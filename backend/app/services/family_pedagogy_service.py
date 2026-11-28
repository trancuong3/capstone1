"""Service layer for Wave 1 Feature #4:
1. Child-Safe Mode Parent PIN Lock (PBKDF2-HMAC-SHA256 + constant-time verify + 5-attempt lockout)
2. Intrinsic Reading Passport (anti-addiction stamps reusing `compute_reading_streak_days` & `goal_streak`)
3. Parent Voice Encouragement Note (`<=10s`, `<=256 KB` verified audio MIME + magic-byte validation,
   private Supabase Storage upload outside DB tx, short-TTL signed URL + authenticated stream).
"""

from __future__ import annotations

import asyncio
from datetime import datetime, timedelta, timezone
import hashlib
import hmac
import logging
import os
import secrets
import unicodedata
from uuid import UUID, uuid4

from fastapi import HTTPException, status

from app.database.config import SUPABASE_PRIVATE_BOOKS_BUCKET
from app.repositories.family_pedagogy_repository import FamilyPedagogyRepository
from app.schemas.family_pedagogy import (
    ParentEncouragementNoteRead,
    ParentPinStatusRead,
    ParentPinUpsertRequest,
    ParentPinVerifyResponse,
    PassportStampRead,
    ReadingPassportRead,
)
from app.services.child_progress.metrics import VIETNAM_TZ, FINISHED_STATES, local_date
from app.services.parent_email_notification_service import compute_reading_streak_days
from app.services.reading_management_rules import goal_cycles, goal_streak
from app.services.reading_management_service import completed_metric
from app.services.storage_service import (
    StorageUploadFailure,
    create_signed_image_url,
    delete_object,
    download_object_async,
    upload_object,
)
from app.services.tts_audio_cache_service import get_tts_cache_bucket

logger = logging.getLogger(__name__)

PIN_PBKDF2_ITERATIONS = 210_000
MAX_PIN_ATTEMPTS = 5
PIN_LOCKOUT_SECONDS = 300  # 5 minutes

PARENT_ENCOURAGEMENT_BUCKET = "viread-parent-encouragements"
MAX_ENCOURAGEMENT_AUDIO_BYTES = 262_144  # 256 KiB
MAX_ENCOURAGEMENT_DURATION_MS = 10_500   # 10s (+500ms browser encoder frame tolerance)
ENCOURAGEMENT_SIGNED_URL_TTL_SECONDS = 300

ALLOWED_AUDIO_MIME_EXTENSIONS: dict[str, str] = {
    "audio/webm": "webm",
    "audio/ogg": "ogg",
    "audio/mpeg": "mp3",
    "audio/mp3": "mp3",
    "audio/mp4": "m4a",
    "audio/x-m4a": "m4a",
    "audio/aac": "aac",
    "audio/wav": "wav",
    "audio/x-wav": "wav",
}

# Fallback in-memory PIN store ONLY when `parent_security_pins` migration hasn't been applied yet
# in local/dev environments so tests and pre-migration previews stay functional.
_FALLBACK_MEMORY_PINS: dict[str, dict] = {}


def clear_fallback_memory_pins() -> None:
    _FALLBACK_MEMORY_PINS.clear()


def hash_parent_pin(pin: str, salt_hex: str) -> str:
    derived = hashlib.pbkdf2_hmac(
        "sha256",
        pin.encode("utf-8"),
        bytes.fromhex(salt_hex),
        PIN_PBKDF2_ITERATIONS,
    )
    return derived.hex()


def verify_parent_pin_constant_time(pin: str, salt_hex: str, expected_hash_hex: str) -> bool:
    candidate = hash_parent_pin(pin, salt_hex)
    return hmac.compare_digest(candidate, expected_hash_hex)


