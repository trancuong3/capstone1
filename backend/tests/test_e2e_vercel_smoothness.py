"""Opaque-box E2E & Vercel smoothness verification suite (Backend + Python Email Relay).

Covers PROJECT.md Features #1-#8 and #11 across Tiers 1-4:
- Tier 1: Core feature happy-path checks (>= 5 checks per feature group).
- Tier 2: Boundary, authorization isolation, validation, rate-limit, and relay security corners.
- Tier 3: Cross-feature / pairwise concurrency, cache reuse/invalidation, and backend->relay integration.
- Tier 4: Real-world end-to-end parent, child reading, and weekly email digest journeys.

Zero real Supabase calls, zero real Gmail SMTP calls, and zero heavy ML/OCR imports.
Supports VIREAD_E2E_HARNESS_ONLY=1 ONLY to isolate baseline/harness/relay checks from
pending [M1-target]/[M2-target] assertions; default execution runs ALL Tiers 1-4 genuinely.
"""
from __future__ import annotations

import asyncio
import hashlib
import hmac
import importlib.util
import io
import json
import logging
import os
import smtplib
import socket
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from contextlib import asynccontextmanager
from datetime import datetime, timezone
from decimal import Decimal
from http.server import ThreadingHTTPServer
from pathlib import Path
from types import SimpleNamespace
from typing import Any
from unittest.mock import AsyncMock, MagicMock, patch
from uuid import UUID, uuid4

BACKEND_ROOT = Path(__file__).resolve().parents[1]
REPO_ROOT = BACKEND_ROOT.parent
if str(BACKEND_ROOT) not in sys.path:
    sys.path.insert(0, str(BACKEND_ROOT))

# Safe isolated test environment BEFORE importing app.sever.
os.environ.setdefault("APP_ENVIRONMENT", "test")
os.environ.setdefault("DATABASE_URL", "postgresql+asyncpg://test:test@127.0.0.1:1/test")
os.environ.setdefault("SUPABASE_URL", "https://example.supabase.co")
os.environ.setdefault("SUPABASE_KEY", "isolated-test-key")
os.environ.setdefault("SUPABASE_SECRET_KEY", "isolated-test-admin-key")
os.environ.setdefault("SUPABASE_STORAGE_BUCKET", "viread-test-catalog")
os.environ.setdefault("SUPABASE_AVATAR_BUCKET", "viread-test-avatars")
os.environ.setdefault("SUPABASE_PRIVATE_BOOKS_BUCKET", "viread-test-private")
os.environ.setdefault("EMAIL_FROM_ADDRESS", "noreply@viread.test")
os.environ.setdefault("VIREAD_LOCAL_VOICE_WORKER_AUTOSTART", "false")

import cv2  # noqa: E402
import httpx  # noqa: E402
import numpy as np  # noqa: E402
from fastapi import HTTPException, Request, status  # noqa: E402
from fastapi.security import HTTPAuthorizationCredentials  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402
from PIL import Image, ImageDraw  # noqa: E402
from sqlalchemy import select  # noqa: E402
from sqlalchemy.ext.asyncio import AsyncSession  # noqa: E402

from app.api.deps import (  # noqa: E402
    clear_auth_token_cache,
    get_current_parent_id,
    get_db,
    require_active_profile_id,
    require_admin_id,
    require_parent_id,
)
from app.api.routes.assistant import (  # noqa: E402
    get_assistant_service,
)
from app.api.routes.reading import (  # noqa: E402
    MAX_MATCH_PAGE_GLOBAL_CANDIDATES,
    _bounded_match_limit,
)
from app.api.routes.voice import clear_default_voice_orchestrators  # noqa: E402
from app.database.role_cache import invalidate_cached_role  # noqa: E402
from app.models import (  # noqa: E402
    Book,
    BookPage,
    BookPresentationAsset,
    ChildProfile,
    PageRevision,
    PageRevisionWord,
    Profile,
    ReadingEvent,
    ReadingSession,
    ReadingSessionPage,
    SmartStudioJob,
    TtsAudioCacheEntry,
)
from app.providers import parent_email_transport as email_transport  # noqa: E402
from app.providers.local_voice_provider import (  # noqa: E402
    DEFAULT_LOCAL_VOICE_ID,
    LOCAL_TTS_MODEL_VERSION,
    LocalSynthesizedAudio,
    LocalVoiceTechnicalError,
)
from app.repositories.book_repository import CatalogRepository  # noqa: E402
from app.repositories.local_ocr_scan_repository import LocalOcrScanRepository  # noqa: E402
from app.services.assistant_service import AssistantConfig, ViReadAssistantService  # noqa: E402
from app.services.local_ocr_scan_service import (  # noqa: E402
    MAX_SCAN_IMAGE_BYTES,
    clear_local_ocr_scan_cache,
)
from app.services.rate_limiter import clear_rate_limits  # noqa: E402
from app.services.storage_service import (  # noqa: E402
    clear_signed_url_cache,
    download_object as storage_download_object,
)
from app.services.tts_audio_cache_service import (  # noqa: E402
    ResolvedCacheTarget,
    TtsAudioCacheService,
    canonical_tts_text,
    clear_tts_cache_runtime_metrics,
)
from app.services.vision_page_matcher import vision_page_matcher  # noqa: E402
from app.services.voice_orchestrator import VoiceOrchestrator  # noqa: E402
from app.sever import app  # noqa: E402

HEAVY_ML_MODULES = (
    "torch",
    "torchvision",
    "paddle",
    "paddleocr",
    "vietocr",
    "pytesseract",
)
_HEAVY_IMPORTED_ON_APP_LOAD = [m for m in HEAVY_ML_MODULES if m in sys.modules]

HARNESS_ONLY = os.getenv("VIREAD_E2E_HARNESS_ONLY", "").strip() == "1"


def _load_email_relay_module():
    relay_path = REPO_ROOT / "frontend" / "api" / "parent-email-relay.py"
    spec = importlib.util.spec_from_file_location("viread_parent_email_relay_e2e", relay_path)
    assert spec is not None and spec.loader is not None
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


RELAY_MOD = _load_email_relay_module()

# Fixed deterministic UUIDs for opaque-box multi-tenant test fixtures.
ADMIN_ID = UUID("10000000-0000-4000-8000-000000000001")
PARENT_A_ID = UUID("20000000-0000-4000-8000-000000000001")
PARENT_B_ID = UUID("20000000-0000-4000-8000-000000000002")
SUSPENDED_PARENT_ID = UUID("20000000-0000-4000-8000-000000000003")

CHILD_A_ID = UUID("30000000-0000-4000-8000-000000000001")
CHILD_B_ID = UUID("30000000-0000-4000-8000-000000000002")

CATALOG_BOOK_ID = UUID("40000000-0000-4000-8000-000000000001")
CATALOG_BOOK_2_ID = UUID("40000000-0000-4000-8000-000000000002")
PRIVATE_BOOK_A_ID = UUID("40000000-0000-4000-8000-000000000099")

CATALOG_PAGE_1_ID = UUID("50000000-0000-4000-8000-000000000001")
CATALOG_PAGE_2_ID = UUID("50000000-0000-4000-8000-000000000002")
PRIVATE_PAGE_A_ID = UUID("50000000-0000-4000-8000-000000000099")

CATALOG_REV_1_ID = UUID("60000000-0000-4000-8000-000000000001")
CATALOG_REV_2_ID = UUID("60000000-0000-4000-8000-000000000002")
PRIVATE_REV_A_ID = UUID("60000000-0000-4000-8000-000000000099")

CATALOG_COVER_ASSET_ID = UUID("70000000-0000-4000-8000-000000000001")
CATALOG_ILLUS_ASSET_ID = UUID("70000000-0000-4000-8000-000000000002")
PRIVATE_COVER_ASSET_ID = UUID("70000000-0000-4000-8000-000000000091")
PRIVATE_ILLUS_ASSET_ID = UUID("70000000-0000-4000-8000-000000000092")

TOKEN_TO_ACTOR = {
    "token-admin": ADMIN_ID,
    "token-parent-a": PARENT_A_ID,
    "token-parent-b": PARENT_B_ID,
    "token-suspended": SUSPENDED_PARENT_ID,
}


def _make_image_bytes(fmt: str = "PNG", size: tuple[int, int] = (320, 240), color=(60, 140, 210)) -> bytes:
    img = Image.new("RGB", size, color)
    draw = ImageDraw.Draw(img)
    draw.rectangle((20, 20, size[0] - 20, size[1] - 20), outline=(255, 255, 255), width=4)
    buf = io.BytesIO()
    img.save(buf, format=fmt)
    return buf.getvalue()


def _make_textured_book_page_png(seed_offset: int = 0) -> bytes:
    """Create a bright, sharp, feature-rich synthetic storybook page image for OpenCV ORB & framing."""
    w, h = 800, 1000
    canvas = np.full((h, w, 3), 245, dtype=np.uint8)
    # Crisp central dark frame & rich geometric artwork for ORB keypoints + Laplacian sharpness.
    cv2.rectangle(canvas, (70, 70), (730, 930), (40, 60, 90), 4)
    cv2.rectangle(canvas, (110, 110), (690, 480), (230, 195, 140), -1)
    cv2.circle(canvas, (260 + seed_offset, 240), 75, (60, 130, 220), -1)
    cv2.circle(canvas, (260 + seed_offset, 240), 75, (20, 30, 40), 3)
    pts = np.array([[420, 420], [520, 170], [630, 420]], dtype=np.int32)
    cv2.fillPoly(canvas, [pts], (70, 175, 95))
    cv2.polylines(canvas, [pts], True, (25, 45, 25), 3)
    for row in range(6):
        y = 560 + row * 54
        cv2.putText(
            canvas,
            f"Be An doc sach hay trang {row + 1 + seed_offset}!",
            (110, y),
            cv2.FONT_HERSHEY_SIMPLEX,
            0.95,
            (25, 25, 30),
            2,
            cv2.LINE_AA,
        )
    # Add fine grid/checker corners inside central zone so ORB always finds >100 keypoints.
    for gx in range(130, 670, 48):
        for gy in range(130, 460, 48):
            cv2.rectangle(canvas, (gx, gy), (gx + 10, gy + 10), (50, 70, 110), 2)
    ok, encoded = cv2.imencode(".png", canvas)
    assert ok
    return encoded.tobytes()


def _sample_ocr_output(text: str = "Bé An đọc sách buổi sáng") -> dict[str, Any]:
    tokens = text.split()
    return {
        "text": text,
        "words": [
            {
                "word_index": idx,
                "line_index": 0,
                "text": tok,
                "bbox": [0.05 + idx * 0.12, 0.2, 0.1, 0.08],
                "ocr_confidence": 0.96,
            }
            for idx, tok in enumerate(tokens)
        ],
        "metadata": {
            "engine": "paddleocr_vietocr_dual",
            "engine_statuses": {"paddleocr": "success", "vietocr": "success", "tesseract": "success"},
            "model_profile": "FLOW1_EXTERNAL_TRDG",
            "checkpoint_sha256": "a" * 64,
            "model_load_status": "loaded",
        },
    }


class _FakeStorageBucket:
    def __init__(self, client: "_FakeStorageClient", bucket_name: str) -> None:
        self._client = client
        self._bucket = bucket_name

    def upload(self, path: str, data: bytes, file_options: dict[str, Any] | None = None) -> dict[str, Any]:
        if self._client.upload_entered_at is None:
            self._client.upload_entered_at = time.perf_counter()
        if self._client.upload_entered_event is not None:
            self._client.upload_entered_event.set()
        if self._client.upload_delay_seconds > 0:
            time.sleep(self._client.upload_delay_seconds)
        self._client.upload_calls.append((self._bucket, path))
        self._client.objects[(self._bucket, path)] = bytes(data)
        return {"path": path}

    def download(self, path: str) -> bytes:
        if self._client.download_delay_seconds > 0:
            time.sleep(self._client.download_delay_seconds)
        self._client.download_calls.append((self._bucket, path))
        data = self._client.objects.get((self._bucket, path))
        if data is None:
            raise ValueError(f"object not found: {self._bucket}/{path}")
        return data

    def remove(self, paths: list[str]) -> list[dict[str, Any]]:
        self._client.remove_calls.append((self._bucket, list(paths)))
        for p in paths:
            self._client.objects.pop((self._bucket, p), None)
        return [{"name": p} for p in paths]

    def create_signed_url(self, path: str, ttl: int) -> dict[str, str]:
        self._client.sign_calls += 1
        self._client.signed_paths.append((self._bucket, path))
        return {
            "signedURL": f"/storage/v1/object/sign/{self._bucket}/{path}?token=fake-sig-{ttl}"
        }

    def create_signed_urls(self, paths: list[str], ttl: int) -> list[dict[str, str]]:
        self._client.sign_calls += 1
        out: list[dict[str, str]] = []
        for p in paths:
            self._client.signed_paths.append((self._bucket, p))
            out.append(
                {
                    "path": p,
                    "signedURL": f"/storage/v1/object/sign/{self._bucket}/{p}?token=fake-sig-{ttl}",
                }
            )
        return out


class _FakeStorageClient:
    def __init__(self) -> None:
        self.objects: dict[tuple[str, str], bytes] = {}
        self.upload_calls: list[tuple[str, str]] = []
        self.download_calls: list[tuple[str, str]] = []
        self.remove_calls: list[tuple[str, list[str]]] = []
        self.signed_paths: list[tuple[str, str]] = []
        self.sign_calls = 0
        self.upload_delay_seconds = 0.0
        self.upload_entered_event: threading.Event | None = None
        self.upload_entered_at: float | None = None
        self.download_delay_seconds = 0.0
        self.storage = self

    def from_(self, bucket_name: str) -> _FakeStorageBucket:
        return _FakeStorageBucket(self, bucket_name)


class _FakeScalarResult:
    def __init__(self, items: list[Any]) -> None:
        self._items = items

    def all(self) -> list[Any]:
        return list(self._items)

    def first(self) -> Any | None:
        return self._items[0] if self._items else None

    def unique(self) -> "_FakeScalarResult":
        return self


class _FakeExecuteResult:
    def __init__(self, rows: list[Any]) -> None:
        self._rows = rows

    def all(self) -> list[Any]:
        return list(self._rows)

    def first(self) -> Any | None:
        return self._rows[0] if self._rows else None

    def scalar_one_or_none(self) -> Any | None:
        if not self._rows:
            return None
        row = self._rows[0]
        return row[0] if isinstance(row, tuple) else row

    def scalars(self) -> _FakeScalarResult:
        items = [r[0] if isinstance(r, tuple) else r for r in self._rows]
        return _FakeScalarResult(items)


