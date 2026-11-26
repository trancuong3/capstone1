"""Parent-authorized local Vietnamese OCR page scanning service.

Runs exclusively on the local Windows/host OCR pipeline (`extract_text_and_boxes`)
with zero cloud OCR calls. Enforces image validation, EXIF auto-orientation,
per-owner idempotency, bounded timeout, and strict Child Safety catalog matching.
Never logs uploaded images or recognized Vietnamese text.
"""
from __future__ import annotations

import asyncio
import hashlib
import inspect
import logging
import math
import os
import sys
import threading
import time
import unicodedata
from collections import Counter
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from io import BytesIO
from typing import Any
from uuid import UUID, uuid4

from fastapi import HTTPException, UploadFile
from PIL import Image, ImageOps, UnidentifiedImageError
from starlette.concurrency import run_in_threadpool

from app.services.ocr_executor import get_ocr_executor

from app.database.config import SUPABASE_PRIVATE_BOOKS_BUCKET
from app.diagnostic_logging import log_diagnostic
from app.models import OcrInferenceJob
from app.repositories.local_ocr_scan_repository import LocalOcrScanRepository
from app.schemas.reading import (
    LocalOcrPageScanJobListRead,
    LocalOcrPageScanJobRead,
    LocalOcrPageScanRead,
    LocalOcrProvenanceRead,
    LocalOcrWordRead,
    ReadingPageRead,
    ReadingPageWordRead,
)
from app.services import storage_service
from app.services.ocr_inference_job_service import (
    JOB_KIND_LOCAL_SCAN,
    PRIORITY_LOCAL_SCAN,
    OcrInferenceJobService,
    is_remote_ocr_mode,
    normalize_text_tokens,
    normalize_word,
    remote_sync_wait_timeout_seconds,
)


class OcrEngineUnavailable(RuntimeError):
    """Lightweight placeholder matching app.services.ocr_engine.OcrEngineUnavailable."""


class OcrNoTextDetected(RuntimeError):
    """Lightweight placeholder matching app.services.ocr_engine.OcrNoTextDetected."""


def _is_ocr_exception(exc: BaseException, class_name: str) -> bool:
    return any(cls.__name__ == class_name for cls in type(exc).__mro__)


def extract_text_and_boxes(image_bytes: bytes):
    """Lazy proxy preserving unit-test patch targets without importing ocr_engine at startup."""
    from app.services import ocr_engine as _ocr_engine

    try:
        return _ocr_engine.extract_text_and_boxes(image_bytes)
    except _ocr_engine.OcrNoTextDetected as exc:
        raise OcrNoTextDetected(str(exc)) from exc
    except _ocr_engine.OcrEngineUnavailable as exc:
        raise OcrEngineUnavailable(str(exc)) from exc


