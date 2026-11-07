from __future__ import annotations

import asyncio
import hashlib
import logging
import os
from datetime import datetime, timezone
from uuid import UUID, uuid4

from sqlalchemy import update

from app.database.session import AsyncSessionLocal, engine
from app.diagnostic_logging import log_diagnostic
from app.models.book_content_quality import (
    BookQualityFinding,
    BookQualityPageScan,
    BookQualityScanRun,
)
from app.repositories.book_content_quality_repository import BookContentQualityRepository
from app.services.admin_ocr_local import LocalCorrectionError
from app.services.book_quality_analyzer import (
    analyse_verified_text,
    content_fingerprint,
    duplicate_page_finding,
    page_gap_finding,
)
from app.services.book_quality_ollama import analyse_with_ollama

logger = logging.getLogger(__name__)


def _poll_seconds() -> int:
    try:
        value = int(os.getenv("BOOK_QUALITY_SCAN_POLL_SECONDS", "5"))
    except ValueError:
        return 5
    return max(2, min(60, value))


POLL_SECONDS = _poll_seconds()
MAX_PAGE_ATTEMPTS = 3
LEASE_SECONDS = 1800
HEARTBEAT_SECONDS = 30


class WorkerLeaseLost(RuntimeError):
    pass


def _revision_snapshot_hash(revision) -> str:
    return revision.ContentHash or hashlib.sha256(
        (revision.VerifiedText or "").encode("utf-8")
    ).hexdigest()


async def _heartbeat(scan_id: UUID, worker_id: str, stop: asyncio.Event) -> None:
    while not stop.is_set():
        try:
            await asyncio.wait_for(stop.wait(), timeout=HEARTBEAT_SECONDS)
            return
        except TimeoutError:
            pass
        try:
            async with AsyncSessionLocal() as session:
                alive = await BookContentQualityRepository(session).renew_scan_lease(
                    scan_id, worker_id, lease_seconds=LEASE_SECONDS
                )
        except Exception:
            logger.exception("Book quality worker heartbeat failed")
            stop.set()
            return
        if not alive:
            stop.set()
            return


def _finding_row(
    *,
    page_scan: BookQualityPageScan,
    book_id: UUID | None,
    page_id: UUID | None,
    revision_id: UUID | None,
    issue_type: str,
    severity: str,
    excerpt: str,
    excerpt_start: int,
    excerpt_end: int,
    explanation: str,
    source: str = "RULE",
    suggestion: str | None = None,
    confidence: float | None = None,
    model_name: str | None = None,
) -> BookQualityFinding:
    return BookQualityFinding(
        Id=uuid4(),
        PageScanId=page_scan.Id,
        BookId=book_id,
        PageId=page_id,
        PageRevisionId=revision_id,
        IssueType=issue_type,
        Severity=severity,
        OriginalExcerpt=excerpt,
        ExcerptStart=excerpt_start,
        ExcerptEnd=excerpt_end,
        SuggestedCorrection=suggestion,
        Explanation=explanation[:2000],
        DetectionSource=source,
        Confidence=confidence,
        ModelName=model_name,
        Status="NEEDS_REVIEW",
    )


