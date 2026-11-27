from __future__ import annotations

import base64

import httpx

from app.services.admin_ocr_chunking import OcrTextChunk
from app.services.admin_ocr_local import LocalOcrConfig
from app.services.ocr_ai.exceptions import OcrProviderError
from app.services.ocr_ai.prompts import (
    SYSTEM_PROMPT,
    chunk_prompt,
    json_output_contract,
    response_json_schema,
)
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
        self._client: httpx.AsyncClient | None = None

    def _get_client(self) -> httpx.AsyncClient:
        if self._client is None or self._client.is_closed:
            self._client = httpx.AsyncClient(
                base_url=self._config.base_url + "/",
                timeout=httpx.Timeout(self._config.timeout_seconds),
                trust_env=False,
                follow_redirects=False,
                transport=self._transport,
            )
        return self._client

    async def aclose(self) -> None:
        if self._client is not None and not self._client.is_closed:
            await self._client.aclose()
        self._client = None

    def _build_payload(
        self,
        *,
        chunk: OcrTextChunk,
        image_b64: str,
        use_json_fallback: bool,
    ) -> dict[str, object]:
        prompt_text = f"{SYSTEM_PROMPT}\n\n{chunk_prompt(chunk)}"
        if use_json_fallback:
            prompt_text = f"{prompt_text}{json_output_contract(chunk)}"
        return {
            "model": self.model,
            "stream": False,
            # Qwen3-VL may put its structured answer in Ollama's separate
            # `thinking` field when reasoning is left enabled. OCR consumes
            # only message.content, so explicitly request a final answer.
            "think": False,
            "keep_alive": self._config.keep_alive,
            "format": (
                "json"
                if use_json_fallback
                else response_json_schema(chunk.expected_word_count)
            ),
            "messages": [
                {
                    "role": "user",
                    "content": prompt_text,
                    "images": [image_b64],
                }
            ],
            "options": self._config.build_ollama_options(
                num_predict=min(
                    self._config.num_predict,
                    max(256, 128 + chunk.expected_word_count * 16),
                ),
            ),
        }

    async def correct_chunk(
        self,
        *,
        chunk: OcrTextChunk,
        image_bytes: bytes,
        image_mime_type: str,
    ) -> ChunkCorrectionResult:
        # Ollama accepts raw base64 image bytes; the crop is generated in memory
        # by the orchestrator and is never written to a public path.
        image_b64 = base64.b64encode(image_bytes).decode("ascii")
        try:
            client = self._get_client()
            response = await client.post(
                "api/chat",
                json=self._build_payload(
                    chunk=chunk,
                    image_b64=image_b64,
                    use_json_fallback=False,
                ),
            )
            if response.status_code in (400, 422):
                response = await client.post(
                    "api/chat",
                    json=self._build_payload(
                        chunk=chunk,
                        image_b64=image_b64,
                        use_json_fallback=True,
                    ),
                )
        except httpx.TimeoutException as exc:
            raise OcrProviderError(
                provider=self.name,
                code="PROVIDER_TIMEOUT",
                status_code=504,
                disables_family=True,
            ) from exc
        except httpx.RequestError as exc:
            raise OcrProviderError(
                provider=self.name,
                code="PROVIDER_NETWORK",
                status_code=503,
                disables_family=True,
            ) from exc
        if response.status_code != 200:
            raise OcrProviderError(
                provider=self.name,
                code="MODEL_UNAVAILABLE"
                if response.status_code in (400, 404)
                else "PROVIDER_UNAVAILABLE",
                status_code=503,
                upstream_status_code=response.status_code,
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
