from __future__ import annotations

import base64

import httpx

from app.services.admin_ocr_chunking import OcrTextChunk
from app.services.cloud_ai_defaults import (
    extract_gemini_text,
    gemini_thinking_config,
    record_cloud_ai_outcome,
)
from app.services.ocr_ai.exceptions import OcrProviderError
from app.services.ocr_ai.prompts import SYSTEM_PROMPT, chunk_prompt, response_json_schema
from app.services.ocr_ai.runtime import (
    detect_limit_zero,
    get_shared_ocr_ai_http_client,
    parse_retry_after_seconds,
)
from app.services.ocr_ai.schemas import ChunkCorrectionResult
from app.services.ocr_ai.validators import decode_and_validate_content


_GEMINI_API_BASE = "https://generativelanguage.googleapis.com/v1beta"


class GeminiOcrProvider:
    family = "google"

    def __init__(
        self,
        *,
        name: str,
        model: str,
        api_key: str,
        timeout_seconds: int,
        transport: httpx.AsyncBaseTransport | None = None,
    ) -> None:
        self.name = name
        self.model = model
        self._api_key = api_key
        self._timeout_seconds = timeout_seconds
        self._transport = transport
        self._client: httpx.AsyncClient | None = None

    def _get_client(self) -> httpx.AsyncClient:
        if self._transport is None:
            return get_shared_ocr_ai_http_client()
        if self._client is None or self._client.is_closed:
            self._client = httpx.AsyncClient(
                timeout=httpx.Timeout(self._timeout_seconds),
                trust_env=False,
                follow_redirects=False,
                transport=self._transport,
            )
        return self._client

    async def aclose(self) -> None:
        if self._client is not None and not self._client.is_closed:
            await self._client.aclose()
        self._client = None

    async def correct_chunk(
        self,
        *,
        chunk: OcrTextChunk,
        image_bytes: bytes,
        image_mime_type: str,
    ) -> ChunkCorrectionResult:
        generation_config: dict[str, object] = {
            "temperature": 0,
            "responseMimeType": "application/json",
            "responseJsonSchema": response_json_schema(chunk.expected_word_count),
        }
        thinking_cfg = gemini_thinking_config(self.model)
        if thinking_cfg is not None:
            generation_config["thinkingConfig"] = thinking_cfg

        payload = {
            "systemInstruction": {"parts": [{"text": SYSTEM_PROMPT}]},
            "contents": [
                {
                    "role": "user",
                    "parts": [
                        {"text": chunk_prompt(chunk)},
                        {
                            "inline_data": {
                                "mime_type": image_mime_type,
                                "data": base64.b64encode(image_bytes).decode("ascii"),
                            }
                        },
                    ],
                }
            ],
            "generationConfig": generation_config,
        }
        url = f"{_GEMINI_API_BASE}/models/{self.model}:generateContent"
        try:
            client = self._get_client()
            response = await client.post(
                url,
                headers={"x-goog-api-key": self._api_key},
                json=payload,
                timeout=httpx.Timeout(self._timeout_seconds),
            )
            if response.status_code == 400 and thinking_cfg is not None:
                generation_config.pop("thinkingConfig", None)
                response = await client.post(
                    url,
                    headers={"x-goog-api-key": self._api_key},
                    json=payload,
                    timeout=httpx.Timeout(self._timeout_seconds),
                )
        except httpx.TimeoutException as exc:
            if self._transport is None:
                record_cloud_ai_outcome(
                    "ocr_ai",
                    "gemini",
                    self.model,
                    ok=False,
                    error_code="PROVIDER_TIMEOUT",
                    http_status=504,
                )
            raise OcrProviderError(
                provider=self.name,
                code="PROVIDER_TIMEOUT",
                status_code=504,
                disables_family=True,
            ) from exc
        except httpx.RequestError as exc:
            if self._transport is None:
                record_cloud_ai_outcome(
                    "ocr_ai",
                    "gemini",
                    self.model,
                    ok=False,
                    error_code="PROVIDER_NETWORK",
                    http_status=503,
                )
            raise OcrProviderError(
                provider=self.name,
                code="PROVIDER_NETWORK",
                status_code=503,
                disables_family=True,
            ) from exc
        if response.status_code != 200:
            err = self._http_error(response.status_code, response=response)
            if self._transport is None:
                record_cloud_ai_outcome(
                    "ocr_ai",
                    "gemini",
                    self.model,
                    ok=False,
                    error_code=err.code,
                    http_status=response.status_code,
                )
            raise err
        try:
            data = response.json()
            text = extract_gemini_text(data)
        except (AttributeError, IndexError, TypeError, ValueError) as exc:
            if self._transport is None:
                record_cloud_ai_outcome(
                    "ocr_ai",
                    "gemini",
                    self.model,
                    ok=False,
                    error_code="INVALID_RESPONSE",
                    http_status=response.status_code,
                )
            raise OcrProviderError(
                provider=self.name, code="INVALID_RESPONSE", status_code=502
            ) from exc
        try:
            result = decode_and_validate_content(text, chunk=chunk, provider=self.name)
        except OcrProviderError as exc:
            if self._transport is None:
                record_cloud_ai_outcome(
                    "ocr_ai",
                    "gemini",
                    self.model,
                    ok=False,
                    error_code=exc.code,
                    http_status=response.status_code,
                )
            raise
        if self._transport is None:
            record_cloud_ai_outcome(
                "ocr_ai",
                "gemini",
                self.model,
                ok=True,
                http_status=response.status_code,
            )
        return result

    def _http_error(
        self, status_code: int, *, response: httpx.Response | None = None
    ) -> OcrProviderError:
        retry_after_seconds = (
            parse_retry_after_seconds(response.headers.get("retry-after"))
            if response is not None
            else None
        )
        limit_zero = detect_limit_zero(response)
        if status_code in (401, 403):
            return OcrProviderError(
                provider=self.name,
                code="PROVIDER_AUTHENTICATION",
                status_code=502,
                upstream_status_code=status_code,
                disables_family=True,
                retry_after_seconds=retry_after_seconds,
                limit_zero=limit_zero,
            )
        if status_code == 429:
            return OcrProviderError(
                provider=self.name,
                code="PROVIDER_QUOTA",
                status_code=503,
                upstream_status_code=status_code,
                disables_family=True,
                retry_after_seconds=retry_after_seconds,
                limit_zero=limit_zero,
            )
        if status_code >= 500:
            return OcrProviderError(
                provider=self.name,
                code="PROVIDER_UNAVAILABLE",
                status_code=503,
                upstream_status_code=status_code,
                disables_family=True,
                retry_after_seconds=retry_after_seconds,
                limit_zero=limit_zero,
            )
        if status_code == 404:
            return OcrProviderError(
                provider=self.name,
                code="MODEL_UNAVAILABLE",
                status_code=502,
                upstream_status_code=status_code,
                retry_after_seconds=retry_after_seconds,
                limit_zero=limit_zero,
            )
        return OcrProviderError(
            provider=self.name,
            code="PROVIDER_REJECTED",
            status_code=502,
            upstream_status_code=status_code,
            retry_after_seconds=retry_after_seconds,
            limit_zero=limit_zero,
        )
