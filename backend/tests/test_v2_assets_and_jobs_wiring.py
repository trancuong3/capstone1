"""Comprehensive Wave 2A-2 CPU-only contract & wiring tests for ViRead AI Smart Book Studio V2.

Covers:
- G-08: AiCapabilityRouter 2025/2026 free-tier defaults, env overrides, 0 VND Gemini Image opt-in,
        Cloudflare privacy skip, local Diffusers /generate + loopback + 10 MiB cap.
- G-09: GpuWorkloadScheduler VIREAD_GPU_MAX_VRAM_MB (default 3600) + sync/async `run_sync` bridge.
- G-05: BookCoverService router+scheduler wiring, mandatory Dual Text-Free Gate on AI covers,
        double-SmartStudioJob elimination (`enqueue_ai_cover_job` + `execute_ai_cover_job`),
        `extract_cover_from_page` (`ORIGINAL_CROP`/`ENHANCED_CROP`) + priority + STALE fencing.
- G-06: BookIllustrationService `_build_default_ocr_check_fn()`, explicit `ocr_gate_mode`
        reporting (`tesseract_ocr` / `hybrid_ocr` / `opencv_only_remote_worker`), route wiring,
        router+scheduler dispatch, double-job elimination.
- G-07: GlobalTasksService `OCR_EXTRACT` & `BATCH_BOOK_IMPORT` real handlers, `retry_task`
        worker wakeup, GPU scheduler wrapping, 0 nested jobs for cover/illustration.
- G-04: AdminOcrCorrectionJobManager durable SmartStudioJob mirroring, restart survival,
        Global Task Center visibility, and zero worker-steal collision.
- Wave 2C: `scripts/local_image_gen_worker.py` CPU-only HTTP contract & PowerShell script hygiene.
"""
from __future__ import annotations

import asyncio
import base64
import importlib.util
import json
import os
from datetime import datetime, timezone
from io import BytesIO
from pathlib import Path
import sys
import tempfile
import threading
import time
import unittest
from typing import Any
from unittest.mock import AsyncMock, MagicMock, patch
from uuid import UUID, uuid4

_BACKEND_DIR = Path(__file__).resolve().parents[1]
_REPO_ROOT = _BACKEND_DIR.parent
if str(_BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(_BACKEND_DIR))

os.environ["APP_ENVIRONMENT"] = "test"
os.environ.setdefault("DATABASE_URL", "postgresql+asyncpg://test:test@127.0.0.1:1/test")
os.environ.setdefault("SUPABASE_URL", "https://example.supabase.co")
os.environ.setdefault("SUPABASE_KEY", "isolated-test-key")
os.environ.setdefault("SUPABASE_STORAGE_BUCKET", "viread-test-catalog")
os.environ.setdefault("SUPABASE_PRIVATE_BOOKS_BUCKET", "viread-test-private")
os.environ.setdefault("VIREAD_LOCAL_VOICE_WORKER_AUTOSTART", "false")

import cv2
from fastapi import FastAPI
from fastapi.testclient import TestClient
import httpx
import numpy as np
from PIL import Image, ImageDraw

from app.api.deps import get_current_parent_id, get_db
from app.api.routes import admin_ocr as admin_ocr_route
from app.api.routes import book_assets as book_assets_route
from app.models import (
    Book,
    BookPage,
    BookPresentationAsset,
    PageOcrExtraction,
    PageRevision,
    PageRevisionWord,
    Profile,
    SmartStudioJob,
)
from app.schemas.book_assets import (
    BookCoverGenerateRequest,
    PageIllustrationExtractRequest,
    PageIllustrationGenerateRequest,
)
from app.schemas.global_tasks import GlobalTaskCreateRequest
from app.services.admin_ocr_jobs import (
    AdminOcrCorrectionJobManager,
    admin_ocr_correction_jobs,
)
from app.services.admin_ocr_local import LocalOcrConfig
from app.services.admin_ocr_service import AdminOcrService, PreparedLocalOcrCorrection
from app.services.ai_capability_router import (
    AiCapability,
    AiCapabilityRouter,
    AiErrorKind,
    AiRoutingError,
    ImageGenerationRequest,
    build_default_provider_registry,
    reset_default_ai_router,
)
from app.services.book_cover_service import BookCoverService, detect_image_generation_provider
from app.services.book_illustration_service import (
    BookIllustrationService,
    _build_default_ocr_check_fn,
    verify_illustration_text_free,
)
from app.services.global_tasks_service import (
    GlobalTasksService,
    process_one_smart_studio_job,
)
from app.services.gpu_workload_scheduler import (
    DEFAULT_GPU_MAX_VRAM_MB,
    GpuWorkloadScheduler,
    WorkloadPriority,
    reset_default_gpu_scheduler,
)
from app.services.ocr_ai.config import OcrCorrectionConfig

# Reuse deterministic in-memory AsyncSession double from existing router test suite
from test_durable_workflows_and_router import (  # noqa: E402
    FakeStudioAsyncSession,
    StudioDbState,
    _ScalarResult,
    _eval_clause,
    _resolve_col_val,
)


class _ExtendedFakeStudioSession(FakeStudioAsyncSession):
    """Extends FakeStudioAsyncSession with Update, aggregate max, and BookPage+Book joins."""

    def _model_for_table(self, table_name: str | None):
        return next(
            (c for c in self.state.tables if getattr(c, "__tablename__", None) == table_name),
            None,
        )

    async def execute(self, query: Any) -> Any:
        # Handle SQLAlchemy Update statements (e.g. deactivate_existing covers/illustrations)
        if type(query).__name__ == "Update":
            table_name = getattr(getattr(query, "table", None), "name", None)
            model_cls = self._model_for_table(table_name)
            rows = list(self.state.tables.get(model_cls, [])) if model_cls else []
            for crit in getattr(query, "_where_criteria", ()):
                rows = [r for r in rows if _eval_clause(r, crit)]
            values_map = getattr(query, "_values", None) or {}
            updated = 0
            for row in rows:
                for col_key, val_expr in values_map.items():
                    attr_name = getattr(col_key, "name", str(col_key))
                    raw_val = getattr(val_expr, "value", val_expr)
                    if hasattr(row, "__mapper__"):
                        for attr in row.__mapper__.attrs:
                            cols = getattr(attr, "columns", ())
                            if cols and cols[0].name == attr_name:
                                setattr(row, attr.key, raw_val)
                                break
                updated += 1
            return MagicMock(rowcount=updated)

        col_descs = getattr(query, "column_descriptions", None) or []
        # Handle multi-entity select(BookPage, Book) join
        if len(col_descs) == 2 and col_descs[0].get("entity") is BookPage and col_descs[1].get("entity") is Book:
            pairs: list[tuple[Any, Any]] = []
            for page in self.state.tables.get(BookPage, []):
                book = next((b for b in self.state.tables.get(Book, []) if b.Id == page.BookId), None)
                if book is None:
                    continue
                ok = True
                for crit in getattr(query, "_where_criteria", ()):
                    left_tbl = getattr(getattr(getattr(crit, "left", None), "table", None), "name", None)
                    target_row = book if left_tbl == "books" else page
                    if not _eval_clause(target_row, crit):
                        ok = False
                        break
                if ok:
                    pairs.append((page, book))
            return _ScalarResult(pairs)

        # Handle multi-column PageRevision sample texts select(...)
        if len(col_descs) == 3 and getattr(col_descs[0].get("entity"), "__tablename__", None) == "pagerevisions":
            book_map = {p.Id: p for p in self.state.tables.get(BookPage, [])}
            revs = []
            for rev in self.state.tables.get(PageRevision, []):
                page = book_map.get(rev.PageId)
                if page is None:
                    continue
                ok = True
                for crit in getattr(query, "_where_criteria", ()):
                    left_tbl = getattr(getattr(getattr(crit, "left", None), "table", None), "name", None)
                    target_row = page if left_tbl == "bookpages" else rev
                    if not _eval_clause(target_row, crit):
                        ok = False
                        break
                if ok:
                    revs.append((rev.VerifiedText, rev.DraftText, rev.OriginalOcrText))
            return _ScalarResult(revs)

        return await super().execute(query)

    async def scalar(self, query: Any) -> Any | None:
        col_descs = getattr(query, "column_descriptions", None) or []
        if col_descs:
            expr = col_descs[0].get("expr")
            # Handle func.coalesce(func.max(BookPresentationAsset.AssetVersion), 0)
            if type(expr).__name__ == "coalesce":
                rows = list(self.state.tables.get(BookPresentationAsset, []))
                for crit in getattr(query, "_where_criteria", ()):
                    rows = [r for r in rows if _eval_clause(r, crit)]
                return max((int(r.AssetVersion or 0) for r in rows), default=0)
        return await super().scalar(query)
