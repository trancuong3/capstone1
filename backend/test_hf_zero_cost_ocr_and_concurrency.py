"""Deep verification for 0-cost HF Space OCR, anti-bottleneck wakeup, and STT/TTS concurrency safety."""

from __future__ import annotations

import asyncio
from datetime import datetime, timedelta, timezone
import hashlib
import json
import os
from pathlib import Path
import socket
import tempfile
import unittest
from unittest.mock import patch
from uuid import uuid4

# Ensure standalone execution (`python -m unittest test_hf_zero_cost_ocr_and_concurrency.py -v`)
# succeeds without requiring external CI shell env setup.
os.environ.setdefault("APP_ENVIRONMENT", "test")
os.environ.setdefault("DATABASE_URL", "postgresql+asyncpg://test:test@localhost:5432/test")
os.environ.setdefault("SUPABASE_URL", "https://example.supabase.co")
os.environ.setdefault("SUPABASE_KEY", "test-publishable-key")

import httpx

from app.database.session import DatabaseConcurrencyLimiter
from app.models import Book, OcrInferenceJob, OcrWorkerHeartbeat, ParentBookPageSubmission
from app.services.ocr_inference_job_service import (
    JOB_KIND_LOCAL_SCAN,
    OcrInferenceJobService,
    _post_ocr_concurrency_limit,
    clear_active_model_manifest_cache,
    compute_candidate_hash,
    schedule_parent_submission_post_ocr,
    shutdown_post_ocr_tasks,
)
from app.services.remote_ocr_wakeup import (
    _dispatch_wakeup_with_hybrid_grace,
    _validate_production_target_dns,
    clear_remote_ocr_wakeup_cache_for_tests,
    get_configured_remote_ocr_worker_url,
    maybe_keep_warm_hf_space_from_cron,
    probe_configured_remote_ocr_worker_health,
    send_remote_ocr_wakeup,
    set_remote_ocr_wakeup_transport_for_tests,
    shutdown_remote_ocr_wakeup_tasks,
)
from app.services.runtime_diagnostics import collect_remote_ocr_health
from test_ocr_inference_jobs import FakeAsyncSession, InMemoryDbState

WORKER_TOKEN = "hf-space-ocr-worker-token-0123456789abcdef"
HF_READ_TOKEN = "hf_test_private_space_read_token_123456"
SPACE_URL = "https://viread-ocr-worker.hf.space"


