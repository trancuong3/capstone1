"""OpenCV clean text-free illustration extraction, CLAHE restoration & mandatory text-free gate (0 VND, Render Free 512 MiB safe)."""
from __future__ import annotations

import asyncio
import hashlib
import importlib.util
import ipaddress
import logging
import os
from pathlib import Path
import re
import shutil
import socket
import unicodedata
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from io import BytesIO
from typing import Any, Callable
from urllib.parse import urlsplit
from uuid import UUID, uuid4

import cv2
import httpx
import numpy as np
from fastapi import HTTPException, status
from PIL import Image, ImageOps, UnidentifiedImageError
from sqlalchemy import select
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.ext.asyncio import AsyncSession

from app.database.config import SUPABASE_PRIVATE_BOOKS_BUCKET, SUPABASE_STORAGE_BUCKET
from app.models import Book, BookPage, SmartStudioJob
from app.policies.book_access import is_book_private
from app.repositories.book_assets_repository import BookAssetsRepository
from app.schemas.book_assets import (
    BookPresentationAssetRead,
    PageIllustrationExtractRequest,
    PageIllustrationExtractResponse,
    PageIllustrationGenerateRequest,
    PageIllustrationGenerateResponse,
    PageIllustrationModerationRequest,
    ReadingDisplayMode,
)
from app.services.ai_capability_router import AiCapabilityRouter
from app.services.book_cover_service import (
    BookCoverService,
    ImageGenerateTransport,
    MAX_COVER_PIXELS,
    _DEFAULT_NEGATIVE_PROMPT,
    _encode_optimized_webp,
    _sanitize_child_safe_prompt_hint,
    _validate_relative_storage_path,
    asset_to_dto,
    detect_image_generation_provider,
    detect_magic_image_format,
    generate_image_via_router_and_scheduler,
)
from app.services.book_style_bible import BookStyleBibleService
from app.services.gpu_workload_scheduler import (
    GpuWorkloadScheduler,
    WorkloadPriority,
    get_default_gpu_scheduler,
)
from app.services.ocr_ai.config import OcrCorrectionConfig
from app.services.storage_service import delete_object, download_object, upload_object

logger = logging.getLogger(__name__)

HTTP_422 = getattr(status, "HTTP_422_UNPROCESSABLE_CONTENT", 422)

MAX_ANALYSIS_EDGE = 1024
MAX_ILLUSTRATION_EDGE = 1280
MAX_ILLUSTRATION_WEBP_BYTES = 350 * 1024  # 350 KB
TEXT_DENSITY_REJECT_THRESHOLD = 0.08
OCR_OVERLAP_REJECT_THRESHOLD = 0.15
BBOX_OVERLAP_REJECT_THRESHOLD = 0.05

_WORD_TOKEN_RE = re.compile(r"[0-9A-Za-zÀ-ỹ]{2,}", re.UNICODE)

OcrCheckFn = Callable[[bytes], str]


def _is_remote_worker_ocr_mode() -> bool:
    """Return True when local OCR inference is disabled (Render Free 512 MiB / remote_worker)."""
    if (os.getenv("VIREAD_OCR_WORKER_PROCESS") or "").strip().lower() in {
        "1",
        "true",
        "yes",
        "on",
    }:
        return False
    raw_mode = (os.getenv("VIREAD_OCR_MODE") or "").strip().lower()
    if raw_mode == "remote_worker":
        return True
    if raw_mode == "local_inprocess":
        return False
    return (
        (os.getenv("RENDER") or "").strip().lower() in {"1", "true", "yes", "on"}
        or (os.getenv("VIREAD_WEB_DISABLE_HEAVY_WORKERS") or "").strip().lower()
        in {"1", "true", "yes", "on"}
    )


def _resolve_tesseract_binary() -> str | None:
    explicit = (os.getenv("TESSERACT_CMD") or "").strip()
    if explicit and os.path.isfile(explicit):
        return explicit
    from_path = shutil.which("tesseract")
    if from_path:
        return from_path
    for candidate in (
        r"C:\Program Files\Tesseract-OCR\tesseract.exe",
        r"C:\Program Files (x86)\Tesseract-OCR\tesseract.exe",
    ):
        if os.path.isfile(candidate):
            return candidate
    return None


def _build_default_ocr_check_fn() -> OcrCheckFn | None:
    """Lazily construct a real local OCR text-free checker when local runtime is available.

    - In `remote_worker` / Render 512 MiB mode: returns `None` (zero ML imports) so the gate
      honestly labels assets `ocr_gate_mode="opencv_only_remote_worker"` instead of silently
      faking `ocr_overlap_score == 0.0` as verified OCR.
    - In local mode with `VIREAD_OCR_TEXT_FREE_ENGINE=hybrid` and PaddleOCR installed:
      returns a lazy Hybrid OCR checker serialized via `GpuWorkloadScheduler` (`hybrid_ocr`).
    - In local mode with Tesseract + pytesseract available: returns a fast CPU-only Tesseract
      checker (`tesseract_ocr`, 0 MiB VRAM).
    """
    if _is_remote_worker_ocr_mode():
        return None

    preferred_engine = (os.getenv("VIREAD_OCR_TEXT_FREE_ENGINE") or "tesseract").strip().lower()
    if preferred_engine == "hybrid" and importlib.util.find_spec("paddleocr") is not None:

        def _hybrid_ocr_check(image_bytes: bytes) -> str:
            from app.services import ocr_engine

            scheduler = get_default_gpu_scheduler()

            def _run() -> str:
                try:
                    result = ocr_engine.extract_text_and_boxes(image_bytes)
                except ocr_engine.OcrNoTextDetected:
                    return ""
                return str(result.get("text") or "").strip()

            return scheduler.run_sync(
                WorkloadPriority.PREPROCESSING,
                "illustration-text-free-hybrid-ocr",
                _run,
                estimated_vram_mb=1200,
            )

        setattr(_hybrid_ocr_check, "_ocr_gate_mode", "hybrid_ocr")
        return _hybrid_ocr_check

    tesseract_bin = _resolve_tesseract_binary()
    if tesseract_bin and importlib.util.find_spec("pytesseract") is not None:
        backend_root = Path(__file__).resolve().parents[2]
        tessdata_dir = backend_root / "tessdata"
        has_local_vie = (tessdata_dir / "vie.traineddata").is_file()

        def _extract_high_conf_tokens(
            pytesseract_mod: Any, rgb_img: Image.Image, *, lang: str, psm: str, min_conf_3: int, min_conf_2: int
        ) -> list[str]:
            data = pytesseract_mod.image_to_data(
                rgb_img,
                lang=lang,
                config=psm,
                output_type=pytesseract_mod.Output.DICT,
            )
            tokens: list[str] = []
            for raw_tok, raw_conf in zip(data.get("text", []), data.get("conf", [])):
                tok_str = str(raw_tok or "").strip()
                if not tok_str:
                    continue
                try:
                    conf_val = float(raw_conf)
                except (TypeError, ValueError):
                    continue
                if conf_val < 0:
                    continue
                for word in _WORD_TOKEN_RE.findall(unicodedata.normalize("NFC", tok_str)):
                    threshold = min_conf_3 if len(word) >= 3 else min_conf_2
                    if conf_val >= threshold:
                        tokens.append(word)
            return tokens

        def _tesseract_ocr_check(image_bytes: bytes) -> str:
            import pytesseract

            if has_local_vie and not os.environ.get("TESSDATA_PREFIX"):
                os.environ["TESSDATA_PREFIX"] = str(tessdata_dir)
            pytesseract.pytesseract.tesseract_cmd = tesseract_bin
            with Image.open(BytesIO(image_bytes)) as img:
                rgb = img.convert("RGB")
                for lang in ("vie+eng", "eng"):
                    try:
                        # Pass 1: Auto page segmentation (--psm 3) for clean printed text/banners
                        tokens = _extract_high_conf_tokens(
                            pytesseract, rgb, lang=lang, psm="--psm 3", min_conf_3=55, min_conf_2=65
                        )
                        if not tokens:
                            # Pass 2: Sparse text (--psm 11) with stricter confidence floor
                            # to catch direct overlays on colored backgrounds while ignoring painted texture noise.
                            tokens = _extract_high_conf_tokens(
                                pytesseract, rgb, lang=lang, psm="--psm 11", min_conf_3=65, min_conf_2=75
                            )
                        return " ".join(tokens).strip()
                    except Exception:
                        if lang == "eng":
                            raise
                        continue
            return ""

        setattr(_tesseract_ocr_check, "_ocr_gate_mode", "tesseract_ocr")
        return _tesseract_ocr_check

    return None


