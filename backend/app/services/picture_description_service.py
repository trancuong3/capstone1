from __future__ import annotations

import asyncio
import inspect
import logging
from dataclasses import dataclass
from datetime import datetime, timezone
from io import BytesIO
from pathlib import Path
from typing import Any, Callable
from uuid import UUID, uuid4

from fastapi import HTTPException, status
from PIL import Image, ImageOps, UnidentifiedImageError
from sqlalchemy import insert

from app.diagnostic_logging import log_diagnostic
from app.models import (
    LearningSkillEvidence,
    PictureDescriptionAttempt,
    PictureDescriptionSession,
)
from app.repositories.picture_description_repository import (
    AttemptProjection,
    BookPageCandidateProjection,
    PictureDescriptionRepository,
    SessionProjection,
)
from app.services.child_difficult_word_feed import DifficultWordTarget
from app.services.difficult_words_service import (
    normalize_vietnamese_practice_word,
    tokenize_vietnamese_practice_text,
)
from app.schemas.picture_description import (
    EvaluationSource,
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
    PictureVocabItem,
    SourceType,
    TeachingMode,
    _normalize_target_words,
)
from app.services.picture_description_ai import (
    GeminiPictureDescriptionAI,
    PictureAiError,
    PictureDescriptionAiConfig,
    PictureSafetyError,
    TEACHING_MODE_SPECS,
    _build_next_prompt_question,
    _count_meaningful_words,
    _select_scaffolding_step,
    build_deterministic_picture_guide,
    detect_used_target_words,
    evaluate_description_with_guide_fallback,
    resolve_provider_tier,
)
from app.services.storage_service import (
    StorageUploadFailure,
    create_signed_image_url,
    delete_object,
    download_object,
    upload_object,
)

