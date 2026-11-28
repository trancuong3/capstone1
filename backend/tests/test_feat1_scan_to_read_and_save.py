"""Tests for Feature #1: Instant Scan-to-ReadAlong & 1-Tap Save to Sách của tôi (`POST /books/my-books/from-scan`).

Covers:
- Create new PARENT_PRIVATE book from scanned image + OCR text (page 1, verified revision + aligned words, reader_href)
- Auto-derived book title from first line when title is omitted
- Append page to an existing PARENT_PRIVATE book owned by the same parent (page_number increments cleanly)
- Reject cross-parent target_book_id (403/404) and non-parent/unauthenticated callers without leaking storage objects
- Reject empty payload, blank/whitespace ocr_text, invalid mode/grade, empty 0-byte file, non-image MIME/PDF, and corrupt bytes
- Enforce `Cache-Control: private, no-store` headers on responses
"""
from __future__ import annotations

import io
import json
import os
import sys
import unittest
from pathlib import Path
from typing import Any
from unittest.mock import patch
from uuid import UUID, uuid4

from fastapi import FastAPI
from fastapi.testclient import TestClient
from PIL import Image

BACKEND_ROOT = Path(__file__).resolve().parents[1]
if str(BACKEND_ROOT) not in sys.path:
    sys.path.insert(0, str(BACKEND_ROOT))

os.environ.setdefault("APP_ENVIRONMENT", "test")
os.environ.setdefault("DATABASE_URL", "postgresql+asyncpg://test:test@127.0.0.1:5432/test")
os.environ.setdefault("SUPABASE_URL", "https://example.supabase.co")
os.environ.setdefault("SUPABASE_KEY", "test-key")

from app.api.deps import get_current_parent_id, get_db
from app.api.routes.parent_private_book import router as parent_private_book_router
from app.policies.book_access import VISIBILITY_PARENT_PRIVATE

PARENT_A = UUID("11111111-1111-4111-8111-111111111111")
PARENT_B = UUID("22222222-2222-4222-8222-222222222222")
ADMIN_USER = UUID("33333333-3333-4333-8333-333333333333")


def _make_png_bytes(width: int = 360, height: int = 240, color=(248, 246, 240)) -> bytes:
    buf = io.BytesIO()
    Image.new("RGB", (width, height), color).save(buf, format="PNG")
    return buf.getvalue()


class _FakeSession:
    async def rollback(self) -> None:
        return None

    async def commit(self) -> None:
        return None

    async def refresh(self, _instance: Any) -> None:
        return None


class _InMemoryPrivateBookRepo:
    """Stateful repository double backing `ParentPrivateBookService` across requests."""

    def __init__(self) -> None:
        self.roles: dict[UUID, str] = {
            PARENT_A: "parent",
            PARENT_B: "parent",
            ADMIN_USER: "admin",
        }
        self.books: dict[UUID, Any] = {}
        self.pages: dict[UUID, Any] = {}
        self.revisions: dict[UUID, Any] = {}
        self.words_by_revision: dict[UUID, list[Any]] = {}
        self.submissions: list[Any] = []
        self.audit_logs: list[dict[str, Any]] = []

    async def role(self, actor_id: UUID) -> str | None:
        return self.roles.get(actor_id)

    async def create_private_book(self, book: Any) -> Any:
        if getattr(book, "Id", None) is None:
            book.Id = uuid4()
        self.books[book.Id] = book
        return book

    async def get_owned_private_book(
        self, book_id: UUID, owner_parent_id: UUID, *, lock: bool = False
    ) -> Any | None:
        _ = lock
        book = self.books.get(book_id)
        if book is None:
            return None
        if (
            book.VisibilityScope != VISIBILITY_PARENT_PRIVATE
            or book.OwnerParentId != owner_parent_id
            or book.LifecycleStatus != "ACTIVE"
        ):
            return None
        return book

    async def max_page_number(self, book_id: UUID) -> int:
        nums = [
            int(p.PageNumber)
            for p in self.pages.values()
            if p.BookId == book_id and p.LifecycleStatus in ("ACTIVE", "PROCESSING")
        ]
        return max(nums, default=0)

    async def create_committed_page(
        self, *, page: Any, revision: Any, words: list[Any]
    ) -> tuple[Any, Any]:
        if getattr(page, "Id", None) is None:
            page.Id = uuid4()
        if getattr(revision, "Id", None) is None:
            revision.Id = uuid4()
        revision.PageId = page.Id
        for w in words:
            if getattr(w, "Id", None) is None:
                w.Id = uuid4()
            w.PageRevisionId = revision.Id
        page.CurrentVerifiedRevisionId = revision.Id
        self.pages[page.Id] = page
        self.revisions[revision.Id] = revision
        self.words_by_revision[revision.Id] = list(words)
        return page, revision

    async def add_submissions(self, rows: list[Any]) -> None:
        self.submissions.extend(rows)

    async def add_audit_log(
        self,
        *,
        actor_id: UUID | None,
        action: str,
        resource_type: str,
        resource_id: UUID,
        metadata: dict[str, Any],
    ) -> None:
        self.audit_logs.append(
            {
                "actor_id": actor_id,
                "action": action,
                "resource_type": resource_type,
                "resource_id": resource_id,
                "metadata": metadata,
            }
        )

    async def commit(self) -> None:
        return None

    async def rollback(self) -> None:
        return None


