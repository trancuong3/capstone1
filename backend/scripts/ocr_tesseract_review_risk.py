"""Pure, counts-only risk assessment for the PRIVATE Tesseract flip review.

This module does not read images, OCR predictions, GT text, or credentials.
It never approves a production policy: the existing 10-page A/B data is an
in-sample, positionally scored research diagnostic, not held-out acceptance.
"""
from __future__ import annotations

REVIEW_RULES = (
    "tesseract_line_priority",
    "tesseract_line_vietocr_crop_agreement",
)
KINDS = ("corrected", "regressed", "changed_other", "ambiguous")


def _nonnegative_int(value: object) -> int:
    if type(value) is not int or value < 0:
        raise ValueError("Invalid numeric review count")
    return value


def assess_review_risk(aggregate: dict[str, object]) -> dict[str, object]:
    """Reject inconsistent count data; return no private tokens or page images."""
    records = aggregate.get("policy_flip_review_counts")
    if not isinstance(records, dict):
        raise ValueError("Missing policy review counts")
    successful = _nonnegative_int(aggregate.get("successful_pages"))
    total = _nonnegative_int(aggregate.get("dataset_pages"))
    failed = _nonnegative_int(aggregate.get("failed_pages"))
    if successful + failed != total:
        raise ValueError("Inconsistent page count")

    per_policy: dict[str, dict[str, object]] = {}
    for name in REVIEW_RULES:
        record = records.get(name)
        if not isinstance(record, dict):
            raise ValueError("Missing research policy result")
        flips = _nonnegative_int(record.get("flips"))
        kinds = {key: _nonnegative_int(record.get(key)) for key in KINDS}
        if sum(kinds.values()) != flips:
            raise ValueError("Policy flip totals do not reconcile")
        per_policy[name] = {
            "flips": flips,
            "confirmed_corrected_by_position": kinds["corrected"],
            "confirmed_regressed_by_position": kinds["regressed"],
            "changed_but_still_incorrect_by_position": kinds["changed_other"],
            "ambiguous_position": kinds["ambiguous"],
            "review_required": (
                kinds["regressed"] + kinds["changed_other"] + kinds["ambiguous"]
            ),
            "regression_fraction_of_flips": (
                round(kinds["regressed"] / flips, 6) if flips else None
            ),
            "correction_fraction_of_flips": (
                round(kinds["corrected"] / flips, 6) if flips else None
            ),
            "eligible_for_production": False,
        }
    reasons = ["not_independent_held_out", "word_boxes_not_verified"]
    if failed or total == 0:
        reasons.append("incomplete_benchmark")
    if any(entry["confirmed_regressed_by_position"] for entry in per_policy.values()):
        reasons.append("correct_to_wrong_regressions")
    if any(entry["ambiguous_position"] for entry in per_policy.values()):
        reasons.append("unresolved_token_alignment")
    return {
        "production_deployment_allowed": False,
        "reason_codes": reasons,
        "scoring_is_positional_diagnostic_only": True,
        "independent_human_review_completed": False,
        "per_policy": per_policy,
    }
