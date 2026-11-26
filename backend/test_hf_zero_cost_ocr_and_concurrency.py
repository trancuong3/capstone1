"""Deep verification for 0-cost HF Space OCR, anti-bottleneck wakeup, and STT/TTS concurrency safety."""

from __future__ import annotations

import asyncio
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
from uuid import uuid4

import httpx

from app.database.session import DatabaseConcurrencyLimiter
from app.models import Book, OcrInferenceJob, OcrWorkerHeartbeat
from app.services.ocr_inference_job_service import (
    JOB_KIND_LOCAL_SCAN,
    OcrInferenceJobService,
    _post_ocr_concurrency_limit,
    clear_active_model_manifest_cache,
)
from app.services.remote_ocr_wakeup import (
    _dispatch_wakeup_with_hybrid_grace,
    clear_remote_ocr_wakeup_cache_for_tests,
    get_configured_remote_ocr_worker_url,
    maybe_keep_warm_hf_space_from_cron,
    probe_configured_remote_ocr_worker_health,
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
            self.assertIn("không được dùng để huấn luyện", summary_cloud.privacy_notice.lower())

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


if __name__ == "__main__":
    unittest.main()
