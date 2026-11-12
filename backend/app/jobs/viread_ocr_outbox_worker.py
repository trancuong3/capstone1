from __future__ import annotations

import asyncio
import hashlib
import json
import logging
import math
from collections import defaultdict
from io import BytesIO
from typing import Any

from PIL import Image
from sqlalchemy import text

from app.database.session import AsyncSessionLocal
from app.diagnostic_logging import log_diagnostic
from app.services.storage_service import download_object, upload_object
from app.services.viread_training_storage_quota import ensure_database_capacity, ensure_storage_capacity

logger = logging.getLogger(__name__)
MAX_ATTEMPTS = 8
POLL_SECONDS = 5


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
            RETURNING outbox.id, outbox.page_id, outbox.revision_id, outbox.attempts
        """))
        row = result.mappings().first()
        await db.commit()
        return dict(row) if row else None


def _line_crops(image_bytes: bytes, words: list[dict[str, Any]]) -> list[tuple[int, bytes, str, str]]:
    with Image.open(BytesIO(image_bytes)) as source:
        page = source.convert("RGB")
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
            if not all(math.isfinite(v) for v in (x, y, width, height)) or x < 0 or y < 0 or width <= 0 or height <= 0 or x + width > 1.001 or y + height > 1.001:
                raise ValueError("verified OCR word geometry is outside normalized page bounds")
            bounds.append((x * page.width, y * page.height, (x + width) * page.width, (y + height) * page.height))
            token = str(word["text"]).strip()
            if token:
                tokens.append(token)
        if not bounds or not tokens:
            continue
        left = min(item[0] for item in bounds)
        top = min(item[1] for item in bounds)
        right = max(item[2] for item in bounds)
        bottom = max(item[3] for item in bounds)
        pad_y = max(2, round((bottom - top) * 0.12))
        crop_box = (max(0, math.floor(left)), max(0, math.floor(top - pad_y)),
                    min(page.width, math.ceil(right)), min(page.height, math.ceil(bottom + pad_y)))
        if crop_box[2] <= crop_box[0] or crop_box[3] <= crop_box[1]:
            raise ValueError("verified OCR line crop has zero area")
        label = " ".join(tokens)
        output = BytesIO()
        page.crop(crop_box).save(output, format="PNG", optimize=True)
        data = output.getvalue()
        fingerprint = hashlib.sha256(data + b"\0" + label.encode("utf-8")).hexdigest()
        crops.append((line_index, data, label, fingerprint))
    return crops


async def _process(event: dict[str, Any]) -> None:
    async with AsyncSessionLocal() as db:
        result = await db.execute(text("""
            SELECT p.imagepath, p.width, p.height, r.verificationstatus, r.verifiedtext,
                   r.contenthash, w.wordindex, w.lineindex, w.text, w.boundingbox
            FROM public.bookpages AS p
            JOIN public.pagerevisions AS r ON r.pageid = p.id
            JOIN public.pagerevisionwords AS w ON w.pagerevisionid = r.id
            WHERE p.id = :page_id AND r.id = :revision_id
            ORDER BY w.lineindex, w.wordindex
        """), {"page_id": event["page_id"], "revision_id": event["revision_id"]})
        rows = [dict(row) for row in result.mappings().all()]
    if not rows or rows[0]["verificationstatus"] != "VERIFIED":
        raise ValueError("outbox source revision is missing or not VERIFIED")
    image_path = rows[0]["imagepath"]
    image_bytes = await asyncio.to_thread(download_object, image_path)
    words = [{key: row[key] for key in ("wordindex", "lineindex", "text", "boundingbox")} for row in rows]
    crops = _line_crops(image_bytes, words)
    if not crops:
        raise ValueError("verified revision contains no usable line crops")

    for line_index, crop, label, fingerprint in crops:
        object_path = f"ocr-training/flow1/{event['revision_id']}/{line_index:04d}-{fingerprint}.png"
        async with AsyncSessionLocal() as db:
            await ensure_storage_capacity(db, len(crop), existing_object_path=object_path)
            await db.commit()
        await asyncio.to_thread(upload_object, object_path, crop, "image/png", upsert=True)
        image_hash = hashlib.sha256(crop).hexdigest()
        async with AsyncSessionLocal() as db:
            await ensure_database_capacity(db, len(label.encode("utf-8")) + 2048)
            await db.execute(text("""
                INSERT INTO public.viread_ocr_samples
                    (source_flow, source_group_id, split, image_storage_path, image_sha256,
                     label, source_page_id, source_revision_id, provenance)
                VALUES ('FLOW1_VERIFIED', :group_id, :split, :path, :image_sha, :label,
                        :page_id, :revision_id, CAST(:provenance AS jsonb))
                ON CONFLICT DO NOTHING
            """), {
                "group_id": str(event["page_id"]),
                "split": _stable_split(str(event["page_id"])),
                "path": object_path,
                "image_sha": image_hash,
                "label": label,
                "page_id": event["page_id"],
                "revision_id": event["revision_id"],
                "provenance": json.dumps({"outbox_event_id": str(event["id"]), "line_index": line_index,
                                           "source_content_hash": rows[0]["contenthash"], "verified_by_admin": True}),
            })
            await db.commit()


def _stable_split(group_id: str) -> str:
    value = int(hashlib.sha256(f"viread-vietocr-v2-split-v1\0{group_id}".encode()).hexdigest()[:8], 16) / 0xFFFFFFFF
    return "train" if value < 0.70 else "validation" if value < 0.85 else "holdout"


async def _finish(event_id, *, status: str, error_code: str | None = None, delay_seconds: int = 0) -> None:
    async with AsyncSessionLocal() as db:
        await db.execute(text("""
            UPDATE public.viread_ocr_outbox
            SET status = :status, last_error_code = :error_code, locked_at = NULL,
                available_at = now() + (:delay_seconds * interval '1 second'), updated_at = now()
            WHERE id = :event_id
        """), {"event_id": event_id, "status": status, "error_code": error_code,
              "delay_seconds": delay_seconds})
        await db.commit()


async def run_worker(stop: asyncio.Event, *, poll_seconds: int = POLL_SECONDS) -> None:
    """Durable multi-process-safe outbox worker. Failed events retry and eventually dead-letter."""
    while not stop.is_set():
        try:
            event = await _claim_one()
        except asyncio.CancelledError:
            raise
        except Exception as exc:
            log_diagnostic(logger, logging.ERROR, event="viread_ocr_outbox_claim_failed",
                           stage="database_claim", exception=exc)
            await asyncio.sleep(poll_seconds)
            continue
        if event is None:
            try:
                await asyncio.wait_for(stop.wait(), timeout=poll_seconds)
            except TimeoutError:
                pass
            continue
        try:
            await _process(event)
            await _finish(event["id"], status="DONE")
        except asyncio.CancelledError:
            raise
        except Exception as exc:
            attempts = int(event["attempts"])
            terminal = attempts >= MAX_ATTEMPTS
            delay = min(3600, 2 ** min(attempts, 10))
            await _finish(event["id"], status="DEAD" if terminal else "RETRY",
                          error_code=type(exc).__name__[:64], delay_seconds=delay)
            log_diagnostic(logger, logging.ERROR, event="viread_ocr_outbox_processing_failed",
                           stage="line_crop_materialization", exception=exc,
                           outbox_id=str(event["id"]), attempt=attempts, terminal=terminal)
