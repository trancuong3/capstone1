from __future__ import annotations

import gc
import hashlib
import logging
import math
import os
import re
import shutil
import subprocess
import tempfile
import unicodedata
import xml.etree.ElementTree as ET
import zipfile
from collections.abc import Iterator
from contextlib import contextmanager
from dataclasses import dataclass
from io import BytesIO
from pathlib import Path, PurePath
from typing import Any, BinaryIO, Literal

from fastapi import HTTPException, UploadFile
from PIL import Image, ImageDraw, ImageFont, ImageOps, ImageSequence, UnidentifiedImageError

logger = logging.getLogger(__name__)

MAX_SINGLE_IMAGE_BYTES = 12 * 1024 * 1024
MAX_DOCUMENT_BYTES = 50 * 1024 * 1024
MAX_DOCUMENT_PAGES = 30
MAX_PAGE_IMAGE_DIMENSION = 6000
MAX_PAGE_IMAGE_PIXELS = MAX_PAGE_IMAGE_DIMENSION * MAX_PAGE_IMAGE_DIMENSION
MAX_PAGE_IMAGE_BYTES = 12 * 1024 * 1024

MAX_DOCX_UNCOMPRESSED_BYTES = 100 * 1024 * 1024
MAX_DOCX_ZIP_ENTRIES = 2000
MAX_DOCX_COMPRESSION_RATIO = 200.0
MAX_DOCX_RATIO_CHECK_MIN_BYTES = 10 * 1024 * 1024

OLE2_MAGIC = b"\xd0\xcf\x11\xe0\xa1\xb1\x1a\xe1"
SUPPORTED_EXTENSIONS = {
    ".jpg",
    ".jpeg",
    ".png",
    ".webp",
    ".bmp",
    ".tif",
    ".tiff",
    ".pdf",
    ".docx",
}

SourceDocumentFormat = Literal["JPEG", "PNG", "WEBP", "BMP", "TIFF", "PDF", "DOCX"]

_FORMAT_EXTENSIONS: dict[SourceDocumentFormat, set[str]] = {
    "JPEG": {".jpg", ".jpeg"},
    "PNG": {".png"},
    "WEBP": {".webp"},
    "BMP": {".bmp"},
    "TIFF": {".tif", ".tiff"},
    "PDF": {".pdf"},
    "DOCX": {".docx"},
}

_FORMAT_MIMES: dict[SourceDocumentFormat, set[str]] = {
    "JPEG": {"image/jpeg", "image/jpg", "image/pjpeg"},
    "PNG": {"image/png"},
    "WEBP": {"image/webp"},
    "BMP": {"image/bmp", "image/x-ms-bmp", "image/x-bmp"},
    "TIFF": {"image/tiff", "image/x-tiff"},
    "PDF": {"application/pdf", "application/x-pdf"},
    "DOCX": {
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    },
}

_GENERIC_MIMES = {"", "application/octet-stream", "binary/octet-stream"}

_A4_WIDTH = 1654
_A4_HEIGHT = 2339
_MARGIN_X = 120
_MARGIN_Y = 130
_PDF_RENDER_DPI = 220.0
_MIN_FREE_TEMP_BYTES = 200 * 1024 * 1024
_UPLOAD_SPOOL_CHUNK_BYTES = 256 * 1024
_UPLOAD_SPOOL_RAM_THRESHOLD_BYTES = 2 * 1024 * 1024


def _is_constrained_web_runtime() -> bool:
    """Detect 512 MiB Render / remote-worker web deployments where memory headroom is tight."""
    render = (os.getenv("RENDER") or "").strip().lower() in {"1", "true", "yes", "on"}
    disable_heavy = (os.getenv("VIREAD_WEB_DISABLE_HEAVY_WORKERS") or "").strip().lower() in {
        "1",
        "true",
        "yes",
        "on",
    }
    remote_ocr = (os.getenv("VIREAD_OCR_MODE") or "").strip().lower() == "remote_worker"
    return render or disable_heavy or remote_ocr


def _resolve_pdf_render_dpi() -> float:
    raw = (os.getenv("VIREAD_RASTERIZE_DPI") or "").strip()
    if raw:
        try:
            return max(96.0, min(300.0, float(raw)))
        except ValueError:
            pass
    return 160.0 if _is_constrained_web_runtime() else _PDF_RENDER_DPI


def _resolve_max_render_edge() -> int:
    raw = (os.getenv("VIREAD_RASTERIZE_MAX_EDGE") or "").strip()
    if raw:
        try:
            return max(1000, min(MAX_PAGE_IMAGE_DIMENSION, int(raw)))
        except ValueError:
            pass
    return 2400 if _is_constrained_web_runtime() else MAX_PAGE_IMAGE_DIMENSION


@dataclass(frozen=True)
class RasterizedDocumentPage:
    source_page: int
    image_bytes: bytes
    content_type: str
    extension: str
    width: int
    height: int


@dataclass(frozen=True)
class RasterizedDocumentBundle:
    file_name: str
    source_format: SourceDocumentFormat
    source_sha256: str
    pages: tuple[RasterizedDocumentPage, ...]


@dataclass
class SpooledUploadDocument:
    """Disk-backed spooled upload holding file metadata without keeping 50 MB in Python heap RAM."""

    file_name: str
    content_type: str | None
    byte_length: int
    source_sha256: str
    spool_file: tempfile.SpooledTemporaryFile[bytes]
    header_bytes: bytes

    def close(self) -> None:
        try:
            self.spool_file.close()
        except Exception:
            pass


