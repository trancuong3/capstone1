from __future__ import annotations

import hashlib
import json
import sys
import tempfile
import types
import unittest
from pathlib import Path
from unittest.mock import Mock, patch

import requests

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

    def test_process_job_fails_fast_on_source_lock_before_downloading_dataset(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            worker = ColabWorker("https://viread.example", "x" * 48, temp_dir)
            try:
                job = {
                    "id": "d8cc3c25-5c78-4118-abf4-8aa65b718704",
                    "profile": "FLOW2_ADMIN_VERIFIED",
                    "manifest_sha256": "a" * 64,
                    "config_sha256": "b" * 64,
                    "metadata": {
                        "training_config": {
                            "trainer_sha256": "0" * 64,
                            "requirements_sha256": "0" * 64,
                            "colab_requirements_sha256": "0" * 64,
                        }
                    },
                }
                with patch.object(worker, "assert_runtime_capacity", return_value={"device": "T4"}):
                    with patch.object(worker, "heartbeat_loop", return_value=None):
                        with patch.object(worker, "dataset", side_effect=AssertionError("dataset() must not run on lock mismatch")):
                            with self.assertRaisesRegex(
                                ValueError,
                                r"WORKER_CODE_OR_DEPENDENCY_LOCK_MISMATCH: commit=.*trainer_sha256\(",
                            ):
                                worker.process_job(job)
            finally:
                worker.session.close()

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
            with (
                patch("ai.vietocr_v2.colab_worker.requests.get", return_value=FakeResponse()),
                patch("ai.vietocr_v2.colab_worker.time.sleep"),
            ):
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

    def test_benchmark_only_job_never_enters_the_training_function(self):
        worker = ColabWorker("https://viread.example", "x" * 48, tempfile.gettempdir())
        job = {"id": "a5fd82cb-490a-4e59-bad3-64e8a6f88d70",
               "metadata": {"operation": "BENCHMARK_ONLY", "evaluation_type": "PILOT"}}
        trainer = Mock(side_effect=AssertionError("benchmark-only work must not train"))
        training_module = types.SimpleNamespace(run_training=trainer)
        with (
            patch.object(ColabWorker, "assert_runtime_capacity", return_value={"device": "Test GPU"}),
            patch.object(worker, "heartbeat_loop"),
            patch.object(worker, "process_benchmark_only_job") as benchmark,
            patch.dict(sys.modules, {"ai.vietocr_v2.train": training_module}),
        ):
            worker.process_job(job)
        benchmark.assert_called_once()
        trainer.assert_not_called()
        worker.session.close()

    def test_upload_candidate_sets_job_run_id_immediately_and_sync_throttles_every_500_steps(self):
        import json as _json
        import re as _re
        from ai.vietocr_v2.train import _label_for_locked_vocabulary, ORIGINAL_VOCAB_SHA256

        # Cf invisible format chars stripped cleanly against locked vocab
        cleaned = _label_for_locked_vocabulary("Xin\u200b “chào”", "Xin chào\"'")
        self.assertEqual(cleaned, "Xin \"chào\"")

        # COLAB_INSUFFICIENT_RAM matches backend error_code regex ^[A-Z0-9_]+$
        with tempfile.TemporaryDirectory() as temp_dir:
            worker = ColabWorker("https://viread.example", "x" * 48, temp_dir)
            fake_torch = types.SimpleNamespace(
                __version__="2.5.1+cu121",
                version=types.SimpleNamespace(cuda="12.1"),
                cuda=types.SimpleNamespace(
                    is_available=lambda: True,
                    mem_get_info=lambda _idx: (12 * 1024**3, 15 * 1024**3),
                    get_device_name=lambda _idx: "Tesla T4",
                ),
            )
            with (
                patch.dict(sys.modules, {"torch": fake_torch}),
                patch.object(ColabWorker, "available_ram_bytes", return_value=2 * 1024**3),
            ):
                with self.assertRaises(RuntimeError) as ram_err:
                    ColabWorker.assert_runtime_capacity(Path(temp_dir))
            self.assertRegex(str(ram_err.exception), r"^[A-Z0-9_]+$")

            run_dir = Path(temp_dir) / "run"
            run_dir.mkdir()
            cand_file = run_dir / "candidate.pth"
            cand_file.write_bytes(b"ckpt-bytes")
            cand_sha = hashlib.sha256(b"ckpt-bytes").hexdigest()
            candidate = {
                "candidate_path": str(cand_file),
                "checkpoint_sha256": cand_sha,
                "parent_checkpoint_sha256": "a" * 64,
                "manifest_sha256": "b" * 64,
                "config_sha256": "c" * 64,
                "architecture_sha256": "d" * 64,
                "vocabulary_sha256": ORIGINAL_VOCAB_SHA256,
            }
            job = {
                "id": "11111111-1111-4111-8111-111111111111",
                "profile": "FLOW2_ADMIN_VERIFIED",
                "dataset_version_id": "22222222-2222-4222-8222-222222222222",
            }
            created_run_id = "33333333-3333-4333-8333-333333333333"

            def fake_call(method, path, **kwargs):
                if path.endswith("/runs"):
                    return {"run_id": created_run_id, "status": "CANDIDATE", "checkpoint_sha256": cand_sha}
                raise AssertionError(path)

            with patch.object(worker, "call", side_effect=fake_call):
                rid, rstatus, _ = worker.upload_candidate(job, candidate, run_dir)
            self.assertEqual(rid, created_run_id)
            self.assertEqual(job["run_id"], created_run_id)
            self.assertEqual(rstatus, "CANDIDATE")
            worker.session.close()

    def test_fetch_artifact_retries_on_http_503_and_truncated_200(self):
        payload = b"valid-vietnamese-line-png-bytes"
        expected_sha = hashlib.sha256(payload).hexdigest()

        def _make_resp(status_code: int, chunks: list[bytes], *, content_length: int | None = None):
            resp = Mock()
            resp.status_code = status_code
            resp.headers = {"Content-Length": str(content_length)} if content_length is not None else {}
            if status_code >= 400:
                http_err = requests.HTTPError(f"HTTP {status_code}")
                http_err.response = resp
                resp.raise_for_status.side_effect = http_err
            else:
                resp.raise_for_status.return_value = None
            resp.iter_content.return_value = iter(chunks)
            resp.__enter__ = lambda s: s
            resp.__exit__ = lambda s, *args: None
            return resp

        with tempfile.TemporaryDirectory() as temp_dir:
            worker = ColabWorker("https://viread.example", "t" * 48, temp_dir)
            worker.artifact_fetch_max_attempts = 5
            worker.artifact_fetch_retry_base_seconds = 0.01
            destination = Path(temp_dir) / "sample.png"
            responses = [
                _make_resp(503, []),
                _make_resp(200, []),
                _make_resp(200, [b"abc"], content_length=len(payload)),
                _make_resp(200, [payload], content_length=len(payload)),
            ]
            with (
                patch.object(worker.session, "get", side_effect=responses) as mock_get,
                patch("ai.vietocr_v2.colab_worker.time.sleep") as mock_sleep,
            ):
                worker._fetch_artifact(
                    "/books/admin/viread-training/worker/jobs/j/artifact-stream?worker_id=w&token=tok",
                    destination,
                    expected_sha,
                )
            self.assertEqual(mock_get.call_count, 4)
            self.assertEqual(mock_sleep.call_count, 3)
            self.assertEqual(destination.read_bytes(), payload)
            self.assertFalse(destination.with_suffix(".png.download").exists())
            worker.session.close()

    def test_fetch_artifact_fails_fast_on_http_403_and_exhausts_corrupt_sha(self):
        def _make_resp(status_code: int, body: bytes):
            resp = Mock()
            resp.status_code = status_code
            resp.headers = {"Content-Length": str(len(body))}
            if status_code >= 400:
                http_err = requests.HTTPError(f"HTTP {status_code}")
                http_err.response = resp
                resp.raise_for_status.side_effect = http_err
            else:
                resp.raise_for_status.return_value = None
            resp.iter_content.return_value = iter([body] if body else [])
            resp.__enter__ = lambda s: s
            resp.__exit__ = lambda s, *args: None
            return resp

        with tempfile.TemporaryDirectory() as temp_dir:
            worker = ColabWorker("https://viread.example", "t" * 48, temp_dir)
            worker.artifact_fetch_max_attempts = 3
            worker.artifact_fetch_retry_base_seconds = 0.01

            with (
                patch.object(worker.session, "get", return_value=_make_resp(403, b"forbidden")) as get_403,
                patch("ai.vietocr_v2.colab_worker.time.sleep") as sleep_403,
            ):
                with self.assertRaises(requests.HTTPError):
                    worker._fetch_artifact("/books/admin/viread-training/worker/jobs/j/artifact-stream", Path(temp_dir) / "a.png", "a" * 64)
            self.assertEqual(get_403.call_count, 1)
            sleep_403.assert_not_called()

            with (
                patch.object(worker.session, "get", side_effect=lambda *a, **kw: _make_resp(200, b"corrupt")) as get_bad,
                patch("ai.vietocr_v2.colab_worker.time.sleep") as sleep_bad,
            ):
                with self.assertRaises(ValueError) as sha_err:
                    worker._fetch_artifact("/books/admin/viread-training/worker/jobs/j/artifact-stream", Path(temp_dir) / "b.png", "a" * 64)
            self.assertEqual(str(sha_err.exception), "DOWNLOADED_OBJECT_HASH_MISMATCH")
            self.assertEqual(get_bad.call_count, 3)
            self.assertEqual(sleep_bad.call_count, 2)
            worker.session.close()

    def test_materialize_dataset_refreshes_expired_urls_on_403_and_preserves_order(self):
        import threading as _threading

        with tempfile.TemporaryDirectory() as temp_dir:
            worker = ColabWorker("https://viread.example", "t" * 48, temp_dir)
            worker.artifact_download_workers = 4
            run_dir = Path(temp_dir) / "run"
            run_dir.mkdir()

            receipt_bytes = b'{"version_sha256":"' + (b"r" * 44) + b'"}'
            receipt_sha = hashlib.sha256(receipt_bytes).hexdigest()
            dataset = {
                "version_sha256": receipt_sha,
                "manifest_url": "/books/admin/viread-training/worker/jobs/j/artifact-stream?token=receipt",
            }
            payloads = {}
            initial_items = []
            fresh_items = []
            for idx in range(1, 5):
                sid = f"s{idx}"
                raw = f"image-payload-{idx}".encode("utf-8")
                sha = hashlib.sha256(raw).hexdigest()
                payloads[sid] = raw
                base_item = {
                    "sample_id": sid,
                    "group_id": f"g{(idx - 1) // 2 + 1}",
                    "label": f"Nhãn {idx}",
                    "source_flow": "FLOW1_VERIFIED",
                    "split": "train",
                    "image_sha256": sha,
                }
                initial_items.append({**base_item, "image_url": f"/books/admin/viread-training/worker/jobs/j/artifact-stream?token=expired-{sid}"})
                fresh_items.append({**base_item, "image_url": f"/books/admin/viread-training/worker/jobs/j/artifact-stream?token=fresh-{sid}"})

            fetch_lock = _threading.Lock()
            dataset_calls = [0]

            def fake_dataset(job_id_arg, *, locked_test=False):
                with fetch_lock:
                    dataset_calls[0] += 1
                return dataset, fresh_items

            def fake_fetch(url, destination, expected_sha256=None, *, local_drive_candidates=None):
                if url == dataset["manifest_url"]:
                    destination.parent.mkdir(parents=True, exist_ok=True)
                    destination.write_bytes(receipt_bytes)
                    return
                if "token=expired-" in url:
                    resp = Mock()
                    resp.status_code = 403
                    err = requests.HTTPError("403 Client Error: Forbidden")
                    err.response = resp
                    raise err
                sid = url.split("token=fresh-", 1)[1]
                destination.parent.mkdir(parents=True, exist_ok=True)
                destination.write_bytes(payloads[sid])

            with (
                patch.object(worker, "dataset", side_effect=fake_dataset),
                patch.object(worker, "_fetch_artifact", side_effect=fake_fetch),
            ):
                manifest_path, out_receipt, _ = worker.materialize_dataset("j-1", dataset, initial_items, run_dir)

            self.assertEqual(dataset_calls[0], 1)
            self.assertEqual(out_receipt.read_bytes(), receipt_bytes)
            written_lines = [json.loads(line) for line in manifest_path.read_text(encoding="utf-8").splitlines()]
            self.assertEqual([row["annotation_id"] for row in written_lines], ["s1", "s2", "s3", "s4"])
            for item in initial_items:
                img_file = run_dir / "training-images" / item["image_sha256"]
                self.assertTrue(img_file.is_file())
                self.assertEqual(hashlib.sha256(img_file.read_bytes()).hexdigest(), item["image_sha256"])
            worker.session.close()

    def test_call_retries_transient_502_rewinds_file_streams_and_fails_fast_on_403(self):
        import io

        with tempfile.TemporaryDirectory() as temp_dir:
            worker = ColabWorker("https://viread.example", "t" * 48, temp_dir)
            worker.api_call_max_attempts = 4
            worker.api_call_retry_base_seconds = 0.01

            stream_bytes = b"checkpoint-shard-bytes-123456"
            bio = io.BytesIO(stream_bytes)
            observed_reads: list[bytes] = []

            def _make_resp(status_code: int, json_body: bytes = b"{}"):
                resp = Mock()
                resp.status_code = status_code
                resp.content = json_body
                if json_body.strip().startswith(b"{"):
                    resp.json.return_value = json.loads(json_body.decode("utf-8"))
                else:
                    resp.json.side_effect = ValueError("not json")
                if status_code >= 400:
                    err = requests.HTTPError(f"HTTP {status_code}")
                    err.response = resp
                    resp.raise_for_status.side_effect = err
                else:
                    resp.raise_for_status.return_value = None
                return resp

            attempt_counter = [0]

            def fake_request(method, url, **kwargs):
                attempt_counter[0] += 1
                files = kwargs.get("files") or {}
                observed_reads.append(files["file"][1].read())
                if attempt_counter[0] == 1:
                    return _make_resp(502, b"")
                if attempt_counter[0] == 2:
                    raise requests.ConnectionError("Render restarting")
                return _make_resp(200, b'{"ok": true}')

            sleep_target = f"{__package__}.colab_worker.time.sleep"
            with (
                patch.object(worker.session, "request", side_effect=fake_request),
                patch(sleep_target) as mock_sleep,
            ):
                res = worker.call(
                    "POST",
                    "/books/admin/viread-training/worker/jobs/j/runs/r/chunks",
                    files={"file": ("part.bin", bio, "application/octet-stream")},
                )
            self.assertEqual(res, {"ok": True})
            self.assertEqual(observed_reads, [stream_bytes, stream_bytes, stream_bytes])
            self.assertEqual(mock_sleep.call_count, 2)

            with (
                patch.object(worker.session, "request", return_value=_make_resp(403, b"forbidden")) as req_403,
                patch(sleep_target) as sleep_403,
            ):
                with self.assertRaises(requests.HTTPError):
                    worker.call("POST", "/books/admin/viread-training/worker/jobs/j/finish", json={})
            self.assertEqual(req_403.call_count, 1)
            sleep_403.assert_not_called()
            worker.session.close()

    def test_mid_training_remote_resume_sync_failure_does_not_abort_training(self):
        from .colab_state_store import RemoteBackendJobStateStore

        with tempfile.TemporaryDirectory() as temp_dir:
            worker = ColabWorker("https://viread.example", "t" * 48, temp_dir, use_remote_resume_store=True)
            training_dir = Path(__file__).parent
            config = {
                "profile": "FLOW2_ADMIN_VERIFIED",
                "steps": 5000,
                "batch_size": 8,
                "freeze_epochs": 5,
                "optimizer": "AdamW",
                "scheduler": "CosineAnnealingLR",
                "preprocessing": "opencv-line-v1",
                "fp16": True,
                "seed": 20261113,
                "trainer_sha256": sha256_file(training_dir / "train.py"),
                "requirements_sha256": sha256_file(training_dir / "requirements.txt"),
                "colab_requirements_sha256": sha256_file(training_dir / "requirements-colab.txt"),
            }
            from .contracts import canonical_sha256

            config_sha = canonical_sha256(config)
            job = {
                "id": "11111111-1111-4111-8111-111111111111",
                "profile": "FLOW2_ADMIN_VERIFIED",
                "dataset_version_id": "22222222-2222-4222-8222-222222222222",
                "manifest_sha256": "a" * 64,
                "parent_checkpoint_sha256": "b" * 64,
                "config_sha256": config_sha,
                "metadata": {"training_config": config},
            }
            fake_cand = Path(temp_dir) / "produced.pth"
            fake_cand.write_bytes(b"candidate-weights")
            cand_sha = sha256_file(fake_cand)
            cand_payload = {
                "candidate_path": str(fake_cand),
                "checkpoint_sha256": cand_sha,
                "parent_checkpoint_sha256": "b" * 64,
                "manifest_sha256": "a" * 64,
                "config_sha256": config_sha,
                "architecture_sha256": "c" * 64,
                "vocabulary_sha256": "d" * 64,
                "profile": "FLOW2_ADMIN_VERIFIED",
                "steps": 5000,
            }

            def fake_run_training(**kwargs):
                cb = kwargs["progress_callback"]
                cb(500, 5000)
                cb(2500, 5000)
                cb(5000, 5000)
                return dict(cand_payload)

            upload_calls = []

            def fake_upload(j, cand, rdir):
                upload_calls.append(cand["checkpoint_sha256"])
                return "33333333-3333-4333-8333-333333333333", "CANDIDATE", Path(cand["candidate_path"])

            with (
                patch.object(RemoteBackendJobStateStore, "restore", return_value={}),
                patch.object(RemoteBackendJobStateStore, "sync", side_effect=requests.HTTPError("502 Bad Gateway")),
                patch.object(worker, "assert_runtime_capacity", return_value={"device": "Tesla T4"}),
                patch.object(worker, "heartbeat_loop"),
                patch.object(worker, "dataset", return_value=({"version_sha256": "a" * 64}, [])),
                patch.object(worker, "materialize_parent", return_value=Path(temp_dir) / "parent.pth"),
                patch.object(worker, "materialize_dataset", return_value=(Path(temp_dir) / "m.jsonl", Path(temp_dir) / "r.json", Path(temp_dir) / "imgs")),
                patch.object(worker, "upload_candidate", side_effect=fake_upload),
                patch.object(worker, "call", return_value={}),
                patch.dict(sys.modules, {f"{__package__}.train": types.SimpleNamespace(run_training=fake_run_training)}),
            ):
                worker.process_job(job)

            self.assertEqual(upload_calls, [cand_sha])
            worker.session.close()

    def test_colab_worker_notebook_requires_only_worker_token_with_default_api_base(self):
        nb_path = Path(__file__).with_name("viread_vietocr_v2_colab_worker.ipynb")
        nb = json.loads(nb_path.read_text(encoding="utf-8"))
        self.assertEqual(len(nb.get("cells", [])), 2)
        code_src = "".join(nb["cells"][1].get("source", []))
        compile(code_src, str(nb_path), "exec")
        self.assertIn('DEFAULT_API_BASE = "https://capstone1-ssd8.onrender.com"', code_src)
        self.assertIn('"VIREAD_TRAINING_WORKER_TOKEN"', code_src)
        self.assertIn('"IREAD_TRAINING_WORKER_TOKEN"', code_src)
        self.assertIn("getpass(", code_src)
        self.assertIn("run_next_job_once(", code_src)

    def test_fetch_artifact_retries_cloudflare_http_520_to_530(self):
        payload = b"recovered-image-after-520"
        expected_sha = hashlib.sha256(payload).hexdigest()
        attempts = [0]

        class FakeStreamResponse:
            def __init__(self, status_code: int, body: bytes):
                self.status_code = status_code
                self._body = body
                self.headers = {"Content-Length": str(len(body))}

            def __enter__(self):
                return self

            def __exit__(self, *_args):
                return False

            def raise_for_status(self):
                if self.status_code >= 400:
                    err = requests.HTTPError(f"{self.status_code} Server Error")
                    err.response = self
                    raise err

            def iter_content(self, _chunk_size):
                yield self._body

        with tempfile.TemporaryDirectory() as temp_dir:
            worker = ColabWorker("https://viread.example", "t" * 48, temp_dir)
            worker.artifact_fetch_retry_base_seconds = 0.0
            dest = Path(temp_dir) / "img.png"

            def fake_get(_url, **_kwargs):
                attempts[0] += 1
                if attempts[0] == 1:
                    return FakeStreamResponse(520, b"")
                if attempts[0] == 2:
                    return FakeStreamResponse(524, b"")
                return FakeStreamResponse(200, payload)

            with patch.object(worker.session, "get", side_effect=fake_get):
                worker._fetch_artifact("/books/admin/viread-training/worker/jobs/1/artifact-stream", dest, expected_sha)
            self.assertEqual(attempts[0], 3)
            self.assertEqual(dest.read_bytes(), payload)
            worker.session.close()

    def test_linux_available_ram_uses_proc_meminfo_and_cgroup_v2_reclaimable(self):
        gib = 1024**3
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            meminfo = root / "meminfo"
            # Low MemFree (1 GiB) but high MemAvailable (10 GiB) due to page cache
            meminfo.write_text(
                "MemTotal:       13000000 kB\n"
                f"MemFree:        {1 * 1024 * 1024} kB\n"
                f"MemAvailable:   {10 * 1024 * 1024} kB\n"
                f"Buffers:        {1 * 1024 * 1024} kB\n"
                f"Cached:         {7 * 1024 * 1024} kB\n"
                f"SReclaimable:   {1 * 1024 * 1024} kB\n",
                encoding="ascii",
            )
            cg2 = root / "cg2"
            cg2.mkdir()
            # Cgroup v2: max=12 GiB, current=10 GiB, inactive_file=6 GiB, slab_reclaimable=1 GiB
            # Raw max-current would be 2 GiB (false COLAB_INSUFFICIENT_RAM!),
            # whereas adjusted used=3 GiB -> cgroup_available=9 GiB.
            (cg2 / "memory.max").write_text(str(12 * gib), encoding="ascii")
            (cg2 / "memory.current").write_text(str(10 * gib), encoding="ascii")
            (cg2 / "memory.stat").write_text(
                f"anon {3 * gib}\n"
                f"inactive_file {6 * gib}\n"
                f"slab_reclaimable {1 * gib}\n",
                encoding="ascii",
            )
            avail_v2, breakdown_v2 = ColabWorker._linux_available_ram_breakdown(
                meminfo_path=meminfo,
                cgroup_v2_dir=cg2,
                cgroup_v1_dir=root / "nonexistent_cg1",
            )
            self.assertEqual(avail_v2, 9 * gib)
            self.assertEqual(breakdown_v2["host_source"], "proc_meminfo:MemAvailable")
            self.assertEqual(breakdown_v2["cgroup_version"], "v2")
            self.assertEqual(breakdown_v2["cgroup_used_bytes"], 3 * gib)
            self.assertEqual(breakdown_v2["cgroup_available_bytes"], 9 * gib)

            # Fallback when MemAvailable is absent: MemFree + Buffers + Cached + SReclaimable
            meminfo_fallback = root / "meminfo_no_avail"
            meminfo_fallback.write_text(
                f"MemFree:        {2 * 1024 * 1024} kB\n"
                f"Buffers:        {1 * 1024 * 1024} kB\n"
                f"Cached:         {4 * 1024 * 1024} kB\n"
                f"SReclaimable:   {1 * 1024 * 1024} kB\n",
                encoding="ascii",
            )
            cg1 = root / "cg1"
            cg1.mkdir()
            (cg1 / "memory.limit_in_bytes").write_text(str(12 * gib), encoding="ascii")
            (cg1 / "memory.usage_in_bytes").write_text(str(10 * gib), encoding="ascii")
            (cg1 / "memory.stat").write_text(f"total_inactive_file {5 * gib}\n", encoding="ascii")
            avail_v1, breakdown_v1 = ColabWorker._linux_available_ram_breakdown(
                meminfo_path=meminfo_fallback,
                cgroup_v2_dir=root / "nonexistent_cg2",
                cgroup_v1_dir=cg1,
            )
            # host=8 GiB, cgroup_used=5 GiB -> cgroup_avail=7 GiB -> min(8, 7)=7 GiB
            self.assertEqual(avail_v1, 7 * gib)
            self.assertEqual(breakdown_v1["host_source"], "proc_meminfo:MemFree+Buffers+Cached+SReclaimable")
            self.assertEqual(breakdown_v1["cgroup_version"], "v1")

            # Verify assert_runtime_capacity logs numeric breakdown and keeps exact error string
            fake_torch = types.SimpleNamespace(
                __version__="2.14.1",
                version=types.SimpleNamespace(cuda="13.0"),
                cuda=types.SimpleNamespace(
                    is_available=lambda: True,
                    mem_get_info=lambda _idx: (12 * gib, 16 * gib),
                    get_device_name=lambda _idx: "Tesla T4",
                ),
            )
            with (
                patch.dict(sys.modules, {"torch": fake_torch}),
                patch.object(ColabWorker, "available_ram_bytes", return_value=2 * gib),
                patch(f"{__package__}.colab_worker.logger.warning") as mock_warn,
            ):
                with self.assertRaises(RuntimeError) as ctx:
                    ColabWorker.assert_runtime_capacity(root / "work")
            self.assertEqual(str(ctx.exception), "COLAB_INSUFFICIENT_RAM")
            self.assertTrue(mock_warn.called)
            warn_msg = mock_warn.call_args[0][0] % mock_warn.call_args[0][1:]
            self.assertIn("available_bytes=", warn_msg)
            self.assertIn("minimum_bytes=", warn_msg)

    def test_process_job_skips_final_sync_after_finish_and_syncs_on_error(self):
        from .colab_state_store import RemoteBackendJobStateStore
        from .contracts import canonical_sha256

        with tempfile.TemporaryDirectory() as temp_dir:
            worker = ColabWorker("https://viread.example", "t" * 48, temp_dir, use_remote_resume_store=True)
            training_dir = Path(__file__).parent
            config = {
                "profile": "FLOW2_ADMIN_VERIFIED",
                "steps": 100,
                "batch_size": 8,
                "freeze_epochs": 1,
                "optimizer": "AdamW",
                "scheduler": "CosineAnnealingLR",
                "preprocessing": "opencv-line-v1",
                "fp16": True,
                "seed": 20261113,
                "trainer_sha256": sha256_file(training_dir / "train.py"),
                "requirements_sha256": sha256_file(training_dir / "requirements.txt"),
                "colab_requirements_sha256": sha256_file(training_dir / "requirements-colab.txt"),
            }
            config_sha = canonical_sha256(config)
            job = {
                "id": "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
                "profile": "FLOW2_ADMIN_VERIFIED",
                "dataset_version_id": "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
                "manifest_sha256": "a" * 64,
                "parent_checkpoint_sha256": "b" * 64,
                "config_sha256": config_sha,
                "metadata": {"training_config": config},
            }
            fake_cand = Path(temp_dir) / "produced.pth"
            fake_cand.write_bytes(b"candidate-weights")
            cand_sha = sha256_file(fake_cand)
            cand_payload = {
                "candidate_path": str(fake_cand),
                "checkpoint_sha256": cand_sha,
                "parent_checkpoint_sha256": "b" * 64,
                "manifest_sha256": "a" * 64,
                "config_sha256": config_sha,
                "architecture_sha256": "c" * 64,
                "vocabulary_sha256": "d" * 64,
                "profile": "FLOW2_ADMIN_VERIFIED",
                "steps": 100,
            }

            events: list[str] = []

            def fake_sync(_self):
                events.append("sync")

            def fake_call(method, path, **kwargs):
                if path.endswith("/finish"):
                    events.append("finish")
                return {}

            with (
                patch.object(RemoteBackendJobStateStore, "restore", return_value={}),
                patch.object(RemoteBackendJobStateStore, "sync", fake_sync),
                patch.object(worker, "assert_runtime_capacity", return_value={"device": "Tesla T4"}),
                patch.object(worker, "heartbeat_loop"),
                patch.object(worker, "dataset", return_value=({"version_sha256": "a" * 64}, [])),
                patch.object(worker, "materialize_parent", return_value=Path(temp_dir) / "parent.pth"),
                patch.object(worker, "materialize_dataset", return_value=(Path(temp_dir) / "m.jsonl", Path(temp_dir) / "r.json", Path(temp_dir) / "imgs")),
                patch.object(worker, "upload_candidate", return_value=("run-1", "CANDIDATE", fake_cand)),
                patch.object(worker, "call", side_effect=fake_call),
                patch.dict(sys.modules, {f"{__package__}.train": types.SimpleNamespace(run_training=lambda **_kw: dict(cand_payload))}),
            ):
                worker.process_job(job)

            # Only post-training sync happened before upload; NO sync after /finish!
            self.assertEqual(events, ["sync", "finish"])

            # Error before /finish MUST still trigger final sync in finally
            events.clear()
            with (
                patch.object(RemoteBackendJobStateStore, "restore", return_value={}),
                patch.object(RemoteBackendJobStateStore, "sync", fake_sync),
                patch.object(worker, "assert_runtime_capacity", return_value={"device": "Tesla T4"}),
                patch.object(worker, "heartbeat_loop"),
                patch.object(worker, "dataset", side_effect=RuntimeError("boom")),
            ):
                with self.assertRaisesRegex(RuntimeError, "boom"):
                    worker.process_job({**job, "id": "cccccccc-cccc-4ccc-8ccc-cccccccccccc"})
            self.assertEqual(events, ["sync"])
            worker.session.close()

    def test_single_pass_benchmark_frees_cuda_cache_and_tolerates_pre_benchmark_remote_sync_error(self):
        from .colab_state_store import RemoteBackendJobStateStore
        from .contracts import ORIGINAL_CHECKPOINT_SHA256, canonical_sha256

        with tempfile.TemporaryDirectory() as temp_dir:
            worker = ColabWorker("https://viread.example", "t" * 48, temp_dir, use_remote_resume_store=True)
            training_dir = Path(__file__).parent
            config = {
                "profile": "FLOW2_ADMIN_VERIFIED",
                "steps": 100,
                "batch_size": 8,
                "freeze_epochs": 1,
                "optimizer": "AdamW",
                "scheduler": "CosineAnnealingLR",
                "preprocessing": "opencv-line-v1",
                "fp16": True,
                "seed": 20261113,
                "trainer_sha256": sha256_file(training_dir / "train.py"),
                "requirements_sha256": sha256_file(training_dir / "requirements.txt"),
                "colab_requirements_sha256": sha256_file(training_dir / "requirements-colab.txt"),
            }
            config_sha = canonical_sha256(config)
            job_id = "dddddddd-dddd-4ddd-8ddd-dddddddddddd"
            locked_sha = "e" * 64
            job = {
                "id": job_id,
                "profile": "FLOW2_ADMIN_VERIFIED",
                "dataset_version_id": "22222222-2222-4222-8222-222222222222",
                "manifest_sha256": "a" * 64,
                "parent_checkpoint_sha256": "b" * 64,
                "config_sha256": config_sha,
                "locked_test_version_id": "lt-version-1",
                "locked_test_manifest_sha256": locked_sha,
                "active_model": {"profile": "ORIGINAL"},
                "metadata": {"training_config": config},
            }
            run_dir = Path(temp_dir) / job_id
            run_dir.mkdir(parents=True, exist_ok=True)
            fake_cand = Path(temp_dir) / "produced.pth"
            fake_cand.write_bytes(b"candidate-weights")
            cand_sha = sha256_file(fake_cand)
            cand_payload = {
                "candidate_path": str(fake_cand),
                "checkpoint_sha256": cand_sha,
                "parent_checkpoint_sha256": "b" * 64,
                "manifest_sha256": "a" * 64,
                "config_sha256": config_sha,
                "architecture_sha256": "c" * 64,
                "vocabulary_sha256": "d" * 64,
                "profile": "FLOW2_ADMIN_VERIFIED",
                "steps": 100,
            }
            orig_file = run_dir / f"original-{ORIGINAL_CHECKPOINT_SHA256}.pth"
            orig_file.write_bytes(b"orig")

            events: list[str] = []
            sync_calls = [0]

            def fake_sync(_self):
                sync_calls[0] += 1
                events.append(f"sync-{sync_calls[0]}")
                raise requests.HTTPError("502 Bad Gateway")

            def fake_dataset(_jid, *, locked_test=False):
                if locked_test:
                    return {"id": "lt-version-1", "version_sha256": locked_sha}, []
                return {"version_sha256": "a" * 64}, []

            def fake_empty_cache():
                events.append("empty_cache")

            def fake_run_locked_benchmark(**_kw):
                events.append("run_locked_benchmark")
                return {
                    "candidate_checkpoint_sha256": cand_sha,
                    "locked_manifest_sha256": locked_sha,
                    "quality_gate": {"status": "V2_WIN"},
                    "outputs": [{"sample_id": "s1", "group_id": "g1", "original": "a", "candidate": "b"}],
                }

            def fake_call(method, path, **kwargs):
                if path.endswith("/benchmarks"):
                    events.append("post_benchmarks")
                    return {"gate_status": "V2_WIN"}
                if path.endswith("/finish"):
                    events.append(f"finish:{kwargs['json']['status']}")
                    return {}
                return {}

            fake_torch = types.SimpleNamespace(
                cuda=types.SimpleNamespace(
                    is_available=lambda: True,
                    empty_cache=fake_empty_cache,
                )
            )
            real_sha256_file = sha256_file

            def fake_sha256(path):
                if Path(path) == orig_file:
                    return ORIGINAL_CHECKPOINT_SHA256
                return real_sha256_file(path)

            with (
                patch.object(RemoteBackendJobStateStore, "restore", return_value={}),
                patch.object(RemoteBackendJobStateStore, "sync", fake_sync),
                patch.object(worker, "assert_runtime_capacity", return_value={"device": "Tesla T4"}),
                patch.object(worker, "heartbeat_loop"),
                patch.object(worker, "dataset", side_effect=fake_dataset),
                patch.object(worker, "materialize_parent", return_value=Path(temp_dir) / "parent.pth"),
                patch.object(worker, "materialize_dataset", return_value=(Path(temp_dir) / "m.jsonl", Path(temp_dir) / "r.json", Path(temp_dir) / "imgs")),
                patch.object(worker, "upload_candidate", return_value=("run-1", "CANDIDATE", fake_cand)),
                patch.object(worker, "call", side_effect=fake_call),
                patch(f"{__package__}.colab_worker.sha256_file", side_effect=fake_sha256),
                patch(f"{__package__}.colab_worker.gc.collect", side_effect=lambda: events.append("gc_collect")),
                patch.dict(
                    sys.modules,
                    {
                        "torch": fake_torch,
                        f"{__package__}.train": types.SimpleNamespace(run_training=lambda **_kw: dict(cand_payload)),
                        f"{__package__}.benchmark": types.SimpleNamespace(run_locked_benchmark=fake_run_locked_benchmark),
                    },
                ),
            ):
                worker.process_job(job)

            self.assertEqual(
                events,
                [
                    "sync-1",
                    "gc_collect",
                    "empty_cache",
                    "run_locked_benchmark",
                    "sync-2",
                    "post_benchmarks",
                    "finish:BENCHMARKED",
                ],
            )
            worker.session.close()

    def test_colab_worker_notebook_rerun_safety_guards(self):
        nb_path = Path(__file__).with_name("viread_vietocr_v2_colab_worker.ipynb")
        nb = json.loads(nb_path.read_text(encoding="utf-8"))
        code_src = "".join(nb["cells"][1].get("source", []))
        compile(code_src, str(nb_path), "exec")
        chdir_idx = code_src.find('os.chdir("/content")')
        repo_exists_idx = code_src.find("if REPO.exists():")
        self.assertGreaterEqual(chdir_idx, 0)
        self.assertGreater(repo_exists_idx, chdir_idx)
        self.assertIn("importlib.metadata.version", code_src)
        self.assertIn('"--no-cache-dir"', code_src)
        self.assertIn('os.environ["VIREAD_TRAINING_WORKER_TOKEN"]', code_src)
        self.assertIn('"viread_vietocr_v2_preprocessing"', code_src)


if __name__ == "__main__":
    unittest.main()
