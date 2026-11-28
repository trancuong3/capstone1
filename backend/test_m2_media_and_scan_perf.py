"""Targeted unit & SQLite-execution tests for M2: Media Caching, Cover Delivery & Bounded Scans."""
from __future__ import annotations

import asyncio
import io
import os
import sys
import unittest
from datetime import datetime, timezone
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock, patch
from uuid import UUID, uuid4

os.environ.setdefault("DATABASE_URL", "postgresql+asyncpg://test:test@127.0.0.1:1/test")
os.environ.setdefault("SUPABASE_URL", "https://example.supabase.co")
os.environ.setdefault("SUPABASE_KEY", "isolated-test-key")

from fastapi import FastAPI, HTTPException
from fastapi.testclient import TestClient
import httpx
from PIL import Image
from sqlalchemy import create_engine, select, text
from sqlalchemy.dialects import postgresql
from sqlalchemy.orm import Session

from app.api.deps import get_current_parent_id, get_db
from app.api.routes import book as book_route
from app.api.routes import book_assets as book_assets_route
from app.api.routes import reading as reading_route
from app.database.session import Base
from app.models import AdminAiWorkflow, AuditLog, Book, BookPage, BookPresentationAsset, PageRevision
from app.repositories.book_assets_repository import BookAssetsRepository
from app.repositories.book_repository import CatalogRepository
from app.repositories.local_ocr_scan_repository import (
    MAX_BOOK_OCR_SCAN_CANDIDATES,
    MAX_GLOBAL_OCR_SCAN_CANDIDATES,
    LocalOcrScanRepository,
)
from app.services.book_cover_service import BookCoverService
from app.services.book_service import AdminCatalogService, BookService, CatalogService
from app.services.local_ocr_scan_service import LocalOcrScanService
from app.services.reading_content_service import ReadingContentService
from app.services.storage_service import clear_signed_url_cache


def _png_bytes(width: int = 320, height: int = 420, color: tuple[int, int, int] = (40, 140, 200)) -> bytes:
    buf = io.BytesIO()
    Image.new("RGB", (width, height), color).save(buf, format="PNG")
    return buf.getvalue()


class _ExpiringProxy:
    def __init__(self, **attrs):
        self.__dict__["_attrs"] = dict(attrs)
        self.__dict__["_expired"] = False

    def expire(self) -> None:
        self.__dict__["_expired"] = True

    def __getattr__(self, name: str):
        if self.__dict__["_expired"]:
            raise RuntimeError(f"MissingGreenlet simulation on {name}")
        if name not in self.__dict__["_attrs"]:
            raise AttributeError(name)
        return self.__dict__["_attrs"][name]


