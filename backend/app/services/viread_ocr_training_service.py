from __future__ import annotations

import asyncio
import hashlib
import inspect
import json
import logging
import math
import os
import random
import re
import unicodedata
from collections import defaultdict
from datetime import datetime, timezone
from functools import lru_cache
from typing import Any
from urllib.parse import quote
from uuid import UUID, uuid4

import numpy as np
from fastapi import HTTPException
from PIL import Image, UnidentifiedImageError
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession
import yaml

from app.repositories.viread_ocr_training_repository import VireadOcrTrainingRepository
from app.schemas.viread_ocr_training import BenchmarkCreate, DatasetImport, DatasetSampleInput, ModelDecisionRequest, TrainingRunComplete, TrainingRunCreate
from app.services.admin_ocr_service import AdminOcrService
from app.services.storage_service import create_signed_image_url, delete_object, download_object, hash_storage_object, upload_object
from app.services.training_storage import (
    StorageProvider,
    TrainingArtifactStoreRouter,
    TrainingStorageError,
    drive_file_id_from_reference,
    flow2_storage_provider_setting,
    is_gdrive_ref,
    sign_worker_artifact_token,
    validate_logical_path,
)
from app.services.viread_drive_connection_service import VireadDriveConnectionService
from app.services.viread_flow2_hygiene import (
    normalize_typographic_for_vietocr,
    open_image_exif_safe,
    sanitize_and_validate_vietocr_label,
    validate_flow2_line_crop,
)
from app.services.viread_training_storage_quota import ensure_database_capacity, ensure_storage_capacity

logger = logging.getLogger(__name__)

_OVERVIEW_MANIFEST_CACHE: dict[tuple[str, str], dict[str, Any]] = {}


def invalidate_overview_manifest_cache() -> None:
    _OVERVIEW_MANIFEST_CACHE.clear()

ORIGINAL_SHA256 = "380512193a8b6cbf6fad80deacdc9b6939d10d473d199892fc6408d13775ea59"
ORIGINAL_VOCAB_SHA256 = "b4ec9437ef82d952a65c101ea7ec6748a7168777c2d84cdb6a1bba7540bd163d"
ORIGINAL_ARCHITECTURE_SHA256 = "a26f0adfc33ffe32cdf73c7daa04c39a86a36a8ac0dcc6047fe7a4d9b4fe6dc6"
MAX_SHARD_BYTES = 40 * 1024 * 1024
MIN_LOCKED_PAIRS = 200
MIN_LOCKED_GROUPS = 30
MIN_PILOT_PAIRS = 20
MIN_PILOT_GROUPS = 5
MAX_PILOT_PAIRS = 40
MAX_PILOT_PER_GROUP = 8
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


