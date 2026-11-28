"""Regression guard preventing retired Cloud AI model outages and verifying self-healing."""

from __future__ import annotations

import asyncio
import json
import os
import unittest
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch
from uuid import uuid4

os.environ.setdefault("DATABASE_URL", "postgresql+asyncpg://test:test@127.0.0.1:1/test")
os.environ.setdefault("SUPABASE_URL", "https://example.supabase.co")
os.environ.setdefault("SUPABASE_KEY", "isolated-test-key")

import httpx

from app.api.routes.system import AdminSystemService
from app.services import child_progress_service as progress_service_module
from app.services import phonics_ai_service
from app.services.ai_capability_router import build_default_provider_registry
from app.services.book_style_bible import BookStyleBibleService
from app.services.child_progress.ai import ChildProgressAI, ChildProgressConfig
from app.services.child_progress_service import ChildProgressService
from app.services.cloud_ai_defaults import (
    DEFAULT_GEMINI_ALIAS_MODEL,
    DEFAULT_GEMINI_FALLBACK_MODEL,
    DEFAULT_GEMINI_PRIMARY_MODEL,
    DEFAULT_GROQ_MULTIMODAL_MODEL,
    DEFAULT_GROQ_TEXT_MODEL,
    RETIRED_CLOUD_AI_MODELS,
    extract_gemini_text,
    gemini_thinking_config,
    get_cloud_ai_health_snapshot,
    is_model_in_cooldown,
    read_model_env,
    read_secret_env,
    record_cloud_ai_outcome,
    reset_cloud_ai_telemetry,
    strip_think_tags,
)
from app.services.games import memory_game_evaluator
from app.services.ocr_ai.config import OcrCorrectionConfig
from app.services.picture_description_ai import PictureDescriptionAiConfig
from app.services.tutor_questions.config import TutorQuestionConfig
from test_child_progress import FakeRepository, GOOD_AI, NOW, PARENT_ID, CHILD_ID


def _run(coro):
    return asyncio.run(coro)


