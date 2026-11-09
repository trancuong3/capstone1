from __future__ import annotations

import logging
import os
from importlib.metadata import PackageNotFoundError, version as package_version
from pathlib import Path
import re
import shutil
import tempfile
import threading
import unicodedata
from typing import Any

from app.services.ocr_evidence import (
    HYBRID_OCR_EVIDENCE_CONTRACT,
    MAX_SELECTIVE_WORD_CROPS_PER_PAGE,
    OCR_PREPROCESSING_VERSION,
    crop_word_region,
    find_split_merge_candidates,
    token_alignment_cost,
)

os.environ["KMP_DUPLICATE_LIB_OK"] = "TRUE"

# The Windows setup script keeps the pinned Vietnamese model inside this
# checkout instead of writing into Program Files. Tesseract expects the parent
# directory of `tessdata` here; preserve any explicit machine/user override.
_backend_root = Path(__file__).resolve().parents[2]
if (_backend_root / "tessdata" / "vie.traineddata").is_file():
    os.environ.setdefault("TESSDATA_PREFIX", str(_backend_root))

import PIL.Image

if not hasattr(PIL.Image, "ANTIALIAS"):
    PIL.Image.ANTIALIAS = PIL.Image.Resampling.LANCZOS

import cv2
import jiwer
import numpy as np
import pytesseract
from pytesseract import Output
import torch
from PIL import Image

try:
    from paddleocr import PaddleOCR
except ImportError:
    PaddleOCR = None  # type: ignore

try:
    from vietocr.tool.config import Cfg
    from vietocr.tool.predictor import Predictor
except ImportError:
    Cfg = None  # type: ignore
    Predictor = None  # type: ignore

logger = logging.getLogger(__name__)



class OcrEngineUnavailable(RuntimeError):
    """Mô hình PaddleOCR hoặc VietOCR không khả dụng hoặc chưa được cấu hình."""


class OcrNoTextDetected(RuntimeError):
    """Hình ảnh hợp lệ nhưng hệ thống không phát hiện được chữ tiếng Việt khả dụng."""


def normalize_word(value: str) -> str:
    value = unicodedata.normalize("NFC", value).strip().lower()
    while value and (
        unicodedata.category(value[0]).startswith(("P", "S"))
        and value[0] not in {"'", "-"}
    ):
        value = value[1:]
    while value and (
        unicodedata.category(value[-1]).startswith(("P", "S"))
        and value[-1] not in {"'", "-"}
    ):
        value = value[:-1]
    return re.sub(r"\s+", " ", value).strip()


def normalize_text_tokens(value: str) -> list[str]:
    return [
        token
        for raw in re.split(r"\s+", unicodedata.normalize("NFC", value).strip())
        if (token := normalize_word(raw))
    ]


_paddle_engine: PaddleOCR | None = None
_vietocr_engine: Predictor | None = None
_engine_lock = threading.Lock()


def _find_cached_vietocr_weights() -> str | None:
    temp_dir = os.environ.get("TEMP", os.environ.get("TMP", tempfile.gettempdir()))
    candidates = [
        os.path.join(temp_dir, "vgg_transformer.pth"),
        os.path.expanduser(r"~\AppData\Local\Temp\vgg_transformer.pth"),
        os.path.expanduser("~/.cache/vietocr/vgg_transformer.pth"),
        os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..", "weights", "vgg_transformer.pth")),
    ]
    for path in candidates:
        if path and os.path.isfile(path) and os.path.getsize(path) > 10 * 1024 * 1024:
            return path
    return None


def _get_ocr_engines() -> tuple[PaddleOCR, Predictor]:
    global _paddle_engine, _vietocr_engine
    if _paddle_engine is not None and _vietocr_engine is not None:
        return _paddle_engine, _vietocr_engine

    with _engine_lock:
        if _paddle_engine is not None and _vietocr_engine is not None:
            return _paddle_engine, _vietocr_engine

        try:
            if PaddleOCR is None or Cfg is None or Predictor is None:
                raise OcrEngineUnavailable(
                    "Thư viện PaddleOCR hoặc VietOCR chưa được cài đặt trong môi trường."
                )

            paddle_inst = PaddleOCR(
                use_angle_cls=False,
                lang="vi",
                det_limit_side_len=2048,
                det_db_thresh=0.25,
                det_db_box_thresh=0.18,
                det_db_unclip_ratio=1.60,
                det_db_score_mode="slow",
                drop_score=0.0,
                show_log=False,
            )

            viet_config = Cfg.load_config_from_name("vgg_transformer")
            target_device = "cuda" if torch.cuda.is_available() else "cpu"
            viet_config["device"] = target_device

            cached_weight = _find_cached_vietocr_weights()
            if cached_weight:
                viet_config["weights"] = cached_weight

            if target_device == "cpu":
                torch.set_num_threads(min(8, max(2, os.cpu_count() or 4)))

            viet_inst = Predictor(viet_config)

            _paddle_engine = paddle_inst
            _vietocr_engine = viet_inst
            logger.info("OCR Dual-Engine (PaddleOCR + VietOCR) đã nạp sẵn thành công vào RAM.")
        except Exception as exc:
            raise OcrEngineUnavailable(
                f"Không thể khởi tạo engine PaddleOCR / VietOCR: {exc}"
            ) from exc

    return _paddle_engine, _vietocr_engine


def warmup_ocr_engines() -> None:
    try:
        _get_ocr_engines()
    except Exception as exc:
        logger.warning(f"Preload OCR Engine thất bại: {exc}")


threading.Thread(target=warmup_ocr_engines, daemon=True, name="ocr_model_preloader").start()


def strip_accents(text: str) -> str:
    text = unicodedata.normalize("NFD", text)
    text = re.sub(r"[\u0300-\u036f]", "", text)
    text = text.replace("đ", "d").replace("Đ", "D")
    return re.sub(r"[^a-zA-Z0-9\s]", "", text).lower().strip()


def clean_ocr_punctuation(text: str) -> str:
    text = re.sub(r'(^|\s)\?(?=[A-ZÀ-Ỹa-zà-ỹ])', r'\1"', text)
    text = re.sub(r'\.{2,3}3[\?\"]*', '...?"', text)
    return text.strip()