async def _process_page_scan(page_scan_id: UUID) -> None:
    text_snapshot: str | None = None
    page_number = 0
    book_id: UUID | None = None
    page_id: UUID | None = None
    revision_id: UUID | None = None
    expected_content_hash: str | None = None
    should_run_ai = False

    async with AsyncSessionLocal() as session:
        repo = BookContentQualityRepository(session)
        context = await repo.scan_page_context(page_scan_id)
        if context is None:
            return
        page_scan, page, revision = context
        if page_scan.Status in ("COMPLETED", "NOT_SCANNABLE", "STALE"):
            return
        if page_scan.Status == "FAILED" and int(page_scan.AttemptCount or 0) >= MAX_PAGE_ATTEMPTS:
            return

        page_scan.AttemptCount = int(page_scan.AttemptCount or 0) + 1
        page_scan.StartedAt = page_scan.StartedAt or datetime.now(timezone.utc)
        page_scan.Status = "RUNNING"
        page_scan.ErrorCode = None
        page_scan.ErrorSummary = None

        if page is None:
            page_scan.Status = "NOT_SCANNABLE"
            page_scan.RuleCheckStatus = "SKIPPED"
            page_scan.AIAnalysisStatus = "SKIPPED"
            page_scan.ErrorCode = "PAGE_NO_LONGER_EXISTS"
            page_scan.ErrorSummary = "Trang không còn tồn tại; snapshot của lần quét vẫn được giữ."
            page_scan.CompletedAt = datetime.now(timezone.utc)
            await session.commit()
            return

        if page.LifecycleStatus != "ACTIVE":
            page_scan.Status = "NOT_SCANNABLE"
            page_scan.RuleCheckStatus = "SKIPPED"
            page_scan.AIAnalysisStatus = "SKIPPED"
            page_scan.ErrorCode = "PAGE_NOT_ACTIVE"
            page_scan.ErrorSummary = "Trang đã ngừng hoạt động hoặc đang xử lý."
            page_scan.CompletedAt = datetime.now(timezone.utc)
            await session.commit()
            return

        if (
            page_scan.PageRevisionId is None
            or page_scan.ContentHash is None
            or page_scan.VerifiedTextSnapshot is None
        ):
            page_scan.Status = "NOT_SCANNABLE"
            page_scan.RuleCheckStatus = "SKIPPED"
            page_scan.AIAnalysisStatus = "SKIPPED"
            page_scan.ErrorCode = "NO_VERIFIED_REVISION_AT_SNAPSHOT"
            page_scan.ErrorSummary = "Trang chưa có snapshot revision VERIFIED hợp lệ tại thời điểm tạo scan."
            page_scan.CompletedAt = datetime.now(timezone.utc)
            await session.commit()
            return

        if page.CurrentVerifiedRevisionId != page_scan.PageRevisionId:
            page_scan.Status = "STALE"
            page_scan.RuleCheckStatus = "SKIPPED"
            page_scan.AIAnalysisStatus = "SKIPPED"
            page_scan.ErrorCode = "CURRENT_REVISION_CHANGED"
            page_scan.ErrorSummary = "Revision hiện hành đã thay đổi trước khi scan; cần tạo scan mới."
            page_scan.CompletedAt = datetime.now(timezone.utc)
            await session.commit()
            return

        if (
            revision is None
            or revision.PageId != page.Id
            or revision.Id != page.CurrentVerifiedRevisionId
            or revision.VerificationStatus != "VERIFIED"
            or _revision_snapshot_hash(revision) != page_scan.ContentHash
        ):
            page_scan.Status = "STALE"
            page_scan.RuleCheckStatus = "SKIPPED"
            page_scan.AIAnalysisStatus = "SKIPPED"
            page_scan.ErrorCode = "REVISION_SNAPSHOT_MISMATCH"
            page_scan.ErrorSummary = "Revision hoặc content hash không còn trùng snapshot scan."
            page_scan.CompletedAt = datetime.now(timezone.utc)
            await session.commit()
            return

        # Mark unresolved findings from older verified revisions as stale before
        # analyzing the current revision. Their evidence remains immutable.
        await session.execute(
            update(BookQualityFinding)
            .where(
                BookQualityFinding.PageId == page.Id,
                BookQualityFinding.PageRevisionId != page_scan.PageRevisionId,
                BookQualityFinding.Status.in_(("NEEDS_REVIEW", "CONFIRMED")),
            )
            .values(
                Status="STALE",
                ReviewNote="Current verified revision changed; inspect the new scan.",
                ReviewedAt=datetime.now(timezone.utc),
            )
        )

        # Analyze the immutable text captured when the scan enumerated the book.
        text_snapshot = page_scan.VerifiedTextSnapshot
        page_number = page_scan.PageNumberSnapshot
        book_id = page_scan.BookId
        page_id = page.Id
        revision_id = page_scan.PageRevisionId
        expected_content_hash = page_scan.ContentHash

        if page_scan.RuleCheckStatus != "COMPLETED":
            deterministic = analyse_verified_text(text_snapshot)
            rule_rows = [
                _finding_row(
                    page_scan=page_scan,
                    book_id=book_id,
                    page_id=page_id,
                    revision_id=revision_id,
                    issue_type=item.issue_type,
                    severity=item.severity,
                    excerpt=item.original_excerpt,
                    excerpt_start=item.excerpt_start,
                    excerpt_end=item.excerpt_end,
                    explanation=item.explanation,
                )
                for item in deterministic
            ]
            inserted_ids = await repo.create_findings(rule_rows)
            page_scan.RuleCheckStatus = "COMPLETED"
            await repo.link_findings_to_reports(
                book_id=book_id,
                page_id=page_id,
                finding_ids=inserted_ids,
            )

        if not text_snapshot.strip():
            page_scan.AIAnalysisStatus = "SKIPPED"
            page_scan.Status = "COMPLETED"
            page_scan.CompletedAt = datetime.now(timezone.utc)
            await session.commit()
            return

        should_run_ai = page_scan.AIAnalysisStatus in ("PENDING", "FAILED")
        if not should_run_ai:
            page_scan.Status = "COMPLETED"
            page_scan.CompletedAt = datetime.now(timezone.utc)
        await session.commit()

    if (
        not should_run_ai
        or text_snapshot is None
        or book_id is None
        or page_id is None
        or revision_id is None
        or expected_content_hash is None
    ):
        return

    ai_findings = []
    ai_rejected_count = 0
    ai_result = None
    ai_error: LocalCorrectionError | None = None
    try:
        ai_result = await analyse_with_ollama(text_snapshot, page_number)
        ai_rejected_count = ai_result.rejected_excerpt_count
        for item in ai_result.findings:
            if (
                item.excerpt_start < 0
                or item.excerpt_end > len(text_snapshot)
                or text_snapshot[item.excerpt_start:item.excerpt_end] != item.excerpt
            ):
                ai_rejected_count += 1
                continue
            ai_findings.append(item)
    except LocalCorrectionError as error:
        ai_error = error
    except Exception:
        logger.exception("Book quality Ollama analysis failed")
        ai_error = LocalCorrectionError(503, "Ollama content inspection is unavailable.")

    async with AsyncSessionLocal() as session:
        repo = BookContentQualityRepository(session)
        context = await repo.scan_page_context(page_scan_id)
        if context is None:
            return
        page_scan, page, revision = context
        if (
            page is None
            or revision is None
            or page.CurrentVerifiedRevisionId != revision_id
            or revision.Id != revision_id
            or revision.PageId != page.Id
            or revision.VerificationStatus != "VERIFIED"
            or _revision_snapshot_hash(revision) != expected_content_hash
            or page_scan.ContentHash != expected_content_hash
        ):
            page_scan.Status = "STALE"
            page_scan.AIAnalysisStatus = "SKIPPED"
            page_scan.ErrorCode = "REVISION_CHANGED_DURING_SCAN"
            page_scan.ErrorSummary = "Revision đã thay đổi trong khi AI phân tích; findings cũ được đánh dấu STALE."
            page_scan.CompletedAt = datetime.now(timezone.utc)
            await session.execute(
                update(BookQualityFinding)
                .where(
                    BookQualityFinding.PageScanId == page_scan.Id,
                    BookQualityFinding.Status.in_(("NEEDS_REVIEW", "CONFIRMED")),
                )
                .values(
                    Status="STALE",
                    ReviewNote="Current verified revision changed during inspection.",
                    ReviewedAt=datetime.now(timezone.utc),
                )
            )
            await session.commit()
            return

        if ai_error is not None:
            page_scan.AIAnalysisStatus = (
                "UNAVAILABLE" if ai_error.status_code == 503 else "FAILED"
            )
            page_scan.ErrorCode = (
                "OLLAMA_UNAVAILABLE"
                if ai_error.status_code == 503
                else "OLLAMA_INVALID_RESPONSE"
            )
            page_scan.ErrorSummary = ai_error.detail[:1000]
        else:
            ai_rows = [
                _finding_row(
                    page_scan=page_scan,
                    book_id=book_id,
                    page_id=page_id,
                    revision_id=revision_id,
                    issue_type=item.issue_type,
                    severity=item.severity,
                    excerpt=item.excerpt,
                    excerpt_start=item.excerpt_start,
                    excerpt_end=item.excerpt_end,
                    explanation=item.explanation,
                    source="OLLAMA_TEXT",
                    suggestion=item.suggested_correction,
                    confidence=item.confidence,
                    model_name=item.model_name,
                )
                for item in ai_findings
            ]
            inserted_ids = await repo.create_findings(ai_rows)
            page_scan.RejectedAIFindingCount = ai_rejected_count
            page_scan.AIAnalysisStatus = "COMPLETED"
            await repo.link_findings_to_reports(
                book_id=book_id,
                page_id=page_id,
                finding_ids=inserted_ids,
            )
        page_scan.Status = "COMPLETED"
        page_scan.CompletedAt = datetime.now(timezone.utc)
        await session.commit()


