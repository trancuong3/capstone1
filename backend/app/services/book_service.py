"""Business services for book catalog and admin page-read endpoints."""
from __future__ import annotations

import math
from uuid import UUID

from fastapi import HTTPException
from pydantic import ValidationError
from sqlalchemy.ext.asyncio import AsyncSession

from app.models import Book
from app.repositories.book_repository import (
    AdminCatalogRepository,
    BookRepository,
    CatalogRepository,
)
from app.schemas import BookCreate
from app.schemas.book import (
    AdminBookMetadataResponse,
    AdminCatalogBookDetailResponse,
    AdminCatalogBookResponse,
    AdminPageImageRead,
    AdminPageListRead,
    AdminPageProcessingRead,
    AdminRevisionDetailRead,
    AdminRevisionSummaryRead,
    CatalogBookResponse,
    CatalogPagePreviewResponse,
)
from app.services.storage_service import create_signed_image_url


class BookService:
    """Business logic for legacy book endpoints."""

    def __init__(self, db: AsyncSession):
        self.repository = BookRepository(db)

    async def list_books(self) -> list[Book]:
        return await self.repository.list_books()

    async def create_book(self, actor_id: UUID, payload: BookCreate) -> Book:
        if await self.repository.role(actor_id) != "admin":
            raise HTTPException(status_code=403, detail="Admin access required")
        # The authenticated actor is authoritative; never trust CreatedBy from input.
        values = payload.model_dump(exclude={"CreatedBy"})
        values["CreatedBy"] = actor_id
        return await self.repository.create(Book(**values))

    async def list_pages(self, book_id: UUID):
        return await self.repository.list_pages(book_id)


class CatalogService:
    def __init__(self, db: AsyncSession | None = None, *, repository: CatalogRepository | None = None):
        if repository is not None:
            self.repository = repository
        elif db is not None:
            self.repository = CatalogRepository(db)
        else:
            raise TypeError("CatalogService requires a database session or repository")

    async def require_parent(self, actor_id: UUID):
        if await self.repository.role(actor_id) != "parent":
            raise HTTPException(status_code=403, detail="Access denied")

    async def list(self, search: str | None, author: str | None, grade: int | None):
        return [CatalogBookResponse.model_validate(book) for book in await self.repository.list(search, author, grade)]

    async def get(self, book_id: UUID):
        book = await self.repository.get(book_id)
        if book is None:
            raise HTTPException(status_code=404, detail="Resource not found")
        if not await self.repository.is_eligible(book_id):
            raise HTTPException(status_code=409, detail={"code": "CONTENT_INACTIVE"})
        return CatalogBookResponse.model_validate(book)

    async def previews(self, book_id: UUID):
        await self.get(book_id)
        pages = await self.repository.previews(book_id)
        snapshots = [
            {
                "page_id": page.Id,
                "page_number": page.PageNumber,
                "lifecycle_status": page.LifecycleStatus,
                "current_verified_revision_id": page.CurrentVerifiedRevisionId,
                "image_path": page.ImagePath,
            }
            for page in pages
        ]
        # Signed URL creation calls Supabase Storage; close the read transaction first.
        await self.repository.db.rollback()
        previews = []
        for page in snapshots:
            # Preserve the existing Storage error contract after releasing the DB transaction.
            preview_url = create_signed_image_url(page["image_path"])
            previews.append(CatalogPagePreviewResponse(
                page_id=page["page_id"],
                page_number=page["page_number"],
                lifecycle_status=page["lifecycle_status"],
                current_verified_revision_id=page["current_verified_revision_id"],
                preview_url=preview_url,
            ))
        return previews


