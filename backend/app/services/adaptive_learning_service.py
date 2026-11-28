"""Adaptive Learning Engine V4.0 (G03) & Parent Analytics Service (G11).

Deterministic, transparent, non-diagnostic educational adaptation for Vietnamese
primary learners (Grades 1–5, aligned with MOET GDPT 2018).
Zero external AI API calls; zero IQ or medical claims.
"""

from __future__ import annotations

from collections import defaultdict
from datetime import datetime, timezone
from typing import Iterable
from uuid import UUID

from fastapi import HTTPException, status
from sqlalchemy.exc import IntegrityError

from app.repositories.adaptive_learning_repository import AdaptiveLearningRepository
from app.schemas.adaptive_learning import (
    AdaptiveProfileRead,
    CrossGameRecommendationRead,
    DailyFiveMinuteTrainCompleteRequest,
    DailyFiveMinuteTrainCompleteResponse,
    DailyFiveMinuteTrainRead,
    DifficultyDirection,
    EntertainmentRecommendationsRead,
    GameKey,
    KaraokeWeakSegmentSummaryRead,
    ModuleActivitySummaryRead,
    ModuleDifficultyPlan,
    ParentEntertainmentAnalyticsRead,
    SkillEvidenceCreate,
    SkillEvidenceRead,
    SkillMasteryRead,
    SkillStatus,
    SkillTaxonomyItem,
    SpacedDifficultWordRead,
    TrainCar1WarmupRead,
    TrainCar2GameKey,
    TrainCar2GameRoundRead,
    TrainCar3FinishMode,
    TrainCar3FluencyFinishRead,
    TrainWarmupWordItemRead,
)

NON_DIAGNOSTIC_DISCLAIMER_VI = (
    "Tổng hợp này phản ánh các lượt luyện tập thực tế của bé trên ViRead để ba mẹ đồng hành "
    "tại nhà; không phải bài kiểm tra IQ hay chẩn đoán y khoa/tâm lý."
)

# Canonical 16-skill taxonomy aligned with MOET GDPT 2018 Vietnamese Language Grades 1–5.
SKILL_TAXONOMY: tuple[SkillTaxonomyItem, ...] = (
    SkillTaxonomyItem(
        skill_key="phonics_decoding",
        label_vi="Đánh vần & nhận diện vần",
        domain="READING_WORDS",
        description_vi="Nhận diện âm, vần và dấu thanh khi đọc tiếng Việt.",
    ),
    SkillTaxonomyItem(
        skill_key="difficult_word_mastery",
        label_vi="Làm chủ từ khó",
        domain="READING_WORDS",
        description_vi="Ôn luyện lặp lại ngắt quãng các từ bé còn lúng túng khi đọc.",
    ),
    SkillTaxonomyItem(
        skill_key="reading_fluency",
        label_vi="Đọc trôi chảy",
        domain="READING_WORDS",
        description_vi="Nhịp đọc đều, ngắt nghỉ tự nhiên theo dấu câu.",
    ),
    SkillTaxonomyItem(
        skill_key="reading_comprehension",
        label_vi="Hiểu nội dung đọc",
        domain="READING_WORDS",
        description_vi="Hiểu ý chính, nhân vật và chi tiết trong bài đọc.",
    ),
    SkillTaxonomyItem(
        skill_key="vocabulary_naming",
        label_vi="Vốn từ & gọi tên sự vật",
        domain="LANGUAGE_GRAMMAR",
        description_vi="Gọi tên chính xác đồ vật, con vật, màu sắc và hoạt động.",
    ),
    SkillTaxonomyItem(
        skill_key="sentence_ordering",
        label_vi="Sắp xếp trật tự câu",
        domain="LANGUAGE_GRAMMAR",
        description_vi="Ghép các từ/cụm từ thành câu tiếng Việt đúng cấu trúc.",
    ),
    SkillTaxonomyItem(
        skill_key="sentence_cloze",
        label_vi="Điền từ hợp ngữ cảnh",
        domain="LANGUAGE_GRAMMAR",
        description_vi="Chọn từ phù hợp hoàn thiện nghĩa câu văn.",
    ),
    SkillTaxonomyItem(
        skill_key="grammar_awareness",
        label_vi="Cảm nhận ngữ pháp & dấu câu",
        domain="LANGUAGE_GRAMMAR",
        description_vi="Nhận biết từ nối, hành động và dấu câu cơ bản.",
    ),
    SkillTaxonomyItem(
        skill_key="visual_observation",
        label_vi="Quan sát chi tiết tranh",
        domain="OBSERVATION_MEMORY_CREATIVITY",
        description_vi="Nhận ra nhân vật, số lượng, màu sắc và vị trí trong tranh.",
    ),
    SkillTaxonomyItem(
        skill_key="visual_memory_recall",
        label_vi="Ghi nhớ hình ảnh có chủ đích",
        domain="OBSERVATION_MEMORY_CREATIVITY",
        description_vi="Nhớ lại chi tiết đã quan sát sau khi bức tranh ẩn đi.",
    ),
    SkillTaxonomyItem(
        skill_key="descriptive_speaking",
        label_vi="Diễn đạt & miêu tả câu trọn vẹn",
        domain="OBSERVATION_MEMORY_CREATIVITY",
        description_vi="Kể lại điều quan sát bằng lời nói hoặc câu văn mạch lạc.",
    ),
    SkillTaxonomyItem(
        skill_key="story_creativity",
        label_vi="Tưởng tượng & kể tiếp câu chuyện",
        domain="OBSERVATION_MEMORY_CREATIVITY",
        description_vi="Sáng tạo diễn biến mới giàu cảm xúc và trí tưởng tượng.",
    ),
    SkillTaxonomyItem(
        skill_key="inferential_thinking",
        label_vi="Suy luận vì sao & cảm xúc",
        domain="OBSERVATION_MEMORY_CREATIVITY",
        description_vi="Dự đoán cảm xúc nhân vật và nguyên nhân sự việc trong tranh.",
    ),
    SkillTaxonomyItem(
        skill_key="rhythm_timing",
        label_vi="Cảm thụ nhịp điệu",
        domain="MUSIC_RHYTHM",
        description_vi="Vào câu đúng nhịp và giữ tiết tấu ổn định theo nhạc.",
    ),
    SkillTaxonomyItem(
        skill_key="pitch_melody",
        label_vi="Cảm thụ giai điệu & cao độ",
        domain="MUSIC_RHYTHM",
        description_vi="Giữ giọng hát ổn định, lên xuống giai điệu tự nhiên.",
    ),
    SkillTaxonomyItem(
        skill_key="lyric_delivery",
        label_vi="Hát rõ lời & tròn vành",
        domain="MUSIC_RHYTHM",
        description_vi="Phát âm rõ ràng lời bài hát thiếu nhi tiếng Việt.",
    ),
)

VALID_SKILL_KEYS: frozenset[str] = frozenset(item.skill_key for item in SKILL_TAXONOMY)

GAME_SKILL_MAP: dict[GameKey, tuple[str, ...]] = {
    "PICTURE_DESCRIPTION": (
        "visual_observation",
        "descriptive_speaking",
        "vocabulary_naming",
        "inferential_thinking",
    ),
    "SENTENCE_SHOOTER": (
        "sentence_ordering",
        "sentence_cloze",
        "grammar_awareness",
        "difficult_word_mastery",
    ),
    "KARAOKE": ("rhythm_timing", "pitch_melody", "lyric_delivery"),
    "MEMORY_GAME": (
        "visual_memory_recall",
        "visual_observation",
        "story_creativity",
        "vocabulary_naming",
    ),
}

HIGH_CONFIDENCE_THRESHOLD = 0.60
MIN_ATTEMPTS_FOR_ADAPTATION = 3