def _transfer_punctuation(viet_text: str, paddle_text: str) -> str:
    v_clean = viet_text.strip()
    p_clean = paddle_text.strip()
    if not v_clean or not p_clean:
        return v_clean

    trailing_punct_match = re.search(r"([,!?:;\"'…]+)$", p_clean)
    if trailing_punct_match and not re.search(r"[,!?:;\"'…]$", v_clean):
        v_clean = v_clean + trailing_punct_match.group(1)

    leading_punct_match = re.match(r"^([\"'“—–-]+)", p_clean)
    if leading_punct_match and not re.match(r"^[\"'“—–-]", v_clean):
        v_clean = leading_punct_match.group(1) + v_clean

    return v_clean


def is_vietocr_reliable(
    viet_text: str,
    paddle_text: str,
    paddle_conf: float = 0.90,
    max_cer: float = 0.40,
) -> bool:
    """Reject obvious empty/repetition outputs, not select OCR correctness.

    A True result means only that VietOCR can be shown as a provisional draft.
    It does not mean the candidate is better than PaddleOCR or that its words
    are correct. Diacritic-folded CER and line-level confidence are excluded.
    """
    del paddle_text, paddle_conf, max_cer
    candidate = unicodedata.normalize("NFC", viet_text).strip()
    if not candidate:
        return False
    words = candidate.split()
    if len(words) >= 3:
        for index in range(len(words) - 2):
            if words[index].casefold() == words[index + 1].casefold() == words[index + 2].casefold():
                return False
    return True


DUAL_ENGINE_EVIDENCE_CONTRACT = "dual_engine_agreement_v2"
PADDLE_LINE_SCORE_CONTRACT = "paddle_line_score_v1"
MAX_ALIGNMENT_CELLS = 100_000


def _token_surface(value: str) -> str:
    return unicodedata.normalize("NFC", str(value)).strip()


def _token_alignment_cost(left: str, right: str) -> float:
    """NFC token distance that preserves all Vietnamese diacritics."""
    return token_alignment_cost(left, right)


def align_ocr_tokens(
    primary_tokens: list[str],
    secondary_tokens: list[str],
    *,
    max_cells: int = MAX_ALIGNMENT_CELLS,
) -> list[dict[str, object]]:
    """Globally align tokens in order, with explicit gaps and one-to-one pairs."""
    left_count = len(primary_tokens)
    right_count = len(secondary_tokens)
    if left_count * right_count > max_cells:
        return (
            [
                {"operation": "delete", "primary_index": i, "secondary_index": None, "similarity": None}
                for i in range(left_count)
            ]
            + [
                {"operation": "insert", "primary_index": None, "secondary_index": j, "similarity": None}
                for j in range(right_count)
            ]
        )

    gap_cost = 0.45
    costs = [[0.0] * (right_count + 1) for _ in range(left_count + 1)]
    steps: list[list[str | None]] = [
        [None] * (right_count + 1) for _ in range(left_count + 1)
    ]
    for i in range(1, left_count + 1):
        costs[i][0] = i * gap_cost
        steps[i][0] = "delete"
    for j in range(1, right_count + 1):
        costs[0][j] = j * gap_cost
        steps[0][j] = "insert"

    for i in range(1, left_count + 1):
        for j in range(1, right_count + 1):
            substitution_cost = _token_alignment_cost(
                primary_tokens[i - 1], secondary_tokens[j - 1]
            )
            options = (
                (costs[i - 1][j - 1] + substitution_cost, "pair"),
                (costs[i - 1][j] + gap_cost, "delete"),
                (costs[i][j - 1] + gap_cost, "insert"),
            )
            best_cost, best_step = options[0]
            for candidate_cost, candidate_step in options[1:]:
                if candidate_cost < best_cost - 1e-12:
                    best_cost, best_step = candidate_cost, candidate_step
            costs[i][j] = best_cost
            steps[i][j] = best_step

    aligned: list[dict[str, object]] = []
    i, j = left_count, right_count
    while i or j:
        step = steps[i][j]
        if step == "pair":
            primary_index, secondary_index = i - 1, j - 1
            exact = _token_surface(primary_tokens[primary_index]) == _token_surface(
                secondary_tokens[secondary_index]
            )
            similarity = max(
                0.0,
                min(
                    1.0,
                    1.0
                    - float(
                        jiwer.cer(
                            _token_surface(primary_tokens[primary_index]).casefold(),
                            _token_surface(secondary_tokens[secondary_index]).casefold(),
                        )
                    ),
                ),
            )
            aligned.append(
                {
                    "operation": "match" if exact else "substitute",
                    "primary_index": primary_index,
                    "secondary_index": secondary_index,
                    "similarity": round(similarity, 4),
                }
            )
            i -= 1
            j -= 1
        elif step == "delete":
            aligned.append(
                {"operation": "delete", "primary_index": i - 1, "secondary_index": None, "similarity": None}
            )
            i -= 1
        elif step == "insert":
            aligned.append(
                {"operation": "insert", "primary_index": None, "secondary_index": j - 1, "similarity": None}
            )
            j -= 1
        else:
            raise RuntimeError("OCR token alignment has an invalid backtrace")
    aligned.reverse()
    return aligned


def _word_engine_evidence(
    recognized_word: str,
    other_engine_word: str | None,
) -> tuple[float | None, str]:
    recognized = _token_surface(recognized_word)
    other = _token_surface(other_engine_word or "")
    if not recognized or not other:
        return None, "needs_review"
    if recognized == other:
        return 1.0, "engine_agreement"
    try:
        similarity = max(0.0, min(1.0, 1.0 - float(jiwer.cer(recognized.casefold(), other.casefold()))))
    except (TypeError, ValueError, ZeroDivisionError):
        similarity = None
    return (round(similarity, 4) if similarity is not None else None), "engine_disagreement"


def _word_ocr_evidence(
    recognized_word: str,
    other_engine_word: str | None,
    line_confidence: float | None = None,
) -> tuple[None, str, None]:
    """Compatibility wrapper: engine evidence never becomes word probability."""
    del line_confidence
    _, status = _word_engine_evidence(recognized_word, other_engine_word)
    return None, status, None


