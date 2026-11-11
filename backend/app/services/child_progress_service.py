from __future__ import annotations

import hashlib
import json
import logging
import time
from collections import OrderedDict
from datetime import date, datetime, time as day_time, timedelta
from typing import Callable
from uuid import UUID

from fastapi import HTTPException, status

from app.repositories.child_progress_repository import ChildProgressRepository
from app.schemas.child_progress import (
    AssessmentTextRead,
    ChildProgressAssessmentRead,
    ComprehensionTypeRead,
    DifficultWordStatRead,
    ProgressMetricsRead,
    ScoreComponentRead,
    ScoreRead,
    WeeklyPointRead,
)
from app.services.child_progress.ai import (
    AssessmentAIError,
    ChildProgressAI,
    ChildProgressConfig,
)
from app.services.child_progress.assessor import (
    AssessmentFacts,
    facts_payload,
    rule_based_assessment,
)
from app.services.child_progress.metrics import (
    VIETNAM_TZ,
    WindowMetrics,
    compute_window,
    top_difficult_words,
)
from app.services.child_progress.scoring import (
    component_scores,
    grade_for,
    overall_score,
)

logger = logging.getLogger(__name__)

CACHE_MAX_ENTRIES = 256


class _AssessmentCache:
    """In-memory (per process) cache so unchanged data never costs a second AI call."""

    def __init__(self) -> None:
        self._items: OrderedDict[tuple, tuple[float, AssessmentTextRead]] = OrderedDict()

    def get(self, key: tuple, ttl: int) -> tuple[float, AssessmentTextRead] | None:
        item = self._items.get(key)
        if item is None:
            return None
        if time.monotonic() - item[0] > ttl:
            self._items.pop(key, None)
            return None
        self._items.move_to_end(key)
        return item

    def put(self, key: tuple, value: AssessmentTextRead) -> None:
        self._items[key] = (time.monotonic(), value)
        self._items.move_to_end(key)
        while len(self._items) > CACHE_MAX_ENTRIES:
            self._items.popitem(last=False)

    def clear(self) -> None:
        self._items.clear()


assessment_cache = _AssessmentCache()


def _metrics_read(m: WindowMetrics) -> ProgressMetricsRead:
    return ProgressMetricsRead(
        reading_assessment=m.reading_assessment,
        sessions=m.sessions,
        active_days=m.active_days,
        reading_minutes=m.reading_minutes,
        books=m.books,
        pages_compared=m.pages_compared,
        words_read=m.words_read,
        coverage_pct=m.coverage_pct,
        accuracy_pct=m.accuracy_pct,
        skipped_rate_pct=m.skipped_rate_pct,
        substitution_rate_pct=m.substitution_rate_pct,
        hesitations=m.hesitations,
        repeated_words=m.repeated_words,
        hesitations_per_100_words=m.hesitations_per_100_words,
        words_per_minute=m.words_per_minute,
        comprehension_answered=m.comprehension_answered,
        comprehension_first_try_pct=m.comprehension_first_try_pct,
        comprehension_by_type=[
            ComprehensionTypeRead(type=name, answered=a, first_try_correct=c)
            for name, (a, c) in m.comprehension_by_type.items()
        ],
        retry_confirmed=m.retry_confirmed,
        retry_failed=m.retry_failed,
    )


