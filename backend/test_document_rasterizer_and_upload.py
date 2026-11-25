"""Unit and route tests for multi-format Pre-OCR document rasterizer and upload."""

from __future__ import annotations

import os
import unicodedata
import unittest
import zipfile
from datetime import datetime, timezone
from io import BytesIO
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock, patch
from uuid import UUID, uuid4

os.environ.setdefault("DATABASE_URL", "postgresql+asyncpg://test:test@127.0.0.1:1/test")
os.environ.setdefault("SUPABASE_URL", "https://example.supabase.co")
os.environ.setdefault("SUPABASE_KEY", "isolated-test-key")
os.environ.setdefault("DATABASE_POOLER_MODE", "local")
os.environ.setdefault("DATABASE_SSL_REQUIRED", "false")

import docx
import pymupdf
from fastapi import FastAPI, HTTPException, UploadFile
from fastapi.testclient import TestClient
from PIL import Image, ImageChops, ImageDraw, ImageFont
from sqlalchemy.exc import MissingGreenlet

from app.api.deps import get_current_parent_id, get_db
from app.api.routes.admin_ocr import router as admin_ocr_router
from app.schemas.admin_ocr import normalize_ocr_bbox
from app.schemas.book import AdminRevisionDetailRead
from app.services.admin_ocr_service import AdminOcrService
from app.services.document_rasterizer_service import (
    MAX_DOCUMENT_PAGES,
    OLE2_MAGIC,
    _find_unicode_font_paths,
    rasterize_uploaded_document,
)
from app.services.ocr_engine import OcrNoTextDetected, extract_text_and_boxes
from app.services.runtime_diagnostics import runtime_configuration_diagnostics
from app.services.storage_service import StorageUploadFailure

ACTOR_ID = UUID("11111111-1111-4111-8111-111111111111")
BOOK_ID = UUID("22222222-2222-4222-8222-222222222222")


def _make_png_bytes(*, mode: str = "RGBA", color=(20, 90, 140, 128), size=(120, 160)) -> bytes:
    buf = BytesIO()
    Image.new(mode, size, color).save(buf, format="PNG")
    return buf.getvalue()


def _make_bmp_bytes(size=(180, 240)) -> bytes:
    buf = BytesIO()
    Image.new("RGB", size, (250, 250, 250)).save(buf, format="BMP")
    return buf.getvalue()


def _make_tiff_bytes(frame_count: int) -> bytes:
    frames = [
        Image.new("RGB", (140, 200), (240 - (i * 5) % 80, 240, 245))
        for i in range(frame_count)
    ]
    buf = BytesIO()
    frames[0].save(
        buf,
        format="TIFF",
        save_all=True,
        append_images=frames[1:],
    )
    for frame in frames:
        frame.close()
    return buf.getvalue()


def _make_pdf_bytes(page_texts: list[str], *, password: str | None = None) -> bytes:
    doc = pymupdf.open()
    for text in page_texts:
        page = doc.new_page(width=595, height=842)
        if text:
            page.insert_text((72, 96), text, fontsize=16)
    if password:
        raw = doc.tobytes(
            encryption=pymupdf.PDF_ENCRYPT_AES_256,
            owner_pw=f"owner-{password}",
            user_pw=password,
        )
    else:
        raw = doc.tobytes()
    doc.close()
    return raw


def _make_docx_bytes(
    *,
    paragraphs: list[str] | None = None,
    with_table: bool = False,
    with_image: bool = False,
    page_breaks: int = 0,
) -> bytes:
    document = docx.Document()
    for text in paragraphs or []:
        document.add_paragraph(text)
    if with_table:
        table = document.add_table(rows=2, cols=2)
        table.cell(0, 0).text = "Từ vựng"
        table.cell(0, 1).text = "Nghĩa"
        table.cell(1, 0).text = "Đọc sách"
        table.cell(1, 1).text = "Luyện phát âm tiếng Việt"
    if with_image:
        img_buf = BytesIO(_make_png_bytes(mode="RGB", color=(40, 120, 80), size=(80, 60)))
        document.add_picture(img_buf)
    for idx in range(page_breaks):
        document.add_page_break()
        document.add_paragraph(f"Trang số {idx + 2}: Bé tập đọc tiếng Việt.")
    out = BytesIO()
    document.save(out)
    return out.getvalue()


def _fake_ocr_result(word_text: str = "Mèo") -> dict[str, object]:
    return {
        "text": f"{word_text} nhỏ",
        "words": [
            {
                "word_index": 0,
                "line_index": 0,
                "text": word_text,
                "normalized_text": word_text.lower(),
                "bbox": [0.1, 0.15, 0.12, 0.05],
                "ocr_confidence": 0.94,
            },
            {
                "word_index": 1,
                "line_index": 0,
                "text": "nhỏ",
                "normalized_text": "nhỏ",
                "bbox": [0.24, 0.15, 0.1, 0.05],
                "ocr_confidence": 0.91,
            },
        ],
        "metadata": {"engine": "dual_engine", "language": "vie"},
    }


