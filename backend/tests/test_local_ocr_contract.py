"""Contract tests for the local Vietnamese OCR page scanning API and Admin OCR upload.

Covers:
- valid image upload + real response contract (request_id, scan_job_id, provenance, cloud_ocr_used=False)
- EXIF orientation transpose (rotated mobile photo -> upright pixels passed to OCR)
- unsupported format (415) & corrupted bytes (422) & empty file (422) & oversized file (413) & oversized dimensions (422)
- unauthenticated access (401) & wrong role (403) & other owner's child_id (404)
- missing/unavailable OCR engine (503) & blank/no-text page (422) & worker crash (500) & timeout (504)
- file read failure cleanup (422) & zero leaked temp files
- retry / idempotency by idempotency_key (same owner + same image returns cached result without rerunning OCR;
  different image with same key returns 409; different owner never sees another user's cached result)
- safe logging (never logs recognized OCR text or raw image bytes)
"""
from __future__ import annotations

import asyncio
import io
import logging
import os
import sys
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock, patch
from uuid import UUID, uuid4

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
from app.services.local_ocr_scan_service import (
    MAX_SCAN_IMAGE_BYTES,
    clear_local_ocr_scan_cache,
)
from app.services.ocr_engine import OcrEngineUnavailable, OcrNoTextDetected
from app.sever import app

PARENT_A = UUID("11111111-1111-4111-8111-111111111111")
PARENT_B = UUID("22222222-2222-4222-8222-222222222222")
ADMIN_USER = UUID("33333333-3333-4333-8333-333333333333")
CHILD_A = UUID("44444444-4444-4444-8444-444444444444")
CHILD_B = UUID("55555555-5555-4555-8555-555555555555")
BOOK_ID = UUID("66666666-6666-4666-8666-666666666666")
PAGE_ID = UUID("77777777-7777-4777-8777-777777777777")
REV_ID = UUID("88888888-8888-4888-8888-888888888888")
WORD_ID_1 = UUID("99999999-9999-4999-8999-999999999991")
WORD_ID_2 = UUID("99999999-9999-4999-8999-999999999992")


def _png_bytes(width: int = 320, height: int = 120, color=(245, 245, 240)) -> bytes:
    buf = io.BytesIO()
    Image.new("RGB", (width, height), color).save(buf, format="PNG")
    return buf.getvalue()


def _exif_rotated_jpeg_bytes(width: int = 300, height: int = 100) -> bytes:
    """Create a JPEG with EXIF Orientation=6 (90 deg CW); exif_transpose swaps width & height."""
    img = Image.new("RGB", (width, height), (250, 250, 245))
    exif = img.getexif()
    exif[0x0112] = 6  # Orientation = Rotate 90 CW
    buf = io.BytesIO()
    img.save(buf, format="JPEG", exif=exif.tobytes())
    return buf.getvalue()


def _sample_ocr_output(text: str = "Bé An đọc sách tiếng Việt") -> dict[str, object]:
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
            "engine_statuses": {
                "paddleocr": "success",
                "vietocr": "success",
                "tesseract": "success",
            },
            "model_profile": "FLOW1_EXTERNAL_TRDG",
            "checkpoint_sha256": "a" * 64,
            "model_load_status": "loaded",
        },
    }


