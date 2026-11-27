from __future__ import annotations

import hashlib
import json
import math
import os
import random
import time
import unittest
from collections import defaultdict
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock, patch
from uuid import UUID, uuid4

from fastapi import HTTPException
from sqlalchemy.exc import IntegrityError

os.environ.setdefault("DATABASE_URL", "postgresql+asyncpg://test:test@127.0.0.1:1/test")
os.environ.setdefault("SUPABASE_URL", "https://example.supabase.co")
os.environ.setdefault("SUPABASE_KEY", "isolated-test-key")

from app.api.routes import admin_viread_training
from app.schemas.viread_ocr_training import (
    BenchmarkCreate,
    BenchmarkOutput,
    ModelDecisionRequest,
    TrainingWorkerFinish,
)
from app.services.training_storage import StorageProvider, StoredArtifact
from app.services.viread_ocr_training_service import (
    ORIGINAL_SHA256,
    TRAINING_PROFILES,
    VireadOcrTrainingService,
    _canonical,
    _canonicalize_legacy_verified_snapshot,
    _deduplicate_verified_samples,
    _gate,
    _metric_counts,
    _paired_metric,
    _verified_snapshot,
    _verified_snapshot_db_rows,
)


class VireadDualTrainingContracts(unittest.TestCase):
    def test_public_profiles_keep_the_two_training_flows_disjoint(self):
        flow1 = TRAINING_PROFILES["FLOW1_EXTERNAL_TRDG"]
        flow2 = TRAINING_PROFILES["FLOW2_ADMIN_VERIFIED"]

        self.assertEqual(flow1["dataset_flows"], {"FLOW2_EXTERNAL_TRDG"})
        self.assertEqual(flow2["dataset_flows"], {"FLOW1_VERIFIED"})
        self.assertTrue(flow1["dataset_flows"].isdisjoint(flow2["dataset_flows"]))
        self.assertEqual(flow1["minimum_counts"], {"FLOW2_EXTERNAL": 500, "FLOW2_TRDG": 20_000})
        self.assertEqual(flow1["maximum_counts"], {"FLOW2_EXTERNAL": 1_000, "FLOW2_TRDG": 50_000})

    def test_verified_snapshot_deduplicates_identical_crop_and_label(self):
        first = {"sample_id": "first", "image_sha256": "a" * 64, "label": "Tiếng Việt"}
        duplicate = {"sample_id": "second", "image_sha256": "a" * 64, "label": "Tiếng Việt"}

        self.assertEqual(_deduplicate_verified_samples([first, duplicate]), [first])

    def test_verified_snapshot_prefers_validation_copy_to_prevent_split_leakage(self):
        common = {
            "image_storage_path": "ocr-training/flow2/admin-verified/sample.png",
            "label": "Tiếng Việt", "source_revision_id": "revision-1", "provenance": {},
        }
        train = {
            **common, "sample_id": "train-copy", "group_id": "page-train", "split": "train",
            "image_sha256": "a" * 64, "source_page_id": "page-train",
        }
        validation = {
            **common, "sample_id": "validation-copy", "group_id": "page-validation",
            "split": "validation", "image_sha256": "a" * 64,
            "source_page_id": "page-validation",
        }
        unique_train = {
            **common, "sample_id": "unique-train", "group_id": "page-train", "split": "train",
            "image_sha256": "b" * 64, "source_page_id": "page-train",
        }

        manifest, selected = _verified_snapshot([train, validation, unique_train])

        self.assertEqual({item["sample_id"] for item in selected}, {"validation-copy", "unique-train"})
        self.assertEqual({item["split"] for item in manifest["samples"]}, {"train", "validation"})
        self.assertEqual(len({item["image_sha256"] for item in manifest["samples"]}), 2)
        reversed_manifest, reversed_selected = _verified_snapshot([unique_train, validation, train])
        self.assertEqual(reversed_selected, selected)
        self.assertEqual(reversed_manifest, manifest)

    def test_verified_snapshot_preserves_holdout_copy_over_train_and_validation(self):
        base = {
            "image_storage_path": "ocr-training/flow2/admin-verified/sample.png",
            "label": "Tiếng Việt", "image_sha256": "c" * 64,
        }
        rows = [
            {**base, "sample_id": "train-copy", "group_id": "train-page", "split": "train"},
            {**base, "sample_id": "validation-copy", "group_id": "validation-page", "split": "validation"},
            {**base, "sample_id": "holdout-copy", "group_id": "holdout-page", "split": "holdout"},
        ]

        _, selected = _verified_snapshot(rows)

        self.assertEqual([item["sample_id"] for item in selected], ["holdout-copy"])

    def test_verified_snapshot_rejects_same_image_with_conflicting_labels(self):
        first = {"sample_id": "first", "image_sha256": "a" * 64, "label": "Mỹ"}
        conflict = {"sample_id": "second", "image_sha256": "a" * 64, "label": "Mẹ"}

        with self.assertRaises(HTTPException) as raised:
            _deduplicate_verified_samples([first, conflict])

        self.assertEqual(raised.exception.status_code, 409)

    def test_verified_snapshot_manifest_and_rows_use_the_same_deduplicated_sources(self):
        first = {
            "sample_id": "source-1", "group_id": "page-1", "split": "train",
            "image_storage_path": "ocr-training/flow2/admin-verified/one.png",
            "image_sha256": "a" * 64, "label": "Tiếng Việt", "source_page_id": "page-1",
            "source_revision_id": "revision-1", "provenance": {"verified_by_admin": True},
        }
        duplicate = {**first, "sample_id": "source-2"}

        manifest, unique_sources = _verified_snapshot([first, duplicate])
        rows = _verified_snapshot_db_rows("dataset-1", unique_sources)

        self.assertEqual(manifest["schema"], "viread-dataset-v1")
        self.assertEqual(manifest["snapshot_strategy"], "cumulative-deduplicated-v3-split-safe")
        self.assertEqual(len(manifest["samples"]), 1)
        self.assertEqual(len(rows), len(manifest["samples"]))
        self.assertEqual(rows[0]["source_annotation_id"], "source-1")
        self.assertEqual(rows[0]["dataset_id"], "dataset-1")
        self.assertEqual(rows[0]["source_revision_id"], "revision-1")

    def test_legacy_snapshot_is_rebuilt_only_when_duplicate_hashes_exist(self):
        first = {
            "sample_id": "source-1", "group_id": "page-1", "split": "train",
            "image_storage_path": "ocr-training/flow2/admin-verified/one.png",
            "image_sha256": "a" * 64, "label": "Tiếng Việt", "source_page_id": "page-1",
            "source_revision_id": "revision-1", "provenance": {},
        }
        duplicate = {**first, "sample_id": "source-2"}

        needs_rebuild, manifest, canonical = _canonicalize_legacy_verified_snapshot([first, duplicate])

        self.assertTrue(needs_rebuild)
        self.assertEqual(len(canonical), 1)
        self.assertEqual(manifest["samples"][0]["sample_id"], "source-1")

    def test_legacy_snapshot_refuses_duplicate_rows_that_leak_page_across_splits(self):
        first = {
            "sample_id": "source-1", "group_id": "page-1", "split": "train",
            "image_storage_path": "ocr-training/flow2/admin-verified/one.png",
            "image_sha256": "a" * 64, "label": "Tiếng Việt", "source_page_id": "page-1",
            "source_revision_id": "revision-1", "provenance": {},
        }
        conflicting_split = {**first, "sample_id": "source-2", "split": "validation"}

        with self.assertRaises(HTTPException) as raised:
            _canonicalize_legacy_verified_snapshot([first, conflicting_split])

        self.assertEqual(raised.exception.status_code, 409)

    def test_pilot_evaluation_is_advisory_and_never_promotable(self):
        metrics = {"outputs": [{"group_id": f"document-{index % 5}"} for index in range(20)]}

        gate = _gate(metrics, manifest_sha="a" * 64, evaluation_type="PILOT",
                     require_model_baselines=True)

        self.assertEqual(gate["status"], "INSUFFICIENT_EVIDENCE")
        self.assertFalse(gate["promotion_allowed"])
        self.assertEqual(gate["sample_count"], 20)
        self.assertEqual(gate["group_count"], 5)

    def test_production_evaluation_requires_parent_and_active_predictions(self):
        metrics = {"outputs": [{"group_id": f"document-{index % 30}"} for index in range(200)],
                   "cer": {}, "wer": {}}

        gate = _gate(metrics, manifest_sha="b" * 64, evaluation_type="PRODUCTION",
                     require_model_baselines=True)

        self.assertEqual(gate["status"], "EVALUATION_FAILED")
        self.assertFalse(gate["promotion_allowed"])
        self.assertEqual(gate["reason"], "parent_and_active_baselines_required")

    def test_paired_metric_precomputation_matches_reference_bit_for_bit_and_is_fast(self):
        lines = []
        for idx in range(375):
            group = f"book-{idx % 30:02d}"
            # Include typographic punctuation to verify normalize_typographic_for_vietocr parity.
            ref = f"“Xin chào” — bài học số {idx}"
            orig = f'"Xin chao" - bai hoc so {idx}' if idx % 2 == 0 else ref
            cand = f'"Xin chào" - bài học số {idx}'
            lines.append({
                "group_id": group,
                "reference": ref,
                "original": orig,
                "candidate": cand,
            })

        # Reference unoptimized bootstrap on a smaller replicate count for exact bit-for-bit check
        small_lines = lines[:60]
        groups = defaultdict(list)
        for line in small_lines:
            groups[line["group_id"]].append(line)
        names = sorted(groups)
        rng = random.Random(20261112)
        ref_deltas = []
        for _ in range(100):
            selected = [names[rng.randrange(len(names))] for _ in names]
            sampled = [line for name in selected for line in groups[name]]
            base_n, base_units = _metric_counts(sampled, "original", "cer")
            cand_n, _ = _metric_counts(sampled, "candidate", "cer")
            ref_deltas.append(cand_n / base_units - base_n / base_units)
        ref_deltas.sort()
        fast_small = _paired_metric(small_lines, "cer", replicates=100, seed=20261112)
        self.assertEqual(
            fast_small["paired_cluster_bootstrap_95ci"],
            [
                ref_deltas[math.floor(0.025 * (len(ref_deltas) - 1))],
                ref_deltas[math.ceil(0.975 * (len(ref_deltas) - 1))],
            ],
        )
        # Candidate differs only by typographic quotes/dash -> 0 errors after normalization!
        self.assertEqual(fast_small["candidate_error_count"], 0)

        # Full 375 samples x 30 groups x 5000 replicates speed check (<1s)
        t0 = time.perf_counter()
        full = _paired_metric(lines, "cer", replicates=5000, seed=20261112)
        elapsed = time.perf_counter() - t0
        self.assertLess(elapsed, 1.0)
        self.assertEqual(full["cluster_count"], 30)
        self.assertLess(full["paired_cluster_bootstrap_95ci"][1], 0.0)

    def test_paired_metric_handles_zero_unit_group_safely(self):
        lines = [
            {"group_id": "empty-group", "reference": "", "original": "", "candidate": ""},
            {"group_id": "real-group", "reference": "Xin chào", "original": "Xin chao", "candidate": "Xin chào"},
        ]
        result = _paired_metric(lines, "cer", replicates=200, seed=42)
        self.assertGreater(result["reference_unit_count"], 0)
        self.assertEqual(result["candidate_error_count"], 0)

    def test_gate_includes_failing_checks_when_not_v2_win(self):
        outputs = [{"group_id": f"doc-{i % 30}"} for i in range(200)]

        def _m(baseline: str, delta: float, ci: list[float]):
            return {
                f"{baseline}_rate": 0.10,
                "candidate_rate": 0.10 + delta,
                f"delta_candidate_minus_{baseline}": delta,
                f"paired_cluster_bootstrap_95ci_candidate_minus_{baseline}": ci,
            }

        # V2_WIN: no failing_checks
        win_metrics = {
            "outputs": outputs,
            "cer": _m("original", -0.05, [-0.07, -0.03]),
            "wer": _m("original", -0.08, [-0.10, -0.05]),
            "parent_cer": _m("parent", -0.02, [-0.03, -0.01]),
            "parent_wer": _m("parent", -0.03, [-0.05, -0.01]),
            "active_cer": _m("active", -0.02, [-0.03, -0.01]),
            "active_wer": _m("active", -0.03, [-0.05, -0.01]),
        }
        win_gate = _gate(win_metrics, manifest_sha="a" * 64, evaluation_type="PRODUCTION", require_model_baselines=True)
        self.assertEqual(win_gate["status"], "V2_WIN")
        self.assertNotIn("failing_checks", win_gate)

        # NO_SIGNIFICANT_DIFFERENCE: parent_wer straddles 0
        nsd_metrics = {
            **win_metrics,
            "parent_wer": _m("parent", -0.004, [-0.015, 0.007]),
        }
        nsd_gate = _gate(nsd_metrics, manifest_sha="a" * 64, evaluation_type="PRODUCTION", require_model_baselines=True)
        self.assertEqual(nsd_gate["status"], "NO_SIGNIFICANT_DIFFERENCE")
        self.assertEqual(len(nsd_gate["failing_checks"]), 1)
        self.assertEqual(nsd_gate["failing_checks"][0]["baseline"], "parent")
        self.assertEqual(nsd_gate["failing_checks"][0]["metric"], "wer")
        self.assertEqual(nsd_gate["failing_checks"][0]["ci95"], [-0.015, 0.007])

        # ORIGINAL_WIN via non-regression limit
        reg_metrics = {
            **win_metrics,
            "active_cer": _m("active", 0.012, [0.002, 0.022]),
        }
        reg_gate = _gate(reg_metrics, manifest_sha="a" * 64, evaluation_type="PRODUCTION", require_model_baselines=True)
        self.assertEqual(reg_gate["status"], "ORIGINAL_WIN")
        self.assertEqual(reg_gate["reason"], "non_regression_limit_exceeded")
        self.assertEqual(reg_gate["failing_checks"][0]["baseline"], "active")
        self.assertEqual(reg_gate["failing_checks"][0]["metric"], "cer")


