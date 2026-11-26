"""Flow 2 — Admin Verified Clean Sample Ingestion Tool (Google Drive-First).

Validates authorized Vietnamese OCR line crops & verified ground-truth labels,
rejects blurry/clipped/unverified/duplicate/leaking samples, uploads verified
PNG + label JSON to Google Drive via TrainingArtifactStoreRouter, registers
idempotent rows in public.viread_ocr_samples, and optionally creates a new
immutable Flow 2 dataset manifest.

Usage:
    python scripts/flow2_clean_ingest.py --manifest path/to/samples.jsonl --dry-run
    python scripts/flow2_clean_ingest.py --manifest path/to/samples.jsonl --pending-out pending_review.jsonl --build-manifest
"""
from __future__ import annotations

import argparse
import asyncio
import hashlib
import json
import sys
import unicodedata
from dataclasses import dataclass, field
from io import BytesIO
from pathlib import Path
from typing import Any
from uuid import NAMESPACE_URL, UUID, uuid5

from PIL import Image, ImageFilter, ImageStat

REPO_ROOT = Path(__file__).resolve().parents[1]
BACKEND_DIR = REPO_ROOT / "backend"
if str(BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(BACKEND_DIR))

from app.services.viread_flow2_hygiene import (
    DEFAULT_MAX_LABEL_LENGTH,
    MIN_LINE_EDGE_VARIANCE,
    MIN_LINE_HEIGHT_PX,
    MIN_LINE_STDDEV,
    MIN_LINE_WIDTH_PX,
    detect_vietnamese_pii_strict,
    open_image_exif_safe,
    sanitize_and_validate_vietocr_label,
    validate_flow2_line_crop,
)

ALLOWED_RIGHTS_BASES = frozenset({
    "owner_supplied",
    "owner_authorized",
    "licensed",
    "public_domain",
    "cc_by",
    "cc0",
})

MIN_WIDTH_PX = MIN_LINE_WIDTH_PX
MIN_HEIGHT_PX = MIN_LINE_HEIGHT_PX
MIN_STDDEV = MIN_LINE_STDDEV
MIN_EDGE_VARIANCE = MIN_LINE_EDGE_VARIANCE
MAX_LABEL_LEN = DEFAULT_MAX_LABEL_LENGTH


@dataclass
class ValidatedSample:
    sample_id: str
    source_group_id: str
    split: str
    label: str
    label_sha256: str
    image_bytes: bytes
    image_sha256: str
    line_index: int
    source_name: str
    rights_basis: str
    verified_by: str
    verified_at: str
    source_page_id: str | None
    source_revision_id: str | None
    provenance: dict[str, Any] = field(default_factory=dict)


@dataclass
class RejectedSample:
    row_index: int
    reason_code: str
    detail: str
    route_to_pending_review: bool
    raw: dict[str, Any]


def normalize_label_nfc(raw_label: str) -> str:
    cleaned, reason = sanitize_and_validate_vietocr_label(raw_label, max_length=MAX_LABEL_LEN)
    if cleaned is None:
        raise ValueError(reason or "INVALID_LABEL")
    return cleaned


def stable_flow2_split(group_id: str) -> str:
    digest = hashlib.sha256(f"viread-vietocr-v2-split-v1\0{group_id}".encode("utf-8")).hexdigest()
    value = int(digest[:8], 16) / 0xFFFFFFFF
    if value < 0.70:
        return "train"
    if value < 0.85:
        return "validation"
    return "holdout"


def deterministic_clean_sample_id(source_group_id: str, line_index: int, image_sha256: str) -> str:
    return str(
        uuid5(
            NAMESPACE_URL,
            f"viread-flow2-clean-sample:{source_group_id}:{line_index}:{image_sha256}",
        )
    )


