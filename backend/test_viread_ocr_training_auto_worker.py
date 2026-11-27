from __future__ import annotations

import sys
import tempfile
import unittest
import os
import hashlib
import json
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[1]
if str(REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(REPO_ROOT))
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch
from uuid import uuid4

from app.jobs.viread_ocr_training_auto_worker import (
    _available_ram_bytes_linux,
    _expire_exhausted_jobs,
    _schedule_ready_flow1,
    _schedule_ready_flow2_detailed,
    _training_config,
    colab_failure_action,
    dataset_snapshot_count_matches,
    flow1_dataset_readiness,
    local_training_capacity,
    trigger_flow2_schedule_once,
)
from sqlalchemy import text


class TrainingCapacityTests(unittest.TestCase):
    def test_training_config_pins_colab_runtime_dependencies(self):
        config, config_sha256 = _training_config("FLOW2_ADMIN_VERIFIED", REPO_ROOT)
        expected = hashlib.sha256(
            (REPO_ROOT / "ai" / "vietocr_v2" / "requirements-colab.txt").read_bytes()
        ).hexdigest()
        self.assertEqual(config["colab_requirements_sha256"], expected)
        self.assertEqual(len(config_sha256), 64)

    def test_cpu_only_torch_routes_away_from_local_training(self):
        torch_stub = SimpleNamespace(
            __version__="test-cpu",
            version=SimpleNamespace(cuda=None),
            cuda=SimpleNamespace(is_available=lambda: False),
        )
        with patch.dict(os.environ, {"VIREAD_LOCAL_TRAINING_ENABLED": "true"}), \
             patch.dict(sys.modules, {"torch": torch_stub}):
            ready, details = local_training_capacity()
        self.assertFalse(ready)
        self.assertEqual(details["reason"], "CUDA_UNAVAILABLE")

    def test_flow1_readiness_preserves_real_and_trdg_sample_thresholds_and_splits(self):
        valid = {
            "FLOW2_EXTERNAL": 500, "FLOW2_TRDG": 20_000,
            "FLOW2_EXTERNAL_train": 350, "FLOW2_EXTERNAL_validation": 75,
            "FLOW2_TRDG_train": 14_000, "FLOW2_TRDG_validation": 3_000,
        }
        self.assertEqual(flow1_dataset_readiness(valid), (True, None))
        too_few_real = {**valid, "FLOW2_EXTERNAL": 499}
        self.assertEqual(flow1_dataset_readiness(too_few_real), (False, "FLOW2_EXTERNAL_BELOW_MINIMUM"))
        missing_validation = {**valid, "FLOW2_TRDG_validation": 0}
        self.assertEqual(flow1_dataset_readiness(missing_validation),
                         (False, "FLOW2_TRDG_TRAIN_AND_VALIDATION_REQUIRED"))

    def test_local_training_can_be_disabled_without_importing_torch(self):
        with patch.dict(os.environ, {"VIREAD_LOCAL_TRAINING_ENABLED": "false"}):
            ready, details = local_training_capacity()
        self.assertFalse(ready)
        self.assertEqual(details["reason"], "LOCAL_TRAINING_DISABLED")

    def test_colab_failure_retries_only_before_a_run_has_partial_state(self):
        self.assertEqual(colab_failure_action(1, None),
                         ("WAITING_FOR_COLAB_WORKER", "COLAB_EXECUTION_FAILED"))
        self.assertEqual(colab_failure_action(3, None), ("FAILED", "COLAB_EXECUTION_RETRY_LIMIT"))
        self.assertEqual(colab_failure_action(1, "run-id"),
                         ("BLOCKED", "COLAB_RETRY_REQUIRES_RUN_RECOVERY"))

    def test_paid_colab_dispatch_requires_manifest_sample_count_to_match_materialized_rows(self):
        self.assertTrue(dataset_snapshot_count_matches(19, 19))
        self.assertFalse(dataset_snapshot_count_matches(19, 27))
        self.assertFalse(dataset_snapshot_count_matches(19, None))

    def test_colab_worker_rejects_runtime_without_a_real_cuda_gpu(self):
        from ai.vietocr_v2.colab_worker import ColabWorker

        torch_stub = SimpleNamespace(
            __version__="test-cpu",
            version=SimpleNamespace(cuda=None),
            cuda=SimpleNamespace(is_available=lambda: False),
        )
        with patch.dict(sys.modules, {"torch": torch_stub}):
            with self.assertRaisesRegex(RuntimeError, "COLAB_CUDA_UNAVAILABLE"):
                ColabWorker.assert_runtime_capacity(Path(tempfile.gettempdir()))

    def test_colab_capacity_probe_requires_vram_ram_and_disk(self):
        from ai.vietocr_v2.colab_worker import ColabWorker

        cuda = SimpleNamespace(
            is_available=lambda: True,
            mem_get_info=lambda _index: (8 * 1024**3, 16 * 1024**3),
            get_device_name=lambda _index: "Test GPU",
        )
        torch_stub = SimpleNamespace(
            __version__="test-cuda",
            version=SimpleNamespace(cuda="test"),
            cuda=cuda,
        )
        with (
            tempfile.TemporaryDirectory() as temp_dir,
            patch.dict(sys.modules, {"torch": torch_stub}),
            patch.object(ColabWorker, "available_ram_bytes", return_value=16 * 1024**3),
            patch("shutil.disk_usage", return_value=SimpleNamespace(free=20 * 1024**3)),
        ):
            result = ColabWorker.assert_runtime_capacity(Path(temp_dir))
        self.assertEqual(result["device"], "Test GPU")
        self.assertGreaterEqual(result["vram_free_bytes"], 6 * 1024**3)

    def test_colab_capacity_probe_blocks_insufficient_ram_and_disk(self):
        from ai.vietocr_v2.colab_worker import ColabWorker

        cuda = SimpleNamespace(
            is_available=lambda: True,
            mem_get_info=lambda _index: (8 * 1024**3, 16 * 1024**3),
        )
        torch_stub = SimpleNamespace(
            __version__="test-cuda", version=SimpleNamespace(cuda="test"), cuda=cuda,
        )
        with (
            tempfile.TemporaryDirectory() as temp_dir,
            patch.dict(sys.modules, {"torch": torch_stub}),
            patch.object(ColabWorker, "available_ram_bytes", return_value=2 * 1024**3),
        ):
            with self.assertRaisesRegex(RuntimeError, "COLAB_INSUFFICIENT_RAM"):
                ColabWorker.assert_runtime_capacity(Path(temp_dir))
        with (
            tempfile.TemporaryDirectory() as temp_dir,
            patch.dict(sys.modules, {"torch": torch_stub}),
            patch.object(ColabWorker, "available_ram_bytes", return_value=16 * 1024**3),
            patch("shutil.disk_usage", return_value=SimpleNamespace(free=2 * 1024**3)),
        ):
            with self.assertRaisesRegex(RuntimeError, "COLAB_INSUFFICIENT_DISK"):
                ColabWorker.assert_runtime_capacity(Path(temp_dir))


