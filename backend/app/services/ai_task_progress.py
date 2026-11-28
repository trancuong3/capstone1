"""Pure, deterministic `%` progress calculation helpers for all async ViRead AI pipelines.

Every queued, waiting, running, or completed AI task exposes a finite numeric
`progress_pct` in `[0.0, 100.0]` so the UI can always render a truthful progress bar
without ever appearing hung at an indeterminate spinner.
"""

from __future__ import annotations

import json
import math
from typing import Any, Literal

ProgressMode = Literal["measured", "staged"]

_STUDIO_RUNNING_STAGE_PCT: dict[str, float] = {
    "QUEUED": 15.0,
    "PROCESSING": 25.0,
    "STYLE_BIBLE": 25.0,
    "STYLE_ANALYSIS": 30.0,
    "BOUNDARY_DETECT": 35.0,
    "OCR": 50.0,
    "OCR_EXTRACT": 60.0,
    "IMAGE_GENERATING": 50.0,
    "COVER": 55.0,
    "COVER_GEN": 55.0,
    "ILLUSTRATION": 55.0,
    "ILLUSTRATION_EXTRACT": 55.0,
    "ILLUSTRATION_GEN": 55.0,
    "PROOFREADING": 60.0,
    "TEXT_FREE_VERIFY": 78.0,
    "CHILD_SAFETY": 80.0,
    "TOOL_CHECK": 80.0,
    "SAVING": 90.0,
    "FINALIZING": 90.0,
    "BATCH_BOOK_IMPORT": 30.0,
}

_OCR_PHASE_PCT: dict[str, float] = {
    "downloading": 30.0,
    "fetch": 30.0,
    "fetching": 30.0,
    "loading_image": 30.0,
    "preprocessing": 40.0,
    "preprocess": 40.0,
    "deskew": 40.0,
    "detecting": 52.0,
    "detection": 52.0,
    "layout": 52.0,
    "craft": 52.0,
    "paddle_det": 52.0,
    "recognizing": 76.0,
    "recognition": 76.0,
    "vietocr": 76.0,
    "ocr": 76.0,
    "inferencing": 76.0,
    "postprocessing": 90.0,
    "postprocess": 90.0,
    "finalizing": 90.0,
    "uploading": 90.0,
    "saving": 90.0,
}

_KARAOKE_STAGE_PCT: dict[str, float] = {
    "QUEUED": 8.0,
    "VALIDATING_INPUT": 20.0,
    "PREPARING_AUDIO": 45.0,
    "ALIGNING_LYRICS": 75.0,
    "VALIDATING_RESULT": 92.0,
    "COMPLETE": 100.0,
}

_TRAINING_STATUS_PCT: dict[str, float] = {
    "QUEUED": 5.0,
    "PENDING": 5.0,
    "WAITING_FOR_COLAB_WORKER": 4.0,
    "CLAIMED": 12.0,
    "DISPATCHED": 12.0,
    "STARTING": 15.0,
    "PREPARING": 20.0,
    "PREPARING_DATASET": 20.0,
    "EXPORTING_DATASET": 20.0,
    "TRAINING": 45.0,
    "RUNNING": 45.0,
    "COLAB_RUNNING": 45.0,
    "LOCAL_RUNNING": 45.0,
    "EVALUATING": 82.0,
    "BENCHMARKING": 82.0,
    "UPLOADING": 92.0,
    "FINALIZING": 92.0,
    "SUCCEEDED": 100.0,
    "COMPLETED": 100.0,
    "BENCHMARKED": 100.0,
    "PROMOTED": 100.0,
    "FAILED": 0.0,
    "CANCELLED": 0.0,
    "DEAD_LETTER": 0.0,
}


def clamp_pct(value: float) -> float:
    if not math.isfinite(value):
        return 0.0
    return round(max(0.0, min(100.0, float(value))), 1)


def _finite_float(value: Any) -> float | None:
    if value is None or isinstance(value, bool):
        return None
    try:
        parsed = float(value)
    except (TypeError, ValueError, OverflowError):
        return None
    return parsed if math.isfinite(parsed) else None


