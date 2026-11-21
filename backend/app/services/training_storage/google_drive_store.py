from __future__ import annotations

from collections.abc import Callable, Iterator
from dataclasses import dataclass
import hashlib
import io
import logging
import os
from pathlib import Path
import random
import re
import threading
import time
from typing import Any, BinaryIO
from urllib.parse import urlsplit
from uuid import uuid4

import requests

from app.services.training_storage.base import (
    ArtifactMetadata,
    DriveAuthError,
    DriveIntegrityError,
    DriveNotFoundError,
    DrivePermissionError,
    DriveQuotaExceededError,
    DriveRateLimitError,
    DriveTransientError,
    StorageHealthStatus,
    StorageQuotaStatus,
    StoredArtifact,
    TrainingArtifactStore,
)
from app.services.training_storage.google_drive_oauth import (
    GOOGLE_DRIVE_REQUIRED_SCOPE,
    refresh_access_token,
)
from app.services.training_storage.references import (
    ALLOWED_DRIVE_CATEGORIES,
    DRIVE_ROOT_DISPLAY_PATH,
    DRIVE_ROOT_SEGMENTS,
    StorageProvider,
    format_gdrive_ref,
    parse_artifact_ref,
    validate_drive_file_id,
    validate_logical_path,
    validate_sha256,
)

logger = logging.getLogger(__name__)

DRIVE_API_BASE = "https://www.googleapis.com/drive/v3"
DRIVE_UPLOAD_BASE = "https://www.googleapis.com/upload/drive/v3"
DRIVE_FOLDER_MIME = "application/vnd.google-apps.folder"
RESUMABLE_CHUNK_GRANULARITY = 256 * 1024  # Google Drive requires multiples of 256 KiB
DEFAULT_UPLOAD_CHUNK_BYTES = 4 * 1024 * 1024  # 4 MiB (16 * 256 KiB)
DEFAULT_DOWNLOAD_CHUNK_BYTES = 1024 * 1024  # 1 MiB (Render Free 512 MiB RAM safe)
DEFAULT_MIN_FREE_BUFFER_BYTES = 512 * 1024 * 1024  # 512 MiB safety buffer
_RANGE_HEADER_RE = re.compile(r"bytes=(\d+)-(\d+)")
_IMMUTABLE_CATEGORIES = frozenset(
    {"verified-samples", "datasets", "locked-tests", "checkpoints", "benchmarks", "audit"}
)
_RATE_LIMIT_REASONS = frozenset(
    {"rateLimitExceeded", "userRateLimitExceeded", "sharingRateLimitExceeded", "backendError"}
)
_QUOTA_REASONS = frozenset({"storageQuotaExceeded", "quotaExceeded"})
_RESUME_JOB_UUID_RE = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$", re.I)
_RESUME_BLOB_NAME_RE = re.compile(r"^[0-9a-f]{64}(?:\.part\d{4})?$")
_RESUME_BEST_RE = re.compile(r"^best-[0-9a-f]{64}\.pth$")
_RESUME_BENCHMARK_RE = re.compile(r"^(pilot|production)-[0-9a-f]{64}(?:-[0-9a-f]{64})?(?:-benchmark)?\.json$")
_RESUME_FIXED_FILES = frozenset(
    {
        "resume-manifest.json",
        "latest.pt",
        "candidate.pth",
        "candidate.json",
        "candidate.manifest.json",
        "locked-test-report.json",
    }
)


def validate_resume_object_path(job_id: str, relative_path: str) -> str:
    """Validate and resolve a safe Drive logical path strictly inside resume/jobs/<job_id>/."""
    clean_job = str(job_id or "").strip().lower()
    if not _RESUME_JOB_UUID_RE.fullmatch(clean_job):
        raise ValueError("Resume job_id must be a canonical UUID")
    rel = (relative_path or "").strip().strip("/")
    if not rel or "\\" in rel or ".." in rel or "\x00" in rel:
        raise ValueError("Invalid resume object path")
    parts = rel.split("/")
    if len(parts) == 1:
        name = parts[0]
        if not (
            name in _RESUME_FIXED_FILES
            or _RESUME_BEST_RE.fullmatch(name)
            or _RESUME_BENCHMARK_RE.fullmatch(name)
        ):
            raise ValueError("Unsupported top-level resume filename")
        return validate_logical_path(f"resume/jobs/{clean_job}/{name}", require_known_category=True)
    if len(parts) == 2 and parts[0] == "blobs" and _RESUME_BLOB_NAME_RE.fullmatch(parts[1]):
        return validate_logical_path(f"resume/jobs/{clean_job}/blobs/{parts[1]}", require_known_category=True)
    raise ValueError("Unsupported resume object path")


def _int_env(name: str, default: int, *, minimum: int = 0) -> int:
    raw = (os.getenv(name) or "").strip()
    if not raw:
        return default
    try:
        parsed = int(raw)
    except ValueError:
        return default
    return max(minimum, parsed)


def _escape_drive_query_literal(value: str) -> str:
    return value.replace("\\", "\\\\").replace("'", "\\'")


def _extract_drive_error_info(response: requests.Response) -> tuple[str | None, str]:
    try:
        payload = response.json()
    except ValueError:
        return None, f"http_{response.status_code}"
    if not isinstance(payload, dict):
        return None, f"http_{response.status_code}"
    err = payload.get("error")
    if isinstance(err, dict):
        errors = err.get("errors")
        reason = None
        if isinstance(errors, list) and errors and isinstance(errors[0], dict):
            reason = str(errors[0].get("reason") or "").strip() or None
        message = str(err.get("message") or "").strip() or f"http_{response.status_code}"
        return reason, message[:200]
    return None, f"http_{response.status_code}"


def _has_public_permission(permissions: Any) -> bool:
    if not isinstance(permissions, list):
        return False
    for perm in permissions:
        if isinstance(perm, dict) and str(perm.get("type") or "").lower() in {"anyone", "domain"}:
            return True
    return False


def _parse_int_or_none(value: Any) -> int | None:
    if value is None or value == "":
        return None
    try:
        return int(value)
    except (TypeError, ValueError):
        return None


@dataclass(frozen=True)
class DriveSelfTestResult:
    ok: bool
    logical_path: str
    drive_file_id: str | None
    sha256: str | None
    size_bytes: int
    deleted_after_test: bool
    is_private: bool
    quota: StorageQuotaStatus | None
    detail: str