class _ViReadInMemoryWorld:
    """Multi-tenant in-memory domain world backing FastAPI routes without Postgres or Supabase."""

    def __init__(self) -> None:
        now = datetime(2026, 11, 20, 8, 0, tzinfo=timezone.utc)
        self.active_actor_id: UUID | None = PARENT_A_ID
        self.storage = _FakeStorageClient()
        self.page_png_1 = _make_textured_book_page_png(0)
        self.page_png_2 = _make_textured_book_page_png(65)
        self.cover_webp = _make_image_bytes("WEBP", (300, 400), (244, 162, 97))
        self.illus_webp = _make_image_bytes("WEBP", (400, 300), (82, 183, 136))

        from app.database.config import (
            SUPABASE_AVATAR_BUCKET as CFG_AVATAR_BUCKET,
            SUPABASE_PRIVATE_BOOKS_BUCKET as CFG_PRIVATE_BUCKET,
            SUPABASE_STORAGE_BUCKET as CFG_STORAGE_BUCKET,
        )

        catalog_bucket = CFG_STORAGE_BUCKET or os.environ["SUPABASE_STORAGE_BUCKET"]
        avatar_bucket = CFG_AVATAR_BUCKET or os.environ["SUPABASE_AVATAR_BUCKET"]
        private_bucket = CFG_PRIVATE_BUCKET or os.environ["SUPABASE_PRIVATE_BOOKS_BUCKET"]

        self.storage.objects[(avatar_bucket, f"profiles/{PARENT_A_ID}/avatar/initial.webp")] = self.cover_webp
        self.storage.objects[(avatar_bucket, f"children/{CHILD_A_ID}/avatar/initial.webp")] = self.cover_webp
        self.storage.objects[(catalog_bucket, "catalog/books/cat1/cover.webp")] = self.cover_webp
        self.storage.objects[(catalog_bucket, "catalog/books/cat1/page1.png")] = self.page_png_1
        self.storage.objects[(catalog_bucket, "catalog/books/cat1/page1_illus.webp")] = self.illus_webp
        self.storage.objects[(catalog_bucket, "catalog/books/cat2/page1.png")] = self.page_png_2
        self.storage.objects[(private_bucket, f"private/{PARENT_A_ID}/priv1/cover.webp")] = self.cover_webp
        self.storage.objects[(private_bucket, f"private/{PARENT_A_ID}/priv1/page1.png")] = self.page_png_1
        self.storage.objects[(private_bucket, f"private/{PARENT_A_ID}/priv1/page1_illus.webp")] = self.illus_webp

        self.profiles: dict[UUID, Profile] = {
            ADMIN_ID: Profile(
                Id=ADMIN_ID,
                Role="admin",
                DisplayName="Admin ViRead",
                Active=1,
                AvatarPath=None,
                CreatedAt=now,
            ),
            PARENT_A_ID: Profile(
                Id=PARENT_A_ID,
                Role="parent",
                DisplayName="Mẹ Bé An",
                Active=1,
                AvatarPath=f"profiles/{PARENT_A_ID}/avatar/initial.webp",
                CreatedAt=now,
            ),
            PARENT_B_ID: Profile(
                Id=PARENT_B_ID,
                Role="parent",
                DisplayName="Ba Bé Bình",
                Active=1,
                AvatarPath=None,
                CreatedAt=now,
            ),
            SUSPENDED_PARENT_ID: Profile(
                Id=SUSPENDED_PARENT_ID,
                Role="parent",
                DisplayName="Suspended Parent",
                Active=0,
                AvatarPath=None,
                CreatedAt=now,
            ),
        }

        self.children: dict[UUID, ChildProfile] = {
            CHILD_A_ID: ChildProfile(
                Id=CHILD_A_ID,
                ParentId=PARENT_A_ID,
                Alias="Bé An",
                Grade=2,
                Settings={"preferred_voice": DEFAULT_LOCAL_VOICE_ID},
                AvatarPath=f"children/{CHILD_A_ID}/avatar/initial.webp",
                CreatedAt=now,
            ),
            CHILD_B_ID: ChildProfile(
                Id=CHILD_B_ID,
                ParentId=PARENT_B_ID,
                Alias="Bé Bình",
                Grade=3,
                Settings={},
                AvatarPath=None,
                CreatedAt=now,
            ),
        }
        self._sync_profile_children()

        self.books: dict[UUID, Book] = {
            CATALOG_BOOK_ID: Book(
                Id=CATALOG_BOOK_ID,
                Name="Khu vườn nắng sớm",
                Title="Khu vườn nắng sớm",
                Author="Nguyễn Nhật Ánh",
                MinGrade=1,
                MaxGrade=3,
                LifecycleStatus="ACTIVE",
                VisibilityScope="CATALOG",
                OwnerParentId=None,
                ModerationStatus="ACTIVE",
                IsDeleted=False,
                CreatedAt=now,
            ),
            CATALOG_BOOK_2_ID: Book(
                Id=CATALOG_BOOK_2_ID,
                Name="Mèo con đi học",
                Title="Mèo con đi học",
                Author="Tô Hoài",
                MinGrade=1,
                MaxGrade=2,
                LifecycleStatus="ACTIVE",
                VisibilityScope="CATALOG",
                OwnerParentId=None,
                ModerationStatus="ACTIVE",
                IsDeleted=False,
                CreatedAt=now,
            ),
            PRIVATE_BOOK_A_ID: Book(
                Id=PRIVATE_BOOK_A_ID,
                Name="Truyện Riêng Nhà An",
                Title="Truyện Riêng Nhà An",
                Author="Mẹ Bé An",
                MinGrade=1,
                MaxGrade=2,
                LifecycleStatus="ACTIVE",
                VisibilityScope="PARENT_PRIVATE",
                OwnerParentId=PARENT_A_ID,
                ModerationStatus="ACTIVE",
                IsDeleted=False,
                CreatedAt=now,
            ),
        }

        self.pages: dict[UUID, BookPage] = {
            CATALOG_PAGE_1_ID: BookPage(
                Id=CATALOG_PAGE_1_ID,
                BookId=CATALOG_BOOK_ID,
                PageNumber=1,
                ImagePath="catalog/books/cat1/page1.png",
                Width=800,
                Height=1000,
                LifecycleStatus="ACTIVE",
                CurrentVerifiedRevisionId=CATALOG_REV_1_ID,
                CreatedAt=now,
            ),
            CATALOG_PAGE_2_ID: BookPage(
                Id=CATALOG_PAGE_2_ID,
                BookId=CATALOG_BOOK_2_ID,
                PageNumber=1,
                ImagePath="catalog/books/cat2/page1.png",
                Width=800,
                Height=1000,
                LifecycleStatus="ACTIVE",
                CurrentVerifiedRevisionId=CATALOG_REV_2_ID,
                CreatedAt=now,
            ),
            PRIVATE_PAGE_A_ID: BookPage(
                Id=PRIVATE_PAGE_A_ID,
                BookId=PRIVATE_BOOK_A_ID,
                PageNumber=1,
                ImagePath=f"private/{PARENT_A_ID}/priv1/page1.png",
                Width=800,
                Height=1000,
                LifecycleStatus="ACTIVE",
                CurrentVerifiedRevisionId=PRIVATE_REV_A_ID,
                CreatedAt=now,
            ),
        }

        self.revisions: dict[UUID, PageRevision] = {
            CATALOG_REV_1_ID: PageRevision(
                Id=CATALOG_REV_1_ID,
                PageId=CATALOG_PAGE_1_ID,
                RevisionNo="1",
                VerificationStatus="VERIFIED",
                VerifiedText="Bé An đọc sách buổi sáng",
                ProcessingMeta={
                    "catalog_tts": {
                        "object_path": "catalog/tts/cat1/1.00/page1.mp3",
                        "voice_id": DEFAULT_LOCAL_VOICE_ID,
                        "speed": 1.0,
                    }
                },
                CreatedAt=now,
            ),
            CATALOG_REV_2_ID: PageRevision(
                Id=CATALOG_REV_2_ID,
                PageId=CATALOG_PAGE_2_ID,
                RevisionNo="1",
                VerificationStatus="VERIFIED",
                VerifiedText="Mèo con đi học cùng bạn",
                ProcessingMeta={},
                CreatedAt=now,
            ),
            PRIVATE_REV_A_ID: PageRevision(
                Id=PRIVATE_REV_A_ID,
                PageId=PRIVATE_PAGE_A_ID,
                RevisionNo="1",
                VerificationStatus="VERIFIED",
                VerifiedText="Bé An cùng bạn thỏ trắng",
                ProcessingMeta={},
                CreatedAt=now,
            ),
        }

        self.words: dict[UUID, list[PageRevisionWord]] = {
            CATALOG_REV_1_ID: [
                PageRevisionWord(
                    Id=UUID(f"80000000-0000-4000-8000-00000000000{i + 1}"),
                    PageRevisionId=CATALOG_REV_1_ID,
                    WordIndex=i,
                    LineIndex=0,
                    Text=tok,
                    BoundingBox=[0.05 + i * 0.14, 0.2, 0.12, 0.06],
                )
                for i, tok in enumerate(["Bé", "An", "đọc", "sách", "buổi", "sáng"])
            ],
            CATALOG_REV_2_ID: [
                PageRevisionWord(
                    Id=UUID(f"81000000-0000-4000-8000-00000000000{i + 1}"),
                    PageRevisionId=CATALOG_REV_2_ID,
                    WordIndex=i,
                    LineIndex=0,
                    Text=tok,
                    BoundingBox=[0.05 + i * 0.14, 0.2, 0.12, 0.06],
                )
                for i, tok in enumerate(["Mèo", "con", "đi", "học", "cùng", "bạn"])
            ],
            PRIVATE_REV_A_ID: [
                PageRevisionWord(
                    Id=UUID(f"82000000-0000-4000-8000-00000000000{i + 1}"),
                    PageRevisionId=PRIVATE_REV_A_ID,
                    WordIndex=i,
                    LineIndex=0,
                    Text=tok,
                    BoundingBox=[0.05 + i * 0.14, 0.2, 0.12, 0.06],
                )
                for i, tok in enumerate(["Bé", "An", "cùng", "bạn", "thỏ", "trắng"])
            ],
        }

        self.assets: dict[UUID, BookPresentationAsset] = {
            CATALOG_COVER_ASSET_ID: BookPresentationAsset(
                Id=CATALOG_COVER_ASSET_ID,
                BookId=CATALOG_BOOK_ID,
                BookPageId=None,
                OwnerId=None,
                AssetRole="COVER",
                SourceType="USER_UPLOAD",
                StoragePath="catalog/books/cat1/cover.webp",
                MimeType="image/webp",
                Width=300,
                Height=400,
                SizeBytes=len(self.cover_webp),
                AssetHash="a" * 64,
                AssetVersion=1,
                IsActive=True,
                TextFreeVerified=True,
                ModerationStatus="APPROVED",
                CreatedAt=now,
                UpdatedAt=now,
            ),
            CATALOG_ILLUS_ASSET_ID: BookPresentationAsset(
                Id=CATALOG_ILLUS_ASSET_ID,
                BookId=CATALOG_BOOK_ID,
                BookPageId=CATALOG_PAGE_1_ID,
                OwnerId=None,
                AssetRole="PAGE_ILLUSTRATION",
                SourceType="AI_GENERATED",
                StoragePath="catalog/books/cat1/page1_illus.webp",
                MimeType="image/webp",
                Width=400,
                Height=300,
                SizeBytes=len(self.illus_webp),
                AssetHash="b" * 64,
                AssetVersion=1,
                IsActive=True,
                TextFreeVerified=True,
                ModerationStatus="APPROVED",
                CreatedAt=now,
                UpdatedAt=now,
            ),
            PRIVATE_COVER_ASSET_ID: BookPresentationAsset(
                Id=PRIVATE_COVER_ASSET_ID,
                BookId=PRIVATE_BOOK_A_ID,
                BookPageId=None,
                OwnerId=PARENT_A_ID,
                AssetRole="COVER",
                SourceType="USER_UPLOAD",
                StoragePath=f"private/{PARENT_A_ID}/priv1/cover.webp",
                MimeType="image/webp",
                Width=300,
                Height=400,
                SizeBytes=len(self.cover_webp),
                AssetHash="c" * 64,
                AssetVersion=1,
                IsActive=True,
                TextFreeVerified=True,
                ModerationStatus="APPROVED",
                CreatedAt=now,
                UpdatedAt=now,
            ),
            PRIVATE_ILLUS_ASSET_ID: BookPresentationAsset(
                Id=PRIVATE_ILLUS_ASSET_ID,
                BookId=PRIVATE_BOOK_A_ID,
                BookPageId=PRIVATE_PAGE_A_ID,
                OwnerId=PARENT_A_ID,
                AssetRole="PAGE_ILLUSTRATION",
                SourceType="AI_GENERATED",
                StoragePath=f"private/{PARENT_A_ID}/priv1/page1_illus.webp",
                MimeType="image/webp",
                Width=400,
                Height=300,
                SizeBytes=len(self.illus_webp),
                AssetHash="d" * 64,
                AssetVersion=1,
                IsActive=True,
                TextFreeVerified=True,
                ModerationStatus="APPROVED",
                CreatedAt=now,
                UpdatedAt=now,
            ),
        }

        self.sessions: dict[UUID, ReadingSession] = {}
        self.session_pages: dict[UUID, list[ReadingSessionPage]] = {}
        self.events: list[ReadingEvent] = []
        self.studio_jobs: dict[UUID, SmartStudioJob] = {}
        self.last_camera_query_limit: int | None = None

    def _sync_profile_children(self) -> None:
        for prof in self.profiles.values():
            prof.children = [
                c for c in self.children.values() if c.ParentId == prof.Id
            ]

    def is_book_readable_for(self, book: Book, actor_id: UUID | None) -> bool:
        if book.IsDeleted or book.LifecycleStatus != "ACTIVE":
            return False
        if book.VisibilityScope == "CATALOG":
            return True
        if book.VisibilityScope == "PARENT_PRIVATE":
            return (
                actor_id is not None
                and book.OwnerParentId == actor_id
                and book.ModerationStatus != "SUSPENDED"
            )
        return False


