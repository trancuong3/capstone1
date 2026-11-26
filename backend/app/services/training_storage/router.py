from __future__ import annotations

import base64
from collections.abc import Callable, Iterator
from dataclasses import dataclass
import hashlib
import hmac
import json
import os
from pathlib import Path
import threading
import time
from typing import BinaryIO

from app.services.training_storage.base import (
    ArtifactMetadata,
    DriveNotConnectedError,
    DriveNotFoundError,
    StorageHealthStatus,
    StorageQuotaStatus,
    StoredArtifact,
    TrainingArtifactStore,
)
from app.services.training_storage.google_apps_script_store import GoogleAppsScriptDriveStore
from app.services.training_storage.google_drive_desktop_store import GoogleDriveDesktopStore
from app.services.training_storage.google_drive_store import GoogleDriveTrainingStore

DriveStoreType = GoogleDriveTrainingStore | GoogleAppsScriptDriveStore | GoogleDriveDesktopStore
from app.services.training_storage.references import (
    StorageProvider,
    parse_artifact_ref,
    validate_sha256,
)
from app.services.training_storage.supabase_legacy_store import SupabaseLegacyTrainingStore

DEFAULT_WORKER_STREAM_TOKEN_TTL = 1800  # 30 minutes


def flow2_storage_provider_setting() -> StorageProvider:
    """Return the configured write provider for Flow 2 training artifacts.

    Defaults strictly to Google Drive (`google_drive`) so Flow 2 never silently
    falls back to Supabase Storage when Drive is disconnected or full.
    """
    raw = (os.getenv("VIREAD_FLOW2_STORAGE_PROVIDER") or "google_drive").strip().lower()
    if raw in {"supabase", "supabase_legacy", "legacy"}:
        return StorageProvider.SUPABASE_LEGACY
    return StorageProvider.GOOGLE_DRIVE


def _worker_stream_signing_key() -> bytes:
    """Derive HMAC key strictly from server-only secrets (NEVER VIREAD_TRAINING_WORKER_TOKEN)."""
    secret = (
        os.getenv("VIREAD_ARTIFACT_STREAM_SIGNING_SECRET")
        or os.getenv("VIREAD_GDRIVE_TOKEN_ENCRYPTION_KEY")
        or os.getenv("SUPABASE_SECRET_KEY")
        or os.getenv("SUPABASE_SERVICE_ROLE_KEY")
        or ""
    ).strip()
    if len(secret) < 32:
        raise RuntimeError(
            "Server-only artifact stream signing secret is not configured "
            "(set VIREAD_GDRIVE_TOKEN_ENCRYPTION_KEY or VIREAD_ARTIFACT_STREAM_SIGNING_SECRET)"
        )
    return hashlib.sha256(f"viread-flow2-artifact-stream-v2:{secret}".encode("utf-8")).digest()


def _b64url_encode(raw: bytes) -> str:
    return base64.urlsafe_b64encode(raw).decode("ascii").rstrip("=")


def _b64url_decode(token: str) -> bytes:
    padding = "=" * (-len(token) % 4)
    return base64.urlsafe_b64decode(token + padding)


@dataclass(frozen=True)
class WorkerArtifactStreamClaims:
    job_id: str
    worker_id: str
    reference: str
    expected_sha256: str | None
    expires_at: int


def sign_worker_artifact_token(
    *,
    job_id: str,
    worker_id: str,
    reference: str,
    expected_sha256: str | None = None,
    ttl_seconds: int = DEFAULT_WORKER_STREAM_TOKEN_TTL,
) -> str:
    """Create a short-lived HMAC token binding one worker artifact download to job_id + worker_id + ref."""
    parsed = parse_artifact_ref(reference)
    clean_sha = validate_sha256(expected_sha256, required=False)
    payload = {
        "job_id": str(job_id),
        "worker_id": str(worker_id),
        "ref": parsed.raw,
        "sha256": clean_sha,
        "exp": int(time.time()) + max(60, min(ttl_seconds, 7200)),
    }
    body = _b64url_encode(json.dumps(payload, separators=(",", ":"), sort_keys=True).encode("utf-8"))
    sig = _b64url_encode(hmac.new(_worker_stream_signing_key(), body.encode("ascii"), hashlib.sha256).digest())
    return f"{body}.{sig}"


