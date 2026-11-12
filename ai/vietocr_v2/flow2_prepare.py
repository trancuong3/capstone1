from __future__ import annotations

import argparse
import json
import math
import sys
import unicodedata
from pathlib import Path
from typing import Any, Callable

from PIL import Image

from .contracts import DatasetRow, sha256_file, stable_split, write_jsonl


def _box_bounds(box: Any) -> tuple[float, float, float, float]:
    points = list(box)
    if len(points) < 4:
        raise ValueError("detector returned an invalid quadrilateral")
    xs = [float(point[0]) for point in points]
    ys = [float(point[1]) for point in points]
    bounds = min(xs), min(ys), max(xs), max(ys)
    if not all(math.isfinite(value) for value in bounds):
        raise ValueError("detector returned non-finite coordinates")
    if bounds[2] <= bounds[0] or bounds[3] <= bounds[1]:
        raise ValueError("detector returned a zero-area text box")
    return bounds


def _iou(left: tuple[float, float, float, float], right: tuple[float, float, float, float]) -> float:
    x1, y1 = max(left[0], right[0]), max(left[1], right[1])
    x2, y2 = min(left[2], right[2]), min(left[3], right[3])
    intersection = max(0.0, x2 - x1) * max(0.0, y2 - y1)
    left_area = max(0.0, left[2] - left[0]) * max(0.0, left[3] - left[1])
    right_area = max(0.0, right[2] - right[0]) * max(0.0, right[3] - right[1])
    union = left_area + right_area - intersection
    return intersection / union if union else 0.0


def match_external_annotations(
    annotations: list[dict[str, Any]], detector: Callable[[str], list[Any]], output_dir: str | Path,
    *, min_iou: float = 0.35, ambiguity_margin: float = 0.10,
) -> tuple[list[DatasetRow], list[dict[str, Any]]]:
    """Match external human line boxes one-to-one with DBNet proposals; ambiguous items go to review."""
    target = Path(output_dir)
    target.mkdir(parents=True, exist_ok=True)
    grouped: dict[str, list[dict[str, Any]]] = {}
    for annotation in annotations:
        image = str(annotation.get("image", "")).strip()
        if not image or not annotation.get("annotation_id") or not annotation.get("group_id"):
            raise ValueError("each external annotation needs image, annotation_id, and group_id")
        if not annotation.get("verified") is True:
            raise ValueError("external ground truth must be explicitly human-verified")
        bbox = annotation.get("bbox")
        if not isinstance(bbox, list) or len(bbox) != 4:
            raise ValueError("external line annotations require an explicit [x1,y1,x2,y2] box")
        label = unicodedata.normalize("NFC", str(annotation.get("label", "")).strip())
        if not label:
            raise ValueError("external annotation label is blank")
        grouped.setdefault(image, []).append({**annotation, "bbox": [float(v) for v in bbox], "label": label})

    rows: list[DatasetRow] = []
    review: list[dict[str, Any]] = []
    for image_path, line_annotations in grouped.items():
        with Image.open(image_path) as page:
            page = page.convert("RGB")
            detected = []
            for candidate in detector(image_path):
                try:
                    x1, y1, x2, y2 = _box_bounds(candidate)
                except (TypeError, ValueError, IndexError):
                    continue
                bounds = (max(0.0, x1), max(0.0, y1), min(float(page.width), x2), min(float(page.height), y2))
                if bounds[2] - bounds[0] >= 8 and bounds[3] - bounds[1] >= 8:
                    detected.append(bounds)
            used: set[int] = set()
            for annotation in line_annotations:
                ann_x1, ann_y1, ann_x2, ann_y2 = annotation["bbox"]
                if (not all(math.isfinite(value) for value in annotation["bbox"])
                        or ann_x2 <= ann_x1 or ann_y2 <= ann_y1
                        or ann_x1 < 0 or ann_y1 < 0 or ann_x2 > page.width or ann_y2 > page.height):
                    review.append({"image": image_path, "annotation_id": annotation["annotation_id"],
                                   "reason": "invalid_annotation_box"})
                    continue
                scores = sorted(((_iou(tuple(annotation["bbox"]), box), index) for index, box in enumerate(detected)), reverse=True)
                best = scores[0] if scores else (0.0, -1)
                second = scores[1][0] if len(scores) > 1 else 0.0
                reason = None
                if best[0] < min_iou:
                    reason = "no_confident_dbnet_match"
                elif best[0] - second < ambiguity_margin:
                    reason = "ambiguous_dbnet_match"
                elif best[1] in used:
                    reason = "dbnet_box_already_matched"
                if reason:
                    review.append({"image": image_path, "annotation_id": annotation["annotation_id"], "reason": reason,
                                   "best_iou": best[0], "second_iou": second})
                    continue
                used.add(best[1])
                x1, y1, x2, y2 = detected[best[1]]
                pad = max(2, round((y2 - y1) * 0.08))
                crop_box = (max(0, math.floor(x1)), max(0, math.floor(y1 - pad)),
                            min(page.width, math.ceil(x2)), min(page.height, math.ceil(y2 + pad)))
                if crop_box[2] - crop_box[0] < 8 or crop_box[3] - crop_box[1] < 8:
                    review.append({"image": image_path, "annotation_id": annotation["annotation_id"],
                                   "reason": "invalid_dbnet_crop"})
                    continue
                crop = page.crop(crop_box)
                crop_path = target / "flow1_external" / annotation["annotation_id"] / "line.png"
                crop_path.parent.mkdir(parents=True, exist_ok=True)
                crop.save(crop_path, format="PNG")
                relative = crop_path.resolve().as_posix()
                rows.append(DatasetRow(relative, annotation["label"], str(annotation["group_id"]), "FLOW2_EXTERNAL",
                                       stable_split(str(annotation["group_id"])), sha256_file(crop_path), True,
                                       str(annotation["annotation_id"])))
    return rows, review


def _load_dbnet_detector() -> Callable[[str], list[Any]]:
    # Uses the already-pinned PaddleOCR detector and never consumes its recognition output as ground truth.
    backend_root = Path(__file__).resolve().parents[2] / "backend"
    if str(backend_root) not in sys.path:
        sys.path.insert(0, str(backend_root))
    from app.services.ocr_engine import _get_ocr_engines  # type: ignore[import-not-found]

    engine, _ = _get_ocr_engines()
    if not hasattr(engine, "text_detector"):
        raise RuntimeError("The configured PaddleOCR detector does not expose text_detector")

    def detect(path: str) -> list[Any]:
        import cv2

        image = cv2.imread(path)
        if image is None:
            raise ValueError(f"could not read image: {path}")
        boxes, _ = engine.text_detector(image)
        return list(boxes) if boxes is not None else []

    return detect


def main() -> None:
    parser = argparse.ArgumentParser(description="Prepare Flow 1 real-data labels with DBNet proposal matching")
    parser.add_argument("--annotations", required=True, help="JSON array: verified image/line-box/label annotations")
    parser.add_argument("--output", required=True, help="Output folder for line crops and JSONL manifest")
    args = parser.parse_args()
    annotations = json.loads(Path(args.annotations).read_text(encoding="utf-8"))
    rows, review = match_external_annotations(annotations, _load_dbnet_detector(), args.output)
    manifest = Path(args.output) / "flow1_external.jsonl"
    digest = write_jsonl(manifest, rows)
    review_path = Path(args.output) / "needs_review.json"
    review_path.write_text(json.dumps(review, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps({"manifest": str(manifest), "sha256": digest, "accepted": len(rows), "needs_review": len(review)}))


if __name__ == "__main__":
    main()