from test_book_assets import (  # noqa: E402
    ADMIN_ID,
    CATALOG_BOOK_ID,
    PAGE_A_ID,
    PARENT_A_ID,
    PARENT_B_ID,
    PRIVATE_BOOK_A_ID,
    InMemoryBookAssetsStore,
    _make_image_bytes,
    _make_storybook_page_png,
    _make_text_laden_illustration_bgr,
    _patch_repository_with_store,
)


def _encode_png(bgr: np.ndarray) -> bytes:
    ok, raw = cv2.imencode(".png", bgr)
    assert ok
    return raw.tobytes()


class AiRouterV2DefaultsAndTransportTests(unittest.IsolatedAsyncioTestCase):
    """G-08: 2025/2026 free-tier defaults, 0 VND Gemini Image opt-in, local /generate & size caps."""

    def tearDown(self) -> None:
        reset_default_ai_router()

    def test_default_free_tier_models_and_env_overrides_and_zero_vnd_gemini_image(self) -> None:
        base_env = {
            "OCR_CLOUD_CORRECTION_ENABLED": "true",
            "GEMINI_API_KEY": "fake-gemini",
            "GROQ_API_KEY": "fake-groq",
            "CLOUDFLARE_ACCOUNT_ID": "cf-acc",
            "CLOUDFLARE_API_TOKEN": "cf-tok",
            "LOCAL_IMAGE_GEN_URL": "http://127.0.0.1:8090",
        }
        specs = {p.provider_id: p for p in build_default_provider_registry(env=base_env)}
        self.assertEqual(specs["gemini_primary"].model_id, "gemini-3.1-flash-lite")
        self.assertEqual(specs["gemini_fallback"].model_id, "gemini-3.5-flash-lite")
        self.assertEqual(specs["groq_qwen"].model_id, "qwen/qwen3.8-27b")
        self.assertEqual(
            specs["cloudflare_flux"].model_id, "@cf/black-forest-labs/flux-1-schnell"
        )
        # Strict 0 VND invariant: Gemini Image stays DISABLED without explicit paid opt-in!
        self.assertFalse(specs["gemini_image"].enabled)

        # Env overrides respected + explicit GEMINI_IMAGE_GEN_PAID_OPT_IN enables Gemini Image
        override_env = {
            **base_env,
            "GEMINI_OCR_PRIMARY_MODEL": "gemini-2.5-flash-preview",
            "GEMINI_OCR_FALLBACK_MODEL": "gemini-2.5-flash-lite",
            "GROQ_OCR_MODEL": "meta-llama/llama-4-scout-17b-16e-instruct",
            "GEMINI_IMAGE_GEN_PAID_OPT_IN": "true",
        }
        override_specs = {
            p.provider_id: p for p in build_default_provider_registry(env=override_env)
        }
        self.assertEqual(
            override_specs["gemini_primary"].model_id, "gemini-2.5-flash-preview"
        )
        self.assertEqual(
            override_specs["groq_qwen"].model_id,
            "meta-llama/llama-4-scout-17b-16e-instruct",
        )
        self.assertTrue(override_specs["gemini_image"].enabled)

    async def test_local_diffusers_contract_loopback_enforcement_and_private_cloud_skip(
        self,
    ) -> None:
        env = {
            "SMART_AI_IMAGE_GEN_ENABLED": "true",
            "CLOUDFLARE_ACCOUNT_ID": "cf-acc",
            "CLOUDFLARE_API_TOKEN": "cf-tok",
            "LOCAL_IMAGE_GEN_URL": "http://127.0.0.1:8090/",
        }
        router = AiCapabilityRouter(env=env)
        captured: list[tuple[str, dict[str, Any]]] = []
        clean_png = _make_image_bytes("PNG", (512, 768))

        async def mock_handler(request: httpx.Request) -> httpx.Response:
            body = json.loads(request.content.decode("utf-8"))
            captured.append((str(request.url), body))
            return httpx.Response(
                200,
                json={
                    "image_base64": base64.b64encode(clean_png).decode("ascii"),
                    "mime_type": "image/png",
                    "width": 512,
                    "height": 768,
                    "elapsed_ms": 250,
                },
            )

        # allow_cloud=False MUST skip Cloudflare and post strictly to /generate with full payload!
        result = await router.generate_image(
            ImageGenerationRequest(
                prompt="Sunny Vietnamese garden watercolor",
                negative_prompt="text, letters",
                width=512,
                height=768,
                steps=4,
                seed=42,
                tenant_scope="parent:user-1",
                allow_cloud=False,
            ),
            transport=httpx.MockTransport(mock_handler),
        )
        self.assertEqual(result.provider_id, "local_diffusers")
        self.assertEqual(result.image_bytes, clean_png)
        self.assertEqual(len(captured), 1)
        url, payload = captured[0]
        self.assertEqual(url, "http://127.0.0.1:8090/generate")
        self.assertEqual(payload["prompt"], "Sunny Vietnamese garden watercolor")
        self.assertEqual(payload["negative_prompt"], "text, letters")
        self.assertEqual(payload["width"], 512)
        self.assertEqual(payload["height"], 768)
        self.assertEqual(payload["steps"], 4)
        self.assertEqual(payload["seed"], 42)
        self.assertTrue(
            any(
                a.provider_id == "cloudflare_flux" and a.outcome == "SKIPPED_PRIVACY_POLICY"
                for a in result.attempts
            )
        )

        # Non-loopback URL blocked unless LOCAL_IMAGE_GEN_ALLOW_LAN=true
        lan_router = AiCapabilityRouter(
            env={
                "SMART_AI_IMAGE_GEN_ENABLED": "true",
                "LOCAL_IMAGE_GEN_URL": "http://192.168.1.50:8090",
            }
        )
        with self.assertRaises(AiRoutingError) as ctx:
            await lan_router.generate_image(
                ImageGenerationRequest(prompt="Test", allow_cloud=False),
                transport=httpx.MockTransport(mock_handler),
            )
        self.assertEqual(ctx.exception.kind, AiErrorKind.PERMISSION_FAILURE)
        self.assertEqual(ctx.exception.code, "LOCAL_IMAGE_URL_NON_LOOPBACK")

        # Oversized >10 MiB response rejected cleanly
        async def oversized_handler(_request: httpx.Request) -> httpx.Response:
            return httpx.Response(
                200,
                headers={"content-type": "image/png"},
                content=b"\x89PNG\r\n\x1a\n" + b"x" * (10 * 1024 * 1024 + 16),
            )

        cap_router = AiCapabilityRouter(
            env={
                "SMART_AI_IMAGE_GEN_ENABLED": "true",
                "LOCAL_IMAGE_GEN_URL": "http://127.0.0.1:8090",
            }
        )
        with self.assertRaises(AiRoutingError) as cap_ctx:
            await cap_router.generate_image(
                ImageGenerationRequest(prompt="Big response", allow_cloud=False),
                transport=httpx.MockTransport(oversized_handler),
            )
        self.assertEqual(cap_ctx.exception.code, "IMAGE_RESPONSE_TOO_LARGE")


