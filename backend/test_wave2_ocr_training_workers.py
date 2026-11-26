from __future__ import annotations

import asyncio
import hashlib
import io
import json
import math
import os
import tempfile
import threading
import time
import unicodedata
import unittest
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta, timezone
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock, patch
from uuid import uuid4

os.environ.setdefault("APP_ENVIRONMENT", "test")
os.environ.setdefault("DATABASE_URL", "postgresql+asyncpg://test:test@127.0.0.1:1/test")
os.environ.setdefault("SUPABASE_URL", "https://example.supabase.co")
os.environ.setdefault("SUPABASE_KEY", "isolated-test-key")
os.environ.setdefault("DATABASE_POOLER_MODE", "local")
os.environ.setdefault("DATABASE_SSL_REQUIRED", "false")

import cv2
import httpx
import numpy as np
from fastapi import HTTPException
from PIL import Image

from app.api.routes import admin_viread_training as training_routes
from app.jobs import admin_ai_workflow_worker
from app.jobs import viread_ocr_outbox_worker
from app.jobs import viread_ocr_training_auto_worker
from app.schemas.viread_ocr_training import DatasetImport, DatasetSampleInput, TrainingWorkerClaim
from app.services import admin_ocr_local
from app.services import admin_ocr_service
from app.services import local_ocr_scan_service
from app.services import ocr_engine
from app.services import viread_drive_connection_service
from app.services import viread_ocr_training_service
from app.services import viread_training_storage_quota
from app.services.admin_ocr_chunking import ChunkingConfig
from app.services.ocr_ai import child_safety
from app.services.ocr_ai.config import OcrCorrectionConfig
from app.services.training_storage.google_apps_script_store import GoogleAppsScriptDriveStore
from app.services.training_storage.google_drive_desktop_store import GoogleDriveDesktopStore
from app.services.training_storage.google_drive_store import GoogleDriveTrainingStore
from app.services.vision_page_matcher import ViReadPageMatcher


def _make_png_bytes(width: int = 32, height: int = 32, color=(220, 220, 220)) -> bytes:
    img = Image.new("RGB", (width, height), color)
    buf = io.BytesIO()
    img.save(buf, format="PNG")
    return buf.getvalue()


class _FakeUploadFile:
    def __init__(self, data: bytes, filename: str = "page.png", content_type: str = "image/png"):
        self._buf = io.BytesIO(data)
        self.filename = filename
        self.content_type = content_type
        self.closed = False

    async def read(self, size: int = -1) -> bytes:
        return self._buf.read(size)

    async def close(self) -> None:
        self.closed = True
        self._buf.close()


class ChildSafetyWave2Tests(unittest.IsolatedAsyncioTestCase):
    async def test_ollama_only_chunks_stay_within_2500_chars_for_small_num_ctx(self):
        local_cfg = admin_ocr_local.LocalOcrConfig(num_ctx=4096, timeout_seconds=10)
        cfg = OcrCorrectionConfig(
            local=local_cfg,
            cloud_enabled=False,
            cloud_timeout_seconds=10,
            total_timeout_seconds=30,
        )
        orch = child_safety.ChildSafetyOrchestrator(cfg)
        seen_lengths: list[int] = []

        async def fake_request(_provider, source: str):
            seen_lengths.append(len(source))
            return {"suitability": "SUITABLE", "findings": []}, 200, "json_schema", 0

        orch._request = fake_request  # type: ignore[method-assign]
        text = ("Xin chào các bạn nhỏ đọc sách vui vẻ. " * 200).strip()
        assert len(text) > 6000
        result = await orch.analyze(text)
        self.assertEqual(result["suitability"], "SUITABLE")
        self.assertGreaterEqual(len(seen_lengths), 3)
        self.assertTrue(all(length <= 2500 for length in seen_lengths), seen_lengths)

    async def test_cloud_fallback_to_ollama_subchunks_and_preserves_evidence_offsets(self):
        local_cfg = admin_ocr_local.LocalOcrConfig(num_ctx=4096, timeout_seconds=10)
        cfg = OcrCorrectionConfig(
            local=local_cfg,
            cloud_enabled=True,
            gemini_api_key="test-key",
            groq_api_key=None,
            cloud_timeout_seconds=10,
            total_timeout_seconds=30,
        )
        orch = child_safety.ChildSafetyOrchestrator(cfg)
        ollama_lengths: list[int] = []

        async def fake_request(provider, source: str):
            if provider.family == "google":
                err = child_safety.ChildSafetyError("PROVIDER_UNAVAILABLE", [])
                err.status_code = 503  # type: ignore[attr-defined]
                raise err
            ollama_lengths.append(len(source))
            if "BAD_MARKER" in source:
                return {
                    "suitability": "REVIEW_REQUIRED",
                    "findings": [{
                        "category": "VIOLENCE",
                        "content_type": "DESCRIPTION",
                        "severity": "MEDIUM",
                        "evidence": "BAD_MARKER",
                        "explanation": "Contains a marker needing review.",
                        "recommendation": "Admin should review.",
                    }],
                }, 200, "json_schema", 0
            return {"suitability": "SUITABLE", "findings": []}, 200, "json_schema", 0

        orch._request = fake_request  # type: ignore[method-assign]
        text = ("a " * 2000) + "BAD_MARKER" + (" b" * 1000)
        result = await orch.analyze(text)
        self.assertGreaterEqual(len(ollama_lengths), 3)
        self.assertTrue(all(length <= 2500 for length in ollama_lengths), ollama_lengths)
        self.assertEqual(result["suitability"], "REVIEW_REQUIRED")
        self.assertEqual(len(result["findings"]), 1)
        finding = result["findings"][0]
        self.assertEqual(text[finding["evidence_start"]:finding["evidence_end"]], "BAD_MARKER")

    async def test_total_timeout_seconds_enforced_fail_closed(self):
        local_cfg = admin_ocr_local.LocalOcrConfig(num_ctx=4096, timeout_seconds=30)
        cfg = OcrCorrectionConfig(
            local=local_cfg,
            cloud_enabled=False,
            cloud_timeout_seconds=30,
            total_timeout_seconds=1,
        )
        # Override total_timeout_seconds to a very short value for fast deterministic test.
        object.__setattr__(cfg, "total_timeout_seconds", 0.08)
        orch = child_safety.ChildSafetyOrchestrator(cfg)

        async def slow_request(_provider, _source: str):
            await asyncio.sleep(5.0)
            return {"suitability": "SUITABLE", "findings": []}, 200, "json_schema", 0

        orch._request = slow_request  # type: ignore[method-assign]
        started = time.monotonic()
        with self.assertRaises(child_safety.ChildSafetyError) as ctx:
            await orch.analyze("Một đoạn văn ngắn.")
        elapsed = time.monotonic() - started
        self.assertEqual(ctx.exception.code, "DOCUMENT_TIMEOUT")
        self.assertLess(elapsed, 2.0)


