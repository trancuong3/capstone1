from __future__ import annotations

import hashlib
import logging
import os
import shutil
import subprocess
import tempfile
import unicodedata
import zipfile
from dataclasses import dataclass
from io import BytesIO
from pathlib import Path, PurePath
from typing import Literal

from fastapi import HTTPException
from PIL import Image, ImageDraw, ImageFont, ImageOps, ImageSequence, UnidentifiedImageError

logger = logging.getLogger(__name__)

MAX_SINGLE_IMAGE_BYTES = 12 * 1024 * 1024
MAX_DOCUMENT_BYTES = 50 * 1024 * 1024
MAX_DOCUMENT_PAGES = 30
MAX_PAGE_IMAGE_DIMENSION = 6000
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


def _validate_docx_archive(data: bytes) -> None:
    try:
        with zipfile.ZipFile(BytesIO(data), "r") as zf:
            infos = zf.infolist()
            if len(infos) > MAX_DOCX_ZIP_ENTRIES:
                raise HTTPException(
                    status_code=422,
                    detail="Archive structure exceeds safe extraction limits",
                )

            total_declared_uncompressed = 0
            names_lower: set[str] = set()
            xml_entries: list[zipfile.ZipInfo] = []

            for info in infos:
                if info.flag_bits & 0x1:
                    raise HTTPException(
                        status_code=422,
                        detail="Password-protected documents are not supported",
                    )
                lower_name = info.filename.lower()
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

                if lower_name.endswith(".xml") or lower_name.endswith(".rels"):
                    xml_entries.append(info)

            if "[content_types].xml" not in names_lower or "word/document.xml" not in names_lower:
                raise HTTPException(
                    status_code=415,
                    detail="File content does not match the declared file type or extension",
                )

            total_read_bytes = 0
            for info in xml_entries:
                chunks: list[bytes] = []
                with zf.open(info, "r") as entry_stream:
                    while True:
                        chunk = entry_stream.read(65536)
                        if not chunk:
                            break
                        total_read_bytes += len(chunk)
                        if total_read_bytes > MAX_DOCX_UNCOMPRESSED_BYTES:
                            raise HTTPException(
                                status_code=422,
                                detail="Archive structure exceeds safe extraction limits",
                            )
                        chunks.append(chunk)
                xml_bytes = b"".join(chunks).lower()
                if b"<!doctype" in xml_bytes or b"<!entity" in xml_bytes:
                    raise HTTPException(
                        status_code=422,
                        detail="Document XML contains unsafe declarations",
                    )
    except HTTPException:
        raise
    except (zipfile.BadZipFile, OSError, RuntimeError) as exc:
        raise HTTPException(
            status_code=422,
            detail="The uploaded document is empty or corrupted",
        ) from exc


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


def _normalize_pil_frame(frame: Image.Image) -> tuple[bytes, str, str, int, int]:
    canvas = _flatten_to_rgb(frame)
    width, height = canvas.size
    if width <= 0 or height <= 0:
        raise HTTPException(
            status_code=422,
            detail="The uploaded document is empty or corrupted",
        )
    if max(width, height) > MAX_PAGE_IMAGE_DIMENSION:
        scale = MAX_PAGE_IMAGE_DIMENSION / float(max(width, height))
        new_w = max(1, min(MAX_PAGE_IMAGE_DIMENSION, int(round(width * scale))))
        new_h = max(1, min(MAX_PAGE_IMAGE_DIMENSION, int(round(height * scale))))
        canvas = canvas.resize((new_w, new_h), Image.Resampling.LANCZOS)
        width, height = canvas.size

    png_buffer = BytesIO()
    canvas.save(png_buffer, format="PNG", optimize=True)
    png_bytes = png_buffer.getvalue()
    if len(png_bytes) <= MAX_PAGE_IMAGE_BYTES:
        return png_bytes, "image/png", "png", width, height

    for quality in (92, 85, 75):
        jpeg_buffer = BytesIO()
        canvas.save(jpeg_buffer, format="JPEG", quality=quality, optimize=True)
        jpeg_bytes = jpeg_buffer.getvalue()
        if len(jpeg_bytes) <= MAX_PAGE_IMAGE_BYTES:
            return jpeg_bytes, "image/jpeg", "jpg", width, height

    raise HTTPException(
        status_code=413,
        detail="Image exceeds the 12 MB limit",
    )


