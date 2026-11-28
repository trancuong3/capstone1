"""Adaptive Learning Engine V4.0 (G03) & Parent Analytics Service (G11).

Deterministic, transparent, non-diagnostic educational adaptation for Vietnamese
primary learners (Grades 1–5, aligned with MOET GDPT 2018).
Zero external AI API calls; zero IQ or medical claims.
"""

from __future__ import annotations

from collections import defaultdict
from datetime import datetime, timezone
import inspect
from typing import Iterable
from uuid import UUID

from fastapi import HTTPException, status
from sqlalchemy.exc import IntegrityError

from app.repositories.adaptive_learning_repository import AdaptiveLearningRepository
from app.services.child_difficult_word_feed import (
    MIN_REINFORCEMENT_SCORE_NORMALIZED,
    DifficultWordTarget,
)
from app.services.difficult_words_service import normalize_vietnamese_practice_word
from app.schemas.adaptive_learning import (
    AdaptiveProfileRead,
    CrossGameRecommendationRead,
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
    feed_targets: list[DifficultWordTarget] | None = None,
    now: datetime | None = None,
    limit: int = 8,
) -> list[SpacedDifficultWordRead]:
    """Rank difficult words for spaced repetition across games (1d -> 3d -> 7d cadence)."""
    ref_now = now or datetime.now(timezone.utc)
    grouped: dict[str, dict] = {}
    attempts_by_norm: dict[str, list[tuple[datetime, str]]] = defaultdict(list)

    for row in word_attempts:
        norm = normalize_vietnamese_practice_word(
            getattr(row, "NormalizedWord", None) or getattr(row, "DisplayText", None) or ""
        )
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
                "from_reading": False,
                "heard_as": None,
                "feed_priority": 0.0,
                "reinforced_count": 0,
            },
        )
        bucket["attempts"] += 1
        status_val = getattr(row, "AssessmentStatus", None)
        if status_val == "CORRECT":
            bucket["correct"] += 1
        elif status_val in ("INCORRECT", "UNCERTAIN"):
            bucket["incorrect"] += 1
        ts = getattr(row, "CompletedAt", None) or getattr(row, "CreatedAt", None)
        if ts is not None:
            aware_ts = ts if ts.tzinfo else ts.replace(tzinfo=timezone.utc)
            if status_val in ("CORRECT", "INCORRECT", "UNCERTAIN"):
                attempts_by_norm[norm].append((aware_ts, str(status_val)))
            if bucket["last_at"] is None or aware_ts > (
                bucket["last_at"] if bucket["last_at"].tzinfo else bucket["last_at"].replace(tzinfo=timezone.utc)
            ):
                bucket["last_at"] = ts

    # When live feed_targets is supplied, exclude mastered words (2 most recent valid == CORRECT)
    # and merge real reading errors (ReadingComparisonReport + ReadingEvent) into spaced review.
    feed_norms: set[str] = set()
    if feed_targets is not None:
        for norm, att_list in attempts_by_norm.items():
            att_list.sort(key=lambda item: item[0], reverse=True)
            recent_two = [item[1] for item in att_list[:2]]
            if len(recent_two) >= 2 and all(s == "CORRECT" for s in recent_two):
                grouped.pop(norm, None)

        for target in feed_targets:
            norm = normalize_vietnamese_practice_word(target.normalized_word or target.word)
            if not norm:
                continue
            feed_norms.add(norm)
            reading_errors = (
                int(target.reading_error_count)
                if target.reading_error_count is not None
                else int(target.error_count)
            )
            practice_errors = int(getattr(target, "practice_error_count", 0) or 0)
            has_reading_evidence = reading_errors > 0
            existing = grouped.get(norm)
            if existing is None:
                grouped[norm] = {
                    "display_text": target.word,
                    "attempts": 0,
                    "correct": 0,
                    "incorrect": int(target.error_count),
                    "last_at": target.last_seen_at,
                    "from_reading": has_reading_evidence,
                    "heard_as": target.heard_as,
                    "feed_priority": float(target.priority_score),
                    "reinforced_count": int(target.reinforced_count),
                }
            else:
                if has_reading_evidence:
                    existing["from_reading"] = True
                existing["heard_as"] = existing["heard_as"] or target.heard_as
                existing["feed_priority"] = max(existing["feed_priority"], float(target.priority_score))
                if target.reading_error_count is not None:
                    existing["incorrect"] = max(existing["incorrect"], practice_errors) + reading_errors
                else:
                    existing["incorrect"] += reading_errors
                existing["reinforced_count"] = max(
                    existing["reinforced_count"], int(target.reinforced_count)
                )
                if target.last_seen_at is not None:
                    cur_last = existing["last_at"]
                    cur_aware = (
                        cur_last if cur_last.tzinfo else cur_last.replace(tzinfo=timezone.utc)
                    ) if cur_last is not None else None
                    t_aware = (
                        target.last_seen_at
                        if target.last_seen_at.tzinfo
                        else target.last_seen_at.replace(tzinfo=timezone.utc)
                    )
                    if cur_aware is None or t_aware > cur_aware:
                        existing["last_at"] = target.last_seen_at

    ranked: list[SpacedDifficultWordRead] = []
    game_cycle: tuple[GameKey, ...] = ("SENTENCE_SHOOTER", "PICTURE_DESCRIPTION", "MEMORY_GAME")

    for idx, (norm, info) in enumerate(grouped.items()):
        attempts = info["attempts"]
        correct = info["correct"]
        incorrect = info["incorrect"]
        last_at = info["last_at"]
        days_since: int | None = None
        if last_at is not None:
            aware_last = last_at if last_at.tzinfo else last_at.replace(tzinfo=timezone.utc)
            days_since = max(0, (ref_now - aware_last).days)

        # Target spaced interval grows with mastered repetitions: 1d -> 3d -> 7d.
        target_interval = 1 if correct == 0 else (3 if correct == 1 else 7)
        is_new_reading_error = bool(info.get("from_reading")) and correct == 0
        due_bonus = (
            1.5
            if (is_new_reading_error or days_since is None or days_since >= target_interval)
            else 0.5
        )
        error_weight = (
            1.0
            + incorrect * 0.8
            - correct * 0.35
            + float(info.get("feed_priority", 0.0)) * 0.3
        )
        priority = round(max(0.1, error_weight * due_bonus), 2)

        recommended_game = game_cycle[idx % len(game_cycle)]
        heard_as = info.get("heard_as")
        if heard_as:
            reason_vi = (
                f'Khi đọc sách bé từng đọc nhầm thành "{heard_as}"; ôn nhẹ qua trò chơi giúp bé nhớ ngay.'
            )
        elif info.get("from_reading") and incorrect > correct:
            reason_vi = "Bé vừa gặp khó ở từ này khi đọc sách; nên ôn nhẹ trong câu ngắn."
        elif incorrect > correct:
            reason_vi = "Bé từng gặp khó ở từ này; nên ôn nhẹ trong câu ngắn."
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

    def _build_recommendations(
        self,
        child_grade: int,
        plans: list[ModuleDifficultyPlan],
        spaced_words: list[SpacedDifficultWordRead],
        picture_count: int,
        shooter_count: int,
        karaoke_count: int,
        memory_count: int,
    ) -> list[CrossGameRecommendationRead]:
        plan_map = {p.game_key: p for p in plans}
        focus_words = [w.display_text for w in spaced_words[:3]]
        counts = {
            "PICTURE_DESCRIPTION": picture_count,
            "SENTENCE_SHOOTER": shooter_count,
            "KARAOKE": karaoke_count,
            "MEMORY_GAME": memory_count,
        }

        def _difficulty_slug(level: int) -> str:
            if level <= 2:
                return "easy"
            if level == 3:
                return "medium"
            return "challenge"

        shooter_mode = "FILL_BLANK" if (child_grade >= 3 or focus_words) else "WORD_ORDER"
        shooter_diff = plan_map["SENTENCE_SHOOTER"].recommended_difficulty
        memory_mode = "FREE_RECALL" if child_grade >= 3 else "GUIDED_RECALL"
        pic_mode = "VOCABULARY" if focus_words else ("STORY" if child_grade >= 3 else "OBSERVE")

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
                suggested_mode=shooter_mode,
                suggested_difficulty=shooter_diff,
                target_words=focus_words,
                href="/entertainment/sentence-shooter",
                quick_play_href=(
                    f"/entertainment/sentence-shooter?autoplay=1&mode={shooter_mode}"
                    f"&difficulty={_difficulty_slug(shooter_diff)}"
                ),
                priority=1 if focus_words else (2 + counts["SENTENCE_SHOOTER"]),
            ),
            CrossGameRecommendationRead(
                game_key="MEMORY_GAME",
                zone_title_vi="Khám phá trí nhớ",
                game_title_vi="Bé nhớ được gì?",
                reason_vi="Quan sát tranh tiếng Việt rực rỡ, rèn trí nhớ hình ảnh và kể tiếp câu chuyện sáng tạo.",
                suggested_mode=memory_mode,
                suggested_difficulty=plan_map["MEMORY_GAME"].recommended_difficulty,
                target_words=focus_words[:2],
                href="/entertainment/memory-game",
                quick_play_href=f"/entertainment/memory-game?autoplay=1&recall_mode={memory_mode}",
                priority=1 if counts["MEMORY_GAME"] == 0 else (2 + counts["MEMORY_GAME"]),
            ),
            CrossGameRecommendationRead(
                game_key="PICTURE_DESCRIPTION",
                zone_title_vi="Thế giới kể chuyện",
                game_title_vi="Kể chuyện qua tranh cùng Cô giáo AI",
                reason_vi="Luyện quan sát tranh và mở rộng câu văn cùng Cô giáo AI dịu dàng.",
                suggested_mode=pic_mode,
                suggested_difficulty=plan_map["PICTURE_DESCRIPTION"].recommended_difficulty,
                target_words=focus_words[:2],
                href="/entertainment/picture-description",
                quick_play_href=f"/entertainment/picture-description?autoplay=1&mode={pic_mode}",
                priority=2 + counts["PICTURE_DESCRIPTION"],
            ),
            CrossGameRecommendationRead(
                game_key="KARAOKE",
                zone_title_vi="Sân khấu âm nhạc",
                game_title_vi="Hát vui cùng bé",
                reason_vi="Thư giãn cùng giai điệu thiếu nhi, tập gõ nhịp và hát rõ lời.",
                suggested_mode="RHYTHM_TAP" if counts["KARAOKE"] == 0 else "FULL_SONG",
                suggested_difficulty=plan_map["KARAOKE"].recommended_difficulty,
                target_words=focus_words[:2],
                href="/karaoke",
                quick_play_href="/karaoke?autoplay=1",
                priority=2 + counts["KARAOKE"],
            ),
        ]

        recs.sort(key=lambda r: (r.priority, r.game_key))
        return [
            r.model_copy(update={"priority": idx + 1})
            for idx, r in enumerate(recs)
        ]

    async def _load_feed_targets(
        self,
        child_id: UUID,
        parent_id: UUID,
        *,
        limit: int = 12,
    ) -> list[DifficultWordTarget] | None:
        fn = getattr(self.repository, "list_difficult_word_targets", None)
        if not callable(fn):
            return None
        res = fn(child_id, parent_id, limit=limit)
        if inspect.isawaitable(res):
            return await res
        return None

    async def get_adaptive_profile(
        self,
        child_id: UUID,
        parent_id: UUID,
        *,
        window_days: int = 30,
    ) -> AdaptiveProfileRead:
        child = await self._require_child(child_id, parent_id)
        explicit_rows = await self.repository.list_skill_evidence(child_id, window_days=90)
        word_attempts = await self.repository.list_difficult_word_attempts(child_id, window_days=90)
        feed_targets = await self._load_feed_targets(child_id, parent_id, limit=12)
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
        spaced_words = compute_spaced_difficult_words(
            word_attempts,
            feed_targets=feed_targets,
        )
        recommendations = self._build_recommendations(
            child.Grade,
            plans,
            spaced_words,
            len(picture_sessions),
            len(shooter_sessions),
            len(karaoke_sessions),
            len(memory_sessions),
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
        profile = await self.get_adaptive_profile(child_id, parent_id, window_days=7)
        today_utc = datetime.now(timezone.utc).date()
        recent_pic = await self.repository.list_picture_sessions(child_id, window_days=2)
        recent_shoot = await self.repository.list_shooter_sessions(child_id, window_days=2)
        recent_kar = await self.repository.list_karaoke_sessions(child_id, window_days=2)
        recent_mem = await self.repository.list_memory_sessions(child_id, window_days=2)

        resolved_gender = teacher_gender if teacher_gender in ("female", "male") else None
        if resolved_gender is None:
            try:
                child = await self._require_child(child_id, parent_id)
                settings = getattr(child, "Settings", None)
                if isinstance(settings, dict):
                    vp = settings.get("voice_preferences")
                    if isinstance(vp, dict) and vp.get("gender") in ("female", "male"):
                        resolved_gender = vp["gender"]
            except Exception:
                resolved_gender = None

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
    ) -> ParentEntertainmentAnalyticsRead:
        child = await self._require_child(child_id, parent_id)
        explicit_rows = await self.repository.list_skill_evidence(child_id, window_days=window_days)
        word_attempts = await self.repository.list_difficult_word_attempts(child_id, window_days=window_days)
        feed_targets = await self._load_feed_targets(child_id, parent_id, limit=12)
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
        spaced_words = compute_spaced_difficult_words(
            word_attempts,
            feed_targets=feed_targets,
            limit=10,
        )

        reinforced_norms: set[str] = set()
        for row in explicit_rows:
            if getattr(row, "SkillKey", None) == "difficult_word_mastery":
                score_raw = float(getattr(row, "ScoreNormalized", 0.0) or 0.0)
                if score_raw > 1.0:
                    score_raw = score_raw / 100.0
                if score_raw < MIN_REINFORCEMENT_SCORE_NORMALIZED:
                    continue
                for word in getattr(row, "PracticeWords", None) or []:
                    norm = normalize_vietnamese_practice_word(word)
                    if norm:
                        reinforced_norms.add(norm)
        for target in feed_targets or []:
            if target.reinforced_count > 0:
                reinforced_norms.add(target.normalized_word)
        for att in word_attempts:
            if getattr(att, "AssessmentStatus", None) == "CORRECT":
                norm = normalize_vietnamese_practice_word(
                    getattr(att, "NormalizedWord", None) or getattr(att, "DisplayText", None) or ""
                )
                if norm:
                    reinforced_norms.add(norm)

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
                title_vi="Kể chuyện qua tranh cùng Cô giáo AI",
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
            reading_misread_words_reinforced=len(reinforced_norms),
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
