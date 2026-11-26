"""Wave 1 #4 unit regression tests: Private Book / Child-Safety / Moderation Isolation.

Fully offline (no PostgreSQL or Supabase network calls required). Verifies every
hardening invariant across:
- BookCoverService (`authorize_book_read`, `authorize_book_write`, `get_authorized_asset_media`)
- BookStyleBibleService (`build_for_actor`)
- ParentPrivateBookService (`read_owner_submission_image`, `admin_decide_submission`, `admin_suspend_book`)
- ParentFlow2ContributionService (`admin_read_candidate_crop_image`)
- BookContentQualityRepository (`book`) & BookContentQualityService (`_report_detail_response`, report endpoints)
"""
from __future__ import annotations

import inspect
import os
import unittest
from datetime import datetime, timedelta, timezone
from io import BytesIO
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock, patch
from uuid import UUID, uuid4

os.environ["APP_ENVIRONMENT"] = "test"
os.environ.setdefault("DATABASE_URL", "postgresql+asyncpg://test:test@127.0.0.1:1/test")
os.environ.setdefault("SUPABASE_URL", "https://example.supabase.co")
os.environ.setdefault("SUPABASE_KEY", "isolated-test-key")
os.environ.setdefault("SUPABASE_STORAGE_BUCKET", "viread-test-catalog")
os.environ.setdefault("SUPABASE_PRIVATE_BOOKS_BUCKET", "viread-test-private")

from fastapi import HTTPException
from PIL import Image
from sqlalchemy.dialects import postgresql
from sqlalchemy.exc import IntegrityError, MissingGreenlet

from app.repositories.book_content_quality_repository import BookContentQualityRepository
from app.repositories.book_repository import CatalogRepository
from app.schemas.book_content_quality import (
    BookContentReportCreate,
    BookContentReportStatusUpdate,
)
from app.schemas.parent_private_book import (
    AdminSuspendPrivateBookRequest,
    AdminUserBookDecisionRequest,
)
from app.services.book_content_quality_service import BookContentQualityService
from app.services.book_cover_service import BookCoverService
from app.services.book_style_bible import BookStyleBibleService
from app.services.parent_flow2_contribution_service import ParentFlow2ContributionService
from app.services.parent_private_book_service import ParentPrivateBookService

ADMIN_ID = UUID("11111111-1111-4111-8111-111111111111")
PARENT_A_ID = UUID("22222222-2222-4222-8222-222222222222")
PARENT_B_ID = UUID("33333333-3333-4333-8333-333333333333")
CATALOG_BOOK_ID = UUID("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa")
PRIVATE_BOOK_ID = UUID("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb")
ASSET_ID = UUID("cccccccc-cccc-4ccc-8ccc-cccccccccccc")
SUBMISSION_ID = UUID("dddddddd-dddd-4ddd-8ddd-dddddddddddd")
CANDIDATE_ID = UUID("eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee")
PAGE_ID = UUID("12121212-1212-4121-8121-121212121212")
REVISION_ID = UUID("34343434-3434-4343-8343-343434343434")
REPORT_ID = UUID("56565656-5656-4565-8565-565656565656")
SCAN_ID = UUID("78787878-7878-4787-8787-787878787878")


def _png_bytes(size: tuple[int, int] = (200, 120), color: tuple[int, int, int] = (240, 200, 120)) -> bytes:
    buf = BytesIO()
    Image.new("RGB", size, color).save(buf, format="PNG")
    return buf.getvalue()


class _ExpiringOrmProxy:
    """Simulates a SQLAlchemy ORM instance whose attributes raise MissingGreenlet once expired."""

    def __init__(self, **attrs: object) -> None:
        object.__setattr__(self, "_attrs", dict(attrs))
        object.__setattr__(self, "_expired", False)

    def expire(self) -> None:
        object.__setattr__(self, "_expired", True)

    def __getattr__(self, name: str) -> object:
        if object.__getattribute__(self, "_expired"):
            raise MissingGreenlet(f"Attribute '{name}' accessed after DB session release")
        attrs = object.__getattribute__(self, "_attrs")
        if name not in attrs:
            raise AttributeError(name)
        return attrs[name]


def _make_book(
    *,
    book_id: UUID = PRIVATE_BOOK_ID,
    visibility_scope: str = "PARENT_PRIVATE",
    owner_parent_id: UUID | None = PARENT_A_ID,
    lifecycle_status: str = "ACTIVE",
    moderation_status: str = "ACTIVE",
    is_deleted: bool = False,
) -> SimpleNamespace:
    return SimpleNamespace(
        Id=book_id,
        Name="Sách kiểm thử",
        Title="Truyện thiếu nhi kiểm thử",
        Author="Tác giả",
        MinGrade=1,
        MaxGrade=3,
        LifecycleStatus=lifecycle_status,
        VisibilityScope=visibility_scope,
        OwnerParentId=owner_parent_id,
        ModerationStatus=moderation_status,
        IsDeleted=is_deleted,
        SuspendedAt=None,
        SuspendedBy=None,
        SuspendedReason=None,
        CreatedAt=datetime(2026, 11, 20, tzinfo=timezone.utc),
    )


def _make_submission(
    *,
    sub_id: UUID | None = None,
    book_id: UUID = PRIVATE_BOOK_ID,
    owner_parent_id: UUID = PARENT_A_ID,
    workflow_status: str = "PENDING_ADMIN",
    submission_version: int = 1,
    lock_version: int = 1,
    candidate_hash: str = "a" * 64,
    approved_by: UUID | None = None,
    admin_decision: str | None = None,
    worker_id: str | None = None,
    lease_expires_at: datetime | None = None,
    retry_after: datetime | None = None,
) -> SimpleNamespace:
    now = datetime(2026, 11, 25, tzinfo=timezone.utc)
    return SimpleNamespace(
        Id=sub_id or uuid4(),
        BookId=book_id,
        OwnerParentId=owner_parent_id,
        SourceStoragePath=f"private-books/{owner_parent_id}/{book_id}/staging/p1.png",
        SourceSha256="b" * 64,
        SourceFileName="p1.png",
        SourceFormat="PNG",
        SourcePageNumber=1,
        BatchId=uuid4(),
        BatchTotalPages=1,
        ImageWidth=800,
        ImageHeight=1000,
        SubmissionVersion=submission_version,
        OptimisticLockVersion=lock_version,
        CandidateHash=candidate_hash,
        OcrText="Mèo con đi học.",
        ProofreadText="Mèo con đi học.",
        CandidateText="Mèo con đi học.",
        ToolCheckStatus="FLAGGED",
        ToolCheckSuitability="REVIEW_REQUIRED",
        ToolCheckPolicyBlocked=False,
        SourceType="SELF_AUTHORED",
        SourceNote="Gia đình tự viết",
        WorkflowStatus=workflow_status,
        ApprovedSnapshotHash=candidate_hash if approved_by else None,
        ApprovedSubmissionVersion=submission_version if approved_by else None,
        ApprovedBy=approved_by,
        ApprovedAt=now if approved_by else None,
        AdminDecision=admin_decision,
        AdminDecisionReason=None,
        WorkerId=worker_id,
        LeaseExpiresAt=lease_expires_at,
        RetryAfter=retry_after,
        CreatedAt=now,
        UpdatedAt=now,
    )


