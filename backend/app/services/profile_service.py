"""Business orchestration for the authenticated user's profile."""

import logging
from typing import Any
from uuid import UUID

from app.providers.supabase_auth_contact_provider import SupabaseAuthContactProvider
from app.repositories.profile_repository import ProfileRepository

logger = logging.getLogger(__name__)

CONTACT_INFO_STATUSES = {
    "available",
    "not_configured",
    "user_not_found",
    "lookup_failed",
}


class ProfileNotFoundError(Exception):
    """Raised when an authenticated user's profile does not exist."""


class ProfileAccessDeniedError(Exception):
    """Raised when a non-admin attempts a legacy all-profile operation."""


class ProfileService:
    """Combine the PostgreSQL profile projection with safe Supabase Auth fields."""

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

    async def get_current_profile(self, parent_id: UUID) -> dict[str, Any]:
        profile = await self.repository.get_by_id(parent_id)
        if profile is None:
            raise ProfileNotFoundError()

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
        phone_value = contact.get("phone")
        email = email_value.strip() or None if isinstance(email_value, str) else None
        phone = phone_value.strip() or None if isinstance(phone_value, str) else None

        email_verified_value = contact.get("email_verified")
        phone_verified_value = contact.get("phone_verified")
        email_verified = (
            email_verified_value
            if isinstance(email_verified_value, bool) and status_value == "available"
            else None
        )
        phone_verified = (
            phone_verified_value
            if isinstance(phone_verified_value, bool) and status_value == "available"
            else None
        )

        children = sorted(
            profile.children,
            key=lambda child: (child.CreatedAt, str(child.Id)),
            reverse=True,
        )

        return {
            "id": profile.Id,
            "display_name": profile.DisplayName,
            "role": profile.Role,
            "created_at": profile.CreatedAt,
            "email": email,
            "phone": phone,
            "email_verified": email_verified,
            "phone_verified": phone_verified,
            "contact_info_status": status_value,
            # Deliberately expose only a small display-safe child summary.
            # Settings JSON and reading/event data stay out of the profile response.
            "children": [
                {
                    "id": child.Id,
                    "alias": child.Alias,
                    "grade": child.Grade,
                    "created_at": child.CreatedAt,
                }
                for child in children
            ],
        }
