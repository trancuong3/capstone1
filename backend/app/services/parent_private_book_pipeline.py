"""Stage-preserving OCR -> Proofreading -> Tool Check pipeline for Parent Private Books.

Guarantees:
- Reuses real OCR (extract_text_and_boxes), real image-grounded proofreading
  (OcrCorrectionOrchestrator), real deterministic quality checks (book_quality_analyzer),
  and real Child Safety assessment (ChildSafetyOrchestrator).
- Defaults to local Ollama (no private full text sent to external cloud APIs unless
  PRIVATE_BOOK_ALLOW_CLOUD_AI=true is explicitly set).
- Preserves already-succeeded stage results so stage retries never discard good work.
- Fails closed on timeout, quota, missing model, bad JSON, empty/corrupt output,
  missing chunks, or worker crash.
- Never marks image-only / blank pages safe; routes them to Admin visual review.
- Explicitly checks submission_version + source_sha256 + candidate_hash before writing
  stage outputs so late/stale worker responses are discarded cleanly.
"""
from __future__ import annotations

import asyncio
import hashlib
import logging
import math
import unicodedata
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any, Callable
from uuid import UUID, uuid4

from sqlalchemy.ext.asyncio import AsyncSession

from app.database.config import SUPABASE_PRIVATE_BOOKS_BUCKET
from app.diagnostic_logging import log_diagnostic
from app.models import ParentBookPageSubmission
from app.repositories.parent_private_book_repository import ParentPrivateBookRepository
from app.services.book_quality_analyzer import (
    analyse_verified_text,
    content_fingerprint,
    duplicate_page_finding,
)
from app.services.ocr_ai.child_safety import (
    ChildSafetyError,
    build_private_book_child_safety_orchestrator,
    content_hash as safety_content_hash,
)
from app.services.ocr_ai.config import OcrCorrectionConfig
from app.services.ocr_ai.exceptions import OcrConfigurationError, OcrOrchestrationError
from app.services.ocr_ai.orchestrator import OcrCorrectionOrchestrator
from app.services.ocr_engine import (
    OcrEngineUnavailable,
    OcrNoTextDetected,
    extract_text_and_boxes,
    normalize_word,
)
from app.services.ocr_content_extraction import (
    build_extraction_provenance_meta,
    extract_ocr_content,
    filter_word_dicts_by_extraction,
    is_stage3_semantic_provider_configured,
    ocr_words_from_dicts,
    persist_committed_parent_page_v2,
    run_stage3_semantic_filter_if_needed,
    safe_detect_document_boundary,
)
from app.services.parent_private_book_post_ocr import (
    build_empty_text_findings,
    build_image_only_findings,
    build_proofread_suggestions as _shared_build_proofread_suggestions,
    build_rights_declaration_finding,
    build_rule_and_duplicate_findings,
    build_tool_check_scope,
    compact_provider_events as _compact_provider_events,
    compute_candidate_hash,
    format_safety_findings,
    normalize_private_book_text as _normalize_text,
    should_auto_accept_spelling,
)
from app.services.smart_studio_flags import SmartStudioFlags
from app.services.storage_service import download_object

finalize_committed_private_book_page_v2 = persist_committed_parent_page_v2

logger = logging.getLogger(__name__)


def _valid_box(raw: object) -> list[float] | None:
    raw_vals: list[object] | None = None
    if isinstance(raw, (list, tuple)) and len(raw) == 4:
        raw_vals = list(raw)
    elif isinstance(raw, dict):
        if "x" not in raw or "y" not in raw:
            return None
        raw_vals = [
            raw["x"],
            raw["y"],
            raw.get("w", raw.get("width", 0.0)),
            raw.get("h", raw.get("height", 0.0)),
        ]
    if raw_vals is None or any(isinstance(v, bool) for v in raw_vals):
        return None
    try:
        vals = [float(v) for v in raw_vals]
    except (TypeError, ValueError):
        return None
    if not all(math.isfinite(v) for v in vals):
        return None
    x, y, w, h = vals
    if (
        0.0 <= x < 1.0
        and 0.0 <= y < 1.0
        and w > 0.0
        and h > 0.0
        and x + w <= 1.001
        and y + h <= 1.001
    ):
        rx = round(x, 6)
        ry = round(y, 6)
        rw = round(min(w, 1.0 - rx), 6)
        rh = round(min(h, 1.0 - ry), 6)
        if rx < 1.0 and ry < 1.0 and rw > 0.0 and rh > 0.0:
            return [rx, ry, rw, rh]
    return None


def _item_box(raw_item: dict[str, Any]) -> list[float] | None:
    for key in ("bounding_box", "bbox", "BoundingBox"):
        box = _valid_box(raw_item.get(key))
        if box is not None:
            return box
    return None