class _InMemoryAsyncSession(AsyncSession):
    """SQLAlchemy-compatible AsyncSession double routing queries to _ViReadInMemoryWorld."""

    def __init__(self, world: _ViReadInMemoryWorld) -> None:
        self.world = world
        self.sync_session = SimpleNamespace(expire_on_commit=False)

    def in_transaction(self) -> bool:
        return False

    def in_nested_transaction(self) -> bool:
        return False

    def get_bind(self, *args: Any, **kwargs: Any) -> Any:
        return None

    @property
    def is_active(self) -> bool:
        return True

    async def close(self) -> None:
        return None

    def add(self, obj: Any) -> None:
        now = datetime.now(timezone.utc)
        if isinstance(obj, ChildProfile):
            if getattr(obj, "Id", None) is None:
                obj.Id = uuid4()
            if getattr(obj, "CreatedAt", None) is None:
                obj.CreatedAt = now
            self.world.children[obj.Id] = obj
            self.world._sync_profile_children()
        elif isinstance(obj, ReadingSession):
            if getattr(obj, "Id", None) is None:
                obj.Id = uuid4()
            if getattr(obj, "StartedAt", None) is None:
                obj.StartedAt = now
            self.world.sessions[obj.Id] = obj
        elif isinstance(obj, ReadingSessionPage):
            if getattr(obj, "Id", None) is None:
                obj.Id = uuid4()
            rows = self.world.session_pages.setdefault(obj.SessionId, [])
            if all(r.Id != obj.Id for r in rows):
                rows.append(obj)
        elif isinstance(obj, ReadingEvent):
            if getattr(obj, "Id", None) is None:
                obj.Id = uuid4()
            if getattr(obj, "CreatedAt", None) is None:
                obj.CreatedAt = now
            self.world.events.append(obj)
        elif isinstance(obj, SmartStudioJob):
            if getattr(obj, "Id", None) is None:
                obj.Id = uuid4()
            if getattr(obj, "CreatedAt", None) is None:
                obj.CreatedAt = now
            if getattr(obj, "UpdatedAt", None) is None:
                obj.UpdatedAt = now
            if getattr(obj, "AttemptCount", None) is None:
                obj.AttemptCount = 0
            self.world.studio_jobs[obj.Id] = obj

    def add_all(self, objs: list[Any]) -> None:
        for obj in objs:
            self.add(obj)

    async def delete(self, obj: Any) -> None:
        if isinstance(obj, ChildProfile):
            self.world.children.pop(obj.Id, None)
            self.world._sync_profile_children()

    async def commit(self) -> None:
        self.world._sync_profile_children()

    async def rollback(self) -> None:
        return None

    async def flush(self) -> None:
        return None

    async def refresh(self, obj: Any) -> None:
        return None

    @asynccontextmanager
    async def begin_nested(self):
        yield self

    def _compile(self, statement: Any) -> tuple[list[tuple[Any, str | None]], dict[str, Any], str]:
        descs = [
            (d.get("entity"), d.get("name"))
            for d in getattr(statement, "column_descriptions", [])
        ]
        try:
            compiled = statement.compile()
            params = dict(compiled.params)
            sql = str(compiled).lower()
        except Exception:
            params = {}
            sql = str(statement).lower()
        return descs, params, sql

    @staticmethod
    def _uuid_param(params: dict[str, Any], *prefixes: str) -> UUID | None:
        for prefix in prefixes:
            for k, v in params.items():
                if k == prefix or k.startswith(prefix + "_"):
                    if isinstance(v, UUID):
                        return v
                    try:
                        return UUID(str(v))
                    except (ValueError, TypeError):
                        pass
        return None

    def _resolve_rows(self, statement: Any) -> list[Any]:
        descs, params, sql = self._compile(statement)
        entities = [e for e, _ in descs]
        names = [n for _, n in descs]

        # 1. Profile.Role scalar lookup
        if descs == [(Profile, "Role")]:
            pid = self._uuid_param(params, "id")
            prof = self.world.profiles.get(pid) if pid else None
            if prof is not None and prof.Active == 1:
                return [prof.Role]
            return []

        # 2. Profile ORM lookup
        if descs == [(Profile, "Profile")]:
            pid = self._uuid_param(params, "id")
            if pid is not None:
                prof = self.world.profiles.get(pid)
                return [prof] if prof is not None else []
            return list(self.world.profiles.values())

        # 3. ProfileRepository.get_dashboard_summary_rows
        if len(descs) == 4 and entities[0] is Profile and entities[1] is ChildProfile and entities[2] is ReadingSession:
            pid = self._uuid_param(params, "id", "parentid")
            prof = self.world.profiles.get(pid) if pid else None
            if prof is None:
                return []
            kids = [c for c in self.world.children.values() if c.ParentId == prof.Id]
            if not kids:
                return [(prof, None, None, None)]
            rows = []
            for kid in kids:
                kid_sessions = [s for s in self.world.sessions.values() if s.ChildId == kid.Id]
                kid_sessions.sort(key=lambda s: (s.StartedAt, str(s.Id)), reverse=True)
                latest = kid_sessions[0] if kid_sessions else None
                b_title = self.world.books[latest.BookId].Title if latest and latest.BookId in self.world.books else None
                rows.append((prof, kid, latest, b_title))
            return rows

        # 4. ChildProfile lookups
        if descs == [(ChildProfile, "ChildProfile")]:
            cid = self._uuid_param(params, "id")
            pid = self._uuid_param(params, "parentid")
            items = list(self.world.children.values())
            if cid is not None:
                items = [c for c in items if c.Id == cid]
            if pid is not None:
                prof = self.world.profiles.get(pid)
                if prof is None or prof.Active != 1 or prof.Role != "parent":
                    return []
                items = [c for c in items if c.ParentId == pid]
            items.sort(key=lambda c: c.CreatedAt, reverse=True)
            return items

        if descs == [(ChildProfile, "Id")]:
            cid = self._uuid_param(params, "id")
            pid = self._uuid_param(params, "parentid")
            c = self.world.children.get(cid) if cid else None
            if c is not None and (pid is None or c.ParentId == pid):
                return [c.Id]
            return []

        # 5. ReadingContentRepository.session_start_context
        if names == ["child_owned", "Book", "is_readable"]:
            cid = self._uuid_param(params, "childid", "id")
            bid = self._uuid_param(params, "bookid", "id_1", "id_2")
            actor_id = self._uuid_param(params, "parentid", "ownerparentid")
            # Determine child & book robustly from all UUID params
            all_uuids = [v if isinstance(v, UUID) else UUID(str(v)) for v in params.values() if isinstance(v, UUID)]
            child = next((self.world.children[u] for u in all_uuids if u in self.world.children), None)
            book = next((self.world.books[u] for u in all_uuids if u in self.world.books), None)
            actor_u = next((u for u in all_uuids if u in self.world.profiles), self.world.active_actor_id)
            child_owned = child is not None and child.ParentId == actor_u
            is_readable = book is not None and self.world.is_book_readable_for(book, actor_u)
            return [(child_owned, book, is_readable)]

        # 6. ReadingContentRepository.active_book_pages_with_revisions
        if len(descs) == 3 and entities[0] is BookPage and entities[1] is PageRevision and names[2] == "is_eligible":
            bid = self._uuid_param(params, "bookid")
            pages = [p for p in self.world.pages.values() if p.BookId == bid and p.LifecycleStatus == "ACTIVE"]
            pages.sort(key=lambda p: p.PageNumber)
            out = []
            for p in pages:
                rev = self.world.revisions.get(p.CurrentVerifiedRevisionId) if p.CurrentVerifiedRevisionId else None
                elig = rev is not None and rev.VerificationStatus == "VERIFIED"
                out.append((p, rev, elig))
            return out

        # 7. ReadingContentRepository.session_with_ownership_and_book
        if len(descs) == 3 and entities[0] is ReadingSession and entities[1] is Book and names[2] == "child_owned":
            sid = self._uuid_param(params, "id")
            actor_id = self._uuid_param(params, "parentid", "ownerparentid") or self.world.active_actor_id
            sess = self.world.sessions.get(sid) if sid else None
            if sess is None:
                return []
            book = self.world.books.get(sess.BookId)
            if book is None or not self.world.is_book_readable_for(book, actor_id):
                return []
            child = self.world.children.get(sess.ChildId)
            child_owned = child is not None and child.ParentId == actor_id
            return [(sess, book, child_owned)]

        # 8. ReadingContentRepository.session_pages_with_content
        if len(descs) == 3 and entities[0] is ReadingSessionPage and entities[1] is BookPage and entities[2] is PageRevision:
            sid = self._uuid_param(params, "sessionid")
            rows = self.world.session_pages.get(sid, []) if sid else []
            rows_sorted = sorted(rows, key=lambda r: (r.PageOrder, str(r.Id)))
            return [
                (sp, self.world.pages.get(sp.PageId), self.world.revisions.get(sp.PageRevisionId))
                for sp in rows_sorted
            ]

        # 9. Camera match candidate query: select(BookPage, Book)
        if descs == [(BookPage, "BookPage"), (Book, "Book")]:
            limit_val = getattr(getattr(statement, "_limit_clause", None), "value", None)
            if isinstance(limit_val, int):
                self.world.last_camera_query_limit = limit_val
            bid = self._uuid_param(params, "bookid") if "bookpages.bookid" in sql else None
            actor_id = self._uuid_param(params, "owner_parent_id", "ownerparentid")
            pairs = []
            for p in self.world.pages.values():
                if bid is not None and p.BookId != bid:
                    continue
                if p.LifecycleStatus != "ACTIVE" or p.CurrentVerifiedRevisionId is None:
                    continue
                b = self.world.books.get(p.BookId)
                if b is None or not self.world.is_book_readable_for(b, actor_id):
                    continue
                pairs.append((p, b))
            pairs.sort(key=lambda pair: (str(pair[0].BookId), pair[0].PageNumber))
            if isinstance(limit_val, int) and limit_val > 0:
                pairs = pairs[:limit_val]
            return pairs

        # 10. Book queries
        if descs == [(Book, "Book")]:
            has_book_id_filter = "books.id =" in sql or "books.id=" in sql
            bid = self._uuid_param(params, "id") if has_book_id_filter else None
            if bid is not None:
                b = self.world.books.get(bid)
                return [b] if (b is not None and not b.IsDeleted) else []
            actor_id = self._uuid_param(params, "owner_parent_id", "ownerparentid")
            has_private_scope = "owner_parent_id" in sql or "ownerparentid" in sql
            books = [
                b
                for b in self.world.books.values()
                if self.world.is_book_readable_for(b, actor_id if has_private_scope else None)
            ]
            books.sort(key=lambda b: (b.Title, str(b.Id)))
            return books

        if descs == [(Book, "Id")]:
            has_book_id_filter = "books.id =" in sql or "books.id=" in sql
            bid = self._uuid_param(params, "id") if has_book_id_filter else None
            actor_id = self._uuid_param(params, "owner_parent_id", "ownerparentid")
            has_private_scope = "owner_parent_id" in sql or "ownerparentid" in sql
            b = self.world.books.get(bid) if bid else None
            if b is not None and self.world.is_book_readable_for(b, actor_id if has_private_scope else None):
                return [b.Id]
            return []

        # 11. BookPage queries
        if descs == [(BookPage, "BookPage")]:
            bid = self._uuid_param(params, "bookid")
            pid = self._uuid_param(params, "id")
            pages = list(self.world.pages.values())
            if bid is not None:
                pages = [p for p in pages if p.BookId == bid]
            if pid is not None:
                pages = [p for p in pages if p.Id == pid]
            pages = [p for p in pages if p.LifecycleStatus == "ACTIVE" and p.CurrentVerifiedRevisionId is not None]
            pages.sort(key=lambda p: p.PageNumber)
            return pages

        # 12. PageRevision queries
        if descs == [(PageRevision, "PageRevision")]:
            rid = self._uuid_param(params, "id")
            pid = self._uuid_param(params, "pageid")
            if rid is not None:
                rev = self.world.revisions.get(rid)
                return [rev] if rev is not None else []
            if pid is not None:
                revs = [r for r in self.world.revisions.values() if r.PageId == pid]
                return revs
            return []

        # 13. PageRevisionWord validation & word queries
        if len(descs) == 3 and entities == [PageRevisionWord, PageRevisionWord, PageRevisionWord]:
            rev_ids = params.get("pagerevisionid_1") or []
            if not isinstance(rev_ids, (list, tuple, set)):
                rev_ids = [rev_ids]
            out = []
            for rid in rev_ids:
                for w in self.world.words.get(rid, []):
                    out.append((w.PageRevisionId, w.Text, w.BoundingBox))
            return out

        if descs == [(PageRevisionWord, "PageRevisionWord")]:
            rid = self._uuid_param(params, "pagerevisionid")
            words = list(self.world.words.get(rid, [])) if rid else []
            words.sort(key=lambda w: w.WordIndex)
            return words

        if descs == [(PageRevisionWord, "Id")]:
            wid = self._uuid_param(params, "id")
            rid = self._uuid_param(params, "pagerevisionid")
            for w in self.world.words.get(rid, []):
                if w.Id == wid:
                    return [w.Id]
            return []

        # 14. BookPresentationAsset queries
        if descs == [(BookPresentationAsset, "BookPresentationAsset"), (Book, "Book")]:
            aid = self._uuid_param(params, "id")
            a = self.world.assets.get(aid) if aid else None
            b = self.world.books.get(a.BookId) if a else None
            if a is not None and b is not None and not b.IsDeleted:
                return [(a, b)]
            return []

        if descs == [(BookPresentationAsset, "BookPresentationAsset")]:
            has_asset_id = "book_presentation_assets.id =" in sql or "book_presentation_assets.id=" in sql
            aid = self._uuid_param(params, "id") if has_asset_id else None
            if aid is not None:
                a = self.world.assets.get(aid)
                return [a] if a is not None else []
            page_id = self._uuid_param(params, "book_page_id", "bookpageid")
            if page_id is not None:
                matches = [
                    a
                    for a in self.world.assets.values()
                    if a.BookPageId == page_id
                    and a.AssetRole == "PAGE_ILLUSTRATION"
                    and a.IsActive
                    and a.ModerationStatus == "APPROVED"
                    and a.TextFreeVerified
                ]
                matches.sort(key=lambda a: (a.AssetVersion, a.UpdatedAt), reverse=True)
                return matches[:1]
            book_ids = params.get("book_id_1") or params.get("bookid_1") or []
            if isinstance(book_ids, UUID):
                book_ids = [book_ids]
            matches = [
                a
                for a in self.world.assets.values()
                if a.BookId in set(book_ids)
                and a.AssetRole == "COVER"
                and a.IsActive
                and a.ModerationStatus == "APPROVED"
            ]
            matches.sort(key=lambda a: (a.AssetVersion, a.UpdatedAt), reverse=True)
            return matches

        # 15. ReadingSession / ReadingSessionPage / ReadingEvent / ComparisonReport
        if descs == [(ReadingSession, "ReadingSession")]:
            sid = self._uuid_param(params, "id")
            actor_id = self._uuid_param(params, "ownerparentid")
            if sid is not None:
                s = self.world.sessions.get(sid)
                if s is None:
                    return []
                b = self.world.books.get(s.BookId)
                if b and self.world.is_book_readable_for(b, actor_id):
                    return [s]
                return []
            return list(self.world.sessions.values())

        if descs == [(ReadingSessionPage, "ReadingSessionPage")]:
            sid = self._uuid_param(params, "sessionid")
            pid = self._uuid_param(params, "pageid")
            rows = list(self.world.session_pages.get(sid, [])) if sid else []
            if pid is not None:
                rows = [r for r in rows if r.PageId == pid]
            rows.sort(key=lambda r: (r.PageOrder, str(r.Id)))
            return rows

        if descs == [(ReadingEvent, "ReadingEvent")]:
            sid = self._uuid_param(params, "sessionid")
            rows = [e for e in self.world.events if sid is None or e.SessionId == sid]
            rows.sort(key=lambda e: (e.StartMs, str(e.Id)))
            return rows

        # 16. SmartStudioJob queries (GlobalTasksRepository)
        if descs == [(SmartStudioJob, "SmartStudioJob")]:
            jid = self._uuid_param(params, "id")
            actor_id = self._uuid_param(params, "actorid")
            idem = params.get("idempotencykey_1")
            jobs = list(self.world.studio_jobs.values())
            if jid is not None:
                jobs = [j for j in jobs if j.Id == jid]
            if actor_id is not None:
                jobs = [j for j in jobs if j.ActorId == actor_id]
            if isinstance(idem, str):
                jobs = [j for j in jobs if j.IdempotencyKey == idem]
            jobs.sort(key=lambda j: j.UpdatedAt, reverse=True)
            return jobs

        if len(descs) == 1 and names[0] == "Id" and "ocr_inference_jobs" in sql:
            return []
        if "parent_book_page_submissions" in sql or "admin_ai_workflows" in sql or "ocr_inference_jobs" in sql:
            return []
        if "ocr_worker_heartbeats" in sql or "readingcomparisonreports" in sql or "tts_audio_cache" in sql:
            return []

        return []

    async def execute(self, statement: Any) -> _FakeExecuteResult:
        return _FakeExecuteResult(self._resolve_rows(statement))

    async def scalar(self, statement: Any) -> Any | None:
        rows = self._resolve_rows(statement)
        if not rows:
            return None
        first = rows[0]
        return first[0] if isinstance(first, tuple) else first

    async def scalars(self, statement: Any) -> _FakeScalarResult:
        rows = self._resolve_rows(statement)
        items = [r[0] if isinstance(r, tuple) else r for r in rows]
        return _FakeScalarResult(items)


