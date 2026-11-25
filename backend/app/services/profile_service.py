"""Business orchestration for the authenticated user's profile."""

import asyncio
from datetime import timezone
import logging
from typing import Any
from uuid import UUID

from app.database.config import SUPABASE_AVATAR_BUCKET
from app.providers.supabase_auth_contact_provider import SupabaseAuthContactProvider
from app.repositories.profile_repository import ProfileRepository
from app.services.storage_service import (
    create_cached_signed_image_urls,
    create_signed_image_url,
)

logger = logging.getLogger(__name__)

CONTACT_INFO_STATUSES = {
    "available",
    "not_configured",
    "user_not_found",
    "lookup_failed",
}


class ProfileNotFoundError(Exception):
    """Raised when the requested profile does not exist."""


class ProfileAccessDeniedError(Exception):
    """Raised when an actor does not have permission for a profile operation."""


def _validate_safe_avatar_path(path: object, expected_prefix: str) -> str | None:
    if not isinstance(path, str) or not path:
        return None
    if (
        not path.startswith(expected_prefix)
        or ".." in path
        or path.startswith(("http://", "https://"))
    ):
        return None
    return path


def _safe_avatar_url(path: object, expected_prefix: str) -> str | None:
    safe_path = _validate_safe_avatar_path(path, expected_prefix)
    if safe_path is None:
        return None
    return create_signed_image_url(safe_path, bucket_name=SUPABASE_AVATAR_BUCKET)


async def batch_sign_avatar_paths(paths: list[str]) -> dict[str, str]:
    """Batch-sign validated avatar paths via 20m TTL cache without blocking the event loop."""
    unique_paths = list(dict.fromkeys(p for p in paths if p))
    if not unique_paths:
        return {}
    signed = await asyncio.to_thread(
        create_cached_signed_image_urls,
        unique_paths,
        bucket_name=SUPABASE_AVATAR_BUCKET,
    )
    return dict(zip(unique_paths, signed))


def _ensure_active_profile(profile: Any) -> None:
    active_val = getattr(profile, "Active", 1)
    if active_val == 0 or active_val is False:
        raise ProfileAccessDeniedError()


