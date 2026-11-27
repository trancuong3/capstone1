"""Comprehensive unit & route tests for Phase 2 Admin Health Overhaul & Book Cover Hydration."""
from __future__ import annotations

import asyncio
import os
import time
import unittest
from datetime import datetime, timedelta, timezone
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock, patch
from uuid import UUID, uuid4

os.environ.setdefault("APP_ENVIRONMENT", "test")
os.environ.setdefault("DATABASE_URL", "postgresql+asyncpg://test:test@127.0.0.1:1/test")
os.environ.setdefault("SUPABASE_URL", "https://example.supabase.co")
os.environ.setdefault("SUPABASE_KEY", "isolated-test-key")

from fastapi import FastAPI
from fastapi.testclient import TestClient
from pydantic import ValidationError
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import get_current_parent_id, get_db
from app.api.routes.system import (
    AdminSystemRepository,
    AdminSystemService,
    _remote_ocr_health_timeout_seconds,
    router as system_router,
)
from app.providers.local_voice_provider import LocalVoiceProvider
from app.repositories.book_repository import AdminCatalogRepository
from app.schemas.system import (
    AdminHealthItemRead,
    AdminHealthRead,
    AdminOcrWorkerWakeupResponse,
)
from app.services import remote_ocr_wakeup, runtime_diagnostics, worker_telemetry
from app.services.book_service import AdminCatalogService
from app.services.rate_limiter import clear_rate_limits, rate_limiter

ADMIN_ACTOR = UUID("11111111-1111-4111-8111-111111111111")
PARENT_ACTOR = UUID("22222222-2222-4222-8222-222222222222")


def _healthy_storage() -> dict[str, str]:
    return {
        "id": "storage",
        "label": "Supabase Storage",
        "status": "HEALTHY",
        "detail_status": "healthy",
        "safe_message": "Storage OK",
        "service_group": "core",
        "execution_mode": "always_on",
        "criticality": "core",
    }


def _default_audio_cache(entry_count: int = 1904, quota_exhausted: bool = False) -> dict[str, object]:
    return {
        "entry_count": entry_count,
        "storage_used_bytes": 88 * 1024 * 1024,
        "storage_quota_bytes": 150 * 1024 * 1024,
        "daily_egress_bytes": 23 * 1024 * 1024,
        "daily_egress_limit_bytes": 300 * 1024 * 1024,
        "cache_hit_ratio": 0.72,
        "quota_exhausted": quota_exhausted,
    }


class CanonicalSchemaAndOperationalStateTests(unittest.TestCase):
    def test_canonical_10_operational_states_and_14_detail_statuses_enforced(self) -> None:
        now = datetime.now(timezone.utc)
        for op_state in (
            "Healthy",
            "Degraded",
            "Offline",
            "Queued",
            "Quota exhausted",
            "Unsupported",
            "Unknown",
            "Standby",
            "Scheduled",
            "Local only",
        ):
            item = AdminHealthItemRead(
                id="svc",
                label="Service",
                status="HEALTHY",
                operational_state=op_state,  # type: ignore[arg-type]
                checked_at=now,
                safe_message="ok",
            )
            self.assertEqual(item.operational_state, op_state)

        for detail in (
            "installed",
            "initialized",
            "loaded",
            "healthy",
            "failed",
            "unknown",
            "disabled",
            "standby",
            "cached",
            "client_side",
            "cloud_ready",
            "scheduled",
            "remote_delegated",
            "local_only",
        ):
            item = AdminHealthItemRead(
                id="svc",
                label="Service",
                status="HEALTHY",
                detail_status=detail,  # type: ignore[arg-type]
                checked_at=now,
                safe_message="ok",
            )
            self.assertEqual(item.detail_status, detail)

        with self.assertRaises(ValidationError):
            AdminHealthItemRead(
                id="svc",
                label="Service",
                status="HEALTHY",
                detail_status="not_real",  # type: ignore[arg-type]
                checked_at=now,
                safe_message="ok",
            )

        with self.assertRaises(ValidationError):
            AdminHealthItemRead(
                id="svc",
                label="Service",
                status="HEALTHY",
                operational_state="BogusState",  # type: ignore[arg-type]
                checked_at=now,
                safe_message="ok",
            )

        health = AdminHealthRead(
            overall_status="UNAVAILABLE",
            checked_at=now,
            services=[],
            audio_cache=None,
            audio_cache_error="AUDIO_CACHE_PROBE_TIMEOUT",
        )
        self.assertEqual(health.overall_status, "UNAVAILABLE")
        self.assertEqual(health.audio_cache_error, "AUDIO_CACHE_PROBE_TIMEOUT")

    def test_derive_operational_state_mappings(self) -> None:
        self.assertEqual(
            runtime_diagnostics.derive_operational_state(status="HEALTHY", detail_status="standby"),
            "Standby",
        )
        self.assertEqual(
            runtime_diagnostics.derive_operational_state(status="DEGRADED", detail_status="standby"),
            "Standby",
        )
        self.assertEqual(
            runtime_diagnostics.derive_operational_state(status="HEALTHY", detail_status="remote_delegated"),
            "Standby",
        )
        self.assertEqual(
            runtime_diagnostics.derive_operational_state(status="HEALTHY", detail_status="scheduled"),
            "Scheduled",
        )
        self.assertEqual(
            runtime_diagnostics.derive_operational_state(status="HEALTHY", detail_status="local_only"),
            "Local only",
        )
        for detail in ("cached", "client_side", "cloud_ready"):
            self.assertEqual(
                runtime_diagnostics.derive_operational_state(status="HEALTHY", detail_status=detail),
                "Healthy",
            )
            self.assertEqual(
                runtime_diagnostics.derive_operational_state(status="DEGRADED", detail_status=detail),
                "Degraded",
            )


class CorePerformanceAndConcurrencyTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self) -> None:
        runtime_diagnostics.clear_storage_health_cache()
        worker_telemetry.clear_worker_telemetry()

    def tearDown(self) -> None:
        runtime_diagnostics.clear_storage_health_cache()
        worker_telemetry.clear_worker_telemetry()

    async def test_worker_queue_metrics_collapses_into_single_union_all_query(self) -> None:
        now = datetime.now(timezone.utc)
        executed_sqls: list[str] = []

        class _FakeMappingsResult:
            def all(self):
                return [
                    {
                        "worker_key": "book_quality",
                        "queue_depth": 2,
                        "oldest_pending": now - timedelta(seconds=45),
                        "last_success": now - timedelta(minutes=3),
                    },
                    {
                        "worker_key": "reading_reminder",
                        "queue_depth": 0,
                        "oldest_pending": None,
                        "last_success": now - timedelta(minutes=10),
                    },
                ]

        class _FakeResult:
            def mappings(self):
                return _FakeMappingsResult()

        fake_db = MagicMock()
        fake_db.begin_nested = MagicMock(
            side_effect=AssertionError("begin_nested savepoint loop must NOT run when UNION ALL succeeds")
        )

        async def _fake_execute(stmt):
            executed_sqls.append(str(stmt))
            return _FakeResult()

        fake_db.execute = AsyncMock(side_effect=_fake_execute)

        metrics = await runtime_diagnostics.collect_worker_queue_metrics(
            fake_db, now=now, include_ocr_worker=False
        )
        self.assertEqual(len(executed_sqls), 1)
        self.assertIn("UNION ALL", executed_sqls[0])
        self.assertNotIn("ocr_inference_jobs", executed_sqls[0])
        self.assertEqual(metrics["book_quality"]["queue_depth"], 2)
        self.assertAlmostEqual(metrics["book_quality"]["oldest_pending_job_age_seconds"], 45.0, delta=1.0)
        self.assertEqual(metrics["reading_reminder"]["queue_depth"], 0)
        fake_db.begin_nested.assert_not_called()

    async def test_worker_queue_metrics_falls_back_gracefully_on_partial_sqlite_db(self) -> None:
        now = datetime.now(timezone.utc)

        class _SingleRowMappings:
            def __init__(self, row):
                self._row = row

            def first(self):
                return self._row

        class _FakeResult:
            def __init__(self, row):
                self._row = row

            def mappings(self):
                return _SingleRowMappings(self._row)

        async def _fake_execute(stmt):
            sql = str(stmt)
            if "UNION ALL" in sql:
                raise RuntimeError("no such table: public.karaoke_processing_jobs")
            if "bookqualityscanruns" in sql:
                return _FakeResult({"queue_depth": 3, "oldest_pending": None, "last_success": now})
            raise RuntimeError("no such table")

        fake_db = MagicMock()
        fake_db.execute = AsyncMock(side_effect=_fake_execute)

        metrics = await runtime_diagnostics.collect_worker_queue_metrics(
            fake_db, now=now, include_ocr_worker=False
        )
        self.assertEqual(metrics["book_quality"]["queue_depth"], 3)
        self.assertNotIn("karaoke_processing", metrics)

    async def test_async_session_db_probe_and_isolated_audio_cache_avoid_shared_session_race(self) -> None:
        # Simulate real AsyncSession repo_db so both probe_database and _probe_audio_cache_isolated
        # use independent AUTOCOMMIT sessions rather than sharing request self.db concurrently.
        request_db = MagicMock(spec=AsyncSession)
        request_db.scalar = AsyncMock(side_effect=AssertionError("Must not race on request_db.scalar"))
        request_db.execute = AsyncMock(side_effect=AssertionError("Must not race on request_db.execute"))

        cache_session = MagicMock(spec=AsyncSession)
        cache_session.in_transaction.return_value = False
        cache_session.bind = SimpleNamespace(dialect=SimpleNamespace(name="postgresql"))
        cache_session.connection = AsyncMock()
        cache_cm = MagicMock()
        cache_cm.__aenter__ = AsyncMock(return_value=cache_session)
        cache_cm.__aexit__ = AsyncMock(return_value=False)

        repo = AdminSystemRepository(request_db)
        voice = MagicMock()
        voice.probe_tts = AsyncMock(return_value=("HEALTHY", "ok"))
        voice.probe_stt = AsyncMock(return_value=("HEALTHY", "ok"))

        with (
            patch(
                "app.api.routes.system.probe_database_connection",
                new=AsyncMock(return_value={"ok": True}),
            ) as db_probe_mock,
            patch("app.api.routes.system.AsyncSessionLocal", return_value=cache_cm) as session_maker,
            patch(
                "app.api.routes.system.TtsAudioCacheRepository.get_summary",
                new=AsyncMock(
                    return_value={
                        "entry_count": 42,
                        "storage_used_bytes": 1024,
                        "daily_egress_bytes": 512,
                        "hit_count": 9,
                        "miss_count": 1,
                    }
                ),
            ),
            patch("app.api.routes.system.probe_storage_health", new=AsyncMock(return_value=_healthy_storage())),
            patch("app.api.routes.system.LocalOcrCorrector.probe", new=AsyncMock(return_value=("HEALTHY", "ok"))),
            patch("app.api.routes.system.collect_ocr_health", return_value=[]),
        ):
            report = await AdminSystemService(repo, voice).health()

        db_probe_mock.assert_awaited_once_with(timeout=6.0)
        session_maker.assert_called_once()
        cache_session.connection.assert_awaited_once_with(
            execution_options={"isolation_level": "AUTOCOMMIT"}
        )
        self.assertIsNone(report.audio_cache_error)
        self.assertIsNotNone(report.audio_cache)
        assert report.audio_cache is not None
        self.assertEqual(report.audio_cache.entry_count, 42)
        self.assertEqual(report.audio_cache.cache_hit_ratio, 0.9)

    async def test_audio_cache_probe_failure_sets_audio_cache_error_instead_of_faking_zeros(self) -> None:
        repo = MagicMock()
        repo.db = None
        repo.probe_database = AsyncMock(return_value=True)
        voice = MagicMock()
        voice.probe_tts = AsyncMock(return_value=("HEALTHY", "ok"))
        voice.probe_stt = AsyncMock(return_value=("HEALTHY", "ok"))

        with (
            patch(
                "app.api.routes.system.TtsAudioCacheService.get_summary",
                new=AsyncMock(side_effect=asyncio.TimeoutError()),
            ),
            patch("app.api.routes.system.probe_storage_health", new=AsyncMock(return_value=_healthy_storage())),
            patch("app.api.routes.system.LocalOcrCorrector.probe", new=AsyncMock(return_value=("HEALTHY", "ok"))),
            patch("app.api.routes.system.collect_ocr_health", return_value=[]),
        ):
            report = await AdminSystemService(repo, voice).health()

        self.assertIsNone(report.audio_cache)
        self.assertEqual(report.audio_cache_error, "AUDIO_CACHE_PROBE_TIMEOUT")
        by_id = {item.id: item for item in report.services}
        self.assertEqual(by_id["tts_audio_cache"].status, "DEGRADED")
        self.assertEqual(by_id["tts_audio_cache"].detail_status, "unknown")
        self.assertEqual(by_id["tts_audio_cache"].operational_state, "Unknown")
        self.assertEqual(by_id["tts_audio_cache"].last_error, "AUDIO_CACHE_PROBE_TIMEOUT")
        self.assertEqual(report.overall_status, "DEGRADED")

    def test_remote_ocr_health_timeout_env_default_and_clamp(self) -> None:
        with patch.dict(os.environ, {"VIREAD_HEALTH_OCR_TIMEOUT_SECONDS": ""}, clear=False):
            self.assertEqual(_remote_ocr_health_timeout_seconds(), 8.0)
        with patch.dict(os.environ, {"VIREAD_HEALTH_OCR_TIMEOUT_SECONDS": "11.5"}, clear=False):
            self.assertEqual(_remote_ocr_health_timeout_seconds(), 11.5)
        with patch.dict(os.environ, {"VIREAD_HEALTH_OCR_TIMEOUT_SECONDS": "99"}, clear=False):
            self.assertEqual(_remote_ocr_health_timeout_seconds(), 15.0)
        with patch.dict(os.environ, {"VIREAD_HEALTH_OCR_TIMEOUT_SECONDS": "0.5"}, clear=False):
            self.assertEqual(_remote_ocr_health_timeout_seconds(), 2.5)