class OcrEngineWave2Tests(unittest.TestCase):
    def test_segment_words_by_ink_handles_noise_only_and_tiny_crops_without_argmax_crash(self):
        # Single isolated pixel produces ink_cols > 0 but 0 connected components passing area>=8 filter
        img = np.full((24, 80, 3), 255, dtype=np.uint8)
        img[12, 40] = (0, 0, 0)
        geometry: dict[str, object] = {}
        spans = ocr_engine._segment_words_by_ink(img, ["xin", "chào", "bé"], geometry=geometry)
        self.assertEqual(len(spans), 3)
        self.assertFalse(geometry["reliable"])

        # Tiny / empty images return [] cleanly and _map_curved_word_boxes falls back safely
        self.assertEqual(ocr_engine._segment_words_by_ink(np.zeros((0, 0, 3), dtype=np.uint8), ["a", "b"]), [])
        item = {
            "rect_img": np.full((4, 4, 3), 255, dtype=np.uint8),
            "quad": np.float32([[0, 0], [40, 0], [40, 20], [0, 20]]),
        }
        boxes = ocr_engine._map_curved_word_boxes(["xin", "chào"], item, 100, 100, geometry=geometry)
        self.assertEqual(len(boxes), 2)
        for bx, by, bw, bh in boxes:
            self.assertGreaterEqual(bx, 0.0)
            self.assertGreaterEqual(by, 0.0)
            self.assertLessEqual(bx + bw, 1.0)
            self.assertLessEqual(by + bh, 1.0)

    def test_extract_curved_lines_guards_degenerate_and_collinear_quads(self):
        image = np.full((100, 100, 3), 255, dtype=np.uint8)
        bad_items = [
            ([[10, 10], [50, 10], [50, 10], [10, 10]], ("collinear", 0.9)),
            ([[float("nan"), 10], [50, 10], [50, 30], [10, 30]], ("nan", 0.9)),
            ([[130, 130], [150, 130], [150, 150], [130, 150]], ("clipped_to_point", 0.9)),
        ]
        extracted = ocr_engine._extract_curved_lines_from_items(bad_items, image)
        self.assertEqual(extracted, [])
        self.assertEqual(ocr_engine._extract_curved_lines_from_items(bad_items, np.zeros((0, 0, 3), dtype=np.uint8)), [])

    def test_tesseract_bboxes_are_clamped_within_unit_bounds(self):
        fake_pt = MagicMock()
        fake_pt.pytesseract = SimpleNamespace(tesseract_cmd="tesseract")
        fake_pt.image_to_data.return_value = {
            "text": ["Xin", "chào"],
            "left": [-15, 95],
            "top": [-5, 95],
            "width": [40, 50],
            "height": [20, 40],
            "conf": ["95.0", "nan"],
            "line_num": [-2, 1],
        }
        png = _make_png_bytes(100, 100)
        with patch.object(ocr_engine, "_ensure_pytesseract", return_value=(fake_pt, SimpleNamespace(DICT="dict"))), \
             patch.object(ocr_engine, "_resolve_tesseract_command", return_value=None):
            res = ocr_engine._extract_text_and_boxes_tesseract(png)
        self.assertEqual(len(res["words"]), 2)
        for w in res["words"]:
            x, y, bw, bh = w["bbox"]
            self.assertGreaterEqual(x, 0.0)
            self.assertGreaterEqual(y, 0.0)
            self.assertGreater(bw, 0.0)
            self.assertGreater(bh, 0.0)
            self.assertLessEqual(x + bw, 1.0)
            self.assertLessEqual(y + bh, 1.0)
            self.assertGreaterEqual(w["line_index"], 0)
        self.assertIsNone(res["words"][1]["ocr_confidence"])

    def test_v2_preprocessing_profiles_include_legacy_aliases(self):
        self.assertIn("FLOW1_EXTERNAL_TRDG", ocr_engine._V2_PREPROCESSING_PROFILES)
        self.assertIn("FLOW2_ADMIN_VERIFIED", ocr_engine._V2_PREPROCESSING_PROFILES)
        self.assertIn("FLOW1_VERIFIED", ocr_engine._V2_PREPROCESSING_PROFILES)
        self.assertIn("FLOW2_EXTERNAL_TRDG", ocr_engine._V2_PREPROCESSING_PROFILES)

    def test_active_model_cache_recovers_after_empty_fetch_with_cooldown(self):
        old_cache = ocr_engine._active_model_info_cache
        old_retry = ocr_engine._active_model_retry_after
        old_fail = ocr_engine._active_model_failure_count
        try:
            ocr_engine._active_model_info_cache = (0.0, None)
            ocr_engine._active_model_retry_after = 0.0
            ocr_engine._active_model_failure_count = 0

            empty_resp = MagicMock()
            empty_resp.raise_for_status.return_value = None
            empty_resp.json.return_value = []

            valid_row = {"checkpoint_sha256": "a" * 64, "storage_path": "gdrive://abc", "profile": "FLOW2_ADMIN_VERIFIED"}
            valid_resp = MagicMock()
            valid_resp.raise_for_status.return_value = None
            valid_resp.json.return_value = [valid_row]

            with patch.object(ocr_engine, "SUPABASE_URL", "https://example.supabase.co"), \
                 patch.object(ocr_engine, "SUPABASE_ADMIN_KEY", "secret-key"), \
                 patch.object(ocr_engine.requests, "get", side_effect=[empty_resp, valid_resp]) as mock_get:
                # 1st fetch returns []: should NOT permanently lock ts > 0 with None, and sets cooldown
                self.assertIsNone(ocr_engine._active_viread_model())
                self.assertEqual(mock_get.call_count, 1)
                self.assertEqual(ocr_engine._active_model_info_cache[0], 0.0)

                # Immediate 2nd call hits cooldown (no retry storm)
                self.assertIsNone(ocr_engine._active_viread_model())
                self.assertEqual(mock_get.call_count, 1)

                # Once cooldown expires, next call retries and retrieves valid row!
                ocr_engine._active_model_retry_after = 0.0
                got = ocr_engine._active_viread_model()
                self.assertEqual(got, valid_row)
                self.assertEqual(mock_get.call_count, 2)
        finally:
            ocr_engine._active_model_info_cache = old_cache
            ocr_engine._active_model_retry_after = old_retry
            ocr_engine._active_model_failure_count = old_fail

    def test_tessdata_prefix_probe_serialized_under_lock(self):
        self.assertIsInstance(ocr_engine._tesseract_config_lock, type(threading.Lock()))
        old_checked = ocr_engine._tesseract_language_data_checked
        try:
            ocr_engine._tesseract_language_data_checked = False
            probe_calls = 0

            def fake_get_langs(config=""):
                nonlocal probe_calls
                probe_calls += 1
                time.sleep(0.02)
                return ["vie"]

            fake_pt = SimpleNamespace(get_languages=fake_get_langs)
            with patch.object(ocr_engine, "_ensure_pytesseract", return_value=(fake_pt, None)), \
                 patch.object(Path, "is_file", return_value=True):
                with ThreadPoolExecutor(max_workers=4) as pool:
                    list(pool.map(lambda _: ocr_engine._ensure_tesseract_language_data(), range(4)))
            self.assertEqual(probe_calls, 1)
        finally:
            ocr_engine._tesseract_language_data_checked = old_checked


