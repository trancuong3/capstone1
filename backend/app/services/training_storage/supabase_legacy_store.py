from __future__ import annotations

from collections.abc import Callable, Iterator
import hashlib
from pathlib import Path
from typing import BinaryIO

from app.services import storage_service
from app.services.training_storage.base import (
    ArtifactMetadata,
    DriveIntegrityError,
    DriveNotFoundError,
    DriveTransientError,
    StorageHealthStatus,
    StorageQuotaStatus,
    StoredArtifact,
    TrainingArtifactStore,
)
from app.services.training_storage.references import (
    StorageProvider,
    parse_artifact_ref,
    validate_logical_path,
    validate_sha256,
)


class SupabaseLegacyTrainingStore(TrainingArtifactStore):
    """Backward-compatible adapter over existing Supabase Storage for legacy artifacts and Flow 1."""

    provider = StorageProvider.SUPABASE_LEGACY

    def _read_all(self, data: bytes | Path | BinaryIO) -> bytes:
        if isinstance(data, (bytes, bytearray, memoryview)):
            return bytes(data)
        if isinstance(data, Path):
            return data.read_bytes()
        if data.seekable():
            pos = data.tell()
            payload = data.read()
            data.seek(pos)
            return payload
        return data.read()

    def put(
        self,
        logical_path: str,
        data: bytes | Path | BinaryIO,
        *,
        content_type: str = "application/octet-stream",
        expected_sha256: str | None = None,
        metadata: dict[str, str] | None = None,
        size_bytes: int | None = None,
    ) -> StoredArtifact:
        clean_path = validate_logical_path(logical_path, require_known_category=False)
        payload = self._read_all(data)
        actual_sha = hashlib.sha256(payload).hexdigest()
        expected = validate_sha256(expected_sha256, required=False)
        if size_bytes is not None and len(payload) != size_bytes:
            raise DriveIntegrityError("Legacy Supabase upload byte length mismatch")
        if expected and actual_sha != expected:
            raise DriveIntegrityError("Legacy Supabase upload SHA-256 mismatch")
        storage_service.upload_object(
            clean_path,
            payload,
            content_type=content_type,
            upsert=True,
        )
        return StoredArtifact(
            provider=StorageProvider.SUPABASE_LEGACY,
            reference=clean_path,
            logical_path=clean_path,
            sha256=actual_sha,
            size_bytes=len(payload),
            content_type=content_type,
            drive_file_id=None,
            deduplicated=False,
            metadata=dict(metadata or {}),
        )

    def open_stream(
        self,
        reference: str,
        *,
        chunk_size: int = 1024 * 1024,
        expected_sha256: str | None = None,
    ) -> Iterator[bytes]:
        parsed = parse_artifact_ref(reference)
        if parsed.provider != StorageProvider.SUPABASE_LEGACY or not parsed.legacy_path:
            raise ValueError("SupabaseLegacyTrainingStore only accepts legacy relative paths")
        expected = validate_sha256(expected_sha256, required=False)
        try:
            payload = storage_service.download_object(parsed.legacy_path)
        except Exception as exc:
            status_code = getattr(exc, "status_code", None)
            if status_code == 404:
                raise DriveNotFoundError("Legacy training artifact not found in Supabase Storage") from exc
            raise DriveTransientError("Could not read legacy artifact from Supabase Storage") from exc
        actual_sha = hashlib.sha256(payload).hexdigest()
        if expected and actual_sha != expected:
            raise DriveIntegrityError("Legacy training artifact SHA-256 mismatch")
        step = max(16 * 1024, chunk_size)
        for offset in range(0, len(payload), step):
            yield payload[offset : offset + step]

    def get(
        self,
        reference: str,
        *,
        expected_sha256: str | None = None,
        max_bytes: int | None = None,
    ) -> bytes:
        parsed = parse_artifact_ref(reference)
        if parsed.provider != StorageProvider.SUPABASE_LEGACY or not parsed.legacy_path:
            raise ValueError("SupabaseLegacyTrainingStore only accepts legacy relative paths")
        expected = validate_sha256(expected_sha256, required=False)
        try:
            payload = storage_service.download_object(parsed.legacy_path)
        except Exception as exc:
            status_code = getattr(exc, "status_code", None)
            if status_code == 404:
                raise DriveNotFoundError("Legacy training artifact not found in Supabase Storage") from exc
            raise DriveTransientError("Could not read legacy artifact from Supabase Storage") from exc
        if max_bytes is not None and len(payload) > max_bytes:
            raise DriveIntegrityError(f"Legacy artifact exceeds max_bytes limit ({max_bytes})")
        if expected and hashlib.sha256(payload).hexdigest() != expected:
            raise DriveIntegrityError("Legacy training artifact SHA-256 mismatch")
        return payload

    def exists(self, reference: str) -> bool:
        try:
            parsed = parse_artifact_ref(reference)
            if parsed.provider != StorageProvider.SUPABASE_LEGACY or not parsed.legacy_path:
                return False
            storage_service.download_object(parsed.legacy_path)
            return True
        except Exception:
            return False

    def get_metadata(self, reference: str) -> ArtifactMetadata:
        parsed = parse_artifact_ref(reference)
        if parsed.provider != StorageProvider.SUPABASE_LEGACY or not parsed.legacy_path:
            raise ValueError("SupabaseLegacyTrainingStore only accepts legacy relative paths")
        payload = self.get(parsed.legacy_path)
        return ArtifactMetadata(
            provider=StorageProvider.SUPABASE_LEGACY,
            reference=parsed.legacy_path,
            name=parsed.legacy_path.rsplit("/", 1)[-1],
            size_bytes=len(payload),
            sha256=hashlib.sha256(payload).hexdigest(),
            content_type="application/octet-stream",
            trashed=False,
            is_public=False,
            drive_file_id=None,
            logical_path=parsed.legacy_path,
        )

    def delete_if_unreferenced(
        self,
        reference: str,
        *,
        is_referenced_check: Callable[[str], bool],
    ) -> bool:
        parsed = parse_artifact_ref(reference)
        if parsed.provider != StorageProvider.SUPABASE_LEGACY or not parsed.legacy_path:
            raise ValueError("SupabaseLegacyTrainingStore only accepts legacy relative paths")
        if is_referenced_check(parsed.legacy_path):
            return False
        storage_service.delete_object(parsed.legacy_path)
        return True

    def health_check(self) -> StorageHealthStatus:
        return StorageHealthStatus(
            provider=StorageProvider.SUPABASE_LEGACY,
            healthy=True,
            status="LEGACY_READY",
            detail="Supabase legacy training storage adapter is available for legacy reads",
        )

    def quota_check(self, incoming_bytes: int = 0) -> StorageQuotaStatus:
        return StorageQuotaStatus(
            provider=StorageProvider.SUPABASE_LEGACY,
            limit_bytes=None,
            usage_bytes=None,
            usage_in_drive_bytes=None,
            usage_in_trash_bytes=None,
            available_bytes=None,
            min_free_buffer_bytes=0,
            max_training_budget_bytes=None,
            warning_level="UNKNOWN",
            can_accept_upload=True,
            detail="Supabase legacy quota is enforced via viread_training_storage_quota",
        )
