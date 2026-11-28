"""Privacy-safe Admin OCR Hard-Sample Radar correlating low OCR confidence with reading friction (#6b).

Strictly enforces:
- Admin-only role check (`403` for non-admin actors).
- Public catalog books (`Book.VisibilityScope == "CATALOG"`) OR actively consented private books
  (`Book.VisibilityScope == "PARENT_PRIVATE"`, `Book.ModerationStatus == "ACTIVE"`,
  `ParentBookOcrContributionConsent.Status == "OPTED_IN"`, `RightsConfirmed == True`,
  `RevokedAt IS NULL`, `Purpose == "FLOW2_ADMIN_VERIFIED_OCR"`, and clear training rights basis).
- Strict Vietnamese PII filtering (`detect_vietnamese_pii_strict`) on word, line, and private title.
- Zero parent/child identifiers or PII in SQL projections and response DTOs.
"""
from __future__ import annotations

from collections import defaultdict
from datetime import datetime, timezone
from typing import Any
from uuid import UUID

from fastapi import HTTPException
from sqlalchemy import and_, desc, func, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models import (
    Book,
    BookPage,
    PageRevision,
    PageRevisionWord,
    ParentBookOcrContributionConsent,
    Profile,
    ReadingEvent,
)
from app.models.reading_comparison_report import ReadingComparisonReport
from app.schemas.book_content_quality import (
    AdminOcrHardSampleItemRead,
    AdminOcrHardSampleRadarResponse,
)
from app.services.viread_flow2_hygiene import detect_vietnamese_pii_strict

ALLOWED_TRAINING_RIGHTS: frozenset[str] = frozenset(
    {"SELF_AUTHORED", "PUBLIC_DOMAIN", "LICENSED_OR_PERMISSION"}
)


def _parse_source_rights_tag(source_declaration: str | None) -> str:
    cleaned = (source_declaration or "").strip()
    if cleaned.startswith("[") and "]" in cleaned:
        tag = cleaned[1:].split("]", 1)[0].strip()
        if tag:
            return tag
    return "OWNED_PHYSICAL_BOOK"


def _eligible_radar_book_clause():
    """SQL predicate allowing only active CATALOG books or strictly OPTED_IN private books."""
    return and_(
        Book.IsDeleted.is_(False),
        Book.LifecycleStatus == "ACTIVE",
        BookPage.LifecycleStatus == "ACTIVE",
        BookPage.CurrentVerifiedRevisionId == PageRevision.Id,
        or_(
            Book.VisibilityScope == "CATALOG",
            and_(
                Book.VisibilityScope == "PARENT_PRIVATE",
                Book.ModerationStatus == "ACTIVE",
                Book.SuspendedAt.is_(None),
                ParentBookOcrContributionConsent.Status == "OPTED_IN",
                ParentBookOcrContributionConsent.RightsConfirmed.is_(True),
                ParentBookOcrContributionConsent.RevokedAt.is_(None),
                ParentBookOcrContributionConsent.Purpose == "FLOW2_ADMIN_VERIFIED_OCR",
            ),
        ),
    )


