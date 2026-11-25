"""Unit tests for automatic local Windows voice worker bootstrap and recovery."""

from __future__ import annotations

import asyncio
import os
import subprocess
import tempfile
import unittest
from pathlib import Path
from unittest.mock import AsyncMock, MagicMock, patch

import httpx

os.environ.setdefault("DATABASE_URL", "postgresql+asyncpg://test:test@127.0.0.1:1/test")
os.environ.setdefault("SUPABASE_URL", "https://example.supabase.co")
os.environ.setdefault("SUPABASE_KEY", "isolated-test-key")

from app.providers.local_voice_provider import LocalVoiceProvider
from app.services import local_voice_worker_bootstrap as bootstrap


class LocalVoiceWorkerBootstrapTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self) -> None:
        bootstrap.reset_local_voice_worker_bootstrap_state()

    def tearDown(self) -> None:
        bootstrap.reset_local_voice_worker_bootstrap_state()

    def test_parse_loopback_worker_endpoint(self) -> None:
        self.assertEqual(
            bootstrap.parse_loopback_worker_endpoint("http://127.0.0.1:8010"),
            ("127.0.0.1", 8010),
        )
        self.assertEqual(
            bootstrap.parse_loopback_worker_endpoint("http://localhost:8011"),
            ("127.0.0.1", 8011),
        )
        self.assertIsNone(
            bootstrap.parse_loopback_worker_endpoint("https://127.0.0.1:8010")
        )
        self.assertIsNone(
            bootstrap.parse_loopback_worker_endpoint("http://192.168.1.5:8010")
        )

    def test_should_autostart_respects_environment_and_provisioning_guards(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            script = root / "Start-ViReadVoiceWorker.ps1"
            script.write_text("# mock", encoding="utf-8")
            runtime = root / "voice-runtime"
            py_exe = runtime / ".venv" / "Scripts" / "python.exe"
            py_exe.parent.mkdir(parents=True, exist_ok=True)
            py_exe.write_text("", encoding="utf-8")

            ok, reason = bootstrap.should_autostart_local_voice_worker(
                base_url="http://127.0.0.1:8010",
                platform_name="win32",
                app_environment="development",
                render_env="",
                autostart_env="true",
                runtime_dir=runtime,
                start_script_path=script,
            )
            self.assertTrue(ok)
            self.assertEqual(reason, "eligible")

            for kwargs, expected_reason in [
                ({"platform_name": "linux"}, "non_windows_host"),
                ({"app_environment": "test"}, "app_environment_test"),
                ({"app_environment": "production"}, "app_environment_production"),
                ({"render_env": "true"}, "render_environment"),
                ({"autostart_env": "false"}, "autostart_disabled"),
                (
                    {"base_url": "http://10.0.0.5:8010"},
                    "non_loopback_worker_url",
                ),
            ]:
                params = dict(
                    base_url="http://127.0.0.1:8010",
                    platform_name="win32",
                    app_environment="development",
                    render_env="",
                    autostart_env="true",
                    runtime_dir=runtime,
                    start_script_path=script,
                )
                params.update(kwargs)
                allowed, actual_reason = bootstrap.should_autostart_local_voice_worker(
                    **params
                )
                self.assertFalse(allowed)
                self.assertEqual(actual_reason, expected_reason)

    async def test_local_voice_provider_recovers_on_connect_error_when_armed(self) -> None:
        bootstrap.arm_local_voice_worker_autostart(True)
        provider = LocalVoiceProvider(base_url="http://127.0.0.1:8010")
        calls = 0

        class FakeClient:
            is_closed = False

            async def post(self, url, **_kwargs):
                nonlocal calls
                calls += 1
                if calls == 1:
                    raise httpx.ConnectError(
                        "Connection refused", request=httpx.Request("POST", url)
                    )
                return httpx.Response(
                    200,
                    json={
                        "text": "xin chào",
                        "language_code": "vi",
                        "words": [{"text": "xin", "start": 0.0, "end": 0.2}],
                    },
                )

        provider._client = FakeClient()  # type: ignore[assignment]
        with patch(
            "app.providers.local_voice_provider.ensure_local_voice_worker_running",
            new=AsyncMock(return_value=True),
        ) as mock_ensure:
            result = await provider.transcribe(
                audio=b"RIFF....",
                filename="seg.wav",
                content_type="audio/wav",
            )

        self.assertEqual(result.text, "xin chào")
        self.assertEqual(calls, 2)
        mock_ensure.assert_awaited_once_with(base_url="http://127.0.0.1:8010")

    async def test_local_voice_provider_does_not_autostart_when_unarmed(self) -> None:
        bootstrap.arm_local_voice_worker_autostart(False)
        provider = LocalVoiceProvider(base_url="http://127.0.0.1:8010")

        class AlwaysFailClient:
            is_closed = False

            async def post(self, url, **_kwargs):
                raise httpx.ConnectError(
                    "Connection refused", request=httpx.Request("POST", url)
                )

            async def aclose(self):
                self.is_closed = True

        provider._client = AlwaysFailClient()  # type: ignore[assignment]
        with patch(
            "app.providers.local_voice_provider.ensure_local_voice_worker_running",
            new=AsyncMock(return_value=True),
        ) as mock_ensure:
            with self.assertRaises(Exception):
                await provider.transcribe(
                    audio=b"RIFF....",
                    filename="seg.wav",
                    content_type="audio/wav",
                )

        mock_ensure.assert_not_called()

    async def test_ensure_local_voice_worker_uses_pipe_free_popen_for_uvicorn_windows_loop(
        self,
    ) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            script = root / "Start-ViReadVoiceWorker.ps1"
            script.write_text("# mock", encoding="utf-8")
            runtime = root / "voice-runtime"
            py_exe = runtime / ".venv" / "Scripts" / "python.exe"
            py_exe.parent.mkdir(parents=True, exist_ok=True)
            py_exe.write_text("", encoding="utf-8")

            health_states = iter([False, False, True])

            async def fake_health(_url: str) -> bool:
                return next(health_states)

            fake_proc = MagicMock()
            fake_proc.poll.return_value = None

            with (
                patch.object(bootstrap, "_is_worker_healthy", side_effect=fake_health),
                patch.object(
                    bootstrap,
                    "should_autostart_local_voice_worker",
                    return_value=(True, "eligible"),
                ),
                patch.object(bootstrap, "_resolve_voice_runtime_dir", return_value=runtime),
                patch.object(bootstrap, "_resolve_start_script_path", return_value=script),
                patch.object(
                    bootstrap.subprocess, "Popen", MagicMock(return_value=fake_proc)
                ) as mock_popen,
            ):
                ok = await bootstrap.ensure_local_voice_worker_running(
                    base_url="http://127.0.0.1:8010"
                )

        self.assertTrue(ok)
        mock_popen.assert_called_once()
        cmd = mock_popen.call_args.args[0]
        self.assertIn("-ReplaceIncompatibleWorker", cmd)
        kwargs = mock_popen.call_args.kwargs
        self.assertEqual(kwargs["stdin"], subprocess.DEVNULL)
        self.assertEqual(kwargs["stdout"], subprocess.DEVNULL)
        self.assertEqual(kwargs["stderr"], subprocess.DEVNULL)
        self.assertTrue(kwargs["close_fds"])

    async def test_is_worker_healthy_rejects_auth_required_foreign_worker_without_token(
        self,
    ) -> None:
        class AuthGatedClient:
            def __init__(self, **_kwargs):
                pass

            async def __aenter__(self):
                return self

            async def __aexit__(self, *_args):
                return None

            async def get(self, _url, **_kwargs):
                return httpx.Response(
                    200,
                    json={"status": "ok", "auth_required": True},
                )

        with patch(
            "app.services.local_voice_worker_bootstrap.httpx.AsyncClient",
            AuthGatedClient,
        ):
            with patch.dict(os.environ, {}, clear=False):
                os.environ.pop("VIREAD_VOICE_WORKER_TOKEN", None)
                os.environ.pop("VIREAD_LOCAL_VOICE_WORKER_TOKEN", None)
                self.assertFalse(
                    await bootstrap._is_worker_healthy("http://127.0.0.1:8010")
                )
            with patch.dict(
                os.environ,
                {"VIREAD_VOICE_WORKER_TOKEN": "valid-token"},
                clear=False,
            ):
                self.assertTrue(
                    await bootstrap._is_worker_healthy("http://127.0.0.1:8010")
                )

    async def test_local_voice_provider_recovers_on_auth_mismatch_http_status_when_armed(
        self,
    ) -> None:
        bootstrap.arm_local_voice_worker_autostart(True)
        with patch.dict(os.environ, {}, clear=False):
            os.environ.pop("VIREAD_VOICE_WORKER_TOKEN", None)
            os.environ.pop("VIREAD_LOCAL_VOICE_WORKER_TOKEN", None)
            provider = LocalVoiceProvider(base_url="http://127.0.0.1:8010")

        calls = 0

        class FakeAuthMismatchClient:
            is_closed = False

            async def post(self, _url, **_kwargs):
                nonlocal calls
                calls += 1
                if calls == 1:
                    return httpx.Response(401, json={"detail": "unauthorized"})
                return httpx.Response(
                    200,
                    json={
                        "text": "xin chào",
                        "language_code": "vi",
                        "words": [{"text": "xin", "start": 0.0, "end": 0.2}],
                    },
                )

        class FakeHealthClient:
            is_closed = False

            def __init__(self, **_kwargs):
                pass

            async def __aenter__(self):
                return self

            async def __aexit__(self, *_args):
                return None

            async def aclose(self):
                self.is_closed = True

            async def get(self, _url, **_kwargs):
                return httpx.Response(
                    200, json={"status": "ok", "auth_required": True}
                )

        provider._client = FakeAuthMismatchClient()  # type: ignore[assignment]
        with (
            patch(
                "app.providers.local_voice_provider.httpx.AsyncClient",
                FakeHealthClient,
            ),
            patch(
                "app.providers.local_voice_provider.ensure_local_voice_worker_running",
                new=AsyncMock(return_value=True),
            ) as mock_ensure,
        ):
            result = await provider.transcribe(
                audio=b"RIFF....",
                filename="seg.wav",
                content_type="audio/wav",
            )

        self.assertEqual(result.text, "xin chào")
        self.assertEqual(calls, 2)
        mock_ensure.assert_awaited_once_with(base_url="http://127.0.0.1:8010")

    async def test_get_health_triggers_non_blocking_recovery_when_armed(self) -> None:
        bootstrap.arm_local_voice_worker_autostart(True)
        with patch.dict(os.environ, {}, clear=False):
            os.environ.pop("VIREAD_VOICE_WORKER_TOKEN", None)
            os.environ.pop("VIREAD_LOCAL_VOICE_WORKER_TOKEN", None)
            provider = LocalVoiceProvider(base_url="http://127.0.0.1:8010")

        class ConnectErrorClient:
            is_closed = False

            def __init__(self, **_kwargs):
                pass

            async def __aenter__(self):
                return self

            async def __aexit__(self, *_args):
                return None

            async def get(self, url, **_kwargs):
                raise httpx.ConnectError(
                    "Connection refused", request=httpx.Request("GET", url)
                )

        class AuthMismatchHealthClient:
            is_closed = False

            def __init__(self, **_kwargs):
                pass

            async def __aenter__(self):
                return self

            async def __aexit__(self, *_args):
                return None

            async def get(self, _url, **_kwargs):
                return httpx.Response(
                    200, json={"status": "ok", "auth_required": True}
                )

        # 1. ConnectError fires background recovery without blocking get_health()
        with (
            patch(
                "app.providers.local_voice_provider.httpx.AsyncClient",
                ConnectErrorClient,
            ),
            patch(
                "app.providers.local_voice_provider.ensure_local_voice_worker_running",
                new=AsyncMock(side_effect=RuntimeError("boom")),
            ) as mock_ensure_connect,
        ):
            health = await provider.get_health()
            self.assertFalse(health["available"])
            self.assertIsNotNone(provider._recovery_task)
            await asyncio.sleep(0)
            await asyncio.sleep(0)
            mock_ensure_connect.assert_awaited_once_with(
                base_url="http://127.0.0.1:8010"
            )
            self.assertIsNone(provider._recovery_task)

        # 2. auth_required mismatch also fires background recovery when armed
        with (
            patch(
                "app.providers.local_voice_provider.httpx.AsyncClient",
                AuthMismatchHealthClient,
            ),
            patch(
                "app.providers.local_voice_provider.ensure_local_voice_worker_running",
                new=AsyncMock(return_value=True),
            ) as mock_ensure_auth,
        ):
            health_auth = await provider.get_health()
            self.assertFalse(health_auth["available"])
            self.assertIsNotNone(provider._recovery_task)
            await asyncio.sleep(0)
            await asyncio.sleep(0)
            mock_ensure_auth.assert_awaited_once_with(
                base_url="http://127.0.0.1:8010"
            )
            self.assertIsNone(provider._recovery_task)


if __name__ == "__main__":
    unittest.main()
