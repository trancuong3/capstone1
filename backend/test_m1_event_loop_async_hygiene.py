"""M1 Event-Loop Unblocking & Async Storage/Auth Hygiene Unit Tests."""

from __future__ import annotations

import asyncio
from collections import deque
from contextlib import contextmanager
from datetime import datetime, timezone
import gc
from io import BytesIO
import os
from pathlib import Path
import shutil
import sys
import tempfile
import threading
import time
from types import SimpleNamespace
import unittest
from unittest.mock import AsyncMock, MagicMock, patch
from uuid import UUID, uuid4

_BACKEND_DIR = str(Path(__file__).resolve().parent)
if _BACKEND_DIR not in sys.path:
    sys.path.insert(0, _BACKEND_DIR)

os.environ.setdefault("DATABASE_URL", "postgresql+asyncpg://test:test@127.0.0.1:1/test")
os.environ.setdefault("SUPABASE_URL", "https://example.supabase.co")
os.environ.setdefault("SUPABASE_KEY", "isolated-test-key")

from fastapi import HTTPException
from fastapi.security import HTTPAuthorizationCredentials
from PIL import Image

from app.api.routes import assistant as assistant_routes
from app.api.routes import profile as profile_routes
from app.database.config import SUPABASE_STORAGE_BUCKET
from app.services import (
    avatar_service,
    document_rasterizer_service,
    global_tasks_service,
    tts_audio_cache_service,
)
from app.services.document_rasterizer_service import (
    RasterizedDocumentPage,
    SpooledUploadDocument,
    iter_rasterized_spooled_document,
)
from app.services.gpu_workload_scheduler import (
    GpuWorkloadScheduler,
    PreemptionRequested,
    WorkloadPriority,
)
from app.services.tts_audio_cache_service import ResolvedCacheTarget, TtsAudioCacheService


def _png_bytes(size: tuple[int, int] = (200, 100)) -> bytes:
    buf = BytesIO()
    Image.new("RGB", size, (40, 120, 200)).save(buf, format="PNG")
    return buf.getvalue()


def _pdf_bytes_3pages() -> bytes:
    import pypdfium2

    pdf = pypdfium2.PdfDocument.new()
    try:
        for _ in range(3):
            pdf.new_page(200, 300)
        buf = BytesIO()
        pdf.save(buf)
        return buf.getvalue()
    finally:
        pdf.close()


def _tiff_bytes_multipage(num_pages: int = 3) -> bytes:
    frames = [
        Image.new("RGB", (120, 120), (30 * i, 90, 180))
        for i in range(1, num_pages + 1)
    ]
    buf = BytesIO()
    try:
        frames[0].save(buf, format="TIFF", save_all=True, append_images=frames[1:])
        return buf.getvalue()
    finally:
        for frame in frames:
            frame.close()


class _LoopHeartbeatGate:
    """Deterministic worker-thread <-> event-loop handshake."""

    def __init__(
        self,
        *,
        ticks_per_checkpoint: int = 2,
        timeout: float = 5.0,
    ) -> None:
        self.ticks_per_checkpoint = ticks_per_checkpoint
        self.timeout = timeout
        self._loop: asyncio.AbstractEventLoop | None = None
        self._lock = threading.Lock()
        self._pending_wakes: deque[threading.Event] = deque()
        self._loop_wake: asyncio.Event | None = None
        self._stopped = False
        self.checkpoints_completed = 0
        self.timed_out = False

    def bind(self, loop: asyncio.AbstractEventLoop) -> asyncio.Event:
        with self._lock:
            self._loop = loop
            self._loop_wake = asyncio.Event()
            self._stopped = False
            self._pending_wakes.clear()
            return self._loop_wake

    def stop(self) -> None:
        with self._lock:
            self._stopped = True
            while self._pending_wakes:
                self._pending_wakes.popleft().set()

    def wait_for_ticks(self) -> None:
        wake = threading.Event()
        with self._lock:
            if self._stopped:
                return
            loop = self._loop
            loop_wake = self._loop_wake
            if loop is None or loop_wake is None:
                raise AssertionError(
                    "_LoopHeartbeatGate.wait_for_ticks() called outside _run_with_heartbeat"
                )
            self._pending_wakes.append(wake)
        try:
            if not loop.is_closed():
                loop.call_soon_threadsafe(loop_wake.set)
        except RuntimeError:
            pass
        if not wake.wait(timeout=self.timeout):
            self.timed_out = True
            raise AssertionError(
                "Timed out waiting for event-loop heartbeat ticks; "
                "sync function may have blocked the event loop."
            )


async def _run_with_heartbeat(
    coro,
    *,
    gate: _LoopHeartbeatGate,
    min_checkpoints: int = 1,
):
    """Run coroutine while a concurrent asyncio ticker proves non-blocking loop progress."""
    loop = asyncio.get_running_loop()
    loop_wake = gate.bind(loop)
    ticks = 0
    stop = asyncio.Event()

    async def _ticker():
        nonlocal ticks
        while not stop.is_set():
            wait_wake = asyncio.create_task(loop_wake.wait())
            wait_stop = asyncio.create_task(stop.wait())
            _done, pending = await asyncio.wait(
                {wait_wake, wait_stop},
                return_when=asyncio.FIRST_COMPLETED,
            )
            for p in pending:
                p.cancel()
            if pending:
                await asyncio.gather(*pending, return_exceptions=True)
            if stop.is_set():
                break
            with gate._lock:
                loop_wake.clear()
                wakes: list[threading.Event] = []
                while gate._pending_wakes:
                    wakes.append(gate._pending_wakes.popleft())
            if not wakes:
                continue
            for _ in range(gate.ticks_per_checkpoint):
                if stop.is_set():
                    break
                await asyncio.sleep(0)
                ticks += 1
            gate.checkpoints_completed += len(wakes)
            for w in wakes:
                w.set()

    task = asyncio.create_task(_ticker())
    try:
        result = await coro
    finally:
        stop.set()
        gate.stop()
        await task

    if gate.timed_out:
        raise AssertionError(
            "Timed out waiting for event-loop heartbeat ticks; "
            "sync function may have blocked the event loop."
        )
    if gate.checkpoints_completed < min_checkpoints:
        raise AssertionError(
            f"Expected at least {min_checkpoints} heartbeat checkpoint(s), "
            f"got {gate.checkpoints_completed}."
        )
    return result, ticks


class AssistantActorOffloadTests(unittest.IsolatedAsyncioTestCase):
    async def test_resolve_assistant_actor_runs_auth_off_event_loop_and_does_not_block(self):
        loop_thread_id = threading.get_ident()
        observed_threads: list[int] = []
        parent_id = uuid4()
        gate = _LoopHeartbeatGate(ticks_per_checkpoint=3)

        def fake_get_current_parent_id(credentials):
            observed_threads.append(threading.get_ident())
            gate.wait_for_ticks()
            return parent_id

        fake_app = SimpleNamespace(dependency_overrides={})
        request = SimpleNamespace(
            client=SimpleNamespace(host="127.0.0.1"),
            app=fake_app,
        )
        creds = HTTPAuthorizationCredentials(scheme="Bearer", credentials="valid-token")

        with (
            patch.object(
                assistant_routes,
                "get_current_parent_id",
                side_effect=fake_get_current_parent_id,
            ),
            patch.object(
                assistant_routes,
                "_lookup_active_role",
                AsyncMock(return_value="parent"),
            ),
        ):
            actor, ticks = await _run_with_heartbeat(
                assistant_routes.resolve_assistant_actor(request, creds),
                gate=gate,
                min_checkpoints=1,
            )

        self.assertEqual(actor.role_scope, "parent")
        self.assertEqual(actor.subject_key, f"user:{parent_id}")
        self.assertEqual(len(observed_threads), 1)
        self.assertNotEqual(observed_threads[0], loop_thread_id)
        self.assertGreaterEqual(ticks, 3)

    async def test_resolve_assistant_actor_fails_closed_on_http_exception(self):
        loop_thread_id = threading.get_ident()
        observed_threads: list[int] = []

        def fake_get_current_parent_id(credentials):
            observed_threads.append(threading.get_ident())
            raise HTTPException(status_code=503, detail="Auth unavailable")

        request = SimpleNamespace(
            client=SimpleNamespace(host="10.0.0.5"),
            app=SimpleNamespace(dependency_overrides={}),
        )
        creds = HTTPAuthorizationCredentials(scheme="Bearer", credentials="bad-token")

        with patch.object(
            assistant_routes,
            "get_current_parent_id",
            side_effect=fake_get_current_parent_id,
        ):
            actor = await assistant_routes.resolve_assistant_actor(request, creds)

        self.assertEqual(actor.role_scope, "public")
        self.assertEqual(actor.subject_key, "ip:10.0.0.5")
        self.assertEqual(len(observed_threads), 1)
        self.assertNotEqual(observed_threads[0], loop_thread_id)