def compute_studio_job_progress(
    *,
    status: str | None,
    stage: str | None,
    completed: int | None,
    total: int | None,
    unit: str | None = None,
) -> tuple[int | None, int | None, str | None, float, bool, ProgressMode]:
    """Return `(completed, total, unit, progress_pct, is_indeterminate, progress_mode)`."""
    norm_status = str(status or "QUEUED").strip().upper()
    norm_stage = str(stage or "QUEUED").strip().upper()

    if completed is not None and total is not None and int(total) > 0:
        safe_total = int(total)
        safe_completed = max(0, min(int(completed), safe_total))
        pct = 100.0 if norm_status == "SUCCEEDED" else clamp_pct((safe_completed / safe_total) * 100.0)
        return safe_completed, safe_total, unit, pct, False, "measured"

    if norm_status == "SUCCEEDED":
        pct = 100.0
    elif norm_status == "WAITING_FOR_REVIEW":
        pct = 95.0
    elif norm_status == "PARTIAL_SUCCESS":
        pct = 90.0
    elif norm_status == "WAITING_FOR_WORKER":
        pct = 2.0
    elif norm_status == "QUEUED":
        pct = 5.0
    elif norm_status in ("WAITING_FOR_QUOTA", "RETRY_SCHEDULED"):
        pct = 10.0
    elif norm_status in ("RUNNING", "CANCEL_REQUESTED"):
        pct = _STUDIO_RUNNING_STAGE_PCT.get(norm_stage, 40.0)
    else:
        pct = 0.0

    return None, None, unit, clamp_pct(pct), False, "staged"


def extract_ocr_worker_phase(processing_meta: Any) -> str | None:
    if not isinstance(processing_meta, dict):
        return None
    raw = processing_meta.get("worker_phase")
    if isinstance(raw, str) and raw.strip():
        return raw.strip()[:64]
    return None


def compute_ocr_job_progress(
    *,
    status: str | None,
    worker_phase: str | None = None,
    worker_online: bool | None = None,
) -> tuple[float, ProgressMode]:
    """Map an `OcrInferenceJob` status + optional `worker_phase` into deterministic staged `%`."""
    norm_status = str(status or "QUEUED").strip().upper()
    norm_phase = str(worker_phase or "").strip().lower()

    if norm_status == "SUCCEEDED":
        return 100.0, "staged"
    if norm_status in ("DEAD_LETTER", "FAILED", "CANCELLED"):
        return 0.0, "staged"
    if norm_status == "WAITING_FOR_WORKER":
        return 2.0, "staged"
    if norm_status == "QUEUED":
        return (2.0 if worker_online is False else 8.0), "staged"
    if norm_status in ("FAILED_RETRYABLE", "RETRY_SCHEDULED"):
        return 12.0, "staged"
    if norm_status == "CLAIMED":
        return 18.0, "staged"
    if norm_status == "RUNNING":
        if norm_phase in _OCR_PHASE_PCT:
            return _OCR_PHASE_PCT[norm_phase], "staged"
        for marker, pct in _OCR_PHASE_PCT.items():
            if marker in norm_phase:
                return pct, "staged"
        return 50.0, "staged"
    return 8.0, "staged"