class _InMemoryTtsRepo:
    """In-memory TTS audio cache repository double for opaque-box /voice/text-to-speech E2E tests."""

    def __init__(self, world: _ViReadInMemoryWorld) -> None:
        self.world = world
        self.entries: dict[UUID, TtsAudioCacheEntry] = {}
        self.daily = {"bytes_served": 0, "hit_count": 0, "miss_count": 0}

    async def get_book_scope_info(self, book_id: UUID):
        b = self.world.books.get(book_id)
        if b is None:
            return None
        return {
            "book_id": b.Id,
            "visibility_scope": b.VisibilityScope,
            "owner_parent_id": b.OwnerParentId,
            "lifecycle_status": b.LifecycleStatus,
            "moderation_status": b.ModerationStatus,
            "is_deleted": b.IsDeleted,
        }

    async def get_page_book_scope_info(self, page_id: UUID):
        p = self.world.pages.get(page_id)
        if p is None:
            return None
        b = self.world.books.get(p.BookId)
        if b is None:
            return None
        return {
            "page_id": p.Id,
            "book_id": b.Id,
            "page_lifecycle_status": p.LifecycleStatus,
            "visibility_scope": b.VisibilityScope,
            "owner_parent_id": b.OwnerParentId,
            "lifecycle_status": b.LifecycleStatus,
            "moderation_status": b.ModerationStatus,
            "is_deleted": b.IsDeleted,
        }

    async def get_page_revision_scope_info(
        self, *, page_revision_id: UUID, page_id: UUID | None = None, book_id: UUID | None = None
    ):
        rev = self.world.revisions.get(page_revision_id)
        if rev is None:
            return None
        p = self.world.pages.get(rev.PageId)
        if p is None or (page_id is not None and p.Id != page_id):
            return None
        b = self.world.books.get(p.BookId)
        if b is None or (book_id is not None and b.Id != book_id):
            return None
        return {
            "page_revision_id": rev.Id,
            "page_id": p.Id,
            "book_id": b.Id,
            "verification_status": rev.VerificationStatus,
            "page_lifecycle_status": p.LifecycleStatus,
            "visibility_scope": b.VisibilityScope,
            "owner_parent_id": b.OwnerParentId,
            "lifecycle_status": b.LifecycleStatus,
            "moderation_status": b.ModerationStatus,
            "is_deleted": b.IsDeleted,
        }

    async def get_verified_catalog_texts(
        self, *, book_id: UUID, page_id: UUID | None = None, page_revision_id: UUID | None = None
    ):
        out = []
        for rev in self.world.revisions.values():
            p = self.world.pages.get(rev.PageId)
            if p is None or p.BookId != book_id:
                continue
            if page_id is not None and p.Id != page_id:
                continue
            if page_revision_id is not None and rev.Id != page_revision_id:
                continue
            words = [(w.Text, w.Text) for w in self.world.words.get(rev.Id, [])]
            out.append((rev.VerifiedText, words))
        return out

    async def get_active_entry(
        self,
        *,
        scope: str,
        owner_parent_id: UUID | None,
        content_sha256: str,
        voice_id: str,
        model_version: str | None,
        speed: float,
        audio_formats,
        require_word_timings: bool = False,
    ):
        if scope == "PRIVATE" and owner_parent_id is None:
            return None
        q_speed = Decimal(f"{float(speed):.2f}")
        matches = [
            e
            for e in self.entries.values()
            if e.Status == "ACTIVE"
            and e.Scope == scope
            and (e.OwnerParentId == owner_parent_id if scope == "PRIVATE" else e.OwnerParentId is None)
            and e.ContentSha256 == content_sha256
            and e.VoiceId == voice_id
            and (model_version is None or e.ModelVersion == model_version)
            and Decimal(str(e.Speed)) == q_speed
            and e.AudioFormat in audio_formats
            and (not require_word_timings or e.WordTimingsJson is not None)
        ]
        matches.sort(key=lambda e: e.CreatedAt, reverse=True)
        return matches[0] if matches else None

    async def get_nearest_active_entry(self, **kwargs):
        kwargs.pop("speed", None)
        matches = [
            e
            for e in self.entries.values()
            if e.Status == "ACTIVE"
            and e.Scope == kwargs["scope"]
            and (e.OwnerParentId == kwargs["owner_parent_id"] if kwargs["scope"] == "PRIVATE" else e.OwnerParentId is None)
            and e.ContentSha256 == kwargs["content_sha256"]
            and e.VoiceId == kwargs["voice_id"]
            and e.AudioFormat in kwargs["audio_formats"]
        ]
        return matches[0] if matches else None

    async def upsert_active_entry(self, **kwargs):
        now = kwargs.get("now") or datetime.now(timezone.utc)
        entry_id = uuid4()
        entry = TtsAudioCacheEntry(
            Id=entry_id,
            Scope=kwargs["scope"],
            OwnerParentId=kwargs["owner_parent_id"],
            BookId=kwargs["book_id"],
            PageId=kwargs["page_id"],
            PageRevisionId=kwargs["page_revision_id"],
            ContentSha256=kwargs["content_sha256"],
            NormalizedText=kwargs["normalized_text"],
            VoiceId=kwargs["voice_id"],
            ModelVersion=kwargs["model_version"],
            Speed=Decimal(f"{float(kwargs['speed']):.2f}"),
            AudioFormat=kwargs["audio_format"],
            StorageBucket=kwargs["storage_bucket"],
            StoragePath=kwargs["storage_path"],
            ByteSize=int(kwargs["byte_size"]),
            DurationSeconds=kwargs["duration_seconds"],
            WordTimingsJson=kwargs["word_timings_json"],
            Status="ACTIVE",
            LastAccessedAt=now,
            HitCount=0,
            CreatedAt=now,
            UpdatedAt=now,
        )
        self.entries[entry_id] = entry
        return entry, []

    async def get_daily_usage(self, usage_day=None):
        return dict(self.daily)

    async def record_hit(self, entry_id: UUID, *, byte_size: int, now=None):
        if entry_id in self.entries:
            self.entries[entry_id].HitCount = int(self.entries[entry_id].HitCount or 0) + 1
            self.entries[entry_id].LastAccessedAt = now or datetime.now(timezone.utc)
        self.daily["bytes_served"] += int(byte_size)
        self.daily["hit_count"] += 1

    async def record_miss(self, *, now=None):
        self.daily["miss_count"] += 1

    async def total_active_bytes(self) -> int:
        return sum(int(e.ByteSize) for e in self.entries.values() if e.Status == "ACTIVE")

    async def list_lru_eviction_candidates(self, *, exclude_ids=(), limit: int = 100):
        return []


class _BackendHarnessMixin:
    """Shared isolated backend fixture for Tier 1-4 tests (zero Supabase / zero SMTP / zero Postgres)."""

    def start_backend_harness(self) -> None:
        clear_rate_limits()
        clear_signed_url_cache()
        clear_auth_token_cache()
        invalidate_cached_role()
        clear_local_ocr_scan_cache()
        clear_tts_cache_runtime_metrics()
        clear_default_voice_orchestrators()
        vision_page_matcher.clear_descriptor_cache()

        self._saved_overrides = dict(app.dependency_overrides)
        self.world = _ViReadInMemoryWorld()
        self.db = _InMemoryAsyncSession(self.world)
        self._tmpdir = tempfile.TemporaryDirectory()

        def _actor_from_auth_or_default(request_headers_auth: str | None = None) -> UUID:
            if request_headers_auth and request_headers_auth.lower().startswith("bearer "):
                tok = request_headers_auth[7:].strip()
                if tok in TOKEN_TO_ACTOR:
                    return TOKEN_TO_ACTOR[tok]
            if self.world.active_actor_id is None:
                raise HTTPException(
                    status_code=status.HTTP_401_UNAUTHORIZED,
                    detail="Not authenticated",
                )
            return self.world.active_actor_id

        async def _override_db():
            yield self.db

        def _override_current_parent_id(request: Request) -> UUID:
            auth = (request.headers.get("authorization") or "").strip()
            if auth.lower().startswith("bearer "):
                tok = auth[7:].strip()
                if tok in TOKEN_TO_ACTOR:
                    return TOKEN_TO_ACTOR[tok]
                raise HTTPException(
                    status_code=status.HTTP_401_UNAUTHORIZED,
                    detail="Invalid authentication credentials",
                )
            if self.world.active_actor_id is None:
                raise HTTPException(
                    status_code=status.HTTP_401_UNAUTHORIZED,
                    detail="Not authenticated",
                )
            return self.world.active_actor_id

        def _override_active_profile_id(request: Request) -> UUID:
            actor_id = _override_current_parent_id(request)
            prof = self.world.profiles.get(actor_id)
            if prof is None or prof.Active != 1:
                raise HTTPException(
                    status_code=status.HTTP_403_FORBIDDEN,
                    detail="Account is inactive or unavailable",
                )
            return actor_id

        def _override_parent_id(request: Request) -> UUID:
            actor_id = _override_active_profile_id(request)
            if self.world.profiles[actor_id].Role != "parent":
                raise HTTPException(
                    status_code=status.HTTP_403_FORBIDDEN,
                    detail="Parent access required",
                )
            return actor_id

        def _override_admin_id(request: Request) -> UUID:
            actor_id = _override_active_profile_id(request)
            if self.world.profiles[actor_id].Role != "admin":
                raise HTTPException(
                    status_code=status.HTTP_403_FORBIDDEN,
                    detail="Admin access required",
                )
            return actor_id

        app.dependency_overrides[get_db] = _override_db
        app.dependency_overrides[get_current_parent_id] = _override_current_parent_id
        app.dependency_overrides[require_active_profile_id] = _override_active_profile_id
        app.dependency_overrides[require_parent_id] = _override_parent_id
        app.dependency_overrides[require_admin_id] = _override_admin_id

        # Deterministic offline AssistantService (Tier 0 KB + safe fallback, zero cloud keys).
        self.assistant_service = ViReadAssistantService(
            config=AssistantConfig(
                enabled=True,
                cloud_enabled=False,
                allow_public_llm=False,
                ollama_enabled=False,
            )
        )
        app.dependency_overrides[get_assistant_service] = lambda: self.assistant_service

        def _assistant_auth(credentials: HTTPAuthorizationCredentials | None):
            if credentials is None or credentials.credentials not in TOKEN_TO_ACTOR:
                raise HTTPException(status_code=401, detail="Invalid token")
            return TOKEN_TO_ACTOR[credentials.credentials]

        async def _fake_download_object_async(path: str, *, bucket_name: str | None = None) -> bytes:
            return await asyncio.to_thread(storage_download_object, path, bucket_name=bucket_name)

        self._patches = [
            patch("app.sever.probe_database_connection", AsyncMock(return_value={
                "ok": True,
                "dns_resolved": True,
                "ssl_enabled": True,
                "pool_class": "NullPool",
                "pooler_mode": "transaction",
                "latency_ms": 2,
            })),
            patch("app.sever.collect_remote_ocr_health", AsyncMock(return_value={
                "ready": True,
                "engines": {"paddleocr": {"status": "HEALTHY", "detail_status": "healthy"}},
                "workers": [],
                "queue": {},
                "heartbeat_ttl_seconds": 30,
            })),
            patch("app.sever.collect_ocr_health", return_value=[
                {"id": "paddleocr", "status": "HEALTHY", "detail_status": "healthy"},
            ]),
            patch("app.services.storage_service.get_supabase_admin_client", return_value=self.world.storage),
            patch("app.services.storage_service.download_object_async", side_effect=_fake_download_object_async),
            patch("app.services.book_cover_service.download_object_async", side_effect=_fake_download_object_async),
            patch("app.api.routes.reading.download_object_async", side_effect=_fake_download_object_async),
            patch("app.services.tts_audio_cache_service.download_object_async", side_effect=_fake_download_object_async),
            patch("app.api.routes.assistant.get_current_parent_id", side_effect=_assistant_auth),
            patch(
                "app.providers.supabase_auth_contact_provider.SupabaseAuthContactProvider.get_contact_info",
                AsyncMock(return_value={
                    "email": "parent.a@example.test",
                    "phone": None,
                    "email_verified": True,
                    "phone_verified": False,
                    "contact_info_status": "available",
                }),
            ),
            patch("app.services.global_tasks_service.notify_smart_studio_worker", create=True),
        ]
        # Ensure VIREAD_LOCAL_STORAGE_DIR does not hijack storage_service Storage mocks.
        self._env_patch = patch.dict(os.environ, {"VIREAD_LOCAL_STORAGE_DIR": ""}, clear=False)
        self._env_patch.start()
        for p in self._patches:
            p.start()

    def stop_backend_harness(self) -> None:
        for p in reversed(getattr(self, "_patches", [])):
            p.stop()
        if hasattr(self, "_env_patch"):
            self._env_patch.stop()
        app.dependency_overrides.clear()
        app.dependency_overrides.update(getattr(self, "_saved_overrides", {}))
        if hasattr(self, "_tmpdir"):
            self._tmpdir.cleanup()
        clear_rate_limits()
        clear_signed_url_cache()
        clear_auth_token_cache()
        invalidate_cached_role()
        clear_local_ocr_scan_cache()
        clear_tts_cache_runtime_metrics()
        clear_default_voice_orchestrators()
        vision_page_matcher.clear_descriptor_cache()


class _RelayServerMixin:
    """Real loopback ThreadingHTTPServer hosting frontend/api/parent-email-relay.py with mocked SMTP_SSL."""

    def start_relay_server(self) -> None:
        self.relay_secret = "test-relay-secret-32-chars-minimum-key!"
        self.relay_env = patch.dict(
            os.environ,
            {
                "EMAIL_RELAY_SECRET": self.relay_secret,
                "SMTP_USERNAME": "viread.sender@example.test",
                "SMTP_APP_PASSWORD": "abcd efgh ijkl mnop",
                "SMTP_FROM_EMAIL": "viread.sender@example.test",
            },
            clear=False,
        )
        self.relay_env.start()
        self.smtp_patch = patch.object(RELAY_MOD.smtplib, "SMTP_SSL")
        self.smtp_mock = self.smtp_patch.start()
        self.server = ThreadingHTTPServer(("127.0.0.1", 0), RELAY_MOD.handler)
        self.relay_port = self.server.server_address[1]
        self.relay_url = f"http://127.0.0.1:{self.relay_port}/api/parent-email-relay"
        self.server_thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.server_thread.start()

    def stop_relay_server(self) -> None:
        if hasattr(self, "server"):
            self.server.shutdown()
            self.server.server_close()
        if hasattr(self, "server_thread"):
            self.server_thread.join(timeout=2.0)
        if hasattr(self, "smtp_patch"):
            self.smtp_patch.stop()
        if hasattr(self, "relay_env"):
            self.relay_env.stop()

    def sign_headers(self, body: bytes, *, age_seconds: int = 0) -> dict[str, str]:
        ts = str(int(time.time()) - age_seconds)
        sig = hmac.new(
            self.relay_secret.encode(),
            ts.encode() + b"." + body,
            hashlib.sha256,
        ).hexdigest()
        return {
            "Content-Type": "message/rfc822",
            "X-Email-Relay-Timestamp": ts,
            "X-Email-Relay-Signature": sig,
        }

    @staticmethod
    def build_valid_rfc822(
        *,
        sender: str = "viread.sender@example.test",
        recipient: str = "parent@example.test",
        subject: str = "ViRead Test",
    ) -> bytes:
        with patch.object(email_transport.settings, "EMAIL_FROM_ADDRESS", sender):
            msg = email_transport.build_test_email_message(
                recipient=recipient, parent_name="Ba mẹ", delivery_id=uuid4()
            )
            msg.replace_header("Subject", subject)
            return msg.as_bytes()


# =============================================================================
# TIER 1: FEATURE COVERAGE (>= 45 subtests/checks across 9 feature groups)
# =============================================================================


