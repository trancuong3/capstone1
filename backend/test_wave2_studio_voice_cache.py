"""Wave 2 + Wave 3 Slice 1 regression tests: Studio V2, TTS Cache, Voice & Lifespan."""
from __future__ import annotations

import asyncio
import base64
import io
import json
import os
import struct
import tempfile
import unittest
from contextlib import asynccontextmanager
from datetime import datetime, timedelta, timezone
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock, patch
from uuid import UUID, uuid4

os.environ["APP_ENVIRONMENT"] = "test"
os.environ.setdefault("DATABASE_URL", "postgresql+asyncpg://test:test@127.0.0.1:1/test")
os.environ.setdefault("SUPABASE_URL", "https://example.supabase.co")
os.environ.setdefault("SUPABASE_KEY", "isolated-test-key")
os.environ.setdefault("SUPABASE_STORAGE_BUCKET", "viread-test-catalog")
os.environ.setdefault("SUPABASE_PRIVATE_BOOKS_BUCKET", "viread-test-private")

import httpx
from fastapi import FastAPI, HTTPException
from fastapi.testclient import TestClient
from PIL import Image
from sqlalchemy.ext.asyncio import AsyncSession
from starlette.websockets import WebSocketDisconnect

import app.providers as providers_pkg
from app.api.deps import get_current_parent_id, get_db, require_active_profile_id
from app.api.routes import book_assets as book_assets_route
from app.api.routes import global_tasks as global_tasks_route
from app.api.routes import ocr_extraction as ocr_extraction_route
from app.api.routes import voice as voice_routes
from app.api.routes import voice_studio as voice_studio_route
from app.models import Book, BookPage, BookPresentationAsset, Profile, SmartStudioJob
from app.providers.elevenlabs_voice_provider import VoiceProviderError
from app.providers.google_voice_provider import (
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
from app.schemas.book_assets import (
    PageIllustrationExtractRequest,
    PageIllustrationGenerateRequest,
    PageIllustrationGenerateResponse,
)
from app.schemas.global_tasks import GlobalTaskCreateRequest
from app.services import local_voice_worker_bootstrap as bootstrap_mod
from app.services.book_cover_service import (
    BookCoverService,
    ImageProviderAvailability,
    _default_image_generate_transport,
    validate_and_process_cover_image,
)
from app.services.book_illustration_service import (
    BookIllustrationService,
    _decode_bgr_safely,
    _validate_and_download_page_image,
)
from app.services.global_tasks_service import (
    GlobalTasksService,
    process_one_smart_studio_job,
)
from app.services.ocr_document_boundary import _decode_image_to_bgr
from app.services.rate_limiter import clear_rate_limits, rate_limiter
from app.services.tts_audio_cache_service import (
    ALLOWED_COACHING_PHRASES,
    ResolvedCacheTarget,
    TtsAudioCacheService,
    delete_stale_tts_objects,
)
from app.services.voice_orchestrator import (
    VoiceOrchestrator,
    VoicePolicyContext,
    clear_voice_orchestrator_caches,
)


def _make_png_bytes(size: tuple[int, int] = (360, 480), color=(90, 170, 210)) -> bytes:
    img = Image.new("RGB", size, color)
    buf = io.BytesIO()
    img.save(buf, format="PNG")
    return buf.getvalue()


class Wave2SmartStudioAndLifespanTests(unittest.IsolatedAsyncioTestCase):
    async def test_create_task_persists_authorized_book_id_from_page(self) -> None:
        from test_durable_workflows_and_router import FakeStudioAsyncSession, StudioDbState

        state = StudioDbState()
        db = FakeStudioAsyncSession(state)
        parent_id = uuid4()
        book_id = uuid4()
        page_id = uuid4()
        db.add(Profile(Id=parent_id, Role="parent", Active=1))
        db.add(
            Book(
                Id=book_id,
                Title="Sách riêng của bé",
                MinGrade=1,
                MaxGrade=3,
                VisibilityScope="PARENT_PRIVATE",
                OwnerParentId=parent_id,
                LifecycleStatus="ACTIVE",
                ModerationStatus="ACTIVE",
                IsDeleted=False,
            )
        )
        db.add(BookPage(Id=page_id, BookId=book_id, PageNumber=1, ImagePath="private/p1.png"))

        svc = GlobalTasksService(db)  # type: ignore[arg-type]
        res = await svc.create_task(
            actor_id=parent_id,
            payload=GlobalTaskCreateRequest(
                job_type="ILLUSTRATION_EXTRACT",
                book_id=None,
                book_page_id=page_id,
                idempotency_key="page-only-book-id-1",
                input_hash="a" * 64,
            ),
        )
        self.assertEqual(res.task.book_id, book_id)
        stored_jobs = state.tables[SmartStudioJob]
        self.assertEqual(len(stored_jobs), 1)
        self.assertEqual(stored_jobs[0].BookId, book_id)

    async def test_process_one_job_no_duplicate_respects_user_cover_maps_quota_and_fences_cancel(
        self,
    ) -> None:
        from app.schemas.book_assets import BookStyleBibleRead, StyleBibleContentRead
        from test_durable_workflows_and_router import FakeStudioAsyncSession, StudioDbState

        state = StudioDbState()
        db = FakeStudioAsyncSession(state)
        parent_id = uuid4()
        book_id = uuid4()
        db.add(Profile(Id=parent_id, Role="parent", Active=1))
        db.add(
            Book(
                Id=book_id,
                Title="Sách có bìa người dùng",
                MinGrade=1,
                MaxGrade=4,
                VisibilityScope="PARENT_PRIVATE",
                OwnerParentId=parent_id,
                LifecycleStatus="ACTIVE",
                ModerationStatus="ACTIVE",
                IsDeleted=False,
            )
        )
        svc = GlobalTasksService(db)  # type: ignore[arg-type]

        def _fake_bible(ctx_hash: str) -> BookStyleBibleRead:
            return BookStyleBibleRead(
                book_id=book_id,
                context_hash=ctx_hash,
                cache_hit=True,
                bible=StyleBibleContentRead(
                    genre="story",
                    age_group="6-9",
                    art_style="watercolor",
                    prompt_prefix="Cute Vietnamese children book illustration",
                ),
                updated_at=datetime.now(timezone.utc),
            )

        def _find_job(job_id: UUID) -> SmartStudioJob:
            return next(j for j in state.tables[SmartStudioJob] if j.Id == job_id)

        # 1. Existing USER_UPLOAD cover -> worker does NOT hardcode force_regenerate=True,
        #    maps SUPERSEDED_BY_USER_UPLOAD -> STALE, and creates ZERO duplicate SmartStudioJob rows!
        created1 = await svc.create_task(
            actor_id=parent_id,
            payload=GlobalTaskCreateRequest(
                job_type="COVER_GENERATE",
                book_id=book_id,
                idempotency_key="worker-cover-user-upload",
                input_hash="1" * 64,
            ),
        )
        fake_user_cover = BookPresentationAsset(
            Id=uuid4(),
            BookId=book_id,
            AssetRole="COVER",
            SourceType="USER_UPLOAD",
            StoragePath="studio/covers/u.webp",
            MimeType="image/webp",
            AssetHash="h" * 64,
            AssetVersion=1,
            IsActive=True,
            TextFreeVerified=True,
            ModerationStatus="APPROVED",
            CreatedAt=datetime.now(timezone.utc),
            UpdatedAt=datetime.now(timezone.utc),
        )
        with (
            patch(
                "app.services.book_cover_service.BookAssetsRepository.has_active_user_uploaded_cover",
                AsyncMock(return_value=True),
            ),
            patch(
                "app.services.book_cover_service.BookAssetsRepository.get_effective_cover",
                AsyncMock(return_value=(fake_user_cover, False)),
            ),
            patch(
                "app.services.book_cover_service.BookStyleBibleService.get_or_build_for_book",
                AsyncMock(return_value=_fake_bible("ctx1")),
            ),
        ):
            ran = await process_one_smart_studio_job(db, worker_id="w1")  # type: ignore[arg-type]
        self.assertTrue(ran)
        self.assertEqual(len(state.tables[SmartStudioJob]), 1)
        self.assertEqual(_find_job(created1.task.id).Status, "STALE")

        # 2. HTTP 429 quota -> maps cleanly to WAITING_FOR_QUOTA (not FAILED) with zero duplicate job
        created2 = await svc.create_task(
            actor_id=parent_id,
            payload=GlobalTaskCreateRequest(
                job_type="COVER_GENERATE",
                book_id=book_id,
                idempotency_key="worker-cover-quota-429",
                input_hash="2" * 64,
            ),
        )
        avail_provider = ImageProviderAvailability(
            available=True,
            provider_name="local_image_worker",
            model_id="sd15-lcm",
            endpoint_url="http://127.0.0.1:8099/gen",
            reason_code="READY",
            message_vi="OK",
        )
        with (
            patch(
                "app.services.book_cover_service.detect_image_generation_provider",
                return_value=avail_provider,
            ),
            patch(
                "app.services.book_cover_service._default_image_generate_transport",
                AsyncMock(return_value=(429, b"")),
            ),
            patch(
                "app.services.book_cover_service.BookAssetsRepository.has_active_user_uploaded_cover",
                AsyncMock(return_value=False),
            ),
            patch(
                "app.services.book_cover_service.BookStyleBibleService.get_or_build_for_book",
                AsyncMock(return_value=_fake_bible("ctx2")),
            ),
        ):
            ran2 = await process_one_smart_studio_job(db, worker_id="w1")  # type: ignore[arg-type]
        self.assertTrue(ran2)
        self.assertEqual(len(state.tables[SmartStudioJob]), 2)
        self.assertEqual(_find_job(created2.task.id).Status, "WAITING_FOR_QUOTA")

        # 3. CANCEL_REQUESTED mid-generation -> fences asset write & deletes uploaded Storage blob!
        created3 = await svc.create_task(
            actor_id=parent_id,
            payload=GlobalTaskCreateRequest(
                job_type="COVER_GENERATE",
                book_id=book_id,
                idempotency_key="worker-cover-cancel-fence",
                input_hash="3" * 64,
            ),
        )
        png_bytes = _make_png_bytes()
        deleted_paths: list[str] = []

        async def _transport_then_cancel(_provider, _prompt):
            _find_job(created3.task.id).Status = "CANCEL_REQUESTED"
            return 200, png_bytes

        with tempfile.TemporaryDirectory() as tmpdir:
            with (
                patch.dict(os.environ, {"VIREAD_LOCAL_STORAGE_DIR": tmpdir}, clear=False),
                patch(
                    "app.services.book_cover_service.detect_image_generation_provider",
                    return_value=avail_provider,
                ),
                patch(
                    "app.services.book_cover_service._default_image_generate_transport",
                    side_effect=_transport_then_cancel,
                ),
                patch(
                    "app.services.book_cover_service.BookAssetsRepository.has_active_user_uploaded_cover",
                    AsyncMock(return_value=False),
                ),
                patch(
                    "app.services.book_cover_service.BookAssetsRepository.create_cover_asset",
                    AsyncMock(side_effect=AssertionError("Must NOT insert asset when cancelled")),
                ),
                patch(
                    "app.services.book_cover_service.BookStyleBibleService.get_or_build_for_book",
                    AsyncMock(return_value=_fake_bible("ctx3")),
                ),
                patch(
                    "app.services.book_cover_service.delete_object",
                    side_effect=lambda path, **_kw: deleted_paths.append(path),
                ),
            ):
                ran3 = await process_one_smart_studio_job(db, worker_id="w1")  # type: ignore[arg-type]
        self.assertTrue(ran3)
        self.assertEqual(_find_job(created3.task.id).Status, "CANCELLED")
        self.assertEqual(len(deleted_paths), 1)

    async def test_sever_gates_smart_studio_worker_exposes_health_and_cleans_up_on_shutdown(
        self,
    ) -> None:
        import app.sever as sever_mod

        fake_engine = SimpleNamespace(dispose=AsyncMock())
        with (
            patch.dict(
                os.environ,
                {
                    "VIREAD_WEB_DISABLE_HEAVY_WORKERS": "true",
                    "VIREAD_SMART_STUDIO_WORKER_ENABLED": "true",
                    "BACKGROUND_WORKER_STARTUP_DELAY_SECONDS": "0",
                },
                clear=False,
            ),
            patch.object(sever_mod, "APP_ENVIRONMENT", "staging"),
            patch.object(
                sever_mod,
                "probe_database_connection",
                AsyncMock(
                    return_value={
                        "ok": True,
                        "dns_resolved": True,
                        "ssl_enabled": False,
                        "pool_class": "NullPool",
                        "pooler_mode": "local",
                        "latency_ms": 1.0,
                        "error_type": None,
                    }
                ),
            ),
            patch.object(sever_mod, "engine", fake_engine),
            patch(
                "app.api.routes.voice_studio.shutdown_cached_public_voice_ids_task",
                new_callable=AsyncMock,
            ) as mock_shutdown_voices_task,
            patch(
                "app.api.routes.voice.close_default_voice_orchestrators",
                new_callable=AsyncMock,
            ) as mock_close_orchs,
            patch.object(sever_mod, "collect_ocr_health", return_value=[]),
        ):
            with TestClient(sever_mod.app) as client:
                self.assertIsNone(client.app.state.background_workers["smart_studio"])
                resp = client.get("/health")
                self.assertEqual(resp.status_code, 200)
                workers_map = resp.json()["workers"]
                self.assertEqual(workers_map["smart_studio_worker"], "disabled")
                self.assertEqual(workers_map["local_voice_bootstrap"], "disabled")
            mock_shutdown_voices_task.assert_awaited_once()
            mock_close_orchs.assert_awaited_once()


class Wave2CoverIllustrationBoundaryTests(unittest.IsolatedAsyncioTestCase):
    async def test_no_global_max_image_pixels_mutation_and_stream_cap_and_orphan_delete(
        self,
    ) -> None:
        sentinel_limit = 77_654_321
        orig_limit = Image.MAX_IMAGE_PIXELS
        Image.MAX_IMAGE_PIXELS = sentinel_limit
        try:
            png = _make_png_bytes((200, 260))
            _ = validate_and_process_cover_image(png, "image/png")
            self.assertEqual(Image.MAX_IMAGE_PIXELS, sentinel_limit)
            _ = _decode_bgr_safely(png)
            self.assertEqual(Image.MAX_IMAGE_PIXELS, sentinel_limit)
            _ = _decode_image_to_bgr(png)
            self.assertEqual(Image.MAX_IMAGE_PIXELS, sentinel_limit)
        finally:
            Image.MAX_IMAGE_PIXELS = orig_limit

        # Stream-cap in _default_image_generate_transport rejects >10 MiB before buffering all chunks
        class _OversizedStreamResponse:
            status_code = 200
            headers = {"content-type": "image/png"}

            async def __aenter__(self):
                return self

            async def __aexit__(self, *args):
                return False

            async def aiter_bytes(self, _chunk_size: int = 65536):
                for _ in range(300):
                    yield b"x" * 65536

        fake_client = MagicMock()
        fake_client.__aenter__ = AsyncMock(return_value=fake_client)
        fake_client.__aexit__ = AsyncMock(return_value=False)
        fake_client.stream = MagicMock(return_value=_OversizedStreamResponse())
        provider = ImageProviderAvailability(
            available=True,
            provider_name="local_image_worker",
            model_id="m",
            endpoint_url="http://127.0.0.1:8099/gen",
            reason_code="READY",
            message_vi="OK",
        )
        with patch("app.services.book_cover_service.httpx.AsyncClient", return_value=fake_client):
            code, body = await _default_image_generate_transport(provider, "cat")
        self.assertEqual((code, body), (502, b""))

        # delete_book_cover deletes orphan Storage blobs AFTER commit
        events: list[str] = []
        book = Book(
            Id=uuid4(),
            Title="T",
            MinGrade=1,
            MaxGrade=3,
            VisibilityScope="CATALOG",
            LifecycleStatus="ACTIVE",
            ModerationStatus="ACTIVE",
            IsDeleted=False,
        )
        old_cover = SimpleNamespace(StoragePath="studio/covers/catalog/x/old.webp")
        fake_db = SimpleNamespace(
            commit=AsyncMock(side_effect=lambda: events.append("db_commit")),
            rollback=AsyncMock(),
        )
        svc = BookCoverService(fake_db)  # type: ignore[arg-type]
        svc.authorize_book_write = AsyncMock(return_value=(book, "admin"))  # type: ignore[method-assign]
        svc.repo = SimpleNamespace(
            deactivate_book_covers=AsyncMock(return_value=[old_cover]),
            mark_inflight_cover_jobs_stale=AsyncMock(return_value=0),
        )  # type: ignore[assignment]
        with patch(
            "app.services.book_cover_service.delete_object",
            side_effect=lambda path, **_kw: events.append(f"delete:{path}"),
        ):
            res = await svc.delete_book_cover(uuid4(), book.Id)
        self.assertEqual(res.removed_count, 1)
        self.assertEqual(events, ["db_commit", "delete:studio/covers/catalog/x/old.webp"])

    async def test_illustration_image_path_validation_and_stale_response_status(self) -> None:
        # Rejects traversal, http://, private-book https://, and loopback https://
        for bad_path, is_priv in (
            ("../etc/passwd", False),
            ("http://example.com/p.png", False),
            ("https://127.0.0.1/p.png", False),
            ("https://cdn.example.com/p.png", True),
        ):
            with self.assertRaises(HTTPException):
                await _validate_and_download_page_image(
                    bad_path, is_private_book=is_priv, bucket="books"
                )

        # PageIllustrationGenerateResponse supports "STALE" and service returns STALE on revision drift
        dto = PageIllustrationGenerateResponse(
            status="STALE",
            recommended_reading_mode="TEXT",
            message_vi="stale",
        )
        self.assertEqual(dto.status, "STALE")

        book_id, page_id, rev1, rev2 = uuid4(), uuid4(), uuid4(), uuid4()
        book = Book(
            Id=book_id,
            Title="Truyện",
            MinGrade=1,
            MaxGrade=3,
            VisibilityScope="CATALOG",
            LifecycleStatus="ACTIVE",
            ModerationStatus="ACTIVE",
            IsDeleted=False,
        )
        page_before = BookPage(
            Id=page_id, BookId=book_id, PageNumber=1, ImagePath="pages/p1.png", CurrentVerifiedRevisionId=rev1
        )
        page_after = BookPage(
            Id=page_id, BookId=book_id, PageNumber=1, ImagePath="pages/p1.png", CurrentVerifiedRevisionId=rev2
        )
        fake_db = SimpleNamespace(commit=AsyncMock(), rollback=AsyncMock())
        avail = ImageProviderAvailability(
            available=True,
            provider_name="local_image_worker",
            model_id="m",
            endpoint_url="http://127.0.0.1:8099/gen",
            reason_code="READY",
            message_vi="OK",
        )
        svc = BookIllustrationService(
            fake_db,  # type: ignore[arg-type]
            image_transport=AsyncMock(return_value=(200, _make_png_bytes((400, 300)))),
        )
        svc.cover_service.authorize_book_write = AsyncMock(return_value=(book, "admin"))  # type: ignore[method-assign]
        svc.style_bible_service.get_or_build_for_book = AsyncMock(  # type: ignore[method-assign]
            return_value=SimpleNamespace(
                context_hash="ch", bible=SimpleNamespace(prompt_prefix="Cute")
            )
        )
        svc.repo = SimpleNamespace(
            get_page=AsyncMock(side_effect=[page_before, page_after]),
            get_page_revision_context=AsyncMock(return_value=(rev1, "Mèo con đi học", [])),
            record_studio_job=AsyncMock(return_value=None),
        )  # type: ignore[assignment]
        with patch(
            "app.services.book_illustration_service.detect_image_generation_provider",
            return_value=avail,
        ):
            res = await svc.generate_page_illustration(
                uuid4(), book_id, page_id, PageIllustrationGenerateRequest()
            )
        self.assertEqual(res.status, "STALE")

    def test_studio_routes_enforce_rate_limits(self) -> None:
        clear_rate_limits()
        app = FastAPI()
        app.include_router(book_assets_route.router, prefix="/studio")
        app.include_router(global_tasks_route.router, prefix="/studio")
        app.include_router(ocr_extraction_route.router, prefix="/studio/ocr")
        actor_id = uuid4()
        app.dependency_overrides[get_current_parent_id] = lambda: actor_id
        app.dependency_overrides[get_db] = lambda: SimpleNamespace(rollback=AsyncMock())

        rate_limiter.set_override("studio_tasks_read", 1, 60.0)
        try:
            with patch(
                "app.api.routes.global_tasks.GlobalTasksService.list_tasks",
                AsyncMock(
                    return_value={
                        "actor_id": actor_id,
                        "actor_role": "parent",
                        "tasks": [],
                        "active_count": 0,
                        "worker_online": False,
                    }
                ),
            ):
                with TestClient(app) as client:
                    r1 = client.get("/studio/tasks")
                    r2 = client.get("/studio/tasks")
                self.assertEqual(r1.status_code, 200)
                self.assertEqual(r2.status_code, 429)
                self.assertIn("retry-after", r2.headers)
        finally:
            clear_rate_limits()


class Wave2TtsCacheAndVoiceTests(unittest.IsolatedAsyncioTestCase):
    async def test_tts_cache_male_coaching_exact_speed_private_guard_lru_partition_and_invalidate(
        self,
    ) -> None:
        from test_zero_cost_phase2_backend import _InMemoryTtsRepo

        self.assertIn("Thầy đọc mẫu cho con nhé.", ALLOWED_COACHING_PHRASES)
        self.assertIn("Con nghe thầy đọc từ này nhé.", ALLOWED_COACHING_PHRASES)
        self.assertIn("Con đọc xong trang này trôi chảy quá! Thầy khen nhé!", ALLOWED_COACHING_PHRASES)

        with tempfile.TemporaryDirectory() as tmpdir:
            repo = _InMemoryTtsRepo()
            fake_db = MagicMock(spec=AsyncSession)
            fake_db.commit = AsyncMock()
            fake_db.rollback = AsyncMock()
            svc = TtsAudioCacheService(fake_db)
            svc.repo = repo  # type: ignore[assignment]

            # 1. PRIVATE cache requires book_id or page_id
            parent_id = uuid4()
            t_priv_no_book = await svc.resolve_target(
                actor_id=parent_id, cache_scope="PRIVATE", allow_cache_write=True
            )
            self.assertIsNotNone(t_priv_no_book)
            self.assertFalse(t_priv_no_book.can_store_on_miss)
            stored_bad = await svc.store_cached_audio(
                target=ResolvedCacheTarget("PRIVATE", parent_id, None, None, None, True),
                normalized_text="xin chào",
                voice_id=DEFAULT_LOCAL_VOICE_ID,
                model_version=LOCAL_TTS_MODEL_VERSION,
                speed=1.0,
                audio_bytes=b"ID3abc",
                source_content_type="audio/mpeg",
            )
            self.assertFalse(stored_bad)

            # 2. LRU partitioned by scope: PRIVATE writes do NOT evict CATALOG/COACHING entries
            with patch.dict(
                os.environ,
                {"VIREAD_LOCAL_STORAGE_DIR": tmpdir, "VIREAD_TTS_CACHE_MAX_BYTES": "1024"},
                clear=False,
            ):
                pub_target = ResolvedCacheTarget("COACHING", None, None, None, None, True)
                priv_target = ResolvedCacheTarget("PRIVATE", parent_id, uuid4(), uuid4(), None, True)
                ok_pub = await svc.store_cached_audio(
                    target=pub_target,
                    normalized_text="Thầy đọc mẫu cho con nhé.",
                    voice_id=DEFAULT_LOCAL_VOICE_ID,
                    model_version=LOCAL_TTS_MODEL_VERSION,
                    speed=1.0,
                    audio_bytes=b"ID3" + b"p" * 697,  # 700 B
                    source_content_type="audio/mpeg",
                )
                self.assertTrue(ok_pub)
                pub_id = next(iter(repo.entries.keys()))
                ok_priv = await svc.store_cached_audio(
                    target=priv_target,
                    normalized_text="Sách riêng",
                    voice_id=DEFAULT_LOCAL_VOICE_ID,
                    model_version=LOCAL_TTS_MODEL_VERSION,
                    speed=1.0,
                    audio_bytes=b"ID3" + b"x" * 697,  # 700 B (combined 1400 > 1024, but separate scope)
                    source_content_type="audio/mpeg",
                )
                self.assertTrue(ok_priv)
                self.assertEqual(repo.entries[pub_id].Status, "ACTIVE")

                # 3. Pre-existing live Storage object is NOT deleted when DB fails on re-store!
                pub_entry = repo.entries[pub_id]
                pub_file = Path(tmpdir) / pub_entry.StorageBucket / pub_entry.StoragePath
                self.assertTrue(pub_file.is_file())
                with patch.object(repo, "upsert_active_entry", AsyncMock(side_effect=RuntimeError("db fail"))):
                    ok_fail = await svc.store_cached_audio(
                        target=pub_target,
                        normalized_text="Thầy đọc mẫu cho con nhé.",
                        voice_id=DEFAULT_LOCAL_VOICE_ID,
                        model_version=LOCAL_TTS_MODEL_VERSION,
                        speed=1.0,
                        audio_bytes=b"ID3" + b"p" * 697,
                        source_content_type="audio/mpeg",
                    )
                self.assertFalse(ok_fail)
                self.assertTrue(pub_file.is_file())

                # 4. invalidate_target(..., commit=False) returns stale paths WITHOUT deleting early
                stale = await svc.invalidate_target(book_id=priv_target.book_id, commit=False)
                self.assertIsInstance(stale, list)
                self.assertEqual(len(stale), 1)
                priv_bucket, priv_path = stale[0]
                priv_file = Path(tmpdir) / priv_bucket / priv_path
                self.assertTrue(priv_file.is_file())
                await delete_stale_tts_objects(stale)
                self.assertFalse(priv_file.is_file())

        # 5. Exact-speed candidate appearing AFTER mismatched-speed candidate wins!
        page_id = uuid4()
        cand_slow = SimpleNamespace(
            Id=uuid4(),
            NormalizedText="Mèo con đi học.",
            Speed=0.85,
            ByteSize=10,
            StorageBucket="b",
            StoragePath="slow.mp3",
            AudioFormat="audio/mpeg",
            VoiceId=DEFAULT_LOCAL_VOICE_ID,
            ModelVersion=LOCAL_TTS_MODEL_VERSION,
            DurationSeconds=1.0,
            WordTimingsJson=[{"index": 0, "start": 0.0, "end": 1.0}],
            Scope="CATALOG",
        )
        cand_exact = SimpleNamespace(
            Id=uuid4(),
            NormalizedText="Mèo con đi học.",
            Speed=1.0,
            ByteSize=10,
            StorageBucket="b",
            StoragePath="exact.mp3",
            AudioFormat="audio/mpeg",
            VoiceId=DEFAULT_LOCAL_VOICE_ID,
            ModelVersion=LOCAL_TTS_MODEL_VERSION,
            DurationSeconds=1.0,
            WordTimingsJson=[{"index": 0, "start": 0.0, "end": 1.0}],
            Scope="CATALOG",
        )
        fake_repo = SimpleNamespace(
            get_daily_usage=AsyncMock(return_value={"bytes_served": 0, "hit_count": 0, "miss_count": 0}),
            get_active_entry=AsyncMock(return_value=None),
            get_active_timed_entries_for_page=AsyncMock(return_value=[cand_slow, cand_exact]),
            get_nearest_active_entry=AsyncMock(return_value=None),
            record_hit=AsyncMock(),
            record_miss=AsyncMock(),
        )
        fake_db2 = MagicMock(spec=AsyncSession)
        fake_db2.commit = AsyncMock()
        fake_db2.rollback = AsyncMock()
        svc2 = TtsAudioCacheService(fake_db2)
        svc2.repo = fake_repo  # type: ignore[assignment]
        with patch(
            "app.services.tts_audio_cache_service.download_object",
            return_value=b"ID3exact",
        ):
            hit = await svc2.lookup_cached_audio(
                target=ResolvedCacheTarget("CATALOG", None, uuid4(), page_id, None, True),
                normalized_text="Mèo con đi học",
                voice_id=DEFAULT_LOCAL_VOICE_ID,
                speed=1.0,
                require_word_timings=True,
            )
        self.assertIsNotNone(hit)
        self.assertEqual(hit.storage_path, "exact.mp3")

    async def test_voice_studio_negative_cache_backoff_suppresses_retry_storm(self) -> None:
        voice_studio_route.clear_cached_public_voice_ids_cache()
        call_count = 0

        class _FailingRepo:
            def __init__(self, _s):
                pass

            async def list_active_public_voice_ids(self):
                nonlocal call_count
                call_count += 1
                raise RuntimeError("db down")

        fake_cm = MagicMock()
        fake_cm.__aenter__ = AsyncMock(return_value=MagicMock())
        fake_cm.__aexit__ = AsyncMock(return_value=False)
        with (
            patch("app.services.tts_audio_cache_service.AsyncSessionLocal", return_value=fake_cm),
            patch("app.services.tts_audio_cache_service.TtsAudioCacheRepository", _FailingRepo),
        ):
            r1 = await voice_studio_route._get_cached_public_voice_ids()
            await asyncio.sleep(0.02)
            r2 = await voice_studio_route._get_cached_public_voice_ids()
        self.assertEqual(r1, [])
        self.assertEqual(r2, [])
        self.assertEqual(call_count, 1)
        voice_studio_route.clear_cached_public_voice_ids_cache()

    async def test_turn_inflight_cancellation_does_not_hang_waiter(self) -> None:
        clear_voice_orchestrator_caches()
        started = asyncio.Event()
        gate = asyncio.Event()

        class _SlowLocal(LocalVoiceProvider):
            async def transcribe(self, **_kwargs):
                started.set()
                await gate.wait()
                raise AssertionError("unreachable")

        orch = VoiceOrchestrator(local_provider=_SlowLocal(base_url="http://127.0.0.1:8010"))
        policy = VoicePolicyContext(session_id="s1", page_id="p1", turn_id="t1")
        leader = asyncio.create_task(
            orch.transcribe(audio=b"RIFF", filename="a.wav", content_type="audio/wav", policy=policy)
        )
        await started.wait()
        waiter = asyncio.create_task(
            orch.transcribe(audio=b"RIFF", filename="a.wav", content_type="audio/wav", policy=policy)
        )
        await asyncio.sleep(0.01)
        leader.cancel()
        with self.assertRaises(asyncio.CancelledError):
            await leader
        with self.assertRaises(asyncio.CancelledError):
            await asyncio.wait_for(waiter, timeout=1.0)
        clear_voice_orchestrator_caches()

    async def test_local_and_google_providers_invalid_payloads_phonics_monotonic_and_deferred_reset(
        self,
    ) -> None:
        # 1. providers/__init__.py has no broken top-level __init__
        self.assertNotIn("__init__", providers_pkg.__dict__)

        # 2. LocalVoiceProvider deferred close does not close in-flight client prematurely
        provider = LocalVoiceProvider(base_url="http://127.0.0.1:8010")
        fake_client = MagicMock()
        fake_client.is_closed = False
        fake_client.aclose = AsyncMock()
        provider._client = fake_client
        acquired = provider._acquire_client()
        self.assertIs(acquired, fake_client)
        await provider._reset_client()
        fake_client.aclose.assert_not_awaited()
        await provider._release_client(acquired)
        fake_client.aclose.assert_awaited_once()

        # 3. LocalVoiceProvider synthesize_phonics rejects invalid JSON/base64/NaN and tracks prev_end
        bad_json_resp = MagicMock(status_code=200)
        bad_json_resp.json.side_effect = ValueError("bad json")
        with patch.object(provider, "_post_with_retry", AsyncMock(return_value=bad_json_resp)):
            with self.assertRaises(LocalVoiceTechnicalError) as ctx:
                await provider.synthesize_phonics(steps=[{"id": "s1", "spoken_text": "ba"}])
        self.assertEqual(ctx.exception.status_code, 502)

        nan_resp = MagicMock(status_code=200)
        nan_resp.json.return_value = {
            "audio_base64": base64.b64encode(b"RIFF" + b"\x00" * 40).decode("ascii"),
            "duration_seconds": 1.0,
            "step_timings": [{"id": "s1", "start": float("nan"), "end": 0.5}],
        }
        with patch.object(provider, "_post_with_retry", AsyncMock(return_value=nan_resp)):
            with self.assertRaises(LocalVoiceTechnicalError):
                await provider.synthesize_phonics(steps=[{"id": "s1", "spoken_text": "ba"}])

        overlap_resp = MagicMock(status_code=200)
        overlap_resp.json.return_value = {
            "audio_base64": base64.b64encode(b"RIFF" + b"\x00" * 40).decode("ascii"),
            "duration_seconds": 1.2,
            "step_timings": [
                {"id": "s1", "start": 0.0, "end": 0.6},
                {"id": "s2", "start": 0.3, "end": 1.1},
            ],
        }
        with patch.object(provider, "_post_with_retry", AsyncMock(return_value=overlap_resp)):
            ph = await provider.synthesize_phonics(
                steps=[{"id": "s1", "spoken_text": "b"}, {"id": "s2", "spoken_text": "ba"}]
            )
        self.assertGreaterEqual(ph.step_timings[1].start, ph.step_timings[0].end)

        # 4. GoogleCloudVoiceProvider catches corrupt WAV (wave.Error) cleanly -> 502 VoiceProviderError
        reset_google_cooldowns()
        g_prov = GoogleCloudVoiceProvider(tts_api_key="test-key")
        with patch.object(
            g_prov,
            "_synthesize_wav_raw",
            AsyncMock(return_value=(b"not-a-valid-wav", {"voice_id": "google_vi_vn_neural2_a", "region": "north"})),
        ):
            with self.assertRaises(VoiceProviderError) as g_ctx:
                await g_prov.synthesize_timed(words=["mèo"], voice_id="google_vi_vn_neural2_a")
        self.assertEqual(g_ctx.exception.status_code, 502)

    async def test_voice_routes_fallback_reason_magic_bytes_ws_limits_and_bootstrap_terminate(
        self,
    ) -> None:
        clear_rate_limits()
        app = FastAPI()
        app.include_router(voice_routes.router, prefix="/voice")
        actor_id = uuid4()
        app.dependency_overrides[require_active_profile_id] = lambda: actor_id

        fallback_audio = LocalSynthesizedAudio(
            content=b"RIFF" + struct.pack("<I", 36) + b"WAVE" + b"\x00" * 32,
            content_type="audio/wav",
            resolved_voice_id="google_vi_vn_neural2_a",
            region="north",
            model_version="google-cloud-tts-v1",
            provider="google",
            used_fallback_voice=True,
            fallback_reason="LOCAL_TTS_TIMEOUT",
        )
        fake_orch = SimpleNamespace(
            synthesize=AsyncMock(return_value=fallback_audio),
            transcribe=AsyncMock(),
            local=SimpleNamespace(
                get_ws_stt_url=lambda: "ws://127.0.0.1:8010/stt/stream",
                get_ws_auth_headers=lambda: {},
                _schedule_background_recovery=lambda: None,
            ),
        )
        with patch.object(voice_routes, "get_voice_orchestrator", return_value=fake_orch):
            with TestClient(app) as client:
                # 1. X-Voice-Fallback-Reason header on TTS fallback
                tts_resp = client.post(
                    "/voice/text-to-speech",
                    json={"text": "Xin chào", "provider_mode": "local_with_google_fallback", "allow_google_tts": True},
                )
                self.assertEqual(tts_resp.status_code, 200)
                self.assertEqual(tts_resp.headers.get("x-voice-fallback"), "1")
                self.assertEqual(tts_resp.headers.get("x-voice-fallback-reason"), "LOCAL_TTS_TIMEOUT")

                # 2. STT rejects non-audio bytes when content_type is absent
                stt_bad = client.post(
                    "/voice/speech-to-text",
                    files={"file": ("payload.bin", b"<html>not audio</html>", "")},
                )
                self.assertEqual(stt_bad.status_code, 415)

                # 3. WS rejects disallowed Origin header
                with self.assertRaises(WebSocketDisconnect):
                    with client.websocket_connect(
                        "/voice/stt-stream", headers={"Origin": "https://evil.example"}
                    ):
                        pass

                # 4. WS enforces max binary message size -> MESSAGE_TOO_LARGE + close 1009
                class _IdleFakeWorker:
                    async def send(self, _data):
                        pass

                    def __aiter__(self):
                        return self

                    async def __anext__(self):
                        await asyncio.sleep(5)
                        raise StopAsyncIteration

                @asynccontextmanager
                async def _fake_open_ws(_url, _headers):
                    yield _IdleFakeWorker()

                with patch.object(voice_routes, "open_local_stt_ws", _fake_open_ws):
                    with client.websocket_connect("/voice/stt-stream") as ws:
                        ws.send_bytes(b"\x00" * (voice_routes._WS_MAX_BINARY_BYTES + 16))
                        err = ws.receive_json()
                        self.assertEqual(err["code"], "MESSAGE_TOO_LARGE")
                        with self.assertRaises(WebSocketDisconnect) as ws_ctx:
                            ws.receive_text()
                        self.assertEqual(ws_ctx.exception.code, 1009)

        # 5. Bootstrap terminates unfinished PowerShell process on stop_event
        fake_proc = MagicMock()
        fake_proc.poll.return_value = None
        fake_proc.terminate = MagicMock()
        fake_proc.wait = MagicMock(return_value=0)
        stop_ev = asyncio.Event()
        bootstrap_mod.reset_local_voice_worker_bootstrap_state()

        async def _health_then_stop(_url: str) -> bool:
            stop_ev.set()
            return False

        with (
            patch.object(
                bootstrap_mod, "should_autostart_local_voice_worker", return_value=(True, "eligible")
            ),
            patch.object(bootstrap_mod, "_is_worker_healthy", side_effect=[False, False, False]),
            patch.object(bootstrap_mod.subprocess, "Popen", return_value=fake_proc),
            patch.object(bootstrap_mod, "_is_worker_healthy", side_effect=[False, False]),
        ):
            stop_ev.set()
            # Pre-arm stop_event right after Popen by using a side_effect on Popen
            stop_ev.clear()

            def _popen_and_signal(*_a, **_kw):
                stop_ev.set()
                return fake_proc

            with patch.object(bootstrap_mod.subprocess, "Popen", side_effect=_popen_and_signal):
                ok = await bootstrap_mod.ensure_local_voice_worker_running(stop_event=stop_ev)
        self.assertFalse(ok)
        fake_proc.terminate.assert_called_once()


if __name__ == "__main__":
    unittest.main()
