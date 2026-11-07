"""Mocked Ollama boundary tests; no local model or external API is contacted."""
import asyncio
import base64
import json
import os
import re
import unittest
from io import BytesIO
from unittest.mock import patch

os.environ.setdefault("DATABASE_URL", "postgresql+asyncpg://test:test@127.0.0.1:1/test")
os.environ.setdefault("SUPABASE_URL", "https://example.supabase.co")
os.environ.setdefault("SUPABASE_KEY", "isolated-test-key")

import httpx
from PIL import Image

from app.services.admin_ocr_chunking import ChunkingConfig
from app.services.admin_ocr_local import (
    DEFAULT_MODEL,
    LocalCorrectionError,
    LocalOcrConfig,
    LocalOcrCorrector,
)


def _image():
    output = BytesIO()
    Image.new("RGB", (500, 300), "white").save(output, format="PNG")
    return output.getvalue()


def _boxes(count):
    return [
        (0.08 + index * 0.2, 0.15, 0.12, 0.08)
        for index in range(count)
    ]


def _config(**kwargs):
    values = {
        "base_url": "http://127.0.0.1:11434",
        "model": DEFAULT_MODEL,
        "timeout_seconds": 2,
        "total_timeout_seconds": 10,
        "num_ctx": 4096,
        "num_predict": 1024,
        "chunking": ChunkingConfig(
            max_bytes=100, max_words=2, max_chunks=10,
            context_bytes=20, max_document_bytes=1000,
        ),
    }
    values.update(kwargs)
    return LocalOcrConfig(**values)


def _response_for_request(request, *, corrupt_output=False):
    payload = json.loads(request.content)
    prompt = payload["messages"][0]["content"]
    chunk_id = int(re.search(r"CHUNK_ID: (\d+)", prompt).group(1))
    source_line = prompt.split("SOURCE WORDS JSON:\n", 1)[1]
    source_words = json.loads(source_line)
    corrections = [item["text"] for item in source_words]
    if corrupt_output:
        corrections[0] += " invalid"
    result = json.dumps(
        {"chunk_id": chunk_id, "corrected_words": corrections},
        ensure_ascii=False,
    )
    return httpx.Response(
        200,
        json={"message": {"content": result}, "done_reason": "stop"},
    )


class LocalOcrProviderTests(unittest.IsolatedAsyncioTestCase):
    async def test_uses_loopback_json_schema_image_crops_and_preserves_spacing(self):
        seen = []

        async def handler(request):
            seen.append(request)
            return _response_for_request(request)

        text = "ngay   xua,\tbe."
        result = await LocalOcrCorrector(
            _config(chunking=ChunkingConfig(
                max_bytes=100, max_words=10, max_chunks=10,
                context_bytes=20, max_document_bytes=1000,
            )),
            transport=httpx.MockTransport(handler),
        ).correct(text, _image(), _boxes(3))

        self.assertEqual(result, text)
        self.assertEqual(len(seen), 1)
        self.assertEqual(str(seen[0].url), "http://127.0.0.1:11434/api/chat")
        payload = json.loads(seen[0].content)
        self.assertEqual(payload["model"], DEFAULT_MODEL)
        self.assertEqual(payload["options"]["num_ctx"], 4096)
        self.assertEqual(payload["options"]["num_predict"], 256)
        schema = payload["format"]["properties"]["corrected_words"]
        self.assertEqual(schema["minItems"], 3)
        self.assertEqual(schema["maxItems"], 3)
        self.assertEqual(schema["items"]["type"], "string")
        self.assertEqual(seen[0].url.host, "127.0.0.1")
        crop = base64.b64decode(payload["messages"][0]["images"][0])
        with Image.open(BytesIO(crop)) as decoded:
            self.assertEqual(decoded.format, "JPEG")
            self.assertLessEqual(max(decoded.size), 2048)

    async def test_chunks_run_sequentially_and_bad_output_rejects_document(self):
        seen = []

        async def handler(request):
            seen.append(request.url)
            return _response_for_request(request)

        text = "một hai ba bốn năm"
        result = await LocalOcrCorrector(
            _config(),
            transport=httpx.MockTransport(handler),
        ).correct(text, _image(), _boxes(5))

        self.assertEqual(result, text)
        self.assertEqual(len(seen), 3)
        self.assertTrue(all(url.host == "127.0.0.1" for url in seen))

        async def bad_handler(request):
            return _response_for_request(request, corrupt_output=True)

        with self.assertRaises(LocalCorrectionError) as caught:
            await LocalOcrCorrector(
                _config(),
                transport=httpx.MockTransport(bad_handler),
            ).correct(text, _image(), _boxes(5))
        self.assertEqual(caught.exception.status_code, 502)

    async def test_non_success_and_redirect_responses_do_not_fallback_or_follow(self):
        seen = []

        async def handler(request):
            seen.append(request)
            return httpx.Response(
                302,
                headers={"Location": "https://generativelanguage.googleapis.com/"},
            )

        with self.assertRaises(LocalCorrectionError) as caught:
            await LocalOcrCorrector(
                _config(),
                transport=httpx.MockTransport(handler),
            ).correct("ngay.", _image(), _boxes(1))
        self.assertEqual(caught.exception.status_code, 502)
        self.assertEqual(len(seen), 1)
        self.assertEqual(seen[0].url.host, "127.0.0.1")

    async def test_total_timeout_is_bounded(self):
        async def slow_handler(_request):
            await asyncio.sleep(0.1)
            return httpx.Response(200, json={})

        with self.assertRaises(LocalCorrectionError) as caught:
            await LocalOcrCorrector(
                _config(total_timeout_seconds=0.01),
                transport=httpx.MockTransport(slow_handler),
            ).correct("ngay.", _image(), _boxes(1))
        self.assertEqual(caught.exception.status_code, 504)

    async def test_url_configuration_rejects_non_loopback_hosts_and_paths(self):
        for value in (
            "https://127.0.0.1:11434",
            "http://example.com:11434",
            "http://10.0.0.2:11434",
            "http://user:pass@127.0.0.1:11434",
            "http://127.0.0.1:11434/api",
            "http://127.0.0.1:11434/?key=secret",
        ):
            with self.subTest(value=value), patch.dict(
                os.environ, {"LOCAL_OCR_BASE_URL": value}, clear=False
            ):
                with self.assertRaises(LocalCorrectionError):
                    LocalOcrConfig.from_environment()

        with patch.dict(
            os.environ, {"LOCAL_OCR_MAX_CHUNK_BYTES": "bad"}, clear=False
        ):
            with self.assertRaises(LocalCorrectionError):
                LocalOcrConfig.from_environment()


if __name__ == "__main__":
    unittest.main()
