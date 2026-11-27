from __future__ import annotations

import asyncio
from collections import defaultdict
from datetime import datetime
import hashlib
from io import BytesIO
import json
import logging
import math
import os
from typing import Any
import unicodedata
from uuid import NAMESPACE_URL, uuid5

from PIL import Image
from sqlalchemy import text

from app.database.config import SUPABASE_PRIVATE_BOOKS_BUCKET
from app.database.session import AsyncSessionLocal
from app.diagnostic_logging import log_diagnostic
from app.services.parent_flow2_contribution_service import (
    ALLOWED_TRAINING_RIGHTS,
    detect_line_pii,
    evaluate_line_crop_quality,
    normalize_and_validate_ocr_label,
)
from app.services.storage_service import download_object
from app.services.training_storage import (
    DriveAuthError,
    DriveQuotaExceededError,
    StorageProvider,
    TrainingArtifactStoreRouter,
    TrainingStorageError,
)
from app.services.viread_drive_connection_service import VireadDriveConnectionService
from app.services.viread_flow2_hygiene import (
    compute_line_crop_box,
    detect_vietnamese_pii_strict,
    open_image_exif_safe,
    sanitize_and_validate_vietocr_label,
    validate_flow2_line_crop,
    validate_line_word_geometry,
)
from app.services.viread_training_storage_quota import (
    ensure_database_capacity,
    ensure_storage_capacity,
)
from app.services.worker_telemetry import (
    persist_worker_heartbeat_with_factory,
    record_worker_error,
    record_worker_success,
)

logger = logging.getLogger(__name__)
MAX_ATTEMPTS = 8
POLL_SECONDS = 5
# Claims expire after ten minutes in _claim_one. Refresh well before that,
# including when Storage downloads/uploads are taking a long time.
LEASE_HEARTBEAT_SECONDS = 60
LEASE_HEARTBEAT_TIMEOUT_SECONDS = 5


class OutboxLeaseLost(RuntimeError):
    """Stop side effects when another worker has reclaimed this event."""


class OutboxEventSkipped(RuntimeError):
    """Event is intentionally ineligible for Flow 2 training (e.g. AI-only auto-verified)."""

    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code


class OutboxEventBlocked(RuntimeError):
    """Event cannot be ingested safely without Admin inspection (e.g. duplicate image hash conflict)."""

    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code


def is_flow2_ingestion_paused() -> bool:
    return os.getenv("VIREAD_FLOW2_INGESTION_PAUSED", "false").strip().lower() in {
        "1",
        "true",
        "yes",
        "on",
    }


def normalize_verified_label(tokens: list[str]) -> str:
    """Normalize Admin-verified Vietnamese tokens to NFC and enforce locked VietOCR vocab."""
    raw = " ".join(str(token or "").strip() for token in tokens if str(token or "").strip())
    cleaned, reason = sanitize_and_validate_vietocr_label(raw)
    if cleaned is None:
        raise ValueError(f"verified OCR label failed hygiene check: {reason}")
    return cleaned


def deterministic_sample_id(revision_id: Any, line_index: int, image_sha256: str) -> str:
    return str(uuid5(NAMESPACE_URL, f"viread-flow2-sample:{revision_id}:{line_index}:{image_sha256}"))


async def _claim_one() -> dict[str, Any] | None:
    async with AsyncSessionLocal() as db:
        await db.execute(
            text("""
                UPDATE public.viread_ocr_outbox
                SET status = 'DEAD',
                    last_error_code = 'LEASE_EXHAUSTED',
                    locked_at = NULL,
                    updated_at = now()
                WHERE status = 'PROCESSING'
                  AND locked_at < now() - interval '10 minutes'
                  AND attempts >= :max_attempts
            """),
            {"max_attempts": MAX_ATTEMPTS},
        )
        result = await db.execute(text("""
            WITH next_event AS (
                SELECT id FROM public.viread_ocr_outbox
                WHERE (
                    (status IN ('PENDING', 'RETRY') AND available_at <= now())
                    OR (status = 'PROCESSING' AND locked_at < now() - interval '10 minutes')
                )
                  AND attempts < :max_attempts
                ORDER BY created_at, id
                FOR UPDATE SKIP LOCKED
                LIMIT 1
            )
            UPDATE public.viread_ocr_outbox AS outbox
            SET status = 'PROCESSING', attempts = outbox.attempts + 1,
                locked_at = now(), updated_at = now()
            FROM next_event
            WHERE outbox.id = next_event.id
            RETURNING outbox.id, outbox.event_type, outbox.page_id, outbox.revision_id,
                      outbox.actor_id, outbox.attempts, outbox.payload,
                      to_jsonb(outbox) ->> 'candidate_id' AS candidate_id
        """), {"max_attempts": MAX_ATTEMPTS})
        row = result.mappings().first()
        await db.commit()
        return dict(row) if row else None


def _line_crops(
    image_bytes: bytes,
    words: list[dict[str, Any]],
    *,
    rejected_lines: list[dict[str, Any]] | None = None,
) -> list[tuple[int, bytes, str, str]]:
    try:
        page = open_image_exif_safe(image_bytes)
    except Exception as exc:
        raise ValueError("verified OCR source page image is corrupted or unreadable") from exc
    if page.width <= 0 or page.height <= 0:
        raise ValueError("verified OCR source page image has invalid dimensions")

    by_line: dict[int, list[dict[str, Any]]] = defaultdict(list)
    for word in words:
        by_line[int(word["lineindex"])].append(word)
    crops: list[tuple[int, bytes, str, str]] = []
    rejections: list[dict[str, Any]] = rejected_lines if rejected_lines is not None else []
    for line_index, line_words in sorted(by_line.items()):
        line_words.sort(key=lambda item: int(item["wordindex"]))
        geom_ok, geom_reason = validate_line_word_geometry(line_words)
        if not geom_ok:
            rejections.append({"line_index": line_index, "reason": geom_reason or "INVALID_WORD_GEOMETRY"})
            continue
        bounds = []
        tokens = []
        valid_line = True
        for word in line_words:
            box = word["boundingbox"]
            if not isinstance(box, list) or len(box) != 4:
                valid_line = False
                rejections.append({"line_index": line_index, "reason": "INVALID_WORD_GEOMETRY"})
                break
            x, y, width, height = (float(value) for value in box)
            if (
                not all(math.isfinite(v) for v in (x, y, width, height))
                or x < 0
                or y < 0
                or width <= 0
                or height <= 0
                or x + width > 1.001
                or y + height > 1.001
            ):
                valid_line = False
                rejections.append({"line_index": line_index, "reason": "OUT_OF_BOUNDS_GEOMETRY"})
                break
            bounds.append(
                (x * page.width, y * page.height, (x + width) * page.width, (y + height) * page.height)
            )
            token = str(word.get("text") or "").strip()
            if token:
                tokens.append(token)
        if not valid_line or not bounds or not tokens:
            continue
        crop_box = compute_line_crop_box(bounds, page_width=page.width, page_height=page.height)
        if crop_box[2] <= crop_box[0] or crop_box[3] <= crop_box[1]:
            rejections.append({"line_index": line_index, "reason": "ZERO_AREA_CROP"})
            continue
        try:
            label = normalize_verified_label(tokens)
        except ValueError as exc:
            rejections.append({"line_index": line_index, "reason": str(exc)})
            continue
        pii_flags = detect_vietnamese_pii_strict(label, mode="contact_only")
        if pii_flags:
            rejections.append({"line_index": line_index, "reason": f"PII_DETECTED:{','.join(pii_flags)}"})
            continue
        cropped_img = page.crop(crop_box)
        quality_ok, _metrics, quality_reason = validate_flow2_line_crop(
            cropped_img,
            label=label,
            page_height=page.height,
        )
        if not quality_ok:
            rejections.append({"line_index": line_index, "reason": quality_reason or "IMAGE_QUALITY_REJECTED"})
            continue
        output = BytesIO()
        cropped_img.save(output, format="PNG", optimize=True)
        data = output.getvalue()
        if not data:
            rejections.append({"line_index": line_index, "reason": "EMPTY_PNG_OUTPUT"})
            continue
        fingerprint = hashlib.sha256(data + b"\0" + label.encode("utf-8")).hexdigest()
        crops.append((line_index, data, label, fingerprint))
    if not crops and rejections:
        raise ValueError(
            f"verified OCR revision has no usable line crops ({rejections[0]['reason']})"
        )
    return crops


