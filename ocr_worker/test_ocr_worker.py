from __future__ import annotations

import hashlib
import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import httpx
from fastapi.testclient import TestClient

REPO_ROOT = Path(__file__).resolve().parents[1]
if str(REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(REPO_ROOT))

from ocr_worker.service import (  # noqa: E402
    CPU_THREADS,
    EXPECTED_FLOW1_TRDG_SHA256,
    ORIGINAL_VIETOCR_SHA256,
    OcrRuntimeManager,
    build_smoke_test_image_bytes,
    build_worker_http_app,
    configure_cpu_thread_caps,
    get_system_memory_stats,
    install_vietocr_safe_config_loader,
    install_zero_db_config_shim,
)
from ocr_worker.worker import (  # noqa: E402
    DEFAULT_BACKEND_TIMEOUT_SECONDS,
    BackendOcrClient,
    apply_loopback_quiet_standby_keepalive_guard,
    compute_adaptive_poll_delay,
    compute_degraded_retry_backoff,
    drain_queue_synchronously,
    is_quiet_standby_enabled,
    process_claimed_job,
    resolve_max_degraded_seconds,
    resolve_quiet_standby_keepalive_seconds,
    run_worker_forever,
)


class _DummyNoTextError(RuntimeError):
    pass


class OcrNoTextDetected(_DummyNoTextError):
    pass