class VoiceCooldownAndHostedClassificationTests(unittest.IsolatedAsyncioTestCase):
    async def test_local_voice_provider_get_health_respects_remote_cooldown_without_network(self) -> None:
        provider = LocalVoiceProvider(
            base_url="https://dead-tunnel.trycloudflare.com",
            worker_token="tok",
        )
        calls = 0

        class _TimeoutClient:
            async def get(self, *_a, **_kw):
                nonlocal calls
                calls += 1
                raise asyncio.TimeoutError()

        client = _TimeoutClient()
        with patch.object(provider, "_get_client", return_value=client):
            first = await provider.get_health()
            second = await provider.get_health()

        self.assertEqual(calls, 1)
        self.assertEqual(first["error_code"], "LOCAL_VOICE_TIMEOUT")
        self.assertIn(
            second["error_code"],
            {"LOCAL_VOICE_TIMEOUT", "LOCAL_VOICE_UNAVAILABLE"},
        )
        self.assertEqual(second["latency_ms"], 0)
        self.assertGreater(provider._remote_unavailable_until, time.monotonic())

    async def test_hosted_render_healthy_scenario_all_22_subsystems_green(self) -> None:
        now = datetime.now(timezone.utc)
        fresh_iso = (now - timedelta(minutes=8)).isoformat()
        persisted_hb = {
            key: {
                "execution_mode": "cron_scheduled",
                "last_run_at": fresh_iso,
                "last_success_at": fresh_iso,
                "last_error_at": None,
                "last_error_code": None,
                "last_items_processed": 0,
                "last_source": "cron",
                "updated_at": fresh_iso,
            }
            for key in (
                "viread_ocr_outbox",
                "viread_ocr_training",
                "book_quality",
                "admin_ai_workflow",
                "parent_book_submission",
                "reading_reminder",
                "reading_presence",
            )
        }

        repo = MagicMock()
        repo.db = None
        repo.probe_database = AsyncMock(return_value=True)
        repo.worker_queue_metrics = AsyncMock(return_value={})
        repo.persisted_worker_heartbeats = AsyncMock(return_value=persisted_hb)

        voice = MagicMock()
        voice.get_status = AsyncMock(
            return_value={
                "local": {
                    "configured": False,
                    "available": False,
                    "stt_ready": False,
                    "tts_ready": False,
                    "error_code": "LOCAL_VOICE_UNCONFIGURED",
                },
                "google": {"stt_configured": False, "tts_configured": False},
            }
        )

        remote_payload = {
            "mode": "remote_worker",
            "ready": True,
            "wakeup_configured": True,
            "heartbeat_ttl_seconds": 45,
            "engines": {
                "paddleocr": {
                    "status": "HEALTHY",
                    "detail_status": "loaded",
                    "installed": True,
                    "loaded": True,
                    "inference_verified": False,
                },
                "vietocr": {
                    "status": "HEALTHY",
                    "detail_status": "loaded",
                    "installed": True,
                    "loaded": True,
                    "inference_verified": False,
                },
                "tesseract_vie": {
                    "status": "HEALTHY",
                    "detail_status": "loaded",
                    "installed": True,
                    "loaded": True,
                    "inference_verified": False,
                },
            },
            "workers": [
                {
                    "worker_id": "hf-space-cpu-1",
                    "hostname": "hf-space",
                    "status": "IDLE",
                    "standby_mode": "quiet_standby",
                    "online": True,
                    "ready": True,
                    "last_heartbeat_at": fresh_iso,
                    "model_profile": "FLOW1_EXTERNAL_TRDG",
                    "engines": {},
                }
            ],
            "queue": {"pending_total": 0, "active_total": 0},
        }

        env = {
            "RENDER": "true",
            "APP_ENVIRONMENT": "production",
            "VIREAD_OCR_MODE": "remote_worker",
            "VIREAD_WEB_DISABLE_HEAVY_WORKERS": "true",
            "VIREAD_ENABLE_LIGHTWEIGHT_WORKERS": "false",
            "VIREAD_LOCAL_TRAINING_ENABLED": "false",
            "KARAOKE_PROCESSING_ENABLED": "false",
            "KARAOKE_PROCESSING_WORKER_ENABLED": "false",
            "OCR_CLOUD_CORRECTION_ENABLED": "true",
            "GEMINI_API_KEY": "fake-gemini-key-for-test",
            "LOCAL_OCR_ENABLED": "",
            "LOCAL_OCR_BASE_URL": "",
        }

        with (
            patch.dict(os.environ, env, clear=False),
            patch("app.api.routes.system.LocalOcrCorrector.probe", new=AsyncMock()) as local_probe,
            patch("app.api.routes.system.collect_remote_ocr_health", new=AsyncMock(return_value=remote_payload)),
            patch("app.api.routes.system.probe_storage_health", new=AsyncMock(return_value=_healthy_storage())),
            patch("app.api.routes.system.is_tts_cache_enabled", return_value=True),
            patch(
                "app.api.routes.system.TtsAudioCacheService.get_summary",
                new=AsyncMock(return_value=_default_audio_cache(1904)),
            ),
        ):
            report = await AdminSystemService(repo, voice).health(workers={})

        # Ollama probe MUST be skipped on hosted Render!
        local_probe.assert_not_awaited()
        self.assertEqual(report.overall_status, "HEALTHY")
        by_id = {item.id: item for item in report.services}

        # Core group
        for core_id in ("api", "database", "storage"):
            self.assertEqual(by_id[core_id].service_group, "core")
            self.assertEqual(by_id[core_id].criticality, "core")
            self.assertEqual(by_id[core_id].execution_mode, "always_on")
            self.assertEqual(by_id[core_id].detail_status, "healthy")

        # Voice group
        self.assertEqual(by_id["tts"].status, "HEALTHY")
        self.assertEqual(by_id["tts"].detail_status, "cached")
        self.assertEqual(by_id["tts"].operational_state, "Healthy")
        self.assertEqual(by_id["tts"].execution_mode, "precomputed_cache")
        self.assertEqual(by_id["tts"].service_group, "voice")

        self.assertEqual(by_id["stt"].status, "HEALTHY")
        self.assertEqual(by_id["stt"].detail_status, "client_side")
        self.assertEqual(by_id["stt"].operational_state, "Healthy")
        self.assertEqual(by_id["stt"].execution_mode, "browser_wasm")
        self.assertEqual(by_id["stt"].service_group, "voice")

        # Local OCR cloud_ready
        self.assertEqual(by_id["local_ocr"].status, "HEALTHY")
        self.assertEqual(by_id["local_ocr"].detail_status, "cloud_ready")
        self.assertEqual(by_id["local_ocr"].operational_state, "Healthy")
        self.assertEqual(by_id["local_ocr"].execution_mode, "cloud_ai")

        # Remote OCR prebaked loaded=True & quiet_standby
        self.assertEqual(by_id["paddleocr"].status, "HEALTHY")
        self.assertEqual(by_id["paddleocr"].detail_status, "loaded")
        self.assertEqual(by_id["vietocr"].status, "HEALTHY")
        self.assertEqual(by_id["vietocr"].detail_status, "loaded")
        self.assertEqual(by_id["tesseract"].status, "HEALTHY")
        self.assertEqual(by_id["tesseract_vie"].status, "HEALTHY")
        self.assertEqual(by_id["ocr_worker"].status, "HEALTHY")
        self.assertEqual(by_id["ocr_worker"].detail_status, "standby")
        self.assertEqual(by_id["ocr_worker"].operational_state, "Standby")
        self.assertTrue(by_id["ocr_worker"].can_wake)
        self.assertIsNone(by_id["ocr_worker"].last_error)

        # Optional / delegated / local-only workers
        self.assertEqual(by_id["active_model_registry"].detail_status, "remote_delegated")
        self.assertEqual(by_id["active_model_registry"].operational_state, "Standby")
        self.assertEqual(by_id["active_model_registry"].execution_mode, "remote_delegated")

        self.assertEqual(by_id["local_trainer_process"].detail_status, "local_only")
        self.assertEqual(by_id["local_trainer_process"].operational_state, "Local only")
        self.assertEqual(by_id["local_trainer_process"].execution_mode, "local_only")

        self.assertEqual(by_id["karaoke_processing"].detail_status, "local_only")
        self.assertEqual(by_id["karaoke_processing"].operational_state, "Local only")
        self.assertEqual(by_id["karaoke_processing"].execution_mode, "disabled_opt_in")

        # 7 cron workers (all HEALTHY / scheduled / Scheduled even with 0 processed items!)
        for wkey in (
            "viread_ocr_outbox",
            "viread_ocr_training",
            "book_quality",
            "admin_ai_workflow",
            "parent_book_submission",
            "reading_reminder",
            "reading_presence",
        ):
            self.assertEqual(by_id[wkey].status, "HEALTHY", wkey)
            self.assertEqual(by_id[wkey].detail_status, "scheduled", wkey)
            self.assertEqual(by_id[wkey].operational_state, "Scheduled", wkey)
            self.assertEqual(by_id[wkey].service_group, "workers", wkey)

    async def test_hosted_broken_voice_tunnel_and_local_only_ocr_do_not_break_overall_health(self) -> None:
        repo = MagicMock()
        repo.db = None
        repo.probe_database = AsyncMock(return_value=True)

        voice = MagicMock()
        voice.get_status = AsyncMock(
            return_value={
                "local": {
                    "configured": True,
                    "available": False,
                    "stt_ready": False,
                    "tts_ready": False,
                    "error_code": "LOCAL_VOICE_TIMEOUT",
                },
                "google": {"stt_configured": False, "tts_configured": False},
            }
        )
        remote_ready = {
            "mode": "remote_worker",
            "ready": True,
            "wakeup_configured": True,
            "engines": {
                "paddleocr": {"status": "HEALTHY", "detail_status": "loaded", "installed": True, "loaded": True},
                "vietocr": {"status": "HEALTHY", "detail_status": "loaded", "installed": True, "loaded": True},
                "tesseract_vie": {"status": "HEALTHY", "detail_status": "loaded", "installed": True, "loaded": True},
            },
            "workers": [{"worker_id": "aca-1", "online": True, "ready": True, "standby_mode": "scale_to_zero"}],
            "queue": {"pending_total": 0, "active_total": 0},
        }
        env = {
            "RENDER": "true",
            "APP_ENVIRONMENT": "production",
            "VIREAD_OCR_MODE": "remote_worker",
            "OCR_CLOUD_CORRECTION_ENABLED": "false",
            "GEMINI_API_KEY": "",
            "GROQ_API_KEY": "",
            "LOCAL_OCR_ENABLED": "",
            "LOCAL_OCR_BASE_URL": "",
        }
        with (
            patch.dict(os.environ, env, clear=False),
            patch("app.api.routes.system.LocalOcrCorrector.probe", new=AsyncMock()) as local_probe,
            patch("app.api.routes.system.collect_remote_ocr_health", new=AsyncMock(return_value=remote_ready)),
            patch("app.api.routes.system.probe_storage_health", new=AsyncMock(return_value=_healthy_storage())),
            patch("app.api.routes.system.is_tts_cache_enabled", return_value=True),
            patch(
                "app.api.routes.system.TtsAudioCacheService.get_summary",
                new=AsyncMock(return_value=_default_audio_cache(500)),
            ),
        ):
            report = await AdminSystemService(repo, voice).health()

        local_probe.assert_not_awaited()
        by_id = {item.id: item for item in report.services}

        # TTS & STT degraded optional with explicit VIREAD_LOCAL_VOICE_WORKER_URL removal hint
        self.assertEqual(by_id["tts"].status, "DEGRADED")
        self.assertEqual(by_id["tts"].detail_status, "cached")
        self.assertEqual(by_id["tts"].operational_state, "Degraded")
        self.assertEqual(by_id["tts"].criticality, "optional")
        self.assertIn("VIREAD_LOCAL_VOICE_WORKER_URL", by_id["tts"].action_hint or "")

        self.assertEqual(by_id["stt"].status, "DEGRADED")
        self.assertEqual(by_id["stt"].detail_status, "client_side")
        self.assertEqual(by_id["stt"].operational_state, "Degraded")
        self.assertEqual(by_id["stt"].criticality, "optional")
        self.assertIn("VIREAD_LOCAL_VOICE_WORKER_URL", by_id["stt"].action_hint or "")
        self.assertIn("WASM", by_id["stt"].action_hint or "")

        # local_ocr without cloud keys -> HEALTHY / local_only / Local only + action_hint
        self.assertEqual(by_id["local_ocr"].status, "HEALTHY")
        self.assertEqual(by_id["local_ocr"].detail_status, "local_only")
        self.assertEqual(by_id["local_ocr"].operational_state, "Local only")
        self.assertEqual(by_id["local_ocr"].criticality, "optional")
        self.assertIn("OCR_CLOUD_CORRECTION_ENABLED", by_id["local_ocr"].action_hint or "")
        self.assertIn("GEMINI_API_KEY", by_id["local_ocr"].action_hint or "")

        # Overall stays HEALTHY because optional broken tunnel doesn't take down core/important services!
        self.assertEqual(report.overall_status, "HEALTHY")

    async def test_voice_singleton_reuse_and_google_tts_cloud_ready(self) -> None:
        fake_orch = MagicMock()
        fake_orch.get_status = AsyncMock(
            return_value={
                "local": {
                    "configured": False,
                    "available": False,
                    "stt_ready": False,
                    "tts_ready": False,
                    "error_code": "LOCAL_VOICE_UNCONFIGURED",
                },
                "google": {
                    "stt_configured": False,
                    "tts_configured": True,
                    "stt_cooldown": False,
                    "tts_cooldown": False,
                },
            }
        )
        repo = MagicMock()
        repo.db = None
        repo.probe_database = AsyncMock(return_value=True)

        with (
            patch.dict(
                os.environ,
                {"RENDER": "true", "APP_ENVIRONMENT": "production", "VIREAD_OCR_MODE": "local_inprocess"},
                clear=False,
            ),
            patch("app.api.routes.voice.get_voice_orchestrator", return_value=fake_orch) as get_orch,
            patch("app.api.routes.system.probe_storage_health", new=AsyncMock(return_value=_healthy_storage())),
            patch("app.api.routes.system.collect_ocr_health", return_value=[]),
            patch(
                "app.api.routes.system.TtsAudioCacheService.get_summary",
                new=AsyncMock(return_value=_default_audio_cache(0)),
            ),
        ):
            report = await AdminSystemService(repo, voice_provider=None).health()

        get_orch.assert_called_once()
        fake_orch.get_status.assert_awaited_once()
        by_id = {item.id: item for item in report.services}
        self.assertEqual(by_id["tts"].status, "HEALTHY")
        self.assertEqual(by_id["tts"].detail_status, "cloud_ready")
        self.assertEqual(by_id["tts"].operational_state, "Healthy")
        self.assertEqual(by_id["tts"].execution_mode, "cloud_ai")

    async def test_persisted_worker_heartbeats_roundtrip_via_runtime_diagnostics(self) -> None:
        from sqlalchemy import create_engine, text
        from sqlalchemy.orm import sessionmaker

        sync_engine = create_engine("sqlite:///:memory:")
        try:
            with sync_engine.begin() as conn:
                conn.execute(
                    text(
                        """
                        CREATE TABLE system_worker_heartbeats (
                            worker_key TEXT PRIMARY KEY,
                            execution_mode TEXT NOT NULL,
                            last_run_at TEXT,
                            last_success_at TEXT,
                            last_error_at TEXT,
                            last_error_code TEXT,
                            last_items_processed INTEGER NOT NULL DEFAULT 0,
                            last_source TEXT,
                            updated_at TEXT NOT NULL
                        )
                        """
                    )
                )
            sync_factory = sessionmaker(bind=sync_engine)

            class _AsyncSqliteBridge:
                def __init__(self, sync_sess):
                    self.sync_session = sync_sess

                async def execute(self, stmt, params=None):
                    return (
                        self.sync_session.execute(stmt, params)
                        if params is not None
                        else self.sync_session.execute(stmt)
                    )

                async def commit(self):
                    self.sync_session.commit()

                async def rollback(self):
                    self.sync_session.rollback()

            with sync_factory() as s_write:
                await worker_telemetry.persist_worker_heartbeat(
                    _AsyncSqliteBridge(s_write),  # type: ignore[arg-type]
                    "reading_reminder",
                    execution_mode="cron_scheduled",
                    ok=True,
                    items_processed=0,
                    source="cron",
                )
            with sync_factory() as s_read:
                hb = await runtime_diagnostics.collect_persisted_worker_heartbeats(
                    _AsyncSqliteBridge(s_read)
                )
            self.assertIn("reading_reminder", hb)
            self.assertEqual(hb["reading_reminder"]["execution_mode"], "cron_scheduled")
            self.assertIsNotNone(hb["reading_reminder"]["last_success_at"])
            self.assertIsNone(hb["reading_reminder"]["last_error_code"])
            self.assertEqual(hb["reading_reminder"]["last_items_processed"], 0)
        finally:
            sync_engine.dispose()


