"""Create a PRIVATE, deliberately UNLABELED word-box annotation template.

This file contains local image relative paths and must never be committed.
It does NOT copy OCR predictions or ground truth into human annotations.
"""
from __future__ import annotations

import argparse
import json
import os
import sys
from pathlib import Path

BACKEND_ROOT = Path(__file__).resolve().parents[1]
if str(BACKEND_ROOT) not in sys.path:
    sys.path.insert(0, str(BACKEND_ROOT))

from scripts.ocr_real_photo_benchmark import load_cases


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("dataset", type=Path)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args(argv)

    root = args.dataset.expanduser().resolve().parent
    target = args.output.expanduser().resolve()
    if root.is_relative_to(BACKEND_ROOT.parent.resolve()):
        parser.error("Dataset must be outside repository")
    if not target.is_relative_to(root) or target.suffix.lower() != ".jsonl":
        parser.error("Template must be a .jsonl file inside private dataset directory")
    if target.exists():
        parser.error("Template already exists; choose a new filename")
    try:
        cases = load_cases(args.dataset)
    except (OSError, ValueError) as error:
        print(f"Invalid private dataset: {type(error).__name__}", file=sys.stderr)
        return 2

    try:
        target.parent.mkdir(parents=True, exist_ok=True)
        fd = os.open(target, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            for case in cases:
                # The user must fill each word+box independently and explicitly
                # attest to the manual review. No OCR-proposed boxes are copied.
                handle.write(json.dumps({
                    "image": case.image.resolve().relative_to(root).as_posix(),
                    "annotation_source": "unverified",
                    "reviewer_confirmed": False,
                    "coordinate_space": "normalized_original_dimensions",
                    "words": [],
                }, ensure_ascii=False) + "\n")
    except OSError as error:
        print(f"Could not create template: {type(error).__name__}", file=sys.stderr)
        return 2
    print(f"Created a private UNLABELED template for {len(cases)} images.")
    print("Each word box requires independent manual annotation before scoring.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