class FixABookCoverServiceIsolationTests(unittest.IsolatedAsyncioTestCase):
    """Fix A: BookCoverService private/catalog authorization, text-free gate, and DB release before download."""

    def _build_service(self, *, role: str, book: object, asset: object = None, eligible_scalar: object = CATALOG_BOOK_ID):
        db = SimpleNamespace(
            scalar=AsyncMock(return_value=eligible_scalar),
            commit=AsyncMock(),
            rollback=AsyncMock(),
            flush=AsyncMock(),
        )
        svc = BookCoverService(db)  # type: ignore[arg-type]
        svc.repo = SimpleNamespace(
            get_actor_role=AsyncMock(return_value=role),
            get_book=AsyncMock(return_value=book),
            get_asset_by_id=AsyncMock(return_value=(asset, False)),
        )
        return svc, db

    async def test_authorize_book_read_private_enforces_owner_lifecycle_moderation_and_deleted(self):
        # Active owner succeeds
        ok_book = _make_book()
        svc, _ = self._build_service(role="parent", book=ok_book)
        book, role = await svc.authorize_book_read(PARENT_A_ID, PRIVATE_BOOK_ID)
        self.assertIs(book, ok_book)
        self.assertEqual(role, "parent")

        # Parent B -> 404
        with self.assertRaises(HTTPException) as ctx:
            await svc.authorize_book_read(PARENT_B_ID, PRIVATE_BOOK_ID)
        self.assertEqual(ctx.exception.status_code, 404)

        # Suspended private book -> 403 for owner, allowed for admin
        suspended_book = _make_book(moderation_status="SUSPENDED")
        svc_susp, _ = self._build_service(role="parent", book=suspended_book)
        with self.assertRaises(HTTPException) as ctx:
            await svc_susp.authorize_book_read(PARENT_A_ID, PRIVATE_BOOK_ID)
        self.assertEqual(ctx.exception.status_code, 403)

        svc_admin, _ = self._build_service(role="admin", book=suspended_book)
        adm_book, adm_role = await svc_admin.authorize_book_read(ADMIN_ID, PRIVATE_BOOK_ID)
        self.assertIs(adm_book, suspended_book)
        self.assertEqual(adm_role, "admin")

        # Retired private book -> 403 for owner
        retired_book = _make_book(lifecycle_status="RETIRED")
        svc_ret, _ = self._build_service(role="parent", book=retired_book)
        with self.assertRaises(HTTPException) as ctx:
            await svc_ret.authorize_book_read(PARENT_A_ID, PRIVATE_BOOK_ID)
        self.assertEqual(ctx.exception.status_code, 403)

        # Soft-deleted private book -> 404 for owner
        deleted_book = _make_book(is_deleted=True)
        svc_del, _ = self._build_service(role="parent", book=deleted_book)
        with self.assertRaises(HTTPException) as ctx:
            await svc_del.authorize_book_read(PARENT_A_ID, PRIVATE_BOOK_ID)
        self.assertEqual(ctx.exception.status_code, 404)

    async def test_authorize_book_write_private_enforces_lifecycle_deleted_and_suspended(self):
        # Retired private book -> 403 even if active moderation
        retired_book = _make_book(lifecycle_status="RETIRED")
        svc_ret, _ = self._build_service(role="parent", book=retired_book)
        with self.assertRaises(HTTPException) as ctx:
            await svc_ret.authorize_book_write(PARENT_A_ID, PRIVATE_BOOK_ID)
        self.assertEqual(ctx.exception.status_code, 403)

        svc_ret_admin, _ = self._build_service(role="admin", book=retired_book)
        with self.assertRaises(HTTPException) as ctx:
            await svc_ret_admin.authorize_book_write(ADMIN_ID, PRIVATE_BOOK_ID)
        self.assertEqual(ctx.exception.status_code, 403)

        # Deleted private book -> 404
        deleted_book = _make_book(is_deleted=True)
        svc_del, _ = self._build_service(role="parent", book=deleted_book)
        with self.assertRaises(HTTPException) as ctx:
            await svc_del.authorize_book_write(PARENT_A_ID, PRIVATE_BOOK_ID)
        self.assertEqual(ctx.exception.status_code, 404)

        # Suspended private book -> 403 for owner
        susp_book = _make_book(moderation_status="SUSPENDED")
        svc_susp, _ = self._build_service(role="parent", book=susp_book)
        with self.assertRaises(HTTPException) as ctx:
            await svc_susp.authorize_book_write(PARENT_A_ID, PRIVATE_BOOK_ID)
        self.assertEqual(ctx.exception.status_code, 403)

    async def test_catalog_book_enforces_catalog_repository_is_eligible_for_parents(self):
        cat_book = _make_book(
            book_id=CATALOG_BOOK_ID,
            visibility_scope="CATALOG",
            owner_parent_id=None,
            lifecycle_status="ACTIVE",
        )
        asset = SimpleNamespace(
            Id=ASSET_ID,
            BookId=CATALOG_BOOK_ID,
            AssetRole="COVER",
            IsActive=True,
            ModerationStatus="APPROVED",
            TextFreeVerified=True,
            StoragePath="studio/covers/catalog/c.webp",
            MimeType="image/webp",
        )
        # Ineligible (e.g., unverified/unapproved) catalog book -> db.scalar returns None -> 403 for parent
        svc_ineligible, db = self._build_service(
            role="parent", book=cat_book, asset=asset, eligible_scalar=None
        )
        with self.assertRaises(HTTPException) as read_err:
            await svc_ineligible.authorize_book_read(PARENT_A_ID, CATALOG_BOOK_ID)
        self.assertEqual(read_err.exception.status_code, 403)
        self.assertGreaterEqual(db.scalar.await_count, 1)

        with patch("app.services.book_cover_service.download_object") as dl_mock:
            with self.assertRaises(HTTPException) as media_err:
                await svc_ineligible.get_authorized_asset_media(PARENT_A_ID, ASSET_ID)
            self.assertEqual(media_err.exception.status_code, 403)
            dl_mock.assert_not_called()

        # Admin bypasses eligibility gate for moderation/review
        svc_admin, _ = self._build_service(
            role="admin", book=cat_book, asset=asset, eligible_scalar=None
        )
        adm_book, adm_role = await svc_admin.authorize_book_read(ADMIN_ID, CATALOG_BOOK_ID)
        self.assertIs(adm_book, cat_book)
        self.assertEqual(adm_role, "admin")

        # Eligible catalog book -> parent allowed
        svc_ok, _ = self._build_service(
            role="parent", book=cat_book, asset=asset, eligible_scalar=CATALOG_BOOK_ID
        )
        with patch("app.services.book_cover_service.download_object", return_value=b"WEBPBYTES"):
            content, mime, is_priv = await svc_ok.get_authorized_asset_media(PARENT_A_ID, ASSET_ID)
        self.assertEqual(content, b"WEBPBYTES")
        self.assertEqual(mime, "image/webp")
        self.assertFalse(is_priv)

    async def test_get_authorized_asset_media_blocks_unverified_page_illustration_and_suspended_private(self):
        cat_book = _make_book(
            book_id=CATALOG_BOOK_ID,
            visibility_scope="CATALOG",
            owner_parent_id=None,
        )
        unverified_ill = SimpleNamespace(
            Id=ASSET_ID,
            BookId=CATALOG_BOOK_ID,
            AssetRole="PAGE_ILLUSTRATION",
            IsActive=True,
            ModerationStatus="APPROVED",
            TextFreeVerified=False,
            StoragePath="studio/illustrations/catalog/i.webp",
            MimeType="image/webp",
        )
        svc_parent, _ = self._build_service(
            role="parent", book=cat_book, asset=unverified_ill, eligible_scalar=CATALOG_BOOK_ID
        )
        with self.assertRaises(HTTPException) as ctx:
            await svc_parent.get_authorized_asset_media(PARENT_A_ID, ASSET_ID)
        self.assertEqual(ctx.exception.status_code, 403)

        # Admin CAN inspect unverified page illustration
        svc_admin, _ = self._build_service(
            role="admin", book=cat_book, asset=unverified_ill, eligible_scalar=None
        )
        with patch("app.services.book_cover_service.download_object", return_value=b"ADMINBYTES"):
            content, _, _ = await svc_admin.get_authorized_asset_media(ADMIN_ID, ASSET_ID)
        self.assertEqual(content, b"ADMINBYTES")

        # Owner on SUSPENDED private book cover -> 403
        priv_susp = _make_book(moderation_status="SUSPENDED")
        priv_cover = SimpleNamespace(
            Id=ASSET_ID,
            BookId=PRIVATE_BOOK_ID,
            AssetRole="COVER",
            IsActive=True,
            ModerationStatus="APPROVED",
            TextFreeVerified=True,
            StoragePath="studio/covers/private/a.webp",
            MimeType="image/webp",
        )
        svc_priv_susp, _ = self._build_service(role="parent", book=priv_susp, asset=priv_cover)
        with self.assertRaises(HTTPException) as ctx:
            await svc_priv_susp.get_authorized_asset_media(PARENT_A_ID, ASSET_ID)
        self.assertEqual(ctx.exception.status_code, 403)

    async def test_get_authorized_asset_media_releases_db_before_download_without_touching_orm(self):
        events: list[str] = []
        priv_book = _ExpiringOrmProxy(
            Id=PRIVATE_BOOK_ID,
            VisibilityScope="PARENT_PRIVATE",
            OwnerParentId=PARENT_A_ID,
            LifecycleStatus="ACTIVE",
            ModerationStatus="ACTIVE",
            IsDeleted=False,
        )
        asset = _ExpiringOrmProxy(
            Id=ASSET_ID,
            BookId=PRIVATE_BOOK_ID,
            AssetRole="COVER",
            IsActive=True,
            ModerationStatus="APPROVED",
            TextFreeVerified=True,
            StoragePath="studio/covers/private/ok.webp",
            MimeType="image/webp",
        )

        async def _rollback():
            events.append("rollback")
            priv_book.expire()
            asset.expire()

        def _download(path: str, *, bucket_name: str):
            events.append(f"download:{bucket_name}:{path}")
            return b"OK_WEBP"

        db = SimpleNamespace(rollback=AsyncMock(side_effect=_rollback))
        svc = BookCoverService(db)  # type: ignore[arg-type]
        svc.repo = SimpleNamespace(
            get_actor_role=AsyncMock(return_value="parent"),
            get_book=AsyncMock(return_value=priv_book),
            get_asset_by_id=AsyncMock(return_value=(asset, False)),
        )
        with patch("app.services.book_cover_service.download_object", side_effect=_download):
            content, mime, is_priv = await svc.get_authorized_asset_media(PARENT_A_ID, ASSET_ID)

        self.assertEqual(content, b"OK_WEBP")
        self.assertEqual(mime, "image/webp")
        self.assertTrue(is_priv)
        self.assertEqual(events[0], "rollback")
        self.assertTrue(events[1].startswith("download:"))


