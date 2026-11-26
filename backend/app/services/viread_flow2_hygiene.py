"""Canonical Flow 2 OCR training data hygiene & anti-dirty-label validator.

Zero heavy ML imports (no torch/paddle/vietocr/pytesseract) so this module is safe
to import in Render Free 512 MiB web processes, outbox workers, and CLI tools.
"""
from __future__ import annotations

from io import BytesIO
import math
import re
from statistics import median
from typing import Any, Literal
import unicodedata

import numpy as np
from PIL import Image, ImageOps, ImageStat

# Exact 229-character VietOCR vgg_transformer locked vocabulary
# (SHA-256 of canonical JSON string == ORIGINAL_VOCAB_SHA256).
LOCKED_VIETOCR_VOCAB = (
    "aAàÀảẢãÃáÁạẠăĂằẰẳẲẵẴắẮặẶâÂầẦẩẨẫẪấẤậẬ"
    "bBcCdDđĐ"
    "eEèÈẻẺẽẼéÉẹẸêÊềỀểỂễỄếẾệỆ"
    "fFgGhH"
    "iIìÌỉỈĩĨíÍịỊ"
    "jJkKlLmMnN"
    "oOòÒỏỎõÕóÓọỌôÔồỒổỔỗỖốỐộỘơƠờỜởỞỡỠớỚợỢ"
    "pPqQrRsStT"
    "uUùÙủỦũŨúÚụỤưƯừỪửỬữỮứỨựỰ"
    "vVwWxX"
    "yYỳỲỷỶỹỸýÝỵỴzZ"
    "0123456789!\"#$%&'()*+,-./:;<=>?@[\\]^_`{|}~ "
)
LOCKED_VIETOCR_VOCAB_SET: frozenset[str] = frozenset(LOCKED_VIETOCR_VOCAB)
LOCKED_VIETOCR_VOCAB_SHA256 = (
    "b4ec9437ef82d952a65c101ea7ec6748a7168777c2d84cdb6a1bba7540bd163d"
)

# Exact 15 typographic punctuation mappings aligned with ai/vietocr_v2/train.py.
TYPOGRAPHIC_PUNCT_MAP = str.maketrans({
    "\u2018": "'",
    "\u2019": "'",
    "\u201a": "'",
    "\u201b": "'",
    "\u201c": '"',
    "\u201d": '"',
    "\u201e": '"',
    "\u201f": '"',
    "\u2010": "-",
    "\u2011": "-",
    "\u2012": "-",
    "\u2013": "-",
    "\u2014": "-",
    "\u2026": "...",
    "\u00a0": " ",
})

MIN_LINE_WIDTH_PX = 24
MIN_LINE_HEIGHT_PX = 12
MAX_LINE_HEIGHT_PX = 256
MAX_PAGE_HEIGHT_FRACTION = 0.25
MIN_LINE_ASPECT_RATIO = 0.5
MAX_LINE_ASPECT_RATIO = 30.0
MIN_LINE_STDDEV = 8.0
MIN_LINE_EDGE_VARIANCE = 15.0
MIN_PX_PER_CHAR = 3.0
MAX_PX_PER_CHAR = 120.0
DEFAULT_MAX_LABEL_LENGTH = 180

_GARBAGE_REPEAT_RE = re.compile(r"(?:\|{3,}|_{3,}|={3,}|~{3,})")