def _tesseract_review_status(_confidence: float | None) -> str:
    """A raw score from one engine cannot establish correctness."""
    return "needs_review"


def _order_quad_points(pts: np.ndarray) -> np.ndarray:
    pts = np.array(pts, dtype=np.float32)
    x_sorted = pts[np.argsort(pts[:, 0])]
    left_pts = x_sorted[:2]
    right_pts = x_sorted[2:]
    tl, bl = left_pts[np.argsort(left_pts[:, 1])]
    tr, br = right_pts[np.argsort(right_pts[:, 1])]
    return np.array([tl, tr, br, bl], dtype=np.float32)


def _dewarp_strip_with_safe_border(
    rect_img: np.ndarray, v_curve: np.ndarray, strip_h: int
) -> np.ndarray:
    crop_h, crop_w = rect_img.shape[:2]
    strip_h = max(24, int(strip_h))
    u_grid = np.broadcast_to(
        np.arange(crop_w, dtype=np.float32)[None, :], (strip_h, crop_w)
    ).copy()
    v_offsets = (
        np.arange(strip_h, dtype=np.float32)[:, None] - (strip_h / 2.0)
    )
    v_grid = np.clip(v_curve[None, :] + v_offsets, 0.0, float(crop_h - 1)).astype(
        np.float32
    )

    dewarped = cv2.remap(
        rect_img,
        u_grid,
        v_grid,
        interpolation=cv2.INTER_CUBIC,
        borderMode=cv2.BORDER_REPLICATE,
    )

    pad_horiz = max(16, int(strip_h * 0.30))
    pad_vert = max(12, int(strip_h * 0.22))
    return cv2.copyMakeBorder(
        dewarped,
        top=pad_vert,
        bottom=pad_vert,
        left=pad_horiz,
        right=pad_horiz,
        borderType=cv2.BORDER_CONSTANT,
        value=[255, 255, 255],
    )


def _extract_curved_lines_from_items(
    raw_items: list, image: np.ndarray
) -> list[dict[str, Any]]:
    if not raw_items:
        return []

    img_h, img_w = image.shape[:2]
    temp_items = []

    for raw in raw_items:
        pts = _order_quad_points(raw[0])
        p_text = str(raw[1][0]) if (len(raw) > 1 and raw[1]) else ""
        try:
            raw_confidence = raw[1][1] if (len(raw) > 1 and raw[1]) else None
            p_conf = (
                float("nan")
                if raw_confidence is None or isinstance(raw_confidence, (bool, np.bool_))
                else float(raw_confidence)
            )
        except (TypeError, ValueError, OverflowError):
            p_conf = float("nan")

        raw_w = max(np.linalg.norm(pts[0] - pts[1]), np.linalg.norm(pts[2] - pts[3]))
        raw_h = max(np.linalg.norm(pts[0] - pts[3]), np.linalg.norm(pts[1] - pts[2]))

        if raw_w < 8 or raw_h < 8:
            continue

        vec_x = (pts[1] - pts[0]) / max(1.0, float(raw_w))
        vec_y = (pts[3] - pts[0]) / max(1.0, float(raw_h))
        pad_x = max(6.0, raw_h * 0.22)
        pad_y = max(4.0, raw_h * 0.20)

        padded_pts = pts.copy()
        padded_pts[0] -= vec_x * pad_x + vec_y * pad_y
        padded_pts[1] += vec_x * pad_x - vec_y * pad_y
        padded_pts[2] += vec_x * pad_x + vec_y * pad_y
        padded_pts[3] -= vec_x * pad_x - vec_y * pad_y

        padded_pts[:, 0] = np.clip(padded_pts[:, 0], 0, img_w - 1)
        padded_pts[:, 1] = np.clip(padded_pts[:, 1], 0, img_h - 1)

        crop_w = int(max(np.linalg.norm(padded_pts[0] - padded_pts[1]), np.linalg.norm(padded_pts[2] - padded_pts[3])))
        crop_h = int(max(np.linalg.norm(padded_pts[0] - padded_pts[3]), np.linalg.norm(padded_pts[1] - padded_pts[2])))

        temp_items.append((padded_pts, crop_w, crop_h, p_text, p_conf))

    if not temp_items:
        return []

    extracted: list[dict[str, Any]] = []

    for pts, crop_w, crop_h, p_text, p_conf in temp_items:
        pts_std = np.float32([[0, 0], [crop_w, 0], [crop_w, crop_h], [0, crop_h]])
        matrix = cv2.getPerspectiveTransform(pts, pts_std)
        rect_img = cv2.warpPerspective(
            image,
            matrix,
            (crop_w, crop_h),
            borderMode=cv2.BORDER_REPLICATE,
            flags=cv2.INTER_CUBIC,
        )

        v_curve = np.full(crop_w, crop_h / 2.0, dtype=np.float32)
        strip_h = int(round(max(24.0, float(crop_h) * 1.30)))
        dewarped_img = _dewarp_strip_with_safe_border(rect_img, v_curve, strip_h)

        tl, tr, br, bl = pts[0], pts[1], pts[2], pts[3]

        extracted.append({
            "quad": pts,
            "crop_w": crop_w,
            "crop_h": crop_h,
            "rect_img": rect_img,
            "band_h": float(crop_h),
            "dewarped_img": dewarped_img,
            "paddle_text": p_text,
            "paddle_conf": p_conf,
            "yc": float((tl[1] + tr[1] + br[1] + bl[1]) / 4.0),
        })

    return extracted


def sort_reading_order_adaptive(
    raw_items: list, img_width: int, image: np.ndarray
) -> tuple[list[dict[str, Any]], str]:
    items = _extract_curved_lines_from_items(raw_items, image)
    if not items:
        return [], "empty"

    items.sort(key=lambda it: it["yc"])
    return items, "single_column"


