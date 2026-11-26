from __future__ import annotations

import asyncio
import copy
from datetime import datetime
import hashlib
import inspect
import json
import logging
import os
import threading
import time
from typing import Any
from uuid import UUID

from fastapi import HTTPException
import requests
from sqlalchemy.ext.asyncio import AsyncSession

from app.database.config import SUPABASE_ADMIN_KEY, SUPABASE_URL
from app.repositories.viread_drive_connection_repository import (
    PRIMARY_CONNECTION_KEY,
    VireadDriveConnectionRepository,
)
from app.services.training_storage.base import (
    DriveAuthError,
    DriveNotConnectedError,
    DrivePermissionError,
    DriveQuotaExceededError,
    StorageQuotaStatus,
    TrainingStorageError,
)
from app.services.training_storage.google_apps_script_store import (
    APPS_SCRIPT_BRIDGE_SCOPE,
    GoogleAppsScriptDriveStore,
    apps_script_config_readiness,
    validate_apps_script_web_app_url,
)
from app.services.training_storage.google_drive_desktop_store import (
    DRIVE_DESKTOP_SYNC_SCOPE,
    GoogleDriveDesktopStore,
    detect_google_drive_desktop_mounts,
    drive_desktop_config_readiness,
    resolve_flow2_sync_root,
    validate_flow2_sync_root_allowed,
)
from app.services.training_storage.google_drive_oauth import (
    GOOGLE_DRIVE_REQUIRED_SCOPE,
    create_oauth_authorization,
    decrypt_refresh_token,
    encrypt_refresh_token,
    exchange_authorization_code,
    load_oauth_config,
    oauth_config_readiness,
    revoke_token,
    verify_and_consume_oauth_state,
)
from app.services.training_storage.google_drive_store import (
    DEFAULT_MIN_FREE_BUFFER_BYTES,
    GoogleDriveTrainingStore,
)
from app.services.training_storage.references import (
    DRIVE_ROOT_DISPLAY_PATH,
    StorageProvider,
)
from app.services.training_storage.router import (
    TrainingArtifactStoreRouter,
    flow2_storage_provider_setting,
)

logger = logging.getLogger(__name__)

DriveStoreType = GoogleDriveTrainingStore | GoogleAppsScriptDriveStore | GoogleDriveDesktopStore

_sync_store_lock = threading.Lock()
_sync_store_cache: tuple[float, DriveStoreType | None] = (0.0, None)
_warm_store_cache: dict[tuple[str, str], DriveStoreType] = {}
_SYNC_STORE_CACHE_TTL_SECONDS = 60.0

_desktop_readiness_lock = threading.Lock()
_desktop_readiness_cache: tuple[float, tuple[Any, ...], dict[str, Any]] | None = None
_DESKTOP_READINESS_CACHE_TTL_SECONDS = 30.0


def invalidate_desktop_mount_probe_cache() -> None:
    global _desktop_readiness_cache
    with _desktop_readiness_lock:
        _desktop_readiness_cache = None


def _desktop_readiness_cache_key() -> tuple[Any, ...]:
    return (
        id(drive_desktop_config_readiness),
        (os.getenv("VIREAD_GDRIVE_TOKEN_ENCRYPTION_KEY") or "").strip(),
        (os.getenv("VIREAD_GDRIVE_REQUIRED_ACCOUNT_EMAIL") or "").strip().lower(),
        (os.getenv("VIREAD_GDRIVE_DESKTOP_ALLOWED_ROOTS") or "").strip(),
        (os.getenv("VIREAD_GDRIVE_DESKTOP_ROOT") or "").strip(),
        (os.getenv("LOCALAPPDATA") or "").strip(),
    )


async def _get_cached_desktop_readiness() -> dict[str, Any]:
    global _desktop_readiness_cache
    now = time.monotonic()
    key = _desktop_readiness_cache_key()
    with _desktop_readiness_lock:
        cached = _desktop_readiness_cache
        if cached is not None and cached[0] > now and cached[1] == key:
            return copy.deepcopy(cached[2])
    fresh = await asyncio.to_thread(drive_desktop_config_readiness)
    with _desktop_readiness_lock:
        _desktop_readiness_cache = (
            time.monotonic() + _DESKTOP_READINESS_CACHE_TTL_SECONDS,
            key,
            copy.deepcopy(fresh),
        )
    return fresh


def invalidate_sync_google_drive_store_cache() -> None:
    global _sync_store_cache
    with _sync_store_lock:
        _sync_store_cache = (0.0, None)
        _warm_store_cache.clear()
    invalidate_desktop_mount_probe_cache()


def _set_sync_google_drive_store_cache(store: DriveStoreType | None) -> None:
    global _sync_store_cache
    with _sync_store_lock:
        _sync_store_cache = (time.monotonic() + _SYNC_STORE_CACHE_TTL_SECONDS, store)


def _mark_token_revoked_via_postgrest(error_code: str) -> None:
    """Best-effort out-of-band DB status update when Google revokes the refresh token."""
    invalidate_sync_google_drive_store_cache()
    if not SUPABASE_URL or not SUPABASE_ADMIN_KEY:
        return
    try:
        requests.patch(
            f"{SUPABASE_URL.rstrip('/')}/rest/v1/viread_ocr_drive_connections",
            params={"connection_key": f"eq.{PRIMARY_CONNECTION_KEY}"},
            headers={
                "apikey": SUPABASE_ADMIN_KEY,
                "Authorization": f"Bearer {SUPABASE_ADMIN_KEY}",
                "Content-Type": "application/json",
            },
            json={
                "status": "TOKEN_REVOKED",
                "last_health_status": "TOKEN_REVOKED",
                "last_error_code": error_code[:64],
            },
            timeout=(2, 4),
        )
    except Exception:
        pass