def sniff_verified_audio_mime(data: bytes, declared_content_type: str | None) -> tuple[str, str]:
    """Verify magic bytes + declared MIME so non-audio payloads (HTML/JS/EXE) can never be stored."""
    if not data:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_CONTENT,
            detail="Audio clip must not be empty",
        )
    if len(data) > MAX_ENCOURAGEMENT_AUDIO_BYTES:
        raise HTTPException(
            status_code=413,
            detail="Encouragement audio clip exceeds 256 KB limit",
        )

    base_mime = (declared_content_type or "").split(";")[0].strip().lower()
    header = data[:16]

    # EBML (WebM / Matroska)
    if header.startswith(b"\x1a\x45\xdf\xa3"):
        return "audio/webm", "webm"
    # Ogg Opus / Vorbis
    if header.startswith(b"OggS"):
        return "audio/ogg", "ogg"
    # RIFF WAVE
    if len(header) >= 12 and header[:4] == b"RIFF" and header[8:12] == b"WAVE":
        return "audio/wav", "wav"
    # ID3v2 or MPEG ADTS/MP3 sync frame (0xFF 0xE0 mask)
    if header.startswith(b"ID3") or (len(header) >= 2 and header[0] == 0xFF and (header[1] & 0xE0) == 0xE0):
        if base_mime == "audio/aac":
            return "audio/aac", "aac"
        return "audio/mpeg", "mp3"
    # ISO BMFF ftyp (M4A / MP4 audio)
    if len(header) >= 8 and header[4:8] == b"ftyp":
        return "audio/mp4", "m4a"

    raise HTTPException(
        status_code=status.HTTP_415_UNSUPPORTED_MEDIA_TYPE,
        detail="Unsupported or invalid audio format (allowed: WebM, Ogg, MP3, M4A, WAV)",
    )


