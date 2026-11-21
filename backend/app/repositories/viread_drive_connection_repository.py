from __future__ import annotations

import json
from typing import Any
from uuid import UUID

from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

PRIMARY_CONNECTION_KEY = "flow2_primary"


def _is_missing_relation_error(exc: Exception) -> bool:
    message = str(exc).lower()
    return (
        "viread_ocr_drive_connections" in message
        and ("does not exist" in message or "undefinedtable" in message or "no such table" in message)
    )


class VireadDriveConnectionRepository:
    """SQL-only persistence for server-managed Flow 2 Google Drive OAuth connections."""

    def __init__(self, db: AsyncSession) -> None:
        self.db = db

    async def get_primary(self) -> tuple[dict[str, Any] | None, bool]:
        """Return (row_dict_or_none, table_exists)."""
        try:
            result = await self.db.execute(
                text(
                    """
                    SELECT id, connection_key, status, account_email, account_display_name,
                           oauth_scope, encrypted_refresh_token, token_key_fingerprint,
                           root_folder_id, root_folder_path, subfolder_ids,
                           quota_limit_bytes, quota_usage_bytes, quota_usage_in_drive_bytes,
                           quota_usage_in_trash_bytes, quota_checked_at,
                           last_health_check_at, last_health_status, last_error_code,
                           connected_by, connected_at, disconnected_at, created_at, updated_at
                    FROM public.viread_ocr_drive_connections
                    WHERE connection_key = :connection_key
                    LIMIT 1
                    """
                ),
                {"connection_key": PRIMARY_CONNECTION_KEY},
            )
            row = result.mappings().first()
            return (dict(row) if row else None), True
        except Exception as exc:
            if _is_missing_relation_error(exc):
                try:
                    await self.db.rollback()
                except Exception:
                    pass
                return None, False
            raise

    async def upsert_connected(
        self,
        *,
        account_email: str | None,
        account_display_name: str | None,
        oauth_scope: str,
        encrypted_refresh_token: str,
        token_key_fingerprint: str,
        root_folder_id: str,
        root_folder_path: str,
        subfolder_ids: dict[str, str],
        quota_limit_bytes: int | None,
        quota_usage_bytes: int | None,
        quota_usage_in_drive_bytes: int | None,
        quota_usage_in_trash_bytes: int | None,
        connected_by: UUID,
    ) -> dict[str, Any]:
        result = await self.db.execute(
            text(
                """
                INSERT INTO public.viread_ocr_drive_connections (
                    connection_key, status, account_email, account_display_name,
                    oauth_scope, encrypted_refresh_token, token_key_fingerprint,
                    root_folder_id, root_folder_path, subfolder_ids,
                    quota_limit_bytes, quota_usage_bytes, quota_usage_in_drive_bytes,
                    quota_usage_in_trash_bytes, quota_checked_at,
                    last_health_check_at, last_health_status, last_error_code,
                    connected_by, connected_at, disconnected_at, updated_at
                )
                VALUES (
                    :connection_key, 'CONNECTED', :account_email, :account_display_name,
                    :oauth_scope, :encrypted_refresh_token, :token_key_fingerprint,
                    :root_folder_id, :root_folder_path, CAST(:subfolder_ids AS jsonb),
                    :quota_limit_bytes, :quota_usage_bytes, :quota_usage_in_drive_bytes,
                    :quota_usage_in_trash_bytes, now(),
                    now(), 'HEALTHY', NULL,
                    :connected_by, now(), NULL, now()
                )
                ON CONFLICT (connection_key) DO UPDATE SET
                    status = 'CONNECTED',
                    account_email = EXCLUDED.account_email,
                    account_display_name = EXCLUDED.account_display_name,
                    oauth_scope = EXCLUDED.oauth_scope,
                    encrypted_refresh_token = EXCLUDED.encrypted_refresh_token,
                    token_key_fingerprint = EXCLUDED.token_key_fingerprint,
                    root_folder_id = EXCLUDED.root_folder_id,
                    root_folder_path = EXCLUDED.root_folder_path,
                    subfolder_ids = EXCLUDED.subfolder_ids,
                    quota_limit_bytes = EXCLUDED.quota_limit_bytes,
                    quota_usage_bytes = EXCLUDED.quota_usage_bytes,
                    quota_usage_in_drive_bytes = EXCLUDED.quota_usage_in_drive_bytes,
                    quota_usage_in_trash_bytes = EXCLUDED.quota_usage_in_trash_bytes,
                    quota_checked_at = now(),
                    last_health_check_at = now(),
                    last_health_status = 'HEALTHY',
                    last_error_code = NULL,
                    connected_by = EXCLUDED.connected_by,
                    connected_at = now(),
                    disconnected_at = NULL,
                    updated_at = now()
                RETURNING id, connection_key, status, account_email, account_display_name,
                          oauth_scope, root_folder_id, root_folder_path, subfolder_ids,
                          quota_limit_bytes, quota_usage_bytes, quota_usage_in_drive_bytes,
                          quota_usage_in_trash_bytes, quota_checked_at,
                          last_health_check_at, last_health_status, last_error_code,
                          connected_by, connected_at, disconnected_at, created_at, updated_at
                """
            ),
            {
                "connection_key": PRIMARY_CONNECTION_KEY,
                "account_email": account_email,
                "account_display_name": account_display_name,
                "oauth_scope": oauth_scope,
                "encrypted_refresh_token": encrypted_refresh_token,
                "token_key_fingerprint": token_key_fingerprint,
                "root_folder_id": root_folder_id,
                "root_folder_path": root_folder_path,
                "subfolder_ids": json.dumps(subfolder_ids, sort_keys=True),
                "quota_limit_bytes": quota_limit_bytes,
                "quota_usage_bytes": quota_usage_bytes,
                "quota_usage_in_drive_bytes": quota_usage_in_drive_bytes,
                "quota_usage_in_trash_bytes": quota_usage_in_trash_bytes,
                "connected_by": connected_by,
            },
        )
        row = result.mappings().first()
        await self.db.commit()
        return dict(row) if row else {}

    async def update_health_and_quota(
        self,
        *,
        status: str,
        last_health_status: str,
        last_error_code: str | None,
        root_folder_id: str | None = None,
        subfolder_ids: dict[str, str] | None = None,
        quota_limit_bytes: int | None = None,
        quota_usage_bytes: int | None = None,
        quota_usage_in_drive_bytes: int | None = None,
        quota_usage_in_trash_bytes: int | None = None,
        update_quota: bool = False,
    ) -> dict[str, Any] | None:
        result = await self.db.execute(
            text(
                """
                UPDATE public.viread_ocr_drive_connections
                SET status = :status,
                    last_health_check_at = now(),
                    last_health_status = :last_health_status,
                    last_error_code = :last_error_code,
                    root_folder_id = COALESCE(:root_folder_id, root_folder_id),
                    subfolder_ids = COALESCE(CAST(:subfolder_ids AS jsonb), subfolder_ids),
                    quota_limit_bytes = CASE WHEN :update_quota THEN :quota_limit_bytes ELSE quota_limit_bytes END,
                    quota_usage_bytes = CASE WHEN :update_quota THEN :quota_usage_bytes ELSE quota_usage_bytes END,
                    quota_usage_in_drive_bytes = CASE WHEN :update_quota THEN :quota_usage_in_drive_bytes ELSE quota_usage_in_drive_bytes END,
                    quota_usage_in_trash_bytes = CASE WHEN :update_quota THEN :quota_usage_in_trash_bytes ELSE quota_usage_in_trash_bytes END,
                    quota_checked_at = CASE WHEN :update_quota THEN now() ELSE quota_checked_at END,
                    updated_at = now()
                WHERE connection_key = :connection_key
                RETURNING id, connection_key, status, account_email, account_display_name,
                          oauth_scope, root_folder_id, root_folder_path, subfolder_ids,
                          quota_limit_bytes, quota_usage_bytes, quota_usage_in_drive_bytes,
                          quota_usage_in_trash_bytes, quota_checked_at,
                          last_health_check_at, last_health_status, last_error_code,
                          connected_by, connected_at, disconnected_at, created_at, updated_at
                """
            ),
            {
                "connection_key": PRIMARY_CONNECTION_KEY,
                "status": status,
                "last_health_status": last_health_status,
                "last_error_code": last_error_code,
                "root_folder_id": root_folder_id,
                "subfolder_ids": json.dumps(subfolder_ids, sort_keys=True) if subfolder_ids is not None else None,
                "update_quota": update_quota,
                "quota_limit_bytes": quota_limit_bytes,
                "quota_usage_bytes": quota_usage_bytes,
                "quota_usage_in_drive_bytes": quota_usage_in_drive_bytes,
                "quota_usage_in_trash_bytes": quota_usage_in_trash_bytes,
            },
        )
        row = result.mappings().first()
        await self.db.commit()
        return dict(row) if row else None

    async def mark_disconnected(self) -> dict[str, Any] | None:
        result = await self.db.execute(
            text(
                """
                UPDATE public.viread_ocr_drive_connections
                SET status = 'DISCONNECTED',
                    encrypted_refresh_token = NULL,
                    token_key_fingerprint = NULL,
                    last_health_status = 'DISCONNECTED',
                    last_error_code = NULL,
                    disconnected_at = now(),
                    updated_at = now()
                WHERE connection_key = :connection_key
                RETURNING id, connection_key, status, account_email, account_display_name,
                          oauth_scope, root_folder_id, root_folder_path, subfolder_ids,
                          quota_limit_bytes, quota_usage_bytes, quota_usage_in_drive_bytes,
                          quota_usage_in_trash_bytes, quota_checked_at,
                          last_health_check_at, last_health_status, last_error_code,
                          connected_by, connected_at, disconnected_at, created_at, updated_at
                """
            ),
            {"connection_key": PRIMARY_CONNECTION_KEY},
        )
        row = result.mappings().first()
        await self.db.commit()
        return dict(row) if row else None
