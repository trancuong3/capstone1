from __future__ import annotations

import asyncio
import hashlib
import sys
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch
from uuid import UUID

REPO_ROOT = Path(__file__).resolve().parents[1]
if str(REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(REPO_ROOT))

from app.api.routes import admin_viread_training
from app.schemas.viread_ocr_training import TrainingRunComplete
from app.services import storage_service
from app.services import viread_ocr_training_service
from app.services.viread_ocr_training_service import VireadOcrTrainingService


class _StreamingResponse:
    def __init__(self, blocks: list[bytes]):
        self.blocks = blocks

    def __enter__(self):
        return self

    def __exit__(self, *_args):
        return False

    def raise_for_status(self):
        return None

    def iter_content(self, chunk_size: int):
        self.chunk_size = chunk_size
        yield from self.blocks


class CheckpointStreamingTests(unittest.TestCase):
    def test_hash_storage_object_streams_and_updates_aggregate_digest(self):
        blocks = [b"checkpoint shard ", b"contents"]
        response = _StreamingResponse(blocks)
        aggregate = hashlib.sha256()
        with (
            patch.object(storage_service, "SUPABASE_URL", "https://project.supabase.co"),
            patch.object(storage_service, "SUPABASE_ADMIN_KEY", "test-service-key"),
            patch.object(storage_service, "_bucket_name", return_value="private-bucket"),
            patch.object(storage_service.requests, "get", return_value=response) as get,
        ):
            digest, byte_count = storage_service.hash_storage_object("ocr-training/chunks/a.bin", aggregate)

        body = b"".join(blocks)
        self.assertEqual(digest, hashlib.sha256(body).hexdigest())
        self.assertEqual(aggregate.hexdigest(), hashlib.sha256(body).hexdigest())
        self.assertEqual(byte_count, len(body))
        self.assertEqual(get.call_args.kwargs["stream"], True)
        self.assertEqual(response.chunk_size, 1024 * 1024)
        self.assertIn("/object/authenticated/private-bucket/ocr-training/chunks/a.bin", get.call_args.args[0])


class CompleteRunRouteLockTests(unittest.TestCase):
    def test_releases_job_row_lock_before_storage_verification(self):
        events: list[str] = []
        actor_id = UUID("03db2619-ea6a-41ef-b7fd-02e5cc91cc53")
        job_id = UUID("bb934c35-5ba2-45f8-b4c0-6159fd6b20cf")
        run_id = UUID("0122c065-25d4-4ac5-9f57-4f379aa6b2ee")

        class FakeDb:
            async def commit(self):
                events.append("commit")

            async def rollback(self):
                events.append("rollback")

        class FakeService:
            def __init__(self, _db):
                pass

            async def _admin(self, received_actor_id):
                events.append("admin")
                self.actor_id = received_actor_id

            async def complete_run(self, received_actor_id, received_run_id, payload, *, job_id, worker_id):
                events.append("complete")
                self.assertions = (received_actor_id, received_run_id, payload.profile, job_id, worker_id)
                return {"status": "CANDIDATE"}

        async def leased_job(_service, received_job_id, worker_id):
            events.append("lease")
            return {
                "run_id": run_id,
                "profile": "FLOW2_ADMIN_VERIFIED",
                "created_by": actor_id,
            }

        payload = TrainingRunComplete(
            profile="FLOW2_ADMIN_VERIFIED",
            parent_checkpoint_sha256="a" * 64,
            manifest_sha256="b" * 64,
            config_sha256="c" * 64,
            architecture_sha256="d" * 64,
            vocabulary_sha256="e" * 64,
            checkpoint_sha256="f" * 64,
            checkpoint_bytes=123,
            step=5000,
        )
        with (
            patch.object(admin_viread_training, "VireadOcrTrainingService", FakeService),
            patch.object(admin_viread_training, "_leased_colab_job", leased_job),
        ):
            result = asyncio.run(admin_viread_training.complete_viread_colab_job_run(
                job_id=job_id,
                run_id=run_id,
                worker_id="worker-test",
                payload=payload,
                _worker=None,
                db=FakeDb(),
            ))

        self.assertEqual(result, {"status": "CANDIDATE"})
        self.assertEqual(events, ["lease", "admin", "commit", "complete"])


