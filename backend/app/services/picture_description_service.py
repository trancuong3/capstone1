from __future__ import annotations

import asyncio
from dataclasses import dataclass
from datetime import datetime, timezone
from io import BytesIO
from pathlib import Path
from typing import Callable
from uuid import UUID, uuid4

from fastapi import HTTPException, status
from PIL import Image, ImageOps, UnidentifiedImageError

from app.models import PictureDescriptionAttempt, PictureDescriptionSession
from app.repositories.picture_description_repository import (
    AttemptProjection,
    PictureDescriptionRepository,
    SessionProjection,
)
from app.schemas.picture_description import (
    InputMode,
    PictureAttemptRead,
    PictureBookPageItem,
    PictureCatalogRead,
    PictureEvaluateRequest,
    PictureEvaluateResponse,
    PictureEvaluationFeedbackRead,
    PictureGuideRead,
    PictureSampleItem,
    PictureSessionRead,
    PictureSessionSummaryRead,
    SourceType,
)
from app.services.picture_description_ai import GeminiPictureDescriptionAI, PictureAiError
from app.services.storage_service import (
    StorageUploadFailure,
    create_signed_image_url,
    delete_object,
    download_object,
    upload_object,
)


ASSETS_DIR = Path(__file__).resolve().parent.parent / "assets" / "picture_description"
MAX_UPLOAD_BYTES = 5 * 1024 * 1024
MAX_IMAGE_PIXELS = 25_000_000
MAX_AI_DIMENSION = 1280
ALLOWED_PIL_FORMATS = {"JPEG", "PNG", "WEBP"}


@dataclass(frozen=True, slots=True)
class SamplePictureSpec:
    sample_key: str
    filename: str
    title: str
    theme: str
    description: str

    @property
    def image_url(self) -> str:
        return f"/images/picture-description/{self.filename}"

    @property
    def storage_ref(self) -> str:
        return f"sample://{self.filename}"

    @property
    def asset_path(self) -> Path:
        return ASSETS_DIR / self.filename


SAMPLE_CATALOG: tuple[SamplePictureSpec, ...] = (
    SamplePictureSpec(
        sample_key="sunny-garden",
        filename="sunny-garden.jpg",
        title="Khu vườn đầy nắng",
        theme="Thiên nhiên",
        description="Chú mèo cam ngủ trưa trên ghế gỗ giữa vườn hoa hướng dương rực rỡ.",
    ),
    SamplePictureSpec(
        sample_key="lakeside-picnic",
        filename="lakeside-picnic.jpg",
        title="Chuyến dã ngoại bên hồ",
        theme="Bạn bè & Thiên nhiên",
        description="Hai bạn nhỏ vui đùa dưới gốc xoài xanh bên mặt hồ có vịt trắng bơi lội.",
    ),
    SamplePictureSpec(
        sample_key="happy-classroom",
        filename="happy-classroom.jpg",
        title="Phòng học vui vẻ",
        theme="Trường lớp",
        description="Cô giáo và các bạn nhỏ cùng học đọc sách bên ô cửa sổ đầy nắng.",
    ),
)
SAMPLE_BY_KEY: dict[str, SamplePictureSpec] = {
    spec.sample_key: spec for spec in SAMPLE_CATALOG
}


def _normalize_upload_image(raw_bytes: bytes) -> tuple[bytes, str]:
    """Validate and re-encode an uploaded image cleanly, stripping camera EXIF metadata."""
    if not raw_bytes or len(raw_bytes) > MAX_UPLOAD_BYTES:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="INVALID_IMAGE",
        )
    try:
        with Image.open(BytesIO(raw_bytes)) as img:
            if (img.format or "").upper() not in ALLOWED_PIL_FORMATS:
                raise HTTPException(
                    status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
                    detail="INVALID_IMAGE",
                )
            width, height = img.size
            if width < 16 or height < 16 or width * height > MAX_IMAGE_PIXELS:
                raise HTTPException(
                    status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
                    detail="INVALID_IMAGE",
                )
            oriented = ImageOps.exif_transpose(img).convert("RGB")
            oriented.thumbnail(
                (MAX_AI_DIMENSION, MAX_AI_DIMENSION),
                Image.Resampling.LANCZOS,
            )
            buffer = BytesIO()
            oriented.save(buffer, format="JPEG", quality=88, optimize=True)
            return buffer.getvalue(), "image/jpeg"
    except HTTPException:
        raise
    except (UnidentifiedImageError, OSError, ValueError) as exc:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="INVALID_IMAGE",
        ) from exc