logger = logging.getLogger(__name__)


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
    default_guide: PictureGuideRead

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
        default_guide=PictureGuideRead(
            is_child_safe=True,
            scene_title="Khu vườn đầy nắng",
            scene_summary="Chú mèo cam đang cuộn tròn ngủ trên ghế gỗ giữa khu vườn đầy nắng có hoa hướng dương, bình tưới nước và bươm bướm.",
            guiding_questions=[
                "Trong bức tranh có con vật nào và đang làm gì?",
                "Xung quanh chỗ con vật nằm có những loài hoa hay đồ vật gì?",
                "Khung cảnh thời tiết và bầu không khí trong vườn như thế nào?",
            ],
            suggested_vocabulary=[
                PictureVocabItem(word="mèo cam", hint="Chú mèo lông màu vàng cam"),
                PictureVocabItem(word="cuộn tròn", hint="Tư thế nằm ngủ ngoan, ấm áp"),
                PictureVocabItem(word="ghế gỗ", hint="Chiếc ghế bằng gỗ đặt trong vườn"),
                PictureVocabItem(word="hướng dương", hint="Loài hoa to màu vàng tươi"),
                PictureVocabItem(word="bình tưới", hint="Dụng cụ dùng để tưới nước cho cây"),
                PictureVocabItem(word="nắng ấm", hint="Ánh sáng dịu nhẹ từ mặt trời"),
            ],
            model_sample_sentences=[
                "Dưới ánh nắng ấm áp, chú mèo cam đang cuộn tròn ngủ ngon trên chiếc ghế gỗ giữa khu vườn.",
                "Xung quanh ghế gỗ có những bông hoa hướng dương nở rực rỡ và chiếc bình tưới cây xinh xắn.",
            ],
        ),
    ),
    SamplePictureSpec(
        sample_key="lakeside-picnic",
        filename="lakeside-picnic.jpg",
        title="Chuyến dã ngoại bên hồ",
        theme="Bạn bè & Thiên nhiên",
        description="Hai bạn nhỏ vui đùa dưới gốc xoài xanh bên mặt hồ có vịt trắng bơi lội.",
        default_guide=PictureGuideRead(
            is_child_safe=True,
            scene_title="Dã ngoại bên hồ",
            scene_summary="Hai bạn nhỏ ngồi dã ngoại trên thảm cỏ dưới tán cây xanh bên bờ hồ có đàn vịt trắng bơi lội và bầu trời trong xanh.",
            guiding_questions=[
                "Trong bức tranh có những bạn nhỏ nào và các bạn đang làm gì?",
                "Trên mặt nước và xung quanh bãi cỏ có những con vật hay đồ vật nào?",
                "Bé thấy khung cảnh thiên nhiên và cảm xúc của các bạn ra sao?",
            ],
            suggested_vocabulary=[
                PictureVocabItem(word="dã ngoại", hint="Chuyến đi chơi, ăn uống ngoài trời"),
                PictureVocabItem(word="bờ hồ", hint="Khoảng đất cỏ xanh sát mặt nước"),
                PictureVocabItem(word="vịt trắng", hint="Những chú vịt lông trắng bơi trên hồ"),
                PictureVocabItem(word="tán cây", hint="Cành lá xanh tỏa bóng mát"),
                PictureVocabItem(word="giỏ đồ ăn", hint="Chiếc giỏ đựng trái cây và bánh"),
                PictureVocabItem(word="vui vẻ", hint="Gương mặt rạng rỡ, tươi cười"),
            ],
            model_sample_sentences=[
                "Hai bạn nhỏ đang ngồi trò chuyện vui vẻ trên tấm thảm dưới tán cây xanh mát bên bờ hồ.",
                "Trên mặt hồ yên ả có những chú vịt trắng đang tung tăng bơi lội dưới ánh nắng dịu nhẹ.",
            ],
        ),
    ),
    SamplePictureSpec(
        sample_key="happy-classroom",
        filename="happy-classroom.jpg",
        title="Phòng học vui vẻ",
        theme="Trường lớp",
        description="Cô giáo và các bạn nhỏ cùng học đọc sách bên ô cửa sổ đầy nắng.",
        default_guide=PictureGuideRead(
            is_child_safe=True,
            scene_title="Trong lớp học",
            scene_summary="Cô giáo đứng cầm sách mỉm cười dịu dàng trước bảng xanh, ba bạn học sinh hào hứng giơ tay phát biểu trong lớp học ngập nắng.",
            guiding_questions=[
                "Trong bức tranh có những ai và mỗi người đang làm gì?",
                "Trên bảng và xung quanh phòng học có những đồ vật gì quen thuộc?",
                "Không khí giờ học trong tranh trông vui tươi như thế nào?",
            ],
            suggested_vocabulary=[
                PictureVocabItem(word="cô giáo", hint="Người đứng giảng bài và cầm quyển sách"),
                PictureVocabItem(word="học sinh", hint="Các bạn nhỏ ngồi ngay ngắn ở bàn học"),
                PictureVocabItem(word="giơ tay", hint="Động tác xin phát biểu ý kiến"),
                PictureVocabItem(word="bảng xanh", hint="Tấm bảng lớn phía trước lớp học"),
                PictureVocabItem(word="cửa sổ", hint="Ô cửa đón ánh nắng và có chậu cây"),
                PictureVocabItem(word="hào hứng", hint="Vẻ mặt vui tươi, thích thú khi học"),
            ],
            model_sample_sentences=[
                "Trong lớp học ngập tràn ánh nắng, cô giáo dịu dàng cầm sách và mỉm cười nhìn cả lớp.",
                "Ba bạn học sinh ngồi ngay ngắn, hào hứng giơ tay phát biểu bên khung cửa sổ có nhiều cây xanh.",
            ],
        ),
    ),
)
SAMPLE_BY_KEY: dict[str, SamplePictureSpec] = {
    spec.sample_key: spec for spec in SAMPLE_CATALOG
}
GRADE_DEFAULT_SAMPLE: dict[int, str] = {
    1: "sunny-garden",
    2: "sunny-garden",
    3: "lakeside-picnic",
    4: "happy-classroom",
    5: "happy-classroom",
}


def _default_sample_key_for_grade(grade: int) -> str:
    return GRADE_DEFAULT_SAMPLE.get(max(1, min(5, int(grade))), "sunny-garden")


def _match_words_in_text(text: str, words: list[str]) -> list[str]:
    if not text or not words:
        return []
    tokens = [
        normalize_vietnamese_practice_word(token)
        for token in tokenize_vietnamese_practice_text(text)
    ]
    cleaned_tokens = [token for token in tokens if token]
    if not cleaned_tokens:
        return []
    padded = f" {' '.join(cleaned_tokens)} "
    token_set = set(cleaned_tokens)
    matched: list[str] = []
    seen: set[str] = set()
    for word in words:
        norm = normalize_vietnamese_practice_word(word)
        if not norm or norm in seen:
            continue
        hit = norm in token_set if " " not in norm else f" {norm} " in padded
        if hit:
            seen.add(norm)
            matched.append(word)
    return matched


def _sample_searchable_text(spec: SamplePictureSpec) -> str:
    vocab_parts = [f"{item.word} {item.hint}" for item in spec.default_guide.suggested_vocabulary]
    return " ".join(
        [
            spec.title,
            spec.theme,
            spec.description,
            spec.default_guide.scene_title,
            spec.default_guide.scene_summary,
            *vocab_parts,
            *spec.default_guide.model_sample_sentences,
        ]
    )