class AvatarServiceAsyncHygieneTests(unittest.IsolatedAsyncioTestCase):
    async def test_upload_parent_avatar_offloads_normalize_upload_delete_and_releases_read_tx(self):
        loop_thread_id = threading.get_ident()
        parent_id = uuid4()
        old_path = f"profiles/{parent_id}/avatar/old.webp"
        parent = SimpleNamespace(Active=1, AvatarPath=old_path)
        events: list[str] = []
        thread_ids: dict[str, int] = {}

        async def rollback():
            events.append("rollback")

        profile_repo = SimpleNamespace(
            db=SimpleNamespace(rollback=AsyncMock(side_effect=rollback)),
            get_by_id=AsyncMock(return_value=parent),
            update_avatar_path=AsyncMock(side_effect=lambda *_args: events.append("persist") or parent),
        )
        child_repo = SimpleNamespace()
        service = avatar_service.AvatarService(profile_repo, child_repo)

        real_normalize = avatar_service.normalize_avatar_image
        gate = _LoopHeartbeatGate(ticks_per_checkpoint=2)

        def wrapped_normalize(data, content_type):
            thread_ids["normalize"] = threading.get_ident()
            events.append("normalize")
            gate.wait_for_ticks()
            return real_normalize(data, content_type)

        def fake_upload(path, data, content_type, **kwargs):
            thread_ids["upload"] = threading.get_ident()
            events.append("upload")
            gate.wait_for_ticks()

        def fake_delete(path, **kwargs):
            thread_ids["delete"] = threading.get_ident()
            events.append("delete")
            gate.wait_for_ticks()

        with (
            patch.object(avatar_service, "normalize_avatar_image", side_effect=wrapped_normalize),
            patch.object(avatar_service, "upload_object", side_effect=fake_upload),
            patch.object(avatar_service, "delete_object", side_effect=fake_delete),
        ):
            _, ticks = await _run_with_heartbeat(
                service.upload_parent_avatar(parent_id, _png_bytes(), "image/png"),
                gate=gate,
                min_checkpoints=3,
            )

        self.assertEqual(events, ["rollback", "normalize", "upload", "persist", "delete"])
        for stage in ("normalize", "upload", "delete"):
            self.assertNotEqual(thread_ids[stage], loop_thread_id)
        self.assertGreaterEqual(ticks, 5)

    async def test_upload_and_remove_child_and_parent_avatars_offload_cleanup(self):
        loop_thread_id = threading.get_ident()
        parent_id = uuid4()
        child_id = uuid4()
        parent = SimpleNamespace(Active=1, AvatarPath=f"profiles/{parent_id}/avatar/p.webp")
        child = SimpleNamespace(AvatarPath=f"children/{child_id}/avatar/c.webp")
        child_events: list[str] = []
        thread_ids: list[tuple[str, int]] = []

        profile_repo = SimpleNamespace(
            db=SimpleNamespace(rollback=AsyncMock()),
            get_by_id=AsyncMock(return_value=parent),
            update_avatar_path=AsyncMock(
                side_effect=lambda *_args: child_events.append("parent_persist") or parent
            ),
        )
        child_repo = SimpleNamespace(
            db=SimpleNamespace(rollback=AsyncMock(side_effect=lambda: child_events.append("rollback"))),
            get_by_id_and_parent=AsyncMock(return_value=child),
            update_avatar_path=AsyncMock(side_effect=lambda *_args: child_events.append("persist") or child),
        )
        service = avatar_service.AvatarService(profile_repo, child_repo)

        active_gate: _LoopHeartbeatGate | None = None

        def fake_upload(*_args, **_kwargs):
            thread_ids.append(("upload", threading.get_ident()))
            child_events.append("upload")
            assert active_gate is not None
            active_gate.wait_for_ticks()

        def fake_delete(*_args, **_kwargs):
            thread_ids.append(("delete", threading.get_ident()))
            child_events.append("delete")
            assert active_gate is not None
            active_gate.wait_for_ticks()

        with (
            patch.object(avatar_service, "upload_object", side_effect=fake_upload),
            patch.object(avatar_service, "delete_object", side_effect=fake_delete),
        ):
            active_gate = _LoopHeartbeatGate(ticks_per_checkpoint=2)
            _, upload_ticks = await _run_with_heartbeat(
                service.upload_child_avatar(parent_id, child_id, _png_bytes(), "image/png"),
                gate=active_gate,
                min_checkpoints=2,
            )
            active_gate = _LoopHeartbeatGate(ticks_per_checkpoint=2)
            _, parent_ticks = await _run_with_heartbeat(
                service.remove_parent_avatar(parent_id),
                gate=active_gate,
                min_checkpoints=1,
            )
            active_gate = _LoopHeartbeatGate(ticks_per_checkpoint=2)
            _, child_ticks = await _run_with_heartbeat(
                service.remove_child_avatar(parent_id, child_id),
                gate=active_gate,
                min_checkpoints=1,
            )

        self.assertEqual(
            child_events,
            ["rollback", "upload", "persist", "delete", "parent_persist", "delete", "persist", "delete"],
        )
        self.assertEqual([op for op, _ in thread_ids], ["upload", "delete", "delete", "delete"])
        for _, tid in thread_ids:
            self.assertNotEqual(tid, loop_thread_id)
        self.assertGreaterEqual(upload_ticks, 4)
        self.assertGreaterEqual(parent_ticks, 2)
        self.assertGreaterEqual(child_ticks, 2)