_EMAIL_RE = re.compile(r"[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}")
_VN_PHONE_RE = re.compile(
    r"(?<!\d)(?:\+84|84|0)(?:[\s.\-]?[35789])(?:[\s.\-]?\d){8}(?!\d)"
)
_LONG_ID_RE = re.compile(r"(?<!\d)\d{9,14}(?!\d)")
_STANDALONE_CCCD_RE = re.compile(r"(?<!\d)\d{9,12}(?!\d)")
_ID_KEYWORD_RE = re.compile(
    r"\b(?:cccd|cmnd|căn cước|số tài khoản|stk|tài khoản|sđt|điện thoại|hotline|zalo)\b",
    re.IGNORECASE,
)
_URL_RE = re.compile(
    r"(?:https?://\S+|www\.\S+|\b(?:facebook\.com|fb\.com|zalo\.me|tiktok\.com|instagram\.com)/\S*)",
    re.IGNORECASE,
)
_SOCIAL_HANDLE_RE = re.compile(r"(?<![a-zA-Z0-9._%+-])@[a-zA-Z0-9_]{3,30}\b")
_ADDRESS_RE = re.compile(
    r"\b(?:địa chỉ|số nhà|ngõ\s+\d+|hẻm\s+\d+|tổ dân phố|phường\s+\S+|quận\s+\S+|thôn\s+\S+)\b",
    re.IGNORECASE,
)
_EXPLICIT_ADDRESS_PREFIX_RE = re.compile(
    r"\b(?:địa chỉ|số nhà|tổ dân phố)\s*[:\-]?\s*\S+",
    re.IGNORECASE,
)
_WORKSHEET_NAME_RE = re.compile(
    r"\b(?:họ và tên|họ tên học sinh|họ tên bé|tên học sinh|tên bé|trường tiểu học|ngày sinh|sinh ngày)\s*[:\-]?\s*\S+",
    re.IGNORECASE,
)
_CLASS_MARKER_RE = re.compile(r"\blớp\s*[:\-]?\s*\d{1,2}[a-zA-Z]\d?\b", re.IGNORECASE)

_FORBIDDEN_BBOX_SOURCES = frozenset({"synthetic_grid", "admin_placeholder"})


def strip_invisible_format_chars(text: str) -> str:
    """Remove Unicode category Cf format characters (ZWSP, BOM, soft hyphen, etc.)."""
    return "".join(ch for ch in text if unicodedata.category(ch) != "Cf")


def normalize_typographic_for_vietocr(text: str) -> str:
    """Apply NFC, strip invisible Cf chars, and map typographic punctuation to locked vocab."""
    nfc = unicodedata.normalize("NFC", str(text or ""))
    no_cf = strip_invisible_format_chars(nfc)
    mapped = no_cf.translate(TYPOGRAPHIC_PUNCT_MAP)
    return unicodedata.normalize("NFC", " ".join(mapped.split()))


def sanitize_and_validate_vietocr_label(
    raw_label: Any,
    *,
    max_length: int = DEFAULT_MAX_LABEL_LENGTH,
) -> tuple[str | None, str | None]:
    """Validate and normalize a Vietnamese OCR line label against VietOCR's locked 229-char vocab."""
    if not isinstance(raw_label, str):
        return None, "LABEL_NOT_TEXT"
    nfc = unicodedata.normalize("NFC", raw_label)
    if any((ord(ch) < 32 and ch not in {"\t", " "}) or ord(ch) == 127 for ch in nfc):
        return None, "FORBIDDEN_CONTROL_CHARS"
    no_cf = strip_invisible_format_chars(nfc)
    mapped = no_cf.translate(TYPOGRAPHIC_PUNCT_MAP)
    cleaned = unicodedata.normalize("NFC", " ".join(mapped.split()))
    if not cleaned:
        return None, "EMPTY_LABEL"
    if len(cleaned) > max_length:
        return None, "LABEL_TOO_LONG"
    if _GARBAGE_REPEAT_RE.search(cleaned):
        return None, "OCR_GARBAGE_PATTERN"
    if len(cleaned) >= 2 and not any(ch.isalnum() for ch in cleaned):
        return None, "NON_ALPHANUMERIC_GARBAGE"
    if any(ch not in LOCKED_VIETOCR_VOCAB_SET for ch in cleaned):
        return None, "UNSUPPORTED_VIETOCR_VOCAB_CHAR"
    return cleaned, None


def open_image_exif_safe(raw_bytes: bytes) -> Image.Image:
    """Open image bytes with EXIF orientation transposed consistently into RGB."""
    with Image.open(BytesIO(raw_bytes)) as source:
        source.load()
        transposed = ImageOps.exif_transpose(source)
        return transposed.convert("RGB")