def compute_adaptive_difficulty(
    child_grade: int,
    attempts: Iterable[tuple[float, float]],
    game_key: GameKey,
) -> ModuleDifficultyPlan:
    """Compute next difficulty strictly requiring >=3 high-confidence observations.

    Prevents erratic difficulty swings from 1 noisy attempt (mic glitch, distraction).
    Each attempt tuple is `(score_normalized [0..1], confidence [0..1])`, newest first.
    """
    baseline = max(1, min(5, int(child_grade)))
    high_conf = [
        (max(0.0, min(1.0, score)), max(0.0, min(1.0, conf)))
        for score, conf in attempts
        if conf >= HIGH_CONFIDENCE_THRESHOLD
    ]
    count = len(high_conf)
    if count < MIN_ATTEMPTS_FOR_ADAPTATION:
        return ModuleDifficultyPlan(
            game_key=game_key,
            recommended_difficulty=baseline,
            baseline_grade_difficulty=baseline,
            direction="HOLD",
            high_confidence_attempts=count,
            requires_more_evidence=True,
            reason_vi=(
                f"Cần thêm {MIN_ATTEMPTS_FOR_ADAPTATION - count} lượt luyện tập rõ ràng "
                f"trước khi tự điều chỉnh độ khó; hiện giữ mức phù hợp lớp {baseline}."
            ),
        )

    recent = high_conf[:5]
    weights = [1.0 / (idx + 1) for idx in range(len(recent))]
    weighted_avg = sum(s * w for (s, _), w in zip(recent, weights)) / sum(weights)
    last_two_strong = len(recent) >= 2 and recent[0][0] >= 0.80 and recent[1][0] >= 0.80

    direction: DifficultyDirection = "HOLD"
    recommended = baseline
    if weighted_avg >= 0.85 and last_two_strong and baseline < 5:
        direction = "INCREASE"
        recommended = min(5, baseline + 1)
        reason_vi = (
            f"Bé hoàn thành rất tốt {count} lượt gần nhất ({round(weighted_avg * 100)}%); "
            f"gợi ý thử sức ở mức {recommended} nhẹ nhàng."
        )
    elif weighted_avg <= 0.45 and baseline > 1:
        direction = "DECREASE"
        recommended = max(1, baseline - 1)
        reason_vi = (
            f"Bé đang cần thêm thời gian làm quen ({round(weighted_avg * 100)}%); "
            f"hạ nhẹ xuống mức {recommended} để bé tự tin hơn."
        )
    else:
        reason_vi = (
            f"Độ khó mức {baseline} đang vừa sức với bé "
            f"(trung bình {round(weighted_avg * 100)}% qua {count} lượt)."
        )

    return ModuleDifficultyPlan(
        game_key=game_key,
        recommended_difficulty=recommended,
        baseline_grade_difficulty=baseline,
        direction=direction,
        high_confidence_attempts=count,
        requires_more_evidence=False,
        reason_vi=reason_vi,
    )


def compute_spaced_difficult_words(
    word_attempts: list,
    *,
    now: datetime | None = None,
    limit: int = 8,
) -> list[SpacedDifficultWordRead]:
    """Rank difficult words for spaced repetition across games (1d -> 3d -> 7d cadence)."""
    from app.services.active_weak_words import (
        classify_vietnamese_phonics_category,
        is_word_mastered_across_contexts,
    )

    ref_now = now or datetime.now(timezone.utc)
    grouped: dict[str, dict] = {}
    for row in word_attempts:
        norm = getattr(row, "NormalizedWord", None) or ""
        display = getattr(row, "DisplayText", None) or norm
        if not norm:
            continue
        bucket = grouped.setdefault(
            norm,
            {
                "display_text": display,
                "attempts": 0,
                "correct": 0,
                "incorrect": 0,
                "last_at": None,
                "rows": [],
            },
        )
        bucket["attempts"] += 1
        bucket["rows"].append(row)
        status_val = getattr(row, "AssessmentStatus", None)
        if status_val == "CORRECT":
            bucket["correct"] += 1
        elif status_val in ("INCORRECT", "UNCERTAIN"):
            bucket["incorrect"] += 1
        ts = getattr(row, "CompletedAt", None) or getattr(row, "CreatedAt", None)
        if ts is not None and (bucket["last_at"] is None or ts > bucket["last_at"]):
            bucket["last_at"] = ts

    ranked: list[SpacedDifficultWordRead] = []
    game_cycle: tuple[GameKey, ...] = (
        "SENTENCE_SHOOTER",
        "PICTURE_DESCRIPTION",
        "MEMORY_GAME",
        "KARAOKE",
    )

    for idx, (norm, info) in enumerate(grouped.items()):
        attempts = info["attempts"]
        correct = info["correct"]
        incorrect = info["incorrect"]
        last_at = info["last_at"]
        mastered = is_word_mastered_across_contexts(info["rows"])
        days_since: int | None = None
        if last_at is not None:
            aware_last = last_at if last_at.tzinfo else last_at.replace(tzinfo=timezone.utc)
            days_since = max(0, (ref_now - aware_last).days)

        # Target spaced interval grows with mastered repetitions: 1d -> 3d -> 7d.
        target_interval = 1 if correct == 0 else (3 if correct == 1 else 7)
        due_bonus = (
            1.5
            if (not mastered or days_since is None or days_since >= target_interval)
            else 0.5
        )
        error_weight = 1.0 + incorrect * 0.8 - correct * 0.35
        priority = round(max(0.1, error_weight * due_bonus), 2)

        phonics_cat, phonics_label = classify_vietnamese_phonics_category(info["display_text"])
        recommended_game = game_cycle[idx % len(game_cycle)]
        if incorrect > correct:
            reason_vi = f"Bé từng gặp khó ở từ này ({phonics_label}); nên ôn nhẹ qua trò chơi."
        elif not mastered and correct == 1:
            reason_vi = "Bé đã nói đúng 1 lần trong góc Giải trí; thử dùng thêm 1 lần nữa để làm chủ nhé!"
        elif days_since is not None and days_since >= target_interval:
            reason_vi = f"Đã {days_since} ngày kể từ lần ôn trước; rất hợp để nhắc lại."
        else:
            reason_vi = "Từ đang luyện gần đây; chơi lồng ghép giúp bé nhớ lâu hơn."

        ranked.append(
            SpacedDifficultWordRead(
                normalized_word=norm,
                display_text=info["display_text"],
                priority_score=priority,
                practice_count=attempts,
                last_practiced_at=last_at,
                days_since_practice=days_since,
                recommended_game=recommended_game,
                reason_vi=reason_vi,
                phonics_category=phonics_cat,
                phonics_label_vi=phonics_label,
            )
        )

    ranked.sort(key=lambda item: (-item.priority_score, item.practice_count, item.normalized_word))
    return ranked[:limit]


def _shooter_session_score_normalized(sess) -> float | None:
    """Compute normalized [0..1] mastery score from real SQLAlchemy GameSession columns.

    `GameSession` stores `CorrectCount`, `MistakeCount`, `TotalStars`,
    `CompletedRounds`, and `TotalRounds` (never a `Score` column).
    """
    correct = int(getattr(sess, "CorrectCount", 0) or 0)
    mistakes = int(getattr(sess, "MistakeCount", 0) or 0)
    total_stars = int(getattr(sess, "TotalStars", 0) or 0)
    completed_rounds = int(getattr(sess, "CompletedRounds", 0) or 0)
    total_rounds = max(1, int(getattr(sess, "TotalRounds", 1) or 1))
    status_val = getattr(sess, "Status", "")

    total_shots = correct + mistakes
    if total_shots == 0 and total_stars == 0 and completed_rounds == 0 and status_val == "IN_PROGRESS":
        return None
    if total_shots > 0:
        accuracy = correct / float(total_shots)
        if completed_rounds > 0:
            star_ratio = min(1.0, total_stars / float(max(1, completed_rounds) * 3))
            return max(0.0, min(1.0, accuracy * 0.7 + star_ratio * 0.3))
        return max(0.0, min(1.0, accuracy))
    if total_stars > 0:
        return max(0.0, min(1.0, total_stars / float(total_rounds * 3)))
    return None


