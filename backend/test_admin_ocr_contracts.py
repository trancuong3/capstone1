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
from pydantic import ValidationError

from app.api.deps import get_current_parent_id, get_db
from app.api.routes.admin_ocr import router as admin_ocr_router
from app.schemas.admin_ocr import AdminBookCreateRequest, AdminOcrWordInput
from app.services.ocr_engine import normalize_text_tokens, normalize_word

ACTOR = UUID("11111111-1111-4111-8111-111111111111")
BOOK = UUID("22222222-2222-4222-8222-222222222222")
PAGE = UUID("33333333-3333-4333-8333-333333333333")
REVISION = UUID("44444444-4444-4444-8444-444444444444")


class AdminOcrSchemaTests(unittest.TestCase):
    def test_book_create_normalizes_strings_and_grade_range(self):
        request = AdminBookCreateRequest(title="  Chú mèo  ", author="  Nguyễn Văn A  ", min_grade=1, max_grade=3)
        self.assertEqual(request.title, "Chú mèo")
        self.assertEqual(request.author, "Nguyễn Văn A")

    def test_book_create_rejects_blank_title_and_inverted_grades(self):
        for payload in (
            dict(title="  ", min_grade=1, max_grade=2),
            dict(title="Book", min_grade=4, max_grade=2),
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

    def test_vietnamese_normalizer_preserves_accents_and_normalizes_unicode(self):
        self.assertEqual(normalize_word("  CHU\u0301,  "), "chú")
        self.assertEqual(normalize_text_tokens("CHÚ mèo nhỏ!"), ["chú", "mèo", "nhỏ"])


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
            self.client.post("/books/admin/catalog", json={"title": "Book", "author": None, "min_grade": 1, "max_grade": 2}, headers=headers),
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
            "title": "Book", "author": None, "min_grade": 1, "max_grade": 2, "role": "admin",
            "createdby": str(ACTOR),
        })
        self.assertEqual(response.status_code, 403)
        self.db.add.assert_not_called()
        self.db.commit.assert_not_awaited()


if __name__ == "__main__":
    unittest.main()
