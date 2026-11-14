from __future__ import annotations

import os
import unittest
from unittest.mock import AsyncMock, patch

from fastapi import HTTPException

os.environ.setdefault("DATABASE_URL", "postgresql+asyncpg://test:test@127.0.0.1:1/test")
os.environ.setdefault("SUPABASE_URL", "https://example.supabase.co")
os.environ.setdefault("SUPABASE_KEY", "isolated-test-key")

from app.api.routes.admin_viread_training import (
    _colab_worker_failure_state,
    claim_viread_colab_training_job,
    retry_failed_viread_colab_training_job,
)
from app.schemas.viread_ocr_training import TrainingWorkerClaim


class _EmptyMappings:
    @staticmethod
    def first():
        return None


class _EmptyResult:
    @staticmethod
    def mappings():
        return _EmptyMappings()


class _RecordingSession:
    def __init__(self, results=None):
        self.statement = []
        self.params = []
        self.results = list(results or [])
        self.committed = False
        self.rolled_back = False

    async def execute(self, statement, params=None):
        self.statement.append(str(statement))
        self.params.append(params or {})
        return self.results.pop(0) if self.results else _EmptyResult()

    async def commit(self):
        self.committed = True

    async def rollback(self):
        self.rolled_back = True


class _RowResult:
    def __init__(self, row):
        self.row = row

    class _Mappings:
        def __init__(self, row):
            self.row = row

        def first(self):
            return self.row

    def mappings(self):
        return self._Mappings(self.row)


class _ScalarResult:
    def __init__(self, value):
        self.value = value

    def scalar_one_or_none(self):
        return self.value


