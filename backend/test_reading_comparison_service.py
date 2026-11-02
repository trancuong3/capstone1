"""Unit tests for page-scoped comparison report lifecycle."""

import os
import unittest
from datetime import datetime, timezone
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch
from uuid import UUID

os.environ["DATABASE_URL"] = "postgresql+asyncpg://test:test@127.0.0.1:1/test"
os.environ["SUPABASE_URL"] = "https://example.supabase.co"
os.environ["SUPABASE_KEY"] = "isolated-test-key"

from fastapi import HTTPException

from app.schemas.reading import CompareReadingRequest
from app.services import reading_comparison_service as comparison_module
from app.services.reading_comparison_service import ReadingComparisonService


SESSION_ID = UUID("10000000-0000-4000-8000-000000000001")
ACTOR_ID = UUID("20000000-0000-4000-8000-000000000001")
PAGE_ID = UUID("30000000-0000-4000-8000-000000000001")
REVISION_ID = UUID("40000000-0000-4000-8000-000000000001")
REPORT_ID = UUID("50000000-0000-4000-8000-000000000001")


def page_dto():
    return SimpleNamespace(
        page_id=PAGE_ID,
        page_revision_id=REVISION_ID,
        page_number=4,
        text="Con mèo đang ngủ.",
        words=[],
    )


def saved_report():
    return SimpleNamespace(
        Id=REPORT_ID,
        SessionId=SESSION_ID,
        PageId=PAGE_ID,
        PageRevisionId=REVISION_ID,
        Transcript="Con mèo đang ngủ.",
        Distance=0,
        Alignment=[{
            "book_word": "Con",
            "spoken_word": "Con",
            "book_index": 0,
            "spoken_index": 0,
            "status": "MATCH",
        }],
        Summary={
            "missing_words": [],
            "extra_words": [],
            "substitutions": [],
            "repeated_count": 0,
            "repeated_words": [],
            "hesitations": [],
            "hesitation_seconds": None,
        },
        CreatedAt=datetime(2026, 11, 2, tzinfo=timezone.utc),
    )


def service_with_mocks():
    service = ReadingComparisonService.__new__(ReadingComparisonService)
    service.content = SimpleNamespace(
        get_page=AsyncMock(return_value=page_dto()),
        get_session_page=AsyncMock(return_value=page_dto()),
        get_session_summary=AsyncMock(return_value=SimpleNamespace(id=SESSION_ID)),
    )
    service.repository = SimpleNamespace(
        find_exact=AsyncMock(return_value=None),
        create=AsyncMock(),
        list_for_session=AsyncMock(return_value=[]),
        get=AsyncMock(return_value=None),
        delete=AsyncMock(),
    )
    return service