class ChildProfileAsyncSigningTests(unittest.IsolatedAsyncioTestCase):
    def test_profile_routes_do_not_expose_sync_create_signed_image_url(self):
        self.assertFalse(hasattr(profile_routes, "create_signed_image_url"))
        self.assertFalse(hasattr(profile_routes, "SUPABASE_AVATAR_BUCKET"))

    async def test_list_children_releases_read_tx_before_batch_signing_when_avatars_exist(self):
        parent_id = uuid4()
        child_id = uuid4()
        avatar_path = f"children/{child_id}/avatar/a.webp"
        child = SimpleNamespace(
            Id=child_id,
            ParentId=parent_id,
            Alias="Bé Minh",
            Grade=1,
            Settings={"voice": "north"},
            CreatedAt=datetime(2026, 11, 1, tzinfo=timezone.utc),
            AvatarPath=avatar_path,
        )
        call_order: list[str] = []

        async def fake_rollback():
            call_order.append("rollback")

        async def fake_batch_sign(paths):
            call_order.append("sign")
            return {p: f"https://signed.example/{p}" for p in paths}

        repo = SimpleNamespace(
            db=SimpleNamespace(rollback=AsyncMock(side_effect=fake_rollback)),
            list_by_parent=AsyncMock(return_value=[child]),
            get_by_id_and_parent=AsyncMock(return_value=child),
        )
        service = profile_routes.ChildProfileService(repo)

        with patch.object(profile_routes, "batch_sign_avatar_paths", side_effect=fake_batch_sign):
            items = await service.list_children(parent_id)
            single = await service.get_child(child_id, parent_id)

        self.assertEqual(call_order, ["rollback", "sign", "rollback", "sign"])
        self.assertEqual(items[0]["avatar_url"], f"https://signed.example/{avatar_path}")
        self.assertEqual(single["avatar_url"], f"https://signed.example/{avatar_path}")

    async def test_list_children_skips_rollback_when_no_avatar_paths_need_signing(self):
        parent_id = uuid4()
        child = SimpleNamespace(
            Id=uuid4(),
            ParentId=parent_id,
            Alias="Bé Lan",
            Grade=2,
            Settings={},
            CreatedAt=datetime(2026, 11, 1, tzinfo=timezone.utc),
            AvatarPath=None,
        )
        rollback_mock = AsyncMock()
        repo = SimpleNamespace(
            db=SimpleNamespace(rollback=rollback_mock),
            list_by_parent=AsyncMock(return_value=[child]),
        )
        service = profile_routes.ChildProfileService(repo)

        with patch.object(profile_routes, "batch_sign_avatar_paths", AsyncMock(return_value={})) as sign_mock:
            items = await service.list_children(parent_id)

        rollback_mock.assert_not_awaited()
        sign_mock.assert_not_awaited()
        self.assertIsNone(items[0]["avatar_url"])

    async def test_child_profile_response_is_async_and_uses_batch_sign(self):
        child_id = uuid4()
        avatar_path = f"children/{child_id}/avatar/direct.webp"
        child = SimpleNamespace(
            Id=child_id,
            ParentId=uuid4(),
            Alias="Bé An",
            Grade=3,
            Settings={},
            CreatedAt=datetime(2026, 11, 1, tzinfo=timezone.utc),
            AvatarPath=avatar_path,
        )
        with patch.object(
            profile_routes,
            "batch_sign_avatar_paths",
            AsyncMock(return_value={avatar_path: "https://signed.example/direct"}),
        ) as sign_mock:
            res = await profile_routes.ChildProfileService._response(child)

        sign_mock.assert_awaited_once_with([avatar_path])
        self.assertEqual(res["avatar_url"], "https://signed.example/direct")


