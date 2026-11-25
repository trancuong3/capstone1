"""OpenCV-only document boundary detection, deskew, double-page gutter & homography mapping.

Zero extra ML dependencies (`cv2`, `numpy`, `PIL` only — Render Free 512 MiB safe).
Enforces the Conservative Crop Safety Rule:
  - ONLY sets `auto_crop=True` when `confidence >= 0.72` AND `area_ratio >= 0.45`
    (and `< 0.97`, i.e., real background border present) AND `not clips_margin_text`.
  - Always returns exact 3x3 `transform_matrix` and `inverse_transform_matrix` plus
    `map_point_to_source(x, y, transform)` so word coordinates map faithfully back
    to the source scan without ever synthesizing fake bounding boxes.
"""

from __future__ import annotations

import io
import math
import time
from typing import Any, Sequence

import cv2
import numpy as np
from PIL import Image, ImageOps

from app.schemas.ocr_extraction import (
    DocumentBoundaryResult,
    GutterDetectionResult,
    LightingProfile,
)

# Conservative Crop Safety thresholds
AUTO_CROP_MIN_CONFIDENCE = 0.72
AUTO_CROP_MIN_AREA_RATIO = 0.45
AUTO_CROP_MAX_AREA_RATIO = 0.97
MAX_SAFE_PERSPECTIVE_SKEW_DEG = 25.0
FINE_DESKEW_MIN_DEG = 0.4
FINE_DESKEW_MAX_DEG = 15.0
GUTTER_MIN_BAND_X = 0.30
GUTTER_MAX_BAND_X = 0.70
GUTTER_MIN_ASPECT_RATIO = 1.22
GUTTER_RECOMMEND_CONFIDENCE = 0.72

_IDENTITY_3X3: list[list[float]] = [
    [1.0, 0.0, 0.0],
    [0.0, 1.0, 0.0],
    [0.0, 0.0, 1.0],
]


def _matrix_to_list(matrix: np.ndarray) -> list[list[float]]:
    return [[float(val) for val in row] for row in matrix.tolist()]


_MAX_IMAGE_BYTES = 12 * 1024 * 1024  # 12 MiB cap for Render Free 512 MiB safety
_MAX_IMAGE_PIXELS = 25_000_000  # 25 MP decompression bomb cap


def _has_supported_image_magic(raw: bytes) -> bool:
    if len(raw) < 12:
        return False
    is_jpeg = raw[:3] == b"\xff\xd8\xff"
    is_png = raw[:8] == b"\x89PNG\r\n\x1a\n"
    is_webp = raw[:4] == b"RIFF" and raw[8:12] == b"WEBP"
    return is_jpeg or is_png or is_webp


def _decode_image_to_bgr(image_input: bytes | np.ndarray | Image.Image) -> np.ndarray:
    """Decode bytes, PIL Image, or OpenCV ndarray into a BGR uint8 image (EXIF-normalized)."""
    if isinstance(image_input, np.ndarray):
        arr = image_input
        if arr.ndim == 2:
            return cv2.cvtColor(arr, cv2.COLOR_GRAY2BGR)
        if arr.ndim == 3 and arr.shape[2] == 4:
            return cv2.cvtColor(arr, cv2.COLOR_BGRA2BGR)
        if arr.ndim == 3 and arr.shape[2] == 3:
            return arr.copy()
        raise ValueError("Unsupported numpy image array shape")

    if isinstance(image_input, Image.Image):
        if int(image_input.width) * int(image_input.height) > _MAX_IMAGE_PIXELS:
            raise ValueError("Image exceeds 25MP decompression limit")
        transposed = ImageOps.exif_transpose(image_input).convert("RGB")
        rgb = np.asarray(transposed, dtype=np.uint8)
        return cv2.cvtColor(rgb, cv2.COLOR_RGB2BGR)

    if isinstance(image_input, (bytes, bytearray)):
        raw = bytes(image_input)
        if len(raw) > _MAX_IMAGE_BYTES:
            raise ValueError("Image payload exceeds 12 MiB limit")
        if not _has_supported_image_magic(raw):
            raise ValueError("Unsupported image format: only JPEG, PNG, and WEBP are allowed")
        prev_max_pixels = Image.MAX_IMAGE_PIXELS
        Image.MAX_IMAGE_PIXELS = _MAX_IMAGE_PIXELS
        try:
            with Image.open(io.BytesIO(raw)) as pil_img:
                if int(pil_img.width) * int(pil_img.height) > _MAX_IMAGE_PIXELS:
                    raise ValueError("Image exceeds 25MP decompression limit")
                transposed = ImageOps.exif_transpose(pil_img).convert("RGB")
                rgb = np.asarray(transposed, dtype=np.uint8)
        finally:
            Image.MAX_IMAGE_PIXELS = prev_max_pixels
        return cv2.cvtColor(rgb, cv2.COLOR_RGB2BGR)

    raise TypeError(f"Unsupported image input type: {type(image_input).__name__}")