class ReadingComparisonServiceTests(unittest.IsolatedAsyncioTestCase):
    async def test_compare_uses_exact_page_and_revision_and_persists_real_payload(self):
        service = service_with_mocks()
        saved = saved_report()

        async def persist(report):
            report.Id = saved.Id
            report.CreatedAt = saved.CreatedAt
            return report

        service.repository.create.side_effect = persist
        payload = CompareReadingRequest(
            transcript="  Con mèo đang ngủ.  ",
            page_id=PAGE_ID,
            page_revision_id=REVISION_ID,
        )

        with (
            patch.object(
                comparison_module,
                "align_text",
                return_value={"distance": 0, "alignment": saved.Alignment},
            ) as align,
            patch.object(
                comparison_module,
                "summarize_alignment",
                return_value=saved.Summary,
            ),
        ):
            result = await service.compare(SESSION_ID, ACTOR_ID, payload)

        service.content.get_page.assert_awaited_once_with(
            PAGE_ID, SESSION_ID, ACTOR_ID, revision_id=REVISION_ID
        )
        service.content.get_session_page.assert_not_awaited()
        align.assert_called_once_with("Con mèo đang ngủ.", "Con mèo đang ngủ.")
        service.repository.create.assert_awaited_once()
        created = service.repository.create.await_args.args[0]
        self.assertEqual(created.SessionId, SESSION_ID)
        self.assertEqual(created.PageId, PAGE_ID)
        self.assertEqual(created.PageRevisionId, REVISION_ID)
        self.assertEqual(created.Transcript, "Con mèo đang ngủ.")
        self.assertEqual(result.report_id, REPORT_ID)
        self.assertEqual(result.session_id, SESSION_ID)
        self.assertEqual(result.page_revision_id, REVISION_ID)

    async def test_identical_retry_returns_persisted_report_without_duplicate_insert(self):
        service = service_with_mocks()
        existing = saved_report()
        service.repository.find_exact.return_value = existing

        with (
            patch.object(
                comparison_module,
                "align_text",
                return_value={"distance": 0, "alignment": existing.Alignment},
            ),
            patch.object(
                comparison_module,
                "summarize_alignment",
                return_value=existing.Summary,
            ),
        ):
            result = await service.compare(
                SESSION_ID,
                ACTOR_ID,
                CompareReadingRequest(
                    transcript=existing.Transcript,
                    page_id=PAGE_ID,
                    page_revision_id=REVISION_ID,
                ),
            )

        self.assertEqual(result.report_id, REPORT_ID)
        service.repository.create.assert_not_awaited()
        service.repository.find_exact.assert_awaited_once_with(
            SESSION_ID, PAGE_ID, REVISION_ID, existing.Transcript
        )

    async def test_page_id_without_revision_is_rejected_before_page_lookup(self):
        service = service_with_mocks()

        with self.assertRaises(HTTPException) as caught:
            await service.compare(
                SESSION_ID,
                ACTOR_ID,
                CompareReadingRequest(transcript="Con mèo", page_id=PAGE_ID),
            )

        self.assertEqual(caught.exception.status_code, 422)
        service.content.get_page.assert_not_awaited()
        service.repository.create.assert_not_awaited()

    async def test_blank_transcript_is_rejected_without_creating_report(self):
        service = service_with_mocks()

        with self.assertRaises(HTTPException) as caught:
            await service.compare(
                SESSION_ID,
                ACTOR_ID,
                CompareReadingRequest(transcript=" "),
            )

        self.assertEqual(caught.exception.status_code, 422)
        service.content.get_session_page.assert_not_awaited()
        service.repository.create.assert_not_awaited()

    async def test_legacy_compare_without_page_reference_uses_current_page(self):
        service = service_with_mocks()
        existing = saved_report()
        service.repository.find_exact.return_value = existing

        with (
            patch.object(
                comparison_module,
                "align_text",
                return_value={"distance": 0, "alignment": existing.Alignment},
            ),
            patch.object(
                comparison_module,
                "summarize_alignment",
                return_value=existing.Summary,
            ),
        ):
            await service.compare(
                SESSION_ID,
                ACTOR_ID,
                CompareReadingRequest(transcript=existing.Transcript),
            )

        service.content.get_session_page.assert_awaited_once_with(
            SESSION_ID, ACTOR_ID
        )
        service.content.get_page.assert_not_awaited()

    async def test_list_checks_session_ownership_before_loading_reports(self):
        service = service_with_mocks()
        report = saved_report()
        service.repository.list_for_session.return_value = [report]

        result = await service.list_for_session(SESSION_ID, ACTOR_ID)

        service.content.get_session_summary.assert_awaited_once_with(
            SESSION_ID, ACTOR_ID
        )
        service.repository.list_for_session.assert_awaited_once_with(SESSION_ID)
        self.assertEqual(result.total, 1)
        self.assertEqual(result.reports[0].report_id, REPORT_ID)

    async def test_delete_checks_report_session_ownership_before_deletion(self):
        service = service_with_mocks()
        report = saved_report()
        service.repository.get.return_value = report

        result = await service.delete(REPORT_ID, ACTOR_ID)

        service.content.get_session_summary.assert_awaited_once_with(
            SESSION_ID, ACTOR_ID
        )
        service.repository.delete.assert_awaited_once_with(report)
        self.assertEqual(result["report_id"], str(REPORT_ID))

    async def test_delete_missing_report_returns_not_found(self):
        service = service_with_mocks()

        with self.assertRaises(HTTPException) as caught:
            await service.delete(REPORT_ID, ACTOR_ID)

        self.assertEqual(caught.exception.status_code, 404)
        service.content.get_session_summary.assert_not_awaited()
        service.repository.delete.assert_not_awaited()


if __name__ == "__main__":
    unittest.main()