async def spool_upload_file(
    upload: UploadFile,
    *,
    max_bytes: int = MAX_DOCUMENT_BYTES,
) -> SpooledUploadDocument:
    """Stream an UploadFile into a SpooledTemporaryFile while computing SHA-256."""
    spool: tempfile.SpooledTemporaryFile[bytes] = tempfile.SpooledTemporaryFile(
        max_size=_UPLOAD_SPOOL_RAM_THRESHOLD_BYTES,
        mode="w+b",
    )
    hasher = hashlib.sha256()
    total = 0
    header_buf = bytearray()
    try:
        while True:
            chunk = await upload.read(_UPLOAD_SPOOL_CHUNK_BYTES)
            if not chunk:
                break
            total += len(chunk)
            if total > max_bytes:
                raise HTTPException(status_code=413, detail="Document exceeds the 50 MB limit")
            hasher.update(chunk)
            if len(header_buf) < 8192:
                need = 8192 - len(header_buf)
                header_buf.extend(chunk[:need])
            spool.write(chunk)
        spool.seek(0)
        return SpooledUploadDocument(
            file_name=upload.filename or "",
            content_type=upload.content_type,
            byte_length=total,
            source_sha256=hasher.hexdigest(),
            spool_file=spool,
            header_bytes=bytes(header_buf),
        )
    except Exception:
        try:
            spool.close()
        except Exception:
            pass
        raise


def _detect_format_by_magic(data: bytes) -> SourceDocumentFormat | None:
    if data.lstrip()[:5] == b"%PDF-":
        return "PDF"
    if data[:4] == b"PK\x03\x04":
        return "DOCX"
    if data[:4] in (b"II*\x00", b"MM\x00*"):
        return "TIFF"
    if data[:2] == b"BM":
        return "BMP"
    if data[:3] == b"\xff\xd8\xff":
        return "JPEG"
    if data[:8] == b"\x89PNG\r\n\x1a\n":
        return "PNG"
    if len(data) >= 12 and data[:4] == b"RIFF" and data[8:12] == b"WEBP":
        return "WEBP"
    return None


_XML_UNSAFE_DECL_RE = re.compile(r"<!\s*(?:doctype|entity)\b", re.IGNORECASE)
_XML_EXTERNAL_TARGET_MODE_RE = re.compile(r"""targetmode\s*=\s*["']\s*external\s*["']""", re.IGNORECASE)
_UNSAFE_EXTERNAL_TARGET_RE = re.compile(r"(?:https?://|file://|ftp://|smb://|\\\\)", re.IGNORECASE)
_EXTERNAL_REF_ATTR_NAMES = frozenset({"target", "href", "src", "link", "url"})


