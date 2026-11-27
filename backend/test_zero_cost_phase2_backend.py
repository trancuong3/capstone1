"""Unit tests for ViRead zero-cost Phase 2 backend fixes, TTS cache, health & scripts."""
from __future__ import annotations

import hashlib
import io
import json
import logging
import os
import subprocess
import sys
import tempfile
import unittest
from datetime import datetime, timedelta, timezone
from decimal import Decimal
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock, patch
from uuid import UUID, uuid4

from fastapi.testclient import TestClient
from sqlalchemy.exc import ProgrammingError
from sqlalchemy.ext.asyncio import AsyncSession

BACKEND_ROOT = Path(__file__).resolve().parent
REPO_ROOT = BACKEND_ROOT.parent
if str(BACKEND_ROOT) not in sys.path:
    sys.path.insert(0, str(BACKEND_ROOT))
if str(REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(REPO_ROOT))

os.environ.setdefault("DATABASE_URL", "postgresql+asyncpg://test:test@127.0.0.1:1/test")
os.environ.setdefault("SUPABASE_URL", "https://example.supabase.co")
os.environ.setdefault("SUPABASE_KEY", "isolated-test-key")
os.environ.setdefault("APP_ENVIRONMENT", "test")
os.environ.setdefault("VIREAD_LOCAL_VOICE_WORKER_AUTOSTART", "false")

from app.api.deps import get_db, require_active_profile_id  # noqa: E402
from app.api.routes.system import AdminSystemService  # noqa: E402
from app.api.routes.voice import (  # noqa: E402
    clear_default_voice_orchestrators,
    get_voice_orchestrator,
)
from app.diagnostic_logging import log_diagnostic  # noqa: E402
from app.models import TtsAudioCacheEntry  # noqa: E402
from app.providers.local_voice_provider import (  # noqa: E402
    DEFAULT_LOCAL_VOICE_ID,
    LOCAL_TTS_MODEL_VERSION,
    LocalPhonicsSpeech,
    LocalPhonicsStepTiming,
    LocalSynthesizedAudio,
    LocalTimedSpeech,
    LocalTimedWord,
    LocalVoiceTechnicalError,
)
from app.schemas.system import AdminAudioCacheSummaryRead  # noqa: E402
from app.services.admin_book_service import AdminBookService  # noqa: E402
from app.services.parent_private_book_service import ParentPrivateBookService  # noqa: E402
from app.services.runtime_diagnostics import derive_operational_state  # noqa: E402
from app.services.tts_audio_cache_service import (  # noqa: E402
    ALLOWED_COACHING_PHRASES_RAW,
    ResolvedCacheTarget,
    TtsAudioCacheService,
    canonical_phonics_key,
    canonical_tts_sha256,
    canonical_tts_text,
    clear_tts_cache_runtime_metrics,
    detect_audio_content_type,
    invalidate_tts_cache_best_effort,
    transcode_to_mp3_64k,
)
from app.services.voice_orchestrator import VoiceOrchestrator, VoicePolicyContext  # noqa: E402
from app.sever import app  # noqa: E402


class _FakeAsyncPgError(Exception):
    def __init__(self, msg: str, *, sqlstate: str) -> None:
        super().__init__(msg)
        self.sqlstate = sqlstate


class _InMemoryTtsRepo:
    """In-memory repository double preserving exact isolation & LRU semantics."""

    def __init__(
        self,
        *,
        books: dict[UUID, dict] | None = None,
        pages: dict[UUID, dict] | None = None,
        revisions: dict[UUID, dict] | None = None,
        verified_texts: dict[UUID, list[tuple[str | None, list[tuple[str | None, str | None]]]]] | None = None,
    ) -> None:
        self.books = books or {}
        self.pages = pages or {}
        self.revisions = revisions or {}
        self.verified_texts = verified_texts or {}
        self.entries: dict[UUID, TtsAudioCacheEntry] = {}
        self.daily = {"bytes_served": 0, "hit_count": 0, "miss_count": 0}

    async def get_book_scope_info(self, book_id: UUID):
        return self.books.get(book_id)

    async def get_page_book_scope_info(self, page_id: UUID):
        return self.pages.get(page_id)

    async def get_page_revision_scope_info(
        self,
        *,
        page_revision_id: UUID,
        page_id: UUID | None = None,
        book_id: UUID | None = None,
    ):
        rev = self.revisions.get(page_revision_id)
        if rev is None:
            return None
        if page_id is not None and rev["page_id"] != page_id:
            return None
        if book_id is not None and rev["book_id"] != book_id:
            return None
        return rev

    async def get_verified_catalog_texts(
        self,
        *,
        book_id: UUID,
        page_id: UUID | None = None,
        page_revision_id: UUID | None = None,
    ):
        if page_revision_id is not None and page_revision_id in self.verified_texts:
            return self.verified_texts[page_revision_id]
        if page_id is not None and page_id in self.verified_texts:
            return self.verified_texts[page_id]
        return self.verified_texts.get(book_id, [])

    async def get_active_entry(
        self,
        *,
        scope: str,
        owner_parent_id: UUID | None,
        content_sha256: str,
        voice_id: str,
        model_version: str | None,
        speed: float,
        audio_formats,
        require_word_timings: bool = False,
    ):
        if scope == "PRIVATE" and owner_parent_id is None:
            return None
        q_speed = Decimal(f"{float(speed):.2f}")
        matches = [
            e
            for e in self.entries.values()
            if e.Status == "ACTIVE"
            and e.Scope == scope
            and (e.OwnerParentId == owner_parent_id if scope == "PRIVATE" else e.OwnerParentId is None)
            and e.ContentSha256 == content_sha256
            and e.VoiceId == voice_id
            and (model_version is None or e.ModelVersion == model_version)
            and Decimal(str(e.Speed)) == q_speed
            and e.AudioFormat in audio_formats
            and (not require_word_timings or e.WordTimingsJson is not None)
        ]
        matches.sort(key=lambda e: e.CreatedAt, reverse=True)
        return matches[0] if matches else None

    async def get_nearest_active_entry(
        self,
        *,
        scope: str,
        owner_parent_id: UUID | None,
        content_sha256: str,
        voice_id: str,
        model_version: str | None,
        speed: float,
        audio_formats,
        require_word_timings: bool = False,
    ):
        if scope == "PRIVATE" and owner_parent_id is None:
            return None
        q_speed = Decimal(f"{float(speed):.2f}")
        matches = [
            e
            for e in self.entries.values()
            if e.Status == "ACTIVE"
            and e.Scope == scope
            and (e.OwnerParentId == owner_parent_id if scope == "PRIVATE" else e.OwnerParentId is None)
            and e.ContentSha256 == content_sha256
            and e.VoiceId == voice_id
            and (model_version is None or e.ModelVersion == model_version)
            and e.AudioFormat in audio_formats
            and (not require_word_timings or e.WordTimingsJson is not None)
        ]
        matches.sort(key=lambda e: (abs(Decimal(str(e.Speed)) - q_speed), -e.CreatedAt.timestamp()))
        return matches[0] if matches else None

    async def upsert_active_entry(self, **kwargs):
        now = kwargs.get("now") or datetime.now(timezone.utc)
        entry_id = uuid4()
        entry = TtsAudioCacheEntry(
            Id=entry_id,
            Scope=kwargs["scope"],
            OwnerParentId=kwargs["owner_parent_id"],
            BookId=kwargs["book_id"],
            PageId=kwargs["page_id"],
            PageRevisionId=kwargs["page_revision_id"],
            ContentSha256=kwargs["content_sha256"],
            NormalizedText=kwargs["normalized_text"],
            VoiceId=kwargs["voice_id"],
            ModelVersion=kwargs["model_version"],
            Speed=Decimal(f"{float(kwargs['speed']):.2f}"),
            AudioFormat=kwargs["audio_format"],
            StorageBucket=kwargs["storage_bucket"],
            StoragePath=kwargs["storage_path"],
            ByteSize=int(kwargs["byte_size"]),
            DurationSeconds=kwargs["duration_seconds"],
            WordTimingsJson=kwargs["word_timings_json"],
            Status="ACTIVE",
            LastAccessedAt=now,
            HitCount=0,
            CreatedAt=now,
            UpdatedAt=now,
        )
        self.entries[entry_id] = entry
        return entry, []

    async def get_daily_usage(self, usage_day=None):
        return dict(self.daily)

    async def record_hit(self, entry_id: UUID, *, byte_size: int, now=None):
        if entry_id in self.entries:
            self.entries[entry_id].HitCount = int(self.entries[entry_id].HitCount or 0) + 1
            self.entries[entry_id].LastAccessedAt = now or datetime.now(timezone.utc)
        self.daily["bytes_served"] += int(byte_size)
        self.daily["hit_count"] += 1

    async def record_miss(self, *, now=None):
        self.daily["miss_count"] += 1

    async def total_active_bytes(self) -> int:
        return sum(int(e.ByteSize) for e in self.entries.values() if e.Status == "ACTIVE")

    async def list_lru_eviction_candidates(self, *, exclude_ids=(), limit: int = 100):
        rows = [
            e
            for e in self.entries.values()
            if e.Status == "ACTIVE" and e.Id not in set(exclude_ids)
        ]
        rows.sort(key=lambda e: (e.LastAccessedAt, e.CreatedAt))
        return rows[:limit]

    async def mark_entries_status(self, entry_ids, *, status: str, now=None) -> int:
        cnt = 0
        for eid in entry_ids:
            if eid in self.entries:
                self.entries[eid].Status = status
                cnt += 1
        return cnt

    async def mark_stale_for_target(
        self, *, book_id=None, page_id=None, page_revision_id=None, now=None
    ):
        removed = []
        for e in self.entries.values():
            if e.Status != "ACTIVE":
                continue
            if (
                (book_id is not None and e.BookId == book_id)
                or (page_id is not None and e.PageId == page_id)
                or (page_revision_id is not None and e.PageRevisionId == page_revision_id)
            ):
                e.Status = "STALE"
                removed.append((e.StorageBucket, e.StoragePath))
        return removed

    async def get_summary(self, *, now=None):
        active = [e for e in self.entries.values() if e.Status == "ACTIVE"]
        return {
            "entry_count": len(active),
            "storage_used_bytes": sum(int(e.ByteSize) for e in active),
            "daily_egress_bytes": self.daily["bytes_served"],
            "hit_count": self.daily["hit_count"],
            "miss_count": self.daily["miss_count"],
        }