def _normalize_mime_type(image_bytes: bytes, declared_mime: str | None = None) -> tuple[bytes, str]:
    """Ensure image bytes sent to Gemini Vision are valid and capped at safe dimensions."""
    try:
        with Image.open(BytesIO(image_bytes)) as img:
            fmt = (img.format or "").upper()
            width, height = img.size
            if width <= MAX_AI_DIMENSION and height <= MAX_AI_DIMENSION and fmt in {"JPEG", "PNG"}:
                mime = "image/png" if fmt == "PNG" else "image/jpeg"
                return image_bytes, mime
            oriented = ImageOps.exif_transpose(img).convert("RGB")
            oriented.thumbnail(
                (MAX_AI_DIMENSION, MAX_AI_DIMENSION),
                Image.Resampling.LANCZOS,
            )
            buffer = BytesIO()
            oriented.save(buffer, format="JPEG", quality=86, optimize=True)
            return buffer.getvalue(), "image/jpeg"
    except (UnidentifiedImageError, OSError, ValueError):
        if declared_mime in {"image/jpeg", "image/png", "image/webp"}:
            return image_bytes, declared_mime
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="INVALID_IMAGE",
        )


def _load_sample_bytes(spec: SamplePictureSpec) -> bytes:
    if not spec.asset_path.is_file():
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="SAMPLE_IMAGE_UNAVAILABLE",
        )
    return spec.asset_path.read_bytes()


