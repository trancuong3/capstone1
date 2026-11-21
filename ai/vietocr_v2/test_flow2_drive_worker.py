"""Tests for zero-cost Drive resume store, worker proxy downloads, and benchmark finish bugfix."""

from __future__ import annotations

import hashlib
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from .colab_state_store import LocalDriveJobStateStore, MANIFEST_NAME
from .colab_worker import ColabWorker


class LocalDriveJobStateStoreTests(unittest.TestCase):
    def _identity(self, **overrides: str) -> dict[str, str]:
        base = {
            "training_job_id": "a5fd82cb-490a-4e59-bad3-64e8a6f88d70",
            "profile": "FLOW2_ADMIN_VERIFIED",
            "dataset_manifest_sha256": "1" * 64,
            "parent_checkpoint_sha256": "2" * 64,
            "config_sha256": "3" * 64,
            "repository_commit": "a" * 40,
            "locked_test_manifest_sha256": "unregistered",
            "locked_test_version_id": "unregistered",
        }
        base.update(overrides)
        return base

    def test_drive_resume_round_trip_prunes_obsolete_best_and_blocks_lineage_mismatch(self):
        with tempfile.TemporaryDirectory() as tmp:
            resume_root = Path(tmp) / "drive" / "resume"
            run_a = Path(tmp) / "run-a"
            run_b = Path(tmp) / "run-b"
            identity = self._identity()

            store_a = LocalDriveJobStateStore(resume_root, identity, run_a)
            self.assertEqual(store_a.restore(), {})

            best_old = f"best-{'a' * 64}.pth"
            (run_a / "latest.pt").write_bytes(b"step-100-state")
            (run_a / best_old).write_bytes(b"old-best-weights")
            synced = store_a.sync()
            self.assertIn("latest.pt", synced)
            self.assertIn(best_old, synced)

            # Update best weights and sync again -> obsolete best-*.pth blob must be pruned
            (run_a / best_old).unlink()
            best_new = f"best-{'b' * 64}.pth"
            (run_a / best_new).write_bytes(b"new-best-weights")
            store_a.sync()
            old_sha = hashlib.sha256(b"old-best-weights").hexdigest()
            new_sha = hashlib.sha256(b"new-best-weights").hexdigest()
            self.assertFalse((store_a.blobs_dir / old_sha).exists())
            self.assertTrue((store_a.blobs_dir / new_sha).exists())

            # Restore into a fresh Colab session directory with matching lineage
            store_b = LocalDriveJobStateStore(resume_root, identity, run_b)
            restored = store_b.restore()
            self.assertEqual(set(restored.keys()), {"latest.pt", best_new})
            self.assertEqual((run_b / "latest.pt").read_bytes(), b"step-100-state")
            self.assertEqual((run_b / best_new).read_bytes(), b"new-best-weights")

            # HIGH-04 regression: simulated mid-sync crash writing a new blob BEFORE manifest commit
            # must leave step-100 snapshot 100% intact and restorable!
            step200_bytes = b"step-200-uncommitted"
            step200_sha = hashlib.sha256(step200_bytes).hexdigest()
            (store_a.blobs_dir / step200_sha).write_bytes(step200_bytes)
            run_e = Path(tmp) / "run-e"
            restored_after_crash = LocalDriveJobStateStore(resume_root, identity, run_e).restore()
            self.assertEqual((run_e / "latest.pt").read_bytes(), b"step-100-state")
            self.assertIn("latest.pt", restored_after_crash)

            # Dataset change invalidates resume strictly
            mismatched = LocalDriveJobStateStore(
                resume_root,
                self._identity(dataset_manifest_sha256="9" * 64),
                Path(tmp) / "run-c",
            )
            with self.assertRaisesRegex(ValueError, "identity mismatch"):
                mismatched.restore()

            # Tampering with persisted blob fails integrity check
            step100_sha = hashlib.sha256(b"step-100-state").hexdigest()
            (store_a.blobs_dir / step100_sha).write_bytes(b"corrupted-checkpoint")
            with self.assertRaisesRegex(ValueError, "integrity check failed"):
                LocalDriveJobStateStore(resume_root, identity, Path(tmp) / "run-d").restore()

    def test_benchmark_only_job_skips_training_resume_manifest_even_with_same_job_id(self):
        """CRIT-02 regression: BENCHMARK_ONLY with newly pinned locked_test must not fail resume identity."""
        with tempfile.TemporaryDirectory() as tmp:
            drive_root = Path(tmp) / "drive"
            resume_root = drive_root / "resume"
            job_id = "a5fd82cb-490a-4e59-bad3-64e8a6f88d70"
            # Seed a completed training resume manifest with locked_test='unregistered'
            train_run_dir = Path(tmp) / "train-work" / job_id
            train_run_dir.mkdir(parents=True)
            (train_run_dir / "latest.pt").write_bytes(b"trained-state")
            train_store = LocalDriveJobStateStore(resume_root, self._identity(), train_run_dir)
            train_store.sync()

            # Now run BENCHMARK_ONLY on the exact same job_id with pinned locked_test!
            worker = ColabWorker(
                "https://viread.example",
                "t" * 48,
                Path(tmp) / "eval-work",
                drive_root=drive_root,
                resume_root=resume_root,
            )
            try:
                eval_job = {
                    "id": job_id,
                    "profile": "FLOW2_ADMIN_VERIFIED",
                    "manifest_sha256": "1" * 64,
                    "parent_checkpoint_sha256": "2" * 64,
                    "config_sha256": "3" * 64,
                    "locked_test_version_id": "99999999-9999-4999-8999-999999999999",
                    "locked_test_manifest_sha256": "8" * 64,
                    "metadata": {"operation": "BENCHMARK_ONLY", "evaluation_type": "PILOT"},
                }
                with (
                    patch.object(ColabWorker, "assert_runtime_capacity", return_value={"device": "T4"}),
                    patch.object(worker, "heartbeat_loop"),
                    patch.object(worker, "process_benchmark_only_job") as bench_mock,
                ):
                    worker.process_job(eval_job)
                bench_mock.assert_called_once()
            finally:
                worker.session.close()

    def test_uncommitted_orphan_files_without_manifest_are_rejected(self):
        with tempfile.TemporaryDirectory() as tmp:
            resume_root = Path(tmp) / "drive" / "resume"
            run_dir = Path(tmp) / "run"
            store = LocalDriveJobStateStore(resume_root, self._identity(), run_dir)
            (store.job_dir / "latest.pt").write_bytes(b"partial-uncommitted")
            self.assertFalse((store.job_dir / MANIFEST_NAME).exists())
            with self.assertRaisesRegex(ValueError, "without a manifest"):
                store.restore()