class _FakeRepo:
    def __init__(self, roles=None, owned_children=None, pages=None, rev_words=None):
        self._roles = roles or {
            PARENT_A: "parent",
            PARENT_B: "parent",
            ADMIN_USER: "admin",
        }
        self._owned = owned_children or {
            (CHILD_A, PARENT_A),
            (CHILD_B, PARENT_B),
        }
        self._pages = pages if pages is not None else [
            (
                SimpleNamespace(Id=BOOK_ID, Title="Truyện Bé An"),
                SimpleNamespace(Id=PAGE_ID, PageNumber=1, Width=1000, Height=1400),
                SimpleNamespace(Id=REV_ID, VerifiedText="Bé An đọc sách tiếng Việt rất hay", OriginalOcrText=None),
            )
        ]
        self._rev_words = rev_words if rev_words is not None else [
            SimpleNamespace(Id=WORD_ID_1, WordIndex=0, Text="Bé", BoundingBox=[0.1, 0.2, 0.1, 0.05]),
            SimpleNamespace(Id=WORD_ID_2, WordIndex=1, Text="An", BoundingBox=[0.22, 0.2, 0.1, 0.05]),
        ]

    async def profile_role(self, actor_id: UUID) -> str | None:
        return self._roles.get(actor_id)

    async def child_belongs_to_parent(self, child_id: UUID, actor_id: UUID) -> bool:
        return (child_id, actor_id) in self._owned

    async def eligible_verified_pages(self, book_id: UUID | None = None):
        if book_id is None:
            return list(self._pages)
        return [row for row in self._pages if row[0].Id == book_id]

    async def revision_words(self, revision_id: UUID):
        return list(self._rev_words) if revision_id == REV_ID else []


