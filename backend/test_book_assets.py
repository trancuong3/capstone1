"""Comprehensive tests for Book Cover Studio, Book Style Bible & OpenCV Text-Free Illustration Pipeline.

Compatible with BOTH `unittest` and `pytest`. Runs fully offline using real Pillow, OpenCV,
FastAPI ASGITransport, and isolated temporary local storage (zero external network or secrets).
"""
from __future__ import annotations

import os
import tempfile
import unittest
from datetime import datetime, timezone
from io import BytesIO
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch
from uuid import UUID, uuid4

os.environ["APP_ENVIRONMENT"] = "test"
os.environ.setdefault("DATABASE_URL", "postgresql+asyncpg://test:test@127.0.0.1:1/test")
os.environ.setdefault("SUPABASE_URL", "https://example.supabase.co")
os.environ.setdefault("SUPABASE_KEY", "isolated-test-key")
os.environ.setdefault("SUPABASE_STORAGE_BUCKET", "viread-test-catalog")
os.environ.setdefault("SUPABASE_PRIVATE_BOOKS_BUCKET", "viread-test-private")

import cv2
import httpx
import numpy as np
from fastapi import FastAPI, HTTPException
from PIL import Image, ImageDraw
from sqlalchemy.exc import ProgrammingError

from app.api.deps import get_current_parent_id, get_db
from app.api.routes import book_assets as book_assets_route
from app.models import Book, BookPage, BookPresentationAsset, BookStyleBible, SmartStudioJob
from app.repositories.book_assets_repository import BookAssetsRepository
from app.schemas.book_assets import (
    BookCoverGenerateRequest,
    PageIllustrationExtractRequest,
)
from app.services.book_cover_service import (
    MAX_COVER_UPLOAD_BYTES,
    MAX_OUTPUT_WEBP_BYTES,
    BookCoverService,
    ImageProviderAvailability,
    build_metadata_cover_fallback,
    detect_magic_image_format,
    validate_and_process_cover_image,
)
from app.services.book_illustration_service import (
    BookIllustrationService,
    extract_clean_illustration_from_bytes,
    verify_illustration_text_free,
)
from app.services.book_style_bible import (
    BookStyleBibleService,
    analyze_book_style_deterministic,
    compute_style_context_hash,
)

ADMIN_ID = UUID("11111111-1111-4111-8111-111111111111")
PARENT_A_ID = UUID("22222222-2222-4222-8222-222222222222")
PARENT_B_ID = UUID("33333333-3333-4333-8333-333333333333")
CATALOG_BOOK_ID = UUID("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa")
RETIRED_CATALOG_BOOK_ID = UUID("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaab")
PRIVATE_BOOK_A_ID = UUID("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb")
PAGE_A_ID = UUID("cccccccc-cccc-4ccc-8ccc-cccccccccccc")
REVISION_A_ID = UUID("dddddddd-dddd-4ddd-8ddd-dddddddddddd")