class GpuSchedulerV2BridgeTests(unittest.IsolatedAsyncioTestCase):
    """G-09: VIREAD_GPU_MAX_VRAM_MB env default (3600) and async+sync thread serialization."""

    def tearDown(self) -> None:
        reset_default_gpu_scheduler()

    def test_vram_env_configuration_defaults_to_3600(self) -> None:
        with patch.dict(os.environ, {"VIREAD_GPU_MAX_VRAM_MB": ""}, clear=False):
            sched = GpuWorkloadScheduler()
            self.assertEqual(sched.max_vram_mb, DEFAULT_GPU_MAX_VRAM_MB)
            self.assertEqual(sched.max_vram_mb, 3600)
        with patch.dict(os.environ, {"VIREAD_GPU_MAX_VRAM_MB": "3200"}, clear=False):
            sched_custom = GpuWorkloadScheduler()
            self.assertEqual(sched_custom.max_vram_mb, 3200)

    async def test_run_sync_serializes_with_async_acquire_without_deadlock(self) -> None:
        scheduler = GpuWorkloadScheduler(max_concurrent_gpu_jobs=1, max_vram_mb=3600)
        timeline: list[str] = []
        async_entered = asyncio.Event()
        release_async = asyncio.Event()

        async def hold_async() -> None:
            async with scheduler.acquire(
                priority=WorkloadPriority.COVER_GEN,
                workload_id="async-cover",
                estimated_vram_mb=2200,
            ):
                timeline.append("async_start")
                async_entered.set()
                await release_async.wait()
                timeline.append("async_end")

        holder_task = asyncio.create_task(hold_async())
        await async_entered.wait()

        sync_result: dict[str, Any] = {}
        sync_started_thread = threading.Event()

        def sync_worker() -> None:
            sync_started_thread.set()
            sync_result["value"] = scheduler.run_sync(
                WorkloadPriority.URGENT_OCR,
                "sync-ocr",
                lambda: (timeline.append("sync_ran"), "ocr-ok")[1],
                estimated_vram_mb=1400,
                timeout_seconds=5.0,
            )

        thread = threading.Thread(target=sync_worker, daemon=True)
        thread.start()
        sync_started_thread.wait(timeout=2.0)
        # Brief sleep to prove sync_worker waits while async holder owns the GPU slot
        await asyncio.sleep(0.05)
        self.assertEqual(timeline, ["async_start"])

        release_async.set()
        await holder_task
        thread.join(timeout=5.0)
        self.assertFalse(thread.is_alive())
        self.assertEqual(sync_result["value"], "ocr-ok")
        self.assertEqual(timeline, ["async_start", "async_end", "sync_ran"])