@dataclass(frozen=True)
class TextFreeVerificationResult:
    text_free_verified: bool
    text_density_score: float
    ocr_overlap_score: float
    bbox_overlap_score: float
    detected_text_runs: int
    detected_glyph_count: int
    ocr_detected_text: str
    ocr_gate_mode: str = "opencv_only_remote_worker"
    ocr_checked: bool = False


@dataclass(frozen=True)
class IllustrationExtractionOutput:
    status: str  # EXTRACTED_VERIFIED | REJECTED_CONTAINS_TEXT | NO_CLEAN_ARTWORK
    webp_bytes: bytes | None
    width: int
    height: int
    size_bytes: int
    asset_hash: str | None
    crop_bbox_norm: list[float] | None
    artwork_area_ratio: float
    verification: TextFreeVerificationResult
    restored_with_clahe: bool


def _normalize_tokens(text: str | None) -> set[str]:
    normalized = unicodedata.normalize("NFC", (text or "").lower())
    return set(_WORD_TOKEN_RE.findall(normalized))


def compute_ocr_text_overlap(detected_text: str | None, canonical_text: str | None) -> float:
    """Compute normalized token containment ratio between crop OCR text and canonical story text."""
    detected_tokens = _normalize_tokens(detected_text)
    if not detected_tokens:
        return 0.0
    canonical_tokens = _normalize_tokens(canonical_text)
    if not canonical_tokens:
        # Even without canonical_text (e.g. AI book covers), >= 2 readable words indicate baked-in text.
        return round(min(1.0, len(detected_tokens) / 6.0), 4) if len(detected_tokens) >= 2 else 0.0
    shared = detected_tokens & canonical_tokens
    if not shared:
        return round(min(1.0, len(detected_tokens) / 10.0), 4) if len(detected_tokens) >= 3 else 0.0
    denom = max(1, min(len(canonical_tokens), 12))
    ratio = len(shared) / float(denom)
    if len(shared) >= 3:
        ratio = max(ratio, 0.25)
    return round(min(1.0, ratio), 4)


def _compute_bbox_overlap(
    crop_norm: list[float] | None, word_bboxes: list[list[float]] | None
) -> float:
    if not crop_norm or not word_bboxes:
        return 0.0
    cx, cy, cw, ch = crop_norm
    cx2, cy2 = cx + cw, cy + ch
    overlapping = 0
    for box in word_bboxes:
        if len(box) != 4:
            continue
        bx, by, bw, bh = box
        if bw <= 0 or bh <= 0:
            continue
        ix1 = max(cx, bx)
        iy1 = max(cy, by)
        ix2 = min(cx2, bx + bw)
        iy2 = min(cy2, by + bh)
        if ix2 > ix1 and iy2 > iy1:
            inter = (ix2 - ix1) * (iy2 - iy1)
            if inter / (bw * bh) >= 0.25:
                overlapping += 1
    return round(overlapping / float(len(word_bboxes)), 4)


def verify_illustration_text_free(
    image_bgr: np.ndarray,
    *,
    canonical_text: str | None = None,
    crop_bbox_norm: list[float] | None = None,
    word_bboxes: list[list[float]] | None = None,
    ocr_check_fn: OcrCheckFn | None = None,
    image_bytes: bytes | None = None,
) -> TextFreeVerificationResult:
    """MANDATORY text-free duplicate validation gate (OpenCV glyph-line detector + bbox + optional OCR overlap)."""
    h_orig, w_orig = image_bgr.shape[:2]
    if h_orig < 24 or w_orig < 24:
        return TextFreeVerificationResult(
            text_free_verified=False,
            text_density_score=1.0,
            ocr_overlap_score=0.0,
            bbox_overlap_score=1.0,
            detected_text_runs=0,
            detected_glyph_count=0,
            ocr_detected_text="",
        )

    scale = min(1.0, 900.0 / float(max(h_orig, w_orig)))
    work = (
        cv2.resize(
            image_bgr,
            (max(1, int(round(w_orig * scale))), max(1, int(round(h_orig * scale)))),
            interpolation=cv2.INTER_AREA,
        )
        if scale < 1.0
        else image_bgr
    )
    h, w = work.shape[:2]
    gray = cv2.cvtColor(work, cv2.COLOR_BGR2GRAY)

    # Detect crisp high-contrast ink strokes in BOTH polarities independently
    # (dark-on-light AND light-on-dark) without merging opposite-polarity halos.
    adaptive_dark = cv2.adaptiveThreshold(
        gray,
        255,
        cv2.ADAPTIVE_THRESH_GAUSSIAN_C,
        cv2.THRESH_BINARY_INV,
        21,
        15,
    )
    adaptive_light = cv2.adaptiveThreshold(
        gray,
        255,
        cv2.ADAPTIVE_THRESH_GAUSSIAN_C,
        cv2.THRESH_BINARY,
        21,
        -15,
    )
    # Require strong local edge contrast so soft watercolor gradients are not mistaken for printed glyphs
    grad_x = cv2.Sobel(gray, cv2.CV_16S, 1, 0, ksize=3)
    grad_y = cv2.Sobel(gray, cv2.CV_16S, 0, 1, ksize=3)
    grad_mag = cv2.convertScaleAbs(
        cv2.addWeighted(cv2.convertScaleAbs(grad_x), 0.5, cv2.convertScaleAbs(grad_y), 0.5, 0)
    )
    edge_dilated = cv2.dilate((grad_mag >= 28).astype(np.uint8) * 255, np.ones((3, 3), np.uint8))

    def _extract_runs_from_mask(mask: np.ndarray) -> list[tuple[int, int, int, int, int]]:
        num_labels, _labels, stats, _centroids = cv2.connectedComponentsWithStats(
            mask, connectivity=8
        )
        min_glyph_h = max(6, int(round(0.012 * h)))
        max_glyph_h = max(20, int(round(0.14 * h)))
        max_glyph_w = max(14, int(round(0.11 * w)))

        glyphs: list[tuple[int, int, int, int, float]] = []
        for idx in range(1, num_labels):
            gx = int(stats[idx, cv2.CC_STAT_LEFT])
            gy = int(stats[idx, cv2.CC_STAT_TOP])
            gw = int(stats[idx, cv2.CC_STAT_WIDTH])
            gh = int(stats[idx, cv2.CC_STAT_HEIGHT])
            area = int(stats[idx, cv2.CC_STAT_AREA])

            if gh < min_glyph_h or gh > max_glyph_h:
                continue
            if gw < 2 or gw > max_glyph_w:
                continue
            aspect = gw / float(gh)
            if aspect < 0.08 or aspect > 2.4:
                continue
            fill = area / float(max(1, gw * gh))
            if fill < 0.12 or fill > 0.9:
                continue

            pad = 2
            rx1, ry1 = max(0, gx - pad), max(0, gy - pad)
            rx2, ry2 = min(w, gx + gw + pad), min(h, gy + gh + pad)
            patch = gray[ry1:ry2, rx1:rx2]
            if patch.size == 0 or (int(patch.max()) - int(patch.min())) < 38:
                continue

            glyphs.append((gx, gy, gw, gh, gy + gh * 0.5))

        glyphs.sort(key=lambda item: (item[4], item[0]))
        bands: list[list[tuple[int, int, int, int, float]]] = []
        for glyph in glyphs:
            gx, gy, gw, gh, yc = glyph
            placed = False
            for band in bands:
                avg_yc = sum(g[4] for g in band) / len(band)
                avg_h = sum(g[3] for g in band) / len(band)
                if abs(yc - avg_yc) <= max(6.0, 0.55 * avg_h) and (0.4 * avg_h <= gh <= 2.4 * avg_h):
                    band.append(glyph)
                    placed = True
                    break
            if not placed:
                bands.append([glyph])

        found_runs: list[tuple[int, int, int, int, int]] = []
        for band in bands:
            if len(band) < 4:
                continue
            band.sort(key=lambda g: g[0])
            cluster: list[tuple[int, int, int, int, float]] = [band[0]]
            for g in band[1:]:
                prev = cluster[-1]
                avg_h = sum(item[3] for item in cluster) / len(cluster)
                gap = g[0] - (prev[0] + prev[2])
                if gap <= max(24.0, 2.5 * avg_h):
                    cluster.append(g)
                else:
                    if len(cluster) >= 4:
                        _append_run_if_textlike(cluster, w, found_runs)
                    cluster = [g]
            if len(cluster) >= 4:
                _append_run_if_textlike(cluster, w, found_runs)
        return found_runs

    runs_dark = _extract_runs_from_mask(cv2.bitwise_and(adaptive_dark, edge_dilated))
    runs_light = _extract_runs_from_mask(cv2.bitwise_and(adaptive_light, edge_dilated))
    text_runs = (
        runs_dark
        if (len(runs_dark), sum(r[4] for r in runs_dark))
        >= (len(runs_light), sum(r[4] for r in runs_light))
        else runs_light
    )

    total_line_glyphs = sum(run[4] for run in text_runs)
    run_area = sum((r[2] - r[0]) * (r[3] - r[1]) for r in text_runs)
    run_area_ratio = run_area / float(max(1, w * h))

    if len(text_runs) >= 2 or total_line_glyphs >= 10:
        text_density_score = max(
            run_area_ratio * 2.5,
            min(1.0, total_line_glyphs / 32.0) * 0.45,
            0.12,
        )
    elif len(text_runs) == 1 and total_line_glyphs >= 5:
        text_density_score = max(run_area_ratio * 2.0, 0.095)
    else:
        text_density_score = min(0.06, run_area_ratio)
    text_density_score = round(min(1.0, text_density_score), 4)

    bbox_overlap_score = _compute_bbox_overlap(crop_bbox_norm, word_bboxes)

    ocr_detected_text = ""
    ocr_overlap_score = 0.0
    ocr_checked = False
    ocr_gate_mode = "opencv_only_remote_worker"
    meaningful_ocr_tokens: set[str] = set()
    if ocr_check_fn is not None:
        effective_bytes = image_bytes
        if not effective_bytes:
            ok_enc, encoded_buf = cv2.imencode(".png", image_bgr)
            effective_bytes = encoded_buf.tobytes() if ok_enc else b""
        if effective_bytes:
            declared_mode = str(getattr(ocr_check_fn, "_ocr_gate_mode", "") or "").strip()
            try:
                ocr_detected_text = (ocr_check_fn(effective_bytes) or "").strip()
                meaningful_ocr_tokens = _normalize_tokens(ocr_detected_text)
                ocr_overlap_score = compute_ocr_text_overlap(ocr_detected_text, canonical_text)
                ocr_checked = True
                ocr_gate_mode = declared_mode or "tesseract_ocr"
            except Exception as exc:
                logger.warning("Optional OCR text-free check failed (type=%s)", type(exc).__name__)
                ocr_checked = False
                ocr_gate_mode = "opencv_only_remote_worker"

    if ocr_checked:
        # Real OCR verified: trust clean OCR (zero meaningful >= 2-char alnum tokens &
        # overlap below threshold) so detailed painted textures (foliage/petals/fur) do not
        # false-reject text-free artwork; still strictly reject any OCR text or bbox overlap.
        verified = (
            ocr_overlap_score < OCR_OVERLAP_REJECT_THRESHOLD
            and len(meaningful_ocr_tokens) == 0
            and bbox_overlap_score < BBOX_OVERLAP_REJECT_THRESHOLD
        )
    else:
        # OpenCV-only fallback (remote_worker / no OCR engine): enforce strict heuristic density gate.
        verified = (
            text_density_score < TEXT_DENSITY_REJECT_THRESHOLD
            and ocr_overlap_score < OCR_OVERLAP_REJECT_THRESHOLD
            and bbox_overlap_score < BBOX_OVERLAP_REJECT_THRESHOLD
        )
    return TextFreeVerificationResult(
        text_free_verified=verified,
        text_density_score=text_density_score,
        ocr_overlap_score=ocr_overlap_score,
        bbox_overlap_score=bbox_overlap_score,
        detected_text_runs=len(text_runs),
        detected_glyph_count=total_line_glyphs,
        ocr_detected_text=ocr_detected_text[:400],
        ocr_gate_mode=ocr_gate_mode,
        ocr_checked=ocr_checked,
    )