class Tier1FeatureTests(unittest.TestCase, _BackendHarnessMixin, _RelayServerMixin):
    def setUp(self) -> None:
        self.start_backend_harness()
        self.start_relay_server()
        self.client = TestClient(app)

    def tearDown(self) -> None:
        self.stop_relay_server()
        self.stop_backend_harness()

    def test_t1_health_and_heavy_import_guard(self) -> None:
        # 1. In-process heavy import guard
        with self.subTest("in_process_heavy_import_guard"):
            self.assertEqual(_HEAVY_IMPORTED_ON_APP_LOAD, [])

        # 2. Static top-level AST check on app/sever.py (instant, deterministic, zero subprocess stall)
        with self.subTest("sever_ast_no_top_level_heavy_imports"):
            import ast

            sever_src = (BACKEND_ROOT / "app" / "sever.py").read_text(encoding="utf-8")
            tree = ast.parse(sever_src)
            top_imports: set[str] = set()
            for node in tree.body:
                if isinstance(node, ast.Import):
                    for alias in node.names:
                        top_imports.add(alias.name.split(".")[0])
                elif isinstance(node, ast.ImportFrom) and node.module:
                    top_imports.add(node.module)
                    top_imports.add(node.module.split(".")[0])
            forbidden = set(HEAVY_ML_MODULES) | {"app.services.ocr_engine"}
            self.assertEqual(top_imports & forbidden, set())

        # 3. GET /health status & payload
        with self.subTest("health_payload_ok"):
            resp = self.client.get("/health")
            self.assertEqual(resp.status_code, 200)
            body = resp.json()
            self.assertEqual(body["status"], "ok")
            self.assertEqual(body["database"]["status"], "healthy")
            self.assertIn("ocr", body)

        # 4. Security headers attached by request middleware
        with self.subTest("health_security_headers"):
            resp = self.client.get("/health")
            self.assertTrue(resp.headers.get("X-Request-ID"))
            self.assertEqual(resp.headers.get("X-Content-Type-Options"), "nosniff")
            self.assertEqual(resp.headers.get("X-Frame-Options"), "DENY")
            self.assertEqual(resp.headers.get("Referrer-Policy"), "no-referrer")

        # 5. Authorization header triggers Cache-Control: no-store
        with self.subTest("auth_header_no_store"):
            resp = self.client.get("/health", headers={"Authorization": "Bearer token-parent-a"})
            self.assertEqual(resp.status_code, 200)
            self.assertEqual(resp.headers.get("Cache-Control"), "no-store")

    def test_t1_f1_assistant_routes_all_roles_and_status(self) -> None:
        # 1-3: POST /assistant/chat for public, parent, admin
        for label, auth_header, expected_scope in (
            ("public", {}, "public"),
            ("parent", {"Authorization": "Bearer token-parent-a"}, "parent"),
            ("admin", {"Authorization": "Bearer token-admin"}, "admin"),
        ):
            with self.subTest(chat_role=label):
                resp = self.client.post(
                    "/assistant/chat",
                    headers=auth_header,
                    json={
                        "message": "Hướng dẫn đọc sách trên ViRead",
                        "current_path": "/books",
                        "locale": "vi",
                        "bandwidth_profile": "high",
                    },
                )
                self.assertEqual(resp.status_code, 200, resp.text)
                data = resp.json()
                self.assertEqual(data["role_scope"], expected_scope)
                self.assertTrue(data["reply"])
                self.assertIn(data["source_tier"], ("tier_0_kb", "tier_3_fallback", "cache"))

        # 4. GET /assistant/context across roles
        with self.subTest("context_suggestions_parent"):
            resp = self.client.get(
                "/assistant/context?path=/books&locale=vi",
                headers={"Authorization": "Bearer token-parent-a"},
            )
            self.assertEqual(resp.status_code, 200)
            data = resp.json()
            self.assertEqual(data["current_path"], "/books")
            self.assertIsInstance(data["suggested_prompts"], list)
            self.assertIsInstance(data["quick_actions"], list)

        # 5. GET /assistant/status exposes zero secrets
        with self.subTest("status_exposes_zero_secrets"):
            resp = self.client.get("/assistant/status")
            self.assertEqual(resp.status_code, 200)
            text = resp.text.lower()
            self.assertNotIn("api_key", text)
            self.assertNotIn("secret", text)
            self.assertIn("tiers", resp.json())

    def test_t1_f2_avatar_upload_normalize_and_delete(self) -> None:
        self.world.active_actor_id = PARENT_A_ID
        for fmt, mime in (("PNG", "image/png"), ("JPEG", "image/jpeg"), ("WEBP", "image/webp")):
            with self.subTest(parent_avatar_format=fmt):
                resp = self.client.post(
                    "/profiles/me/avatar",
                    files={"file": (f"avatar.{fmt.lower()}", _make_image_bytes(fmt), mime)},
                )
                self.assertEqual(resp.status_code, 200, resp.text)
                body = resp.json()
                self.assertTrue(body["avatar_url"].startswith("https://"))
                # Verify uploaded object in Storage is normalized WebP
                uploaded_key = self.world.storage.upload_calls[-1]
                self.assertTrue(uploaded_key[1].endswith(".webp"))
                with Image.open(io.BytesIO(self.world.storage.objects[uploaded_key])) as img:
                    self.assertEqual(img.format, "WEBP")

        with self.subTest("delete_parent_avatar"):
            resp = self.client.delete("/profiles/me/avatar")
            self.assertEqual(resp.status_code, 200)
            self.assertIsNone(resp.json()["avatar_url"])

        with self.subTest("upload_and_delete_child_avatar"):
            up = self.client.post(
                f"/profiles/children/{CHILD_A_ID}/avatar",
                files={"file": ("kid.png", _make_image_bytes("PNG"), "image/png")},
            )
            self.assertEqual(up.status_code, 200, up.text)
            self.assertTrue(up.json()["avatar_url"].startswith("https://"))
            rm = self.client.delete(f"/profiles/children/{CHILD_A_ID}/avatar")
            self.assertEqual(rm.status_code, 200)
            self.assertIsNone(rm.json()["avatar_url"])

    def test_t1_f3_profiles_and_dashboard_summary_batched_signing(self) -> None:
        self.world.active_actor_id = PARENT_A_ID

        with self.subTest("get_profiles_me"):
            resp = self.client.get("/profiles/me")
            self.assertEqual(resp.status_code, 200, resp.text)
            body = resp.json()
            self.assertEqual(body["id"], str(PARENT_A_ID))
            self.assertTrue(body["avatar_url"].startswith("https://"))

        with self.subTest("get_profiles_children"):
            resp = self.client.get("/profiles/children")
            self.assertEqual(resp.status_code, 200, resp.text)
            kids = resp.json()
            self.assertEqual(len(kids), 1)
            self.assertTrue(kids[0]["avatar_url"].startswith("https://"))

        with self.subTest("child_crud_create_get_delete"):
            created = self.client.post(
                "/profiles/children",
                json={"alias": "Bé Cún", "grade": 1, "settings": {}},
            )
            self.assertEqual(created.status_code, 201, created.text)
            cid = created.json()["id"]
            fetched = self.client.get(f"/profiles/children/{cid}")
            self.assertEqual(fetched.status_code, 200)
            self.assertEqual(fetched.json()["alias"], "Bé Cún")
            deleted = self.client.delete(f"/profiles/children/{cid}")
            self.assertEqual(deleted.status_code, 204)

        with self.subTest("get_dashboard_summary"):
            resp = self.client.get("/profiles/dashboard-summary")
            self.assertEqual(resp.status_code, 200, resp.text)
            summary = resp.json()
            self.assertEqual(summary["profile"]["id"], str(PARENT_A_ID))
            self.assertEqual(len(summary["children"]), 1)
            self.assertIn("latest_sessions_by_child", summary)

        with self.subTest("batched_avatar_signing_uses_single_call_for_multiple_children"):
            # Add second child with avatar and clear signed URL cache to observe batching
            clear_signed_url_cache()
            c2_id = uuid4()
            c2_path = f"children/{c2_id}/avatar/a.webp"
            self.world.children[c2_id] = ChildProfile(
                Id=c2_id,
                ParentId=PARENT_A_ID,
                Alias="Bé Thứ Hai",
                Grade=2,
                Settings={},
                AvatarPath=c2_path,
                CreatedAt=datetime.now(timezone.utc),
            )
            self.world.storage.objects[(os.environ["SUPABASE_AVATAR_BUCKET"], c2_path)] = self.world.cover_webp
            self.world._sync_profile_children()
            self.world.storage.sign_calls = 0

            resp = self.client.get("/profiles/children")
            self.assertEqual(resp.status_code, 200)
            self.assertEqual(len(resp.json()), 2)
            self.assertEqual(self.world.storage.sign_calls, 1)

    def test_t1_f4_studio_tasks_and_tts_cache_headers(self) -> None:
        self.world.active_actor_id = PARENT_A_ID

        with self.subTest("create_and_deduplicate_studio_task"):
            payload = {
                "job_type": "COVER_GENERATE",
                "book_id": str(PRIVATE_BOOK_A_ID),
                "input_hash": "abcd1234abcd1234",
                "idempotency_key": "e2e-task-1",
            }
            r1 = self.client.post("/studio/tasks", json=payload)
            self.assertEqual(r1.status_code, 201, r1.text)
            self.assertFalse(r1.json()["deduplicated"])
            r2 = self.client.post("/studio/tasks", json=payload)
            self.assertEqual(r2.status_code, 200, r2.text)
            self.assertTrue(r2.json()["deduplicated"])

        with self.subTest("list_studio_tasks"):
            resp = self.client.get("/studio/tasks")
            self.assertEqual(resp.status_code, 200, resp.text)
            self.assertGreaterEqual(len(resp.json()["tasks"]), 1)

        with self.subTest("get_studio_capabilities"):
            resp = self.client.get("/studio/capabilities")
            self.assertEqual(resp.status_code, 200, resp.text)
            self.assertIn("providers", resp.json())
            self.assertNotIn("secret", resp.text.lower())

        # TTS cache MISS then HIT via /voice/text-to-speech
        tts_repo = _InMemoryTtsRepo(self.world)
        fake_local = MagicMock()
        fake_local.synthesize = AsyncMock(
            return_value=LocalSynthesizedAudio(
                content=b"ID3\x04\x00e2e-tts-audio",
                content_type="audio/mpeg",
                resolved_voice_id=DEFAULT_LOCAL_VOICE_ID,
                region="north",
                model_version=LOCAL_TTS_MODEL_VERSION,
            )
        )
        orch = VoiceOrchestrator(local_provider=fake_local)

        def _make_svc(db_arg):
            s = TtsAudioCacheService(db_arg)
            s.repo = tts_repo  # type: ignore[assignment]
            return s

        with (
            patch("app.api.routes.voice.get_voice_orchestrator", return_value=orch),
            patch("app.services.voice_orchestrator.TtsAudioCacheService", side_effect=_make_svc),
        ):
            seed_svc = _make_svc(self.db)
            asyncio.run(
                seed_svc.store_cached_audio(
                    target=ResolvedCacheTarget("CATALOG", None, CATALOG_BOOK_ID, CATALOG_PAGE_1_ID, None, True),
                    normalized_text=canonical_tts_text("Bé"),
                    voice_id=DEFAULT_LOCAL_VOICE_ID,
                    model_version=LOCAL_TTS_MODEL_VERSION,
                    speed=1.0,
                    audio_bytes=b"ID3\x04\x00e2e-cached-be",
                    source_content_type="audio/mpeg",
                )
            )
            with self.subTest("tts_cache_miss"):
                r_miss = self.client.post(
                    "/voice/text-to-speech",
                    json={
                        "text": "Xin chào",
                        "voice_id": DEFAULT_LOCAL_VOICE_ID,
                        "speed": 1.0,
                        "book_id": str(CATALOG_BOOK_ID),
                        "page_id": str(CATALOG_PAGE_1_ID),
                    },
                )
                self.assertEqual(r_miss.status_code, 200, r_miss.text)
                self.assertEqual(r_miss.headers.get("X-TTS-Cache"), "MISS")
                self.assertEqual(r_miss.headers.get("Cache-Control"), "no-store")

            with self.subTest("tts_cache_hit"):
                fake_local.synthesize.reset_mock()
                r_hit = self.client.post(
                    "/voice/text-to-speech",
                    json={
                        "text": "Bé",
                        "voice_id": DEFAULT_LOCAL_VOICE_ID,
                        "speed": 1.0,
                        "book_id": str(CATALOG_BOOK_ID),
                        "page_id": str(CATALOG_PAGE_1_ID),
                    },
                )
                self.assertEqual(r_hit.status_code, 200, r_hit.text)
                self.assertEqual(r_hit.headers.get("X-TTS-Cache"), "HIT")
                self.assertEqual(r_hit.content, b"ID3\x04\x00e2e-cached-be")
                fake_local.synthesize.assert_not_awaited()

    def test_t1_f5_f6_f8_books_catalog_media_and_sql_eligibility(self) -> None:
        self.world.active_actor_id = PARENT_A_ID

        with self.subTest("public_books_list"):
            resp = self.client.get("/books/")
            self.assertEqual(resp.status_code, 200)
            ids = {b["Id"] for b in resp.json()}
            self.assertIn(str(CATALOG_BOOK_ID), ids)
            self.assertNotIn(str(PRIVATE_BOOK_A_ID), ids)

        with self.subTest("authenticated_book_pages_signed"):
            resp = self.client.get(
                f"/books/{CATALOG_BOOK_ID}/pages",
                headers={"Authorization": "Bearer token-parent-a"},
            )
            self.assertEqual(resp.status_code, 200, resp.text)
            pages = resp.json()
            self.assertEqual(len(pages), 1)
            self.assertTrue(pages[0]["ImagePath"].startswith("https://"))

        with self.subTest("catalog_list_with_private"):
            resp = self.client.get("/books/catalog?include_private=true")
            self.assertEqual(resp.status_code, 200, resp.text)
            self.assertEqual(resp.headers.get("Cache-Control"), "private, no-store, max-age=0")
            ids = {b["id"] for b in resp.json()}
            self.assertIn(str(CATALOG_BOOK_ID), ids)
            self.assertIn(str(PRIVATE_BOOK_A_ID), ids)

        with self.subTest("catalog_book_detail"):
            resp = self.client.get(f"/books/catalog/{CATALOG_BOOK_ID}")
            self.assertEqual(resp.status_code, 200, resp.text)
            self.assertEqual(resp.json()["id"], str(CATALOG_BOOK_ID))

        with self.subTest("catalog_preview_returns_urls"):
            resp = self.client.get(f"/books/catalog/{CATALOG_BOOK_ID}/preview")
            self.assertEqual(resp.status_code, 200, resp.text)
            self.assertTrue(resp.json()[0]["preview_url"].startswith("https://"))

        with self.subTest("private_studio_asset_media_proxy_streams_with_no_store"):
            resp = self.client.get(f"/studio/assets/{PRIVATE_COVER_ASSET_ID}/media")
            self.assertEqual(resp.status_code, 200, resp.text)
            self.assertIn("no-store", resp.headers.get("Cache-Control", ""))
            self.assertEqual(resp.content, self.world.cover_webp)

        with self.subTest("catalog_eligibility_expression_compiles"):
            stmt = select(Book).where(CatalogRepository.eligible_book())
            sql = str(stmt)
            self.assertIn("books", sql.lower())

    @unittest.skipIf(HARNESS_ONLY, "Skipped when VIREAD_E2E_HARNESS_ONLY=1 ([M2-target])")
    def test_t1_m2_target_direct_catalog_signed_urls_and_preview_cache_reuse(self) -> None:
        self.world.active_actor_id = PARENT_A_ID

        with self.subTest("M2_catalog_cover_url_direct_https_not_studio_proxy"):
            resp = self.client.get("/books/catalog?include_private=true")
            self.assertEqual(resp.status_code, 200)
            by_id = {b["id"]: b for b in resp.json()}
            cat_cover = by_id[str(CATALOG_BOOK_ID)]["cover_url"]
            priv_cover = by_id[str(PRIVATE_BOOK_A_ID)]["cover_url"]
            self.assertIsNotNone(cat_cover)
            self.assertTrue(cat_cover.startswith("https://"), f"Expected direct signed HTTPS URL, got {cat_cover}")
            self.assertNotIn("/studio/assets/", cat_cover)
            self.assertEqual(priv_cover, f"/studio/assets/{PRIVATE_COVER_ASSET_ID}/media")

        with self.subTest("M2_catalog_preview_second_call_reuses_signed_url_cache"):
            clear_signed_url_cache()
            self.world.storage.sign_calls = 0
            r1 = self.client.get(f"/books/catalog/{CATALOG_BOOK_ID}/preview")
            self.assertEqual(r1.status_code, 200)
            calls_after_first = self.world.storage.sign_calls
            self.assertGreater(calls_after_first, 0)
            r2 = self.client.get(f"/books/catalog/{CATALOG_BOOK_ID}/preview")
            self.assertEqual(r2.status_code, 200)
            self.assertEqual(self.world.storage.sign_calls, calls_after_first)
            self.assertEqual(r1.json()[0]["preview_url"], r2.json()[0]["preview_url"])

        with self.subTest("M2_reading_session_page_direct_illustration_and_cached_page_image"):
            sess_resp = self.client.post(
                "/reading/sessions",
                json={"ChildId": str(CHILD_A_ID), "BookId": str(CATALOG_BOOK_ID)},
            )
            self.assertEqual(sess_resp.status_code, 200, sess_resp.text)
            sid = sess_resp.json()["Id"]

            clear_signed_url_cache()
            self.world.storage.sign_calls = 0
            p1 = self.client.get(f"/reading/sessions/{sid}/page")
            self.assertEqual(p1.status_code, 200, p1.text)
            body1 = p1.json()
            self.assertTrue(body1["image_url"].startswith("https://"))
            self.assertIsNotNone(body1["illustration_url"])
            self.assertTrue(
                body1["illustration_url"].startswith("https://"),
                f"Expected direct signed HTTPS illustration_url, got {body1['illustration_url']}",
            )
            self.assertNotIn("/studio/assets/", body1["illustration_url"])
            calls_after_first = self.world.storage.sign_calls

            p2 = self.client.get(f"/reading/sessions/{sid}/page")
            self.assertEqual(p2.status_code, 200)
            self.assertEqual(self.world.storage.sign_calls, calls_after_first)

    def test_t1_f7_ocr_scan_and_camera_match_baseline(self) -> None:
        self.world.active_actor_id = PARENT_A_ID

        class _FakeOcrRepo:
            def __init__(self, _db):
                self._world = None

            async def profile_role(self, actor_id: UUID):
                prof = self_outer.world.profiles.get(actor_id)
                return prof.Role if prof and prof.Active == 1 else None

            async def child_belongs_to_parent(self, child_id: UUID, actor_id: UUID):
                c = self_outer.world.children.get(child_id)
                return c is not None and c.ParentId == actor_id

            async def eligible_verified_pages(self, book_id: UUID | None = None, *, ocr_tokens=None, limit=None):
                rows = []
                for p in self_outer.world.pages.values():
                    b = self_outer.world.books[p.BookId]
                    if b.VisibilityScope != "CATALOG":
                        continue
                    if book_id is not None and b.Id != book_id:
                        continue
                    rows.append((b, p, self_outer.world.revisions[p.CurrentVerifiedRevisionId]))
                return rows

            async def revision_words(self, revision_id: UUID):
                return list(self_outer.world.words.get(revision_id, []))

        self_outer = self

        with (
            patch("app.api.routes.reading.LocalOcrScanRepository", side_effect=_FakeOcrRepo),
            patch(
                "app.services.local_ocr_scan_service.extract_text_and_boxes",
                return_value=_sample_ocr_output("Bé An đọc sách buổi sáng"),
            ),
        ):
            with self.subTest("scan_page_ocr_valid_png"):
                resp = self.client.post(
                    "/reading/scan-page-ocr",
                    data={"child_id": str(CHILD_A_ID)},
                    files={"file": ("page.png", _make_image_bytes("PNG"), "image/png")},
                )
                self.assertEqual(resp.status_code, 200, resp.text)
                body = resp.json()
                self.assertEqual(body["status"], "SUCCEEDED")
                self.assertFalse(body["provenance"]["cloud_ocr_used"])

            with self.subTest("scan_page_ocr_matches_verified_page"):
                self.assertTrue(body["matched"])
                self.assertEqual(body["matched_book_id"], str(CATALOG_BOOK_ID))

        with self.subTest("camera_match_global_valid_png"):
            resp = self.client.post(
                "/reading/match-page",
                files={"file": ("cam.png", self.world.page_png_1, "image/png")},
            )
            self.assertEqual(resp.status_code, 200, resp.text)
            body = resp.json()
            self.assertTrue(body["framing_valid"])
            self.assertTrue(body["matched"])
            self.assertEqual(body["book_id"], str(CATALOG_BOOK_ID))

        with self.subTest("camera_match_book_scoped_valid_png"):
            resp = self.client.post(
                f"/reading/books/{CATALOG_BOOK_2_ID}/match-page",
                files={"file": ("cam2.png", self.world.page_png_2, "image/png")},
            )
            self.assertEqual(resp.status_code, 200, resp.text)
            body = resp.json()
            self.assertTrue(body["matched"])
            self.assertEqual(body["book_id"], str(CATALOG_BOOK_2_ID))

    @unittest.skipIf(HARNESS_ONLY, "Skipped when VIREAD_E2E_HARNESS_ONLY=1 ([M2-target])")
    def test_t1_f7_m2_target_ocr_scan_repository_bounds_eligible_pages_query(self) -> None:
        captured_sql: list[str] = []

        class _QuerySpyDb:
            async def execute(self, statement):
                captured_sql.append(str(statement).lower())
                return _FakeExecuteResult([])

        repo = LocalOcrScanRepository(_QuerySpyDb())  # type: ignore[arg-type]
        asyncio.run(repo.eligible_verified_pages())
        self.assertEqual(len(captured_sql), 1)
        self.assertIn("limit", captured_sql[0], f"Expected bounded LIMIT on eligible_verified_pages SQL: {captured_sql[0]}")

    def test_t1_f11_python_email_relay_loopback_http(self) -> None:
        raw_mail = self.build_valid_rfc822()
        headers = self.sign_headers(raw_mail)

        with httpx.Client(timeout=5.0) as http:
            resp = http.post(self.relay_url, content=raw_mail, headers=headers)

        with self.subTest("relay_returns_200_sent"):
            self.assertEqual(resp.status_code, 200, resp.text)
            self.assertEqual(resp.json(), {"status": "SENT"})

        with self.subTest("relay_sets_no_store_and_json_headers"):
            self.assertEqual(resp.headers.get("Cache-Control"), "no-store")
            self.assertEqual(resp.headers.get("Content-Type"), "application/json")

        with self.subTest("smtp_ssl_strictly_gmail_465"):
            self.smtp_mock.assert_called_once()
            args, kwargs = self.smtp_mock.call_args
            self.assertEqual(args, ("smtp.gmail.com", 465))
            self.assertTrue(kwargs["context"].check_hostname)

        smtp_client = self.smtp_mock.return_value.__enter__.return_value
        with self.subTest("smtp_login_strips_app_password_spaces"):
            smtp_client.login.assert_called_once_with("viread.sender@example.test", "abcdefghijklmnop")

        with self.subTest("smtp_sendmail_exact_bytes_single_recipient"):
            smtp_client.sendmail.assert_called_once_with(
                "viread.sender@example.test", ["parent@example.test"], raw_mail
            )


