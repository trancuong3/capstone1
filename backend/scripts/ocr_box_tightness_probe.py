"""Local-only box-tightness probe against synthetic or independent manual labels.

Writes numeric aggregates; optional overlays contain private photo pixels and
MUST remain under the private dataset folder. Never upload overlays or labels.
This runner does not tune or mutate the production OCR engine.
"""
from __future__ import annotations

import argparse
import json
import os
import re
import sys
from collections import Counter
from pathlib import Path

BACKEND_ROOT = Path(__file__).resolve().parents[1]
if str(BACKEND_ROOT) not in sys.path:
    sys.path.insert(0, str(BACKEND_ROOT))

from scripts.ocr_box_tightness import evaluate_hypotheses
from scripts.ocr_real_photo_benchmark import MAX_CASES, REQUIRED_ENGINES, Case, load_cases
from scripts.ocr_word_box_iou import (
    MAX_ANNOTATION_BYTES, MAX_WORDS_PER_PAGE,
    load_manual_annotations, score_page,
)

EXPECTED_SOURCE = ("synthetic_renderer", "manual_independent")


def load_renderer_labels(
    path: Path, image_keys: set[str],
) -> dict[str, list[dict[str, object]]]:
    """Accept ONLY renderer-declared nonhuman ground truth, fail closed."""
    if not path.is_file() or path.stat().st_size > MAX_ANNOTATION_BYTES:
        raise ValueError("Missing or oversized reference file")
    output: dict[str, list[dict[str, object]]] = {}
    try:
        with path.open("r", encoding="utf-8-sig") as handle:
            for line in handle:
                if not line.strip():
                    continue
                row = json.loads(line)
                if not isinstance(row, dict):
                    raise ValueError("Malformed renderer label row")
                key = row.get("image")
                if (
                    not isinstance(key, str) or key not in image_keys
                    or key in output
                    or row.get("annotation_source") != "synthetic_renderer"
                    or row.get("reviewer_confirmed") is not False
                    or row.get("coordinate_space") != "normalized_original_dimensions"
                ):
                    raise ValueError("Invalid synthetic annotation source")
                words = row.get("words")
                if not isinstance(words, list) or not 0 < len(words) <= MAX_WORDS_PER_PAGE:
                    raise ValueError("Missing or oversized renderer word boxes")
                # scorer performs reference box/type/single-token validation.
                score_page([], words)
                output[key] = words
    except (OSError, UnicodeError, json.JSONDecodeError) as exc:
        raise ValueError("Renderer annotations cannot be parsed") from exc
    if output.keys() != image_keys:
        raise ValueError("Renderer annotations do not cover every image")
    return output


def verify_ocr_output(
    output: object, *, expected_profile: str, expected_sha: str,
) -> list[dict[str, object]]:
    if not isinstance(output, dict) or not isinstance(output.get("words"), list):
        raise ValueError("Missing OCR words")
    metadata = output.get("metadata")
    if not isinstance(metadata, dict):
        raise ValueError("Missing OCR metadata")
    statuses = metadata.get("engine_statuses")
    if not isinstance(statuses, dict) or any(
        statuses.get(name) != "success" for name in REQUIRED_ENGINES
    ):
        raise ValueError("Engine contract failed")
    provenance = metadata.get("vietocr_runtime_provenance")
    if not isinstance(provenance, dict) or (
        provenance.get("model_load_status") != "loaded"
        or provenance.get("model_inference_status") != "success"
        or provenance.get("fallback_reason") is not None
        or provenance.get("model_profile") != expected_profile
        or provenance.get("checkpoint_sha256") != expected_sha
    ):
        raise ValueError("Model provenance failed")
    return output["words"]


def write_overlay(
    image: Path, predicted: list[dict[str, object]],
    reference: list[dict[str, object]], target: Path,
) -> None:
    """Private image overlay; never draws OCR tokens or reference word text."""
    from PIL import Image, ImageDraw
    from scripts.ocr_word_box_iou import valid_box

    with Image.open(image) as source:
        canvas = source.convert("RGB")
    draw = ImageDraw.Draw(canvas)
    width, height = canvas.size
    for words, color in ((reference, (220, 50, 50)), (predicted, (0, 160, 245))):
        for row in words:
            if not isinstance(row, dict) or not valid_box(row.get("bbox")):
                continue
            x, y, w, h = row["bbox"]
            draw.rectangle(
                (round(x * width), round(y * height),
                 round((x + w) * width), round((y + h) * height)),
                outline=color, width=2,
            )
    # Never paint a legend over word boxes: even a small banner can hide
    # legitimate labels near the top-left corner, especially on small pages.
    # Color conventions are documented outside the private image.
    canvas.save(target, format="PNG")