class BookAssetsV2WiringAndTextFreeGateTests(unittest.IsolatedAsyncioTestCase):
    """G-05 & G-06: Router/Scheduler wiring, Dual Text-Free Gate on covers, OCR gate mode, extract_cover_from_page."""

    async def asyncSetUp(self) -> None:
        reset_default_ai_router()
        reset_default_gpu_scheduler()
        self._tmp_dir = tempfile.TemporaryDirectory()
        self._env_patch = patch.dict(
            os.environ,
            {
                "VIREAD_LOCAL_STORAGE_DIR": self._tmp_dir.name,
                "VIREAD_OCR_MODE": "remote_worker",
                "CLOUDFLARE_ACCOUNT_ID": "",
                "CLOUDFLARE_API_TOKEN": "",
                "LOCAL_IMAGE_GEN_URL": "",
                "PRIVATE_BOOK_ALLOW_CLOUD_AI": "false",
            },
            clear=False,
        )
        self._env_patch.start()
        self.store = InMemoryBookAssetsStore()
        self.db = self.store.make_fake_db()
        self._repo_patch = _patch_repository_with_store(self.store)
        self._repo_patch.start()

    async def asyncTearDown(self) -> None:
        self._repo_patch.stop()
        self._env_patch.stop()
        self._tmp_dir.cleanup()
        reset_default_ai_router()
        reset_default_gpu_scheduler()

    async def test_ai_cover_uses_router_and_scheduler_and_enforces_dual_text_free_gate(
        self,
    ) -> None:
        clean_png = _make_image_bytes("PNG", (512, 768), color=(110, 190, 220))
        text_png = _encode_png(_make_text_laden_illustration_bgr())

        scheduler = GpuWorkloadScheduler(max_concurrent_gpu_jobs=1, max_vram_mb=3600)
        router_env = {
            "SMART_AI_IMAGE_GEN_ENABLED": "true",
            "LOCAL_IMAGE_GEN_URL": "http://127.0.0.1:8090",
        }
        router = AiCapabilityRouter(env=router_env)

        with patch.dict(os.environ, router_env, clear=False):
            # 1) Text-laden AI cover MUST BE REJECTED by Dual Text-Free Gate!
            with patch.object(
                router,
                "generate_image",
                new=AsyncMock(
                    return_value=MagicMock(
                        image_bytes=text_png,
                        mime_type="image/png",
                        provider_id="local_diffusers",
                        model_id="Lykon/dreamshaper-8+lcm-lora-sdv1-5",
                    )
                ),
            ) as gen_mock:
                svc_bad = BookCoverService(
                    self.db,
                    ai_router=router,
                    gpu_scheduler=scheduler,
                )
                bad_res = await svc_bad.generate_ai_cover(
                    ADMIN_ID, CATALOG_BOOK_ID, BookCoverGenerateRequest(prompt_hint="Nắng sớm")
                )
                self.assertEqual(bad_res.status, "REJECTED_CONTAINS_TEXT")
                self.assertFalse(bad_res.honest_ai_generated)
                self.assertIsNone(bad_res.cover)
                self.assertEqual(len(self.store.assets), 0)
                gen_mock.assert_awaited_once()
                req_arg = gen_mock.await_args.args[0]
                self.assertEqual((req_arg.width, req_arg.height, req_arg.steps), (512, 768, 4))
                self.assertEqual(scheduler.get_status()["total_completed"], 1)

            # 2) Clean visual cover + OCR callback reporting text overlap -> ALSO REJECTED!
            def fake_ocr_finds_title(_raw: bytes) -> str:
                return "Khu vuon nang som cua meo con"

            setattr(fake_ocr_finds_title, "_ocr_gate_mode", "tesseract_ocr")
            with patch.object(
                router,
                "generate_image",
                new=AsyncMock(
                    return_value=MagicMock(
                        image_bytes=clean_png,
                        mime_type="image/png",
                        provider_id="local_diffusers",
                        model_id="Lykon/dreamshaper-8+lcm-lora-sdv1-5",
                    )
                ),
            ):
                svc_ocr_reject = BookCoverService(
                    self.db,
                    ai_router=router,
                    gpu_scheduler=scheduler,
                    ocr_check_fn=fake_ocr_finds_title,
                )
                ocr_rej = await svc_ocr_reject.generate_ai_cover(
                    ADMIN_ID, CATALOG_BOOK_ID, BookCoverGenerateRequest()
                )
                self.assertEqual(ocr_rej.status, "REJECTED_CONTAINS_TEXT")
                self.assertIsNone(ocr_rej.cover)

            # 3) Clean visual cover + clean OCR callback -> SUCCEEDED with ocr_gate_mode recorded!
            def fake_ocr_clean(_raw: bytes) -> str:
                return ""

            setattr(fake_ocr_clean, "_ocr_gate_mode", "tesseract_ocr")
            with patch.object(
                router,
                "generate_image",
                new=AsyncMock(
                    return_value=MagicMock(
                        image_bytes=clean_png,
                        mime_type="image/png",
                        provider_id="local_diffusers",
                        model_id="Lykon/dreamshaper-8+lcm-lora-sdv1-5",
                    )
                ),
            ):
                svc_ok = BookCoverService(
                    self.db,
                    ai_router=router,
                    gpu_scheduler=scheduler,
                    ocr_check_fn=fake_ocr_clean,
                )
                ok_res = await svc_ok.generate_ai_cover(
                    ADMIN_ID, CATALOG_BOOK_ID, BookCoverGenerateRequest()
                )
                self.assertEqual(ok_res.status, "SUCCEEDED")
                self.assertTrue(ok_res.honest_ai_generated)
                self.assertIsNotNone(ok_res.cover)
                self.assertEqual(ok_res.cover.metadata["ocr_gate_mode"], "tesseract_ocr")  # type: ignore[union-attr]
                self.assertTrue(ok_res.cover.metadata["ocr_checked"])  # type: ignore[union-attr]

            # Provider detection normalizes /generate endpoint cleanly
            avail = detect_image_generation_provider(is_private_book=True, router=router)
            self.assertTrue(avail.available)
            self.assertEqual(avail.endpoint_url, "http://127.0.0.1:8090/generate")

    async def test_extract_cover_from_page_priority_and_stale_fencing_and_http_route(
        self,
    ) -> None:
        page_png, _, _ = _make_storybook_page_png()
        inflight = SmartStudioJob(
            Id=uuid4(),
            JobType="COVER_GENERATE",
            ActorId=PARENT_A_ID,
            ActorRole="parent",
            BookId=PRIVATE_BOOK_A_ID,
            InputHash="a" * 64,
            IdempotencyKey="inflight-page-cover",
            Stage="IMAGE_GENERATING",
            Status="RUNNING",
            Priority=40,
            AttemptCount=1,
            MaxAttempts=3,
            CreatedAt=datetime.now(timezone.utc),
            UpdatedAt=datetime.now(timezone.utc),
        )
        self.store.jobs[inflight.Id] = inflight

        svc = BookCoverService(self.db)
        # 1) Extract ENHANCED_CROP cover from page -> activates & marks in-flight AI cover STALE
        enhanced = await svc.extract_cover_from_page(
            PRIVATE_BOOK_A_ID,
            PAGE_A_ID,
            PARENT_A_ID,
            "parent",
            apply_clahe_restore=True,
            page_image_bytes_override=page_png,
        )
        self.assertEqual(enhanced.source_type, "ENHANCED_CROP")
        self.assertTrue(enhanced.is_active)
        self.assertEqual(self.store.jobs[inflight.Id].Status, "STALE")

        summary = await svc.get_book_assets_summary(PARENT_A_ID, PRIVATE_BOOK_A_ID)
        self.assertIsNotNone(summary.active_cover)
        self.assertEqual(summary.active_cover.id, enhanced.id)  # type: ignore[union-attr]

        # 2) Upload USER_UPLOAD cover -> then extract ORIGINAL_CROP without force_replace -> USER_UPLOAD wins!
        user_cover = await svc.upload_user_cover(
            PARENT_A_ID,
            PRIVATE_BOOK_A_ID,
            _make_image_bytes("PNG", (600, 800)),
            "image/png",
        )
        orig_crop = await svc.extract_cover_from_page(
            PRIVATE_BOOK_A_ID,
            PAGE_A_ID,
            PARENT_A_ID,
            "parent",
            apply_clahe_restore=False,
            page_image_bytes_override=page_png,
        )
        self.assertEqual(orig_crop.source_type, "ORIGINAL_CROP")
        self.assertFalse(orig_crop.is_active)
        summary_after = await svc.get_book_assets_summary(PARENT_A_ID, PRIVATE_BOOK_A_ID)
        self.assertEqual(summary_after.effective_cover_source, "USER_UPLOAD")
        self.assertEqual(summary_after.active_cover.id, user_cover.id)  # type: ignore[union-attr]

        # 3) HTTP route POST /studio/books/{book_id}/cover/from-page enforces RBAC/IDOR + no-store
        app = FastAPI()
        app.include_router(book_assets_route.router, prefix="/studio")
        actor_ref = {"id": PARENT_B_ID}
        app.dependency_overrides[get_current_parent_id] = lambda: actor_ref["id"]

        async def _db_override():
            yield self.db

        app.dependency_overrides[get_db] = _db_override
        with patch(
            "app.services.book_cover_service.download_object",
            return_value=page_png,
        ):
            async with httpx.AsyncClient(
                transport=httpx.ASGITransport(app=app),
                base_url="http://testserver",
            ) as client:
                # Non-owner Parent B gets 404
                r_idor = await client.post(
                    f"/studio/books/{PRIVATE_BOOK_A_ID}/cover/from-page",
                    json={"page_id": str(PAGE_A_ID), "apply_clahe_restore": False},
                )
                self.assertEqual(r_idor.status_code, 404)
                # Owner Parent A succeeds with 201 + no-store
                actor_ref["id"] = PARENT_A_ID
                r_ok = await client.post(
                    f"/studio/books/{PRIVATE_BOOK_A_ID}/cover/from-page",
                    json={"page_id": str(PAGE_A_ID), "apply_clahe_restore": False},
                )
                self.assertEqual(r_ok.status_code, 201, r_ok.text)
                self.assertIn("no-store", r_ok.headers.get("cache-control", ""))
                self.assertEqual(r_ok.json()["source_type"], "ORIGINAL_CROP")

    async def test_ocr_gate_mode_reporting_and_route_wiring(self) -> None:
        # 1) Remote worker mode returns None -> explicitly reports opencv_only_remote_worker
        with patch.dict(os.environ, {"VIREAD_OCR_MODE": "remote_worker"}, clear=False):
            self.assertIsNone(_build_default_ocr_check_fn())

        page_png, word_bboxes, canonical_text = _make_storybook_page_png()
        self.store.page_contexts[PAGE_A_ID] = (uuid4(), canonical_text, word_bboxes)

        svc_remote = BookIllustrationService(self.db, ocr_check_fn=None)
        res_remote = await svc_remote.extract_page_illustration(
            PARENT_A_ID,
            PRIVATE_BOOK_A_ID,
            PAGE_A_ID,
            PageIllustrationExtractRequest(),
            page_image_bytes_override=page_png,
        )
        self.assertEqual(res_remote.status, "EXTRACTED_VERIFIED")
        self.assertEqual(res_remote.asset.metadata["ocr_gate_mode"], "opencv_only_remote_worker")  # type: ignore[union-attr]
        self.assertFalse(res_remote.asset.metadata["ocr_checked"])  # type: ignore[union-attr]

        # 2) Local OCR callback sets explicit tesseract_ocr / hybrid_ocr mode
        def stub_tesseract(_raw: bytes) -> str:
            return ""

        setattr(stub_tesseract, "_ocr_gate_mode", "tesseract_ocr")
        svc_local = BookIllustrationService(self.db, ocr_check_fn=stub_tesseract)
        res_local = await svc_local.extract_page_illustration(
            PARENT_A_ID,
            PRIVATE_BOOK_A_ID,
            PAGE_A_ID,
            PageIllustrationExtractRequest(),
            page_image_bytes_override=page_png,
        )
        self.assertEqual(res_local.asset.metadata["ocr_gate_mode"], "tesseract_ocr")  # type: ignore[union-attr]
        self.assertTrue(res_local.asset.metadata["ocr_checked"])  # type: ignore[union-attr]

        # 3) Verify HTTP route calls _build_default_ocr_check_fn() so ocr_check_fn is wired in production!
        app = FastAPI()
        app.include_router(book_assets_route.router, prefix="/studio")
        app.dependency_overrides[get_current_parent_id] = lambda: PARENT_A_ID

        async def _db_override():
            yield self.db

        app.dependency_overrides[get_db] = _db_override
        called_checker = {"count": 0}

        def spy_ocr(_raw: bytes) -> str:
            called_checker["count"] += 1
            return ""

        setattr(spy_ocr, "_ocr_gate_mode", "tesseract_ocr")
        with (
            patch.object(book_assets_route, "_build_default_ocr_check_fn", return_value=spy_ocr),
            patch("app.services.book_illustration_service.download_object", return_value=page_png),
        ):
            async with httpx.AsyncClient(
                transport=httpx.ASGITransport(app=app),
                base_url="http://testserver",
            ) as client:
                resp = await client.post(
                    f"/studio/books/{PRIVATE_BOOK_A_ID}/pages/{PAGE_A_ID}/illustration/extract",
                    json={},
                )
        self.assertEqual(resp.status_code, 200, resp.text)
        self.assertEqual(called_checker["count"], 1)
        self.assertEqual(resp.json()["asset"]["metadata"]["ocr_gate_mode"], "tesseract_ocr")

    def test_text_free_gate_trusts_clean_real_ocr_on_textured_art_but_rejects_text_and_opencv_only(
        self,
    ) -> None:
        """#119 regression: high-texture artwork with clean real OCR passes; text or ocr=None still fails."""
        from app.services.book_illustration_service import verify_illustration_text_free

        # Build a high-frequency textured pattern that triggers OpenCV glyph-band heuristics
        h, w = 512, 512
        textured = np.full((h, w, 3), 235, dtype=np.uint8)
        for row in range(60, 440, 38):
            for col in range(30, 470, 22):
                cv2.rectangle(textured, (col, row), (col + 10, row + 18), (35, 70, 45), -1)

        # 1) Without OCR (opencv_only_remote_worker) -> MUST still reject strictly!
        res_no_ocr = verify_illustration_text_free(textured, ocr_check_fn=None)
        self.assertFalse(res_no_ocr.text_free_verified)
        self.assertEqual(res_no_ocr.ocr_gate_mode, "opencv_only_remote_worker")
        self.assertGreaterEqual(res_no_ocr.text_density_score, 0.08)

        # 2) With real OCR returning clean "" or single-char noise "W" -> MUST PASS!
        def _clean_ocr(_raw: bytes) -> str:
            return "W"

        setattr(_clean_ocr, "_ocr_gate_mode", "tesseract_ocr")
        res_clean_ocr = verify_illustration_text_free(textured, ocr_check_fn=_clean_ocr)
        self.assertTrue(res_clean_ocr.text_free_verified)
        self.assertTrue(res_clean_ocr.ocr_checked)
        self.assertEqual(res_clean_ocr.ocr_overlap_score, 0.0)

        # 3) With real OCR detecting >= 2-char words (e.g. "CHƯƠNG 1 - MÈO CON") -> MUST REJECT!
        def _text_ocr(_raw: bytes) -> str:
            return "CHƯƠNG 1 - MÈO CON"

        setattr(_text_ocr, "_ocr_gate_mode", "tesseract_ocr")
        res_dirty_ocr = verify_illustration_text_free(textured, ocr_check_fn=_text_ocr)
        self.assertFalse(res_dirty_ocr.text_free_verified)
        self.assertTrue(res_dirty_ocr.ocr_checked)
        self.assertGreaterEqual(res_dirty_ocr.ocr_overlap_score, 0.15)

        # 4) Even with clean OCR, bbox overlap >= 0.05 -> MUST STILL REJECT!
        res_bbox = verify_illustration_text_free(
            textured,
            crop_bbox_norm=[0.0, 0.0, 1.0, 1.0],
            word_bboxes=[[0.1, 0.1, 0.2, 0.05]],
            ocr_check_fn=_clean_ocr,
        )
        self.assertFalse(res_bbox.text_free_verified)
        self.assertGreaterEqual(res_bbox.bbox_overlap_score, 0.05)