def _append_run_if_textlike(
    cluster: list[tuple[int, int, int, int, float]],
    image_width: int,
    out: list[tuple[int, int, int, int, int]],
) -> None:
    x1 = min(g[0] for g in cluster)
    y1 = min(g[1] for g in cluster)
    x2 = max(g[0] + g[2] for g in cluster)
    y2 = max(g[1] + g[3] for g in cluster)
    run_w = x2 - x1
    run_h = max(1, y2 - y1)
    # Text runs are wider than tall and span meaningful horizontal extent
    if run_w >= max(24, int(0.07 * image_width)) and (run_w / float(run_h)) >= 1.6:
        out.append((x1, y1, x2, y2, len(cluster)))


def _decode_bgr_safely(image_bytes: bytes) -> np.ndarray:
    detected = detect_magic_image_format(image_bytes)
    if detected is None:
        raise HTTPException(
            status_code=HTTP_422,
            detail="Ảnh trang sách không hợp lệ (chỉ hỗ trợ JPG, PNG hoặc WEBP).",
        )
    try:
        with Image.open(BytesIO(image_bytes)) as source:
            width, height = source.size
            if width <= 0 or height <= 0 or (width * height) > MAX_COVER_PIXELS:
                raise HTTPException(
                    status_code=HTTP_422,
                    detail="Ảnh vượt quá giới hạn an toàn 25 megapixel.",
                )
            source.load()
            rgb = ImageOps.exif_transpose(source).convert("RGB")
            arr = np.asarray(rgb, dtype=np.uint8)
            return cv2.cvtColor(arr, cv2.COLOR_RGB2BGR)
    except HTTPException:
        raise
    except (UnidentifiedImageError, OSError, ValueError, Image.DecompressionBombError) as exc:
        raise HTTPException(
            status_code=HTTP_422,
            detail="Không thể giải mã ảnh trang sách.",
        ) from exc


def _apply_gentle_clahe_restore(crop_bgr: np.ndarray) -> np.ndarray:
    """Gentle lighting/contrast restoration & paper-grain denoise without distorting author artwork."""
    lab = cv2.cvtColor(crop_bgr, cv2.COLOR_BGR2LAB)
    l_channel, a_channel, b_channel = cv2.split(lab)
    clahe = cv2.createCLAHE(clipLimit=1.8, tileGridSize=(8, 8))
    enhanced_l = clahe.apply(l_channel)
    blended_l = cv2.addWeighted(enhanced_l, 0.55, l_channel, 0.45, 0)
    restored = cv2.cvtColor(cv2.merge((blended_l, a_channel, b_channel)), cv2.COLOR_LAB2BGR)
    denoised = cv2.bilateralFilter(restored, d=5, sigmaColor=20, sigmaSpace=20)
    return denoised


def _build_non_text_mask(
    width: int, height: int, word_bboxes: list[list[float]]
) -> np.ndarray:
    mask = np.full((height, width), 255, dtype=np.uint8)
    pad_x = max(5, int(round(0.016 * width)))
    pad_y = max(5, int(round(0.020 * height)))

    pixel_boxes: list[tuple[int, int, int, int]] = []
    for box in word_bboxes:
        if len(box) != 4:
            continue
        bx, by, bw, bh = box
        if bw <= 0 or bh <= 0:
            continue
        x1 = max(0, int(round(bx * width)) - pad_x)
        y1 = max(0, int(round(by * height)) - pad_y)
        x2 = min(width, int(round((bx + bw) * width)) + pad_x)
        y2 = min(height, int(round((by + bh) * height)) + pad_y)
        mask[y1:y2, x1:x2] = 0
        pixel_boxes.append((x1, y1, x2, y2))

    # Mask contiguous horizontal lines formed by neighboring words so inter-word gaps don't leak
    if len(pixel_boxes) >= 2:
        pixel_boxes.sort(key=lambda b: ((b[1] + b[3]) * 0.5, b[0]))
        lines: list[list[tuple[int, int, int, int]]] = []
        for pb in pixel_boxes:
            yc = (pb[1] + pb[3]) * 0.5
            placed = False
            for line in lines:
                lyc = sum((item[1] + item[3]) * 0.5 for item in line) / len(line)
                lh = sum((item[3] - item[1]) for item in line) / len(line)
                if abs(yc - lyc) <= max(10.0, 0.8 * lh):
                    line.append(pb)
                    placed = True
                    break
            if not placed:
                lines.append([pb])
        for line in lines:
            lx1 = min(b[0] for b in line)
            ly1 = min(b[1] for b in line)
            lx2 = max(b[2] for b in line)
            ly2 = max(b[3] for b in line)
            mask[ly1:ly2, lx1:lx2] = 0

    return mask


