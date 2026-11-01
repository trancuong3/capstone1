from __future__ import annotations

import os
import re
import threading
import unicodedata
from typing import Any

# Ngăn chặn xung đột OpenMP runtime giữa PyTorch và PaddlePaddle
os.environ["KMP_DUPLICATE_LIB_OK"] = "TRUE"

import PIL.Image

if not hasattr(PIL.Image, "ANTIALIAS"):
    PIL.Image.ANTIALIAS = PIL.Image.Resampling.LANCZOS

import cv2
import jiwer
import numpy as np
import torch
from paddleocr import PaddleOCR
from PIL import Image
from vietocr.tool.config import Cfg
from vietocr.tool.predictor import Predictor


class OcrEngineUnavailable(RuntimeError):
    """Mô hình PaddleOCR hoặc VietOCR không khả dụng hoặc chưa được cấu hình."""


class OcrNoTextDetected(RuntimeError):
    """Hình ảnh hợp lệ nhưng hệ thống không phát hiện được chữ tiếng Việt khả dụng."""


def normalize_word(value: str) -> str:
    """Chuẩn hóa tiếng Việt canonical dùng chung cho OCR output và review words."""
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
    """Phân tách chuỗi thành danh sách token từ đã chuẩn hóa."""
    return [
        token
        for raw in re.split(r"\s+", unicodedata.normalize("NFC", value).strip())
        if (token := normalize_word(raw))
    ]


# =============================================================================
# Quản lý khởi tạo Dual-Engine Singleton (PaddleOCR + VietOCR)
# =============================================================================
_paddle_engine: PaddleOCR | None = None
_vietocr_engine: Predictor | None = None
_engine_lock = threading.Lock()


def _get_ocr_engines() -> tuple[PaddleOCR, Predictor]:
    """Khởi tạo và lưu cache trọng số mô hình vào RAM một lần duy nhất (Thread-safe)."""
    global _paddle_engine, _vietocr_engine
    if _paddle_engine is not None and _vietocr_engine is not None:
        return _paddle_engine, _vietocr_engine

    with _engine_lock:
        if _paddle_engine is not None and _vietocr_engine is not None:
            return _paddle_engine, _vietocr_engine

        try:
            paddle_inst = PaddleOCR(
                use_angle_cls=False,
                lang="vi",
                det_limit_side_len=2048,
                det_db_thresh=0.25,
                det_db_box_thresh=0.18,      # Bắt trọn vẹn các dòng bị cong vòm ở giữa trang sách
                det_db_unclip_ratio=1.32,
                det_db_score_mode="slow",    # Chấm điểm theo đa giác thực tế thay vì khung chữ nhật
                drop_score=0.0,              # Giữ lại toàn bộ các dòng dài cho VietOCR xử lý
                show_log=False,
            )

            viet_config = Cfg.load_config_from_name("vgg_transformer")
            target_device = "cuda" if torch.cuda.is_available() else "cpu"
            viet_config["device"] = target_device
            viet_inst = Predictor(viet_config)

            _paddle_engine = paddle_inst
            _vietocr_engine = viet_inst
        except Exception as exc:
            raise OcrEngineUnavailable(
                f"Không thể khởi tạo engine PaddleOCR / VietOCR: {exc}"
            ) from exc

    return _paddle_engine, _vietocr_engine


# =============================================================================
# Các thuật toán thị giác, khử độ cong vòm (Parabolic Dewarping) & Layout
# =============================================================================
def strip_accents(text: str) -> str:
    """Loại bỏ dấu tiếng Việt, đưa về ký tự ASCII thường để kiểm định ngữ âm."""
    text = unicodedata.normalize("NFD", text)
    text = re.sub(r"[\u0300-\u036f]", "", text)
    text = text.replace("đ", "d").replace("Đ", "D")
    return re.sub(r"[^a-zA-Z0-9\s]", "", text).lower().strip()


def clean_ocr_punctuation(text: str) -> str:
    """Chuẩn hóa tất định các lỗi nhận diện dấu câu."""
    text = re.sub(r'(^|\s)\?(?=[A-ZÀ-Ỹa-zà-ỹ])', r'\1"', text)
    text = re.sub(r'\.{2,3}3[\?\"]*', '...?"', text)
    return text.strip()


def is_vietocr_reliable(
    viet_text: str,
    paddle_text: str,
    paddle_conf: float = 0.90,
    max_cer: float = 0.35,
) -> bool:
    """Kiểm tra độ tin cậy của VietOCR và chống ảo giác lặp từ."""
    v_clean = viet_text.strip()
    p_clean = paddle_text.strip()

    if not v_clean:
        return False

    words = v_clean.split()
    if len(words) >= 3:
        for i in range(len(words) - 2):
            if words[i].lower() == words[i + 1].lower() == words[i + 2].lower():
                return False

    if not p_clean or paddle_conf < 0.75 or len(v_clean) > 28:
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