def _is_explicit_admin_verification(header: dict[str, Any]) -> tuple[bool, str | None]:
    """Strictly verify that a revision was explicitly verified by an Admin, never AI-only."""
    if header.get("verificationstatus") != "VERIFIED":
        return False, "REVISION_NOT_VERIFIED"
    mode = str(header.get("ai_proofread_mode") or "").strip().upper()
    automated_by = str(header.get("ai_automated_by") or "").strip()
    reviewed_by = str(header.get("ai_reviewed_by") or "").strip()
    verified_by = header.get("verifiedby")
    if mode == "AI_AUTO_VERIFIED" or automated_by:
        return False, "AI_AUTO_VERIFIED_NOT_ELIGIBLE"
    if mode and not reviewed_by:
        return False, "ADMIN_REVIEWER_MISSING"
    if not verified_by and not reviewed_by:
        return False, "ADMIN_VERIFIER_MISSING"
    return True, None


async def _build_artifact_router(db) -> TrainingArtifactStoreRouter:
    return await VireadDriveConnectionService(db).build_artifact_router()


async def _find_conflicting_labels(
    db,
    image_labels: dict[str, str],
) -> list[tuple[str, str, str]]:
    """Detect existing samples with identical image_sha256 but a different NFC ground-truth label."""
    if not image_labels:
        return []
    conflicts: list[tuple[str, str, str]] = []
    hashes = sorted(image_labels.keys())
    result = await db.execute(
        text(
            """
            SELECT image_sha256, label
            FROM public.viread_ocr_samples s
            WHERE s.source_flow = 'FLOW1_VERIFIED'
              AND COALESCE(to_jsonb(s)->>'training_eligibility', 'ELIGIBLE') = 'ELIGIBLE'
              AND s.image_sha256 = ANY(:hashes)
            """
        ),
        {"hashes": hashes},
    )
    for row in result.mappings().all():
        img_sha = str(row["image_sha256"])
        existing_label = unicodedata.normalize("NFC", str(row["label"] or ""))
        incoming_label = image_labels.get(img_sha)
        if incoming_label is not None and existing_label != incoming_label:
            conflicts.append((img_sha, existing_label, incoming_label))
    return conflicts


def _parent_contrib_split(group_id: str) -> str:
    """Assign parent-contributed groups strictly to train/validation (never holdout / LOCKED_TEST)."""
    value = int(
        hashlib.sha256(f"viread-vietocr-v2-document-split-v1\0{group_id}".encode()).hexdigest()[:8],
        16,
    ) / 0xFFFFFFFF
    return "train" if value < 0.80 else "validation"


async def _load_live_parent_candidate_state(db, candidate_id: str) -> dict[str, Any] | None:
    result = await db.execute(
        text(
            """
            SELECT c.id AS candidate_id,
                   c.book_id,
                   c.owner_parent_id,
                   c.page_id,
                   c.revision_id,
                   c.consent_version AS candidate_consent_version,
                   c.line_index,
                   c.source_image_path,
                   c.source_content_hash,
                   c.crop_box_json,
                   c.image_sha256,
                   c.verified_label,
                   c.verified_label_sha256,
                   c.rights_basis,
                   c.pii_check_status,
                   c.status AS candidate_status,
                   c.verified_by,
                   c.verified_at,
                   b.visibility_scope,
                   b.lifecyclestatus AS book_lifecycle_status,
                   b.moderation_status AS book_moderation_status,
                   b.owner_parent_id AS book_owner_parent_id,
                   p.lifecyclestatus AS page_lifecycle_status,
                   p.currentverifiedrevisionid AS page_current_revision_id,
                   r.verificationstatus AS revision_verification_status,
                   r.contenthash AS revision_content_hash,
                   cs.status AS consent_status,
                   cs.rights_confirmed AS consent_rights_confirmed,
                   cs.consent_version AS live_consent_version,
                   cs.notice_version AS consent_notice_version
            FROM public.parent_book_flow2_candidates c
            JOIN public.books b ON b.id = c.book_id
            JOIN public.bookpages p ON p.id = c.page_id
            JOIN public.pagerevisions r ON r.id = c.revision_id
            LEFT JOIN public.parent_book_ocr_contribution_consents cs ON cs.book_id = c.book_id
            WHERE c.id = CAST(:candidate_id AS uuid)
            """
        ),
        {"candidate_id": candidate_id},
    )
    row = result.mappings().first()
    return dict(row) if row else None


def _check_live_parent_candidate_eligible(row: dict[str, Any] | None) -> tuple[bool, str | None]:
    if row is None:
        return False, "CANDIDATE_NOT_FOUND"
    if str(row.get("visibility_scope") or "").upper() != "PARENT_PRIVATE":
        return False, "NOT_PARENT_PRIVATE_BOOK"
    if str(row.get("book_lifecycle_status") or "").upper() != "ACTIVE":
        return False, "BOOK_NOT_ACTIVE"
    if str(row.get("book_moderation_status") or "").upper() != "ACTIVE":
        return False, "BOOK_SUSPENDED"
    if str(row.get("owner_parent_id")) != str(row.get("book_owner_parent_id")):
        return False, "OWNER_MISMATCH"
    if str(row.get("consent_status") or "").upper() != "OPTED_IN":
        return False, "CONSENT_NOT_OPTED_IN"
    if not bool(row.get("consent_rights_confirmed")):
        return False, "CONSENT_RIGHTS_NOT_CONFIRMED"
    if int(row.get("live_consent_version") or 0) != int(row.get("candidate_consent_version") or -1):
        return False, "CONSENT_VERSION_STALE"
    if str(row.get("page_lifecycle_status") or "").upper() != "ACTIVE":
        return False, "PAGE_NOT_ACTIVE"
    if str(row.get("page_current_revision_id") or "") != str(row.get("revision_id") or ""):
        return False, "REVISION_SUPERSEDED"
    if str(row.get("revision_verification_status") or "").upper() != "VERIFIED":
        return False, "REVISION_NOT_VERIFIED"
    if str(row.get("revision_content_hash") or "") != str(row.get("source_content_hash") or ""):
        return False, "REVISION_CONTENT_HASH_CHANGED"
    if str(row.get("candidate_status") or "").upper() != "SYNC_QUEUED":
        return False, f"CANDIDATE_STATUS_{row.get('candidate_status')}"
    if not row.get("verified_by") or not row.get("verified_at") or not row.get("verified_label"):
        return False, "ADMIN_LABEL_VERIFICATION_MISSING"
    if str(row.get("pii_check_status") or "").upper() != "CLEAR":
        return False, "PII_FLAGGED"
    if str(row.get("rights_basis") or "") not in ALLOWED_TRAINING_RIGHTS:
        return False, "RIGHTS_BASIS_INSUFFICIENT"
    return True, None


