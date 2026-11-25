from __future__ import annotations

import asyncio
import difflib
import hashlib
import json
import logging
import math
import os
import re
import string
import unicodedata
from datetime import datetime, timedelta, timezone
from typing import Any
from uuid import UUID, uuid4

from fastapi import HTTPException, status
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.database.config import APP_ENVIRONMENT, SUPABASE_PRIVATE_BOOKS_BUCKET
from app.database.session import AsyncSessionLocal
from app.diagnostic_logging import log_diagnostic
from app.models import Book, BookPage, OcrInferenceJob, OcrWorkerHeartbeat, PageRevision, ParentBookPageSubmission
from app.repositories.ocr_inference_job_repository import ACTIVE_JOB_STATUSES, OcrInferenceJobRepository
from app.services import storage_service
from app.services.ocr_text_utils import (  # noqa: F401
    align_ocr_tokens,
    normalize_text_tokens,
    normalize_word,
)

logger = logging.getLogger(__name__)

OCR_MODES = ("local_inprocess", "remote_worker")
DEFAULT_OCR_MODE = "local_inprocess"

JOB_KIND_ADMIN_UPLOAD = "ADMIN_PAGE_UPLOAD"
JOB_KIND_ADMIN_REUPLOAD = "ADMIN_PAGE_REUPLOAD"
JOB_KIND_ADMIN_REPROCESS = "ADMIN_PAGE_REPROCESS"
JOB_KIND_PARENT_SUBMISSION = "PARENT_BOOK_SUBMISSION"
JOB_KIND_LOCAL_SCAN = "LOCAL_PAGE_SCAN"

PRIORITY_LOCAL_SCAN = 10
PRIORITY_ADMIN_OCR = 20
PRIORITY_PARENT_SUBMISSION = 50
PRIORITY_RETRY = 60

DEFAULT_LEASE_SECONDS = 120
DEFAULT_MAX_ATTEMPTS = 3
DEFAULT_WORKER_HEARTBEAT_TTL_SECONDS = 45
ORIGINAL_VIETOCR_SHA256 = "380512193a8b6cbf6fad80deacdc9b6939d10d473d199892fc6408d13775ea59"

_TRUTHY_VALUES = {"1", "true", "yes", "on"}
_FALSY_VALUES = {"0", "false", "no", "off"}
_WHITESPACE_RE = re.compile(r"\s+")

_POST_OCR_TASKS: set[asyncio.Task[Any]] = set()
_POST_OCR_SEMAPHORE: asyncio.Semaphore | None = None


def get_ocr_mode() -> str:
    raw = (os.getenv("VIREAD_OCR_MODE") or DEFAULT_OCR_MODE).strip().lower()
    if raw in OCR_MODES:
        return raw
    return DEFAULT_OCR_MODE


def is_remote_ocr_mode() -> bool:
    return get_ocr_mode() == "remote_worker"


def is_heavy_workers_disabled() -> bool:
    raw = os.getenv("VIREAD_WEB_DISABLE_HEAVY_WORKERS")
    if raw is not None and raw.strip() != "":
        normalized = raw.strip().lower()
        if normalized in _TRUTHY_VALUES:
            return True
        if normalized in _FALSY_VALUES:
            return False
    return is_remote_ocr_mode()


def worker_heartbeat_ttl_seconds() -> int:
    raw = os.getenv("VIREAD_OCR_WORKER_HEARTBEAT_TTL_SECONDS", str(DEFAULT_WORKER_HEARTBEAT_TTL_SECONDS)).strip()
    try:
        return max(10, min(600, int(raw)))
    except ValueError:
        return DEFAULT_WORKER_HEARTBEAT_TTL_SECONDS


def remote_sync_wait_timeout_seconds() -> float:
    raw = os.getenv("VIREAD_REMOTE_OCR_SYNC_TIMEOUT_SECONDS", "45").strip()
    try:
        return max(2.0, min(180.0, float(raw)))
    except ValueError:
        return 45.0


def compute_candidate_hash(
    text: str | None,
    *,
    source_sha256: str,
    is_image_only: bool = False,
) -> str:
    """Bind candidate snapshot hash to both normalized text and source image digest."""
    from app.services.ocr_ai.child_safety import content_hash as safety_content_hash

    if is_image_only and not (text or "").strip():
        return hashlib.sha256(f"IMAGE_ONLY:{source_sha256}".encode("utf-8")).hexdigest()
    text_hash = safety_content_hash(text or "")
    return hashlib.sha256(f"{source_sha256}:{text_hash}".encode("utf-8")).hexdigest()


def _valid_bbox(raw: object) -> list[float] | None:
    """Coerce list/tuple/dict bounding box into a non-negative 4-float [x, y, w, h] list."""
    vals: list[float] | None = None
    if isinstance(raw, (list, tuple)) and len(raw) == 4:
        try:
            vals = [float(v) for v in raw]
        except (TypeError, ValueError):
            return None
    elif isinstance(raw, dict):
        try:
            vals = [
                float(raw["x"]),
                float(raw["y"]),
                float(raw.get("w", raw.get("width", 0.0))),
                float(raw.get("h", raw.get("height", 0.0))),
            ]
        except (KeyError, TypeError, ValueError):
            return None
    if vals is None or not all(math.isfinite(v) and v >= 0.0 for v in vals):
        return None
    if vals[2] <= 0.0 or vals[3] <= 0.0:
        return None
    return [round(v, 6) for v in vals]


def _extract_word_bbox_list(item: dict[str, Any]) -> list[float] | None:
    for key in ("bounding_box", "bbox", "BoundingBox"):
        box = _valid_bbox(item.get(key))
        if box is not None:
            return box
    return None


def align_edited_text_to_words(
    edited_text: str, base_words: list[dict[str, Any]]
) -> list[dict[str, Any]]:
    normalized_text = unicodedata.normalize(
        "NFC", edited_text.replace("\r\n", "\n").replace("\r", "\n")
    ).strip()
    if not normalized_text:
        return []
    lines = [line.strip() for line in normalized_text.split("\n") if line.strip()]
    tokens_with_lines: list[tuple[int, str]] = []
    for line_idx, line in enumerate(lines):
        for tok in _WHITESPACE_RE.split(line):
            if tok:
                tokens_with_lines.append((line_idx, tok))
    if not tokens_with_lines:
        return []

    raw_tokens = [tok for _, tok in tokens_with_lines]
    base_norms = [normalize_word(str(w.get("text") or w.get("Text") or "")) for w in base_words]
    edit_norms = [normalize_word(tok) for tok in raw_tokens]
    matcher = difflib.SequenceMatcher(None, base_norms, edit_norms, autojunk=False)
    matched_base_for_edit: dict[int, int] = {}
    for tag, i1, i2, j1, j2 in matcher.get_opcodes():
        if tag in ("equal", "replace"):
            span = min(i2 - i1, j2 - j1)
            for offset in range(span):
                matched_base_for_edit[j1 + offset] = i1 + offset

    base_valid_norm_boxes: list[list[float]] = []
    for w in base_words:
        if isinstance(w, dict):
            b = _extract_word_bbox_list(w)
            if b is not None and b[0] <= 1.0 and b[1] <= 1.0 and b[0] + b[2] <= 1.001 and b[1] + b[3] <= 1.001:
                base_valid_norm_boxes.append(b)
    if base_valid_norm_boxes:
        left = max(0.02, min(b[0] for b in base_valid_norm_boxes))
        top = max(0.02, min(b[1] for b in base_valid_norm_boxes))
        right = min(0.98, max(b[0] + b[2] for b in base_valid_norm_boxes))
        bottom = min(0.98, max(b[1] + b[3] for b in base_valid_norm_boxes))
    else:
        left, top, right, bottom = 0.08, 0.08, 0.92, 0.92

    line_counts: dict[int, int] = {}
    for line_idx, _ in tokens_with_lines:
        line_counts[line_idx] = line_counts.get(line_idx, 0) + 1
    line_pos: dict[int, int] = {}
    total_lines = max(1, len(lines))
    total_h = max(0.08, bottom - top)
    line_h = min(0.08, total_h / total_lines)

    aligned: list[dict[str, Any]] = []
    for idx, (default_line_idx, token) in enumerate(tokens_with_lines):
        pos_in_line = line_pos.get(default_line_idx, 0)
        line_pos[default_line_idx] = pos_in_line + 1
        src_idx = matched_base_for_edit.get(idx)
        src = base_words[src_idx] if src_idx is not None and src_idx < len(base_words) else None
        raw_box = None
        line_idx = default_line_idx
        conf = None
        if src is not None:
            raw_box = _extract_word_bbox_list(src)
            try:
                line_idx = max(0, int(src.get("line_index", src.get("LineIndex", default_line_idx)) or 0))
            except (TypeError, ValueError):
                line_idx = default_line_idx
            conf = src.get("ocr_confidence", src.get("OCRConfidence"))
        if raw_box is None:
            cols = max(1, line_counts.get(default_line_idx, 1))
            y = min(0.92, top + default_line_idx * (total_h / total_lines))
            slot_w = max(0.02, (right - left) / cols)
            x = min(0.95, left + pos_in_line * slot_w)
            w = max(0.015, min(slot_w * 0.9, 1.0 - x))
            h = max(0.015, min(line_h * 0.85, 1.0 - y))
            raw_box = [round(x, 6), round(y, 6), round(w, 6), round(h, 6)]
        entry: dict[str, Any] = {
            "word_index": idx,
            "line_index": line_idx,
            "text": token,
            "normalized_text": normalize_word(token) or token.casefold(),
            "bounding_box": raw_box,
            "bbox": raw_box,
        }
        if conf is not None:
            entry["ocr_confidence"] = conf
        aligned.append(entry)
    return aligned