def _build_test_harness(initial_actor: UUID | None = PARENT_A):
    state = {"actor_id": initial_actor}
    repo = _InMemoryPrivateBookRepo()
    storage_objects: dict[str, tuple[bytes, str, str | None]] = {}

    def _fake_upload(
        path: str,
        content: bytes,
        content_type: str,
        *,
        bucket_name: str | None = None,
        upsert: bool = False,
    ) -> str:
        _ = upsert
        storage_objects[path] = (content, content_type, bucket_name)
        return path

    def _fake_delete(path: str, *, bucket_name: str | None = None) -> None:
        _ = bucket_name
        storage_objects.pop(path, None)

    test_app = FastAPI()
    test_app.include_router(parent_private_book_router, prefix="/books")

    async def _override_db():
        yield _FakeSession()

    def _override_actor() -> UUID:
        actor = state["actor_id"]
        if actor is None:
            from fastapi import HTTPException

            raise HTTPException(status_code=401, detail="Authentication required")
        return actor

    test_app.dependency_overrides[get_db] = _override_db
    test_app.dependency_overrides[get_current_parent_id] = _override_actor
    return test_app, state, repo, storage_objects, _fake_upload, _fake_delete


def _assert_private_no_store_headers(response) -> None:
    cache_control = response.headers.get("cache-control", "")
    assert "private" in cache_control
    assert "no-store" in cache_control
    assert response.headers.get("pragma") == "no-cache"
    assert response.headers.get("vary") == "Authorization"


def test_create_new_private_book_from_scan_persists_private_book_words_and_no_store():
    test_app, _state, repo, storage_objects, fake_upload, fake_delete = _build_test_harness(PARENT_A)
    ocr_words = [
        {"word_index": 0, "line_index": 0, "text": "Chú", "bbox": [0.1, 0.12, 0.12, 0.05], "ocr_confidence": 0.97},
        {"word_index": 1, "line_index": 0, "text": "mèo", "bbox": [0.24, 0.12, 0.12, 0.05], "ocr_confidence": 0.95},
    ]

    with (
        patch("app.services.parent_private_book_service.ParentPrivateBookRepository", return_value=repo),
        patch("app.services.parent_private_book_service.upload_object", side_effect=fake_upload),
        patch("app.services.parent_private_book_service.delete_object", side_effect=fake_delete),
        TestClient(test_app) as client,
    ):
        res = client.post(
            "/books/my-books/from-scan",
            files={"image": ("trang-1.png", _make_png_bytes(), "image/png")},
            data={
                "ocr_text": "Chú mèo nhỏ ngồi bên cửa sổ.\nTrời mùa thu trong xanh.",
                "mode": "create_book",
                "title": "Truyện Chú Mèo Nhỏ",
                "grade_level": "2",
                "words_json": json.dumps(ocr_words, ensure_ascii=False),
            },
        )

    assert res.status_code == 201, res.text
    _assert_private_no_store_headers(res)

    body = res.json()
    book_id = UUID(body["book_id"])
    page_id = UUID(body["page_id"])
    assert body["page_number"] == 1
    assert body["visibility_scope"] == "PARENT_PRIVATE"
    assert body["title"] == "Truyện Chú Mèo Nhỏ"
    assert body["reader_href"] == f"/books/{book_id}?pageId={page_id}"

    # Strictly PARENT_PRIVATE and owned by PARENT_A
    saved_book = repo.books[book_id]
    assert saved_book.VisibilityScope == "PARENT_PRIVATE"
    assert saved_book.OwnerParentId == PARENT_A
    assert saved_book.CreatedBy == PARENT_A
    assert saved_book.MinGrade == 2
    assert saved_book.MaxGrade == 2
    assert saved_book.ModerationStatus == "ACTIVE"
    assert saved_book.LifecycleStatus == "ACTIVE"

    # Ready-to-read page, VERIFIED revision, and tokenized Vietnamese words
    saved_page = repo.pages[page_id]
    assert saved_page.PageNumber == 1
    assert saved_page.LifecycleStatus == "ACTIVE"
    assert saved_page.ImagePath.startswith(f"private-books/{PARENT_A}/{book_id}/pages/{page_id}/")
    assert saved_page.ImagePath in storage_objects

    saved_rev = repo.revisions[saved_page.CurrentVerifiedRevisionId]
    assert saved_rev.VerificationStatus == "VERIFIED"
    assert saved_rev.VerifiedBy == PARENT_A
    saved_words = repo.words_by_revision[saved_rev.Id]
    assert [w.Text for w in saved_words[:4]] == ["Chú", "mèo", "nhỏ", "ngồi"]
    assert len(saved_words) == 12
    assert all(len(w.BoundingBox) == 4 for w in saved_words)


