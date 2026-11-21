from __future__ import annotations

from abc import ABC, abstractmethod
from collections.abc import Callable, Iterator
from dataclasses import dataclass, field
import hashlib
from pathlib import Path
from typing import Any, BinaryIO

from app.services.training_storage.references import StorageProvider, validate_sha256


class TrainingStorageError(RuntimeError):
    """Base error for training artifact storage operations (never contains raw tokens)."""

    def __init__(
        self,
        message: str,
        *,
        code: str = "TRAINING_STORAGE_ERROR",
        http_status: int | None = None,
        retryable: bool = False,
    ) -> None:
        super().__init__(message)
        self.code = code
        self.http_status = http_status
        self.retryable = retryable


class DriveNotConnectedError(TrainingStorageError):
    def __init__(self, message: str = "Google Drive storage is not connected for Flow 2 training") -> None:
        super().__init__(message, code="DRIVE_NOT_CONNECTED", http_status=503, retryable=True)


class DriveAuthError(TrainingStorageError):
    def __init__(
        self,
        message: str = "Google Drive authentication failed or was revoked",
        *,
        code: str = "DRIVE_AUTH_FAILED",
        http_status: int | None = 401,
        token_revoked: bool = False,
    ) -> None:
        super().__init__(message, code=code, http_status=http_status, retryable=False)
        self.token_revoked = token_revoked


class DrivePermissionError(TrainingStorageError):
    def __init__(
        self,
        message: str = "Google Drive permission denied or insufficient OAuth scope",
        *,
        code: str = "DRIVE_PERMISSION_DENIED",
        http_status: int | None = 403,
    ) -> None:
        super().__init__(message, code=code, http_status=http_status, retryable=False)


class DriveQuotaExceededError(TrainingStorageError):
    def __init__(
        self,
        message: str = "Google Drive free storage quota would be exceeded; upload halted safely",
        *,
        code: str = "DRIVE_QUOTA_EXCEEDED",
        required_bytes: int | None = None,
        available_bytes: int | None = None,
        limit_bytes: int | None = None,
        usage_bytes: int | None = None,
    ) -> None:
        super().__init__(message, code=code, http_status=507, retryable=True)
        self.required_bytes = required_bytes
        self.available_bytes = available_bytes
        self.limit_bytes = limit_bytes
        self.usage_bytes = usage_bytes


class DriveRateLimitError(TrainingStorageError):
    def __init__(
        self,
        message: str = "Google Drive API rate limit reached; retry later",
        *,
        http_status: int | None = 429,
    ) -> None:
        super().__init__(message, code="DRIVE_RATE_LIMITED", http_status=http_status, retryable=True)


class DriveNotFoundError(TrainingStorageError):
    def __init__(self, message: str = "Training artifact was not found in storage") -> None:
        super().__init__(message, code="DRIVE_OBJECT_NOT_FOUND", http_status=404, retryable=False)


class DriveIntegrityError(TrainingStorageError):
    def __init__(
        self,
        message: str = "Training artifact checksum or size verification failed",
        *,
        code: str = "ARTIFACT_INTEGRITY_MISMATCH",
    ) -> None:
        super().__init__(message, code=code, http_status=422, retryable=False)


class DriveTransientError(TrainingStorageError):
    def __init__(
        self,
        message: str = "Google Drive storage encountered a temporary error",
        *,
        code: str = "DRIVE_TRANSIENT_ERROR",
        http_status: int | None = 503,
    ) -> None:
        super().__init__(message, code=code, http_status=http_status, retryable=True)


@dataclass(frozen=True)
class StoredArtifact:
    provider: StorageProvider
    reference: str
    logical_path: str
    sha256: str
    size_bytes: int
    content_type: str
    drive_file_id: str | None = None
    deduplicated: bool = False
    metadata: dict[str, Any] = field(default_factory=dict)


@dataclass(frozen=True)
class ArtifactMetadata:
    provider: StorageProvider
    reference: str
    name: str | None
    size_bytes: int | None
    sha256: str | None
    content_type: str | None
    trashed: bool = False
    is_public: bool = False
    drive_file_id: str | None = None
    logical_path: str | None = None
    extra: dict[str, Any] = field(default_factory=dict)