def _iso_or_none(value: Any) -> str | None:
    if value is None:
        return None
    if isinstance(value, datetime):
        return value.isoformat()
    return str(value)


def _min_free_buffer_bytes() -> int:
    raw = (os.getenv("VIREAD_GDRIVE_MIN_FREE_BYTES") or "").strip()
    try:
        return max(0, int(raw)) if raw else DEFAULT_MIN_FREE_BUFFER_BYTES
    except ValueError:
        return DEFAULT_MIN_FREE_BUFFER_BYTES


def _max_training_budget_bytes() -> int | None:
    raw = (os.getenv("VIREAD_GDRIVE_MAX_TRAINING_BYTES") or "").strip()
    try:
        val = int(raw) if raw else 0
    except ValueError:
        return None
    return val if val > 0 else None


def _compute_quota_summary(row: dict[str, Any] | None) -> dict[str, Any]:
    min_buffer = _min_free_buffer_bytes()
    max_budget = _max_training_budget_bytes()
    if not row:
        return {
            "limit_bytes": None,
            "usage_bytes": None,
            "usage_in_drive_bytes": None,
            "usage_in_trash_bytes": None,
            "available_bytes": None,
            "min_free_buffer_bytes": min_buffer,
            "max_training_budget_bytes": max_budget,
            "warning_level": "UNKNOWN",
            "can_accept_upload": False,
            "checked_at": None,
        }
    limit_b = row.get("quota_limit_bytes")
    usage_b = row.get("quota_usage_bytes")
    drive_b = row.get("quota_usage_in_drive_bytes")
    trash_b = row.get("quota_usage_in_trash_bytes")
    available_b = max(0, int(limit_b) - int(usage_b)) if (limit_b is not None and usage_b is not None) else None
    warning = "UNKNOWN"
    can_upload = row.get("status") == "CONNECTED"
    if available_b is not None and limit_b:
        if available_b <= min_buffer:
            warning = "EXCEEDED"
            can_upload = False
        else:
            ratio = int(usage_b) / max(1, int(limit_b))
            if ratio >= 0.90 or available_b <= (min_buffer * 2):
                warning = "CRITICAL"
            elif ratio >= 0.75:
                warning = "WARNING"
            else:
                warning = "OK"
    if max_budget is not None and drive_b is not None and int(drive_b) >= max_budget:
        warning = "EXCEEDED"
        can_upload = False
    return {
        "limit_bytes": int(limit_b) if limit_b is not None else None,
        "usage_bytes": int(usage_b) if usage_b is not None else None,
        "usage_in_drive_bytes": int(drive_b) if drive_b is not None else None,
        "usage_in_trash_bytes": int(trash_b) if trash_b is not None else None,
        "available_bytes": available_b,
        "min_free_buffer_bytes": min_buffer,
        "max_training_budget_bytes": max_budget,
        "warning_level": warning,
        "can_accept_upload": can_upload,
        "checked_at": _iso_or_none(row.get("quota_checked_at")),
    }


def _quota_status_to_dict(quota: StorageQuotaStatus | None) -> dict[str, Any] | None:
    if quota is None:
        return None
    return {
        "limit_bytes": quota.limit_bytes,
        "usage_bytes": quota.usage_bytes,
        "usage_in_drive_bytes": quota.usage_in_drive_bytes,
        "usage_in_trash_bytes": quota.usage_in_trash_bytes,
        "available_bytes": quota.available_bytes,
        "min_free_buffer_bytes": quota.min_free_buffer_bytes,
        "max_training_budget_bytes": quota.max_training_budget_bytes,
        "warning_level": quota.warning_level,
        "can_accept_upload": quota.can_accept_upload,
        "detail": quota.detail,
    }