class GlobalTasksV2WorkersAndZeroDuplicateJobsTests(unittest.IsolatedAsyncioTestCase):
    """G-07: No duplicate SmartStudioJobs, real OCR_EXTRACT & BATCH_BOOK_IMPORT, retry wakeup."""

    def setUp(self) -> None:
        reset_default_ai_router()
        reset_default_gpu_scheduler()
        self._tmp_dir = tempfile.TemporaryDirectory()
        self._env_patch = patch.dict(
            os.environ,
            {
                "VIREAD_LOCAL_STORAGE_DIR": self._tmp_dir.name,
                "VIREAD_OCR_MODE": "remote_worker",
                "SMART_OCR_FILTER_MODE": "active",
            },
            clear=False,
        )
        self._env_patch.start()
        self.state = StudioDbState()
        self.state.tables.setdefault(PageRevisionWord, [])
        self.state.tables.setdefault(PageOcrExtraction, [])
        self.db = _ExtendedFakeStudioSession(self.state)
        self.admin_id = uuid4()
        self.book_id = uuid4()
        self.page1_id = uuid4()
        self.page2_id = uuid4()
        self.rev1_id = uuid4()
        self.rev2_id = uuid4()
        now = datetime.now(timezone.utc)
        self.db.add_all(
            [
                Profile(Id=self.admin_id, Role="admin", Active=1),
                Book(
                    Id=self.book_id,
                    Title="Khu vườn của bé",
                    Author="Tác giả thử nghiệm",
                    MinGrade=1,
                    MaxGrade=3,
                    LifecycleStatus="ACTIVE",
                    VisibilityScope="CATALOG",
                    IsDeleted=False,
                ),
                BookPage(
                    Id=self.page1_id,
                    BookId=self.book_id,
                    PageNumber=1,
                    ImagePath="books/test/p1.png",
                    Width=800,
                    Height=1000,
                    CurrentVerifiedRevisionId=self.rev1_id,
                    LifecycleStatus="ACTIVE",
                ),
                BookPage(
                    Id=self.page2_id,
                    BookId=self.book_id,
                    PageNumber=2,
                    ImagePath="books/test/p2.png",
                    Width=800,
                    Height=1000,
                    CurrentVerifiedRevisionId=self.rev2_id,
                    LifecycleStatus="ACTIVE",
                ),
                PageRevision(
                    Id=self.rev1_id,
                    PageId=self.page1_id,
                    RevisionNo="1",
                    VerificationStatus="VERIFIED",
                    VerifiedText="Ngày xưa có chú mèo nhỏ.",
                    ContentHash="1" * 64,
                    CreatedAt=now,
                ),
                PageRevision(
                    Id=self.rev2_id,
                    PageId=self.page2_id,
                    RevisionNo="1",
                    VerificationStatus="VERIFIED",
                    VerifiedText="Mèo con đi dạo trong vườn hoa.",
                    ContentHash="2" * 64,
                    CreatedAt=now,
                ),
                PageRevisionWord(
                    Id=uuid4(),
                    PageRevisionId=self.rev1_id,
                    WordIndex=0,
                    LineIndex=0,
                    Text="Ngày",
                    NormalizedText="ngay",
                    BoundingBox=[0.1, 0.25, 0.12, 0.04],
                    OCRConfidence=0.95,
                ),
                PageRevisionWord(
                    Id=uuid4(),
                    PageRevisionId=self.rev1_id,
                    WordIndex=1,
                    LineIndex=0,
                    Text="xưa",
                    NormalizedText="xua",
                    BoundingBox=[0.24, 0.25, 0.1, 0.04],
                    OCRConfidence=0.95,
                ),
                PageRevisionWord(
                    Id=uuid4(),
                    PageRevisionId=self.rev2_id,
                    WordIndex=0,
                    LineIndex=0,
                    Text="Mèo",
                    NormalizedText="meo",
                    BoundingBox=[0.1, 0.25, 0.1, 0.04],
                    OCRConfidence=0.96,
                ),
                PageRevisionWord(
                    Id=uuid4(),
                    PageRevisionId=self.rev2_id,
                    WordIndex=1,
                    LineIndex=0,
                    Text="con",
                    NormalizedText="con",
                    BoundingBox=[0.22, 0.25, 0.1, 0.04],
                    OCRConfidence=0.96,
                ),
            ]
        )
        self.svc = GlobalTasksService(self.db)  # type: ignore[arg-type]

    def tearDown(self) -> None:
        self._env_patch.stop()
        self._tmp_dir.cleanup()
        reset_default_ai_router()
        reset_default_gpu_scheduler()

    async def test_ocr_extract_and_batch_book_import_execute_end_to_end(self) -> None:
        scheduler = GpuWorkloadScheduler(max_concurrent_gpu_jobs=1, max_vram_mb=3600)

        # 1) Enqueue and execute OCR_EXTRACT (must SUCCEED, NOT WAITING_FOR_WORKER!)
        ocr_task = await self.svc.create_task(
            actor_id=self.admin_id,
            payload=GlobalTaskCreateRequest(
                job_type="OCR_EXTRACT",
                book_id=self.book_id,
                book_page_id=self.page1_id,
                source_revision_id=self.rev1_id,
                input_hash="e" * 32,
                idempotency_key="ocr-extract-p1",
                priority=80,
                initial_checkpoints={"request": {"detect_boundary": False}},
            ),
        )
        ran_ocr = await process_one_smart_studio_job(
            self.db,  # type: ignore[arg-type]
            worker_id="w-ocr",
            gpu_scheduler=scheduler,
        )
        self.assertTrue(ran_ocr)
        ocr_job = next(j for j in self.state.tables[SmartStudioJob] if j.Id == ocr_task.task.id)
        self.assertEqual(ocr_job.Status, "SUCCEEDED")
        self.assertEqual(ocr_job.ProgressCompleted, 1)
        self.assertEqual(ocr_job.ProgressTotal, 1)
        self.assertEqual(ocr_job.ResultRefJson.get("page_id"), str(self.page1_id))
        self.assertGreaterEqual(len(self.state.tables[PageOcrExtraction]), 1)
        self.assertGreaterEqual(scheduler.get_status()["total_completed"], 1)

        # 2) Enqueue and execute BATCH_BOOK_IMPORT across both pages
        batch_task = await self.svc.create_task(
            actor_id=self.admin_id,
            payload=GlobalTaskCreateRequest(
                job_type="BATCH_BOOK_IMPORT",
                book_id=self.book_id,
                input_hash="b" * 32,
                idempotency_key="batch-book-1",
                priority=20,
            ),
        )
        ran_batch = await process_one_smart_studio_job(
            self.db,  # type: ignore[arg-type]
            worker_id="w-batch",
            gpu_scheduler=scheduler,
        )
        self.assertTrue(ran_batch)
        batch_job = next(
            j for j in self.state.tables[SmartStudioJob] if j.Id == batch_task.task.id
        )
        self.assertEqual(batch_job.Status, "SUCCEEDED")
        self.assertEqual(batch_job.ProgressCompleted, 2)
        self.assertEqual(batch_job.ProgressTotal, 2)
        self.assertEqual(batch_job.ResultRefJson.get("processed_pages"), 2)

    async def test_worker_cover_and_illustration_do_not_spawn_duplicate_smart_studio_jobs(
        self,
    ) -> None:
        clean_png = _make_image_bytes("PNG", (512, 768), color=(90, 180, 140))
        router_env = {
            "SMART_AI_IMAGE_GEN_ENABLED": "true",
            "LOCAL_IMAGE_GEN_URL": "http://127.0.0.1:8090",
        }
        router = AiCapabilityRouter(env=router_env)
        scheduler = GpuWorkloadScheduler(max_concurrent_gpu_jobs=1, max_vram_mb=3600)

        cover_created = await self.svc.create_task(
            actor_id=self.admin_id,
            payload=GlobalTaskCreateRequest(
                job_type="COVER_GENERATE",
                book_id=self.book_id,
                input_hash="c" * 32,
                idempotency_key="single-cover-job",
                priority=40,
            ),
        )
        ill_created = await self.svc.create_task(
            actor_id=self.admin_id,
            payload=GlobalTaskCreateRequest(
                job_type="ILLUSTRATION_GENERATE",
                book_id=self.book_id,
                book_page_id=self.page1_id,
                source_revision_id=self.rev1_id,
                input_hash="i" * 32,
                idempotency_key="single-ill-job",
                priority=30,
            ),
        )
        self.assertEqual(len(self.state.tables[SmartStudioJob]), 2)

        with (
            patch.dict(os.environ, router_env, clear=False),
            patch.object(
                router,
                "generate_image",
                new=AsyncMock(
                    return_value=MagicMock(
                        image_bytes=clean_png,
                        mime_type="image/png",
                        provider_id="local_diffusers",
                        model_id="Lykon/dreamshaper-8+lcm-lora-sdv1-5",
                    )
                ),
            ),
        ):
            ran1 = await process_one_smart_studio_job(
                self.db,  # type: ignore[arg-type]
                worker_id="w-1",
                ai_router=router,
                gpu_scheduler=scheduler,
            )
            ran2 = await process_one_smart_studio_job(
                self.db,  # type: ignore[arg-type]
                worker_id="w-1",
                ai_router=router,
                gpu_scheduler=scheduler,
            )

        self.assertTrue(ran1)
        self.assertTrue(ran2)
        # CRITICAL INVARIANT: STILL EXACTLY 2 SmartStudioJob rows (ZERO duplicate nested jobs!)
        self.assertEqual(len(self.state.tables[SmartStudioJob]), 2)
        cover_job = next(
            j for j in self.state.tables[SmartStudioJob] if j.Id == cover_created.task.id
        )
        ill_job = next(
            j for j in self.state.tables[SmartStudioJob] if j.Id == ill_created.task.id
        )
        self.assertEqual(cover_job.Status, "SUCCEEDED")
        self.assertEqual(ill_job.Status, "SUCCEEDED")
        self.assertIn("asset_id", cover_job.ResultRefJson)
        self.assertIn("asset_id", ill_job.ResultRefJson)

    async def test_retry_task_wakes_smart_studio_worker_immediately(self) -> None:
        created = await self.svc.create_task(
            actor_id=self.admin_id,
            payload=GlobalTaskCreateRequest(
                job_type="OCR_EXTRACT",
                book_id=self.book_id,
                book_page_id=self.page1_id,
                input_hash="r" * 32,
                idempotency_key="retry-wake-1",
            ),
        )
        job_row = self.state.tables[SmartStudioJob][0]
        job_row.Status = "FAILED"

        with patch(
            "app.services.global_tasks_service.notify_smart_studio_worker"
        ) as notify_mock:
            retried = await self.svc.retry_task(
                actor_id=self.admin_id, job_id=created.task.id
            )
        self.assertEqual(retried.task.status, "QUEUED")
        notify_mock.assert_called_once()