@dataclass(frozen=True)
class StorageQuotaStatus:
    provider: StorageProvider
    limit_bytes: int | None
    usage_bytes: int | None
    usage_in_drive_bytes: int | None
    usage_in_trash_bytes: int | None
    available_bytes: int | None
    min_free_buffer_bytes: int
    max_training_budget_bytes: int | None
    warning_level: str  # OK | WARNING | CRITICAL | EXCEEDED | UNKNOWN
    can_accept_upload: bool
    detail: str | None = None


@dataclass(frozen=True)
class StorageHealthStatus:
    provider: StorageProvider
    healthy: bool
    status: str  # CONNECTED | DISCONNECTED | ERROR | TOKEN_REVOKED | LEGACY_READY
    account_email: str | None = None
    scope: str | None = None
    root_folder_id: str | None = None
    root_folder_path: str | None = None
    quota: StorageQuotaStatus | None = None
    error_code: str | None = None
    detail: str | None = None


class TrainingArtifactStore(ABC):
    """Provider-agnostic interface for Flow 2 training artifacts."""

    provider: StorageProvider

    @abstractmethod
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
        """Upload an artifact privately, verifying quota, size, and SHA-256 integrity."""

    @abstractmethod
    def get(
        self,
        reference: str,
        *,
        expected_sha256: str | None = None,
        max_bytes: int | None = None,
    ) -> bytes:
        """Download a bounded artifact into memory with optional SHA-256 verification."""

    @abstractmethod
    def open_stream(
        self,
        reference: str,
        *,
        chunk_size: int = 1024 * 1024,
        expected_sha256: str | None = None,
    ) -> Iterator[bytes]:
        """Stream an artifact in bounded chunks, verifying SHA-256 on EOF when supplied."""

    @abstractmethod
    def exists(self, reference: str) -> bool:
        """Return True if the artifact exists and is not trashed."""

    @abstractmethod
    def get_metadata(self, reference: str) -> ArtifactMetadata:
        """Return provider metadata without downloading the object payload."""

    @abstractmethod
    def delete_if_unreferenced(
        self,
        reference: str,
        *,
        is_referenced_check: Callable[[str], bool],
    ) -> bool:
        """Delete an artifact ONLY when is_referenced_check(reference) returns False."""

    @abstractmethod
    def health_check(self) -> StorageHealthStatus:
        """Check connectivity, permissions, and dedicated root folder health."""

    @abstractmethod
    def quota_check(self, incoming_bytes: int = 0) -> StorageQuotaStatus:
        """Inspect available storage quota and whether incoming_bytes can be safely uploaded."""

    def verify_checksum(self, reference: str, expected_sha256: str) -> bool:
        """Verify an artifact's SHA-256 using provider metadata when authoritative or streaming fallback."""
        normalized = validate_sha256(expected_sha256, required=True)
        meta = self.get_metadata(reference)
        if meta.trashed:
            return False
        if meta.sha256:
            return meta.sha256.lower() == normalized
        digest = hashlib.sha256()
        for chunk in self.open_stream(reference):
            digest.update(chunk)
        return digest.hexdigest() == normalized

    def download_to_path(
        self,
        reference: str,
        destination: Path,
        *,
        expected_sha256: str | None = None,
        chunk_size: int = 1024 * 1024,
    ) -> tuple[int, str]:
        """Atomically stream an artifact to disk with SHA-256 verification."""
        expected = validate_sha256(expected_sha256, required=False)
        destination.parent.mkdir(parents=True, exist_ok=True)
        temp_path = destination.with_suffix(destination.suffix + ".tmp")
        digest = hashlib.sha256()
        total = 0
        try:
            with temp_path.open("wb") as handle:
                for chunk in self.open_stream(reference, chunk_size=chunk_size):
                    handle.write(chunk)
                    digest.update(chunk)
                    total += len(chunk)
            actual = digest.hexdigest()
            if expected and actual != expected:
                raise DriveIntegrityError(
                    f"Downloaded artifact SHA-256 mismatch: expected {expected[:12]}, got {actual[:12]}"
                )
            temp_path.replace(destination)
            return total, actual
        except Exception:
            temp_path.unlink(missing_ok=True)
            raise