def build_proofread_suggestions(
    original_text: str, proofread_text: str
) -> list[dict[str, Any]]:
    orig_tokens = [t for t in _WHITESPACE_RE.split(unicodedata.normalize("NFC", original_text).strip()) if t]
    new_tokens = [t for t in _WHITESPACE_RE.split(unicodedata.normalize("NFC", proofread_text).strip()) if t]
    matcher = difflib.SequenceMatcher(None, orig_tokens, new_tokens, autojunk=False)
    suggestions: list[dict[str, Any]] = []
    for tag, i1, i2, j1, j2 in matcher.get_opcodes():
        if tag == "equal":
            continue
        suggestions.append(
            {
                "op": tag,
                "original_span": [i1, i2],
                "proposed_span": [j1, j2],
                "original": " ".join(orig_tokens[i1:i2]),
                "proposed": " ".join(new_tokens[j1:j2]),
            }
        )
    return suggestions


def _normalize_worker_words(raw_words: list[dict[str, Any]]) -> list[dict[str, Any]]:
    normalized: list[dict[str, Any]] = []
    for item in raw_words:
        text_val = unicodedata.normalize("NFC", str(item.get("text") or "")).strip()
        if not text_val or not normalize_word(text_val):
            continue
        box_list = _extract_word_bbox_list(item) or [0.02, 0.02, 0.08, 0.05]
        entry: dict[str, Any] = {
            "word_index": len(normalized),
            "line_index": max(0, int(item.get("line_index", 0) or 0)),
            "text": text_val,
            "normalized_text": normalize_word(text_val) or text_val.casefold(),
            "bounding_box": box_list,
            "bbox": box_list,
        }
        if item.get("ocr_confidence") is not None:
            entry["ocr_confidence"] = float(item["ocr_confidence"])
        if item.get("ocr_review_status") is not None:
            entry["ocr_review_status"] = str(item["ocr_review_status"])
        if item.get("ocr_score_source") is not None:
            entry["ocr_score_source"] = str(item["ocr_score_source"])
        if item.get("ocr_evidence") is not None:
            entry["ocr_evidence"] = item["ocr_evidence"]
        normalized.append(entry)
    return normalized


def _sanitize_error_message(message: str | None, *, max_len: int = 300) -> str | None:
    if not message:
        return None
    cleaned = _WHITESPACE_RE.sub(" ", str(message)).strip()
    if "token=" in cleaned.lower() or "sig=" in cleaned.lower() or "service_role" in cleaned.lower():
        return "Worker reported an inference error."
    return cleaned[:max_len]


def _post_ocr_concurrency_limit() -> int:
    import os

    raw = (os.getenv("VIREAD_POST_OCR_CONCURRENCY") or "").strip()
    if raw:
        try:
            parsed = int(raw)
        except ValueError:
            parsed = 1
        return max(1, min(8, parsed))
    cloud_enabled = (os.getenv("OCR_CLOUD_CORRECTION_ENABLED") or "").strip().lower() in {
        "1", "true", "yes", "on",
    }
    private_cloud = (os.getenv("PRIVATE_BOOK_ALLOW_CLOUD_AI") or "").strip().lower() in {
        "1", "true", "yes", "on",
    }
    return 4 if (cloud_enabled and private_cloud) else 1


_POST_OCR_SEMAPHORE_KEY: tuple[int, int] | None = None


def _post_ocr_semaphore() -> asyncio.Semaphore:
    global _POST_OCR_SEMAPHORE, _POST_OCR_SEMAPHORE_KEY
    limit = _post_ocr_concurrency_limit()
    try:
        loop_id = id(asyncio.get_running_loop())
    except RuntimeError:
        loop_id = 0
    key = (loop_id, limit)
    if _POST_OCR_SEMAPHORE is None or _POST_OCR_SEMAPHORE_KEY != key:
        _POST_OCR_SEMAPHORE = asyncio.Semaphore(limit)
        _POST_OCR_SEMAPHORE_KEY = key
    return _POST_OCR_SEMAPHORE


async def _run_post_ocr_guarded(submission_id: UUID) -> None:
    sem = _post_ocr_semaphore()
    async with sem:
        try:
            await run_parent_submission_post_ocr(submission_id)
        except asyncio.CancelledError:
            raise
        except Exception as exc:
            logger.exception(
                "Unhandled exception in lightweight Stage 2+3 runner for submission %s: %s",
                submission_id,
                type(exc).__name__,
            )


def schedule_parent_submission_post_ocr(submission_id: UUID) -> asyncio.Task[Any] | None:
    """Schedule Stage 2+3 post-OCR check cleanly without importing heavy ML modules."""
    try:
        loop = asyncio.get_running_loop()
    except RuntimeError:
        return None
    task = loop.create_task(
        _run_post_ocr_guarded(submission_id),
        name=f"parent_submission_post_ocr_{submission_id}",
    )
    _POST_OCR_TASKS.add(task)
    task.add_done_callback(_POST_OCR_TASKS.discard)
    return task


async def shutdown_post_ocr_tasks(*, timeout_seconds: float = 5.0) -> None:
    if not _POST_OCR_TASKS:
        return
    pending = [task for task in list(_POST_OCR_TASKS) if not task.done()]
    for task in pending:
        task.cancel()
    if pending:
        await asyncio.wait(pending, timeout=timeout_seconds)