def verify_worker_artifact_token(
    token: str,
    *,
    expected_job_id: str,
    expected_worker_id: str,
    now_ts: int | None = None,
) -> WorkerArtifactStreamClaims:
    parts = (token or "").strip().split(".")
    if len(parts) != 2 or not parts[0] or not parts[1]:
        raise ValueError("Invalid worker artifact stream token format")
    body, provided_sig = parts
    expected_sig = _b64url_encode(
        hmac.new(_worker_stream_signing_key(), body.encode("ascii"), hashlib.sha256).digest()
    )
    if not hmac.compare_digest(provided_sig, expected_sig):
        raise ValueError("Worker artifact stream token signature is invalid")
    try:
        payload = json.loads(_b64url_decode(body).decode("utf-8"))
    except Exception as exc:
        raise ValueError("Worker artifact stream token payload is corrupted") from exc
    now = int(time.time()) if now_ts is None else int(now_ts)
    exp = int(payload.get("exp") or 0)
    if exp < now:
        raise ValueError("Worker artifact stream token has expired")
    if str(payload.get("job_id") or "") != str(expected_job_id):
        raise ValueError("Worker artifact stream token does not match job_id")
    if str(payload.get("worker_id") or "") != str(expected_worker_id):
        raise ValueError("Worker artifact stream token does not match worker_id")
    parsed = parse_artifact_ref(str(payload.get("ref") or ""))
    clean_sha = validate_sha256(payload.get("sha256"), required=False)
    return WorkerArtifactStreamClaims(
        job_id=str(expected_job_id),
        worker_id=str(expected_worker_id),
        reference=parsed.raw,
        expected_sha256=clean_sha,
        expires_at=exp,
    )