def align_edited_text_to_words(
    new_text: str,
    base_words: list[dict[str, Any]],
) -> list[dict[str, Any]]:
    """Map edited Vietnamese text to valid normalized word boxes preserving original geometry."""
    normalized = _normalize_text(new_text)
    if not normalized:
        return []
    lines = [line.strip() for line in normalized.split("\n") if line.strip()]
    tokens_with_lines: list[tuple[int, str]] = []
    for line_idx, line in enumerate(lines):
        for tok in line.split():
            tok_clean = tok.strip()
            if tok_clean and normalize_word(tok_clean):
                tokens_with_lines.append((line_idx, tok_clean))
    if not tokens_with_lines:
        return []

    valid_base: list[tuple[dict[str, Any], list[float]]] = []
    for w in base_words:
        if not isinstance(w, dict):
            continue
        raw_tok = str(w.get("text") or w.get("Text") or "").strip()
        if raw_tok and not normalize_word(raw_tok):
            continue
        box = _item_box(w)
        if box is not None:
            valid_base.append((w, box))
    if len(valid_base) == len(tokens_with_lines):
        aligned: list[dict[str, Any]] = []
        for idx, ((line_idx, tok), (orig, box)) in enumerate(zip(tokens_with_lines, valid_base)):
            orig_line = int(orig.get("line_index", line_idx))
            entry: dict[str, Any] = {
                "word_index": idx,
                "line_index": orig_line,
                "text": tok,
                "normalized_text": normalize_word(tok) or tok.lower(),
                "bounding_box": box,
                "ocr_confidence": orig.get("ocr_confidence"),
            }
            if orig_line != line_idx:
                entry["bbox_source"] = "aligned_reordered"
            elif orig.get("bbox_source"):
                entry["bbox_source"] = orig.get("bbox_source")
            aligned.append(entry)
        return aligned

    # Group base boxes by line or fallback evenly across the OCR text envelope so
    # edited additions/deletions always retain valid normalized page coordinates.
    if valid_base:
        xs = [box[0] for _, box in valid_base]
        ys = [box[1] for _, box in valid_base]
        x2s = [box[0] + box[2] for _, box in valid_base]
        y2s = [box[1] + box[3] for _, box in valid_base]
        left, top = max(0.02, min(xs)), max(0.02, min(ys))
        right, bottom = min(0.98, max(x2s)), min(0.98, max(y2s))
    else:
        left, top, right, bottom = 0.08, 0.08, 0.92, 0.92

    line_count = max(1, len(lines))
    total_h = max(0.08, bottom - top)
    line_h = min(0.08, total_h / line_count)
    out: list[dict[str, Any]] = []
    word_idx = 0
    for line_idx, line in enumerate(lines):
        line_tokens = [
            t.strip() for t in line.split() if t.strip() and normalize_word(t.strip())
        ]
        if not line_tokens:
            continue
        y = min(0.92, top + line_idx * (total_h / line_count))
        slot_w = max(0.02, (right - left) / len(line_tokens))
        for tok_i, tok in enumerate(line_tokens):
            x = min(0.95, left + tok_i * slot_w)
            w = max(0.015, min(slot_w * 0.9, 1.0 - x))
            h = max(0.015, min(line_h * 0.85, 1.0 - y))
            out.append({
                "word_index": word_idx,
                "line_index": line_idx,
                "text": tok,
                "normalized_text": normalize_word(tok) or tok.lower(),
                "bounding_box": [round(x, 6), round(y, 6), round(w, 6), round(h, 6)],
                "ocr_confidence": None,
                "bbox_source": "synthetic_grid",
            })
            word_idx += 1
    return out


def build_proofread_suggestions(
    ocr_words: list[dict[str, Any]],
    proofread_text: str,
    uncertain_indices: set[int],
) -> list[dict[str, Any]]:
    """Compute word-level spelling/diacritic diff aligned with normalize_word tokens."""
    uncertain_set = {int(i) for i in (uncertain_indices or ())}
    normalized_ocr: list[tuple[int, str]] = []
    for idx, word in enumerate(ocr_words):
        if not isinstance(word, dict):
            continue
        original = str(word.get("text") or "").strip()
        if original and normalize_word(original):
            normalized_ocr.append((idx, original))
    proof_tokens = [
        tok for tok in _normalize_text(proofread_text).split() if normalize_word(tok)
    ]
    suggestions: list[dict[str, Any]] = []
    for pos, (word_idx, original) in enumerate(normalized_ocr):
        suggested = proof_tokens[pos] if pos < len(proof_tokens) else original
        is_uncertain = pos in uncertain_set or word_idx in uncertain_set
        if original != suggested or is_uncertain:
            suggestions.append({
                "word_index": word_idx,
                "original": original,
                "suggested": suggested,
                "uncertain": is_uncertain,
            })
    return suggestions


def _extract_ocr_words_and_text(raw_result: Any) -> tuple[str, list[dict[str, Any]], dict[str, Any]]:
    """Convert extract_text_and_boxes output into normalized text, word list, and metadata."""
    if isinstance(raw_result, tuple):
        if len(raw_result) == 3:
            text_value, raw_words, raw_meta = raw_result
        elif len(raw_result) == 2:
            text_value, raw_words = raw_result
            raw_meta = {}
        else:
            raise ValueError("Unexpected OCR return shape")
    elif isinstance(raw_result, dict):
        text_value = str(raw_result.get("text") or "")
        raw_words = list(raw_result.get("words") or [])
        meta_candidate = raw_result.get("metadata")
        if not isinstance(meta_candidate, dict):
            meta_candidate = raw_result.get("meta")
        raw_meta = dict(meta_candidate) if isinstance(meta_candidate, dict) else {}
    else:
        raise ValueError("Unexpected OCR return shape")

    words: list[dict[str, Any]] = []
    for idx, item in enumerate(raw_words or []):
        if isinstance(item, dict):
            tok = str(item.get("text") or item.get("Text") or "").strip()
            box = _valid_box(item.get("bounding_box") or item.get("BoundingBox") or item.get("bbox"))
            line_idx = int(item.get("line_index", item.get("LineIndex", 0)) or 0)
            conf = item.get("ocr_confidence", item.get("OCRConfidence", item.get("confidence")))
        else:
            tok = str(getattr(item, "text", getattr(item, "Text", "")) or "").strip()
            box = _valid_box(
                getattr(item, "bounding_box", getattr(item, "BoundingBox", getattr(item, "bbox", None)))
            )
            line_idx = int(getattr(item, "line_index", getattr(item, "LineIndex", 0)) or 0)
            conf = getattr(item, "ocr_confidence", getattr(item, "OCRConfidence", getattr(item, "confidence", None)))
        normalized_tok = normalize_word(tok) if tok else ""
        if not tok or not normalized_tok or box is None:
            continue
        conf_val = (
            float(conf)
            if isinstance(conf, (int, float)) and not isinstance(conf, bool) and math.isfinite(float(conf))
            else None
        )
        words.append({
            "word_index": len(words),
            "line_index": max(0, line_idx),
            "text": unicodedata.normalize("NFC", tok),
            "normalized_text": normalized_tok,
            "bounding_box": box,
            "ocr_confidence": conf_val,
        })

    normalized_text = _normalize_text(str(text_value or ""))
    if not normalized_text and words:
        lines_by_idx: dict[int, list[str]] = {}
        for w in words:
            lines_by_idx.setdefault(w["line_index"], []).append(w["text"])
        normalized_text = "\n".join(
            " ".join(lines_by_idx[k]) for k in sorted(lines_by_idx)
        )
    return normalized_text, words, dict(raw_meta or {})