# =============================================================================
# TIER 2: BOUNDARY & CORNER CASES (>= 38 checks across feature groups)
# =============================================================================


class Tier2BoundaryTests(unittest.TestCase, _BackendHarnessMixin, _RelayServerMixin):
    def setUp(self) -> None:
        self.start_backend_harness()
        self.start_relay_server()
        self.client = TestClient(app)

    def tearDown(self) -> None:
        self.stop_relay_server()
        self.stop_backend_harness()

    def test_t2_parent_private_isolation_fails_closed(self) -> None:
        self.world.active_actor_id = PARENT_B_ID

        cases = (
            ("catalog_private_detail", "GET", f"/books/catalog/{PRIVATE_BOOK_A_ID}"),
            ("catalog_private_preview", "GET", f"/books/catalog/{PRIVATE_BOOK_A_ID}/preview"),
            ("public_private_pages", "GET", f"/books/{PRIVATE_BOOK_A_ID}/pages"),
            ("studio_private_asset_media", "GET", f"/studio/assets/{PRIVATE_COVER_ASSET_ID}/media"),
            ("private_book_page_image", "GET", f"/books/my-books/{PRIVATE_BOOK_A_ID}/pages/{PRIVATE_PAGE_A_ID}/image"),
            ("child_profile_cross_tenant", "GET", f"/profiles/children/{CHILD_A_ID}"),
        )
        for label, method, path in cases:
            with self.subTest(isolation=label):
                resp = self.client.request(method, path)
                self.assertIn(resp.status_code, (403, 404), f"{label} -> {resp.status_code}: {resp.text}")

        with self.subTest("private_tts_scope_cross_tenant_404"):
            tts_repo = _InMemoryTtsRepo(self.world)
            orch = VoiceOrchestrator(local_provider=MagicMock())

            def _make_svc(db_arg):
                s = TtsAudioCacheService(db_arg)
                s.repo = tts_repo  # type: ignore[assignment]
                return s

            with (
                patch("app.api.routes.voice.get_voice_orchestrator", return_value=orch),
                patch("app.services.voice_orchestrator.TtsAudioCacheService", side_effect=_make_svc),
            ):
                resp = self.client.post(
                    "/voice/text-to-speech",
                    json={
                        "text": "Bé An",
                        "voice_id": DEFAULT_LOCAL_VOICE_ID,
                        "book_id": str(PRIVATE_BOOK_A_ID),
                        "page_id": str(PRIVATE_PAGE_A_ID),
                        "cache_scope": "PRIVATE",
                    },
                )
                self.assertEqual(resp.status_code, 404, resp.text)

    def test_t2_unauthenticated_and_suspended_profile_boundaries(self) -> None:
        with self.subTest("unauth_catalog_pages_omits_signed_urls"):
            resp = self.client.get(f"/books/{CATALOG_BOOK_ID}/pages")
            self.assertEqual(resp.status_code, 200, resp.text)
            for page in resp.json():
                self.assertEqual(page["ImagePath"], "")

        with self.subTest("unauth_private_book_pages_404"):
            resp = self.client.get(f"/books/{PRIVATE_BOOK_A_ID}/pages")
            self.assertEqual(resp.status_code, 404)

        with self.subTest("malformed_auth_header_on_book_pages_401"):
            resp = self.client.get(
                f"/books/{CATALOG_BOOK_ID}/pages",
                headers={"Authorization": "Basic abc123"},
            )
            self.assertEqual(resp.status_code, 401)

        self.world.active_actor_id = SUSPENDED_PARENT_ID
        with self.subTest("suspended_profile_me_403"):
            resp = self.client.get("/profiles/me")
            self.assertEqual(resp.status_code, 403)
            self.assertEqual(resp.json()["detail"]["code"], "ACCESS_DENIED")

        with self.subTest("suspended_profile_dashboard_summary_403"):
            resp = self.client.get("/profiles/dashboard-summary")
            self.assertEqual(resp.status_code, 403)

        with self.subTest("suspended_profile_avatar_403"):
            resp = self.client.post(
                "/profiles/me/avatar",
                files={"file": ("a.png", _make_image_bytes("PNG"), "image/png")},
            )
            self.assertEqual(resp.status_code, 403)

    def test_t2_invalid_oversized_media_validation_and_rate_limits(self) -> None:
        self.world.active_actor_id = PARENT_A_ID

        with self.subTest("avatar_svg_magic_bytes_rejected_422"):
            resp = self.client.post(
                "/profiles/me/avatar",
                files={"file": ("evil.png", b"<svg onload=alert(1)></svg>", "image/png")},
            )
            self.assertEqual(resp.status_code, 422)

        with self.subTest("avatar_oversized_5mib_rejected_413"):
            resp = self.client.post(
                "/profiles/me/avatar",
                files={"file": ("big.png", b"x" * (5 * 1024 * 1024 + 1), "image/png")},
            )
            self.assertEqual(resp.status_code, 413)

        with self.subTest("avatar_empty_rejected_422"):
            resp = self.client.post(
                "/profiles/me/avatar",
                files={"file": ("empty.png", b"", "image/png")},
            )
            self.assertEqual(resp.status_code, 422)

        with self.subTest("camera_frame_oversized_8mib_rejected_413"):
            resp = self.client.post(
                "/reading/match-page",
                files={"file": ("cam.png", b"x" * (8 * 1024 * 1024 + 1), "image/png")},
            )
            self.assertEqual(resp.status_code, 413)

        with self.subTest("camera_frame_fake_magic_bytes_422"):
            resp = self.client.post(
                "/reading/match-page",
                files={"file": ("cam.png", b"<svg>bad</svg>", "image/png")},
            )
            self.assertEqual(resp.status_code, 422)

        with self.subTest("ocr_scan_oversized_12mib_rejected_413"):
            resp = self.client.post(
                "/reading/scan-page-ocr",
                files={"file": ("scan.png", b"x" * (MAX_SCAN_IMAGE_BYTES + 1), "image/png")},
            )
            self.assertEqual(resp.status_code, 413)

        with self.subTest("ocr_scan_svg_rejected_415_or_422"):
            resp = self.client.post(
                "/reading/scan-page-ocr",
                files={"file": ("scan.svg", b"<svg xmlns='http://www.w3.org/2000/svg'/>", "image/svg+xml")},
            )
            self.assertIn(resp.status_code, (415, 422))

        with self.subTest("assistant_chat_extra_forbid_422"):
            resp = self.client.post(
                "/assistant/chat",
                json={"message": "Xin chào", "unexpected_field": "boom"},
            )
            self.assertEqual(resp.status_code, 422)

        with self.subTest("assistant_public_rate_limit_429_with_retry_after"):
            clear_rate_limits()
            last = None
            for idx in range(11):
                last = self.client.post(
                    "/assistant/chat",
                    json={"message": f"Câu hỏi {idx}", "current_path": "/"},
                )
            assert last is not None
            self.assertEqual(last.status_code, 429)
            self.assertEqual(last.json()["detail"]["code"], "RATE_LIMIT_EXCEEDED")
            self.assertTrue(last.headers.get("Retry-After"))

    def test_t2_relay_security_and_error_corners_via_http(self) -> None:
        raw_mail = self.build_valid_rfc822()
        with httpx.Client(timeout=5.0) as http:
            with self.subTest("missing_secret_503"):
                with patch.dict(os.environ, {"EMAIL_RELAY_SECRET": ""}, clear=False):
                    r = http.post(self.relay_url, content=raw_mail, headers=self.sign_headers(raw_mail))
                    self.assertEqual(r.status_code, 503)
                    self.assertEqual(r.json()["code"], "RELAY_NOT_CONFIGURED")

            with self.subTest("short_secret_503"):
                with patch.dict(os.environ, {"EMAIL_RELAY_SECRET": "too-short"}, clear=False):
                    r = http.post(self.relay_url, content=raw_mail, headers=self.sign_headers(raw_mail))
                    self.assertEqual(r.status_code, 503)
                    self.assertEqual(r.json()["code"], "RELAY_NOT_CONFIGURED")

            with self.subTest("missing_smtp_config_503"):
                with patch.dict(os.environ, {"SMTP_APP_PASSWORD": ""}, clear=False):
                    r = http.post(self.relay_url, content=raw_mail, headers=self.sign_headers(raw_mail))
                    self.assertEqual(r.status_code, 503)
                    self.assertEqual(r.json()["code"], "SMTP_NOT_CONFIGURED")

            with self.subTest("expired_past_timestamp_401"):
                r = http.post(self.relay_url, content=raw_mail, headers=self.sign_headers(raw_mail, age_seconds=65))
                self.assertEqual(r.status_code, 401)
                self.assertEqual(r.json()["code"], "RELAY_UNAUTHORIZED")

            with self.subTest("expired_future_timestamp_401"):
                r = http.post(self.relay_url, content=raw_mail, headers=self.sign_headers(raw_mail, age_seconds=-65))
                self.assertEqual(r.status_code, 401)

            with self.subTest("bad_hmac_signature_401"):
                h = self.sign_headers(raw_mail)
                h["X-Email-Relay-Signature"] = "0" * 64
                r = http.post(self.relay_url, content=raw_mail, headers=h)
                self.assertEqual(r.status_code, 401)

            with self.subTest("empty_body_413"):
                r = http.post(self.relay_url, content=b"", headers=self.sign_headers(b""))
                self.assertEqual(r.status_code, 413)
                self.assertEqual(r.json()["code"], "MESSAGE_SIZE_INVALID")

            with self.subTest("oversized_body_gt_256kib_413"):
                huge = b"a" * (256 * 1024 + 1)
                huge_headers = self.sign_headers(huge)
                self.assertEqual(
                    RELAY_MOD.deliver(
                        huge,
                        huge_headers["X-Email-Relay-Timestamp"],
                        huge_headers["X-Email-Relay-Signature"],
                    ),
                    (413, {"code": "MESSAGE_SIZE_INVALID"}),
                )
                with socket.create_connection(("127.0.0.1", self.relay_port), timeout=5.0) as sock:
                    req = (
                        f"POST /api/parent-email-relay HTTP/1.1\r\n"
                        f"Host: 127.0.0.1:{self.relay_port}\r\n"
                        f"Content-Length: {len(huge)}\r\n"
                        f"Connection: close\r\n\r\n"
                    ).encode("ascii")
                    sock.sendall(req)
                    raw_resp = b""
                    while True:
                        chunk = sock.recv(4096)
                        if not chunk:
                            break
                        raw_resp += chunk
                self.assertIn(b"413", raw_resp.splitlines()[0])
                self.assertIn(b"MESSAGE_SIZE_INVALID", raw_resp)

            with self.subTest("mismatched_from_header_422"):
                bad_from = self.build_valid_rfc822(sender="attacker@example.test")
                r = http.post(self.relay_url, content=bad_from, headers=self.sign_headers(bad_from))
                self.assertEqual(r.status_code, 422)
                self.assertEqual(r.json()["code"], "MESSAGE_ENVELOPE_INVALID")

            for label, smuggled in (
                (
                    "smuggled_from_adjacent_addr_422",
                    b"From: <viread.sender@example.test><evil@example.test>\r\n"
                    b"To: parent@example.test\r\n"
                    b"Subject: Test\r\n\r\nBody",
                ),
                (
                    "smuggled_to_adjacent_addr_422",
                    b"From: viread.sender@example.test\r\n"
                    b"To: <parent@example.test><evil@example.test>\r\n"
                    b"Subject: Test\r\n\r\nBody",
                ),
            ):
                with self.subTest(label):
                    r = http.post(self.relay_url, content=smuggled, headers=self.sign_headers(smuggled))
                    self.assertEqual(r.status_code, 422)
                    self.assertEqual(r.json()["code"], "MESSAGE_ENVELOPE_INVALID")

            for hdr_name in ("Cc", "Bcc", "Resent-From"):
                with self.subTest(forbidden_header=hdr_name):
                    extra_hdr = f"{hdr_name}: extra@example.test\r\n".encode() + raw_mail
                    r = http.post(self.relay_url, content=extra_hdr, headers=self.sign_headers(extra_hdr))
                    self.assertEqual(r.status_code, 422)
                    self.assertEqual(r.json()["code"], "MESSAGE_ENVELOPE_INVALID")

            with self.subTest("smtp_auth_error_422"):
                self.smtp_mock.side_effect = smtplib.SMTPAuthenticationError(535, b"bad auth")
                r = http.post(self.relay_url, content=raw_mail, headers=self.sign_headers(raw_mail))
                self.assertEqual(r.status_code, 422)
                self.assertEqual(r.json()["code"], "SMTP_REJECTED")

            with self.subTest("smtp_exception_or_oserror_503"):
                self.smtp_mock.side_effect = OSError("network unreachable")
                r = http.post(self.relay_url, content=raw_mail, headers=self.sign_headers(raw_mail))
                self.assertEqual(r.status_code, 503)
                self.assertEqual(r.json()["code"], "SMTP_UNAVAILABLE")

    def test_t2_camera_match_candidate_clamp_and_task_bounds(self) -> None:
        with self.subTest("clamp_min_1"):
            with patch.dict(os.environ, {"VIREAD_MAX_MATCH_PAGE_CANDIDATES": "0"}, clear=False):
                self.assertEqual(_bounded_match_limit(MAX_MATCH_PAGE_GLOBAL_CANDIDATES), 1)

        with self.subTest("clamp_max_200"):
            with patch.dict(os.environ, {"VIREAD_MAX_MATCH_PAGE_CANDIDATES": "999"}, clear=False):
                self.assertEqual(_bounded_match_limit(MAX_MATCH_PAGE_GLOBAL_CANDIDATES), 200)

        with self.subTest("invalid_env_falls_back_to_default"):
            with patch.dict(os.environ, {"VIREAD_MAX_MATCH_PAGE_CANDIDATES": "invalid"}, clear=False):
                self.assertEqual(_bounded_match_limit(MAX_MATCH_PAGE_GLOBAL_CANDIDATES), 60)

        with self.subTest("global_camera_match_applies_env_limit_to_query"):
            self.world.active_actor_id = PARENT_A_ID
            with patch.dict(os.environ, {"VIREAD_MAX_MATCH_PAGE_CANDIDATES": "5"}, clear=False):
                resp = self.client.post(
                    "/reading/match-page",
                    files={"file": ("cam.png", self.world.page_png_1, "image/png")},
                )
                self.assertEqual(resp.status_code, 200)
                self.assertEqual(self.world.last_camera_query_limit, 5)

        with self.subTest("studio_task_honest_progress_bounds_422"):
            self.world.active_actor_id = PARENT_A_ID
            resp = self.client.post(
                "/studio/tasks",
                json={
                    "job_type": "COVER_GENERATE",
                    "book_id": str(PRIVATE_BOOK_A_ID),
                    "input_hash": "abcd1234abcd1234",
                    "idempotency_key": "bad-progress-1",
                    "progress_completed": 5,
                    "progress_total": 3,
                },
            )
            self.assertEqual(resp.status_code, 422)


