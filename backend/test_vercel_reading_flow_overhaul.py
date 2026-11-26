"""Regression tests for Vercel + Render reading flow overhaul (Workstreams 3 & 4)."""
from __future__ import annotations

import asyncio
import base64
import io
import os
import sys
import tempfile
import time
import unittest
import wave
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock, patch
from uuid import UUID, uuid4

import httpx
from fastapi import BackgroundTasks, FastAPI
from fastapi.testclient import TestClient
from sqlalchemy import event
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

BACKEND_DIR = Path(__file__).resolve().parent
if str(BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(BACKEND_DIR))

os.environ.setdefault("DATABASE_URL", "postgresql+asyncpg://test:test@localhost:5432/test")
os.environ.setdefault("SUPABASE_URL", "https://example.supabase.co")
os.environ.setdefault("SUPABASE_KEY", "test-anon-key")
os.environ.setdefault("APP_ENVIRONMENT", "development")

from app.api.deps import get_db, require_active_profile_id
from app.api.routes import voice as voice_routes
from app.api.routes import voice_studio as voice_studio_routes
from app.models.tts_audio_cache import TtsAudioCacheDailyUsage, TtsAudioCacheEntry
from app.providers.google_voice_provider import (
    GOOGLE_TTS_MODEL_VERSION,
    GoogleCloudVoiceProvider,
    reset_google_cooldowns,
)
from app.providers.local_voice_provider import (
    DEFAULT_LOCAL_VOICE_ID,
    LOCAL_TTS_MODEL_VERSION,
    LocalSynthesizedAudio,
    LocalVoiceProvider,
    LocalVoiceTechnicalError,
)
from app.repositories.tts_audio_cache_repository import TtsAudioCacheRepository
from app.services.reading_content_service import ReadingContentService
from app.services.tts_audio_cache_service import (
    ResolvedCacheTarget,
    TtsAudioCacheService,
    clear_tts_cache_runtime_metrics,
)
from app.services.voice_orchestrator import (
    VoiceOrchestrator,
    VoicePolicyContext,
    clear_voice_orchestrator_caches,
)


def _make_wav_bytes(duration_sec: float = 0.08, sr: int = 24000) -> bytes:
    buf = io.BytesIO()
    nframes = max(1, int(sr * duration_sec))
    with wave.open(buf, "wb") as wf:
        wf.setnchannels(1)
        wf.setsampwidth(2)
        wf.setframerate(sr)
        wf.writeframes(b"\x10\x00" * nframes)
    return buf.getvalue()


def _make_voice_app(orchestrator: VoiceOrchestrator, actor_id: UUID) -> TestClient:
    app = FastAPI()
    app.include_router(voice_routes.router, prefix="/voice")
    app.include_router(voice_studio_routes.router, prefix="/voice")
    app.dependency_overrides[require_active_profile_id] = lambda: actor_id

    async def _fake_db():
        yield None

    app.dependency_overrides[get_db] = _fake_db
    return TestClient(app)


class VercelReadingFlowOverhaulBackendTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self) -> None:
        clear_tts_cache_runtime_metrics()
        clear_voice_orchestrator_caches()
        reset_google_cooldowns()

    def tearDown(self) -> None:
        clear_tts_cache_runtime_metrics()
        clear_voice_orchestrator_caches()
        reset_google_cooldowns()

    async def test_single_query_cache_lookup_bg_write_behind_and_ram_lru_isolation(
        self,
    ) -> None:
        from sqlalchemy import create_engine
        from sqlalchemy.dialects.postgresql import JSONB
        from sqlalchemy.ext.compiler import compiles
        from sqlalchemy.orm import sessionmaker

        @compiles(JSONB, "sqlite")
        def _compile_jsonb_sqlite(_type, _compiler, **_kw):
            return "JSON"

        sync_engine = create_engine("sqlite:///:memory:")
        TtsAudioCacheEntry.__table__.create(sync_engine, checkfirst=True)
        TtsAudioCacheDailyUsage.__table__.create(sync_engine, checkfirst=True)
        sync_factory = sessionmaker(bind=sync_engine, expire_on_commit=False)

        class _SyncAsyncSession(AsyncSession):
            def __init__(self, sync_db) -> None:
                self._db = sync_db
                self.bind = sync_db.get_bind()

            def get_bind(self, *args, **kwargs):
                return self._db.get_bind(*args, **kwargs)

            async def __aenter__(self):
                return self

            async def __aexit__(self, exc_type, exc, tb) -> None:
                self._db.close()

            def add(self, obj) -> None:
                self._db.add(obj)

            def add_all(self, objs) -> None:
                self._db.add_all(objs)

            async def get(self, *args, **kwargs):
                return self._db.get(*args, **kwargs)

            async def execute(self, *args, **kwargs):
                return self._db.execute(*args, **kwargs)

            async def scalar(self, *args, **kwargs):
                return self._db.scalar(*args, **kwargs)

            async def scalars(self, *args, **kwargs):
                return self._db.scalars(*args, **kwargs)

            async def flush(self) -> None:
                self._db.flush()

            async def commit(self) -> None:
                self._db.commit()

            async def rollback(self) -> None:
                self._db.rollback()

            async def refresh(self, obj) -> None:
                self._db.refresh(obj)

            def begin_nested(self):
                nested = self._db.begin_nested()

                class _AsyncNested:
                    async def __aenter__(self_inner):
                        return nested.__enter__()

                    async def __aexit__(self_inner, exc_type, exc, tb):
                        return nested.__exit__(exc_type, exc, tb)

                return _AsyncNested()

        def session_factory():
            return _SyncAsyncSession(sync_factory())

        select_sqls: list[str] = []

        @event.listens_for(sync_engine, "before_cursor_execute")
        def _record_sql(_conn, _cursor, statement, _params, _ctx, _many):
            if statement.lstrip().upper().startswith("SELECT"):
                select_sqls.append(statement)

        with tempfile.TemporaryDirectory() as tmpdir:
            with patch.dict(
                os.environ,
                {
                    "VIREAD_LOCAL_STORAGE_DIR": tmpdir,
                    "VIREAD_TTS_CACHE_ENABLED": "true",
                },
                clear=False,
            ):
                page_id = uuid4()
                book_id = uuid4()
                owner_id = uuid4()
                catalog_target = ResolvedCacheTarget(
                    scope="CATALOG",
                    owner_parent_id=None,
                    book_id=book_id,
                    page_id=page_id,
                    page_revision_id=None,
                    can_store_on_miss=True,
                )
                private_target = ResolvedCacheTarget(
                    scope="PRIVATE",
                    owner_parent_id=owner_id,
                    book_id=uuid4(),
                    page_id=uuid4(),
                    page_revision_id=None,
                    can_store_on_miss=True,
                )

                async with session_factory() as db:
                    svc = TtsAudioCacheService(db)
                    # Seed folded catalog word at speed 0.90 and private word at 1.00
                    ok_cat = await svc.store_cached_audio(
                        target=catalog_target,
                        normalized_text="con mèo",
                        voice_id=DEFAULT_LOCAL_VOICE_ID,
                        model_version=LOCAL_TTS_MODEL_VERSION,
                        speed=0.9,
                        audio_bytes=b"ID3\x04\x00catalog-cat-mp3",
                        source_content_type="audio/mpeg",
                    )
                    ok_priv = await svc.store_cached_audio(
                        target=private_target,
                        normalized_text="bí mật riêng tư",
                        voice_id=DEFAULT_LOCAL_VOICE_ID,
                        model_version=LOCAL_TTS_MODEL_VERSION,
                        speed=1.0,
                        audio_bytes=b"ID3\x04\x00private-mp3",
                        source_content_type="audio/mpeg",
                    )
                    self.assertTrue(ok_cat)
                    self.assertTrue(ok_priv)

                # First lookup with punctuation + different speed (1.0 vs 0.9):
                # Must resolve folded + nearest speed in ONE cache SELECT query,
                # and defer record_hit to BackgroundTasks (zero inline write SQL).
                select_sqls.clear()
                bg = BackgroundTasks()
                async with session_factory() as db:
                    svc = TtsAudioCacheService(db)
                    hit1 = await svc.lookup_cached_audio(
                        target=catalog_target,
                        normalized_text="Con Mèo!",
                        voice_id=DEFAULT_LOCAL_VOICE_ID,
                        speed=1.0,
                        background_tasks=bg,
                    )
                self.assertIsNotNone(hit1)
                assert hit1 is not None
                self.assertEqual(hit1.content, b"ID3\x04\x00catalog-cat-mp3")
                self.assertAlmostEqual(hit1.cached_speed or 0.0, 0.9, places=2)
                # 1 SELECT for daily_usage (first cold check) + 1 SELECT for get_best_active_entries
                cache_entry_selects = [
                    s for s in select_sqls if "tts_audio_cache_entries" in s.lower()
                ]
                self.assertEqual(len(cache_entry_selects), 1)
                self.assertEqual(len(bg.tasks), 1)

                # Second lookup on same CATALOG entry:
                # 1) Daily usage is served from 15s TTL memory cache (0 daily_usage SELECTs!)
                # 2) Audio bytes are served from 32 MiB RAM LRU (0 storage reads!)
                select_sqls.clear()
                with patch(
                    "app.services.storage_service._local_storage_path",
                    side_effect=AssertionError("Should hit server RAM LRU without disk/storage read"),
                ):
                    bg2 = BackgroundTasks()
                    async with session_factory() as db:
                        svc = TtsAudioCacheService(db)
                        hit2 = await svc.lookup_cached_audio(
                            target=catalog_target,
                            normalized_text="Con Mèo!",
                            voice_id=DEFAULT_LOCAL_VOICE_ID,
                            speed=1.0,
                            background_tasks=bg2,
                        )
                self.assertIsNotNone(hit2)
                assert hit2 is not None
                self.assertEqual(hit2.content, b"ID3\x04\x00catalog-cat-mp3")
                self.assertEqual(len(select_sqls), 1)  # Only 1 SELECT total!

                # PRIVATE audio must NEVER be stored in shared RAM LRU:
                # Deleting the local file after 1st hit must force a miss on 2nd hit.
                async with session_factory() as db:
                    svc = TtsAudioCacheService(db)
                    priv_hit1 = await svc.lookup_cached_audio(
                        target=private_target,
                        normalized_text="bí mật riêng tư",
                        voice_id=DEFAULT_LOCAL_VOICE_ID,
                        speed=1.0,
                    )
                self.assertIsNotNone(priv_hit1)
                assert priv_hit1 is not None
                priv_file = (
                    Path(tmpdir) / priv_hit1.storage_bucket / priv_hit1.storage_path
                )
                self.assertTrue(priv_file.is_file())
                priv_file.unlink()
                async with session_factory() as db:
                    svc = TtsAudioCacheService(db)
                    priv_hit2 = await svc.lookup_cached_audio(
                        target=private_target,
                        normalized_text="bí mật riêng tư",
                        voice_id=DEFAULT_LOCAL_VOICE_ID,
                        speed=1.0,
                    )
                self.assertIsNone(priv_hit2)

        sync_engine.dispose()

    async def test_reading_page_dto_precomputed_word_timings_public_only(self) -> None:
        page_id = uuid4()
        rev_id = uuid4()
        w1_id = uuid4()
        w2_id = uuid4()
        fake_words = [
            SimpleNamespace(
                Id=w1_id,
                WordIndex=0,
                Text="Xin",
                BoundingBox=[0.1, 0.1, 0.2, 0.08],
                LineIndex=0,
            ),
            SimpleNamespace(
                Id=w2_id,
                WordIndex=1,
                Text="chào",
                BoundingBox=[0.35, 0.1, 0.25, 0.08],
                LineIndex=0,
            ),
        ]
        page = SimpleNamespace(
            Id=page_id,
            BookId=uuid4(),
            PageNumber=1,
            Width=1000,
            Height=1400,
            ImagePath=None,
            CurrentVerifiedRevisionId=rev_id,
        )
        revision = SimpleNamespace(
            Id=rev_id,
            VerifiedText="Xin chào",
            VerificationStatus="VERIFIED",
            ProcessingMeta={
                "catalog_tts": {
                    "object_path": f"{DEFAULT_LOCAL_VOICE_ID}/0.9/abc123.mp3",
                    "voice_id": DEFAULT_LOCAL_VOICE_ID,
                    "speed": 0.9,
                    "word_timings": [
                        {"index": 0, "start": 0.0, "end": 0.32},
                        {"index": 1, "start": 0.34, "end": 0.78},
                    ],
                }
            },
        )
        fake_repo = MagicMock()
        fake_repo.revision_words = AsyncMock(return_value=fake_words)
        fake_repo.db = MagicMock()
        fake_repo.db.rollback = AsyncMock()
        fake_repo.db.begin_nested = None

        svc = ReadingContentService(fake_repo)
        with patch.dict(
            os.environ,
            {"SUPABASE_URL": "https://demo.supabase.co"},
            clear=False,
        ):
            public_dto = await svc._build_page_dto(
                page, revision, book_is_private=False
            )
            private_dto = await svc._build_page_dto(
                page, revision, book_is_private=True
            )

        self.assertIsNotNone(public_dto.tts_audio_url)
        self.assertEqual(public_dto.tts_voice_id, DEFAULT_LOCAL_VOICE_ID)
        self.assertEqual(public_dto.tts_cached_speed, 0.9)
        self.assertIsNotNone(public_dto.tts_word_timings)
        assert public_dto.tts_word_timings is not None
        self.assertEqual(len(public_dto.tts_word_timings), 2)
        self.assertEqual(public_dto.tts_word_timings[1].end, 0.78)

        # Private parent book MUST NEVER expose public catalog URL or precomputed timings
        self.assertIsNone(private_dto.tts_audio_url)
        self.assertIsNone(private_dto.tts_word_timings)
        self.assertIsNone(private_dto.tts_voice_id)
        self.assertIsNone(private_dto.tts_cached_speed)

    async def test_local_provider_remote_circuit_breaker_and_no_tts_timeout_retry(
        self,
    ) -> None:
        provider = LocalVoiceProvider(
            base_url="https://remote-voice.example.com",
            worker_token="secret",
        )
        post_calls = 0
        get_calls = 0

        class _TimeoutClient:
            async def post(self, *args, **kwargs):
                nonlocal post_calls
                post_calls += 1
                raise httpx.ReadTimeout("timed out")

            async def get(self, *args, **kwargs):
                nonlocal get_calls
                get_calls += 1
                raise httpx.ReadTimeout("timed out")

        fake_client = _TimeoutClient()
        with patch.object(provider, "_get_client", return_value=fake_client):
            # 1st TTS call times out ONCE (no retry doubling 25s -> 50s) and opens remote breaker
            with self.assertRaises(LocalVoiceTechnicalError):
                await provider.synthesize(text="Xin chào", voice_id=DEFAULT_LOCAL_VOICE_ID)
            self.assertEqual(post_calls, 1)
            self.assertGreater(provider._remote_unavailable_until, time.monotonic())

            # Subsequent get_health & synthesize fail fast in <50ms without calling network
            t0 = time.perf_counter()
            health = await provider.get_health()
            self.assertFalse(health["available"])
            self.assertEqual(get_calls, 0)
            with self.assertRaises(LocalVoiceTechnicalError):
                await provider.synthesize_timed(
                    words=["Xin", "chào"], voice_id=DEFAULT_LOCAL_VOICE_ID
                )
            self.assertEqual(post_calls, 1)
            self.assertLess(time.perf_counter() - t0, 0.05)

    async def test_google_provider_pooled_client_mp3_and_parallel_phonics_order(
        self,
    ) -> None:
        provider = GoogleCloudVoiceProvider(tts_api_key="test-google-key")
        c1 = provider._get_shared_client()
        c2 = provider._get_shared_client()
        self.assertIs(c1, c2)
        await provider.aclose()

        # Verify MP3 negotiation when client accepts audio/mpeg
        sent_bodies: list[dict] = []

        async def _fake_post_mp3(url, *, headers, json):
            sent_bodies.append(json)
            return httpx.Response(
                200,
                json={"audioContent": base64.b64encode(b"ID3\x04\x00mp3-data").decode()},
            )

        with patch.object(provider, "_post_google", side_effect=_fake_post_mp3):
            res_mp3 = await provider.synthesize(
                text="Xin chào",
                voice_id="google_vi_vn_neural2_a",
                accept="audio/mpeg",
            )
        self.assertEqual(res_mp3.content_type, "audio/mpeg")
        self.assertEqual(sent_bodies[0]["audioConfig"]["audioEncoding"], "MP3")

        # Verify synthesize_phonics runs steps concurrently while keeping exact order
        in_flight = 0
        max_in_flight = 0
        wav_a = _make_wav_bytes(0.05)
        wav_b = _make_wav_bytes(0.10)
        wav_c = _make_wav_bytes(0.07)
        wav_by_text = {"mờ": wav_a, "ốt": wav_b, "mốt": wav_c}

        async def _fake_synth_step(
            *, text, voice_id, speed, for_phonics_step=False, audio_encoding="LINEAR16"
        ):
            nonlocal in_flight, max_in_flight
            in_flight += 1
            max_in_flight = max(max_in_flight, in_flight)
            await asyncio.sleep(0.02)
            in_flight -= 1
            key = text.strip().strip(".").lower()
            raw = wav_by_text.get(key, wav_a)
            return raw, "audio/wav", {"voice_id": voice_id, "region": "north"}

        with patch.object(
            provider, "_synthesize_audio_raw", side_effect=_fake_synth_step
        ):
            phonics = await provider.synthesize_phonics(
                steps=[
                    {"id": "s1", "spoken_text": "mờ", "pause_after_ms": 100},
                    {"id": "s2", "spoken_text": "ốt", "pause_after_ms": 100},
                    {"id": "s3", "spoken_text": "mốt", "pause_after_ms": 100},
                ],
                voice_id="google_vi_vn_neural2_a",
                speed=1.0,
            )

        self.assertGreaterEqual(max_in_flight, 2)
        self.assertEqual([s.id for s in phonics.step_timings], ["s1", "s2", "s3"])
        self.assertEqual([s.index for s in phonics.step_timings], [0, 1, 2])
        self.assertLess(phonics.step_timings[0].end, phonics.step_timings[1].start)
        self.assertLess(phonics.step_timings[1].end, phonics.step_timings[2].start)

    async def test_single_flight_tts_dedup_preview_and_explicit_session_relock(
        self,
    ) -> None:
        local = LocalVoiceProvider(base_url="http://127.0.0.1:8010")
        google = GoogleCloudVoiceProvider(tts_api_key="test-key")
        synth_calls = 0

        async def _slow_local_synth(**kwargs):
            nonlocal synth_calls
            synth_calls += 1
            await asyncio.sleep(0.03)
            return LocalSynthesizedAudio(
                content=_make_wav_bytes(0.06),
                content_type="audio/wav",
                resolved_voice_id=kwargs.get("voice_id") or DEFAULT_LOCAL_VOICE_ID,
                region="north",
                model_version=LOCAL_TTS_MODEL_VERSION,
                provider="local",
            )

        local.synthesize = _slow_local_synth  # type: ignore[method-assign]
        orch = VoiceOrchestrator(local_provider=local, google_provider=google)
        actor_id = uuid4()
        policy = VoicePolicyContext(
            session_id="sess_sf_1",
            actor_id=actor_id,
        )

        # Two concurrent identical TTS requests coalesce into 1 synthesis call
        r1, r2 = await asyncio.gather(
            orch.synthesize(
                text="Xin chào bé",
                requested_voice_id=DEFAULT_LOCAL_VOICE_ID,
                speed=1.0,
                policy=policy,
            ),
            orch.synthesize(
                text="Xin chào bé",
                requested_voice_id=DEFAULT_LOCAL_VOICE_ID,
                speed=1.0,
                policy=policy,
            ),
        )
        self.assertEqual(synth_calls, 1)
        self.assertEqual(r1.content, r2.content)

        # HTTP route checks: preview without session_id succeeds (0 409);
        # mid-session mismatch returns 409; PUT /voice/session-lock updates lock cleanly.
        with patch.object(voice_routes, "get_voice_orchestrator", return_value=orch), patch.object(
            voice_studio_routes, "get_voice_orchestrator", return_value=orch
        ):
            with _make_voice_app(orch, actor_id) as client:
                # Preview of a DIFFERENT voice without session_id -> 200 OK (never 409!)
                preview_resp = client.post(
                    "/voice/text-to-speech",
                    json={
                        "text": "Chào con nhé.",
                        "voice_id": "local_south_thuc_doan",
                        "speed": 1.0,
                    },
                )
                self.assertEqual(preview_resp.status_code, 200)

                # Accidental mid-session voice change WITH session_id -> 409 SESSION_VOICE_LOCKED
                conflict_resp = client.post(
                    "/voice/text-to-speech",
                    json={
                        "text": "Từ này nhé.",
                        "voice_id": "local_south_thuc_doan",
                        "speed": 1.0,
                        "session_id": "sess_sf_1",
                    },
                )
                self.assertEqual(conflict_resp.status_code, 409)
                self.assertEqual(
                    conflict_resp.json(),
                    {"detail": {"code": "SESSION_VOICE_LOCKED"}},
                )

                # Deliberate paused relock via PUT /voice/session-lock -> 200 OK
                relock_resp = client.put(
                    "/voice/session-lock",
                    json={
                        "session_id": "sess_sf_1",
                        "voice_id": "local_south_thuc_doan",
                    },
                )
                self.assertEqual(relock_resp.status_code, 200)
                self.assertEqual(
                    relock_resp.json()["voice_id"], "local_south_thuc_doan"
                )

                # Subsequent TTS with session_id + new voice -> 200 OK (0 409!)
                after_relock = client.post(
                    "/voice/text-to-speech",
                    json={
                        "text": "Từ tiếp theo nhé.",
                        "voice_id": "local_south_thuc_doan",
                        "speed": 1.0,
                        "session_id": "sess_sf_1",
                    },
                )
                self.assertEqual(after_relock.status_code, 200)


if __name__ == "__main__":
    unittest.main()