def order_quad_points(pts: np.ndarray) -> np.ndarray:
    """Order 4 points canonically as [TL, TR, BR, BL]."""
    arr = np.asarray(pts, dtype=np.float32).reshape(4, 2)
    sums = arr.sum(axis=1)
    diffs = np.diff(arr, axis=1).reshape(4)
    tl = arr[int(np.argmin(sums))]
    br = arr[int(np.argmax(sums))]
    tr = arr[int(np.argmin(diffs))]
    bl = arr[int(np.argmax(diffs))]
    return np.array([tl, tr, br, bl], dtype=np.float32)


def _quad_area(quad: np.ndarray) -> float:
    return float(abs(cv2.contourArea(quad.reshape(-1, 1, 2).astype(np.float32))))


def _quad_corner_angles_deg(quad: np.ndarray) -> list[float]:
    angles: list[float] = []
    for idx in range(4):
        p_prev = quad[(idx - 1) % 4]
        p_curr = quad[idx]
        p_next = quad[(idx + 1) % 4]
        v1 = p_prev - p_curr
        v2 = p_next - p_curr
        denom = float(np.linalg.norm(v1) * np.linalg.norm(v2))
        if denom < 1e-6:
            angles.append(0.0)
            continue
        cos_theta = max(-1.0, min(1.0, float(np.dot(v1, v2) / denom)))
        angles.append(math.degrees(math.acos(cos_theta)))
    return angles


def _analyze_lighting_profile(gray: np.ndarray) -> LightingProfile:
    mean_lum = float(np.mean(gray))
    if mean_lum < 75.0:
        return "LOW_LIGHT"
    bright_ratio = float(np.mean(gray > 248))
    if mean_lum > 235.0 and bright_ratio > 0.72:
        return "OVER_EXPOSED"

    h, w = gray.shape[:2]
    if h >= 16 and w >= 16:
        mid_h, mid_w = h // 2, w // 2
        quadrants = [
            float(np.mean(gray[:mid_h, :mid_w])),
            float(np.mean(gray[:mid_h, mid_w:])),
            float(np.mean(gray[mid_h:, :mid_w])),
            float(np.mean(gray[mid_h:, mid_w:])),
        ]
        spread = max(quadrants) - min(quadrants)
        dark_ratio = float(np.mean(gray < 90))
        if spread >= 48.0 and dark_ratio >= 0.08:
            return "SHADOW"
        if spread >= 30.0:
            return "UNEVEN_LIGHT"
    return "NORMAL"


