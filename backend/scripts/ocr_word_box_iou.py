"""Independent, privacy-safe word-box IoU scoring for local ViRead acceptance.

Predicted boxes and human labels are both normalized [x,y,width,height].
Human labels MUST be created from the original photos, never copied from OCR.
This module returns numerical counts only: never return raw image names or words.
"""
from __future__ import annotations

import json
import math
import unicodedata
from collections import Counter, deque
from pathlib import Path

MAX_WORDS_PER_PAGE = 512
THRESHOLDS = (0.50, 0.75)
MAX_ANNOTATION_BYTES = 16 * 1024 * 1024


def valid_box(value: object) -> bool:
    if not isinstance(value, (list, tuple)) or len(value) != 4:
        return False
    if any(isinstance(v, bool) or not isinstance(v, (int, float)) for v in value):
        return False
    x, y, w, h = (float(v) for v in value)
    return (
        all(math.isfinite(v) for v in (x, y, w, h))
        and x >= 0 and y >= 0 and w > 0 and h > 0
        and x + w <= 1.0 + 1e-6 and y + h <= 1.0 + 1e-6
    )


def intersection_over_union(a: object, b: object) -> float:
    if not valid_box(a) or not valid_box(b):
        return 0.0
    x1, y1, w1, h1 = (float(v) for v in a)
    x2, y2, w2, h2 = (float(v) for v in b)
    iw = max(0.0, min(x1 + w1, x2 + w2) - max(x1, x2))
    ih = max(0.0, min(y1 + h1, y2 + h2) - max(y1, y2))
    inter = iw * ih
    union = w1 * h1 + w2 * h2 - inter
    return inter / union if union > 0 else 0.0


def _exact_word(word: object) -> str:
    # NFC only; keep accents, casing, punctuation and đ/d distinct.
    return unicodedata.normalize("NFC", word.strip()) if isinstance(word, str) else ""


def _maximum_cardinality(edges: list[list[int]], right_count: int) -> int:
    """Deterministic Hopcroft-Karp: each predicted box matches at most one GT."""
    left_count = len(edges)
    left_to_right = [-1] * left_count
    right_to_left = [-1] * right_count
    distance = [0] * left_count
    infinite = left_count + right_count + 1

    def breadth_first() -> bool:
        queue: deque[int] = deque()
        for u in range(left_count):
            if left_to_right[u] == -1:
                distance[u] = 0
                queue.append(u)
            else:
                distance[u] = infinite
        found = False
        while queue:
            u = queue.popleft()
            for v in edges[u]:
                other = right_to_left[v]
                if other == -1:
                    found = True
                elif distance[other] == infinite:
                    distance[other] = distance[u] + 1
                    queue.append(other)
        return found

    def depth_first(u: int) -> bool:
        for v in edges[u]:
            other = right_to_left[v]
            if other == -1 or (
                distance[other] == distance[u] + 1 and depth_first(other)
            ):
                left_to_right[u] = v
                right_to_left[v] = u
                return True
        distance[u] = infinite
        return False

    matched = 0
    while breadth_first():
        for u in range(left_count):
            if left_to_right[u] == -1 and depth_first(u):
                matched += 1
    return matched


