from __future__ import annotations

import secrets
from typing import Any
from uuid import UUID

from fastapi import HTTPException, status

from app.repositories.memory_game_repository import (
    MemoryAttemptProjection,
    MemoryGameRepository,
    MemorySessionProjection,
)
from app.schemas.memory_game import (
    MemoryAttemptCreate,
    MemoryAttemptRead,
    MemoryAttemptSubmitRead,
    MemoryEvaluationRead,
    MemoryHintRead,
    MemoryHintRequest,
    MemoryPeekRead,
    MemorySessionCreate,
    MemorySessionRead,
    MemorySessionSummaryRead,
    MemoryThemesCatalogRead,
    SceneSpec,
)
from app.services.games.memory_game_evaluator import (
    MemoryGameEvaluator,
    detect_mentioned_object_ids,
)
from app.services.games.memory_scene_generator import (
    THEME_BY_KEY,
    THEME_KEYS,
    default_difficulty_for_grade,
    generate_scene_spec,
    get_themes_catalog,
    recommend_theme_for_words,
    resolve_theme_key,
    timer_seconds_for_mode,
)


def _to_attempt_read(attempt: MemoryAttemptProjection) -> MemoryAttemptRead:
    evaluation = MemoryEvaluationRead.model_validate(attempt.EvaluationPayload)
    return MemoryAttemptRead(
        id=attempt.Id,
        session_id=attempt.SessionId,
        attempt_number=attempt.AttemptNumber,
        stage=attempt.Stage,  # type: ignore[arg-type]
        input_mode=attempt.InputMode,  # type: ignore[arg-type]
        response_text=attempt.ResponseText,
        factual_score=attempt.FactualScore,
        creative_score=attempt.CreativeScore,
        stars=attempt.Stars,
        evaluation=evaluation,
        ai_provider=attempt.AiProvider,
        created_at=attempt.CreatedAt,
    )


def _to_session_read(session: MemorySessionProjection) -> MemorySessionRead:
    scene_spec = SceneSpec.model_validate(session.SceneSpec)
    theme_name = THEME_BY_KEY.get(scene_spec.theme_key)
    return MemorySessionRead(
        id=session.Id,
        child_id=session.ChildId,
        child_grade=session.ChildGrade,
        theme_key=scene_spec.theme_key,
        theme_name_vi=theme_name.name_vi if theme_name else scene_spec.theme_name_vi,
        difficulty_level=session.DifficultyLevel,
        scene_seed=session.SceneSeed,
        timer_mode=session.TimerMode,  # type: ignore[arg-type]
        timer_seconds=session.TimerSeconds,
        recall_mode=session.RecallMode,  # type: ignore[arg-type]
        status=session.Status,  # type: ignore[arg-type]
        hints_used=session.HintsUsed,
        peek_count=session.PeekCount,
        best_factual_score=session.BestFactualScore,
        best_creative_score=session.BestCreativeScore,
        stars=session.Stars,
        attempts_count=session.AttemptsCount,
        focus_words=list(scene_spec.focus_words or scene_spec.matched_focus_words),
        scene_spec=scene_spec,
        attempts=[_to_attempt_read(item) for item in session.Attempts],
        created_at=session.CreatedAt,
        updated_at=session.UpdatedAt,
    )


def _to_summary_read(session: MemorySessionProjection) -> MemorySessionSummaryRead:
    scene_objects = session.SceneSpec.get("objects") if isinstance(session.SceneSpec, dict) else []
    theme_name = (
        session.SceneSpec.get("theme_name_vi")
        if isinstance(session.SceneSpec, dict)
        else None
    ) or (
        THEME_BY_KEY[session.ThemeKey].name_vi  # type: ignore[index]
        if session.ThemeKey in THEME_BY_KEY
        else session.ThemeKey
    )
    return MemorySessionSummaryRead(
        id=session.Id,
        child_id=session.ChildId,
        child_grade=session.ChildGrade,
        theme_key=session.ThemeKey,  # type: ignore[arg-type]
        theme_name_vi=str(theme_name),
        difficulty_level=session.DifficultyLevel,
        timer_mode=session.TimerMode,  # type: ignore[arg-type]
        timer_seconds=session.TimerSeconds,
        recall_mode=session.RecallMode,  # type: ignore[arg-type]
        status=session.Status,  # type: ignore[arg-type]
        hints_used=session.HintsUsed,
        peek_count=session.PeekCount,
        best_factual_score=session.BestFactualScore,
        best_creative_score=session.BestCreativeScore,
        stars=session.Stars,
        attempts_count=session.AttemptsCount,
        object_count=len(scene_objects) if isinstance(scene_objects, list) else 0,
        created_at=session.CreatedAt,
        updated_at=session.UpdatedAt,
    )


