from __future__ import annotations

import base64

import httpx

from app.services.admin_ocr_chunking import OcrTextChunk
from app.services.ocr_ai.exceptions import OcrProviderError
from app.services.ocr_ai.prompts import SYSTEM_PROMPT, chunk_prompt, response_json_schema
from app.services.ocr_ai.schemas import ChunkCorrectionResult
from app.services.ocr_ai.validators import decode_and_validate_content


_GROQ_CHAT_URL = "https://api.groq.com/openai/v1/chat/completions"


class GroqOcrProvider:
    name = "groq_qwen"
    family = "groq"

    def __init__(
        self,
        *,
        model: str,
        api_key: str,
        timeout_seconds: int,
        transport: httpx.AsyncBaseTransport | None = None,
    ) -> None:
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
        image_data = base64.b64encode(image_bytes).decode("ascii")
        payload = {
            "model": self.model,
            "temperature": 0,
            "messages": [
                {"role": "system", "content": SYSTEM_PROMPT},
                {
                    "role": "user",
                    "content": [
                        {"type": "text", "text": chunk_prompt(chunk)},
                        {
                            "type": "image_url",
                            "image_url": {
                                "url": f"data:{image_mime_type};base64,{image_data}"
                            },
                        },
                    ],
                },
            ],
            "response_format": {
                "type": "json_schema",
                "json_schema": {
                    "name": "ocr_chunk_correction",
                    "strict": True,
                    "schema": response_json_schema(chunk.expected_word_count),
                },
            },
        }
        try:
            async with httpx.AsyncClient(
                timeout=httpx.Timeout(self._timeout_seconds),
                trust_env=False,
                follow_redirects=False,
                transport=self._transport,
            ) as client:
                response = await client.post(
                    _GROQ_CHAT_URL,
                    headers={"Authorization": f"Bearer {self._api_key}"},
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
            choices = data.get("choices") if isinstance(data, dict) else None
            first = choices[0] if isinstance(choices, list) and choices else None
            message = first.get("message") if isinstance(first, dict) else None
            content = message.get("content") if isinstance(message, dict) else None
        except (AttributeError, IndexError, TypeError, ValueError) as exc:
            raise OcrProviderError(
                provider=self.name, code="INVALID_RESPONSE", status_code=502
            ) from exc
        return decode_and_validate_content(content, chunk=chunk, provider=self.name)

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
                provider=self.name, code="PROVIDER_QUOTA", status_code=503
            )
        if status_code >= 500:
            return OcrProviderError(
                provider=self.name, code="PROVIDER_UNAVAILABLE", status_code=503
            )
        if status_code == 404:
            return OcrProviderError(
                provider=self.name, code="MODEL_UNAVAILABLE", status_code=502
            )
        return OcrProviderError(
            provider=self.name, code="PROVIDER_REJECTED", status_code=502
        )