class FixBBookStyleBibleIsolationTests(unittest.IsolatedAsyncioTestCase):
    """Fix B: BookStyleBibleService.build_for_actor private book lifecycle/moderation/deleted checks."""

    def _service(self, *, role: str, book: object):
        db = SimpleNamespace(commit=AsyncMock(), rollback=AsyncMock())
        svc = BookStyleBibleService(db)  # type: ignore[arg-type]
        svc.repo = SimpleNamespace(
            get_actor_role=AsyncMock(return_value=role),
            get_book=AsyncMock(return_value=book),
            list_book_sample_texts=AsyncMock(return_value=["Mèo con đi học."]),
            get_style_bible=AsyncMock(return_value=(None, False)),
            upsert_style_bible=AsyncMock(return_value=(None, False)),
        )
        return svc

    async def test_build_for_actor_blocks_suspended_retired_deleted_and_other_parent_private_books(self):
        # Suspended private book -> 403 for owner, allowed for admin
        susp_book = _make_book(moderation_status="SUSPENDED")
        with self.assertRaises(HTTPException) as ctx:
            await self._service(role="parent", book=susp_book).build_for_actor(PARENT_A_ID, PRIVATE_BOOK_ID)
        self.assertEqual(ctx.exception.status_code, 403)

        adm_res = await self._service(role="admin", book=susp_book).build_for_actor(ADMIN_ID, PRIVATE_BOOK_ID)
        self.assertEqual(adm_res.book_id, PRIVATE_BOOK_ID)

        # Retired private book -> 403 for owner
        ret_book = _make_book(lifecycle_status="RETIRED")
        with self.assertRaises(HTTPException) as ctx:
            await self._service(role="parent", book=ret_book).build_for_actor(PARENT_A_ID, PRIVATE_BOOK_ID)
        self.assertEqual(ctx.exception.status_code, 403)

        # Deleted private book -> 404
        del_book = _make_book(is_deleted=True)
        with self.assertRaises(HTTPException) as ctx:
            await self._service(role="parent", book=del_book).build_for_actor(PARENT_A_ID, PRIVATE_BOOK_ID)
        self.assertEqual(ctx.exception.status_code, 404)

        # Wrong owner -> 404
        active_book = _make_book()
        with self.assertRaises(HTTPException) as ctx:
            await self._service(role="parent", book=active_book).build_for_actor(PARENT_B_ID, PRIVATE_BOOK_ID)
        self.assertEqual(ctx.exception.status_code, 404)

        # Active owner -> 200
        ok_res = await self._service(role="parent", book=active_book).build_for_actor(PARENT_A_ID, PRIVATE_BOOK_ID)
        self.assertEqual(ok_res.book_id, PRIVATE_BOOK_ID)


