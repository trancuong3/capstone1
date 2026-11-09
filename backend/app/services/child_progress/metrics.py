"""Pure functions turning stored reading data into progress metrics.

Everything here is deterministic and has no I/O, so the numbers shown to
parents never depend on an AI model.
"""

from __future__ import annotations

from collections import Counter, defaultdict
from dataclasses import dataclass, field
from datetime import date, datetime, timedelta, timezone
from typing import Any
from uuid import UUID

VIETNAM_TZ = timezone(timedelta(hours=7))
FINISHED_STATES = ("COMPLETED", "FINISHED")
MAX_SESSION_MINUTES = 90  # a forgotten open session must not inflate minutes
MIN_WORD_LENGTH = 2
QUESTION_TYPES = ("FACTUAL", "CLOZE", "VOCABULARY")


@dataclass(frozen=True)
class SessionRow:
    id: UUID
    book_id: UUID
    state: str
    started_at: datetime
    ended_at: datetime | None


@dataclass(frozen=True)
class ReportRow:
    session_id: UUID
    created_at: datetime
    alignment: Any
    summary: Any


@dataclass(frozen=True)
class RetryEventRow:
    session_id: UUID
    status: str
    created_at: datetime


@dataclass(frozen=True)
class AnswerRow:
    question_id: UUID
    question_type: str
    is_correct: bool | None
    created_at: datetime


@dataclass
class WindowMetrics:
    sessions: int = 0
    active_days: int = 0
    reading_minutes: int = 0
    books: int = 0
    pages_compared: int = 0
    words_read: int = 0
    correct_words: int = 0
    substituted_words: int = 0
    skipped_words: int = 0
    inserted_words: int = 0
    book_words_total: int = 0
    hesitations: int = 0
    repeated_words: int = 0
    compared_session_minutes: float = 0.0
    comprehension_answered: int = 0
    comprehension_first_try_correct: int = 0
    comprehension_by_type: dict[str, list[int]] = field(default_factory=dict)
    retry_confirmed: int = 0
    retry_failed: int = 0
    word_errors: Counter = field(default_factory=Counter)
    heard_as: dict[str, Counter] = field(default_factory=lambda: defaultdict(Counter))
    weekly: list[dict[str, Any]] = field(default_factory=list)

    @property
    def accuracy_pct(self) -> float | None:
        return _pct(self.correct_words, self.words_read)

    @property
    def coverage_pct(self) -> float | None:
        return _pct(self.words_read, self.book_words_total)

    @property
    def skipped_rate_pct(self) -> float | None:
        return _pct(self.skipped_words, self.words_read)

    @property
    def substitution_rate_pct(self) -> float | None:
        return _pct(self.substituted_words, self.words_read)

    @property
    def hesitations_per_100_words(self) -> float | None:
        if self.words_read <= 0:
            return None
        return round((self.hesitations + self.repeated_words) * 100 / self.words_read, 1)

    @property
    def words_per_minute(self) -> float | None:
        if self.compared_session_minutes < 1 or self.words_read <= 0:
            return None
        return round(min(250.0, self.words_read / self.compared_session_minutes), 1)

    @property
    def comprehension_first_try_pct(self) -> float | None:
        return _pct(self.comprehension_first_try_correct, self.comprehension_answered)


def _pct(part: int | float, whole: int | float) -> float | None:
    if whole <= 0:
        return None
    return round(part * 100 / whole, 1)


def local_date(moment: datetime) -> date:
    if moment.tzinfo is None:
        moment = moment.replace(tzinfo=timezone.utc)
    return moment.astimezone(VIETNAM_TZ).date()


def normalize_word(value: Any) -> str:
    if not isinstance(value, str):
        return ""
    return value.strip().strip(".,;:!?…\"'“”‘’()[]").lower()


def analyze_alignment(alignment: Any) -> dict[str, Any] | None:
    """Count what the child read in one page comparison.

    Words after the last word the child actually attempted were simply not
    reached; they are not held against accuracy (only skips *before* the last
    attempted word count as omissions).
    """

    if not isinstance(alignment, list):
        return None
    entries = [item for item in alignment if isinstance(item, dict)]
    attempted = [
        item.get("book_index")
        for item in entries
        if item.get("status") in ("MATCH", "SUBSTITUTE")
        and isinstance(item.get("book_index"), int)
    ]
    if not attempted:
        return None
    last = max(attempted)

    correct = substituted = skipped = inserted = book_total = 0
    errors: Counter = Counter()
    heard: dict[str, Counter] = defaultdict(Counter)
    for item in entries:
        status = item.get("status")
        index = item.get("book_index")
        if status == "INSERT":
            inserted += 1
            continue
        if not isinstance(index, int):
            continue
        book_total += 1
        if index > last:
            continue
        word = normalize_word(item.get("book_word"))
        if status == "MATCH":
            correct += 1
        elif status == "SUBSTITUTE":
            substituted += 1
            if len(word) >= MIN_WORD_LENGTH:
                errors[word] += 1
                spoken = normalize_word(item.get("spoken_word"))
                if spoken and spoken != word:
                    heard[word][spoken] += 1
        elif status == "DELETE":
            skipped += 1
            if len(word) >= MIN_WORD_LENGTH:
                errors[word] += 1
    return {
        "reached": correct + substituted + skipped,
        "correct": correct,
        "substituted": substituted,
        "skipped": skipped,
        "inserted": inserted,
        "book_total": book_total,
        "errors": errors,
        "heard": heard,
    }