class DocumentRasterizerTests(unittest.TestCase):
    def test_rasterizes_png_rgba_bmp_and_multiframe_tiff(self):
        png_bundle = rasterize_uploaded_document(
            filename="alpha.png",
            content_type="image/png",
            data=_make_png_bytes(mode="RGBA", color=(0, 0, 0, 0)),
        )
        self.assertEqual(png_bundle.source_format, "PNG")
        self.assertEqual(len(png_bundle.pages), 1)
        with Image.open(BytesIO(png_bundle.pages[0].image_bytes)) as flattened:
            self.assertEqual(flattened.mode, "RGB")
            self.assertEqual(flattened.getpixel((10, 10)), (255, 255, 255))

        bmp_bundle = rasterize_uploaded_document(
            filename="scan.bmp",
            content_type="application/octet-stream",
            data=_make_bmp_bytes(),
        )
        self.assertEqual(bmp_bundle.source_format, "BMP")
        self.assertEqual(len(bmp_bundle.pages), 1)
        self.assertEqual(bmp_bundle.pages[0].content_type, "image/jpeg")
        self.assertEqual(bmp_bundle.pages[0].extension, "jpg")
        self.assertTrue(bmp_bundle.pages[0].image_bytes.startswith(b"\xff\xd8\xff"))

        with patch.dict(os.environ, {"VIREAD_RASTERIZER_FORMAT": "png"}):
            png_override_bundle = rasterize_uploaded_document(
                filename="scan.bmp",
                content_type="application/octet-stream",
                data=_make_bmp_bytes(),
            )
        self.assertEqual(png_override_bundle.pages[0].content_type, "image/png")
        self.assertEqual(png_override_bundle.pages[0].extension, "png")
        self.assertTrue(png_override_bundle.pages[0].image_bytes.startswith(b"\x89PNG\r\n\x1a\n"))

        tiff_bundle = rasterize_uploaded_document(
            filename="scan-multi.tiff",
            content_type="image/tiff",
            data=_make_tiff_bytes(3),
        )
        self.assertEqual(tiff_bundle.source_format, "TIFF")
        self.assertEqual([p.source_page for p in tiff_bundle.pages], [1, 2, 3])

    def test_enforces_30_page_limit_for_pdf_and_tiff(self):
        valid_30 = rasterize_uploaded_document(
            filename="thirty.pdf",
            content_type="application/pdf",
            data=_make_pdf_bytes([f"Page {i}" for i in range(1, MAX_DOCUMENT_PAGES + 1)]),
        )
        self.assertEqual(len(valid_30.pages), 30)
        self.assertEqual(valid_30.source_format, "PDF")

        with self.assertRaises(HTTPException) as pdf_over:
            rasterize_uploaded_document(
                filename="thirty-one.pdf",
                content_type="application/pdf",
                data=_make_pdf_bytes([f"Page {i}" for i in range(1, MAX_DOCUMENT_PAGES + 2)]),
            )
        self.assertEqual(pdf_over.exception.status_code, 422)
        self.assertEqual(
            pdf_over.exception.detail,
            "Document exceeds the 30-page limit per upload",
        )

        with self.assertRaises(HTTPException) as tiff_over:
            rasterize_uploaded_document(
                filename="too-many.tif",
                content_type="image/tiff",
                data=_make_tiff_bytes(MAX_DOCUMENT_PAGES + 1),
            )
        self.assertEqual(tiff_over.exception.status_code, 422)
        self.assertEqual(
            tiff_over.exception.detail,
            "Document exceeds the 30-page limit per upload",
        )

    def test_rejects_encrypted_pdf_and_spoofed_magic_bytes(self):
        encrypted = _make_pdf_bytes(["Secret page"], password="pass")
        with self.assertRaises(HTTPException) as raised_enc:
            rasterize_uploaded_document(
                filename="locked.pdf",
                content_type="application/pdf",
                data=encrypted,
            )
        self.assertEqual(raised_enc.exception.status_code, 422)
        self.assertEqual(
            raised_enc.exception.detail,
            "Password-protected PDF files are not supported",
        )

        with self.assertRaises(HTTPException) as raised_spoof:
            rasterize_uploaded_document(
                filename="fake.pdf",
                content_type="application/pdf",
                data=_make_png_bytes(),
            )
        self.assertEqual(raised_spoof.exception.status_code, 415)

    def test_rasterizes_vietnamese_nfc_docx_and_enforces_security_checks(self):
        raw_docx = _make_docx_bytes(
            paragraphs=[
                "Chú mèo nhỏ đọc sách tiếng Việt có đủ dấu: á à ả ã ạ ă â đ ê ô ơ ư.",
            ],
            with_table=True,
            with_image=True,
            page_breaks=1,
        )
        bundle = rasterize_uploaded_document(
            filename="truyen-thieu-nhi.docx",
            content_type="",
            data=raw_docx,
        )
        self.assertEqual(bundle.source_format, "DOCX")
        self.assertEqual(len(bundle.pages), 2)
        for page in bundle.pages:
            with Image.open(BytesIO(page.image_bytes)) as rendered:
                diff = ImageChops.difference(
                    rendered, Image.new("RGB", rendered.size, (255, 255, 255))
                )
                self.assertIsNotNone(diff.getbbox(), "DOCX page should render visible text/content")

        # Empty DOCX rejected
        with self.assertRaises(HTTPException) as empty_docx:
            rasterize_uploaded_document(
                filename="empty.docx",
                content_type="",
                data=_make_docx_bytes(paragraphs=[]),
            )
        self.assertEqual(empty_docx.exception.status_code, 422)

        # Over 30 pages DOCX rejected
        with self.assertRaises(HTTPException) as over_docx:
            rasterize_uploaded_document(
                filename="long.docx",
                content_type="",
                data=_make_docx_bytes(paragraphs=["Trang đầu"], page_breaks=30),
            )
        self.assertEqual(over_docx.exception.status_code, 422)
        self.assertEqual(
            over_docx.exception.detail,
            "Document exceeds the 30-page limit per upload",
        )

        # Legacy .doc and encrypted OLE2 .docx rejected
        with self.assertRaises(HTTPException) as legacy_doc:
            rasterize_uploaded_document(
                filename="old.doc",
                content_type="application/msword",
                data=OLE2_MAGIC + b"\x00" * 64,
            )
        self.assertEqual(legacy_doc.exception.status_code, 415)

        with self.assertRaises(HTTPException) as enc_docx:
            rasterize_uploaded_document(
                filename="secret.docx",
                content_type="",
                data=OLE2_MAGIC + b"EncryptedPackage" + b"\x00" * 64,
            )
        self.assertEqual(enc_docx.exception.status_code, 422)

        # .docm rejected
        with self.assertRaises(HTTPException) as macro_ext:
            rasterize_uploaded_document(
                filename="macro.docm",
                content_type="",
                data=raw_docx,
            )
        self.assertEqual(macro_ext.exception.status_code, 415)

        # DOCX archive containing vbaProject.bin rejected
        vba_buf = BytesIO()
        with zipfile.ZipFile(BytesIO(raw_docx), "r") as src_zip:
            with zipfile.ZipFile(vba_buf, "w", compression=zipfile.ZIP_DEFLATED) as dst_zip:
                for item in src_zip.infolist():
                    dst_zip.writestr(item, src_zip.read(item.filename))
                dst_zip.writestr("word/vbaProject.bin", b"vba-macro-bytes")
        with self.assertRaises(HTTPException) as macro_zip:
            rasterize_uploaded_document(
                filename="sneaky.docx",
                content_type="",
                data=vba_buf.getvalue(),
            )
        self.assertEqual(macro_zip.exception.status_code, 415)

        # XML entity injection rejected
        xxe_buf = BytesIO()
        with zipfile.ZipFile(BytesIO(raw_docx), "r") as src_zip:
            with zipfile.ZipFile(xxe_buf, "w", compression=zipfile.ZIP_DEFLATED) as dst_zip:
                for item in src_zip.infolist():
                    content = src_zip.read(item.filename)
                    if item.filename == "word/document.xml":
                        content = b'<!DOCTYPE foo [<!ENTITY xxe "boom">]>' + content
                    dst_zip.writestr(item, content)
        with self.assertRaises(HTTPException) as xml_xxe:
            rasterize_uploaded_document(
                filename="xxe.docx",
                content_type="",
                data=xxe_buf.getvalue(),
            )
        self.assertEqual(xml_xxe.exception.status_code, 422)

        # Legitimate 500 KB repetitive XML/metadata entry inside DOCX must pass
        legit_large_buf = BytesIO()
        with zipfile.ZipFile(BytesIO(raw_docx), "r") as src_zip:
            with zipfile.ZipFile(legit_large_buf, "w", compression=zipfile.ZIP_DEFLATED) as dst_zip:
                for item in src_zip.infolist():
                    content = src_zip.read(item.filename)
                    if item.filename == "word/styles.xml":
                        marker = b"<w:styles"
                        idx = content.find(marker)
                        if idx >= 0:
                            content = content[:idx] + b"<!--" + (b"A" * 500_000) + b"-->" + content[idx:]
                    dst_zip.writestr(item, content)
        legit_bundle = rasterize_uploaded_document(
            filename="styled.docx",
            content_type="",
            data=legit_large_buf.getvalue(),
        )
        self.assertEqual(legit_bundle.source_format, "DOCX")

        # Zip bomb (> 10 MB entry with > 200:1 compression ratio) rejected
        bomb_buf = BytesIO()
        with zipfile.ZipFile(BytesIO(raw_docx), "r") as src_zip:
            with zipfile.ZipFile(bomb_buf, "w", compression=zipfile.ZIP_DEFLATED) as dst_zip:
                for item in src_zip.infolist():
                    dst_zip.writestr(item, src_zip.read(item.filename))
                dst_zip.writestr("word/padding.bin", b"A" * (12 * 1024 * 1024))
        with self.assertRaises(HTTPException) as zip_bomb:
            rasterize_uploaded_document(
                filename="bomb.docx",
                content_type="",
                data=bomb_buf.getvalue(),
            )
        self.assertEqual(zip_bomb.exception.status_code, 422)


