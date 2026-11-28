"""Lifecycle tests for OCR worker online/offline cache invalidation, engine readiness, and scale-to-zero startup/shutdown."""
from __future__ import annotations

import asyncio
import hashlib
import json
import os
import sys
import threading
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any
from unittest.mock import patch
from uuid import uuid4

REPO_ROOT = Path(__file__).resolve().parent.parent
if str(REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(REPO_ROOT))

import httpx

from app.models import OcrWorkerHeartbeat
from app.repositories.global_tasks_repository import GlobalTasksRepository
from app.services.ocr_inference_job_service import OcrInferenceJobService
from app.services.remote_ocr_wakeup import (
    clear_remote_ocr_wakeup_cache_for_tests,
    invalidate_remote_ocr_health_cache,
    peek_cached_remote_ocr_worker_health,
    probe_configured_remote_ocr_worker_health,
    set_remote_ocr_wakeup_transport_for_tests,
)
from app.services.runtime_diagnostics import collect_remote_ocr_health
from test_ocr_inference_jobs import FakeAsyncSession, InMemoryDbState


class TestOcrWorkerLifecycleAndDetection(unittest.TestCase):
    def setUp(self) -> None:
        clear_remote_ocr_wakeup_cache_for_tests()
        set_remote_ocr_wakeup_transport_for_tests(None)
        self.state = InMemoryDbState()
        self.db = FakeAsyncSession(self.state)
        self.svc = OcrInferenceJobService(self.db)  # type: ignore[arg-type]

    def tearDown(self) -> None:
        clear_remote_ocr_wakeup_cache_for_tests()
        set_remote_ocr_wakeup_transport_for_tests(None)

    def test_heartbeat_invalidates_remote_health_cache_for_offline_idle_busy(self) -> None:
        worker_online_flag = {"online": True}
        probe_calls = 0

        async def _transport_handler(request: httpx.Request) -> httpx.Response:
            nonlocal probe_calls
            probe_calls += 1
            if not worker_online_flag["online"]:
                raise httpx.ConnectError("connection refused", request=request)
            return httpx.Response(
                200,
                json={
                    "ready": True,
                    "worker_status": "IDLE",
                    "worker_id": "docker-ocr-1",
                    "engines": {
                        "paddleocr": {
                            "status": "HEALTHY",
                            "detail_status": "loaded",
                            "installed": True,
                            "loaded": True,
                            "inference_verified": True,
                        }
                    },
                },
            )

        set_remote_ocr_wakeup_transport_for_tests(httpx.MockTransport(_transport_handler))

        class _SessionCtx:
            def __init__(self, state: InMemoryDbState):
                self._state = state

            async def __aenter__(self) -> FakeAsyncSession:
                return FakeAsyncSession(self._state)

            async def __aexit__(self, *_args: Any) -> bool:
                return False

        async def _scenario() -> None:
            env = {
                "VIREAD_OCR_REMOTE_WORKER_URL": "https://ocr.example.internal",
                "VIREAD_OCR_REMOTE_SCALE_TO_ZERO": "false",
                "VIREAD_OCR_WORKER_TOKEN": "x" * 40,
            }
            with (
                patch.dict(os.environ, env, clear=False),
                patch("app.database.session.AsyncSessionLocal", side_effect=lambda: _SessionCtx(self.state)),
                patch(
                    "app.repositories.ocr_inference_job_repository.OcrInferenceJobRepository.queue_depth_counts",
                    return_value={
                        "queued": 0,
                        "claimed": 0,
                        "running": 0,
                        "failed_retryable": 0,
                        "dead_letter": 0,
                        "succeeded": 0,
                        "cancelled": 0,
                        "expired_leases": 0,
                        "pending_total": 0,
                        "active_total": 0,
                        "oldest_pending_job_age_seconds": None,
                        "latest_succeeded_at": None,
                    },
                ),
            ):
                # 1. Populate _HEALTH_CACHE via initial probe
                initial = await probe_configured_remote_ocr_worker_health()
                self.assertIsNotNone(initial)
                assert initial is not None
                self.assertTrue(initial["online"])
                self.assertEqual(probe_calls, 1)
                valid, _cached = peek_cached_remote_ocr_worker_health()
                self.assertTrue(valid)

                # Explicit invalidation clears _HEALTH_CACHE
                invalidate_remote_ocr_health_cache()
                valid_after_clear, _ = peek_cached_remote_ocr_worker_health()
                self.assertFalse(valid_after_clear)

                # Re-warm cache
                await probe_configured_remote_ocr_worker_health()
                self.assertEqual(probe_calls, 2)

                # 2. Simulate `docker stop`: worker sends OFFLINE heartbeat -> cache invalidated immediately
                worker_online_flag["online"] = False
                await self.svc.record_worker_heartbeat(
                    worker_id="docker-ocr-1",
                    hostname="docker-host",
                    app_version="1.0.0",
                    git_sha="abc",
                    status_value="OFFLINE",
                    active_job_id=None,
                    active_job_count=0,
                    concurrency_limit=1,
                    model_profile="ORIGINAL",
                    model_sha256="a" * 64,
                    engines={},
                    system_stats={},
                    last_error=None,
                )
                valid_after_stop, _ = peek_cached_remote_ocr_worker_health()
                self.assertFalse(valid_after_stop)

                # collect_remote_ocr_health and has_online_worker reflect offline immediately without 60s wait
                health_after_stop = await collect_remote_ocr_health()
                self.assertFalse(health_after_stop["ready"])
                self.assertFalse(await self.svc.has_online_worker())
                self.assertGreaterEqual(probe_calls, 3)

                # 3. Simulate `docker start`: worker sends IDLE heartbeat -> cache invalidated immediately
                worker_online_flag["online"] = True
                await self.svc.record_worker_heartbeat(
                    worker_id="docker-ocr-1",
                    hostname="docker-host",
                    app_version="1.0.0",
                    git_sha="abc",
                    status_value="IDLE",
                    active_job_id=None,
                    active_job_count=0,
                    concurrency_limit=1,
                    model_profile="ORIGINAL",
                    model_sha256="a" * 64,
                    engines={
                        "paddleocr": {
                            "status": "HEALTHY",
                            "detail_status": "loaded",
                            "loaded": True,
                            "inference_verified": True,
                        }
                    },
                    system_stats={},
                    last_error=None,
                )
                valid_after_start, _ = peek_cached_remote_ocr_worker_health()
                self.assertFalse(valid_after_start)
                self.assertTrue(await self.svc.has_online_worker())

                # BUSY heartbeat also invalidates cache
                await probe_configured_remote_ocr_worker_health()
                self.assertTrue(peek_cached_remote_ocr_worker_health()[0])
                await self.svc.record_worker_heartbeat(
                    worker_id="docker-ocr-1",
                    hostname="docker-host",
                    app_version="1.0.0",
                    git_sha="abc",
                    status_value="BUSY",
                    active_job_id=uuid4(),
                    active_job_count=1,
                    concurrency_limit=1,
                    model_profile="ORIGINAL",
                    model_sha256="a" * 64,
                    engines={
                        "paddleocr": {
                            "status": "HEALTHY",
                            "detail_status": "loaded",
                            "loaded": True,
                            "inference_verified": True,
                        }
                    },
                    system_stats={},
                    last_error=None,
                )
                self.assertFalse(peek_cached_remote_ocr_worker_health()[0])

        asyncio.run(_scenario())

    def test_has_online_worker_and_global_tasks_repo_reject_offline_starting_degraded_and_unready_engines(self) -> None:
        async def _scenario() -> None:
            now = datetime.now(timezone.utc)
            gt_repo = GlobalTasksRepository(self.db)  # type: ignore[arg-type]

            with patch(
                "app.services.remote_ocr_wakeup.is_remote_worker_wakeup_configured",
                return_value=False,
            ):
                # 1. OFFLINE -> False in both has_online_worker and is_remote_ocr_worker_online
                hb = OcrWorkerHeartbeat(
                    WorkerId="w1",
                    Status="OFFLINE",
                    Engines={},
                    LastHeartbeatAt=now,
                    CreatedAt=now,
                    UpdatedAt=now,
                )
                self.state.tables[OcrWorkerHeartbeat].append(hb)
                await self.db.commit()
                self.assertFalse(await self.svc.has_online_worker())
                self.assertFalse(await gt_repo.is_remote_ocr_worker_online())

                # 2. STARTING -> False
                hb.Status = "STARTING"
                await self.db.commit()
                self.assertFalse(await self.svc.has_online_worker())
                self.assertFalse(await gt_repo.is_remote_ocr_worker_online())

                # 3. DEGRADED -> False
                hb.Status = "DEGRADED"
                await self.db.commit()
                self.assertFalse(await self.svc.has_online_worker())
                self.assertFalse(await gt_repo.is_remote_ocr_worker_online())

                # 4. IDLE with explicitly unready engines -> False in has_online_worker
                hb.Status = "IDLE"
                hb.Engines = {
                    "paddleocr": {
                        "status": "DEGRADED",
                        "detail_status": "installed",
                        "installed": True,
                        "loaded": False,
                        "inference_verified": False,
                    }
                }
                await self.db.commit()
                self.assertFalse(await self.svc.has_online_worker())

                # 5. IDLE with empty engines dict (test fixture compat) -> True
                hb.Engines = {}
                await self.db.commit()
                self.assertTrue(await self.svc.has_online_worker())
                self.assertTrue(await gt_repo.is_remote_ocr_worker_online())

                # 6. BUSY with loaded engine -> True
                hb.Status = "BUSY"
                hb.Engines = {
                    "vietocr": {
                        "status": "HEALTHY",
                        "detail_status": "loaded",
                        "loaded": True,
                        "inference_verified": False,
                    }
                }
                await self.db.commit()
                self.assertTrue(await self.svc.has_online_worker())
                self.assertTrue(await gt_repo.is_remote_ocr_worker_online())

                # 7. Stale heartbeat -> False
                hb.LastHeartbeatAt = now - timedelta(seconds=120)
                await self.db.commit()
                self.assertFalse(await self.svc.has_online_worker())
                self.assertFalse(await gt_repo.is_remote_ocr_worker_online())

            # 8. Remote probe returning ready=False (e.g. DEGRADED) -> has_online_worker() is False
            async def _degraded_probe(_request: httpx.Request) -> httpx.Response:
                return httpx.Response(200, json={"ready": False, "worker_status": "DEGRADED"})

            set_remote_ocr_wakeup_transport_for_tests(httpx.MockTransport(_degraded_probe))
            with patch.dict(
                os.environ,
                {
                    "VIREAD_OCR_REMOTE_WORKER_URL": "https://ocr.example.internal",
                    "VIREAD_OCR_REMOTE_SCALE_TO_ZERO": "false",
                    "VIREAD_OCR_WORKER_TOKEN": "x" * 40,
                },
                clear=False,
            ):
                invalidate_remote_ocr_health_cache()
                self.assertFalse(await self.svc.has_online_worker())

        asyncio.run(_scenario())

    def test_worker_scale_to_zero_startup_drains_offline_queue_and_sigterm_sends_offline_heartbeat(self) -> None:
        from ocr_worker import worker as worker_mod
        from ocr_worker.service import EXPECTED_FLOW1_TRDG_SHA256, OcrRuntimeManager

        img_bytes = b"queued-while-offline-bytes"
        img_sha = hashlib.sha256(img_bytes).hexdigest()
        queued_jobs = [
            {
                "job_id": "offline-job-1",
                "job_kind": "ADMIN_PAGE_UPLOAD",
                "fencing_token": 1,
                "image_sha256": img_sha,
                "source_url": None,
                "source_fallback_path": "/internal/ocr-jobs/offline-job-1/source",
            }
        ]
        seen_heartbeats: list[tuple[str, float | None]] = []
        completed_job_ids: list[str] = []
        entered_standby = threading.Event()
        wake_calls = 0

        class _FakeClient:
            def __init__(self, *_args: Any, **_kwargs: Any):
                pass

            def close(self) -> None:
                return None

            def get_active_model(self) -> dict[str, Any]:
                return {"profile": "FLOW1_EXTERNAL_TRDG", "checkpoint_sha256": EXPECTED_FLOW1_TRDG_SHA256}

            def download_model_artifact(self, *_args: Any, **_kwargs: Any) -> bytes:
                return b""

            def download_direct_url(self, *_args: Any, **_kwargs: Any) -> bytes | None:
                return None

            def send_worker_heartbeat(
                self, payload: dict[str, Any], *, timeout_seconds: float | None = None
            ) -> dict[str, Any]:
                seen_heartbeats.append((str(payload.get("status")), timeout_seconds))
                return {"ok": True}

            def claim_next_job(self, _worker_id: str, *, lease_seconds: int = 120) -> dict[str, Any] | None:
                if queued_jobs:
                    return queued_jobs.pop(0)
                return None

            def download_job_source(self, _job: dict[str, Any], *, worker_id: str) -> bytes:
                return img_bytes

            def heartbeat_job(self, *_args: Any, **_kwargs: Any) -> dict[str, Any]:
                return {"cancelled": False}

            def complete_job(self, job_id: str, _payload: dict[str, Any]) -> tuple[int, dict[str, Any]]:
                completed_job_ids.append(job_id)
                return 200, {"status": "SUCCEEDED"}

        class _FakeRuntime(OcrRuntimeManager):
            def __init__(self) -> None:
                super().__init__(worker_id="docker-test-worker")
                self._ocr_engine_mod = object()  # type: ignore[assignment]
                with self._state_lock:
                    self._engines["paddleocr"].loaded = True
                    self._engines["paddleocr"].inference_verified = True
                    self._engines["vietocr"].loaded = True
                    self._engines["vietocr"].inference_verified = True
                    self._engines["tesseract_vie"].loaded = True
                    self._engines["tesseract_vie"].inference_verified = True

            def initialize_and_verify_engines(self, **_kwargs: Any) -> None:
                return None

            def run_ocr_for_job(self, job_id: str, image_bytes: bytes) -> dict[str, Any]:
                return {
                    "full_text": "Xin chào",
                    "words": [{"word_index": 0, "line_index": 0, "text": "Xin", "bbox": [0.1, 0.1, 0.1, 0.05]}],
                    "ocr_meta": {"runtime_device": "cpu"},
                    "model_profile": "FLOW1_EXTERNAL_TRDG",
                    "model_sha256": EXPECTED_FLOW1_TRDG_SHA256,
                    "engine_diagnostics": {},
                    "duration_ms": 10,
                }

        class _FakeServer:
            def __init__(self, *_args: Any, **_kwargs: Any):
                self.should_exit = False

            def run(self) -> None:
                return None

        def _fake_wait(stop_ev: threading.Event, wake_ev: threading.Event, timeout_s: float | None) -> bool:
            nonlocal wake_calls
            wake_calls += 1
            if timeout_s is None:
                # Reached standby sleep! Trigger graceful stop (simulating SIGTERM)
                entered_standby.set()
                stop_ev.set()
                return False
            return False

        with (
            patch.dict(
                os.environ,
                {
                    "VIREAD_OCR_SCALE_TO_ZERO": "true",
                    "VIREAD_OCR_QUIET_STANDBY": "",
                },
                clear=False,
            ),
            patch.object(worker_mod, "OcrRuntimeManager", _FakeRuntime),
            patch.object(worker_mod, "BackendOcrClient", _FakeClient),
            patch.object(worker_mod, "build_worker_http_app", return_value=object()),
            patch.object(worker_mod.uvicorn, "Server", _FakeServer),
            patch.object(worker_mod.uvicorn, "Config", return_value=object()),
            patch.object(worker_mod, "_wait_for_wake_or_stop", side_effect=_fake_wait),
        ):
            worker_mod.run_worker_forever(
                backend_url="https://api.example",
                worker_token="t" * 40,
                apply_priority=False,
            )

        self.assertTrue(entered_standby.is_set())
        self.assertEqual(completed_job_ids, ["offline-job-1"])
        # Heartbeat sequence: startup IDLE -> drain IDLE -> BUSY -> IDLE -> shutdown OFFLINE
        statuses = [s for s, _t in seen_heartbeats]
        self.assertGreaterEqual(len(statuses), 4)
        self.assertEqual(statuses[0], "IDLE")
        self.assertIn("BUSY", statuses)
        self.assertEqual(statuses[-1], "OFFLINE")
        # Shutdown OFFLINE heartbeat must use short ~2s timeout even when use_quiet_standby=True
        offline_status, offline_timeout = seen_heartbeats[-1]
        self.assertEqual(offline_status, "OFFLINE")
        self.assertIsNotNone(offline_timeout)
        assert offline_timeout is not None
        self.assertLessEqual(offline_timeout, 3.0)


if __name__ == "__main__":
    unittest.main()