def validate_image_quality(
    image_bytes: bytes,
    *,
    label: str | None = None,
) -> tuple[bool, str | None, bytes]:
    """Validate image readability, EXIF orientation, dimensions, contrast, and sharpness; return canonical PNG bytes."""
    try:
        rgb = open_image_exif_safe(image_bytes)
    except Exception:
        return False, "UNREADABLE_IMAGE", b""

    ok, _metrics, reason = validate_flow2_line_crop(rgb, label=label)
    if not ok:
        if reason == "LOW_CONTRAST_OR_BLANK":
            return False, "BLANK_OR_LOW_CONTRAST", b""
        if reason == "BLURRY_OR_LOW_EDGE_DETAIL":
            return False, "TOO_BLURRY", b""
        return False, reason or "IMAGE_QUALITY_REJECTED", b""

    buf = BytesIO()
    rgb.save(buf, format="PNG", optimize=True)
    png_bytes = buf.getvalue()
    if not png_bytes:
        return False, "EMPTY_PNG_OUTPUT", b""
    return True, None, png_bytes


def validate_batch(
    records: list[dict[str, Any]],
    *,
    base_dir: Path,
    locked_test_hashes: set[str] | None = None,
    locked_test_groups: set[str] | None = None,
    existing_eligible_labels: dict[str, str] | None = None,
) -> tuple[list[ValidatedSample], list[RejectedSample]]:
    """Apply all verification, rights, quality, PII, vocab, dedup, and leakage gates to a batch of candidate records."""
    locked_hashes = {h.lower() for h in (locked_test_hashes or set())}
    locked_groups = set(locked_test_groups or set())
    known_labels = {k.lower(): unicodedata.normalize("NFC", v) for k, v in (existing_eligible_labels or {}).items()}

    accepted: list[ValidatedSample] = []
    rejected: list[RejectedSample] = []
    seen_hashes: dict[str, str] = {}
    group_splits: dict[str, str] = {}

    for idx, raw in enumerate(records):
        status = str(raw.get("verification_status") or "").strip().upper()
        # Require explicit verification_source == "admin" (never silently default missing field to admin).
        ver_source = str(raw.get("verification_source") or "").strip().lower()
        verified_by = str(raw.get("verified_by") or "").strip()
        verified_at = str(raw.get("verified_at") or "").strip()
        ai_review_required = bool(raw.get("ai_review_required", False))

        # 1. Strict verification gate: unverified or AI-only never enters training pool
        if status != "VERIFIED" or ver_source != "admin" or ai_review_required or not verified_by:
            rejected.append(
                RejectedSample(
                    row_index=idx,
                    reason_code="NOT_ADMIN_VERIFIED",
                    detail="Sample is not explicitly Admin VERIFIED (requires verification_status=VERIFIED, verification_source=admin, verified_by); routed to pending review.",
                    route_to_pending_review=True,
                    raw=raw,
                )
            )
            continue

        # 2. Rights gate
        rights_basis = str(raw.get("rights_basis") or "").strip().lower()
        source_name = str(raw.get("source_name") or "").strip()
        source_group_id = str(raw.get("source_group_id") or "").strip()
        if rights_basis not in ALLOWED_RIGHTS_BASES or not source_name or not source_group_id:
            rejected.append(
                RejectedSample(
                    row_index=idx,
                    reason_code="MISSING_RIGHTS_OR_SOURCE",
                    detail=f"rights_basis='{rights_basis}' must be in {sorted(ALLOWED_RIGHTS_BASES)} with source_name & source_group_id.",
                    route_to_pending_review=True,
                    raw=raw,
                )
            )
            continue

        # 3. Leakage gate (group-level)
        if source_group_id in locked_groups:
            rejected.append(
                RejectedSample(
                    row_index=idx,
                    reason_code="LOCKED_TEST_GROUP_LEAKAGE",
                    detail=f"source_group_id '{source_group_id}' overlaps LOCKED_TEST or holdout.",
                    route_to_pending_review=False,
                    raw=raw,
                )
            )
            continue

        # 4. Label & VietOCR vocab + contact PII gate
        try:
            label = normalize_label_nfc(str(raw.get("label") or ""))
        except ValueError as exc:
            code = str(exc)
            rejected.append(
                RejectedSample(
                    row_index=idx,
                    reason_code="INVALID_LABEL_LENGTH" if code in {"EMPTY_LABEL", "LABEL_TOO_LONG"} else code,
                    detail=f"Label failed hygiene validation: {code}",
                    route_to_pending_review=True,
                    raw=raw,
                )
            )
            continue
        pii_flags = detect_vietnamese_pii_strict(label, mode="contact_only")
        if pii_flags:
            rejected.append(
                RejectedSample(
                    row_index=idx,
                    reason_code="PII_DETECTED",
                    detail=f"Label contains sensitive contact/ID pattern: {', '.join(pii_flags)}",
                    route_to_pending_review=True,
                    raw=raw,
                )
            )
            continue

        # 5. Image load & quality gate
        img_rel = str(raw.get("image_path") or "").strip()
        img_path = Path(img_rel)
        if not img_path.is_absolute():
            img_path = (base_dir / img_path).resolve()
        if not img_path.is_file():
            rejected.append(
                RejectedSample(
                    row_index=idx,
                    reason_code="IMAGE_FILE_NOT_FOUND",
                    detail=f"Missing image file: {img_rel}",
                    route_to_pending_review=False,
                    raw=raw,
                )
            )
            continue

        ok, err_code, png_bytes = validate_image_quality(img_path.read_bytes(), label=label)
        if not ok:
            rejected.append(
                RejectedSample(
                    row_index=idx,
                    reason_code=err_code or "IMAGE_QUALITY_REJECTED",
                    detail=f"Image failed quality check: {err_code}",
                    route_to_pending_review=False,
                    raw=raw,
                )
            )
            continue

        image_sha = hashlib.sha256(png_bytes).hexdigest()
        label_sha = hashlib.sha256(label.encode("utf-8")).hexdigest()

        # 6. Leakage gate (image hash)
        if image_sha in locked_hashes:
            rejected.append(
                RejectedSample(
                    row_index=idx,
                    reason_code="LOCKED_TEST_IMAGE_LEAKAGE",
                    detail="Image SHA-256 already exists in LOCKED_TEST or holdout.",
                    route_to_pending_review=False,
                    raw=raw,
                )
            )
            continue

        # 7. Conflict & dedup gate
        if image_sha in known_labels and known_labels[image_sha] != label:
            rejected.append(
                RejectedSample(
                    row_index=idx,
                    reason_code="CONFLICTING_LABEL_EXISTING_POOL",
                    detail="Image SHA-256 conflicts with an existing eligible pool label.",
                    route_to_pending_review=True,
                    raw=raw,
                )
            )
            continue
        if image_sha in seen_hashes:
            code = "DUPLICATE_IN_BATCH" if seen_hashes[image_sha] == label else "CONFLICTING_LABEL_IN_BATCH"
            rejected.append(
                RejectedSample(
                    row_index=idx,
                    reason_code=code,
                    detail="Duplicate image SHA-256 detected in batch.",
                    route_to_pending_review=(code == "CONFLICTING_LABEL_IN_BATCH"),
                    raw=raw,
                )
            )
            continue

        line_index = int(raw.get("line_index", idx))
        requested_split = str(raw.get("split") or "").strip().lower()
        split = requested_split if requested_split in {"train", "validation", "holdout"} else stable_flow2_split(source_group_id)
        existing_group_split = group_splits.get(source_group_id)
        if existing_group_split is not None and existing_group_split != split:
            rejected.append(
                RejectedSample(
                    row_index=idx,
                    reason_code="GROUP_SPLIT_LEAKAGE_IN_BATCH",
                    detail=f"source_group_id '{source_group_id}' appeared in multiple splits ({existing_group_split} vs {split}).",
                    route_to_pending_review=True,
                    raw=raw,
                )
            )
            continue
        group_splits[source_group_id] = split
        seen_hashes[image_sha] = label
        sample_id = deterministic_clean_sample_id(source_group_id, line_index, image_sha)

        accepted.append(
            ValidatedSample(
                sample_id=sample_id,
                source_group_id=source_group_id,
                split=split,
                label=label,
                label_sha256=label_sha,
                image_bytes=png_bytes,
                image_sha256=image_sha,
                line_index=line_index,
                source_name=source_name,
                rights_basis=rights_basis,
                verified_by=verified_by,
                verified_at=verified_at,
                source_page_id=raw.get("source_page_id"),
                source_revision_id=raw.get("source_revision_id"),
                provenance={
                    "sample_id": sample_id,
                    "source_name": source_name,
                    "rights_basis": rights_basis,
                    "group_id": source_group_id,
                    "line_index": line_index,
                    "image_sha256": image_sha,
                    "label_sha256": label_sha,
                    "verified_by": verified_by,
                    "verified_at": verified_at,
                    "verified_by_admin": True,
                    "ai_review_required": False,
                    "verification_source": "admin",
                    "ingest_pipeline": "flow2_clean_ingest_v1",
                },
            )
        )

    return accepted, rejected


