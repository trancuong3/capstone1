"""Parent-authorized local Vietnamese OCR page scanning service.

Runs exclusively on the local Windows/host OCR pipeline (`extract_text_and_boxes`)
with zero cloud OCR calls. Enforces image validation, EXIF auto-orientation,
per-owner idempotency, bounded timeout, and strict Child Safety catalog matching.
Never logs uploaded images or recognized Vietnamese text.
"""
from __future__ import annotations

import asyncio
import hashlib
import logging
import os
import threading
import time
import unicodedata
from collections import Counter
from dataclasses import dataclass
from io import BytesIO
from typing import Any
from uuid import UUID, uuid4

from fastapi import HTTPException, UploadFile
from PIL import Image, ImageOps, UnidentifiedImageError
from starlette.concurrency import run_in_threadpool

from app.diagnostic_logging import log_diagnostic
from app.repositories.local_ocr_scan_repository import LocalOcrScanRepository
from app.schemas.reading import (
    LocalOcrPageScanRead,
    LocalOcrProvenanceRead,
    LocalOcrWordRead,
    ReadingPageRead,
    ReadingPageWordRead,
)
from app.services import ocr_engine
from app.services.ocr_engine import (
    OcrEngineUnavailable,
    OcrNoTextDetected,
    extract_text_and_boxes,
    normalize_text_tokens,
    normalize_word,
)

logger = logging.getLogger(__name__)

MAX_SCAN_IMAGE_BYTES = 12 * 1024 * 1024
MAX_SCAN_IMAGE_DIMENSION = 6000
ALLOWED_SCAN_FORMATS = {"JPEG", "PNG", "WEBP"}
DEFAULT_SCAN_TIMEOUT_SECONDS = 120.0
IDEMPOTENCY_TTL_SECONDS = 900.0
IDEMPOTENCY_MAX_ENTRIES = 128


@dataclass(frozen=True)
class _CachedScanEntry:
    image_sha256: str
    book_id: UUID | None
    child_id: UUID | None
    created_at: float
    response: LocalOcrPageScanRead


_idempotency_lock = threading.Lock()
_idempotency_cache: dict[tuple[UUID, UUID], _CachedScanEntry] = {}


def clear_local_ocr_scan_cache() -> None:
    """Test helper to reset bounded in-memory idempotency cache."""
    with _idempotency_lock:
        _idempotency_cache.clear()


def _prune_cache(now: float) -> None:
    expired = [
        key
        for key, entry in _idempotency_cache.items()
        if (now - entry.created_at) > IDEMPOTENCY_TTL_SECONDS
    ]
    for key in expired:
        _idempotency_cache.pop(key, None)
    while len(_idempotency_cache) > IDEMPOTENCY_MAX_ENTRIES:
        oldest_key = min(
            _idempotency_cache.items(), key=lambda item: item[1].created_at
        )[0]
        _idempotency_cache.pop(oldest_key, None)


def _normalize_bbox(raw_bbox: object) -> tuple[float, float, float, float]:
    if isinstance(raw_bbox, (list, tuple)) and len(raw_bbox) == 4:
        return (
            max(0.0, min(1.0, float(raw_bbox[0]))),
            max(0.0, min(1.0, float(raw_bbox[1]))),
            max(0.0001, min(1.0, float(raw_bbox[2]))),
            max(0.0001, min(1.0, float(raw_bbox[3]))),
        )
    if isinstance(raw_bbox, dict):
        return (
            max(0.0, min(1.0, float(raw_bbox.get("x", 0.0)))),
            max(0.0, min(1.0, float(raw_bbox.get("y", 0.0)))),
            max(0.0001, min(1.0, float(raw_bbox.get("w", raw_bbox.get("width", 0.1))))),
            max(0.0001, min(1.0, float(raw_bbox.get("h", raw_bbox.get("height", 0.05))))),
        )
    return (0.0, 0.0, 0.1, 0.05)