def _serialize_connection_status(
    row: dict[str, Any] | None,
    *,
    migration_applied: bool,
    desktop_readiness: dict[str, Any] | None = None,
) -> dict[str, Any]:
    readiness = oauth_config_readiness()
    bridge_readiness = apps_script_config_readiness()
    resolved_desktop_readiness = (
        desktop_readiness
        if desktop_readiness is not None
        else drive_desktop_config_readiness()
    )
    configured_provider = flow2_storage_provider_setting().value
    if not migration_applied:
        return {
            "provider": configured_provider,
            "migration_applied": False,
            "status": "DISCONNECTED",
            "connected": False,
            "connection_mode": None,
            "oauth_configured": readiness["oauth_configured"],
            "oauth_readiness": readiness,
            "apps_script_readiness": bridge_readiness,
            "drive_desktop_readiness": resolved_desktop_readiness,
            "required_account_email": readiness.get("required_account_email"),
            "account_email": None,
            "account_display_name": None,
            "oauth_scope": None,
            "scope_valid": False,
            "root_folder_id": None,
            "root_folder_path": DRIVE_ROOT_DISPLAY_PATH,
            "subfolder_ids": {},
            "quota": _compute_quota_summary(None),
            "last_health_check_at": None,
            "last_health_status": "MIGRATION_PENDING",
            "last_error_code": "DRIVE_MIGRATION_PENDING",
            "connected_at": None,
            "disconnected_at": None,
        }
    status_val = str(row.get("status") or "DISCONNECTED") if row else "DISCONNECTED"
    scope_val = str(row.get("oauth_scope") or "").strip() if row else ""
    scope_tokens = {tok for tok in scope_val.split() if tok}
    is_apps_script = scope_val == APPS_SCRIPT_BRIDGE_SCOPE
    is_drive_desktop = scope_val == DRIVE_DESKTOP_SYNC_SCOPE
    scope_valid = is_apps_script or is_drive_desktop or (scope_tokens == {GOOGLE_DRIVE_REQUIRED_SCOPE})
    if is_drive_desktop:
        connection_mode = "drive_desktop_sync"
    elif is_apps_script:
        connection_mode = "apps_script_bridge"
    elif scope_val:
        connection_mode = "oauth"
    else:
        connection_mode = None
    subfolders = row.get("subfolder_ids") if (row and isinstance(row.get("subfolder_ids"), dict)) else {}
    raw_root_path = str(row.get("root_folder_path") or "").strip() if row else ""
    if (
        is_drive_desktop
        or not raw_root_path
        or " (" in raw_root_path
        or ":\\" in raw_root_path
        or ":/" in raw_root_path
        or raw_root_path.startswith(("/", "\\"))
    ):
        safe_root_folder_path = DRIVE_ROOT_DISPLAY_PATH
    else:
        safe_root_folder_path = raw_root_path
    return {
        "provider": configured_provider,
        "migration_applied": True,
        "status": status_val,
        "connected": status_val == "CONNECTED" and bool(row and row.get("encrypted_refresh_token")),
        "connection_mode": connection_mode,
        "oauth_configured": readiness["oauth_configured"],
        "oauth_readiness": readiness,
        "apps_script_readiness": bridge_readiness,
        "drive_desktop_readiness": resolved_desktop_readiness,
        "required_account_email": readiness.get("required_account_email"),
        "account_email": row.get("account_email") if row else None,
        "account_display_name": row.get("account_display_name") if row else None,
        "oauth_scope": scope_val or None,
        "scope_valid": scope_valid,
        "root_folder_id": row.get("root_folder_id") if row else None,
        "root_folder_path": safe_root_folder_path,
        "subfolder_ids": dict(subfolders),
        "quota": _compute_quota_summary(row),
        "last_health_check_at": _iso_or_none(row.get("last_health_check_at")) if row else None,
        "last_health_status": row.get("last_health_status") if row else None,
        "last_error_code": row.get("last_error_code") if row else None,
        "connected_at": _iso_or_none(row.get("connected_at")) if row else None,
        "disconnected_at": _iso_or_none(row.get("disconnected_at")) if row else None,
    }


def _http_exception_from_storage_error(exc: TrainingStorageError) -> HTTPException:
    status_code = exc.http_status or 503
    return HTTPException(status_code=status_code, detail=f"{exc.code}: {exc}")


def build_google_drive_store_from_row(
    row: dict[str, Any],
    *,
    access_token: str | None = None,
    access_token_expires_at: float = 0.0,
    session: requests.Session | None = None,
    use_warm_cache: bool = True,
) -> DriveStoreType:
    if str(row.get("status") or "") != "CONNECTED":
        raise DriveNotConnectedError("Google Drive is not connected for Flow 2 training")
    encrypted = str(row.get("encrypted_refresh_token") or "").strip()
    if not encrypted:
        raise DriveNotConnectedError("Google Drive credential is not stored; reconnect Drive")
    root_folder_id = str(row.get("root_folder_id") or "")
    scope_val = str(row.get("oauth_scope") or "").strip()
    cache_key = (hashlib.sha256(encrypted.encode("utf-8")).hexdigest(), root_folder_id)
    if use_warm_cache and session is None and access_token is None:
        with _sync_store_lock:
            warm = _warm_store_cache.get(cache_key)
            if warm is not None:
                return warm

    enc_key = (os.getenv("VIREAD_GDRIVE_TOKEN_ENCRYPTION_KEY") or "").strip()
    subfolders = row.get("subfolder_ids") if isinstance(row.get("subfolder_ids"), dict) else {}

    if scope_val == DRIVE_DESKTOP_SYNC_SCOPE:
        if len(enc_key) < 32:
            raise TrainingStorageError(
                "Server VIREAD_GDRIVE_TOKEN_ENCRYPTION_KEY is not configured",
                code="DRIVE_ENCRYPTION_KEY_MISSING",
                http_status=503,
            )
        decrypted = decrypt_refresh_token(encrypted, enc_key)
        try:
            cred = json.loads(decrypted)
        except Exception as exc:
            raise DriveAuthError(
                "Stored Google Drive Desktop configuration is corrupted; reconnect Drive",
                code="DRIVE_DESKTOP_CREDENTIAL_CORRUPTED",
                http_status=500,
            ) from exc
        if not isinstance(cred, dict) or cred.get("kind") != "drive_desktop_sync":
            raise DriveAuthError(
                "Stored Google Drive Desktop configuration has invalid type; reconnect Drive",
                code="DRIVE_DESKTOP_CREDENTIAL_CORRUPTED",
                http_status=500,
            )
        stored_root = resolve_flow2_sync_root(str(cred.get("root_dir") or ""))
        validated_root = validate_flow2_sync_root_allowed(stored_root)
        store = GoogleDriveDesktopStore(
            root_dir=validated_root,
            account_email=str(cred.get("account_email") or row.get("account_email") or "") or None,
        )
    elif scope_val == APPS_SCRIPT_BRIDGE_SCOPE:
        if len(enc_key) < 32:
            raise TrainingStorageError(
                "Server VIREAD_GDRIVE_TOKEN_ENCRYPTION_KEY is not configured",
                code="DRIVE_ENCRYPTION_KEY_MISSING",
                http_status=503,
            )
        decrypted = decrypt_refresh_token(encrypted, enc_key)
        try:
            cred = json.loads(decrypted)
        except Exception as exc:
            raise DriveAuthError(
                "Stored Apps Script Drive bridge credential is corrupted; reconnect Drive",
                code="DRIVE_BRIDGE_CREDENTIAL_CORRUPTED",
                http_status=500,
            ) from exc
        if not isinstance(cred, dict) or cred.get("kind") != "apps_script_bridge":
            raise DriveAuthError(
                "Stored Drive bridge credential has invalid type; reconnect Drive",
                code="DRIVE_BRIDGE_CREDENTIAL_CORRUPTED",
                http_status=500,
            )
        store: DriveStoreType = GoogleAppsScriptDriveStore(
            web_app_url=str(cred.get("web_app_url") or ""),
            bridge_secret=str(cred.get("bridge_secret") or ""),
            root_folder_id=root_folder_id or None,
            subfolder_ids={str(k): str(v) for k, v in subfolders.items() if v},
            session=session,
        )
    else:
        client_id = (os.getenv("VIREAD_GDRIVE_OAUTH_CLIENT_ID") or "").strip()
        client_secret = (os.getenv("VIREAD_GDRIVE_OAUTH_CLIENT_SECRET") or "").strip()
        if not client_id or not client_secret or not enc_key:
            raise TrainingStorageError(
                "Google Drive server OAuth credentials or encryption key are not configured",
                code="DRIVE_OAUTH_NOT_CONFIGURED",
                http_status=503,
            )
        refresh_token = decrypt_refresh_token(encrypted, enc_key)
        store = GoogleDriveTrainingStore(
            client_id=client_id,
            client_secret=client_secret,
            refresh_token=refresh_token,
            access_token=access_token,
            access_token_expires_at=access_token_expires_at,
            granted_scope=scope_val or GOOGLE_DRIVE_REQUIRED_SCOPE,
            root_folder_id=root_folder_id or None,
            subfolder_ids={str(k): str(v) for k, v in subfolders.items() if v},
            session=session,
            on_token_revoked=_mark_token_revoked_via_postgrest,
        )
    if use_warm_cache and session is None:
        with _sync_store_lock:
            _warm_store_cache.clear()
            _warm_store_cache[cache_key] = store
    return store


