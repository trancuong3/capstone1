from __future__ import annotations

import base64
import re

import httpx

from app.services.admin_ocr_chunking import OcrTextChunk
from app.services.ocr_ai.exceptions import OcrProviderError
from app.services.ocr_ai.prompts import SYSTEM_PROMPT, chunk_prompt
from app.services.ocr_ai.schemas import ChunkCorrectionResult
from app.services.ocr_ai.validators import decode_and_validate_content


_GROQ_CHAT_URL = "https://api.groq.com/openai/v1/chat/completions"
_SAFE_PROVIDER_IDENTIFIER = re.compile(r"[A-Za-z0-9_.:-]{1,80}")


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
        output_contract = (
            "\n\nOUTPUT JSON CONTRACT:\n"
            "Return exactly one JSON object with exactly these fields: "
            '"chunk_id" (integer), "corrected_words" (array of strings), '
            'and "uncertain_word_indices" (array of zero-based integers). '
            f'"chunk_id" must be {chunk.chunk_id}. '
            f'"corrected_words" must contain exactly {chunk.expected_word_count} '
            "strings, one for each SOURCE WORD in the same order. "
            "Use an empty uncertain_word_indices array when all words are certain. "
            "Do not include markdown or any extra fields."
        )
        payload = {
            "model": self.model,
            "temperature": 0,
            "messages": [
                {"role": "system", "content": SYSTEM_PROMPT},
                {
                    "role": "user",
                    "content": [
                        {
                            "type": "text",
                            "text": f"{chunk_prompt(chunk)}{output_contract}",
                        },
                        {
                            "type": "image_url",
                            "image_url": {
                                "url": f"data:{image_mime_type};base64,{image_data}"
                            },
                        },
                    ],
                },
            ],
            # Groq Qwen supports JSON mode for multimodal requests. Keep the
            # detailed schema validation local because provider-side strict
            # schema constraints can reject OCR array bounds as bad requests.
            "response_format": {"type": "json_object"},
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
            raise self._http_error(response)
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

    @staticmethod
    def _safe_identifier(value: object) -> str | None:
        if isinstance(value, str) and _SAFE_PROVIDER_IDENTIFIER.fullmatch(value):
            return value
        return None

    def _http_error(self, response: httpx.Response) -> OcrProviderError:
        status_code = response.status_code
        error_type = None
        error_code = None
        try:
            body = response.json()
            error = body.get("error") if isinstance(body, dict) else None
            if isinstance(error, dict):
                error_type = self._safe_identifier(error.get("type"))
                error_code = self._safe_identifier(error.get("code"))
        except (TypeError, ValueError):
            pass
        request_id = self._safe_identifier(
            response.headers.get("x-request-id")
            or response.headers.get("request-id")
        )
        diagnostic = {
            "upstream_status_code": status_code,
            "upstream_error_type": error_type,
            "upstream_error_code": error_code,
            "upstream_request_id": request_id,
        }
        if status_code in (401, 403):
            return OcrProviderError(
                provider=self.name,
                code="PROVIDER_AUTHENTICATION",
                status_code=502,
                disables_family=True,
                **diagnostic,
            )
        if status_code == 429:
            return OcrProviderError(
                provider=self.name,
                code="PROVIDER_QUOTA",
                status_code=503,
                **diagnostic,
            )
        if status_code >= 500:
            return OcrProviderError(
                provider=self.name,
                code="PROVIDER_UNAVAILABLE",
                status_code=503,
                **diagnostic,
            )
        if status_code == 404:
            return OcrProviderError(
                provider=self.name,
                code="MODEL_UNAVAILABLE",
                status_code=502,
                **diagnostic,
            )
        return OcrProviderError(
            provider=self.name,
            code="PROVIDER_REJECTED",
            status_code=502,
            **diagnostic,
        )
