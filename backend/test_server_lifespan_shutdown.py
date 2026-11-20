"""Tests for FastAPI lifespan, /docs, /health, worker startup/shutdown, and dependency pins."""

from __future__ import annotations

import asyncio
import inspect
import os
from pathlib import Path
from types import SimpleNamespace
import unittest
from unittest.mock import AsyncMock, patch

import json
from fastapi import FastAPI
from starlette.routing import Router as StarletteRouter

os.environ.setdefault(
    "DATABASE_URL", "postgresql+asyncpg://test:test@127.0.0.1:1/test"
)
os.environ.setdefault("SUPABASE_URL", "https://example.supabase.co")
os.environ.setdefault("SUPABASE_KEY", "isolated-test-key")
os.environ.setdefault("DATABASE_POOLER_MODE", "local")
os.environ.setdefault("DATABASE_SSL_REQUIRED", "false")

from app.sever import app, lifespan


def _mock_probe_ok() -> dict[str, object]:
    return {
        "ok": True,
        "dns_resolved": True,
        "ssl_enabled": False,
        "pool_class": "NullPool",
        "pooler_mode": "local",
        "port": 5432,
        "latency_ms": 2,
        "error_type": None,
    }


class ServerLifespanShutdownTests(unittest.IsolatedAsyncioTestCase):
    async def test_lifespan_handles_simultaneous_ctrl_c_task_cancellation_cleanly(self):
        """Simulates Windows Python 3.12 asyncio.Runner cancelling receive() and workers at once."""
        worker_started = asyncio.Event()

        async def stuck_in_network_io(_stop: asyncio.Event) -> None:
            worker_started.set()
            # Simulates loop.getaddrinfo / asyncpg connect that ignores stop.set()
            await asyncio.Future()

        receive_queue: asyncio.Queue[dict[str, str]] = asyncio.Queue()
        await receive_queue.put({"type": "lifespan.startup"})
        sent_messages: list[dict[str, object]] = []

        async def receive() -> dict[str, str]:
            return await receive_queue.get()

        async def send(message: dict[str, object]) -> None:
            sent_messages.append(message)

        target_router = (
            app.router
            if "lifespan" in inspect.signature(FastAPI.__init__).parameters
            else StarletteRouter(lifespan=lifespan)
        )
        fake_engine = SimpleNamespace(dispose=AsyncMock())

        with (
            patch("app.sever.APP_ENVIRONMENT", "development"),
            patch(
                "app.sever.probe_database_connection",
                new=AsyncMock(return_value=_mock_probe_ok()),
            ),
            patch.dict(
                os.environ,
                {"VIREAD_LOCAL_TRAINING_WORKER_AUTOSTART": "false"},
                clear=False,
            ),
            patch(
                "app.sever.run_active_viread_model_worker",
                side_effect=lambda stop: stop.wait(1.0),
            ),
            patch(
                "app.sever.run_viread_ocr_outbox_worker",
                side_effect=stuck_in_network_io,
            ),
            patch(
                "app.sever.run_viread_ocr_training_auto_worker",
                side_effect=stuck_in_network_io,
            ),
            patch(
                "app.sever.run_book_quality_worker",
                side_effect=stuck_in_network_io,
            ),
            patch(
                "app.sever.admin_ocr_correction_jobs.shutdown",
                new_callable=AsyncMock,
            ) as mock_jobs_shutdown,
            patch("app.sever.engine", fake_engine),
        ):
            lifespan_task = asyncio.create_task(
                target_router.lifespan({"app": app, "state": {}}, receive, send)
            )
            await asyncio.wait_for(worker_started.wait(), timeout=2.0)
            await asyncio.sleep(0.02)

            self.assertEqual(
                sent_messages, [{"type": "lifespan.startup.complete"}]
            )
            workers = getattr(app.state, "background_workers", {})
            if workers:
                self.assertFalse(workers["viread_ocr_outbox"].done())

            # Cancel background workers AND router lifespan concurrently, matching
            # asyncio.Runner._cancel_all_tasks on Ctrl+C / reloader stop.
            for task in asyncio.all_tasks():
                if task.get_name() in {
                    "viread_ocr_verified_outbox_worker",
                    "viread_ocr_flow2_auto_training_worker",
                    "book_quality_scan_worker",
                }:
                    task.cancel()
            lifespan_task.cancel()

            result = await asyncio.gather(lifespan_task, return_exceptions=True)
            self.assertEqual(result, [None])
            self.assertEqual(
                sent_messages,
                [
                    {"type": "lifespan.startup.complete"},
                    {"type": "lifespan.shutdown.complete"},
                ],
            )
            mock_jobs_shutdown.assert_awaited_once()
            fake_engine.dispose.assert_awaited_once()

    async def test_lifespan_cancels_timed_out_workers_on_graceful_shutdown(self):
        worker_cancelled = asyncio.Event()

        async def unresponsive_worker(_stop: asyncio.Event) -> None:
            try:
                await asyncio.Future()
            except asyncio.CancelledError:
                worker_cancelled.set()
                raise

        fake_engine = SimpleNamespace(dispose=AsyncMock())
        with (
            patch("app.sever.APP_ENVIRONMENT", "development"),
            patch("app.sever._WORKER_SHUTDOWN_TIMEOUT_SECONDS", 0.05),
            patch(
                "app.sever.probe_database_connection",
                new=AsyncMock(return_value=_mock_probe_ok()),
            ),
            patch.dict(
                os.environ,
                {"VIREAD_LOCAL_TRAINING_WORKER_AUTOSTART": "false"},
                clear=False,
            ),
            patch(
                "app.sever.run_active_viread_model_worker",
                side_effect=lambda stop: stop.wait(1.0),
            ),
            patch(
                "app.sever.run_viread_ocr_outbox_worker",
                side_effect=unresponsive_worker,
            ),
            patch(
                "app.sever.run_viread_ocr_training_auto_worker",
                side_effect=unresponsive_worker,
            ),
            patch(
                "app.sever.run_book_quality_worker",
                side_effect=unresponsive_worker,
            ),
            patch(
                "app.sever.admin_ocr_correction_jobs.shutdown",
                new_callable=AsyncMock,
            ) as mock_jobs_shutdown,
            patch("app.sever.engine", fake_engine),
        ):
            async with lifespan(app):
                await asyncio.sleep(0.01)
                self.assertFalse(
                    app.state.background_workers["viread_ocr_outbox"].done()
                )

            self.assertTrue(worker_cancelled.is_set())
            self.assertEqual(app.state.background_workers, {})
            mock_jobs_shutdown.assert_awaited_once()
            fake_engine.dispose.assert_awaited_once()

    async def test_non_cancellation_errors_still_propagate_from_lifespan_body(self):
        fake_engine = SimpleNamespace(dispose=AsyncMock())
        with (
            patch(
                "app.sever.admin_ocr_correction_jobs.shutdown",
                new_callable=AsyncMock,
            ) as mock_jobs_shutdown,
            patch("app.sever.engine", fake_engine),
        ):
            with self.assertRaisesRegex(RuntimeError, "simulated failure"):
                async with lifespan(app):
                    raise RuntimeError("simulated failure")

            mock_jobs_shutdown.assert_awaited_once()
            fake_engine.dispose.assert_awaited_once()


