from __future__ import annotations

import hashlib
import json
import logging
import math
import os
import re
import time
import urllib.error
import urllib.request
from datetime import datetime, timezone
from io import BytesIO
from uuid import UUID, uuid4

from fastapi import HTTPException, UploadFile, status
from PIL import Image, ImageOps, UnidentifiedImageError
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession
from starlette.concurrency import run_in_threadpool

from app.diagnostic_logging import log_diagnostic
from app.models import Book, BookPage, PageRevision
from app.repositories.admin_ocr_repository import AdminOcrRepository
from app.schemas.admin_ocr import AdminOcrDraftRequest, AdminOcrVerifyRequest
from app.schemas.book import AdminPageLifecycleRead, AdminRevisionDetailRead
from app.services.ocr_engine import (
    OcrEngineUnavailable, OcrNoTextDetected, extract_text_and_boxes, normalize_text_tokens, normalize_word,
)
from app.services.storage_service import create_signed_image_url, delete_object, download_object, upload_object

logger = logging.getLogger(__name__)

MAX_IMAGE_BYTES = 12 * 1024 * 1024
MAX_IMAGE_DIMENSION = 6000
ALLOWED_FORMATS = {
    "JPEG": ("image/jpeg", "jpg"),
    "PNG": ("image/png", "png"),
    "WEBP": ("image/webp", "webp"),
}


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
        if width <= 0 or height <= 0 or width > MAX_IMAGE_DIMENSION or height > MAX_IMAGE_DIMENSION:
            raise HTTPException(status_code=413, detail="Image dimensions must not exceed 6000 by 6000 pixels")
        if not data or len(data) > MAX_IMAGE_BYTES:
            raise HTTPException(status_code=413, detail="Normalized image exceeds the 12 MB limit")
        return data, actual[0], actual[1], width, height

    @staticmethod
    def _normalize_confidence(value: object) -> float | None:
        if value is None:
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
            text_value = str(item["text"]).strip()
            norm = normalize_word(text_value)
            if not norm:
                continue
            bbox = item["bbox"]
            if not isinstance(bbox, (list, tuple)) or len(bbox) != 4:
                raise HTTPException(status_code=422, detail="OCR engine returned an invalid bounding box")
            x, y, width, height = (float(value) for value in bbox)
            if (any(value < 0 or value > 1 for value in (x, y, width, height))
                or width <= 0 or height <= 0 or x + width > 1.000001 or y + height > 1.000001):
                raise HTTPException(status_code=422, detail="OCR engine returned a bounding box outside the image")
            confidence = AdminOcrService._normalize_confidence(
                item.get("ocr_confidence")
            )
            normalized.append({
                "word_index": len(normalized),
                "line_index": max(0, int(item["line_index"])),
                "text": text_value,
                "normalized_text": norm,
                "bbox": [x, y, width, height],
                "ocr_confidence": confidence,
            })
        if not normalized:
            raise HTTPException(status_code=422, detail="OCR did not produce any valid word")
        return normalized

    async def _renumber_active_pages(self, book_id: UUID, *, lock: bool = True) -> bool:
        active_pages = await self.repo.active_pages_for_renumber(book_id, lock=lock)
        changed = False
        for expected_number, page in enumerate(active_pages, start=1):
            if page.PageNumber != expected_number:
                self.repo.set_page_number(page, expected_number)
                await self.repo.flush()
                changed = True
        return changed

    async def upload_page(
        self, actor_id: UUID, book_id: UUID, file: UploadFile
    ) -> AdminRevisionDetailRead:
        started_at = time.perf_counter()
        await self.require_admin(actor_id)

        book = await self.repo.book(book_id, lock=True)
        if book is None:
            raise HTTPException(status_code=404, detail="Book not found")
        if book.LifecycleStatus != "ACTIVE":
            raise HTTPException(status_code=409, detail="Cannot upload pages to a retired book")
        await self._renumber_active_pages(book_id, lock=True)
        page_number = await self.repo.next_active_page_number(book_id)
        if page_number > 32767:
            await self.db.rollback()
            raise HTTPException(status_code=422, detail="The book has reached the maximum number of pages")

        data, content_type, extension, width, height = await self._read_validate_image(file)

        page_id = uuid4()
        revision_id = uuid4()
        object_path = f"books/{book_id}/pages/{page_id}/{uuid4().hex}.{extension}"

        try:
            await run_in_threadpool(upload_object, object_path, data, content_type)
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

        storage_uploaded = True
        try:
            ocr = await run_in_threadpool(extract_text_and_boxes, data)
            words = self._word_data(ocr["words"])
            text_value = str(ocr["text"]).strip()
            if not text_value:
                raise HTTPException(status_code=422, detail="OCR produced empty text")
            metadata = dict(ocr["metadata"])
            content_hash = hashlib.sha256(
                json.dumps(
                    {"text": text_value, "words": words},
                    ensure_ascii=False,
                    sort_keys=True,
                ).encode("utf-8")
            ).hexdigest()
        except OcrEngineUnavailable as exc:
            await self._cleanup_uploaded_object(
                object_path,
                object_may_exist=storage_uploaded,
                book_id=book_id,
                page_id=page_id,
                started_at=started_at,
            )
            raise HTTPException(status_code=503, detail=str(exc)) from exc
        except OcrNoTextDetected as exc:
            await self._cleanup_uploaded_object(
                object_path,
                object_may_exist=storage_uploaded,
                book_id=book_id,
                page_id=page_id,
                started_at=started_at,
            )
            raise HTTPException(
                status_code=422,
                detail="No usable text was detected; check the image quality",
            ) from exc
        except ValueError as exc:
            await self._cleanup_uploaded_object(
                object_path,
                object_may_exist=storage_uploaded,
                book_id=book_id,
                page_id=page_id,
                started_at=started_at,
            )
            raise HTTPException(
                status_code=422,
                detail="The image could not be decoded by the OCR engine",
            ) from exc
        except Exception:
            await self._cleanup_uploaded_object(
                object_path,
                object_may_exist=storage_uploaded,
                book_id=book_id,
                page_id=page_id,
                started_at=started_at,
            )
            raise

        page = BookPage(
            Id=page_id, BookId=book_id, PageNumber=page_number, ImagePath=object_path,
            Width=width, Height=height, LifecycleStatus="ACTIVE", FeaturePath=None,
            ProcessingMeta={"storage": "supabase"},
        )
        revision = PageRevision(
            Id=revision_id, PageId=page_id, RevisionNo="1", VerificationStatus="NEEDS_REVIEW",
            VerifiedText=None, DraftText=text_value, ContentHash=content_hash, ProcessingMeta=metadata,
        )
        self.repo.stage_page_revision_bundle(page, revision, words)
        try:
            await self.repo.flush()
            await self.db.refresh(page)
            await self.db.refresh(revision)
            result = await self.revision_detail(page, revision)
            await self.db.commit()
        except IntegrityError as exc:
            await self.db.rollback()
            await self._cleanup_uploaded_object(
                object_path,
                object_may_exist=storage_uploaded,
                book_id=book_id,
                page_id=page_id,
                started_at=started_at,
            )
            raise HTTPException(status_code=409, detail="Page number conflicts with an existing page") from exc
        except Exception:
            await self.db.rollback()
            await self._cleanup_uploaded_object(
                object_path,
                object_may_exist=storage_uploaded,
                book_id=book_id,
                page_id=page_id,
                started_at=started_at,
            )
            raise

        return result

    async def replace_page_image(
        self, actor_id: UUID, page_id: UUID, file: UploadFile
    ) -> AdminRevisionDetailRead:
        started_at = time.perf_counter()
        await self.require_admin(actor_id)
        page = await self.repo.page(page_id, lock=True)
        if page is None:
            raise HTTPException(status_code=404, detail="Page not found")
        if page.LifecycleStatus != "ACTIVE":
            raise HTTPException(status_code=409, detail="Cannot replace the image of a retired page")

        data, content_type, extension, width, height = await self._read_validate_image(file)
        object_path = f"books/{page.BookId}/pages/{page.Id}/{uuid4().hex}.{extension}"
        storage_uploaded = False
        try:
            await run_in_threadpool(upload_object, object_path, data, content_type)
            storage_uploaded = True
        except Exception as exc:
            if bool(getattr(exc, "cleanup_may_be_needed", False)):
                await self._cleanup_uploaded_object(
                    object_path, object_may_exist=True, book_id=page.BookId,
                    page_id=page.Id, started_at=started_at,
                )
            raise

        try:
            ocr = await run_in_threadpool(extract_text_and_boxes, data)
            words = self._word_data(ocr["words"])
            text_value = str(ocr["text"]).strip()
            if not text_value:
                raise HTTPException(status_code=422, detail="OCR produced empty text")
        except OcrEngineUnavailable as exc:
            await self._cleanup_uploaded_object(
                object_path, object_may_exist=storage_uploaded, book_id=page.BookId,
                page_id=page.Id, started_at=started_at,
            )
            await self.db.rollback()
            raise HTTPException(status_code=503, detail=str(exc)) from exc
        except OcrNoTextDetected as exc:
            await self._cleanup_uploaded_object(
                object_path, object_may_exist=storage_uploaded, book_id=page.BookId,
                page_id=page.Id, started_at=started_at,
            )
            await self.db.rollback()
            raise HTTPException(status_code=422, detail="No usable text was detected; check the replacement image") from exc
        except HTTPException:
            await self._cleanup_uploaded_object(
                object_path, object_may_exist=storage_uploaded, book_id=page.BookId,
                page_id=page.Id, started_at=started_at,
            )
            await self.db.rollback()
            raise
        except ValueError as exc:
            await self._cleanup_uploaded_object(
                object_path, object_may_exist=storage_uploaded, book_id=page.BookId,
                page_id=page.Id, started_at=started_at,
            )
            await self.db.rollback()
            raise HTTPException(status_code=422, detail="Replacement image could not be decoded by OCR") from exc
        except Exception as exc:
            await self._cleanup_uploaded_object(
                object_path, object_may_exist=storage_uploaded, book_id=page.BookId,
                page_id=page.Id, started_at=started_at,
            )
            await self.db.rollback()
            raise HTTPException(status_code=503, detail="Replacement OCR processing failed; check local OCR configuration") from exc

        try:
            next_number = await self.repo.next_revision_number(page.Id)
        except ValueError as exc:
            await self.db.rollback()
            await self._cleanup_uploaded_object(
                object_path, object_may_exist=storage_uploaded, book_id=page.BookId,
                page_id=page.Id, started_at=started_at,
            )
            raise HTTPException(status_code=409, detail="Existing revision numbering requires manual review") from exc

        processing_meta = dict(ocr["metadata"])
        processing_meta.update({
            "source_image_path": object_path,
            "source_image_width": width,
            "source_image_height": height,
            "previous_image_path": page.ImagePath,
            "previous_image_width": page.Width,
            "previous_image_height": page.Height,
        })
        try:
            if page.CurrentVerifiedRevisionId is not None:
                current_verified = await self.repo.revision(
                    page.Id, page.CurrentVerifiedRevisionId, lock=True
                )
                if current_verified is not None:
                    current_metadata = dict(current_verified.ProcessingMeta or {})
                    current_metadata.setdefault("source_image_path", page.ImagePath)
                    current_metadata.setdefault("source_image_width", page.Width)
                    current_metadata.setdefault("source_image_height", page.Height)
                    current_verified.ProcessingMeta = current_metadata

            content_hash = hashlib.sha256(
                json.dumps(
                    {"text": text_value, "words": words},
                    ensure_ascii=False,
                    sort_keys=True,
                ).encode("utf-8")
            ).hexdigest()
            revision = PageRevision(
                Id=uuid4(), PageId=page.Id, RevisionNo=str(next_number),
                VerificationStatus="NEEDS_REVIEW", VerifiedText=None,
                DraftText=text_value, ContentHash=content_hash, ProcessingMeta=processing_meta,
            )
            self.repo.stage_revision_bundle(revision, words)
            await self.repo.flush()
            await self.db.refresh(revision)
            await self.db.refresh(page)
            result = await self.revision_detail(page, revision)
            await self.db.commit()
        except IntegrityError as exc:
            await self.db.rollback()
            await self._cleanup_uploaded_object(
                object_path, object_may_exist=storage_uploaded, book_id=page.BookId,
                page_id=page.Id, started_at=started_at,
            )
            raise HTTPException(status_code=409, detail="A concurrent OCR revision was created; retry") from exc
        except Exception:
            await self.db.rollback()
            await self._cleanup_uploaded_object(
                object_path, object_may_exist=storage_uploaded, book_id=page.BookId,
                page_id=page.Id, started_at=started_at,
            )
            raise

        return result

    async def revision_detail(self, page: BookPage, revision: PageRevision) -> AdminRevisionDetailRead:
        rows = await self.repo.words(revision.Id)
        words = []
        for row in rows:
            box = row.BoundingBox
            if isinstance(box, dict):
                box = [box.get("x"), box.get("y"), box.get("width"), box.get("height")]
            if not isinstance(box, list) or len(box) != 4:
                raise HTTPException(status_code=409, detail="Stored bounding box does not match the OCR contract")
            words.append({
                "word_index": row.WordIndex, "line_index": row.LineIndex, "text": row.Text,
                "normalized_text": row.NormalizedText,
                "bbox": tuple(box),
                "ocr_confidence": self._normalize_confidence(row.OCRConfidence),
            })
        raw_revision = str(revision.RevisionNo)
        if not raw_revision.isascii() or not raw_revision.isdecimal() or int(raw_revision) < 1:
            raise HTTPException(status_code=409, detail="Stored revision number is not a positive numeric string")
        metadata = dict(revision.ProcessingMeta or {})
        for internal_key in (
            "source_image_path",
            "source_image_width",
            "source_image_height",
            "previous_image_path",
            "previous_image_width",
            "previous_image_height",
        ):
            metadata.pop(internal_key, None)
        return AdminRevisionDetailRead(
            page_id=page.Id, page_revision_id=revision.Id, revision_no=int(raw_revision),
            verification_status=revision.VerificationStatus, lifecycle_status=page.LifecycleStatus,
            draft_text=revision.DraftText if revision.DraftText is not None else revision.VerifiedText,
            words=words, ocr_metadata=metadata, created_at=revision.CreatedAt,
            verified_at=revision.VerifiedAt, verified_by=revision.VerifiedBy,
        )

    def _validated_words(self, words) -> list[dict[str, object]]:
        raw = [item.model_dump() for item in words]
        for expected_index, item in enumerate(raw):
            if item["word_index"] != expected_index:
                raise HTTPException(status_code=422, detail="word_index values must be contiguous and start at zero")
            item["text"] = str(item["text"]).strip()
            item["normalized_text"] = normalize_word(item["text"])
            if not item["normalized_text"]:
                raise HTTPException(status_code=422, detail="Word text cannot be empty")
            item["bbox"] = list(item["bbox"])
        return raw

    async def create_edit_draft(self, actor_id: UUID, page_id: UUID) -> AdminRevisionDetailRead:
        await self.require_admin(actor_id)
        page = await self.repo.page(page_id, lock=True)
        if page is None:
            raise HTTPException(status_code=404, detail="Page not found")
        if page.LifecycleStatus != "ACTIVE":
            raise HTTPException(status_code=409, detail="Cannot edit a retired page")
        if page.CurrentVerifiedRevisionId is None:
            raise HTTPException(status_code=409, detail="Page has no current verified revision")

        source = await self.repo.revision(page_id, page.CurrentVerifiedRevisionId, lock=True)
        if source is None or source.VerificationStatus != "VERIFIED" or not (source.VerifiedText or "").strip():
            raise HTTPException(status_code=409, detail="Current verified revision is not available")
        source_words = await self.repo.words(source.Id)
        if not source_words:
            raise HTTPException(status_code=409, detail="Current verified revision has no editable word data")

        candidates = []
        for row in source_words:
            bbox = row.BoundingBox
            if isinstance(bbox, dict):
                bbox = [bbox.get("x"), bbox.get("y"), bbox.get("width"), bbox.get("height")]
            if not isinstance(bbox, (list, tuple)) or len(bbox) != 4:
                raise HTTPException(status_code=409, detail="Stored word coordinates cannot be copied safely")
            candidates.append({
                "text": row.Text,
                "line_index": row.LineIndex,
                "bbox": bbox,
                "ocr_confidence": row.OCRConfidence,
            })
        words = self._word_data(candidates)
        text_value = source.VerifiedText.strip()
        if normalize_text_tokens(text_value) != [str(item["normalized_text"]) for item in words]:
            raise HTTPException(status_code=409, detail="Current verified text and word data are inconsistent")

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
            ProcessingMeta={"source_revision_id": str(source.Id), "creation_reason": "manual_edit"},
        )
        self.repo.stage_revision_bundle(revision, words)
        try:
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
        draft_text = payload.draft_text.strip()
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
        corrected_text = payload.corrected_text.strip()
        if not corrected_text:
            raise HTTPException(status_code=422, detail="Verified text must not be blank")
        words = self._validated_words(payload.words)
        text_tokens = normalize_text_tokens(corrected_text)
        word_tokens = [str(item["normalized_text"]) for item in words]
        if text_tokens != word_tokens:
            raise HTTPException(status_code=422, detail="Corrected text must match the ordered word list; edit the word entries before verifying")
        content_hash = hashlib.sha256(
            json.dumps({"text": corrected_text, "words": words}, ensure_ascii=False, sort_keys=True).encode("utf-8")
        ).hexdigest()
        try:
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
            raise HTTPException(status_code=404, detail="Page not found")
        if page.LifecycleStatus != "ACTIVE":
            raise HTTPException(status_code=409, detail="Cannot reprocess a retired page")
        latest_revisions = await self.repo.revisions(page.Id)
        latest_metadata = dict(latest_revisions[0].ProcessingMeta or {}) if latest_revisions else {}
        candidate_path = latest_metadata.get("source_image_path")
        source_image_path = candidate_path if isinstance(candidate_path, str) and candidate_path else page.ImagePath
        try:
            image_bytes = await run_in_threadpool(download_object, source_image_path)
            ocr = await run_in_threadpool(extract_text_and_boxes, image_bytes)
        except OcrEngineUnavailable as exc:
            await self.db.rollback()
            raise HTTPException(status_code=503, detail=str(exc)) from exc
        except OcrNoTextDetected as exc:
            await self.db.rollback()
            raise HTTPException(status_code=422, detail="No usable text was detected during reprocessing") from exc
        except ValueError as exc:
            await self.db.rollback()
            raise HTTPException(status_code=422, detail="Stored image could not be decoded") from exc
        words = self._word_data(ocr["words"])
        text_value = str(ocr["text"]).strip()
        try:
            next_number = await self.repo.next_revision_number(page.Id)
        except ValueError as exc:
            await self.db.rollback()
            raise HTTPException(status_code=409, detail="Existing revision numbering requires manual review") from exc
        revision_id = uuid4()
        content_hash = hashlib.sha256(
            json.dumps({"text": text_value, "words": words}, ensure_ascii=False, sort_keys=True).encode("utf-8")
        ).hexdigest()
        processing_meta = dict(ocr["metadata"])
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
        revision = PageRevision(
            Id=revision_id, PageId=page.Id, RevisionNo=str(next_number), VerificationStatus="NEEDS_REVIEW",
            VerifiedText=None, DraftText=text_value, ContentHash=content_hash, ProcessingMeta=processing_meta,
        )
        self.repo.stage_revision_bundle(revision, words)
        try:
            await self.db.commit()
            await self.db.refresh(revision)
            await self.db.refresh(page)
        except IntegrityError as exc:
            await self.db.rollback()
            raise HTTPException(status_code=409, detail="A concurrent reprocess created this revision number; retry") from exc
        except Exception:
            await self.db.rollback()
            raise
        return await self.revision_detail(page, revision)

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
        self, actor_id: UUID, page_id: UUID, draft_text: str
    ) -> dict[str, object]:
        """Dùng Gemini từ Google AI Studio sửa lỗi chính tả và dấu theo ngữ cảnh."""
        await self.require_admin(actor_id)
        page = await self.repo.page(page_id, lock=False)
        if page is None:
            raise HTTPException(status_code=404, detail="Page not found")

        gemini_api_key = os.getenv("GEMINI_API_KEY")
        if not gemini_api_key:
            raise HTTPException(
                status_code=500,
                detail="Chưa cấu hình GEMINI_API_KEY trong file .env của backend",
            )

        # Lấy tên model linh hoạt từ file .env (nếu không set sẽ mặc định là gemini-2.5-flash)
        gemini_model = os.getenv("GEMINI_MODEL", "gemini-2.5-flash")

        system_instruction = (
            "Bạn là chuyên gia hiệu đính văn bản tiếng Việt cho sách thiếu nhi và giáo dục. "
            "Nhiệm vụ của bạn là rà soát văn bản được quét OCR, sửa toàn bộ các lỗi sai chính tả, "
            "lỗi sai dấu thanh (huyền, sắc, hỏi, ngã, nặng) hoặc nhầm ký tự theo đúng ngữ cảnh tiếng Việt. "
            "YÊU CẦU: "
            "1. Tuyệt đối giữ nguyên thứ tự câu từ và cấu trúc ngữ nghĩa gốc của bài. "
            "2. Không tự ý thêm bớt từ ngữ hoặc câu văn mới để bảo toàn khớp nối với bounding box ảnh. "
            "3. Chỉ trả về duy nhất văn bản tiếng Việt đã được sửa, không kèm lời giải thích hay định dạng markdown."
        )

        prompt = f"Hãy sửa lỗi chính tả và dấu thanh cho văn bản OCR sau:\n\n{draft_text}"

        def _call_gemini() -> str:
            endpoint = f"https://generativelanguage.googleapis.com/v1beta/models/{gemini_model}:generateContent?key={gemini_api_key}"
            payload = {
                "contents": [{"parts": [{"text": prompt}]}],
                "systemInstruction": {"parts": [{"text": system_instruction}]},
                "generationConfig": {"temperature": 0.1},
            }
            req = urllib.request.Request(
                endpoint,
                data=json.dumps(payload).encode("utf-8"),
                headers={"Content-Type": "application/json"},
                method="POST",
            )
            try:
                with urllib.request.urlopen(req, timeout=30) as resp:
                    data = json.loads(resp.read().decode("utf-8"))
                    candidates = data.get("candidates", [])
                    if not candidates:
                        raise HTTPException(status_code=502, detail="Gemini không phản hồi kết quả.")
                    return candidates[0]["content"]["parts"][0]["text"].strip()
            except urllib.error.HTTPError as err:
                raise HTTPException(
                    status_code=502, detail=f"Lỗi kết nối Google AI Studio: {err.reason}"
                ) from err

        corrected_text = await run_in_threadpool(_call_gemini)
        return {"corrected_text": corrected_text}

    async def ai_generate_questions(
        self, actor_id: UUID, page_id: UUID, content_text: str, count: int = 10
    ) -> dict[str, object]:
        """Dùng Gemini tạo bộ câu hỏi đọc hiểu cho trẻ em dựa trên nội dung trang."""
        await self.require_admin(actor_id)
        page = await self.repo.page(page_id, lock=False)
        if page is None:
            raise HTTPException(status_code=404, detail="Page not found")

        gemini_api_key = os.getenv("GEMINI_API_KEY")
        if not gemini_api_key:
            raise HTTPException(
                status_code=500,
                detail="Chưa cấu hình GEMINI_API_KEY trong file .env của backend",
            )

        # Lấy tên model linh hoạt từ file .env (nếu không set sẽ mặc định là gemini-2.5-flash)
        gemini_model = os.getenv("GEMINI_MODEL", "gemini-2.5-flash")

        prompt = (
            f"Dựa vào nội dung bài đọc dưới đây, hãy tạo đúng {count} câu hỏi trắc nghiệm đọc hiểu "
            f"dành cho học sinh thiếu nhi để kiểm tra mức độ hiểu bài:\n\n{content_text}\n\n"
            "YÊU CẦU ĐỊNH DẠNG TRẢ VỀ: Chỉ trả về một chuỗi JSON thuần túy (JSON array hợp lệ), "
            "không sử dụng code block ```json hay bất kỳ văn bản nào khác. "
            "Mỗi phần tử có cấu trúc:\n"
            "[\n"
            "  {\n"
            '    "question": "Nội dung câu hỏi dành cho trẻ?",\n'
            '    "options": ["A. Lựa chọn 1", "B. Lựa chọn 2", "C. Lựa chọn 3", "D. Lựa chọn 4"],\n'
            '    "correct_answer": "A",\n'
            '    "explanation": "Giải thích ngắn gọn, dễ hiểu vì sao đúng"\n'
            "  }\n"
            "]"
        )

        def _call_gemini_questions() -> list[dict[str, object]]:
            endpoint = f"[https://generativelanguage.googleapis.com/v1beta/models/](https://generativelanguage.googleapis.com/v1beta/models/){gemini_model}:generateContent?key={gemini_api_key}"
            payload = {
                "contents": [{"parts": [{"text": prompt}]}],
                "generationConfig": {"temperature": 0.3},
            }
            req = urllib.request.Request(
                endpoint,
                data=json.dumps(payload).encode("utf-8"),
                headers={"Content-Type": "application/json"},
                method="POST",
            )
            try:
                with urllib.request.urlopen(req, timeout=45) as resp:
                    data = json.loads(resp.read().decode("utf-8"))
                    candidates = data.get("candidates", [])
                    if not candidates:
                        raise HTTPException(status_code=502, detail="Gemini không phản hồi.")
                    raw_content = candidates[0]["content"]["parts"][0]["text"].strip()
                    if raw_content.startswith("```"):
                        raw_content = re.sub(r"^```[a-zA-Z]*\n?", "", raw_content)
                        raw_content = re.sub(r"\n?```$", "", raw_content).strip()
                    return json.loads(raw_content)
            except Exception as err:
                raise HTTPException(
                    status_code=502, detail=f"Không thể tạo câu hỏi từ Gemini: {err}"
                ) from err

        questions = await run_in_threadpool(_call_gemini_questions)
        return {"questions": questions}

    async def image_url(self, page: BookPage) -> str:
        return create_signed_image_url(page.ImagePath)