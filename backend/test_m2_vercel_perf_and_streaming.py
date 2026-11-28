"""Comprehensive unit tests for Milestone M2 (F4, F5, F6, F7)."""
from __future__ import annotations

import os
import tempfile
import unittest
import uuid
from contextlib import ExitStack
from datetime import datetime, timezone
from io import BytesIO
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock, patch

os.environ.setdefault("DATABASE_URL", "postgresql+asyncpg://test:test@127.0.0.1:1/test")
os.environ.setdefault("APP_ENVIRONMENT", "test")
os.environ.setdefault("DATABASE_POOLER_MODE", "local")
os.environ.setdefault("DATABASE_SSL_REQUIRED", "false")
os.environ.setdefault("SUPABASE_URL", "https://proj.supabase.co")
os.environ.setdefault("SUPABASE_KEY", "isolated-test-key")

import pymupdf
from fastapi import HTTPException, UploadFile
from fastapi.testclient import TestClient
from fastapi import FastAPI
from PIL import Image

from app.api.deps import get_current_parent_id, get_db
from app.api.routes.book_assets import router as book_assets_router
from app.api.routes.profile import ChildProfileService
from app.policies import book_access
from app.repositories.reading_content_repository import ReadingContentRepository
from app.services import profile_service, storage_service
from app.services.admin_ocr_service import AdminOcrService
from app.services.book_cover_service import BookCoverService
from app.services.book_service import AdminCatalogService, CatalogService
from app.services.document_rasterizer_service import (
    iter_rasterized_document_pages,
    iter_rasterized_spooled_document,
    spool_bytes_document,
)
from app.services.global_tasks_service import _execute_batch_book_import_job
from app.services.parent_private_book_service import ParentPrivateBookService
from app.services.reading_content_service import ReadingContentService


def _make_pdf_bytes(num_pages: int) -> bytes:
    doc = pymupdf.open()
    for idx in range(num_pages):
        page = doc.new_page(width=400, height=550)
        page.insert_text((40, 80), f"Trang so {idx + 1}", fontsize=18)
    data = doc.tobytes()
    doc.close()
    return data


def _make_png_upload(name: str = "page.png") -> UploadFile:
    buf = BytesIO()
    Image.new("RGB", (200, 300), (245, 245, 245)).save(buf, format="PNG")
    buf.seek(0)
    return UploadFile(
        filename=name,
        file=buf,
        headers={"content-type": "image/png"},
    )


def _make_pdf_upload(name: str, num_pages: int) -> UploadFile:
    buf = BytesIO(_make_pdf_bytes(num_pages))
    buf.seek(0)
    return UploadFile(
        filename=name,
        file=buf,
        headers={"content-type": "application/pdf"},
    )


class TestM2CachedAsyncStorageSigning(unittest.IsolatedAsyncioTestCase):
    def setUp(self) -> None:
        storage_service.clear_signed_url_cache()

    def tearDown(self) -> None:
        storage_service.clear_signed_url_cache()

    async def test_create_cached_signed_image_urls_async_uses_httpx_batch_cache_and_invalidation(
        self,
    ) -> None:
        post_calls: list[tuple[str, dict, dict]] = []

        class _FakeResponse:
            def __init__(self, status_code: int, payload: object) -> None:
                self.status_code = status_code
                self._payload = payload

            def json(self) -> object:
                return self._payload

            def raise_for_status(self) -> None:
                if self.status_code >= 400:
                    raise RuntimeError(f"HTTP {self.status_code}")

        class _FakeAsyncClient:
            def __init__(self, *args, **kwargs) -> None:
                pass

            async def __aenter__(self):
                return self

            async def __aexit__(self, *args):
                return False

            async def post(self, url: str, *, json: dict, headers: dict):
                post_calls.append((url, json, headers))
                paths = json.get("paths", [])
                return _FakeResponse(
                    200,
                    [
                        {
                            "path": p,
                            "signedURL": f"/object/sign/book-pages/{p}?token=tok-{idx}",
                        }
                        for idx, p in enumerate(paths)
                    ],
                )

        with (
            patch.object(storage_service, "SUPABASE_URL", "https://proj.supabase.co"),
            patch.object(storage_service, "SUPABASE_ADMIN_KEY", "sb_secret_test_key"),
            patch.object(storage_service, "SUPABASE_STORAGE_BUCKET", "book-pages"),
            patch.object(storage_service.httpx, "AsyncClient", _FakeAsyncClient),
        ):
            first = await storage_service.create_cached_signed_image_urls_async(
                [
                    "books/b1/p1.png",
                    "https://legacy.example/pub.png",
                    "books/b1/p2.png",
                    "books/b1/p1.png",
                ],
                bucket_name="book-pages",
            )
            self.assertEqual(len(post_calls), 1)
            url, payload, headers = post_calls[0]
            self.assertEqual(url, "https://proj.supabase.co/storage/v1/object/sign/book-pages")
            self.assertEqual(payload, {"expiresIn": 3600, "paths": ["books/b1/p1.png", "books/b1/p2.png"]})
            self.assertEqual(headers["apikey"], "sb_secret_test_key")
            self.assertNotIn("Authorization", headers)
            self.assertEqual(
                first[0],
                "https://proj.supabase.co/storage/v1/object/sign/book-pages/books/b1/p1.png?token=tok-0",
            )
            self.assertEqual(first[1], "https://legacy.example/pub.png")
            self.assertEqual(first[0], first[3])

            # Second call hits cache with zero HTTP calls
            second = await storage_service.create_cached_signed_image_urls_async(
                ["books/b1/p1.png", "books/b1/p2.png"],
                bucket_name="book-pages",
            )
            self.assertEqual(len(post_calls), 1)
            self.assertEqual(second, [first[0], first[2]])

            # Invalidate p1 only -> p2 stays cached, only p1 is re-signed
            storage_service.invalidate_signed_url_cache(
                "books/b1/p1.png", bucket_name="book-pages"
            )
            third = await storage_service.create_cached_signed_image_urls_async(
                ["books/b1/p1.png", "books/b1/p2.png"],
                bucket_name="book-pages",
            )
            self.assertEqual(len(post_calls), 2)
            self.assertEqual(post_calls[1][1]["paths"], ["books/b1/p1.png"])
            self.assertEqual(third[1], first[2])

    async def test_create_cached_signed_image_urls_async_single_fallback_and_validation(
        self,
    ) -> None:
        calls: list[str] = []

        class _FakeResponse:
            def __init__(self, status_code: int, payload: object) -> None:
                self.status_code = status_code
                self._payload = payload

            def json(self) -> object:
                return self._payload

            def raise_for_status(self) -> None:
                if self.status_code >= 400:
                    raise RuntimeError("http error")

        class _FakeAsyncClient:
            def __init__(self, *args, **kwargs) -> None:
                pass

            async def __aenter__(self):
                return self

            async def __aexit__(self, *args):
                return False

            async def post(self, url: str, *, json: dict, headers: dict):
                calls.append(url)
                if url.endswith("/sign/book-pages"):
                    return _FakeResponse(
                        200,
                        [
                            {
                                "path": "books/b1/p1.png",
                                "signedURL": "/storage/v1/object/sign/book-pages/books/b1/p1.png?token=ok1",
                            },
                            {"path": "books/b1/p2.png", "error": "partial"},
                        ],
                    )
                return _FakeResponse(
                    200,
                    {"signedURL": "/object/sign/book-pages/books/b1/p2.png?token=ok2"},
                )

        with (
            patch.object(storage_service, "SUPABASE_URL", "https://proj.supabase.co"),
            patch.object(storage_service, "SUPABASE_ADMIN_KEY", "srv-key"),
            patch.object(storage_service, "SUPABASE_STORAGE_BUCKET", "book-pages"),
            patch.object(storage_service.httpx, "AsyncClient", _FakeAsyncClient),
        ):
            with self.assertRaises(HTTPException) as bad_traversal:
                await storage_service.create_cached_signed_image_urls_async(
                    ["../secret.png"], bucket_name="book-pages"
                )
            self.assertEqual(bad_traversal.exception.status_code, 503)

            with self.assertRaises(HTTPException) as bad_cred:
                await storage_service.create_cached_signed_image_urls_async(
                    ["https://user:pass@evil.example/a.png"], bucket_name="book-pages"
                )
            self.assertEqual(bad_cred.exception.status_code, 503)
            self.assertEqual(calls, [])

            urls = await storage_service.create_cached_signed_image_urls_async(
                ["books/b1/p1.png", "books/b1/p2.png"],
                bucket_name="book-pages",
            )
            self.assertEqual(
                urls,
                [
                    "https://proj.supabase.co/storage/v1/object/sign/book-pages/books/b1/p1.png?token=ok1",
                    "https://proj.supabase.co/storage/v1/object/sign/book-pages/books/b1/p2.png?token=ok2",
                ],
            )
            self.assertEqual(len(calls), 2)
            self.assertTrue(calls[1].endswith("/sign/book-pages/books/b1/p2.png"))

    async def test_f4_callers_hit_cache_and_private_ttl_stays_bounded(self) -> None:
        sign_mock = MagicMock(
            side_effect=lambda paths, **kwargs: [
                f"https://proj.supabase.co/storage/v1/object/sign/b/{p}?t=1"
                for p in paths
            ]
        )
        with (
            patch.object(storage_service, "create_signed_image_urls", sign_mock),
            patch.object(storage_service, "SUPABASE_STORAGE_BUCKET", "book-pages"),
        ):
            # 1) AdminCatalogService.image caches on 2nd call
            page_id = uuid.uuid4()
            rev_id = uuid.uuid4()
            admin_repo = MagicMock()
            admin_repo.db = MagicMock()
            admin_repo.db.rollback = AsyncMock()
            admin_repo.page = AsyncMock(
                return_value=SimpleNamespace(
                    Id=page_id,
                    PageNumber=1,
                    LifecycleStatus="ACTIVE",
                    ImagePath="books/cat/p1.png",
                    Width=800,
                    Height=1000,
                    CurrentVerifiedRevisionId=rev_id,
                )
            )
            admin_repo.revisions = AsyncMock(
                return_value=[
                    SimpleNamespace(
                        Id=rev_id,
                        ProcessingMeta={},
                    )
                ]
            )
            admin_cat_svc = AdminCatalogService(repository=admin_repo)
            img1 = await admin_cat_svc.image(page_id)
            img2 = await admin_cat_svc.image(page_id)
            self.assertEqual(img1.preview_url, img2.preview_url)
            self.assertEqual(sign_mock.call_count, 1)

            # 2) AdminOcrService.image_url caches on 2nd call
            ocr_db = MagicMock()
            ocr_db.rollback = AsyncMock()
            ocr_svc = AdminOcrService(ocr_db)
            ocr_page = SimpleNamespace(ImagePath="books/ocr/p2.png")
            u1 = await ocr_svc.image_url(ocr_page)
            u2 = await ocr_svc.image_url(ocr_page)
            self.assertEqual(u1, u2)
            self.assertEqual(sign_mock.call_count, 2)

            # 3) ReadingContentService._build_page_dto caches public page URL
            rc_repo = MagicMock()
            rc_repo.db = MagicMock()
            rc_repo.db.rollback = AsyncMock()
            rc_rev_id = uuid.uuid4()
            rc_repo.revision_words = AsyncMock(
                return_value=[
                    SimpleNamespace(
                        Id=uuid.uuid4(),
                        WordIndex=0,
                        Text="Xin",
                        BoundingBox=[0.1, 0.1, 0.2, 0.05],
                        LineIndex=0,
                    )
                ]
            )
            rc_svc = ReadingContentService(rc_repo)
            cat_book_id = uuid.uuid4()
            cat_page = SimpleNamespace(
                Id=uuid.uuid4(),
                BookId=cat_book_id,
                PageNumber=1,
                ImagePath="books/read/p3.png",
                CurrentVerifiedRevisionId=rc_rev_id,
                Width=600,
                Height=800,
            )
            cat_rev = SimpleNamespace(
                Id=rc_rev_id,
                VerifiedText="Xin chao",
                VerificationStatus="VERIFIED",
                ProcessingMeta={},
            )
            dto1 = await rc_svc._build_page_dto(
                cat_page, cat_rev, book_is_private=False, owner_parent_id=None
            )
            dto2 = await rc_svc._build_page_dto(
                cat_page, cat_rev, book_is_private=False, owner_parent_id=None
            )
            self.assertEqual(dto1.image_url, dto2.image_url)
            self.assertEqual(sign_mock.call_count, 3)

            # 4) ChildProfileService._response(..., use_prebuilt_url=False) caches avatar URL
            child_id = uuid.uuid4()
            child = SimpleNamespace(
                Id=child_id,
                ParentId=uuid.uuid4(),
                Alias="Be Na",
                Grade=1,
                Settings={},
                CreatedAt=datetime.now(timezone.utc),
                AvatarPath=f"children/{child_id}/avatar/a.webp",
            )
            c1 = ChildProfileService._response(child, use_prebuilt_url=False)
            c2 = ChildProfileService._response(child, use_prebuilt_url=False)
            self.assertEqual(c1["avatar_url"], c2["avatar_url"])
            self.assertEqual(sign_mock.call_count, 4)

            # 5) Private book URLs enforce TTL=300, bounded cache TTL, and owner scope
            owner_id = uuid.uuid4()
            other_id = uuid.uuid4()
            priv_book_id = uuid.uuid4()
            priv_page_id = uuid.uuid4()
            priv_path = f"private-books/{owner_id}/{priv_book_id}/pages/{priv_page_id}/rev-1.png"
            with (
                patch.object(book_access, "is_local_storage_enabled", return_value=False),
                patch.dict(os.environ, {"VIREAD_PROXYLESS_PRIVATE_URLS": "true"}),
            ):
                p_urls = await book_access.private_page_image_urls_async(
                    priv_book_id,
                    [(priv_page_id, None, priv_path)],
                    owner_id=owner_id,
                )
                p_urls_2 = await book_access.private_page_image_urls_async(
                    priv_book_id,
                    [(priv_page_id, None, priv_path)],
                    owner_id=owner_id,
                )
                self.assertEqual(p_urls, p_urls_2)
                self.assertEqual(sign_mock.call_count, 5)
                self.assertEqual(
                    sign_mock.call_args.kwargs["ttl_seconds"],
                    book_access.PRIVATE_SIGNED_URL_TTL_SECONDS,
                )
                self.assertEqual(
                    sign_mock.call_args.kwargs["bucket_name"],
                    "viread-private-books",
                )
                # Foreign owner MUST fall back to authenticated proxy URL, never signed URL
                foreign_urls = await book_access.private_page_image_urls_async(
                    priv_book_id,
                    [(priv_page_id, None, priv_path)],
                    owner_id=other_id,
                )
                self.assertIn(f"/books/my-books/{priv_book_id}/pages/{priv_page_id}/image", foreign_urls[0])
                self.assertEqual(sign_mock.call_count, 5)