def test_append_page_to_existing_private_book_increments_page_number():
    test_app, _state, repo, storage_objects, fake_upload, fake_delete = _build_test_harness(PARENT_A)

    with (
        patch("app.services.parent_private_book_service.ParentPrivateBookRepository", return_value=repo),
        patch("app.services.parent_private_book_service.upload_object", side_effect=fake_upload),
        patch("app.services.parent_private_book_service.delete_object", side_effect=fake_delete),
        TestClient(test_app) as client,
    ):
        # Create book with page 1 (auto-title from first line when title omitted)
        first_res = client.post(
            "/books/my-books/from-scan",
            files={"image": ("p1.png", _make_png_bytes(), "image/png")},
            data={
                "ocr_text": "Bài thơ hạt gạo làng ta\nCó vị phù sa của sông Kinh Thầy.",
                "mode": "create_book",
            },
        )
        assert first_res.status_code == 201, first_res.text
        first_body = first_res.json()
        book_id = first_body["book_id"]
        assert first_body["title"] == "Bài thơ hạt gạo làng ta"
        assert first_body["page_number"] == 1

        # Append page 2 to the same PARENT_PRIVATE book
        second_res = client.post(
            "/books/my-books/from-scan",
            files={"image": ("p2.png", _make_png_bytes(), "image/png")},
            data={
                "ocr_text": "Hạt gạo làng ta có hương sen thơm trong hồ nước đầy.",
                "mode": "append_page",
                "target_book_id": book_id,
            },
        )

    assert second_res.status_code == 201, second_res.text
    _assert_private_no_store_headers(second_res)
    second_body = second_res.json()
    assert second_body["book_id"] == book_id
    assert second_body["page_number"] == 2
    assert second_body["visibility_scope"] == "PARENT_PRIVATE"
    assert second_body["reader_href"] == f"/books/{book_id}?pageId={second_body['page_id']}"
    assert len(storage_objects) == 2


def test_rejects_cross_parent_target_book_and_non_parent_or_unauthenticated():
    test_app, state, repo, storage_objects, fake_upload, fake_delete = _build_test_harness(PARENT_A)

    with (
        patch("app.services.parent_private_book_service.ParentPrivateBookRepository", return_value=repo),
        patch("app.services.parent_private_book_service.upload_object", side_effect=fake_upload),
        patch("app.services.parent_private_book_service.delete_object", side_effect=fake_delete),
        TestClient(test_app) as client,
    ):
        # Parent A creates a private book
        create_res = client.post(
            "/books/my-books/from-scan",
            files={"image": ("a1.png", _make_png_bytes(), "image/png")},
            data={
                "ocr_text": "Sách riêng của gia đình A.",
                "mode": "create_book",
                "title": "Sách Nhà A",
            },
        )
        assert create_res.status_code == 201
        book_a_id = create_res.json()["book_id"]
        assert len(storage_objects) == 1

        # Parent B attempts to append a page to Parent A's private book -> 403/404
        state["actor_id"] = PARENT_B
        cross_res = client.post(
            "/books/my-books/from-scan",
            files={"image": ("b-intrude.png", _make_png_bytes(), "image/png")},
            data={
                "ocr_text": "Trang không hợp lệ từ tài khoản khác.",
                "mode": "append_page",
                "target_book_id": book_a_id,
            },
        )
        assert cross_res.status_code in (403, 404), cross_res.text
        _assert_private_no_store_headers(cross_res)
        # Zero pages leaked into Parent A's book and zero extra storage objects uploaded
        assert len(repo.pages) == 1
        assert len(storage_objects) == 1

        # Admin / non-parent role -> 403 Forbidden
        state["actor_id"] = ADMIN_USER
        admin_res = client.post(
            "/books/my-books/from-scan",
            files={"image": ("admin.png", _make_png_bytes(), "image/png")},
            data={"ocr_text": "Nội dung thử nghiệm.", "mode": "create_book"},
        )
        assert admin_res.status_code == 403
        _assert_private_no_store_headers(admin_res)

        # Unauthenticated -> 401
        state["actor_id"] = None
        unauth_res = client.post(
            "/books/my-books/from-scan",
            files={"image": ("anon.png", _make_png_bytes(), "image/png")},
            data={"ocr_text": "Nội dung thử nghiệm.", "mode": "create_book"},
        )
        assert unauth_res.status_code == 401