class FixCParentPrivateBookServiceTests(unittest.IsolatedAsyncioTestCase):
    """Fix C: read_owner_submission_image + admin_decide_submission scope & shared suspension."""

    async def test_read_owner_submission_image_enforces_book_state_cancelled_and_releases_db_first(self):
        # 1) Missing book -> 404
        svc = ParentPrivateBookService(SimpleNamespace())  # type: ignore[arg-type]
        svc._require_parent = AsyncMock()
        svc.repo = SimpleNamespace(
            get_owned_private_book=AsyncMock(return_value=None),
            get_owned_submission=AsyncMock(),
            rollback=AsyncMock(),
        )
        with self.assertRaises(HTTPException) as ctx:
            await svc.read_owner_submission_image(PARENT_A_ID, PRIVATE_BOOK_ID, SUBMISSION_ID)
        self.assertEqual(ctx.exception.status_code, 404)
        svc.repo.get_owned_submission.assert_not_awaited()

        # 2) Suspended book -> 403 (matching read_owner_page_image)
        svc.repo.get_owned_private_book = AsyncMock(return_value=_make_book(moderation_status="SUSPENDED"))
        with self.assertRaises(HTTPException) as ctx:
            await svc.read_owner_submission_image(PARENT_A_ID, PRIVATE_BOOK_ID, SUBMISSION_ID)
        self.assertEqual(ctx.exception.status_code, 403)

        # 3) Inactive (RETIRED) book -> 403
        svc.repo.get_owned_private_book = AsyncMock(return_value=_make_book(lifecycle_status="RETIRED"))
        with self.assertRaises(HTTPException) as ctx:
            await svc.read_owner_submission_image(PARENT_A_ID, PRIVATE_BOOK_ID, SUBMISSION_ID)
        self.assertEqual(ctx.exception.status_code, 403)

        # 4) Soft-deleted book -> 404
        svc.repo.get_owned_private_book = AsyncMock(return_value=_make_book(is_deleted=True))
        with self.assertRaises(HTTPException) as ctx:
            await svc.read_owner_submission_image(PARENT_A_ID, PRIVATE_BOOK_ID, SUBMISSION_ID)
        self.assertEqual(ctx.exception.status_code, 404)

        # 5) Cancelled submission -> 404
        svc.repo.get_owned_private_book = AsyncMock(return_value=_make_book())
        svc.repo.get_owned_submission = AsyncMock(return_value=_make_submission(workflow_status="CANCELLED"))
        with self.assertRaises(HTTPException) as ctx:
            await svc.read_owner_submission_image(PARENT_A_ID, PRIVATE_BOOK_ID, SUBMISSION_ID)
        self.assertEqual(ctx.exception.status_code, 404)

        # 6) Valid active book + submission -> rollback BEFORE download_object, no ORM access after rollback
        events: list[str] = []
        expiring_sub = _ExpiringOrmProxy(
            Id=SUBMISSION_ID,
            WorkflowStatus="CHECKING",
            SourceStoragePath=f"private-books/{PARENT_A_ID}/{PRIVATE_BOOK_ID}/staging/p1.png",
        )

        async def _rollback():
            events.append("rollback")
            expiring_sub.expire()

        def _download(path: str, *, bucket_name: str):
            events.append(f"download:{bucket_name}:{path}")
            return b"PNGDATA"

        svc.repo.get_owned_submission = AsyncMock(return_value=expiring_sub)
        svc.repo.rollback = AsyncMock(side_effect=_rollback)
        with patch("app.services.parent_private_book_service.download_object", side_effect=_download):
            data, mime = await svc.read_owner_submission_image(PARENT_A_ID, PRIVATE_BOOK_ID, SUBMISSION_ID)
        self.assertEqual(data, b"PNGDATA")
        self.assertEqual(mime, "image/png")
        self.assertEqual(events[0], "rollback")
        self.assertTrue(events[1].startswith("download:"))

    async def test_admin_decide_submission_enforces_moderation_scope_without_existence_leak(self):
        book = _make_book()
        for clean_status in ("CHECKING", "PASSED_READY_TO_ADD", "ADDED_TO_BOOK"):
            with self.subTest(workflow_status=clean_status):
                clean_sub = _make_submission(
                    sub_id=SUBMISSION_ID,
                    workflow_status=clean_status,
                    approved_by=None,
                    admin_decision=None,
                )
                svc = ParentPrivateBookService(SimpleNamespace(refresh=AsyncMock()))  # type: ignore[arg-type]
                svc._require_admin = AsyncMock()
                svc.repo = SimpleNamespace(
                    get_submission=AsyncMock(return_value=clean_sub),
                    get_private_book=AsyncMock(return_value=book),
                    list_moderation_history=AsyncMock(return_value=[]),
                )
                payload = AdminUserBookDecisionRequest(
                    decision="SUSPEND",
                    reason="Thử truy cập bản sạch chưa gửi kiểm duyệt.",
                    expected_submission_version=999,  # Wrong lock/version must STILL return 404, not 409!
                    expected_snapshot_hash="wrong-hash",
                    expected_lock_version=999,
                )
                with self.assertRaises(HTTPException) as ctx:
                    await svc.admin_decide_submission(ADMIN_ID, SUBMISSION_ID, payload)
                self.assertEqual(ctx.exception.status_code, 404)

    async def test_admin_decide_submission_suspend_runs_full_book_suspension_routine(self):
        now = datetime.now(timezone.utc)
        book = _make_book()
        target_sub = _make_submission(
            sub_id=SUBMISSION_ID,
            workflow_status="PENDING_ADMIN",
            worker_id="worker-target",
            lease_expires_at=now + timedelta(minutes=5),
            retry_after=now + timedelta(minutes=1),
        )
        sibling_checking = _make_submission(
            workflow_status="CHECKING",
            worker_id="worker-sib-1",
            lease_expires_at=now + timedelta(minutes=5),
            retry_after=now + timedelta(minutes=2),
        )
        sibling_approved = _make_submission(
            workflow_status="APPROVED_READY_TO_ADD",
            approved_by=ADMIN_ID,
            admin_decision="APPROVE",
        )
        sibling_committed = _make_submission(
            workflow_status="ADDED_TO_BOOK",
            approved_by=ADMIN_ID,
            admin_decision="APPROVE",
        )
        sibling_cancelled = _make_submission(workflow_status="CANCELLED")

        open_req = SimpleNamespace(
            Id=uuid4(),
            SubmissionId=target_sub.Id,
            Status="PENDING_ADMIN",
            PreviousStatus=None,
            DecidedBy=None,
            DecidedAt=None,
            DecisionReason=None,
            OptimisticLockVersion=1,
            UpdatedAt=now,
        )

        db = SimpleNamespace(refresh=AsyncMock())
        svc = ParentPrivateBookService(db)  # type: ignore[arg-type]
        svc._require_admin = AsyncMock()
        svc._safe_revoke_flow2_contributions = AsyncMock()
        audit_id = uuid4()
        svc.repo = SimpleNamespace(
            get_submission=AsyncMock(return_value=target_sub),
            get_private_book=AsyncMock(return_value=book),
            list_moderation_history=AsyncMock(return_value=[open_req]),
            get_open_moderation_request=AsyncMock(return_value=open_req),
            list_submissions_for_book=AsyncMock(
                return_value=[
                    target_sub,
                    sibling_checking,
                    sibling_approved,
                    sibling_committed,
                    sibling_cancelled,
                ]
            ),
            suspend_open_moderation_requests_for_book=AsyncMock(),
            add_audit_log=AsyncMock(return_value=SimpleNamespace(Id=audit_id)),
            commit=AsyncMock(),
        )

        payload = AdminUserBookDecisionRequest(
            decision="SUSPEND",
            reason="Nội dung vi phạm an toàn trẻ em nghiêm trọng.",
            expected_submission_version=1,
            expected_snapshot_hash=target_sub.CandidateHash,
            expected_lock_version=1,
        )
        res = await svc.admin_decide_submission(ADMIN_ID, target_sub.Id, payload)

        # Book is suspended
        self.assertEqual(book.ModerationStatus, "SUSPENDED")
        self.assertEqual(book.SuspendedBy, ADMIN_ID)
        self.assertEqual(book.SuspendedReason, payload.reason)
        self.assertEqual(res.book_moderation_status, "SUSPENDED")
        self.assertEqual(res.new_workflow_status, "REJECTED")

        # Target submission: leases cleared, lock version incremented ONCE (not double-incremented!)
        self.assertIsNone(target_sub.WorkerId)
        self.assertIsNone(target_sub.LeaseExpiresAt)
        self.assertIsNone(target_sub.RetryAfter)
        self.assertEqual(target_sub.OptimisticLockVersion, 2)
        self.assertEqual(open_req.Status, "SUSPENDED")
        self.assertEqual(open_req.PreviousStatus, "PENDING_ADMIN")

        # Sibling CHECKING & APPROVED_READY_TO_ADD submissions rejected + leases/approvals cleared
        self.assertEqual(sibling_checking.WorkflowStatus, "REJECTED")
        self.assertEqual(sibling_checking.AdminDecision, "SUSPEND")
        self.assertIsNone(sibling_checking.WorkerId)
        self.assertIsNone(sibling_checking.LeaseExpiresAt)
        self.assertIsNone(sibling_checking.RetryAfter)
        self.assertEqual(sibling_checking.OptimisticLockVersion, 2)

        self.assertEqual(sibling_approved.WorkflowStatus, "REJECTED")
        self.assertIsNone(sibling_approved.ApprovedSnapshotHash)
        self.assertIsNone(sibling_approved.ApprovedBy)
        self.assertEqual(sibling_approved.OptimisticLockVersion, 2)

        # Sibling ADDED_TO_BOOK & CANCELLED retain their terminal WorkflowStatus
        self.assertEqual(sibling_committed.WorkflowStatus, "ADDED_TO_BOOK")
        self.assertIsNone(sibling_committed.ApprovedSnapshotHash)
        self.assertEqual(sibling_cancelled.WorkflowStatus, "CANCELLED")

        # Full suspension hooks invoked
        svc.repo.suspend_open_moderation_requests_for_book.assert_awaited_once()
        svc._safe_revoke_flow2_contributions.assert_awaited_once()
        revoke_kwargs = svc._safe_revoke_flow2_contributions.await_args.kwargs
        self.assertIs(revoke_kwargs["book"], book)
        self.assertEqual(revoke_kwargs["actor_id"], ADMIN_ID)
        self.assertEqual(revoke_kwargs["consent_event_action"], "REVOKE_BOOK_SUSPENDED")
        svc.repo.commit.assert_awaited_once()

    async def test_admin_decide_submission_allows_suspend_on_escalated_committed_submission(self):
        book = _make_book()
        committed_sub = _make_submission(
            sub_id=SUBMISSION_ID,
            workflow_status="ADDED_TO_BOOK",
            approved_by=ADMIN_ID,
            admin_decision="APPROVE",
        )
        history_row = SimpleNamespace(Id=uuid4(), Status="APPROVED")
        svc = ParentPrivateBookService(SimpleNamespace(refresh=AsyncMock()))  # type: ignore[arg-type]
        svc._require_admin = AsyncMock()
        svc._safe_revoke_flow2_contributions = AsyncMock()
        svc.repo = SimpleNamespace(
            get_submission=AsyncMock(return_value=committed_sub),
            get_private_book=AsyncMock(return_value=book),
            list_moderation_history=AsyncMock(return_value=[history_row]),
            get_open_moderation_request=AsyncMock(return_value=None),
            add_moderation_request=AsyncMock(),
            list_submissions_for_book=AsyncMock(return_value=[committed_sub]),
            suspend_open_moderation_requests_for_book=AsyncMock(),
            add_audit_log=AsyncMock(return_value=SimpleNamespace(Id=uuid4())),
            commit=AsyncMock(),
        )
        res = await svc.admin_decide_submission(
            ADMIN_ID,
            committed_sub.Id,
            AdminUserBookDecisionRequest(
                decision="SUSPEND",
                reason="Đình chỉ sách đã xuất bản sau khi rà soát lại.",
                expected_submission_version=1,
                expected_snapshot_hash=committed_sub.CandidateHash,
                expected_lock_version=1,
            ),
        )
        self.assertEqual(res.book_moderation_status, "SUSPENDED")
        self.assertEqual(res.new_workflow_status, "ADDED_TO_BOOK")
        svc._safe_revoke_flow2_contributions.assert_awaited_once()

    async def test_admin_suspend_book_uses_shared_suspension_routine(self):
        book = _make_book()
        sib = _make_submission(workflow_status="PENDING_ADMIN", worker_id="w-1")
        svc = ParentPrivateBookService(SimpleNamespace())  # type: ignore[arg-type]
        svc._require_admin = AsyncMock()
        svc._safe_revoke_flow2_contributions = AsyncMock()
        svc.repo = SimpleNamespace(
            get_private_book=AsyncMock(return_value=book),
            list_submissions_for_book=AsyncMock(return_value=[sib]),
            suspend_open_moderation_requests_for_book=AsyncMock(),
            add_audit_log=AsyncMock(return_value=SimpleNamespace(Id=uuid4())),
            commit=AsyncMock(),
        )
        out = await svc.admin_suspend_book(
            ADMIN_ID,
            book.Id,
            AdminSuspendPrivateBookRequest(reason="Đình chỉ trực tiếp toàn bộ sách."),
        )
        self.assertEqual(out["moderation_status"], "SUSPENDED")
        self.assertEqual(sib.WorkflowStatus, "REJECTED")
        self.assertIsNone(sib.WorkerId)
        svc.repo.suspend_open_moderation_requests_for_book.assert_awaited_once()
        svc._safe_revoke_flow2_contributions.assert_awaited_once()