class TrainingArtifactStoreRouter:
    """Routes reads by explicit provider prefix and writes by Flow 2 configuration.

    CRITICAL INVARIANT: When Flow 2 is configured for Google Drive (`google_drive`),
    write failures or disconnected Drive NEVER silently fall back to Supabase Storage.
    """

    def __init__(
        self,
        *,
        drive_store_factory: Callable[[], DriveStoreType | None] | None = None,
        legacy_store: SupabaseLegacyTrainingStore | None = None,
        write_provider: StorageProvider | None = None,
    ) -> None:
        self._drive_store_factory = drive_store_factory
        self._legacy_store = legacy_store or SupabaseLegacyTrainingStore()
        self._write_provider_override = write_provider

    @property
    def write_provider(self) -> StorageProvider:
        if self._write_provider_override is not None:
            return self._write_provider_override
        return flow2_storage_provider_setting()

    def get_drive_store(self) -> DriveStoreType:
        store = self._drive_store_factory() if self._drive_store_factory else None
        if store is None:
            raise DriveNotConnectedError(
                "Google Drive is not connected for Flow 2 training; connect Google Drive in Admin Training settings"
            )
        return store

    def get_legacy_store(self) -> SupabaseLegacyTrainingStore:
        return self._legacy_store

    def store_for_reference(self, reference: str) -> TrainingArtifactStore:
        parsed = parse_artifact_ref(reference)
        if parsed.provider == StorageProvider.GOOGLE_DRIVE:
            return self.get_drive_store()
        return self._legacy_store

    def store_for_write(self, *, provider: StorageProvider | None = None) -> TrainingArtifactStore:
        target = provider or self.write_provider
        if target == StorageProvider.GOOGLE_DRIVE:
            return self.get_drive_store()
        return self._legacy_store

    def put(
        self,
        logical_path: str,
        data: bytes | Path | BinaryIO,
        *,
        content_type: str = "application/octet-stream",
        expected_sha256: str | None = None,
        metadata: dict[str, str] | None = None,
        size_bytes: int | None = None,
        provider: StorageProvider | None = None,
    ) -> StoredArtifact:
        store = self.store_for_write(provider=provider)
        return store.put(
            logical_path,
            data,
            content_type=content_type,
            expected_sha256=expected_sha256,
            metadata=metadata,
            size_bytes=size_bytes,
        )

    def get(
        self,
        reference: str,
        *,
        expected_sha256: str | None = None,
        max_bytes: int | None = None,
    ) -> bytes:
        return self.store_for_reference(reference).get(
            reference,
            expected_sha256=expected_sha256,
            max_bytes=max_bytes,
        )

    def open_stream(
        self,
        reference: str,
        *,
        chunk_size: int = 1024 * 1024,
        expected_sha256: str | None = None,
        preloaded_meta: ArtifactMetadata | None = None,
    ) -> Iterator[bytes]:
        store = self.store_for_reference(reference)
        if isinstance(
            store,
            (GoogleDriveTrainingStore, GoogleAppsScriptDriveStore, GoogleDriveDesktopStore),
        ) and preloaded_meta is not None:
            return store.open_stream(
                reference,
                chunk_size=chunk_size,
                expected_sha256=expected_sha256,
                preloaded_meta=preloaded_meta,
            )
        return store.open_stream(
            reference,
            chunk_size=chunk_size,
            expected_sha256=expected_sha256,
        )

    def open_stream_with_metadata(
        self,
        reference: str,
        *,
        chunk_size: int = 1024 * 1024,
        expected_sha256: str | None = None,
    ) -> tuple[ArtifactMetadata, Iterator[bytes]]:
        store = self.store_for_reference(reference)
        if isinstance(store, GoogleAppsScriptDriveStore):
            return store.open_stream_with_metadata(
                reference,
                chunk_size=chunk_size,
                expected_sha256=expected_sha256,
            )
        meta = store.get_metadata(reference)
        if meta.trashed:
            raise DriveNotFoundError("Drive artifact is trashed")
        stream = self.open_stream(
            reference,
            chunk_size=chunk_size,
            expected_sha256=expected_sha256,
            preloaded_meta=meta,
        )
        return meta, stream

    def download_to_path(
        self,
        reference: str,
        destination: Path,
        *,
        expected_sha256: str | None = None,
        chunk_size: int = 1024 * 1024,
    ) -> tuple[int, str]:
        return self.store_for_reference(reference).download_to_path(
            reference,
            destination,
            expected_sha256=expected_sha256,
            chunk_size=chunk_size,
        )

    def verify_checksum(self, reference: str, expected_sha256: str) -> bool:
        return self.store_for_reference(reference).verify_checksum(reference, expected_sha256)

    def exists(self, reference: str) -> bool:
        return self.store_for_reference(reference).exists(reference)

    def get_metadata(self, reference: str) -> ArtifactMetadata:
        return self.store_for_reference(reference).get_metadata(reference)

    def delete_if_unreferenced(
        self,
        reference: str,
        *,
        is_referenced_check: Callable[[str], bool],
    ) -> bool:
        return self.store_for_reference(reference).delete_if_unreferenced(
            reference,
            is_referenced_check=is_referenced_check,
        )

    def health_check(self, *, provider: StorageProvider | None = None) -> StorageHealthStatus:
        target = provider or self.write_provider
        if target == StorageProvider.GOOGLE_DRIVE:
            try:
                return self.get_drive_store().health_check()
            except DriveNotConnectedError as exc:
                return StorageHealthStatus(
                    provider=StorageProvider.GOOGLE_DRIVE,
                    healthy=False,
                    status="DISCONNECTED",
                    error_code=exc.code,
                    detail=str(exc),
                )
        return self._legacy_store.health_check()

    def quota_check(
        self,
        incoming_bytes: int = 0,
        *,
        provider: StorageProvider | None = None,
    ) -> StorageQuotaStatus:
        return self.store_for_write(provider=provider).quota_check(incoming_bytes=incoming_bytes)


_runtime_factory_lock = threading.Lock()
_runtime_drive_store_factory: Callable[[], DriveStoreType | None] | None = None


def register_runtime_drive_store_factory(
    factory: Callable[[], DriveStoreType | None] | None,
) -> None:
    """Register or override the process-level Google Drive store factory (also useful in tests)."""
    global _runtime_drive_store_factory
    with _runtime_factory_lock:
        _runtime_drive_store_factory = factory


def get_runtime_artifact_router(
    *,
    write_provider: StorageProvider | None = None,
) -> TrainingArtifactStoreRouter:
    """Build a TrainingArtifactStoreRouter wired to the active DB-backed Drive connection factory."""
    with _runtime_factory_lock:
        factory = _runtime_drive_store_factory
    if factory is None:
        from app.services.viread_drive_connection_service import load_sync_google_drive_store

        factory = load_sync_google_drive_store
    return TrainingArtifactStoreRouter(
        drive_store_factory=factory,
        write_provider=write_provider,
    )