class PictureDescriptionService:
    """Coordinates picture catalog, Supabase storage, PostgreSQL state, and Gemini Vision."""

    def __init__(
        self,
        repository: PictureDescriptionRepository,
        *,
        ai_client: GeminiPictureDescriptionAI | None = None,
        upload_fn: Callable[..., None] = upload_object,
        download_fn: Callable[[str], bytes] = download_object,
        delete_fn: Callable[..., None] = delete_object,
        sign_url_fn: Callable[..., str] = create_signed_image_url,
    ):
        self.repository = repository
        self.ai_client = ai_client or GeminiPictureDescriptionAI()
        self._upload_fn = upload_fn
        self._download_fn = download_fn
        self._delete_fn = delete_fn
        self._sign_url_fn = sign_url_fn

    async def _require_parent(self, actor_id: UUID) -> None:
        if await self.repository.profile_role(actor_id) != "parent":
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail="Parent access required",
            )

    async def _owned_child(self, actor_id: UUID, child_id: UUID):
        child = await self.repository.child_owned_by(child_id, actor_id)
        if child is None:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail="Resource not found",
            )
        return child

    def _resolve_image_url(
        self,
        *,
        source_type: str,
        sample_key: str | None,
        image_path: str,
    ) -> str:
        if source_type == "SAMPLE" and sample_key and sample_key in SAMPLE_BY_KEY:
            return SAMPLE_BY_KEY[sample_key].image_url
        if image_path.startswith("sample://"):
            filename = image_path.removeprefix("sample://")
            return f"/images/picture-description/{filename}"
        return self._sign_url_fn(image_path)

    async def _load_bytes_for_session(self, session: SessionProjection) -> tuple[bytes, str]:
        if session.SourceType == "SAMPLE":
            spec = SAMPLE_BY_KEY.get(session.SampleKey or "")
            if spec is None:
                raise HTTPException(status_code=404, detail="Resource not found")
            return _load_sample_bytes(spec), "image/jpeg"
        raw = await asyncio.to_thread(self._download_fn, session.ImagePath)
        return _normalize_mime_type(raw, session.ImageMimeType)

    @staticmethod
    def _to_attempt_read(attempt: AttemptProjection) -> PictureAttemptRead:
        feedback = PictureEvaluationFeedbackRead.model_validate(attempt.FeedbackPayload)
        return PictureAttemptRead(
            attempt_id=attempt.Id,
            attempt_number=attempt.AttemptNumber,
            input_mode=attempt.InputMode,  # type: ignore[arg-type]
            transcript_text=attempt.TranscriptText,
            score_out_of_10=attempt.ScoreOutOf10,
            stars=attempt.Stars,
            feedback=feedback,
            created_at=attempt.CreatedAt,
        )

    def _to_session_read(
        self,
        session: SessionProjection,
        attempts: list[AttemptProjection],
    ) -> PictureSessionRead:
        guide = PictureGuideRead.model_validate(session.PromptPayload)
        return PictureSessionRead(
            session_id=session.Id,
            child_id=session.ChildProfileId,
            child_grade=session.ChildGrade,
            source_type=session.SourceType,  # type: ignore[arg-type]
            sample_key=session.SampleKey,
            book_id=session.BookId,
            book_page_id=session.BookPageId,
            image_url=self._resolve_image_url(
                source_type=session.SourceType,
                sample_key=session.SampleKey,
                image_path=session.ImagePath,
            ),
            scene_title=session.SceneTitle,
            status=session.Status,  # type: ignore[arg-type]
            best_stars=session.BestStars,
            best_score=session.BestScore,
            attempts_count=session.AttemptsCount,
            guide=guide,
            attempts=[self._to_attempt_read(item) for item in attempts],
            created_at=session.CreatedAt,
            updated_at=session.UpdatedAt,
        )

    async def get_catalog(
        self,
        actor_id: UUID,
        child_id: UUID,
    ) -> PictureCatalogRead:
        await self._require_parent(actor_id)
        child = await self._owned_child(actor_id, child_id)
        child_grade = int(child.Grade)
        candidates = await self.repository.list_book_pages_for_grade(child_grade)

        samples = [
            PictureSampleItem(
                sample_key=spec.sample_key,
                title=spec.title,
                theme=spec.theme,
                description=spec.description,
                image_url=spec.image_url,
            )
            for spec in SAMPLE_CATALOG
        ]

        # Sign candidate page URLs safely after releasing DB transaction.
        def _sign_pages() -> list[PictureBookPageItem]:
            items: list[PictureBookPageItem] = []
            for row in candidates:
                try:
                    signed_url = self._sign_url_fn(row.ImagePath)
                except HTTPException:
                    continue
                items.append(
                    PictureBookPageItem(
                        book_id=row.BookId,
                        book_title=row.BookTitle,
                        page_id=row.PageId,
                        page_number=row.PageNumber,
                        image_url=signed_url,
                    )
                )
            return items

        book_pages = await asyncio.to_thread(_sign_pages)
        return PictureCatalogRead(samples=samples, book_pages=book_pages)

    async def list_sessions(
        self,
        actor_id: UUID,
        child_id: UUID,
    ) -> list[PictureSessionSummaryRead]:
        await self._require_parent(actor_id)
        await self._owned_child(actor_id, child_id)
        rows = await self.repository.list_child_sessions(
            child_id=child_id,
            parent_id=actor_id,
        )

        def _build() -> list[PictureSessionSummaryRead]:
            summaries: list[PictureSessionSummaryRead] = []
            for row in rows:
                try:
                    image_url = self._resolve_image_url(
                        source_type=row.SourceType,
                        sample_key=row.SampleKey,
                        image_path=row.ImagePath,
                    )
                except HTTPException:
                    image_url = "/images/picture-description/sunny-garden.jpg"
                summaries.append(
                    PictureSessionSummaryRead(
                        session_id=row.Id,
                        child_id=row.ChildProfileId,
                        source_type=row.SourceType,  # type: ignore[arg-type]
                        sample_key=row.SampleKey,
                        book_page_id=row.BookPageId,
                        scene_title=row.SceneTitle,
                        image_url=image_url,
                        status=row.Status,  # type: ignore[arg-type]
                        best_stars=row.BestStars,
                        best_score=row.BestScore,
                        attempts_count=row.AttemptsCount,
                        created_at=row.CreatedAt,
                        updated_at=row.UpdatedAt,
                    )
                )
            return summaries

        return await asyncio.to_thread(_build)

    async def get_session(
        self,
        actor_id: UUID,
        session_id: UUID,
    ) -> PictureSessionRead:
        await self._require_parent(actor_id)
        session = await self.repository.get_owned_session_projection(session_id, actor_id)
        if session is None:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail="Resource not found",
            )
        attempts = await self.repository.list_attempts(session.Id)
        await self.repository.db.rollback()
        return await asyncio.to_thread(self._to_session_read, session, attempts)

    async def create_session(
        self,
        actor_id: UUID,
        *,
        child_id: UUID,
        source_type: SourceType,
        sample_key: str | None = None,
        book_page_id: UUID | None = None,
        upload_bytes: bytes | None = None,
    ) -> PictureSessionRead:
        await self._require_parent(actor_id)
        child = await self._owned_child(actor_id, child_id)
        child_grade = int(child.Grade)
        session_id = uuid4()

        resolved_book_id: UUID | None = None
        resolved_book_page_id: UUID | None = None
        resolved_sample_key: str | None = None
        storage_path: str
        uploaded_new_object = False
        context_hint: str | None = None

        if source_type == "SAMPLE":
            spec = SAMPLE_BY_KEY.get((sample_key or "").strip())
            if spec is None:
                await self.repository.db.rollback()
                raise HTTPException(
                    status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
                    detail="INVALID_SAMPLE",
                )
            await self.repository.db.rollback()
            image_bytes = _load_sample_bytes(spec)
            image_mime = "image/jpeg"
            storage_path = spec.storage_ref
            resolved_sample_key = spec.sample_key
            context_hint = f"{spec.title}: {spec.description}"

        elif source_type == "BOOK_PAGE":
            if book_page_id is None:
                await self.repository.db.rollback()
                raise HTTPException(
                    status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
                    detail="BOOK_PAGE_REQUIRED",
                )
            candidate = await self.repository.get_book_page_for_grade(
                book_page_id, child_grade
            )
            await self.repository.db.rollback()
            if candidate is None:
                raise HTTPException(
                    status_code=status.HTTP_404_NOT_FOUND,
                    detail="Resource not found",
                )
            resolved_book_id = candidate.BookId
            resolved_book_page_id = candidate.PageId
            storage_path = candidate.ImagePath
            context_hint = f"Trang {candidate.PageNumber} của sách {candidate.BookTitle}"
            raw_bytes = await asyncio.to_thread(self._download_fn, storage_path)
            image_bytes, image_mime = _normalize_mime_type(raw_bytes)

        elif source_type == "CUSTOM_UPLOAD":
            await self.repository.db.rollback()
            if upload_bytes is None:
                raise HTTPException(
                    status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
                    detail="IMAGE_FILE_REQUIRED",
                )
            image_bytes, image_mime = _normalize_upload_image(upload_bytes)
            storage_path = f"picture-descriptions/{actor_id}/{session_id}.jpg"
        else:
            await self.repository.db.rollback()
            raise HTTPException(
                status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
                detail="INVALID_SOURCE_TYPE",
            )

        # Release any DB lock completely before calling Gemini Vision!
        try:
            guide, model_used = await self.ai_client.analyze_picture(
                image_bytes=image_bytes,
                mime_type=image_mime,
                child_grade=child_grade,
                context_hint=context_hint,
            )
        except PictureAiError as exc:
            raise HTTPException(status_code=exc.status_code, detail=exc.detail) from exc

        if source_type == "CUSTOM_UPLOAD":
            try:
                await asyncio.to_thread(
                    self._upload_fn,
                    storage_path,
                    image_bytes,
                    image_mime,
                    upsert=True,
                )
                uploaded_new_object = True
            except StorageUploadFailure as exc:
                raise HTTPException(
                    status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
                    detail=exc.detail,
                ) from exc

        now = datetime.now(timezone.utc)
        orm_session = PictureDescriptionSession(
            Id=session_id,
            ChildProfileId=child_id,
            ParentId=actor_id,
            BookId=resolved_book_id,
            BookPageId=resolved_book_page_id,
            SourceType=source_type,
            SampleKey=resolved_sample_key,
            ImagePath=storage_path,
            ImageMimeType=image_mime,
            ChildGrade=child_grade,
            SceneTitle=guide.scene_title[:200],
            PromptPayload=guide.model_dump(mode="json"),
            Status="ACTIVE",
            BestStars=0,
            BestScore=0,
            AttemptsCount=0,
            AiModelUsed=model_used[:64] if model_used else None,
            CreatedAt=now,
            UpdatedAt=now,
        )
        try:
            saved = await self.repository.create_session(orm_session)
        except Exception:
            if uploaded_new_object:
                await asyncio.to_thread(self._delete_fn, storage_path)
            raise

        return await asyncio.to_thread(self._to_session_read, saved, [])

    async def evaluate_attempt(
        self,
        actor_id: UUID,
        session_id: UUID,
        payload: PictureEvaluateRequest,
    ) -> PictureEvaluateResponse:
        await self._require_parent(actor_id)
        session = await self.repository.get_owned_session_projection(session_id, actor_id)
        await self.repository.db.rollback()
        if session is None:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail="Resource not found",
            )

        guide = PictureGuideRead.model_validate(session.PromptPayload)
        previous_transcript: str | None = None
        previous_score: int | None = None
        previous_tip: str | None = None
        if int(session.AttemptsCount) > 0:
            prior_attempts = await self.repository.list_attempts(session.Id)
            await self.repository.db.rollback()
            if prior_attempts:
                latest_prior = prior_attempts[0]
                previous_transcript = latest_prior.TranscriptText
                previous_score = int(latest_prior.ScoreOutOf10)
                if isinstance(latest_prior.FeedbackPayload, dict):
                    raw_tip = latest_prior.FeedbackPayload.get("improvement_tip")
                    if isinstance(raw_tip, str) and raw_tip.strip():
                        previous_tip = raw_tip.strip()

        image_bytes, image_mime = await self._load_bytes_for_session(session)

        try:
            feedback, model_used = await self.ai_client.evaluate_description(
                image_bytes=image_bytes,
                mime_type=image_mime,
                child_grade=session.ChildGrade,
                scene_title=session.SceneTitle,
                guiding_questions=guide.guiding_questions,
                child_transcript=payload.transcript_text,
                model_sample_sentences=guide.model_sample_sentences,
                previous_transcript=previous_transcript,
                previous_score=previous_score,
                previous_tip=previous_tip,
            )
        except PictureAiError as exc:
            raise HTTPException(status_code=exc.status_code, detail=exc.detail) from exc

        now = datetime.now(timezone.utc)
        new_best_stars = max(int(session.BestStars), int(feedback.stars))
        new_best_score = max(int(session.BestScore), int(feedback.score_out_of_10))
        achieved_completion = feedback.is_relevant and new_best_stars >= 2
        new_status = (
            "COMPLETED"
            if achieved_completion or session.Status == "COMPLETED"
            else "ACTIVE"
        )
        input_mode: InputMode = payload.input_mode

        orm_attempt = PictureDescriptionAttempt(
            Id=uuid4(),
            SessionId=session.Id,
            AttemptNumber=int(session.AttemptsCount) + 1,
            InputMode=input_mode,
            TranscriptText=payload.transcript_text,
            ScoreOutOf10=feedback.score_out_of_10,
            Stars=feedback.stars,
            FeedbackPayload=feedback.model_dump(mode="json"),
            AiModelUsed=model_used[:64] if model_used else None,
            CreatedAt=now,
        )
        updated_session, saved_attempt = await self.repository.save_attempt_and_update_session(
            session_id=session.Id,
            parent_id=actor_id,
            attempt=orm_attempt,
            new_best_stars=new_best_stars,
            new_best_score=new_best_score,
            new_attempts_count=int(session.AttemptsCount) + 1,
            new_status=new_status,
            updated_at=now,
        )
        all_attempts = await self.repository.list_attempts(updated_session.Id)
        await self.repository.db.rollback()

        session_read = await asyncio.to_thread(
            self._to_session_read, updated_session, all_attempts
        )
        attempt_read = self._to_attempt_read(saved_attempt)
        return PictureEvaluateResponse(session=session_read, latest_attempt=attempt_read)