class FixDFlow2CandidateCropImageSecurityTests(unittest.IsolatedAsyncioTestCase):
    """Fix D: admin_read_candidate_crop_image live book/consent/revoked checks, audit log, commit-before-download."""

    def _service(self, *, cand: object, book: object, consent: object):
        svc = ParentFlow2ContributionService(SimpleNamespace())  # type: ignore[arg-type]
        svc._require_admin = AsyncMock()
        svc.repo = SimpleNamespace(
            get_candidate=AsyncMock(return_value=cand),
            get_private_book=AsyncMock(return_value=book),
            get_consent=AsyncMock(return_value=consent),
            add_audit_log=AsyncMock(return_value=SimpleNamespace(Id=uuid4())),
            commit=AsyncMock(),
        )
        return svc

    def _candidate(self, *, status: str = "PENDING_VERIFICATION", crop_box=None):
        return SimpleNamespace(
            Id=CANDIDATE_ID,
            BookId=PRIVATE_BOOK_ID,
            PageId=PAGE_ID,
            RevisionId=REVISION_ID,
            LineIndex=0,
            Status=status,
            SourceImagePath=f"private-books/{PARENT_A_ID}/{PRIVATE_BOOK_ID}/pages/p1.png",
            CropBoxJson=[10, 10, 120, 60] if crop_box is None else crop_box,
        )

    async def test_rejects_revoked_candidate_inactive_suspended_deleted_book_and_revoked_consent(self):
        active_book = _make_book()
        opted_in = SimpleNamespace(Status="OPTED_IN")

        cases = [
            ("revoked_candidate", self._candidate(status="REVOKED"), active_book, opted_in, 404),
            ("missing_book", self._candidate(), None, opted_in, 404),
            ("deleted_book", self._candidate(), _make_book(is_deleted=True), opted_in, 404),
            ("retired_book", self._candidate(), _make_book(lifecycle_status="RETIRED"), opted_in, 404),
            ("suspended_book", self._candidate(), _make_book(moderation_status="SUSPENDED"), opted_in, 403),
            ("missing_consent", self._candidate(), active_book, None, 403),
            ("opted_out_consent", self._candidate(), active_book, SimpleNamespace(Status="OPTED_OUT"), 403),
            ("revoked_consent", self._candidate(), active_book, SimpleNamespace(Status="REVOKED"), 403),
            ("invalid_crop_box", self._candidate(crop_box=[10, 20]), active_book, opted_in, 409),
        ]
        for label, cand, book, consent, expected_status in cases:
            with self.subTest(case=label):
                svc = self._service(cand=cand, book=book, consent=consent)
                with patch("app.services.parent_flow2_contribution_service.download_object") as dl_mock:
                    with self.assertRaises(HTTPException) as ctx:
                        await svc.admin_read_candidate_crop_image(ADMIN_ID, CANDIDATE_ID)
                    self.assertEqual(ctx.exception.status_code, expected_status)
                    dl_mock.assert_not_called()
                    svc.repo.add_audit_log.assert_not_awaited()

    async def test_records_audit_commits_before_download_and_does_not_touch_orm_after_commit(self):
        events: list[str] = []
        expiring_cand = _ExpiringOrmProxy(
            Id=CANDIDATE_ID,
            BookId=PRIVATE_BOOK_ID,
            PageId=PAGE_ID,
            RevisionId=REVISION_ID,
            LineIndex=2,
            Status="PENDING_VERIFICATION",
            SourceImagePath=f"private-books/{PARENT_A_ID}/{PRIVATE_BOOK_ID}/pages/p1.png",
            CropBoxJson=[10, 20, 110, 70],
        )
        expiring_book = _ExpiringOrmProxy(
            Id=PRIVATE_BOOK_ID,
            LifecycleStatus="ACTIVE",
            ModerationStatus="ACTIVE",
            IsDeleted=False,
        )
        expiring_consent = _ExpiringOrmProxy(Status="OPTED_IN")

        async def _add_audit(**kwargs):
            events.append(f"audit:{kwargs['action']}")
            return SimpleNamespace(Id=uuid4())

        async def _commit():
            events.append("commit")
            expiring_cand.expire()
            expiring_book.expire()
            expiring_consent.expire()

        raw_png = _png_bytes((200, 120))

        def _download(path: str, *, bucket_name: str):
            events.append(f"download:{bucket_name}:{path}")
            return raw_png

        svc = ParentFlow2ContributionService(SimpleNamespace())  # type: ignore[arg-type]
        svc._require_admin = AsyncMock()
        svc.repo = SimpleNamespace(
            get_candidate=AsyncMock(return_value=expiring_cand),
            get_private_book=AsyncMock(return_value=expiring_book),
            get_consent=AsyncMock(return_value=expiring_consent),
            add_audit_log=AsyncMock(side_effect=_add_audit),
            commit=AsyncMock(side_effect=_commit),
        )
        with patch("app.services.parent_flow2_contribution_service.download_object", side_effect=_download):
            png_bytes, mime = await svc.admin_read_candidate_crop_image(ADMIN_ID, CANDIDATE_ID)

        self.assertEqual(mime, "image/png")
        with Image.open(BytesIO(png_bytes)) as cropped:
            self.assertEqual(cropped.size, (100, 50))
        self.assertEqual(events[:2], ["audit:admin.flow2_candidate.crop_viewed", "commit"])
        self.assertTrue(events[2].startswith("download:"))