# =============================================================================
# TIER 3: CROSS-FEATURE / PAIRWISE INTEGRATION
# =============================================================================


class Tier3IntegrationTests(unittest.IsolatedAsyncioTestCase, _BackendHarnessMixin, _RelayServerMixin):
    async def asyncSetUp(self) -> None:
        self.start_backend_harness()
        self.start_relay_server()

    async def asyncTearDown(self) -> None:
        self.stop_relay_server()
        self.stop_backend_harness()

    @unittest.skipIf(HARNESS_ONLY, "Skipped when VIREAD_E2E_HARNESS_ONLY=1 ([M1-target])")
    async def test_t3_m1_target_event_loop_non_blocking_under_slow_storage_and_auth(self) -> None:
        """Concurrent slow Auth + Avatar upload + Dashboard + Catalog MUST NOT stall fast /health."""
        self.world.active_actor_id = PARENT_A_ID
        avatar_png = _make_image_bytes("PNG")
        transport = httpx.ASGITransport(app=app)

        # Warm lazy FastAPI middleware stack, PIL WebP plugin, SQLAlchemy query compilation,
        # avatar upload route, and KB index once before enabling slow Storage/Auth delays.
        from app.services.avatar_service import normalize_avatar_image

        normalize_avatar_image(avatar_png, "image/png")
        async with httpx.AsyncClient(transport=transport, base_url="http://testserver") as warm_client:
            for warm_resp in await asyncio.gather(
                warm_client.get("/health"),
                warm_client.get("/profiles/me"),
                warm_client.get("/profiles/dashboard-summary"),
                warm_client.get("/books/catalog"),
                warm_client.post(
                    "/profiles/me/avatar",
                    files={"file": ("avatar-warm.png", avatar_png, "image/png")},
                ),
                warm_client.post(
                    "/assistant/chat",
                    headers={"Authorization": "Bearer token-parent-a"},
                    json={"message": "Hướng dẫn đọc sách", "current_path": "/books"},
                ),
            ):
                self.assertEqual(warm_resp.status_code, 200, warm_resp.text)

        sleep_seconds = 1.0
        auth_entered = threading.Event()
        upload_entered = threading.Event()
        auth_entered_at: list[float] = []
        self.world.storage.upload_delay_seconds = sleep_seconds
        self.world.storage.upload_entered_at = None
        self.world.storage.upload_entered_event = upload_entered

        def _slow_assistant_auth(credentials: HTTPAuthorizationCredentials | None):
            auth_entered_at.append(time.perf_counter())
            auth_entered.set()
            time.sleep(sleep_seconds)
            if credentials is None or credentials.credentials not in TOKEN_TO_ACTOR:
                raise HTTPException(status_code=401, detail="Invalid token")
            return TOKEN_TO_ACTOR[credentials.credentials]

        with patch("app.api.routes.assistant.get_current_parent_id", new=_slow_assistant_auth):
            async with httpx.AsyncClient(transport=transport, base_url="http://testserver") as client:
                task_avatar = asyncio.create_task(
                    client.post(
                        "/profiles/me/avatar",
                        files={"file": ("avatar.png", avatar_png, "image/png")},
                    )
                )
                task_dash = asyncio.create_task(client.get("/profiles/dashboard-summary"))
                task_cat = asyncio.create_task(client.get("/books/catalog"))
                task_chat = asyncio.create_task(
                    client.post(
                        "/assistant/chat",
                        headers={"Authorization": "Bearer token-parent-a"},
                        json={"message": "Hướng dẫn đọc sách", "current_path": "/books"},
                    )
                )

                async def _wait_for_worker_threads() -> None:
                    while not (auth_entered.is_set() and upload_entered.is_set()):
                        await asyncio.sleep(0.01)

                await asyncio.wait_for(_wait_for_worker_threads(), timeout=5.0)

                health_started = time.perf_counter()
                res_health = await client.get("/health")
                health_finished = time.perf_counter()
                health_elapsed = health_finished - health_started

                res_chat, res_avatar, res_dash, res_cat = await asyncio.gather(
                    task_chat,
                    task_avatar,
                    task_dash,
                    task_cat,
                )

        self.assertEqual(res_chat.status_code, 200, res_chat.text)
        self.assertEqual(res_avatar.status_code, 200, res_avatar.text)
        self.assertEqual(res_dash.status_code, 200, res_dash.text)
        self.assertEqual(res_cat.status_code, 200, res_cat.text)
        self.assertEqual(res_health.status_code, 200)
        self.assertTrue(auth_entered_at)
        self.assertIsNotNone(self.world.storage.upload_entered_at)
        self.assertLess(
            health_elapsed,
            0.35,
            f"Event loop stalled! /health took {health_elapsed:.3f}s while slow Storage/Auth slept {sleep_seconds:.2f}s",
        )
        self.assertLess(
            health_finished,
            auth_entered_at[0] + sleep_seconds,
            "Auth sleep blocked the event loop until after it finished before /health completed",
        )
        self.assertLess(
            health_finished,
            self.world.storage.upload_entered_at + sleep_seconds,
            "Storage upload sleep blocked the event loop until after it finished before /health completed",
        )

    @unittest.skipIf(HARNESS_ONLY, "Skipped when VIREAD_E2E_HARNESS_ONLY=1 ([M2-target])")
    async def test_t3_m2_target_signed_url_cache_reuse_vs_avatar_invalidation(self) -> None:
        self.world.active_actor_id = PARENT_A_ID
        clear_signed_url_cache()
        self.world.storage.sign_calls = 0

        transport = httpx.ASGITransport(app=app)
        async with httpx.AsyncClient(transport=transport, base_url="http://testserver") as client:
            # 1. Cold sign: preview + children
            p1 = await client.get(f"/books/catalog/{CATALOG_BOOK_ID}/preview")
            c1 = await client.get("/profiles/children")
            self.assertEqual(p1.status_code, 200)
            self.assertEqual(c1.status_code, 200)
            calls_after_warm = self.world.storage.sign_calls
            self.assertGreaterEqual(calls_after_warm, 2)

            # 2. Warm reuse: zero new Storage sign calls
            p2 = await client.get(f"/books/catalog/{CATALOG_BOOK_ID}/preview")
            c2 = await client.get("/profiles/children")
            self.assertEqual(p2.status_code, 200)
            self.assertEqual(c2.status_code, 200)
            self.assertEqual(self.world.storage.sign_calls, calls_after_warm)

            # 3. Mutate child avatar: child URL updates & re-signs, catalog preview stays cached
            old_child_url = c2.json()[0]["avatar_url"]
            up = await client.post(
                f"/profiles/children/{CHILD_A_ID}/avatar",
                files={"file": ("new.png", _make_image_bytes("PNG", color=(200, 90, 90)), "image/png")},
            )
            self.assertEqual(up.status_code, 200)
            new_child_url = up.json()["avatar_url"]
            self.assertNotEqual(new_child_url, old_child_url)
            calls_after_avatar_mutation = self.world.storage.sign_calls

            p3 = await client.get(f"/books/catalog/{CATALOG_BOOK_ID}/preview")
            self.assertEqual(p3.status_code, 200)
            self.assertEqual(self.world.storage.sign_calls, calls_after_avatar_mutation)

    async def test_t3_backend_email_transport_to_python_relay_http_loop(self) -> None:
        raw_msg_obj = email_transport.build_test_email_message(
            recipient="parent@example.test",
            parent_name="Ba mẹ",
            delivery_id=uuid4(),
        )
        raw_msg_obj.replace_header("From", "viread.sender@example.test")

        real_httpx_client = httpx.Client

        def _bridged_client(*args, **kwargs):
            client = real_httpx_client(*args, **kwargs)
            orig_post = client.post

            def _forwarded_post(url, **post_kwargs):
                rewritten = str(url).replace("https://relay.viread.local/api/parent-email-relay", self.relay_url)
                return orig_post(rewritten, **post_kwargs)

            client.post = _forwarded_post  # type: ignore[method-assign]
            return client

        with (
            patch.object(email_transport.settings, "EMAIL_RELAY_URL", "https://relay.viread.local/api/parent-email-relay"),
            patch.object(email_transport.settings, "EMAIL_RELAY_SECRET", self.relay_secret),
            patch.object(email_transport.settings, "EMAIL_PROVIDER", "vercel_relay"),
            patch.object(email_transport.settings, "EMAIL_FROM_ADDRESS", "viread.sender@example.test"),
            patch.object(email_transport.settings, "PARENT_EMAIL_MAIL_SINK_DIR", None),
            patch.object(email_transport.httpx, "Client", side_effect=_bridged_client),
        ):
            # 1. Success -> 200 SENT
            provider_used = email_transport.send_email_message(raw_msg_obj)
            self.assertEqual(provider_used, "vercel_relay")

            # 2. SMTP transient failure -> 503 -> EmailTransportRetryable
            self.smtp_mock.side_effect = smtplib.SMTPException("temporary smtp glitch")
            with self.assertRaises(email_transport.EmailTransportRetryable):
                email_transport.send_email_message(raw_msg_obj)

            # 3. SMTP auth rejection -> 422 -> EmailTransportPermanent
            self.smtp_mock.side_effect = smtplib.SMTPAuthenticationError(535, b"auth rejected")
            with self.assertRaises(email_transport.EmailTransportPermanent):
                email_transport.send_email_message(raw_msg_obj)

    async def test_t3_catalog_tts_shared_vs_private_book_isolated(self) -> None:
        tts_repo = _InMemoryTtsRepo(self.world)
        fake_local = MagicMock()
        fake_local.synthesize = AsyncMock(
            return_value=LocalSynthesizedAudio(
                content=b"ID3\x04\x00shared-catalog-tts",
                content_type="audio/mpeg",
                resolved_voice_id=DEFAULT_LOCAL_VOICE_ID,
                region="north",
                model_version=LOCAL_TTS_MODEL_VERSION,
            )
        )
        orch = VoiceOrchestrator(local_provider=fake_local)

        def _make_svc(db_arg):
            s = TtsAudioCacheService(db_arg)
            s.repo = tts_repo  # type: ignore[assignment]
            return s

        transport = httpx.ASGITransport(app=app)
        with (
            patch("app.api.routes.voice.get_voice_orchestrator", return_value=orch),
            patch("app.services.voice_orchestrator.TtsAudioCacheService", side_effect=_make_svc),
        ):
            seed_svc = _make_svc(self.db)
            await seed_svc.store_cached_audio(
                target=ResolvedCacheTarget("CATALOG", None, CATALOG_BOOK_ID, CATALOG_PAGE_1_ID, None, True),
                normalized_text=canonical_tts_text("Bé"),
                voice_id=DEFAULT_LOCAL_VOICE_ID,
                model_version=LOCAL_TTS_MODEL_VERSION,
                speed=1.0,
                audio_bytes=b"ID3\x04\x00shared-catalog-tts",
                source_content_type="audio/mpeg",
            )
            async with httpx.AsyncClient(transport=transport, base_url="http://testserver") as client:
                # Parent A gets HIT on seeded catalog TTS cache; uncached text misses
                r_a = await client.post(
                    "/voice/text-to-speech",
                    headers={"Authorization": "Bearer token-parent-a"},
                    json={"text": "Xin chào", "voice_id": DEFAULT_LOCAL_VOICE_ID, "book_id": str(CATALOG_BOOK_ID), "page_id": str(CATALOG_PAGE_1_ID)},
                )
                self.assertEqual(r_a.status_code, 200)
                self.assertEqual(r_a.headers.get("X-TTS-Cache"), "MISS")

                # Parent B gets cache HIT on shared CATALOG book
                r_b_cat = await client.post(
                    "/voice/text-to-speech",
                    headers={"Authorization": "Bearer token-parent-b"},
                    json={"text": "Bé", "voice_id": DEFAULT_LOCAL_VOICE_ID, "book_id": str(CATALOG_BOOK_ID), "page_id": str(CATALOG_PAGE_1_ID)},
                )
                self.assertEqual(r_b_cat.status_code, 200)
                self.assertEqual(r_b_cat.headers.get("X-TTS-Cache"), "HIT")

                # Parent B is denied Parent A's private book (404)
                r_b_priv = await client.post(
                    "/voice/text-to-speech",
                    headers={"Authorization": "Bearer token-parent-b"},
                    json={"text": "Bé", "voice_id": DEFAULT_LOCAL_VOICE_ID, "book_id": str(PRIVATE_BOOK_A_ID), "page_id": str(PRIVATE_PAGE_A_ID), "cache_scope": "PRIVATE"},
                )
                self.assertEqual(r_b_priv.status_code, 404)


