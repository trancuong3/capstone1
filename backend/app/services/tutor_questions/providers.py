from __future__ import annotations

import json
from typing import Any, Protocol

import httpx

from app.services.tutor_questions.prompts import (
    SYSTEM_PROMPT,
    response_json_schema,
    user_prompt,
)
from app.services.tutor_questions.types import QuestionProviderError, SourcePage

_GEMINI_API_BASE = "https://generativelanguage.googleapis.com/v1beta"
_GROQ_CHAT_URL = "https://api.groq.com/openai/v1/chat/completions"


class QuestionProvider(Protocol):
    name: str

    async def generate(
        self, *, pages: list[SourcePage], count: int, max_chars: int
    ) -> Any:
        """Return the decoded JSON payload. The caller validates every field."""
        ...


def _http_error(provider: str, status_code: int) -> QuestionProviderError:
    if status_code in (401, 403):
        return QuestionProviderError(provider=provider, code="PROVIDER_AUTHENTICATION")
    if status_code == 429:
        return QuestionProviderError(provider=provider, code="PROVIDER_QUOTA")
    if status_code >= 500:
        return QuestionProviderError(provider=provider, code="PROVIDER_UNAVAILABLE")
    if status_code == 404:
        return QuestionProviderError(provider=provider, code="MODEL_UNAVAILABLE")
    return QuestionProviderError(provider=provider, code="PROVIDER_REJECTED")


def _decode_json(provider: str, text: Any) -> Any:
    if not isinstance(text, str) or not text.strip():
        raise QuestionProviderError(provider=provider, code="INVALID_RESPONSE")
    cleaned = text.strip()
    if cleaned.startswith("```"):
        cleaned = cleaned.strip("`")
        cleaned = cleaned[4:] if cleaned.lower().startswith("json") else cleaned
    try:
        return json.loads(cleaned)
    except ValueError as exc:
        raise QuestionProviderError(provider=provider, code="INVALID_RESPONSE") from exc


async def _post(
    provider: str,
    url: str,
    *,
    headers: dict[str, str],
    payload: dict[str, Any],
    timeout_seconds: int,
    transport: httpx.AsyncBaseTransport | None,
) -> Any:
    try:
        async with httpx.AsyncClient(
            timeout=httpx.Timeout(timeout_seconds),
            trust_env=False,
            follow_redirects=False,
            transport=transport,
        ) as client:
            response = await client.post(url, headers=headers, json=payload)
    except httpx.TimeoutException as exc:
        raise QuestionProviderError(provider=provider, code="PROVIDER_TIMEOUT") from exc
    except httpx.RequestError as exc:
        raise QuestionProviderError(provider=provider, code="PROVIDER_NETWORK") from exc
    if response.status_code != 200:
        raise _http_error(provider, response.status_code)
    try:
        return response.json()
    except ValueError as exc:
        raise QuestionProviderError(provider=provider, code="INVALID_RESPONSE") from exc


class GeminiQuestionProvider:
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

    async def generate(
        self, *, pages: list[SourcePage], count: int, max_chars: int
    ) -> Any:
        payload = {
            "systemInstruction": {"parts": [{"text": SYSTEM_PROMPT}]},
            "contents": [
                {
                    "role": "user",
                    "parts": [{"text": user_prompt(pages, count=count, max_chars=max_chars)}],
                }
            ],
            "generationConfig": {
                "temperature": 0.7,
                "responseMimeType": "application/json",
                "responseJsonSchema": response_json_schema(count),
            },
        }
        data = await _post(
            self.name,
            f"{_GEMINI_API_BASE}/models/{self.model}:generateContent",
            headers={"x-goog-api-key": self._api_key},
            payload=payload,
            timeout_seconds=self._timeout_seconds,
            transport=self._transport,
        )
        try:
            text = data["candidates"][0]["content"]["parts"][0]["text"]
        except (KeyError, IndexError, TypeError) as exc:
            raise QuestionProviderError(
                provider=self.name, code="INVALID_RESPONSE"
            ) from exc
        return _decode_json(self.name, text)


class GroqQuestionProvider:
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

    async def generate(
        self, *, pages: list[SourcePage], count: int, max_chars: int
    ) -> Any:
        schema_hint = json.dumps(response_json_schema(count), ensure_ascii=False)
        payload = {
            "model": self.model,
            "temperature": 0.7,
            "response_format": {"type": "json_object"},
            "messages": [
                {
                    "role": "system",
                    "content": f"{SYSTEM_PROMPT}\n\nJSON schema phải tuân theo:\n{schema_hint}",
                },
                {
                    "role": "user",
                    "content": user_prompt(pages, count=count, max_chars=max_chars),
                },
            ],
        }
        data = await _post(
            self.name,
            _GROQ_CHAT_URL,
            headers={"Authorization": f"Bearer {self._api_key}"},
            payload=payload,
            timeout_seconds=self._timeout_seconds,
            transport=self._transport,
        )
        try:
            text = data["choices"][0]["message"]["content"]
        except (KeyError, IndexError, TypeError) as exc:
            raise QuestionProviderError(
                provider=self.name, code="INVALID_RESPONSE"
            ) from exc
        return _decode_json(self.name, text)
