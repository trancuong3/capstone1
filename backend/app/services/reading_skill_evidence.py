"""Safe, best-effort bridges emitting MOET GDPT 2018 LearningSkillEvidence from core reading modules.

Connects:
- `ReadingComparisonService.compare` -> `reading_fluency`, `phonics_decoding` (`source_module='READING'`)
- `TutorQuestionService.submit_answer` -> `reading_comprehension` (+ `vocabulary_naming` / `sentence_cloze`)
- `DifficultWordsService` practice completions -> `difficult_word_mastery`, `phonics_decoding` (`source_module='DIFFICULT_WORD'`)

All helpers degrade silently when unit tests pass fake/in-memory repositories without a real
SQLAlchemy `AsyncSession` or when `learning_skill_evidence` has not yet been migrated.
"""

from __future__ import annotations

import logging
from typing import Any
from uuid import UUID

from sqlalchemy.ext.asyncio import AsyncSession

from app.repositories.adaptive_learning_repository import record_skill_evidence_safe

logger = logging.getLogger(__name__)


def _extract_async_session(repo_or_db: Any) -> AsyncSession | None:
    if isinstance(repo_or_db, AsyncSession):
        return repo_or_db
    candidate = getattr(repo_or_db, "db", None)
    if isinstance(candidate, AsyncSession):
        return candidate
    return None


async def emit_reading_comparison_skill_evidence(
    repo_or_db: Any,
    *,
    child_id: UUID | None,
    parent_id: UUID | None,
    report_id: UUID | None,
    alignment: Any,
    summary: Any,
    difficulty_level: int = 2,
) -> None:
    db = _extract_async_session(repo_or_db)
    if db is None or child_id is None or parent_id is None or report_id is None:
        return

    try:
        entries = [item for item in alignment if isinstance(item, dict)] if isinstance(alignment, list) else []
        attempted = [
            item.get("book_index")
            for item in entries
            if item.get("status") in ("MATCH", "SUBSTITUTE")
            and isinstance(item.get("book_index"), int)
        ]
        if not attempted:
            return
        last_idx = max(attempted)
        correct = substituted = skipped = 0
        mispronounced_words: list[str] = []
        for item in entries:
            idx = item.get("book_index")
            if not isinstance(idx, int) or idx > last_idx:
                continue
            status_val = item.get("status")
            if status_val == "MATCH":
                correct += 1
            elif status_val == "SUBSTITUTE":
                substituted += 1
                bw = item.get("book_word")
                if isinstance(bw, str) and bw.strip():
                    mispronounced_words.append(bw.strip().lower())
            elif status_val == "DELETE":
                skipped += 1

        reached = correct + substituted + skipped
        if reached < 2:
            return

        decoding_score = max(0.0, min(1.0, correct / float(reached)))
        hesitations = 0
        repeated = 0
        if isinstance(summary, dict):
            hes_list = summary.get("hesitations")
            if isinstance(hes_list, list):
                hesitations = len(hes_list)
            rep_val = summary.get("repeated_count")
            if isinstance(rep_val, int) and not isinstance(rep_val, bool) and rep_val > 0:
                repeated = rep_val

        fluency_penalty = min(0.3, ((hesitations + repeated) / float(max(1, reached))) * 0.5)
        fluency_score = max(0.0, min(1.0, decoding_score - fluency_penalty))
        conf = 0.85 if reached >= 8 else 0.7
        record_key = str(report_id)

        wrote_decoding = await record_skill_evidence_safe(
            db,
            child_id=child_id,
            parent_id=parent_id,
            skill_key="phonics_decoding",
            source_module="READING",
            score_normalized=decoding_score,
            confidence=conf,
            difficulty_level=difficulty_level,
            source_record_id=record_key,
            practice_words=mispronounced_words[:12],
            metadata_json={"reached_words": reached, "correct_words": correct},
        )
        wrote_fluency = await record_skill_evidence_safe(
            db,
            child_id=child_id,
            parent_id=parent_id,
            skill_key="reading_fluency",
            source_module="READING",
            score_normalized=fluency_score,
            confidence=conf,
            difficulty_level=difficulty_level,
            source_record_id=record_key,
            practice_words=mispronounced_words[:12],
            metadata_json={"hesitations": hesitations, "repeated_words": repeated},
        )
        if wrote_decoding is not None or wrote_fluency is not None:
            await db.commit()
    except Exception as exc:
        logger.debug("Skipping reading comparison skill evidence emission: %s", exc)


