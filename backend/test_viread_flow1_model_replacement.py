from __future__ import annotations

import hashlib
import json
import os
import tempfile
import unittest
from datetime import datetime, timezone
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch
from uuid import UUID, uuid4

from fastapi import HTTPException

from app.repositories.viread_ocr_training_repository import VireadOcrTrainingRepository
from app.services.ocr_engine import evict_cached_viread_checkpoint, _v2_artifact_from_storage
from app.services.viread_ocr_training_service import (
    VireadOcrTrainingService,
    invalidate_overview_manifest_cache,
)


class Flow1ModelReplacementTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        invalidate_overview_manifest_cache()

    async def test_chunk_upload_validates_magic_bytes(self):
        actor_id = uuid4()
        upload_id = uuid4()
        repo = SimpleNamespace(commit=AsyncMock(), rollback=AsyncMock())
        service = VireadOcrTrainingService(repo)
        service.repo = repo
        service._admin = AsyncMock()

        with patch("app.services.viread_ocr_training_service.ensure_storage_capacity", new_callable=AsyncMock), \
             patch("app.services.viread_ocr_training_service.upload_object") as mock_upload:

            # Invalid magic bytes on chunk 0
            with self.assertRaises(HTTPException) as ctx:
                await service.upload_flow1_model_chunk(actor_id, upload_id, 0, b"CORRUPT DATA INVALID")
            self.assertEqual(ctx.exception.status_code, 422)

            # Valid zip magic bytes on chunk 0
            zip_header = b"PK\x03\x04" + b"some zip content"
            res_zip = await service.upload_flow1_model_chunk(actor_id, upload_id, 0, zip_header)
            self.assertEqual(res_zip["chunk_index"], 0)
            self.assertEqual(res_zip["bytes"], len(zip_header))
            mock_upload.assert_called_once()

            # Valid pickle magic bytes on chunk 0
            mock_upload.reset_mock()
            pickle_header = b"\x80\x02" + b"pickle payload"
            res_pickle = await service.upload_flow1_model_chunk(actor_id, upload_id, 0, pickle_header)
            self.assertEqual(res_pickle["chunk_index"], 0)
            mock_upload.assert_called_once()

            # Chunk 1 does not enforce chunk 0 magic bytes
            mock_upload.reset_mock()
            res_chunk1 = await service.upload_flow1_model_chunk(actor_id, upload_id, 1, b"arbitrary subsequent data")
            self.assertEqual(res_chunk1["chunk_index"], 1)
            mock_upload.assert_called_once()

    async def test_activate_happy_path_with_yaml_and_cleanup_of_previous_model(self):
        actor_id = uuid4()
        upload_id = uuid4()
        old_upload_id = uuid4()

        old_manifest_path = f"ocr-training/checkpoints/flow1-manual/{old_upload_id}/checkpoint.manifest.json"
        old_chunk_path = f"ocr-training/checkpoints/flow1-manual/{old_upload_id}/0000-old.part"
        old_config_path = f"ocr-training/checkpoints/flow1-manual/{old_upload_id}/config.yml"
        old_sha = "1" * 64

        old_manifest = {
            "schema": "viread-checkpoint-shards-v1",
            "checkpoint_sha256": old_sha,
            "chunks": [{"index": 0, "path": old_chunk_path, "sha256": "oldchunk", "bytes": 100}],
            "config": {"storage_path": old_config_path, "sha256": "oldcfg"},
        }

        active_row = {
            "checkpoint_sha256": old_sha,
            "storage_path": old_manifest_path,
            "profile": "FLOW1_EXTERNAL_TRDG",
            "decision_id": uuid4(),
            "updated_at": datetime.now(timezone.utc),
        }

        # Create dummy local temp file to verify local eviction
        temp_dir = tempfile.gettempdir()
        cached_pth = os.path.join(temp_dir, f"viread-vietocr-v2-{old_sha}.pth")
        with open(cached_pth, "wb") as f:
            f.write(b"dummy old model")
        self.assertTrue(os.path.isfile(cached_pth))

        chunk0_bytes = b"PK\x03\x04" + b"x" * 1000
        chunk1_bytes = b"y" * 1000
        ch0_sha = hashlib.sha256(chunk0_bytes).hexdigest()
        ch1_sha = hashlib.sha256(chunk1_bytes).hexdigest()
        expected_full_sha = hashlib.sha256(chunk0_bytes + chunk1_bytes).hexdigest()

        chunks_data = [
            {"index": 0, "path": f"ocr-training/checkpoints/flow1-manual/{upload_id}/0000-{ch0_sha}.part", "sha256": ch0_sha, "bytes": len(chunk0_bytes)},
            {"index": 1, "path": f"ocr-training/checkpoints/flow1-manual/{upload_id}/0001-{ch1_sha}.part", "sha256": ch1_sha, "bytes": len(chunk1_bytes)},
        ]
        chunks_json = json.dumps(chunks_data)

        comparison_dict = {
            "models": {
                "baseline": "vgg_transformer (VietOCR default)",
                "finetuned_model_only": "vgg_transformer (Fine-tuned V2)",
                "finetuned_full_pipeline": "DBNet + VietOCR V2 Full Pipeline",
            },
            "real_sgk_test_set": {
                "cer_pct": {"baseline": 12.4, "finetuned_model_only": 4.1, "finetuned_full_pipeline": 3.2},
                "wer_pct": {"baseline": 24.8, "finetuned_model_only": 9.2, "finetuned_full_pipeline": 7.5},
                "exact_match_pct": {"baseline": 65.0, "finetuned_model_only": 88.5, "finetuned_full_pipeline": 91.2},
                "f1_score_pct": {"baseline": 85.3, "finetuned_model_only": 96.1, "finetuned_full_pipeline": 97.4},
                "gpu_infer_ms_per_line": {"baseline": 42.1, "finetuned_model_only": 41.8, "finetuned_full_pipeline": 58.6},
            },
            "overall_test_set": {
                "cer_pct": {"baseline": 15.0, "finetuned_model_only": 5.0, "finetuned_full_pipeline": 4.0},
                "wer_pct": {"baseline": 28.0, "finetuned_model_only": 11.0, "finetuned_full_pipeline": 9.0},
            },
            "vietnamese_diacritics_errors": {
                "tone_confusion_chars": {"baseline": 142, "finetuned": 18, "reduction_pct": 87.3},
                "d_vs_d_stroke_chars": {"baseline": 56, "finetuned": 4, "reduction_pct": 92.8},
            },
        }
        comparison_bytes = json.dumps(comparison_dict).encode("utf-8")
        custom_yaml = b"device: cpu\ncnn:\n  pretrained: false\n"

        deleted_paths: list[str] = []
        uploaded_objects: dict[str, bytes] = {}

        def fake_upload(path, data, content_type="application/octet-stream", upsert=True):
            uploaded_objects[path] = data

        def fake_download(path):
            if path == old_manifest_path:
                return json.dumps(old_manifest).encode("utf-8")
            if path in uploaded_objects:
                return uploaded_objects[path]
            raise FileNotFoundError(path)

        def fake_delete(path):
            deleted_paths.append(path)

        def fake_stream_hash(path, digest):
            if "0000" in path:
                digest.update(chunk0_bytes)
                return ch0_sha, len(chunk0_bytes)
            if "0001" in path:
                digest.update(chunk1_bytes)
                return ch1_sha, len(chunk1_bytes)
            raise ValueError(f"Unknown chunk: {path}")

        class MockRepo(VireadOcrTrainingRepository):
            def __init__(self):
                super().__init__(SimpleNamespace())
                self.decisions = []
                self.active = dict(active_row)

            async def get_active_model_for_update(self):
                return dict(self.active)

            async def get_active_model(self):
                return dict(self.active)

            async def insert_model_decision(self, **kwargs):
                self.decisions.append(kwargs)

            async def update_active_model(self, **kwargs):
                self.active.update(kwargs)

            async def commit(self):
                pass

            async def rollback(self):
                pass

        repo = MockRepo()
        service = VireadOcrTrainingService(repo.db)
        service.repo = repo
        service._admin = AsyncMock()

        with patch("app.services.viread_ocr_training_service.ensure_storage_capacity", new_callable=AsyncMock), \
             patch("app.services.viread_ocr_training_service.upload_object", side_effect=fake_upload), \
             patch("app.services.viread_ocr_training_service.download_object", side_effect=fake_download), \
             patch("app.services.viread_ocr_training_service.delete_object", side_effect=fake_delete), \
             patch("app.services.viread_ocr_training_service.hash_storage_object", side_effect=fake_stream_hash), \
             patch("app.services.ocr_engine.set_active_viread_model_cache") as mock_set_cache:

            res = await service.activate_flow1_model(
                actor_id=actor_id,
                upload_id=upload_id,
                weights_filename="custom_vietocr_model.pth",
                chunks_json=chunks_json,
                comparison_bytes=comparison_bytes,
                config_bytes=custom_yaml,
                config_filename="custom_config.yml",
                model_version="VietOCR-V2-Custom",
                reason="Admin replacing model with fine-tuned checkpoint",
            )

            # 1. Returned active model
            self.assertEqual(res["active_model"]["checkpoint_sha256"], expected_full_sha)
            self.assertEqual(res["active_model"]["profile"], "FLOW1_EXTERNAL_TRDG")
            self.assertEqual(res["active_model"]["version_label"], "VietOCR-V2-Custom")

            # 2. Cleanup status
            cleanup = res["cleanup"]
            self.assertTrue(cleanup["previous_model_existed"])
            self.assertTrue(cleanup["previous_storage_deleted"])
            self.assertTrue(cleanup["local_cache_deleted"])
            self.assertIn(old_chunk_path, deleted_paths)
            self.assertIn(old_config_path, deleted_paths)
            self.assertIn(old_manifest_path, deleted_paths)
            self.assertFalse(os.path.isfile(cached_pth))

            # 3. Decision recorded
            self.assertEqual(len(repo.decisions), 1)
            dec = repo.decisions[0]
            self.assertEqual(dec["action"], "APPROVE")
            self.assertEqual(dec["candidate_sha"], expected_full_sha)
            self.assertEqual(dec["previous_sha"], old_sha)
            self.assertEqual(dec["candidate_profile"], "FLOW1_EXTERNAL_TRDG")

            # 4. Manifest uploaded and contains metadata & comparison summary
            manifest_path = f"ocr-training/checkpoints/flow1-manual/{upload_id}/checkpoint.manifest.json"
            self.assertIn(manifest_path, uploaded_objects)
            saved_manifest = json.loads(uploaded_objects[manifest_path].decode("utf-8"))
            self.assertEqual(saved_manifest["schema"], "viread-checkpoint-shards-v1")
            self.assertEqual(saved_manifest["model_info"]["version_label"], "VietOCR-V2-Custom")
            self.assertEqual(saved_manifest["model_info"]["config_source"], "custom_yaml")
            self.assertEqual(saved_manifest["comparison_summary"]["verdict"], "IMPROVED")
            self.assertEqual(len(saved_manifest["comparison_summary"]["datasets"]), 2)

            # 5. In-memory cache updated
            mock_set_cache.assert_called_once_with({
                "checkpoint_sha256": expected_full_sha,
                "storage_path": manifest_path,
                "profile": "FLOW1_EXTERNAL_TRDG",
            })

    async def test_activate_without_yaml_config_defaults_to_vgg_transformer(self):
        actor_id = uuid4()
        upload_id = uuid4()

        chunk_bytes = b"PK\x03\x04" + b"z" * 500
        ch_sha = hashlib.sha256(chunk_bytes).hexdigest()
        chunks_data = [
            {"index": 0, "path": f"ocr-training/checkpoints/flow1-manual/{upload_id}/0000-{ch_sha}.part", "sha256": ch_sha, "bytes": len(chunk_bytes)},
        ]
        chunks_json = json.dumps(chunks_data)

        comparison_dict = {
            "models": {"baseline": "vgg_transformer", "finetuned_model_only": "vgg_transformer-v2"},
            "sgk_test": {
                "cer_pct": {"baseline": 10.0, "finetuned_model_only": 3.0},
                "wer_pct": {"baseline": 20.0, "finetuned_model_only": 6.0},
            },
        }
        comparison_bytes = json.dumps(comparison_dict).encode("utf-8")

        uploaded_objects: dict[str, bytes] = {}

        class MockRepo(VireadOcrTrainingRepository):
            def __init__(self):
                super().__init__(SimpleNamespace())
                self.active = {
                    "checkpoint_sha256": "original_sha",
                    "storage_path": None,  # Original baseline has no storage path
                    "profile": "ORIGINAL",
                    "decision_id": None,
                    "updated_at": datetime.now(timezone.utc),
                }

            async def get_active_model_for_update(self):
                return dict(self.active)

            async def get_active_model(self):
                return dict(self.active)

            async def insert_model_decision(self, **kwargs):
                pass

            async def update_active_model(self, **kwargs):
                self.active.update(kwargs)

            async def commit(self):
                pass

            async def rollback(self):
                pass

        repo = MockRepo()
        service = VireadOcrTrainingService(repo.db)
        service.repo = repo
        service._admin = AsyncMock()

        with patch("app.services.viread_ocr_training_service.ensure_storage_capacity", new_callable=AsyncMock), \
             patch("app.services.viread_ocr_training_service.upload_object", side_effect=lambda p, d, *a, **k: uploaded_objects.update({p: d})), \
             patch("app.services.viread_ocr_training_service.hash_storage_object", return_value=(ch_sha, len(chunk_bytes))), \
             patch("app.services.ocr_engine.set_active_viread_model_cache"):

            res = await service.activate_flow1_model(
                actor_id=actor_id,
                upload_id=upload_id,
                weights_filename="weights.pt",
                chunks_json=chunks_json,
                comparison_bytes=comparison_bytes,
                config_bytes=None,
                config_filename=None,
            )

            cleanup = res["cleanup"]
            self.assertFalse(cleanup["previous_model_existed"])
            self.assertFalse(cleanup["previous_storage_deleted"])

            manifest_path = f"ocr-training/checkpoints/flow1-manual/{upload_id}/checkpoint.manifest.json"
            saved_manifest = json.loads(uploaded_objects[manifest_path].decode("utf-8"))
            self.assertIsNone(saved_manifest["config"])
            self.assertEqual(saved_manifest["model_info"]["config_source"], "default_vgg_transformer")

    async def test_activate_rejects_regression_over_baseline(self):
        actor_id = uuid4()
        upload_id = uuid4()

        chunks_data = [{"index": 0, "path": f"ocr-training/checkpoints/flow1-manual/{upload_id}/0000-{'a'*64}.part", "sha256": "a"*64, "bytes": 100}]
        # Candidate CER (15.0) is worse than baseline (12.0)
        comparison_dict = {
            "models": {"baseline": "vgg_transformer", "finetuned_model_only": "vgg_transformer-v2"},
            "sgk_test": {
                "cer_pct": {"baseline": 12.0, "finetuned_model_only": 15.0},
                "wer_pct": {"baseline": 20.0, "finetuned_model_only": 6.0},
            },
        }

        service = VireadOcrTrainingService(SimpleNamespace())
        service._admin = AsyncMock()

        with self.assertRaises(HTTPException) as ctx:
            await service.activate_flow1_model(
                actor_id=actor_id,
                upload_id=upload_id,
                weights_filename="weights.pt",
                chunks_json=json.dumps(chunks_data),
                comparison_bytes=json.dumps(comparison_dict).encode("utf-8"),
            )
        self.assertEqual(ctx.exception.status_code, 422)
        self.assertIn("does not improve CER", ctx.exception.detail)

    async def test_activate_rejects_invalid_yaml(self):
        actor_id = uuid4()
        upload_id = uuid4()
        chunks_data = [{"index": 0, "path": f"ocr-training/checkpoints/flow1-manual/{upload_id}/0000-{'a'*64}.part", "sha256": "a"*64, "bytes": 100}]
        comparison_dict = {
            "models": {"baseline": "vgg_transformer", "finetuned_model_only": "vgg_transformer-v2"},
            "sgk_test": {
                "cer_pct": {"baseline": 12.0, "finetuned_model_only": 4.0},
                "wer_pct": {"baseline": 20.0, "finetuned_model_only": 6.0},
            },
        }
        mock_db = SimpleNamespace(rollback=AsyncMock())
        service = VireadOcrTrainingService(mock_db)
        service._admin = AsyncMock()

        # Non-mapping YAML
        with self.assertRaises(HTTPException) as ctx:
            await service.activate_flow1_model(
                actor_id=actor_id,
                upload_id=upload_id,
                weights_filename="weights.pt",
                chunks_json=json.dumps(chunks_data),
                comparison_bytes=json.dumps(comparison_dict).encode("utf-8"),
                config_bytes=b"just a scalar string",
                config_filename="config.yml",
            )
        self.assertEqual(ctx.exception.status_code, 422)

    async def test_activate_duplicate_rejected(self):
        actor_id = uuid4()
        upload_id = uuid4()

        target_data = b"target chunk bytes"
        target_sha = hashlib.sha256(target_data).hexdigest()

        chunks_data = [{"index": 0, "path": f"ocr-training/checkpoints/flow1-manual/{upload_id}/0000-{target_sha}.part", "sha256": target_sha, "bytes": len(target_data)}]
        comparison_dict = {
            "models": {"baseline": "vgg", "finetuned": "v2"},
            "sgk": {"cer_pct": {"baseline": 10.0, "finetuned": 5.0}, "wer_pct": {"baseline": 20.0, "finetuned": 10.0}},
        }

        class MockRepo:
            async def get_active_model_for_update(self):
                return {
                    "checkpoint_sha256": target_sha,
                    "storage_path": None,
                    "profile": "FLOW1_EXTERNAL_TRDG",
                }

            async def rollback(self):
                pass

        service = VireadOcrTrainingService(SimpleNamespace())
        service.repo = MockRepo()
        service._admin = AsyncMock()

        def fake_hash_storage(path, digest):
            digest.update(target_data)
            return target_sha, len(target_data)

        with patch("app.services.viread_ocr_training_service.ensure_storage_capacity", new_callable=AsyncMock), \
             patch("app.services.viread_ocr_training_service.hash_storage_object", side_effect=fake_hash_storage):

            with self.assertRaises(HTTPException) as ctx:
                await service.activate_flow1_model(
                    actor_id=actor_id,
                    upload_id=upload_id,
                    weights_filename="weights.pt",
                    chunks_json=json.dumps(chunks_data),
                    comparison_bytes=json.dumps(comparison_dict).encode("utf-8"),
                )
            self.assertEqual(ctx.exception.status_code, 409)

    async def test_activate_storage_quota_failure_cleans_up_new_shards(self):
        actor_id = uuid4()
        upload_id = uuid4()
        chunk_sha = "b" * 64
        chunk_path = f"ocr-training/checkpoints/flow1-manual/{upload_id}/0000-{chunk_sha}.part"
        chunks_data = [{"index": 0, "path": chunk_path, "sha256": chunk_sha, "bytes": 100}]

        comparison_dict = {
            "models": {"baseline": "vgg", "finetuned": "v2"},
            "sgk": {"cer_pct": {"baseline": 10.0, "finetuned": 5.0}, "wer_pct": {"baseline": 20.0, "finetuned": 10.0}},
        }

        deleted_paths = []
        rollback_called = False

        class MockRepo:
            async def get_active_model_for_update(self):
                return {"checkpoint_sha256": "old_sha", "storage_path": None, "profile": "ORIGINAL"}

            async def rollback(self):
                nonlocal rollback_called
                rollback_called = True

        service = VireadOcrTrainingService(SimpleNamespace())
        service.repo = MockRepo()
        service._admin = AsyncMock()

        # Simulate storage quota failure when saving manifest
        async def fake_ensure_cap(db, bytes_count, existing_object_path=None):
            if existing_object_path and "manifest" in existing_object_path:
                raise HTTPException(status_code=413, detail="Storage quota exceeded")

        with patch("app.services.viread_ocr_training_service.ensure_storage_capacity", side_effect=fake_ensure_cap), \
             patch("app.services.viread_ocr_training_service.upload_object"), \
             patch("app.services.viread_ocr_training_service.hash_storage_object", return_value=(chunk_sha, 100)), \
             patch("app.services.viread_ocr_training_service.delete_object", side_effect=lambda p: deleted_paths.append(p)):

            with self.assertRaises(HTTPException) as ctx:
                await service.activate_flow1_model(
                    actor_id=actor_id,
                    upload_id=upload_id,
                    weights_filename="weights.pt",
                    chunks_json=json.dumps(chunks_data),
                    comparison_bytes=json.dumps(comparison_dict).encode("utf-8"),
                )
            self.assertEqual(ctx.exception.status_code, 413)
            self.assertTrue(rollback_called)
            self.assertIn(chunk_path, deleted_paths)


    def test_ocr_engine_artifact_loading_and_eviction(self):
        cfg_bytes = b"custom: true\n"
        cfg_sha = hashlib.sha256(cfg_bytes).hexdigest()
        shard0_bytes = b"PK\x03\x04" + b"0" * 16
        s0_sha = hashlib.sha256(shard0_bytes).hexdigest()
        expected_weights_sha = s0_sha

        manifest = {
            "schema": "viread-checkpoint-shards-v1",
            "checkpoint_sha256": expected_weights_sha,
            "chunks": [{"index": 0, "path": "shard0", "sha256": s0_sha, "bytes": len(shard0_bytes)}],
            "config": {
                "storage_path": "cfg_path",
                "sha256": cfg_sha,
                "filename": "cfg.yml",
            },
        }

        with patch("app.services.storage_service.download_object") as mock_dl:
            mock_dl.side_effect = lambda p: (
                json.dumps(manifest).encode("utf-8") if p == "manifest_path"
                else (shard0_bytes if p == "shard0"
                else (cfg_bytes if p == "cfg_path"
                else b""))
            )
            with patch("app.services.ocr_engine._sha256_path", return_value=expected_weights_sha):
                weights_path, custom_cfg, returned_cfg_sha = _v2_artifact_from_storage({
                    "checkpoint_sha256": expected_weights_sha,
                    "storage_path": "manifest_path",
                })

                self.assertIn(expected_weights_sha, weights_path)
                self.assertEqual(custom_cfg, {"custom": True})
                self.assertEqual(returned_cfg_sha, cfg_sha)

        # Test eviction
        evicted = evict_cached_viread_checkpoint(expected_weights_sha)
        self.assertIsInstance(evicted, bool)