async def run_parent_submission_post_ocr(
    submission_id: UUID,
    *,
    proofread_orchestrator: Any | None = None,
    safety_orchestrator: Any | None = None,
    download_bytes: Any | None = None,
) -> dict[str, Any]:
    """Run Stage 2 (AI proofread) & Stage 3 (child safety/quality) strictly using lightweight web deps."""
    from app.models import ParentBookPageSubmission
    from app.services.book_quality_analyzer import analyse_verified_text
    from app.services.ocr_ai.child_safety import (
        ChildSafetyError,
        build_private_book_child_safety_orchestrator,
        normalize_safety_text,
    )
    from app.services.ocr_ai.config import OcrCorrectionConfig
    from app.services.ocr_ai.orchestrator import OcrCorrectionOrchestrator, OcrOrchestrationError

    async with AsyncSessionLocal() as db:
        row = await db.scalar(
            select(ParentBookPageSubmission).where(ParentBookPageSubmission.Id == submission_id)
        )
        if row is None or row.WorkflowStatus != "CHECKING":
            return {"status": "SKIPPED_NOT_CHECKING", "submission_id": str(submission_id)}
        if row.OcrStatus not in ("COMPLETED", "NO_TEXT_DETECTED"):
            return {"status": "WAITING_FOR_OCR", "submission_id": str(submission_id)}

        snapshot_version = int(row.SubmissionVersion)
        snapshot_candidate_hash = row.CandidateHash
        snapshot_source_sha256 = row.SourceSha256
        snapshot_storage_path = row.SourceStoragePath
        snapshot_ocr_text = str(row.OcrText or "")
        snapshot_ocr_words = list(row.OcrWordsJson or [])
        snapshot_is_image_only = bool(row.IsImageOnly)
        snapshot_proofread_status = str(row.ProofreadStatus)
        snapshot_tool_status = str(row.ToolCheckStatus)
        snapshot_candidate_text = str(row.CandidateText or "")
        snapshot_source_note = str(row.SourceNote or "")

    # Stage 2: AI proofreading (lightweight HTTP to Ollama/configured provider + Pillow crops)
    if (
        snapshot_ocr_status := ("NO_TEXT_DETECTED" if snapshot_is_image_only else "COMPLETED")
    ) == "COMPLETED" and snapshot_proofread_status == "PENDING":
        try:
            downloader = download_bytes or (
                lambda path: storage_service.download_object(
                    path, bucket_name=SUPABASE_PRIVATE_BOOKS_BUCKET
                )
            )
            image_bytes = await asyncio.to_thread(downloader, snapshot_storage_path)
            if hashlib.sha256(image_bytes).hexdigest() != snapshot_source_sha256:
                raise RuntimeError("SOURCE_IMAGE_HASH_MISMATCH")

            tokens = [t for t in _WHITESPACE_RE.split(unicodedata.normalize("NFC", snapshot_ocr_text).strip()) if t]
            word_boxes: list[tuple[float, float, float, float]] = []
            for idx in range(len(tokens)):
                box = None
                if idx < len(snapshot_ocr_words) and isinstance(snapshot_ocr_words[idx], dict):
                    box = _extract_word_bbox_list(snapshot_ocr_words[idx])
                if box is None:
                    box = [0.0, 0.0, 1.0, 1.0]
                word_boxes.append((box[0], box[1], box[2], box[3]))

            orchestrator = proofread_orchestrator or OcrCorrectionOrchestrator(
                OcrCorrectionConfig.from_environment()
            )
            events: list[dict[str, object]] = []
            uncertain: list[int] = []

            def _on_event(evt: dict[str, object]) -> None:
                if len(events) < 30:
                    events.append(
                        {
                            k: evt[k]
                            for k in ("provider", "family", "outcome", "status_code", "latency_ms", "chunk_id")
                            if k in evt
                        }
                    )

            def _on_uncertain(_chunk_id: int, indices: tuple[int, ...]) -> None:
                uncertain.extend(int(i) for i in indices)

            proofread_text = await orchestrator.correct(
                snapshot_ocr_text,
                image_bytes,
                word_boxes,
                on_provider_event=_on_event,
                on_uncertain_tokens=_on_uncertain,
                word_normalizer=normalize_word,
            )
            proofread_hash = hashlib.sha256(
                " ".join(unicodedata.normalize("NFC", proofread_text).split()).encode("utf-8")
            ).hexdigest()
            suggestions = build_proofread_suggestions(snapshot_ocr_text, proofread_text)
            aligned_words = align_edited_text_to_words(proofread_text, snapshot_ocr_words)
            new_candidate_hash = compute_candidate_hash(
                proofread_text,
                source_sha256=snapshot_source_sha256,
                is_image_only=False,
            )
        except Exception as exc:
            error_code = (
                exc.code
                if isinstance(exc, OcrOrchestrationError)
                else ("SOURCE_IMAGE_HASH_MISMATCH" if "HASH_MISMATCH" in str(exc) else "PROOFREAD_FAILED")
            )
            await _persist_parent_post_ocr_failure(
                submission_id=submission_id,
                expected_version=snapshot_version,
                expected_candidate_hash=snapshot_candidate_hash,
                stage="PROOFREADING",
                error_code=str(error_code)[:72],
            )
            return {"status": "CHECK_FAILED", "stage": "PROOFREADING", "error_code": error_code}

        async with AsyncSessionLocal() as db:
            locked = await db.scalar(
                select(ParentBookPageSubmission)
                .where(ParentBookPageSubmission.Id == submission_id)
                .with_for_update()
            )
            if (
                locked is None
                or locked.WorkflowStatus != "CHECKING"
                or int(locked.SubmissionVersion) != snapshot_version
                or locked.CandidateHash != snapshot_candidate_hash
                or locked.SourceSha256 != snapshot_source_sha256
            ):
                await db.rollback()
                return {"status": "STALE_DISCARDED", "submission_id": str(submission_id)}

            now = datetime.now(timezone.utc)
            locked.ProofreadStatus = "COMPLETED"
            locked.ProofreadText = proofread_text
            locked.ProofreadHash = proofread_hash
            locked.ProofreadSuggestionsJson = suggestions
            locked.UncertainWordIndicesJson = sorted(set(uncertain))
            locked.ProofreadProviderEventsJson = events
            locked.ProofreadErrorCode = None
            locked.CandidateText = proofread_text
            locked.CandidateWordsJson = aligned_words
            locked.CandidateHash = new_candidate_hash
            locked.OptimisticLockVersion = int(locked.OptimisticLockVersion or 1) + 1
            locked.UpdatedAt = now
            await db.commit()

            snapshot_candidate_text = proofread_text
            snapshot_candidate_hash = new_candidate_hash
            snapshot_proofread_status = "COMPLETED"
            snapshot_tool_status = str(locked.ToolCheckStatus)

    # Stage 3: Child safety + deterministic quality checks (fail-closed!)
    if snapshot_tool_status == "PENDING":
        text_to_check = snapshot_candidate_text.strip()
        if not text_to_check and snapshot_source_note:
            text_to_check = snapshot_source_note.strip()

        findings_payload: list[dict[str, Any]] = []
        if not snapshot_is_image_only:
            for finding in analyse_verified_text(snapshot_candidate_text):
                findings_payload.append(
                    {
                        "issue_type": finding.issue_type,
                        "severity": finding.severity,
                        "original_excerpt": finding.original_excerpt,
                        "excerpt_start": finding.excerpt_start,
                        "excerpt_end": finding.excerpt_end,
                        "explanation": finding.explanation,
                    }
                )

        suitability = "REVIEW_REQUIRED" if snapshot_is_image_only else "SUITABLE"
        safety_events: list[dict[str, Any]] = []
        if text_to_check:
            try:
                safety_runner = safety_orchestrator or build_private_book_child_safety_orchestrator()
                safety_result = await safety_runner.analyze(text_to_check)
                if not isinstance(safety_result, dict) or not safety_result.get("suitability"):
                    raise ChildSafetyError("INVALID_SAFETY_RESPONSE")
                suitability = str(safety_result.get("suitability") or "REVIEW_REQUIRED")
                raw_findings = safety_result.get("findings")
                if not isinstance(raw_findings, list):
                    raise ChildSafetyError("INVALID_SAFETY_FINDINGS")
                for item in raw_findings:
                    if isinstance(item, dict):
                        findings_payload.append(item)
                raw_events = safety_result.get("provider_events")
                if isinstance(raw_events, list):
                    safety_events = list(raw_events)[:20]
            except Exception as exc:
                error_code = (
                    getattr(exc, "code", None)
                    or ("CHILD_SAFETY_TIMEOUT" if "timeout" in str(exc).lower() else "CHILD_SAFETY_CHECK_FAILED")
                )
                await _persist_parent_post_ocr_failure(
                    submission_id=submission_id,
                    expected_version=snapshot_version,
                    expected_candidate_hash=snapshot_candidate_hash,
                    stage="TOOL_CHECK",
                    error_code=str(error_code)[:72],
                )
                return {"status": "CHECK_FAILED", "stage": "TOOL_CHECK", "error_code": error_code}

        is_clean = bool(
            not snapshot_is_image_only
            and suitability == "SUITABLE"
            and len(findings_payload) == 0
            and bool(normalize_safety_text(snapshot_candidate_text))
        )
        policy_blocked = bool(suitability != "SUITABLE" or len(findings_payload) > 0)
        tool_check_status = (
            "PASSED"
            if is_clean
            else ("FLAGGED" if (findings_payload or suitability != "SUITABLE") else "NEEDS_MANUAL_REVIEW")
        )
        if snapshot_is_image_only and not findings_payload and suitability in ("SUITABLE", "REVIEW_REQUIRED"):
            suitability = "REVIEW_REQUIRED"
            tool_check_status = "NEEDS_MANUAL_REVIEW"
            policy_blocked = False

        async with AsyncSessionLocal() as db:
            locked = await db.scalar(
                select(ParentBookPageSubmission)
                .where(ParentBookPageSubmission.Id == submission_id)
                .with_for_update()
            )
            if (
                locked is None
                or locked.WorkflowStatus != "CHECKING"
                or int(locked.SubmissionVersion) != snapshot_version
                or locked.CandidateHash != snapshot_candidate_hash
                or locked.SourceSha256 != snapshot_source_sha256
            ):
                await db.rollback()
                return {"status": "STALE_DISCARDED", "submission_id": str(submission_id)}

            now = datetime.now(timezone.utc)
            locked.ToolCheckStatus = tool_check_status
            locked.ToolCheckInputHash = snapshot_candidate_hash
            locked.ToolCheckSuitability = suitability
            locked.ToolCheckScopeJson = {
                "checked_ocr_candidate": not snapshot_is_image_only,
                "checked_source_note": bool(snapshot_source_note),
            }
            locked.ToolCheckFindingsJson = findings_payload
            locked.ToolCheckProviderEventsJson = safety_events
            locked.ToolCheckErrorCode = None
            locked.ToolCheckPolicyBlocked = policy_blocked
            locked.ToolCheckCompletedAt = now
            locked.WorkflowStatus = "PASSED_READY_TO_ADD" if is_clean else "NEEDS_ADMIN_REVIEW"
            locked.OptimisticLockVersion = int(locked.OptimisticLockVersion or 1) + 1
            locked.UpdatedAt = now
            await db.commit()
            return {"status": locked.WorkflowStatus, "submission_id": str(submission_id)}

    return {"status": "COMPLETED", "submission_id": str(submission_id)}


