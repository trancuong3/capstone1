from __future__ import annotations

import asyncio
from collections import defaultdict
from datetime import datetime
import hashlib
from io import BytesIO
import json
import logging
import math
from typing import Any
import unicodedata
from uuid import NAMESPACE_URL, uuid5

from PIL import Image
from sqlalchemy import text

from app.database.session import AsyncSessionLocal
from app.diagnostic_logging import log_diagnostic
from app.services.storage_service import download_object
from app.services.training_storage import (
    DriveAuthError,
    DriveQuotaExceededError,
    StorageProvider,
    TrainingArtifactStoreRouter,
    TrainingStorageError,
)
from app.services.viread_drive_connection_service import VireadDriveConnectionService
from app.services.viread_training_storage_quota import (
    ensure_database_capacity,
    ensure_storage_capacity,
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


def normalize_verified_label(tokens: list[str]) -> str:
    """Normalize Admin-verified Vietnamese tokens to NFC while preserving punctuation and spaces."""
    cleaned: list[str] = []
    for raw in tokens:
        text_token = unicodedata.normalize("NFC", str(raw))
        if any(ord(ch) < 32 and ch not in {"\t", " "} for ch in text_token):
            raise ValueError("verified OCR label contains forbidden control characters")
        stripped = " ".join(text_token.split())
        if stripped:
            cleaned.append(stripped)
    return unicodedata.normalize("NFC", " ".join(cleaned))


def deterministic_sample_id(revision_id: Any, line_index: int, image_sha256: str) -> str:
    return str(uuid5(NAMESPACE_URL, f"viread-flow2-sample:{revision_id}:{line_index}:{image_sha256}"))


async def _claim_one() -> dict[str, Any] | None:
    async with AsyncSessionLocal() as db:
        result = await db.execute(text("""
            WITH next_event AS (
                SELECT id FROM public.viread_ocr_outbox
                WHERE (status IN ('PENDING', 'RETRY') AND available_at <= now())
                   OR (status = 'PROCESSING' AND locked_at < now() - interval '10 minutes')
                ORDER BY created_at, id
                FOR UPDATE SKIP LOCKED
                LIMIT 1
            )
            UPDATE public.viread_ocr_outbox AS outbox
            SET status = 'PROCESSING', attempts = outbox.attempts + 1,
                locked_at = now(), updated_at = now()
            FROM next_event
            WHERE outbox.id = next_event.id
            RETURNING outbox.id, outbox.page_id, outbox.revision_id, outbox.actor_id, outbox.attempts
        """))
        row = result.mappings().first()
        await db.commit()
        return dict(row) if row else None


def _line_crops(image_bytes: bytes, words: list[dict[str, Any]]) -> list[tuple[int, bytes, str, str]]:
    try:
        with Image.open(BytesIO(image_bytes)) as source:
            source.load()
            page = source.convert("RGB")
    except Exception as exc:
        raise ValueError("verified OCR source page image is corrupted or unreadable") from exc
    if page.width <= 0 or page.height <= 0:
        raise ValueError("verified OCR source page image has invalid dimensions")

    by_line: dict[int, list[dict[str, Any]]] = defaultdict(list)
    for word in words:
        by_line[int(word["lineindex"])].append(word)
    crops = []
    for line_index, line_words in sorted(by_line.items()):
        line_words.sort(key=lambda item: int(item["wordindex"]))
        bounds = []
        tokens = []
        for word in line_words:
            box = word["boundingbox"]
            if not isinstance(box, list) or len(box) != 4:
                raise ValueError("verified OCR word has invalid geometry")
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
                raise ValueError("verified OCR word geometry is outside normalized page bounds")
            bounds.append(
                (x * page.width, y * page.height, (x + width) * page.width, (y + height) * page.height)
            )
            token = str(word.get("text") or "").strip()
            if token:
                tokens.append(token)
        if not bounds or not tokens:
            continue
        left = min(item[0] for item in bounds)
        top = min(item[1] for item in bounds)
        right = max(item[2] for item in bounds)
        bottom = max(item[3] for item in bounds)
        pad_y = max(2, round((bottom - top) * 0.12))
        crop_box = (
            max(0, math.floor(left)),
            max(0, math.floor(top - pad_y)),
            min(page.width, math.ceil(right)),
            min(page.height, math.ceil(bottom + pad_y)),
        )
        if crop_box[2] <= crop_box[0] or crop_box[3] <= crop_box[1]:
            raise ValueError("verified OCR line crop has zero area")
        label = normalize_verified_label(tokens)
        if not label:
            raise ValueError("verified OCR line label is empty after normalization")
        output = BytesIO()
        page.crop(crop_box).save(output, format="PNG", optimize=True)
        data = output.getvalue()
        if not data:
            raise ValueError("verified OCR line crop produced empty PNG output")
        fingerprint = hashlib.sha256(data + b"\0" + label.encode("utf-8")).hexdigest()
        crops.append((line_index, data, label, fingerprint))
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
            FROM public.viread_ocr_samples
            WHERE source_flow = 'FLOW1_VERIFIED'
              AND image_sha256 = ANY(:hashes)
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


async def _process(event: dict[str, Any]) -> None:
    async with AsyncSessionLocal() as db:
        header_result = await db.execute(text("""
            SELECT COALESCE(NULLIF(r.processingmeta ->> 'source_image_path', ''), p.imagepath) AS imagepath,
                   p.bookid, r.verificationstatus, r.contenthash,
                   r.verifiedby, r.verifiedat,
                   r.processingmeta -> 'ai_proofread_audit' ->> 'mode' AS ai_proofread_mode,
                   to_jsonb(b) ->> 'visibility_scope' AS visibility_scope,
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

    image_path = header_dict["imagepath"]
    if not image_path:
        raise ValueError("verified revision page has no source image path")
    image_bytes = await asyncio.to_thread(download_object, image_path)
    crops = _line_crops(image_bytes, words)
    if not crops:
        raise ValueError("verified revision contains no usable line crops")

    # Detect within-revision and cross-revision duplicate-image-hash label conflicts.
    image_labels: dict[str, str] = {}
    prepared_lines: list[tuple[int, bytes, str, str, str, str]] = []
    for line_index, crop, label, fingerprint in crops:
        image_sha = hashlib.sha256(crop).hexdigest()
        label_sha = hashlib.sha256(label.encode("utf-8")).hexdigest()
        prev_label = image_labels.get(image_sha)
        if prev_label is not None and prev_label != label:
            raise OutboxEventBlocked(
                "CONFLICTING_LABEL_FOR_IMAGE_HASH",
                "Duplicate line crop hash within revision has conflicting verified labels",
            )
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

    async with AsyncSessionLocal() as db:
        conflicts = await _find_conflicting_labels(db, image_labels)
        if conflicts:
            raise OutboxEventBlocked(
                "CONFLICTING_LABEL_FOR_IMAGE_HASH",
                f"Detected {len(conflicts)} duplicate line image hash(es) with conflicting labels",
            )
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
        try:
            event = await _claim_one()
        except asyncio.CancelledError:
            raise
        except Exception as exc:
            log_diagnostic(logger, logging.ERROR, event="viread_ocr_outbox_claim_failed",
                           stage="database_claim", exception=exc)
            await _wait_for_stop_or_timeout(stop, poll_seconds)
            continue
        if event is None:
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