class VisionMatcherAndLocalOcrTests(unittest.IsolatedAsyncioTestCase):
    def test_vision_page_matcher_handles_1x1_and_empty_image_without_crashing(self):
        matcher = ViReadPageMatcher()
        tiny_png = _make_png_bytes(1, 1, color=(255, 255, 255))
        res_tiny = matcher.check_framing(tiny_png)
        self.assertFalse(res_tiny["framing_valid"])
        self.assertEqual(res_tiny["status_code"], "INVALID_IMAGE")

        res_empty = matcher.check_framing(b"")
        self.assertFalse(res_empty["framing_valid"])
        self.assertEqual(res_empty["status_code"], "INVALID_IMAGE")

        self.assertEqual(matcher.match_page(b"", []), {"matched": False, "confidence": 0.0})

    async def test_local_ocr_corrector_uses_normalize_word_and_nfc(self):
        # Input contains standalone punctuation "—" AND NFD decomposed Vietnamese ("ho\u0300a")
        nfd_word = unicodedata.normalize("NFD", "hòa")
        nfc_word = unicodedata.normalize("NFC", "hòa")
        text = f"Xin — {nfd_word}"
        # Only 2 word boxes (standalone "—" has normalize_word("—") == "")
        boxes = [(0.0, 0.0, 0.4, 0.5), (0.5, 0.0, 0.4, 0.5)]
        png = _make_png_bytes(64, 32)

        def handler(_request: httpx.Request) -> httpx.Response:
            # Provider echoes NFD form for uncertain word index 1; NFC normalization must accept it
            body = {
                "message": {
                    "content": json.dumps({
                        "chunk_id": 0,
                        "corrected_words": ["Xin", nfd_word],
                        "uncertain_word_indices": [1],
                    })
                }
            }
            return httpx.Response(200, json=body)

        cfg = admin_ocr_local.LocalOcrConfig(chunking=ChunkingConfig(max_words=20))
        corrector = admin_ocr_local.LocalOcrCorrector(cfg, transport=httpx.MockTransport(handler))
        corrected = await corrector.correct(text, png, boxes)
        self.assertEqual(corrected, f"Xin — {nfc_word}")