@dataclass
class PipelineHooks:
    """Optional injectable hooks for deterministic provider/failure testing."""

    ocr_fn: Callable[[bytes], Any] | None = None
    proofread_orchestrator_factory: Callable[[], OcrCorrectionOrchestrator] | None = None
    safety_orchestrator_factory: Callable[[], Any] | None = None
    download_fn: Callable[[str], bytes] | None = None


def _default_download(storage_path: str) -> bytes:
    return download_object(storage_path, bucket_name=SUPABASE_PRIVATE_BOOKS_BUCKET)


def _default_proofread_orchestrator() -> OcrCorrectionOrchestrator:
    config = OcrCorrectionConfig.from_environment_for_private_book()
    return OcrCorrectionOrchestrator(config)


def _default_safety_orchestrator():
    return build_private_book_child_safety_orchestrator()


async def process_submission_stages(
    db: AsyncSession,
    submission_id: UUID,
    *,
    hooks: PipelineHooks | None = None,
    worker_id: str | None = None,
) -> ParentBookPageSubmission | None:
    """Execute pending stages (OCR -> Proofreading -> Tool Check) for one submission.

    Releases the DB transaction during slow OCR/AI execution and re-verifies
    submission_version + source_sha256 + candidate_hash before committing any stage
    result so late/stale worker results are never applied to a newer revision.
    """
    hooks = hooks or PipelineHooks()
    repo = ParentPrivateBookRepository(db)

    row = await repo.get_submission(submission_id)
    if row is None or row.WorkflowStatus != "CHECKING":
        return row

    # Capture immutable snapshot metadata before releasing DB transaction
    book_id = row.BookId
    captured_version = int(row.SubmissionVersion)
    captured_sha = str(row.SourceSha256)
    storage_path = str(row.SourceStoragePath)
    source_type = str(row.SourceType)
    source_note = row.SourceNote
    ocr_status = str(row.OcrStatus)
    proofread_status = str(row.ProofreadStatus)
    tool_check_status = str(row.ToolCheckStatus)
    is_image_only = bool(row.IsImageOnly)
    ocr_text = row.OcrText
    ocr_words = list(row.OcrWordsJson or [])
    candidate_text = row.CandidateText
    candidate_hash = row.CandidateHash
    candidate_page_num = int(row.TargetPageNumber or row.SourcePageNumber or 1)
    committed_texts = await repo.list_committed_page_texts(book_id)
    local_ai_enforced = not OcrCorrectionConfig.private_book_allow_cloud_ai()

    await db.rollback()

    download_fn = hooks.download_fn or _default_download

    # ------------------------------------------------------------------
    # STAGE 1: OCR
    # ------------------------------------------------------------------
    image_bytes: bytes | None = None
    if ocr_status in ("PENDING", "RUNNING", "FAILED"):
        try:
            image_bytes = await asyncio.to_thread(download_fn, storage_path)
        except Exception as exc:
            log_diagnostic(
                logger,
                logging.WARNING,
                event="parent_book_ocr_download_failed",
                stage="ocr_download",
                submission_id=str(submission_id),
                exception=exc,
            )
            return await _persist_stage_failure(
                db,
                submission_id,
                expected_version=captured_version,
                expected_sha=captured_sha,
                expected_worker_id=worker_id,
                stage="OCR",
                error_code="SOURCE_IMAGE_UNAVAILABLE",
            )

        ocr_fn = hooks.ocr_fn or extract_text_and_boxes
        try:
            raw_ocr = await asyncio.to_thread(ocr_fn, image_bytes)
            extracted_text, extracted_words, extracted_meta = _extract_ocr_words_and_text(raw_ocr)
        except OcrNoTextDetected:
            extracted_text, extracted_words, extracted_meta = "", [], {"no_text_detected": True}
        except OcrEngineUnavailable as exc:
            log_diagnostic(
                logger,
                logging.WARNING,
                event="parent_book_ocr_unavailable",
                stage="ocr",
                submission_id=str(submission_id),
                exception=exc,
            )
            return await _persist_stage_failure(
                db,
                submission_id,
                expected_version=captured_version,
                expected_sha=captured_sha,
                expected_worker_id=worker_id,
                stage="OCR",
                error_code="OCR_ENGINE_UNAVAILABLE",
            )
        except Exception as exc:
            log_diagnostic(
                logger,
                logging.ERROR,
                event="parent_book_ocr_failed",
                stage="ocr",
                submission_id=str(submission_id),
                exception=exc,
            )
            return await _persist_stage_failure(
                db,
                submission_id,
                expected_version=captured_version,
                expected_sha=captured_sha,
                expected_worker_id=worker_id,
                stage="OCR",
                error_code="OCR_PROCESSING_FAILED",
            )

        # Stage 1B: Smart Book Studio V2 boundary + 20-class extraction (strict local-only privacy default)
        allow_cloud_ai = not local_ai_enforced
        studio_flags = SmartStudioFlags.from_environment()
        raw_word_boxes = [
            w["bounding_box"]
            for w in extracted_words
            if isinstance(w, dict) and _valid_box(w.get("bounding_box")) is not None
        ]
        boundary_result = await asyncio.to_thread(
            safe_detect_document_boundary, image_bytes, raw_word_boxes or None
        )
        source_word_inputs = ocr_words_from_dicts(extracted_words)
        smart_extraction = extract_ocr_content(
            source_word_inputs,
            page_number=max(1, candidate_page_num),
            boundary=boundary_result,
            flags=studio_flags,
            book_id=book_id,
        )
        if (
            studio_flags.semantic_layout_enabled
            and smart_extraction.filter_mode != "off"
            and any(b.decision == "REVIEW" for b in smart_extraction.blocks)
            and is_stage3_semantic_provider_configured(
                allow_cloud=allow_cloud_ai, is_private_book=True
            )
        ):
            smart_extraction = await run_stage3_semantic_filter_if_needed(
                smart_extraction,
                source_words=source_word_inputs,
                allow_cloud=allow_cloud_ai,
                is_private_book=True,
                tenant_scope=f"parent:{book_id}",
                flags=studio_flags,
            )
        extracted_meta["smart_ocr_extraction"] = build_extraction_provenance_meta(
            smart_extraction,
            source_word_inputs,
            allow_cloud_ai=allow_cloud_ai,
        )

        # Persist Stage 1 atomically with stale-version & lease check
        locked = await repo.get_submission(submission_id, lock=True)
        if locked is None or _is_stale(
            locked, captured_version, captured_sha, expected_worker_id=worker_id
        ):
            await db.rollback()
            return locked

        now = datetime.now(timezone.utc)
        if not extracted_text or not extracted_words:
            # Blank or image-only page: NEVER mark safe; escalate to Admin visual review.
            extracted_meta["smart_ocr_extraction"]["artwork_candidate"] = True
            locked.OcrStatus = "NO_TEXT_DETECTED"
            locked.OcrText = ""
            locked.OcrWordsJson = []
            locked.OcrMetaJson = extracted_meta
            locked.OcrHash = hashlib.sha256(b"").hexdigest()
            locked.OcrErrorCode = None
            locked.IsImageOnly = True
            locked.ProofreadStatus = "SKIPPED"
            locked.ProofreadText = ""
            locked.ProofreadHash = hashlib.sha256(b"").hexdigest()
            locked.ProofreadSuggestionsJson = []
            locked.UncertainWordIndicesJson = []
            locked.CandidateText = ""
            locked.CandidateWordsJson = []
            locked.CandidateHash = compute_candidate_hash("", source_sha256=captured_sha, is_image_only=True)
            locked.ToolCheckStatus = "NEEDS_MANUAL_REVIEW"
            locked.ToolCheckInputHash = locked.CandidateHash
            locked.ToolCheckSuitability = "REVIEW_REQUIRED"
            locked.ToolCheckPolicyBlocked = False
            locked.ToolCheckWorkflowId = uuid4()
            locked.ToolCheckScopeJson = {
                "modality": "TEXT_ONLY_WITH_OCR_IMAGE_PROOFREAD",
                "covers_all_chunks": True,
                "chunks_checked": 0,
                "total_chunks": 0,
                "image_visual_safety_checked": False,
                "requires_admin_visual_review": True,
                "copyright_scanner_status": "NOT_CONFIGURED",
                "local_ai_enforced": local_ai_enforced,
            }
            locked.ToolCheckFindingsJson = [
                {
                    "finding_id": hashlib.sha256(f"IMAGE_ONLY:{captured_sha}".encode("utf-8")).hexdigest()[:32],
                    "source": "RULE",
                    "category": "IMAGE_ONLY_OR_BLANK_PAGE",
                    "severity": "MEDIUM",
                    "content_type": "DESCRIPTION",
                    "excerpt": "(Trang không phát hiện chữ hoặc chỉ có hình ảnh)",
                    "explanation": "OCR không phát hiện chữ tiếng Việt trên trang này. Tool Check chỉ kiểm tra văn bản nên không thể tự xác nhận an toàn cho trang chỉ có hình ảnh hoặc trang trắng.",
                    "recommendation": "Gửi Admin xem trực tiếp ảnh trang sách trước khi thêm vào sách.",
                }
            ]
            locked.ToolCheckCompletedAt = now
            locked.WorkflowStatus = "NEEDS_ADMIN_REVIEW"
            locked.WorkerId = None
            locked.LeaseExpiresAt = None
            locked.UpdatedAt = now
            await db.commit()
            await db.refresh(locked)
            return locked

        # Layer 2 clean candidate (only excludes high-confidence noise in active mode;
        # shadow/off or 0 exclusions keep exact raw OCR text & words!)
        stage1_candidate_text = extracted_text
        stage1_candidate_words = extracted_words
        if (
            smart_extraction.filter_mode == "active"
            and smart_extraction.stats.exclude_blocks > 0
            and smart_extraction.canonical_text.strip()
        ):
            filtered_words = filter_word_dicts_by_extraction(extracted_words, smart_extraction)
            if filtered_words:
                stage1_candidate_text = _normalize_text(smart_extraction.canonical_text)
                stage1_candidate_words = filtered_words

        locked.OcrStatus = "COMPLETED"
        locked.OcrText = extracted_text
        locked.OcrWordsJson = extracted_words
        locked.OcrMetaJson = extracted_meta
        locked.OcrHash = safety_content_hash(extracted_text)
        locked.OcrErrorCode = None
        locked.IsImageOnly = False
        locked.CandidateText = stage1_candidate_text
        locked.CandidateWordsJson = stage1_candidate_words
        locked.CandidateHash = compute_candidate_hash(stage1_candidate_text, source_sha256=captured_sha)
        locked.UpdatedAt = now
        await db.commit()
        await db.refresh(locked)

        ocr_status = "COMPLETED"
        ocr_text = stage1_candidate_text
        ocr_words = stage1_candidate_words
        candidate_text = stage1_candidate_text
        candidate_hash = locked.CandidateHash
        is_image_only = False
        await db.rollback()

    # ------------------------------------------------------------------
    # STAGE 2: SPELLING / OCR PROOFREADING (against source image, Ollama local default)
    # ------------------------------------------------------------------
    if not is_image_only and ocr_status == "COMPLETED" and proofread_status in ("PENDING", "RUNNING", "FAILED"):
        if image_bytes is None:
            try:
                image_bytes = await asyncio.to_thread(download_fn, storage_path)
            except Exception as exc:
                log_diagnostic(
                    logger,
                    logging.WARNING,
                    event="parent_book_proofread_download_failed",
                    stage="proofreading",
                    submission_id=str(submission_id),
                    exception=exc,
                )
                return await _persist_stage_failure(
                    db,
                    submission_id,
                    expected_version=captured_version,
                    expected_sha=captured_sha,
                    expected_worker_id=worker_id,
                    stage="PROOFREADING",
                    error_code="SOURCE_IMAGE_UNAVAILABLE",
                )

        word_boxes = [
            tuple(w["bounding_box"])  # type: ignore[misc]
            for w in ocr_words
            if _valid_box(w.get("bounding_box")) is not None
        ]
        provider_events: list[dict[str, Any]] = []
        uncertain_global: set[int] = set()

        def on_event(evt: dict[str, Any]) -> None:
            provider_events.append({
                "provider": str(evt.get("provider") or "unknown"),
                "model": evt.get("model"),
                "stage": "PROOFREADING",
                "chunk_id": evt.get("chunk_id"),
                "availability": evt.get("availability"),
                "error_code": evt.get("error_code"),
                "duration_ms": evt.get("duration_ms"),
            })

        def on_uncertain(_chunk_id: int, indices: tuple[int, ...]) -> None:
            uncertain_global.update(int(i) for i in indices)

        try:
            orchestrator = (
                hooks.proofread_orchestrator_factory()
                if hooks.proofread_orchestrator_factory is not None
                else _default_proofread_orchestrator()
            )
            corrected_text = await orchestrator.correct(
                ocr_text or "",
                image_bytes,
                word_boxes,
                on_provider_event=on_event,
                on_uncertain_tokens=on_uncertain,
                word_normalizer=normalize_word,
            )
            corrected_text = _normalize_text(corrected_text)
            if not corrected_text:
                raise OcrOrchestrationError("EMPTY_PROOFREAD_OUTPUT")
        except (OcrOrchestrationError, OcrConfigurationError) as exc:
            code = getattr(exc, "code", None) or str(exc) or "PROOFREAD_FAILED"
            return await _persist_stage_failure(
                db,
                submission_id,
                expected_version=captured_version,
                expected_sha=captured_sha,
                expected_worker_id=worker_id,
                stage="PROOFREADING",
                error_code=str(code)[:80],
                provider_events=provider_events,
            )
        except Exception as exc:
            log_diagnostic(
                logger,
                logging.ERROR,
                event="parent_book_proofread_failed",
                stage="proofreading",
                submission_id=str(submission_id),
                exception=exc,
            )
            return await _persist_stage_failure(
                db,
                submission_id,
                expected_version=captured_version,
                expected_sha=captured_sha,
                expected_worker_id=worker_id,
                stage="PROOFREADING",
                error_code="PROOFREAD_UNEXPECTED_ERROR",
                provider_events=provider_events,
            )

        suggestions = build_proofread_suggestions(ocr_words, corrected_text, uncertain_global)
        aligned_words = align_edited_text_to_words(corrected_text, ocr_words)
        new_candidate_hash = compute_candidate_hash(corrected_text, source_sha256=captured_sha)

        locked = await repo.get_submission(submission_id, lock=True)
        if locked is None or _is_stale(
            locked, captured_version, captured_sha, expected_worker_id=worker_id
        ):
            await db.rollback()
            return locked

        now = datetime.now(timezone.utc)
        locked.ProofreadStatus = "COMPLETED"
        locked.ProofreadText = corrected_text
        locked.ProofreadHash = safety_content_hash(corrected_text)
        locked.ProofreadSuggestionsJson = suggestions
        locked.UncertainWordIndicesJson = sorted(uncertain_global)
        locked.ProofreadProviderEventsJson = provider_events
        locked.ProofreadErrorCode = None
        locked.CandidateText = corrected_text
        locked.CandidateWordsJson = aligned_words
        locked.CandidateHash = new_candidate_hash
        # Auto-accept spelling only if there are zero suggested diffs and zero uncertain words;
        # otherwise parent reviews suggestions & accepts before adding.
        if not suggestions and not uncertain_global:
            locked.SpellingAcceptedAt = now
        else:
            locked.SpellingAcceptedAt = None
        locked.UpdatedAt = now
        await db.commit()
        await db.refresh(locked)

        proofread_status = "COMPLETED"
        candidate_text = corrected_text
        candidate_hash = new_candidate_hash
        await db.rollback()

    # ------------------------------------------------------------------
    # STAGE 3: TOOL CHECK (Deterministic Rules + Child Safety + Rights Basis)
    # Runs on EXACT candidate_text (post-proofreading or post-parent-edit).
    # ------------------------------------------------------------------
    if is_image_only or ocr_status == "NO_TEXT_DETECTED":
        effective_hash = candidate_hash or compute_candidate_hash(
            "", source_sha256=captured_sha, is_image_only=True
        )
        return await _persist_tool_check_result(
            db,
            submission_id,
            expected_version=captured_version,
            expected_sha=captured_sha,
            expected_candidate_hash=candidate_hash,
            effective_candidate_hash=effective_hash,
            expected_worker_id=worker_id,
            workflow_id=uuid4(),
            suitability="REVIEW_REQUIRED",
            findings=build_image_only_findings(captured_sha),
            provider_events=[],
            scope=build_tool_check_scope(
                chunks_checked=0,
                total_chunks=0,
                requires_admin_visual_review=True,
                local_ai_enforced=local_ai_enforced,
            ),
            policy_blocked=False,
        )

    if not is_image_only and ocr_status == "COMPLETED" and proofread_status in ("COMPLETED", "SKIPPED") and tool_check_status in ("PENDING", "RUNNING", "FAILED"):
        text_to_check = _normalize_text(candidate_text or "")
        expected_candidate_hash = candidate_hash or compute_candidate_hash(
            text_to_check, source_sha256=captured_sha
        )
        workflow_id = uuid4()

        if not text_to_check:
            return await _persist_tool_check_result(
                db,
                submission_id,
                expected_version=captured_version,
                expected_sha=captured_sha,
                expected_candidate_hash=expected_candidate_hash,
                expected_worker_id=worker_id,
                workflow_id=workflow_id,
                suitability="REVIEW_REQUIRED",
                findings=[{
                    "finding_id": hashlib.sha256(f"EMPTY:{captured_sha}".encode("utf-8")).hexdigest()[:32],
                    "source": "RULE",
                    "category": "EMPTY_VERIFIED_TEXT",
                    "severity": "MEDIUM",
                    "content_type": "DESCRIPTION",
                    "excerpt": "(Văn bản trống)",
                    "explanation": "Nội dung trang sau chỉnh sửa đang trống.",
                    "recommendation": "Bổ sung văn bản hợp lệ hoặc gửi Admin xem xét ảnh.",
                }],
                provider_events=[],
                scope={
                    "modality": "TEXT_ONLY_WITH_OCR_IMAGE_PROOFREAD",
                    "covers_all_chunks": True,
                    "chunks_checked": 0,
                    "total_chunks": 0,
                    "image_visual_safety_checked": False,
                    "requires_admin_visual_review": True,
                    "copyright_scanner_status": "NOT_CONFIGURED",
                    "local_ai_enforced": local_ai_enforced,
                },
                policy_blocked=False,
            )

        # Sub-check 3a: Deterministic rules + duplicate page detection inside same book
        combined_findings: list[dict[str, Any]] = []
        for rule_finding in analyse_verified_text(text_to_check):
            combined_findings.append({
                "finding_id": hashlib.sha256(
                    f"RULE:{rule_finding.issue_type}:{rule_finding.excerpt_start}:{rule_finding.excerpt_end}".encode("utf-8")
                ).hexdigest()[:32],
                "source": "RULE",
                "category": rule_finding.issue_type,
                "severity": rule_finding.severity,
                "content_type": "DESCRIPTION",
                "excerpt": rule_finding.original_excerpt,
                "explanation": rule_finding.explanation,
                "recommendation": "Kiểm tra lại văn bản hoặc gửi Admin xem xét.",
            })

        cand_fp = content_fingerprint(text_to_check)
        if cand_fp:
            for existing_page_num, existing_text in committed_texts:
                if content_fingerprint(existing_text) == cand_fp:
                    dup = duplicate_page_finding(
                        text_to_check, candidate_page_num, existing_page_num
                    )
                    combined_findings.append({
                        "finding_id": hashlib.sha256(
                            f"DUP:{existing_page_num}:{cand_fp}".encode("utf-8")
                        ).hexdigest()[:32],
                        "source": "RULE",
                        "category": dup.issue_type,
                        "severity": dup.severity,
                        "content_type": "DESCRIPTION",
                        "excerpt": dup.original_excerpt,
                        "explanation": dup.explanation,
                        "recommendation": "Kiểm tra xem trang này có bị tải trùng với trang đã có trong sách không.",
                    })
                    break

        # Sub-check 3b: Child Safety (ALL chunks, fail-closed, local Ollama default)
        safety_events: list[dict[str, Any]] = []
        try:
            safety_orchestrator = (
                hooks.safety_orchestrator_factory()
                if hooks.safety_orchestrator_factory is not None
                else _default_safety_orchestrator()
            )
            safety_result = await safety_orchestrator.analyze(text_to_check)
        except ChildSafetyError as exc:
            safety_events = _compact_provider_events(list(getattr(exc, "provider_events", None) or []))
            return await _persist_stage_failure(
                db,
                submission_id,
                expected_version=captured_version,
                expected_sha=captured_sha,
                expected_candidate_hash=expected_candidate_hash,
                expected_worker_id=worker_id,
                stage="TOOL_CHECK",
                error_code=str(getattr(exc, "code", None) or "CHILD_SAFETY_FAILED")[:80],
                provider_events=safety_events,
                workflow_id=workflow_id,
            )
        except OcrConfigurationError as exc:
            return await _persist_stage_failure(
                db,
                submission_id,
                expected_version=captured_version,
                expected_sha=captured_sha,
                expected_candidate_hash=expected_candidate_hash,
                expected_worker_id=worker_id,
                stage="TOOL_CHECK",
                error_code=str(getattr(exc, "code", None) or "TOOL_CHECK_CONFIG_INVALID")[:80],
                workflow_id=workflow_id,
            )
        except Exception as exc:
            log_diagnostic(
                logger,
                logging.ERROR,
                event="parent_book_tool_check_failed",
                stage="tool_check",
                submission_id=str(submission_id),
                exception=exc,
            )
            return await _persist_stage_failure(
                db,
                submission_id,
                expected_version=captured_version,
                expected_sha=captured_sha,
                expected_candidate_hash=expected_candidate_hash,
                expected_worker_id=worker_id,
                stage="TOOL_CHECK",
                error_code="TOOL_CHECK_UNEXPECTED_ERROR",
                workflow_id=workflow_id,
            )

        suitability = str(safety_result.get("suitability") or "REVIEW_REQUIRED")
        raw_safety_findings = list(safety_result.get("findings") or [])
        safety_events = _compact_provider_events(list(safety_result.get("provider_events") or []))
        successful_chunks = sorted({
            int(evt.get("chunk_id", 0))
            for evt in safety_events
            if evt.get("availability") is True
        })
        all_event_chunks = {
            int(evt.get("chunk_id", 0))
            for evt in safety_events
            if evt.get("chunk_id") is not None
        }
        raw_chunks_total = safety_result.get("chunks_total")
        if isinstance(raw_chunks_total, int) and not isinstance(raw_chunks_total, bool):
            total_chunks = raw_chunks_total
        else:
            total_chunks = max(len(all_event_chunks), len(successful_chunks), 1)
        raw_chunks_completed = safety_result.get("chunks_completed")
        raw_all_completed = safety_result.get("all_chunks_completed")
        all_chunks_flag_ok = (
            raw_all_completed is True if raw_all_completed is not None else True
        )
        completed_count_ok = (
            raw_chunks_completed >= total_chunks
            if isinstance(raw_chunks_completed, int) and not isinstance(raw_chunks_completed, bool)
            else True
        )
        covers_all_chunks = bool(
            all_chunks_flag_ok
            and completed_count_ok
            and total_chunks > 0
            and len(successful_chunks) >= total_chunks
        )
        if not covers_all_chunks:
            return await _persist_stage_failure(
                db,
                submission_id,
                expected_version=captured_version,
                expected_sha=captured_sha,
                expected_candidate_hash=expected_candidate_hash,
                expected_worker_id=worker_id,
                stage="TOOL_CHECK",
                error_code="INCOMPLETE_CHUNK_COVERAGE",
                provider_events=safety_events,
                workflow_id=workflow_id,
            )

        has_high_safety = suitability == "NOT_RECOMMENDED"
        for sf in raw_safety_findings:
            sev = str(sf.get("severity") or "MEDIUM")
            if sev == "HIGH":
                has_high_safety = True
            combined_findings.append({
                "finding_id": sf.get("finding_id"),
                "source": "CHILD_SAFETY",
                "category": str(sf.get("category") or "OTHER_SENSITIVE"),
                "severity": sev,
                "content_type": sf.get("content_type"),
                "excerpt": str(sf.get("evidence_text") or ""),
                "explanation": str(sf.get("explanation") or ""),
                "recommendation": sf.get("recommendation"),
            })

        # Sub-check 3c: Rights / usage basis declaration check (no fake copyright PASS!)
        if source_type == "OTHER" and len((source_note or "").strip()) < 10:
            combined_findings.append({
                "finding_id": hashlib.sha256(f"RIGHTS:{captured_sha}".encode("utf-8")).hexdigest()[:32],
                "source": "RIGHTS_DECLARATION",
                "category": "RIGHTS_BASIS_UNSPECIFIED",
                "severity": "MEDIUM",
                "content_type": "DESCRIPTION",
                "excerpt": "(Chưa khai rõ nguồn/quyền sử dụng cho mục Nguồn khác)",
                "explanation": "Hệ thống chưa có scanner bản quyền tự động và mục Nguồn khác chưa có căn cứ rõ ràng nên cần Admin rà soát thủ công.",
                "recommendation": "Bổ sung rõ nguồn gốc hoặc gửi Admin xem xét.",
            })

        scope = {
            "modality": "TEXT_ONLY_WITH_OCR_IMAGE_PROOFREAD",
            "covers_all_chunks": covers_all_chunks,
            "chunks_checked": len(successful_chunks),
            "total_chunks": total_chunks,
            "image_visual_safety_checked": False,
            "requires_admin_visual_review": False,
            "copyright_scanner_status": "NOT_CONFIGURED",
            "local_ai_enforced": local_ai_enforced,
        }

        return await _persist_tool_check_result(
            db,
            submission_id,
            expected_version=captured_version,
            expected_sha=captured_sha,
            expected_candidate_hash=expected_candidate_hash,
            expected_worker_id=worker_id,
            workflow_id=workflow_id,
            suitability=suitability,
            findings=combined_findings,
            provider_events=safety_events,
            scope=scope,
            policy_blocked=has_high_safety,
        )

    return await repo.get_submission(submission_id)