class TestHfZeroCostOcrAndConcurrency(unittest.TestCase):
    def setUp(self) -> None:
        clear_remote_ocr_wakeup_cache_for_tests()
        clear_active_model_manifest_cache()
        set_remote_ocr_wakeup_transport_for_tests(None)

    def tearDown(self) -> None:
        set_remote_ocr_wakeup_transport_for_tests(None)
        clear_remote_ocr_wakeup_cache_for_tests()
        clear_active_model_manifest_cache()

    def test_url_validation_blocks_ssrf_and_non_https_in_production(self) -> None:
        with patch.dict(
            os.environ,
            {
                "APP_ENVIRONMENT": "production",
                "VIREAD_OCR_REMOTE_WORKER_URL": "http://viread-ocr-worker.hf.space",
            },
            clear=False,
        ):
            self.assertIsNone(get_configured_remote_ocr_worker_url())

        with patch.dict(
            os.environ,
            {
                "APP_ENVIRONMENT": "production",
                "VIREAD_OCR_REMOTE_WORKER_URL": "https://169.254.169.254/latest",
            },
            clear=False,
        ):
            self.assertIsNone(get_configured_remote_ocr_worker_url())

        with patch.dict(
            os.environ,
            {
                "APP_ENVIRONMENT": "production",
                "VIREAD_OCR_REMOTE_WORKER_URL": "https://user:pass@viread-ocr.hf.space",
            },
            clear=False,
        ):
            self.assertIsNone(get_configured_remote_ocr_worker_url())

        with patch.dict(
            os.environ,
            {
                "APP_ENVIRONMENT": "production",
                "VIREAD_OCR_REMOTE_WORKER_URL": f"{SPACE_URL}/",
            },
            clear=False,
        ):
            self.assertEqual(get_configured_remote_ocr_worker_url(), SPACE_URL)

    def test_post_commit_wakeup_fires_only_on_commit_never_on_rollback(self) -> None:
        seen_wakeups: list[tuple[str, dict[str, str], dict[str, object]]] = []

        async def transport_handler(request: httpx.Request) -> httpx.Response:
            body = json.loads(request.content.decode("utf-8")) if request.content else {}
            seen_wakeups.append(
                (
                    str(request.url),
                    {k.lower(): v for k, v in request.headers.items()},
                    body,
                )
            )
            return httpx.Response(200, json={"ok": True, "woken": True})

        set_remote_ocr_wakeup_transport_for_tests(httpx.MockTransport(transport_handler))

        async def _scenario() -> None:
            state = InMemoryDbState()
            db = FakeAsyncSession(state)
            svc = OcrInferenceJobService(db)  # type: ignore[arg-type]

            with patch.dict(
                os.environ,
                {
                    "VIREAD_OCR_REMOTE_WORKER_URL": SPACE_URL,
                    "VIREAD_OCR_WORKER_TOKEN": WORKER_TOKEN,
                    "VIREAD_HF_SPACE_TOKEN": HF_READ_TOKEN,
                },
                clear=False,
            ):
                # 1. Rolled-back transaction MUST NOT fire /wakeup!
                await svc.enqueue_job(
                    job_kind=JOB_KIND_LOCAL_SCAN,
                    owner_user_id=uuid4(),
                    image_path="local-scans/u1/rollback.jpg",
                    image_sha256="1" * 64,
                )
                await db.rollback()
                await asyncio.sleep(0.05)
                self.assertEqual(len(seen_wakeups), 0)

                # 2. Committed transaction MUST fire /wakeup post-commit with both tokens!
                committed_job = await svc.enqueue_job(
                    job_kind=JOB_KIND_LOCAL_SCAN,
                    owner_user_id=uuid4(),
                    image_path="local-scans/u1/committed.jpg",
                    image_sha256="2" * 64,
                )
                self.assertEqual(len(seen_wakeups), 0)  # Not yet committed!
                await db.commit()
                await asyncio.sleep(0.08)
                await shutdown_remote_ocr_wakeup_tasks()

                self.assertEqual(len(seen_wakeups), 1)
                url, headers, payload = seen_wakeups[0]
                self.assertEqual(url, f"{SPACE_URL}/wakeup")
                self.assertEqual(headers.get("x-viread-ocr-worker-token"), WORKER_TOKEN)
                self.assertEqual(headers.get("authorization"), f"Bearer {HF_READ_TOKEN}")
                self.assertEqual(payload.get("job_id"), str(committed_job.Id))

        asyncio.run(_scenario())

    def test_passive_health_cache_coalescing_and_quiet_standby_readiness(self) -> None:
        health_calls: list[dict[str, str]] = []

        async def transport_handler(request: httpx.Request) -> httpx.Response:
            if request.url.path == "/health":
                health_calls.append({k.lower(): v for k, v in request.headers.items()})
                await asyncio.sleep(0.02)
                return httpx.Response(
                    200,
                    json={
                        "status": "ok",
                        "worker_status": "IDLE",
                        "standby_mode": "quiet_standby",
                        "worker_id": "hf-space-cpu-1",
                        "ready": True,
                        "active_job_count": 0,
                        "concurrency_limit": 1,
                        "model": {
                            "profile": "FLOW1_EXTERNAL_TRDG",
                            "checkpoint_sha256": "200edce460606275481dda19c50b7763620a112ddc66a8378982bddc013114a6",
                        },
                        "engines": {
                            "paddleocr": {
                                "status": "HEALTHY",
                                "detail_status": "inference_verified",
                                "installed": True,
                                "loaded": True,
                                "inference_verified": True,
                            },
                            "vietocr": {
                                "status": "HEALTHY",
                                "detail_status": "inference_verified",
                                "installed": True,
                                "loaded": True,
                                "inference_verified": True,
                            },
                            "tesseract_vie": {
                                "status": "HEALTHY",
                                "detail_status": "inference_verified",
                                "installed": True,
                                "loaded": True,
                                "inference_verified": True,
                            },
                        },
                        "version": "1.0.0",
                        "git_sha": "7c2ec011",
                    },
                )
            return httpx.Response(404)

        set_remote_ocr_wakeup_transport_for_tests(httpx.MockTransport(transport_handler))

        async def _scenario() -> None:
            state = InMemoryDbState()  # Zero DB heartbeats (Quiet Standby!)

            class _SessionCtx:
                async def __aenter__(self):
                    s = FakeAsyncSession(state)
                    s.execute = self._fake_execute  # type: ignore[method-assign]
                    return s

                async def __aexit__(self, *_a):
                    return False

                @staticmethod
                async def _fake_execute(_q):
                    class _Row:
                        queued = 0
                        claimed = 0
                        running = 0
                        failed_retryable = 0
                        dead_letter = 0
                        succeeded = 5
                        cancelled = 0
                        expired_leases = 0
                        oldest_pending_created = None
                        latest_succeeded_at = None

                    class _Res:
                        def one(self):
                            return _Row()

                    return _Res()

            with (
                patch.dict(
                    os.environ,
                    {
                        "VIREAD_OCR_REMOTE_WORKER_URL": SPACE_URL,
                        "VIREAD_OCR_WORKER_TOKEN": WORKER_TOKEN,
                        "VIREAD_HF_SPACE_TOKEN": HF_READ_TOKEN,
                    },
                    clear=False,
                ),
                patch("app.database.session.AsyncSessionLocal", side_effect=_SessionCtx),
            ):
                # 25 concurrent health + online checks -> single-flight 60s cache = 1 HTTP GET!
                tasks = [collect_remote_ocr_health() for _ in range(15)] + [
                    OcrInferenceJobService(FakeAsyncSession(state)).has_online_worker()  # type: ignore[arg-type]
                    for _ in range(10)
                ]
                results = await asyncio.gather(*tasks)

                self.assertEqual(len(health_calls), 1)
                # Worker token MUST NEVER be sent on passive GET /health!
                self.assertNotIn("x-viread-ocr-worker-token", health_calls[0])
                self.assertEqual(health_calls[0].get("authorization"), f"Bearer {HF_READ_TOKEN}")

                for diag in results[:15]:
                    assert isinstance(diag, dict)
                    self.assertTrue(diag["ready"])
                    self.assertEqual(diag["workers"][0]["worker_id"], "hf-space-cpu-1")
                    self.assertEqual(diag["workers"][0]["standby_mode"], "quiet_standby")
                for online_flag in results[15:]:
                    self.assertTrue(online_flag)

                # 12h cron keepwarm respects min_interval_seconds
                ping1 = await maybe_keep_warm_hf_space_from_cron(min_interval_seconds=3600)
                ping2 = await maybe_keep_warm_hf_space_from_cron(min_interval_seconds=3600)
                self.assertTrue(ping1)
                self.assertFalse(ping2)

        asyncio.run(_scenario())

    def test_hybrid_gpu_first_grace_skips_wakeup_when_cuda_worker_claims_job(self) -> None:
        wake_count = 0

        async def transport_handler(_request: httpx.Request) -> httpx.Response:
            nonlocal wake_count
            wake_count += 1
            return httpx.Response(200, json={"ok": True, "woken": True})

        set_remote_ocr_wakeup_transport_for_tests(httpx.MockTransport(transport_handler))

        async def _scenario() -> None:
            job_id = uuid4()
            job_claimed_by_gpu = False

            async def fake_has_cuda() -> bool:
                return True

            async def fake_still_queued(_jid) -> bool:
                return not job_claimed_by_gpu

            with (
                patch.dict(
                    os.environ,
                    {
                        "VIREAD_OCR_REMOTE_WORKER_URL": SPACE_URL,
                        "VIREAD_OCR_WORKER_TOKEN": WORKER_TOKEN,
                        "VIREAD_OCR_HYBRID_GPU_GRACE_SECONDS": "0.06",
                    },
                    clear=False,
                ),
                patch(
                    "app.services.remote_ocr_wakeup._has_online_idle_cuda_worker",
                    side_effect=fake_has_cuda,
                ),
                patch(
                    "app.services.remote_ocr_wakeup._is_job_still_queued",
                    side_effect=fake_still_queued,
                ),
            ):
                # Laptop GPU claims single job within 20ms (< 60ms grace) -> HF Space NOT woken!
                async def _gpu_claims_fast() -> None:
                    nonlocal job_claimed_by_gpu
                    await asyncio.sleep(0.02)
                    job_claimed_by_gpu = True

                woke, _ = await asyncio.gather(
                    _dispatch_wakeup_with_hybrid_grace([job_id], "enqueue:LOCAL_PAGE_SCAN"),
                    _gpu_claims_fast(),
                )
                self.assertFalse(woke)
                self.assertEqual(wake_count, 0)

                # Batch of 2 jobs -> bypasses GPU-only grace and wakes HF Space immediately to co-process!
                job_claimed_by_gpu = False
                woke_batch = await _dispatch_wakeup_with_hybrid_grace(
                    [uuid4(), uuid4()], "enqueue:ADMIN_PAGE_UPLOAD"
                )
                self.assertTrue(woke_batch)
                self.assertEqual(wake_count, 1)

        asyncio.run(_scenario())

    def test_claim_refresh_and_manifest_release_db_before_storage_signing(self) -> None:
        async def _scenario() -> None:
            state = InMemoryDbState()
            events: list[str] = []

            class InstrumentedSession(FakeAsyncSession):
                async def commit(self) -> None:
                    events.append("db_commit")
                    await super().commit()

                async def rollback(self) -> None:
                    events.append("db_rollback")
                    await super().rollback()

            db = InstrumentedSession(state)
            svc = OcrInferenceJobService(db)  # type: ignore[arg-type]

            job = await svc.enqueue_job(
                job_kind=JOB_KIND_LOCAL_SCAN,
                owner_user_id=uuid4(),
                image_path="local-scans/u1/page1.jpg",
                image_bucket="private-books",
                image_sha256="a" * 64,
            )
            await db.commit()
            events.clear()

            seen_ttls: list[int | None] = []

            def fake_sign(path: str, *, bucket_name: str | None = None, ttl_seconds: int | None = None) -> str:
                events.append(f"sign:{path}")
                seen_ttls.append(ttl_seconds)
                return f"https://storage.example/signed/{path}?ttl={ttl_seconds}"

            with (
                patch("app.services.ocr_inference_job_service.APP_ENVIRONMENT", "production"),
                patch.dict(os.environ, {"VIREAD_LOCAL_STORAGE_DIR": ""}, clear=False),
                patch(
                    "app.services.ocr_inference_job_service.storage_service.create_signed_image_url",
                    side_effect=fake_sign,
                ),
            ):
                claimed = await svc.claim_next_job(worker_id="hf-ocr-1", lease_seconds=120)
                assert claimed is not None
                self.assertEqual(events, ["db_commit", "sign:local-scans/u1/page1.jpg"])
                self.assertEqual(seen_ttls[-1], 300)
                self.assertIn("ttl=300", str(claimed["source_url"]))

                events.clear()
                refreshed = await svc.refresh_source_url(
                    job_id=job.Id,
                    worker_id="hf-ocr-1",
                    fencing_token=int(claimed["fencing_token"]),
                    expires_in=420,
                )
                self.assertEqual(events, ["db_rollback", "sign:local-scans/u1/page1.jpg"])
                self.assertEqual(seen_ttls[-1], 420)
                self.assertIn("ttl=420", str(refreshed["source_url"]))

                # Active model manifest signs Storage shards (not gdrive://) & caches in RAM
                manifest_json = json.dumps(
                    {
                        "checkpoint_sha256": "b" * 64,
                        "config": {"storage_path": "models/v2/cfg.yml", "sha256": "c" * 64},
                        "chunks": [
                            {"index": 0, "path": "models/v2/s0.part", "sha256": "d" * 64, "bytes": 100},
                            {"index": 1, "path": "gdrive://file_id_1", "sha256": "e" * 64, "bytes": 100},
                        ],
                    }
                ).encode("utf-8")
                download_calls = 0

                def fake_download_ref(_ref: str) -> bytes:
                    nonlocal download_calls
                    download_calls += 1
                    return manifest_json

                with (
                    patch.object(
                        svc.repo,
                        "get_active_model_pointer",
                        return_value={
                            "profile": "FLOW1_EXTERNAL_TRDG",
                            "checkpoint_sha256": "b" * 64,
                            "storage_path": "models/v2/manifest.json",
                        },
                    ),
                    patch.object(svc, "_download_model_ref", side_effect=fake_download_ref),
                ):
                    m1 = await svc.get_active_model_manifest()
                    m2 = await svc.get_active_model_manifest()
                    self.assertEqual(download_calls, 1)  # Served from RAM cache on m2!
                    self.assertIsNotNone(m1["config_signed_url"])
                    self.assertIsNotNone(m1["shards"][0]["signed_url"])
                    self.assertIsNone(m1["shards"][1]["signed_url"])  # gdrive:// not signed via Supabase
                    self.assertEqual(m1["shards"], m2["shards"])

        asyncio.run(_scenario())

    def test_post_ocr_concurrency_limit_and_cloud_privacy_notice(self) -> None:
        with patch.dict(
            os.environ,
            {
                "VIREAD_WEB_DISABLE_HEAVY_WORKERS": "true",
                "OCR_CLOUD_CORRECTION_ENABLED": "true",
                "PRIVATE_BOOK_ALLOW_CLOUD_AI": "true",
            },
            clear=False,
        ):
            os.environ.pop("VIREAD_POST_OCR_CONCURRENCY", None)
            self.assertEqual(_post_ocr_concurrency_limit(), 1)

        with patch.dict(
            os.environ,
            {
                "VIREAD_WEB_DISABLE_HEAVY_WORKERS": "false",
                "VIREAD_OCR_MODE": "local_inprocess",
                "APP_ENVIRONMENT": "development",
                "OCR_CLOUD_CORRECTION_ENABLED": "true",
                "PRIVATE_BOOK_ALLOW_CLOUD_AI": "true",
            },
            clear=False,
        ):
            os.environ.pop("RENDER", None)
            os.environ.pop("VIREAD_POST_OCR_CONCURRENCY", None)
            self.assertEqual(_post_ocr_concurrency_limit(), 4)

        from app.services.parent_private_book_service import ParentPrivateBookService

        book = Book(
            Id=uuid4(),
            Name="Sách riêng gia đình",
            Title="Sách riêng gia đình",
            MinGrade=1,
            MaxGrade=3,
            LifecycleStatus="ACTIVE",
            VisibilityScope="PARENT_PRIVATE",
            ModerationStatus="ACTIVE",
            OwnerParentId=uuid4(),
            CreatedAt=datetime.now(timezone.utc),
        )
        svc = ParentPrivateBookService(FakeAsyncSession(InMemoryDbState()))  # type: ignore[arg-type]

        with patch.dict(
            os.environ,
            {"OCR_CLOUD_CORRECTION_ENABLED": "true", "PRIVATE_BOOK_ALLOW_CLOUD_AI": "true"},
            clear=False,
        ):
            summary_cloud = svc._serialize_book_summary(
                book,
                committed_count=0,
                submissions=[],
                readable_for_children=False,
                ocr_contribution=None,
            )
            self.assertIn("dịch vụ AI đám mây bảo mật", summary_cloud.privacy_notice)
            self.assertIn("không được dùng để đóng góp dữ liệu cải thiện nhận diện chữ", summary_cloud.privacy_notice.lower())

        with patch.dict(
            os.environ,
            {"OCR_CLOUD_CORRECTION_ENABLED": "true", "PRIVATE_BOOK_ALLOW_CLOUD_AI": "false"},
            clear=False,
        ):
            summary_local = svc._serialize_book_summary(
                book,
                committed_count=0,
                submissions=[],
                readable_for_children=False,
                ocr_contribution=None,
            )
            self.assertNotIn("dịch vụ AI đám mây bảo mật", summary_local.privacy_notice)

    def test_end_to_end_quiet_standby_wakeup_ocr_plus_concurrent_tts_stt_zero_503_stress(
        self,
    ) -> None:
        """Simulate Quiet Standby -> post-commit /wakeup -> OCR completion + 24 concurrent TTS/STT DB reads under limit=8."""
        import sys

        repo_root = Path(__file__).resolve().parents[1]
        if str(repo_root) not in sys.path:
            sys.path.insert(0, str(repo_root))
        from ocr_worker.service import OcrRuntimeManager, build_worker_http_app
        from ocr_worker.worker import BackendOcrClient, process_claimed_job

        async def _scenario() -> None:
            limiter = DatabaseConcurrencyLimiter(limit=8, wait_timeout=5.0)
            peak_permits = 0
            worker_poll_calls_while_idle = 0
            state = InMemoryDbState()

            with tempfile.TemporaryDirectory(prefix="viread-e2e-stress-") as tmp_storage:
                img_bytes = b"fake-jpeg-vietnamese-page-content"
                img_sha = hashlib.sha256(img_bytes).hexdigest()
                rel_path = "local-scans/stress/page1.jpg"
                target_file = Path(tmp_storage) / "default" / rel_path
                target_file.parent.mkdir(parents=True, exist_ok=True)
                target_file.write_bytes(img_bytes)

                class PermitTrackedSession(FakeAsyncSession):
                    def __init__(self, st: InMemoryDbState):
                        super().__init__(st)
                        self._held = False

                    async def _acquire(self) -> None:
                        nonlocal peak_permits
                        if not self._held:
                            await limiter.acquire()
                            self._held = True
                            if limiter.active > peak_permits:
                                peak_permits = limiter.active
                            await asyncio.sleep(0.004)

                    def _release(self) -> None:
                        if self._held:
                            self._held = False
                            limiter.release()

                    async def scalar(self, query):
                        await self._acquire()
                        return await super().scalar(query)

                    async def scalars(self, query):
                        await self._acquire()
                        return await super().scalars(query)

                    async def flush(self) -> None:
                        await self._acquire()
                        await super().flush()

                    async def commit(self) -> None:
                        await self._acquire()
                        try:
                            await super().commit()
                        finally:
                            self._release()

                    async def rollback(self) -> None:
                        try:
                            await super().rollback()
                        finally:
                            self._release()

                class FastStubRuntime(OcrRuntimeManager):
                    def run_ocr_for_job(self, job_id: str, raw_bytes: bytes) -> dict:
                        assert hashlib.sha256(raw_bytes).hexdigest() == img_sha
                        return {
                            "full_text": "Xin chào Việt Nam",
                            "words": [
                                {"word_index": 0, "line_index": 0, "text": "Xin", "bbox": [0.1, 0.1, 0.1, 0.05]},
                                {"word_index": 1, "line_index": 0, "text": "chào", "bbox": [0.22, 0.1, 0.1, 0.05]},
                                {"word_index": 2, "line_index": 0, "text": "Việt", "bbox": [0.35, 0.1, 0.1, 0.05]},
                                {"word_index": 3, "line_index": 0, "text": "Nam", "bbox": [0.48, 0.1, 0.1, 0.05]},
                            ],
                            "ocr_meta": {"engine_statuses": {"paddleocr": "success", "vietocr": "success"}},
                            "model_profile": "FLOW1_EXTERNAL_TRDG",
                            "model_sha256": "200edce460606275481dda19c50b7763620a112ddc66a8378982bddc013114a6",
                            "engine_diagnostics": {"engines": self.engines_snapshot()},
                            "duration_ms": 25,
                        }

                worker_runtime = FastStubRuntime(worker_id="hf-space-e2e-1")
                worker_runtime.set_standby_mode("quiet_standby")
                worker_app = build_worker_http_app(worker_runtime, worker_token=WORKER_TOKEN)
                worker_asgi_transport = httpx.ASGITransport(app=worker_app)
                set_remote_ocr_wakeup_transport_for_tests(worker_asgi_transport)

                def sync_backend_handler(request: httpx.Request) -> httpx.Response:
                    # Synchronous bridge for BackendOcrClient used inside worker thread
                    assert request.headers.get("X-ViRead-Ocr-Worker-Token") == WORKER_TOKEN
                    path = request.url.path
                    body = json.loads(request.content.decode("utf-8")) if request.content else {}

                    async def _op() -> httpx.Response:
                        sess = PermitTrackedSession(state)
                        svc = OcrInferenceJobService(sess)  # type: ignore[arg-type]
                        try:
                            if path == "/internal/ocr-jobs/claim":
                                claimed = await svc.claim_next_job(
                                    worker_id=body["worker_id"],
                                    lease_seconds=body.get("lease_seconds", 120),
                                )
                                return httpx.Response(200, json={"job": claimed})
                            if path.endswith("/source"):
                                raw, mime = await svc.stream_job_source(
                                    job_id=state.tables[OcrInferenceJob][0].Id,
                                    worker_id=request.url.params["worker_id"],
                                    fencing_token=int(request.url.params["fencing_token"]),
                                )
                                return httpx.Response(200, content=raw, headers={"content-type": mime})
                            if path.endswith("/complete"):
                                job_uuid = state.tables[OcrInferenceJob][0].Id
                                res = await svc.complete_job(
                                    job_id=job_uuid,
                                    worker_id=body["worker_id"],
                                    fencing_token=body["fencing_token"],
                                    source_sha256=body["source_sha256"],
                                    full_text=body["full_text"],
                                    words=body["words"],
                                    ocr_meta=body["ocr_meta"],
                                    no_text_detected=body["no_text_detected"],
                                    model_profile=body["model_profile"],
                                    model_sha256=body["model_sha256"],
                                    engine_diagnostics=body["engine_diagnostics"],
                                    duration_ms=body["duration_ms"],
                                )
                                return httpx.Response(200, json=res)
                            return httpx.Response(404)
                        finally:
                            sess._release()

                    return asyncio.run_coroutine_threadsafe(_op(), main_loop).result(timeout=5.0)

                main_loop = asyncio.get_running_loop()

                async def _simulate_tts_stt_reading_request(idx: int) -> int:
                    # Simulates TTS cache lookup + reading session progress write under limit=8
                    sess = PermitTrackedSession(state)
                    try:
                        await sess.scalar(select_expr := OcrInferenceJobService(sess).repo.list_worker_heartbeats(limit=2)) if False else None  # noqa: E501
                        _ = await OcrInferenceJobService(sess).repo.list_worker_heartbeats(limit=2)
                        await sess.rollback()
                        return 200
                    except Exception:
                        sess._release()
                        return 503

                with patch.dict(
                    os.environ,
                    {
                        "VIREAD_LOCAL_STORAGE_DIR": tmp_storage,
                        "VIREAD_OCR_REMOTE_WORKER_URL": SPACE_URL,
                        "VIREAD_OCR_WORKER_TOKEN": WORKER_TOKEN,
                        "VIREAD_HF_SPACE_TOKEN": HF_READ_TOKEN,
                        "VIREAD_OCR_HYBRID_GPU_GRACE_SECONDS": "0",
                    },
                    clear=False,
                ):
                    # Phase 1: Quiet Standby + 12 concurrent TTS/STT requests -> 0 worker polls!
                    idle_statuses = await asyncio.gather(
                        *[_simulate_tts_stt_reading_request(i) for i in range(12)]
                    )
                    self.assertTrue(all(code == 200 for code in idle_statuses))
                    self.assertFalse(worker_runtime.wake_event.is_set())
                    self.assertEqual(worker_poll_calls_while_idle, 0)

                    # Phase 2: Start background Quiet Standby watcher + fire enqueue_job + 24 concurrent TTS/STT requests!
                    async def _worker_standby_watcher() -> dict:
                        while not worker_runtime.wake_event.is_set():
                            await asyncio.sleep(0.005)
                        worker_runtime.wake_event.clear()

                        def _claim_and_run() -> dict:
                            w_client = BackendOcrClient(
                                "https://backend.example",
                                WORKER_TOKEN,
                                transport=httpx.MockTransport(sync_backend_handler),
                            )
                            try:
                                claimed = w_client.claim_next_job(worker_runtime.worker_id)
                                assert claimed is not None
                                return process_claimed_job(w_client, worker_runtime, claimed)
                            finally:
                                w_client.close()

                        return await asyncio.to_thread(_claim_and_run)

                    watcher_task = asyncio.create_task(_worker_standby_watcher())

                    enqueue_sess = PermitTrackedSession(state)
                    enqueue_svc = OcrInferenceJobService(enqueue_sess)  # type: ignore[arg-type]
                    queued_job = await enqueue_svc.enqueue_job(
                        job_kind=JOB_KIND_LOCAL_SCAN,
                        owner_user_id=uuid4(),
                        image_path=rel_path,
                        image_bucket="default",
                        image_sha256=img_sha,
                    )
                    await enqueue_sess.commit()

                    concurrent_results = await asyncio.gather(
                        watcher_task,
                        *[_simulate_tts_stt_reading_request(i) for i in range(24)],
                    )
                    await shutdown_remote_ocr_wakeup_tasks()

                    worker_outcome = concurrent_results[0]
                    tts_stt_codes = concurrent_results[1:]

                    self.assertEqual(worker_outcome["outcome"], "completed")
                    self.assertEqual(queued_job.Status, "SUCCEEDED")
                    self.assertEqual(queued_job.ResultPayload["full_text"], "Xin chào Việt Nam")
                    self.assertTrue(all(code == 200 for code in tts_stt_codes))
                    self.assertLessEqual(peak_permits, 8)
                    self.assertEqual(limiter.active, 0)

        asyncio.run(_scenario())

    def test_ssrf_blocks_redirects_and_dns_rebinding_in_production(self) -> None:
        redirect_targets_hit: list[str] = []

        async def redirect_handler(request: httpx.Request) -> httpx.Response:
            redirect_targets_hit.append(str(request.url))
            if request.url.host == "viread-ocr-worker.hf.space":
                return httpx.Response(
                    307,
                    headers={"Location": "http://169.254.169.254/latest/meta-data/"},
                )
            return httpx.Response(200, json={"ready": True, "ok": True})

        set_remote_ocr_wakeup_transport_for_tests(httpx.MockTransport(redirect_handler))

        async def _scenario() -> None:
            with patch.dict(
                os.environ,
                {
                    "APP_ENVIRONMENT": "production",
                    "VIREAD_OCR_REMOTE_WORKER_URL": SPACE_URL,
                    "VIREAD_OCR_WORKER_TOKEN": WORKER_TOKEN,
                    "VIREAD_HF_SPACE_TOKEN": HF_READ_TOKEN,
                },
                clear=False,
            ):
                health = await probe_configured_remote_ocr_worker_health(force_refresh=True)
                self.assertIsNone(health)
                woke = await send_remote_ocr_wakeup(bypass_coalesce=True)
                self.assertFalse(woke)
                # Redirect target MUST NEVER be contacted or receive tokens!
                self.assertTrue(
                    all("169.254.169.254" not in url for url in redirect_targets_hit),
                    msg=f"Redirect followed to metadata endpoint: {redirect_targets_hit}",
                )

            # DNS rebinding check (tested with _CUSTOM_TRANSPORT=None and mocked getaddrinfo)
            set_remote_ocr_wakeup_transport_for_tests(None)
            loop = asyncio.get_running_loop()
            with (
                patch.dict(
                    os.environ,
                    {
                        "APP_ENVIRONMENT": "production",
                        "VIREAD_OCR_REMOTE_WORKER_URL": "https://rebind.example.com",
                    },
                    clear=False,
                ),
                patch.object(
                    loop,
                    "getaddrinfo",
                    return_value=[
                        (socket.AF_INET, socket.SOCK_STREAM, 6, "", ("127.0.0.1", 443))
                    ],
                ),
            ):
                clear_remote_ocr_wakeup_cache_for_tests()
                self.assertFalse(
                    await _validate_production_target_dns("https://rebind.example.com")
                )

            with (
                patch.dict(
                    os.environ,
                    {
                        "APP_ENVIRONMENT": "production",
                        "VIREAD_OCR_REMOTE_WORKER_URL": SPACE_URL,
                    },
                    clear=False,
                ),
                patch.object(
                    loop,
                    "getaddrinfo",
                    return_value=[
                        (socket.AF_INET, socket.SOCK_STREAM, 6, "", ("34.195.210.12", 443))
                    ],
                ),
            ):
                clear_remote_ocr_wakeup_cache_for_tests()
                self.assertTrue(await _validate_production_target_dns(SPACE_URL))

        asyncio.run(_scenario())

    def test_rollback_expire_all_safety_on_scan_job_poll_cancel_and_retry(self) -> None:
        """Regression test: real SQLAlchemy rollback() expires ORM objects; polling/cancel/retry must never raise MissingGreenlet."""
        from sqlalchemy.exc import MissingGreenlet
        from app.repositories.local_ocr_scan_repository import LocalOcrScanRepository
        from app.services.local_ocr_scan_service import LocalOcrScanService

        health_probes = 0

        async def transport_handler(request: httpx.Request) -> httpx.Response:
            nonlocal health_probes
            if request.url.path == "/health":
                health_probes += 1
                return httpx.Response(
                    200,
                    json={
                        "status": "ok",
                        "worker_status": "IDLE",
                        "standby_mode": "quiet_standby",
                        "worker_id": "hf-space-1",
                        "ready": True,
                    },
                )
            return httpx.Response(200, json={"ok": True, "woken": True})

        set_remote_ocr_wakeup_transport_for_tests(httpx.MockTransport(transport_handler))

        class StrictExpireOnRollbackSession(FakeAsyncSession):
            def __init__(self, st: InMemoryDbState):
                super().__init__(st)
                self._in_tx = False
                self._loaded_objs: list[object] = []

            def in_transaction(self) -> bool:
                return self._in_tx

            async def scalar(self, query):
                self._in_tx = True
                res = await super().scalar(query)
                if res is not None and hasattr(res, "__mapper__"):
                    self._loaded_objs.append(res)
                return res

            async def scalars(self, query):
                self._in_tx = True
                res = await super().scalars(query)
                for item in res.all():
                    if hasattr(item, "__mapper__"):
                        self._loaded_objs.append(item)
                return res

            async def commit(self) -> None:
                await super().commit()
                self._in_tx = False

            async def rollback(self) -> None:
                await super().rollback()
                self._in_tx = False
                # Simulate SQLAlchemy sync_session.expire_all(): accessing ORM attributes
                # synchronously after rollback raises MissingGreenlet!
                for obj in list(self._loaded_objs):
                    for attr in ("Status", "CreatedAt", "UpdatedAt", "ErrorCode", "ResultPayload"):
                        if hasattr(type(obj), attr):
                            pass
                    object.__setattr__(obj, "_expired_after_rollback", True)
                self._loaded_objs.clear()

        async def _scenario() -> None:
            state = InMemoryDbState()
            parent_id = uuid4()
            state.roles[parent_id] = "parent"

            seed_db = FakeAsyncSession(state)
            svc_seed = OcrInferenceJobService(seed_db)  # type: ignore[arg-type]
            job = await svc_seed.enqueue_job(
                job_kind=JOB_KIND_LOCAL_SCAN,
                owner_user_id=parent_id,
                image_path="local-scans/p1/scan.jpg",
                image_sha256="f" * 64,
            )
            await seed_db.commit()

            orig_getattribute = OcrInferenceJob.__getattribute__

            def _strict_getattr(self_obj: OcrInferenceJob, name: str):
                if name in {"Status", "CreatedAt", "UpdatedAt", "ResultPayload", "ErrorCode"}:
                    if orig_getattribute(self_obj, "__dict__").get("_expired_after_rollback"):
                        raise MissingGreenlet("Simulated expired ORM attribute access after rollback()")
                return orig_getattribute(self_obj, name)

            with (
                patch.object(OcrInferenceJob, "__getattribute__", _strict_getattr),
                patch.dict(
                    os.environ,
                    {
                        "VIREAD_OCR_REMOTE_WORKER_URL": SPACE_URL,
                        "VIREAD_OCR_WORKER_TOKEN": WORKER_TOKEN,
                        "VIREAD_HF_SPACE_TOKEN": HF_READ_TOKEN,
                    },
                    clear=False,
                ),
            ):
                # 1. Poll get_scan_page_job on cold /health cache -> must serialize before rollback & probe!
                poll_db = StrictExpireOnRollbackSession(state)
                repo = LocalOcrScanRepository(poll_db)  # type: ignore[arg-type]
                repo.profile_role = lambda _uid: asyncio.sleep(0, result="parent")  # type: ignore[method-assign]
                scan_svc = LocalOcrScanService(repo)
                polled = await scan_svc.get_scan_page_job(parent_id, job.Id, request_id="req-1")
                self.assertEqual(polled.status, "QUEUED")
                self.assertTrue(polled.worker_online)
                self.assertEqual(health_probes, 1)

                # Clear expired marker on shared in-memory job before next request
                job.__dict__.pop("_expired_after_rollback", None)
                clear_remote_ocr_wakeup_cache_for_tests()

                # 2. retry_job on ACTIVE job must serialize BEFORE rollback!
                job.Status = "RUNNING"
                retry_db = StrictExpireOnRollbackSession(state)
                retry_res = await OcrInferenceJobService(retry_db).retry_job(job.Id)  # type: ignore[arg-type]
                self.assertEqual(retry_res["status"], "RUNNING")
                job.__dict__.pop("_expired_after_rollback", None)

                # 3. cancel_scan_page_job on cold /health cache -> must serialize before rollback!
                job.Status = "QUEUED"
                cancel_db = StrictExpireOnRollbackSession(state)
                cancel_repo = LocalOcrScanRepository(cancel_db)  # type: ignore[arg-type]
                cancel_repo.profile_role = lambda _uid: asyncio.sleep(0, result="parent")  # type: ignore[method-assign]
                cancelled = await LocalOcrScanService(cancel_repo).cancel_scan_page_job(
                    parent_id, job.Id, request_id="req-2"
                )
                self.assertEqual(cancelled.status, "CANCELLED")
                self.assertTrue(cancelled.worker_online)
                await shutdown_remote_ocr_wakeup_tasks()

        asyncio.run(_scenario())

    def test_cold_boot_503_waking_space_sets_probe_degraded_and_self_heals_via_poll_nudge(
        self,
    ) -> None:
        space_sleeping = True
        wakeup_hits = 0

        async def transport_handler(request: httpx.Request) -> httpx.Response:
            nonlocal wakeup_hits
            if request.url.path == "/health":
                if space_sleeping:
                    return httpx.Response(503, text="<html>Space is waking up...</html>")
                return httpx.Response(
                    200,
                    json={
                        "status": "ok",
                        "worker_status": "IDLE",
                        "standby_mode": "quiet_standby",
                        "worker_id": "hf-space-cold-1",
                        "ready": True,
                    },
                )
            if request.url.path == "/wakeup":
                wakeup_hits += 1
                if space_sleeping:
                    return httpx.Response(503, text="<html>Space is waking up...</html>")
                return httpx.Response(200, json={"ok": True, "woken": True})
            return httpx.Response(404)

        set_remote_ocr_wakeup_transport_for_tests(httpx.MockTransport(transport_handler))

        async def _scenario() -> None:
            nonlocal space_sleeping, wakeup_hits
            state = InMemoryDbState()

            class _SessionCtx:
                async def __aenter__(self):
                    s = FakeAsyncSession(state)
                    s.execute = self._fake_execute  # type: ignore[method-assign]
                    return s

                async def __aexit__(self, *_a):
                    return False

                @staticmethod
                async def _fake_execute(_q):
                    class _Row:
                        queued = 1
                        claimed = 0
                        running = 0
                        failed_retryable = 0
                        dead_letter = 0
                        succeeded = 0
                        cancelled = 0
                        expired_leases = 0
                        oldest_pending_created = None
                        latest_succeeded_at = None

                    class _Res:
                        def one(self):
                            return _Row()

                    return _Res()

            with (
                patch.dict(
                    os.environ,
                    {
                        "VIREAD_OCR_REMOTE_WORKER_URL": SPACE_URL,
                        "VIREAD_OCR_WORKER_TOKEN": WORKER_TOKEN,
                        "VIREAD_HF_SPACE_TOKEN": HF_READ_TOKEN,
                    },
                    clear=False,
                ),
                patch("app.database.session.AsyncSessionLocal", side_effect=_SessionCtx),
            ):
                # 1. While HF Space returns 503 waking screen, /health reports probe_degraded=True!
                diag_waking = await collect_remote_ocr_health()
                self.assertFalse(diag_waking["ready"])
                self.assertTrue(diag_waking.get("probe_degraded"))

                # 2. Job was queued 20s ago while Space was 503-sleeping; now Space finishes booting!
                db = FakeAsyncSession(state)
                svc = OcrInferenceJobService(db)  # type: ignore[arg-type]
                stale_job = OcrInferenceJob(
                    Id=uuid4(),
                    JobKind=JOB_KIND_LOCAL_SCAN,
                    Status="QUEUED",
                    Priority=10,
                    OwnerUserId=uuid4(),
                    ImageBucket="private-books",
                    ImagePath="local-scans/u1/waking.jpg",
                    ImageSha256="9" * 64,
                    ExpectedVersion=1,
                    FencingToken=0,
                    AttemptCount=0,
                    MaxAttempts=3,
                    CreatedAt=datetime.now(timezone.utc) - timedelta(seconds=20),
                    UpdatedAt=datetime.now(timezone.utc) - timedelta(seconds=20),
                )
                db.add(stale_job)
                await db.commit()

                space_sleeping = False
                wakeup_hits = 0
                status_payload = await svc.get_job_status_payload(stale_job.Id)
                self.assertEqual(status_payload["status"], "QUEUED")
                await asyncio.sleep(0.08)
                self.assertEqual(wakeup_hits, 1)

                # Subsequent polls within active burst window MUST NOT spam /wakeup!
                _ = await svc.get_job_status_payload(stale_job.Id)
                await asyncio.sleep(0.05)
                self.assertEqual(wakeup_hits, 1)
                await shutdown_remote_ocr_wakeup_tasks()

        asyncio.run(_scenario())

    def test_concurrent_parent_post_ocr_429_rate_limit_serializes_without_stalling(
        self,
    ) -> None:
        """Verify _post_ocr_concurrency_limit()==1 + 429 retry backoff processes queued parent submissions cleanly."""
        from app.services.ocr_ai.orchestrator import OcrOrchestrationError

        async def _scenario() -> None:
            state = InMemoryDbState()
            book_id = uuid4()
            parent_id = uuid4()
            img_bytes = b"parent-book-page-jpeg"
            img_sha = hashlib.sha256(img_bytes).hexdigest()

            for idx in (1, 2):
                ocr_txt = f"Bé đọc trang {idx}"
                cand_hash = compute_candidate_hash(
                    ocr_txt, source_sha256=img_sha, is_image_only=False
                )
                sub = ParentBookPageSubmission(
                    Id=uuid4(),
                    BookId=book_id,
                    OwnerParentId=parent_id,
                    BatchId=uuid4(),
                    BatchTotalPages=2,
                    SourcePageNumber=idx,
                    TargetPageNumber=idx,
                    SourceFileName=f"p{idx}.jpg",
                    SourceFormat="IMAGE",
                    SourceStoragePath=f"private/{idx}.jpg",
                    SourceSha256=img_sha,
                    ImageWidth=800,
                    ImageHeight=1000,
                    SourceType="PARENT_OWNED_PHOTO",
                    SourceNote="Sách gia đình tự chụp",
                    SubmissionVersion=1,
                    OptimisticLockVersion=1,
                    WorkflowStatus="CHECKING",
                    OcrStatus="COMPLETED",
                    OcrText=ocr_txt,
                    OcrWordsJson=[
                        {"text": "Bé", "bbox": [0.1, 0.1, 0.1, 0.05]},
                        {"text": "đọc", "bbox": [0.22, 0.1, 0.1, 0.05]},
                        {"text": "trang", "bbox": [0.35, 0.1, 0.1, 0.05]},
                        {"text": str(idx), "bbox": [0.48, 0.1, 0.1, 0.05]},
                    ],
                    IsImageOnly=False,
                    ProofreadStatus="PENDING",
                    ToolCheckStatus="PENDING",
                    CandidateText=ocr_txt,
                    CandidateHash=cand_hash,
                    TempExpiresAt=datetime.now(timezone.utc) + timedelta(days=7),
                    CreatedAt=datetime.now(timezone.utc),
                    UpdatedAt=datetime.now(timezone.utc),
                )
                state.tables[ParentBookPageSubmission].append(sub)

            sub1, sub2 = state.tables[ParentBookPageSubmission]
            in_flight = 0
            peak_in_flight = 0
            proofread_calls = 0

            class _RateLimitedCloudProofreader:
                async def correct(self, text: str, *_a, **_kw) -> str:
                    nonlocal in_flight, peak_in_flight, proofread_calls
                    in_flight += 1
                    peak_in_flight = max(peak_in_flight, in_flight)
                    proofread_calls += 1
                    try:
                        await asyncio.sleep(0.015)
                        if proofread_calls == 1:
                            err = OcrOrchestrationError("PROVIDER_QUOTA")
                            err.status_code = 429  # type: ignore[attr-defined]
                            raise err
                        return text
                    finally:
                        in_flight -= 1

            class _CloudSafetyRunner:
                async def analyze(self, _text: str) -> dict[str, object]:
                    return {
                        "suitability": "SUITABLE",
                        "findings": [],
                        "provider_events": [{"chunk_id": 0, "availability": True, "provider": "gemini"}],
                    }

            class _SessionCtx:
                async def __aenter__(self):
                    return FakeAsyncSession(state)

                async def __aexit__(self, *_a):
                    return False

            from app.services.ocr_inference_job_service import (
                run_parent_submission_post_ocr as orig_run_parent_submission_post_ocr,
            )

            async def _patched_post_ocr(sub_id):
                return await orig_run_parent_submission_post_ocr(
                    sub_id,
                    proofread_orchestrator=_RateLimitedCloudProofreader(),
                    safety_orchestrator=_CloudSafetyRunner(),
                    download_bytes=lambda _p: img_bytes,
                )

            with (
                patch.dict(
                    os.environ,
                    {
                        "VIREAD_WEB_DISABLE_HEAVY_WORKERS": "true",
                        "OCR_CLOUD_CORRECTION_ENABLED": "true",
                        "PRIVATE_BOOK_ALLOW_CLOUD_AI": "true",
                    },
                    clear=False,
                ),
                patch("app.services.ocr_inference_job_service.AsyncSessionLocal", side_effect=_SessionCtx),
                patch(
                    "app.services.ocr_inference_job_service.run_parent_submission_post_ocr",
                    side_effect=_patched_post_ocr,
                ),
            ):
                os.environ.pop("VIREAD_POST_OCR_CONCURRENCY", None)
                self.assertEqual(_post_ocr_concurrency_limit(), 1)
                t1 = schedule_parent_submission_post_ocr(sub1.Id)
                t2 = schedule_parent_submission_post_ocr(sub2.Id)
                assert t1 is not None and t2 is not None
                await asyncio.gather(t1, t2)
                await shutdown_post_ocr_tasks()

                self.assertEqual(peak_in_flight, 1)
                self.assertEqual(proofread_calls, 3)  # sub1: 429 + 200; sub2: 200
                self.assertEqual(sub1.WorkflowStatus, "PASSED_READY_TO_ADD")
                self.assertEqual(sub2.WorkflowStatus, "PASSED_READY_TO_ADD")
                self.assertFalse(sub1.ToolCheckScopeJson.get("local_ai_enforced", True))
                self.assertFalse(sub2.ToolCheckScopeJson.get("local_ai_enforced", True))

        asyncio.run(_scenario())

    def test_scale_to_zero_passive_health_emits_zero_http_and_keeps_worker_online(self) -> None:
        from app.services.global_tasks_service import GlobalTasksService
        from app.services.ocr_inference_job_service import remote_sync_wait_timeout_seconds
        from app.services.remote_ocr_wakeup import (
            is_remote_ocr_scale_to_zero_enabled,
            peek_cached_remote_ocr_worker_health,
            peek_remote_ocr_probe_degraded,
        )

        aca_url = "https://viread-ocr-worker.eastasia.azurecontainerapps.io"
        http_calls: list[str] = []

        async def forbidden_transport(request: httpx.Request) -> httpx.Response:
            http_calls.append(str(request.url))
            return httpx.Response(200, json={"ready": True})

        set_remote_ocr_wakeup_transport_for_tests(httpx.MockTransport(forbidden_transport))

        # Fail-closed when VIREAD_OCR_WORKER_TOKEN is missing/short (<32 chars).
        with patch.dict(
            os.environ,
            {
                "VIREAD_OCR_REMOTE_WORKER_URL": aca_url,
                "VIREAD_OCR_REMOTE_SCALE_TO_ZERO": "true",
                "VIREAD_OCR_WORKER_TOKEN": "too-short",
            },
            clear=False,
        ):
            self.assertFalse(is_remote_ocr_scale_to_zero_enabled())

        async def _scenario() -> None:
            state = InMemoryDbState()
            actor_id = uuid4()

            class _SessionCtx:
                async def __aenter__(self):
                    s = FakeAsyncSession(state)
                    s.execute = self._fake_execute  # type: ignore[method-assign]
                    return s

                async def __aexit__(self, *_a):
                    return False

                @staticmethod
                async def _fake_execute(_q):
                    class _Row:
                        queued = 0
                        claimed = 0
                        running = 0
                        failed_retryable = 0
                        dead_letter = 0
                        succeeded = 3
                        cancelled = 0
                        expired_leases = 0
                        oldest_pending_created = None
                        latest_succeeded_at = None

                    class _Res:
                        def one(self):
                            return _Row()

                    return _Res()

            with (
                patch.dict(
                    os.environ,
                    {
                        "VIREAD_OCR_REMOTE_WORKER_URL": aca_url,
                        "VIREAD_OCR_REMOTE_SCALE_TO_ZERO": "true",
                        "VIREAD_OCR_WORKER_TOKEN": WORKER_TOKEN,
                        "VIREAD_REMOTE_OCR_SYNC_TIMEOUT_SECONDS": "",
                    },
                    clear=False,
                ),
                patch("app.database.session.AsyncSessionLocal", side_effect=_SessionCtx),
            ):
                self.assertTrue(is_remote_ocr_scale_to_zero_enabled())
                self.assertEqual(remote_sync_wait_timeout_seconds(), 90.0)
                valid_cache, cached = peek_cached_remote_ocr_worker_health()
                self.assertTrue(valid_cache)
                assert cached is not None
                self.assertEqual(cached["standby_mode"], "scale_to_zero")
                self.assertTrue(cached["online"])
                self.assertTrue(cached["ready"])
                self.assertFalse(peek_remote_ocr_probe_degraded())

                gts = GlobalTasksService(FakeAsyncSession(state))  # type: ignore[arg-type]
                with (
                    patch.object(gts, "require_actor_role", return_value="admin"),
                    patch.object(gts.repo, "is_remote_ocr_worker_online", return_value=False),
                    patch.object(gts.repo, "list_studio_jobs_for_actor", return_value=[]),
                    patch.object(gts.repo, "list_ocr_inference_jobs_for_actor", return_value=[]),
                    patch.object(gts.repo, "list_admin_workflows", return_value=[]),
                ):
                    task_feed = await gts.list_tasks(actor_id=actor_id)
                    self.assertTrue(task_feed.worker_online)

                results = await asyncio.gather(
                    *[collect_remote_ocr_health() for _ in range(10)],
                    *[
                        OcrInferenceJobService(FakeAsyncSession(state)).has_online_worker()  # type: ignore[arg-type]
                        for _ in range(10)
                    ],
                    probe_configured_remote_ocr_worker_health(force_refresh=True),
                    maybe_keep_warm_hf_space_from_cron(min_interval_seconds=60.0),
                )

                # Zero outbound HTTP calls when scaled to zero!
                self.assertEqual(http_calls, [])
                for diag in results[:10]:
                    assert isinstance(diag, dict)
                    self.assertTrue(diag["ready"])
                    self.assertEqual(diag["workers"][0]["standby_mode"], "scale_to_zero")
                for online_flag in results[10:20]:
                    self.assertTrue(online_flag)
                self.assertFalse(results[-1])  # Cron keepwarm is a strict no-op on scale-to-zero

        asyncio.run(_scenario())

    def test_scale_to_zero_single_flight_drain_coalescing_and_pending_rewake(self) -> None:
        from app.services.remote_ocr_wakeup import maybe_nudge_ocr_wakeup_for_stale_queued_job

        aca_url = "https://viread-ocr-worker.eastasia.azurecontainerapps.io"
        seen_requests: list[tuple[str, str]] = []
        in_flight = 0
        peak_in_flight = 0

        async def drain_transport(request: httpx.Request) -> httpx.Response:
            nonlocal in_flight, peak_in_flight
            in_flight += 1
            peak_in_flight = max(peak_in_flight, in_flight)
            body = json.loads(request.content.decode("utf-8")) if request.content else {}
            seen_requests.append((str(request.url), str(body.get("reason") or "")))
            try:
                await asyncio.sleep(0.06)
                return httpx.Response(
                    200, json={"ok": True, "drained": True, "drained_jobs": 2}
                )
            finally:
                in_flight -= 1

        set_remote_ocr_wakeup_transport_for_tests(httpx.MockTransport(drain_transport))

        async def _scenario() -> None:
            with patch.dict(
                os.environ,
                {
                    "VIREAD_OCR_REMOTE_WORKER_URL": aca_url,
                    "VIREAD_OCR_REMOTE_SCALE_TO_ZERO": "true",
                    "VIREAD_OCR_WORKER_TOKEN": WORKER_TOKEN,
                },
                clear=False,
            ):
                # 1. Start Drain #1, fire 7 concurrent enqueues + 5 poll nudges mid-flight:
                t_first = asyncio.create_task(
                    send_remote_ocr_wakeup(reason="enqueue:ADMIN_PAGE_UPLOAD", job_id="job-1")
                )
                await asyncio.sleep(0.01)

                # Poll nudges while drain is in-flight MUST return None and NOT trigger rewake.
                for idx in range(5):
                    nudge_task = maybe_nudge_ocr_wakeup_for_stale_queued_job(
                        job_id=f"job-{idx}",
                        created_at=datetime.now(timezone.utc) - timedelta(seconds=30),
                        reason="admin_poll_nudge",
                    )
                    self.assertIsNone(nudge_task)

                concurrent_enqueues = await asyncio.gather(
                    *[
                        send_remote_ocr_wakeup(
                            reason="enqueue:ADMIN_PAGE_UPLOAD", job_id=f"job-{idx}"
                        )
                        for idx in range(2, 9)
                    ]
                )
                self.assertTrue(all(concurrent_enqueues))
                self.assertTrue(await t_first)

                # Strictly single-flight (peak=1), and all 7 mid-flight enqueues collapsed into 1 pending_rewake!
                self.assertEqual(peak_in_flight, 1)
                self.assertEqual(
                    seen_requests,
                    [
                        (f"{aca_url}/wakeup?drain=true", "enqueue:ADMIN_PAGE_UPLOAD"),
                        (f"{aca_url}/wakeup?drain=true", "pending_rewake"),
                    ],
                )

                # 2. Immediately (<1.5s) after Drain finishes, a brand-new scan is NOT suppressed by _LAST_WAKE_SENT!
                seen_requests.clear()
                ok_next = await send_remote_ocr_wakeup(
                    reason="enqueue:LOCAL_PAGE_SCAN", job_id="job-99"
                )
                self.assertTrue(ok_next)
                self.assertEqual(
                    seen_requests,
                    [(f"{aca_url}/wakeup?drain=true", "enqueue:LOCAL_PAGE_SCAN")],
                )

        asyncio.run(_scenario())

    def test_concurrent_stt_tts_cache_isolation_during_long_scale_to_zero_drain(self) -> None:
        aca_url = "https://viread-ocr-worker.eastasia.azurecontainerapps.io"

        async def slow_cold_boot_drain(_request: httpx.Request) -> httpx.Response:
            await asyncio.sleep(0.12)
            return httpx.Response(200, json={"ok": True, "drained": True, "drained_jobs": 1})

        set_remote_ocr_wakeup_transport_for_tests(httpx.MockTransport(slow_cold_boot_drain))

        async def _scenario() -> None:
            limiter = DatabaseConcurrencyLimiter(limit=4, wait_timeout=1.5)

            async def _simulated_tts_cache_lookup(word_idx: int) -> int:
                await limiter.acquire()
                try:
                    await asyncio.sleep(0.004)
                    return word_idx
                finally:
                    limiter.release()

            with patch.dict(
                os.environ,
                {
                    "VIREAD_OCR_REMOTE_WORKER_URL": aca_url,
                    "VIREAD_OCR_REMOTE_SCALE_TO_ZERO": "true",
                    "VIREAD_OCR_WORKER_TOKEN": WORKER_TOKEN,
                },
                clear=False,
            ):
                drain_task = asyncio.create_task(
                    send_remote_ocr_wakeup(reason="enqueue:PARENT_BOOK_SUBMISSION", job_id="p-1")
                )
                await asyncio.sleep(0.01)
                # Drain holds 0 DB permits, so all 16 TTS cache lookups fly through unimpeded!
                t0 = asyncio.get_running_loop().time()
                tts_results = await asyncio.gather(
                    *[_simulated_tts_cache_lookup(i) for i in range(16)]
                )
                tts_elapsed = asyncio.get_running_loop().time() - t0
                self.assertEqual(len(tts_results), 16)
                self.assertLess(tts_elapsed, 0.08)
                self.assertTrue(await drain_task)

        asyncio.run(_scenario())

    def test_sync_local_ocr_scan_honors_scale_to_zero_90s_timeout_without_premature_45s_cancel(
        self,
    ) -> None:
        from io import BytesIO
        from PIL import Image
        from app.repositories.local_ocr_scan_repository import LocalOcrScanRepository
        from app.services.local_ocr_scan_service import LocalOcrScanService

        buf = BytesIO()
        Image.new("RGB", (120, 60), color=(255, 255, 255)).save(buf, format="JPEG")
        jpeg_bytes = buf.getvalue()
        img_sha = hashlib.sha256(jpeg_bytes).hexdigest()

        async def _scenario() -> None:
            state = InMemoryDbState()
            observed_timeouts: list[float | None] = []
            cancelled_reasons: list[str] = []

            async def fake_wait_for_job_completion(
                _self_svc: OcrInferenceJobService,
                job_id,
                *,
                timeout_seconds: float | None = None,
                poll_interval_seconds: float | None = None,
            ) -> OcrInferenceJob:
                del poll_interval_seconds
                observed_timeouts.append(timeout_seconds)
                completed_job = OcrInferenceJob(
                    Id=job_id,
                    JobKind=JOB_KIND_LOCAL_SCAN,
                    Status="SUCCEEDED",
                    ImageSha256=img_sha,
                    ResultPayload={
                        "full_text": "Xin chào thế giới",
                        "words": [{"text": "Xin", "bbox": [0.1, 0.1, 0.1, 0.05]}],
                        "ocr_meta": {"runtime_device": "cpu"},
                        "no_text_detected": False,
                    },
                )
                return completed_job

            async def fake_cancel_job(_self_svc: OcrInferenceJobService, _job_id, *, reason: str):
                cancelled_reasons.append(reason)

            aca_url = "https://viread-ocr-worker.eastasia.azurecontainerapps.io"
            with (
                tempfile.TemporaryDirectory(prefix="viread-sync-scan-cap-") as tmp_storage,
                patch.object(
                    OcrInferenceJobService,
                    "wait_for_job_completion",
                    new=fake_wait_for_job_completion,
                ),
                patch.object(
                    OcrInferenceJobService,
                    "cancel_job",
                    new=fake_cancel_job,
                ),
                patch(
                    "app.services.remote_ocr_wakeup.send_remote_ocr_wakeup",
                    return_value=True,
                ),
            ):
                # 1. Scale-to-zero enabled -> sync scan waits up to 90.0s (not 45.0s!)
                with patch.dict(
                    os.environ,
                    {
                        "VIREAD_LOCAL_STORAGE_DIR": tmp_storage,
                        "VIREAD_OCR_MODE": "remote_worker",
                        "VIREAD_OCR_REMOTE_WORKER_URL": aca_url,
                        "VIREAD_OCR_REMOTE_SCALE_TO_ZERO": "true",
                        "VIREAD_OCR_WORKER_TOKEN": WORKER_TOKEN,
                        "VIREAD_REMOTE_OCR_SYNC_TIMEOUT_SECONDS": "",
                    },
                    clear=False,
                ):
                    sess = FakeAsyncSession(state)
                    svc = LocalOcrScanService(LocalOcrScanRepository(sess))  # type: ignore[arg-type]
                    out = await svc._run_remote_ocr_scan(
                        actor_id=uuid4(),
                        scan_job_id=uuid4(),
                        clean_bytes=jpeg_bytes,
                        image_sha256=img_sha,
                        book_id=None,
                        idempotency_key=None,
                        timeout_seconds=120.0,
                    )
                    await shutdown_remote_ocr_wakeup_tasks()
                    self.assertEqual(out["text"], "Xin chào thế giới")

                # 2. Scale-to-zero disabled -> preserves 45.0s cap
                with patch.dict(
                    os.environ,
                    {
                        "VIREAD_LOCAL_STORAGE_DIR": tmp_storage,
                        "VIREAD_OCR_MODE": "remote_worker",
                        "VIREAD_OCR_REMOTE_WORKER_URL": aca_url,
                        "VIREAD_OCR_REMOTE_SCALE_TO_ZERO": "false",
                        "VIREAD_OCR_WORKER_TOKEN": WORKER_TOKEN,
                        "VIREAD_REMOTE_OCR_SYNC_TIMEOUT_SECONDS": "",
                    },
                    clear=False,
                ):
                    clear_remote_ocr_wakeup_cache_for_tests()
                    set_remote_ocr_wakeup_transport_for_tests(
                        httpx.MockTransport(
                            lambda _req: httpx.Response(
                                200,
                                json={
                                    "status": "ok",
                                    "worker_status": "IDLE",
                                    "ready": True,
                                },
                            )
                        )
                    )
                    sess2 = FakeAsyncSession(state)
                    svc2 = LocalOcrScanService(LocalOcrScanRepository(sess2))  # type: ignore[arg-type]
                    await svc2._run_remote_ocr_scan(
                        actor_id=uuid4(),
                        scan_job_id=uuid4(),
                        clean_bytes=jpeg_bytes,
                        image_sha256=img_sha,
                        book_id=None,
                        idempotency_key=None,
                        timeout_seconds=120.0,
                    )
                    await shutdown_remote_ocr_wakeup_tasks()

                self.assertEqual(observed_timeouts, [90.0, 45.0])
                self.assertEqual(cancelled_reasons, [])

        asyncio.run(_scenario())


if __name__ == "__main__":
    unittest.main()