async def _mark_candidate_revoked_if_active(db, candidate_id: str, reason: str) -> None:
    await db.execute(
        text(
            """
            UPDATE public.parent_book_flow2_candidates
            SET status = 'REVOKED',
                revoked_at = now(),
                revoke_reason = :reason,
                updated_at = now()
            WHERE id = CAST(:candidate_id AS uuid)
              AND status IN ('PENDING_VERIFICATION', 'VERIFIED', 'SYNC_QUEUED')
            """
        ),
        {"candidate_id": candidate_id, "reason": reason},
    )


async def _process_parent_contribution_candidate(event: dict[str, Any]) -> None:
    payload = event.get("payload") if isinstance(event.get("payload"), dict) else {}
    candidate_id = str(event.get("candidate_id") or payload.get("candidate_id") or "").strip()
    if not candidate_id:
        raise OutboxEventSkipped(
            "PARENT_CANDIDATE_ID_MISSING",
            "Parent contribution outbox event is missing candidate_id",
        )

    # Recheck #1: Live ownership, consent version, active book/page/revision, Admin verification, rights, PII
    async with AsyncSessionLocal() as db:
        cand = await _load_live_parent_candidate_state(db, candidate_id)
        ok, reject_code = _check_live_parent_candidate_eligible(cand)
        if not ok or cand is None:
            if cand is not None:
                await _mark_candidate_revoked_if_active(db, candidate_id, reject_code or "CONSENT_REVOKED")
                await db.commit()
            raise OutboxEventSkipped(
                reject_code or "CONSENT_REVOKED_OR_STALE_REVISION",
                "Parent contribution candidate is no longer eligible for Flow 2 sync",
            )

    source_image_path = str(cand["source_image_path"])
    crop_box = list(cand["crop_box_json"] or [])
    if len(crop_box) != 4:
        raise ValueError("Parent contribution candidate has invalid crop_box_json")

    verified_label = normalize_and_validate_ocr_label(str(cand["verified_label"]))
    if detect_line_pii(verified_label):
        async with AsyncSessionLocal() as db:
            await _mark_candidate_revoked_if_active(db, candidate_id, "PII_DETECTED_AT_SYNC")
            await db.commit()
        raise OutboxEventSkipped("PII_DETECTED_AT_SYNC", "Verified label flagged for PII before sync")

    label_sha = hashlib.sha256(verified_label.encode("utf-8")).hexdigest()
    if cand.get("verified_label_sha256") and label_sha != str(cand["verified_label_sha256"]):
        raise ValueError("Verified label SHA-256 mismatch on parent contribution candidate")

    page_bytes = await asyncio.to_thread(
        download_object, source_image_path, bucket_name=SUPABASE_PRIVATE_BOOKS_BUCKET
    )

    def _crop_and_verify() -> bytes:
        rgb = open_image_exif_safe(page_bytes)
        cropped = rgb.crop((int(crop_box[0]), int(crop_box[1]), int(crop_box[2]), int(crop_box[3])))
        q_ok, _metrics, q_reason = evaluate_line_crop_quality(
            cropped,
            label=verified_label,
            page_height=rgb.height,
        )
        if not q_ok:
            raise OutboxEventSkipped(
                f"CROP_QUALITY_FAILED:{q_reason}",
                f"Parent contribution crop failed quality gate: {q_reason}",
            )
        buf = BytesIO()
        cropped.save(buf, format="PNG", optimize=True)
        return buf.getvalue()

    crop_bytes = await asyncio.to_thread(_crop_and_verify)
    image_sha = hashlib.sha256(crop_bytes).hexdigest()
    if image_sha != str(cand["image_sha256"]):
        async with AsyncSessionLocal() as db:
            await _mark_candidate_revoked_if_active(db, candidate_id, "STALE_IMAGE_HASH_MISMATCH")
            await db.commit()
        raise OutboxEventSkipped(
            "STALE_IMAGE_HASH_MISMATCH",
            "Source page image changed since candidate was verified",
        )

    line_index = int(cand["line_index"])
    book_id = str(cand["book_id"])
    group_id = f"parent-book:{book_id}"
    split_value = _parent_contrib_split(group_id)
    sample_id = deterministic_sample_id(cand["revision_id"], line_index, image_sha)
    content_fingerprint = hashlib.sha256(verified_label.lower().encode("utf-8")).hexdigest()
    verified_at_iso = (
        cand["verified_at"].isoformat()
        if isinstance(cand.get("verified_at"), datetime)
        else (str(cand["verified_at"]) if cand.get("verified_at") else None)
    )
    verified_by_str = str(cand.get("verified_by") or event.get("actor_id") or "")

    # Recheck #2 + conflict/quota check right before Drive upload
    async with AsyncSessionLocal() as db:
        live_cand = await _load_live_parent_candidate_state(db, candidate_id)
        ok, reject_code = _check_live_parent_candidate_eligible(live_cand)
        if not ok:
            await _mark_candidate_revoked_if_active(db, candidate_id, reject_code or "CONSENT_REVOKED_MID_FLIGHT")
            await db.commit()
            raise OutboxEventSkipped(
                reject_code or "CONSENT_REVOKED_MID_FLIGHT",
                "Parent consent or revision changed before Drive upload",
            )
        conflicts = await _find_conflicting_labels(db, {image_sha: verified_label})
        if conflicts:
            raise OutboxEventBlocked(
                "CONFLICTING_LABEL_FOR_IMAGE_HASH",
                "Detected duplicate line image hash with conflicting verified label",
            )
        router = await _build_artifact_router(db)
        total_db_bytes = len(verified_label.encode("utf-8")) + 2048
        est_upload_bytes = len(crop_bytes) + len(verified_label.encode("utf-8")) + 512
        await ensure_database_capacity(db, total_db_bytes)
        if router.write_provider == StorageProvider.SUPABASE_LEGACY:
            await ensure_storage_capacity(db, est_upload_bytes)
        else:
            quota = await asyncio.to_thread(router.quota_check, incoming_bytes=est_upload_bytes)
            if not quota.can_accept_upload:
                raise DriveQuotaExceededError(
                    quota.detail or "Google Drive quota insufficient for parent contribution sample",
                    required_bytes=est_upload_bytes,
                    available_bytes=quota.available_bytes,
                    limit_bytes=quota.limit_bytes,
                    usage_bytes=quota.usage_bytes,
                )

    if router.write_provider == StorageProvider.GOOGLE_DRIVE:
        image_logical = f"verified-samples/parent-contrib/{cand['revision_id']}/line-{line_index:04d}-{image_sha[:12]}.png"
        label_logical = f"verified-samples/parent-contrib/{cand['revision_id']}/line-{line_index:04d}-{image_sha[:12]}.json"
    else:
        image_logical = f"ocr-training/flow2/parent-contrib/{cand['revision_id']}/{line_index:04d}-{image_sha[:12]}.png"
        label_logical = f"ocr-training/flow2/parent-contrib/{cand['revision_id']}/{line_index:04d}-{image_sha[:12]}.json"

    stored_image = await asyncio.to_thread(
        router.put,
        image_logical,
        crop_bytes,
        content_type="image/png",
        expected_sha256=image_sha,
        metadata={
            "sample_id": sample_id,
            "revision_id": str(cand["revision_id"]),
            "line_index": str(line_index),
            "source_origin": "PARENT_PRIVATE_CONTRIBUTION",
        },
    )
    label_payload = {
        "schema": "viread-flow2-sample-v1",
        "source_origin": "PARENT_PRIVATE_CONTRIBUTION",
        "sample_id": sample_id,
        "book_id": book_id,
        "page_id": str(cand["page_id"]),
        "revision_id": str(cand["revision_id"]),
        "candidate_id": candidate_id,
        "consent_version": int(cand["candidate_consent_version"]),
        "notice_version": cand.get("consent_notice_version"),
        "rights_basis": cand["rights_basis"],
        "line_index": line_index,
        "group_id": group_id,
        "image_reference": stored_image.reference,
        "image_drive_file_id": stored_image.drive_file_id,
        "image_sha256": image_sha,
        "label": verified_label,
        "label_sha256": label_sha,
        "content_fingerprint": content_fingerprint,
        "verified_at": verified_at_iso,
        "verified_by": verified_by_str or None,
        "eligible_for_locked_test": False,
        "split": split_value,
        "source_content_hash": cand["source_content_hash"],
        "storage_provider": stored_image.provider.value,
    }
    label_bytes = json.dumps(label_payload, ensure_ascii=False, sort_keys=True, indent=2).encode("utf-8")
    label_blob_sha = hashlib.sha256(label_bytes).hexdigest()
    stored_label = await asyncio.to_thread(
        router.put,
        label_logical,
        label_bytes,
        content_type="application/json",
        expected_sha256=label_blob_sha,
        metadata={
            "sample_id": sample_id,
            "revision_id": str(cand["revision_id"]),
            "line_index": str(line_index),
            "source_origin": "PARENT_PRIVATE_CONTRIBUTION",
        },
    )

    provenance_json = json.dumps(
        {
            "source_origin": "PARENT_PRIVATE_CONTRIBUTION",
            "sample_id": sample_id,
            "book_id": book_id,
            "page_id": str(cand["page_id"]),
            "revision_id": str(cand["revision_id"]),
            "candidate_id": candidate_id,
            "outbox_event_id": str(event["id"]),
            "consent_version": int(cand["candidate_consent_version"]),
            "notice_version": cand.get("consent_notice_version"),
            "rights_basis": cand["rights_basis"],
            "line_index": line_index,
            "group_id": group_id,
            "image_reference": stored_image.reference,
            "label_reference": stored_label.reference,
            "image_sha256": image_sha,
            "label_sha256": label_sha,
            "content_fingerprint": content_fingerprint,
            "source_content_hash": cand["source_content_hash"],
            "verified_by": verified_by_str or None,
            "verified_at": verified_at_iso,
            "verified_by_admin": True,
            "ai_review_required": False,
            "verification_source": "admin",
            "eligible_for_locked_test": False,
            "storage_provider": stored_image.provider.value,
        },
        ensure_ascii=False,
    )

    # Recheck #3 under advisory lock right before committing sample row!
    async with AsyncSessionLocal() as db:
        await db.execute(
            text("SELECT pg_advisory_xact_lock(hashtext('viread_ocr_sample_hash:' || :img_sha))"),
            {"img_sha": image_sha},
        )
        final_cand = await _load_live_parent_candidate_state(db, candidate_id)
        ok, reject_code = _check_live_parent_candidate_eligible(final_cand)
        if not ok:
            await _mark_candidate_revoked_if_active(db, candidate_id, reject_code or "CONSENT_REVOKED_BEFORE_COMMIT")
            await db.commit()
            for ref in (stored_image.reference, stored_label.reference):
                try:
                    await asyncio.to_thread(
                        router.delete_if_unreferenced,
                        ref,
                        is_referenced_check=lambda _r: False,
                    )
                except Exception:
                    pass
            raise OutboxEventSkipped(
                reject_code or "CONSENT_REVOKED_BEFORE_COMMIT",
                "Parent consent or revision changed while uploading; discarded stale worker output",
            )
        final_conflicts = await _find_conflicting_labels(db, {image_sha: verified_label})
        if final_conflicts:
            await db.rollback()
            raise OutboxEventBlocked(
                "CONFLICTING_LABEL_FOR_IMAGE_HASH",
                "Detected concurrent duplicate image hash conflict",
            )
        await db.execute(
            text(
                """
                INSERT INTO public.viread_ocr_samples
                    (id, source_flow, source_group_id, split, image_storage_path, image_sha256,
                     label, source_page_id, source_revision_id, provenance,
                     storage_provider, drive_file_id, label_storage_path,
                     label_drive_file_id, label_sha256, sync_status, training_eligibility)
                VALUES (CAST(:sample_id AS uuid), 'FLOW1_VERIFIED', :group_id, :split, :path,
                        :image_sha, :label, :page_id, :revision_id, CAST(:provenance AS jsonb),
                        :storage_provider, :drive_file_id, :label_storage_path,
                        :label_drive_file_id, :label_sha256, 'SYNCED', 'ELIGIBLE')
                ON CONFLICT DO NOTHING
                """
            ),
            {
                "sample_id": sample_id,
                "group_id": group_id,
                "split": split_value,
                "path": stored_image.reference,
                "image_sha": image_sha,
                "label": verified_label,
                "page_id": cand["page_id"],
                "revision_id": cand["revision_id"],
                "provenance": provenance_json,
                "storage_provider": stored_image.provider.value,
                "drive_file_id": stored_image.drive_file_id,
                "label_storage_path": stored_label.reference,
                "label_drive_file_id": stored_label.drive_file_id,
                "label_sha256": label_sha,
            },
        )
        await db.execute(
            text(
                """
                UPDATE public.parent_book_flow2_candidates
                SET status = 'SYNCED',
                    sample_id = CAST(:sample_id AS uuid),
                    updated_at = now()
                WHERE id = CAST(:candidate_id AS uuid)
                """
            ),
            {"sample_id": sample_id, "candidate_id": candidate_id},
        )
        await db.commit()


