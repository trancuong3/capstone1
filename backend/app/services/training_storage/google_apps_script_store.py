from __future__ import annotations

import base64
from collections import OrderedDict
from collections.abc import Callable, Iterator
from dataclasses import replace
import hashlib
import hmac
import io
import json
import logging
import os
from pathlib import Path
import random
import re
import tarfile
import threading
import time
from typing import Any, BinaryIO
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
    TrainingStorageError,
)
from app.services.training_storage.google_drive_store import (
    DEFAULT_MIN_FREE_BUFFER_BYTES,
    DriveSelfTestResult,
    validate_resume_object_path,
)
from app.services.training_storage.references import (
    DRIVE_ROOT_DISPLAY_PATH,
    SHA256_HEX_RE,
    StorageProvider,
    build_vpack_storage_ref,
    format_gdrive_ref,
    parse_artifact_ref,
    parse_vpack_ref,
    validate_drive_file_id,
    validate_logical_path,
    validate_sha256,
)

logger = logging.getLogger(__name__)

APPS_SCRIPT_BRIDGE_SCOPE = "apps_script_bridge"
APPS_SCRIPT_CHUNKED_MIME = "application/vnd.viread.chunked+json"
DEFAULT_APPS_SCRIPT_CHUNK_BYTES = 8 * 1024 * 1024  # 8 MiB raw (~10.7 MiB base64 JSON, well under 50 MB GAS limit)
_APPS_SCRIPT_URL_RE = re.compile(r"^https://script\.google\.com/macros/s/[A-Za-z0-9_-]{20,240}/exec$")


def validate_apps_script_web_app_url(url: str) -> str:
    candidate = (url or "").strip()
    if not _APPS_SCRIPT_URL_RE.fullmatch(candidate):
        raise TrainingStorageError(
            "Apps Script Web App URL must match https://script.google.com/macros/s/<deployment_id>/exec",
            code="DRIVE_BRIDGE_INVALID_URL",
            http_status=400,
        )
    return candidate


def apps_script_config_readiness() -> dict[str, Any]:
    enc_key = (os.getenv("VIREAD_GDRIVE_TOKEN_ENCRYPTION_KEY") or "").strip()
    server_secret = (os.getenv("VIREAD_GDRIVE_APPS_SCRIPT_SECRET") or "").strip()
    env_url = (os.getenv("VIREAD_GDRIVE_APPS_SCRIPT_URL") or "").strip()
    required_email = (os.getenv("VIREAD_GDRIVE_REQUIRED_ACCOUNT_EMAIL") or "").strip().lower() or None
    return {
        "bridge_ready": len(enc_key) >= 32,
        "encryption_key_configured": len(enc_key) >= 32,
        "server_secret_configured": len(server_secret) >= 32,
        "web_app_url_configured": bool(_APPS_SCRIPT_URL_RE.fullmatch(env_url)) if env_url else False,
        "required_account_email": required_email,
        "script_path": "scripts/google-apps-script/viread_flow2_drive_bridge.gs",
    }


def _int_env(name: str, default: int, *, minimum: int = 0) -> int:
    raw = (os.getenv(name) or "").strip()
    if not raw:
        return default
    try:
        parsed = int(raw)
    except ValueError:
        return default
    return max(minimum, parsed)


def _parse_int_or_none(value: Any) -> int | None:
    if value is None or value == "":
        return None
    try:
        return int(value)
    except (TypeError, ValueError):
        return None


def sign_apps_script_envelope(
    *,
    action: str,
    payload: dict[str, Any],
    bridge_secret: str,
    timestamp: int | None = None,
) -> dict[str, Any]:
    ts = int(time.time()) if timestamp is None else int(timestamp)
    payload_json = json.dumps(payload, separators=(",", ":"), sort_keys=True)
    payload_hash = hashlib.sha256(payload_json.encode("utf-8")).hexdigest()
    signing_input = f"{ts}:{action}:{payload_hash}".encode("utf-8")
    sig = hmac.new(bridge_secret.encode("utf-8"), signing_input, hashlib.sha256).hexdigest()
    return {
        "action": action,
        "ts": ts,
        "sig": sig,
        "payload_json": payload_json,
    }