class AdminDocumentUploadServiceAndRouteTests(unittest.IsolatedAsyncioTestCase):
    def _make_service(self):
        db = MagicMock()
        db.commit = AsyncMock()
        db.rollback = AsyncMock()
        db.refresh = AsyncMock()
        db.flush = AsyncMock()

        service = AdminOcrService(db)
        service.repo = MagicMock()
        service.repo.role = AsyncMock(return_value="admin")
        service.repo.book = AsyncMock(
            return_value=SimpleNamespace(Id=BOOK_ID, LifecycleStatus="ACTIVE")
        )
        service.repo.flush = AsyncMock()

        persisted_pages = []

        async def active_pages_for_renumber(_book_id, *, lock=False):
            return [
                p for p in persisted_pages if p.LifecycleStatus in ("ACTIVE", "PROCESSING")
            ]

        async def next_active_page_number(_book_id):
            nums = [
                p.PageNumber
                for p in persisted_pages
                if p.LifecycleStatus in ("ACTIVE", "PROCESSING")
            ]
            return max(nums, default=0) + 1

        async def delete_page(page):
            if page in persisted_pages:
                persisted_pages.remove(page)

        async def find_page(page_id, *, lock=False):
            return next((p for p in persisted_pages if p.Id == page_id), None)

        async def find_page_for_upload(_book_id, upload_id):
            return next(
                (
                    p
                    for p in persisted_pages
                    if (p.ProcessingMeta or {}).get("upload_id") == str(upload_id)
                ),
                None,
            )

        revisions_by_id = {}

        def stage_bundle(page, revision, _words):
            revisions_by_id[revision.Id] = revision

        async def find_revision(_page_id, rev_id, *, lock=False):
            return revisions_by_id.get(rev_id)

        service.repo.active_pages_for_renumber = AsyncMock(
            side_effect=active_pages_for_renumber
        )
        service.repo.next_active_page_number = AsyncMock(
            side_effect=next_active_page_number
        )
        service.repo.stage_page_reservation = MagicMock(side_effect=persisted_pages.append)
        service.repo.delete_page = AsyncMock(side_effect=delete_page)
        service.repo.set_page_lifecycle_status = MagicMock(
            side_effect=lambda page, state: setattr(page, "LifecycleStatus", state)
        )
        service.repo.set_page_number = MagicMock(
            side_effect=lambda page, num: setattr(page, "PageNumber", num)
        )
        service.repo.page = AsyncMock(side_effect=find_page)
        service.repo.page_for_upload = AsyncMock(side_effect=find_page_for_upload)
        service.repo.stage_page_revision_bundle = MagicMock(side_effect=stage_bundle)
        service.repo.revision = AsyncMock(side_effect=find_revision)
        service.repo.words = AsyncMock(return_value=[])

        async def fake_revision_detail(page, revision, *, word_rows=None):
            return AdminRevisionDetailRead(
                page_id=page.Id,
                page_revision_id=revision.Id,
                revision_no=int(revision.RevisionNo),
                verification_status=revision.VerificationStatus,
                lifecycle_status=page.LifecycleStatus,
                draft_text=revision.DraftText,
                words=[],
                ocr_metadata={"engine": "dual_engine"},
                created_at=datetime.now(timezone.utc),
                verified_at=None,
                verified_by=None,
            )

        service.revision_detail = AsyncMock(side_effect=fake_revision_detail)
        service._test_pages = persisted_pages
        return service

    async def test_pdf_with_blank_middle_page_skips_cleanly_and_keeps_contiguous_numbers(self):
        service = self._make_service()
        pdf_bytes = _make_pdf_bytes(["Trang 1", "", "Trang 3"])
        upload_file = UploadFile(
            file=BytesIO(pdf_bytes),
            filename="sample.pdf",
            headers={"content-type": "application/pdf"},
        )

        ocr_calls = 0

        def ocr_side_effect(img_bytes: bytes):
            nonlocal ocr_calls
            ocr_calls += 1
            self.assertGreater(len(img_bytes), 0)
            if ocr_calls == 2:
                raise OcrNoTextDetected("No usable text was detected")
            return _fake_ocr_result(f"Từ{ocr_calls}")

        with (
            patch("app.services.admin_ocr_service.upload_object") as uploaded,
            patch("app.services.admin_ocr_service.delete_object") as deleted_obj,
            patch("app.services.admin_ocr_service.extract_text_and_boxes", side_effect=ocr_side_effect),
        ):
            response = await service.upload_document(ACTOR_ID, BOOK_ID, upload_file)

        self.assertEqual(response.source_format, "PDF")
        self.assertEqual(response.total_source_pages, 3)
        self.assertEqual(response.created_pages_count, 2)
        self.assertEqual(response.skipped_empty_count, 1)
        self.assertEqual(response.failed_pages_count, 0)
        self.assertEqual([p.status for p in response.pages], ["SUCCEEDED", "SKIPPED_EMPTY", "SUCCEEDED"])
        self.assertEqual(response.pages[0].page_number, 1)
        self.assertIsNone(response.pages[1].page_number)
        self.assertEqual(response.pages[2].page_number, 2)
        self.assertEqual([p.PageNumber for p in service._test_pages], [1, 2])
        self.assertEqual(uploaded.call_count, 3)
        deleted_obj.assert_called_once()
        service.repo.delete_page.assert_awaited_once()

    async def test_all_blank_pages_raise_422_and_leave_zero_pages(self):
        service = self._make_service()
        pdf_bytes = _make_pdf_bytes(["", ""])
        upload_file = UploadFile(
            file=BytesIO(pdf_bytes),
            filename="blank.pdf",
            headers={"content-type": "application/pdf"},
        )
        with (
            patch("app.services.admin_ocr_service.upload_object"),
            patch("app.services.admin_ocr_service.delete_object") as deleted_obj,
            patch(
                "app.services.admin_ocr_service.extract_text_and_boxes",
                side_effect=OcrNoTextDetected("empty"),
            ),
        ):
            with self.assertRaises(HTTPException) as raised:
                await service.upload_document(ACTOR_ID, BOOK_ID, upload_file)

        self.assertEqual(raised.exception.status_code, 422)
        self.assertEqual(
            raised.exception.detail,
            "No usable text was detected in the uploaded document",
        )
        self.assertEqual(service._test_pages, [])
        self.assertEqual(deleted_obj.call_count, 2)

    async def test_document_upload_idempotency_reuses_existing_pages_on_retry(self):
        service = self._make_service()
        pdf_bytes = _make_pdf_bytes(["Trang 1", "Trang 2"])
        shared_upload_id = uuid4()

        with (
            patch("app.services.admin_ocr_service.upload_object") as uploaded,
            patch(
                "app.services.admin_ocr_service.extract_text_and_boxes",
                return_value=_fake_ocr_result("Chữ"),
            ) as ocr_mock,
        ):
            first = await service.upload_document(
                ACTOR_ID,
                BOOK_ID,
                UploadFile(
                    file=BytesIO(pdf_bytes),
                    filename="book.pdf",
                    headers={"content-type": "application/pdf"},
                ),
                upload_id=shared_upload_id,
            )
            second = await service.upload_document(
                ACTOR_ID,
                BOOK_ID,
                UploadFile(
                    file=BytesIO(pdf_bytes),
                    filename="book.pdf",
                    headers={"content-type": "application/pdf"},
                ),
                upload_id=shared_upload_id,
            )

        self.assertEqual(first.created_pages_count, 2)
        self.assertEqual(second.created_pages_count, 2)
        self.assertEqual(len(service._test_pages), 2)
        self.assertEqual(uploaded.call_count, 2)
        self.assertEqual(ocr_mock.call_count, 2)

    async def test_upload_document_reads_book_status_before_db_rollback(self):
        service = self._make_service()
        issued_books = []

        class ExpiringBook:
            def __init__(self):
                self.Id = BOOK_ID
                self._expired = False
                issued_books.append(self)

            @property
            def LifecycleStatus(self):
                if self._expired:
                    raise MissingGreenlet("Book attributes expired after rollback")
                return "ACTIVE"

        async def expire_on_rollback():
            for book in issued_books:
                book._expired = True

        service.repo.book = AsyncMock(side_effect=lambda *_args, **_kwargs: ExpiringBook())
        service.db.rollback = AsyncMock(side_effect=expire_on_rollback)
        pdf_bytes = _make_pdf_bytes(["Trang 1"])

        with (
            patch("app.services.admin_ocr_service.upload_object"),
            patch(
                "app.services.admin_ocr_service.extract_text_and_boxes",
                return_value=_fake_ocr_result("Chữ"),
            ),
        ):
            response = await service.upload_document(
                ACTOR_ID,
                BOOK_ID,
                UploadFile(
                    file=BytesIO(pdf_bytes),
                    filename="book.pdf",
                    headers={"content-type": "application/pdf"},
                ),
            )

        self.assertEqual(response.created_pages_count, 1)

    def test_route_endpoint_returns_201_document_upload_response(self):
        app = FastAPI()
        app.include_router(admin_ocr_router, prefix="/books")
        db = MagicMock()
        app.dependency_overrides[get_current_parent_id] = lambda: ACTOR_ID
        app.dependency_overrides[get_db] = lambda: db
        client = TestClient(app)

        expected_payload = {
            "book_id": str(BOOK_ID),
            "file_name": "book.pdf",
            "source_format": "PDF",
            "total_source_pages": 1,
            "created_pages_count": 1,
            "skipped_empty_count": 0,
            "failed_pages_count": 0,
            "pages": [
                {
                    "source_page": 1,
                    "status": "SUCCEEDED",
                    "page_id": str(uuid4()),
                    "page_number": 1,
                    "revision": None,
                    "error_code": None,
                    "error_message": None,
                }
            ],
        }
        with patch.object(
            AdminOcrService,
            "upload_document",
            new=AsyncMock(return_value=expected_payload),
        ) as mock_upload:
            response = client.post(
                f"/books/admin/catalog/{BOOK_ID}/documents",
                files={"document": ("book.pdf", b"%PDF-1.4\n", "application/pdf")},
                data={"upload_id": str(uuid4())},
            )

        self.assertEqual(response.status_code, 201)
        self.assertEqual(response.json()["created_pages_count"], 1)
        mock_upload.assert_awaited_once()


