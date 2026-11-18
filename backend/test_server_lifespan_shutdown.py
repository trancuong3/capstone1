"""Tests for graceful FastAPI lifespan shutdown under Ctrl+C cancellation and worker timeouts."""

from __future__ import annotations

import asyncio
import inspect
import os
from pathlib import Path
import unittest
from unittest.mock import AsyncMock, patch

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

        with (
            patch("app.sever.APP_ENVIRONMENT", "development"),
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
            patch(
                "app.sever.engine.dispose",
                new_callable=AsyncMock,
            ) as mock_engine_dispose,
        ):
            lifespan_task = asyncio.create_task(
                target_router.lifespan({"app": app, "state": {}}, receive, send)
            )
            await asyncio.wait_for(worker_started.wait(), timeout=2.0)
            await asyncio.sleep(0.02)

            self.assertEqual(
                sent_messages, [{"type": "lifespan.startup.complete"}]
            )

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
            mock_engine_dispose.assert_awaited_once()

    async def test_lifespan_cancels_timed_out_workers_on_graceful_shutdown(self):
        worker_cancelled = asyncio.Event()

        async def unresponsive_worker(_stop: asyncio.Event) -> None:
            try:
                await asyncio.Future()
            except asyncio.CancelledError:
                worker_cancelled.set()
                raise

        with (
            patch("app.sever.APP_ENVIRONMENT", "development"),
            patch("app.sever._WORKER_SHUTDOWN_TIMEOUT_SECONDS", 0.05),
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
            patch(
                "app.sever.engine.dispose",
                new_callable=AsyncMock,
            ) as mock_engine_dispose,
        ):
            async with lifespan(app):
                await asyncio.sleep(0.01)

            self.assertTrue(worker_cancelled.is_set())
            mock_jobs_shutdown.assert_awaited_once()
            mock_engine_dispose.assert_awaited_once()

    async def test_non_cancellation_errors_still_propagate_from_lifespan_body(self):
        with (
            patch(
                "app.sever.admin_ocr_correction_jobs.shutdown",
                new_callable=AsyncMock,
            ) as mock_jobs_shutdown,
            patch(
                "app.sever.engine.dispose",
                new_callable=AsyncMock,
            ) as mock_engine_dispose,
        ):
            with self.assertRaisesRegex(RuntimeError, "simulated failure"):
                async with lifespan(app):
                    raise RuntimeError("simulated failure")

            mock_jobs_shutdown.assert_awaited_once()
            mock_engine_dispose.assert_awaited_once()


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