def _detect_runtime_device(metadata: dict[str, Any]) -> str:
    """Report actual execution device observed in ocr_engine, never guessed from config."""
    statuses = metadata.get("engine_statuses")
    if isinstance(statuses, dict) and statuses.get("vietocr") == "success":
        predictor = getattr(ocr_engine, "_vietocr_engine", None)
        if predictor is not None:
            dev = getattr(predictor, "device", None)
            if dev is not None:
                dev_str = str(dev).lower()
                if dev_str.startswith("cuda"):
                    return "cuda"
                if dev_str.startswith("cpu"):
                    return "cpu"
            cfg = getattr(predictor, "config", None)
            if isinstance(cfg, dict):
                cfg_dev = str(cfg.get("device", "")).lower()
                if cfg_dev.startswith("cuda"):
                    return "cuda"
                if cfg_dev.startswith("cpu"):
                    return "cpu"
        torch_mod = getattr(ocr_engine, "torch", None)
        if torch_mod is not None:
            try:
                return "cuda" if torch_mod.cuda.is_available() else "cpu"
            except Exception:
                return "unknown"
    if metadata.get("engine") == "tesseract":
        return "cpu"
    return "cpu" if isinstance(statuses, dict) and statuses.get("paddleocr") == "success" else "unknown"


def _token_match_score(ocr_tokens: list[str], reference_tokens: list[str]) -> tuple[float, int]:
    """Compute NFC Vietnamese token overlap score between OCR text and verified page text."""
    if not ocr_tokens or not reference_tokens:
        return 0.0, 0
    ocr_counts = Counter(ocr_tokens)
    ref_counts = Counter(reference_tokens)
    shared = sum((ocr_counts & ref_counts).values())
    if shared == 0:
        return 0.0, 0
    dice = (2.0 * shared) / (len(ocr_tokens) + len(reference_tokens))
    containment = shared / min(len(ocr_tokens), len(reference_tokens))
    score = round(min(1.0, 0.6 * dice + 0.4 * containment), 3)
    return score, shared


