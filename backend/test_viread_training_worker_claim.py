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


if __name__ == "__main__":
    unittest.main()