def test_rejects_empty_payload_blank_text_and_invalid_image_files():
    test_app, _state, repo, storage_objects, fake_upload, fake_delete = _build_test_harness(PARENT_A)

    with (
        patch("app.services.parent_private_book_service.ParentPrivateBookRepository", return_value=repo),
        patch("app.services.parent_private_book_service.upload_object", side_effect=fake_upload),
        patch("app.services.parent_private_book_service.delete_object", side_effect=fake_delete),
        TestClient(test_app) as client,
    ):
        # 1. Empty payload -> 422
        empty_payload = client.post("/books/my-books/from-scan", data={})
        assert empty_payload.status_code == 422

        # 2. Whitespace-only ocr_text -> 422 + Cache-Control: private, no-store
        blank_text = client.post(
            "/books/my-books/from-scan",
            files={"image": ("page.png", _make_png_bytes(), "image/png")},
            data={"ocr_text": "   \n\t  ", "mode": "create_book"},
        )
        assert blank_text.status_code == 422
        _assert_private_no_store_headers(blank_text)

        # 3. Invalid mode -> 422
        bad_mode = client.post(
            "/books/my-books/from-scan",
            files={"image": ("page.png", _make_png_bytes(), "image/png")},
            data={"ocr_text": "Mèo con đi học.", "mode": "public_catalog"},
        )
        assert bad_mode.status_code == 422
        _assert_private_no_store_headers(bad_mode)

        # 4. Empty 0-byte image file -> 422
        zero_file = client.post(
            "/books/my-books/from-scan",
            files={"image": ("empty.png", b"", "image/png")},
            data={"ocr_text": "Mèo con đi học.", "mode": "create_book"},
        )
        assert zero_file.status_code == 422
        _assert_private_no_store_headers(zero_file)

        # 5. Non-image MIME / PDF file -> 422
        pdf_file = client.post(
            "/books/my-books/from-scan",
            files={"image": ("doc.pdf", b"%PDF-1.4 fake", "application/pdf")},
            data={"ocr_text": "Mèo con đi học.", "mode": "create_book"},
        )
        assert pdf_file.status_code == 422
        _assert_private_no_store_headers(pdf_file)

        # 6. Corrupted image bytes -> 415/422
        corrupt_img = client.post(
            "/books/my-books/from-scan",
            files={"image": ("broken.png", b"not-a-valid-png-stream", "image/png")},
            data={"ocr_text": "Mèo con đi học.", "mode": "create_book"},
        )
        assert corrupt_img.status_code in (415, 422)
        _assert_private_no_store_headers(corrupt_img)

    assert len(storage_objects) == 0
    assert len(repo.books) == 0


class Feat1ScanToReadAndSaveTestSuite(unittest.TestCase):
    """Unittest-compatible suite wrapper so both `pytest` and `python -m unittest` run all checks."""

    def test_01_create_new_private_book_from_scan(self) -> None:
        test_create_new_private_book_from_scan_persists_private_book_words_and_no_store()

    def test_02_append_page_to_existing_private_book(self) -> None:
        test_append_page_to_existing_private_book_increments_page_number()

    def test_03_rejects_cross_parent_and_unauthorized_roles(self) -> None:
        test_rejects_cross_parent_target_book_and_non_parent_or_unauthenticated()

    def test_04_rejects_empty_payload_blank_text_and_invalid_files(self) -> None:
        test_rejects_empty_payload_blank_text_and_invalid_image_files()


if __name__ == "__main__":
    unittest.main()