class LocalOcrScanService:
    def __init__(self, repository: LocalOcrScanRepository):
        self.repository = repository

    async def _validate_and_normalize_image(self, file: UploadFile) -> tuple[bytes, str]:
        try:
            raw = await file.read(MAX_SCAN_IMAGE_BYTES + 1)
        except Exception as exc:
            raise HTTPException(
                status_code=422,
                detail="Image decoding failed",
            ) from exc
        finally:
            try:
                await file.close()
            except Exception:
                pass

        if not raw:
            raise HTTPException(status_code=422, detail="A file is required")
        if len(raw) > MAX_SCAN_IMAGE_BYTES:
            raise HTTPException(status_code=413, detail="Image exceeds the 12 MB limit")

        image_sha256 = hashlib.sha256(raw).hexdigest()

        try:
            with Image.open(BytesIO(raw)) as probe:
                fmt = (probe.format or "").upper()
                if fmt not in ALLOWED_SCAN_FORMATS:
                    raise HTTPException(
                        status_code=415,
                        detail="Unsupported upload format; use JPEG, PNG, or WebP",
                    )
                width, height = probe.size
                if width <= 0 or height <= 0:
                    raise HTTPException(status_code=422, detail="Image dimensions are invalid")
                if width > MAX_SCAN_IMAGE_DIMENSION or height > MAX_SCAN_IMAGE_DIMENSION:
                    raise HTTPException(
                        status_code=422,
                        detail="Image dimensions must not exceed 6000 by 6000 pixels",
                    )
                # Apply EXIF orientation so rotated mobile camera photos are upright.
                oriented = ImageOps.exif_transpose(probe)
                rgb = oriented.convert("RGB")
                buf = BytesIO()
                rgb.save(buf, format="PNG")
                clean_bytes = buf.getvalue()
        except HTTPException:
            raise
        except (UnidentifiedImageError, OSError, ValueError) as exc:
            raise HTTPException(status_code=422, detail="Image decoding failed") from exc

        return clean_bytes, image_sha256

    async def scan_page(
        self,
        actor_id: UUID,
        file: UploadFile,
        *,
        request_id: str,
        book_id: UUID | None = None,
        child_id: UUID | None = None,
        idempotency_key: UUID | None = None,
    ) -> LocalOcrPageScanRead:
        role = await self.repository.profile_role(actor_id)
        if role != "parent":
            raise HTTPException(status_code=403, detail="Parent access required")

        if child_id is not None:
            if not await self.repository.child_belongs_to_parent(child_id, actor_id):
                raise HTTPException(status_code=404, detail="Child profile not found")

        clean_bytes, image_sha256 = await self._validate_and_normalize_image(file)

        if idempotency_key is not None:
            now = time.monotonic()
            with _idempotency_lock:
                _prune_cache(now)
                cached = _idempotency_cache.get((actor_id, idempotency_key))
                if cached is not None:
                    if cached.image_sha256 != image_sha256 or cached.book_id != book_id:
                        raise HTTPException(
                            status_code=409,
                            detail="Upload identity already belongs to a different image",
                        )
                    return cached.response

        scan_job_id = uuid4()
        started_at = time.perf_counter()
        timeout_seconds = max(
            1.0,
            float(os.getenv("LOCAL_OCR_SCAN_TIMEOUT_SECONDS", str(DEFAULT_SCAN_TIMEOUT_SECONDS))),
        )

        log_diagnostic(
            logger,
            logging.INFO,
            event="local_ocr_page_scan_started",
            stage="ocr_inference",
            request_id=request_id,
            scan_job_id=str(scan_job_id),
            book_id=str(book_id) if book_id else None,
        )

        try:
            ocr_result = await asyncio.wait_for(
                run_in_threadpool(extract_text_and_boxes, clean_bytes),
                timeout=timeout_seconds,
            )
        except (TimeoutError, asyncio.TimeoutError) as exc:
            log_diagnostic(
                logger,
                logging.WARNING,
                event="local_ocr_page_scan_timeout",
                stage="ocr_inference",
                request_id=request_id,
                scan_job_id=str(scan_job_id),
                elapsed_ms=int((time.perf_counter() - started_at) * 1000),
            )
            raise HTTPException(
                status_code=504,
                detail="Local OCR processing timed out; please retry",
            ) from exc
        except OcrNoTextDetected as exc:
            log_diagnostic(
                logger,
                logging.INFO,
                event="local_ocr_page_scan_no_text",
                stage="ocr_inference",
                request_id=request_id,
                scan_job_id=str(scan_job_id),
                elapsed_ms=int((time.perf_counter() - started_at) * 1000),
            )
            raise HTTPException(
                status_code=422,
                detail="No usable text was detected; check the image quality",
            ) from exc
        except OcrEngineUnavailable as exc:
            log_diagnostic(
                logger,
                logging.ERROR,
                event="local_ocr_page_scan_unavailable",
                stage="ocr_inference",
                exception=exc,
                request_id=request_id,
                scan_job_id=str(scan_job_id),
                elapsed_ms=int((time.perf_counter() - started_at) * 1000),
            )
            raise HTTPException(
                status_code=503,
                detail="Local OCR engine is unavailable",
            ) from exc
        except ValueError as exc:
            raise HTTPException(status_code=422, detail="Image decoding failed") from exc
        except Exception as exc:
            log_diagnostic(
                logger,
                logging.ERROR,
                event="local_ocr_page_scan_failed",
                stage="ocr_inference",
                exception=exc,
                request_id=request_id,
                scan_job_id=str(scan_job_id),
                elapsed_ms=int((time.perf_counter() - started_at) * 1000),
            )
            raise HTTPException(
                status_code=500,
                detail="OCR processing failed; check the local OCR configuration",
            ) from exc

        elapsed_ms = int((time.perf_counter() - started_at) * 1000)
        ocr_text = unicodedata.normalize("NFC", str(ocr_result.get("text", "")).strip())
        if not ocr_text:
            raise HTTPException(
                status_code=422,
                detail="No usable text was detected; check the image quality",
            )

        raw_words = ocr_result.get("words") if isinstance(ocr_result.get("words"), list) else []
        parsed_words: list[LocalOcrWordRead] = []
        for idx, raw_word in enumerate(raw_words):
            if not isinstance(raw_word, dict):
                continue
            surface = unicodedata.normalize("NFC", str(raw_word.get("text", "")).strip())
            if not surface:
                continue
            conf_raw = raw_word.get("ocr_confidence")
            conf = (
                max(0.0, min(1.0, float(conf_raw)))
                if isinstance(conf_raw, (int, float))
                else None
            )
            parsed_words.append(
                LocalOcrWordRead(
                    word_index=int(raw_word.get("word_index", idx)),
                    line_index=max(0, int(raw_word.get("line_index", 0))),
                    text=surface,
                    normalized_text=normalize_word(surface),
                    bbox=_normalize_bbox(raw_word.get("bbox")),
                    ocr_confidence=conf,
                )
            )

        metadata = (
            dict(ocr_result["metadata"])
            if isinstance(ocr_result.get("metadata"), dict)
            else {}
        )
        engine_statuses = {
            str(k): str(v)
            for k, v in (metadata.get("engine_statuses") or {}).items()
        } if isinstance(metadata.get("engine_statuses"), dict) else {}
        device = _detect_runtime_device(metadata)
        provenance = LocalOcrProvenanceRead(
            engine=str(metadata.get("engine") or "unknown"),
            device=device if device in ("cuda", "cpu", "unknown") else "unknown",
            engine_statuses=engine_statuses,
            model_profile=str(metadata["model_profile"]) if metadata.get("model_profile") else None,
            checkpoint_sha256=str(metadata["checkpoint_sha256"]) if metadata.get("checkpoint_sha256") else None,
            model_load_status=str(metadata["model_load_status"]) if metadata.get("model_load_status") else None,
            cloud_ocr_used=False,
            elapsed_ms=elapsed_ms,
        )

        # Match extracted Vietnamese text against child-safety-approved catalog pages.
        ocr_tokens = normalize_text_tokens(ocr_text)
        candidates = await self.repository.eligible_verified_pages(book_id=book_id)
        best_tuple = None
        best_score = 0.0
        best_shared = 0
        for candidate_book, candidate_page, candidate_rev in candidates:
            ref_text = candidate_rev.VerifiedText or candidate_rev.OriginalOcrText or ""
            ref_tokens = normalize_text_tokens(ref_text)
            score, shared = _token_match_score(ocr_tokens, ref_tokens)
            if score > best_score or (score == best_score and shared > best_shared):
                best_score = score
                best_shared = shared
                best_tuple = (candidate_book, candidate_page, candidate_rev)

        matched = False
        matched_book_id: UUID | None = None
        matched_book_title: str | None = None
        matched_page_dto: ReadingPageRead | None = None
        if best_tuple is not None and (
            (best_score >= 0.35 and best_shared >= 3)
            or (best_score >= 0.60 and best_shared >= 2)
        ):
            m_book, m_page, m_rev = best_tuple
            rev_words = await self.repository.revision_words(m_rev.Id)
            matched = True
            matched_book_id = m_book.Id
            matched_book_title = m_book.Title
            matched_page_dto = ReadingPageRead(
                page_id=m_page.Id,
                page_revision_id=m_rev.Id,
                page_number=m_page.PageNumber,
                confidence=best_score,
                width=max(1, int(m_page.Width or 1000)),
                height=max(1, int(m_page.Height or 1400)),
                words=[
                    ReadingPageWordRead(
                        word_id=w.Id,
                        word_index=w.WordIndex,
                        text=w.Text,
                        bbox=_normalize_bbox(w.BoundingBox),
                    )
                    for w in rev_words
                ],
            )
            message = (
                f"Đã nhận diện tiếng Việt bằng OCR cục bộ và khớp Trang {m_page.PageNumber} "
                f"của sách “{m_book.Title}”."
            )
        else:
            message = (
                "Đã nhận diện văn bản tiếng Việt trên máy chủ cục bộ, nhưng trang này chưa khớp "
                "trang đã duyệt trong thư viện. Ba mẹ có thể chọn sách trong thư viện để bắt đầu đọc."
            )

        response = LocalOcrPageScanRead(
            scan_job_id=scan_job_id,
            request_id=request_id,
            idempotency_key=idempotency_key,
            status="SUCCEEDED",
            ocr_text=ocr_text,
            word_count=len(parsed_words),
            words=parsed_words,
            provenance=provenance,
            matched=matched,
            matched_book_id=matched_book_id,
            matched_book_title=matched_book_title,
            match_confidence=best_score if matched else 0.0,
            matched_page=matched_page_dto,
            message=message,
        )

        if idempotency_key is not None:
            now = time.monotonic()
            with _idempotency_lock:
                _prune_cache(now)
                _idempotency_cache[(actor_id, idempotency_key)] = _CachedScanEntry(
                    image_sha256=image_sha256,
                    book_id=book_id,
                    child_id=child_id,
                    created_at=now,
                    response=response,
                )

        # Safe correlation log only: NEVER log image bytes or recognized text!
        log_diagnostic(
            logger,
            logging.INFO,
            event="local_ocr_page_scan_completed",
            stage="ocr_inference",
            request_id=request_id,
            scan_job_id=str(scan_job_id),
            engine=provenance.engine,
            device=provenance.device,
            model_profile=provenance.model_profile,
            model_load_status=provenance.model_load_status,
            elapsed_ms=elapsed_ms,
            word_count=len(parsed_words),
            matched=matched,
            matched_book_id=str(matched_book_id) if matched_book_id else None,
        )
        return response
