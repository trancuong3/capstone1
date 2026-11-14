from __future__ import annotations

import hashlib
import json
import sys
import tempfile
import types
import unittest
from pathlib import Path
from unittest.mock import patch

from .colab_worker import ColabWorker, verify_worker_source_lock
from .contracts import sha256_file


class ColabWorkerTests(unittest.TestCase):
    def test_free_colab_capacity_gate_accepts_four_to_eight_gib_available_ram(self):
        available_ram = 6 * 1024**3
        fake_torch = types.SimpleNamespace(
            cuda=types.SimpleNamespace(
                is_available=lambda: True,
                mem_get_info=lambda _device: (8 * 1024**3, 16 * 1024**3),
                get_device_name=lambda _device: "Tesla T4",
            ),
            version=types.SimpleNamespace(cuda="13.0"),
            __version__="2.14.1",
        )
        with tempfile.TemporaryDirectory() as temp_dir:
            with (
                patch.dict(sys.modules, {"torch": fake_torch}),
                patch.object(ColabWorker, "available_ram_bytes", return_value=available_ram),
                patch("ai.vietocr_v2.colab_worker.os.getenv", side_effect=lambda _key, default=None: default),
                patch("ai.vietocr_v2.colab_worker.shutil.disk_usage",
                      return_value=types.SimpleNamespace(free=16 * 1024**3)),
            ):
                capacity = ColabWorker.assert_runtime_capacity(Path(temp_dir))
        self.assertEqual(capacity["ram_available_bytes"], available_ram)

    def test_colab_lock_does_not_replace_preloaded_pillow_mid_kernel(self):
        requirements = Path(__file__).with_name("requirements-colab.txt").read_text()
        pins = [
            line.strip().lower()
            for line in requirements.splitlines()
            if line.strip() and not line.lstrip().startswith("#")
        ]
        self.assertFalse(any(line.startswith("pillow==") for line in pins))

    def test_colab_lock_includes_vietocr_dataloader_dependency(self):
        requirements = Path(__file__).with_name("requirements-colab.txt").read_text()
        pins = {
            line.strip().lower()
            for line in requirements.splitlines()
            if line.strip() and not line.lstrip().startswith("#")
        }
        self.assertIn("prefetch-generator==1.0.1", pins)

    def test_colab_lock_matches_preloaded_numpy_without_replacing_it(self):
        requirements = Path(__file__).with_name("requirements-colab.txt").read_text()
        pins = {
            line.strip().lower()
            for line in requirements.splitlines()
            if line.strip() and not line.lstrip().startswith("#")
        }
        self.assertIn("numpy==2.4.6", pins)
        self.assertNotIn("numpy==2.3.5", pins)

    def test_worker_requires_current_hashes_for_all_training_inputs(self):
        training_dir = Path(__file__).parent
        config = {
            "trainer_sha256": sha256_file(training_dir / "train.py"),
            "requirements_sha256": sha256_file(training_dir / "requirements.txt"),
            "colab_requirements_sha256": sha256_file(training_dir / "requirements-colab.txt"),
        }
        verify_worker_source_lock(config)
        with self.assertRaisesRegex(ValueError, "WORKER_CODE_OR_DEPENDENCY_LOCK_MISMATCH"):
            verify_worker_source_lock({**config, "colab_requirements_sha256": "0" * 64})

    def test_worker_rejects_jobs_without_colab_dependency_lock(self):
        training_dir = Path(__file__).parent
        config = {
            "trainer_sha256": sha256_file(training_dir / "train.py"),
            "requirements_sha256": sha256_file(training_dir / "requirements.txt"),
        }
        with self.assertRaisesRegex(ValueError, "WORKER_CODE_OR_DEPENDENCY_LOCK_MISMATCH"):
            verify_worker_source_lock(config)

    def test_worker_requires_https_for_remote_backend_and_long_token(self):
        with self.assertRaisesRegex(ValueError, "HTTPS"):
            ColabWorker("http://viread.example", "x" * 48, tempfile.gettempdir())
        with self.assertRaisesRegex(ValueError, "32 characters"):
            ColabWorker("https://viread.example", "short", tempfile.gettempdir())

    def test_worker_allows_local_development_backend(self):
        worker = ColabWorker("http://127.0.0.1:8001", "x" * 48, tempfile.gettempdir())
        self.assertEqual(worker.api_base, "http://127.0.0.1:8001")
        worker.session.close()

    def test_candidate_recovery_refuses_checkpoint_hash_different_from_registered_candidate(self):
        worker = ColabWorker("https://viread.example", "x" * 48, tempfile.gettempdir())
        job_id = "a5fd82cb-490a-4e59-bad3-64e8a6f88d70"
        with tempfile.TemporaryDirectory() as temp_dir:
            run_dir = Path(temp_dir)
            candidate_path = run_dir / "candidate.pth"
            candidate_path.write_bytes(b"persisted candidate")
            candidate_sha = sha256_file(candidate_path)
            candidate = {
                "profile": "FLOW2_ADMIN_VERIFIED",
                "parent_checkpoint_sha256": "a" * 64,
                "manifest_sha256": "b" * 64,
                "config_sha256": "c" * 64,
                "architecture_sha256": "d" * 64,
                "vocabulary_sha256": "e" * 64,
                "checkpoint_sha256": candidate_sha,
                "candidate_path": str(candidate_path),
                "steps": 5000,
            }
            (run_dir / "candidate.json").write_text(json.dumps(candidate), encoding="utf-8")
            with patch.object(worker, "call", return_value={
                "run_id": "run-1", "status": "CANDIDATE", "checkpoint_sha256": "f" * 64,
            }) as call:
                with self.assertRaisesRegex(ValueError, "REGISTERED_CANDIDATE_HASH_MISMATCH"):
                    worker.upload_candidate({
                        "id": job_id, "profile": candidate["profile"],
                        "dataset_version_id": "dataset-1", "manifest_sha256": candidate["manifest_sha256"],
                    }, candidate, run_dir)
            call.assert_called_once()
        worker.session.close()

    def test_worker_does_not_claim_jobs_without_gpu_and_reports_waiting_state(self):
        worker = ColabWorker("https://viread.example", "x" * 48, tempfile.gettempdir(), poll_seconds=0)
        with (
            patch.object(ColabWorker, "assert_runtime_capacity", side_effect=RuntimeError("COLAB_CUDA_UNAVAILABLE")),
            patch.object(worker, "report_status") as report_status,
            patch.object(worker, "claim") as claim,
            patch("ai.vietocr_v2.colab_worker.time.sleep", side_effect=KeyboardInterrupt),
        ):
            with self.assertRaises(KeyboardInterrupt):
                worker.run_forever()
        report_status.assert_called_once_with("WAITING_FOR_GPU", "COLAB_CUDA_UNAVAILABLE")
        claim.assert_not_called()
        worker.session.close()

    def test_download_verifies_content_hash_before_publishing_file(self):
        payload = b"verified dataset image"
        digest = hashlib.sha256(payload).hexdigest()

        class FakeResponse:
            def __enter__(self):
                return self

            def __exit__(self, *_args):
                return False

            def raise_for_status(self):
                return None

            def iter_content(self, _chunk_size):
                yield payload

        with tempfile.TemporaryDirectory() as temp_dir:
            target = Path(temp_dir) / "sample.png"
            with patch("ai.vietocr_v2.colab_worker.requests.get", return_value=FakeResponse()):
                ColabWorker.download("https://storage.example/signed", target, digest)
            self.assertEqual(target.read_bytes(), payload)
            self.assertFalse(target.with_suffix(".png.download").exists())

    def test_download_refuses_hash_mismatch_and_leaves_no_partial_target(self):
        class FakeResponse:
            def __enter__(self):
                return self

            def __exit__(self, *_args):
                return False

            def raise_for_status(self):
                return None

            def iter_content(self, _chunk_size):
                yield b"wrong image"

        with tempfile.TemporaryDirectory() as temp_dir:
            target = Path(temp_dir) / "sample.png"
            with patch("ai.vietocr_v2.colab_worker.requests.get", return_value=FakeResponse()):
                with self.assertRaisesRegex(ValueError, "HASH_MISMATCH"):
                    ColabWorker.download("https://storage.example/signed", target, "0" * 64)
            self.assertFalse(target.exists())

    def test_enterprise_one_shot_claims_only_the_requested_job_and_profile(self):
        worker = ColabWorker("https://viread.example", "x" * 48, tempfile.gettempdir())
        job_id = "a5fd82cb-490a-4e59-bad3-64e8a6f88d70"
        job = {"id": job_id, "profile": "FLOW1_EXTERNAL_TRDG"}
        with (
            patch.object(ColabWorker, "assert_runtime_capacity", return_value={"device": "Test GPU"}),
            patch.object(worker, "report_status") as report_status,
            patch.object(worker, "claim", return_value=job) as claim,
            patch.object(worker, "process_job") as process_job,
        ):
            self.assertTrue(worker.run_job_once(job_id, expected_profile="FLOW1_EXTERNAL_TRDG"))
        claim.assert_called_once_with(job_id)
        report_status.assert_called_once_with("READY")
        process_job.assert_called_once_with(job)
        worker.session.close()


if __name__ == "__main__":
    unittest.main()
