from __future__ import annotations

import hashlib
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from .colab_worker import ColabWorker


class ColabWorkerTests(unittest.TestCase):
    def test_worker_requires_https_for_remote_backend_and_long_token(self):
        with self.assertRaisesRegex(ValueError, "HTTPS"):
            ColabWorker("http://viread.example", "x" * 48, tempfile.gettempdir())
        with self.assertRaisesRegex(ValueError, "32 characters"):
            ColabWorker("https://viread.example", "short", tempfile.gettempdir())

    def test_worker_allows_local_development_backend(self):
        worker = ColabWorker("http://127.0.0.1:8001", "x" * 48, tempfile.gettempdir())
        self.assertEqual(worker.api_base, "http://127.0.0.1:8001")
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