class FamilyPedagogyService:
    def __init__(
        self,
        repository: FamilyPedagogyRepository,
        *,
        now_fn=None,
    ) -> None:
        self.repository = repository
        self._now = now_fn or (lambda: datetime.now(timezone.utc))

    def _is_locked(self, locked_until: datetime | None) -> bool:
        if locked_until is None:
            return False
        aware = (
            locked_until
            if locked_until.tzinfo is not None
            else locked_until.replace(tzinfo=timezone.utc)
        )
        return aware > self._now()

    async def get_pin_status(self, parent_id: UUID) -> ParentPinStatusRead:
        storage_ready = await self.repository.is_pin_storage_ready()
        if storage_ready:
            rec = await self.repository.get_pin_record(parent_id)
            await self.repository.release()
            if rec is None:
                return ParentPinStatusRead(
                    has_pin=False,
                    child_mode_default=False,
                    is_locked_out=False,
                    locked_until=None,
                    remaining_attempts=MAX_PIN_ATTEMPTS,
                    storage_ready=True,
                )
            locked = self._is_locked(rec.LockedUntil)
            failed = int(rec.FailedAttempts or 0) if not locked else MAX_PIN_ATTEMPTS
            return ParentPinStatusRead(
                has_pin=True,
                child_mode_default=bool(rec.ChildModeDefault),
                is_locked_out=locked,
                locked_until=rec.LockedUntil if locked else None,
                remaining_attempts=max(0, MAX_PIN_ATTEMPTS - failed) if not locked else 0,
                storage_ready=True,
            )

        mem = _FALLBACK_MEMORY_PINS.get(str(parent_id))
        await self.repository.release()
        if mem is None:
            return ParentPinStatusRead(storage_ready=False)
        locked = self._is_locked(mem.get("locked_until"))
        failed = int(mem.get("failed_attempts", 0))
        return ParentPinStatusRead(
            has_pin=True,
            child_mode_default=bool(mem.get("child_mode_default", False)),
            is_locked_out=locked,
            locked_until=mem.get("locked_until") if locked else None,
            remaining_attempts=max(0, MAX_PIN_ATTEMPTS - failed) if not locked else 0,
            storage_ready=False,
        )

    async def upsert_pin(
        self, parent_id: UUID, payload: ParentPinUpsertRequest
    ) -> ParentPinStatusRead:
        storage_ready = await self.repository.is_pin_storage_ready()
        if storage_ready:
            existing = await self.repository.get_pin_record(parent_id)
            if existing is not None:
                if self._is_locked(existing.LockedUntil):
                    raise HTTPException(
                        status_code=status.HTTP_429_TOO_MANY_REQUESTS,
                        detail="PIN_LOCKED_OUT",
                    )
                if not payload.current_pin or not verify_parent_pin_constant_time(
                    payload.current_pin, existing.PinSalt, existing.PinHash
                ):
                    await self._register_db_pin_failure(existing)
                    raise HTTPException(
                        status_code=status.HTTP_403_FORBIDDEN,
                        detail="INVALID_CURRENT_PIN",
                    )
            salt_hex = secrets.token_bytes(16).hex()
            pin_hash = hash_parent_pin(payload.pin, salt_hex)
            saved = await self.repository.upsert_pin_record(
                parent_id=parent_id,
                pin_hash=pin_hash,
                pin_salt=salt_hex,
                child_mode_default=payload.child_mode_default,
            )
            return ParentPinStatusRead(
                has_pin=True,
                child_mode_default=bool(saved.ChildModeDefault),
                is_locked_out=False,
                locked_until=None,
                remaining_attempts=MAX_PIN_ATTEMPTS,
                storage_ready=True,
            )

        mem = _FALLBACK_MEMORY_PINS.get(str(parent_id))
        if mem is not None:
            if self._is_locked(mem.get("locked_until")):
                raise HTTPException(
                    status_code=status.HTTP_429_TOO_MANY_REQUESTS,
                    detail="PIN_LOCKED_OUT",
                )
            if not payload.current_pin or not verify_parent_pin_constant_time(
                payload.current_pin, mem["pin_salt"], mem["pin_hash"]
            ):
                raise HTTPException(
                    status_code=status.HTTP_403_FORBIDDEN,
                    detail="INVALID_CURRENT_PIN",
                )
        salt_hex = secrets.token_bytes(16).hex()
        _FALLBACK_MEMORY_PINS[str(parent_id)] = {
            "pin_salt": salt_hex,
            "pin_hash": hash_parent_pin(payload.pin, salt_hex),
            "child_mode_default": payload.child_mode_default,
            "failed_attempts": 0,
            "locked_until": None,
        }
        return ParentPinStatusRead(
            has_pin=True,
            child_mode_default=payload.child_mode_default,
            is_locked_out=False,
            locked_until=None,
            remaining_attempts=MAX_PIN_ATTEMPTS,
            storage_ready=False,
        )

    async def _register_db_pin_failure(self, rec) -> tuple[int, datetime | None]:
        next_failed = int(rec.FailedAttempts or 0) + 1
        locked_until = None
        if next_failed >= MAX_PIN_ATTEMPTS:
            locked_until = self._now() + timedelta(seconds=PIN_LOCKOUT_SECONDS)
            next_failed = MAX_PIN_ATTEMPTS
        await self.repository.record_pin_attempt(
            rec, failed_attempts=next_failed, locked_until=locked_until
        )
        return max(0, MAX_PIN_ATTEMPTS - next_failed), locked_until

    async def verify_pin(self, parent_id: UUID, pin: str) -> ParentPinVerifyResponse:
        storage_ready = await self.repository.is_pin_storage_ready()
        if storage_ready:
            rec = await self.repository.get_pin_record(parent_id)
            if rec is None:
                await self.repository.release()
                raise HTTPException(
                    status_code=status.HTTP_404_NOT_FOUND,
                    detail="PIN_NOT_CONFIGURED",
                )
            if self._is_locked(rec.LockedUntil):
                await self.repository.release()
                raise HTTPException(
                    status_code=status.HTTP_429_TOO_MANY_REQUESTS,
                    detail="PIN_LOCKED_OUT",
                )
            if verify_parent_pin_constant_time(pin, rec.PinSalt, rec.PinHash):
                if (rec.FailedAttempts or 0) > 0 or rec.LockedUntil is not None:
                    await self.repository.record_pin_attempt(
                        rec, failed_attempts=0, locked_until=None
                    )
                else:
                    await self.repository.release()
                return ParentPinVerifyResponse(
                    verified=True,
                    remaining_attempts=MAX_PIN_ATTEMPTS,
                    locked_until=None,
                )

            remaining, locked_until = await self._register_db_pin_failure(rec)
            return ParentPinVerifyResponse(
                verified=False,
                remaining_attempts=remaining,
                locked_until=locked_until,
            )

        mem = _FALLBACK_MEMORY_PINS.get(str(parent_id))
        if mem is None:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail="PIN_NOT_CONFIGURED",
            )
        if self._is_locked(mem.get("locked_until")):
            raise HTTPException(
                status_code=status.HTTP_429_TOO_MANY_REQUESTS,
                detail="PIN_LOCKED_OUT",
            )
        if verify_parent_pin_constant_time(pin, mem["pin_salt"], mem["pin_hash"]):
            mem["failed_attempts"] = 0
            mem["locked_until"] = None
            return ParentPinVerifyResponse(
                verified=True,
                remaining_attempts=MAX_PIN_ATTEMPTS,
                locked_until=None,
            )
        mem["failed_attempts"] = int(mem.get("failed_attempts", 0)) + 1
        if mem["failed_attempts"] >= MAX_PIN_ATTEMPTS:
            mem["locked_until"] = self._now() + timedelta(seconds=PIN_LOCKOUT_SECONDS)
            mem["failed_attempts"] = MAX_PIN_ATTEMPTS
        return ParentPinVerifyResponse(
            verified=False,
            remaining_attempts=max(0, MAX_PIN_ATTEMPTS - mem["failed_attempts"]),
            locked_until=mem.get("locked_until"),
        )

    async def delete_pin(self, parent_id: UUID, current_pin: str) -> ParentPinStatusRead:
        storage_ready = await self.repository.is_pin_storage_ready()
        if storage_ready:
            rec = await self.repository.get_pin_record(parent_id)
            if rec is None:
                await self.repository.release()
                return ParentPinStatusRead(storage_ready=True)
            if self._is_locked(rec.LockedUntil):
                await self.repository.release()
                raise HTTPException(
                    status_code=status.HTTP_429_TOO_MANY_REQUESTS,
                    detail="PIN_LOCKED_OUT",
                )
            if not verify_parent_pin_constant_time(current_pin, rec.PinSalt, rec.PinHash):
                await self._register_db_pin_failure(rec)
                raise HTTPException(
                    status_code=status.HTTP_403_FORBIDDEN,
                    detail="INVALID_CURRENT_PIN",
                )
            await self.repository.delete_pin_record(rec)
            return ParentPinStatusRead(storage_ready=True)

        mem = _FALLBACK_MEMORY_PINS.get(str(parent_id))
        if mem is not None:
            if not verify_parent_pin_constant_time(
                current_pin, mem["pin_salt"], mem["pin_hash"]
            ):
                raise HTTPException(
                    status_code=status.HTTP_403_FORBIDDEN,
                    detail="INVALID_CURRENT_PIN",
                )
            _FALLBACK_MEMORY_PINS.pop(str(parent_id), None)
        return ParentPinStatusRead(storage_ready=False)

    async def get_reading_passport(
        self, child_id: UUID, parent_id: UUID
    ) -> ReadingPassportRead:
        child = await self.repository.owned_child(child_id, parent_id)
        if child is None:
            await self.repository.release()
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail="Child profile not found",
            )
        alias = str(child.Alias or "Bé")
        facts = await self.repository.load_passport_facts(child_id)
        await self.repository.release()

        now_vn = self._now().astimezone(VIETNAM_TZ)
        today_vn = now_vn.date()

        raw_sessions = facts["sessions"]
        finished_sessions = [row for row in raw_sessions if row[2] in FINISHED_STATES]
        session_dates = [local_date(row[3]) for row in finished_sessions if row[3] is not None]
        streak_days = compute_reading_streak_days(session_dates, today_vn)
        completed_count = len(finished_sessions)
        books_explored = len({row[1] for row in finished_sessions if row[1] is not None})
        mastered_words = int(facts["mastered_words"])
        comp_correct = int(facts["comprehension_correct"])

        # Reuse ReadingManagement goal_cycles + goal_streak for goal-keeper stamp!
        best_goal_streak = 0
        # Build lightweight session objects for completed_metric
        class _LightSession:
            def __init__(self, row):
                self.Id = row[0]
                self.BookId = row[1]
                self.State = row[2]
                self.StartedAt = row[3]
                self.EndedAt = row[4]

        light_sessions = [_LightSession(r) for r in finished_sessions]
        for goal in facts["goals"]:
            try:
                cycles = goal_cycles(goal, now_vn, count=14)
                if not cycles:
                    continue
                target_val = max(1, int(getattr(goal, "TargetValue", 1) or 1))
                metric_name = str(getattr(goal, "Metric", "SESSIONS") or "SESSIONS")
                last_in_progress = cycles[-1].ends_at > now_vn
                streak_val = goal_streak(
                    cycles,
                    target_val,
                    lambda cyc: completed_metric(
                        light_sessions, metric_name, now_vn, cyc.starts_at, cyc.ends_at
                    ),
                    last_in_progress=last_in_progress,
                )
                best_goal_streak = max(best_goal_streak, streak_val)
            except Exception:
                continue

        stamps = [
            PassportStampRead(
                stamp_key="first_story_step",
                category="BOOKS",
                title_vi="Bước chân mở sách",
                description_vi="Hoàn thành phiên đọc sách đầu tiên đầy tự tin.",
                unlocked=completed_count >= 1,
                progress_current=min(1, completed_count),
                progress_target=1,
            ),
            PassportStampRead(
                stamp_key="warm_streak_3",
                category="STREAK",
                title_vi="Ba ngày đọc ấm áp",
                description_vi="Duy trì thói quen đọc sách 3 ngày liên tiếp theo nhịp riêng của bé.",
                unlocked=streak_days >= 3,
                progress_current=min(3, streak_days),
                progress_target=3,
            ),
            PassportStampRead(
                stamp_key="book_explorer_3",
                category="BOOKS",
                title_vi="Nhà thám hiểm trang sách",
                description_vi="Khám phá trọn vẹn 3 cuốn sách khác nhau.",
                unlocked=books_explored >= 3,
                progress_current=min(3, books_explored),
                progress_target=3,
            ),
            PassportStampRead(
                stamp_key="word_courage_5",
                category="COURAGE_WORDS",
                title_vi="Dũng sĩ chinh phục từ khó",
                description_vi="Luyện đọc chuẩn xác 5 từ từng gặp thử thách.",
                unlocked=mastered_words >= 5,
                progress_current=min(5, mastered_words),
                progress_target=5,
            ),
            PassportStampRead(
                stamp_key="story_listener_5",
                category="COMPREHENSION",
                title_vi="Người bạn hiểu chuyện",
                description_vi="Trả lời đúng 5 câu hỏi đọc hiểu câu chuyện.",
                unlocked=comp_correct >= 5,
                progress_current=min(5, comp_correct),
                progress_target=5,
            ),
            PassportStampRead(
                stamp_key="goal_keeper_2",
                category="GOAL_KEEPER",
                title_vi="Giữ nhịp mục tiêu gia đình",
                description_vi="Hoàn thành mục tiêu đọc sách 2 chu kỳ liên tiếp.",
                unlocked=best_goal_streak >= 2,
                progress_current=min(2, best_goal_streak),
                progress_target=2,
            ),
        ]

        unlocked_count = sum(1 for item in stamps if item.unlocked)
        if streak_days >= 3:
            gentle_msg = f"{alias} đang giữ nhịp {streak_days} ngày đọc liên tiếp thật đều đặn — đọc vừa sức rồi nghỉ mắt nhé!"
        elif completed_count >= 1:
            gentle_msg = f"{alias} đã sưu tầm {unlocked_count}/{len(stamps)} con dấu trong Hộ chiếu đọc sách. Mỗi ngày đọc vài trang là đã rất tuyệt!"
        else:
            gentle_msg = f"Hộ chiếu đọc sách của {alias} đã sẵn sàng đón con dấu đầu tiên hôm nay!"

        return ReadingPassportRead(
            child_id=child_id,
            child_alias=alias,
            streak_days=streak_days,
            best_goal_streak_cycles=best_goal_streak,
            completed_sessions=completed_count,
            books_explored=books_explored,
            mastered_difficult_words=mastered_words,
            comprehension_correct=comp_correct,
            unlocked_stamps_count=unlocked_count,
            total_stamps_count=len(stamps),
            stamps=stamps,
            gentle_message_vi=gentle_msg,
            has_parent_encouragement=bool(facts["has_parent_encouragement"]),
        )

    def _to_note_read(
        self, note, *, signed_url: str | None = None
    ) -> ParentEncouragementNoteRead:
        return ParentEncouragementNoteRead(
            id=note.Id,
            child_id=note.ChildId,
            title=note.Title,
            mime_type=note.MimeType,
            size_bytes=note.SizeBytes,
            duration_ms=note.DurationMs,
            audio_stream_path=f"/profiles/children/{note.ChildId}/encouragement-note/{note.Id}/audio",
            signed_audio_url=signed_url,
            created_at=note.CreatedAt,
        )

    async def get_encouragement_note(
        self, child_id: UUID, parent_id: UUID
    ) -> ParentEncouragementNoteRead | None:
        child = await self.repository.owned_child(child_id, parent_id)
        if child is None:
            await self.repository.release()
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail="Child profile not found",
            )
        note = await self.repository.get_active_encouragement_note(child_id, parent_id)
        await self.repository.release()
        if note is None:
            return None

        signed_url: str | None = None
        if not os.getenv("VIREAD_LOCAL_STORAGE_DIR", "").strip():
            try:
                signed_url = await asyncio.to_thread(
                    create_signed_image_url,
                    note.StoragePath,
                    bucket_name=note.StorageBucket,
                    ttl_seconds=ENCOURAGEMENT_SIGNED_URL_TTL_SECONDS,
                )
            except Exception:
                signed_url = None
        return self._to_note_read(note, signed_url=signed_url)

    async def upload_encouragement_note(
        self,
        *,
        child_id: UUID,
        parent_id: UUID,
        audio_bytes: bytes,
        declared_content_type: str | None,
        title: str | None = None,
        duration_ms: int | None = None,
    ) -> ParentEncouragementNoteRead:
        child = await self.repository.owned_child(child_id, parent_id)
        if child is None:
            await self.repository.release()
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail="Child profile not found",
            )
        if not await self.repository.is_encouragement_storage_ready():
            await self.repository.release()
            raise HTTPException(
                status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
                detail="ENCOURAGEMENT_STORAGE_NOT_MIGRATED",
            )

        if duration_ms is not None and (
            duration_ms <= 0 or duration_ms > MAX_ENCOURAGEMENT_DURATION_MS
        ):
            await self.repository.release()
            raise HTTPException(
                status_code=status.HTTP_422_UNPROCESSABLE_CONTENT,
                detail="Encouragement audio duration must be between 1ms and 10000ms",
            )

        verified_mime, ext = sniff_verified_audio_mime(audio_bytes, declared_content_type)
        clean_title = (
            unicodedata.normalize("NFC", title.strip())[:100]
            if isinstance(title, str) and title.strip()
            else None
        )
        note_id = uuid4()
        object_path = f"parent-encouragements/{parent_id}/{child_id}/{note_id}.{ext}"

        # Release Supavisor read transaction BEFORE uploading bytes to Supabase Storage!
        await self.repository.release()

        chosen_bucket = PARENT_ENCOURAGEMENT_BUCKET
        try:
            await asyncio.to_thread(
                upload_object,
                object_path,
                audio_bytes,
                verified_mime,
                bucket_name=chosen_bucket,
                upsert=False,
            )
        except StorageUploadFailure:
            # Fallback to existing private audio bucket if `viread-parent-encouragements` bucket
            # has not been created on Supabase yet.
            chosen_bucket = get_tts_cache_bucket() or SUPABASE_PRIVATE_BOOKS_BUCKET
            try:
                await asyncio.to_thread(
                    upload_object,
                    object_path,
                    audio_bytes,
                    verified_mime,
                    bucket_name=chosen_bucket,
                    upsert=False,
                )
            except StorageUploadFailure as fallback_exc:
                raise HTTPException(
                    status_code=status.HTTP_502_BAD_GATEWAY,
                    detail="Failed to store parent encouragement audio",
                ) from fallback_exc

        try:
            saved, old_objects = await self.repository.replace_active_encouragement_note(
                note_id=note_id,
                child_id=child_id,
                parent_id=parent_id,
                title=clean_title,
                storage_bucket=chosen_bucket,
                storage_path=object_path,
                mime_type=verified_mime,
                size_bytes=len(audio_bytes),
                duration_ms=duration_ms,
            )
        except Exception:
            await asyncio.to_thread(delete_object, object_path, bucket_name=chosen_bucket)
            raise

        for old_bucket, old_path in old_objects:
            if (old_bucket, old_path) != (chosen_bucket, object_path):
                await asyncio.to_thread(delete_object, old_path, bucket_name=old_bucket)

        signed_url: str | None = None
        if not os.getenv("VIREAD_LOCAL_STORAGE_DIR", "").strip():
            try:
                signed_url = await asyncio.to_thread(
                    create_signed_image_url,
                    saved.StoragePath,
                    bucket_name=saved.StorageBucket,
                    ttl_seconds=ENCOURAGEMENT_SIGNED_URL_TTL_SECONDS,
                )
            except Exception:
                signed_url = None
        return self._to_note_read(saved, signed_url=signed_url)

    async def download_encouragement_audio(
        self, child_id: UUID, note_id: UUID, parent_id: UUID
    ) -> tuple[bytes, str]:
        child = await self.repository.owned_child(child_id, parent_id)
        if child is None:
            await self.repository.release()
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail="Child profile not found",
            )
        note = await self.repository.get_encouragement_note_by_id(
            note_id, child_id, parent_id
        )
        await self.repository.release()
        if note is None:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail="Encouragement note not found",
            )

        audio_bytes = await download_object_async(
            note.StoragePath, bucket_name=note.StorageBucket
        )
        return audio_bytes, note.MimeType

    async def delete_encouragement_note(
        self, child_id: UUID, note_id: UUID, parent_id: UUID
    ) -> None:
        child = await self.repository.owned_child(child_id, parent_id)
        if child is None:
            await self.repository.release()
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail="Child profile not found",
            )
        note = await self.repository.get_encouragement_note_by_id(
            note_id, child_id, parent_id
        )
        if note is None:
            await self.repository.release()
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail="Encouragement note not found",
            )
        bucket, path = note.StorageBucket, note.StoragePath
        await self.repository.delete_encouragement_note(note)
        await asyncio.to_thread(delete_object, path, bucket_name=bucket)
