"""OCR input contracts and protected write endpoints; never touches live Supabase."""
import os
import unittest
from unittest.mock import AsyncMock, MagicMock
from uuid import UUID

os.environ.setdefault("DATABASE_URL", "postgresql+asyncpg://test:test@127.0.0.1:1/test")
os.environ.setdefault("SUPABASE_URL", "https://example.supabase.co")
os.environ.setdefault("SUPABASE_KEY", "isolated-test-key")

from fastapi import FastAPI
from fastapi.testclient import TestClient
from fastapi import HTTPException
from pydantic import ValidationError

from app.api.deps import get_current_parent_id, get_db
from app.api.routes.admin_ocr import router as admin_ocr_router
from app.api.routes.admin_viread_training import _require_training_worker_token, _safe_runtime
from app.schemas.admin_ocr import (
    AdminBookCreateRequest,
    AdminOcrProofreadAuditInput,
    AdminOcrProofreadSuggestionInput,
    AdminOcrWordInput,
)
from app.schemas.viread_ocr_training import TrainingWorkerStatus
from app.services.admin_ocr_service import AdminOcrService
from app.services.ocr_engine import normalize_text_tokens, normalize_word

ACTOR = UUID("11111111-1111-4111-8111-111111111111")
BOOK = UUID("22222222-2222-4222-8222-222222222222")
PAGE = UUID("33333333-3333-4333-8333-333333333333")
REVISION = UUID("44444444-4444-4444-8444-444444444444")


class AdminOcrSchemaTests(unittest.TestCase):
    def test_book_create_normalizes_strings_and_grade_range(self):
        request = AdminBookCreateRequest(name="  Tên mèo  ", title="  Chú mèo  ", author="  Nguyễn Văn A  ", min_grade=1, max_grade=3)
        self.assertEqual(request.name, "Tên mèo")
        self.assertEqual(request.title, "Chú mèo")
        self.assertEqual(request.author, "Nguyễn Văn A")

    def test_book_create_rejects_blank_title_and_inverted_grades(self):
        for payload in (
            dict(name="Tên sách", title="  ", min_grade=1, max_grade=2),
            dict(name="Tên sách", title="Book", min_grade=4, max_grade=2),
        ):
            with self.subTest(payload=payload), self.assertRaises(ValidationError):
                AdminBookCreateRequest(**payload)

    def test_bbox_is_normalized_positive_and_inside_image(self):
        word = AdminOcrWordInput(
            word_index=0, line_index=0, text="Chú", normalized_text="chú",
            bbox=(0.1, 0.2, 0.08, 0.04), ocr_confidence=0.93,
        )
        self.assertEqual(word.bbox, (0.1, 0.2, 0.08, 0.04))
        for bbox in (
            (-0.1, 0.2, 0.1, 0.1),
            (0.9, 0.2, 0.2, 0.1),
            (0.1, 0.2, 0, 0.1),
        ):
            with self.subTest(bbox=bbox), self.assertRaises(ValidationError):
                AdminOcrWordInput(
                    word_index=0, line_index=0, text="x", normalized_text="x",
                    bbox=bbox, ocr_confidence=None,
                )

    def test_colab_worker_status_requires_known_state_and_sanitizes_runtime(self):
        status = TrainingWorkerStatus(
            worker_id="colab-test", status="WAITING_FOR_GPU",
            reason_code="COLAB_CUDA_UNAVAILABLE",
            runtime={"device": "T4", "vram_free_bytes": 0, "secret": "must not persist",
                     "vram_total_bytes": 8.5, "ram_available_bytes": True},
        )
        self.assertEqual(_safe_runtime(status.runtime), {"device": "T4", "vram_free_bytes": 0})
        with self.assertRaises(ValidationError):
            TrainingWorkerStatus(worker_id="colab-test", status="TRAINING", runtime={})

    def test_vietnamese_normalizer_preserves_accents_and_normalizes_unicode(self):
        self.assertEqual(normalize_word("  CHU\u0301,  "), "chú")
        self.assertEqual(normalize_text_tokens("CHÚ mèo nhỏ!"), ["chú", "mèo", "nhỏ"])

    def test_ai_suggestion_is_applied_only_when_admin_accepts_it(self):
        suggestion = AdminOcrProofreadSuggestionInput(
            word_index=0, original="Xin", proposed="Xịn", decision="ACCEPTED",
        )
        audit = AdminOcrProofreadAuditInput(
            mode="AI_CHECKED", checked_text="Xin chào", suggestions=[suggestion],
        )
        decisions = AdminOcrService._validate_proofread_final(audit, "Xịn chào")
        self.assertEqual(decisions[0]["decision"], "ACCEPTED")
        with self.assertRaises(HTTPException) as error:
            AdminOcrService._validate_proofread_final(audit, "Xin chào")
        self.assertEqual(error.exception.status_code, 422)

    def test_rejected_ai_suggestion_preserves_the_original_ground_truth(self):
        audit = AdminOcrProofreadAuditInput(
            mode="AI_CHECKED", checked_text="Xin chào",
            suggestions=[AdminOcrProofreadSuggestionInput(
                word_index=0, original="Xin", proposed="Xịn", decision="REJECTED",
            )],
        )
        decisions = AdminOcrService._validate_proofread_final(audit, "Xin chào")
        self.assertEqual(decisions[0]["decision"], "REJECTED")
        with self.assertRaises(HTTPException):
            AdminOcrService._validate_proofread_final(audit, "Xịn chào")

    def test_colab_worker_credential_is_scoped_and_required(self):
        token = "test-worker-token-" + ("x" * 48)
        with unittest.mock.patch.dict(os.environ, {"VIREAD_TRAINING_WORKER_TOKEN": token}):
            self.assertIsNone(_require_training_worker_token(token))
            with self.assertRaises(HTTPException) as error:
                _require_training_worker_token("invalid-worker-token")
            self.assertEqual(error.exception.status_code, 401)
        with unittest.mock.patch.dict(os.environ, {"VIREAD_TRAINING_WORKER_TOKEN": ""}):
            with self.assertRaises(HTTPException) as error:
                _require_training_worker_token(token)
            self.assertEqual(error.exception.status_code, 503)

    def test_manual_fallback_must_audit_the_exact_text_being_verified(self):
        audit = AdminOcrProofreadAuditInput(
            mode="MANUAL_FALLBACK", checked_text="Xin chào", suggestions=[],
            reason_code="AI_CHECK_UNAVAILABLE",
        )
        self.assertEqual(AdminOcrService._validate_proofread_final(audit, "Xin chào"), [])
        with self.assertRaises(HTTPException):
            AdminOcrService._validate_proofread_final(audit, "Xịn chào")