def evaluate(
    cases: list[Case],
    reference_labels: dict[str, list[dict[str, object]]],
    root: Path,
    *,
    expected_profile: str,
    expected_sha: str,
    overlay_dir: Path | None = None,
) -> dict[str, object]:
    # On the user's Windows CUDA environment importing torch first avoids
    # PaddleOCR/PyTorch DLL import-order problems.
    import torch  # noqa: F401
    from app.services.ocr_engine import extract_text_and_boxes

    pages: list[tuple[list[dict[str, object]], list[dict[str, object]]]] = []
    failure_types: Counter[str] = Counter()
    conditions: Counter[str] = Counter()
    for index, case in enumerate(cases, 1):
        try:
            words = verify_ocr_output(
                extract_text_and_boxes(case.image.read_bytes()),
                expected_profile=expected_profile,
                expected_sha=expected_sha,
            )
            key = case.image.resolve().relative_to(root).as_posix()
            reference = reference_labels[key]
            # Fail on invalid labels/predictions BEFORE including page in metrics.
            score_page(words, reference)
            if overlay_dir is not None:
                write_overlay(
                    case.image, words, reference,
                    overlay_dir / f"page_{index:04}.png",
                )
            pages.append((words, reference))
            conditions[case.condition] += 1
        except Exception as exc:
            # Exception strings and tracebacks can contain private file names.
            failure_types[type(exc).__name__] += 1

    return {
        "dataset_case_count": len(cases),
        "successful_cases": len(pages),
        "failed_cases": len(cases) - len(pages),
        "failure_exception_types": dict(sorted(failure_types.items())),
        "conditions_case_counts": dict(sorted(conditions.items())),
        "results": evaluate_hypotheses(pages) if pages else None,
        "model_profile_counts": {expected_profile: len(pages)},
        "checkpoint_sha256_counts": {expected_sha: len(pages)},
        "real_photo_provenance_independently_verified": False,
        "annotation_review_independently_verified": False,
        "reading_color_acceptance_not_measured": True,
        "quality_thresholds_predeclared": False,
        "all_runtime_checks_passed": len(pages) == len(cases),
    }


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("dataset", type=Path, help="Private pages.jsonl")
    parser.add_argument("--reference-labels", required=True, type=Path)
    parser.add_argument("--reference-kind", required=True, choices=EXPECTED_SOURCE)
    parser.add_argument("--env-file", type=Path)
    parser.add_argument("--expected-profile", required=True)
    parser.add_argument("--expected-sha", required=True)
    parser.add_argument("--min-pages", type=int, default=10)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--overlay-dir", type=Path, help="Private NEW directory for annotated PNGs")
    args = parser.parse_args(argv)

    root = args.dataset.expanduser().resolve().parent
    repo = BACKEND_ROOT.parent.resolve()
    label_path = args.reference_labels.expanduser().resolve()
    output_path = args.output.expanduser().resolve()
    overlays = args.overlay_dir.expanduser().resolve() if args.overlay_dir else None
    if root.is_relative_to(repo):
        parser.error("Private dataset must be outside repository")
    if not 1 <= args.min_pages <= MAX_CASES:
        parser.error("--min-pages must be between 1 and 1000")
    if not re.fullmatch(r"[a-f0-9]{64}", args.expected_sha):
        parser.error("--expected-sha must be 64 lowercase SHA256 hex characters")
    if label_path == args.dataset.expanduser().resolve() or label_path.suffix.lower() != ".jsonl" or not label_path.is_relative_to(root):
        parser.error("Reference labels must be a separate private .jsonl file")
    if not output_path.is_relative_to(root) or output_path.suffix.lower() != ".json" or output_path.exists():
        parser.error("Aggregate output must be a NEW .json inside private dataset directory")
    if output_path == label_path:
        parser.error("Do not replace reference labels")
    if overlays is not None and (not overlays.is_relative_to(root) or overlays.exists()):
        parser.error("Overlay output must be a NEW folder within private dataset directory")
    if args.env_file is not None and not args.env_file.expanduser().is_file():
        parser.error("Existing --env-file required")

    try:
        cases = load_cases(args.dataset)
        if len(cases) < args.min_pages:
            raise ValueError("Too few photographed or synthetic pages")
        keys = {case.image.resolve().relative_to(root).as_posix() for case in cases}
        if args.reference_kind == "synthetic_renderer":
            labels = load_renderer_labels(label_path, keys)
        else:
            labels = load_manual_annotations(label_path, keys)
    except (OSError, ValueError) as exc:
        print(f"Invalid dataset/labels: {type(exc).__name__}", file=sys.stderr)
        return 2

    if args.env_file is not None:
        from dotenv import dotenv_values

        for key, value in dotenv_values(args.env_file.expanduser()).items():
            if value is not None and not (os.getenv(key) or "").strip():
                os.environ[key] = value

    if overlays is not None:
        try:
            overlays.mkdir(parents=True, mode=0o700)
        except OSError as exc:
            print(f"Cannot create private overlay directory: {type(exc).__name__}", file=sys.stderr)
            return 2
    report = evaluate(
        cases, labels, root,
        expected_profile=args.expected_profile,
        expected_sha=args.expected_sha,
        overlay_dir=overlays,
    )
    report["reference_kind"] = args.reference_kind
    report["human_annotated"] = args.reference_kind == "manual_independent"
    report["real_photo_acceptance"] = False
    encoded = json.dumps(report, indent=2, ensure_ascii=False) + "\n"
    try:
        output_path.parent.mkdir(parents=True, exist_ok=True)
        fd = os.open(output_path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            handle.write(encoded)
    except OSError as exc:
        print(f"Could not write aggregate output: {type(exc).__name__}", file=sys.stderr)
        return 2
    print(encoded)
    return 0 if report["all_runtime_checks_passed"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