def _make_image_bytes(fmt: str = "PNG", size: tuple[int, int] = (900, 1200), color=(240, 180, 90)) -> bytes:
    img = Image.new("RGB", size, color)
    draw = ImageDraw.Draw(img)
    draw.rectangle((40, 40, size[0] - 40, size[1] // 2), fill=(72, 169, 166))
    draw.ellipse((size[0] // 4, size[1] // 4, size[0] * 3 // 4, size[1] * 3 // 4), fill=(244, 162, 97))
    buf = BytesIO()
    img.save(buf, format=fmt)
    return buf.getvalue()


def _make_storybook_page_png() -> tuple[bytes, list[list[float]], str]:
    """Synthetic storybook page: rich colorful illustration on top 52%, crisp story text on bottom 35%."""
    w, h = 800, 1000
    canvas = np.full((h, w, 3), 252, dtype=np.uint8)  # warm white paper

    # Top illustration frame (y: 60..540, x: 80..720 -> ~38% of page area, colorful & clean, ZERO text)
    cv2.rectangle(canvas, (80, 60), (720, 340), (245, 205, 130), -1)  # blue sky (BGR)
    cv2.rectangle(canvas, (80, 340), (720, 540), (95, 185, 110), -1)  # green meadow
    cv2.circle(canvas, (620, 145), 55, (75, 215, 250), -1)  # bright yellow sun
    cv2.circle(canvas, (210, 160), 42, (250, 250, 250), -1)  # soft cloud
    cv2.circle(canvas, (255, 155), 50, (250, 250, 250), -1)
    cv2.circle(canvas, (300, 165), 38, (250, 250, 250), -1)
    # Cozy red-roof cottage
    cv2.rectangle(canvas, (300, 290), (470, 460), (165, 215, 245), -1)
    roof = np.array([[280, 295], [385, 205], [490, 295]], dtype=np.int32)
    cv2.fillPoly(canvas, [roof], (60, 85, 220))
    cv2.rectangle(canvas, (365, 375), (410, 460), (50, 95, 150), -1)
    # Friendly tree
    cv2.rectangle(canvas, (150, 340), (185, 470), (55, 90, 130), -1)
    cv2.circle(canvas, (168, 315), 58, (60, 150, 70), -1)

    # Bottom printed story text lines (y: 630..880)
    lines = [
        "Ngay xua co chu meo nho song trong vuon hoa.",
        "Sang nao chu cung ra san don anh nang mai.",
        "Chu meo vui ve choi dua cung cac ban nho.",
    ]
    word_bboxes: list[list[float]] = []
    for idx, line in enumerate(lines):
        y = 665 + idx * 72
        cv2.putText(canvas, line, (70, y), cv2.FONT_HERSHEY_SIMPLEX, 0.85, (25, 25, 25), 2, cv2.LINE_AA)
        words = line.split(" ")
        x_cursor = 70
        for word in words:
            ww = max(24, len(word) * 15)
            word_bboxes.append([x_cursor / w, (y - 26) / h, ww / w, 34 / h])
            x_cursor += ww + 12

    ok, encoded = cv2.imencode(".png", canvas)
    assert ok
    return encoded.tobytes(), word_bboxes, " ".join(lines)


def _make_text_laden_illustration_bgr() -> np.ndarray:
    """Image heavily covered with crisp horizontal printed text lines (must FAIL text-free gate!)."""
    w, h = 720, 520
    canvas = np.full((h, w, 3), 248, dtype=np.uint8)
    # Faint pastel background tint
    cv2.rectangle(canvas, (20, 20), (700, 500), (225, 238, 248), -1)
    lines = [
        "Chu meo nho buoc ra khu vuon ruc ro anh nang",
        "Nhung bong hoa no vang tuoi ben hang rao go",
        "Me goi be vao an sang truoc khi di hoc som",
        "Be vui ve mang cap sach cung ban den truong",
        "Tieng chim hot liu lo tren canh cay xanh mat",
    ]
    for idx, line in enumerate(lines):
        cv2.putText(
            canvas,
            line,
            (45, 95 + idx * 78),
            cv2.FONT_HERSHEY_SIMPLEX,
            0.82,
            (20, 20, 20),
            2,
            cv2.LINE_AA,
        )
    return canvas


def _make_text_only_page_png() -> bytes:
    """Page with ONLY printed story text and zero illustration artwork."""
    w, h = 800, 1000
    canvas = np.full((h, w, 3), 252, dtype=np.uint8)
    for idx in range(10):
        cv2.putText(
            canvas,
            f"Dong van ban thu {idx + 1} trong trang truyen thieu nhi.",
            (60, 120 + idx * 75),
            cv2.FONT_HERSHEY_SIMPLEX,
            0.8,
            (25, 25, 25),
            2,
            cv2.LINE_AA,
        )
    ok, encoded = cv2.imencode(".png", canvas)
    assert ok
    return encoded.tobytes()


class InMemoryBookAssetsStore:
    """Stateful in-memory store backing BookAssetsRepository methods for isolated unit/API tests."""

    def __init__(self) -> None:
        self.roles: dict[UUID, str] = {
            ADMIN_ID: "admin",
            PARENT_A_ID: "parent",
            PARENT_B_ID: "parent",
        }
        self.books: dict[UUID, Book] = {
            CATALOG_BOOK_ID: Book(
                Id=CATALOG_BOOK_ID,
                Name="Vườn hoa của bé",
                Title="Khu vườn nắng sớm của mèo con",
                Author="Nguyễn Nhật Ánh",
                MinGrade=1,
                MaxGrade=3,
                LifecycleStatus="ACTIVE",
                VisibilityScope="CATALOG",
                OwnerParentId=None,
                ModerationStatus="ACTIVE",
                IsDeleted=False,
            ),
            RETIRED_CATALOG_BOOK_ID: Book(
                Id=RETIRED_CATALOG_BOOK_ID,
                Name="Sách đã ẩn",
                Title="Sách thư viện đã ngừng phát hành",
                Author="Tác giả ẩn",
                MinGrade=2,
                MaxGrade=4,
                LifecycleStatus="RETIRED",
                VisibilityScope="CATALOG",
                OwnerParentId=None,
                ModerationStatus="ACTIVE",
                IsDeleted=False,
            ),
            PRIVATE_BOOK_A_ID: Book(
                Id=PRIVATE_BOOK_A_ID,
                Name="Truyện nhà An",
                Title="Chuyến phiêu lưu của bé An và thỏ trắng",
                Author="Mẹ của An",
                MinGrade=1,
                MaxGrade=2,
                LifecycleStatus="ACTIVE",
                VisibilityScope="PARENT_PRIVATE",
                OwnerParentId=PARENT_A_ID,
                ModerationStatus="ACTIVE",
                IsDeleted=False,
            ),
        }
        self.pages: dict[UUID, BookPage] = {
            PAGE_A_ID: BookPage(
                Id=PAGE_A_ID,
                BookId=PRIVATE_BOOK_A_ID,
                PageNumber=1,
                ImagePath="private/pages/page-1-original.png",
                Width=800,
                Height=1000,
                CurrentVerifiedRevisionId=REVISION_A_ID,
                LifecycleStatus="ACTIVE",
            ),
        }
        self.page_contexts: dict[UUID, tuple[UUID | None, str, list[list[float]]]] = {
            PAGE_A_ID: (REVISION_A_ID, "Ngày xưa có chú mèo nhỏ sống trong vườn hoa.", []),
        }
        self.book_samples: dict[UUID, list[str]] = {
            CATALOG_BOOK_ID: ["Mèo con chạy ra khu vườn ngập nắng sớm và gặp bướm vàng."],
            PRIVATE_BOOK_A_ID: ["Bé An cùng bạn thỏ trắng đi thăm khu rừng xanh tươi."],
        }
        self.assets: dict[UUID, BookPresentationAsset] = {}
        self.style_bibles: dict[UUID, BookStyleBible] = {}
        self.jobs: dict[UUID, SmartStudioJob] = {}
        self.unmigrated_v2 = False

    def make_fake_db(self):
        return SimpleNamespace(
            commit=AsyncMock(),
            rollback=AsyncMock(),
            flush=AsyncMock(),
        )


def _patch_repository_with_store(store: InMemoryBookAssetsStore):
    """Patch BookAssetsRepository methods to execute against InMemoryBookAssetsStore."""

    async def get_actor_role(_self, actor_id: UUID):
        return store.roles.get(actor_id)

    async def get_book(_self, book_id: UUID):
        book = store.books.get(book_id)
        return book if book and not book.IsDeleted else None

    async def get_page(_self, book_id: UUID, page_id: UUID):
        page = store.pages.get(page_id)
        return page if page and page.BookId == book_id else None

    async def get_page_revision_context(_self, page: BookPage):
        return store.page_contexts.get(page.Id, (None, "", []))

    async def list_book_sample_texts(_self, book_id: UUID, *, limit: int = 6):
        return list(store.book_samples.get(book_id, []))[:limit]

    async def get_asset_by_id(_self, asset_id: UUID):
        if store.unmigrated_v2:
            return None, True
        return store.assets.get(asset_id), False

    async def list_active_covers(_self, book_id: UUID):
        if store.unmigrated_v2:
            return [], True
        items = [
            a
            for a in store.assets.values()
            if a.BookId == book_id
            and a.AssetRole == "COVER"
            and a.BookPageId is None
            and a.IsActive
        ]
        items.sort(key=lambda a: (a.AssetVersion or 0, a.UpdatedAt or datetime.min.replace(tzinfo=timezone.utc)), reverse=True)
        return items, False

    async def create_cover_asset(_self, **kwargs):
        if store.unmigrated_v2:
            raise ProgrammingError("SELECT", {}, Exception('relation "book_presentation_assets" does not exist'))
        now = datetime.now(timezone.utc)
        book_id = kwargs["book_id"]
        if kwargs.get("deactivate_existing", True) and kwargs.get("is_active", True):
            for existing in store.assets.values():
                if existing.BookId == book_id and existing.AssetRole == "COVER" and existing.IsActive:
                    existing.IsActive = False
                    existing.UpdatedAt = now
        version = max(
            (a.AssetVersion for a in store.assets.values() if a.BookId == book_id and a.AssetRole == "COVER"),
            default=0,
        ) + 1
        asset = BookPresentationAsset(
            Id=uuid4(),
            BookId=book_id,
            BookPageId=None,
            SourceRevisionId=None,
            OwnerId=kwargs.get("owner_id"),
            AssetRole="COVER",
            SourceType=kwargs["source_type"],
            StoragePath=kwargs["storage_path"],
            MimeType=kwargs["mime_type"],
            Width=kwargs["width"],
            Height=kwargs["height"],
            SizeBytes=kwargs["size_bytes"],
            AssetHash=kwargs["asset_hash"],
            AssetVersion=version,
            IsActive=kwargs.get("is_active", True),
            TextFreeVerified=True,
            ModerationStatus=kwargs.get("moderation_status", "APPROVED"),
            ProviderName=kwargs.get("provider_name"),
            ModelId=kwargs.get("model_id"),
            JobId=kwargs.get("job_id"),
            MetadataJson=dict(kwargs.get("metadata_json") or {}),
            CreatedAt=now,
            UpdatedAt=now,
        )
        store.assets[asset.Id] = asset
        return asset

    async def deactivate_book_covers(_self, book_id: UUID):
        covers, _ = await list_active_covers(_self, book_id)
        now = datetime.now(timezone.utc)
        for c in covers:
            c.IsActive = False
            c.UpdatedAt = now
        return covers

    async def mark_inflight_cover_jobs_stale(_self, book_id: UUID):
        if store.unmigrated_v2:
            return 0
        count = 0
        now = datetime.now(timezone.utc)
        for job in store.jobs.values():
            if (
                job.BookId == book_id
                and job.JobType == "COVER_GENERATE"
                and job.Status in ("QUEUED", "RUNNING", "WAITING_FOR_WORKER", "WAITING_FOR_QUOTA", "RETRY_SCHEDULED")
            ):
                job.Status = "STALE"
                job.Stage = "SUPERSEDED_BY_USER_UPLOAD"
                job.ErrorCode = "SUPERSEDED_BY_USER_UPLOAD"
                job.UpdatedAt = now
                job.CompletedAt = now
                count += 1
        return count

    async def list_page_illustrations(_self, book_id: UUID, *, page_id: UUID | None = None):
        if store.unmigrated_v2:
            return [], True
        items = [
            a
            for a in store.assets.values()
            if a.BookId == book_id
            and a.AssetRole == "PAGE_ILLUSTRATION"
            and a.BookPageId is not None
            and (page_id is None or a.BookPageId == page_id)
        ]
        items.sort(key=lambda a: (bool(a.IsActive), a.AssetVersion or 0), reverse=True)
        return items, False

    async def create_page_illustration_asset(_self, **kwargs):
        now = datetime.now(timezone.utc)
        book_id = kwargs["book_id"]
        page_id = kwargs["book_page_id"]
        if kwargs["is_active"] and kwargs["moderation_status"] == "APPROVED" and kwargs["text_free_verified"]:
            for existing in store.assets.values():
                if (
                    existing.BookId == book_id
                    and existing.BookPageId == page_id
                    and existing.AssetRole == "PAGE_ILLUSTRATION"
                    and existing.IsActive
                ):
                    existing.IsActive = False
                    existing.UpdatedAt = now
        version = max(
            (
                a.AssetVersion
                for a in store.assets.values()
                if a.BookId == book_id and a.BookPageId == page_id and a.AssetRole == "PAGE_ILLUSTRATION"
            ),
            default=0,
        ) + 1
        asset = BookPresentationAsset(
            Id=uuid4(),
            BookId=book_id,
            BookPageId=page_id,
            SourceRevisionId=kwargs.get("source_revision_id"),
            OwnerId=kwargs.get("owner_id"),
            AssetRole="PAGE_ILLUSTRATION",
            SourceType=kwargs["source_type"],
            StoragePath=kwargs["storage_path"],
            MimeType=kwargs["mime_type"],
            Width=kwargs["width"],
            Height=kwargs["height"],
            SizeBytes=kwargs["size_bytes"],
            AssetHash=kwargs["asset_hash"],
            AssetVersion=version,
            IsActive=kwargs["is_active"],
            TextFreeVerified=kwargs["text_free_verified"],
            ModerationStatus=kwargs["moderation_status"],
            ProviderName=kwargs.get("provider_name"),
            ModelId=kwargs.get("model_id"),
            JobId=kwargs.get("job_id"),
            MetadataJson=dict(kwargs.get("metadata_json") or {}),
            CreatedAt=now,
            UpdatedAt=now,
        )
        store.assets[asset.Id] = asset
        return asset

    async def moderate_page_illustration(_self, asset: BookPresentationAsset, *, action: str, reason: str | None = None):
        now = datetime.now(timezone.utc)
        meta = dict(asset.MetadataJson or {})
        if reason:
            meta["moderation_reason"] = reason
        meta["last_moderation_action"] = action
        if action in ("APPROVE", "RESTORE"):
            for other in store.assets.values():
                if (
                    other.BookId == asset.BookId
                    and other.BookPageId == asset.BookPageId
                    and other.AssetRole == "PAGE_ILLUSTRATION"
                    and other.Id != asset.Id
                ):
                    other.IsActive = False
            asset.ModerationStatus = "APPROVED"
            asset.IsActive = True
        elif action == "REJECT":
            asset.ModerationStatus = "REJECTED"
            asset.IsActive = False
        asset.MetadataJson = meta
        asset.UpdatedAt = now
        return asset

    async def get_style_bible(_self, book_id: UUID):
        if store.unmigrated_v2:
            return None, True
        return store.style_bibles.get(book_id), False

    async def upsert_style_bible(_self, **kwargs):
        if store.unmigrated_v2:
            return None, True
        now = datetime.now(timezone.utc)
        bible = BookStyleBible(
            BookId=kwargs["book_id"],
            OwnerId=kwargs.get("owner_id"),
            ContextHash=kwargs["context_hash"],
            BibleJson=dict(kwargs["bible_json"]),
            ProviderName=kwargs.get("provider_name"),
            ModelId=kwargs.get("model_id"),
            UpdatedAt=now,
        )
        store.style_bibles[bible.BookId] = bible
        return bible, False

    async def get_studio_job(_self, job_id: UUID):
        if store.unmigrated_v2:
            return None
        return store.jobs.get(job_id)

    async def record_studio_job(_self, **kwargs):
        if store.unmigrated_v2:
            return None
        for existing in store.jobs.values():
            if existing.ActorId == kwargs["actor_id"] and existing.IdempotencyKey == kwargs["idempotency_key"]:
                return existing
        now = datetime.now(timezone.utc)
        job = SmartStudioJob(
            Id=uuid4(),
            JobType=kwargs["job_type"],
            ActorId=kwargs["actor_id"],
            ActorRole=kwargs["actor_role"],
            BookId=kwargs["book_id"],
            BookPageId=kwargs.get("book_page_id"),
            SourceRevisionId=kwargs.get("source_revision_id"),
            InputHash=kwargs["input_hash"],
            IdempotencyKey=kwargs["idempotency_key"],
            Stage=kwargs["stage"],
            Status=kwargs["status_value"],
            Priority=kwargs.get("priority", 40),
            AttemptCount=1,
            MaxAttempts=3,
            ResultRefJson=dict(kwargs.get("result_ref_json") or {}),
            ErrorCode=kwargs.get("error_code"),
            ErrorMessageVi=kwargs.get("error_message_vi"),
            CreatedAt=now,
            UpdatedAt=now,
        )
        store.jobs[job.Id] = job
        return job

    return patch.multiple(
        BookAssetsRepository,
        get_actor_role=get_actor_role,
        get_book=get_book,
        get_page=get_page,
        get_page_revision_context=get_page_revision_context,
        list_book_sample_texts=list_book_sample_texts,
        get_asset_by_id=get_asset_by_id,
        list_active_covers=list_active_covers,
        create_cover_asset=create_cover_asset,
        deactivate_book_covers=deactivate_book_covers,
        mark_inflight_cover_jobs_stale=mark_inflight_cover_jobs_stale,
        list_page_illustrations=list_page_illustrations,
        create_page_illustration_asset=create_page_illustration_asset,
        moderate_page_illustration=moderate_page_illustration,
        get_style_bible=get_style_bible,
        upsert_style_bible=upsert_style_bible,
        get_studio_job=get_studio_job,
        record_studio_job=record_studio_job,
    )


class CoverValidationSecurityTests(unittest.TestCase):
    """Pure image validation, magic bytes, crop/rotate, WebP budget & decompression bomb tests."""

    def test_accepts_jpeg_png_webp_and_outputs_optimized_3x4_webp_under_300kb(self):
        for fmt, mime in (("JPEG", "image/jpeg"), ("PNG", "image/png"), ("WEBP", "image/webp")):
            with self.subTest(fmt=fmt):
                raw = _make_image_bytes(fmt, size=(1200, 1600))
                processed = validate_and_process_cover_image(raw, mime)
                self.assertEqual(processed.detected_format, fmt)
                self.assertLessEqual(processed.width, 900)
                self.assertLessEqual(processed.height, 1200)
                self.assertLessEqual(processed.size_bytes, MAX_OUTPUT_WEBP_BYTES)
                self.assertEqual(len(processed.asset_hash), 64)
                self.assertEqual(detect_magic_image_format(processed.webp_bytes), "WEBP")

    def test_crop_and_rotation_transforms_dimensions_accurately(self):
        raw = _make_image_bytes("PNG", size=(1200, 600))
        # Rotate 90 degrees -> becomes 600x1200, then crop center half -> 300x600
        processed = validate_and_process_cover_image(
            raw,
            "image/png",
            crop_x=0.25,
            crop_y=0.25,
            crop_w=0.5,
            crop_h=0.5,
            rotation=90,
        )
        self.assertEqual((processed.width, processed.height), (300, 600))

    def test_rejects_svg_xss_html_zip_fake_mime_oversize_and_decompression_bomb(self):
        png_data = _make_image_bytes("PNG", (300, 400))
        jpeg_data = _make_image_bytes("JPEG", (300, 400))
        svg_xss = b'<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'
        html_payload = b"<!DOCTYPE html><html><body>not an image</body></html>"
        zip_payload = b"PK\x03\x04" + b"\x00" * 64
        pdf_payload = b"%PDF-1.7\n1 0 obj\n<<>>\nendobj"

        cases = [
            ("empty", b"", "image/png", 422),
            ("oversize_10mb", b"\x89PNG\r\n\x1a\n" + b"0" * MAX_COVER_UPLOAD_BYTES, "image/png", 413),
            ("svg_xss_as_svg", svg_xss, "image/svg+xml", 422),
            ("svg_xss_fake_png_mime", svg_xss, "image/png", 422),
            ("html_fake_jpeg", html_payload, "image/jpeg", 422),
            ("zip_fake_webp", zip_payload, "image/webp", 422),
            ("pdf_fake_png", pdf_payload, "image/png", 422),
            ("png_bytes_fake_jpeg_mime", png_data, "image/jpeg", 422),
            ("jpeg_bytes_fake_webp_mime", jpeg_data, "image/webp", 422),
            ("corrupted_png_header", b"\x89PNG\r\n\x1a\n" + b"corrupt-bytes-only", "image/png", 422),
        ]
        for label, payload, mime, expected_status in cases:
            with self.subTest(label=label):
                with self.assertRaises(HTTPException) as ctx:
                    validate_and_process_cover_image(payload, mime)
                self.assertEqual(ctx.exception.status_code, expected_status)

        # Decompression bomb (> 25 MP: 6000x5000 = 30 MP solid-color PNG compresses tiny but explodes RAM!)
        bomb_buf = BytesIO()
        Image.new("L", (6000, 5000), 255).save(bomb_buf, format="PNG")
        with self.assertRaises(HTTPException) as ctx:
            validate_and_process_cover_image(bomb_buf.getvalue(), "image/png")
        self.assertEqual(ctx.exception.status_code, 422)

        # Invalid rotation & out-of-range crop
        with self.assertRaises(HTTPException) as ctx:
            validate_and_process_cover_image(png_data, "image/png", rotation=45)
        self.assertEqual(ctx.exception.status_code, 422)
        with self.assertRaises(HTTPException) as ctx:
            validate_and_process_cover_image(
                png_data, "image/png", crop_x=0.8, crop_y=0.1, crop_w=0.4, crop_h=0.4
            )
        self.assertEqual(ctx.exception.status_code, 422)


class OpenCvIllustrationPipelineTests(unittest.TestCase):
    """Pure OpenCV illustration extraction, CLAHE restoration & mandatory text-free gate tests."""

    def test_extracts_clean_artwork_crop_from_storybook_page_and_passes_text_free_gate(self):
        page_png, word_bboxes, canonical_text = _make_storybook_page_png()
        result = extract_clean_illustration_from_bytes(
            page_png,
            word_bboxes=word_bboxes,
            canonical_text=canonical_text,
            apply_clahe_restore=True,
        )
        self.assertEqual(result.status, "EXTRACTED_VERIFIED")
        self.assertTrue(result.verification.text_free_verified)
        self.assertIsNotNone(result.webp_bytes)
        self.assertEqual(detect_magic_image_format(result.webp_bytes or b""), "WEBP")
        self.assertGreaterEqual(result.artwork_area_ratio, 0.12)
        self.assertLess(result.verification.text_density_score, 0.08)
        self.assertLess(result.verification.bbox_overlap_score, 0.05)
        # Cropped box must stay in upper illustration region (y + h <= 0.65), excluding bottom text!
        self.assertIsNotNone(result.crop_bbox_norm)
        crop_y_bottom = result.crop_bbox_norm[1] + result.crop_bbox_norm[3]
        self.assertLessEqual(crop_y_bottom, 0.65)

    def test_text_only_page_returns_no_clean_artwork(self):
        text_only_png = _make_text_only_page_png()
        result = extract_clean_illustration_from_bytes(
            text_only_png,
            word_bboxes=[[0.05, 0.08, 0.9, 0.82]],
            canonical_text="Dòng văn bản trong trang truyện thiếu nhi.",
        )
        self.assertEqual(result.status, "NO_CLEAN_ARTWORK")
        self.assertFalse(result.verification.text_free_verified)
        self.assertIsNone(result.webp_bytes)

    def test_mandatory_text_free_gate_rejects_text_laden_image_and_ocr_overlap(self):
        text_laden = _make_text_laden_illustration_bgr()
        gate_cv = verify_illustration_text_free(text_laden)
        self.assertFalse(gate_cv.text_free_verified)
        self.assertGreaterEqual(gate_cv.text_density_score, 0.08)

        # Even if an image looks colorful/clean visually, OCR duplicate story text triggers REJECTION!
        page_png, word_bboxes, canonical_text = _make_storybook_page_png()
        rejected = extract_clean_illustration_from_bytes(
            page_png,
            word_bboxes=word_bboxes,
            canonical_text=canonical_text,
            ocr_check_fn=lambda _raw: "Ngay xua co chu meo nho song trong vuon hoa",
        )
        self.assertEqual(rejected.status, "REJECTED_CONTAINS_TEXT")
        self.assertFalse(rejected.verification.text_free_verified)
        self.assertGreaterEqual(rejected.verification.ocr_overlap_score, 0.15)


class BookStyleBibleTests(unittest.IsolatedAsyncioTestCase):
    """Style Bible deterministic analyzer, context_hash cache hit/invalidation & private cloud gate."""

    def test_deterministic_vietnamese_style_bible_extracts_all_required_fields(self):
        bible = analyze_book_style_deterministic(
            title="Cây khế và chú chim phượng hoàng",
            author="Dân gian Việt Nam",
            min_grade=1,
            max_grade=3,
            sample_texts=["Ngày xưa có hai anh em sống ở ngôi làng ven sông có cây khế ngọt."],
        )
        self.assertIn("Cổ tích", bible.genre)
        self.assertIn("Lớp 1–3", bible.age_group)
        self.assertGreaterEqual(len(bible.color_palette), 4)
        self.assertTrue(bible.art_style)
        self.assertGreaterEqual(len(bible.characters), 1)
        self.assertGreaterEqual(len(bible.settings), 1)
        self.assertTrue(any("Không chèn" in inv for inv in bible.invariants))

    async def test_style_bible_cache_hit_and_context_hash_invalidation(self):
        store = InMemoryBookAssetsStore()
        db = store.make_fake_db()
        with _patch_repository_with_store(store):
            svc = BookStyleBibleService(db)
            book = store.books[CATALOG_BOOK_ID]

            first = await svc.get_or_build_for_book(book, allow_cloud_refine=False)
            self.assertFalse(first.cache_hit)

            second = await svc.get_or_build_for_book(book, allow_cloud_refine=False)
            self.assertTrue(second.cache_hit)
            self.assertEqual(first.context_hash, second.context_hash)

            # Mutate book title -> context_hash changes -> cache invalidates cleanly!
            book.Title = "Chuyến đi biển kỳ thú của bé Nam"
            third = await svc.get_or_build_for_book(book, allow_cloud_refine=False)
            self.assertFalse(third.cache_hit)
            self.assertNotEqual(first.context_hash, third.context_hash)
            self.assertEqual(
                third.context_hash,
                compute_style_context_hash(
                    title=book.Title,
                    author=book.Author,
                    min_grade=book.MinGrade,
                    max_grade=book.MaxGrade,
                    sample_texts=store.book_samples[CATALOG_BOOK_ID],
                ),
            )

    async def test_private_book_blocks_cloud_gemini_refinement_unless_opted_in(self):
        store = InMemoryBookAssetsStore()
        db = store.make_fake_db()
        gemini_mock = AsyncMock(return_value={"genre": "Cloud Refined Genre"})

        env_override = {
            "OCR_CLOUD_CORRECTION_ENABLED": "true",
            "GEMINI_API_KEY": "fake-key-for-gate-test",
            "PRIVATE_BOOK_ALLOW_CLOUD_AI": "false",
        }
        with _patch_repository_with_store(store), patch.dict(os.environ, env_override, clear=False):
            svc = BookStyleBibleService(db, gemini_refine_fn=gemini_mock)
            private_book = store.books[PRIVATE_BOOK_A_ID]
            result = await svc.get_or_build_for_book(private_book)
            self.assertEqual(result.provider_name, "local_deterministic")
            gemini_mock.assert_not_awaited()

            # Public catalog book IS allowed to refine with Free-Tier Gemini
            catalog_book = store.books[CATALOG_BOOK_ID]
            catalog_result = await svc.get_or_build_for_book(catalog_book)
            self.assertEqual(catalog_result.provider_name, "gemini_free_tier")
            self.assertEqual(catalog_result.bible.genre, "Cloud Refined Genre")
            gemini_mock.assert_awaited_once()


class BookAssetsHttpApiAndSecurityTests(unittest.IsolatedAsyncioTestCase):
    """Full FastAPI route tests for Cover Studio, Anti-Overwrite, 3-Actor IDOR, Illustrations & Unmigrated Fallback."""

    async def asyncSetUp(self) -> None:
        self._tmp_dir = tempfile.TemporaryDirectory()
        self._env_patch = patch.dict(
            os.environ,
            {
                "VIREAD_LOCAL_STORAGE_DIR": self._tmp_dir.name,
                "CLOUDFLARE_ACCOUNT_ID": "",
                "CLOUDFLARE_API_TOKEN": "",
                "LOCAL_IMAGE_GEN_URL": "",
                "PRIVATE_BOOK_ALLOW_CLOUD_AI": "false",
                "OCR_CLOUD_CORRECTION_ENABLED": "false",
            },
            clear=False,
        )
        self._env_patch.start()
        self.store = InMemoryBookAssetsStore()
        self.db = self.store.make_fake_db()
        self._repo_patch = _patch_repository_with_store(self.store)
        self._repo_patch.start()

        self.current_actor: UUID | None = ADMIN_ID
        self.app = FastAPI()
        self.app.include_router(book_assets_route.router, prefix="/studio")

        def override_actor() -> UUID:
            if self.current_actor is None:
                raise HTTPException(status_code=401, detail="Authentication required")
            return self.current_actor

        async def override_db():
            yield self.db

        self.app.dependency_overrides[get_current_parent_id] = override_actor
        self.app.dependency_overrides[get_db] = override_db

    async def asyncTearDown(self) -> None:
        self._repo_patch.stop()
        self._env_patch.stop()
        self._tmp_dir.cleanup()

    def _client(self) -> httpx.AsyncClient:
        return httpx.AsyncClient(
            transport=httpx.ASGITransport(app=self.app),
            base_url="http://testserver",
        )

    async def test_admin_and_parent_cover_upload_crop_rotate_and_never_counted_as_page(self):
        initial_page_count = len(self.store.pages)
        async with self._client() as client:
            # Admin uploads cover for catalog book with crop + 90 deg rotation
            self.current_actor = ADMIN_ID
            resp = await client.post(
                f"/studio/books/{CATALOG_BOOK_ID}/cover/upload",
                files={"file": ("cover.png", _make_image_bytes("PNG", (1000, 800)), "image/png")},
                data={"crop_x": "0.1", "crop_y": "0.1", "crop_w": "0.75", "crop_h": "0.75", "rotation": "90"},
            )
            self.assertEqual(resp.status_code, 201, resp.text)
            cover_dto = resp.json()
            self.assertEqual(cover_dto["asset_role"], "COVER")
            self.assertIsNone(cover_dto["book_page_id"])
            self.assertEqual(cover_dto["source_type"], "USER_UPLOAD")
            self.assertEqual(cover_dto["mime_type"], "image/webp")
            self.assertTrue(cover_dto["media_url"].startswith("/studio/assets/"))
            self.assertLessEqual(cover_dto["size_bytes"], MAX_OUTPUT_WEBP_BYTES)

            # Verify DB stores relative path only (NO base64, NO http URL)
            stored_asset = self.store.assets[UUID(cover_dto["id"])]
            self.assertFalse(stored_asset.StoragePath.startswith(("http", "data:", "/")))
            self.assertNotIn("base64", stored_asset.StoragePath)
            # Cover is NEVER inserted into bookpages
            self.assertEqual(len(self.store.pages), initial_page_count)

            # Parent A uploads cover for Parent A's private book
            self.current_actor = PARENT_A_ID
            priv_resp = await client.post(
                f"/studio/books/{PRIVATE_BOOK_A_ID}/cover/upload",
                files={"file": ("my-cover.jpg", _make_image_bytes("JPEG", (900, 1200)), "image/jpeg")},
            )
            self.assertEqual(priv_resp.status_code, 201, priv_resp.text)
            self.assertIn("no-store", priv_resp.headers.get("cache-control", ""))
            self.assertEqual(len(self.store.pages), initial_page_count)

            # Delete cover -> reverts cleanly to METADATA_RENDER fallback
            del_resp = await client.delete(f"/studio/books/{PRIVATE_BOOK_A_ID}/cover")
            self.assertEqual(del_resp.status_code, 200, del_resp.text)
            self.assertEqual(del_resp.json()["removed_count"], 1)
            self.assertEqual(del_resp.json()["metadata_fallback"]["source_type"], "METADATA_RENDER")

            summary = await client.get(f"/studio/books/{PRIVATE_BOOK_A_ID}/assets")
            self.assertEqual(summary.status_code, 200)
            self.assertIsNone(summary.json()["active_cover"])
            self.assertEqual(summary.json()["effective_cover_source"], "METADATA_RENDER")

    async def test_three_actor_idor_and_private_media_isolation(self):
        async with self._client() as client:
            # Parent A uploads a private cover
            self.current_actor = PARENT_A_ID
            upload_a = await client.post(
                f"/studio/books/{PRIVATE_BOOK_A_ID}/cover/upload",
                files={"file": ("secret.png", _make_image_bytes("PNG", (600, 800)), "image/png")},
            )
            self.assertEqual(upload_a.status_code, 201)
            private_asset_id = upload_a.json()["id"]

            # Parent A reads own private cover bytes -> 200 WebP + no-store
            media_a = await client.get(f"/studio/assets/{private_asset_id}/media")
            self.assertEqual(media_a.status_code, 200)
            self.assertEqual(detect_magic_image_format(media_a.content), "WEBP")
            self.assertIn("no-store", media_a.headers.get("cache-control", ""))

            # Parent B tries to read Parent A's private cover media -> 404 (blocked!)
            self.current_actor = PARENT_B_ID
            media_b = await client.get(f"/studio/assets/{private_asset_id}/media")
            self.assertIn(media_b.status_code, (403, 404))
            self.assertNotIn(b"WEBP", media_b.content)

            # Parent B tries to read assets summary or overwrite Parent A's private cover -> 404!
            summary_b = await client.get(f"/studio/books/{PRIVATE_BOOK_A_ID}/assets")
            self.assertEqual(summary_b.status_code, 404)
            overwrite_b = await client.post(
                f"/studio/books/{PRIVATE_BOOK_A_ID}/cover/upload",
                files={"file": ("hack.png", _make_image_bytes("PNG", (600, 800)), "image/png")},
            )
            self.assertEqual(overwrite_b.status_code, 404)

            # Parent A cannot mutate Admin Catalog book -> 403!
            self.current_actor = PARENT_A_ID
            parent_on_catalog = await client.post(
                f"/studio/books/{CATALOG_BOOK_ID}/cover/upload",
                files={"file": ("nope.png", _make_image_bytes("PNG", (600, 800)), "image/png")},
            )
            self.assertEqual(parent_on_catalog.status_code, 403)

            # Admin uploads covers for both ACTIVE and RETIRED catalog books
            self.current_actor = ADMIN_ID
            cat_up = await client.post(
                f"/studio/books/{CATALOG_BOOK_ID}/cover/upload",
                files={"file": ("cat.png", _make_image_bytes("PNG", (600, 800)), "image/png")},
            )
            self.assertEqual(cat_up.status_code, 201)
            retired_up = await client.post(
                f"/studio/books/{RETIRED_CATALOG_BOOK_ID}/cover/upload",
                files={"file": ("ret.png", _make_image_bytes("PNG", (600, 800)), "image/png")},
            )
            self.assertEqual(retired_up.status_code, 201)

            # Admin CAN inspect private book media for moderation
            media_admin = await client.get(f"/studio/assets/{private_asset_id}/media")
            self.assertEqual(media_admin.status_code, 200)

            # Parent B CAN read PUBLISHED active catalog book cover, CANNOT read RETIRED catalog book cover
            self.current_actor = PARENT_B_ID
            pub_media = await client.get(f"/studio/assets/{cat_up.json()['id']}/media")
            self.assertEqual(pub_media.status_code, 200)
            retired_media = await client.get(f"/studio/assets/{retired_up.json()['id']}/media")
            self.assertEqual(retired_media.status_code, 403)

            # Unauthenticated user -> 401
            self.current_actor = None
            unauth = await client.get(f"/studio/assets/{cat_up.json()['id']}/media")
            self.assertEqual(unauth.status_code, 401)

    async def test_stale_ai_cover_never_overwrites_user_uploaded_cover(self):
        # Seed an in-flight COVER_GENERATE job for CATALOG_BOOK_ID
        inflight_job = SmartStudioJob(
            Id=uuid4(),
            JobType="COVER_GENERATE",
            ActorId=ADMIN_ID,
            ActorRole="admin",
            BookId=CATALOG_BOOK_ID,
            InputHash="a" * 64,
            IdempotencyKey="inflight-cover-1",
            Stage="IMAGE_GENERATING",
            Status="RUNNING",
            Priority=40,
            AttemptCount=1,
            MaxAttempts=3,
            CreatedAt=datetime.now(timezone.utc),
            UpdatedAt=datetime.now(timezone.utc),
        )
        self.store.jobs[inflight_job.Id] = inflight_job

        svc = BookCoverService(self.db)
        user_cover = await svc.upload_user_cover(
            ADMIN_ID, CATALOG_BOOK_ID, _make_image_bytes("PNG", (600, 800)), "image/png"
        )
        self.assertEqual(user_cover.source_type, "USER_UPLOAD")
        # In-flight AI cover job MUST be marked STALE immediately!
        self.assertEqual(self.store.jobs[inflight_job.Id].Status, "STALE")

        # Late AI cover arrives and tries to commit -> MUST BE REJECTED!
        late_asset, superseded = await svc.commit_generated_cover_bytes(
            book=self.store.books[CATALOG_BOOK_ID],
            image_bytes=_make_image_bytes("PNG", (600, 800), color=(20, 40, 200)),
            provider_name="cloudflare_workers_ai",
            model_id="@cf/black-forest-labs/flux-1-schnell",
            job_id=inflight_job.Id,
        )
        self.assertIsNone(late_asset)
        self.assertTrue(superseded)

        # Effective cover remains the user-uploaded cover!
        summary = await svc.get_book_assets_summary(ADMIN_ID, CATALOG_BOOK_ID)
        self.assertEqual(summary.effective_cover_source, "USER_UPLOAD")
        self.assertEqual(summary.active_cover.id, user_cover.id)  # type: ignore[union-attr]

    async def test_honest_ai_cover_blocked_no_provider_quota_and_real_mock_provider(self):
        async with self._client() as client:
            # 1) No image provider configured -> HONEST BLOCKED_NO_IMAGE_PROVIDER (never fakes SVG!)
            self.current_actor = ADMIN_ID
            blocked = await client.post(
                f"/studio/books/{CATALOG_BOOK_ID}/cover/generate",
                json={"prompt_hint": "Mèo con bên cửa sổ nắng"},
            )
            self.assertEqual(blocked.status_code, 200, blocked.text)
            body = blocked.json()
            self.assertEqual(body["status"], "BLOCKED_NO_IMAGE_PROVIDER")
            self.assertFalse(body["honest_ai_generated"])
            self.assertIsNone(body["cover"])
            self.assertEqual(body["metadata_fallback"]["source_type"], "METADATA_RENDER")
            self.assertIsNotNone(body["style_bible"])
            self.assertEqual(len(self.store.assets), 0)

        # 2) Cloudflare configured -> STILL blocked on Private Book when PRIVATE_BOOK_ALLOW_CLOUD_AI=false!
        with patch.dict(
            os.environ,
            {
                "CLOUDFLARE_ACCOUNT_ID": "cf-acc",
                "CLOUDFLARE_API_TOKEN": "cf-tok",
                "PRIVATE_BOOK_ALLOW_CLOUD_AI": "false",
            },
            clear=False,
        ):
            svc_priv = BookCoverService(self.db)
            priv_res = await svc_priv.generate_ai_cover(
                PARENT_A_ID, PRIVATE_BOOK_A_ID, BookCoverGenerateRequest()
            )
            self.assertEqual(priv_res.status, "BLOCKED_NO_IMAGE_PROVIDER")
            self.assertFalse(priv_res.honest_ai_generated)

            # 3) On Catalog Book, upstream 429 -> HONEST WAITING_FOR_QUOTA
            async def transport_429(_prov: ImageProviderAvailability, _prompt: str):
                return 429, b""

            svc_429 = BookCoverService(self.db, image_transport=transport_429)
            quota_res = await svc_429.generate_ai_cover(
                ADMIN_ID, CATALOG_BOOK_ID, BookCoverGenerateRequest()
            )
            self.assertEqual(quota_res.status, "WAITING_FOR_QUOTA")
            self.assertFalse(quota_res.honest_ai_generated)
            self.assertIsNone(quota_res.cover)

            # 4) On Catalog Book, real provider returns valid PNG -> AI_GENERATED APPROVED cover
            async def transport_ok(_prov: ImageProviderAvailability, _prompt: str):
                return 200, _make_image_bytes("PNG", (768, 1024), color=(110, 190, 220))

            svc_ok = BookCoverService(self.db, image_transport=transport_ok)
            ok_res = await svc_ok.generate_ai_cover(
                ADMIN_ID, CATALOG_BOOK_ID, BookCoverGenerateRequest(prompt_hint="Nắng sớm")
            )
            self.assertEqual(ok_res.status, "SUCCEEDED")
            self.assertTrue(ok_res.honest_ai_generated)
            self.assertIsNotNone(ok_res.cover)
            self.assertEqual(ok_res.cover.source_type, "AI_GENERATED")  # type: ignore[union-attr]
            self.assertEqual(ok_res.provider_name, "cloudflare_workers_ai")

    async def test_page_illustration_extract_moderation_and_flow_isolation(self):
        page_png, word_bboxes, canonical_text = _make_storybook_page_png()
        original_page_path = self.store.pages[PAGE_A_ID].ImagePath
        self.store.page_contexts[PAGE_A_ID] = (REVISION_A_ID, canonical_text, word_bboxes)

        svc = BookIllustrationService(self.db)
        extracted = await svc.extract_page_illustration(
            PARENT_A_ID,
            PRIVATE_BOOK_A_ID,
            PAGE_A_ID,
            PageIllustrationExtractRequest(apply_clahe_restore=True),
            page_image_bytes_override=page_png,
        )
        self.assertEqual(extracted.status, "EXTRACTED_VERIFIED")
        self.assertTrue(extracted.text_free_verified)
        self.assertEqual(extracted.recommended_reading_mode, "ILLUSTRATED")
        self.assertIsNotNone(extracted.asset)
        # Flow 1 / Flow 2 isolation: BookPage.ImagePath is NEVER mutated!
        self.assertEqual(self.store.pages[PAGE_A_ID].ImagePath, original_page_path)

        # Reject and then Restore the verified illustration via HTTP PATCH
        asset_id = extracted.asset.id  # type: ignore[union-attr]
        async with self._client() as client:
            self.current_actor = PARENT_A_ID
            rej = await client.patch(
                f"/studio/books/{PRIVATE_BOOK_A_ID}/pages/{PAGE_A_ID}/illustration/{asset_id}",
                json={"action": "REJECT", "reason": "Tạm ẩn minh họa"},
            )
            self.assertEqual(rej.status_code, 200)
            self.assertEqual(rej.json()["moderation_status"], "REJECTED")
            self.assertFalse(rej.json()["is_active"])

            restored = await client.patch(
                f"/studio/books/{PRIVATE_BOOK_A_ID}/pages/{PAGE_A_ID}/illustration/{asset_id}",
                json={"action": "RESTORE"},
            )
            self.assertEqual(restored.status_code, 200)
            self.assertEqual(restored.json()["moderation_status"], "APPROVED")
            self.assertTrue(restored.json()["is_active"])

        # Now extract with duplicate text detected -> REJECTED and CANNOT be force-approved!
        svc_dup = BookIllustrationService(
            self.db,
            ocr_check_fn=lambda _raw: canonical_text,
        )
        dup_res = await svc_dup.extract_page_illustration(
            PARENT_A_ID,
            PRIVATE_BOOK_A_ID,
            PAGE_A_ID,
            PageIllustrationExtractRequest(),
            page_image_bytes_override=page_png,
        )
        self.assertEqual(dup_res.status, "REJECTED_CONTAINS_TEXT")
        self.assertFalse(dup_res.text_free_verified)
        self.assertEqual(dup_res.recommended_reading_mode, "TEXT")
        self.assertIsNotNone(dup_res.asset)
        self.assertEqual(dup_res.asset.moderation_status, "REJECTED")  # type: ignore[union-attr]
        self.assertFalse(dup_res.asset.is_active)  # type: ignore[union-attr]

        async with self._client() as client:
            self.current_actor = PARENT_A_ID
            force_approve = await client.patch(
                f"/studio/books/{PRIVATE_BOOK_A_ID}/pages/{PAGE_A_ID}/illustration/{dup_res.asset.id}",  # type: ignore[union-attr]
                json={"action": "APPROVE"},
            )
            self.assertEqual(force_approve.status_code, 422)

    async def test_unmigrated_v2_tables_graceful_fallback_returns_metadata_cover(self):
        self.store.unmigrated_v2 = True
        async with self._client() as client:
            self.current_actor = ADMIN_ID
            resp = await client.get(f"/studio/books/{CATALOG_BOOK_ID}/assets")
            self.assertEqual(resp.status_code, 200, resp.text)
            body = resp.json()
            self.assertTrue(body["v2_storage_degraded"])
            self.assertIsNone(body["active_cover"])
            self.assertEqual(body["effective_cover_source"], "METADATA_RENDER")
            self.assertEqual(
                body["metadata_fallback"]["palette_id"],
                build_metadata_cover_fallback(self.store.books[CATALOG_BOOK_ID]).palette_id,
            )

    async def test_cover_priority_order_user_upload_over_ai_generated_over_metadata_render(self):
        now = datetime.now(timezone.utc)
        # Only PENDING AI cover -> falls back to METADATA_RENDER
        pending_ai = BookPresentationAsset(
            Id=uuid4(),
            BookId=CATALOG_BOOK_ID,
            BookPageId=None,
            AssetRole="COVER",
            SourceType="AI_GENERATED",
            StoragePath="studio/covers/catalog/pending.webp",
            MimeType="image/webp",
            Width=600,
            Height=800,
            SizeBytes=12000,
            AssetHash="1" * 64,
            AssetVersion=1,
            IsActive=True,
            TextFreeVerified=True,
            ModerationStatus="PENDING",
            MetadataJson={},
            CreatedAt=now,
            UpdatedAt=now,
        )
        self.store.assets[pending_ai.Id] = pending_ai
        svc = BookCoverService(self.db)
        s0 = await svc.get_book_assets_summary(ADMIN_ID, CATALOG_BOOK_ID)
        self.assertEqual(s0.effective_cover_source, "METADATA_RENDER")
        self.assertIsNone(s0.active_cover)

        # APPROVED AI cover -> takes priority over METADATA_RENDER
        pending_ai.ModerationStatus = "APPROVED"
        s1 = await svc.get_book_assets_summary(ADMIN_ID, CATALOG_BOOK_ID)
        self.assertEqual(s1.effective_cover_source, "AI_GENERATED")
        self.assertEqual(s1.active_cover.id, pending_ai.Id)  # type: ignore[union-attr]

        # Even if both USER_UPLOAD and AI_GENERATED are active & APPROVED, USER_UPLOAD ALWAYS wins!
        user_cover = BookPresentationAsset(
            Id=uuid4(),
            BookId=CATALOG_BOOK_ID,
            BookPageId=None,
            AssetRole="COVER",
            SourceType="USER_UPLOAD",
            StoragePath="studio/covers/catalog/user.webp",
            MimeType="image/webp",
            Width=600,
            Height=800,
            SizeBytes=15000,
            AssetHash="2" * 64,
            AssetVersion=1,
            IsActive=True,
            TextFreeVerified=True,
            ModerationStatus="APPROVED",
            MetadataJson={},
            CreatedAt=now,
            UpdatedAt=now,
        )
        self.store.assets[user_cover.Id] = user_cover
        s2 = await svc.get_book_assets_summary(ADMIN_ID, CATALOG_BOOK_ID)
        self.assertEqual(s2.effective_cover_source, "USER_UPLOAD")
        self.assertEqual(s2.active_cover.id, user_cover.Id)  # type: ignore[union-attr]

    async def test_style_bible_http_endpoint_and_parent_idor(self):
        async with self._client() as client:
            self.current_actor = PARENT_A_ID
            ok_priv = await client.post(
                f"/studio/books/{PRIVATE_BOOK_A_ID}/style-bible",
                json={"force_refresh": False},
            )
            self.assertEqual(ok_priv.status_code, 200, ok_priv.text)
            self.assertFalse(ok_priv.json()["cache_hit"])

            hit_priv = await client.post(
                f"/studio/books/{PRIVATE_BOOK_A_ID}/style-bible",
                json={"force_refresh": False},
            )
            self.assertEqual(hit_priv.status_code, 200)
            self.assertTrue(hit_priv.json()["cache_hit"])

            # Parent B cannot build/read Parent A's style bible
            self.current_actor = PARENT_B_ID
            blocked_b = await client.post(
                f"/studio/books/{PRIVATE_BOOK_A_ID}/style-bible",
                json={},
            )
            self.assertEqual(blocked_b.status_code, 404)

            # Parent cannot mutate Catalog style bible
            blocked_cat = await client.post(
                f"/studio/books/{CATALOG_BOOK_ID}/style-bible",
                json={},
            )
            self.assertEqual(blocked_cat.status_code, 403)

    async def test_page_illustration_generate_honest_blocked_and_text_free_gate_on_ai_output(self):
        async with self._client() as client:
            self.current_actor = PARENT_A_ID
            blocked = await client.post(
                f"/studio/books/{PRIVATE_BOOK_A_ID}/pages/{PAGE_A_ID}/illustration/generate",
                json={"prompt_hint": "Bé An trong khu vườn"},
            )
            self.assertEqual(blocked.status_code, 200, blocked.text)
            self.assertEqual(blocked.json()["status"], "BLOCKED_NO_IMAGE_PROVIDER")
            self.assertEqual(blocked.json()["recommended_reading_mode"], "TEXT")
            self.assertIsNone(blocked.json()["asset"])

        # Mock local image worker returning a text-laden image -> MUST BE REJECTED by text-free gate!
        ok, text_img_bytes = cv2.imencode(".png", _make_text_laden_illustration_bgr())
        assert ok

        async def bad_ai_transport(_prov: ImageProviderAvailability, _prompt: str):
            return 200, text_img_bytes.tobytes()

        with patch.dict(os.environ, {"LOCAL_IMAGE_GEN_URL": "http://127.0.0.1:7860/generate"}, clear=False):
            svc = BookIllustrationService(self.db, image_transport=bad_ai_transport)
            from app.schemas.book_assets import PageIllustrationGenerateRequest

            res = await svc.generate_page_illustration(
                PARENT_A_ID,
                PRIVATE_BOOK_A_ID,
                PAGE_A_ID,
                PageIllustrationGenerateRequest(prompt_hint="Minh họa"),
            )
            self.assertEqual(res.status, "REJECTED_CONTAINS_TEXT")
            self.assertEqual(res.recommended_reading_mode, "TEXT")
            self.assertIsNotNone(res.asset)
            self.assertFalse(res.asset.text_free_verified)  # type: ignore[union-attr]
            self.assertEqual(res.asset.moderation_status, "REJECTED")  # type: ignore[union-attr]
            self.assertFalse(res.asset.is_active)  # type: ignore[union-attr]

    async def test_repository_nested_savepoint_handles_unmigrated_v2_tables_directly(self):
        class _NestedCtx:
            async def __aenter__(self):
                return self

            async def __aexit__(self, exc_type, exc, tb):
                return False

        class _UnmigratedDb:
            def begin_nested(self):
                return _NestedCtx()

            async def execute(self, *_args, **_kwargs):
                raise ProgrammingError(
                    "SELECT", {}, Exception('relation "book_presentation_assets" does not exist')
                )

            async def scalar(self, *_args, **_kwargs):
                raise ProgrammingError(
                    "SELECT", {}, Exception('relation "book_style_bibles" does not exist')
                )

        # Call REAL BookAssetsRepository methods directly (temporarily stopping store patch)
        self._repo_patch.stop()
        try:
            repo = BookAssetsRepository(_UnmigratedDb())  # type: ignore[arg-type]
            covers, degraded_c = await repo.list_active_covers(CATALOG_BOOK_ID)
            self.assertEqual(covers, [])
            self.assertTrue(degraded_c)

            bible, degraded_b = await repo.get_style_bible(CATALOG_BOOK_ID)
            self.assertIsNone(bible)
            self.assertTrue(degraded_b)

            stale = await repo.mark_inflight_cover_jobs_stale(CATALOG_BOOK_ID)
            self.assertEqual(stale, 0)
        finally:
            self._repo_patch.start()

    def test_p0_05_text_free_gate_rejects_white_text_on_dark_background(self):
        from PIL import ImageDraw

        # Dark night-sky canvas with crisp bright white printed story lines (light-on-dark polarity!)
        pil_dark = Image.new("RGB", (600, 420), (22, 30, 48))
        draw = ImageDraw.Draw(pil_dark)
        lines = [
            "CHU MEO NHO NGOI BEN CUA SO NHIN SAO DEM",
            "NGOAI VUON CHIM HOT LIU LO DUOI ANH TRANG",
            "BE DOC SACH MOI NGAY CUNG BA ME THAT VUI",
            "MOT CAU CHUYEN HAY VE KHU VUON NANG MAI",
            "CAC BAN NHO CUNG NHAU DI HOC VAO BUOI SANG",
        ]
        for idx, line in enumerate(lines):
            draw.text((28, 40 + idx * 55), line, fill=(248, 250, 255))
        bgr = cv2.cvtColor(np.asarray(pil_dark, dtype=np.uint8), cv2.COLOR_RGB2BGR)
        ver = verify_illustration_text_free(bgr, canonical_text=" ".join(lines))
        self.assertFalse(ver.text_free_verified)
        self.assertGreater(ver.text_density_score, 0.0)

    async def test_new_p0_03_duplicate_idempotency_key_on_illustration_generate_returns_queued(self):
        from app.models.smart_book_studio import SmartStudioJob
        from app.schemas.book_assets import PageIllustrationGenerateRequest

        # Seed an in-flight RUNNING job with matching (actor_id, idempotency_key)
        existing = SmartStudioJob(
            Id=uuid4(),
            JobType="ILLUSTRATION_GENERATE",
            ActorId=PARENT_A_ID,
            ActorRole="parent",
            BookId=PRIVATE_BOOK_A_ID,
            BookPageId=PAGE_A_ID,
            InputHash="d" * 64,
            IdempotencyKey="dup-ill-key-1",
            Status="RUNNING",
            Stage="IMAGE_GENERATING",
        )

        class _IdemDb:
            async def scalar(self, _stmt):
                return existing

            def begin_nested(self):
                return self

            async def __aenter__(self):
                return self

            async def __aexit__(self, *_a):
                return False

            async def commit(self):
                return None

        svc = BookIllustrationService(
            _IdemDb(),  # type: ignore[arg-type]
        )
        with patch.dict(
            os.environ,
            {"LOCAL_IMAGE_GEN_URL": "http://127.0.0.1:7860/generate"},
            clear=False,
        ):
            res = await svc.generate_page_illustration(
                PARENT_A_ID,
                PRIVATE_BOOK_A_ID,
                PAGE_A_ID,
                PageIllustrationGenerateRequest(idempotency_key="dup-ill-key-1"),
            )
        self.assertEqual(res.status, "QUEUED")
        self.assertEqual(res.job_id, existing.Id)


if __name__ == "__main__":
    unittest.main()