def load_sync_google_drive_store() -> DriveStoreType | None:
    """Synchronous Google Drive store loader for OCR runtime model hydration (zero new DB drivers)."""
    now = time.monotonic()
    with _sync_store_lock:
        expires_at, cached = _sync_store_cache
        if expires_at > now:
            return cached

    if not SUPABASE_URL or not SUPABASE_ADMIN_KEY:
        return None
    try:
        response = requests.get(
            f"{SUPABASE_URL.rstrip('/')}/rest/v1/viread_ocr_drive_connections",
            params={
                "select": (
                    "status,oauth_scope,encrypted_refresh_token,"
                    "root_folder_id,subfolder_ids"
                ),
                "connection_key": f"eq.{PRIMARY_CONNECTION_KEY}",
                "limit": "1",
            },
            headers={
                "apikey": SUPABASE_ADMIN_KEY,
                "Authorization": f"Bearer {SUPABASE_ADMIN_KEY}",
            },
            timeout=(2, 4),
        )
        if response.status_code != 200:
            return None
        rows = response.json()
        row = rows[0] if isinstance(rows, list) and rows else None
        if not isinstance(row, dict) or row.get("status") != "CONNECTED":
            _set_sync_google_drive_store_cache(None)
            return None
        store = build_google_drive_store_from_row(row)
        _set_sync_google_drive_store_cache(store)
        return store
    except Exception as exc:
        logger.debug("Sync Google Drive store lookup unavailable: %s", type(exc).__name__)
        return None


