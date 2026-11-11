"""Recovery reads durable assessment/retry evidence without writes or providers."""
import unittest
from copy import deepcopy
from types import SimpleNamespace

from fastapi import HTTPException
import test_reading_content_service as content_fixture
from test_reading_assessment import final_report, retry, SESSION_ID, PAGE_ID, REVISION_ID, WORD_ID, OTHER_WORD_ID


class ReadingPracticeStateTests(unittest.IsolatedAsyncioTestCase):
    def make_service(self):
        service, repo = content_fixture.ReadingContentServiceTests().make_service()
        repo.session.return_value = SimpleNamespace(Id=SESSION_ID, ChildId=content_fixture.CHILD_ID,
            BookId=content_fixture.BOOK_ID, State="IN_PROGRESS")
        repo.page_by_id.return_value = SimpleNamespace(Id=PAGE_ID, BookId=content_fixture.BOOK_ID, PageNumber=4)
        repo.revision_snapshot.return_value = SimpleNamespace(Id=REVISION_ID, PageId=PAGE_ID)
        repo.revision_words.return_value = [SimpleNamespace(Id=WORD_ID), SimpleNamespace(Id=OTHER_WORD_ID)]
        repo.comparison_reports.return_value = [final_report()]
        return service, repo

    async def test_reload_restores_two_failed_attempts_without_resetting_or_writing(self):
        service, repo = self.make_service()
        repo.events_for_session.return_value = [retry("FAILED", 2), retry("FAILED", 1)]
        before = deepcopy(repo.comparison_reports.return_value[0].Summary)
        state = await service.get_practice_state(SESSION_ID, content_fixture.PARENT_ID)
        self.assertEqual(state.session_id, SESSION_ID)
        self.assertEqual(state.pages[0].page_revision_id, REVISION_ID)
        self.assertEqual(state.pages[0].initial_assessment[0].status, "MISPRONUNCIATION")
        self.assertEqual(state.words[0].retry_attempt_count, 2)
        self.assertEqual(state.words[0].incorrect_retry_count, 2)
        self.assertEqual(state.words[0].resolution_status, "RETRYING")
        self.assertEqual(repo.comparison_reports.return_value[0].Summary, before)
        repo.create_reading_event.assert_not_awaited()
        repo.session_for_update.assert_not_awaited()

    async def test_completed_and_self_corrected_words_are_terminal_on_reload(self):
        service, repo = self.make_service()
        repo.session.return_value.State = "COMPLETED"
        repo.events_for_session.return_value = [retry("FAILED", 1), retry("FAILED", 2), retry("CONFIRMED", 3)]
        state = await service.get_practice_state(SESSION_ID, content_fixture.PARENT_ID)
        self.assertEqual(state.words[0].resolution_status, "SELF_CORRECTED")
        self.assertEqual(state.words[0].incorrect_retry_count, 2)
        self.assertEqual(state.pages[0].initial_assessment[0].status, "MISPRONUNCIATION")
        repo.create_reading_event.assert_not_awaited()

    async def test_third_incorrect_attempt_remains_unresolved_on_reload(self):
        service, repo = self.make_service()
        repo.events_for_session.return_value = [retry("FAILED", index) for index in (1, 2, 3)]
        state = await service.get_practice_state(SESSION_ID, content_fixture.PARENT_ID)
        self.assertEqual(state.words[0].resolution_status, "UNRESOLVED")
        self.assertEqual(state.words[0].incorrect_retry_count, 3)

    async def test_legacy_comparison_is_preserved_as_unknown_without_reassessment(self):
        service, repo = self.make_service()
        repo.comparison_reports.return_value[0].Summary = {}
        state = await service.get_practice_state(SESSION_ID, content_fixture.PARENT_ID)
        self.assertTrue(state.legacy_evidence_present)
        self.assertEqual(state.pages, [])
        self.assertEqual(state.words, [])
        repo.page_by_id.assert_not_awaited()

    async def test_foreign_child_is_denied_before_reading_evidence(self):
        service, repo = self.make_service()
        repo.child_belongs_to_parent.return_value = False
        with self.assertRaises(HTTPException) as caught:
            await service.get_practice_state(SESSION_ID, content_fixture.PARENT_ID)
        self.assertEqual(caught.exception.status_code, 404)
        repo.comparison_reports.assert_not_awaited()

    async def test_cross_book_or_corrupted_word_identity_cannot_be_restored(self):
        for invalid in ("book", "word"):
            service, repo = self.make_service()
            if invalid == "book": repo.page_by_id.return_value.BookId = OTHER_WORD_ID
            else: repo.revision_words.return_value = [SimpleNamespace(Id=OTHER_WORD_ID)]
            with self.assertRaises(HTTPException) as caught:
                await service.get_practice_state(SESSION_ID, content_fixture.PARENT_ID)
            self.assertEqual(caught.exception.status_code, 501)
            repo.create_reading_event.assert_not_awaited()