class LocalOcrScanAndAdminOcrServiceWave2Tests(unittest.IsolatedAsyncioTestCase):
    async def test_local_ocr_scan_decompression_bomb_returns_422_and_bbox_clamping(self):
        raw = _make_png_bytes(16, 16)
        with patch.object(local_ocr_scan_service.Image, "open", side_effect=Image.DecompressionBombError("bomb")):
            with self.assertRaises(HTTPException) as ctx:
                local_ocr_scan_service._decode_and_normalize_image_bytes(raw)
        self.assertEqual(ctx.exception.status_code, 422)

        # Bbox clamping & NaN/bool guards
        x, y, w, h = local_ocr_scan_service._normalize_bbox([-0.5, float("nan"), 2.0, True])
        self.assertGreaterEqual(x, 0.0)
        self.assertGreaterEqual(y, 0.0)
        self.assertGreater(w, 0.0)
        self.assertGreater(h, 0.0)
        self.assertLessEqual(x + w, 1.0)
        self.assertLessEqual(y + h, 1.0)

        x2, y2, w2, h2 = local_ocr_scan_service._normalize_bbox([0.95, 0.95, 0.5, 0.5])
        self.assertLessEqual(x2 + w2, 1.0)
        self.assertLessEqual(y2 + h2, 1.0)

    async def test_local_ocr_scan_releases_db_txn_before_ocr_and_guards_numeric_fields(self):
        db = SimpleNamespace(rollback=AsyncMock())
        repo = SimpleNamespace(
            db=db,
            profile_role=AsyncMock(return_value="parent"),
            eligible_verified_pages=AsyncMock(return_value=[]),
        )
        service = local_ocr_scan_service.LocalOcrScanService(repo)  # type: ignore[arg-type]
        upload = _FakeUploadFile(_make_png_bytes(32, 32))
        fake_ocr = {
            "text": "Xin chào",
            "words": [
                {
                    "word_index": True,
                    "line_index": -5,
                    "text": "Xin",
                    "bbox": [0.9, 0.9, 0.5, 0.5],
                    "ocr_confidence": float("nan"),
                },
                {
                    "word_index": 1,
                    "line_index": 0,
                    "text": "chào",
                    "bbox": [0.1, 0.1, 0.2, 0.1],
                    "ocr_confidence": True,
                },
            ],
            "metadata": {"engine": "tesseract"},
        }
        with patch.object(local_ocr_scan_service, "is_remote_ocr_mode", return_value=False), \
             patch.object(local_ocr_scan_service, "extract_text_and_boxes", return_value=fake_ocr):
            res = await service.scan_page(uuid4(), upload, request_id="req-1")
        self.assertTrue(upload.closed)
        self.assertGreaterEqual(db.rollback.await_count, 1)
        self.assertEqual(res.word_count, 2)
        self.assertIsNone(res.words[0].ocr_confidence)
        self.assertIsNone(res.words[1].ocr_confidence)
        self.assertEqual(res.words[0].line_index, 0)
        self.assertLessEqual(res.words[0].bbox[0] + res.words[0].bbox[2], 1.0)
        self.assertLessEqual(res.words[0].bbox[1] + res.words[0].bbox[3], 1.0)

    async def test_admin_ocr_service_closes_upload_file_rolls_back_and_offloads_image_url(self):
        db = SimpleNamespace(rollback=AsyncMock(), commit=AsyncMock())
        service = admin_ocr_service.AdminOcrService(db)  # type: ignore[arg-type]

        # 1) _read_validate_image closes UploadFile even on 415 error
        bad_upload = _FakeUploadFile(b"not-an-image", filename="doc.txt", content_type="text/plain")
        with self.assertRaises(HTTPException) as ctx:
            await service._read_validate_image(bad_upload)
        self.assertEqual(ctx.exception.status_code, 415)
        self.assertTrue(bad_upload.closed)

        # 2) ai_correct_text rolls back read txn before LLM work
        prepared = object()
        events: list[str] = []

        async def fake_prepare(*_a, **_kw):
            events.append("prepare")
            return prepared

        async def fake_rollback():
            events.append("rollback")

        async def fake_run(_prep):
            events.append("run")
            return "corrected"

        db.rollback = AsyncMock(side_effect=fake_rollback)
        with patch.object(service, "prepare_ai_correction", side_effect=fake_prepare), \
             patch.object(service, "run_prepared_ai_correction", side_effect=fake_run):
            out = await service.ai_correct_text(uuid4(), uuid4(), "hi", [])
        self.assertEqual(out, {"corrected_text": "corrected"})
        self.assertEqual(events, ["prepare", "rollback", "run"])

        # 3) image_url offloads create_signed_image_url via run_in_threadpool
        page = SimpleNamespace(ImagePath="books/1/pages/1/img.png")
        with patch.object(admin_ocr_service, "run_in_threadpool", new_callable=AsyncMock, return_value="https://signed") as mock_pool:
            url = await service.image_url(page)  # type: ignore[arg-type]
        self.assertEqual(url, "https://signed")
        mock_pool.assert_awaited_once_with(admin_ocr_service.create_signed_image_url, "books/1/pages/1/img.png")


