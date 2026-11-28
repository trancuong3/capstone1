from __future__ import annotations

from collections import Counter
from collections.abc import Mapping
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from uuid import UUID
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from sqlalchemy import and_, case, desc, exists, func, or_, select, text, update
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
class ParentDeliverySummary:
    automated_sent_last_7d: int
    last_digest_sent_at: datetime | None = None
    last_milestone_sent_at: datetime | None = None
    last_inactivity_sent_at: datetime | None = None


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
            select(ParentEmailPreference)
            .where(ParentEmailPreference.ParentId == parent_id)
            .execution_options(populate_existing=True)
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

    async def count_global_sent_since(self, since: datetime) -> int:
        """Count global automated/claimed email deliveries across all parents since timestamp."""
        stmt = select(func.count(ParentEmailDelivery.Id)).where(
            ParentEmailDelivery.Status.in_(("SENDING", "SENT")),
            ParentEmailDelivery.CreatedAt >= since,
        )
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

    async def expire_stale_retries(
        self,
        now: datetime,
        *,
        inactivity_retry_ttl: timedelta = timedelta(hours=24),
        digest_retry_ttl: timedelta = timedelta(hours=36),
        milestone_retry_ttl: timedelta = timedelta(hours=48),
        max_attempts: int = 3,
        limit: int = 100,
    ) -> int:
        """Expire TTL-aged retries and skip INACTIVITY_ALERT retries once reading resumes."""
        retry_rows = list(
            (
                await self.db.execute(
                    select(ParentEmailDelivery)
                    .where(ParentEmailDelivery.Status == "RETRY")
                    .order_by(ParentEmailDelivery.CreatedAt, ParentEmailDelivery.Id)
                    .limit(limit)
                )
            )
            .scalars()
            .all()
        )
        if not retry_rows:
            return 0

        utc_now = _ensure_utc(now, now)
        ttl_by_category = {
            "INACTIVITY_ALERT": inactivity_retry_ttl,
            "WEEKLY_DIGEST": digest_retry_ttl,
            "MILESTONE": milestone_retry_ttl,
        }
        updated = 0
        inactivity_rows: list[ParentEmailDelivery] = []

        for row in retry_rows:
            if (row.Attempts or 0) >= max_attempts:
                row.Status = "FAILED"
                row.ErrorCode = row.ErrorCode or "DELIVERY_RETRY_LIMIT"
                row.NextAttemptAt = None
                updated += 1
            elif row.Category == "TEST_EMAIL":
                row.Status = "SKIPPED"
                row.ErrorCode = "RETRY_EXPIRED"
                row.NextAttemptAt = None
                updated += 1
            elif (
                row.CreatedAt is not None
                and (utc_now - _ensure_utc(row.CreatedAt, utc_now))
                >= ttl_by_category.get(row.Category, inactivity_retry_ttl)
            ):
                row.Status = "SKIPPED"
                row.ErrorCode = "RETRY_EXPIRED"
                row.NextAttemptAt = None
                updated += 1
            elif row.Category == "INACTIVITY_ALERT":
                inactivity_rows.append(row)

        if inactivity_rows:
            parent_ids = list({row.ParentId for row in inactivity_rows})
            active_rows = (
                await self.db.execute(
                    select(Profile.Id, Profile.Active).where(Profile.Id.in_(parent_ids))
                )
            ).all()
            active_by_parent = {pid: active for pid, active in active_rows}

            pref_rows = list(
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
            pref_by_parent = {pref.ParentId: pref for pref in pref_rows}

            child_rows = (
                await self.db.execute(
                    select(
                        ChildProfile.Id, ChildProfile.ParentId, ChildProfile.CreatedAt
                    ).where(ChildProfile.ParentId.in_(parent_ids))
                )
            ).all()
            children_by_parent: dict[UUID, list[tuple[UUID, datetime | None]]] = {}
            child_ids: list[UUID] = []
            for child_id, parent_id, created_at in child_rows:
                children_by_parent.setdefault(parent_id, []).append(
                    (child_id, created_at)
                )
                child_ids.append(child_id)

            last_session_by_child: dict[UUID, datetime | None] = {}
            if child_ids:
                session_rows = (
                    await self.db.execute(
                        select(
                            ReadingSession.ChildId,
                            func.max(ReadingSession.StartedAt),
                        )
                        .where(ReadingSession.ChildId.in_(child_ids))
                        .group_by(ReadingSession.ChildId)
                    )
                ).all()
                last_session_by_child = {
                    cid: last_at for cid, last_at in session_rows
                }

            for row in inactivity_rows:
                pref = pref_by_parent.get(row.ParentId)
                parent_children = children_by_parent.get(row.ParentId, [])
                if (
                    active_by_parent.get(row.ParentId) != 1
                    or not parent_children
                    or (pref is not None and not pref.InactivityAlertEnabled)
                ):
                    row.Status = "SKIPPED"
                    row.ErrorCode = "PARENT_OPTED_OUT"
                    row.NextAttemptAt = None
                    updated += 1
                    continue

                threshold_days = int(pref.InactivityDays) if pref is not None else 5
                tz_name = (
                    str(pref.Timezone or "Asia/Ho_Chi_Minh")
                    if pref is not None
                    else "Asia/Ho_Chi_Minh"
                )
                try:
                    zone = ZoneInfo(tz_name)
                except (ZoneInfoNotFoundError, ValueError):
                    zone = ZoneInfo("Asia/Ho_Chi_Minh")
                local_today = utc_now.astimezone(zone).date()

                still_has_inactive_child = False
                for child_id, child_created_at in parent_children:
                    ref_at = last_session_by_child.get(child_id) or child_created_at
                    if ref_at is None:
                        continue
                    days_inactive = (
                        local_today
                        - _ensure_utc(ref_at, utc_now).astimezone(zone).date()
                    ).days
                    if days_inactive >= threshold_days:
                        still_has_inactive_child = True
                        break

                if not still_has_inactive_child:
                    row.Status = "SKIPPED"
                    row.ErrorCode = "CHILD_ACTIVITY_RESUMED"
                    row.NextAttemptAt = None
                    updated += 1

        if updated > 0:
            await self.db.commit()
        return updated

    async def get_delivery_by_dedupe_key(
        self, dedupe_key: str
    ) -> ParentEmailDelivery | None:
        return await self.db.scalar(
            select(ParentEmailDelivery)
            .where(ParentEmailDelivery.DedupeKey == dedupe_key)
            .execution_options(populate_existing=True)
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
        return await self.db.get(
            ParentEmailDelivery, reclaimed_id, populate_existing=True
        )

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
        utc_cutoff_7d = _ensure_utc(cutoff_7d, now)
        utc_cutoff_14d = _ensure_utc(cutoff_14d, now)
        sessions_last_7d = tuple(
            s
            for s in recent_sessions
            if s.StartedAt is not None
            and _ensure_utc(s.StartedAt, now) >= utc_cutoff_7d
        )
        sessions_prev_7d_count = sum(
            1
            for s in recent_sessions
            if s.StartedAt is not None
            and utc_cutoff_14d <= _ensure_utc(s.StartedAt, now) < utc_cutoff_7d
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

    async def get_parent_delivery_summaries_batch(
        self,
        parent_ids: list[UUID],
        now: datetime,
    ) -> dict[UUID, ParentDeliverySummary]:
        """Batch-fetch weekly sent counts and last-sent timestamps per category in 1 query."""
        if not parent_ids:
            return {}
        cutoff_7d = now - timedelta(days=7)
        automated_categories = ("WEEKLY_DIGEST", "INACTIVITY_ALERT", "MILESTONE")
        stmt = (
            select(
                ParentEmailDelivery.ParentId.label("parent_id"),
                func.sum(
                    case(
                        (
                            and_(
                                ParentEmailDelivery.Status.in_(("SENDING", "SENT")),
                                ParentEmailDelivery.CreatedAt >= cutoff_7d,
                            ),
                            1,
                        ),
                        else_=0,
                    )
                ).label("sent_7d"),
                func.max(
                    case(
                        (
                            and_(
                                ParentEmailDelivery.Category == "WEEKLY_DIGEST",
                                ParentEmailDelivery.Status == "SENT",
                            ),
                            ParentEmailDelivery.SentAt,
                        ),
                        else_=None,
                    )
                ).label("last_digest_sent_at"),
                func.max(
                    case(
                        (
                            and_(
                                ParentEmailDelivery.Category == "MILESTONE",
                                ParentEmailDelivery.Status == "SENT",
                            ),
                            ParentEmailDelivery.SentAt,
                        ),
                        else_=None,
                    )
                ).label("last_milestone_sent_at"),
                func.max(
                    case(
                        (
                            and_(
                                ParentEmailDelivery.Category == "INACTIVITY_ALERT",
                                ParentEmailDelivery.Status == "SENT",
                            ),
                            ParentEmailDelivery.SentAt,
                        ),
                        else_=None,
                    )
                ).label("last_inactivity_sent_at"),
            )
            .where(
                ParentEmailDelivery.ParentId.in_(parent_ids),
                ParentEmailDelivery.Category.in_(automated_categories),
            )
            .group_by(ParentEmailDelivery.ParentId)
        )
        rows = (await self.db.execute(stmt)).all()
        summaries: dict[UUID, ParentDeliverySummary] = {
            pid: ParentDeliverySummary(automated_sent_last_7d=0) for pid in parent_ids
        }
        for row in rows:
            summaries[row.parent_id] = ParentDeliverySummary(
                automated_sent_last_7d=int(row.sent_7d or 0),
                last_digest_sent_at=row.last_digest_sent_at,
                last_milestone_sent_at=row.last_milestone_sent_at,
                last_inactivity_sent_at=row.last_inactivity_sent_at,
            )
        return summaries

    async def list_retry_deliveries_batch(
        self,
        parent_ids: list[UUID],
    ) -> dict[str, ParentEmailDelivery]:
        """Batch-fetch all RETRY delivery rows for a page of parents in 1 query."""
        if not parent_ids:
            return {}
        rows = list(
            (
                await self.db.execute(
                    select(ParentEmailDelivery)
                    .where(
                        ParentEmailDelivery.ParentId.in_(parent_ids),
                        ParentEmailDelivery.Status == "RETRY",
                    )
                    .execution_options(populate_existing=True)
                )
            )
            .scalars()
            .all()
        )
        return {row.DedupeKey: row for row in rows if row.DedupeKey}

    async def get_children_activity_snapshots_batch(
        self,
        children: list[ChildProfile],
        now: datetime,
        *,
        digest_child_ids: set[UUID] | None = None,
    ) -> dict[UUID, ChildActivitySnapshot]:
        """Batch-fetch ChildActivitySnapshot for all children in 3 queries (+3 only if digest needed)."""
        if not children:
            return {}

        child_ids = [child.Id for child in children]
        cutoff_7d = now - timedelta(days=7)
        cutoff_14d = now - timedelta(days=14)
        cutoff_35d = now - timedelta(days=35)

        # 1. Recent 35d completed sessions for all children
        recent_rows = list(
            (
                await self.db.execute(
                    select(ReadingSession)
                    .where(
                        ReadingSession.ChildId.in_(child_ids),
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
        recent_by_child: dict[UUID, list[ReadingSession]] = {}
        for sess in recent_rows:
            recent_by_child.setdefault(sess.ChildId, []).append(sess)

        # 2. Aggregate total_completed, first_completed_at, and last_session_at in 1 query
        completed_cond = and_(
            ReadingSession.State.in_(COMPLETED_SESSION_STATES),
            ReadingSession.EndedAt.is_not(None),
            ReadingSession.EndedAt >= ReadingSession.StartedAt,
            ReadingSession.EndedAt <= now,
        )
        agg_rows = (
            await self.db.execute(
                select(
                    ReadingSession.ChildId.label("child_id"),
                    func.sum(case((completed_cond, 1), else_=0)).label("total_completed"),
                    func.min(
                        case((completed_cond, ReadingSession.EndedAt), else_=None)
                    ).label("first_completed_at"),
                    func.max(ReadingSession.StartedAt).label("last_session_at"),
                )
                .where(ReadingSession.ChildId.in_(child_ids))
                .group_by(ReadingSession.ChildId)
            )
        ).all()
        agg_by_child = {
            row.child_id: (
                int(row.total_completed or 0),
                row.first_completed_at,
                row.last_session_at,
            )
            for row in agg_rows
        }

        # 3. Active reading goals for all children
        goal_rows = list(
            (
                await self.db.execute(
                    select(ReadingGoal).where(
                        ReadingGoal.ChildId.in_(child_ids),
                        ReadingGoal.Status == "ACTIVE",
                    )
                )
            )
            .scalars()
            .all()
        )
        goals_by_child: dict[UUID, list[ReadingGoal]] = {}
        for goal in goal_rows:
            goals_by_child.setdefault(goal.ChildId, []).append(goal)

        # 4-6. Weekly digest accuracy & difficult-word metrics ONLY for children needing a digest
        target_digest_ids = (
            child_ids
            if digest_child_ids is None
            else [cid for cid in child_ids if cid in digest_child_ids]
        )
        fluency_by_child: dict[UUID, float] = {}
        reports_by_child: dict[UUID, list[ReadingComparisonReport]] = {}
        event_words_by_child: dict[UUID, list[tuple[str, int]]] = {}

        if target_digest_ids:
            fluency_rows = (
                await self.db.execute(
                    select(
                        ReadingSession.ChildId.label("child_id"),
                        func.avg(FluencyAssessment.Score).label("avg_score"),
                    )
                    .join(ReadingSession, ReadingSession.Id == FluencyAssessment.SessionId)
                    .where(
                        ReadingSession.ChildId.in_(target_digest_ids),
                        ReadingSession.State.in_(COMPLETED_SESSION_STATES),
                        ReadingSession.StartedAt >= cutoff_7d,
                        FluencyAssessment.Score.is_not(None),
                    )
                    .group_by(ReadingSession.ChildId)
                )
            ).all()
            for row in fluency_rows:
                if row.avg_score is not None:
                    score = float(row.avg_score)
                    if score <= 1.0:
                        score = score * 100.0
                    fluency_by_child[row.child_id] = max(0.0, min(100.0, score))

            report_pairs = (
                await self.db.execute(
                    select(ReadingSession.ChildId, ReadingComparisonReport)
                    .join(
                        ReadingSession,
                        ReadingSession.Id == ReadingComparisonReport.SessionId,
                    )
                    .where(
                        ReadingSession.ChildId.in_(target_digest_ids),
                        ReadingSession.State.in_(COMPLETED_SESSION_STATES),
                        ReadingSession.StartedAt >= cutoff_7d,
                        ReadingSession.EndedAt.is_not(None),
                        ReadingSession.EndedAt >= ReadingSession.StartedAt,
                        ReadingSession.EndedAt <= now,
                    )
                    .order_by(desc(ReadingComparisonReport.CreatedAt))
                )
            ).all()
            for cid, report in report_pairs:
                reports_by_child.setdefault(cid, []).append(report)

            difficult_rows = (
                await self.db.execute(
                    select(
                        ReadingSession.ChildId.label("child_id"),
                        PageRevisionWord.Text.label("word_text"),
                        func.count(ReadingEvent.Id).label("cnt"),
                    )
                    .join(ReadingEvent, ReadingEvent.WordId == PageRevisionWord.Id)
                    .join(ReadingSession, ReadingSession.Id == ReadingEvent.SessionId)
                    .where(
                        ReadingSession.ChildId.in_(target_digest_ids),
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
                    .group_by(ReadingSession.ChildId, PageRevisionWord.Text)
                )
            ).all()
            for row in difficult_rows:
                event_words_by_child.setdefault(row.child_id, []).append(
                    (row.word_text, int(row.cnt or 0))
                )

        utc_cutoff_7d = _ensure_utc(cutoff_7d, now)
        utc_cutoff_14d = _ensure_utc(cutoff_14d, now)
        target_digest_id_set = set(target_digest_ids)
        snapshots: dict[UUID, ChildActivitySnapshot] = {}
        for child in children:
            recent_sessions = recent_by_child.get(child.Id, [])
            sessions_last_7d = tuple(
                s
                for s in recent_sessions
                if s.StartedAt is not None
                and _ensure_utc(s.StartedAt, now) >= utc_cutoff_7d
            )
            sessions_prev_7d_count = sum(
                1
                for s in recent_sessions
                if s.StartedAt is not None
                and utc_cutoff_14d <= _ensure_utc(s.StartedAt, now) < utc_cutoff_7d
            )
            total_completed, first_completed_at, last_session_at = agg_by_child.get(
                child.Id, (0, None, None)
            )
            avg_fluency = fluency_by_child.get(child.Id)
            top_difficult_words: tuple[str, ...] = ()
            if child.Id in target_digest_id_set:
                report_accuracy, report_word_errors = _summarize_comparison_reports(
                    reports_by_child.get(child.Id, []), now
                )
                if avg_fluency is None and report_accuracy is not None:
                    avg_fluency = report_accuracy
                combined_difficult_words: Counter[str] = Counter(report_word_errors)
                for raw_word, count in event_words_by_child.get(child.Id, []):
                    word = normalize_word(raw_word)
                    if word and count > 0:
                        combined_difficult_words[word] += count
                top_difficult_words = tuple(
                    word
                    for word, _count in sorted(
                        combined_difficult_words.items(),
                        key=lambda item: (-item[1], item[0]),
                    )[:5]
                )

            snapshots[child.Id] = ChildActivitySnapshot(
                child=child,
                sessions_last_7d=sessions_last_7d,
                sessions_prev_7d_count=sessions_prev_7d_count,
                sessions_last_35d=tuple(recent_sessions),
                total_completed_sessions=total_completed,
                last_session_at=last_session_at,
                avg_fluency_last_7d=avg_fluency,
                top_difficult_words_last_7d=top_difficult_words,
                active_goals=tuple(goals_by_child.get(child.Id, ())),
                first_completed_session_at=first_completed_at,
            )
        return snapshots
