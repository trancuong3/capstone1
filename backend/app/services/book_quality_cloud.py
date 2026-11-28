from __future__ import annotations

import asyncio
import json
import logging
import re
import unicodedata
from dataclasses import dataclass

import httpx
from pydantic import ValidationError

from app.services.admin_ocr_local import LocalCorrectionError
from app.services.book_quality_ollama import (
    OllamaAnalysisResult,
    OllamaFindingEvidence,
    OllamaTextResponse,
    _json_schema,
    _prompt,
    _reject_json_constant,
    _text_chunks,
    _unique_excerpt_span,
)
from app.services.ocr_ai.config import OcrCorrectionConfig

logger = logging.getLogger(__name__)

_GEMINI_API_BASE = "https://generativelanguage.googleapis.com/v1beta"
_GROQ_CHAT_URL = "https://api.groq.com/openai/v1/chat/completions"

_CLOUD_MAX_DOCUMENT_BYTES = 256_000
_CLOUD_CHUNK_MAX_CHARS = 4000
_CLOUD_CHUNK_OVERLAP_CHARS = 120
_CLOUD_CHUNK_MAX_BYTES = 16_384
_CLOUD_CHUNK_MAX_WORDS = 2_500


@dataclass(frozen=True)
class _CloudQualityProvider:
    name: str
    family: str
    model: str
    api_key: str


def _strip_json_fences(raw_text: str) -> str:
    cleaned = re.sub(
        r"<think>.*?</think>", "", raw_text, flags=re.DOTALL | re.IGNORECASE
    ).strip()
    if cleaned.startswith("```"):
        cleaned = re.sub(r"^```(?:json)?\s*", "", cleaned, flags=re.IGNORECASE)
        cleaned = re.sub(r"\s*```$", "", cleaned)
    return cleaned.strip()


def _build_providers(config: OcrCorrectionConfig) -> tuple[_CloudQualityProvider, ...]:
    providers: list[_CloudQualityProvider] = []
    if config.gemini_enabled and config.gemini_api_key:
        providers.append(
            _CloudQualityProvider(
                name="gemini_primary",
                family="google",
                model=config.gemini_primary_model,
                api_key=config.gemini_api_key,
            )
        )
        if (
            config.gemini_fallback_model
            and config.gemini_fallback_model != config.gemini_primary_model
        ):
            providers.append(
                _CloudQualityProvider(
                    name="gemini_fallback",
                    family="google",
                    model=config.gemini_fallback_model,
                    api_key=config.gemini_api_key,
                )
            )
    if config.groq_enabled and config.groq_api_key:
        providers.append(
            _CloudQualityProvider(
                name="groq_qwen",
                family="groq",
                model=config.groq_model,
                api_key=config.groq_api_key,
            )
        )
    return tuple(providers)


def _extract_provider_content(family: str, payload: object) -> str:
    if not isinstance(payload, dict):
        raise LocalCorrectionError(502, "Cloud AI trả về dữ liệu không đúng cấu trúc.")
    content: object = None
    if family == "google":
        candidates = payload.get("candidates")
        first = candidates[0] if isinstance(candidates, list) and candidates else None
        content_obj = first.get("content") if isinstance(first, dict) else None
        parts = content_obj.get("parts") if isinstance(content_obj, dict) else None
        if isinstance(parts, list):
            texts = [
                part.get("text")
                for part in parts
                if isinstance(part, dict)
                and not part.get("thought")
                and isinstance(part.get("text"), str)
            ]
            content = "\n".join(texts) if texts else None
    else:
        choices = payload.get("choices")
        first = choices[0] if isinstance(choices, list) and choices else None
        message = first.get("message") if isinstance(first, dict) else None
        content = message.get("content") if isinstance(message, dict) else None

    if not isinstance(content, str) or not content.strip():
        raise LocalCorrectionError(502, "Cloud AI trả về phản hồi rỗng hoặc không hợp lệ.")
    return _strip_json_fences(content)


def _decode_cloud_response(family: str, payload: object) -> OllamaTextResponse:
    content = _extract_provider_content(family, payload)
    try:
        parsed_json = json.loads(content, parse_constant=_reject_json_constant)
        return OllamaTextResponse.model_validate(parsed_json)
    except (json.JSONDecodeError, ValidationError, ValueError) as error:
        raise LocalCorrectionError(502, "Cloud AI trả về JSON không đúng schema.") from error