class AdminOcrAuthorizationTests(unittest.TestCase):
    def setUp(self):
        self.db = MagicMock()
        self.db.scalar = AsyncMock(return_value="parent")
        self.db.commit = AsyncMock()
        self.db.refresh = AsyncMock()
        self.db.rollback = AsyncMock()
        self.db.add = MagicMock()
        self.db.add_all = MagicMock()
        self.app = FastAPI()
        self.app.include_router(admin_ocr_router, prefix="/books")
        self.app.dependency_overrides[get_db] = lambda: self.db
        self.client = TestClient(self.app)

    def tearDown(self):
        self.app.dependency_overrides.clear()

    def test_all_write_routes_require_bearer_identity(self):
        headers = {}
        response_cases = [
            self.client.post("/books/admin/catalog", json={"name": "Book name", "title": "Book", "author": None, "min_grade": 1, "max_grade": 2}, headers=headers),
            self.client.post(f"/books/admin/catalog/{BOOK}/pages", data={"page_number": "1"}, files={"image": ("page.png", b"not-an-image", "image/png")}, headers=headers),
            self.client.put(f"/books/admin/pages/{PAGE}/revisions/{REVISION}/draft", json={"draft_text": "text", "words": []}, headers=headers),
            self.client.post(f"/books/admin/pages/{PAGE}/verify", json={
                "page_revision_id": str(REVISION), "corrected_text": "a",
                "words": [{"word_index": 0, "line_index": 0, "text": "a", "normalized_text": "a",
                           "bbox": [0.1, 0.1, 0.1, 0.1], "ocr_confidence": None}],
            }, headers=headers),
            self.client.post(f"/books/admin/pages/{PAGE}/reprocess", headers=headers),
        ]
        self.assertEqual([response.status_code for response in response_cases], [401] * 5)
        self.db.scalar.assert_not_awaited()
        self.db.add.assert_not_called()
        self.db.commit.assert_not_awaited()

    def test_parent_cannot_create_admin_book_even_with_role_in_body(self):
        self.app.dependency_overrides[get_current_parent_id] = lambda: ACTOR
        response = self.client.post("/books/admin/catalog", json={
            "name": "Book name", "title": "Book", "author": None, "min_grade": 1, "max_grade": 2, "role": "admin",
            "createdby": str(ACTOR),
        })
        self.assertEqual(response.status_code, 403)
        self.db.add.assert_not_called()
        self.db.commit.assert_not_awaited()


if __name__ == "__main__":
    unittest.main()