def _compact_provider_events(events: list[dict[str, Any]]) -> list[dict[str, Any]]:
    compacted: list[dict[str, Any]] = []
    for evt in events:
        if not isinstance(evt, dict):
            continue
        compacted.append({
            "provider": str(evt.get("provider") or "unknown"),
            "model": evt.get("model"),
            "stage": str(evt.get("stage") or "TOOL_CHECK"),
            "chunk_id": evt.get("chunk_id"),
            "availability": evt.get("availability"),
            "error_code": evt.get("error_code"),
            "duration_ms": evt.get("duration_ms"),
        })
    return compacted


def _is_stale(
    locked: ParentBookPageSubmission,
    expected_version: int,
    expected_sha: str,
    expected_candidate_hash: str | None = None,
    *,
    expected_worker_id: str | None = None,
) -> bool:
    if locked.WorkflowStatus != "CHECKING":
        return True
    if int(locked.SubmissionVersion) != expected_version:
        return True
    if str(locked.SourceSha256) != expected_sha:
        return True
    if expected_candidate_hash is not None and locked.CandidateHash != expected_candidate_hash:
        return True
    if expected_worker_id is not None:
        now = datetime.now(timezone.utc)
        if locked.WorkerId != expected_worker_id:
            return True
        if locked.LeaseExpiresAt is None or locked.LeaseExpiresAt <= now:
            return True
    return False