def extract_clean_illustration_from_bytes(
    page_image_bytes: bytes,
    *,
    word_bboxes: list[list[float]] | None = None,
    canonical_text: str | None = None,
    min_area_ratio: float = 0.12,
    apply_clahe_restore: bool = True,
    ocr_check_fn: OcrCheckFn | None = None,
) -> IllustrationExtractionOutput:
    """Extract largest clean non-text artwork from a page scan, restore gently, and run mandatory text-free gate."""
    full_bgr = _decode_bgr_safely(page_image_bytes)
    full_h, full_w = full_bgr.shape[:2]

    scale = min(1.0, float(MAX_ANALYSIS_EDGE) / float(max(full_h, full_w)))
    work_w = max(1, int(round(full_w * scale)))
    work_h = max(1, int(round(full_h * scale)))
    work_bgr = (
        cv2.resize(full_bgr, (work_w, work_h), interpolation=cv2.INTER_AREA)
        if scale < 1.0
        else full_bgr
    )

    boxes = list(word_bboxes or [])
    non_text_mask = _build_non_text_mask(work_w, work_h, boxes)

    hsv = cv2.cvtColor(work_bgr, cv2.COLOR_BGR2HSV)
    saturation = hsv[:, :, 1]
    value = hsv[:, :, 2]

    # Identify colorful artwork OR solid non-blank illustration strokes while ignoring blank white/cream paper
    colorful_mask = ((saturation >= 28) & (value >= 30)).astype(np.uint8) * 255
    dark_content_mask = ((value < 210) & (saturation < 28)).astype(np.uint8) * 255
    # Filter thin text-like strokes out of grayscale dark mask by requiring cohesive blobs
    dark_blobs = cv2.morphologyEx(
        dark_content_mask,
        cv2.MORPH_OPEN,
        cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (7, 7)),
    )
    content_mask = cv2.bitwise_or(colorful_mask, dark_blobs)
    content_mask = cv2.bitwise_and(content_mask, non_text_mask)

    # Clean speckles and join nearby illustration parts without crossing masked text regions
    cleaned = cv2.morphologyEx(
        content_mask,
        cv2.MORPH_OPEN,
        cv2.getStructuringElement(cv2.MORPH_RECT, (5, 5)),
    )
    close_size = max(13, min(29, int(round(min(work_w, work_h) * 0.035)) | 1))
    merged_mask = cv2.morphologyEx(
        cleaned,
        cv2.MORPH_CLOSE,
        cv2.getStructuringElement(cv2.MORPH_RECT, (close_size, close_size)),
    )
    merged_mask = cv2.bitwise_and(merged_mask, non_text_mask)

    contours, _ = cv2.findContours(merged_mask, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    page_area = float(work_w * work_h)

    candidate_rects: list[tuple[int, int, int, int]] = []
    for cnt in contours:
        rx, ry, rw, rh = cv2.boundingRect(cnt)
        if (rw * rh) / page_area >= 0.015:
            candidate_rects.append((rx, ry, rx + rw, ry + rh))

    # Iteratively merge nearby rects if their union doesn't cross masked text regions
    changed = True
    while changed and len(candidate_rects) > 1:
        changed = False
        candidate_rects.sort(key=lambda r: (r[2] - r[0]) * (r[3] - r[1]), reverse=True)
        merged_list: list[tuple[int, int, int, int]] = []
        used = [False] * len(candidate_rects)
        for i, rect_a in enumerate(candidate_rects):
            if used[i]:
                continue
            ax1, ay1, ax2, ay2 = rect_a
            for j in range(i + 1, len(candidate_rects)):
                if used[j]:
                    continue
                bx1, by1, bx2, by2 = candidate_rects[j]
                ux1, uy1 = min(ax1, bx1), min(ay1, by1)
                ux2, uy2 = max(ax2, bx2), max(ay2, by2)
                # Only merge if reasonably close and union has <2% masked text overlap
                gap_x = max(0, max(ax1, bx1) - min(ax2, bx2))
                gap_y = max(0, max(ay1, by1) - min(ay2, by2))
                if gap_x <= int(0.08 * work_w) and gap_y <= int(0.08 * work_h):
                    masked_fraction = float((non_text_mask[uy1:uy2, ux1:ux2] == 0).mean())
                    if masked_fraction < 0.02:
                        ax1, ay1, ax2, ay2 = ux1, uy1, ux2, uy2
                        used[j] = True
                        changed = True
            used[i] = True
            merged_list.append((ax1, ay1, ax2, ay2))
        candidate_rects = merged_list

    best_rect: tuple[int, int, int, int] | None = None
    best_area_ratio = 0.0
    for rx1, ry1, rx2, ry2 in candidate_rects:
        ratio = ((rx2 - rx1) * (ry2 - ry1)) / page_area
        if ratio < min_area_ratio:
            continue
        crop_preview = work_bgr[ry1:ry2, rx1:rx2]
        if float(np.std(crop_preview)) < 12.0:
            continue
        if ratio > best_area_ratio:
            best_area_ratio = ratio
            best_rect = (rx1, ry1, rx2, ry2)

    if best_rect is None:
        empty_check = TextFreeVerificationResult(
            text_free_verified=False,
            text_density_score=0.0,
            ocr_overlap_score=0.0,
            bbox_overlap_score=0.0,
            detected_text_runs=0,
            detected_glyph_count=0,
            ocr_detected_text="",
        )
        return IllustrationExtractionOutput(
            status="NO_CLEAN_ARTWORK",
            webp_bytes=None,
            width=0,
            height=0,
            size_bytes=0,
            asset_hash=None,
            crop_bbox_norm=None,
            artwork_area_ratio=0.0,
            verification=empty_check,
            restored_with_clahe=False,
        )

    rx1, ry1, rx2, ry2 = best_rect
    crop_bbox_norm = [
        round(rx1 / float(work_w), 4),
        round(ry1 / float(work_h), 4),
        round((rx2 - rx1) / float(work_w), 4),
        round((ry2 - ry1) / float(work_h), 4),
    ]

    # Map back to original high-resolution coordinates
    fx1 = max(0, int(round(rx1 / scale)))
    fy1 = max(0, int(round(ry1 / scale)))
    fx2 = min(full_w, int(round(rx2 / scale)))
    fy2 = min(full_h, int(round(ry2 / scale)))
    crop_bgr = full_bgr[fy1:fy2, fx1:fx2].copy()

    # Cap max output edge for low memory & fast mobile delivery
    ch, cw = crop_bgr.shape[:2]
    if max(ch, cw) > MAX_ILLUSTRATION_EDGE:
        out_scale = float(MAX_ILLUSTRATION_EDGE) / float(max(ch, cw))
        crop_bgr = cv2.resize(
            crop_bgr,
            (max(1, int(round(cw * out_scale))), max(1, int(round(ch * out_scale)))),
            interpolation=cv2.INTER_AREA,
        )

    if apply_clahe_restore:
        crop_bgr = _apply_gentle_clahe_restore(crop_bgr)

    crop_rgb = cv2.cvtColor(crop_bgr, cv2.COLOR_BGR2RGB)
    pil_crop = Image.fromarray(crop_rgb)
    webp_bytes, out_w, out_h = _encode_optimized_webp(
        pil_crop, max_bytes=MAX_ILLUSTRATION_WEBP_BYTES
    )
    asset_hash = hashlib.sha256(webp_bytes).hexdigest()

    verification = verify_illustration_text_free(
        crop_bgr,
        canonical_text=canonical_text,
        crop_bbox_norm=crop_bbox_norm,
        word_bboxes=boxes,
        ocr_check_fn=ocr_check_fn,
        image_bytes=webp_bytes,
    )

    result_status = (
        "EXTRACTED_VERIFIED"
        if verification.text_free_verified
        else "REJECTED_CONTAINS_TEXT"
    )
    return IllustrationExtractionOutput(
        status=result_status,
        webp_bytes=webp_bytes,
        width=out_w,
        height=out_h,
        size_bytes=len(webp_bytes),
        asset_hash=asset_hash,
        crop_bbox_norm=crop_bbox_norm,
        artwork_area_ratio=round(best_area_ratio, 4),
        verification=verification,
        restored_with_clahe=apply_clahe_restore,
    )


def _bucket_for_book(book: Book) -> str:
    if is_book_private(book):
        return SUPABASE_PRIVATE_BOOKS_BUCKET
    return SUPABASE_STORAGE_BUCKET or "books"


_MAX_PAGE_DOWNLOAD_BYTES = 12 * 1024 * 1024


def _is_global_ip_str(raw_ip: str) -> bool:
    try:
        addr = ipaddress.ip_address(raw_ip)
    except ValueError:
        return False
    return bool(
        addr.is_global
        and not addr.is_private
        and not addr.is_loopback
        and not addr.is_link_local
        and not addr.is_multicast
        and not addr.is_reserved
    )


async def _validate_and_download_page_image(
    image_path: str | None,
    *,
    is_private_book: bool,
    bucket: str,
) -> bytes:
    cleaned = (image_path or "").strip()
    if not cleaned:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Stored page image path is invalid",
        )
    lower = cleaned.lower()
    if lower.startswith(("http://", "https://")):
        if is_private_book or not lower.startswith("https://"):
            raise HTTPException(
                status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
                detail="Stored page image path is invalid",
            )
        parsed = urlsplit(cleaned)
        host = (parsed.hostname or "").strip().lower()
        if (
            parsed.scheme != "https"
            or not host
            or host in {"localhost", "localhost.localdomain"}
            or parsed.username is not None
            or parsed.password is not None
        ):
            raise HTTPException(
                status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
                detail="Stored page image URL is invalid",
            )
        try:
            ipaddress.ip_address(host)
            if not _is_global_ip_str(host):
                raise HTTPException(
                    status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
                    detail="Stored page image URL host is not allowed",
                )
        except ValueError:
            try:
                infos = await asyncio.to_thread(
                    socket.getaddrinfo, host, parsed.port or 443, type=socket.SOCK_STREAM
                )
            except OSError as exc:
                raise HTTPException(
                    status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
                    detail="Stored page image URL could not be resolved",
                ) from exc
            resolved_ips = {info[4][0] for info in infos if info and info[4]}
            if not resolved_ips or not all(_is_global_ip_str(ip) for ip in resolved_ips):
                raise HTTPException(
                    status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
                    detail="Stored page image URL host is not allowed",
                )
        try:
            async with httpx.AsyncClient(
                timeout=20.0, trust_env=False, follow_redirects=False
            ) as client:
                async with client.stream("GET", cleaned) as resp:
                    if resp.status_code != 200:
                        raise HTTPException(
                            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
                            detail="Could not download catalog page image",
                        )
                    buf = bytearray()
                    async for chunk in resp.aiter_bytes(65536):
                        buf.extend(chunk)
                        if len(buf) > _MAX_PAGE_DOWNLOAD_BYTES:
                            raise HTTPException(
                                status_code=status.HTTP_413_CONTENT_TOO_LARGE,
                                detail="Catalog page image exceeds safe size limit",
                            )
                    return bytes(buf)
        except HTTPException:
            raise
        except httpx.HTTPError as exc:
            raise HTTPException(
                status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
                detail="Could not download catalog page image",
            ) from exc

    safe_path = _validate_relative_storage_path(cleaned)
    return await asyncio.to_thread(download_object, safe_path, bucket_name=bucket)


