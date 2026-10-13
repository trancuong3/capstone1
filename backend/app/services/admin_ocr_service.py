from __future__ import annotations

import hashlib
import json
from datetime import datetime, timezone
from io import BytesIO
from uuid import UUID, uuid4

from fastapi import HTTPException, UploadFile, status
from PIL import Image, UnidentifiedImageError
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.models import Book, BookPage, PageRevision, PageRevisionWord
from app.repositories.admin_ocr_repository import AdminOcrRepository
from app.schemas.admin_ocr import AdminBookCreateRequest, AdminOcrDraftRequest, AdminOcrVerifyRequest
from app.schemas.book import AdminRevisionDetailRead, CatalogBookResponse
from app.services.ocr_engine import (
    OcrEngineUnavailable, OcrNoTextDetected, extract_text_and_boxes, normalize_text_tokens, normalize_word,
)
from app.services.storage_service import create_signed_image_url, delete_object, download_object, upload_object

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

    async def require_admin(self, actor_id: UUID) -> None:
        if await self.repo.role(actor_id) != "admin":
            # Safe even when auth.users.id is not mapped to profiles.id; fail closed.
            raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Admin access required")

    async def create_book(self, actor_id: UUID, payload: AdminBookCreateRequest) -> CatalogBookResponse:
        await self.require_admin(actor_id)
        row = Book(
            Title=payload.title.strip(),
            Author=payload.author,
            MinGrade=payload.min_grade,
            MaxGrade=payload.max_grade,
            LifecycleStatus="ACTIVE",
            CreatedBy=actor_id,
        )
        self.db.add(row)
        try:
            await self.db.commit()
            await self.db.refresh(row)
        except IntegrityError as exc:
            await self.db.rollback()
            raise HTTPException(status_code=409, detail="Could not create book with the current database constraints") from exc
        except Exception:
            await self.db.rollback()
            raise
        return CatalogBookResponse.model_validate(row)

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
                width, height = image.size
        except (UnidentifiedImageError, OSError, ValueError, Image.DecompressionBombError) as exc:
            raise HTTPException(status_code=422, detail="The uploaded file is not a valid image") from exc
        actual = ALLOWED_FORMATS.get(image_format)
        if actual is None or actual[0] != declared_type:
            raise HTTPException(status_code=415, detail="File content does not match the declared image type")
        if width <= 0 or height <= 0 or width > MAX_IMAGE_DIMENSION or height > MAX_IMAGE_DIMENSION:
            raise HTTPException(status_code=413, detail="Image dimensions must not exceed 6000 by 6000 pixels")
        return data, actual[0], actual[1], width, height

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
            confidence = item.get("ocr_confidence")
            if confidence is not None:
                confidence = float(confidence)
                if not 0 <= confidence <= 1:
                    confidence = None
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

    async def upload_page(self, actor_id: UUID, book_id: UUID, page_number: int, file: UploadFile) -> AdminRevisionDetailRead:
        await self.require_admin(actor_id)
        book = await self.repo.book(book_id)
        if book is None:
            raise HTTPException(status_code=404, detail="Book not found")
        if book.LifecycleStatus != "ACTIVE":
            raise HTTPException(status_code=409, detail="Cannot upload pages to a retired book")
        if page_number < 1 or page_number > 32767:
            raise HTTPException(status_code=422, detail="page_number is out of range")
        if await self.repo.page_number_exists(book_id, page_number):
            raise HTTPException(status_code=409, detail="This page number already exists for the book")

        data, content_type, extension, width, height = await self._read_validate_image(file)
        try:
            ocr = extract_text_and_boxes(data)
        except OcrEngineUnavailable as exc:
            raise HTTPException(status_code=503, detail=str(exc)) from exc
        except OcrNoTextDetected as exc:
            raise HTTPException(status_code=422, detail="No usable text was detected; check the image quality") from exc
        except ValueError as exc:
            raise HTTPException(status_code=422, detail="The image could not be decoded by the OCR engine") from exc

        words = self._word_data(ocr["words"])  # real TSV boxes only
        text_value = str(ocr["text"]).strip()
        if not text_value:
            raise HTTPException(status_code=422, detail="OCR produced empty text")
        page_id = uuid4()
        revision_id = uuid4()
        object_path = f"books/{book_id}/pages/{page_id}/{uuid4().hex}.{extension}"
        metadata = dict(ocr["metadata"])
        content_hash = hashlib.sha256(
            json.dumps({"text": text_value, "words": words}, ensure_ascii=False, sort_keys=True).encode("utf-8")
        ).hexdigest()

        upload_object(object_path, data, content_type)
        page = BookPage(
            Id=page_id, BookId=book_id, PageNumber=page_number, ImagePath=object_path,
            Width=width, Height=height, LifecycleStatus="ACTIVE", FeaturePath=None,
            ProcessingMeta={"storage": "supabase"},
        )
        revision = PageRevision(
            Id=revision_id, PageId=page_id, RevisionNo="1", VerificationStatus="NEEDS_REVIEW",
            VerifiedText=None, DraftText=text_value, ContentHash=content_hash, ProcessingMeta=metadata,
        )
        self.db.add_all([page, revision])
        for word in words:
            self.db.add(PageRevisionWord(
                PageRevisionId=revision_id, WordIndex=word["word_index"], LineIndex=word["line_index"],
                Text=word["text"], NormalizedText=word["normalized_text"], BoundingBox=word["bbox"],
                OCRConfidence=word["ocr_confidence"],
            ))
        try:
            await self.db.commit()
            await self.db.refresh(page)
            await self.db.refresh(revision)
        except IntegrityError as exc:
            await self.db.rollback()
            delete_object(object_path)
            raise HTTPException(status_code=409, detail="Page number conflicts with an existing page") from exc
        except Exception:
            await self.db.rollback()
            delete_object(object_path)
            raise
        return await self.revision_detail(page, revision)

    async def revision_detail(self, page: BookPage, revision: PageRevision) -> AdminRevisionDetailRead:
        rows = await self.repo.words(revision.Id)
        words = []
        for row in rows:
            box = row.BoundingBox
            if isinstance(box, dict):  # Read legacy records; never write this shape again.
                box = [box.get("x"), box.get("y"), box.get("width"), box.get("height")]
            if not isinstance(box, list) or len(box) != 4:
                raise HTTPException(status_code=409, detail="Stored bounding box does not match the OCR contract")
            words.append({
                "word_index": row.WordIndex, "line_index": row.LineIndex, "text": row.Text,
                "normalized_text": row.NormalizedText, "bbox": tuple(box), "ocr_confidence": row.OCRConfidence,
            })
        raw_revision = str(revision.RevisionNo)
        if not raw_revision.isascii() or not raw_revision.isdecimal() or int(raw_revision) < 1:
            raise HTTPException(status_code=409, detail="Stored revision number is not a positive numeric string")
        return AdminRevisionDetailRead(
            page_id=page.Id, page_revision_id=revision.Id, revision_no=int(raw_revision),
            verification_status=revision.VerificationStatus, lifecycle_status=page.LifecycleStatus,
            draft_text=revision.DraftText if revision.DraftText is not None else revision.VerifiedText,
            words=words, ocr_metadata=revision.ProcessingMeta or {}, created_at=revision.CreatedAt,
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

    async def save_draft(self, actor_id: UUID, page_id: UUID, revision_id: UUID, payload: AdminOcrDraftRequest) -> AdminRevisionDetailRead:
        await self.require_admin(actor_id)
        page = await self.repo.page(page_id, lock=True)
        if page is None:
            raise HTTPException(status_code=404, detail="Page not found")
        revision = await self.repo.revision(page_id, revision_id, lock=True)
        if revision is None:
            raise HTTPException(status_code=404, detail="Revision not found for this page")
        if revision.VerificationStatus != "NEEDS_REVIEW":
            raise HTTPException(status_code=409, detail="Only a revision awaiting review can be edited")
        if not payload.draft_text.strip():
            raise HTTPException(status_code=422, detail="Draft text must not be blank")
        words = self._validated_words(payload.words)
        await self.repo.sync_words(revision.Id, words)
        revision.DraftText = payload.draft_text.strip()
        revision.ContentHash = hashlib.sha256(
            json.dumps({"text": revision.DraftText, "words": words}, ensure_ascii=False, sort_keys=True).encode("utf-8")
        ).hexdigest()
        try:
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
        await self.repo.sync_words(revision.Id, words)
        revision.DraftText = corrected_text
        revision.VerifiedText = corrected_text
        revision.VerificationStatus = "VERIFIED"
        revision.VerifiedAt = datetime.now(timezone.utc)
        revision.VerifiedBy = actor_id
        revision.ContentHash = hashlib.sha256(
            json.dumps({"text": corrected_text, "words": words}, ensure_ascii=False, sort_keys=True).encode("utf-8")
        ).hexdigest()
        if page.LifecycleStatus == "ACTIVE":
            page.CurrentVerifiedRevisionId = revision.Id
        try:
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
        try:
            image_bytes = download_object(page.ImagePath)
            ocr = extract_text_and_boxes(image_bytes)
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
        revision = PageRevision(
            Id=revision_id, PageId=page.Id, RevisionNo=str(next_number), VerificationStatus="NEEDS_REVIEW",
            VerifiedText=None, DraftText=text_value, ContentHash=content_hash, ProcessingMeta=dict(ocr["metadata"]),
        )
        self.db.add(revision)
        for word in words:
            self.db.add(PageRevisionWord(
                PageRevisionId=revision_id, WordIndex=word["word_index"], LineIndex=word["line_index"],
                Text=word["text"], NormalizedText=word["normalized_text"], BoundingBox=word["bbox"],
                OCRConfidence=word["ocr_confidence"],
            ))
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
        # The current verified pointer and all historical session/event references remain untouched.
        return await self.revision_detail(page, revision)

    async def image_url(self, page: BookPage) -> str:
        return create_signed_image_url(page.ImagePath)