def _render_vietnamese_image(
    text: str,
    *,
    format_name: str,
    size: tuple[int, int] = (1000, 260),
    mode: str = "RGB",
    background: tuple[int, ...] = (255, 255, 255),
    text_color: tuple[int, ...] = (15, 15, 15),
    font_size: int = 44,
) -> bytes:
    font_path, _ = _find_unicode_font_paths()
    font = ImageFont.truetype(font_path, font_size)
    img = Image.new(mode, size, background)
    draw = ImageDraw.Draw(img)
    draw.text((48, 80), unicodedata.normalize("NFC", text), fill=text_color, font=font)
    buf = BytesIO()
    img.save(buf, format=format_name)
    img.close()
    return buf.getvalue()


class RealOcrAndEndToEndDocumentScenarios(unittest.IsolatedAsyncioTestCase):
    def _make_strict_stateful_service(self, *, book_status: str | None = "ACTIVE"):
        db = MagicMock()
        issued_proxies = []

        class ExpiringRow:
            def __init__(self, **attrs):
                object.__setattr__(self, "_attrs", dict(attrs))
                object.__setattr__(self, "_expired", False)
                issued_proxies.append(self)

            def __getattr__(self, name):
                if object.__getattribute__(self, "_expired"):
                    raise MissingGreenlet(f"Attribute {name} expired after rollback/commit")
                attrs = object.__getattribute__(self, "_attrs")
                if name in attrs:
                    return attrs[name]
                raise AttributeError(name)

            def __setattr__(self, name, value):
                if name in ("_attrs", "_expired"):
                    object.__setattr__(self, name, value)
                    return
                object.__getattribute__(self, "_attrs")[name] = value

        async def expire_proxies():
            for row in issued_proxies:
                object.__setattr__(row, "_expired", True)

        db.rollback = AsyncMock(side_effect=expire_proxies)
        db.commit = AsyncMock(side_effect=expire_proxies)
        db.flush = AsyncMock()

        async def refresh_row(row):
            object.__setattr__(row, "_expired", False)

        db.refresh = AsyncMock(side_effect=refresh_row)

        service = AdminOcrService(db)
        service.repo = MagicMock()
        service.repo.role = AsyncMock(return_value="admin")
        service.repo.flush = AsyncMock()

        persisted_pages: list[dict[str, object]] = []
        revisions_by_id: dict[UUID, dict[str, object]] = {}

        def make_book_proxy():
            if book_status is None:
                return None
            return ExpiringRow(Id=BOOK_ID, LifecycleStatus=book_status)

        service.repo.book = AsyncMock(side_effect=lambda *_a, **_kw: make_book_proxy())

        def stage_reservation(page_orm):
            persisted_pages.append(
                {
                    "Id": page_orm.Id,
                    "BookId": page_orm.BookId,
                    "PageNumber": page_orm.PageNumber,
                    "ImagePath": page_orm.ImagePath,
                    "Width": page_orm.Width,
                    "Height": page_orm.Height,
                    "LifecycleStatus": page_orm.LifecycleStatus,
                    "ProcessingMeta": dict(page_orm.ProcessingMeta or {}),
                }
            )

        def stage_bundle(page_orm, revision_orm, _words):
            for row in persisted_pages:
                if row["Id"] == page_orm.Id:
                    row["LifecycleStatus"] = page_orm.LifecycleStatus
                    row["ProcessingMeta"] = dict(page_orm.ProcessingMeta or {})
                    row["PageNumber"] = page_orm.PageNumber
            revisions_by_id[revision_orm.Id] = {
                "Id": revision_orm.Id,
                "PageId": revision_orm.PageId,
                "RevisionNo": revision_orm.RevisionNo,
                "VerificationStatus": revision_orm.VerificationStatus,
                "DraftText": revision_orm.DraftText,
                "ProcessingMeta": dict(revision_orm.ProcessingMeta or {}),
                "CreatedAt": datetime.now(timezone.utc),
                "VerifiedAt": None,
                "VerifiedBy": None,
            }

        async def active_pages_for_renumber(_book_id, *, lock=False):
            return [
                ExpiringRow(**row)
                for row in sorted(persisted_pages, key=lambda item: int(item["PageNumber"]))
                if row["LifecycleStatus"] in ("ACTIVE", "PROCESSING")
            ]

        async def next_active_page_number(_book_id):
            nums = [
                int(row["PageNumber"])
                for row in persisted_pages
                if row["LifecycleStatus"] in ("ACTIVE", "PROCESSING")
            ]
            return max(nums, default=0) + 1

        async def find_page(page_id, *, lock=False):
            found = next((row for row in persisted_pages if row["Id"] == page_id), None)
            return ExpiringRow(**found) if found else None

        async def find_page_for_upload(_book_id, upload_id):
            found = next(
                (
                    row
                    for row in persisted_pages
                    if (row.get("ProcessingMeta") or {}).get("upload_id") == str(upload_id)
                ),
                None,
            )
            return ExpiringRow(**found) if found else None

        async def delete_page(page_proxy):
            target_id = object.__getattribute__(page_proxy, "_attrs")["Id"]
            persisted_pages[:] = [row for row in persisted_pages if row["Id"] != target_id]

        def set_lifecycle(page_proxy, state):
            attrs = object.__getattribute__(page_proxy, "_attrs")
            attrs["LifecycleStatus"] = state
            for row in persisted_pages:
                if row["Id"] == attrs["Id"]:
                    row["LifecycleStatus"] = state

        def set_page_number(page_proxy, num):
            attrs = object.__getattribute__(page_proxy, "_attrs")
            attrs["PageNumber"] = num
            for row in persisted_pages:
                if row["Id"] == attrs["Id"]:
                    row["PageNumber"] = num

        async def find_revision(_page_id, rev_id, *, lock=False):
            found = revisions_by_id.get(rev_id)
            return ExpiringRow(**found) if found else None

        service.repo.stage_page_reservation = MagicMock(side_effect=stage_reservation)
        service.repo.stage_page_revision_bundle = MagicMock(side_effect=stage_bundle)
        service.repo.active_pages_for_renumber = AsyncMock(
            side_effect=active_pages_for_renumber
        )
        service.repo.next_active_page_number = AsyncMock(
            side_effect=next_active_page_number
        )
        service.repo.page = AsyncMock(side_effect=find_page)
        service.repo.page_for_upload = AsyncMock(side_effect=find_page_for_upload)
        service.repo.delete_page = AsyncMock(side_effect=delete_page)
        service.repo.set_page_lifecycle_status = MagicMock(side_effect=set_lifecycle)
        service.repo.set_page_number = MagicMock(side_effect=set_page_number)
        service.repo.revision = AsyncMock(side_effect=find_revision)
        service.repo.words = AsyncMock(return_value=[])

        async def fake_revision_detail(page, revision, *, word_rows=None):
            return AdminRevisionDetailRead(
                page_id=page.Id,
                page_revision_id=revision.Id,
                revision_no=int(revision.RevisionNo),
                verification_status=revision.VerificationStatus,
                lifecycle_status=page.LifecycleStatus,
                draft_text=revision.DraftText,
                words=[],
                ocr_metadata={"engine": "tesseract"},
                created_at=datetime.now(timezone.utc),
                verified_at=None,
                verified_by=None,
            )

        service.revision_detail = AsyncMock(side_effect=fake_revision_detail)
        service._persisted_pages = persisted_pages
        return service

    @staticmethod
    def _ocr_available() -> bool:
        diag = runtime_configuration_diagnostics()
        return bool(diag.get("ocr_engine_available") and diag.get("vietnamese_language_available"))

    async def test_scenario_1_real_ocr_on_multipage_vietnamese_pdf(self):
        if not self._ocr_available():
            self.skipTest("Local Vietnamese OCR engine unavailable in this environment")

        font_path, _ = _find_unicode_font_paths()
        doc = pymupdf.open()
        for line in (
            "Buổi sáng mùa thu chú mèo nhỏ đi học",
            "Cô giáo dạy bé đọc sách tiếng Việt",
        ):
            page = doc.new_page(width=595, height=842)
            page.insert_text((60, 120), line, fontname="vi", fontfile=font_path, fontsize=22)
        pdf_bytes = doc.tobytes()
        doc.close()

        bundle = rasterize_uploaded_document(
            filename="truyen-viet.pdf",
            content_type="application/pdf",
            data=pdf_bytes,
        )
        self.assertEqual(len(bundle.pages), 2)

        texts: list[str] = []
        for page_img in bundle.pages:
            ocr = extract_text_and_boxes(page_img.image_bytes)
            words = AdminOcrService._word_data(ocr["words"])
            self.assertGreaterEqual(len(words), 4)
            for idx, word in enumerate(words):
                self.assertEqual(word["word_index"], idx)
                normalize_ocr_bbox(word["bbox"])
            texts.append(unicodedata.normalize("NFC", str(ocr["text"])).lower())

        self.assertTrue("mèo" in texts[0] or "học" in texts[0], f"Unexpected page 1 OCR: {texts[0]}")
        self.assertTrue("sách" in texts[1] or "việt" in texts[1], f"Unexpected page 2 OCR: {texts[1]}")

    async def test_scenario_2_real_ocr_on_mixed_vietnamese_docx(self):
        if not self._ocr_available():
            self.skipTest("Local Vietnamese OCR engine unavailable in this environment")

        inline_img_bytes = _render_vietnamese_image(
            "Ảnh trang sách đính kèm",
            format_name="PNG",
            size=(900, 180),
            font_size=40,
        )
        document = docx.Document()
        document.add_heading("Bài đọc mùa xuân", level=1)
        document.add_paragraph(
            unicodedata.normalize("NFD", "Bé chăm chỉ luyện đọc tiếng Việt mỗi ngày.")
        )
        table = document.add_table(rows=2, cols=2)
        table.cell(0, 0).text = "Từ khóa"
        table.cell(0, 1).text = "Ý nghĩa"
        table.cell(1, 0).text = "Chăm ngoan"
        table.cell(1, 1).text = "Nghe lời cha mẹ"
        document.add_picture(BytesIO(inline_img_bytes))
        buf = BytesIO()
        document.save(buf)

        bundle = rasterize_uploaded_document(
            filename="bai-tap.docx",
            content_type="",
            data=buf.getvalue(),
        )
        self.assertGreaterEqual(len(bundle.pages), 1)
        ocr = extract_text_and_boxes(bundle.pages[0].image_bytes)
        words = AdminOcrService._word_data(ocr["words"])
        self.assertGreaterEqual(len(words), 10)
        recognized = unicodedata.normalize("NFC", str(ocr["text"])).lower()
        self.assertIn("mùa", recognized)
        self.assertIn("chăm", recognized)
        self.assertIn("đính", recognized)

    async def test_scenario_3_real_ocr_on_rgba_png_bmp_multiframe_tiff_and_oversized(self):
        if not self._ocr_available():
            self.skipTest("Local Vietnamese OCR engine unavailable in this environment")

        rgba_png = _render_vietnamese_image(
            "Con cò bay lả bay la",
            format_name="PNG",
            mode="RGBA",
            background=(0, 0, 0, 0),
            text_color=(0, 0, 0, 255),
        )
        bmp_bytes = _render_vietnamese_image(
            "Trang sách định dạng BMP",
            format_name="BMP",
        )
        tiff_frames = [
            Image.open(BytesIO(_render_vietnamese_image("Trang TIFF một", format_name="PNG"))),
            Image.open(BytesIO(_render_vietnamese_image("Trang TIFF hai", format_name="PNG"))),
        ]
        tiff_buf = BytesIO()
        tiff_frames[0].save(tiff_buf, format="TIFF", save_all=True, append_images=tiff_frames[1:])
        for frame in tiff_frames:
            frame.close()

        oversized_png = _render_vietnamese_image(
            "Ảnh quét khổ lớn",
            format_name="PNG",
            size=(6400, 4800),
            font_size=120,
        )

        for fname, ctype, raw, expected_substr in (
            ("transparent.png", "image/png", rgba_png, "bay"),
            ("scan.bmp", "image/bmp", bmp_bytes, "trang"),
            ("multi.tiff", "image/tiff", tiff_buf.getvalue(), "tiff"),
            ("large.png", "image/png", oversized_png, "lớn"),
        ):
            bundle = rasterize_uploaded_document(filename=fname, content_type=ctype, data=raw)
            for page in bundle.pages:
                self.assertLessEqual(max(page.width, page.height), 6000)
                ocr = extract_text_and_boxes(page.image_bytes)
                words = AdminOcrService._word_data(ocr["words"])
                self.assertTrue(words)
                self.assertIn(
                    expected_substr,
                    unicodedata.normalize("NFC", str(ocr["text"])).lower(),
                )
            if fname == "large.png":
                self.assertEqual((bundle.pages[0].width, bundle.pages[0].height), (6000, 4500))

    async def test_scenario_4_sequential_mixed_book_uploads_and_retired_or_missing_errors(self):
        service = self._make_strict_stateful_service(book_status="ACTIVE")
        png_bytes = _render_vietnamese_image("Trang bìa", format_name="PNG")
        pdf_bytes = _make_pdf_bytes(["Trang PDF 1", "", "Trang PDF 3"])
        docx_bytes = _make_docx_bytes(paragraphs=["Đoạn Word 1"], page_breaks=1)
        bmp_bytes = _make_bmp_bytes()

        with (
            patch("app.services.admin_ocr_service.upload_object"),
            patch("app.services.admin_ocr_service.delete_object"),
            patch(
                "app.services.admin_ocr_service.extract_text_and_boxes",
                side_effect=[
                    _fake_ocr_result("Bìa"),
                    _fake_ocr_result("Pdf1"),
                    OcrNoTextDetected("blank"),
                    _fake_ocr_result("Pdf3"),
                    _fake_ocr_result("Docx1"),
                    _fake_ocr_result("Docx2"),
                    _fake_ocr_result("Bmp"),
                ],
            ),
        ):
            await service.upload_page(
                ACTOR_ID,
                BOOK_ID,
                UploadFile(
                    file=BytesIO(png_bytes),
                    filename="cover.png",
                    headers={"content-type": "image/png"},
                ),
            )
            pdf_res = await service.upload_document(
                ACTOR_ID,
                BOOK_ID,
                UploadFile(
                    file=BytesIO(pdf_bytes),
                    filename="lesson.pdf",
                    headers={"content-type": "application/pdf"},
                ),
            )
            docx_res = await service.upload_document(
                ACTOR_ID,
                BOOK_ID,
                UploadFile(
                    file=BytesIO(docx_bytes),
                    filename="exercise.docx",
                    headers={"content-type": ""},
                ),
            )
            bmp_res = await service.upload_document(
                ACTOR_ID,
                BOOK_ID,
                UploadFile(
                    file=BytesIO(bmp_bytes),
                    filename="appendix.bmp",
                    headers={"content-type": "image/bmp"},
                ),
            )

        self.assertEqual(pdf_res.skipped_empty_count, 1)
        self.assertEqual(docx_res.created_pages_count, 2)
        self.assertEqual(bmp_res.created_pages_count, 1)
        self.assertEqual([row["PageNumber"] for row in service._persisted_pages], [1, 2, 3, 4, 5, 6])

        # Verify 409 RETIRED and 404 NOT FOUND also never raise MissingGreenlet
        retired_service = self._make_strict_stateful_service(book_status="RETIRED")
        with self.assertRaises(HTTPException) as retired_err:
            await retired_service.upload_document(
                ACTOR_ID,
                BOOK_ID,
                UploadFile(file=BytesIO(pdf_bytes), filename="x.pdf", headers={"content-type": "application/pdf"}),
            )
        self.assertEqual(retired_err.exception.status_code, 409)

        missing_service = self._make_strict_stateful_service(book_status=None)
        with self.assertRaises(HTTPException) as missing_err:
            await missing_service.upload_document(
                ACTOR_ID,
                BOOK_ID,
                UploadFile(file=BytesIO(pdf_bytes), filename="x.pdf", headers={"content-type": "application/pdf"}),
            )
        self.assertEqual(missing_err.exception.status_code, 404)

    async def test_scenario_5_mid_document_storage_outage_and_idempotent_retry_recovery(self):
        service = self._make_strict_stateful_service(book_status="ACTIVE")
        pdf_bytes = _make_pdf_bytes(["Trang 1", "Trang 2", "Trang 3"])
        retry_upload_id = uuid4()

        storage_attempt = 0

        def flaky_upload(*_args, **_kwargs):
            nonlocal storage_attempt
            storage_attempt += 1
            if storage_attempt == 2:
                raise StorageUploadFailure(
                    "Could not save the image to Supabase Storage",
                    cleanup_may_be_needed=True,
                )

        with (
            patch("app.services.admin_ocr_service.upload_object", side_effect=flaky_upload) as uploaded,
            patch("app.services.admin_ocr_service.delete_object") as deleted_obj,
            patch(
                "app.services.admin_ocr_service.extract_text_and_boxes",
                return_value=_fake_ocr_result("Trang"),
            ) as ocr_mock,
        ):
            first = await service.upload_document(
                ACTOR_ID,
                BOOK_ID,
                UploadFile(
                    file=BytesIO(pdf_bytes),
                    filename="flaky.pdf",
                    headers={"content-type": "application/pdf"},
                ),
                upload_id=retry_upload_id,
            )
            self.assertEqual(first.created_pages_count, 1)
            self.assertEqual(first.failed_pages_count, 2)
            self.assertEqual([p.status for p in first.pages], ["SUCCEEDED", "FAILED", "FAILED"])
            self.assertEqual(len(service._persisted_pages), 1)
            deleted_obj.assert_called_once()
            self.assertEqual(uploaded.call_count, 2)
            self.assertEqual(ocr_mock.call_count, 1)

            # Retry with the same upload_id after Storage recovers -> Page 1 reused idempotently!
            second = await service.upload_document(
                ACTOR_ID,
                BOOK_ID,
                UploadFile(
                    file=BytesIO(pdf_bytes),
                    filename="flaky.pdf",
                    headers={"content-type": "application/pdf"},
                ),
                upload_id=retry_upload_id,
            )

        self.assertEqual(second.created_pages_count, 3)
        self.assertEqual(second.failed_pages_count, 0)
        self.assertEqual([row["PageNumber"] for row in service._persisted_pages], [1, 2, 3])
        # Page 1 reused without extra Storage upload or OCR: +2 uploads (pages 2 & 3), +2 OCR calls
        self.assertEqual(uploaded.call_count, 4)
        self.assertEqual(ocr_mock.call_count, 3)


if __name__ == "__main__":
    unittest.main()