class TestM2ReadingPracticeStateBatching(unittest.IsolatedAsyncioTestCase):
    async def test_get_practice_state_batches_queries_with_real_repository(self) -> None:
        mock_db = MagicMock()
        repo = ReadingContentRepository(mock_db)
        service = ReadingContentService(repo)

        actor_id = uuid.uuid4()
        session_id = uuid.uuid4()
        book_id = uuid.uuid4()
        p1, p2, p3 = uuid.uuid4(), uuid.uuid4(), uuid.uuid4()
        r1, r2, r3 = uuid.uuid4(), uuid.uuid4(), uuid.uuid4()
        w1, w2, w3 = uuid.uuid4(), uuid.uuid4(), uuid.uuid4()

        session_obj = SimpleNamespace(Id=session_id, ChildId=uuid.uuid4(), BookId=book_id)
        book_obj = SimpleNamespace(Id=book_id)
        reports = [
            SimpleNamespace(
                SessionId=session_id,
                PageId=p3,
                PageRevisionId=r3,
                Transcript="page 3",
                Summary={
                    "assessment_version": 1,
                    "initial_assessment": [
                        {"word_id": str(w3), "word_index": 0, "text": "meo", "status": "MISPRONUNCIATION"},
                    ],
                },
            ),
            SimpleNamespace(
                SessionId=session_id,
                PageId=p2,
                PageRevisionId=r2,
                Transcript="page 2",
                Summary={
                    "assessment_version": 1,
                    "initial_assessment": [
                        {"word_id": str(w2), "word_index": 0, "text": "cho", "status": "OMISSION"},
                    ],
                },
            ),
            SimpleNamespace(
                SessionId=session_id,
                PageId=p1,
                PageRevisionId=r1,
                Transcript="page 1",
                Summary={
                    "assessment_version": 1,
                    "initial_assessment": [
                        {"word_id": str(w1), "word_index": 0, "text": "ga", "status": "CORRECT"},
                    ],
                },
            ),
        ]
        events = [
            SimpleNamespace(
                SessionId=session_id,
                PageId=p2,
                PageRevisionId=r2,
                WordId=w2,
                Type="WORD_RETRY",
                Status="CONFIRMED",
                Metadata={"retry_attempt": 1},
            ),
            SimpleNamespace(
                SessionId=session_id,
                PageId=p3,
                PageRevisionId=r3,
                WordId=w3,
                Type="WORD_RETRY",
                Status="FAILED",
                Metadata={"retry_attempt": 1},
            ),
        ]
        pages_map = {
            p1: SimpleNamespace(Id=p1, BookId=book_id, PageNumber=1),
            p2: SimpleNamespace(Id=p2, BookId=book_id, PageNumber=2),
            p3: SimpleNamespace(Id=p3, BookId=book_id, PageNumber=3),
        }
        revisions_map = {
            (p1, r1): SimpleNamespace(Id=r1, PageId=p1),
            (p2, r2): SimpleNamespace(Id=r2, PageId=p2),
            (p3, r3): SimpleNamespace(Id=r3, PageId=p3),
        }
        word_ids_map = {r1: {w1}, r2: {w2}, r3: {w3}}

        with (
            patch.object(repo, "profile_role", AsyncMock(return_value="parent")),
            patch.object(
                repo,
                "session_with_ownership_and_book",
                AsyncMock(return_value=(session_obj, book_obj, True)),
            ) as m_ctx,
            patch.object(repo, "comparison_reports", AsyncMock(return_value=reports)),
            patch.object(repo, "events_for_session", AsyncMock(return_value=events)),
            patch.object(repo, "session_page_rows", AsyncMock(return_value=[])),
            patch.object(repo, "pages_by_ids", AsyncMock(return_value=pages_map)) as m_pages,
            patch.object(repo, "revision_snapshots", AsyncMock(return_value=revisions_map)) as m_revs,
            patch.object(
                repo,
                "revision_word_ids_by_revisions",
                AsyncMock(return_value=word_ids_map),
            ) as m_words,
            patch.object(repo, "page_by_id", AsyncMock(side_effect=AssertionError("N+1 page_by_id"))),
            patch.object(
                repo,
                "revision_snapshot",
                AsyncMock(side_effect=AssertionError("N+1 revision_snapshot")),
            ),
            patch.object(
                repo,
                "revision_words",
                AsyncMock(side_effect=AssertionError("N+1 revision_words")),
            ),
        ):
            state = await service.get_practice_state(session_id, actor_id)

        m_ctx.assert_awaited_once_with(session_id, actor_id)
        m_pages.assert_awaited_once()
        m_revs.assert_awaited_once()
        m_words.assert_awaited_once()
        self.assertEqual([p.page_number for p in state.pages], [1, 2, 3])
        by_word = {w.word_id: w for w in state.words}
        self.assertEqual(by_word[w2].resolution_status, "SELF_CORRECTED")
        self.assertEqual(by_word[w3].resolution_status, "RETRYING")
        self.assertEqual(by_word[w3].incorrect_retry_count, 1)

    async def test_get_practice_state_legacy_skips_batch_and_preserves_501_errors(self) -> None:
        mock_db = MagicMock()
        repo = ReadingContentRepository(mock_db)
        service = ReadingContentService(repo)
        actor_id = uuid.uuid4()
        session_id = uuid.uuid4()
        book_id = uuid.uuid4()
        page_id = uuid.uuid4()
        rev_id = uuid.uuid4()
        word_id = uuid.uuid4()
        session_obj = SimpleNamespace(Id=session_id, ChildId=uuid.uuid4(), BookId=book_id)

        # Legacy-only reports -> zero batch queries
        with (
            patch.object(repo, "profile_role", AsyncMock(return_value="parent")),
            patch.object(
                repo,
                "session_with_ownership_and_book",
                AsyncMock(return_value=(session_obj, SimpleNamespace(Id=book_id), True)),
            ),
            patch.object(
                repo,
                "comparison_reports",
                AsyncMock(
                    return_value=[
                        SimpleNamespace(
                            SessionId=session_id,
                            PageId=page_id,
                            PageRevisionId=rev_id,
                            Transcript="legacy",
                            Summary={},
                        )
                    ]
                ),
            ),
            patch.object(repo, "events_for_session", AsyncMock(return_value=[])),
            patch.object(repo, "session_page_rows", AsyncMock(return_value=[])),
            patch.object(repo, "pages_by_ids", AsyncMock()) as m_pages,
            patch.object(repo, "revision_snapshots", AsyncMock()) as m_revs,
            patch.object(repo, "revision_word_ids_by_revisions", AsyncMock()) as m_words,
        ):
            state = await service.get_practice_state(session_id, actor_id)
        self.assertTrue(state.legacy_evidence_present)
        m_pages.assert_not_awaited()
        m_revs.assert_not_awaited()
        m_words.assert_not_awaited()

        # Cross-book page -> 501 identity error
        v1_report = SimpleNamespace(
            SessionId=session_id,
            PageId=page_id,
            PageRevisionId=rev_id,
            Transcript="t",
            Summary={
                "assessment_version": 1,
                "initial_assessment": [
                    {"word_id": str(word_id), "expected_text": "meo", "status": "MISPRONUNCIATION"}
                ],
            },
        )
        with (
            patch.object(repo, "profile_role", AsyncMock(return_value="parent")),
            patch.object(
                repo,
                "session_with_ownership_and_book",
                AsyncMock(return_value=(session_obj, SimpleNamespace(Id=book_id), True)),
            ),
            patch.object(repo, "comparison_reports", AsyncMock(return_value=[v1_report])),
            patch.object(repo, "events_for_session", AsyncMock(return_value=[])),
            patch.object(repo, "session_page_rows", AsyncMock(return_value=[])),
            patch.object(
                repo,
                "pages_by_ids",
                AsyncMock(return_value={page_id: SimpleNamespace(Id=page_id, BookId=uuid.uuid4(), PageNumber=1)}),
            ),
            patch.object(
                repo,
                "revision_snapshots",
                AsyncMock(return_value={(page_id, rev_id): SimpleNamespace(Id=rev_id, PageId=page_id)}),
            ),
            patch.object(
                repo,
                "revision_word_ids_by_revisions",
                AsyncMock(return_value={rev_id: {word_id}}),
            ),
        ):
            with self.assertRaises(HTTPException) as err:
                await service.get_practice_state(session_id, actor_id)
            self.assertEqual(err.exception.status_code, 501)

    async def test_get_practice_state_dedupes_duplicate_reports_keeps_latest_and_handles_mixed_legacy_and_retries(
        self,
    ) -> None:
        mock_db = MagicMock()
        repo = ReadingContentRepository(mock_db)
        service = ReadingContentService(repo)
        actor_id = uuid.uuid4()
        session_id = uuid.uuid4()
        book_id = uuid.uuid4()
        p1, p2, p_legacy = uuid.uuid4(), uuid.uuid4(), uuid.uuid4()
        r1, r2, r_legacy = uuid.uuid4(), uuid.uuid4(), uuid.uuid4()
        w1, w2 = uuid.uuid4(), uuid.uuid4()

        session_obj = SimpleNamespace(Id=session_id, ChildId=uuid.uuid4(), BookId=book_id)
        book_obj = SimpleNamespace(Id=book_id)
        # Reports ordered oldest -> newest; reversed(reports) keeps latest (p1, r1) and marks legacy=True
        reports = [
            SimpleNamespace(
                SessionId=session_id,
                PageId=p_legacy,
                PageRevisionId=r_legacy,
                Transcript="legacy report",
                Summary={"legacy": True},
            ),
            SimpleNamespace(
                SessionId=session_id,
                PageId=p1,
                PageRevisionId=r1,
                Transcript="older page 1",
                Summary={
                    "assessment_version": 1,
                    "initial_assessment": [
                        {"word_id": str(w1), "word_index": 0, "text": "meo", "status": "CORRECT"},
                    ],
                },
            ),
            SimpleNamespace(
                SessionId=session_id,
                PageId=p1,
                PageRevisionId=r1,
                Transcript="latest page 1",
                Summary={
                    "assessment_version": 1,
                    "initial_assessment": [
                        {"word_id": str(w1), "word_index": 0, "text": "meo", "status": "MISPRONUNCIATION"},
                    ],
                },
            ),
            SimpleNamespace(
                SessionId=session_id,
                PageId=p2,
                PageRevisionId=r2,
                Transcript="page 2",
                Summary={
                    "assessment_version": 1,
                    "initial_assessment": [
                        {"word_id": str(w2), "word_index": 0, "text": "cho", "status": "OMISSION"},
                    ],
                },
            ),
        ]
        events = [
            SimpleNamespace(
                SessionId=session_id,
                PageId=p1,
                PageRevisionId=r1,
                WordId=w1,
                Type="WORD_RETRY",
                Status="FAILED",
                Metadata={"retry_attempt": 1},
            ),
            SimpleNamespace(
                SessionId=session_id,
                PageId=p1,
                PageRevisionId=r1,
                WordId=w1,
                Type="WORD_RETRY",
                Status="CONFIRMED",
                Metadata={"retry_attempt": 2},
            ),
            SimpleNamespace(
                SessionId=session_id,
                PageId=p2,
                PageRevisionId=r2,
                WordId=w2,
                Type="WORD_RETRY",
                Status="UNCERTAIN",
                Metadata={"retry_attempt": 1, "skip_reason": "TECHNICAL_OR_MANUAL"},
            ),
        ]
        selected_rows = [
            SimpleNamespace(PageId=p1, PageRevisionId=r1),
            SimpleNamespace(PageId=p2, PageRevisionId=r2),
            SimpleNamespace(PageId=p_legacy, PageRevisionId=r_legacy),
        ]
        pages_map = {
            p1: SimpleNamespace(Id=p1, BookId=book_id, PageNumber=1),
            p2: SimpleNamespace(Id=p2, BookId=book_id, PageNumber=2),
        }
        revisions_map = {
            (p1, r1): SimpleNamespace(Id=r1, PageId=p1),
            (p2, r2): SimpleNamespace(Id=r2, PageId=p2),
        }
        word_ids_map = {r1: {w1}, r2: {w2}}

        with (
            patch.object(repo, "profile_role", AsyncMock(return_value="parent")),
            patch.object(
                repo,
                "session_with_ownership_and_book",
                AsyncMock(return_value=(session_obj, book_obj, True)),
            ),
            patch.object(repo, "comparison_reports", AsyncMock(return_value=reports)),
            patch.object(repo, "events_for_session", AsyncMock(return_value=events)),
            patch.object(repo, "session_page_rows", AsyncMock(return_value=selected_rows)),
            patch.object(repo, "pages_by_ids", AsyncMock(return_value=pages_map)) as m_pages,
            patch.object(repo, "revision_snapshots", AsyncMock(return_value=revisions_map)) as m_revs,
            patch.object(
                repo,
                "revision_word_ids_by_revisions",
                AsyncMock(return_value=word_ids_map),
            ) as m_words,
            patch.object(repo, "page_by_id", AsyncMock(side_effect=AssertionError("N+1 page_by_id"))),
            patch.object(
                repo,
                "revision_snapshot",
                AsyncMock(side_effect=AssertionError("N+1 revision_snapshot")),
            ),
            patch.object(
                repo,
                "revision_words",
                AsyncMock(side_effect=AssertionError("N+1 revision_words")),
            ),
        ):
            state = await service.get_practice_state(session_id, actor_id)

        self.assertTrue(state.legacy_evidence_present)
        self.assertEqual(len(state.pages), 2)
        by_page = {p.page_id: p for p in state.pages}
        self.assertEqual(by_page[p1].transcript, "latest page 1")
        self.assertEqual(by_page[p1].initial_assessment[0].status, "MISPRONUNCIATION")
        by_word = {w.word_id: w for w in state.words}
        self.assertEqual(by_word[w1].resolution_status, "SELF_CORRECTED")
        self.assertEqual(by_word[w1].retry_attempt_count, 2)
        self.assertEqual(by_word[w1].incorrect_retry_count, 1)
        self.assertEqual(by_word[w2].resolution_status, "UNRESOLVED")
        m_pages.assert_awaited_once()
        m_revs.assert_awaited_once()
        m_words.assert_awaited_once()

    async def test_repository_batch_methods_compile_cleanly(self) -> None:
        mock_db = MagicMock()
        scalar_result = MagicMock()
        scalar_result.all.return_value = []
        exec_result = MagicMock()
        exec_result.scalars.return_value = scalar_result
        exec_result.all.return_value = []
        mock_db.execute = AsyncMock(return_value=exec_result)

        repo = ReadingContentRepository(mock_db)
        self.assertEqual(await repo.pages_by_ids([]), {})
        self.assertEqual(await repo.revision_snapshots([]), {})
        self.assertEqual(await repo.revision_word_ids_by_revisions([]), {})
        mock_db.execute.assert_not_awaited()

        p1 = uuid.uuid4()
        r1 = uuid.uuid4()
        await repo.pages_by_ids([p1, p1])
        await repo.revision_snapshots([(p1, r1)])
        await repo.revision_word_ids_by_revisions([r1, r1])
        self.assertEqual(mock_db.execute.await_count, 3)