def _segment_words_by_ink(
    rect_img: np.ndarray, words: list[str]
) -> list[tuple[float, float, float, float]]:
    num_words = len(words)
    c_h, c_w = rect_img.shape[:2]
    if num_words == 0 or c_w < 8 or c_h < 6:
        return []

    gray = cv2.cvtColor(rect_img, cv2.COLOR_BGR2GRAY)
    block_sz = max(11, (c_h | 1))
    binary = cv2.adaptiveThreshold(
        gray, 255, cv2.ADAPTIVE_THRESH_GAUSSIAN_C, cv2.THRESH_BINARY_INV, block_sz, 10
    )

    binary[0:1, :] = 0
    binary[-1:, :] = 0
    binary[:, 0:1] = 0
    binary[:, -1:] = 0

    row_ink = np.where(np.sum(binary > 0, axis=1) >= 1)[0]
    if len(row_ink) > 0:
        line_y0 = max(0, int(row_ink[0]) - 3)
        line_y1 = min(c_h, int(row_ink[-1]) + 4)
    else:
        line_y0 = 0
        line_y1 = c_h

    norm_y0 = float(line_y0) / c_h
    norm_y1 = float(line_y1) / c_h

    v_proj = np.sum(binary[line_y0:line_y1, :] > 0, axis=0)
    has_ink = v_proj > 0
    ink_cols = np.where(has_ink)[0]

    if len(ink_cols) == 0:
        step = 1.0 / num_words
        return [(i * step, norm_y0, (i + 1) * step, norm_y1) for i in range(num_words)]

    first_ink = int(ink_cols[0])
    last_ink = int(ink_cols[-1])

    if num_words == 1:
        return [(max(0.0, (first_ink - 3) / c_w), norm_y0, min(1.0, (last_ink + 4) / c_w), norm_y1)]

    best_segments = None
    best_diff = 999

    for k in range(3, min(28, max(6, int(c_h * 0.75)))):
        kernel = cv2.getStructuringElement(cv2.MORPH_RECT, (k, 1))
        dilated = cv2.dilate(binary, kernel)

        num_labels, labels, stats, centroids = cv2.connectedComponentsWithStats(dilated)
        comps = []
        for lbl in range(1, num_labels):
            area = stats[lbl, cv2.CC_STAT_AREA]
            w = stats[lbl, cv2.CC_STAT_WIDTH]
            h = stats[lbl, cv2.CC_STAT_HEIGHT]
            if area >= 8 and w >= 3 and h >= 4:
                comps.append([
                    stats[lbl, cv2.CC_STAT_LEFT],
                    stats[lbl, cv2.CC_STAT_WIDTH],
                    stats[lbl, cv2.CC_STAT_TOP],
                    stats[lbl, cv2.CC_STAT_HEIGHT],
                ])

        comps.sort(key=lambda c: c[0])

        merged_comps: list[list[int]] = []
        for comp in comps:
            if not merged_comps:
                merged_comps.append(list(comp))
            else:
                prev = merged_comps[-1]
                if comp[0] <= prev[0] + prev[1]:
                    new_r = max(prev[0] + prev[1], comp[0] + comp[1])
                    new_top = min(prev[2], comp[2])
                    new_bot = max(prev[2] + prev[3], comp[2] + comp[3])
                    prev[0] = min(prev[0], comp[0])
                    prev[1] = new_r - prev[0]
                    prev[2] = new_top
                    prev[3] = new_bot - new_top
                else:
                    merged_comps.append(list(comp))

        diff = abs(len(merged_comps) - num_words)
        if diff < best_diff:
            best_diff = diff
            best_segments = merged_comps
            if diff == 0:
                break

    if best_segments is None:
        best_segments = []

    while len(best_segments) > num_words:
        min_gap = 1e9
        min_idx = 0
        for i in range(len(best_segments) - 1):
            gap = best_segments[i + 1][0] - (best_segments[i][0] + best_segments[i][1])
            if gap < min_gap:
                min_gap = gap
                min_idx = i
        c1 = best_segments[min_idx]
        c2 = best_segments[min_idx + 1]
        new_r = max(c1[0] + c1[1], c2[0] + c2[1])
        new_top = min(c1[2], c2[2])
        new_bot = max(c1[2] + c1[3], c2[2] + c2[3])
        merged = [min(c1[0], c2[0]), new_r - min(c1[0], c2[0]), new_top, new_bot - new_top]
        best_segments = best_segments[:min_idx] + [merged] + best_segments[min_idx + 2:]

    while len(best_segments) < num_words:
        widest_idx = int(np.argmax([c[1] for c in best_segments]))
        c = best_segments[widest_idx]
        x_start = c[0]
        x_end = c[0] + c[1]
        mid_left = x_start + int(c[1] * 0.25)
        mid_right = x_start + int(c[1] * 0.75)
        if mid_left < mid_right:
            split_pt = mid_left + int(np.argmin(v_proj[mid_left:mid_right]))
        else:
            split_pt = (x_start + x_end) // 2

        c_left = [x_start, max(2, split_pt - x_start), c[2], c[3]]
        c_right = [split_pt, max(2, x_end - split_pt), c[2], c[3]]
        best_segments = best_segments[:widest_idx] + [c_left, c_right] + best_segments[widest_idx + 1:]

    result_boxes: list[tuple[float, float, float, float]] = []
    for i, comp in enumerate(best_segments):
        x_start = max(0, comp[0])
        x_end = min(c_w, comp[0] + comp[1])

        sub_bin = binary[:, x_start:x_end]
        sub_cols = np.where(np.sum(sub_bin > 0, axis=0) > 0)[0]

        if len(sub_cols) > 0:
            real_x0 = x_start + int(sub_cols[0])
            real_x1 = x_start + int(sub_cols[-1]) + 1
        else:
            real_x0 = x_start
            real_x1 = x_end

        box_x0 = max(0.0, float(real_x0 - 3) / c_w)
        box_x1 = min(1.0, float(real_x1 + 3) / c_w)

        result_boxes.append((box_x0, norm_y0, box_x1, norm_y1))

    gap_norm = 2.0 / c_w
    for i in range(len(result_boxes) - 1):
        b1 = result_boxes[i]
        b2 = result_boxes[i + 1]
        if b1[2] >= b2[0]:
            mid = (b1[2] + b2[0]) / 2.0
            result_boxes[i] = (b1[0], b1[1], max(b1[0] + 0.002, mid - gap_norm / 2.0), b1[3])
            result_boxes[i + 1] = (min(b2[2] - 0.002, mid + gap_norm / 2.0), b2[1], b2[2], b2[3])

    return result_boxes