class ZeroCostPhase2BackendTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self) -> None:
        clear_default_voice_orchestrators()
        clear_tts_cache_runtime_metrics()
        app.dependency_overrides.clear()

    def tearDown(self) -> None:
        clear_default_voice_orchestrators()
        clear_tts_cache_runtime_metrics()
        app.dependency_overrides.clear()

    def test_transaction_pooler_selects_nullpool_and_disables_caches(self) -> None:
        import certifi

        env = os.environ.copy()
        env["APP_ENVIRONMENT"] = "production"
        env["DATABASE_POOLER_MODE"] = "transaction"
        env["DATABASE_SSL_REQUIRED"] = "true"
        env["DATABASE_SSL_ROOT_CERT"] = certifi.where()
        env["DATABASE_URL"] = "postgresql+asyncpg://u:p@db.example.com:6543/postgres"
        env["SUPABASE_URL"] = "https://x.supabase.co"
        env["SUPABASE_KEY"] = "test-key"
        env.pop("DATABASE_FORCE_NULL_POOL", None)
        code_bounded = (
            "import sys; sys.path.insert(0, r'" + str(BACKEND_ROOT) + "');"
            "from sqlalchemy.pool import AsyncAdaptedQueuePool;"
            "from app.database import session;"
            "assert isinstance(session.engine.pool, AsyncAdaptedQueuePool), type(session.engine.pool);"
            "assert session.engine.pool.size() == 2, session.engine.pool.size();"
            "assert session.engine.pool._max_overflow == 2, session.engine.pool._max_overflow;"
            "assert session.asyncpg_connect_args['statement_cache_size'] == 0;"
            "assert session.sqlalchemy_database_url.query['prepared_statement_cache_size'] == '0';"
            "print('BOUNDED_POOL_OK')"
        )
        proc = subprocess.run(
            [sys.executable, "-c", code_bounded],
            env=env,
            capture_output=True,
            text=True,
            check=False,
        )
        self.assertEqual(proc.returncode, 0, msg=proc.stderr or proc.stdout)
        self.assertIn("BOUNDED_POOL_OK", proc.stdout)

        env_forced = {**env, "DATABASE_FORCE_NULL_POOL": "true"}
        code_null = (
            "import sys; sys.path.insert(0, r'" + str(BACKEND_ROOT) + "');"
            "from sqlalchemy.pool import NullPool;"
            "from app.database import session;"
            "assert isinstance(session.engine.pool, NullPool), type(session.engine.pool);"
            "assert session.asyncpg_connect_args['statement_cache_size'] == 0;"
            "assert session.sqlalchemy_database_url.query['prepared_statement_cache_size'] == '0';"
            "print('NULLPOOL_OK')"
        )
        proc_null = subprocess.run(
            [sys.executable, "-c", code_null],
            env=env_forced,
            capture_output=True,
            text=True,
            check=False,
        )
        self.assertEqual(proc_null.returncode, 0, msg=proc_null.stderr or proc_null.stdout)
        self.assertIn("NULLPOOL_OK", proc_null.stdout)

    def test_diagnostic_logging_extracts_safe_pgcode_without_pii(self) -> None:
        buf = io.StringIO()
        handler = logging.StreamHandler(buf)
        test_logger = logging.getLogger("test.pgcode.logger")
        test_logger.handlers = [handler]
        test_logger.setLevel(logging.ERROR)
        test_logger.propagate = False

        secret_sql = "SELECT * FROM private_secret_table WHERE secret='top-secret-token'"
        exc = ProgrammingError(secret_sql, {}, _FakeAsyncPgError("permission denied", sqlstate="42501"))
        log_diagnostic(test_logger, logging.ERROR, event="worker_fail", stage="claim", exception=exc)

        line = buf.getvalue().strip()
        self.assertNotIn("top-secret-token", line)
        self.assertNotIn("permission denied", line)
        payload = json.loads(line.split("readalong_diagnostic ", 1)[1])
        self.assertEqual(payload["error_code"], "f405")
        self.assertEqual(payload["pgcode"], "42501")

        # Invalid/oversized sqlstate must be suppressed
        buf2 = io.StringIO()
        handler2 = logging.StreamHandler(buf2)
        test_logger.handlers = [handler2]
        bad_exc = ProgrammingError("stmt", {}, _FakeAsyncPgError("msg", sqlstate="BAD SQLSTATE!"))
        log_diagnostic(test_logger, logging.ERROR, event="worker_fail", stage="claim", exception=bad_exc)
        payload2 = json.loads(buf2.getvalue().split("readalong_diagnostic ", 1)[1])
        self.assertIsNone(payload2["pgcode"])

    def test_voice_worker_token_env_unification(self) -> None:
        with patch.dict(
            os.environ,
            {
                "VIREAD_VOICE_WORKER_TOKEN": "primary-token-123",
                "VIREAD_LOCAL_VOICE_WORKER_TOKEN": "legacy-token-456",
            },
            clear=False,
        ):
            orch = get_voice_orchestrator()
            headers = orch.local.get_ws_auth_headers()
            self.assertEqual(headers.get("X-ViRead-Voice-Token"), "primary-token-123")
            self.assertEqual(headers.get("Authorization"), "Bearer primary-token-123")

        with patch.dict(
            os.environ,
            {
                "VIREAD_VOICE_WORKER_TOKEN": "",
                "VIREAD_LOCAL_VOICE_WORKER_TOKEN": "legacy-token-456",
            },
            clear=False,
        ):
            clear_default_voice_orchestrators()
            orch2 = get_voice_orchestrator()
            headers2 = orch2.local.get_ws_auth_headers()
            self.assertEqual(headers2.get("X-ViRead-Voice-Token"), "legacy-token-456")
            self.assertEqual(headers2.get("Authorization"), "Bearer legacy-token-456")

    def test_audio_format_detection_and_safe_transcode_fallback(self) -> None:
        wav_bytes = b"RIFF\x24\x00\x00\x00WAVEfmt "
        mp3_bytes = b"ID3\x03\x00\x00\x00\x00\x00\x00"
        ogg_bytes = b"OggS\x00\x02"
        self.assertEqual(detect_audio_content_type(wav_bytes, "audio/mpeg"), "audio/wav")
        self.assertEqual(detect_audio_content_type(mp3_bytes, "audio/wav"), "audio/mpeg")
        self.assertEqual(detect_audio_content_type(ogg_bytes, None), "audio/ogg")

        out_bytes, out_ct = transcode_to_mp3_64k(wav_bytes, "audio/wav")
        self.assertTrue(len(out_bytes) > 0)
        self.assertIn(out_ct, {"audio/mpeg", "audio/wav"})

    async def test_tts_cache_hit_when_local_worker_offline_and_cross_family_404(self) -> None:
        parent_a = uuid4()
        parent_b = uuid4()
        catalog_book = uuid4()
        catalog_page = uuid4()
        private_book = uuid4()
        private_page = uuid4()

        with tempfile.TemporaryDirectory() as tmpdir:
            repo = _InMemoryTtsRepo(
                books={
                    catalog_book: {
                        "book_id": catalog_book,
                        "visibility_scope": "CATALOG",
                        "owner_parent_id": None,
                        "lifecycle_status": "ACTIVE",
                        "moderation_status": "ACTIVE",
                        "is_deleted": False,
                    },
                    private_book: {
                        "book_id": private_book,
                        "visibility_scope": "PARENT_PRIVATE",
                        "owner_parent_id": parent_a,
                        "lifecycle_status": "ACTIVE",
                        "moderation_status": "ACTIVE",
                        "is_deleted": False,
                    },
                },
                pages={
                    catalog_page: {
                        "page_id": catalog_page,
                        "book_id": catalog_book,
                        "page_lifecycle_status": "ACTIVE",
                        "visibility_scope": "CATALOG",
                        "owner_parent_id": None,
                        "lifecycle_status": "ACTIVE",
                        "moderation_status": "ACTIVE",
                        "is_deleted": False,
                    },
                    private_page: {
                        "page_id": private_page,
                        "book_id": private_book,
                        "page_lifecycle_status": "ACTIVE",
                        "visibility_scope": "PARENT_PRIVATE",
                        "owner_parent_id": parent_a,
                        "lifecycle_status": "ACTIVE",
                        "moderation_status": "ACTIVE",
                        "is_deleted": False,
                    },
                },
            )

            with patch.dict(os.environ, {"VIREAD_LOCAL_STORAGE_DIR": tmpdir}, clear=False):
                fake_db = MagicMock(spec=AsyncSession)
                fake_db.commit = AsyncMock()
                fake_db.rollback = AsyncMock()
                cache_svc = TtsAudioCacheService(fake_db)
                cache_svc.repo = repo  # type: ignore[assignment]

                # Populate CATALOG plain + timed + phonics + PRIVATE plain entries
                cat_mp3 = b"ID3\x04\x00catalog-mp3"
                priv_mp3 = b"ID3\x04\x00private-mp3"
                await cache_svc.store_cached_audio(
                    target=ResolvedCacheTarget("CATALOG", None, catalog_book, catalog_page, None, True),
                    normalized_text=canonical_tts_text("Xin chào bạn nhỏ"),
                    voice_id=DEFAULT_LOCAL_VOICE_ID,
                    model_version=LOCAL_TTS_MODEL_VERSION,
                    speed=1.0,
                    audio_bytes=cat_mp3,
                    source_content_type="audio/mpeg",
                    duration_seconds=1.2,
                    word_timings_json=[
                        {"index": 0, "start": 0.0, "end": 0.3},
                        {"index": 1, "start": 0.3, "end": 0.6},
                        {"index": 2, "start": 0.6, "end": 0.9},
                        {"index": 3, "start": 0.9, "end": 1.2},
                    ],
                )
                phonics_steps = [{"id": "step_1", "spoken_text": "một", "pause_after_ms": 300}]
                phonics_key, _ = canonical_phonics_key(phonics_steps)
                await cache_svc.store_cached_audio(
                    target=ResolvedCacheTarget("COACHING", None, None, None, None, True),
                    normalized_text=phonics_key,
                    voice_id=DEFAULT_LOCAL_VOICE_ID,
                    model_version=LOCAL_TTS_MODEL_VERSION,
                    speed=1.0,
                    audio_bytes=cat_mp3,
                    source_content_type="audio/mpeg",
                    duration_seconds=0.5,
                    word_timings_json=[{"id": "step_1", "index": 0, "start": 0.0, "end": 0.5}],
                )
                await cache_svc.store_cached_audio(
                    target=ResolvedCacheTarget("PRIVATE", parent_a, private_book, private_page, None, True),
                    normalized_text=canonical_tts_text("Trang sách của gia đình A"),
                    voice_id=DEFAULT_LOCAL_VOICE_ID,
                    model_version=LOCAL_TTS_MODEL_VERSION,
                    speed=1.0,
                    audio_bytes=priv_mp3,
                    source_content_type="audio/mpeg",
                )

                # Local voice worker is COMPLETELY OFFLINE
                offline_local = MagicMock()
                offline_local.synthesize = AsyncMock(
                    side_effect=LocalVoiceTechnicalError(status_code=503, code="LOCAL_VOICE_UNAVAILABLE")
                )
                offline_local.synthesize_timed = AsyncMock(
                    side_effect=LocalVoiceTechnicalError(status_code=503, code="LOCAL_VOICE_UNAVAILABLE")
                )
                offline_local.synthesize_phonics = AsyncMock(
                    side_effect=LocalVoiceTechnicalError(status_code=503, code="LOCAL_VOICE_UNAVAILABLE")
                )
                orch = VoiceOrchestrator(local_provider=offline_local)

                def _make_svc(db_arg):
                    svc = TtsAudioCacheService(db_arg)
                    svc.repo = repo  # type: ignore[assignment]
                    return svc

                current_actor = {"id": parent_a}

                async def _override_actor():
                    return current_actor["id"]

                async def _override_db():
                    yield fake_db

                app.dependency_overrides[require_active_profile_id] = _override_actor
                app.dependency_overrides[get_db] = _override_db

                with (
                    patch("app.api.routes.voice.get_voice_orchestrator", return_value=orch),
                    patch("app.api.routes.voice_studio.get_voice_orchestrator", return_value=orch),
                    patch("app.services.voice_orchestrator.TtsAudioCacheService", side_effect=_make_svc),
                ):
                    client = TestClient(app)

                    # 1. CATALOG hit when local worker offline
                    r1 = client.post(
                        "/voice/text-to-speech",
                        json={
                            "text": "Xin chào bạn nhỏ",
                            "voice_id": DEFAULT_LOCAL_VOICE_ID,
                            "book_id": str(catalog_book),
                            "page_id": str(catalog_page),
                        },
                    )
                    self.assertEqual(r1.status_code, 200, r1.text)
                    self.assertEqual(r1.headers.get("X-TTS-Cache"), "HIT")
                    self.assertEqual(r1.headers.get("X-TTS-Provider"), "precomputed_cache")
                    self.assertEqual(r1.headers.get("Cache-Control"), "no-store")
                    self.assertEqual(r1.content, cat_mp3)

                    # 2. CATALOG timed hit when local worker offline
                    r2 = client.post(
                        "/voice/text-to-speech/timed",
                        json={
                            "words": ["Xin", "chào", "bạn", "nhỏ"],
                            "voice_id": DEFAULT_LOCAL_VOICE_ID,
                            "book_id": str(catalog_book),
                            "page_id": str(catalog_page),
                        },
                    )
                    self.assertEqual(r2.status_code, 200, r2.text)
                    self.assertEqual(r2.headers.get("X-TTS-Cache"), "HIT")
                    self.assertEqual(r2.headers.get("X-TTS-Provider"), "precomputed_cache")
                    self.assertEqual(r2.json()["provider"], "precomputed_cache")
                    self.assertEqual(len(r2.json()["words"]), 4)

                    # 3. COACHING phonics hit when local worker offline
                    r3 = client.post(
                        "/voice/text-to-speech/phonics",
                        json={
                            "steps": phonics_steps,
                            "voice_id": DEFAULT_LOCAL_VOICE_ID,
                            "cache_scope": "COACHING",
                        },
                    )
                    self.assertEqual(r3.status_code, 200, r3.text)
                    self.assertEqual(r3.headers.get("X-TTS-Cache"), "HIT")
                    self.assertEqual(r3.json()["provider"], "precomputed_cache")

                    # 4. PRIVATE hit for owner parent_a -> must stay Cache-Control: private, no-store
                    r4 = client.post(
                        "/voice/text-to-speech",
                        json={
                            "text": "Trang sách của gia đình A",
                            "voice_id": DEFAULT_LOCAL_VOICE_ID,
                            "book_id": str(private_book),
                            "page_id": str(private_page),
                        },
                    )
                    self.assertEqual(r4.status_code, 200, r4.text)
                    self.assertEqual(r4.headers.get("X-TTS-Cache"), "HIT")
                    self.assertEqual(r4.headers.get("Cache-Control"), "private, no-store")
                    self.assertEqual(r4.content, priv_mp3)

                    # 5. Cross-family parent_b accessing parent_a PRIVATE book -> uniform 404
                    current_actor["id"] = parent_b
                    r5 = client.post(
                        "/voice/text-to-speech",
                        json={
                            "text": "Trang sách của gia đình A",
                            "voice_id": DEFAULT_LOCAL_VOICE_ID,
                            "book_id": str(private_book),
                            "page_id": str(private_page),
                        },
                    )
                    self.assertEqual(r5.status_code, 404)

                    # 6. Unscoped child utterance -> NEVER cached globally, hits offline worker -> 503
                    r6 = client.post(
                        "/voice/text-to-speech",
                        json={
                            "text": "Con đọc thử câu riêng tư",
                            "voice_id": DEFAULT_LOCAL_VOICE_ID,
                        },
                    )
                    self.assertEqual(r6.status_code, 503)

    async def test_tts_cache_lru_eviction_and_daily_egress_cap(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            repo = _InMemoryTtsRepo()
            fake_db = MagicMock(spec=AsyncSession)
            fake_db.commit = AsyncMock()
            fake_db.rollback = AsyncMock()
            svc = TtsAudioCacheService(fake_db)
            svc.repo = repo  # type: ignore[assignment]

            # Minimum max_bytes in get_tts_cache_max_bytes is 1024
            with patch.dict(
                os.environ,
                {
                    "VIREAD_LOCAL_STORAGE_DIR": tmpdir,
                    "VIREAD_TTS_CACHE_MAX_BYTES": "1024",
                    "VIREAD_TTS_CACHE_DAILY_EGRESS_LIMIT_BYTES": "900",
                },
                clear=False,
            ):
                t0 = datetime.now(timezone.utc) - timedelta(minutes=10)
                t1 = datetime.now(timezone.utc) - timedelta(minutes=5)
                target = ResolvedCacheTarget("COACHING", None, None, None, None, True)
                p1 = b"ID3" + b"a" * 597  # 600 B
                p2 = b"ID3" + b"b" * 597  # 600 B -> total 1200 > 1024 -> evicts p1

                ok1 = await svc.store_cached_audio(
                    target=target,
                    normalized_text="câu một",
                    voice_id=DEFAULT_LOCAL_VOICE_ID,
                    model_version=LOCAL_TTS_MODEL_VERSION,
                    speed=1.0,
                    audio_bytes=p1,
                    source_content_type="audio/mpeg",
                )
                self.assertTrue(ok1)
                first_id = next(iter(repo.entries.keys()))
                repo.entries[first_id].LastAccessedAt = t0
                repo.entries[first_id].CreatedAt = t0

                ok2 = await svc.store_cached_audio(
                    target=target,
                    normalized_text="câu hai",
                    voice_id=DEFAULT_LOCAL_VOICE_ID,
                    model_version=LOCAL_TTS_MODEL_VERSION,
                    speed=1.0,
                    audio_bytes=p2,
                    source_content_type="audio/mpeg",
                )
                self.assertTrue(ok2)
                self.assertEqual(repo.entries[first_id].Status, "DELETED")
                self.assertLessEqual(await repo.total_active_bytes(), 1024)

                # Serve hit #1 (600 B <= 900 B daily limit) -> OK
                hit1 = await svc.lookup_cached_audio(
                    target=target,
                    normalized_text="câu hai",
                    voice_id=DEFAULT_LOCAL_VOICE_ID,
                )
                self.assertIsNotNone(hit1)
                # Hit #2 would reach 1200 > 900 -> blocked cleanly by daily egress cap
                hit2 = await svc.lookup_cached_audio(
                    target=target,
                    normalized_text="câu hai",
                    voice_id=DEFAULT_LOCAL_VOICE_ID,
                )
                self.assertIsNone(hit2)
                summary = await svc.get_summary()
                self.assertTrue(summary["quota_exhausted"])

    async def test_tts_cache_invalidation_and_soft_delete_hook(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            repo = _InMemoryTtsRepo()
            fake_db = MagicMock(spec=AsyncSession)
            fake_db.commit = AsyncMock()
            fake_db.rollback = AsyncMock()
            svc = TtsAudioCacheService(fake_db)
            svc.repo = repo  # type: ignore[assignment]

            book_id = uuid4()
            page_id = uuid4()
            with patch.dict(os.environ, {"VIREAD_LOCAL_STORAGE_DIR": tmpdir}, clear=False):
                await svc.store_cached_audio(
                    target=ResolvedCacheTarget("CATALOG", None, book_id, page_id, None, True),
                    normalized_text="Trang một",
                    voice_id=DEFAULT_LOCAL_VOICE_ID,
                    model_version=LOCAL_TTS_MODEL_VERSION,
                    speed=1.0,
                    audio_bytes=b"ID3\x03abc",
                    source_content_type="audio/mpeg",
                )
                self.assertEqual(await repo.total_active_bytes(), 7)
                stored_path = next(iter(repo.entries.values())).StoragePath
                full_file = Path(tmpdir) / "viread-tts-cache" / stored_path
                self.assertTrue(full_file.is_file())

                removed = await svc.invalidate_target(page_id=page_id, commit=True)
                self.assertEqual(removed, 1)
                self.assertEqual(await repo.total_active_bytes(), 0)
                self.assertFalse(full_file.is_file())

        # AdminBookService.soft_delete calls invalidate_tts_cache_best_effort
        admin_repo = MagicMock()
        admin_repo.db = MagicMock()
        admin_repo.role = AsyncMock(return_value="admin")
        admin_repo.soft_delete = AsyncMock(return_value=True)
        with patch(
            "app.services.admin_book_service.invalidate_tts_cache_best_effort",
            new=AsyncMock(return_value=1),
        ) as inv_mock:
            res = await AdminBookService(admin_repo).soft_delete(uuid4(), book_id)
            self.assertTrue(res.is_deleted)
            inv_mock.assert_awaited_once_with(admin_repo.db, book_id=book_id, commit=True)

    async def test_admin_health_15_plus_subsystems_and_audio_cache_summary(self) -> None:
        self.assertEqual(derive_operational_state(status="HEALTHY"), "Healthy")
        self.assertEqual(derive_operational_state(status="HEALTHY", queue_depth=3), "Queued")
        self.assertEqual(derive_operational_state(status="DEGRADED", detail_status="disabled"), "Offline")
        self.assertEqual(derive_operational_state(status="DEGRADED", quota_exhausted=True), "Quota exhausted")

        fake_repo = MagicMock()
        fake_repo.db = None
        fake_repo.probe_database = AsyncMock(return_value=True)
        fake_repo.worker_queue_metrics = AsyncMock(
            return_value={
                "reading_reminder": {
                    "queue_depth": 4,
                    "oldest_pending_job_age_seconds": 12.0,
                    "last_success_at": None,
                    "last_error": None,
                }
            }
        )
        fake_voice = MagicMock()
        fake_voice.get_status = AsyncMock(
            return_value={
                "local": {
                    "url_configured": False,
                    "tts_ready": False,
                    "stt_ready": False,
                    "tts_error_code": "LOCAL_VOICE_UNCONFIGURED",
                    "stt_error_code": "LOCAL_VOICE_UNCONFIGURED",
                },
                "google": {"stt_configured": False, "tts_configured": False},
            }
        )
        cache_summary = {
            "entry_count": 12,
            "storage_used_bytes": 102400,
            "storage_quota_bytes": 157286400,
            "daily_egress_bytes": 4096,
            "daily_egress_limit_bytes": 314572800,
            "cache_hit_ratio": 0.85,
            "quota_exhausted": False,
        }
        with (
            patch("app.api.routes.system.TtsAudioCacheService.get_summary", new=AsyncMock(return_value=cache_summary)),
            patch("app.api.routes.system.collect_ocr_health", return_value=[]),
            patch(
                "app.api.routes.system.probe_storage_health",
                new=AsyncMock(
                    return_value={
                        "id": "storage",
                        "label": "Supabase Storage",
                        "status": "HEALTHY",
                        "detail_status": "healthy",
                        "safe_message": "OK",
                    }
                ),
            ),
        ):
            report = await AdminSystemService(fake_repo, voice_provider=fake_voice).health(workers={})

        self.assertGreaterEqual(len(report.services), 15)
        ids = {s.id for s in report.services}
        self.assertIn("tts_audio_cache", ids)
        self.assertIn("ocr_worker", ids)
        self.assertIn("reading_reminder", ids)
        self.assertIsInstance(report.audio_cache, AdminAudioCacheSummaryRead)
        self.assertEqual(report.audio_cache.entry_count, 12)
        self.assertEqual(report.audio_cache.cache_hit_ratio, 0.85)
        reminder = next(s for s in report.services if s.id == "reading_reminder")
        self.assertEqual(reminder.operational_state, "Queued")
        for s in report.services:
            self.assertIn(
                s.operational_state,
                {
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
                },
            )

    async def test_precompute_script_dry_run_and_idempotency(self) -> None:
        from scripts import precompute_book_tts_cache as precompute

        book_id = uuid4()
        page_id = uuid4()
        rev_id = uuid4()
        sample_pages = [
            {
                "scope": "CATALOG",
                "owner_parent_id": None,
                "book_id": book_id,
                "page_id": page_id,
                "page_revision_id": rev_id,
                "verified_text": "Con mèo",
                "text": "Con mèo",
                "tokens": ["con", "mèo"],
            }
        ]
        with (
            patch.object(precompute, "_current_cache_bytes", new=AsyncMock(return_value=0)),
            patch.object(precompute, "_collect_page_targets", new=AsyncMock(return_value=sample_pages)),
            patch.object(precompute, "_load_existing_cache_keys", new=AsyncMock(return_value=set())),
        ):
            stats = await precompute.run_precompute(
                scope="catalog",
                dry_run=True,
                include_words=True,
                include_coaching=True,
            )
            # 1 page + 2 unique tokens + coaching phrases
            self.assertEqual(stats["planned"], 3 + len(precompute.COACHING_PHRASES))
            self.assertEqual(stats["synthesized"], 0)
            self.assertEqual(stats["errors"], 0)

        pre_existing = {
            ("CATALOG", None, canonical_tts_sha256("Con mèo")),
            ("CATALOG", None, canonical_tts_sha256("con")),
            ("CATALOG", None, canonical_tts_sha256("mèo")),
        }
        with (
            patch.object(precompute, "_current_cache_bytes", new=AsyncMock(return_value=0)),
            patch.object(precompute, "_collect_page_targets", new=AsyncMock(return_value=sample_pages)),
            patch.object(precompute, "_load_existing_cache_keys", new=AsyncMock(return_value=pre_existing)),
        ):
            stats_hit = await precompute.run_precompute(
                scope="catalog",
                dry_run=False,
                include_words=True,
                include_coaching=False,
            )
            self.assertEqual(stats_hit["cached_hit"], 3)
            self.assertEqual(stats_hit["synthesized"], 0)

    async def test_tts_cache_blocks_global_pollution_and_mismatched_revision_404(self) -> None:
        from fastapi import HTTPException

        book_id = uuid4()
        page_id = uuid4()
        other_page_id = uuid4()
        rev_id = uuid4()
        other_rev_id = uuid4()
        repo = _InMemoryTtsRepo(
            books={
                book_id: {
                    "book_id": book_id,
                    "visibility_scope": "CATALOG",
                    "owner_parent_id": None,
                    "lifecycle_status": "ACTIVE",
                    "moderation_status": "ACTIVE",
                    "is_deleted": False,
                }
            },
            pages={
                page_id: {
                    "page_id": page_id,
                    "book_id": book_id,
                    "page_lifecycle_status": "ACTIVE",
                    "visibility_scope": "CATALOG",
                    "owner_parent_id": None,
                    "lifecycle_status": "ACTIVE",
                    "moderation_status": "ACTIVE",
                    "is_deleted": False,
                }
            },
            revisions={
                rev_id: {
                    "revision_id": rev_id,
                    "page_id": page_id,
                    "book_id": book_id,
                    "page_lifecycle_status": "ACTIVE",
                    "visibility_scope": "CATALOG",
                    "owner_parent_id": None,
                    "lifecycle_status": "ACTIVE",
                    "moderation_status": "ACTIVE",
                    "is_deleted": False,
                },
                other_rev_id: {
                    "revision_id": other_rev_id,
                    "page_id": other_page_id,
                    "book_id": book_id,
                    "page_lifecycle_status": "ACTIVE",
                    "visibility_scope": "CATALOG",
                    "owner_parent_id": None,
                    "lifecycle_status": "ACTIVE",
                    "moderation_status": "ACTIVE",
                    "is_deleted": False,
                },
            },
            verified_texts={
                rev_id: [
                    ("Con mèo ngủ.", [("Con", "Con"), ("mèo", "mèo"), ("ngủ", "ngủ.")]),
                ]
            },
        )
        fake_db = MagicMock(spec=AsyncSession)
        fake_db.commit = AsyncMock()
        fake_db.rollback = AsyncMock()
        svc = TtsAudioCacheService(fake_db)
        svc.repo = repo  # type: ignore[assignment]

        # 1. Arbitrary text sent to CATALOG scope -> read-only (can_store_on_miss=False)
        t_bad_cat = await svc.resolve_target(
            actor_id=uuid4(),
            book_id=book_id,
            page_id=page_id,
            page_revision_id=rev_id,
            normalized_text="văn bản rác không thuộc sách",
            allow_cache_write=False,
        )
        self.assertIsNotNone(t_bad_cat)
        self.assertEqual(t_bad_cat.scope, "CATALOG")
        self.assertFalse(t_bad_cat.can_store_on_miss)

        # 2. Verified page text and verified token -> writable (can_store_on_miss=True)
        for ok_text in ("Con mèo ngủ.", "mèo", "Con mèo ngủ"):
            t_ok_cat = await svc.resolve_target(
                actor_id=uuid4(),
                book_id=book_id,
                page_id=page_id,
                page_revision_id=rev_id,
                normalized_text=ok_text,
                allow_cache_write=False,
            )
            self.assertIsNotNone(t_ok_cat)
            self.assertTrue(t_ok_cat.can_store_on_miss, ok_text)

        # 3. Orchestrator must NOT store arbitrary unverified text on CATALOG miss
        local_mock = MagicMock()
        local_mock.synthesize = AsyncMock(
            return_value=LocalSynthesizedAudio(
                content=b"RIFF\x00\x00\x00\x00WAVEfmt ",
                content_type="audio/wav",
                resolved_voice_id=DEFAULT_LOCAL_VOICE_ID,
                region="north",
                model_version=LOCAL_TTS_MODEL_VERSION,
                provider="local",
                used_fallback_voice=False,
            )
        )
        orch = VoiceOrchestrator(local_provider=local_mock)

        def _make_svc(db_arg):
            s = TtsAudioCacheService(db_arg)
            s.repo = repo  # type: ignore[assignment]
            return s

        with patch("app.services.voice_orchestrator.TtsAudioCacheService", side_effect=_make_svc):
            await orch.synthesize(
                text="văn bản tấn công LRU",
                requested_voice_id=DEFAULT_LOCAL_VOICE_ID,
                policy=VoicePolicyContext(
                    provider_mode="local_only",
                    allow_google_tts=False,
                    actor_id=uuid4(),
                    book_id=book_id,
                    page_id=str(page_id),
                    page_revision_id=rev_id,
                ),
                db=fake_db,
            )
        self.assertEqual(len(repo.entries), 0)

        # 4. COACHING scope rejects non-allowlisted HTTP writes, accepts canonical coaching phrases
        t_bad_coach = await svc.resolve_target(
            actor_id=uuid4(),
            cache_scope="COACHING",
            normalized_text="spam phrase 12345",
            allow_cache_write=False,
        )
        self.assertIsNotNone(t_bad_coach)
        self.assertFalse(t_bad_coach.can_store_on_miss)

        t_ok_coach = await svc.resolve_target(
            actor_id=uuid4(),
            cache_scope="COACHING",
            normalized_text=ALLOWED_COACHING_PHRASES_RAW[0],
            allow_cache_write=False,
        )
        self.assertIsNotNone(t_ok_coach)
        self.assertTrue(t_ok_coach.can_store_on_miss)

        # 5. Mismatched page_revision_id (belongs to other_page_id, not page_id) -> uniform 404
        with self.assertRaises(HTTPException) as ctx:
            await svc.resolve_target(
                actor_id=uuid4(),
                book_id=book_id,
                page_id=page_id,
                page_revision_id=other_rev_id,
                normalized_text="Con mèo ngủ.",
            )
        self.assertEqual(ctx.exception.status_code, 404)

    async def test_tts_cache_releases_db_permit_before_storage_download(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            repo = _InMemoryTtsRepo()
            events: list[str] = []

            fake_db = MagicMock(spec=AsyncSession)

            async def _commit_side_effect():
                events.append("db_commit")

            fake_db.commit = AsyncMock(side_effect=_commit_side_effect)
            fake_db.rollback = AsyncMock()
            svc = TtsAudioCacheService(fake_db)
            svc.repo = repo  # type: ignore[assignment]

            target = ResolvedCacheTarget("COACHING", None, None, None, None, True)
            with patch.dict(os.environ, {"VIREAD_LOCAL_STORAGE_DIR": tmpdir}, clear=False):
                await svc.store_cached_audio(
                    target=target,
                    normalized_text="Tuyệt vời!",
                    voice_id=DEFAULT_LOCAL_VOICE_ID,
                    model_version=LOCAL_TTS_MODEL_VERSION,
                    speed=1.0,
                    audio_bytes=b"ID3\x03xyz",
                    source_content_type="audio/mpeg",
                )
                events.clear()

                def _recording_download(path, *, bucket_name):
                    events.append("storage_download")
                    return b"ID3\x03xyz"

                orig_record_hit = repo.record_hit

                async def _recording_hit(entry_id: UUID, *, byte_size: int, now=None):
                    events.append("record_hit")
                    return await orig_record_hit(entry_id, byte_size=byte_size, now=now)

                repo.record_hit = _recording_hit  # type: ignore[method-assign]
                with patch("app.services.tts_audio_cache_service.download_object", side_effect=_recording_download):
                    hit = await svc.lookup_cached_audio(
                        target=target,
                        normalized_text="Tuyệt vời!",
                        voice_id=DEFAULT_LOCAL_VOICE_ID,
                    )
                self.assertIsNotNone(hit)
                self.assertEqual(events, ["db_commit", "storage_download", "record_hit", "db_commit"])

    async def test_lifecycle_retire_suspend_invalidation_and_precompute_timed_parity(self) -> None:
        from scripts import precompute_book_tts_cache as precompute

        # 1. AdminBookService.update_lifecycle(..., "RETIRED") invalidates cache
        book_id = uuid4()
        retired_row = SimpleNamespace(
            Id=book_id,
            Title="Book",
            Author="Auth",
            Language="vi",
            LifecycleStatus="RETIRED",
            VisibilityScope="CATALOG",
            OwnerParentId=None,
            IsDeleted=False,
        )
        admin_repo = MagicMock()
        admin_repo.db = MagicMock(spec=AsyncSession)
        admin_repo.role = AsyncMock(return_value="admin")
        admin_repo.get = AsyncMock(return_value=retired_row)
        admin_repo.set_lifecycle = AsyncMock(return_value=retired_row)
        with (
            patch(
                "app.services.admin_book_service.AdminBookMetadataResponse.model_validate",
                return_value=SimpleNamespace(id=book_id, lifecycle_status="RETIRED"),
            ),
            patch(
                "app.services.admin_book_service.invalidate_tts_cache_best_effort",
                new=AsyncMock(return_value=2),
            ) as inv_retire,
        ):
            res = await AdminBookService(admin_repo).update_lifecycle(uuid4(), book_id, "RETIRED")
            self.assertEqual(res.lifecycle_status, "RETIRED")
            inv_retire.assert_awaited_once_with(admin_repo.db, book_id=book_id, commit=True)

        # 2. ParentPrivateBookService.admin_suspend_book invalidates cache
        susp_book = SimpleNamespace(
            Id=book_id,
            VisibilityScope="PARENT_PRIVATE",
            IsDeleted=False,
            ModerationStatus="ACTIVE",
        )
        audit_obj = SimpleNamespace(Id=uuid4())
        private_db = MagicMock(spec=AsyncSession)
        private_repo = MagicMock()
        private_repo.role = AsyncMock(return_value="admin")
        private_repo.get_private_book = AsyncMock(return_value=susp_book)
        private_repo.list_submissions_for_book = AsyncMock(return_value=[])
        private_repo.suspend_open_moderation_requests_for_book = AsyncMock()
        private_repo.add_audit_log = AsyncMock(return_value=audit_obj)
        private_repo.commit = AsyncMock()
        svc_priv = ParentPrivateBookService(private_db)
        svc_priv.repo = private_repo
        svc_priv._safe_revoke_flow2_contributions = AsyncMock()
        payload = SimpleNamespace(reason="policy_violation")
        with (
            patch("app.services.parent_private_book_service.is_remote_ocr_mode", return_value=False),
            patch(
                "app.services.parent_private_book_service.invalidate_tts_cache_best_effort",
                new=AsyncMock(return_value=1),
            ) as inv_suspend,
        ):
            susp_res = await svc_priv.admin_suspend_book(uuid4(), book_id, payload)
            self.assertEqual(susp_res["book_id"], str(book_id))
            inv_suspend.assert_awaited_once_with(private_db, book_id=book_id, commit=True)

        # 3. precompute_book_tts_cache keys timed page synthesis on splitSpeechText(VerifiedText)
        #    preserving capitalization & punctuation, while single words use normalized tokens.
        sample_pages = [
            {
                "scope": "CATALOG",
                "owner_parent_id": None,
                "book_id": book_id,
                "page_id": uuid4(),
                "page_revision_id": uuid4(),
                "verified_text": "Xin, chào bé!\nMèo ngủ.",
                "text": "Xin, chào bé! Mèo ngủ.",
                "tokens": ["xin", "chào", "bé", "mèo", "ngủ"],
            }
        ]
        expected_timed_text = canonical_tts_text("Xin, chào bé! Mèo ngủ.")
        expected_timed_key = ("CATALOG", None, canonical_tts_sha256(expected_timed_text))
        with (
            patch.object(precompute, "_current_cache_bytes", new=AsyncMock(return_value=0)),
            patch.object(precompute, "_collect_page_targets", new=AsyncMock(return_value=sample_pages)),
            patch.object(precompute, "_load_existing_cache_keys", new=AsyncMock(return_value={expected_timed_key})),
        ):
            stats = await precompute.run_precompute(
                scope="catalog",
                dry_run=True,
                include_words=False,
                include_coaching=False,
            )
        self.assertEqual(stats["planned"], 1)
        self.assertEqual(stats["cached_hit"], 1)
        self.assertEqual(
            precompute.split_speech_text_chunks("Xin, chào bé!\nMèo ngủ."),
            [["Xin,", "chào", "bé!", "Mèo", "ngủ."]],
        )

    async def test_sqlalchemy_real_queries_word_index_and_speed_fallback(self) -> None:
        from sqlalchemy.dialects import postgresql
        from app.repositories.tts_audio_cache_repository import TtsAudioCacheRepository

        compiled_sqls: list[str] = []
        rev_id = uuid4()
        book_id = uuid4()
        page_id = uuid4()

        class _FakeResult:
            def __init__(self, rows):
                self._rows = rows

            def all(self):
                return self._rows

        call_idx = {"n": 0}

        async def _recording_execute(stmt):
            sql = str(stmt.compile(dialect=postgresql.dialect()))
            compiled_sqls.append(sql)
            call_idx["n"] += 1
            if call_idx["n"] == 1:
                return _FakeResult([SimpleNamespace(Id=rev_id, VerifiedText="Con mèo ngủ.")])
            return _FakeResult(
                [
                    SimpleNamespace(PageRevisionId=rev_id, NormalizedText="con", Text="Con"),
                    SimpleNamespace(PageRevisionId=rev_id, NormalizedText="mèo", Text="mèo"),
                ]
            )

        async def _recording_scalar(stmt):
            sql = str(stmt.compile(dialect=postgresql.dialect()))
            compiled_sqls.append(sql)
            return None

        fake_db = MagicMock(spec=AsyncSession)
        fake_db.execute = AsyncMock(side_effect=_recording_execute)
        fake_db.scalar = AsyncMock(side_effect=_recording_scalar)

        repo = TtsAudioCacheRepository(fake_db)
        rows = await repo.get_verified_catalog_texts(
            book_id=book_id,
            page_id=page_id,
            page_revision_id=rev_id,
        )
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0][0], "Con mèo ngủ.")
        self.assertEqual(len(rows[0][1]), 2)
        self.assertTrue(
            any("pagerevisionwords.wordindex ASC" in sql for sql in compiled_sqls),
            msg=f"Expected WordIndex ASC in compiled SQL, got: {compiled_sqls}",
        )
        self.assertFalse(any("wordorder" in sql.lower() for sql in compiled_sqls))

        # Verify real SQLAlchemy compilation of exact + nearest speed fallback queries
        await repo.get_active_entry(
            scope="CATALOG",
            owner_parent_id=None,
            content_sha256="abc123",
            voice_id=DEFAULT_LOCAL_VOICE_ID,
            model_version=None,
            speed=0.9,
            audio_formats=["audio/mpeg"],
            allow_speed_fallback=True,
            require_word_timings=True,
        )
        self.assertTrue(
            any("abs(tts_audio_cache_entries.speed -" in sql.lower() for sql in compiled_sqls),
            msg=f"Expected ABS(speed - target) ORDER BY in compiled SQL, got: {compiled_sqls}",
        )
        self.assertTrue(
            any("word_timings_json is not null" in sql.lower() for sql in compiled_sqls),
            msg=f"Expected word_timings_json IS NOT NULL in compiled SQL, got: {compiled_sqls}",
        )

        # Also compile real SQLAlchemy queries in scripts/precompute_book_tts_cache.py
        from scripts import precompute_book_tts_cache as precompute

        precompute_sqls: list[str] = []
        precompute_params: list[dict] = []

        class _PrecomputeSession:
            async def __aenter__(self):
                return self

            async def __aexit__(self, *args):
                return False

            async def execute(self, stmt):
                compiled = stmt.compile(dialect=postgresql.dialect())
                precompute_sqls.append(str(compiled))
                precompute_params.append(dict(compiled.params))
                return _FakeResult([])

        with patch.object(precompute, "AsyncSessionLocal", return_value=_PrecomputeSession()):
            await precompute._load_existing_cache_keys(voice_id=DEFAULT_LOCAL_VOICE_ID, speed=0.9)
        self.assertEqual(len(precompute_sqls), 1)
        self.assertIn(Decimal("0.90"), precompute_params[0].values())

    async def test_catalog_cache_hit_skips_allowlist_queries_while_private_keeps_isolation(self) -> None:
        from fastapi import HTTPException

        parent_a = uuid4()
        parent_b = uuid4()
        catalog_book = uuid4()
        catalog_page = uuid4()
        private_book = uuid4()
        private_page = uuid4()

        with tempfile.TemporaryDirectory() as tmpdir:
            repo = _InMemoryTtsRepo(
                books={
                    catalog_book: {
                        "book_id": catalog_book,
                        "visibility_scope": "CATALOG",
                        "owner_parent_id": None,
                        "lifecycle_status": "ACTIVE",
                        "moderation_status": "ACTIVE",
                        "is_deleted": False,
                    },
                    private_book: {
                        "book_id": private_book,
                        "visibility_scope": "PARENT_PRIVATE",
                        "owner_parent_id": parent_a,
                        "lifecycle_status": "ACTIVE",
                        "moderation_status": "ACTIVE",
                        "is_deleted": False,
                    },
                },
                pages={
                    catalog_page: {
                        "page_id": catalog_page,
                        "book_id": catalog_book,
                        "page_lifecycle_status": "ACTIVE",
                        "visibility_scope": "CATALOG",
                        "owner_parent_id": None,
                        "lifecycle_status": "ACTIVE",
                        "moderation_status": "ACTIVE",
                        "is_deleted": False,
                    },
                    private_page: {
                        "page_id": private_page,
                        "book_id": private_book,
                        "page_lifecycle_status": "ACTIVE",
                        "visibility_scope": "PARENT_PRIVATE",
                        "owner_parent_id": parent_a,
                        "lifecycle_status": "ACTIVE",
                        "moderation_status": "ACTIVE",
                        "is_deleted": False,
                    },
                },
                verified_texts={catalog_page: [("mèo", [("mèo", "mèo")])]},
            )
            allowlist_calls = {"count": 0}
            orig_get_verified = repo.get_verified_catalog_texts

            async def _counting_verified(**kwargs):
                allowlist_calls["count"] += 1
                return await orig_get_verified(**kwargs)

            repo.get_verified_catalog_texts = _counting_verified  # type: ignore[method-assign]

            with patch.dict(os.environ, {"VIREAD_LOCAL_STORAGE_DIR": tmpdir}, clear=False):
                fake_db = MagicMock(spec=AsyncSession)
                fake_db.commit = AsyncMock()
                fake_db.rollback = AsyncMock()
                seed_svc = TtsAudioCacheService(fake_db)
                seed_svc.repo = repo  # type: ignore[assignment]
                await seed_svc.store_cached_audio(
                    target=ResolvedCacheTarget("CATALOG", None, catalog_book, catalog_page, None, True),
                    normalized_text="mèo",
                    voice_id=DEFAULT_LOCAL_VOICE_ID,
                    model_version=LOCAL_TTS_MODEL_VERSION,
                    speed=1.0,
                    audio_bytes=b"ID3\x04\x00cat-word",
                    source_content_type="audio/mpeg",
                )
                self.assertEqual(allowlist_calls["count"], 0)

                def _make_svc(db_arg):
                    s = TtsAudioCacheService(db_arg)
                    s.repo = repo  # type: ignore[assignment]
                    return s

                offline_local = MagicMock()
                offline_local.synthesize = AsyncMock(
                    side_effect=LocalVoiceTechnicalError(status_code=503, code="LOCAL_VOICE_UNAVAILABLE")
                )
                orch = VoiceOrchestrator(local_provider=offline_local)
                with patch("app.services.voice_orchestrator.TtsAudioCacheService", side_effect=_make_svc):
                    # Cache HIT -> zero allowlist queries!
                    res = await orch.synthesize(
                        text="mèo",
                        requested_voice_id=DEFAULT_LOCAL_VOICE_ID,
                        speed=1.0,
                        policy=VoicePolicyContext(
                            actor_id=parent_a,
                            book_id=catalog_book,
                            page_id=str(catalog_page),
                        ),
                        db=fake_db,
                    )
                    self.assertTrue(res.cache_hit)
                    self.assertEqual(allowlist_calls["count"], 0)

                    # Cross-family PRIVATE book -> still 404 before lookup!
                    with self.assertRaises(HTTPException) as ctx:
                        await orch.synthesize(
                            text="mèo",
                            requested_voice_id=DEFAULT_LOCAL_VOICE_ID,
                            speed=1.0,
                            policy=VoicePolicyContext(
                                actor_id=parent_b,
                                book_id=private_book,
                                page_id=str(private_page),
                            ),
                            db=fake_db,
                        )
                    self.assertEqual(ctx.exception.status_code, 404)

    async def test_tts_cache_speed_fallback_headers_and_json(self) -> None:
        parent_id = uuid4()
        catalog_book = uuid4()
        catalog_page = uuid4()

        with tempfile.TemporaryDirectory() as tmpdir:
            repo = _InMemoryTtsRepo(
                books={
                    catalog_book: {
                        "book_id": catalog_book,
                        "visibility_scope": "CATALOG",
                        "owner_parent_id": None,
                        "lifecycle_status": "ACTIVE",
                        "moderation_status": "ACTIVE",
                        "is_deleted": False,
                    }
                },
                pages={
                    catalog_page: {
                        "page_id": catalog_page,
                        "book_id": catalog_book,
                        "page_lifecycle_status": "ACTIVE",
                        "visibility_scope": "CATALOG",
                        "owner_parent_id": None,
                        "lifecycle_status": "ACTIVE",
                        "moderation_status": "ACTIVE",
                        "is_deleted": False,
                    }
                },
            )
            with patch.dict(os.environ, {"VIREAD_LOCAL_STORAGE_DIR": tmpdir}, clear=False):
                fake_db = MagicMock(spec=AsyncSession)
                fake_db.commit = AsyncMock()
                fake_db.rollback = AsyncMock()
                seed_svc = TtsAudioCacheService(fake_db)
                seed_svc.repo = repo  # type: ignore[assignment]

                # Seed word at 1.00 and timed page at 1.00 only
                await seed_svc.store_cached_audio(
                    target=ResolvedCacheTarget("CATALOG", None, catalog_book, catalog_page, None, True),
                    normalized_text="mèo",
                    voice_id=DEFAULT_LOCAL_VOICE_ID,
                    model_version=LOCAL_TTS_MODEL_VERSION,
                    speed=1.0,
                    audio_bytes=b"ID3\x04\x00word-1p00",
                    source_content_type="audio/mpeg",
                )
                await seed_svc.store_cached_audio(
                    target=ResolvedCacheTarget("CATALOG", None, catalog_book, catalog_page, None, True),
                    normalized_text="Con mèo.",
                    voice_id=DEFAULT_LOCAL_VOICE_ID,
                    model_version=LOCAL_TTS_MODEL_VERSION,
                    speed=1.0,
                    audio_bytes=b"ID3\x04\x00page-1p00",
                    source_content_type="audio/mpeg",
                    duration_seconds=1.0,
                    word_timings_json=[
                        {"index": 0, "start": 0.0, "end": 0.4},
                        {"index": 1, "start": 0.4, "end": 1.0},
                    ],
                )

                offline_local = MagicMock()
                offline_local.synthesize = AsyncMock(
                    side_effect=LocalVoiceTechnicalError(status_code=503, code="LOCAL_VOICE_UNCONFIGURED")
                )
                offline_local.synthesize_timed = AsyncMock(
                    side_effect=LocalVoiceTechnicalError(status_code=503, code="LOCAL_VOICE_UNCONFIGURED")
                )
                orch = VoiceOrchestrator(local_provider=offline_local)

                def _make_svc(db_arg):
                    s = TtsAudioCacheService(db_arg)
                    s.repo = repo  # type: ignore[assignment]
                    return s

                async def _override_actor():
                    return parent_id

                async def _override_db():
                    yield fake_db

                app.dependency_overrides[require_active_profile_id] = _override_actor
                app.dependency_overrides[get_db] = _override_db

                with (
                    patch("app.api.routes.voice.get_voice_orchestrator", return_value=orch),
                    patch("app.api.routes.voice_studio.get_voice_orchestrator", return_value=orch),
                    patch("app.services.voice_orchestrator.TtsAudioCacheService", side_effect=_make_svc),
                ):
                    client = TestClient(app)

                    # Request at 0.90 falls back to 1.00 cached clip and reports X-TTS-Scope + X-TTS-Cached-Speed
                    r_word = client.post(
                        "/voice/text-to-speech",
                        json={
                            "text": "mèo",
                            "voice_id": DEFAULT_LOCAL_VOICE_ID,
                            "speed": 0.9,
                            "book_id": str(catalog_book),
                            "page_id": str(catalog_page),
                        },
                    )
                    self.assertEqual(r_word.status_code, 200, r_word.text)
                    self.assertEqual(r_word.headers.get("X-TTS-Cache"), "HIT")
                    self.assertEqual(r_word.headers.get("X-TTS-Scope"), "CATALOG")
                    self.assertEqual(r_word.headers.get("X-TTS-Cached-Speed"), "1.00")
                    self.assertEqual(r_word.content, b"ID3\x04\x00word-1p00")

                    r_timed = client.post(
                        "/voice/text-to-speech/timed",
                        json={
                            "words": ["Con", "mèo."],
                            "voice_id": DEFAULT_LOCAL_VOICE_ID,
                            "speed": 0.9,
                            "book_id": str(catalog_book),
                            "page_id": str(catalog_page),
                        },
                    )
                    self.assertEqual(r_timed.status_code, 200, r_timed.text)
                    self.assertEqual(r_timed.headers.get("X-TTS-Cache"), "HIT")
                    self.assertEqual(r_timed.headers.get("X-TTS-Scope"), "CATALOG")
                    self.assertEqual(r_timed.headers.get("X-TTS-Cached-Speed"), "1.00")
                    self.assertEqual(r_timed.json()["cached_speed"], 1.0)

                    # Now add an entry at 0.90 -> speed 0.90 prefers exact match, 0.75 picks nearest 0.90, 1.15 picks nearest 1.00
                    await seed_svc.store_cached_audio(
                        target=ResolvedCacheTarget("CATALOG", None, catalog_book, catalog_page, None, True),
                        normalized_text="mèo",
                        voice_id=DEFAULT_LOCAL_VOICE_ID,
                        model_version=LOCAL_TTS_MODEL_VERSION,
                        speed=0.9,
                        audio_bytes=b"ID3\x04\x00word-0p90",
                        source_content_type="audio/mpeg",
                    )
                    r_exact = client.post(
                        "/voice/text-to-speech",
                        json={
                            "text": "mèo",
                            "voice_id": DEFAULT_LOCAL_VOICE_ID,
                            "speed": 0.9,
                            "book_id": str(catalog_book),
                            "page_id": str(catalog_page),
                        },
                    )
                    self.assertEqual(r_exact.headers.get("X-TTS-Cached-Speed"), "0.90")
                    self.assertEqual(r_exact.content, b"ID3\x04\x00word-0p90")

                    r_slow = client.post(
                        "/voice/text-to-speech",
                        json={
                            "text": "mèo",
                            "voice_id": DEFAULT_LOCAL_VOICE_ID,
                            "speed": 0.75,
                            "book_id": str(catalog_book),
                            "page_id": str(catalog_page),
                        },
                    )
                    self.assertEqual(r_slow.headers.get("X-TTS-Cached-Speed"), "0.90")

                    r_fast = client.post(
                        "/voice/text-to-speech",
                        json={
                            "text": "mèo",
                            "voice_id": DEFAULT_LOCAL_VOICE_ID,
                            "speed": 1.15,
                            "book_id": str(catalog_book),
                            "page_id": str(catalog_page),
                        },
                    )
                    self.assertEqual(r_fast.headers.get("X-TTS-Cached-Speed"), "1.00")

    async def test_tts_cache_download_transient_error_preserves_active_entry_404_marks_stale(self) -> None:
        from fastapi import HTTPException

        with tempfile.TemporaryDirectory() as tmpdir:
            repo = _InMemoryTtsRepo()
            fake_db = MagicMock(spec=AsyncSession)
            fake_db.commit = AsyncMock()
            fake_db.rollback = AsyncMock()
            svc = TtsAudioCacheService(fake_db)
            svc.repo = repo  # type: ignore[assignment]
            target = ResolvedCacheTarget("COACHING", None, None, None, None, True)

            with patch.dict(os.environ, {"VIREAD_LOCAL_STORAGE_DIR": tmpdir}, clear=False):
                await svc.store_cached_audio(
                    target=target,
                    normalized_text="Cô đọc mẫu cho con nhé.",
                    voice_id=DEFAULT_LOCAL_VOICE_ID,
                    model_version=LOCAL_TTS_MODEL_VERSION,
                    speed=0.9,
                    audio_bytes=b"ID3\x04\x00coach-mp3",
                    source_content_type="audio/mpeg",
                )
                entry_id = next(iter(repo.entries.keys()))

                # 1. Transient network timeout -> MUST NOT mark STALE
                with patch(
                    "app.services.tts_audio_cache_service.download_object",
                    side_effect=TimeoutError("transient network blip"),
                ):
                    hit_timeout = await svc.lookup_cached_audio(
                        target=target,
                        normalized_text="Cô đọc mẫu cho con nhé.",
                        voice_id=DEFAULT_LOCAL_VOICE_ID,
                        speed=0.9,
                    )
                self.assertIsNone(hit_timeout)
                self.assertEqual(repo.entries[entry_id].Status, "ACTIVE")

                # 2. Wrapped 503 with 502 upstream cause -> MUST NOT mark STALE
                upstream_502 = RuntimeError("502 Bad Gateway")
                upstream_502.status_code = 502  # type: ignore[attr-defined]
                wrapped_502 = HTTPException(status_code=503, detail="storage error")
                wrapped_502.__cause__ = upstream_502
                with patch(
                    "app.services.tts_audio_cache_service.download_object",
                    side_effect=wrapped_502,
                ):
                    hit_502 = await svc.lookup_cached_audio(
                        target=target,
                        normalized_text="Cô đọc mẫu cho con nhé.",
                        voice_id=DEFAULT_LOCAL_VOICE_ID,
                        speed=0.9,
                    )
                self.assertIsNone(hit_502)
                self.assertEqual(repo.entries[entry_id].Status, "ACTIVE")

                # 3. Real 404 wrapped in storage_service HTTPException(503) -> MUST mark STALE
                upstream_404 = RuntimeError({"statusCode": 404, "error": "not_found", "message": "Object not found"})
                wrapped_404 = HTTPException(status_code=503, detail="storage error")
                wrapped_404.__cause__ = upstream_404
                with patch(
                    "app.services.tts_audio_cache_service.download_object",
                    side_effect=wrapped_404,
                ):
                    hit_404 = await svc.lookup_cached_audio(
                        target=target,
                        normalized_text="Cô đọc mẫu cho con nhé.",
                        voice_id=DEFAULT_LOCAL_VOICE_ID,
                        speed=0.9,
                    )
                self.assertIsNone(hit_404)
                self.assertEqual(repo.entries[entry_id].Status, "STALE")

    def test_cors_headers_on_unhandled_500_and_exposed_tts_headers(self) -> None:
        from app.database.config import CORS_ALLOWED_ORIGINS

        allowed_origin = CORS_ALLOWED_ORIGINS[0]

        async def _override_actor():
            return uuid4()

        async def _override_db():
            yield MagicMock(spec=AsyncSession)

        boom_orch = MagicMock()
        boom_orch.synthesize = AsyncMock(side_effect=RuntimeError("unexpected crash"))

        app.dependency_overrides[require_active_profile_id] = _override_actor
        app.dependency_overrides[get_db] = _override_db

        with patch("app.api.routes.voice.get_voice_orchestrator", return_value=boom_orch):
            client = TestClient(app, raise_server_exceptions=False)
            r_allowed = client.post(
                "/voice/text-to-speech",
                headers={"Origin": allowed_origin},
                json={"text": "xin chào"},
            )
            self.assertEqual(r_allowed.status_code, 500)
            self.assertEqual(r_allowed.headers.get("Access-Control-Allow-Origin"), allowed_origin)
            self.assertEqual(r_allowed.headers.get("Vary"), "Origin")

            r_disallowed = client.post(
                "/voice/text-to-speech",
                headers={"Origin": "https://evil.example.com"},
                json={"text": "xin chào"},
            )
            self.assertEqual(r_disallowed.status_code, 500)
            self.assertIsNone(r_disallowed.headers.get("Access-Control-Allow-Origin"))

        # Verify CORSMiddleware exposes the 4 TTS cache/speed headers on normal responses
        ok_orch = MagicMock()
        ok_orch.synthesize = AsyncMock(
            return_value=LocalSynthesizedAudio(
                content=b"ID3\x04\x00ok",
                content_type="audio/mpeg",
                resolved_voice_id=DEFAULT_LOCAL_VOICE_ID,
                region="north",
                model_version=LOCAL_TTS_MODEL_VERSION,
                provider="precomputed_cache",
                cache_hit=True,
                cache_scope="CATALOG",
                cached_speed=1.0,
            )
        )
        with patch("app.api.routes.voice.get_voice_orchestrator", return_value=ok_orch):
            client = TestClient(app)
            r_ok = client.post(
                "/voice/text-to-speech",
                headers={"Origin": allowed_origin},
                json={"text": "xin chào"},
            )
            self.assertEqual(r_ok.status_code, 200)
            exposed = r_ok.headers.get("Access-Control-Expose-Headers", "")
            for h in ("X-TTS-Cache", "X-TTS-Provider", "X-TTS-Scope", "X-TTS-Cached-Speed"):
                self.assertIn(h, exposed)
            self.assertEqual(r_ok.headers.get("X-TTS-Scope"), "CATALOG")
            self.assertEqual(r_ok.headers.get("X-TTS-Cached-Speed"), "1.00")

        # IntegrityError (DBAPIError) runs inside CORSMiddleware and must NOT duplicate Vary: Origin
        from sqlalchemy.exc import IntegrityError

        db_err_orch = MagicMock()
        db_err_orch.synthesize = AsyncMock(
            side_effect=IntegrityError("INSERT ...", {}, Exception("duplicate key"))
        )
        with patch("app.api.routes.voice.get_voice_orchestrator", return_value=db_err_orch):
            client = TestClient(app, raise_server_exceptions=False)
            r_integrity = client.post(
                "/voice/text-to-speech",
                headers={"Origin": allowed_origin},
                json={"text": "xin chào"},
            )
            self.assertEqual(r_integrity.status_code, 500)
            self.assertEqual(r_integrity.headers.get("Access-Control-Allow-Origin"), allowed_origin)
            self.assertEqual(r_integrity.headers.get("Vary"), "Origin")

    async def test_timed_speed_fallback_skips_timingless_entry_and_storage_api_404_marks_stale(self) -> None:
        from fastapi import HTTPException
        from scripts import precompute_book_tts_cache as precompute

        parent_id = uuid4()
        catalog_book = uuid4()
        catalog_page = uuid4()

        with tempfile.TemporaryDirectory() as tmpdir:
            repo = _InMemoryTtsRepo(
                books={
                    catalog_book: {
                        "book_id": catalog_book,
                        "visibility_scope": "CATALOG",
                        "owner_parent_id": None,
                        "lifecycle_status": "ACTIVE",
                        "moderation_status": "ACTIVE",
                        "is_deleted": False,
                    }
                },
                pages={
                    catalog_page: {
                        "page_id": catalog_page,
                        "book_id": catalog_book,
                        "page_lifecycle_status": "ACTIVE",
                        "visibility_scope": "CATALOG",
                        "owner_parent_id": None,
                        "lifecycle_status": "ACTIVE",
                        "moderation_status": "ACTIVE",
                        "is_deleted": False,
                    }
                },
            )
            with patch.dict(os.environ, {"VIREAD_LOCAL_STORAGE_DIR": tmpdir}, clear=False):
                fake_db = MagicMock(spec=AsyncSession)
                fake_db.commit = AsyncMock()
                fake_db.rollback = AsyncMock()
                seed_svc = TtsAudioCacheService(fake_db)
                seed_svc.repo = repo  # type: ignore[assignment]

                # 1. Seed a plain (timing-less) entry at 1.00 and a timed entry at 0.90 for the same 1-word page "mèo"
                await seed_svc.store_cached_audio(
                    target=ResolvedCacheTarget("CATALOG", None, catalog_book, catalog_page, None, True),
                    normalized_text="mèo",
                    voice_id=DEFAULT_LOCAL_VOICE_ID,
                    model_version=LOCAL_TTS_MODEL_VERSION,
                    speed=1.0,
                    audio_bytes=b"ID3\x04\x00plain-1p00",
                    source_content_type="audio/mpeg",
                    word_timings_json=None,
                )
                await seed_svc.store_cached_audio(
                    target=ResolvedCacheTarget("CATALOG", None, catalog_book, catalog_page, None, True),
                    normalized_text="mèo",
                    voice_id=DEFAULT_LOCAL_VOICE_ID,
                    model_version=LOCAL_TTS_MODEL_VERSION,
                    speed=0.9,
                    audio_bytes=b"ID3\x04\x00timed-0p90",
                    source_content_type="audio/mpeg",
                    duration_seconds=0.6,
                    word_timings_json=[{"index": 0, "start": 0.0, "end": 0.6}],
                )

                offline_local = MagicMock()
                offline_local.synthesize_timed = AsyncMock(
                    side_effect=LocalVoiceTechnicalError(status_code=503, code="LOCAL_VOICE_UNCONFIGURED")
                )
                orch = VoiceOrchestrator(local_provider=offline_local)

                def _make_svc(db_arg):
                    s = TtsAudioCacheService(db_arg)
                    s.repo = repo  # type: ignore[assignment]
                    return s

                with patch("app.services.voice_orchestrator.TtsAudioCacheService", side_effect=_make_svc):
                    # Request /timed at speed 1.00 (and 1.10) must skip timing-less 1.00 and HIT timed 0.90!
                    for req_speed in (1.0, 1.1):
                        timed_hit = await orch.synthesize_timed(
                            words=["mèo"],
                            requested_voice_id=DEFAULT_LOCAL_VOICE_ID,
                            speed=req_speed,
                            policy=VoicePolicyContext(
                                actor_id=parent_id,
                                book_id=catalog_book,
                                page_id=str(catalog_page),
                            ),
                            db=fake_db,
                        )
                        self.assertTrue(timed_hit.cache_hit)
                        self.assertEqual(timed_hit.audio, b"ID3\x04\x00timed-0p90")
                        self.assertEqual(timed_hit.cached_speed, 0.9)

                # 2. Precompute must NOT skip a /timed page when only a timing-less entry exists at the same speed
                plain_only_key = ("CATALOG", None, canonical_tts_sha256("mèo"))
                sample_pages = [
                    {
                        "scope": "CATALOG",
                        "owner_parent_id": None,
                        "book_id": catalog_book,
                        "page_id": catalog_page,
                        "page_revision_id": uuid4(),
                        "verified_text": "mèo",
                        "text": "mèo",
                        "tokens": ["mèo"],
                    }
                ]
                with (
                    patch.object(precompute, "_current_cache_bytes", new=AsyncMock(return_value=0)),
                    patch.object(precompute, "_collect_page_targets", new=AsyncMock(return_value=sample_pages)),
                    patch.object(
                        precompute,
                        "_load_existing_cache_keys",
                        new=AsyncMock(return_value={plain_only_key: False}),
                    ),
                ):
                    stats = await precompute.run_precompute(
                        scope="catalog",
                        dry_run=True,
                        include_words=True,
                        include_coaching=False,
                    )
                # Timed item (planned #1) needs synthesis (miss); single word item (planned #2) is satisfied by plain entry (hit)
                self.assertEqual(stats["planned"], 2)
                self.assertEqual(stats["cached_hit"], 1)

                # 3. Supabase storage3 StorageApiError(message="The resource was not found", code="404", status=400) marks STALE
                class _SupabaseStorage404(Exception):
                    def __init__(self) -> None:
                        super().__init__("{'statusCode': 400, 'error': 404, 'message': The resource was not found}")
                        self.code = "404"
                        self.status = 400
                        self.message = "The resource was not found"

                wrapped = HTTPException(status_code=503, detail="Could not read the image from Supabase Storage")
                wrapped.__cause__ = _SupabaseStorage404()
                target = ResolvedCacheTarget("CATALOG", None, catalog_book, catalog_page, None, True)
                timed_entry_id = next(e.Id for e in repo.entries.values() if e.WordTimingsJson is not None)
                with patch("app.services.tts_audio_cache_service.download_object", side_effect=wrapped):
                    miss = await seed_svc.lookup_cached_audio(
                        target=target,
                        normalized_text="mèo",
                        voice_id=DEFAULT_LOCAL_VOICE_ID,
                        speed=0.9,
                        require_word_timings=True,
                    )
                self.assertIsNone(miss)
                self.assertEqual(repo.entries[timed_entry_id].Status, "STALE")


if __name__ == "__main__":
    unittest.main()
