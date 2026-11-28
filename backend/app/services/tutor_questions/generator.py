from __future__ import annotations

import logging
import random

import httpx

from app.services.cloud_ai_defaults import (
    DEFAULT_GEMINI_ALIAS_MODEL,
    build_gemini_model_chain,
    build_groq_model_chain,
    is_model_in_cooldown,
    record_cloud_ai_outcome,
)
from app.services.tutor_questions.config import TutorQuestionConfig
from app.services.tutor_questions.providers import (
    GeminiQuestionProvider,
    GroqQuestionProvider,
    QuestionProvider,
)
from app.services.tutor_questions.rule_based import generate_rule_based
from app.services.tutor_questions.types import (
    GenerationResult,
    QuestionProviderError,
    SourcePage,
)
from app.services.tutor_questions.validators import validate_drafts

logger = logging.getLogger(__name__)

# Roughly one grounded, non-overlapping question per this many words read.
WORDS_PER_QUESTION = 8


class TutorQuestionGenerator:
    """Try cloud models in order, validate the output, then fall back to rules.

    Order: Gemini primary -> Gemini fallback -> Groq -> deterministic cloze.
    Only verified book text is sent to a provider; no child, parent or session
    identifiers ever leave the backend.
    """

    def __init__(
        self,
        config: TutorQuestionConfig | None = None,
        *,
        transport: httpx.AsyncBaseTransport | None = None,
        providers: list[QuestionProvider] | None = None,
        rng: random.Random | None = None,
    ) -> None:
        self.config = config or TutorQuestionConfig.from_environment()
        self._rng = rng or random.Random()
        self._transport = transport
        self._uses_custom_providers = providers is not None
        self._providers = (
            providers if providers is not None else self._build_providers(transport)
        )

    def _build_providers(
        self, transport: httpx.AsyncBaseTransport | None
    ) -> list[QuestionProvider]:
        cfg = self.config
        if not cfg.ai_enabled:
            return []
        providers: list[QuestionProvider] = []
        if cfg.gemini_api_key:
            gemini_models = build_gemini_model_chain(
                cfg.gemini_model, cfg.gemini_fallback_model
            )
            alias_used = False
            extra_idx = 0
            for idx, model in enumerate(gemini_models):
                if idx == 0:
                    name = "gemini-primary"
                elif idx == 1:
                    name = "gemini-fallback"
                elif model == DEFAULT_GEMINI_ALIAS_MODEL and not alias_used:
                    name = "gemini-alias"
                    alias_used = True
                else:
                    extra_idx += 1
                    name = f"gemini-extra-{extra_idx}"
                providers.append(
                    GeminiQuestionProvider(
                        name=name,
                        model=model,
                        api_key=cfg.gemini_api_key,
                        timeout_seconds=cfg.timeout_seconds,
                        transport=transport,
                    )
                )
        if cfg.groq_api_key:
            groq_models = build_groq_model_chain(cfg.groq_model, multimodal=False)
            for idx, model in enumerate(groq_models):
                if idx == 0:
                    name = "groq"
                elif idx == 1:
                    name = "groq-fallback"
                else:
                    name = f"groq-extra-{idx - 1}"
                providers.append(
                    GroqQuestionProvider(
                        name=name,
                        model=model,
                        api_key=cfg.groq_api_key,
                        timeout_seconds=cfg.timeout_seconds,
                        transport=transport,
                    )
                )
        return providers

    def target_count(self, pages: list[SourcePage]) -> int:
        """Random number in [min, max], never more than the text can support."""

        words = sum(len(page.tokens) for page in pages)
        low = max(1, self.config.min_questions)
        high = max(low, self.config.max_questions)
        wanted = self._rng.randint(low, high)
        capacity = max(1, words // WORDS_PER_QUESTION)
        return max(1, min(wanted, capacity))

    async def generate(self, pages: list[SourcePage], *, seed: str) -> GenerationResult:
        pages = [page for page in pages if page.tokens]
        if not pages:
            return GenerationResult([], "RULE_BASED", "none")

        count = self.target_count(pages)
        attempts: list[str] = []
        skip_families: set[str] = set()
        record_telemetry = self._transport is None and not self._uses_custom_providers
        active_providers = self._providers
        if record_telemetry and active_providers:
            non_cooled = [
                provider
                for provider in active_providers
                if not is_model_in_cooldown(
                    provider.name.split("-")[0],
                    str(getattr(provider, "model", provider.name)),
                )
            ]
            if non_cooled:
                active_providers = non_cooled

        for provider in active_providers:
            family = provider.name.split("-")[0]
            model_name = str(getattr(provider, "model", provider.name))
            if family in skip_families:
                attempts.append(f"{provider.name}:SKIPPED_FAMILY")
                continue
            try:
                payload = await provider.generate(
                    pages=pages, count=count, max_chars=self.config.max_source_chars
                )
            except QuestionProviderError as error:
                attempts.append(f"{provider.name}:{error.code}")
                if record_telemetry:
                    record_cloud_ai_outcome(
                        "tutor_questions",
                        family,
                        model_name,
                        ok=False,
                        error_code=error.code,
                    )
                # A bad key or exhausted quota fails every model of that vendor; a 5xx
                # (overload) is per model, so the fallback model is still worth trying.
                if error.code in {"PROVIDER_AUTHENTICATION", "PROVIDER_QUOTA"}:
                    skip_families.add(family)
                continue
            questions = validate_drafts(payload, pages, count=count, seed=seed)
            if questions:
                if record_telemetry:
                    record_cloud_ai_outcome(
                        "tutor_questions",
                        family,
                        model_name,
                        ok=True,
                        http_status=200,
                    )
                logger.info(
                    "tutor_questions_generated provider=%s model=%s accepted=%d attempts=%s",
                    provider.name,
                    model_name,
                    len(questions),
                    ",".join(attempts) or "-",
                )
                return GenerationResult(questions, "AI", provider.name, attempts)
            attempts.append(f"{provider.name}:NO_VALID_QUESTIONS")
            if record_telemetry:
                record_cloud_ai_outcome(
                    "tutor_questions",
                    family,
                    model_name,
                    ok=False,
                    error_code="NO_VALID_QUESTIONS",
                )

        questions = generate_rule_based(pages, count=count, seed=seed)
        logger.info(
            "tutor_questions_generated provider=rule_based accepted=%d attempts=%s",
            len(questions),
            ",".join(attempts) or "-",
        )
        return GenerationResult(questions, "RULE_BASED", "rule_based", attempts)
