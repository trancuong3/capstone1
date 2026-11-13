from __future__ import annotations

import asyncio
import hashlib
import json
import logging
import math
import os
import time
import unicodedata
from dataclasses import dataclass
from datetime import datetime, timezone
from io import BytesIO
from pathlib import PurePath
from typing import Any, Callable
from uuid import UUID, uuid4

from fastapi import HTTPException, UploadFile, status
from PIL import Image, ImageOps, UnidentifiedImageError
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import text
from starlette.concurrency import run_in_threadpool

from app.diagnostic_logging import log_diagnostic
from app.models import Book, BookPage, PageRevision
from app.repositories.admin_ocr_repository import AdminOcrRepository
from app.schemas.admin_ocr import (
    AdminOcrDraftRequest,
    AdminOcrVerifyRequest,
    AdminOcrWordInput,
    normalize_ocr_bbox,
)
from app.schemas.book import AdminPageLifecycleRead, AdminRevisionDetailRead
from app.services.ocr_adjudication import adjudicate_word
from app.services.ocr_punctuation import punctuation_status
from app.services.ocr_evidence import (
    HYBRID_OCR_EVIDENCE_CONTRACT,
    find_split_merge_candidates,
)
from app.services.ocr_engine import (
    OcrEngineUnavailable,
    OcrNoTextDetected,
    align_ocr_tokens,
    extract_text_and_boxes,
    normalize_text_tokens,
    normalize_word,
)
from app.services.admin_ocr_chunking import ChunkingError, chunk_ocr_text
from app.services.ocr_ai.config import OcrCorrectionConfig
from app.services.ocr_ai.exceptions import OcrConfigurationError, OcrOrchestrationError
from app.services.ocr_ai.orchestrator import OcrCorrectionOrchestrator
from app.services.storage_service import create_signed_image_url, delete_object, download_object, upload_object

logger = logging.getLogger(__name__)

MAX_IMAGE_BYTES = 12 * 1024 * 1024
MAX_IMAGE_DIMENSION = 6000
OCR_SCORE_CONTRACT = "tesseract_raw_word_score_v1"
OCR_SCORE_CONTRACTS = {
    OCR_SCORE_CONTRACT,
    "dual_engine_consensus_v1",
    "paddle_line_score_v1",
    "ocr_calibrated_word_accuracy_v1",
}
WORD_PROBABILITY_SCORE_CONTRACTS = {"ocr_calibrated_word_accuracy_v1"}
RAW_WORD_SCORE_CONTRACTS = {OCR_SCORE_CONTRACT}
OCR_EVIDENCE_CONTRACTS = {
    "dual_engine_agreement_v2",
    "hybrid_ocr_evidence_v3",
    "hybrid_ocr_evidence_v4",
    "tesseract_raw_word_score_v1",
    "ocr_calibrated_word_accuracy_v1",
}
OCR_REVIEW_STATUSES = {
    "matched",
    "suspect",
    "needs_review",
    "engine_agreement",
    "engine_disagreement",
    "reference_match",
    "confirmed_mismatch",
    "verified",
}
ALLOWED_FORMATS = {
    "JPEG": ("image/jpeg", "jpg"),
    "PNG": ("image/png", "png"),
    "WEBP": ("image/webp", "webp"),
}


@dataclass(frozen=True)
class PreparedLocalOcrCorrection:
    """Validated, short-lived input for OCR correction; never persisted.

    The historical name remains import-compatible with the local-only
    implementation. Its configuration is still backend-only and never reaches
    the browser or database.
    """

    config: OcrCorrectionConfig
    draft_text: str
    image_path: str
    word_boxes: tuple[tuple[float, float, float, float], ...]
    total_chunks: int


def geometry_quality(evidence: object) -> str:
    """How well the stored box covers the word; independent of text color.

    ``good``: valid box with a usable padded crop. ``weak``: valid box whose
    crop is clipped by the page edge or too faint. ``invalid``: the box
    itself failed validation and needs repair. ``not_assessed``: no geometry
    check was recorded (legacy revisions, manual edits).
    """
    if not isinstance(evidence, dict):
        return "not_assessed"
    bbox_quality = evidence.get("bbox_quality")
    if bbox_quality == "rejected":
        return "invalid"
    if bbox_quality != "valid":
        return "not_assessed"
    return "good" if evidence.get("crop_quality") == "usable" else "weak"


def classify_word_evidence(
    review_status: str,
    evidence: dict[str, object] | None,
    word_text: str | None = None,
) -> str:
    """Classify one OCR word as green, yellow or red using auditable evidence."""
    if not isinstance(evidence, dict) or not isinstance(word_text, str):
        return "green" if review_status == "verified" else "yellow"

    normalized_word = normalize_word(unicodedata.normalize("NFC", word_text))
    if not normalized_word:
        return "green" if review_status == "verified" else "yellow"

    reference_text = evidence.get("reference_text")
    verification_source = evidence.get("verification_source")
    reference_alignment = evidence.get("reference_alignment")
    has_verified_reference_provenance = (
        isinstance(verification_source, str)
        and verification_source in {"admin", "verified_revision"}
    )
    trusted_reference = (
        isinstance(verification_source, str)
        and verification_source in {"admin", "verified_revision"}
        and isinstance(reference_text, str)
        and bool(reference_text.strip())
        and isinstance(reference_alignment, str)
        and reference_alignment in {"match", "substitute"}
    )
    if has_verified_reference_provenance and not trusted_reference:
        # A verified page reference exists, but this token has no safe one-to-one
        # reference mapping. Do not bypass that uncertainty with OCR consensus.
        return "yellow"
    if trusted_reference and isinstance(reference_text, str):
        normalized_reference = normalize_word(unicodedata.normalize("NFC", reference_text))
        if normalized_word == normalized_reference:
            return "green"
        source_text = evidence.get("source_text")
        normalized_source = (
            normalize_word(unicodedata.normalize("NFC", source_text))
            if isinstance(source_text, str) else None
        )
        if (
            reference_alignment == "substitute"
            and normalized_source == normalized_word
        ):
            # Trusted reference provenance plus a one-to-one substitution is
            # decisive even when a persisted review status is stale.
            return "red"
        return "yellow"

    # Explicit word-level Admin verification remains green unless a trusted
    # verified reference above directly contradicts the current OCR token.
    if review_status == "verified":
        return "green"

    source_text = evidence.get("source_text")
    if not isinstance(source_text, str):
        return "yellow"
    normalized_source = normalize_word(unicodedata.normalize("NFC", source_text))
    if normalized_source != normalized_word:
        return "yellow"

    outputs = evidence.get("engine_outputs")
    statuses = evidence.get("engine_statuses")
    if not isinstance(outputs, dict) or not isinstance(statuses, dict):
        return "yellow"
    paddle = outputs.get("paddleocr")
    vietocr = outputs.get("vietocr")
    normalized_paddle = (
        normalize_word(unicodedata.normalize("NFC", paddle))
        if isinstance(paddle, str) and statuses.get("paddleocr") == "success"
        else ""
    )
    normalized_vietocr = (
        normalize_word(unicodedata.normalize("NFC", vietocr))
        if isinstance(vietocr, str) and statuses.get("vietocr") == "success"
        else ""
    )
    alignment = evidence.get("alignment")
    line_engines_agree = (
        bool(normalized_paddle)
        and normalized_paddle == normalized_vietocr
        and alignment == "match"
    )
    if not line_engines_agree:
        # PaddleOCR and VietOCR did not both return this token. The word can
        # still be settled when independent engines (VietOCR, Tesseract, crop
        # readings) converge on the text that is stored and displayed. Split,
        # merge and unaligned tokens have no one-to-one mapping: never green.
        if alignment not in {"substitute", "unmatched", "insert"}:
            return "yellow"
        # The word must still be anchored to a token position of the engine
        # that produced the line (PaddleOCR or VietOCR).
        anchored = False
        for index_name in ("paddle_token_index", "vietocr_token_index"):
            token_index = evidence.get(index_name)
            if (
                not isinstance(token_index, bool)
                and isinstance(token_index, int)
                and token_index >= 0
            ):
                anchored = True
        if not anchored:
            return "yellow"
        adjudication = adjudicate_word(evidence)
        if (
            adjudication["status"] == "resolved"
            and adjudication["text"] == normalized_word
        ):
            return "green"
        return "yellow"
    if normalized_source != normalized_paddle:
        return "yellow"
    if statuses.get("tesseract") == "success":
        # Tesseract ran: confirmation comes from the two Vietnamese engines.
        # Box and crop quality describe geometry, not the text, and are
        # reported separately (see ``geometry_quality``).
        adjudication = adjudicate_word(evidence)
        if adjudication["status"] == "resolved" and adjudication["text"] == normalized_word:
            return "green"
        return "yellow"

    selected_engine = evidence.get("selected_engine")
    selected_candidate = (
        outputs.get(selected_engine)
        if isinstance(selected_engine, str) and selected_engine in {"paddleocr", "vietocr"}
        else None
    )
    if (
        not isinstance(selected_candidate, str)
        or normalize_word(unicodedata.normalize("NFC", selected_candidate)) != normalized_paddle
    ):
        return "yellow"

    for index_name in ("paddle_token_index", "vietocr_token_index"):
        token_index = evidence.get(index_name)
        if isinstance(token_index, bool) or not isinstance(token_index, int) or token_index < 0:
            return "yellow"
    if evidence.get("bbox_quality") != "valid" or evidence.get("crop_quality") != "usable":
        return "yellow"

    crop_evidence = evidence.get("crop_evidence")
    if isinstance(crop_evidence, dict):
        crop_status = crop_evidence.get("status")
        if (
            not isinstance(crop_status, str)
            or crop_status not in {"not_needed", "completed"}
            or isinstance(crop_evidence.get("paddle_error"), str)
            or isinstance(crop_evidence.get("vietocr_error"), str)
        ):
            return "yellow"
        if crop_status == "completed":
            candidates = (
                crop_evidence.get("paddleocr_candidate"),
                crop_evidence.get("vietocr_candidate"),
            )
            if not all(isinstance(candidate, str) and candidate.strip() for candidate in candidates):
                return "yellow"
            if any(
                normalize_word(unicodedata.normalize("NFC", candidate)) != normalized_paddle
                for candidate in candidates if isinstance(candidate, str)
            ):
                return "yellow"
    # Agreement between PaddleOCR and VietOCR still loses to a Vietnamese
    # engine that read the same letters with more marks, or to repeated
    # contradicting readings.
    adjudication = adjudicate_word(evidence)
    if adjudication["status"] != "resolved" or adjudication["text"] != normalized_word:
        return "yellow"
    return "green"