def compute_admin_workflow_progress(
    *,
    status: str | None,
    stage: str | None,
    completed_chunks: int | None = 0,
    total_chunks: int | None = 0,
) -> tuple[float, ProgressMode]:
    """Compute monotonic 2-phase `%` for `AdminAiWorkflow` (never resets 100% -> 0% across stages)."""
    norm_status = str(status or "QUEUED").strip().upper()
    norm_stage = str(stage or "PROOFREADING").strip().upper()
    safe_total = max(0, int(total_chunks or 0))
    safe_done = max(0, min(int(completed_chunks or 0), safe_total)) if safe_total > 0 else 0
    ratio = (safe_done / safe_total) if safe_total > 0 else 0.0
    mode: ProgressMode = "measured" if safe_total > 1 else "staged"

    if norm_status in (
        "READY_FOR_ADMIN_REVIEW",
        "READY_FOR_REVIEW",
        "NEEDS_REVIEW",
        "APPROVED",
        "COMPLETED",
        "VERIFIED",
    ):
        return 100.0, mode
    if norm_status == "FAILED":
        return (50.0 if "SAFETY" in norm_stage else 15.0), "staged"
    if norm_status in ("CANCELLED", "STALE"):
        return 0.0, "staged"

    in_safety = "SAFETY" in norm_stage or norm_status == "CHILD_SAFETY_SCANNING"
    if in_safety:
        if norm_status == "QUEUED":
            return 55.0, "staged"
        return clamp_pct(55.0 + 40.0 * ratio), mode

    if norm_status == "QUEUED":
        return 5.0, "staged"
    return clamp_pct(10.0 + 45.0 * ratio), mode


def compute_parent_submission_progress(
    *,
    workflow_status: str | None,
    ocr_status: str | None,
    proofread_status: str | None,
    tool_check_status: str | None,
    is_image_only: bool = False,
    linked_ocr_status: str | None = None,
    linked_ocr_worker_phase: str | None = None,
    worker_online: bool | None = None,
) -> tuple[int, int, float, ProgressMode]:
    """Compute continuous 3-stage `%` for `ParentBookPageSubmission` (merging live OCR phase)."""
    wf = str(workflow_status or "CHECKING").strip().upper()
    ocr = str(ocr_status or "PENDING").strip().upper()
    proof = str(proofread_status or "PENDING").strip().upper()
    tool = str(tool_check_status or "PENDING").strip().upper()

    ocr_done = ocr in ("COMPLETED", "NO_TEXT_DETECTED")
    proof_done = proof in ("COMPLETED", "SKIPPED") or bool(is_image_only)
    tool_done = tool in ("PASSED", "FLAGGED", "NEEDS_MANUAL_REVIEW")
    stages_done = int(ocr_done) + int(proof_done) + int(tool_done)

    if wf in ("PASSED_READY_TO_ADD", "APPROVED_READY_TO_ADD", "COMMITTED", "ADDED_TO_BOOK"):
        return 3, 3, 100.0, "measured"
    if wf in ("NEEDS_ADMIN_REVIEW", "PENDING_ADMIN_REVIEW", "PENDING_ADMIN"):
        if tool_done:
            return 3, 3, 100.0, "staged"
        return stages_done, 3, 95.0, "staged"
    if wf in ("CHECK_FAILED", "REJECTED", "CANCELLED"):
        return stages_done, 3, clamp_pct((stages_done / 3.0) * 100.0), "staged"

    if not ocr_done:
        if linked_ocr_status:
            linked_norm = str(linked_ocr_status).strip().upper()
            if linked_norm in ("QUEUED", "FAILED_RETRYABLE") and worker_online is False:
                return 0, 3, 2.0, "staged"
            ocr_pct, _ = compute_ocr_job_progress(
                status=linked_norm,
                worker_phase=linked_ocr_worker_phase,
                worker_online=worker_online,
            )
            return 0, 3, clamp_pct(max(4.0, min(34.0, ocr_pct * 0.34))), "staged"
        if ocr == "RUNNING":
            return 0, 3, 20.0, "staged"
        if ocr == "PENDING" and worker_online is False:
            return 0, 3, 2.0, "staged"
        return 0, 3, 8.0, "staged"

    if not proof_done:
        return 1, 3, (52.0 if proof == "RUNNING" else 38.0), "staged"

    if not tool_done:
        return 2, 3, (82.0 if tool == "RUNNING" else 67.0), "staged"

    return 3, 3, 100.0, "measured"