def compute_line_crop_box(
    bounds: list[tuple[float, float, float, float]],
    *,
    page_width: int,
    page_height: int,
) -> tuple[int, int, int, int]:
    """Compute padded pixel crop box (left, top, right, bottom) preserving Vietnamese diacritics."""
    left = min(item[0] for item in bounds)
    top = min(item[1] for item in bounds)
    right = max(item[2] for item in bounds)
    bottom = max(item[3] for item in bounds)
    line_height = max(1.0, bottom - top)
    pad_y = max(2, round(line_height * 0.12))
    pad_x = max(2, round(line_height * 0.08))
    return (
        max(0, math.floor(left - pad_x)),
        max(0, math.floor(top - pad_y)),
        min(page_width, math.ceil(right + pad_x)),
        min(page_height, math.ceil(bottom + pad_y)),
    )


def _extract_normalized_box(word: dict[str, Any]) -> tuple[float, float, float, float] | None:
    box = word.get("boundingbox")
    if box is None:
        box = word.get("bounding_box")
    if box is None:
        box = word.get("bbox")
    if not isinstance(box, (list, tuple)) or len(box) != 4:
        return None
    try:
        x, y, w, h = (float(v) for v in box)
    except (TypeError, ValueError):
        return None
    if (
        not all(math.isfinite(v) for v in (x, y, w, h))
        or x < 0.0
        or y < 0.0
        or w <= 0.0
        or h <= 0.0
        or x + w > 1.001
        or y + h > 1.001
    ):
        return None
    return (x, y, w, h)


def validate_line_word_geometry(
    words: list[dict[str, Any]],
) -> tuple[bool, str | None]:
    """Reject synthetic grids, admin placeholder boxes, unusable OCR crops, and multi-line unions."""
    if not words:
        return False, "EMPTY_LINE_WORDS"

    boxes: list[tuple[float, float, float, float]] = []
    for word in words:
        source = str(word.get("bbox_source") or "").strip().lower()
        if source in _FORBIDDEN_BBOX_SOURCES:
            return False, "SYNTHETIC_OR_PLACEHOLDER_BBOX"

        evidence = word.get("ocr_evidence")
        if not isinstance(evidence, dict):
            evidence = word.get("word_evidence") if isinstance(word.get("word_evidence"), dict) else {}
        bbox_quality = str(word.get("bbox_quality") or evidence.get("bbox_quality") or "").strip().lower()
        crop_quality = str(word.get("crop_quality") or evidence.get("crop_quality") or "").strip().lower()
        if bbox_quality == "rejected" or crop_quality == "unusable":
            return False, "REJECTED_OCR_BBOX_QUALITY"

        parsed = _extract_normalized_box(word)
        if parsed is None:
            return False, "INVALID_WORD_BBOX"
        boxes.append(parsed)

    heights = [b[3] for b in boxes]
    ys = [b[1] for b in boxes]
    median_h = float(median(heights))
    median_y = float(median(ys))

    if len(boxes) >= 2:
        for x, y, w, h in boxes:
            is_admin_placeholder = (
                abs(x - 0.1) < 1e-4
                and abs(y - 0.1) < 1e-4
                and abs(w - 0.1) < 1e-4
                and abs(h - 0.05) < 1e-4
            )
            if is_admin_placeholder and abs(y - median_y) > max(1.5 * median_h, 0.08):
                return False, "ADMIN_PLACEHOLDER_BBOX_DISPLACED"

    min_top = min(b[1] for b in boxes)
    max_bottom = max(b[1] + b[3] for b in boxes)
    vertical_span = max_bottom - min_top
    if vertical_span > max(2.4 * median_h, 0.14):
        return False, "MULTILINE_VERTICAL_SPREAD"

    return True, None