async def ingest_validated_samples(
    samples: list[ValidatedSample],
    *,
    db,
    router,
) -> dict[str, int]:
    """Upload verified line PNG + label JSON to Google Drive and insert idempotent DB rows."""
    from sqlalchemy import text

    inserted_count = 0
    skipped_existing = 0
    for sample in samples:
        folder = f"verified-samples/{sample.source_group_id}"
        img_name = f"line-{sample.line_index:04d}-{sample.image_sha256[:12]}.png"
        lbl_name = f"line-{sample.line_index:04d}-{sample.image_sha256[:12]}.json"

        stored_img = await asyncio.to_thread(
            router.put,
            f"{folder}/{img_name}",
            sample.image_bytes,
            content_type="image/png",
            expected_sha256=sample.image_sha256,
        )
        label_payload = json.dumps(
            {
                "sample_id": sample.sample_id,
                "source_group_id": sample.source_group_id,
                "line_index": sample.line_index,
                "label": sample.label,
                "label_sha256": sample.label_sha256,
                "image_sha256": sample.image_sha256,
                "image_reference": stored_img.reference,
                "source_name": sample.source_name,
                "rights_basis": sample.rights_basis,
                "verified_by": sample.verified_by,
                "verified_at": sample.verified_at,
                "verification_source": "admin",
            },
            ensure_ascii=False,
            sort_keys=True,
        ).encode("utf-8")
        stored_lbl = await asyncio.to_thread(
            router.put,
            f"{folder}/{lbl_name}",
            label_payload,
            content_type="application/json",
        )
        provenance = {
            **sample.provenance,
            "image_reference": stored_img.reference,
            "label_reference": stored_lbl.reference,
            "storage_provider": stored_img.provider.value,
        }
        result = await db.execute(
            text(
                """
                INSERT INTO public.viread_ocr_samples
                    (id, source_flow, source_group_id, split, image_storage_path, image_sha256,
                     label, source_page_id, source_revision_id, provenance,
                     storage_provider, drive_file_id, label_storage_path,
                     label_drive_file_id, label_sha256, sync_status, training_eligibility)
                VALUES (CAST(:sample_id AS uuid), 'FLOW1_VERIFIED', :group_id, :split, :image_ref,
                        :image_sha, :label, CAST(:page_id AS uuid), CAST(:revision_id AS uuid),
                        CAST(:provenance AS jsonb), :storage_provider, :drive_file_id,
                        :label_ref, :label_drive_file_id, :label_sha, 'SYNCED', 'ELIGIBLE')
                ON CONFLICT DO NOTHING
                """
            ),
            {
                "sample_id": sample.sample_id,
                "group_id": sample.source_group_id,
                "split": sample.split,
                "image_ref": stored_img.reference,
                "image_sha": sample.image_sha256,
                "label": sample.label,
                "page_id": sample.source_page_id,
                "revision_id": sample.source_revision_id,
                "provenance": json.dumps(provenance, ensure_ascii=False),
                "storage_provider": stored_img.provider.value,
                "drive_file_id": stored_img.drive_file_id,
                "label_ref": stored_lbl.reference,
                "label_drive_file_id": stored_lbl.drive_file_id,
                "label_sha": sample.label_sha256,
            },
        )
        if result.rowcount:
            inserted_count += 1
        else:
            skipped_existing += 1
    await db.commit()
    return {"inserted": inserted_count, "skipped_existing": skipped_existing}


