"""Unit tests for `_HIT_LOOKUP_CACHE` in `tts_audio_cache_service`."""
from __future__ import annotations

import asyncio
import os
import time
from types import SimpleNamespace
import unittest
from unittest.mock import AsyncMock, MagicMock, patch
from uuid import UUID, uuid4

from fastapi import BackgroundTasks
from sqlalchemy.ext.asyncio import AsyncSession

from app.services import tts_audio_cache_service as cache_mod
from app.services.tts_audio_cache_service import (
    CachedTtsHit,
    ResolvedCacheTarget,
    TtsAudioCacheService,
    _AUDIO_RAM_LRU,
    _HIT_LOOKUP_CACHE,
    _bg_record_hit,
    canonical_tts_sha256,
    canonical_tts_text,
    clear_tts_cache_runtime_metrics,
    delete_stale_tts_objects,
    invalidate_tts_cache_summary_cache,
    is_tts_cache_runtime_quota_exhausted,
)


def _make_mp3_bytes(payload: bytes = b"viread-test-mp3-frame-payload") -> bytes:
    return b"ID3\x04\x00\x00\x00\x00\x00\x00" + payload


def _make_fake_session(bind: object) -> AsyncSession:
    db = MagicMock(spec=AsyncSession)
    db.bind = bind
    db.commit = AsyncMock()
    db.rollback = AsyncMock()
    return db


def _make_entry(
    *,
    entry_id: UUID | None = None,
    scope: str = "CATALOG",
    owner_parent_id: UUID | None = None,
    book_id: UUID | None = None,
    page_id: UUID | None = None,
    normalized_text: str = "Chào con, hôm nay cô trò mình cùng đọc sách nhé.",
    voice_id: str = "local_north_truc_ly",
    model_version: str = "vieneu-0.3b-q4",
    speed: float = 1.0,
    audio_format: str = "audio/mpeg",
    bucket: str = "viread-tts-cache",
    path: str | None = None,
    byte_size: int = 64,
    duration_seconds: float | None = None,
    word_timings_json: list[dict[str, float | int]] | None = None,
) -> SimpleNamespace:
    norm = canonical_tts_text(normalized_text)
    sha = canonical_tts_sha256(norm)
    resolved_id = entry_id or uuid4()
    resolved_path = path or f"{scope.lower()}/{sha}/{voice_id}_{speed:.2f}.mp3"
    return SimpleNamespace(
        Id=resolved_id,
        Scope=scope,
        OwnerParentId=owner_parent_id,
        BookId=book_id,
        PageId=page_id,
        ContentSha256=sha,
        NormalizedText=norm,
        VoiceId=voice_id,
        ModelVersion=model_version,
        Speed=speed,
        AudioFormat=audio_format,
        StorageBucket=bucket,
        StoragePath=resolved_path,
        ByteSize=byte_size,
        DurationSeconds=duration_seconds,
        WordTimingsJson=word_timings_json,
        Status="ACTIVE",
    )