class AdaptiveLearningService:
    """Computes unified child skill evidence, adaptive difficulty, and parent analytics."""

    def __init__(self, repository: AdaptiveLearningRepository) -> None:
        self.repository = repository

    async def _require_child(self, child_id: UUID, parent_id: UUID):
        child = await self.repository.get_owned_child(child_id, parent_id)
        if child is None:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail="Child profile not found",
                headers={"Cache-Control": "private, no-store"},
            )
        return child

    def _synthesize_evidence_rows(
        self,
        explicit_rows: list,
        picture_sessions: list,
        shooter_sessions: list,
        karaoke_sessions: list,
        memory_sessions: list,
        word_attempts: list,
    ) -> dict[str, list[dict]]:
        """Merge persisted learning_skill_evidence with existing module session history.

        Guarantees Parent Analytics and Adaptive Difficulty work seamlessly even when
        historical sessions existed before the V4 migration!
        """
        by_skill: dict[str, list[dict]] = defaultdict(list)
        seen_records: set[tuple[str, str, str]] = set()

        for row in explicit_rows:
            if row.SkillKey not in VALID_SKILL_KEYS:
                continue
            if row.SourceRecordId:
                seen_records.add((row.SourceModule, row.SourceRecordId, row.SkillKey))
            by_skill[row.SkillKey].append(
                {
                    "score": float(row.ScoreNormalized),
                    "confidence": float(row.Confidence),
                    "source_module": row.SourceModule,
                    "created_at": row.CreatedAt,
                }
            )

        for sess in picture_sessions:
            if getattr(sess, "AttemptsCount", 0) <= 0:
                continue
            rec_id = str(sess.Id)
            score = max(0.0, min(1.0, float(sess.BestScore) / 10.0))
            for skill_key in ("visual_observation", "descriptive_speaking"):
                if ("PICTURE_DESCRIPTION", rec_id, skill_key) in seen_records:
                    continue
                by_skill[skill_key].append(
                    {
                        "score": score,
                        "confidence": 0.78,
                        "source_module": "PICTURE_DESCRIPTION",
                        "created_at": sess.UpdatedAt or sess.CreatedAt,
                    }
                )

        for sess in shooter_sessions:
            norm_score = _shooter_session_score_normalized(sess)
            if norm_score is None:
                continue
            rec_id = str(sess.Id)
            if ("SENTENCE_SHOOTER", rec_id, "sentence_ordering") not in seen_records:
                by_skill["sentence_ordering"].append(
                    {
                        "score": norm_score,
                        "confidence": 0.85,
                        "source_module": "SENTENCE_SHOOTER",
                        "created_at": getattr(sess, "CompletedAt", None) or sess.CreatedAt,
                    }
                )

        for sess in karaoke_sessions:
            if sess.ScoringMode == "INSUFFICIENT_EVIDENCE":
                continue
            rec_id = str(sess.Id)
            mapping = [
                ("rhythm_timing", sess.RhythmScore, 0.82),
                ("pitch_melody", sess.PitchScore, 0.78 if sess.ScoringMode == "FULL_MUSICAL" else 0.0),
                ("lyric_delivery", sess.LyricsScore, 0.75),
            ]
            for skill_key, raw_score, conf in mapping:
                if raw_score is None or conf <= 0:
                    continue
                if ("KARAOKE", rec_id, skill_key) in seen_records:
                    continue
                by_skill[skill_key].append(
                    {
                        "score": max(0.0, min(1.0, float(raw_score) / 100.0)),
                        "confidence": conf,
                        "source_module": "KARAOKE",
                        "created_at": sess.CreatedAt,
                    }
                )

        for sess in memory_sessions:
            if sess.AttemptsCount <= 0:
                continue
            rec_id = str(sess.Id)
            if ("MEMORY_GAME", rec_id, "visual_memory_recall") not in seen_records:
                by_skill["visual_memory_recall"].append(
                    {
                        "score": max(0.0, min(1.0, float(sess.BestFactualScore) / 100.0)),
                        "confidence": 0.90,
                        "source_module": "MEMORY_GAME",
                        "created_at": sess.UpdatedAt or sess.CreatedAt,
                    }
                )
            if sess.BestCreativeScore > 0 and ("MEMORY_GAME", rec_id, "story_creativity") not in seen_records:
                by_skill["story_creativity"].append(
                    {
                        "score": max(0.0, min(1.0, float(sess.BestCreativeScore) / 100.0)),
                        "confidence": 0.75,
                        "source_module": "MEMORY_GAME",
                        "created_at": sess.UpdatedAt or sess.CreatedAt,
                    }
                )

        for att in word_attempts:
            status_val = getattr(att, "AssessmentStatus", None)
            if status_val not in ("CORRECT", "INCORRECT", "UNCERTAIN"):
                continue
            rec_id = str(att.Id)
            if ("DIFFICULT_WORD", rec_id, "difficult_word_mastery") in seen_records:
                continue
            score = 1.0 if status_val == "CORRECT" else (0.45 if status_val == "UNCERTAIN" else 0.15)
            by_skill["difficult_word_mastery"].append(
                {
                    "score": score,
                    "confidence": float(getattr(att, "Confidence", None) or 0.7),
                    "source_module": "DIFFICULT_WORD",
                    "created_at": getattr(att, "CompletedAt", None) or att.CreatedAt,
                }
            )

        for items in by_skill.values():
            items.sort(
                key=lambda e: e["created_at"] or datetime.min.replace(tzinfo=timezone.utc),
                reverse=True,
            )
        return by_skill

    def _build_skill_mastery(self, by_skill: dict[str, list[dict]]) -> list[SkillMasteryRead]:
        skills: list[SkillMasteryRead] = []
        for item in SKILL_TAXONOMY:
            entries = by_skill.get(item.skill_key, [])
            if not entries:
                skills.append(
                    SkillMasteryRead(
                        skill_key=item.skill_key,
                        label_vi=item.label_vi,
                        domain=item.domain,
                        status="UNKNOWN",
                        mastery_pct=None,
                        confidence=0.0,
                        evidence_count=0,
                        high_confidence_count=0,
                        last_observed_at=None,
                        source_modules=[],
                    )
                )
                continue

            high_conf_count = sum(1 for e in entries if e["confidence"] >= HIGH_CONFIDENCE_THRESHOLD)
            recent = entries[:8]
            weights = [max(0.2, e["confidence"]) / (idx + 1) for idx, e in enumerate(recent)]
            weighted_score = sum(e["score"] * w for e, w in zip(recent, weights)) / sum(weights)
            avg_conf = sum(e["confidence"] for e in recent) / len(recent)
            status_val: SkillStatus = "OBSERVED" if high_conf_count >= 2 else "ESTIMATED"
            modules = sorted({e["source_module"] for e in entries})

            skills.append(
                SkillMasteryRead(
                    skill_key=item.skill_key,
                    label_vi=item.label_vi,
                    domain=item.domain,
                    status=status_val,
                    mastery_pct=round(max(0.0, min(1.0, weighted_score)) * 100),
                    confidence=round(max(0.0, min(1.0, avg_conf)), 2),
                    evidence_count=len(entries),
                    high_confidence_count=high_conf_count,
                    last_observed_at=entries[0]["created_at"],
                    source_modules=modules,
                )
            )
        return skills

    def _build_difficulty_plans(
        self,
        child_grade: int,
        by_skill: dict[str, list[dict]],
    ) -> list[ModuleDifficultyPlan]:
        plans: list[ModuleDifficultyPlan] = []
        for game_key, skill_keys in GAME_SKILL_MAP.items():
            combined: list[dict] = []
            for sk in skill_keys:
                combined.extend(by_skill.get(sk, []))
            combined.sort(
                key=lambda e: e["created_at"] or datetime.min.replace(tzinfo=timezone.utc),
                reverse=True,
            )
            attempts = [(e["score"], e["confidence"]) for e in combined]
            plans.append(compute_adaptive_difficulty(child_grade, attempts, game_key))
        return plans

    @staticmethod
    def _resolve_teacher_gender(
        child: object,
        explicit_gender: str | None = None,
    ) -> str | None:
        if explicit_gender in ("female", "male"):
            return explicit_gender
        settings = getattr(child, "Settings", None)
        if isinstance(settings, dict):
            vp = settings.get("voice_preferences")
            if isinstance(vp, dict):
                gender = vp.get("gender")
                if gender in ("female", "male"):
                    return str(gender)
                voice_id = str(vp.get("voice_id") or "").strip().lower()
                if any(
                    token in voice_id
                    for token in (
                        "quang_son",
                        "thien_minh",
                        "thai_son",
                        "neural2_d",
                        "wavenet_b",
                        "_male",
                    )
                ):
                    return "male"
                if voice_id:
                    return "female"
        return None

    def _build_recommendations(
        self,
        child_grade: int,
        plans: list[ModuleDifficultyPlan],
        spaced_words: list[SpacedDifficultWordRead],
        picture_count: int,
        shooter_count: int,
        karaoke_count: int,
        memory_count: int,
        *,
        teacher_gender: str | None = None,
    ) -> list[CrossGameRecommendationRead]:
        plan_map = {p.game_key: p for p in plans}
        focus_words = [w.display_text for w in spaced_words[:3]]
        teacher_label = "Thầy giáo AI" if teacher_gender == "male" else "Cô giáo AI"
        counts = {
            "PICTURE_DESCRIPTION": picture_count,
            "SENTENCE_SHOOTER": shooter_count,
            "KARAOKE": karaoke_count,
            "MEMORY_GAME": memory_count,
        }

        recs = [
            CrossGameRecommendationRead(
                game_key="SENTENCE_SHOOTER",
                zone_title_vi="Phiêu lưu cùng chữ",
                game_title_vi="Xạ thủ ghép câu",
                reason_vi=(
                    f"Ôn nhẹ các từ cần nhớ ({', '.join(focus_words)}) qua trò chơi bắn chữ nhanh tay."
                    if focus_words
                    else "Luyện xếp trật tự từ và điền từ vào chỗ trống siêu vui."
                ),
                suggested_mode="FILL_BLANK" if child_grade >= 3 else "WORD_ORDER",
                suggested_difficulty=plan_map["SENTENCE_SHOOTER"].recommended_difficulty,
                target_words=focus_words,
                href="/entertainment/sentence-shooter",
                priority=1 if focus_words else (2 + counts["SENTENCE_SHOOTER"]),
            ),
            CrossGameRecommendationRead(
                game_key="MEMORY_GAME",
                zone_title_vi="Khám phá trí nhớ",
                game_title_vi="Bé nhớ được gì?",
                reason_vi="Quan sát tranh tiếng Việt rực rỡ, rèn trí nhớ hình ảnh và kể tiếp câu chuyện sáng tạo.",
                suggested_mode="FREE_RECALL" if child_grade >= 3 else "GUIDED_RECALL",
                suggested_difficulty=plan_map["MEMORY_GAME"].recommended_difficulty,
                target_words=focus_words[:2],
                href="/entertainment/memory-game",
                priority=1 if counts["MEMORY_GAME"] == 0 else (2 + counts["MEMORY_GAME"]),
            ),
            CrossGameRecommendationRead(
                game_key="PICTURE_DESCRIPTION",
                zone_title_vi="Thế giới kể chuyện",
                game_title_vi=f"Kể chuyện qua tranh cùng {teacher_label}",
                reason_vi=f"Luyện quan sát tranh và mở rộng câu văn cùng {teacher_label} dịu dàng.",
                suggested_mode="STORY" if child_grade >= 3 else "OBSERVE",
                suggested_difficulty=plan_map["PICTURE_DESCRIPTION"].recommended_difficulty,
                target_words=focus_words[:2],
                href="/entertainment/picture-description",
                priority=2 + counts["PICTURE_DESCRIPTION"],
            ),
            CrossGameRecommendationRead(
                game_key="KARAOKE",
                zone_title_vi="Sân khấu âm nhạc",
                game_title_vi="Hát vui cùng bé",
                reason_vi=(
                    f"Hát theo âm quãng mẫu dịu nhẹ và luyện phát âm rõ chữ ({', '.join(focus_words[:2])})."
                    if focus_words
                    else "Thư giãn cùng giai điệu thiếu nhi, tập âm quãng mẫu và hát rõ lời."
                ),
                suggested_mode="RHYTHM_TAP" if counts["KARAOKE"] == 0 else "FULL_SONG",
                suggested_difficulty=plan_map["KARAOKE"].recommended_difficulty,
                target_words=focus_words[:3],
                href="/karaoke",
                priority=2 + counts["KARAOKE"],
            ),
        ]

        recs.sort(key=lambda r: (r.priority, r.game_key))
        return [
            r.model_copy(update={"priority": idx + 1})
            for idx, r in enumerate(recs)
        ]

    async def get_adaptive_profile(
        self,
        child_id: UUID,
        parent_id: UUID,
        *,
        window_days: int = 30,
        teacher_gender: str | None = None,
    ) -> AdaptiveProfileRead:
        child = await self._require_child(child_id, parent_id)
        resolved_gender = self._resolve_teacher_gender(child, teacher_gender)
        explicit_rows = await self.repository.list_skill_evidence(child_id, window_days=90)
        word_attempts = await self.repository.list_difficult_word_attempts(child_id, window_days=90)
        picture_sessions = await self.repository.list_picture_sessions(child_id, window_days=window_days)
        shooter_sessions = await self.repository.list_shooter_sessions(child_id, window_days=window_days)
        karaoke_sessions = await self.repository.list_karaoke_sessions(child_id, window_days=window_days)
        memory_sessions = await self.repository.list_memory_sessions(child_id, window_days=window_days)

        by_skill = self._synthesize_evidence_rows(
            explicit_rows,
            picture_sessions,
            shooter_sessions,
            karaoke_sessions,
            memory_sessions,
            word_attempts,
        )
        skills = self._build_skill_mastery(by_skill)
        plans = self._build_difficulty_plans(child.Grade, by_skill)
        spaced_words = compute_spaced_difficult_words(word_attempts)
        recommendations = self._build_recommendations(
            child.Grade,
            plans,
            spaced_words,
            len(picture_sessions),
            len(shooter_sessions),
            len(karaoke_sessions),
            len(memory_sessions),
            teacher_gender=resolved_gender,
        )

        return AdaptiveProfileRead(
            child_id=child.Id,
            child_alias=child.Alias,
            child_grade=child.Grade,
            is_diagnostic=False,
            disclaimer_vi=NON_DIAGNOSTIC_DISCLAIMER_VI,
            observed_skills_count=sum(1 for s in skills if s.status == "OBSERVED"),
            estimated_skills_count=sum(1 for s in skills if s.status == "ESTIMATED"),
            unknown_skills_count=sum(1 for s in skills if s.status == "UNKNOWN"),
            skills=skills,
            difficulty_plans=plans,
            spaced_difficult_words=spaced_words,
            recommendations=recommendations,
            generated_at=datetime.now(timezone.utc),
        )

    async def get_entertainment_recommendations(
        self,
        child_id: UUID,
        parent_id: UUID,
        *,
        teacher_gender: str | None = None,
    ) -> EntertainmentRecommendationsRead:
        resolved_gender = teacher_gender if teacher_gender in ("female", "male") else None
        if resolved_gender is None:
            try:
                child = await self._require_child(child_id, parent_id)
                resolved_gender = self._resolve_teacher_gender(child, None)
            except Exception:
                resolved_gender = None

        profile = await self.get_adaptive_profile(
            child_id,
            parent_id,
            window_days=7,
            teacher_gender=resolved_gender,
        )
        today_utc = datetime.now(timezone.utc).date()
        recent_pic = await self.repository.list_picture_sessions(child_id, window_days=2)
        recent_shoot = await self.repository.list_shooter_sessions(child_id, window_days=2)
        recent_kar = await self.repository.list_karaoke_sessions(child_id, window_days=2)
        recent_mem = await self.repository.list_memory_sessions(child_id, window_days=2)

        today_count = sum(
            1
            for row in (*recent_pic, *recent_shoot, *recent_kar, *recent_mem)
            if row.CreatedAt and row.CreatedAt.date() == today_utc
        )

        if today_count >= 4:
            break_msg = (
                f"Hôm nay {profile.child_alias} đã chơi {today_count} hoạt động rồi! "
                "Bé nhớ nghỉ mắt 5 phút và uống một ngụm nước mát nhé."
            )
        else:
            break_msg = "Mỗi phiên chơi khoảng 10–15 phút là vừa đẹp để mắt bé luôn khỏe mạnh."

        primary = profile.recommendations[0]
        if resolved_gender == "male":
            greeting = (
                f"Chào {profile.child_alias}! Hôm nay thầy trò mình cùng khám phá \"{primary.game_title_vi}\" nhé!"
            )
        elif resolved_gender == "female":
            greeting = (
                f"Chào {profile.child_alias}! Hôm nay cô trò mình cùng khám phá \"{primary.game_title_vi}\" nhé!"
            )
        else:
            greeting = (
                f"Chào {profile.child_alias}! Hôm nay mình cùng khám phá \"{primary.game_title_vi}\" nhé!"
            )

        return EntertainmentRecommendationsRead(
            child_id=profile.child_id,
            child_alias=profile.child_alias,
            child_grade=profile.child_grade,
            mascot_greeting_vi=greeting,
            natural_break_reminder_vi=break_msg,
            today_activities_count=today_count,
            focus_difficult_words=[w.display_text for w in profile.spaced_difficult_words[:5]],
            primary_recommendation=primary,
            recommendations=profile.recommendations,
        )

    async def get_parent_analytics(
        self,
        child_id: UUID,
        parent_id: UUID,
        *,
        window_days: int = 30,
        teacher_gender: str | None = None,
    ) -> ParentEntertainmentAnalyticsRead:
        child = await self._require_child(child_id, parent_id)
        resolved_gender = self._resolve_teacher_gender(child, teacher_gender)
        teacher_label = "Thầy giáo AI" if resolved_gender == "male" else "Cô giáo AI"
        explicit_rows = await self.repository.list_skill_evidence(child_id, window_days=window_days)
        word_attempts = await self.repository.list_difficult_word_attempts(child_id, window_days=window_days)
        picture_sessions = await self.repository.list_picture_sessions(child_id, window_days=window_days)
        shooter_sessions = await self.repository.list_shooter_sessions(child_id, window_days=window_days)
        karaoke_sessions = await self.repository.list_karaoke_sessions(child_id, window_days=window_days)
        memory_sessions = await self.repository.list_memory_sessions(child_id, window_days=window_days)

        by_skill = self._synthesize_evidence_rows(
            explicit_rows,
            picture_sessions,
            shooter_sessions,
            karaoke_sessions,
            memory_sessions,
            word_attempts,
        )
        skills = self._build_skill_mastery(by_skill)
        spaced_words = compute_spaced_difficult_words(word_attempts, limit=10)

        pic_scores = [s.BestScore * 10 for s in picture_sessions if s.AttemptsCount > 0]
        shoot_scores = [
            round(score * 100)
            for s in shooter_sessions
            if (score := _shooter_session_score_normalized(s)) is not None
        ]
        kar_scores = [
            s.OverallScore
            for s in karaoke_sessions
            if s.OverallScore is not None and s.ScoringMode != "INSUFFICIENT_EVIDENCE"
        ]
        mem_scores = [s.BestFactualScore for s in memory_sessions if s.AttemptsCount > 0]

        module_activities = [
            ModuleActivitySummaryRead(
                game_key="PICTURE_DESCRIPTION",
                title_vi=f"Kể chuyện qua tranh cùng {teacher_label}",
                sessions_count=len(picture_sessions),
                recent_average_pct=round(sum(pic_scores) / len(pic_scores)) if pic_scores else None,
                highlight_vi=(
                    f"{len(picture_sessions)} buổi kể chuyện tranh trong {window_days} ngày qua."
                    if picture_sessions
                    else "Chưa có buổi kể chuyện tranh trong kỳ này."
                ),
            ),
            ModuleActivitySummaryRead(
                game_key="SENTENCE_SHOOTER",
                title_vi="Xạ thủ ghép câu",
                sessions_count=len(shooter_sessions),
                recent_average_pct=round(sum(shoot_scores) / len(shoot_scores)) if shoot_scores else None,
                highlight_vi=(
                    f"{len(shooter_sessions)} lượt ghép câu từ sách của bé."
                    if shooter_sessions
                    else "Chưa có lượt chơi Xạ thủ ghép câu trong kỳ này."
                ),
            ),
            ModuleActivitySummaryRead(
                game_key="KARAOKE",
                title_vi="Hát vui cùng bé (Karaoke âm nhạc)",
                sessions_count=len(karaoke_sessions),
                recent_average_pct=round(sum(kar_scores) / len(kar_scores)) if kar_scores else None,
                highlight_vi=(
                    f"{len(karaoke_sessions)} lượt hát luyện nhịp & giai điệu."
                    if karaoke_sessions
                    else "Chưa có lượt luyện hát Karaoke trong kỳ này."
                ),
            ),
            ModuleActivitySummaryRead(
                game_key="MEMORY_GAME",
                title_vi="Bé nhớ được gì? (Trí nhớ & Sáng tạo)",
                sessions_count=len(memory_sessions),
                recent_average_pct=round(sum(mem_scores) / len(mem_scores)) if mem_scores else None,
                highlight_vi=(
                    f"{len(memory_sessions)} lượt luyện ghi nhớ chi tiết và kể chuyện sáng tạo."
                    if memory_sessions
                    else "Chưa có lượt chơi Bé nhớ được gì? trong kỳ này."
                ),
            ),
        ]

        weak_segments: list[KaraokeWeakSegmentSummaryRead] = []
        for sess in karaoke_sessions:
            payload = sess.ReportPayload if isinstance(sess.ReportPayload, dict) else {}
            weakest = payload.get("weakest_segment") or payload.get("weakestSegment")
            if isinstance(weakest, dict) and weakest.get("text"):
                start_ms = int(weakest.get("start_ms", weakest.get("startMs", 0)) or 0)
                end_ms = int(weakest.get("end_ms", weakest.get("endMs", start_ms + 3000)) or (start_ms + 3000))
                if end_ms > start_ms:
                    weak_segments.append(
                        KaraokeWeakSegmentSummaryRead(
                            song_id=sess.SongId,
                            line_text=str(weakest.get("text"))[:160],
                            start_ms=start_ms,
                            end_ms=end_ms,
                            tip_vi=str(
                                weakest.get("tip_vi")
                                or weakest.get("tipVi")
                                or "Bé có thể nghe chậm 0.85x và hát lại đoạn này 1–2 lần."
                            ),
                        )
                    )
            if len(weak_segments) >= 3:
                break

        tips: list[str] = []
        if spaced_words:
            top_words = ", ".join(w.display_text for w in spaced_words[:3])
            tips.append(
                f"Ba mẹ có thể cùng bé đặt 1 câu vui mỗi tối với các từ: {top_words}."
            )
        observed_sorted = sorted(
            [s for s in skills if s.status == "OBSERVED" and s.mastery_pct is not None],
            key=lambda s: s.mastery_pct or 0,
        )
        if observed_sorted:
            lowest = observed_sorted[0]
            highest = observed_sorted[-1]
            tips.append(
                f"Điểm sáng gần đây: bé thể hiện tốt ở \"{highest.label_vi}\" ({highest.mastery_pct}%). "
                "Hãy khen cụ thể nỗ lực của bé nhé!"
            )
            if lowest.skill_key != highest.skill_key and (lowest.mastery_pct or 100) < 75:
                tips.append(
                    f"Kỹ năng nên đồng hành thêm: \"{lowest.label_vi}\" — mỗi tuần chơi 2 lượt ngắn 10 phút là đủ."
                )
        if weak_segments:
            tips.append(
                "Khi hát Karaoke, dùng chế độ luyện đoạn ngắn 0.85x giúp bé bắt nhịp dễ dàng hơn mà không bị áp lực."
            )
        if not tips:
            tips.append(
                "Hãy để bé tự chọn 1 hoạt động giải trí mỗi ngày (10–15 phút) để hệ thống có đủ dữ liệu quan sát thực tế."
            )

        return ParentEntertainmentAnalyticsRead(
            child_id=child.Id,
            child_alias=child.Alias,
            child_grade=child.Grade,
            window_days=window_days,
            is_diagnostic=False,
            disclaimer_vi=NON_DIAGNOSTIC_DISCLAIMER_VI,
            observed_skills_count=sum(1 for s in skills if s.status == "OBSERVED"),
            estimated_skills_count=sum(1 for s in skills if s.status == "ESTIMATED"),
            unknown_skills_count=sum(1 for s in skills if s.status == "UNKNOWN"),
            skills=skills,
            practiced_difficult_words=spaced_words,
            module_activities=module_activities,
            karaoke_weak_segments=weak_segments,
            home_support_tips_vi=tips[:4],
            generated_at=datetime.now(timezone.utc),
        )

    async def record_evidence(
        self,
        child_id: UUID,
        parent_id: UUID,
        payload: SkillEvidenceCreate,
    ) -> SkillEvidenceRead:
        if payload.skill_key not in VALID_SKILL_KEYS:
            raise HTTPException(
                status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
                detail="Unknown skill_key",
            )
        await self._require_child(child_id, parent_id)
        try:
            row = await self.repository.create_evidence(
                child_id=child_id,
                parent_id=parent_id,
                skill_key=payload.skill_key,
                source_module=payload.source_module,
                source_record_id=payload.source_record_id,
                evidence_type=payload.evidence_type,
                score_normalized=payload.score_normalized,
                confidence=payload.confidence,
                difficulty_level=payload.difficulty_level,
                practice_words=payload.practice_words,
                metadata_json=payload.metadata_json,
            )
            await self.repository.db.commit()
        except IntegrityError as exc:
            await self.repository.db.rollback()
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail="Duplicate skill evidence record",
            ) from exc
        return SkillEvidenceRead(
            id=row.Id,
            child_id=row.ChildId,
            skill_key=row.SkillKey,
            source_module=row.SourceModule,
            score_normalized=row.ScoreNormalized,
            confidence=row.Confidence,
            difficulty_level=row.DifficultyLevel,
            created_at=row.CreatedAt,
        )

    @staticmethod
    def _build_syllable_hint_vi(display_text: str, phonics_category: str) -> str:
        from app.services.active_weak_words import tokenize_focus_phrase
        from app.services.vietnamese_phonics import build_vietnamese_phonics_steps

        tokens = tokenize_focus_phrase(display_text)
        syllable_join = " · ".join(tokens) if tokens else display_text
        steps = build_vietnamese_phonics_steps(display_text)
        blend_preview = ""
        for step in steps:
            if step.get("id") in ("onset_blend", "rhyme_build", "tone_blend"):
                blend_preview = str(step.get("spoken_text") or "").rstrip(".")
                if blend_preview:
                    break

        cue_by_cat = {
            "l_n": "Đặt đầu lưỡi chạm nhẹ lợi trên cho âm l, hạ mềm cho âm n.",
            "s_x": "Cong nhẹ đầu lưỡi ở âm s, thả nhẹ hơi phẳng ở âm x.",
            "tr_ch": "Cong đầu lưỡi khi đọc tr, bật nhẹ mặt lưỡi khi đọc ch.",
            "r_d_gi": "Rung nhẹ đầu lưỡi ở âm r, giữ hơi êm ở âm d/gi.",
            "hoi_nga": "Thanh hỏi hạ nhẹ rồi nâng êm; thanh ngã nhấn nhịp giữa rõ ràng.",
            "coda_n_ng_t_c": "Khép gọn âm cuối để tiếng tròn vành, rõ chữ.",
            "compound_reduplicative": "Đọc liền mạch hai tiếng theo nhịp đều, không ngắt rời.",
            "general": "Nghe mẫu chậm rồi đọc rõ từng tiếng thật bình tĩnh.",
        }
        cue = cue_by_cat.get(phonics_category, cue_by_cat["general"])
        if blend_preview:
            return f"Tách tiếng: {syllable_join} ({blend_preview}) — {cue}"
        return f"Tách tiếng: {syllable_join} — {cue}"

    @staticmethod
    def _cold_start_words_for_grade(grade: int) -> tuple[tuple[str, str], ...]:
        clamped = max(1, min(5, int(grade)))
        by_grade: dict[int, tuple[tuple[str, str], ...]] = {
            1: (
                ("con trâu", "Con trâu thong thả gặm cỏ bên bờ đê."),
                ("bông sen", "Bông sen hồng tỏa hương thơm dịu buổi sớm."),
                ("cây tre", "Hàng cây tre xanh rì rào đón gió mát."),
            ),
            2: (
                ("chim sẻ", "Chú chim sẻ nhỏ nhảy nhót trên cành cây."),
                ("giọt sương", "Giọt sương sớm long lanh trên chiếc lá non."),
                ("lung linh", "Ánh trăng rằm tỏa sáng lung linh trên sân nhà."),
            ),
            3: (
                ("trong trẻo", "Tiếng suối chảy nghe thật trong trẻo và êm tai."),
                ("rực rỡ", "Vườn hoa mùa xuân nở rộ sắc màu rực rỡ."),
                ("cánh đồng", "Cánh đồng lúa chín vàng ươm dưới nắng mai."),
            ),
            4: (
                ("khúc khuỷu", "Con đường nhỏ quanh đồi uốn lượn khúc khuỷu."),
                ("xôn xao", "Tiếng lá thu xôn xao gọi mùa tựu trường về."),
                ("truyền thống", "Làng nghề giữ gìn nét đẹp truyền thống lâu đời."),
            ),
            5: (
                ("nghiêng nghiêng", "Bóng tre nghiêng nghiêng soi mát dòng sông quê."),
                ("sáng suốt", "Đọc kỹ từng câu giúp em suy nghĩ sáng suốt hơn."),
                ("trưởng thành", "Mỗi trang sách hay giúp chúng em thêm trưởng thành."),
            ),
        }
        return by_grade[clamped]

    @staticmethod
    def _build_fluency_passage(
        grade: int,
        phonics_category: str,
        target_words: list[str],
    ) -> tuple[str, str, str]:
        lead_words = ", ".join(target_words[:2]) if target_words else "từ vừa ôn"
        w0 = target_words[0] if target_words else "cây tre"
        w1 = target_words[1] if len(target_words) > 1 else w0

        if grade <= 2:
            by_cat: dict[str, tuple[str, str, str]] = {
                "tr_ch": (
                    "Buổi sớm bên hàng tre",
                    f"Buổi sớm, nắng chiếu nhẹ qua hàng tre xanh. Bé thong thả đọc rõ tiếng {w0} và {w1} thật êm tai.",
                    "Đọc chậm vừa phải, cong nhẹ đầu lưỡi ở các tiếng có âm tr và nghỉ hơi ở dấu chấm.",
                ),
                "s_x": (
                    "Giọt sương mùa xuân",
                    f"Sáng sớm, sương mai đậu trên lá xanh mát. Bé mỉm cười đọc vang từ {w0} cùng {w1} thật tròn vành.",
                    "Giữ nhịp thở nhẹ, phân biệt êm âm s và âm x mà không cần vội vàng.",
                ),
                "l_n": (
                    "Nắng lên lung linh",
                    f"Nắng non lan nhẹ trên lối nhỏ quanh sân. Bé bình tĩnh đọc từng tiếng {w0} và {w1} thật rõ ràng.",
                    "Chú ý vị trí đầu lưỡi ở âm l và âm n, ngắt nhịp nhẹ sau dấu phẩy.",
                ),
                "hoi_nga": (
                    "Kể chuyện buổi chiều",
                    f"Gió mát khẽ đưa hương hoa bưởi ngoài ngõ nhỏ. Bé đọc chậm rãi từ {w0} và {w1} đúng dấu thanh.",
                    "Ngân nhẹ ở các tiếng có thanh hỏi và thanh ngã để câu đọc mềm mại hơn.",
                ),
            }
            if phonics_category in by_cat:
                return by_cat[phonics_category]
            return (
                "Góc đọc sách ấm áp",
                f"Mỗi ngày năm phút, bé mở trang sách nhỏ bên cửa sổ. Bé đọc trôi chảy từ {w0} và {w1} với giọng thật vui.",
                f"Nghe mẫu chậm 0.85x nếu cần, rồi đọc liền mạch câu có từ {lead_words}.",
            )

        return (
            "Hành trình năm phút mỗi ngày",
            (
                f"Buổi chiều yên ả, ánh nắng dịu nhẹ trải trên bàn học nhỏ. "
                f"Em đọc chậm rãi, rõ ràng từng câu văn có từ {w0} và {w1}, giữ nhịp ngắt nghỉ tự nhiên theo dấu câu."
            ),
            f"Giữ tốc độ vừa sức, nhấn nhẹ ở cụm từ {lead_words} và nghỉ hơi thoải mái cuối câu.",
        )

    async def get_daily_five_minute_train(
        self,
        child_id: UUID,
        parent_id: UUID,
        *,
        teacher_gender: str | None = None,
    ) -> DailyFiveMinuteTrainRead:
        from app.services.active_weak_words import (
            classify_vietnamese_phonics_category,
            normalize_focus_phrase,
            tokenize_focus_phrase,
        )

        child = await self._require_child(child_id, parent_id)
        resolved_gender = self._resolve_teacher_gender(child, teacher_gender)
        teacher_label = "Thầy giáo AI" if resolved_gender == "male" else "Cô giáo AI"
        now_utc = datetime.now(timezone.utc)
        today_utc = now_utc.date()

        explicit_rows = await self.repository.list_skill_evidence(child_id, window_days=90)
        word_attempts = await self.repository.list_difficult_word_attempts(child_id, window_days=90)
        picture_sessions = await self.repository.list_picture_sessions(child_id, window_days=30)
        shooter_sessions = await self.repository.list_shooter_sessions(child_id, window_days=30)
        karaoke_sessions = await self.repository.list_karaoke_sessions(child_id, window_days=30)
        memory_sessions = await self.repository.list_memory_sessions(child_id, window_days=30)

        by_skill = self._synthesize_evidence_rows(
            explicit_rows,
            picture_sessions,
            shooter_sessions,
            karaoke_sessions,
            memory_sessions,
            word_attempts,
        )
        plans = self._build_difficulty_plans(child.Grade, by_skill)
        plan_map = {p.game_key: p for p in plans}
        spaced_words = compute_spaced_difficult_words(word_attempts, now=now_utc, limit=6)

        is_cold_start = len(spaced_words) == 0
        warmup_items: list[TrainWarmupWordItemRead] = []
        seen_norms: set[str] = set()

        for sw in spaced_words[:3]:
            norm = normalize_focus_phrase(sw.display_text) or sw.normalized_word
            if not norm or norm in seen_norms:
                continue
            seen_norms.add(norm)
            warmup_items.append(
                TrainWarmupWordItemRead(
                    normalized_word=norm,
                    display_text=sw.display_text,
                    phonics_category=sw.phonics_category,
                    phonics_label_vi=sw.phonics_label_vi,
                    syllable_hint_vi=self._build_syllable_hint_vi(
                        sw.display_text, sw.phonics_category
                    ),
                    sample_sentence_vi=f"Bé đọc rõ từ {sw.display_text} trong câu ngắn thật bình tĩnh.",
                    source="SPACED_DIFFICULT_WORD",
                )
            )

        for cold_word, cold_sentence in self._cold_start_words_for_grade(child.Grade):
            if len(warmup_items) >= 3:
                break
            norm = normalize_focus_phrase(cold_word)
            if not norm or norm in seen_norms:
                continue
            seen_norms.add(norm)
            p_cat, p_label = classify_vietnamese_phonics_category(cold_word)
            warmup_items.append(
                TrainWarmupWordItemRead(
                    normalized_word=norm,
                    display_text=cold_word,
                    phonics_category=p_cat,
                    phonics_label_vi=p_label,
                    syllable_hint_vi=self._build_syllable_hint_vi(cold_word, p_cat),
                    sample_sentence_vi=cold_sentence,
                    source="COLD_START_GRADE",
                )
            )

        cat_counts: dict[str, int] = defaultdict(int)
        cat_labels: dict[str, str] = {}
        for item in warmup_items:
            cat_counts[item.phonics_category] += 1
            cat_labels[item.phonics_category] = item.phonics_label_vi
        dominant_cat = max(
            cat_counts,
            key=lambda key: (cat_counts[key], 1 if key != "general" else 0),
        )
        dominant_label = cat_labels[dominant_cat]
        seeded_words = [w.display_text for w in warmup_items]

        car_1 = TrainCar1WarmupRead(
            title_vi="Toa 1: Khởi động từ khó",
            subtitle_vi=(
                f"Làm quen nhẹ 3 từ phù hợp lớp {child.Grade} cùng {teacher_label}."
                if is_cold_start
                else f"Ôn nhẹ {len(warmup_items)} từ thuộc nhóm \"{dominant_label}\" cùng {teacher_label}."
            ),
            estimated_seconds=90,
            dominant_phonics_category=dominant_cat,
            dominant_phonics_label_vi=dominant_label,
            target_words=warmup_items,
        )

        prefer_picture = (
            bool(spaced_words)
            and spaced_words[0].recommended_game == "PICTURE_DESCRIPTION"
        ) or (len(shooter_sessions) > len(picture_sessions) + 1)
        car_2_game_key: TrainCar2GameKey = (
            "PICTURE_DESCRIPTION" if prefer_picture else "SENTENCE_SHOOTER"
        )
        car_2_plan = plan_map[car_2_game_key]

        w_first = seeded_words[0]
        w_second = seeded_words[1] if len(seeded_words) > 1 else w_first
        if car_2_game_key == "PICTURE_DESCRIPTION":
            round_sentence = f"Trong tranh có {w_first} và {w_second} thật đẹp"
            suggested_mode = "STORY" if child.Grade >= 3 else "OBSERVE"
            prompt_vi = (
                f"Quan sát chi tiết gợi ý và ghép câu miêu tả có từ \"{w_first}\", \"{w_second}\"."
            )
            deep_link_href = "/entertainment/picture-description"
        else:
            round_sentence = f"Bé đọc rõ từ {w_first} và {w_second} mỗi ngày"
            suggested_mode = "FILL_BLANK" if child.Grade >= 3 else "WORD_ORDER"
            prompt_vi = (
                f"Chạm chọn đúng thứ tự các từ để hoàn thành câu có \"{w_first}\" và \"{w_second}\"."
            )
            deep_link_href = "/entertainment/sentence-shooter"

        sentence_tokens = tokenize_focus_phrase(round_sentence)
        if len(sentence_tokens) < 3:
            sentence_tokens = ["bé", "đọc", w_first]
        distractor_pool = ["lấp lánh", "nhanh nhảu", "bình minh", "êm đềm"]
        distractors = [
            d for d in distractor_pool if normalize_focus_phrase(d) not in seen_norms
        ][:2]

        car_2 = TrainCar2GameRoundRead(
            title_vi="Toa 2: Vận dụng qua trò chơi",
            subtitle_vi=(
                "1 vòng Kể chuyện qua tranh gắn kết từ vừa khởi động."
                if car_2_game_key == "PICTURE_DESCRIPTION"
                else "1 vòng Xạ thủ ghép câu gắn kết đúng các từ vừa khởi động."
            ),
            estimated_seconds=120,
            game_key=car_2_game_key,
            suggested_mode=suggested_mode,
            recommended_difficulty=car_2_plan.recommended_difficulty,
            seeded_words=seeded_words,
            prompt_vi=prompt_vi,
            sentence_tokens=sentence_tokens,
            distractor_tokens=distractors,
            deep_link_href=deep_link_href,
        )

        weak_karaoke_line: str | None = None
        weak_karaoke_tip: str | None = None
        for sess in karaoke_sessions:
            payload = getattr(sess, "ReportPayload", None)
            if isinstance(payload, dict):
                weakest = payload.get("weakest_segment") or payload.get("weakestSegment")
                if isinstance(weakest, dict) and weakest.get("text"):
                    weak_karaoke_line = str(weakest["text"]).strip()[:180]
                    weak_karaoke_tip = str(
                        weakest.get("tip_vi")
                        or weakest.get("tipVi")
                        or "Nghe mẫu tốc độ chậm 0.85x rồi ngân nga nhẹ nhàng theo từng nhịp chữ."
                    )
                    break

        if weak_karaoke_line:
            finish_mode: TrainCar3FinishMode = "SLOW_KARAOKE_085X"
            passage_title = "Câu hát chậm 0.85x"
            text_vi = f"{weak_karaoke_line} — cùng ôn nhẹ {', '.join(seeded_words[:2])}."
            coaching_tip = weak_karaoke_tip or "Nghe chậm 0.85x và hát rõ từng tiếng thật thư giãn."
        else:
            finish_mode = "SHORT_PASSAGE"
            passage_title, text_vi, coaching_tip = self._build_fluency_passage(
                child.Grade,
                dominant_cat,
                seeded_words,
            )

        car_3 = TrainCar3FluencyFinishRead(
            title_vi="Toa 3: Về đích trôi chảy",
            subtitle_vi=(
                "Nghe và hát chậm 0.85x thật êm để khép lại chuyến tàu."
                if finish_mode == "SLOW_KARAOKE_085X"
                else "Đọc đoạn ngắn có nhóm vần vừa ôn ở nhịp 0.85x thật thư thái."
            ),
            estimated_seconds=90,
            finish_mode=finish_mode,
            playback_speed=0.85,
            phonics_category=dominant_cat,
            phonics_label_vi=dominant_label,
            passage_title_vi=passage_title,
            text_vi=text_vi,
            featured_words=seeded_words,
            coaching_tip_vi=coaching_tip,
        )

        completed_keys_today: set[str] = set()
        for row in explicit_rows:
            created = getattr(row, "CreatedAt", None)
            meta = getattr(row, "MetadataJson", None)
            if (
                created is not None
                and created.date() == today_utc
                and isinstance(meta, dict)
                and meta.get("origin") == "DAILY_FIVE_MINUTE_TRAIN"
            ):
                key = str(
                    meta.get("train_completion_key")
                    or getattr(row, "SourceRecordId", None)
                    or getattr(row, "Id", "")
                )
                completed_keys_today.add(key)

        train_id = f"train-{child.Id}-{today_utc.isoformat()}"
        if resolved_gender == "male":
            greeting_vi = (
                f"Chào {child.Alias}! Lên chuyến tàu 5 phút cùng thầy để khởi động 3 toa thật nhẹ nhàng nhé!"
            )
        elif resolved_gender == "female":
            greeting_vi = (
                f"Chào {child.Alias}! Lên chuyến tàu 5 phút cùng cô để khởi động 3 toa thật nhẹ nhàng nhé!"
            )
        else:
            greeting_vi = (
                f"Chào {child.Alias}! Mình cùng khởi hành chuyến tàu luyện đọc 5 phút qua 3 toa vui nhé!"
            )

        return DailyFiveMinuteTrainRead(
            train_id=train_id,
            visibility="PARENT_PRIVATE",
            child_id=child.Id,
            child_alias=child.Alias,
            child_grade=child.Grade,
            total_estimated_seconds=300,
            is_cold_start=is_cold_start,
            completed_today=len(completed_keys_today) > 0,
            today_completed_count=len(completed_keys_today),
            greeting_vi=greeting_vi,
            no_mic_support_note_vi=(
                "Nếu đang ở nơi ồn hoặc tạm không tiện bật mic, ba mẹ và bé có thể bật chế độ "
                "\"Tạm không tiện bật mic\" để nghe mẫu và chạm chọn hoàn thành trọn vẹn cả 3 toa."
            ),
            natural_break_cue_vi=(
                f"Hoàn thành ~5 phút hôm nay là vừa đẹp rồi! {child.Alias} nhớ chớp mắt nhẹ, "
                "nhìn ra xa thư giãn mắt và uống một ngụm nước mát trước khi nghỉ ngơi nhé."
            ),
            disclaimer_vi=NON_DIAGNOSTIC_DISCLAIMER_VI,
            car_1_warmup=car_1,
            car_2_game=car_2,
            car_3_fluency=car_3,
            generated_at=now_utc,
        )

    async def complete_daily_five_minute_train(
        self,
        child_id: UUID,
        parent_id: UUID,
        payload: DailyFiveMinuteTrainCompleteRequest,
    ) -> DailyFiveMinuteTrainCompleteResponse:
        child = await self._require_child(child_id, parent_id)
        now_utc = datetime.now(timezone.utc)
        today_utc = now_utc.date()

        if not (payload.car_1_completed or payload.car_2_completed or payload.car_3_completed):
            raise HTTPException(
                status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
                detail="At least one train car must be completed",
            )

        clean_words = [
            w.strip() for w in payload.practiced_words if isinstance(w, str) and w.strip()
        ][:10]

        if payload.interaction_mode == "NO_MIC_TOUCH":
            evidence_type = "ESTIMATED"
            base_conf = 0.58
        elif payload.interaction_mode == "MIXED":
            evidence_type = "OBSERVED"
            base_conf = 0.72
        else:
            evidence_type = "OBSERVED"
            base_conf = 0.80

        completion_token = (payload.client_completion_id or payload.train_id).strip()[:48]
        difficulty = max(1, min(5, int(child.Grade)))

        def _car_score(car_key: str, default: float = 0.85) -> float:
            raw = payload.car_scores.get(car_key, default)
            try:
                return max(0.0, min(1.0, float(raw)))
            except (TypeError, ValueError):
                return default

        planned_specs: list[tuple[str, str, str, float]] = []
        if payload.car_1_completed:
            planned_specs.append(
                ("c1", "difficult_word_mastery", "DIFFICULT_WORD", _car_score("car_1", 0.85))
            )
        if payload.car_2_completed:
            if payload.car_2_game_key == "PICTURE_DESCRIPTION":
                planned_specs.append(
                    ("c2", "descriptive_speaking", "PICTURE_DESCRIPTION", _car_score("car_2", 0.86))
                )
            else:
                planned_specs.append(
                    ("c2", "sentence_ordering", "SENTENCE_SHOOTER", _car_score("car_2", 0.88))
                )
        if payload.car_3_completed:
            if payload.car_3_finish_mode == "SLOW_KARAOKE_085X":
                planned_specs.append(
                    ("c3", "lyric_delivery", "KARAOKE", _car_score("car_3", 0.86))
                )
            else:
                planned_specs.append(
                    ("c3", "reading_fluency", "READING", _car_score("car_3", 0.88))
                )

        recorded_items: list[SkillEvidenceRead] = []
        for suffix, skill_key, source_module, score_val in planned_specs:
            source_record_id = f"train5m:{completion_token}:{suffix}"[:64]
            ev_create = SkillEvidenceCreate(
                skill_key=skill_key,
                source_module=source_module,  # type: ignore[arg-type]
                source_record_id=source_record_id,
                evidence_type=evidence_type,  # type: ignore[arg-type]
                score_normalized=score_val,
                confidence=base_conf,
                difficulty_level=difficulty,
                practice_words=clean_words,
                metadata_json={
                    "origin": "DAILY_FIVE_MINUTE_TRAIN",
                    "train_id": payload.train_id,
                    "train_completion_key": completion_token,
                    "interaction_mode": payload.interaction_mode,
                    "duration_seconds": payload.duration_seconds,
                    "car": suffix,
                },
            )
            try:
                created = await self.record_evidence(child_id, parent_id, ev_create)
                recorded_items.append(created)
            except HTTPException as exc:
                if exc.status_code != status.HTTP_409_CONFLICT:
                    raise

        recent_evidence = await self.repository.list_skill_evidence(child_id, window_days=2)
        completed_keys_today: set[str] = {completion_token}
        for row in recent_evidence:
            created_at = getattr(row, "CreatedAt", None)
            meta = getattr(row, "MetadataJson", None)
            if (
                created_at is not None
                and created_at.date() == today_utc
                and isinstance(meta, dict)
                and meta.get("origin") == "DAILY_FIVE_MINUTE_TRAIN"
            ):
                completed_keys_today.add(
                    str(meta.get("train_completion_key") or getattr(row, "SourceRecordId", ""))
                )

        return DailyFiveMinuteTrainCompleteResponse(
            visibility="PARENT_PRIVATE",
            train_id=payload.train_id,
            child_id=child.Id,
            child_alias=child.Alias,
            interaction_mode=payload.interaction_mode,
            recorded_evidence_count=len(recorded_items),
            evidence_items=recorded_items,
            today_completed_trains_count=max(1, len(completed_keys_today)),
            celebration_title_vi=f"Chuyến tàu 5 phút của {child.Alias} đã cập bến êm ái!",
            natural_break_cue_vi=(
                f"Tuyệt lắm {child.Alias}! Mình đã hoàn thành trọn vẹn 3 toa luyện đọc hôm nay. "
                "Giờ bé hãy đóng màn hình, nhìn cây xanh hoặc khoảng xa 20 giây và nghỉ ngơi thoải mái nhé."
            ),
            completed_at=now_utc,
        )
