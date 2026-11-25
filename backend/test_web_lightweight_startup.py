from __future__ import annotations

import asyncio
import json
import os
import subprocess
import sys
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock, patch

from fastapi.testclient import TestClient

BACKEND_DIR = Path(__file__).resolve().parent
REPO_ROOT = BACKEND_DIR.parent


class TestWebLightweightStartupAndHealth(unittest.TestCase):
    def test_requirements_web_excludes_heavy_ocr_dependencies(self):
        web_req = (BACKEND_DIR / "requirements-web.txt").read_text(encoding="utf-8")
        full_req = (BACKEND_DIR / "requirements.txt").read_text(encoding="utf-8")

        for forbidden in (
            "torch==",
            "torchvision==",
            "paddlepaddle==",
            "paddleocr==",
            "vietocr==",
            "pytesseract==",
            "jiwer==",
            "scipy==",
        ):
            self.assertNotIn(forbidden, web_req)
        self.assertIn("fastapi==0.121.2", web_req)
        self.assertIn("opencv-python-headless==4.10.0.84", web_req)
        self.assertIn("numpy==1.26.4", web_req)

        # Ensure ABI-locked backend/requirements.txt stays completely intact.
        for required_pin in (
            "numpy==1.26.4",
            "protobuf==3.20.2",
            "opencv-python-headless==4.10.0.84",
            "pytesseract==0.3.13",
            "paddleocr==2.7.3",
            "paddlepaddle==2.6.2",
            "vietocr==0.3.12",
        ):
            self.assertIn(required_pin, full_req)

    def test_remote_worker_mode_imports_zero_heavy_ml_modules_at_startup(self):
        script = """
import json, os, sys
sys.path.insert(0, %r)
os.environ["APP_ENVIRONMENT"] = "test"
os.environ["VIREAD_OCR_MODE"] = "remote_worker"
os.environ["VIREAD_WEB_DISABLE_HEAVY_WORKERS"] = "true"
os.environ.setdefault("DATABASE_URL", "postgresql+asyncpg://x:y@127.0.0.1:5432/z")
os.environ.setdefault("SUPABASE_URL", "https://example.supabase.co")
os.environ.setdefault("SUPABASE_KEY", "test-anon-key")
os.environ.setdefault("SUPABASE_SERVICE_ROLE_KEY", "test-service-role-key")

import app.sever  # noqa: F401
from app.services import admin_ocr_service, local_ocr_scan_service, parent_private_book_service  # noqa: F401
from app.jobs import parent_book_submission_worker  # noqa: F401

forbidden = [
    name for name in (
        "torch", "torchvision", "paddle", "paddleocr", "vietocr",
        "pytesseract", "jiwer",
        "app.services.ocr_engine", "app.services.parent_private_book_pipeline",
    )
    if name in sys.modules
]
print(json.dumps({"forbidden_loaded": forbidden}))
""" % (
            str(BACKEND_DIR),
        )
        proc = subprocess.run(
            [sys.executable, "-c", script],
            capture_output=True,
            text=True,
            check=True,
            timeout=30,
        )
        data = json.loads(proc.stdout.strip().splitlines()[-1])
        self.assertEqual(data["forbidden_loaded"], [])

    def test_parent_book_worker_runs_lightweight_post_ocr_sweeper_in_remote_mode(self):
        from app.jobs import parent_book_submission_worker

        fake_claimed = SimpleNamespace(Id="00000000-0000-4000-8000-000000000123")
        fake_repo = SimpleNamespace(
            claim_next_checking_submission=AsyncMock(return_value=fake_claimed)
        )
        fake_session = AsyncMock()
        fake_cm = MagicMock()
        fake_cm.__aenter__ = AsyncMock(return_value=fake_session)
        fake_cm.__aexit__ = AsyncMock(return_value=False)
        with (
            patch.dict(
                os.environ,
                {
                    "VIREAD_OCR_MODE": "remote_worker",
                    "VIREAD_WEB_DISABLE_HEAVY_WORKERS": "true",
                },
                clear=False,
            ),
            patch.object(parent_book_submission_worker, "AsyncSessionLocal", MagicMock(return_value=fake_cm)),
            patch.object(
                parent_book_submission_worker,
                "ParentPrivateBookRepository",
                return_value=fake_repo,
            ),
            patch.object(
                parent_book_submission_worker,
                "run_parent_submission_post_ocr",
                AsyncMock(return_value={"status": "PASSED_READY_TO_ADD"}),
            ) as mock_post_ocr,
        ):
            did_work = asyncio.run(parent_book_submission_worker.run_once())
            self.assertTrue(did_work)
            fake_repo.claim_next_checking_submission.assert_awaited_once()
            self.assertTrue(
                fake_repo.claim_next_checking_submission.await_args.kwargs.get("only_post_ocr")
            )
            mock_post_ocr.assert_awaited_once_with(fake_claimed.Id)

    def test_lifespan_decouples_lightweight_workers_from_remote_ocr_mode(self):
        import app.sever as sever_mod

        called_workers: list[str] = []

        async def _fake_worker(stop_event):
            called_workers.append("started")
            await stop_event.wait()

        with (
            patch.dict(
                os.environ,
                {
                    "VIREAD_OCR_MODE": "remote_worker",
                    "VIREAD_WEB_DISABLE_HEAVY_WORKERS": "true",
                    "VIREAD_OCR_WARMUP_ENABLED": "true",
                    "PARENT_BOOK_WORKER_ENABLED": "true",
                    "VIREAD_OCR_OUTBOX_WORKER_ENABLED": "true",
                    "VIREAD_OCR_AUTO_TRAINING_WORKER_ENABLED": "true",
                    "BACKGROUND_WORKER_STARTUP_DELAY_SECONDS": "0",
                },
                clear=False,
            ),
            patch.object(sever_mod, "APP_ENVIRONMENT", "staging"),
            patch.object(sever_mod, "warmup_ocr_engines", side_effect=AssertionError("should not warmup")),
            patch.object(sever_mod, "run_active_viread_model_worker", side_effect=AssertionError("should not poll active model")),
            patch.object(sever_mod, "run_viread_ocr_outbox_worker", new=_fake_worker),
            patch.object(sever_mod, "run_viread_ocr_training_auto_worker", new=_fake_worker),
            patch.object(sever_mod, "run_parent_book_submission_worker", new=_fake_worker),
            patch.object(sever_mod, "run_book_quality_worker", new=_fake_worker),
            patch.object(sever_mod, "run_admin_ai_workflow_worker", new=_fake_worker),
            patch.object(sever_mod, "ensure_local_voice_worker_running", AsyncMock(return_value=False)),
            patch.object(sever_mod, "probe_database_connection", AsyncMock(return_value={
                "ok": True, "dns_resolved": True, "ssl_enabled": True,
                "pool_class": "NullPool", "pooler_mode": "transaction", "latency_ms": 2.0,
                "error_type": None,
            })),
        ):
            with TestClient(sever_mod.app) as client:
                state = client.app.state.background_workers
                self.assertIsNotNone(state["viread_ocr_outbox"])
                self.assertIsNotNone(state["viread_ocr_training"])
                self.assertIsNotNone(state["parent_book_submission"])
                self.assertIsNone(state["active_model_registry"])
                self.assertIsNone(state["local_trainer_process"])

        # Gated strictly by their own env flags when disabled:
        with (
            patch.dict(
                os.environ,
                {
                    "VIREAD_OCR_MODE": "remote_worker",
                    "VIREAD_WEB_DISABLE_HEAVY_WORKERS": "true",
                    "PARENT_BOOK_WORKER_ENABLED": "false",
                    "VIREAD_OCR_OUTBOX_WORKER_ENABLED": "false",
                    "VIREAD_OCR_AUTO_TRAINING_WORKER_ENABLED": "false",
                    "BACKGROUND_WORKER_STARTUP_DELAY_SECONDS": "0",
                },
                clear=False,
            ),
            patch.object(sever_mod, "APP_ENVIRONMENT", "staging"),
            patch.object(sever_mod, "run_book_quality_worker", new=_fake_worker),
            patch.object(sever_mod, "run_admin_ai_workflow_worker", new=_fake_worker),
            patch.object(sever_mod, "ensure_local_voice_worker_running", AsyncMock(return_value=False)),
            patch.object(sever_mod, "probe_database_connection", AsyncMock(return_value={
                "ok": True, "dns_resolved": True, "ssl_enabled": True,
                "pool_class": "NullPool", "pooler_mode": "transaction", "latency_ms": 2.0,
                "error_type": None,
            })),
        ):
            with TestClient(sever_mod.app) as client:
                state = client.app.state.background_workers
                self.assertIsNone(state["viread_ocr_outbox"])
                self.assertIsNone(state["viread_ocr_training"])
                self.assertIsNone(state["parent_book_submission"])

    def test_health_never_marks_installed_as_ready_and_exposes_version_header(self):
        import app.sever as sever_mod

        fake_db = {
            "ok": True,
            "dns_resolved": True,
            "ssl_enabled": True,
            "pool_class": "NullPool",
            "pooler_mode": "transaction",
            "latency_ms": 1.2,
        }
        installed_only_items = [
            {"id": "paddleocr", "status": "DEGRADED", "detail_status": "installed"},
            {"id": "vietocr", "status": "DEGRADED", "detail_status": "installed"},
            {"id": "tesseract_vie", "status": "HEALTHY", "detail_status": "healthy"},
        ]

        with (
            patch.dict(
                os.environ,
                {"VIREAD_OCR_MODE": "local_inprocess", "VIREAD_APP_VERSION": "2.4.1-staging"},
                clear=False,
            ),
            patch.object(sever_mod, "probe_database_connection", AsyncMock(return_value=fake_db)),
            patch.object(sever_mod, "collect_ocr_health", return_value=installed_only_items),
        ):
            client = TestClient(sever_mod.app)
            resp = client.get("/health")
            self.assertEqual(resp.status_code, 200)
            self.assertEqual(resp.headers.get("X-ViRead-Version"), "2.4.1-staging")
            body = resp.json()
            self.assertEqual(body["version"], "2.4.1-staging")
            self.assertFalse(body["ocr"]["ready"])

        # Now verify remote_worker /health returns worker heartbeat, engine states, and queue depth.
        remote_snapshot = {
            "mode": "remote_worker",
            "ready": True,
            "heartbeat_ttl_seconds": 45,
            "engines": {
                "paddleocr": {"status": "HEALTHY", "detail_status": "inference_verified", "installed": True, "loaded": True, "inference_verified": True},
                "vietocr": {"status": "HEALTHY", "detail_status": "inference_verified", "installed": True, "loaded": True, "inference_verified": True},
                "tesseract_vie": {"status": "HEALTHY", "detail_status": "inference_verified", "installed": True, "loaded": True, "inference_verified": True},
            },
            "workers": [{"worker_id": "win-ocr-1", "status": "IDLE", "online": True, "age_seconds": 3.2}],
            "queue": {"queued": 2, "claimed": 0, "running": 1, "failed_retryable": 0, "dead_letter": 0, "pending_total": 2, "active_total": 1},
        }
        with (
            patch.dict(os.environ, {"VIREAD_OCR_MODE": "remote_worker"}, clear=False),
            patch.object(sever_mod, "probe_database_connection", AsyncMock(return_value=fake_db)),
            patch.object(sever_mod, "collect_remote_ocr_health", AsyncMock(return_value=remote_snapshot)),
        ):
            client = TestClient(sever_mod.app)
            resp = client.get("/health")
            self.assertEqual(resp.status_code, 200)
            body = resp.json()
            self.assertEqual(body["ocr"]["mode"], "remote_worker")
            self.assertTrue(body["ocr"]["ready"])
            self.assertEqual(body["ocr"]["workers"][0]["worker_id"], "win-ocr-1")
            self.assertEqual(body["ocr"]["queue"]["queued"], 2)


if __name__ == "__main__":
    unittest.main()