class OcrHardSampleRadarService:
    def __init__(self, db: AsyncSession) -> None:
        self.db = db

    async def _require_admin(self, actor_id: UUID) -> None:
        role = await self.db.scalar(
            select(Profile.Role).where(Profile.Id == actor_id, Profile.Active == 1)
        )
        normalized = role.strip().casefold() if isinstance(role, str) else ""
        if normalized != "admin":
            raise HTTPException(status_code=403, detail="Access denied")

    async def get_hard_sample_radar(
        self,
        actor_id: UUID,
        *,
        limit: int = 30,
        max_ocr_confidence: float = 0.88,
    ) -> AdminOcrHardSampleRadarResponse:
        await self._require_admin(actor_id)
        safe_limit = max(1, min(100, int(limit)))
        safe_max_conf = max(0.1, min(1.0, float(max_ocr_confidence)))

        eligible_clause = _eligible_radar_book_clause()

        # 1. Aggregate WORD_RETRY FAILED/UNCERTAIN counts per PageRevisionWord.Id
        retry_rows = (
            await self.db.execute(
                select(
                    ReadingEvent.WordId,
                    func.count(ReadingEvent.Id).label("retry_count"),
                    func.count(func.distinct(ReadingEvent.SessionId)).label("sess_count"),
                )
                .join(PageRevisionWord, PageRevisionWord.Id == ReadingEvent.WordId)
                .join(PageRevision, PageRevision.Id == PageRevisionWord.PageRevisionId)
                .join(BookPage, BookPage.Id == PageRevision.PageId)
                .join(Book, Book.Id == BookPage.BookId)
                .outerjoin(
                    ParentBookOcrContributionConsent,
                    ParentBookOcrContributionConsent.BookId == Book.Id,
                )
                .where(
                    ReadingEvent.WordId.is_not(None),
                    ReadingEvent.Type == "WORD_RETRY",
                    ReadingEvent.Status.in_(("FAILED", "UNCERTAIN")),
                    eligible_clause,
                )
                .group_by(ReadingEvent.WordId)
                .order_by(desc("retry_count"))
                .limit(200)
            )
        ).all()

        retry_by_word_id: dict[UUID, int] = {}
        sessions_by_word_id: dict[UUID, int] = {}
        for w_id, r_count, s_count in retry_rows:
            if w_id is not None:
                retry_by_word_id[w_id] = int(r_count or 0)
                sessions_by_word_id[w_id] = int(s_count or 0)

        # 2. Sample recent ReadingComparisonReports on eligible revisions for alignment mismatches
        report_rows = (
            await self.db.execute(
                select(
                    ReadingComparisonReport.PageRevisionId,
                    ReadingComparisonReport.SessionId,
                    ReadingComparisonReport.Alignment,
                    ReadingComparisonReport.Summary,
                )
                .join(
                    PageRevision,
                    PageRevision.Id == ReadingComparisonReport.PageRevisionId,
                )
                .join(BookPage, BookPage.Id == PageRevision.PageId)
                .join(Book, Book.Id == BookPage.BookId)
                .outerjoin(
                    ParentBookOcrContributionConsent,
                    ParentBookOcrContributionConsent.BookId == Book.Id,
                )
                .where(eligible_clause)
                .order_by(desc(ReadingComparisonReport.CreatedAt))
                .limit(250)
            )
        ).all()

        mismatch_by_rev_word_idx: dict[tuple[UUID, int], int] = defaultdict(int)
        mismatch_by_word_id: dict[UUID, int] = defaultdict(int)
        report_sessions_by_rev_idx: dict[tuple[UUID, int], set[UUID]] = defaultdict(set)

        for rev_id, sess_id, alignment, summary in report_rows:
            if isinstance(alignment, list):
                for entry in alignment:
                    if not isinstance(entry, dict):
                        continue
                    st = str(entry.get("status") or "").upper()
                    b_idx = entry.get("book_index")
                    if (
                        st in {"SUBSTITUTE", "DELETE", "MISPRONUNCIATION", "UNCERTAIN"}
                        and isinstance(b_idx, int)
                        and not isinstance(b_idx, bool)
                        and b_idx >= 0
                    ):
                        mismatch_by_rev_word_idx[(rev_id, b_idx)] += 1
                        if sess_id is not None:
                            report_sessions_by_rev_idx[(rev_id, b_idx)].add(sess_id)
            if isinstance(summary, dict):
                init_assess = summary.get("initial_assessment")
                if isinstance(init_assess, list):
                    for item in init_assess:
                        if not isinstance(item, dict):
                            continue
                        ist = str(item.get("status") or "").upper()
                        if ist in {"MISPRONUNCIATION", "UNCERTAIN", "OMISSION"}:
                            raw_wid = item.get("word_id")
                            try:
                                wid = UUID(str(raw_wid))
                            except (TypeError, ValueError):
                                wid = None
                            if wid is not None:
                                mismatch_by_word_id[wid] += 1

        # 3. Load candidate low-confidence / high-friction words from eligible books
        flagged_word_ids = set(retry_by_word_id.keys()) | set(mismatch_by_word_id.keys())
        flagged_rev_ids = {rev_id for rev_id, _ in mismatch_by_rev_word_idx.keys()}

        word_filter_clauses = [
            and_(
                PageRevisionWord.OCRConfidence.is_not(None),
                PageRevisionWord.OCRConfidence <= safe_max_conf,
            )
        ]
        if flagged_word_ids:
            word_filter_clauses.append(PageRevisionWord.Id.in_(list(flagged_word_ids)[:250]))
        if flagged_rev_ids:
            word_filter_clauses.append(
                PageRevisionWord.PageRevisionId.in_(list(flagged_rev_ids)[:120])
            )

        candidate_rows = (
            await self.db.execute(
                select(
                    PageRevisionWord,
                    PageRevision.Id,
                    BookPage.Id,
                    BookPage.PageNumber,
                    Book.Id,
                    Book.Title,
                    Book.Name,
                    Book.VisibilityScope,
                    Book.SourceDeclaration,
                )
                .join(PageRevision, PageRevision.Id == PageRevisionWord.PageRevisionId)
                .join(BookPage, BookPage.Id == PageRevision.PageId)
                .join(Book, Book.Id == BookPage.BookId)
                .outerjoin(
                    ParentBookOcrContributionConsent,
                    ParentBookOcrContributionConsent.BookId == Book.Id,
                )
                .where(
                    eligible_clause,
                    or_(*word_filter_clauses),
                )
                .limit(400)
            )
        ).all()

        if not candidate_rows:
            return AdminOcrHardSampleRadarResponse(
                generated_at=datetime.now(timezone.utc),
                total_candidates=0,
                catalog_count=0,
                consented_private_count=0,
                items=[],
            )

        # Batch-load surrounding line context for matched revisions/lines
        line_keys = {
            (rev_id, int(word_orm.LineIndex or 0))
            for word_orm, rev_id, *_ in candidate_rows
        }
        target_rev_ids = list({rev_id for rev_id, _ in line_keys})
        line_words_map: dict[tuple[UUID, int], list[str]] = defaultdict(list)
        if target_rev_ids:
            sibling_rows = (
                await self.db.execute(
                    select(
                        PageRevisionWord.PageRevisionId,
                        PageRevisionWord.LineIndex,
                        PageRevisionWord.Text,
                    )
                    .where(PageRevisionWord.PageRevisionId.in_(target_rev_ids))
                    .order_by(
                        PageRevisionWord.PageRevisionId,
                        PageRevisionWord.LineIndex,
                        PageRevisionWord.WordIndex,
                    )
                )
            ).all()
            for s_rev_id, s_line_idx, s_text in sibling_rows:
                key = (s_rev_id, int(s_line_idx or 0))
                if key in line_keys and str(s_text or "").strip():
                    line_words_map[key].append(str(s_text).strip())

        scored_items: list[AdminOcrHardSampleItemRead] = []
        seen_word_ids: set[UUID] = set()

        for (
            word_orm,
            rev_id,
            page_id,
            page_num,
            book_id,
            book_title_raw,
            book_name_raw,
            vis_scope_raw,
            source_decl,
        ) in candidate_rows:
            if word_orm.Id in seen_word_ids:
                continue
            seen_word_ids.add(word_orm.Id)

            vis_scope = (
                "PARENT_PRIVATE"
                if str(vis_scope_raw or "").upper() == "PARENT_PRIVATE"
                else "CATALOG"
            )
            if vis_scope == "PARENT_PRIVATE":
                rights_tag = _parse_source_rights_tag(source_decl)
                if rights_tag not in ALLOWED_TRAINING_RIGHTS:
                    continue
            else:
                rights_tag = "CATALOG_VERIFIED"

            word_text = str(word_orm.Text or "").strip()
            if not word_text:
                continue
            line_idx = max(0, int(word_orm.LineIndex or 0))
            line_tokens = line_words_map.get((rev_id, line_idx)) or [word_text]
            line_text = " ".join(line_tokens).strip()[:260]

            # Strict PII exclusion on word and line text
            if detect_vietnamese_pii_strict(word_text, mode="strict") or detect_vietnamese_pii_strict(
                line_text, mode="strict"
            ):
                continue
            lowered_line = line_text.casefold()
            if "email" in lowered_line or "child" in lowered_line:
                continue

            raw_conf = word_orm.OCRConfidence
            ocr_conf = (
                round(max(0.0, min(1.0, float(raw_conf))), 4)
                if raw_conf is not None
                else None
            )
            w_idx = max(0, int(word_orm.WordIndex or 0))
            retry_cnt = retry_by_word_id.get(word_orm.Id, 0)
            mismatch_cnt = max(
                mismatch_by_rev_word_idx.get((rev_id, w_idx), 0),
                mismatch_by_word_id.get(word_orm.Id, 0),
            )
            distinct_sessions = max(
                sessions_by_word_id.get(word_orm.Id, 0),
                len(report_sessions_by_rev_idx.get((rev_id, w_idx), set())),
            )

            is_low_conf = ocr_conf is not None and ocr_conf <= safe_max_conf
            has_friction = (retry_cnt + mismatch_cnt) > 0
            if not is_low_conf and not has_friction:
                continue

            conf_uncertainty = (1.0 - ocr_conf) if ocr_conf is not None else 0.28
            score = min(
                100.0,
                round(
                    conf_uncertainty * 55.0
                    + min(retry_cnt, 8) * 6.0
                    + min(mismatch_cnt, 8) * 4.5
                    + min(distinct_sessions, 5) * 3.0,
                    1,
                ),
            )
            if score < 8.0:
                continue

            raw_display_title = str(book_title_raw or book_name_raw or "Sách ViRead").strip()
            if vis_scope == "PARENT_PRIVATE":
                if (
                    detect_vietnamese_pii_strict(raw_display_title, mode="strict")
                    or "email" in raw_display_title.casefold()
                    or "child" in raw_display_title.casefold()
                ):
                    safe_title = "Sách gia đình đã đồng thuận Flow 2"
                else:
                    safe_title = raw_display_title[:160]
                action = "PRIORITIZE_FLOW2_CROP_REVIEW"
            else:
                safe_title = (
                    "Sách thư viện ViRead"
                    if ("email" in raw_display_title.casefold() or "child" in raw_display_title.casefold())
                    else raw_display_title[:160]
                )
                action = (
                    "INSPECT_CATALOG_PAGE_OCR"
                    if is_low_conf and has_friction
                    else "MONITOR_PHONICS_VS_OCR"
                )

            scored_items.append(
                AdminOcrHardSampleItemRead(
                    book_id=book_id,
                    book_title=safe_title,
                    visibility_scope=vis_scope,
                    training_rights_basis=rights_tag,
                    page_id=page_id,
                    page_number=max(1, int(page_num or 1)),
                    page_revision_id=rev_id,
                    line_index=line_idx,
                    word_id=word_orm.Id,
                    word_index=w_idx,
                    word_text=word_text[:80],
                    line_text=line_text,
                    ocr_confidence=ocr_conf,
                    retry_fail_count=retry_cnt,
                    comparison_mismatch_count=mismatch_cnt,
                    distinct_session_count=distinct_sessions,
                    hard_sample_score=score,
                    recommended_action=action,
                )
            )

        scored_items.sort(
            key=lambda item: (
                item.hard_sample_score,
                item.retry_fail_count + item.comparison_mismatch_count,
                -(item.ocr_confidence if item.ocr_confidence is not None else 0.5),
            ),
            reverse=True,
        )
        top_items = scored_items[:safe_limit]
        catalog_cnt = sum(1 for i in top_items if i.visibility_scope == "CATALOG")
        private_cnt = sum(1 for i in top_items if i.visibility_scope == "PARENT_PRIVATE")

        return AdminOcrHardSampleRadarResponse(
            generated_at=datetime.now(timezone.utc),
            total_candidates=len(scored_items),
            catalog_count=catalog_cnt,
            consented_private_count=private_cnt,
            items=top_items,
        )
