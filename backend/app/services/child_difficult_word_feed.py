"""Shared single-source-of-truth feed of a child's active difficult reading words.

Aggregates real reading mistakes from `ReadingComparisonReport` (SUBSTITUTE/DELETE),
`ReadingEvent` (`WORD_RETRY` FAILED/UNCERTAIN + legacy error events),
`DifficultWordPracticeAttempt` (mastery exclusion & active/incorrect boost),
and `LearningSkillEvidence` (7-day spaced interleaving rotation).
"""

from __future__ import annotations

import inspect
import logging
from collections import Counter, defaultdict
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from typing import Any, Callable, Coroutine
from uuid import UUID

from sqlalchemy import and_, desc, or_, select
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.ext.asyncio import AsyncSession

from app.models import (
    ChildProfile,
    DifficultWordPracticeAttempt,
    LearningSkillEvidence,
    PageRevisionWord,
    ReadingComparisonReport,
    ReadingEvent,
    ReadingSession,
)
from app.services.child_progress.metrics import (
    ReportRow,
    analyze_alignment,
    analyze_first_pass,
    first_pass_reports,
    local_date,
    normalize_word,
)
from app.services.difficult_words_service import (
    clean_difficult_word_display_text,
    normalize_vietnamese_practice_word,
)
from app.services.reading_assessment import initial_snapshot

logger = logging.getLogger(__name__)

DEFAULT_WINDOW_DAYS = 90
REINFORCEMENT_WINDOW_DAYS = 7
MIN_REINFORCEMENT_SCORE_NORMALIZED = 0.75
_LEGACY_DIFFICULT_EVENT_TYPES = (
    "OMISSION",
    "MISPRONUNCIATION",
    "SUBSTITUTION",
    "REPETITION",
    "LONG_PAUSE",
)
_IGNORED_EVENT_STATUSES = ("IGNORED_BY_GATE", "DISMISSED")
_VALID_PRACTICE_STATUSES = frozenset({"CORRECT", "INCORRECT", "UNCERTAIN"})


def _ensure_utc(value: datetime | None) -> datetime | None:
    if value is None:
        return None
    if value.tzinfo is None:
        return value.replace(tzinfo=timezone.utc)
    return value


def _is_missing_relation_runtime_error(exc: Exception) -> bool:
    text = str(exc).lower()
    return (
        "does not exist" in text
        or "undefinedtable" in text
        or "no such table" in text
    )


def _is_usable_target_word(norm: str) -> bool:
    return len(norm) >= 2 and any(ch.isalpha() for ch in norm)


@dataclass(frozen=True, slots=True)
class DifficultWordTarget:
    """Canonical difficult-word target shared across all ViRead entertainment games."""

    word: str
    normalized_word: str
    error_count: int
    heard_as: str | None = None
    source_book_ids: list[UUID] = field(default_factory=list)
    source_page_ids: list[UUID] = field(default_factory=list)
    priority_score: float = 0.0
    last_seen_at: datetime | None = None
    reinforced_count: int = 0
    reading_error_count: int | None = None
    practice_error_count: int = 0