async def _persist_stage_failure(
    db: AsyncSession,
    submission_id: UUID,
    *,
    expected_version: int,
    expected_sha: str,
    stage: str,
    error_code: str,
    expected_candidate_hash: str | None = None,
    expected_worker_id: str | None = None,
    provider_events: list[dict[str, Any]] | None = None,
    workflow_id: UUID | None = None,
) -> ParentBookPageSubmission | None:
    repo = ParentPrivateBookRepository(db)
    locked = await repo.get_submission(submission_id, lock=True)
    if locked is None or _is_stale(
        locked,
        expected_version,
        expected_sha,
        expected_candidate_hash,
        expected_worker_id=expected_worker_id,
    ):
        await db.rollback()
        return locked
    now = datetime.now(timezone.utc)
    if stage == "OCR":
        locked.OcrStatus = "FAILED"
        locked.OcrErrorCode = error_code
    elif stage == "PROOFREADING":
        locked.ProofreadStatus = "FAILED"
        locked.ProofreadErrorCode = error_code
        if provider_events:
            locked.ProofreadProviderEventsJson = provider_events
    elif stage == "TOOL_CHECK":
        locked.ToolCheckStatus = "FAILED"
        locked.ToolCheckErrorCode = error_code
        if provider_events:
            locked.ToolCheckProviderEventsJson = provider_events
        if workflow_id is not None:
            locked.ToolCheckWorkflowId = workflow_id
    locked.WorkflowStatus = "CHECK_FAILED"
    locked.WorkerId = None
    locked.LeaseExpiresAt = None
    locked.UpdatedAt = now
    await db.commit()
    await db.refresh(locked)
    return locked