async def emit_comprehension_skill_evidence(
    repo_or_db: Any,
    *,
    child_id: UUID | None,
    parent_id: UUID | None,
    answer_id: UUID | None,
    question_type: str | None,
    is_correct: bool,
    difficulty_level: int = 2,
) -> None:
    db = _extract_async_session(repo_or_db)
    if db is None or child_id is None or parent_id is None or answer_id is None:
        return

    try:
        score = 1.0 if is_correct else 0.25
        record_key = f"comp:{answer_id}"
        wrote_main = await record_skill_evidence_safe(
            db,
            child_id=child_id,
            parent_id=parent_id,
            skill_key="reading_comprehension",
            source_module="READING",
            score_normalized=score,
            confidence=0.8,
            difficulty_level=difficulty_level,
            source_record_id=record_key,
            metadata_json={"question_type": question_type or "FACTUAL", "is_correct": is_correct},
        )
        wrote_secondary = None
        if question_type == "VOCABULARY":
            wrote_secondary = await record_skill_evidence_safe(
                db,
                child_id=child_id,
                parent_id=parent_id,
                skill_key="vocabulary_naming",
                source_module="READING",
                score_normalized=score,
                confidence=0.75,
                difficulty_level=difficulty_level,
                source_record_id=record_key,
            )
        elif question_type == "CLOZE":
            wrote_secondary = await record_skill_evidence_safe(
                db,
                child_id=child_id,
                parent_id=parent_id,
                skill_key="sentence_cloze",
                source_module="READING",
                score_normalized=score,
                confidence=0.75,
                difficulty_level=difficulty_level,
                source_record_id=record_key,
            )
        if wrote_main is not None or wrote_secondary is not None:
            await db.commit()
    except Exception as exc:
        logger.debug("Skipping comprehension skill evidence emission: %s", exc)


async def emit_difficult_word_skill_evidence(
    repo_or_db: Any,
    *,
    child_id: UUID | None,
    parent_id: UUID | None,
    record_id: UUID | str | None,
    normalized_word: str,
    assessment_status: str | None,
    confidence: float | None = None,
    difficulty_level: int = 2,
) -> None:
    db = _extract_async_session(repo_or_db)
    if (
        db is None
        or child_id is None
        or parent_id is None
        or record_id is None
        or assessment_status not in ("CORRECT", "INCORRECT", "UNCERTAIN")
    ):
        return

    try:
        score = (
            1.0
            if assessment_status == "CORRECT"
            else 0.45
            if assessment_status == "UNCERTAIN"
            else 0.15
        )
        conf = max(0.55, min(0.95, float(confidence))) if isinstance(confidence, (int, float)) else 0.75
        rec_str = str(record_id)[:64]
        wrote_mastery = await record_skill_evidence_safe(
            db,
            child_id=child_id,
            parent_id=parent_id,
            skill_key="difficult_word_mastery",
            source_module="DIFFICULT_WORD",
            score_normalized=score,
            confidence=conf,
            difficulty_level=difficulty_level,
            source_record_id=rec_str,
            practice_words=[normalized_word] if normalized_word else [],
            metadata_json={"assessment_status": assessment_status},
        )
        wrote_phonics = await record_skill_evidence_safe(
            db,
            child_id=child_id,
            parent_id=parent_id,
            skill_key="phonics_decoding",
            source_module="DIFFICULT_WORD",
            score_normalized=score,
            confidence=round(conf * 0.9, 2),
            difficulty_level=difficulty_level,
            source_record_id=rec_str,
            practice_words=[normalized_word] if normalized_word else [],
            metadata_json={"assessment_status": assessment_status},
        )
        if wrote_mastery is not None or wrote_phonics is not None:
            await db.commit()
    except Exception as exc:
        logger.debug("Skipping difficult word skill evidence emission: %s", exc)