# =============================================================================
# TIER 4: REAL-WORLD END-TO-END WORKFLOWS (>= 3 journeys)
# =============================================================================


class Tier4EndToEndJourneysTests(unittest.IsolatedAsyncioTestCase, _BackendHarnessMixin, _RelayServerMixin):
    async def asyncSetUp(self) -> None:
        self.start_backend_harness()
        self.start_relay_server()

    async def asyncTearDown(self) -> None:
        self.stop_relay_server()
        self.stop_backend_harness()

    async def test_t4_journey_1_parent_onboarding_avatar_catalog_and_assistant(self) -> None:
        self.world.active_actor_id = PARENT_A_ID
        transport = httpx.ASGITransport(app=app)

        async with httpx.AsyncClient(transport=transport, base_url="http://testserver") as client:
            health = await client.get("/health")
            self.assertEqual(health.status_code, 200)
            self.assertEqual(health.json()["status"], "ok")

            me = await client.get("/profiles/me")
            self.assertEqual(me.status_code, 200)
            self.assertEqual(me.json()["display_name"], "Mẹ Bé An")

            created_child = await client.post(
                "/profiles/children",
                json={"alias": "Bé Sóc", "grade": 1, "settings": {}},
            )
            self.assertEqual(created_child.status_code, 201, created_child.text)
            child_id = created_child.json()["id"]

            avatar_resp = await client.post(
                f"/profiles/children/{child_id}/avatar",
                files={"file": ("soc.png", _make_image_bytes("PNG"), "image/png")},
            )
            self.assertEqual(avatar_resp.status_code, 200, avatar_resp.text)
            self.assertTrue(avatar_resp.json()["avatar_url"].startswith("https://"))

            dash = await client.get("/profiles/dashboard-summary")
            self.assertEqual(dash.status_code, 200)
            child_ids = {c["id"] for c in dash.json()["children"]}
            self.assertIn(child_id, child_ids)

            catalog = await client.get("/books/catalog?include_private=true")
            self.assertEqual(catalog.status_code, 200)
            self.assertGreaterEqual(len(catalog.json()), 2)

            preview = await client.get(f"/books/catalog/{CATALOG_BOOK_ID}/preview")
            self.assertEqual(preview.status_code, 200)
            self.assertTrue(preview.json()[0]["preview_url"].startswith("https://"))

            chat = await client.post(
                "/assistant/chat",
                headers={"Authorization": "Bearer token-parent-a"},
                json={"message": "Hướng dẫn đọc sách cho bé", "current_path": "/books"},
            )
            self.assertEqual(chat.status_code, 200)
            self.assertEqual(chat.json()["role_scope"], "parent")
            self.assertTrue(chat.json()["reply"])

    async def test_t4_journey_2_child_camera_match_ocr_reading_tts_and_finish(self) -> None:
        self.world.active_actor_id = PARENT_A_ID
        tts_repo = _InMemoryTtsRepo(self.world)
        fake_local = MagicMock()
        fake_local.synthesize = AsyncMock(
            return_value=LocalSynthesizedAudio(
                content=b"ID3\x04\x00journey-tts-mp3",
                content_type="audio/mpeg",
                resolved_voice_id=DEFAULT_LOCAL_VOICE_ID,
                region="north",
                model_version=LOCAL_TTS_MODEL_VERSION,
            )
        )
        orch = VoiceOrchestrator(local_provider=fake_local)

        def _make_svc(db_arg):
            s = TtsAudioCacheService(db_arg)
            s.repo = tts_repo  # type: ignore[assignment]
            return s

        class _JourneyOcrRepo:
            def __init__(self, _db):
                pass

            async def profile_role(self, actor_id: UUID):
                prof = self.world.profiles.get(actor_id) if False else None
                return "parent" if actor_id == PARENT_A_ID else None

            async def child_belongs_to_parent(self, child_id: UUID, actor_id: UUID):
                return child_id == CHILD_A_ID and actor_id == PARENT_A_ID

            async def eligible_verified_pages(self, book_id: UUID | None = None, *, ocr_tokens=None, limit=None):
                return [(
                    self_world.books[CATALOG_BOOK_ID],
                    self_world.pages[CATALOG_PAGE_1_ID],
                    self_world.revisions[CATALOG_REV_1_ID],
                )]

            async def revision_words(self, revision_id: UUID):
                return list(self_world.words.get(revision_id, []))

        self_world = self.world
        transport = httpx.ASGITransport(app=app)
        with (
            patch("app.api.routes.voice.get_voice_orchestrator", return_value=orch),
            patch("app.services.voice_orchestrator.TtsAudioCacheService", side_effect=_make_svc),
            patch("app.api.routes.reading.LocalOcrScanRepository", side_effect=_JourneyOcrRepo),
            patch("app.services.local_ocr_scan_service.extract_text_and_boxes", return_value=_sample_ocr_output("Bé An đọc sách buổi sáng")),
        ):
            seed_svc = _make_svc(self.db)
            await seed_svc.store_cached_audio(
                target=ResolvedCacheTarget("CATALOG", None, CATALOG_BOOK_ID, CATALOG_PAGE_1_ID, None, True),
                normalized_text=canonical_tts_text("Bé"),
                voice_id=DEFAULT_LOCAL_VOICE_ID,
                model_version=LOCAL_TTS_MODEL_VERSION,
                speed=1.0,
                audio_bytes=b"ID3\x04\x00journey-cached-be",
                source_content_type="audio/mpeg",
            )
            async with httpx.AsyncClient(transport=transport, base_url="http://testserver") as client:
                # 1. Camera match + OCR scan
                match_resp = await client.post(
                    "/reading/match-page",
                    files={"file": ("cam.png", self.world.page_png_1, "image/png")},
                )
                self.assertEqual(match_resp.status_code, 200, match_resp.text)
                self.assertTrue(match_resp.json()["matched"])

                ocr_resp = await client.post(
                    "/reading/scan-page-ocr",
                    data={"child_id": str(CHILD_A_ID)},
                    files={"file": ("scan.png", _make_image_bytes("PNG"), "image/png")},
                )
                self.assertEqual(ocr_resp.status_code, 200, ocr_resp.text)
                self.assertTrue(ocr_resp.json()["matched"])

                # 2. Start reading session
                sess_resp = await client.post(
                    "/reading/sessions",
                    json={"ChildId": str(CHILD_A_ID), "BookId": str(CATALOG_BOOK_ID)},
                )
                self.assertEqual(sess_resp.status_code, 200, sess_resp.text)
                session_id = sess_resp.json()["Id"]

                # 3. Load session page
                page_resp = await client.get(f"/reading/sessions/{session_id}/page")
                self.assertEqual(page_resp.status_code, 200, page_resp.text)
                page_data = page_resp.json()
                self.assertEqual(page_data["page_id"], str(CATALOG_PAGE_1_ID))
                self.assertTrue(page_data["words"])
                self.assertTrue(page_data["image_url"].startswith("https://"))

                # 4. TTS MISS (uncached) then HIT (precomputed)
                tts1 = await client.post(
                    "/voice/text-to-speech",
                    json={
                        "text": "Xin chào",
                        "voice_id": DEFAULT_LOCAL_VOICE_ID,
                        "book_id": str(CATALOG_BOOK_ID),
                        "page_id": str(CATALOG_PAGE_1_ID),
                    },
                )
                self.assertEqual(tts1.status_code, 200)
                self.assertEqual(tts1.headers.get("X-TTS-Cache"), "MISS")
                tts2 = await client.post(
                    "/voice/text-to-speech",
                    json={
                        "text": "Bé",
                        "voice_id": DEFAULT_LOCAL_VOICE_ID,
                        "book_id": str(CATALOG_BOOK_ID),
                        "page_id": str(CATALOG_PAGE_1_ID),
                    },
                )
                self.assertEqual(tts2.status_code, 200)
                self.assertEqual(tts2.headers.get("X-TTS-Cache"), "HIT")

                # 5. Record reading event
                ev_resp = await client.post(
                    "/reading/events",
                    json={
                        "SessionId": session_id,
                        "PageId": str(CATALOG_PAGE_1_ID),
                        "PageRevisionId": str(CATALOG_REV_1_ID),
                        "WordId": page_data["words"][0]["word_id"],
                        "Type": "WORD_READ",
                        "StartMs": 100,
                        "EndMs": 450,
                        "Confidence": 0.94,
                        "Status": "CONFIRMED",
                        "Metadata": {},
                    },
                )
                self.assertEqual(ev_resp.status_code, 200, ev_resp.text)

                # 6. Finish & completion summary
                fin_resp = await client.post(f"/reading/sessions/{session_id}/finish")
                self.assertEqual(fin_resp.status_code, 200, fin_resp.text)
                self.assertEqual(fin_resp.json()["state"], "FINISHED")

                sum_resp = await client.get(f"/reading/sessions/{session_id}/completion-summary")
                self.assertEqual(sum_resp.status_code, 200, sum_resp.text)
                self.assertIsNotNone(sum_resp.json()["selected_range_pages"])

    async def test_t4_journey_3_weekly_digest_to_hmac_relay_zero_pii_logged(self) -> None:
        secret_recipient = "private.parent.recipient@example.test"
        secret_child_alias = "Bé Bảo Mật"
        with patch.object(email_transport.settings, "EMAIL_FROM_ADDRESS", "viread.sender@example.test"):
            digest_msg = email_transport.build_weekly_digest_message(
                recipient=secret_recipient,
                parent_name="Mẹ Bé Bảo Mật",
                week_label="18/11 - 24/11",
                items=[
                    email_transport.ChildWeeklyDigestItem(
                        child_alias=secret_child_alias,
                        sessions_count=4,
                        total_minutes=45,
                        prev_sessions_count=2,
                        avg_fluency_score=88.5,
                        goal_summary="Đạt 4/4 buổi mục tiêu",
                        top_difficult_words=("nghiêng", "khúc khuỷu"),
                    )
                ],
                delivery_id=uuid4(),
            )

        captured_logs: list[str] = []

        class _LogCapture(logging.Handler):
            def emit(self, record: logging.LogRecord) -> None:
                captured_logs.append(self.format(record))

        log_handler = _LogCapture()
        root_logger = logging.getLogger()
        root_logger.addHandler(log_handler)

        real_httpx_client = httpx.Client

        def _bridged_client(*args, **kwargs):
            client = real_httpx_client(*args, **kwargs)
            orig_post = client.post

            def _forwarded_post(url, **post_kwargs):
                rewritten = str(url).replace("https://relay.viread.local/api/parent-email-relay", self.relay_url)
                return orig_post(rewritten, **post_kwargs)

            client.post = _forwarded_post  # type: ignore[method-assign]
            return client

        try:
            with (
                patch.object(email_transport.settings, "EMAIL_RELAY_URL", "https://relay.viread.local/api/parent-email-relay"),
                patch.object(email_transport.settings, "EMAIL_RELAY_SECRET", self.relay_secret),
                patch.object(email_transport.settings, "EMAIL_PROVIDER", "vercel_relay"),
                patch.object(email_transport.settings, "EMAIL_FROM_ADDRESS", "viread.sender@example.test"),
                patch.object(email_transport.settings, "PARENT_EMAIL_MAIL_SINK_DIR", None),
                patch.object(email_transport.httpx, "Client", side_effect=_bridged_client),
            ):
                used = email_transport.send_email_message(digest_msg)
        finally:
            root_logger.removeHandler(log_handler)

        self.assertEqual(used, "vercel_relay")
        smtp_client = self.smtp_mock.return_value.__enter__.return_value
        smtp_client.sendmail.assert_called_once()
        sent_sender, sent_recipients, sent_bytes = smtp_client.sendmail.call_args.args
        self.assertEqual(sent_sender, "viread.sender@example.test")
        self.assertEqual(sent_recipients, [secret_recipient])
        self.assertIn("Báo cáo đọc sách tuần", digest_msg["Subject"])
        self.assertGreater(len(sent_bytes), 200)

        # Verify zero PII or secrets leaked into logs
        joined_logs = "\n".join(captured_logs)
        self.assertNotIn(secret_recipient, joined_logs)
        self.assertNotIn(self.relay_secret, joined_logs)
        self.assertNotIn("abcdefghijklmnop", joined_logs)


if __name__ == "__main__":
    unittest.main(verbosity=2)