class GlobalTasksServiceAsyncHygieneTests(unittest.IsolatedAsyncioTestCase):
    async def test_execute_ocr_extract_job_uses_async_download_and_offloads_boundary_detection(self):
        loop_thread_id = threading.get_ident()
        observed_boundary_threads: list[int] = []
        book_id = uuid4()
        page_id = uuid4()
        rev_id = uuid4()
        actor_id = uuid4()
        job = SimpleNamespace(
            Id=uuid4(),
            BookPageId=page_id,
            BookId=book_id,
            SourceRevisionId=rev_id,
            ActorId=actor_id,
            ActorRole="admin",
            CheckpointsJson={},
        )
        page = SimpleNamespace(Id=page_id, PageNumber=1, ImagePath="books/1/p1.png")
        book = SimpleNamespace(
            Id=book_id,
            Title="Truyện",
            Author="Tác giả",
            BookScope="CATALOG",
            OwnerParentId=None,
        )
        revision = SimpleNamespace(Id=rev_id)

        fake_repo = SimpleNamespace(
            get_page_with_book=AsyncMock(return_value=(page, book)),
            resolve_revision_for_page=AsyncMock(return_value=revision),
            load_revision_words=AsyncMock(return_value=[]),
            load_sibling_cross_pages=AsyncMock(return_value=[]),
            get_latest_extraction=AsyncMock(return_value=(None, False)),
            save_extraction=AsyncMock(return_value=(SimpleNamespace(Id=uuid4()), False)),
        )
        fake_svc = SimpleNamespace(commit_stage_result=AsyncMock())
        fake_extract_result = SimpleNamespace(
            page_kind="STORY_TEXT",
            filter_mode="active",
            requires_review=False,
            stats=SimpleNamespace(keep_blocks=1, exclude_blocks=0, review_blocks=0),
        )

        gate = _LoopHeartbeatGate(ticks_per_checkpoint=3)

        def fake_detect_boundary(img_bytes, word_bboxes_norm=None):
            observed_boundary_threads.append(threading.get_ident())
            gate.wait_for_ticks()
            return {"detected": True}

        download_async_mock = AsyncMock(return_value=b"fake-image-bytes")

        with (
            patch("app.repositories.ocr_extraction_repository.OcrExtractionRepository", return_value=fake_repo),
            patch("app.services.storage_service.download_object_async", download_async_mock),
            patch(
                "app.services.storage_service.download_object",
                side_effect=AssertionError("sync download_object must not be called"),
            ),
            patch("app.services.ocr_document_boundary.detect_document_boundary", side_effect=fake_detect_boundary),
            patch("app.services.ocr_content_extraction.extract_ocr_content", return_value=fake_extract_result),
        ):
            _, ticks = await _run_with_heartbeat(
                global_tasks_service._execute_ocr_extract_job(
                    MagicMock(),
                    fake_svc,
                    job,
                    uuid4(),
                    GpuWorkloadScheduler(),
                ),
                gate=gate,
                min_checkpoints=1,
            )

        expected_bucket = SUPABASE_STORAGE_BUCKET or "books"
        download_async_mock.assert_awaited_once_with(
            "books/1/p1.png", bucket_name=expected_bucket
        )
        self.assertEqual(len(observed_boundary_threads), 1)
        self.assertNotEqual(observed_boundary_threads[0], loop_thread_id)
        self.assertGreaterEqual(ticks, 3)
        fake_svc.commit_stage_result.assert_awaited_once()
        self.assertEqual(fake_svc.commit_stage_result.await_args.kwargs["next_status"], "SUCCEEDED")

    async def test_execute_batch_book_import_job_mode_a_offloads_download_and_rasterizer_and_preserves_statuses(self):
        loop_thread_id = threading.get_ident()
        book_id = uuid4()
        actor_id = uuid4()

        for scenario in ("succeeded", "partial", "failed"):
            with self.subTest(scenario=scenario):
                rasterizer_threads: list[int] = []
                gate = _LoopHeartbeatGate(ticks_per_checkpoint=2)
                job = SimpleNamespace(
                    Id=uuid4(),
                    BookId=book_id,
                    ActorId=actor_id,
                    ActorRole="admin",
                    CheckpointsJson={
                        "source_storage_path": "imports/book.pdf",
                        "file_name": "book.pdf",
                        "content_type": "application/pdf",
                    },
                )
                book = SimpleNamespace(
                    Id=book_id,
                    IsDeleted=False,
                    BookScope="CATALOG",
                    OwnerParentId=None,
                )
                fake_svc = SimpleNamespace(
                    repo=SimpleNamespace(get_book=AsyncMock(return_value=book)),
                    commit_stage_result=AsyncMock(),
                )

                pages = [
                    RasterizedDocumentPage(
                        source_page=1,
                        image_bytes=_png_bytes((120, 120)),
                        content_type="image/png",
                        extension=".png",
                        width=120,
                        height=120,
                    ),
                    RasterizedDocumentPage(
                        source_page=2,
                        image_bytes=_png_bytes((120, 120)),
                        content_type="image/png",
                        extension=".png",
                        width=120,
                        height=120,
                    ),
                ]

                @contextmanager
                def fake_iter_rasterized(spooled: SpooledUploadDocument):
                    self.assertIsInstance(spooled, SpooledUploadDocument)
                    self.assertEqual(spooled.byte_length, len(b"%PDF-1.4-fake"))
                    self.assertEqual(spooled.header_bytes, b"%PDF-1.4-fake")
                    rasterizer_threads.append(threading.get_ident())

                    def _gen():
                        for p in pages:
                            rasterizer_threads.append(threading.get_ident())
                            gate.wait_for_ticks()
                            yield p

                    try:
                        yield ("book.pdf", "PDF", spooled.source_sha256, _gen())
                    finally:
                        rasterizer_threads.append(threading.get_ident())

                async def fake_ingest(_actor, _book_id, *, data, **_kwargs):
                    if scenario == "failed":
                        raise RuntimeError("ingest fail all")
                    if scenario == "partial" and len(ingest_calls) == 1:
                        ingest_calls.append(2)
                        raise RuntimeError("ingest fail page 2")
                    ingest_calls.append(len(ingest_calls) + 1)
                    return len(ingest_calls), SimpleNamespace(page_id=uuid4())

                ingest_calls: list[int] = []
                fake_admin_ocr = SimpleNamespace(_ingest_validated_page_image=AsyncMock(side_effect=fake_ingest))
                download_async_mock = AsyncMock(return_value=b"%PDF-1.4-fake")

                with (
                    patch("app.services.storage_service.download_object_async", download_async_mock),
                    patch(
                        "app.services.storage_service.download_object",
                        side_effect=AssertionError("sync download_object must not be called"),
                    ),
                    patch(
                        "app.services.document_rasterizer_service.iter_rasterized_spooled_document",
                        side_effect=fake_iter_rasterized,
                    ),
                    patch("app.services.admin_ocr_service.AdminOcrService", return_value=fake_admin_ocr),
                ):
                    _, ticks = await _run_with_heartbeat(
                        global_tasks_service._execute_batch_book_import_job(
                            MagicMock(),
                            fake_svc,
                            job,
                            uuid4(),
                            GpuWorkloadScheduler(),
                            MagicMock(),
                        ),
                        gate=gate,
                        min_checkpoints=2,
                    )

                expected_bucket = SUPABASE_STORAGE_BUCKET or "books"
                download_async_mock.assert_awaited_once_with(
                    "imports/book.pdf", bucket_name=expected_bucket
                )
                self.assertGreaterEqual(len(rasterizer_threads), 4)
                for tid in rasterizer_threads:
                    self.assertNotEqual(tid, loop_thread_id)
                self.assertGreaterEqual(ticks, 3)

                final_call = fake_svc.commit_stage_result.await_args_list[-1].kwargs
                expected_status = {
                    "succeeded": "SUCCEEDED",
                    "partial": "PARTIAL_SUCCESS",
                    "failed": "FAILED",
                }[scenario]
                self.assertEqual(final_call["next_status"], expected_status)
                self.assertEqual(final_call["result_ref"]["total_source_pages"], 2)

    async def test_batch_book_import_mode_a_preemption_mid_pdf_cleans_temp_file(self):
        pdf_bytes = _pdf_bytes_3pages()
        scheduler = GpuWorkloadScheduler(max_concurrent_gpu_jobs=1)
        book_id = uuid4()
        actor_id = uuid4()
        job = SimpleNamespace(
            Id=uuid4(),
            BookId=book_id,
            ActorId=actor_id,
            ActorRole="admin",
            CheckpointsJson={
                "source_storage_path": "imports/three_pages.pdf",
                "file_name": "three_pages.pdf",
                "content_type": "application/pdf",
            },
        )
        book = SimpleNamespace(
            Id=book_id,
            IsDeleted=False,
            BookScope="CATALOG",
            OwnerParentId=None,
        )
        fake_svc = SimpleNamespace(
            repo=SimpleNamespace(get_book=AsyncMock(return_value=book)),
            commit_stage_result=AsyncMock(),
        )

        real_mkstemp = tempfile.mkstemp
        created_temp_pdfs: list[Path] = []
        observed_spooled: list[SpooledUploadDocument] = []
        real_iter = iter_rasterized_spooled_document

        def spy_mkstemp(*args, **kwargs):
            fd, raw_path = real_mkstemp(*args, **kwargs)
            created_temp_pdfs.append(Path(raw_path))
            return fd, raw_path

        def spy_iter(spooled: SpooledUploadDocument):
            observed_spooled.append(spooled)
            return real_iter(spooled)

        ingest_calls = 0
        urgent_task: asyncio.Task[str] | None = None

        async def fake_urgent_job(_handle):
            return "urgent_done"

        async def fake_ingest(_actor, _book_id, **_kwargs):
            nonlocal ingest_calls, urgent_task
            ingest_calls += 1
            if ingest_calls == 1:
                urgent_task = asyncio.create_task(
                    scheduler.run(
                        priority=WorkloadPriority.URGENT_OCR,
                        workload_id="urgent-ocr-test",
                        estimated_vram_mb=500,
                        coro_factory=fake_urgent_job,
                    )
                )
                await asyncio.sleep(0)
            return ingest_calls, SimpleNamespace(page_id=uuid4())

        fake_admin_ocr = SimpleNamespace(
            _ingest_validated_page_image=AsyncMock(side_effect=fake_ingest)
        )
        download_async_mock = AsyncMock(return_value=pdf_bytes)

        try:
            with (
                patch("app.services.storage_service.download_object_async", download_async_mock),
                patch.object(document_rasterizer_service.tempfile, "mkstemp", side_effect=spy_mkstemp),
                patch.object(
                    document_rasterizer_service,
                    "iter_rasterized_spooled_document",
                    side_effect=spy_iter,
                ),
                patch("app.services.admin_ocr_service.AdminOcrService", return_value=fake_admin_ocr),
            ):
                with self.assertRaises(PreemptionRequested) as exc_ctx:
                    await global_tasks_service._execute_batch_book_import_job(
                        MagicMock(),
                        fake_svc,
                        job,
                        uuid4(),
                        scheduler,
                        MagicMock(),
                    )

            self.assertEqual(exc_ctx.exception.stage, "source_page_2")
            self.assertEqual(ingest_calls, 1)
            self.assertIsNotNone(urgent_task)
            assert urgent_task is not None
            self.assertEqual(await urgent_task, "urgent_done")
            self.assertEqual(len(observed_spooled), 1)
            self.assertTrue(observed_spooled[0].spool_file.closed)
            self.assertEqual(len(created_temp_pdfs), 1)
            self.assertEqual([p for p in created_temp_pdfs if p.exists()], [])
        finally:
            for p in created_temp_pdfs:
                p.unlink(missing_ok=True)

    async def test_batch_book_import_mode_a_mid_pdf_abort_and_cancel_clean_temp_file(self):
        pdf_bytes = _pdf_bytes_3pages()

        def _make_job_and_deps():
            book_id = uuid4()
            job = SimpleNamespace(
                Id=uuid4(),
                BookId=book_id,
                ActorId=uuid4(),
                ActorRole="admin",
                CheckpointsJson={
                    "source_storage_path": "imports/three_pages.pdf",
                    "file_name": "three_pages.pdf",
                    "content_type": "application/pdf",
                },
            )
            book = SimpleNamespace(
                Id=book_id,
                IsDeleted=False,
                BookScope="CATALOG",
                OwnerParentId=None,
            )
            return job, book

        # Sub-case 1: RuntimeError in commit_stage_result after page 1
        with self.subTest(scenario="commit_stage_result_runtime_error"):
            job, book = _make_job_and_deps()
            fake_svc = SimpleNamespace(
                repo=SimpleNamespace(get_book=AsyncMock(return_value=book)),
                commit_stage_result=AsyncMock(side_effect=RuntimeError("db abort mid-pdf")),
            )
            real_mkstemp = tempfile.mkstemp
            created_temp_pdfs: list[Path] = []
            observed_spooled: list[SpooledUploadDocument] = []
            real_iter = iter_rasterized_spooled_document

            def spy_mkstemp(*args, **kwargs):
                fd, raw_path = real_mkstemp(*args, **kwargs)
                created_temp_pdfs.append(Path(raw_path))
                return fd, raw_path

            def spy_iter(spooled: SpooledUploadDocument):
                observed_spooled.append(spooled)
                return real_iter(spooled)

            fake_admin_ocr = SimpleNamespace(
                _ingest_validated_page_image=AsyncMock(
                    return_value=(1, SimpleNamespace(page_id=uuid4()))
                )
            )
            try:
                with (
                    patch("app.services.storage_service.download_object_async", AsyncMock(return_value=pdf_bytes)),
                    patch.object(document_rasterizer_service.tempfile, "mkstemp", side_effect=spy_mkstemp),
                    patch.object(
                        document_rasterizer_service,
                        "iter_rasterized_spooled_document",
                        side_effect=spy_iter,
                    ),
                    patch("app.services.admin_ocr_service.AdminOcrService", return_value=fake_admin_ocr),
                ):
                    with self.assertRaisesRegex(RuntimeError, "db abort mid-pdf"):
                        await global_tasks_service._execute_batch_book_import_job(
                            MagicMock(),
                            fake_svc,
                            job,
                            uuid4(),
                            GpuWorkloadScheduler(),
                            MagicMock(),
                        )
                self.assertEqual(len(observed_spooled), 1)
                self.assertTrue(observed_spooled[0].spool_file.closed)
                self.assertEqual(len(created_temp_pdfs), 1)
                self.assertEqual([p for p in created_temp_pdfs if p.exists()], [])
            finally:
                for p in created_temp_pdfs:
                    p.unlink(missing_ok=True)

        # Sub-case 2: mid-loop asyncio.Task.cancel()
        with self.subTest(scenario="mid_loop_task_cancel"):
            job, book = _make_job_and_deps()
            fake_svc = SimpleNamespace(
                repo=SimpleNamespace(get_book=AsyncMock(return_value=book)),
                commit_stage_result=AsyncMock(),
            )
            real_mkstemp = tempfile.mkstemp
            created_temp_pdfs = []
            observed_spooled = []
            real_iter = iter_rasterized_spooled_document
            in_ingest = asyncio.Event()

            def spy_mkstemp(*args, **kwargs):
                fd, raw_path = real_mkstemp(*args, **kwargs)
                created_temp_pdfs.append(Path(raw_path))
                return fd, raw_path

            def spy_iter(spooled: SpooledUploadDocument):
                observed_spooled.append(spooled)
                return real_iter(spooled)

            async def fake_ingest_wait(*_args, **_kwargs):
                in_ingest.set()
                await asyncio.sleep(5.0)

            fake_admin_ocr = SimpleNamespace(
                _ingest_validated_page_image=AsyncMock(side_effect=fake_ingest_wait)
            )
            try:
                with (
                    patch("app.services.storage_service.download_object_async", AsyncMock(return_value=pdf_bytes)),
                    patch.object(document_rasterizer_service.tempfile, "mkstemp", side_effect=spy_mkstemp),
                    patch.object(
                        document_rasterizer_service,
                        "iter_rasterized_spooled_document",
                        side_effect=spy_iter,
                    ),
                    patch("app.services.admin_ocr_service.AdminOcrService", return_value=fake_admin_ocr),
                ):
                    task = asyncio.create_task(
                        global_tasks_service._execute_batch_book_import_job(
                            MagicMock(),
                            fake_svc,
                            job,
                            uuid4(),
                            GpuWorkloadScheduler(),
                            MagicMock(),
                        )
                    )
                    await asyncio.wait_for(in_ingest.wait(), timeout=5.0)
                    task.cancel()
                    with self.assertRaises(asyncio.CancelledError):
                        await task

                self.assertEqual(len(observed_spooled), 1)
                self.assertTrue(observed_spooled[0].spool_file.closed)
                self.assertEqual(len(created_temp_pdfs), 1)
                self.assertEqual([p for p in created_temp_pdfs if p.exists()], [])
            finally:
                for p in created_temp_pdfs:
                    p.unlink(missing_ok=True)

        # Sub-case 3: mid-__enter__ asyncio.Task.cancel()
        with self.subTest(scenario="mid_enter_task_cancel"):
            job, book = _make_job_and_deps()
            fake_svc = SimpleNamespace(
                repo=SimpleNamespace(get_book=AsyncMock(return_value=book)),
                commit_stage_result=AsyncMock(),
            )
            real_mkstemp = tempfile.mkstemp
            created_temp_pdfs = []
            observed_spooled = []
            real_iter = iter_rasterized_spooled_document
            enter_started = threading.Event()
            allow_enter_finish = threading.Event()
            exit_calls = 0

            def spy_mkstemp(*args, **kwargs):
                fd, raw_path = real_mkstemp(*args, **kwargs)
                created_temp_pdfs.append(Path(raw_path))
                return fd, raw_path

            class _SlowEnterCtxWrapper:
                def __init__(self, inner_ctx):
                    self._inner = inner_ctx

                def __enter__(self):
                    res = self._inner.__enter__()
                    enter_started.set()
                    allow_enter_finish.wait(timeout=5.0)
                    return res

                def __exit__(self, exc_type, exc_val, exc_tb):
                    nonlocal exit_calls
                    exit_calls += 1
                    return self._inner.__exit__(exc_type, exc_val, exc_tb)

            def spy_iter(spooled: SpooledUploadDocument):
                observed_spooled.append(spooled)
                return _SlowEnterCtxWrapper(real_iter(spooled))

            fake_admin_ocr = SimpleNamespace(_ingest_validated_page_image=AsyncMock())
            try:
                with (
                    patch("app.services.storage_service.download_object_async", AsyncMock(return_value=pdf_bytes)),
                    patch.object(document_rasterizer_service.tempfile, "mkstemp", side_effect=spy_mkstemp),
                    patch.object(
                        document_rasterizer_service,
                        "iter_rasterized_spooled_document",
                        side_effect=spy_iter,
                    ),
                    patch("app.services.admin_ocr_service.AdminOcrService", return_value=fake_admin_ocr),
                ):
                    task = asyncio.create_task(
                        global_tasks_service._execute_batch_book_import_job(
                            MagicMock(),
                            fake_svc,
                            job,
                            uuid4(),
                            GpuWorkloadScheduler(),
                            MagicMock(),
                        )
                    )
                    deadline = time.monotonic() + 5.0
                    while not enter_started.is_set():
                        if time.monotonic() > deadline:
                            self.fail("Timed out waiting for ctx_mgr.__enter__ to start")
                        await asyncio.sleep(0.005)
                    task.cancel()
                    await asyncio.sleep(0.02)
                    allow_enter_finish.set()
                    with self.assertRaises(asyncio.CancelledError):
                        await task

                self.assertEqual(exit_calls, 1)
                self.assertEqual(len(observed_spooled), 1)
                self.assertTrue(observed_spooled[0].spool_file.closed)
                self.assertEqual(len(created_temp_pdfs), 1)
                self.assertEqual([p for p in created_temp_pdfs if p.exists()], [])
            finally:
                allow_enter_finish.set()
                for p in created_temp_pdfs:
                    p.unlink(missing_ok=True)

    def test_iter_rasterized_spooled_document_early_and_unstarted_exit_cleanup(self):
        from tempfile import SpooledTemporaryFile
        import hashlib
        import pypdfium2

        pdf_bytes = _pdf_bytes_3pages()
        tiff_bytes = _tiff_bytes_multipage(num_pages=3)

        def _make_spooled(raw: bytes, *, filename: str, content_type: str) -> SpooledUploadDocument:
            spool_file = SpooledTemporaryFile(max_size=2 * 1024 * 1024, mode="w+b")
            spool_file.write(raw)
            spool_file.seek(0)
            return SpooledUploadDocument(
                file_name=filename,
                content_type=content_type,
                byte_length=len(raw),
                source_sha256=hashlib.sha256(raw).hexdigest(),
                spool_file=spool_file,
                header_bytes=raw[:8192],
            )

        # 1. Real 3-page PDF broken out after 1 page
        with self.subTest(case="pdf_early_break_after_1_page"):
            real_mkstemp = tempfile.mkstemp
            created_temp_pdfs: list[Path] = []
            pdf_close_calls = 0
            orig_pdf_close = pypdfium2.PdfDocument.close

            def spy_mkstemp(*args, **kwargs):
                fd, raw_path = real_mkstemp(*args, **kwargs)
                created_temp_pdfs.append(Path(raw_path))
                return fd, raw_path

            def spy_pdf_close(self_pdf, *args, **kwargs):
                nonlocal pdf_close_calls
                pdf_close_calls += 1
                return orig_pdf_close(self_pdf, *args, **kwargs)

            spooled = _make_spooled(
                pdf_bytes, filename="three.pdf", content_type="application/pdf"
            )
            try:
                with (
                    patch.object(document_rasterizer_service.tempfile, "mkstemp", side_effect=spy_mkstemp),
                    patch.object(pypdfium2.PdfDocument, "close", spy_pdf_close),
                ):
                    with iter_rasterized_spooled_document(spooled) as (_fn, fmt, _sha, it):
                        self.assertEqual(fmt, "PDF")
                        seen = 0
                        for page in it:
                            seen += 1
                            self.assertEqual(page.source_page, 1)
                            break
                        self.assertEqual(seen, 1)
                self.assertGreaterEqual(pdf_close_calls, 1)
                self.assertEqual(len(created_temp_pdfs), 1)
                self.assertEqual([p for p in created_temp_pdfs if p.exists()], [])
            finally:
                spooled.close()
                for p in created_temp_pdfs:
                    p.unlink(missing_ok=True)

        # 2. Real 3-page PDF exited unstarted (0 next() calls)
        with self.subTest(case="pdf_unstarted_exit"):
            real_mkstemp = tempfile.mkstemp
            created_temp_pdfs = []

            def spy_mkstemp(*args, **kwargs):
                fd, raw_path = real_mkstemp(*args, **kwargs)
                created_temp_pdfs.append(Path(raw_path))
                return fd, raw_path

            spooled = _make_spooled(
                pdf_bytes, filename="three_unstarted.pdf", content_type="application/pdf"
            )
            try:
                with patch.object(document_rasterizer_service.tempfile, "mkstemp", side_effect=spy_mkstemp):
                    with iter_rasterized_spooled_document(spooled) as (_fn, fmt, _sha, it):
                        self.assertEqual(fmt, "PDF")
                        self.assertIsNotNone(it)
                self.assertEqual(len(created_temp_pdfs), 1)
                self.assertEqual([p for p in created_temp_pdfs if p.exists()], [])
            finally:
                spooled.close()
                for p in created_temp_pdfs:
                    p.unlink(missing_ok=True)

        # 3. Multi-frame TIFF early exit after 1 page
        with self.subTest(case="tiff_early_break_after_1_page"):
            spooled = _make_spooled(
                tiff_bytes, filename="three_frames.tiff", content_type="image/tiff"
            )
            inner_closed = False
            opened_images: list[Image.Image] = []
            real_iter_image_pages = document_rasterizer_service._iter_image_pages
            real_image_open = document_rasterizer_service.Image.open

            def spy_image_open(*args, **kwargs):
                img = real_image_open(*args, **kwargs)
                opened_images.append(img)
                return img

            def spy_iter_image_pages(*args, **kwargs):
                nonlocal inner_closed
                gen = real_iter_image_pages(*args, **kwargs)
                try:
                    yield from gen
                finally:
                    gen.close()
                    inner_closed = True

            try:
                with (
                    patch.object(document_rasterizer_service.Image, "open", side_effect=spy_image_open),
                    patch.object(
                        document_rasterizer_service,
                        "_iter_image_pages",
                        side_effect=spy_iter_image_pages,
                    ),
                ):
                    with iter_rasterized_spooled_document(spooled) as (_fn, fmt, _sha, it):
                        self.assertEqual(fmt, "TIFF")
                        for page in it:
                            self.assertEqual(page.source_page, 1)
                            break
                self.assertTrue(inner_closed)
                self.assertEqual(len(opened_images), 1)
                self.assertIsNone(getattr(opened_images[0], "fp", None))
            finally:
                spooled.close()

    def _make_batch_import_job_and_book(self):
        book_id = uuid4()
        job = SimpleNamespace(
            Id=uuid4(),
            BookId=book_id,
            ActorId=uuid4(),
            ActorRole="admin",
            CheckpointsJson={
                "source_storage_path": "imports/three_pages.pdf",
                "file_name": "three_pages.pdf",
                "content_type": "application/pdf",
            },
        )
        book = SimpleNamespace(
            Id=book_id,
            IsDeleted=False,
            BookScope="CATALOG",
            OwnerParentId=None,
        )
        return job, book

    async def test_batch_book_import_mode_a_mid_enter_real_copyfileobj_double_cancel(self):
        pdf_bytes = _pdf_bytes_3pages()
        job, book = self._make_batch_import_job_and_book()
        fake_svc = SimpleNamespace(
            repo=SimpleNamespace(get_book=AsyncMock(return_value=book)),
            commit_stage_result=AsyncMock(),
        )
        fake_admin_ocr = SimpleNamespace(_ingest_validated_page_image=AsyncMock())

        loop = asyncio.get_running_loop()
        orig_handler = loop.get_exception_handler()
        loop_exceptions: list[dict] = []

        def _capture_exception(_loop, context):
            loop_exceptions.append(context)

        real_mkstemp = tempfile.mkstemp
        created_temp_pdfs: list[Path] = []
        observed_spooled: list[SpooledUploadDocument] = []
        real_iter = iter_rasterized_spooled_document
        orig_copyfileobj = shutil.copyfileobj
        copy_started = asyncio.Event()
        allow_copy_finish = threading.Event()
        copy_errors: list[str] = []

        def spy_mkstemp(*args, **kwargs):
            fd, raw_path = real_mkstemp(*args, **kwargs)
            created_temp_pdfs.append(Path(raw_path))
            return fd, raw_path

        def spy_iter(spooled: SpooledUploadDocument):
            observed_spooled.append(spooled)
            return real_iter(spooled)

        def gated_copyfileobj(fsrc, fdst, *args, **kwargs):
            loop.call_soon_threadsafe(copy_started.set)
            allow_copy_finish.wait(timeout=5.0)
            try:
                return orig_copyfileobj(fsrc, fdst, *args, **kwargs)
            except Exception as exc:
                copy_errors.append(f"{type(exc).__name__}: {exc}")
                raise

        loop.set_exception_handler(_capture_exception)
        try:
            with (
                patch("app.services.storage_service.download_object_async", AsyncMock(return_value=pdf_bytes)),
                patch.object(document_rasterizer_service.tempfile, "mkstemp", side_effect=spy_mkstemp),
                patch.object(document_rasterizer_service.shutil, "copyfileobj", side_effect=gated_copyfileobj),
                patch.object(
                    document_rasterizer_service,
                    "iter_rasterized_spooled_document",
                    side_effect=spy_iter,
                ),
                patch("app.services.admin_ocr_service.AdminOcrService", return_value=fake_admin_ocr),
            ):
                task = asyncio.create_task(
                    global_tasks_service._execute_batch_book_import_job(
                        MagicMock(),
                        fake_svc,
                        job,
                        uuid4(),
                        GpuWorkloadScheduler(),
                        MagicMock(),
                    )
                )
                await asyncio.wait_for(copy_started.wait(), timeout=5.0)
                task.cancel()
                await asyncio.sleep(0.01)
                task.cancel()
                await asyncio.sleep(0.01)

                self.assertFalse(task.done())
                self.assertEqual(len(observed_spooled), 1)
                self.assertFalse(observed_spooled[0].spool_file.closed)

                allow_copy_finish.set()
                with self.assertRaises(asyncio.CancelledError):
                    await task

            gc.collect()
            await asyncio.sleep(0)
            self.assertEqual(copy_errors, [])
            self.assertTrue(observed_spooled[0].spool_file.closed)
            self.assertEqual(len(created_temp_pdfs), 1)
            self.assertEqual([p for p in created_temp_pdfs if p.exists()], [])
            self.assertEqual(loop_exceptions, [])
        finally:
            allow_copy_finish.set()
            loop.set_exception_handler(orig_handler)
            for p in created_temp_pdfs:
                p.unlink(missing_ok=True)

    async def test_batch_book_import_mode_a_mid_close_and_exit_double_cancel(self):
        pdf_bytes = _pdf_bytes_3pages()
        job, book = self._make_batch_import_job_and_book()
        fake_svc = SimpleNamespace(
            repo=SimpleNamespace(get_book=AsyncMock(return_value=book)),
            commit_stage_result=AsyncMock(),
        )

        loop = asyncio.get_running_loop()
        orig_handler = loop.get_exception_handler()
        loop_exceptions: list[dict] = []

        def _capture_exception(_loop, context):
            loop_exceptions.append(context)

        real_mkstemp = tempfile.mkstemp
        created_temp_pdfs: list[Path] = []
        observed_spooled: list[SpooledUploadDocument] = []
        real_iter = iter_rasterized_spooled_document
        in_ingest = asyncio.Event()
        exit_started = asyncio.Event()
        allow_exit_finish = threading.Event()
        spooled_closed_during_exit: list[bool] = []
        exit_finished = False

        def spy_mkstemp(*args, **kwargs):
            fd, raw_path = real_mkstemp(*args, **kwargs)
            created_temp_pdfs.append(Path(raw_path))
            return fd, raw_path

        class _SlowExitCtxWrapper:
            def __init__(self, inner_ctx):
                self._inner = inner_ctx

            def __enter__(self):
                return self._inner.__enter__()

            def __exit__(self, exc_type, exc_val, exc_tb):
                nonlocal exit_finished
                loop.call_soon_threadsafe(exit_started.set)
                allow_exit_finish.wait(timeout=5.0)
                spooled_closed_during_exit.append(observed_spooled[0].spool_file.closed)
                res = self._inner.__exit__(exc_type, exc_val, exc_tb)
                exit_finished = True
                return res

        def spy_iter(spooled: SpooledUploadDocument):
            observed_spooled.append(spooled)
            return _SlowExitCtxWrapper(real_iter(spooled))

        async def fake_ingest_wait(*_args, **_kwargs):
            in_ingest.set()
            await asyncio.sleep(5.0)

        fake_admin_ocr = SimpleNamespace(
            _ingest_validated_page_image=AsyncMock(side_effect=fake_ingest_wait)
        )

        loop.set_exception_handler(_capture_exception)
        try:
            with (
                patch("app.services.storage_service.download_object_async", AsyncMock(return_value=pdf_bytes)),
                patch.object(document_rasterizer_service.tempfile, "mkstemp", side_effect=spy_mkstemp),
                patch.object(
                    document_rasterizer_service,
                    "iter_rasterized_spooled_document",
                    side_effect=spy_iter,
                ),
                patch("app.services.admin_ocr_service.AdminOcrService", return_value=fake_admin_ocr),
            ):
                task = asyncio.create_task(
                    global_tasks_service._execute_batch_book_import_job(
                        MagicMock(),
                        fake_svc,
                        job,
                        uuid4(),
                        GpuWorkloadScheduler(),
                        MagicMock(),
                    )
                )
                await asyncio.wait_for(in_ingest.wait(), timeout=5.0)
                task.cancel()
                await asyncio.wait_for(exit_started.wait(), timeout=5.0)
                task.cancel()
                await asyncio.sleep(0.01)
                task.cancel()
                await asyncio.sleep(0.01)

                self.assertFalse(task.done())
                self.assertEqual(len(observed_spooled), 1)
                self.assertFalse(observed_spooled[0].spool_file.closed)

                allow_exit_finish.set()
                with self.assertRaises(asyncio.CancelledError):
                    await task

            gc.collect()
            await asyncio.sleep(0)
            self.assertTrue(exit_finished)
            self.assertEqual(spooled_closed_during_exit, [False])
            self.assertTrue(observed_spooled[0].spool_file.closed)
            self.assertEqual(len(created_temp_pdfs), 1)
            self.assertEqual([p for p in created_temp_pdfs if p.exists()], [])
            self.assertEqual(loop_exceptions, [])
        finally:
            allow_exit_finish.set()
            loop.set_exception_handler(orig_handler)
            for p in created_temp_pdfs:
                p.unlink(missing_ok=True)

    async def test_batch_book_import_mode_a_mid_enter_exception_plus_double_cancel(self):
        pdf_bytes = _pdf_bytes_3pages()
        job, book = self._make_batch_import_job_and_book()
        fake_svc = SimpleNamespace(
            repo=SimpleNamespace(get_book=AsyncMock(return_value=book)),
            commit_stage_result=AsyncMock(),
        )
        fake_admin_ocr = SimpleNamespace(_ingest_validated_page_image=AsyncMock())

        loop = asyncio.get_running_loop()
        orig_handler = loop.get_exception_handler()
        loop_exceptions: list[dict] = []

        def _capture_exception(_loop, context):
            loop_exceptions.append(context)

        real_mkstemp = tempfile.mkstemp
        created_temp_pdfs: list[Path] = []
        observed_spooled: list[SpooledUploadDocument] = []
        enter_started = asyncio.Event()
        allow_enter_finish = threading.Event()

        def spy_mkstemp(*args, **kwargs):
            fd, raw_path = real_mkstemp(*args, **kwargs)
            created_temp_pdfs.append(Path(raw_path))
            return fd, raw_path

        class _FailingEnterCtx:
            def __enter__(self):
                loop.call_soon_threadsafe(enter_started.set)
                allow_enter_finish.wait(timeout=5.0)
                raise HTTPException(status_code=422, detail="corrupt")

            def __exit__(self, exc_type, exc_val, exc_tb):
                return False

        def spy_iter(spooled: SpooledUploadDocument):
            observed_spooled.append(spooled)
            return _FailingEnterCtx()

        loop.set_exception_handler(_capture_exception)
        try:
            with (
                patch("app.services.storage_service.download_object_async", AsyncMock(return_value=pdf_bytes)),
                patch.object(document_rasterizer_service.tempfile, "mkstemp", side_effect=spy_mkstemp),
                patch.object(
                    document_rasterizer_service,
                    "iter_rasterized_spooled_document",
                    side_effect=spy_iter,
                ),
                patch("app.services.admin_ocr_service.AdminOcrService", return_value=fake_admin_ocr),
            ):
                task = asyncio.create_task(
                    global_tasks_service._execute_batch_book_import_job(
                        MagicMock(),
                        fake_svc,
                        job,
                        uuid4(),
                        GpuWorkloadScheduler(),
                        MagicMock(),
                    )
                )
                await asyncio.wait_for(enter_started.wait(), timeout=5.0)
                task.cancel()
                await asyncio.sleep(0.01)
                task.cancel()
                await asyncio.sleep(0.01)
                allow_enter_finish.set()
                with self.assertRaises(asyncio.CancelledError):
                    await task

            gc.collect()
            await asyncio.sleep(0)
            self.assertEqual(len(observed_spooled), 1)
            self.assertTrue(observed_spooled[0].spool_file.closed)
            self.assertEqual([p for p in created_temp_pdfs if p.exists()], [])
            self.assertEqual(loop_exceptions, [])
        finally:
            allow_enter_finish.set()
            loop.set_exception_handler(orig_handler)
            for p in created_temp_pdfs:
                p.unlink(missing_ok=True)

    async def test_batch_book_import_mode_a_mid_next_page_cancel_serializes_exit(self):
        pdf_bytes = _pdf_bytes_3pages()
        job, book = self._make_batch_import_job_and_book()
        fake_svc = SimpleNamespace(
            repo=SimpleNamespace(get_book=AsyncMock(return_value=book)),
            commit_stage_result=AsyncMock(),
        )
        fake_admin_ocr = SimpleNamespace(
            _ingest_validated_page_image=AsyncMock(
                return_value=(1, SimpleNamespace(page_id=uuid4()))
            )
        )

        loop = asyncio.get_running_loop()
        orig_handler = loop.get_exception_handler()
        loop_exceptions: list[dict] = []

        def _capture_exception(_loop, context):
            loop_exceptions.append(context)

        real_mkstemp = tempfile.mkstemp
        created_temp_pdfs: list[Path] = []
        observed_spooled: list[SpooledUploadDocument] = []
        real_iter = iter_rasterized_spooled_document
        real_iter_pdf_pages = document_rasterizer_service._iter_pdf_pages
        next_started = asyncio.Event()
        allow_next_finish = threading.Event()
        next_finished = False
        next_finished_before_exit = False
        exit_calls = 0

        def spy_mkstemp(*args, **kwargs):
            fd, raw_path = real_mkstemp(*args, **kwargs)
            created_temp_pdfs.append(Path(raw_path))
            return fd, raw_path

        class _GatedPageIter:
            def __init__(self, inner):
                self._inner = inner

            def __iter__(self):
                return self

            def __next__(self):
                nonlocal next_finished
                loop.call_soon_threadsafe(next_started.set)
                allow_next_finish.wait(timeout=5.0)
                try:
                    return next(self._inner)
                finally:
                    next_finished = True

            def close(self):
                close_fn = getattr(self._inner, "close", None)
                if callable(close_fn):
                    close_fn()

        def spy_iter_pdf_pages(temp_pdf_path):
            return _GatedPageIter(real_iter_pdf_pages(temp_pdf_path))

        class _TrackingExitCtxWrapper:
            def __init__(self, inner_ctx):
                self._inner = inner_ctx

            def __enter__(self):
                return self._inner.__enter__()

            def __exit__(self, exc_type, exc_val, exc_tb):
                nonlocal exit_calls, next_finished_before_exit
                exit_calls += 1
                next_finished_before_exit = next_finished
                return self._inner.__exit__(exc_type, exc_val, exc_tb)

        def spy_iter(spooled: SpooledUploadDocument):
            observed_spooled.append(spooled)
            return _TrackingExitCtxWrapper(real_iter(spooled))

        loop.set_exception_handler(_capture_exception)
        try:
            with (
                patch("app.services.storage_service.download_object_async", AsyncMock(return_value=pdf_bytes)),
                patch.object(document_rasterizer_service.tempfile, "mkstemp", side_effect=spy_mkstemp),
                patch.object(
                    document_rasterizer_service,
                    "_iter_pdf_pages",
                    side_effect=spy_iter_pdf_pages,
                ),
                patch.object(
                    document_rasterizer_service,
                    "iter_rasterized_spooled_document",
                    side_effect=spy_iter,
                ),
                patch("app.services.admin_ocr_service.AdminOcrService", return_value=fake_admin_ocr),
            ):
                task = asyncio.create_task(
                    global_tasks_service._execute_batch_book_import_job(
                        MagicMock(),
                        fake_svc,
                        job,
                        uuid4(),
                        GpuWorkloadScheduler(),
                        MagicMock(),
                    )
                )
                await asyncio.wait_for(next_started.wait(), timeout=5.0)
                task.cancel()
                await asyncio.sleep(0.02)

                self.assertEqual(exit_calls, 0)
                self.assertFalse(task.done())

                allow_next_finish.set()
                with self.assertRaises(asyncio.CancelledError):
                    await task

            gc.collect()
            await asyncio.sleep(0)
            self.assertTrue(next_finished_before_exit)
            self.assertEqual(exit_calls, 1)
            self.assertEqual(len(observed_spooled), 1)
            self.assertTrue(observed_spooled[0].spool_file.closed)
            self.assertEqual(len(created_temp_pdfs), 1)
            self.assertEqual([p for p in created_temp_pdfs if p.exists()], [])
            self.assertEqual(loop_exceptions, [])
        finally:
            allow_next_finish.set()
            loop.set_exception_handler(orig_handler)
            for p in created_temp_pdfs:
                p.unlink(missing_ok=True)