class RemoteOcrStandbyWakeupAndCriticalityTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self) -> None:
        clear_rate_limits()
        remote_ocr_wakeup.clear_remote_ocr_wakeup_cache_for_tests()

    def tearDown(self) -> None:
        clear_rate_limits()
        remote_ocr_wakeup.clear_remote_ocr_wakeup_cache_for_tests()

    async def test_sleeping_remote_ocr_preserves_standby_engines_at_zero_queue_and_escalates_on_backlog(self) -> None:
        last_known_engines = {
            "paddleocr": {"status": "HEALTHY", "detail_status": "loaded", "installed": True, "loaded": True},
            "vietocr": {"status": "HEALTHY", "detail_status": "loaded", "installed": True, "loaded": True},
            "tesseract_vie": {"status": "HEALTHY", "detail_status": "loaded", "installed": True, "loaded": True},
        }
        repo = MagicMock()
        repo.db = None
        repo.probe_database = AsyncMock(return_value=True)
        repo.worker_queue_metrics = AsyncMock(return_value={})
        voice = MagicMock()
        voice.probe_tts = AsyncMock(return_value=("HEALTHY", "ok"))
        voice.probe_stt = AsyncMock(return_value=("HEALTHY", "ok"))

        # 1. Queue depth == 0 -> DEGRADED / standby / Standby, preserving last known engines as standby!
        sleeping_empty = {
            "mode": "remote_worker",
            "ready": False,
            "wakeup_configured": True,
            "probe_degraded": True,
            "engines": {},
            "workers": [
                {
                    "worker_id": "hf-space-1",
                    "online": False,
                    "status": "OFFLINE",
                    "engines": last_known_engines,
                }
            ],
            "queue": {"pending_total": 0, "active_total": 0},
        }
        with (
            patch("app.api.routes.system.is_remote_ocr_mode", return_value=True),
            patch("app.api.routes.system.collect_remote_ocr_health", new=AsyncMock(return_value=sleeping_empty)),
            patch("app.api.routes.system.probe_storage_health", new=AsyncMock(return_value=_healthy_storage())),
            patch("app.api.routes.system.LocalOcrCorrector.probe", new=AsyncMock(return_value=("HEALTHY", "ok"))),
            patch(
                "app.api.routes.system.TtsAudioCacheService.get_summary",
                new=AsyncMock(return_value=_default_audio_cache(10)),
            ),
        ):
            report_idle = await AdminSystemService(repo, voice).health(workers={})

        by_id_idle = {item.id: item for item in report_idle.services}
        self.assertEqual(by_id_idle["ocr_worker"].status, "DEGRADED")
        self.assertEqual(by_id_idle["ocr_worker"].detail_status, "standby")
        self.assertEqual(by_id_idle["ocr_worker"].operational_state, "Standby")
        self.assertEqual(by_id_idle["ocr_worker"].last_error, "REMOTE_OCR_SLEEPING_OR_WAKING")
        self.assertTrue(by_id_idle["ocr_worker"].can_wake)
        for eng_id in ("paddleocr", "vietocr", "tesseract", "tesseract_vie"):
            self.assertEqual(by_id_idle[eng_id].detail_status, "standby", eng_id)
            self.assertEqual(by_id_idle[eng_id].operational_state, "Standby", eng_id)

        # 2. Queue depth > 0 -> escalates to UNAVAILABLE / Offline!
        sleeping_backlog = {
            **sleeping_empty,
            "queue": {"pending_total": 3, "active_total": 0},
        }
        with (
            patch("app.api.routes.system.is_remote_ocr_mode", return_value=True),
            patch("app.api.routes.system.collect_remote_ocr_health", new=AsyncMock(return_value=sleeping_backlog)),
            patch("app.api.routes.system.probe_storage_health", new=AsyncMock(return_value=_healthy_storage())),
            patch("app.api.routes.system.LocalOcrCorrector.probe", new=AsyncMock(return_value=("HEALTHY", "ok"))),
            patch(
                "app.api.routes.system.TtsAudioCacheService.get_summary",
                new=AsyncMock(return_value=_default_audio_cache(10)),
            ),
        ):
            report_backlog = await AdminSystemService(repo, voice).health(workers={})

        by_id_backlog = {item.id: item for item in report_backlog.services}
        self.assertEqual(by_id_backlog["ocr_worker"].status, "UNAVAILABLE")
        self.assertEqual(by_id_backlog["ocr_worker"].operational_state, "Offline")
        self.assertTrue(by_id_backlog["ocr_worker"].can_wake)
        self.assertEqual(report_backlog.overall_status, "DEGRADED")

        # 3. Unconfigured remote OCR -> REMOTE_OCR_WORKER_UNCONFIGURED + action_hint
        unconfigured = {
            "mode": "remote_worker",
            "ready": False,
            "wakeup_configured": False,
            "probe_degraded": False,
            "engines": {},
            "workers": [],
            "queue": {"pending_total": 0, "active_total": 0},
        }
        with (
            patch("app.api.routes.system.is_remote_ocr_mode", return_value=True),
            patch("app.api.routes.system.collect_remote_ocr_health", new=AsyncMock(return_value=unconfigured)),
            patch("app.api.routes.system.probe_storage_health", new=AsyncMock(return_value=_healthy_storage())),
            patch("app.api.routes.system.LocalOcrCorrector.probe", new=AsyncMock(return_value=("HEALTHY", "ok"))),
            patch(
                "app.api.routes.system.TtsAudioCacheService.get_summary",
                new=AsyncMock(return_value=_default_audio_cache(10)),
            ),
        ):
            report_unconf = await AdminSystemService(repo, voice).health(workers={})

        by_id_unconf = {item.id: item for item in report_unconf.services}
        self.assertEqual(by_id_unconf["ocr_worker"].last_error, "REMOTE_OCR_WORKER_UNCONFIGURED")
        self.assertFalse(by_id_unconf["ocr_worker"].can_wake)
        self.assertIn("VIREAD_OCR_REMOTE_WORKER_URL", by_id_unconf["ocr_worker"].action_hint or "")

    async def test_core_unavailability_marks_overall_status_unavailable(self) -> None:
        repo = MagicMock()
        repo.db = None
        repo.probe_database = AsyncMock(return_value=False)
        voice = MagicMock()
        voice.probe_tts = AsyncMock(return_value=("HEALTHY", "ok"))
        voice.probe_stt = AsyncMock(return_value=("HEALTHY", "ok"))

        with (
            patch("app.api.routes.system.probe_storage_health", new=AsyncMock(return_value=_healthy_storage())),
            patch("app.api.routes.system.LocalOcrCorrector.probe", new=AsyncMock(return_value=("HEALTHY", "ok"))),
            patch("app.api.routes.system.collect_ocr_health", return_value=[]),
            patch(
                "app.api.routes.system.TtsAudioCacheService.get_summary",
                new=AsyncMock(return_value=_default_audio_cache(10)),
            ),
        ):
            report = await AdminSystemService(repo, voice).health()

        self.assertEqual(report.overall_status, "UNAVAILABLE")
        by_id = {item.id: item for item in report.services}
        self.assertEqual(by_id["database"].status, "UNAVAILABLE")
        self.assertEqual(by_id["database"].criticality, "core")
        self.assertEqual(by_id["database"].operational_state, "Offline")

    async def test_cron_worker_staleness_presence_300s_never_ran_and_error_recovery(self) -> None:
        now = datetime.now(timezone.utc)
        persisted_hb = {
            # Recovered error: last_success_at > last_error_at -> HEALTHY / scheduled
            "viread_ocr_outbox": {
                "execution_mode": "cron_scheduled",
                "last_success_at": (now - timedelta(minutes=2)).isoformat(),
                "last_error_at": (now - timedelta(minutes=15)).isoformat(),
                "last_error_code": "TRANSIENT_ERR",
            },
            # Active error: last_error_at > last_success_at -> UNAVAILABLE / failed / Offline
            "book_quality": {
                "execution_mode": "cron_scheduled",
                "last_success_at": (now - timedelta(minutes=20)).isoformat(),
                "last_error_at": (now - timedelta(minutes=1)).isoformat(),
                "last_error_code": "LLM_RATE_LIMIT",
            },
            # Fresh heartbeat for presence & reminder
            "reading_presence": {
                "execution_mode": "cron_scheduled",
                "last_success_at": (now - timedelta(minutes=1)).isoformat(),
                "last_error_at": None,
                "last_error_code": None,
            },
            "reading_reminder": {
                "execution_mode": "cron_scheduled",
                "last_success_at": (now - timedelta(minutes=1)).isoformat(),
                "last_error_at": None,
                "last_error_code": None,
            },
            # parent_book_submission never ran -> DEGRADED / unknown / Unknown with cron action_hint
        }
        queue_metrics = {
            # Presence > 300s (360s) -> DEGRADED + STALE_PENDING_JOBS
            "reading_presence": {
                "queue_depth": 2,
                "oldest_pending_job_age_seconds": 360.0,
                "last_success_at": None,
                "last_error": None,
            },
            # Reminder queued <= 15m (120s) -> Queued
            "reading_reminder": {
                "queue_depth": 5,
                "oldest_pending_job_age_seconds": 120.0,
                "last_success_at": None,
                "last_error": None,
            },
        }

        repo = MagicMock()
        repo.db = None
        repo.probe_database = AsyncMock(return_value=True)
        repo.worker_queue_metrics = AsyncMock(return_value=queue_metrics)
        repo.persisted_worker_heartbeats = AsyncMock(return_value=persisted_hb)
        voice = MagicMock()
        voice.probe_tts = AsyncMock(return_value=("HEALTHY", "ok"))
        voice.probe_stt = AsyncMock(return_value=("HEALTHY", "ok"))

        with (
            patch.dict(
                os.environ,
                {
                    "RENDER": "true",
                    "APP_ENVIRONMENT": "production",
                    "VIREAD_ENABLE_LIGHTWEIGHT_WORKERS": "false",
                    "VIREAD_OCR_MODE": "local_inprocess",
                },
                clear=False,
            ),
            patch("app.api.routes.system.probe_storage_health", new=AsyncMock(return_value=_healthy_storage())),
            patch("app.api.routes.system.collect_ocr_health", return_value=[]),
            patch(
                "app.api.routes.system.TtsAudioCacheService.get_summary",
                new=AsyncMock(return_value=_default_audio_cache(10)),
            ),
        ):
            report = await AdminSystemService(repo, voice).health(workers={})

        by_id = {item.id: item for item in report.services}
        self.assertEqual(by_id["viread_ocr_outbox"].status, "HEALTHY")
        self.assertEqual(by_id["viread_ocr_outbox"].detail_status, "scheduled")
        self.assertIsNone(by_id["viread_ocr_outbox"].last_error)

        self.assertEqual(by_id["book_quality"].status, "UNAVAILABLE")
        self.assertEqual(by_id["book_quality"].detail_status, "failed")
        self.assertEqual(by_id["book_quality"].operational_state, "Offline")
        self.assertEqual(by_id["book_quality"].last_error, "LLM_RATE_LIMIT")

        self.assertEqual(by_id["reading_presence"].status, "DEGRADED")
        self.assertEqual(by_id["reading_presence"].operational_state, "Degraded")
        self.assertEqual(by_id["reading_presence"].last_error, "STALE_PENDING_JOBS")

        self.assertEqual(by_id["reading_reminder"].operational_state, "Queued")
        self.assertEqual(by_id["reading_reminder"].queue_depth, 5)

        self.assertEqual(by_id["parent_book_submission"].status, "DEGRADED")
        self.assertEqual(by_id["parent_book_submission"].detail_status, "unknown")
        self.assertEqual(by_id["parent_book_submission"].operational_state, "Unknown")
        self.assertIn("VIREAD_CRON_DISPATCH_TOKEN", by_id["parent_book_submission"].action_hint or "")

    def test_wakeup_endpoint_auth_rate_limit_cache_bust_and_dispatch(self) -> None:
        app = FastAPI()
        app.include_router(system_router, prefix="/system")
        current_role = {"value": "parent"}
        db = MagicMock()
        db.scalar = AsyncMock(side_effect=lambda *_a, **_kw: current_role["value"])
        app.dependency_overrides[get_db] = lambda: db
        client = TestClient(app)

        # 1. Unauthenticated -> 401
        self.assertEqual(client.post("/system/admin/health/ocr-worker/wakeup").status_code, 401)

        # 2. Non-admin -> 403
        app.dependency_overrides[get_current_parent_id] = lambda: PARENT_ACTOR
        with patch("app.api.routes.system.get_cached_profile_role", new=AsyncMock(return_value="parent")):
            self.assertEqual(client.post("/system/admin/health/ocr-worker/wakeup").status_code, 403)

        # 3. Admin + configured -> busts _HEALTH_CACHE, calls send_remote_ocr_wakeup(reason="admin_manual_wakeup", bypass_coalesce=True)
        app.dependency_overrides[get_current_parent_id] = lambda: ADMIN_ACTOR
        remote_ocr_wakeup._HEALTH_CACHE = (time.monotonic() + 60.0, "https://worker.example", None, True)
        rate_limiter.set_override("admin_ocr_wakeup", 2, 60.0)

        with (
            patch("app.api.routes.system.get_cached_profile_role", new=AsyncMock(return_value="admin")),
            patch("app.api.routes.system.is_remote_worker_wakeup_configured", return_value=True),
            patch(
                "app.api.routes.system.send_remote_ocr_wakeup",
                new=AsyncMock(return_value=True),
            ) as wake_mock,
        ):
            r1 = client.post("/system/admin/health/ocr-worker/wakeup")
            self.assertEqual(r1.status_code, 200)
            payload = AdminOcrWorkerWakeupResponse.model_validate(r1.json())
            self.assertEqual(payload.status, "woken")
            self.assertTrue(payload.woken)
            self.assertIsNone(remote_ocr_wakeup._HEALTH_CACHE)
            wake_mock.assert_awaited_once_with(
                reason="admin_manual_wakeup",
                bypass_coalesce=True,
            )

            # 2nd request succeeds
            r2 = client.post("/system/admin/health/ocr-worker/wakeup")
            self.assertEqual(r2.status_code, 200)

            # 3rd request hits 429 rate limit
            r3 = client.post("/system/admin/health/ocr-worker/wakeup")
            self.assertEqual(r3.status_code, 429)
            self.assertIn("Retry-After", r3.headers)