class GoogleDriveTrainingStore(TrainingArtifactStore):
    """Zero-cost private Google Drive API v3 artifact store for Flow 2 training."""

    provider = StorageProvider.GOOGLE_DRIVE

    def __init__(
        self,
        *,
        client_id: str,
        client_secret: str,
        refresh_token: str | None = None,
        access_token: str | None = None,
        access_token_expires_at: float = 0.0,
        granted_scope: str = GOOGLE_DRIVE_REQUIRED_SCOPE,
        root_folder_id: str | None = None,
        subfolder_ids: dict[str, str] | None = None,
        session: requests.Session | None = None,
        min_free_buffer_bytes: int | None = None,
        max_training_budget_bytes: int | None = None,
        upload_chunk_bytes: int = DEFAULT_UPLOAD_CHUNK_BYTES,
        max_retries: int = 4,
        base_backoff_seconds: float = 0.4,
        sleep_fn: Callable[[float], None] = time.sleep,
        jitter_fn: Callable[[float, float], float] = random.uniform,
        timeout_seconds: float = 30.0,
        on_token_revoked: Callable[[str], None] | None = None,
        on_folders_updated: Callable[[str, dict[str, str]], None] | None = None,
    ) -> None:
        if upload_chunk_bytes <= 0 or (upload_chunk_bytes % RESUMABLE_CHUNK_GRANULARITY) != 0:
            raise ValueError("upload_chunk_bytes must be a positive multiple of 262144 bytes (256 KiB)")
        self._client_id = client_id
        self._client_secret = client_secret
        self._refresh_token = refresh_token
        self._access_token = access_token
        self._access_token_expires_at = access_token_expires_at
        self._granted_scope = granted_scope
        self._session = session or requests.Session()
        self._min_free_buffer_bytes = (
            min_free_buffer_bytes
            if min_free_buffer_bytes is not None
            else _int_env("VIREAD_GDRIVE_MIN_FREE_BYTES", DEFAULT_MIN_FREE_BUFFER_BYTES, minimum=0)
        )
        env_budget = _int_env("VIREAD_GDRIVE_MAX_TRAINING_BYTES", 0, minimum=0)
        self._max_training_budget_bytes = (
            max_training_budget_bytes
            if max_training_budget_bytes is not None
            else (env_budget if env_budget > 0 else None)
        )
        self._upload_chunk_bytes = upload_chunk_bytes
        self._max_retries = max(0, max_retries)
        self._base_backoff_seconds = max(0.0, base_backoff_seconds)
        self._sleep = sleep_fn
        self._jitter = jitter_fn
        self._timeout = timeout_seconds
        self._on_token_revoked = on_token_revoked
        self._on_folders_updated = on_folders_updated

        self._token_lock = threading.Lock()
        self._folder_lock = threading.Lock()
        self._root_folder_id: str | None = root_folder_id
        self._folder_cache: dict[tuple[str, str], str] = {}
        self._subfolder_ids: dict[str, str] = dict(subfolder_ids or {})
        if self._root_folder_id:
            for name, folder_id in self._subfolder_ids.items():
                if name in ALLOWED_DRIVE_CATEGORIES and folder_id:
                    self._folder_cache[(self._root_folder_id, name)] = folder_id

    @property
    def root_folder_id(self) -> str | None:
        return self._root_folder_id

    @property
    def subfolder_ids(self) -> dict[str, str]:
        return dict(self._subfolder_ids)

    def _get_access_token(self, *, force_refresh: bool = False) -> str:
        with self._token_lock:
            now = time.monotonic()
            if (
                not force_refresh
                and self._access_token
                and now < (self._access_token_expires_at - 60.0)
            ):
                return self._access_token
            if not self._refresh_token:
                if self._access_token and not force_refresh:
                    return self._access_token
                raise DriveAuthError(
                    "Google Drive refresh token is unavailable; admin must reconnect Drive",
                    code="DRIVE_TOKEN_MISSING",
                    token_revoked=True,
                )
            try:
                bundle = refresh_access_token(
                    client_id=self._client_id,
                    client_secret=self._client_secret,
                    refresh_token=self._refresh_token,
                    session=self._session,
                    timeout=self._timeout,
                )
            except DriveAuthError as exc:
                if exc.token_revoked and self._on_token_revoked:
                    try:
                        self._on_token_revoked(exc.code)
                    except Exception:
                        pass
                raise
            self._access_token = bundle.access_token
            self._access_token_expires_at = time.monotonic() + bundle.expires_in
            self._granted_scope = bundle.scope
            return self._access_token

    def _compute_backoff(self, attempt: int, response: requests.Response | None = None) -> float:
        if response is not None:
            retry_after = (response.headers.get("Retry-After") or "").strip()
            if retry_after:
                try:
                    parsed = float(retry_after)
                    if 0 <= parsed <= 60:
                        return parsed
                except ValueError:
                    pass
        base = self._base_backoff_seconds * (2**attempt)
        jitter = self._jitter(0.0, max(0.05, self._base_backoff_seconds)) if self._base_backoff_seconds > 0 else 0.0
        return min(30.0, base + max(0.0, jitter))

    def _raise_for_drive_status(self, response: requests.Response) -> None:
        status_code = response.status_code
        reason, message = _extract_drive_error_info(response)
        if status_code == 401:
            raise DriveAuthError(
                "Google Drive rejected the access token",
                code="DRIVE_UNAUTHORIZED",
                http_status=401,
            )
        if status_code == 403:
            if reason in _QUOTA_REASONS:
                raise DriveQuotaExceededError(
                    "Google Drive reported storage quota exceeded; upload halted without fallback"
                )
            if reason in _RATE_LIMIT_REASONS:
                raise DriveRateLimitError(http_status=403)
            raise DrivePermissionError(
                f"Google Drive denied access ({reason or 'forbidden'})",
                code="DRIVE_PERMISSION_DENIED",
                http_status=403,
            )
        if status_code == 404:
            raise DriveNotFoundError("Google Drive file or folder was not found")
        if status_code == 429:
            raise DriveRateLimitError(http_status=429)
        if status_code >= 500:
            raise DriveTransientError(
                f"Google Drive returned HTTP {status_code}",
                http_status=status_code,
            )
        raise DriveTransientError(
            f"Unexpected Google Drive API status {status_code} ({message})",
            code="DRIVE_API_ERROR",
            http_status=status_code,
        )

    def _request(
        self,
        method: str,
        url: str,
        *,
        params: dict[str, Any] | None = None,
        json_body: dict[str, Any] | None = None,
        data: Any = None,
        headers: dict[str, str] | None = None,
        stream: bool = False,
        accepted_statuses: frozenset[int] = frozenset({200, 201, 204}),
    ) -> requests.Response:
        refreshed_after_401 = False
        attempt = 0
        while True:
            token = self._get_access_token(force_refresh=False)
            req_headers = dict(headers or {})
            req_headers["Authorization"] = f"Bearer {token}"
            try:
                response = self._session.request(
                    method,
                    url,
                    params=params,
                    json=json_body,
                    data=data,
                    headers=req_headers,
                    stream=stream,
                    timeout=self._timeout,
                )
            except requests.RequestException as exc:
                if attempt < self._max_retries:
                    delay = self._compute_backoff(attempt)
                    attempt += 1
                    self._sleep(delay)
                    continue
                raise DriveTransientError("Network error communicating with Google Drive API") from exc

            if response.status_code in accepted_statuses:
                return response

            if response.status_code == 401 and not refreshed_after_401:
                refreshed_after_401 = True
                response.close()
                self._get_access_token(force_refresh=True)
                continue

            reason, _ = _extract_drive_error_info(response)
            retryable_status = (
                response.status_code in {429, 500, 502, 503, 504}
                or (response.status_code == 403 and reason in _RATE_LIMIT_REASONS)
            )
            if retryable_status and attempt < self._max_retries:
                delay = self._compute_backoff(attempt, response)
                response.close()
                attempt += 1
                self._sleep(delay)
                continue

            try:
                self._raise_for_drive_status(response)
            finally:
                response.close()

    def _fetch_about(self) -> dict[str, Any]:
        response = self._request(
            "GET",
            f"{DRIVE_API_BASE}/about",
            params={"fields": "storageQuota,user(emailAddress,displayName)"},
        )
        try:
            payload = response.json()
        except ValueError as exc:
            raise DriveTransientError("Google Drive /about returned invalid JSON") from exc
        if not isinstance(payload, dict):
            raise DriveTransientError("Google Drive /about returned malformed response")
        return payload

    def get_account_info(self) -> dict[str, str | None]:
        about = self._fetch_about()
        user = about.get("user") if isinstance(about.get("user"), dict) else {}
        return {
            "email": str(user.get("emailAddress") or "").strip() or None,
            "display_name": str(user.get("displayName") or "").strip() or None,
        }

    def quota_check(self, incoming_bytes: int = 0) -> StorageQuotaStatus:
        if incoming_bytes < 0:
            raise ValueError("incoming_bytes must be non-negative")
        about = self._fetch_about()
        quota = about.get("storageQuota") if isinstance(about.get("storageQuota"), dict) else {}
        limit_bytes = _parse_int_or_none(quota.get("limit"))
        usage_bytes = _parse_int_or_none(quota.get("usage"))
        usage_in_drive = _parse_int_or_none(quota.get("usageInDrive"))
        usage_in_trash = _parse_int_or_none(quota.get("usageInDriveTrash"))

        available_bytes: int | None = None
        can_accept = True
        warning_level = "OK"
        detail: str | None = None

        if limit_bytes is not None and usage_bytes is not None:
            available_bytes = max(0, limit_bytes - usage_bytes)
            effective_headroom = available_bytes - self._min_free_buffer_bytes
            if incoming_bytes > effective_headroom or available_bytes <= self._min_free_buffer_bytes:
                can_accept = False
                warning_level = "EXCEEDED"
                detail = (
                    f"Available Drive space ({available_bytes} B) minus safety buffer "
                    f"({self._min_free_buffer_bytes} B) cannot fit {incoming_bytes} B"
                )
            else:
                ratio = (usage_bytes + incoming_bytes) / max(1, limit_bytes)
                if ratio >= 0.90 or available_bytes <= (self._min_free_buffer_bytes * 2):
                    warning_level = "CRITICAL"
                    detail = "Google Drive free storage usage is above 90%"
                elif ratio >= 0.75:
                    warning_level = "WARNING"
                    detail = "Google Drive free storage usage is above 75%"
        elif limit_bytes is None:
            warning_level = "UNKNOWN"
            detail = "Google Drive did not report a fixed quota limit"

        if (
            self._max_training_budget_bytes is not None
            and usage_in_drive is not None
            and (usage_in_drive + incoming_bytes) > self._max_training_budget_bytes
        ):
            can_accept = False
            warning_level = "EXCEEDED"
            detail = (
                f"Configured Flow 2 Drive budget ({self._max_training_budget_bytes} B) would be exceeded"
            )

        return StorageQuotaStatus(
            provider=StorageProvider.GOOGLE_DRIVE,
            limit_bytes=limit_bytes,
            usage_bytes=usage_bytes,
            usage_in_drive_bytes=usage_in_drive,
            usage_in_trash_bytes=usage_in_trash,
            available_bytes=available_bytes,
            min_free_buffer_bytes=self._min_free_buffer_bytes,
            max_training_budget_bytes=self._max_training_budget_bytes,
            warning_level=warning_level,
            can_accept_upload=can_accept,
            detail=detail,
        )

    def _find_child_folder(self, parent_id: str, name: str) -> str | None:
        escaped_name = _escape_drive_query_literal(name)
        escaped_parent = _escape_drive_query_literal(parent_id)
        query = (
            f"name = '{escaped_name}' and '{escaped_parent}' in parents "
            f"and mimeType = '{DRIVE_FOLDER_MIME}' and trashed = false"
        )
        response = self._request(
            "GET",
            f"{DRIVE_API_BASE}/files",
            params={
                "q": query,
                "spaces": "drive",
                "pageSize": 5,
                "fields": "files(id,name,trashed)",
            },
        )
        payload = response.json()
        files = payload.get("files") if isinstance(payload, dict) else []
        if isinstance(files, list):
            for item in files:
                if isinstance(item, dict) and not item.get("trashed") and item.get("id"):
                    return validate_drive_file_id(str(item["id"]))
        return None

    def _create_child_folder(self, parent_id: str, name: str) -> str:
        body: dict[str, Any] = {
            "name": name,
            "mimeType": DRIVE_FOLDER_MIME,
            "parents": [parent_id],
            "appProperties": {"viread_managed": "true", "viread_flow": "flow2_admin_verified"},
        }
        response = self._request(
            "POST",
            f"{DRIVE_API_BASE}/files",
            params={"fields": "id,name,mimeType,trashed"},
            json_body=body,
        )
        payload = response.json()
        folder_id = validate_drive_file_id(str(payload.get("id") or ""))
        return folder_id

    def _ensure_folder(self, parent_id: str, name: str) -> str:
        cache_key = (parent_id, name)
        with self._folder_lock:
            cached = self._folder_cache.get(cache_key)
        if cached:
            return cached
        found = self._find_child_folder(parent_id, name)
        folder_id = found or self._create_child_folder(parent_id, name)
        with self._folder_lock:
            self._folder_cache[cache_key] = folder_id
        return folder_id

    def _verify_folder_exists(self, folder_id: str) -> bool:
        try:
            meta = self._fetch_file_metadata_raw(folder_id)
        except DriveNotFoundError:
            return False
        if _has_public_permission(meta.get("permissions")):
            raise DrivePermissionError(
                "Dedicated Flow 2 Google Drive folder has public permissions; remove public sharing immediately",
                code="DRIVE_PUBLIC_PERMISSION_DETECTED",
            )
        return (
            not bool(meta.get("trashed"))
            and str(meta.get("mimeType") or "") == DRIVE_FOLDER_MIME
        )

    def ensure_directory_tree(self) -> tuple[str, dict[str, str]]:
        """Ensure MyDrive/ViRead/OCR-Training/Flow2-Admin-Verified and all standard subfolders exist."""
        root_id = self._root_folder_id
        if root_id and not self._verify_folder_exists(root_id):
            root_id = None
            with self._folder_lock:
                self._root_folder_id = None
                self._folder_cache.clear()
                self._subfolder_ids.clear()

        if not root_id:
            parent_id = "root"
            for segment in DRIVE_ROOT_SEGMENTS:
                parent_id = self._ensure_folder(parent_id, segment)
            root_id = parent_id
            with self._folder_lock:
                self._root_folder_id = root_id

        subfolders: dict[str, str] = {}
        for category in sorted(ALLOWED_DRIVE_CATEGORIES):
            existing = self._subfolder_ids.get(category)
            if existing and self._verify_folder_exists(existing):
                subfolders[category] = existing
                with self._folder_lock:
                    self._folder_cache[(root_id, category)] = existing
            else:
                subfolders[category] = self._ensure_folder(root_id, category)

        with self._folder_lock:
            self._subfolder_ids = dict(subfolders)
        if self._on_folders_updated:
            try:
                self._on_folders_updated(root_id, dict(subfolders))
            except Exception:
                pass
        return root_id, subfolders

    def _resolve_parent_folder(self, logical_path: str) -> tuple[str, str]:
        clean = validate_logical_path(logical_path, require_known_category=True)
        parts = clean.split("/")
        if len(parts) < 2:
            raise ValueError("Logical path must include a category folder and a file name")
        if not self._root_folder_id:
            self.ensure_directory_tree()
        parent_id = self._root_folder_id
        assert parent_id is not None
        for folder_name in parts[:-1]:
            parent_id = self._ensure_folder(parent_id, folder_name)
        return parent_id, parts[-1]

    def _find_existing_file(self, parent_id: str, filename: str) -> dict[str, Any] | None:
        escaped_name = _escape_drive_query_literal(filename)
        escaped_parent = _escape_drive_query_literal(parent_id)
        query = (
            f"name = '{escaped_name}' and '{escaped_parent}' in parents "
            f"and mimeType != '{DRIVE_FOLDER_MIME}' and trashed = false"
        )
        response = self._request(
            "GET",
            f"{DRIVE_API_BASE}/files",
            params={
                "q": query,
                "spaces": "drive",
                "pageSize": 5,
                "fields": "files(id,name,mimeType,size,sha256Checksum,trashed,appProperties,permissions)",
            },
        )
        payload = response.json()
        files = payload.get("files") if isinstance(payload, dict) else []
        if isinstance(files, list):
            for item in files:
                if isinstance(item, dict) and not item.get("trashed") and item.get("id"):
                    return item
        return None

    def _prepare_stream(
        self,
        data: bytes | Path | BinaryIO,
        *,
        expected_sha256: str | None,
        size_bytes: int | None,
    ) -> tuple[BinaryIO, bool, int, str]:
        """Return (seekable_stream, should_close, total_size, actual_sha256) without buffering huge files."""
        expected = validate_sha256(expected_sha256, required=False)
        if isinstance(data, (bytes, bytearray, memoryview)):
            raw = bytes(data)
            actual_size = len(raw)
            actual_sha = hashlib.sha256(raw).hexdigest()
            stream: BinaryIO = io.BytesIO(raw)
            should_close = True
        elif isinstance(data, Path):
            stream = data.open("rb")
            should_close = True
            digest = hashlib.sha256()
            actual_size = 0
            while True:
                chunk = stream.read(1024 * 1024)
                if not chunk:
                    break
                digest.update(chunk)
                actual_size += len(chunk)
            actual_sha = digest.hexdigest()
            stream.seek(0)
        else:
            stream = data
            should_close = False
            if not stream.seekable():
                raise ValueError("Upload file stream must be seekable for resumable verification")
            start_pos = stream.tell()
            digest = hashlib.sha256()
            actual_size = 0
            while True:
                chunk = stream.read(1024 * 1024)
                if not chunk:
                    break
                digest.update(chunk)
                actual_size += len(chunk)
            actual_sha = digest.hexdigest()
            stream.seek(start_pos)

        if size_bytes is not None and size_bytes != actual_size:
            if should_close:
                stream.close()
            raise DriveIntegrityError(
                f"Upload byte length mismatch: expected {size_bytes}, got {actual_size}"
            )
        if expected and actual_sha != expected:
            if should_close:
                stream.close()
            raise DriveIntegrityError(
                f"Upload SHA-256 mismatch before transfer: expected {expected[:12]}, got {actual_sha[:12]}"
            )
        return stream, should_close, actual_size, actual_sha

    def _initiate_resumable_upload(
        self,
        *,
        parent_id: str,
        filename: str,
        logical_path: str,
        content_type: str,
        total_size: int,
        sha256_hex: str,
        metadata: dict[str, str] | None,
    ) -> str:
        app_props = {
            "viread_managed": "true",
            "viread_flow": "flow2_admin_verified",
            "viread_sha256": sha256_hex,
            "viread_logical_path": logical_path[:118],
        }
        if metadata:
            for key, value in metadata.items():
                clean_key = re.sub(r"[^A-Za-z0-9_.-]", "_", str(key))[:40]
                if clean_key and clean_key not in app_props:
                    app_props[clean_key] = str(value)[:100]
        response = self._request(
            "POST",
            f"{DRIVE_UPLOAD_BASE}/files",
            params={
                "uploadType": "resumable",
                "fields": "id,name,mimeType,size,sha256Checksum,trashed,appProperties,permissions",
            },
            json_body={
                "name": filename,
                "parents": [parent_id],
                "mimeType": content_type,
                "appProperties": app_props,
            },
            headers={
                "X-Upload-Content-Type": content_type,
                "X-Upload-Content-Length": str(total_size),
            },
            accepted_statuses=frozenset({200}),
        )
        session_uri = (response.headers.get("Location") or "").strip()
        response.close()
        if not session_uri:
            raise DriveTransientError("Google Drive resumable upload initiation did not return a Location URI")
        parsed_uri = urlsplit(session_uri)
        host = (parsed_uri.hostname or "").lower()
        if parsed_uri.scheme != "https" or not (host == "googleapis.com" or host.endswith(".googleapis.com")):
            raise DrivePermissionError(
                "Google Drive resumable upload returned an untrusted upload URI host",
                code="DRIVE_UNTRUSTED_UPLOAD_URI",
                http_status=502,
            )
        return session_uri

    def _query_resumable_offset(self, session_uri: str, total_size: int) -> tuple[int, dict[str, Any] | None]:
        """Ask Google Drive how many bytes of a resumable upload were already committed."""
        response = self._request(
            "PUT",
            session_uri,
            data=b"",
            headers={
                "Content-Length": "0",
                "Content-Range": f"bytes */{total_size}",
            },
            accepted_statuses=frozenset({200, 201, 308}),
        )
        try:
            if response.status_code in {200, 201}:
                return total_size, response.json()
            range_header = (response.headers.get("Range") or "").strip()
            match = _RANGE_HEADER_RE.search(range_header)
            if not match:
                return 0, None
            return int(match.group(2)) + 1, None
        finally:
            response.close()

    def _upload_resumable_chunks(
        self,
        *,
        session_uri: str,
        stream: BinaryIO,
        base_pos: int,
        total_size: int,
        content_type: str,
    ) -> dict[str, Any]:
        if total_size == 0:
            response = self._request(
                "PUT",
                session_uri,
                data=b"",
                headers={"Content-Type": content_type, "Content-Length": "0"},
                accepted_statuses=frozenset({200, 201}),
            )
            try:
                return response.json()
            finally:
                response.close()

        offset = 0
        interruption_retries = 0
        refreshed_after_401 = False
        while offset < total_size:
            stream.seek(base_pos + offset)
            chunk = stream.read(self._upload_chunk_bytes)
            if not chunk:
                raise DriveIntegrityError("Local upload stream ended unexpectedly before total_size")
            end_byte = offset + len(chunk) - 1
            headers = {
                "Content-Type": content_type,
                "Content-Length": str(len(chunk)),
                "Content-Range": f"bytes {offset}-{end_byte}/{total_size}",
            }
            try:
                response = self._session.put(
                    session_uri,
                    data=chunk,
                    headers={**headers, "Authorization": f"Bearer {self._get_access_token()}"},
                    timeout=self._timeout,
                )
            except requests.RequestException as exc:
                if interruption_retries >= self._max_retries:
                    raise DriveTransientError("Resumable upload interrupted repeatedly by network error") from exc
                self._sleep(self._compute_backoff(interruption_retries))
                interruption_retries += 1
                committed, final_payload = self._query_resumable_offset(session_uri, total_size)
                if final_payload is not None:
                    return final_payload
                offset = committed
                continue

            status_code = response.status_code
            if status_code in {200, 201}:
                try:
                    return response.json()
                finally:
                    response.close()

            if status_code == 308:
                range_header = (response.headers.get("Range") or "").strip()
                response.close()
                match = _RANGE_HEADER_RE.search(range_header)
                if match:
                    offset = int(match.group(2)) + 1
                else:
                    offset = end_byte + 1
                interruption_retries = 0
                refreshed_after_401 = False
                continue

            if status_code == 401 and not refreshed_after_401:
                refreshed_after_401 = True
                response.close()
                self._get_access_token(force_refresh=True)
                committed, final_payload = self._query_resumable_offset(session_uri, total_size)
                if final_payload is not None:
                    return final_payload
                offset = committed
                continue

            reason, _ = _extract_drive_error_info(response)
            retryable = status_code in {429, 500, 502, 503, 504} or (
                status_code == 403 and reason in _RATE_LIMIT_REASONS
            )
            if retryable and interruption_retries < self._max_retries:
                delay = self._compute_backoff(interruption_retries, response)
                response.close()
                self._sleep(delay)
                interruption_retries += 1
                committed, final_payload = self._query_resumable_offset(session_uri, total_size)
                if final_payload is not None:
                    return final_payload
                offset = committed
                continue

            try:
                self._raise_for_drive_status(response)
            finally:
                response.close()

        raise DriveTransientError("Resumable upload loop terminated without Google Drive completion response")

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
        clean_path = validate_logical_path(logical_path, require_known_category=True)
        category = clean_path.split("/")[0]
        stream, should_close, total_size, actual_sha = self._prepare_stream(
            data, expected_sha256=expected_sha256, size_bytes=size_bytes
        )
        base_pos = stream.tell()
        try:
            parent_id, filename = self._resolve_parent_folder(clean_path)

            # Idempotency check before consuming upload quota.
            existing = self._find_existing_file(parent_id, filename)
            if existing is not None:
                existing_id = validate_drive_file_id(str(existing["id"]))
                existing_props = existing.get("appProperties") if isinstance(existing.get("appProperties"), dict) else {}
                existing_sha = (
                    str(existing.get("sha256Checksum") or "").strip().lower()
                    or str(existing_props.get("viread_sha256") or "").strip().lower()
                )
                existing_size = _parse_int_or_none(existing.get("size"))
                if existing_sha == actual_sha and (existing_size is None or existing_size == total_size):
                    if _has_public_permission(existing.get("permissions")):
                        raise DrivePermissionError(
                            "Existing Drive training artifact has public permissions; refusing reuse",
                            code="DRIVE_PUBLIC_PERMISSION_DETECTED",
                        )
                    return StoredArtifact(
                        provider=StorageProvider.GOOGLE_DRIVE,
                        reference=format_gdrive_ref(existing_id),
                        logical_path=clean_path,
                        sha256=actual_sha,
                        size_bytes=total_size,
                        content_type=str(existing.get("mimeType") or content_type),
                        drive_file_id=existing_id,
                        deduplicated=True,
                        metadata=dict(existing_props),
                    )
                if category in _IMMUTABLE_CATEGORIES:
                    raise DriveIntegrityError(
                        f"Immutable Flow 2 artifact already exists at '{clean_path}' with different SHA-256",
                        code="IMMUTABLE_ARTIFACT_CONFLICT",
                    )

            # Enforce zero-cost Google Drive quota guard BEFORE uploading.
            quota = self.quota_check(incoming_bytes=total_size)
            if not quota.can_accept_upload:
                raise DriveQuotaExceededError(
                    quota.detail or "Google Drive free quota would be exceeded; upload blocked",
                    required_bytes=total_size,
                    available_bytes=quota.available_bytes,
                    limit_bytes=quota.limit_bytes,
                    usage_bytes=quota.usage_bytes,
                )

            session_uri = self._initiate_resumable_upload(
                parent_id=parent_id,
                filename=filename,
                logical_path=clean_path,
                content_type=content_type,
                total_size=total_size,
                sha256_hex=actual_sha,
                metadata=metadata,
            )
            uploaded = self._upload_resumable_chunks(
                session_uri=session_uri,
                stream=stream,
                base_pos=base_pos,
                total_size=total_size,
                content_type=content_type,
            )
        finally:
            if should_close:
                stream.close()

        file_id = validate_drive_file_id(str(uploaded.get("id") or ""))
        remote_size = _parse_int_or_none(uploaded.get("size"))
        remote_sha = str(uploaded.get("sha256Checksum") or "").strip().lower() or None
        if remote_size is not None and remote_size != total_size:
            raise DriveIntegrityError(
                f"Google Drive stored byte size mismatch: expected {total_size}, got {remote_size}"
            )
        if remote_sha is not None and remote_sha != actual_sha:
            raise DriveIntegrityError(
                f"Google Drive stored SHA-256 mismatch: expected {actual_sha[:12]}, got {remote_sha[:12]}"
            )
        if _has_public_permission(uploaded.get("permissions")):
            try:
                del_resp = self._request(
                    "DELETE",
                    f"{DRIVE_API_BASE}/files/{file_id}",
                    accepted_statuses=frozenset({200, 204}),
                )
                del_resp.close()
            except Exception:
                pass
            raise DrivePermissionError(
                "Uploaded Drive artifact unexpectedly has public permissions and was removed",
                code="DRIVE_PUBLIC_PERMISSION_DETECTED",
            )
        return StoredArtifact(
            provider=StorageProvider.GOOGLE_DRIVE,
            reference=format_gdrive_ref(file_id),
            logical_path=clean_path,
            sha256=actual_sha,
            size_bytes=total_size,
            content_type=str(uploaded.get("mimeType") or content_type),
            drive_file_id=file_id,
            deduplicated=False,
            metadata=dict(uploaded.get("appProperties") or {}),
        )

    def _fetch_file_metadata_raw(self, file_id: str) -> dict[str, Any]:
        validated = validate_drive_file_id(file_id)
        response = self._request(
            "GET",
            f"{DRIVE_API_BASE}/files/{validated}",
            params={
                "fields": "id,name,mimeType,size,sha256Checksum,trashed,appProperties,permissions",
            },
        )
        try:
            payload = response.json()
        except ValueError as exc:
            raise DriveTransientError("Google Drive metadata endpoint returned invalid JSON") from exc
        if not isinstance(payload, dict) or not payload.get("id"):
            raise DriveNotFoundError("Google Drive file metadata was empty")
        return payload

    def get_metadata(self, reference: str) -> ArtifactMetadata:
        parsed = parse_artifact_ref(reference)
        if parsed.provider != StorageProvider.GOOGLE_DRIVE or not parsed.drive_file_id:
            raise ValueError("GoogleDriveTrainingStore only accepts gdrive:// references")
        raw = self._fetch_file_metadata_raw(parsed.drive_file_id)
        props = raw.get("appProperties") if isinstance(raw.get("appProperties"), dict) else {}
        remote_sha = str(raw.get("sha256Checksum") or "").strip().lower() or None
        if not remote_sha:
            prop_sha = str(props.get("viread_sha256") or "").strip().lower()
            remote_sha = prop_sha if len(prop_sha) == 64 else None
        return ArtifactMetadata(
            provider=StorageProvider.GOOGLE_DRIVE,
            reference=parsed.raw,
            name=str(raw.get("name") or "") or None,
            size_bytes=_parse_int_or_none(raw.get("size")),
            sha256=remote_sha,
            content_type=str(raw.get("mimeType") or "") or None,
            trashed=bool(raw.get("trashed")),
            is_public=_has_public_permission(raw.get("permissions")),
            drive_file_id=parsed.drive_file_id,
            logical_path=str(props.get("viread_logical_path") or "") or None,
            extra=dict(props),
        )

    def exists(self, reference: str) -> bool:
        try:
            meta = self.get_metadata(reference)
            return not meta.trashed
        except DriveNotFoundError:
            return False

    def open_stream(
        self,
        reference: str,
        *,
        chunk_size: int = DEFAULT_DOWNLOAD_CHUNK_BYTES,
        expected_sha256: str | None = None,
        preloaded_meta: ArtifactMetadata | None = None,
    ) -> Iterator[bytes]:
        parsed = parse_artifact_ref(reference)
        if parsed.provider != StorageProvider.GOOGLE_DRIVE or not parsed.drive_file_id:
            raise ValueError("GoogleDriveTrainingStore only accepts gdrive:// references")
        expected = validate_sha256(expected_sha256, required=False)
        meta = preloaded_meta if preloaded_meta is not None else self.get_metadata(parsed.raw)
        if meta.trashed:
            raise DriveNotFoundError("Google Drive artifact was trashed outside the system")
        if expected and meta.sha256 and meta.sha256.lower() != expected:
            raise DriveIntegrityError(
                f"Google Drive artifact checksum changed externally: expected {expected[:12]}, "
                f"got {meta.sha256[:12]}"
            )

        file_id = parsed.drive_file_id
        expected_size = meta.size_bytes
        digest = hashlib.sha256()
        downloaded = 0
        range_retries = 0
        safe_chunk_size = max(16 * 1024, min(chunk_size, 4 * 1024 * 1024))

        while True:
            headers = {"Range": f"bytes={downloaded}-"} if downloaded > 0 else None
            accepted = frozenset({200, 206}) if downloaded > 0 else frozenset({200})
            response = self._request(
                "GET",
                f"{DRIVE_API_BASE}/files/{file_id}",
                params={"alt": "media"},
                headers=headers,
                stream=True,
                accepted_statuses=accepted,
            )
            try:
                if downloaded > 0 and response.status_code == 200:
                    # Server ignored Range header; fail fast rather than corrupting stream.
                    raise DriveTransientError("Google Drive ignored HTTP Range header during download resume")
                for piece in response.iter_content(chunk_size=safe_chunk_size):
                    if not piece:
                        continue
                    digest.update(piece)
                    downloaded += len(piece)
                    yield piece
                break
            except requests.RequestException as exc:
                if range_retries >= self._max_retries:
                    raise DriveTransientError("Google Drive download stream interrupted repeatedly") from exc
                self._sleep(self._compute_backoff(range_retries))
                range_retries += 1
                continue
            finally:
                response.close()

        if expected_size is not None and downloaded != expected_size:
            raise DriveIntegrityError(
                f"Google Drive download truncated: expected {expected_size} bytes, got {downloaded}"
            )
        actual_sha = digest.hexdigest()
        if expected and actual_sha != expected:
            raise DriveIntegrityError(
                f"Google Drive downloaded payload SHA-256 mismatch: expected {expected[:12]}, got {actual_sha[:12]}"
            )
        if meta.sha256 and actual_sha != meta.sha256.lower():
            raise DriveIntegrityError("Google Drive downloaded payload did not match Drive metadata checksum")

    def get(
        self,
        reference: str,
        *,
        expected_sha256: str | None = None,
        max_bytes: int | None = None,
    ) -> bytes:
        buf = bytearray()
        for chunk in self.open_stream(reference, expected_sha256=expected_sha256):
            if max_bytes is not None and (len(buf) + len(chunk)) > max_bytes:
                raise DriveIntegrityError(
                    f"Artifact exceeds max_bytes limit ({max_bytes} bytes); use open_stream() instead"
                )
            buf.extend(chunk)
        return bytes(buf)

    def delete_if_unreferenced(
        self,
        reference: str,
        *,
        is_referenced_check: Callable[[str], bool],
    ) -> bool:
        parsed = parse_artifact_ref(reference)
        if parsed.provider != StorageProvider.GOOGLE_DRIVE or not parsed.drive_file_id:
            raise ValueError("GoogleDriveTrainingStore only accepts gdrive:// references")
        if is_referenced_check(parsed.raw):
            return False
        try:
            response = self._request(
                "DELETE",
                f"{DRIVE_API_BASE}/files/{parsed.drive_file_id}",
                accepted_statuses=frozenset({200, 204}),
            )
            response.close()
            return True
        except DriveNotFoundError:
            return False

    def health_check(self) -> StorageHealthStatus:
        try:
            about = self._fetch_about()
            user = about.get("user") if isinstance(about.get("user"), dict) else {}
            account_email = str(user.get("emailAddress") or "").strip() or None
            root_id, _ = self.ensure_directory_tree()
            quota = self.quota_check(incoming_bytes=0)
            return StorageHealthStatus(
                provider=StorageProvider.GOOGLE_DRIVE,
                healthy=True,
                status="CONNECTED",
                account_email=account_email,
                scope=self._granted_scope,
                root_folder_id=root_id,
                root_folder_path=DRIVE_ROOT_DISPLAY_PATH,
                quota=quota,
                detail="Google Drive connected and Flow 2 folder tree verified",
            )
        except DriveAuthError as exc:
            return StorageHealthStatus(
                provider=StorageProvider.GOOGLE_DRIVE,
                healthy=False,
                status="TOKEN_REVOKED" if exc.token_revoked else "ERROR",
                scope=self._granted_scope,
                root_folder_id=self._root_folder_id,
                root_folder_path=DRIVE_ROOT_DISPLAY_PATH,
                error_code=exc.code,
                detail=str(exc),
            )
        except Exception as exc:
            code = getattr(exc, "code", "DRIVE_HEALTH_CHECK_FAILED")
            safe_detail = str(exc) if hasattr(exc, "code") else f"Health check failed ({type(exc).__name__})"
            return StorageHealthStatus(
                provider=StorageProvider.GOOGLE_DRIVE,
                healthy=False,
                status="ERROR",
                scope=self._granted_scope,
                root_folder_id=self._root_folder_id,
                root_folder_path=DRIVE_ROOT_DISPLAY_PATH,
                error_code=str(code),
                detail=safe_detail,
            )

    def self_test(self) -> DriveSelfTestResult:
        """Upload, verify metadata & checksum, stream-download, and delete an isolated test object."""
        payload = f"viread-flow2-drive-selftest-{uuid4().hex}".encode("utf-8")
        expected_sha = hashlib.sha256(payload).hexdigest()
        logical_path = f"_selftest/selftest-{uuid4().hex}.txt"
        stored = self.put(
            logical_path,
            payload,
            content_type="text/plain; charset=utf-8",
            expected_sha256=expected_sha,
            metadata={"purpose": "selftest"},
        )
        meta = self.get_metadata(stored.reference)
        if meta.is_public:
            raise DrivePermissionError(
                "Self-test artifact was unexpectedly marked public on Google Drive",
                code="DRIVE_PUBLIC_PERMISSION_DETECTED",
            )
        downloaded = self.get(stored.reference, expected_sha256=expected_sha, max_bytes=4096)
        if downloaded != payload:
            raise DriveIntegrityError("Self-test downloaded bytes did not match uploaded payload")
        deleted = self.delete_if_unreferenced(stored.reference, is_referenced_check=lambda _ref: False)
        quota = self.quota_check(incoming_bytes=0)
        return DriveSelfTestResult(
            ok=deleted and not self.exists(stored.reference),
            logical_path=logical_path,
            drive_file_id=stored.drive_file_id,
            sha256=expected_sha,
            size_bytes=len(payload),
            deleted_after_test=deleted,
            is_private=not meta.is_public,
            quota=quota,
            detail="Upload, SHA-256 verification, private permission check, read-back, and cleanup succeeded",
        )

    def _list_folder_files(self, parent_id: str) -> list[dict[str, Any]]:
        escaped_parent = _escape_drive_query_literal(parent_id)
        query = (
            f"'{escaped_parent}' in parents "
            f"and mimeType != '{DRIVE_FOLDER_MIME}' "
            f"and trashed = false"
        )
        items: list[dict[str, Any]] = []
        page_token: str | None = None
        while True:
            params: dict[str, Any] = {
                "q": query,
                "spaces": "drive",
                "fields": "nextPageToken,files(id,name,mimeType,size,sha256Checksum,appProperties,permissions,modifiedTime)",
                "orderBy": "modifiedTime desc",
                "pageSize": 100,
            }
            if page_token:
                params["pageToken"] = page_token
            response = self._request("GET", f"{DRIVE_API_BASE}/files", params=params)
            try:
                payload = response.json()
            finally:
                response.close()
            for entry in payload.get("files") or []:
                if isinstance(entry, dict) and entry.get("id") and entry.get("name"):
                    items.append(entry)
            page_token = payload.get("nextPageToken")
            if not page_token:
                break
        return items

    def list_resume_files(self, job_id: str) -> list[dict[str, Any]]:
        """List non-trashed resume files under resume/jobs/<job_id>/ and blobs/ in Drive."""
        clean_job = str(job_id or "").strip().lower()
        if not _RESUME_JOB_UUID_RE.fullmatch(clean_job):
            raise ValueError("Resume job_id must be a canonical UUID")
        _, subfolders = self.ensure_directory_tree()
        resume_id = subfolders["resume"]
        jobs_id = self._find_child_folder(resume_id, "jobs")
        if not jobs_id:
            return []
        job_folder_id = self._find_child_folder(jobs_id, clean_job)
        if not job_folder_id:
            return []

        results: list[dict[str, Any]] = []
        seen_names: set[str] = set()
        for prefix, folder_id in (("", job_folder_id), ("blobs/", self._find_child_folder(job_folder_id, "blobs"))):
            if not folder_id:
                continue
            for entry in self._list_folder_files(folder_id):
                rel_name = f"{prefix}{entry['name']}"
                if rel_name in seen_names:
                    continue
                seen_names.add(rel_name)
                if _has_public_permission(entry.get("permissions")):
                    raise DrivePermissionError(
                        "Resume Drive object has public permissions; refusing read",
                        code="DRIVE_PUBLIC_PERMISSION_DETECTED",
                    )
                props = entry.get("appProperties") if isinstance(entry.get("appProperties"), dict) else {}
                sha = (
                    str(entry.get("sha256Checksum") or "").strip().lower()
                    or str(props.get("viread_sha256") or "").strip().lower()
                    or None
                )
                results.append(
                    {
                        "name": rel_name,
                        "drive_file_id": validate_drive_file_id(str(entry["id"])),
                        "size_bytes": _parse_int_or_none(entry.get("size")) or 0,
                        "sha256": sha,
                    }
                )
        return results

    def put_resume_file(
        self,
        job_id: str,
        relative_path: str,
        data: bytes | Path | BinaryIO,
        *,
        content_type: str = "application/octet-stream",
        expected_sha256: str | None = None,
    ) -> StoredArtifact:
        """Store or atomically replace a resume file strictly inside resume/jobs/<job_id>/."""
        logical_path = validate_resume_object_path(job_id, relative_path)
        parent_id, filename = self._resolve_parent_folder(logical_path)
        prior_ids = [
            validate_drive_file_id(str(entry["id"]))
            for entry in self._list_folder_files(parent_id)
            if str(entry.get("name") or "") == filename
        ]
        stored = self.put(
            logical_path,
            data,
            content_type=content_type,
            expected_sha256=expected_sha256,
            metadata={"purpose": "colab_resume", "job_id": str(job_id).strip().lower()},
        )
        # Manifest-last atomic cleanup: delete superseded copies only AFTER new upload succeeded.
        for old_id in prior_ids:
            if old_id != stored.drive_file_id:
                try:
                    del_resp = self._request(
                        "DELETE",
                        f"{DRIVE_API_BASE}/files/{old_id}",
                        accepted_statuses=frozenset({200, 204}),
                    )
                    del_resp.close()
                except Exception:
                    pass
        return stored

    def open_resume_file_stream(
        self,
        job_id: str,
        relative_path: str,
        *,
        expected_sha256: str | None = None,
    ) -> tuple[ArtifactMetadata, Iterator[bytes]]:
        """Stream a verified resume file from resume/jobs/<job_id>/ in the connected Drive."""
        logical_path = validate_resume_object_path(job_id, relative_path)
        parent_id, filename = self._resolve_parent_folder(logical_path)
        matches = [
            entry
            for entry in self._list_folder_files(parent_id)
            if str(entry.get("name") or "") == filename
        ]
        if not matches:
            raise DriveNotFoundError(f"Resume file not found on Drive: {relative_path}")
        file_id = validate_drive_file_id(str(matches[0]["id"]))
        ref = format_gdrive_ref(file_id)
        meta = self.get_metadata(ref)
        return meta, self.open_stream(ref, expected_sha256=expected_sha256)

    def delete_resume_file(self, job_id: str, relative_path: str) -> bool:
        """Delete obsolete resume file(s) strictly inside resume/jobs/<job_id>/."""
        logical_path = validate_resume_object_path(job_id, relative_path)
        parent_id, filename = self._resolve_parent_folder(logical_path)
        matches = [
            validate_drive_file_id(str(entry["id"]))
            for entry in self._list_folder_files(parent_id)
            if str(entry.get("name") or "") == filename
        ]
        deleted_any = False
        for file_id in matches:
            try:
                del_resp = self._request(
                    "DELETE",
                    f"{DRIVE_API_BASE}/files/{file_id}",
                    accepted_statuses=frozenset({200, 204}),
                )
                del_resp.close()
                deleted_any = True
            except DriveNotFoundError:
                continue
        return deleted_any