def _map_curved_word_boxes(
    words: list[str],
    item: dict[str, Any],
    orig_width: int,
    orig_height: int,
) -> list[list[float]]:
    if not words:
        return []

    rect_img = item["rect_img"]
    pts = item["quad"]
    tl, tr, br, bl = pts[0], pts[1], pts[2], pts[3]

    word_spans = _segment_words_by_ink(rect_img, words)
    boxes: list[list[float]] = []

    for rx0, ry0, rx1, ry1 in word_spans:
        pt_tl = (tl + rx0 * (tr - tl)) + ry0 * ((bl + rx0 * (br - bl)) - (tl + rx0 * (tr - tl)))
        pt_tr = (tl + rx1 * (tr - tl)) + ry0 * ((bl + rx1 * (br - bl)) - (tl + rx1 * (tr - tl)))
        pt_bl = (tl + rx0 * (tr - tl)) + ry1 * ((bl + rx0 * (br - bl)) - (tl + rx0 * (tr - tl)))
        pt_br = (tl + rx1 * (tr - tl)) + ry1 * ((bl + rx1 * (br - bl)) - (tl + rx1 * (tr - tl)))

        word_xmin = float(min(pt_tl[0], pt_tr[0], pt_bl[0], pt_br[0]))
        word_xmax = float(max(pt_tl[0], pt_tr[0], pt_bl[0], pt_br[0]))
        word_ymin = float(min(pt_tl[1], pt_tr[1], pt_bl[1], pt_br[1]))
        word_ymax = float(max(pt_tl[1], pt_tr[1], pt_bl[1], pt_br[1]))

        norm_x = max(0.0, min(0.9999, word_xmin / orig_width))
        norm_y = max(0.0, min(0.9999, word_ymin / orig_height))
        norm_w = max(0.0001, min(1.0 - norm_x, (word_xmax - word_xmin) / orig_width))
        norm_h = max(0.0001, min(1.0 - norm_y, (word_ymax - word_ymin) / orig_height))

        boxes.append([round(norm_x, 6), round(norm_y, 6), round(norm_w, 6), round(norm_h, 6)])

    return boxes


def _resolve_tesseract_command() -> str | None:
    configured_binary = os.getenv("TESSERACT_CMD") or shutil.which("tesseract")
    if not configured_binary:
        install_directories = [
            os.getenv("ProgramFiles"),
            os.getenv("ProgramFiles(x86)"),
        ]
        configured_binary = next(
            (
                str(Path(directory) / "Tesseract-OCR" / "tesseract.exe")
                for directory in install_directories
                if directory
                and (Path(directory) / "Tesseract-OCR" / "tesseract.exe").is_file()
            ),
            None,
        )
    return configured_binary


def _extract_text_and_boxes_tesseract(image_bytes: bytes) -> dict[str, object]:
    """Fallback Tesseract cho môi trường CI headless không có GPU/PaddleOCR."""
    configured_binary = _resolve_tesseract_command()
    if configured_binary:
        pytesseract.pytesseract.tesseract_cmd = configured_binary.strip('"\'')

    array = np.frombuffer(image_bytes, dtype=np.uint8)
    image = cv2.imdecode(array, cv2.IMREAD_COLOR)
    if image is None:
        raise ValueError("Image decoding failed")
    orig_height, orig_width = image.shape[:2]

    target_lang = os.getenv("TESSERACT_LANG", "vie")
    gray = cv2.cvtColor(image, cv2.COLOR_BGR2GRAY)
    _, otsu = cv2.threshold(gray, 0, 255, cv2.THRESH_BINARY + cv2.THRESH_OTSU)

    try:
        result = pytesseract.image_to_data(
            otsu,
            lang=target_lang,
            config="--oem 1 --psm 6",
            output_type=Output.DICT,
        )
    except Exception as exc:
        raise OcrEngineUnavailable("Tesseract execution failed") from exc

    words: list[dict[str, object]] = []
    lines: dict[int, list[str]] = {}

    for index, raw_text in enumerate(result.get("text", [])):
        token = unicodedata.normalize("NFC", str(raw_text)).strip()
        if not token or not any(c.isalnum() for c in token):
            continue
        try:
            left = int(result["left"][index])
            top = int(result["top"][index])
            w = int(result["width"][index])
            h = int(result["height"][index])
            conf = float(result["conf"][index])
            line = int(result["line_num"][index])
        except (KeyError, TypeError, ValueError, IndexError):
            continue

        normalized = normalize_word(token)
        if not normalized:
            continue

        confidence = conf / 100.0 if 0 <= conf <= 100 else None
        words.append({
            "word_index": len(words),
            "line_index": line,
            "text": token,
            "normalized_text": normalized,
            "bbox": [left / orig_width, top / orig_height, w / orig_width, h / orig_height],
            "ocr_confidence": confidence,
            "ocr_score_source": "tesseract_raw_word_score_v1" if confidence is not None else None,
            "ocr_review_status": _tesseract_review_status(confidence),
            "ocr_evidence": {
                "contract": "tesseract_raw_word_score_v1",
                "engine_outputs": {"tesseract": token},
                "alignment": "single_engine",
                "engine_agreement_score": None,
                "calibrated_word_accuracy": None,
                "verification_source": None,
                "reference_text": None,
                "review_reason": "Chỉ có điểm thô từ một engine; Admin cần xác minh nội dung.",
            },
        })
        lines.setdefault(line, []).append(token)

    if not words:
        raise OcrNoTextDetected("Tesseract did not detect usable Vietnamese text")

    formatted_text = "\n".join(" ".join(lines[k]) for k in sorted(lines))
    return {
        "text": formatted_text,
        "words": words,
        "metadata": {
            "engine": "tesseract",
            "ocr_score_contract": "tesseract_raw_word_score_v1",
            "ocr_evidence_contract": "tesseract_raw_word_score_v1",
            "language": target_lang,
            "word_count": len(words),
            "line_count": len(lines),
        },
    }