class AdminOcrService:
    def __init__(self, db: AsyncSession):
        self.db = db
        self.repo = AdminOcrRepository(db)

    async def _cleanup_uploaded_object(
        self,
        object_path: str,
        *,
        object_may_exist: bool,
        book_id: UUID | None = None,
        page_id: UUID | None = None,
        started_at: float | None = None,
    ) -> None:
        if not object_may_exist:
            return
        try:
            await run_in_threadpool(delete_object, object_path)
        except Exception as exc:
            log_diagnostic(
                logger,
                logging.WARNING,
                event="admin_ocr_cleanup_failed",
                stage="cleanup",
                exception=exc,
                book_id=str(book_id) if book_id else None,
                page_id=str(page_id) if page_id else None,
                elapsed_ms=int((time.perf_counter() - started_at) * 1000) if started_at else None,
            )

    async def _discard_processing_page(self, page_id: UUID) -> bool:
        """Delete only a pending upload placeholder; never delete an activated page."""
        try:
            await self.db.rollback()
            probe = await self.repo.page(page_id)
            if probe is None:
                await self.db.rollback()
                return True
            book_id = probe.BookId
            await self.db.rollback()

            book = await self.repo.book(book_id, lock=True)
            if book is None:
                await self.db.rollback()
                return False
            page = await self.repo.page(page_id, lock=True)
            if page is None:
                await self.db.rollback()
                return True
            if page.LifecycleStatus != "PROCESSING":
                await self.db.rollback()
                return False

            await self.repo.delete_page(page)
            await self.db.commit()
            return True
        except Exception as exc:
            await self.db.rollback()
            log_diagnostic(
                logger,
                logging.ERROR,
                event="admin_ocr_processing_reservation_cleanup_failed",
                stage="database_cleanup",
                exception=exc,
                page_id=str(page_id),
            )
            return False

    async def _abort_page_upload(
        self,
        page_id: UUID,
        object_path: str,
        *,
        object_may_exist: bool,
        book_id: UUID,
        started_at: float,
    ) -> None:
        """Remove a pending row before removing its external object."""
        placeholder_removed = await self._discard_processing_page(page_id)
        if placeholder_removed and object_may_exist:
            await self._cleanup_uploaded_object(
                object_path,
                object_may_exist=True,
                book_id=book_id,
                page_id=page_id,
                started_at=started_at,
            )
        elif object_may_exist and not placeholder_removed:
            log_diagnostic(
                logger,
                logging.WARNING,
                event="admin_ocr_storage_cleanup_deferred",
                stage="database_cleanup",
                book_id=str(book_id),
                page_id=str(page_id),
                reason="Page state could not be proven to be an uncommitted PROCESSING placeholder",
            )

    async def require_admin(self, actor_id: UUID) -> None:
        if await self.repo.role(actor_id) != "admin":
            raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Admin access required")

    async def _read_validate_image(self, file: UploadFile) -> tuple[bytes, str, str, int, int]:
        if not file.filename:
            raise HTTPException(status_code=422, detail="An image file is required")
        data = await file.read(MAX_IMAGE_BYTES + 1)
        if len(data) > MAX_IMAGE_BYTES:
            raise HTTPException(status_code=413, detail="Image exceeds the 12 MB limit")
        if not data:
            raise HTTPException(status_code=422, detail="Image file is empty")
        declared_type = (file.content_type or "").split(";", 1)[0].strip().lower()
        if declared_type not in {"image/jpeg", "image/png", "image/webp"}:
            raise HTTPException(status_code=415, detail="Only JPEG, PNG, and WebP images are supported")
        try:
            with Image.open(BytesIO(data)) as image:
                if max(image.size) > MAX_IMAGE_DIMENSION:
                    raise HTTPException(status_code=413, detail="Image dimensions must not exceed 6000 by 6000 pixels")
                image.verify()
            with Image.open(BytesIO(data)) as image:
                image_format = image.format or ""
                orientation = image.getexif().get(274, 1)
                canonical_image = ImageOps.exif_transpose(image)
                width, height = canonical_image.size
                if orientation not in (None, 1):
                    output = BytesIO()
                    save_image = canonical_image
                    save_options: dict[str, object] = {}
                    if image_format == "JPEG":
                        if save_image.mode not in ("RGB", "L"):
                            save_image = save_image.convert("RGB")
                        save_options = {"quality": 95, "optimize": True}
                    elif image_format == "WEBP":
                        save_options = {"quality": 95, "method": 4}
                    elif image_format == "PNG":
                        save_options = {"optimize": True}
                    save_image.save(output, format=image_format, **save_options)
                    data = output.getvalue()
        except (UnidentifiedImageError, OSError, ValueError, Image.DecompressionBombError) as exc:
            raise HTTPException(status_code=422, detail="The uploaded file is not a valid image") from exc
        actual = ALLOWED_FORMATS.get(image_format)
        if actual is None or actual[0] != declared_type:
            raise HTTPException(status_code=415, detail="File content does not match the declared image type")
        suffix = PurePath(file.filename).suffix.lower()
        allowed_extensions = {"JPEG": {".jpg", ".jpeg"}, "PNG": {".png"}, "WEBP": {".webp"}}
        if suffix not in allowed_extensions.get(image_format, set()):
            raise HTTPException(status_code=415, detail="File extension does not match the image content")
        if width <= 0 or height <= 0 or width > MAX_IMAGE_DIMENSION or height > MAX_IMAGE_DIMENSION:
            raise HTTPException(status_code=413, detail="Image dimensions must not exceed 6000 by 6000 pixels")
        if not data or len(data) > MAX_IMAGE_BYTES:
            raise HTTPException(status_code=413, detail="Normalized image exceeds the 12 MB limit")
        return data, actual[0], actual[1], width, height

    @staticmethod
    def _normalize_confidence(value: object) -> float | None:
        if value is None or isinstance(value, bool):
            return None
        try:
            confidence = float(value)
        except (TypeError, ValueError):
            return None
        if not math.isfinite(confidence) or not 0.0 <= confidence <= 1.0:
            return None
        return confidence

    @staticmethod
    def _word_data(words: list[dict[str, object]]) -> list[dict[str, object]]:
        normalized: list[dict[str, object]] = []
        for position, item in enumerate(words):
            text_value = unicodedata.normalize("NFC", str(item["text"]).strip())
            norm = normalize_word(text_value)
            if not norm:
                continue
            try:
                bbox = normalize_ocr_bbox(item["bbox"])
            except (TypeError, ValueError) as exc:
                raise HTTPException(
                    status_code=422,
                    detail="OCR engine returned an invalid bounding box",
                ) from exc
            word_index = int(item.get("word_index", len(normalized)))
            line_index = int(item["line_index"])
            if word_index != len(normalized) or line_index < 0:
                raise HTTPException(
                    status_code=422,
                    detail="OCR engine returned invalid word or line indexes",
                )
            confidence = AdminOcrService._normalize_confidence(
                item.get("ocr_confidence")
            )
            normalized.append({
                "word_index": word_index,
                "line_index": line_index,
                "text": text_value,
                "normalized_text": norm,
                "bbox": list(bbox),
                "ocr_confidence": confidence,
                "ocr_review_status": (
                    item.get("ocr_review_status")
                    if item.get("ocr_review_status") in OCR_REVIEW_STATUSES
                    else "needs_review"
                ),
                "ocr_score_source": (
                    item.get("ocr_score_source")
                    if item.get("ocr_score_source") in OCR_SCORE_CONTRACTS
                    else None
                ),
                "ocr_evidence": AdminOcrService._normalize_word_evidence(
                    item.get("ocr_evidence")
                ),
            })
        if not normalized:
            raise HTTPException(status_code=422, detail="OCR did not produce any valid word")
        return normalized

    @staticmethod
    def _normalize_word_evidence(value: object) -> dict[str, object] | None:
        if not isinstance(value, dict) or value.get("contract") not in OCR_EVIDENCE_CONTRACTS:
            return None
        outputs = value.get("engine_outputs")
        safe_outputs = {}
        if isinstance(outputs, dict):
            for engine in ("paddleocr", "vietocr", "tesseract"):
                token = outputs.get(engine)
                safe_outputs[engine] = token if isinstance(token, str) else None
        source_text = value.get("source_text")
        if not isinstance(source_text, str):
            selected_engine = value.get("selected_engine")
            source_candidate = (
                safe_outputs.get(selected_engine)
                if isinstance(selected_engine, str)
                and selected_engine in {"paddleocr", "vietocr", "tesseract"}
                else None
            )
            if not isinstance(source_candidate, str):
                source_candidate = safe_outputs.get("tesseract")
            source_text = source_candidate if isinstance(source_candidate, str) else None
        agreement = value.get("engine_agreement_score")
        if isinstance(agreement, bool) or not isinstance(agreement, (int, float)):
            agreement = None
        elif not math.isfinite(float(agreement)) or not 0 <= float(agreement) <= 1:
            agreement = None
        calibrated = value.get("calibrated_word_accuracy")
        if isinstance(calibrated, bool) or not isinstance(calibrated, (int, float)):
            calibrated = None
        elif not math.isfinite(float(calibrated)) or not 0 <= float(calibrated) <= 1:
            calibrated = None
        verification_source = value.get("verification_source")
        if verification_source not in {"admin", "verified_revision"}:
            verification_source = None
        reference_text = value.get("reference_text")
        if not isinstance(reference_text, str):
            reference_text = None
        reference_alignment = value.get("reference_alignment")
        if not isinstance(reference_alignment, str):
            reference_alignment = None
        alignment = value.get("alignment")
        if not isinstance(alignment, str) or alignment == "unknown":
            # Older serializers used "unknown" for absent metadata. Preserve
            # genuine unsafe mappings separately as "unresolved".
            alignment = "not_computed"
        review_reason = value.get("review_reason")
        if not isinstance(review_reason, str):
            review_reason = "Alignment and word-level review reasoning were not recorded in this revision."

        raw_engine_statuses = value.get("engine_statuses")
        allowed_engine_statuses = {
            "not_installed", "not_initialized", "not_run", "processing",
            "success", "no_result", "error", "disabled",
        }
        engine_statuses: dict[str, str] = {}
        if isinstance(raw_engine_statuses, dict):
            for engine_name in ("paddleocr", "vietocr", "tesseract"):
                status_value = raw_engine_statuses.get(engine_name)
                if isinstance(status_value, str) and status_value in allowed_engine_statuses:
                    engine_statuses[engine_name] = status_value

        raw_engine_errors = value.get("engine_errors")
        engine_errors: dict[str, str] = {}
        if isinstance(raw_engine_errors, dict):
            for engine_name in ("paddleocr", "vietocr", "tesseract"):
                error_reason = raw_engine_errors.get(engine_name)
                if isinstance(error_reason, str):
                    engine_errors[engine_name] = error_reason[:160]

        def safe_token_index(name: str) -> int | None:
            token_index = value.get(name)
            return (
                token_index
                if isinstance(token_index, int)
                and not isinstance(token_index, bool)
                and token_index >= 0
                else None
            )

        selected_engine = value.get("selected_engine")
        if selected_engine not in {"paddleocr", "vietocr", "tesseract"}:
            selected_engine = None
        selection_reason = value.get("selection_reason")
        if not isinstance(selection_reason, str):
            selection_reason = None
        bbox_quality = value.get("bbox_quality")
        if not isinstance(bbox_quality, str):
            bbox_quality = None
        crop_quality = value.get("crop_quality")
        if not isinstance(crop_quality, str):
            crop_quality = None

        raw_crop = value.get("crop_evidence")
        crop_evidence = None
        if isinstance(raw_crop, dict):
            crop_evidence = {}
            for key in (
                "status", "reason", "preprocessing", "score_semantics",
                "paddle_error", "vietocr_error", "vietocr_status", "bbox_quality", "crop_quality",
                "paddleocr_candidate", "vietocr_candidate", "vietocr_decoding_mode",
                "tesseract_candidate", "tesseract_error",
                "bbox_source", "punctuation_before_reconciliation",
                "adjudication_rule", "adjudication_status", "adjudication_support",
                "adjudicated_text", "text_before_adjudication",
            ):
                field_value = raw_crop.get(key)
                if isinstance(field_value, str):
                    crop_evidence[key] = field_value
            clipped = raw_crop.get("padding_clipped")
            if isinstance(clipped, bool):
                crop_evidence["padding_clipped"] = clipped
            for key in ("contrast_std", "ink_ratio"):
                field_value = raw_crop.get(key)
                if (
                    isinstance(field_value, (int, float))
                    and not isinstance(field_value, bool)
                    and math.isfinite(float(field_value))
                ):
                    crop_evidence[key] = float(field_value)

            def safe_raw_score(raw_value: object) -> object:
                if isinstance(raw_value, bool):
                    return None
                if isinstance(raw_value, (int, float)):
                    number = float(raw_value)
                    return number if math.isfinite(number) else None
                if isinstance(raw_value, (list, tuple)):
                    safe_values = []
                    for element in raw_value[:128]:
                        if isinstance(element, bool):
                            safe_values.append(None)
                        elif isinstance(element, (int, float)):
                            number = float(element)
                            safe_values.append(number if math.isfinite(number) else None)
                        else:
                            safe_values.append(None)
                    return safe_values
                return None

            for key in (
                "paddle_crop_recognition_score",
                "vietocr_crop_recognition_score",
            ):
                if key in raw_crop:
                    crop_evidence[key] = safe_raw_score(raw_crop.get(key))
            if not crop_evidence:
                crop_evidence = None

        return {
            "contract": value["contract"],
            "engine_outputs": safe_outputs,
            "engine_statuses": engine_statuses,
            "engine_errors": engine_errors,
            "paddle_token_index": safe_token_index("paddle_token_index"),
            "vietocr_token_index": safe_token_index("vietocr_token_index"),
            "source_text": source_text,
            "alignment": alignment,
            "engine_agreement_score": float(agreement) if agreement is not None else None,
            "calibrated_word_accuracy": float(calibrated) if calibrated is not None else None,
            "verification_source": verification_source,
            "reference_text": reference_text,
            "reference_alignment": reference_alignment,
            "selected_engine": selected_engine,
            "selection_reason": selection_reason,
            "bbox_quality": bbox_quality,
            "crop_quality": crop_quality,
            "crop_evidence": crop_evidence,
            "review_reason": review_reason,
        }

    @staticmethod
    def _empty_word_evidence(review_reason: str) -> dict[str, object]:
        """Represent a real verification event when no OCR candidate was stored."""
        return {
            "contract": HYBRID_OCR_EVIDENCE_CONTRACT,
            "engine_outputs": {
                "paddleocr": None,
                "vietocr": None,
                "tesseract": None,
            },
            "engine_statuses": {},
            "engine_errors": {},
            "paddle_token_index": None,
            "vietocr_token_index": None,
            "source_text": None,
            "alignment": "not_computed",
            "engine_agreement_score": None,
            "calibrated_word_accuracy": None,
            "verification_source": None,
            "reference_text": None,
            "reference_alignment": None,
            "selected_engine": None,
            "selection_reason": None,
            "bbox_quality": None,
            "crop_quality": None,
            "crop_evidence": None,
            "review_reason": review_reason,
        }

    @staticmethod
    def _merge_recovered_word_evidence(
        stored: dict[str, object] | None,
        recovered: dict[str, object] | None,
    ) -> dict[str, object] | None:
        """Fill missing fields only from a safe reconstruction of an unchanged line."""
        if stored is None:
            return recovered
        if recovered is None:
            return stored

        merged = dict(stored)
        stored_outputs = dict(stored.get("engine_outputs") or {})
        recovered_outputs = recovered.get("engine_outputs")
        if isinstance(recovered_outputs, dict):
            for engine in ("paddleocr", "vietocr", "tesseract"):
                current = stored_outputs.get(engine)
                candidate = recovered_outputs.get(engine)
                if (
                    (not isinstance(current, str) or not current.strip())
                    and isinstance(candidate, str)
                    and candidate.strip()
                ):
                    stored_outputs[engine] = candidate
        merged["engine_outputs"] = stored_outputs

        for field in ("engine_statuses", "engine_errors"):
            current = merged.get(field)
            recovered_value = recovered.get(field)
            combined = dict(recovered_value) if isinstance(recovered_value, dict) else {}
            if isinstance(current, dict):
                combined.update(current)
            merged[field] = combined

        for field in (
            "paddle_token_index",
            "vietocr_token_index",
            "source_text",
            "selected_engine",
            "selection_reason",
            "bbox_quality",
            "crop_quality",
        ):
            current = merged.get(field)
            candidate = recovered.get(field)
            if current is None or (isinstance(current, str) and not current.strip()):
                if candidate is not None:
                    merged[field] = candidate

        if merged.get("alignment") in {None, "", "not_computed"}:
            recovered_alignment = recovered.get("alignment")
            if isinstance(recovered_alignment, str):
                merged["alignment"] = recovered_alignment
        if merged.get("engine_agreement_score") is None:
            merged["engine_agreement_score"] = recovered.get("engine_agreement_score")
        current_reason = merged.get("review_reason")
        if (
            not isinstance(current_reason, str)
            or not current_reason.strip()
            or current_reason
            == "Alignment and word-level review reasoning were not recorded in this revision."
        ):
            merged["review_reason"] = recovered.get("review_reason")

        # Reference fields are deliberately not reconstructed from OCR output.
        return AdminOcrService._normalize_word_evidence(merged)

    @staticmethod
    def _line_word_evidence(
        metadata: dict[str, object],
        line_index: int,
        word_position: int,
        expected_line_tokens: list[str] | None = None,
    ) -> dict[str, object] | None:
        """Recover legacy OCR candidates only when the stored line is unchanged."""
        raw_lines = metadata.get("line_evidence")
        if not isinstance(raw_lines, list):
            return None
        line = next(
            (
                item for item in raw_lines
                if isinstance(item, dict) and item.get("line_index") == line_index
            ),
            None,
        )
        if not isinstance(line, dict):
            return None
        operations = line.get("alignment_operations")
        if not isinstance(operations, list):
            return None

        selected_engine = "vietocr" if line.get("vietocr_output_used") is True else "paddleocr"
        selected_key = "vietocr_token" if selected_engine == "vietocr" else "paddle_token"
        output_key = "vietocr_output" if selected_engine == "vietocr" else "paddle_output"
        selected_output = line.get(output_key)
        if expected_line_tokens is not None:
            if not isinstance(selected_output, str):
                return None
            expected = [normalize_word(token) for token in expected_line_tokens]
            observed = normalize_text_tokens(selected_output)
            if expected != observed:
                return None

        if not isinstance(selected_output, str):
            return None
        original_indexes = [
            index
            for index, token in enumerate(selected_output.split())
            if normalize_word(token)
        ]
        if word_position < 0 or word_position >= len(original_indexes):
            return None
        selected_source_index = original_indexes[word_position]

        item = next(
            (
                candidate for candidate in operations
                if isinstance(candidate, dict)
                and candidate.get("selected_token_index") == selected_source_index
                and isinstance(candidate.get(selected_key), str)
                and str(candidate[selected_key]).strip()
            ),
            None,
        )
        if item is None:
            selected_operations = [
                candidate for candidate in operations
                if isinstance(candidate, dict)
                and isinstance(candidate.get(selected_key), str)
                and str(candidate[selected_key]).strip()
            ]
            # Legacy operations without source indexes are safe only if they
            # preserve every selected-side token in the exact original order.
            operation_tokens = normalize_text_tokens(
                " ".join(str(candidate[selected_key]) for candidate in selected_operations)
            )
            source_tokens = normalize_text_tokens(selected_output)
            if operation_tokens != source_tokens:
                return None
            if word_position >= len(selected_operations):
                return None
            item = selected_operations[word_position]

        operation = item.get("operation")
        if operation not in {"match", "substitute", "delete", "insert", "split", "merge"}:
            operation = "unresolved"
        paddle_token = item.get("paddle_token")
        vietocr_token = item.get("vietocr_token")
        source_text = item.get(selected_key)
        selection_reason = line.get("selection_reason")
        if not isinstance(selection_reason, str):
            selection_reason = "reconstructed_from_unchanged_line_evidence"

        if operation == "match":
            review_reason = (
                "Khôi phục từ line_evidence: hai engine từng trả về cùng token; "
                "điều này chưa xác minh token là đúng."
            )
        elif operation == "substitute":
            review_reason = (
                "Khôi phục từ line_evidence: hai engine từng bất đồng; "
                "candidate gốc cần Admin đối chiếu ảnh."
            )
        else:
            review_reason = (
                "Khôi phục từ line_evidence: chỉ có candidate từ engine được chọn; "
                "không có ground truth độc lập."
            )

        return {
            "contract": HYBRID_OCR_EVIDENCE_CONTRACT,
            "engine_outputs": {
                "paddleocr": paddle_token if isinstance(paddle_token, str) else None,
                "vietocr": vietocr_token if isinstance(vietocr_token, str) else None,
                "tesseract": None,
            },
            "engine_statuses": (
                line.get("engine_statuses")
                if isinstance(line.get("engine_statuses"), dict)
                else {}
            ),
            "engine_errors": (
                line.get("engine_errors")
                if isinstance(line.get("engine_errors"), dict)
                else {}
            ),
            "paddle_token_index": item.get("paddle_token_index"),
            "vietocr_token_index": item.get("vietocr_token_index"),
            "source_text": source_text,
            "alignment": str(operation),
            "engine_agreement_score": None,
            "calibrated_word_accuracy": None,
            "verification_source": None,
            "reference_text": None,
            "reference_alignment": None,
            "selected_engine": selected_engine,
            "selection_reason": selection_reason,
            "bbox_quality": None,
            "crop_quality": None,
            "crop_evidence": None,
            "review_reason": review_reason,
        }

    @staticmethod
    def _collapse_isolated_replacements(
        alignment: list[dict[str, object]],
    ) -> list[dict[str, object]]:
        """Pair one deleted reference token with one inserted OCR token.

        The aligner prefers delete+insert over pairing two very different
        tokens. When exactly one of each sits between paired neighbours (or a
        page edge), the position is still an unambiguous one-to-one
        replacement, so a badly misread word is a mismatch, not "unknown".
        Longer or unbalanced gap runs are left untouched.
        """
        collapsed: list[dict[str, object]] = []
        position = 0
        while position < len(alignment):
            step = alignment[position]
            following = alignment[position + 1] if position + 1 < len(alignment) else None
            operations = {step["operation"], following["operation"]} if following else set()
            if operations == {"delete", "insert"}:
                before = alignment[position - 1] if position > 0 else None
                after = alignment[position + 2] if position + 2 < len(alignment) else None
                isolated = all(
                    neighbour is None or neighbour["operation"] in {"match", "substitute"}
                    for neighbour in (before, after)
                )
                if isolated:
                    deleted = step if step["operation"] == "delete" else following
                    inserted = following if step["operation"] == "delete" else step
                    collapsed.append({
                        "operation": "substitute",
                        "primary_index": deleted["primary_index"],
                        "secondary_index": inserted["secondary_index"],
                        "similarity": None,
                    })
                    position += 2
                    continue
            collapsed.append(step)
            position += 1
        return collapsed

    @staticmethod
    def _apply_verified_reference(
        words: list[dict[str, object]], reference_text: str
    ) -> list[dict[str, object]]:
        """Attach evidence only from the exact page's current verified revision."""
        reference_tokens = [
            unicodedata.normalize("NFC", token).strip()
            for token in reference_text.split()
            if normalize_word(token)
        ]
        recognized_tokens = [str(word["text"]) for word in words]
        alignment = AdminOcrService._collapse_isolated_replacements(
            align_ocr_tokens(reference_tokens, recognized_tokens)
        )
        # Ambiguity is decided per token, never for the whole page: a missing
        # or extra word elsewhere must not hide a confirmed mismatch here. A
        # substitution is one-to-one only when neither neighbouring alignment
        # step is a gap (a gap next to it means the pairing could shift) and
        # the token is not part of a possible split/merge group.
        gap_adjacent_steps: set[int] = set()
        for position, step in enumerate(alignment):
            if step["operation"] in {"insert", "delete"}:
                gap_adjacent_steps.update({position - 1, position + 1})
        split_merge_recognized: set[int] = set()
        for candidate in find_split_merge_candidates(reference_tokens, recognized_tokens):
            split_merge_recognized.update(
                int(index) for index in candidate["secondary_indices"]
            )
        unambiguous_recognized_indices = {
            int(step["secondary_index"])
            for position, step in enumerate(alignment)
            if step["operation"] in {"match", "substitute"}
            and step["secondary_index"] is not None
            and position not in gap_adjacent_steps
            and int(step["secondary_index"]) not in split_merge_recognized
        }
        by_recognized_index = {
            int(step["secondary_index"]): step
            for step in alignment
            if step["secondary_index"] is not None
        }
        for index, word in enumerate(words):
            step = by_recognized_index.get(index)
            reference_index = (
                int(step["primary_index"])
                if step is not None and step["primary_index"] is not None
                else None
            )
            reference_token = (
                reference_tokens[reference_index]
                if reference_index is not None
                else None
            )
            exact_match = (
                reference_token is not None
                and normalize_word(str(word["text"]))
                == normalize_word(reference_token)
            )
            confirmed_mismatch = (
                not exact_match
                and index in unambiguous_recognized_indices
                and step is not None
                and step["operation"] == "substitute"
            )
            if step is None:
                reference_alignment = "unmatched"
            elif exact_match:
                reference_alignment = "match"
            elif confirmed_mismatch:
                reference_alignment = "substitute"
            elif step["operation"] == "substitute":
                # Paired, but not safely one-to-one: never a trusted mapping.
                reference_alignment = "ambiguous"
            else:
                reference_alignment = str(step["operation"])
            evidence = AdminOcrService._normalize_word_evidence(
                word.get("ocr_evidence")
            ) or {
                "contract": "dual_engine_agreement_v2",
                "engine_outputs": {"paddleocr": None, "vietocr": None, "tesseract": None},
                "alignment": "unknown",
                "engine_agreement_score": None,
                "calibrated_word_accuracy": None,
                "verification_source": None,
                "reference_text": None,
                "reference_alignment": None,
                "source_text": str(word["text"]),
                "review_reason": "Bằng chứng từ engine không khả dụng.",
            }
            recorded_source = evidence.get("source_text")
            if (
                not isinstance(recorded_source, str)
                or normalize_word(recorded_source) != normalize_word(str(word["text"]))
            ):
                # The reference is compared with the token stored right now;
                # a missing or empty engine field must not turn a confirmed
                # mismatch into "unknown". Engine outputs stay untouched.
                evidence["source_text"] = str(word["text"])
            evidence.update({
                "reference_text": reference_token,
                "verification_source": "verified_revision",
                "reference_alignment": reference_alignment,
                "review_reason": (
                    "Token khớp với revision đã xác minh sau khi chuẩn hóa dấu câu và chữ hoa/thường."
                    if exact_match
                    else (
                        "Token không khớp với reference trong căn chỉnh một-một rõ ràng."
                        if confirmed_mismatch
                        else "Chưa thể ghép token với reference một cách chắc chắn; cần xem lại."
                    )
                ),
            })
            word["ocr_evidence"] = evidence
            word["ocr_review_status"] = (
                "reference_match"
                if exact_match
                else "confirmed_mismatch"
                if confirmed_mismatch
                else "needs_review"
            )
        return [
            {
                "operation": step["operation"],
                "reference_token": (
                    reference_tokens[int(step["primary_index"])]
                    if step["primary_index"] is not None
                    else None
                ),
                "ocr_token": (
                    recognized_tokens[int(step["secondary_index"])]
                    if step["secondary_index"] is not None
                    else None
                ),
            }
            for step in alignment
        ]

    @staticmethod
    def _word_score_sources(
        words: list[dict[str, object]], metadata: dict[str, object]
    ) -> list[str | None]:
        contract_fallback = metadata.get("ocr_score_contract")
        sources: list[str | None] = []
        for word in words:
            source = word.get("ocr_score_source")
            if (
                not isinstance(source, str) or source not in OCR_SCORE_CONTRACTS
            ) and word.get("ocr_confidence") is not None:
                source = contract_fallback
            sources.append(
                source
                if isinstance(source, str) and source in OCR_SCORE_CONTRACTS
                else None
            )
        return sources

    @staticmethod
    def _existing_rows_by_bbox(
        words: list[dict[str, object]],
        existing_rows: list[Any],
    ) -> dict[int, Any]:
        """Match source rows only by a unique normalized bbox."""
        rows_by_bbox: dict[tuple[float, float, float, float], list[Any]] = {}
        for row in existing_rows:
            try:
                key = tuple(
                    round(value, 6)
                    for value in normalize_ocr_bbox(row.BoundingBox)
                )
            except (AttributeError, TypeError, ValueError):
                continue
            rows_by_bbox.setdefault(key, []).append(row)

        matched: dict[int, Any] = {}
        for word in words:
            try:
                key = tuple(
                    round(value, 6)
                    for value in normalize_ocr_bbox(word["bbox"])
                )
            except (KeyError, TypeError, ValueError):
                continue
            candidates = rows_by_bbox.get(key, [])
            if len(candidates) == 1:
                matched[int(word["word_index"])] = candidates[0]
        return matched

    @staticmethod
    def _preserve_trusted_word_scores(
        revision: PageRevision,
        words: list[dict[str, object]],
        existing_rows: list[Any],
    ) -> None:
        """Never transfer a raw score to a different token or ambiguous bbox."""
        metadata = dict(getattr(revision, "ProcessingMeta", None) or {})
        raw_sources = metadata.get("word_score_sources")
        if not isinstance(raw_sources, list):
            raw_sources = []
        contract_fallback = metadata.get("ocr_score_contract")
        existing_by_bbox = AdminOcrService._existing_rows_by_bbox(words, existing_rows)
        for word in words:
            source_row = existing_by_bbox.get(int(word["word_index"]))
            source_index = int(source_row.WordIndex) if source_row is not None else -1
            score_source = (
                raw_sources[source_index]
                if 0 <= source_index < len(raw_sources)
                else contract_fallback
            )
            same_token = (
                source_row is not None
                and unicodedata.normalize("NFC", str(source_row.Text))
                == unicodedata.normalize("NFC", str(word["text"]))
            )
            trusted_source = (
                score_source
                if isinstance(score_source, str) and score_source in OCR_SCORE_CONTRACTS
                else None
            )
            word["ocr_confidence"] = (
                AdminOcrService._normalize_confidence(source_row.OCRConfidence)
                if same_token
                and trusted_source in RAW_WORD_SCORE_CONTRACTS | WORD_PROBABILITY_SCORE_CONTRACTS
                else None
            )
            word["ocr_score_source"] = trusted_source if same_token else None

    @staticmethod
    def _set_word_review_statuses(
        revision: PageRevision,
        words: list[dict[str, object]],
        existing_rows: list[Any],
        *,
        verified: bool = False,
    ) -> None:
        """Persist provenance against source bbox identity, never shifted word indexes."""
        metadata = dict(getattr(revision, "ProcessingMeta", None) or {})
        old_statuses = metadata.get("word_review_statuses")
        if not isinstance(old_statuses, list):
            old_statuses = []
        old_sources = metadata.get("word_score_sources")
        if not isinstance(old_sources, list):
            old_sources = []
        old_evidence = metadata.get("word_evidence_v2")
        if not isinstance(old_evidence, list):
            old_evidence = []
        contract_fallback = metadata.get("ocr_score_contract")

        existing_by_bbox = AdminOcrService._existing_rows_by_bbox(words, existing_rows)
        sorted_rows = sorted(
            existing_rows,
            key=lambda row: (int(row.LineIndex), int(row.WordIndex)),
        )
        line_tokens: dict[int, list[str]] = {}
        line_positions: dict[int, int] = {}
        source_line_positions: dict[int, int] = {}
        for row in sorted_rows:
            line_index = int(row.LineIndex)
            word_index = int(row.WordIndex)
            source_line_positions[word_index] = line_positions.get(line_index, 0)
            line_positions[line_index] = source_line_positions[word_index] + 1
            line_tokens.setdefault(line_index, []).append(
                unicodedata.normalize("NFC", str(row.Text))
            )

        statuses: list[str] = []
        score_sources: list[str | None] = []
        evidence_items: list[dict[str, object] | None] = []
        for word in words:
            index = int(word["word_index"])
            source = existing_by_bbox.get(index)
            source_index = int(source.WordIndex) if source is not None else -1
            same_token = (
                source is not None
                and unicodedata.normalize("NFC", str(source.Text))
                == unicodedata.normalize("NFC", str(word["text"]))
            )

            previous = (
                old_statuses[source_index]
                if 0 <= source_index < len(old_statuses)
                else None
            )
            if verified:
                current = "verified"
            elif same_token and isinstance(previous, str) and previous in OCR_REVIEW_STATUSES:
                current = (
                    "engine_agreement" if previous == "matched"
                    else "needs_review" if previous == "suspect"
                    else previous
                )
            else:
                current = "needs_review"
            statuses.append(current)

            previous_source = (
                old_sources[source_index]
                if 0 <= source_index < len(old_sources)
                else contract_fallback
            )
            score_sources.append(
                previous_source
                if same_token
                and isinstance(previous_source, str)
                and previous_source in OCR_SCORE_CONTRACTS
                else None
            )

            evidence = (
                old_evidence[source_index]
                if 0 <= source_index < len(old_evidence)
                else None
            )
            normalized_evidence = AdminOcrService._normalize_word_evidence(evidence)
            if source is not None:
                recovered_evidence = AdminOcrService._normalize_word_evidence(
                    AdminOcrService._line_word_evidence(
                        metadata,
                        int(source.LineIndex),
                        source_line_positions.get(source_index, 0),
                        line_tokens.get(int(source.LineIndex)),
                    )
                )
                normalized_evidence = AdminOcrService._merge_recovered_word_evidence(
                    normalized_evidence, recovered_evidence
                )
            if (
                normalized_evidence is not None
                and normalized_evidence.get("source_text") is None
                and source is not None
            ):
                normalized_evidence["source_text"] = unicodedata.normalize(
                    "NFC", str(source.Text)
                )
            if (
                not verified
                and same_token
                and previous == "suspect"
                and AdminOcrService._has_engine_disagreement_evidence(normalized_evidence)
            ):
                current = "engine_disagreement"
                statuses[-1] = current
            evidence_items.append(normalized_evidence)

        metadata["word_review_statuses"] = statuses
        metadata["word_score_sources"] = score_sources
        metadata["word_evidence_v2"] = evidence_items
        metadata["word_evidence_v2_authoritative"] = True
        revision.ProcessingMeta = metadata


    async def _renumber_active_pages(self, book_id: UUID, *, lock: bool = True) -> bool:
        """Normalize ACTIVE pages and PROCESSING reservations to 1..N in page order."""
        active_pages = await self.repo.active_pages_for_renumber(book_id, lock=lock)
        changed = False
        for expected_number, page in enumerate(active_pages, start=1):
            if page.PageNumber != expected_number:
                self.repo.set_page_number(page, expected_number)
                await self.repo.flush()
                changed = True
        return changed

    async def upload_page(
        self, actor_id: UUID, book_id: UUID, file: UploadFile, *, upload_id: UUID | None = None,
    ) -> AdminRevisionDetailRead:
        started_at = time.perf_counter()
        log_diagnostic(
            logger,
            logging.INFO,
            event="admin_ocr_upload_started",
            stage="request_received",
            book_id=str(book_id),
        )
        await self.require_admin(actor_id)
        await self.db.rollback()

        data, content_type, extension, width, height = await self._read_validate_image(file)
        image_digest = hashlib.sha256(data).hexdigest()
        page_id = uuid4()
        revision_id = uuid4()
        object_path = f"books/{book_id}/pages/{page_id}/{uuid4().hex}.{extension}"

        # Phase 1: short transaction. The PROCESSING row reserves page order.
        try:
            book = await self.repo.book(book_id, lock=True)
            if book is None:
                raise HTTPException(status_code=404, detail="Book not found")
            if book.LifecycleStatus != "ACTIVE":
                raise HTTPException(status_code=409, detail="Cannot upload pages to a retired book")

            if upload_id is not None:
                existing = await self.repo.page_for_upload(book_id, upload_id)
                if existing is not None:
                    saved_meta = dict(existing.ProcessingMeta or {})
                    if saved_meta.get("image_sha256") != image_digest:
                        raise HTTPException(status_code=409, detail="Upload identity already belongs to a different image")
                    if existing.LifecycleStatus != "ACTIVE":
                        raise HTTPException(status_code=409, detail="This upload is pending or retired; reload before retrying")
                    saved_revision_id = saved_meta.get("upload_revision_id")
                    saved_revision = await self.repo.revision(existing.Id, UUID(saved_revision_id)) if saved_revision_id else None
                    if saved_revision is None:
                        raise HTTPException(status_code=409, detail="Upload outcome requires review; reload before retrying")
                    return await self.revision_detail(existing, saved_revision)

            await self._renumber_active_pages(book_id, lock=True)
            page_number = await self.repo.next_active_page_number(book_id)
            if page_number > 32767:
                raise HTTPException(
                    status_code=422,
                    detail="The book has reached the maximum number of pages",
                )

            page = BookPage(
                Id=page_id,
                BookId=book_id,
                PageNumber=page_number,
                ImagePath=object_path,
                Width=width,
                Height=height,
                LifecycleStatus="PROCESSING",
                FeaturePath=None,
                ProcessingMeta={
                    "storage": "supabase",
                    "ocr_state": "PROCESSING",
                    "processing_started_at": datetime.now(timezone.utc).isoformat(),
                    **({"upload_id": str(upload_id), "image_sha256": image_digest,
                        "upload_revision_id": str(revision_id)} if upload_id else {}),
                },
            )
            self.repo.stage_page_reservation(page)
            await self.repo.flush()
            await self.db.commit()
        except asyncio.CancelledError:
            await self.db.rollback()
            await self._discard_processing_page(page_id)
            raise
        except Exception:
            await self.db.rollback()
            await self._discard_processing_page(page_id)
            raise

        # Phase 2: storage upload and OCR work outside database transaction
        storage_uploaded = False
        try:
            try:
                await run_in_threadpool(upload_object, object_path, data, content_type)
                storage_uploaded = True
            except Exception as exc:
                may_exist = bool(getattr(exc, "cleanup_may_be_needed", False))
                await self._abort_page_upload(
                    page_id,
                    object_path,
                    object_may_exist=may_exist,
                    book_id=book_id,
                    started_at=started_at,
                )
                log_diagnostic(
                    logger,
                    logging.ERROR,
                    event="admin_ocr_upload_failed",
                    stage="storage_upload",
                    exception=exc,
                    book_id=str(book_id),
                    page_id=str(page_id),
                    cleanup_may_be_needed=may_exist,
                    elapsed_ms=int((time.perf_counter() - started_at) * 1000),
                )
                raise

            try:
                ocr = await run_in_threadpool(extract_text_and_boxes, data)
                words = self._word_data(ocr["words"])
                text_value = unicodedata.normalize("NFC", str(ocr["text"]).strip())
                if not text_value:
                    raise HTTPException(status_code=422, detail="OCR produced empty text")
                metadata = dict(ocr["metadata"])
                metadata.update({"source_image_path": object_path, "source_image_width": width,
                                 "source_image_height": height, "source_image_sha256": image_digest})
                metadata["word_review_statuses"] = [
                    str(word.get("ocr_review_status", "needs_review"))
                    for word in words
                ]
                metadata["word_score_sources"] = self._word_score_sources(
                    words, metadata
                )
                metadata["word_evidence_v2"] = [
                    self._normalize_word_evidence(word.get("ocr_evidence"))
                    for word in words
                ]
                metadata["word_evidence_v2_authoritative"] = True
                content_hash = hashlib.sha256(
                    json.dumps(
                        {"text": text_value, "words": words},
                        ensure_ascii=False,
                        sort_keys=True,
                    ).encode("utf-8")
                ).hexdigest()
            except OcrEngineUnavailable as exc:
                await self._abort_page_upload(
                    page_id, object_path, object_may_exist=storage_uploaded,
                    book_id=book_id, started_at=started_at,
                )
                raise HTTPException(status_code=503, detail=str(exc)) from exc
            except OcrNoTextDetected as exc:
                await self._abort_page_upload(
                    page_id, object_path, object_may_exist=storage_uploaded,
                    book_id=book_id, started_at=started_at,
                )
                raise HTTPException(
                    status_code=422,
                    detail="No usable text was detected; check the image quality",
                ) from exc
            except ValueError as exc:
                await self._abort_page_upload(
                    page_id, object_path, object_may_exist=storage_uploaded,
                    book_id=book_id, started_at=started_at,
                )
                raise HTTPException(
                    status_code=422,
                    detail="The image could not be decoded by the OCR engine",
                ) from exc
            except HTTPException:
                await self._abort_page_upload(
                    page_id, object_path, object_may_exist=storage_uploaded,
                    book_id=book_id, started_at=started_at,
                )
                raise
            except Exception as exc:
                await self._abort_page_upload(
                    page_id, object_path, object_may_exist=storage_uploaded,
                    book_id=book_id, started_at=started_at,
                )
                log_diagnostic(
                    logger,
                    logging.ERROR,
                    event="admin_ocr_upload_failed",
                    stage="ocr_processing",
                    exception=exc,
                    include_traceback=True,
                    book_id=str(book_id),
                    page_id=str(page_id),
                    elapsed_ms=int((time.perf_counter() - started_at) * 1000),
                )
                raise HTTPException(
                    status_code=503,
                    detail="OCR processing failed; check the local OCR configuration",
                ) from exc

            # Phase 3: short transaction to activate page with its revision
            stage = "database_finalize"
            try:
                await self.require_admin(actor_id)
                book = await self.repo.book(book_id, lock=True)
                if book is None or book.LifecycleStatus != "ACTIVE":
                    raise HTTPException(
                        status_code=409,
                        detail="The book is no longer active; reload and retry",
                    )
                page = await self.repo.page(page_id, lock=True)
                if page is None or page.BookId != book_id:
                    raise HTTPException(status_code=409, detail="Page reservation is no longer available")
                if page.LifecycleStatus != "PROCESSING":
                    raise HTTPException(status_code=409, detail="Page reservation is no longer pending")

                self.repo.set_page_lifecycle_status(page, "ACTIVE")
                page.ProcessingMeta = {"storage": "supabase", **({
                    "upload_id": str(upload_id), "image_sha256": image_digest,
                    "upload_revision_id": str(revision_id),
                } if upload_id else {})}
                revision = PageRevision(
                    Id=revision_id,
                    PageId=page_id,
                    RevisionNo="1",
                    VerificationStatus="NEEDS_REVIEW",
                    VerifiedText=None,
                    DraftText=text_value,
                    ContentHash=content_hash,
                    ProcessingMeta=metadata,
                )
                self.repo.stage_page_revision_bundle(page, revision, words)
                await self.repo.flush()
                await self.db.refresh(page)
                await self.db.refresh(revision)
                result = await self.revision_detail(page, revision)
                await self.db.commit()
                return result
            except IntegrityError as exc:
                log_diagnostic(
                    logger,
                    logging.WARNING,
                    event="admin_ocr_upload_failed",
                    stage=stage,
                    exception=exc,
                    book_id=str(book_id),
                    page_id=str(page_id),
                    elapsed_ms=int((time.perf_counter() - started_at) * 1000),
                )
                await self.db.rollback()
                await self._abort_page_upload(
                    page_id, object_path, object_may_exist=storage_uploaded,
                    book_id=book_id, started_at=started_at,
                )
                raise HTTPException(
                    status_code=409,
                    detail="Page number conflicts with an existing page",
                ) from exc
            except HTTPException:
                await self.db.rollback()
                await self._abort_page_upload(
                    page_id, object_path, object_may_exist=storage_uploaded,
                    book_id=book_id, started_at=started_at,
                )
                raise
            except Exception as exc:
                log_diagnostic(
                    logger,
                    logging.ERROR,
                    event="admin_ocr_upload_failed",
                    stage=stage,
                    exception=exc,
                    include_traceback=True,
                    book_id=str(book_id),
                    page_id=str(page_id),
                    elapsed_ms=int((time.perf_counter() - started_at) * 1000),
                )
                await self.db.rollback()
                await self._abort_page_upload(
                    page_id, object_path, object_may_exist=storage_uploaded,
                    book_id=book_id, started_at=started_at,
                )
                raise
        except asyncio.CancelledError:
            await self.db.rollback()
            await self._abort_page_upload(
                page_id,
                object_path,
                object_may_exist=storage_uploaded,
                book_id=book_id,
                started_at=started_at,
            )
            raise
        finally:
            await self.db.rollback()

    async def replace_page_image(
        self, actor_id: UUID, page_id: UUID, file: UploadFile, *, upload_id: UUID | None = None,
    ) -> AdminRevisionDetailRead:
        started_at = time.perf_counter()
        await self.require_admin(actor_id)
        probe = await self.repo.page(page_id)
        if probe is None:
            await self.db.rollback()
            raise HTTPException(status_code=404, detail="Page not found")
        book_id = probe.BookId
        await self.db.rollback()

        book = await self.repo.book(book_id, lock=True)
        if book is None:
            await self.db.rollback()
            raise HTTPException(status_code=404, detail="Book not found")
        if book.LifecycleStatus != "ACTIVE":
            await self.db.rollback()
            raise HTTPException(status_code=409, detail="Cannot replace a page in a retired book")
        page = await self.repo.page(page_id, lock=True)
        if page is None:
            await self.db.rollback()
            raise HTTPException(status_code=404, detail="Page not found")
        if page.BookId != book_id or page.LifecycleStatus != "ACTIVE":
            await self.db.rollback()
            raise HTTPException(status_code=409, detail="Page is no longer active; reload and retry")

        expected_verified_revision_id = page.CurrentVerifiedRevisionId
        previous_image_path = page.ImagePath
        previous_width = page.Width
        previous_height = page.Height
        existing_revisions = await self.repo.revisions(page_id)
        expected_latest_revision_id = existing_revisions[0].Id if existing_revisions else None
        previous_uploads = [(row.Id, dict(row.ProcessingMeta or {})) for row in existing_revisions] if upload_id else []
        await self.db.rollback()

        data, content_type, extension, width, height = await self._read_validate_image(file)
        image_digest = hashlib.sha256(data).hexdigest()
        if upload_id:
            for saved_id, saved_meta in previous_uploads:
                if saved_meta.get("upload_id") != str(upload_id):
                    continue
                if saved_meta.get("source_image_sha256") != image_digest:
                    raise HTTPException(status_code=409, detail="Upload identity already belongs to a different image")
                saved_page = await self.repo.page(page_id)
                saved_revision = await self.repo.revision(page_id, saved_id)
                if saved_page is None or saved_revision is None:
                    raise HTTPException(status_code=409, detail="Upload outcome requires review; reload before retrying")
                return await self.revision_detail(saved_page, saved_revision)
        object_path = f"books/{book_id}/pages/{page_id}/{uuid4().hex}.{extension}"
        storage_uploaded = False

        try:
            await run_in_threadpool(upload_object, object_path, data, content_type)
            storage_uploaded = True
        except Exception as exc:
            if bool(getattr(exc, "cleanup_may_be_needed", False)):
                await self._cleanup_uploaded_object(
                    object_path,
                    object_may_exist=True,
                    book_id=book_id,
                    page_id=page_id,
                    started_at=started_at,
                )
            raise

        try:
            ocr = await run_in_threadpool(extract_text_and_boxes, data)
            words = self._word_data(ocr["words"])
            text_value = unicodedata.normalize("NFC", str(ocr["text"]).strip())
            if not text_value:
                raise HTTPException(status_code=422, detail="OCR produced empty text")
        except OcrEngineUnavailable as exc:
            await self._cleanup_uploaded_object(
                object_path, object_may_exist=storage_uploaded,
                book_id=book_id, page_id=page_id, started_at=started_at,
            )
            raise HTTPException(status_code=503, detail=str(exc)) from exc
        except OcrNoTextDetected as exc:
            await self._cleanup_uploaded_object(
                object_path, object_may_exist=storage_uploaded,
                book_id=book_id, page_id=page_id, started_at=started_at,
            )
            raise HTTPException(
                status_code=422,
                detail="No usable text was detected; check the replacement image",
            ) from exc
        except HTTPException:
            await self._cleanup_uploaded_object(
                object_path, object_may_exist=storage_uploaded,
                book_id=book_id, page_id=page_id, started_at=started_at,
            )
            raise
        except ValueError as exc:
            await self._cleanup_uploaded_object(
                object_path, object_may_exist=storage_uploaded,
                book_id=book_id, page_id=page_id, started_at=started_at,
            )
            raise HTTPException(
                status_code=422,
                detail="Replacement image could not be decoded by OCR",
            ) from exc
        except Exception as exc:
            await self._cleanup_uploaded_object(
                object_path, object_may_exist=storage_uploaded,
                book_id=book_id, page_id=page_id, started_at=started_at,
            )
            log_diagnostic(
                logger,
                logging.ERROR,
                event="admin_ocr_reupload_failed",
                stage="ocr_processing",
                exception=exc,
                include_traceback=True,
                book_id=str(book_id),
                page_id=str(page_id),
                elapsed_ms=int((time.perf_counter() - started_at) * 1000),
            )
            raise HTTPException(
                status_code=503,
                detail="Replacement OCR processing failed; check local OCR configuration",
            ) from exc

        processing_meta = dict(ocr["metadata"])
        processing_meta["word_review_statuses"] = [
            str(word.get("ocr_review_status", "needs_review")) for word in words
        ]
        processing_meta["word_score_sources"] = self._word_score_sources(
            words, processing_meta
        )
        processing_meta["word_evidence_v2"] = [
            self._normalize_word_evidence(word.get("ocr_evidence"))
            for word in words
        ]
        processing_meta["word_evidence_v2_authoritative"] = True
        processing_meta.update({
            **({"upload_id": str(upload_id)} if upload_id else {}),
            "source_image_sha256": image_digest,
            "source_image_path": object_path,
            "source_image_width": width,
            "source_image_height": height,
            "previous_image_path": previous_image_path,
            "previous_image_width": previous_width,
            "previous_image_height": previous_height,
        })
        revision_id = uuid4()
        commit_started = False

        try:
            await self.require_admin(actor_id)
            current_book = await self.repo.book(book_id, lock=True)
            if current_book is None or current_book.LifecycleStatus != "ACTIVE":
                raise HTTPException(status_code=409, detail="Book is no longer active; reload and retry")
            current_page = await self.repo.page(page_id, lock=True)
            if current_page is None or current_page.BookId != book_id:
                raise HTTPException(status_code=409, detail="Page is no longer available; reload and retry")
            if current_page.LifecycleStatus != "ACTIVE":
                raise HTTPException(status_code=409, detail="Page is no longer active; reload and retry")
            if current_page.CurrentVerifiedRevisionId != expected_verified_revision_id:
                raise HTTPException(
                    status_code=409,
                    detail="The verified page changed while OCR was running; reload and retry",
                )

            latest_revisions = await self.repo.revisions(page_id)
            latest_revision_id = latest_revisions[0].Id if latest_revisions else None
            if latest_revision_id != expected_latest_revision_id:
                raise HTTPException(
                    status_code=409,
                    detail="Another OCR revision was created while OCR was running; reload and retry",
                )

            try:
                next_number = await self.repo.next_revision_number(page_id)
            except ValueError as exc:
                raise HTTPException(
                    status_code=409,
                    detail="Existing revision numbering requires manual review",
                ) from exc

            if current_page.CurrentVerifiedRevisionId is not None:
                current_verified = await self.repo.revision(
                    current_page.Id, current_page.CurrentVerifiedRevisionId, lock=True
                )
                if current_verified is None or current_verified.VerificationStatus != "VERIFIED":
                    raise HTTPException(
                        status_code=409,
                        detail="Current verified revision is no longer available",
                    )
                current_metadata = dict(current_verified.ProcessingMeta or {})
                current_metadata.setdefault("source_image_path", previous_image_path)
                current_metadata.setdefault("source_image_width", previous_width)
                current_metadata.setdefault("source_image_height", previous_height)
                current_verified.ProcessingMeta = current_metadata

            content_hash = hashlib.sha256(
                json.dumps(
                    {"text": text_value, "words": words},
                    ensure_ascii=False,
                    sort_keys=True,
                ).encode("utf-8")
            ).hexdigest()
            revision = PageRevision(
                Id=revision_id,
                PageId=current_page.Id,
                RevisionNo=str(next_number),
                VerificationStatus="NEEDS_REVIEW",
                VerifiedText=None,
                DraftText=text_value,
                ContentHash=content_hash,
                ProcessingMeta=processing_meta,
            )
            self.repo.stage_revision_bundle(revision, words)
            await self.repo.flush()
            await self.db.refresh(revision)
            await self.db.refresh(current_page)
            result = await self.revision_detail(current_page, revision)

            commit_started = True
            await self.db.commit()
            return result
        except IntegrityError as exc:
            await self.db.rollback()
            await self._cleanup_uploaded_object(
                object_path, object_may_exist=storage_uploaded,
                book_id=book_id, page_id=page_id, started_at=started_at,
            )
            raise HTTPException(
                status_code=409,
                detail="A concurrent OCR revision was created; reload and retry",
            ) from exc
        except HTTPException:
            await self.db.rollback()
            await self._cleanup_uploaded_object(
                object_path, object_may_exist=storage_uploaded,
                book_id=book_id, page_id=page_id, started_at=started_at,
            )
            raise
        except Exception as exc:
            await self.db.rollback()
            if commit_started:
                try:
                    persisted_page = await self.repo.page(page_id)
                    persisted_revision = await self.repo.revision(page_id, revision_id)
                    if (
                        persisted_page is not None
                        and persisted_revision is not None
                        and persisted_page.LifecycleStatus == "ACTIVE"
                    ):
                        result = await self.revision_detail(persisted_page, persisted_revision)
                        await self.db.rollback()
                        return result
                except Exception:
                    await self.db.rollback()
                    log_diagnostic(
                        logger,
                        logging.ERROR,
                        event="admin_ocr_commit_outcome_unconfirmed",
                        stage="database_commit",
                        exception=exc,
                        book_id=str(book_id),
                        page_id=str(page_id),
                    )
                    raise HTTPException(
                        status_code=503,
                        detail="OCR revision commit outcome is unknown; reload before retrying",
                    ) from exc
            await self._cleanup_uploaded_object(
                object_path, object_may_exist=storage_uploaded,
                book_id=book_id, page_id=page_id, started_at=started_at,
            )
            raise

    @staticmethod
    def _has_engine_disagreement_evidence(
        evidence: dict[str, object] | None,
    ) -> bool:
        """Return true only when this word has concrete cross-engine disagreement evidence."""
        if not isinstance(evidence, dict):
            return False

        outputs = evidence.get("engine_outputs")
        if isinstance(outputs, dict):
            paddle = outputs.get("paddleocr")
            vietocr = outputs.get("vietocr")
            if (
                isinstance(paddle, str) and paddle.strip()
                and isinstance(vietocr, str) and vietocr.strip()
                and normalize_word(paddle) != normalize_word(vietocr)
            ):
                return True

        crop_evidence = evidence.get("crop_evidence")
        if isinstance(crop_evidence, dict):
            paddle_crop = crop_evidence.get("paddleocr_candidate")
            vietocr_crop = crop_evidence.get("vietocr_candidate")
            if (
                isinstance(paddle_crop, str) and paddle_crop.strip()
                and isinstance(vietocr_crop, str) and vietocr_crop.strip()
                and normalize_word(paddle_crop) != normalize_word(vietocr_crop)
            ):
                return True

        alignment = evidence.get("alignment")
        if alignment in {"substitute", "split", "merge"}:
            return True
        if alignment in {"unmatched", "delete", "insert"}:
            selected_engine = evidence.get("selected_engine")
            other_engine = (
                "vietocr" if selected_engine == "paddleocr"
                else "paddleocr" if selected_engine == "vietocr"
                else None
            )
            statuses = evidence.get("engine_statuses")
            other_status = (
                statuses.get(other_engine)
                if isinstance(statuses, dict) and other_engine
                else None
            )
            return other_status == "success"
        return False

    @staticmethod
    def _classify_word_color_group(
        review_status: str,
        evidence: dict[str, object] | None,
        word_text: str | None = None,
    ) -> str:
        """Compatibility wrapper around the pure word-evidence classifier."""
        return classify_word_evidence(review_status, evidence, word_text)

    async def revision_detail(
        self,
        page: BookPage,
        revision: PageRevision,
        *,
        word_rows: list[Any] | None = None,
    ) -> AdminRevisionDetailRead:
        rows = word_rows if word_rows is not None else await self.repo.words(revision.Id)
        metadata = dict(revision.ProcessingMeta or {})
        raw_statuses = metadata.get("word_review_statuses")
        if not isinstance(raw_statuses, list):
            raw_statuses = []
        raw_score_sources = metadata.get("word_score_sources")
        if not isinstance(raw_score_sources, list):
            raw_score_sources = []
        raw_word_evidence = metadata.get("word_evidence_v2")
        if not isinstance(raw_word_evidence, list):
            raw_word_evidence = []
        raw_score_source = metadata.get("ocr_score_contract")
        score_contract = raw_score_source if raw_score_source in OCR_SCORE_CONTRACTS else None
        words = []
        line_positions: dict[int, int] = {}
        line_tokens: dict[int, list[str]] = {}
        for source_row in sorted(rows, key=lambda item: (int(item.LineIndex), int(item.WordIndex))):
            line_tokens.setdefault(int(source_row.LineIndex), []).append(
                unicodedata.normalize("NFC", str(source_row.Text))
            )
        for row in rows:
            word_position = line_positions.get(row.LineIndex, 0)
            line_positions[row.LineIndex] = word_position + 1
            try:
                box = normalize_ocr_bbox(row.BoundingBox)
            except (TypeError, ValueError) as exc:
                raise HTTPException(
                    status_code=409,
                    detail="Stored bounding box does not match the OCR contract",
                ) from exc
            status_from_evidence = (
                raw_statuses[row.WordIndex]
                if 0 <= row.WordIndex < len(raw_statuses)
                else None
            )
            score_source = (
                raw_score_sources[row.WordIndex]
                if 0 <= row.WordIndex < len(raw_score_sources)
                else score_contract
            )
            score_source = (
                score_source
                if isinstance(score_source, str)
                and score_source in OCR_SCORE_CONTRACTS
                else None
            )
            review_status = (
                "verified"
                if revision.VerificationStatus == "VERIFIED"
                else status_from_evidence
                if isinstance(status_from_evidence, str)
                and status_from_evidence in OCR_REVIEW_STATUSES
                else "needs_review"
            )
            if review_status == "matched":
                review_status = "engine_agreement"
            word_score = self._normalize_confidence(row.OCRConfidence)
            if score_source not in RAW_WORD_SCORE_CONTRACTS | WORD_PROBABILITY_SCORE_CONTRACTS:
                word_score = None
            stored_evidence = self._normalize_word_evidence(
                raw_word_evidence[row.WordIndex]
                if 0 <= row.WordIndex < len(raw_word_evidence)
                else None
            )
            # A partially populated V2 object must not block recovery of the
            # missing engine candidate. Reconstruction succeeds only when the
            # selected line still matches the persisted word sequence.
            recovered_evidence = self._normalize_word_evidence(
                self._line_word_evidence(
                    metadata,
                    row.LineIndex,
                    word_position,
                    line_tokens.get(int(row.LineIndex)),
                )
            )
            stored_evidence = self._merge_recovered_word_evidence(
                stored_evidence, recovered_evidence
            )
            if review_status == "suspect":
                # A legacy suspect label is not evidence by itself. Preserve it
                # as an actual disagreement only if this word has conflicting
                # PaddleOCR/VietOCR candidates or an explicit risky alignment.
                review_status = (
                    "engine_disagreement"
                    if self._has_engine_disagreement_evidence(stored_evidence)
                    else "needs_review"
                )
            if (
                review_status == "engine_disagreement"
                and not self._has_engine_disagreement_evidence(stored_evidence)
            ):
                review_status = "needs_review"
            color_group = self._classify_word_color_group(
                review_status, stored_evidence, row.Text
            )
            if color_group == "red":
                # RED is reached only through a trusted one-to-one reference
                # mismatch. No page-level or stale word status may relabel it.
                review_status = "confirmed_mismatch"
            words.append({
                "word_index": row.WordIndex, "line_index": row.LineIndex, "text": unicodedata.normalize("NFC", row.Text),
                "normalized_text": row.NormalizedText,
                "bbox": tuple(box),
                "ocr_confidence": word_score,
                "ocr_review_status": review_status,
                "review_color_group": color_group,
                "geometry_quality": geometry_quality(stored_evidence),
                "punctuation_status": punctuation_status(row.Text, stored_evidence),
                "ocr_score_source": score_source,
                "ocr_evidence": stored_evidence,
            })
        raw_revision = str(revision.RevisionNo)
        if not raw_revision.isascii() or not raw_revision.isdecimal() or int(raw_revision) < 1:
            raise HTTPException(status_code=409, detail="Stored revision number is not a positive numeric string")
        for internal_key in (
            "upload_id",
            "source_image_sha256",
            "source_image_path",
            "source_image_width",
            "source_image_height",
            "previous_image_path",
            "previous_image_width",
            "previous_image_height",
        ):
            metadata.pop(internal_key, None)
        metadata.pop("word_review_statuses", None)
        metadata.pop("word_score_sources", None)
        metadata.pop("word_evidence_v2", None)
        metadata.pop("word_evidence_v2_authoritative", None)
        metadata.pop("ocr_score_contract", None)
        return AdminRevisionDetailRead(
            page_id=page.Id, page_revision_id=revision.Id, revision_no=int(raw_revision),
            verification_status=revision.VerificationStatus, lifecycle_status=page.LifecycleStatus,
            draft_text=unicodedata.normalize("NFC", revision.DraftText if revision.DraftText is not None else (revision.VerifiedText or "")),
            words=words, ocr_metadata=metadata, created_at=revision.CreatedAt,
            verified_at=revision.VerifiedAt, verified_by=revision.VerifiedBy,
        )

    def _validated_words(self, words) -> list[dict[str, object]]:
        raw = [item.model_dump() for item in words]
        for expected_index, item in enumerate(raw):
            if item["word_index"] != expected_index:
                raise HTTPException(status_code=422, detail="word_index values must be contiguous and start at zero")
            item["text"] = unicodedata.normalize("NFC", str(item["text"]).strip())
            item["normalized_text"] = normalize_word(item["text"])
            if not item["normalized_text"]:
                raise HTTPException(status_code=422, detail="Word text cannot be empty")
            item["bbox"] = list(item["bbox"])
        return raw

    @staticmethod
    def _validate_proofread_final(proofread, corrected_text: str) -> list[dict[str, object]]:
        checked_text = unicodedata.normalize("NFC", proofread.checked_text.strip())
        checked_tokens = normalize_text_tokens(checked_text)
        final_tokens = normalize_text_tokens(corrected_text)
        if len(checked_tokens) != len(final_tokens):
            raise HTTPException(status_code=422, detail="AI proofread input no longer aligns with the verified text")
        decisions: list[dict[str, object]] = []
        seen_suggestions: set[int] = set()
        for suggestion in proofread.suggestions:
            index = suggestion.word_index
            if index >= len(checked_tokens) or index in seen_suggestions:
                raise HTTPException(status_code=422, detail="AI proofread suggestions contain an invalid or duplicate word index")
            seen_suggestions.add(index)
            original_tokens = normalize_text_tokens(suggestion.original)
            proposed_tokens = normalize_text_tokens(suggestion.proposed)
            if len(original_tokens) != 1 or len(proposed_tokens) != 1 or original_tokens[0] != checked_tokens[index]:
                raise HTTPException(status_code=422, detail="AI proofread suggestion does not match the text version reviewed by Admin")
            expected_final = proposed_tokens[0] if suggestion.decision == "ACCEPTED" else original_tokens[0]
            if final_tokens[index] != expected_final:
                raise HTTPException(status_code=422, detail="Final verified text does not match the Admin's AI suggestion decisions")
            decisions.append({"word_index": index, "original": suggestion.original,
                              "proposed": suggestion.proposed, "decision": suggestion.decision})
        if proofread.mode == "MANUAL_FALLBACK" and checked_text != corrected_text:
            raise HTTPException(status_code=422, detail="Manual fallback audit must describe the exact text being verified")
        return decisions

    async def create_edit_draft(
        self,
        actor_id: UUID,
        page_id: UUID,
        expected_source_revision_id: UUID,
    ) -> AdminRevisionDetailRead:
        await self.require_admin(actor_id)
        page = await self.repo.page(page_id, lock=True)
        if page is None:
            raise HTTPException(status_code=404, detail="Page not found")
        if page.LifecycleStatus != "ACTIVE":
            raise HTTPException(status_code=409, detail="Cannot edit a retired page")
        if page.CurrentVerifiedRevisionId is None:
            raise HTTPException(status_code=409, detail="Page has no current verified revision")
        if page.CurrentVerifiedRevisionId != expected_source_revision_id:
            raise HTTPException(
                status_code=409,
                detail="The verified revision changed; reload the page before creating a draft",
            )
        latest_revisions = await self.repo.revisions(page_id)
        if (
            latest_revisions
            and latest_revisions[0].VerificationStatus != "VERIFIED"
        ):
            raise HTTPException(
                status_code=409,
                detail="A revision is already awaiting review; finish or reload it before creating another draft",
            )

        source = await self.repo.revision(page_id, expected_source_revision_id, lock=True)
        if source is None or source.VerificationStatus != "VERIFIED" or not (source.VerifiedText or "").strip():
            raise HTTPException(status_code=409, detail="Current verified revision is not available")
        source_words = await self.repo.words(source.Id)
        if not source_words:
            raise HTTPException(status_code=409, detail="Current verified revision has no editable word data")

        candidates = []
        source_metadata = dict(source.ProcessingMeta or {})
        raw_score_sources = source_metadata.get("word_score_sources")
        if not isinstance(raw_score_sources, list):
            raw_score_sources = []
        raw_score_source = source_metadata.get("ocr_score_contract")
        score_contract = (
            raw_score_source
            if isinstance(raw_score_source, str)
            and raw_score_source in OCR_SCORE_CONTRACTS
            else None
        )
        for expected_index, row in enumerate(source_words):
            try:
                box = normalize_ocr_bbox(row.BoundingBox)
            except (TypeError, ValueError) as exc:
                raise HTTPException(
                    status_code=409,
                    detail="Stored word coordinates cannot be copied safely",
                ) from exc
            if row.WordIndex != expected_index or row.LineIndex < 0:
                raise HTTPException(
                    status_code=409,
                    detail="Stored OCR word ordering cannot be copied safely",
                )
            word_score_source = (
                raw_score_sources[expected_index]
                if expected_index < len(raw_score_sources)
                else score_contract
            )
            word_score_source = (
                word_score_source
                if isinstance(word_score_source, str)
                and word_score_source in OCR_SCORE_CONTRACTS
                else None
            )
            confidence = self._normalize_confidence(row.OCRConfidence) if word_score_source else None
            candidates.append({
                "word_index": row.WordIndex,
                "text": unicodedata.normalize("NFC", row.Text),
                "line_index": row.LineIndex,
                "bbox": box,
                "ocr_confidence": confidence,
                "ocr_score_source": word_score_source,
            })
        words = self._word_data(candidates)
        text_value = unicodedata.normalize("NFC", source.VerifiedText)
        if normalize_text_tokens(text_value) != [str(item["normalized_text"]) for item in words]:
            raise HTTPException(status_code=409, detail="Current verified text and word data are inconsistent")

        source_line_positions: dict[int, int] = {}
        source_line_tokens: dict[int, list[str]] = {}
        source_line_counts: dict[int, int] = {}
        for source_row in sorted(
            source_words, key=lambda row: (int(row.LineIndex), int(row.WordIndex))
        ):
            source_line = int(source_row.LineIndex)
            source_word_index = int(source_row.WordIndex)
            source_line_positions[source_word_index] = source_line_counts.get(source_line, 0)
            source_line_counts[source_line] = source_line_positions[source_word_index] + 1
            source_line_tokens.setdefault(source_line, []).append(
                unicodedata.normalize("NFC", str(source_row.Text))
            )

        raw_source_evidence = source_metadata.get("word_evidence_v2")
        if not isinstance(raw_source_evidence, list):
            raw_source_evidence = []
        draft_evidence: list[dict[str, object]] = []
        for index, word in enumerate(words):
            stored = self._normalize_word_evidence(
                raw_source_evidence[index] if index < len(raw_source_evidence) else None
            )
            source_row = source_words[index]
            recovered = self._normalize_word_evidence(
                self._line_word_evidence(
                    source_metadata,
                    int(source_row.LineIndex),
                    source_line_positions.get(int(source_row.WordIndex), 0),
                    source_line_tokens.get(int(source_row.LineIndex)),
                )
            )
            evidence = self._merge_recovered_word_evidence(stored, recovered)
            if evidence is None:
                evidence = self._empty_word_evidence(
                    "Từ được sao chép từ revision nguồn đã xác minh; không có OCR candidate được lưu."
                )
            evidence.update({
                "verification_source": "verified_revision",
                "reference_text": str(word["text"]),
                "reference_alignment": "match",
                "review_reason": (
                    "Từ khớp chính xác với nội dung của revision nguồn đã được Admin xác minh."
                ),
            })
            draft_evidence.append(evidence)

        try:
            next_number = await self.repo.next_revision_number(page.Id)
        except ValueError as exc:
            await self.db.rollback()
            raise HTTPException(status_code=409, detail="Existing revision numbering requires manual review") from exc
        revision = PageRevision(
            Id=uuid4(),
            PageId=page.Id,
            RevisionNo=str(next_number),
            VerificationStatus="NEEDS_REVIEW",
            VerifiedText=None,
            DraftText=text_value,
            ContentHash=hashlib.sha256(
                json.dumps({"text": text_value, "words": words}, ensure_ascii=False, sort_keys=True).encode("utf-8")
            ).hexdigest(),
            ProcessingMeta={
                "source_image_path": source_metadata.get("source_image_path", page.ImagePath),
                "source_image_width": source_metadata.get("source_image_width", page.Width),
                "source_image_height": source_metadata.get("source_image_height", page.Height),
                **({"source_image_sha256": source_metadata["source_image_sha256"]} if "source_image_sha256" in source_metadata else {}),
                "source_revision_id": str(source.Id),
                "creation_reason": "manual_edit",
                "word_review_statuses": ["reference_match"] * len(words),
                "word_score_sources": self._word_score_sources(words, source_metadata),
                "word_evidence_v2": draft_evidence,
                "word_evidence_v2_authoritative": True,
                "ocr_score_contract": score_contract,
            },
        )
        try:
            self.repo.stage_revision_bundle(revision, words)
            await self.db.commit()
            await self.db.refresh(revision)
            await self.db.refresh(page)
        except IntegrityError as exc:
            await self.db.rollback()
            raise HTTPException(status_code=409, detail="A concurrent edit created this revision number; retry") from exc
        except Exception:
            await self.db.rollback()
            raise
        return await self.revision_detail(page, revision)

    async def save_draft(self, actor_id: UUID, page_id: UUID, revision_id: UUID, payload: AdminOcrDraftRequest) -> AdminRevisionDetailRead:
        await self.require_admin(actor_id)
        page = await self.repo.page(page_id, lock=True)
        if page is None:
            raise HTTPException(status_code=404, detail="Page not found")
        if page.LifecycleStatus != "ACTIVE":
            raise HTTPException(status_code=409, detail="Cannot edit a retired page")
        revision = await self.repo.revision(page_id, revision_id, lock=True)
        if revision is None:
            raise HTTPException(status_code=404, detail="Revision not found for this page")
        if revision.VerificationStatus != "NEEDS_REVIEW":
            raise HTTPException(status_code=409, detail="Only a revision awaiting review can be edited")
        if not payload.draft_text.strip():
            raise HTTPException(status_code=422, detail="Draft text must not be blank")
        draft_text = unicodedata.normalize("NFC", payload.draft_text.strip())
        words = self._validated_words(payload.words)
        text_tokens = normalize_text_tokens(draft_text)
        word_tokens = [str(item["normalized_text"]) for item in words]
        if text_tokens != word_tokens:
            raise HTTPException(
                status_code=422,
                detail="Draft text must match the ordered word list; edit the word entries before saving",
            )

        content_hash = hashlib.sha256(
            json.dumps({"text": draft_text, "words": words}, ensure_ascii=False, sort_keys=True).encode("utf-8")
        ).hexdigest()
        try:
            existing_rows = await self.repo.words(revision.Id)
            self._preserve_trusted_word_scores(revision, words, existing_rows)
            self._set_word_review_statuses(revision, words, existing_rows)
            await self.repo.sync_words(revision.Id, words)
            self.repo.update_revision_draft(
                revision,
                draft_text=draft_text,
                content_hash=content_hash,
            )
            await self.db.commit()
            await self.db.refresh(revision)
            await self.db.refresh(page)
        except Exception:
            await self.db.rollback()
            raise
        return await self.revision_detail(page, revision)

    async def verify(self, actor_id: UUID, page_id: UUID, payload: AdminOcrVerifyRequest) -> AdminRevisionDetailRead:
        await self.require_admin(actor_id)
        page = await self.repo.page(page_id, lock=True)
        if page is None:
            raise HTTPException(status_code=404, detail="Page not found")
        if page.LifecycleStatus != "ACTIVE":
            raise HTTPException(status_code=409, detail="Cannot verify a retired page")
        revision = await self.repo.revision(page_id, payload.page_revision_id, lock=True)
        if revision is None:
            raise HTTPException(status_code=404, detail="Revision does not belong to this page")
        if revision.VerificationStatus != "NEEDS_REVIEW":
            raise HTTPException(status_code=409, detail="Only a revision awaiting review can be verified")
        corrected_text = unicodedata.normalize("NFC", payload.corrected_text.strip())
        if not corrected_text:
            raise HTTPException(status_code=422, detail="Verified text must not be blank")
        words = self._validated_words(payload.words)
        text_tokens = normalize_text_tokens(corrected_text)
        word_tokens = [str(item["normalized_text"]) for item in words]
        if text_tokens != word_tokens:
            raise HTTPException(status_code=422, detail="Corrected text must match the ordered word list; edit the word entries before verifying")
        proofread = payload.proofread_audit
        checked_text = unicodedata.normalize("NFC", proofread.checked_text.strip())
        decisions = self._validate_proofread_final(proofread, corrected_text)
        content_hash = hashlib.sha256(
            json.dumps({"text": corrected_text, "words": words}, ensure_ascii=False, sort_keys=True).encode("utf-8")
        ).hexdigest()
        try:
            existing_rows = await self.repo.words(revision.Id)
            self._preserve_trusted_word_scores(revision, words, existing_rows)
            self._set_word_review_statuses(
                revision, words, existing_rows, verified=True
            )
            verification_metadata = dict(revision.ProcessingMeta or {})
            stored_evidence_items = verification_metadata.get("word_evidence_v2")
            if not isinstance(stored_evidence_items, list):
                stored_evidence_items = []
            admin_verified_evidence: list[dict[str, object]] = []
            for index, word in enumerate(words):
                evidence = self._normalize_word_evidence(
                    stored_evidence_items[index]
                    if index < len(stored_evidence_items)
                    else None
                )
                if evidence is None:
                    evidence = self._empty_word_evidence(
                        "Admin đã xác minh từ này; không có OCR candidate gốc được lưu."
                    )
                evidence.update({
                    "verification_source": "admin",
                    "reference_text": str(word["text"]),
                    "reference_alignment": "match",
                    "review_reason": "Admin đã xác minh nội dung từ này trong revision hiện tại.",
                })
                admin_verified_evidence.append(evidence)
            verification_metadata["word_review_statuses"] = ["verified"] * len(words)
            verification_metadata["word_evidence_v2"] = admin_verified_evidence
            verification_metadata["word_evidence_v2_authoritative"] = True
            verification_metadata["ai_proofread_audit"] = {
                "mode": proofread.mode,
                "outcome": "AI_NO_SUGGESTIONS" if proofread.mode == "AI_CHECKED" and not decisions else "ADMIN_REVIEWED" if proofread.mode == "AI_CHECKED" else "MANUAL_FALLBACK",
                "source_revision_id": str(revision.Id),
                "checked_text_sha256": hashlib.sha256(checked_text.encode("utf-8")).hexdigest(),
                "checked_text": checked_text,
                "suggestions": decisions,
                "reason_code": proofread.reason_code,
                "final_content_sha256": content_hash,
                "reviewed_by": str(actor_id),
                "reviewed_at": datetime.now(timezone.utc).isoformat(),
            }
            revision.ProcessingMeta = verification_metadata
            await self.repo.sync_words(revision.Id, words)
            self.repo.update_revision_verification(
                revision,
                corrected_text=corrected_text,
                content_hash=content_hash,
                verified_by=actor_id,
                verified_at=datetime.now(timezone.utc),
            )
            source_meta = dict(revision.ProcessingMeta or {})
            source_path = source_meta.get("source_image_path")
            source_width = source_meta.get("source_image_width")
            source_height = source_meta.get("source_image_height")
            if (
                isinstance(source_path, str)
                and source_path
                and type(source_width) is int
                and type(source_height) is int
                and source_width > 0
                and source_height > 0
            ):
                self.repo.set_page_image_source(
                    page, image_path=source_path, width=source_width, height=source_height
                )
            if page.LifecycleStatus == "ACTIVE":
                self.repo.set_current_verified_revision(page, revision.Id)
            # This insert shares the VERIFIED revision's PostgreSQL transaction. The worker
            # cannot observe an event unless this exact verification commits successfully.
            await self.db.execute(
                text("""
                    INSERT INTO public.viread_ocr_outbox
                        (event_type, page_id, revision_id, actor_id, payload)
                    VALUES ('VERIFIED_REVISION', :page_id, :revision_id, :actor_id,
                            CAST(:payload AS jsonb))
                    ON CONFLICT (event_type, revision_id) DO NOTHING
                """),
                {
                    "page_id": page.Id,
                    "revision_id": revision.Id,
                    "actor_id": actor_id,
                    "payload": json.dumps({"source_flow": "FLOW1_VERIFIED", "schema": "viread-outbox-v1",
                                            "proofread_mode": proofread.mode,
                                            "verified_content_sha256": content_hash}),
                },
            )
            await self.db.commit()
            await self.db.refresh(revision)
            await self.db.refresh(page)
        except Exception:
            await self.db.rollback()
            raise
        return await self.revision_detail(page, revision)

    async def reprocess(self, actor_id: UUID, page_id: UUID) -> AdminRevisionDetailRead:
        await self.require_admin(actor_id)
        page = await self.repo.page(page_id, lock=True)
        if page is None:
            await self.db.rollback()
            raise HTTPException(status_code=404, detail="Page not found")
        if page.LifecycleStatus != "ACTIVE":
            await self.db.rollback()
            raise HTTPException(status_code=409, detail="Cannot reprocess a retired page")

        expected_verified_revision_id = page.CurrentVerifiedRevisionId
        verified_reference = (
            await self.repo.revision(page.Id, expected_verified_revision_id)
            if expected_verified_revision_id is not None
            else None
        )
        reference_text = (
            unicodedata.normalize("NFC", verified_reference.VerifiedText).strip()
            if verified_reference is not None
            and verified_reference.PageId == page.Id
            and verified_reference.VerificationStatus == "VERIFIED"
            and isinstance(verified_reference.VerifiedText, str)
            and verified_reference.VerifiedText.strip()
            else None
        )
        page_book_id = page.BookId
        latest_revisions = await self.repo.revisions(page.Id)
        expected_latest_revision_id = latest_revisions[0].Id if latest_revisions else None
        latest_metadata = dict(latest_revisions[0].ProcessingMeta or {}) if latest_revisions else {}
        candidate_path = latest_metadata.get("source_image_path")
        source_image_path = (
            candidate_path
            if isinstance(candidate_path, str) and candidate_path
            else page.ImagePath
        )
        source_width = latest_metadata.get("source_image_width") if candidate_path else page.Width
        source_height = latest_metadata.get("source_image_height") if candidate_path else page.Height
        await self.db.rollback()

        try:
            image_bytes = await run_in_threadpool(download_object, source_image_path)
            ocr = await run_in_threadpool(extract_text_and_boxes, image_bytes)
        except OcrEngineUnavailable as exc:
            raise HTTPException(status_code=503, detail=str(exc)) from exc
        except OcrNoTextDetected as exc:
            raise HTTPException(
                status_code=422,
                detail="No usable text was detected during reprocessing",
            ) from exc
        except ValueError as exc:
            raise HTTPException(
                status_code=422,
                detail="Stored image could not be decoded",
            ) from exc

        words = self._word_data(ocr["words"])
        text_value = unicodedata.normalize("NFC", str(ocr["text"]).strip())
        if not text_value:
            raise HTTPException(status_code=422, detail="OCR produced empty text")

        processing_meta = dict(ocr["metadata"])
        processing_meta["word_review_statuses"] = [
            str(word.get("ocr_review_status", "needs_review"))
            for word in words
        ]
        processing_meta["word_score_sources"] = self._word_score_sources(
            words, processing_meta
        )
        processing_meta["word_evidence_v2"] = [
            self._normalize_word_evidence(word.get("ocr_evidence")) for word in words
        ]
        processing_meta["word_evidence_v2_authoritative"] = True
        if reference_text is not None and verified_reference is not None:
            processing_meta["verified_reference_alignment"] = self._apply_verified_reference(
                words, reference_text
            )
            processing_meta["reference_source"] = "current_verified_revision"
            processing_meta["reference_revision_id"] = str(verified_reference.Id)
            processing_meta["word_review_statuses"] = [
                str(word.get("ocr_review_status", "needs_review")) for word in words
            ]
            processing_meta["word_score_sources"] = [
                word.get("ocr_score_source") for word in words
            ]
            processing_meta["word_evidence_v2"] = [
                self._normalize_word_evidence(word.get("ocr_evidence")) for word in words
            ]
        if isinstance(candidate_path, str) and candidate_path:
            for key in (
                "source_image_path",
                "source_image_width",
                "source_image_height",
                "previous_image_path",
                "previous_image_width",
                "previous_image_height",
            ):
                if key in latest_metadata:
                    processing_meta[key] = latest_metadata[key]
        processing_meta.update({"source_image_path": source_image_path,
                                "source_image_width": source_width, "source_image_height": source_height,
                                "source_image_sha256": hashlib.sha256(image_bytes).hexdigest()})

        revision_id = uuid4()
        content_hash = hashlib.sha256(
            json.dumps(
                {"text": text_value, "words": words},
                ensure_ascii=False,
                sort_keys=True,
            ).encode("utf-8")
        ).hexdigest()

        try:
            await self.require_admin(actor_id)
            current_page = await self.repo.page(page_id, lock=True)
            if current_page is None or current_page.BookId != page_book_id:
                raise HTTPException(status_code=409, detail="Page is no longer available; reload and retry")
            if current_page.LifecycleStatus != "ACTIVE":
                raise HTTPException(status_code=409, detail="Page is no longer active; reload and retry")
            if current_page.CurrentVerifiedRevisionId != expected_verified_revision_id:
                raise HTTPException(
                    status_code=409,
                    detail="The verified page changed while reprocessing was running; reload and retry",
                )

            current_revisions = await self.repo.revisions(page_id)
            current_latest_id = current_revisions[0].Id if current_revisions else None
            if current_latest_id != expected_latest_revision_id:
                raise HTTPException(
                    status_code=409,
                    detail="Another OCR revision was created while reprocessing was running; reload and retry",
                )

            try:
                next_number = await self.repo.next_revision_number(current_page.Id)
            except ValueError as exc:
                raise HTTPException(
                    status_code=409,
                    detail="Existing revision numbering requires manual review",
                ) from exc

            revision = PageRevision(
                Id=revision_id,
                PageId=current_page.Id,
                RevisionNo=str(next_number),
                VerificationStatus="NEEDS_REVIEW",
                VerifiedText=None,
                DraftText=text_value,
                ContentHash=content_hash,
                ProcessingMeta=processing_meta,
            )
            self.repo.stage_revision_bundle(revision, words)
            await self.repo.flush()
            await self.db.refresh(revision)
            await self.db.refresh(current_page)
            result = await self.revision_detail(current_page, revision)
            await self.db.commit()
            return result
        except IntegrityError as exc:
            await self.db.rollback()
            raise HTTPException(
                status_code=409,
                detail="A concurrent reprocess created this revision number; reload and retry",
            ) from exc
        except Exception:
            await self.db.rollback()
            raise

    async def retire_page(self, actor_id: UUID, page_id: UUID) -> AdminPageLifecycleRead:
        await self.require_admin(actor_id)
        probe = await self.repo.page(page_id)
        if probe is None:
            raise HTTPException(status_code=404, detail="Page not found")

        book = await self.repo.book(probe.BookId, lock=True)
        if book is None:
            raise HTTPException(status_code=404, detail="Book not found")
        page = await self.repo.page(page_id, lock=True)
        if page is None:
            raise HTTPException(status_code=404, detail="Page not found")
        if page.BookId != book.Id:
            raise HTTPException(status_code=409, detail="Page/book relationship changed; reload and retry")
        if page.LifecycleStatus not in ("ACTIVE", "RETIRED"):
            raise HTTPException(status_code=409, detail="Page lifecycle state is not supported")

        changed = False
        try:
            if page.LifecycleStatus != "RETIRED":
                self.repo.set_page_lifecycle_status(page, "RETIRED")
                await self.repo.flush()
                changed = True
            changed = await self._renumber_active_pages(page.BookId, lock=True) or changed
            if changed:
                await self.db.commit()
                await self.db.refresh(page)
        except Exception:
            await self.db.rollback()
            raise
        return AdminPageLifecycleRead(
            page_id=page.Id,
            book_id=page.BookId,
            page_number=page.PageNumber,
            lifecycle_status="RETIRED",
        )

    async def ai_correct_text(
        self,
        actor_id: UUID,
        page_id: UUID,
        draft_text: str,
        words: list[AdminOcrWordInput],
    ) -> dict[str, object]:
        prepared = await self.prepare_ai_correction(
            actor_id, page_id, draft_text, words
        )
        corrected_text = await self.run_prepared_ai_correction(prepared)
        return {"corrected_text": corrected_text}

    async def prepare_ai_correction(
        self,
        actor_id: UUID,
        page_id: UUID,
        draft_text: str,
        words: list[AdminOcrWordInput],
    ) -> PreparedLocalOcrCorrection:
        """Authorize and validate a correction before dispatching a job."""
        await self.require_admin(actor_id)
        page = await self.repo.page(page_id, lock=False)
        if page is None:
            raise HTTPException(status_code=404, detail="Page not found")
        if not draft_text.strip():
            raise HTTPException(status_code=422, detail="Draft text must not be blank")

        normalized_draft = unicodedata.normalize("NFC", draft_text)
        validated_words = self._validated_words(words)
        if normalize_text_tokens(normalized_draft) != [
            str(item["normalized_text"]) for item in validated_words
        ]:
            raise HTTPException(
                status_code=422,
                detail="Draft text and OCR word data are inconsistent",
            )
        if not page.ImagePath:
            raise HTTPException(
                status_code=409,
                detail="The source page image is unavailable for visual OCR verification.",
            )

        try:
            config = OcrCorrectionConfig.from_environment()
        except OcrConfigurationError as exc:
            raise HTTPException(
                status_code=500,
                detail="Cấu hình AI OCR trên máy chủ chưa hợp lệ.",
            ) from exc

        if len(normalized_draft.encode("utf-8")) > config.local.chunking.max_document_bytes:
            raise HTTPException(
                status_code=422,
                detail="OCR text exceeds LOCAL_OCR_MAX_DOCUMENT_BYTES",
            )
        word_boxes = [tuple(item["bbox"]) for item in validated_words]
        try:
            plan = chunk_ocr_text(normalized_draft, config.local.chunking)
        except ChunkingError as exc:
            raise HTTPException(status_code=422, detail=str(exc)) from exc
        if len(word_boxes) != len(plan.tokens):
            raise HTTPException(
                status_code=422,
                detail="Số lượng từ và vùng OCR không khớp; văn bản hiện tại được giữ nguyên.",
            )
        return PreparedLocalOcrCorrection(
            config=config,
            draft_text=normalized_draft,
            image_path=page.ImagePath,
            word_boxes=tuple(word_boxes),
            total_chunks=len(plan.chunks),
        )

    @staticmethod
    async def run_prepared_ai_correction(
        prepared: PreparedLocalOcrCorrection,
        on_progress: Callable[[int, int], None] | None = None,
    ) -> str:
        try:
            image_bytes = await run_in_threadpool(
                download_object, prepared.image_path
            )
        except Exception as exc:
            logger.warning(
                "Unable to load source page image for local OCR verification"
            )
            raise HTTPException(
                status_code=502,
                detail="Không thể tải ảnh trang để đối chiếu OCR; văn bản hiện tại vẫn được giữ nguyên.",
            ) from exc

        try:
            return await OcrCorrectionOrchestrator(prepared.config).correct(
                prepared.draft_text,
                image_bytes,
                list(prepared.word_boxes),
                on_progress=on_progress,
            )
        except OcrOrchestrationError as exc:
            if exc.code in {"INVALID_CHUNK_PLAN", "WORD_BOX_MISMATCH"}:
                status_code = 422
            elif exc.code == "DOCUMENT_TIMEOUT":
                status_code = 504
            elif exc.code in {"SOURCE_IMAGE_UNAVAILABLE", "CHUNK_IMAGE_UNAVAILABLE"}:
                status_code = 502
            else:
                status_code = 503
            raise HTTPException(
                status_code=status_code,
                detail="Không thể hoàn tất AI OCR; bản nháp hiện tại vẫn được giữ nguyên.",
            ) from exc

    async def image_url(self, page: BookPage) -> str:
        image_path = page.ImagePath
        await self.db.rollback()
        return create_signed_image_url(image_path)