class TestTtsHitLookupCache(unittest.IsolatedAsyncioTestCase):
    def setUp(self) -> None:
        clear_tts_cache_runtime_metrics()
        self._shared_bind = object()

    def tearDown(self) -> None:
        clear_tts_cache_runtime_metrics()

    async def test_catalog_and_coaching_warm_hits_skip_db_under_5ms_and_record_bg_hit(
        self,
    ) -> None:
        mp3_bytes = _make_mp3_bytes(b"warm-hit-audio-data" * 8)
        book_id = uuid4()
        page_id = uuid4()
        timings = [
            {"index": 0, "start": 0.0, "end": 0.32},
            {"index": 1, "start": 0.32, "end": 0.74},
            {"index": 2, "start": 0.74, "end": 1.15},
        ]

        scenarios = [
            (
                "CATALOG untimed",
                ResolvedCacheTarget(
                    scope="CATALOG",
                    owner_parent_id=None,
                    book_id=book_id,
                    page_id=page_id,
                    page_revision_id=None,
                    can_store_on_miss=True,
                ),
                "Hai mươi mốt bông hoa",
                1.0,
                1.0,
                False,
                None,
                None,
            ),
            (
                "CATALOG timed speed fallback 0.9 -> 1.05",
                ResolvedCacheTarget(
                    scope="CATALOG",
                    owner_parent_id=None,
                    book_id=book_id,
                    page_id=page_id,
                    page_revision_id=None,
                    can_store_on_miss=True,
                ),
                "Hai mươi mốt",
                0.9,
                1.05,
                True,
                1.15,
                timings,
            ),
            (
                "COACHING untimed",
                ResolvedCacheTarget(
                    scope="COACHING",
                    owner_parent_id=None,
                    book_id=None,
                    page_id=None,
                    page_revision_id=None,
                    can_store_on_miss=True,
                ),
                "Tuyệt vời! Con đọc rất tốt!",
                1.0,
                1.0,
                False,
                None,
                None,
            ),
            (
                "COACHING timed speed fallback 0.9 -> 1.05",
                ResolvedCacheTarget(
                    scope="COACHING",
                    owner_parent_id=None,
                    book_id=None,
                    page_id=None,
                    page_revision_id=None,
                    can_store_on_miss=True,
                ),
                "Chào con hôm nay",
                0.9,
                1.05,
                True,
                1.15,
                timings,
            ),
        ]

        for (
            label,
            target,
            raw_text,
            req_speed,
            cached_speed,
            require_timings,
            duration_sec,
            entry_timings,
        ) in scenarios:
            with self.subTest(scenario=label):
                clear_tts_cache_runtime_metrics()
                norm_text = canonical_tts_text(raw_text)
                entry = _make_entry(
                    scope=target.scope,
                    owner_parent_id=None,
                    book_id=target.book_id,
                    page_id=target.page_id,
                    normalized_text=norm_text,
                    speed=cached_speed,
                    byte_size=len(mp3_bytes),
                    duration_seconds=duration_sec,
                    word_timings_json=(
                        [dict(item) for item in entry_timings]
                        if entry_timings is not None
                        else None
                    ),
                )

                async def _slow_wan_entries(**_kwargs: object) -> list[SimpleNamespace]:
                    await asyncio.sleep(0.025)
                    return [entry]

                get_entries_mock = AsyncMock(side_effect=_slow_wan_entries)
                get_usage_mock = AsyncMock(
                    return_value={"bytes_served": 0, "hit_count": 0, "miss_count": 0}
                )
                download_async_mock = AsyncMock(return_value=mp3_bytes)

                with (
                    patch.object(
                        cache_mod, "is_local_storage_enabled", return_value=False
                    ),
                    patch.object(
                        cache_mod, "download_object_async", download_async_mock
                    ),
                    patch.object(
                        cache_mod.TtsAudioCacheRepository,
                        "get_daily_usage",
                        get_usage_mock,
                    ),
                    patch.object(
                        cache_mod.TtsAudioCacheRepository,
                        "get_best_active_entries",
                        get_entries_mock,
                    ),
                ):
                    db1 = _make_fake_session(self._shared_bind)
                    svc1 = TtsAudioCacheService(db1)
                    bg1 = BackgroundTasks()
                    hit1 = await svc1.lookup_cached_audio(
                        target=target,
                        normalized_text=norm_text,
                        voice_id="local_north_truc_ly",
                        preferred_model_version="vieneu-0.3b-q4",
                        speed=req_speed,
                        audio_format="mp3",
                        allow_speed_fallback=True,
                        require_word_timings=require_timings,
                        background_tasks=bg1,
                    )
                    self.assertIsInstance(hit1, CachedTtsHit)
                    assert hit1 is not None
                    self.assertEqual(get_entries_mock.await_count, 1)
                    self.assertEqual(download_async_mock.await_count, 1)
                    self.assertEqual(db1.commit.await_count, 1)
                    self.assertEqual(len(_HIT_LOOKUP_CACHE), 1)

                    # Verify cached metadata holds plain Python values (never ORM/SimpleNamespace)
                    _, meta = next(iter(_HIT_LOOKUP_CACHE.values()))
                    self.assertNotIn("entry", meta)
                    for meta_val in meta.values():
                        self.assertNotIsInstance(meta_val, SimpleNamespace)

                    if hit1.word_timings_json and isinstance(
                        hit1.word_timings_json, list
                    ):
                        hit1.word_timings_json[0]["start"] = 999.0

                    # Second warm lookup on a fresh session sharing the engine bind
                    db2 = _make_fake_session(self._shared_bind)
                    svc2 = TtsAudioCacheService(db2)
                    bg2 = BackgroundTasks()
                    t0 = time.perf_counter()
                    hit2 = await svc2.lookup_cached_audio(
                        target=target,
                        normalized_text=norm_text,
                        voice_id="local_north_truc_ly",
                        preferred_model_version="vieneu-0.3b-q4",
                        speed=req_speed,
                        audio_format="mp3",
                        allow_speed_fallback=True,
                        require_word_timings=require_timings,
                        background_tasks=bg2,
                    )
                    elapsed_ms = (time.perf_counter() - t0) * 1000.0

                    self.assertIsInstance(hit2, CachedTtsHit)
                    assert hit2 is not None
                    self.assertLess(
                        elapsed_ms,
                        5.0,
                        f"Expected warm RAM lookup < 5 ms for {label}, got {elapsed_ms:.3f} ms",
                    )
                    # get_best_active_entries MUST remain at 1 (0 DB queries and 0 commits on warm hit)
                    self.assertEqual(get_entries_mock.await_count, 1)
                    self.assertEqual(get_usage_mock.await_count, 1)
                    self.assertEqual(download_async_mock.await_count, 1)
                    self.assertEqual(db2.commit.await_count, 0)

                    self.assertEqual(hit2.content, mp3_bytes)
                    self.assertEqual(hit2.content_type, "audio/mpeg")
                    self.assertEqual(hit2.resolved_voice_id, "local_north_truc_ly")
                    self.assertEqual(hit2.model_version, "vieneu-0.3b-q4")
                    self.assertEqual(hit2.scope, target.scope)
                    self.assertEqual(hit2.storage_bucket, entry.StorageBucket)
                    self.assertEqual(hit2.storage_path, entry.StoragePath)
                    self.assertAlmostEqual(hit2.cached_speed or 0.0, cached_speed)
                    self.assertEqual(hit2.normalized_text, norm_text)
                    if require_timings:
                        self.assertAlmostEqual(hit2.duration_seconds or 0.0, 1.15)
                        assert isinstance(hit2.word_timings_json, list)
                        self.assertEqual(hit2.word_timings_json[0]["start"], 0.0)

                    # Verify background _bg_record_hit was scheduled with (entry_id, len(mp3_bytes))
                    self.assertEqual(len(bg2.tasks), 1)
                    self.assertIs(bg2.tasks[0].func, _bg_record_hit)
                    self.assertEqual(bg2.tasks[0].args, (entry.Id, len(mp3_bytes)))

    async def test_private_scope_never_uses_hit_lookup_cache(self) -> None:
        mp3_bytes = _make_mp3_bytes(b"private-parent-audio")
        parent_id = uuid4()
        book_id = uuid4()
        page_id = uuid4()
        norm_text = canonical_tts_text("Truyện riêng của gia đình bé.")
        private_target = ResolvedCacheTarget(
            scope="PRIVATE",
            owner_parent_id=parent_id,
            book_id=book_id,
            page_id=page_id,
            page_revision_id=None,
            can_store_on_miss=True,
        )
        private_entry = _make_entry(
            scope="PRIVATE",
            owner_parent_id=parent_id,
            book_id=book_id,
            page_id=page_id,
            normalized_text=norm_text,
            bucket="viread-private-books",
            byte_size=len(mp3_bytes),
        )

        get_entries_mock = AsyncMock(return_value=[private_entry])
        get_usage_mock = AsyncMock(
            return_value={"bytes_served": 0, "hit_count": 0, "miss_count": 0}
        )
        download_async_mock = AsyncMock(return_value=mp3_bytes)

        with (
            patch.object(cache_mod, "is_local_storage_enabled", return_value=False),
            patch.object(cache_mod, "download_object_async", download_async_mock),
            patch.object(
                cache_mod.TtsAudioCacheRepository, "get_daily_usage", get_usage_mock
            ),
            patch.object(
                cache_mod.TtsAudioCacheRepository,
                "get_best_active_entries",
                get_entries_mock,
            ),
        ):
            svc1 = TtsAudioCacheService(_make_fake_session(self._shared_bind))
            hit1 = await svc1.lookup_cached_audio(
                target=private_target,
                normalized_text=norm_text,
                voice_id="local_north_truc_ly",
                speed=1.0,
                background_tasks=BackgroundTasks(),
            )
            self.assertIsNotNone(hit1)
            self.assertEqual(len(_HIT_LOOKUP_CACHE), 0)
            self.assertEqual(len(_AUDIO_RAM_LRU), 0)

            svc2 = TtsAudioCacheService(_make_fake_session(self._shared_bind))
            hit2 = await svc2.lookup_cached_audio(
                target=private_target,
                normalized_text=norm_text,
                voice_id="local_north_truc_ly",
                speed=1.0,
                background_tasks=BackgroundTasks(),
            )
            self.assertIsNotNone(hit2)
            self.assertEqual(len(_HIT_LOOKUP_CACHE), 0)
            self.assertEqual(len(_AUDIO_RAM_LRU), 0)
            self.assertEqual(get_entries_mock.await_count, 2)
            self.assertEqual(download_async_mock.await_count, 2)

            # Even if a target has owner_parent_id set on a public scope name, never cache it
            hybrid_target = ResolvedCacheTarget(
                scope="CATALOG",
                owner_parent_id=parent_id,
                book_id=book_id,
                page_id=page_id,
                page_revision_id=None,
                can_store_on_miss=False,
            )
            await svc2.lookup_cached_audio(
                target=hybrid_target,
                normalized_text=norm_text,
                voice_id="local_north_truc_ly",
                speed=1.0,
                background_tasks=BackgroundTasks(),
            )
            self.assertEqual(len(_HIT_LOOKUP_CACHE), 0)

    async def test_daily_egress_quota_limit_blocks_warm_ram_hits_when_exceeded(
        self,
    ) -> None:
        mp3_bytes = _make_mp3_bytes(b"quota-check-payload-60b" * 2)  # > 50 bytes
        norm_text = canonical_tts_text("Tuyệt vời!")
        target = ResolvedCacheTarget(
            scope="COACHING",
            owner_parent_id=None,
            book_id=None,
            page_id=None,
            page_revision_id=None,
            can_store_on_miss=True,
        )
        entry = _make_entry(
            scope="COACHING",
            normalized_text=norm_text,
            byte_size=len(mp3_bytes),
        )
        # Allow exactly 1 hit, block the 2nd warm hit (2 * len > limit > 1 * len)
        daily_limit = len(mp3_bytes) + 10

        get_entries_mock = AsyncMock(return_value=[entry])
        get_usage_mock = AsyncMock(
            return_value={"bytes_served": 0, "hit_count": 0, "miss_count": 0}
        )
        download_async_mock = AsyncMock(return_value=mp3_bytes)

        with (
            patch.dict(
                os.environ,
                {"VIREAD_TTS_CACHE_DAILY_EGRESS_LIMIT_BYTES": str(daily_limit)},
            ),
            patch.object(cache_mod, "is_local_storage_enabled", return_value=False),
            patch.object(cache_mod, "download_object_async", download_async_mock),
            patch.object(
                cache_mod.TtsAudioCacheRepository, "get_daily_usage", get_usage_mock
            ),
            patch.object(
                cache_mod.TtsAudioCacheRepository,
                "get_best_active_entries",
                get_entries_mock,
            ),
        ):
            # 1st lookup: cold hit succeeds and advances _DAILY_USAGE_CACHE bytes_served
            svc1 = TtsAudioCacheService(_make_fake_session(self._shared_bind))
            bg1 = BackgroundTasks()
            hit1 = await svc1.lookup_cached_audio(
                target=target,
                normalized_text=norm_text,
                voice_id="local_north_truc_ly",
                speed=1.0,
                background_tasks=bg1,
            )
            self.assertIsNotNone(hit1)
            self.assertFalse(is_tts_cache_runtime_quota_exhausted())
            self.assertEqual(len(_HIT_LOOKUP_CACHE), 1)
            self.assertEqual(len(bg1.tasks), 1)

            # 2nd lookup: warm _HIT_LOOKUP_CACHE + _AUDIO_RAM_LRU hit exceeds daily_limit -> None
            db2 = _make_fake_session(self._shared_bind)
            svc2 = TtsAudioCacheService(db2)
            bg2 = BackgroundTasks()
            hit2 = await svc2.lookup_cached_audio(
                target=target,
                normalized_text=norm_text,
                voice_id="local_north_truc_ly",
                speed=1.0,
                background_tasks=bg2,
            )
            self.assertIsNone(hit2)
            self.assertTrue(is_tts_cache_runtime_quota_exhausted())
            # Must NOT have queried get_best_active_entries or scheduled _bg_record_hit
            self.assertEqual(get_entries_mock.await_count, 1)
            self.assertEqual(len(bg2.tasks), 0)
            self.assertEqual(db2.commit.await_count, 1)

    async def test_store_invalidate_and_clear_evict_hit_lookup_cache(self) -> None:
        mp3_bytes = _make_mp3_bytes(b"eviction-test-audio")
        book_id = uuid4()
        page_id = uuid4()
        norm_text = canonical_tts_text("Con đọc rất tốt!")
        target = ResolvedCacheTarget(
            scope="CATALOG",
            owner_parent_id=None,
            book_id=book_id,
            page_id=page_id,
            page_revision_id=None,
            can_store_on_miss=True,
        )
        entry = _make_entry(
            scope="CATALOG",
            book_id=book_id,
            page_id=page_id,
            normalized_text=norm_text,
            byte_size=len(mp3_bytes),
        )

        async def _populate_warm_entry() -> TtsAudioCacheService:
            clear_tts_cache_runtime_metrics()
            db = _make_fake_session(self._shared_bind)
            svc = TtsAudioCacheService(db)
            with (
                patch.object(cache_mod, "is_local_storage_enabled", return_value=False),
                patch.object(
                    cache_mod,
                    "download_object_async",
                    AsyncMock(return_value=mp3_bytes),
                ),
                patch.object(
                    cache_mod.TtsAudioCacheRepository,
                    "get_daily_usage",
                    AsyncMock(
                        return_value={"bytes_served": 0, "hit_count": 0, "miss_count": 0}
                    ),
                ),
                patch.object(
                    cache_mod.TtsAudioCacheRepository,
                    "get_best_active_entries",
                    AsyncMock(return_value=[entry]),
                ),
            ):
                hit = await svc.lookup_cached_audio(
                    target=target,
                    normalized_text=norm_text,
                    voice_id="local_north_truc_ly",
                    speed=1.0,
                    background_tasks=BackgroundTasks(),
                )
                self.assertIsNotNone(hit)
                self.assertEqual(len(_HIT_LOOKUP_CACHE), 1)
            return svc

        # 1. clear_tts_cache_runtime_metrics()
        await _populate_warm_entry()
        clear_tts_cache_runtime_metrics()
        self.assertEqual(len(_HIT_LOOKUP_CACHE), 0)

        # 2. invalidate_tts_cache_summary_cache()
        await _populate_warm_entry()
        invalidate_tts_cache_summary_cache()
        self.assertEqual(len(_HIT_LOOKUP_CACHE), 0)

        # 3. store_cached_audio()
        svc_store = await _populate_warm_entry()
        with (
            patch.object(cache_mod, "upload_object", MagicMock()),
            patch.object(cache_mod, "delete_object", MagicMock()),
            patch.object(
                cache_mod.TtsAudioCacheRepository,
                "get_active_entry",
                AsyncMock(return_value=None),
            ),
            patch.object(
                cache_mod.TtsAudioCacheRepository,
                "upsert_active_entry",
                AsyncMock(return_value=(entry, [])),
            ),
            patch.object(
                cache_mod.TtsAudioCacheRepository,
                "total_active_bytes",
                AsyncMock(return_value=len(mp3_bytes)),
            ),
        ):
            stored = await svc_store.store_cached_audio(
                target=target,
                normalized_text=norm_text,
                voice_id="local_north_truc_ly",
                model_version="vieneu-0.3b-q4",
                speed=1.0,
                audio_bytes=mp3_bytes,
                source_content_type="audio/mpeg",
            )
            self.assertTrue(stored)
            self.assertEqual(len(_HIT_LOOKUP_CACHE), 0)

        # 4. invalidate_target()
        svc_inv = await _populate_warm_entry()
        with (
            patch.object(cache_mod, "delete_object", MagicMock()),
            patch.object(
                cache_mod.TtsAudioCacheRepository,
                "mark_stale_for_target",
                AsyncMock(return_value=[(entry.StorageBucket, entry.StoragePath)]),
            ),
        ):
            count = await svc_inv.invalidate_target(book_id=book_id, commit=True)
            self.assertEqual(count, 1)
            self.assertEqual(len(_HIT_LOOKUP_CACHE), 0)

        # 5. delete_stale_tts_objects()
        await _populate_warm_entry()
        with patch.object(cache_mod, "delete_object", MagicMock()):
            await delete_stale_tts_objects([(entry.StorageBucket, entry.StoragePath)])
        self.assertEqual(len(_HIT_LOOKUP_CACHE), 0)

        # 6. LRU quota eviction (_enforce_lru_quota)
        svc_evict = await _populate_warm_entry()
        with (
            patch.object(
                cache_mod.TtsAudioCacheRepository,
                "total_active_bytes",
                AsyncMock(side_effect=[5000, 100]),
            ),
            patch.object(
                cache_mod.TtsAudioCacheRepository,
                "list_lru_eviction_candidates",
                AsyncMock(return_value=[entry]),
            ),
            patch.object(
                cache_mod.TtsAudioCacheRepository,
                "mark_entries_status",
                AsyncMock(),
            ),
        ):
            evicted = await svc_evict._enforce_lru_quota(
                max_bytes=1024,
                keep_entry_id=uuid4(),
                scope="CATALOG",
                owner_parent_id=None,
            )
            self.assertEqual(len(evicted), 1)
            self.assertEqual(len(_HIT_LOOKUP_CACHE), 0)


if __name__ == "__main__":
    unittest.main()