async def _process(event: dict[str, Any]) -> None:
    if str(event.get("event_type") or "").upper() == "PARENT_CONTRIBUTION_CANDIDATE":
        await _process_parent_contribution_candidate(event)
        return
    async with AsyncSessionLocal() as db:
        header_result = await db.execute(text("""
            SELECT COALESCE(NULLIF(r.processingmeta ->> 'source_image_path', ''), p.imagepath) AS imagepath,
                   p.bookid, r.verificationstatus, r.contenthash,
                   r.verifiedby, r.verifiedat,
                   r.processingmeta -> 'ai_proofread_audit' ->> 'mode' AS ai_proofread_mode,
                   to_jsonb(b) ->> 'visibility_scope' AS visibility_scope,
                   to_jsonb(b) ->> 'lifecyclestatus' AS book_lifecycle_status,
                   to_jsonb(p) ->> 'lifecyclestatus' AS page_lifecycle_status,
                   to_jsonb(p) ->> 'currentverifiedrevisionid' AS current_verified_revision_id,
                   r.processingmeta -> 'word_evidence_v2' AS word_evidence_v2,
                   r.processingmeta -> 'ai_proofread_audit' ->> 'reviewed_by' AS ai_reviewed_by,
                   r.processingmeta -> 'ai_proofread_audit' ->> 'automated_by' AS ai_automated_by
            FROM public.bookpages AS p
            LEFT JOIN public.books AS b ON b.id = p.bookid
            JOIN public.pagerevisions AS r ON r.pageid = p.id
            WHERE p.id = :page_id AND r.id = :revision_id
        """), {"page_id": event["page_id"], "revision_id": event["revision_id"]})
        header = header_result.mappings().first()
        if not header:
            raise ValueError("outbox source revision is missing or not VERIFIED")
        header_dict = dict(header)
        visibility_scope = header_dict.get("visibility_scope")
        if visibility_scope is not None and str(visibility_scope).strip().upper() != "CATALOG":
            raise OutboxEventSkipped(
                "PARENT_PRIVATE_BOOK_EXCLUDED",
                "Parent private books are strictly excluded from Flow 2 OCR training",
            )
        book_lifecycle = header_dict.get("book_lifecycle_status")
        if book_lifecycle is not None and str(book_lifecycle).strip().upper() != "ACTIVE":
            raise OutboxEventSkipped(
                "BOOK_NOT_ACTIVE",
                "Book is no longer ACTIVE; skipping Flow 2 OCR training ingestion",
            )
        page_lifecycle = header_dict.get("page_lifecycle_status")
        if page_lifecycle is not None and str(page_lifecycle).strip().upper() != "ACTIVE":
            raise OutboxEventSkipped(
                "PAGE_NOT_ACTIVE",
                "Page is no longer ACTIVE; skipping Flow 2 OCR training ingestion",
            )
        current_rev_id = header_dict.get("current_verified_revision_id")
        if current_rev_id and str(current_rev_id) != str(event["revision_id"]):
            raise OutboxEventSkipped(
                "REVISION_SUPERSEDED",
                "Superseded catalog revision is excluded from Flow 2 OCR training",
            )
        eligible, reject_code = _is_explicit_admin_verification(header_dict)
        if not eligible:
            if reject_code in {
                "AI_AUTO_VERIFIED_NOT_ELIGIBLE",
                "ADMIN_REVIEWER_MISSING",
                "REVISION_NOT_VERIFIED",
            }:
                raise OutboxEventSkipped(
                    reject_code,
                    "Only explicitly Admin-verified revisions are eligible for Flow 2 training",
                )
            raise ValueError("outbox source revision is missing or not VERIFIED")

        words_result = await db.execute(text("""
            SELECT w.wordindex, w.lineindex, w.text, w.boundingbox
            FROM public.pagerevisionwords AS w
            WHERE w.pagerevisionid = :revision_id
            ORDER BY w.lineindex, w.wordindex, w.id
        """), {"revision_id": event["revision_id"]})
        words = [dict(row) for row in words_result.mappings().all()]

    if not words:
        raise ValueError("outbox source revision has no words")

    raw_evidence = header_dict.get("word_evidence_v2")
    if isinstance(raw_evidence, list):
        for w in words:
            w_idx = int(w.get("wordindex", -1))
            if 0 <= w_idx < len(raw_evidence) and isinstance(raw_evidence[w_idx], dict):
                w["ocr_evidence"] = raw_evidence[w_idx]

    image_path = header_dict["imagepath"]
    if not image_path:
        raise ValueError("verified revision page has no source image path")
    image_bytes = await asyncio.to_thread(download_object, image_path)
    rejected_lines: list[dict[str, Any]] = []
    crops = await asyncio.to_thread(
        _line_crops, image_bytes, words, rejected_lines=rejected_lines
    )
    if rejected_lines:
        log_diagnostic(
            logger,
            logging.INFO,
            event="viread_ocr_outbox_lines_quarantined",
            stage="flow2_hygiene_gate",
            outbox_id=str(event["id"]),
            quarantined_count=len(rejected_lines),
            accepted_count=len(crops),
            sample_reason=str(rejected_lines[0].get("reason", ""))[:64],
        )
    if not crops:
        raise OutboxEventSkipped(
            "ALL_LINES_REJECTED_BY_HYGIENE",
            "Verified revision contains no line crops passing Flow 2 hygiene checks",
        )

    # Detect within-revision duplicate-image-hash label conflicts and deduplicate identical pairs.
    image_labels: dict[str, str] = {}
    prepared_lines: list[tuple[int, bytes, str, str, str, str]] = []
    for line_index, crop, label, fingerprint in crops:
        image_sha = hashlib.sha256(crop).hexdigest()
        label_sha = hashlib.sha256(label.encode("utf-8")).hexdigest()
        prev_label = image_labels.get(image_sha)
        if prev_label is not None:
            if prev_label != label:
                raise OutboxEventBlocked(
                    "CONFLICTING_LABEL_FOR_IMAGE_HASH",
                    "Duplicate line crop hash within revision has conflicting verified labels",
                )
            continue
        image_labels[image_sha] = label
        prepared_lines.append((line_index, crop, label, fingerprint, image_sha, label_sha))

    group_id = str(header_dict["bookid"] or event["page_id"])
    split_value = _stable_split(group_id)
    verified_at_iso = (
        header_dict["verifiedat"].isoformat()
        if isinstance(header_dict.get("verifiedat"), datetime)
        else (str(header_dict["verifiedat"]) if header_dict.get("verifiedat") else None)
    )
    verified_by_str = str(
        header_dict.get("ai_reviewed_by")
        or header_dict.get("verifiedby")
        or event.get("actor_id")
        or ""
    )

    total_crop_bytes = sum(len(crop) for _, crop, _, _, _, _ in prepared_lines)
    estimated_label_json_bytes = sum(len(label.encode("utf-8")) + 512 for _, _, label, _, _, _ in prepared_lines)
    total_db_bytes = sum(len(label.encode("utf-8")) + 2048 for _, _, label, _, _, _ in prepared_lines)

    async def _archive_superseded_page_samples(db_session) -> None:
        try:
            await db_session.execute(
                text(
                    """
                    UPDATE public.viread_ocr_samples
                    SET training_eligibility = 'ARCHIVED',
                        quarantine_reason = 'SUPERSEDED_BY_NEWER_REVISION'
                    WHERE source_flow = 'FLOW1_VERIFIED'
                      AND dataset_version_id IS NULL
                      AND source_page_id = :page_id
                      AND source_revision_id IS DISTINCT FROM :revision_id
                      AND training_eligibility = 'ELIGIBLE'
                    """
                ),
                {"page_id": event["page_id"], "revision_id": event["revision_id"]},
            )
        except Exception as exc:
            if "column" not in str(exc).lower() and "does not exist" not in str(exc).lower():
                raise

    async with AsyncSessionLocal() as db:
        await _archive_superseded_page_samples(db)
        conflicts = await _find_conflicting_labels(db, image_labels)
        if conflicts:
            await db.rollback()
            raise OutboxEventBlocked(
                "CONFLICTING_LABEL_FOR_IMAGE_HASH",
                f"Detected {len(conflicts)} duplicate line image hash(es) with conflicting labels",
            )
        await db.commit()
        router = await _build_artifact_router(db)
        await ensure_database_capacity(db, total_db_bytes)
        if router.write_provider == StorageProvider.SUPABASE_LEGACY:
            await ensure_storage_capacity(db, total_crop_bytes + estimated_label_json_bytes)
        else:
            quota = await asyncio.to_thread(
                router.quota_check,
                incoming_bytes=total_crop_bytes + estimated_label_json_bytes,
            )
            if not quota.can_accept_upload:
                raise DriveQuotaExceededError(
                    quota.detail or "Google Drive quota insufficient for verified Flow 2 sample batch",
                    required_bytes=total_crop_bytes + estimated_label_json_bytes,
                    available_bytes=quota.available_bytes,
                    limit_bytes=quota.limit_bytes,
                    usage_bytes=quota.usage_bytes,
                )

    sample_rows: list[dict[str, Any]] = []
    for line_index, crop, label, _fingerprint, image_sha, label_sha in prepared_lines:
        sample_id = deterministic_sample_id(event["revision_id"], line_index, image_sha)
        if router.write_provider == StorageProvider.GOOGLE_DRIVE:
            image_logical = f"verified-samples/{event['revision_id']}/line-{line_index:04d}-{image_sha[:12]}.png"
            label_logical = f"verified-samples/{event['revision_id']}/line-{line_index:04d}-{image_sha[:12]}.json"
        else:
            image_logical = (
                f"ocr-training/flow2/admin-verified/{event['revision_id']}/"
                f"{line_index:04d}-{image_sha[:12]}.png"
            )
            label_logical = (
                f"ocr-training/flow2/admin-verified/{event['revision_id']}/"
                f"{line_index:04d}-{image_sha[:12]}.json"
            )

        stored_image = await asyncio.to_thread(
            router.put,
            image_logical,
            crop,
            content_type="image/png",
            expected_sha256=image_sha,
            metadata={
                "sample_id": sample_id,
                "revision_id": str(event["revision_id"]),
                "line_index": str(line_index),
            },
        )
        label_payload = {
            "schema": "viread-flow2-sample-v1",
            "sample_id": sample_id,
            "book_id": str(header_dict["bookid"]) if header_dict.get("bookid") else None,
            "page_id": str(event["page_id"]),
            "revision_id": str(event["revision_id"]),
            "line_index": line_index,
            "group_id": group_id,
            "image_reference": stored_image.reference,
            "image_drive_file_id": stored_image.drive_file_id,
            "image_sha256": image_sha,
            "label": label,
            "label_sha256": label_sha,
            "verified_at": verified_at_iso,
            "verified_by": verified_by_str or None,
            "split": split_value,
            "source_content_hash": header_dict.get("contenthash"),
            "storage_provider": stored_image.provider.value,
        }
        label_bytes = json.dumps(label_payload, ensure_ascii=False, sort_keys=True, indent=2).encode("utf-8")
        label_blob_sha = hashlib.sha256(label_bytes).hexdigest()
        stored_label = await asyncio.to_thread(
            router.put,
            label_logical,
            label_bytes,
            content_type="application/json",
            expected_sha256=label_blob_sha,
            metadata={
                "sample_id": sample_id,
                "revision_id": str(event["revision_id"]),
                "line_index": str(line_index),
            },
        )

        sample_rows.append({
            "sample_id": sample_id,
            "group_id": group_id,
            "split": split_value,
            "path": stored_image.reference,
            "image_sha": image_sha,
            "label": label,
            "page_id": event["page_id"],
            "revision_id": event["revision_id"],
            "storage_provider": stored_image.provider.value,
            "drive_file_id": stored_image.drive_file_id,
            "label_storage_path": stored_label.reference,
            "label_drive_file_id": stored_label.drive_file_id,
            "label_sha256": label_sha,
            "provenance": json.dumps({
                "sample_id": sample_id,
                "book_id": str(header_dict["bookid"]) if header_dict.get("bookid") else None,
                "page_id": str(event["page_id"]),
                "revision_id": str(event["revision_id"]),
                "outbox_event_id": str(event["id"]),
                "line_index": line_index,
                "group_id": group_id,
                "image_reference": stored_image.reference,
                "label_reference": stored_label.reference,
                "image_sha256": image_sha,
                "label_sha256": label_sha,
                "source_content_hash": header_dict.get("contenthash"),
                "verified_by": verified_by_str or None,
                "verified_at": verified_at_iso,
                "verified_by_admin": True,
                "ai_review_required": False,
                "verification_source": "admin",
                "storage_provider": stored_image.provider.value,
            }, ensure_ascii=False),
        })

    async with AsyncSessionLocal() as db:
        # Close TOCTOU race across concurrent workers by acquiring deterministic
        # advisory locks in sorted hash order and re-checking conflicting labels.
        for img_sha in sorted(image_labels.keys()):
            await db.execute(
                text("SELECT pg_advisory_xact_lock(hashtext('viread_ocr_sample_hash:' || :img_sha))"),
                {"img_sha": img_sha},
            )
        final_conflicts = await _find_conflicting_labels(db, image_labels)
        if final_conflicts:
            await db.rollback()
            raise OutboxEventBlocked(
                "CONFLICTING_LABEL_FOR_IMAGE_HASH",
                f"Detected {len(final_conflicts)} concurrent duplicate image hash conflict(s)",
            )
        await db.execute(text("""
            INSERT INTO public.viread_ocr_samples
                (id, source_flow, source_group_id, split, image_storage_path, image_sha256,
                 label, source_page_id, source_revision_id, provenance,
                 storage_provider, drive_file_id, label_storage_path,
                 label_drive_file_id, label_sha256, sync_status)
            VALUES (CAST(:sample_id AS uuid), 'FLOW1_VERIFIED', :group_id, :split, :path,
                    :image_sha, :label, :page_id, :revision_id, CAST(:provenance AS jsonb),
                    :storage_provider, :drive_file_id, :label_storage_path,
                    :label_drive_file_id, :label_sha256, 'SYNCED')
            ON CONFLICT DO NOTHING
        """), sample_rows)
        await db.commit()