class ChildProgressService:
    """Router -> ChildProgressService -> ChildProgressRepository -> PostgreSQL.

    Scores come from the data; the AI only writes the comments.
    """

    def __init__(
        self,
        repository: ChildProgressRepository,
        ai: ChildProgressAI | None = None,
        config: ChildProgressConfig | None = None,
        now: Callable[[], datetime] | None = None,
    ) -> None:
        self.repository = repository
        self.config = config or ChildProgressConfig.from_environment()
        self.ai = ai or ChildProgressAI(self.config)
        self._now = now or (lambda: datetime.now(VIETNAM_TZ))

    async def assess(
        self,
        child_id: UUID,
        actor_id: UUID,
        *,
        days: int = 30,
        use_ai: bool = False,
        refresh: bool = False,
    ) -> ChildProgressAssessmentRead:
        if not 7 <= days <= 90:
            raise HTTPException(422, "Invalid period")
        if await self.repository.owned_child(child_id, actor_id) is None:
            # Same answer for a missing child and another parent's child.
            raise HTTPException(status.HTTP_404_NOT_FOUND, "Child profile not found")

        end: date = self._now().astimezone(VIETNAM_TZ).date()
        start = end - timedelta(days=days - 1)
        previous_end = start - timedelta(days=1)
        previous_start = previous_end - timedelta(days=days - 1)
        since = datetime.combine(previous_start, day_time.min, tzinfo=VIETNAM_TZ)

        sessions = await self.repository.sessions(child_id, since)
        reports = await self.repository.reports(child_id, since)
        retries = await self.repository.word_retries(child_id, since)
        answers = await self.repository.answers(child_id, since)
        await self.repository.release()

        data = dict(sessions=sessions, reports=reports, retries=retries, answers=answers)
        current = compute_window(start=start, end=end, **data)
        previous = compute_window(start=previous_start, end=previous_end, **data)

        components = component_scores(current, days)
        previous_components = component_scores(previous, days)
        overall = overall_score(components)
        previous_overall = overall_score(previous_components)
        facts = AssessmentFacts(
            days=days,
            metrics=current,
            previous=previous,
            components=components,
            previous_components=previous_components,
            overall=overall,
            previous_overall=previous_overall,
            difficult_words=top_difficult_words(current),
        )

        text, cached = await self._comments(
            child_id, facts, use_ai=use_ai, refresh=refresh
        )
        grade = grade_for(overall)
        previous_by_key = {c.key: c.score for c in previous_components}
        return ChildProgressAssessmentRead(
            child_id=child_id,
            period_start=start,
            period_end=end,
            days=days,
            generated_at=self._now(),
            data_status="OK" if overall is not None else "INSUFFICIENT",
            score=ScoreRead(
                overall=overall,
                previous_overall=previous_overall,
                delta=facts.delta,
                grade=grade[0] if grade else None,
                grade_label=grade[1] if grade else None,
                components=[
                    ScoreComponentRead(
                        key=c.key,
                        label=c.label,
                        score=c.score,
                        previous_score=previous_by_key.get(c.key),
                        detail=c.detail,
                    )
                    for c in components
                ],
            ),
            metrics=_metrics_read(current),
            weekly=[WeeklyPointRead(**week) for week in current.weekly],
            difficult_words=[DifficultWordStatRead(**word) for word in facts.difficult_words],
            assessment=text,
            ai_cached=cached,
        )

    async def _comments(
        self, child_id: UUID, facts: AssessmentFacts, *, use_ai: bool, refresh: bool
    ) -> tuple[AssessmentTextRead, bool]:
        fallback = rule_based_assessment(facts)
        if facts.overall is None:
            return fallback, False  # nothing meaningful to ask an AI about

        payload = facts_payload(facts)
        fingerprint = hashlib.sha256(
            json.dumps(payload, sort_keys=True, ensure_ascii=False).encode("utf-8")
        ).hexdigest()
        key = (str(child_id), facts.days, fingerprint)
        ttl = self.config.cache_ttl_seconds

        cached = assessment_cache.get(key, ttl)
        if cached is not None:
            age = time.monotonic() - cached[0]
            if not (use_ai and refresh and age >= self.config.refresh_cooldown_seconds):
                return cached[1], True
        if not (use_ai and self.ai.available):
            return fallback, False

        try:
            text = await self.ai.assess(
                payload, allowed_words=[w["word"] for w in facts.difficult_words]
            )
        except AssessmentAIError as error:
            logger.warning("Progress AI unavailable, using rule-based comments: %s", error.attempts)
            return fallback, False
        assessment_cache.put(key, text)
        return text, False