class LockedTestRouteTests(unittest.TestCase):
    def test_locked_test_route_selects_and_uses_locked_dataset_fields(self):
        actor_id = UUID("03db2619-ea6a-41ef-b7fd-02e5cc91cc53")
        job_id = UUID("bb934c35-5ba2-45f8-b4c0-6159fd6b20cf")
        locked_test_id = UUID("bb934c35-5ba2-45f8-b4c0-6159fd6b20cd")
        selected_job_columns: list[str] = []

        class FakeRepo:
            async def one(self, sql, _params=None):
                if "FROM public.viread_ocr_training_jobs WHERE id=:id FOR UPDATE" in sql:
                    select_clause = sql.split("FROM", 1)[0]
                    selected_job_columns.extend((
                        "locked_test_version_id" if "locked_test_version_id" in select_clause else "",
                        "locked_test_manifest_sha256" if "locked_test_manifest_sha256" in select_clause else "",
                    ))
                    job = {
                        "id": job_id,
                        "profile": "FLOW2_ADMIN_VERIFIED",
                        "status": "COLAB_RUNNING",
                        "target": "COLAB",
                        "worker_id": "worker-test",
                        "created_by": actor_id,
                        "locked_test_version_id": locked_test_id,
                        "locked_test_manifest_sha256": "a" * 64,
                    }
                    return {key: value for key, value in job.items() if key in select_clause}
                if "FROM public.viread_ocr_dataset_versions" in sql:
                    return {
                        "id": locked_test_id,
                        "source_flow": "LOCKED_TEST",
                        "version_sha256": "a" * 64,
                        "sample_count": 1,
                        "is_locked_test": True,
                        "manifest_storage_path": "ocr-training/locked-test/manifest.json",
                    }
                raise AssertionError(f"Unexpected query: {sql}")

        class FakeService:
            def __init__(self, _db):
                self.repo = FakeRepo()

            async def _admin(self, received_actor_id):
                if received_actor_id != actor_id:
                    raise AssertionError("Unexpected admin actor")

            async def dataset_samples(self, received_actor_id, dataset_id, *, limit, offset):
                return {"dataset": {"version_sha256": "a" * 64, "id": str(dataset_id)},
                        "items": [{"label": "text"}], "next_offset": None}

        class FakeDb:
            async def commit(self):
                return None

            async def rollback(self):
                return None

            async def execute(self, *_args, **_kwargs):
                return None

        with patch.object(admin_viread_training, "VireadOcrTrainingService", FakeService):
            result = asyncio.run(admin_viread_training.get_viread_colab_job_locked_test(
                job_id=job_id,
                worker_id="worker-test",
                limit=200,
                offset=0,
                _worker=None,
                db=FakeDb(),
            ))

        self.assertEqual(selected_job_columns, ["locked_test_version_id", "locked_test_manifest_sha256"])
        self.assertEqual(result["dataset"]["id"], str(locked_test_id))
        self.assertEqual(result["items"], [{"label": "text"}])


class CompleteRunStreamingTests(unittest.TestCase):
    def test_verifies_checkpoint_shards_without_buffering_and_persists_candidate(self):
        actor_id = UUID("03db2619-ea6a-41ef-b7fd-02e5cc91cc53")
        job_id = UUID("bb934c35-5ba2-45f8-b4c0-6159fd6b20cf")
        run_id = UUID("0122c065-25d4-4ac5-9f57-4f379aa6b2ee")
        shard_bodies = [b"first checkpoint shard", b"second checkpoint shard"]
        checkpoint = b"".join(shard_bodies)
        identity = {
            "profile": "FLOW2_ADMIN_VERIFIED",
            "parent_checkpoint_sha256": "a" * 64,
            "manifest_sha256": "b" * 64,
            "config_sha256": "c" * 64,
            "architecture_sha256": "d" * 64,
            "vocabulary_sha256": "e" * 64,
        }
        run = {"id": run_id, "status": "RUNNING", **identity}
        chunks = [
            {"chunk_index": index, "chunk_sha256": hashlib.sha256(body).hexdigest(),
             "storage_path": f"ocr-training/checkpoints/{run_id}/{index:04d}.part", "byte_count": len(body)}
            for index, body in enumerate(shard_bodies)
        ]
        latest_run = {"status": "RUNNING", "checkpoint_sha256": None,
                      "checkpoint_bytes": None, "step": 0, "checkpoint_storage_path": None}
        job = {"id": job_id, "target": "COLAB", "status": "COLAB_RUNNING", "worker_id": "worker-test",
               "run_id": run_id, "profile": identity["profile"], "created_by": actor_id,
               "lease_expires_at": datetime.now(timezone.utc) + timedelta(minutes=5)}

        class FakeRepo:
            def __init__(self):
                self.events: list[str] = []

            async def one(self, sql, _params=None):
                if "SELECT * FROM public.viread_ocr_training_runs" in sql:
                    self.events.append("load-run")
                    return run
                if "FROM public.viread_ocr_training_jobs WHERE id=:id FOR UPDATE" in sql:
                    self.events.append("lock-job")
                    return job
                if "FROM public.viread_ocr_training_runs WHERE id=:run_id FOR UPDATE" in sql:
                    self.events.append("lock-run")
                    return latest_run
                raise AssertionError(f"Unexpected query: {sql}")

            async def all(self, _sql, _params=None):
                self.events.append("load-chunks")
                return chunks

            async def execute(self, _sql, _params=None):
                self.events.append("write")

            async def commit(self):
                self.events.append("commit")

            async def rollback(self):
                self.events.append("rollback")

        repo = FakeRepo()
        service = VireadOcrTrainingService(SimpleNamespace())
        service.repo = repo
        service._admin = AsyncMock()

        def stream_hash(path, aggregate):
            index = int(path.rsplit("/", 1)[1][:4])
            body = shard_bodies[index]
            self.assertIn("commit", repo.events)
            self.assertNotIn("lock-job", repo.events)
            aggregate.update(body)
            return hashlib.sha256(body).hexdigest(), len(body)

        payload = TrainingRunComplete(
            **identity,
            checkpoint_sha256=hashlib.sha256(checkpoint).hexdigest(),
            checkpoint_bytes=len(checkpoint),
            step=5000,
        )
        with (
            patch.object(viread_ocr_training_service, "hash_storage_object", side_effect=stream_hash),
            patch.object(viread_ocr_training_service, "ensure_storage_capacity", new=AsyncMock(return_value={})),
            patch.object(viread_ocr_training_service, "upload_object") as upload,
        ):
            result = asyncio.run(service.complete_run(
                actor_id, run_id, payload, job_id=job_id, worker_id="worker-test",
            ))

        self.assertEqual(result["status"], "CANDIDATE")
        self.assertEqual(result["checkpoint_bytes"], len(checkpoint))
        self.assertEqual(result["chunk_count"], 2)
        self.assertEqual(upload.call_args.args[0], f"ocr-training/checkpoints/{run_id}/checkpoint.manifest.json")
        self.assertLess(repo.events.index("commit"), repo.events.index("lock-job"))
        self.assertIn("lock-run", repo.events)


if __name__ == "__main__":
    unittest.main()