async def _run_cli(args: argparse.Namespace) -> int:
    from dotenv import load_dotenv
    from sqlalchemy import text

    load_dotenv(BACKEND_DIR / ".env", override=False)
    from app.database.session import AsyncSessionLocal
    from app.services.viread_drive_connection_service import VireadDriveConnectionService
    from app.services.viread_ocr_training_service import VireadOcrTrainingService

    manifest_path = Path(args.manifest).resolve()
    raw_lines = [line.strip() for line in manifest_path.read_text(encoding="utf-8").splitlines() if line.strip()]
    records = [json.loads(line) for line in raw_lines]

    async with AsyncSessionLocal() as db:
        lt_rows = (
            await db.execute(
                text(
                    """
                    SELECT s.image_sha256, COALESCE(p.bookid::text, s.source_group_id) AS group_id
                    FROM public.viread_ocr_samples s
                    LEFT JOIN public.bookpages p ON p.id = s.source_page_id
                    WHERE s.source_flow = 'LOCKED_TEST'
                       OR (
                           s.source_flow = 'FLOW1_VERIFIED'
                           AND s.dataset_version_id IS NULL
                           AND s.split = 'holdout'
                           AND COALESCE(to_jsonb(s)->>'training_eligibility', 'ELIGIBLE') = 'ELIGIBLE'
                       )
                    """
                )
            )
        ).mappings().all()
        locked_hashes = {str(r["image_sha256"]) for r in lt_rows}
        locked_groups = {str(r["group_id"]) for r in lt_rows}

        existing_rows = (
            await db.execute(
                text(
                    """
                    SELECT image_sha256, label
                    FROM public.viread_ocr_samples s
                    WHERE s.source_flow = 'FLOW1_VERIFIED'
                      AND COALESCE(to_jsonb(s)->>'training_eligibility', 'ELIGIBLE') = 'ELIGIBLE'
                    """
                )
            )
        ).mappings().all()
        existing_labels = {str(r["image_sha256"]): str(r["label"]) for r in existing_rows}

        accepted, rejected = validate_batch(
            records,
            base_dir=manifest_path.parent,
            locked_test_hashes=locked_hashes,
            locked_test_groups=locked_groups,
            existing_eligible_labels=existing_labels,
        )

        pending = [r for r in rejected if r.route_to_pending_review]
        if args.pending_out and pending:
            Path(args.pending_out).write_text(
                "\n".join(
                    json.dumps(
                        {"row_index": r.row_index, "reason_code": r.reason_code, "detail": r.detail, "raw": r.raw},
                        ensure_ascii=False,
                    )
                    for r in pending
                )
                + "\n",
                encoding="utf-8",
            )

        summary: dict[str, Any] = {
            "dry_run": bool(args.dry_run),
            "input_records": len(records),
            "accepted": len(accepted),
            "rejected": len(rejected),
            "routed_to_pending_review": len(pending),
            "rejection_reasons": {},
        }
        for r in rejected:
            summary["rejection_reasons"][r.reason_code] = summary["rejection_reasons"].get(r.reason_code, 0) + 1

        if not args.dry_run and accepted:
            router = await VireadDriveConnectionService(db).build_artifact_router()
            summary["ingest"] = await ingest_validated_samples(accepted, db=db, router=router)
            if args.build_manifest:
                admin_id = (
                    await db.execute(
                        text("SELECT id FROM public.profiles WHERE role = 'admin' AND active = 1 LIMIT 1")
                    )
                ).scalar_one()
                summary["dataset_manifest"] = await VireadOcrTrainingService(db).admin_verified_manifest(
                    UUID(str(admin_id)), limit=1, offset=0
                )

        print(json.dumps(summary, default=str, ensure_ascii=False, indent=2))
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description="Flow 2 clean sample ingestion tool (Google Drive-first).")
    parser.add_argument("--manifest", required=True, help="Path to JSONL file of candidate verified samples.")
    parser.add_argument("--pending-out", default="", help="Optional JSONL path for samples routed to pending review.")
    parser.add_argument("--dry-run", action="store_true", help="Validate only; do not write to Drive or DB.")
    parser.add_argument("--build-manifest", action="store_true", help="Create immutable Flow 2 dataset manifest after ingest.")
    args = parser.parse_args()
    return asyncio.run(_run_cli(args))


if __name__ == "__main__":
    raise SystemExit(main())
