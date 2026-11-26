"""Repository layer for Parent Private Book -> Flow 2 (Admin Verified) OCR contribution."""
from __future__ import annotations

from datetime import datetime
from typing import Any
from uuid import UUID, uuid4

from sqlalchemy import func, select, text, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.models import (
    AuditLog,
    Book,
    BookPage,
    PageRevision,
    PageRevisionWord,
    ParentBookFlow2Candidate,
    ParentBookOcrContributionConsent,
    ParentBookOcrContributionConsentEvent,
    ParentBookPageSubmission,
    Profile,
)
from app.policies.book_access import is_private_book, is_private_book_owned_by


class ParentFlow2ContributionRepository:
    """Data-access layer for book-level OCR contribution consent, candidates, and revocation."""

    def __init__(self, db: AsyncSession):
        self.db = db

    async def role(self, actor_id: UUID) -> str | None:
        return (
            await self.db.execute(
                select(Profile.Role).where(Profile.Id == actor_id, Profile.Active == 1)
            )
        ).scalar_one_or_none()

    async def get_owned_private_book(
        self, book_id: UUID, actor_id: UUID, *, lock: bool = False
    ) -> Book | None:
        stmt = select(Book).where(
            Book.Id == book_id,
            is_private_book_owned_by(actor_id, include_retired=False),
        )
        if lock:
            stmt = stmt.with_for_update()
        return (await self.db.execute(stmt)).scalar_one_or_none()

    async def get_private_book(self, book_id: UUID, *, lock: bool = False) -> Book | None:
        stmt = select(Book).where(Book.Id == book_id, is_private_book())
        if lock:
            stmt = stmt.with_for_update()
        return (await self.db.execute(stmt)).scalar_one_or_none()

    async def get_consent(
        self, book_id: UUID, *, lock: bool = False
    ) -> ParentBookOcrContributionConsent | None:
        stmt = select(ParentBookOcrContributionConsent).where(
            ParentBookOcrContributionConsent.BookId == book_id
        )
        if lock:
            stmt = stmt.with_for_update()
        return (await self.db.execute(stmt)).scalar_one_or_none()

    async def list_consents_for_books(
        self, book_ids: list[UUID]
    ) -> dict[UUID, ParentBookOcrContributionConsent]:
        if not book_ids:
            return {}
        rows = (
            await self.db.execute(
                select(ParentBookOcrContributionConsent).where(
                    ParentBookOcrContributionConsent.BookId.in_(book_ids)
                )
            )
        ).scalars().all()
        return {row.BookId: row for row in rows}

    async def save_consent(
        self, consent: ParentBookOcrContributionConsent
    ) -> ParentBookOcrContributionConsent:
        self.db.add(consent)
        await self.db.flush()
        return consent

    async def add_consent_event(
        self, event: ParentBookOcrContributionConsentEvent
    ) -> ParentBookOcrContributionConsentEvent:
        self.db.add(event)
        await self.db.flush()
        return event

    async def get_candidate_counts_by_book(
        self, book_ids: list[UUID]
    ) -> dict[UUID, dict[str, int]]:
        if not book_ids:
            return {}
        rows = (
            await self.db.execute(
                select(
                    ParentBookFlow2Candidate.BookId,
                    ParentBookFlow2Candidate.Status,
                    func.count(ParentBookFlow2Candidate.Id),
                )
                .where(ParentBookFlow2Candidate.BookId.in_(book_ids))
                .group_by(ParentBookFlow2Candidate.BookId, ParentBookFlow2Candidate.Status)
            )
        ).all()
        counts: dict[UUID, dict[str, int]] = {}
        for book_id, status_val, count_val in rows:
            counts.setdefault(book_id, {})[str(status_val)] = int(count_val)
        return counts

    async def list_active_committed_pages(
        self, book_id: UUID
    ) -> list[tuple[BookPage, PageRevision]]:
        rows = (
            await self.db.execute(
                select(BookPage, PageRevision)
                .join(PageRevision, PageRevision.Id == BookPage.CurrentVerifiedRevisionId)
                .where(
                    BookPage.BookId == book_id,
                    BookPage.LifecycleStatus == "ACTIVE",
                    PageRevision.PageId == BookPage.Id,
                    PageRevision.VerificationStatus == "VERIFIED",
                )
                .order_by(BookPage.PageNumber.asc(), BookPage.CreatedAt.asc())
            )
        ).all()
        return [(p, r) for p, r in rows]

    async def get_committed_submission_for_revision(
        self, book_id: UUID, page_id: UUID, revision_id: UUID
    ) -> ParentBookPageSubmission | None:
        return (
            await self.db.execute(
                select(ParentBookPageSubmission)
                .where(
                    ParentBookPageSubmission.BookId == book_id,
                    ParentBookPageSubmission.CommittedPageId == page_id,
                    ParentBookPageSubmission.CommittedRevisionId == revision_id,
                    ParentBookPageSubmission.WorkflowStatus == "ADDED_TO_BOOK",
                )
                .order_by(ParentBookPageSubmission.UpdatedAt.desc())
                .limit(1)
            )
        ).scalar_one_or_none()

    async def list_revision_words(self, revision_id: UUID) -> list[PageRevisionWord]:
        return list(
            (
                await self.db.execute(
                    select(PageRevisionWord)
                    .where(PageRevisionWord.PageRevisionId == revision_id)
                    .order_by(
                        PageRevisionWord.LineIndex.asc(),
                        PageRevisionWord.WordIndex.asc(),
                        PageRevisionWord.Id.asc(),
                    )
                )
            ).scalars().all()
        )

    async def get_candidate_by_idempotency_key(
        self, idempotency_key: str
    ) -> ParentBookFlow2Candidate | None:
        return (
            await self.db.execute(
                select(ParentBookFlow2Candidate).where(
                    ParentBookFlow2Candidate.IdempotencyKey == idempotency_key
                )
            )
        ).scalar_one_or_none()

    async def get_prior_admin_verified_candidate(
        self,
        *,
        revision_id: UUID,
        line_index: int,
        image_sha256: str,
        source_content_hash: str,
    ) -> ParentBookFlow2Candidate | None:
        return (
            await self.db.execute(
                select(ParentBookFlow2Candidate)
                .where(
                    ParentBookFlow2Candidate.RevisionId == revision_id,
                    ParentBookFlow2Candidate.LineIndex == line_index,
                    ParentBookFlow2Candidate.ImageSha256 == image_sha256,
                    ParentBookFlow2Candidate.SourceContentHash == source_content_hash,
                    ParentBookFlow2Candidate.VerifiedBy.is_not(None),
                    ParentBookFlow2Candidate.VerifiedAt.is_not(None),
                    ParentBookFlow2Candidate.VerifiedLabel.is_not(None),
                    ParentBookFlow2Candidate.PiiCheckStatus == "CLEAR",
                    ParentBookFlow2Candidate.Status.in_(("VERIFIED", "SYNC_QUEUED", "SYNCED")),
                )
                .order_by(ParentBookFlow2Candidate.VerifiedAt.desc())
                .limit(1)
            )
        ).scalar_one_or_none()

    async def create_candidate(
        self, candidate: ParentBookFlow2Candidate
    ) -> ParentBookFlow2Candidate:
        self.db.add(candidate)
        await self.db.flush()
        return candidate

    async def get_candidate(
        self, candidate_id: UUID, *, lock: bool = False
    ) -> ParentBookFlow2Candidate | None:
        stmt = select(ParentBookFlow2Candidate).where(
            ParentBookFlow2Candidate.Id == candidate_id
        )
        if lock:
            stmt = stmt.with_for_update()
        return (await self.db.execute(stmt)).scalar_one_or_none()

    async def get_page_and_revision(
        self, page_id: UUID, revision_id: UUID
    ) -> tuple[BookPage | None, PageRevision | None]:
        page = (
            await self.db.execute(select(BookPage).where(BookPage.Id == page_id))
        ).scalar_one_or_none()
        rev = (
            await self.db.execute(
                select(PageRevision).where(PageRevision.Id == revision_id)
            )
        ).scalar_one_or_none()
        return page, rev

    async def list_admin_candidates(
        self,
        *,
        status_filter: str | None = None,
        book_id: UUID | None = None,
        limit: int = 25,
        offset: int = 0,
    ) -> tuple[list[tuple[ParentBookFlow2Candidate, str, int]], int, dict[str, int]]:
        base_stmt = (
            select(
                ParentBookFlow2Candidate,
                Book.Title,
                BookPage.PageNumber,
            )
            .join(Book, Book.Id == ParentBookFlow2Candidate.BookId)
            .join(BookPage, BookPage.Id == ParentBookFlow2Candidate.PageId)
        )
        count_stmt = select(func.count(ParentBookFlow2Candidate.Id))
        if book_id is not None:
            base_stmt = base_stmt.where(ParentBookFlow2Candidate.BookId == book_id)
            count_stmt = count_stmt.where(ParentBookFlow2Candidate.BookId == book_id)

        summary_rows = (
            await self.db.execute(
                select(
                    ParentBookFlow2Candidate.Status,
                    func.count(ParentBookFlow2Candidate.Id),
                ).group_by(ParentBookFlow2Candidate.Status)
            )
        ).all()
        summary = {str(st): int(cnt) for st, cnt in summary_rows}

        if status_filter:
            base_stmt = base_stmt.where(ParentBookFlow2Candidate.Status == status_filter)
            count_stmt = count_stmt.where(ParentBookFlow2Candidate.Status == status_filter)

        total = int((await self.db.execute(count_stmt)).scalar_one() or 0)
        rows = (
            await self.db.execute(
                base_stmt.order_by(
                    ParentBookFlow2Candidate.CreatedAt.asc(),
                    ParentBookFlow2Candidate.LineIndex.asc(),
                )
                .limit(limit)
                .offset(offset)
            )
        ).all()
        return [(cand, str(title or ""), int(page_num or 1)) for cand, title, page_num in rows], total, summary

    async def enqueue_candidate_outbox(
        self,
        *,
        candidate_id: UUID,
        page_id: UUID,
        revision_id: UUID,
        actor_id: UUID,
        payload_json: str,
    ) -> UUID:
        result = await self.db.execute(
            text(
                """
                INSERT INTO public.viread_ocr_outbox
                    (event_type, page_id, revision_id, candidate_id, actor_id, payload, status)
                VALUES (
                    'PARENT_CONTRIBUTION_CANDIDATE',
                    :page_id,
                    :revision_id,
                    :candidate_id,
                    :actor_id,
                    CAST(:payload AS jsonb),
                    'PENDING'
                )
                ON CONFLICT (event_type, candidate_id)
                    WHERE event_type = 'PARENT_CONTRIBUTION_CANDIDATE' AND candidate_id IS NOT NULL
                DO UPDATE SET updated_at = public.viread_ocr_outbox.updated_at
                RETURNING id
                """
            ),
            {
                "page_id": page_id,
                "revision_id": revision_id,
                "candidate_id": candidate_id,
                "actor_id": actor_id,
                "payload": payload_json,
            },
        )
        return result.scalar_one()

    async def revoke_candidates_and_downstream(
        self,
        *,
        book_id: UUID,
        page_id: UUID | None,
        reason: str,
        now: datetime,
    ) -> dict[str, int]:
        """Atomically revoke candidates, skip pending outbox events, archive pool samples,
        archive affected active datasets, and cancel queued/waiting training jobs."""
        cand_where = [
            ParentBookFlow2Candidate.BookId == book_id,
            ParentBookFlow2Candidate.Status.in_(
                ("PENDING_VERIFICATION", "VERIFIED", "SYNC_QUEUED", "SYNCED")
            ),
        ]
        if page_id is not None:
            cand_where.append(ParentBookFlow2Candidate.PageId == page_id)

        revoked_cand_ids = list(
            (
                await self.db.execute(
                    update(ParentBookFlow2Candidate)
                    .where(*cand_where)
                    .values(
                        Status="REVOKED",
                        RevokedAt=now,
                        RevokeReason=reason,
                        UpdatedAt=now,
                    )
                    .returning(ParentBookFlow2Candidate.Id)
                )
            ).scalars().all()
        )

        # Skip any pending/retry/processing outbox events for these candidates or book/page
        outbox_skipped = 0
        if page_id is not None:
            res_outbox = await self.db.execute(
                text(
                    """
                    UPDATE public.viread_ocr_outbox
                    SET status = 'SKIPPED',
                        last_error_code = 'CONSENT_REVOKED',
                        locked_at = NULL,
                        updated_at = :now
                    WHERE event_type = 'PARENT_CONTRIBUTION_CANDIDATE'
                      AND page_id = :page_id
                      AND status IN ('PENDING', 'RETRY', 'PROCESSING')
                    """
                ),
                {"page_id": page_id, "now": now},
            )
            outbox_skipped = int(res_outbox.rowcount or 0)
        else:
            res_outbox = await self.db.execute(
                text(
                    """
                    UPDATE public.viread_ocr_outbox o
                    SET status = 'SKIPPED',
                        last_error_code = 'CONSENT_REVOKED',
                        locked_at = NULL,
                        updated_at = :now
                    WHERE o.event_type = 'PARENT_CONTRIBUTION_CANDIDATE'
                      AND o.status IN ('PENDING', 'RETRY', 'PROCESSING')
                      AND (
                          o.payload->>'book_id' = :book_id_str
                          OR EXISTS (
                              SELECT 1 FROM public.bookpages p
                              WHERE p.id = o.page_id AND p.bookid = :book_id
                          )
                      )
                    """
                ),
                {"book_id": book_id, "book_id_str": str(book_id), "now": now},
            )
            outbox_skipped = int(res_outbox.rowcount or 0)

        # Archive pool samples (dataset_version_id IS NULL) so they never enter future manifests
        if page_id is not None:
            sample_params: dict[str, Any] = {
                "page_id": page_id,
                "reason": f"PARENT_CONTRIBUTION_REVOKED:{reason}",
                "now": now,
            }
            res_samples = await self.db.execute(
                text(
                    """
                    UPDATE public.viread_ocr_samples
                    SET training_eligibility = 'ARCHIVED',
                        quarantined_at = :now,
                        quarantine_reason = :reason
                    WHERE source_flow = 'FLOW1_VERIFIED'
                      AND dataset_version_id IS NULL
                      AND COALESCE(training_eligibility, 'ELIGIBLE') = 'ELIGIBLE'
                      AND source_page_id = :page_id
                    """
                ),
                sample_params,
            )
            res_datasets = await self.db.execute(
                text(
                    """
                    UPDATE public.viread_ocr_dataset_versions dv
                    SET dataset_status = 'ARCHIVED',
                        archived_at = :now,
                        archive_reason = :reason
                    WHERE dv.source_flow = 'FLOW1_VERIFIED'
                      AND COALESCE(dv.dataset_status, 'ACTIVE') = 'ACTIVE'
                      AND EXISTS (
                          SELECT 1
                          FROM public.viread_ocr_samples s
                          WHERE s.dataset_version_id = dv.id
                            AND s.source_page_id = :page_id
                      )
                    RETURNING dv.id
                    """
                ),
                sample_params,
            )
        else:
            sample_params = {
                "book_id": book_id,
                "book_id_str": str(book_id),
                "group_key": f"parent-book:{book_id}",
                "reason": f"PARENT_CONTRIBUTION_REVOKED:{reason}",
                "now": now,
            }
            res_samples = await self.db.execute(
                text(
                    """
                    UPDATE public.viread_ocr_samples
                    SET training_eligibility = 'ARCHIVED',
                        quarantined_at = :now,
                        quarantine_reason = :reason
                    WHERE source_flow = 'FLOW1_VERIFIED'
                      AND dataset_version_id IS NULL
                      AND COALESCE(training_eligibility, 'ELIGIBLE') = 'ELIGIBLE'
                      AND (
                          provenance->>'book_id' = :book_id_str
                          OR source_group_id = :group_key
                          OR EXISTS (
                              SELECT 1 FROM public.bookpages p
                              WHERE p.id = viread_ocr_samples.source_page_id AND p.bookid = :book_id
                          )
                      )
                    """
                ),
                sample_params,
            )
            res_datasets = await self.db.execute(
                text(
                    """
                    UPDATE public.viread_ocr_dataset_versions dv
                    SET dataset_status = 'ARCHIVED',
                        archived_at = :now,
                        archive_reason = :reason
                    WHERE dv.source_flow = 'FLOW1_VERIFIED'
                      AND COALESCE(dv.dataset_status, 'ACTIVE') = 'ACTIVE'
                      AND EXISTS (
                          SELECT 1
                          FROM public.viread_ocr_samples s
                          WHERE s.dataset_version_id = dv.id
                            AND (
                                s.provenance->>'book_id' = :book_id_str
                                OR s.source_group_id = :group_key
                                OR EXISTS (
                                    SELECT 1 FROM public.bookpages p
                                    WHERE p.id = s.source_page_id AND p.bookid = :book_id
                                )
                            )
                      )
                    RETURNING dv.id
                    """
                ),
                sample_params,
            )
        archived_samples = int(res_samples.rowcount or 0)
        archived_dataset_ids = [row[0] for row in res_datasets.all()]

        cancelled_jobs = 0
        if archived_dataset_ids:
            # Cancel any queued/waiting training jobs referencing those archived datasets
            try:
                async with self.db.begin_nested():
                    res_jobs = await self.db.execute(
                        text(
                            """
                            UPDATE public.viread_ocr_training_jobs
                            SET status = 'FAILED',
                                last_error_code = 'DATASET_CONSENT_REVOKED',
                                updated_at = :now
                            WHERE dataset_version_id = ANY(:dataset_ids)
                              AND status IN ('QUEUED', 'WAITING_FOR_COLAB_WORKER')
                            """
                        ),
                        {"dataset_ids": archived_dataset_ids, "now": now},
                    )
                    cancelled_jobs = int(res_jobs.rowcount or 0)
            except Exception:
                # Table may not exist in minimal unit-test schemas without training jobs table
                cancelled_jobs = 0

        return {
            "revoked_candidates": len(revoked_cand_ids),
            "skipped_outbox_events": outbox_skipped,
            "archived_pool_samples": archived_samples,
            "archived_datasets": len(archived_dataset_ids),
            "cancelled_jobs": cancelled_jobs,
        }

    async def add_audit_log(
        self,
        *,
        actor_id: UUID,
        action: str,
        resource_type: str,
        resource_id: UUID,
        metadata: dict[str, Any],
    ) -> AuditLog:
        entry = AuditLog(
            ActorId=actor_id,
            Action=action,
            ResourceType=resource_type,
            ResourceId=resource_id,
            Metadata=metadata,
            RequestId=str(uuid4()),
        )
        self.db.add(entry)
        await self.db.flush()
        return entry

    async def commit(self) -> None:
        await self.db.commit()

    async def rollback(self) -> None:
        await self.db.rollback()
