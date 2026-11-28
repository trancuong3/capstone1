"""Direct-call unit tests verifying FastAPI Query/Header/Form defaults unwrap to plain Python values."""

from __future__ import annotations

from datetime import datetime, timezone
import os
from pathlib import Path
import sys
from types import SimpleNamespace
import unittest
from unittest.mock import AsyncMock, MagicMock, patch
from uuid import uuid4

os.environ.setdefault("DATABASE_URL", "postgresql+asyncpg://test:test@127.0.0.1:1/test")
os.environ.setdefault("SUPABASE_URL", "https://example.supabase.co")
os.environ.setdefault("SUPABASE_KEY", "isolated-test-key")

BACKEND_DIR = Path(__file__).resolve().parent
if str(BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(BACKEND_DIR))

from fastapi import Response  # noqa: E402
from pydantic.fields import FieldInfo  # noqa: E402

from app.api.routes import (  # noqa: E402
    book,
    book_assets,
    book_content_quality,
    child_progress,
    karaoke_practice,
    karaoke_processing,
    memory_game,
    parent_notifications,
    parent_private_book,
    profile,
    reading,
    system,
    voice_studio,
)


def _fake_request(base_url: str = "https://api.viread.test/") -> SimpleNamespace:
    return SimpleNamespace(
        base_url=base_url,
        headers={},
        state=SimpleNamespace(request_id="req-direct-test"),
    )