def _jsonl_bytes(rows: list[dict[str, Any]]) -> bytes:
    if not rows:
        return b""
    lines = [
        json.dumps(row, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
        for row in rows
    ]
    return ("\n".join(lines) + "\n").encode("utf-8")


def _is_flow2_profile(profile: str | None) -> bool:
    return str(profile or "") in {"FLOW2_ADMIN_VERIFIED", "FLOW1_VERIFIED"}


def _storage_http_error(exc: TrainingStorageError) -> HTTPException:
    return HTTPException(status_code=exc.http_status or 503, detail=f"{exc.code}: {exc}")


def _is_missing_column_error(exc: Exception) -> bool:
    msg = str(exc).lower()
    return ("column" in msg and "does not exist" in msg) or "undefinedcolumn" in msg


def _sha(value: str) -> bool:
    return len(value) == 64 and all(char in "0123456789abcdef" for char in value.lower())


def _deduplicate_verified_samples(samples: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Keep one crop per image hash and reject conflicting verified labels.

    If the same image was assigned to more than one split, retain the strongest
    evaluation split (holdout, then validation) to prevent evaluation leakage.
    """
    by_hash: dict[str, dict[str, Any]] = {}

    def selection_key(item: dict[str, Any]) -> tuple[int, str]:
        # Holdout then validation win on duplicate pixels. The sample id tie-breaker
        # makes the canonical row independent of query/input order.
        split_priority = {"holdout": 0, "validation": 1, "train": 2}.get(
            str(item.get("split", "")), 3
        )
        return split_priority, str(item.get("sample_id", ""))

    for item in sorted(samples, key=selection_key):
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
        "snapshot_strategy": "cumulative-deduplicated-v3-split-safe",
        "samples": manifest_samples,
    }
    return manifest, samples


def _canonicalize_legacy_verified_snapshot(
    source_rows: list[dict[str, Any]],
) -> tuple[bool, dict[str, Any], list[dict[str, Any]]]:
    """Return a deduplicated snapshot only when a legacy immutable version needs repair."""
    manifest, canonical_rows = _verified_snapshot(source_rows)
    if len(canonical_rows) == len(source_rows):
        return False, manifest, canonical_rows

    group_splits: dict[str, str] = {}
    for row in source_rows:
        group_id, split = str(row["group_id"]), str(row["split"])
        previous_split = group_splits.setdefault(group_id, split)
        if previous_split != split:
            raise HTTPException(
                status_code=409,
                detail="Verified dataset group appears in multiple splits; refusing to rebuild its snapshot",
            )
    return True, manifest, canonical_rows


def _verified_training_split(group_id: str) -> str:
    """Assign one deterministic Train/Validation split to a whole source document."""
    value = int(hashlib.sha256(
        f"viread-vietocr-v2-document-split-v1\0{group_id}".encode()
    ).hexdigest()[:8], 16) / 0xFFFFFFFF
    return "train" if value < 0.8 else "validation"


def _assign_leak_safe_splits(source_rows: list[dict[str, Any]]) -> None:
    """Assign deterministic Train/Validation splits while clustering exact and near-duplicate
    content across different source groups (e.g. same book/page submitted by two families)
    into the same split so duplicate content can never leak across train and validation."""
    if not source_rows:
        return
    parent: dict[str, str] = {}

    def find(key: str) -> str:
        root = parent.setdefault(key, key)
        while parent[root] != root:
            parent[root] = parent[parent[root]]
            root = parent[root]
        return root

    def union(a: str, b: str) -> None:
        ra, rb = find(a), find(b)
        if ra != rb:
            if ra < rb:
                parent[rb] = ra
            else:
                parent[ra] = rb

    # Pre-scan near-duplicate long labels so boilerplate headings shared by >3 books
    # never collapse unrelated document groups into one mega-cluster.
    label_groups: dict[str, set[str]] = defaultdict(set)
    row_text_keys: list[str | None] = []
    for row in source_rows:
        norm_label = " ".join(
            normalize_typographic_for_vietocr(unicodedata.normalize("NFC", str(row.get("label") or ""))).lower().split()
        )
        if len(norm_label) >= 24:
            t_key = f"t:{hashlib.sha256(norm_label.encode('utf-8')).hexdigest()}"
            label_groups[t_key].add(str(row["group_id"]))
            row_text_keys.append(t_key)
        else:
            row_text_keys.append(None)

    for row, t_key in zip(source_rows, row_text_keys, strict=True):
        g_key = f"g:{row['group_id']}"
        h_key = f"h:{str(row['image_sha256']).lower()}"
        union(g_key, h_key)
        if t_key is not None and 2 <= len(label_groups[t_key]) <= 3:
            union(g_key, t_key)

    # Determine canonical cluster key (smallest raw group_id in each connected component)
    cluster_min_group: dict[str, str] = {}
    cluster_sizes: dict[str, int] = defaultdict(int)
    for row in source_rows:
        root = find(f"g:{row['group_id']}")
        gid = str(row["group_id"])
        cluster_sizes[root] += 1
        if root not in cluster_min_group or gid < cluster_min_group[root]:
            cluster_min_group[root] = gid

    cluster_split = {
        root: _verified_training_split(canonical_group)
        for root, canonical_group in cluster_min_group.items()
    }
    if len(cluster_split) >= 2:
        train_roots = [r for r, sp in cluster_split.items() if sp == "train"]
        val_roots = [r for r, sp in cluster_split.items() if sp == "validation"]
        if not val_roots:
            # Deterministic fallback: move smallest cluster(s) (~20%, >=1) into validation
            # without splitting any cluster across train/validation.
            ordered = sorted(train_roots, key=lambda r: (cluster_sizes[r], cluster_min_group[r]))
            target_val = max(1, len(ordered) // 5)
            for r in ordered[:target_val]:
                cluster_split[r] = "validation"
        elif not train_roots:
            ordered = sorted(val_roots, key=lambda r: (cluster_sizes[r], cluster_min_group[r]), reverse=True)
            cluster_split[ordered[0]] = "train"

    for row in source_rows:
        root = find(f"g:{row['group_id']}")
        row["split"] = cluster_split[root]


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


@lru_cache(maxsize=4096)
def _normalize_metric_text(value: str) -> str:
    return normalize_typographic_for_vietocr(unicodedata.normalize("NFC", value))


@lru_cache(maxsize=4096)
def _cached_edit_distance(left: str | tuple[str, ...], right: str | tuple[str, ...]) -> int:
    if left == right:
        return 0
    len_l = len(left)
    len_r = len(right)
    min_len = len_l if len_l < len_r else len_r
    start = 0
    while start < min_len and left[start] == right[start]:
        start += 1
    end_l = len_l
    end_r = len_r
    while end_l > start and end_r > start and left[end_l - 1] == right[end_r - 1]:
        end_l -= 1
        end_r -= 1
    left = left[start:end_l]
    right = right[start:end_r]
    if not left:
        return len(right)
    if not right:
        return len(left)
    if len(left) < len(right):
        left, right = right, left
    # Myers' bit-parallel exact Levenshtein distance (O(len(left)) integer ops).
    m = len(right)
    peq: dict[str, int] = {}
    for idx, token in enumerate(right):
        peq[token] = peq.get(token, 0) | (1 << idx)
    mask = (1 << m) - 1
    pv = mask
    mv = 0
    score = m
    high_bit = 1 << (m - 1)
    for token in left:
        eq = peq.get(token, 0)
        xv = eq | mv
        xh = ((((eq & pv) + pv) ^ pv) | eq) & mask
        ph = (mv | (~(xh | pv) & mask)) & mask
        mh = pv & xh
        if ph & high_bit:
            score += 1
        elif mh & high_bit:
            score -= 1
        ph = ((ph << 1) | 1) & mask
        mh = (mh << 1) & mask
        pv = (mh | (~(xv | ph) & mask)) & mask
        mv = ph & xv
    return score


def _edit_distance(left: list[str] | str, right: list[str] | str) -> int:
    key_l = left if isinstance(left, str) else tuple(left)
    key_r = right if isinstance(right, str) else tuple(right)
    return _cached_edit_distance(key_l, key_r)


def _metric_counts(lines: list[dict[str, str]], field: str, metric: str) -> tuple[int, int]:
    errors = units = 0
    is_cer = metric == "cer"
    for line in lines:
        ref_norm = _normalize_metric_text(line["reference"])
        hyp_norm = _normalize_metric_text(line[field])
        if is_cer:
            errors += _cached_edit_distance(ref_norm, hyp_norm)
            units += len(ref_norm)
        else:
            ref_words = tuple(ref_norm.split())
            errors += _cached_edit_distance(ref_words, tuple(hyp_norm.split()))
            units += len(ref_words)
    return errors, units


def _group_paired_counts(lines: list[dict[str, str]], baseline: str, metric: str) -> tuple[int, int, int]:
    base_errors = cand_errors = units = 0
    is_cer = metric == "cer"
    for line in lines:
        ref_norm = _normalize_metric_text(line["reference"])
        base_norm = _normalize_metric_text(line[baseline])
        cand_norm = _normalize_metric_text(line["candidate"])
        if is_cer:
            base_errors += _cached_edit_distance(ref_norm, base_norm)
            cand_errors += _cached_edit_distance(ref_norm, cand_norm)
            units += len(ref_norm)
        else:
            ref_words = tuple(ref_norm.split())
            base_errors += _cached_edit_distance(ref_words, tuple(base_norm.split()))
            cand_errors += _cached_edit_distance(ref_words, tuple(cand_norm.split()))
            units += len(ref_words)
    return base_errors, cand_errors, units


@lru_cache(maxsize=16)
def _bootstrap_cluster_counts(n_groups: int, replicates: int, seed: int) -> np.ndarray:
    """Precompute exact cluster draw counts matching Random(seed).randrange(n_groups)."""
    rng = random.Random(seed)
    getrandbits = rng.getrandbits
    k = n_groups.bit_length()
    draws: list[int] = []
    append = draws.append
    for _ in range(replicates * n_groups):
        r = getrandbits(k)
        while r >= n_groups:
            r = getrandbits(k)
        append(r)
    idx = np.asarray(draws, dtype=np.int32).reshape(replicates, n_groups)
    counts = np.zeros((replicates, n_groups), dtype=np.int64)
    np.add.at(counts, (np.arange(replicates)[:, None], idx), 1)
    counts.setflags(write=False)
    return counts


def _paired_metric(lines: list[dict[str, str]], metric: str, *, baseline: str = "original",
                   replicates: int = 5000, seed: int = 20261112) -> dict[str, Any]:
    groups: dict[str, list[dict[str, str]]] = defaultdict(list)
    for line in lines:
        groups[line["group_id"]].append(line)
    names = sorted(groups)
    group_stats: list[tuple[int, int, int]] = []
    original_errors = 0
    candidate_errors = 0
    units = 0
    for name in names:
        base_err, cand_err, group_units = _group_paired_counts(groups[name], baseline, metric)
        group_stats.append((base_err, cand_err, group_units))
        original_errors += base_err
        candidate_errors += cand_err
        units += group_units
    if units <= 0:
        raise ValueError("benchmark reference units are empty")
    n_groups = len(group_stats)
    counts = _bootstrap_cluster_counts(n_groups, replicates, seed)
    totals = counts @ np.asarray(group_stats, dtype=np.int64)
    base_units = totals[:, 2]
    valid = base_units > 0
    if np.any(valid):
        valid_units = base_units[valid]
        deltas_arr = totals[valid, 1] / valid_units - totals[valid, 0] / valid_units
        deltas_arr.sort()
        n_deltas = int(deltas_arr.shape[0])
        ci_low = float(deltas_arr[math.floor(0.025 * (n_deltas - 1))])
        ci_high = float(deltas_arr[math.ceil(0.975 * (n_deltas - 1))])
    else:
        fallback_delta = candidate_errors / units - original_errors / units
        ci_low = fallback_delta
        ci_high = fallback_delta
    delta = candidate_errors / units - original_errors / units
    return {"metric": metric, f"{baseline}_error_count": original_errors,
            "candidate_error_count": candidate_errors, "reference_unit_count": units,
            f"{baseline}_rate": original_errors / units, "candidate_rate": candidate_errors / units,
            f"delta_candidate_minus_{baseline}": delta,
            f"paired_cluster_bootstrap_95ci_candidate_minus_{baseline}": [ci_low, ci_high],
            "bootstrap_replicates": replicates, "cluster_count": n_groups, "seed": seed,
            **({"delta_candidate_minus_original": delta,
               "paired_cluster_bootstrap_95ci": [ci_low, ci_high]}
               if baseline == "original" else {})}


def _gate(metrics: dict[str, Any], *, manifest_sha: str, evaluation_type: str = "PRODUCTION",
          require_model_baselines: bool = False) -> dict[str, Any]:
    sample_count = len(metrics.get("outputs", []))
    group_count = len({item["group_id"] for item in metrics.get("outputs", [])})
    if evaluation_type == "PILOT":
        return {"status": "INSUFFICIENT_EVIDENCE", "promotion_allowed": False,
                "reason": "pilot_is_advisory_and_never_promotable",
                "sample_count": sample_count, "group_count": group_count,
                "locked_test_manifest_sha256": manifest_sha,
                "failing_checks": []}
    if sample_count < MIN_LOCKED_PAIRS or group_count < MIN_LOCKED_GROUPS:
        return {"status": "INSUFFICIENT_EVIDENCE", "promotion_allowed": False,
                "reason": "minimum_locked_test_size_not_met",
                "failing_checks": []}
    baselines = ["original"]
    for baseline in ("parent", "active"):
        if f"{baseline}_cer" in metrics or f"{baseline}_wer" in metrics:
            baselines.append(baseline)
    if require_model_baselines and not {"parent", "active"}.issubset(baselines):
        return {"status": "EVALUATION_FAILED", "promotion_allowed": False,
                "reason": "parent_and_active_baselines_required",
                "failing_checks": []}
    if any((f"{baseline}_cer" in metrics) != (f"{baseline}_wer" in metrics)
           for baseline in ("parent", "active")):
        return {"status": "EVALUATION_FAILED", "promotion_allowed": False,
                "reason": "incomplete_model_baseline_metrics",
                "failing_checks": []}
    comparisons = [(baseline, metrics["cer"] if baseline == "original" else metrics[f"{baseline}_cer"],
                    metrics["wer"] if baseline == "original" else metrics[f"{baseline}_wer"])
                   for baseline in baselines]
    failing_checks: list[dict[str, Any]] = []
    non_regression_exceeded = False
    favors_original = False
    for baseline, cer, wer in comparisons:
        for metric_name, result in (("cer", cer), ("wer", wer)):
            rate_key = f"{baseline}_rate"
            if not math.isfinite(float(result["candidate_rate"])) or not math.isfinite(float(result[rate_key])):
                return {"status": "EVALUATION_FAILED", "promotion_allowed": False,
                        "reason": "non_finite_metric", "failing_checks": []}
            interval = result.get(f"paired_cluster_bootstrap_95ci_candidate_minus_{baseline}")
            delta_key = f"delta_candidate_minus_{baseline}"
            if (not isinstance(interval, list) or len(interval) != 2
                    or any(not math.isfinite(float(value)) or not -1 <= float(value) <= 1 for value in interval)
                    or not math.isfinite(float(result[delta_key]))):
                return {"status": "EVALUATION_FAILED", "promotion_allowed": False,
                        "reason": "invalid_paired_confidence_interval", "failing_checks": []}
            delta_val = float(result[delta_key])
            ci_low, ci_high = float(interval[0]), float(interval[1])
            if delta_val > 0.005:
                non_regression_exceeded = True
            if ci_low > 0:
                favors_original = True
            if delta_val > 0.005 or ci_high >= 0:
                failing_checks.append({
                    "baseline": baseline,
                    "metric": metric_name,
                    "delta": delta_val,
                    "ci95": [ci_low, ci_high],
                })
    if non_regression_exceeded:
        return {"status": "ORIGINAL_WIN", "promotion_allowed": False,
                "reason": "non_regression_limit_exceeded",
                "failing_checks": failing_checks}
    if not failing_checks:
        return {"status": "V2_WIN", "promotion_allowed": True, "requires_human_approval": True,
                "reason": "paired_cluster_confidence_intervals_favor_candidate_against_all_baselines",
                "locked_test_manifest_sha256": manifest_sha}
    if favors_original:
        return {"status": "ORIGINAL_WIN", "promotion_allowed": False,
                "reason": "paired_cluster_confidence_interval_favors_original",
                "failing_checks": failing_checks}
    return {"status": "NO_SIGNIFICANT_DIFFERENCE", "promotion_allowed": False,
            "reason": "paired_cluster_confidence_intervals_include_zero",
            "failing_checks": failing_checks}


class VireadOcrTrainingService:
    def __init__(self, db: AsyncSession):
        self.db = db
        self.repo = VireadOcrTrainingRepository(db)

    async def _admin(self, actor_id: UUID) -> None:
        await AdminOcrService(self.db).require_admin(actor_id)

    async def _artifact_router(
        self,
        *,
        write_provider: StorageProvider | None = None,
    ) -> TrainingArtifactStoreRouter:
        target = write_provider or flow2_storage_provider_setting()
        if not hasattr(self.db, "execute"):
            return TrainingArtifactStoreRouter(write_provider=target)
        return await VireadDriveConnectionService(self.db).build_artifact_router(
            write_provider=target,
        )

    async def _exec_optional_column_update(self, sql: str, params: Any) -> None:
        """Execute an additive-column UPDATE inside a SAVEPOINT so pre-migration DBs never abort."""
        if not hasattr(self.db, "execute"):
            return
        try:
            if hasattr(self.db, "begin_nested"):
                async with self.db.begin_nested():
                    await self.repo.execute(sql, params)
            else:
                await self.repo.execute(sql, params)
        except Exception as exc:
            if not _is_missing_column_error(exc):
                raise

    async def _read_artifact_bytes(
        self,
        reference: str,
        *,
        expected_sha256: str | None = None,
        max_bytes: int | None = None,
        router: TrainingArtifactStoreRouter | None = None,
    ) -> bytes:
        if is_gdrive_ref(reference):
            active_router = router if router is not None else await self._artifact_router()
            try:
                return await asyncio.to_thread(
                    active_router.get,
                    reference,
                    expected_sha256=expected_sha256,
                    max_bytes=max_bytes,
                )
            except TrainingStorageError as exc:
                raise _storage_http_error(exc) from exc
        return await asyncio.to_thread(download_object, reference)

    async def _hash_artifact_stream(
        self,
        reference: str,
        aggregate: Any | None = None,
        *,
        router: TrainingArtifactStoreRouter | None = None,
    ) -> tuple[str, int]:
        if is_gdrive_ref(reference):
            if router is None:
                router = await self._artifact_router()
                await self._release_read_txn()

            def _stream_hash() -> tuple[str, int]:
                chunk_digest = hashlib.sha256()
                byte_count = 0
                for block in router.open_stream(reference):
                    chunk_digest.update(block)
                    if aggregate is not None:
                        aggregate.update(block)
                    byte_count += len(block)
                return chunk_digest.hexdigest(), byte_count

            try:
                return await asyncio.to_thread(_stream_hash)
            except TrainingStorageError as exc:
                raise _storage_http_error(exc) from exc
            except (ValueError, KeyError) as exc:
                raise _storage_http_error(
                    TrainingStorageError(
                        f"Unexpected Drive bridge error while streaming checkpoint shard: {exc}",
                        code="DRIVE_BRIDGE_RESPONSE_INVALID",
                        http_status=502,
                    )
                ) from exc
        return await asyncio.to_thread(hash_storage_object, reference, aggregate)

    async def _release_read_txn(self) -> None:
        rollback = getattr(self.repo, "rollback", None)
        if callable(rollback):
            try:
                res = rollback()
                if inspect.isawaitable(res):
                    await res
            except Exception:
                pass

    def _artifact_download_url(
        self,
        reference: str,
        *,
        expected_sha256: str | None = None,
        job_id: UUID | None = None,
        worker_id: str | None = None,
    ) -> str | None:
        if is_gdrive_ref(reference):
            if job_id is not None and worker_id:
                token = sign_worker_artifact_token(
                    job_id=str(job_id),
                    worker_id=worker_id,
                    reference=reference,
                    expected_sha256=expected_sha256,
                )
                return (
                    f"/books/admin/viread-training/worker/jobs/{job_id}/artifact-stream"
                    f"?worker_id={quote(worker_id, safe='')}&token={quote(token, safe='')}"
                )
            return None
        return create_signed_image_url(reference)

    async def _artifact_download_url_async(
        self,
        reference: str,
        *,
        expected_sha256: str | None = None,
        job_id: UUID | None = None,
        worker_id: str | None = None,
    ) -> str | None:
        return await asyncio.to_thread(
            self._artifact_download_url,
            reference,
            expected_sha256=expected_sha256,
            job_id=job_id,
            worker_id=worker_id,
        )

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
            SELECT job.id AS job_id, job.profile, job.target, job.status, job.dataset_version_id,
                   job.manifest_sha256, job.config_sha256, job.parent_checkpoint_sha256, job.run_id,
                   training_run.status AS run_status, training_run.config_sha256 AS run_config_sha256,
                   job.generation,
                   EXISTS (SELECT 1 FROM public.viread_ocr_benchmarks benchmark WHERE benchmark.run_id=job.run_id)
                       AS candidate_has_benchmark,
                   job.attempts, job.evaluation_attempts, job.progress, job.last_error_code,
                   job.metadata, job.colab_execution_id, job.colab_execution_resource_name,
                   job.colab_operation_name, job.colab_execution_number,
                   job.worker_id, job.lease_expires_at,
                   job.locked_test_version_id, job.locked_test_manifest_sha256,
                   job.created_at, job.updated_at
            FROM public.viread_ocr_training_jobs AS job
            LEFT JOIN public.viread_ocr_training_runs AS training_run ON training_run.id=job.run_id
            ORDER BY job.created_at DESC LIMIT 30
        """)
        benchmarks = await self.repo.all("""
            SELECT id AS benchmark_id, run_id, gate_status, sample_count, group_count,
                   candidate_checkpoint_sha256, locked_test_manifest_sha256, evaluation_type, created_at
            FROM public.viread_ocr_benchmarks ORDER BY created_at DESC LIMIT 20
        """)
        active = await self.repo.one("SELECT model_family, checkpoint_sha256, storage_path, profile, decision_id, updated_at FROM public.viread_ocr_active_model WHERE singleton = TRUE")
        if active:
            active["storage_provider"] = (
                StorageProvider.GOOGLE_DRIVE.value
                if is_gdrive_ref(active.get("storage_path"))
                else StorageProvider.SUPABASE_LEGACY.value
            )
            active["drive_file_id"] = drive_file_id_from_reference(active.get("storage_path"))
            if not active.get("storage_path") or active.get("profile") == "ORIGINAL":
                active["version_label"] = None
                active["weights_filename"] = None
                active["config_source"] = "original_default"
                active["config_filename"] = None
                active["comparison_summary"] = None
                active["source"] = "original_default"
            else:
                cache_key = (str(active.get("checkpoint_sha256")), str(active.get("storage_path")))
                cached_meta = _OVERVIEW_MANIFEST_CACHE.get(cache_key)
                if cached_meta is None:
                    try:
                        active_router = (
                            await self._artifact_router()
                            if is_gdrive_ref(active["storage_path"])
                            else None
                        )
                        await self._release_read_txn()
                        m_bytes = await self._read_artifact_bytes(
                            active["storage_path"],
                            router=active_router,
                        )
                        m_json = json.loads(m_bytes.decode("utf-8"))
                        m_info = m_json.get("model_info", {})
                        cached_meta = {
                            "version_label": m_info.get("version_label"),
                            "weights_filename": m_info.get("weights_filename"),
                            "config_source": m_info.get("config_source", "custom_yaml" if m_json.get("config") else "default_vgg_transformer"),
                            "config_filename": m_info.get("config_filename") or (m_json.get("config", {}).get("filename") if m_json.get("config") else None),
                            "comparison_summary": m_json.get("comparison_summary"),
                            "source": m_json.get("source"),
                        }
                        _OVERVIEW_MANIFEST_CACHE[cache_key] = cached_meta
                    except Exception as exc:
                        logger.warning("Could not read active model manifest metadata: %s", exc)
                        cached_meta = {
                            "version_label": None,
                            "weights_filename": None,
                            "config_source": "default_vgg_transformer",
                            "config_filename": None,
                            "comparison_summary": None,
                            "source": None,
                        }
                active.update(cached_meta)
        locked_test = await self._locked_test_readiness()
        google_drive = (
            await VireadDriveConnectionService(self.db).get_status()
            if hasattr(self.db, "execute")
            else None
        )
        from app.services.ocr_inference_job_service import (
            is_remote_ocr_mode,
            worker_heartbeat_ttl_seconds,
        )

        if is_remote_ocr_mode():
            loaded_runtime = {
                "initialized": False,
                "initialization_status": "worker_offline",
                "initialization_error": None,
                "loaded_profile": None,
                "loaded_checkpoint_sha256": None,
                "loaded_config_sha256": None,
                "verified_runtime_proof": False,
                "remote_worker_online": False,
                "remote_worker_id": None,
            }
            if hasattr(self.db, "execute"):
                try:
                    from app.repositories.ocr_inference_job_repository import (
                        OcrInferenceJobRepository,
                    )

                    now_utc = datetime.now(timezone.utc)
                    ttl = timedelta(seconds=worker_heartbeat_ttl_seconds())
                    workers = await OcrInferenceJobRepository(self.db).list_worker_heartbeats(
                        limit=20
                    )
                    for w in workers:
                        if w.LastHeartbeatAt is None:
                            continue
                        hb_at = (
                            w.LastHeartbeatAt
                            if w.LastHeartbeatAt.tzinfo is not None
                            else w.LastHeartbeatAt.replace(tzinfo=timezone.utc)
                        )
                        if (now_utc - hb_at) <= ttl and str(w.Status or "").upper() != "OFFLINE":
                            engines_map = dict(w.Engines or {})
                            viet_info = (
                                engines_map.get("vietocr")
                                if isinstance(engines_map.get("vietocr"), dict)
                                else {}
                            )
                            is_init = bool(
                                w.ModelSha256
                                or viet_info.get("loaded")
                                or viet_info.get("inference_verified")
                            )
                            loaded_runtime = {
                                "initialized": is_init,
                                "initialization_status": "success" if is_init else "not_initialized",
                                "initialization_error": w.LastError,
                                "loaded_profile": w.ModelProfile,
                                "loaded_checkpoint_sha256": w.ModelSha256,
                                "loaded_config_sha256": None,
                                "verified_runtime_proof": bool(w.ModelSha256),
                                "remote_worker_online": True,
                                "remote_worker_id": w.WorkerId,
                            }
                            break
                except Exception as exc:
                    logger.warning(
                        "Could not read remote OCR worker heartbeats for runtime status: %s",
                        type(exc).__name__,
                    )
        else:
            from app.services.ocr_engine import get_loaded_vietocr_runtime_status

            loaded_runtime = get_loaded_vietocr_runtime_status()
        desired_sha = active.get("checkpoint_sha256") if active else ORIGINAL_SHA256
        desired_profile = active.get("profile") if active else "ORIGINAL"
        loaded_sha = loaded_runtime.get("loaded_checkpoint_sha256")
        loaded_profile = loaded_runtime.get("loaded_profile")
        initialized = bool(loaded_runtime.get("initialized"))
        if not initialized:
            runtime_state = "NOT_INITIALIZED_YET"
            matches_desired = True
        elif loaded_sha == desired_sha and loaded_profile == desired_profile:
            runtime_state = "MATCHED"
            matches_desired = True
        elif loaded_profile == "ORIGINAL" and desired_profile != "ORIGINAL":
            runtime_state = "FALLBACK_TO_ORIGINAL"
            matches_desired = False
        else:
            runtime_state = "MISMATCH_STALE_MODEL"
            matches_desired = False
        runtime_model = {
            **loaded_runtime,
            "desired_profile": desired_profile,
            "desired_checkpoint_sha256": desired_sha,
            "matches_desired": matches_desired,
            "status_label": runtime_state,
        }

        flow2_drive_count = 0
        flow2_legacy_count = 0
        flow2_total_count = 0
        flow2_train_count = 0
        flow2_validation_count = 0
        flow2_holdout_count = 0
        flow2_pending_verification_count = 0
        flow2_excluded_count = 0
        try:
            flow2_stats = await self.repo.one("""
                SELECT count(DISTINCT s.image_sha256) FILTER (
                           WHERE COALESCE(to_jsonb(s)->>'training_eligibility', 'ELIGIBLE') = 'ELIGIBLE'
                             AND s.provenance->>'verified_by_admin' = 'true'
                             AND COALESCE(s.provenance->>'ai_review_required', 'false') <> 'true'
                             AND COALESCE(s.provenance->>'verification_source', 'admin') = 'admin'
                             AND COALESCE(to_jsonb(b)->>'is_deleted', 'false') <> 'true'
                             AND COALESCE(to_jsonb(b)->>'lifecyclestatus', 'ACTIVE') = 'ACTIVE'
                             AND COALESCE(to_jsonb(p)->>'lifecyclestatus', 'ACTIVE') = 'ACTIVE'
                             AND (
                                 p.id IS NULL
                                 OR NULLIF(to_jsonb(p)->>'currentverifiedrevisionid', '') IS NULL
                                 OR (to_jsonb(p)->>'currentverifiedrevisionid') = s.source_revision_id::text
                             )
                       )::integer AS total_verified_count,
                       count(DISTINCT s.image_sha256) FILTER (
                           WHERE COALESCE(to_jsonb(s)->>'training_eligibility', 'ELIGIBLE') = 'ELIGIBLE'
                             AND s.provenance->>'verified_by_admin' = 'true'
                             AND COALESCE(s.provenance->>'ai_review_required', 'false') <> 'true'
                             AND COALESCE(s.provenance->>'verification_source', 'admin') = 'admin'
                             AND COALESCE(to_jsonb(b)->>'is_deleted', 'false') <> 'true'
                             AND COALESCE(to_jsonb(b)->>'lifecyclestatus', 'ACTIVE') = 'ACTIVE'
                             AND COALESCE(to_jsonb(p)->>'lifecyclestatus', 'ACTIVE') = 'ACTIVE'
                             AND (
                                 p.id IS NULL
                                 OR NULLIF(to_jsonb(p)->>'currentverifiedrevisionid', '') IS NULL
                                 OR (to_jsonb(p)->>'currentverifiedrevisionid') = s.source_revision_id::text
                             )
                             AND s.image_storage_path LIKE 'gdrive://%'
                       )::integer AS drive_synced_count,
                       count(DISTINCT s.image_sha256) FILTER (
                           WHERE COALESCE(to_jsonb(s)->>'training_eligibility', 'ELIGIBLE') = 'ELIGIBLE'
                             AND s.provenance->>'verified_by_admin' = 'true'
                             AND COALESCE(s.provenance->>'ai_review_required', 'false') <> 'true'
                             AND COALESCE(s.provenance->>'verification_source', 'admin') = 'admin'
                             AND COALESCE(to_jsonb(b)->>'is_deleted', 'false') <> 'true'
                             AND COALESCE(to_jsonb(b)->>'lifecyclestatus', 'ACTIVE') = 'ACTIVE'
                             AND COALESCE(to_jsonb(p)->>'lifecyclestatus', 'ACTIVE') = 'ACTIVE'
                             AND (
                                 p.id IS NULL
                                 OR NULLIF(to_jsonb(p)->>'currentverifiedrevisionid', '') IS NULL
                                 OR (to_jsonb(p)->>'currentverifiedrevisionid') = s.source_revision_id::text
                             )
                             AND s.image_storage_path NOT LIKE 'gdrive://%'
                       )::integer AS legacy_count,
                       count(DISTINCT s.image_sha256) FILTER (
                           WHERE COALESCE(to_jsonb(s)->>'training_eligibility', 'ELIGIBLE') = 'ELIGIBLE'
                             AND s.provenance->>'verified_by_admin' = 'true'
                             AND COALESCE(s.provenance->>'ai_review_required', 'false') <> 'true'
                             AND COALESCE(s.provenance->>'verification_source', 'admin') = 'admin'
                             AND COALESCE(to_jsonb(b)->>'is_deleted', 'false') <> 'true'
                             AND COALESCE(to_jsonb(b)->>'lifecyclestatus', 'ACTIVE') = 'ACTIVE'
                             AND COALESCE(to_jsonb(p)->>'lifecyclestatus', 'ACTIVE') = 'ACTIVE'
                             AND (
                                 p.id IS NULL
                                 OR NULLIF(to_jsonb(p)->>'currentverifiedrevisionid', '') IS NULL
                                 OR (to_jsonb(p)->>'currentverifiedrevisionid') = s.source_revision_id::text
                             )
                             AND s.split = 'train'
                       )::integer AS train_count,
                       count(DISTINCT s.image_sha256) FILTER (
                           WHERE COALESCE(to_jsonb(s)->>'training_eligibility', 'ELIGIBLE') = 'ELIGIBLE'
                             AND s.provenance->>'verified_by_admin' = 'true'
                             AND COALESCE(s.provenance->>'ai_review_required', 'false') <> 'true'
                             AND COALESCE(s.provenance->>'verification_source', 'admin') = 'admin'
                             AND COALESCE(to_jsonb(b)->>'is_deleted', 'false') <> 'true'
                             AND COALESCE(to_jsonb(b)->>'lifecyclestatus', 'ACTIVE') = 'ACTIVE'
                             AND COALESCE(to_jsonb(p)->>'lifecyclestatus', 'ACTIVE') = 'ACTIVE'
                             AND (
                                 p.id IS NULL
                                 OR NULLIF(to_jsonb(p)->>'currentverifiedrevisionid', '') IS NULL
                                 OR (to_jsonb(p)->>'currentverifiedrevisionid') = s.source_revision_id::text
                             )
                             AND s.split = 'validation'
                       )::integer AS validation_count,
                       count(DISTINCT s.image_sha256) FILTER (
                           WHERE COALESCE(to_jsonb(s)->>'training_eligibility', 'ELIGIBLE') = 'ELIGIBLE'
                             AND s.provenance->>'verified_by_admin' = 'true'
                             AND COALESCE(s.provenance->>'ai_review_required', 'false') <> 'true'
                             AND COALESCE(s.provenance->>'verification_source', 'admin') = 'admin'
                             AND COALESCE(to_jsonb(b)->>'is_deleted', 'false') <> 'true'
                             AND COALESCE(to_jsonb(b)->>'lifecyclestatus', 'ACTIVE') = 'ACTIVE'
                             AND COALESCE(to_jsonb(p)->>'lifecyclestatus', 'ACTIVE') = 'ACTIVE'
                             AND (
                                 p.id IS NULL
                                 OR NULLIF(to_jsonb(p)->>'currentverifiedrevisionid', '') IS NULL
                                 OR (to_jsonb(p)->>'currentverifiedrevisionid') = s.source_revision_id::text
                             )
                             AND s.split = 'holdout'
                       )::integer AS holdout_count,
                       count(DISTINCT s.image_sha256) FILTER (
                           WHERE COALESCE(to_jsonb(s)->>'training_eligibility', 'ELIGIBLE') = 'ELIGIBLE'
                             AND NOT (
                                 s.provenance->>'verified_by_admin' = 'true'
                                 AND COALESCE(s.provenance->>'ai_review_required', 'false') <> 'true'
                                 AND COALESCE(s.provenance->>'verification_source', 'admin') = 'admin'
                             )
                       )::integer AS pending_verification_count,
                       count(DISTINCT s.image_sha256) FILTER (
                           WHERE COALESCE(to_jsonb(s)->>'training_eligibility', 'ELIGIBLE') IN ('QUARANTINED', 'ARCHIVED')
                       )::integer AS excluded_count
                FROM public.viread_ocr_samples s
                LEFT JOIN public.bookpages p ON p.id = s.source_page_id
                LEFT JOIN public.books b ON b.id = p.bookid
                WHERE s.source_flow = 'FLOW1_VERIFIED'
                  AND s.dataset_version_id IS NULL
            """)
            if flow2_stats:
                flow2_total_count = int(flow2_stats.get("total_verified_count") or 0)
                flow2_drive_count = int(flow2_stats.get("drive_synced_count") or 0)
                flow2_legacy_count = int(flow2_stats.get("legacy_count") or 0)
                flow2_train_count = int(flow2_stats.get("train_count") or 0)
                flow2_validation_count = int(flow2_stats.get("validation_count") or 0)
                flow2_holdout_count = int(flow2_stats.get("holdout_count") or 0)
                flow2_pending_verification_count = int(flow2_stats.get("pending_verification_count") or 0)
                flow2_excluded_count = int(flow2_stats.get("excluded_count") or 0)
        except Exception as exc:
            logger.debug("Flow 2 storage summary query skipped: %s", type(exc).__name__)
        parent_cand_counts: dict[str, int] = {}
        try:
            if hasattr(self.db, "begin_nested"):
                async with self.db.begin_nested():
                    cand_rows = await self.repo.all(
                        "SELECT status, count(*)::integer AS count FROM public.parent_book_flow2_candidates GROUP BY status"
                    )
            else:
                cand_rows = await self.repo.all(
                    "SELECT status, count(*)::integer AS count FROM public.parent_book_flow2_candidates GROUP BY status"
                )
            for row in cand_rows:
                parent_cand_counts[str(row["status"])] = int(row["count"] or 0)
        except Exception as exc:
            logger.debug("Parent Flow 2 candidate summary query skipped: %s", type(exc).__name__)
        outbox_map = {str(item["status"]): int(item["count"]) for item in outbox}
        from app.jobs.viread_ocr_training_auto_worker import local_training_capacity

        local_ready, local_info = local_training_capacity()
        web_heavy_disabled = (os.getenv("VIREAD_WEB_DISABLE_HEAVY_WORKERS") or "").strip().lower() in {
            "1", "true", "yes", "on",
        }
        worker_status = {
            "local_training_enabled": local_ready or local_info.get("reason") != "LOCAL_TRAINING_DISABLED",
            "local_gpu_ready": local_ready,
            "local_capacity": local_info,
            "web_heavy_workers_disabled": web_heavy_disabled,
            "execution_mode": "COLAB" if not local_ready else "LOCAL",
        }
        flow2_blockers: list[str] = []
        if flow2_storage_provider_setting() == StorageProvider.GOOGLE_DRIVE:
            if not google_drive or not google_drive.get("connected"):
                flow2_blockers.append("Google Drive cho dữ liệu xác minh chưa kết nối hoặc phiên cầu nối không hợp lệ.")
            elif google_drive.get("connection_mode") == "drive_desktop_sync" and web_heavy_disabled:
                flow2_blockers.append("Đang dùng Google Drive trên máy cá nhân; máy chủ đám mây cần kết nối qua Apps Script Bridge.")
        if flow2_legacy_count > 0:
            flow2_blockers.append(
                f"Còn {flow2_legacy_count} mẫu chưa đồng bộ lên Google Drive (cần kết nối Apps Script Bridge và đồng bộ)."
            )
        if not (flow2_train_count > 0 and flow2_validation_count > 0):
            flow2_blockers.append(
                f"Kho dữ liệu sạch cần có mẫu ở cả tập huấn luyện ({flow2_train_count}) và tập kiểm thử ({flow2_validation_count}); có thể bấm tạo bản tổng hợp nếu đã có ít nhất 2 nhóm sách."
            )
        if web_heavy_disabled and not any(
            str(j.get("profile") or "") in {"FLOW2_ADMIN_VERIFIED", "FLOW1_VERIFIED"}
            and str(j.get("status") or "") in {"WAITING_FOR_COLAB_WORKER", "COLAB_RUNNING", "QUEUED"}
            for j in jobs
        ):
            flow2_blockers.append("Tác vụ huấn luyện nền trên máy chủ web đang tắt; hãy bấm 'Tạo bản tổng hợp & Xếp hàng huấn luyện' để gửi tác vụ cho máy chủ xử lý.")

        storage_summary = {
            "flow2_write_provider": flow2_storage_provider_setting().value,
            "flow2_drive_synced_samples": flow2_drive_count,
            "flow2_legacy_samples": flow2_legacy_count,
            "flow2_verified_total_samples": flow2_total_count,
            "flow2_pending_verification_samples": flow2_pending_verification_count,
            "flow2_excluded_samples": flow2_excluded_count,
            "flow2_train_samples": flow2_train_count,
            "flow2_validation_samples": flow2_validation_count,
            "flow2_holdout_samples": flow2_holdout_count,
            "flow2_parent_candidates_pending": parent_cand_counts.get("PENDING_VERIFICATION", 0),
            "flow2_parent_candidates_sync_queued": parent_cand_counts.get("SYNC_QUEUED", 0) + parent_cand_counts.get("VERIFIED", 0),
            "flow2_parent_candidates_synced": parent_cand_counts.get("SYNCED", 0),
            "flow2_parent_candidates_rejected": parent_cand_counts.get("REJECTED", 0),
            "flow2_parent_candidates_revoked": parent_cand_counts.get("REVOKED", 0),
            "dataset_ready_for_training": flow2_train_count > 0 and flow2_validation_count > 0,
            "evaluation_ready_for_model_replacement": bool(locked_test and locked_test.get("status") == "READY"),
            "outbox_pending": outbox_map.get("PENDING", 0) + outbox_map.get("PROCESSING", 0),
            "outbox_retry": outbox_map.get("RETRY", 0),
            "outbox_dead": outbox_map.get("DEAD", 0),
            "outbox_blocked": outbox_map.get("BLOCKED", 0),
            "outbox_skipped": outbox_map.get("SKIPPED", 0),
            "outbox_done": outbox_map.get("DONE", 0),
            "flow2_blockers": flow2_blockers,
        }
        return {
            "outbox": outbox,
            "samples": samples,
            "jobs": jobs,
            "runs": runs,
            "benchmarks": benchmarks,
            "active_model": active,
            "locked_test": locked_test,
            "google_drive": google_drive,
            "runtime_model": runtime_model,
            "storage_summary": storage_summary,
            "worker_status": worker_status,
            "flow2_blockers": flow2_blockers,
        }

    _VERIFIED_HOLDOUT_SOURCE_SQL = """
                    SELECT sample.id::text AS sample_id, sample.source_flow,
                           COALESCE(page.bookid::text, sample.source_group_id) AS group_id,
                           sample.image_storage_path, sample.image_sha256, sample.label,
                           sample.source_page_id, sample.source_revision_id, sample.provenance
                    FROM public.viread_ocr_samples sample
                    LEFT JOIN public.bookpages page ON page.id=sample.source_page_id
                    WHERE sample.split='holdout'
                      AND sample.source_flow='FLOW1_VERIFIED'
                      AND sample.dataset_version_id IS NULL
                      AND COALESCE(to_jsonb(sample)->>'training_eligibility', 'ELIGIBLE') = 'ELIGIBLE'
                      AND sample.provenance->>'verified_by_admin'='true'
                      AND COALESCE(sample.provenance->>'ai_review_required', 'false') <> 'true'
                      AND COALESCE(sample.provenance->>'verification_source', 'admin') = 'admin'
                      AND COALESCE(sample.provenance->>'source_origin', '') <> 'PARENT_PRIVATE_CONTRIBUTION'
                      AND COALESCE(sample.provenance->>'eligible_for_locked_test', 'true') <> 'false'
                      AND (
                          (
                              sample.source_page_id IS NOT NULL
                              AND sample.source_revision_id IS NOT NULL
                              AND EXISTS (
                                  SELECT 1 FROM public.viread_ocr_outbox outbox
                                  WHERE outbox.page_id=sample.source_page_id
                                    AND outbox.revision_id=sample.source_revision_id
                                    AND outbox.status='DONE'
                              )
                          )
                          OR (
                              COALESCE(sample.provenance->>'ingest_pipeline', '') = 'flow2_clean_ingest_v1'
                              AND COALESCE(sample.provenance->>'rights_basis', '') IN (
                                  'owner_supplied', 'owner_authorized', 'licensed', 'public_domain', 'cc_by', 'cc0'
                              )
                              AND COALESCE(BTRIM(sample.provenance->>'verified_by'), '') <> ''
                              AND COALESCE(to_jsonb(sample)->>'sync_status', 'SYNCED') = 'SYNCED'
                          )
                      )
                    UNION ALL
                    SELECT sample.id::text AS sample_id, sample.source_flow,
                           COALESCE(page.bookid::text, sample.source_group_id) AS group_id,
                           sample.image_storage_path, sample.image_sha256, sample.label,
                           sample.source_page_id, sample.source_revision_id, sample.provenance
                    FROM public.viread_ocr_samples sample
                    LEFT JOIN public.bookpages page ON page.id=sample.source_page_id
                    WHERE sample.split='holdout'
                      AND sample.source_flow='FLOW2_EXTERNAL'
                      AND sample.dataset_version_id IS NOT NULL
                      AND sample.provenance->>'verified'='true'
                      AND sample.provenance->>'annotation_id' IS NOT NULL
    """

    _SAFE_HOLDOUT_EXCLUSIONS_SQL = """
                    WHERE NOT EXISTS (
                        SELECT 1 FROM public.viread_ocr_samples used
                        WHERE used.split IN ('train','validation')
                          AND used.image_sha256 = holdout.image_sha256
                    )
                      AND NOT EXISTS (
                        SELECT 1 FROM public.viread_ocr_samples used
                        LEFT JOIN public.bookpages used_page ON used_page.id = used.source_page_id
                        WHERE used.split IN ('train','validation')
                          AND COALESCE(used_page.bookid::text, used.source_group_id) = holdout.group_id
                    )
                      AND NOT EXISTS (
                        SELECT 1 FROM public.viread_ocr_samples locked
                        WHERE locked.source_flow = 'LOCKED_TEST'
                          AND locked.image_sha256 = holdout.image_sha256
                    )
                      AND NOT EXISTS (
                        SELECT 1 FROM public.viread_ocr_samples locked
                        LEFT JOIN public.bookpages locked_page ON locked_page.id = locked.source_page_id
                        WHERE locked.source_flow = 'LOCKED_TEST'
                          AND COALESCE(locked_page.bookid::text, locked.source_group_id) = holdout.group_id
                    )
    """


    async def register_dataset(
        self,
        actor_id: UUID,
        payload: DatasetImport,
        *,
        commit: bool = True,
        preverified_storage_refs: set[tuple[str, str]] | None = None,
    ) -> dict[str, Any]:
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
                valid = (
                    payload.source_flow == "LOCKED_TEST"
                    and (path.startswith("ocr-training/locked-test/") or is_gdrive_ref(path))
                    and item["verified"]
                    and bool(item["annotation_id"])
                )
                valid_split = item["split"] == "locked_test"
            if not valid or not valid_split:
                raise HTTPException(status_code=422, detail="Dataset source, provenance, path, verification, or split contract is invalid")
            # Locked Test is a sealed record of the verified annotation. Normalize
            # Unicode canonically, but do not silently rewrite its whitespace.
            normalized_label = unicodedata.normalize("NFC", item["label"])
            item["label"] = normalized_label if item_flow == "LOCKED_TEST" else normalized_label.strip()
            item["source_flow"] = item_flow
            if not item["label"].strip():
                raise HTTPException(status_code=422, detail="Dataset label must not be blank")
        groups: dict[str, str] = {}
        for item in samples:
            previous = groups.setdefault(item["group_id"], item["split"])
            if previous != item["split"]:
                raise HTTPException(status_code=422, detail="Samples from the same document must share one split")

        has_drive_samples = any(is_gdrive_ref(item["image_storage_path"]) for item in samples)
        verify_router = await self._artifact_router() if has_drive_samples else None
        if commit:
            await self._release_read_txn()
        semaphore = asyncio.Semaphore(8)

        async def verify_object(item: dict[str, Any]) -> None:
            ref_pair = (item["image_storage_path"], str(item["image_sha256"]).lower())
            if preverified_storage_refs and ref_pair in preverified_storage_refs:
                return
            async with semaphore:
                data = await self._read_artifact_bytes(
                    item["image_storage_path"],
                    expected_sha256=item["image_sha256"],
                    router=verify_router,
                )
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
        existing = await self.repo.one("""
            SELECT id, source_flow, version_sha256, manifest_storage_path, sample_count, is_locked_test
            FROM public.viread_ocr_dataset_versions WHERE source_flow=:source_flow AND version_sha256=:version_sha
        """, {"source_flow": payload.source_flow, "version_sha": version_sha})
        if existing:
            return existing
        estimated_db_bytes = len(encoded) + sum(len(item["label"].encode("utf-8")) + 2048 for item in samples)
        await ensure_database_capacity(self.db, estimated_db_bytes)

        use_drive_manifest = (
            payload.source_flow == "LOCKED_TEST"
            and any(is_gdrive_ref(item["image_storage_path"]) for item in samples)
        )
        manifest_provider = StorageProvider.SUPABASE_LEGACY.value
        manifest_drive_id: str | None = None
        if use_drive_manifest:
            router = await self._artifact_router(write_provider=StorageProvider.GOOGLE_DRIVE)
            if commit:
                await self._release_read_txn()
            try:
                stored_manifest = await asyncio.to_thread(
                    router.put,
                    f"locked-tests/manifests/{version_sha}.json",
                    encoded,
                    content_type="application/json",
                    expected_sha256=version_sha,
                    metadata={"source_flow": "LOCKED_TEST", "version_sha256": version_sha},
                )
            except TrainingStorageError as exc:
                raise _storage_http_error(exc) from exc
            storage_path = stored_manifest.reference
            manifest_provider = stored_manifest.provider.value
            manifest_drive_id = stored_manifest.drive_file_id
        else:
            storage_path = f"ocr-training/manifests/{manifest_folder}/{version_sha}.json"
            await ensure_storage_capacity(self.db, len(encoded), existing_object_path=storage_path)
            if commit:
                await self._release_read_txn()
        try:
            if not use_drive_manifest:
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
                  "split_seed": payload.split_seed,
                  "provenance": json.dumps({**payload.provenance, "storage_provider": manifest_provider,
                                            "drive_file_id": manifest_drive_id}),
                  "actor_id": actor_id})
            if use_drive_manifest and result:
                await self._exec_optional_column_update("""
                    UPDATE public.viread_ocr_dataset_versions
                    SET storage_provider = :provider, drive_file_id = :drive_id
                    WHERE id = :id
                """, {"provider": manifest_provider, "drive_id": manifest_drive_id, "id": result["id"]})
            sample_rows = [{"dataset_id": result["id"], "source_flow": item["source_flow"],
                            "group_id": item["group_id"], "split": item["split"], "path": item["image_storage_path"],
                            "image_sha": item["image_sha256"], "label": item["label"], "sample_id": item["sample_id"],
                            "source_page_id": item.get("source_page_id"),
                            "source_revision_id": item.get("source_revision_id"),
                            "provenance": json.dumps({**item["provenance"], "verified": item["verified"],
                                                       "annotation_id": item["annotation_id"]})}
                           for item in samples]
            for start in range(0, len(sample_rows), 1000):
                await self.repo.execute("""
                INSERT INTO public.viread_ocr_samples
                    (dataset_version_id, source_flow, source_group_id, split, image_storage_path,
                     image_sha256, label, source_page_id, source_revision_id,
                     source_annotation_id, provenance)
                VALUES (:dataset_id, :source_flow, :group_id, :split, :path, :image_sha,
                        :label, :source_page_id, :source_revision_id, :sample_id, CAST(:provenance AS jsonb))
                ON CONFLICT DO NOTHING
                """, sample_rows[start:start + 1000])
            if has_drive_samples and result:
                await self._exec_optional_column_update("""
                    UPDATE public.viread_ocr_samples
                    SET storage_provider = 'google_drive',
                        drive_file_id = substring(image_storage_path FROM '^gdrive://(.+)$')
                    WHERE dataset_version_id = :dataset_id
                      AND image_storage_path LIKE 'gdrive://%'
                """, {"dataset_id": result["id"]})
            if commit:
                await self.repo.commit()
            return result
        except HTTPException:
            if commit:
                await self.repo.rollback()
            raise
        except Exception:
            if commit:
                await self.repo.rollback()
            raise

    async def _locked_test_readiness(self) -> dict[str, Any]:
        """Report an immutable, sufficiently large Locked Test or the verified holdout still needed."""
        existing = await self.repo.one("""
            WITH locked_versions AS (
                SELECT version.id, version.version_sha256, version.sample_count,
                       version.created_at, count(sample.id)::integer AS materialized_count,
                       count(DISTINCT sample.source_annotation_id)::integer AS unique_annotation_count,
                       count(DISTINCT sample.image_sha256)::integer AS unique_image_count,
                       count(DISTINCT COALESCE(page.bookid::text, sample.source_group_id))::integer AS group_count,
                       bool_and(sample.provenance->>'verified'='true'
                                AND sample.source_annotation_id IS NOT NULL
                                AND sample.provenance->>'annotation_id'=sample.source_annotation_id) AS all_samples_verified
                FROM public.viread_ocr_dataset_versions version
                JOIN public.viread_ocr_samples sample ON sample.dataset_version_id=version.id
                LEFT JOIN public.bookpages page ON page.id=sample.source_page_id
                WHERE version.source_flow='LOCKED_TEST' AND version.is_locked_test=TRUE
                  AND sample.source_flow='LOCKED_TEST' AND sample.split='locked_test'
                GROUP BY version.id, version.version_sha256, version.sample_count, version.created_at
            )
            SELECT locked.id AS version_id, locked.version_sha256 AS manifest_sha256,
                   locked.materialized_count AS sample_count, locked.group_count
            FROM locked_versions locked
            WHERE locked.materialized_count=locked.sample_count
              AND locked.unique_annotation_count=locked.sample_count
              AND locked.unique_image_count=locked.sample_count
              AND locked.all_samples_verified IS TRUE
              AND locked.materialized_count >= :minimum_samples
              AND locked.group_count >= :minimum_groups
              AND NOT EXISTS (
                  SELECT 1 FROM public.viread_ocr_benchmarks consumed
                  WHERE consumed.locked_test_version_id=locked.id
              )
              AND NOT EXISTS (
                  SELECT 1
                  FROM public.viread_ocr_samples test_sample
                  JOIN public.viread_ocr_samples used
                    ON used.split IN ('train','validation')
                   AND used.image_sha256 = test_sample.image_sha256
                  WHERE test_sample.dataset_version_id = locked.id
              )
              AND NOT EXISTS (
                  SELECT 1
                  FROM public.viread_ocr_samples test_sample
                  LEFT JOIN public.bookpages test_page ON test_page.id = test_sample.source_page_id
                  JOIN public.viread_ocr_samples used ON used.split IN ('train','validation')
                  LEFT JOIN public.bookpages used_page ON used_page.id = used.source_page_id
                  WHERE test_sample.dataset_version_id = locked.id
                    AND COALESCE(used_page.bookid::text, used.source_group_id)
                        = COALESCE(test_page.bookid::text, test_sample.source_group_id)
              )
            ORDER BY locked.created_at, locked.id LIMIT 1
        """, {"minimum_samples": MIN_LOCKED_PAIRS, "minimum_groups": MIN_LOCKED_GROUPS})
        if existing:
            return {"status": "READY", "version_id": str(existing["version_id"]),
                    "manifest_sha256": existing["manifest_sha256"],
                    "sample_count": int(existing["sample_count"]),
                    "group_count": int(existing["group_count"]),
                    "eligible_sample_count": int(existing["sample_count"]),
                    "eligible_group_count": int(existing["group_count"]),
                    "minimum_samples": MIN_LOCKED_PAIRS, "minimum_groups": MIN_LOCKED_GROUPS}

        eligible = await self.repo.one(f"""
            WITH verified_holdout AS (
{self._VERIFIED_HOLDOUT_SOURCE_SQL}
            ), safe_holdout AS (
                SELECT DISTINCT ON (holdout.image_sha256)
                       holdout.image_sha256, holdout.group_id
                FROM verified_holdout holdout
{self._SAFE_HOLDOUT_EXCLUSIONS_SQL}
                ORDER BY holdout.image_sha256, holdout.group_id
            )
            SELECT count(*)::integer AS sample_count,
                   count(DISTINCT group_id)::integer AS group_count
            FROM safe_holdout
        """)
        eligible_samples = int((eligible or {}).get("sample_count") or 0)
        eligible_groups = int((eligible or {}).get("group_count") or 0)
        ready = eligible_samples >= MIN_LOCKED_PAIRS and eligible_groups >= MIN_LOCKED_GROUPS
        return {"status": "READY_TO_CREATE" if ready else "NEEDS_DATA",
                "version_id": None, "manifest_sha256": None,
                "sample_count": 0, "group_count": 0,
                "eligible_sample_count": eligible_samples,
                "eligible_group_count": eligible_groups,
                "missing_sample_count": max(0, MIN_LOCKED_PAIRS - eligible_samples),
                "missing_group_count": max(0, MIN_LOCKED_GROUPS - eligible_groups),
                "minimum_samples": MIN_LOCKED_PAIRS, "minimum_groups": MIN_LOCKED_GROUPS}

    async def _record_evaluation_cohort(
        self, dataset_version_id: UUID, manifest_sha256: str, evaluation_type: str,
        seed: str, sample_count: int, group_count: int, actor_id: UUID | None = None,
    ) -> dict[str, Any]:
        existing = await self.repo.one("""
            SELECT id, evaluation_type, manifest_sha256, sample_count, group_count
            FROM public.viread_ocr_evaluation_cohorts WHERE dataset_version_id=:dataset_id
        """, {"dataset_id": dataset_version_id})
        if existing:
            if existing["manifest_sha256"] != manifest_sha256 or existing["evaluation_type"] != evaluation_type:
                raise HTTPException(status_code=409, detail="Evaluation cohort lineage conflicts with its immutable dataset")
            return existing
        cohort = await self.repo.one("""
            INSERT INTO public.viread_ocr_evaluation_cohorts
                (evaluation_type, dataset_version_id, manifest_sha256, seed,
                 sampling_policy, sample_count, group_count, created_by)
            VALUES (:evaluation_type, :dataset_id, :manifest_sha, :seed,
                    :policy, :sample_count, :group_count, :actor_id)
            ON CONFLICT (dataset_version_id) DO NOTHING
            RETURNING id, evaluation_type, manifest_sha256, sample_count, group_count
        """, {"evaluation_type": evaluation_type, "dataset_id": dataset_version_id,
              "manifest_sha": manifest_sha256, "seed": seed,
              "policy": ("seeded balanced sample from verified holdout; max 8 lines/document; single-use"
                         if evaluation_type == "PILOT" else
                         "all eligible verified holdout; minimum 200 samples and 30 document groups; single-use"),
              "sample_count": sample_count, "group_count": group_count, "actor_id": actor_id})
        if cohort:
            return cohort
        existing = await self.repo.one("""
            SELECT id, evaluation_type, manifest_sha256, sample_count, group_count
            FROM public.viread_ocr_evaluation_cohorts WHERE dataset_version_id=:dataset_id
        """, {"dataset_id": dataset_version_id})
        if not existing or existing["manifest_sha256"] != manifest_sha256:
            raise HTTPException(status_code=409, detail="Evaluation cohort was concurrently created with different lineage")
        return existing

    async def ensure_pilot_test(self, actor_id: UUID) -> dict[str, Any]:
        """Create one small, balanced, immutable Pilot cohort from untouched human VERIFIED holdout."""
        await self._admin(actor_id)
        await self.repo.execute("SELECT pg_advisory_xact_lock(hashtext('viread_ocr_pilot_test_autocreate'))")
        existing = await self.repo.one("""
            SELECT cohort.id AS cohort_id, cohort.dataset_version_id AS version_id,
                   cohort.manifest_sha256, cohort.sample_count, cohort.group_count, cohort.seed
            FROM public.viread_ocr_evaluation_cohorts cohort
            WHERE cohort.evaluation_type='PILOT'
              AND NOT EXISTS (
                  SELECT 1 FROM public.viread_ocr_benchmarks benchmark
                  WHERE benchmark.evaluation_cohort_id=cohort.id
              )
            ORDER BY cohort.created_at, cohort.id LIMIT 1
        """)
        if existing:
            await self.repo.commit()
            return {"status": "READY", **existing, "evaluation_type": "PILOT",
                    "minimum_samples": MIN_PILOT_PAIRS, "minimum_groups": MIN_PILOT_GROUPS}

        rows = await self.repo.all(f"""
            WITH verified_holdout AS (
{self._VERIFIED_HOLDOUT_SOURCE_SQL}
            )
            SELECT holdout.* FROM verified_holdout holdout
{self._SAFE_HOLDOUT_EXCLUSIONS_SQL}
            ORDER BY holdout.group_id, holdout.image_sha256, holdout.sample_id
        """)
        by_hash: dict[str, dict[str, Any]] = {}
        for row in rows:
            cleaned_label, _label_reason = sanitize_and_validate_vietocr_label(row.get("label"))
            if not cleaned_label:
                continue
            row = {**row, "label": cleaned_label}
            digest = str(row["image_sha256"]).lower()
            previous = by_hash.get(digest)
            if previous and previous["label"] != row["label"]:
                await self.repo.rollback()
                raise HTTPException(status_code=409, detail="Verified holdout image has conflicting labels")
            by_hash.setdefault(digest, row)
        groups: dict[str, list[dict[str, Any]]] = defaultdict(list)
        for row in by_hash.values():
            groups[str(row["group_id"])].append(row)
        seed = "viread-pilot-admin-verified-v1"
        ordered_groups = sorted(groups, key=lambda group: hashlib.sha256(f"{seed}\0{group}".encode()).hexdigest())
        selected: list[dict[str, Any]] = []
        depth = 0
        while len(selected) < MAX_PILOT_PAIRS:
            progressed = False
            for group in ordered_groups:
                group_rows = sorted(groups[group], key=lambda row: hashlib.sha256(
                    f"{seed}\0{group}\0{row['image_sha256']}".encode()
                ).hexdigest())
                if depth < min(MAX_PILOT_PER_GROUP, len(group_rows)) and len(selected) < MAX_PILOT_PAIRS:
                    selected.append(group_rows[depth])
                    progressed = True
            if not progressed:
                break
            depth += 1
        group_count = len({str(row["group_id"]) for row in selected})
        if len(selected) < MIN_PILOT_PAIRS or group_count < MIN_PILOT_GROUPS:
            await self.repo.commit()
            return {"status": "NEEDS_DATA", "version_id": None, "manifest_sha256": None,
                    "eligible_sample_count": len(by_hash), "eligible_group_count": len(groups),
                    "minimum_samples": MIN_PILOT_PAIRS, "minimum_groups": MIN_PILOT_GROUPS}

        from io import BytesIO
        router = await self._artifact_router()
        use_drive = router.write_provider == StorageProvider.GOOGLE_DRIVE
        pilot_samples: list[DatasetSampleInput] = []
        for row in selected:
            digest = str(row["image_sha256"]).lower()
            image_bytes = await self._read_artifact_bytes(
                row["image_storage_path"], expected_sha256=digest, router=router
            )
            if hashlib.sha256(image_bytes).hexdigest() != digest:
                await self.repo.rollback()
                raise HTTPException(status_code=409, detail="Verified holdout image hash changed")
            try:
                with Image.open(BytesIO(image_bytes)) as image:
                    image.verify()
                    image_format = (image.format or "PNG").upper()
                rgb_crop = open_image_exif_safe(image_bytes)
            except (UnidentifiedImageError, OSError) as exc:
                await self.repo.rollback()
                raise HTTPException(status_code=422, detail="Verified Pilot holdout contains an invalid image") from exc
            crop_ok, _crop_metrics, crop_reason = validate_flow2_line_crop(rgb_crop, label=row["label"])
            if not crop_ok:
                await self.repo.rollback()
                raise HTTPException(
                    status_code=422,
                    detail=f"Verified Pilot holdout image failed quality check: {crop_reason}",
                )
            extension, content_type = {"JPEG": ("jpg", "image/jpeg"), "PNG": ("png", "image/png"),
                                       "WEBP": ("webp", "image/webp")}.get(image_format, (None, None))
            if not extension:
                await self.repo.rollback()
                raise HTTPException(status_code=422, detail="Verified Pilot holdout image format is unsupported")
            if use_drive:
                try:
                    stored = await asyncio.to_thread(
                        router.put,
                        f"locked-tests/pilot/{digest[:2]}/{digest}.{extension}",
                        image_bytes,
                        content_type=content_type,
                        expected_sha256=digest,
                        metadata={"evaluation_type": "PILOT", "sample_id": str(row["sample_id"])},
                    )
                except TrainingStorageError as exc:
                    await self.repo.rollback()
                    raise _storage_http_error(exc) from exc
                object_path = stored.reference
            else:
                object_path = f"ocr-training/locked-test/pilot/{digest[:2]}/{digest}.{extension}"
                await ensure_storage_capacity(self.db, len(image_bytes), existing_object_path=object_path)
                await asyncio.to_thread(upload_object, object_path, image_bytes, content_type, upsert=True)
            pilot_samples.append(DatasetSampleInput(
                source_flow="LOCKED_TEST", sample_id=str(row["sample_id"]),
                group_id=str(row["group_id"]), split="locked_test", image_storage_path=object_path,
                image_sha256=digest, label=unicodedata.normalize("NFC", str(row["label"])),
                verified=True, annotation_id=str(row["sample_id"]),
                source_page_id=row.get("source_page_id"), source_revision_id=row.get("source_revision_id"),
                provenance={"evaluation_type": "PILOT", "source_flow": row["source_flow"],
                            "source_sample_id": str(row["sample_id"]), "source_group_id": str(row["group_id"]),
                            "storage_provider": StorageProvider.GOOGLE_DRIVE.value if use_drive else StorageProvider.SUPABASE_LEGACY.value,
                            "verified_by_admin": row["source_flow"] == "FLOW1_VERIFIED"},
            ))
        imported = await self.register_dataset(
            actor_id,
            DatasetImport(
                source_flow="LOCKED_TEST",
                samples=pilot_samples,
                split_seed=seed,
                provenance={"auto_created": True, "evaluation_type": "PILOT", "seed": seed,
                            "sampling_policy": "seeded balanced verified holdout; max 8 samples per document; single-use",
                            "minimum_samples": MIN_PILOT_PAIRS, "minimum_groups": MIN_PILOT_GROUPS},
            ),
            commit=False,
        )
        await self._record_evaluation_cohort(UUID(str(imported["id"])), imported["version_sha256"],
                                             "PILOT", seed, len(pilot_samples), group_count, actor_id)
        await self.repo.commit()
        return {"status": "READY", "version_id": str(imported["id"]),
                "manifest_sha256": imported["version_sha256"], "sample_count": len(pilot_samples),
                "group_count": group_count, "evaluation_type": "PILOT",
                "minimum_samples": MIN_PILOT_PAIRS, "minimum_groups": MIN_PILOT_GROUPS}

    async def _prepare_locked_test_row(
        self,
        row: dict[str, Any],
        *,
        router: TrainingArtifactStoreRouter | None,
        use_drive: bool,
        semaphore: asyncio.Semaphore,
        supabase_quota_lock: asyncio.Lock,
    ) -> tuple[DatasetSampleInput, tuple[str, str]]:
        from io import BytesIO

        digest = str(row["image_sha256"]).lower()
        async with semaphore:
            image_bytes = await self._read_artifact_bytes(
                row["image_storage_path"], expected_sha256=digest, router=router
            )
            if hashlib.sha256(image_bytes).hexdigest() != digest:
                raise HTTPException(
                    status_code=409,
                    detail="Verified holdout image hash changed; Locked Test was not created",
                )
            try:
                with Image.open(BytesIO(image_bytes)) as image:
                    image.verify()
                    image_format = (image.format or "PNG").upper()
                rgb_crop = open_image_exif_safe(image_bytes)
            except (UnidentifiedImageError, OSError) as exc:
                raise HTTPException(
                    status_code=422,
                    detail="Verified holdout contains an invalid image; Locked Test was not created",
                ) from exc
            crop_ok, _crop_metrics, crop_reason = validate_flow2_line_crop(rgb_crop, label=row["label"])
            if not crop_ok:
                raise HTTPException(
                    status_code=422,
                    detail=f"Verified holdout image failed quality check; Locked Test was not created ({crop_reason})",
                )
            extension, content_type = {
                "JPEG": ("jpg", "image/jpeg"),
                "PNG": ("png", "image/png"),
                "WEBP": ("webp", "image/webp"),
            }.get(image_format, (None, None))
            if not extension:
                raise HTTPException(
                    status_code=422,
                    detail="Verified holdout image format is unsupported for Locked Test",
                )
            if use_drive:
                try:
                    stored = await asyncio.to_thread(
                        router.put,
                        f"locked-tests/production/{digest[:2]}/{digest}.{extension}",
                        image_bytes,
                        content_type=content_type,
                        expected_sha256=digest,
                        metadata={"evaluation_type": "PRODUCTION", "sample_id": str(row["sample_id"])},
                    )
                except TrainingStorageError as exc:
                    raise _storage_http_error(exc) from exc
                object_path = stored.reference
            else:
                object_path = f"ocr-training/locked-test/auto-admin-verified/{digest[:2]}/{digest}.{extension}"
                async with supabase_quota_lock:
                    await ensure_storage_capacity(self.db, len(image_bytes), existing_object_path=object_path)
                await asyncio.to_thread(upload_object, object_path, image_bytes, content_type, upsert=True)
        sample_input = DatasetSampleInput(
            source_flow="LOCKED_TEST",
            sample_id=str(row["sample_id"]),
            group_id=str(row["group_id"]),
            split="locked_test",
            image_storage_path=object_path,
            image_sha256=digest,
            label=unicodedata.normalize("NFC", str(row["label"])),
            verified=True,
            annotation_id=str(row["sample_id"]),
            source_page_id=row.get("source_page_id"),
            source_revision_id=row.get("source_revision_id"),
            provenance={
                "auto_locked_test": "admin_verified_holdout_v1",
                "source_flow": row["source_flow"],
                "source_sample_id": str(row["sample_id"]),
                "source_page_id": str(row["source_page_id"]) if row.get("source_page_id") else None,
                "source_revision_id": str(row["source_revision_id"]) if row.get("source_revision_id") else None,
                "storage_provider": (
                    StorageProvider.GOOGLE_DRIVE.value if use_drive else StorageProvider.SUPABASE_LEGACY.value
                ),
                "verified_by_admin": row["source_flow"] == "FLOW1_VERIFIED",
            },
        )
        return sample_input, (object_path, digest)

    async def ensure_locked_test(self, actor_id: UUID) -> dict[str, Any]:
        """Create the first immutable Locked Test from clean verified holdout data once thresholds are met."""
        await self._admin(actor_id)
        readiness = await self._locked_test_readiness()
        if readiness["status"] == "READY":
            await self.repo.execute("SELECT pg_advisory_xact_lock(hashtext('viread_ocr_locked_test_autocreate'))")
            await self._record_evaluation_cohort(
                UUID(readiness["version_id"]), readiness["manifest_sha256"],
                "PRODUCTION", "viread-locked-test-admin-verified-v1",
                readiness["sample_count"], readiness["group_count"], actor_id,
            )
            await self.repo.commit()
            return readiness
        if readiness["status"] != "READY_TO_CREATE":
            await self.repo.commit()
            return readiness

        rows = await self.repo.all(f"""
            WITH verified_holdout AS (
{self._VERIFIED_HOLDOUT_SOURCE_SQL}
            )
            SELECT holdout.*
            FROM verified_holdout holdout
{self._SAFE_HOLDOUT_EXCLUSIONS_SQL}
            ORDER BY holdout.source_flow, holdout.group_id, holdout.image_sha256, holdout.sample_id
        """)
        by_hash: dict[str, dict[str, Any]] = {}
        for row in rows:
            cleaned_label, _label_reason = sanitize_and_validate_vietocr_label(row.get("label"))
            if not cleaned_label:
                continue
            row = {**row, "label": cleaned_label}
            digest = str(row["image_sha256"]).lower()
            existing = by_hash.get(digest)
            if existing:
                if existing["label"] != row["label"]:
                    await self.repo.rollback()
                    raise HTTPException(status_code=409, detail="Verified holdout image has conflicting labels; Locked Test was not created")
                continue
            by_hash[digest] = row
        selected = list(by_hash.values())
        group_count = len({str(row["group_id"]) for row in selected})
        if len(selected) < MIN_LOCKED_PAIRS or group_count < MIN_LOCKED_GROUPS:
            await self.repo.commit()
            return {**readiness, "status": "NEEDS_DATA",
                    "eligible_sample_count": len(selected), "eligible_group_count": group_count}

        router = await self._artifact_router()
        use_drive = router.write_provider == StorageProvider.GOOGLE_DRIVE
        # Release the read transaction before remote storage I/O so slow Drive calls
        # never hold advisory locks or DB connections open across the batch.
        await self._release_read_txn()
        semaphore = asyncio.Semaphore(4 if use_drive else 8)
        supabase_quota_lock = asyncio.Lock()
        try:
            prepared = await asyncio.gather(
                *(
                    self._prepare_locked_test_row(
                        row,
                        router=router,
                        use_drive=use_drive,
                        semaphore=semaphore,
                        supabase_quota_lock=supabase_quota_lock,
                    )
                    for row in selected
                )
            )
        except Exception:
            await self.repo.rollback()
            raise
        locked_samples = [pair[0] for pair in prepared]
        preverified_refs = {pair[1] for pair in prepared}

        await self.repo.execute("SELECT pg_advisory_xact_lock(hashtext('viread_ocr_locked_test_autocreate'))")
        latest_readiness = await self._locked_test_readiness()
        if latest_readiness["status"] == "READY":
            await self._record_evaluation_cohort(
                UUID(latest_readiness["version_id"]), latest_readiness["manifest_sha256"],
                "PRODUCTION", "viread-locked-test-admin-verified-v1",
                latest_readiness["sample_count"], latest_readiness["group_count"], actor_id,
            )
            await self.repo.commit()
            return latest_readiness

        imported = await self.register_dataset(
            actor_id,
            DatasetImport(
                source_flow="LOCKED_TEST",
                samples=locked_samples,
                split_seed="viread-locked-test-admin-verified-v1",
                provenance={"auto_created": True,
                            "policy": "verified_holdout_excluding_all_train_validation_and_prior_locked_test",
                            "minimum_samples": MIN_LOCKED_PAIRS,
                            "minimum_groups": MIN_LOCKED_GROUPS,
                            "eligible_source_flows": ["FLOW1_VERIFIED", "FLOW2_EXTERNAL"]},
            ),
            commit=False,
            preverified_storage_refs=preverified_refs,
        )
        await self._record_evaluation_cohort(
            UUID(str(imported["id"])), imported["version_sha256"], "PRODUCTION",
            "viread-locked-test-admin-verified-v1", len(locked_samples), group_count, actor_id,
        )
        await self.repo.commit()
        return {"status": "READY", "version_id": str(imported["id"]),
                "manifest_sha256": imported["version_sha256"],
                "sample_count": len(locked_samples), "group_count": group_count,
                "eligible_sample_count": len(locked_samples),
                "eligible_group_count": group_count,
                "minimum_samples": MIN_LOCKED_PAIRS, "minimum_groups": MIN_LOCKED_GROUPS}

    async def admin_verified_manifest(self, actor_id: UUID, *, limit: int, offset: int) -> dict[str, Any]:
        await self._admin(actor_id)
        await self.repo.execute("SELECT pg_advisory_xact_lock(hashtext('viread_ocr_flow1_snapshot'))")
        source_rows = await self.repo.all("""
            SELECT sample.id::text AS sample_id,
                   COALESCE(page.bookid::text, sample.source_group_id) AS group_id,
                   sample.split, sample.image_storage_path, sample.image_sha256, sample.label,
                   sample.source_page_id, sample.source_revision_id, sample.provenance
            FROM public.viread_ocr_samples sample
            LEFT JOIN public.bookpages page ON page.id=sample.source_page_id
            LEFT JOIN public.books book ON book.id=page.bookid
            WHERE sample.source_flow='FLOW1_VERIFIED'
              AND sample.split IN ('train','validation') AND sample.dataset_version_id IS NULL
              AND COALESCE(to_jsonb(sample)->>'training_eligibility', 'ELIGIBLE') = 'ELIGIBLE'
              AND sample.provenance->>'verified_by_admin' = 'true'
              AND COALESCE(sample.provenance->>'ai_review_required', 'false') <> 'true'
              AND COALESCE(sample.provenance->>'verification_source', 'admin') = 'admin'
              AND COALESCE(to_jsonb(book)->>'is_deleted', 'false') <> 'true'
              AND COALESCE(to_jsonb(book)->>'lifecyclestatus', 'ACTIVE') = 'ACTIVE'
              AND COALESCE(to_jsonb(page)->>'lifecyclestatus', 'ACTIVE') = 'ACTIVE'
              AND (
                  page.id IS NULL
                  OR NULLIF(to_jsonb(page)->>'currentverifiedrevisionid', '') IS NULL
                  OR (to_jsonb(page)->>'currentverifiedrevisionid') = sample.source_revision_id::text
              )
              AND NOT EXISTS (
                  SELECT 1 FROM public.viread_ocr_samples held
                  LEFT JOIN public.bookpages held_page ON held_page.id=held.source_page_id
                  WHERE held.source_flow='FLOW1_VERIFIED' AND held.split='holdout'
                    AND held.dataset_version_id IS NULL
                    AND COALESCE(to_jsonb(held)->>'training_eligibility', 'ELIGIBLE') = 'ELIGIBLE'
                    AND COALESCE(held_page.bookid::text, held.source_group_id)
                        = COALESCE(page.bookid::text, sample.source_group_id)
              )
              AND NOT EXISTS (
                  SELECT 1 FROM public.viread_ocr_samples locked
                  LEFT JOIN public.bookpages locked_page ON locked_page.id=locked.source_page_id
                  WHERE locked.source_flow='LOCKED_TEST'
                    AND (
                        locked.image_sha256 = sample.image_sha256
                        OR COALESCE(locked_page.bookid::text, locked.source_group_id)
                           = COALESCE(page.bookid::text, sample.source_group_id)
                    )
              )
            ORDER BY group_id, sample.created_at, sample.id
        """)
        # Defense-in-depth Python filter: never admit AI-only auto-verified rows into Flow 2 datasets.
        source_rows = [
            row for row in source_rows
            if isinstance(row.get("provenance"), dict)
            and row["provenance"].get("verified_by_admin") is True
            and not row["provenance"].get("ai_review_required")
            and str(row["provenance"].get("verification_source") or "admin") == "admin"
        ]
        # Recheck #3: for any parent-contributed sample, re-verify live consent, active book/page,
        # and active revision right before snapshotting into a new manifest.
        parent_contrib_rows = [
            row for row in source_rows
            if str((row.get("provenance") or {}).get("source_origin") or "") == "PARENT_PRIVATE_CONTRIBUTION"
        ]
        if parent_contrib_rows and hasattr(self.db, "execute"):
            book_ids = sorted({
                str(row["provenance"].get("book_id"))
                for row in parent_contrib_rows
                if row["provenance"].get("book_id")
            })
            live_states: dict[str, dict[str, Any]] = {}
            live_pages: dict[str, dict[str, Any]] = {}
            if book_ids:
                try:
                    book_rows = await self.repo.all(
                        """
                        SELECT b.id::text AS book_id,
                               b.lifecyclestatus AS book_lifecycle,
                               b.moderation_status AS book_moderation,
                               cs.status AS consent_status,
                               cs.rights_confirmed AS consent_rights_confirmed,
                               cs.consent_version AS consent_version
                        FROM public.books b
                        LEFT JOIN public.parent_book_ocr_contribution_consents cs ON cs.book_id = b.id
                        WHERE b.id = ANY(CAST(:book_ids AS uuid[]))
                        """,
                        {"book_ids": book_ids},
                    )
                    live_states = {str(r["book_id"]): r for r in book_rows}
                    page_ids = sorted({
                        str(row["source_page_id"])
                        for row in parent_contrib_rows
                        if row.get("source_page_id")
                    })
                    if page_ids:
                        p_rows = await self.repo.all(
                            """
                            SELECT p.id::text AS page_id,
                                   p.lifecyclestatus AS page_lifecycle,
                                   p.currentverifiedrevisionid::text AS current_rev_id
                            FROM public.bookpages p
                            WHERE p.id = ANY(CAST(:page_ids AS uuid[]))
                            """,
                            {"page_ids": page_ids},
                        )
                        live_pages = {str(r["page_id"]): r for r in p_rows}
                except Exception:
                    live_states = {}
                    live_pages = {}

            def _parent_sample_still_valid(row: dict[str, Any]) -> bool:
                prov = row.get("provenance") or {}
                if str(prov.get("source_origin") or "") != "PARENT_PRIVATE_CONTRIBUTION":
                    return True
                b_id = str(prov.get("book_id") or "")
                b_state = live_states.get(b_id)
                if not b_state:
                    return False
                if (
                    str(b_state.get("book_lifecycle") or "").upper() != "ACTIVE"
                    or str(b_state.get("book_moderation") or "").upper() != "ACTIVE"
                    or str(b_state.get("consent_status") or "").upper() != "OPTED_IN"
                    or not bool(b_state.get("consent_rights_confirmed"))
                ):
                    return False
                if int(b_state.get("consent_version") or 0) != int(prov.get("consent_version") or -1):
                    return False
                p_id = str(row.get("source_page_id") or "")
                p_state = live_pages.get(p_id)
                if not p_state:
                    return False
                if (
                    str(p_state.get("page_lifecycle") or "").upper() != "ACTIVE"
                    or str(p_state.get("current_rev_id") or "") != str(row.get("source_revision_id") or "")
                ):
                    return False
                return True

            source_rows = [row for row in source_rows if _parent_sample_still_valid(row)]

        # Flow 2 label & duplicate-conflict hygiene gate: quarantine bad labels or conflicting
        # hashes before building the immutable snapshot so corrupt pool rows never block training.
        clean_rows: list[dict[str, Any]] = []
        bad_sample_ids: list[str] = []
        for row in source_rows:
            cleaned_label, _label_err = sanitize_and_validate_vietocr_label(row.get("label"))
            if not cleaned_label:
                if row.get("sample_id"):
                    bad_sample_ids.append(str(row["sample_id"]))
                continue
            clean_rows.append({**row, "label": cleaned_label})

        labels_by_hash: dict[str, set[str]] = defaultdict(set)
        for row in clean_rows:
            labels_by_hash[str(row["image_sha256"]).lower()].add(row["label"])
        conflicting_hashes = {sha for sha, lbls in labels_by_hash.items() if len(lbls) > 1}
        if conflicting_hashes:
            filtered_rows: list[dict[str, Any]] = []
            for row in clean_rows:
                if str(row["image_sha256"]).lower() in conflicting_hashes:
                    if row.get("sample_id"):
                        bad_sample_ids.append(str(row["sample_id"]))
                else:
                    filtered_rows.append(row)
            clean_rows = filtered_rows
        if bad_sample_ids and hasattr(self.db, "execute"):
            try:
                if hasattr(self.db, "begin_nested"):
                    async with self.db.begin_nested():
                        await self.repo.execute(
                            """
                            UPDATE public.viread_ocr_samples
                            SET training_eligibility = 'QUARANTINED',
                                quarantined_at = now(),
                                quarantine_reason = 'FLOW2_MANIFEST_HYGIENE_REJECTED'
                            WHERE id::text = ANY(:ids)
                              AND dataset_version_id IS NULL
                            """,
                            {"ids": bad_sample_ids},
                        )
                logger.warning(
                    "Quarantined %d invalid/conflicting Flow 2 pool sample(s) before snapshot",
                    len(bad_sample_ids),
                )
            except Exception as exc:
                logger.warning("Could not persist Flow 2 manifest quarantine: %s", type(exc).__name__)
        source_rows = clean_rows

        # Assign deterministic, cross-family duplicate-safe Train/Validation splits.
        _assign_leak_safe_splits(source_rows)
        manifest, source_rows = _verified_snapshot(source_rows)
        version_sha = hashlib.sha256(_canonical(manifest)).hexdigest()
        if source_rows:
            dataset = await self.repo.one("""
                SELECT id, version_sha256, manifest_storage_path, sample_count,
                       COALESCE(to_jsonb(viread_ocr_dataset_versions)->>'dataset_status', 'ACTIVE') AS dataset_status
                FROM public.viread_ocr_dataset_versions
                WHERE source_flow='FLOW1_VERIFIED' AND version_sha256=:version_sha
            """, {"version_sha": version_sha})
            if dataset and str(dataset.get("dataset_status") or "ACTIVE").upper() == "ARCHIVED":
                await self._exec_optional_column_update(
                    """
                    UPDATE public.viread_ocr_dataset_versions
                    SET dataset_status = 'ACTIVE',
                        archived_at = NULL,
                        archive_reason = NULL
                    WHERE id = :id
                    """,
                    {"id": dataset["id"]},
                )
        else:
            dataset = await self.repo.one("""
                SELECT id, version_sha256, manifest_storage_path, sample_count
                FROM public.viread_ocr_dataset_versions dv
                WHERE dv.source_flow='FLOW1_VERIFIED'
                  AND COALESCE(to_jsonb(dv)->>'dataset_status', 'ACTIVE') = 'ACTIVE'
                ORDER BY dv.created_at DESC LIMIT 1
            """)
            if dataset:
                actual_count = await self.repo.one("""
                    SELECT count(*)::integer AS total
                    FROM public.viread_ocr_samples WHERE dataset_version_id=:dataset_id
                """, {"dataset_id": dataset["id"]})
                if (not actual_count or int(actual_count["total"]) != int(dataset["sample_count"])):
                    raise HTTPException(
                        status_code=409,
                        detail="Verified dataset snapshot count differs from its immutable version; refusing to rebuild it",
                    )
                legacy_rows = await self.repo.all("""
                    SELECT COALESCE(source_annotation_id, id::text) AS sample_id,
                           source_group_id AS group_id, split, image_storage_path,
                           image_sha256, label, source_page_id, source_revision_id, provenance
                    FROM public.viread_ocr_samples
                    WHERE dataset_version_id=:dataset_id AND source_flow='FLOW1_VERIFIED'
                    ORDER BY created_at, id
                """, {"dataset_id": dataset["id"]})
                if len(legacy_rows) != int(dataset["sample_count"]):
                    raise HTTPException(
                        status_code=409,
                        detail="Verified dataset rows do not match the immutable version count",
                    )
                needs_canonical_snapshot, legacy_manifest, canonical_rows = (
                    _canonicalize_legacy_verified_snapshot(legacy_rows)
                )
                if needs_canonical_snapshot:
                    source_rows = canonical_rows
                    manifest = legacy_manifest
                    version_sha = hashlib.sha256(_canonical(manifest)).hexdigest()
                    dataset = await self.repo.one("""
                        SELECT id, version_sha256, manifest_storage_path, sample_count
                        FROM public.viread_ocr_dataset_versions
                        WHERE source_flow='FLOW1_VERIFIED' AND version_sha256=:version_sha
                    """, {"version_sha": version_sha})
                else:
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
        if not dataset and not source_rows:
            await self.repo.commit()
            return {
                "dataset_version_id": None,
                "manifest_sha256": None,
                "manifest_storage_path": None,
                "storage_provider": flow2_storage_provider_setting().value,
                "source_flow": "FLOW1_VERIFIED",
                "training_profile": "FLOW2_ADMIN_VERIFIED",
                "items": [],
                "total": 0,
                "limit": limit,
                "offset": offset,
                "next_offset": None,
            }
        if not dataset:
            manifest_bytes = _canonical(manifest)
            estimated_db_bytes = len(manifest_bytes) + sum(len(item["label"].encode("utf-8")) + 2048 for item in source_rows)
            await ensure_database_capacity(self.db, estimated_db_bytes)
            router = await self._artifact_router()
            manifest_provider = router.write_provider.value
            manifest_drive_id: str | None = None
            split_manifests: dict[str, Any] = {}
            if router.write_provider == StorageProvider.GOOGLE_DRIVE:
                train_bytes = _jsonl_bytes([row for row in manifest["samples"] if row["split"] == "train"])
                val_bytes = _jsonl_bytes([row for row in manifest["samples"] if row["split"] == "validation"])
                holdout_bytes = _jsonl_bytes([row for row in manifest["samples"] if row["split"] == "holdout"])
                total_upload_bytes = len(manifest_bytes) + len(train_bytes) + len(val_bytes) + len(holdout_bytes)
                try:
                    quota = await asyncio.to_thread(router.quota_check, incoming_bytes=total_upload_bytes)
                    if not quota.can_accept_upload:
                        raise HTTPException(
                            status_code=507,
                            detail=f"DRIVE_QUOTA_EXCEEDED: {quota.detail or 'Google Drive free quota insufficient for Flow 2 dataset snapshot'}",
                        )
                    stored_manifest = await asyncio.to_thread(
                        router.put,
                        f"datasets/{version_sha}/manifest.json",
                        manifest_bytes,
                        content_type="application/json",
                        expected_sha256=version_sha,
                        metadata={"dataset_version_sha256": version_sha, "source_flow": "FLOW1_VERIFIED"},
                    )
                    for split_name, split_data in (
                        ("train", train_bytes),
                        ("validation", val_bytes),
                        ("holdout", holdout_bytes),
                    ):
                        split_sha = hashlib.sha256(split_data).hexdigest()
                        stored_split = await asyncio.to_thread(
                            router.put,
                            f"datasets/{version_sha}/{split_name}.jsonl",
                            split_data,
                            content_type="application/x-ndjson",
                            expected_sha256=split_sha,
                            metadata={"dataset_version_sha256": version_sha, "split": split_name},
                        )
                        split_manifests[split_name] = {
                            "storage_path": stored_split.reference,
                            "drive_file_id": stored_split.drive_file_id,
                            "sha256": split_sha,
                            "bytes": len(split_data),
                        }
                except TrainingStorageError as exc:
                    raise _storage_http_error(exc) from exc
                manifest_path = stored_manifest.reference
                manifest_drive_id = stored_manifest.drive_file_id
            else:
                manifest_path = f"ocr-training/manifests/flow2_admin_verified/{version_sha}.json"
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
                  "sample_count": len(source_rows),
                  "provenance": json.dumps({
                      "snapshot": "admin_verified_outbox",
                      "storage_provider": manifest_provider,
                      "drive_file_id": manifest_drive_id,
                      "split_manifests": split_manifests,
                  })})
            if manifest_provider == StorageProvider.GOOGLE_DRIVE.value and dataset:
                await self._exec_optional_column_update("""
                    UPDATE public.viread_ocr_dataset_versions
                    SET storage_provider = :provider,
                        drive_file_id = :drive_id,
                        split_manifests = CAST(:split_manifests AS jsonb)
                    WHERE id = :id
                """, {
                    "provider": manifest_provider,
                    "drive_id": manifest_drive_id,
                    "split_manifests": json.dumps(split_manifests),
                    "id": dataset["id"],
                })
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
                await self._exec_optional_column_update("""
                    UPDATE public.viread_ocr_samples
                    SET storage_provider = 'google_drive',
                        drive_file_id = substring(image_storage_path FROM '^gdrive://(.+)$')
                    WHERE dataset_version_id = :dataset_id
                      AND image_storage_path LIKE 'gdrive://%'
                """, {"dataset_id": dataset["id"]})
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
            item["image"] = await self._artifact_download_url_async(
                item["image_storage_path"],
                expected_sha256=item["image_sha256"],
            )
            item["storage_provider"] = (
                StorageProvider.GOOGLE_DRIVE.value
                if is_gdrive_ref(item["image_storage_path"])
                else StorageProvider.SUPABASE_LEGACY.value
            )
            item["drive_file_id"] = drive_file_id_from_reference(item["image_storage_path"])
            item["source_flow"] = "FLOW1_VERIFIED"
            item["verified"] = True
        return {"dataset_version_id": dataset_id, "manifest_sha256": version_sha,
                "manifest_storage_path": dataset.get("manifest_storage_path"),
                "storage_provider": (
                    StorageProvider.GOOGLE_DRIVE.value
                    if is_gdrive_ref(dataset.get("manifest_storage_path"))
                    else StorageProvider.SUPABASE_LEGACY.value
                ),
                "source_flow": "FLOW1_VERIFIED", "training_profile": "FLOW2_ADMIN_VERIFIED",
                "items": items, "total": int(total_row["total"] if total_row else 0),
                "limit": limit, "offset": offset, "next_offset": offset + len(items) if offset + len(items) < int(total_row["total"] if total_row else 0) else None}

    async def active_model_artifact(
        self,
        actor_id: UUID,
        *,
        job_id: UUID | None = None,
        worker_id: str | None = None,
    ) -> dict[str, Any]:
        await self._admin(actor_id)
        active = await self.repo.one("SELECT checkpoint_sha256, storage_path, profile FROM public.viread_ocr_active_model WHERE singleton=TRUE")
        if not active:
            raise HTTPException(status_code=503, detail="Active model registry is not initialized")
        if active["storage_path"] is None:
            return {**active, "source_url": "https://vocr.vn/data/vietocr/vgg_transformer.pth", "chunks": []}
        artifact_router = (
            await self._artifact_router()
            if is_gdrive_ref(active["storage_path"])
            else None
        )
        if job_id is None:
            await self._release_read_txn()
        raw = await self._read_artifact_bytes(active["storage_path"], router=artifact_router)
        try:
            manifest = json.loads(raw)
        except (UnicodeDecodeError, json.JSONDecodeError) as exc:
            raise HTTPException(status_code=503, detail="Active model shard manifest is invalid") from exc
        if manifest.get("checkpoint_sha256") != active["checkpoint_sha256"] or not isinstance(manifest.get("chunks"), list):
            raise HTTPException(status_code=503, detail="Active model manifest does not match the registered checkpoint")
        chunks = []
        for item in manifest["chunks"]:
            chunks.append({
                **item,
                "url": await self._artifact_download_url_async(
                    item["path"],
                    expected_sha256=item.get("sha256"),
                    job_id=job_id,
                    worker_id=worker_id,
                ),
                "storage_provider": (
                    StorageProvider.GOOGLE_DRIVE.value
                    if is_gdrive_ref(item["path"])
                    else StorageProvider.SUPABASE_LEGACY.value
                ),
                "drive_file_id": drive_file_id_from_reference(item["path"]),
            })
        return {
            **active,
            "storage_provider": (
                StorageProvider.GOOGLE_DRIVE.value
                if is_gdrive_ref(active["storage_path"])
                else StorageProvider.SUPABASE_LEGACY.value
            ),
            "drive_file_id": drive_file_id_from_reference(active["storage_path"]),
            "manifest_sha256": hashlib.sha256(raw).hexdigest(),
            "chunks": chunks,
        }

    async def dataset_samples(
        self,
        actor_id: UUID,
        dataset_id: UUID,
        *,
        limit: int,
        offset: int,
        job_id: UUID | None = None,
        worker_id: str | None = None,
    ) -> dict[str, Any]:
        await self._admin(actor_id)
        dataset = await self.repo.one("""
            SELECT id, source_flow, version_sha256, sample_count, is_locked_test, manifest_storage_path
            FROM public.viread_ocr_dataset_versions WHERE id=:id
        """, {"id": dataset_id})
        if not dataset:
            raise HTTPException(status_code=404, detail="Dataset version not found")
        items = await self.repo.all("""
            SELECT COALESCE(sample.source_annotation_id, sample.id::text) AS sample_id,
                   sample.source_annotation_id, sample.source_flow,
                   CASE WHEN dataset.source_flow='LOCKED_TEST'
                        THEN COALESCE(page.bookid::text, sample.source_group_id)
                        ELSE sample.source_group_id END AS group_id,
                   sample.split, sample.image_storage_path, sample.image_sha256, sample.label
            FROM public.viread_ocr_samples sample
            JOIN public.viread_ocr_dataset_versions dataset ON dataset.id=sample.dataset_version_id
            LEFT JOIN public.bookpages page ON page.id=sample.source_page_id
            WHERE sample.dataset_version_id=:dataset_id
            ORDER BY group_id, sample.source_annotation_id, sample.id LIMIT :limit OFFSET :offset
        """, {"dataset_id": dataset_id, "limit": limit, "offset": offset})
        dataset["manifest_url"] = await self._artifact_download_url_async(
            dataset["manifest_storage_path"],
            expected_sha256=dataset["version_sha256"],
            job_id=job_id,
            worker_id=worker_id,
        )
        dataset["storage_provider"] = (
            StorageProvider.GOOGLE_DRIVE.value
            if is_gdrive_ref(dataset["manifest_storage_path"])
            else StorageProvider.SUPABASE_LEGACY.value
        )
        dataset["drive_file_id"] = drive_file_id_from_reference(dataset["manifest_storage_path"])
        for item in items:
            item["image_url"] = await self._artifact_download_url_async(
                item["image_storage_path"],
                expected_sha256=item["image_sha256"],
                job_id=job_id,
                worker_id=worker_id,
            )
            item["storage_provider"] = (
                StorageProvider.GOOGLE_DRIVE.value
                if is_gdrive_ref(item["image_storage_path"])
                else StorageProvider.SUPABASE_LEGACY.value
            )
            item["drive_file_id"] = drive_file_id_from_reference(item["image_storage_path"])
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
        await self._release_read_txn()
        await asyncio.to_thread(upload_object, path, data, content_type, upsert=True)
        return {"source_flow": source_flow, "image_storage_path": path, "image_sha256": digest,
                "byte_count": len(data), "content_type": content_type}

    async def create_run(self, actor_id: UUID, payload: TrainingRunCreate) -> dict[str, Any]:
        await self._admin(actor_id)
        dataset = await self.repo.one(
            """
            SELECT id, source_flow, version_sha256, is_locked_test,
                   COALESCE(to_jsonb(viread_ocr_dataset_versions)->>'dataset_status', 'ACTIVE') AS dataset_status
            FROM public.viread_ocr_dataset_versions
            WHERE id=:id
            """,
            {"id": payload.dataset_version_id},
        )
        if not dataset or dataset["is_locked_test"] or dataset["version_sha256"] != payload.manifest_sha256:
            raise HTTPException(status_code=422, detail="Training manifest version is unavailable or hash mismatched")
        if str(dataset.get("dataset_status") or "ACTIVE").upper() != "ACTIVE":
            raise HTTPException(
                status_code=409,
                detail="DATASET_CONSENT_REVOKED: Snapshot dataset này đã bị lưu trữ hoặc thu hồi quyền nên không thể khởi chạy huấn luyện mới.",
            )
        profile_contract = TRAINING_PROFILES[payload.profile]
        if dataset["source_flow"] not in profile_contract["dataset_flows"]:
            raise HTTPException(status_code=422, detail="Training profile does not match its independent data flow")
        leakage = await self.repo.one("""
            SELECT EXISTS (
                SELECT 1 FROM public.viread_ocr_samples sample
                WHERE sample.dataset_version_id=:dataset_id
                  AND sample.split IN ('train','validation')
                GROUP BY sample.source_group_id
                HAVING count(DISTINCT sample.split) > 1
            ) AS document_group_leak,
            EXISTS (
                SELECT 1 FROM public.viread_ocr_samples sample
                WHERE sample.dataset_version_id=:dataset_id
                GROUP BY sample.image_sha256
                HAVING count(DISTINCT sample.split) > 1
            ) AS image_hash_leak
        """, {"dataset_id": dataset["id"]})
        if leakage and (leakage["document_group_leak"] or leakage["image_hash_leak"]):
            raise HTTPException(status_code=422, detail={
                "message": "Training dataset leaks a source page group or image across Train/Validation",
                "document_group_leak": bool(leakage["document_group_leak"]),
                "image_hash_leak": bool(leakage["image_hash_leak"]),
            })
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
        run = await self.repo.one("SELECT id, status, profile FROM public.viread_ocr_training_runs WHERE id=:id", {"id": run_id})
        if not run or run["status"] not in {"CREATED", "RUNNING"}:
            raise HTTPException(status_code=409, detail="Training run is not accepting checkpoint shards")
        digest = hashlib.sha256(data).hexdigest()
        existing = await self.repo.one("SELECT chunk_sha256, storage_path, byte_count FROM public.viread_ocr_checkpoint_chunks WHERE run_id=:run_id AND chunk_index=:chunk_index", {"run_id": run_id, "chunk_index": chunk_index})
        if existing:
            if existing["chunk_sha256"] == digest and existing["byte_count"] == len(data):
                return {
                    "run_id": run_id,
                    "chunk_index": chunk_index,
                    "sha256": digest,
                    "bytes": len(data),
                    "storage_provider": (
                        StorageProvider.GOOGLE_DRIVE.value
                        if is_gdrive_ref(existing.get("storage_path"))
                        else StorageProvider.SUPABASE_LEGACY.value
                    ),
                    "drive_file_id": drive_file_id_from_reference(existing.get("storage_path")),
                    "idempotent": True,
                }
            raise HTTPException(status_code=409, detail="Checkpoint shard index already contains different bytes")

        router = await self._artifact_router()
        use_drive = _is_flow2_profile(run.get("profile")) and router.write_provider == StorageProvider.GOOGLE_DRIVE
        storage_provider = StorageProvider.SUPABASE_LEGACY.value
        drive_file_id: str | None = None
        if use_drive:
            logical_path = f"checkpoints/{run_id}/chunk-{chunk_index:04d}-{digest[:12]}.part"
            await self._release_read_txn()
            try:
                stored = await asyncio.to_thread(
                    router.put,
                    logical_path,
                    data,
                    content_type="application/octet-stream",
                    expected_sha256=digest,
                    metadata={"run_id": str(run_id), "chunk_index": str(chunk_index)},
                )
            except TrainingStorageError as exc:
                raise _storage_http_error(exc) from exc
            path = stored.reference
            storage_provider = stored.provider.value
            drive_file_id = stored.drive_file_id
        else:
            path = f"ocr-training/checkpoints/{run_id}/{chunk_index:04d}-{digest}.part"
            await ensure_storage_capacity(self.db, len(data), existing_object_path=path)
            await self._release_read_txn()
            await asyncio.to_thread(upload_object, path, data, "application/octet-stream", upsert=True)
        try:
            await self.repo.execute("""
                INSERT INTO public.viread_ocr_checkpoint_chunks (run_id, chunk_index, chunk_sha256, storage_path, byte_count)
                VALUES (:run_id, :chunk_index, :digest, :path, :byte_count)
            """, {"run_id": run_id, "chunk_index": chunk_index, "digest": digest, "path": path, "byte_count": len(data)})
            if use_drive:
                await self._exec_optional_column_update("""
                    UPDATE public.viread_ocr_checkpoint_chunks
                    SET storage_provider = :provider, drive_file_id = :drive_id
                    WHERE run_id = :run_id AND chunk_index = :chunk_index
                """, {"provider": storage_provider, "drive_id": drive_file_id, "run_id": run_id, "chunk_index": chunk_index})
            await self.repo.execute("UPDATE public.viread_ocr_training_runs SET status='RUNNING', updated_at=now() WHERE id=:id", {"id": run_id})
            await self.repo.commit()
        except Exception:
            await self.repo.rollback()
            raise
        return {"run_id": run_id, "chunk_index": chunk_index, "sha256": digest, "bytes": len(data),
                "storage_provider": storage_provider, "drive_file_id": drive_file_id, "idempotent": False}

    async def _lock_colab_job_for_finalize(self, actor_id: UUID, job_id: UUID, run_id: UUID, worker_id: str, profile: str) -> None:
        job = await self.repo.one("""
            SELECT id, target, status, worker_id, run_id, profile, created_by, lease_expires_at
            FROM public.viread_ocr_training_jobs WHERE id=:id FOR UPDATE
        """, {"id": job_id})
        if (not job or job["target"] != "COLAB" or job["status"] != "COLAB_RUNNING"
                or job["worker_id"] != worker_id or str(job["run_id"]) != str(run_id)
                or job["profile"] != profile or str(job["created_by"]) != str(actor_id)
                or job["lease_expires_at"] is None or job["lease_expires_at"] <= datetime.now(timezone.utc)):
            await self.repo.rollback()
            raise HTTPException(status_code=409, detail="Training job lease is no longer owned by this worker")

    async def _finalize_colab_job(self, actor_id: UUID, job_id: UUID, run_id: UUID, worker_id: str, profile: str) -> None:
        await self._lock_colab_job_for_finalize(actor_id, job_id, run_id, worker_id, profile)
        await self.repo.execute("""
            UPDATE public.viread_ocr_training_runs SET metadata=metadata || CAST(:metadata AS jsonb)
            WHERE id=:run_id
        """, {"run_id": run_id, "metadata": json.dumps({
            "execution_target": "COLAB", "training_job_id": str(job_id), "worker_id": worker_id,
        })})
        await self.repo.execute("""
            UPDATE public.viread_ocr_training_jobs
            SET progress='{"stage":"benchmark"}'::jsonb, updated_at=now()
            WHERE id=:id
        """, {"id": job_id})
        await self.repo.commit()

    async def complete_run(
        self,
        actor_id: UUID,
        run_id: UUID,
        payload: TrainingRunComplete,
        *,
        job_id: UUID | None = None,
        worker_id: str | None = None,
    ) -> dict[str, Any]:
        if (job_id is None) != (worker_id is None):
            raise ValueError("job_id and worker_id must be provided together")
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
            if job_id is not None and worker_id is not None:
                await self._finalize_colab_job(actor_id, job_id, run_id, worker_id, payload.profile)
            return {"run_id": run_id, "status": "CANDIDATE", "checkpoint_sha256": payload.checkpoint_sha256,
                    "checkpoint_bytes": int(run["checkpoint_bytes"]), "manifest_storage_path": run["checkpoint_storage_path"],
                    "idempotent": True}
        if run["status"] not in {"CREATED", "RUNNING"}:
            raise HTTPException(status_code=409, detail="Training run cannot be completed")
        chunks = await self.repo.all("SELECT chunk_index, chunk_sha256, storage_path, byte_count FROM public.viread_ocr_checkpoint_chunks WHERE run_id=:run_id ORDER BY chunk_index", {"run_id": run_id})
        if not chunks or [int(chunk["chunk_index"]) for chunk in chunks] != list(range(len(chunks))):
            raise HTTPException(status_code=422, detail="Checkpoint shards are incomplete or out of order")
        chunks_on_drive = any(is_gdrive_ref(chunk["storage_path"]) for chunk in chunks)
        drive_router: TrainingArtifactStoreRouter | None = None
        if chunks_on_drive:
            drive_router = await self._artifact_router(write_provider=StorageProvider.GOOGLE_DRIVE)
        # Release the read transaction before touching Storage. On Render Free,
        # the checkpoint can exceed 150 MiB and remote I/O must not hold a DB
        # connection or the training-job row lock while heartbeats update it.
        await self.repo.commit()
        digest = hashlib.sha256()
        total = 0
        for chunk in chunks:
            chunk_digest, chunk_bytes = await self._hash_artifact_stream(
                chunk["storage_path"],
                digest,
                router=drive_router,
            )
            if chunk_bytes != int(chunk["byte_count"]) or chunk_digest != chunk["chunk_sha256"]:
                raise HTTPException(status_code=422, detail="Stored checkpoint shard failed integrity verification")
            total += chunk_bytes
        if digest.hexdigest() != payload.checkpoint_sha256 or total != payload.checkpoint_bytes:
            raise HTTPException(status_code=422, detail="Reassembled candidate checkpoint does not match the registered hash or size")
        manifest_provider = (
            StorageProvider.GOOGLE_DRIVE.value if chunks_on_drive else StorageProvider.SUPABASE_LEGACY.value
        )
        manifest = {"schema": "viread-checkpoint-shards-v1", "run_id": str(run_id),
                    "profile": payload.profile,
                    "parent_checkpoint_sha256": payload.parent_checkpoint_sha256,
                    "manifest_sha256": payload.manifest_sha256,
                    "config_sha256": payload.config_sha256,
                    "step": payload.step,
                    "storage_provider": manifest_provider,
                    "checkpoint_sha256": payload.checkpoint_sha256, "checkpoint_bytes": total,
                    "chunks": [{"index": int(chunk["chunk_index"]), "path": chunk["storage_path"],
                                "sha256": chunk["chunk_sha256"], "bytes": int(chunk["byte_count"])} for chunk in chunks]}
        manifest_bytes = _canonical(manifest)
        manifest_drive_id: str | None = None
        if chunks_on_drive:
            assert drive_router is not None
            try:
                stored_manifest = await asyncio.to_thread(
                    drive_router.put,
                    f"checkpoints/{run_id}/checkpoint.manifest.json",
                    manifest_bytes,
                    content_type="application/json",
                    expected_sha256=hashlib.sha256(manifest_bytes).hexdigest(),
                    metadata={"run_id": str(run_id), "checkpoint_sha256": payload.checkpoint_sha256},
                )
            except TrainingStorageError as exc:
                raise _storage_http_error(exc) from exc
            except (ValueError, KeyError) as exc:
                raise _storage_http_error(
                    TrainingStorageError(
                        f"Unexpected Drive bridge error while storing checkpoint manifest: {exc}",
                        code="DRIVE_BRIDGE_RESPONSE_INVALID",
                        http_status=502,
                    )
                ) from exc
            manifest_path = stored_manifest.reference
            manifest_drive_id = stored_manifest.drive_file_id
        else:
            manifest_path = f"ocr-training/checkpoints/{run_id}/checkpoint.manifest.json"
            await ensure_storage_capacity(self.db, len(manifest_bytes), existing_object_path=manifest_path)
            await self.repo.commit()
            await asyncio.to_thread(upload_object, manifest_path, manifest_bytes, "application/json", upsert=True)
        if job_id is not None and worker_id is not None:
            await self._lock_colab_job_for_finalize(actor_id, job_id, run_id, worker_id, payload.profile)
        latest = await self.repo.one("""
            SELECT status, checkpoint_sha256, checkpoint_bytes, step, checkpoint_storage_path
            FROM public.viread_ocr_training_runs WHERE id=:run_id FOR UPDATE
        """, {"run_id": run_id})
        if not latest:
            await self.repo.rollback()
            raise HTTPException(status_code=409, detail="Training run cannot be completed")
        already_completed = (
            latest["status"] == "CANDIDATE"
            and latest["checkpoint_sha256"] == payload.checkpoint_sha256
            and int(latest["checkpoint_bytes"]) == payload.checkpoint_bytes
            and int(latest["step"]) == payload.step
        )
        if not already_completed and latest["status"] not in {"CREATED", "RUNNING"}:
            await self.repo.rollback()
            raise HTTPException(status_code=409, detail="Training run cannot be completed")
        try:
            if not already_completed:
                await self.repo.execute("""
                    UPDATE public.viread_ocr_training_runs SET status='CANDIDATE', checkpoint_sha256=:sha,
                        checkpoint_bytes=:bytes, checkpoint_storage_path=:path, step=:step,
                        metadata = metadata || CAST(:metadata AS jsonb), updated_at=now()
                    WHERE id=:run_id
                """, {"sha": payload.checkpoint_sha256, "bytes": total, "path": manifest_path,
                      "step": payload.step,
                      "metadata": json.dumps({
                          "checkpoint_chunks": len(chunks),
                          "storage_provider": manifest_provider,
                          "checkpoint_drive_file_id": manifest_drive_id,
                      }),
                      "run_id": run_id})
                if chunks_on_drive:
                    await self._exec_optional_column_update("""
                        UPDATE public.viread_ocr_training_runs
                        SET storage_provider = :provider, checkpoint_drive_file_id = :drive_id
                        WHERE id = :run_id
                    """, {"provider": manifest_provider, "drive_id": manifest_drive_id, "run_id": run_id})
            if job_id is not None and worker_id is not None:
                await self.repo.execute("""
                    UPDATE public.viread_ocr_training_runs SET metadata=metadata || CAST(:metadata AS jsonb)
                    WHERE id=:run_id
                """, {"run_id": run_id, "metadata": json.dumps({
                    "execution_target": "COLAB", "training_job_id": str(job_id), "worker_id": worker_id,
                })})
                await self.repo.execute("""
                    UPDATE public.viread_ocr_training_jobs
                    SET progress='{"stage":"benchmark"}'::jsonb, updated_at=now()
                    WHERE id=:id
                """, {"id": job_id})
            await self.repo.commit()
        except Exception:
            await self.repo.rollback()
            raise
        return {"run_id": run_id, "status": "CANDIDATE", "checkpoint_sha256": payload.checkpoint_sha256,
                "checkpoint_bytes": total, "manifest_storage_path": manifest_path, "chunk_count": len(chunks),
                "idempotent": already_completed}

    async def upload_flow1_model_chunk(
        self,
        actor_id: UUID,
        upload_id: UUID,
        chunk_index: int,
        data: bytes,
    ) -> dict[str, Any]:
        await self._admin(actor_id)
        if not data or len(data) > MAX_SHARD_BYTES:
            raise HTTPException(status_code=413, detail="Checkpoint shard must be between 1 byte and 40 MiB")
        if chunk_index == 0:
            is_zip = len(data) >= 4 and data[:4] == b"PK\x03\x04"
            is_pickle = len(data) >= 2 and data[:2] in (b"\x80\x02", b"\x80\x03", b"\x80\x04", b"\x80\x05")
            if not (is_zip or is_pickle):
                raise HTTPException(
                    status_code=422,
                    detail="Checkpoint file magic bytes are invalid; expected PyTorch .pth/.pt format",
                )
        digest = hashlib.sha256(data).hexdigest()
        path = f"ocr-training/checkpoints/flow1-manual/{upload_id}/{chunk_index:04d}-{digest}.part"
        await ensure_storage_capacity(self.db, len(data), existing_object_path=path)
        await self._release_read_txn()
        await asyncio.to_thread(upload_object, path, data, "application/octet-stream", upsert=True)
        return {
            "upload_id": str(upload_id),
            "chunk_index": chunk_index,
            "storage_path": path,
            "sha256": digest,
            "bytes": len(data),
        }

    async def activate_flow1_model(
        self,
        *,
        actor_id: UUID,
        upload_id: UUID,
        weights_filename: str,
        chunks_json: str,
        comparison_bytes: bytes,
        config_bytes: bytes | None = None,
        config_filename: str | None = None,
        model_version: str | None = None,
        reason: str | None = None,
    ) -> dict[str, Any]:
        await self._admin(actor_id)
        w_lower = weights_filename.lower()
        if not (w_lower.endswith(".pth") or w_lower.endswith(".pt")):
            raise HTTPException(status_code=422, detail="Weights file must end with .pth or .pt")

        if not comparison_bytes or len(comparison_bytes) > 2 * 1024 * 1024:
            raise HTTPException(status_code=422, detail="Comparison JSON file must be between 1 byte and 2 MiB")
        try:
            comp = json.loads(comparison_bytes.decode("utf-8"))
        except Exception:
            raise HTTPException(status_code=422, detail="Comparison file must be valid UTF-8 JSON")
        if not isinstance(comp, dict):
            raise HTTPException(status_code=422, detail="Comparison JSON must be an object")

        models = comp.get("models")
        if not isinstance(models, dict):
            raise HTTPException(status_code=422, detail="Comparison JSON missing 'models' object")
        baseline_name = models.get("baseline")
        has_finetuned = bool(
            models.get("finetuned_full_pipeline") or models.get("finetuned_model_only") or models.get("finetuned")
        )
        if not baseline_name or not has_finetuned:
            raise HTTPException(status_code=422, detail="Comparison JSON must define 'baseline' and at least one fine-tuned model")

        dataset_blocks: list[tuple[str, dict[str, Any]]] = []
        for key, val in comp.items():
            if key in {"models", "vietnamese_diacritics_errors", "metadata", "summary", "verdict"}:
                continue
            if isinstance(val, dict) and "cer_pct" in val and "wer_pct" in val:
                dataset_blocks.append((key, val))

        if not dataset_blocks:
            raise HTTPException(status_code=422, detail="Comparison JSON must contain at least one dataset block with cer_pct and wer_pct")

        normalized_datasets = []
        for key, block in dataset_blocks:
            cer_pct = block.get("cer_pct")
            wer_pct = block.get("wer_pct")
            if not isinstance(cer_pct, dict) or not isinstance(wer_pct, dict):
                raise HTTPException(status_code=422, detail=f"Dataset '{key}' must have object values for cer_pct and wer_pct")
            b_cer = cer_pct.get("baseline")
            b_wer = wer_pct.get("baseline")
            if b_cer is None or b_wer is None or not isinstance(b_cer, (int, float)) or not isinstance(b_wer, (int, float)):
                raise HTTPException(status_code=422, detail=f"Dataset '{key}' missing numeric baseline CER or WER")

            candidate_keys = [k for k in ("finetuned_full_pipeline", "finetuned_model_only", "finetuned") if k in cer_pct or k in wer_pct]
            if not candidate_keys:
                raise HTTPException(status_code=422, detail=f"Dataset '{key}' missing fine-tuned metrics in cer_pct or wer_pct")

            for c_key in candidate_keys:
                c_cer = cer_pct.get(c_key)
                c_wer = wer_pct.get(c_key)
                if c_cer is not None and isinstance(c_cer, (int, float)) and c_cer >= b_cer:
                    raise HTTPException(
                        status_code=422,
                        detail=f"Fine-tuned model does not improve CER over baseline on '{key}': {c_cer}% vs baseline {b_cer}%",
                    )
                if c_wer is not None and isinstance(c_wer, (int, float)) and c_wer >= b_wer:
                    raise HTTPException(
                        status_code=422,
                        detail=f"Fine-tuned model does not improve WER over baseline on '{key}': {c_wer}% vs baseline {b_wer}%",
                    )

            key_lower = key.lower()
            if "sgk" in key_lower or "real" in key_lower:
                label = "Tập sách giáo khoa thực tế (Real SGK Test Set)"
                sort_order = 0
            elif "overall" in key_lower:
                label = "Tập kiểm thử tổng hợp (Overall Test Set)"
                sort_order = 1
            else:
                label = key.replace("_", " ").title()
                sort_order = 2

            item: dict[str, Any] = {
                "key": key,
                "label": label,
                "_order": sort_order,
                "cer_pct": cer_pct,
                "wer_pct": wer_pct,
            }
            for optional_metric in ("exact_match_pct", "f1_score_pct", "gpu_infer_ms_per_line"):
                if optional_metric in block and isinstance(block[optional_metric], dict):
                    item[optional_metric] = block[optional_metric]
            normalized_datasets.append(item)

        normalized_datasets.sort(key=lambda d: (d["_order"], d["key"]))
        for d in normalized_datasets:
            d.pop("_order", None)

        diacritics_errors = None
        if "vietnamese_diacritics_errors" in comp and isinstance(comp["vietnamese_diacritics_errors"], dict):
            diacritics_errors = comp["vietnamese_diacritics_errors"]

        comparison_summary = {
            "models": {
                "baseline": str(baseline_name),
                "finetuned_model_only": models.get("finetuned_model_only"),
                "finetuned_full_pipeline": models.get("finetuned_full_pipeline"),
            },
            "datasets": normalized_datasets,
            "vietnamese_diacritics_errors": diacritics_errors,
            "verdict": "IMPROVED",
        }

        newly_uploaded_paths: list[str] = []
        try:
            config_info: dict[str, Any] | None = None
            config_sha: str | None = None
            if config_bytes and len(config_bytes) > 0:
                if not config_filename or not (config_filename.lower().endswith(".yml") or config_filename.lower().endswith(".yaml")):
                    raise HTTPException(status_code=422, detail="Configuration file must have a .yml or .yaml extension")
                if len(config_bytes) > 1024 * 1024:
                    raise HTTPException(status_code=422, detail="Configuration file must be at most 1 MiB")
                try:
                    cfg_parsed = yaml.safe_load(config_bytes.decode("utf-8"))
                except Exception:
                    raise HTTPException(status_code=422, detail="Configuration YAML syntax is invalid")
                if not isinstance(cfg_parsed, dict) or not cfg_parsed:
                    raise HTTPException(status_code=422, detail="Configuration YAML must be a non-empty mapping")

                config_storage_path = f"ocr-training/checkpoints/flow1-manual/{upload_id}/config.yml"
                await ensure_storage_capacity(self.db, len(config_bytes), existing_object_path=config_storage_path)
                await asyncio.to_thread(upload_object, config_storage_path, config_bytes, "application/x-yaml", upsert=True)
                newly_uploaded_paths.append(config_storage_path)
                config_sha = hashlib.sha256(config_bytes).hexdigest()
                config_info = {
                    "storage_path": config_storage_path,
                    "sha256": config_sha,
                    "filename": config_filename,
                }

            try:
                chunks = json.loads(chunks_json)
            except Exception:
                raise HTTPException(status_code=422, detail="chunks_json must be a valid JSON array")
            if not isinstance(chunks, list) or not chunks:
                raise HTTPException(status_code=422, detail="Chunks list cannot be empty")
            if any(not isinstance(c, dict) for c in chunks):
                raise HTTPException(status_code=422, detail="Chunks list must contain objects")
            try:
                chunk_indices = [int(c.get("index", -1)) for c in chunks]
            except (TypeError, ValueError):
                raise HTTPException(status_code=422, detail="Chunks are incomplete or not contiguous")
            if chunk_indices != list(range(len(chunks))):
                raise HTTPException(status_code=422, detail="Chunks are incomplete or not contiguous")

            chunk_path_re = re.compile(
                rf"^ocr-training/checkpoints/flow1-manual/{re.escape(str(upload_id))}/\d{{4}}-[0-9a-f]{{64}}\.part$"
            )
            verified_chunk_paths: list[str] = []
            for c in chunks:
                raw_chunk_path = c.get("path")
                if not isinstance(raw_chunk_path, str):
                    raise HTTPException(status_code=422, detail="Chunk storage path is invalid")
                try:
                    clean_chunk_path = validate_logical_path(raw_chunk_path, require_known_category=False)
                except ValueError as exc:
                    raise HTTPException(status_code=422, detail="Chunk storage path is invalid") from exc
                if clean_chunk_path != raw_chunk_path or not chunk_path_re.fullmatch(clean_chunk_path):
                    raise HTTPException(status_code=422, detail="Chunk storage path is invalid")
                verified_chunk_paths.append(clean_chunk_path)
            newly_uploaded_paths.extend(verified_chunk_paths)

            aggregate_digest = hashlib.sha256()
            total_bytes = 0
            for c, chunk_path in zip(chunks, verified_chunk_paths, strict=True):
                chunk_digest, chunk_bytes = await asyncio.to_thread(hash_storage_object, chunk_path, aggregate_digest)
                if chunk_bytes != int(c["bytes"]) or chunk_digest != c["sha256"]:
                    raise HTTPException(status_code=422, detail="Checkpoint shard failed integrity verification")
                total_bytes += chunk_bytes

            checkpoint_sha256 = aggregate_digest.hexdigest()
            checkpoint_bytes = total_bytes

            active = await self.repo.get_active_model_for_update()
            if active and active.get("checkpoint_sha256") == checkpoint_sha256:
                old_cfg_sha = None
                if active.get("storage_path"):
                    try:
                        old_m_bytes = await self._read_artifact_bytes(active["storage_path"])
                        old_m_data = json.loads(old_m_bytes.decode("utf-8"))
                        old_cfg_sha = old_m_data.get("config", {}).get("sha256") if isinstance(old_m_data.get("config"), dict) else None
                    except Exception:
                        pass
                if old_cfg_sha == config_sha:
                    raise HTTPException(status_code=409, detail="Checkpoint and configuration are identical to the currently active model")

            old_storage_path = active.get("storage_path") if active else None
            old_checkpoint_sha256 = active.get("checkpoint_sha256") if active else None
            old_object_paths: list[str] = []
            if old_storage_path and not is_gdrive_ref(old_storage_path):
                try:
                    old_manifest_bytes = await asyncio.to_thread(download_object, old_storage_path)
                    old_manifest = json.loads(old_manifest_bytes.decode("utf-8"))
                    for c in old_manifest.get("chunks", []):
                        if isinstance(c.get("path"), str):
                            old_object_paths.append(c["path"])
                    if isinstance(old_manifest.get("config"), dict) and old_manifest["config"].get("storage_path"):
                        old_object_paths.append(old_manifest["config"]["storage_path"])
                    old_object_paths.append(old_storage_path)
                except Exception as exc:
                    logger.warning("Could not read previous active manifest for cleanup: %s", exc)

            version_label = model_version.strip() if model_version and model_version.strip() else None
            if not version_label:
                version_label = models.get("finetuned_full_pipeline") or models.get("finetuned_model_only") or weights_filename.rsplit(".", 1)[0]
            version_label = version_label[:120]

            manifest = {
                "schema": "viread-checkpoint-shards-v1",
                "source": "flow1_manual_upload",
                "upload_id": str(upload_id),
                "checkpoint_sha256": checkpoint_sha256,
                "checkpoint_bytes": checkpoint_bytes,
                "chunks": [{"index": int(c["index"]), "path": c["path"], "sha256": c["sha256"], "bytes": int(c["bytes"])} for c in chunks],
                "config": config_info,
                "model_info": {
                    "version_label": version_label,
                    "weights_filename": weights_filename,
                    "config_source": "custom_yaml" if config_info else "default_vgg_transformer",
                    "config_filename": config_filename,
                    "uploaded_at": datetime.now(timezone.utc).isoformat(),
                    "uploaded_by": str(actor_id),
                },
                "comparison_summary": comparison_summary,
            }

            manifest_path = f"ocr-training/checkpoints/flow1-manual/{upload_id}/checkpoint.manifest.json"
            manifest_bytes = _canonical(manifest)
            await ensure_storage_capacity(self.db, len(manifest_bytes), existing_object_path=manifest_path)
            await asyncio.to_thread(upload_object, manifest_path, manifest_bytes, "application/json", upsert=True)
            newly_uploaded_paths.append(manifest_path)

            decision_id = uuid4()
            decision_reason = reason.strip() if reason and len(reason.strip()) >= 8 else f"Direct fine-tuned model replacement ({version_label})"

            await self.repo.insert_model_decision(
                decision_id=decision_id,
                action="APPROVE",
                candidate_sha=checkpoint_sha256,
                previous_sha=active["checkpoint_sha256"] if active else ORIGINAL_SHA256,
                candidate_path=manifest_path,
                previous_path=old_storage_path,
                candidate_profile="FLOW1_EXTERNAL_TRDG",
                previous_profile=active["profile"] if active else "ORIGINAL",
                benchmark_id=None,
                reason=decision_reason,
                actor_id=actor_id,
            )
            await self.repo.update_active_model(
                checkpoint_sha256=checkpoint_sha256,
                storage_path=manifest_path,
                profile="FLOW1_EXTERNAL_TRDG",
                decision_id=decision_id,
            )
            prev_provider = (
                StorageProvider.GOOGLE_DRIVE.value
                if is_gdrive_ref(old_storage_path)
                else StorageProvider.SUPABASE_LEGACY.value
            )
            await self._exec_optional_column_update("""
                UPDATE public.viread_ocr_active_model
                SET storage_provider = 'supabase_legacy', drive_file_id = NULL
                WHERE singleton = TRUE
            """, {})
            await self._exec_optional_column_update("""
                UPDATE public.viread_ocr_model_decisions
                SET candidate_storage_provider = 'supabase_legacy',
                    previous_storage_provider = :prev_provider
                WHERE id = :id
            """, {"prev_provider": prev_provider, "id": decision_id})
            await self.repo.commit()
        except Exception:
            await self.repo.rollback()
            for obj_path in set(newly_uploaded_paths):
                try:
                    await asyncio.to_thread(delete_object, obj_path)
                except Exception as del_err:
                    logger.warning("Could not delete orphan shard %s: %s", obj_path, del_err)
            raise

        from app.services.ocr_inference_job_service import (
            clear_active_model_manifest_cache,
            is_remote_ocr_mode,
        )

        evict_cached_viread_checkpoint = None
        clear_active_model_manifest_cache()
        if not is_remote_ocr_mode():
            from app.services.ocr_engine import (
                evict_cached_viread_checkpoint as _evict_cached,
                set_active_viread_model_cache,
            )

            evict_cached_viread_checkpoint = _evict_cached
            set_active_viread_model_cache({
                "checkpoint_sha256": checkpoint_sha256,
                "storage_path": manifest_path,
                "profile": "FLOW1_EXTERNAL_TRDG",
            })
        else:
            self._trigger_remote_ocr_wakeup_best_effort(reason="flow1_model_activated")
        invalidate_overview_manifest_cache()

        cleanup_status = {
            "previous_model_existed": bool(old_storage_path),
            "previous_storage_deleted": False,
            "deleted_object_count": 0,
            "local_cache_deleted": False,
            "warning": None,
        }
        if old_storage_path and old_storage_path != manifest_path and not is_gdrive_ref(old_storage_path):
            deleted_count = 0
            try:
                for obj_path in set(old_object_paths):
                    if is_gdrive_ref(obj_path):
                        continue
                    try:
                        await asyncio.to_thread(delete_object, obj_path)
                        deleted_count += 1
                    except Exception as del_err:
                        logger.warning("Could not delete old object %s: %s", obj_path, del_err)
                cleanup_status["previous_storage_deleted"] = True
                cleanup_status["deleted_object_count"] = deleted_count
            except Exception as exc:
                cleanup_status["warning"] = f"Storage deletion warning: {exc}"
                logger.warning("Failed deleting previous model storage objects: %s", exc)

            if old_checkpoint_sha256 and evict_cached_viread_checkpoint is not None:
                try:
                    evicted = evict_cached_viread_checkpoint(old_checkpoint_sha256)
                    cleanup_status["local_cache_deleted"] = evicted
                except Exception as exc:
                    logger.warning("Failed evicting cached checkpoint %s: %s", old_checkpoint_sha256, exc)

        return {
            "decision_id": decision_id,
            "active_model": {
                "checkpoint_sha256": checkpoint_sha256,
                "storage_path": manifest_path,
                "profile": "FLOW1_EXTERNAL_TRDG",
                "version_label": version_label,
                "updated_at": datetime.now(timezone.utc),
            },
            "cleanup": cleanup_status,
        }


    @staticmethod
    def _trigger_remote_ocr_wakeup_best_effort(*, reason: str) -> None:
        """Fire a non-blocking remote OCR worker wakeup so a newly active model is loaded immediately."""
        try:
            from app.services.ocr_inference_job_service import (
                trigger_remote_ocr_model_reload_wakeup,
            )

            trigger_remote_ocr_model_reload_wakeup(
                reason=reason,
                bypass_coalesce=True,
            )
        except Exception as exc:
            logger.warning("Best-effort remote OCR wakeup skipped (%s): %s", reason, type(exc).__name__)

    @staticmethod
    def _build_idempotent_benchmark_response(
        prior_benchmark: dict[str, Any],
        *,
        run_id: UUID,
        report_hash: str,
        evaluation_type: str,
    ) -> dict[str, Any]:
        if str(prior_benchmark["run_id"]) != str(run_id) or prior_benchmark["report_sha256"] != report_hash:
            raise HTTPException(status_code=409, detail="This sealed evaluation cohort has already been consumed")
        stored_metrics = prior_benchmark.get("metrics") or {}
        return {
            "benchmark_id": prior_benchmark["id"],
            "run_id": run_id,
            "gate_status": prior_benchmark["gate_status"],
            "promotion_allowed": (
                prior_benchmark["gate_status"] == "V2_WIN" and evaluation_type == "PRODUCTION"
            ),
            "sample_count": prior_benchmark["sample_count"],
            "group_count": prior_benchmark["group_count"],
            "report_sha256": report_hash,
            "report_storage_path": stored_metrics.get("report_storage_path"),
            "storage_provider": stored_metrics.get("storage_provider", StorageProvider.SUPABASE_LEGACY.value),
            "evaluation_type": evaluation_type,
            "metrics": {key: value for key, value in stored_metrics.items()
                        if key in {"cer", "wer"} or key.endswith(("_cer", "_wer"))},
            "quality_gate": stored_metrics.get("quality_gate"),
            "idempotent": True,
        }

    async def _lock_colab_job_for_benchmark(
        self,
        actor_id: UUID,
        job_id: UUID,
        worker_id: str,
        payload: BenchmarkCreate,
    ) -> None:
        job = await self.repo.one("""
            SELECT id, target, status, worker_id, run_id, created_by,
                   locked_test_version_id, locked_test_manifest_sha256,
                   (lease_expires_at IS NOT NULL AND lease_expires_at > now()) AS lease_active
            FROM public.viread_ocr_training_jobs WHERE id=:id FOR UPDATE
        """, {"id": job_id})
        if (
            not job
            or job["target"] != "COLAB"
            or job["status"] != "COLAB_RUNNING"
            or job["worker_id"] != worker_id
            or not job.get("lease_active", True)
            or str(job["created_by"]) != str(actor_id)
        ):
            await self.repo.rollback()
            raise HTTPException(status_code=409, detail="Training job lease is no longer owned by this worker")
        if (
            str(payload.run_id) != str(job["run_id"])
            or str(payload.locked_test_version_id) != str(job["locked_test_version_id"])
            or payload.locked_test_manifest_sha256 != job["locked_test_manifest_sha256"]
        ):
            await self.repo.rollback()
            raise HTTPException(status_code=422, detail="Benchmark dataset or run differs from the immutable job selection")

    async def _update_colab_job_benchmark_state(
        self,
        job_id: UUID,
        worker_id: str,
        *,
        gate_status: str,
        evaluation_type: str,
    ) -> None:
        await self.repo.execute("""
            UPDATE public.viread_ocr_training_jobs
            SET progress=CAST(:progress AS jsonb),
                metadata=metadata || CAST(:metadata AS jsonb),
                updated_at=now()
            WHERE id=:id AND target='COLAB' AND status='COLAB_RUNNING' AND worker_id=:worker_id
        """, {
            "id": job_id,
            "worker_id": worker_id,
            "progress": json.dumps({"stage": "benchmarked", "gate_status": gate_status}),
            "metadata": json.dumps({
                "evaluation_status": "COMPLETED",
                "evaluation_gate_status": gate_status,
                "evaluation_type": evaluation_type,
            }),
        })

    async def _fetch_prior_benchmark(
        self,
        *,
        cohort_id: Any | None,
        locked_test_version_id: UUID,
    ) -> dict[str, Any] | None:
        if cohort_id is not None:
            return await self.repo.one("""
                SELECT id, run_id, report_sha256, gate_status, sample_count, group_count, metrics
                FROM public.viread_ocr_benchmarks WHERE evaluation_cohort_id=:cohort_id LIMIT 1
            """, {"cohort_id": cohort_id})
        return await self.repo.one("""
            SELECT id, run_id, report_sha256, gate_status, sample_count, group_count, metrics
            FROM public.viread_ocr_benchmarks WHERE locked_test_version_id=:dataset_id LIMIT 1
        """, {"dataset_id": locked_test_version_id})

    async def benchmark(
        self,
        actor_id: UUID,
        payload: BenchmarkCreate,
        *,
        job_id: UUID | None = None,
        worker_id: str | None = None,
    ) -> dict[str, Any]:
        if (job_id is None) != (worker_id is None):
            raise ValueError("job_id and worker_id must be provided together")

        # Phase 1: short read-only validation transaction (NO FOR UPDATE locks).
        await self._admin(actor_id)
        run = await self.repo.one("""
            SELECT id, status, profile, parent_checkpoint_sha256, checkpoint_sha256
            FROM public.viread_ocr_training_runs WHERE id=:id
        """, {"id": payload.run_id})
        locked = await self.repo.one(
            "SELECT id, source_flow, version_sha256, is_locked_test, sample_count FROM public.viread_ocr_dataset_versions WHERE id=:id",
            {"id": payload.locked_test_version_id},
        )
        if not run or run["status"] not in {"CANDIDATE", "BENCHMARKED"} or not run["checkpoint_sha256"]:
            await self._release_read_txn()
            raise HTTPException(status_code=409, detail="Benchmark requires a completed candidate run")
        if not locked or locked["source_flow"] != "LOCKED_TEST" or not locked["is_locked_test"] or locked["version_sha256"] != payload.locked_test_manifest_sha256:
            await self._release_read_txn()
            raise HTTPException(status_code=422, detail="Locked Test version/hash is invalid")
        integrity = await self.repo.one("""
            SELECT count(sample.id)::integer AS sample_count,
                   count(DISTINCT sample.source_annotation_id)::integer AS unique_annotation_count,
                   count(DISTINCT sample.image_sha256)::integer AS unique_image_count,
                   count(DISTINCT COALESCE(page.bookid::text, sample.source_group_id))::integer AS group_count,
                   count(*) FILTER (WHERE sample.provenance->>'verified'='true'
                                    AND sample.source_annotation_id IS NOT NULL
                                    AND sample.provenance->>'annotation_id'=sample.source_annotation_id)::integer AS verified_count
            FROM public.viread_ocr_samples sample
            LEFT JOIN public.bookpages page ON page.id=sample.source_page_id
            WHERE sample.dataset_version_id=:dataset_id
              AND sample.source_flow='LOCKED_TEST' AND sample.split='locked_test'
        """, {"dataset_id": payload.locked_test_version_id})
        if (not integrity or int(integrity["sample_count"] or 0) != int(locked["sample_count"])
                or int(integrity["unique_annotation_count"] or 0) != int(locked["sample_count"])
                or int(integrity["unique_image_count"] or 0) != int(locked["sample_count"])
                or int(integrity["verified_count"] or 0) != int(locked["sample_count"])):
            await self._release_read_txn()
            raise HTTPException(status_code=409, detail="Locked Test snapshot has missing, duplicate, or unverified human-annotation rows")
        cohort = await self.repo.one("""
            SELECT id, evaluation_type, manifest_sha256, sample_count, group_count
            FROM public.viread_ocr_evaluation_cohorts WHERE dataset_version_id=:dataset_id
        """, {"dataset_id": payload.locked_test_version_id})
        if cohort and cohort["manifest_sha256"] != locked["version_sha256"]:
            await self._release_read_txn()
            raise HTTPException(status_code=409, detail="Evaluation cohort manifest hash changed")
        evaluation_type = cohort["evaluation_type"] if cohort else "PRODUCTION"
        minimum_samples, minimum_groups = ((MIN_PILOT_PAIRS, MIN_PILOT_GROUPS)
                                           if evaluation_type == "PILOT"
                                           else (MIN_LOCKED_PAIRS, MIN_LOCKED_GROUPS))
        if int(integrity["sample_count"]) < minimum_samples or int(integrity["group_count"] or 0) < minimum_groups:
            await self._release_read_txn()
            raise HTTPException(status_code=409, detail="Locked Test cohort does not meet its independent sample and document-group minimums")
        if cohort and (int(cohort["sample_count"]) != int(integrity["sample_count"])
                       or int(cohort["group_count"]) != int(integrity["group_count"])):
            await self._release_read_txn()
            raise HTTPException(status_code=409, detail="Evaluation cohort counts do not match its sealed dataset")
        prior_benchmark = await self._fetch_prior_benchmark(
            cohort_id=cohort["id"] if cohort else None,
            locked_test_version_id=payload.locked_test_version_id,
        )
        expected = await self.repo.all("""
            SELECT sample.source_annotation_id AS sample_id,
                   COALESCE(page.bookid::text, sample.source_group_id) AS group_id,
                   sample.label AS reference
            FROM public.viread_ocr_samples sample
            LEFT JOIN public.bookpages page ON page.id=sample.source_page_id
            WHERE sample.dataset_version_id=:dataset_id
              AND sample.source_flow='LOCKED_TEST' AND sample.split='locked_test'
        """, {"dataset_id": payload.locked_test_version_id})
        by_id = {item["sample_id"]: item for item in expected}
        outputs = [item.model_dump() for item in payload.outputs]
        if len(outputs) != len(by_id) or {item["sample_id"] for item in outputs} != set(by_id):
            await self._release_read_txn()
            raise HTTPException(status_code=422, detail="Benchmark outputs must cover every Locked Test sample exactly once")
        active = await self.repo.one("SELECT checkpoint_sha256 FROM public.viread_ocr_active_model WHERE singleton=TRUE")
        active_sha = active["checkpoint_sha256"] if active else None
        require_baselines = evaluation_type == "PRODUCTION"
        if require_baselines:
            if active_sha != run["parent_checkpoint_sha256"]:
                await self._release_read_txn()
                raise HTTPException(status_code=409, detail="Candidate parent is no longer active; preserve the candidate and evaluate a new lineage")
            if (payload.parent_checkpoint_sha256 != run["parent_checkpoint_sha256"]
                    or payload.active_checkpoint_sha256 != active_sha
                    or any(item.get("parent") is None or item.get("active") is None for item in outputs)):
                await self._release_read_txn()
                raise HTTPException(status_code=422, detail="Production benchmark must include parent and active model predictions with matching lineage hashes")
        if cohort and evaluation_type == "PILOT" and (payload.parent_checkpoint_sha256 or payload.active_checkpoint_sha256):
            if payload.parent_checkpoint_sha256 != run["parent_checkpoint_sha256"]:
                await self._release_read_txn()
                raise HTTPException(status_code=422, detail="Pilot parent checkpoint hash does not match the candidate lineage")
        paired = []
        for output in outputs:
            reference = by_id[output["sample_id"]]
            if output["group_id"] != reference["group_id"]:
                await self._release_read_txn()
                raise HTTPException(status_code=422, detail="Benchmark group ID does not match the sealed dataset")
            row = {"sample_id": output["sample_id"], "group_id": output["group_id"],
                   "reference": unicodedata.normalize("NFC", reference["reference"]),
                   "original": unicodedata.normalize("NFC", output["original"]),
                   "candidate": unicodedata.normalize("NFC", output["candidate"])}
            if output.get("parent") is not None:
                row["parent"] = unicodedata.normalize("NFC", output["parent"])
            if output.get("active") is not None:
                row["active"] = unicodedata.normalize("NFC", output["active"])
            paired.append(row)
        report_hash = hashlib.sha256(_canonical(paired)).hexdigest()
        if prior_benchmark:
            try:
                replay = self._build_idempotent_benchmark_response(
                    prior_benchmark,
                    run_id=payload.run_id,
                    report_hash=report_hash,
                    evaluation_type=evaluation_type,
                )
            except HTTPException:
                await self._release_read_txn()
                raise
            if job_id is not None and worker_id is not None:
                await self._lock_colab_job_for_benchmark(actor_id, job_id, worker_id, payload)
                await self._update_colab_job_benchmark_state(
                    job_id,
                    worker_id,
                    gate_status=replay["gate_status"],
                    evaluation_type=evaluation_type,
                )
                await self.repo.commit()
            else:
                await self._release_read_txn()
            return replay

        router = await self._artifact_router()
        use_drive_report = (
            _is_flow2_profile(run.get("profile"))
            and router.write_provider == StorageProvider.GOOGLE_DRIVE
        )
        # Release the read transaction before CPU bootstrap and Google Drive upload
        # so Supavisor/Postgres never sees an idle-in-transaction session or held row locks.
        await self._release_read_txn()

        # Phase 2: CPU paired cluster bootstrap + quality gate + Drive report upload (NO DB txn).
        cer_metric, wer_metric = await asyncio.gather(
            asyncio.to_thread(_paired_metric, paired, "cer"),
            asyncio.to_thread(_paired_metric, paired, "wer", seed=20261113),
        )
        metrics = {"sample_count": len(paired), "group_count": len({item["group_id"] for item in paired}),
                   "cer": cer_metric, "wer": wer_metric,
                   "outputs": paired, "original_checkpoint_sha256": ORIGINAL_SHA256,
                   "candidate_checkpoint_sha256": run["checkpoint_sha256"],
                   "parent_checkpoint_sha256": payload.parent_checkpoint_sha256 or run["parent_checkpoint_sha256"],
                   "active_checkpoint_sha256": payload.active_checkpoint_sha256 or active_sha,
                   "locked_test_manifest_sha256": locked["version_sha256"],
                   "evaluation_type": evaluation_type}
        if all("parent" in item for item in paired):
            metrics["parent_cer"], metrics["parent_wer"] = await asyncio.gather(
                asyncio.to_thread(_paired_metric, paired, "cer", baseline="parent"),
                asyncio.to_thread(_paired_metric, paired, "wer", baseline="parent", seed=20261113),
            )
        if all("active" in item for item in paired):
            metrics["active_cer"], metrics["active_wer"] = await asyncio.gather(
                asyncio.to_thread(_paired_metric, paired, "cer", baseline="active"),
                asyncio.to_thread(_paired_metric, paired, "wer", baseline="active", seed=20261113),
            )
        gate = _gate(metrics, manifest_sha=locked["version_sha256"], evaluation_type=evaluation_type,
                     require_model_baselines=require_baselines)
        benchmark_id = uuid4()
        full_report_payload = {
            **metrics,
            "benchmark_id": str(benchmark_id),
            "run_id": str(payload.run_id),
            "report_sha256": report_hash,
            "quality_gate": gate,
        }
        full_report_bytes = _canonical(full_report_payload)
        report_provider = StorageProvider.SUPABASE_LEGACY.value
        report_storage_path: str | None = None
        report_drive_file_id: str | None = None
        if use_drive_report:
            db_metrics_payload = {
                key: value for key, value in full_report_payload.items()
                if key != "outputs"
            }
            try:
                stored_report = await asyncio.to_thread(
                    router.put,
                    f"benchmarks/{payload.run_id}/benchmark-{report_hash[:16]}.json",
                    full_report_bytes,
                    content_type="application/json",
                    expected_sha256=hashlib.sha256(full_report_bytes).hexdigest(),
                    metadata={"run_id": str(payload.run_id), "report_sha256": report_hash},
                )
            except TrainingStorageError as exc:
                raise _storage_http_error(exc) from exc
            except (ValueError, KeyError) as exc:
                raise _storage_http_error(
                    TrainingStorageError(
                        f"Unexpected Drive bridge error while storing benchmark report: {exc}",
                        code="DRIVE_BRIDGE_RESPONSE_INVALID",
                        http_status=502,
                    )
                ) from exc
            report_provider = stored_report.provider.value
            report_storage_path = stored_report.reference
            report_drive_file_id = stored_report.drive_file_id
            db_metrics_payload["report_storage_path"] = report_storage_path
            db_metrics_payload["report_drive_file_id"] = report_drive_file_id
            db_metrics_payload["storage_provider"] = report_provider
        else:
            db_metrics_payload = {**metrics, "quality_gate": gate}

        # Phase 3: short atomic write transaction acquiring FOR UPDATE locks only for persistence.
        await ensure_database_capacity(self.db, len(_canonical(db_metrics_payload)) + 4096)
        if job_id is not None and worker_id is not None:
            await self._lock_colab_job_for_benchmark(actor_id, job_id, worker_id, payload)
        locked_for_write = await self.repo.one(
            "SELECT id, source_flow, version_sha256, is_locked_test, sample_count FROM public.viread_ocr_dataset_versions WHERE id=:id FOR UPDATE",
            {"id": payload.locked_test_version_id},
        )
        if (
            not locked_for_write
            or locked_for_write["source_flow"] != "LOCKED_TEST"
            or not locked_for_write["is_locked_test"]
            or locked_for_write["version_sha256"] != locked["version_sha256"]
        ):
            await self.repo.rollback()
            raise HTTPException(status_code=422, detail="Locked Test version/hash is invalid")
        cohort_for_write = await self.repo.one("""
            SELECT id, evaluation_type, manifest_sha256, sample_count, group_count
            FROM public.viread_ocr_evaluation_cohorts WHERE dataset_version_id=:dataset_id FOR UPDATE
        """, {"dataset_id": payload.locked_test_version_id})
        if cohort_for_write and cohort_for_write["manifest_sha256"] != locked["version_sha256"]:
            await self.repo.rollback()
            raise HTTPException(status_code=409, detail="Evaluation cohort manifest hash changed")
        effective_cohort_id = cohort_for_write["id"] if cohort_for_write else (cohort["id"] if cohort else None)
        prior_for_write = await self._fetch_prior_benchmark(
            cohort_id=effective_cohort_id,
            locked_test_version_id=payload.locked_test_version_id,
        )
        if prior_for_write:
            try:
                replay = self._build_idempotent_benchmark_response(
                    prior_for_write,
                    run_id=payload.run_id,
                    report_hash=report_hash,
                    evaluation_type=evaluation_type,
                )
            except HTTPException:
                await self.repo.rollback()
                raise
            if job_id is not None and worker_id is not None:
                await self._update_colab_job_benchmark_state(
                    job_id,
                    worker_id,
                    gate_status=replay["gate_status"],
                    evaluation_type=evaluation_type,
                )
                await self.repo.commit()
            else:
                await self.repo.rollback()
            return replay
        if require_baselines:
            latest_active = await self.repo.one(
                "SELECT checkpoint_sha256 FROM public.viread_ocr_active_model WHERE singleton=TRUE"
            )
            latest_active_sha = latest_active["checkpoint_sha256"] if latest_active else None
            if latest_active_sha != run["parent_checkpoint_sha256"]:
                await self.repo.rollback()
                raise HTTPException(
                    status_code=409,
                    detail="Candidate parent is no longer active; preserve the candidate and evaluate a new lineage",
                )

        try:
            await self.repo.execute("""
                INSERT INTO public.viread_ocr_benchmarks
                    (id, run_id, baseline_checkpoint_sha256, candidate_checkpoint_sha256,
                     locked_test_version_id, locked_test_manifest_sha256, report_sha256,
                     gate_status, sample_count, group_count, metrics, created_by,
                     evaluation_cohort_id, evaluation_type, parent_checkpoint_sha256, active_checkpoint_sha256)
                VALUES (:id, :run_id, :baseline_sha, :candidate_sha, :test_id, :test_sha,
                        :report_sha, :gate, :samples, :groups, CAST(:metrics AS jsonb), :actor_id,
                        :cohort_id, :evaluation_type, :parent_sha, :active_sha)
            """, {"id": benchmark_id, "run_id": payload.run_id, "baseline_sha": ORIGINAL_SHA256,
                  "candidate_sha": run["checkpoint_sha256"], "test_id": payload.locked_test_version_id,
                  "test_sha": locked["version_sha256"], "report_sha": report_hash, "gate": gate["status"],
                  "samples": len(paired), "groups": len({item["group_id"] for item in paired}),
                  "metrics": json.dumps(db_metrics_payload, ensure_ascii=False), "actor_id": actor_id,
                  "cohort_id": effective_cohort_id, "evaluation_type": evaluation_type,
                  "parent_sha": payload.parent_checkpoint_sha256 or run["parent_checkpoint_sha256"],
                  "active_sha": payload.active_checkpoint_sha256 or active_sha})
            if report_storage_path:
                await self._exec_optional_column_update("""
                    UPDATE public.viread_ocr_benchmarks
                    SET storage_provider = :provider,
                        report_storage_path = :report_path,
                        report_drive_file_id = :drive_id
                    WHERE id = :id
                """, {
                    "provider": report_provider,
                    "report_path": report_storage_path,
                    "drive_id": report_drive_file_id,
                    "id": benchmark_id,
                })
            await self.repo.execute("UPDATE public.viread_ocr_training_runs SET status='BENCHMARKED', updated_at=now() WHERE id=:id", {"id": payload.run_id})
            if job_id is not None and worker_id is not None:
                await self._update_colab_job_benchmark_state(
                    job_id,
                    worker_id,
                    gate_status=gate["status"],
                    evaluation_type=evaluation_type,
                )
            await self.repo.commit()
        except IntegrityError as exc:
            await self.repo.rollback()
            raced = await self._fetch_prior_benchmark(
                cohort_id=effective_cohort_id,
                locked_test_version_id=payload.locked_test_version_id,
            )
            if raced is not None:
                try:
                    replay = self._build_idempotent_benchmark_response(
                        raced,
                        run_id=payload.run_id,
                        report_hash=report_hash,
                        evaluation_type=evaluation_type,
                    )
                except HTTPException:
                    await self._release_read_txn()
                    raise
                if job_id is not None and worker_id is not None:
                    await self._lock_colab_job_for_benchmark(actor_id, job_id, worker_id, payload)
                    await self._update_colab_job_benchmark_state(
                        job_id,
                        worker_id,
                        gate_status=replay["gate_status"],
                        evaluation_type=evaluation_type,
                    )
                    await self.repo.commit()
                else:
                    await self._release_read_txn()
                return replay
            await self._release_read_txn()
            err_msg = str(exc).lower()
            if "viread_ocr_benchmarks_evaluation_cohort_uidx" in err_msg or "unique" in err_msg:
                raise HTTPException(
                    status_code=409,
                    detail="This sealed evaluation cohort has already been consumed",
                ) from exc
            raise
        except Exception:
            await self.repo.rollback()
            raise
        return {"benchmark_id": benchmark_id, "run_id": payload.run_id, "gate_status": gate["status"],
                "promotion_allowed": gate["promotion_allowed"], "sample_count": len(paired),
                "group_count": len({item["group_id"] for item in paired}), "report_sha256": report_hash,
                "report_storage_path": report_storage_path, "storage_provider": report_provider,
                "evaluation_type": evaluation_type,
                "metrics": {key: value for key, value in metrics.items()
                            if key in {"cer", "wer"} or key.endswith(("_cer", "_wer"))},
                "quality_gate": gate}

    async def request_candidate_evaluation(
        self, actor_id: UUID, job_id: UUID, evaluation_type: str,
    ) -> dict[str, Any]:
        """Queue evaluation of a retained candidate without invoking the trainer."""
        await self._admin(actor_id)
        job = await self.repo.one("""
            SELECT id, profile, status, target, dataset_version_id, manifest_sha256,
                   config_sha256, parent_checkpoint_sha256, run_id, created_by, metadata
            FROM public.viread_ocr_training_jobs WHERE id=:id FOR UPDATE
        """, {"id": job_id})
        if evaluation_type not in {"PILOT", "PRODUCTION"}:
            raise HTTPException(status_code=422, detail="Evaluation type must be PILOT or PRODUCTION")
        if not job or not job["run_id"] or job["created_by"] is None:
            raise HTTPException(status_code=409, detail="Training job does not contain a retained candidate")
        run = await self.repo.one("""
            SELECT id, profile, status, checkpoint_sha256, parent_checkpoint_sha256,
                   manifest_sha256, config_sha256
            FROM public.viread_ocr_training_runs WHERE id=:run_id FOR SHARE
        """, {"run_id": job["run_id"]})
        if (job["status"] not in {"CANDIDATE", "BENCHMARKED", "QUALITY_GATE_REJECTED"}
                or not run or run["profile"] != job["profile"]
                or run["checkpoint_sha256"] is None
                or run["manifest_sha256"] != job["manifest_sha256"]
                or run["config_sha256"] != job["config_sha256"]
                or run["parent_checkpoint_sha256"] != job["parent_checkpoint_sha256"]):
            raise HTTPException(status_code=409, detail="Candidate checkpoint or lineage is unavailable")

        if evaluation_type == "PILOT":
            readiness = await self.ensure_pilot_test(actor_id)
        else:
            readiness = await self.ensure_locked_test(actor_id)
        if readiness.get("status") != "READY":
            raise HTTPException(status_code=409, detail={
                "message": "No eligible independent evaluation cohort is ready",
                "evaluation_type": evaluation_type, "readiness": readiness,
            })
        cohort = await self.repo.one("""
            SELECT id, evaluation_type, manifest_sha256, sample_count, group_count
            FROM public.viread_ocr_evaluation_cohorts WHERE dataset_version_id=:dataset_id
        """, {"dataset_id": readiness["version_id"]})
        if not cohort or cohort["evaluation_type"] != evaluation_type or cohort["manifest_sha256"] != readiness["manifest_sha256"]:
            raise HTTPException(status_code=409, detail="Evaluation snapshot is missing its immutable cohort record")
        used = await self.repo.one("""
            SELECT id FROM public.viread_ocr_benchmarks
            WHERE evaluation_cohort_id=:cohort_id LIMIT 1
        """, {"cohort_id": cohort["id"]})
        if used:
            raise HTTPException(status_code=409, detail="This evaluation cohort was already consumed; a fresh independent cohort is required")
        active = await self.repo.one("SELECT checkpoint_sha256 FROM public.viread_ocr_active_model WHERE singleton=TRUE")
        if evaluation_type == "PRODUCTION" and (not active or active["checkpoint_sha256"] != run["parent_checkpoint_sha256"]):
            raise HTTPException(status_code=409, detail="Production evaluation requires the candidate parent to remain active; candidate checkpoint was retained")
        metadata = dict(job.get("metadata") or {})
        metadata.update({"operation": "BENCHMARK_ONLY", "evaluation_type": evaluation_type,
                         "evaluation_cohort_id": str(cohort["id"]),
                         "evaluation_status": "QUEUED", "candidate_checkpoint_sha256": run["checkpoint_sha256"]})
        await self.repo.execute("""
            UPDATE public.viread_ocr_training_jobs
            SET target='COLAB', status='WAITING_FOR_COLAB_WORKER',
                locked_test_version_id=:dataset_id, locked_test_manifest_sha256=:manifest_sha,
                evaluation_attempts=0, worker_id=NULL, lease_expires_at=NULL,
                available_at=now(), last_error_code=NULL,
                progress=CAST(:progress AS jsonb), metadata=CAST(:metadata AS jsonb), updated_at=now()
            WHERE id=:id
        """, {"dataset_id": readiness["version_id"], "manifest_sha": readiness["manifest_sha256"],
              "progress": json.dumps({"stage": "evaluation_queued", "evaluation_type": evaluation_type}),
              "metadata": json.dumps(metadata), "id": job_id})
        await self.repo.commit()
        return {"job_id": job_id, "run_id": run["id"], "status": "WAITING_FOR_COLAB_WORKER",
                "operation": "BENCHMARK_ONLY", "evaluation_type": evaluation_type,
                "cohort_id": cohort["id"], "sample_count": cohort["sample_count"],
                "group_count": cohort["group_count"], "trainer_will_run": False}

    async def candidate_artifact(
        self,
        actor_id: UUID,
        run_id: UUID,
        *,
        job_id: UUID | None = None,
        worker_id: str | None = None,
    ) -> dict[str, Any]:
        """Return a hash-checked checkpoint shard manifest with short-lived private URLs."""
        await self._admin(actor_id)
        run = await self.repo.one("""
            SELECT id, profile, status, checkpoint_sha256, checkpoint_bytes, checkpoint_storage_path,
                   parent_checkpoint_sha256, manifest_sha256, config_sha256
            FROM public.viread_ocr_training_runs WHERE id=:run_id
        """, {"run_id": run_id})
        if not run or run["status"] not in {"CANDIDATE", "BENCHMARKED"} or not run["checkpoint_storage_path"]:
            raise HTTPException(status_code=404, detail="Retained candidate checkpoint is unavailable")
        artifact_router = (
            await self._artifact_router()
            if is_gdrive_ref(run["checkpoint_storage_path"])
            else None
        )
        await self._release_read_txn()
        raw = await self._read_artifact_bytes(run["checkpoint_storage_path"], router=artifact_router)
        try:
            manifest = json.loads(raw)
        except (UnicodeDecodeError, json.JSONDecodeError) as exc:
            raise HTTPException(status_code=503, detail="Candidate checkpoint manifest is invalid") from exc
        if (manifest.get("schema") != "viread-checkpoint-shards-v1"
                or manifest.get("run_id") != str(run_id)
                or manifest.get("checkpoint_sha256") != run["checkpoint_sha256"]
                or int(manifest.get("checkpoint_bytes", -1)) != int(run["checkpoint_bytes"] or 0)
                or not isinstance(manifest.get("chunks"), list) or not manifest["chunks"]):
            raise HTTPException(status_code=503, detail="Candidate checkpoint manifest does not match its registered lineage")
        chunks = []
        for index, item in enumerate(manifest["chunks"]):
            if int(item.get("index", -1)) != index or not _sha(str(item.get("sha256", ""))):
                raise HTTPException(status_code=503, detail="Candidate checkpoint shard manifest is malformed")
            chunks.append({
                **item,
                "url": await self._artifact_download_url_async(
                    item["path"],
                    expected_sha256=item.get("sha256"),
                    job_id=job_id,
                    worker_id=worker_id,
                ),
                "storage_provider": (
                    StorageProvider.GOOGLE_DRIVE.value
                    if is_gdrive_ref(item["path"])
                    else StorageProvider.SUPABASE_LEGACY.value
                ),
                "drive_file_id": drive_file_id_from_reference(item["path"]),
            })
        return {
            **run,
            "storage_provider": (
                StorageProvider.GOOGLE_DRIVE.value
                if is_gdrive_ref(run["checkpoint_storage_path"])
                else StorageProvider.SUPABASE_LEGACY.value
            ),
            "drive_file_id": drive_file_id_from_reference(run["checkpoint_storage_path"]),
            "manifest_sha256": hashlib.sha256(raw).hexdigest(),
            "chunks": chunks,
        }

    async def decide(self, actor_id: UUID, payload: ModelDecisionRequest) -> dict[str, Any]:
        await self._admin(actor_id)
        verified_drive_path: str | None = None
        if payload.action == "APPROVE":
            if payload.run_id is None or payload.benchmark_id is None:
                raise HTTPException(status_code=422, detail="Approval requires both a candidate run and its Locked Test benchmark")
            # Phase 1 (short read txn, NO FOR UPDATE): validate candidate and verify Drive
            # artifact existence outside any row locks.
            pre_active = await self.repo.one(
                "SELECT checkpoint_sha256, storage_path, profile, decision_id FROM public.viread_ocr_active_model WHERE singleton=TRUE"
            )
            if not pre_active:
                await self._release_read_txn()
                raise HTTPException(status_code=503, detail="Active model registry is not initialized")
            pre_run = await self.repo.one("""
                SELECT id, profile, status, checkpoint_sha256, checkpoint_storage_path,
                       parent_checkpoint_sha256
                FROM public.viread_ocr_training_runs WHERE id=:id
            """, {"id": payload.run_id})
            pre_benchmark = await self.repo.one("""
                SELECT id, run_id, candidate_checkpoint_sha256, gate_status, evaluation_type,
                       parent_checkpoint_sha256, active_checkpoint_sha256
                FROM public.viread_ocr_benchmarks WHERE id=:id
            """, {"id": payload.benchmark_id})
            if (not pre_run or not pre_benchmark or pre_run["status"] != "BENCHMARKED"
                    or str(pre_benchmark["run_id"]) != str(pre_run["id"])
                    or pre_benchmark["candidate_checkpoint_sha256"] != pre_run["checkpoint_sha256"]
                    or pre_benchmark["gate_status"] != "V2_WIN"
                    or pre_benchmark["evaluation_type"] != "PRODUCTION"):
                await self._release_read_txn()
                raise HTTPException(status_code=409, detail="Candidate has no passing Production quality gate")
            if (pre_active["checkpoint_sha256"] != pre_run["parent_checkpoint_sha256"]
                    or pre_benchmark["parent_checkpoint_sha256"] != pre_run["parent_checkpoint_sha256"]
                    or pre_benchmark["active_checkpoint_sha256"] != pre_active["checkpoint_sha256"]):
                await self._release_read_txn()
                raise HTTPException(status_code=409, detail="Candidate parent/active lineage changed after evaluation")
            if pre_active["checkpoint_sha256"] == pre_run["checkpoint_sha256"]:
                await self._release_read_txn()
                raise HTTPException(status_code=409, detail="Candidate is already the active model")
            candidate_path = pre_run["checkpoint_storage_path"]
            if candidate_path and is_gdrive_ref(candidate_path):
                router = await self._artifact_router()
                await self._release_read_txn()
                try:
                    artifact_ok = await asyncio.to_thread(router.exists, candidate_path)
                except TrainingStorageError as exc:
                    raise _storage_http_error(exc) from exc
                except (ValueError, KeyError) as exc:
                    raise _storage_http_error(
                        TrainingStorageError(
                            f"Unexpected Drive bridge error while verifying candidate artifact: {exc}",
                            code="DRIVE_BRIDGE_RESPONSE_INVALID",
                            http_status=502,
                        )
                    ) from exc
                if not artifact_ok:
                    raise HTTPException(
                        status_code=409,
                        detail="Candidate checkpoint manifest is missing or trashed on Google Drive; refusing activation",
                    )
                verified_drive_path = candidate_path

        # Phase 2 (short atomic write txn with FOR UPDATE locks; zero Drive I/O).
        active = await self.repo.one("SELECT checkpoint_sha256, storage_path, profile, decision_id FROM public.viread_ocr_active_model WHERE singleton=TRUE FOR UPDATE")
        if not active:
            await self.repo.rollback()
            raise HTTPException(status_code=503, detail="Active model registry is not initialized")
        if payload.action == "APPROVE":
            run = await self.repo.one("""
                SELECT id, profile, status, checkpoint_sha256, checkpoint_storage_path,
                       parent_checkpoint_sha256
                FROM public.viread_ocr_training_runs WHERE id=:id FOR UPDATE
            """, {"id": payload.run_id})
            benchmark = await self.repo.one("""
                SELECT id, run_id, candidate_checkpoint_sha256, gate_status, evaluation_type,
                       parent_checkpoint_sha256, active_checkpoint_sha256
                FROM public.viread_ocr_benchmarks WHERE id=:id
            """, {"id": payload.benchmark_id})
            if (not run or not benchmark or run["status"] != "BENCHMARKED"
                    or str(benchmark["run_id"]) != str(run["id"])
                    or benchmark["candidate_checkpoint_sha256"] != run["checkpoint_sha256"]
                    or benchmark["gate_status"] != "V2_WIN"
                    or benchmark["evaluation_type"] != "PRODUCTION"):
                await self.repo.rollback()
                raise HTTPException(status_code=409, detail="Candidate has no passing Production quality gate")
            if (active["checkpoint_sha256"] != run["parent_checkpoint_sha256"]
                    or benchmark["parent_checkpoint_sha256"] != run["parent_checkpoint_sha256"]
                    or benchmark["active_checkpoint_sha256"] != active["checkpoint_sha256"]):
                await self.repo.rollback()
                raise HTTPException(status_code=409, detail="Candidate parent/active lineage changed after evaluation")
            if active["checkpoint_sha256"] == run["checkpoint_sha256"]:
                await self.repo.rollback()
                raise HTTPException(status_code=409, detail="Candidate is already the active model")
            next_sha, next_path, next_profile = run["checkpoint_sha256"], run["checkpoint_storage_path"], run["profile"]
            if next_path and is_gdrive_ref(next_path) and next_path != verified_drive_path:
                await self.repo.rollback()
                raise HTTPException(
                    status_code=409,
                    detail="Candidate checkpoint storage path changed during activation; retry approval",
                )
            action_benchmark = payload.benchmark_id
        else:
            if active["profile"] == "ORIGINAL" or active["decision_id"] is None:
                await self.repo.rollback()
                raise HTTPException(status_code=409, detail="Original is already active; there is nothing to roll back")
            prior = await self.repo.one("SELECT action, candidate_checkpoint_sha256, previous_checkpoint_sha256, candidate_storage_path, previous_storage_path, candidate_profile, previous_profile FROM public.viread_ocr_model_decisions WHERE id=:id", {"id": active["decision_id"]})
            if not prior or prior["action"] != "APPROVE":
                await self.repo.rollback()
                raise HTTPException(status_code=409, detail="Rollback is only available from the latest approved V2 model")
            next_sha, next_path, next_profile = prior["previous_checkpoint_sha256"], prior["previous_storage_path"], prior["previous_profile"]
            action_benchmark = None
        decision_id = uuid4()
        next_provider = (
            StorageProvider.GOOGLE_DRIVE.value
            if is_gdrive_ref(next_path)
            else StorageProvider.SUPABASE_LEGACY.value
        )
        previous_provider = (
            StorageProvider.GOOGLE_DRIVE.value
            if is_gdrive_ref(active.get("storage_path"))
            else StorageProvider.SUPABASE_LEGACY.value
        )
        next_drive_id = drive_file_id_from_reference(next_path)
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
            await self._exec_optional_column_update("""
                UPDATE public.viread_ocr_model_decisions
                SET candidate_storage_provider=:cand_provider, previous_storage_provider=:prev_provider
                WHERE id=:id
            """, {"cand_provider": next_provider, "prev_provider": previous_provider, "id": decision_id})
            await self._exec_optional_column_update("""
                UPDATE public.viread_ocr_active_model
                SET storage_provider=:provider, drive_file_id=:drive_id
                WHERE singleton=TRUE
            """, {"provider": next_provider, "drive_id": next_drive_id})
            await self.repo.commit()
        except Exception:
            await self.repo.rollback()
            raise

        invalidate_overview_manifest_cache()
        from app.services.ocr_inference_job_service import (
            clear_active_model_manifest_cache,
            is_remote_ocr_mode,
        )

        clear_active_model_manifest_cache()
        if not is_remote_ocr_mode():
            from app.services.ocr_engine import set_active_viread_model_cache

            set_active_viread_model_cache({
                "checkpoint_sha256": next_sha,
                "storage_path": next_path,
                "profile": next_profile,
            })
        else:
            self._trigger_remote_ocr_wakeup_best_effort(
                reason=f"model_{payload.action.lower()}"
            )
        return {"decision_id": decision_id, "action": payload.action,
                "active_model": {"checkpoint_sha256": next_sha, "storage_path": next_path,
                                 "storage_provider": next_provider, "drive_file_id": next_drive_id,
                                 "profile": next_profile, "updated_at": datetime.now(timezone.utc)}}