async def _add_cross_page_findings(scan_id: UUID) -> None:
    async with AsyncSessionLocal() as session:
        repo = BookContentQualityRepository(session)
        run = await repo.scan_run(scan_id)
        pages = await repo.page_scans(scan_id)
        if run is not None and run.Scope == "PAGE":
            return

        # Duplicate-content checks require verified text. Exact duplicates are only
        # LOW-severity signals because intentional repeated pages are possible.
        previous_by_hash: dict[str, BookQualityPageScan] = {}
        verified_active_pages = [
            row
            for row in pages
            if row.Status == "COMPLETED"
            and row.PageLifecycleSnapshot == "ACTIVE"
            and isinstance(row.VerifiedTextSnapshot, str)
            and row.VerifiedTextSnapshot.strip()
        ]
        verified_active_pages.sort(
            key=lambda row: (row.PageNumberSnapshot, str(row.Id))
        )
        for row in verified_active_pages:
            fingerprint = content_fingerprint(row.VerifiedTextSnapshot or "")
            other = previous_by_hash.get(fingerprint)
            if other is not None and row.PageId is not None:
                item = duplicate_page_finding(
                    row.VerifiedTextSnapshot or "",
                    row.PageNumberSnapshot,
                    other.PageNumberSnapshot,
                )
                row_values = [
                    _finding_row(
                        page_scan=row,
                        book_id=row.BookId,
                        page_id=row.PageId,
                        revision_id=row.PageRevisionId,
                        issue_type=item.issue_type,
                        severity=item.severity,
                        excerpt=item.original_excerpt,
                        excerpt_start=item.excerpt_start,
                        excerpt_end=item.excerpt_end,
                        explanation=item.explanation,
                    )
                ]
                inserted_ids = await repo.create_findings(row_values)
                if row.BookId is not None:
                    await repo.link_findings_to_reports(
                        book_id=row.BookId,
                        page_id=row.PageId,
                        finding_ids=inserted_ids,
                    )
            else:
                previous_by_hash[fingerprint] = row

        # Detect page-number gaps from all ACTIVE page records, including those
        # without a VERIFIED revision. A non-verified page is not counted as inspected.
        active_page_rows = [
            row for row in pages if row.PageLifecycleSnapshot == "ACTIVE"
        ]
        active_page_rows.sort(
            key=lambda row: (row.PageNumberSnapshot, str(row.Id))
        )
        unique_numbers: dict[int, BookQualityPageScan] = {}
        for row in active_page_rows:
            unique_numbers.setdefault(row.PageNumberSnapshot, row)
        numbers = sorted(unique_numbers.items())
        for index in range(1, len(numbers)):
            previous_number, _ = numbers[index - 1]
            current_number, current_row = numbers[index]
            if current_number - previous_number <= 1 or current_row.PageId is None:
                continue
            gap = page_gap_finding(current_number, previous_number)
            finding = _finding_row(
                page_scan=current_row,
                book_id=current_row.BookId,
                page_id=current_row.PageId,
                revision_id=current_row.PageRevisionId,
                issue_type=gap.issue_type,
                severity=gap.severity,
                excerpt=gap.original_excerpt,
                excerpt_start=gap.excerpt_start,
                excerpt_end=gap.excerpt_end,
                explanation=gap.explanation,
            )
            inserted_ids = await repo.create_findings([finding])
            if current_row.BookId is not None:
                await repo.link_findings_to_reports(
                    book_id=current_row.BookId,
                    page_id=current_row.PageId,
                    finding_ids=inserted_ids,
                )
        await session.commit()


