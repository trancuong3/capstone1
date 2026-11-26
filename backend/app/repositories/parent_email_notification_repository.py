from __future__ import annotations

from collections import Counter
from collections.abc import Mapping
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from uuid import UUID

from sqlalchemy import and_, desc, exists, func, or_, select, text, update
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.ext.asyncio import AsyncSession

from app.models import (
    ChildProfile,
    FluencyAssessment,
    PageRevisionWord,
    Profile,
    ReadingComparisonReport,
    ReadingEvent,
    ReadingGoal,
    ReadingSession,
)
from app.models.parent_email_notification import (
    ParentEmailDelivery,
    ParentEmailPreference,
)
from app.services.child_progress.metrics import (
    ReportRow,
    analyze_first_pass,
    first_pass_reports,
    normalize_word,
)

COMPLETED_SESSION_STATES = ("COMPLETED", "FINISHED")
DIFFICULT_EVENT_TYPES = ("MISPRONUNCIATION", "SUBSTITUTION", "OMISSION", "LONG_PAUSE")
DIFFICULT_RETRY_STATUSES = ("FAILED", "UNCERTAIN")
IGNORED_EVENT_STATUSES = ("IGNORED_BY_GATE", "DISMISSED")


def _ensure_utc(value: datetime | None, fallback: datetime) -> datetime:
    if value is None:
        return fallback
    if value.tzinfo is None:
        return value.replace(tzinfo=timezone.utc)
    return value


def _summarize_comparison_reports(
    reports: list[ReadingComparisonReport],
    fallback_now: datetime,
) -> tuple[float | None, Counter[str]]:
    """Compute first-pass accuracy (0..100) and difficult-word counts from comparison reports."""
    report_rows: list[ReportRow] = []
    for row in reports:
        session_id = getattr(row, "SessionId", None)
        if session_id is None:
            continue
        report_rows.append(
            ReportRow(
                session_id=session_id,
                created_at=_ensure_utc(getattr(row, "CreatedAt", None), fallback_now),
                alignment=getattr(row, "Alignment", None),
                summary=getattr(row, "Summary", None),
                page_id=getattr(row, "PageId", None),
                page_revision_id=getattr(row, "PageRevisionId", None),
                transcript=getattr(row, "Transcript", None) or "",
            )
        )
    if not report_rows:
        return None, Counter()

    total_correct = 0
    total_reached = 0
    word_errors: Counter[str] = Counter()
    for report in first_pass_reports(report_rows):
        try:
            analysis = analyze_first_pass(report)
        except (TypeError, ValueError, KeyError, AttributeError):
            continue
        if not isinstance(analysis, Mapping):
            continue
        reached = analysis.get("reached")
        correct = analysis.get("correct")
        if (
            isinstance(reached, int)
            and not isinstance(reached, bool)
            and reached > 0
            and isinstance(correct, int)
            and not isinstance(correct, bool)
            and correct >= 0
        ):
            total_reached += reached
            total_correct += min(correct, reached)
        errors = analysis.get("errors")
        if isinstance(errors, Mapping):
            for raw_word, count in errors.items():
                word = normalize_word(raw_word)
                if (
                    word
                    and isinstance(count, int)
                    and not isinstance(count, bool)
                    and count > 0
                ):
                    word_errors[word] += count

    if total_reached <= 0:
        return None, word_errors
    accuracy_pct = max(0.0, min(100.0, round(total_correct * 100.0 / total_reached, 1)))
    return accuracy_pct, word_errors


@dataclass(frozen=True)
class ActiveParentBundle:
    parent_id: UUID
    display_name: str | None
    children: tuple[ChildProfile, ...]
    preferences: ParentEmailPreference | None
    created_at: datetime | None = None


@dataclass(frozen=True)
class ChildActivitySnapshot:
    child: ChildProfile
    sessions_last_7d: tuple[ReadingSession, ...]
    sessions_prev_7d_count: int
    sessions_last_35d: tuple[ReadingSession, ...]
    total_completed_sessions: int
    last_session_at: datetime | None
    avg_fluency_last_7d: float | None
    top_difficult_words_last_7d: tuple[str, ...]
    active_goals: tuple[ReadingGoal, ...]
    first_completed_session_at: datetime | None = None