def score_page(predicted: object, reference: object) -> dict[str, dict[str, int]]:
    """Return per-IoU-threshold micro count inputs, not text or photos.

    Geometry and exact-text+geometry are separately maximum-cardinality
    matched; the latter is constrained to NFC-exact token equality.
    Invalid predicted boxes remain in prediction denominators (false positives).
    """
    if not isinstance(predicted, list) or not isinstance(reference, list):
        raise ValueError("Word-box input is not a list")
    if not reference or len(predicted) > MAX_WORDS_PER_PAGE or len(reference) > MAX_WORDS_PER_PAGE:
        raise ValueError("Empty or excessive word-box records")
    if any(not isinstance(row, dict) for row in reference):
        raise ValueError("Invalid reference word record")
    if any(
        not valid_box(row.get("bbox"))
        or len(_exact_word(row.get("text")).split()) != 1
        for row in reference
    ):
        raise ValueError("Reference box or text is invalid")

    results: dict[str, dict[str, int]] = {}
    for threshold in THRESHOLDS:
        geo_edges: list[list[int]] = []
        word_edges: list[list[int]] = []
        for predicted_word in predicted:
            geo: list[tuple[float, int]] = []
            exact: list[tuple[float, int]] = []
            if isinstance(predicted_word, dict):
                box = predicted_word.get("bbox")
                if valid_box(box):
                    for index, reference_word in enumerate(reference):
                        overlap = intersection_over_union(box, reference_word["bbox"])
                        if overlap + 1e-12 >= threshold:
                            geo.append((overlap, index))
                            if _exact_word(predicted_word.get("text")) == _exact_word(reference_word["text"]):
                                exact.append((overlap, index))
            geo_edges.append([i for _, i in sorted(geo, key=lambda p: (-p[0], p[1]))])
            word_edges.append([i for _, i in sorted(exact, key=lambda p: (-p[0], p[1]))])
        results[f"{threshold:.2f}"] = {
            "predicted": len(predicted),
            "reference": len(reference),
            "geometry_tp": _maximum_cardinality(geo_edges, len(reference)),
            "strict_word_position_tp": _maximum_cardinality(word_edges, len(reference)),
        }
    return results


def _score_counts(predicted: int, reference: int, tp: int) -> dict[str, int | float]:
    precision = tp / predicted if predicted else 0.0
    recall = tp / reference if reference else 0.0
    return {
        "tp": tp, "fp": predicted - tp, "fn": reference - tp,
        "precision": round(precision, 6),
        "recall": round(recall, 6),
        "f1": round(2 * precision * recall / (precision + recall), 6)
        if precision + recall else 0.0,
    }


def summarize_scores(rows: list[dict[str, dict[str, int]]]) -> dict[str, object]:
    summary: dict[str, object] = {}
    for threshold in THRESHOLDS:
        key = f"{threshold:.2f}"
        counts: Counter[str] = Counter()
        for row in rows:
            counts.update(row[key])
        predicted, reference = counts["predicted"], counts["reference"]
        summary[key] = {
            "predicted_words": predicted,
            "reference_words": reference,
            "geometry": _score_counts(predicted, reference, counts["geometry_tp"]),
            "strict_word_and_geometry": _score_counts(
                predicted, reference, counts["strict_word_position_tp"]
            ),
        }
    return summary


def load_manual_annotations(path: Path, image_keys: set[str]) -> dict[str, list[dict[str, object]]]:
    """Validate independent JSONL; no private values in raised exception text.

    Each line:
    {"image":"images/p01.jpg","annotation_source":"manual_independent",
     "reviewer_confirmed":true,"coordinate_space":"normalized_original_dimensions",
     "words":[{"text":"Bé","bbox":[0.1,0.2,0.1,0.05]}]}
    """
    if not path.is_file() or path.stat().st_size > MAX_ANNOTATION_BYTES:
        raise ValueError("Missing or oversize manual annotation file")
    annotations: dict[str, list[dict[str, object]]] = {}
    try:
        with path.open("r", encoding="utf-8-sig") as handle:
            for raw in handle:
                if not raw.strip():
                    continue
                data = json.loads(raw)
                if not isinstance(data, dict):
                    raise ValueError("Invalid annotation row")
                key = data.get("image")
                if not isinstance(key, str) or key not in image_keys or key in annotations:
                    raise ValueError("Duplicate, missing or unexpected image annotation")
                if (
                    data.get("annotation_source") != "manual_independent"
                    or data.get("reviewer_confirmed") is not True
                    or data.get("coordinate_space") != "normalized_original_dimensions"
                ):
                    raise ValueError("Manual independent review declaration required")
                words = data.get("words")
                if not isinstance(words, list) or not 0 < len(words) <= MAX_WORDS_PER_PAGE:
                    raise ValueError("Manual word annotations missing or too large")
                if any(
                    not isinstance(word, dict)
                    or not valid_box(word.get("bbox"))
                    or len(_exact_word(word.get("text")).split()) != 1
                    for word in words
                ):
                    raise ValueError("Manual word box annotation invalid")
                annotations[key] = words
    except (UnicodeError, OSError, json.JSONDecodeError) as exc:
        raise ValueError("Manual annotation file could not be parsed") from exc
    if annotations.keys() != image_keys:
        raise ValueError("Annotations incomplete for supplied dataset")
    return annotations