class AdminCatalogCoverHydrationTests(unittest.IsolatedAsyncioTestCase):
    async def test_admin_catalog_list_hydrates_covers_in_single_batched_query_with_priority(self) -> None:
        book_a_id = uuid4()
        book_b_id = uuid4()
        book_c_id = uuid4()
        asset_meta_a = uuid4()
        asset_upload_a = uuid4()
        asset_ai_b = uuid4()

        book_a = SimpleNamespace(
            Id=book_a_id, Name="Sách A", Title="Sách A", Author="Tác giả A",
            MinGrade=1, MaxGrade=2, LifecycleStatus="ACTIVE", VisibilityScope="CATALOG",
        )
        book_b = SimpleNamespace(
            Id=book_b_id, Name="Sách B", Title="Sách B", Author="Tác giả B",
            MinGrade=2, MaxGrade=3, LifecycleStatus="ACTIVE", VisibilityScope="CATALOG",
        )
        book_c = SimpleNamespace(
            Id=book_c_id, Name="Sách C", Title="Sách C", Author=None,
            MinGrade=1, MaxGrade=5, LifecycleStatus="RETIRED", VisibilityScope="CATALOG",
        )

        cover_assets = [
            SimpleNamespace(Id=asset_meta_a, BookId=book_a_id, SourceType="METADATA_RENDER"),
            SimpleNamespace(Id=asset_upload_a, BookId=book_a_id, SourceType="USER_UPLOAD"),
            SimpleNamespace(Id=asset_ai_b, BookId=book_b_id, SourceType="AI_GENERATED"),
        ]

        class _NestedCtx:
            async def __aenter__(self):
                return self

            async def __aexit__(self, *_a):
                return False

        class _ScalarRows:
            def all(self):
                return cover_assets

        fake_db = MagicMock()
        fake_db.begin_nested = MagicMock(return_value=_NestedCtx())
        fake_db.scalars = AsyncMock(return_value=_ScalarRows())

        repo = AdminCatalogRepository(fake_db)
        repo.catalog_rows = AsyncMock(
            return_value=[
                (book_a, 4, 0, 1, 3, 0, False),
                (book_b, 2, 0, 0, 2, 0, True),
                (book_c, 0, 0, 0, 0, 0, False),
            ]
        )

        items = await AdminCatalogService(repository=repo).list(None, None, None)

        # Strictly 1 batched cover query for all 3 books (no N+1!)
        fake_db.scalars.assert_awaited_once()
        by_id = {item.book.id: item.book for item in items}
        self.assertEqual(by_id[book_a_id].cover_url, f"/studio/assets/{asset_upload_a}/media")
        self.assertEqual(by_id[book_a_id].cover_source_type, "USER_UPLOAD")
        self.assertEqual(by_id[book_b_id].cover_url, f"/studio/assets/{asset_ai_b}/media")
        self.assertEqual(by_id[book_b_id].cover_source_type, "AI_GENERATED")
        self.assertIsNone(by_id[book_c_id].cover_url)
        self.assertIsNone(by_id[book_c_id].cover_source_type)


class OpsHealthCoreVoiceOcrFixesTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self) -> None:
        clear_rate_limits()
        remote_ocr_wakeup.clear_remote_ocr_wakeup_cache_for_tests()
        from app.services.tts_audio_cache_service import clear_tts_cache_runtime_metrics

        clear_tts_cache_runtime_metrics()

    def tearDown(self) -> None:
        clear_rate_limits()
        remote_ocr_wakeup.clear_remote_ocr_wakeup_cache_for_tests()
        from app.services.tts_audio_cache_service import clear_tts_cache_runtime_metrics

        clear_tts_cache_runtime_metrics()

    async def test_get_admin_health_route_rolls_back_active_db_tx_before_health_probes(self) -> None:
        from app.api.routes.system import get_admin_health

        db = MagicMock(spec=AsyncSession)
        db.in_transaction.return_value = True
        db.rollback = AsyncMock()
        events: list[str] = []

        async def _fake_rollback():
            events.append("rollback")

        db.rollback.side_effect = _fake_rollback

        fake_report = AdminHealthRead(
            overall_status="HEALTHY",
            checked_at=datetime.now(timezone.utc),
            services=[],
        )

        async def _fake_health(*_a, **_kw):
            events.append("health")
            return fake_report

        req = SimpleNamespace(app=SimpleNamespace(state=SimpleNamespace(background_workers={})))
        with (
            patch.object(AdminSystemService, "require_admin", new=AsyncMock()) as req_admin,
            patch.object(AdminSystemService, "health", new=AsyncMock(side_effect=_fake_health)),
        ):
            res = await get_admin_health(request=req, actor_id=ADMIN_ACTOR, db=db)

        req_admin.assert_awaited_once_with(ADMIN_ACTOR)
        db.rollback.assert_awaited_once()
        self.assertEqual(events, ["rollback", "health"])
        self.assertEqual(res.overall_status, "HEALTHY")

    async def test_hosted_tts_elevenlabs_ready_and_empty_cache_fallback_do_not_report_local_unconfigured(
        self,
    ) -> None:
        el_orch = MagicMock()
        el_orch.get_status = AsyncMock(
            return_value={
                "local": {
                    "configured": False,
                    "available": False,
                    "stt_ready": False,
                    "tts_ready": False,
                    "error_code": "LOCAL_VOICE_UNCONFIGURED",
                },
                "elevenlabs": {
                    "configured": True,
                    "tts_cooldown": False,
                    "stt_cooldown": False,
                },
                "google": {
                    "stt_configured": False,
                    "tts_configured": False,
                    "stt_cooldown": False,
                    "tts_cooldown": False,
                },
            }
        )
        repo = MagicMock()
        repo.db = None
        repo.probe_database = AsyncMock(return_value=True)
        with (
            patch.dict(
                os.environ,
                {"RENDER": "true", "APP_ENVIRONMENT": "production", "VIREAD_OCR_MODE": "local_inprocess"},
                clear=False,
            ),
            patch("app.api.routes.system.probe_storage_health", new=AsyncMock(return_value=_healthy_storage())),
            patch("app.api.routes.system.collect_ocr_health", return_value=[]),
            patch(
                "app.api.routes.system.TtsAudioCacheService.get_summary",
                new=AsyncMock(return_value=_default_audio_cache(0)),
            ),
        ):
            el_report = await AdminSystemService(repo, el_orch).health()

        by_id_el = {item.id: item for item in el_report.services}
        self.assertEqual(by_id_el["tts"].status, "HEALTHY")
        self.assertEqual(by_id_el["tts"].detail_status, "cloud_ready")
        self.assertEqual(by_id_el["tts"].execution_mode, "cloud_ai")

        # Empty TTS audio cache on hosted mode with no cloud keys -> HEALTHY standby cache + Web Speech fallback
        empty_orch = MagicMock()
        empty_orch.get_status = AsyncMock(
            return_value={
                "local": {
                    "configured": False,
                    "available": False,
                    "stt_ready": False,
                    "tts_ready": False,
                    "error_code": "LOCAL_VOICE_UNCONFIGURED",
                },
                "elevenlabs": {
                    "configured": False,
                    "tts_cooldown": False,
                    "stt_cooldown": False,
                },
                "google": {
                    "stt_configured": False,
                    "tts_configured": False,
                    "stt_cooldown": False,
                    "tts_cooldown": False,
                },
            }
        )
        with (
            patch.dict(
                os.environ,
                {"RENDER": "true", "APP_ENVIRONMENT": "production", "VIREAD_OCR_MODE": "local_inprocess"},
                clear=False,
            ),
            patch("app.api.routes.system.probe_storage_health", new=AsyncMock(return_value=_healthy_storage())),
            patch("app.api.routes.system.collect_ocr_health", return_value=[]),
            patch("app.api.routes.system.is_tts_cache_enabled", return_value=True),
            patch(
                "app.api.routes.system.TtsAudioCacheService.get_summary",
                new=AsyncMock(return_value=_default_audio_cache(0)),
            ),
        ):
            cached_empty_report = await AdminSystemService(repo, empty_orch).health()

        by_id_empty = {item.id: item for item in cached_empty_report.services}
        self.assertEqual(by_id_empty["tts"].status, "HEALTHY")
        self.assertEqual(by_id_empty["tts"].detail_status, "cached")
        self.assertNotEqual(by_id_empty["tts"].last_error, "LOCAL_VOICE_UNCONFIGURED")

    async def test_remote_ocr_probe_timeout_and_hosted_idle_never_report_fake_unconfigured_while_online_worker_is_healthy(
        self,
    ) -> None:
        repo = MagicMock()
        repo.db = None
        repo.probe_database = AsyncMock(return_value=True)
        voice = MagicMock()
        voice.probe_tts = AsyncMock(return_value=("HEALTHY", "ok"))
        voice.probe_stt = AsyncMock(return_value=("HEALTHY", "ok"))

        # 1. Timeout during collect_remote_ocr_health -> Unknown / OCR_HEALTH_PROBE_TIMEOUT, NOT REMOTE_OCR_WORKER_UNCONFIGURED
        with (
            patch.dict(os.environ, {"RENDER": "true", "APP_ENVIRONMENT": "production"}, clear=False),
            patch("app.api.routes.system.is_remote_ocr_mode", return_value=True),
            patch(
                "app.api.routes.system.collect_remote_ocr_health",
                new=AsyncMock(side_effect=asyncio.TimeoutError()),
            ),
            patch("app.api.routes.system.is_remote_worker_wakeup_configured", return_value=False),
            patch("app.api.routes.system.probe_storage_health", new=AsyncMock(return_value=_healthy_storage())),
            patch(
                "app.api.routes.system.TtsAudioCacheService.get_summary",
                new=AsyncMock(return_value=_default_audio_cache(0)),
            ),
        ):
            timeout_report = await AdminSystemService(repo, voice).health(workers={})

        by_timeout = {item.id: item for item in timeout_report.services}
        self.assertEqual(by_timeout["ocr_worker"].status, "DEGRADED")
        self.assertEqual(by_timeout["ocr_worker"].detail_status, "unknown")
        self.assertEqual(by_timeout["ocr_worker"].operational_state, "Unknown")
        self.assertEqual(by_timeout["ocr_worker"].last_error, "OCR_HEALTH_PROBE_TIMEOUT")
        self.assertNotEqual(by_timeout["ocr_worker"].last_error, "REMOTE_OCR_WORKER_UNCONFIGURED")

        # 2. Hosted empty queue with no remote URL -> Standby (no false REMOTE_OCR_WORKER_UNCONFIGURED)
        hosted_idle = {
            "mode": "remote_worker",
            "ready": False,
            "wakeup_configured": False,
            "probe_degraded": False,
            "engines": {},
            "workers": [],
            "queue": {"pending_total": 0, "active_total": 0},
        }
        with (
            patch.dict(os.environ, {"RENDER": "true", "APP_ENVIRONMENT": "production"}, clear=False),
            patch("app.api.routes.system.is_remote_ocr_mode", return_value=True),
            patch(
                "app.api.routes.system.collect_remote_ocr_health",
                new=AsyncMock(return_value=hosted_idle),
            ),
            patch("app.api.routes.system.probe_storage_health", new=AsyncMock(return_value=_healthy_storage())),
            patch(
                "app.api.routes.system.TtsAudioCacheService.get_summary",
                new=AsyncMock(return_value=_default_audio_cache(0)),
            ),
        ):
            idle_report = await AdminSystemService(repo, voice).health(workers={})

        by_idle = {item.id: item for item in idle_report.services}
        self.assertEqual(by_idle["ocr_worker"].detail_status, "standby")
        self.assertEqual(by_idle["ocr_worker"].operational_state, "Standby")
        self.assertIsNone(by_idle["ocr_worker"].last_error)

        # 3. Online laptop worker win-ocr-c -> all 5 OCR entries HEALTHY
        win_worker_online = {
            "mode": "remote_worker",
            "ready": True,
            "wakeup_configured": False,
            "probe_degraded": False,
            "engines": {
                "paddleocr": {"status": "HEALTHY", "detail_status": "inference_verified", "installed": True, "loaded": True, "inference_verified": True},
                "vietocr": {"status": "HEALTHY", "detail_status": "inference_verified", "installed": True, "loaded": True, "inference_verified": True},
                "tesseract_vie": {"status": "HEALTHY", "detail_status": "inference_verified", "installed": True, "loaded": True, "inference_verified": True},
            },
            "workers": [
                {"worker_id": "win-ocr-c", "online": True, "ready": True, "standby_mode": "quiet_standby", "engines": {}}
            ],
            "queue": {"pending_total": 0, "active_total": 0},
        }
        with (
            patch.dict(os.environ, {"RENDER": "true", "APP_ENVIRONMENT": "production"}, clear=False),
            patch("app.api.routes.system.is_remote_ocr_mode", return_value=True),
            patch(
                "app.api.routes.system.collect_remote_ocr_health",
                new=AsyncMock(return_value=win_worker_online),
            ),
            patch("app.api.routes.system.probe_storage_health", new=AsyncMock(return_value=_healthy_storage())),
            patch(
                "app.api.routes.system.TtsAudioCacheService.get_summary",
                new=AsyncMock(return_value=_default_audio_cache(0)),
            ),
        ):
            online_report = await AdminSystemService(repo, voice).health(workers={})

        by_online = {item.id: item for item in online_report.services}
        for ocr_id in ("ocr_worker", "paddleocr", "vietocr", "tesseract", "tesseract_vie"):
            self.assertEqual(by_online[ocr_id].status, "HEALTHY", ocr_id)

    async def test_queue_metrics_parent_email_and_ocr_training_ignore_colab_wait_or_active_lease(
        self,
    ) -> None:
        from sqlalchemy import create_engine, text
        from sqlalchemy.orm import sessionmaker

        sync_engine = create_engine("sqlite:///:memory:")
        try:
            with sync_engine.begin() as conn:
                conn.execute(
                    text(
                        """
                        CREATE TABLE parentemaildeliveries (
                            status TEXT NOT NULL,
                            nextattemptat TEXT,
                            createdat TEXT NOT NULL,
                            sentat TEXT
                        )
                        """
                    )
                )
                conn.execute(
                    text(
                        """
                        CREATE TABLE viread_ocr_training_jobs (
                            status TEXT NOT NULL,
                            target TEXT,
                            created_at TEXT NOT NULL,
                            updated_at TEXT NOT NULL,
                            lease_expires_at TEXT
                        )
                        """
                    )
                )
                now = datetime.now(timezone.utc)
                old_ts = (now - timedelta(minutes=30)).strftime("%Y-%m-%d %H:%M:%S")
                recent_ts = (now - timedelta(minutes=2)).strftime("%Y-%m-%d %H:%M:%S")
                future_ts = (now + timedelta(minutes=20)).strftime("%Y-%m-%d %H:%M:%S")
                conn.execute(
                    text(
                        """
                        INSERT INTO parentemaildeliveries (status, nextattemptat, createdat, sentat)
                        VALUES
                            ('SENT', NULL, :old_ts, :recent_ts),
                            ('RETRY', :old_ts, :old_ts, NULL)
                        """
                    ),
                    {"old_ts": old_ts, "recent_ts": recent_ts},
                )
                conn.execute(
                    text(
                        """
                        INSERT INTO viread_ocr_training_jobs (status, target, created_at, updated_at, lease_expires_at)
                        VALUES
                            ('WAITING_FOR_COLAB_WORKER', 'COLAB', :old_ts, :old_ts, NULL),
                            ('COLAB_RUNNING', 'COLAB', :old_ts, :recent_ts, :future_ts),
                            ('CANDIDATE', 'COLAB', :old_ts, :recent_ts, NULL)
                        """
                    ),
                    {"old_ts": old_ts, "recent_ts": recent_ts, "future_ts": future_ts},
                )

            class _Bridge:
                def __init__(self, s):
                    self.s = s
                    self.sync_session = s
                    self.bind = s.bind

                async def execute(self, stmt, params=None):
                    return self.s.execute(stmt, params) if params is not None else self.s.execute(stmt)

            with sessionmaker(bind=sync_engine)() as sess:
                metrics = await runtime_diagnostics.collect_worker_queue_metrics(_Bridge(sess))  # type: ignore[arg-type]

            email_m = metrics["parent_email_dispatcher"]
            self.assertEqual(email_m["queue_depth"], 1)
            self.assertIsNotNone(email_m["last_success_at"])
            self.assertIsNotNone(email_m["oldest_pending_job_age_seconds"])

            train_m = metrics["viread_ocr_training"]
            self.assertEqual(train_m["queue_depth"], 2)
            self.assertIsNotNone(train_m["last_success_at"])
            self.assertIsNone(train_m["oldest_pending_job_age_seconds"])
        finally:
            sync_engine.dispose()

    async def test_tts_cache_summary_ram_ttl_cache_hits_once_and_invalidates(self) -> None:
        from app.repositories.tts_audio_cache_repository import TtsAudioCacheRepository
        from app.services.tts_audio_cache_service import (
            TtsAudioCacheService,
            invalidate_tts_cache_summary_cache,
        )

        mock_repo = MagicMock(spec=TtsAudioCacheRepository)
        mock_repo.get_summary = AsyncMock(
            side_effect=[
                {
                    "entry_count": 3,
                    "storage_used_bytes": 100,
                    "daily_egress_bytes": 10,
                    "hit_count": 2,
                    "miss_count": 1,
                },
                {
                    "entry_count": 4,
                    "storage_used_bytes": 150,
                    "daily_egress_bytes": 12,
                    "hit_count": 3,
                    "miss_count": 1,
                },
            ]
        )
        fake_db = MagicMock(spec=AsyncSession)
        fake_db.bind = object()
        svc = TtsAudioCacheService(fake_db)
        svc.repo = mock_repo
        first = await svc.get_summary()
        second = await svc.get_summary()
        self.assertEqual(first["entry_count"], 3)
        self.assertEqual(second["entry_count"], 3)
        self.assertEqual(mock_repo.get_summary.await_count, 1)

        invalidate_tts_cache_summary_cache()
        third = await svc.get_summary()
        self.assertEqual(third["entry_count"], 4)
        self.assertEqual(mock_repo.get_summary.await_count, 2)


if __name__ == "__main__":
    unittest.main()
