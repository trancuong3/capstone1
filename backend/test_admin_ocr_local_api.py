"""FastAPI contract tests with storage and Ollama fully mocked."""
import os
import unittest
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock, patch
from uuid import UUID

os.environ["DATABASE_URL"] = "postgresql+asyncpg://test:test@127.0.0.1:1/test"
os.environ.setdefault("SUPABASE_URL", "https://example.supabase.co")
os.environ.setdefault("SUPABASE_KEY", "isolated-test-key")

from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.api.deps import get_current_parent_id, get_db
from app.api.routes.admin_ocr import router as admin_ocr_router
from app.repositories.admin_ocr_repository import AdminOcrRepository
from app.services.admin_ocr_local import LocalCorrectionError, LocalOcrConfig
from app.services.admin_ocr_service import AdminOcrService


ACTOR = UUID("11111111-1111-4111-8111-111111111111")
PAGE_ID = UUID("33333333-3333-4333-8333-333333333333")
WORDS = [
    {
        "word_index": 0,
        "line_index": 0,
        "text": "ngay",
        "normalized_text": "ngay",
        "bbox": [0.1, 0.1, 0.2, 0.1],
        "ocr_confidence": 0.8,
    },
    {
        "word_index": 1,
        "line_index": 0,
        "text": "xua.",
        "normalized_text": "xua",
        "bbox": [0.35, 0.1, 0.2, 0.1],
        "ocr_confidence": 0.7,
    },
]


def _make_app():
    app = FastAPI()
    app.include_router(admin_ocr_router, prefix="/books")

    async def actor_override():
        return ACTOR

    async def database_override():
        yield MagicMock()

    app.dependency_overrides[get_current_parent_id] = actor_override
    app.dependency_overrides[get_db] = database_override
    return app


class AdminOcrLocalApiTests(unittest.TestCase):
    def _post(self, *, role="admin", text="ngay xua.", correction_error=None):
        app = _make_app()
        page = SimpleNamespace(Id=PAGE_ID, ImagePath="books/test.png")
        corrector = MagicMock()
        corrector.correct = AsyncMock(
            side_effect=correction_error or None,
            return_value="Ngày xưa.",
        )
        with (
            patch.object(AdminOcrRepository, "role", new=AsyncMock(return_value=role)),
            patch.object(AdminOcrRepository, "page", new=AsyncMock(return_value=page)),
            patch(
                "app.services.admin_ocr_service.download_object",
                return_value=b"test-image-bytes",
            ) as download,
            patch(
                "app.services.admin_ocr_service.LocalOcrConfig.from_environment",
                return_value=LocalOcrConfig(),
            ),
            patch(
                "app.services.admin_ocr_service.LocalOcrCorrector",
                return_value=corrector,
            ) as provider,
            TestClient(app) as client,
        ):
            response = client.post(
                f"/books/admin/pages/{PAGE_ID}/ai-correct",
                json={"draft_text": text, "words": WORDS},
            )
        return response, download, provider, corrector

    def test_admin_contract_sends_bbox_and_returns_local_result(self):
        response, download, provider, corrector = self._post()

        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(response.json(), {"corrected_text": "Ngày xưa."})
        download.assert_called_once_with("books/test.png")
        provider.assert_called_once()
        corrector.correct.assert_awaited_once_with(
            "ngay xua.",
            b"test-image-bytes",
            [(0.1, 0.1, 0.2, 0.1), (0.35, 0.1, 0.2, 0.1)],
            on_progress=None,
        )

    def test_non_admin_and_inconsistent_word_data_fail_before_storage_or_model(self):
        response, download, provider, _corrector = self._post(role="parent")
        self.assertEqual(response.status_code, 403)
        download.assert_not_called()
        provider.assert_not_called()

        response, download, provider, _corrector = self._post(text="different words")
        self.assertEqual(response.status_code, 422)
        download.assert_not_called()
        provider.assert_not_called()

    def test_local_model_error_is_returned_without_cloud_fallback(self):
        response, _download, _provider, _corrector = self._post(
            correction_error=LocalCorrectionError(
                503, "Không thể kết nối Ollama trên máy này; văn bản hiện tại được giữ nguyên."
            )
        )
        self.assertEqual(response.status_code, 503)
        self.assertIn("Ollama", response.json()["detail"])

    def test_async_job_returns_before_local_inference_and_exposes_status(self):
        from app.services.admin_ocr_service import PreparedLocalOcrCorrection

        app = _make_app()
        prepared = PreparedLocalOcrCorrection(
            config=LocalOcrConfig(),
            draft_text="ngay xua.",
            image_path="books/test.png",
            word_boxes=((0.1, 0.1, 0.2, 0.1), (0.35, 0.1, 0.2, 0.1)),
            total_chunks=2,
        )

        async def complete_job(_prepared, on_progress=None):
            on_progress(1, 2)
            on_progress(2, 2)
            return "ngày xưa."

        with (
            patch.object(
                AdminOcrService,
                "prepare_ai_correction",
                new=AsyncMock(return_value=prepared),
            ) as prepare,
            patch.object(
                AdminOcrService,
                "run_prepared_ai_correction",
                new=AsyncMock(side_effect=complete_job),
            ) as run,
            patch.object(
                AdminOcrService, "require_admin", new=AsyncMock()
            ),
            TestClient(app) as client,
        ):
            started = client.post(
                f"/books/admin/pages/{PAGE_ID}/ai-correct/jobs",
                json={"draft_text": "ngay xua.", "words": WORDS},
            )
            self.assertEqual(started.status_code, 202, started.text)
            self.assertEqual(started.json()["status"], "QUEUED")
            job_id = started.json()["job_id"]
            import time

            deadline = time.monotonic() + 2
            while time.monotonic() < deadline:
                current = client.get(
                    f"/books/admin/pages/{PAGE_ID}/ai-correct/jobs/{job_id}"
                )
                if current.json()["status"] == "SUCCEEDED":
                    break
                time.sleep(0.01)

        self.assertEqual(current.status_code, 200, current.text)
        self.assertEqual(current.json()["status"], "SUCCEEDED")
        self.assertEqual(current.json()["result"], "ngày xưa.")
        self.assertEqual(current.json()["completed_chunks"], 2)
        prepare.assert_awaited_once()
        run.assert_awaited_once()


if __name__ == "__main__":
    unittest.main()