class AdminOcrJobsDurabilityTests(unittest.IsolatedAsyncioTestCase):
    """G-04: /admin/pages/{page_id}/ai-correct/jobs durable SmartStudioJob mirror & restart survival."""

    async def test_admin_ai_correct_job_mirrors_to_smart_studio_jobs_and_survives_restart(
        self,
    ) -> None:
        state = StudioDbState()
        db = FakeStudioAsyncSession(state)
        admin_id = uuid4()
        book_id = uuid4()
        page_id = uuid4()
        db.add_all(
            [
                Profile(Id=admin_id, Role="admin", Active=1),
                Book(
                    Id=book_id,
                    Title="Sách soát lỗi AI",
                    MinGrade=1,
                    MaxGrade=5,
                    LifecycleStatus="ACTIVE",
                    VisibilityScope="CATALOG",
                    IsDeleted=False,
                ),
                BookPage(
                    Id=page_id,
                    BookId=book_id,
                    PageNumber=1,
                    ImagePath="books/s1/p1.png",
                    Width=800,
                    Height=1000,
                    LifecycleStatus="ACTIVE",
                ),
            ]
        )

        mgr = AdminOcrCorrectionJobManager()

        async def _sync_to_fake_db(job_obj) -> None:
            await mgr.persist_job_mirror(FakeStudioAsyncSession(state), job_obj)  # type: ignore[arg-type]

        async def _op(progress) -> str:
            progress(1, 2)
            await asyncio.sleep(0)
            progress(2, 2)
            return "Ngày xưa có chú mèo nhỏ."

        job = mgr.submit(
            page_id=page_id,
            actor_id=admin_id,
            total_chunks=2,
            operation=_op,
            book_id=book_id,
            input_hash="f" * 64,
            durable_sync=_sync_to_fake_db,
        )
        mirrored = await mgr.persist_job_mirror(db, job)  # type: ignore[arg-type]
        self.assertTrue(mirrored)
        self.assertEqual(len(state.tables[SmartStudioJob]), 1)

        # Smart studio background worker must NOT steal a QUEUED mirrored job!
        stolen = await process_one_smart_studio_job(
            FakeStudioAsyncSession(state), worker_id="w-check"  # type: ignore[arg-type]
        )
        self.assertFalse(stolen)

        assert job.task is not None
        await job.task
        self.assertEqual(job.status, "SUCCEEDED")

        # Simulate full process restart by wiping RAM dicts!
        mgr._jobs.clear()
        mgr._idempotency.clear()
        self.assertIsNone(mgr.get(job.job_id, admin_id, page_id))

        # Durable lookup MUST recover SUCCEEDED status, chunk counts & corrected text!
        recovered = await mgr.get_durable(
            FakeStudioAsyncSession(state), job.job_id, admin_id, page_id  # type: ignore[arg-type]
        )
        self.assertIsNotNone(recovered)
        assert recovered is not None
        self.assertEqual(recovered.status, "SUCCEEDED")
        self.assertEqual(recovered.completed_chunks, 2)
        self.assertEqual(recovered.total_chunks, 2)
        self.assertEqual(recovered.result, "Ngày xưa có chú mèo nhỏ.")

        # And it MUST appear in Global Task Center for Admin!
        tasks_svc = GlobalTasksService(FakeStudioAsyncSession(state))  # type: ignore[arg-type]
        feed = await tasks_svc.list_tasks(actor_id=admin_id)
        matching = [item for item in feed.tasks if item.id == job.job_id]
        self.assertEqual(len(matching), 1)
        self.assertEqual(matching[0].status, "SUCCEEDED")
        self.assertEqual(matching[0].progress_completed, 2)
        self.assertEqual(matching[0].progress_total, 2)
        self.assertEqual(matching[0].progress_unit, "đoạn")