class AdminCatalogService:
    def __init__(self, db: AsyncSession | None = None, *, repository: AdminCatalogRepository | None = None):
        if repository is not None:
            self.repository = repository
        elif db is not None:
            self.repository = AdminCatalogRepository(db)
        else:
            raise TypeError("AdminCatalogService requires a database session or repository")

    async def require_admin(self, actor_id: UUID):
        if await self.repository.role(actor_id) != "admin":
            raise HTTPException(status_code=403, detail="Access denied")

    @staticmethod
    def revision_number(revision):
        value = str(revision.RevisionNo)
        if not value.isascii() or not value.isdecimal() or len(value) > 16 or int(value) <= 0 or int(value) > 9007199254740991:
            raise HTTPException(status_code=501, detail="Revision number contract is not available yet")
        return int(value)

    async def book(self, book_id: UUID):
        row = await self.repository.get(book_id)
        if row is None:
            raise HTTPException(status_code=404, detail="Resource not found")
        try:
            return AdminBookMetadataResponse.model_validate(row)
        except ValidationError:
            raise HTTPException(status_code=501, detail="Book contract is not available yet") from None

    async def book_detail(self, book_id: UUID) -> AdminCatalogBookDetailResponse:
        book = await self.book(book_id)
        max_page_number = await self.repository.max_page_number(book_id)
        return AdminCatalogBookDetailResponse(
            **book.model_dump(),
            next_page_number=(max_page_number or 0) + 1,
        )

    async def page(self, page_id: UUID):
        page = await self.repository.page(page_id)
        # A retired page remains stored for history but is no longer part of the
        # active Admin OCR workflow, including when an old detail URL is opened.
        if page is None or page.LifecycleStatus != "ACTIVE":
            raise HTTPException(status_code=404, detail="Resource not found")
        return page

    async def list(self, search: str | None, lifecycle_status: str | None, verification_status: str | None):
        output = []
        for book in await self.repository.books(search, lifecycle_status):
            pages = await self.repository.pages(book.Id)
            statuses = []
            for page in pages:
                revisions = await self.repository.revisions(page.Id)
                if revisions:
                    if revisions[0].VerificationStatus not in ("PROCESSING", "NEEDS_REVIEW", "VERIFIED"):
                        raise HTTPException(status_code=501, detail="Page status contract is not available yet")
                    statuses.append(revisions[0].VerificationStatus)
            if verification_status is not None and verification_status not in statuses:
                continue
            try:
                output.append(AdminCatalogBookResponse(
                book=AdminBookMetadataResponse.model_validate(book), page_count=len(pages),
                processing_count=statuses.count("PROCESSING"), needs_review_count=statuses.count("NEEDS_REVIEW"),
                verified_count=statuses.count("VERIFIED"), parent_catalog_eligible=await self.repository.is_eligible(book.Id),
                ))
            except ValidationError:
                raise HTTPException(status_code=501, detail="Catalog contract is not available yet") from None
        return output

    async def processing(self, page):
        revisions = await self.repository.revisions(page.Id)
        if not revisions:
            raise HTTPException(status_code=501, detail="Page has no revision yet")
        # Only numeric version numbers can be mapped to the current UI contract.
        revision = revisions[0]
        try:
            return AdminPageProcessingRead(
                page_id=page.Id, page_revision_id=revision.Id, revision_no=self.revision_number(revision),
                verification_status=revision.VerificationStatus, lifecycle_status=page.LifecycleStatus,
                ocr_preview_metadata={}, verified_at=revision.VerifiedAt,
                current_verified_revision_id=page.CurrentVerifiedRevisionId,
            )
        except ValidationError:
            raise HTTPException(status_code=501, detail="Page contract is not available yet") from None

    async def processing_by_page_id(self, page_id: UUID):
        page = await self.page(page_id)
        return await self.processing(page)

    async def page_text_preview(self, page) -> str | None:
        revisions = await self.repository.revisions(page.Id)
        if not revisions:
            return None
        revision = revisions[0]
        text_value = getattr(revision, "DraftText", None) or getattr(revision, "VerifiedText", None)
        if not isinstance(text_value, str) or not text_value.strip():
            return None
        compact = " ".join(text_value.split())
        return compact[:240] + ("…" if len(compact) > 240 else "")

    async def pages(self, book_id: UUID):
        await self.book(book_id)
        try:
            output = []
            for page in await self.repository.pages(book_id):
                output.append(
                    AdminPageListRead(
                        book_id=page.BookId,
                        page_number=page.PageNumber,
                        processing=await self.processing(page),
                        text_preview=await self.page_text_preview(page),
                    )
                )
            return output
        except ValidationError:
            raise HTTPException(status_code=501, detail="Page list contract is not available yet") from None

    async def image(self, page_id: UUID):
        page = await self.page(page_id)
        # Admin reviews the image that produced the latest revision, even when pending.
        # Parent/Child reading keeps BookPage.ImagePath until that revision is verified.
        revisions = await self.repository.revisions(page.Id)
        metadata = (
            dict(getattr(revisions[0], "ProcessingMeta", None) or {})
            if revisions
            else {}
        )
        candidate_path = metadata.get("source_image_path")
        image_path = candidate_path if isinstance(candidate_path, str) and candidate_path else page.ImagePath
        candidate_width = metadata.get("source_image_width")
        candidate_height = metadata.get("source_image_height")
        width = candidate_width if type(candidate_width) is int and candidate_width > 0 else page.Width
        height = candidate_height if type(candidate_height) is int and candidate_height > 0 else page.Height
        page_id = page.Id
        page_number = page.PageNumber
        await self.repository.db.rollback()
        preview_url = create_signed_image_url(image_path)
        try:
            return AdminPageImageRead(
                page_id=page_id,
                page_number=page_number,
                preview_url=preview_url,
                width=width,
                height=height,
            )
        except ValidationError:
            raise HTTPException(status_code=501, detail="Image metadata does not match the admin contract") from None

    async def revisions(self, page_id: UUID):
        page = await self.page(page_id)
        rows = await self.repository.revisions(page_id)
        if not rows:
            raise HTTPException(status_code=404, detail="Page has no revision yet")
        try:
            return [AdminRevisionSummaryRead(
                page_revision_id=revision.Id,
                revision_no=self.revision_number(revision),
                verification_status=revision.VerificationStatus,
                created_at=revision.CreatedAt,
                is_current_verified=page.CurrentVerifiedRevisionId == revision.Id,
            ) for revision in rows]
        except ValidationError:
            raise HTTPException(status_code=501, detail="Revision contract is not available yet") from None

    async def revision(self, page_id: UUID, revision_id: UUID):
        page = await self.page(page_id)
        revision = await self.repository.revision(page_id, revision_id)
        if revision is None:
            raise HTTPException(status_code=404, detail="Resource not found")
        metadata = dict(getattr(revision, "ProcessingMeta", None) or {})
        raw_statuses = metadata.get("word_review_statuses")
        if not isinstance(raw_statuses, list):
            raw_statuses = []
        raw_score_sources = metadata.get("word_score_sources")
        if not isinstance(raw_score_sources, list):
            raw_score_sources = []
        raw_word_evidence = metadata.get("word_evidence_v2")
        if not isinstance(raw_word_evidence, list):
            raw_word_evidence = []
        raw_score_contract = metadata.get("ocr_score_contract")
        trusted_score_contracts = {
            "tesseract_raw_word_score_v1",
            "dual_engine_consensus_v1",
            "paddle_line_score_v1",
            "ocr_calibrated_word_accuracy_v1",
        }
        words = []
        for word in await self.repository.words(revision_id):
            box = word.BoundingBox
            # New writes use [x, y, width, height]. Legacy object rows are read-only compatibility.
            if isinstance(box, dict):
                box = [box.get("x"), box.get("y"), box.get("width"), box.get("height")]
            if not isinstance(box, list) or len(box) != 4:
                raise HTTPException(status_code=501, detail="Word bounding box contract is not available yet")
            if not all(isinstance(value, (int, float)) and not isinstance(value, bool) for value in box):
                raise HTTPException(status_code=501, detail="Normalized bounding box is not available yet")
            x, y, width, height = [float(value) for value in box]
            if (any(value < 0 or value > 1 for value in (x, y, width, height))
                or width <= 0 or height <= 0 or x + width > 1.000001 or y + height > 1.000001):
                raise HTTPException(status_code=501, detail="Normalized bounding box is not available yet")
            raw_score = word.OCRConfidence
            try:
                numeric_score = float(raw_score) if raw_score is not None and not isinstance(raw_score, bool) else None
            except (TypeError, ValueError, OverflowError):
                numeric_score = None
            if (
                numeric_score is None
                or not math.isfinite(numeric_score)
                or not 0 <= numeric_score <= 1
            ):
                numeric_score = None
            status_from_evidence = (
                raw_statuses[word.WordIndex]
                if 0 <= word.WordIndex < len(raw_statuses)
                else None
            )
            score_source = (
                raw_score_sources[word.WordIndex]
                if 0 <= word.WordIndex < len(raw_score_sources)
                else raw_score_contract
            )
            score_source = (
                score_source
                if isinstance(score_source, str)
                and score_source in trusted_score_contracts
                else None
            )
            if score_source not in {
                "tesseract_raw_word_score_v1",
                "ocr_calibrated_word_accuracy_v1",
            }:
                numeric_score = None
            review_status = (
                "verified"
                if revision.VerificationStatus == "VERIFIED"
                else status_from_evidence
                if isinstance(status_from_evidence, str)
                and status_from_evidence in {
                    "matched",
                    "suspect",
                    "needs_review",
                    "engine_agreement",
                    "engine_disagreement",
                    "reference_match",
                    "confirmed_mismatch",
                    "local_vision_match",
                    "vision_suggested_mismatch",
                    "verified",
                }
                else "needs_review"
            )
            if review_status == "matched":
                review_status = "engine_agreement"
            elif review_status == "suspect":
                review_status = "engine_disagreement"
            raw_evidence = (
                raw_word_evidence[word.WordIndex]
                if 0 <= word.WordIndex < len(raw_word_evidence)
                else None
            )
            word_evidence = None
            if isinstance(raw_evidence, dict) and raw_evidence.get("contract") in {
                "dual_engine_agreement_v2",
                "tesseract_raw_word_score_v1",
            }:
                outputs = raw_evidence.get("engine_outputs")
                safe_outputs = {
                    engine: outputs.get(engine)
                    if isinstance(outputs, dict) and isinstance(outputs.get(engine), str)
                    else None
                    for engine in ("paddleocr", "vietocr", "tesseract")
                }
                agreement = raw_evidence.get("engine_agreement_score")
                if (
                    isinstance(agreement, bool)
                    or not isinstance(agreement, (int, float))
                    or not math.isfinite(float(agreement))
                    or not 0 <= float(agreement) <= 1
                ):
                    agreement = None
                calibrated = raw_evidence.get("calibrated_word_accuracy")
                if (
                    isinstance(calibrated, bool)
                    or not isinstance(calibrated, (int, float))
                    or not math.isfinite(float(calibrated))
                    or not 0 <= float(calibrated) <= 1
                    or raw_evidence.get("contract") != "ocr_calibrated_word_accuracy_v1"
                ):
                    calibrated = None
                verification_source = raw_evidence.get("verification_source")
                if verification_source not in {"admin", "verified_revision"}:
                    verification_source = None
                reference_text = raw_evidence.get("reference_text")
                if not isinstance(reference_text, str):
                    reference_text = None
                reference_alignment = raw_evidence.get("reference_alignment")
                if not isinstance(reference_alignment, str):
                    reference_alignment = None
                local_vision_source = raw_evidence.get("local_vision_source")
                if local_vision_source != "ollama_local_vision_v1":
                    local_vision_source = None
                local_vision_result = raw_evidence.get("local_vision_result")
                if local_vision_result not in {"match", "mismatch", "uncertain"}:
                    local_vision_result = None
                local_vision_suggestion = raw_evidence.get("local_vision_suggestion")
                if (
                    not isinstance(local_vision_suggestion, str)
                    or len(local_vision_suggestion) > 500
                ):
                    local_vision_suggestion = None
                word_evidence = {
                    "contract": raw_evidence["contract"],
                    "engine_outputs": safe_outputs,
                    "alignment": raw_evidence.get("alignment") if isinstance(raw_evidence.get("alignment"), str) else "unknown",
                    "engine_agreement_score": float(agreement) if agreement is not None else None,
                    "calibrated_word_accuracy": float(calibrated) if calibrated is not None else None,
                    "verification_source": verification_source,
                    "reference_text": reference_text,
                    "reference_alignment": reference_alignment,
                    "local_vision_source": local_vision_source,
                    "local_vision_result": local_vision_result,
                    "local_vision_suggestion": local_vision_suggestion,
                    "review_reason": raw_evidence.get("review_reason") if isinstance(raw_evidence.get("review_reason"), str) else "Evidence is unavailable.",
                }
            words.append({
                "word_index": word.WordIndex,
                "line_index": word.LineIndex,
                "text": word.Text,
                "normalized_text": word.NormalizedText,
                "bbox": (x, y, width, height),
                "ocr_confidence": numeric_score if score_source is not None else None,
                "ocr_review_status": review_status,
                "ocr_score_source": score_source,
                "ocr_evidence": word_evidence,
            })
        raw_revision = str(revision.RevisionNo)
        if not raw_revision.isascii() or not raw_revision.isdecimal() or int(raw_revision) < 1:
            raise HTTPException(status_code=501, detail="Revision number contract is not available yet")
        try:
            return AdminRevisionDetailRead(
                page_id=page.Id,
                page_revision_id=revision.Id,
                revision_no=int(raw_revision),
                verification_status=revision.VerificationStatus,
                lifecycle_status=page.LifecycleStatus,
                draft_text=getattr(revision, "DraftText", None) if getattr(revision, "DraftText", None) is not None else revision.VerifiedText,
                words=words,
                # Expose OCR diagnostics only from a strict allowlist; never return storage paths.
                ocr_metadata={
                    key: metadata[key]
                    for key in (
                        "engine",
                        "engine_version",
                        "ocr_evidence_contract",
                        "ocr_score_contract",
                        "language",
                        "coordinate_space",
                        "source_width",
                        "source_height",
                        "processed_width",
                        "processed_height",
                        "scale_factor",
                        "word_count",
                        "line_count",
                        "reading_layout",
                        "line_evidence",
                        "reference_source",
                        "reference_revision_id",
                        "verified_reference_alignment",
                    )
                    if key in metadata
                },
                created_at=revision.CreatedAt,
                verified_at=revision.VerifiedAt,
                verified_by=revision.VerifiedBy,
            )
        except ValidationError:
            raise HTTPException(status_code=501, detail="Revision contract is not available yet") from None