def _summary_counts(summary: Any) -> tuple[int, int]:
    if not isinstance(summary, dict):
        return 0, 0
    hesitations = summary.get("hesitations")
    repeated = summary.get("repeated_count")
    return (
        len(hesitations) if isinstance(hesitations, list) else 0,
        repeated if isinstance(repeated, int) and not isinstance(repeated, bool) and repeated >= 0 else 0,
    )


def session_minutes(session: SessionRow) -> float:
    if session.ended_at is None:
        return 0.0
    seconds = (session.ended_at - session.started_at).total_seconds()
    return max(0.0, min(seconds / 60, float(MAX_SESSION_MINUTES)))


def compute_window(
    *,
    start: date,
    end: date,
    sessions: list[SessionRow],
    reports: list[ReportRow],
    retries: list[RetryEventRow],
    answers: list[AnswerRow],
) -> WindowMetrics:
    """Aggregate everything whose local date falls in [start, end]."""

    def inside(moment: datetime) -> bool:
        return start <= local_date(moment) <= end

    window_sessions = [s for s in sessions if inside(s.started_at)]
    window_ids = {s.id for s in window_sessions}
    finished = [s for s in window_sessions if s.state in FINISHED_STATES]

    metrics = WindowMetrics()
    metrics.sessions = len(finished)
    metrics.active_days = len({local_date(s.started_at) for s in finished})
    metrics.reading_minutes = round(sum(session_minutes(s) for s in finished))
    metrics.books = len({s.book_id for s in finished})

    minutes_by_session = {s.id: session_minutes(s) for s in window_sessions}
    compared_sessions: set[UUID] = set()
    weekly_words: dict[int, list[int]] = defaultdict(lambda: [0, 0])  # correct, reached

    for report in reports:
        if report.session_id not in window_ids:
            continue
        analysis = analyze_alignment(report.alignment)
        if analysis is None:
            continue
        metrics.pages_compared += 1
        metrics.words_read += analysis["reached"]
        metrics.correct_words += analysis["correct"]
        metrics.substituted_words += analysis["substituted"]
        metrics.skipped_words += analysis["skipped"]
        metrics.inserted_words += analysis["inserted"]
        metrics.book_words_total += analysis["book_total"]
        hesitations, repeated = _summary_counts(report.summary)
        metrics.hesitations += hesitations
        metrics.repeated_words += repeated
        metrics.word_errors.update(analysis["errors"])
        for word, counter in analysis["heard"].items():
            metrics.heard_as[word].update(counter)
        compared_sessions.add(report.session_id)
        bucket = weekly_words[(local_date(report.created_at) - start).days // 7]
        bucket[0] += analysis["correct"]
        bucket[1] += analysis["reached"]

    metrics.compared_session_minutes = sum(
        minutes_by_session.get(session_id, 0.0) for session_id in compared_sessions
    )

    for retry in retries:
        if retry.session_id in window_ids and inside(retry.created_at):
            if retry.status == "CONFIRMED":
                metrics.retry_confirmed += 1
            elif retry.status == "FAILED":
                metrics.retry_failed += 1

    # Comprehension counts the first answer of each question (retries do not
    # make the first attempt any better).
    first_by_question: dict[UUID, AnswerRow] = {}
    for answer in sorted(answers, key=lambda item: item.created_at):
        if answer.question_id not in first_by_question and inside(answer.created_at):
            first_by_question[answer.question_id] = answer
    by_type = {name: [0, 0] for name in QUESTION_TYPES}
    for answer in first_by_question.values():
        if answer.is_correct is None:
            continue
        metrics.comprehension_answered += 1
        if answer.is_correct:
            metrics.comprehension_first_try_correct += 1
        if answer.question_type in by_type:
            by_type[answer.question_type][0] += 1
            by_type[answer.question_type][1] += 1 if answer.is_correct else 0
    metrics.comprehension_by_type = {k: v for k, v in by_type.items() if v[0] > 0}

    # Weekly series (7-day buckets starting at `start`).
    days = (end - start).days + 1
    for index in range(max(1, -(-days // 7))):
        week_start = start + timedelta(days=index * 7)
        week_end = min(end, week_start + timedelta(days=6))
        week_sessions = [
            s for s in finished if week_start <= local_date(s.started_at) <= week_end
        ]
        correct, reached = weekly_words.get(index, [0, 0])
        metrics.weekly.append(
            {
                "week_start": week_start,
                "sessions": len(week_sessions),
                "minutes": round(sum(session_minutes(s) for s in week_sessions)),
                "accuracy_pct": _pct(correct, reached),
            }
        )
    return metrics


def top_difficult_words(metrics: WindowMetrics, limit: int = 8) -> list[dict[str, Any]]:
    ranked = sorted(metrics.word_errors.items(), key=lambda item: (-item[1], item[0]))[:limit]
    result = []
    for word, times in ranked:
        heard = metrics.heard_as.get(word)
        heard_as = heard.most_common(1)[0][0] if heard else None
        result.append({"word": word, "times": times, "heard_as": heard_as})
    return result