@dataclass
class _TargetAccumulator:
    normalized_word: str
    display_counts: Counter[str] = field(default_factory=Counter)
    error_count: int = 0
    reading_error_count: int = 0
    practice_error_count: int = 0
    weighted_errors: float = 0.0
    heard_counts: Counter[str] = field(default_factory=Counter)
    book_ids: list[UUID] = field(default_factory=list)
    page_ids: list[UUID] = field(default_factory=list)
    last_seen_at: datetime | None = None
    last_reading_error_at: datetime | None = None
    has_active_incorrect: bool = False

    def observe(
        self,
        *,
        display_text: str,
        weight: float,
        error_increment: int = 1,
        from_reading: bool = False,
        heard_as: str | None = None,
        book_id: UUID | None = None,
        page_id: UUID | None = None,
        seen_at: datetime | None = None,
    ) -> None:
        cleaned = clean_difficult_word_display_text(display_text) or self.normalized_word
        self.display_counts[cleaned] += 1
        self.error_count += error_increment
        if from_reading:
            self.reading_error_count += error_increment
        else:
            self.practice_error_count += error_increment
        self.weighted_errors += weight
        if heard_as:
            clean_heard = clean_difficult_word_display_text(heard_as)
            if clean_heard and clean_heard.casefold() != self.normalized_word:
                self.heard_counts[clean_heard] += 1
        if book_id is not None and book_id not in self.book_ids:
            self.book_ids.append(book_id)
        if page_id is not None and page_id not in self.page_ids:
            self.page_ids.append(page_id)
        seen_utc = _ensure_utc(seen_at)
        if seen_utc is not None and (
            self.last_seen_at is None or seen_utc > self.last_seen_at
        ):
            self.last_seen_at = seen_utc
        if from_reading and seen_utc is not None and (
            self.last_reading_error_at is None or seen_utc > self.last_reading_error_at
        ):
            self.last_reading_error_at = seen_utc


