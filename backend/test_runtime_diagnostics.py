"""Runtime diagnostics: prove no model loading and independent Tesseract checks."""
from __future__ import annotations

import os
import subprocess
import sys
import unittest
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock, patch

os.environ.setdefault("DATABASE_URL", "postgresql+asyncpg://test:test@127.0.0.1:1/test")
os.environ.setdefault("SUPABASE_URL", "https://example.supabase.co")
os.environ.setdefault("SUPABASE_KEY", "isolated-test-key")

from app.services import runtime_diagnostics


def _tesseract_result(*languages: str):
    return subprocess.CompletedProcess(
        args=["tesseract", "--list-langs"], returncode=0,
        stdout="List of available languages:\n" + "\n".join(languages) + "\n",
        stderr="",
    )


class RuntimeConfigurationDiagnosticsTests(unittest.TestCase):
    def setUp(self):
        runtime_diagnostics._cached_tesseract_languages.cache_clear()

    def test_diagnostics_return_boolean_flags_and_never_return_secret_values(self):
        with (
            patch.object(runtime_diagnostics, "SUPABASE_URL", "https://private.example"),
            patch.object(runtime_diagnostics, "SUPABASE_STORAGE_BUCKET", "private-bucket-name"),
            patch.object(runtime_diagnostics, "SUPABASE_ADMIN_KEY", "sb_secret_do_not_log"),
            patch.dict(os.environ, {"TESSERACT_CMD": "C:\\private\\tesseract.exe"}),
            patch.object(runtime_diagnostics.shutil, "which", return_value="C:\\private\\tesseract.exe"),
            patch.object(runtime_diagnostics.subprocess, "run", return_value=_tesseract_result("eng", "vie")),
            patch.object(runtime_diagnostics.importlib.util, "find_spec", return_value=MagicMock()),
        ):
            result = runtime_diagnostics.runtime_configuration_diagnostics()

        for key in (
            "supabase_url_configured", "supabase_storage_bucket_configured",
            "server_side_key_configured", "local_ocr_config_valid", "ocr_engine_available",
            "vietnamese_language_available", "tesseract_command_configured",
            "tesseract_executable_available",
        ):
            self.assertTrue(result[key], key)
        self.assertTrue(all(value is None or isinstance(value, bool) for value in result.values()))
        serialized = repr(result)
        for secret in ("private.example", "private-bucket-name",
                       "sb_secret_do_not_log", "C:\\private\\tesseract.exe"):
            self.assertNotIn(secret, serialized)

    def test_diagnostics_without_ocr_skips_probes(self):
        with (
            patch.object(runtime_diagnostics.importlib.util, "find_spec") as find,
            patch.object(runtime_diagnostics.shutil, "which") as which,
            patch.object(runtime_diagnostics.subprocess, "run") as run,
        ):
            result = runtime_diagnostics.runtime_configuration_diagnostics(include_ocr=False)
        find.assert_not_called()
        which.assert_not_called()
        run.assert_not_called()
        for key in ("ocr_engine_available", "vietnamese_language_available",
                    "tesseract_command_configured", "tesseract_executable_available"):
            self.assertIsNone(result[key])

    def test_missing_vietnamese_pack_cannot_be_reported_healthy(self):
        with (
            patch.object(runtime_diagnostics.shutil, "which", return_value="/usr/bin/tesseract"),
            patch.object(runtime_diagnostics.subprocess, "run", return_value=_tesseract_result("eng")),
            patch.object(runtime_diagnostics.importlib.util, "find_spec", return_value=MagicMock()),
        ):
            result = runtime_diagnostics.runtime_configuration_diagnostics()
            details = runtime_diagnostics.collect_ocr_health()
        self.assertFalse(result["vietnamese_language_available"])
        self.assertTrue(result["tesseract_executable_available"])
        self.assertEqual(details[-1]["status"], "UNAVAILABLE")
        self.assertEqual(details[-1]["detail_status"], "failed")

    def test_missing_binary_is_not_inferred_from_paddle_or_vietocr(self):
        with (
            patch.object(runtime_diagnostics.shutil, "which", return_value=None),
            patch.object(runtime_diagnostics.importlib.util, "find_spec", return_value=MagicMock()),
            patch.object(runtime_diagnostics.subprocess, "run") as run,
        ):
            details = runtime_diagnostics.collect_ocr_health()
            values = runtime_diagnostics.runtime_configuration_diagnostics()
        run.assert_not_called()
        self.assertEqual(details[-2]["status"], "UNAVAILABLE")
        self.assertIs(values["vietnamese_language_available"], False)

    def test_lazy_ocr_is_installed_but_not_loaded_without_importing_weights(self):
        with (
            patch.dict(sys.modules, {"app.services.ocr_engine": None}),
            patch.object(runtime_diagnostics.importlib.util, "find_spec", return_value=MagicMock()),
            patch.object(runtime_diagnostics.shutil, "which", return_value=None),
        ):
            details = runtime_diagnostics.collect_ocr_health()
        self.assertEqual(details[0]["detail_status"], "installed")
        self.assertEqual(details[1]["detail_status"], "installed")
        self.assertEqual(details[0]["status"], "DEGRADED")

    def test_loaded_and_failed_ocr_engines_have_independent_states(self):
        fake_runtime = SimpleNamespace(
            _paddle_engine=object(), _paddle_initialization_status="success",
            _vietocr_engine=None, _vietocr_initialization_status="error",
        )
        with (
            patch.dict(sys.modules, {"app.services.ocr_engine": fake_runtime}),
            patch.object(runtime_diagnostics.importlib.util, "find_spec", return_value=MagicMock()),
            patch.object(runtime_diagnostics.shutil, "which", return_value=None),
        ):
            details = runtime_diagnostics.collect_ocr_health()
        self.assertEqual((details[0]["detail_status"], details[0]["status"]), ("loaded", "HEALTHY"))
        self.assertEqual((details[1]["detail_status"], details[1]["status"]), ("failed", "UNAVAILABLE"))

    def test_timeout_produces_unknown_language_not_false_success(self):
        with (
            patch.object(runtime_diagnostics.shutil, "which", return_value="/usr/bin/tesseract"),
            patch.object(runtime_diagnostics.subprocess, "run",
                         side_effect=subprocess.TimeoutExpired("tesseract", 2.0)),
        ):
            binary, language, available, vie = runtime_diagnostics._tesseract_health()
        self.assertTrue(available)
        self.assertFalse(vie)
        self.assertEqual(language["detail_status"], "unknown")
        self.assertEqual(binary["status"], "UNAVAILABLE")

    def test_worker_states_report_disabled_running_and_failed_without_leakage(self):
        running = SimpleNamespace(done=lambda: False)
        failed = SimpleNamespace(done=lambda: True, cancelled=lambda: False,
                                 exception=lambda: RuntimeError("secret-db-credential"))
        states = runtime_diagnostics.collect_worker_health({
            "book_quality": running, "admin_ai_workflow": failed,
        })
        by_id = {x["id"]: x for x in states}
        self.assertEqual(by_id["book_quality"]["status"], "HEALTHY")
        self.assertEqual(by_id["admin_ai_workflow"]["status"], "UNAVAILABLE")
        self.assertEqual(by_id["local_trainer_process"]["detail_status"], "disabled")
        self.assertNotIn("secret-db-credential", repr(states))


class StorageHealthTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        runtime_diagnostics.clear_storage_health_cache()

    def tearDown(self):
        runtime_diagnostics.clear_storage_health_cache()

    async def test_missing_storage_config_fails_without_network(self):
        with (
            patch.object(runtime_diagnostics, "SUPABASE_STORAGE_BUCKET", ""),
            patch.object(runtime_diagnostics.httpx, "AsyncClient") as client,
        ):
            result = await runtime_diagnostics.probe_storage_health()
        client.assert_not_called()
        self.assertEqual(result["status"], "UNAVAILABLE")
        self.assertEqual(result["service_group"], "core")
        self.assertEqual(result["criticality"], "core")
        self.assertEqual(result["execution_mode"], "always_on")
        self.assertNotIn("private", repr(result))

    async def test_storage_head_success_and_access_denied_without_exposing_key(self):
        client = AsyncMock()
        client.__aenter__.return_value = client
        with (
            patch.object(runtime_diagnostics, "SUPABASE_URL", "https://example.supabase.co"),
            patch.object(runtime_diagnostics, "SUPABASE_STORAGE_BUCKET", "secret-bucket"),
            patch.object(runtime_diagnostics, "SUPABASE_ADMIN_KEY", "secret-admin-key"),
            patch.object(runtime_diagnostics.httpx, "AsyncClient", return_value=client),
        ):
            client.head.return_value = MagicMock(status_code=200)
            ready = await runtime_diagnostics.probe_storage_health()
            # Second call within 15s TTL is served from RAM cache (no extra network call).
            cached_ready = await runtime_diagnostics.probe_storage_health()
            self.assertEqual(cached_ready["status"], "HEALTHY")
            self.assertEqual(client.head.await_count, 1)

            runtime_diagnostics.clear_storage_health_cache()
            client.head.return_value = MagicMock(status_code=403)
            denied = await runtime_diagnostics.probe_storage_health()
        self.assertEqual(ready["status"], "HEALTHY")
        self.assertEqual(denied["status"], "UNAVAILABLE")
        self.assertNotIn("secret-bucket", repr(ready) + repr(denied))
        self.assertNotIn("secret-admin-key", repr(ready) + repr(denied))
        self.assertEqual(client.head.await_count, 2)

    async def test_storage_timeout_never_claims_success(self):
        client = AsyncMock()
        client.__aenter__.return_value = client
        client.head.side_effect = runtime_diagnostics.httpx.ReadTimeout("secret HTTP failure")
        with (
            patch.object(runtime_diagnostics, "SUPABASE_URL", "https://example.supabase.co"),
            patch.object(runtime_diagnostics, "SUPABASE_STORAGE_BUCKET", "bucket"),
            patch.object(runtime_diagnostics, "SUPABASE_ADMIN_KEY", "private-key"),
            patch.object(runtime_diagnostics.httpx, "AsyncClient", return_value=client),
        ):
            result = await runtime_diagnostics.probe_storage_health()
        self.assertEqual(result["detail_status"], "unknown")
        self.assertNotIn("private-key", repr(result))
        self.assertNotIn("secret HTTP failure", repr(result))


if __name__ == "__main__":
    unittest.main()