async def _asgi_get(target_app: FastAPI, path: str) -> tuple[int, str]:
    scope = {
        "type": "http",
        "asgi": {"version": "3.0"},
        "http_version": "1.1",
        "method": "GET",
        "scheme": "http",
        "path": path,
        "raw_path": path.encode("ascii"),
        "query_string": b"",
        "headers": [(b"host", b"testserver")],
        "client": ("127.0.0.1", 50000),
        "server": ("testserver", 80),
        "app": target_app,
    }
    request_sent = False
    status_code = 0
    chunks: list[bytes] = []

    async def receive() -> dict[str, object]:
        nonlocal request_sent
        if not request_sent:
            request_sent = True
            return {"type": "http.request", "body": b"", "more_body": False}
        await asyncio.Future()
        return {"type": "http.disconnect"}

    async def send(message: dict[str, object]) -> None:
        nonlocal status_code
        if message["type"] == "http.response.start":
            status_code = int(message["status"])
        elif message["type"] == "http.response.body":
            chunks.append(bytes(message.get("body", b"")))

    await target_app(scope, receive, send)
    return status_code, b"".join(chunks).decode("utf-8")


class ServerHealthAndDocsEndpointTests(unittest.IsolatedAsyncioTestCase):
    async def test_docs_and_health_endpoints_respond_without_leaking_secrets(self):
        fake_engine = SimpleNamespace(dispose=AsyncMock())
        with (
            patch(
                "app.sever.probe_database_connection",
                new=AsyncMock(return_value=_mock_probe_ok()),
            ),
            patch("app.sever.engine", fake_engine),
        ):
            async with lifespan(app):
                docs_status, docs_text = await _asgi_get(app, "/docs")
                self.assertEqual(docs_status, 200)
                self.assertIn("Swagger UI", docs_text)

                health_status, health_text = await _asgi_get(app, "/health")
                self.assertEqual(health_status, 200)
                body = json.loads(health_text)
                self.assertEqual(body["status"], "ok")
                self.assertEqual(body["database"]["status"], "healthy")
                self.assertEqual(body["database"]["pool_class"], "NullPool")
                self.assertIn("viread_ocr_outbox", body["workers"])
                self.assertNotIn("postgresql+asyncpg://", health_text)
                self.assertNotIn("isolated-test-key", health_text)


