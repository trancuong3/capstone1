from __future__ import annotations

import asyncio
import hashlib
import json
import os
import sys
import threading
import time
import unittest
from pathlib import Path
from typing import Any
from unittest.mock import AsyncMock, MagicMock, patch

import httpx
from fastapi import FastAPI, HTTPException
from fastapi.responses import StreamingResponse

BACKEND_DIR = Path(__file__).resolve().parent
REPO_ROOT = BACKEND_DIR.parent
for p in (str(BACKEND_DIR), str(REPO_ROOT)):
    if p not in sys.path:
        sys.path.insert(0, p)

from app.api.deps import get_db
from app.api.routes.internal_ocr import (
    download_active_ocr_model_shard,
    router as internal_ocr_router,
)
from app.services.ocr_inference_job_service import (
    OcrInferenceJobService,
    clear_active_model_manifest_cache,
    trigger_remote_ocr_model_reload_wakeup,
)
from app.services.training_storage.base import (
    ArtifactMetadata,
    DriveNotConnectedError,
    DriveTransientError,
)
from app.services.training_storage.references import StorageProvider


class _FakeAsyncReadSession:
    """Tracks read-transaction lifecycle to assert DB txn release before Drive I/O."""

    def __init__(self, events: list[str]) -> None:
        self._events = events
        self._in_tx = False
        self.new: set[Any] = set()
        self.dirty: set[Any] = set()
        self.deleted: set[Any] = set()
        self.rollback_calls = 0

    def in_transaction(self) -> bool:
        return self._in_tx

    def mark_tx_started(self) -> None:
        self._in_tx = True

    async def rollback(self) -> None:
        self.rollback_calls += 1
        self._in_tx = False
        self._events.append("db_rollback")


