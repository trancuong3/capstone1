"""Offline OCR word-box tightness hypotheses; never modifies production boxes.

All exposed results are numeric aggregates. This module intentionally makes
NO claim that optimizations found on synthetic pages will transfer to photos.
"""
from __future__ import annotations

import math
import statistics
import unicodedata
from collections import Counter

from scripts.ocr_word_box_iou import (
    intersection_over_union,
    score_page,
    summarize_scores,
    valid_box,
)

# Compact, prespecified hypothesis grid; all results are in-sample diagnostics.
FACTORS = (0.90, 1.00, 1.10)
CANDIDATES = {
    f"width_{int(round(sx * 100))}_height_{int(round(sy * 100))}": (sx, sy)
    for sx in FACTORS for sy in FACTORS
}


def resize_box(box: object, width_scale: float, height_scale: float) -> object:
    """Scale normalized box around its center, clipped to the image bounds."""
    if not valid_box(box):
        return box  # Invalid predictions must remain false positives.
    x, y, w, h = (float(v) for v in box)
    cx, cy = x + w / 2, y + h / 2
    xmin = max(0.0, cx - w * width_scale / 2)
    xmax = min(1.0, cx + w * width_scale / 2)
    ymin = max(0.0, cy - h * height_scale / 2)
    ymax = min(1.0, cy + h * height_scale / 2)
    return [xmin, ymin, xmax - xmin, ymax - ymin]


def candidate_predictions(words: object, sx: float, sy: float) -> list[dict[str, object]]:
    if not isinstance(words, list):
        raise ValueError("Missing OCR word list")
    result: list[dict[str, object]] = []
    for row in words:
        if not isinstance(row, dict):
            # Keep invalid prediction as a FP, not silently drop it.
            result.append({"text": None, "bbox": None})
        else:
            result.append({
                "text": row.get("text"),
                "bbox": resize_box(row.get("bbox"), sx, sy),
            })
    return result


def inspect_overlap_shapes(predicted: object, reference: object) -> dict[str, object]:
    """Best-overlap *descriptive* histogram (not a one-to-one TP count).

    For each valid predicted box, find the highest-IoU reference box.
    Width/height ratios use only best-overlap pairs with IoU >= 0.50 and
    exact NFC text match; they do NOT establish the correct pairing.
    """
    if not isinstance(predicted, list) or not isinstance(reference, list):
        raise ValueError("Expected lists of word boxes")
    histogram: Counter[str] = Counter()
    width_ratios: list[float] = []
    height_ratios: list[float] = []
    for row in predicted:
        if not isinstance(row, dict) or not valid_box(row.get("bbox")):
            histogram["invalid_prediction"] += 1
            continue
        matches = [
            (intersection_over_union(row["bbox"], gt["bbox"]), index)
            for index, gt in enumerate(reference)
            if isinstance(gt, dict) and valid_box(gt.get("bbox"))
        ]
        overlap, index = max(matches, default=(0.0, -1))
        if overlap >= 0.90:
            bucket = "0.90_to_1.00"
        elif overlap >= 0.75:
            bucket = "0.75_to_0.90"
        elif overlap >= 0.50:
            bucket = "0.50_to_0.75"
        elif overlap >= 0.25:
            bucket = "0.25_to_0.50"
        else:
            bucket = "below_0.25"
        histogram[bucket] += 1
        if overlap >= 0.50 and index >= 0:
            gt = reference[index]
            ptext = row.get("text")
            rtext = gt.get("text")
            if isinstance(ptext, str) and isinstance(rtext, str) and (
                unicodedata.normalize("NFC", ptext)
                == unicodedata.normalize("NFC", rtext)
            ):
                width_ratios.append(float(row["bbox"][2]) / float(gt["bbox"][2]))
                height_ratios.append(float(row["bbox"][3]) / float(gt["bbox"][3]))
    return {
        "best_overlap_histogram": dict(sorted(histogram.items())),
        "exact_word_best_overlap_pairs": len(width_ratios),
        "median_predicted_to_reference_width": round(statistics.median(width_ratios), 4)
        if width_ratios else None,
        "median_predicted_to_reference_height": round(statistics.median(height_ratios), 4)
        if height_ratios else None,
        "caveat": (
            "Best overlap per prediction may reuse reference boxes; "
            "use one-to-one IoU F1 for actual localization metrics."
        ),
    }


def evaluate_hypotheses(
    pages: list[tuple[list[dict[str, object]], list[dict[str, object]]]],
) -> dict[str, object]:
    if not pages:
        raise ValueError("No successfully scored pages")
    baseline_scores = [score_page(predicted, reference) for predicted, reference in pages]
    per_candidate: dict[str, dict[str, object]] = {}
    for name, (sx, sy) in CANDIDATES.items():
        scored = [
            score_page(candidate_predictions(predicted, sx, sy), reference)
            for predicted, reference in pages
        ]
        per_candidate[name] = {
            "width_scale": sx,
            "height_scale": sy,
            "scores": summarize_scores(scored),
        }
    # Baseline is evaluated independently so no candidate can silently
    # redefine it. Never interpret a higher in-sample score as approved.
    return {
        "baseline": summarize_scores(baseline_scores),
        "bbox_tightness_hypotheses": per_candidate,
        "baseline_shapes": _combine_shapes(pages),
        "candidate_scope": "in_sample_offline_diagnostics_only",
        "production_inference_modified": False,
    }


def _combine_shapes(
    pages: list[tuple[list[dict[str, object]], list[dict[str, object]]]],
) -> dict[str, object]:
    histogram: Counter[str] = Counter()
    widths: list[float] = []
    heights: list[float] = []
    for predicted, reference in pages:
        row = inspect_overlap_shapes(predicted, reference)
        histogram.update(row["best_overlap_histogram"])
        # We aggregate histograms over all pages and disclose only summary medians
        # of page medians: a descriptive statistic, not a micro/pairwise median.
        if row["median_predicted_to_reference_width"] is not None:
            widths.append(row["median_predicted_to_reference_width"])
        if row["median_predicted_to_reference_height"] is not None:
            heights.append(row["median_predicted_to_reference_height"])
    return {
        "max_iou_by_prediction_histogram": dict(sorted(histogram.items())),
        "median_of_page_median_width_ratios": round(statistics.median(widths), 4)
        if widths else None,
        "median_of_page_median_height_ratios": round(statistics.median(heights), 4)
        if heights else None,
        "note": "Best-match histogram is descriptive and can reuse ground-truth boxes.",
    }