class M2SignedUrlCachingTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self) -> None:
        clear_signed_url_cache()

    def tearDown(self) -> None:
        clear_signed_url_cache()

    async def test_book_pages_catalog_previews_and_admin_image_reuse_signed_url_cache(self) -> None:
        book_id = uuid4()
        page_id = uuid4()
        rev_id = uuid4()
        actor_id = uuid4()
        now = datetime.now(timezone.utc)
        page_row = SimpleNamespace(
            Id=page_id,
            BookId=book_id,
            PageNumber=1,
            ImagePath="books/b1/p1.png",
            Width=800,
            Height=1200,
            LifecycleStatus="ACTIVE",
            CurrentVerifiedRevisionId=rev_id,
            CreatedAt=now,
        )

        # 1. GET /books/{book_id}/pages
        app = FastAPI()
        app.include_router(book_route.router, prefix="/books")
        db = MagicMock()
        db.rollback = AsyncMock()
        app.dependency_overrides[get_db] = lambda: db
        app.dependency_overrides[get_current_parent_id] = lambda: actor_id

        with (
            patch.object(book_route, "get_cached_profile_role", AsyncMock(return_value="parent")),
            patch.object(BookService, "list_pages", AsyncMock(return_value=[page_row])),
            patch(
                "app.services.storage_service.create_signed_image_urls",
                side_effect=lambda paths, **_kw: [f"https://cdn.example.com/{p}?sig=1" for p in paths],
            ) as sign_mock,
        ):
            async with httpx.AsyncClient(
                transport=httpx.ASGITransport(app=app),
                base_url="http://testserver",
            ) as client:
                r1 = await client.get(f"/books/{book_id}/pages", headers={"Authorization": "Bearer t1"})
                r2 = await client.get(f"/books/{book_id}/pages", headers={"Authorization": "Bearer t1"})
        self.assertEqual(r1.status_code, 200)
        self.assertEqual(r2.status_code, 200)
        self.assertEqual(r1.json()[0]["ImagePath"], "https://cdn.example.com/books/b1/p1.png?sig=1")
        self.assertEqual(r2.json()[0]["ImagePath"], "https://cdn.example.com/books/b1/p1.png?sig=1")
        sign_mock.assert_called_once_with(["books/b1/p1.png"], bucket_name=None, max_workers=8, ttl_seconds=3600)

        clear_signed_url_cache()

        # 2. CatalogService.previews + AdminCatalogService.image share cached URL
        repo = MagicMock()
        repo.db = MagicMock()
        repo.db.rollback = AsyncMock()
        repo.get = AsyncMock(
            return_value=SimpleNamespace(
                Id=book_id,
                LifecycleStatus="ACTIVE",
                VisibilityScope="CATALOG",
                OwnerParentId=None,
                ModerationStatus="ACTIVE",
            )
        )
        repo.is_eligible = AsyncMock(return_value=True)
        repo.previews = AsyncMock(return_value=[page_row])
        repo.page = AsyncMock(return_value=page_row)
        repo.revisions = AsyncMock(
            return_value=[SimpleNamespace(Id=rev_id, ProcessingMeta={})]
        )

        with patch(
            "app.services.storage_service.create_signed_image_urls",
            side_effect=lambda paths, **_kw: [f"https://cdn.example.com/{p}?sig=2" for p in paths],
        ) as sign_mock2:
            previews_res = await CatalogService(repository=repo).previews(book_id)
            admin_img = await AdminCatalogService(repository=repo).image(page_id)
        self.assertEqual(previews_res[0].preview_url, "https://cdn.example.com/books/b1/p1.png?sig=2")
        self.assertEqual(admin_img.preview_url, "https://cdn.example.com/books/b1/p1.png?sig=2")
        sign_mock2.assert_called_once()

    async def test_reading_page_dto_batches_and_isolates_catalog_vs_private_illustrations(self) -> None:
        book_id = uuid4()
        page_id = uuid4()
        rev_id = uuid4()
        ill_id = uuid4()

        class _NestedCtx:
            async def __aenter__(self):
                return self

            async def __aexit__(self, *_a):
                return False

        ill_asset = SimpleNamespace(
            Id=ill_id,
            StoragePath="studio/illustrations/catalog/ill-1.webp",
        )
        db = MagicMock()
        db.begin_nested = MagicMock(return_value=_NestedCtx())
        db.scalar = AsyncMock(return_value=ill_asset)
        db.rollback = AsyncMock()

        repo = MagicMock()
        repo.db = db
        repo.revision_words = AsyncMock(
            return_value=[
                SimpleNamespace(Id=uuid4(), WordIndex=0, Text="Bé", BoundingBox=[0.1, 0.2, 0.1, 0.05], LineIndex=0),
            ]
        )
        page = SimpleNamespace(
            Id=page_id,
            BookId=book_id,
            PageNumber=1,
            Width=800,
            Height=1200,
            ImagePath="books/cat/p1.png",
            CurrentVerifiedRevisionId=rev_id,
        )
        revision = SimpleNamespace(Id=rev_id, VerificationStatus="VERIFIED", VerifiedText="Bé", ProcessingMeta={})
        svc = ReadingContentService(repo)

        # Catalog book: single batched call for [page_image, illustration], then cache hit on 2nd call
        with (
            patch("app.services.reading_content_service.is_local_storage_enabled", return_value=False),
            patch(
                "app.services.storage_service.create_signed_image_urls",
                side_effect=lambda paths, **_kw: [f"https://cdn.example.com/{p}?sig=cat" for p in paths],
            ) as sign_mock,
        ):
            dto1 = await svc._build_page_dto(page, revision, book_is_private=False)
            dto2 = await svc._build_page_dto(page, revision, book_is_private=False)
        self.assertEqual(dto1.image_url, "https://cdn.example.com/books/cat/p1.png?sig=cat")
        self.assertEqual(dto1.illustration_url, "https://cdn.example.com/studio/illustrations/catalog/ill-1.webp?sig=cat")
        self.assertEqual(dto2.illustration_url, dto1.illustration_url)
        sign_mock.assert_called_once()

        clear_signed_url_cache()

        # Private book: ALWAYS keeps /studio/assets/{id}/media and private_page_image_url, ZERO catalog signing
        priv_owner_id = uuid4()
        priv_page = SimpleNamespace(
            Id=page_id,
            BookId=book_id,
            PageNumber=1,
            Width=800,
            Height=1200,
            ImagePath=f"private-books/{priv_owner_id}/{book_id}/p1.png",
            CurrentVerifiedRevisionId=rev_id,
        )
        with (
            patch("app.services.reading_content_service.is_local_storage_enabled", return_value=False),
            patch("app.services.storage_service.create_signed_image_urls") as sign_never,
        ):
            priv_dto = await svc._build_page_dto(
                priv_page, revision, book_is_private=True, owner_parent_id=priv_owner_id,
            )
        self.assertEqual(priv_dto.illustration_url, f"/studio/assets/{ill_id}/media")
        self.assertIn(f"/books/my-books/{book_id}/pages/{page_id}/image", priv_dto.image_url or "")
        sign_never.assert_not_called()

        # Independent fallback: if illustration path fails validation/signing, image_url still succeeds
        clear_signed_url_cache()
        bad_ill = SimpleNamespace(Id=ill_id, StoragePath="https://user:pass@bad.example/x.webp")
        db.scalar = AsyncMock(return_value=bad_ill)
        with (
            patch("app.services.reading_content_service.is_local_storage_enabled", return_value=False),
            patch(
                "app.services.storage_service.create_signed_image_urls",
                side_effect=lambda paths, **_kw: [f"https://cdn.example.com/{p}?sig=ok" for p in paths],
            ),
        ):
            partial_dto = await svc._build_page_dto(page, revision, book_is_private=False)
        self.assertEqual(partial_dto.image_url, "https://cdn.example.com/books/cat/p1.png?sig=ok")
        self.assertEqual(partial_dto.illustration_url, f"/studio/assets/{ill_id}/media")


class M2CatalogCoversAndStudioMediaTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self) -> None:
        clear_signed_url_cache()

    def tearDown(self) -> None:
        clear_signed_url_cache()

    async def test_catalog_list_signs_catalog_only_normalizes_crops_and_protects_private(self) -> None:
        cat_book_id = uuid4()
        priv_book_id = uuid4()
        cat_crop_id = uuid4()
        cat_ai_id = uuid4()
        priv_cover_id = uuid4()

        cat_book = _ExpiringProxy(
            Id=cat_book_id,
            Title="Sách Công Khai",
            Author="Tác giả",
            MinGrade=1,
            MaxGrade=3,
            LifecycleStatus="ACTIVE",
            VisibilityScope="CATALOG",
            OwnerParentId=None,
        )
        priv_book = _ExpiringProxy(
            Id=priv_book_id,
            Title="Sách Riêng",
            Author="Ba Mẹ",
            MinGrade=1,
            MaxGrade=2,
            LifecycleStatus="ACTIVE",
            VisibilityScope="PARENT_PRIVATE",
            OwnerParentId=uuid4(),
        )
        assets = [
            SimpleNamespace(
                Id=cat_ai_id,
                BookId=cat_book_id,
                SourceType="AI_GENERATED",
                StoragePath="studio/covers/catalog/ai.webp",
            ),
            SimpleNamespace(
                Id=cat_crop_id,
                BookId=cat_book_id,
                SourceType="ENHANCED_CROP",
                StoragePath="studio/covers/catalog/crop.webp",
            ),
            SimpleNamespace(
                Id=priv_cover_id,
                BookId=priv_book_id,
                SourceType="USER_UPLOAD",
                StoragePath="studio/covers/private/owner/secret.webp",
            ),
        ]

        class _NestedCtx:
            async def __aenter__(self):
                return self

            async def __aexit__(self, *_a):
                return False

        class _ScalarRows:
            def all(self):
                return assets

        async def _rollback():
            cat_book.expire()
            priv_book.expire()

        db = MagicMock()
        db.begin_nested = MagicMock(return_value=_NestedCtx())
        db.scalars = AsyncMock(return_value=_ScalarRows())
        db.rollback = AsyncMock(side_effect=_rollback)

        repo = MagicMock()
        repo.db = db
        repo.list = AsyncMock(return_value=[cat_book, priv_book])

        with (
            patch("app.services.book_service.is_local_storage_enabled", return_value=False),
            patch(
                "app.services.storage_service.create_signed_image_urls",
                side_effect=lambda paths, **_kw: [f"https://cdn.example.com/{p}?sig=1" for p in paths],
            ) as sign_mock,
        ):
            items = await CatalogService(repository=repo).list(
                None, None, None, actor_id=uuid4(), include_private=True
            )

        by_id = {item.id: item for item in items}
        # Catalog ENHANCED_CROP beats AI_GENERATED, normalizes to USER_UPLOAD, and uses direct signed URL
        self.assertEqual(by_id[cat_book_id].cover_url, "https://cdn.example.com/studio/covers/catalog/crop.webp?sig=1")
        self.assertEqual(by_id[cat_book_id].cover_source_type, "USER_UPLOAD")
        # PARENT_PRIVATE NEVER gets a direct signed URL
        self.assertEqual(by_id[priv_book_id].cover_url, f"/studio/assets/{priv_cover_id}/media")
        self.assertEqual(by_id[priv_book_id].cover_source_type, "USER_UPLOAD")
        sign_mock.assert_called_once_with(
            ["studio/covers/catalog/crop.webp"], bucket_name=None, max_workers=8, ttl_seconds=3600
        )

        # When local storage is enabled, catalog falls back gracefully to /studio/assets/{id}/media
        cat_book2 = SimpleNamespace(
            Id=cat_book_id, Title="Sách", Author=None, MinGrade=1, MaxGrade=2,
            LifecycleStatus="ACTIVE", VisibilityScope="CATALOG", OwnerParentId=None,
        )
        repo.list = AsyncMock(return_value=[cat_book2])
        with patch("app.services.book_service.is_local_storage_enabled", return_value=True):
            local_items = await CatalogService(repository=repo).list(None, None, None)
        self.assertEqual(local_items[0].cover_url, f"/studio/assets/{cat_crop_id}/media")

    async def test_stream_studio_asset_media_304_etag_joined_query_and_auth_before_304(self) -> None:
        actor_id = uuid4()
        asset_id = uuid4()
        book_id = uuid4()
        etag_hash = "ab" * 32

        cat_book = SimpleNamespace(
            Id=book_id,
            VisibilityScope="CATALOG",
            OwnerParentId=None,
            LifecycleStatus="ACTIVE",
            ModerationStatus="ACTIVE",
            IsDeleted=False,
        )
        cat_asset = SimpleNamespace(
            Id=asset_id,
            BookId=book_id,
            AssetRole="COVER",
            IsActive=True,
            ModerationStatus="APPROVED",
            TextFreeVerified=True,
            StoragePath="studio/covers/catalog/c.webp",
            MimeType="image/webp",
            AssetHash=etag_hash,
        )

        class _NestedCtx:
            async def __aenter__(self):
                return self

            async def __aexit__(self, *_a):
                return False

        class _ExecResult:
            def __init__(self, row):
                self._row = row

            def first(self):
                return self._row

        db = MagicMock()
        db.begin_nested = MagicMock(return_value=_NestedCtx())
        db.scalar = AsyncMock(side_effect=["parent", book_id])
        db.execute = AsyncMock(return_value=_ExecResult((cat_asset, cat_book)))
        db.rollback = AsyncMock()

        app = FastAPI()
        app.include_router(book_assets_route.router, prefix="/studio")
        app.dependency_overrides[get_current_parent_id] = lambda: actor_id

        async def _db_override():
            yield db

        app.dependency_overrides[get_db] = _db_override

        with patch(
            "app.services.book_cover_service.download_object_async",
            AsyncMock(return_value=b"WEBP_BYTES"),
        ) as dl_async:
            async with httpx.AsyncClient(
                transport=httpx.ASGITransport(app=app),
                base_url="http://testserver",
            ) as client:
                # 1. Cache miss -> 200 with ETag & private max-age=1200
                r200 = await client.get(f"/studio/assets/{asset_id}/media")
                self.assertEqual(r200.status_code, 200)
                self.assertEqual(r200.content, b"WEBP_BYTES")
                self.assertEqual(r200.headers.get("etag"), f'"{etag_hash}"')
                self.assertIn("max-age=1200", r200.headers.get("cache-control", ""))
                dl_async.assert_awaited_once()
                # Joined asset+book query ran via single execute
                db.execute.assert_awaited_once()

                # 2. Matching If-None-Match (with W/ prefix in list) -> 304 and ZERO Storage download
                db.scalar = AsyncMock(side_effect=["parent", book_id])
                db.execute = AsyncMock(return_value=_ExecResult((cat_asset, cat_book)))
                r304 = await client.get(
                    f"/studio/assets/{asset_id}/media",
                    headers={"If-None-Match": f'"other", W/"{etag_hash}"'},
                )
                self.assertEqual(r304.status_code, 304)
                self.assertEqual(r304.content, b"")
                dl_async.assert_awaited_once()

                # 3. Unauthorized actor with If-None-Match: "*" still gets 403/404, NEVER 304!
                priv_book = SimpleNamespace(
                    Id=book_id,
                    VisibilityScope="PARENT_PRIVATE",
                    OwnerParentId=uuid4(),
                    LifecycleStatus="ACTIVE",
                    ModerationStatus="ACTIVE",
                    IsDeleted=False,
                )
                db.scalar = AsyncMock(return_value="parent")
                db.execute = AsyncMock(return_value=_ExecResult((cat_asset, priv_book)))
                r_idor = await client.get(
                    f"/studio/assets/{asset_id}/media",
                    headers={"If-None-Match": "*"},
                )
                self.assertEqual(r_idor.status_code, 404)

    async def test_extract_cover_from_page_releases_db_and_offloads_io_and_cpu(self) -> None:
        book_id = uuid4()
        page_id = uuid4()
        owner_id = uuid4()
        events: list[str] = []

        book = _ExpiringProxy(
            Id=book_id,
            VisibilityScope="PARENT_PRIVATE",
            OwnerParentId=owner_id,
            LifecycleStatus="ACTIVE",
            ModerationStatus="ACTIVE",
            IsDeleted=False,
        )
        page = _ExpiringProxy(
            Id=page_id,
            BookId=book_id,
            PageNumber=2,
            ImagePath="private-books/owner/book/p2.png",
        )

        async def _rollback():
            events.append("rollback")
            book.expire()
            page.expire()

        async def _dl_async(path: str, *, bucket_name: str | None = None):
            events.append(f"dl_async:{bucket_name}:{path}")
            return _png_bytes()

        def _upload(path: str, data: bytes, content_type: str, **_kw):
            events.append(f"upload:{path}")

        db = MagicMock()
        db.rollback = AsyncMock(side_effect=_rollback)
        db.commit = AsyncMock()
        svc = BookCoverService(db)
        svc.authorize_book_write = AsyncMock(return_value=(book, "parent"))
        svc.repo = MagicMock()
        svc.repo.get_page = AsyncMock(return_value=page)
        svc.repo.mark_inflight_cover_jobs_stale = AsyncMock(return_value=0)
        svc.repo.has_active_user_uploaded_cover = AsyncMock(return_value=False)
        now = datetime.now(timezone.utc)
        created_asset = SimpleNamespace(
            Id=uuid4(),
            BookId=book_id,
            BookPageId=None,
            SourceRevisionId=None,
            AssetRole="COVER",
            SourceType="ENHANCED_CROP",
            StoragePath="studio/covers/private/x.webp",
            MimeType="image/webp",
            Width=900,
            Height=1200,
            SizeBytes=1024,
            AssetHash="f" * 64,
            AssetVersion=1,
            IsActive=True,
            TextFreeVerified=True,
            ModerationStatus="APPROVED",
            ProviderName="opencv_local",
            ModelId="cover-page-crop-v2",
            JobId=None,
            MetadataJson={},
            CreatedAt=now,
            UpdatedAt=now,
        )
        svc.repo.create_cover_asset = AsyncMock(return_value=created_asset)

        with (
            patch("app.services.book_cover_service.download_object_async", side_effect=_dl_async),
            patch("app.services.book_cover_service.upload_object", side_effect=_upload),
        ):
            dto = await svc.extract_cover_from_page(
                book_id, page_id, owner_id, apply_clahe_restore=True
            )

        self.assertEqual(dto.source_type, "ENHANCED_CROP")
        self.assertEqual(events[0], "rollback")
        self.assertTrue(events[1].startswith("dl_async:"))
        self.assertTrue(events[2].startswith("upload:"))


