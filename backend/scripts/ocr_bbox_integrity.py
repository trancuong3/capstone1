"""Privacy-safe integrity checks for normalized OCR word boxes.

This only checks box structure and image bounds. It DOES NOT assess
geometric accuracy, word-to-box correspondence, or reading colors.
"""
from __future__ import annotations

import math
from collections import Counter


def inspect_word_boxes(words: object) -> dict[str, object]:
    """Inspect x,y,width,height normalized boxes without retaining word text."""
    if not isinstance(words, list):
        return {
            "status": "not_reported",
            "reported_words": 0,
            "valid_boxes": 0,
            "invalid_boxes": 0,
            "invalid_reasons": {},
        }

    if not words:
        return {
            "status": "empty_word_list",
            "reported_words": 0,
            "valid_boxes": 0,
            "invalid_boxes": 0,
            "invalid_reasons": {},
        }

    invalid: Counter[str] = Counter()
    valid = 0
    for item in words:
        if not isinstance(item, dict):
            invalid["invalid_word_record"] += 1
            continue
        bbox = item.get("bbox")
        if not isinstance(bbox, (list, tuple)) or len(bbox) != 4:
            invalid["invalid_bbox_shape"] += 1
            continue
        if any(isinstance(v, bool) or not isinstance(v, (int, float)) for v in bbox):
            invalid["non_numeric_coordinate"] += 1
            continue
        x, y, w, h = [float(v) for v in bbox]
        if not all(math.isfinite(v) for v in (x, y, w, h)):
            invalid["non_finite_coordinate"] += 1
        elif w <= 0 or h <= 0:
            invalid["non_positive_extent"] += 1
        elif x < 0 or y < 0 or x + w > 1 + 1e-6 or y + h > 1 + 1e-6:
            invalid["out_of_image_bounds"] += 1
        else:
            valid += 1

    return {
        "status": "complete",
        "reported_words": len(words),
        "valid_boxes": valid,
        "invalid_boxes": sum(invalid.values()),
        "invalid_reasons": dict(sorted(invalid.items())),
    }
