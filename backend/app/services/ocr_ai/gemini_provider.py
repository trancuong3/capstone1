from __future__ import annotations

import base64

import httpx

from app.services.admin_ocr_chunking import OcrTextChunk
from app.services.ocr_ai.exceptions import OcrProviderError
from app.services.ocr_ai.prompts import SYSTEM_PROMPT, chunk_prompt, response_json_schema
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

    async def correct_chunk(
        self,
        *,
        chunk: OcrTextChunk,
        image_bytes: bytes,
        image_mime_type: str,
    ) -> ChunkCorrectionResult:
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
            "generationConfig": {
                "temperature": 0,
                "responseMimeType": "application/json",
                "responseJsonSchema": response_json_schema(chunk.expected_word_count),
            },
        }
        url = f"{_GEMINI_API_BASE}/models/{self.model}:generateContent"
        try:
            async with httpx.AsyncClient(
                timeout=httpx.Timeout(self._timeout_seconds),
                trust_env=False,
                follow_redirects=False,
                transport=self._transport,
            ) as client:
                response = await client.post(
                    url,
                    headers={"x-goog-api-key": self._api_key},
                    json=payload,
                )
        except httpx.TimeoutException as exc:
            raise OcrProviderError(
                provider=self.name, code="PROVIDER_TIMEOUT", status_code=504
            ) from exc
        except httpx.RequestError as exc:
            raise OcrProviderError(
                provider=self.name, code="PROVIDER_NETWORK", status_code=503
            ) from exc
        if response.status_code != 200:
            raise self._http_error(response.status_code)
        try:
            data = response.json()
            candidates = data.get("candidates") if isinstance(data, dict) else None
            first = candidates[0] if isinstance(candidates, list) and candidates else None
            content = first.get("content") if isinstance(first, dict) else None
            parts = content.get("parts") if isinstance(content, dict) else None
            text = parts[0].get("text") if isinstance(parts, list) and parts else None
        except (AttributeError, IndexError, TypeError, ValueError) as exc:
            raise OcrProviderError(
                provider=self.name, code="INVALID_RESPONSE", status_code=502
            ) from exc
        return decode_and_validate_content(text, chunk=chunk, provider=self.name)

    def _http_error(self, status_code: int) -> OcrProviderError:
        if status_code in (401, 403):
            return OcrProviderError(
                provider=self.name,
                code="PROVIDER_AUTHENTICATION",
                status_code=502,
                disables_family=True,
            )
        if status_code == 429:
            return OcrProviderError(
                provider=self.name,
                code="PROVIDER_QUOTA",
                status_code=503,
                disables_family=True,
            )
        if status_code >= 500:
            return OcrProviderError(
                provider=self.name,
                code="PROVIDER_UNAVAILABLE",
                status_code=503,
                disables_family=True,
            )
        if status_code == 404:
            return OcrProviderError(
                provider=self.name, code="MODEL_UNAVAILABLE", status_code=502
            )
        return OcrProviderError(
            provider=self.name, code="PROVIDER_REJECTED", status_code=502
        )