class TtsAudioCacheAsyncHygieneTests(unittest.IsolatedAsyncioTestCase):
    def _make_tts_service(self, entry_path: str):
        entry = SimpleNamespace(
            Id=uuid4(),
            ByteSize=42,
            StorageBucket="tts-cache",
            StoragePath=entry_path,
            AudioFormat="audio/mpeg",
            VoiceId="local_north_truc_ly",
            ModelVersion="v1",
            DurationSeconds=1.2,
            WordTimingsJson=None,
            Scope="PRIVATE",
            Speed=1.0,
            NormalizedText="xin chào",
        )
        svc = TtsAudioCacheService(None)
        fake_db = MagicMock()
        fake_db.commit = AsyncMock()
        fake_db.rollback = AsyncMock()
        fake_repo = MagicMock()
        fake_repo.get_daily_usage = AsyncMock(
            return_value={"bytes_served": 0, "hit_count": 0, "miss_count": 0}
        )
        fake_repo.get_active_entry = AsyncMock(return_value=entry)
        fake_repo.record_hit = AsyncMock()
        fake_repo.record_miss = AsyncMock()
        svc.db = fake_db
        svc.repo = fake_repo
        target = ResolvedCacheTarget(
            scope="PRIVATE",
            owner_parent_id=uuid4(),
            book_id=uuid4(),
            page_id=uuid4(),
            page_revision_id=None,
            can_store_on_miss=True,
        )
        return svc, target

    async def test_lookup_cached_audio_awaits_download_object_async_when_unpatched(self):
        entry_path = f"private-books/{uuid4()}/tts-cache/unpatched.mp3"
        svc, target = self._make_tts_service(entry_path)
        mp3_bytes = b"ID3\x03\x00\x00\x00\x00\x00\x00" + (b"\x11" * 24)
        async_dl = AsyncMock(return_value=mp3_bytes)

        with (
            patch.object(tts_audio_cache_service, "is_local_storage_enabled", return_value=False),
            patch.object(tts_audio_cache_service, "download_object_async", async_dl),
        ):
            hit = await svc.lookup_cached_audio(
                target=target,
                normalized_text="xin chào",
                voice_id="local_north_truc_ly",
            )

        self.assertIsNotNone(hit)
        assert hit is not None
        self.assertEqual(hit.content, mp3_bytes)
        async_dl.assert_awaited_once_with(entry_path, bucket_name="tts-cache")

    async def test_lookup_cached_audio_offloads_patched_download_object_to_thread(self):
        loop_thread_id = threading.get_ident()
        observed_threads: list[int] = []
        entry_path = f"private-books/{uuid4()}/tts-cache/patched.mp3"
        svc, target = self._make_tts_service(entry_path)
        mp3_bytes = b"ID3\x03\x00\x00\x00\x00\x00\x00" + (b"\x22" * 24)
        gate = _LoopHeartbeatGate(ticks_per_checkpoint=3)

        def fake_sync_download(path, bucket_name=None):
            observed_threads.append(threading.get_ident())
            gate.wait_for_ticks()
            return mp3_bytes

        with patch.object(tts_audio_cache_service, "download_object", side_effect=fake_sync_download):
            hit, ticks = await _run_with_heartbeat(
                svc.lookup_cached_audio(
                    target=target,
                    normalized_text="xin chào",
                    voice_id="local_north_truc_ly",
                ),
                gate=gate,
                min_checkpoints=1,
            )

        self.assertIsNotNone(hit)
        assert hit is not None
        self.assertEqual(hit.content, mp3_bytes)
        self.assertEqual(len(observed_threads), 1)
        self.assertNotEqual(observed_threads[0], loop_thread_id)
        self.assertGreaterEqual(ticks, 3)


if __name__ == "__main__":
    unittest.main()