class TestM2DirectCatalogCoverAndIllustrationSigning(unittest.IsolatedAsyncioTestCase):
    def setUp(self) -> None:
        storage_service.clear_signed_url_cache()

    def tearDown(self) -> None:
        storage_service.clear_signed_url_cache()

    async def test_catalog_list_mixed_public_and_private_signs_only_public_covers(self) -> None:
        actor_id = uuid.uuid4()
        pub_book_id = uuid.uuid4()
        priv_book_id = uuid.uuid4()
        owner_asset_book_id = uuid.uuid4()
        pub_asset_id = uuid.uuid4()
        priv_asset_id = uuid.uuid4()
        owned_cat_asset_id = uuid.uuid4()
        now = datetime.now(timezone.utc)

        books = [
            SimpleNamespace(
                Id=pub_book_id,
                Title="Sach Cong Khai",
                Author="Tac gia A",
                MinGrade=1,
                MaxGrade=2,
                LifecycleStatus="ACTIVE",
                VisibilityScope="CATALOG",
                OwnerParentId=None,
                ModerationStatus="ACTIVE",
                IsDeleted=False,
                CreatedAt=now,
            ),
            SimpleNamespace(
                Id=priv_book_id,
                Title="Sach Rieng",
                Author="Phu huynh",
                MinGrade=1,
                MaxGrade=2,
                LifecycleStatus="ACTIVE",
                VisibilityScope="PARENT_PRIVATE",
                OwnerParentId=actor_id,
                ModerationStatus="ACTIVE",
                IsDeleted=False,
                CreatedAt=now,
            ),
            SimpleNamespace(
                Id=owner_asset_book_id,
                Title="Sach Co Owner Asset",
                Author="Tac gia B",
                MinGrade=1,
                MaxGrade=2,
                LifecycleStatus="ACTIVE",
                VisibilityScope="CATALOG",
                OwnerParentId=None,
                ModerationStatus="ACTIVE",
                IsDeleted=False,
                CreatedAt=now,
            ),
        ]
        cover_assets = [
            SimpleNamespace(
                Id=pub_asset_id,
                BookId=pub_book_id,
                SourceType="USER_UPLOAD",
                StoragePath="studio/covers/catalog/pub.webp",
                OwnerId=None,
            ),
            SimpleNamespace(
                Id=priv_asset_id,
                BookId=priv_book_id,
                SourceType="USER_UPLOAD",
                StoragePath=f"private-books/{actor_id}/{priv_book_id}/cover.webp",
                OwnerId=actor_id,
            ),
            SimpleNamespace(
                Id=owned_cat_asset_id,
                BookId=owner_asset_book_id,
                SourceType="USER_UPLOAD",
                StoragePath="studio/covers/owned/c.webp",
                OwnerId=actor_id,
            ),
        ]

        class _NestedCtx:
            async def __aenter__(self):
                return self

            async def __aexit__(self, *_a):
                return False

        class _ScalarRows:
            def all(self):
                return cover_assets

        fake_db = MagicMock()
        fake_db.begin_nested = MagicMock(return_value=_NestedCtx())
        fake_db.scalars = AsyncMock(return_value=_ScalarRows())
        fake_db.rollback = AsyncMock()

        repo = MagicMock()
        repo.db = fake_db
        repo.list = AsyncMock(return_value=books)

        sign_async_mock = AsyncMock(
            return_value=["https://proj.supabase.co/storage/v1/object/sign/book-pages/studio/covers/catalog/pub.webp?token=pub"]
        )
        with (
            patch("app.services.book_service.is_local_storage_enabled", return_value=False),
            patch("app.services.book_service.create_cached_signed_image_urls_async", sign_async_mock),
        ):
            items = await CatalogService(repository=repo).list(
                None, None, None, actor_id=actor_id, include_private=True
            )

        by_id = {item.id: item for item in items}
        sign_async_mock.assert_awaited_once()
        self.assertEqual(
            sign_async_mock.await_args.args[0],
            ["studio/covers/catalog/pub.webp"],
        )
        self.assertTrue(by_id[pub_book_id].cover_url.startswith("https://proj.supabase.co/"))
        self.assertEqual(by_id[priv_book_id].cover_url, f"/studio/assets/{priv_asset_id}/media")
        self.assertEqual(by_id[owner_asset_book_id].cover_url, f"/studio/assets/{owned_cat_asset_id}/media")

        # Fallback to proxy URL when local storage is active or signing raises
        with (
            patch("app.services.book_service.is_local_storage_enabled", return_value=True),
            patch("app.services.book_service.create_cached_signed_image_urls_async", sign_async_mock),
        ):
            items_local = await CatalogService(repository=repo).list(None, None, None)
        self.assertEqual(
            {i.id: i for i in items_local}[pub_book_id].cover_url,
            f"/studio/assets/{pub_asset_id}/media",
        )

        with (
            patch("app.services.book_service.is_local_storage_enabled", return_value=False),
            patch(
                "app.services.book_service.create_cached_signed_image_urls_async",
                AsyncMock(side_effect=HTTPException(status_code=503, detail="storage down")),
            ),
        ):
            items_err = await CatalogService(repository=repo).list(None, None, None)
        self.assertEqual(
            {i.id: i for i in items_err}[pub_book_id].cover_url,
            f"/studio/assets/{pub_asset_id}/media",
        )

    async def test_reading_page_dto_public_illustration_direct_signed_and_private_proxied(
        self,
    ) -> None:
        ill_id = uuid.uuid4()
        pub_ill = SimpleNamespace(
            Id=ill_id,
            StoragePath="studio/illustrations/cat/p1.webp",
            OwnerId=None,
        )

        class _NestedCtx:
            async def __aenter__(self):
                return self

            async def __aexit__(self, *_a):
                return False

        fake_db = MagicMock()
        fake_db.rollback = AsyncMock()
        fake_db.begin_nested = MagicMock(return_value=_NestedCtx())
        fake_db.scalar = AsyncMock(return_value=pub_ill)

        repo = MagicMock()
        repo.db = fake_db
        rev_id = uuid.uuid4()
        repo.revision_words = AsyncMock(
            return_value=[
                SimpleNamespace(
                    Id=uuid.uuid4(),
                    WordIndex=0,
                    Text="Xin",
                    BoundingBox=[0.1, 0.1, 0.2, 0.05],
                    LineIndex=0,
                )
            ]
        )
        svc = ReadingContentService(repo)

        pub_book_id = uuid.uuid4()
        page = SimpleNamespace(
            Id=uuid.uuid4(),
            BookId=pub_book_id,
            PageNumber=1,
            ImagePath="",
            CurrentVerifiedRevisionId=rev_id,
            Width=500,
            Height=700,
        )
        rev = SimpleNamespace(
            Id=rev_id,
            VerifiedText="Xin chao",
            VerificationStatus="VERIFIED",
            ProcessingMeta={},
        )

        with (
            patch("app.services.reading_content_service.is_local_storage_enabled", return_value=False),
            patch(
                "app.services.reading_content_service.create_cached_signed_image_urls_async",
                AsyncMock(return_value=["https://proj.supabase.co/storage/v1/object/sign/book-pages/ill.webp?t=1"]),
            ),
        ):
            pub_dto = await svc._build_page_dto(
                page, rev, book_is_private=False, owner_parent_id=None
            )
            self.assertEqual(
                pub_dto.illustration_url,
                "https://proj.supabase.co/storage/v1/object/sign/book-pages/ill.webp?t=1",
            )
            self.assertTrue(pub_dto.illustration_text_free)

            priv_dto = await svc._build_page_dto(
                page, rev, book_is_private=True, owner_parent_id=uuid.uuid4()
            )
            self.assertEqual(priv_dto.illustration_url, f"/studio/assets/{ill_id}/media")

    async def test_book_cover_service_uses_download_object_async_and_route_returns_200(self) -> None:
        actor_id = uuid.uuid4()
        asset_id = uuid.uuid4()
        book_id = uuid.uuid4()
        db = SimpleNamespace(rollback=AsyncMock())
        svc = BookCoverService(db)  # type: ignore[arg-type]
        svc.repo = SimpleNamespace(
            get_actor_role=AsyncMock(return_value="parent"),
            get_book=AsyncMock(
                return_value=SimpleNamespace(
                    Id=book_id,
                    VisibilityScope="CATALOG",
                    OwnerParentId=None,
                    LifecycleStatus="ACTIVE",
                    ModerationStatus="ACTIVE",
                    IsDeleted=False,
                )
            ),
            get_asset_by_id=AsyncMock(
                return_value=(
                    SimpleNamespace(
                        Id=asset_id,
                        BookId=book_id,
                        AssetRole="COVER",
                        IsActive=True,
                        ModerationStatus="APPROVED",
                        TextFreeVerified=True,
                        StoragePath="studio/covers/cat/c.webp",
                        MimeType="image/webp",
                    ),
                    False,
                )
            ),
        )
        with (
            patch.object(svc, "_is_catalog_book_eligible", AsyncMock(return_value=True)),
            patch(
                "app.services.book_cover_service.download_object_async",
                AsyncMock(return_value=b"WEBP_ASYNC_BYTES"),
            ) as dl_async,
        ):
            content, mime, is_priv = await svc.get_authorized_asset_media(actor_id, asset_id)
        dl_async.assert_awaited_once()
        db.rollback.assert_awaited_once()
        self.assertEqual(content, b"WEBP_ASYNC_BYTES")
        self.assertEqual(mime, "image/webp")
        self.assertFalse(is_priv)

        # Route continues returning 200 (never 307) with appropriate Cache-Control
        app = FastAPI()
        app.include_router(book_assets_router, prefix="/studio")
        app.dependency_overrides[get_current_parent_id] = lambda: actor_id
        app.dependency_overrides[get_db] = lambda: db
        client = TestClient(app)
        with patch.object(
            BookCoverService,
            "get_authorized_asset_media",
            AsyncMock(return_value=(b"BYTES", "image/webp", True)),
        ):
            resp = client.get(f"/studio/assets/{asset_id}/media", follow_redirects=False)
        self.assertEqual(resp.status_code, 200)
        self.assertIn("no-store", resp.headers.get("cache-control", ""))


