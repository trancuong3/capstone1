from __future__ import annotations

import asyncio
import hashlib
import json
import logging
import math
import random
import re
import unicodedata
from collections import defaultdict
from datetime import datetime, timezone
from typing import Any
from uuid import UUID, uuid4

from fastapi import HTTPException, status
from PIL import Image, UnidentifiedImageError
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.repositories.viread_ocr_training_repository import VireadOcrTrainingRepository
from app.schemas.viread_ocr_training import BenchmarkCreate, DatasetImport, ModelDecisionRequest, TrainingRunComplete, TrainingRunCreate
from app.services.admin_ocr_service import AdminOcrService
from app.services.storage_service import create_signed_image_url, download_object, upload_object
from app.services.viread_training_storage_quota import ensure_database_capacity, ensure_storage_capacity

logger = logging.getLogger(__name__)
ORIGINAL_SHA256 = "380512193a8b6cbf6fad80deacdc9b6939d10d473d199892fc6408d13775ea59"
ORIGINAL_VOCAB_SHA256 = "b4ec9437ef82d952a65c101ea7ec6748a7168777c2d84cdb6a1bba7540bd163d"
ORIGINAL_ARCHITECTURE_SHA256 = "a26f0adfc33ffe32cdf73c7daa04c39a86a36a8ac0dcc6047fe7a4d9b4fe6dc6"
MAX_SHARD_BYTES = 40 * 1024 * 1024
MIN_LOCKED_PAIRS = 200
MIN_LOCKED_GROUPS = 30
TRAINING_PROFILES = {
    "FLOW1_EXTERNAL_TRDG": {
        "dataset_flows": {"FLOW2_EXTERNAL_TRDG"},
        "requires_components": {"FLOW2_EXTERNAL", "FLOW2_TRDG"},
        "minimum_counts": {"FLOW2_EXTERNAL": 500, "FLOW2_TRDG": 20_000},
        "maximum_counts": {"FLOW2_EXTERNAL": 1_000, "FLOW2_TRDG": 50_000},
    },
    "FLOW2_ADMIN_VERIFIED": {"dataset_flows": {"FLOW1_VERIFIED"}, "requires_components": set(), "minimum_counts": {}, "maximum_counts": {}},
    # Retain the legacy profile mapping for stored runs and clients during deployment.
    "FLOW1_VERIFIED": {"dataset_flows": {"FLOW1_VERIFIED"}, "requires_components": set(), "minimum_counts": {}, "maximum_counts": {}},
    "FLOW2_EXTERNAL_TRDG": {"dataset_flows": {"FLOW2_EXTERNAL", "FLOW2_TRDG", "FLOW2_EXTERNAL_TRDG"}, "requires_components": set(), "minimum_counts": {}, "maximum_counts": {}},
}


def _canonical(value: Any) -> bytes:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode("utf-8")


def _sha(value: str) -> bool:
    return len(value) == 64 and all(char in "0123456789abcdef" for char in value.lower())


