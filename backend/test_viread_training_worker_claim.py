from __future__ import annotations

import os
import unittest

os.environ.setdefault("DATABASE_URL", "postgresql+asyncpg://test:test@127.0.0.1:1/test")
os.environ.setdefault("SUPABASE_URL", "https://example.supabase.co")
os.environ.setdefault("SUPABASE_KEY", "isolated-test-key")

from app.api.routes.admin_viread_training import claim_viread_colab_training_job
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
    def __init__(self):
        self.statement = None
        self.params = None
        self.committed = False

    async def execute(self, statement, params):
        self.statement = str(statement)
        self.params = params
        return _EmptyResult()

    async def commit(self):
        self.committed = True


class TrainingWorkerClaimTests(unittest.IsolatedAsyncioTestCase):
    async def test_claim_without_requested_job_uses_explicit_uuid_cast(self):
        db = _RecordingSession()

        response = await claim_viread_colab_training_job(
            payload=TrainingWorkerClaim(worker_id="colab-test-worker"),
            _worker=None,
            db=db,
        )

        self.assertEqual(response, {"job": None})
        self.assertIsNone(db.params["requested_job_id"])
        self.assertIn("CAST(:requested_job_id AS uuid) IS NULL", db.statement)
        self.assertIn("id=CAST(:requested_job_id AS uuid)", db.statement)
        self.assertTrue(db.committed)


if __name__ == "__main__":
    unittest.main()
