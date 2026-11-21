from __future__ import annotations

import base64

import httpx

from app.services.admin_ocr_chunking import OcrTextChunk
from app.services.admin_ocr_local import LocalOcrConfig
from app.services.ocr_ai.exceptions import OcrProviderError
from app.services.ocr_ai.prompts import SYSTEM_PROMPT, chunk_prompt, response_json_schema
from app.services.ocr_ai.schemas import ChunkCorrectionResult
from app.services.ocr_ai.validators import decode_and_validate_content


class OllamaOcrProvider:
    name = "ollama_qwen3_vl"
    family = "ollama"

    def __init__(
        self,
        config: LocalOcrConfig,
        *,
        transport: httpx.AsyncBaseTransport | None = None,
    ) -> None:
        self._config = config
        self.model = config.model
        self._transport = transport

    async def correct_chunk(
        self,
        *,
        chunk: OcrTextChunk,
        image_bytes: bytes,
        image_mime_type: str,
    ) -> ChunkCorrectionResult:
        # Ollama accepts raw base64 image bytes; the crop is generated in memory
        # by the orchestrator and is never written to a public path.
        payload = {
            "model": self.model,
            "stream": False,
            # Qwen3-VL may put its structured answer in Ollama's separate
            # `thinking` field when reasoning is left enabled. OCR consumes
            # only message.content, so explicitly request a final answer.
            "think": False,
            "format": response_json_schema(chunk.expected_word_count),
            "messages": [
                {
                    "role": "user",
                    "content": f"{SYSTEM_PROMPT}\n\n{chunk_prompt(chunk)}",
                    "images": [base64.b64encode(image_bytes).decode("ascii")],
                }
            ],
            "options": {
                "temperature": 0,
                "num_ctx": self._config.num_ctx,
                "num_predict": min(
                    self._config.num_predict,
                    max(256, 128 + chunk.expected_word_count * 16),
                ),
            },
        }
        try:
            async with httpx.AsyncClient(
                base_url=self._config.base_url + "/",
                timeout=httpx.Timeout(self._config.timeout_seconds),
                trust_env=False,
                follow_redirects=False,
                transport=self._transport,
            ) as client:
                response = await client.post("api/chat", json=payload)
                # Older or stricter Ollama builds may reject JSON Schema in `format`.
                # Retry once in plain JSON mode; decode_and_validate_content remains authoritative.
                if response.status_code in {400, 422} and isinstance(payload.get("format"), dict):
                    fallback_payload = {**payload, "format": "json"}
                    response = await client.post("api/chat", json=fallback_payload)
        except httpx.TimeoutException as exc:
            raise OcrProviderError(
                provider=self.name, code="PROVIDER_TIMEOUT", status_code=504
            ) from exc
        except httpx.RequestError as exc:
            raise OcrProviderError(
                provider=self.name, code="PROVIDER_NETWORK", status_code=503
            ) from exc
        if response.status_code != 200:
            upstream_status = response.status_code
            if upstream_status == 404:
                code = "MODEL_UNAVAILABLE"
            elif upstream_status in {400, 422}:
                code = "PROVIDER_REJECTED"
            else:
                code = "PROVIDER_UNAVAILABLE"
            raise OcrProviderError(
                provider=self.name,
                code=code,
                status_code=503,
                upstream_status_code=upstream_status,
            )
        try:
            data = response.json()
            message = data.get("message") if isinstance(data, dict) else None
            content = message.get("content") if isinstance(message, dict) else None
        except (AttributeError, TypeError, ValueError) as exc:
            raise OcrProviderError(
                provider=self.name, code="INVALID_RESPONSE", status_code=502
            ) from exc
        return decode_and_validate_content(content, chunk=chunk, provider=self.name)
