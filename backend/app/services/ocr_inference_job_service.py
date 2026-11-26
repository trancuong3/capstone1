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
from sqlalchemy import or_, select
from sqlalchemy.exc import IntegrityError
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
from app.services.parent_private_book_post_ocr import (
    align_edited_text_to_words as _shared_align_edited_text_to_words,
    build_empty_text_findings,
    build_image_only_findings,
    build_proofread_suggestions as _shared_build_proofread_suggestions,
    build_rights_declaration_finding,
    build_rule_and_duplicate_findings,
    build_tool_check_scope,
    compact_provider_events,
    compute_candidate_hash as _shared_compute_candidate_hash,
    format_safety_findings,
    normalize_private_book_text,
    should_auto_accept_spelling,
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
OCR_PIPELINE_VERSION = "hybrid_ocr_v2"
ADMIN_JOB_KINDS = (
    JOB_KIND_ADMIN_UPLOAD,
    JOB_KIND_ADMIN_REUPLOAD,
    JOB_KIND_ADMIN_REPROCESS,
)
USER_SCOPED_JOB_KINDS = (
    JOB_KIND_PARENT_SUBMISSION,
    JOB_KIND_LOCAL_SCAN,
)

_TRUTHY_VALUES = {"1", "true", "yes", "on"}
_FALSY_VALUES = {"0", "false", "no", "off"}
_WHITESPACE_RE = re.compile(r"\s+")

_POST_OCR_TASKS: set[asyncio.Task[Any]] = set()
_POST_OCR_SEMAPHORE: asyncio.Semaphore | None = None


def get_ocr_mode() -> str:
    raw = (os.getenv("VIREAD_OCR_MODE") or "").strip().lower()
    if raw in OCR_MODES:
        return raw
    # Fail-closed on production/Render/light-web deployments so missing
    # VIREAD_OCR_MODE can never silently fall back to heavy in-process OCR.
    app_env = (os.getenv("APP_ENVIRONMENT") or APP_ENVIRONMENT or "").strip().lower()
    render_flag = (os.getenv("RENDER") or "").strip().lower()
    disable_heavy = (os.getenv("VIREAD_WEB_DISABLE_HEAVY_WORKERS") or "").strip().lower()
    if (
        app_env == "production"
        or render_flag in _TRUTHY_VALUES
        or disable_heavy in _TRUTHY_VALUES
    ):
        return "remote_worker"
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
    raw = (os.getenv("VIREAD_REMOTE_OCR_SYNC_TIMEOUT_SECONDS") or "").strip()
    if raw:
        try:
            return max(2.0, min(180.0, float(raw)))
        except ValueError:
            pass
    from app.services.remote_ocr_wakeup import is_remote_ocr_scale_to_zero_enabled

    if is_remote_ocr_scale_to_zero_enabled():
        return 90.0
    return 45.0


def compute_candidate_hash(
    text: str | None,
    *,
    source_sha256: str,
    is_image_only: bool = False,
) -> str:
    """Bind candidate snapshot hash to both normalized text and source image digest."""
    return _shared_compute_candidate_hash(
        text,
        source_sha256=source_sha256,
        is_image_only=is_image_only,
    )


def _valid_bbox(raw: object) -> list[float] | None:
    """Coerce list/tuple/dict bounding box into a valid normalized [x, y, w, h] inside [0.0, 1.0]."""
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
    if vals is None or not all(math.isfinite(v) for v in vals):
        return None
    x, y, w, h = vals
    if not (0.0 <= x <= 1.0 and 0.0 <= y <= 1.0 and w > 0.0 and h > 0.0):
        return None
    if x + w > 1.001 or y + h > 1.001:
        return None
    clamped_w = min(w, 1.0 - x)
    clamped_h = min(h, 1.0 - y)
    if clamped_w <= 0.0 or clamped_h <= 0.0:
        return None
    rx = round(x, 6)
    ry = round(y, 6)
    rw = round(min(clamped_w, 1.0 - rx), 6)
    rh = round(min(clamped_h, 1.0 - ry), 6)
    if rw <= 0.0 or rh <= 0.0:
        return None
    return [rx, ry, rw, rh]


def _extract_word_bbox_list(item: dict[str, Any]) -> list[float] | None:
    for key in ("bounding_box", "bbox", "BoundingBox"):
        box = _valid_bbox(item.get(key))
        if box is not None:
            return box
    return None


def align_edited_text_to_words(
    edited_text: str, base_words: list[dict[str, Any]]
) -> list[dict[str, Any]]:
    return _shared_align_edited_text_to_words(edited_text, base_words)


def build_proofread_suggestions(
    ocr_words_or_text: list[dict[str, Any]] | str,
    proofread_text: str,
    uncertain_indices: set[int] | list[int] | None = None,
) -> list[dict[str, Any]]:
    """Canonical word-level proofread suggestions aligned with parent_private_book_pipeline."""
    if isinstance(ocr_words_or_text, str):
        tokens = [
            tok
            for tok in normalize_private_book_text(ocr_words_or_text).split()
            if tok and normalize_word(tok)
        ]
        ocr_words = [{"text": tok} for tok in tokens]
    else:
        ocr_words = [
            w
            for w in (ocr_words_or_text or [])
            if isinstance(w, dict) and normalize_word(str(w.get("text") or ""))
        ]
    return _shared_build_proofread_suggestions(ocr_words, proofread_text, uncertain_indices)


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
    raw = (os.getenv("VIREAD_POST_OCR_CONCURRENCY") or "").strip()
    if raw:
        try:
            parsed = int(raw)
        except ValueError:
            parsed = 1
        return max(1, min(8, parsed))
    # Protect Render Free 512 MB RAM and NullPool DB permits (DATABASE_CONCURRENCY_LIMIT=8)
    # so post-OCR image+LLM work never starves interactive child STT/TTS reading.
    if is_heavy_workers_disabled():
        return 1
    cloud_enabled = (os.getenv("OCR_CLOUD_CORRECTION_ENABLED") or "").strip().lower() in {
        "1", "true", "yes", "on",
    }
    private_cloud = (os.getenv("PRIVATE_BOOK_ALLOW_CLOUD_AI") or "").strip().lower() in {
        "1", "true", "yes", "on",
    }
    return 4 if (cloud_enabled and private_cloud) else 1


_ACTIVE_MODEL_MANIFEST_CACHE: tuple[float, tuple[str, str, str], dict[str, Any]] | None = None
_ACTIVE_MODEL_MANIFEST_CACHE_TTL_SECONDS = 600.0


def clear_active_model_manifest_cache() -> None:
    """Clear cached active VietOCR manifest + signed shard URLs."""
    global _ACTIVE_MODEL_MANIFEST_CACHE
    _ACTIVE_MODEL_MANIFEST_CACHE = None


def _session_in_transaction(db: Any) -> bool:
    """Return True if `db` already had an open transaction before a read helper ran."""
    in_tx = getattr(db, "in_transaction", None)
    if callable(in_tx):
        try:
            return bool(in_tx())
        except Exception:
            return False
    return False


async def _release_clean_self_opened_transaction(db: Any, *, was_in_tx: bool) -> None:
    """Release a read-only transaction opened solely by the current helper without expiring caller ORM objects."""
    if was_in_tx:
        return
    if (
        getattr(db, "new", None)
        or getattr(db, "dirty", None)
        or getattr(db, "deleted", None)
    ):
        return
    try:
        await db.rollback()
    except Exception:
        pass


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


_TRANSIENT_POST_OCR_ERROR_CODES = {
    "PROVIDER_QUOTA",
    "PROVIDER_UNAVAILABLE",
    "PROVIDER_TIMEOUT",
    "PROVIDER_NETWORK",
    "ALL_PROVIDERS_FAILED",
    "CHILD_SAFETY_TIMEOUT",
    "DOCUMENT_TIMEOUT",
    "INCOMPLETE_CHUNK_COVERAGE",
}


def _is_transient_post_ocr_error(exc: Exception) -> bool:
    code = str(getattr(exc, "code", "") or "").upper()
    status_code = getattr(exc, "status_code", None)
    if code in _TRANSIENT_POST_OCR_ERROR_CODES:
        return True
    if status_code in (429, 502, 503, 504):
        return True
    msg = str(exc).lower()
    return "timeout" in msg or "429" in msg or "503" in msg


async def _run_with_transient_retry(
    fn: Any,
    *,
    max_attempts: int = 3,
    base_delay_seconds: float | None = None,
) -> Any:
    delay_base = (
        0.01
        if APP_ENVIRONMENT == "test"
        else (1.0 if base_delay_seconds is None else max(0.0, float(base_delay_seconds)))
    )
    last_exc: Exception | None = None
    for attempt in range(1, max(1, int(max_attempts)) + 1):
        try:
            return await fn()
        except Exception as exc:
            last_exc = exc
            if attempt >= max_attempts or not _is_transient_post_ocr_error(exc):
                raise
            wait_for = delay_base * (2 ** (attempt - 1))
            if wait_for > 0:
                await asyncio.sleep(wait_for)
    assert last_exc is not None
    raise last_exc


async def run_parent_submission_post_ocr(
    submission_id: UUID,
    *,
    proofread_orchestrator: Any | None = None,
    safety_orchestrator: Any | None = None,
    download_bytes: Any | None = None,
) -> dict[str, Any]:
    """Run Stage 2 (AI proofread) & Stage 3 (child safety/quality) strictly using lightweight web deps."""
    from app.models import ParentBookPageSubmission
    from app.repositories.parent_private_book_repository import ParentPrivateBookRepository
    from app.services.ocr_ai.child_safety import (
        ChildSafetyError,
        build_private_book_child_safety_orchestrator,
        content_hash as safety_content_hash,
    )
    from app.services.ocr_ai.config import OcrCorrectionConfig
    from app.services.ocr_ai.exceptions import OcrConfigurationError
    from app.services.ocr_ai.orchestrator import OcrCorrectionOrchestrator, OcrOrchestrationError

    local_ai_enforced = not OcrCorrectionConfig.private_book_allow_cloud_ai()

    async with AsyncSessionLocal() as db:
        row = await db.scalar(
            select(ParentBookPageSubmission).where(ParentBookPageSubmission.Id == submission_id)
        )
        if row is None or row.WorkflowStatus != "CHECKING":
            return {"status": "SKIPPED_NOT_CHECKING", "submission_id": str(submission_id)}
        if row.OcrStatus not in ("COMPLETED", "NO_TEXT_DETECTED"):
            return {"status": "WAITING_FOR_OCR", "submission_id": str(submission_id)}

        snapshot_book_id = row.BookId
        snapshot_version = int(row.SubmissionVersion)
        snapshot_candidate_hash = row.CandidateHash
        snapshot_source_sha256 = row.SourceSha256
        snapshot_storage_path = row.SourceStoragePath
        snapshot_ocr_text = str(row.OcrText or "")
        snapshot_ocr_words = list(row.OcrWordsJson or [])
        snapshot_ocr_meta = dict(row.OcrMetaJson or {}) if isinstance(row.OcrMetaJson, dict) else {}
        snapshot_is_image_only = bool(row.IsImageOnly)
        snapshot_proofread_status = str(row.ProofreadStatus)
        snapshot_tool_status = str(row.ToolCheckStatus)
        snapshot_candidate_text = str(row.CandidateText or "")
        snapshot_candidate_words = list(row.CandidateWordsJson or [])
        snapshot_committed_page_id = getattr(row, "CommittedPageId", None)
        snapshot_committed_revision_id = getattr(row, "CommittedRevisionId", None)
        snapshot_owner_parent_id = getattr(row, "OwnerParentId", None)
        snapshot_source_type = str(getattr(row, "SourceType", "") or "")
        snapshot_source_note = str(row.SourceNote or "")
        snapshot_page_num = int(
            getattr(row, "TargetPageNumber", None)
            or getattr(row, "SourcePageNumber", None)
            or 1
        )
        committed_texts: list[tuple[int, str]] = []
        if snapshot_book_id is not None and hasattr(db, "execute"):
            try:
                committed_texts = await ParentPrivateBookRepository(db).list_committed_page_texts(
                    snapshot_book_id
                )
            except Exception:
                committed_texts = []

    # Lightweight CPU-only V2 content extraction (0 ML imports, <1s) when not yet recorded
    computed_smart_extraction_meta: dict[str, Any] | None = None
    computed_smart_extraction_obj: Any | None = None
    computed_smart_source_words: list[Any] = []
    proofread_input_text = snapshot_candidate_text or snapshot_ocr_text
    proofread_input_words = snapshot_candidate_words or snapshot_ocr_words
    if (
        not snapshot_is_image_only
        and snapshot_ocr_words
        and not isinstance(snapshot_ocr_meta.get("smart_ocr_extraction"), dict)
    ):
        try:
            from app.services.ocr_content_extraction import (
                build_extraction_provenance_meta,
                extract_ocr_content,
                filter_word_dicts_by_extraction,
                ocr_words_from_dicts,
            )
            from app.services.smart_studio_flags import SmartStudioFlags

            computed_smart_source_words = ocr_words_from_dicts(snapshot_ocr_words)
            if computed_smart_source_words:
                computed_smart_extraction_obj = extract_ocr_content(
                    computed_smart_source_words,
                    page_number=max(1, snapshot_page_num),
                    flags=SmartStudioFlags.from_environment(),
                    book_id=snapshot_book_id,
                    book_page_id=snapshot_committed_page_id,
                    page_revision_id=snapshot_committed_revision_id,
                )
                computed_smart_extraction_meta = build_extraction_provenance_meta(
                    computed_smart_extraction_obj,
                    computed_smart_source_words,
                    allow_cloud_ai=not local_ai_enforced,
                )
                if (
                    computed_smart_extraction_obj.filter_mode == "active"
                    and computed_smart_extraction_obj.stats.exclude_blocks > 0
                    and computed_smart_extraction_obj.canonical_text.strip()
                    and snapshot_proofread_status in ("PENDING", "RUNNING", "FAILED")
                ):
                    filtered_post_words = filter_word_dicts_by_extraction(
                        snapshot_ocr_words, computed_smart_extraction_obj
                    )
                    if filtered_post_words:
                        proofread_input_text = normalize_private_book_text(
                            computed_smart_extraction_obj.canonical_text
                        )
                        proofread_input_words = filtered_post_words
        except Exception as exc:
            logger.warning(
                "Non-fatal post-OCR CPU extraction skipped for submission %s: %s",
                submission_id,
                type(exc).__name__,
            )

    # Stage 2: AI proofreading (privacy-safe local default; respects PRIVATE_BOOK_ALLOW_CLOUD_AI)
    if (
        not snapshot_is_image_only
        and snapshot_proofread_status in ("PENDING", "RUNNING", "FAILED")
    ):
        events: list[dict[str, object]] = []
        try:
            downloader = download_bytes or (
                lambda path: storage_service.download_object(
                    path, bucket_name=SUPABASE_PRIVATE_BOOKS_BUCKET
                )
            )
            image_bytes = await asyncio.to_thread(downloader, snapshot_storage_path)
            if hashlib.sha256(image_bytes).hexdigest() != snapshot_source_sha256:
                raise RuntimeError("SOURCE_IMAGE_HASH_MISMATCH")

            # Filter standalone punctuation (e.g. Vietnamese dialogue dash '–'/'—')
            # identically to chunk_ocr_text(..., word_normalizer=normalize_word) so
            # word_boxes always match len(plan.tokens) 1-to-1 with zero WORD_BOX_MISMATCH.
            tokens = [
                t
                for t in _WHITESPACE_RE.split(normalize_private_book_text(proofread_input_text))
                if t and normalize_word(t)
            ]
            filtered_ocr_words = [
                w
                for w in proofread_input_words
                if isinstance(w, dict) and normalize_word(str(w.get("text") or ""))
            ]
            word_boxes: list[tuple[float, float, float, float]] = []
            for idx in range(len(tokens)):
                box = None
                if idx < len(filtered_ocr_words):
                    box = _extract_word_bbox_list(filtered_ocr_words[idx])
                if box is None:
                    box = [0.0, 0.0, 1.0, 1.0]
                word_boxes.append((box[0], box[1], box[2], box[3]))

            orchestrator = proofread_orchestrator or OcrCorrectionOrchestrator(
                OcrCorrectionConfig.from_environment_for_private_book()
            )
            uncertain_set: set[int] = set()

            def _on_event(evt: dict[str, object]) -> None:
                if len(events) < 30:
                    events.append(
                        {
                            "provider": str(evt.get("provider") or "unknown"),
                            "model": evt.get("model"),
                            "stage": "PROOFREADING",
                            "chunk_id": evt.get("chunk_id"),
                            "availability": evt.get("availability"),
                            "error_code": evt.get("error_code"),
                            "duration_ms": evt.get("duration_ms"),
                        }
                    )

            def _on_uncertain(_chunk_id: int, indices: tuple[int, ...]) -> None:
                uncertain_set.update(int(i) for i in indices)

            async def _invoke_proofread() -> str:
                uncertain_set.clear()
                return await orchestrator.correct(
                    proofread_input_text,
                    image_bytes,
                    word_boxes,
                    on_provider_event=_on_event,
                    on_uncertain_tokens=_on_uncertain,
                    word_normalizer=normalize_word,
                )

            proofread_text = await _run_with_transient_retry(_invoke_proofread, max_attempts=3)
            proofread_text = normalize_private_book_text(proofread_text)
            if not proofread_text:
                raise OcrOrchestrationError("EMPTY_PROOFREAD_OUTPUT")
            proofread_hash = safety_content_hash(proofread_text)
            suggestions = build_proofread_suggestions(
                proofread_input_words or proofread_input_text,
                proofread_text,
                uncertain_set,
            )
            aligned_words = align_edited_text_to_words(proofread_text, proofread_input_words)
            new_candidate_hash = compute_candidate_hash(
                proofread_text,
                source_sha256=snapshot_source_sha256,
                is_image_only=False,
            )
        except Exception as exc:
            error_code = (
                getattr(exc, "code", None)
                if isinstance(exc, (OcrOrchestrationError, OcrConfigurationError))
                else ("SOURCE_IMAGE_HASH_MISMATCH" if "HASH_MISMATCH" in str(exc) else "PROOFREAD_FAILED")
            ) or "PROOFREAD_FAILED"
            await _persist_parent_post_ocr_failure(
                submission_id=submission_id,
                expected_version=snapshot_version,
                expected_candidate_hash=snapshot_candidate_hash,
                stage="PROOFREADING",
                error_code=str(error_code)[:72],
                provider_events=events,
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
            if computed_smart_extraction_meta is not None:
                updated_ocr_meta = dict(locked.OcrMetaJson or {}) if isinstance(locked.OcrMetaJson, dict) else {}
                updated_ocr_meta["smart_ocr_extraction"] = computed_smart_extraction_meta
                locked.OcrMetaJson = updated_ocr_meta
            locked.ProofreadStatus = "COMPLETED"
            locked.ProofreadText = proofread_text
            locked.ProofreadHash = proofread_hash
            locked.ProofreadSuggestionsJson = suggestions
            locked.UncertainWordIndicesJson = sorted(uncertain_set)
            locked.ProofreadProviderEventsJson = events
            locked.ProofreadErrorCode = None
            locked.CandidateText = proofread_text
            locked.CandidateWordsJson = aligned_words
            locked.CandidateHash = new_candidate_hash
            locked.SpellingAcceptedAt = (
                now if should_auto_accept_spelling(suggestions, uncertain_set) else None
            )
            locked.OptimisticLockVersion = int(locked.OptimisticLockVersion or 1) + 1
            locked.UpdatedAt = now
            if (
                computed_smart_extraction_obj is not None
                and snapshot_book_id is not None
                and snapshot_committed_page_id is not None
            ):
                from app.services.ocr_content_extraction import persist_extraction_savepoint_safe

                await persist_extraction_savepoint_safe(
                    db,
                    book_id=snapshot_book_id,
                    page_id=snapshot_committed_page_id,
                    page_revision_id=snapshot_committed_revision_id,
                    owner_id=snapshot_owner_parent_id,
                    extraction=computed_smart_extraction_obj,
                    source_words=computed_smart_source_words,
                )
            await db.commit()

            snapshot_candidate_text = proofread_text
            snapshot_candidate_hash = new_candidate_hash
            snapshot_proofread_status = "COMPLETED"
            snapshot_tool_status = str(locked.ToolCheckStatus)

    # Stage 3: Deterministic rules + Duplicate detection + Child Safety + Rights check (fail-closed!)
    if snapshot_tool_status in ("PENDING", "RUNNING", "FAILED"):
        workflow_id = uuid4()
        text_to_check = normalize_private_book_text(snapshot_candidate_text)
        safety_events: list[dict[str, Any]] = []

        if snapshot_is_image_only:
            findings_payload = build_image_only_findings(snapshot_source_sha256)
            scope = build_tool_check_scope(
                chunks_checked=0,
                total_chunks=0,
                requires_admin_visual_review=True,
                local_ai_enforced=local_ai_enforced,
            )
            suitability = "REVIEW_REQUIRED"
            policy_blocked = False
            tool_check_status = "NEEDS_MANUAL_REVIEW"
            is_clean = False
        elif not text_to_check:
            findings_payload = build_empty_text_findings(snapshot_source_sha256)
            scope = build_tool_check_scope(
                chunks_checked=0,
                total_chunks=0,
                requires_admin_visual_review=True,
                local_ai_enforced=local_ai_enforced,
            )
            suitability = "REVIEW_REQUIRED"
            policy_blocked = False
            tool_check_status = "NEEDS_MANUAL_REVIEW"
            is_clean = False
        else:
            findings_payload = build_rule_and_duplicate_findings(
                text_to_check,
                candidate_page_num=snapshot_page_num,
                committed_texts=committed_texts,
            )
            try:
                safety_runner = safety_orchestrator or build_private_book_child_safety_orchestrator()
                safety_result = await _run_with_transient_retry(
                    lambda: safety_runner.analyze(text_to_check),
                    max_attempts=3,
                )
                if not isinstance(safety_result, dict) or not safety_result.get("suitability"):
                    raise ChildSafetyError("INVALID_SAFETY_RESPONSE")
                suitability = str(safety_result.get("suitability") or "REVIEW_REQUIRED")
                raw_findings = safety_result.get("findings")
                if not isinstance(raw_findings, list):
                    raise ChildSafetyError("INVALID_SAFETY_FINDINGS")
                raw_events = safety_result.get("provider_events")
                if isinstance(raw_events, list):
                    safety_events = compact_provider_events(list(raw_events)[:20])
                successful_chunks = sorted(
                    {
                        int(evt.get("chunk_id", 0))
                        for evt in safety_events
                        if evt.get("availability") is True
                    }
                )
                if safety_events and not successful_chunks:
                    raise ChildSafetyError("INCOMPLETE_CHUNK_COVERAGE")
                chunks_checked = len(successful_chunks) if successful_chunks else 1
                total_chunks = max(1, chunks_checked)
                formatted_safety, has_high_safety = format_safety_findings(
                    raw_findings, suitability=suitability
                )
                findings_payload.extend(formatted_safety)
            except Exception as exc:
                error_code = (
                    getattr(exc, "code", None)
                    or ("CHILD_SAFETY_TIMEOUT" if "timeout" in str(exc).lower() else "CHILD_SAFETY_CHECK_FAILED")
                )
                err_events = (
                    compact_provider_events(getattr(exc, "provider_events", None) or [])
                    if isinstance(exc, ChildSafetyError)
                    else safety_events
                )
                await _persist_parent_post_ocr_failure(
                    submission_id=submission_id,
                    expected_version=snapshot_version,
                    expected_candidate_hash=snapshot_candidate_hash,
                    stage="TOOL_CHECK",
                    error_code=str(error_code)[:72],
                    provider_events=err_events,
                    workflow_id=workflow_id,
                )
                return {"status": "CHECK_FAILED", "stage": "TOOL_CHECK", "error_code": error_code}

            rights_finding = build_rights_declaration_finding(
                source_type=snapshot_source_type,
                source_note=snapshot_source_note,
                source_sha256=snapshot_source_sha256,
            )
            if rights_finding is not None:
                findings_payload.append(rights_finding)

            scope = build_tool_check_scope(
                chunks_checked=chunks_checked,
                total_chunks=total_chunks,
                requires_admin_visual_review=False,
                local_ai_enforced=local_ai_enforced,
            )
            policy_blocked = bool(has_high_safety)
            is_clean = (
                suitability == "SUITABLE"
                and len(findings_payload) == 0
                and not policy_blocked
                and not bool(scope.get("requires_admin_visual_review"))
            )
            tool_check_status = (
                "PASSED"
                if is_clean
                else ("FLAGGED" if (findings_payload or suitability != "SUITABLE") else "NEEDS_MANUAL_REVIEW")
            )

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
            if computed_smart_extraction_meta is not None and not isinstance(
                (locked.OcrMetaJson or {}).get("smart_ocr_extraction")
                if isinstance(locked.OcrMetaJson, dict)
                else None,
                dict,
            ):
                updated_ocr_meta = (
                    dict(locked.OcrMetaJson or {})
                    if isinstance(locked.OcrMetaJson, dict)
                    else {}
                )
                updated_ocr_meta["smart_ocr_extraction"] = computed_smart_extraction_meta
                locked.OcrMetaJson = updated_ocr_meta
            locked.ToolCheckStatus = tool_check_status
            locked.ToolCheckInputHash = snapshot_candidate_hash
            locked.ToolCheckSuitability = suitability
            locked.ToolCheckScopeJson = scope
            locked.ToolCheckFindingsJson = findings_payload
            locked.ToolCheckProviderEventsJson = safety_events
            locked.ToolCheckErrorCode = None
            locked.ToolCheckPolicyBlocked = policy_blocked
            locked.ToolCheckWorkflowId = workflow_id
            locked.ToolCheckCompletedAt = now
            locked.WorkflowStatus = "PASSED_READY_TO_ADD" if is_clean else "NEEDS_ADMIN_REVIEW"
            locked.WorkerId = None
            locked.LeaseExpiresAt = None
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
    provider_events: list[dict[str, Any]] | None = None,
    workflow_id: UUID | None = None,
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
            if provider_events:
                locked.ProofreadProviderEventsJson = provider_events
        else:
            locked.ToolCheckStatus = "FAILED"
            locked.ToolCheckErrorCode = error_code
            locked.ToolCheckSuitability = None
            if provider_events:
                locked.ToolCheckProviderEventsJson = provider_events
            if workflow_id is not None:
                locked.ToolCheckWorkflowId = workflow_id
        locked.WorkflowStatus = "CHECK_FAILED"
        locked.WorkerId = None
        locked.LeaseExpiresAt = None
        locked.OptimisticLockVersion = int(locked.OptimisticLockVersion or 1) + 1
        locked.UpdatedAt = now
        await db.commit()


def _has_live_post_ocr_task(submission_id: UUID) -> bool:
    expected_name = f"parent_submission_post_ocr_{submission_id}"
    return any(
        not task.done() and task.get_name() == expected_name
        for task in list(_POST_OCR_TASKS)
    )


async def reconcile_orphaned_parent_submissions(
    db: AsyncSession | None = None,
    *,
    stale_after_seconds: int = 90,
    max_attempts: int = DEFAULT_MAX_ATTEMPTS,
    limit: int = 50,
    reschedule: bool = True,
    now: datetime | None = None,
) -> dict[str, Any]:
    """Reclaim `CHECKING` parent submissions orphaned after a Render web restart.

    In `remote_worker` mode, Stage 2+3 post-OCR runs on the web tier without ML
    weights. If the web dyno restarts mid-stage, rows stay in `CHECKING` with
    `OcrStatus IN ('COMPLETED', 'NO_TEXT_DETECTED')` and pending proofread/tool
    check. This reconciler cleanly re-schedules them (up to `max_attempts`) or
    fails them closed so no submission remains stuck forever.
    """
    current_time = now or datetime.now(timezone.utc)
    cutoff = current_time - timedelta(seconds=max(0, stale_after_seconds))
    reclaimed_ids: list[UUID] = []
    failed_ids: list[UUID] = []

    async def _reconcile_in_session(session: AsyncSession) -> None:
        query = (
            select(ParentBookPageSubmission)
            .where(
                ParentBookPageSubmission.WorkflowStatus == "CHECKING",
                ParentBookPageSubmission.OcrStatus.in_(("COMPLETED", "NO_TEXT_DETECTED")),
                or_(
                    ParentBookPageSubmission.ProofreadStatus.in_(("PENDING", "RUNNING")),
                    ParentBookPageSubmission.ToolCheckStatus.in_(("PENDING", "RUNNING")),
                ),
            )
            .order_by(ParentBookPageSubmission.UpdatedAt.asc())
            .limit(max(1, min(limit, 200)))
            .with_for_update(skip_locked=True)
        )
        rows = list((await session.scalars(query)).all())
        for row in rows:
            if _has_live_post_ocr_task(row.Id):
                continue
            updated_at = row.UpdatedAt
            if stale_after_seconds > 0 and updated_at is not None and updated_at > cutoff:
                continue

            attempts = int(row.Attempts or 0)
            if attempts >= max_attempts:
                if row.ProofreadStatus in ("PENDING", "RUNNING") and not bool(row.IsImageOnly):
                    row.ProofreadStatus = "FAILED"
                    row.ProofreadErrorCode = "POST_OCR_ORPHANED_MAX_ATTEMPTS"
                else:
                    row.ToolCheckStatus = "FAILED"
                    row.ToolCheckErrorCode = "POST_OCR_ORPHANED_MAX_ATTEMPTS"
                    row.ToolCheckSuitability = None
                row.WorkflowStatus = "CHECK_FAILED"
                row.WorkerId = None
                row.LeaseExpiresAt = None
                row.OptimisticLockVersion = int(row.OptimisticLockVersion or 1) + 1
                row.UpdatedAt = current_time
                failed_ids.append(row.Id)
            else:
                if row.ProofreadStatus == "RUNNING":
                    row.ProofreadStatus = "PENDING"
                if row.ToolCheckStatus == "RUNNING":
                    row.ToolCheckStatus = "PENDING"
                row.Attempts = attempts + 1
                row.WorkerId = None
                row.LeaseExpiresAt = None
                row.OptimisticLockVersion = int(row.OptimisticLockVersion or 1) + 1
                row.UpdatedAt = current_time
                reclaimed_ids.append(row.Id)

        if reclaimed_ids or failed_ids:
            await session.commit()

    if db is not None:
        await _reconcile_in_session(db)
    else:
        async with AsyncSessionLocal() as session:
            await _reconcile_in_session(session)

    if reschedule:
        for submission_id in reclaimed_ids:
            schedule_parent_submission_post_ocr(submission_id)

    return {
        "reclaimed_count": len(reclaimed_ids),
        "failed_count": len(failed_ids),
        "reclaimed_submission_ids": [str(item) for item in reclaimed_ids],
        "failed_submission_ids": [str(item) for item in failed_ids],
    }


class OcrInferenceJobService:
    """Backend orchestrator for durable OCR inference jobs and remote worker leases."""

    def __init__(self, db: AsyncSession):
        self.db = db
        self.repo = OcrInferenceJobRepository(db)

    async def _persist_job_with_idempotency_recovery(
        self,
        job: OcrInferenceJob,
        *,
        clean_idem: str | None,
        job_kind: str,
        owner_user_id: UUID | None,
        image_sha256: str,
        page_id: UUID | None,
    ) -> tuple[OcrInferenceJob, bool]:
        """Insert a job while gracefully recovering from concurrent duplicate idempotency IntegrityError."""
        try:
            if hasattr(self.db, "begin_nested"):
                async with self.db.begin_nested():
                    await self.repo.create_job(job)
            else:
                await self.repo.create_job(job)
            return job, True
        except IntegrityError:
            if clean_idem is None:
                raise
            existing = await self.repo.get_by_idempotency(
                job_kind, owner_user_id, clean_idem
            )
            if existing is None:
                raise
            if existing.ImageSha256 != image_sha256 or (
                page_id is not None and existing.PageId not in (None, page_id)
            ):
                raise HTTPException(
                    status_code=status.HTTP_409_CONFLICT,
                    detail="Idempotency key already used for a different OCR payload.",
                )
            setattr(existing, "should_schedule_post_ocr", False)
            return existing, False

    async def _resolve_cache_key_components(
        self, processing_meta: dict[str, Any] | None = None
    ) -> tuple[str, str, str | None, str]:
        meta = dict(processing_meta or {})
        pointer = await self.repo.get_active_model_pointer()
        profile = str(
            meta.get("active_model_profile")
            or meta.get("expected_model_profile")
            or (pointer or {}).get("profile")
            or "ORIGINAL"
        )
        model_sha = str(
            meta.get("active_model_sha256")
            or (pointer or {}).get("checkpoint_sha256")
            or ORIGINAL_VIETOCR_SHA256
        ).lower()
        config_sha = meta.get("active_config_sha256")
        if config_sha is None and pointer and pointer.get("config_sha256"):
            config_sha = str(pointer["config_sha256"]).lower()
        pipeline_version = str(meta.get("pipeline_version") or OCR_PIPELINE_VERSION)
        return profile, model_sha, config_sha, pipeline_version

    async def _apply_parent_submission_ocr_result(
        self,
        *,
        job: OcrInferenceJob,
        worker_id: str,
        clean_full_text: str,
        normalized_words: list[dict[str, Any]],
        ocr_meta: dict[str, Any],
        no_text_detected: bool,
        model_profile: str | None,
        model_sha256: str | None,
        now: datetime,
    ) -> UUID:
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
            # Lightweight CPU-only V2 content extraction (0 ML imports, <1s, savepoint-guarded)
            candidate_text = clean_full_text
            candidate_words = normalized_words
            parent_extraction_obj: Any | None = None
            parent_source_words: list[Any] = []
            try:
                from app.services.ocr_content_extraction import (
                    build_extraction_provenance_meta,
                    extract_ocr_content,
                    filter_word_dicts_by_extraction,
                    ocr_words_from_dicts,
                )
                from app.services.smart_studio_flags import SmartStudioFlags

                parent_source_words = ocr_words_from_dicts(normalized_words)
                if parent_source_words:
                    page_num = max(
                        1,
                        int(
                            getattr(sub, "TargetPageNumber", None)
                            or getattr(sub, "SourcePageNumber", None)
                            or 1
                        ),
                    )
                    parent_extraction_obj = extract_ocr_content(
                        parent_source_words,
                        page_number=page_num,
                        flags=SmartStudioFlags.from_environment(),
                        book_id=sub.BookId,
                        book_page_id=getattr(sub, "CommittedPageId", None),
                        page_revision_id=getattr(sub, "CommittedRevisionId", None),
                    )
                    merged_meta["smart_ocr_extraction"] = build_extraction_provenance_meta(
                        parent_extraction_obj,
                        parent_source_words,
                        allow_cloud_ai=False,
                    )
                    sub.OcrMetaJson = merged_meta
                    if (
                        parent_extraction_obj.filter_mode == "active"
                        and parent_extraction_obj.stats.exclude_blocks > 0
                        and parent_extraction_obj.canonical_text.strip()
                    ):
                        filtered_parent_words = filter_word_dicts_by_extraction(
                            normalized_words, parent_extraction_obj
                        )
                        if filtered_parent_words:
                            candidate_text = normalize_private_book_text(
                                parent_extraction_obj.canonical_text
                            )
                            candidate_words = filtered_parent_words
            except Exception as exc:
                logger.warning(
                    "Non-fatal CPU extraction skipped in _apply_parent_submission_ocr_result: %s",
                    type(exc).__name__,
                )

            sub.OcrStatus = "COMPLETED"
            sub.IsImageOnly = False
            sub.OcrText = clean_full_text
            sub.OcrWordsJson = normalized_words
            sub.OcrHash = hashlib.sha256(
                " ".join(unicodedata.normalize("NFC", clean_full_text).split()).encode("utf-8")
            ).hexdigest()
            sub.ProofreadStatus = "PENDING"
            sub.CandidateText = candidate_text
            sub.CandidateWordsJson = candidate_words
            sub.CandidateHash = compute_candidate_hash(
                candidate_text, source_sha256=sub.SourceSha256, is_image_only=False
            )
            committed_page_id = getattr(sub, "CommittedPageId", None)
            if (
                parent_extraction_obj is not None
                and sub.BookId is not None
                and committed_page_id is not None
            ):
                from app.services.ocr_content_extraction import persist_extraction_savepoint_safe

                await persist_extraction_savepoint_safe(
                    self.db,
                    book_id=sub.BookId,
                    page_id=committed_page_id,
                    page_revision_id=getattr(sub, "CommittedRevisionId", None),
                    owner_id=getattr(sub, "OwnerParentId", None),
                    extraction=parent_extraction_obj,
                    source_words=parent_source_words,
                )

        sub.OptimisticLockVersion = int(sub.OptimisticLockVersion or 1) + 1
        sub.UpdatedAt = now
        return sub.Id

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
        schedule_post_ocr: bool = True,
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
                setattr(existing, "should_schedule_post_ocr", False)
                return existing
        else:
            active_dup = await self.repo.find_active_duplicate_job(
                job_kind=job_kind,
                image_sha256=image_sha256,
                owner_user_id=owner_user_id,
                page_id=page_id,
                submission_id=submission_id,
            )
            if active_dup is not None:
                setattr(active_dup, "should_schedule_post_ocr", False)
                return active_dup

        if book_id is not None:
            book_row = await self.db.scalar(select(Book).where(Book.Id == book_id))
            if book_row is not None and (
                getattr(book_row, "IsDeleted", False)
                or book_row.LifecycleStatus == "RETIRED"
            ):
                raise HTTPException(
                    status_code=status.HTTP_409_CONFLICT,
                    detail={"code": "BOOK_SOFT_DELETED", "reason": "BOOK_SOFT_DELETED"},
                )

        now = datetime.now(timezone.utc)
        (
            active_profile,
            active_model_sha,
            active_config_sha,
            pipeline_version,
        ) = await self._resolve_cache_key_components(processing_meta)
        meta = dict(processing_meta or {})
        meta.setdefault("active_model_profile", active_profile)
        meta.setdefault("active_model_sha256", active_model_sha)
        meta.setdefault("active_config_sha256", active_config_sha)
        meta.setdefault("pipeline_version", pipeline_version)

        cached_hit: OcrInferenceJob | None = None
        if not meta.get("bypass_ocr_cache"):
            cached_hit = await self.repo.find_completed_cached_job(
                job_kind=job_kind,
                owner_user_id=owner_user_id,
                image_sha256=image_sha256,
                active_model_profile=active_profile,
                active_model_sha256=active_model_sha,
                active_config_sha256=active_config_sha,
                pipeline_version=pipeline_version,
                admin_job_kinds=ADMIN_JOB_KINDS,
                user_job_kinds=USER_SCOPED_JOB_KINDS,
            )

        if cached_hit is not None and isinstance(cached_hit.ResultPayload, dict):
            cached_payload = dict(cached_hit.ResultPayload)
            cached_words = _normalize_worker_words(list(cached_payload.get("words") or []))
            cached_text = unicodedata.normalize(
                "NFC", str(cached_payload.get("full_text") or "")
            ).strip()
            cached_no_text = bool(cached_payload.get("no_text_detected")) or (
                not cached_words and not cached_text
            )
            cached_meta = dict(cached_payload.get("ocr_meta") or {})
            cached_meta["ocr_cache_hit"] = True
            cached_meta["ocr_cache_source_job_id"] = str(cached_hit.Id)
            meta["ocr_cache_hit"] = True
            meta["ocr_cache_source_job_id"] = str(cached_hit.Id)

            job = OcrInferenceJob(
                Id=uuid4(),
                JobKind=job_kind,
                Status="SUCCEEDED",
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
                ProcessingMeta=meta,
                ExpectedVersion=int(expected_version),
                ExpectedCandidateHash=expected_candidate_hash,
                ExpectedVerifiedRevisionId=expected_verified_revision_id,
                ExpectedLatestRevisionId=expected_latest_revision_id,
                FencingToken=0,
                WorkerId="ocr-cache",
                AttemptCount=0,
                MaxAttempts=max(1, min(20, int(max_attempts))),
                ResultPayload=cached_payload,
                ModelProfile=active_profile,
                ModelSha256=active_model_sha,
                EngineDiagnostics={"cache_hit": True, "source_job_id": str(cached_hit.Id)},
                DurationMs=0,
                CreatedAt=now,
                UpdatedAt=now,
                CompletedAt=now,
            )
            job, created = await self._persist_job_with_idempotency_recovery(
                job,
                clean_idem=clean_idem,
                job_kind=job_kind,
                owner_user_id=owner_user_id,
                image_sha256=image_sha256,
                page_id=page_id,
            )
            if not created:
                return job

            if job_kind in ADMIN_JOB_KINDS:
                from app.services.admin_ocr_service import AdminOcrService

                applied = await AdminOcrService(self.db).apply_remote_ocr_job_completion(
                    job=job,
                    full_text=cached_text,
                    words=cached_words,
                    ocr_meta=cached_meta,
                    no_text_detected=cached_no_text,
                    model_profile=active_profile,
                    model_sha256=active_model_sha,
                    now=now,
                )
                if applied.get("stale_reason"):
                    job.Status = "CANCELLED"
                    job.CancelledReason = str(applied["stale_reason"])
                    job.CompletedAt = now
                    job.UpdatedAt = now
                    if job.CancelledReason == "BOOK_SOFT_DELETED":
                        raise HTTPException(
                            status_code=status.HTTP_409_CONFLICT,
                            detail={"code": "BOOK_SOFT_DELETED", "reason": "BOOK_SOFT_DELETED"},
                        )
                    raise HTTPException(
                        status_code=status.HTTP_409_CONFLICT,
                        detail={"code": "STALE_TARGET_MODIFIED", "reason": job.CancelledReason},
                    )
                job.RevisionId = applied.get("revision_id")
                setattr(job, "should_schedule_post_ocr", False)
            elif job_kind == JOB_KIND_PARENT_SUBMISSION:
                sub_id = await self._apply_parent_submission_ocr_result(
                    job=job,
                    worker_id="ocr-cache",
                    clean_full_text=cached_text,
                    normalized_words=cached_words,
                    ocr_meta=cached_meta,
                    no_text_detected=cached_no_text,
                    model_profile=active_profile,
                    model_sha256=active_model_sha,
                    now=now,
                )
                setattr(job, "should_schedule_post_ocr", True)
                if schedule_post_ocr:
                    schedule_parent_submission_post_ocr(sub_id)
            else:
                setattr(job, "should_schedule_post_ocr", False)
            return job

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
            ProcessingMeta=meta,
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
        persisted, _created = await self._persist_job_with_idempotency_recovery(
            job,
            clean_idem=clean_idem,
            job_kind=job_kind,
            owner_user_id=owner_user_id,
            image_sha256=image_sha256,
            page_id=page_id,
        )
        setattr(persisted, "should_schedule_post_ocr", False)
        if str(persisted.Status or "").upper() == "QUEUED":
            from app.services.remote_ocr_wakeup import schedule_post_commit_ocr_wakeup

            schedule_post_commit_ocr_wakeup(
                self.db,
                job_id=persisted.Id,
                reason=f"enqueue:{job_kind}",
            )
        return persisted

    async def has_online_worker(self) -> bool:
        was_in_tx = _session_in_transaction(self.db)
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
                await _release_clean_self_opened_transaction(self.db, was_in_tx=was_in_tx)
                return True

        from app.services.remote_ocr_wakeup import (
            is_remote_worker_wakeup_configured,
            peek_cached_remote_ocr_worker_health,
            probe_configured_remote_ocr_worker_health,
        )

        if not is_remote_worker_wakeup_configured():
            await _release_clean_self_opened_transaction(self.db, was_in_tx=was_in_tx)
            return False

        cache_valid, cached_probe = peek_cached_remote_ocr_worker_health()
        if cache_valid:
            await _release_clean_self_opened_transaction(self.db, was_in_tx=was_in_tx)
            return bool(cached_probe and cached_probe.get("online"))

        await _release_clean_self_opened_transaction(self.db, was_in_tx=was_in_tx)
        probe = await probe_configured_remote_ocr_worker_health()
        return bool(probe and probe.get("online"))

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
        poll_interval_seconds: float | None = None,
    ) -> OcrInferenceJob:
        deadline = asyncio.get_running_loop().time() + float(
            timeout_seconds or remote_sync_wait_timeout_seconds()
        )
        attempt = 0
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
            if poll_interval_seconds is not None:
                sleep_for = poll_interval_seconds
            elif APP_ENVIRONMENT == "test":
                sleep_for = 0.15
            else:
                # Adaptive backoff (1.5s -> 2.5s -> 4.0s) to protect Supabase pooler under concurrency.
                sleep_for = 1.5 if attempt < 4 else (2.5 if attempt < 10 else 4.0)
            attempt += 1
            await asyncio.sleep(min(sleep_for, remaining))

    async def reap_expired_leases(
        self,
        *,
        now: datetime | None = None,
        retry_delay_seconds: int = 0,
    ) -> dict[str, int]:
        """Independent stale-job lease reaper for cron & periodic reconciler."""
        current = now or datetime.now(timezone.utc)
        reclaimed, dead_lettered = await self.repo.reclaim_expired_leases(
            now=current,
            retry_delay_seconds=retry_delay_seconds,
        )
        for reclaimed_job in reclaimed:
            if (
                reclaimed_job.JobKind == JOB_KIND_PARENT_SUBMISSION
                and reclaimed_job.SubmissionId is not None
            ):
                sub = await self.db.scalar(
                    select(ParentBookPageSubmission)
                    .where(ParentBookPageSubmission.Id == reclaimed_job.SubmissionId)
                    .with_for_update()
                )
                if (
                    sub is not None
                    and sub.WorkflowStatus == "CHECKING"
                    and sub.OcrStatus == "RUNNING"
                ):
                    sub.OcrStatus = "PENDING"
                    sub.UpdatedAt = current
        for expired_job in dead_lettered:
            await self._propagate_dead_letter_to_target(
                expired_job,
                error_code="LEASE_EXPIRED_MAX_ATTEMPTS",
                now=current,
            )
        if reclaimed or dead_lettered:
            if reclaimed:
                from app.services.remote_ocr_wakeup import schedule_post_commit_ocr_wakeup

                schedule_post_commit_ocr_wakeup(
                    self.db,
                    job_id=reclaimed[0].Id,
                    reason="lease_reclaimed",
                )
            await self.db.commit()
            for expired_job in dead_lettered:
                if expired_job.JobKind == JOB_KIND_LOCAL_SCAN:
                    await self._cleanup_local_scan_temp_object(expired_job)
        return {
            "reclaimed": len(reclaimed),
            "dead_lettered": len(dead_lettered),
        }

    async def prune_stale_worker_heartbeats(
        self,
        *,
        max_age_hours: int = 24,
        now: datetime | None = None,
    ) -> int:
        """Delete stale ocr_worker_heartbeats older than max_age_hours."""
        pruned = await self.repo.prune_stale_worker_heartbeats(
            max_age_hours=max_age_hours,
            now=now,
        )
        if pruned > 0:
            await self.db.commit()
        return pruned

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

    async def _build_source_descriptor_async(
        self,
        *,
        job_id: UUID,
        worker_id: str,
        fencing_token: int,
        image_path: str,
        image_bucket: str | None,
        expires_in: int = 300,
    ) -> tuple[str | None, str]:
        fallback_path = (
            f"/internal/ocr-jobs/{job_id}/source"
            f"?worker_id={worker_id}&fencing_token={int(fencing_token)}"
        )
        local_dir = (os.getenv("VIREAD_LOCAL_STORAGE_DIR") or "").strip()
        if local_dir or APP_ENVIRONMENT == "test":
            return None, fallback_path
        try:
            signed = await asyncio.to_thread(
                storage_service.create_signed_image_url,
                image_path,
                bucket_name=image_bucket,
                ttl_seconds=expires_in,
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

        if job.JobKind == JOB_KIND_PARENT_SUBMISSION and job.SubmissionId is not None:
            sub = await self.db.scalar(
                select(ParentBookPageSubmission)
                .where(ParentBookPageSubmission.Id == job.SubmissionId)
                .with_for_update()
            )
            if (
                sub is not None
                and sub.WorkflowStatus == "CHECKING"
                and sub.OcrStatus in ("PENDING", "FAILED")
                and int(sub.SubmissionVersion) == int(job.ExpectedVersion)
                and sub.SourceSha256 == job.ImageSha256
            ):
                sub.OcrStatus = "RUNNING"
                sub.UpdatedAt = now

        job_id = job.Id
        job_kind = job.JobKind
        job_priority = int(job.Priority)
        job_fencing = int(job.FencingToken)
        job_attempt = int(job.AttemptCount)
        job_max_attempts = int(job.MaxAttempts)
        job_lease_iso = job.LeaseExpiresAt.isoformat() if job.LeaseExpiresAt else None
        job_sha = job.ImageSha256
        job_mime = job.ImageMimeType
        job_width = job.ImageWidth
        job_height = job.ImageHeight
        job_expected_ver = int(job.ExpectedVersion)
        job_image_path = job.ImagePath
        job_image_bucket = job.ImageBucket
        job_worker = job.WorkerId or worker_id
        job_expected_profile = (job.ProcessingMeta or {}).get("expected_model_profile")

        # Commit DB transaction BEFORE calling Supabase Storage signed URL API so row locks
        # and ConcurrencyLimitedAsyncSession permits are never held across network I/O.
        await self.db.commit()

        signed_url, fallback_path = await self._build_source_descriptor_async(
            job_id=job_id,
            worker_id=job_worker,
            fencing_token=job_fencing,
            image_path=job_image_path,
            image_bucket=job_image_bucket,
            expires_in=bounded_lease + 180,
        )
        log_diagnostic(
            logger,
            logging.INFO,
            event="ocr_job_claimed",
            stage="worker_claim",
            job_id=str(job_id),
            job_kind=job_kind,
            worker_id=job_worker,
            fencing_token=job_fencing,
            attempt=job_attempt,
        )
        return {
            "job_id": str(job_id),
            "job_kind": job_kind,
            "priority": job_priority,
            "fencing_token": job_fencing,
            "attempt_count": job_attempt,
            "max_attempts": job_max_attempts,
            "lease_expires_at": job_lease_iso,
            "image_sha256": job_sha,
            "image_mime_type": job_mime,
            "image_width": job_width,
            "image_height": job_height,
            "expected_version": job_expected_ver,
            "source_url": signed_url,
            "source_fallback_path": fallback_path,
            "refresh_url_path": f"/internal/ocr-jobs/{job_id}/refresh-source-url",
            "expected_model_profile": job_expected_profile,
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

    async def _is_book_deleted(self, book_id: UUID | None) -> bool:
        if book_id is None:
            return False
        book = await self.db.scalar(select(Book).where(Book.Id == book_id))
        if book is None:
            return False
        return bool(getattr(book, "IsDeleted", False) or book.LifecycleStatus == "RETIRED")

    async def _is_target_still_current(self, job: OcrInferenceJob) -> tuple[bool, str | None]:
        if await self._is_book_deleted(job.BookId):
            return False, "BOOK_SOFT_DELETED"

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
            if await self._is_book_deleted(page.BookId):
                return False, "BOOK_SOFT_DELETED"
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
        await self.repo.touch_worker_heartbeat(
            worker_id=worker_id.strip()[:120],
            status="BUSY",
            active_job_id=job.Id,
            active_job_count=1,
            now=now,
        )
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
        captured_id = job.Id
        captured_fencing = int(job.FencingToken)
        captured_sha = job.ImageSha256
        captured_path = job.ImagePath
        captured_bucket = job.ImageBucket
        # Release row lock & DB concurrency permit BEFORE calling Storage signed URL API.
        await self.db.rollback()
        signed_url, fallback_path = await self._build_source_descriptor_async(
            job_id=captured_id,
            worker_id=worker_id,
            fencing_token=captured_fencing,
            image_path=captured_path,
            image_bucket=captured_bucket,
            expires_in=expires_in,
        )
        return {
            "job_id": str(captured_id),
            "fencing_token": captured_fencing,
            "image_sha256": captured_sha,
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
            cancelled_reason = job.CancelledReason or "CANCELLED"
            await self.db.rollback()
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail={
                    "code": "BOOK_SOFT_DELETED" if cancelled_reason == "BOOK_SOFT_DELETED" else "JOB_CANCELLED",
                    "cancelled_reason": cancelled_reason,
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
        if await self._is_book_deleted(job.BookId):
            job.Status = "CANCELLED"
            job.CancelledReason = "BOOK_SOFT_DELETED"
            job.LeaseExpiresAt = None
            job.CompletedAt = now
            job.UpdatedAt = now
            await self.db.commit()
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail={
                    "code": "BOOK_SOFT_DELETED",
                    "reason": "BOOK_SOFT_DELETED",
                },
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
                if job.CancelledReason == "BOOK_SOFT_DELETED":
                    raise HTTPException(
                        status_code=status.HTTP_409_CONFLICT,
                        detail={
                            "code": "BOOK_SOFT_DELETED",
                            "reason": "BOOK_SOFT_DELETED",
                        },
                    )
                raise HTTPException(
                    status_code=status.HTTP_409_CONFLICT,
                    detail={
                        "code": "STALE_TARGET_MODIFIED",
                        "reason": job.CancelledReason,
                    },
                )
            job.RevisionId = applied.get("revision_id")

        elif job.JobKind == JOB_KIND_PARENT_SUBMISSION:
            should_schedule_post_ocr_submission_id = await self._apply_parent_submission_ocr_result(
                job=job,
                worker_id=worker_id,
                clean_full_text=clean_full_text,
                normalized_words=normalized_words,
                ocr_meta=dict(ocr_meta or {}),
                no_text_detected=bool(no_text_detected),
                model_profile=model_profile,
                model_sha256=model_sha256,
                now=now,
            )

        proc_meta = dict(job.ProcessingMeta or {})
        eff_profile = model_profile or proc_meta.get("active_model_profile") or "ORIGINAL"
        eff_model_sha = (
            model_sha256
            or proc_meta.get("active_model_sha256")
            or ORIGINAL_VIETOCR_SHA256
        )
        eff_config_sha = proc_meta.get("active_config_sha256")
        eff_pipeline = str(proc_meta.get("pipeline_version") or OCR_PIPELINE_VERSION)

        local_scan_extraction_summary: dict[str, Any] | None = None
        if job.JobKind == JOB_KIND_LOCAL_SCAN and not no_text_detected and normalized_words:
            try:
                from app.services.ocr_content_extraction import (
                    extract_ocr_content,
                    ocr_words_from_dicts,
                )
                from app.services.smart_studio_flags import SmartStudioFlags

                scan_words = ocr_words_from_dicts(normalized_words)
                if scan_words:
                    scan_ext = extract_ocr_content(
                        scan_words,
                        page_number=1,
                        flags=SmartStudioFlags.from_environment(),
                    )
                    local_scan_extraction_summary = {
                        "filter_mode": scan_ext.filter_mode,
                        "page_kind": scan_ext.page_kind,
                        "canonical_text": scan_ext.canonical_text,
                        "requires_review": bool(scan_ext.requires_review),
                        "exclude_blocks": scan_ext.stats.exclude_blocks,
                    }
            except Exception:
                local_scan_extraction_summary = None

        job.ResultPayload = {
            "full_text": clean_full_text,
            "words": normalized_words,
            "ocr_meta": dict(ocr_meta or {}),
            "no_text_detected": bool(no_text_detected),
            **(
                {"smart_ocr_extraction": local_scan_extraction_summary}
                if local_scan_extraction_summary is not None
                else {}
            ),
            "cache_key": {
                "image_sha256": job.ImageSha256,
                "active_model_profile": eff_profile,
                "active_model_sha256": eff_model_sha,
                "active_config_sha256": eff_config_sha,
                "pipeline_version": eff_pipeline,
            },
        }
        job.Status = "SUCCEEDED"
        job.ModelProfile = eff_profile
        job.ModelSha256 = eff_model_sha
        job.EngineDiagnostics = dict(engine_diagnostics or {})
        job.DurationMs = duration_ms
        job.LeaseExpiresAt = None
        job.CompletedAt = now
        job.UpdatedAt = now
        await self.repo.touch_worker_heartbeat(
            worker_id=worker_id.strip()[:120],
            status="IDLE",
            active_job_id=None,
            active_job_count=0,
            now=now,
        )
        await self.db.commit()

        if job.JobKind == JOB_KIND_LOCAL_SCAN:
            await self._cleanup_local_scan_temp_object(job)

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
            if job.JobKind == JOB_KIND_PARENT_SUBMISSION and job.SubmissionId is not None:
                sub = await self.db.scalar(
                    select(ParentBookPageSubmission)
                    .where(ParentBookPageSubmission.Id == job.SubmissionId)
                    .with_for_update()
                )
                if (
                    sub is not None
                    and sub.WorkflowStatus == "CHECKING"
                    and sub.OcrStatus == "RUNNING"
                ):
                    sub.OcrStatus = "PENDING"
                    sub.UpdatedAt = now
        else:
            job.Status = "DEAD_LETTER"
            job.RetryDelaySeconds = None
            job.NextRetryAt = None
            job.CompletedAt = now
            await self._propagate_dead_letter_to_target(job, error_code=clean_code, now=now)

        await self.repo.touch_worker_heartbeat(
            worker_id=worker_id.strip()[:120],
            status="IDLE",
            active_job_id=None,
            active_job_count=0,
            now=now,
        )
        await self.db.commit()
        if job.Status == "DEAD_LETTER" and job.JobKind == JOB_KIND_LOCAL_SCAN:
            await self._cleanup_local_scan_temp_object(job)
        return {
            "job_id": str(job.Id),
            "status": job.Status,
            "fencing_token": int(job.FencingToken),
            "next_retry_at": job.NextRetryAt.isoformat() if job.NextRetryAt else None,
        }

    async def get_active_model_manifest(self) -> dict[str, Any]:
        global _ACTIVE_MODEL_MANIFEST_CACHE
        import copy as _copy
        import time as _time

        was_in_tx = _session_in_transaction(self.db)
        pointer = await self.repo.get_active_model_pointer()
        await _release_clean_self_opened_transaction(self.db, was_in_tx=was_in_tx)

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
            "config_signed_url": None,
            "shard_count": 0,
            "shards": [],
        }
        if not storage_path:
            return base

        cache_key = (profile, checkpoint_sha, str(storage_path))
        now_mono = _time.monotonic()
        if (
            _ACTIVE_MODEL_MANIFEST_CACHE is not None
            and _ACTIVE_MODEL_MANIFEST_CACHE[1] == cache_key
            and now_mono < _ACTIVE_MODEL_MANIFEST_CACHE[0]
        ):
            return _copy.deepcopy(_ACTIVE_MODEL_MANIFEST_CACHE[2])

        try:
            manifest_bytes = await asyncio.to_thread(self._download_model_ref, str(storage_path))
            manifest = json.loads(manifest_bytes.decode("utf-8"))
        except Exception as exc:
            logger.warning("Failed reading active VietOCR manifest: %s", type(exc).__name__)
            return base

        from app.services.training_storage.references import is_gdrive_ref

        local_dir = (os.getenv("VIREAD_LOCAL_STORAGE_DIR") or "").strip()
        can_sign_storage = not local_dir and APP_ENVIRONMENT != "test"

        def _maybe_sign_ref(ref_val: object) -> str | None:
            if not can_sign_storage or not isinstance(ref_val, str) or not ref_val.strip():
                return None
            if is_gdrive_ref(ref_val):
                return None
            try:
                return storage_service.create_signed_image_url(ref_val.strip(), ttl_seconds=900)
            except Exception:
                return None

        chunks = manifest.get("chunks") if isinstance(manifest.get("chunks"), list) else []
        config_info = manifest.get("config") if isinstance(manifest.get("config"), dict) else {}
        config_ref = config_info.get("storage_path")
        base["has_custom_config"] = bool(config_ref)
        base["config_sha256"] = config_info.get("sha256")
        base["config_signed_url"] = (
            await asyncio.to_thread(_maybe_sign_ref, config_ref) if config_ref else None
        )
        base["shard_count"] = len(chunks)

        shard_entries: list[dict[str, Any]] = []
        for idx, chunk in enumerate(chunks):
            if not isinstance(chunk, dict):
                continue
            shard_ref = chunk.get("path") or chunk.get("storage_path")
            signed_shard_url = (
                await asyncio.to_thread(_maybe_sign_ref, shard_ref) if shard_ref else None
            )
            shard_entries.append(
                {
                    "index": idx,
                    "sha256": chunk.get("sha256"),
                    "bytes": chunk.get("bytes"),
                    "signed_url": signed_shard_url,
                }
            )
        base["shards"] = shard_entries
        _ACTIVE_MODEL_MANIFEST_CACHE = (
            _time.monotonic() + _ACTIVE_MODEL_MANIFEST_CACHE_TTL_SECONDS,
            cache_key,
            _copy.deepcopy(base),
        )
        return base

    def _download_model_ref(self, ref: str) -> bytes:
        from app.services.training_storage.references import is_gdrive_ref

        if is_gdrive_ref(ref):
            from app.services.training_storage.router import get_runtime_artifact_router

            return get_runtime_artifact_router().get(ref)
        return storage_service.download_object(ref)

    async def get_active_model_artifact_bytes(
        self, *, kind: str, shard_index: int | None = None
    ) -> tuple[bytes, str]:
        was_in_tx = _session_in_transaction(self.db)
        pointer = await self.repo.get_active_model_pointer()
        await _release_clean_self_opened_transaction(self.db, was_in_tx=was_in_tx)
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
            ref = chunk.get("path") or chunk.get("storage_path")
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
        if str(job.Status or "").upper() == "QUEUED":
            from app.services.remote_ocr_wakeup import (
                maybe_nudge_ocr_wakeup_for_stale_queued_job,
            )

            maybe_nudge_ocr_wakeup_for_stale_queued_job(
                job_id=job.Id,
                created_at=job.CreatedAt,
                reason="admin_poll_nudge",
            )
        return self.serialize_job(job)

    async def list_book_jobs_payload(self, book_id: UUID, *, limit: int = 200) -> list[dict[str, Any]]:
        rows = await self.repo.list_for_book(book_id, limit=limit)
        queued_row = next(
            (row for row in rows if str(row.Status or "").upper() == "QUEUED"),
            None,
        )
        if queued_row is not None:
            from app.services.remote_ocr_wakeup import (
                maybe_nudge_ocr_wakeup_for_stale_queued_job,
            )

            maybe_nudge_ocr_wakeup_for_stale_queued_job(
                job_id=queued_row.Id,
                created_at=queued_row.CreatedAt,
                reason="admin_book_poll_nudge",
            )
        return [self.serialize_job(row) for row in rows]

    async def retry_job(self, job_id: UUID) -> dict[str, Any]:
        job = await self.repo.get(job_id, lock=True)
        if job is None:
            raise HTTPException(status_code=404, detail="OCR inference job not found.")
        if job.Status in ACTIVE_JOB_STATUSES:
            serialized_active = self.serialize_job(job)
            await self.db.rollback()
            return serialized_active
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
        from app.services.remote_ocr_wakeup import trigger_ocr_wakeup_background

        trigger_ocr_wakeup_background(
            job_ids=[job.Id],
            reason="retry_job",
            session_factory_check_enabled=APP_ENVIRONMENT != "test",
        )
        return self.serialize_job(job)

    async def _cleanup_local_scan_temp_object(self, job: OcrInferenceJob) -> None:
        image_path = str(getattr(job, "ImagePath", "") or "")
        if not image_path.startswith("local-scans/"):
            return
        meta = dict(getattr(job, "ProcessingMeta", None) or {})
        if meta.get("temp_image_cleaned"):
            return
        bucket = getattr(job, "ImageBucket", None) or SUPABASE_PRIVATE_BOOKS_BUCKET
        try:
            await asyncio.to_thread(
                storage_service.delete_object,
                image_path,
                bucket_name=bucket,
            )
            meta["temp_image_cleaned"] = True
            job.ProcessingMeta = meta
        except Exception:
            pass

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
            if job.JobKind == JOB_KIND_LOCAL_SCAN:
                await self._cleanup_local_scan_temp_object(job)
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