async def _run_local_ocr_in_executor(clean_bytes: bytes) -> dict[str, Any]:
    """Run local OCR extraction inside the bounded single-worker OCR executor as a coroutine."""
    loop = asyncio.get_running_loop()
    return await loop.run_in_executor(
        get_ocr_executor(), extract_text_and_boxes, clean_bytes
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


def _safe_finite_float(value: object, default: float) -> float:
    if value is None or isinstance(value, bool):
        return default
    try:
        parsed = float(value)
    except (TypeError, ValueError, OverflowError):
        return default
    return parsed if math.isfinite(parsed) else default


def _safe_nonneg_int(value: object, default: int) -> int:
    if value is None or isinstance(value, bool):
        return default
    if isinstance(value, float):
        if not math.isfinite(value):
            return default
        return max(0, int(value))
    try:
        return max(0, int(value))
    except (TypeError, ValueError, OverflowError):
        return default


def _resolve_scan_timeout_seconds() -> float:
    raw = os.getenv("LOCAL_OCR_SCAN_TIMEOUT_SECONDS", str(DEFAULT_SCAN_TIMEOUT_SECONDS))
    parsed = _safe_finite_float(raw, DEFAULT_SCAN_TIMEOUT_SECONDS)
    return max(1.0, min(600.0, parsed))


def _clamp_bbox_coords(
    raw_x: float, raw_y: float, raw_w: float, raw_h: float
) -> tuple[float, float, float, float]:
    x = max(0.0, min(0.9999, raw_x))
    y = max(0.0, min(0.9999, raw_y))
    w = max(0.0001, min(1.0 - x, raw_w))
    h = max(0.0001, min(1.0 - y, raw_h))
    if x + w > 1.0:
        w = max(0.0001, math.floor((1.0 - x) * 1_000_000) / 1_000_000)
    if y + h > 1.0:
        h = max(0.0001, math.floor((1.0 - y) * 1_000_000) / 1_000_000)
    return (x, y, w, h)


def _normalize_bbox(raw_bbox: object) -> tuple[float, float, float, float]:
    if isinstance(raw_bbox, (list, tuple)) and len(raw_bbox) == 4:
        return _clamp_bbox_coords(
            _safe_finite_float(raw_bbox[0], 0.0),
            _safe_finite_float(raw_bbox[1], 0.0),
            _safe_finite_float(raw_bbox[2], 0.1),
            _safe_finite_float(raw_bbox[3], 0.05),
        )
    if isinstance(raw_bbox, dict):
        return _clamp_bbox_coords(
            _safe_finite_float(raw_bbox.get("x"), 0.0),
            _safe_finite_float(raw_bbox.get("y"), 0.0),
            _safe_finite_float(raw_bbox.get("w", raw_bbox.get("width")), 0.1),
            _safe_finite_float(raw_bbox.get("h", raw_bbox.get("height")), 0.05),
        )
    return (0.0, 0.0, 0.1, 0.05)


def _decode_and_normalize_image_bytes(raw: bytes) -> tuple[bytes, str]:
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
            # Apply EXIF orientation so rotated mobile camera photos are upright,
            # and store compact JPEG q85 (avoiding multi-MB uncompressed PNGs).
            oriented = ImageOps.exif_transpose(probe)
            rgb = oriented.convert("RGB")
            buf = BytesIO()
            rgb.save(buf, format="JPEG", quality=85, optimize=True)
            clean_bytes = buf.getvalue()
    except HTTPException:
        raise
    except (UnidentifiedImageError, OSError, ValueError, Image.DecompressionBombError) as exc:
        raise HTTPException(status_code=422, detail="Image decoding failed") from exc

    # Hash the exact encoded bytes stored/transmitted so remote OCR workers verify cleanly.
    image_sha256 = hashlib.sha256(clean_bytes).hexdigest()
    return clean_bytes, image_sha256


def _probe_image_dimensions_and_format(clean_bytes: bytes) -> tuple[int, int, str]:
    try:
        with Image.open(BytesIO(clean_bytes)) as img:
            width, height = img.size
            fmt = (img.format or "PNG").upper()
            if width <= 0 or height <= 0:
                raise HTTPException(status_code=422, detail="Image dimensions are invalid")
            return int(width), int(height), fmt
    except HTTPException:
        raise
    except (UnidentifiedImageError, OSError, ValueError, Image.DecompressionBombError) as exc:
        raise HTTPException(status_code=422, detail="Image decoding failed") from exc


def _detect_runtime_device(metadata: dict[str, Any]) -> str:
    """Report actual execution device observed on runtime, never guessed from config."""
    explicit_dev = str(metadata.get("runtime_device") or "").lower()
    if explicit_dev.startswith("cuda"):
        return "cuda"
    if explicit_dev.startswith("cpu"):
        return "cpu"
    statuses = metadata.get("engine_statuses")
    ocr_engine_mod = sys.modules.get("app.services.ocr_engine")
    if isinstance(statuses, dict) and statuses.get("vietocr") == "success" and ocr_engine_mod is not None:
        predictor = getattr(ocr_engine_mod, "_vietocr_engine", None)
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
        torch_mod = getattr(ocr_engine_mod, "torch", None)
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

    async def _release_db_read_txn(self) -> None:
        """Release read-only auth/lookup transactions before slow I/O without discarding pending ORM changes."""
        db = getattr(self.repository, "db", None)
        if db is None or (
            getattr(db, "new", None)
            or getattr(db, "dirty", None)
            or getattr(db, "deleted", None)
        ):
            return
        rollback = getattr(db, "rollback", None)
        if callable(rollback):
            try:
                res = rollback()
                if inspect.isawaitable(res):
                    await res
            except Exception:
                pass

    async def _validate_and_normalize_image(self, file: UploadFile) -> tuple[bytes, str]:
        chunks: list[bytes] = []
        total = 0
        chunk_size = 1024 * 1024
        try:
            while True:
                chunk = await file.read(chunk_size)
                if not chunk:
                    break
                total += len(chunk)
                if total > MAX_SCAN_IMAGE_BYTES:
                    raise HTTPException(
                        status_code=413,
                        detail="Image exceeds the 12 MB limit",
                    )
                chunks.append(chunk)
        except HTTPException:
            raise
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

        raw = b"".join(chunks)
        if not raw:
            raise HTTPException(status_code=422, detail="A file is required")

        return await asyncio.to_thread(_decode_and_normalize_image_bytes, raw)

    async def _run_remote_ocr_scan(
        self,
        *,
        actor_id: UUID,
        scan_job_id: UUID,
        clean_bytes: bytes,
        image_sha256: str,
        book_id: UUID | None,
        idempotency_key: UUID | None,
        timeout_seconds: float,
    ) -> dict[str, Any]:
        job_service = OcrInferenceJobService(self.repository.db)
        if not await job_service.has_online_worker():
            raise HTTPException(
                status_code=503,
                detail="Remote OCR worker is offline; live page scan is temporarily unavailable.",
            )
        await self._release_db_read_txn()

        width, height, fmt = await asyncio.to_thread(
            _probe_image_dimensions_and_format, clean_bytes
        )
        ext = "jpg" if fmt == "JPEG" else ("webp" if fmt == "WEBP" else "png")
        mime_type = "image/jpeg" if ext == "jpg" else f"image/{ext}"
        storage_path = f"local-scans/{actor_id}/{scan_job_id}.{ext}"

        await asyncio.to_thread(
            storage_service.upload_object,
            storage_path,
            clean_bytes,
            mime_type,
            bucket_name=SUPABASE_PRIVATE_BOOKS_BUCKET,
        )
        job_id: UUID | None = None
        try:
            job = await job_service.enqueue_job(
                job_kind=JOB_KIND_LOCAL_SCAN,
                owner_user_id=actor_id,
                book_id=book_id,
                local_scan_request_id=str(scan_job_id),
                image_bucket=SUPABASE_PRIVATE_BOOKS_BUCKET,
                image_path=storage_path,
                image_sha256=image_sha256,
                image_width=int(width),
                image_height=int(height),
                image_mime_type=mime_type,
                priority=PRIORITY_LOCAL_SCAN,
                idempotency_key=f"local_scan:{idempotency_key}" if idempotency_key else None,
            )
            job_id = job.Id
            await self.repository.db.commit()

            try:
                completed = await job_service.wait_for_job_completion(
                    job.Id,
                    timeout_seconds=min(
                        float(timeout_seconds), remote_sync_wait_timeout_seconds()
                    ),
                )
            except HTTPException:
                await OcrInferenceJobService(self.repository.db).cancel_job(
                    job.Id, reason="SYNC_SCAN_TIMEOUT"
                )
                raise

            if completed.Status == "DEAD_LETTER":
                if (completed.ErrorCode or "").upper() == "NO_TEXT_DETECTED":
                    raise OcrNoTextDetected("No text detected")
                raise OcrEngineUnavailable(completed.ErrorCode or "Remote OCR worker failed")
            if completed.Status != "SUCCEEDED":
                raise OcrEngineUnavailable(completed.CancelledReason or "Remote OCR scan cancelled")

            payload = dict(completed.ResultPayload or {})
            if payload.get("no_text_detected"):
                raise OcrNoTextDetected("No usable text detected")
            return {
                "text": str(payload.get("full_text") or ""),
                "words": list(payload.get("words") or []),
                "metadata": {
                    **dict(payload.get("ocr_meta") or {}),
                    "runtime_device": str(
                        (payload.get("ocr_meta") or {}).get("runtime_device") or "cpu"
                    ),
                },
            }
        finally:
            try:
                await asyncio.to_thread(
                    storage_service.delete_object,
                    storage_path,
                    bucket_name=SUPABASE_PRIVATE_BOOKS_BUCKET,
                )
            except Exception:
                pass
            if job_id is not None:
                try:
                    await self.repository.db.rollback()
                except Exception:
                    pass

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

        # Release read-only auth transaction before image processing & remote /health check.
        await self._release_db_read_txn()
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
        timeout_seconds = _resolve_scan_timeout_seconds()

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
            if is_remote_ocr_mode():
                ocr_result = await self._run_remote_ocr_scan(
                    actor_id=actor_id,
                    scan_job_id=scan_job_id,
                    clean_bytes=clean_bytes,
                    image_sha256=image_sha256,
                    book_id=book_id,
                    idempotency_key=idempotency_key,
                    timeout_seconds=timeout_seconds,
                )
            else:
                ocr_result = await asyncio.wait_for(
                    _run_local_ocr_in_executor(clean_bytes),
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
        except HTTPException:
            raise
        except ValueError as exc:
            raise HTTPException(status_code=422, detail="Image decoding failed") from exc
        except Exception as exc:
            if _is_ocr_exception(exc, "OcrNoTextDetected"):
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
            if _is_ocr_exception(exc, "OcrEngineUnavailable"):
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
        response = await self._build_scan_response(
            ocr_result=ocr_result,
            scan_job_id=scan_job_id,
            request_id=request_id,
            idempotency_key=idempotency_key,
            book_id=book_id,
            elapsed_ms=elapsed_ms,
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
            engine=response.provenance.engine,
            device=response.provenance.device,
            model_profile=response.provenance.model_profile,
            model_load_status=response.provenance.model_load_status,
            elapsed_ms=elapsed_ms,
            word_count=response.word_count,
            matched=response.matched,
            matched_book_id=str(response.matched_book_id) if response.matched_book_id else None,
        )
        return response

    async def _build_scan_response(
        self,
        *,
        ocr_result: dict[str, Any],
        scan_job_id: UUID,
        request_id: str,
        idempotency_key: UUID | None,
        book_id: UUID | None,
        elapsed_ms: int,
    ) -> LocalOcrPageScanRead:
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
            conf: float | None = None
            if isinstance(conf_raw, (int, float)) and not isinstance(conf_raw, bool):
                conf_float = float(conf_raw)
                if math.isfinite(conf_float):
                    conf = max(0.0, min(1.0, conf_float))
            parsed_words.append(
                LocalOcrWordRead(
                    word_index=_safe_nonneg_int(raw_word.get("word_index"), idx),
                    line_index=_safe_nonneg_int(raw_word.get("line_index"), 0),
                    text=surface,
                    normalized_text=normalize_word(surface),
                    bbox=_normalize_bbox(raw_word.get("bbox") or raw_word.get("bounding_box")),
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
            elapsed_ms=_safe_nonneg_int(elapsed_ms, 0),
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
                width=max(1, _safe_nonneg_int(m_page.Width, 1000)),
                height=max(1, _safe_nonneg_int(m_page.Height, 1400)),
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
                f"Đã nhận diện tiếng Việt bằng OCR và khớp Trang {m_page.PageNumber} "
                f"của sách “{m_book.Title}”."
            )
        else:
            message = (
                "Đã nhận diện văn bản tiếng Việt, nhưng trang này chưa khớp "
                "trang đã duyệt trong thư viện. Ba mẹ có thể chọn sách trong thư viện để bắt đầu đọc."
            )

        return LocalOcrPageScanRead(
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

    @staticmethod
    def _parse_optional_uuid(raw: object) -> UUID | None:
        if isinstance(raw, UUID):
            return raw
        if isinstance(raw, str) and raw.strip():
            try:
                return UUID(raw.strip())
            except ValueError:
                return None
        return None

    async def _serialize_scan_job(
        self,
        job: OcrInferenceJob,
        *,
        worker_online: bool,
        request_id: str,
        queue_position: int | None = None,
    ) -> LocalOcrPageScanJobRead:
        now_fallback = datetime.now(timezone.utc)
        created_at = job.CreatedAt or now_fallback
        updated_at = job.UpdatedAt or created_at
        proc_meta = dict(job.ProcessingMeta or {})
        effective_req_id = str(proc_meta.get("request_id") or request_id or "")
        effective_idem = self._parse_optional_uuid(proc_meta.get("idempotency_key"))
        raw_file_name = proc_meta.get("file_name")
        file_name = (
            str(raw_file_name).strip()[:180]
            if isinstance(raw_file_name, str) and raw_file_name.strip()
            else None
        )
        result_dto: LocalOcrPageScanRead | None = None
        error_code = job.ErrorCode
        error_message = job.ErrorMessage
        job_status = str(job.Status)

        if job_status == "SUCCEEDED":
            payload = dict(job.ResultPayload or {})
            if payload.get("no_text_detected") or not str(payload.get("full_text") or "").strip():
                job_status = "DEAD_LETTER"
                error_code = error_code or "NO_TEXT_DETECTED"
                error_message = (
                    error_message
                    or "No usable text was detected; check the image quality"
                )
            else:
                ocr_meta = dict(payload.get("ocr_meta") or {})
                ocr_meta.setdefault("runtime_device", str(ocr_meta.get("runtime_device") or "cpu"))
                if job.ModelProfile and not ocr_meta.get("model_profile"):
                    ocr_meta["model_profile"] = job.ModelProfile
                if job.ModelSha256 and not ocr_meta.get("checkpoint_sha256"):
                    ocr_meta["checkpoint_sha256"] = job.ModelSha256
                result_dto = await self._build_scan_response(
                    ocr_result={
                        "text": str(payload.get("full_text") or ""),
                        "words": list(payload.get("words") or []),
                        "metadata": ocr_meta,
                    },
                    scan_job_id=job.Id,
                    request_id=effective_req_id,
                    idempotency_key=effective_idem,
                    book_id=job.BookId,
                    elapsed_ms=int(job.DurationMs or 0),
                )

        return LocalOcrPageScanJobRead(
            job_id=job.Id,
            status=job_status,  # type: ignore[arg-type]
            worker_online=worker_online,
            created_at=created_at,
            updated_at=updated_at,
            file_name=file_name,
            queue_position=queue_position if job_status in ("QUEUED", "FAILED_RETRYABLE") else None,
            error_code=error_code,
            error_message=error_message,
            result=result_dto,
        )

    async def enqueue_scan_page_job(
        self,
        actor_id: UUID,
        file: UploadFile,
        *,
        request_id: str,
        book_id: UUID | None = None,
        child_id: UUID | None = None,
        idempotency_key: UUID | None = None,
        idempotency_key_raw: str | None = None,
    ) -> LocalOcrPageScanJobRead:
        """Enqueue an asynchronous page OCR job (202 Accepted) without blocking on worker availability."""
        role = await self.repository.profile_role(actor_id)
        if role != "parent":
            raise HTTPException(status_code=403, detail="Parent access required")

        if child_id is not None:
            if not await self.repository.child_belongs_to_parent(child_id, actor_id):
                raise HTTPException(status_code=404, detail="Child profile not found")

        # Release read-only auth transaction before image processing & remote /health check.
        await self._release_db_read_txn()
        clean_bytes, image_sha256 = await self._validate_and_normalize_image(file)
        width, height, _fmt = await asyncio.to_thread(
            _probe_image_dimensions_and_format, clean_bytes
        )

        effective_idem_raw = (
            str(idempotency_key)
            if idempotency_key is not None
            else (idempotency_key_raw.strip()[:120] if idempotency_key_raw and idempotency_key_raw.strip() else None)
        )
        effective_idem_uuid = idempotency_key or self._parse_optional_uuid(effective_idem_raw)
        job_idem_key = f"local_scan_job:{effective_idem_raw}" if effective_idem_raw else None

        job_service = OcrInferenceJobService(self.repository.db)
        worker_online = await job_service.has_online_worker()

        if job_idem_key is not None:
            existing = await job_service.repo.get_by_idempotency(
                JOB_KIND_LOCAL_SCAN, actor_id, job_idem_key
            )
            if existing is not None:
                if existing.ImageSha256 != image_sha256:
                    raise HTTPException(
                        status_code=409,
                        detail="Upload identity already belongs to a different image",
                    )
                return await self._serialize_scan_job(
                    existing, worker_online=worker_online, request_id=request_id
                )

        await self._release_db_read_txn()
        scan_req_id = uuid4()
        storage_path = f"local-scans/{actor_id}/{scan_req_id}.jpg"
        upload_file_name = (getattr(file, "filename", None) or "").strip()[:180] or None
        proc_meta: dict[str, Any] = {
            "request_id": request_id,
            "child_id": str(child_id) if child_id else None,
            "idempotency_key": str(effective_idem_uuid) if effective_idem_uuid else None,
            "file_name": upload_file_name,
            "temp_image_ttl_hours": 72,
        }

        if not is_remote_ocr_mode():
            # Dev/local in-process compatibility: execute and persist durable job row
            # so async polling works identically in both local and remote_worker modes.
            now = datetime.now(timezone.utc)
            started_at = time.perf_counter()
            timeout_seconds = _resolve_scan_timeout_seconds()
            try:
                ocr_result = await asyncio.wait_for(
                    _run_local_ocr_in_executor(clean_bytes),
                    timeout=timeout_seconds,
                )
                duration_ms = int((time.perf_counter() - started_at) * 1000)
                text_val = unicodedata.normalize("NFC", str(ocr_result.get("text") or "")).strip()
                words_val = list(ocr_result.get("words") or [])
                meta_val = dict(ocr_result.get("metadata") or {})
                job = OcrInferenceJob(
                    Id=scan_req_id,
                    JobKind=JOB_KIND_LOCAL_SCAN,
                    Status="SUCCEEDED" if text_val else "DEAD_LETTER",
                    Priority=PRIORITY_LOCAL_SCAN,
                    IdempotencyKey=job_idem_key,
                    OwnerUserId=actor_id,
                    BookId=book_id,
                    LocalScanRequestId=str(scan_req_id),
                    ImageBucket=SUPABASE_PRIVATE_BOOKS_BUCKET,
                    ImagePath=storage_path,
                    ImageSha256=image_sha256,
                    ImageWidth=int(width),
                    ImageHeight=int(height),
                    ImageMimeType="image/jpeg",
                    ProcessingMeta={**proc_meta, "temp_image_cleaned": True},
                    ExpectedVersion=1,
                    FencingToken=0,
                    WorkerId="local-inprocess",
                    AttemptCount=1,
                    MaxAttempts=1,
                    ResultPayload={
                        "full_text": text_val,
                        "words": words_val,
                        "ocr_meta": meta_val,
                        "no_text_detected": not bool(text_val),
                    },
                    ErrorCode=None if text_val else "NO_TEXT_DETECTED",
                    ErrorMessage=None if text_val else "No usable text was detected; check the image quality",
                    DurationMs=duration_ms,
                    CreatedAt=now,
                    UpdatedAt=now,
                    CompletedAt=now,
                )
            except Exception as exc:
                err_code = (
                    "NO_TEXT_DETECTED"
                    if _is_ocr_exception(exc, "OcrNoTextDetected")
                    else (
                        "OCR_ENGINE_UNAVAILABLE"
                        if _is_ocr_exception(exc, "OcrEngineUnavailable")
                        else "OCR_PROCESSING_FAILED"
                    )
                )
                job = OcrInferenceJob(
                    Id=scan_req_id,
                    JobKind=JOB_KIND_LOCAL_SCAN,
                    Status="DEAD_LETTER",
                    Priority=PRIORITY_LOCAL_SCAN,
                    IdempotencyKey=job_idem_key,
                    OwnerUserId=actor_id,
                    BookId=book_id,
                    LocalScanRequestId=str(scan_req_id),
                    ImageBucket=SUPABASE_PRIVATE_BOOKS_BUCKET,
                    ImagePath=storage_path,
                    ImageSha256=image_sha256,
                    ImageWidth=int(width),
                    ImageHeight=int(height),
                    ImageMimeType="image/jpeg",
                    ProcessingMeta={**proc_meta, "temp_image_cleaned": True},
                    ExpectedVersion=1,
                    FencingToken=0,
                    WorkerId="local-inprocess",
                    AttemptCount=1,
                    MaxAttempts=1,
                    ErrorCode=err_code,
                    ErrorMessage="Local OCR processing failed.",
                    CreatedAt=now,
                    UpdatedAt=now,
                    CompletedAt=now,
                )
            await job_service.repo.create_job(job)
            await self.repository.db.commit()
            return await self._serialize_scan_job(
                job, worker_online=True, request_id=request_id
            )

        await asyncio.to_thread(
            storage_service.upload_object,
            storage_path,
            clean_bytes,
            "image/jpeg",
            bucket_name=SUPABASE_PRIVATE_BOOKS_BUCKET,
        )
        try:
            job = await job_service.enqueue_job(
                job_kind=JOB_KIND_LOCAL_SCAN,
                owner_user_id=actor_id,
                book_id=book_id,
                local_scan_request_id=str(scan_req_id),
                image_bucket=SUPABASE_PRIVATE_BOOKS_BUCKET,
                image_path=storage_path,
                image_sha256=image_sha256,
                image_width=int(width),
                image_height=int(height),
                image_mime_type="image/jpeg",
                priority=PRIORITY_LOCAL_SCAN,
                idempotency_key=job_idem_key,
                processing_meta=proc_meta,
            )
            await self.repository.db.commit()
        except Exception:
            await self.repository.db.rollback()
            try:
                await asyncio.to_thread(
                    storage_service.delete_object,
                    storage_path,
                    bucket_name=SUPABASE_PRIVATE_BOOKS_BUCKET,
                )
            except Exception:
                pass
            raise

        # Clean up temp JPEG immediately on cache hit or idempotent reuse of an existing job.
        if job.Status == "SUCCEEDED" or job.ImagePath != storage_path:
            try:
                await asyncio.to_thread(
                    storage_service.delete_object,
                    storage_path,
                    bucket_name=SUPABASE_PRIVATE_BOOKS_BUCKET,
                )
            except Exception:
                pass

        queue_position: int | None = None
        if job.Status in ("QUEUED", "FAILED_RETRYABLE"):
            positions = await self._safe_queue_positions(job_service, [job.Id])
            queue_position = positions.get(job.Id)

        return await self._serialize_scan_job(
            job,
            worker_online=worker_online,
            request_id=request_id,
            queue_position=queue_position,
        )

    @staticmethod
    async def _safe_queue_positions(
        job_service: OcrInferenceJobService,
        job_ids: list[UUID],
    ) -> dict[UUID, int]:
        if not job_ids:
            return {}
        get_positions = getattr(job_service.repo, "get_queue_positions", None)
        if not callable(get_positions):
            return {}
        return await get_positions(job_ids)

    async def list_scan_page_jobs(
        self,
        actor_id: UUID,
        *,
        request_id: str,
        active_only: bool = True,
        limit: int = 10,
    ) -> LocalOcrPageScanJobListRead:
        """List authenticated parent's own queued/recent page scan OCR jobs (survives reloads)."""
        role = await self.repository.profile_role(actor_id)
        if role != "parent":
            raise HTTPException(status_code=403, detail="Parent access required")

        job_service = OcrInferenceJobService(self.repository.db)
        rows = await job_service.repo.list_local_scans_for_owner(
            actor_id,
            active_only=active_only,
            limit=limit,
        )
        queued_ids = [row.Id for row in rows if row.Status in ("QUEUED", "FAILED_RETRYABLE")]
        positions = await self._safe_queue_positions(job_service, queued_ids)
        first_queued = next(
            (row for row in rows if str(row.Status or "").upper() == "QUEUED"),
            None,
        )
        if first_queued is not None:
            from app.services.remote_ocr_wakeup import (
                maybe_nudge_ocr_wakeup_for_stale_queued_job,
            )

            maybe_nudge_ocr_wakeup_for_stale_queued_job(
                job_id=first_queued.Id,
                created_at=first_queued.CreatedAt,
                reason="local_scan_list_nudge",
            )

        serialized_jobs: list[LocalOcrPageScanJobRead] = []
        for row in rows:
            serialized_jobs.append(
                await self._serialize_scan_job(
                    row,
                    worker_online=False,
                    request_id=request_id,
                    queue_position=positions.get(row.Id),
                )
            )
        await self._release_db_read_txn()
        worker_online = await job_service.has_online_worker()
        return LocalOcrPageScanJobListRead(
            worker_online=worker_online,
            jobs=[
                item.model_copy(update={"worker_online": worker_online})
                for item in serialized_jobs
            ],
        )

    async def get_scan_page_job(
        self,
        actor_id: UUID,
        job_id: UUID,
        *,
        request_id: str,
    ) -> LocalOcrPageScanJobRead:
        role = await self.repository.profile_role(actor_id)
        if role != "parent":
            raise HTTPException(status_code=403, detail="Parent access required")

        job_service = OcrInferenceJobService(self.repository.db)
        job = await job_service.repo.get(job_id)
        if (
            job is None
            or job.JobKind != JOB_KIND_LOCAL_SCAN
            or job.OwnerUserId != actor_id
        ):
            raise HTTPException(status_code=404, detail="Scan OCR job not found")

        if str(job.Status or "").upper() == "QUEUED":
            from app.services.remote_ocr_wakeup import (
                maybe_nudge_ocr_wakeup_for_stale_queued_job,
            )

            maybe_nudge_ocr_wakeup_for_stale_queued_job(
                job_id=job.Id,
                created_at=job.CreatedAt,
                reason="local_scan_poll_nudge",
            )

        if job.Status in ("SUCCEEDED", "DEAD_LETTER", "CANCELLED"):
            await job_service._cleanup_local_scan_temp_object(job)
            try:
                await self.repository.db.commit()
            except Exception:
                await self.repository.db.rollback()
                job = await job_service.repo.get(job_id) or job

        queue_position: int | None = None
        if job.Status in ("QUEUED", "FAILED_RETRYABLE"):
            positions = await self._safe_queue_positions(job_service, [job.Id])
            queue_position = positions.get(job.Id)

        serialized = await self._serialize_scan_job(
            job,
            worker_online=False,
            request_id=request_id,
            queue_position=queue_position,
        )
        if not (
            getattr(self.repository.db, "new", None)
            or getattr(self.repository.db, "dirty", None)
            or getattr(self.repository.db, "deleted", None)
        ):
            try:
                await self.repository.db.rollback()
            except Exception:
                pass
        worker_online = await job_service.has_online_worker()
        return serialized.model_copy(update={"worker_online": worker_online})

    async def cancel_scan_page_job(
        self,
        actor_id: UUID,
        job_id: UUID,
        *,
        request_id: str,
    ) -> LocalOcrPageScanJobRead:
        role = await self.repository.profile_role(actor_id)
        if role != "parent":
            raise HTTPException(status_code=403, detail="Parent access required")

        job_service = OcrInferenceJobService(self.repository.db)
        job = await job_service.repo.get(job_id)
        if (
            job is None
            or job.JobKind != JOB_KIND_LOCAL_SCAN
            or job.OwnerUserId != actor_id
        ):
            raise HTTPException(status_code=404, detail="Scan OCR job not found")

        await job_service.cancel_job(job_id, reason="USER_CANCELLED")
        refreshed = await job_service.repo.get(job_id) or job
        serialized = await self._serialize_scan_job(
            refreshed, worker_online=False, request_id=request_id
        )
        if not (
            getattr(self.repository.db, "new", None)
            or getattr(self.repository.db, "dirty", None)
            or getattr(self.repository.db, "deleted", None)
        ):
            try:
                await self.repository.db.rollback()
            except Exception:
                pass
        worker_online = await job_service.has_online_worker()
        return serialized.model_copy(update={"worker_online": worker_online})


async def cleanup_expired_local_scan_objects(
    max_age_hours: int = 24,
    *,
    now: datetime | None = None,
    limit: int = 100,
    db: Any | None = None,
) -> int:
    """Sweep temporary `local-scans/` objects in private Storage for terminal jobs older than max_age_hours.

    Active/queued jobs (`QUEUED`, `CLAIMED`, `RUNNING`, `FAILED_RETRYABLE`) are NEVER cleaned up
    while waiting for the remote OCR worker (even when the laptop worker is turned off for 24-72+ hours).
    """
    from sqlalchemy import select
    from app.database.session import AsyncSessionLocal

    current = now or datetime.now(timezone.utc)
    cutoff = current - timedelta(hours=max(1, int(max_age_hours)))
    cleaned = 0

    async def _sweep(session: Any) -> int:
        nonlocal cleaned
        query = (
            select(OcrInferenceJob)
            .where(
                OcrInferenceJob.JobKind == JOB_KIND_LOCAL_SCAN,
                OcrInferenceJob.Status.in_(("SUCCEEDED", "DEAD_LETTER", "CANCELLED")),
                OcrInferenceJob.CreatedAt <= cutoff,
            )
            .order_by(OcrInferenceJob.CreatedAt.asc())
            .limit(max(1, min(int(limit), 500)))
        )
        rows = list((await session.scalars(query)).all())
        job_svc = OcrInferenceJobService(session)
        changed = False
        for row in rows:
            image_path = str(getattr(row, "ImagePath", "") or "")
            meta = dict(getattr(row, "ProcessingMeta", None) or {})
            if not image_path.startswith("local-scans/") or meta.get("temp_image_cleaned"):
                continue
            await job_svc._cleanup_local_scan_temp_object(row)
            if (getattr(row, "ProcessingMeta", None) or {}).get("temp_image_cleaned"):
                cleaned += 1
                changed = True
        if changed:
            await session.commit()
        return cleaned

    if db is not None:
        return await _sweep(db)
    async with AsyncSessionLocal() as session:
        return await _sweep(session)