class ProfileService:
    """Apply profile authorization and coordinate PostgreSQL with Supabase Auth."""

    def __init__(
        self,
        repository: ProfileRepository,
        auth_contact_provider: SupabaseAuthContactProvider | None = None,
    ):
        self.repository = repository
        self.auth_contact_provider = (
            auth_contact_provider or SupabaseAuthContactProvider()
        )

    async def require_admin(self, actor_id: UUID) -> None:
        """Allow legacy all-profile operations only for authenticated Admin users."""
        if await self.repository.get_role(actor_id) != "admin":
            raise ProfileAccessDeniedError()

    async def list_profiles_for_admin(self, actor_id: UUID):
        await self.require_admin(actor_id)
        return await self.repository.list_all_profiles()

    async def create_profile_for_admin(
        self,
        actor_id: UUID,
        role: str,
        display_name: str | None,
    ):
        await self.require_admin(actor_id)
        return await self.repository.create_profile(role, display_name)

    async def get_profile_for_owner(
        self,
        actor_id: UUID,
        profile_id: UUID,
    ):
        if actor_id != profile_id:
            raise ProfileAccessDeniedError()
        profile = await self.repository.get_by_id(profile_id)
        if profile is None:
            raise ProfileNotFoundError()
        _ensure_active_profile(profile)
        return profile

    async def update_profile_for_owner(
        self,
        actor_id: UUID,
        profile_id: UUID,
        display_name: str,
    ):
        if actor_id != profile_id:
            raise ProfileAccessDeniedError()
        existing = await self.repository.get_by_id(profile_id)
        if existing is None:
            raise ProfileNotFoundError()
        _ensure_active_profile(existing)
        profile = await self.repository.update_display_name(
            profile_id,
            display_name,
        )
        if profile is None:
            raise ProfileNotFoundError()
        return profile

    async def delete_profile_for_admin(
        self,
        actor_id: UUID,
        profile_id: UUID,
    ) -> None:
        await self.require_admin(actor_id)
        deleted = await self.repository.delete_by_id(profile_id)
        if not deleted:
            raise ProfileNotFoundError()

    async def update_contact_phone_for_owner(
        self,
        parent_id: UUID,
        contact_phone: str | None,
    ) -> dict[str, Any]:
        """Update the authenticated profile's contact number without Auth OTP."""
        existing = await self.repository.get_by_id(parent_id)
        if existing is None:
            raise ProfileNotFoundError()
        _ensure_active_profile(existing)
        profile = await self.repository.update_contact_phone(
            parent_id,
            contact_phone,
        )
        if profile is None:
            raise ProfileNotFoundError()
        return await self.get_current_profile(parent_id)

    async def get_current_profile(self, parent_id: UUID) -> dict[str, Any]:
        profile = await self.repository.get_by_id(parent_id)
        if profile is None:
            raise ProfileNotFoundError()
        _ensure_active_profile(profile)

        try:
            contact = await self.auth_contact_provider.get_contact_info(parent_id)
        except Exception as error:
            # Never log provider messages because they may include private values.
            logger.warning(
                "Profile contact lookup failed (exception_type=%s)",
                type(error).__name__,
            )
            contact = {
                "email": None,
                "phone": None,
                "email_verified": None,
                "phone_verified": None,
                "contact_info_status": "lookup_failed",
            }

        status_value = contact.get("contact_info_status")
        if status_value not in CONTACT_INFO_STATUSES:
            status_value = "lookup_failed"

        email_value = contact.get("email")
        email = email_value.strip() or None if isinstance(email_value, str) else None
        contact_phone_value = getattr(profile, "ContactPhone", None)
        contact_phone = (
            contact_phone_value.strip() or None
            if isinstance(contact_phone_value, str)
            else None
        )
        pending_email_value = contact.get("pending_email")
        pending_email = (
            pending_email_value.strip() or None
            if isinstance(pending_email_value, str)
            else None
        )

        email_verified_value = contact.get("email_verified")
        email_verified = (
            email_verified_value
            if isinstance(email_verified_value, bool) and status_value == "available"
            else None
        )

        children = sorted(
            profile.children,
            key=lambda child: (child.CreatedAt, str(child.Id)),
            reverse=True,
        )
        parent_avatar_path = _validate_safe_avatar_path(
            getattr(profile, "AvatarPath", None),
            f"profiles/{profile.Id}/avatar/",
        )
        child_avatar_paths = {
            child.Id: _validate_safe_avatar_path(
                getattr(child, "AvatarPath", None),
                f"children/{child.Id}/avatar/",
            )
            for child in children
        }
        paths_to_sign = [
            p
            for p in [parent_avatar_path, *child_avatar_paths.values()]
            if p is not None
        ]
        signed_map = await batch_sign_avatar_paths(paths_to_sign)

        return {
            "id": profile.Id,
            "display_name": profile.DisplayName,
            "role": profile.Role,
            "created_at": profile.CreatedAt,
            "email": email,
            "contact_phone": contact_phone,
            "pending_email": pending_email,
            "email_verified": email_verified,
            "contact_info_status": status_value,
            "avatar_url": signed_map.get(parent_avatar_path) if parent_avatar_path else None,
            # Deliberately expose only a small display-safe child summary.
            # Settings JSON and reading/event data stay out of the profile response.
            "children": [
                {
                    "id": child.Id,
                    "alias": child.Alias,
                    "grade": child.Grade,
                    "created_at": child.CreatedAt,
                    "avatar_url": (
                        signed_map.get(child_avatar_paths[child.Id])
                        if child_avatar_paths[child.Id]
                        else None
                    ),
                }
                for child in children
            ],
        }

    @staticmethod
    def _serialize_latest_session(session: Any, book_title: str) -> dict[str, Any]:
        started_at = session.StartedAt
        ended_at = session.EndedAt
        duration_ms = None
        if ended_at is not None and started_at is not None:
            start_utc = (
                started_at
                if started_at.tzinfo is not None
                else started_at.replace(tzinfo=timezone.utc)
            )
            end_utc = (
                ended_at
                if ended_at.tzinfo is not None
                else ended_at.replace(tzinfo=timezone.utc)
            )
            duration_ms = max(0, int((end_utc - start_utc).total_seconds() * 1000))

        raw_state = str(session.State or "")
        if raw_state in ("FINISHED", "COMPLETED"):
            wire_state = "FINISHED"
        elif raw_state in (
            "CREATED",
            "PAGE_READY",
            "LISTENING",
            "PAUSED",
            "RECONNECTING",
            "QUESTIONING",
            "ABORTED",
        ):
            wire_state = raw_state
        else:
            wire_state = "PAGE_READY"

        resumable = ended_at is None and wire_state not in ("FINISHED", "ABORTED")
        return {
            "session_id": session.Id,
            "child_id": session.ChildId,
            "book_id": session.BookId,
            "book_title": book_title,
            "state": wire_state,
            "started_at": started_at,
            "ended_at": ended_at,
            "duration_ms": duration_ms,
            "resumable": resumable,
        }

    async def get_dashboard_summary(self, parent_id: UUID) -> dict[str, Any]:
        """Consolidated dashboard read: minimal SQL queries, zero Auth Admin HTTP, batched signed URLs."""
        profile = await self.repository.get_by_id(parent_id)
        if profile is None:
            raise ProfileNotFoundError()
        _ensure_active_profile(profile)

        children = sorted(
            profile.children,
            key=lambda child: (child.CreatedAt, str(child.Id)),
            reverse=True,
        )
        child_ids = [child.Id for child in children]
        latest_rows = (
            await self.repository.get_latest_sessions_by_child_ids(parent_id, child_ids)
            if child_ids
            else []
        )

        # Snapshot ORM attributes before closing read transaction prior to Storage signing.
        contact_phone_value = getattr(profile, "ContactPhone", None)
        contact_phone = (
            contact_phone_value.strip() or None
            if isinstance(contact_phone_value, str)
            else None
        )
        profile_snapshot = {
            "id": profile.Id,
            "display_name": profile.DisplayName,
            "role": profile.Role,
            "created_at": profile.CreatedAt,
            "contact_phone": contact_phone,
        }
        parent_avatar_path = _validate_safe_avatar_path(
            getattr(profile, "AvatarPath", None),
            f"profiles/{profile.Id}/avatar/",
        )
        child_snapshots = [
            {
                "id": child.Id,
                "parent_id": getattr(child, "ParentId", profile.Id),
                "alias": child.Alias,
                "grade": child.Grade,
                "settings": dict(getattr(child, "Settings", None) or {}),
                "created_at": child.CreatedAt,
                "avatar_path": _validate_safe_avatar_path(
                    getattr(child, "AvatarPath", None),
                    f"children/{child.Id}/avatar/",
                ),
            }
            for child in children
        ]
        latest_by_child = {
            str(session.ChildId): self._serialize_latest_session(session, book_title)
            for session, book_title in latest_rows
        }

        repo_db = getattr(self.repository, "db", None)
        if repo_db is not None and callable(getattr(repo_db, "rollback", None)):
            try:
                await repo_db.rollback()
            except Exception:
                pass

        paths_to_sign = [
            p
            for p in [
                parent_avatar_path,
                *(c["avatar_path"] for c in child_snapshots),
            ]
            if p is not None
        ]
        signed_map = await batch_sign_avatar_paths(paths_to_sign)

        return {
            "profile": {
                **profile_snapshot,
                "avatar_url": signed_map.get(parent_avatar_path) if parent_avatar_path else None,
            },
            "children": [
                {
                    "id": c["id"],
                    "parent_id": c["parent_id"],
                    "alias": c["alias"],
                    "grade": c["grade"],
                    "settings": c["settings"],
                    "created_at": c["created_at"],
                    "avatar_url": (
                        signed_map.get(c["avatar_path"]) if c["avatar_path"] else None
                    ),
                }
                for c in child_snapshots
            ],
            "latest_sessions_by_child": latest_by_child,
        }