def _deduplicate_verified_samples(samples: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Keep one crop per image hash and reject conflicting verified labels."""
    by_hash: dict[str, dict[str, Any]] = {}
    for item in samples:
        digest = str(item["image_sha256"]).lower()
        previous = by_hash.get(digest)
        if previous is None:
            by_hash[digest] = item
            continue
        if unicodedata.normalize("NFC", str(previous["label"])) != unicodedata.normalize(
            "NFC", str(item["label"])
        ):
            raise HTTPException(
                status_code=409,
                detail="The same verified image crop has conflicting labels; resolve the source revision before dataset snapshotting",
            )
    return list(by_hash.values())


def _verified_snapshot(source_rows: list[dict[str, Any]]) -> tuple[dict[str, Any], list[dict[str, Any]]]:
    """Build one immutable cumulative manifest and its exact DB materialization rows.

    Keep the schema at v1 for existing workers, but version the snapshot strategy so
    already-persisted snapshots created by the former INSERT..SELECT path cannot be
    mistaken for this canonical, deduplicated snapshot.
    """
    samples = _deduplicate_verified_samples(source_rows)
    manifest_samples = []
    for item in samples:
        manifest_samples.append({
            "sample_id": str(item["sample_id"]),
            "group_id": str(item["group_id"]),
            "split": str(item["split"]),
            "image_storage_path": str(item["image_storage_path"]),
            "image_sha256": str(item["image_sha256"]).lower(),
            "label": unicodedata.normalize("NFC", str(item["label"])),
            "source_page_id": str(item["source_page_id"]) if item.get("source_page_id") else None,
            "source_revision_id": str(item["source_revision_id"]) if item.get("source_revision_id") else None,
            "verified": True,
        })
    manifest = {
        "schema": "viread-dataset-v1",
        "source_flow": "FLOW1_VERIFIED",
        "split_seed": "viread-vietocr-v2-split-v1",
        "snapshot_strategy": "cumulative-deduplicated-v2",
        "samples": manifest_samples,
    }
    return manifest, samples


def _verified_snapshot_db_rows(dataset_id: UUID, source_rows: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Map exactly the canonical source rows to immutable version-owned rows."""
    return [{
        "dataset_id": dataset_id,
        "source_flow": "FLOW1_VERIFIED",
        "group_id": item["group_id"],
        "split": item["split"],
        "path": item["image_storage_path"],
        "image_sha": str(item["image_sha256"]).lower(),
        "label": unicodedata.normalize("NFC", str(item["label"])),
        "source_page_id": item.get("source_page_id"),
        "source_revision_id": item.get("source_revision_id"),
        "source_annotation_id": item["sample_id"],
        "provenance": json.dumps({
            **(item.get("provenance") or {}),
            "snapshot": "admin_verified_outbox",
            "source_sample_id": item["sample_id"],
        }),
    } for item in source_rows]


def _edit_distance(left: list[str], right: list[str]) -> int:
    if len(left) < len(right):
        left, right = right, left
    previous = list(range(len(right) + 1))
    for i, item in enumerate(left, 1):
        current = [i]
        for j, other in enumerate(right, 1):
            current.append(min(current[-1] + 1, previous[j] + 1, previous[j - 1] + (item != other)))
        previous = current
    return previous[-1]


def _metric_counts(lines: list[dict[str, str]], field: str, metric: str) -> tuple[int, int]:
    errors = units = 0
    for line in lines:
        reference = list(unicodedata.normalize("NFC", line["reference"])) if metric == "cer" else unicodedata.normalize("NFC", line["reference"]).split()
        hypothesis = list(unicodedata.normalize("NFC", line[field])) if metric == "cer" else unicodedata.normalize("NFC", line[field]).split()
        errors += _edit_distance(reference, hypothesis)
        units += len(reference)
    return errors, units


def _paired_metric(lines: list[dict[str, str]], metric: str, *, replicates: int = 5000, seed: int = 20261112) -> dict[str, Any]:
    groups: dict[str, list[dict[str, str]]] = defaultdict(list)
    for line in lines:
        groups[line["group_id"]].append(line)
    original_errors, units = _metric_counts(lines, "original", metric)
    candidate_errors, _ = _metric_counts(lines, "candidate", metric)
    if units <= 0:
        raise ValueError("benchmark reference units are empty")
    names = sorted(groups)
    rng = random.Random(seed)
    deltas = []
    for _ in range(replicates):
        selected = [name for _ in names for name in (names[rng.randrange(len(names))],)]
        sampled = [line for name in selected for line in groups[name]]
        base_n, base_units = _metric_counts(sampled, "original", metric)
        candidate_n, _ = _metric_counts(sampled, "candidate", metric)
        deltas.append(candidate_n / base_units - base_n / base_units)
    deltas.sort()
    return {"metric": metric, "original_error_count": original_errors,
            "candidate_error_count": candidate_errors, "reference_unit_count": units,
            "original_rate": original_errors / units, "candidate_rate": candidate_errors / units,
            "delta_candidate_minus_original": candidate_errors / units - original_errors / units,
            "paired_cluster_bootstrap_95ci": [deltas[math.floor(0.025 * (len(deltas) - 1))],
                                               deltas[math.ceil(0.975 * (len(deltas) - 1))]],
            "bootstrap_replicates": replicates, "cluster_count": len(names), "seed": seed}


def _gate(metrics: dict[str, Any], *, manifest_sha: str) -> dict[str, Any]:
    if len(metrics.get("outputs", [])) < MIN_LOCKED_PAIRS or len({item["group_id"] for item in metrics.get("outputs", [])}) < MIN_LOCKED_GROUPS:
        return {"status": "INSUFFICIENT_EVIDENCE", "promotion_allowed": False,
                "reason": "minimum_locked_test_size_not_met"}
    for metric in (metrics["cer"], metrics["wer"]):
        if not math.isfinite(float(metric["candidate_rate"])) or not math.isfinite(float(metric["original_rate"])):
            return {"status": "EVALUATION_FAILED", "promotion_allowed": False, "reason": "non_finite_metric"}
        if metric["delta_candidate_minus_original"] > 0.005:
            return {"status": "ORIGINAL_WIN", "promotion_allowed": False, "reason": "non_regression_limit_exceeded"}
    if all(float(metrics[name]["paired_cluster_bootstrap_95ci"][1]) < 0 for name in ("cer", "wer")):
        return {"status": "V2_WIN", "promotion_allowed": True, "requires_human_approval": True,
                "reason": "paired_cluster_confidence_intervals_favor_v2", "locked_test_manifest_sha256": manifest_sha}
    if any(float(metrics[name]["paired_cluster_bootstrap_95ci"][0]) > 0 for name in ("cer", "wer")):
        return {"status": "ORIGINAL_WIN", "promotion_allowed": False,
                "reason": "paired_cluster_confidence_interval_favors_original"}
    return {"status": "NO_SIGNIFICANT_DIFFERENCE", "promotion_allowed": False,
            "reason": "paired_cluster_confidence_intervals_include_zero"}


class VireadOcrTrainingService:
    def __init__(self, db: AsyncSession):
        self.db = db
        self.repo = VireadOcrTrainingRepository(db)

    async def _admin(self, actor_id: UUID) -> None:
        await AdminOcrService(self.db).require_admin(actor_id)

    async def overview(self, actor_id: UUID) -> dict[str, Any]:
        await self._admin(actor_id)
        outbox = await self.repo.all("SELECT status, count(*)::integer AS count FROM public.viread_ocr_outbox GROUP BY status ORDER BY status")
        samples = await self.repo.all("SELECT source_flow, split, count(DISTINCT image_sha256)::integer AS count FROM public.viread_ocr_samples GROUP BY source_flow, split ORDER BY source_flow, split")
        runs = await self.repo.all("""
            SELECT id AS run_id, profile, status, parent_checkpoint_sha256, manifest_sha256,
                   checkpoint_sha256, checkpoint_storage_path, step, created_at
            FROM public.viread_ocr_training_runs ORDER BY created_at DESC LIMIT 20
        """)
        jobs = await self.repo.all("""
            SELECT id AS job_id, profile, target, status, dataset_version_id,
                   manifest_sha256, config_sha256, parent_checkpoint_sha256, run_id,
                   attempts, progress, last_error_code, metadata, colab_execution_id,
                   colab_execution_resource_name, colab_operation_name,
                   colab_execution_number, created_at, updated_at
            FROM public.viread_ocr_training_jobs ORDER BY created_at DESC LIMIT 30
        """)
        benchmarks = await self.repo.all("""
            SELECT id AS benchmark_id, run_id, gate_status, sample_count, group_count,
                   candidate_checkpoint_sha256, locked_test_manifest_sha256, created_at
            FROM public.viread_ocr_benchmarks ORDER BY created_at DESC LIMIT 20
        """)
        active = await self.repo.one("SELECT model_family, checkpoint_sha256, storage_path, profile, decision_id, updated_at FROM public.viread_ocr_active_model WHERE singleton = TRUE")
        return {"outbox": outbox, "samples": samples, "jobs": jobs, "runs": runs,
                "benchmarks": benchmarks, "active_model": active}

    async def register_dataset(self, actor_id: UUID, payload: DatasetImport) -> dict[str, Any]:
        await self._admin(actor_id)
        samples = [item.model_dump() for item in payload.samples]
        if len({item["sample_id"] for item in samples}) != len(samples):
            raise HTTPException(status_code=422, detail="Dataset sample IDs must be unique")
        if len({item["image_sha256"] for item in samples}) != len(samples):
            raise HTTPException(status_code=422, detail="Dataset image content must be unique within a version")
        for item in samples:
            path = item["image_storage_path"]
            item_flow = item.get("source_flow") or payload.source_flow
            if payload.source_flow == "FLOW2_EXTERNAL_TRDG" and item_flow not in {"FLOW2_EXTERNAL", "FLOW2_TRDG"}:
                raise HTTPException(status_code=422, detail="Flow 1 combined datasets must label each sample as external or TRDG")
            if item_flow == "FLOW2_EXTERNAL":
                valid = path.startswith(("ocr-training/flow1/external/", "ocr-training/flow2/external/")) and item["verified"] and item["annotation_id"]
                valid_split = item["split"] in {"train", "validation", "holdout"}
            elif item_flow == "FLOW2_TRDG":
                valid = path.startswith(("ocr-training/flow1/trdg/", "ocr-training/flow2/trdg/")) and not item["verified"] and item["provenance"].get("generator") == "trdg"
                valid_split = item["split"] in {"train", "validation", "holdout"}
            else:
                valid = payload.source_flow == "LOCKED_TEST" and path.startswith("ocr-training/locked-test/") and item["verified"] and bool(item["annotation_id"])
                valid_split = item["split"] == "locked_test"
            if not valid or not valid_split:
                raise HTTPException(status_code=422, detail="Dataset source, provenance, path, verification, or split contract is invalid")
            item["label"] = unicodedata.normalize("NFC", item["label"]).strip()
            item["source_flow"] = item_flow
            if not item["label"]:
                raise HTTPException(status_code=422, detail="Dataset label must not be blank")
        groups: dict[str, str] = {}
        for item in samples:
            previous = groups.setdefault(item["group_id"], item["split"])
            if previous != item["split"]:
                raise HTTPException(status_code=422, detail="Samples from the same document must share one split")

        semaphore = asyncio.Semaphore(8)
        async def verify_object(item: dict[str, Any]) -> None:
            async with semaphore:
                data = await asyncio.to_thread(download_object, item["image_storage_path"])
                if hashlib.sha256(data).hexdigest() != item["image_sha256"]:
                    raise HTTPException(status_code=422, detail="Dataset image hash does not match its registered object")
        # Bound task creation for the 20k-50k synthetic corpus target.
        for start in range(0, len(samples), 256):
            await asyncio.gather(*(verify_object(item) for item in samples[start:start + 256]))

        manifest = {"schema": "viread-locked-test-v1" if payload.source_flow == "LOCKED_TEST" else "viread-dataset-v1",
                    "source_flow": payload.source_flow, "sealed": payload.source_flow == "LOCKED_TEST",
                    "split_seed": payload.split_seed, "samples": samples, "provenance": payload.provenance}
        encoded = _canonical(manifest)
        version_sha = hashlib.sha256(encoded).hexdigest()
        manifest_folder = {
            "FLOW2_EXTERNAL": "flow1_external",
            "FLOW2_TRDG": "flow1_trdg",
            "FLOW2_EXTERNAL_TRDG": "flow1_external_trdg",
            "FLOW1_VERIFIED": "flow2_admin_verified",
            "LOCKED_TEST": "locked_test",
        }[payload.source_flow]
        storage_path = f"ocr-training/manifests/{manifest_folder}/{version_sha}.json"
        existing = await self.repo.one("""
            SELECT id, source_flow, version_sha256, manifest_storage_path, sample_count, is_locked_test
            FROM public.viread_ocr_dataset_versions WHERE source_flow=:source_flow AND version_sha256=:version_sha
        """, {"source_flow": payload.source_flow, "version_sha": version_sha})
        if existing:
            return existing
        estimated_db_bytes = len(encoded) + sum(len(item["label"].encode("utf-8")) + 2048 for item in samples)
        await ensure_database_capacity(self.db, estimated_db_bytes)
        await ensure_storage_capacity(self.db, len(encoded), existing_object_path=storage_path)
        try:
            await asyncio.to_thread(upload_object, storage_path, encoded, "application/json", upsert=True)
            result = await self.repo.one("""
                INSERT INTO public.viread_ocr_dataset_versions
                    (source_flow, version_sha256, manifest_storage_path, sample_count, is_locked_test,
                     split_seed, provenance, created_by)
                VALUES (:source_flow, :version_sha, :storage_path, :sample_count, :locked_test,
                        :split_seed, CAST(:provenance AS jsonb), :actor_id)
                ON CONFLICT (source_flow, version_sha256) DO UPDATE SET version_sha256 = EXCLUDED.version_sha256
                RETURNING id, source_flow, version_sha256, manifest_storage_path, sample_count, is_locked_test
            """, {"source_flow": payload.source_flow, "version_sha": version_sha, "storage_path": storage_path,
                  "sample_count": len(samples), "locked_test": payload.source_flow == "LOCKED_TEST",
                  "split_seed": payload.split_seed, "provenance": json.dumps(payload.provenance), "actor_id": actor_id})
            sample_rows = [{"dataset_id": result["id"], "source_flow": item["source_flow"],
                            "group_id": item["group_id"], "split": item["split"], "path": item["image_storage_path"],
                            "image_sha": item["image_sha256"], "label": item["label"], "sample_id": item["sample_id"],
                            "provenance": json.dumps({**item["provenance"], "verified": item["verified"],
                                                       "annotation_id": item["annotation_id"]})}
                           for item in samples]
            for start in range(0, len(sample_rows), 1000):
                await self.repo.execute("""
                INSERT INTO public.viread_ocr_samples
                    (dataset_version_id, source_flow, source_group_id, split, image_storage_path,
                     image_sha256, label, source_annotation_id, provenance)
                VALUES (:dataset_id, :source_flow, :group_id, :split, :path, :image_sha,
                        :label, :sample_id, CAST(:provenance AS jsonb))
                ON CONFLICT DO NOTHING
                """, sample_rows[start:start + 1000])
            await self.repo.commit()
            return result
        except HTTPException:
            await self.repo.rollback()
            raise
        except Exception:
            await self.repo.rollback()
            raise

    async def admin_verified_manifest(self, actor_id: UUID, *, limit: int, offset: int) -> dict[str, Any]:
        await self._admin(actor_id)
        await self.repo.execute("SELECT pg_advisory_xact_lock(hashtext('viread_ocr_flow1_snapshot'))")
        source_rows = await self.repo.all("""
            SELECT id::text AS sample_id, source_group_id AS group_id, split, image_storage_path,
                   image_sha256, label, source_page_id, source_revision_id, provenance
            FROM public.viread_ocr_samples
            WHERE source_flow='FLOW1_VERIFIED' AND split IN ('train','validation') AND dataset_version_id IS NULL
            ORDER BY created_at, id
        """)
        manifest, source_rows = _verified_snapshot(source_rows)
        version_sha = hashlib.sha256(_canonical(manifest)).hexdigest()
        if source_rows:
            dataset = await self.repo.one("""
                SELECT id, version_sha256, manifest_storage_path, sample_count
                FROM public.viread_ocr_dataset_versions
                WHERE source_flow='FLOW1_VERIFIED' AND version_sha256=:version_sha
            """, {"version_sha": version_sha})
        else:
            dataset = await self.repo.one("""
                SELECT id, version_sha256, manifest_storage_path FROM public.viread_ocr_dataset_versions
                WHERE source_flow='FLOW1_VERIFIED' ORDER BY created_at DESC LIMIT 1
            """)
            if dataset:
                version_sha = dataset["version_sha256"]
        if dataset and source_rows:
            actual_count = await self.repo.one("""
                SELECT count(*)::integer AS total
                FROM public.viread_ocr_samples WHERE dataset_version_id=:dataset_id
            """, {"dataset_id": dataset["id"]})
            expected_count = len(source_rows)
            if (int(dataset["sample_count"]) != expected_count
                    or not actual_count or int(actual_count["total"]) != expected_count):
                raise HTTPException(
                    status_code=409,
                    detail="Verified dataset snapshot does not match its canonical manifest; refusing to schedule training",
                )
        if not dataset:
            manifest_path = f"ocr-training/manifests/flow2_admin_verified/{version_sha}.json"
            manifest_bytes = _canonical(manifest)
            estimated_db_bytes = len(manifest_bytes) + sum(len(item["label"].encode("utf-8")) + 2048 for item in source_rows)
            await ensure_database_capacity(self.db, estimated_db_bytes)
            await ensure_storage_capacity(self.db, len(manifest_bytes), existing_object_path=manifest_path)
            await asyncio.to_thread(upload_object, manifest_path, manifest_bytes, "application/json", upsert=True)
            dataset = await self.repo.one("""
                INSERT INTO public.viread_ocr_dataset_versions
                    (source_flow, version_sha256, manifest_storage_path, sample_count, is_locked_test,
                     split_seed, provenance)
                VALUES ('FLOW1_VERIFIED', :version_sha, :manifest_path, :sample_count, FALSE,
                        'viread-vietocr-v2-split-v1', CAST(:provenance AS jsonb))
                ON CONFLICT (source_flow, version_sha256) DO UPDATE SET version_sha256=EXCLUDED.version_sha256
                RETURNING id, manifest_storage_path
            """, {"version_sha": version_sha, "manifest_path": manifest_path,
                  "sample_count": len(source_rows), "provenance": json.dumps({"snapshot": "admin_verified_outbox"})})
            if source_rows:
                snapshot_rows = _verified_snapshot_db_rows(dataset["id"], source_rows)
                await self.repo.execute("""
                    INSERT INTO public.viread_ocr_samples
                        (dataset_version_id, source_flow, source_group_id, split, image_storage_path,
                         image_sha256, label, source_page_id, source_revision_id, source_annotation_id, provenance)
                    VALUES (:dataset_id, :source_flow, :group_id, :split, :path,
                            :image_sha, :label, :source_page_id, :source_revision_id,
                            :source_annotation_id, CAST(:provenance AS jsonb))
                    ON CONFLICT DO NOTHING
                """, snapshot_rows)
                actual_count = await self.repo.one("""
                    SELECT count(*)::integer AS total
                    FROM public.viread_ocr_samples WHERE dataset_version_id=:dataset_id
                """, {"dataset_id": dataset["id"]})
                if not actual_count or int(actual_count["total"]) != len(snapshot_rows):
                    raise RuntimeError("verified dataset snapshot insert count differs from manifest")
            await self.repo.commit()
        elif dataset and not source_rows:
            version_sha = dataset["version_sha256"]
        dataset_id = dataset["id"]
        total_row = await self.repo.one("SELECT count(*)::integer AS total FROM public.viread_ocr_samples WHERE dataset_version_id=:dataset_id", {"dataset_id": dataset_id})
        items = await self.repo.all("""
            SELECT source_annotation_id AS sample_id, source_group_id AS group_id, split, image_storage_path,
                   image_sha256, label, source_revision_id::text AS source_revision_id
            FROM public.viread_ocr_samples
            WHERE dataset_version_id=:dataset_id
            ORDER BY created_at, id LIMIT :limit OFFSET :offset
        """, {"dataset_id": dataset_id, "limit": limit, "offset": offset})
        for item in items:
            item["image"] = create_signed_image_url(item["image_storage_path"])
            item["source_flow"] = "FLOW1_VERIFIED"
            item["verified"] = True
        return {"dataset_version_id": dataset_id, "manifest_sha256": version_sha,
                "source_flow": "FLOW1_VERIFIED", "training_profile": "FLOW2_ADMIN_VERIFIED",
                "items": items, "total": int(total_row["total"] if total_row else 0),
                "limit": limit, "offset": offset, "next_offset": offset + len(items) if offset + len(items) < int(total_row["total"] if total_row else 0) else None}

    async def active_model_artifact(self, actor_id: UUID) -> dict[str, Any]:
        await self._admin(actor_id)
        active = await self.repo.one("SELECT checkpoint_sha256, storage_path, profile FROM public.viread_ocr_active_model WHERE singleton=TRUE")
        if not active:
            raise HTTPException(status_code=503, detail="Active model registry is not initialized")
        if active["storage_path"] is None:
            return {**active, "source_url": "https://vocr.vn/data/vietocr/vgg_transformer.pth", "chunks": []}
        raw = await asyncio.to_thread(download_object, active["storage_path"])
        try:
            manifest = json.loads(raw)
        except (UnicodeDecodeError, json.JSONDecodeError) as exc:
            raise HTTPException(status_code=503, detail="Active model shard manifest is invalid") from exc
        if manifest.get("checkpoint_sha256") != active["checkpoint_sha256"] or not isinstance(manifest.get("chunks"), list):
            raise HTTPException(status_code=503, detail="Active model manifest does not match the registered checkpoint")
        chunks = []
        for item in manifest["chunks"]:
            chunks.append({**item, "url": create_signed_image_url(item["path"])})
        return {**active, "manifest_sha256": hashlib.sha256(raw).hexdigest(), "chunks": chunks}

    async def dataset_samples(self, actor_id: UUID, dataset_id: UUID, *, limit: int, offset: int) -> dict[str, Any]:
        await self._admin(actor_id)
        dataset = await self.repo.one("""
            SELECT id, source_flow, version_sha256, sample_count, is_locked_test, manifest_storage_path
            FROM public.viread_ocr_dataset_versions WHERE id=:id
        """, {"id": dataset_id})
        if not dataset:
            raise HTTPException(status_code=404, detail="Dataset version not found")
        items = await self.repo.all("""
            SELECT COALESCE(source_annotation_id, id::text) AS sample_id, source_annotation_id,
                   source_flow, source_group_id AS group_id, split, image_storage_path, image_sha256, label
            FROM public.viread_ocr_samples WHERE dataset_version_id=:dataset_id
            ORDER BY source_group_id, source_annotation_id, id LIMIT :limit OFFSET :offset
        """, {"dataset_id": dataset_id, "limit": limit, "offset": offset})
        dataset["manifest_url"] = create_signed_image_url(dataset["manifest_storage_path"])
        for item in items:
            item["image_url"] = create_signed_image_url(item["image_storage_path"])
        return {"dataset": dataset, "items": items, "limit": limit, "offset": offset,
                "next_offset": offset + len(items) if offset + len(items) < int(dataset["sample_count"]) else None}

    async def upload_dataset_object(self, actor_id: UUID, source_flow: str, filename: str, data: bytes, content_type: str) -> dict[str, Any]:
        await self._admin(actor_id)
        if source_flow not in {"FLOW2_EXTERNAL", "FLOW2_TRDG", "LOCKED_TEST"}:
            raise HTTPException(status_code=422, detail="Only Flow 1 external/TRDG and Locked Test objects can be uploaded here")
        if not data or len(data) > MAX_SHARD_BYTES:
            raise HTTPException(status_code=413, detail="Dataset image must be between 1 byte and 40 MiB")
        if content_type not in {"image/png", "image/jpeg", "image/webp"}:
            raise HTTPException(status_code=415, detail="Dataset objects must be PNG, JPEG, or WebP images")
        try:
            from io import BytesIO

            with Image.open(BytesIO(data)) as image:
                image.verify()
        except (UnidentifiedImageError, OSError) as exc:
            raise HTTPException(status_code=422, detail="Dataset object is not a decodable image") from exc
        digest = hashlib.sha256(data).hexdigest()
        safe_name = re.sub(r"[^A-Za-z0-9_.-]+", "_", filename or "image")[:100].strip("._") or "image"
        folder = {"FLOW2_EXTERNAL": "external", "FLOW2_TRDG": "trdg", "LOCKED_TEST": "locked-test"}[source_flow]
        path = f"ocr-training/{'locked-test' if source_flow == 'LOCKED_TEST' else 'flow1/' + folder}/{digest[:2]}/{digest}-{safe_name}"
        await ensure_storage_capacity(self.db, len(data), existing_object_path=path)
        await asyncio.to_thread(upload_object, path, data, content_type, upsert=True)
        return {"source_flow": source_flow, "image_storage_path": path, "image_sha256": digest,
                "byte_count": len(data), "content_type": content_type}

    async def create_run(self, actor_id: UUID, payload: TrainingRunCreate) -> dict[str, Any]:
        await self._admin(actor_id)
        dataset = await self.repo.one("SELECT id, source_flow, version_sha256, is_locked_test FROM public.viread_ocr_dataset_versions WHERE id=:id", {"id": payload.dataset_version_id})
        if not dataset or dataset["is_locked_test"] or dataset["version_sha256"] != payload.manifest_sha256:
            raise HTTPException(status_code=422, detail="Training manifest version is unavailable or hash mismatched")
        profile_contract = TRAINING_PROFILES[payload.profile]
        if dataset["source_flow"] not in profile_contract["dataset_flows"]:
            raise HTTPException(status_code=422, detail="Training profile does not match its independent data flow")
        split_counts = await self.repo.one("""
            SELECT count(*) FILTER (WHERE split='train')::integer AS train_count,
                   count(*) FILTER (WHERE split='validation')::integer AS validation_count
            FROM public.viread_ocr_samples WHERE dataset_version_id=:dataset_id
        """, {"dataset_id": dataset["id"]})
        if not split_counts or not split_counts["train_count"] or not split_counts["validation_count"]:
            raise HTTPException(status_code=422, detail={
                "message": "The selected dataset version needs separate train and validation groups before a run can start",
                "train_count": int((split_counts or {}).get("train_count") or 0),
                "validation_count": int((split_counts or {}).get("validation_count") or 0),
            })
        if profile_contract["requires_components"]:
            components = await self.repo.all("""
                SELECT source_flow, count(*)::integer AS count FROM public.viread_ocr_samples
                WHERE dataset_version_id=:dataset_id GROUP BY source_flow
            """, {"dataset_id": dataset["id"]})
            component_counts = {item["source_flow"]: int(item["count"]) for item in components}
            if not profile_contract["requires_components"].issubset(component_counts):
                raise HTTPException(status_code=422, detail="Flow 1 training requires its own dataset version to contain both verified real samples and TRDG samples")
            shortages = {flow: minimum - component_counts.get(flow, 0)
                         for flow, minimum in profile_contract["minimum_counts"].items()
                         if component_counts.get(flow, 0) < minimum}
            if shortages:
                raise HTTPException(status_code=422, detail={
                    "message": "Flow 1 dataset has not reached the minimum training volume",
                    "minimum_samples": profile_contract["minimum_counts"],
                    "registered_samples": component_counts,
                    "missing_samples": shortages,
                })
            excesses = {flow: component_counts.get(flow, 0) - maximum
                        for flow, maximum in profile_contract["maximum_counts"].items()
                        if component_counts.get(flow, 0) > maximum}
            if excesses:
                raise HTTPException(status_code=422, detail={
                    "message": "Flow 1 dataset exceeds its approved sample-volume range",
                    "maximum_samples": profile_contract["maximum_counts"],
                    "registered_samples": component_counts,
                    "excess_samples": excesses,
                })
        active = await self.repo.one("SELECT checkpoint_sha256 FROM public.viread_ocr_active_model WHERE singleton=TRUE FOR SHARE")
        if not active:
            raise HTTPException(status_code=503, detail="VietOCR active model registry is not initialized")
        if payload.parent_checkpoint_sha256 != active["checkpoint_sha256"]:
            raise HTTPException(status_code=409, detail="Active parent checkpoint changed; refresh the model pointer before training")
        if payload.vocabulary_sha256 != ORIGINAL_VOCAB_SHA256:
            raise HTTPException(status_code=422, detail="Candidate must keep the locked Original vocabulary")
        if payload.architecture_sha256 != ORIGINAL_ARCHITECTURE_SHA256:
            raise HTTPException(status_code=422, detail="Candidate must keep the locked Original architecture")
        run_id = uuid4()
        try:
            row = await self.repo.one("""
                INSERT INTO public.viread_ocr_training_runs
                    (id, profile, status, dataset_version_id, parent_checkpoint_sha256, manifest_sha256, config_sha256,
                     architecture_sha256, vocabulary_sha256, created_by)
                VALUES (:id, :profile, 'CREATED', :dataset_id, :parent_sha, :manifest_sha, :config_sha,
                        :architecture_sha, :vocabulary_sha, :actor_id)
                RETURNING id AS run_id, status, profile, parent_checkpoint_sha256, manifest_sha256,
                          config_sha256, architecture_sha256, vocabulary_sha256
            """, {"id": run_id, "profile": payload.profile, "dataset_id": payload.dataset_version_id,
                  "parent_sha": active["checkpoint_sha256"],
                  "manifest_sha": payload.manifest_sha256, "config_sha": payload.config_sha256,
                  "architecture_sha": payload.architecture_sha256, "vocabulary_sha": payload.vocabulary_sha256,
                  "actor_id": actor_id})
            await self.repo.commit()
            return row or {"run_id": run_id, "status": "CREATED", "profile": payload.profile}
        except Exception:
            await self.repo.rollback()
            raise

    async def upload_checkpoint_chunk(self, actor_id: UUID, run_id: UUID, chunk_index: int, data: bytes) -> dict[str, Any]:
        await self._admin(actor_id)
        if not data or len(data) > MAX_SHARD_BYTES:
            raise HTTPException(status_code=413, detail="Checkpoint shard must be between 1 byte and 40 MiB")
        run = await self.repo.one("SELECT id, status FROM public.viread_ocr_training_runs WHERE id=:id", {"id": run_id})
        if not run or run["status"] not in {"CREATED", "RUNNING"}:
            raise HTTPException(status_code=409, detail="Training run is not accepting checkpoint shards")
        digest = hashlib.sha256(data).hexdigest()
        existing = await self.repo.one("SELECT chunk_sha256, storage_path, byte_count FROM public.viread_ocr_checkpoint_chunks WHERE run_id=:run_id AND chunk_index=:chunk_index", {"run_id": run_id, "chunk_index": chunk_index})
        if existing:
            if existing["chunk_sha256"] == digest and existing["byte_count"] == len(data):
                return {"run_id": run_id, "chunk_index": chunk_index, "sha256": digest, "bytes": len(data), "idempotent": True}
            raise HTTPException(status_code=409, detail="Checkpoint shard index already contains different bytes")
        path = f"ocr-training/checkpoints/{run_id}/{chunk_index:04d}-{digest}.part"
        await ensure_storage_capacity(self.db, len(data), existing_object_path=path)
        await asyncio.to_thread(upload_object, path, data, "application/octet-stream", upsert=True)
        try:
            await self.repo.execute("""
                INSERT INTO public.viread_ocr_checkpoint_chunks (run_id, chunk_index, chunk_sha256, storage_path, byte_count)
                VALUES (:run_id, :chunk_index, :digest, :path, :byte_count)
            """, {"run_id": run_id, "chunk_index": chunk_index, "digest": digest, "path": path, "byte_count": len(data)})
            await self.repo.execute("UPDATE public.viread_ocr_training_runs SET status='RUNNING', updated_at=now() WHERE id=:id", {"id": run_id})
            await self.repo.commit()
        except Exception:
            await self.repo.rollback()
            raise
        return {"run_id": run_id, "chunk_index": chunk_index, "sha256": digest, "bytes": len(data), "idempotent": False}

    async def complete_run(self, actor_id: UUID, run_id: UUID, payload: TrainingRunComplete) -> dict[str, Any]:
        await self._admin(actor_id)
        run = await self.repo.one("SELECT * FROM public.viread_ocr_training_runs WHERE id=:id", {"id": run_id})
        if not run:
            raise HTTPException(status_code=409, detail="Training run cannot be completed")
        run_identity = (payload.profile, payload.parent_checkpoint_sha256, payload.manifest_sha256,
                        payload.config_sha256, payload.architecture_sha256, payload.vocabulary_sha256)
        expected_identity = (run["profile"], run["parent_checkpoint_sha256"], run["manifest_sha256"],
                             run["config_sha256"], run["architecture_sha256"], run["vocabulary_sha256"])
        if run_identity != expected_identity:
            raise HTTPException(status_code=422, detail="Completed checkpoint lineage does not match the registered training run")
        if (run["status"] == "CANDIDATE" and run["checkpoint_sha256"] == payload.checkpoint_sha256
                and int(run["checkpoint_bytes"]) == payload.checkpoint_bytes and int(run["step"]) == payload.step):
            return {"run_id": run_id, "status": "CANDIDATE", "checkpoint_sha256": payload.checkpoint_sha256,
                    "checkpoint_bytes": int(run["checkpoint_bytes"]), "manifest_storage_path": run["checkpoint_storage_path"],
                    "idempotent": True}
        if run["status"] not in {"CREATED", "RUNNING"}:
            raise HTTPException(status_code=409, detail="Training run cannot be completed")
        chunks = await self.repo.all("SELECT chunk_index, chunk_sha256, storage_path, byte_count FROM public.viread_ocr_checkpoint_chunks WHERE run_id=:run_id ORDER BY chunk_index", {"run_id": run_id})
        if not chunks or [int(chunk["chunk_index"]) for chunk in chunks] != list(range(len(chunks))):
            raise HTTPException(status_code=422, detail="Checkpoint shards are incomplete or out of order")
        digest = hashlib.sha256()
        total = 0
        for chunk in chunks:
            data = await asyncio.to_thread(download_object, chunk["storage_path"])
            if len(data) != int(chunk["byte_count"]) or hashlib.sha256(data).hexdigest() != chunk["chunk_sha256"]:
                raise HTTPException(status_code=422, detail="Stored checkpoint shard failed integrity verification")
            digest.update(data)
            total += len(data)
        if digest.hexdigest() != payload.checkpoint_sha256 or total != payload.checkpoint_bytes:
            raise HTTPException(status_code=422, detail="Reassembled candidate checkpoint does not match the registered hash or size")
        manifest = {"schema": "viread-checkpoint-shards-v1", "run_id": str(run_id),
                    "checkpoint_sha256": payload.checkpoint_sha256, "checkpoint_bytes": total,
                    "chunks": [{"index": int(chunk["chunk_index"]), "path": chunk["storage_path"],
                                "sha256": chunk["chunk_sha256"], "bytes": int(chunk["byte_count"])} for chunk in chunks]}
        manifest_path = f"ocr-training/checkpoints/{run_id}/checkpoint.manifest.json"
        manifest_bytes = _canonical(manifest)
        await ensure_storage_capacity(self.db, len(manifest_bytes), existing_object_path=manifest_path)
        await asyncio.to_thread(upload_object, manifest_path, manifest_bytes, "application/json", upsert=True)
        await self.repo.execute("""
            UPDATE public.viread_ocr_training_runs SET status='CANDIDATE', checkpoint_sha256=:sha,
                checkpoint_bytes=:bytes, checkpoint_storage_path=:path, step=:step,
                metadata = metadata || CAST(:metadata AS jsonb), updated_at=now()
            WHERE id=:run_id
        """, {"sha": payload.checkpoint_sha256, "bytes": total, "path": manifest_path,
              "step": payload.step, "metadata": json.dumps({"checkpoint_chunks": len(chunks)}), "run_id": run_id})
        await self.repo.commit()
        return {"run_id": run_id, "status": "CANDIDATE", "checkpoint_sha256": payload.checkpoint_sha256,
                "checkpoint_bytes": total, "manifest_storage_path": manifest_path, "chunk_count": len(chunks)}

    async def benchmark(self, actor_id: UUID, payload: BenchmarkCreate) -> dict[str, Any]:
        await self._admin(actor_id)
        run = await self.repo.one("SELECT id, status, checkpoint_sha256 FROM public.viread_ocr_training_runs WHERE id=:id", {"id": payload.run_id})
        locked = await self.repo.one("SELECT id, source_flow, version_sha256, is_locked_test, sample_count FROM public.viread_ocr_dataset_versions WHERE id=:id", {"id": payload.locked_test_version_id})
        if not run or run["status"] != "CANDIDATE" or not run["checkpoint_sha256"]:
            raise HTTPException(status_code=409, detail="Benchmark requires a completed candidate run")
        if not locked or locked["source_flow"] != "LOCKED_TEST" or not locked["is_locked_test"] or locked["version_sha256"] != payload.locked_test_manifest_sha256:
            raise HTTPException(status_code=422, detail="Locked Test version/hash is invalid")
        expected = await self.repo.all("""
            SELECT source_annotation_id AS sample_id, source_group_id AS group_id, label AS reference
            FROM public.viread_ocr_samples WHERE dataset_version_id=:dataset_id AND source_flow='LOCKED_TEST'
        """, {"dataset_id": payload.locked_test_version_id})
        by_id = {item["sample_id"]: item for item in expected}
        outputs = [item.model_dump() for item in payload.outputs]
        if len(outputs) != len(by_id) or {item["sample_id"] for item in outputs} != set(by_id):
            raise HTTPException(status_code=422, detail="Benchmark outputs must cover every Locked Test sample exactly once")
        paired = []
        for output in outputs:
            reference = by_id[output["sample_id"]]
            if output["group_id"] != reference["group_id"]:
                raise HTTPException(status_code=422, detail="Benchmark group ID does not match the sealed dataset")
            paired.append({"sample_id": output["sample_id"], "group_id": output["group_id"],
                           "reference": unicodedata.normalize("NFC", reference["reference"]),
                           "original": unicodedata.normalize("NFC", output["original"]),
                           "candidate": unicodedata.normalize("NFC", output["candidate"])})
        metrics = {"sample_count": len(paired), "group_count": len({item["group_id"] for item in paired}),
                   "cer": _paired_metric(paired, "cer"), "wer": _paired_metric(paired, "wer", seed=20261113),
                   "outputs": paired, "original_checkpoint_sha256": ORIGINAL_SHA256,
                   "candidate_checkpoint_sha256": run["checkpoint_sha256"],
                   "locked_test_manifest_sha256": locked["version_sha256"]}
        gate = _gate(metrics, manifest_sha=locked["version_sha256"])
        report_hash = hashlib.sha256(_canonical(paired)).hexdigest()
        await ensure_database_capacity(self.db, len(_canonical({**metrics, "quality_gate": gate})) + 4096)
        benchmark_id = uuid4()
        try:
            await self.repo.execute("""
                INSERT INTO public.viread_ocr_benchmarks
                    (id, run_id, baseline_checkpoint_sha256, candidate_checkpoint_sha256,
                     locked_test_version_id, locked_test_manifest_sha256, report_sha256,
                     gate_status, sample_count, group_count, metrics, created_by)
                VALUES (:id, :run_id, :baseline_sha, :candidate_sha, :test_id, :test_sha,
                        :report_sha, :gate, :samples, :groups, CAST(:metrics AS jsonb), :actor_id)
            """, {"id": benchmark_id, "run_id": payload.run_id, "baseline_sha": ORIGINAL_SHA256,
                  "candidate_sha": run["checkpoint_sha256"], "test_id": payload.locked_test_version_id,
                  "test_sha": locked["version_sha256"], "report_sha": report_hash, "gate": gate["status"],
                  "samples": len(paired), "groups": len({item["group_id"] for item in paired}),
                  "metrics": json.dumps({**metrics, "quality_gate": gate}, ensure_ascii=False), "actor_id": actor_id})
            await self.repo.execute("UPDATE public.viread_ocr_training_runs SET status='BENCHMARKED', updated_at=now() WHERE id=:id", {"id": payload.run_id})
            await self.repo.commit()
        except Exception:
            await self.repo.rollback()
            raise
        return {"benchmark_id": benchmark_id, "run_id": payload.run_id, "gate_status": gate["status"],
                "promotion_allowed": gate["promotion_allowed"], "sample_count": len(paired),
                "group_count": len({item["group_id"] for item in paired}), "report_sha256": report_hash,
                "metrics": {"cer": metrics["cer"], "wer": metrics["wer"]}, "quality_gate": gate}

    async def decide(self, actor_id: UUID, payload: ModelDecisionRequest) -> dict[str, Any]:
        await self._admin(actor_id)
        active = await self.repo.one("SELECT checkpoint_sha256, storage_path, profile, decision_id FROM public.viread_ocr_active_model WHERE singleton=TRUE FOR UPDATE")
        if not active:
            raise HTTPException(status_code=503, detail="Active model registry is not initialized")
        if payload.action == "APPROVE":
            if payload.run_id is None or payload.benchmark_id is None:
                raise HTTPException(status_code=422, detail="Approval requires both a candidate run and its Locked Test benchmark")
            run = await self.repo.one("SELECT id, profile, status, checkpoint_sha256, checkpoint_storage_path FROM public.viread_ocr_training_runs WHERE id=:id FOR UPDATE", {"id": payload.run_id})
            benchmark = await self.repo.one("SELECT id, run_id, candidate_checkpoint_sha256, gate_status FROM public.viread_ocr_benchmarks WHERE id=:id", {"id": payload.benchmark_id})
            if not run or not benchmark or run["status"] != "BENCHMARKED" or benchmark["run_id"] != run["id"] or benchmark["candidate_checkpoint_sha256"] != run["checkpoint_sha256"] or benchmark["gate_status"] != "V2_WIN":
                raise HTTPException(status_code=409, detail="Candidate has no passing paired Locked Test gate")
            if active["checkpoint_sha256"] == run["checkpoint_sha256"]:
                raise HTTPException(status_code=409, detail="Candidate is already the active model")
            next_sha, next_path, next_profile = run["checkpoint_sha256"], run["checkpoint_storage_path"], run["profile"]
            action_benchmark = payload.benchmark_id
        else:
            if active["profile"] == "ORIGINAL" or active["decision_id"] is None:
                raise HTTPException(status_code=409, detail="Original is already active; there is nothing to roll back")
            prior = await self.repo.one("SELECT action, candidate_checkpoint_sha256, previous_checkpoint_sha256, candidate_storage_path, previous_storage_path, candidate_profile, previous_profile FROM public.viread_ocr_model_decisions WHERE id=:id", {"id": active["decision_id"]})
            if not prior or prior["action"] != "APPROVE":
                raise HTTPException(status_code=409, detail="Rollback is only available from the latest approved V2 model")
            next_sha, next_path, next_profile = prior["previous_checkpoint_sha256"], prior["previous_storage_path"], prior["previous_profile"]
            action_benchmark = None
        decision_id = uuid4()
        try:
            await self.repo.execute("""
                INSERT INTO public.viread_ocr_model_decisions
                    (id, action, candidate_checkpoint_sha256, previous_checkpoint_sha256,
                     candidate_storage_path, previous_storage_path, candidate_profile,
                     previous_profile, benchmark_id, reason, actor_id)
                VALUES (:id, :action, :candidate_sha, :previous_sha, :candidate_path,
                        :previous_path, :candidate_profile, :previous_profile, :benchmark_id,
                        :reason, :actor_id)
            """, {"id": decision_id, "action": payload.action, "candidate_sha": next_sha,
                  "previous_sha": active["checkpoint_sha256"], "candidate_path": next_path,
                  "previous_path": active["storage_path"], "candidate_profile": next_profile,
                  "previous_profile": active["profile"], "benchmark_id": action_benchmark,
                  "reason": payload.reason.strip(), "actor_id": actor_id})
            await self.repo.execute("""
                UPDATE public.viread_ocr_active_model
                SET checkpoint_sha256=:sha, storage_path=:path, profile=:profile,
                    decision_id=:decision_id, updated_at=now()
                WHERE singleton=TRUE
            """, {"sha": next_sha, "path": next_path, "profile": next_profile, "decision_id": decision_id})
            await self.repo.commit()
        except Exception:
            await self.repo.rollback()
            raise
        return {"decision_id": decision_id, "action": payload.action,
                "active_model": {"checkpoint_sha256": next_sha, "storage_path": next_path,
                                 "profile": next_profile, "updated_at": datetime.now(timezone.utc)}}