class GoogleAppsScriptDriveStore(TrainingArtifactStore):
    """Zero-card, zero-GCP-billing private Google Drive store via owner-deployed Apps Script Web App."""

    provider = StorageProvider.GOOGLE_DRIVE

    def __init__(
        self,
        *,
        web_app_url: str,
        bridge_secret: str,
        root_folder_id: str | None = None,
        subfolder_ids: dict[str, str] | None = None,
        session: requests.Session | None = None,
        min_free_buffer_bytes: int | None = None,
        max_training_budget_bytes: int | None = None,
        chunk_bytes: int = DEFAULT_APPS_SCRIPT_CHUNK_BYTES,
        max_retries: int = 3,
        base_backoff_seconds: float = 0.5,
        sleep_fn: Callable[[float], None] = time.sleep,
        jitter_fn: Callable[[float, float], float] = random.uniform,
        timeout_seconds: float = 90.0,
    ) -> None:
        self._web_app_url = validate_apps_script_web_app_url(web_app_url)
        clean_secret = (bridge_secret or "").strip()
        if len(clean_secret) < 32:
            raise DriveAuthError(
                "Apps Script bridge secret must be at least 32 characters",
                code="DRIVE_BRIDGE_SECRET_INVALID",
                http_status=400,
            )
        self._bridge_secret = clean_secret
        self._provided_session = session
        self._session_local = threading.local()
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
        self._chunk_bytes = max(64 * 1024, min(int(chunk_bytes), 20 * 1024 * 1024))
        self._max_retries = max(0, max_retries)
        self._base_backoff_seconds = max(0.0, base_backoff_seconds)
        self._sleep = sleep_fn
        self._jitter = jitter_fn
        self._timeout = timeout_seconds

        self._lock = threading.Lock()
        self._root_folder_id: str | None = root_folder_id
        self._subfolder_ids: dict[str, str] = {str(k): str(v) for k, v in (subfolder_ids or {}).items() if v}
        self._quota_cache_ttl_seconds = 45.0
        self._quota_cache_safe_floor_bytes = 500 * 1024 * 1024
        self._cached_quota: StorageQuotaStatus | None = None
        self._cached_quota_at: float = 0.0
        self._vpack_cache_lock = threading.Lock()
        self._vpack_cache: OrderedDict[str, dict[str, bytes]] = OrderedDict()
        self._vpack_cache_capacity = 4
        self._vpack_inflight_locks: dict[str, threading.Lock] = {}

    def _get_session(self) -> requests.Session:
        if self._provided_session is not None:
            return self._provided_session
        sess = getattr(self._session_local, "session", None)
        if sess is None:
            sess = requests.Session()
            self._session_local.session = sess
        return sess

    @property
    def _session(self) -> requests.Session:
        return self._get_session()

    @_session.setter
    def _session(self, value: requests.Session | None) -> None:
        self._provided_session = value

    @property
    def root_folder_id(self) -> str | None:
        return self._root_folder_id

    @property
    def subfolder_ids(self) -> dict[str, str]:
        with self._lock:
            return dict(self._subfolder_ids)

    def _compute_backoff(self, attempt: int) -> float:
        return (self._base_backoff_seconds * (2**attempt)) + self._jitter(0.0, 0.25)

    def _raise_for_bridge_error(self, error_code: str, message: str) -> None:
        clean_code = (error_code or "DRIVE_BRIDGE_ERROR").strip().upper()
        clean_msg = (message or "Google Apps Script Drive bridge returned an error")[:260]
        if clean_code in {"DRIVE_AUTH_FAILED", "DRIVE_BRIDGE_SECRET_NOT_SET"}:
            raise DriveAuthError(clean_msg, code=clean_code, http_status=401)
        if clean_code in {
            "DRIVE_PERMISSION_DENIED",
            "DRIVE_PUBLIC_PERMISSION_DETECTED",
            "DRIVE_BRIDGE_ACCESS_DENIED",
        }:
            raise DrivePermissionError(clean_msg, code=clean_code, http_status=403)
        if clean_code == "DRIVE_OBJECT_NOT_FOUND":
            raise DriveNotFoundError(clean_msg)
        if clean_code == "ARTIFACT_INTEGRITY_MISMATCH":
            raise DriveIntegrityError(clean_msg)
        if clean_code == "DRIVE_QUOTA_EXCEEDED":
            raise DriveQuotaExceededError(clean_msg)
        if clean_code == "INVALID_PATH":
            raise ValueError(clean_msg)
        raise DriveTransientError(clean_msg, code=clean_code, http_status=502)

    def _call_bridge(self, action: str, payload: dict[str, Any] | None = None) -> dict[str, Any]:
        body_payload = payload or {}
        for attempt in range(self._max_retries + 1):
            envelope = sign_apps_script_envelope(
                action=action,
                payload=body_payload,
                bridge_secret=self._bridge_secret,
            )
            try:
                response = self._session.post(
                    self._web_app_url,
                    json=envelope,
                    headers={"Content-Type": "application/json", "Accept": "application/json"},
                    allow_redirects=True,
                    timeout=self._timeout,
                )
            except requests.RequestException as exc:
                if attempt < self._max_retries:
                    self._sleep(self._compute_backoff(attempt))
                    continue
                raise DriveTransientError("Network error communicating with Google Apps Script Drive bridge") from exc

            status_code = response.status_code
            content_type = (response.headers.get("Content-Type") or "").lower()
            try:
                content_obj = getattr(response, "content", None)
                if isinstance(content_obj, (bytes, bytearray)):
                    raw_bytes = bytes(content_obj)
                else:
                    raw_bytes = str(getattr(response, "text", "") or "").encode("utf-8")
            finally:
                response.close()

            if status_code == 429:
                if attempt < self._max_retries:
                    self._sleep(self._compute_backoff(attempt))
                    continue
                raise DriveRateLimitError("Google Apps Script Drive bridge rate limit reached")

            if status_code in {500, 502, 503, 504}:
                if attempt < self._max_retries:
                    self._sleep(self._compute_backoff(attempt))
                    continue
                raise DriveTransientError(
                    f"Google Apps Script Drive bridge temporary HTTP {status_code}",
                    http_status=status_code,
                )

            if status_code in {401, 403} or "text/html" in content_type or raw_bytes.lstrip().startswith(b"<"):
                lowered = raw_bytes[:8192].decode("utf-8", errors="replace").lower()
                if "accounts.google.com" in lowered or "servicelogin" in lowered or "sign in" in lowered:
                    raise DrivePermissionError(
                        "Apps Script Web App requires Google Sign-In; redeploy with 'Who has access: Anyone'",
                        code="DRIVE_BRIDGE_ACCESS_DENIED",
                        http_status=403,
                    )
                raise DrivePermissionError(
                    f"Apps Script Web App returned non-JSON response (HTTP {status_code}); verify deployment URL and access='Anyone'",
                    code="DRIVE_BRIDGE_ACCESS_DENIED",
                    http_status=403,
                )

            try:
                try:
                    parsed = json.loads(raw_bytes)
                except ValueError as exc:
                    raise DriveTransientError(
                        "Apps Script Drive bridge returned invalid JSON payload",
                        code="DRIVE_BRIDGE_INVALID_RESPONSE",
                        http_status=502,
                    ) from exc

                if not isinstance(parsed, dict):
                    raise DriveTransientError(
                        "Apps Script Drive bridge returned unexpected payload type",
                        code="DRIVE_BRIDGE_INVALID_RESPONSE",
                        http_status=502,
                    )

                if not parsed.get("ok"):
                    self._raise_for_bridge_error(
                        str(parsed.get("error_code") or "DRIVE_BRIDGE_ERROR"),
                        str(parsed.get("message") or "Google Apps Script Drive bridge rejected request"),
                    )
                return parsed
            except DriveTransientError:
                if attempt < self._max_retries:
                    self._sleep(self._compute_backoff(attempt))
                    continue
                raise

        raise DriveTransientError("Google Apps Script Drive bridge request exhausted retries")

    def _quota_from_dict(self, raw_quota: dict[str, Any] | None, *, incoming_bytes: int = 0) -> StorageQuotaStatus:
        q = raw_quota if isinstance(raw_quota, dict) else {}
        limit_bytes = _parse_int_or_none(q.get("limit_bytes"))
        usage_bytes = _parse_int_or_none(q.get("usage_bytes"))
        drive_bytes = _parse_int_or_none(q.get("usage_in_drive_bytes"))
        trash_bytes = _parse_int_or_none(q.get("usage_in_trash_bytes"))
        available_bytes = (
            max(0, limit_bytes - usage_bytes)
            if (limit_bytes is not None and usage_bytes is not None)
            else None
        )
        can_accept = True
        warning_level = "OK"
        detail: str | None = None

        if limit_bytes is not None and available_bytes is not None:
            remaining_after = available_bytes - max(0, int(incoming_bytes))
            if remaining_after < self._min_free_buffer_bytes:
                warning_level = "EXCEEDED"
                can_accept = False
                detail = (
                    f"Upload would leave {max(0, remaining_after)} bytes free, "
                    f"below required safety buffer {self._min_free_buffer_bytes} bytes"
                )
            else:
                ratio = usage_bytes / max(1, limit_bytes)
                if ratio >= 0.90 or remaining_after <= (self._min_free_buffer_bytes * 2):
                    warning_level = "CRITICAL"
                elif ratio >= 0.75:
                    warning_level = "WARNING"
        else:
            warning_level = "UNKNOWN"

        if (
            self._max_training_budget_bytes is not None
            and drive_bytes is not None
            and (drive_bytes + max(0, int(incoming_bytes))) > self._max_training_budget_bytes
        ):
            warning_level = "EXCEEDED"
            can_accept = False
            detail = "Upload would exceed configured VIREAD_GDRIVE_MAX_TRAINING_BYTES budget"

        return StorageQuotaStatus(
            provider=StorageProvider.GOOGLE_DRIVE,
            limit_bytes=limit_bytes,
            usage_bytes=usage_bytes,
            usage_in_drive_bytes=drive_bytes,
            usage_in_trash_bytes=trash_bytes,
            available_bytes=available_bytes,
            min_free_buffer_bytes=self._min_free_buffer_bytes,
            max_training_budget_bytes=self._max_training_budget_bytes,
            warning_level=warning_level,
            can_accept_upload=can_accept,
            detail=detail,
        )

    def _assert_quota_for_upload(self, incoming_bytes: int) -> StorageQuotaStatus:
        upload_bytes = max(0, int(incoming_bytes))
        now = time.monotonic()
        with self._lock:
            cached = self._cached_quota
            if (
                cached is not None
                and (now - self._cached_quota_at) <= self._quota_cache_ttl_seconds
                and cached.can_accept_upload
                and cached.available_bytes is not None
            ):
                safe_floor = max(self._quota_cache_safe_floor_bytes, self._min_free_buffer_bytes * 2)
                remaining_after = cached.available_bytes - upload_bytes
                budget_ok = (
                    self._max_training_budget_bytes is None
                    or cached.usage_in_drive_bytes is None
                    or (cached.usage_in_drive_bytes + upload_bytes) <= self._max_training_budget_bytes
                )
                if remaining_after > safe_floor and budget_ok:
                    updated = replace(
                        cached,
                        available_bytes=remaining_after,
                        usage_bytes=(
                            (cached.usage_bytes + upload_bytes)
                            if cached.usage_bytes is not None
                            else None
                        ),
                        usage_in_drive_bytes=(
                            (cached.usage_in_drive_bytes + upload_bytes)
                            if cached.usage_in_drive_bytes is not None
                            else None
                        ),
                    )
                    self._cached_quota = updated
                    return updated

        quota = self.quota_check(incoming_bytes=upload_bytes)
        if not quota.can_accept_upload:
            with self._lock:
                self._cached_quota = None
                self._cached_quota_at = 0.0
            raise DriveQuotaExceededError(
                quota.detail or "Google Drive free storage quota would be exceeded; upload halted safely",
                required_bytes=upload_bytes + self._min_free_buffer_bytes,
                available_bytes=quota.available_bytes,
                limit_bytes=quota.limit_bytes,
                usage_bytes=quota.usage_bytes,
            )
        with self._lock:
            safe_floor = max(self._quota_cache_safe_floor_bytes, self._min_free_buffer_bytes * 2)
            if quota.available_bytes is not None and (quota.available_bytes - upload_bytes) > safe_floor:
                self._cached_quota = replace(
                    quota,
                    available_bytes=max(0, quota.available_bytes - upload_bytes),
                    usage_bytes=(
                        (quota.usage_bytes + upload_bytes)
                        if quota.usage_bytes is not None
                        else None
                    ),
                    usage_in_drive_bytes=(
                        (quota.usage_in_drive_bytes + upload_bytes)
                        if quota.usage_in_drive_bytes is not None
                        else None
                    ),
                )
                self._cached_quota_at = time.monotonic()
            else:
                self._cached_quota = None
                self._cached_quota_at = 0.0
        return quota

    def _prepare_upload_stream(
        self,
        data: bytes | Path | BinaryIO,
        *,
        expected_sha256: str | None,
        size_bytes: int | None,
    ) -> tuple[BinaryIO, bool, int, str]:
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
                raise ValueError("Upload file stream must be seekable for integrity verification")
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
            raise DriveIntegrityError(f"Upload byte length mismatch: expected {size_bytes}, got {actual_size}")
        if expected and actual_sha != expected:
            if should_close:
                stream.close()
            raise DriveIntegrityError(
                f"Upload SHA-256 mismatch before transfer: expected {expected[:12]}, got {actual_sha[:12]}"
            )
        return stream, should_close, actual_size, actual_sha

    def _metadata_from_file_info(self, info: dict[str, Any]) -> ArtifactMetadata:
        file_id = validate_drive_file_id(str(info["file_id"]))
        extra = dict(info.get("extra") or {})
        extra["is_chunked"] = bool(info.get("is_chunked"))
        return ArtifactMetadata(
            provider=StorageProvider.GOOGLE_DRIVE,
            reference=format_gdrive_ref(file_id),
            name=str(info.get("name") or "") or None,
            size_bytes=_parse_int_or_none(info.get("size_bytes")),
            sha256=str(info.get("sha256") or "").strip().lower() or None,
            content_type=str(info.get("content_type") or "") or None,
            trashed=bool(info.get("trashed")),
            is_public=bool(info.get("is_public")),
            drive_file_id=file_id,
            logical_path=str(info.get("logical_path") or "") or None,
            extra=extra,
        )

    def get_account_info(self) -> dict[str, str | None]:
        res = self._call_bridge("health", {})
        if res.get("root_folder_id"):
            with self._lock:
                self._root_folder_id = validate_drive_file_id(str(res["root_folder_id"]))
                subs = res.get("subfolder_ids")
                if isinstance(subs, dict):
                    self._subfolder_ids = {str(k): str(v) for k, v in subs.items() if v}
        return {
            "email": str(res.get("account_email") or "").strip().lower() or None,
            "display_name": str(res.get("account_display_name") or "").strip() or None,
        }

    def ensure_directory_tree(self) -> tuple[str, dict[str, str]]:
        res = self._call_bridge("health", {})
        root_id = validate_drive_file_id(str(res["root_folder_id"]))
        subs = {str(k): validate_drive_file_id(str(v)) for k, v in (res.get("subfolder_ids") or {}).items()}
        with self._lock:
            self._root_folder_id = root_id
            self._subfolder_ids = dict(subs)
        return root_id, subs

    def quota_check(self, incoming_bytes: int = 0) -> StorageQuotaStatus:
        res = self._call_bridge("quota", {})
        return self._quota_from_dict(res.get("quota"), incoming_bytes=incoming_bytes)

    def health_check(self) -> StorageHealthStatus:
        try:
            res = self._call_bridge("health", {})
            root_id = validate_drive_file_id(str(res["root_folder_id"]))
            subs = {str(k): validate_drive_file_id(str(v)) for k, v in (res.get("subfolder_ids") or {}).items()}
            with self._lock:
                self._root_folder_id = root_id
                self._subfolder_ids = dict(subs)
            quota = self._quota_from_dict(res.get("quota"), incoming_bytes=0)
            email = str(res.get("account_email") or "").strip().lower() or None
            raw_adv = res.get("advanced_drive_enabled")
            advanced_drive_enabled = raw_adv if isinstance(raw_adv, bool) else None
            raw_delete_mode = res.get("delete_mode")
            delete_mode = str(raw_delete_mode).strip() if isinstance(raw_delete_mode, str) and raw_delete_mode.strip() else None
            warnings: list[str] = []
            if advanced_drive_enabled is False or delete_mode == "trash_fallback":
                warnings.append(
                    "Apps Script Advanced Drive Service (Drive API) chưa được bật: các tệp đã xóa sẽ bị chuyển vào Thùng rác Drive và tiếp tục chiếm dung lượng trong 30 ngày. Hãy bật Services (+) -> Drive API trong Apps Script."
                )
            return StorageHealthStatus(
                provider=StorageProvider.GOOGLE_DRIVE,
                healthy=True,
                status="CONNECTED",
                account_email=email,
                scope=APPS_SCRIPT_BRIDGE_SCOPE,
                root_folder_id=root_id,
                root_folder_path=DRIVE_ROOT_DISPLAY_PATH,
                quota=quota,
                detail="Google Drive Apps Script Bridge connected and Flow 2 folder tree verified",
                advanced_drive_enabled=advanced_drive_enabled,
                delete_mode=delete_mode,
                warnings=warnings,
            )
        except TrainingStorageError as exc:
            return StorageHealthStatus(
                provider=StorageProvider.GOOGLE_DRIVE,
                healthy=False,
                status="ERROR",
                scope=APPS_SCRIPT_BRIDGE_SCOPE,
                root_folder_id=self._root_folder_id,
                root_folder_path=DRIVE_ROOT_DISPLAY_PATH,
                error_code=exc.code,
                detail=str(exc),
            )

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
        stream, should_close, actual_size, actual_sha = self._prepare_upload_stream(
            data,
            expected_sha256=expected_sha256,
            size_bytes=size_bytes,
        )
        base_pos = stream.tell()
        try:
            self._assert_quota_for_upload(actual_size)
            if actual_size <= self._chunk_bytes:
                stream.seek(base_pos)
                raw = stream.read(actual_size)
                res = self._call_bridge(
                    "put_file",
                    {
                        "logical_path": clean_path,
                        "content_b64": base64.b64encode(raw).decode("ascii"),
                        "content_type": content_type,
                        "expected_sha256": actual_sha,
                        "metadata": dict(metadata or {}),
                    },
                )
                file_info = res["file"]
                file_id = validate_drive_file_id(str(file_info["file_id"]))
                if str(file_info.get("sha256") or "").lower() != actual_sha:
                    raise DriveIntegrityError("Drive bridge returned mismatched SHA-256 after upload")
                return StoredArtifact(
                    provider=StorageProvider.GOOGLE_DRIVE,
                    reference=format_gdrive_ref(file_id),
                    logical_path=clean_path,
                    sha256=actual_sha,
                    size_bytes=actual_size,
                    content_type=content_type,
                    drive_file_id=file_id,
                    deduplicated=bool(res.get("deduplicated")),
                    metadata=dict(metadata or {}),
                )

            # Large file (> chunk_bytes): upload verified <= 8 MiB parts, then commit manifest at logical_path.
            parts_parent = clean_path.rsplit("/", 1)[0]
            upload_token = uuid4().hex[:12]
            uploaded_parts: list[dict[str, Any]] = []
            part_index = 0
            offset = 0
            try:
                stream.seek(base_pos)
                while offset < actual_size:
                    chunk = stream.read(self._chunk_bytes)
                    if not chunk:
                        raise DriveIntegrityError("Upload stream ended prematurely during chunked transfer")
                    part_sha = hashlib.sha256(chunk).hexdigest()
                    part_path = validate_logical_path(
                        f"{parts_parent}/_parts_{upload_token}/part{part_index:04d}",
                        require_known_category=True,
                    )
                    part_res = self._call_bridge(
                        "put_file",
                        {
                            "logical_path": part_path,
                            "content_b64": base64.b64encode(chunk).decode("ascii"),
                            "content_type": "application/octet-stream",
                            "expected_sha256": part_sha,
                            "skip_dedup": True,
                        },
                    )
                    part_info = part_res["file"]
                    part_file_id = validate_drive_file_id(str(part_info["file_id"]))
                    uploaded_parts.append(
                        {
                            "index": part_index,
                            "file_id": part_file_id,
                            "size_bytes": len(chunk),
                            "sha256": part_sha,
                        }
                    )
                    offset += len(chunk)
                    part_index += 1

                manifest_obj = {
                    "viread_chunked_v1": True,
                    "logical_path": clean_path,
                    "content_type": content_type,
                    "size_bytes": actual_size,
                    "sha256": actual_sha,
                    "parts": uploaded_parts,
                }
                manifest_bytes = json.dumps(manifest_obj, separators=(",", ":"), sort_keys=True).encode("utf-8")
                manifest_sha = hashlib.sha256(manifest_bytes).hexdigest()
                manifest_res = self._call_bridge(
                    "put_file",
                    {
                        "logical_path": clean_path,
                        "content_b64": base64.b64encode(manifest_bytes).decode("ascii"),
                        "content_type": APPS_SCRIPT_CHUNKED_MIME,
                        "expected_sha256": manifest_sha,
                        "skip_dedup": True,
                        "metadata": {
                            **dict(metadata or {}),
                            "viread_chunked_v1": True,
                            "viread_logical_size": actual_size,
                            "viread_logical_sha256": actual_sha,
                            "viread_logical_content_type": content_type,
                        },
                    },
                )
            except Exception:
                for part in uploaded_parts:
                    try:
                        self._call_bridge("delete_file", {"file_id": part["file_id"]})
                    except Exception:
                        pass
                raise

            manifest_file_id = validate_drive_file_id(str(manifest_res["file"]["file_id"]))
            return StoredArtifact(
                provider=StorageProvider.GOOGLE_DRIVE,
                reference=format_gdrive_ref(manifest_file_id),
                logical_path=clean_path,
                sha256=actual_sha,
                size_bytes=actual_size,
                content_type=content_type,
                drive_file_id=manifest_file_id,
                deduplicated=False,
                metadata={**dict(metadata or {}), "chunked_parts": len(uploaded_parts)},
            )
        finally:
            if should_close:
                stream.close()

    def _read_bridge_file_bytes(self, file_id: str) -> tuple[ArtifactMetadata, bytes]:
        res = self._call_bridge("get_file", {"file_id": file_id})
        file_info = dict(res.get("file") or {})
        if not file_info.get("file_id"):
            file_info["file_id"] = file_id
        meta = self._metadata_from_file_info(file_info)
        if meta.is_public:
            raise DrivePermissionError(
                "Drive artifact has public permissions; refusing read",
                code="DRIVE_PUBLIC_PERMISSION_DETECTED",
            )
        if meta.trashed:
            raise DriveNotFoundError("Drive artifact is trashed")
        raw_bytes = base64.b64decode(str(res.get("content_b64") or ""))
        is_chunked = bool(file_info.get("is_chunked")) or bool(meta.extra.get("is_chunked"))
        if is_chunked:
            try:
                manifest = json.loads(raw_bytes.decode("utf-8"))
            except Exception as exc:
                raise DriveIntegrityError("Corrupted chunked artifact manifest on Google Drive") from exc
            if not isinstance(manifest, dict) or not manifest.get("viread_chunked_v1"):
                raise DriveIntegrityError("Invalid chunked artifact manifest structure")
            parts = sorted(manifest.get("parts") or [], key=lambda p: int(p.get("index", 0)))
            if meta.size_bytes is None and isinstance(manifest.get("size_bytes"), int):
                meta = replace(meta, size_bytes=int(manifest["size_bytes"]))
            buf = bytearray()
            for part in parts:
                part_id = validate_drive_file_id(str(part["file_id"]))
                part_res = self._call_bridge("get_file", {"file_id": part_id})
                part_bytes = base64.b64decode(str(part_res.get("content_b64") or ""))
                expected_part_sha = validate_sha256(part.get("sha256"), required=False)
                actual_part_sha = hashlib.sha256(part_bytes).hexdigest()
                if expected_part_sha and actual_part_sha != expected_part_sha:
                    raise DriveIntegrityError("Chunked artifact part SHA-256 mismatch")
                buf.extend(part_bytes)
            raw_bytes = bytes(buf)
        if meta.sha256:
            actual_sha = hashlib.sha256(raw_bytes).hexdigest()
            if actual_sha != meta.sha256.lower():
                raise DriveIntegrityError(
                    f"Streamed artifact SHA-256 mismatch: expected {meta.sha256[:12]}, got {actual_sha[:12]}"
                )
        return meta, raw_bytes

    def _get_vpack_members(self, pack_file_id: str) -> dict[str, bytes]:
        pack_ref = format_gdrive_ref(pack_file_id)
        if parse_vpack_ref(pack_ref) is not None:
            raise ValueError("Pack file ID cannot itself be a virtual vpack reference")
        clean_pack_id = parse_artifact_ref(pack_ref).drive_file_id
        assert clean_pack_id is not None
        with self._vpack_cache_lock:
            cached = self._vpack_cache.get(clean_pack_id)
            if cached is not None:
                self._vpack_cache.move_to_end(clean_pack_id)
                return cached
            inflight_lock = self._vpack_inflight_locks.setdefault(clean_pack_id, threading.Lock())

        with inflight_lock:
            with self._vpack_cache_lock:
                cached = self._vpack_cache.get(clean_pack_id)
                if cached is not None:
                    self._vpack_cache.move_to_end(clean_pack_id)
                    return cached

            _pack_meta, raw_tar_bytes = self._read_bridge_file_bytes(clean_pack_id)
            members: dict[str, bytes] = {}
            try:
                with tarfile.open(fileobj=io.BytesIO(raw_tar_bytes), mode="r:*") as tf:
                    for tar_member in tf.getmembers():
                        if not tar_member.isfile():
                            continue
                        base_name = tar_member.name.replace("\\", "/").rsplit("/", 1)[-1]
                        stem = (base_name.split(".", 1)[0] if "." in base_name else base_name).lower()
                        if not SHA256_HEX_RE.fullmatch(stem):
                            continue
                        extracted = tf.extractfile(tar_member)
                        members[stem] = extracted.read() if extracted is not None else b""
            except (tarfile.TarError, EOFError, OSError) as exc:
                raise DriveIntegrityError("Corrupted virtual pack tar archive on Google Drive") from exc

            with self._vpack_cache_lock:
                self._vpack_cache[clean_pack_id] = members
                self._vpack_cache.move_to_end(clean_pack_id)
                while len(self._vpack_cache) > self._vpack_cache_capacity:
                    self._vpack_cache.popitem(last=False)
            return members

    def _resolve_vpack_member(
        self,
        reference: str,
        *,
        expected_sha256: str | None = None,
    ) -> tuple[ArtifactMetadata, bytes]:
        vpack = parse_vpack_ref(reference)
        if vpack is None:
            raise ValueError("Reference is not a valid virtual pack reference")
        pack_file_id, member_sha = vpack
        expected = validate_sha256(expected_sha256, required=False)
        if expected and expected != member_sha:
            raise DriveIntegrityError(
                f"Virtual pack member SHA-256 mismatch: expected {expected[:12]}, got {member_sha[:12]}"
            )
        members = self._get_vpack_members(pack_file_id)
        member_bytes = members.get(member_sha)
        if member_bytes is None:
            raise DriveNotFoundError(f"Virtual pack {pack_file_id} does not contain member {member_sha}")
        actual_sha = hashlib.sha256(member_bytes).hexdigest()
        if actual_sha != member_sha:
            raise DriveIntegrityError(
                f"Virtual pack member SHA-256 mismatch: expected {member_sha[:12]}, got {actual_sha[:12]}"
            )
        if member_bytes.startswith(b"\x89PNG\r\n\x1a\n"):
            content_type = "image/png"
            ext = "png"
        elif member_bytes.startswith(b"\xff\xd8\xff"):
            content_type = "image/jpeg"
            ext = "jpg"
        elif member_bytes[:4] == b"RIFF" and member_bytes[8:12] == b"WEBP":
            content_type = "image/webp"
            ext = "webp"
        else:
            content_type = "application/octet-stream"
            ext = "bin"
        meta = ArtifactMetadata(
            provider=StorageProvider.GOOGLE_DRIVE,
            reference=build_vpack_storage_ref(pack_file_id, member_sha),
            name=f"{member_sha}.{ext}",
            size_bytes=len(member_bytes),
            sha256=member_sha,
            content_type=content_type,
            trashed=False,
            is_public=False,
            drive_file_id=f"vpack--{pack_file_id}--{member_sha}",
            logical_path=None,
            extra={"is_chunked": False, "is_vpack_member": True, "pack_file_id": pack_file_id},
        )
        return meta, member_bytes

    def get_metadata(self, reference: str) -> ArtifactMetadata:
        parsed = parse_artifact_ref(reference)
        if parsed.provider != StorageProvider.GOOGLE_DRIVE or not parsed.drive_file_id:
            raise ValueError("GoogleAppsScriptDriveStore only handles gdrive:// references")
        if parse_vpack_ref(parsed.raw) is not None:
            meta, _member_bytes = self._resolve_vpack_member(parsed.raw)
            return meta
        res = self._call_bridge("get_metadata", {"file_id": parsed.drive_file_id})
        meta = self._metadata_from_file_info(res["file"])
        if meta.is_public:
            raise DrivePermissionError(
                "Drive artifact has public permissions; refusing read",
                code="DRIVE_PUBLIC_PERMISSION_DETECTED",
            )
        return meta

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
        chunk_size: int = 1024 * 1024,
        expected_sha256: str | None = None,
        preloaded_meta: ArtifactMetadata | None = None,
    ) -> Iterator[bytes]:
        parsed = parse_artifact_ref(reference)
        if parsed.provider != StorageProvider.GOOGLE_DRIVE or not parsed.drive_file_id:
            raise ValueError("GoogleAppsScriptDriveStore only handles gdrive:// references")
        expected = validate_sha256(expected_sha256, required=False)
        if parse_vpack_ref(parsed.raw) is not None:
            _meta, member_bytes = self._resolve_vpack_member(parsed.raw, expected_sha256=expected)
            step = max(64 * 1024, int(chunk_size))

            def _iter_vpack() -> Iterator[bytes]:
                for pos in range(0, len(member_bytes), step):
                    yield member_bytes[pos : pos + step]

            return _iter_vpack()
        file_id = parsed.drive_file_id
        meta = preloaded_meta if preloaded_meta is not None else self.get_metadata(reference)
        if meta.is_public:
            raise DrivePermissionError(
                "Drive artifact has public permissions; refusing stream",
                code="DRIVE_PUBLIC_PERMISSION_DETECTED",
            )
        if meta.trashed:
            raise DriveNotFoundError("Drive artifact is trashed")

        res = self._call_bridge("get_file", {"file_id": file_id})
        raw_bytes = base64.b64decode(str(res.get("content_b64") or ""))
        is_chunked = bool(res.get("file", {}).get("is_chunked")) or bool(meta.extra.get("is_chunked"))

        def _iter_bytes() -> Iterator[bytes]:
            digest = hashlib.sha256()
            step = max(64 * 1024, int(chunk_size))
            if is_chunked:
                try:
                    manifest = json.loads(raw_bytes.decode("utf-8"))
                except Exception as exc:
                    raise DriveIntegrityError("Corrupted chunked artifact manifest on Google Drive") from exc
                if not isinstance(manifest, dict) or not manifest.get("viread_chunked_v1"):
                    raise DriveIntegrityError("Invalid chunked artifact manifest structure")
                parts = sorted(manifest.get("parts") or [], key=lambda p: int(p.get("index", 0)))
                for part in parts:
                    part_id = validate_drive_file_id(str(part["file_id"]))
                    part_res = self._call_bridge("get_file", {"file_id": part_id})
                    part_bytes = base64.b64decode(str(part_res.get("content_b64") or ""))
                    expected_part_sha = validate_sha256(part.get("sha256"), required=False)
                    actual_part_sha = hashlib.sha256(part_bytes).hexdigest()
                    if expected_part_sha and actual_part_sha != expected_part_sha:
                        raise DriveIntegrityError("Chunked artifact part SHA-256 mismatch")
                    for pos in range(0, len(part_bytes), step):
                        piece = part_bytes[pos : pos + step]
                        digest.update(piece)
                        yield piece
            else:
                for pos in range(0, len(raw_bytes), step):
                    piece = raw_bytes[pos : pos + step]
                    digest.update(piece)
                    yield piece

            actual = digest.hexdigest()
            authoritative = expected or meta.sha256
            if authoritative and actual != authoritative.lower():
                raise DriveIntegrityError(
                    f"Streamed artifact SHA-256 mismatch: expected {authoritative[:12]}, got {actual[:12]}"
                )

        return _iter_bytes()

    def open_stream_with_metadata(
        self,
        reference: str,
        *,
        chunk_size: int = 1024 * 1024,
        expected_sha256: str | None = None,
    ) -> tuple[ArtifactMetadata, Iterator[bytes]]:
        """Fetch Drive metadata + payload eagerly so failures raise before HTTP 200 headers flush."""
        parsed = parse_artifact_ref(reference)
        if parsed.provider != StorageProvider.GOOGLE_DRIVE or not parsed.drive_file_id:
            raise ValueError("GoogleAppsScriptDriveStore only handles gdrive:// references")
        expected = validate_sha256(expected_sha256, required=False)
        step = max(64 * 1024, int(chunk_size))
        if parse_vpack_ref(parsed.raw) is not None:
            meta, member_bytes = self._resolve_vpack_member(parsed.raw, expected_sha256=expected)

            def _iter_vpack() -> Iterator[bytes]:
                for pos in range(0, len(member_bytes), step):
                    yield member_bytes[pos : pos + step]

            return meta, _iter_vpack()
        file_id = parsed.drive_file_id

        res = self._call_bridge("get_file", {"file_id": file_id})
        file_info = res.get("file") or {}
        meta = self._metadata_from_file_info(file_info)
        if meta.is_public:
            raise DrivePermissionError(
                "Drive artifact has public permissions; refusing stream",
                code="DRIVE_PUBLIC_PERMISSION_DETECTED",
            )
        if meta.trashed:
            raise DriveNotFoundError("Drive artifact is trashed")

        raw_bytes = base64.b64decode(str(res.get("content_b64") or ""))
        is_chunked = bool(file_info.get("is_chunked")) or bool(meta.extra.get("is_chunked"))

        if is_chunked:
            try:
                manifest = json.loads(raw_bytes.decode("utf-8"))
            except Exception as exc:
                raise DriveIntegrityError("Corrupted chunked artifact manifest on Google Drive") from exc
            if not isinstance(manifest, dict) or not manifest.get("viread_chunked_v1"):
                raise DriveIntegrityError("Invalid chunked artifact manifest structure")
            parts = sorted(manifest.get("parts") or [], key=lambda p: int(p.get("index", 0)))
            if meta.size_bytes is None and isinstance(manifest.get("size_bytes"), int):
                meta = replace(meta, size_bytes=int(manifest["size_bytes"]))

            def _iter_chunked() -> Iterator[bytes]:
                digest = hashlib.sha256()
                for part in parts:
                    part_id = validate_drive_file_id(str(part["file_id"]))
                    part_res = self._call_bridge("get_file", {"file_id": part_id})
                    part_bytes = base64.b64decode(str(part_res.get("content_b64") or ""))
                    expected_part_sha = validate_sha256(part.get("sha256"), required=False)
                    actual_part_sha = hashlib.sha256(part_bytes).hexdigest()
                    if expected_part_sha and actual_part_sha != expected_part_sha:
                        raise DriveIntegrityError("Chunked artifact part SHA-256 mismatch")
                    for pos in range(0, len(part_bytes), step):
                        piece = part_bytes[pos : pos + step]
                        digest.update(piece)
                        yield piece
                actual = digest.hexdigest()
                authoritative = expected or meta.sha256
                if authoritative and actual != authoritative.lower():
                    raise DriveIntegrityError(
                        f"Streamed artifact SHA-256 mismatch: expected {authoritative[:12]}, got {actual[:12]}"
                    )

            return meta, _iter_chunked()

        actual = hashlib.sha256(raw_bytes).hexdigest()
        authoritative = expected or meta.sha256
        if authoritative and actual != authoritative.lower():
            raise DriveIntegrityError(
                f"Streamed artifact SHA-256 mismatch: expected {authoritative[:12]}, got {actual[:12]}"
            )
        if meta.size_bytes is None:
            meta = replace(meta, size_bytes=len(raw_bytes))

        def _iter_raw() -> Iterator[bytes]:
            for pos in range(0, len(raw_bytes), step):
                yield raw_bytes[pos : pos + step]

        return meta, _iter_raw()

    def get(
        self,
        reference: str,
        *,
        expected_sha256: str | None = None,
        max_bytes: int | None = None,
    ) -> bytes:
        meta = self.get_metadata(reference)
        if max_bytes is not None and meta.size_bytes is not None and meta.size_bytes > max_bytes:
            raise DriveIntegrityError(f"Artifact size {meta.size_bytes} exceeds max_bytes limit {max_bytes}")
        buf = bytearray()
        for chunk in self.open_stream(reference, expected_sha256=expected_sha256, preloaded_meta=meta):
            buf.extend(chunk)
            if max_bytes is not None and len(buf) > max_bytes:
                raise DriveIntegrityError(f"Artifact download exceeded max_bytes limit {max_bytes}")
        return bytes(buf)

    def _delete_with_telemetry(
        self,
        reference: str,
        *,
        is_referenced_check: Callable[[str], bool],
    ) -> tuple[bool, str | None, bool | None]:
        parsed = parse_artifact_ref(reference)
        if parsed.provider != StorageProvider.GOOGLE_DRIVE or not parsed.drive_file_id:
            raise ValueError("GoogleAppsScriptDriveStore only handles gdrive:// references")
        if is_referenced_check(parsed.raw):
            return False, None, None
        res = self._call_bridge("delete_file", {"file_id": parsed.drive_file_id})
        deleted = bool(res.get("deleted"))
        raw_mode = res.get("delete_mode")
        delete_mode = str(raw_mode).strip() if isinstance(raw_mode, str) and raw_mode.strip() else None
        raw_perm = res.get("permanent_delete")
        permanent_delete = raw_perm if isinstance(raw_perm, bool) else (
            True if delete_mode == "permanent_delete" else (False if delete_mode == "trash_fallback" else None)
        )
        if res.get("trashed_fallback") is True or delete_mode == "trash_fallback":
            logger.warning(
                "Apps Script Drive bridge fell back to setTrashed(true) instead of permanent delete for %s; enable Services (+) -> Drive API in Apps Script to reclaim 15 GiB quota immediately.",
                parsed.drive_file_id,
            )
        return deleted, delete_mode, permanent_delete

    def delete_if_unreferenced(
        self,
        reference: str,
        *,
        is_referenced_check: Callable[[str], bool],
    ) -> bool:
        deleted, _delete_mode, _permanent_delete = self._delete_with_telemetry(
            reference,
            is_referenced_check=is_referenced_check,
        )
        return deleted

    def self_test(self) -> DriveSelfTestResult:
        token = uuid4().hex[:12]
        logical_path = f"_selftest/selftest-{token}.txt"
        payload = f"viread-flow2-apps-script-selftest:{token}:{int(time.time())}".encode("utf-8")
        expected_sha = hashlib.sha256(payload).hexdigest()
        stored = self.put(
            logical_path,
            payload,
            content_type="text/plain",
            expected_sha256=expected_sha,
            metadata={"purpose": "selftest"},
        )
        downloaded = self.get(stored.reference, expected_sha256=expected_sha, max_bytes=64 * 1024)
        meta = self.get_metadata(stored.reference)
        deleted, delete_mode, permanent_delete = self._delete_with_telemetry(
            stored.reference,
            is_referenced_check=lambda _ref: False,
        )
        quota = self.quota_check(incoming_bytes=0)
        ok = downloaded == payload and not meta.is_public and deleted
        warning: str | None = None
        if delete_mode == "trash_fallback" or permanent_delete is False:
            warning = (
                "Apps Script Bridge đã xóa tạm thời vào Thùng rác (trash_fallback) thay vì xóa vĩnh viễn. "
                "Hãy bật Services (+) -> Drive API trong Google Apps Script để tránh đầy dung lượng 15 GiB."
            )
        return DriveSelfTestResult(
            ok=ok,
            logical_path=logical_path,
            drive_file_id=stored.drive_file_id,
            sha256=expected_sha,
            size_bytes=len(payload),
            deleted_after_test=deleted,
            is_private=not meta.is_public,
            quota=quota,
            detail="Upload, SHA-256 verification, private read-back, and cleanup succeeded via Apps Script Bridge"
            if ok
            else "Self-test completed with one or more failed assertions",
            permanent_delete=permanent_delete,
            delete_mode=delete_mode,
            warning=warning,
        )

    def list_resume_files(self, job_id: str) -> list[dict[str, Any]]:
        clean_job = str(job_id or "").strip().lower()
        validate_resume_object_path(clean_job, "resume-manifest.json")
        res = self._call_bridge("list_resume_files", {"job_id": clean_job})
        files = []
        for entry in res.get("files") or []:
            if not isinstance(entry, dict) or not entry.get("name") or not entry.get("drive_file_id"):
                continue
            files.append(
                {
                    "name": str(entry["name"]),
                    "drive_file_id": validate_drive_file_id(str(entry["drive_file_id"])),
                    "size_bytes": _parse_int_or_none(entry.get("size_bytes")) or 0,
                    "sha256": str(entry.get("sha256") or "").strip().lower() or None,
                }
            )
        return files

    def put_resume_file(
        self,
        job_id: str,
        relative_path: str,
        data: bytes | Path | BinaryIO,
        *,
        content_type: str = "application/octet-stream",
        expected_sha256: str | None = None,
    ) -> StoredArtifact:
        logical_path = validate_resume_object_path(job_id, relative_path)
        stream, should_close, actual_size, actual_sha = self._prepare_upload_stream(
            data,
            expected_sha256=expected_sha256,
            size_bytes=None,
        )
        base_pos = stream.tell()
        try:
            self._assert_quota_for_upload(actual_size)
            if actual_size <= self._chunk_bytes:
                stream.seek(base_pos)
                raw = stream.read(actual_size)
                res = self._call_bridge(
                    "put_resume_file",
                    {
                        "logical_path": logical_path,
                        "content_b64": base64.b64encode(raw).decode("ascii"),
                        "content_type": content_type,
                        "expected_sha256": actual_sha,
                        "metadata": {"purpose": "colab_resume", "job_id": str(job_id).strip().lower()},
                    },
                )
                file_info = res["file"]
                file_id = validate_drive_file_id(str(file_info["file_id"]))
                return StoredArtifact(
                    provider=StorageProvider.GOOGLE_DRIVE,
                    reference=format_gdrive_ref(file_id),
                    logical_path=logical_path,
                    sha256=actual_sha,
                    size_bytes=actual_size,
                    content_type=content_type,
                    drive_file_id=file_id,
                    deduplicated=False,
                    metadata={"purpose": "colab_resume", "job_id": str(job_id).strip().lower()},
                )
            # Oversized resume file fallback via chunked put (RemoteBackendJobStateStore already chunks at 8 MiB)
            stream.seek(base_pos)
            return self.put(
                logical_path,
                stream,
                content_type=content_type,
                expected_sha256=actual_sha,
                metadata={"purpose": "colab_resume", "job_id": str(job_id).strip().lower()},
            )
        finally:
            if should_close:
                stream.close()

    def open_resume_file_stream(
        self,
        job_id: str,
        relative_path: str,
        *,
        expected_sha256: str | None = None,
    ) -> tuple[ArtifactMetadata, Iterator[bytes]]:
        logical_path = validate_resume_object_path(job_id, relative_path)
        res = self._call_bridge("get_resume_file_meta", {"logical_path": logical_path})
        meta = self._metadata_from_file_info(res["file"])
        return meta, self.open_stream(meta.reference, expected_sha256=expected_sha256, preloaded_meta=meta)

    def delete_resume_file(self, job_id: str, relative_path: str) -> bool:
        logical_path = validate_resume_object_path(job_id, relative_path)
        res = self._call_bridge("delete_resume_file", {"logical_path": logical_path})
        if res.get("trashed_fallback") is True or res.get("delete_mode") == "trash_fallback":
            logger.warning(
                "Apps Script Drive bridge fell back to setTrashed(true) when deleting resume file %s; enable Services (+) -> Drive API in Apps Script.",
                logical_path,
            )
        return bool(res.get("deleted"))