def _best_sample_for_child(grade: int, focus_words: list[str]) -> SamplePictureSpec:
    preferred_key = _default_sample_key_for_grade(grade)
    ranked = sorted(
        SAMPLE_CATALOG,
        key=lambda spec: (
            -len(_match_words_in_text(_sample_searchable_text(spec), focus_words)),
            0 if spec.sample_key == preferred_key else 1,
        ),
    )
    return ranked[0]


def _select_target_words_for_scene(
    explicit_words: list[str] | None,
    feed_words: list[str],
    scene_text: str,
) -> list[str]:
    if not feed_words:
        return _normalize_target_words(explicit_words)
    matched = _match_words_in_text(scene_text, feed_words)
    matched_keys = {normalize_vietnamese_practice_word(w) for w in matched}
    remaining = [
        word
        for word in feed_words
        if normalize_vietnamese_practice_word(word) not in matched_keys
    ]
    woven_focus = [*matched, *remaining][:3]
    if explicit_words:
        return _normalize_target_words([*explicit_words, *woven_focus])
    return _normalize_target_words(woven_focus)


def _normalize_upload_image(raw_bytes: bytes) -> tuple[bytes, str]:
    """Validate and re-encode an uploaded image cleanly, stripping camera EXIF metadata."""
    if not raw_bytes or len(raw_bytes) > MAX_UPLOAD_BYTES:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_CONTENT,
            detail="INVALID_IMAGE",
        )
    try:
        with Image.open(BytesIO(raw_bytes)) as img:
            if (img.format or "").upper() not in ALLOWED_PIL_FORMATS:
                raise HTTPException(
                    status_code=status.HTTP_422_UNPROCESSABLE_CONTENT,
                    detail="INVALID_IMAGE",
                )
            width, height = img.size
            if width < 16 or height < 16 or width * height > MAX_IMAGE_PIXELS:
                raise HTTPException(
                    status_code=status.HTTP_422_UNPROCESSABLE_CONTENT,
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
    except (UnidentifiedImageError, OSError, ValueError, Image.DecompressionBombError) as exc:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_CONTENT,
            detail="INVALID_IMAGE",
        ) from exc