def _package_version(distribution: str) -> str | None:
    try:
        return package_version(distribution)
    except PackageNotFoundError:
        return None


def _raw_recognition_score(value: Any) -> object:
    """Keep model output scores raw; never reinterpret them as accuracy."""
    if value is None:
        return None
    if torch.is_tensor(value):
        value = value.detach().cpu().tolist()
    elif isinstance(value, np.ndarray):
        value = value.tolist()
    if isinstance(value, bool):
        return None
    if isinstance(value, (int, float)):
        number = float(value)
        return number if np.isfinite(number) else None
    if isinstance(value, (list, tuple)):
        safe = []
        for item in value[:128]:
            if isinstance(item, bool):
                safe.append(None)
            elif isinstance(item, (int, float)):
                number = float(item)
                safe.append(number if np.isfinite(number) else None)
            else:
                safe.append(None)
        return safe
    return None


def _recognize_uncertain_word_crops(
    image: np.ndarray,
    words: list[dict[str, object]],
    paddle_engine: Any,
    vietocr_engine: Any,
) -> dict[str, object]:
    """Re-recognize disputed words with already-loaded recognition models."""
    import time

    started = time.perf_counter()
    prepared: list[tuple[dict[str, object], np.ndarray, dict[str, Any]]] = []
    rejected_bbox = 0
    rejected_quality = 0
    capped = 0
    bbox_validated = 0
    for word in words:
        evidence = word.get("ocr_evidence")
        if not isinstance(evidence, dict):
            continue

        # Validate geometry and image signal even when the full-line engines agree.
        # Agreement is not correctness and must not hide a clipped/invalid word box.
        crop, quality = crop_word_region(image, word.get("bbox"))
        bbox_validated += 1
        evidence["bbox_quality"] = quality.get("bbox_quality")
        evidence["crop_quality"] = quality.get("crop_quality")

        engine_agrees = evidence.get("alignment") == "match"
        if engine_agrees and quality.get("bbox_quality") == "valid" and quality.get("crop_quality") == "usable":
            evidence["crop_evidence"] = {
                **quality,
                "status": "not_needed",
                "reason": "engines_agree_but_agreement_is_not_verification",
                "score_semantics": "raw_recognition_output_not_probability",
            }
            continue

        if crop is None:
            if quality.get("bbox_quality") != "valid":
                rejected_bbox += 1
            else:
                rejected_quality += 1
            evidence["crop_evidence"] = {
                **quality, "status": "skipped",
                "score_semantics": "raw_recognition_output_not_probability",
            }
            continue
        if quality.get("crop_quality") != "usable":
            rejected_quality += 1
            evidence["crop_evidence"] = {
                **quality, "status": "skipped",
                "score_semantics": "raw_recognition_output_not_probability",
            }
            continue
        if len(prepared) >= MAX_SELECTIVE_WORD_CROPS_PER_PAGE:
            capped += 1
            evidence["crop_evidence"] = {
                **quality,
                "status": "skipped",
                "reason": "per_page_selective_crop_limit_reached",
                "score_semantics": "raw_recognition_output_not_probability",
            }
            continue
        prepared.append((evidence, crop, quality))

    paddle_failures = 0
    vietocr_failures = 0
    inference_calls = 0
    for evidence, _crop, quality in prepared:
        evidence["crop_evidence"] = {
            **quality, "status": "pending",
            "score_semantics": "raw_recognition_output_not_probability",
        }

    if prepared:
        crops = [item[1] for item in prepared]
        try:
            # PaddleOCR 2.7.x exposes recognition-only OCR with det=False.
            paddle_results = paddle_engine.ocr(crops, det=False, rec=True, cls=False)
            inference_calls += 1
            for index, (evidence, _crop, _quality) in enumerate(prepared):
                page_result = (
                    paddle_results[index]
                    if isinstance(paddle_results, list) and index < len(paddle_results)
                    else None
                )
                recognition = (
                    page_result[0]
                    if isinstance(page_result, (list, tuple)) and page_result
                    else None
                )
                candidate = (
                    recognition[0]
                    if isinstance(recognition, (list, tuple)) and recognition
                    else None
                )
                score = (
                    recognition[1]
                    if isinstance(recognition, (list, tuple)) and len(recognition) > 1
                    else None
                )
                crop_evidence = evidence["crop_evidence"]
                crop_evidence["paddleocr_candidate"] = (
                    unicodedata.normalize("NFC", candidate).strip()
                    if isinstance(candidate, str) else None
                )
                crop_evidence["paddle_crop_recognition_score"] = _raw_recognition_score(score)
        except Exception as exc:
            paddle_failures += 1
            logger.warning("Selective PaddleOCR recognition failed: %s", type(exc).__name__)
            for evidence, _crop, _quality in prepared:
                evidence["crop_evidence"]["paddle_error"] = type(exc).__name__

        try:
            pil_crops = [
                Image.fromarray(cv2.cvtColor(crop, cv2.COLOR_BGR2RGB))
                for crop in crops
            ]
            with torch.inference_mode():
                if callable(getattr(vietocr_engine, "predict_batch", None)):
                    try:
                        batch_result = vietocr_engine.predict_batch(
                            pil_crops, return_prob=True
                        )
                    except TypeError:
                        # Older/beam-search configurations may not expose probabilities.
                        batch_result = vietocr_engine.predict_batch(pil_crops)
                    inference_calls += 1
                    if isinstance(batch_result, tuple) and len(batch_result) >= 2:
                        predictions, scores = batch_result[0], batch_result[1]
                    else:
                        predictions = (
                            list(batch_result)
                            if isinstance(batch_result, (list, tuple))
                            else [batch_result]
                        )
                        scores = [None] * len(pil_crops)
                else:
                    predictions, scores = [], []
                    for pil_crop in pil_crops:
                        try:
                            prediction = vietocr_engine.predict(
                                pil_crop, return_prob=True
                            )
                        except TypeError:
                            prediction = vietocr_engine.predict(pil_crop)
                        if isinstance(prediction, tuple) and len(prediction) >= 2:
                            predictions.append(prediction[0])
                            scores.append(prediction[1])
                        else:
                            predictions.append(
                                prediction if isinstance(prediction, str) else None
                            )
                            scores.append(None)
                        inference_calls += 1
            for index, (evidence, _crop, _quality) in enumerate(prepared):
                prediction = predictions[index] if index < len(predictions) else None
                score = scores[index] if index < len(scores) else None
                crop_evidence = evidence["crop_evidence"]
                crop_evidence["vietocr_candidate"] = (
                    unicodedata.normalize("NFC", prediction).strip()
                    if isinstance(prediction, str) else None
                )
                crop_evidence["vietocr_crop_recognition_score"] = _raw_recognition_score(score)
                crop_evidence["status"] = "completed"
        except Exception as exc:
            vietocr_failures += 1
            logger.warning("Selective VietOCR recognition failed: %s", type(exc).__name__)
            for evidence, _crop, _quality in prepared:
                evidence["crop_evidence"]["status"] = "partial"
                evidence["crop_evidence"]["vietocr_error"] = type(exc).__name__

    return {
        "bbox_validated": bbox_validated,
        "requested": len(prepared) + rejected_bbox + rejected_quality + capped,
        "recognized": len(prepared),
        "rejected_bbox": rejected_bbox,
        "rejected_crop_quality": rejected_quality,
        "skipped_by_page_limit": capped,
        "inference_calls": inference_calls,
        "paddle_failures": paddle_failures,
        "vietocr_failures": vietocr_failures,
        "elapsed_ms": round((time.perf_counter() - started) * 1000, 2),
        "max_crops_per_page": MAX_SELECTIVE_WORD_CROPS_PER_PAGE,
    }