def _stable_split(group_id: str) -> str:
    value = int(hashlib.sha256(f"viread-vietocr-v2-split-v1\0{group_id}".encode()).hexdigest()[:8], 16) / 0xFFFFFFFF
    return "train" if value < 0.70 else "validation" if value < 0.85 else "holdout"


async def _finish(
    event_id,
    *,
    status: str,
    expected_attempts: int | None = None,
    error_code: str | None = None,
    delay_seconds: int = 0,
) -> bool:
    async with AsyncSessionLocal() as db:
        async def _execute_update(target_status: str) -> bool:
            if expected_attempts is None:
                result = await db.execute(text("""
                    UPDATE public.viread_ocr_outbox
                    SET status = :status, last_error_code = :error_code, locked_at = NULL,
                        available_at = now() + (:delay_seconds * interval '1 second'), updated_at = now()
                    WHERE id = :event_id AND status = 'PROCESSING'
                """), {
                    "event_id": event_id,
                    "status": target_status,
                    "error_code": error_code,
                    "delay_seconds": delay_seconds,
                })
            else:
                result = await db.execute(text("""
                    UPDATE public.viread_ocr_outbox
                    SET status = :status, last_error_code = :error_code, locked_at = NULL,
                        available_at = now() + (:delay_seconds * interval '1 second'), updated_at = now()
                    WHERE id = :event_id AND status = 'PROCESSING' AND attempts = :expected_attempts
                """), {
                    "event_id": event_id,
                    "status": target_status,
                    "expected_attempts": expected_attempts,
                    "error_code": error_code,
                    "delay_seconds": delay_seconds,
                })
            await db.commit()
            return bool(result.rowcount)

        try:
            return await _execute_update(status)
        except Exception as exc:
            if status in {"SKIPPED", "BLOCKED"} and "check" in str(exc).lower():
                await db.rollback()
                return await _execute_update("DEAD")
            raise


