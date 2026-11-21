"""Exact-image and full-reference independence checks for PRIVATE OCR held-out sets.

This utility is entirely offline and does not access any OCR engine or model.
Neither digests, file paths nor reference texts are written into diagnostics.
Exact hashes cannot discover resized/cropped/rephotographed near-duplicates.
"""
from __future__ import annotations

import hashlib
from pathlib import Path

from scripts.ocr_real_photo_benchmark import Case, normalize


def _image_digest(path: Path) -> bytes:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.digest()


def _reference_digest(text: str) -> bytes:
    return hashlib.sha256(normalize(text).encode("utf-8")).digest()


def audit_exact_independence(
    development: list[Case], holdout: list[Case],
) -> dict[str, object]:
    """Fail closed if image bytes OR complete reference text overlap.

    Disjointness is a pre-inference check. It does not establish independent
    photography, labeling, non-near-duplicates, page boxes or child feedback.
    """
    if not development or not holdout:
        raise ValueError("Two nonempty photo sets are required")
    dev_image_hashes = {_image_digest(case.image) for case in development}
    dev_reference_hashes = {_reference_digest(case.truth) for case in development}
    holdout_image_hashes = [_image_digest(case.image) for case in holdout]
    holdout_reference_hashes = [_reference_digest(case.truth) for case in holdout]
    image_repeats = len(holdout_image_hashes) - len(set(holdout_image_hashes))
    reference_repeats = len(holdout_reference_hashes) - len(set(holdout_reference_hashes))
    image_overlap = len(set(holdout_image_hashes) & dev_image_hashes)
    text_overlap = len(set(holdout_reference_hashes) & dev_reference_hashes)
    if image_repeats or reference_repeats or image_overlap or text_overlap:
        # No sensitive digest, path, raw image or label appears in the error.
        raise ValueError("Held-out set contains exact duplicated photo or full text")
    return {
        "development_pages": len(development),
        "holdout_pages": len(holdout),
        "exact_image_content_overlap": 0,
        "exact_full_reference_overlap": 0,
        "within_holdout_duplicate_image_count": 0,
        "within_holdout_duplicate_reference_count": 0,
        "exact_overlap_checks_passed": True,
        "near_duplicate_images_verified": False,
        "independent_photo_provenance_verified": False,
        "reference_manual_audit_verified": False,
    }


POLICIES = (
    "tesseract_line_priority",
    "tesseract_line_vietocr_crop_agreement",
)


def summarize_holdout_report(
    ab_report: dict[str, object],
    audit: dict[str, object],
    minimum_pages: int,
) -> dict[str, object]:
    """Publish ONLY aggregate numeric diagnostics, never predicted tokens."""
    if type(minimum_pages) is not int or minimum_pages < 1:
        raise ValueError("Invalid minimum page threshold")
    tested = ab_report.get("dataset_case_count")
    successful = ab_report.get("successful_cases")
    if (
        type(tested) is not int or type(successful) is not int
        or tested < minimum_pages or successful > tested
    ):
        raise ValueError("Invalid evaluation case count")
    if not audit.get("exact_overlap_checks_passed") or audit.get("holdout_pages") != tested:
        raise ValueError("Held-out independence audit is missing")
    quality = ab_report.get("quality")
    if not isinstance(quality, dict):
        raise ValueError("Missing numerical OCR quality report")
    original = quality.get("baseline_strict")
    candidates = quality.get("ground_truth_blind_rules")
    if not isinstance(original, dict) or not isinstance(candidates, dict):
        raise ValueError("Missing strict A/B quality")
    safe_baseline = {
        key: original[key]
        for key in ("character_edits", "reference_characters", "micro_cer",
                    "word_edits", "reference_words", "micro_wer")
    }
    selected: dict[str, dict[str, object]] = {}
    for name in POLICIES:
        row = candidates.get(name)
        if not isinstance(row, dict) or not isinstance(row.get("quality"), dict):
            raise ValueError("Missing frozen candidate policy")
        stats = row["quality"]
        selected[name] = {
            "quality": {
                key: stats[key]
                for key in ("character_edits", "reference_characters", "micro_cer",
                            "word_edits", "reference_words", "micro_wer")
            },
            **{
                key: row[key] for key in (
                    "flipped_words", "corrected_words", "regressed_words",
                    "other_changed_words", "flips_without_positional_truth",
                )
            },
            "wer_page_directions": {
                direction: int(row["wer_page_directions"].get(direction, 0))
                for direction in ("improved", "unchanged", "worsened")
            },
        }

    complete = (
        successful == tested
        and ab_report.get("failed_cases") == 0
        and ab_report.get("runtime_all_cases_verified") is True
    )
    has_regression = any(item["regressed_words"] > 0 for item in selected.values())
    has_ambiguous = any(
        item["flips_without_positional_truth"] > 0
        for item in selected.values()
    )
    reasons = [
        "independent_photo_provenance_not_verified",
        "reference_manual_review_not_verified",
        "near_duplicate_detection_not_performed",
        "word_box_iou_and_child_feedback_not_tested",
    ]
    if not complete:
        reasons.append("incomplete_heldout_evaluation")
    if has_regression:
        reasons.append("observed_correct_to_wrong_regressions")
    if has_ambiguous:
        reasons.append("unresolved_positional_scoring")
    return {
        "dataset_case_count": tested,
        "successful_cases": successful,
        "failed_cases": tested - successful,
        "runtime_all_cases_verified": complete,
        "exact_overlap_audit": audit,
        "baseline_strict": safe_baseline,
        "ground_truth_blind_policies": selected,
        "scoring_note": (
            "Policy proposals are reference-blind; token correction/regression "
            "counts are positional and may be incomplete if tokens misalign."
        ),
        "heldout_exact_disjoint_verified": True,
        "independent_heldout_acceptance_verified": False,
        "production_deployment_allowed": False,
        "reason_codes": reasons,
    }