class WorkersWave2Tests(unittest.IsolatedAsyncioTestCase):
    async def test_admin_ai_workflow_progress_loop_survives_db_error_and_reaps_task_exception(self):
        wf_id = uuid4()
        q: asyncio.Queue[tuple[int, int] | None] = asyncio.Queue()
        q.put_nowait((1, 4))
        q.put_nowait((2, 4))
        q.put_nowait((-1, -1))

        calls = 0

        class _FakeSessionCtx:
            async def __aenter__(self):
                return self

            async def __aexit__(self, *args):
                return False

        class _FakeRepo:
            def __init__(self, _session):
                pass

            async def update_progress(self, *_a, **_kw):
                nonlocal calls
                calls += 1
                if calls == 1:
                    raise RuntimeError("transient db error")
                return True

        with patch.object(admin_ai_workflow_worker, "AsyncSessionLocal", return_value=_FakeSessionCtx()), \
             patch.object(admin_ai_workflow_worker, "AdminAiWorkflowRepository", _FakeRepo):
            await admin_ai_workflow_worker._progress_loop(wf_id, "worker-1", q)
        self.assertEqual(calls, 2)

        # _process releases claim if _load fails
        release_mock = AsyncMock()

        class _ReleaseRepo:
            def __init__(self, _session):
                pass

            async def release_claim(self, wid, wk):
                await release_mock(wid, wk)

        with patch.object(admin_ai_workflow_worker, "_load", side_effect=RuntimeError("db down")), \
             patch.object(admin_ai_workflow_worker, "AsyncSessionLocal", return_value=_FakeSessionCtx()), \
             patch.object(admin_ai_workflow_worker, "AdminAiWorkflowRepository", _ReleaseRepo):
            await admin_ai_workflow_worker._process(wf_id, "worker-1")
        release_mock.assert_awaited_once_with(wf_id, "worker-1")

        # _reap_done_tasks logs & records exception from failed task
        async def boom():
            raise RuntimeError("unhandled")

        failed_task = asyncio.create_task(boom())
        await asyncio.sleep(0.02)
        with patch.object(admin_ai_workflow_worker, "record_worker_error") as mock_rec:
            rem = admin_ai_workflow_worker._reap_done_tasks({failed_task})
        self.assertEqual(rem, set())
        mock_rec.assert_called_once()

    async def test_training_auto_worker_heartbeat_lease_loss_and_cancel_release(self):
        job_id = uuid4()
        stop = asyncio.Event()
        lease_lost = asyncio.Event()
        attempts = 0

        class _FakeDb:
            async def __aenter__(self):
                return self

            async def __aexit__(self, *args):
                return False

            async def execute(self, *_a, **_kw):
                nonlocal attempts
                attempts += 1
                if attempts == 1:
                    raise RuntimeError("transient connection drop")
                return SimpleNamespace(rowcount=0)

            async def commit(self):
                pass

        orig_wait_for = asyncio.wait_for

        async def fast_wait_for(coro, timeout=None):
            return await orig_wait_for(coro, timeout=0.01)

        with patch.object(viread_ocr_training_auto_worker, "AsyncSessionLocal", return_value=_FakeDb()), \
             patch.object(viread_ocr_training_auto_worker.asyncio, "wait_for", side_effect=fast_wait_for):
            await viread_ocr_training_auto_worker._heartbeat(
                job_id, "local-w1", stop, {"stage": "training"}, lease_lost=lease_lost
            )
        self.assertEqual(attempts, 2)
        self.assertTrue(lease_lost.is_set())

        # _run_local_once releases claim cleanly on CancelledError
        release_called = AsyncMock()
        fake_job = {"id": str(job_id), "attempts": 1}

        async def cancel_process(_job, _progress):
            raise asyncio.CancelledError()

        with patch.object(viread_ocr_training_auto_worker, "_claim_local_job", new_callable=AsyncMock, return_value=fake_job), \
             patch.object(viread_ocr_training_auto_worker, "_process_local_job", side_effect=cancel_process), \
             patch.object(viread_ocr_training_auto_worker, "_release_local_claim_on_cancel", side_effect=release_called):
            with self.assertRaises(asyncio.CancelledError):
                await viread_ocr_training_auto_worker._run_local_once("local-w1")
        release_called.assert_awaited_once_with(job_id, "local-w1")

    async def test_outbox_worker_run_once_releases_claim_on_cancel(self):
        ev_id = uuid4()
        release_called = AsyncMock()
        with patch.object(viread_ocr_outbox_worker, "is_flow2_ingestion_paused", return_value=False), \
             patch.object(viread_ocr_outbox_worker, "_claim_one", new_callable=AsyncMock, return_value={"id": ev_id, "attempts": 2}), \
             patch.object(viread_ocr_outbox_worker, "_process_with_lease", side_effect=asyncio.CancelledError()), \
             patch.object(viread_ocr_outbox_worker, "_release_claim_on_cancel", side_effect=release_called):
            with self.assertRaises(asyncio.CancelledError):
                await viread_ocr_outbox_worker.run_once()
        release_called.assert_awaited_once_with(ev_id, expected_attempts=2)