async def _renew_claim(event_id, *, expected_attempts: int) -> bool:
    """Fence heartbeat by status and attempt generation, not merely the event UUID."""
    async with AsyncSessionLocal() as db:
        result = await db.execute(text("""
            UPDATE public.viread_ocr_outbox
            SET locked_at = now(), updated_at = now()
            WHERE id = :event_id AND status = 'PROCESSING'
              AND attempts = :expected_attempts
        """), {"event_id": event_id, "expected_attempts": expected_attempts})
        await db.commit()
        return result.rowcount == 1


async def _maintain_claim(
    event_id,
    *,
    expected_attempts: int,
    stop: asyncio.Event,
    lease_lost: asyncio.Event,
) -> None:
    """Renew an in-flight claim. Fail closed if renewal cannot be verified."""
    while not stop.is_set():
        try:
            await asyncio.wait_for(stop.wait(), timeout=LEASE_HEARTBEAT_SECONDS)
        except TimeoutError:
            pass
        if stop.is_set():
            return
        try:
            owned = await asyncio.wait_for(
                _renew_claim(event_id, expected_attempts=expected_attempts),
                timeout=LEASE_HEARTBEAT_TIMEOUT_SECONDS,
            )
        except asyncio.CancelledError:
            raise
        except Exception as exc:
            # Log only the exception type, never credentials or Storage paths.
            log_diagnostic(
                logger,
                logging.WARNING,
                event="viread_ocr_outbox_lease_renewal_failed",
                stage="lease_heartbeat",
                error_code=type(exc).__name__.upper(),
            )
            lease_lost.set()
            return
        if not owned:
            lease_lost.set()
            return