class _RecordingSession:
    def __init__(self):
        self.calls = []
        self.committed = False

    async def __aenter__(self):
        return self

    async def __aexit__(self, *_args):
        return None

    async def execute(self, statement, params=None):
        self.calls.append((str(statement), params or {}))

    async def commit(self):
        self.committed = True


class TrainingReconciliationTests(unittest.IsolatedAsyncioTestCase):
    async def test_reconciliation_metadata_json_does_not_create_an_unbound_sql_parameter(self):
        from app.jobs import viread_ocr_training_auto_worker as worker

        session = _RecordingSession()
        with patch.object(worker, "AsyncSessionLocal", return_value=session):
            await _expire_exhausted_jobs()

        self.assertTrue(session.committed)
        self.assertEqual(len(session.calls), 3)
        for statement, params in session.calls:
            self.assertEqual(set(text(statement)._bindparams), set(params))
        reconciliation_params = session.calls[0][1]
        self.assertTrue(json.loads(reconciliation_params["reconciliation_metadata"])[
            "manual_colab_failure_reconciled"
        ])
        exhausted_update = session.calls[2][0]
        self.assertIn("evaluation_status", exhausted_update)
        self.assertIn("BENCHMARK_ONLY", exhausted_update)
        self.assertIn("lease_expires_at IS NULL", session.calls[1][0])
        self.assertIn("lease_expires_at IS NULL", exhausted_update)

    async def test_run_maintenance_once_can_defer_heartbeat_persistence_to_cron_batch(self):
        from unittest.mock import AsyncMock
        from app.jobs import viread_ocr_training_auto_worker as worker

        with (
            patch.object(worker, "_expire_exhausted_jobs", new=AsyncMock()) as expire_mock,
            patch.object(
                worker, "_dispatch_or_poll_colab_once", new=AsyncMock(return_value=False)
            ) as colab_mock,
            patch.object(
                worker, "persist_worker_heartbeat_with_factory", new=AsyncMock()
            ) as persist_mock,
        ):
            res = await worker.run_maintenance_once(persist_heartbeat=False)

        self.assertEqual(res, {"ok": True, "colab_activity": False})
        expire_mock.assert_awaited_once()
        colab_mock.assert_awaited_once()
        persist_mock.assert_not_awaited()

    def test_available_ram_bytes_linux_uses_memavailable_and_subtracts_cgroup_reclaimable_cache(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            meminfo = root / "meminfo"
            meminfo.write_text(
                "MemTotal:       16777216 kB\n"
                "MemFree:          524288 kB\n"
                "MemAvailable:   12582912 kB\n",
                encoding="ascii",
            )
            cg_v2 = root / "cg_v2"
            cg_v2.mkdir()
            # 12 GiB limit, 10 GiB current, 6 GiB inactive_file + 1 GiB slab_reclaimable -> 3 GiB used -> 9 GiB avail
            gib = 1024**3
            (cg_v2 / "memory.max").write_text(str(12 * gib), encoding="ascii")
            (cg_v2 / "memory.current").write_text(str(10 * gib), encoding="ascii")
            (cg_v2 / "memory.stat").write_text(
                f"anon {3 * gib}\ninactive_file {6 * gib}\nslab_reclaimable {1 * gib}\n",
                encoding="ascii",
            )
            avail_v2 = _available_ram_bytes_linux(meminfo_path=meminfo, cgroup_root=cg_v2)
            self.assertEqual(avail_v2, 9 * gib)

            # Cgroup v1 fallback subtracting total_inactive_file
            cg_v1 = root / "cg_v1"
            (cg_v1 / "memory").mkdir(parents=True)
            (cg_v1 / "memory" / "memory.limit_in_bytes").write_text(str(12 * gib), encoding="ascii")
            (cg_v1 / "memory" / "memory.usage_in_bytes").write_text(str(9 * gib), encoding="ascii")
            (cg_v1 / "memory" / "memory.stat").write_text(
                f"total_inactive_file {4 * gib}\n",
                encoding="ascii",
            )
            avail_v1 = _available_ram_bytes_linux(meminfo_path=meminfo, cgroup_root=cg_v1)
            self.assertEqual(avail_v1, 7 * gib)

    async def test_trigger_flow2_schedule_once_ensures_locked_test_first_and_passes_it(self):
        from app.jobs import viread_ocr_training_auto_worker as worker

        actor_id = uuid4()
        locked_ready = {
            "status": "READY",
            "version_id": str(uuid4()),
            "manifest_sha256": "a" * 64,
        }
        order: list[str] = []

        async def _fake_ensure(actor_id=None):
            order.append(f"ensure:{actor_id}")
            return locked_ready

        async def _fake_schedule(locked_test=None, *, actor_id=None):
            order.append(f"schedule:{locked_test == locked_ready}:{actor_id}")
            return {"scheduled": 1, "reason": "JOB_ENQUEUED"}

        with (
            patch.object(worker, "_expire_exhausted_jobs", new=AsyncMock()),
            patch.object(worker, "_ensure_automatic_locked_test", side_effect=_fake_ensure),
            patch.object(worker, "_schedule_ready_flow2_detailed", side_effect=_fake_schedule),
        ):
            res = await trigger_flow2_schedule_once(actor_id=actor_id)

        self.assertTrue(res["locked_test_ready"])
        self.assertEqual(order, [f"ensure:{actor_id}", f"schedule:True:{actor_id}"])

    async def test_schedule_ready_flow2_pins_ready_unconsumed_locked_test_and_falls_back_when_consumed(self):
        from app.jobs import viread_ocr_training_auto_worker as worker

        actor_id = uuid4()
        dataset_id = uuid4()
        locked_id = str(uuid4())
        locked_sha = "f" * 64
        new_job_id = uuid4()

        class _Mappings:
            def __init__(self, row):
                self._row = row

            def one(self):
                return self._row

            def first(self):
                return self._row

        class _Result:
            def __init__(self, scalar=None, row=None):
                self._scalar = scalar
                self._row = row

            def scalar_one(self):
                return self._scalar

            def scalar_one_or_none(self):
                return self._scalar

            def mappings(self):
                return _Mappings(self._row)

        def _make_session(locked_test_unconsumed: bool):
            calls = []

            class _SchedSession:
                async def __aenter__(self):
                    return self

                async def __aexit__(self, *_a):
                    return None

                async def execute(self, stmt, params=None):
                    sql = str(stmt)
                    calls.append((sql, params or {}))
                    if "pg_advisory_xact_lock" in sql:
                        return _Result()
                    if "SELECT EXISTS" in sql:
                        return _Result(scalar=False)
                    if "FILTER (WHERE split='train')" in sql:
                        return _Result(row={"train_count": 40, "validation_count": 10})
                    if "FROM public.viread_ocr_active_model" in sql:
                        return _Result(scalar="b" * 64)
                    if "FROM public.viread_ocr_dataset_versions locked" in sql:
                        return _Result(scalar=locked_id if locked_test_unconsumed else None)
                    if "SELECT generation, metadata->>'candidate_disposition'" in sql:
                        return _Result(row=None)
                    if "INSERT INTO public.viread_ocr_training_jobs" in sql:
                        return _Result(scalar=new_job_id)
                    return _Result()

                async def commit(self):
                    return None

            return _SchedSession(), calls

        ready_locked = {"status": "READY", "version_id": locked_id, "manifest_sha256": locked_sha}
        fake_svc = SimpleNamespace(
            admin_verified_manifest=AsyncMock(
                return_value={"dataset_version_id": dataset_id, "manifest_sha256": "c" * 64}
            )
        )

        # Case 1: unconsumed READY locked test -> pinned!
        sess1, calls1 = _make_session(locked_test_unconsumed=True)
        with (
            patch.object(worker, "AsyncSessionLocal", return_value=sess1),
            patch.object(worker, "VireadOcrTrainingService", return_value=fake_svc),
            patch.object(worker, "local_training_capacity", return_value=(False, {"reason": "LOCAL_TRAINING_DISABLED"})),
        ):
            res1 = await _schedule_ready_flow2_detailed(ready_locked, actor_id=actor_id)
        self.assertEqual(res1["scheduled"], 1)
        self.assertEqual(res1["locked_test_version_id"], locked_id)
        self.assertEqual(res1["locked_test_manifest_sha256"], locked_sha)
        self.assertEqual(res1["evaluation_status"], "LOCKED_TEST_PINNED")
        prior_sql, prior_params = next((s, p) for s, p in calls1 if "SELECT generation" in s)
        self.assertIn("locked_test_version_id IS NOT DISTINCT FROM CAST(:locked_test_id AS uuid)", prior_sql)
        self.assertEqual(prior_params["locked_test_id"], locked_id)
        ins_sql, ins_params = next((s, p) for s, p in calls1 if "INSERT INTO public.viread_ocr_training_jobs" in s)
        self.assertEqual(ins_params["locked_test_id"], locked_id)
        self.assertEqual(ins_params["locked_test_sha"], locked_sha)
        self.assertEqual(json.loads(ins_params["metadata"])["evaluation_status"], "LOCKED_TEST_PINNED")

        # Case 2: already consumed locked test -> falls back to NULL + WAITING_FOR_HOLDOUT
        sess2, calls2 = _make_session(locked_test_unconsumed=False)
        with (
            patch.object(worker, "AsyncSessionLocal", return_value=sess2),
            patch.object(worker, "VireadOcrTrainingService", return_value=fake_svc),
            patch.object(worker, "local_training_capacity", return_value=(False, {"reason": "LOCAL_TRAINING_DISABLED"})),
        ):
            res2 = await _schedule_ready_flow2_detailed(ready_locked, actor_id=actor_id)
        self.assertEqual(res2["scheduled"], 1)
        self.assertIsNone(res2["locked_test_version_id"])
        self.assertEqual(res2["evaluation_status"], "WAITING_FOR_HOLDOUT")
        _, ins_params2 = next((s, p) for s, p in calls2 if "INSERT INTO public.viread_ocr_training_jobs" in s)
        self.assertIsNone(ins_params2["locked_test_id"])
        self.assertIsNone(ins_params2["locked_test_sha"])
        self.assertEqual(json.loads(ins_params2["metadata"])["evaluation_status"], "WAITING_FOR_HOLDOUT")

    async def test_schedule_ready_flow1_pins_ready_unconsumed_locked_test(self):
        from app.jobs import viread_ocr_training_auto_worker as worker

        dataset_id = uuid4()
        actor_id = uuid4()
        locked_id = str(uuid4())
        locked_sha = "e" * 64
        new_job_id = uuid4()
        calls = []

        class _Mappings:
            def __init__(self, rows=None, row=None):
                self._rows = rows or []
                self._row = row

            def all(self):
                return self._rows

            def first(self):
                return self._row

        class _Result:
            def __init__(self, scalar=None, rows=None, row=None):
                self._scalar = scalar
                self._rows = rows
                self._row = row

            def scalar_one(self):
                return self._scalar

            def scalar_one_or_none(self):
                return self._scalar

            def mappings(self):
                return _Mappings(rows=self._rows, row=self._row)

        class _Flow1Session:
            async def __aenter__(self):
                return self

            async def __aexit__(self, *_a):
                return None

            async def execute(self, stmt, params=None):
                sql = str(stmt)
                calls.append((sql, params or {}))
                if "SELECT EXISTS" in sql:
                    return _Result(scalar=False)
                if "external_count" in sql:
                    return _Result(rows=[{
                        "dataset_version_id": dataset_id,
                        "version_sha256": "d" * 64,
                        "created_by": actor_id,
                        "external_count": 500,
                        "trdg_count": 20_000,
                        "external_train": 400,
                        "external_validation": 100,
                        "trdg_train": 16_000,
                        "trdg_validation": 4_000,
                    }])
                if "FROM public.viread_ocr_active_model" in sql:
                    return _Result(scalar="b" * 64)
                if "FROM public.viread_ocr_dataset_versions locked" in sql:
                    return _Result(scalar=locked_id)
                if "SELECT generation" in sql:
                    return _Result(row=None)
                if "INSERT INTO public.viread_ocr_training_jobs" in sql:
                    return _Result(scalar=new_job_id)
                return _Result()

            async def commit(self):
                return None

        ready_locked = {"status": "READY", "version_id": locked_id, "manifest_sha256": locked_sha}
        with (
            patch.object(worker, "AsyncSessionLocal", return_value=_Flow1Session()),
            patch.object(worker, "local_training_capacity", return_value=(False, {"reason": "LOCAL_TRAINING_DISABLED"})),
        ):
            scheduled = await _schedule_ready_flow1(ready_locked)

        self.assertEqual(scheduled, 1)
        prior_sql, prior_params = next((s, p) for s, p in calls if "SELECT generation" in s)
        self.assertIn("locked_test_version_id IS NOT DISTINCT FROM CAST(:locked_test_id AS uuid)", prior_sql)
        self.assertEqual(prior_params["locked_test_id"], locked_id)
        _, ins_params = next((s, p) for s, p in calls if "INSERT INTO public.viread_ocr_training_jobs" in s)
        self.assertEqual(ins_params["locked_test_id"], locked_id)
        self.assertEqual(ins_params["locked_test_sha"], locked_sha)
        self.assertEqual(json.loads(ins_params["metadata"])["evaluation_status"], "LOCKED_TEST_PINNED")


if __name__ == "__main__":
    unittest.main()
