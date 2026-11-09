from __future__ import annotations

import math
import unicodedata
from typing import Any

import cv2
import numpy as np

HYBRID_OCR_EVIDENCE_CONTRACT = "hybrid_ocr_evidence_v3"
OCR_PREPROCESSING_VERSION = "vi_word_crop_nfc_v1"
MAX_SELECTIVE_WORD_CROPS_PER_PAGE = 12


def normalize_alignment_token(value: str) -> str:
    """NFC/case normalization that deliberately preserves Vietnamese diacritics."""
    token = unicodedata.normalize("NFC", str(value)).casefold().strip()
    while token and unicodedata.category(token[0]).startswith(("P", "S")):
        token = token[1:]
    while token and unicodedata.category(token[-1]).startswith(("P", "S")):
        token = token[:-1]
    return " ".join(token.split())


def _edit_distance_ratio(left: str, right: str) -> float:
    if left == right:
        return 0.0
    if not left or not right:
        return 1.0
    previous = list(range(len(right) + 1))
    for row, left_char in enumerate(left, start=1):
        current = [row]
        for column, right_char in enumerate(right, start=1):
            current.append(min(
                current[column - 1] + 1,
                previous[column] + 1,
                previous[column - 1] + (left_char != right_char),
            ))
        previous = current
    return previous[-1] / max(len(left), len(right))


def token_alignment_cost(left: str, right: str) -> float:
    """Alignment cost using NFC text; accent-folded equality is never accepted."""
    left_token = normalize_alignment_token(left)
    right_token = normalize_alignment_token(right)
    if left_token == right_token:
        return 0.0
    if not left_token or not right_token or max(len(left_token), len(right_token)) > 128:
        return 1.1
    return min(1.5, _edit_distance_ratio(left_token, right_token) * 1.1)


def find_split_merge_candidates(
    primary_tokens: list[str],
    secondary_tokens: list[str],
    *,
    max_group_size: int = 3,
) -> list[dict[str, Any]]:
    """Find possible 1:N/N:1 boundaries without forcing them into token alignment."""
    candidates: list[dict[str, Any]] = []
    right = [normalize_alignment_token(token) for token in secondary_tokens]
    left = [normalize_alignment_token(token) for token in primary_tokens]
    for primary_index, token in enumerate(left):
        if not token:
            continue
        for start in range(len(right)):
            for size in range(2, max_group_size + 1):
                end = start + size
                if end <= len(right) and "".join(right[start:end]) == token:
                    candidates.append({
                        "operation": "merge",
                        "primary_indices": [primary_index],
                        "secondary_indices": list(range(start, end)),
                    })
    for secondary_index, token in enumerate(right):
        if not token:
            continue
        for start in range(len(left)):
            for size in range(2, max_group_size + 1):
                end = start + size
                if end <= len(left) and "".join(left[start:end]) == token:
                    candidates.append({
                        "operation": "split",
                        "primary_indices": list(range(start, end)),
                        "secondary_indices": [secondary_index],
                    })
    return candidates


def crop_word_region(
    image: np.ndarray,
    bbox: object,
) -> tuple[np.ndarray | None, dict[str, Any]]:
    """Validate normalized xywh geometry and make a padded, evidence-safe crop."""
    rejected = {
        "bbox_quality": "rejected",
        "crop_quality": "unavailable",
        "reason": "invalid_bbox",
    }
    if not isinstance(image, np.ndarray) or image.ndim not in (2, 3):
        return None, {**rejected, "reason": "invalid_source_image"}
    if image.ndim == 3 and image.shape[2] != 3:
        return None, {**rejected, "reason": "unsupported_source_channels"}
    height, width = image.shape[:2]
    if height < 8 or width < 8:
        return None, {**rejected, "reason": "invalid_source_dimensions"}
    if not isinstance(bbox, (list, tuple)) or len(bbox) != 4:
        return None, rejected
    if any(isinstance(value, bool) or not isinstance(value, (int, float)) for value in bbox):
        return None, rejected
    x, y, box_width, box_height = (float(value) for value in bbox)
    if not all(math.isfinite(value) for value in (x, y, box_width, box_height)):
        return None, rejected
    if (
        x < 0 or y < 0 or box_width <= 0 or box_height <= 0
        or x + box_width > 1 or y + box_height > 1
    ):
        return None, rejected

    left = int(math.floor(x * width))
    top = int(math.floor(y * height))
    right = int(math.ceil((x + box_width) * width))
    bottom = int(math.ceil((y + box_height) * height))
    pixel_width = right - left
    pixel_height = bottom - top
    if pixel_width < 8 or pixel_height < 8:
        return None, {**rejected, "reason": "bbox_too_small"}
    ratio = pixel_width / max(1, pixel_height)
    if ratio < 0.12 or ratio > 24:
        return None, {**rejected, "reason": "implausible_word_geometry"}

    pad_x = max(4, int(round(pixel_height * 0.22)))
    pad_y = max(6, int(round(pixel_height * 0.45)))
    padded_left = max(0, left - pad_x)
    padded_top = max(0, top - pad_y)
    padded_right = min(width, right + pad_x)
    padded_bottom = min(height, bottom + pad_y)
    padding_clipped = (
        padded_left == 0 or padded_top == 0
        or padded_right == width or padded_bottom == height
    )
    crop = image[padded_top:padded_bottom, padded_left:padded_right].copy()
    if crop.size == 0 or crop.shape[0] < 8 or crop.shape[1] < 8:
        return None, {**rejected, "reason": "empty_crop"}

    gray = cv2.cvtColor(crop, cv2.COLOR_BGR2GRAY) if crop.ndim == 3 else crop
    contrast = float(np.std(gray))
    _, ink = cv2.threshold(
        gray, 0, 255, cv2.THRESH_BINARY_INV | cv2.THRESH_OTSU
    )
    ink_ratio = float(np.mean(ink > 0))
    if contrast < 5.0 or ink_ratio < 0.001 or ink_ratio > 0.80:
        return None, {
            "bbox_quality": "valid",
            "crop_quality": "weak",
            "reason": "insufficient_visual_signal",
            "contrast_std": round(contrast, 3),
            "ink_ratio": round(ink_ratio, 5),
            "padding_clipped": padding_clipped,
        }

    preprocessing = "original_padded"
    if contrast < 28.0 and crop.ndim == 3:
        lab = cv2.cvtColor(crop, cv2.COLOR_BGR2LAB)
        lightness, channel_a, channel_b = cv2.split(lab)
        lightness = cv2.createCLAHE(
            clipLimit=2.0, tileGridSize=(4, 4)
        ).apply(lightness)
        crop = cv2.cvtColor(
            cv2.merge((lightness, channel_a, channel_b)), cv2.COLOR_LAB2BGR
        )
        preprocessing = "clahe_padded"

    if crop.shape[0] < 48:
        scale = min(3.0, 48.0 / float(crop.shape[0]))
        if scale > 1.0:
            crop = cv2.resize(
                crop,
                (
                    max(8, int(round(crop.shape[1] * scale))),
                    max(8, int(round(crop.shape[0] * scale))),
                ),
                interpolation=cv2.INTER_CUBIC,
            )
            preprocessing += "_upscaled"

    return crop, {
        "bbox_quality": "valid",
        "crop_quality": "weak" if padding_clipped else "usable",
        "reason": "padding_touched_image_edge" if padding_clipped else None,
        "contrast_std": round(contrast, 3),
        "ink_ratio": round(ink_ratio, 5),
        "padding_clipped": padding_clipped,
        "preprocessing": preprocessing,
    }