class TestOcrWorkerServiceAndClient(unittest.TestCase):
    def test_cpu_thread_caps_and_zero_db_shim(self):
        threads = configure_cpu_thread_caps()
        self.assertEqual(threads, 2)
        self.assertEqual(CPU_THREADS, 2)
        self.assertEqual(os.environ.get("OMP_NUM_THREADS"), "2")
        self.assertEqual(os.environ.get("OPENBLAS_NUM_THREADS"), "2")
        self.assertEqual(os.environ.get("MKL_NUM_THREADS"), "2")

        with patch.dict(
            os.environ,
            {
                "DATABASE_URL": "postgresql://leaked",
                "SUPABASE_SERVICE_ROLE_KEY": "secret-role-key",
            },
            clear=False,
        ):
            install_zero_db_config_shim()
            self.assertNotIn("DATABASE_URL", os.environ)
            self.assertNotIn("SUPABASE_SERVICE_ROLE_KEY", os.environ)
            cfg = sys.modules["app.database.config"]
            self.assertIsNone(cfg.SUPABASE_ADMIN_KEY)
            self.assertIsNone(cfg.DATABASE_URL)
            self.assertTrue(callable(cfg.supabase_admin_headers))
            self.assertEqual(cfg.supabase_admin_headers(), {"apikey": ""})
            self.assertEqual(
                cfg.supabase_admin_headers("sb_secret_abc", extra={"X-Test": "1"}),
                {"apikey": "sb_secret_abc", "X-Test": "1"},
            )
            self.assertTrue(cfg.is_supabase_jwt_key("eyJ.payload.sig"))
            self.assertFalse(cfg.is_supabase_jwt_key("sb_secret_abc"))

    def test_health_and_version_independent_engine_states(self):
        runtime = OcrRuntimeManager(worker_id="test-ocr-1")
        with runtime._state_lock:
            for st in runtime._engines.values():
                st.installed = True
                st.loaded = False
                st.inference_verified = False
                st.error = None

        app = build_worker_http_app(runtime)
        client = TestClient(app)

        health_installed = client.get("/health").json()
        self.assertEqual(health_installed["status"], "degraded")
        self.assertFalse(health_installed["ready"])
        self.assertEqual(health_installed["engines"]["paddleocr"]["detail_status"], "installed")
        self.assertFalse(health_installed["engines"]["paddleocr"]["inference_verified"])

        with runtime._state_lock:
            runtime._engines["paddleocr"].loaded = True
            runtime._engines["vietocr"].loaded = True
            runtime._engines["paddleocr"].inference_verified = True
            runtime._engines["vietocr"].inference_verified = True
            runtime._engines["tesseract_vie"].loaded = True
            runtime._engines["tesseract_vie"].inference_verified = True

        health_ready = client.get("/health").json()
        self.assertEqual(health_ready["status"], "ok")
        self.assertTrue(health_ready["ready"])
        self.assertEqual(health_ready["concurrency_limit"], 1)
        self.assertEqual(
            health_ready["engines"]["paddleocr"]["detail_status"],
            "inference_verified",
        )

        ver = client.get("/version").json()
        self.assertEqual(ver["worker_id"], "test-ocr-1")
        self.assertEqual(ver["cpu_threads"], 2)

    def test_signed_url_refresh_and_token_isolation(self):
        token = "v" * 40
        img_bytes = build_smoke_test_image_bytes("Chào bé")
        img_sha = hashlib.sha256(img_bytes).hexdigest()
        seen_backend_calls: list[tuple[str, str]] = []
        seen_storage_headers: list[dict[str, str]] = []

        def backend_handler(request: httpx.Request) -> httpx.Response:
            seen_backend_calls.append((request.method, request.url.path))
            self.assertEqual(request.headers.get("X-ViRead-Ocr-Worker-Token"), token)
            if request.url.path == "/internal/ocr-jobs/job-1/refresh-source-url":
                return httpx.Response(
                    200,
                    json={
                        "job_id": "job-1",
                        "source_url": "https://storage.example/signed-v2",
                    },
                )
            return httpx.Response(404)

        def storage_handler(request: httpx.Request) -> httpx.Response:
            seen_storage_headers.append(dict(request.headers))
            # Worker token must NEVER leak to signed URL host.
            self.assertNotIn("x-viread-ocr-worker-token", {k.lower() for k in request.headers})
            if str(request.url) == "https://storage.example/signed-v1":
                return httpx.Response(403)
            if str(request.url) == "https://storage.example/signed-v2":
                return httpx.Response(200, content=img_bytes)
            return httpx.Response(404)

        client = BackendOcrClient(
            "https://api.example",
            token,
            transport=httpx.MockTransport(backend_handler),
            storage_transport=httpx.MockTransport(storage_handler),
        )
        try:
            downloaded = client.download_job_source(
                {
                    "job_id": "job-1",
                    "fencing_token": 3,
                    "image_sha256": img_sha,
                    "source_url": "https://storage.example/signed-v1",
                    "source_fallback_path": "/internal/ocr-jobs/job-1/source",
                },
                worker_id="w1",
            )
            self.assertEqual(downloaded, img_bytes)
            self.assertIn(("POST", "/internal/ocr-jobs/job-1/refresh-source-url"), seen_backend_calls)
            self.assertEqual(len(seen_storage_headers), 2)
        finally:
            client.close()

    def test_no_text_handling_differs_for_parent_vs_admin(self):
        token = "t" * 40
        img_bytes = b"fake-img"
        img_sha = hashlib.sha256(img_bytes).hexdigest()
        recorded: list[tuple[str, dict]] = []

        def backend_handler(request: httpx.Request) -> httpx.Response:
            import json

            if request.url.path.endswith("/source"):
                return httpx.Response(200, content=img_bytes)
            body = json.loads(request.content.decode("utf-8")) if request.content else {}
            recorded.append((request.url.path, body))
            return httpx.Response(200, json={"status": "OK"})

        class _NoTextRuntime(OcrRuntimeManager):
            def run_ocr_for_job(self, job_id: str, image_bytes: bytes) -> dict:
                raise OcrNoTextDetected("blank")

        runtime = _NoTextRuntime(worker_id="w-notext")
        client = BackendOcrClient(
            "https://api.example",
            token,
            transport=httpx.MockTransport(backend_handler),
        )
        try:
            res_parent = process_claimed_job(
                client,
                runtime,
                {
                    "job_id": "sub-1",
                    "job_kind": "PARENT_BOOK_SUBMISSION",
                    "fencing_token": 1,
                    "image_sha256": img_sha,
                    "source_url": None,
                    "source_fallback_path": "/internal/ocr-jobs/sub-1/source",
                },
            )
            self.assertEqual(res_parent["outcome"], "completed_no_text")
            self.assertEqual(recorded[-1][0], "/internal/ocr-jobs/sub-1/complete")
            self.assertTrue(recorded[-1][1]["no_text_detected"])

            res_admin = process_claimed_job(
                client,
                runtime,
                {
                    "job_id": "adm-1",
                    "job_kind": "ADMIN_PAGE_UPLOAD",
                    "fencing_token": 2,
                    "image_sha256": img_sha,
                    "source_url": None,
                    "source_fallback_path": "/internal/ocr-jobs/adm-1/source",
                },
            )
            self.assertEqual(res_admin["outcome"], "failed_no_text")
            self.assertEqual(recorded[-1][0], "/internal/ocr-jobs/adm-1/fail")
            self.assertEqual(recorded[-1][1]["error_code"], "NO_TEXT_DETECTED")
            self.assertFalse(recorded[-1][1]["retryable"])
        finally:
            client.close()

    def test_real_three_engine_ocr_smoke_on_python312(self):
        # Verify real torch->paddle order and 3-engine OCR when running under OCR Python.
        try:
            import torch  # noqa: F401
            import paddle  # noqa: F401
        except Exception as exc:
            self.skipTest(f"Full OCR runtime not available in this interpreter: {exc}")

        runtime = OcrRuntimeManager(worker_id="w-real-smoke")
        temp_pth = Path(tempfile.gettempdir()) / f"viread-vietocr-v2-{EXPECTED_FLOW1_TRDG_SHA256}.pth"
        manifest = None
        if temp_pth.is_file():
            manifest = lambda: {
                "profile": "FLOW1_EXTERNAL_TRDG",
                "checkpoint_sha256": EXPECTED_FLOW1_TRDG_SHA256,
                "storage_path": f"worker-cache/{temp_pth.name}",
                "shards": [],
                "has_custom_config": False,
            }

        health = runtime.initialize_and_verify_engines(
            manifest_fetcher=manifest,
            run_smoke_inference=True,
        )
        self.assertTrue(health["ready"], msg=f"OCR smoke health not ready: {health}")
        self.assertTrue(health["engines"]["paddleocr"]["inference_verified"])
        self.assertTrue(health["engines"]["vietocr"]["inference_verified"])
        self.assertTrue(health["engines"]["tesseract_vie"]["installed"])
        if temp_pth.is_file():
            self.assertEqual(health["model"]["checkpoint_sha256"], EXPECTED_FLOW1_TRDG_SHA256)

        smoke = build_smoke_test_image_bytes("Xin chào các bạn nhỏ")
        out = runtime.run_ocr_for_job("smoke-job", smoke)
        self.assertTrue(out["full_text"].strip())
        self.assertGreaterEqual(len(out["words"]), 1)
        self.assertLessEqual(torch.get_num_threads(), CPU_THREADS)

    def test_complete_and_fail_job_retry_on_transient_502_503_without_retrying_409(self):
        token = "r" * 40
        complete_attempts = 0
        fail_attempts = 0
        conflict_attempts = 0

        def backend_handler(request: httpx.Request) -> httpx.Response:
            nonlocal complete_attempts, fail_attempts, conflict_attempts
            if request.url.path == "/internal/ocr-jobs/job-ok/complete":
                complete_attempts += 1
                if complete_attempts < 3:
                    return httpx.Response(503 if complete_attempts == 1 else 502, text="bad gateway")
                return httpx.Response(200, json={"status": "SUCCEEDED", "job_id": "job-ok"})
            if request.url.path == "/internal/ocr-jobs/job-fail/fail":
                fail_attempts += 1
                if fail_attempts == 1:
                    return httpx.Response(503, text="temporarily unavailable")
                return httpx.Response(200, json={"status": "FAILED_RETRYABLE"})
            if request.url.path == "/internal/ocr-jobs/job-conflict/complete":
                conflict_attempts += 1
                return httpx.Response(409, json={"detail": "Fencing token mismatch"})
            return httpx.Response(404)

        client = BackendOcrClient(
            "https://api.example",
            token,
            transport=httpx.MockTransport(backend_handler),
            completion_retry_attempts=5,
            completion_retry_base_delay=0.001,
        )
        try:
            code, body = client.complete_job("job-ok", {"worker_id": "w1", "fencing_token": 1})
            self.assertEqual(code, 200)
            self.assertEqual(body["status"], "SUCCEEDED")
            self.assertEqual(complete_attempts, 3)

            f_code, f_body = client.fail_job("job-fail", {"worker_id": "w1", "fencing_token": 1})
            self.assertEqual(f_code, 200)
            self.assertEqual(f_body["status"], "FAILED_RETRYABLE")
            self.assertEqual(fail_attempts, 2)

            c_code, _c_body = client.complete_job("job-conflict", {"worker_id": "w1", "fencing_token": 1})
            self.assertEqual(c_code, 409)
            self.assertEqual(conflict_attempts, 1)
        finally:
            client.close()

    def test_stable_hostname_worker_id_default(self):
        with patch.dict(os.environ, {"VIREAD_OCR_WORKER_ID": ""}, clear=False):
            r1 = OcrRuntimeManager()
            r2 = OcrRuntimeManager()
            self.assertEqual(r1.worker_id, r2.worker_id)
            self.assertTrue(r1.worker_id.startswith("win-ocr-"))

    def test_wakeup_endpoint_constant_time_auth_and_passive_health_isolation(self):
        runtime = OcrRuntimeManager(worker_id="hf-ocr-standby-1")
        runtime.set_standby_mode("quiet_standby")
        valid_token = "w" * 40

        unconfigured_client = TestClient(build_worker_http_app(runtime, worker_token="short"))
        self.assertEqual(unconfigured_client.post("/wakeup").status_code, 503)

        client = TestClient(build_worker_http_app(runtime, worker_token=valid_token))
        # Passive /health must NOT wake the worker or alter standby_mode.
        h1 = client.get("/health").json()
        self.assertEqual(h1["standby_mode"], "quiet_standby")
        self.assertEqual(h1["wakeup_count"], 0)
        self.assertFalse(runtime.wake_event.is_set())

        # Missing or invalid token -> 401
        self.assertEqual(client.post("/wakeup").status_code, 401)
        self.assertEqual(
            client.post("/wakeup", headers={"X-ViRead-Ocr-Worker-Token": "x" * 40}).status_code,
            401,
        )
        self.assertFalse(runtime.wake_event.is_set())

        # Valid token -> 200 + switches to burst_awake + sets wake_event
        wake_resp = client.post(
            "/wakeup",
            headers={"X-ViRead-Ocr-Worker-Token": valid_token},
            json={"reason": "enqueue:LOCAL_PAGE_SCAN", "burst_seconds": 90},
        )
        self.assertEqual(wake_resp.status_code, 200)
        wake_body = wake_resp.json()
        self.assertTrue(wake_body["woken"])
        self.assertEqual(wake_body["standby_mode"], "burst_awake")
        self.assertEqual(wake_body["wakeup_count"], 1)
        self.assertTrue(runtime.wake_event.is_set())

    def test_direct_signed_shard_download_and_fallback_with_cache_dir(self):
        token = "z" * 40
        shard0 = b"vietocr-shard-0-bytes"
        shard1 = b"vietocr-shard-1-bytes"
        assembled = shard0 + shard1
        full_sha = hashlib.sha256(assembled).hexdigest()
        s0_sha = hashlib.sha256(shard0).hexdigest()
        s1_sha = hashlib.sha256(shard1).hexdigest()
        cfg_bytes = b"vocab: test\n"
        cfg_sha = hashlib.sha256(cfg_bytes).hexdigest()

        backend_shard_calls: list[str] = []
        storage_headers: list[dict[str, str]] = []

        def backend_handler(request: httpx.Request) -> httpx.Response:
            self.assertEqual(request.headers.get("X-ViRead-Ocr-Worker-Token"), token)
            backend_shard_calls.append(request.url.path)
            if request.url.path == "/internal/ocr-jobs/active-model":
                return httpx.Response(
                    200,
                    json={
                        "profile": "FLOW1_EXTERNAL_TRDG",
                        "checkpoint_sha256": full_sha,
                        "storage_path": "models/manifest.json",
                        "has_custom_config": True,
                        "config_sha256": cfg_sha,
                        "config_signed_url": "https://cdn.storage.example/cfg.yml",
                        "shards": [
                            {
                                "index": 0,
                                "sha256": s0_sha,
                                "bytes": len(shard0),
                                "signed_url": "https://cdn.storage.example/shard0",
                            },
                            {
                                "index": 1,
                                "sha256": s1_sha,
                                "bytes": len(shard1),
                                "signed_url": "https://cdn.storage.example/expired-shard1",
                            },
                        ],
                    },
                )
            if request.url.path == "/internal/ocr-jobs/active-model/shard/1":
                return httpx.Response(200, content=shard1)
            return httpx.Response(404)

        def storage_handler(request: httpx.Request) -> httpx.Response:
            storage_headers.append({k.lower(): v for k, v in request.headers.items()})
            self.assertNotIn("x-viread-ocr-worker-token", {k.lower() for k in request.headers})
            if str(request.url) == "https://cdn.storage.example/shard0":
                return httpx.Response(200, content=shard0)
            if str(request.url) == "https://cdn.storage.example/expired-shard1":
                return httpx.Response(403)
            if str(request.url) == "https://cdn.storage.example/cfg.yml":
                return httpx.Response(200, content=cfg_bytes)
            return httpx.Response(404)

        with tempfile.TemporaryDirectory(prefix="viread-worker-cache-") as tmp_cache:
            with patch.dict(os.environ, {"VIREAD_OCR_MODEL_CACHE_DIR": tmp_cache}, clear=False):
                client = BackendOcrClient(
                    "https://api.example",
                    token,
                    transport=httpx.MockTransport(backend_handler),
                    storage_transport=httpx.MockTransport(storage_handler),
                )
                try:
                    self.assertEqual(client.timeout_seconds, DEFAULT_BACKEND_TIMEOUT_SECONDS)
                    self.assertEqual(DEFAULT_BACKEND_TIMEOUT_SECONDS, 75.0)
                    runtime = OcrRuntimeManager(worker_id="w-shard-test")
                    info = runtime.sync_active_model(
                        manifest_fetcher=client.get_active_model,
                        artifact_fetcher=client.download_model_artifact,
                        direct_url_fetcher=client.download_direct_url,
                    )
                    self.assertTrue(info["local_pth_exists"])
                    self.assertTrue(info["local_yml_exists"])
                    self.assertEqual(
                        (Path(tmp_cache) / f"viread-vietocr-v2-{full_sha}.pth").read_bytes(),
                        assembled,
                    )
                    # Shard 0 came directly from signed URL; only expired Shard 1 fell back to backend!
                    self.assertNotIn("/internal/ocr-jobs/active-model/shard/0", backend_shard_calls)
                    self.assertIn("/internal/ocr-jobs/active-model/shard/1", backend_shard_calls)
                finally:
                    client.close()

    def test_vendored_configs_adaptive_poll_and_hf_bundle_contract(self):
        install_vietocr_safe_config_loader()
        import vietocr.tool.config as vc

        with patch("requests.get", side_effect=RuntimeError("vocr.vn unreachable")):
            cfg = vc.Cfg.load_config_from_name("vgg_transformer")
            self.assertEqual(cfg["backbone"], "vgg19_bn")
            self.assertEqual(len(cfg["vocab"]), 229)

        with patch.dict(os.environ, {"SPACE_ID": "user/viread-ocr"}, clear=False):
            os.environ.pop("VIREAD_OCR_QUIET_STANDBY", None)
            self.assertTrue(is_quiet_standby_enabled())

        self.assertEqual(compute_adaptive_poll_delay(base_poll_seconds=2.0, idle_seconds=5.0), 2.0)
        self.assertEqual(compute_adaptive_poll_delay(base_poll_seconds=2.0, idle_seconds=30.0), 5.0)
        self.assertEqual(compute_adaptive_poll_delay(base_poll_seconds=2.0, idle_seconds=70.0), 10.0)
        self.assertEqual(
            compute_adaptive_poll_delay(
                base_poll_seconds=2.0,
                idle_seconds=130.0,
                max_idle_poll_seconds=20.0,
            ),
            20.0,
        )
        with patch.dict(os.environ, {"VIREAD_OCR_QUIET_STANDBY_KEEPALIVE_SECONDS": ""}, clear=False):
            self.assertEqual(resolve_quiet_standby_keepalive_seconds(), 0.0)
        self.assertEqual(resolve_quiet_standby_keepalive_seconds(30.0), 30.0)
        self.assertEqual(resolve_quiet_standby_keepalive_seconds(3.0), 10.0)
        self.assertEqual(resolve_quiet_standby_keepalive_seconds(999.0), 180.0)
        self.assertEqual(resolve_quiet_standby_keepalive_seconds(0.0), 0.0)

        from scripts.build_hf_space_bundle import build_hf_space_bundle

        with tempfile.TemporaryDirectory(prefix="viread-hf-bundle-test-") as tmp_bundle:
            summary = build_hf_space_bundle(Path(tmp_bundle) / "space")
            self.assertLess(summary["total_bytes"], 1_048_576)
            self.assertGreaterEqual(summary["file_count"], 18)

    def test_get_active_model_retries_transient_502_503_and_push_hf_space_contracts(self):
        token = "m" * 40
        active_model_calls = 0

        def backend_handler(request: httpx.Request) -> httpx.Response:
            nonlocal active_model_calls
            if request.url.path == "/internal/ocr-jobs/active-model":
                active_model_calls += 1
                if active_model_calls < 3:
                    return httpx.Response(502 if active_model_calls == 1 else 503, text="waking")
                return httpx.Response(
                    200,
                    json={
                        "profile": "FLOW1_EXTERNAL_TRDG",
                        "checkpoint_sha256": EXPECTED_FLOW1_TRDG_SHA256,
                        "shards": [],
                    },
                )
            return httpx.Response(404)

        client = BackendOcrClient(
            "https://api.example",
            token,
            transport=httpx.MockTransport(backend_handler),
            completion_retry_attempts=3,
            completion_retry_base_delay=0.001,
        )
        try:
            manifest = client.get_active_model()
            self.assertEqual(manifest["profile"], "FLOW1_EXTERNAL_TRDG")
            self.assertEqual(active_model_calls, 3)
        finally:
            client.close()

        from scripts.push_hf_space import (
            _redact_secrets,
            ensure_private_docker_space,
            main as push_hf_main,
        )

        # Dry-run succeeds with exit code 0 without requiring HF_TOKEN
        self.assertEqual(
            push_hf_main(["--space-id", "demo-user/viread-ocr-worker", "--dry-run"]),
            0,
        )
        self.assertNotIn(
            "hf_secret_123456",
            _redact_secrets("Authorization: Bearer hf_secret_123456 failed", "hf_secret_123456"),
        )

        seen_payloads: list[dict[str, object]] = []

        def fake_hf_api(method: str, url: str, *, hf_token: str, payload=None):
            if method == "GET" and url.endswith("/api/spaces/demo-user/viread-ocr-worker"):
                return 404, {"error": "Not found"}
            if method == "GET" and url.endswith("/api/whoami-v2"):
                return 200, {"name": "demo-user"}
            if method == "POST" and url.endswith("/api/repos/create"):
                assert isinstance(payload, dict)
                seen_payloads.append(payload)
                return 201, {"url": "https://huggingface.co/spaces/demo-user/viread-ocr-worker"}
            return 500, {"error": "unexpected"}

        with patch("scripts.push_hf_space._hf_api_request", side_effect=fake_hf_api):
            ensure_private_docker_space(
                space_id="demo-user/viread-ocr-worker",
                hf_token="hf_test_token_abcdef",
                public=False,
            )
        self.assertEqual(len(seen_payloads), 1)
        self.assertEqual(seen_payloads[0].get("visibility"), "private")
        self.assertEqual(seen_payloads[0].get("sdk"), "docker")
        self.assertEqual(seen_payloads[0].get("hardware"), "cpu-basic")
        self.assertNotIn("organization", seen_payloads[0])

        def fake_hf_402(method: str, url: str, *, hf_token: str, payload=None):
            if method == "GET" and "/api/spaces/" in url:
                return 404, {}
            if method == "GET" and url.endswith("/api/whoami-v2"):
                return 200, {"name": "demo-user"}
            return 402, {"error": "Payment Required for hf_test_token_abcdef"}

        with patch("scripts.push_hf_space._hf_api_request", side_effect=fake_hf_402):
            with self.assertRaises(RuntimeError) as ctx:
                ensure_private_docker_space(
                    space_id="demo-user/viread-ocr-worker",
                    hf_token="hf_test_token_abcdef",
                    public=False,
                )
            self.assertIn("Google Cloud Run Always Free", str(ctx.exception))
            self.assertNotIn("hf_test_token_abcdef", str(ctx.exception))

    def test_synchronous_wakeup_drain_single_flight_and_nonblocking_health(self):
        import asyncio
        import json
        import time

        from ocr_worker.worker import drain_queue_synchronously

        token = "d" * 40
        img_bytes = b"synthetic-page-bytes"
        img_sha = hashlib.sha256(img_bytes).hexdigest()

        queued_jobs = [
            {
                "job_id": "drain-job-1",
                "job_kind": "LOCAL_PAGE_SCAN",
                "fencing_token": 1,
                "image_sha256": img_sha,
                "source_url": None,
                "source_fallback_path": "/internal/ocr-jobs/drain-job-1/source",
            },
            {
                "job_id": "drain-job-2",
                "job_kind": "LOCAL_PAGE_SCAN",
                "fencing_token": 1,
                "image_sha256": img_sha,
                "source_url": None,
                "source_fallback_path": "/internal/ocr-jobs/drain-job-2/source",
            },
        ]
        straggler_job = {
            "job_id": "drain-job-3",
            "job_kind": "LOCAL_PAGE_SCAN",
            "fencing_token": 1,
            "image_sha256": img_sha,
            "source_url": None,
            "source_fallback_path": "/internal/ocr-jobs/drain-job-3/source",
        }
        empty_polls = 0
        completed_ids: list[str] = []

        def backend_handler(request: httpx.Request) -> httpx.Response:
            nonlocal empty_polls
            if request.url.path == "/internal/ocr-jobs/worker-heartbeat":
                return httpx.Response(200, json={"ok": True})
            if request.url.path == "/internal/ocr-jobs/claim":
                if queued_jobs:
                    return httpx.Response(200, json={"job": queued_jobs.pop(0)})
                empty_polls += 1
                if empty_polls == 1:
                    # Simulate a straggler page committing right before the 3s re-check!
                    queued_jobs.append(straggler_job)
                return httpx.Response(200, json={"job": None})
            if request.url.path.endswith("/source"):
                return httpx.Response(200, content=img_bytes)
            if request.url.path.endswith("/complete"):
                body = json.loads(request.content.decode("utf-8"))
                completed_ids.append(request.url.path.split("/")[-2])
                self.assertEqual(body["source_sha256"], img_sha)
                return httpx.Response(200, json={"status": "SUCCEEDED"})
            return httpx.Response(404)

        class _FakeReadyRuntime(OcrRuntimeManager):
            def run_ocr_for_job(self, job_id: str, image_bytes: bytes) -> dict:
                time.sleep(0.04)
                return {
                    "full_text": f"Xin chào {job_id}",
                    "words": [{"text": "Xin", "bbox": [0.1, 0.1, 0.1, 0.05]}],
                    "ocr_meta": {"runtime_device": "cpu"},
                    "model_profile": "FLOW1_EXTERNAL_TRDG",
                    "model_sha256": EXPECTED_FLOW1_TRDG_SHA256,
                    "engine_diagnostics": {},
                    "duration_ms": 40,
                }

        runtime = _FakeReadyRuntime(worker_id="aca-ocr-1")
        with runtime._state_lock:
            runtime._engines["paddleocr"].loaded = True
            runtime._engines["vietocr"].loaded = True
            runtime._engines["tesseract_vie"].loaded = True

        backend_client = BackendOcrClient(
            "https://api.example",
            token,
            transport=httpx.MockTransport(backend_handler),
        )
        try:
            with patch.dict(
                os.environ,
                {"VIREAD_OCR_SCALE_TO_ZERO": "true"},
                clear=False,
            ):
                app = build_worker_http_app(
                    runtime,
                    worker_token=token,
                    drain_runner=lambda _r: drain_queue_synchronously(
                        backend_client,
                        runtime,
                        straggler_wait_seconds=0.05,
                    ),
                )

                async def _exercise_asgi() -> None:
                    transport = httpx.ASGITransport(app=app)
                    async with httpx.AsyncClient(
                        transport=transport, base_url="http://worker.local"
                    ) as http:
                        # Unauthenticated drain -> 401
                        unauth = await http.post("/wakeup?drain=true")
                        self.assertEqual(unauth.status_code, 401)

                        # Fire primary drain; while it is processing job 1, fire a 2nd concurrent
                        # drain AND a passive GET /health to verify event-loop responsiveness!
                        primary_task = asyncio.create_task(
                            http.post(
                                "/wakeup?drain=true",
                                headers={"X-ViRead-Ocr-Worker-Token": token},
                                json={"reason": "enqueue:LOCAL_PAGE_SCAN"},
                            )
                        )
                        await asyncio.sleep(0.02)

                        t_health = time.perf_counter()
                        health_resp, dup_resp = await asyncio.gather(
                            http.get("/health"),
                            http.post(
                                "/wakeup?drain=true",
                                headers={"X-ViRead-Ocr-Worker-Token": token},
                                json={"reason": "concurrent_second_enqueue"},
                            ),
                        )
                        health_ms = (time.perf_counter() - t_health) * 1000.0
                        self.assertEqual(health_resp.status_code, 200)
                        self.assertLess(health_ms, 80.0)

                        self.assertEqual(dup_resp.status_code, 200)
                        dup_json = dup_resp.json()
                        self.assertTrue(dup_json["ok"])
                        self.assertTrue(dup_json["already_draining"])

                        primary_resp = await primary_task
                        self.assertEqual(primary_resp.status_code, 200)
                        primary_json = primary_resp.json()
                        self.assertTrue(primary_json["ok"])
                        self.assertTrue(primary_json["drained"])
                        self.assertFalse(primary_json["already_draining"])
                        self.assertEqual(primary_json["drained_jobs"], 3)
                        self.assertEqual(primary_json["standby_mode"], "scale_to_zero")

                asyncio.run(_exercise_asgi())
                self.assertEqual(
                    completed_ids,
                    ["drain-job-1", "drain-job-2", "drain-job-3"],
                )
        finally:
            backend_client.close()

    def test_checkpoint_cdn_url_sha256_verification_prebaked_skip_smoke_and_hf_model_helper(self):
        from ocr_worker.prebake import fetch_and_verify
        from ocr_worker.service import should_skip_startup_smoke
        from scripts.push_hf_model_checkpoint import main as push_model_main

        token = "c" * 40
        pth_bytes = b"verified-flow1-vietocr-checkpoint-payload"
        pth_sha = hashlib.sha256(pth_bytes).hexdigest()
        cfg_bytes = b"backbone: vgg19_bn\nvocab: abc\n"
        cfg_sha = hashlib.sha256(cfg_bytes).hexdigest()

        supabase_calls: list[str] = []
        cdn_headers_seen: list[tuple[str, dict[str, str]]] = []

        def backend_handler(request: httpx.Request) -> httpx.Response:
            if request.url.path == "/internal/ocr-jobs/active-model":
                return httpx.Response(
                    200,
                    json={
                        "profile": "FLOW1_EXTERNAL_TRDG",
                        "checkpoint_sha256": pth_sha,
                        "storage_path": "models/manifest.json",
                        "has_custom_config": True,
                        "config_sha256": cfg_sha,
                        "config_signed_url": "https://supabase.example/cfg.yml",
                        "shards": [
                            {
                                "index": 0,
                                "sha256": pth_sha,
                                "bytes": len(pth_bytes),
                                "signed_url": "https://supabase.example/shard0",
                            }
                        ],
                    },
                )
            supabase_calls.append(request.url.path)
            if request.url.path == "/internal/ocr-jobs/active-model/shard/0":
                return httpx.Response(200, content=pth_bytes)
            if request.url.path == "/internal/ocr-jobs/active-model/config":
                return httpx.Response(200, content=cfg_bytes)
            return httpx.Response(404)

        def supabase_storage_handler(request: httpx.Request) -> httpx.Response:
            supabase_calls.append(str(request.url))
            if str(request.url).endswith("/shard0"):
                return httpx.Response(200, content=pth_bytes)
            if str(request.url).endswith("/cfg.yml"):
                return httpx.Response(200, content=cfg_bytes)
            return httpx.Response(404)

        cdn_mode = "valid"

        def cdn_handler(request: httpx.Request) -> httpx.Response:
            hdrs = {k.lower(): v for k, v in request.headers.items()}
            cdn_headers_seen.append((str(request.url.host), hdrs))
            # Worker token must NEVER leak to CDN!
            self.assertNotIn("x-viread-ocr-worker-token", hdrs)
            if str(request.url).endswith(".pth"):
                if cdn_mode == "tampered":
                    return httpx.Response(200, content=b"tampered-corrupt-weights")
                return httpx.Response(200, content=pth_bytes)
            if str(request.url).endswith(".yml"):
                return httpx.Response(200, content=cfg_bytes)
            return httpx.Response(404)

        # Case 1: Valid HF Model Repo CDN URL -> 0 Supabase calls + HF token attached ONLY to huggingface.co
        with tempfile.TemporaryDirectory(prefix="viread-cdn-ok-") as tmp_dir:
            with patch.dict(
                os.environ,
                {
                    "VIREAD_OCR_MODEL_CACHE_DIR": tmp_dir,
                    "VIREAD_OCR_PREBAKED_MODEL_DIR": str(Path(tmp_dir) / "empty-prebaked"),
                    "VIREAD_OCR_CHECKPOINT_CDN_URL": f"https://huggingface.co/cuonghhhdd3/viread-ocr-models/resolve/main/viread-vietocr-v2-{pth_sha}.pth",
                    "VIREAD_HF_MODEL_TOKEN": "hf_model_read_token_secret",
                },
                clear=False,
            ):
                client = BackendOcrClient(
                    "https://api.example",
                    token,
                    transport=httpx.MockTransport(backend_handler),
                    storage_transport=httpx.MockTransport(supabase_storage_handler),
                )
                try:
                    rt = OcrRuntimeManager(worker_id="w-cdn-ok")
                    rt._cdn_transport = httpx.MockTransport(cdn_handler)
                    info = rt.sync_active_model(
                        manifest_fetcher=client.get_active_model,
                        artifact_fetcher=client.download_model_artifact,
                        direct_url_fetcher=client.download_direct_url,
                    )
                    self.assertTrue(info["local_pth_exists"])
                    self.assertTrue(info["local_yml_exists"])
                    self.assertFalse(info["prebaked_hit"])
                    self.assertEqual(supabase_calls, [])
                    self.assertEqual(
                        cdn_headers_seen[0][1].get("authorization"),
                        "Bearer hf_model_read_token_secret",
                    )

                    # Second sync in same dir hits pre-baked / cached file with 0 network calls!
                    cdn_headers_seen.clear()
                    info2 = rt.sync_active_model(
                        manifest_fetcher=client.get_active_model,
                        artifact_fetcher=client.download_model_artifact,
                        direct_url_fetcher=client.download_direct_url,
                    )
                    self.assertTrue(info2["prebaked_hit"])
                    self.assertEqual(cdn_headers_seen, [])
                finally:
                    client.close()

        # Case 2: Tampered CDN payload with no fallback -> strictly rejected with ValueError!
        cdn_mode = "tampered"
        cdn_headers_seen.clear()
        with tempfile.TemporaryDirectory(prefix="viread-cdn-tamper-") as tmp_dir:
            with patch.dict(
                os.environ,
                {
                    "VIREAD_OCR_MODEL_CACHE_DIR": tmp_dir,
                    "VIREAD_OCR_PREBAKED_MODEL_DIR": str(Path(tmp_dir) / "empty-prebaked"),
                    "VIREAD_OCR_CHECKPOINT_CDN_URL": f"https://github.com/trancuong3/capstone1/releases/download/v1/viread-vietocr-v2-{pth_sha}.pth",
                    "VIREAD_HF_MODEL_TOKEN": "hf_model_read_token_secret",
                },
                clear=False,
            ):
                rt_bad = OcrRuntimeManager(worker_id="w-cdn-tamper")
                rt_bad._cdn_transport = httpx.MockTransport(cdn_handler)
                with self.assertRaises(ValueError):
                    rt_bad.sync_active_model(
                        manifest_fetcher=lambda: {
                            "profile": "FLOW1_EXTERNAL_TRDG",
                            "checkpoint_sha256": pth_sha,
                            "shards": [],
                        }
                    )
                # HF token MUST NOT be sent to github.com!
                self.assertNotIn("authorization", cdn_headers_seen[0][1])
                self.assertFalse((Path(tmp_dir) / f"viread-vietocr-v2-{pth_sha}.pth").exists())

        # Case 3: VIREAD_OCR_SKIP_STARTUP_SMOKE + prebake helper + push_hf_model_checkpoint --dry-run
        with patch.dict(os.environ, {"VIREAD_OCR_SKIP_STARTUP_SMOKE": "true"}, clear=False):
            self.assertTrue(should_skip_startup_smoke(prebaked_hit=True))
            self.assertFalse(should_skip_startup_smoke(prebaked_hit=False))

        with tempfile.TemporaryDirectory(prefix="viread-prebake-unit-") as tmp_dir:
            src_file = Path(tmp_dir) / f"viread-vietocr-v2-{pth_sha}.pth"
            src_file.write_bytes(pth_bytes)
            file_uri = src_file.as_uri()
            baked_dst = Path(tmp_dir) / "baked" / src_file.name
            fetch_and_verify(file_uri, expected_sha256=pth_sha, dst_path=baked_dst)
            self.assertEqual(baked_dst.read_bytes(), pth_bytes)
            with self.assertRaises(ValueError):
                fetch_and_verify(
                    file_uri,
                    expected_sha256="0" * 64,
                    dst_path=Path(tmp_dir) / "baked" / "bad.pth",
                )
            self.assertEqual(
                push_model_main(
                    [
                        "--repo-id",
                        "cuonghhhdd3/viread-ocr-models",
                        "--checkpoint-path",
                        str(src_file),
                        "--dry-run",
                    ]
                ),
                0,
            )

    def test_wakeup_drain_post_loop_pending_redrain_and_cancelled_disconnect_recovery(self):
        import asyncio
        import threading
        import time

        token = "e" * 40
        runtime = OcrRuntimeManager(worker_id="aca-race-1")
        pass_calls = 0
        pass1_exiting = threading.Event()
        allow_pass1_return = threading.Event()

        def controlled_drain_runner(_reason: str) -> int:
            nonlocal pass_calls
            pass_calls += 1
            if pass_calls == 1:
                # Simulate the exact window AFTER drain_queue_synchronously exited its
                # claim_next_job() loop, right before finish_drain_or_continue() runs!
                pass1_exiting.set()
                allow_pass1_return.wait(timeout=2.0)
                return 1
            if pass_calls == 2:
                return 1
            return 2

        with patch.dict(os.environ, {"VIREAD_OCR_SCALE_TO_ZERO": "true"}, clear=False):
            app = build_worker_http_app(
                runtime,
                worker_token=token,
                drain_runner=controlled_drain_runner,
            )

            async def _exercise_race() -> None:
                transport = httpx.ASGITransport(app=app)
                async with httpx.AsyncClient(
                    transport=transport, base_url="http://worker.local"
                ) as http:
                    t1 = asyncio.create_task(
                        http.post(
                            "/wakeup?drain=true",
                            headers={"X-ViRead-Ocr-Worker-Token": token},
                            json={"reason": "first_scan"},
                        )
                    )
                    while not pass1_exiting.is_set():
                        await asyncio.sleep(0.005)

                    # Arrive in the post-loop window: gets already_draining=True and sets _pending_redrain
                    dup = await http.post(
                        "/wakeup?drain=true",
                        headers={"X-ViRead-Ocr-Worker-Token": token},
                        json={"reason": "late_arrival_enqueue"},
                    )
                    self.assertEqual(dup.status_code, 200)
                    self.assertTrue(dup.json()["already_draining"])

                    allow_pass1_return.set()
                    res1 = await t1
                    self.assertEqual(res1.status_code, 200)
                    body1 = res1.json()
                    # Primary wakeup MUST run a 2nd pass before releasing _draining!
                    self.assertEqual(pass_calls, 2)
                    self.assertEqual(body1["drained_jobs"], 2)
                    self.assertEqual(body1["standby_mode"], "scale_to_zero")
                    self.assertFalse(runtime.is_draining())

            asyncio.run(_exercise_race())

            # Simulate ACA 240s ingress disconnect (CancelledError) mid-drain: must abort_drain cleanly!
            cancel_entered = threading.Event()
            release_blocked_thread = threading.Event()

            def slow_drain(_r: str) -> int:
                cancel_entered.set()
                release_blocked_thread.wait(timeout=2.0)
                return 0

            app_cancel = build_worker_http_app(
                runtime,
                worker_token=token,
                drain_runner=slow_drain,
            )

            async def _exercise_cancel() -> None:
                transport = httpx.ASGITransport(app=app_cancel)
                async with httpx.AsyncClient(
                    transport=transport, base_url="http://worker.local"
                ) as http:
                    cancelled_req = asyncio.create_task(
                        http.post(
                            "/wakeup?drain=true",
                            headers={"X-ViRead-Ocr-Worker-Token": token},
                            json={"reason": "long_batch"},
                        )
                    )
                    while not cancel_entered.is_set():
                        await asyncio.sleep(0.005)
                    self.assertTrue(runtime.is_draining())
                    cancelled_req.cancel()
                    with self.assertRaises(asyncio.CancelledError):
                        await cancelled_req
                    release_blocked_thread.set()
                    self.assertFalse(runtime.is_draining())

                    # Follow-up drain immediately acquires ownership (not stuck in already_draining)!
                    recovery = await http.post(
                        "/wakeup?drain=true",
                        headers={"X-ViRead-Ocr-Worker-Token": token},
                        json={"reason": "followup_after_240s_disconnect"},
                    )
                    self.assertEqual(recovery.status_code, 200)
                    self.assertFalse(recovery.json()["already_draining"])
                    self.assertTrue(recovery.json()["drained"])

            asyncio.run(_exercise_cancel())

    @unittest.skipUnless(sys.platform == "win32", "Windows PowerShell 5.1 integration test")
    def test_azure_powershell_deployer_region_fallback_stderr_json_and_arm_patch(self):
        import json
        import subprocess

        ps_script = REPO_ROOT / "scripts" / "azure" / "Deploy-ViReadAzureOcrWorker.ps1"
        self.assertTrue(ps_script.is_file())
        secret_token = "f1e2d3c4b5a697887766554433221100ffeeddccbbaa9988"

        with tempfile.TemporaryDirectory(prefix="viread-az-ps51-") as tmp_dir:
            tmp_path = Path(tmp_dir)
            state_file = tmp_path / "az_state.json"
            state_file.write_text(
                json.dumps(
                    {
                        "rg": None,
                        "resources": [],
                        "env": None,
                        "app": None,
                        "calls": [],
                    }
                ),
                encoding="utf-8",
            )

            fake_az_py = tmp_path / "fake_az.py"
            fake_az_py.write_text(
                '''import json, os, sys
from pathlib import Path

state_path = Path(os.environ["FAKE_AZ_STATE_FILE"])
state = json.loads(state_path.read_text(encoding="utf-8"))
args = sys.argv[1:]
state["calls"].append(args)

def save():
    state_path.write_text(json.dumps(state, indent=2), encoding="utf-8")

def arg_val(flag):
    if flag in args:
        idx = args.index(flag)
        if idx + 1 < len(args):
            return args[idx + 1]
    return None

# Emit a realistic Azure CLI preview warning on stderr to test PS 5.1 NativeCommandError + JSON purity!
if args[:2] in (["account", "show"], ["containerapp", "show"]):
    sys.stderr.write("WARNING: Command group 'containerapp' is in preview and under development.\\n")

if args[:2] == ["config", "set"] or args[:2] == ["extension", "add"] or args[:2] == ["provider", "register"]:
    save()
    sys.exit(0)

if args[:2] == ["account", "show"]:
    save()
    print(json.dumps({"id": "00000000-1111-2222-3333-444444444444", "name": "Azure for Students"}))
    sys.exit(0)

if args[:2] == ["group", "show"]:
    save()
    if state["rg"] is None:
        sys.stderr.write("ERROR: (ResourceGroupNotFound) Resource group could not be found.\\n")
        sys.exit(3)
    print(json.dumps(state["rg"]))
    sys.exit(0)

if args[:2] == ["resource", "list"]:
    save()
    print(json.dumps(state["resources"]))
    sys.exit(0)

if args[:2] == ["group", "delete"]:
    state["rg"] = None
    state["resources"] = []
    save()
    sys.exit(0)

if args[:2] == ["group", "create"]:
    loc = arg_val("--location")
    state["rg"] = {"name": arg_val("--name"), "location": loc}
    save()
    print(json.dumps(state["rg"]))
    sys.exit(0)

if args[:3] == ["containerapp", "env", "show"]:
    save()
    if state["env"] is None:
        sys.stderr.write("ERROR: ResourceNotFound\\n")
        sys.exit(3)
    print(json.dumps(state["env"]))
    sys.exit(0)

if args[:3] == ["containerapp", "env", "create"]:
    loc = arg_val("--location")
    logs_dest = arg_val("--logs-destination")
    assert logs_dest == "none", f"Expected --logs-destination none, got {logs_dest}"
    if loc == "southeastasia":
        save()
        sys.stderr.write("ERROR: (InvalidTemplateDeployment) RequestDisallowedByPolicy: Resource disallowed in southeastasia.\\n")
        sys.exit(1)
    if state["rg"] and state["rg"]["location"] != loc:
        save()
        sys.stderr.write("ERROR: (InvalidResourceGroupLocation) Resource location must match resource group location.\\n")
        sys.exit(1)
    state["env"] = {"name": arg_val("--name"), "location": loc}
    state["resources"].append({"type": "Microsoft.App/managedEnvironments", "name": arg_val("--name")})
    save()
    print(json.dumps(state["env"]))
    sys.exit(0)

if args[:2] == ["containerapp", "show"]:
    save()
    if state["app"] is None:
        sys.stderr.write("ERROR: ResourceNotFound\\n")
        sys.exit(3)
    if arg_val("-o") == "json":
        # Like real ARM GET, omit secret values!
        redacted = json.loads(json.dumps(state["app"]))
        redacted["properties"]["configuration"]["secrets"] = [{"name": "ocr-worker-token"}]
        print(json.dumps(redacted))
    sys.exit(0)

if args[:2] == ["containerapp", "create"]:
    sec = arg_val("--secrets") or ""
    assert sec.startswith("ocr-worker-token="), "Missing ocr-worker-token secret"
    state["app"] = {
        "name": arg_val("--name"),
        "location": state["env"]["location"],
        "secret_raw": sec.split("=", 1)[1],
        "properties": {
            "configuration": {
                "ingress": {"external": True, "targetPort": 7860, "fqdn": "viread-ocr-worker.eastasia.azurecontainerapps.io"},
                "secrets": [{"name": "ocr-worker-token", "value": sec.split("=", 1)[1]}],
            },
            "template": {
                "scale": {"minReplicas": 0, "maxReplicas": 1, "cooldownPeriod": 300, "pollingInterval": 30}
            },
        },
    }
    state["resources"].append({"type": "Microsoft.App/containerApps", "name": arg_val("--name")})
    save()
    sys.exit(0)

if args[:3] == ["containerapp", "secret", "set"]:
    sec = arg_val("--secrets") or ""
    state["app"]["secret_raw"] = sec.split("=", 1)[1]
    save()
    sys.exit(0)

if args[:2] == ["containerapp", "update"]:
    # Like real az containerapp update, reset cooldownPeriod to 300 before Step 5 PATCH runs!
    state["app"]["properties"]["template"]["scale"]["cooldownPeriod"] = 300
    save()
    sys.exit(0)

if args[:2] == ["resource", "update"]:
    save()
    sys.stderr.write("ERROR: (ContainerAppSecretInvalid) Secret 'ocr-worker-token' must have a valid value.\\n")
    sys.exit(1)

if args[:1] == ["rest"]:
    assert arg_val("--method").upper() == "PATCH", f"Expected PATCH, got {arg_val('--method')}"
    body_arg = arg_val("--body")
    assert body_arg and body_arg.startswith("@"), f"Expected @file body, got {body_arg}"
    raw_bytes = Path(body_arg[1:]).read_bytes()
    assert not raw_bytes.startswith(b"\\xef\\xbb\\xbf"), "UTF-8 BOM breaks az rest JSON parser!"
    patch_doc = json.loads(raw_bytes.decode("utf-8"))
    scale_patch = patch_doc["properties"]["template"]["scale"]
    state["app"]["properties"]["template"]["scale"].update(scale_patch)
    save()
    print(json.dumps(state["app"]))
    sys.exit(0)

save()
sys.stderr.write(f"Unhandled fake az command: {args}\\n")
sys.exit(2)
''',
                encoding="utf-8",
            )

            az_cmd = tmp_path / "az.cmd"
            az_cmd.write_text(
                f'@echo off\r\n"{sys.executable}" "{fake_az_py}" %*\r\n',
                encoding="utf-8",
            )

            env = {
                **os.environ,
                "PATH": f"{tmp_path}{os.pathsep}{os.environ.get('PATH', '')}",
                "FAKE_AZ_STATE_FILE": str(state_file),
                "VIREAD_OCR_WORKER_TOKEN": secret_token,
            }

            # Run 1: Initial creation (southeastasia blocked -> cleans empty RG -> succeeds in eastasia + PATCH cooldown=30)
            proc1 = subprocess.run(
                [
                    "powershell.exe",
                    "-NoProfile",
                    "-ExecutionPolicy",
                    "Bypass",
                    "-File",
                    str(ps_script),
                    "-Image",
                    "example.com/public/viread-ocr-worker:latest",
                    "-CandidateRegions",
                    "southeastasia,eastasia",
                    "-UseEnvWorkerToken",
                    "-HealthProbeAttempts",
                    "0",
                ],
                env=env,
                capture_output=True,
                text=True,
                timeout=30,
                check=False,
            )
            # In PS 5.1, `-CandidateRegions a,b` over `-File` passes string; handle or pass via -Command:
            if proc1.returncode != 0:
                self.fail(f"Run 1 failed (exit {proc1.returncode}):\nSTDOUT:\n{proc1.stdout}\nSTDERR:\n{proc1.stderr}")

            state_after_1 = json.loads(state_file.read_text(encoding="utf-8"))
            self.assertEqual(state_after_1["rg"]["location"], "eastasia")
            self.assertEqual(state_after_1["env"]["location"], "eastasia")
            self.assertEqual(
                state_after_1["app"]["properties"]["template"]["scale"]["cooldownPeriod"],
                30,
            )
            self.assertEqual(
                state_after_1["app"]["properties"]["template"]["scale"]["pollingInterval"],
                15,
            )
            self.assertEqual(state_after_1["app"]["secret_raw"], secret_token)
            self.assertNotIn(secret_token, proc1.stdout)
            self.assertNotIn(secret_token, proc1.stderr)
            self.assertIn("VIREAD_OCR_REMOTE_SCALE_TO_ZERO=true", proc1.stdout)

            # Run 2: Idempotent update when environment + app already exist
            proc2 = subprocess.run(
                [
                    "powershell.exe",
                    "-NoProfile",
                    "-ExecutionPolicy",
                    "Bypass",
                    "-File",
                    str(ps_script),
                    "-Image",
                    "example.com/public/viread-ocr-worker:latest",
                    "-UseEnvWorkerToken",
                    "-HealthProbeAttempts",
                    "0",
                ],
                env=env,
                capture_output=True,
                text=True,
                timeout=30,
                check=False,
            )
            self.assertEqual(
                proc2.returncode,
                0,
                msg=f"Run 2 failed:\nSTDOUT:\n{proc2.stdout}\nSTDERR:\n{proc2.stderr}",
            )
            state_after_2 = json.loads(state_file.read_text(encoding="utf-8"))
            self.assertEqual(
                state_after_2["app"]["properties"]["template"]["scale"]["cooldownPeriod"],
                30,
            )
            self.assertNotIn(secret_token, proc2.stdout)
            self.assertNotIn(secret_token, proc2.stderr)

    def test_backend_client_retries_transient_502_503_504_on_claim_and_heartbeats(self):
        import json

        token = "r" * 40
        counts = {"worker_hb": 0, "job_hb": 0, "claim": 0, "conflict_hb": 0, "timeout_claim": 0}

        def handler(request: httpx.Request) -> httpx.Response:
            path = request.url.path
            if path == "/internal/ocr-jobs/worker-heartbeat":
                counts["worker_hb"] += 1
                if counts["worker_hb"] < 3:
                    return httpx.Response(503, text="restarting")
                return httpx.Response(200, json={"ok": True})
            if path == "/internal/ocr-jobs/job-1/heartbeat":
                counts["job_hb"] += 1
                if counts["job_hb"] == 1:
                    return httpx.Response(502, text="bad gateway")
                return httpx.Response(200, json={"cancelled": False, "status": "RUNNING"})
            if path == "/internal/ocr-jobs/job-conflict/heartbeat":
                counts["conflict_hb"] += 1
                return httpx.Response(409, json={"detail": "conflict"})
            if path == "/internal/ocr-jobs/claim":
                body = json.loads(request.content.decode("utf-8"))
                if body.get("worker_id") == "w-readtimeout":
                    counts["timeout_claim"] += 1
                    raise httpx.ReadTimeout("slow read after commit")
                counts["claim"] += 1
                if counts["claim"] == 1:
                    return httpx.Response(504, text="gateway timeout")
                if counts["claim"] == 2:
                    raise httpx.ConnectError("transient connect failure")
                return httpx.Response(200, json={"job": {"job_id": "job-1"}})
            return httpx.Response(404)

        client = BackendOcrClient(
            "https://api.example",
            token,
            transport=httpx.MockTransport(handler),
            completion_retry_attempts=3,
            completion_retry_base_delay=0.001,
        )
        try:
            self.assertEqual(client.send_worker_heartbeat({"worker_id": "w-1"}), {"ok": True})
            self.assertEqual(counts["worker_hb"], 3)

            self.assertEqual(
                client.heartbeat_job("job-1", worker_id="w-1", fencing_token=1),
                {"cancelled": False, "status": "RUNNING"},
            )
            self.assertEqual(counts["job_hb"], 2)

            self.assertEqual(
                client.heartbeat_job("job-conflict", worker_id="w-1", fencing_token=1),
                {"cancelled": True, "status": "CONFLICT"},
            )
            self.assertEqual(counts["conflict_hb"], 1)

            claimed = client.claim_next_job("w-1")
            self.assertEqual(claimed, {"job_id": "job-1"})
            self.assertEqual(counts["claim"], 3)

            with self.assertRaises(httpx.ReadTimeout):
                client.claim_next_job("w-readtimeout")
            self.assertEqual(counts["timeout_claim"], 1)
        finally:
            client.close()

    def test_degraded_paddle_failure_preserves_last_error_and_skips_smoke_verification(self):
        from types import ModuleType, SimpleNamespace
        from unittest.mock import MagicMock

        self.assertEqual(os.environ.get("LMDB_FORCE_CPYTHON"), "1")
        mem_stats = get_system_memory_stats()
        self.assertIn("pagefile_total_mb", mem_stats)
        self.assertIn("pagefile_available_mb", mem_stats)
        if sys.platform == "win32":
            self.assertIsNotNone(mem_stats["pagefile_total_mb"])
            self.assertIsNotNone(mem_stats["pagefile_available_mb"])

        runtime = OcrRuntimeManager(worker_id="w-degraded-paddle")
        fake_ocr_mod = ModuleType("app.services.ocr_engine")
        fake_ocr_mod._paddle_engine = None
        fake_ocr_mod._paddle_initialization_error = "DistutilsPlatformError"
        fake_ocr_mod._paddle_import_error = "DistutilsPlatformError"
        fake_ocr_mod._vietocr_engine = object()
        fake_ocr_mod._vietocr_initialization_error = None
        fake_ocr_mod._vietocr_import_error = None
        fake_ocr_mod._v2_artifact_from_storage = lambda _active: ("fake.pth", None, None)
        fake_ocr_mod.set_active_viread_model_cache = lambda _item: None
        fake_ocr_mod.warmup_ocr_engines = lambda: None
        fake_ocr_mod.get_loaded_vietocr_runtime_status = lambda: {
            "loaded_profile": "ORIGINAL",
            "loaded_checkpoint_sha256": ORIGINAL_VIETOCR_SHA256,
        }
        fake_ocr_mod.extract_text_and_boxes = MagicMock(
            return_value={
                "text": "fallback",
                "words": [],
                "metadata": {
                    "engine": "tesseract",
                    "engine_statuses": {
                        "paddleocr": "not_initialized",
                        "vietocr": "not_run",
                        "tesseract": "success",
                    },
                },
            }
        )

        fake_services_pkg = ModuleType("app.services")
        fake_services_pkg.ocr_engine = fake_ocr_mod

        with (
            patch.dict(
                sys.modules,
                {
                    "app.services": fake_services_pkg,
                    "app.services.ocr_engine": fake_ocr_mod,
                },
            ),
            patch(
                "ocr_worker.service.import_ml_modules_safe_order",
                return_value=(
                    SimpleNamespace(__version__="2.5.0"),
                    SimpleNamespace(__version__="2.6.2"),
                ),
            ),
            patch("ocr_worker.service.install_vietocr_safe_config_loader"),
            patch.object(runtime, "_run_smoke_verification", wraps=runtime._run_smoke_verification) as smoke_spy,
            patch.object(runtime, "_verify_tesseract_smoke", return_value=True) as tess_spy,
        ):
            health = runtime.initialize_and_verify_engines(run_smoke_inference=True)
            self.assertFalse(health["ready"])
            self.assertEqual(health["status"], "degraded")
            self.assertEqual(health["worker_status"], "DEGRADED")
            self.assertFalse(health["engines"]["paddleocr"]["loaded"])
            self.assertEqual(
                health["engines"]["paddleocr"]["error"], "DistutilsPlatformError"
            )
            self.assertIsNotNone(health["last_error"])
            self.assertIn("DistutilsPlatformError", health["last_error"])
            # Smoke verification MUST be skipped when primary engines failed to load!
            smoke_spy.assert_not_called()
            fake_ocr_mod.extract_text_and_boxes.assert_not_called()
            tess_spy.assert_not_called()

            # Even if _run_smoke_verification is invoked directly and falls back to Tesseract,
            # last_error must NOT be cleared to None and tesseract.exe must NOT be spammed.
            runtime._run_smoke_verification(fake_ocr_mod)
            after_smoke = runtime.health_payload()
            self.assertFalse(after_smoke["ready"])
            self.assertIsNotNone(after_smoke["last_error"])
            self.assertIn("smoke_verification_incomplete", after_smoke["last_error"])
            tess_spy.assert_not_called()

            # When run_ocr_for_job executes while still degraded, last_error stays preserved.
            runtime.run_ocr_for_job("job-deg", b"synthetic")
            self.assertIsNotNone(runtime.health_payload()["last_error"])

            # Now simulate PaddleOCR recovering, then VietOCR failing during maybe_resync_active_model.
            fake_ocr_mod._paddle_engine = object()
            fake_ocr_mod._paddle_initialization_error = None
            fake_ocr_mod._paddle_import_error = None
            fake_ocr_mod.extract_text_and_boxes.return_value = {
                "text": "Xin chào Việt Nam",
                "words": [{"text": "Xin"}],
                "metadata": {
                    "engine": "paddleocr_vietocr_dual",
                    "engine_statuses": {
                        "paddleocr": "success",
                        "vietocr": "success",
                        "tesseract": "success",
                    },
                },
            }
            recovered = runtime.initialize_and_verify_engines(
                run_smoke_inference=True, force_reinit=True
            )
            self.assertTrue(recovered["ready"])
            self.assertIsNone(recovered["last_error"])

            new_sha = "a" * 64
            fake_ocr_mod._vietocr_engine = None
            fake_ocr_mod._vietocr_initialization_error = "RuntimeError"
            resynced = runtime.maybe_resync_active_model(
                manifest_fetcher=lambda: {
                    "profile": "FLOW2_ADMIN_VERIFIED",
                    "checkpoint_sha256": new_sha,
                    "shards": [],
                },
                artifact_fetcher=lambda _k, _i: b"",
                force=True,
            )
            self.assertTrue(resynced)
            degraded_resync = runtime.health_payload()
            self.assertFalse(degraded_resync["ready"])
            self.assertEqual(degraded_resync["engines"]["vietocr"]["error"], "RuntimeError")
            self.assertIn("RuntimeError", str(degraded_resync["last_error"]))

    def test_claim_next_job_blocked_when_not_ready_and_loopback_quiet_standby_guard(self):
        import json
        from unittest.mock import MagicMock

        # 1. Loopback QuietStandby keepalive clamp contract
        with patch.dict(os.environ, {"SPACE_ID": ""}, clear=False):
            self.assertEqual(
                apply_loopback_quiet_standby_keepalive_guard(
                    use_quiet_standby=True,
                    use_scale_to_zero=False,
                    bind_host="127.0.0.1",
                    keepalive_seconds=0.0,
                ),
                20.0,
            )
            self.assertEqual(
                apply_loopback_quiet_standby_keepalive_guard(
                    use_quiet_standby=True,
                    use_scale_to_zero=False,
                    bind_host="localhost",
                    keepalive_seconds=0.0,
                ),
                20.0,
            )
            self.assertEqual(
                apply_loopback_quiet_standby_keepalive_guard(
                    use_quiet_standby=True,
                    use_scale_to_zero=False,
                    bind_host="::1",
                    keepalive_seconds=0.0,
                ),
                20.0,
            )
            self.assertEqual(
                apply_loopback_quiet_standby_keepalive_guard(
                    use_quiet_standby=True,
                    use_scale_to_zero=True,
                    bind_host="127.0.0.1",
                    keepalive_seconds=0.0,
                ),
                0.0,
            )
            self.assertEqual(
                apply_loopback_quiet_standby_keepalive_guard(
                    use_quiet_standby=True,
                    use_scale_to_zero=False,
                    bind_host="0.0.0.0",
                    keepalive_seconds=0.0,
                ),
                0.0,
            )
        with patch.dict(os.environ, {"SPACE_ID": "demo/viread-ocr"}, clear=False):
            self.assertEqual(
                apply_loopback_quiet_standby_keepalive_guard(
                    use_quiet_standby=True,
                    use_scale_to_zero=False,
                    bind_host="127.0.0.1",
                    keepalive_seconds=0.0,
                ),
                0.0,
            )

        # 2. drain_queue_synchronously must NEVER call claim_next_job when runtime is degraded
        token = "q" * 40
        claim_calls = 0
        heartbeats: list[dict] = []

        def backend_handler(request: httpx.Request) -> httpx.Response:
            nonlocal claim_calls
            if request.url.path == "/internal/ocr-jobs/claim":
                claim_calls += 1
                return httpx.Response(200, json={"job": {"job_id": "should-not-claim"}})
            if request.url.path == "/internal/ocr-jobs/worker-heartbeat":
                heartbeats.append(json.loads(request.content.decode("utf-8")))
                return httpx.Response(200, json={"ok": True})
            return httpx.Response(404)

        degraded_rt = OcrRuntimeManager(worker_id="w-drain-degraded")
        with degraded_rt._state_lock:
            degraded_rt._engines["paddleocr"].installed = True
            degraded_rt._engines["paddleocr"].loaded = False
            degraded_rt._engines["paddleocr"].error = "DistutilsPlatformError"
            degraded_rt._engines["vietocr"].installed = True
            degraded_rt._engines["vietocr"].loaded = True
            degraded_rt._last_error = "paddleocr:DistutilsPlatformError"

        client = BackendOcrClient(
            "https://api.example",
            token,
            transport=httpx.MockTransport(backend_handler),
        )
        try:
            with patch.object(
                degraded_rt,
                "initialize_and_verify_engines",
                side_effect=lambda **_kw: degraded_rt.health_payload(),
            ):
                drained = drain_queue_synchronously(
                    client,
                    degraded_rt,
                    straggler_wait_seconds=0.01,
                )
            self.assertEqual(drained, 0)
            self.assertEqual(claim_calls, 0)
        finally:
            client.close()

        # 3. QuietStandby loopback keepalive runs maybe_resync_active_model and blocks claim if resync degrades
        resync_calls = 0
        initial_burst_claim_calls = 0
        keepalive_claim_calls = 0
        total_backend_requests = 0
        wait_invocations = 0

        def keepalive_backend_handler(request: httpx.Request) -> httpx.Response:
            nonlocal initial_burst_claim_calls, keepalive_claim_calls, total_backend_requests
            total_backend_requests += 1
            if total_backend_requests > 25:
                raise AssertionError("Unexpected spin loop in keepalive_backend_handler")
            if request.url.path == "/internal/ocr-jobs/claim":
                if wait_invocations < 2 and resync_calls == 0:
                    initial_burst_claim_calls += 1
                    return httpx.Response(200, json={"job": None})
                keepalive_claim_calls += 1
                return httpx.Response(200, json={"job": {"job_id": "should-not-claim-in-keepalive"}})
            if request.url.path == "/internal/ocr-jobs/worker-heartbeat":
                return httpx.Response(200, json={"ok": True})
            return httpx.Response(404)

        ka_clock = [2000.0]

        class _KeepaliveDegradingRuntime(OcrRuntimeManager):
            def __post_init__(self) -> None:
                super().__post_init__()
                with self._state_lock:
                    self._ocr_engine_mod = object()
                    self._engines["paddleocr"].installed = True
                    self._engines["paddleocr"].loaded = True
                    self._engines["vietocr"].installed = True
                    self._engines["vietocr"].loaded = True

            def initialize_and_verify_engines(self, **_kwargs):
                return self.health_payload()

            def maybe_resync_active_model(self, **_kwargs) -> bool:
                nonlocal resync_calls
                resync_calls += 1
                with self._state_lock:
                    self._engines["vietocr"].loaded = False
                    self._engines["vietocr"].inference_verified = False
                    self._engines["vietocr"].error = "RuntimeError"
                    self._last_error = "vietocr:RuntimeError"
                return True

        def fake_wait_wake_or_stop(stop_event, _wake_event, timeout_seconds):
            nonlocal wait_invocations
            wait_invocations += 1
            if wait_invocations > 10:
                stop_event.set()
                raise AssertionError("Unexpected wait loop spin in fake_wait_wake_or_stop")
            if wait_invocations == 1:
                # First wait: expire initial burst window so next iteration enters QuietStandby keepalive
                ka_clock[0] += float(timeout_seconds or 20.0) + 200.0
                return False
            if wait_invocations == 2:
                # Second wait is keepalive_wait (clamped to 20.0s on loopback!)
                self.assertEqual(timeout_seconds, 20.0)
                ka_clock[0] += 20.0
                return False
            stop_event.set()
            return False

        def make_ka_client(backend_url: str, worker_token: str) -> BackendOcrClient:
            return BackendOcrClient(
                backend_url,
                worker_token,
                transport=httpx.MockTransport(keepalive_backend_handler),
            )

        fake_ka_server = MagicMock()
        fake_ka_server.run = lambda: None

        with (
            patch.dict(
                os.environ,
                {"SPACE_ID": "", "VIREAD_OCR_SCALE_TO_ZERO": "false"},
                clear=False,
            ),
            patch("ocr_worker.worker.OcrRuntimeManager", _KeepaliveDegradingRuntime),
            patch("ocr_worker.worker.BackendOcrClient", side_effect=make_ka_client),
            patch("ocr_worker.worker.uvicorn.Server", return_value=fake_ka_server),
            patch("ocr_worker.worker._wait_for_wake_or_stop", side_effect=fake_wait_wake_or_stop),
            patch("ocr_worker.worker._sleep_degraded_backoff", side_effect=lambda stop_ev, *_a, **_kw: (stop_ev.set(), 0.0)[1]),
            patch("ocr_worker.worker.drain_queue_synchronously", return_value=0),
            patch("ocr_worker.worker.time.monotonic", side_effect=lambda: ka_clock[0]),
        ):
            rc_ka = run_worker_forever(
                backend_url="https://api.example",
                worker_token=token,
                bind_host="127.0.0.1",
                bind_port=18021,
                apply_priority=False,
                quiet_standby=True,
                quiet_standby_keepalive_seconds=0.0,
                wake_burst_seconds=10.0,
                max_degraded_seconds=180.0,
            )
        self.assertEqual(rc_ka, 0)
        self.assertEqual(initial_burst_claim_calls, 1)
        self.assertEqual(resync_calls, 1)
        self.assertEqual(keepalive_claim_calls, 0)

    def test_degraded_watchdog_progressive_backoff_and_exit_code_2(self):
        import json
        from unittest.mock import MagicMock

        self.assertEqual(
            [compute_degraded_retry_backoff(i) for i in range(5)],
            [15.0, 30.0, 60.0, 60.0, 60.0],
        )
        with patch.dict(os.environ, {"VIREAD_OCR_MAX_DEGRADED_SECONDS": ""}, clear=False):
            self.assertEqual(resolve_max_degraded_seconds(), 180.0)
        self.assertEqual(resolve_max_degraded_seconds(0), 0.0)
        self.assertEqual(resolve_max_degraded_seconds(-10), 0.0)
        self.assertEqual(resolve_max_degraded_seconds(90), 90.0)

        token = "w" * 40
        claim_calls = 0
        heartbeat_statuses: list[str] = []

        def backend_handler(request: httpx.Request) -> httpx.Response:
            nonlocal claim_calls
            if request.url.path == "/internal/ocr-jobs/claim":
                claim_calls += 1
                return httpx.Response(200, json={"job": {"job_id": "never"}})
            if request.url.path == "/internal/ocr-jobs/worker-heartbeat":
                body = json.loads(request.content.decode("utf-8"))
                heartbeat_statuses.append(str(body.get("status")))
                return httpx.Response(200, json={"ok": True})
            return httpx.Response(404)

        fake_clock = [1000.0]
        recorded_sleeps: list[float] = []

        class _AlwaysDegradedRuntime(OcrRuntimeManager):
            def __post_init__(self) -> None:
                super().__post_init__()
                with self._state_lock:
                    self._ocr_engine_mod = object()
                    self._engines["paddleocr"].installed = True
                    self._engines["paddleocr"].loaded = False
                    self._engines["paddleocr"].error = "DistutilsPlatformError"
                    self._engines["vietocr"].installed = True
                    self._engines["vietocr"].loaded = True
                    self._last_error = "paddleocr:DistutilsPlatformError"

            def initialize_and_verify_engines(self, **_kwargs):
                return self.health_payload()

        def fake_sleep_backoff(stop_event, wait_seconds, **_kwargs):
            recorded_sleeps.append(round(float(wait_seconds), 3))
            fake_clock[0] += float(wait_seconds)
            return 0.0

        def make_mock_client(backend_url: str, worker_token: str) -> BackendOcrClient:
            return BackendOcrClient(
                backend_url,
                worker_token,
                transport=httpx.MockTransport(backend_handler),
            )

        fake_server = MagicMock()
        fake_server.run = lambda: None

        with (
            patch("ocr_worker.worker.OcrRuntimeManager", _AlwaysDegradedRuntime),
            patch("ocr_worker.worker.BackendOcrClient", side_effect=make_mock_client),
            patch("ocr_worker.worker.uvicorn.Server", return_value=fake_server),
            patch("ocr_worker.worker._sleep_degraded_backoff", side_effect=fake_sleep_backoff),
            patch("ocr_worker.worker.time.monotonic", side_effect=lambda: fake_clock[0]),
        ):
            rc = run_worker_forever(
                backend_url="https://api.example",
                worker_token=token,
                bind_host="127.0.0.1",
                bind_port=18020,
                apply_priority=False,
                quiet_standby=False,
                max_degraded_seconds=180.0,
            )

        self.assertEqual(rc, 2)
        self.assertEqual(claim_calls, 0)
        self.assertEqual(recorded_sleeps, [15.0, 30.0, 60.0, 60.0, 15.0])
        self.assertIn("DEGRADED", heartbeat_statuses)
        self.assertEqual(heartbeat_statuses[-1], "OFFLINE")


if __name__ == "__main__":
    unittest.main()