def _encode_and_verify_ai_illustration(
    raw_bytes: bytes,
    *,
    canonical_text: str | None,
    ocr_check_fn: OcrCheckFn | None,
) -> tuple[bytes, int, int, str, TextFreeVerificationResult]:
    img_bgr = _decode_bgr_safely(raw_bytes)
    rgb = cv2.cvtColor(img_bgr, cv2.COLOR_BGR2RGB)
    webp_bytes, out_w, out_h = _encode_optimized_webp(
        Image.fromarray(rgb), max_bytes=MAX_ILLUSTRATION_WEBP_BYTES
    )
    asset_hash = hashlib.sha256(webp_bytes).hexdigest()
    verification = verify_illustration_text_free(
        img_bgr,
        canonical_text=canonical_text,
        ocr_check_fn=ocr_check_fn,
        image_bytes=webp_bytes,
    )
    return webp_bytes, out_w, out_h, asset_hash, verification


class BookIllustrationService:
    """Orchestrates text-free page illustration extraction, generation, and moderation.

    Strictly isolated from Flow 1 / Flow 2: NEVER mutates `bookpages.imagepath`,
    `pagerevisions`, or `viread_ocr_outbox`.
    """

    def __init__(
        self,
        db: AsyncSession,
        *,
        ocr_check_fn: OcrCheckFn | None = None,
        image_transport: ImageGenerateTransport | None = None,
        ai_router: AiCapabilityRouter | None = None,
        gpu_scheduler: GpuWorkloadScheduler | None = None,
    ) -> None:
        self.db = db
        self.repo = BookAssetsRepository(db)
        self.cover_service = BookCoverService(
            db,
            image_transport=image_transport,
            ai_router=ai_router,
            gpu_scheduler=gpu_scheduler,
            ocr_check_fn=ocr_check_fn,
        )
        self.style_bible_service = BookStyleBibleService(db)
        self._ocr_check_fn = ocr_check_fn
        self._custom_image_transport = image_transport
        self._ai_router = ai_router
        self._gpu_scheduler = gpu_scheduler

    async def extract_page_illustration(
        self,
        actor_id: UUID,
        book_id: UUID,
        page_id: UUID,
        payload: PageIllustrationExtractRequest,
        *,
        page_image_bytes_override: bytes | None = None,
        existing_job_id: UUID | None = None,
        existing_lease_token: UUID | None = None,
        existing_source_revision_id: UUID | None = None,
    ) -> PageIllustrationExtractResponse:
        book, _role = await self.cover_service.authorize_book_write(actor_id, book_id)
        page = await self.repo.get_page(book.Id, page_id)
        if page is None:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND, detail="Book page not found"
            )

        resolved_book_id = book.Id
        resolved_page_id = page.Id
        private_book = is_book_private(book)
        owner_id = book.OwnerParentId if private_book else None
        bucket = _bucket_for_book(book)
        raw_image_path = page.ImagePath

        revision_id, revision_text, revision_bboxes = await self.repo.get_page_revision_context(
            page
        )
        expected_revision_id = existing_source_revision_id or revision_id
        word_bboxes = payload.word_bboxes if payload.word_bboxes else revision_bboxes
        canonical_text = (
            payload.canonical_text
            if payload.canonical_text is not None
            else revision_text
        )

        # Release read transaction before Storage/network I/O & OpenCV CPU work.
        if callable(getattr(self.db, "rollback", None)):
            await self.db.rollback()

        if page_image_bytes_override is not None:
            source_bytes = page_image_bytes_override
        else:
            source_bytes = await _validate_and_download_page_image(
                raw_image_path,
                is_private_book=private_book,
                bucket=bucket,
            )

        managed_by_worker = existing_job_id is not None and existing_lease_token is not None
        if managed_by_worker and existing_job_id is not None and existing_lease_token is not None:
            await self.cover_service._advance_worker_progress(
                job_id=existing_job_id,
                lease_token=existing_lease_token,
                stage="ILLUSTRATION_EXTRACT",
                completed=1,
                total=3,
            )

        extraction = await asyncio.to_thread(
            extract_clean_illustration_from_bytes,
            source_bytes,
            word_bboxes=word_bboxes,
            canonical_text=canonical_text,
            min_area_ratio=payload.min_area_ratio,
            apply_clahe_restore=payload.apply_clahe_restore,
            ocr_check_fn=self._ocr_check_fn,
        )

        if extraction.status == "NO_CLEAN_ARTWORK" or extraction.webp_bytes is None or extraction.asset_hash is None:
            return PageIllustrationExtractResponse(
                status="NO_CLEAN_ARTWORK",
                asset=None,
                text_free_verified=False,
                text_density_score=extraction.verification.text_density_score,
                ocr_overlap_score=extraction.verification.ocr_overlap_score,
                artwork_area_ratio=extraction.artwork_area_ratio,
                recommended_reading_mode="TEXT",
                message_vi=(
                    "Không tìm thấy vùng tranh minh họa sạch (>= 12% diện tích trang) tách biệt khỏi văn bản. "
                    "Hệ thống khuyến nghị chế độ Đọc chữ sạch."
                ),
            )

        if managed_by_worker and existing_job_id is not None and existing_lease_token is not None:
            await self.cover_service._advance_worker_progress(
                job_id=existing_job_id,
                lease_token=existing_lease_token,
                stage="TEXT_FREE_VERIFY",
                completed=2,
                total=3,
            )

        scope = f"private/{owner_id}" if private_book else "catalog"
        storage_path = _validate_relative_storage_path(
            f"studio/illustrations/{scope}/{resolved_book_id}/{resolved_page_id}/{extraction.asset_hash[:16]}_{uuid4().hex[:8]}.webp"
        )
        await asyncio.to_thread(
            upload_object,
            storage_path,
            extraction.webp_bytes,
            "image/webp",
            bucket_name=bucket,
            upsert=False,
        )

        is_verified = extraction.verification.text_free_verified
        moderation_status = "APPROVED" if is_verified else "REJECTED"
        source_type = "ENHANCED_CROP" if extraction.restored_with_clahe else "ORIGINAL_CROP"

        try:
            if managed_by_worker and existing_job_id is not None and existing_lease_token is not None:
                from app.services.global_tasks_service import (
                    GlobalTasksService,
                    verify_smart_studio_job_fence_in_tx,
                )

                _fenced_job, fence_status = await verify_smart_studio_job_fence_in_tx(
                    self.db,
                    job_id=existing_job_id,
                    lease_token=existing_lease_token,
                    expected_revision_id=expected_revision_id,
                    book_page_id=resolved_page_id,
                )
                if fence_status == "STALE":
                    await asyncio.to_thread(delete_object, storage_path, bucket_name=bucket)
                    return PageIllustrationExtractResponse(
                        status="FAILED",
                        asset=None,
                        text_free_verified=False,
                        text_density_score=extraction.verification.text_density_score,
                        ocr_overlap_score=extraction.verification.ocr_overlap_score,
                        artwork_area_ratio=extraction.artwork_area_ratio,
                        recommended_reading_mode="TEXT",
                        message_vi="Trang sách đã chuyển sang phiên bản mới hơn; kết quả trích xuất cũ bị bỏ qua.",
                    )

            asset = await self.repo.create_page_illustration_asset(
                book_id=resolved_book_id,
                book_page_id=resolved_page_id,
                source_revision_id=revision_id,
                owner_id=owner_id,
                source_type=source_type,
                storage_path=storage_path,
                mime_type="image/webp",
                width=extraction.width,
                height=extraction.height,
                size_bytes=extraction.size_bytes,
                asset_hash=extraction.asset_hash,
                text_free_verified=is_verified,
                moderation_status=moderation_status,
                is_active=is_verified,
                provider_name="opencv_local",
                model_id="opencv-clahe-textfree-v2",
                job_id=existing_job_id,
                metadata_json={
                    "crop_bbox_norm": extraction.crop_bbox_norm,
                    "artwork_area_ratio": extraction.artwork_area_ratio,
                    "text_density_score": extraction.verification.text_density_score,
                    "ocr_overlap_score": extraction.verification.ocr_overlap_score,
                    "bbox_overlap_score": extraction.verification.bbox_overlap_score,
                    "detected_text_runs": extraction.verification.detected_text_runs,
                    "detected_glyph_count": extraction.verification.detected_glyph_count,
                    "restored_with_clahe": extraction.restored_with_clahe,
                    "ocr_gate_mode": extraction.verification.ocr_gate_mode,
                    "ocr_checked": extraction.verification.ocr_checked,
                },
            )
            if managed_by_worker and existing_job_id is not None and existing_lease_token is not None:
                from app.services.global_tasks_service import GlobalTasksService

                outcome = await GlobalTasksService(self.db).commit_stage_result(
                    job_id=existing_job_id,
                    lease_token=existing_lease_token,
                    stage="ILLUSTRATION_EXTRACT",
                    mark_stage_completed=is_verified,
                    checkpoint_data={"asset_id": str(asset.Id)} if is_verified else None,
                    next_status="SUCCEEDED" if is_verified else "FAILED",
                    result_ref={"asset_id": str(asset.Id)} if is_verified else None,
                    progress_completed=3 if is_verified else None,
                    progress_total=3 if is_verified else None,
                    progress_unit="bước" if is_verified else None,
                    error_code=None if is_verified else extraction.status,
                    error_message_vi=(
                        None
                        if is_verified
                        else "Vùng ảnh trích xuất vẫn chứa chữ truyện trùng lặp nên đã bị từ chối tự động."
                    ),
                )
                if not outcome.get("accepted"):
                    await asyncio.to_thread(delete_object, storage_path, bucket_name=bucket)
                    return PageIllustrationExtractResponse(
                        status="FAILED",
                        asset=None,
                        text_free_verified=False,
                        text_density_score=extraction.verification.text_density_score,
                        ocr_overlap_score=extraction.verification.ocr_overlap_score,
                        artwork_area_ratio=extraction.artwork_area_ratio,
                        recommended_reading_mode="TEXT",
                        message_vi="Tác vụ trích xuất đã bị hủy hoặc phiên bản trang đã thay đổi.",
                    )
            else:
                await self.db.commit()
        except BaseException:
            if callable(getattr(self.db, "rollback", None)):
                try:
                    await self.db.rollback()
                except Exception:
                    pass
            try:
                await asyncio.to_thread(delete_object, storage_path, bucket_name=bucket)
            except Exception:
                pass
            raise

        recommended: ReadingDisplayMode = "ILLUSTRATED" if is_verified else "TEXT"
        message_vi = (
            "Đã trích xuất và phục hồi tranh minh họa sạch (đã xác minh không chứa chữ truyện)."
            if is_verified
            else (
                "Cảnh báo: Vùng ảnh trích xuất vẫn chứa chữ truyện trùng lặp nên đã bị TỪ CHỐI tự động. "
                "Hệ thống chuyển sang chế độ Đọc chữ sạch để bé không bị rối mắt."
            )
        )
        return PageIllustrationExtractResponse(
            status=extraction.status,  # type: ignore[arg-type]
            asset=asset_to_dto(asset),
            text_free_verified=is_verified,
            text_density_score=extraction.verification.text_density_score,
            ocr_overlap_score=extraction.verification.ocr_overlap_score,
            artwork_area_ratio=extraction.artwork_area_ratio,
            recommended_reading_mode=recommended,
            message_vi=message_vi,
        )

    async def enqueue_ai_illustration_job(
        self,
        actor_id: UUID,
        book_id: UUID,
        page_id: UUID,
        payload: PageIllustrationGenerateRequest,
    ) -> PageIllustrationGenerateResponse:
        """Enqueue a durable QUEUED ILLUSTRATION_GENERATE SmartStudioJob without blocking HTTP."""
        book, role = await self.cover_service.authorize_book_write(actor_id, book_id)
        page = await self.repo.get_page(book.Id, page_id)
        if page is None:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND, detail="Book page not found"
            )

        resolved_book_id = book.Id
        resolved_page_id = page.Id
        private_book = is_book_private(book)
        revision_id, _canonical_text, _bboxes = await self.repo.get_page_revision_context(page)
        style_bible = await self.style_bible_service.get_or_build_for_book(book)
        provider = detect_image_generation_provider(
            is_private_book=private_book,
            router=self._ai_router,
        )
        safe_hint = _sanitize_child_safe_prompt_hint(payload.prompt_hint)
        input_hash = hashlib.sha256(
            f"{resolved_book_id}:{resolved_page_id}:{revision_id}:{style_bible.context_hash}:{safe_hint}".encode(
                "utf-8"
            )
        ).hexdigest()
        idem_key = (
            (payload.idempotency_key or "").strip()
            or f"ill-gen:{resolved_page_id}:{input_hash[:16]}:{uuid4().hex[:8]}"
        )

        if not provider.available:
            job = await self.repo.record_studio_job(
                job_type="ILLUSTRATION_GENERATE",
                actor_id=actor_id,
                actor_role=role,
                book_id=resolved_book_id,
                book_page_id=resolved_page_id,
                source_revision_id=revision_id,
                input_hash=input_hash,
                idempotency_key=idem_key,
                stage="BLOCKED_NO_IMAGE_PROVIDER",
                status_value="FAILED",
                error_code=provider.reason_code,
                error_message_vi=provider.message_vi,
            )
            await self.db.commit()
            return PageIllustrationGenerateResponse(
                status="BLOCKED_NO_IMAGE_PROVIDER",
                job_id=job.Id if job is not None else None,
                provider_name=None,
                model_id=None,
                asset=None,
                recommended_reading_mode="TEXT",
                message_vi=provider.message_vi,
            )

        job = await self.repo.record_studio_job(
            job_type="ILLUSTRATION_GENERATE",
            actor_id=actor_id,
            actor_role=role,
            book_id=resolved_book_id,
            book_page_id=resolved_page_id,
            source_revision_id=revision_id,
            input_hash=input_hash,
            idempotency_key=idem_key,
            stage="QUEUED",
            status_value="QUEUED",
            priority=int(WorkloadPriority.ILLUSTRATION_GEN),
        )
        if job is not None:
            checkpoints = dict(job.CheckpointsJson or {}) if isinstance(job.CheckpointsJson, dict) else {}
            checkpoints["request"] = {"prompt_hint": safe_hint}
            job.CheckpointsJson = checkpoints
        await self.db.commit()

        from app.services.global_tasks_service import notify_smart_studio_worker

        notify_smart_studio_worker()
        return PageIllustrationGenerateResponse(
            status="QUEUED",
            job_id=job.Id if job is not None else None,
            provider_name=provider.provider_name,
            model_id=provider.model_id,
            asset=None,
            recommended_reading_mode="TEXT",
            message_vi="Đã đưa yêu cầu tạo tranh minh họa AI vào hàng đợi xử lý nền.",
        )

    async def execute_ai_illustration_job(
        self,
        actor_id: UUID,
        book_id: UUID,
        page_id: UUID,
        payload: PageIllustrationGenerateRequest,
        *,
        existing_job_id: UUID | None = None,
        existing_lease_token: UUID | None = None,
        existing_source_revision_id: UUID | None = None,
        managed_by_worker: bool = False,
    ) -> PageIllustrationGenerateResponse:
        """Execute AI page illustration via AiCapabilityRouter + GpuWorkloadScheduler + Dual Text-Free Gate.

        When `existing_job_id` is supplied (e.g. from `global_tasks_service.py`), reuses that exact
        `SmartStudioJob` without creating a nested duplicate job.
        """
        book, role = await self.cover_service.authorize_book_write(actor_id, book_id)
        page = await self.repo.get_page(book.Id, page_id)
        if page is None:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND, detail="Book page not found"
            )

        resolved_book_id = book.Id
        resolved_page_id = page.Id
        private_book = is_book_private(book)
        owner_id = book.OwnerParentId if private_book else None
        bucket = _bucket_for_book(book)
        revision_id, canonical_text, _bboxes = await self.repo.get_page_revision_context(page)
        expected_revision_id = existing_source_revision_id or revision_id
        style_bible = await self.style_bible_service.get_or_build_for_book(book)
        allow_cloud = (not private_book) or OcrCorrectionConfig.private_book_allow_cloud_ai()
        provider = detect_image_generation_provider(
            is_private_book=private_book,
            router=self._ai_router,
        )

        safe_hint = _sanitize_child_safe_prompt_hint(payload.prompt_hint)
        input_hash = hashlib.sha256(
            f"{resolved_book_id}:{resolved_page_id}:{revision_id}:{style_bible.context_hash}:{safe_hint}".encode(
                "utf-8"
            )
        ).hexdigest()
        idem_key = (
            (payload.idempotency_key or "").strip()
            or f"ill-gen:{resolved_page_id}:{input_hash[:16]}:{uuid4().hex[:8]}"
        )

        if not provider.available:
            job_id_out = existing_job_id
            if existing_job_id is None:
                job = await self.repo.record_studio_job(
                    job_type="ILLUSTRATION_GENERATE",
                    actor_id=actor_id,
                    actor_role=role,
                    book_id=resolved_book_id,
                    book_page_id=resolved_page_id,
                    source_revision_id=revision_id,
                    input_hash=input_hash,
                    idempotency_key=idem_key,
                    stage="BLOCKED_NO_IMAGE_PROVIDER",
                    status_value="FAILED",
                    error_code=provider.reason_code,
                    error_message_vi=provider.message_vi,
                )
                job_id_out = job.Id if job is not None else None
                await self.db.commit()
            return PageIllustrationGenerateResponse(
                status="BLOCKED_NO_IMAGE_PROVIDER",
                job_id=job_id_out,
                provider_name=None,
                model_id=None,
                asset=None,
                recommended_reading_mode="TEXT",
                message_vi=provider.message_vi,
            )

        scene_snippet = (
            (safe_hint or canonical_text or book.Title)
            .replace("<", " ")
            .replace(">", " ")
            .strip()[:320]
        )
        prompt = (
            f"{style_bible.bible.prompt_prefix} "
            f"Illustrate this Vietnamese children's story moment without ANY text: {scene_snippet}."
        )

        job: SmartStudioJob | None = None
        if existing_job_id is not None:
            job = await self.repo.get_studio_job(existing_job_id)
            effective_job_id: UUID | None = existing_job_id
            if managed_by_worker and existing_lease_token is not None:
                await self.cover_service._advance_worker_progress(
                    job_id=existing_job_id,
                    lease_token=existing_lease_token,
                    stage="STYLE_BIBLE",
                    completed=1,
                    total=4,
                )
            elif managed_by_worker and callable(getattr(self.db, "rollback", None)):
                await self.db.rollback()
        else:
            if payload.idempotency_key and payload.idempotency_key.strip():
                existing_job = None
                try:
                    async with self.db.begin_nested():
                        existing_job = await self.db.scalar(
                            select(SmartStudioJob).where(
                                SmartStudioJob.ActorId == actor_id,
                                SmartStudioJob.IdempotencyKey == idem_key,
                            )
                        )
                except (SQLAlchemyError, AttributeError):
                    existing_job = None
                if existing_job is not None and existing_job.Status in (
                    "SUCCEEDED",
                    "RUNNING",
                    "QUEUED",
                    "WAITING_FOR_QUOTA",
                ):
                    existing_ills, _ = await self.repo.list_page_illustrations(
                        resolved_book_id, page_id=resolved_page_id
                    )
                    current_ill = next((item for item in existing_ills if item.IsActive), None)
                    return PageIllustrationGenerateResponse(
                        status=(
                            "SUCCEEDED"
                            if existing_job.Status == "SUCCEEDED"
                            else "WAITING_FOR_QUOTA"
                            if existing_job.Status == "WAITING_FOR_QUOTA"
                            else "QUEUED"
                        ),
                        job_id=existing_job.Id,
                        provider_name=provider.provider_name,
                        model_id=provider.model_id,
                        asset=asset_to_dto(current_ill) if current_ill is not None else None,
                        recommended_reading_mode=(
                            "ILLUSTRATED"
                            if current_ill is not None and current_ill.TextFreeVerified
                            else "TEXT"
                        ),
                        message_vi="Yêu cầu tạo minh họa AI này đã được tiếp nhận trước đó (tránh tạo trùng).",
                    )
            job = await self.repo.record_studio_job(
                job_type="ILLUSTRATION_GENERATE",
                actor_id=actor_id,
                actor_role=role,
                book_id=resolved_book_id,
                book_page_id=resolved_page_id,
                source_revision_id=revision_id,
                input_hash=input_hash,
                idempotency_key=idem_key,
                stage="IMAGE_GENERATING",
                status_value="RUNNING",
            )
            if job is not None:
                now_start = datetime.now(timezone.utc)
                job.LeaseExpiresAt = now_start + timedelta(seconds=90)
                job.ProgressCompleted = 1
                job.ProgressTotal = 4
                job.ProgressUnit = "bước"
                job.UpdatedAt = now_start
            await self.db.commit()
            effective_job_id = job.Id if job is not None else None

        tenant_scope = f"parent:{owner_id}" if private_book else "admin:catalog"
        http_status, raw_bytes, used_provider, used_model, error_code = (
            await generate_image_via_router_and_scheduler(
                prompt=prompt,
                negative_prompt=_DEFAULT_NEGATIVE_PROMPT,
                width=512,
                height=512,
                steps=4,
                tenant_scope=tenant_scope,
                allow_cloud=allow_cloud,
                source_hash=input_hash,
                revision=str(revision_id or resolved_page_id),
                priority=WorkloadPriority.ILLUSTRATION_GEN,
                workload_id=f"illust-gen:{resolved_page_id}",
                estimated_vram_mb=2200,
                provider_hint=provider,
                image_transport=self._custom_image_transport,
                ai_router=self._ai_router,
                gpu_scheduler=self._gpu_scheduler,
            )
        )
        resolved_provider = used_provider or provider.provider_name
        resolved_model = used_model or provider.model_id

        if http_status == 429:
            if job is not None and not managed_by_worker:
                job.Status = "WAITING_FOR_QUOTA"
                job.Stage = "WAITING_FOR_QUOTA"
                job.ErrorCode = "IMAGE_PROVIDER_QUOTA_EXCEEDED"
                await self.db.commit()
            return PageIllustrationGenerateResponse(
                status="WAITING_FOR_QUOTA",
                job_id=effective_job_id,
                provider_name=resolved_provider,
                model_id=resolved_model,
                asset=None,
                recommended_reading_mode="TEXT",
                message_vi="Hạn mức tạo ảnh AI miễn phí tạm thời đã hết. Hệ thống giữ chế độ Đọc chữ sạch.",
            )

        if http_status != 200 or not raw_bytes:
            if job is not None and not managed_by_worker:
                job.Status = "FAILED"
                job.ErrorCode = error_code or f"IMAGE_PROVIDER_HTTP_{http_status}"
                await self.db.commit()
            return PageIllustrationGenerateResponse(
                status="BLOCKED_NO_IMAGE_PROVIDER",
                job_id=effective_job_id,
                provider_name=resolved_provider,
                model_id=resolved_model,
                asset=None,
                recommended_reading_mode="TEXT",
                message_vi="Nhà cung cấp tạo ảnh AI tạm thời không khả dụng.",
            )

        if managed_by_worker and existing_job_id is not None and existing_lease_token is not None:
            await self.cover_service._advance_worker_progress(
                job_id=existing_job_id,
                lease_token=existing_lease_token,
                stage="IMAGE_GENERATING",
                completed=2,
                total=4,
            )
        elif job is not None and not managed_by_worker:
            job.Stage = "TEXT_FREE_VERIFY"
            job.ProgressCompleted = 2
            job.ProgressTotal = 4
            job.ProgressUnit = "bước"
            job.UpdatedAt = datetime.now(timezone.utc)
            await self.db.commit()

        webp_bytes, out_w, out_h, asset_hash, verification = await asyncio.to_thread(
            _encode_and_verify_ai_illustration,
            raw_bytes,
            canonical_text=canonical_text,
            ocr_check_fn=self._ocr_check_fn,
        )

        if managed_by_worker and existing_job_id is not None and existing_lease_token is not None:
            await self.cover_service._advance_worker_progress(
                job_id=existing_job_id,
                lease_token=existing_lease_token,
                stage="TEXT_FREE_VERIFY",
                completed=3,
                total=4,
            )
        elif job is not None and not managed_by_worker:
            job.Stage = "SAVING"
            job.ProgressCompleted = 3
            job.ProgressTotal = 4
            job.ProgressUnit = "bước"
            job.UpdatedAt = datetime.now(timezone.utc)
            await self.db.commit()

        # Revision fencing: verify page's verified revision did not advance while AI image generated!
        latest_page = await self.repo.get_page(resolved_book_id, resolved_page_id)
        if (
            expected_revision_id is not None
            and latest_page is not None
            and latest_page.CurrentVerifiedRevisionId is not None
            and latest_page.CurrentVerifiedRevisionId != expected_revision_id
        ):
            if job is not None and not managed_by_worker:
                now_stale = datetime.now(timezone.utc)
                job.Status = "STALE"
                job.Stage = "STALE_REVISION"
                job.CompletedAt = now_stale
                job.UpdatedAt = now_stale
                job.LeaseExpiresAt = None
                await self.db.commit()
            return PageIllustrationGenerateResponse(
                status="STALE",
                job_id=effective_job_id,
                provider_name=resolved_provider,
                model_id=resolved_model,
                asset=None,
                recommended_reading_mode="TEXT",
                message_vi="Nội dung trang đã được cập nhật sang phiên bản mới nên ảnh AI cũ được đánh dấu STALE.",
            )

        if callable(getattr(self.db, "rollback", None)):
            await self.db.rollback()

        scope = f"private/{owner_id}" if private_book else "catalog"
        storage_path = _validate_relative_storage_path(
            f"studio/illustrations/{scope}/{resolved_book_id}/{resolved_page_id}/ai_{asset_hash[:16]}_{uuid4().hex[:8]}.webp"
        )
        await asyncio.to_thread(
            upload_object,
            storage_path,
            webp_bytes,
            "image/webp",
            bucket_name=bucket,
            upsert=False,
        )

        is_verified = verification.text_free_verified
        try:
            if managed_by_worker and existing_job_id is not None and existing_lease_token is not None:
                from app.services.global_tasks_service import (
                    verify_smart_studio_job_fence_in_tx,
                )

                _fenced_job, fence_status = await verify_smart_studio_job_fence_in_tx(
                    self.db,
                    job_id=existing_job_id,
                    lease_token=existing_lease_token,
                    expected_revision_id=expected_revision_id,
                    book_page_id=resolved_page_id,
                )
                if fence_status == "STALE":
                    await asyncio.to_thread(delete_object, storage_path, bucket_name=bucket)
                    return PageIllustrationGenerateResponse(
                        status="STALE",
                        job_id=existing_job_id,
                        provider_name=resolved_provider,
                        model_id=resolved_model,
                        asset=None,
                        recommended_reading_mode="TEXT",
                        message_vi="Nội dung trang đã được cập nhật sang phiên bản mới nên ảnh AI cũ được đánh dấu STALE.",
                    )

            asset = await self.repo.create_page_illustration_asset(
                book_id=resolved_book_id,
                book_page_id=resolved_page_id,
                source_revision_id=revision_id,
                owner_id=owner_id,
                source_type="AI_GENERATED",
                storage_path=storage_path,
                mime_type="image/webp",
                width=out_w,
                height=out_h,
                size_bytes=len(webp_bytes),
                asset_hash=asset_hash,
                text_free_verified=is_verified,
                moderation_status="APPROVED" if is_verified else "REJECTED",
                is_active=is_verified,
                provider_name=resolved_provider,
                model_id=resolved_model,
                job_id=effective_job_id,
                metadata_json={
                    "text_density_score": verification.text_density_score,
                    "ocr_overlap_score": verification.ocr_overlap_score,
                    "ocr_gate_mode": verification.ocr_gate_mode,
                    "ocr_checked": verification.ocr_checked,
                },
            )
            if managed_by_worker and existing_job_id is not None and existing_lease_token is not None:
                from app.services.global_tasks_service import GlobalTasksService

                outcome = await GlobalTasksService(self.db).commit_stage_result(
                    job_id=existing_job_id,
                    lease_token=existing_lease_token,
                    stage="ILLUSTRATION_GEN",
                    mark_stage_completed=is_verified,
                    checkpoint_data={"asset_id": str(asset.Id)} if is_verified else None,
                    next_status="SUCCEEDED" if is_verified else "FAILED",
                    result_ref={
                        "asset_id": str(asset.Id),
                        "ocr_gate_mode": verification.ocr_gate_mode,
                    }
                    if is_verified
                    else None,
                    progress_completed=4 if is_verified else None,
                    progress_total=4 if is_verified else None,
                    progress_unit="bước" if is_verified else None,
                    error_code=None if is_verified else "REJECTED_CONTAINS_TEXT",
                    error_message_vi=(
                        None
                        if is_verified
                        else "Ảnh AI tạo ra chứa ký tự/chữ không hợp lệ nên đã bị từ chối tự động."
                    ),
                )
                if not outcome.get("accepted"):
                    await asyncio.to_thread(delete_object, storage_path, bucket_name=bucket)
                    return PageIllustrationGenerateResponse(
                        status="STALE",
                        job_id=existing_job_id,
                        provider_name=resolved_provider,
                        model_id=resolved_model,
                        asset=None,
                        recommended_reading_mode="TEXT",
                        message_vi="Nội dung trang đã được cập nhật hoặc tác vụ bị hủy trước khi lưu.",
                    )
            else:
                if job is not None:
                    now_done = datetime.now(timezone.utc)
                    job.Status = "SUCCEEDED" if is_verified else "FAILED"
                    job.Stage = "COMPLETED" if is_verified else "REJECTED_CONTAINS_TEXT"
                    if is_verified:
                        job.ProgressCompleted = 4
                        job.ProgressTotal = 4
                        job.ProgressUnit = "bước"
                    job.CompletedAt = now_done
                    job.UpdatedAt = now_done
                    job.LeaseExpiresAt = None
                    job.ResultRefJson = {
                        "asset_id": str(asset.Id),
                        "ocr_gate_mode": verification.ocr_gate_mode,
                    }
                await self.db.commit()
        except BaseException:
            if callable(getattr(self.db, "rollback", None)):
                try:
                    await self.db.rollback()
                except Exception:
                    pass
            try:
                await asyncio.to_thread(delete_object, storage_path, bucket_name=bucket)
            except Exception:
                pass
            raise

        return PageIllustrationGenerateResponse(
            status="SUCCEEDED" if is_verified else "REJECTED_CONTAINS_TEXT",
            job_id=effective_job_id,
            provider_name=resolved_provider,
            model_id=resolved_model,
            asset=asset_to_dto(asset),
            recommended_reading_mode="ILLUSTRATED" if is_verified else "TEXT",
            message_vi=(
                "Đã tạo tranh minh họa AI không chữ thành công."
                if is_verified
                else "Ảnh AI tạo ra chứa ký tự/chữ không hợp lệ nên đã bị từ chối tự động."
            ),
        )

    async def generate_page_illustration(
        self,
        actor_id: UUID,
        book_id: UUID,
        page_id: UUID,
        payload: PageIllustrationGenerateRequest,
        *,
        existing_job_id: UUID | None = None,
        existing_lease_token: UUID | None = None,
        existing_source_revision_id: UUID | None = None,
    ) -> PageIllustrationGenerateResponse:
        return await self.execute_ai_illustration_job(
            actor_id,
            book_id,
            page_id,
            payload,
            existing_job_id=existing_job_id,
            existing_lease_token=existing_lease_token,
            existing_source_revision_id=existing_source_revision_id,
            managed_by_worker=existing_job_id is not None,
        )

    async def moderate_page_illustration(
        self,
        actor_id: UUID,
        book_id: UUID,
        page_id: UUID,
        asset_id: UUID,
        payload: PageIllustrationModerationRequest,
    ) -> BookPresentationAssetRead:
        book, _role = await self.cover_service.authorize_book_write(actor_id, book_id)
        asset, degraded = await self.repo.get_asset_by_id(asset_id)
        if degraded or asset is None:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND, detail="Illustration asset not found"
            )
        if (
            asset.BookId != book.Id
            or asset.BookPageId != page_id
            or asset.AssetRole != "PAGE_ILLUSTRATION"
        ):
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND, detail="Illustration asset not found"
            )
        if payload.action in ("APPROVE", "RESTORE") and not asset.TextFreeVerified:
            raise HTTPException(
                status_code=HTTP_422,
                detail="Không thể kích hoạt tranh minh họa chưa vượt qua kiểm tra không chứa chữ.",
            )

        updated = await self.repo.moderate_page_illustration(
            asset,
            action=payload.action,
            reason=payload.reason,
        )
        await self.db.commit()
        return asset_to_dto(updated)