def compute_quality_scan_progress(
    *,
    status: str | None,
    completed_pages: int | None = 0,
    skipped_pages: int | None = 0,
    failed_pages: int | None = 0,
    total_pages: int | None = 0,
) -> float:
    """Compute numeric `%` progress for `BookQualityScanRun`."""
    st = str(status or "QUEUED").strip().upper()
    if st in ("COMPLETED", "PARTIAL"):
        return 100.0
    if st == "QUEUED":
        return 5.0
    safe_total = max(0, int(total_pages or 0))
    processed = (
        max(0, int(completed_pages or 0))
        + max(0, int(skipped_pages or 0))
        + max(0, int(failed_pages or 0))
    )
    if st == "RUNNING":
        if safe_total > 0:
            raw = clamp_pct(min(99.0, (min(processed, safe_total) / safe_total) * 100.0))
            return max(10.0, raw)
        return 15.0
    if st in ("FAILED", "CANCELLED"):
        if safe_total > 0:
            return clamp_pct(min(99.0, (min(processed, safe_total) / safe_total) * 100.0))
        return 0.0
    return 10.0


def compute_karaoke_job_progress(
    *,
    status: str | None = None,
    stage: str | None = None,
    lifecycle_state: str | None = None,
) -> float:
    """Compute deterministic stage `%` for Karaoke processing jobs and Simple Mode status."""
    st = str(status or "").strip().upper()
    sg = str(stage or "").strip().upper()

    if st in ("READY", "NEEDS_REVIEW", "APPLIED"):
        return 100.0
    if st in ("FAILED", "CANCELLED", "EXPIRED"):
        if sg in _KARAOKE_STAGE_PCT and sg != "COMPLETE":
            return _KARAOKE_STAGE_PCT[sg]
        return 0.0
    if sg in _KARAOKE_STAGE_PCT:
        return _KARAOKE_STAGE_PCT[sg]
    if st == "QUEUED":
        return 8.0
    if st == "RUNNING":
        return 35.0

    lc = str(lifecycle_state or "").strip().upper()
    if lc in ("READY_TO_PUBLISH", "PUBLISHED", "READY_FOR_REVIEW", "NEEDS_REVIEW", "APPLIED"):
        return 100.0
    if lc == "PROCESSING":
        return 45.0
    if lc == "QUEUED":
        return 8.0
    if lc == "WAITING_FOR_WORKER":
        return 2.0
    return 0.0


def compute_training_job_progress(
    *,
    status: str | None,
    progress: Any = None,
) -> float:
    """Normalize `viread_ocr_training_jobs` progress JSONB + status into `[0.0, 100.0]`."""
    st = str(status or "QUEUED").strip().upper()
    if st in ("SUCCEEDED", "COMPLETED", "BENCHMARKED", "PROMOTED"):
        return 100.0

    prog_dict: dict[str, Any] = {}
    if isinstance(progress, dict):
        prog_dict = progress
    elif isinstance(progress, str) and progress.strip():
        try:
            parsed = json.loads(progress)
            if isinstance(parsed, dict):
                prog_dict = parsed
        except (ValueError, TypeError):
            prog_dict = {}

    for key in ("progress_pct", "percent", "pct"):
        val = _finite_float(prog_dict.get(key))
        if val is not None:
            ceiling = 100.0 if st in ("SUCCEEDED", "COMPLETED") else 99.0
            return clamp_pct(min(ceiling, val))

    pair_keys = (
        ("completed_steps", "total_steps"),
        ("current_step", "total_steps"),
        ("current_step", "max_steps"),
        ("step", "total_steps"),
        ("step", "max_steps"),
        ("completed_epochs", "total_epochs"),
        ("epoch", "epochs"),
        ("completed_samples", "total_samples"),
    )
    for done_key, total_key in pair_keys:
        done_val = _finite_float(prog_dict.get(done_key))
        total_val = _finite_float(prog_dict.get(total_key))
        if done_val is not None and total_val is not None and total_val > 0:
            return clamp_pct(min(99.0, (max(0.0, done_val) / total_val) * 100.0))

    raw_stage = str(prog_dict.get("stage") or prog_dict.get("phase") or "").strip().upper()
    if raw_stage and raw_stage in _TRAINING_STATUS_PCT:
        return _TRAINING_STATUS_PCT[raw_stage]
    return _TRAINING_STATUS_PCT.get(st, 10.0)