class TrainingWorkerClaimTests(unittest.IsolatedAsyncioTestCase):
    def test_manual_colab_failure_before_training_is_terminal(self):
        status, error = _colab_worker_failure_state({
            "run_id": None,
            "colab_execution_id": None,
            "colab_execution_resource_name": None,
            "colab_operation_name": None,
        }, None)

        self.assertEqual((status, error), ("FAILED", "COLAB_WORKER_FAILED"))

    def test_enterprise_execution_remains_tracked_after_worker_failure(self):
        status, error = _colab_worker_failure_state({
            "run_id": None,
            "colab_execution_id": "execution-1",
            "colab_execution_resource_name": None,
            "colab_operation_name": None,
        }, None)

        self.assertEqual((status, error), ("COLAB_EXECUTING", "COLAB_WORKER_FAILED"))

    def test_partial_run_failure_is_blocked_for_explicit_recovery(self):
        status, error = _colab_worker_failure_state({
            "run_id": "run-1",
            "colab_execution_id": None,
            "colab_execution_resource_name": None,
            "colab_operation_name": None,
        }, None)

        self.assertEqual((status, error), ("BLOCKED", "COLAB_FAILURE_REQUIRES_RUN_RECOVERY"))

    async def test_claim_without_requested_job_uses_explicit_uuid_cast(self):
        db = _RecordingSession()

        response = await claim_viread_colab_training_job(
            payload=TrainingWorkerClaim(worker_id="colab-test-worker"),
            _worker=None,
            db=db,
        )

        self.assertEqual(response, {"job": None})
        self.assertIsNone(db.params[0]["requested_job_id"])
        self.assertIn("CAST(:requested_job_id AS uuid) IS NULL", db.statement[0])
        self.assertIn("id=CAST(:requested_job_id AS uuid)", db.statement[0])
        self.assertTrue(db.committed)

    async def test_retry_requeues_failed_colab_job_without_a_run(self):
        job_id = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
        actor_id = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"
        parent_sha = "c" * 64
        row = {
            "target": "COLAB", "status": "FAILED", "run_id": None, "attempts": 1,
            "parent_checkpoint_sha256": parent_sha, "colab_execution_id": None,
            "colab_execution_resource_name": None, "colab_operation_name": None,
            "last_error_code": "VALUEERROR",
        }
        db = _RecordingSession([
            _RowResult(row), _ScalarResult(parent_sha), _ScalarResult(None), _EmptyResult(),
        ])

        with patch("app.api.routes.admin_viread_training.VireadOcrTrainingService._admin", new_callable=AsyncMock):
            response = await retry_failed_viread_colab_training_job(
                job_id=job_id, actor_id=actor_id, db=db,
            )

        self.assertEqual(response, {
            "job_id": job_id, "status": "WAITING_FOR_COLAB_WORKER",
            "recovery_mode": "pre_run",
        })
        self.assertIn("FOR UPDATE", db.statement[0])
        self.assertIn("status='WAITING_FOR_COLAB_WORKER'", db.statement[3])
        self.assertEqual(db.params[3]["previous_error"], "VALUEERROR")
        self.assertTrue(db.committed)

    async def test_retry_refuses_jobs_that_already_registered_a_run(self):
        job_id = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
        row = {
            "target": "COLAB", "status": "FAILED", "run_id": "run-1", "attempts": 1,
            "parent_checkpoint_sha256": "c" * 64, "colab_execution_id": None,
            "colab_execution_resource_name": None, "colab_operation_name": None,
            "last_error_code": "VALUEERROR",
        }
        db = _RecordingSession([_RowResult(row)])

        with patch("app.api.routes.admin_viread_training.VireadOcrTrainingService._admin", new_callable=AsyncMock):
            with self.assertRaises(HTTPException) as error:
                await retry_failed_viread_colab_training_job(
                    job_id=job_id, actor_id="bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", db=db,
                )

        self.assertEqual(error.exception.status_code, 409)
        self.assertTrue(db.rolled_back)
        self.assertFalse(db.committed)

    async def test_retry_resumes_matching_candidate_for_locked_test_without_retraining(self):
        job_id = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
        actor_id = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"
        run_id = "cccccccc-cccc-4ccc-8ccc-cccccccccccc"
        parent_sha = "c" * 64
        job = {
            "target": "COLAB", "status": "BLOCKED", "run_id": run_id, "attempts": 2,
            "profile": "FLOW2_ADMIN_VERIFIED", "dataset_version_id": "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
            "manifest_sha256": "a" * 64, "config_sha256": "b" * 64,
            "parent_checkpoint_sha256": parent_sha, "created_by": actor_id,
            "colab_execution_id": None, "colab_execution_resource_name": None,
            "colab_operation_name": None, "last_error_code": "HTTPERROR",
        }
        run = {
            "id": run_id, "status": "CANDIDATE", "profile": job["profile"],
            "dataset_version_id": job["dataset_version_id"], "manifest_sha256": job["manifest_sha256"],
            "config_sha256": job["config_sha256"], "parent_checkpoint_sha256": parent_sha,
            "created_by": actor_id, "checkpoint_sha256": "e" * 64,
            "checkpoint_bytes": 1024, "checkpoint_storage_path": "ocr-training/checkpoints/candidate/manifest.json",
        }
        db = _RecordingSession([
            _RowResult(job), _RowResult(run), _ScalarResult(None),
            _ScalarResult(parent_sha), _ScalarResult(None), _EmptyResult(),
        ])

        with patch("app.api.routes.admin_viread_training.VireadOcrTrainingService._admin", new_callable=AsyncMock):
            response = await retry_failed_viread_colab_training_job(
                job_id=job_id, actor_id=actor_id, db=db,
            )

        self.assertEqual(response, {
            "job_id": job_id,
            "status": "WAITING_FOR_COLAB_WORKER",
            "recovery_mode": "candidate_benchmark",
        })
        self.assertIn("viread_ocr_training_runs WHERE id=:run_id FOR UPDATE", db.statement[1])
        self.assertIn("viread_ocr_benchmarks WHERE run_id=:run_id", db.statement[2])
        self.assertIn("retry_mode", db.statement[-1])
        self.assertEqual(db.params[-1]["retry_mode"], "candidate_benchmark_recovery")
        self.assertEqual(db.params[-1]["previous_error"], "HTTPERROR")
        self.assertTrue(db.committed)

    async def test_retry_refuses_candidate_with_mismatched_job_lineage(self):
        job = {
            "target": "COLAB", "status": "BLOCKED", "run_id": "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
            "attempts": 1, "profile": "FLOW2_ADMIN_VERIFIED", "dataset_version_id": "dataset-job",
            "manifest_sha256": "a" * 64, "config_sha256": "b" * 64,
            "parent_checkpoint_sha256": "c" * 64, "created_by": "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
            "colab_execution_id": None, "colab_execution_resource_name": None,
            "colab_operation_name": None, "last_error_code": "HTTPERROR",
        }
        run = {
            "id": job["run_id"], "status": "CANDIDATE", "profile": job["profile"],
            "dataset_version_id": "different-dataset", "manifest_sha256": job["manifest_sha256"],
            "config_sha256": job["config_sha256"], "parent_checkpoint_sha256": job["parent_checkpoint_sha256"],
            "created_by": job["created_by"], "checkpoint_sha256": "e" * 64,
            "checkpoint_bytes": 1024, "checkpoint_storage_path": "ocr-training/checkpoints/candidate/manifest.json",
        }
        db = _RecordingSession([_RowResult(job), _RowResult(run)])

        with patch("app.api.routes.admin_viread_training.VireadOcrTrainingService._admin", new_callable=AsyncMock):
            with self.assertRaises(HTTPException) as error:
                await retry_failed_viread_colab_training_job(
                    job_id="aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
                    actor_id="bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", db=db,
                )

        self.assertEqual(error.exception.status_code, 409)
        self.assertTrue(db.rolled_back)
        self.assertFalse(db.committed)
        self.assertEqual(len(db.statement), 2)


if __name__ == "__main__":
    unittest.main()
