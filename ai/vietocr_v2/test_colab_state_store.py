from __future__ import annotations

import hashlib
import tempfile
import unittest
from pathlib import Path

from .colab_state_store import GCSJobStateStore, RemoteBackendJobStateStore


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

    def test_remote_backend_resume_store_works_across_different_colab_accounts_with_chunking(self):
        """Worker A (Account A) syncs chunked checkpoint via backend -> Worker B (Account B) restores intact."""
        import hashlib

        remote_objects: dict[str, bytes] = {}

        class _FakeResp:
            def __init__(self, data: bytes):
                self._data = data
            def raise_for_status(self):
                return None
            def iter_content(self, chunk_size=1024):
                for i in range(0, len(self._data), chunk_size):
                    yield self._data[i : i + chunk_size]
            def __enter__(self):
                return self
            def __exit__(self, *args):
                return False

        class _FakeSession:
            def get(self, url, params=None, stream=True, timeout=300):
                rel = url.split("/resume-state/", 1)[1]
                return _FakeResp(remote_objects[rel])

        class _FakeWorker:
            def __init__(self, wid: str):
                self.worker_id = wid
                self.api_base = "https://viread.example.test"
                self.session = _FakeSession()

            def call(self, method: str, path: str, **kwargs):
                if method == "GET" and path.endswith("/resume-state"):
                    return {
                        "files": [
                            {
                                "name": name,
                                "size_bytes": len(raw),
                                "sha256": hashlib.sha256(raw).hexdigest(),
                            }
                            for name, raw in remote_objects.items()
                        ]
                    }
                if method == "PUT":
                    rel = path.split("/resume-state/", 1)[1]
                    raw = kwargs["files"]["file"][1]
                    expected = kwargs["data"]["expected_sha256"]
                    assert hashlib.sha256(raw).hexdigest() == expected
                    remote_objects[rel] = raw
                    return {"name": rel, "sha256": expected, "size_bytes": len(raw)}
                if method == "DELETE":
                    rel = path.split("/resume-state/", 1)[1]
                    remote_objects.pop(rel, None)
                    return {"name": rel, "deleted": True}
                raise AssertionError(f"Unexpected call {method} {path}")

        with tempfile.TemporaryDirectory() as temp_dir:
            # Account A runs epoch 1 with a checkpoint larger than chunk_bytes -> splits into multi-part blobs
            dir_a = Path(temp_dir) / "colab-acc-a"
            dir_a.mkdir()
            ckpt_bytes = b"V2-CHECKPOINT-" * 12000  # ~168 KiB (> 64 KiB test chunk size)
            (dir_a / "latest.pt").write_bytes(ckpt_bytes)
            old_best = dir_a / ("best-" + "a" * 64 + ".pth")
            old_best.write_bytes(b"best-epoch-1")
            store_a = RemoteBackendJobStateStore(
                _FakeWorker("colab-account-a"), IDENTITY, dir_a, chunk_bytes=64 * 1024
            )
            store_a.sync()
            self.assertIn("resume-manifest.json", remote_objects)
            self.assertTrue(any(".part0000" in k for k in remote_objects))
            self.assertTrue(any(".part0001" in k for k in remote_objects))

            # Account B (completely fresh Colab runtime, NO drive.mount!) resumes exact state
            dir_b = Path(temp_dir) / "colab-acc-b"
            store_b = RemoteBackendJobStateStore(
                _FakeWorker("colab-account-b"), IDENTITY, dir_b, chunk_bytes=64 * 1024
            )
            restored = store_b.restore()
            self.assertIn("latest.pt", restored)
            self.assertEqual((dir_b / "latest.pt").read_bytes(), ckpt_bytes)
            self.assertEqual((dir_b / old_best.name).read_bytes(), b"best-epoch-1")

            # Account B updates best checkpoint -> obsolete Account A blob is pruned cleanly
            (dir_b / old_best.name).unlink()
            new_best = dir_b / ("best-" + "b" * 64 + ".pth")
            new_best.write_bytes(b"best-epoch-2")
            store_b.sync()
            old_sha = hashlib.sha256(b"best-epoch-1").hexdigest()
            new_sha = hashlib.sha256(b"best-epoch-2").hexdigest()
            self.assertNotIn(f"blobs/{old_sha}", remote_objects)
            self.assertIn(f"blobs/{new_sha}", remote_objects)

            # Resuming after a new commit to main (repository_commit changed, lineage hashes same)
            # must succeed without throwing identity mismatch.
            dir_c = Path(temp_dir) / "colab-acc-c"
            next_commit_identity = {**IDENTITY, "repository_commit": "0123456789abcdef" * 2 + "01234567"}
            store_c = RemoteBackendJobStateStore(
                _FakeWorker("colab-account-c"), next_commit_identity, dir_c, chunk_bytes=64 * 1024
            )
            restored_c = store_c.restore()
            self.assertIn("latest.pt", restored_c)

            # Changing dataset/config lineage still fails closed.
            bad_identity = {**IDENTITY, "config_sha256": "f" * 64}
            store_bad = RemoteBackendJobStateStore(
                _FakeWorker("colab-account-d"), bad_identity, dir_c, chunk_bytes=64 * 1024
            )
            with self.assertRaisesRegex(ValueError, "identity mismatch"):
                store_bad.restore()


if __name__ == "__main__":
    unittest.main()