class TestM2DocumentRasterizerStreamingAndCleanup(unittest.IsolatedAsyncioTestCase):
    def test_iter_rasterized_spooled_document_early_exit_cleans_up_temp_pdf(self) -> None:
        pdf_bytes = _make_pdf_bytes(4)
        before_pdfs = {p.name for p in Path(tempfile.gettempdir()).glob("viread_pdf_*.pdf")}
        spooled = spool_bytes_document(
            file_name="sample.pdf",
            content_type="application/pdf",
            data=pdf_bytes,
        )
        try:
            with iter_rasterized_spooled_document(spooled) as (_fname, fmt, _sha, page_iter):
                self.assertEqual(fmt, "PDF")
                first = next(page_iter)
                self.assertEqual(first.source_page, 1)
                # Exit early before consuming pages 2..4
        finally:
            spooled.close()

        after_pdfs = {p.name for p in Path(tempfile.gettempdir()).glob("viread_pdf_*.pdf")}
        self.assertEqual(after_pdfs - before_pdfs, set())

        # Also verify iter_rasterized_document_pages helper streams bytes cleanly
        streamed_pages: list[int] = []
        with iter_rasterized_document_pages(
            filename="sample.pdf",
            content_type="application/pdf",
            data=pdf_bytes,
        ) as (_fname, fmt, _sha, page_iter):
            self.assertEqual(fmt, "PDF")
            for p in page_iter:
                streamed_pages.append(p.source_page)
        self.assertEqual(streamed_pages, [1, 2, 3, 4])

    async def test_global_tasks_batch_book_import_mode_a_streams_pages(self) -> None:
        pdf_bytes = _make_pdf_bytes(3)
        job_id = uuid.uuid4()
        actor_id = uuid.uuid4()
        book_id = uuid.uuid4()
        job = SimpleNamespace(
            Id=job_id,
            JobType="BATCH_BOOK_IMPORT",
            ActorId=actor_id,
            ActorRole="admin",
            BookId=book_id,
            TargetPageId=None,
            LeaseToken="lease-1",
            AttemptCount=1,
            InputPayloadJson={},
            CheckpointsJson={
                "source_storage_path": "imports/book.pdf",
                "file_name": "book.pdf",
                "content_type": "application/pdf",
            },
        )
        book = SimpleNamespace(Id=book_id, VisibilityScope="CATALOG")
        db = MagicMock()
        db.commit = AsyncMock()
        db.rollback = AsyncMock()

        mock_svc = MagicMock()
        mock_svc.repo = MagicMock()
        mock_svc.repo.get_job_for_actor = AsyncMock(return_value=job)
        mock_svc.repo.get_book = AsyncMock(return_value=book)
        mock_svc.commit_stage_result = AsyncMock()

        class _SchedulerHandle:
            def checkpoint(self, _name: str, *, raise_on_preempt: bool = False):
                return None

        class _SchedulerCtx:
            async def __aenter__(self):
                return _SchedulerHandle()

            async def __aexit__(self, *args):
                return False

        mock_scheduler = MagicMock()
        mock_scheduler.acquire = MagicMock(return_value=_SchedulerCtx())

        ingested_pages: list[int] = []

        async def _fake_ingest(actor, b_id, *, data: bytes, **kwargs):
            idx = len(ingested_pages) + 1
            ingested_pages.append(len(data))
            return idx, SimpleNamespace(page_id=uuid.uuid4())

        lease_token = uuid.uuid4()
        before_pdfs = {p.name for p in Path(tempfile.gettempdir()).glob("viread_pdf_*.pdf")}
        with (
            patch("app.services.storage_service.download_object", return_value=pdf_bytes),
            patch("app.services.admin_ocr_service.AdminOcrService._ingest_validated_page_image", side_effect=_fake_ingest),
        ):
            await _execute_batch_book_import_job(
                db, mock_svc, job, lease_token, mock_scheduler, MagicMock()
            )
        after_pdfs = {p.name for p in Path(tempfile.gettempdir()).glob("viread_pdf_*.pdf")}

        self.assertEqual(after_pdfs - before_pdfs, set())
        self.assertEqual(len(ingested_pages), 3)
        final_call = mock_svc.commit_stage_result.await_args_list[-1].kwargs
        self.assertEqual(final_call["next_status"], "SUCCEEDED")
        self.assertEqual(final_call["result_ref"]["total_source_pages"], 3)
        self.assertEqual(len(final_call["result_ref"]["created_page_ids"]), 3)

    async def test_parent_private_replace_file_streams_and_aborts_multipage_at_page_2(self) -> None:
        actor_id = uuid.uuid4()
        book_id = uuid.uuid4()
        page_id = uuid.uuid4()
        sub_id = uuid.uuid4()
        now = datetime.now(timezone.utc)

        book = SimpleNamespace(
            Id=book_id,
            OwnerParentId=actor_id,
            VisibilityScope="PARENT_PRIVATE",
            ModerationStatus="ACTIVE",
            LifecycleStatus="ACTIVE",
            SourceDeclaration="[SELF_AUTHORED]",
        )
        page_row = SimpleNamespace(Id=page_id, PageNumber=1, LifecycleStatus="ACTIVE")
        sub_row = SimpleNamespace(
            Id=sub_id,
            BookId=book_id,
            OwnerParentId=actor_id,
            BatchId=uuid.uuid4(),
            BatchTotalPages=1,
            SourcePageNumber=1,
            TargetPageNumber=1,
            SourceFileName="old.png",
            SourceFormat="PNG",
            SourceStoragePath=f"private-books/{actor_id}/{book_id}/staging/{sub_id}/old.png",
            SourceSha256="a" * 64,
            ImageWidth=400,
            ImageHeight=500,
            SourceType="SELF_AUTHORED",
            SourceNote=None,
            SubmissionVersion=1,
            OptimisticLockVersion=1,
            WorkflowStatus="NEEDS_RECHECK",
            OcrStatus="COMPLETED",
            OcrText="abc",
            OcrWordsJson=[],
            OcrErrorCode=None,
            IsImageOnly=False,
            ProofreadStatus="COMPLETED",
            ProofreadText="abc",
            ProofreadSuggestionsJson=[],
            UncertainWordIndicesJson=[],
            ProofreadProviderEventsJson=[],
            ProofreadErrorCode=None,
            SpellingAcceptedAt=None,
            CandidateText="abc",
            CandidateHash="h1",
            CandidateWordsJson=[],
            ToolCheckStatus="PASSED",
            ToolCheckSuitability="SUITABLE",
            ToolCheckScopeJson={},
            ToolCheckFindingsJson=[],
            ToolCheckProviderEventsJson=[],
            ToolCheckPolicyBlocked=False,
            ToolCheckWorkflowId=None,
            ToolCheckErrorCode=None,
            AdminDecision=None,
            AdminDecisionReason=None,
            ApprovedSnapshotHash=None,
            ApprovedSubmissionVersion=None,
            CommittedPageId=None,
            CommittedRevisionId=None,
            CreatedAt=now,
            UpdatedAt=now,
        )

        db = MagicMock()
        db.commit = AsyncMock()
        db.rollback = AsyncMock()
        db.refresh = AsyncMock()
        svc = ParentPrivateBookService(db)
        svc.repo = MagicMock()
        svc.repo.role = AsyncMock(return_value="parent")
        svc.repo.get_owned_private_book = AsyncMock(return_value=book)
        svc.repo.get_committed_page = AsyncMock(return_value=(page_row, SimpleNamespace()))
        svc.repo.get_submission_by_committed_page_id = AsyncMock(return_value=sub_row)
        svc.repo.get_owned_submission = AsyncMock(return_value=sub_row)
        svc.repo.rollback = AsyncMock()
        svc.repo.commit = AsyncMock()
        svc.repo.supersede_open_moderation_requests = AsyncMock()
        svc.repo.add_audit_log = AsyncMock()
        svc.repo.list_moderation_history = AsyncMock(return_value=[])
        svc._sync_remote_ocr_for_submissions = AsyncMock(return_value=[])
        svc._dispatch_post_ocr_if_ready = MagicMock()
        svc._safe_revoke_flow2_contributions = AsyncMock()

        yielded_count = 0
        orig_iter = iter_rasterized_spooled_document

        from contextlib import contextmanager

        @contextmanager
        def _counting_iter(spooled):
            nonlocal yielded_count
            with orig_iter(spooled) as (fname, fmt, sha, page_iter):
                def _wrapped():
                    nonlocal yielded_count
                    for item in page_iter:
                        yielded_count += 1
                        yield item

                yield fname, fmt, sha, _wrapped()

        before_pdfs = {p.name for p in Path(tempfile.gettempdir()).glob("viread_pdf_*.pdf")}
        with (
            patch(
                "app.services.parent_private_book_service.iter_rasterized_spooled_document",
                side_effect=_counting_iter,
            ),
            patch("app.services.parent_private_book_service.upload_object") as upload_mock,
        ):
            with self.assertRaises(HTTPException) as err1:
                await svc.replace_committed_page_file(
                    actor_id, book_id, page_id, _make_pdf_upload("multi.pdf", 4)
                )
            self.assertEqual(err1.exception.status_code, 422)
            self.assertEqual(yielded_count, 2)  # Stopped immediately at page 2 (never 3 or 4)
            upload_mock.assert_not_called()

            yielded_count = 0
            with self.assertRaises(HTTPException) as err2:
                await svc.replace_submission_file(
                    actor_id, book_id, sub_id, _make_pdf_upload("multi.pdf", 4)
                )
            self.assertEqual(err2.exception.status_code, 422)
            self.assertEqual(yielded_count, 2)
            upload_mock.assert_not_called()

        after_pdfs = {p.name for p in Path(tempfile.gettempdir()).glob("viread_pdf_*.pdf")}
        self.assertEqual(after_pdfs - before_pdfs, set())

        # Single-page upload succeeds and triggers delete_object rollback cleanup on DB commit failure
        with (
            patch("app.services.parent_private_book_service.upload_object") as upload_mock,
            patch("app.services.parent_private_book_service.delete_object") as delete_mock,
            patch("app.services.parent_private_book_service.invalidate_tts_cache_best_effort", AsyncMock()),
        ):
            dto = await svc.replace_committed_page_file(
                actor_id, book_id, page_id, _make_png_upload("single.png")
            )
            self.assertEqual(dto.source_format, "PNG")
            upload_mock.assert_called_once()
            delete_mock.assert_not_called()

            # Rollback cleanup on DB error in replace_submission_file
            svc.repo.commit = AsyncMock(side_effect=RuntimeError("db failure"))
            with self.assertRaises(RuntimeError):
                await svc.replace_submission_file(
                    actor_id, book_id, sub_id, _make_pdf_upload("single.pdf", 1)
                )
            delete_mock.assert_called_once()