async def _update_scan_progress(scan_id: UUID, worker_id: str) -> None:
    async with AsyncSessionLocal() as session:
        repo = BookContentQualityRepository(session)
        run = await repo.scan_run(scan_id, lock=True)
        if run is None or run.WorkerId != worker_id:
            return
        pages = await repo.page_scans(scan_id)
        run.CompletedPages = sum(row.Status == "COMPLETED" for row in pages)
        run.SkippedPages = sum(row.Status == "NOT_SCANNABLE" for row in pages)
        run.FailedPages = sum(row.Status in ("FAILED", "STALE") for row in pages)
        run.AICompletedPages = sum(
            row.AIAnalysisStatus == "COMPLETED" for row in pages
        )
        run.AIUnavailablePages = sum(
            row.AIAnalysisStatus in ("UNAVAILABLE", "FAILED") for row in pages
        )
        await session.commit()


async def _finalize_scan(scan_id: UUID, worker_id: str) -> None:
    async with AsyncSessionLocal() as session:
        repo = BookContentQualityRepository(session)
        run = await repo.scan_run(scan_id, lock=True)
        if run is None or run.WorkerId != worker_id:
            return
        pages = await repo.page_scans(scan_id)
        completed = sum(row.Status == "COMPLETED" for row in pages)
        skipped = sum(row.Status == "NOT_SCANNABLE" for row in pages)
        failed = sum(row.Status in ("FAILED", "STALE") for row in pages)
        ai_completed = sum(row.AIAnalysisStatus == "COMPLETED" for row in pages)
        ai_unavailable = sum(
            row.AIAnalysisStatus in ("UNAVAILABLE", "FAILED") for row in pages
        )
        run.CompletedPages = completed
        run.SkippedPages = skipped
        run.FailedPages = failed
        run.AICompletedPages = ai_completed
        run.AIUnavailablePages = ai_unavailable
        if failed and completed == 0:
            run.Status = "FAILED"
        elif failed or skipped or ai_unavailable or not pages:
            run.Status = "PARTIAL"
        else:
            run.Status = "COMPLETED"
        run.CompletedAt = datetime.now(timezone.utc)
        run.LeaseExpiresAt = None
        run.WorkerId = None
        await session.commit()