class ColabWorkerDriveProxyAndGateFixTests(unittest.TestCase):
    def test_fetch_artifact_uses_worker_session_only_for_backend_proxy_and_supports_drive_fast_path(self):
        payload = b"verified-flow2-drive-sample-png"
        sha = hashlib.sha256(payload).hexdigest()

        class _FakeStreamResp:
            def __enter__(self):
                return self

            def __exit__(self, *_a):
                return False

            def raise_for_status(self):
                return None

            def iter_content(self, _sz):
                yield payload

        with tempfile.TemporaryDirectory() as tmp:
            drive_root = Path(tmp) / "mounted-drive"
            drive_root.mkdir()
            worker = ColabWorker(
                "https://viread.example",
                "t" * 48,
                Path(tmp) / "work",
                drive_root=drive_root,
            )
            try:
                # 1. Backend relative proxy URL uses worker.session (authenticated)
                dest1 = Path(tmp) / "work" / "proxy.bin"
                with patch.object(worker.session, "get", return_value=_FakeStreamResp()) as sess_get:
                    worker._fetch_artifact(
                        "/books/admin/viread-training/worker/jobs/job-1/artifact-stream?worker_id=w&token=tok",
                        dest1,
                        sha,
                    )
                sess_get.assert_called_once()
                self.assertTrue(
                    sess_get.call_args.args[0].startswith("https://viread.example/books/admin/viread-training/worker/")
                )
                self.assertEqual(dest1.read_bytes(), payload)

                # 2. Mounted Drive fast-path skips network ONLY when SHA-256 matches exactly
                local_drive_file = drive_root / "datasets" / sha / "manifest.json"
                local_drive_file.parent.mkdir(parents=True, exist_ok=True)
                local_drive_file.write_bytes(payload)
                dest2 = Path(tmp) / "work" / "fastpath.json"
                with patch.object(worker.session, "get", side_effect=AssertionError("Should not hit network")):
                    worker._fetch_artifact(
                        "/books/admin/viread-training/worker/jobs/job-1/artifact-stream?worker_id=w&token=tok",
                        dest2,
                        sha,
                        local_drive_candidates=[local_drive_file],
                    )
                self.assertEqual(dest2.read_bytes(), payload)
            finally:
                worker.session.close()

    def test_v2_win_benchmark_reports_benchmarked_status_not_rejected(self):
        """Regression test for colab_worker.py line 578 bug where report.get('gate_status') was always None."""
        with tempfile.TemporaryDirectory() as tmp:
            worker = ColabWorker("https://viread.example", "t" * 48, Path(tmp) / "work")
            try:
                job_id = "a5fd82cb-490a-4e59-bad3-64e8a6f88d70"
                run_id = "11111111-1111-4111-8111-111111111111"
                locked_id = "22222222-2222-4222-8222-222222222222"
                parent_sha = "3" * 64
                cand_bytes = b"candidate-weights"
                cand_sha = hashlib.sha256(cand_bytes).hexdigest()
                locked_sha = "4" * 64
                run_dir = Path(tmp) / "work" / job_id
                run_dir.mkdir(parents=True, exist_ok=True)
                cand_path = run_dir / f"candidate-{cand_sha}.pth"
                cand_path.write_bytes(cand_bytes)

                job = {
                    "id": job_id,
                    "profile": "FLOW2_ADMIN_VERIFIED",
                    "run_id": run_id,
                    "parent_checkpoint_sha256": parent_sha,
                    "locked_test_version_id": locked_id,
                    "locked_test_manifest_sha256": locked_sha,
                    "active_model": {"profile": "ORIGINAL", "checkpoint_sha256": parent_sha},
                    "metadata": {
                        "operation": "BENCHMARK_ONLY",
                        "evaluation_type": "PRODUCTION",
                        "candidate_checkpoint_sha256": cand_sha,
                    },
                }

                # Write cached production benchmark report with quality_gate.status == V2_WIN (no top-level gate_status)
                report = {
                    "candidate_checkpoint_sha256": cand_sha,
                    "locked_manifest_sha256": locked_sha,
                    "parent_checkpoint_sha256": parent_sha,
                    "active_checkpoint_sha256": parent_sha,
                    "quality_gate": {"status": "V2_WIN", "promotion_allowed": True},
                    "outputs": [
                        {"sample_id": "s1", "group_id": "g1", "original": "a", "candidate": "b", "parent": "a", "active": "a"}
                    ],
                }
                (run_dir / f"production-{locked_sha}-benchmark.json").write_text(
                    json.dumps(report), encoding="utf-8"
                )
                orig_file = run_dir / "original-380512193a8b6cbf6fad80deacdc9b6939d10d473d199892fc6408d13775ea59.pth"
                orig_file.write_bytes(b"orig")

                finish_calls: list[dict] = []

                def fake_call(method, path, **kwargs):
                    if path.endswith("/benchmarks"):
                        return {"gate_status": "V2_WIN", "promotion_allowed": True}
                    if path.endswith("/finish"):
                        finish_calls.append(kwargs["json"])
                        return {"status": kwargs["json"]["status"]}
                    return {}

                with (
                    patch.object(
                        worker,
                        "materialize_candidate_artifact",
                        return_value=({"checkpoint_sha256": cand_sha}, cand_path),
                    ),
                    patch.object(
                        worker,
                        "dataset",
                        return_value=({"id": locked_id, "version_sha256": locked_sha}, []),
                    ),
                    patch.object(
                        worker,
                        "materialize_dataset",
                        return_value=(run_dir / "r.json", run_dir / "r.json", run_dir),
                    ),
                    patch.object(worker, "materialize_parent", return_value=orig_file),
                    patch("ai.vietocr_v2.colab_worker.sha256_file", return_value="380512193a8b6cbf6fad80deacdc9b6939d10d473d199892fc6408d13775ea59"),
                    patch.object(worker, "call", side_effect=fake_call),
                ):
                    worker.process_benchmark_only_job(job, run_dir, {})

                self.assertEqual(len(finish_calls), 1)
                self.assertEqual(finish_calls[0]["status"], "BENCHMARKED")
            finally:
                worker.session.close()


if __name__ == "__main__":
    unittest.main()