def _order_quad_points(pts: np.ndarray) -> np.ndarray:
    """Đảm bảo 4 đỉnh tứ giác luôn theo đúng thứ tự: [top-left, top-right, bottom-right, bottom-left]."""
    pts = np.array(pts, dtype=np.float32)
    x_sorted = pts[np.argsort(pts[:, 0])]
    left_pts = x_sorted[:2]
    right_pts = x_sorted[2:]
    tl, bl = left_pts[np.argsort(left_pts[:, 1])]
    tr, br = right_pts[np.argsort(right_pts[:, 1])]
    return np.array([tl, tr, br, bl], dtype=np.float32)


def _fit_single_line_parabola(
    binary_band: np.ndarray, target_h: float
) -> np.ndarray:
    """Tìm đường tâm Parabol v_c(u) bám theo vệt mực của dòng chữ bị cong vòm."""
    b_h, b_w = binary_band.shape[:2]
    u_coords = np.arange(b_w, dtype=np.float32)
    if b_w < 40 or b_h < 8:
        return np.full(b_w, b_h / 2.0, dtype=np.float32)

    win_h = max(6, min(b_h - 1, int(round(target_h * 0.90))))
    if win_h >= b_h - 2:
        return np.full(b_w, b_h / 2.0, dtype=np.float32)

    num_slices = min(14, max(5, b_w // 60))
    slice_edges = np.linspace(0, b_w, num_slices + 1, dtype=int)

    valid_u: list[float] = []
    valid_v: list[float] = []

    for s in range(num_slices):
        u0, u1 = slice_edges[s], slice_edges[s + 1]
        if u1 - u0 < 4:
            continue
        col_slice = (binary_band[:, u0:u1] > 0).astype(np.float32)
        row_prof = np.sum(col_slice, axis=1)
        total_ink = float(np.sum(row_prof))
        if total_ink < (u1 - u0) * 0.6:
            continue

        # Trượt cửa sổ chiều cao win_h để tìm dải có mật độ mực lớn nhất (loại bỏ nhiễu dòng lân cận)
        window_sums = np.convolve(
            row_prof, np.ones(win_h, dtype=np.float32), mode="valid"
        )
        best_top = int(np.argmax(window_sums))
        sub_prof = row_prof[best_top : best_top + win_h]
        sub_sum = float(np.sum(sub_prof))
        if sub_sum > 0:
            rows_idx = np.arange(best_top, best_top + win_h, dtype=np.float32)
            v_center = float(np.sum(rows_idx * sub_prof) / sub_sum)
        else:
            v_center = best_top + win_h / 2.0

        valid_u.append((u0 + u1) / 2.0)
        valid_v.append(v_center)

    if len(valid_u) >= 3:
        deg = 2 if len(valid_u) >= 4 else 1
        coeffs = np.polyfit(
            np.array(valid_u, dtype=np.float32),
            np.array(valid_v, dtype=np.float32),
            deg=deg,
        )
        v_curve = np.polyval(coeffs, u_coords).astype(np.float32)
        half_band = max(3.0, target_h * 0.35)
        return np.clip(v_curve, half_band, max(half_band, b_h - half_band))
    elif len(valid_u) >= 1:
        return np.full(b_w, float(np.median(valid_v)), dtype=np.float32)

    return np.full(b_w, b_h / 2.0, dtype=np.float32)


def _dewarp_strip_along_curve(
    rect_img: np.ndarray, v_curve: np.ndarray, strip_h: int
) -> np.ndarray:
    """Cắt và nắn phẳng hoàn toàn dòng chữ dọc theo đường cong v_curve(u)."""
    crop_h, crop_w = rect_img.shape[:2]
    strip_h = max(12, int(strip_h))
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
    return cv2.copyMakeBorder(
        dewarped,
        top=4,
        bottom=4,
        left=4,
        right=4,
        borderType=cv2.BORDER_CONSTANT,
        value=[255, 255, 255],
    )


def _estimate_block_arch_offsets(
    binary: np.ndarray, ref_h: float
) -> np.ndarray:
    """Ước lượng độ cong vòm cho khối bị dính nhiều dòng bằng tương quan chéo các lát cắt dọc."""
    c_h, c_w = binary.shape[:2]
    if c_w < 80 or c_h < 20:
        return np.zeros(c_w, dtype=np.float32)

    num_slices = min(12, max(5, c_w // 70))
    edges = np.linspace(0, c_w, num_slices + 1, dtype=int)
    profiles: list[np.ndarray] = []
    centers_u: list[float] = []

    for s in range(num_slices):
        u0, u1 = edges[s], edges[s + 1]
        prof = np.sum(binary[:, u0:u1] > 0, axis=1).astype(np.float32)
        prof = np.convolve(prof, np.ones(3, dtype=np.float32) / 3.0, mode="same")
        profiles.append(prof)
        centers_u.append((u0 + u1) / 2.0)

    mid = num_slices // 2
    shifts = np.zeros(num_slices, dtype=np.float32)
    max_step = max(3, min(8, int(ref_h * 0.25)))

    def best_delta(prof_ref: np.ndarray, prof_cur: np.ndarray) -> float:
        if np.sum(prof_ref) < 5 or np.sum(prof_cur) < 5:
            return 0.0
        best_d = 0
        best_val = -1.0
        for d in range(-max_step, max_step + 1):
            if d < 0:
                val = float(np.dot(prof_ref[:d], prof_cur[-d:]))
            elif d > 0:
                val = float(np.dot(prof_ref[d:], prof_cur[:-d]))
            else:
                val = float(np.dot(prof_ref, prof_cur))
            if val > best_val:
                best_val = val
                best_d = d
        return float(best_d)

    for s in range(mid - 1, -1, -1):
        shifts[s] = shifts[s + 1] + best_delta(profiles[s + 1], profiles[s])
    for s in range(mid + 1, num_slices):
        shifts[s] = shifts[s - 1] + best_delta(profiles[s - 1], profiles[s])

    u_all = np.arange(c_w, dtype=np.float32)
    coeffs = np.polyfit(np.array(centers_u, dtype=np.float32), shifts, deg=2)
    arch = np.polyval(coeffs, u_all).astype(np.float32)
    arch -= float(np.median(arch))
    return np.clip(arch, -ref_h * 1.2, ref_h * 1.2)


def _extract_curved_lines_from_items(
    raw_items: list, image: np.ndarray
) -> list[dict[str, Any]]:
    """Chuyển đổi các box thô của DBNet thành danh sách các dòng đơn đã khử cong và tách dòng dính."""
    if not raw_items:
        return []

    temp_items = []
    perp_heights = []
    for raw in raw_items:
        pts = _order_quad_points(raw[0])
        p_text = str(raw[1][0]) if (len(raw) > 1 and raw[1]) else ""
        try:
            p_conf = float(raw[1][1]) if (len(raw) > 1 and raw[1]) else 0.0
        except (TypeError, ValueError):
            p_conf = 0.0

        crop_w = int(
            max(
                np.linalg.norm(pts[0] - pts[1]),
                np.linalg.norm(pts[2] - pts[3]),
            )
        )
        crop_h = int(
            max(
                np.linalg.norm(pts[0] - pts[3]),
                np.linalg.norm(pts[1] - pts[2]),
            )
        )
        if crop_w < 8 or crop_h < 8:
            continue

        temp_items.append((pts, crop_w, crop_h, p_text, p_conf))
        if crop_w >= 45 and crop_h >= 10:
            perp_heights.append(float(crop_h))

    if not temp_items:
        return []

    ref_h = float(np.percentile(perp_heights, 35)) if perp_heights else 28.0
    ref_h = max(12.0, ref_h)

    extracted: list[dict[str, Any]] = []

    for pts, crop_w, crop_h, p_text, p_conf in temp_items:
        pts_std = np.float32(
            [[0, 0], [crop_w, 0], [crop_w, crop_h], [0, crop_h]]
        )
        matrix = cv2.getPerspectiveTransform(pts, pts_std)
        rect_img = cv2.warpPerspective(
            image,
            matrix,
            (crop_w, crop_h),
            borderMode=cv2.BORDER_REPLICATE,
            flags=cv2.INTER_CUBIC,
        )

        gray = cv2.cvtColor(rect_img, cv2.COLOR_BGR2GRAY)
        block_sz = max(15, int(ref_h) | 1)
        binary = cv2.adaptiveThreshold(
            gray,
            255,
            cv2.ADAPTIVE_THRESH_GAUSSIAN_C,
            cv2.THRESH_BINARY_INV,
            block_sz,
            10,
        )

        # Kiểm tra nếu box bị dính nhiều dòng (chiều cao vuông góc > 1.72 lần dòng chuẩn)
        is_multiline = (crop_h > ref_h * 1.72) and (crop_w > ref_h * 2.2)
        bands: list[tuple[int, int, np.ndarray]] = []

        if is_multiline:
            num_est = min(8, max(2, int(round(crop_h / ref_h))))
            arch_off = _estimate_block_arch_offsets(binary, ref_h)

            # Khử độ cong vòm trên ảnh nhị phân để tìm thung lũng tách dòng chính xác
            u_grid = np.broadcast_to(
                np.arange(crop_w, dtype=np.float32)[None, :], (crop_h, crop_w)
            ).copy()
            v_grid = np.clip(
                np.arange(crop_h, dtype=np.float32)[:, None] + arch_off[None, :],
                0.0,
                float(crop_h - 1),
            ).astype(np.float32)
            bin_flat = cv2.remap(
                binary, u_grid, v_grid, interpolation=cv2.INTER_NEAREST
            )

            h_proj = np.sum(bin_flat > 0, axis=1).astype(np.float32)
            k_sz = max(3, int(ref_h * 0.15) | 1)
            h_smooth = np.convolve(
                h_proj, np.ones(k_sz, dtype=np.float32) / k_sz, mode="same"
            )
            p75_ink = float(np.percentile(h_smooth, 75)) if len(h_smooth) else 1.0

            cuts = [0]
            step = crop_h / num_est
            s_rad = max(4, int(step * 0.35))
            valid_split = True
            for k in range(1, num_est):
                exp_v = int(round(k * step))
                low_v = max(cuts[-1] + int(ref_h * 0.55), exp_v - s_rad)
                high_v = min(crop_h - int(ref_h * 0.55), exp_v + s_rad)
                if low_v < high_v:
                    best_v = low_v + int(np.argmin(h_smooth[low_v:high_v]))
                    if h_smooth[best_v] > p75_ink * 0.68:
                        valid_split = False
                        break
                    cuts.append(best_v)
                else:
                    valid_split = False
                    break
            cuts.append(crop_h)

            if valid_split and len(cuts) == num_est + 1:
                for k in range(num_est):
                    v0, v1 = cuts[k], cuts[k + 1]
                    v_center_flat = (v0 + v1) / 2.0
                    v_curve_k = np.clip(
                        v_center_flat + arch_off, 2.0, float(crop_h - 2)
                    )
                    bands.append((v0, v1, v_curve_k))

        if not bands:
            # Dòng đơn: khớp trực tiếp Parabol theo vệt mực chính
            v_curve = _fit_single_line_parabola(binary, min(float(crop_h), ref_h * 1.15))
            bands.append((0, crop_h, v_curve))

        tl, tr, br, bl = pts[0], pts[1], pts[2], pts[3]
        split_count = len(bands)

        for v0, v1, v_curve in bands:
            band_h = float(v1 - v0) if split_count > 1 else min(float(crop_h), ref_h * 1.18)
            strip_h = int(round(max(12.0, band_h * 1.18)))
            dewarped_img = _dewarp_strip_along_curve(rect_img, v_curve, strip_h)

            # Tính đường cong tọa độ (X, Y) trên ảnh gốc tại 9 điểm mốc ngang
            sample_rxs = np.linspace(0.0, 1.0, 9, dtype=np.float32)
            sample_us = np.clip(
                (sample_rxs * (crop_w - 1)).astype(int), 0, crop_w - 1
            )
            sample_rys = v_curve[sample_us] / max(1.0, float(crop_h))

            curve_xs = []
            curve_ys = []
            for rx, ry in zip(sample_rxs, sample_rys):
                top_pt = tl + rx * (tr - tl)
                bot_pt = bl + rx * (br - bl)
                orig_pt = top_pt + ry * (bot_pt - top_pt)
                curve_xs.append(float(orig_pt[0]))
                curve_ys.append(float(orig_pt[1]))

            xmin = float(min(curve_xs))
            xmax = float(max(curve_xs))
            yc_mid = float(curve_ys[4])
            ymin = yc_mid - band_h * 0.5
            ymax = yc_mid + band_h * 0.5

            extracted.append(
                {
                    "quad": pts,
                    "crop_w": crop_w,
                    "crop_h": crop_h,
                    "v_curve": v_curve,
                    "band_h": band_h,
                    "dewarped_img": dewarped_img,
                    "paddle_text": p_text if split_count == 1 else "",
                    "paddle_conf": p_conf if split_count == 1 else 0.0,
                    "curve_xs": np.array(curve_xs, dtype=np.float32),
                    "curve_ys": np.array(curve_ys, dtype=np.float32),
                    "xmin": xmin,
                    "xmax": xmax,
                    "ymin": ymin,
                    "ymax": ymax,
                    "w": max(1.0, xmax - xmin),
                    "h": max(1.0, band_h),
                    "xc": (xmin + xmax) / 2.0,
                    "yc": yc_mid,
                }
            )

    return extracted


def _deduplicate_curved_lines(
    items: list[dict[str, Any]],
) -> list[dict[str, Any]]:
    """Chỉ loại bỏ các dòng thực sự trùng lên nhau tại cùng hoành độ X, bảo toàn 100% các dòng lân cận."""
    if len(items) <= 1:
        return items

    sorted_items = sorted(items, key=lambda it: it["w"], reverse=True)
    kept: list[dict[str, Any]] = []

    for it in sorted_items:
        is_dup = False
        for k in kept:
            ox0 = max(it["xmin"], k["xmin"])
            ox1 = min(it["xmax"], k["xmax"])
            if ox1 <= ox0:
                continue

            overlap_w = ox1 - ox0
            min_w = max(1.0, min(it["w"], k["w"]))
            if (overlap_w / min_w) < 0.35:
                continue

            # Nội suy tâm Y của 2 dòng tại đúng hoành độ giữa vùng giao nhau x_mid
            x_mid = (ox0 + ox1) / 2.0
            y_it = float(np.interp(x_mid, it["curve_xs"], it["curve_ys"]))
            y_k = float(np.interp(x_mid, k["curve_xs"], k["curve_ys"]))
            min_h = max(8.0, min(it["h"], k["h"]))

            if abs(y_it - y_k) < 0.48 * min_h:
                is_dup = True
                break

        if not is_dup:
            kept.append(it)

    return kept


def sort_reading_order_adaptive(
    raw_items: list, img_width: int, image: np.ndarray
) -> tuple[list[dict[str, Any]], str]:
    """Phân loại bố cục và sắp xếp thứ tự đọc tự nhiên."""
    items = _extract_curved_lines_from_items(raw_items, image)
    if not items:
        return [], "empty"

    items = _deduplicate_curved_lines(items)
    widths = [it["w"] for it in items]
    p75_w = float(np.percentile(widths, 75)) if widths else 0.0
    is_single_column = (p75_w / max(1.0, float(img_width))) >= 0.35

    # Nhánh 1: Sách in / Giáo trình đơn cột
    if is_single_column:
        clean_items = []
        for it in items:
            is_edge_noise = (
                it["xmin"] <= 15 or it["xmax"] >= (img_width - 15)
            ) and it["w"] < 45.0
            if not is_edge_noise and it["w"] >= 12.0 and it["h"] >= 8.0:
                clean_items.append(it)

        clean_items.sort(key=lambda it: it["yc"])
        return clean_items, "single_column"

    # Nhánh 2: Truyện tranh / Bố cục đa bóng thoại
    items.sort(key=lambda it: it["yc"])
    blocks: list[dict[str, Any]] = []
    for item in items:
        matched_block = None
        for b in blocks:
            last_it = b["items"][-1]
            overlap_last = max(
                0.0,
                min(item["xmax"], last_it["xmax"])
                - max(item["xmin"], last_it["xmin"]),
            )
            overlap_block = max(
                0.0,
                min(item["xmax"], b["xmax"]) - max(item["xmin"], b["xmin"]),
            )
            ratio_last = overlap_last / max(1.0, min(item["w"], last_it["w"]))
            ratio_block = overlap_block / max(1.0, min(item["w"], b["w"]))

            yc_dist = item["yc"] - last_it["yc"]
            avg_h = (item["h"] + last_it["h"]) / 2.0

            v_ok = 0.12 * avg_h <= yc_dist <= 1.75 * avg_h
            h_ok = (
                (ratio_last >= 0.20)
                or (ratio_block >= 0.30)
                or (abs(item["xc"] - b["xc"]) < max(item["w"], b["w"]) * 0.42)
            )

            if v_ok and h_ok:
                matched_block = b
                break

        if matched_block is not None:
            matched_block["items"].append(item)
            matched_block["xmin"] = min(matched_block["xmin"], item["xmin"])
            matched_block["xmax"] = max(matched_block["xmax"], item["xmax"])
            matched_block["ymin"] = min(matched_block["ymin"], item["ymin"])
            matched_block["ymax"] = max(matched_block["ymax"], item["ymax"])
            matched_block["w"] = matched_block["xmax"] - matched_block["xmin"]
            matched_block["xc"] = (
                matched_block["xmin"] + matched_block["xmax"]
            ) / 2.0
            matched_block["yc"] = (
                matched_block["ymin"] + matched_block["ymax"]
            ) / 2.0
        else:
            blocks.append(
                {
                    "items": [item],
                    "xmin": item["xmin"],
                    "xmax": item["xmax"],
                    "ymin": item["ymin"],
                    "ymax": item["ymax"],
                    "w": item["w"],
                    "xc": item["xc"],
                    "yc": item["yc"],
                }
            )

    blocks.sort(key=lambda b: (b["ymin"], b["xmin"]))
    tiers: list[dict[str, Any]] = []
    for b in blocks:
        placed = False
        b_h = max(1.0, b["ymax"] - b["ymin"])
        for tier in tiers:
            t_h = max(1.0, tier["ymax"] - tier["ymin"])
            overlap_y = max(
                0.0,
                min(b["ymax"], tier["ymax"]) - max(b["ymin"], tier["ymin"]),
            )
            min_h = min(b_h, t_h)

            if (overlap_y / min_h) > 0.25:
                tier["blocks"].append(b)
                tier["ymin"] = min(tier["ymin"], b["ymin"])
                tier["ymax"] = max(tier["ymax"], b["ymax"])
                placed = True
                break

        if not placed:
            tiers.append(
                {"ymin": b["ymin"], "ymax": b["ymax"], "blocks": [b]}
            )

    tiers.sort(key=lambda t: t["ymin"])
    final_ordered = []
    for tier in tiers:
        tier["blocks"].sort(key=lambda b: b["xmin"])
        for b in tier["blocks"]:
            b["items"].sort(key=lambda it: it["yc"])
            final_ordered.extend(b["items"])

    return final_ordered, "comic_panels"


# =============================================================================
# Thuật toán phân đoạn từ quang học và gắn hộp bám theo đường cong Parabol
# =============================================================================
def _char_weight(ch: str) -> float:
    """Trọng số độ rộng ký tự theo phông chữ tỷ lệ (Proportional Typography)."""
    ch_lower = ch.lower()
    if ch_lower in "mw":
        return 1.38
    if ch_lower in "ijlrtf1.,;:!'|()[]":
        return 0.52
    if ch.isupper():
        return 1.22
    return 1.0


def _segment_words_optically_1d(
    dewarped_img: np.ndarray, words: list[str]
) -> list[tuple[float, float]]:
    """Xác định biên độ ngang (x0_r, x1_r) của từng từ trên dòng đã được khử cong."""
    num_words = len(words)
    if num_words == 0:
        return []

    h_full, w_full = dewarped_img.shape[:2]
    pad = 4 if (w_full > 16 and h_full > 16) else 0
    content = (
        dewarped_img[pad : h_full - pad, pad : w_full - pad]
        if pad
        else dewarped_img
    )
    c_h, c_w = content.shape[:2]

    word_weights = [
        max(0.6, sum(_char_weight(c) for c in w_text)) for w_text in words
    ]
    space_weight = 0.75
    total_w = sum(word_weights) + (num_words - 1) * space_weight

    def fallback_spans() -> list[tuple[float, float]]:
        spans = []
        curr = 0.0
        for ww in word_weights:
            w_frac = ww / total_w
            spans.append((curr, min(1.0, curr + w_frac)))
            curr += w_frac + (space_weight / total_w)
        return spans

    if c_w < 16 or c_h < 8:
        return fallback_spans()

    gray = cv2.cvtColor(content, cv2.COLOR_BGR2GRAY)
    block_sz = max(11, (c_h | 1))
    binary = cv2.adaptiveThreshold(
        gray,
        255,
        cv2.ADAPTIVE_THRESH_GAUSSIAN_C,
        cv2.THRESH_BINARY_INV,
        block_sz,
        10,
    )

    # Chỉ chiếu mật độ mực ở vùng lõi giữa dòng (từ 15% đến 85% chiều cao) để tránh hoàn toàn rìa dòng khác
    r0 = max(0, int(c_h * 0.15))
    r1 = min(c_h, max(r0 + 4, int(c_h * 0.85)))
    core_band = binary[r0:r1, :]
    core_h = core_band.shape[0]

    v_proj = np.sum(core_band > 0, axis=0).astype(np.float32)
    ink_thresh = max(1.0, core_h * 0.05)
    has_ink = v_proj > ink_thresh

    ink_cols = np.where(has_ink)[0]
    if len(ink_cols) < 4:
        return fallback_spans()

    first_ink = int(ink_cols[0])
    last_ink = int(ink_cols[-1])
    active_w = last_ink - first_ink + 1
    if active_w < 10:
        return fallback_spans()

    if num_words == 1:
        return [
            (
                max(0.0, float(first_ink - 1) / c_w),
                min(1.0, float(last_ink + 2) / c_w),
            )
        ]

    valleys: list[tuple[float, int, int, int]] = []
    in_gap = False
    g_start = first_ink
    for x in range(first_ink, last_ink + 1):
        if not has_ink[x]:
            if not in_gap:
                in_gap = True
                g_start = x
        else:
            if in_gap:
                in_gap = False
                g_end = x
                g_len = g_end - g_start
                if g_len >= 1:
                    g_center = (g_start + g_end) / 2.0
                    valleys.append((g_center, g_start, g_end, g_len))

    cum_weights = []
    acc = 0.0
    for i in range(num_words - 1):
        acc += word_weights[i]
        cum_weights.append((acc + i * space_weight + 0.5 * space_weight) / total_w)

    cut_boundaries: list[tuple[int, int]] = []
    prev_end = first_ink
    avg_word_px = active_w / num_words
    search_tol = max(6.0, avg_word_px * 0.55)

    for idx, expected_ratio in enumerate(cum_weights):
        expected_x = first_ink + expected_ratio * active_w
        remaining_words = num_words - 1 - idx
        max_allowed_x = last_ink - remaining_words * 3

        best_valley = None
        best_score = 1e9
        for v_center, v_start, v_end, v_len in valleys:
            if v_start <= prev_end + 1 or v_end >= max_allowed_x:
                continue
            dist = abs(v_center - expected_x)
            if dist <= search_tol:
                score = dist - (v_len * 1.8)
                if score < best_score:
                    best_score = score
                    best_valley = (v_start, v_end)

        if best_valley is not None:
            cut_boundaries.append(best_valley)
            prev_end = best_valley[1]
        else:
            s_left = max(prev_end + 2, int(expected_x - search_tol * 0.5))
            s_right = min(max_allowed_x, int(expected_x + search_tol * 0.5))
            if s_left < s_right:
                min_col = s_left + int(np.argmin(v_proj[s_left:s_right]))
            else:
                min_col = max(prev_end + 1, min(max_allowed_x, int(expected_x)))
            cut_boundaries.append((min_col, min_col + 1))
            prev_end = min_col + 1

    word_raw_intervals: list[tuple[int, int]] = []
    curr_s = first_ink
    for g_s, g_e in cut_boundaries:
        word_raw_intervals.append((curr_s, max(curr_s + 1, g_s)))
        curr_s = g_e
    word_raw_intervals.append((curr_s, max(curr_s + 1, last_ink + 1)))

    final_spans: list[tuple[float, float]] = []
    for w_s, w_e in word_raw_intervals:
        sub_ink = np.where(has_ink[w_s:w_e])[0]
        if len(sub_ink) >= 1:
            tight_s = max(0, w_s + int(sub_ink[0]) - 1)
            tight_e = min(c_w, w_s + int(sub_ink[-1]) + 2)
        else:
            tight_s, tight_e = w_s, w_e

        x0_r = max(0.0, float(tight_s) / c_w)
        x1_r = min(1.0, float(tight_e) / c_w)
        if x1_r <= x0_r:
            x1_r = min(1.0, x0_r + 0.01)

        final_spans.append((x0_r, x1_r))

    return final_spans


def _map_curved_word_boxes(
    words: list[str],
    item: dict[str, Any],
    orig_width: int,
    orig_height: int,
) -> list[list[float]]:
    """Ánh xạ từng từ bám theo đúng đường cong Parabol v_curve(u) trên trang ảnh gốc."""
    if not words:
        return []

    dewarped_img = item["dewarped_img"]
    pts = item["quad"]
    crop_w = item["crop_w"]
    crop_h = max(1, item["crop_h"])
    v_curve = item["v_curve"]
    band_h = item["band_h"]

    tl, tr, br, bl = pts[0], pts[1], pts[2], pts[3]
    spans = _segment_words_optically_1d(dewarped_img, words)

    boxes: list[list[float]] = []
    half_h = max(4.0, band_h * 0.46)

    for x0_r, x1_r in spans:
        x_mid_r = (x0_r + x1_r) / 2.0
        u_mid = int(np.clip(round(x_mid_r * (crop_w - 1)), 0, crop_w - 1))
        v_center = float(v_curve[u_mid])

        ry_top = max(0.0, (v_center - half_h) / crop_h)
        ry_bot = min(1.0, (v_center + half_h) / crop_h)

        # Chiếu 4 góc của từ từ hệ quy chiếu uốn cong về ảnh gốc
        top_l = (tl + x0_r * (tr - tl)) + ry_top * (
            (bl + x0_r * (br - bl)) - (tl + x0_r * (tr - tl))
        )
        top_r = (tl + x1_r * (tr - tl)) + ry_top * (
            (bl + x1_r * (br - bl)) - (tl + x1_r * (tr - tl))
        )
        bot_l = (tl + x0_r * (tr - tl)) + ry_bot * (
            (bl + x0_r * (br - bl)) - (tl + x0_r * (tr - tl))
        )
        bot_r = (tl + x1_r * (tr - tl)) + ry_bot * (
            (bl + x1_r * (br - bl)) - (tl + x1_r * (tr - tl))
        )

        word_xmin = float(min(top_l[0], bot_l[0]))
        word_xmax = float(max(top_r[0], bot_r[0]))
        word_ymin = float((top_l[1] + top_r[1]) / 2.0)
        word_ymax = float((bot_l[1] + bot_r[1]) / 2.0)

        norm_x = word_xmin / orig_width
        norm_y = word_ymin / orig_height
        norm_w = max(1.0, word_xmax - word_xmin) / orig_width
        norm_h = max(1.0, word_ymax - word_ymin) / orig_height

        norm_x = max(0.0, min(0.9999, norm_x))
        norm_y = max(0.0, min(0.9999, norm_y))
        norm_w = max(0.0001, min(1.0 - norm_x, norm_w))
        norm_h = max(0.0001, min(1.0 - norm_y, norm_h))

        boxes.append(
            [
                round(norm_x, 6),
                round(norm_y, 6),
                round(norm_w, 6),
                round(norm_h, 6),
            ]
        )

    return boxes


# =============================================================================
# Hàm Public Service: extract_text_and_boxes
# =============================================================================
def extract_text_and_boxes(image_bytes: bytes) -> dict[str, object]:
    """Chạy quy trình OCR kết hợp Dual-Engine (PaddleOCR DBNet + VietOCR Transformer)."""
    paddle_engine, vietocr_engine = _get_ocr_engines()

    array = np.frombuffer(image_bytes, dtype=np.uint8)
    image = cv2.imdecode(array, cv2.IMREAD_COLOR)
    if image is None:
        raise ValueError("Image decoding failed")

    orig_height, orig_width = image.shape[:2]
    if orig_width <= 0 or orig_height <= 0:
        raise ValueError("Image dimensions are invalid")

    try:
        ocr_res = paddle_engine.ocr(image, cls=False)
    except Exception as exc:
        raise OcrEngineUnavailable(
            f"PaddleOCR xử lý hình ảnh thất bại: {exc}"
        ) from exc

    raw_items = ocr_res[0] if (ocr_res and ocr_res[0] is not None) else []
    if not raw_items:
        raise OcrNoTextDetected(
            "PaddleOCR không phát hiện được chữ trên hình ảnh"
        )

    ordered_items, layout_type = sort_reading_order_adaptive(
        raw_items, img_width=orig_width, image=image
    )
    if not ordered_items:
        raise OcrNoTextDetected(
            "Không có dòng chữ khả dụng sau khi lọc nhiễu bố cục"
        )

    words_output: list[dict[str, object]] = []
    lines_output: list[str] = []

    for line_idx, item in enumerate(ordered_items):
        paddle_text = item["paddle_text"]
        paddle_conf = item["paddle_conf"]
        dewarped_img = item["dewarped_img"]

        h_crop, w_crop = dewarped_img.shape[:2]
        if w_crop < 8 or h_crop < 8:
            continue

        line_img_pil = Image.fromarray(
            cv2.cvtColor(dewarped_img, cv2.COLOR_BGR2RGB)
        )
        chosen_text = paddle_text
        chosen_conf = paddle_conf

        try:
            viet_text = vietocr_engine.predict(line_img_pil)
            if isinstance(viet_text, str) and is_vietocr_reliable(
                viet_text, paddle_text, paddle_conf=paddle_conf, max_cer=0.35
            ):
                chosen_text = viet_text.strip()
                chosen_conf = 0.95
        except Exception:
            pass

        chosen_text = clean_ocr_punctuation(chosen_text)
        if not chosen_text:
            continue

        # Chỉ giữ lại các từ có token hợp lệ trước khi phân đoạn hộp để tránh lệch pha do dấu '*'
        valid_words = [
            w for w in chosen_text.split() if normalize_word(w)
        ]
        if not valid_words:
            continue

        line_boxes = _map_curved_word_boxes(
            valid_words, item, orig_width, orig_height
        )

        for w_idx, raw_token in enumerate(valid_words):
            norm_token = normalize_word(raw_token)
            words_output.append(
                {
                    "word_index": len(words_output),
                    "line_index": len(lines_output),
                    "text": raw_token,
                    "normalized_text": norm_token,
                    "bbox": line_boxes[w_idx],
                    "ocr_confidence": round(chosen_conf, 4)
                    if chosen_conf is not None
                    else 0.90,
                }
            )

        lines_output.append(" ".join(valid_words))

    if not words_output:
        raise OcrNoTextDetected(
            "Dual-Engine không trích xuất được từ ngữ hợp lệ"
        )

    formatted_text = "\n".join(lines_output)

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
            "scale_factor": 1.0,
            "word_count": len(words_output),
            "line_count": len(lines_output),
            "reading_layout": layout_type,
        },
    }