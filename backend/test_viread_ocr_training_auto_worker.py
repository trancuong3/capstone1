from __future__ import annotations

import sys
import tempfile
import unittest
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[1]
if str(REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(REPO_ROOT))
from types import SimpleNamespace
from unittest.mock import patch

from app.jobs.viread_ocr_training_auto_worker import local_training_capacity


class TrainingCapacityTests(unittest.TestCase):
    def test_cpu_only_torch_routes_away_from_local_training(self):
        torch_stub = SimpleNamespace(
            __version__="test-cpu",
            version=SimpleNamespace(cuda=None),
            cuda=SimpleNamespace(is_available=lambda: False),
        )
        with patch.dict(sys.modules, {"torch": torch_stub}):
            ready, details = local_training_capacity()
        self.assertFalse(ready)
        self.assertEqual(details["reason"], "CUDA_UNAVAILABLE")

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