def _shadow_resilient_gray(bgr: np.ndarray) -> np.ndarray:
    """Produce a lighting/shadow-normalized grayscale map for contour/edge detection."""
    lab = cv2.cvtColor(bgr, cv2.COLOR_BGR2LAB)
    l_channel = lab[:, :, 0]
    clahe = cv2.createCLAHE(clipLimit=2.2, tileGridSize=(8, 8))
    enhanced = clahe.apply(l_channel)

    h, w = enhanced.shape[:2]
    k = max(21, int(min(h, w) // 10) | 1)
    bg = cv2.medianBlur(enhanced, min(k, 81))
    bg_safe = np.maximum(bg.astype(np.float32), 1.0)
    normalized = np.clip((enhanced.astype(np.float32) / bg_safe) * 215.0, 0, 255).astype(
        np.uint8
    )
    return cv2.addWeighted(enhanced, 0.55, normalized, 0.45, 0)


def _compute_quad_confidence(
    quad_small: np.ndarray,
    gray_small: np.ndarray,
    contour_area: float,
) -> tuple[float, float, float]:
    """Return (confidence, area_ratio, max_corner_skew_deg) for a candidate page quad."""
    h, w = gray_small.shape[:2]
    img_area = float(max(1, h * w))
    q_area = _quad_area(quad_small)
    area_ratio = min(1.0, q_area / img_area)
    if area_ratio < 0.05:
        return 0.0, area_ratio, 90.0

    # 1. Angle regularity
    angles = _quad_corner_angles_deg(quad_small)
    max_skew = max(abs(90.0 - a) for a in angles)
    angle_score = max(0.0, 1.0 - max_skew / 40.0)

    # 2. Convexity / contour match
    solidity = min(1.0, contour_area / max(q_area, 1.0)) if contour_area > 0 else 0.75
    is_convex = bool(cv2.isContourConvex(quad_small.reshape(-1, 1, 2).astype(np.int32)))
    convex_score = 1.0 if is_convex else 0.35

    # 3. Inside-paper vs outside-background contrast
    mask = np.zeros((h, w), dtype=np.uint8)
    cv2.fillConvexPoly(mask, np.round(quad_small).astype(np.int32), 255)
    inside_pixels = gray_small[mask == 255]
    outside_pixels = gray_small[mask == 0]
    if inside_pixels.size == 0:
        return 0.0, area_ratio, max_skew

    if outside_pixels.size < 20:
        # Full-bleed scan: whole image is paper
        contrast_score = 0.0
    else:
        inside_med = float(np.median(inside_pixels))
        outside_med = float(np.median(outside_pixels))
        contrast_diff = abs(inside_med - outside_med)
        # Paper is typically brighter than desk/shadow, give small bonus when inside > outside
        paper_bonus = 0.08 if inside_med > outside_med + 10.0 else 0.0
        contrast_score = min(1.0, (contrast_diff / 65.0) + paper_bonus)

    # 4. Area plausibility
    area_score = 1.0 if 0.45 <= area_ratio <= 0.96 else (0.55 if area_ratio >= 0.25 else 0.2)

    confidence = (
        0.42 * contrast_score
        + 0.24 * angle_score
        + 0.18 * solidity * convex_score
        + 0.16 * area_score
    )
    confidence = max(0.0, min(1.0, confidence))
    return confidence, area_ratio, max_skew


def _detect_page_quad_small(
    bgr_small: np.ndarray,
    gray_small: np.ndarray,
) -> tuple[np.ndarray, float, float, float, bool]:
    """Detect best candidate page quad on downscaled working image.

    Returns (quad_small, confidence, area_ratio, max_skew_deg, has_distinct_border).
    """
    h, w = gray_small.shape[:2]
    img_area = float(max(1, h * w))
    full_quad = np.array([[0, 0], [w - 1, 0], [w - 1, h - 1], [0, h - 1]], dtype=np.float32)

    # Check if image is already a clean full-bleed white/uniform page (border matches interior)
    border_strip = np.concatenate(
        [
            gray_small[: max(2, h // 40), :].ravel(),
            gray_small[-max(2, h // 40) :, :].ravel(),
            gray_small[:, : max(2, w // 40)].ravel(),
            gray_small[:, -max(2, w // 40) :].ravel(),
        ]
    )
    center_crop = gray_small[h // 4 : (3 * h) // 4, w // 4 : (3 * w) // 4]
    border_med = float(np.median(border_strip))
    center_med = float(np.median(center_crop)) if center_crop.size else border_med
    if border_med >= 210.0 and abs(border_med - center_med) < 18.0:
        return full_quad, 0.96, 1.0, 0.0, False

    shadow_gray = _shadow_resilient_gray(bgr_small)
    blurred = cv2.GaussianBlur(shadow_gray, (5, 5), 0)

    # Multi-cue contour extraction: adaptive Canny + Otsu foreground mask
    med_val = float(np.median(blurred))
    lower = int(max(12, 0.66 * med_val))
    upper = int(min(245, max(lower + 30, 1.33 * med_val)))
    edges = cv2.Canny(blurred, lower, upper)
    close_kernel = cv2.getStructuringElement(cv2.MORPH_RECT, (7, 7))
    edges_closed = cv2.morphologyEx(edges, cv2.MORPH_CLOSE, close_kernel, iterations=2)

    _, otsu_mask = cv2.threshold(
        cv2.GaussianBlur(gray_small, (7, 7), 0),
        0,
        255,
        cv2.THRESH_BINARY + cv2.THRESH_OTSU,
    )
    otsu_closed = cv2.morphologyEx(otsu_mask, cv2.MORPH_CLOSE, close_kernel, iterations=2)
    otsu_opened = cv2.morphologyEx(otsu_closed, cv2.MORPH_OPEN, close_kernel, iterations=1)

    best_quad = full_quad
    best_conf = 0.0
    best_area_ratio = 1.0
    best_skew = 0.0
    found_distinct = False

    for mask_source in (otsu_opened, edges_closed):
        contours, _ = cv2.findContours(
            mask_source, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE
        )
        contours = sorted(contours, key=cv2.contourArea, reverse=True)[:8]
        for contour in contours:
            c_area = float(cv2.contourArea(contour))
            if c_area < 0.12 * img_area or c_area > 0.985 * img_area:
                continue
            hull = cv2.convexHull(contour)
            peri = cv2.arcLength(hull, True)
            candidate_quad: np.ndarray | None = None
            for eps in (0.02, 0.03, 0.045, 0.06):
                approx = cv2.approxPolyDP(hull, eps * peri, True)
                if len(approx) == 4:
                    candidate_quad = order_quad_points(approx.reshape(4, 2))
                    break
            if candidate_quad is None:
                rect = cv2.minAreaRect(hull)
                box = cv2.boxPoints(rect)
                box[:, 0] = np.clip(box[:, 0], 0, w - 1)
                box[:, 1] = np.clip(box[:, 1], 0, h - 1)
                candidate_quad = order_quad_points(box)

            conf, area_ratio, max_skew = _compute_quad_confidence(
                candidate_quad, gray_small, c_area
            )
            if conf > best_conf:
                best_conf = conf
                best_quad = candidate_quad
                best_area_ratio = area_ratio
                best_skew = max_skew
                found_distinct = area_ratio < AUTO_CROP_MAX_AREA_RATIO

    if not found_distinct:
        return full_quad, 0.90, 1.0, 0.0, False
    return best_quad, best_conf, best_area_ratio, best_skew, True


def estimate_deskew_angle(
    gray: np.ndarray,
    *,
    quad_px: np.ndarray | None = None,
) -> float:
    """Estimate fine text-line skew angle in degrees within [-15, +15]."""
    h, w = gray.shape[:2]
    roi = gray
    if quad_px is not None:
        xs = np.clip(np.round(quad_px[:, 0]).astype(int), 0, w - 1)
        ys = np.clip(np.round(quad_px[:, 1]).astype(int), 0, h - 1)
        x0, x1 = int(xs.min()), int(xs.max())
        y0, y1 = int(ys.min()), int(ys.max())
        if x1 - x0 >= 40 and y1 - y0 >= 40:
            roi = gray[y0:y1, x0:x1]

    rh, rw = roi.shape[:2]
    if rh < 24 or rw < 24:
        return 0.0

    # Adaptive dark-ink extraction
    block_size = max(15, (min(rh, rw) // 20) | 1)
    block_size = min(block_size, 51)
    binary = cv2.adaptiveThreshold(
        roi,
        255,
        cv2.ADAPTIVE_THRESH_GAUSSIAN_C,
        cv2.THRESH_BINARY_INV,
        block_size,
        12,
    )

    # Connect horizontal text characters into line strips
    kx = max(11, rw // 28)
    kernel = cv2.getStructuringElement(cv2.MORPH_RECT, (kx, 3))
    dilated = cv2.dilate(binary, kernel, iterations=1)

    angles: list[float] = []
    weights: list[float] = []

    contours, _ = cv2.findContours(dilated, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    for cnt in contours:
        area = cv2.contourArea(cnt)
        if area < 80:
            continue
        (_, _), (bw, bh), angle = cv2.minAreaRect(cnt)
        if bw < 1e-3 or bh < 1e-3:
            continue
        long_side = max(bw, bh)
        short_side = min(bw, bh)
        if long_side < max(24.0, rw * 0.08) or (long_side / max(short_side, 1.0)) < 2.2:
            continue
        # Convert OpenCV minAreaRect angle to horizontal line inclination in [-45, 45]
        if bw < bh:
            norm_angle = angle + 90.0
        else:
            norm_angle = angle
        while norm_angle > 45.0:
            norm_angle -= 90.0
        while norm_angle < -45.0:
            norm_angle += 90.0
        if abs(norm_angle) <= FINE_DESKEW_MAX_DEG:
            angles.append(float(norm_angle))
            weights.append(float(long_side))

    if not angles:
        # Fallback: HoughLinesP on edges
        edges = cv2.Canny(roi, 50, 150)
        lines = cv2.HoughLinesP(
            edges,
            1,
            np.pi / 180.0,
            threshold=max(30, rw // 12),
            minLineLength=max(28, rw // 8),
            maxLineGap=10,
        )
        if lines is not None:
            for line in lines[:, 0, :]:
                x1, y1, x2, y2 = (float(v) for v in line)
                dx = x2 - x1
                dy = y2 - y1
                if abs(dx) < 10.0:
                    continue
                deg = math.degrees(math.atan2(dy, dx))
                if abs(deg) <= FINE_DESKEW_MAX_DEG:
                    angles.append(deg)
                    weights.append(math.hypot(dx, dy))

    if not angles:
        return 0.0

    # Weighted median
    order = np.argsort(angles)
    sorted_angles = np.array(angles, dtype=np.float64)[order]
    sorted_weights = np.array(weights, dtype=np.float64)[order]
    cum = np.cumsum(sorted_weights)
    half = cum[-1] * 0.5
    median_idx = int(np.searchsorted(cum, half))
    median_angle = float(sorted_angles[min(median_idx, len(sorted_angles) - 1)])

    if abs(median_angle) < FINE_DESKEW_MIN_DEG:
        return 0.0
    return round(median_angle, 3)


def detect_double_page_gutter(
    gray: np.ndarray,
    *,
    word_bboxes_norm: Sequence[Sequence[float]] | None = None,
) -> GutterDetectionResult:
    """Detect a double-page book spread vertical gutter in the middle 30-70% band."""
    h, w = gray.shape[:2]
    aspect_ratio = float(w) / float(max(1, h))
    if w < 40 or h < 20:
        return GutterDetectionResult()

    x_start = int(round(w * GUTTER_MIN_BAND_X))
    x_end = int(round(w * GUTTER_MAX_BAND_X))
    if x_end - x_start < 6:
        return GutterDetectionResult()

    # Vertical luminance projection (spine shadow produces a deep dark minimum valley)
    crop_v = gray[int(h * 0.08) : int(h * 0.92), :]
    col_means = np.mean(crop_v.astype(np.float32), axis=0)
    smooth_k = max(5, (w // 80) | 1)
    kernel = np.ones(smooth_k, dtype=np.float32) / float(smooth_k)
    smooth_lum = np.convolve(col_means, kernel, mode="same")

    band_lum = smooth_lum[x_start:x_end]
    min_rel_idx = int(np.argmin(band_lum))
    gutter_px = x_start + min_rel_idx
    gutter_x_norm = float(gutter_px) / float(w)
    valley_lum = float(band_lum[min_rel_idx])

    # Compare valley luminance against surrounding left/right paper flanks
    flank_left = smooth_lum[max(0, x_start - w // 10) : max(1, gutter_px - max(6, w // 25))]
    flank_right = smooth_lum[min(w - 1, gutter_px + max(6, w // 25)) : min(w, x_end + w // 10)]
    left_paper = float(np.percentile(flank_left, 75)) if flank_left.size else float(np.median(smooth_lum))
    right_paper = float(np.percentile(flank_right, 75)) if flank_right.size else float(np.median(smooth_lum))
    flank_paper = 0.5 * (left_paper + right_paper)
    shadow_depth = max(0.0, flank_paper - valley_lum)
    shadow_score = min(1.0, shadow_depth / 45.0)

    # Also compute vertical ink whitespace valley (clean white gutter between two pages)
    binary_ink = (crop_v < max(60.0, flank_paper - 35.0)).astype(np.float32)
    ink_proj = np.mean(binary_ink, axis=0)
    smooth_ink = np.convolve(ink_proj, kernel, mode="same")
    left_has_ink = bool(np.mean(ink_proj[:x_start]) > 0.008)
    right_has_ink = bool(np.mean(ink_proj[x_end:]) > 0.008)

    band_ink = smooth_ink[x_start:x_end]
    ink_min_idx = int(np.argmin(band_ink))
    ink_valley_val = float(band_ink[ink_min_idx])
    white_gutter_score = 0.0
    if left_has_ink and right_has_ink and ink_valley_val < 0.004:
        # Check continuous white strip width around ink_min_idx
        gutter_strip_width = int(np.sum(band_ink < 0.005))
        if gutter_strip_width >= max(6, int(w * 0.025)):
            white_gutter_score = min(1.0, gutter_strip_width / max(1.0, w * 0.06))
            if shadow_score < 0.35:
                gutter_px = x_start + ink_min_idx
                gutter_x_norm = float(gutter_px) / float(w)

    # Count OCR boxes crossing the detected gutter
    crossing_lines = 0
    left_word_count = 0
    right_word_count = 0
    if word_bboxes_norm:
        for wb in word_bboxes_norm:
            if len(wb) < 4:
                continue
            bx, _, bw, _ = (float(wb[0]), float(wb[1]), float(wb[2]), float(wb[3]))
            bx2 = bx + bw
            if bx < gutter_x_norm - 0.005 and bx2 > gutter_x_norm + 0.005:
                crossing_lines += 1
            elif bx2 <= gutter_x_norm + 0.005:
                left_word_count += 1
            else:
                right_word_count += 1

    # Aspect ratio & centering bonus
    center_closeness = max(0.0, 1.0 - abs(gutter_x_norm - 0.5) / 0.22)
    aspect_bonus = 0.28 if aspect_ratio >= GUTTER_MIN_ASPECT_RATIO else 0.0
    valley_strength = max(shadow_score, 0.85 * white_gutter_score)
    confidence = min(1.0, aspect_bonus + 0.57 * valley_strength + 0.15 * center_closeness)
    if aspect_ratio < 1.12 and shadow_score < 0.65:
        confidence *= 0.45

    has_two_sides = (left_has_ink and right_has_ink) or (
        left_word_count >= 1 and right_word_count >= 1
    )
    is_double_page = bool(
        (aspect_ratio >= GUTTER_MIN_ASPECT_RATIO and confidence >= 0.55)
        or (shadow_score >= 0.72 and has_two_sides and aspect_ratio >= 1.12)
    )
    split_recommended = bool(
        is_double_page
        and confidence >= GUTTER_RECOMMEND_CONFIDENCE
        and crossing_lines == 0
    )

    if split_recommended:
        reason_vi = (
            "Phát hiện ảnh chụp hai trang mở (nếp gấp giữa trang rõ ràng) — "
            "đề xuất tách thành trang trái và trang phải."
        )
    elif is_double_page and crossing_lines > 0:
        reason_vi = (
            "Phát hiện bố cục trang đôi nhưng có dòng chữ vắt ngang giữa trang — "
            "không tự động cắt, mời xem xét."
        )
    elif is_double_page:
        reason_vi = (
            "Nghi ngờ ảnh chụp trang đôi nhưng nếp gấp chưa đủ rõ — mời kiểm tra trước khi tách."
        )
    else:
        reason_vi = "Trang đơn — không phát hiện nếp gấp gáy sách."

    return GutterDetectionResult(
        is_double_page=is_double_page,
        gutter_x_norm=round(gutter_x_norm, 6) if is_double_page else None,
        confidence=round(confidence, 4),
        crossing_line_count=crossing_lines,
        split_recommended=split_recommended,
        reason_vi=reason_vi,
    )


def point_in_quad(x: float, y: float, quad: Sequence[Sequence[float]], *, margin: float = 0.0) -> bool:
    """Return True if point (x, y) lies inside (or within `margin` outside) a 4-point quad."""
    poly = np.asarray(quad, dtype=np.float32).reshape(-1, 1, 2)
    dist = float(cv2.pointPolygonTest(poly, (float(x), float(y)), True))
    return dist >= -abs(margin)


def _check_margin_text_clipping(
    gray_small: np.ndarray,
    quad_small: np.ndarray,
    quad_norm: list[list[float]],
    word_bboxes_norm: Sequence[Sequence[float]] | None,
) -> bool:
    """Return True if cropping to `quad` risks clipping text near page margins."""
    # 1. Explicit OCR word boxes check (most accurate when available)
    if word_bboxes_norm:
        for wb in word_bboxes_norm:
            if len(wb) < 4:
                continue
            x, y, bw, bh = (float(wb[0]), float(wb[1]), float(wb[2]), float(wb[3]))
            corners = [(x, y), (x + bw, y), (x + bw, y + bh), (x, y + bh)]
            cx, cy = x + 0.5 * bw, y + 0.5 * bh
            center_in = point_in_quad(cx, cy, quad_norm, margin=0.0)
            corners_in = sum(1 for px, py in corners if point_in_quad(px, py, quad_norm, margin=0.002))
            # A word straddling the quad boundary means cropping would slice the word in half!
            if (center_in and corners_in < 4) or (not center_in and corners_in >= 1):
                return True

    # 2. Ink-band check directly along the quad border (5px straddling band)
    h, w = gray_small.shape[:2]
    poly = np.round(quad_small).astype(np.int32)
    inside_mask = np.zeros((h, w), dtype=np.uint8)
    cv2.fillConvexPoly(inside_mask, poly, 255)
    inside_vals = gray_small[inside_mask == 255]
    if inside_vals.size < 50:
        return True
    paper_med = float(np.median(inside_vals))
    if paper_med < 95.0:
        return False

    # Build a thin band just inside and just outside the quad edge
    border_mask = np.zeros((h, w), dtype=np.uint8)
    cv2.polylines(border_mask, [poly], isClosed=True, color=255, thickness=3)
    # Dark ink pixels strictly on paper side vs border crossing
    ink_mask = (gray_small < (paper_med - 55.0)).astype(np.uint8) * 255
    # Only consider thin text-like dark pixels (connected components of moderate height)
    num_labels, labels, stats, _ = cv2.connectedComponentsWithStats(ink_mask, connectivity=8)
    if num_labels <= 1:
        return False
    clipped_text_components = 0
    for label_idx in range(1, num_labels):
        cw = int(stats[label_idx, cv2.CC_STAT_WIDTH])
        ch = int(stats[label_idx, cv2.CC_STAT_HEIGHT])
        c_area = int(stats[label_idx, cv2.CC_STAT_AREA])
        # Typical text glyph component on 800px working image (excludes dark desk background!)
        if c_area < 6 or c_area > int(h * w * 0.02):
            continue
        if ch < 4 or ch > int(h * 0.12) or cw > int(w * 0.35):
            continue
        comp_x = int(stats[label_idx, cv2.CC_STAT_LEFT])
        comp_y = int(stats[label_idx, cv2.CC_STAT_TOP])
        sub_labels = labels[comp_y : comp_y + ch, comp_x : comp_x + cw] == label_idx
        sub_border = border_mask[comp_y : comp_y + ch, comp_x : comp_x + cw] > 0
        if np.any(sub_labels & sub_border):
            clipped_text_components += 1
            if clipped_text_components >= 3:
                return True
    return False


def _compute_perspective_transform(
    quad_px: np.ndarray,
) -> tuple[np.ndarray, np.ndarray, int, int]:
    """Compute exact 3x3 perspective transform (source -> rectified) and its inverse."""
    tl, tr, br, bl = quad_px
    width_top = float(np.linalg.norm(tr - tl))
    width_bottom = float(np.linalg.norm(br - bl))
    out_w = max(16, int(round(max(width_top, width_bottom))))

    height_left = float(np.linalg.norm(bl - tl))
    height_right = float(np.linalg.norm(br - tr))
    out_h = max(16, int(round(max(height_left, height_right))))

    dst_quad = np.array(
        [[0.0, 0.0], [out_w - 1.0, 0.0], [out_w - 1.0, out_h - 1.0], [0.0, out_h - 1.0]],
        dtype=np.float32,
    )
    mat = cv2.getPerspectiveTransform(quad_px.astype(np.float32), dst_quad)
    det = float(np.linalg.det(mat))
    if abs(det) < 1e-8:
        ident = np.eye(3, dtype=np.float64)
        return ident, ident, out_w, out_h
    inv_mat = np.linalg.inv(mat)
    return mat.astype(np.float64), inv_mat.astype(np.float64), out_w, out_h


def _compute_deskew_affine_3x3(width: int, height: int, angle_deg: float) -> tuple[np.ndarray, np.ndarray]:
    """Compute exact 3x3 affine deskew matrix (source -> deskewed) and its exact inverse."""
    center = (width / 2.0, height / 2.0)
    m2x3 = cv2.getRotationMatrix2D(center, angle_deg, 1.0)
    mat = np.vstack([m2x3, np.array([[0.0, 0.0, 1.0]], dtype=np.float64)])
    inv_mat = np.linalg.inv(mat)
    return mat, inv_mat


def _extract_matrix_3x3(
    transform: DocumentBoundaryResult | dict[str, Any] | Sequence[Sequence[float]] | np.ndarray,
    *,
    prefer_inverse: bool,
) -> tuple[np.ndarray, bool]:
    """Extract a 3x3 matrix from a boundary result, dict, or raw 3x3 array.

    Returns (matrix_3x3, is_already_inverse).
    """
    if isinstance(transform, DocumentBoundaryResult):
        key_mat = (
            transform.inverse_transform_matrix
            if prefer_inverse
            else transform.transform_matrix
        )
        return np.asarray(key_mat, dtype=np.float64).reshape(3, 3), prefer_inverse

    if isinstance(transform, dict):
        if prefer_inverse and "inverse_transform_matrix" in transform:
            return (
                np.asarray(transform["inverse_transform_matrix"], dtype=np.float64).reshape(3, 3),
                True,
            )
        if "transform_matrix" in transform:
            return (
                np.asarray(transform["transform_matrix"], dtype=np.float64).reshape(3, 3),
                False,
            )
        raise ValueError("Transform dict must include transform_matrix or inverse_transform_matrix")

    arr = np.asarray(transform, dtype=np.float64)
    if arr.shape != (3, 3):
        raise ValueError(f"Expected 3x3 transformation matrix, got shape {arr.shape}")
    return arr, False


def apply_transform_point(x: float, y: float, matrix: Sequence[Sequence[float]] | np.ndarray) -> tuple[float, float]:
    """Apply a 3x3 homogeneous matrix directly to a 2D point (x, y)."""
    mat = np.asarray(matrix, dtype=np.float64).reshape(3, 3)
    vec = np.array([float(x), float(y), 1.0], dtype=np.float64)
    mapped = mat @ vec
    w = float(mapped[2])
    if abs(w) < 1e-12:
        raise ValueError("Degenerate projective transform (w ~= 0)")
    return (float(mapped[0] / w), float(mapped[1] / w))


def map_point_to_rectified(
    x: float,
    y: float,
    transform: DocumentBoundaryResult | dict[str, Any] | Sequence[Sequence[float]] | np.ndarray,
) -> tuple[float, float]:
    """Map a source-image pixel point (x, y) into rectified/cropped coordinate space."""
    mat, _ = _extract_matrix_3x3(transform, prefer_inverse=False)
    return apply_transform_point(x, y, mat)


def map_point_to_source(
    x: float,
    y: float,
    transform: DocumentBoundaryResult | dict[str, Any] | Sequence[Sequence[float]] | np.ndarray,
    *,
    already_inverse: bool = False,
) -> tuple[float, float]:
    """Map a point (x, y) from rectified/cropped image space accurately back to source image.

    Accepts:
      - `DocumentBoundaryResult` (uses its exact `inverse_transform_matrix`),
      - A dict containing `inverse_transform_matrix` or `transform_matrix`, OR
      - A 3x3 forward `transform_matrix` (automatically inverted), OR an inverse matrix
        when `already_inverse=True`.
    """
    mat, is_inv = _extract_matrix_3x3(transform, prefer_inverse=True)
    if already_inverse or is_inv:
        inv_mat = mat
    else:
        det = float(np.linalg.det(mat))
        if abs(det) < 1e-12:
            raise ValueError("Singular transform matrix cannot be inverted")
        inv_mat = np.linalg.inv(mat)
    return apply_transform_point(x, y, inv_mat)


def map_bbox_to_source(
    bbox_norm: Sequence[float],
    boundary: DocumentBoundaryResult,
) -> list[float]:
    """Map a normalized [x, y, w, h] bbox in rectified space back to normalized source space."""
    bx, by, bw, bh = (float(bbox_norm[0]), float(bbox_norm[1]), float(bbox_norm[2]), float(bbox_norm[3]))
    out_w = float(boundary.output_width)
    out_h = float(boundary.output_height)
    src_w = float(boundary.image_width)
    src_h = float(boundary.image_height)

    rect_corners = [
        (bx * out_w, by * out_h),
        ((bx + bw) * out_w, by * out_h),
        ((bx + bw) * out_w, (by + bh) * out_h),
        (bx * out_w, (by + bh) * out_h),
    ]
    src_pts = [map_point_to_source(px, py, boundary) for px, py in rect_corners]
    xs = [max(0.0, min(1.0, p[0] / src_w)) for p in src_pts]
    ys = [max(0.0, min(1.0, p[1] / src_h)) for p in src_pts]
    x_min, x_max = min(xs), max(xs)
    y_min, y_max = min(ys), max(ys)
    return [
        round(x_min, 6),
        round(y_min, 6),
        round(max(1e-6, x_max - x_min), 6),
        round(max(1e-6, y_max - y_min), 6),
    ]


def warp_image_with_boundary(
    image_bgr: np.ndarray,
    boundary: DocumentBoundaryResult,
) -> np.ndarray:
    """Apply the boundary's exact transform matrix when `auto_crop=True`, else return copy."""
    if not boundary.auto_crop and abs(boundary.deskew_angle_deg) < FINE_DESKEW_MIN_DEG:
        return image_bgr.copy()
    mat = np.asarray(boundary.transform_matrix, dtype=np.float64).reshape(3, 3)
    return cv2.warpPerspective(
        image_bgr,
        mat,
        (boundary.output_width, boundary.output_height),
        flags=cv2.INTER_LINEAR,
        borderMode=cv2.BORDER_REPLICATE,
    )


def detect_document_boundary(
    image_input: bytes | np.ndarray | Image.Image,
    *,
    word_bboxes_norm: Sequence[Sequence[float]] | None = None,
) -> DocumentBoundaryResult:
    """Detect page quad, deskew angle, double-page gutter, and safe crop transform."""
    started = time.perf_counter()
    bgr = _decode_image_to_bgr(image_input)
    orig_h, orig_w = bgr.shape[:2]

    # Downscale working image to max_side <= 800 for fast, low-memory (<80 MiB) CV analysis
    max_side = max(orig_h, orig_w)
    scale = min(1.0, 800.0 / float(max(1, max_side)))
    if scale < 1.0:
        small_w = max(16, int(round(orig_w * scale)))
        small_h = max(16, int(round(orig_h * scale)))
        bgr_small = cv2.resize(bgr, (small_w, small_h), interpolation=cv2.INTER_AREA)
    else:
        small_w, small_h = orig_w, orig_h
        bgr_small = bgr

    gray_small = cv2.cvtColor(bgr_small, cv2.COLOR_BGR2GRAY)
    lighting_profile = _analyze_lighting_profile(gray_small)

    quad_small, confidence, area_ratio, max_skew, has_distinct_border = _detect_page_quad_small(
        bgr_small, gray_small
    )

    # Scale quad back to original source pixel coordinates & normalized [0, 1]
    sx = float(orig_w) / float(small_w)
    sy = float(orig_h) / float(small_h)
    quad_px = np.column_stack([quad_small[:, 0] * sx, quad_small[:, 1] * sy]).astype(np.float32)
    quad_px[:, 0] = np.clip(quad_px[:, 0], 0.0, float(orig_w - 1))
    quad_px[:, 1] = np.clip(quad_px[:, 1], 0.0, float(orig_h - 1))

    quad_norm = [
        [round(float(pt[0]) / float(orig_w), 6), round(float(pt[1]) / float(orig_h), 6)]
        for pt in quad_px
    ]
    xs_n = [p[0] for p in quad_norm]
    ys_n = [p[1] for p in quad_norm]
    bbox_norm = [
        round(min(xs_n), 6),
        round(min(ys_n), 6),
        round(max(1e-6, max(xs_n) - min(xs_n)), 6),
        round(max(1e-6, max(ys_n) - min(ys_n)), 6),
    ]

    deskew_angle_deg = estimate_deskew_angle(
        gray_small,
        quad_px=quad_small if has_distinct_border else None,
    )
    gutter = detect_double_page_gutter(gray_small, word_bboxes_norm=word_bboxes_norm)

    clips_margin_text = False
    if has_distinct_border:
        clips_margin_text = _check_margin_text_clipping(
            gray_small, quad_small, quad_norm, word_bboxes_norm
        )

    # Conservative Crop Safety Rule
    auto_crop = bool(
        has_distinct_border
        and confidence >= AUTO_CROP_MIN_CONFIDENCE
        and AUTO_CROP_MIN_AREA_RATIO <= area_ratio < AUTO_CROP_MAX_AREA_RATIO
        and not clips_margin_text
        and max_skew <= MAX_SAFE_PERSPECTIVE_SKEW_DEG
    )

    requires_crop_review = False
    if has_distinct_border and not auto_crop:
        requires_crop_review = True
    elif clips_margin_text:
        requires_crop_review = True
    elif gutter.is_double_page and not gutter.split_recommended:
        requires_crop_review = True

    if auto_crop:
        mat, inv_mat, out_w, out_h = _compute_perspective_transform(quad_px)
        reason_vi = (
            "Đã phát hiện rõ viền trang sách và sẵn sàng căn thẳng khung ảnh an toàn."
        )
    elif abs(deskew_angle_deg) >= FINE_DESKEW_MIN_DEG:
        mat, inv_mat = _compute_deskew_affine_3x3(orig_w, orig_h, deskew_angle_deg)
        out_w, out_h = orig_w, orig_h
        if requires_crop_review:
            reason_vi = (
                "Ảnh bị nghiêng hoặc viền trang chưa đủ chắc chắn — chỉ xoay nhẹ, "
                "không tự động cắt sát mép."
            )
        else:
            reason_vi = "Đã ước lượng góc nghiêng trang để căn thẳng dòng chữ."
    else:
        mat = np.eye(3, dtype=np.float64)
        inv_mat = np.eye(3, dtype=np.float64)
        out_w, out_h = orig_w, orig_h
        if clips_margin_text:
            reason_vi = (
                "Phát hiện chữ sát mép trang — không tự động cắt để tránh mất chữ."
            )
        elif has_distinct_border and area_ratio < AUTO_CROP_MIN_AREA_RATIO:
            reason_vi = (
                "Vùng trang phát hiện nhỏ hơn 45% khung ảnh — mời kiểm tra lại khung cắt."
            )
        elif has_distinct_border and confidence < AUTO_CROP_MIN_CONFIDENCE:
            reason_vi = (
                "Độ chắc chắn viền trang chưa đạt ngưỡng an toàn — giữ nguyên ảnh gốc để xác minh."
            )
        else:
            reason_vi = "Trang sách đã đầy khung — giữ nguyên ảnh gốc."

    elapsed_ms = round((time.perf_counter() - started) * 1000.0, 3)

    return DocumentBoundaryResult(
        image_width=orig_w,
        image_height=orig_h,
        boundary_quad_norm=quad_norm,
        boundary_quad_px=[[round(float(p[0]), 3), round(float(p[1]), 3)] for p in quad_px],
        boundary_bbox_norm=bbox_norm,
        area_ratio=round(area_ratio, 4),
        confidence=round(confidence, 4),
        deskew_angle_deg=deskew_angle_deg,
        auto_crop=auto_crop,
        requires_crop_review=requires_crop_review,
        clips_margin_text=clips_margin_text,
        transform_matrix=_matrix_to_list(mat),
        inverse_transform_matrix=_matrix_to_list(inv_mat),
        output_width=out_w,
        output_height=out_h,
        gutter=gutter,
        lighting_profile=lighting_profile,
        processing_ms=elapsed_ms,
        reason_vi=reason_vi,
    )