def _normalize_mime_type(image_bytes: bytes, declared_mime: str | None = None) -> tuple[bytes, str]:
    """Ensure image bytes sent to Gemini Vision are valid and capped at safe dimensions."""
    try:
        with Image.open(BytesIO(image_bytes)) as img:
            fmt = (img.format or "").upper()
            width, height = img.size
            if width <= 0 or height <= 0 or width * height > MAX_IMAGE_PIXELS:
                raise HTTPException(
                    status_code=status.HTTP_422_UNPROCESSABLE_CONTENT,
                    detail="INVALID_IMAGE",
                )
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
    except HTTPException:
        raise
    except Image.DecompressionBombError as exc:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_CONTENT,
            detail="INVALID_IMAGE",
        ) from exc
    except (UnidentifiedImageError, OSError, ValueError):
        if declared_mime in {"image/jpeg", "image/png", "image/webp"}:
            return image_bytes, declared_mime
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_CONTENT,
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
            return await asyncio.to_thread(_load_sample_bytes, spec), "image/jpeg"
        raw = await asyncio.to_thread(self._download_fn, session.ImagePath)
        return await asyncio.to_thread(_normalize_mime_type, raw, session.ImageMimeType)

    def _ai_config(self) -> PictureDescriptionAiConfig | None:
        cfg = getattr(self.ai_client, "config", None)
        return cfg if isinstance(cfg, PictureDescriptionAiConfig) else None

    async def _safe_feed_targets(
        self,
        actor_id: UUID,
        child_id: UUID,
        *,
        limit: int = 8,
    ) -> list[DifficultWordTarget]:
        fn = getattr(self.repository, "list_difficult_word_targets", None)
        if fn is None:
            return []
        try:
            maybe_coro = fn(child_id, actor_id, limit=limit)
            if not inspect.isawaitable(maybe_coro):
                return []
            rows = await maybe_coro
        except Exception:
            return []
        return list(rows) if isinstance(rows, (list, tuple)) else []

    async def _safe_book_pages_for_grade(
        self,
        grade: int,
        *,
        limit: int = 12,
    ) -> list[BookPageCandidateProjection]:
        fn = getattr(self.repository, "list_book_pages_for_grade", None)
        if fn is None:
            return []
        try:
            maybe_coro = fn(grade, limit=limit)
            if not inspect.isawaitable(maybe_coro):
                return []
            rows = await maybe_coro
        except Exception:
            return []
        return list(rows) if isinstance(rows, (list, tuple)) else []

    def _to_attempt_read(self, attempt: AttemptProjection) -> PictureAttemptRead:
        feedback = PictureEvaluationFeedbackRead.model_validate(attempt.FeedbackPayload)
        evaluation_source: EvaluationSource = (
            "FALLBACK" if attempt.AiModelUsed == "guide-fallback" else "AI"
        )
        provider_tier = feedback.provider_tier or resolve_provider_tier(
            attempt.AiModelUsed, self._ai_config()
        )
        if feedback.provider_tier is None:
            feedback = feedback.model_copy(update={"provider_tier": provider_tier})
        return PictureAttemptRead(
            attempt_id=attempt.Id,
            attempt_number=attempt.AttemptNumber,
            input_mode=attempt.InputMode,  # type: ignore[arg-type]
            transcript_text=attempt.TranscriptText,
            score_out_of_10=attempt.ScoreOutOf10,
            stars=attempt.Stars,
            evaluation_source=evaluation_source,
            provider_tier=provider_tier,
            feedback=feedback,
            practiced_difficult_words=list(feedback.used_target_words),
            created_at=attempt.CreatedAt,
        )

    def _to_session_read(
        self,
        session: SessionProjection,
        attempts: list[AttemptProjection],
    ) -> PictureSessionRead:
        guide = PictureGuideRead.model_validate(session.PromptPayload)
        provider_tier = resolve_provider_tier(session.AiModelUsed, self._ai_config())
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
            teaching_mode=guide.teaching_mode,
            target_words=list(guide.target_words),
            target_vocabulary=list(guide.target_words),
            provider_tier=provider_tier,
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
        feed_targets = await self._safe_feed_targets(actor_id, child_id, limit=8)
        focus_difficult_words = [target.word for target in feed_targets if target.word]
        candidates = await self.repository.list_book_pages_for_grade(child_grade)

        samples = [
            PictureSampleItem(
                sample_key=spec.sample_key,
                title=spec.title,
                theme=spec.theme,
                description=spec.description,
                image_url=spec.image_url,
                matched_difficult_words=_match_words_in_text(
                    _sample_searchable_text(spec),
                    focus_difficult_words,
                ),
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
                searchable_page = " ".join(
                    part for part in (row.BookTitle, getattr(row, "VerifiedText", None)) if part
                )
                items.append(
                    PictureBookPageItem(
                        book_id=row.BookId,
                        book_title=row.BookTitle,
                        page_id=row.PageId,
                        page_number=row.PageNumber,
                        image_url=signed_url,
                        matched_difficult_words=_match_words_in_text(
                            searchable_page,
                            focus_difficult_words,
                        ),
                    )
                )
            items.sort(key=lambda item: -len(item.matched_difficult_words))
            return items

        book_pages = await asyncio.to_thread(_sign_pages)
        preferred_sample = _default_sample_key_for_grade(child_grade)
        recommended_sample = max(
            samples,
            key=lambda item: (
                len(item.matched_difficult_words),
                1 if item.sample_key == preferred_sample else 0,
            ),
            default=None,
        )
        recommended_book_page_id = book_pages[0].page_id if book_pages else None
        return PictureCatalogRead(
            samples=samples,
            book_pages=book_pages,
            focus_difficult_words=focus_difficult_words,
            recommended_sample_key=(
                recommended_sample.sample_key if recommended_sample is not None else None
            ),
            recommended_book_page_id=recommended_book_page_id,
        )

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

    async def _record_learning_skill_evidence(
        self,
        *,
        child_id: UUID,
        parent_id: UUID,
        attempt_id: UUID,
        child_grade: int,
        input_mode: InputMode,
        feedback: PictureEvaluationFeedbackRead,
        model_used: str | None,
        practiced_difficult_words: list[str] | None = None,
    ) -> None:
        """Persist compact skill evidence into learning_skill_evidence (gracefully skipping if unmigrated)."""
        active_mode: TeachingMode = (
            feedback.teaching_mode if feedback.teaching_mode in TEACHING_MODE_SPECS else "OBSERVE"
        )
        primary_skill = TEACHING_MODE_SPECS[active_mode].skill_key
        skill_keys: list[str] = [primary_skill]
        if feedback.used_target_words and primary_skill != "vocabulary_naming":
            skill_keys.append("vocabulary_naming")

        is_fallback = (
            feedback.provider_tier == "DETERMINISTIC_FALLBACK"
            or model_used == "guide-fallback"
        )
        evidence_type = "ESTIMATED" if is_fallback else "OBSERVED"
        confidence = 0.55 if is_fallback else 0.85
        score_normalized = round(max(0.0, min(1.0, float(feedback.score_out_of_10) / 10.0)), 3)
        difficulty_level = max(1, min(5, int(child_grade)))
        practice_words = list(feedback.used_target_words or feedback.vocabulary_highlights[:5])
        metadata = {
            "teaching_mode": active_mode,
            "scaffolding_step": feedback.scaffolding_step,
            "provider_tier": feedback.provider_tier,
            "stars": int(feedback.stars),
            "input_mode": input_mode,
        }

        now = datetime.now(timezone.utc)
        rows = [
            {
                "Id": uuid4(),
                "ChildId": child_id,
                "ParentId": parent_id,
                "SkillKey": skill_key,
                "SourceModule": "PICTURE_DESCRIPTION",
                "SourceRecordId": str(attempt_id),
                "EvidenceType": evidence_type,
                "ScoreNormalized": score_normalized,
                "Confidence": confidence,
                "DifficultyLevel": difficulty_level,
                "PracticeWords": practice_words,
                "MetadataJson": metadata,
                "CreatedAt": now,
            }
            for skill_key in skill_keys
        ]
        cleaned_practiced = [w for w in (practiced_difficult_words or []) if w]
        if cleaned_practiced and feedback.is_relevant:
            rows.append(
                {
                    "Id": uuid4(),
                    "ChildId": child_id,
                    "ParentId": parent_id,
                    "SkillKey": "difficult_word_mastery",
                    "SourceModule": "PICTURE_DESCRIPTION",
                    "SourceRecordId": str(attempt_id),
                    "EvidenceType": evidence_type,
                    "ScoreNormalized": score_normalized,
                    "Confidence": confidence,
                    "DifficultyLevel": difficulty_level,
                    "PracticeWords": cleaned_practiced[:6],
                    "MetadataJson": metadata,
                    "CreatedAt": now,
                }
            )
        try:
            await self.repository.db.execute(insert(LearningSkillEvidence), rows)
            await self.repository.db.commit()
        except Exception as exc:
            log_diagnostic(
                logger,
                logging.WARNING,
                event="picture_learning_skill_evidence_skipped",
                stage="learning_skill_evidence",
                exception=exc,
                reason_code="TABLE_UNAVAILABLE_OR_SKIPPED",
            )
            try:
                await self.repository.db.rollback()
            except Exception:
                pass

    @staticmethod
    def _extract_child_teacher_gender(child: Any) -> str | None:
        settings = getattr(child, "Settings", None)
        if not isinstance(settings, dict):
            return None
        vp = settings.get("voice_preferences")
        if not isinstance(vp, dict):
            return None
        gender = str(vp.get("gender") or "").strip().lower()
        return gender if gender in ("female", "male") else None

    @staticmethod
    def _supports_kwarg(fn: Any, name: str) -> bool:
        import inspect as _inspect

        try:
            sig = _inspect.signature(fn)
        except (TypeError, ValueError):
            return False
        if name in sig.parameters:
            return True
        return any(
            p.kind == _inspect.Parameter.VAR_KEYWORD
            for p in sig.parameters.values()
        )

    async def create_session(
        self,
        actor_id: UUID,
        *,
        child_id: UUID,
        source_type: SourceType | None = None,
        sample_key: str | None = None,
        book_page_id: UUID | None = None,
        upload_bytes: bytes | None = None,
        teaching_mode: TeachingMode = "OBSERVE",
        target_words: list[str] | None = None,
        refresh_ai_guide: bool = False,
        auto_select: bool = False,
        teacher_gender: str | None = None,
    ) -> PictureSessionRead:
        await self._require_parent(actor_id)
        child = await self._owned_child(actor_id, child_id)
        child_grade = int(child.Grade)
        resolved_teacher_gender = (
            teacher_gender
            if teacher_gender in ("female", "male")
            else self._extract_child_teacher_gender(child)
        )
        session_id = uuid4()
        active_mode: TeachingMode = (
            teaching_mode if teaching_mode in TEACHING_MODE_SPECS else "OBSERVE"
        )
        feed_targets = await self._safe_feed_targets(actor_id, child_id, limit=8)
        focus_words = [target.word for target in feed_targets if target.word]

        resolved_source_type: SourceType | None = source_type
        resolved_sample_key_input = sample_key
        resolved_book_page_id_input = book_page_id
        preloaded_candidate: BookPageCandidateProjection | None = None
        auto_selected_book_page = False

        if resolved_source_type is None and auto_select:
            candidates = await self._safe_book_pages_for_grade(child_grade)
            best_page: BookPageCandidateProjection | None = None
            best_page_hits = 0
            for row in candidates:
                page_text = " ".join(
                    part for part in (row.BookTitle, getattr(row, "VerifiedText", None)) if part
                )
                hits = len(_match_words_in_text(page_text, focus_words))
                if hits > best_page_hits:
                    best_page_hits = hits
                    best_page = row
            if best_page is not None and best_page_hits > 0:
                resolved_source_type = "BOOK_PAGE"
                resolved_book_page_id_input = best_page.PageId
                preloaded_candidate = best_page
                auto_selected_book_page = True
            else:
                best_sample = _best_sample_for_child(child_grade, focus_words)
                resolved_source_type = "SAMPLE"
                resolved_sample_key_input = best_sample.sample_key
        elif resolved_source_type == "SAMPLE" and not (resolved_sample_key_input or "").strip() and auto_select:
            resolved_sample_key_input = _best_sample_for_child(child_grade, focus_words).sample_key
        elif resolved_source_type == "BOOK_PAGE" and resolved_book_page_id_input is None and auto_select:
            candidates = await self._safe_book_pages_for_grade(child_grade)
            if candidates:
                ranked = sorted(
                    candidates,
                    key=lambda row: -len(
                        _match_words_in_text(
                            " ".join(
                                part for part in (row.BookTitle, getattr(row, "VerifiedText", None)) if part
                            ),
                            focus_words,
                        )
                    ),
                )
                preloaded_candidate = ranked[0]
                resolved_book_page_id_input = preloaded_candidate.PageId
                auto_selected_book_page = True

        resolved_book_id: UUID | None = None
        resolved_book_page_id: UUID | None = None
        resolved_sample_key: str | None = None
        storage_path: str
        uploaded_new_object = False
        context_hint: str | None = None
        scene_match_text = ""
        image_bytes: bytes | None = None
        image_mime = "image/jpeg"

        sample_spec: SamplePictureSpec | None = None

        if resolved_source_type == "SAMPLE":
            spec = SAMPLE_BY_KEY.get((resolved_sample_key_input or "").strip())
            if spec is None:
                await self.repository.db.rollback()
                raise HTTPException(
                    status_code=status.HTTP_422_UNPROCESSABLE_CONTENT,
                    detail="INVALID_SAMPLE",
                )
            await self.repository.db.rollback()
            sample_spec = spec
            image_mime = "image/jpeg"
            storage_path = spec.storage_ref
            resolved_sample_key = spec.sample_key
            context_hint = f"{spec.title}: {spec.description}"
            scene_match_text = _sample_searchable_text(spec)
            if refresh_ai_guide:
                image_bytes = await asyncio.to_thread(_load_sample_bytes, spec)

        elif resolved_source_type == "BOOK_PAGE":
            if resolved_book_page_id_input is None:
                await self.repository.db.rollback()
                raise HTTPException(
                    status_code=status.HTTP_422_UNPROCESSABLE_CONTENT,
                    detail="BOOK_PAGE_REQUIRED",
                )
            candidate = preloaded_candidate or await self.repository.get_book_page_for_grade(
                resolved_book_page_id_input, child_grade
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
            scene_match_text = " ".join(
                part
                for part in (candidate.BookTitle, getattr(candidate, "VerifiedText", None))
                if part
            )
            try:
                raw_bytes = await asyncio.to_thread(self._download_fn, storage_path)
                image_bytes, image_mime = await asyncio.to_thread(_normalize_mime_type, raw_bytes)
            except Exception as exc:
                if not auto_selected_book_page:
                    raise
                log_diagnostic(
                    logger,
                    logging.WARNING,
                    event="picture_auto_select_book_page_download_fallback",
                    stage="picture_auto_select",
                    exception=exc,
                    reason_code="BOOK_PAGE_DOWNLOAD_FAILED",
                    book_page_id=str(candidate.PageId),
                )
                best_sample = _best_sample_for_child(child_grade, focus_words)
                resolved_source_type = "SAMPLE"
                sample_spec = best_sample
                resolved_book_id = None
                resolved_book_page_id = None
                resolved_sample_key = best_sample.sample_key
                image_mime = "image/jpeg"
                storage_path = best_sample.storage_ref
                context_hint = f"{best_sample.title}: {best_sample.description}"
                scene_match_text = _sample_searchable_text(best_sample)
                image_bytes = (
                    await asyncio.to_thread(_load_sample_bytes, best_sample)
                    if refresh_ai_guide
                    else None
                )

        elif resolved_source_type == "CUSTOM_UPLOAD":
            await self.repository.db.rollback()
            if upload_bytes is None:
                raise HTTPException(
                    status_code=status.HTTP_422_UNPROCESSABLE_CONTENT,
                    detail="IMAGE_FILE_REQUIRED",
                )
            image_bytes, image_mime = await asyncio.to_thread(_normalize_upload_image, upload_bytes)
            storage_path = f"picture-descriptions/{actor_id}/{session_id}.jpg"
        else:
            await self.repository.db.rollback()
            raise HTTPException(
                status_code=status.HTTP_422_UNPROCESSABLE_CONTENT,
                detail="INVALID_SOURCE_TYPE",
            )

        cleaned_targets = _select_target_words_for_scene(
            target_words,
            focus_words,
            scene_match_text,
        )

        # Static built-in samples serve curated default_guide directly with ZERO outbound cloud calls
        # unless the caller explicitly requests refresh_ai_guide=True.
        if resolved_source_type == "SAMPLE" and sample_spec is not None and not refresh_ai_guide:
            guide = sample_spec.default_guide.model_copy(
                update={
                    "teaching_mode": active_mode,
                    "target_words": cleaned_targets,
                }
            )
            model_used = "curated-sample-v4"
        else:
            assert image_bytes is not None
            # Release any DB lock completely before calling Vision AI!
            try:
                analyze_kwargs: dict[str, Any] = {
                    "image_bytes": image_bytes,
                    "mime_type": image_mime,
                    "child_grade": child_grade,
                    "context_hint": context_hint,
                    "teaching_mode": active_mode,
                    "target_words": cleaned_targets,
                }
                if resolved_teacher_gender and self._supports_kwarg(
                    self.ai_client.analyze_picture, "teacher_gender"
                ):
                    analyze_kwargs["teacher_gender"] = resolved_teacher_gender
                guide, model_used = await self.ai_client.analyze_picture(**analyze_kwargs)
            except PictureSafetyError as exc:
                # CRITICAL SAFETY INVARIANT: Never bypass UNSAFE_PICTURE!
                raise HTTPException(
                    status_code=status.HTTP_422_UNPROCESSABLE_CONTENT,
                    detail="UNSAFE_PICTURE",
                ) from exc
            except PictureAiError as exc:
                if exc.code == "UNSAFE_PICTURE":
                    raise HTTPException(
                        status_code=status.HTTP_422_UNPROCESSABLE_CONTENT,
                        detail="UNSAFE_PICTURE",
                    ) from exc
                if exc.code == "AI_AUTH_FAILED":
                    raise HTTPException(
                        status_code=exc.status_code,
                        detail=exc.detail,
                    ) from exc
                if resolved_source_type == "SAMPLE" and sample_spec is not None and (
                    exc.retryable or exc.code == "AI_NOT_CONFIGURED"
                ):
                    log_diagnostic(
                        logger,
                        logging.WARNING,
                        event="picture_sample_curated_guide_fallback",
                        stage="picture_analyze",
                        reason_code=exc.code,
                        sample_key=sample_spec.sample_key,
                    )
                    guide = sample_spec.default_guide.model_copy(
                        update={
                            "teaching_mode": active_mode,
                            "target_words": cleaned_targets,
                        }
                    )
                    model_used = "curated-sample-v4"
                elif resolved_source_type == "BOOK_PAGE" and (
                    exc.retryable or exc.code == "AI_NOT_CONFIGURED"
                ):
                    log_diagnostic(
                        logger,
                        logging.WARNING,
                        event="picture_analyze_deterministic_guide_fallback",
                        stage="picture_analyze",
                        reason_code=exc.code,
                        source_type=resolved_source_type,
                    )
                    guide = build_deterministic_picture_guide(
                        child_grade=child_grade,
                        context_hint=context_hint,
                        teaching_mode=active_mode,
                        target_words=cleaned_targets,
                    )
                    model_used = "guide-fallback"
                else:
                    raise HTTPException(status_code=exc.status_code, detail=exc.detail) from exc

        if cleaned_targets and not guide.target_words:
            guide = guide.model_copy(update={"target_words": cleaned_targets})

        if resolved_source_type == "CUSTOM_UPLOAD":
            assert image_bytes is not None
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
            SourceType=resolved_source_type,
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
        active_mode: TeachingMode = (
            payload.teaching_mode
            if payload.teaching_mode in TEACHING_MODE_SPECS
            else guide.teaching_mode
        )
        active_target_words = _normalize_target_words(
            payload.target_words if payload.target_words is not None else list(guide.target_words)
        )

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

        resolved_teacher_gender = (
            payload.teacher_gender
            if payload.teacher_gender in ("female", "male")
            else None
        )
        if resolved_teacher_gender is None:
            child_id = getattr(session, "ChildProfileId", None) or getattr(session, "ChildId", None)
            if child_id is not None and hasattr(self.repository, "child_owned_by"):
                try:
                    owned_child = await self.repository.child_owned_by(child_id, actor_id)
                    resolved_teacher_gender = self._extract_child_teacher_gender(owned_child)
                    await self.repository.db.rollback()
                except Exception:
                    resolved_teacher_gender = None

        try:
            eval_kwargs: dict[str, Any] = {
                "image_bytes": image_bytes,
                "mime_type": image_mime,
                "child_grade": session.ChildGrade,
                "scene_title": session.SceneTitle,
                "guiding_questions": guide.guiding_questions,
                "child_transcript": payload.transcript_text,
                "model_sample_sentences": guide.model_sample_sentences,
                "previous_transcript": previous_transcript,
                "previous_score": previous_score,
                "previous_tip": previous_tip,
                "teaching_mode": active_mode,
                "target_words": active_target_words,
                "scene_summary": guide.scene_summary,
                "suggested_vocabulary": guide.suggested_vocabulary,
            }
            if resolved_teacher_gender and self._supports_kwarg(
                self.ai_client.evaluate_description, "teacher_gender"
            ):
                eval_kwargs["teacher_gender"] = resolved_teacher_gender
            feedback, model_used = await self.ai_client.evaluate_description(**eval_kwargs)
        except PictureSafetyError as exc:
            raise HTTPException(
                status_code=status.HTTP_422_UNPROCESSABLE_CONTENT,
                detail="UNSAFE_PICTURE",
            ) from exc
        except PictureAiError as exc:
            if exc.code == "UNSAFE_PICTURE":
                raise HTTPException(
                    status_code=status.HTTP_422_UNPROCESSABLE_CONTENT,
                    detail="UNSAFE_PICTURE",
                ) from exc
            if exc.code == "AI_AUTH_FAILED":
                raise HTTPException(status_code=exc.status_code, detail=exc.detail) from exc
            if exc.retryable or exc.code == "AI_NOT_CONFIGURED":
                log_diagnostic(
                    logger,
                    logging.WARNING,
                    event="picture_evaluate_guide_fallback",
                    stage="picture_evaluate",
                    reason_code=exc.code,
                )
                feedback, model_used = evaluate_description_with_guide_fallback(
                    guide=guide,
                    child_grade=session.ChildGrade,
                    child_transcript=payload.transcript_text,
                    previous_score=previous_score,
                    teaching_mode=active_mode,
                    target_words=active_target_words,
                    teacher_gender=resolved_teacher_gender,
                )
            else:
                raise HTTPException(status_code=exc.status_code, detail=exc.detail) from exc

        # Guarantee consistent V4 pedagogical fields even when mocked AI clients return legacy payloads.
        detected_targets = detect_used_target_words(payload.transcript_text, active_target_words)
        used_target_words = _normalize_target_words(
            [*(feedback.used_target_words or ()), *detected_targets]
        )
        practiced_difficult_words = list(used_target_words) if feedback.is_relevant else []
        praise_message = feedback.praise_message
        if (
            practiced_difficult_words
            and feedback.is_relevant
            and not any(w.casefold() in praise_message.casefold() for w in practiced_difficult_words)
        ):
            words_preview = ", ".join(f"“{w}”" for w in practiced_difficult_words[:3])
            teacher_pronoun = "Thầy" if resolved_teacher_gender == "male" else "Cô"
            praise_addition = (
                f" {teacher_pronoun} khen bé đã vận dụng tự nhiên từ {words_preview}!"
            )
            if len(praise_message) + len(praise_addition) <= 360:
                praise_message = f"{praise_message.rstrip()}{praise_addition}"

        scaffolding_step = feedback.scaffolding_step or _select_scaffolding_step(
            is_relevant=feedback.is_relevant,
            score=feedback.score_out_of_10,
            stars=feedback.stars,
            word_count=_count_meaningful_words(payload.transcript_text),
            grade=session.ChildGrade,
        )
        next_prompt_question = feedback.next_prompt_question or _build_next_prompt_question(
            teaching_mode=active_mode,
            scaffolding_step=scaffolding_step,
            grade=session.ChildGrade,
            missed_details=feedback.missed_details,
            target_words=active_target_words,
            used_target_words=used_target_words,
        )
        provider_tier = feedback.provider_tier or resolve_provider_tier(
            model_used, self._ai_config()
        )
        feedback = feedback.model_copy(
            update={
                "praise_message": praise_message,
                "teaching_mode": active_mode,
                "scaffolding_step": scaffolding_step,
                "next_prompt_question": next_prompt_question,
                "used_target_words": used_target_words,
                "provider_tier": provider_tier,
            }
        )

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
        try:
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
        except LookupError as exc:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail="Resource not found",
            ) from exc
        all_attempts = await self.repository.list_attempts(updated_session.Id)
        await self.repository.db.rollback()

        await self._record_learning_skill_evidence(
            child_id=updated_session.ChildProfileId,
            parent_id=actor_id,
            attempt_id=saved_attempt.Id,
            child_grade=updated_session.ChildGrade,
            input_mode=input_mode,
            feedback=feedback,
            model_used=model_used,
            practiced_difficult_words=practiced_difficult_words,
        )

        session_read = await asyncio.to_thread(
            self._to_session_read, updated_session, all_attempts
        )
        attempt_read = self._to_attempt_read(saved_attempt)
        return PictureEvaluateResponse(
            session=session_read,
            latest_attempt=attempt_read,
            practiced_difficult_words=practiced_difficult_words,
        )