class RouteDirectCallDefaultsTests(unittest.IsolatedAsyncioTestCase):
    def _assert_no_field_info_leaks(self, mock_fn: MagicMock) -> None:
        self.assertTrue(mock_fn.called, f"Expected {mock_fn} to be called")
        for call in mock_fn.call_args_list:
            for arg in call.args:
                self.assertNotIsInstance(arg, FieldInfo)
            for key, val in call.kwargs.items():
                self.assertNotIsInstance(
                    val, FieldInfo, f"Keyword arg {key!r} leaked FieldInfo: {val!r}"
                )

    async def test_child_progress_direct_call_unwraps_days_and_rejects_bool_as_int(self):
        actor_id = uuid4()
        child_id = uuid4()
        svc = SimpleNamespace(assess=AsyncMock(return_value="ok"))

        with patch.object(child_progress, "_service", return_value=svc):
            res = await child_progress.get_progress_assessment(
                child_id, actor_id=actor_id, db=None
            )
            self.assertEqual(res, "ok")
            self._assert_no_field_info_leaks(svc.assess)
            svc.assess.assert_awaited_once_with(
                child_id, actor_id, days=30, use_ai=False
            )
            self.assertIs(type(svc.assess.await_args.kwargs["days"]), int)

            svc.assess.reset_mock()
            await child_progress.get_progress_assessment(
                child_id, days=True, actor_id=actor_id, db=None  # type: ignore[arg-type]
            )
            self.assertIs(type(svc.assess.await_args.kwargs["days"]), int)
            self.assertEqual(svc.assess.await_args.kwargs["days"], 30)

    async def test_book_routes_direct_call_unwrap_query_defaults(self):
        actor_id = uuid4()
        page_id = uuid4()

        mq_svc = SimpleNamespace(dashboard=AsyncMock(return_value="mq_ok"))
        book_svc = SimpleNamespace(list_books=AsyncMock(return_value=["b1", "b2"]))
        cat_svc = SimpleNamespace(
            require_parent=AsyncMock(),
            list=AsyncMock(return_value=["c1", "c2"]),
        )
        admin_cat_svc = SimpleNamespace(
            require_admin=AsyncMock(),
            list=AsyncMock(return_value=["a1"]),
            image=AsyncMock(return_value="img_ok"),
        )

        with (
            patch.object(book, "MetadataQualityRepository", MagicMock()),
            patch.object(book, "MetadataQualityService", return_value=mq_svc),
            patch.object(book, "BookService", return_value=book_svc),
            patch.object(book, "CatalogService", return_value=cat_svc),
            patch.object(book, "AdminCatalogService", return_value=admin_cat_svc),
        ):
            res_mq = await book.get_admin_metadata_quality(actor_id=actor_id, db=None)
            self.assertEqual(res_mq, "mq_ok")
            self._assert_no_field_info_leaks(mq_svc.dashboard)
            mq_svc.dashboard.assert_awaited_once_with(
                actor_id,
                search=None,
                issue_type=None,
                lifecycle_status=None,
                limit=10,
                offset=0,
            )

            res_books = await book.get_books(db=None)
            self.assertEqual(res_books, ["b1", "b2"])

            response = Response()
            res_cat = await book.get_parent_catalog(
                response, actor_id=actor_id, db=None
            )
            self.assertEqual(res_cat, ["c1", "c2"])
            self._assert_no_field_info_leaks(cat_svc.list)
            cat_svc.list.assert_awaited_once_with(
                None,
                None,
                None,
                actor_id=actor_id,
                include_private=False,
            )
            self.assertIs(cat_svc.list.await_args.kwargs["include_private"], False)
            self.assertNotIn("Cache-Control", response.headers)

            res_admin = await book.get_admin_catalog(actor_id=actor_id, db=None)
            self.assertEqual(res_admin, ["a1"])
            self._assert_no_field_info_leaks(admin_cat_svc.list)
            admin_cat_svc.list.assert_awaited_once_with(None, None, None)

            res_img = await book.get_admin_image(page_id, actor_id=actor_id, db=None)
            self.assertEqual(res_img, "img_ok")
            admin_cat_svc.image.assert_awaited_once_with(page_id, None)

    async def test_parent_notifications_direct_call_unwraps_query_and_headers(self):
        actor_id = uuid4()
        svc = SimpleNamespace(list_history=AsyncMock(return_value=[]))
        verify_mock = MagicMock()
        dispatch_mock = AsyncMock(
            return_value={
                "scope": "all",
                "delivery_configured": True,
                "delivery_provider": "smtp",
                "presence_sent": 0,
                "reminders_sent": 0,
                "engagement_sent": 0,
                "checked_at": datetime.now(timezone.utc),
            }
        )

        with (
            patch.object(parent_notifications, "build_service", return_value=svc),
            patch.object(parent_notifications, "_verify_cron_secret", verify_mock),
            patch.object(parent_notifications, "dispatch_all_once", dispatch_mock),
        ):
            res_hist = await parent_notifications.get_history(
                actor_id=actor_id, db=None
            )
            self.assertEqual(res_hist, [])
            self._assert_no_field_info_leaks(svc.list_history)
            svc.list_history.assert_awaited_once_with(actor_id, limit=10)
            self.assertIs(type(svc.list_history.await_args.kwargs["limit"]), int)

            svc.list_history.reset_mock()
            await parent_notifications.get_history(
                limit=True, actor_id=actor_id, db=None  # type: ignore[arg-type]
            )
            self.assertIs(type(svc.list_history.await_args.kwargs["limit"]), int)
            self.assertEqual(svc.list_history.await_args.kwargs["limit"], 10)

            cron_res = await parent_notifications.trigger_cron_dispatch()
            self.assertEqual(cron_res.scope, "all")
            verify_mock.assert_called_once_with(None, None)
            dispatch_mock.assert_awaited_once_with(scope="all")

    async def test_parent_private_book_direct_call_unwraps_query_and_form_defaults(self):
        actor_id = uuid4()
        book_id = uuid4()
        page_id = uuid4()
        request = _fake_request()

        priv_svc = SimpleNamespace(
            list_books=AsyncMock(return_value=["b1"]),
            list_books_paged=AsyncMock(return_value="paged_ok"),
            submit_pages=AsyncMock(return_value="submitted_ok"),
            read_owner_page_image=AsyncMock(return_value=(b"png", "image/png")),
            admin_list_user_books=AsyncMock(return_value="queue_ok"),
        )
        flow2_svc = SimpleNamespace(
            admin_list_candidates=AsyncMock(return_value="flow2_ok"),
        )
        fake_upload = SimpleNamespace(close=AsyncMock())

        with (
            patch.object(
                parent_private_book, "ParentPrivateBookService", return_value=priv_svc
            ),
            patch.object(
                parent_private_book,
                "ParentFlow2ContributionService",
                return_value=flow2_svc,
            ),
        ):
            res_list = await parent_private_book.list_my_private_books(
                Response(), actor_id=actor_id, db=None
            )
            self.assertEqual(res_list, ["b1"])
            self._assert_no_field_info_leaks(priv_svc.list_books)
            priv_svc.list_books.assert_awaited_once_with(actor_id, ready_only=False)
            self.assertIs(priv_svc.list_books.await_args.kwargs["ready_only"], False)

            res_paged = await parent_private_book.list_my_private_books_paged(
                Response(), actor_id=actor_id, db=None
            )
            self.assertEqual(res_paged, "paged_ok")
            self._assert_no_field_info_leaks(priv_svc.list_books_paged)
            priv_svc.list_books_paged.assert_awaited_once_with(
                actor_id,
                ready_only=False,
                search=None,
                limit=9,
                offset=0,
            )

            res_submit = await parent_private_book.submit_my_private_book_pages(
                book_id,
                request,
                Response(),
                file=fake_upload,
                idempotency_key="idem-1",
                actor_id=actor_id,
                db=None,
            )
            self.assertEqual(res_submit, "submitted_ok")
            self._assert_no_field_info_leaks(priv_svc.submit_pages)
            priv_svc.submit_pages.assert_awaited_once_with(
                actor_id,
                book_id,
                fake_upload,
                idempotency_key="idem-1",
                source_type="OWNED_PHYSICAL_BOOK",
                source_note=None,
                target_page_number=None,
                base_url=str(request.base_url),
            )

            img_resp = await parent_private_book.get_my_private_page_image(
                book_id, page_id, actor_id=actor_id, db=None
            )
            self.assertEqual(img_resp.body, b"png")
            priv_svc.read_owner_page_image.assert_awaited_once_with(
                actor_id, book_id, page_id, revision_id=None
            )

            res_queue = await parent_private_book.list_admin_user_books_queue(
                Response(), actor_id=actor_id, db=None
            )
            self.assertEqual(res_queue, "queue_ok")
            self._assert_no_field_info_leaks(priv_svc.admin_list_user_books)
            priv_svc.admin_list_user_books.assert_awaited_once_with(
                actor_id,
                status_filter=None,
                search=None,
                limit=20,
                offset=0,
            )

            res_f2 = await parent_private_book.list_admin_flow2_candidates(
                request, Response(), actor_id=actor_id, db=None
            )
            self.assertEqual(res_f2, "flow2_ok")
            self._assert_no_field_info_leaks(flow2_svc.admin_list_candidates)
            flow2_svc.admin_list_candidates.assert_awaited_once_with(
                actor_id,
                status_filter=None,
                book_id=None,
                limit=25,
                offset=0,
                base_url=str(request.base_url),
            )

    async def test_profile_admin_parent_directory_direct_call_unwraps_defaults(self):
        admin_id = uuid4()
        svc = SimpleNamespace(
            list_parents=AsyncMock(
                return_value=SimpleNamespace(items=[], total=0, limit=20, offset=0)
            )
        )
        with (
            patch.object(profile, "AdminParentRepository", MagicMock()),
            patch.object(profile, "AdminParentService", return_value=svc),
        ):
            res = await profile.get_admin_parent_directory(admin_id=admin_id, db=None)
            self.assertEqual(res.total, 0)
            self.assertEqual(res.limit, 20)
            self.assertEqual(res.offset, 0)
            self._assert_no_field_info_leaks(svc.list_parents)
            svc.list_parents.assert_awaited_once_with(admin_id, None, 20, 0)

    async def test_reading_routes_direct_call_unwrap_query_header_and_form_defaults(self):
        actor_id = uuid4()
        child_id = uuid4()
        page_id = uuid4()
        session_id = uuid4()
        request = _fake_request()

        content_svc = SimpleNamespace(
            list_sessions=AsyncMock(return_value=["s1"]),
            get_page=AsyncMock(return_value="page_dto"),
        )
        hist_svc = SimpleNamespace(list=AsyncMock(return_value="history_ok"))
        ocr_svc = SimpleNamespace(
            scan_page=AsyncMock(return_value="scan_ok"),
            enqueue_scan_page_job=AsyncMock(return_value="job_ok"),
            list_scan_page_jobs=AsyncMock(return_value="jobs_list_ok"),
        )
        fake_file = SimpleNamespace()

        with (
            patch.object(reading, "ReadingContentRepository", MagicMock()),
            patch.object(reading, "ReadingContentService", return_value=content_svc),
            patch.object(reading, "HistoryRepository", MagicMock()),
            patch.object(reading, "HistoryService", return_value=hist_svc),
            patch.object(reading, "LocalOcrScanRepository", MagicMock()),
            patch.object(reading, "LocalOcrScanService", return_value=ocr_svc),
        ):
            res_sessions = await reading.get_sessions(actor_id=actor_id, db=None)
            self.assertEqual(res_sessions, ["s1"])

            res_page = await reading.get_reading_page(
                page_id,
                request,
                Response(),
                session_id=session_id,
                actor_id=actor_id,
                db=None,
            )
            self.assertEqual(res_page, "page_dto")
            self._assert_no_field_info_leaks(content_svc.get_page)
            content_svc.get_page.assert_awaited_once_with(
                page_id,
                session_id,
                actor_id,
                revision_id=None,
                base_url=str(request.base_url),
            )

            res_hist = await reading.get_owned_history(
                child_id, actor_id=actor_id, db=None
            )
            self.assertEqual(res_hist, "history_ok")
            self._assert_no_field_info_leaks(hist_svc.list)
            hist_svc.list.assert_awaited_once_with(child_id, actor_id, None, 20)

            res_scan = await reading.scan_page_with_local_ocr(
                request, file=fake_file, actor_id=actor_id, db=None
            )
            self.assertEqual(res_scan, "scan_ok")
            self._assert_no_field_info_leaks(ocr_svc.scan_page)
            ocr_svc.scan_page.assert_awaited_once_with(
                actor_id,
                fake_file,
                request_id="req-direct-test",
                book_id=None,
                child_id=None,
                idempotency_key=None,
            )

            res_enq = await reading.enqueue_scan_page_ocr_job(
                request, file=fake_file, actor_id=actor_id, db=None
            )
            self.assertEqual(res_enq, "job_ok")
            self._assert_no_field_info_leaks(ocr_svc.enqueue_scan_page_job)
            ocr_svc.enqueue_scan_page_job.assert_awaited_once_with(
                actor_id,
                fake_file,
                request_id="req-direct-test",
                book_id=None,
                child_id=None,
                idempotency_key=None,
                idempotency_key_raw=None,
            )

            res_jobs = await reading.list_scan_page_ocr_jobs(
                request, actor_id=actor_id, db=None
            )
            self.assertEqual(res_jobs, "jobs_list_ok")
            self._assert_no_field_info_leaks(ocr_svc.list_scan_page_jobs)
            ocr_svc.list_scan_page_jobs.assert_awaited_once_with(
                actor_id,
                request_id="req-direct-test",
                active_only=True,
                limit=10,
            )
            self.assertIs(ocr_svc.list_scan_page_jobs.await_args.kwargs["active_only"], True)

    async def test_system_routes_direct_call_unwrap_query_defaults(self):
        actor_id = uuid4()
        child_id = uuid4()

        diff_svc = SimpleNamespace(practice_history=AsyncMock(return_value="diff_ok"))
        admin_sys_svc = SimpleNamespace(
            require_admin=AsyncMock(),
            logs=AsyncMock(return_value="audit_page_ok"),
        )
        captured_stmt: list[object] = []

        class FakeScalarsResult:
            def scalars(self):
                return self

            def all(self):
                return []

        class FakeDb:
            async def execute(self, stmt):
                captured_stmt.append(stmt)
                return FakeScalarsResult()

        with (
            patch.object(system, "_difficult_words_service", return_value=diff_svc),
            patch.object(system, "AdminSystemService", return_value=admin_sys_svc),
        ):
            res_diff = await system.get_difficult_word_practice_history(
                child_id, actor_id=actor_id, db=None
            )
            self.assertEqual(res_diff, "diff_ok")
            self._assert_no_field_info_leaks(diff_svc.practice_history)
            diff_svc.practice_history.assert_awaited_once_with(
                child_id, actor_id, normalized_word=None, limit=20
            )

            res_admin_logs = await system.get_admin_audit_logs(
                actor_id=actor_id, db=None
            )
            self.assertEqual(res_admin_logs, "audit_page_ok")
            self._assert_no_field_info_leaks(admin_sys_svc.logs)
            admin_sys_svc.logs.assert_awaited_once_with(None, None, None, 10)

            raw_logs = await system.get_audit_logs(actor_id=actor_id, db=FakeDb())
            self.assertEqual(raw_logs, [])
            self.assertEqual(len(captured_stmt), 1)
            compiled_sql = str(
                captured_stmt[0].compile(compile_kwargs={"literal_binds": True})
            )
            self.assertIn("LIMIT 100", compiled_sql)
            self.assertIn("OFFSET 0", compiled_sql)

    async def test_voice_studio_list_voices_direct_call_unwraps_policy_defaults(self):
        actor_id = uuid4()
        orchestrator = SimpleNamespace(
            list_voices=AsyncMock(
                return_value={
                    "voices": [],
                    "default_voice_id": "local_north_truc_ly",
                    "local_worker_ready": True,
                    "google_tts_available": False,
                }
            )
        )
        response = Response()
        with patch.object(
            voice_studio, "get_voice_orchestrator", return_value=orchestrator
        ):
            res = await voice_studio.list_voices(response, _actor_id=actor_id)
        self.assertEqual(res.default_voice_id, "local_north_truc_ly")
        self._assert_no_field_info_leaks(orchestrator.list_voices)
        policy = orchestrator.list_voices.await_args.kwargs["policy"]
        self.assertEqual(policy.provider_mode, "local_only")
        self.assertIs(policy.allow_google_tts, False)

    async def test_karaoke_and_memory_game_routes_direct_call_unwrap_defaults(self):
        actor_id = uuid4()
        child_id = uuid4()
        song_id = uuid4()

        kp_svc = SimpleNamespace(
            list_practice_sessions=AsyncMock(return_value="kp_ok")
        )
        res_kp = await karaoke_practice.list_practice_sessions(
            child_id, parent_id=actor_id, service=kp_svc
        )
        self.assertEqual(res_kp, "kp_ok")
        self._assert_no_field_info_leaks(kp_svc.list_practice_sessions)
        kp_svc.list_practice_sessions.assert_awaited_once_with(
            actor_id, child_id, song_id=None, limit=10
        )

        kproc_svc = SimpleNamespace(list=AsyncMock(return_value="kproc_ok"))
        res_kproc = await karaoke_processing.list_jobs(
            song_id, actor=actor_id, service=kproc_svc
        )
        self.assertEqual(res_kproc, "kproc_ok")
        self._assert_no_field_info_leaks(kproc_svc.list)
        kproc_svc.list.assert_awaited_once_with(
            actor_id, song_id, limit=10, offset=0
        )

        mem_svc = SimpleNamespace(list_sessions=AsyncMock(return_value=[]))
        with patch.object(memory_game, "_build_service", return_value=mem_svc):
            res_mem = await memory_game.list_memory_game_sessions(
                child_id=child_id, parent_id=actor_id, db=None
            )
        self.assertEqual(res_mem, [])
        self._assert_no_field_info_leaks(mem_svc.list_sessions)
        mem_svc.list_sessions.assert_awaited_once_with(
            actor_id, child_id, limit=10
        )

    async def test_book_quality_and_cover_upload_routes_direct_call_unwrap_defaults(self):
        actor_id = uuid4()
        book_id = uuid4()
        qual_svc = SimpleNamespace(
            list_parent_reports=AsyncMock(return_value="mine_ok"),
            list_admin_reports=AsyncMock(return_value="admin_reports_ok"),
            list_books=AsyncMock(return_value="admin_books_ok"),
            get_book_rights=AsyncMock(return_value="rights_ok"),
        )
        with patch.object(book_content_quality, "_service", return_value=qual_svc):
            self.assertEqual(
                await book_content_quality.list_my_book_reports(actor_id=actor_id, db=None),
                "mine_ok",
            )
            self._assert_no_field_info_leaks(qual_svc.list_parent_reports)
            qual_svc.list_parent_reports.assert_awaited_once_with(
                actor_id, limit=20, offset=0
            )

            self.assertEqual(
                await book_content_quality.list_admin_book_reports(actor_id=actor_id, db=None),
                "admin_reports_ok",
            )
            self._assert_no_field_info_leaks(qual_svc.list_admin_reports)
            qual_svc.list_admin_reports.assert_awaited_once_with(
                actor_id,
                status=None,
                issue_type=None,
                book_id=None,
                search=None,
                created_after=None,
                created_before=None,
                limit=20,
                offset=0,
            )

            self.assertEqual(
                await book_content_quality.list_admin_quality_books(actor_id=actor_id, db=None),
                "admin_books_ok",
            )
            self._assert_no_field_info_leaks(qual_svc.list_books)
            qual_svc.list_books.assert_awaited_once_with(
                actor_id,
                search=None,
                limit=20,
                offset=0,
                status_filter=None,
                alert_filter=None,
            )

            self.assertEqual(
                await book_content_quality.get_admin_book_rights(
                    book_id, actor_id=actor_id, db=None
                ),
                "rights_ok",
            )
            self._assert_no_field_info_leaks(qual_svc.get_book_rights)
            qual_svc.get_book_rights.assert_awaited_once_with(
                actor_id, book_id, page_id=None
            )

        cover_svc = SimpleNamespace(
            upload_user_cover=AsyncMock(return_value="cover_ok")
        )
        fake_file = SimpleNamespace(
            content_type="image/jpeg",
            read=AsyncMock(return_value=b"jpeg-bytes"),
            close=AsyncMock(),
        )
        with patch.object(book_assets, "BookCoverService", return_value=cover_svc):
            res_cover = await book_assets.upload_book_cover(
                book_id,
                Response(),
                file=fake_file,
                actor_id=actor_id,
                db=None,
            )
        self.assertEqual(res_cover, "cover_ok")
        self._assert_no_field_info_leaks(cover_svc.upload_user_cover)
        cover_svc.upload_user_cover.assert_awaited_once_with(
            actor_id,
            book_id,
            b"jpeg-bytes",
            "image/jpeg",
            crop_x=None,
            crop_y=None,
            crop_w=None,
            crop_h=None,
            rotation=0,
        )


if __name__ == "__main__":
    unittest.main()