def _rasterize_image_bytes(
    data: bytes,
    source_format: SourceDocumentFormat,
) -> list[RasterizedDocumentPage]:
    pages: list[RasterizedDocumentPage] = []
    try:
        with Image.open(BytesIO(data)) as img:
            if source_format == "TIFF":
                for index, frame in enumerate(ImageSequence.Iterator(img), start=1):
                    if index > MAX_DOCUMENT_PAGES:
                        raise HTTPException(
                            status_code=422,
                            detail="Document exceeds the 30-page limit per upload",
                        )
                    frame_copy = frame.copy()
                    try:
                        out_bytes, ctype, ext, w, h = _normalize_pil_frame(frame_copy)
                    finally:
                        frame_copy.close()
                    pages.append(
                        RasterizedDocumentPage(
                            source_page=index,
                            image_bytes=out_bytes,
                            content_type=ctype,
                            extension=ext,
                            width=w,
                            height=h,
                        )
                    )
            else:
                img.load()
                out_bytes, ctype, ext, w, h = _normalize_pil_frame(img)
                pages.append(
                    RasterizedDocumentPage(
                        source_page=1,
                        image_bytes=out_bytes,
                        content_type=ctype,
                        extension=ext,
                        width=w,
                        height=h,
                    )
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

    if not pages:
        raise HTTPException(
            status_code=422,
            detail="The uploaded document is empty or corrupted",
        )
    return pages


def _rasterize_pdf_with_pypdfium2(data: bytes) -> list[RasterizedDocumentPage]:
    import pypdfium2  # type: ignore[import-not-found]

    pdf = None
    try:
        try:
            pdf = pypdfium2.PdfDocument(data)
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

        pages: list[RasterizedDocumentPage] = []
        for idx in range(page_count):
            page = pdf[idx]
            bitmap = None
            pil_image = None
            try:
                page_w_pt, page_h_pt = page.get_size()
                max_pt = max(float(page_w_pt), float(page_h_pt), 1.0)
                scale = min(_PDF_RENDER_DPI / 72.0, MAX_PAGE_IMAGE_DIMENSION / max_pt)
                scale = max(scale, 0.25)
                bitmap = page.render(scale=scale)
                pil_image = bitmap.to_pil()
                out_bytes, ctype, ext, w, h = _normalize_pil_frame(pil_image)
                pages.append(
                    RasterizedDocumentPage(
                        source_page=idx + 1,
                        image_bytes=out_bytes,
                        content_type=ctype,
                        extension=ext,
                        width=w,
                        height=h,
                    )
                )
            finally:
                if pil_image is not None:
                    pil_image.close()
                if bitmap is not None:
                    bitmap.close()
                page.close()
        return pages
    finally:
        if pdf is not None:
            pdf.close()


def _rasterize_pdf_with_pymupdf(data: bytes) -> list[RasterizedDocumentPage]:
    import pymupdf  # type: ignore[import-not-found]

    doc = None
    try:
        try:
            doc = pymupdf.open(stream=data, filetype="pdf")
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

        pages: list[RasterizedDocumentPage] = []
        for idx in range(page_count):
            page = doc[idx]
            rect = page.rect
            max_pt = max(float(rect.width), float(rect.height), 1.0)
            scale = min(_PDF_RENDER_DPI / 72.0, MAX_PAGE_IMAGE_DIMENSION / max_pt)
            scale = max(scale, 0.25)
            pix = page.get_pixmap(matrix=pymupdf.Matrix(scale, scale), alpha=False)
            pil_image = Image.frombytes("RGB", (pix.width, pix.height), pix.samples)
            try:
                out_bytes, ctype, ext, w, h = _normalize_pil_frame(pil_image)
            finally:
                pil_image.close()
            pages.append(
                RasterizedDocumentPage(
                    source_page=idx + 1,
                    image_bytes=out_bytes,
                    content_type=ctype,
                    extension=ext,
                    width=w,
                    height=h,
                )
            )
        return pages
    finally:
        if doc is not None:
            doc.close()


def _rasterize_pdf_bytes(data: bytes) -> list[RasterizedDocumentPage]:
    try:
        import pypdfium2  # noqa: F401
    except ImportError:
        pypdfium2_available = False
    else:
        pypdfium2_available = True

    if pypdfium2_available:
        return _rasterize_pdf_with_pypdfium2(data)

    try:
        import pymupdf  # noqa: F401
    except ImportError:
        pymupdf_available = False
    else:
        pymupdf_available = True

    if pymupdf_available:
        return _rasterize_pdf_with_pymupdf(data)

    raise HTTPException(
        status_code=503,
        detail="PDF rendering engine is not available on the server",
    )


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
        proc = subprocess.run(
            [
                soffice,
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


def _rasterize_docx_bytes(data: bytes) -> list[RasterizedDocumentPage]:
    converted_pdf = _try_libreoffice_docx_to_pdf(data)
    if converted_pdf is not None:
        return _rasterize_pdf_bytes(converted_pdf)

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
        doc = docx.Document(BytesIO(data))
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(
            status_code=422,
            detail="The uploaded document is empty or corrupted",
        ) from exc

    content_width = _A4_WIDTH - (2 * _MARGIN_X)
    max_y = _A4_HEIGHT - _MARGIN_Y

    canvas_pages: list[Image.Image] = []
    page_has_content: list[bool] = []
    has_any_content = False

    def allocate_page() -> tuple[Image.Image, ImageDraw.ImageDraw]:
        if len(canvas_pages) >= MAX_DOCUMENT_PAGES:
            raise HTTPException(
                status_code=422,
                detail="Document exceeds the 30-page limit per upload",
            )
        img = Image.new("RGB", (_A4_WIDTH, _A4_HEIGHT), (255, 255, 255))
        canvas_pages.append(img)
        page_has_content.append(False)
        return img, ImageDraw.Draw(img)

    current_img, draw = allocate_page()
    cursor_y = _MARGIN_Y

    def advance_page() -> None:
        nonlocal current_img, draw, cursor_y
        current_img, draw = allocate_page()
        cursor_y = _MARGIN_Y

    def mark_drawn() -> None:
        nonlocal has_any_content
        has_any_content = True
        page_has_content[-1] = True

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
                if has_explicit_page_break(para) and page_has_content[-1]:
                    advance_page()

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
                            advance_page()
                        draw.text((_MARGIN_X, cursor_y), line, fill=(20, 20, 20), font=font)
                        cursor_y += line_height
                        mark_drawn()
                    cursor_y += para_gap

                for blob in extract_embedded_images(child):
                    try:
                        with Image.open(BytesIO(blob)) as raw_embedded:
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
                        embedded_rgb = embedded_rgb.resize(
                            (target_w, target_h), Image.Resampling.LANCZOS
                        )
                    if cursor_y + target_h > max_y and page_has_content[-1]:
                        advance_page()
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
                    if cursor_y + row_h > max_y and page_has_content[-1]:
                        advance_page()
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

        rendered_pages: list[RasterizedDocumentPage] = []
        for idx, (img, used) in enumerate(zip(canvas_pages, page_has_content, strict=True)):
            if not used:
                continue
            out_bytes, ctype, ext, w, h = _normalize_pil_frame(img)
            rendered_pages.append(
                RasterizedDocumentPage(
                    source_page=len(rendered_pages) + 1,
                    image_bytes=out_bytes,
                    content_type=ctype,
                    extension=ext,
                    width=w,
                    height=h,
                )
            )
        return rendered_pages
    finally:
        for img in canvas_pages:
            img.close()


def rasterize_uploaded_document(
    *,
    filename: str | None,
    content_type: str | None,
    data: bytes,
) -> RasterizedDocumentBundle:
    """Validate an uploaded image or document and rasterize it into 1..30 normalized RGB pages."""
    if not filename or not str(filename).strip():
        raise HTTPException(status_code=422, detail="A file is required")

    clean_name = PurePath(str(filename)).name
    suffix = PurePath(clean_name).suffix.lower()

    if not data:
        raise HTTPException(
            status_code=422,
            detail="The uploaded document is empty or corrupted",
        )
    if len(data) > MAX_DOCUMENT_BYTES:
        raise HTTPException(status_code=413, detail="Document exceeds the 50 MB limit")

    if suffix == ".docm":
        raise HTTPException(
            status_code=415,
            detail="Macro-enabled Word documents are not permitted",
        )

    if data.startswith(OLE2_MAGIC):
        if suffix == ".doc":
            raise HTTPException(
                status_code=415,
                detail="Legacy .doc files are not supported; convert to .docx or .pdf",
            )
        if (
            suffix == ".docx"
            or b"EncryptedPackage" in data[:8192]
            or "EncryptedPackage".encode("utf-16-le") in data[:8192]
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

    detected = _detect_format_by_magic(data)
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

    if detected in ("JPEG", "PNG", "WEBP", "BMP") and len(data) > MAX_SINGLE_IMAGE_BYTES:
        raise HTTPException(status_code=413, detail="Image exceeds the 12 MB limit")

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
