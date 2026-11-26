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
    install_zero_db_config_shim,
)
from ocr_worker.worker import (  # noqa: E402
    BackendOcrClient,
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


if __name__ == "__main__":
    unittest.main()