class ParentEmailNotificationRepository:
    """SQLAlchemy persistence for parent email preferences, ledger, and activity reads."""

    def __init__(self, db: AsyncSession):
        self.db = db

    async def get_preferences(self, parent_id: UUID) -> ParentEmailPreference | None:
        return await self.db.scalar(
            select(ParentEmailPreference).where(
                ParentEmailPreference.ParentId == parent_id
            )
        )

    async def get_profile(self, parent_id: UUID) -> Profile | None:
        return await self.db.scalar(
            select(Profile).where(Profile.Id == parent_id, Profile.Active == 1)
        )

    async def upsert_preferences(
        self, parent_id: UUID, values: dict[str, object], now: datetime
    ) -> ParentEmailPreference:
        insert_values = {"ParentId": parent_id, "UpdatedAt": now, **values}
        column_map = {
            "WeeklyDigestEnabled": "weeklydigestenabled",
            "InactivityAlertEnabled": "inactivityalertenabled",
            "InactivityDays": "inactivitydays",
            "MilestoneEnabled": "milestoneenabled",
            "DigestWeekday": "digestweekday",
            "Timezone": "timezone",
            "QuietHoursStart": "quiethoursstart",
            "QuietHoursEnd": "quiethoursend",
            "MaxEmailsPerWeek": "maxemailsperweek",
        }
        update_values: dict[str, object] = {"updatedat": now}
        for attr_name, col_name in column_map.items():
            if attr_name in values:
                update_values[col_name] = values[attr_name]

        statement = (
            insert(ParentEmailPreference)
            .values(**insert_values)
            .on_conflict_do_update(
                index_elements=["parentid"],
                set_=update_values,
            )
        )
        await self.db.execute(statement)
        await self.db.commit()
        row = await self.get_preferences(parent_id)
        if row is None:  # pragma: no cover - defensive
            raise RuntimeError("Parent email preferences were not persisted")
        return row

    async def list_recent_deliveries(
        self, parent_id: UUID, *, limit: int = 10
    ) -> list[ParentEmailDelivery]:
        result = await self.db.execute(
            select(ParentEmailDelivery)
            .where(ParentEmailDelivery.ParentId == parent_id)
            .order_by(desc(ParentEmailDelivery.CreatedAt), desc(ParentEmailDelivery.Id))
            .limit(limit)
        )
        return list(result.scalars().all())

    async def count_automated_sent_since(
        self, parent_id: UUID, since: datetime
    ) -> int:
        return int(
            await self.db.scalar(
                select(func.count())
                .select_from(ParentEmailDelivery)
                .where(
                    ParentEmailDelivery.ParentId == parent_id,
                    ParentEmailDelivery.Category.in_(
                        ("WEEKLY_DIGEST", "INACTIVITY_ALERT", "MILESTONE")
                    ),
                    ParentEmailDelivery.Status.in_(("SENDING", "SENT")),
                    ParentEmailDelivery.CreatedAt >= since,
                )
            )
            or 0
        )

    async def last_sent_for_category(
        self, parent_id: UUID, category: str
    ) -> ParentEmailDelivery | None:
        return await self.db.scalar(
            select(ParentEmailDelivery)
            .where(
                ParentEmailDelivery.ParentId == parent_id,
                ParentEmailDelivery.Category == category,
                ParentEmailDelivery.Status == "SENT",
            )
            .order_by(desc(ParentEmailDelivery.SentAt), desc(ParentEmailDelivery.CreatedAt))
            .limit(1)
        )

    async def count_inactivity_alerts_since(
        self, parent_id: UUID, since: datetime | None
    ) -> int:
        stmt = (
            select(func.count())
            .select_from(ParentEmailDelivery)
            .where(
                ParentEmailDelivery.ParentId == parent_id,
                ParentEmailDelivery.Category == "INACTIVITY_ALERT",
                ParentEmailDelivery.Status == "SENT",
            )
        )
        if since is not None:
            stmt = stmt.where(ParentEmailDelivery.SentAt >= since)
        return int(await self.db.scalar(stmt) or 0)

    async def is_storage_ready(self) -> bool:
        """Safely probe migration table existence without aborting the transaction."""
        prefs_tbl = await self.db.scalar(
            select(text("to_regclass('public.parentemailpreferences')"))
        )
        deliveries_tbl = await self.db.scalar(
            select(text("to_regclass('public.parentemaildeliveries')"))
        )
        return prefs_tbl is not None and deliveries_tbl is not None

    async def recover_stale_sending(
        self, now: datetime, *, stale_after: timedelta
    ) -> int:
        """Mark abandoned SENDING rows as FAILED (at-most-once; frees weekly budget)."""
        cutoff = now - stale_after
        result = await self.db.execute(
            update(ParentEmailDelivery)
            .where(
                ParentEmailDelivery.Status == "SENDING",
                or_(
                    ParentEmailDelivery.LastAttemptAt.is_(None),
                    ParentEmailDelivery.LastAttemptAt <= cutoff,
                ),
            )
            .values(
                Status="FAILED",
                ErrorCode="UNKNOWN_DELIVERY",
                NextAttemptAt=None,
            )
            .returning(ParentEmailDelivery.Id)
        )
        recovered = len(result.scalars().all())
        if recovered:
            await self.db.commit()
        return recovered

    async def get_delivery_by_dedupe_key(
        self, dedupe_key: str
    ) -> ParentEmailDelivery | None:
        return await self.db.scalar(
            select(ParentEmailDelivery).where(
                ParentEmailDelivery.DedupeKey == dedupe_key
            )
        )

    async def delivery_exists(self, dedupe_key: str) -> bool:
        return (await self.get_delivery_by_dedupe_key(dedupe_key)) is not None

    async def insert_and_claim_delivery(
        self,
        *,
        parent_id: UUID,
        child_id: UUID | None,
        category: str,
        dedupe_key: str,
        subject: str,
        metadata: dict[str, object],
        now: datetime,
    ) -> ParentEmailDelivery | None:
        """Atomically insert & claim a delivery row. Returns None if already created."""
        statement = (
            insert(ParentEmailDelivery)
            .values(
                ParentId=parent_id,
                ChildId=child_id,
                Category=category,
                DedupeKey=dedupe_key,
                Status="SENDING",
                Subject=subject[:200],
                Attempts=1,
                LastAttemptAt=now,
                Metadata=metadata,
            )
            .on_conflict_do_nothing(index_elements=["dedupekey"])
            .returning(ParentEmailDelivery.Id)
        )
        delivery_id = await self.db.scalar(statement)
        await self.db.commit()
        if delivery_id is None:
            return None
        return await self.db.get(ParentEmailDelivery, delivery_id)

    async def claim_or_retry_delivery(
        self,
        *,
        parent_id: UUID,
        child_id: UUID | None,
        category: str,
        dedupe_key: str,
        subject: str,
        metadata: dict[str, object],
        now: datetime,
        max_attempts: int = 3,
    ) -> ParentEmailDelivery | None:
        """Atomically insert a new delivery OR re-claim a due RETRY row."""
        created = await self.insert_and_claim_delivery(
            parent_id=parent_id,
            child_id=child_id,
            category=category,
            dedupe_key=dedupe_key,
            subject=subject,
            metadata=metadata,
            now=now,
        )
        if created is not None:
            return created

        retry_stmt = (
            update(ParentEmailDelivery)
            .where(
                ParentEmailDelivery.DedupeKey == dedupe_key,
                ParentEmailDelivery.Status == "RETRY",
                ParentEmailDelivery.Attempts < max_attempts,
                or_(
                    ParentEmailDelivery.NextAttemptAt.is_(None),
                    ParentEmailDelivery.NextAttemptAt <= now,
                ),
            )
            .values(
                Status="SENDING",
                Attempts=ParentEmailDelivery.Attempts + 1,
                LastAttemptAt=now,
                NextAttemptAt=None,
                Subject=subject[:200],
                Metadata=metadata,
            )
            .returning(ParentEmailDelivery.Id)
        )
        reclaimed_id = await self.db.scalar(retry_stmt)
        await self.db.commit()
        if reclaimed_id is None:
            return None
        return await self.db.get(ParentEmailDelivery, reclaimed_id)

    async def finish_delivery(
        self,
        delivery_id: UUID,
        *,
        status: str,
        now: datetime,
        error_code: str | None = None,
        next_attempt_at: datetime | None = None,
    ) -> None:
        values: dict[str, object] = {
            "Status": status,
            "ErrorCode": error_code,
            "NextAttemptAt": next_attempt_at,
        }
        if status == "SENT":
            values["SentAt"] = now
        await self.db.execute(
            update(ParentEmailDelivery)
            .where(ParentEmailDelivery.Id == delivery_id)
            .values(**values)
        )
        await self.db.commit()

    async def list_active_parents_with_children(
        self,
        *,
        limit: int = 200,
        after_created_at: datetime | None = None,
        after_id: UUID | None = None,
    ) -> list[ActiveParentBundle]:
        stmt = select(Profile).where(
            Profile.Role == "parent",
            Profile.Active == 1,
            exists().where(ChildProfile.ParentId == Profile.Id),
        )
        if after_created_at is not None and after_id is not None:
            stmt = stmt.where(
                or_(
                    Profile.CreatedAt > after_created_at,
                    and_(
                        Profile.CreatedAt == after_created_at,
                        Profile.Id > after_id,
                    ),
                )
            )
        parents = list(
            (
                await self.db.execute(
                    stmt.order_by(Profile.CreatedAt, Profile.Id).limit(limit)
                )
            )
            .scalars()
            .all()
        )
        if not parents:
            return []
        parent_ids = [p.Id for p in parents]
        children_rows = list(
            (
                await self.db.execute(
                    select(ChildProfile)
                    .where(ChildProfile.ParentId.in_(parent_ids))
                    .order_by(ChildProfile.CreatedAt, ChildProfile.Id)
                )
            )
            .scalars()
            .all()
        )
        prefs_rows = list(
            (
                await self.db.execute(
                    select(ParentEmailPreference).where(
                        ParentEmailPreference.ParentId.in_(parent_ids)
                    )
                )
            )
            .scalars()
            .all()
        )
        children_by_parent: dict[UUID, list[ChildProfile]] = {}
        for child in children_rows:
            children_by_parent.setdefault(child.ParentId, []).append(child)
        prefs_by_parent = {pref.ParentId: pref for pref in prefs_rows}

        bundles: list[ActiveParentBundle] = []
        for parent in parents:
            kids = children_by_parent.get(parent.Id)
            if not kids:
                continue
            bundles.append(
                ActiveParentBundle(
                    parent_id=parent.Id,
                    display_name=parent.DisplayName,
                    children=tuple(kids),
                    preferences=prefs_by_parent.get(parent.Id),
                    created_at=parent.CreatedAt,
                )
            )
        return bundles

    async def get_child_activity_snapshot(
        self, child: ChildProfile, now: datetime
    ) -> ChildActivitySnapshot:
        cutoff_7d = now - timedelta(days=7)
        cutoff_14d = now - timedelta(days=14)
        cutoff_35d = now - timedelta(days=35)

        recent_sessions = list(
            (
                await self.db.execute(
                    select(ReadingSession)
                    .where(
                        ReadingSession.ChildId == child.Id,
                        ReadingSession.State.in_(COMPLETED_SESSION_STATES),
                        ReadingSession.StartedAt >= cutoff_35d,
                        ReadingSession.EndedAt.is_not(None),
                        ReadingSession.EndedAt >= ReadingSession.StartedAt,
                        ReadingSession.EndedAt <= now,
                    )
                    .order_by(desc(ReadingSession.StartedAt))
                )
            )
            .scalars()
            .all()
        )
        sessions_last_7d = tuple(
            s for s in recent_sessions if s.StartedAt is not None and s.StartedAt >= cutoff_7d
        )
        sessions_prev_7d_count = sum(
            1
            for s in recent_sessions
            if s.StartedAt is not None and cutoff_14d <= s.StartedAt < cutoff_7d
        )

        total_completed = int(
            await self.db.scalar(
                select(func.count())
                .select_from(ReadingSession)
                .where(
                    ReadingSession.ChildId == child.Id,
                    ReadingSession.State.in_(COMPLETED_SESSION_STATES),
                    ReadingSession.EndedAt.is_not(None),
                    ReadingSession.EndedAt >= ReadingSession.StartedAt,
                    ReadingSession.EndedAt <= now,
                )
            )
            or 0
        )

        first_completed_session_at = await self.db.scalar(
            select(func.min(ReadingSession.EndedAt)).where(
                ReadingSession.ChildId == child.Id,
                ReadingSession.State.in_(COMPLETED_SESSION_STATES),
                ReadingSession.EndedAt.is_not(None),
                ReadingSession.EndedAt >= ReadingSession.StartedAt,
                ReadingSession.EndedAt <= now,
            )
        )

        # Last activity includes ANY reading session (even in-progress/started)
        # so we never send an inactivity alert if the child actually opened a session.
        last_session_at = await self.db.scalar(
            select(func.max(ReadingSession.StartedAt)).where(
                ReadingSession.ChildId == child.Id
            )
        )

        avg_fluency_raw = await self.db.scalar(
            select(func.avg(FluencyAssessment.Score))
            .join(ReadingSession, ReadingSession.Id == FluencyAssessment.SessionId)
            .where(
                ReadingSession.ChildId == child.Id,
                ReadingSession.State.in_(COMPLETED_SESSION_STATES),
                ReadingSession.StartedAt >= cutoff_7d,
                FluencyAssessment.Score.is_not(None),
            )
        )
        avg_fluency = float(avg_fluency_raw) if avg_fluency_raw is not None else None
        if avg_fluency is not None:
            if avg_fluency <= 1.0:
                avg_fluency = avg_fluency * 100.0
            avg_fluency = max(0.0, min(100.0, avg_fluency))

        comparison_report_rows = list(
            (
                await self.db.execute(
                    select(ReadingComparisonReport)
                    .join(
                        ReadingSession,
                        ReadingSession.Id == ReadingComparisonReport.SessionId,
                    )
                    .where(
                        ReadingSession.ChildId == child.Id,
                        ReadingSession.State.in_(COMPLETED_SESSION_STATES),
                        ReadingSession.StartedAt >= cutoff_7d,
                        ReadingSession.EndedAt.is_not(None),
                        ReadingSession.EndedAt >= ReadingSession.StartedAt,
                        ReadingSession.EndedAt <= now,
                    )
                    .order_by(desc(ReadingComparisonReport.CreatedAt))
                )
            )
            .scalars()
            .all()
        )
        report_accuracy, report_word_errors = _summarize_comparison_reports(
            comparison_report_rows, now
        )
        if avg_fluency is None and report_accuracy is not None:
            avg_fluency = report_accuracy

        difficult_words_rows = (
            await self.db.execute(
                select(PageRevisionWord.Text, func.count(ReadingEvent.Id).label("cnt"))
                .join(ReadingEvent, ReadingEvent.WordId == PageRevisionWord.Id)
                .join(ReadingSession, ReadingSession.Id == ReadingEvent.SessionId)
                .where(
                    ReadingSession.ChildId == child.Id,
                    ReadingSession.StartedAt >= cutoff_7d,
                    ReadingEvent.Status.notin_(IGNORED_EVENT_STATUSES),
                    or_(
                        ReadingEvent.Type.in_(DIFFICULT_EVENT_TYPES),
                        and_(
                            ReadingEvent.Type == "WORD_RETRY",
                            ReadingEvent.Status.in_(DIFFICULT_RETRY_STATUSES),
                        ),
                    ),
                )
                .group_by(PageRevisionWord.Text)
                .order_by(desc("cnt"), PageRevisionWord.Text)
                .limit(50)
            )
        ).all()
        combined_difficult_words: Counter[str] = Counter(report_word_errors)
        for raw_word, raw_count in difficult_words_rows:
            word = normalize_word(raw_word)
            count = int(raw_count or 0)
            if word and count > 0:
                combined_difficult_words[word] += count
        top_difficult_words = tuple(
            word
            for word, _count in sorted(
                combined_difficult_words.items(),
                key=lambda item: (-item[1], item[0]),
            )[:5]
        )

        active_goals = tuple(
            (
                await self.db.execute(
                    select(ReadingGoal).where(
                        ReadingGoal.ChildId == child.Id,
                        ReadingGoal.Status == "ACTIVE",
                    )
                )
            )
            .scalars()
            .all()
        )

        return ChildActivitySnapshot(
            child=child,
            sessions_last_7d=sessions_last_7d,
            sessions_prev_7d_count=sessions_prev_7d_count,
            sessions_last_35d=tuple(recent_sessions),
            total_completed_sessions=total_completed,
            last_session_at=last_session_at,
            avg_fluency_last_7d=avg_fluency,
            top_difficult_words_last_7d=top_difficult_words,
            active_goals=active_goals,
            first_completed_session_at=first_completed_session_at,
        )