class LocalTrainingOptInTests(unittest.IsolatedAsyncioTestCase):
    async def _inspect_lifespan(self, settings: dict[str, str]) -> AsyncMock:
        """No external workers, SQL, training, subprocess or email in this test."""
        async def idle(stop: asyncio.Event) -> None:
            await stop.wait()

        fake_engine = SimpleNamespace(dispose=AsyncMock())
        subprocess_mock = AsyncMock(
            return_value=SimpleNamespace(returncode=0)
        )
        with (
            patch.dict(os.environ, settings, clear=True),
            patch("app.sever.APP_ENVIRONMENT", "development"),
            patch(
                "app.sever.probe_database_connection",
                new=AsyncMock(return_value=_mock_probe_ok()),
            ),
            patch(
                "app.sever.run_active_viread_model_worker",
                side_effect=lambda stop: stop.wait(0.05),
            ),
            patch("app.sever.run_book_quality_worker", side_effect=idle),
            patch("app.sever.run_admin_ai_workflow_worker", side_effect=idle),
            patch("app.sever.run_viread_ocr_outbox_worker", side_effect=idle),
            patch("app.sever.run_viread_ocr_training_auto_worker", side_effect=idle),
            patch(
                "app.sever.asyncio.create_subprocess_exec",
                new=subprocess_mock,
            ),
            patch(
                "app.sever.admin_ocr_correction_jobs.shutdown",
                new=AsyncMock(),
            ),
            patch("app.sever.engine", fake_engine),
        ):
            async with lifespan(FastAPI()) as _:
                pass
        fake_engine.dispose.assert_awaited_once()
        return subprocess_mock

    async def test_local_training_never_autostarts_without_both_opt_ins(self):
        for settings in (
            {},
            {"VIREAD_LOCAL_TRAINING_ENABLED": "true"},
            {"VIREAD_LOCAL_TRAINING_WORKER_AUTOSTART": "true"},
            {
                "VIREAD_LOCAL_TRAINING_ENABLED": "false",
                "VIREAD_LOCAL_TRAINING_WORKER_AUTOSTART": "true",
            },
        ):
            with self.subTest(settings=settings):
                subprocess_mock = await self._inspect_lifespan(settings)
                subprocess_mock.assert_not_awaited()

    async def test_explicit_dual_opt_in_preserves_local_trainer_spawn(self):
        subprocess_mock = await self._inspect_lifespan({
            "VIREAD_LOCAL_TRAINING_ENABLED": "true",
            "VIREAD_LOCAL_TRAINING_WORKER_AUTOSTART": "true",
        })
        subprocess_mock.assert_awaited_once()
        args = subprocess_mock.await_args.args
        self.assertEqual(
            args[1:],
            ("-m", "app.jobs.viread_ocr_local_training_worker"),
        )


class RequirementsCompatibilityTests(unittest.TestCase):
    def test_chardet_and_locked_ocr_dependencies_remain_pinned_safely(self):
        requirements_path = Path(__file__).resolve().parent / "requirements.txt"
        pinned: dict[str, str] = {}
        for raw_line in requirements_path.read_text(encoding="utf-8").splitlines():
            line = raw_line.strip()
            if not line or line.startswith("#") or "==" not in line:
                continue
            pkg, version = line.split("==", 1)
            pinned[pkg.strip().lower()] = version.strip()

        self.assertIn("chardet", pinned)
        major, minor, patch_num = (
            int(part) for part in pinned["chardet"].split(".")[:3]
        )
        self.assertGreaterEqual((major, minor, patch_num), (3, 0, 2))
        self.assertLess((major, minor, patch_num), (6, 0, 0))

        # Guardrails from Agent.md
        self.assertEqual(pinned.get("numpy"), "1.26.4")
        self.assertEqual(pinned.get("protobuf"), "3.20.2")
        self.assertEqual(pinned.get("opencv-python-headless"), "4.10.0.84")
        self.assertEqual(pinned.get("pytesseract"), "0.3.13")


if __name__ == "__main__":
    unittest.main()