class FixEBookContentQualityIsolationTests(unittest.IsolatedAsyncioTestCase):
    """Fix E: BookContentQualityRepository.book catalog scope + _report_detail_response fail-closed findings."""

    async def test_repository_book_query_enforces_is_catalog_book_filter(self):
        captured: list = []

        async def _scalar(stmt):
            captured.append(stmt)
            return None

        repo = BookContentQualityRepository(SimpleNamespace(scalar=AsyncMock(side_effect=_scalar)))  # type: ignore[arg-type]
        await repo.book(PRIVATE_BOOK_ID)
        await repo.book(PRIVATE_BOOK_ID, lock=True)

        self.assertEqual(len(captured), 2)
        for idx, stmt in enumerate(captured):
            compiled = stmt.compile(dialect=postgresql.dialect())
            sql = str(compiled)
            self.assertIn("books.visibility_scope", sql)
            self.assertIn("CATALOG", compiled.params.values())
            if idx == 1:
                self.assertIn("FOR UPDATE", sql)

    def _report_row(self, *, status: str = "OPEN"):
        now = datetime(2026, 11, 25, tzinfo=timezone.utc)
        return SimpleNamespace(
            Id=REPORT_ID,
            ReporterId=PARENT_A_ID,
            ReporterNameSnapshot="Phụ huynh A",
            BookId=CATALOG_BOOK_ID,
            BookTitleSnapshot="Sách mẫu",
            PageId=None,
            PageNumberSnapshot=None,
            PageRevisionId=None,
            VerifiedTextSnapshot=None,
            ContentHashSnapshot=None,
            IssueType="SPELLING_ERROR",
            Description="Báo lỗi chính tả trên trang.",
            ReportedText="trời mua",
            SuggestedCorrection="trời mưa",
            ScanRunId=SCAN_ID,
            Status=status,
            AdminResolutionNote=None,
            ReviewedBy=None,
            ReviewedByNameSnapshot=None,
            ResolvedAt=None,
            CreatedAt=now,
            UpdatedAt=now,
        )

    def _internal_finding(self):
        now = datetime(2026, 11, 25, tzinfo=timezone.utc)
        return SimpleNamespace(
            Id=uuid4(),
            PageScanId=uuid4(),
            BookId=CATALOG_BOOK_ID,
            PageId=PAGE_ID,
            PageRevisionId=REVISION_ID,
            IssueType="SPELLING_SUSPECTED",
            Severity="MEDIUM",
            OriginalExcerpt="trời mua",
            ExcerptStart=0,
            ExcerptEnd=8,
            SuggestedCorrection="trời mưa",
            Explanation="Internal AI explanation not for parents",
            DetectionSource="OLLAMA_TEXT",
            ModelName="qwen3-vl",
            Confidence=0.88,
            Status="NEEDS_REVIEW",
            ReviewNote="Internal reviewer note",
            CreatedAt=now,
        )

    async def test_report_detail_response_defaults_to_false_and_parent_paths_exclude_internal_findings(self):
        # 1) Signature default MUST be False (fail-closed)
        sig = inspect.signature(BookContentQualityService._report_detail_response)
        self.assertIs(sig.parameters["include_internal_findings"].default, False)

        report = self._report_row()
        finding = self._internal_finding()
        profile = SimpleNamespace(Id=PARENT_A_ID, Role="parent", Active=1, DisplayName="Phụ huynh A")
        catalog_book = _make_book(
            book_id=CATALOG_BOOK_ID, visibility_scope="CATALOG", owner_parent_id=None
        )
        payload = BookContentReportCreate(
            idempotency_key=uuid4(),
            issue_type="SPELLING_ERROR",
            description="Phát hiện lỗi chính tả trong sách.",
            reported_text="trời mua",
            suggested_correction="trời mưa",
        )

        # Direct call without kwarg -> must NOT query findings_for_report
        repo_default = SimpleNamespace(findings_for_report=AsyncMock(return_value=[(finding, 1)]))
        svc_default = BookContentQualityService(repo_default)  # type: ignore[arg-type]
        res_default = await svc_default._report_detail_response(report, "Phụ huynh A", [])
        self.assertEqual(res_default.related_findings, [])
        repo_default.findings_for_report.assert_not_awaited()

        # 2) create_parent_report path 1: pre-insert idempotent replay
        repo_idem = SimpleNamespace(
            profile_for_update=AsyncMock(return_value=profile),
            report_by_idempotency_key=AsyncMock(return_value=report),
            report_detail=AsyncMock(return_value=(report, "Phụ huynh A")),
            report_history=AsyncMock(return_value=[]),
            findings_for_report=AsyncMock(return_value=[(finding, 1)]),
        )
        res_idem = await BookContentQualityService(repo_idem).create_parent_report(  # type: ignore[arg-type]
            PARENT_A_ID, CATALOG_BOOK_ID, payload
        )
        self.assertEqual(res_idem.related_findings, [])
        repo_idem.findings_for_report.assert_not_awaited()

        # 3) create_parent_report path 2: normal create
        created_report_holder: list = []

        async def _add_report(r):
            r.CreatedAt = datetime(2026, 11, 25, tzinfo=timezone.utc)
            r.UpdatedAt = r.CreatedAt
            created_report_holder.append(r)

        repo_create = SimpleNamespace(
            profile_for_update=AsyncMock(return_value=profile),
            report_by_idempotency_key=AsyncMock(return_value=None),
            count_recent_reports=AsyncMock(return_value=0),
            book=AsyncMock(return_value=catalog_book),
            active_scan_for_book=AsyncMock(return_value=SimpleNamespace(Id=SCAN_ID)),
            add_scan_run=AsyncMock(),
            add_report=AsyncMock(side_effect=_add_report),
            add_report_history=AsyncMock(),
            link_existing_findings_to_report=AsyncMock(),
            refresh=AsyncMock(),
            report_history=AsyncMock(return_value=[]),
            report_detail=AsyncMock(side_effect=lambda _rid: (created_report_holder[0], "Phụ huynh A")),
            commit=AsyncMock(),
            rollback=AsyncMock(),
            findings_for_report=AsyncMock(return_value=[(finding, 1)]),
        )
        res_created = await BookContentQualityService(repo_create).create_parent_report(  # type: ignore[arg-type]
            PARENT_A_ID, CATALOG_BOOK_ID, payload
        )
        self.assertEqual(res_created.related_findings, [])
        repo_create.findings_for_report.assert_not_awaited()

        # 4) create_parent_report path 3: concurrent IntegrityError idempotency conflict replay
        class _DupIdemPgErr(Exception):
            sqlstate = "23505"
            constraint_name = "uq_bookcontentreports_reporter_idempotency"

        dup_exc = IntegrityError("INSERT", {}, _DupIdemPgErr("duplicate"))
        repo_conflict = SimpleNamespace(
            profile_for_update=AsyncMock(return_value=profile),
            report_by_idempotency_key=AsyncMock(side_effect=[None, report]),
            count_recent_reports=AsyncMock(return_value=0),
            book=AsyncMock(return_value=catalog_book),
            active_scan_for_book=AsyncMock(return_value=SimpleNamespace(Id=SCAN_ID)),
            add_scan_run=AsyncMock(),
            add_report=AsyncMock(side_effect=dup_exc),
            add_report_history=AsyncMock(),
            rollback=AsyncMock(),
            report_detail=AsyncMock(return_value=(report, "Phụ huynh A")),
            report_history=AsyncMock(return_value=[]),
            findings_for_report=AsyncMock(return_value=[(finding, 1)]),
        )
        res_conflict = await BookContentQualityService(repo_conflict).create_parent_report(  # type: ignore[arg-type]
            PARENT_A_ID, CATALOG_BOOK_ID, payload
        )
        self.assertEqual(res_conflict.related_findings, [])
        repo_conflict.findings_for_report.assert_not_awaited()

        # 5) Admin endpoints (`get_admin_report`, `update_report_status` no-op & transition) DO include internal findings
        db_admin = SimpleNamespace(
            add=MagicMock(),
            commit=AsyncMock(),
            refresh=AsyncMock(),
            rollback=AsyncMock(),
        )
        repo_admin = SimpleNamespace(
            db=db_admin,
            role=AsyncMock(return_value="admin"),
            profile_name=AsyncMock(return_value="Admin QA"),
            report=AsyncMock(return_value=report),
            report_detail=AsyncMock(return_value=(report, "Phụ huynh A")),
            report_history=AsyncMock(return_value=[]),
            findings_for_report=AsyncMock(return_value=[(finding, 3)]),
        )
        svc_admin = BookContentQualityService(repo_admin)  # type: ignore[arg-type]

        adm_detail = await svc_admin.get_admin_report(ADMIN_ID, REPORT_ID)
        self.assertEqual(len(adm_detail.related_findings), 1)
        self.assertEqual(adm_detail.related_findings[0].page_number, 3)

        adm_noop = await svc_admin.update_report_status(
            ADMIN_ID, REPORT_ID, BookContentReportStatusUpdate(status="OPEN")
        )
        self.assertEqual(len(adm_noop.related_findings), 1)

        adm_moved = await svc_admin.update_report_status(
            ADMIN_ID,
            REPORT_ID,
            BookContentReportStatusUpdate(status="UNDER_REVIEW", resolution_note="Đang kiểm tra."),
        )
        self.assertEqual(len(adm_moved.related_findings), 1)
        self.assertEqual(repo_admin.findings_for_report.await_count, 3)


if __name__ == "__main__":
    unittest.main()
