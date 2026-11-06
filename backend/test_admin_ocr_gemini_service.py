"""Mocked HTTP-boundary tests for Gemini OCR orchestration and fail-closed output."""

import base64
import json
import os
import re
import unittest
from unittest.mock import patch

os.environ.setdefault("DATABASE_URL", "postgresql+asyncpg://test:test@127.0.0.1:1/test")
os.environ.setdefault("SUPABASE_URL", "https://example.supabase.co")
os.environ.setdefault("SUPABASE_KEY", "isolated-test-key")

import httpx

from app.services.admin_ocr_chunking import ChunkingConfig
from app.services.admin_ocr_gemini import (
    GeminiCorrectionError,
    GeminiOcrConfig,
    GeminiOcrCorrector,
)


def _prompt_details(request: httpx.Request):
    payload = json.loads(request.content)
    text = payload["contents"][0]["parts"][1]["text"]
    chunk_id = int(re.search(r"CHUNK_ID: (\d+)", text).group(1))
    start = int(re.search(r"START_TOKEN_INDEX: (\d+)", text).group(1))
    target = text.split("TARGET TEXT (the only segment to correct):\n", 1)[1]
    target = target.split("\n\nNEXT CONTEXT", 1)[0]
    previous = text.split("PREVIOUS CONTEXT (read-only; do not include in output):\n", 1)[1]
    previous = previous.split("\n\nTARGET TEXT", 1)[0]
    following = text.split("NEXT CONTEXT (read-only; do not include in output):\n", 1)[1]
    following = following.split("\n\nORIGINAL PAGE IMAGE", 1)[0]
    return chunk_id, start, target.split(), previous, following