async def _process_with_lease(event: dict[str, Any]) -> None:
    """Race work against lease loss; stop additional work after fencing fails."""
    stop_heartbeat = asyncio.Event()
    lease_lost = asyncio.Event()
    processing = asyncio.create_task(_process(event), name="ocr_outbox_materialize")
    heartbeat = asyncio.create_task(
        _maintain_claim(
            event["id"], expected_attempts=int(event["attempts"]),
            stop=stop_heartbeat, lease_lost=lease_lost,
        ),
        name="ocr_outbox_lease_heartbeat",
    )
    lost_watcher = asyncio.create_task(lease_lost.wait())
    try:
        completed, _ = await asyncio.wait(
            {processing, lost_watcher}, return_when=asyncio.FIRST_COMPLETED
        )
        if lost_watcher in completed and lease_lost.is_set():
            raise OutboxLeaseLost("Outbox event lease was lost")
        await processing
        if lease_lost.is_set():
            raise OutboxLeaseLost("Outbox event lease was lost")
    finally:
        stop_heartbeat.set()
        if not processing.done():
            processing.cancel()
        heartbeat.cancel()
        lost_watcher.cancel()
        await asyncio.gather(
            processing, heartbeat, lost_watcher, return_exceptions=True
        )


async def _release_claim_on_cancel(event_id, *, expected_attempts: int) -> None:
    """Return an interrupted PROCESSING claim to the queue without burning an attempt."""
    async with AsyncSessionLocal() as db:
        await db.execute(text("""
            UPDATE public.viread_ocr_outbox
            SET status = CASE WHEN attempts <= 1 THEN 'PENDING' ELSE 'RETRY' END,
                attempts = GREATEST(0, attempts - 1),
                locked_at = NULL,
                available_at = now(),
                updated_at = now()
            WHERE id = :event_id AND status = 'PROCESSING' AND attempts = :expected_attempts
        """), {"event_id": event_id, "expected_attempts": expected_attempts})
        await db.commit()


async def _wait_for_stop_or_timeout(stop: asyncio.Event, timeout_seconds: float) -> None:
    """Sleep up to timeout_seconds while waking immediately when stop is signaled."""
    if stop.is_set() or timeout_seconds <= 0:
        return
    try:
        await asyncio.wait_for(stop.wait(), timeout=timeout_seconds)
    except TimeoutError:
        pass


async def run_worker(stop: asyncio.Event, *, poll_seconds: int = POLL_SECONDS) -> None:
    """Durable multi-process-safe outbox worker. Failed events retry and eventually dead-letter."""
    idle_streak = 0
    while not stop.is_set():
        if is_flow2_ingestion_paused():
            await _wait_for_stop_or_timeout(stop, poll_seconds)
            continue
        try:
            event = await _claim_one()
        except asyncio.CancelledError:
            raise
        except Exception as exc:
            record_worker_error("viread_ocr_outbox", exc)
            log_diagnostic(logger, logging.ERROR, event="viread_ocr_outbox_claim_failed",
                           stage="database_claim", exception=exc)
            await _wait_for_stop_or_timeout(stop, poll_seconds)
            continue
        if event is None:
            record_worker_success("viread_ocr_outbox")
            idle_streak = min(idle_streak + 1, 4)
            sleep_for = (
                min(30, poll_seconds * (2 ** (idle_streak - 1)))
                if poll_seconds >= 1
                else poll_seconds
            )
            await _wait_for_stop_or_timeout(stop, sleep_for)
            continue

        idle_streak = 0
        attempts = int(event["attempts"])
        process_completed = False
        try:
            await _process_with_lease(event)
            process_completed = True
            # Shield DONE finalization so cancellation arriving after all crops/samples
            # were persisted does not leave a completed event in PROCESSING.
            await asyncio.shield(
                _finish(event["id"], status="DONE", expected_attempts=attempts)
            )
            record_worker_success("viread_ocr_outbox")
        except OutboxEventSkipped as exc:
            await asyncio.shield(
                _finish(
                    event["id"],
                    status="SKIPPED",
                    expected_attempts=attempts,
                    error_code=exc.code[:64],
                )
            )
            log_diagnostic(
                logger,
                logging.INFO,
                event="viread_ocr_outbox_event_skipped",
                stage="eligibility_check",
                outbox_id=str(event["id"]),
                error_code=exc.code,
            )
        except OutboxEventBlocked as exc:
            await asyncio.shield(
                _finish(
                    event["id"],
                    status="BLOCKED",
                    expected_attempts=attempts,
                    error_code=exc.code[:64],
                )
            )
            log_diagnostic(
                logger,
                logging.WARNING,
                event="viread_ocr_outbox_event_blocked",
                stage="integrity_check",
                outbox_id=str(event["id"]),
                error_code=exc.code,
            )
        except OutboxLeaseLost:
            # A stale worker must never finalize a newer claim. A release is
            # fenced by attempt generation, so it is a no-op after takeover.
            try:
                await asyncio.wait_for(
                    _release_claim_on_cancel(
                        event["id"], expected_attempts=attempts
                    ),
                    timeout=LEASE_HEARTBEAT_TIMEOUT_SECONDS,
                )
            except asyncio.CancelledError:
                raise
            except Exception as exc:
                log_diagnostic(
                    logger, logging.WARNING,
                    event="viread_ocr_outbox_lease_release_failed",
                    stage="lease_loss", error_code=type(exc).__name__.upper(),
                )
            log_diagnostic(
                logger, logging.WARNING,
                event="viread_ocr_outbox_lease_lost",
                stage="materialization", outbox_id=str(event["id"]),
                attempt=attempts,
            )
            await _wait_for_stop_or_timeout(stop, poll_seconds)
        except asyncio.CancelledError:
            if not process_completed:
                try:
                    await asyncio.wait_for(
                        asyncio.shield(
                            _release_claim_on_cancel(
                                event["id"], expected_attempts=attempts
                            )
                        ),
                        timeout=3.0,
                    )
                except (TimeoutError, asyncio.CancelledError, Exception):
                    # If DB teardown is already underway, the 10-minute locked_at lease
                    # guarantees another worker will safely reclaim the event later.
                    pass
            raise
        except Exception as exc:
            if isinstance(exc, (DriveAuthError,)) or (
                isinstance(exc, TrainingStorageError) and exc.retryable
            ):
                # Preserve events cleanly when Google Drive is temporarily full/disconnected/revoked/rate-limited.
                terminal = False
                delay = min(1800, 30 * (2 ** min(attempts, 6)))
                error_code = exc.code[:64]
            else:
                terminal = attempts >= MAX_ATTEMPTS
                delay = min(3600, 2 ** min(attempts, 10))
                error_code = (exc.code if isinstance(exc, TrainingStorageError) else type(exc).__name__)[:64]
            try:
                await _finish(
                    event["id"],
                    status="DEAD" if terminal else "RETRY",
                    expected_attempts=attempts,
                    error_code=error_code,
                    delay_seconds=delay,
                )
            except asyncio.CancelledError:
                raise
            except Exception as finish_exc:
                log_diagnostic(
                    logger,
                    logging.ERROR,
                    event="viread_ocr_outbox_finish_failed",
                    stage="database_finish",
                    exception=finish_exc,
                    outbox_id=str(event["id"]),
                    attempt=attempts,
                )
                await _wait_for_stop_or_timeout(stop, poll_seconds)
            log_diagnostic(logger, logging.ERROR, event="viread_ocr_outbox_processing_failed",
                           stage="line_crop_materialization", exception=exc,
                           outbox_id=str(event["id"]), attempt=attempts, terminal=terminal)


