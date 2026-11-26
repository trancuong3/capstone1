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
    OcrRuntimeManager,
    build_smoke_test_image_bytes,
    build_worker_http_app,
    configure_cpu_thread_caps,
    install_vietocr_safe_config_loader,
    install_zero_db_config_shim,
)
from ocr_worker.worker import (  # noqa: E402
    DEFAULT_BACKEND_TIMEOUT_SECONDS,
    BackendOcrClient,
    compute_adaptive_poll_delay,
    is_quiet_standby_enabled,
    process_claimed_job,
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

        from scripts.build_hf_space_bundle import build_hf_space_bundle

        with tempfile.TemporaryDirectory(prefix="viread-hf-bundle-test-") as tmp_bundle:
            summary = build_hf_space_bundle(Path(tmp_bundle) / "space")
            self.assertLess(summary["total_bytes"], 1_048_576)
            self.assertGreaterEqual(summary["file_count"], 18)


if __name__ == "__main__":
    unittest.main()