async def _call_cloud_provider(
    client: httpx.AsyncClient,
    provider: _CloudQualityProvider,
    chunk: str,
    page_number: int,
) -> OllamaTextResponse:
    if provider.family == "google":
        url = f"{_GEMINI_API_BASE}/models/{provider.model}:generateContent"
        headers = {"x-goog-api-key": provider.api_key}
        payload: dict[str, object] = {
            "systemInstruction": {
                "parts": [{"text": "Return valid JSON only. Preserve source evidence exactly."}]
            },
            "contents": [
                {
                    "role": "user",
                    "parts": [
                        {"text": _prompt(chunk, page_number, include_json_contract=False)}
                    ],
                }
            ],
            "generationConfig": {
                "temperature": 0,
                "responseMimeType": "application/json",
                "responseJsonSchema": _json_schema(),
            },
        }
    else:
        url = _GROQ_CHAT_URL
        headers = {"Authorization": f"Bearer {provider.api_key}"}
        payload = {
            "model": provider.model,
            "temperature": 0,
            "messages": [
                {
                    "role": "system",
                    "content": "Return valid JSON only. Preserve source evidence exactly.",
                },
                {
                    "role": "user",
                    "content": _prompt(chunk, page_number, include_json_contract=True),
                },
            ],
            "response_format": {"type": "json_object"},
        }

    try:
        response = await client.post(url, headers=headers, json=payload)
    except httpx.TimeoutException as error:
        raise LocalCorrectionError(
            503, "Cloud AI rà soát nội dung đã hết thời gian chờ."
        ) from error
    except httpx.RequestError as error:
        raise LocalCorrectionError(
            503, "Không thể kết nối Cloud AI để rà soát nội dung."
        ) from error

    if response.status_code != 200:
        logger.warning(
            "Cloud content review returned HTTP %s from %s",
            response.status_code,
            provider.name,
        )
        raise LocalCorrectionError(
            503, "Dịch vụ Cloud AI tạm thời không khả dụng."
        )

    try:
        raw_payload = response.json()
    except ValueError as error:
        raise LocalCorrectionError(502, "Cloud AI trả về dữ liệu không phải JSON.") from error

    return _decode_cloud_response(provider.family, raw_payload)


async def analyse_with_cloud_ai(
    text_snapshot: str,
    page_number: int,
    config: OcrCorrectionConfig | None = None,
    *,
    transport: httpx.AsyncBaseTransport | None = None,
) -> OllamaAnalysisResult:
    """Text-only quality review using Gemini (primary -> fallback) -> Groq."""
    resolved_config = config or OcrCorrectionConfig.from_environment()
    providers = _build_providers(resolved_config)
    if not providers:
        raise LocalCorrectionError(
            503, "Dịch vụ rà soát chất lượng văn bản đám mây chưa được cấu hình."
        )

    if len(text_snapshot.encode("utf-8")) > _CLOUD_MAX_DOCUMENT_BYTES:
        raise LocalCorrectionError(
            422, "Văn bản trang vượt giới hạn rà soát AI đám mây."
        )

    ranges = _text_chunks(
        text_snapshot,
        maximum=_CLOUD_CHUNK_MAX_CHARS,
        overlap=_CLOUD_CHUNK_OVERLAP_CHARS,
        max_bytes=_CLOUD_CHUNK_MAX_BYTES,
        max_words=_CLOUD_CHUNK_MAX_WORDS,
    )
    if not ranges or not text_snapshot.strip():
        return OllamaAnalysisResult((), providers[0].model, 0)

    timeout = httpx.Timeout(
        resolved_config.cloud_timeout_seconds,
        connect=min(10.0, float(resolved_config.cloud_timeout_seconds)),
    )
    findings: dict[tuple[int, int, str], OllamaFindingEvidence] = {}
    rejected = 0
    disabled_families: set[str] = set()
    used_models: list[str] = []

    try:
        async with asyncio.timeout(resolved_config.total_timeout_seconds):
            async with httpx.AsyncClient(
                timeout=timeout,
                trust_env=False,
                follow_redirects=False,
                transport=transport,
            ) as client:
                for start, end in ranges:
                    chunk = text_snapshot[start:end]
                    parsed: OllamaTextResponse | None = None
                    chunk_model = providers[0].model
                    last_error: LocalCorrectionError | None = None

                    for provider in providers:
                        if provider.family in disabled_families:
                            continue
                        try:
                            parsed = await _call_cloud_provider(
                                client, provider, chunk, page_number
                            )
                            chunk_model = provider.model
                            used_models.append(provider.model)
                            break
                        except LocalCorrectionError as error:
                            last_error = error
                            if error.status_code == 503:
                                disabled_families.add(provider.family)
                            continue

                    if parsed is None:
                        raise (
                            last_error
                            or LocalCorrectionError(
                                503, "Không có nhà cung cấp Cloud AI khả dụng."
                            )
                        )

                    for item in parsed.findings:
                        span = _unique_excerpt_span(chunk, item.excerpt)
                        if span is None:
                            rejected += 1
                            continue
                        raw_start, raw_end = span
                        absolute_start = start + raw_start
                        absolute_end = start + raw_end
                        key = (absolute_start, absolute_end, item.issue_type)
                        if key in findings:
                            continue
                        findings[key] = OllamaFindingEvidence(
                            issue_type=item.issue_type,
                            severity=item.severity,
                            excerpt=chunk[raw_start:raw_end],
                            excerpt_start=absolute_start,
                            excerpt_end=absolute_end,
                            explanation=unicodedata.normalize("NFC", item.explanation),
                            suggested_correction=(
                                unicodedata.normalize("NFC", item.suggested_correction)
                                if item.suggested_correction is not None
                                else None
                            ),
                            confidence=item.confidence,
                            model_name=chunk_model,
                        )
    except LocalCorrectionError:
        raise
    except TimeoutError as error:
        raise LocalCorrectionError(
            503, "Cloud AI rà soát toàn bộ văn bản đã hết thời gian chờ."
        ) from error

    final_model = used_models[-1] if used_models else providers[0].model
    return OllamaAnalysisResult(
        findings=tuple(
            sorted(
                findings.values(),
                key=lambda item: (
                    item.excerpt_start,
                    item.excerpt_end,
                    item.issue_type,
                ),
            )
        ),
        model_name=final_model,
        rejected_excerpt_count=rejected,
    )