class VireadDriveConnectionService:
    """Admin-facing OAuth 2.0 connection lifecycle, health check, quota guard, and self-test."""

    def __init__(self, db: AsyncSession, *, session: requests.Session | None = None) -> None:
        self.db = db
        self.repo = VireadDriveConnectionRepository(db)
        self._session = session

    async def _release_read_txn(self) -> None:
        rollback = getattr(self.db, "rollback", None)
        if callable(rollback):
            try:
                res = rollback()
                if inspect.isawaitable(res):
                    await res
            except Exception:
                pass

    async def _build_store_async(self, row: dict[str, Any]) -> DriveStoreType:
        scope_val = str(row.get("oauth_scope") or "").strip()
        if scope_val == DRIVE_DESKTOP_SYNC_SCOPE:
            return await asyncio.to_thread(
                build_google_drive_store_from_row,
                row,
                session=self._session,
            )
        return build_google_drive_store_from_row(row, session=self._session)

    async def get_status(self) -> dict[str, Any]:
        row, migration_applied = await self.repo.get_primary()
        await self._release_read_txn()
        desktop_readiness = await _get_cached_desktop_readiness()
        return _serialize_connection_status(
            row,
            migration_applied=migration_applied,
            desktop_readiness=desktop_readiness,
        )

    async def get_connected_store(self) -> DriveStoreType:
        row, migration_applied = await self.repo.get_primary()
        await self._release_read_txn()
        if not migration_applied:
            raise DriveNotConnectedError(
                "Flow 2 Google Drive database migration has not been applied yet"
            )
        if not row or row.get("status") != "CONNECTED":
            raise DriveNotConnectedError(
                "Google Drive is not connected for Flow 2 training; connect it in Admin Training"
            )
        store = await self._build_store_async(row)
        _set_sync_google_drive_store_cache(store)
        return store

    async def build_artifact_router(
        self,
        *,
        write_provider: StorageProvider | None = None,
    ) -> TrainingArtifactStoreRouter:
        target_provider = write_provider or flow2_storage_provider_setting()
        drive_store: DriveStoreType | None = None
        drive_init_error: TrainingStorageError | None = None
        row, migration_applied = await self.repo.get_primary()
        if migration_applied and row and row.get("status") == "CONNECTED":
            try:
                drive_store = await self._build_store_async(row)
                _set_sync_google_drive_store_cache(drive_store)
            except TrainingStorageError as exc:
                drive_init_error = exc

        def _drive_factory() -> DriveStoreType | None:
            if drive_init_error is not None:
                raise drive_init_error
            return drive_store

        return TrainingArtifactStoreRouter(
            drive_store_factory=_drive_factory,
            write_provider=target_provider,
        )

    async def start_connect(
        self,
        *,
        actor_id: UUID,
        redirect_uri: str | None = None,
    ) -> dict[str, Any]:
        _, migration_applied = await self.repo.get_primary()
        if not migration_applied:
            raise HTTPException(
                status_code=503,
                detail="Apply migration 20261121210000_flow2_google_drive_storage.sql before connecting Google Drive",
            )
        try:
            config = load_oauth_config(redirect_uri_override=redirect_uri)
            started = create_oauth_authorization(config, actor_id=str(actor_id))
        except TrainingStorageError as exc:
            raise _http_exception_from_storage_error(exc) from exc
        return {
            "authorization_url": started.authorization_url,
            "scope": started.scope,
            "redirect_uri": started.redirect_uri,
            "expires_in_seconds": started.expires_in_seconds,
        }

    async def complete_callback(
        self,
        *,
        actor_id: UUID,
        code: str,
        state: str,
    ) -> dict[str, Any]:
        _, migration_applied = await self.repo.get_primary()
        await self._release_read_txn()
        if not migration_applied:
            raise HTTPException(
                status_code=503,
                detail="Apply migration 20261121210000_flow2_google_drive_storage.sql before connecting Google Drive",
            )
        try:
            config = load_oauth_config()
            state_payload = verify_and_consume_oauth_state(
                state,
                expected_actor_id=str(actor_id),
                encryption_key=config.encryption_key,
            )
            tokens = await asyncio.to_thread(
                exchange_authorization_code,
                config,
                code=code,
                code_verifier=state_payload.code_verifier,
                redirect_uri=state_payload.redirect_uri,
                session=self._session,
            )
            if not tokens.refresh_token:
                raise DriveAuthError(
                    "Google did not issue an offline refresh token; remove previous consent and reconnect",
                    code="DRIVE_REFRESH_TOKEN_MISSING",
                    http_status=400,
                )
            encrypted_token, fingerprint = encrypt_refresh_token(
                tokens.refresh_token,
                config.encryption_key,
            )
            store = GoogleDriveTrainingStore(
                client_id=config.client_id,
                client_secret=config.client_secret,
                refresh_token=tokens.refresh_token,
                access_token=tokens.access_token,
                access_token_expires_at=time.monotonic() + tokens.expires_in,
                granted_scope=tokens.scope,
                session=self._session,
                on_token_revoked=_mark_token_revoked_via_postgrest,
            )

            def _bootstrap_drive() -> tuple[dict[str, str | None], str, dict[str, str], StorageQuotaStatus]:
                acc = store.get_account_info()
                if config.required_account_email:
                    actual_email = (acc.get("email") or "").strip().lower()
                    if actual_email != config.required_account_email:
                        revoke_token(tokens.refresh_token, session=self._session)
                        raise DrivePermissionError(
                            f"Google Drive must be connected with the required owner account "
                            f"({config.required_account_email}), not {actual_email or 'unknown'}",
                            code="DRIVE_ACCOUNT_EMAIL_MISMATCH",
                            http_status=403,
                        )
                r_id, subs = store.ensure_directory_tree()
                q = store.quota_check(incoming_bytes=0)
                return acc, r_id, subs, q

            account, root_id, subfolders, quota = await asyncio.to_thread(_bootstrap_drive)
        except (DriveAuthError, DrivePermissionError, DriveQuotaExceededError, TrainingStorageError) as exc:
            raise _http_exception_from_storage_error(exc) from exc

        row = await self.repo.upsert_connected(
            account_email=account.get("email"),
            account_display_name=account.get("display_name"),
            oauth_scope=tokens.scope,
            encrypted_refresh_token=encrypted_token,
            token_key_fingerprint=fingerprint,
            root_folder_id=root_id,
            root_folder_path=DRIVE_ROOT_DISPLAY_PATH,
            subfolder_ids=subfolders,
            quota_limit_bytes=quota.limit_bytes,
            quota_usage_bytes=quota.usage_bytes,
            quota_usage_in_drive_bytes=quota.usage_in_drive_bytes,
            quota_usage_in_trash_bytes=quota.usage_in_trash_bytes,
            connected_by=actor_id,
        )
        _set_sync_google_drive_store_cache(store)
        row_with_token = {**row, "encrypted_refresh_token": encrypted_token}
        desktop_readiness = await _get_cached_desktop_readiness()
        return _serialize_connection_status(
            row_with_token,
            migration_applied=True,
            desktop_readiness=desktop_readiness,
        )

    async def connect_apps_script(
        self,
        *,
        actor_id: UUID,
        web_app_url: str,
        bridge_secret: str | None = None,
    ) -> dict[str, Any]:
        """Connect Flow 2 Google Drive via owner-deployed Apps Script Web App (0 card, no GCP billing)."""
        _, migration_applied = await self.repo.get_primary()
        await self._release_read_txn()
        if not migration_applied:
            raise HTTPException(
                status_code=503,
                detail="Apply migration 20261121210000_flow2_google_drive_storage.sql before connecting Google Drive",
            )
        enc_key = (os.getenv("VIREAD_GDRIVE_TOKEN_ENCRYPTION_KEY") or "").strip()
        if len(enc_key) < 32:
            raise HTTPException(
                status_code=503,
                detail="DRIVE_ENCRYPTION_KEY_MISSING: Server VIREAD_GDRIVE_TOKEN_ENCRYPTION_KEY must be >= 32 characters",
            )
        resolved_secret = (bridge_secret or "").strip() or (
            os.getenv("VIREAD_GDRIVE_APPS_SCRIPT_SECRET") or ""
        ).strip()
        required_email = (os.getenv("VIREAD_GDRIVE_REQUIRED_ACCOUNT_EMAIL") or "").strip().lower() or None

        try:
            clean_url = validate_apps_script_web_app_url(web_app_url)
            store = GoogleAppsScriptDriveStore(
                web_app_url=clean_url,
                bridge_secret=resolved_secret,
                session=self._session,
            )

            def _bootstrap_bridge() -> tuple[dict[str, str | None], str, dict[str, str], StorageQuotaStatus]:
                health = store.health_check()
                if not health.healthy or not health.root_folder_id:
                    code = health.error_code or "DRIVE_BRIDGE_ERROR"
                    http_status = 401 if code in {"DRIVE_AUTH_FAILED", "DRIVE_BRIDGE_SECRET_NOT_SET"} else (
                        403 if code in {"DRIVE_BRIDGE_ACCESS_DENIED", "DRIVE_PERMISSION_DENIED"} else 502
                    )
                    raise TrainingStorageError(
                        health.detail or "Failed to verify Google Apps Script Drive bridge",
                        code=code,
                        http_status=http_status,
                    )
                actual_email = (health.account_email or "").strip().lower()
                if required_email and actual_email != required_email:
                    raise DrivePermissionError(
                        f"Google Drive bridge must be deployed by the required owner account "
                        f"({required_email}), not {actual_email or 'unknown'}",
                        code="DRIVE_ACCOUNT_EMAIL_MISMATCH",
                        http_status=403,
                    )
                acc = {
                    "email": actual_email or None,
                    "display_name": (actual_email.split("@", 1)[0] if actual_email else None),
                }
                quota = health.quota or store.quota_check(incoming_bytes=0)
                return acc, health.root_folder_id, store.subfolder_ids, quota

            account, root_id, subfolders, quota = await asyncio.to_thread(_bootstrap_bridge)
        except (DriveAuthError, DrivePermissionError, DriveQuotaExceededError, TrainingStorageError) as exc:
            raise _http_exception_from_storage_error(exc) from exc

        cred_blob = json.dumps(
            {
                "kind": "apps_script_bridge",
                "web_app_url": clean_url,
                "bridge_secret": resolved_secret,
            },
            separators=(",", ":"),
            sort_keys=True,
        )
        encrypted_cred, fingerprint = encrypt_refresh_token(cred_blob, enc_key)
        row = await self.repo.upsert_connected(
            account_email=account.get("email"),
            account_display_name=account.get("display_name"),
            oauth_scope=APPS_SCRIPT_BRIDGE_SCOPE,
            encrypted_refresh_token=encrypted_cred,
            token_key_fingerprint=fingerprint,
            root_folder_id=root_id,
            root_folder_path=DRIVE_ROOT_DISPLAY_PATH,
            subfolder_ids=subfolders,
            quota_limit_bytes=quota.limit_bytes,
            quota_usage_bytes=quota.usage_bytes,
            quota_usage_in_drive_bytes=quota.usage_in_drive_bytes,
            quota_usage_in_trash_bytes=quota.usage_in_trash_bytes,
            connected_by=actor_id,
        )
        _set_sync_google_drive_store_cache(store)
        row_with_token = {**row, "encrypted_refresh_token": encrypted_cred}
        desktop_readiness = await _get_cached_desktop_readiness()
        return _serialize_connection_status(
            row_with_token,
            migration_applied=True,
            desktop_readiness=desktop_readiness,
        )

    async def connect_drive_desktop(
        self,
        *,
        actor_id: UUID,
        sync_root_path: str | None = None,
        account_email: str | None = None,
    ) -> dict[str, Any]:
        """Connect Flow 2 Google Drive via official Google Drive for Desktop synced mount (Advanced-Protection safe)."""
        _, migration_applied = await self.repo.get_primary()
        await self._release_read_txn()
        if not migration_applied:
            raise HTTPException(
                status_code=503,
                detail="Apply migration 20261121210000_flow2_google_drive_storage.sql before connecting Google Drive",
            )
        enc_key = (os.getenv("VIREAD_GDRIVE_TOKEN_ENCRYPTION_KEY") or "").strip()
        if len(enc_key) < 32:
            raise HTTPException(
                status_code=503,
                detail="DRIVE_ENCRYPTION_KEY_MISSING: Server VIREAD_GDRIVE_TOKEN_ENCRYPTION_KEY must be >= 32 characters",
            )
        required_email = (os.getenv("VIREAD_GDRIVE_REQUIRED_ACCOUNT_EMAIL") or "").strip().lower() or None

        try:
            def _prepare_and_bootstrap_desktop() -> tuple[Any, str | None, GoogleDriveDesktopStore, str, dict[str, str], StorageQuotaStatus]:
                detected = detect_google_drive_desktop_mounts()
                raw_path = (sync_root_path or "").strip()
                if not raw_path:
                    if detected:
                        raw_path = str(detected[0]["drive_root"])
                    else:
                        raise DriveNotConnectedError(
                            "Google Drive for Desktop mount was not auto-detected; install/sign into Google Drive for Desktop or configure a valid sync mount path"
                        )
                resolved_root = resolve_flow2_sync_root(raw_path)
                allowed_root = validate_flow2_sync_root_allowed(resolved_root, detected_mounts=detected)

                # Determine verified owner email from DriveFS metadata, explicit input, or server pinning
                detected_email = next(
                    (str(m.get("account_email") or "").strip().lower() for m in detected if m.get("account_email")),
                    None,
                )
                requested_email = (account_email or "").strip().lower() or None
                if required_email:
                    if detected_email and detected_email != required_email:
                        raise DrivePermissionError(
                            f"Google Drive for Desktop is signed in as {detected_email}, not required owner {required_email}",
                            code="DRIVE_ACCOUNT_EMAIL_MISMATCH",
                            http_status=403,
                        )
                    if requested_email and requested_email != required_email:
                        raise DrivePermissionError(
                            f"Google Drive must be connected with required owner account ({required_email}), not {requested_email}",
                            code="DRIVE_ACCOUNT_EMAIL_MISMATCH",
                            http_status=403,
                        )
                resolved_email = detected_email or requested_email or required_email

                desktop_store = GoogleDriveDesktopStore(root_dir=allowed_root, account_email=resolved_email)
                r_id, subs = desktop_store.ensure_directory_tree()
                health = desktop_store.health_check()
                if not health.healthy:
                    raise TrainingStorageError(
                        health.detail or "Google Drive for Desktop folder is not writable",
                        code=health.error_code or "DRIVE_DESKTOP_IO_ERROR",
                        http_status=503,
                    )
                q = health.quota or desktop_store.quota_check(incoming_bytes=0)
                return allowed_root, resolved_email, desktop_store, r_id, subs, q

            flow2_root, effective_email, store, root_id, subfolders, quota = await asyncio.to_thread(
                _prepare_and_bootstrap_desktop
            )
        except (DriveAuthError, DrivePermissionError, DriveQuotaExceededError, DriveNotConnectedError, TrainingStorageError) as exc:
            raise _http_exception_from_storage_error(exc) from exc
        except OSError as exc:
            logger.warning("Google Drive Desktop connect I/O failure: %s", exc)
            raise HTTPException(
                status_code=503,
                detail="DRIVE_DESKTOP_IO_ERROR: Google Drive for Desktop folder is not accessible",
            ) from exc

        cred_blob = json.dumps(
            {
                "kind": "drive_desktop_sync",
                "root_dir": str(flow2_root),
                "account_email": effective_email,
            },
            separators=(",", ":"),
            sort_keys=True,
        )
        encrypted_cred, fingerprint = encrypt_refresh_token(cred_blob, enc_key)
        row = await self.repo.upsert_connected(
            account_email=effective_email,
            account_display_name=effective_email.split("@", 1)[0] if effective_email else "Google Drive Desktop",
            oauth_scope=DRIVE_DESKTOP_SYNC_SCOPE,
            encrypted_refresh_token=encrypted_cred,
            token_key_fingerprint=fingerprint,
            root_folder_id=root_id,
            root_folder_path=DRIVE_ROOT_DISPLAY_PATH,
            subfolder_ids=subfolders,
            quota_limit_bytes=quota.limit_bytes,
            quota_usage_bytes=quota.usage_bytes,
            quota_usage_in_drive_bytes=quota.usage_in_drive_bytes,
            quota_usage_in_trash_bytes=quota.usage_in_trash_bytes,
            connected_by=actor_id,
        )
        _set_sync_google_drive_store_cache(store)
        invalidate_desktop_mount_probe_cache()
        row_with_token = {**row, "encrypted_refresh_token": encrypted_cred}
        desktop_readiness = await _get_cached_desktop_readiness()
        return _serialize_connection_status(
            row_with_token,
            migration_applied=True,
            desktop_readiness=desktop_readiness,
        )

    async def check_health(self) -> dict[str, Any]:
        row, migration_applied = await self.repo.get_primary()
        await self._release_read_txn()
        if not migration_applied or not row or row.get("status") == "DISCONNECTED":
            desktop_readiness = await _get_cached_desktop_readiness()
            return _serialize_connection_status(
                row,
                migration_applied=migration_applied,
                desktop_readiness=desktop_readiness,
            )
        try:
            store = await self._build_store_async(row)
        except TrainingStorageError as exc:
            updated = await self.repo.update_health_and_quota(
                status="ERROR",
                last_health_status="ERROR",
                last_error_code=exc.code,
            )
            invalidate_sync_google_drive_store_cache()
            merged = {**(row or {}), **(updated or {})}
            desktop_readiness = await _get_cached_desktop_readiness()
            return _serialize_connection_status(
                merged,
                migration_applied=True,
                desktop_readiness=desktop_readiness,
            )

        health = await asyncio.to_thread(store.health_check)
        quota = health.quota
        updated = await self.repo.update_health_and_quota(
            status=health.status,
            last_health_status="HEALTHY" if health.healthy else health.status,
            last_error_code=health.error_code,
            root_folder_id=health.root_folder_id,
            subfolder_ids=store.subfolder_ids if health.healthy else None,
            quota_limit_bytes=quota.limit_bytes if quota else None,
            quota_usage_bytes=quota.usage_bytes if quota else None,
            quota_usage_in_drive_bytes=quota.usage_in_drive_bytes if quota else None,
            quota_usage_in_trash_bytes=quota.usage_in_trash_bytes if quota else None,
            update_quota=quota is not None,
        )
        if health.healthy:
            _set_sync_google_drive_store_cache(store)
        else:
            invalidate_sync_google_drive_store_cache()
        merged = {**(row or {}), **(updated or {})}
        desktop_readiness = await _get_cached_desktop_readiness()
        payload = _serialize_connection_status(
            merged,
            migration_applied=True,
            desktop_readiness=desktop_readiness,
        )
        payload["health_detail"] = health.detail
        return payload

    async def run_self_test(self) -> dict[str, Any]:
        try:
            store = await self.get_connected_store()
            result = await asyncio.to_thread(store.self_test)
        except TrainingStorageError as exc:
            raise _http_exception_from_storage_error(exc) from exc
        except OSError as exc:
            logger.warning("Google Drive self-test I/O failure: %s", exc)
            raise HTTPException(
                status_code=503,
                detail="DRIVE_DESKTOP_IO_ERROR: Google Drive storage self-test failed",
            ) from exc

        if result.quota is not None:
            await self.repo.update_health_and_quota(
                status="CONNECTED",
                last_health_status="HEALTHY" if result.ok else "ERROR",
                last_error_code=None if result.ok else "DRIVE_SELFTEST_FAILED",
                root_folder_id=store.root_folder_id,
                subfolder_ids=store.subfolder_ids,
                quota_limit_bytes=result.quota.limit_bytes,
                quota_usage_bytes=result.quota.usage_bytes,
                quota_usage_in_drive_bytes=result.quota.usage_in_drive_bytes,
                quota_usage_in_trash_bytes=result.quota.usage_in_trash_bytes,
                update_quota=True,
            )
        return {
            "ok": result.ok,
            "logical_path": result.logical_path,
            "drive_file_id": result.drive_file_id,
            "sha256": result.sha256,
            "size_bytes": result.size_bytes,
            "deleted_after_test": result.deleted_after_test,
            "is_private": result.is_private,
            "quota": _quota_status_to_dict(result.quota),
            "detail": result.detail,
        }

    async def disconnect(self) -> dict[str, Any]:
        row, migration_applied = await self.repo.get_primary()
        await self._release_read_txn()
        if not migration_applied:
            desktop_readiness = await _get_cached_desktop_readiness()
            return _serialize_connection_status(
                None,
                migration_applied=False,
                desktop_readiness=desktop_readiness,
            )
        revoked = False
        if (
            row
            and row.get("encrypted_refresh_token")
            and str(row.get("oauth_scope") or "").strip() not in {APPS_SCRIPT_BRIDGE_SCOPE, DRIVE_DESKTOP_SYNC_SCOPE}
        ):
            enc_key = (os.getenv("VIREAD_GDRIVE_TOKEN_ENCRYPTION_KEY") or "").strip()
            if enc_key:
                try:
                    raw_refresh = decrypt_refresh_token(str(row["encrypted_refresh_token"]), enc_key)
                    revoked = await asyncio.to_thread(revoke_token, raw_refresh, session=self._session)
                except Exception:
                    revoked = False
        updated = await self.repo.mark_disconnected()
        invalidate_sync_google_drive_store_cache()
        desktop_readiness = await _get_cached_desktop_readiness()
        payload = _serialize_connection_status(
            updated,
            migration_applied=True,
            desktop_readiness=desktop_readiness,
        )
        payload["google_token_revoked"] = revoked
        return payload

    async def list_job_resume_files(self, job_id: UUID) -> dict[str, Any]:
        try:
            store = await self.get_connected_store()
            files = await asyncio.to_thread(store.list_resume_files, str(job_id))
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc
        except TrainingStorageError as exc:
            raise _http_exception_from_storage_error(exc) from exc
        return {"job_id": str(job_id), "files": files}

    async def put_job_resume_file(
        self,
        job_id: UUID,
        relative_path: str,
        payload: bytes,
        *,
        expected_sha256: str | None = None,
    ) -> dict[str, Any]:
        try:
            store = await self.get_connected_store()
            stored = await asyncio.to_thread(
                store.put_resume_file,
                str(job_id),
                relative_path,
                payload,
                content_type="application/json" if relative_path.endswith(".json") else "application/octet-stream",
                expected_sha256=expected_sha256,
            )
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc
        except TrainingStorageError as exc:
            raise _http_exception_from_storage_error(exc) from exc
        return {
            "job_id": str(job_id),
            "name": relative_path.strip().strip("/"),
            "drive_file_id": stored.drive_file_id,
            "sha256": stored.sha256,
            "size_bytes": stored.size_bytes,
            "deduplicated": stored.deduplicated,
        }

    async def open_job_resume_stream(self, job_id: UUID, relative_path: str):
        try:
            store = await self.get_connected_store()
            meta, stream = await asyncio.to_thread(
                store.open_resume_file_stream,
                str(job_id),
                relative_path,
            )
            return meta, stream
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc
        except TrainingStorageError as exc:
            raise _http_exception_from_storage_error(exc) from exc

    async def delete_job_resume_file(self, job_id: UUID, relative_path: str) -> dict[str, Any]:
        try:
            store = await self.get_connected_store()
            deleted = await asyncio.to_thread(store.delete_resume_file, str(job_id), relative_path)
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc
        except TrainingStorageError as exc:
            raise _http_exception_from_storage_error(exc) from exc
        return {"job_id": str(job_id), "name": relative_path.strip().strip("/"), "deleted": deleted}
