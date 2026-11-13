from __future__ import annotations

import hashlib
import tempfile
import unittest
from pathlib import Path

from .colab_state_store import GCSJobStateStore


JOB_ID = "a5fd82cb-490a-4e59-bad3-64e8a6f88d70"
IDENTITY = {
    "training_job_id": JOB_ID,
    "profile": "FLOW2_ADMIN_VERIFIED",
    "dataset_manifest_sha256": "1" * 64,
    "parent_checkpoint_sha256": "2" * 64,
    "config_sha256": "3" * 64,
    "repository_commit": "a" * 40,
    "locked_test_manifest_sha256": "4" * 64,
    "locked_test_version_id": "b5fd82cb-490a-4e59-bad3-64e8a6f88d71",
}


class FakeBlob:
    def __init__(self, bucket: "FakeBucket", name: str):
        self.bucket = bucket
        self.name = name

    @property
    def generation(self):
        return self.bucket.objects[self.name][1]

    def upload_from_filename(self, filename: str, *, if_generation_match=None):
        current = self.bucket.objects.get(self.name)
        if if_generation_match == 0 and current is not None:
            raise RuntimeError("generation precondition failed")
        if if_generation_match not in (None, 0) and (current is None or current[1] != if_generation_match):
            raise RuntimeError("generation precondition failed")
        generation = 1 if current is None else current[1] + 1
        self.bucket.objects[self.name] = (Path(filename).read_bytes(), generation)

    def download_as_bytes(self):
        return self.bucket.objects[self.name][0]

    def download_to_filename(self, filename: str):
        Path(filename).write_bytes(self.download_as_bytes())

    def delete(self):
        self.bucket.objects.pop(self.name, None)


class FakeBucket:
    def __init__(self):
        self.objects: dict[str, tuple[bytes, int]] = {}

    def blob(self, name: str):
        return FakeBlob(self, name)


class FakeClient:
    def __init__(self):
        self.store = FakeBucket()

    def bucket(self, _bucket_name: str):
        return self.store

    def list_blobs(self, bucket_name: str, *, prefix: str):
        assert bucket_name == "training-state"
        return [FakeBlob(self.store, name) for name in sorted(self.store.objects) if name.startswith(prefix)]


class ColabStateStoreTests(unittest.TestCase):
    def test_round_trip_restores_only_manifest_committed_job_files(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            client = FakeClient()
            run_dir = Path(temp_dir) / "source"
            run_dir.mkdir()
            (run_dir / "latest.pt").write_bytes(b"resumable checkpoint")
            (run_dir / ("best-" + hashlib.sha256(b"best weights").hexdigest() + ".pth")).write_bytes(b"best weights")
            (run_dir / "locked-test-report.json").write_text('{"gate_status":"V2_WIN"}', encoding="utf-8")
            (run_dir / "not-a-resume-artifact.txt").write_text("do not upload", encoding="utf-8")

            first = GCSJobStateStore("gs://training-state/resume", IDENTITY, run_dir, client=client)
            synced = first.sync()
            self.assertEqual(len(synced), 3)
            self.assertFalse(any(name.endswith("not-a-resume-artifact.txt") for name in client.store.objects))

            restored_dir = Path(temp_dir) / "restored"
            restored = GCSJobStateStore("gs://training-state/resume", IDENTITY, restored_dir, client=client)
            restored_hashes = restored.restore()
            self.assertEqual(restored_hashes, synced)
            self.assertEqual((restored_dir / "latest.pt").read_bytes(), b"resumable checkpoint")
            self.assertEqual((restored_dir / "locked-test-report.json").read_text(encoding="utf-8"),
                             '{"gate_status":"V2_WIN"}')

    def test_resume_refuses_another_training_lineage(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            client = FakeClient()
            root = Path(temp_dir) / "run"
            root.mkdir()
            (root / "latest.pt").write_bytes(b"checkpoint")
            GCSJobStateStore("gs://training-state/resume", IDENTITY, root, client=client).sync()
            changed = {**IDENTITY, "dataset_manifest_sha256": "5" * 64}
            other = GCSJobStateStore("gs://training-state/resume", changed, Path(temp_dir) / "other", client=client)
            with self.assertRaisesRegex(ValueError, "identity mismatch"):
                other.restore()

    def test_resume_refuses_corrupt_checkpoint_instead_of_silently_restarting(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            client = FakeClient()
            root = Path(temp_dir) / "run"
            root.mkdir()
            (root / "latest.pt").write_bytes(b"checkpoint")
            store = GCSJobStateStore("gs://training-state/resume", IDENTITY, root, client=client)
            store.sync()
            remote = next(name for name in client.store.objects if name.endswith("/latest.pt"))
            client.store.objects[remote] = (b"corrupted", client.store.objects[remote][1] + 1)
            other = GCSJobStateStore("gs://training-state/resume", IDENTITY, Path(temp_dir) / "restore", client=client)
            with self.assertRaisesRegex(ValueError, "integrity check failed"):
                other.restore()
            self.assertFalse((Path(temp_dir) / "restore" / "latest.pt").exists())

    def test_sync_updates_snapshot_and_removes_obsolete_best_weights(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            client = FakeClient()
            root = Path(temp_dir) / "run"
            root.mkdir()
            old_best = root / ("best-" + "a" * 64 + ".pth")
            old_best.write_bytes(b"old best")
            latest = root / "latest.pt"
            latest.write_bytes(b"checkpoint 1")
            store = GCSJobStateStore("gs://training-state/resume", IDENTITY, root, client=client)
            store.sync()
            old_best.unlink()
            new_best = root / ("best-" + "b" * 64 + ".pth")
            new_best.write_bytes(b"new best")
            latest.write_bytes(b"checkpoint 2")
            store.sync()
            names = set(client.store.objects)
            self.assertFalse(any(name.endswith(old_best.name) for name in names))
            self.assertTrue(any(name.endswith(new_best.name) for name in names))


if __name__ == "__main__":
    unittest.main()