async def _persist_tool_check_result(
    db: AsyncSession,
    submission_id: UUID,
    *,
    expected_version: int,
    expected_sha: str,
    expected_candidate_hash: str | None,
    effective_candidate_hash: str | None = None,
    expected_worker_id: str | None = None,
    workflow_id: UUID,
    suitability: str,
    findings: list[dict[str, Any]],
    provider_events: list[dict[str, Any]],
    scope: dict[str, Any],
    policy_blocked: bool,
) -> ParentBookPageSubmission | None:
    repo = ParentPrivateBookRepository(db)
    locked = await repo.get_submission(submission_id, lock=True)
    if locked is None or _is_stale(
        locked,
        expected_version,
        expected_sha,
        expected_candidate_hash,
        expected_worker_id=expected_worker_id,
    ):
        await db.rollback()
        return locked

    now = datetime.now(timezone.utc)
    final_candidate_hash = effective_candidate_hash or expected_candidate_hash or locked.CandidateHash
    if final_candidate_hash and not locked.CandidateHash:
        locked.CandidateHash = final_candidate_hash
    locked.ToolCheckInputHash = final_candidate_hash
    locked.ToolCheckSuitability = suitability
    locked.ToolCheckFindingsJson = findings
    locked.ToolCheckProviderEventsJson = provider_events
    locked.ToolCheckScopeJson = scope
    locked.ToolCheckPolicyBlocked = policy_blocked
    locked.ToolCheckErrorCode = None
    locked.ToolCheckWorkflowId = workflow_id
    locked.ToolCheckCompletedAt = now

    is_clean = (
        suitability == "SUITABLE"
        and len(findings) == 0
        and not policy_blocked
        and not bool(scope.get("requires_admin_visual_review"))
    )
    if is_clean:
        locked.ToolCheckStatus = "PASSED"
        locked.WorkflowStatus = "PASSED_READY_TO_ADD"
    else:
        locked.ToolCheckStatus = "FLAGGED" if (findings or suitability != "SUITABLE") else "NEEDS_MANUAL_REVIEW"
        locked.WorkflowStatus = "NEEDS_ADMIN_REVIEW"

    locked.WorkerId = None
    locked.LeaseExpiresAt = None
    locked.UpdatedAt = now
    await db.commit()
    await db.refresh(locked)
    return locked