class ChildDifficultWordFeed:
    """Reads a child's real reading errors and spaced-practice history safely."""

    def __init__(self, db: AsyncSession) -> None:
        self.db = db

    async def _run_optional_query(
        self,
        fn: Callable[[], Coroutine[Any, Any, list[Any]]],
    ) -> list[Any]:
        begin_nested = getattr(self.db, "begin_nested", None)
        use_nested = False
        cm = None
        if callable(begin_nested):
            candidate = begin_nested()
            aenter = getattr(candidate, "__aenter__", None)
            if inspect.iscoroutinefunction(aenter):
                cm = candidate
                use_nested = True
        try:
            if use_nested and cm is not None:
                async with cm:
                    return await fn()
            return await fn()
        except SQLAlchemyError:
            logger.debug("Optional difficult-word query failed safely", exc_info=True)
            return []
        except Exception as exc:
            if _is_missing_relation_runtime_error(exc):
                rollback = getattr(self.db, "rollback", None)
                if callable(rollback):
                    try:
                        res = rollback()
                        if inspect.isawaitable(res):
                            await res
                    except Exception:
                        pass
                return []
            raise

    async def _fetch_comparison_reports(
        self,
        child_id: UUID,
        parent_id: UUID | None,
        since: datetime,
    ) -> list[Any]:
        async def _query() -> list[Any]:
            stmt = (
                select(
                    ReadingComparisonReport.SessionId,
                    ReadingComparisonReport.CreatedAt,
                    ReadingComparisonReport.Alignment,
                    ReadingComparisonReport.Summary,
                    ReadingComparisonReport.PageId,
                    ReadingComparisonReport.PageRevisionId,
                    ReadingComparisonReport.Transcript,
                    ReadingSession.BookId,
                )
                .join(
                    ReadingSession,
                    ReadingSession.Id == ReadingComparisonReport.SessionId,
                )
                .where(
                    ReadingSession.ChildId == child_id,
                    ReadingComparisonReport.CreatedAt >= since,
                )
            )
            if parent_id is not None:
                stmt = stmt.join(
                    ChildProfile,
                    ChildProfile.Id == ReadingSession.ChildId,
                ).where(ChildProfile.ParentId == parent_id)
            stmt = stmt.order_by(
                desc(ReadingComparisonReport.CreatedAt),
                desc(ReadingComparisonReport.Id),
            ).limit(500)
            result = await self.db.execute(stmt)
            return list(result.all())

        return await self._run_optional_query(_query)

    async def _fetch_reading_events(
        self,
        child_id: UUID,
        parent_id: UUID | None,
        since: datetime,
    ) -> list[Any]:
        async def _query() -> list[Any]:
            stmt = (
                select(
                    ReadingEvent.Type,
                    ReadingEvent.Status,
                    ReadingEvent.Metadata,
                    ReadingEvent.CreatedAt,
                    ReadingEvent.PageId,
                    ReadingSession.BookId,
                    PageRevisionWord.Text,
                )
                .join(ReadingSession, ReadingSession.Id == ReadingEvent.SessionId)
                .outerjoin(PageRevisionWord, PageRevisionWord.Id == ReadingEvent.WordId)
                .where(
                    ReadingSession.ChildId == child_id,
                    ReadingEvent.CreatedAt >= since,
                    or_(
                        and_(
                            ReadingEvent.Type == "WORD_RETRY",
                            ReadingEvent.Status.in_(("FAILED", "UNCERTAIN")),
                        ),
                        and_(
                            ReadingEvent.Type.in_(_LEGACY_DIFFICULT_EVENT_TYPES),
                            ReadingEvent.Status.notin_(_IGNORED_EVENT_STATUSES),
                        ),
                    ),
                )
            )
            if parent_id is not None:
                stmt = stmt.join(
                    ChildProfile,
                    ChildProfile.Id == ReadingSession.ChildId,
                ).where(ChildProfile.ParentId == parent_id)
            stmt = stmt.order_by(
                desc(ReadingEvent.CreatedAt),
                desc(ReadingEvent.Id),
            ).limit(1000)
            result = await self.db.execute(stmt)
            return list(result.all())

        return await self._run_optional_query(_query)

    async def _fetch_practice_attempts(
        self,
        child_id: UUID,
        parent_id: UUID | None,
        since: datetime,
    ) -> list[Any]:
        async def _query() -> list[Any]:
            stmt = select(
                DifficultWordPracticeAttempt.NormalizedWord,
                DifficultWordPracticeAttempt.DisplayText,
                DifficultWordPracticeAttempt.AssessmentStatus,
                DifficultWordPracticeAttempt.State,
                DifficultWordPracticeAttempt.AttemptNumber,
                DifficultWordPracticeAttempt.BookId,
                DifficultWordPracticeAttempt.PageId,
                DifficultWordPracticeAttempt.CompletedAt,
                DifficultWordPracticeAttempt.StartedAt,
                DifficultWordPracticeAttempt.CreatedAt,
            ).where(
                DifficultWordPracticeAttempt.ChildId == child_id,
                DifficultWordPracticeAttempt.CreatedAt >= since,
            )
            if parent_id is not None:
                stmt = stmt.where(DifficultWordPracticeAttempt.ParentId == parent_id)
            stmt = stmt.order_by(
                desc(DifficultWordPracticeAttempt.CompletedAt).nulls_last(),
                desc(DifficultWordPracticeAttempt.StartedAt).nulls_last(),
                desc(DifficultWordPracticeAttempt.CreatedAt).nulls_last(),
                desc(DifficultWordPracticeAttempt.AttemptNumber).nulls_last(),
            ).limit(500)
            result = await self.db.execute(stmt)
            return list(result.all())

        return await self._run_optional_query(_query)

    async def _fetch_skill_evidence(
        self,
        child_id: UUID,
        parent_id: UUID | None,
        since: datetime,
    ) -> list[Any]:
        async def _query() -> list[Any]:
            stmt = select(
                LearningSkillEvidence.PracticeWords,
                LearningSkillEvidence.ScoreNormalized,
                LearningSkillEvidence.CreatedAt,
            ).where(
                LearningSkillEvidence.ChildId == child_id,
                LearningSkillEvidence.CreatedAt >= since,
                LearningSkillEvidence.ScoreNormalized >= MIN_REINFORCEMENT_SCORE_NORMALIZED,
            )
            if parent_id is not None:
                stmt = stmt.where(LearningSkillEvidence.ParentId == parent_id)
            stmt = stmt.order_by(desc(LearningSkillEvidence.CreatedAt)).limit(300)
            result = await self.db.execute(stmt)
            return list(result.all())

        return await self._run_optional_query(_query)

    async def list_targets(
        self,
        child_id: UUID,
        parent_id: UUID | None = None,
        *,
        limit: int = 12,
        window_days: int = DEFAULT_WINDOW_DAYS,
        now: datetime | None = None,
    ) -> list[DifficultWordTarget]:
        if limit <= 0:
            return []

        ref_now = _ensure_utc(now) or datetime.now(timezone.utc)
        since_90d = ref_now - timedelta(days=max(1, int(window_days)))
        since_7d = ref_now - timedelta(days=REINFORCEMENT_WINDOW_DAYS)

        report_rows = await self._fetch_comparison_reports(child_id, parent_id, since_90d)
        event_rows = await self._fetch_reading_events(child_id, parent_id, since_90d)
        practice_rows = await self._fetch_practice_attempts(child_id, parent_id, since_90d)
        evidence_rows = await self._fetch_skill_evidence(child_id, parent_id, since_7d)

        accumulators: dict[str, _TargetAccumulator] = {}

        def _acc(norm: str) -> _TargetAccumulator:
            item = accumulators.get(norm)
            if item is None:
                item = _TargetAccumulator(normalized_word=norm)
                accumulators[norm] = item
            return item

        # 1. ReadingComparisonReport (SUBSTITUTE & DELETE via analyze_alignment)
        book_by_report_key: dict[tuple[UUID, UUID | None, UUID | None], UUID | None] = {}
        raw_reports: list[ReportRow] = []
        for row in report_rows:
            session_id, created_at, alignment, summary, page_id, rev_id, transcript, book_id = row
            book_by_report_key[(session_id, page_id, rev_id)] = book_id
            raw_reports.append(
                ReportRow(
                    session_id=session_id,
                    created_at=_ensure_utc(created_at)
                    or datetime.min.replace(tzinfo=timezone.utc),
                    alignment=alignment,
                    summary=summary,
                    page_id=page_id,
                    page_revision_id=rev_id,
                    transcript=transcript or "",
                )
            )

        for report in first_pass_reports(raw_reports):
            analysis = analyze_first_pass(report)
            if analysis is None:
                continue
            errors = analysis.get("errors") or {}
            heard_map = analysis.get("heard") or {}
            if not heard_map and report.alignment:
                alignment_analysis = analyze_alignment(report.alignment)
                if alignment_analysis is not None:
                    heard_map = alignment_analysis.get("heard") or {}
            if not errors:
                continue

            raw_display_by_norm: dict[str, str] = {}
            snapshot_words = initial_snapshot(report.summary)
            if isinstance(snapshot_words, list):
                for entry in snapshot_words:
                    if not isinstance(entry, dict):
                        continue
                    if entry.get("status") not in ("MISPRONUNCIATION", "OMISSION"):
                        continue
                    raw_text = entry.get("text")
                    key = normalize_word(raw_text)
                    if key and key not in raw_display_by_norm and isinstance(raw_text, str):
                        cleaned = clean_difficult_word_display_text(raw_text)
                        if cleaned:
                            raw_display_by_norm[key] = cleaned
            if isinstance(report.alignment, list):
                for entry in report.alignment:
                    if not isinstance(entry, dict):
                        continue
                    if entry.get("status") not in ("SUBSTITUTE", "DELETE"):
                        continue
                    raw_book_word = entry.get("book_word")
                    key = normalize_word(raw_book_word)
                    if key and key not in raw_display_by_norm and isinstance(raw_book_word, str):
                        cleaned = clean_difficult_word_display_text(raw_book_word)
                        if cleaned:
                            raw_display_by_norm[key] = cleaned

            report_book_id = book_by_report_key.get(
                (report.session_id, report.page_id, report.page_revision_id)
            )
            for norm_word, count in errors.items():
                norm = normalize_vietnamese_practice_word(norm_word) or norm_word
                if not _is_usable_target_word(norm):
                    continue
                heard_counter = heard_map.get(norm_word)
                top_heard = heard_counter.most_common(1)[0][0] if heard_counter else None
                display = raw_display_by_norm.get(norm_word) or norm
                _acc(norm).observe(
                    display_text=display,
                    weight=2.0 * int(count),
                    error_increment=int(count),
                    from_reading=True,
                    heard_as=top_heard,
                    book_id=report_book_id,
                    page_id=report.page_id,
                    seen_at=report.created_at,
                )

        # 2. ReadingEvent (WORD_RETRY FAILED/UNCERTAIN + legacy reading error events)
        for row in event_rows:
            ev_type, ev_status, metadata, created_at, page_id, book_id, word_text = row
            if ev_type == "WORD_RETRY":
                if ev_status not in ("FAILED", "UNCERTAIN"):
                    continue
                weight = 2.5 if ev_status == "FAILED" else 1.5
            elif ev_type in _LEGACY_DIFFICULT_EVENT_TYPES:
                if ev_status in _IGNORED_EVENT_STATUSES:
                    continue
                if ev_type in ("OMISSION", "MISPRONUNCIATION", "SUBSTITUTION"):
                    weight = 2.0
                elif ev_type == "REPETITION":
                    weight = 1.5
                else:
                    weight = 1.0
            else:
                continue

            meta = metadata if isinstance(metadata, dict) else {}
            raw_word = (
                word_text
                or meta.get("target_word")
                or meta.get("word")
                or meta.get("book_word")
                or meta.get("normalized_word")
            )
            if not isinstance(raw_word, str):
                continue
            norm = normalize_vietnamese_practice_word(raw_word)
            if not _is_usable_target_word(norm):
                continue

            heard_raw = meta.get("recognized_text") or meta.get("spoken_word")
            heard_as = heard_raw if isinstance(heard_raw, str) else None
            _acc(norm).observe(
                display_text=raw_word,
                weight=weight,
                error_increment=1,
                from_reading=True,
                heard_as=heard_as,
                book_id=book_id,
                page_id=page_id,
                seen_at=created_at,
            )

        # 3. DifficultWordPracticeAttempt (exclude mastered, prioritize active/incorrect)
        attempts_by_word: dict[str, list[tuple[datetime, int, str, str, UUID | None, UUID | None]]] = defaultdict(list)
        for row in practice_rows:
            (
                norm_word,
                display_text,
                assessment_status,
                state,
                attempt_number,
                book_id,
                page_id,
                completed_at,
                started_at,
                created_at,
            ) = row
            if state is not None and state != "COMPLETED" and assessment_status is None:
                continue
            if assessment_status not in _VALID_PRACTICE_STATUSES:
                continue
            norm = normalize_vietnamese_practice_word(norm_word or display_text)
            if not _is_usable_target_word(norm):
                continue
            ts = _ensure_utc(completed_at or started_at or created_at) or datetime.min.replace(
                tzinfo=timezone.utc
            )
            attempts_by_word[norm].append(
                (
                    ts,
                    int(attempt_number or 0),
                    str(assessment_status),
                    str(display_text or norm),
                    book_id,
                    page_id,
                )
            )

        mastered_at: dict[str, datetime] = {}
        for norm, items in attempts_by_word.items():
            items.sort(key=lambda item: (item[0], item[1]), reverse=True)
            recent_two = [item[2] for item in items[:2]]
            if len(recent_two) >= 2 and all(status == "CORRECT" for status in recent_two):
                mastered_at[norm] = items[0][0]
                continue

            incorrect_n = sum(1 for item in items if item[2] == "INCORRECT")
            uncertain_n = sum(1 for item in items if item[2] == "UNCERTAIN")
            correct_n = sum(1 for item in items if item[2] == "CORRECT")

            if incorrect_n > 0 or uncertain_n > 0:
                latest_ts, _, latest_status, latest_display, book_id, page_id = items[0]
                acc = _acc(norm)
                acc.observe(
                    display_text=latest_display,
                    weight=incorrect_n * 2.5 + uncertain_n * 1.5 - correct_n * 0.3,
                    error_increment=incorrect_n + uncertain_n,
                    from_reading=False,
                    book_id=book_id,
                    page_id=page_id,
                    seen_at=latest_ts if latest_ts.year > 1900 else None,
                )
                if latest_status in ("INCORRECT", "UNCERTAIN"):
                    acc.has_active_incorrect = True
            elif norm in accumulators and correct_n == 1:
                accumulators[norm].weighted_errors = max(
                    0.5, accumulators[norm].weighted_errors - 0.5
                )

        # 4. LearningSkillEvidence (last 7 days, ScoreNormalized >= 0.75) for rotation
        today_local = local_date(ref_now)
        reinforced_counts: Counter[str] = Counter()
        reinforced_today: set[str] = set()
        for row in evidence_rows:
            practice_words, score_raw, created_at = row
            score = float(score_raw or 0.0)
            if score > 1.0:
                score = score / 100.0
            if score < MIN_REINFORCEMENT_SCORE_NORMALIZED:
                continue
            if not isinstance(practice_words, list):
                continue
            is_today = created_at is not None and local_date(created_at) == today_local
            seen_in_row: set[str] = set()
            for raw_pw in practice_words:
                norm = normalize_vietnamese_practice_word(raw_pw)
                if not norm or norm in seen_in_row:
                    continue
                seen_in_row.add(norm)
                reinforced_counts[norm] += 1
                if is_today:
                    reinforced_today.add(norm)

        targets: list[DifficultWordTarget] = []
        for norm, acc in accumulators.items():
            if acc.error_count <= 0:
                continue
            mastery_ts = mastered_at.get(norm)
            if mastery_ts is not None:
                relapsed_after_mastery = (
                    acc.last_reading_error_at is not None
                    and acc.last_reading_error_at > mastery_ts
                )
                if not relapsed_after_mastery:
                    continue

            recency_bonus = 0.0
            if acc.last_seen_at is not None:
                age_days = max(0.0, (ref_now - acc.last_seen_at).total_seconds() / 86400.0)
                recency_bonus = 2.0 / (1.0 + age_days / 7.0)

            raw_priority = max(0.25, acc.weighted_errors + recency_bonus + (1.5 if acc.has_active_incorrect else 0.0))
            rc = int(reinforced_counts.get(norm, 0))
            if norm in reinforced_today:
                priority = round(raw_priority * 0.45, 3)
            elif rc > 0:
                priority = round(raw_priority * max(0.6, 1.0 - 0.1 * min(3, rc)), 3)
            else:
                priority = round(raw_priority, 3)

            display_word = (
                acc.display_counts.most_common(1)[0][0]
                if acc.display_counts
                else norm
            )
            heard_as = (
                acc.heard_counts.most_common(1)[0][0]
                if acc.heard_counts
                else None
            )
            targets.append(
                DifficultWordTarget(
                    word=display_word,
                    normalized_word=norm,
                    error_count=acc.error_count,
                    heard_as=heard_as,
                    source_book_ids=list(acc.book_ids),
                    source_page_ids=list(acc.page_ids),
                    priority_score=priority,
                    last_seen_at=acc.last_seen_at,
                    reinforced_count=rc,
                    reading_error_count=acc.reading_error_count,
                    practice_error_count=acc.practice_error_count,
                )
            )

        targets.sort(
            key=lambda item: (
                -item.priority_score,
                -item.error_count,
                -(
                    item.last_seen_at.timestamp()
                    if item.last_seen_at is not None
                    else 0.0
                ),
                item.normalized_word,
            )
        )
        return targets[:limit]

    async def list_words(
        self,
        child_id: UUID,
        parent_id: UUID | None = None,
        *,
        limit: int = 12,
        window_days: int = DEFAULT_WINDOW_DAYS,
        now: datetime | None = None,
    ) -> list[str]:
        targets = await self.list_targets(
            child_id,
            parent_id,
            limit=limit,
            window_days=window_days,
            now=now,
        )
        return [target.word for target in targets]