def _response(chunk_id, start, tokens, *, finish="STOP", split_text=False):
    result = {
        "chunk_id": chunk_id,
        "corrected_tokens": [
            {"index": start + offset, "text": token}
            for offset, token in enumerate(tokens)
        ],
    }
    rendered = json.dumps(result, ensure_ascii=False)
    parts = (
        [rendered[: len(rendered) // 2], rendered[len(rendered) // 2 :]]
        if split_text
        else [rendered]
    )
    return httpx.Response(
        200,
        json={
            "candidates": [
                {
                    "finishReason": finish,
                    "content": {"parts": [{"text": part} for part in parts]},
                }
            ]
        },
    )


def _wrong_order_response(chunk_id, start, tokens):
    result = {
        "chunk_id": chunk_id,
        "corrected_tokens": [
            {"index": start + offset, "text": token}
            for offset, token in reversed(list(enumerate(tokens)))
        ],
    }
    return httpx.Response(
        200,
        json={
            "candidates": [
                {
                    "finishReason": "STOP",
                    "content": {
                        "parts": [{"text": json.dumps(result, ensure_ascii=False)}]
                    },
                }
            ]
        },
    )


def _config(*, max_chars=5000, max_chunks=64, max_retries=0, context_chars=30):
    return GeminiOcrConfig(
        api_key="test-secret-key",
        model="gemini-2.5-flash",
        timeout_seconds=3,
        max_retries=max_retries,
        chunking=ChunkingConfig(
            max_chars=max_chars,
            max_chunks=max_chunks,
            context_chars=context_chars,
        ),
    )


class GeminiOcrServiceTests(unittest.IsolatedAsyncioTestCase):
    async def test_single_chunk_uses_structured_output_image_and_original_spacing(self):
        text = "Ngày  xưa,\ttrời mưa.\nBé đi học."
        seen = []
        image_bytes = b"original-image-bytes"

        async def handler(request):
            details = _prompt_details(request)
            payload = json.loads(request.content)
            seen.append((request, details, payload))
            chunk_id, start, tokens, _previous, _following = details
            corrected = ["đến" if token == "đi" else token for token in tokens]
            return _response(chunk_id, start, corrected, split_text=True)

        corrector = GeminiOcrCorrector(
            _config(), transport=httpx.MockTransport(handler), sleep=lambda _delay: None
        )
        result = await corrector.correct(text, image_bytes, "image/png")

        self.assertEqual(result, "Ngày  xưa,\ttrời mưa.\nBé đến học.")
        self.assertEqual(len(seen), 1)
        request, details, payload = seen[0]
        self.assertEqual(request.headers["x-goog-api-key"], "test-secret-key")
        self.assertNotIn("test-secret-key", str(request.url))
        self.assertEqual(details[2], text.split())
        generation = payload["generationConfig"]
        self.assertEqual(generation["responseMimeType"], "application/json")
        self.assertEqual(generation["responseSchema"]["properties"]["chunk_id"]["type"], "INTEGER")
        attached = payload["contents"][0]["parts"][0]["inlineData"]
        self.assertEqual(attached["mimeType"], "image/png")
        self.assertEqual(base64.b64decode(attached["data"]), image_bytes)

    async def test_multiple_chunks_include_neighbor_context_and_reuse_image(self):
        text = "Trời mưa. Bé đi học. Mẹ chờ em."
        observations = []
        image_bytes = b"one-image-object"

        async def handler(request):
            chunk_id, start, tokens, previous, following = _prompt_details(request)
            payload = json.loads(request.content)
            attached = payload["contents"][0]["parts"][0]["inlineData"]
            observations.append(
                (chunk_id, start, tokens, previous, following, base64.b64decode(attached["data"]))
            )
            return _response(chunk_id, start, tokens)

        corrector = GeminiOcrCorrector(
            _config(max_chars=12, context_chars=20),
            transport=httpx.MockTransport(handler),
            sleep=lambda _delay: None,
        )
        result = await corrector.correct(text, image_bytes, "image/jpeg")

        self.assertEqual(result, text)
        self.assertGreaterEqual(len(observations), 3)
        self.assertEqual([row[0] for row in observations], list(range(len(observations))))
        self.assertTrue(all(row[5] == image_bytes for row in observations))
        self.assertIn("Trời mưa.", observations[1][3])
        self.assertIn("Mẹ chờ em.", observations[1][4])

    async def test_retries_only_the_invalid_chunk(self):
        text = "một hai ba bốn năm"
        seen = []

        async def handler(request):
            chunk_id, start, tokens, _previous, _following = _prompt_details(request)
            seen.append((chunk_id, start))
            if chunk_id == 1 and seen.count((chunk_id, start)) == 1:
                return httpx.Response(200, json={"candidates": []})
            return _response(chunk_id, start, tokens)

        corrector = GeminiOcrCorrector(
            _config(max_chars=7, max_retries=1),
            transport=httpx.MockTransport(handler),
            sleep=lambda _delay: None,
            jitter=lambda _delay: 0,
        )
        result = await corrector.correct(text, b"image", "image/png")

        self.assertEqual(result, text)
        self.assertEqual(seen, [(0, 0), (1, 2), (1, 2), (2, 4)])

    async def test_failed_chunk_rejects_entire_document_after_bounded_retries(self):
        text = "một hai ba bốn năm"
        seen = []

        async def handler(request):
            chunk_id, start, tokens, _previous, _following = _prompt_details(request)
            seen.append(chunk_id)
            if chunk_id == 1:
                return httpx.Response(200, json={"candidates": []})
            return _response(chunk_id, start, tokens)

        corrector = GeminiOcrCorrector(
            _config(max_chars=7, max_retries=1),
            transport=httpx.MockTransport(handler),
            sleep=lambda _delay: None,
            jitter=lambda _delay: 0,
        )
        with self.assertRaises(GeminiCorrectionError) as caught:
            await corrector.correct(text, b"image", "image/png")
        self.assertEqual(caught.exception.status_code, 502)
        self.assertEqual(seen, [0, 1, 1])

    async def test_rejects_wrong_id_order_count_markdown_truncation_and_safety(self):
        cases = (
            ("wrong chunk", lambda chunk, start, tokens: _response(chunk + 1, start, tokens)),
            ("wrong order", _wrong_order_response),
            ("missing token", lambda chunk, start, tokens: _response(chunk, start, tokens[:-1])),
            ("extra token", lambda chunk, start, tokens: _response(chunk, start, tokens + ["thừa"])),
            (
                "changed punctuation",
                lambda chunk, start, tokens: _response(
                    chunk,
                    start,
                    [token[:-1] + "!" if token.endswith(".") else token for token in tokens],
                ),
            ),
            (
                "markdown",
                lambda _chunk, _start, _tokens: httpx.Response(
                    200,
                    json={
                        "candidates": [
                            {
                                "finishReason": "STOP",
                                "content": {"parts": [{"text": chr(96) * 3 + "json\n{}\n" + chr(96) * 3}]},
                            }
                        ]
                    },
                ),
            ),
            ("truncated", lambda chunk, start, tokens: _response(chunk, start, tokens, finish="MAX_TOKENS")),
            ("safety", lambda chunk, start, tokens: _response(chunk, start, tokens, finish="SAFETY")),
        )
        for label, build in cases:
            with self.subTest(label=label):
                async def handler(request):
                    chunk, start, tokens, _previous, _following = _prompt_details(request)
                    return build(chunk, start, tokens)

                corrector = GeminiOcrCorrector(
                    _config(), transport=httpx.MockTransport(handler), sleep=lambda _delay: None
                )
                with self.assertRaises(GeminiCorrectionError):
                    await corrector.correct("Ngày xưa có bé.", b"image", "image/jpeg")

    async def test_permanent_and_transient_http_errors_are_classified(self):
        for status in (400, 401, 403):
            with self.subTest(status=status):
                calls = 0

                async def handler(_request):
                    nonlocal calls
                    calls += 1
                    return httpx.Response(status, json={"error": {"message": "private details"}})

                corrector = GeminiOcrCorrector(
                    _config(max_retries=3),
                    transport=httpx.MockTransport(handler),
                    sleep=lambda _delay: None,
                )
                with self.assertRaises(GeminiCorrectionError):
                    await corrector.correct("Ngày xưa.", b"image", "image/png")
                self.assertEqual(calls, 1)

        calls = 0
        sleeps = []

        async def temporary_handler(request):
            nonlocal calls
            calls += 1
            if calls == 1:
                return httpx.Response(
                    429,
                    headers={"Retry-After": "2"},
                    json={"error": {"message": "requests per minute rate limit"}},
                )
            chunk, start, tokens, _previous, _following = _prompt_details(request)
            return _response(chunk, start, tokens)

        corrector = GeminiOcrCorrector(
            _config(max_retries=1),
            transport=httpx.MockTransport(temporary_handler),
            sleep=lambda delay: sleeps.append(delay),
        )
        self.assertEqual(
            await corrector.correct("Ngày xưa.", b"image", "image/png"),
            "Ngày xưa.",
        )
        self.assertEqual(calls, 2)
        self.assertEqual(sleeps, [2.0])

    async def test_exhausted_quota_is_not_retried_and_secrets_are_not_in_error(self):
        calls = 0

        async def handler(_request):
            nonlocal calls
            calls += 1
            return httpx.Response(
                429,
                json={"error": {"message": "You exceeded your daily quota; billing required"}},
            )

        corrector = GeminiOcrCorrector(
            _config(max_retries=3), transport=httpx.MockTransport(handler)
        )
        with self.assertRaises(GeminiCorrectionError) as caught:
            await corrector.correct("Ngày xưa.", b"image", "image/png")
        self.assertEqual(calls, 1)
        self.assertEqual(caught.exception.status_code, 429)
        self.assertNotIn("test-secret-key", caught.exception.detail)
        self.assertIn("quota", caught.exception.detail.lower())

    async def test_timeout_obeys_maximum_retry_count(self):
        calls = 0

        async def handler(_request):
            nonlocal calls
            calls += 1
            raise httpx.ReadTimeout("network timeout")

        corrector = GeminiOcrCorrector(
            _config(max_retries=2),
            transport=httpx.MockTransport(handler),
            sleep=lambda _delay: None,
            jitter=lambda _delay: 0,
        )
        with self.assertRaises(GeminiCorrectionError):
            await corrector.correct("Ngày xưa.", b"image", "image/png")
        self.assertEqual(calls, 3)

    async def test_environment_configuration_is_validated(self):
        with patch.dict(os.environ, {"GEMINI_API_KEY": "", "GEMINI_MODEL": "gemini-2.5-flash"}):
            with self.assertRaises(GeminiCorrectionError):
                GeminiOcrConfig.from_environment()
        invalid_values = (
            {"GEMINI_MODEL": "invalid/model"},
            {"GEMINI_OCR_TIMEOUT_SECONDS": "999"},
            {"GEMINI_OCR_MAX_RETRIES": "99"},
            {"GEMINI_OCR_CHUNK_MAX_CHARS": "not-an-int"},
        )
        for override in invalid_values:
            with self.subTest(override=override):
                environment = {
                    "GEMINI_API_KEY": "test-key",
                    "GEMINI_MODEL": "gemini-2.5-flash",
                    "GEMINI_OCR_TIMEOUT_SECONDS": "45",
                    "GEMINI_OCR_MAX_RETRIES": "2",
                    "GEMINI_OCR_CHUNK_MAX_CHARS": "5000",
                    **override,
                }
                with patch.dict(os.environ, environment):
                    with self.assertRaises(GeminiCorrectionError):
                        GeminiOcrConfig.from_environment()


if __name__ == "__main__":
    unittest.main()
