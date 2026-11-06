"""FastAPI-level OCR correction tests with only Gemini HTTP mocked."""

import json
import os
import re
import unittest
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock, patch
from uuid import UUID

os.environ["DATABASE_URL"] = "postgresql+asyncpg://test:test@127.0.0.1:1/test"
os.environ.setdefault("SUPABASE_URL", "https://example.supabase.co")
os.environ.setdefault("SUPABASE_KEY", "isolated-test-key")

import httpx
from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.api.deps import get_current_parent_id, get_db
from app.api.routes.admin_ocr import router as admin_ocr_router
from app.repositories.admin_ocr_repository import AdminOcrRepository
from app.services.admin_ocr_chunking import ChunkingConfig
from app.services.admin_ocr_gemini import GeminiCorrectionError, GeminiOcrConfig


ACTOR = UUID("11111111-1111-4111-8111-111111111111")
PAGE_ID = UUID("33333333-3333-4333-8333-333333333333")


def _gemini_response(request: httpx.Request) -> httpx.Response:
    payload = json.loads(request.content)
    prompt = payload["contents"][0]["parts"][1]["text"]
    chunk_id = int(re.search(r"CHUNK_ID: (\d+)", prompt).group(1))
    start = int(re.search(r"START_TOKEN_INDEX: (\d+)", prompt).group(1))
    target = prompt.split("TARGET TEXT (the only segment to correct):\n", 1)[1]
    target = target.split("\n\nNEXT CONTEXT", 1)[0]
    tokens = target.split()
    result = {
        "chunk_id": chunk_id,
        "corrected_tokens": [
            {"index": start + offset, "text": token}
            for offset, token in enumerate(tokens)
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


def _app(role="admin", image_path="books/test.png"):
    app = FastAPI()
    app.include_router(admin_ocr_router, prefix="/books")
    page = SimpleNamespace(Id=PAGE_ID, ImagePath=image_path)

    async def actor_override():
        return ACTOR

    async def database_override():
        yield MagicMock()

    app.dependency_overrides[get_current_parent_id] = actor_override
    app.dependency_overrides[get_db] = database_override
    return app, page, role


class AdminOcrGeminiApiTests(unittest.TestCase):
    def _post(
        self,
        *,
        role="admin",
        image_path="books/test.png",
        body=None,
        download_error=None,
        config_error=None,
        transport_handler=_gemini_response,
    ):
        app, page, role_value = _app(role=role, image_path=image_path)
        config = GeminiOcrConfig(
            api_key="test-secret-key",
            model="gemini-2.5-flash",
            timeout_seconds=2,
            max_retries=0,
            chunking=ChunkingConfig(max_chars=12, max_chunks=20, context_chars=24),
        )
        real_async_client = httpx.AsyncClient

        def client_factory(*args, **kwargs):
            kwargs["transport"] = httpx.MockTransport(transport_handler)
            return real_async_client(*args, **kwargs)

        with (
            patch.object(AdminOcrRepository, "role", new=AsyncMock(return_value=role_value)),
            patch.object(AdminOcrRepository, "page", new=AsyncMock(return_value=page)),
            patch(
                "app.services.admin_ocr_service.download_object",
                side_effect=download_error or [b"page-image-bytes"],
            ) as download,
            patch.object(
                GeminiOcrConfig,
                "from_environment",
                side_effect=config_error,
                return_value=config,
            ),
            patch("app.services.admin_ocr_gemini.httpx.AsyncClient", new=client_factory),
            TestClient(app) as client,
        ):
            response = client.post(
                f"/books/admin/pages/{PAGE_ID}/ai-correct",
                json=body or {"draft_text": "Trời mưa.\n\nBé đi học.\tMẹ chờ em."},
            )
        return response, download

    def test_real_endpoint_chunks_text_and_returns_only_reconstructed_target(self):
        seen = []

        def handler(request):
            seen.append(request)
            return _gemini_response(request)

        response, download = self._post(transport_handler=handler)

        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(
            response.json()["corrected_text"],
            "Trời mưa.\n\nBé đi học.\tMẹ chờ em.",
        )
        self.assertGreaterEqual(len(seen), 3)
        download.assert_called_once_with("books/test.png")
        self.assertTrue(all(request.headers["x-goog-api-key"] == "test-secret-key" for request in seen))
        self.assertTrue(all("test-secret-key" not in str(request.url) for request in seen))

    def test_non_admin_is_rejected_before_image_or_gemini_access(self):
        response, download = self._post(role="parent")

        self.assertEqual(response.status_code, 403)
        download.assert_not_called()

    def test_missing_image_and_storage_failure_fail_without_calling_gemini(self):
        response, download = self._post(image_path=None)
        self.assertEqual(response.status_code, 409)
        download.assert_not_called()

        response, download = self._post(download_error=RuntimeError("private storage detail"))
        self.assertEqual(response.status_code, 502)
        self.assertNotIn("private storage detail", response.text)
        download.assert_called_once()

    def test_invalid_input_and_missing_key_fail_before_storage_access(self):
        response, download = self._post(body={"draft_text": "   "})
        self.assertEqual(response.status_code, 422)
        download.assert_not_called()

        response, download = self._post(
            config_error=GeminiCorrectionError(
                503, "Chức năng sửa OCR bằng Gemini chưa được cấu hình."
            )
        )
        self.assertEqual(response.status_code, 503)
        self.assertNotIn("missing key", response.text)
        download.assert_not_called()


if __name__ == "__main__":
    unittest.main()