class M2BoundedScanCameraMatchAndEligibilityTests(unittest.IsolatedAsyncioTestCase):
    async def test_local_ocr_scan_repository_selects_9_scalars_with_bounds_and_prefilter(self) -> None:
        b_id, p_id, r_id = uuid4(), uuid4(), uuid4()
        res_mock = MagicMock()
        res_mock.all.return_value = [
            (b_id, "Mèo Con", p_id, 1, 800, 1200, r_id, "Con mèo trèo cây cau", "Con mèo")
        ]
        db = MagicMock()
        db.execute = AsyncMock(return_value=res_mock)

        repo = LocalOcrScanRepository(db)
        rows = await repo.eligible_verified_pages(
            book_id=None,
            ocr_tokens=["mèo", "100%", "cây_cau"],
        )
        stmt = db.execute.await_args.args[0]
        compiled = stmt.compile(dialect=postgresql.dialect())
        sql = str(compiled)

        self.assertEqual(stmt._limit_clause.value, MAX_GLOBAL_OCR_SCAN_CANDIDATES)
        self.assertIn("ILIKE", sql.upper())
        self.assertIn("visibility_scope", sql.lower())
        # Escaped LIKE parameters
        self.assertIn("%100\\%%", compiled.params.values())
        self.assertIn("%cây\\_cau%", compiled.params.values())
        # Lightweight row projections
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0][0].Title, "Mèo Con")
        self.assertEqual(rows[0][1].PageNumber, 1)
        self.assertEqual(rows[0][2].VerifiedText, "Con mèo trèo cây cau")

        # Book-scoped bound
        await repo.eligible_verified_pages(book_id=b_id)
        stmt_book = db.execute.await_args.args[0]
        self.assertEqual(stmt_book._limit_clause.value, MAX_BOOK_OCR_SCAN_CANDIDATES)

    async def test_local_ocr_scan_service_forwards_ocr_tokens_when_book_id_none(self) -> None:
        repo = MagicMock()
        repo.eligible_verified_pages = AsyncMock(return_value=[])
        svc = LocalOcrScanService(repo)
        res = await svc._build_scan_response(
            ocr_result={
                "text": "Con mèo trèo cây cau!",
                "words": [
                    {"word_index": 0, "line_index": 0, "text": "Con", "bbox": [0.1, 0.1, 0.1, 0.05]},
                ],
                "metadata": {"engine": "mock"},
            },
            scan_job_id=uuid4(),
            request_id="req-m2-ocr-tokens",
            idempotency_key=None,
            book_id=None,
            elapsed_ms=15,
        )
        self.assertFalse(res.matched)
        repo.eligible_verified_pages.assert_awaited_once_with(
            book_id=None,
            ocr_tokens=["con", "mèo", "trèo", "cây", "cau"],
        )

    async def test_reading_camera_match_async_download_and_drops_unextractable_bytes(self) -> None:
        with patch(
            "app.api.routes.reading.download_object_async",
            AsyncMock(return_value=b"ASYNC_IMG"),
        ) as dl_async:
            out = await reading_route._fetch_stored_page_bytes("books/b1/p1.png")
        self.assertEqual(out, b"ASYNC_IMG")
        dl_async.assert_awaited_once_with("books/b1/p1.png", bucket_name=None)

        page_bad = SimpleNamespace(Id=uuid4(), ImagePath="books/b1/bad.png")
        book_cat = SimpleNamespace(VisibilityScope="CATALOG")
        fake_matcher = MagicMock()
        fake_matcher.get_cached_features.return_value = None
        fake_matcher.compute_and_cache_features.return_value = None

        with (
            patch.object(reading_route, "vision_page_matcher", fake_matcher),
            patch.object(reading_route, "_fetch_stored_page_bytes", AsyncMock(return_value=b"RAW_BYTES")),
        ):
            cands = await reading_route._build_match_candidates([(page_bad, book_cat)])
        self.assertEqual(cands, [])

    def test_catalog_eligible_book_sqlite_execution_semantics(self) -> None:
        compiled = str(
            select(Book.Id).where(CatalogRepository.eligible_book()).compile(dialect=postgresql.dialect())
        ).lower()
        self.assertIn("coalesce((select auditlogs.action", compiled)
        self.assertEqual(compiled.count("from auditlogs"), 1)
        self.assertIn("pagerevisions.verificationstatus =", compiled)
        self.assertEqual(compiled.count("from pagerevisions"), 0)
        self.assertTrue(callable(CatalogRepository.current_page_revision_verified))

        engine = create_engine("sqlite:///:memory:")
        with engine.begin() as conn:
            conn.execute(text("""
                CREATE TABLE books (
                    id TEXT PRIMARY KEY,
                    name TEXT NOT NULL,
                    title TEXT NOT NULL,
                    author TEXT,
                    mingrade INTEGER NOT NULL,
                    maxgrade INTEGER NOT NULL,
                    lifecyclestatus TEXT NOT NULL,
                    visibility_scope TEXT NOT NULL,
                    owner_parent_id TEXT,
                    moderation_status TEXT NOT NULL DEFAULT 'ACTIVE',
                    is_deleted BOOLEAN NOT NULL DEFAULT 0,
                    deleted_at TEXT,
                    deleted_by TEXT,
                    createdby TEXT NOT NULL,
                    createdat TEXT NOT NULL
                )
            """))
            conn.execute(text("""
                CREATE TABLE bookpages (
                    id TEXT PRIMARY KEY,
                    bookid TEXT NOT NULL,
                    pagenumber INTEGER NOT NULL,
                    imagepath TEXT NOT NULL,
                    featurepath TEXT,
                    width INTEGER NOT NULL,
                    height INTEGER NOT NULL,
                    processingmeta JSON,
                    lifecyclestatus TEXT NOT NULL,
                    currentverifiedrevisionid TEXT,
                    createdat TEXT NOT NULL
                )
            """))
            conn.execute(text("""
                CREATE TABLE pagerevisions (
                    id TEXT PRIMARY KEY,
                    pageid TEXT NOT NULL,
                    revisionno TEXT NOT NULL,
                    verificationstatus TEXT NOT NULL,
                    originalocrtext TEXT,
                    drafttext TEXT,
                    verifiedtext TEXT,
                    contenthash TEXT,
                    processingmeta JSON,
                    verifiedby TEXT,
                    verifiedat TEXT,
                    createdat TEXT NOT NULL
                )
            """))
            conn.execute(text("""
                CREATE TABLE adminaiworkflows (
                    id TEXT PRIMARY KEY,
                    bookid TEXT NOT NULL,
                    pageid TEXT NOT NULL,
                    pagerevisionid TEXT NOT NULL,
                    status TEXT NOT NULL,
                    stage TEXT NOT NULL DEFAULT 'READY_FOR_ADMIN_REVIEW',
                    totalchunks INTEGER NOT NULL DEFAULT 1,
                    completedchunks INTEGER NOT NULL DEFAULT 1,
                    candidatehash TEXT NOT NULL,
                    ocrprocessedat TEXT,
                    ocrapprovedat TEXT,
                    ocrapprovedby TEXT,
                    ocrsource TEXT,
                    proofreadstatus TEXT,
                    proofreadsummary TEXT,
                    proofreadmodel TEXT,
                    proofreadat TEXT,
                    safetystatus TEXT,
                    suitability TEXT,
                    findings JSON NOT NULL,
                    safetyreason TEXT,
                    safetysummary TEXT,
                    safetyinputhash TEXT,
                    safetyconfirmedat TEXT,
                    safetyconfirmedby TEXT,
                    finalapprovedtexthash TEXT,
                    imagesafetystatus TEXT,
                    imagesafetysummary TEXT,
                    imagesafetycheckedat TEXT,
                    imagesafetyflaggedby TEXT,
                    lastmodel TEXT,
                    lasterror TEXT,
                    createdat TEXT NOT NULL,
                    updatedat TEXT NOT NULL
                )
            """))
            conn.execute(text("""
                CREATE TABLE auditlogs (
                    id TEXT PRIMARY KEY,
                    actorid TEXT NOT NULL,
                    action TEXT NOT NULL,
                    resourcetype TEXT NOT NULL,
                    resourceid TEXT NOT NULL,
                    payload JSON,
                    createdat TEXT NOT NULL
                )
            """))

        admin_id = str(uuid4())
        parent_id = str(uuid4())
        now_iso = "2026-11-20T09:00:00+00:00"
        b_ok, b_rej, b_rec, b_unverified, b_private = (
            str(uuid4()), str(uuid4()), str(uuid4()), str(uuid4()), str(uuid4())
        )

        with Session(engine) as session:
            for bid, title, scope in [
                (b_ok, "OK No Audit", "CATALOG"),
                (b_rej, "Explicitly Rejected", "CATALOG"),
                (b_rec, "Recovered After Rejection", "CATALOG"),
                (b_unverified, "Unverified Page", "CATALOG"),
                (b_private, "Private Scope", "PARENT_PRIVATE"),
            ]:
                session.execute(
                    text("""
                        INSERT INTO books (id, name, title, mingrade, maxgrade, lifecyclestatus, visibility_scope, owner_parent_id, is_deleted, createdby, createdat)
                        VALUES (:id, :name, :title, 1, 3, 'ACTIVE', :scope, :owner, 0, :admin_id, :now_iso)
                    """),
                    {
                        "id": bid,
                        "name": title,
                        "title": title,
                        "scope": scope,
                        "owner": parent_id if scope == "PARENT_PRIVATE" else None,
                        "admin_id": admin_id,
                        "now_iso": now_iso,
                    },
                )
            for bid, ver in [(b_ok, "VERIFIED"), (b_rej, "VERIFIED"), (b_rec, "VERIFIED"), (b_unverified, "NEEDS_REVIEW"), (b_private, "VERIFIED")]:
                pid, rid, wf_id = str(uuid4()), str(uuid4()), str(uuid4())
                chash = "h" * 64
                session.execute(
                    text("""
                        INSERT INTO bookpages (id, bookid, pagenumber, imagepath, width, height, lifecyclestatus, currentverifiedrevisionid, createdat)
                        VALUES (:pid, :bid, 1, 'books/p1.png', 800, 1000, 'ACTIVE', :rid, :now_iso)
                    """),
                    {"pid": pid, "bid": bid, "rid": rid, "now_iso": now_iso},
                )
                session.execute(
                    text("""
                        INSERT INTO pagerevisions (id, pageid, revisionno, verificationstatus, verifiedtext, contenthash, processingmeta, createdat)
                        VALUES (:rid, :pid, '1', :ver, 'Xin chào', :chash, :meta, :now_iso)
                    """),
                    {
                        "rid": rid,
                        "pid": pid,
                        "ver": ver,
                        "chash": chash,
                        "meta": f'{{"admin_ai_workflow": {{"workflow_id": "{wf_id}", "candidate_hash": "{chash}", "safety_input_hash": "{chash}"}}}}',
                        "now_iso": now_iso,
                    },
                )
                session.execute(
                    text("""
                        INSERT INTO adminaiworkflows (id, bookid, pageid, pagerevisionid, status, candidatehash, safetyinputhash, finalapprovedtexthash, safetystatus, safetyconfirmedby, safetyconfirmedat, ocrapprovedby, ocrapprovedat, suitability, findings, createdat, updatedat)
                        VALUES (:wf_id, :bid, :pid, :rid, 'READY_FOR_ADMIN_REVIEW', :chash, :chash, :chash, 'CONFIRMED', :admin_id, :now_iso, :admin_id, :now_iso, 'SUITABLE', '[]', :now_iso, :now_iso)
                    """),
                    {"wf_id": wf_id, "bid": bid, "pid": pid, "rid": rid, "chash": chash, "admin_id": admin_id, "now_iso": now_iso},
                )

            for aid, act, rid, ts in [
                (str(uuid4()), "book.children.rejected", b_rej, "2026-11-20T10:00:00+00:00"),
                (str(uuid4()), "book.children.rejected", b_rec, "2026-11-20T10:00:00+00:00"),
                (str(uuid4()), "book.children.approved", b_rec, "2026-11-20T11:00:00+00:00"),
            ]:
                session.execute(
                    text("""
                        INSERT INTO auditlogs (id, actorid, action, resourcetype, resourceid, createdat)
                        VALUES (:id, :actor_id, :action, 'book', :resource_id, :created_at)
                    """),
                    {"id": aid, "actor_id": admin_id, "action": act, "resource_id": rid, "created_at": ts},
                )
            session.commit()

            eligible_ids = {
                str(row_id)
                for row_id in session.scalars(select(Book.Id).where(CatalogRepository.eligible_book())).all()
            }
            self.assertEqual(eligible_ids, {b_ok, b_rec})

        engine.dispose()