_EVENT_OUTBOX_TASKS: set[asyncio.Task[Any]] = set()
_EVENT_OUTBOX_SEMAPHORES: dict[int, asyncio.Semaphore] = {}


def _configured_enabled() -> bool:
    return os.getenv("VIREAD_OCR_OUTBOX_WORKER_ENABLED", "true").strip().lower() not in {
        "0",
        "false",
        "no",
        "off",
    }


def _event_outbox_semaphore() -> asyncio.Semaphore:
    loop_id = id(asyncio.get_running_loop())
    sem = _EVENT_OUTBOX_SEMAPHORES.get(loop_id)
    if sem is None:
        sem = asyncio.Semaphore(1)
        _EVENT_OUTBOX_SEMAPHORES[loop_id] = sem
    return sem


async def run_once(
    *,
    source: str = "cron",
    execution_mode: str = "cron_scheduled",
    persist_heartbeat: bool = True,
) -> bool:
    """Claim and process a single outbox event. Returns True if an event was claimed."""
    if is_flow2_ingestion_paused():
        return False
    try:
        event = await _claim_one()
    except asyncio.CancelledError:
        raise
    except Exception as exc:
        record_worker_error("viread_ocr_outbox", exc)
        if persist_heartbeat:
            await persist_worker_heartbeat_with_factory(
                AsyncSessionLocal,
                "viread_ocr_outbox",
                execution_mode=execution_mode,
                ok=False,
                items_processed=0,
                source=source,
                error_code=type(exc).__name__,
            )
        raise
    if event is None:
        record_worker_success("viread_ocr_outbox")
        if persist_heartbeat:
            await persist_worker_heartbeat_with_factory(
                AsyncSessionLocal,
                "viread_ocr_outbox",
                execution_mode=execution_mode,
                ok=True,
                items_processed=0,
                source=source,
            )
        return False
    attempts = int(event["attempts"])
    try:
        await _process_with_lease(event)
        await _finish(event["id"], status="DONE", expected_attempts=attempts)
        record_worker_success("viread_ocr_outbox")
        if persist_heartbeat:
            await persist_worker_heartbeat_with_factory(
                AsyncSessionLocal,
                "viread_ocr_outbox",
                execution_mode=execution_mode,
                ok=True,
                items_processed=1,
                source=source,
            )
    except OutboxEventSkipped as exc:
        await _finish(
            event["id"],
            status="SKIPPED",
            expected_attempts=attempts,
            error_code=exc.code[:64],
        )
        record_worker_success("viread_ocr_outbox")
        if persist_heartbeat:
            await persist_worker_heartbeat_with_factory(
                AsyncSessionLocal,
                "viread_ocr_outbox",
                execution_mode=execution_mode,
                ok=True,
                items_processed=1,
                source=source,
            )
    except OutboxEventBlocked as exc:
        await _finish(
            event["id"],
            status="BLOCKED",
            expected_attempts=attempts,
            error_code=exc.code[:64],
        )
        record_worker_success("viread_ocr_outbox")
        if persist_heartbeat:
            await persist_worker_heartbeat_with_factory(
                AsyncSessionLocal,
                "viread_ocr_outbox",
                execution_mode=execution_mode,
                ok=True,
                items_processed=1,
                source=source,
            )
    except asyncio.CancelledError:
        try:
            await asyncio.shield(
                asyncio.wait_for(
                    _release_claim_on_cancel(event["id"], expected_attempts=attempts),
                    timeout=3.0,
                )
            )
        except Exception:
            pass
        raise
    except OutboxLeaseLost:
        await _release_claim_on_cancel(event["id"], expected_attempts=attempts)
    except Exception as exc:
        if isinstance(exc, (DriveAuthError,)) or (
            isinstance(exc, TrainingStorageError) and exc.retryable
        ):
            terminal = False
            delay = min(1800, 30 * (2 ** min(attempts, 6)))
            error_code = exc.code[:64]
        else:
            terminal = attempts >= MAX_ATTEMPTS
            delay = min(3600, 2 ** min(attempts, 10))
            error_code = (exc.code if isinstance(exc, TrainingStorageError) else type(exc).__name__)[:64]
        await _finish(
            event["id"],
            status="DEAD" if terminal else "RETRY",
            expected_attempts=attempts,
            error_code=error_code,
            delay_seconds=delay,
        )
        record_worker_error("viread_ocr_outbox", error_code)
        if persist_heartbeat:
            await persist_worker_heartbeat_with_factory(
                AsyncSessionLocal,
                "viread_ocr_outbox",
                execution_mode=execution_mode,
                ok=False,
                items_processed=0,
                source=source,
                error_code=error_code,
            )
    return True


async def _drain_scheduled_viread_ocr_outbox(*, max_events: int = 8) -> int:
    await asyncio.sleep(0)
    sem = _event_outbox_semaphore()
    processed = 0
    had_error: str | None = None
    async with sem:
        for _ in range(max(1, max_events)):
            try:
                did_work = await run_once(
                    source="event",
                    execution_mode="on_demand",
                    persist_heartbeat=False,
                )
            except asyncio.CancelledError:
                raise
            except Exception as exc:
                had_error = type(exc).__name__
                log_diagnostic(
                    logger,
                    logging.WARNING,
                    event="viread_ocr_outbox_event_drain_failed",
                    stage="event_trigger",
                    exception=exc,
                )
                break
            if not did_work:
                break
            processed += 1
        await persist_worker_heartbeat_with_factory(
            AsyncSessionLocal,
            "viread_ocr_outbox",
            execution_mode="on_demand",
            ok=had_error is None,
            items_processed=processed,
            source="event",
            error_code=had_error,
        )
    return processed


def schedule_viread_ocr_outbox(*, force: bool = False) -> asyncio.Task[Any] | None:
    """Trigger bounded event-driven Flow 2 outbox drain when heavy workers are disabled."""
    from app.database.config import APP_ENVIRONMENT
    from app.services.ocr_inference_job_service import is_heavy_workers_disabled

    if not force:
        app_env = (os.getenv("APP_ENVIRONMENT") or APP_ENVIRONMENT or "").strip().lower()
        if (
            app_env == "test"
            or not is_heavy_workers_disabled()
            or not _configured_enabled()
            or is_flow2_ingestion_paused()
        ):
            return None
    try:
        loop = asyncio.get_running_loop()
    except RuntimeError:
        return None
    active_tasks = [t for t in list(_EVENT_OUTBOX_TASKS) if not t.done()]
    if len(active_tasks) >= 2:
        return active_tasks[-1]
    task = loop.create_task(
        _drain_scheduled_viread_ocr_outbox(),
        name="viread_ocr_outbox_event_drain",
    )
    _EVENT_OUTBOX_TASKS.add(task)
    task.add_done_callback(_EVENT_OUTBOX_TASKS.discard)
    return task


async def shutdown_scheduled_outbox_tasks(*, timeout_seconds: float = 5.0) -> None:
    if not _EVENT_OUTBOX_TASKS:
        return
    pending = [task for task in list(_EVENT_OUTBOX_TASKS) if not task.done()]
    for task in pending:
        task.cancel()
    if pending:
        await asyncio.wait(pending, timeout=timeout_seconds)