class QuotaAndStorageWave2Tests(unittest.IsolatedAsyncioTestCase):
    async def test_quota_413_rejection_does_not_poison_cache(self):
        old_env = viread_training_storage_quota.APP_ENVIRONMENT
        old_s_cache = viread_training_storage_quota._storage_cache
        old_d_cache = viread_training_storage_quota._db_size_cache
        try:
            viread_training_storage_quota.APP_ENVIRONMENT = "production"
            viread_training_storage_quota._storage_cache = (0.0, 0)
            viread_training_storage_quota._db_size_cache = (0.0, 0)

            class _FakeQuotaDb:
                def __init__(self, used_bytes: int):
                    self.used_bytes = used_bytes

                async def execute(self, *_a, **_kw):
                    return SimpleNamespace(
                        mappings=lambda: SimpleNamespace(first=lambda: {"used_bytes": self.used_bytes})
                    )

            with patch.dict(os.environ, {
                "VIREAD_OCR_STORAGE_LIMIT_BYTES": "1000",
                "VIREAD_OCR_DATABASE_LIMIT_BYTES": "1000",
            }):
                db = _FakeQuotaDb(900)
                with self.assertRaises(HTTPException) as ctx1:
                    await viread_training_storage_quota.ensure_storage_capacity(db, 200)  # type: ignore[arg-type]
                self.assertEqual(ctx1.exception.status_code, 413)
                # Cache must NOT have been poisoned with 900+200=1100
                self.assertEqual(viread_training_storage_quota._storage_cache[1], 0)
                ok = await viread_training_storage_quota.ensure_storage_capacity(db, 50)  # type: ignore[arg-type]
                self.assertEqual(ok["used_bytes"], 900)

                with self.assertRaises(HTTPException) as ctx2:
                    await viread_training_storage_quota.ensure_database_capacity(db, 200)  # type: ignore[arg-type]
                self.assertEqual(ctx2.exception.status_code, 413)
                self.assertEqual(viread_training_storage_quota._db_size_cache[1], 0)
                ok_db = await viread_training_storage_quota.ensure_database_capacity(db, 50)  # type: ignore[arg-type]
                self.assertEqual(ok_db["used_bytes"], 900)
        finally:
            viread_training_storage_quota.APP_ENVIRONMENT = old_env
            viread_training_storage_quota._storage_cache = old_s_cache
            viread_training_storage_quota._db_size_cache = old_d_cache

    def test_drive_stores_use_thread_local_sessions_when_uninjected(self):
        oauth_store = GoogleDriveTrainingStore(
            client_id="cid",
            client_secret="csec",
            refresh_token="rtok",
        )
        gas_store = GoogleAppsScriptDriveStore(
            web_app_url="https://script.google.com/macros/s/AKfycbx1234567890abcdefghij/exec",
            bridge_secret="s" * 40,
        )

        def grab_ids(store):
            ids = []
            barrier = threading.Barrier(2)

            def worker():
                s = store._session
                barrier.wait()
                ids.append(id(s))

            t1 = threading.Thread(target=worker)
            t2 = threading.Thread(target=worker)
            t1.start()
            t2.start()
            t1.join()
            t2.join()
            return ids

        oauth_ids = grab_ids(oauth_store)
        gas_ids = grab_ids(gas_store)
        self.assertEqual(len(set(oauth_ids)), 2)
        self.assertEqual(len(set(gas_ids)), 2)

        # Injected session is preserved across threads
        shared = MagicMock()
        injected = GoogleDriveTrainingStore(
            client_id="cid",
            client_secret="csec",
            refresh_token="rtok",
            session=shared,
        )
        self.assertEqual(set(grab_ids(injected)), {id(shared)})

    def test_desktop_store_deterministic_hash_index_and_canonical_fallback(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp) / "ViRead_Flow2_Training"
            store = GoogleDriveDesktopStore(root_dir=root, min_free_buffer_bytes=0)
            payload = b"verified-sample-bytes"
            sha = hashlib.sha256(payload).hexdigest()
            logical_path = f"verified-samples/train/{sha}.png"

            first = store.put(logical_path, payload, expected_sha256=sha)
            self.assertFalse(first.deduplicated)

            key_idx = store._immutable_key_index_path(logical_path, sha)
            self.assertTrue(key_idx.is_file())
            raw_json = key_idx.read_text(encoding="utf-8")
            parsed = json.loads(raw_json)
            self.assertEqual(raw_json, json.dumps(parsed, separators=(",", ":"), sort_keys=True))

            # O(1) deterministic deduplication hit
            second = store.put(logical_path, payload, expected_sha256=sha)
            self.assertTrue(second.deduplicated)
            self.assertEqual(second.drive_file_id, first.drive_file_id)

            # Remove key index to verify canonical fallback + backfill from legacy gdesk_*.json
            key_idx.unlink()
            self.assertFalse(key_idx.is_file())
            third = store.put(logical_path, payload, expected_sha256=sha)
            self.assertTrue(third.deduplicated)
            self.assertEqual(third.drive_file_id, first.drive_file_id)
            self.assertTrue(key_idx.is_file())

            # delete_if_unreferenced removes both file and hash index
            deleted = store.delete_if_unreferenced(first.reference, is_referenced_check=lambda _r: False)
            self.assertTrue(deleted)
            self.assertFalse(key_idx.is_file())