def _decode_xml_text_for_inspection(raw: bytes) -> str:
    """Decode XML bytes with UTF-8/UTF-16/UTF-32 BOM and Appendix-F auto-detection."""
    if not raw:
        return ""
    if raw.startswith((b"\xff\xfe\x00\x00", b"\x00\x00\xfe\xff")):
        return raw.decode("utf-32", errors="replace")
    if raw.startswith((b"\xff\xfe", b"\xfe\xff")):
        return raw.decode("utf-16", errors="replace")
    if raw.startswith(b"\xef\xbb\xbf"):
        return raw.decode("utf-8-sig", errors="replace")
    if raw.startswith(b"\x00\x00\x00<"):
        return raw.decode("utf-32-be", errors="replace")
    if raw.startswith(b"<\x00\x00\x00"):
        return raw.decode("utf-32-le", errors="replace")
    if raw.startswith(b"\x00<"):
        return raw.decode("utf-16-be", errors="replace")
    if raw.startswith(b"<\x00"):
        return raw.decode("utf-16-le", errors="replace")
    sample = raw[:64]
    if b"\x00" in sample:
        even_nulls = sum(1 for i in range(0, len(sample), 2) if sample[i] == 0)
        odd_nulls = sum(1 for i in range(1, len(sample), 2) if sample[i] == 0)
        if even_nulls > odd_nulls and even_nulls >= max(2, len(sample) // 8):
            return raw.decode("utf-16-be", errors="replace")
        if odd_nulls > even_nulls and odd_nulls >= max(2, len(sample) // 8):
            return raw.decode("utf-16-le", errors="replace")
    return raw.decode("utf-8", errors="replace")


def _xml_local_name(tag_or_attr: str) -> str:
    if "}" in tag_or_attr:
        return tag_or_attr.rsplit("}", 1)[1].lower()
    if ":" in tag_or_attr:
        return tag_or_attr.rsplit(":", 1)[1].lower()
    return tag_or_attr.lower()


def _is_unsafe_external_target(value: str) -> bool:
    stripped = (value or "").strip()
    if not stripped:
        return False
    lowered = stripped.lower()
    if lowered.startswith(("http://", "https://", "file://", "ftp://", "smb://", "\\\\", "//")):
        return True
    if _UNSAFE_EXTERNAL_TARGET_RE.search(stripped):
        return True
    return False


def _validate_docx_xml_entry(lower_name: str, raw_bytes: bytes) -> None:
    decoded = _decode_xml_text_for_inspection(raw_bytes)
    normalized_probe = decoded.replace("\x00", "")
    if _XML_UNSAFE_DECL_RE.search(decoded) or _XML_UNSAFE_DECL_RE.search(normalized_probe):
        raise HTTPException(
            status_code=422,
            detail="Document XML contains unsafe declarations",
        )
    if _XML_EXTERNAL_TARGET_MODE_RE.search(decoded) or _XML_EXTERNAL_TARGET_MODE_RE.search(normalized_probe):
        raise HTTPException(
            status_code=422,
            detail="Document XML contains unsafe external references",
        )
    try:
        root = ET.fromstring(decoded)
    except ET.ParseError as exc:
        raise HTTPException(
            status_code=422,
            detail="The uploaded document is empty or corrupted",
        ) from exc

    is_rels = lower_name.endswith(".rels")
    for elem in root.iter():
        elem_local = _xml_local_name(elem.tag)
        for attr_key, attr_val in elem.attrib.items():
            attr_local = _xml_local_name(attr_key)
            val_str = str(attr_val or "").strip()
            if attr_local == "targetmode" and val_str.lower() == "external":
                raise HTTPException(
                    status_code=422,
                    detail="Document XML contains unsafe external references",
                )
            if is_rels and attr_local == "target" and _is_unsafe_external_target(val_str):
                raise HTTPException(
                    status_code=422,
                    detail="Document XML contains unsafe external references",
                )
            if attr_local in _EXTERNAL_REF_ATTR_NAMES and _is_unsafe_external_target(val_str):
                raise HTTPException(
                    status_code=422,
                    detail="Document XML contains unsafe external references",
                )
            if elem_local == "fldsimple" and attr_local == "instr" and _is_unsafe_external_target(val_str):
                raise HTTPException(
                    status_code=422,
                    detail="Document XML contains unsafe external references",
                )
        if elem_local == "instrtext":
            field_text = "".join(elem.itertext())
            if _is_unsafe_external_target(field_text):
                raise HTTPException(
                    status_code=422,
                    detail="Document XML contains unsafe external references",
                )


def _validate_docx_archive(source: bytes | BinaryIO) -> None:
    stream: BinaryIO
    if isinstance(source, (bytes, bytearray)):
        stream = BytesIO(source)
    else:
        source.seek(0)
        stream = source
    try:
        with zipfile.ZipFile(stream, "r") as zf:
            infos = zf.infolist()
            if len(infos) > MAX_DOCX_ZIP_ENTRIES:
                raise HTTPException(
                    status_code=422,
                    detail="Archive structure exceeds safe extraction limits",
                )

            total_declared_uncompressed = 0
            names_lower: set[str] = set()

            for info in infos:
                if info.flag_bits & 0x1:
                    raise HTTPException(
                        status_code=422,
                        detail="Password-protected documents are not supported",
                    )
                entry_name = info.filename
                if entry_name.startswith(("/", "\\")) or "\\" in entry_name or ".." in entry_name.split("/"):
                    raise HTTPException(
                        status_code=422,
                        detail="Archive structure exceeds safe extraction limits",
                    )
                lower_name = entry_name.lower()
                names_lower.add(lower_name)
                if lower_name.endswith("vbaproject.bin") or lower_name.startswith("word/vba"):
                    raise HTTPException(
                        status_code=415,
                        detail="Macro-enabled Word documents are not permitted",
                    )

                total_declared_uncompressed += info.file_size
                if total_declared_uncompressed > MAX_DOCX_UNCOMPRESSED_BYTES:
                    raise HTTPException(
                        status_code=422,
                        detail="Archive structure exceeds safe extraction limits",
                    )
                if info.file_size > MAX_DOCX_RATIO_CHECK_MIN_BYTES:
                    ratio = info.file_size / max(info.compress_size, 1)
                    if ratio > MAX_DOCX_COMPRESSION_RATIO:
                        raise HTTPException(
                            status_code=422,
                            detail="Archive structure exceeds safe extraction limits",
                        )

            if "[content_types].xml" not in names_lower or "word/document.xml" not in names_lower:
                raise HTTPException(
                    status_code=415,
                    detail="File content does not match the declared file type or extension",
                )

            # Stream-verify actual decompressed bytes for ALL entries (never trust info.file_size header).
            total_read_bytes = 0
            for info in infos:
                lower_name = info.filename.lower()
                is_xml_or_rels = lower_name.endswith(".xml") or lower_name.endswith(".rels")
                chunks: list[bytes] = []
                entry_read_bytes = 0
                with zf.open(info, "r") as entry_stream:
                    while True:
                        chunk = entry_stream.read(65536)
                        if not chunk:
                            break
                        entry_read_bytes += len(chunk)
                        total_read_bytes += len(chunk)
                        if total_read_bytes > MAX_DOCX_UNCOMPRESSED_BYTES:
                            raise HTTPException(
                                status_code=422,
                                detail="Archive structure exceeds safe extraction limits",
                            )
                        if entry_read_bytes > MAX_DOCX_RATIO_CHECK_MIN_BYTES:
                            actual_ratio = entry_read_bytes / max(info.compress_size, 1)
                            if actual_ratio > MAX_DOCX_COMPRESSION_RATIO:
                                raise HTTPException(
                                    status_code=422,
                                    detail="Archive structure exceeds safe extraction limits",
                                )
                        if is_xml_or_rels:
                            chunks.append(chunk)
                if is_xml_or_rels:
                    _validate_docx_xml_entry(lower_name, b"".join(chunks))
    except HTTPException:
        raise
    except (zipfile.BadZipFile, OSError, RuntimeError) as exc:
        raise HTTPException(
            status_code=422,
            detail="The uploaded document is empty or corrupted",
        ) from exc


def _assert_pil_image_within_pixel_budget(image: Image.Image) -> None:
    """Enforce pixel budget on lazy header dimensions before load()/exif_transpose() without mutating Image.MAX_IMAGE_PIXELS."""
    width, height = image.size
    if width <= 0 or height <= 0:
        raise HTTPException(
            status_code=422,
            detail="The uploaded document is empty or corrupted",
        )
    if width * height > MAX_PAGE_IMAGE_PIXELS:
        raise HTTPException(
            status_code=413,
            detail="Image dimensions must not exceed 6000 by 6000 pixels",
        )


def _flatten_to_rgb(image: Image.Image) -> Image.Image:
    transposed = ImageOps.exif_transpose(image)
    if transposed.mode in ("RGBA", "LA") or (
        transposed.mode == "P" and "transparency" in transposed.info
    ):
        rgba = transposed.convert("RGBA")
        canvas = Image.new("RGB", rgba.size, (255, 255, 255))
        canvas.paste(rgba, mask=rgba.getchannel("A"))
        return canvas
    if transposed.mode != "RGB":
        return transposed.convert("RGB")
    return transposed


def _resolve_rasterizer_output_format() -> Literal["jpeg", "png"]:
    raw = (os.getenv("VIREAD_RASTERIZER_FORMAT") or "jpeg").strip().lower()
    if raw == "png":
        return "png"
    return "jpeg"


def _resolve_rasterizer_jpeg_quality() -> int:
    raw = (os.getenv("VIREAD_RASTERIZER_JPEG_QUALITY") or "85").strip()
    try:
        return max(60, min(95, int(raw)))
    except ValueError:
        return 85


def _normalize_pil_frame(
    frame: Image.Image,
    *,
    output_format: Literal["jpeg", "png"] | None = None,
) -> tuple[bytes, str, str, int, int]:
    _assert_pil_image_within_pixel_budget(frame)
    canvas = _flatten_to_rgb(frame)
    owns_canvas = canvas is not frame
    try:
        width, height = canvas.size
        if width <= 0 or height <= 0:
            raise HTTPException(
                status_code=422,
                detail="The uploaded document is empty or corrupted",
            )
        max_edge = _resolve_max_render_edge()
        if max(width, height) > max_edge:
            scale = max_edge / float(max(width, height))
            new_w = max(1, min(max_edge, int(round(width * scale))))
            new_h = max(1, min(max_edge, int(round(height * scale))))
            resized = canvas.resize((new_w, new_h), Image.Resampling.LANCZOS)
            if owns_canvas:
                canvas.close()
            canvas = resized
            owns_canvas = True
            width, height = canvas.size

        target_format = output_format or _resolve_rasterizer_output_format()
        default_q = _resolve_rasterizer_jpeg_quality()

        if target_format == "png":
            png_buffer = BytesIO()
            canvas.save(png_buffer, format="PNG", optimize=True)
            png_bytes = png_buffer.getvalue()
            if len(png_bytes) <= MAX_PAGE_IMAGE_BYTES:
                return png_bytes, "image/png", "png", width, height

        qualities = (default_q, 75) if default_q > 75 else (default_q,)
        if target_format == "png":
            qualities = (92, default_q, 75)
        for quality in qualities:
            jpeg_buffer = BytesIO()
            canvas.save(jpeg_buffer, format="JPEG", quality=quality, optimize=True)
            jpeg_bytes = jpeg_buffer.getvalue()
            if len(jpeg_bytes) <= MAX_PAGE_IMAGE_BYTES:
                return jpeg_bytes, "image/jpeg", "jpg", width, height

        raise HTTPException(
            status_code=413,
            detail="Image exceeds the 12 MB limit",
        )
    finally:
        if owns_canvas:
            canvas.close()


def _iter_image_pages(
    source: bytes | BinaryIO,
    source_format: SourceDocumentFormat,
) -> Iterator[RasterizedDocumentPage]:
    stream: BinaryIO = BytesIO(source) if isinstance(source, (bytes, bytearray)) else source
    if not isinstance(source, (bytes, bytearray)):
        stream.seek(0)
    yielded = 0
    try:
        with Image.open(stream) as img:
            if source_format == "TIFF":
                for index, frame in enumerate(ImageSequence.Iterator(img), start=1):
                    if index > MAX_DOCUMENT_PAGES:
                        raise HTTPException(
                            status_code=422,
                            detail="Document exceeds the 30-page limit per upload",
                        )
                    _assert_pil_image_within_pixel_budget(frame)
                    frame_copy = frame.copy()
                    try:
                        out_bytes, ctype, ext, w, h = _normalize_pil_frame(frame_copy)
                    finally:
                        frame_copy.close()
                    yielded += 1
                    yield RasterizedDocumentPage(
                        source_page=index,
                        image_bytes=out_bytes,
                        content_type=ctype,
                        extension=ext,
                        width=w,
                        height=h,
                    )
                    del out_bytes
                    gc.collect()
            else:
                _assert_pil_image_within_pixel_budget(img)
                img.load()
                out_bytes, ctype, ext, w, h = _normalize_pil_frame(img)
                yielded += 1
                yield RasterizedDocumentPage(
                    source_page=1,
                    image_bytes=out_bytes,
                    content_type=ctype,
                    extension=ext,
                    width=w,
                    height=h,
                )
    except HTTPException:
        raise
    except Image.DecompressionBombError as exc:
        raise HTTPException(
            status_code=413,
            detail="Image dimensions must not exceed 6000 by 6000 pixels",
        ) from exc
    except (UnidentifiedImageError, OSError, ValueError) as exc:
        raise HTTPException(
            status_code=422,
            detail="The uploaded document is empty or corrupted",
        ) from exc

    if yielded == 0:
        raise HTTPException(
            status_code=422,
            detail="The uploaded document is empty or corrupted",
        )


def _compute_safe_pdf_render_scale(
    page_w_pt: float,
    page_h_pt: float,
    *,
    render_dpi: float | None = None,
    max_edge: int | None = None,
) -> float:
    """Compute a PDF render scale strictly capped by MAX_PAGE_IMAGE_DIMENSION and MAX_PAGE_IMAGE_PIXELS."""
    if (
        not math.isfinite(page_w_pt)
        or not math.isfinite(page_h_pt)
        or page_w_pt <= 0.0
        or page_h_pt <= 0.0
    ):
        raise HTTPException(
            status_code=422,
            detail="PDF page dimensions are invalid",
        )
    dpi = _PDF_RENDER_DPI if render_dpi is None else float(render_dpi)
    edge_cap = (
        MAX_PAGE_IMAGE_DIMENSION
        if max_edge is None
        else min(MAX_PAGE_IMAGE_DIMENSION, int(max_edge))
    )
    max_pt = max(page_w_pt, page_h_pt)
    scale = min(dpi / 72.0, edge_cap / max_pt)
    if not math.isfinite(scale) or scale <= 0.0:
        raise HTTPException(
            status_code=422,
            detail="PDF page dimensions exceed safe rendering limits",
        )
    est_w = int(round(page_w_pt * scale))
    est_h = int(round(page_h_pt * scale))
    if (
        est_w < 1
        or est_h < 1
        or est_w > edge_cap
        or est_h > edge_cap
        or (est_w * est_h) > MAX_PAGE_IMAGE_PIXELS
    ):
        raise HTTPException(
            status_code=422,
            detail="PDF page dimensions exceed safe rendering limits",
        )
    return scale


def _rasterize_image_bytes(
    data: bytes,
    source_format: SourceDocumentFormat,
) -> list[RasterizedDocumentPage]:
    return list(_iter_image_pages(data, source_format))


def _iter_pdf_with_pypdfium2(source: bytes | Path) -> Iterator[RasterizedDocumentPage]:
    import pypdfium2  # type: ignore[import-not-found]

    render_dpi = _resolve_pdf_render_dpi()
    max_edge = _resolve_max_render_edge()
    pdf = None
    try:
        try:
            pdf = pypdfium2.PdfDocument(str(source) if isinstance(source, Path) else source)
        except Exception as exc:
            message = str(exc).lower()
            if "password" in message or "encrypt" in message:
                raise HTTPException(
                    status_code=422,
                    detail="Password-protected PDF files are not supported",
                ) from exc
            raise HTTPException(
                status_code=422,
                detail="The uploaded document is empty or corrupted",
            ) from exc

        page_count = len(pdf)
        if page_count <= 0:
            raise HTTPException(
                status_code=422,
                detail="The uploaded document is empty or corrupted",
            )
        if page_count > MAX_DOCUMENT_PAGES:
            raise HTTPException(
                status_code=422,
                detail="Document exceeds the 30-page limit per upload",
            )

        for idx in range(page_count):
            page = pdf[idx]
            bitmap = None
            pil_image = None
            try:
                page_w_pt, page_h_pt = page.get_size()
                scale = _compute_safe_pdf_render_scale(
                    float(page_w_pt),
                    float(page_h_pt),
                    render_dpi=render_dpi,
                    max_edge=max_edge,
                )
                bitmap = page.render(scale=scale)
                pil_image = bitmap.to_pil()
                _assert_pil_image_within_pixel_budget(pil_image)
                out_bytes, ctype, ext, w, h = _normalize_pil_frame(pil_image)
            finally:
                if pil_image is not None:
                    pil_image.close()
                if bitmap is not None:
                    bitmap.close()
                page.close()
            yield RasterizedDocumentPage(
                source_page=idx + 1,
                image_bytes=out_bytes,
                content_type=ctype,
                extension=ext,
                width=w,
                height=h,
            )
            del out_bytes
            gc.collect()
    finally:
        if pdf is not None:
            pdf.close()


def _rasterize_pdf_with_pypdfium2(data: bytes) -> list[RasterizedDocumentPage]:
    return list(_iter_pdf_with_pypdfium2(data))


def _iter_pdf_with_pymupdf(source: bytes | Path) -> Iterator[RasterizedDocumentPage]:
    import pymupdf  # type: ignore[import-not-found]

    render_dpi = _resolve_pdf_render_dpi()
    max_edge = _resolve_max_render_edge()
    doc = None
    try:
        try:
            doc = (
                pymupdf.open(str(source))
                if isinstance(source, Path)
                else pymupdf.open(stream=source, filetype="pdf")
            )
        except Exception as exc:
            raise HTTPException(
                status_code=422,
                detail="The uploaded document is empty or corrupted",
            ) from exc

        if getattr(doc, "needs_pass", False):
            raise HTTPException(
                status_code=422,
                detail="Password-protected PDF files are not supported",
            )
        page_count = int(doc.page_count)
        if page_count <= 0:
            raise HTTPException(
                status_code=422,
                detail="The uploaded document is empty or corrupted",
            )
        if page_count > MAX_DOCUMENT_PAGES:
            raise HTTPException(
                status_code=422,
                detail="Document exceeds the 30-page limit per upload",
            )

        for idx in range(page_count):
            page = doc[idx]
            rect = page.rect
            scale = _compute_safe_pdf_render_scale(
                float(rect.width),
                float(rect.height),
                render_dpi=render_dpi,
                max_edge=max_edge,
            )
            pix = page.get_pixmap(matrix=pymupdf.Matrix(scale, scale), alpha=False)
            if (
                pix.width <= 0
                or pix.height <= 0
                or pix.width > MAX_PAGE_IMAGE_DIMENSION
                or pix.height > MAX_PAGE_IMAGE_DIMENSION
                or (pix.width * pix.height) > MAX_PAGE_IMAGE_PIXELS
            ):
                raise HTTPException(
                    status_code=422,
                    detail="PDF page dimensions exceed safe rendering limits",
                )
            pil_image = Image.frombytes("RGB", (pix.width, pix.height), pix.samples)
            del pix
            try:
                out_bytes, ctype, ext, w, h = _normalize_pil_frame(pil_image)
            finally:
                pil_image.close()
            yield RasterizedDocumentPage(
                source_page=idx + 1,
                image_bytes=out_bytes,
                content_type=ctype,
                extension=ext,
                width=w,
                height=h,
            )
            del out_bytes
            gc.collect()
    finally:
        if doc is not None:
            doc.close()


def _rasterize_pdf_with_pymupdf(data: bytes) -> list[RasterizedDocumentPage]:
    return list(_iter_pdf_with_pymupdf(data))


def _iter_pdf_pages(source: bytes | Path) -> Iterator[RasterizedDocumentPage]:
    try:
        import pypdfium2  # noqa: F401
    except ImportError:
        pypdfium2_available = False
    else:
        pypdfium2_available = True

    if pypdfium2_available:
        yield from _iter_pdf_with_pypdfium2(source)
        return

    try:
        import pymupdf  # noqa: F401
    except ImportError:
        pymupdf_available = False
    else:
        pymupdf_available = True

    if pymupdf_available:
        yield from _iter_pdf_with_pymupdf(source)
        return

    raise HTTPException(
        status_code=503,
        detail="PDF rendering engine is not available on the server",
    )


def _rasterize_pdf_bytes(data: bytes) -> list[RasterizedDocumentPage]:
    return list(_iter_pdf_pages(data))


def _find_unicode_font_paths() -> tuple[str, str]:
    env_font = os.environ.get("VIREAD_DOCX_FONT_PATH", "").strip()
    regular_candidates = [
        env_font,
        r"C:\Windows\Fonts\segoeui.ttf",
        r"C:\Windows\Fonts\arial.ttf",
        r"C:\Windows\Fonts\tahoma.ttf",
        "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
        "/usr/share/fonts/truetype/noto/NotoSans-Regular.ttf",
        "/usr/share/fonts/truetype/liberation/LiberationSans-Regular.ttf",
        "/System/Library/Fonts/Supplemental/Arial Unicode.ttf",
        "/System/Library/Fonts/Supplemental/Arial.ttf",
    ]
    bold_candidates = [
        r"C:\Windows\Fonts\segoeuib.ttf",
        r"C:\Windows\Fonts\arialbd.ttf",
        r"C:\Windows\Fonts\tahomabd.ttf",
        "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
        "/usr/share/fonts/truetype/noto/NotoSans-Bold.ttf",
        "/usr/share/fonts/truetype/liberation/LiberationSans-Bold.ttf",
    ]

    regular_path = next((p for p in regular_candidates if p and Path(p).is_file()), "")
    if not regular_path:
        raise HTTPException(
            status_code=503,
            detail="Server Unicode font for DOCX rendering is unavailable",
        )
    bold_path = next((p for p in bold_candidates if p and Path(p).is_file()), regular_path)
    return regular_path, bold_path


def _wrap_text(
    draw: ImageDraw.ImageDraw,
    text: str,
    font: ImageFont.FreeTypeFont,
    max_width: float,
) -> list[str]:
    normalized = unicodedata.normalize("NFC", text)
    wrapped: list[str] = []
    for raw_line in normalized.splitlines() or [""]:
        stripped = raw_line.strip()
        if not stripped:
            continue
        words = stripped.split()
        current = ""
        for word in words:
            candidate = f"{current} {word}".strip() if current else word
            if draw.textlength(candidate, font=font) <= max_width:
                current = candidate
                continue
            if current:
                wrapped.append(current)
                current = ""
            if draw.textlength(word, font=font) <= max_width:
                current = word
            else:
                chunk = ""
                for char in word:
                    next_chunk = chunk + char
                    if chunk and draw.textlength(next_chunk, font=font) > max_width:
                        wrapped.append(chunk)
                        chunk = char
                    else:
                        chunk = next_chunk
                current = chunk
        if current:
            wrapped.append(current)
    return wrapped


def _try_libreoffice_docx_to_pdf(data: bytes) -> bytes | None:
    soffice = shutil.which("soffice")
    if not soffice:
        return None
    temp_root = Path(tempfile.gettempdir())
    try:
        usage = shutil.disk_usage(temp_root)
    except OSError:
        return None
    if usage.free < _MIN_FREE_TEMP_BYTES:
        return None

    work_dir = Path(tempfile.mkdtemp(prefix="viread_docx_"))
    try:
        input_path = work_dir / "source.docx"
        input_path.write_bytes(data)
        lo_profile_dir = work_dir / "lo_profile"
        lo_profile_dir.mkdir(parents=True, exist_ok=True)
        lo_profile_uri = lo_profile_dir.resolve().as_uri()
        proc = subprocess.run(
            [
                soffice,
                f"-env:UserInstallation={lo_profile_uri}",
                "--headless",
                "--nologo",
                "--nofirststartwizard",
                "--norestore",
                "--convert-to",
                "pdf",
                "--outdir",
                str(work_dir),
                str(input_path),
            ],
            capture_output=True,
            timeout=30,
            check=False,
        )
        pdf_path = work_dir / "source.pdf"
        if proc.returncode == 0 and pdf_path.is_file():
            return pdf_path.read_bytes()
    except (OSError, subprocess.SubprocessError) as exc:
        logger.warning("LibreOffice headless DOCX conversion fallback triggered: %s", exc)
    finally:
        shutil.rmtree(work_dir, ignore_errors=True)
    return None


def _iter_docx_pages(source: bytes | BinaryIO) -> Iterator[RasterizedDocumentPage]:
    """Stream DOCX rendering holding at most ONE uncompressed A4 canvas in RAM at a time."""
    if isinstance(source, (bytes, bytearray)):
        converted_pdf = _try_libreoffice_docx_to_pdf(bytes(source))
        if converted_pdf is not None:
            yield from _iter_pdf_pages(converted_pdf)
            return
        doc_stream: BinaryIO = BytesIO(source)
    else:
        source.seek(0)
        doc_stream = source

    import docx  # type: ignore[import-not-found]
    from docx.oxml.ns import qn  # type: ignore[import-not-found]
    from docx.table import Table  # type: ignore[import-not-found]
    from docx.text.paragraph import Paragraph  # type: ignore[import-not-found]

    regular_path, bold_path = _find_unicode_font_paths()
    fonts = {
        "h1": ImageFont.truetype(bold_path, 44),
        "h2": ImageFont.truetype(bold_path, 38),
        "h3": ImageFont.truetype(bold_path, 34),
        "body": ImageFont.truetype(regular_path, 30),
        "table": ImageFont.truetype(regular_path, 26),
    }

    try:
        doc = docx.Document(doc_stream)
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(
            status_code=422,
            detail="The uploaded document is empty or corrupted",
        ) from exc

    content_width = _A4_WIDTH - (2 * _MARGIN_X)
    max_y = _A4_HEIGHT - _MARGIN_Y

    allocated_count = 0
    emitted_count = 0
    has_any_content = False
    current_has_content = False
    current_img: Image.Image | None = None

    def allocate_page() -> tuple[Image.Image, ImageDraw.ImageDraw]:
        nonlocal allocated_count, current_has_content
        if allocated_count >= MAX_DOCUMENT_PAGES:
            raise HTTPException(
                status_code=422,
                detail="Document exceeds the 30-page limit per upload",
            )
        allocated_count += 1
        current_has_content = False
        img = Image.new("RGB", (_A4_WIDTH, _A4_HEIGHT), (255, 255, 255))
        return img, ImageDraw.Draw(img)

    def flush_current_page() -> RasterizedDocumentPage | None:
        nonlocal current_img, emitted_count, current_has_content
        if current_img is None:
            return None
        img = current_img
        used = current_has_content
        current_img = None
        current_has_content = False
        try:
            if not used:
                return None
            out_bytes, ctype, ext, w, h = _normalize_pil_frame(img)
            emitted_count += 1
            return RasterizedDocumentPage(
                source_page=emitted_count,
                image_bytes=out_bytes,
                content_type=ctype,
                extension=ext,
                width=w,
                height=h,
            )
        finally:
            img.close()
            gc.collect()

    current_img, draw = allocate_page()
    cursor_y = _MARGIN_Y

    def advance_page() -> RasterizedDocumentPage | None:
        nonlocal current_img, draw, cursor_y
        finished = flush_current_page()
        current_img, draw = allocate_page()
        cursor_y = _MARGIN_Y
        return finished

    def mark_drawn() -> None:
        nonlocal has_any_content, current_has_content
        has_any_content = True
        current_has_content = True

    def extract_embedded_images(paragraph_el: object) -> list[bytes]:
        blobs: list[bytes] = []
        for blip in paragraph_el.iter():  # type: ignore[attr-defined]
            if blip.tag.endswith("}blip"):
                r_id = blip.get(qn("r:embed"))
                if r_id and r_id in doc.part.related_parts:
                    part = doc.part.related_parts[r_id]
                    blob = getattr(part, "blob", None)
                    if isinstance(blob, (bytes, bytearray)) and blob:
                        blobs.append(bytes(blob))
        return blobs

    def has_explicit_page_break(paragraph: Paragraph) -> bool:
        if paragraph.paragraph_format.page_break_before:
            return True
        for br in paragraph._element.iter():
            if br.tag.endswith("}br") and br.get(qn("w:type")) == "page":
                return True
        return False

    try:
        for child in doc.element.body.iterchildren():
            if child.tag.endswith("}p"):
                para = Paragraph(child, doc)
                if has_explicit_page_break(para) and current_has_content:
                    finished = advance_page()
                    if finished is not None:
                        yield finished

                style_name = (para.style.name if para.style and para.style.name else "").lower()
                if "title" in style_name or "heading 1" in style_name:
                    font = fonts["h1"]
                    line_height = 66
                    para_gap = 22
                elif "heading 2" in style_name:
                    font = fonts["h2"]
                    line_height = 58
                    para_gap = 18
                elif "heading" in style_name:
                    font = fonts["h3"]
                    line_height = 52
                    para_gap = 16
                else:
                    font = fonts["body"]
                    line_height = 48
                    para_gap = 14

                text_value = unicodedata.normalize("NFC", para.text or "").strip()
                if text_value:
                    lines = _wrap_text(draw, text_value, font, content_width)
                    for line in lines:
                        if cursor_y + line_height > max_y:
                            finished = advance_page()
                            if finished is not None:
                                yield finished
                        draw.text((_MARGIN_X, cursor_y), line, fill=(20, 20, 20), font=font)
                        cursor_y += line_height
                        mark_drawn()
                    cursor_y += para_gap

                for blob in extract_embedded_images(child):
                    try:
                        with Image.open(BytesIO(blob)) as raw_embedded:
                            _assert_pil_image_within_pixel_budget(raw_embedded)
                            embedded_rgb = _flatten_to_rgb(raw_embedded)
                    except (UnidentifiedImageError, OSError, ValueError, Image.DecompressionBombError):
                        continue
                    max_img_h = max(300, max_y - _MARGIN_Y)
                    scale = min(
                        1.0,
                        content_width / float(max(embedded_rgb.width, 1)),
                        max_img_h / float(max(embedded_rgb.height, 1)),
                    )
                    target_w = max(1, int(round(embedded_rgb.width * scale)))
                    target_h = max(1, int(round(embedded_rgb.height * scale)))
                    if (target_w, target_h) != embedded_rgb.size:
                        resized = embedded_rgb.resize(
                            (target_w, target_h), Image.Resampling.LANCZOS
                        )
                        embedded_rgb.close()
                        embedded_rgb = resized
                    if cursor_y + target_h > max_y and current_has_content:
                        finished = advance_page()
                        if finished is not None:
                            yield finished
                    assert current_img is not None
                    current_img.paste(embedded_rgb, (_MARGIN_X, cursor_y))
                    embedded_rgb.close()
                    cursor_y += target_h + 24
                    mark_drawn()

            elif child.tag.endswith("}tbl"):
                table = Table(child, doc)
                num_cols = max((len(row.cells) for row in table.rows), default=0)
                if num_cols <= 0:
                    continue
                col_w = content_width // num_cols
                cell_pad_x = 14
                cell_pad_y = 10
                row_line_h = 40
                font = fonts["table"]

                for row in table.rows:
                    cell_lines: list[list[str]] = []
                    for col_idx in range(num_cols):
                        cell_text = row.cells[col_idx].text if col_idx < len(row.cells) else ""
                        lines = _wrap_text(
                            draw,
                            cell_text,
                            font,
                            max(40, col_w - 2 * cell_pad_x),
                        )
                        cell_lines.append(lines)
                    max_lines = max((len(lines) for lines in cell_lines), default=0)
                    max_lines = max(max_lines, 1)
                    row_h = (max_lines * row_line_h) + (2 * cell_pad_y)
                    if cursor_y + row_h > max_y and current_has_content:
                        finished = advance_page()
                        if finished is not None:
                            yield finished
                    for col_idx, lines in enumerate(cell_lines):
                        x0 = _MARGIN_X + col_idx * col_w
                        x1 = x0 + col_w
                        y0 = cursor_y
                        y1 = cursor_y + row_h
                        draw.rectangle(
                            [x0, y0, x1, y1],
                            outline=(190, 190, 190),
                            width=2,
                        )
                        text_y = y0 + cell_pad_y
                        for line in lines:
                            if text_y + row_line_h <= max_y:
                                draw.text(
                                    (x0 + cell_pad_x, text_y),
                                    line,
                                    fill=(20, 20, 20),
                                    font=font,
                                )
                            text_y += row_line_h
                    cursor_y += row_h
                    mark_drawn()
                cursor_y += 20

        if not has_any_content:
            raise HTTPException(
                status_code=422,
                detail="No usable text was detected in the uploaded document",
            )

        last_page = flush_current_page()
        if last_page is not None:
            yield last_page
    finally:
        if current_img is not None:
            current_img.close()


def _rasterize_docx_bytes(data: bytes) -> list[RasterizedDocumentPage]:
    return list(_iter_docx_pages(data))


def _validate_document_header(
    *,
    filename: str | None,
    content_type: str | None,
    byte_length: int,
    header_bytes: bytes,
) -> tuple[str, SourceDocumentFormat]:
    if not filename or not str(filename).strip():
        raise HTTPException(status_code=422, detail="A file is required")

    clean_name = PurePath(str(filename)).name
    suffix = PurePath(clean_name).suffix.lower()

    if byte_length <= 0:
        raise HTTPException(
            status_code=422,
            detail="The uploaded document is empty or corrupted",
        )
    if byte_length > MAX_DOCUMENT_BYTES:
        raise HTTPException(status_code=413, detail="Document exceeds the 50 MB limit")

    if suffix == ".docm":
        raise HTTPException(
            status_code=415,
            detail="Macro-enabled Word documents are not permitted",
        )

    if header_bytes.startswith(OLE2_MAGIC):
        if suffix == ".doc":
            raise HTTPException(
                status_code=415,
                detail="Legacy .doc files are not supported; convert to .docx or .pdf",
            )
        if (
            suffix == ".docx"
            or b"EncryptedPackage" in header_bytes[:8192]
            or "EncryptedPackage".encode("utf-16-le") in header_bytes[:8192]
        ):
            raise HTTPException(
                status_code=422,
                detail="Password-protected documents are not supported",
            )
        raise HTTPException(
            status_code=415,
            detail="Unsupported upload format; use JPEG, PNG, WebP, BMP, TIFF, PDF, or DOCX",
        )

    if suffix not in SUPPORTED_EXTENSIONS:
        raise HTTPException(
            status_code=415,
            detail="Unsupported upload format; use JPEG, PNG, WebP, BMP, TIFF, PDF, or DOCX",
        )

    detected = _detect_format_by_magic(header_bytes)
    if detected is None or suffix not in _FORMAT_EXTENSIONS[detected]:
        raise HTTPException(
            status_code=415,
            detail="File content does not match the declared file type or extension",
        )

    declared_type = (content_type or "").split(";", 1)[0].strip().lower()
    if declared_type not in _GENERIC_MIMES and declared_type not in _FORMAT_MIMES[detected]:
        raise HTTPException(
            status_code=415,
            detail="File content does not match the declared file type or extension",
        )

    if detected in ("JPEG", "PNG", "WEBP", "BMP") and byte_length > MAX_SINGLE_IMAGE_BYTES:
        raise HTTPException(status_code=413, detail="Image exceeds the 12 MB limit")

    return clean_name, detected


@contextmanager
def iter_rasterized_spooled_document(
    spooled: SpooledUploadDocument,
) -> Iterator[tuple[str, SourceDocumentFormat, str, Iterator[RasterizedDocumentPage]]]:
    """Validate and stream 1..30 rasterized pages one at a time from a SpooledUploadDocument."""
    clean_name, detected = _validate_document_header(
        filename=spooled.file_name,
        content_type=spooled.content_type,
        byte_length=spooled.byte_length,
        header_bytes=spooled.header_bytes,
    )
    temp_pdf_path: Path | None = None
    try:
        if detected == "DOCX":
            _validate_docx_archive(spooled.spool_file)
            page_iter = _iter_docx_pages(spooled.spool_file)
        elif detected == "PDF":
            # Write PDF to a temporary disk file so pypdfium2/pymupdf reads directly
            # from disk without keeping a 50 MB buffer in Python heap RAM.
            fd, raw_path = tempfile.mkstemp(prefix="viread_pdf_", suffix=".pdf")
            temp_pdf_path = Path(raw_path)
            spooled.spool_file.seek(0)
            with os.fdopen(fd, "wb") as out_f:
                shutil.copyfileobj(spooled.spool_file, out_f, length=_UPLOAD_SPOOL_CHUNK_BYTES)
            page_iter = _iter_pdf_pages(temp_pdf_path)
        else:
            page_iter = _iter_image_pages(spooled.spool_file, detected)

        def _bounded_iter() -> Iterator[RasterizedDocumentPage]:
            count = 0
            for page in page_iter:
                count += 1
                if count > MAX_DOCUMENT_PAGES:
                    raise HTTPException(
                        status_code=422,
                        detail="Document exceeds the 30-page limit per upload",
                    )
                yield page

        yield clean_name, detected, spooled.source_sha256, _bounded_iter()
    finally:
        if temp_pdf_path is not None:
            try:
                temp_pdf_path.unlink(missing_ok=True)
            except Exception:
                pass


def rasterize_uploaded_document(
    *,
    filename: str | None,
    content_type: str | None,
    data: bytes,
) -> RasterizedDocumentBundle:
    """Validate an uploaded image or document and rasterize it into 1..30 normalized RGB pages."""
    clean_name, detected = _validate_document_header(
        filename=filename,
        content_type=content_type,
        byte_length=len(data),
        header_bytes=data[:8192],
    )

    if detected == "DOCX":
        _validate_docx_archive(data)
        pages = _rasterize_docx_bytes(data)
    elif detected == "PDF":
        pages = _rasterize_pdf_bytes(data)
    else:
        pages = _rasterize_image_bytes(data, detected)

    if len(pages) > MAX_DOCUMENT_PAGES:
        raise HTTPException(
            status_code=422,
            detail="Document exceeds the 30-page limit per upload",
        )

    return RasterizedDocumentBundle(
        file_name=clean_name,
        source_format=detected,
        source_sha256=hashlib.sha256(data).hexdigest(),
        pages=tuple(pages),
    )