async def _process_claimed_scan(scan_id: UUID, worker_id: str) -> None:
    stop_heartbeat = asyncio.Event()
    heartbeat_task = asyncio.create_task(
        _heartbeat(scan_id, worker_id, stop_heartbeat)
    )
    try:
        async with AsyncSessionLocal() as session:
            repo = BookContentQualityRepository(session)
            run = await repo.scan_run(scan_id)
            if run is None:
                return
            if run.BookId is None:
                await _mark_scan_unavailable(
                    scan_id, "Sách đã bị xóa trước khi scan bắt đầu."
                )
                return
            page_scans = await repo.create_book_page_snapshots(run)
            run.TotalPages = len(page_scans)
            if run.Scope == "PAGE" and not page_scans:
                run.ErrorSummary = (
                    "Trang đích không còn tồn tại; không có page snapshot để kiểm tra."
                )
            await session.commit()

        for page_scan in page_scans:
            if stop_heartbeat.is_set():
                raise WorkerLeaseLost("Book quality scan lease was lost")
            for _ in range(MAX_PAGE_ATTEMPTS):
                try:
                    await _process_page_scan(page_scan.Id)
                    break
                except Exception:
                    logger.exception("Book quality page scan attempt failed")
                    async with AsyncSessionLocal() as session:
                        current = await BookContentQualityRepository(
                            session
                        ).scan_page_context(page_scan.Id)
                        if current is None:
                            break
                        current_scan = current[0]
                        current_scan.Status = "FAILED"
                        current_scan.ErrorCode = "PAGE_SCAN_FAILED"
                        current_scan.ErrorSummary = (
                            "Không thể hoàn tất kiểm tra trang; worker sẽ thử lại."
                        )
                        current_scan.CompletedAt = datetime.now(timezone.utc)
                        attempt_count = int(current_scan.AttemptCount or 0)
                        await session.commit()
                    if attempt_count >= MAX_PAGE_ATTEMPTS:
                        break
            await _update_scan_progress(scan_id, worker_id)

        if stop_heartbeat.is_set():
            raise WorkerLeaseLost("Book quality scan lease was lost")
        await _add_cross_page_findings(scan_id)
        if stop_heartbeat.is_set():
            raise WorkerLeaseLost("Book quality scan lease was lost")
        await _finalize_scan(scan_id, worker_id)
    except asyncio.CancelledError:
        # A normal process shutdown should return the durable run to QUEUED.
        # Any page left RUNNING is safely resumed by its per-page state.
        async with AsyncSessionLocal() as session:
            run = await BookContentQualityRepository(session).scan_run(
                scan_id, lock=True
            )
            if run is not None and run.WorkerId == worker_id:
                run.Status = "QUEUED"
                run.WorkerId = None
                run.LeaseExpiresAt = None
                run.ErrorSummary = "Worker được dừng khi ứng dụng shutdown; scan sẽ được tiếp tục."
                await session.commit()
        raise
    except WorkerLeaseLost:
        logger.warning("Book quality scan worker lost its database lease")
        return
    except Exception:
        logger.exception("Book quality scan failed")
        async with AsyncSessionLocal() as session:
            run = await BookContentQualityRepository(session).scan_run(
                scan_id, lock=True
            )
            if run is not None and run.WorkerId == worker_id:
                run.Status = "PARTIAL"
                run.ErrorSummary = (
                    "Scan gặp lỗi nội bộ; các page scan đã lưu được giữ lại."
                )
                run.LeaseExpiresAt = None
                run.WorkerId = None
                run.CompletedAt = datetime.now(timezone.utc)
                await session.commit()
    finally:
        stop_heartbeat.set()
        heartbeat_task.cancel()
        await asyncio.gather(heartbeat_task, return_exceptions=True)


async def run_worker(stop_event: asyncio.Event | None = None) -> None:
    """Poll PostgreSQL queue; a RUNNING job with an expired lease can be reclaimed."""
    worker_id = f"book-quality-{uuid4()}"
    local_stop = stop_event or asyncio.Event()
    while not local_stop.is_set():
        run = None
        try:
            async with AsyncSessionLocal() as session:
                run = await BookContentQualityRepository(session).claim_next_scan(
                    worker_id, lease_seconds=LEASE_SECONDS
                )
        except Exception:
            log_diagnostic(
                logger,
                logging.ERROR,
                event="book_quality_queue_claim_failed",
                stage="book_quality_worker",
                include_traceback=True,
            )
        if run is not None:
            await _process_claimed_scan(run.Id, worker_id)
            continue
        try:
            await asyncio.wait_for(local_stop.wait(), timeout=POLL_SECONDS)
        except TimeoutError:
            pass


async def main() -> None:
    try:
        await run_worker()
    finally:
        await engine.dispose()


if __name__ == "__main__":
    asyncio.run(main())
