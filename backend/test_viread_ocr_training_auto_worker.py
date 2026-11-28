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
                worker,
                "_prune_flow2_drive_artifacts_once",
                new=AsyncMock(return_value={"pruned_runs": 0, "pruned_resume_jobs": 0}),
            ),
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

    def test_overview_manifest_cache_is_bounded_lru_and_ttl(self):
        from app.services import viread_ocr_training_service as svc_mod

        svc_mod.invalidate_overview_manifest_cache()
        try:
            for idx in range(20):
                svc_mod._set_cached_overview_manifest((f"sha-{idx}", f"path-{idx}"), {"i": idx})
            self.assertLessEqual(
                len(svc_mod._OVERVIEW_MANIFEST_CACHE),
                svc_mod._OVERVIEW_MANIFEST_CACHE_MAXSIZE,
            )
            # Oldest 4 evicted, newest 16 retained
            self.assertIsNone(svc_mod._get_cached_overview_manifest(("sha-0", "path-0")))
            self.assertEqual(
                svc_mod._get_cached_overview_manifest(("sha-19", "path-19")),
                {"i": 19},
            )
        finally:
            svc_mod.invalidate_overview_manifest_cache()

    async def test_prune_flow2_drive_artifacts_once_guards_missing_tables_and_prunes_only_expired(self):
        from datetime import datetime, timedelta, timezone
        from unittest.mock import MagicMock
        from sqlalchemy import text as sa_text
        from app.jobs import viread_ocr_training_auto_worker as worker
        from test_cron_and_worker_heartbeats import _make_sqlite_session_factory

        # 1. Missing tables -> degrades safely to zeros
        empty_engine, empty_factory = _make_sqlite_session_factory()
        try:
            with patch.object(worker, "AsyncSessionLocal", side_effect=empty_factory):
                res_empty = await worker._prune_flow2_drive_artifacts_once()
            self.assertEqual(res_empty, {"pruned_runs": 0, "pruned_resume_jobs": 0})
        finally:
            empty_engine.dispose()

        # 2. Full schema -> protects active, rollback, latest N, unresolved job runs; prunes expired runs & resume jobs
        engine, factory = _make_sqlite_session_factory(
            "CREATE TABLE viread_ocr_drive_connections (connection_key TEXT PRIMARY KEY, status TEXT NOT NULL)",
            "CREATE TABLE viread_ocr_active_model (singleton INTEGER PRIMARY KEY, checkpoint_sha256 TEXT, storage_path TEXT)",
            "CREATE TABLE viread_ocr_model_decisions (id TEXT PRIMARY KEY, action TEXT, previous_checkpoint_sha256 TEXT, previous_storage_path TEXT, candidate_checkpoint_sha256 TEXT, candidate_storage_path TEXT, created_at TIMESTAMP)",
            "CREATE TABLE viread_ocr_training_runs (id TEXT PRIMARY KEY, status TEXT, checkpoint_sha256 TEXT, checkpoint_storage_path TEXT, checkpoint_drive_file_id TEXT, metadata TEXT, created_at TIMESTAMP)",
            "CREATE TABLE viread_ocr_checkpoint_chunks (run_id TEXT, chunk_index INTEGER, storage_path TEXT, PRIMARY KEY (run_id, chunk_index))",
            "CREATE TABLE viread_ocr_training_jobs (id TEXT PRIMARY KEY, status TEXT, run_id TEXT, metadata TEXT, updated_at TIMESTAMP)",
        )
        try:
            now = datetime.now(timezone.utc)
            old_ts = now - timedelta(days=30)
            recent_ts = now - timedelta(days=1)

            with engine.begin() as conn:
                conn.execute(sa_text(
                    "INSERT INTO viread_ocr_drive_connections (connection_key, status) VALUES ('flow2_primary', 'CONNECTED')"
                ))
                conn.execute(sa_text(
                    "INSERT INTO viread_ocr_active_model (singleton, checkpoint_sha256, storage_path) VALUES (1, 'sha_active', 'gdrive://drv_active')"
                ))
                conn.execute(sa_text(
                    "INSERT INTO viread_ocr_model_decisions (id, action, previous_checkpoint_sha256, previous_storage_path, candidate_checkpoint_sha256, candidate_storage_path, created_at) "
                    "VALUES ('dec-1', 'APPROVE', 'sha_rollback', 'gdrive://drv_rollback', 'sha_active', 'gdrive://drv_active', :ts)"
                ), {"ts": recent_ts})

                # Protected runs: active, rollback, 3 latest candidates, 1 unresolved job run
                runs = [
                    ("run-active", "BENCHMARKED", "sha_active", "gdrive://drv_active", "fid_a", "{}", old_ts),
                    ("run-rollback", "BENCHMARKED", "sha_rollback", "gdrive://drv_rollback", "fid_r", "{}", old_ts),
                    ("run-latest-1", "CANDIDATE", "sha_l1", "gdrive://drv_l1", "fid_l1", "{}", recent_ts),
                    ("run-latest-2", "CANDIDATE", "sha_l2", "gdrive://drv_l2", "fid_l2", "{}", recent_ts - timedelta(hours=1)),
                    ("run-latest-3", "CANDIDATE", "sha_l3", "gdrive://drv_l3", "fid_l3", "{}", recent_ts - timedelta(hours=2)),
                    ("run-unresolved", "CANDIDATE", "sha_unres", "gdrive://drv_unres", "fid_u", "{}", old_ts),
                    ("run-expired", "FAILED", "sha_expired", "gdrive://drv_expired_ckpt", "fid_e", "{}", old_ts),
                ]
                for rid, st, sha, spath, fid, meta, cts in runs:
                    conn.execute(sa_text(
                        "INSERT INTO viread_ocr_training_runs (id, status, checkpoint_sha256, checkpoint_storage_path, checkpoint_drive_file_id, metadata, created_at) "
                        "VALUES (:id, :st, :sha, :spath, :fid, :meta, :cts)"
                    ), {"id": rid, "st": st, "sha": sha, "spath": spath, "fid": fid, "meta": meta, "cts": cts})

                conn.execute(sa_text(
                    "INSERT INTO viread_ocr_checkpoint_chunks (run_id, chunk_index, storage_path) VALUES ('run-expired', 0, 'gdrive://drv_expired_chunk0')"
                ))
                conn.execute(sa_text(
                    "INSERT INTO viread_ocr_training_jobs (id, status, run_id, metadata, updated_at) VALUES "
                    "('job-active', 'COLAB_RUNNING', 'run-unresolved', '{}', :old_ts), "
                    "('job-expired', 'FAILED', NULL, '{}', :old_ts)"
                ), {"old_ts": old_ts})

            deleted_refs: list[str] = []
            deleted_resume: list[tuple[str, str]] = []

            fake_store = MagicMock()
            fake_store.list_resume_files.return_value = [{"name": "resume-manifest.json", "drive_file_id": "drv_rm"}]
            fake_store.delete_resume_file.side_effect = lambda jid, name: deleted_resume.append((jid, name)) or True

            fake_router = MagicMock()
            fake_router.google_drive_store = fake_store

            def _fake_delete_if_unreferenced(ref: str, *, is_referenced_check):
                if not is_referenced_check(ref):
                    deleted_refs.append(ref)
                    return True
                return False

            fake_router.delete_if_unreferenced.side_effect = _fake_delete_if_unreferenced
            fake_drive_svc = MagicMock()
            fake_drive_svc.build_artifact_router = AsyncMock(return_value=fake_router)

            with (
                patch.object(worker, "AsyncSessionLocal", side_effect=factory),
                patch.object(worker, "VireadDriveConnectionService", return_value=fake_drive_svc),
            ):
                res = await worker._prune_flow2_drive_artifacts_once(deadline_seconds=5.0)

            self.assertEqual(res, {"pruned_runs": 1, "pruned_resume_jobs": 1})
            self.assertEqual(set(deleted_refs), {"gdrive://drv_expired_ckpt", "gdrive://drv_expired_chunk0"})
            self.assertEqual(deleted_resume, [("job-expired", "resume-manifest.json")])

            with engine.connect() as conn:
                exp_run = conn.execute(sa_text(
                    "SELECT checkpoint_storage_path, metadata FROM viread_ocr_training_runs WHERE id = 'run-expired'"
                )).mappings().one()
                self.assertIsNone(exp_run["checkpoint_storage_path"])
                self.assertTrue(json.loads(exp_run["metadata"])["drive_artifacts_pruned"])
                exp_job = conn.execute(sa_text(
                    "SELECT metadata FROM viread_ocr_training_jobs WHERE id = 'job-expired'"
                )).mappings().one()
                self.assertTrue(json.loads(exp_job["metadata"])["resume_pruned"])
        finally:
            engine.dispose()

    async def test_prune_flow2_drive_artifacts_once_does_not_starve_after_20_old_or_pruned_rows(self):
        from datetime import datetime, timedelta, timezone
        from unittest.mock import MagicMock
        from sqlalchemy import text as sa_text
        from app.jobs import viread_ocr_training_auto_worker as worker
        from test_cron_and_worker_heartbeats import _make_sqlite_session_factory

        engine, factory = _make_sqlite_session_factory(
            "CREATE TABLE viread_ocr_drive_connections (connection_key TEXT PRIMARY KEY, status TEXT NOT NULL)",
            "CREATE TABLE viread_ocr_active_model (singleton INTEGER PRIMARY KEY, checkpoint_sha256 TEXT, storage_path TEXT)",
            "CREATE TABLE viread_ocr_model_decisions (id TEXT PRIMARY KEY, action TEXT, previous_checkpoint_sha256 TEXT, previous_storage_path TEXT, candidate_checkpoint_sha256 TEXT, candidate_storage_path TEXT, created_at TIMESTAMP)",
            "CREATE TABLE viread_ocr_training_runs (id TEXT PRIMARY KEY, status TEXT, checkpoint_sha256 TEXT, checkpoint_storage_path TEXT, checkpoint_drive_file_id TEXT, metadata TEXT, created_at TIMESTAMP)",
            "CREATE TABLE viread_ocr_checkpoint_chunks (run_id TEXT, chunk_index INTEGER, storage_path TEXT, PRIMARY KEY (run_id, chunk_index))",
            "CREATE TABLE viread_ocr_training_jobs (id TEXT PRIMARY KEY, status TEXT, run_id TEXT, metadata TEXT, updated_at TIMESTAMP)",
        )
        try:
            now = datetime.now(timezone.utc)
            very_old_ts = now - timedelta(days=45)
            old_ts = now - timedelta(days=20)
            recent_ts = now - timedelta(days=1)

            with engine.begin() as conn:
                conn.execute(sa_text(
                    "INSERT INTO viread_ocr_drive_connections (connection_key, status) VALUES ('flow2_primary', 'CONNECTED')"
                ))
                conn.execute(sa_text(
                    "INSERT INTO viread_ocr_active_model (singleton, checkpoint_sha256, storage_path) VALUES (1, 'sha_active', 'gdrive://drv_active')"
                ))
                conn.execute(sa_text(
                    "INSERT INTO viread_ocr_model_decisions (id, action, previous_checkpoint_sha256, previous_storage_path, candidate_checkpoint_sha256, candidate_storage_path, created_at) "
                    "VALUES ('dec-1', 'APPROVE', 'sha_rollback', 'gdrive://drv_rollback', 'sha_active', 'gdrive://drv_active', :ts)"
                ), {"ts": recent_ts})

                # 25+ older non-Drive / already-pruned runs + 5 older protected runs ahead of #31 target run
                for idx in range(15):
                    conn.execute(sa_text(
                        "INSERT INTO viread_ocr_training_runs (id, status, checkpoint_sha256, checkpoint_storage_path, checkpoint_drive_file_id, metadata, created_at) "
                        "VALUES (:id, 'FAILED', :sha, :spath, NULL, '{}', :cts)"
                    ), {
                        "id": f"run-local-{idx:02d}",
                        "sha": f"sha_local_{idx:02d}",
                        "spath": None if idx % 2 == 0 else f"supabase://checkpoints/local_{idx:02d}.pth",
                        "cts": very_old_ts + timedelta(minutes=idx),
                    })
                for idx in range(15):
                    meta_json = json.dumps({"drive_artifacts_pruned": True})
                    conn.execute(sa_text(
                        "INSERT INTO viread_ocr_training_runs (id, status, checkpoint_sha256, checkpoint_storage_path, checkpoint_drive_file_id, metadata, created_at) "
                        "VALUES (:id, 'FAILED', :sha, :spath, NULL, :meta, :cts)"
                    ), {
                        "id": f"run-already-pruned-{idx:02d}",
                        "sha": f"sha_pruned_{idx:02d}",
                        "spath": "gdrive://drv_already_marked" if idx == 0 else None,
                        "meta": meta_json,
                        "cts": very_old_ts + timedelta(minutes=20 + idx),
                    })

                protected_runs = [
                    ("run-prot-active", "BENCHMARKED", "sha_active", "gdrive://drv_active", very_old_ts + timedelta(minutes=40)),
                    ("run-prot-rollback", "BENCHMARKED", "sha_rollback", "gdrive://drv_rollback", very_old_ts + timedelta(minutes=41)),
                    ("run-prot-unres-1", "CANDIDATE", "sha_unres_1", "gdrive://drv_unres_1", very_old_ts + timedelta(minutes=42)),
                    ("run-prot-unres-2", "CANDIDATE", "sha_unres_2", "gdrive://drv_unres_2", very_old_ts + timedelta(minutes=43)),
                    ("run-prot-unres-3", "CANDIDATE", "sha_unres_3", "gdrive://drv_unres_3", very_old_ts + timedelta(minutes=44)),
                ]
                for rid, st, sha, spath, cts in protected_runs:
                    conn.execute(sa_text(
                        "INSERT INTO viread_ocr_training_runs (id, status, checkpoint_sha256, checkpoint_storage_path, checkpoint_drive_file_id, metadata, created_at) "
                        "VALUES (:id, :st, :sha, :spath, 'fid_prot', '{}', :cts)"
                    ), {"id": rid, "st": st, "sha": sha, "spath": spath, "cts": cts})

                # Unpruned expired Drive run sitting behind >20 skipped/protected rows
                conn.execute(sa_text(
                    "INSERT INTO viread_ocr_training_runs (id, status, checkpoint_sha256, checkpoint_storage_path, checkpoint_drive_file_id, metadata, created_at) "
                    "VALUES ('run-target-unpruned', 'FAILED', 'sha_target', 'gdrive://drv_target_ckpt', 'fid_target', '{}', :cts)"
                ), {"cts": old_ts})
                conn.execute(sa_text(
                    "INSERT INTO viread_ocr_checkpoint_chunks (run_id, chunk_index, storage_path) "
                    "VALUES ('run-target-unpruned', 0, 'gdrive://drv_target_chunk0')"
                ))

                # Unresolved jobs protecting run-prot-unres-1..3
                for idx in range(1, 4):
                    conn.execute(sa_text(
                        "INSERT INTO viread_ocr_training_jobs (id, status, run_id, metadata, updated_at) "
                        "VALUES (:jid, 'COLAB_RUNNING', :rid, '{}', :uts)"
                    ), {"jid": f"job-unres-{idx}", "rid": f"run-prot-unres-{idx}", "uts": very_old_ts})

                # 25 already-pruned terminal jobs ahead of #26 unpruned expired terminal job
                for idx in range(25):
                    conn.execute(sa_text(
                        "INSERT INTO viread_ocr_training_jobs (id, status, run_id, metadata, updated_at) "
                        "VALUES (:jid, 'FAILED', NULL, :meta, :uts)"
                    ), {
                        "jid": f"job-pruned-{idx:02d}",
                        "meta": json.dumps({"resume_pruned": True}),
                        "uts": very_old_ts + timedelta(minutes=idx),
                    })
                conn.execute(sa_text(
                    "INSERT INTO viread_ocr_training_jobs (id, status, run_id, metadata, updated_at) "
                    "VALUES ('job-target-unpruned', 'FAILED', NULL, '{}', :uts)"
                ), {"uts": old_ts})

            deleted_refs: list[str] = []
            deleted_resume: list[tuple[str, str]] = []

            fake_store = MagicMock()
            fake_store.list_resume_files.return_value = [{"name": "resume-manifest.json", "drive_file_id": "drv_rm"}]
            fake_store.delete_resume_file.side_effect = lambda jid, name: deleted_resume.append((jid, name)) or True

            fake_router = MagicMock()
            fake_router.google_drive_store = fake_store

            def _fake_delete_if_unreferenced(ref: str, *, is_referenced_check):
                if not is_referenced_check(ref):
                    deleted_refs.append(ref)
                    return True
                return False

            fake_router.delete_if_unreferenced.side_effect = _fake_delete_if_unreferenced
            fake_drive_svc = MagicMock()
            fake_drive_svc.build_artifact_router = AsyncMock(return_value=fake_router)

            with (
                patch.object(worker, "AsyncSessionLocal", side_effect=factory),
                patch.object(worker, "VireadDriveConnectionService", return_value=fake_drive_svc),
            ):
                res = await worker._prune_flow2_drive_artifacts_once(deadline_seconds=5.0)

            self.assertEqual(res, {"pruned_runs": 1, "pruned_resume_jobs": 1})
            self.assertEqual(set(deleted_refs), {"gdrive://drv_target_ckpt", "gdrive://drv_target_chunk0"})
            self.assertEqual(deleted_resume, [("job-target-unpruned", "resume-manifest.json")])

            with engine.connect() as conn:
                target_run = conn.execute(sa_text(
                    "SELECT checkpoint_storage_path, metadata FROM viread_ocr_training_runs WHERE id = 'run-target-unpruned'"
                )).mappings().one()
                self.assertIsNone(target_run["checkpoint_storage_path"])
                self.assertTrue(json.loads(target_run["metadata"])["drive_artifacts_pruned"])
                target_job = conn.execute(sa_text(
                    "SELECT metadata FROM viread_ocr_training_jobs WHERE id = 'job-target-unpruned'"
                )).mappings().one()
                self.assertTrue(json.loads(target_job["metadata"])["resume_pruned"])
                for prot_id in ("run-prot-active", "run-prot-rollback", "run-prot-unres-1"):
                    prot_row = conn.execute(sa_text(
                        "SELECT checkpoint_storage_path FROM viread_ocr_training_runs WHERE id = :rid"
                    ), {"rid": prot_id}).mappings().one()
                    self.assertIsNotNone(prot_row["checkpoint_storage_path"])
        finally:
            engine.dispose()

    async def test_prune_flow2_drive_artifacts_once_postgresql_sql_filters_avoid_starvation(self):
        from unittest.mock import MagicMock
        from app.jobs import viread_ocr_training_auto_worker as worker

        executed_queries: list[tuple[str, dict]] = []

        class _PgMappings:
            def __init__(self, rows=None, row=None):
                self._rows = rows or []
                self._row = row

            def all(self):
                return self._rows

            def first(self):
                return self._row

        class _PgResult:
            def __init__(self, rows=None, row=None):
                self._rows = rows
                self._row = row

            def mappings(self):
                return _PgMappings(rows=self._rows, row=self._row)

        class _PgSession:
            bind = SimpleNamespace(dialect=SimpleNamespace(name="postgresql"))

            async def __aenter__(self):
                return self

            async def __aexit__(self, *_a):
                return None

            async def rollback(self):
                return None

            async def commit(self):
                return None

            async def execute(self, stmt, params=None):
                sql = str(stmt)
                executed_queries.append((sql, dict(params or {})))
                if "to_regclass" in sql:
                    return _PgResult(row={f"has_{t}": True for t in worker._FLOW2_PRUNE_REQUIRED_TABLES})
                if "viread_ocr_drive_connections" in sql:
                    return _PgResult(row={"status": "CONNECTED"})
                if "FROM public.viread_ocr_training_jobs" in sql and "run_id IS NOT NULL" in sql:
                    return _PgResult(rows=[{"run_id": "run-prot-1"}])
                if "FROM public.viread_ocr_training_runs r" in sql:
                    return _PgResult(rows=[])
                if "FROM public.viread_ocr_training_jobs" in sql and "resume_pruned" in sql:
                    return _PgResult(rows=[])
                return _PgResult(rows=[])

        with patch.object(worker, "AsyncSessionLocal", return_value=_PgSession()):
            res = await worker._prune_flow2_drive_artifacts_once(deadline_seconds=5.0)

        self.assertEqual(res, {"pruned_runs": 0, "pruned_resume_jobs": 0})
        run_sql, run_params = next(
            (s, p) for s, p in executed_queries if "FROM public.viread_ocr_training_runs r" in s
        )
        self.assertIn("r.checkpoint_storage_path LIKE 'gdrive://%'", run_sql)
        self.assertIn("public.viread_ocr_checkpoint_chunks c", run_sql)
        self.assertIn("COALESCE(r.metadata->>'drive_artifacts_pruned', 'false') NOT IN ('true', '1')", run_sql)
        self.assertIn("CAST(r.id AS TEXT) NOT IN", run_sql)
        self.assertIn("run-prot-1", run_params.values())

        job_sql, _ = next(
            (s, p) for s, p in executed_queries if "FROM public.viread_ocr_training_jobs" in s and "resume_pruned" in s
        )
        self.assertIn("COALESCE(metadata->>'resume_pruned', 'false') NOT IN ('true', '1')", job_sql)

    async def test_prune_flow2_drive_artifacts_once_idle_fast_path_skips_protection_scans(self):
        from datetime import datetime, timedelta, timezone
        from unittest.mock import MagicMock
        from sqlalchemy import text as sa_text
        from app.jobs import viread_ocr_training_auto_worker as worker
        from test_cron_and_worker_heartbeats import _make_sqlite_session_factory

        engine, raw_factory = _make_sqlite_session_factory(
            "CREATE TABLE viread_ocr_drive_connections (connection_key TEXT PRIMARY KEY, status TEXT NOT NULL)",
            "CREATE TABLE viread_ocr_active_model (singleton INTEGER PRIMARY KEY, checkpoint_sha256 TEXT, storage_path TEXT)",
            "CREATE TABLE viread_ocr_model_decisions (id TEXT PRIMARY KEY, action TEXT, previous_checkpoint_sha256 TEXT, previous_storage_path TEXT, candidate_checkpoint_sha256 TEXT, candidate_storage_path TEXT, created_at TIMESTAMP)",
            "CREATE TABLE viread_ocr_training_runs (id TEXT PRIMARY KEY, status TEXT, checkpoint_sha256 TEXT, checkpoint_storage_path TEXT, checkpoint_drive_file_id TEXT, metadata TEXT, created_at TIMESTAMP)",
            "CREATE TABLE viread_ocr_checkpoint_chunks (run_id TEXT, chunk_index INTEGER, storage_path TEXT, PRIMARY KEY (run_id, chunk_index))",
            "CREATE TABLE viread_ocr_training_jobs (id TEXT PRIMARY KEY, status TEXT, run_id TEXT, metadata TEXT, updated_at TIMESTAMP)",
        )
        executed_sqls: list[str] = []

        class _CountingSessionWrapper:
            def __init__(self, inner):
                self._inner = inner
                self.bind = getattr(inner, "bind", None)

            async def __aenter__(self):
                await self._inner.__aenter__()
                return self

            async def __aexit__(self, *args):
                return await self._inner.__aexit__(*args)

            async def execute(self, stmt, *args, **kwargs):
                executed_sqls.append(str(stmt))
                return await self._inner.execute(stmt, *args, **kwargs)

            async def rollback(self):
                return await self._inner.rollback()

            async def commit(self):
                return await self._inner.commit()

        def counting_factory():
            return _CountingSessionWrapper(raw_factory())

        try:
            now = datetime.now(timezone.utc)
            recent_ts = now - timedelta(days=1)
            old_ts = now - timedelta(days=20)

            with engine.begin() as conn:
                conn.execute(sa_text(
                    "INSERT INTO viread_ocr_drive_connections (connection_key, status) VALUES ('flow2_primary', 'CONNECTED')"
                ))
                conn.execute(sa_text(
                    "INSERT INTO viread_ocr_training_runs (id, status, checkpoint_sha256, checkpoint_storage_path, checkpoint_drive_file_id, metadata, created_at) "
                    "VALUES ('run-recent', 'CANDIDATE', 'sha_r', 'gdrive://drv_recent', 'fid_r', '{}', :cts)"
                ), {"cts": recent_ts})
                conn.execute(sa_text(
                    "INSERT INTO viread_ocr_training_jobs (id, status, run_id, metadata, updated_at) "
                    "VALUES ('job-recent', 'FAILED', NULL, '{}', :uts)"
                ), {"uts": recent_ts})

            # 1. Idle DB: 1 storage-detection query + 1 combined preflight SELECT (skips all protection scans)
            with patch.object(worker, "AsyncSessionLocal", side_effect=counting_factory):
                res_idle = await worker._prune_flow2_drive_artifacts_once(deadline_seconds=5.0)

            self.assertEqual(res_idle, {"pruned_runs": 0, "pruned_resume_jobs": 0})
            self.assertEqual(len(executed_sqls), 2, f"Expected 2 queries on idle DB, got {executed_sqls}")
            joined_idle = "\n".join(executed_sqls)
            self.assertNotIn("FROM viread_ocr_active_model", joined_idle)
            self.assertNotIn("FROM viread_ocr_model_decisions", joined_idle)

            # 2. Only expired terminal job (no expired runs) -> skips all 6 run-protection/chunk scans
            with engine.begin() as conn:
                conn.execute(sa_text(
                    "INSERT INTO viread_ocr_training_jobs (id, status, run_id, metadata, updated_at) "
                    "VALUES ('job-expired-only', 'FAILED', NULL, '{}', :uts)"
                ), {"uts": old_ts})

            executed_sqls.clear()
            deleted_resume: list[tuple[str, str]] = []
            fake_store = MagicMock()
            fake_store.list_resume_files.return_value = [{"name": "resume-manifest.json", "drive_file_id": "drv_rm"}]
            fake_store.delete_resume_file.side_effect = lambda jid, name: deleted_resume.append((jid, name)) or True
            fake_router = MagicMock()
            fake_router.google_drive_store = fake_store
            fake_drive_svc = MagicMock()
            fake_drive_svc.build_artifact_router = AsyncMock(return_value=fake_router)

            with (
                patch.object(worker, "AsyncSessionLocal", side_effect=counting_factory),
                patch.object(worker, "VireadDriveConnectionService", return_value=fake_drive_svc),
            ):
                res_jobs_only = await worker._prune_flow2_drive_artifacts_once(deadline_seconds=5.0)

            self.assertEqual(res_jobs_only, {"pruned_runs": 0, "pruned_resume_jobs": 1})
            self.assertEqual(deleted_resume, [("job-expired-only", "resume-manifest.json")])
            joined_jobs_only = "\n".join(executed_sqls)
            self.assertNotIn("FROM viread_ocr_active_model", joined_jobs_only)
            self.assertNotIn("FROM viread_ocr_model_decisions", joined_jobs_only)
        finally:
            engine.dispose()

    async def test_run_maintenance_once_absorbs_prune_timeout_and_still_succeeds(self):
        from app.jobs import viread_ocr_training_auto_worker as worker
        from app.services.worker_telemetry import clear_worker_telemetry, get_worker_telemetry

        clear_worker_telemetry()
        try:
            with (
                patch.object(worker, "_expire_exhausted_jobs", new=AsyncMock()),
                patch.object(worker, "_dispatch_or_poll_colab_once", new=AsyncMock(return_value=False)),
                patch.object(
                    worker,
                    "_prune_flow2_drive_artifacts_once",
                    new=AsyncMock(side_effect=TimeoutError("simulated prune timeout")),
                ),
            ):
                res = await worker.run_maintenance_once(persist_heartbeat=False)

            self.assertEqual(res, {"ok": True, "colab_activity": False})
            telemetry = get_worker_telemetry("viread_ocr_training")
            self.assertIsNone(telemetry.get("last_error"))
            self.assertIsNotNone(telemetry.get("last_success_at"))
        finally:
            clear_worker_telemetry()


if __name__ == "__main__":
    unittest.main()