class LocalImageGenSidecarContractTests(unittest.TestCase):
    """Wave 2C: CPU-only syntax, isolation & HTTP contract check for scripts/local_image_gen_worker.py."""

    def test_sidecar_script_contract_and_windows_launchers_zero_c_drive_cache(self) -> None:
        sidecar_path = _REPO_ROOT / "scripts" / "local_image_gen_worker.py"
        start_ps1 = _REPO_ROOT / "scripts" / "windows" / "start-viread-image-gen-worker.ps1"
        stop_ps1 = _REPO_ROOT / "scripts" / "windows" / "stop-viread-image-gen-worker.ps1"
        self.assertTrue(sidecar_path.is_file())
        self.assertTrue(start_ps1.is_file())
        self.assertTrue(stop_ps1.is_file())

        # Verify backend/app/ never imports local_image_gen_worker
        for py_file in (_BACKEND_DIR / "app").rglob("*.py"):
            content = py_file.read_text(encoding="utf-8", errors="ignore")
            self.assertNotIn("local_image_gen_worker", content, str(py_file))

        # Verify PowerShell launcher pins HF_HOME / TMP / TEMP strictly to Drive F:
        start_text = start_ps1.read_text(encoding="utf-8")
        self.assertIn(r"F:\c1\tools\image-gen-runtime", start_text)
        self.assertIn("HF_HOME", start_text)
        self.assertIn('"TMP"', start_text)
        self.assertIn('"TEMP"', start_text)
        self.assertIn("DATABASE_URL", start_text)

        # Load sidecar module in isolation and test FastAPI contract with a CPU-only fake runtime
        spec = importlib.util.spec_from_file_location("viread_local_image_gen_worker", sidecar_path)
        assert spec is not None and spec.loader is not None
        mod = importlib.util.module_from_spec(spec)
        sys.modules[spec.name] = mod
        spec.loader.exec_module(mod)

        clean_png = _make_image_bytes("PNG", (512, 768))

        class _FakeRuntime:
            model_id = "Lykon/dreamshaper-8+latent-consistency/lcm-lora-sdv1-5"

            def health_snapshot(self):
                return mod.HealthResponse(
                    ok=True,
                    model_id=self.model_id,
                    device="cuda",
                    vram_free_mb=3420,
                    ready=True,
                    busy=False,
                    pipeline_loaded=False,
                )

            def generate(self, **kwargs):
                return clean_png, "image/png", kwargs["width"], kwargs["height"], 120, 42

        app = mod.create_app(runtime=_FakeRuntime())
        client = TestClient(app)

        health = client.get("/health")
        self.assertEqual(health.status_code, 200)
        h_body = health.json()
        self.assertTrue(h_body["ok"])
        self.assertTrue(h_body["ready"])
        self.assertEqual(h_body["vram_free_mb"], 3420)

        gen_json = client.post(
            "/generate",
            json={
                "prompt": "Warm watercolor Vietnamese village garden",
                "negative_prompt": "text, watermark",
                "width": 512,
                "height": 768,
                "steps": 4,
                "seed": 42,
            },
        )
        self.assertEqual(gen_json.status_code, 200, gen_json.text)
        g_body = gen_json.json()
        self.assertEqual(base64.b64decode(g_body["image_base64"]), clean_png)
        self.assertEqual(g_body["mime_type"], "image/png")
        self.assertEqual((g_body["width"], g_body["height"]), (512, 768))

        # Unsafe prompt rejected fail-closed with 422
        unsafe = client.post("/generate", json={"prompt": "blood and gore scene"})
        self.assertEqual(unsafe.status_code, 422)

        # Verify diffusers 0.43+ & GTX 1650 hardware erratum guards are present in worker source
        sidecar_src = sidecar_path.read_text(encoding="utf-8")
        self.assertIn('"dtype": dtype', sidecar_src)
        self.assertIn('"feature_extractor": None', sidecar_src)
        self.assertIn("vae.enable_slicing()", sidecar_src)
        self.assertIn("vae.enable_tiling()", sidecar_src)
        self.assertIn("enable_sequential_cpu_offload", sidecar_src)
        self.assertIn("unload_lora_weights", sidecar_src)

    def test_sidecar_gtx1650_fp32_sdpa_and_rtx_fp16_profiles(self) -> None:
        """Verify GTX 16xx erratum auto-detection (CPU-only with mocked torch/diffusers)."""
        import types

        sidecar_path = _REPO_ROOT / "scripts" / "local_image_gen_worker.py"
        spec = importlib.util.spec_from_file_location("viread_local_image_gen_worker_gpu_test", sidecar_path)
        assert spec is not None and spec.loader is not None
        mod = importlib.util.module_from_spec(spec)
        sys.modules[spec.name] = mod
        spec.loader.exec_module(mod)

        def _run_load(gpu_name: str, env_extra: dict[str, str] | None = None):
            calls: dict[str, Any] = {
                "from_pretrained_kwargs": None,
                "fused": False,
                "unloaded_lora": False,
                "attention_slicing": False,
                "vae_slicing": False,
                "vae_tiling": False,
                "sequential_offload": False,
                "model_offload": False,
            }

            class _FakeVae:
                def enable_slicing(self):
                    calls["vae_slicing"] = True

                def enable_tiling(self):
                    calls["vae_tiling"] = True

            class _FakePipe:
                def __init__(self):
                    self.scheduler = types.SimpleNamespace(config={"beta_start": 0.00085})
                    self.vae = _FakeVae()

                def load_lora_weights(self, src, **kw):
                    calls["lora_src"] = src

                def fuse_lora(self):
                    calls["fused"] = True

                def unload_lora_weights(self):
                    calls["unloaded_lora"] = True

                def enable_attention_slicing(self):
                    calls["attention_slicing"] = True

                def enable_sequential_cpu_offload(self):
                    calls["sequential_offload"] = True

                def enable_model_cpu_offload(self):
                    calls["model_offload"] = True

                def to(self, dev):
                    calls["to_device"] = dev

            class _FakeSDPipe:
                @classmethod
                def from_pretrained(cls, src, **kwargs):
                    calls["base_src"] = src
                    calls["from_pretrained_kwargs"] = dict(kwargs)
                    return _FakePipe()

            class _FakeLCMScheduler:
                @classmethod
                def from_config(cls, cfg):
                    return {"lcm": True, **cfg}

            fake_torch = types.SimpleNamespace(
                float16="FLOAT16",
                float32="FLOAT32",
                cuda=types.SimpleNamespace(
                    is_available=lambda: True,
                    get_device_name=lambda idx=0: gpu_name,
                ),
                nn=types.SimpleNamespace(
                    functional=types.SimpleNamespace(
                        scaled_dot_product_attention=lambda *a, **kw: None
                    )
                ),
            )
            fake_diffusers = types.SimpleNamespace(
                LCMScheduler=_FakeLCMScheduler,
                StableDiffusionPipeline=_FakeSDPipe,
            )

            env = {
                "VIREAD_IMAGE_GEN_MODEL_ID": "Lykon/dreamshaper-8",
                "VIREAD_IMAGE_GEN_LCM_LORA": "latent-consistency/lcm-lora-sdv1-5",
                "VIREAD_LOCAL_SD_FORCE_FP32": "0",
            }
            if env_extra:
                env.update(env_extra)
            with (
                patch.dict(os.environ, env, clear=False),
                patch.dict(sys.modules, {"torch": fake_torch, "diffusers": fake_diffusers}),
            ):
                runtime = mod.LocalDiffusersRuntime()
                runtime._ensure_pipeline_loaded()
                return runtime, calls

        # 1) GTX 1650 Max-Q -> compact fp16 variant loaded as float32 + sequential offload + native SDPA
        rt_gtx, c_gtx = _run_load("NVIDIA GeForce GTX 1650 with Max-Q Design")
        self.assertEqual(c_gtx["from_pretrained_kwargs"]["variant"], "fp16")
        self.assertEqual(c_gtx["from_pretrained_kwargs"]["dtype"], "FLOAT32")
        self.assertTrue(c_gtx["fused"])
        self.assertTrue(c_gtx["unloaded_lora"])
        self.assertFalse(c_gtx["attention_slicing"])
        self.assertTrue(c_gtx["vae_slicing"])
        self.assertTrue(c_gtx["vae_tiling"])
        self.assertTrue(c_gtx["sequential_offload"])
        self.assertFalse(c_gtx["model_offload"])
        self.assertEqual(rt_gtx._offload_mode, "sequential_cpu_offload")

        # 2) RTX 3060 default -> fp16 + model_cpu_offload + native SDPA
        rt_rtx, c_rtx = _run_load("NVIDIA GeForce RTX 3060")
        self.assertEqual(c_rtx["from_pretrained_kwargs"]["dtype"], "FLOAT16")
        self.assertFalse(c_rtx["attention_slicing"])
        self.assertTrue(c_rtx["vae_slicing"])
        self.assertTrue(c_rtx["vae_tiling"])
        self.assertFalse(c_rtx["sequential_offload"])
        self.assertTrue(c_rtx["model_offload"])
        self.assertEqual(rt_rtx._offload_mode, "model_cpu_offload")

        # 3) VIREAD_LOCAL_SD_FORCE_FP32=1 overrides RTX to fp32 + sequential offload
        rt_force, c_force = _run_load(
            "NVIDIA GeForce RTX 3060", {"VIREAD_LOCAL_SD_FORCE_FP32": "1"}
        )
        self.assertEqual(c_force["from_pretrained_kwargs"]["dtype"], "FLOAT32")
        self.assertTrue(c_force["sequential_offload"])
        self.assertEqual(rt_force._offload_mode, "sequential_cpu_offload")


if __name__ == "__main__":
    unittest.main()
