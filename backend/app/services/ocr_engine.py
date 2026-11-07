from __future__ import annotations

import logging
import os
from pathlib import Path
import re
import shutil
import tempfile
import threading
import unicodedata
from typing import Any

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
    v_clean = viet_text.strip()
    p_clean = paddle_text.strip()

    if not v_clean:
        return False

    words = v_clean.split()
    if len(words) >= 3:
        for i in range(len(words) - 2):
            if words[i].lower() == words[i + 1].lower() == words[i + 2].lower():
                return False

    if not p_clean or paddle_conf < 0.70 or len(v_clean) > 28:
        return True

    v_no_acc = strip_accents(v_clean)
    p_no_acc = strip_accents(p_clean)

    if len(p_no_acc) >= 4:
        cer_with_space = jiwer.cer(p_no_acc, v_no_acc)
        p_compact = re.sub(r"\s+", "", p_no_acc)
        v_compact = re.sub(r"\s+", "", v_no_acc)
        cer_compact = (
            jiwer.cer(p_compact, v_compact) if len(p_compact) >= 4 else 0.0
        )
        if min(cer_with_space, cer_compact) > max_cer:
            return False

    return True


_VIET_STOP_CONSONANTS = ("c", "ch", "p", "t")
_VIET_ILLEGAL_STOP_ACCENTS = re.compile(r"[àằầèềìòồờùừỳảẳẩẻểỉỏổởủửỷãẵẫẽễĩõỗỡũữỹ]", re.IGNORECASE)


def _evaluate_vietnamese_word_confidence(
    viet_word: str,
    matched_paddle_word: str | None,
    base_line_conf: float = 0.90,
) -> float:
    v_norm = normalize_word(viet_word)
    if not v_norm:
        return 0.50

    v_base = strip_accents(v_norm)

    if any(v_base.endswith(stop) for stop in _VIET_STOP_CONSONANTS):
        if _VIET_ILLEGAL_STOP_ACCENTS.search(v_norm):
            return 0.50

    if not matched_paddle_word:
        return round(base_line_conf, 4) if base_line_conf >= 0.80 else 0.75

    p_norm = normalize_word(matched_paddle_word)
    p_base = strip_accents(p_norm)

    # Khớp hoàn toàn cả từ hoặc trùng chữ cái gốc -> trả về đúng độ tin cậy base_line_conf
    if p_norm and (v_norm.lower() == p_norm.lower() or v_base == p_base):
        return round(base_line_conf, 4)

    if p_norm and jiwer.cer(v_base, p_base) <= 0.35:
        return 0.75

    return 0.50


def _find_best_matching_paddle_token(
    viet_word: str,
    paddle_tokens: list[str],
    current_idx: int,
    window_size: int = 3,
) -> str | None:
    if not paddle_tokens:
        return None

    v_norm = normalize_word(viet_word)
    v_base = strip_accents(v_norm)

    start = max(0, current_idx - window_size)
    end = min(len(paddle_tokens), current_idx + window_size + 1)
    candidates = paddle_tokens[start:end]

    for candidate in candidates:
        if normalize_word(candidate).lower() == v_norm.lower():
            return candidate

    for candidate in candidates:
        if strip_accents(normalize_word(candidate)) == v_base:
            return candidate

    for candidate in candidates:
        c_base = strip_accents(normalize_word(candidate))
        if c_base and v_base and abs(len(c_base) - len(v_base)) <= 1:
            if jiwer.cer(v_base, c_base) <= 0.35:
                return candidate

    return None


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
            p_conf = float(raw[1][1]) if (len(raw) > 1 and raw[1]) else 0.0
        except (TypeError, ValueError):
            p_conf = 0.0

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
            "language": target_lang,
            "word_count": len(words),
            "line_count": len(lines),
        },
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
        chosen_conf = paddle_conf
        viet_text_used = False

        try:
            with torch.inference_mode():
                viet_text = vietocr_engine.predict(line_img_pil)
            if isinstance(viet_text, str) and is_vietocr_reliable(
                viet_text, paddle_text, paddle_conf=paddle_conf, max_cer=0.40
            ):
                chosen_text = viet_text.strip()
                chosen_conf = paddle_conf
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

        for w_idx, raw_token in enumerate(valid_words):
            matched_p_token = _find_best_matching_paddle_token(
                raw_token, paddle_tokens, w_idx, window_size=3
            )

            norm_token = normalize_word(raw_token)
            word_conf = _evaluate_vietnamese_word_confidence(
                raw_token, matched_p_token, base_line_conf=paddle_conf
            )

            words_output.append({
                "word_index": len(words_output),
                "line_index": len(lines_output),
                "text": raw_token,
                "normalized_text": norm_token,
                "bbox": line_boxes[w_idx],
                "ocr_confidence": round(word_conf, 4),
            })

        lines_output.append(" ".join(valid_words))

    if not words_output:
        raise OcrNoTextDetected("Dual-Engine không trích xuất được từ ngữ hợp lệ")

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