class MemoryGameService:
    """Business orchestration for AI Memory & Creative Story Game ('Bé nhớ được gì?')."""

    def __init__(
        self,
        repo: MemoryGameRepository,
        evaluator: MemoryGameEvaluator | None = None,
    ):
        self.repo = repo
        self.evaluator = evaluator or MemoryGameEvaluator()

    def get_themes(self) -> MemoryThemesCatalogRead:
        return get_themes_catalog()

    async def get_themes_for_child(
        self,
        parent_id: UUID | None = None,
        child_id: UUID | None = None,
    ) -> MemoryThemesCatalogRead:
        catalog = get_themes_catalog()
        if child_id is None or parent_id is None:
            return catalog
        child = await self.repo.child_owned_by(child_id, parent_id)
        if child is None:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail="CHILD_NOT_FOUND",
            )
        focus_words = await self.repo.recent_difficult_words(child.Id, parent_id, limit=6)
        recommended_theme = (
            recommend_theme_for_words(focus_words, child.Grade, seed=0)
            if focus_words
            else None
        )
        return catalog.model_copy(
            update={
                "focus_difficult_words": list(focus_words),
                "recommended_theme_key": recommended_theme,
            }
        )

    async def create_session(
        self,
        parent_id: UUID,
        payload: MemorySessionCreate,
    ) -> MemorySessionRead:
        child = await self.repo.child_owned_by(payload.child_id, parent_id)
        if child is None:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail="CHILD_NOT_FOUND",
            )

        seed = (
            payload.scene_seed
            if payload.scene_seed is not None
            else secrets.randbelow(2_147_483_647)
        )
        difficulty = (
            payload.difficulty_level
            if payload.difficulty_level is not None
            else default_difficulty_for_grade(child.Grade)
        )
        timer_seconds = timer_seconds_for_mode(payload.timer_mode)

        focus_words = list(payload.focus_words)
        if not focus_words:
            focus_words = await self.repo.recent_difficult_words(child.Id, parent_id, limit=8)

        last_theme: str | None = None
        if payload.scene_seed is None and payload.theme_key in (None, "random"):
            try:
                recent = await self.repo.list_sessions_for_child(child.Id, parent_id, limit=1)
                if recent:
                    last_theme = recent[0].ThemeKey
            except Exception:
                last_theme = None

        if payload.theme_key in THEME_BY_KEY:
            theme_key = resolve_theme_key(payload.theme_key, seed)
        elif payload.theme_key == "random":
            theme_key = resolve_theme_key("random", seed)
            if last_theme == theme_key and len(THEME_KEYS) > 1:
                alt_themes = [key for key in THEME_KEYS if key != last_theme]
                theme_key = alt_themes[seed % len(alt_themes)]
        elif focus_words:
            theme_key = recommend_theme_for_words(
                focus_words,
                child.Grade,
                seed,
                exclude_theme=last_theme,
            )
        else:
            theme_key = resolve_theme_key(None, seed)
            if last_theme == theme_key and len(THEME_KEYS) > 1:
                alt_themes = [key for key in THEME_KEYS if key != last_theme]
                theme_key = alt_themes[seed % len(alt_themes)]

        scene_spec = generate_scene_spec(
            theme_key=theme_key,
            child_grade=child.Grade,
            difficulty_level=difficulty,
            scene_seed=seed,
            focus_words=focus_words,
        )

        created = await self.repo.create_session(
            child_id=child.Id,
            parent_id=parent_id,
            child_grade=child.Grade,
            theme_key=scene_spec.theme_key,
            difficulty_level=scene_spec.difficulty_level,
            scene_seed=scene_spec.scene_seed,
            timer_mode=payload.timer_mode,
            timer_seconds=timer_seconds,
            recall_mode=payload.recall_mode,
            scene_spec=scene_spec.model_dump(mode="json"),
        )
        return _to_session_read(created)

    async def get_session(
        self,
        parent_id: UUID,
        session_id: UUID,
    ) -> MemorySessionRead:
        session = await self.repo.get_session_for_parent(session_id, parent_id)
        if session is None:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail="MEMORY_SESSION_NOT_FOUND",
            )
        return _to_session_read(session)

    async def list_sessions(
        self,
        parent_id: UUID,
        child_id: UUID,
        *,
        limit: int = 10,
    ) -> list[MemorySessionSummaryRead]:
        child = await self.repo.child_owned_by(child_id, parent_id)
        if child is None:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail="CHILD_NOT_FOUND",
            )
        sessions = await self.repo.list_sessions_for_child(child.Id, parent_id, limit=limit)
        return [_to_summary_read(item) for item in sessions]

    async def request_hint(
        self,
        parent_id: UUID,
        session_id: UUID,
        payload: MemoryHintRequest,
    ) -> MemoryHintRead:
        session = await self.repo.get_session_for_parent(session_id, parent_id)
        if session is None:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail="MEMORY_SESSION_NOT_FOUND",
            )

        scene_spec = SceneSpec.model_validate(session.SceneSpec)
        mentioned_ids: set[str] = set(payload.mentioned_object_ids)
        if payload.mentioned_text.strip():
            mentioned_ids.update(detect_mentioned_object_ids(scene_spec, payload.mentioned_text))

        # Include objects already matched in previous RECALL attempts
        for attempt in session.Attempts:
            if attempt.Stage == "RECALL":
                for matched in attempt.EvaluationPayload.get("matched_facts", []):
                    obj_id = matched.get("object_id") if isinstance(matched, dict) else None
                    if isinstance(obj_id, str):
                        mentioned_ids.add(obj_id)

        unmentioned = [obj for obj in scene_spec.objects if obj.id not in mentioned_ids]
        hints_used = await self.repo.increment_hints(session_id, parent_id)
        if hints_used is None:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail="MEMORY_SESSION_NOT_FOUND",
            )

        if not unmentioned:
            return MemoryHintRead(
                session_id=session.Id,
                hints_used=hints_used,
                object_id=None,
                tier=3,
                hint_text_vi=(
                    "Tuyệt quá! Bé đã nhắc tới tất cả các chi tiết trong bức tranh rồi — "
                    "bé có thể thêm màu sắc, số lượng hoặc bấm gửi câu trả lời nhé!"
                ),
                remaining_unmentioned_count=0,
                has_more_tiers=False,
            )

        target = None
        if payload.target_object_id:
            target = next((obj for obj in unmentioned if obj.id == payload.target_object_id), None)
        if target is None:
            target = unmentioned[0]

        if payload.requested_tier is not None:
            tier = payload.requested_tier
        else:
            tier = ((hints_used - 1) % 3) + 1

        hint_text = (
            target.hint_tiers.tier_1
            if tier == 1
            else (target.hint_tiers.tier_2 if tier == 2 else target.hint_tiers.tier_3)
        )

        return MemoryHintRead(
            session_id=session.Id,
            hints_used=hints_used,
            object_id=target.id,
            tier=tier,
            hint_text_vi=hint_text,
            remaining_unmentioned_count=len(unmentioned),
            has_more_tiers=tier < 3,
        )

    async def record_peek(
        self,
        parent_id: UUID,
        session_id: UUID,
    ) -> MemoryPeekRead:
        peek_count = await self.repo.increment_peeks(session_id, parent_id)
        if peek_count is None:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail="MEMORY_SESSION_NOT_FOUND",
            )
        return MemoryPeekRead(
            session_id=session_id,
            peek_count=peek_count,
            peek_duration_seconds=3,
            message_vi=(
                "Bức tranh mở lại 3 giây để bé quan sát thêm nhé — nhớ từng bước một rất thông minh!"
            ),
        )

    async def submit_attempt(
        self,
        parent_id: UUID,
        session_id: UUID,
        payload: MemoryAttemptCreate,
        *,
        enable_ai_enrichment: bool = True,
    ) -> MemoryAttemptSubmitRead:
        session = await self.repo.get_session_for_parent(session_id, parent_id)
        if session is None:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail="MEMORY_SESSION_NOT_FOUND",
            )

        cleaned_response = " ".join(payload.response_text.strip().split())
        if not cleaned_response:
            raise HTTPException(
                status_code=status.HTTP_422_UNPROCESSABLE_CONTENT,
                detail="EMPTY_RESPONSE",
            )

        resolved_teacher_gender = (
            payload.teacher_gender
            if payload.teacher_gender in ("female", "male")
            else None
        )
        if resolved_teacher_gender is None and hasattr(self.repo, "child_owned_by"):
            try:
                owned_child = await self.repo.child_owned_by(session.ChildId, parent_id)
                settings = getattr(owned_child, "Settings", None)
                if isinstance(settings, dict):
                    vp = settings.get("voice_preferences")
                    if isinstance(vp, dict) and vp.get("gender") in ("female", "male"):
                        resolved_teacher_gender = vp["gender"]
            except Exception:
                resolved_teacher_gender = None

        scene_spec = SceneSpec.model_validate(session.SceneSpec)
        evaluation = await self.evaluator.evaluate(
            scene_spec=scene_spec,
            stage=payload.stage,
            response_text=cleaned_response,
            hints_used=session.HintsUsed,
            peek_count=session.PeekCount,
            prior_best_factual_score=session.BestFactualScore,
            prior_best_creative_score=session.BestCreativeScore,
            enable_ai_enrichment=enable_ai_enrichment,
            teacher_gender=resolved_teacher_gender,
        )

        saved = await self.repo.record_attempt(
            session_id=session.Id,
            parent_id=parent_id,
            stage=payload.stage,
            input_mode=payload.input_mode,
            response_text=cleaned_response,
            factual_score=evaluation.factual_score,
            creative_score=evaluation.creative_score,
            stars=evaluation.stars,
            evaluation_payload=evaluation.model_dump(mode="json"),
            ai_provider=evaluation.ai_provider,
        )
        if saved is None:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail="MEMORY_SESSION_NOT_FOUND",
            )

        attempt_proj, updated_session = saved
        await self._record_learning_evidence(
            session=updated_session,
            attempt=attempt_proj,
            evaluation=evaluation,
            scene_spec=scene_spec,
        )
        if payload.input_mode == "VOICE" and evaluation.used_focus_words:
            from app.services.active_weak_words import (
                match_focus_words_in_text,
                record_entertainment_vocal_word_practice,
            )

            exact_vocal_words = match_focus_words_in_text(
                cleaned_response,
                [
                    *scene_spec.matched_focus_words,
                    *getattr(scene_spec, "creative_focus_words", []),
                ],
            )
            if exact_vocal_words:
                await record_entertainment_vocal_word_practice(
                    getattr(self.repo, "db", None),
                    child_id=updated_session.ChildId,
                    parent_id=parent_id,
                    words=exact_vocal_words,
                    source_module="MEMORY_GAME",
                    source_record_id=str(attempt_proj.Id),
                    transcript_text=cleaned_response,
                    confidence=0.84,
                    difficulty_level=updated_session.DifficultyLevel,
                )

        return MemoryAttemptSubmitRead(
            attempt=_to_attempt_read(attempt_proj),
            session=_to_session_read(updated_session),
        )

    async def _record_learning_evidence(
        self,
        *,
        session: MemorySessionProjection,
        attempt: MemoryAttemptProjection,
        evaluation: Any,
        scene_spec: SceneSpec,
    ) -> None:
        evidence_items: list[dict[str, Any]] = []
        practice_words = [fact.name_vi for fact in evaluation.matched_facts[:6]]
        metadata = {
            "session_id": str(session.Id),
            "theme_key": scene_spec.theme_key,
            "stage": attempt.Stage,
            "timer_mode": session.TimerMode,
            "hints_used": session.HintsUsed,
            "peek_count": session.PeekCount,
        }

        if attempt.Stage == "RECALL":
            factual_norm = evaluation.factual_score / 100.0
            total_obj = max(1, len(scene_spec.objects))
            vocab_norm = len(evaluation.matched_facts) / total_obj
            attr_hits = sum(
                max(0, len(fact.matched_attributes) - 1) for fact in evaluation.matched_facts
            )
            observation_norm = min(1.0, (len(evaluation.matched_facts) + attr_hits * 0.5) / total_obj)
            evidence_items.extend(
                [
                    {
                        "skill_key": "visual_memory_recall",
                        "score_normalized": factual_norm,
                        "confidence": 0.9 if session.PeekCount == 0 else 0.75,
                        "practice_words": practice_words,
                        "metadata_json": metadata,
                    },
                    {
                        "skill_key": "visual_observation",
                        "score_normalized": observation_norm,
                        "confidence": 0.85,
                        "practice_words": practice_words,
                        "metadata_json": metadata,
                    },
                    {
                        "skill_key": "vocabulary_naming",
                        "score_normalized": vocab_norm,
                        "confidence": 0.85,
                        "practice_words": practice_words,
                        "metadata_json": metadata,
                    },
                ]
            )
        else:
            evidence_items.append(
                {
                    "skill_key": "story_creativity",
                    "score_normalized": evaluation.creative_score / 100.0,
                    "confidence": 0.8,
                    "practice_words": practice_words or evaluation.story_anchors[:6],
                    "metadata_json": metadata,
                }
            )
            if evaluation.used_focus_words:
                evidence_items.append(
                    {
                        "skill_key": "vocabulary_naming",
                        "score_normalized": min(1.0, 0.7 + 0.1 * len(evaluation.used_focus_words)),
                        "confidence": 0.75,
                        "practice_words": evaluation.used_focus_words[:6],
                        "metadata_json": metadata,
                    }
                )

        if evaluation.used_focus_words:
            stage_score_norm = (
                evaluation.factual_score / 100.0
                if attempt.Stage == "RECALL"
                else evaluation.creative_score / 100.0
            )
            mastery_score = round(
                max(0.0, min(1.0, stage_score_norm)),
                4,
            )
            evidence_items.append(
                {
                    "skill_key": "difficult_word_mastery",
                    "score_normalized": mastery_score,
                    "confidence": 0.8,
                    "practice_words": evaluation.used_focus_words[:6],
                    "metadata_json": metadata,
                }
            )

        await self.repo.record_skill_evidence(
            child_id=session.ChildId,
            parent_id=session.ParentId,
            source_record_id=str(attempt.Id),
            difficulty_level=session.DifficultyLevel,
            evidence_items=evidence_items,
        )
