"""Run PRIVATE, disjoint, research-only Tesseract A/B on NEW labeled photos.

Requires a NEW held-out photo manifest and a preexisting development manifest.
No photo/text/secret hashes, file paths or predictions appear in report.
Model/checkpoint and proposals remain frozen; production never changes.
"""
from __future__ import annotations

import argparse
import json
import os
import re
import sys
from pathlib import Path

BACKEND_ROOT = Path(__file__).resolve().parents[1]
if str(BACKEND_ROOT) not in sys.path:
    sys.path.insert(0, str(BACKEND_ROOT))

from scripts.ocr_real_photo_benchmark import MAX_CASES, load_cases
from scripts.ocr_tesseract_holdout_audit import (
    audit_exact_independence,
    summarize_holdout_report,
)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--development-manifest", type=Path, required=True)
    parser.add_argument("--heldout-manifest", type=Path, required=True)
    parser.add_argument("--env-file", type=Path, required=True)
    parser.add_argument("--expected-profile", required=True)
    parser.add_argument("--expected-sha", required=True)
    parser.add_argument("--min-heldout-pages", type=int, default=20)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args(argv)

    development_manifest = args.development_manifest.expanduser().resolve()
    heldout_manifest = args.heldout_manifest.expanduser().resolve()
    output = args.output.expanduser().resolve()
    repo_root = BACKEND_ROOT.parent.resolve()
    if (
        development_manifest == heldout_manifest
        or development_manifest.parent == heldout_manifest.parent
        or development_manifest.parent.is_relative_to(repo_root)
        or heldout_manifest.parent.is_relative_to(repo_root)
    ):
        parser.error("Use two separate private datasets outside Git")
    if (
        output.parent != heldout_manifest.parent
        or output.exists()
        or output.suffix.lower() != ".json"
    ):
        parser.error("Output must be a new private aggregate JSON in held-out folder")
    if not 1 <= args.min_heldout_pages <= MAX_CASES:
        parser.error("Invalid held-out page count")
    if not re.fullmatch(r"[a-f0-9]{64}", args.expected_sha):
        parser.error("Invalid frozen model checkpoint SHA")
    if not args.env_file.expanduser().is_file():
        parser.error("Missing private environment file")

    try:
        development = load_cases(development_manifest)
        holdout = load_cases(heldout_manifest)
        if len(holdout) < args.min_heldout_pages:
            raise ValueError("Not enough NEW held-out photos")
        independence = audit_exact_independence(development, holdout)
    except (OSError, ValueError) as exc:
        # Keep exception messages generic: they can contain private file paths.
        print(f"Held-out preflight rejected: {type(exc).__name__}", file=sys.stderr)
        return 2

    from dotenv import dotenv_values
    for key, value in dotenv_values(args.env_file.expanduser()).items():
        if value is not None and not (os.getenv(key) or "").strip():
            os.environ[key] = value

    try:
        # This is the ORIGINAL strict, blind A/B runner; no new word
        # selection logic or reference-guided proposal is introduced.
        from scripts.ocr_tone_blind_policy_runner import evaluate
        report = evaluate(
            holdout,
            expected_profile=args.expected_profile,
            expected_sha=args.expected_sha,
        )
        summary = summarize_holdout_report(
            report, independence, args.min_heldout_pages,
        )
    except Exception as exc:
        print(f"Held-out evaluation failed: {type(exc).__name__}", file=sys.stderr)
        return 2

    # Do not overwrite any prior report. Only counts and fixed diagnostic
    # strings are written, not image hashes, GT strings or path references.
    try:
        descriptor = os.open(output, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
        with os.fdopen(descriptor, "w", encoding="utf-8") as handle:
            json.dump(summary, handle, ensure_ascii=False, indent=2)
            handle.write("\n")
    except OSError as exc:
        print(f"Cannot store private aggregate: {type(exc).__name__}", file=sys.stderr)
        return 2
    print(json.dumps(summary, ensure_ascii=False, indent=2))
    return 0 if summary["runtime_all_cases_verified"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