class TestInternalOcrActiveModelStreaming(unittest.TestCase):
    def setUp(self) -> None:
        clear_active_model_manifest_cache()

    def tearDown(self) -> None:
        clear_active_model_manifest_cache()

    def test_active_model_shard_streams_gdrive_via_streaming_response_and_releases_db_txn_first(
        self,
    ) -> None:
        events: list[str] = []
        db = _FakeAsyncReadSession(events)

        chunk_parts = [b"chunk-0-alpha-", b"chunk-1-beta-", b"chunk-2-gamma"]
        full_shard = b"".join(chunk_parts)
        shard_sha = hashlib.sha256(full_shard).hexdigest()
        manifest_bytes = json.dumps(
            {
                "checkpoint_sha256": "a" * 64,
                "chunks": [
                    {
                        "index": 0,
                        "path": "gdrive://shard_file_0",
                        "sha256": shard_sha,
                        "bytes": len(full_shard),
                    }
                ],
            }
        ).encode("utf-8")

        class _FakeDriveRouter:
            def __init__(self) -> None:
                self.get_refs: list[str] = []
                self.stream_calls: list[tuple[str, str | None]] = []

            def get(self, reference: str, **_kwargs: Any) -> bytes:
                # DB transaction MUST already be released before any Drive network call!
                assert not db.in_transaction(), "DB transaction still active during Drive get()"
                events.append(f"drive_get:{reference}")
                self.get_refs.append(reference)
                if reference == "gdrive://manifest_file_1":
                    return manifest_bytes
                raise AssertionError(f"Shard must be streamed, not buffered via get(): {reference}")

            def open_stream_with_metadata(
                self,
                reference: str,
                *,
                chunk_size: int = 1024 * 1024,
                expected_sha256: str | None = None,
            ):
                del chunk_size
                assert not db.in_transaction(), "DB transaction still active during Drive stream open"
                events.append(f"drive_open_stream:{reference}")
                self.stream_calls.append((reference, expected_sha256))
                meta = ArtifactMetadata(
                    provider=StorageProvider.GOOGLE_DRIVE,
                    reference=reference,
                    name="shard_0.part",
                    size_bytes=len(full_shard),
                    sha256=shard_sha,
                    content_type="application/octet-stream",
                    trashed=False,
                )

                def _iter_chunks():
                    for idx, part in enumerate(chunk_parts):
                        assert not db.in_transaction(), "DB transaction active while yielding shard"
                        events.append(f"yield_chunk_{idx}")
                        yield part

                return meta, _iter_chunks()

        fake_router = _FakeDriveRouter()

        class _FakeDriveConnectionService:
            def __init__(self, passed_db: Any) -> None:
                assert passed_db is db

            async def build_artifact_router(self) -> _FakeDriveRouter:
                events.append("build_artifact_router")
                db.mark_tx_started()
                return fake_router

        async def _fake_pointer() -> dict[str, Any]:
            events.append("get_active_model_pointer")
            db.mark_tx_started()
            return {
                "profile": "FLOW2_ADMIN_VERIFIED",
                "checkpoint_sha256": "a" * 64,
                "storage_path": "gdrive://manifest_file_1",
            }

        async def _scenario() -> None:
            app = FastAPI()
            app.include_router(internal_ocr_router, prefix="/internal/ocr-jobs")
            app.dependency_overrides[get_db] = lambda: db

            token = "s" * 40
            with (
                patch.dict(os.environ, {"VIREAD_OCR_WORKER_TOKEN": token}, clear=False),
                patch(
                    "app.repositories.ocr_inference_job_repository.OcrInferenceJobRepository.get_active_model_pointer",
                    side_effect=_fake_pointer,
                ),
                patch(
                    "app.services.viread_drive_connection_service.VireadDriveConnectionService",
                    _FakeDriveConnectionService,
                ),
                patch(
                    "app.services.training_storage.router.get_runtime_artifact_router",
                    side_effect=AssertionError("Must not fall back to PostgREST runtime router"),
                ),
            ):
                # 1. Direct async route call returns StreamingResponse
                direct_resp = await download_active_ocr_model_shard(
                    shard_index=0,
                    _="ocr_worker",
                    db=db,
                )
                self.assertIsInstance(direct_resp, StreamingResponse)

                # 2. Full ASGI HTTP streaming delivery
                events.clear()
                transport = httpx.ASGITransport(app=app)
                async with httpx.AsyncClient(transport=transport, base_url="http://test") as client:
                    resp = await client.get(
                        "/internal/ocr-jobs/active-model/shard/0",
                        headers={"X-ViRead-Ocr-Worker-Token": token},
                    )
                self.assertEqual(resp.status_code, 200)
                self.assertEqual(resp.content, full_shard)
                self.assertEqual(resp.headers.get("x-content-sha256"), shard_sha)
                self.assertEqual(resp.headers.get("content-length"), str(len(full_shard)))
                self.assertEqual(resp.headers.get("cache-control"), "no-store")
                self.assertEqual(resp.headers.get("x-content-type-options"), "nosniff")

                # Verify strict ordering: DB pointer + router build -> db_rollback -> Drive I/O -> chunks
                self.assertEqual(
                    events,
                    [
                        "get_active_model_pointer",
                        "build_artifact_router",
                        "db_rollback",
                        "drive_get:gdrive://manifest_file_1",
                        "drive_open_stream:gdrive://shard_file_0",
                        "yield_chunk_0",
                        "yield_chunk_1",
                        "yield_chunk_2",
                    ],
                )
                # Manifest used get(), shard NEVER used get() (only open_stream_with_metadata)
                self.assertEqual(fake_router.get_refs, ["gdrive://manifest_file_1", "gdrive://manifest_file_1"])
                self.assertEqual(
                    fake_router.stream_calls[-1],
                    ("gdrive://shard_file_0", shard_sha),
                )

        asyncio.run(_scenario())

    def test_active_model_shard_preserves_legacy_supabase_path_and_checks_sha(self) -> None:
        events: list[str] = []
        db = _FakeAsyncReadSession(events)
        shard_bytes = b"legacy-supabase-shard-bytes"
        shard_sha = hashlib.sha256(shard_bytes).hexdigest()
        manifest_bytes = json.dumps(
            {
                "checkpoint_sha256": "b" * 64,
                "chunks": [
                    {
                        "index": 0,
                        "path": "models/v2/shard-0.bin",
                        "sha256": shard_sha,
                        "bytes": len(shard_bytes),
                    }
                ],
            }
        ).encode("utf-8")

        def _fake_download(ref: str) -> bytes:
            assert not db.in_transaction(), "DB txn must be released before storage download"
            if ref == "models/v2/manifest.json":
                return manifest_bytes
            if ref == "models/v2/shard-0.bin":
                return shard_bytes
            raise AssertionError(f"Unexpected ref {ref}")

        async def _scenario() -> None:
            svc = OcrInferenceJobService(db)
            svc.repo.get_active_model_pointer = AsyncMock(
                return_value={
                    "profile": "FLOW1_EXTERNAL_TRDG",
                    "checkpoint_sha256": "b" * 64,
                    "storage_path": "models/v2/manifest.json",
                }
            )
            with (
                patch(
                    "app.services.viread_drive_connection_service.VireadDriveConnectionService",
                    side_effect=AssertionError("Legacy non-Drive path must not query Drive service"),
                ),
                patch("app.services.storage_service.download_object", side_effect=_fake_download),
            ):
                chunk_iter, media_type, headers = await svc.open_active_model_artifact_stream(
                    kind="shard", shard_index=0
                )
                self.assertEqual(media_type, "application/octet-stream")
                self.assertEqual(b"".join(chunk_iter), shard_bytes)
                self.assertEqual(headers["X-Content-Sha256"], shard_sha)
                self.assertEqual(headers["Content-Length"], str(len(shard_bytes)))

            # Corrupted legacy shard -> 502 Bad Gateway
            with patch(
                "app.services.storage_service.download_object",
                side_effect=lambda ref: manifest_bytes if "manifest" in ref else b"corrupted",
            ):
                with self.assertRaises(HTTPException) as ctx:
                    await svc.open_active_model_artifact_stream(kind="shard", shard_index=0)
                self.assertEqual(ctx.exception.status_code, 502)

        asyncio.run(_scenario())

    def test_get_active_model_manifest_releases_txn_and_surfaces_503_on_drive_error(
        self,
    ) -> None:
        events: list[str] = []
        db = _FakeAsyncReadSession(events)
        manifest_bytes = json.dumps(
            {
                "checkpoint_sha256": "c" * 64,
                "config": {"storage_path": "gdrive://cfg_file_1", "sha256": "d" * 64},
                "chunks": [
                    {
                        "index": 0,
                        "path": "gdrive://shard_file_0",
                        "sha256": "e" * 64,
                        "bytes": 40_000_000,
                    }
                ],
            }
        ).encode("utf-8")

        should_fail = True

        class _ToggleDriveRouter:
            def get(self, reference: str, **_kwargs: Any) -> bytes:
                assert not db.in_transaction(), "DB txn must be released before Drive manifest get()"
                events.append(f"drive_get:{reference}")
                if should_fail:
                    raise DriveNotConnectedError("Google Drive disconnected")
                return manifest_bytes

        class _FakeDriveService:
            def __init__(self, _db: Any) -> None:
                pass

            async def build_artifact_router(self) -> _ToggleDriveRouter:
                events.append("build_artifact_router")
                db.mark_tx_started()
                return _ToggleDriveRouter()

        async def _fake_pointer() -> dict[str, Any]:
            events.append("get_active_model_pointer")
            db.mark_tx_started()
            return {
                "profile": "FLOW2_ADMIN_VERIFIED",
                "checkpoint_sha256": "c" * 64,
                "storage_path": "gdrive://manifest_file_c",
            }

        async def _scenario() -> None:
            nonlocal should_fail
            svc = OcrInferenceJobService(db)
            svc.repo.get_active_model_pointer = _fake_pointer

            with (
                patch(
                    "app.services.viread_drive_connection_service.VireadDriveConnectionService",
                    _FakeDriveService,
                ),
                patch(
                    "app.services.training_storage.router.get_runtime_artifact_router",
                    side_effect=AssertionError("Must not call PostgREST runtime router"),
                ),
            ):
                # 1. Drive failure MUST raise HTTP 503 (never silently return shards: [])
                with self.assertRaises(HTTPException) as ctx:
                    await svc.get_active_model_manifest()
                self.assertEqual(ctx.exception.status_code, 503)
                self.assertIn("DRIVE_NOT_CONNECTED", str(ctx.exception.detail))
                self.assertEqual(
                    events,
                    [
                        "get_active_model_pointer",
                        "build_artifact_router",
                        "db_rollback",
                        "drive_get:gdrive://manifest_file_c",
                    ],
                )

                # 2. Drive recovery succeeds, caches manifest, and keeps signed_url=None for gdrive://
                should_fail = False
                events.clear()
                m1 = await svc.get_active_model_manifest()
                self.assertEqual(m1["shard_count"], 1)
                self.assertEqual(len(m1["shards"]), 1)
                self.assertIsNone(m1["shards"][0]["signed_url"])
                self.assertIsNone(m1["config_signed_url"])
                self.assertTrue(m1["has_custom_config"])
                self.assertEqual(
                    events,
                    [
                        "get_active_model_pointer",
                        "build_artifact_router",
                        "db_rollback",
                        "drive_get:gdrive://manifest_file_c",
                    ],
                )

                # 3. Cache hit skips Drive router build & Drive get()
                events.clear()
                m2 = await svc.get_active_model_manifest()
                self.assertEqual(m2["shards"], m1["shards"])
                self.assertEqual(events, ["get_active_model_pointer", "db_rollback"])

                # 4. clear_active_model_manifest_cache() forces fresh Drive fetch
                clear_active_model_manifest_cache()
                events.clear()
                m3 = await svc.get_active_model_manifest()
                self.assertEqual(m3["shard_count"], 1)
                self.assertIn("drive_get:gdrive://manifest_file_c", events)

        asyncio.run(_scenario())

    def test_shard_stream_maps_drive_errors_and_trashed_files_cleanly(self) -> None:
        events: list[str] = []
        db = _FakeAsyncReadSession(events)
        manifest_bytes = json.dumps(
            {
                "checkpoint_sha256": "f" * 64,
                "chunks": [{"index": 0, "path": "gdrive://shard_trashed", "sha256": "1" * 64}],
            }
        ).encode("utf-8")

        class _TrashedRouter:
            def get(self, _ref: str, **_kwargs: Any) -> bytes:
                return manifest_bytes

            def open_stream_with_metadata(self, ref: str, **_kwargs: Any):
                return (
                    ArtifactMetadata(
                        provider=StorageProvider.GOOGLE_DRIVE,
                        reference=ref,
                        name="shard.part",
                        size_bytes=10,
                        sha256="1" * 64,
                        content_type="application/octet-stream",
                        trashed=True,
                    ),
                    iter(()),
                )

        class _TransientFailRouter:
            def get(self, _ref: str, **_kwargs: Any) -> bytes:
                return manifest_bytes

            def open_stream_with_metadata(self, _ref: str, **_kwargs: Any):
                raise DriveTransientError("Temporary Apps Script timeout")

        async def _scenario() -> None:
            svc = OcrInferenceJobService(db)
            svc.repo.get_active_model_pointer = AsyncMock(
                return_value={"storage_path": "gdrive://manifest_x"}
            )
            with patch.object(svc, "_build_drive_artifact_router", AsyncMock(return_value=_TrashedRouter())):
                with self.assertRaises(HTTPException) as trashed_ctx:
                    await svc.open_active_model_artifact_stream(kind="shard", shard_index=0)
                self.assertEqual(trashed_ctx.exception.status_code, 404)

                with self.assertRaises(HTTPException) as oob_ctx:
                    await svc.open_active_model_artifact_stream(kind="shard", shard_index=3)
                self.assertEqual(oob_ctx.exception.status_code, 404)

            with patch.object(
                svc, "_build_drive_artifact_router", AsyncMock(return_value=_TransientFailRouter())
            ):
                with self.assertRaises(HTTPException) as err_ctx:
                    await svc.open_active_model_artifact_stream(kind="shard", shard_index=0)
                self.assertEqual(err_ctx.exception.status_code, 503)

        asyncio.run(_scenario())

    def test_trigger_remote_ocr_model_reload_wakeup_clears_caches_and_sends_wakeup(self) -> None:
        from app.services import ocr_inference_job_service as job_svc_mod
        from app.services import remote_ocr_wakeup

        seen_requests: list[tuple[str, str, dict[str, Any]]] = []

        def _transport_handler(request: httpx.Request) -> httpx.Response:
            body = json.loads(request.content.decode("utf-8")) if request.content else {}
            seen_requests.append((request.method, str(request.url), body))
            return httpx.Response(200, json={"ok": True, "woken": True})

        async def _scenario() -> None:
            remote_ocr_wakeup.clear_remote_ocr_wakeup_cache_for_tests()
            remote_ocr_wakeup.set_remote_ocr_wakeup_transport_for_tests(
                httpx.MockTransport(_transport_handler)
            )
            try:
                # Populate both caches first
                job_svc_mod._ACTIVE_MODEL_MANIFEST_CACHE = (
                    time.monotonic() + 600.0,
                    ("OLD", "0" * 64, "gdrive://old"),
                    {"shards": []},
                )
                remote_ocr_wakeup._HEALTH_CACHE = (
                    time.monotonic() + 60.0,
                    "https://ocr-worker.example",
                    {"model_sha256": "0" * 64},
                    False,
                )

                with patch.dict(
                    os.environ,
                    {
                        "VIREAD_OCR_REMOTE_WORKER_URL": "https://ocr-worker.example",
                        "VIREAD_OCR_WORKER_TOKEN": "w" * 40,
                        "VIREAD_OCR_REMOTE_SCALE_TO_ZERO": "false",
                    },
                    clear=False,
                ):
                    task = trigger_remote_ocr_model_reload_wakeup(reason="active_model_promoted")
                    self.assertIsNotNone(task)
                    self.assertIsNone(job_svc_mod._ACTIVE_MODEL_MANIFEST_CACHE)
                    self.assertIsNone(remote_ocr_wakeup._HEALTH_CACHE)
                    assert task is not None
                    ok = await task
                    self.assertTrue(ok)
                    self.assertEqual(len(seen_requests), 1)
                    self.assertEqual(seen_requests[0][0], "POST")
                    self.assertEqual(seen_requests[0][1], "https://ocr-worker.example/wakeup")
                    self.assertEqual(seen_requests[0][2], {"reason": "active_model_promoted"})

                # When unconfigured, no-ops cleanly and still clears manifest cache
                job_svc_mod._ACTIVE_MODEL_MANIFEST_CACHE = (
                    time.monotonic() + 600.0,
                    ("OLD", "0" * 64, "gdrive://old"),
                    {"shards": []},
                )
                with patch.dict(
                    os.environ,
                    {
                        "VIREAD_OCR_REMOTE_WORKER_URL": "",
                        "VIREAD_HF_OCR_SPACE_URL": "",
                    },
                    clear=False,
                ):
                    none_task = trigger_remote_ocr_model_reload_wakeup()
                    self.assertIsNone(none_task)
                    self.assertIsNone(job_svc_mod._ACTIVE_MODEL_MANIFEST_CACHE)
            finally:
                remote_ocr_wakeup.set_remote_ocr_wakeup_transport_for_tests(None)
                remote_ocr_wakeup.clear_remote_ocr_wakeup_cache_for_tests()

        asyncio.run(_scenario())

    def test_ocr_worker_forced_resync_on_wakeup_and_before_mismatched_job(self) -> None:
        from ocr_worker.service import OcrRuntimeManager
        from ocr_worker.worker import (
            BackendOcrClient,
            drain_queue_synchronously,
            process_claimed_job,
        )

        old_sha = "1" * 64
        new_sha = "2" * 64
        img_bytes = b"sample-page-bytes"
        img_sha = hashlib.sha256(img_bytes).hexdigest()
        token = "t" * 40

        # 1. maybe_resync_active_model respects min_interval_seconds unless force=True
        rt = OcrRuntimeManager(worker_id="w-resync-unit")
        with rt._state_lock:
            rt._model_profile = "FLOW1_EXTERNAL_TRDG"
            rt._model_sha256 = old_sha

        manifest_calls = 0

        def _fetch_same_manifest() -> dict[str, Any]:
            nonlocal manifest_calls
            manifest_calls += 1
            return {"profile": "FLOW1_EXTERNAL_TRDG", "checkpoint_sha256": old_sha}

        # Initial check records timestamp
        self.assertFalse(
            rt.maybe_resync_active_model(
                manifest_fetcher=_fetch_same_manifest,
                artifact_fetcher=lambda _k, _i: b"",
                min_interval_seconds=120.0,
            )
        )
        self.assertEqual(manifest_calls, 1)

        # Within 120s and force=False -> skipped
        self.assertFalse(
            rt.maybe_resync_active_model(
                manifest_fetcher=_fetch_same_manifest,
                artifact_fetcher=lambda _k, _i: b"",
                min_interval_seconds=120.0,
                force=False,
            )
        )
        self.assertEqual(manifest_calls, 1)

        # trigger_wakeup marks resync needed; force=True bypasses 120s cooldown immediately!
        rt.trigger_wakeup(reason="active_model_promoted")
        self.assertTrue(rt.needs_model_resync())

        with patch.object(
            rt,
            "sync_active_model",
            side_effect=lambda **_kw: (
                setattr(rt, "_model_profile", "FLOW2_ADMIN_VERIFIED"),
                setattr(rt, "_model_sha256", new_sha),
                {"profile": "FLOW2_ADMIN_VERIFIED", "checkpoint_sha256": new_sha},
            )[-1],
        ):
            changed = rt.maybe_resync_active_model(
                manifest_fetcher=lambda: {
                    "profile": "FLOW2_ADMIN_VERIFIED",
                    "checkpoint_sha256": new_sha,
                },
                artifact_fetcher=lambda _k, _i: b"",
                min_interval_seconds=120.0,
                force=True,
            )
        self.assertTrue(changed)
        self.assertEqual(rt.loaded_model_sha256, new_sha)
        self.assertFalse(rt.needs_model_resync())

        # 2. process_claimed_job forces resync BEFORE running OCR when active_model_sha256 differs
        order_log: list[str] = []

        class _FakeRuntimeForJob(OcrRuntimeManager):
            def maybe_resync_active_model(self, *, force: bool = False, **kwargs: Any) -> bool:
                order_log.append(f"resync:force={force}")
                with self._state_lock:
                    self._model_profile = "FLOW2_ADMIN_VERIFIED"
                    self._model_sha256 = new_sha
                    self._pending_model_resync = False
                return True

            def run_ocr_for_job(self, job_id: str, image_bytes: bytes) -> dict[str, Any]:
                order_log.append(f"ocr:{self.loaded_model_sha256[:8]}")
                return {
                    "full_text": "Xin chào",
                    "words": [{"word_index": 0, "line_index": 0, "text": "Xin"}],
                    "ocr_meta": {},
                    "model_profile": "FLOW2_ADMIN_VERIFIED",
                    "model_sha256": self.loaded_model_sha256,
                    "engine_diagnostics": {},
                    "duration_ms": 10,
                }

        job_rt = _FakeRuntimeForJob(worker_id="w-prejob")
        with job_rt._state_lock:
            job_rt._model_profile = "FLOW1_EXTERNAL_TRDG"
            job_rt._model_sha256 = old_sha
            job_rt._engines["paddleocr"].loaded = True
            job_rt._engines["vietocr"].loaded = True

        seen_heartbeats: list[dict[str, Any]] = []
        completed_payloads: list[dict[str, Any]] = []

        def _backend_handler(request: httpx.Request) -> httpx.Response:
            if request.url.path == "/internal/ocr-jobs/worker-heartbeat":
                seen_heartbeats.append(json.loads(request.content.decode("utf-8")))
                return httpx.Response(200, json={"ok": True})
            if request.url.path == "/internal/ocr-jobs/claim":
                return httpx.Response(200, json={"job": None})
            if request.url.path.endswith("/source"):
                return httpx.Response(200, content=img_bytes)
            if request.url.path.endswith("/complete"):
                completed_payloads.append(json.loads(request.content.decode("utf-8")))
                return httpx.Response(200, json={"status": "SUCCEEDED"})
            return httpx.Response(404)

        client = BackendOcrClient(
            "https://api.example",
            token,
            transport=httpx.MockTransport(_backend_handler),
        )
        try:
            outcome = process_claimed_job(
                client,
                job_rt,
                {
                    "job_id": "job-mismatch-1",
                    "job_kind": "LOCAL_PAGE_SCAN",
                    "fencing_token": 1,
                    "image_sha256": img_sha,
                    "source_url": None,
                    "source_fallback_path": "/internal/ocr-jobs/job-mismatch-1/source",
                    "active_model_sha256": new_sha,
                },
            )
            self.assertEqual(outcome["outcome"], "completed")
            self.assertEqual(order_log, ["resync:force=True", f"ocr:{new_sha[:8]}"])
            self.assertEqual(completed_payloads[-1]["model_sha256"], new_sha)
            self.assertEqual(seen_heartbeats[-1]["model_sha256"], new_sha)

            # 3. drain_queue_synchronously forces resync on wakeup even when queue is empty
            order_log.clear()
            seen_heartbeats.clear()
            with job_rt._state_lock:
                job_rt._model_sha256 = old_sha
            drained = drain_queue_synchronously(
                client,
                job_rt,
                straggler_wait_seconds=0.0,
            )
            self.assertEqual(drained, 0)
            self.assertEqual(order_log, ["resync:force=True"])
            self.assertEqual(seen_heartbeats[-1]["model_sha256"], new_sha)
        finally:
            client.close()


if __name__ == "__main__":
    unittest.main()