class TestM2RollbackOrmExpiryAndPolish(unittest.IsolatedAsyncioTestCase):
    def setUp(self) -> None:
        storage_service.clear_signed_url_cache()

    def tearDown(self) -> None:
        storage_service.clear_signed_url_cache()

    @staticmethod
    def _attach_persistent(session, *orm_objects) -> None:
        from sqlalchemy.orm import make_transient_to_detached

        for obj in orm_objects:
            make_transient_to_detached(obj)
            session.sync_session.add(obj)

    async def test_catalog_and_admin_list_survive_real_sqlalchemy_rollback_orm_expiry(
        self,
    ) -> None:
        from sqlalchemy import inspect
        from sqlalchemy.ext.asyncio import create_async_engine

        from app.database.session import ConcurrencyLimitedAsyncSession
        from app.models import Book
        from app.repositories.book_repository import AdminCatalogRepository, CatalogRepository
        from app.schemas.book import CatalogBookResponse

        aeng = create_async_engine("postgresql+asyncpg://test:test@127.0.0.1:1/test")
        session = ConcurrencyLimitedAsyncSession(bind=aeng, expire_on_commit=False)
        try:
            actor_id = uuid.uuid4()
            pub_book_id = uuid.uuid4()
            priv_book_id = uuid.uuid4()
            pub_asset_id = uuid.uuid4()
            priv_asset_id = uuid.uuid4()
            now = datetime.now(timezone.utc)

            pub_book = Book(
                Id=pub_book_id,
                Name="Sach Cong Khai",
                Title="Sach Cong Khai",
                Author="Tac gia A",
                MinGrade=1,
                MaxGrade=2,
                LifecycleStatus="ACTIVE",
                VisibilityScope="CATALOG",
                OwnerParentId=None,
                ModerationStatus="ACTIVE",
                IsDeleted=False,
                CreatedAt=now,
            )
            priv_book = Book(
                Id=priv_book_id,
                Name="Sach Rieng",
                Title="Sach Rieng",
                Author="Phu huynh",
                MinGrade=1,
                MaxGrade=2,
                LifecycleStatus="ACTIVE",
                VisibilityScope="PARENT_PRIVATE",
                OwnerParentId=actor_id,
                ModerationStatus="ACTIVE",
                IsDeleted=False,
                CreatedAt=now,
            )
            self._attach_persistent(session, pub_book, priv_book)
            self.assertFalse(inspect(pub_book).expired)
            self.assertFalse(inspect(priv_book).expired)

            cover_assets = [
                SimpleNamespace(
                    Id=pub_asset_id,
                    BookId=pub_book_id,
                    SourceType="USER_UPLOAD",
                    StoragePath="studio/covers/cat/pub-orm.webp",
                    OwnerId=None,
                ),
                SimpleNamespace(
                    Id=priv_asset_id,
                    BookId=priv_book_id,
                    SourceType="USER_UPLOAD",
                    StoragePath=f"private-books/{actor_id}/{priv_book_id}/cover.webp",
                    OwnerId=actor_id,
                ),
            ]

            class _NestedCtx:
                async def __aenter__(self):
                    return self

                async def __aexit__(self, *_a):
                    return False

            class _ScalarRows:
                def __init__(self, rows):
                    self._rows = rows

                def all(self):
                    return self._rows

            # Keep session.rollback as the REAL ConcurrencyLimitedAsyncSession.rollback!
            session.begin_nested = MagicMock(return_value=_NestedCtx())  # type: ignore[method-assign]
            session.scalars = AsyncMock(return_value=_ScalarRows(cover_assets))  # type: ignore[method-assign]

            cat_repo = CatalogRepository(session)
            cat_repo.list = AsyncMock(return_value=[pub_book, priv_book])  # type: ignore[method-assign]
            sign_mock = AsyncMock(
                return_value=[
                    "https://proj.supabase.co/storage/v1/object/sign/book-pages/studio/covers/cat/pub-orm.webp?t=1"
                ]
            )
            with (
                patch("app.services.book_service.is_local_storage_enabled", return_value=False),
                patch(
                    "app.services.book_service.create_cached_signed_image_urls_async",
                    sign_mock,
                ),
            ):
                items = await CatalogService(repository=cat_repo).list(
                    None, None, None, actor_id=actor_id, include_private=True
                )

            self.assertTrue(inspect(pub_book).expired)
            self.assertTrue(inspect(priv_book).expired)
            by_id = {item.id: item for item in items}
            self.assertIsInstance(by_id[pub_book_id], CatalogBookResponse)
            self.assertEqual(
                by_id[pub_book_id].cover_url,
                "https://proj.supabase.co/storage/v1/object/sign/book-pages/studio/covers/cat/pub-orm.webp?t=1",
            )
            self.assertEqual(
                by_id[priv_book_id].cover_url,
                f"/studio/assets/{priv_asset_id}/media",
            )

            # CatalogService.get with real ORM Book
            get_book_id = uuid.uuid4()
            get_book = Book(
                Id=get_book_id,
                Name="Sach Get",
                Title="Sach Get",
                Author="Tac gia",
                MinGrade=1,
                MaxGrade=2,
                LifecycleStatus="ACTIVE",
                VisibilityScope="CATALOG",
                OwnerParentId=None,
                ModerationStatus="ACTIVE",
                IsDeleted=False,
                CreatedAt=now,
            )
            self._attach_persistent(session, get_book)
            session.scalars = AsyncMock(  # type: ignore[method-assign]
                return_value=_ScalarRows(
                    [
                        SimpleNamespace(
                            Id=uuid.uuid4(),
                            BookId=get_book_id,
                            SourceType="USER_UPLOAD",
                            StoragePath="studio/covers/cat/get-orm.webp",
                            OwnerId=None,
                        )
                    ]
                )
            )
            cat_repo.get = AsyncMock(return_value=get_book)  # type: ignore[method-assign]
            cat_repo.is_eligible = AsyncMock(return_value=True)  # type: ignore[method-assign]
            with (
                patch("app.services.book_service.is_local_storage_enabled", return_value=False),
                patch(
                    "app.services.book_service.create_cached_signed_image_urls_async",
                    AsyncMock(
                        return_value=[
                            "https://proj.supabase.co/storage/v1/object/sign/book-pages/studio/covers/cat/get-orm.webp?t=1"
                        ]
                    ),
                ),
            ):
                got = await CatalogService(repository=cat_repo).get(get_book_id)
            self.assertTrue(inspect(get_book).expired)
            self.assertTrue(got.cover_url.endswith("get-orm.webp?t=1"))

            # AdminCatalogService.list (AdminCatalogRepository path) with real ORM Book
            admin_book_id = uuid.uuid4()
            admin_book = Book(
                Id=admin_book_id,
                Name="Admin ORM",
                Title="Admin ORM",
                Author="Admin",
                MinGrade=1,
                MaxGrade=3,
                LifecycleStatus="ACTIVE",
                VisibilityScope="CATALOG",
                OwnerParentId=None,
                ModerationStatus="ACTIVE",
                IsDeleted=False,
                CreatedAt=now,
            )
            self._attach_persistent(session, admin_book)
            session.scalars = AsyncMock(  # type: ignore[method-assign]
                return_value=_ScalarRows(
                    [
                        SimpleNamespace(
                            Id=uuid.uuid4(),
                            BookId=admin_book_id,
                            SourceType="USER_UPLOAD",
                            StoragePath="studio/covers/cat/admin-orm.webp",
                            OwnerId=None,
                        )
                    ]
                )
            )
            admin_repo = AdminCatalogRepository(session)
            admin_repo.catalog_rows = AsyncMock(  # type: ignore[method-assign]
                return_value=[(admin_book, 3, 0, 0, 3, 0, True)]
            )
            with (
                patch("app.services.book_service.is_local_storage_enabled", return_value=False),
                patch(
                    "app.services.book_service.create_cached_signed_image_urls_async",
                    AsyncMock(
                        return_value=[
                            "https://proj.supabase.co/storage/v1/object/sign/book-pages/studio/covers/cat/admin-orm.webp?t=1"
                        ]
                    ),
                ),
            ):
                admin_rows = await AdminCatalogService(repository=admin_repo).list(
                    None, None, None
                )
            self.assertTrue(inspect(admin_book).expired)
            self.assertEqual(len(admin_rows), 1)
            self.assertTrue(admin_rows[0].book.cover_url.endswith("admin-orm.webp?t=1"))

            # AdminCatalogService.list (fallback repository path) with real ORM Book
            fb_book_id = uuid.uuid4()
            fb_book = Book(
                Id=fb_book_id,
                Name="Fallback ORM",
                Title="Fallback ORM",
                Author="Admin",
                MinGrade=1,
                MaxGrade=2,
                LifecycleStatus="ACTIVE",
                VisibilityScope="CATALOG",
                OwnerParentId=None,
                ModerationStatus="ACTIVE",
                IsDeleted=False,
                CreatedAt=now,
            )
            self._attach_persistent(session, fb_book)
            session.scalars = AsyncMock(  # type: ignore[method-assign]
                return_value=_ScalarRows(
                    [
                        SimpleNamespace(
                            Id=uuid.uuid4(),
                            BookId=fb_book_id,
                            SourceType="USER_UPLOAD",
                            StoragePath="studio/covers/cat/fb-orm.webp",
                            OwnerId=None,
                        )
                    ]
                )
            )
            fb_repo = MagicMock()
            fb_repo.db = session
            fb_repo.books = AsyncMock(return_value=[fb_book])
            fb_repo.pages = AsyncMock(return_value=[])
            fb_repo.is_eligible = AsyncMock(return_value=True)
            with (
                patch("app.services.book_service.is_local_storage_enabled", return_value=False),
                patch(
                    "app.services.book_service.create_cached_signed_image_urls_async",
                    AsyncMock(
                        return_value=[
                            "https://proj.supabase.co/storage/v1/object/sign/book-pages/studio/covers/cat/fb-orm.webp?t=1"
                        ]
                    ),
                ),
            ):
                fb_rows = await AdminCatalogService(repository=fb_repo).list(
                    None, None, None
                )
            self.assertTrue(inspect(fb_book).expired)
            self.assertEqual(len(fb_rows), 1)
            self.assertTrue(fb_rows[0].book.cover_url.endswith("fb-orm.webp?t=1"))
        finally:
            await session.close()
            await aeng.dispose()

    async def test_parent_private_replays_survive_real_sqlalchemy_rollback_orm_expiry(
        self,
    ) -> None:
        from sqlalchemy import inspect
        from sqlalchemy.exc import IntegrityError
        from sqlalchemy.ext.asyncio import create_async_engine

        from app.database.session import ConcurrencyLimitedAsyncSession
        from app.models import Book, BookPage, ParentBookPageSubmission
        from app.schemas.parent_private_book import ParentAddPageRequest

        aeng = create_async_engine("postgresql+asyncpg://test:test@127.0.0.1:1/test")
        session = ConcurrencyLimitedAsyncSession(bind=aeng, expire_on_commit=False)
        try:
            actor_id = uuid.uuid4()
            book_id = uuid.uuid4()
            batch_id = uuid.uuid4()
            sub_id = uuid.uuid4()
            page_id = uuid.uuid4()
            rev_id = uuid.uuid4()
            now = datetime.now(timezone.utc)

            def _make_book() -> Book:
                return Book(
                    Id=book_id,
                    Name="Sach Rieng",
                    Title="Sach Rieng",
                    Author="Phu huynh",
                    MinGrade=1,
                    MaxGrade=2,
                    LifecycleStatus="ACTIVE",
                    VisibilityScope="PARENT_PRIVATE",
                    OwnerParentId=actor_id,
                    ModerationStatus="ACTIVE",
                    IsDeleted=False,
                    CreatedAt=now,
                )

            def _make_sub(*, status: str = "CHECKING", committed: bool = False) -> ParentBookPageSubmission:
                return ParentBookPageSubmission(
                    Id=sub_id,
                    BookId=book_id,
                    OwnerParentId=actor_id,
                    BatchId=batch_id,
                    BatchTotalPages=1,
                    SourcePageNumber=1,
                    TargetPageNumber=3,
                    IdempotencyKey="idem-1",
                    SourceFileName="page.png",
                    SourceFormat="PNG",
                    SourceStoragePath=f"private-books/{actor_id}/{book_id}/staging/{sub_id}/page.png",
                    SourceSha256="a" * 64,
                    ImageWidth=400,
                    ImageHeight=600,
                    SourceType="SELF_AUTHORED",
                    SourceNote=None,
                    SubmissionVersion=1,
                    OptimisticLockVersion=1,
                    WorkflowStatus=status,
                    OcrStatus="COMPLETED",
                    OcrText="Xin chao cac ban nho",
                    OcrWordsJson=[],
                    OcrMetaJson={},
                    OcrHash="ocrhash",
                    OcrErrorCode=None,
                    IsImageOnly=False,
                    ProofreadStatus="COMPLETED",
                    ProofreadText="Xin chao cac ban nho",
                    ProofreadHash="proofhash",
                    ProofreadSuggestionsJson=[],
                    UncertainWordIndicesJson=[],
                    ProofreadProviderEventsJson=[],
                    ProofreadErrorCode=None,
                    SpellingAcceptedAt=None,
                    CandidateText="Xin chao cac ban nho",
                    CandidateHash="candhash-1234",
                    CandidateWordsJson=[],
                    ToolCheckStatus="PASSED",
                    ToolCheckInputHash="candhash-1234",
                    ToolCheckSuitability="SUITABLE",
                    ToolCheckScopeJson={},
                    ToolCheckFindingsJson=[],
                    ToolCheckProviderEventsJson=[],
                    ToolCheckPolicyBlocked=False,
                    ToolCheckWorkflowId=None,
                    ToolCheckErrorCode=None,
                    ToolCheckCompletedAt=now,
                    AdminDecision=None,
                    AdminDecisionReason=None,
                    ApprovedSnapshotHash=None,
                    ApprovedSubmissionVersion=None,
                    ApprovedBy=None,
                    ApprovedAt=None,
                    CommittedPageId=page_id if committed else None,
                    CommittedRevisionId=rev_id if committed else None,
                    CommittedAt=now if committed else None,
                    WorkerId=None,
                    LeaseExpiresAt=None,
                    RetryAfter=None,
                    TempExpiresAt=now,
                    CreatedAt=now,
                    UpdatedAt=now,
                )

            def _make_page(num: int = 3) -> BookPage:
                return BookPage(
                    Id=page_id,
                    BookId=book_id,
                    PageNumber=num,
                    ImagePath=f"private-books/{actor_id}/{book_id}/pages/{page_id}/rev-1.png",
                    Width=400,
                    Height=600,
                    LifecycleStatus="ACTIVE",
                    CreatedAt=now,
                )

            svc = ParentPrivateBookService(session)
            svc.repo.role = AsyncMock(return_value="parent")  # type: ignore[method-assign]

            # 1) submit_pages early idempotency replay
            b1 = _make_book()
            s1 = _make_sub()
            self._attach_persistent(session, b1, s1)
            svc.repo.get_owned_private_book = AsyncMock(return_value=b1)  # type: ignore[method-assign]
            svc.repo.get_submissions_by_idempotency = AsyncMock(return_value=[s1])  # type: ignore[method-assign]
            with patch(
                "app.services.parent_private_book_service.private_submission_image_urls_async",
                AsyncMock(return_value=["https://signed.example/sub1.png"]),
            ):
                resp1 = await svc.submit_pages(
                    actor_id, book_id, _make_png_upload("page.png"), idempotency_key="idem-1"
                )
            self.assertTrue(inspect(b1).expired)
            self.assertTrue(inspect(s1).expired)
            self.assertTrue(resp1.replayed_idempotency)
            self.assertEqual(resp1.batch_id, batch_id)
            self.assertEqual(resp1.source_format, "PNG")
            self.assertEqual(resp1.submissions[0].image_url, "https://signed.example/sub1.png")

            # 2) submit_pages IntegrityError replay
            session.sync_session.expunge_all()
            b2_pre = _make_book()
            b2_locked = _make_book()
            b2_after = _make_book()
            s2_replayed = _make_sub()
            self._attach_persistent(session, b2_pre)
            svc.repo.get_owned_private_book = AsyncMock(  # type: ignore[method-assign]
                side_effect=[b2_pre, b2_locked, b2_after]
            )
            svc.repo.get_submissions_by_idempotency = AsyncMock(  # type: ignore[method-assign]
                side_effect=[[], [s2_replayed]]
            )
            svc.repo.add_submissions = AsyncMock(  # type: ignore[method-assign]
                side_effect=IntegrityError("dup", {}, Exception("unique"))
            )
            with (
                patch("app.services.parent_private_book_service.upload_object"),
                patch("app.services.parent_private_book_service.delete_object") as del_mock,
                patch(
                    "app.services.parent_private_book_service.private_submission_image_urls_async",
                    AsyncMock(return_value=["https://signed.example/sub2.png"]),
                ),
            ):
                # Run IntegrityError branch: first rollback happens after IntegrityError, then b2_after & s2_replayed are loaded and serialized
                # Ensure b2_after and s2_replayed become attached persistent objects in the session before serialization triggers rollback!
                async def _get_book_with_attach(*args, **kwargs):
                    res = b2_pre if _get_book_with_attach.calls == 0 else (b2_locked if _get_book_with_attach.calls == 1 else b2_after)
                    _get_book_with_attach.calls += 1
                    if res is b2_after:
                        session.sync_session.expunge_all()
                        self._attach_persistent(session, b2_after, s2_replayed)
                    return res
                _get_book_with_attach.calls = 0
                svc.repo.get_owned_private_book = _get_book_with_attach  # type: ignore[method-assign]
                resp2 = await svc.submit_pages(
                    actor_id, book_id, _make_png_upload("page.png"), idempotency_key="idem-1"
                )
            self.assertTrue(inspect(b2_after).expired)
            self.assertTrue(inspect(s2_replayed).expired)
            self.assertTrue(resp2.replayed_idempotency)
            self.assertEqual(resp2.batch_id, batch_id)
            self.assertEqual(resp2.source_format, "PNG")
            del_mock.assert_called_once()

            # 3) add_page_to_book Phase 1 idempotent replay
            session.sync_session.expunge_all()
            b3 = _make_book()
            s3 = _make_sub(status="ADDED_TO_BOOK", committed=True)
            p3 = _make_page(num=4)
            self._attach_persistent(session, b3, s3, p3)
            svc.repo.get_owned_private_book = AsyncMock(return_value=b3)  # type: ignore[method-assign]
            svc.repo.get_owned_submission = AsyncMock(return_value=s3)  # type: ignore[method-assign]
            svc.repo.get_committed_page = AsyncMock(return_value=(p3, SimpleNamespace()))  # type: ignore[method-assign]
            svc.repo.is_private_book_readable = AsyncMock(return_value=True)  # type: ignore[method-assign]
            payload = ParentAddPageRequest(
                expected_submission_version=1,
                expected_candidate_hash="candhash-1234",
            )
            with patch(
                "app.services.parent_private_book_service.private_submission_image_urls_async",
                AsyncMock(return_value=["https://signed.example/sub3.png"]),
            ):
                resp3 = await svc.add_page_to_book(actor_id, book_id, sub_id, payload)
            self.assertTrue(inspect(b3).expired)
            self.assertTrue(inspect(s3).expired)
            self.assertTrue(inspect(p3).expired)
            self.assertEqual(resp3.page_id, page_id)
            self.assertEqual(resp3.page_number, 4)
            self.assertEqual(resp3.revision_id, rev_id)

            # 4) add_page_to_book Phase 3 idempotent replay
            session.sync_session.expunge_all()
            b4_snap = _make_book()
            s4_snap = _make_sub(status="PASSED_READY_TO_ADD", committed=False)
            b4_lock = _make_book()
            s4_lock = _make_sub(status="ADDED_TO_BOOK", committed=True)
            p4_lock = _make_page(num=7)
            self._attach_persistent(session, b4_snap, s4_snap)

            async def _get_book_phase3(*args, **kwargs):
                if kwargs.get("lock"):
                    session.sync_session.expunge_all()
                    self._attach_persistent(session, b4_lock, s4_lock, p4_lock)
                    return b4_lock
                return b4_snap

            svc.repo.get_owned_private_book = _get_book_phase3  # type: ignore[method-assign]
            svc.repo.get_owned_submission = AsyncMock(side_effect=[s4_snap, s4_lock])  # type: ignore[method-assign]
            svc.repo.get_committed_page = AsyncMock(return_value=(p4_lock, SimpleNamespace()))  # type: ignore[method-assign]
            svc.repo.is_private_book_readable = AsyncMock(return_value=True)  # type: ignore[method-assign]
            with (
                patch("app.services.parent_private_book_service.download_object", return_value=b"PNG"),
                patch("app.services.parent_private_book_service.upload_object"),
                patch("app.services.parent_private_book_service.delete_object") as del_perm_mock,
                patch(
                    "app.services.parent_private_book_service.private_submission_image_urls_async",
                    AsyncMock(return_value=["https://signed.example/sub4.png"]),
                ),
            ):
                resp4 = await svc.add_page_to_book(actor_id, book_id, sub_id, payload)
            self.assertTrue(inspect(b4_lock).expired)
            self.assertTrue(inspect(s4_lock).expired)
            self.assertTrue(inspect(p4_lock).expired)
            self.assertEqual(resp4.page_id, page_id)
            self.assertEqual(resp4.page_number, 7)
            self.assertEqual(resp4.revision_id, rev_id)
            del_perm_mock.assert_called_once()
        finally:
            await session.close()
            await aeng.dispose()

    async def test_storage_service_one_arg_mock_compat_with_explicit_kwargs(self) -> None:
        one_arg_mock = lambda paths: [f"https://onearg.example/{p}" for p in paths]
        with patch.object(storage_service, "create_signed_image_urls", one_arg_mock):
            async_urls = await storage_service.create_cached_signed_image_urls_async(
                ["books/one-arg-a.png"],
                bucket_name="book-pages",
                ttl_seconds=300,
                max_workers=2,
            )
            sync_urls = storage_service.create_cached_signed_image_urls(
                ["books/one-arg-b.png"],
                bucket_name="book-pages",
                ttl_seconds=300,
                max_workers=2,
            )
        self.assertEqual(async_urls, ["https://onearg.example/books/one-arg-a.png"])
        self.assertEqual(sync_urls, ["https://onearg.example/books/one-arg-b.png"])

    async def test_global_tasks_mode_a_offloads_spool_bytes_document_to_threadpool(self) -> None:
        from starlette.concurrency import run_in_threadpool as real_run_in_threadpool

        pdf_bytes = _make_pdf_bytes(1)
        job = SimpleNamespace(
            Id=uuid.uuid4(),
            JobType="BATCH_BOOK_IMPORT",
            ActorId=uuid.uuid4(),
            ActorRole="admin",
            BookId=uuid.uuid4(),
            TargetPageId=None,
            LeaseToken="lease-1",
            AttemptCount=1,
            InputPayloadJson={},
            CheckpointsJson={
                "source_storage_path": "imports/onepage.pdf",
                "file_name": "onepage.pdf",
                "content_type": "application/pdf",
            },
        )
        book = SimpleNamespace(Id=job.BookId, VisibilityScope="CATALOG")
        db = MagicMock()
        db.commit = AsyncMock()
        db.rollback = AsyncMock()
        mock_svc = MagicMock()
        mock_svc.repo = MagicMock()
        mock_svc.repo.get_job_for_actor = AsyncMock(return_value=job)
        mock_svc.repo.get_book = AsyncMock(return_value=book)
        mock_svc.commit_stage_result = AsyncMock()

        class _SchedulerHandle:
            def checkpoint(self, _name: str, *, raise_on_preempt: bool = False):
                return None

        class _SchedulerCtx:
            async def __aenter__(self):
                return _SchedulerHandle()

            async def __aexit__(self, *args):
                return False

        mock_scheduler = MagicMock()
        mock_scheduler.acquire = MagicMock(return_value=_SchedulerCtx())

        threadpool_funcs: list[str] = []

        async def _tracking_threadpool(func, *args, **kwargs):
            threadpool_funcs.append(getattr(func, "__name__", str(func)))
            return await real_run_in_threadpool(func, *args, **kwargs)

        with (
            patch("starlette.concurrency.run_in_threadpool", side_effect=_tracking_threadpool),
            patch("app.services.storage_service.download_object", return_value=pdf_bytes),
            patch(
                "app.services.admin_ocr_service.AdminOcrService._ingest_validated_page_image",
                AsyncMock(return_value=(1, SimpleNamespace(page_id=uuid.uuid4()))),
            ),
        ):
            await _execute_batch_book_import_job(
                db, mock_svc, job, uuid.uuid4(), mock_scheduler, MagicMock()
            )
        self.assertIn("spool_bytes_document", threadpool_funcs)

    async def test_sever_lifespan_closes_storage_and_auth_http_clients_on_shutdown(self) -> None:
        import app.sever as sever_mod

        close_storage_mock = AsyncMock()
        close_auth_mock = AsyncMock()
        with (
            patch.object(sever_mod, "APP_ENVIRONMENT", "test"),
            patch.object(sever_mod.admin_ocr_correction_jobs, "shutdown", AsyncMock()),
            patch.object(sever_mod, "engine", MagicMock(dispose=AsyncMock())),
            patch("app.services.storage_service.aclose_storage_http_clients", close_storage_mock),
            patch("app.api.deps.aclose_auth_http_clients", close_auth_mock),
        ):
            async with sever_mod.lifespan(sever_mod.app):
                pass

        close_storage_mock.assert_awaited_once()
        close_auth_mock.assert_awaited_once()

    async def test_storage_http_client_evicts_and_recovers_on_transport_error_and_closes_on_shutdown(
        self,
    ) -> None:
        import asyncio
        import httpx

        loop = asyncio.get_running_loop()
        storage_service.clear_signed_url_cache()
        await storage_service.aclose_storage_http_clients()

        class _StaleTransportClient:
            def __init__(self, exc: Exception) -> None:
                self.is_closed = False
                self.closed_calls = 0
                self._exc = exc

            async def get(self, *args, **kwargs):
                raise self._exc

            async def post(self, *args, **kwargs):
                raise self._exc

            async def aclose(self) -> None:
                self.closed_calls += 1
                self.is_closed = True

        class _HealthyResponse:
            def __init__(self, status_code: int, *, content: bytes = b"", payload: object = None) -> None:
                self.status_code = status_code
                self.content = content
                self._payload = payload
                self.text = ""

            def json(self) -> object:
                return self._payload

            def raise_for_status(self) -> None:
                if self.status_code >= 400:
                    raise RuntimeError(f"HTTP {self.status_code}")

        class _HealthyPooledClient:
            def __init__(self) -> None:
                self.is_closed = False
                self.closed_calls = 0

            async def get(self, *args, **kwargs):
                return _HealthyResponse(200, content=b"recovered-png-bytes")

            async def post(self, url: str, *, json: dict, headers: dict):
                paths = json.get("paths", [])
                return _HealthyResponse(
                    200,
                    payload=[
                        {"path": p, "signedURL": f"/object/sign/book-pages/{p}?token=fresh"}
                        for p in paths
                    ],
                )

            async def aclose(self) -> None:
                self.closed_calls += 1
                self.is_closed = True

        stale_dl = _StaleTransportClient(
            httpx.RemoteProtocolError("Server disconnected without sending a response.")
        )
        healthy_dl = _HealthyPooledClient()
        storage_service._STORAGE_HTTP_CLIENTS[loop] = stale_dl  # type: ignore[assignment]

        try:
            with (
                patch.object(storage_service, "is_local_storage_enabled", return_value=False),
                patch.object(storage_service, "SUPABASE_URL", "https://proj.supabase.co"),
                patch.object(storage_service, "SUPABASE_ADMIN_KEY", "sb_secret_test_key"),
                patch.object(storage_service, "SUPABASE_STORAGE_BUCKET", "book-pages"),
                patch.object(storage_service, "_get_storage_async_client", side_effect=[stale_dl, healthy_dl]),
            ):
                # Inject healthy replacement into pool when stale_dl is evicted
                orig_evict = storage_service._evict_storage_http_client

                async def _evict_and_swap(expected=None):
                    await orig_evict(expected)
                    if expected is stale_dl:
                        storage_service._STORAGE_HTTP_CLIENTS[loop] = healthy_dl  # type: ignore[assignment]

                with patch.object(storage_service, "_evict_storage_http_client", side_effect=_evict_and_swap):
                    downloaded = await storage_service.download_object_async("books/b1/page1.png")

            self.assertEqual(downloaded, b"recovered-png-bytes")
            self.assertEqual(stale_dl.closed_calls, 1)
            self.assertTrue(stale_dl.is_closed)
            self.assertIs(storage_service._STORAGE_HTTP_CLIENTS.get(loop), healthy_dl)

            # Repeated TransportError on both attempts must evict and map to 503
            stale_fail_1 = _StaleTransportClient(httpx.ReadError("read failed 1"))
            stale_fail_2 = _StaleTransportClient(httpx.ConnectError("connect failed 2"))
            storage_service._STORAGE_HTTP_CLIENTS[loop] = stale_fail_1  # type: ignore[assignment]
            with (
                patch.object(storage_service, "is_local_storage_enabled", return_value=False),
                patch.object(storage_service, "SUPABASE_URL", "https://proj.supabase.co"),
                patch.object(storage_service, "SUPABASE_ADMIN_KEY", "sb_secret_test_key"),
                patch.object(storage_service, "SUPABASE_STORAGE_BUCKET", "book-pages"),
                patch.object(storage_service, "_get_storage_async_client", side_effect=[stale_fail_1, stale_fail_2]),
            ):
                async def _evict_twice(expected=None):
                    await orig_evict(expected)
                    if expected is stale_fail_1:
                        storage_service._STORAGE_HTTP_CLIENTS[loop] = stale_fail_2  # type: ignore[assignment]

                with patch.object(storage_service, "_evict_storage_http_client", side_effect=_evict_twice):
                    with self.assertRaises(HTTPException) as dl_503:
                        await storage_service.download_object_async("books/b1/page2.png")
            self.assertEqual(dl_503.exception.status_code, 503)
            self.assertEqual(stale_fail_1.closed_calls, 1)
            self.assertEqual(stale_fail_2.closed_calls, 1)
            self.assertNotIn(loop, storage_service._STORAGE_HTTP_CLIENTS)

            # create_cached_signed_image_urls_async eviction + recovery on RemoteProtocolError
            stale_sign = _StaleTransportClient(
                httpx.RemoteProtocolError("Server disconnected without sending a response.")
            )
            healthy_sign = _HealthyPooledClient()
            storage_service._STORAGE_HTTP_CLIENTS[loop] = stale_sign  # type: ignore[assignment]
            with (
                patch.object(storage_service, "SUPABASE_URL", "https://proj.supabase.co"),
                patch.object(storage_service, "SUPABASE_ADMIN_KEY", "sb_secret_test_key"),
                patch.object(storage_service, "SUPABASE_STORAGE_BUCKET", "book-pages"),
                patch.object(storage_service, "_get_storage_async_client", side_effect=[stale_sign, healthy_sign]),
            ):
                async def _evict_sign(expected=None):
                    await orig_evict(expected)
                    if expected is stale_sign:
                        storage_service._STORAGE_HTTP_CLIENTS[loop] = healthy_sign  # type: ignore[assignment]

                with patch.object(storage_service, "_evict_storage_http_client", side_effect=_evict_sign):
                    signed = await storage_service.create_cached_signed_image_urls_async(
                        ["books/b1/sign-recover.png"],
                        bucket_name="book-pages",
                    )
            self.assertEqual(
                signed,
                ["https://proj.supabase.co/storage/v1/object/sign/book-pages/books/b1/sign-recover.png?token=fresh"],
            )
            self.assertEqual(stale_sign.closed_calls, 1)
            self.assertTrue(stale_sign.is_closed)

            # Direct aclose_storage_http_clients() closes pooled clients and clears registry
            storage_service._STORAGE_HTTP_CLIENTS[loop] = healthy_sign  # type: ignore[assignment]
            await storage_service.aclose_storage_http_clients()
            self.assertEqual(healthy_sign.closed_calls, 1)
            self.assertTrue(healthy_sign.is_closed)
            self.assertEqual(len(storage_service._STORAGE_HTTP_CLIENTS), 0)
        finally:
            await storage_service.aclose_storage_http_clients()
            storage_service.clear_signed_url_cache()


if __name__ == "__main__":
    unittest.main()