class BenchmarkAndDecisionReliabilityTests(unittest.IsolatedAsyncioTestCase):
    def _make_pilot_payload(self, run_id: UUID, locked_id: UUID, locked_sha: str, n: int = 20):
        expected = []
        outputs = []
        for idx in range(n):
            gid = f"doc-{idx % 5}"
            sid = f"sample-{idx}"
            expected.append({"sample_id": sid, "group_id": gid, "reference": f"Tiếng Việt {idx}"})
            outputs.append(BenchmarkOutput(
                sample_id=sid,
                group_id=gid,
                original=f"Tieng Viet {idx}",
                candidate=f"Tiếng Việt {idx}",
                parent=f"Tieng Viet {idx}",
                active=f"Tieng Viet {idx}",
            ))
        payload = BenchmarkCreate(
            run_id=run_id,
            locked_test_version_id=locked_id,
            locked_test_manifest_sha256=locked_sha,
            parent_checkpoint_sha256=ORIGINAL_SHA256,
            active_checkpoint_sha256=ORIGINAL_SHA256,
            outputs=outputs,
        )
        return payload, expected

    async def test_benchmark_three_phase_releases_read_txn_before_compute_and_drive_put(self):
        actor_id = uuid4()
        run_id = uuid4()
        job_id = uuid4()
        locked_id = uuid4()
        cohort_id = uuid4()
        locked_sha = "1" * 64
        cand_sha = "2" * 64
        payload, expected = self._make_pilot_payload(run_id, locked_id, locked_sha, n=20)

        events: list[str] = []
        phase1_for_update_seen = False

        class _FakeRepo:
            async def one(self, sql: str, params=None):
                nonlocal phase1_for_update_seen
                if "FOR UPDATE" in sql and "drive_put" not in events:
                    phase1_for_update_seen = True
                if "FROM public.viread_ocr_training_jobs" in sql:
                    events.append("lock_job")
                    return {
                        "id": job_id, "target": "COLAB", "status": "COLAB_RUNNING",
                        "worker_id": "colab-1", "run_id": run_id, "created_by": actor_id,
                        "locked_test_version_id": locked_id,
                        "locked_test_manifest_sha256": locked_sha, "lease_active": True,
                    }
                if "FROM public.viread_ocr_training_runs" in sql:
                    return {
                        "id": run_id, "status": "CANDIDATE", "profile": "FLOW2_ADMIN_VERIFIED",
                        "parent_checkpoint_sha256": ORIGINAL_SHA256, "checkpoint_sha256": cand_sha,
                    }
                if "FROM public.viread_ocr_dataset_versions" in sql:
                    if "FOR UPDATE" in sql:
                        events.append("lock_dataset")
                    return {
                        "id": locked_id, "source_flow": "LOCKED_TEST",
                        "version_sha256": locked_sha, "is_locked_test": True, "sample_count": 20,
                    }
                if "unique_annotation_count" in sql:
                    return {
                        "sample_count": 20, "unique_annotation_count": 20,
                        "unique_image_count": 20, "group_count": 5, "verified_count": 20,
                    }
                if "FROM public.viread_ocr_evaluation_cohorts" in sql:
                    if "FOR UPDATE" in sql:
                        events.append("lock_cohort")
                    return {
                        "id": cohort_id, "evaluation_type": "PILOT",
                        "manifest_sha256": locked_sha, "sample_count": 20, "group_count": 5,
                    }
                if "FROM public.viread_ocr_benchmarks" in sql:
                    return None
                if "FROM public.viread_ocr_active_model" in sql:
                    return {"checkpoint_sha256": ORIGINAL_SHA256}
                return None

            async def all(self, sql: str, params=None):
                return list(expected)

            async def execute(self, sql: str, params=None):
                if "INSERT INTO public.viread_ocr_benchmarks" in sql:
                    events.append("insert_benchmark")
                elif "UPDATE public.viread_ocr_training_runs" in sql:
                    events.append("update_run")
                elif "UPDATE public.viread_ocr_training_jobs" in sql:
                    events.append("update_job")

            async def commit(self):
                events.append("commit")

            async def rollback(self):
                events.append("rollback")

        class _FakeRouter:
            write_provider = StorageProvider.GOOGLE_DRIVE

            def put(self, logical_path, data, **kwargs):
                events.append("drive_put")
                return StoredArtifact(
                    provider=StorageProvider.GOOGLE_DRIVE,
                    reference="gdrive://bench_file_1",
                    logical_path=logical_path,
                    sha256=hashlib.sha256(data).hexdigest(),
                    size_bytes=len(data),
                    content_type="application/json",
                    drive_file_id="bench_file_1",
                )

        service = VireadOcrTrainingService(SimpleNamespace())
        service.repo = _FakeRepo()
        service._admin = AsyncMock()
        service._artifact_router = AsyncMock(return_value=_FakeRouter())

        with patch("app.services.viread_ocr_training_service.ensure_database_capacity", new=AsyncMock()):
            res = await service.benchmark(actor_id, payload, job_id=job_id, worker_id="colab-1")

        self.assertFalse(phase1_for_update_seen, "Phase 1 must not acquire FOR UPDATE locks")
        self.assertEqual(res["storage_provider"], StorageProvider.GOOGLE_DRIVE.value)
        self.assertLess(events.index("rollback"), events.index("drive_put"))
        self.assertLess(events.index("drive_put"), events.index("lock_job"))
        self.assertLess(events.index("lock_job"), events.index("insert_benchmark"))
        self.assertEqual(events[-4:], ["insert_benchmark", "update_run", "update_job", "commit"])
        self.assertEqual(events.count("commit"), 1)

    async def test_benchmark_maps_bridge_value_error_to_502_not_500(self):
        actor_id = uuid4()
        run_id = uuid4()
        locked_id = uuid4()
        cohort_id = uuid4()
        locked_sha = "1" * 64
        payload, expected = self._make_pilot_payload(run_id, locked_id, locked_sha, n=20)

        class _FakeRepo:
            async def one(self, sql: str, params=None):
                if "FROM public.viread_ocr_training_runs" in sql:
                    return {
                        "id": run_id, "status": "CANDIDATE", "profile": "FLOW2_ADMIN_VERIFIED",
                        "parent_checkpoint_sha256": ORIGINAL_SHA256, "checkpoint_sha256": "2" * 64,
                    }
                if "FROM public.viread_ocr_dataset_versions" in sql:
                    return {
                        "id": locked_id, "source_flow": "LOCKED_TEST",
                        "version_sha256": locked_sha, "is_locked_test": True, "sample_count": 20,
                    }
                if "unique_annotation_count" in sql:
                    return {
                        "sample_count": 20, "unique_annotation_count": 20,
                        "unique_image_count": 20, "group_count": 5, "verified_count": 20,
                    }
                if "FROM public.viread_ocr_evaluation_cohorts" in sql:
                    return {
                        "id": cohort_id, "evaluation_type": "PILOT",
                        "manifest_sha256": locked_sha, "sample_count": 20, "group_count": 5,
                    }
                if "FROM public.viread_ocr_benchmarks" in sql:
                    return None
                if "FROM public.viread_ocr_active_model" in sql:
                    return {"checkpoint_sha256": ORIGINAL_SHA256}
                return None

            async def all(self, sql: str, params=None):
                return list(expected)

            async def rollback(self):
                return None

        class _BrokenBridgeRouter:
            write_provider = StorageProvider.GOOGLE_DRIVE

            def put(self, logical_path, data, **kwargs):
                raise KeyError("file")

        service = VireadOcrTrainingService(SimpleNamespace())
        service.repo = _FakeRepo()
        service._admin = AsyncMock()
        service._artifact_router = AsyncMock(return_value=_BrokenBridgeRouter())

        with self.assertRaises(HTTPException) as raised:
            await service.benchmark(actor_id, payload)
        self.assertEqual(raised.exception.status_code, 502)

    async def test_benchmark_handles_cohort_unique_integrity_error_as_idempotent_or_409(self):
        actor_id = uuid4()
        run_id = uuid4()
        other_run_id = uuid4()
        locked_id = uuid4()
        cohort_id = uuid4()
        bench_id = uuid4()
        locked_sha = "1" * 64
        payload, expected = self._make_pilot_payload(run_id, locked_id, locked_sha, n=20)
        paired = [{
            "sample_id": o.sample_id, "group_id": o.group_id,
            "reference": e["reference"], "original": o.original,
            "candidate": o.candidate, "parent": o.parent, "active": o.active,
        } for o, e in zip(payload.outputs, expected)]
        report_hash = hashlib.sha256(_canonical(paired)).hexdigest()

        for raced_run_id, expect_idempotent in ((str(run_id), True), (str(other_run_id), False)):
            state = {"inserted": False}

            class _RacingRepo:
                async def one(self, sql: str, params=None):
                    if "FROM public.viread_ocr_training_runs" in sql:
                        return {
                            "id": run_id, "status": "CANDIDATE", "profile": "FLOW1_EXTERNAL_TRDG",
                            "parent_checkpoint_sha256": ORIGINAL_SHA256, "checkpoint_sha256": "2" * 64,
                        }
                    if "FROM public.viread_ocr_dataset_versions" in sql:
                        return {
                            "id": locked_id, "source_flow": "LOCKED_TEST",
                            "version_sha256": locked_sha, "is_locked_test": True, "sample_count": 20,
                        }
                    if "unique_annotation_count" in sql:
                        return {
                            "sample_count": 20, "unique_annotation_count": 20,
                            "unique_image_count": 20, "group_count": 5, "verified_count": 20,
                        }
                    if "FROM public.viread_ocr_evaluation_cohorts" in sql:
                        return {
                            "id": cohort_id, "evaluation_type": "PILOT",
                            "manifest_sha256": locked_sha, "sample_count": 20, "group_count": 5,
                        }
                    if "FROM public.viread_ocr_benchmarks" in sql:
                        if state["inserted"]:
                            return {
                                "id": bench_id, "run_id": raced_run_id,
                                "report_sha256": report_hash, "gate_status": "INSUFFICIENT_EVIDENCE",
                                "sample_count": 20, "group_count": 5, "metrics": {"quality_gate": {"status": "INSUFFICIENT_EVIDENCE"}},
                            }
                        return None
                    if "FROM public.viread_ocr_active_model" in sql:
                        return {"checkpoint_sha256": ORIGINAL_SHA256}
                    return None

                async def all(self, sql: str, params=None):
                    return list(expected)

                async def execute(self, sql: str, params=None):
                    if "INSERT INTO public.viread_ocr_benchmarks" in sql:
                        state["inserted"] = True
                        raise IntegrityError(
                            "INSERT", {}, Exception("duplicate key value violates unique constraint viread_ocr_benchmarks_evaluation_cohort_uidx")
                        )

                async def commit(self):
                    return None

                async def rollback(self):
                    return None

            service = VireadOcrTrainingService(SimpleNamespace())
            service.repo = _RacingRepo()
            service._admin = AsyncMock()
            service._artifact_router = AsyncMock(return_value=SimpleNamespace(write_provider=StorageProvider.SUPABASE_LEGACY))

            with patch("app.services.viread_ocr_training_service.ensure_database_capacity", new=AsyncMock()):
                if expect_idempotent:
                    replay = await service.benchmark(actor_id, payload)
                    self.assertTrue(replay["idempotent"])
                    self.assertEqual(replay["benchmark_id"], bench_id)
                else:
                    with self.assertRaises(HTTPException) as err:
                        await service.benchmark(actor_id, payload)
                    self.assertEqual(err.exception.status_code, 409)

    async def test_benchmark_colab_route_commits_initial_lease_before_service_benchmark(self):
        job_id = uuid4()
        run_id = uuid4()
        actor_id = uuid4()
        locked_id = uuid4()
        locked_sha = "3" * 64
        payload, _ = self._make_pilot_payload(run_id, locked_id, locked_sha, n=2)
        call_order: list[str] = []

        fake_job = {
            "id": job_id, "target": "COLAB", "status": "COLAB_RUNNING",
            "worker_id": "colab-worker-1", "run_id": run_id, "created_by": actor_id,
            "locked_test_version_id": locked_id, "locked_test_manifest_sha256": locked_sha,
            "lease_active": True,
        }
        fake_db = SimpleNamespace(
            commit=AsyncMock(side_effect=lambda: call_order.append("db_commit")),
            rollback=AsyncMock(side_effect=lambda: call_order.append("db_rollback")),
        )
        fake_service = SimpleNamespace(
            repo=SimpleNamespace(one=AsyncMock(return_value=fake_job), rollback=AsyncMock()),
            benchmark=AsyncMock(side_effect=lambda *a, **kw: (call_order.append("service_benchmark"), {"gate_status": "V2_WIN", "evaluation_type": "PRODUCTION"})[1]),
        )

        with patch.object(admin_viread_training, "VireadOcrTrainingService", return_value=fake_service):
            res = await admin_viread_training.benchmark_viread_colab_job(
                job_id=job_id,
                worker_id="colab-worker-1",
                payload=payload,
                _worker=None,
                db=fake_db,
            )

        self.assertEqual(res["gate_status"], "V2_WIN")
        self.assertEqual(call_order, ["db_commit", "service_benchmark"])
        fake_service.benchmark.assert_awaited_once_with(
            actor_id, payload, job_id=job_id, worker_id="colab-worker-1"
        )

    async def test_finish_colab_job_opt_in_auto_promote_default_off_and_enabled_on_v2_win(self):
        job_id = uuid4()
        run_id = uuid4()
        actor_id = uuid4()
        dataset_id = uuid4()
        bench_id = uuid4()

        def _make_service_mock(profile="FLOW2_ADMIN_VERIFIED", eval_type="PRODUCTION", decide_side_effect=None):
            job = {
                "id": job_id, "profile": profile, "status": "COLAB_RUNNING",
                "target": "COLAB", "worker_id": "colab-1", "dataset_version_id": dataset_id,
                "manifest_sha256": "a" * 64, "config_sha256": "b" * 64,
                "parent_checkpoint_sha256": ORIGINAL_SHA256, "run_id": run_id,
                "created_by": actor_id, "attempts": 1, "metadata": {}, "lease_active": True,
            }
            run = {
                "id": run_id, "status": "BENCHMARKED", "profile": profile,
                "dataset_version_id": dataset_id, "manifest_sha256": "a" * 64,
                "parent_checkpoint_sha256": ORIGINAL_SHA256, "created_by": actor_id,
            }
            bench = {"id": bench_id, "gate_status": "V2_WIN", "evaluation_type": eval_type}
            events = []

            class _Repo:
                async def one(self, sql, params=None):
                    if "FROM public.viread_ocr_training_jobs" in sql:
                        return dict(job)
                    if "FROM public.viread_ocr_training_runs" in sql:
                        return dict(run)
                    if "FROM public.viread_ocr_benchmarks" in sql:
                        return dict(bench)
                    return None

                async def execute(self, sql, params=None):
                    return None

                async def commit(self):
                    events.append("finish_commit")

                async def rollback(self):
                    events.append("finish_rollback")

            decide_mock = AsyncMock(
                side_effect=decide_side_effect
                or (lambda *a, **kw: (events.append("decide"), {"decision_id": uuid4()})[1])
            )
            return SimpleNamespace(repo=_Repo(), decide=decide_mock), decide_mock, events

        finish_payload = TrainingWorkerFinish(
            worker_id="colab-1", run_id=run_id, status="BENCHMARKED", runtime={"device": "T4"},
        )

        # 1. Default (env unset): strictly disabled
        svc1, decide1, _ = _make_service_mock()
        with patch.dict(os.environ, {}, clear=False):
            os.environ.pop("VIREAD_FLOW2_AUTO_PROMOTE_ON_V2_WIN", None)
            with patch.object(admin_viread_training, "VireadOcrTrainingService", return_value=svc1):
                res1 = await admin_viread_training.finish_viread_colab_training_job(
                    job_id=job_id, payload=finish_payload, _worker=None, db=MagicMock(rollback=AsyncMock())
                )
        self.assertEqual(res1["status"], "BENCHMARKED")
        decide1.assert_not_awaited()

        # 2. Explicitly "true" on Flow 2 + PRODUCTION + V2_WIN -> calls decide AFTER commit
        svc2, decide2, events2 = _make_service_mock()
        with patch.dict(os.environ, {"VIREAD_FLOW2_AUTO_PROMOTE_ON_V2_WIN": "true"}):
            with patch.object(admin_viread_training, "VireadOcrTrainingService", return_value=svc2):
                res2 = await admin_viread_training.finish_viread_colab_training_job(
                    job_id=job_id, payload=finish_payload, _worker=None, db=MagicMock(rollback=AsyncMock())
                )
        self.assertEqual(res2["status"], "BENCHMARKED")
        self.assertTrue(res2.get("auto_promoted"))
        self.assertEqual(events2, ["finish_commit", "decide"])
        decide2.assert_awaited_once()
        called_actor, called_req = decide2.call_args[0]
        self.assertEqual(called_actor, actor_id)
        self.assertEqual(called_req.action, "APPROVE")
        self.assertEqual(called_req.run_id, run_id)
        self.assertEqual(called_req.benchmark_id, bench_id)

        # 3. Failing decide never turns completed /finish into 500
        svc3, decide3, _ = _make_service_mock(
            decide_side_effect=HTTPException(status_code=409, detail="Lineage changed")
        )
        with patch.dict(os.environ, {"VIREAD_FLOW2_AUTO_PROMOTE_ON_V2_WIN": "true"}):
            with patch.object(admin_viread_training, "VireadOcrTrainingService", return_value=svc3):
                res3 = await admin_viread_training.finish_viread_colab_training_job(
                    job_id=job_id, payload=finish_payload, _worker=None, db=MagicMock(rollback=AsyncMock())
                )
        self.assertEqual(res3["status"], "BENCHMARKED")
        self.assertNotIn("auto_promoted", res3)
        decide3.assert_awaited_once()

    async def test_decide_checks_drive_outside_lock_clears_manifest_cache_and_wakes_remote_worker(self):
        actor_id = uuid4()
        run_id = uuid4()
        bench_id = uuid4()
        cand_sha = "5" * 64
        drive_path = "gdrive://manifest_flow2_123"
        events: list[str] = []

        class _Repo:
            async def one(self, sql, params=None):
                if "FROM public.viread_ocr_active_model" in sql:
                    if "FOR UPDATE" in sql:
                        events.append("lock_active")
                    return {
                        "checkpoint_sha256": ORIGINAL_SHA256,
                        "storage_path": None,
                        "profile": "ORIGINAL",
                        "decision_id": None,
                    }
                if "FROM public.viread_ocr_training_runs" in sql:
                    if "FOR UPDATE" in sql:
                        events.append("lock_run")
                    return {
                        "id": run_id, "profile": "FLOW2_ADMIN_VERIFIED",
                        "status": "BENCHMARKED", "checkpoint_sha256": cand_sha,
                        "checkpoint_storage_path": drive_path,
                        "parent_checkpoint_sha256": ORIGINAL_SHA256,
                    }
                if "FROM public.viread_ocr_benchmarks" in sql:
                    return {
                        "id": bench_id, "run_id": run_id,
                        "candidate_checkpoint_sha256": cand_sha,
                        "gate_status": "V2_WIN", "evaluation_type": "PRODUCTION",
                        "parent_checkpoint_sha256": ORIGINAL_SHA256,
                        "active_checkpoint_sha256": ORIGINAL_SHA256,
                    }
                return None

            async def execute(self, sql, params=None):
                return None

            async def commit(self):
                events.append("commit")

            async def rollback(self):
                events.append("rollback")

        class _Router:
            def exists(self, ref):
                events.append("drive_exists")
                return ref == drive_path

        service = VireadOcrTrainingService(SimpleNamespace())
        service.repo = _Repo()
        service._admin = AsyncMock()
        service._artifact_router = AsyncMock(return_value=_Router())

        with (
            patch("app.services.ocr_inference_job_service.is_remote_ocr_mode", return_value=True),
            patch("app.services.ocr_inference_job_service.clear_active_model_manifest_cache") as mock_clear,
            patch("app.services.ocr_inference_job_service.trigger_remote_ocr_model_reload_wakeup") as mock_wake,
        ):
            res = await service.decide(
                actor_id,
                ModelDecisionRequest(
                    action="APPROVE",
                    run_id=run_id,
                    benchmark_id=bench_id,
                    reason="Approve verified Flow 2 candidate after Production V2_WIN",
                ),
            )

        self.assertEqual(res["active_model"]["checkpoint_sha256"], cand_sha)
        # Drive exists must run AFTER read rollback and BEFORE FOR UPDATE locks
        self.assertLess(events.index("rollback"), events.index("drive_exists"))
        self.assertLess(events.index("drive_exists"), events.index("lock_active"))
        self.assertLess(events.index("lock_active"), events.index("commit"))
        mock_clear.assert_called_once()
        mock_wake.assert_called_once_with(reason="model_approve", bypass_coalesce=True)


if __name__ == "__main__":
    unittest.main()