class DriveServiceTrainingServiceAndRoutesWave2Tests(unittest.IsolatedAsyncioTestCase):
    async def test_drive_connection_service_caches_mount_probe_and_rolls_back(self):
        viread_drive_connection_service.invalidate_sync_google_drive_store_cache()
        db = SimpleNamespace(rollback=AsyncMock())
        svc = viread_drive_connection_service.VireadDriveConnectionService(db)  # type: ignore[arg-type]
        svc.repo = SimpleNamespace(get_primary=AsyncMock(return_value=(None, True)))  # type: ignore[assignment]

        probe_calls = 0

        def fake_readiness():
            nonlocal probe_calls
            probe_calls += 1
            return {"desktop_ready": True, "detected_mounts": []}

        with patch.object(viread_drive_connection_service, "drive_desktop_config_readiness", side_effect=fake_readiness):
            s1 = await svc.get_status()
            s2 = await svc.get_status()
            self.assertEqual(probe_calls, 1)
            self.assertEqual(s1["drive_desktop_readiness"]["desktop_ready"], True)
            self.assertEqual(s2["drive_desktop_readiness"]["desktop_ready"], True)
            self.assertEqual(db.rollback.await_count, 2)

            viread_drive_connection_service.invalidate_sync_google_drive_store_cache()
            await svc.get_status()
            self.assertEqual(probe_calls, 2)

    async def test_training_service_register_dataset_commit_false_and_url_quoting(self):
        db = SimpleNamespace(rollback=AsyncMock(), commit=AsyncMock())
        svc = viread_ocr_training_service.VireadOcrTrainingService(db)  # type: ignore[arg-type]
        svc.repo = SimpleNamespace(
            one=AsyncMock(side_effect=[None, {"id": uuid4(), "source_flow": "LOCKED_TEST", "version_sha256": "x" * 64, "manifest_storage_path": "p", "sample_count": 1, "is_locked_test": True}]),
            execute=AsyncMock(),
            commit=AsyncMock(),
            rollback=AsyncMock(),
        )  # type: ignore[assignment]

        img_bytes = _make_png_bytes(16, 16)
        img_sha = hashlib.sha256(img_bytes).hexdigest()
        payload = DatasetImport(
            source_flow="LOCKED_TEST",
            split_seed="seed-1",
            samples=[
                DatasetSampleInput(
                    source_flow="LOCKED_TEST",
                    sample_id="s1",
                    group_id="g1",
                    split="locked_test",
                    image_storage_path=f"ocr-training/locked-test/{img_sha}.png",
                    image_sha256=img_sha,
                    label="Xin chào",
                    verified=True,
                    annotation_id="s1",
                )
            ],
        )
        with patch.object(svc, "_admin", new_callable=AsyncMock), \
             patch.object(svc, "_read_artifact_bytes", new_callable=AsyncMock, return_value=img_bytes), \
             patch.object(viread_ocr_training_service, "ensure_database_capacity", new_callable=AsyncMock), \
             patch.object(viread_ocr_training_service, "ensure_storage_capacity", new_callable=AsyncMock), \
             patch.object(viread_ocr_training_service, "upload_object"):
            await svc.register_dataset(uuid4(), payload, commit=False)
        # commit=False must NOT commit or rollback mid-advisory-lock transaction
        svc.repo.commit.assert_not_awaited()
        svc.repo.rollback.assert_not_awaited()

        # URL quoting in _artifact_download_url
        with patch.object(viread_ocr_training_service, "sign_worker_artifact_token", return_value="tok+a/b=c"):
            url = svc._artifact_download_url(
                "gdrive://file123",
                expected_sha256="a" * 64,
                job_id=uuid4(),
                worker_id="worker:1",
            )
        self.assertIsNotNone(url)
        self.assertIn("worker_id=worker%3A1", url or "")
        self.assertIn("token=tok%2Ba%2Fb%3Dc", url or "")

    async def test_admin_viread_training_worker_id_validation_and_upload_close_and_rollback(self):
        # 1) Invalid worker_id rejected with 422
        db = SimpleNamespace(rollback=AsyncMock(), commit=AsyncMock())
        svc = viread_ocr_training_service.VireadOcrTrainingService(db)  # type: ignore[arg-type]
        for bad_wid in ("", "bad&token=1", "../escape", "has space", "a" * 121):
            with self.assertRaises(HTTPException) as ctx:
                await training_routes._leased_colab_job(svc, uuid4(), bad_wid)
            self.assertEqual(ctx.exception.status_code, 422)

            with self.assertRaises(HTTPException) as ctx2:
                await training_routes.stream_viread_colab_job_artifact(
                    uuid4(), worker_id=bad_wid, token="abc", _worker=None, db=db  # type: ignore[arg-type]
                )
            self.assertEqual(ctx2.exception.status_code, 422)

        # 2) Upload routes close UploadFile in finally even when 413 exceeds limit
        oversized = _FakeUploadFile(b"x" * (training_routes.MAX_SHARD_BYTES + 10))
        with self.assertRaises(HTTPException) as ctx3:
            await training_routes.upload_viread_flow1_model_chunk(
                upload_id=uuid4(), chunk_index=0, file=oversized, actor_id=uuid4(), db=db  # type: ignore[arg-type]
            )
        self.assertEqual(ctx3.exception.status_code, 413)
        self.assertTrue(oversized.closed)

        comp_oversized = _FakeUploadFile(b"x" * (2 * 1024 * 1024 + 5), filename="comp.json")
        cfg_file = _FakeUploadFile(b"a: 1", filename="cfg.yaml")
        with self.assertRaises(HTTPException) as ctx4:
            await training_routes.activate_viread_flow1_model(
                upload_id=uuid4(),
                weights_filename="m.pth",
                chunks_json="[]",
                comparison_file=comp_oversized,  # type: ignore[arg-type]
                config_file=cfg_file,  # type: ignore[arg-type]
                actor_id=uuid4(),
                db=db,  # type: ignore[arg-type]
            )
        self.assertEqual(ctx4.exception.status_code, 413)
        self.assertTrue(comp_oversized.closed)
        self.assertTrue(cfg_file.closed)

        # 3) list_viread_colab_resume_state calls db.rollback() instead of db.commit() before Drive I/O
        db_resume = SimpleNamespace(rollback=AsyncMock(), commit=AsyncMock())
        with patch.object(training_routes, "_leased_colab_job", new_callable=AsyncMock, return_value={"id": uuid4()}), \
             patch.object(
                 training_routes.VireadDriveConnectionService,
                 "list_job_resume_files",
                 new_callable=AsyncMock,
                 return_value={"job_id": "1", "files": []},
             ):
            await training_routes.list_viread_colab_resume_state(
                uuid4(), worker_id="colab-w1", _worker=None, db=db_resume  # type: ignore[arg-type]
            )
        db_resume.rollback.assert_awaited_once()
        db_resume.commit.assert_not_awaited()


if __name__ == "__main__":
    unittest.main()