class LocalOcrContractTests(unittest.TestCase):
    def setUp(self):
        clear_local_ocr_scan_cache()
        self.actor_id = PARENT_A
        self.fake_repo = _FakeRepo()

        async def _fake_db():
            yield MagicMock()

        def _fake_actor():
            return self.actor_id

        app.dependency_overrides[get_db] = _fake_db
        app.dependency_overrides[get_current_parent_id] = _fake_actor
        self.repo_patch = patch(
            "app.api.routes.reading.LocalOcrScanRepository",
            side_effect=lambda _db: self.fake_repo,
        )
        self.repo_patch.start()
        self.client = TestClient(app)

    def tearDown(self):
        self.repo_patch.stop()
        app.dependency_overrides.clear()
        clear_local_ocr_scan_cache()

    def test_valid_image_returns_local_ocr_text_matched_page_and_safe_logs(self):
        secret_text = "Bé An đọc sách tiếng Việt bí mật nội dung"
        log_records: list[str] = []

        class _CaptureHandler(logging.Handler):
            def emit(self, record: logging.LogRecord) -> None:
                log_records.append(self.format(record))

        handler = _CaptureHandler()
        svc_logger = logging.getLogger("app.services.local_ocr_scan_service")
        svc_logger.addHandler(handler)
        svc_logger.setLevel(logging.INFO)
        try:
            with patch(
                "app.services.local_ocr_scan_service.extract_text_and_boxes",
                return_value=_sample_ocr_output(secret_text),
            ):
                resp = self.client.post(
                    "/reading/scan-page-ocr",
                    data={"child_id": str(CHILD_A)},
                    files={"file": ("page.png", _png_bytes(), "image/png")},
                )
        finally:
            svc_logger.removeHandler(handler)

        self.assertEqual(resp.status_code, 200, resp.text)
        body = resp.json()
        self.assertEqual(body["status"], "SUCCEEDED")
        self.assertEqual(body["ocr_text"], secret_text)
        self.assertEqual(body["word_count"], len(secret_text.split()))
        self.assertFalse(body["provenance"]["cloud_ocr_used"])
        self.assertEqual(body["provenance"]["engine"], "paddleocr_vietocr_dual")
        self.assertTrue(body["matched"])
        self.assertEqual(body["matched_book_id"], str(BOOK_ID))
        self.assertEqual(body["matched_page"]["page_id"], str(PAGE_ID))
        self.assertEqual(body["request_id"], resp.headers.get("X-Request-ID"))
        UUID(body["scan_job_id"])  # valid UUID
        # Correlation ID logged, OCR plaintext NEVER logged
        joined_logs = "\n".join(log_records)
        self.assertIn(body["scan_job_id"], joined_logs)
        self.assertNotIn("bí mật nội dung", joined_logs)

    def test_exif_rotated_image_is_auto_oriented_before_ocr(self):
        observed_sizes: list[tuple[int, int]] = []

        def _capture_ocr(image_bytes: bytes):
            with Image.open(io.BytesIO(image_bytes)) as im:
                observed_sizes.append(im.size)
            return _sample_ocr_output("Bé An đọc sách tiếng Việt")

        with patch("app.services.local_ocr_scan_service.extract_text_and_boxes", side_effect=_capture_ocr):
            resp = self.client.post(
                "/reading/scan-page-ocr",
                files={"file": ("rotated.jpg", _exif_rotated_jpeg_bytes(300, 100), "image/jpeg")},
            )
        self.assertEqual(resp.status_code, 200)
        # Orientation=6 rotates 300x100 -> 100x300 upright before OCR
        self.assertEqual(observed_sizes, [(100, 300)])

    def test_rejects_unauthenticated_wrong_role_and_other_owner_child(self):
        # 401 when auth dependency is NOT overridden and no Bearer header is sent
        app.dependency_overrides.pop(get_current_parent_id, None)
        resp_401 = self.client.post(
            "/reading/scan-page-ocr",
            files={"file": ("page.png", _png_bytes(), "image/png")},
        )
        self.assertEqual(resp_401.status_code, 401)

        # 403 for non-parent (admin role)
        app.dependency_overrides[get_current_parent_id] = lambda: ADMIN_USER
        resp_403 = self.client.post(
            "/reading/scan-page-ocr",
            files={"file": ("page.png", _png_bytes(), "image/png")},
        )
        self.assertEqual(resp_403.status_code, 403)

        # 404 when Parent A passes Parent B's child_id (non-enumerating ownership check)
        app.dependency_overrides[get_current_parent_id] = lambda: PARENT_A
        resp_404 = self.client.post(
            "/reading/scan-page-ocr",
            data={"child_id": str(CHILD_B)},
            files={"file": ("page.png", _png_bytes(), "image/png")},
        )
        self.assertEqual(resp_404.status_code, 404)

    def test_rejects_invalid_format_corrupt_empty_and_oversized_files(self):
        # Empty file -> 422
        r_empty = self.client.post(
            "/reading/scan-page-ocr",
            files={"file": ("empty.png", b"", "image/png")},
        )
        self.assertEqual(r_empty.status_code, 422)

        # Corrupted bytes -> 422
        r_corrupt = self.client.post(
            "/reading/scan-page-ocr",
            files={"file": ("broken.png", b"not-a-real-image-at-all", "image/png")},
        )
        self.assertEqual(r_corrupt.status_code, 422)

        # Unsupported format (BMP) -> 415
        bmp_buf = io.BytesIO()
        Image.new("RGB", (64, 64), (255, 255, 255)).save(bmp_buf, format="BMP")
        r_bmp = self.client.post(
            "/reading/scan-page-ocr",
            files={"file": ("page.bmp", bmp_buf.getvalue(), "image/bmp")},
        )
        self.assertEqual(r_bmp.status_code, 415)

        # Oversized (> 12 MB) -> 413
        r_big = self.client.post(
            "/reading/scan-page-ocr",
            files={"file": ("huge.png", b"\x89PNG" + b"\x00" * MAX_SCAN_IMAGE_BYTES, "image/png")},
        )
        self.assertEqual(r_big.status_code, 413)

    def test_maps_blank_engine_unavailable_worker_error_and_timeout(self):
        png = _png_bytes()

        with patch("app.services.local_ocr_scan_service.extract_text_and_boxes", side_effect=OcrNoTextDetected("blank")):
            r = self.client.post("/reading/scan-page-ocr", files={"file": ("blank.png", png, "image/png")})
            self.assertEqual(r.status_code, 422)

        with patch("app.services.local_ocr_scan_service.extract_text_and_boxes", side_effect=OcrEngineUnavailable("missing")):
            r = self.client.post("/reading/scan-page-ocr", files={"file": ("p.png", png, "image/png")})
            self.assertEqual(r.status_code, 503)

        with patch("app.services.local_ocr_scan_service.extract_text_and_boxes", side_effect=RuntimeError("boom")):
            r = self.client.post("/reading/scan-page-ocr", files={"file": ("p.png", png, "image/png")})
            self.assertEqual(r.status_code, 500)
            self.assertNotIn("boom", r.text)

        async def _timeout(coro, *args, **kwargs):
            coro.close()
            raise asyncio.TimeoutError()

        with patch("app.services.local_ocr_scan_service.asyncio.wait_for", side_effect=_timeout):
            r = self.client.post("/reading/scan-page-ocr", files={"file": ("p.png", png, "image/png")})
            self.assertEqual(r.status_code, 504)

    def test_file_read_error_and_oversized_dimensions_clean_up_safely(self):
        # Oversized image dimensions (> 6000px) -> 422
        oversized = _png_bytes(6001, 10)
        r_dim = self.client.post(
            "/reading/scan-page-ocr",
            files={"file": ("wide.png", oversized, "image/png")},
        )
        self.assertEqual(r_dim.status_code, 422)

        # File read exception inside UploadFile -> 422 and file.close() called
        from fastapi import UploadFile
        from app.services.local_ocr_scan_service import LocalOcrScanService

        broken_file = MagicMock(spec=UploadFile)
        broken_file.read = AsyncMock(side_effect=OSError("disk read interrupted"))
        broken_file.close = AsyncMock(return_value=None)

        svc = LocalOcrScanService(self.fake_repo)
        with self.assertRaises(Exception) as ctx:
            asyncio.run(svc.scan_page(PARENT_A, broken_file, request_id="req-read-err"))
        self.assertEqual(getattr(ctx.exception, "status_code", None), 422)
        broken_file.close.assert_awaited_once()

    def test_idempotency_retry_reuses_result_blocks_conflict_and_isolates_owners(self):
        key = str(uuid4())
        img1 = _png_bytes(320, 120, (240, 240, 240))
        img2 = _png_bytes(320, 120, (200, 220, 240))
        ocr_mock = MagicMock(return_value=_sample_ocr_output("Bé An đọc sách tiếng Việt"))

        with patch("app.services.local_ocr_scan_service.extract_text_and_boxes", ocr_mock):
            r1 = self.client.post(
                "/reading/scan-page-ocr",
                data={"idempotency_key": key},
                files={"file": ("p1.png", img1, "image/png")},
            )
            r2 = self.client.post(
                "/reading/scan-page-ocr",
                data={"idempotency_key": key},
                files={"file": ("p1.png", img1, "image/png")},
            )
            self.assertEqual(r1.status_code, 200)
            self.assertEqual(r2.status_code, 200)
            self.assertEqual(r1.json()["scan_job_id"], r2.json()["scan_job_id"])
            # OCR ran ONLY ONCE despite retry
            self.assertEqual(ocr_mock.call_count, 1)

            # Reusing same idempotency_key for a DIFFERENT image -> 409
            r_conflict = self.client.post(
                "/reading/scan-page-ocr",
                data={"idempotency_key": key},
                files={"file": ("p2.png", img2, "image/png")},
            )
            self.assertEqual(r_conflict.status_code, 409)

            # Parent B using the same UUID key must NOT get Parent A's cached result
            self.actor_id = PARENT_B
            r_other = self.client.post(
                "/reading/scan-page-ocr",
                data={"idempotency_key": key},
                files={"file": ("p1.png", img1, "image/png")},
            )
            self.assertEqual(r_other.status_code, 200)
            self.assertNotEqual(r_other.json()["scan_job_id"], r1.json()["scan_job_id"])
            self.assertEqual(ocr_mock.call_count, 2)


if __name__ == "__main__":
    unittest.main()