async def _persist_parent_post_ocr_failure(
    *,
    submission_id: UUID,
    expected_version: int,
    expected_candidate_hash: str | None,
    stage: str,
    error_code: str,
) -> None:
    async with AsyncSessionLocal() as db:
        locked = await db.scalar(
            select(ParentBookPageSubmission)
            .where(ParentBookPageSubmission.Id == submission_id)
            .with_for_update()
        )
        if (
            locked is None
            or locked.WorkflowStatus != "CHECKING"
            or int(locked.SubmissionVersion) != expected_version
            or locked.CandidateHash != expected_candidate_hash
        ):
            await db.rollback()
            return
        now = datetime.now(timezone.utc)
        if stage == "PROOFREADING":
            locked.ProofreadStatus = "FAILED"
            locked.ProofreadErrorCode = error_code
        else:
            locked.ToolCheckStatus = "FAILED"
            locked.ToolCheckErrorCode = error_code
            locked.ToolCheckSuitability = None
        locked.WorkflowStatus = "CHECK_FAILED"
        locked.OptimisticLockVersion = int(locked.OptimisticLockVersion or 1) + 1
        locked.UpdatedAt = now
        await db.commit()


class OcrInferenceJobService:
    """Backend orchestrator for durable OCR inference jobs and remote worker leases."""

    def __init__(self, db: AsyncSession):
        self.db = db
        self.repo = OcrInferenceJobRepository(db)

    async def enqueue_job(
        self,
        *,
        job_kind: str,
        image_path: str,
        image_sha256: str,
        owner_user_id: UUID | None = None,
        book_id: UUID | None = None,
        page_id: UUID | None = None,
        submission_id: UUID | None = None,
        local_scan_request_id: str | None = None,
        image_bucket: str | None = None,
        image_width: int | None = None,
        image_height: int | None = None,
        image_mime_type: str | None = None,
        priority: int = PRIORITY_ADMIN_OCR,
        idempotency_key: str | None = None,
        expected_version: int = 1,
        expected_candidate_hash: str | None = None,
        expected_verified_revision_id: UUID | None = None,
        expected_latest_revision_id: UUID | None = None,
        processing_meta: dict[str, Any] | None = None,
        max_attempts: int = DEFAULT_MAX_ATTEMPTS,
    ) -> OcrInferenceJob:
        clean_idem = (idempotency_key or "").strip() or None
        if clean_idem is not None:
            existing = await self.repo.get_by_idempotency(
                job_kind, owner_user_id, clean_idem, lock=True
            )
            if existing is not None:
                if existing.ImageSha256 != image_sha256 or (
                    page_id is not None and existing.PageId not in (None, page_id)
                ):
                    raise HTTPException(
                        status_code=status.HTTP_409_CONFLICT,
                        detail="Idempotency key already used for a different OCR payload.",
                    )
                return existing

        now = datetime.now(timezone.utc)
        job = OcrInferenceJob(
            Id=uuid4(),
            JobKind=job_kind,
            Status="QUEUED",
            Priority=priority,
            IdempotencyKey=clean_idem,
            OwnerUserId=owner_user_id,
            BookId=book_id,
            PageId=page_id,
            SubmissionId=submission_id,
            LocalScanRequestId=local_scan_request_id,
            ImageBucket=image_bucket,
            ImagePath=image_path,
            ImageSha256=image_sha256,
            ImageWidth=image_width,
            ImageHeight=image_height,
            ImageMimeType=image_mime_type,
            ProcessingMeta=dict(processing_meta or {}),
            ExpectedVersion=int(expected_version),
            ExpectedCandidateHash=expected_candidate_hash,
            ExpectedVerifiedRevisionId=expected_verified_revision_id,
            ExpectedLatestRevisionId=expected_latest_revision_id,
            FencingToken=0,
            AttemptCount=0,
            MaxAttempts=max(1, min(20, int(max_attempts))),
            CreatedAt=now,
            UpdatedAt=now,
        )
        return await self.repo.create_job(job)

    async def has_online_worker(self) -> bool:
        now = datetime.now(timezone.utc)
        ttl = timedelta(seconds=worker_heartbeat_ttl_seconds())
        workers = await self.repo.list_worker_heartbeats(limit=20)
        for worker in workers:
            if worker.LastHeartbeatAt is None:
                continue
            hb_at = (
                worker.LastHeartbeatAt
                if worker.LastHeartbeatAt.tzinfo is not None
                else worker.LastHeartbeatAt.replace(tzinfo=timezone.utc)
            )
            if (now - hb_at) <= ttl and str(worker.Status or "").upper() != "OFFLINE":
                return True
        return False

    async def cancel_for_page(self, page_id: UUID, *, reason: str) -> int:
        return await self.repo.cancel_open_for_page(page_id, reason=reason)

    async def cancel_for_submission(self, submission_id: UUID, *, reason: str) -> int:
        return await self.repo.cancel_open_for_submission(submission_id, reason=reason)

    async def cancel_for_book(self, book_id: UUID, *, reason: str) -> int:
        return await self.repo.cancel_open_for_book(book_id, reason=reason)

    async def wait_for_job_completion(
        self,
        job_id: UUID,
        *,
        timeout_seconds: float | None = None,
        poll_interval_seconds: float = 0.15,
    ) -> OcrInferenceJob:
        deadline = asyncio.get_running_loop().time() + float(
            timeout_seconds or remote_sync_wait_timeout_seconds()
        )
        while True:
            async with AsyncSessionLocal() as poll_db:
                row = await OcrInferenceJobRepository(poll_db).get(job_id)
                if row is None:
                    raise HTTPException(status_code=404, detail="OCR inference job not found.")
                if row.Status in ("SUCCEEDED", "DEAD_LETTER", "CANCELLED"):
                    return row
            remaining = deadline - asyncio.get_running_loop().time()
            if remaining <= 0:
                raise HTTPException(
                    status_code=status.HTTP_504_GATEWAY_TIMEOUT,
                    detail="Remote OCR worker did not finish before sync timeout; poll job status asynchronously.",
                )
            await asyncio.sleep(min(poll_interval_seconds, remaining))

    async def record_worker_heartbeat(
        self,
        *,
        worker_id: str,
        hostname: str | None,
        app_version: str | None,
        git_sha: str | None,
        status_value: str,
        active_job_id: UUID | None,
        active_job_count: int,
        concurrency_limit: int,
        model_profile: str | None,
        model_sha256: str | None,
        engines: dict[str, Any],
        system_stats: dict[str, Any],
        last_error: str | None,
    ) -> OcrWorkerHeartbeat:
        allowed_status = {"STARTING", "IDLE", "BUSY", "DEGRADED", "OFFLINE"}
        normalized_status = status_value.strip().upper()
        if normalized_status not in allowed_status:
            normalized_status = "DEGRADED"
        row = await self.repo.upsert_worker_heartbeat(
            worker_id=worker_id.strip()[:120],
            hostname=(hostname or "").strip()[:120] or None,
            app_version=(app_version or "").strip()[:64] or None,
            git_sha=(git_sha or "").strip()[:64] or None,
            status=normalized_status,
            active_job_id=active_job_id,
            active_job_count=active_job_count,
            concurrency_limit=concurrency_limit,
            model_profile=(model_profile or "").strip()[:64] or None,
            model_sha256=(model_sha256 or "").strip().lower()[:64] or None,
            engines=engines,
            system_stats=system_stats,
            last_error=_sanitize_error_message(last_error),
        )
        await self.db.commit()
        return row

    def _build_source_descriptor(
        self, job: OcrInferenceJob, *, worker_id: str, expires_in: int = 300
    ) -> tuple[str | None, str]:
        fallback_path = (
            f"/internal/ocr-jobs/{job.Id}/source"
            f"?worker_id={worker_id}&fencing_token={int(job.FencingToken)}"
        )
        local_dir = (os.getenv("VIREAD_LOCAL_STORAGE_DIR") or "").strip()
        if local_dir or APP_ENVIRONMENT == "test":
            return None, fallback_path
        try:
            signed = storage_service.create_signed_image_url(
                job.ImagePath,
                bucket_name=job.ImageBucket,
            )
            return signed, fallback_path
        except Exception:
            return None, fallback_path

    async def claim_next_job(
        self,
        *,
        worker_id: str,
        lease_seconds: int = DEFAULT_LEASE_SECONDS,
    ) -> dict[str, Any] | None:
        now = datetime.now(timezone.utc)
        bounded_lease = max(30, min(600, int(lease_seconds)))
        dead_lettered = await self.repo.dead_letter_exhausted_expired_leases(now=now)
        for expired_job in dead_lettered:
            await self._propagate_dead_letter_to_target(
                expired_job,
                error_code="LEASE_EXPIRED_MAX_ATTEMPTS",
                now=now,
            )

        job = await self.repo.claim_next_job(
            worker_id=worker_id.strip()[:120],
            lease_seconds=bounded_lease,
            now=now,
        )
        if job is None:
            if dead_lettered:
                await self.db.commit()
            else:
                await self.db.rollback()
            return None

        signed_url, fallback_path = self._build_source_descriptor(
            job,
            worker_id=job.WorkerId or worker_id,
            expires_in=bounded_lease + 180,
        )
        await self.db.commit()
        log_diagnostic(
            logger,
            logging.INFO,
            event="ocr_job_claimed",
            stage="worker_claim",
            job_id=str(job.Id),
            job_kind=job.JobKind,
            worker_id=job.WorkerId,
            fencing_token=int(job.FencingToken),
            attempt=int(job.AttemptCount),
        )
        return {
            "job_id": str(job.Id),
            "job_kind": job.JobKind,
            "priority": int(job.Priority),
            "fencing_token": int(job.FencingToken),
            "attempt_count": int(job.AttemptCount),
            "max_attempts": int(job.MaxAttempts),
            "lease_expires_at": job.LeaseExpiresAt.isoformat() if job.LeaseExpiresAt else None,
            "image_sha256": job.ImageSha256,
            "image_mime_type": job.ImageMimeType,
            "image_width": job.ImageWidth,
            "image_height": job.ImageHeight,
            "expected_version": int(job.ExpectedVersion),
            "source_url": signed_url,
            "source_fallback_path": fallback_path,
            "refresh_url_path": f"/internal/ocr-jobs/{job.Id}/refresh-source-url",
            "expected_model_profile": (job.ProcessingMeta or {}).get("expected_model_profile"),
        }

    async def _require_active_claim(
        self,
        *,
        job_id: UUID,
        worker_id: str,
        fencing_token: int,
    ) -> OcrInferenceJob:
        job = await self.repo.get(job_id, lock=True)
        if job is None:
            raise HTTPException(status_code=404, detail="OCR inference job not found.")
        if job.Status == "CANCELLED":
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail={
                    "code": "JOB_CANCELLED",
                    "cancelled_reason": job.CancelledReason or "CANCELLED",
                },
            )
        if job.Status not in ("CLAIMED", "RUNNING"):
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail={"code": "JOB_NOT_ACTIVE", "status": job.Status},
            )
        if job.WorkerId != worker_id or int(job.FencingToken or 0) != int(fencing_token):
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail={
                    "code": "FENCING_TOKEN_MISMATCH",
                    "status": job.Status,
                    "current_fencing_token": int(job.FencingToken or 0),
                },
            )
        return job

    async def _is_target_still_current(self, job: OcrInferenceJob) -> tuple[bool, str | None]:
        if job.JobKind == JOB_KIND_PARENT_SUBMISSION and job.SubmissionId is not None:
            sub = await self.db.scalar(
                select(ParentBookPageSubmission).where(
                    ParentBookPageSubmission.Id == job.SubmissionId
                )
            )
            if sub is None:
                return False, "SUBMISSION_DELETED"
            if sub.WorkflowStatus != "CHECKING":
                return False, f"SUBMISSION_STATUS_{sub.WorkflowStatus}"
            if sub.SourceSha256 != job.ImageSha256:
                return False, "SOURCE_IMAGE_REPLACED"
            if int(sub.SubmissionVersion) != int(job.ExpectedVersion):
                return False, "SUBMISSION_VERSION_CHANGED"
            if sub.CandidateHash != job.ExpectedCandidateHash:
                return False, "SUBMISSION_EDITED_MID_JOB"
            return True, None

        if (
            job.JobKind in (JOB_KIND_ADMIN_UPLOAD, JOB_KIND_ADMIN_REUPLOAD, JOB_KIND_ADMIN_REPROCESS)
            and job.PageId is not None
        ):
            page = await self.db.scalar(select(BookPage).where(BookPage.Id == job.PageId))
            if page is None:
                return False, "PAGE_DELETED"
            if page.LifecycleStatus == "RETIRED":
                return False, "PAGE_RETIRED"
            expected_page_path = (job.ProcessingMeta or {}).get("expected_page_image_path") or job.ImagePath
            if expected_page_path and page.ImagePath != expected_page_path:
                return False, "PAGE_IMAGE_REPLACED"
            if page.CurrentVerifiedRevisionId != job.ExpectedVerifiedRevisionId:
                return False, "VERIFIED_REVISION_CHANGED_MID_JOB"
            latest_rev_id = await self.db.scalar(
                select(PageRevision.Id)
                .where(PageRevision.PageId == page.Id)
                .order_by(PageRevision.CreatedAt.desc(), PageRevision.Id.desc())
                .limit(1)
            )
            if latest_rev_id != job.ExpectedLatestRevisionId:
                return False, "PAGE_REVISION_ADDED_MID_JOB"
            return True, None

        return True, None

    async def heartbeat_job(
        self,
        *,
        job_id: UUID,
        worker_id: str,
        fencing_token: int,
        lease_seconds: int = DEFAULT_LEASE_SECONDS,
        phase: str | None = None,
    ) -> dict[str, Any]:
        now = datetime.now(timezone.utc)
        job = await self.repo.get(job_id, lock=True)
        if job is None:
            raise HTTPException(status_code=404, detail="OCR inference job not found.")
        if job.Status == "CANCELLED":
            await self.db.rollback()
            return {
                "job_id": str(job.Id),
                "status": "CANCELLED",
                "cancelled": True,
                "cancelled_reason": job.CancelledReason or "CANCELLED",
                "fencing_token": int(job.FencingToken),
                "lease_expires_at": None,
            }
        if (
            job.Status not in ("CLAIMED", "RUNNING")
            or job.WorkerId != worker_id
            or int(job.FencingToken or 0) != int(fencing_token)
        ):
            await self.db.rollback()
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail="Fencing token mismatch or lease lost.",
            )

        still_current, stale_reason = await self._is_target_still_current(job)
        if not still_current:
            job.Status = "CANCELLED"
            job.CancelledReason = stale_reason or "TARGET_MODIFIED_MID_JOB"
            job.LeaseExpiresAt = None
            job.CompletedAt = now
            job.UpdatedAt = now
            await self.db.commit()
            return {
                "job_id": str(job.Id),
                "status": "CANCELLED",
                "cancelled": True,
                "cancelled_reason": job.CancelledReason,
                "fencing_token": int(job.FencingToken),
                "lease_expires_at": None,
            }

        bounded_lease = max(30, min(600, int(lease_seconds)))
        job.Status = "RUNNING"
        job.HeartbeatAt = now
        job.LeaseExpiresAt = now + timedelta(seconds=bounded_lease)
        job.UpdatedAt = now
        if phase:
            meta = dict(job.ProcessingMeta or {})
            meta["worker_phase"] = str(phase)[:64]
            job.ProcessingMeta = meta
        await self.db.commit()
        return {
            "job_id": str(job.Id),
            "status": job.Status,
            "cancelled": False,
            "cancelled_reason": None,
            "fencing_token": int(job.FencingToken),
            "lease_expires_at": job.LeaseExpiresAt.isoformat(),
        }

    async def refresh_source_url(
        self,
        *,
        job_id: UUID,
        worker_id: str,
        fencing_token: int,
        expires_in: int = 300,
    ) -> dict[str, Any]:
        job = await self._require_active_claim(
            job_id=job_id,
            worker_id=worker_id,
            fencing_token=fencing_token,
        )
        signed_url, fallback_path = self._build_source_descriptor(
            job, worker_id=worker_id, expires_in=expires_in
        )
        await self.db.rollback()
        return {
            "job_id": str(job.Id),
            "fencing_token": int(job.FencingToken),
            "image_sha256": job.ImageSha256,
            "source_url": signed_url,
            "source_fallback_path": fallback_path,
        }

    async def stream_job_source(
        self,
        *,
        job_id: UUID,
        worker_id: str,
        fencing_token: int,
    ) -> tuple[bytes, str]:
        job = await self._require_active_claim(
            job_id=job_id,
            worker_id=worker_id,
            fencing_token=fencing_token,
        )
        image_path = job.ImagePath
        image_bucket = job.ImageBucket
        expected_sha256 = job.ImageSha256
        mime_type = job.ImageMimeType or "application/octet-stream"
        await self.db.rollback()

        raw = await asyncio.to_thread(
            storage_service.download_object, image_path, bucket_name=image_bucket
        )
        if hashlib.sha256(raw).hexdigest() != expected_sha256:
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail="Source image hash changed before worker download.",
            )
        return raw, mime_type

    async def complete_job(
        self,
        *,
        job_id: UUID,
        worker_id: str,
        fencing_token: int,
        source_sha256: str,
        full_text: str,
        words: list[dict[str, Any]],
        ocr_meta: dict[str, Any],
        no_text_detected: bool,
        model_profile: str | None,
        model_sha256: str | None,
        engine_diagnostics: dict[str, Any],
        duration_ms: int | None,
        schedule_post_ocr: bool = True,
    ) -> dict[str, Any]:
        now = datetime.now(timezone.utc)
        job = await self.repo.get(job_id, lock=True)
        if job is None:
            raise HTTPException(status_code=404, detail="OCR inference job not found.")

        if (
            job.Status == "SUCCEEDED"
            and job.WorkerId == worker_id
            and int(job.FencingToken or 0) == int(fencing_token)
        ):
            await self.db.rollback()
            return {
                "job_id": str(job.Id),
                "status": "SUCCEEDED",
                "idempotent_replay": True,
                "revision_id": str(job.RevisionId) if job.RevisionId else None,
                "submission_id": str(job.SubmissionId) if job.SubmissionId else None,
            }

        if job.Status == "CANCELLED":
            await self.db.rollback()
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail={
                    "code": "JOB_CANCELLED",
                    "cancelled_reason": job.CancelledReason or "CANCELLED",
                },
            )
        if (
            job.Status not in ("CLAIMED", "RUNNING")
            or job.WorkerId != worker_id
            or int(job.FencingToken or 0) != int(fencing_token)
        ):
            await self.db.rollback()
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail="Fencing token mismatch; worker lease superseded.",
            )
        if str(source_sha256).lower() != str(job.ImageSha256).lower():
            job.Status = "CANCELLED"
            job.CancelledReason = "SOURCE_SHA256_MISMATCH"
            job.LeaseExpiresAt = None
            job.CompletedAt = now
            job.UpdatedAt = now
            await self.db.commit()
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail="Completed OCR payload source_sha256 does not match queued image.",
            )

        normalized_words = _normalize_worker_words(words) if not no_text_detected else []
        clean_full_text = unicodedata.normalize("NFC", str(full_text or "")).strip()
        if not normalized_words and not clean_full_text:
            no_text_detected = True

        should_schedule_post_ocr_submission_id: UUID | None = None

        if job.JobKind in (
            JOB_KIND_ADMIN_UPLOAD,
            JOB_KIND_ADMIN_REUPLOAD,
            JOB_KIND_ADMIN_REPROCESS,
        ):
            from app.services.admin_ocr_service import AdminOcrService

            applied = await AdminOcrService(self.db).apply_remote_ocr_job_completion(
                job=job,
                full_text=clean_full_text,
                words=normalized_words,
                ocr_meta=dict(ocr_meta or {}),
                no_text_detected=bool(no_text_detected),
                model_profile=model_profile,
                model_sha256=model_sha256,
                now=now,
            )
            if applied.get("stale_reason"):
                job.Status = "CANCELLED"
                job.CancelledReason = str(applied["stale_reason"])
                job.LeaseExpiresAt = None
                job.CompletedAt = now
                job.UpdatedAt = now
                await self.db.commit()
                raise HTTPException(
                    status_code=status.HTTP_409_CONFLICT,
                    detail={
                        "code": "STALE_TARGET_MODIFIED",
                        "reason": job.CancelledReason,
                    },
                )
            job.RevisionId = applied.get("revision_id")

        elif job.JobKind == JOB_KIND_PARENT_SUBMISSION:
            if job.SubmissionId is None:
                raise HTTPException(status_code=422, detail="SubmissionId missing on job.")
            sub = await self.db.scalar(
                select(ParentBookPageSubmission)
                .where(ParentBookPageSubmission.Id == job.SubmissionId)
                .with_for_update()
            )
            stale_reason: str | None = None
            if sub is None:
                stale_reason = "SUBMISSION_DELETED"
            elif sub.WorkflowStatus != "CHECKING":
                stale_reason = f"SUBMISSION_STATUS_{sub.WorkflowStatus}"
            elif sub.SourceSha256 != job.ImageSha256:
                stale_reason = "SOURCE_IMAGE_REPLACED"
            elif int(sub.SubmissionVersion) != int(job.ExpectedVersion):
                stale_reason = "SUBMISSION_VERSION_CHANGED"
            elif sub.CandidateHash != job.ExpectedCandidateHash:
                stale_reason = "SUBMISSION_EDITED_MID_JOB"

            if stale_reason is not None:
                job.Status = "CANCELLED"
                job.CancelledReason = stale_reason
                job.LeaseExpiresAt = None
                job.CompletedAt = now
                job.UpdatedAt = now
                await self.db.commit()
                raise HTTPException(
                    status_code=status.HTTP_409_CONFLICT,
                    detail={"code": "STALE_SUBMISSION_MODIFIED", "reason": stale_reason},
                )

            merged_meta = dict(ocr_meta or {})
            merged_meta["remote_worker_id"] = worker_id
            if model_profile:
                merged_meta["vietocr_profile"] = model_profile
            if model_sha256:
                merged_meta["vietocr_sha256"] = model_sha256
            sub.OcrMetaJson = merged_meta
            sub.OcrErrorCode = None

            if no_text_detected:
                empty_hash = hashlib.sha256(b"").hexdigest()
                sub.OcrStatus = "NO_TEXT_DETECTED"
                sub.IsImageOnly = True
                sub.OcrText = ""
                sub.OcrWordsJson = []
                sub.OcrHash = empty_hash
                sub.ProofreadStatus = "SKIPPED"
                sub.ProofreadText = ""
                sub.ProofreadHash = empty_hash
                sub.ProofreadSuggestionsJson = []
                sub.UncertainWordIndicesJson = []
                sub.CandidateText = ""
                sub.CandidateWordsJson = []
                sub.CandidateHash = compute_candidate_hash(
                    "", source_sha256=sub.SourceSha256, is_image_only=True
                )
            else:
                sub.OcrStatus = "COMPLETED"
                sub.IsImageOnly = False
                sub.OcrText = clean_full_text
                sub.OcrWordsJson = normalized_words
                sub.OcrHash = hashlib.sha256(
                    " ".join(unicodedata.normalize("NFC", clean_full_text).split()).encode("utf-8")
                ).hexdigest()
                sub.ProofreadStatus = "PENDING"
                sub.CandidateText = clean_full_text
                sub.CandidateWordsJson = normalized_words
                sub.CandidateHash = compute_candidate_hash(
                    clean_full_text, source_sha256=sub.SourceSha256, is_image_only=False
                )

            sub.OptimisticLockVersion = int(sub.OptimisticLockVersion or 1) + 1
            sub.UpdatedAt = now
            should_schedule_post_ocr_submission_id = sub.Id

        elif job.JobKind == JOB_KIND_LOCAL_SCAN:
            job.ResultPayload = {
                "full_text": clean_full_text,
                "words": normalized_words,
                "ocr_meta": dict(ocr_meta or {}),
                "no_text_detected": bool(no_text_detected),
            }

        job.Status = "SUCCEEDED"
        job.ModelProfile = model_profile
        job.ModelSha256 = model_sha256
        job.EngineDiagnostics = dict(engine_diagnostics or {})
        job.DurationMs = duration_ms
        job.LeaseExpiresAt = None
        job.CompletedAt = now
        job.UpdatedAt = now
        await self.db.commit()

        if schedule_post_ocr and should_schedule_post_ocr_submission_id is not None:
            schedule_parent_submission_post_ocr(should_schedule_post_ocr_submission_id)

        log_diagnostic(
            logger,
            logging.INFO,
            event="ocr_job_completed",
            stage="worker_complete",
            job_id=str(job.Id),
            job_kind=job.JobKind,
            worker_id=worker_id,
            fencing_token=int(fencing_token),
            duration_ms=duration_ms,
            word_count=len(normalized_words),
            no_text_detected=bool(no_text_detected),
        )
        return {
            "job_id": str(job.Id),
            "status": "SUCCEEDED",
            "idempotent_replay": False,
            "revision_id": str(job.RevisionId) if job.RevisionId else None,
            "submission_id": str(job.SubmissionId) if job.SubmissionId else None,
        }

    async def _propagate_dead_letter_to_target(
        self,
        job: OcrInferenceJob,
        *,
        error_code: str,
        now: datetime,
    ) -> None:
        if job.JobKind == JOB_KIND_PARENT_SUBMISSION and job.SubmissionId is not None:
            sub = await self.db.scalar(
                select(ParentBookPageSubmission)
                .where(ParentBookPageSubmission.Id == job.SubmissionId)
                .with_for_update()
            )
            if (
                sub is not None
                and sub.WorkflowStatus == "CHECKING"
                and int(sub.SubmissionVersion) == int(job.ExpectedVersion)
                and sub.SourceSha256 == job.ImageSha256
            ):
                sub.OcrStatus = "FAILED"
                sub.OcrErrorCode = error_code[:72]
                sub.WorkflowStatus = "CHECK_FAILED"
                sub.OptimisticLockVersion = int(sub.OptimisticLockVersion or 1) + 1
                sub.UpdatedAt = now
        elif (
            job.JobKind in (JOB_KIND_ADMIN_UPLOAD, JOB_KIND_ADMIN_REUPLOAD, JOB_KIND_ADMIN_REPROCESS)
            and job.PageId is not None
        ):
            page = await self.db.scalar(
                select(BookPage).where(BookPage.Id == job.PageId).with_for_update()
            )
            if page is not None and page.LifecycleStatus != "RETIRED":
                meta = dict(page.ProcessingMeta or {})
                meta["last_ocr_job_id"] = str(job.Id)
                meta["last_ocr_error_code"] = error_code[:72]
                page.ProcessingMeta = meta

    async def fail_job(
        self,
        *,
        job_id: UUID,
        worker_id: str,
        fencing_token: int,
        error_code: str,
        error_message: str | None = None,
        retryable: bool = True,
        engine_diagnostics: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        now = datetime.now(timezone.utc)
        job = await self.repo.get(job_id, lock=True)
        if job is None:
            raise HTTPException(status_code=404, detail="OCR inference job not found.")
        if job.Status == "CANCELLED":
            await self.db.rollback()
            return {
                "job_id": str(job.Id),
                "status": "CANCELLED",
                "fencing_token": int(job.FencingToken),
                "next_retry_at": None,
            }
        if (
            job.Status not in ("CLAIMED", "RUNNING")
            or job.WorkerId != worker_id
            or int(job.FencingToken or 0) != int(fencing_token)
        ):
            await self.db.rollback()
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail="Fencing token mismatch or lease lost.",
            )

        clean_code = (error_code or "OCR_WORKER_ERROR").strip()[:72]
        job.ErrorCode = clean_code
        job.ErrorMessage = _sanitize_error_message(error_message)
        if engine_diagnostics:
            job.EngineDiagnostics = dict(engine_diagnostics)
        job.LeaseExpiresAt = None
        job.UpdatedAt = now

        if retryable and int(job.AttemptCount or 0) < int(job.MaxAttempts or DEFAULT_MAX_ATTEMPTS):
            delay_seconds = min(300, 5 * (2 ** max(0, int(job.AttemptCount or 1) - 1)))
            job.Status = "FAILED_RETRYABLE"
            job.RetryDelaySeconds = delay_seconds
            job.NextRetryAt = now + timedelta(seconds=delay_seconds)
        else:
            job.Status = "DEAD_LETTER"
            job.RetryDelaySeconds = None
            job.NextRetryAt = None
            job.CompletedAt = now
            await self._propagate_dead_letter_to_target(job, error_code=clean_code, now=now)

        await self.db.commit()
        return {
            "job_id": str(job.Id),
            "status": job.Status,
            "fencing_token": int(job.FencingToken),
            "next_retry_at": job.NextRetryAt.isoformat() if job.NextRetryAt else None,
        }

    async def get_active_model_manifest(self) -> dict[str, Any]:
        pointer = await self.repo.get_active_model_pointer()
        profile = str((pointer or {}).get("profile") or "ORIGINAL")
        checkpoint_sha = str(
            (pointer or {}).get("checkpoint_sha256") or ORIGINAL_VIETOCR_SHA256
        ).lower()
        storage_path = (pointer or {}).get("storage_path")
        base: dict[str, Any] = {
            "model_family": str((pointer or {}).get("model_family") or "vietocr_v2"),
            "profile": profile,
            "checkpoint_sha256": checkpoint_sha,
            "storage_path": storage_path,
            "has_custom_config": False,
            "config_sha256": None,
            "shard_count": 0,
            "shards": [],
        }
        if not storage_path:
            return base
        try:
            manifest_bytes = await asyncio.to_thread(self._download_model_ref, str(storage_path))
            manifest = json.loads(manifest_bytes.decode("utf-8"))
        except Exception as exc:
            logger.warning("Failed reading active VietOCR manifest: %s", type(exc).__name__)
            return base

        chunks = manifest.get("chunks") if isinstance(manifest.get("chunks"), list) else []
        config_info = manifest.get("config") if isinstance(manifest.get("config"), dict) else {}
        base["has_custom_config"] = bool(config_info.get("storage_path"))
        base["config_sha256"] = config_info.get("sha256")
        base["shard_count"] = len(chunks)
        base["shards"] = [
            {
                "index": idx,
                "sha256": chunk.get("sha256"),
                "bytes": chunk.get("bytes"),
            }
            for idx, chunk in enumerate(chunks)
            if isinstance(chunk, dict)
        ]
        return base

    def _download_model_ref(self, ref: str) -> bytes:
        from app.services.training_storage.references import is_gdrive_ref

        if is_gdrive_ref(ref):
            from app.services.ocr_engine import get_runtime_artifact_router

            return get_runtime_artifact_router().get(ref)
        return storage_service.download_object(ref)

    async def get_active_model_artifact_bytes(
        self, *, kind: str, shard_index: int | None = None
    ) -> tuple[bytes, str]:
        pointer = await self.repo.get_active_model_pointer()
        storage_path = (pointer or {}).get("storage_path")
        if not storage_path:
            raise HTTPException(status_code=404, detail="No custom active VietOCR artifact.")
        manifest_bytes = await asyncio.to_thread(self._download_model_ref, str(storage_path))
        manifest = json.loads(manifest_bytes.decode("utf-8"))

        if kind == "config":
            config_info = manifest.get("config") or {}
            ref = config_info.get("storage_path")
            expected_sha = str(config_info.get("sha256") or "").lower()
            if not ref:
                raise HTTPException(status_code=404, detail="Active VietOCR config not present.")
        elif kind == "shard":
            chunks = manifest.get("chunks") or []
            if shard_index is None or shard_index < 0 or shard_index >= len(chunks):
                raise HTTPException(status_code=404, detail="Shard index out of range.")
            chunk = chunks[shard_index]
            ref = chunk.get("storage_path")
            expected_sha = str(chunk.get("sha256") or "").lower()
            if not ref:
                raise HTTPException(status_code=404, detail="Shard storage path missing.")
        else:
            raise HTTPException(status_code=400, detail="Unsupported artifact kind.")

        payload = await asyncio.to_thread(self._download_model_ref, str(ref))
        actual_sha = hashlib.sha256(payload).hexdigest()
        if expected_sha and actual_sha != expected_sha:
            raise HTTPException(
                status_code=status.HTTP_502_BAD_GATEWAY,
                detail="Artifact SHA-256 verification failed on backend.",
            )
        return payload, actual_sha

    async def get_job_status_payload(self, job_id: UUID) -> dict[str, Any]:
        job = await self.repo.get(job_id)
        if job is None:
            raise HTTPException(status_code=404, detail="OCR inference job not found.")
        return self.serialize_job(job)

    async def list_book_jobs_payload(self, book_id: UUID, *, limit: int = 200) -> list[dict[str, Any]]:
        rows = await self.repo.list_for_book(book_id, limit=limit)
        return [self.serialize_job(row) for row in rows]

    async def retry_job(self, job_id: UUID) -> dict[str, Any]:
        job = await self.repo.get(job_id, lock=True)
        if job is None:
            raise HTTPException(status_code=404, detail="OCR inference job not found.")
        if job.Status in ACTIVE_JOB_STATUSES:
            await self.db.rollback()
            return self.serialize_job(job)
        if job.Status == "SUCCEEDED":
            await self.db.rollback()
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail="Completed OCR job cannot be retried directly.",
            )
        now = datetime.now(timezone.utc)
        job.Status = "QUEUED"
        job.AttemptCount = 0
        job.WorkerId = None
        job.ClaimedAt = None
        job.HeartbeatAt = None
        job.LeaseExpiresAt = None
        job.NextRetryAt = None
        job.RetryDelaySeconds = None
        job.ErrorCode = None
        job.ErrorMessage = None
        job.CancelledReason = None
        job.CompletedAt = None
        job.Priority = PRIORITY_RETRY
        job.UpdatedAt = now
        await self.db.commit()
        return self.serialize_job(job)

    async def cancel_job(self, job_id: UUID, *, reason: str = "ADMIN_CANCELLED") -> dict[str, Any]:
        job = await self.repo.get(job_id, lock=True)
        if job is None:
            raise HTTPException(status_code=404, detail="OCR inference job not found.")
        if job.Status not in ("SUCCEEDED", "CANCELLED"):
            now = datetime.now(timezone.utc)
            job.Status = "CANCELLED"
            job.CancelledReason = reason[:80]
            job.LeaseExpiresAt = None
            job.CompletedAt = now
            job.UpdatedAt = now
            await self.db.commit()
        else:
            await self.db.rollback()
        return self.serialize_job(job)

    @staticmethod
    def serialize_job(job: OcrInferenceJob) -> dict[str, Any]:
        return {
            "id": str(job.Id),
            "job_kind": job.JobKind,
            "status": job.Status,
            "priority": int(job.Priority),
            "book_id": str(job.BookId) if job.BookId else None,
            "page_id": str(job.PageId) if job.PageId else None,
            "revision_id": str(job.RevisionId) if job.RevisionId else None,
            "submission_id": str(job.SubmissionId) if job.SubmissionId else None,
            "worker_id": job.WorkerId,
            "fencing_token": int(job.FencingToken or 0),
            "attempt_count": int(job.AttemptCount or 0),
            "max_attempts": int(job.MaxAttempts or 3),
            "error_code": job.ErrorCode,
            "error_message": job.ErrorMessage,
            "cancelled_reason": job.CancelledReason,
            "model_profile": job.ModelProfile,
            "model_sha256": job.ModelSha256,
            "duration_ms": job.DurationMs,
            "created_at": job.CreatedAt.isoformat() if job.CreatedAt else None,
            "updated_at": job.UpdatedAt.isoformat() if job.UpdatedAt else None,
            "completed_at": job.CompletedAt.isoformat() if job.CompletedAt else None,
        }