def validate_flow2_line_crop(
    image_rgb: Image.Image,
    label: str | None = None,
    *,
    page_height: int | None = None,
) -> tuple[bool, dict[str, Any], str | None]:
    """Validate line crop geometry, contrast, sharpness, and label-vs-width plausibility."""
    width, height = image_rgb.size
    aspect_ratio = round(width / height, 3) if height > 0 else 0.0
    gray = image_rgb.convert("L")
    stat = ImageStat.Stat(gray)
    stddev = round(float(stat.stddev[0]) if stat.stddev else 0.0, 3)

    arr = np.asarray(gray, dtype=np.float32)
    if arr.shape[0] >= 3 and arr.shape[1] >= 3:
        lap = (
            arr[:-2, 1:-1]
            + arr[2:, 1:-1]
            + arr[1:-1, :-2]
            + arr[1:-1, 2:]
            - 4.0 * arr[1:-1, 1:-1]
        )
        edge_variance = round(float(np.var(lap)), 3)
    else:
        edge_variance = 0.0

    px_per_char = (
        round(width / max(len(label), 1), 3)
        if isinstance(label, str) and label
        else None
    )

    metrics: dict[str, Any] = {
        "width": width,
        "height": height,
        "aspect_ratio": aspect_ratio,
        "stddev": stddev,
        "edge_variance": edge_variance,
    }
    if px_per_char is not None:
        metrics["px_per_char"] = px_per_char

    if width < MIN_LINE_WIDTH_PX or height < MIN_LINE_HEIGHT_PX:
        return False, metrics, "IMAGE_TOO_SMALL"
    if height > MAX_LINE_HEIGHT_PX:
        return False, metrics, "IMAGE_TOO_TALL_MULTILINE"
    if (
        page_height is not None
        and page_height > 0
        and (height / float(page_height)) > MAX_PAGE_HEIGHT_FRACTION
    ):
        return False, metrics, "IMAGE_TOO_TALL_FOR_PAGE"
    if aspect_ratio < MIN_LINE_ASPECT_RATIO:
        return False, metrics, "INVALID_ASPECT_RATIO"
    if aspect_ratio > MAX_LINE_ASPECT_RATIO:
        return False, metrics, "INVALID_ASPECT_RATIO_TOO_WIDE"
    if stddev < MIN_LINE_STDDEV:
        return False, metrics, "LOW_CONTRAST_OR_BLANK"
    if edge_variance < MIN_LINE_EDGE_VARIANCE:
        return False, metrics, "BLURRY_OR_LOW_EDGE_DETAIL"
    if isinstance(label, str) and len(label) >= 4 and px_per_char is not None:
        if px_per_char < MIN_PX_PER_CHAR:
            return False, metrics, "LABEL_TOO_DENSE_FOR_CROP_WIDTH"
        if px_per_char > MAX_PX_PER_CHAR:
            return False, metrics, "LABEL_TOO_SPARSE_FOR_CROP_WIDTH"
    return True, metrics, None


def detect_vietnamese_pii_strict(
    label_text: str,
    *,
    mode: Literal["strict", "contact_only"] = "strict",
) -> list[str]:
    """Deterministic Vietnamese PII detector."""
    normalized = unicodedata.normalize("NFC", strip_invisible_format_chars(str(label_text or "")))
    flags: list[str] = []
    if _EMAIL_RE.search(normalized):
        flags.append("EMAIL")
    if _VN_PHONE_RE.search(normalized):
        flags.append("PHONE_NUMBER")
    if (
        (_ID_KEYWORD_RE.search(normalized) and _LONG_ID_RE.search(normalized))
        or _STANDALONE_CCCD_RE.search(normalized)
    ):
        flags.append("ACCOUNT_OR_ID_NUMBER")
    if _URL_RE.search(normalized):
        flags.append("URL_OR_SOCIAL_LINK")
    if mode == "strict":
        if (
            (_ADDRESS_RE.search(normalized) and re.search(r"\d", normalized))
            or _EXPLICIT_ADDRESS_PREFIX_RE.search(normalized)
        ):
            flags.append("PERSONAL_ADDRESS")
        if _WORKSHEET_NAME_RE.search(normalized) or _CLASS_MARKER_RE.search(normalized):
            flags.append("CHILD_WORKSHEET_PERSONAL_INFO")
        if _SOCIAL_HANDLE_RE.search(normalized):
            flags.append("SOCIAL_HANDLE")
    return flags
