from __future__ import annotations

import sys
import tempfile
import unittest
import os
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[1]
if str(REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(REPO_ROOT))
from types import SimpleNamespace
from unittest.mock import patch

from app.jobs.viread_ocr_training_auto_worker import (
    colab_failure_action,
    dataset_snapshot_count_matches,
    flow1_dataset_readiness,
    local_training_capacity,
)


class TrainingCapacityTests(unittest.TestCase):
    def test_cpu_only_torch_routes_away_from_local_training(self):
        torch_stub = SimpleNamespace(
            __version__="test-cpu",
            version=SimpleNamespace(cuda=None),
            cuda=SimpleNamespace(is_available=lambda: False),
        )
        with patch.dict(os.environ, {"VIREAD_LOCAL_TRAINING_ENABLED": "true"}), \
             patch.dict(sys.modules, {"torch": torch_stub}):
            ready, details = local_training_capacity()
        self.assertFalse(ready)
        self.assertEqual(details["reason"], "CUDA_UNAVAILABLE")

    def test_flow1_readiness_preserves_real_and_trdg_sample_thresholds_and_splits(self):
        valid = {
            "FLOW2_EXTERNAL": 500, "FLOW2_TRDG": 20_000,
            "FLOW2_EXTERNAL_train": 350, "FLOW2_EXTERNAL_validation": 75,
            "FLOW2_TRDG_train": 14_000, "FLOW2_TRDG_validation": 3_000,
        }
        self.assertEqual(flow1_dataset_readiness(valid), (True, None))
        too_few_real = {**valid, "FLOW2_EXTERNAL": 499}
        self.assertEqual(flow1_dataset_readiness(too_few_real), (False, "FLOW2_EXTERNAL_BELOW_MINIMUM"))
        missing_validation = {**valid, "FLOW2_TRDG_validation": 0}
        self.assertEqual(flow1_dataset_readiness(missing_validation),
                         (False, "FLOW2_TRDG_TRAIN_AND_VALIDATION_REQUIRED"))

    def test_local_training_can_be_disabled_without_importing_torch(self):
        with patch.dict(os.environ, {"VIREAD_LOCAL_TRAINING_ENABLED": "false"}):
            ready, details = local_training_capacity()
        self.assertFalse(ready)
        self.assertEqual(details["reason"], "LOCAL_TRAINING_DISABLED")

    def test_colab_failure_retries_only_before_a_run_has_partial_state(self):
        self.assertEqual(colab_failure_action(1, None),
                         ("WAITING_FOR_COLAB_WORKER", "COLAB_EXECUTION_FAILED"))
        self.assertEqual(colab_failure_action(3, None), ("FAILED", "COLAB_EXECUTION_RETRY_LIMIT"))
        self.assertEqual(colab_failure_action(1, "run-id"),
                         ("BLOCKED", "COLAB_RETRY_REQUIRES_RUN_RECOVERY"))

    def test_paid_colab_dispatch_requires_manifest_sample_count_to_match_materialized_rows(self):
        self.assertTrue(dataset_snapshot_count_matches(19, 19))
        self.assertFalse(dataset_snapshot_count_matches(19, 27))
        self.assertFalse(dataset_snapshot_count_matches(19, None))

    def test_colab_worker_rejects_runtime_without_a_real_cuda_gpu(self):
        from ai.vietocr_v2.colab_worker import ColabWorker

        torch_stub = SimpleNamespace(
            __version__="test-cpu",
            version=SimpleNamespace(cuda=None),
            cuda=SimpleNamespace(is_available=lambda: False),
        )
        with patch.dict(sys.modules, {"torch": torch_stub}):
            with self.assertRaisesRegex(RuntimeError, "COLAB_CUDA_UNAVAILABLE"):
                ColabWorker.assert_runtime_capacity(Path(tempfile.gettempdir()))

    def test_colab_capacity_probe_requires_vram_ram_and_disk(self):
        from ai.vietocr_v2.colab_worker import ColabWorker

        cuda = SimpleNamespace(
            is_available=lambda: True,
            mem_get_info=lambda _index: (8 * 1024**3, 16 * 1024**3),
            get_device_name=lambda _index: "Test GPU",
        )
        torch_stub = SimpleNamespace(
            __version__="test-cuda",
            version=SimpleNamespace(cuda="test"),
            cuda=cuda,
        )
        with (
            tempfile.TemporaryDirectory() as temp_dir,
            patch.dict(sys.modules, {"torch": torch_stub}),
            patch.object(ColabWorker, "available_ram_bytes", return_value=16 * 1024**3),
            patch("shutil.disk_usage", return_value=SimpleNamespace(free=20 * 1024**3)),
        ):
            result = ColabWorker.assert_runtime_capacity(Path(temp_dir))
        self.assertEqual(result["device"], "Test GPU")
        self.assertGreaterEqual(result["vram_free_bytes"], 6 * 1024**3)

    def test_colab_capacity_probe_blocks_insufficient_ram_and_disk(self):
        from ai.vietocr_v2.colab_worker import ColabWorker

        cuda = SimpleNamespace(
            is_available=lambda: True,
            mem_get_info=lambda _index: (8 * 1024**3, 16 * 1024**3),
        )
        torch_stub = SimpleNamespace(
            __version__="test-cuda", version=SimpleNamespace(cuda="test"), cuda=cuda,
        )
        with (
            tempfile.TemporaryDirectory() as temp_dir,
            patch.dict(sys.modules, {"torch": torch_stub}),
            patch.object(ColabWorker, "available_ram_bytes", return_value=2 * 1024**3),
        ):
            with self.assertRaisesRegex(RuntimeError, "COLAB_INSUFFICIENT_RAM"):
                ColabWorker.assert_runtime_capacity(Path(temp_dir))
        with (
            tempfile.TemporaryDirectory() as temp_dir,
            patch.dict(sys.modules, {"torch": torch_stub}),
            patch.object(ColabWorker, "available_ram_bytes", return_value=16 * 1024**3),
            patch("shutil.disk_usage", return_value=SimpleNamespace(free=2 * 1024**3)),
        ):
            with self.assertRaisesRegex(RuntimeError, "COLAB_INSUFFICIENT_DISK"):
                ColabWorker.assert_runtime_capacity(Path(temp_dir))


if __name__ == "__main__":
    unittest.main()