class CloudAiConnectivityGuardTests(unittest.TestCase):
    def setUp(self) -> None:
        reset_cloud_ai_telemetry()
        progress_service_module.assessment_cache.clear()

    def tearDown(self) -> None:
        reset_cloud_ai_telemetry()
        progress_service_module.assessment_cache.clear()

    def test_zero_retired_models_across_all_eight_services_and_defaults(self) -> None:
        with patch.dict(os.environ, {}, clear=True):
            child_cfg = ChildProgressConfig.from_environment()
            tutor_cfg = TutorQuestionConfig.from_environment()
            ocr_cfg = OcrCorrectionConfig.from_environment()
            pic_cfg = PictureDescriptionAiConfig(
                primary_model=DEFAULT_GEMINI_PRIMARY_MODEL,
                fallback_model=DEFAULT_GEMINI_FALLBACK_MODEL,
            )
            router_specs = build_default_provider_registry({})
            mem_cfg = memory_game_evaluator.get_memory_ai_config()
            style_service = BookStyleBibleService(db=None)  # type: ignore[arg-type]
            public_book = SimpleNamespace(
                IsPublic=True,
                Visibility="PUBLIC",
                OwnerParentId=None,
                CreatedByParentId=None,
                SourceType="CURATED",
            )
            _, _, style_model = style_service._cloud_refinement_allowed(public_book)

        configured_models = {
            child_cfg.gemini_model,
            child_cfg.gemini_fallback_model,
            child_cfg.groq_model,
            tutor_cfg.gemini_model,
            tutor_cfg.gemini_fallback_model,
            tutor_cfg.groq_model,
            ocr_cfg.gemini_primary_model,
            ocr_cfg.gemini_fallback_model,
            ocr_cfg.groq_model,
            pic_cfg.primary_model,
            pic_cfg.fallback_model or "",
            pic_cfg.groq_model,
            phonics_ai_service._DEFAULT_GEMINI_MODEL,
            phonics_ai_service._DEFAULT_GEMINI_FALLBACK_MODEL,
            phonics_ai_service._DEFAULT_GROQ_MODEL,
            memory_game_evaluator.DEFAULT_GEMINI_MODEL,
            memory_game_evaluator.DEFAULT_GEMINI_FALLBACK_MODEL,
            memory_game_evaluator.DEFAULT_GROQ_MODEL,
            mem_cfg.gemini_model,
            mem_cfg.gemini_fallback_model or "",
            mem_cfg.groq_model,
            style_model,
            *(spec.model_id for spec in router_specs),
        }
        self.assertTrue(configured_models.isdisjoint(RETIRED_CLOUD_AI_MODELS), configured_models & RETIRED_CLOUD_AI_MODELS)
        self.assertEqual(child_cfg.gemini_model, DEFAULT_GEMINI_PRIMARY_MODEL)
        self.assertEqual(tutor_cfg.gemini_model, DEFAULT_GEMINI_PRIMARY_MODEL)
        self.assertEqual(ocr_cfg.gemini_primary_model, DEFAULT_GEMINI_PRIMARY_MODEL)
        self.assertEqual(ocr_cfg.groq_model, DEFAULT_GROQ_MULTIMODAL_MODEL)
        self.assertEqual(child_cfg.groq_model, DEFAULT_GROQ_TEXT_MODEL)

    def test_env_helpers_strip_quotes_across_services(self) -> None:
        env = {
            "GEMINI_API_KEY": ' "AIzaQuotedKey" ',
            "GROQ_API_KEY": " 'gsk_QuotedGroq' ",
            "CHILD_PROGRESS_GEMINI_MODEL": ' "gemini-3.1-flash-lite" ',
            "TUTOR_QUESTIONS_GROQ_MODEL": " 'qwen/qwen3.8-27b' ",
            "GEMINI_OCR_PRIMARY_MODEL": ' "gemini-3.5-flash-lite" ',
        }
        self.assertEqual(read_secret_env("GEMINI_API_KEY", env=env), "AIzaQuotedKey")
        self.assertEqual(read_secret_env("GROQ_API_KEY", env=env), "gsk_QuotedGroq")
        self.assertEqual(
            read_model_env("CHILD_PROGRESS_GEMINI_MODEL", default=DEFAULT_GEMINI_PRIMARY_MODEL, env=env),
            "gemini-3.1-flash-lite",
        )
        with patch.dict(os.environ, env, clear=False):
            child_cfg = ChildProgressConfig.from_environment()
            tutor_cfg = TutorQuestionConfig.from_environment()
            ocr_cfg = OcrCorrectionConfig.from_environment()
        self.assertEqual(child_cfg.gemini_api_key, "AIzaQuotedKey")
        self.assertEqual(child_cfg.groq_api_key, "gsk_QuotedGroq")
        self.assertEqual(tutor_cfg.groq_model, "qwen/qwen3.8-27b")
        self.assertEqual(ocr_cfg.gemini_primary_model, "gemini-3.5-flash-lite")

    def test_stale_retired_env_overrides_self_heal_on_404_via_alias(self) -> None:
        seen_models: list[str] = []

        def handler(request: httpx.Request) -> httpx.Response:
            path = request.url.path
            model = path.split("/models/")[-1].split(":")[0]
            seen_models.append(model)
            if model in RETIRED_CLOUD_AI_MODELS:
                return httpx.Response(404, json={"error": {"status": "NOT_FOUND"}})
            if model == DEFAULT_GEMINI_ALIAS_MODEL:
                return httpx.Response(
                    200,
                    json={"candidates": [{"content": {"parts": [{"text": json.dumps(GOOD_AI)}]}}]},
                )
            return httpx.Response(503)

        cfg = ChildProgressConfig(
            gemini_api_key="test-gemini-key",
            groq_api_key=None,
            gemini_model="gemini-2.5-flash-lite",
            gemini_fallback_model="gemini-2.5-flash",
        )
        ai = ChildProgressAI(cfg, transport=httpx.MockTransport(handler))
        result = _run(ai.assess({"overall_score": 80}, allowed_words=["dây", "sáng"]))
        self.assertEqual(result.source, "AI")
        self.assertEqual(result.model, DEFAULT_GEMINI_ALIAS_MODEL)
        self.assertEqual(
            seen_models,
            ["gemini-2.5-flash-lite", "gemini-2.5-flash", DEFAULT_GEMINI_ALIAS_MODEL],
        )

    def test_thought_parts_think_tags_and_thinking_config_400_fallback(self) -> None:
        self.assertEqual(gemini_thinking_config("gemini-3.1-flash-lite"), {"thinkingLevel": "MINIMAL"})
        self.assertEqual(gemini_thinking_config("gemini-flash-lite-latest"), {"thinkingLevel": "MINIMAL"})
        self.assertIsNone(gemini_thinking_config("gemini-3.8-flash"))

        raw_payload = {
            "candidates": [
                {
                    "content": {
                        "parts": [
                            {"thought": True, "text": "internal chain of thought"},
                            {"text": "<think>reasoning</think>\n```json\n" + json.dumps(GOOD_AI) + "\n```"},
                        ]
                    }
                }
            ]
        }
        extracted = extract_gemini_text(raw_payload)
        self.assertIsNotNone(extracted)
        self.assertNotIn("internal chain of thought", extracted or "")
        cleaned = strip_think_tags(extracted or "")
        self.assertEqual(json.loads(cleaned)["headline"], GOOD_AI["headline"])

        request_bodies: list[dict] = []

        def handler(request: httpx.Request) -> httpx.Response:
            body = json.loads(request.content.decode())
            request_bodies.append(body)
            if "thinkingConfig" in body.get("generationConfig", {}):
                return httpx.Response(400, json={"error": {"message": "Thinking level MINIMAL not supported"}})
            return httpx.Response(200, json=raw_payload)

        cfg = ChildProgressConfig(
            gemini_api_key="test-key",
            groq_api_key=None,
            gemini_model="gemini-3.1-flash-lite",
            gemini_fallback_model="gemini-3.5-flash-lite",
        )
        ai = ChildProgressAI(cfg, transport=httpx.MockTransport(handler))
        result = _run(ai.assess({"overall_score": 74}, allowed_words=["dây"]))
        self.assertEqual(result.source, "AI")
        self.assertEqual(len(request_bodies), 2)
        self.assertIn("thinkingConfig", request_bodies[0]["generationConfig"])
        self.assertNotIn("thinkingConfig", request_bodies[1]["generationConfig"])

    def test_child_progress_service_surfaces_accurate_ai_fallback_reasons(self) -> None:
        cases = [
            (401, "PROVIDER_AUTHENTICATION"),
            (429, "PROVIDER_QUOTA"),
            (404, "MODEL_UNAVAILABLE"),
            (503, "PROVIDER_UNAVAILABLE"),
        ]
        for status_code, expected_reason in cases:
            with self.subTest(status_code=status_code):
                progress_service_module.assessment_cache.clear()
                repo = FakeRepository()
                cfg = ChildProgressConfig(gemini_api_key="g", groq_api_key=None)
                ai = ChildProgressAI(
                    cfg,
                    transport=httpx.MockTransport(lambda _r, s=status_code: httpx.Response(s)),
                )
                svc = ChildProgressService(repo, ai, cfg, now=lambda: NOW)
                out = _run(svc.assess(CHILD_ID, PARENT_ID, use_ai=True))
                self.assertEqual(out.assessment.source, "RULE_BASED")
                self.assertEqual(out.ai_fallback_reason, expected_reason)

        # Timeout
        progress_service_module.assessment_cache.clear()
        repo = FakeRepository()
        cfg = ChildProgressConfig(gemini_api_key="g", groq_api_key=None)

        def timeout_handler(_r: httpx.Request) -> httpx.Response:
            raise httpx.ReadTimeout("timed out")

        ai_timeout = ChildProgressAI(cfg, transport=httpx.MockTransport(timeout_handler))
        out_timeout = _run(
            ChildProgressService(repo, ai_timeout, cfg, now=lambda: NOW).assess(
                CHILD_ID, PARENT_ID, use_ai=True
            )
        )
        self.assertEqual(out_timeout.ai_fallback_reason, "PROVIDER_TIMEOUT")

        # Missing keys -> AI_NOT_CONFIGURED; disabled -> AI_DISABLED
        progress_service_module.assessment_cache.clear()
        out_nokey = _run(
            ChildProgressService(
                FakeRepository(),
                config=ChildProgressConfig(gemini_api_key=None, groq_api_key=None),
                now=lambda: NOW,
            ).assess(CHILD_ID, PARENT_ID, use_ai=True)
        )
        self.assertEqual(out_nokey.ai_fallback_reason, "AI_NOT_CONFIGURED")

        out_disabled = _run(
            ChildProgressService(
                FakeRepository(),
                config=ChildProgressConfig(enabled=False, gemini_api_key="g"),
                now=lambda: NOW,
            ).assess(CHILD_ID, PARENT_ID, use_ai=True)
        )
        self.assertEqual(out_disabled.ai_fallback_reason, "AI_DISABLED")

    def test_cooldown_and_admin_health_reflect_cloud_ai_failures_and_recovery(self) -> None:
        record_cloud_ai_outcome(
            "child_progress", "gemini", "gemini-2.5-flash-lite", ok=False, error_code="MODEL_UNAVAILABLE", http_status=404
        )
        record_cloud_ai_outcome(
            "child_progress", "gemini", "gemini-2.5-flash", ok=False, error_code="MODEL_UNAVAILABLE", http_status=404
        )
        self.assertTrue(is_model_in_cooldown("gemini", "gemini-2.5-flash-lite"))

        with patch.dict(
            os.environ,
            {
                "RENDER": "true",
                "OCR_CLOUD_CORRECTION_ENABLED": "true",
                "GEMINI_API_KEY": "test-key",
            },
            clear=False,
        ):
            snap = get_cloud_ai_health_snapshot()
            self.assertEqual(snap["status"], "DEGRADED")
            self.assertEqual(snap["last_error"], "MODEL_UNAVAILABLE")

            repo = AsyncMock()
            repo.probe_database.return_value = True
            voice = AsyncMock()
            voice.probe_tts.return_value = ("HEALTHY", "TTS ready")
            voice.probe_stt.return_value = ("HEALTHY", "STT ready")
            storage = AsyncMock(
                return_value={
                    "id": "storage",
                    "label": "Supabase Storage",
                    "status": "HEALTHY",
                    "detail_status": "healthy",
                    "safe_message": "OK",
                    "service_group": "core",
                    "execution_mode": "always_on",
                    "criticality": "core",
                }
            )
            with patch("app.api.routes.system.probe_storage_health", new=storage):
                health = _run(AdminSystemService(repo, voice).health())
            local_ocr_item = next(item for item in health.services if item.id == "local_ocr")
            self.assertEqual(local_ocr_item.status, "DEGRADED")
            self.assertEqual(local_ocr_item.last_error, "MODEL_UNAVAILABLE")

            # Recovery clears consecutive failure state.
            record_cloud_ai_outcome(
                "child_progress", "gemini", DEFAULT_GEMINI_PRIMARY_MODEL, ok=True, http_status=200
            )
            with patch("app.api.routes.system.probe_storage_health", new=storage):
                recovered = _run(AdminSystemService(repo, voice).health())
            recovered_item = next(item for item in recovered.services if item.id == "local_ocr")
            self.assertEqual(recovered_item.status, "HEALTHY")
            self.assertIsNone(recovered_item.last_error)


if __name__ == "__main__":
    unittest.main()