def _extract_text_and_boxes_dual_engine(
    image_bytes: bytes,
    paddle_engine: Any,
    vietocr_engine: Any,
) -> dict[str, object]:
    array = np.frombuffer(image_bytes, dtype=np.uint8)
    image = cv2.imdecode(array, cv2.IMREAD_COLOR)
    if image is None:
        raise ValueError("Image decoding failed")

    orig_height, orig_width = image.shape[:2]
    if orig_width <= 0 or orig_height <= 0:
        raise ValueError("Image dimensions are invalid")

    scale_factor = 1.0
    max_dim = max(orig_width, orig_height)
    if max_dim < 1500:
        scale_factor = min(2.5, 1500.0 / max_dim)
        scaled_w = int(round(orig_width * scale_factor))
        scaled_h = int(round(orig_height * scale_factor))
        proc_image = cv2.resize(image, (scaled_w, scaled_h), interpolation=cv2.INTER_CUBIC)
    else:
        proc_image = image

    try:
        ocr_res = paddle_engine.ocr(proc_image, cls=False)
    except Exception as exc:
        raise OcrEngineUnavailable(f"PaddleOCR xử lý hình ảnh thất bại: {exc}") from exc

    raw_items = ocr_res[0] if (ocr_res and ocr_res[0] is not None) else []
    if not raw_items:
        raise OcrNoTextDetected("PaddleOCR không phát hiện được chữ trên hình ảnh")

    if scale_factor > 1.01:
        for item in raw_items:
            item[0] = np.array(item[0], dtype=np.float32) / scale_factor

    ordered_items, layout_type = sort_reading_order_adaptive(
        raw_items, img_width=orig_width, image=image
    )
    if not ordered_items:
        raise OcrNoTextDetected("Không có dòng chữ khả dụng sau khi xử lý bố cục")

    words_output: list[dict[str, object]] = []
    lines_output: list[str] = []
    line_evidence: list[dict[str, object]] = []

    for line_idx, item in enumerate(ordered_items):
        paddle_text = item["paddle_text"]
        paddle_conf = item["paddle_conf"]
        dewarped_img = item["dewarped_img"]

        h_crop, w_crop = dewarped_img.shape[:2]
        if w_crop < 8 or h_crop < 8:
            continue

        if h_crop < 52:
            target_h = 56
            target_w = int(round(w_crop * (target_h / h_crop)))
            dewarped_img_scaled = cv2.resize(dewarped_img, (target_w, target_h), interpolation=cv2.INTER_CUBIC)
        else:
            dewarped_img_scaled = dewarped_img

        line_img_pil = Image.fromarray(cv2.cvtColor(dewarped_img_scaled, cv2.COLOR_BGR2RGB))
        chosen_text = paddle_text
        viet_text_candidate: str | None = None
        viet_text_used = False

        try:
            with torch.inference_mode():
                viet_text = vietocr_engine.predict(line_img_pil)
            if isinstance(viet_text, str):
                viet_text_candidate = viet_text.strip()
                if is_vietocr_reliable(
                    viet_text_candidate, paddle_text, paddle_conf=paddle_conf, max_cer=0.40
                ):
                    chosen_text = viet_text_candidate
                    viet_text_used = True
        except Exception:
            pass

        if viet_text_used:
            chosen_text = _transfer_punctuation(chosen_text, paddle_text)

        chosen_text = clean_ocr_punctuation(chosen_text)
        if not chosen_text:
            continue

        valid_words = [w for w in chosen_text.split() if normalize_word(w)]
        if not valid_words:
            continue

        line_boxes = _map_curved_word_boxes(valid_words, item, orig_width, orig_height)
        paddle_tokens = [w for w in paddle_text.split() if normalize_word(w)]
        vietocr_tokens = [
            w for w in (viet_text_candidate or "").split() if normalize_word(w)
        ]
        other_engine_tokens = paddle_tokens if viet_text_used else vietocr_tokens
        alignment = align_ocr_tokens(valid_words, other_engine_tokens)
        by_primary_index = {
            int(step["primary_index"]): step
            for step in alignment
            if step["primary_index"] is not None
        }
        line_index = len(lines_output)
        valid_line_confidence = None
        try:
            if not isinstance(paddle_conf, bool):
                candidate_line_score = float(paddle_conf)
                if np.isfinite(candidate_line_score) and 0 <= candidate_line_score <= 1:
                    valid_line_confidence = candidate_line_score
        except (TypeError, ValueError, OverflowError):
            pass
        alignment_operations = []
        for step in alignment:
            primary_index = step["primary_index"]
            secondary_index = step["secondary_index"]
            primary_token = (
                valid_words[int(primary_index)] if primary_index is not None else None
            )
            secondary_token = (
                other_engine_tokens[int(secondary_index)]
                if secondary_index is not None
                else None
            )
            alignment_operations.append({
                "operation": step["operation"],
                "paddle_token": secondary_token if viet_text_used else primary_token,
                "vietocr_token": primary_token if viet_text_used else secondary_token,
            })
        line_evidence.append({
            "line_index": line_index,
            "paddle_output": paddle_text,
            "vietocr_output": viet_text_candidate,
            "paddle_line_confidence": valid_line_confidence,
            "paddle_line_score_contract": PADDLE_LINE_SCORE_CONTRACT,
            "vietocr_output_used": viet_text_used,
            "selection_reason": (
                "vietocr_nonempty_nonrepetitive_provisional"
                if viet_text_used
                else "paddle_provisional_fallback_or_vietocr_rejected"
            ),
            "alignment_operations": alignment_operations,
            "split_merge_candidates": find_split_merge_candidates(
                paddle_tokens, vietocr_tokens
            ),
        })

        for w_idx, raw_token in enumerate(valid_words):
            step = by_primary_index.get(w_idx)
            secondary_index = (
                int(step["secondary_index"])
                if step is not None and step["secondary_index"] is not None
                else None
            )
            matched_other_token = (
                other_engine_tokens[secondary_index]
                if secondary_index is not None
                else None
            )
            agreement, review_status = _word_engine_evidence(
                raw_token, matched_other_token
            )
            operation = str(step["operation"]) if step is not None else "unmatched"
            if operation == "delete":
                operation = "unmatched"

            paddle_token = raw_token if not viet_text_used else matched_other_token
            vietocr_token = raw_token if viet_text_used else matched_other_token
            if operation == "insert":
                review_reason = "Engine còn lại có thêm token; hệ thống không ghép theo vị trí."
            elif operation == "unmatched":
                review_reason = "Không tìm thấy từ tương ứng đáng tin cậy ở engine còn lại."
            elif operation == "match":
                review_reason = "Hai engine trả về cùng token; điều này chưa xác minh từ có đúng không."
            else:
                review_reason = "Hai token đã căn chỉnh khác nhau; bất đồng chưa cho biết token nào đúng."

            norm_token = normalize_word(raw_token)
            words_output.append({
                "word_index": len(words_output),
                "line_index": len(lines_output),
                "text": raw_token,
                "normalized_text": norm_token,
                "bbox": line_boxes[w_idx],
                "ocr_confidence": None,
                "ocr_review_status": review_status,
                "ocr_score_source": None,
                "ocr_evidence": {
                    "contract": HYBRID_OCR_EVIDENCE_CONTRACT,
                    "engine_outputs": {
                        "paddleocr": paddle_token,
                        "vietocr": vietocr_token,
                    },
                    "alignment": operation,
                    "engine_agreement_score": agreement,
                    "calibrated_word_accuracy": None,
                    "verification_source": None,
                    "reference_text": None,
                    "selected_engine": "vietocr" if viet_text_used else "paddleocr",
                    "selection_reason": (
                        "vietocr_nonempty_nonrepetitive_provisional"
                        if viet_text_used
                        else "paddle_provisional_fallback_or_vietocr_rejected"
                    ),
                    "bbox_quality": "not_checked",
                    "crop_quality": None,
                    "crop_evidence": None,
                    "review_reason": review_reason,
                },
            })

        lines_output.append(" ".join(valid_words))

    if not words_output:
        raise OcrNoTextDetected("Dual-Engine không trích xuất được từ ngữ hợp lệ")

    crop_stats = _recognize_uncertain_word_crops(
        image, words_output, paddle_engine, vietocr_engine
    )
    formatted_text = "\n".join(lines_output)

    try:
        debug_vis = image.copy()
        for w in words_output:
            bx, by, bw, bh = w["bbox"]
            x1 = int(round(bx * orig_width))
            y1 = int(round(by * orig_height))
            x2 = int(round((bx + bw) * orig_width))
            y2 = int(round((by + bh) * orig_height))
            cv2.rectangle(debug_vis, (x1, y1), (x2, y2), (0, 255, 0), 1)
        debug_path = os.getenv("OCR_DEBUG_BOXES_PATH", "").strip()
        if debug_path:
            cv2.imwrite(os.path.abspath(debug_path), debug_vis)
    except Exception:
        pass

    return {
        "text": formatted_text,
        "words": words_output,
        "metadata": {
            "engine": "paddleocr_vietocr_dual",
            "engine_version": "PP-OCRv4 + VietOCR-vgg_transformer",
            "engine_versions": {
                "paddleocr": _package_version("paddleocr"),
                "vietocr": _package_version("vietocr"),
                "paddle_model": "PP-OCRv4",
                "vietocr_model": "vgg_transformer",
            },
            "preprocessing_version": OCR_PREPROCESSING_VERSION,
            "ocr_evidence_contract": HYBRID_OCR_EVIDENCE_CONTRACT,
            "ocr_score_contract": None,
            "language": "vi",
            "coordinate_space": "normalized_original_dimensions",
            "source_width": orig_width,
            "source_height": orig_height,
            "processed_width": orig_width,
            "processed_height": orig_height,
            "scale_factor": scale_factor,
            "word_count": len(words_output),
            "line_count": len(lines_output),
            "reading_layout": layout_type,
            "line_evidence": line_evidence,
            "selective_crop_stats": crop_stats,
        },
    }


def extract_text_and_boxes(image_bytes: bytes) -> dict[str, object]:
    """Chạy quy trình OCR: ưu tiên Dual-Engine, tự động fallback Tesseract cho CI/headless."""
    try:
        paddle_engine, vietocr_engine = _get_ocr_engines()
        return _extract_text_and_boxes_dual_engine(image_bytes, paddle_engine, vietocr_engine)
    except (OcrEngineUnavailable, OcrNoTextDetected):
        return _extract_text_and_boxes_tesseract(image_bytes)
    except Exception:
        try:
            return _extract_text_and_boxes_tesseract(image_bytes)
        except Exception:
            raise
