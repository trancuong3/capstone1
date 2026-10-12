"""Business orchestration for Admin parent list and detail use cases."""
from dataclasses import dataclass
from datetime import datetime
from typing import Any
from uuid import UUID

from app.providers.supabase_auth_contact_provider import (
    ContactInfoStatus,
    SupabaseAuthContactProvider,
)
from app.repositories.admin_parent_repository import AdminParentRepository


class AdminParentAccessDeniedError(Exception):
    """Raised when the authenticated actor is not an Admin."""


class AdminParentNotFoundError(Exception):
    """Raised when the requested record is not a Parent profile."""


@dataclass(frozen=True)
class AdminParentListResult:
    """Application result; API response schemas are owned by the Router layer."""

    items: list[dict[str, Any]]
    total: int
    limit: int
    offset: int


@dataclass(frozen=True)
class AdminParentDetailResult:
    """Application result for one Parent and its linked children."""

    id: UUID
    display_name: str | None
    created_at: datetime
    children: list[dict[str, Any]]
    email: str | None
    phone: str | None
    contact_info_status: ContactInfoStatus


class AdminParentService:
    """Coordinates authorization, PostgreSQL reads, and Auth contact lookup."""

    def __init__(
        self,
        repository: AdminParentRepository,
        auth_contact_provider: SupabaseAuthContactProvider | None = None,
    ):
        self.repository = repository
        self.auth_contact_provider = (
            auth_contact_provider or SupabaseAuthContactProvider()
        )

    async def _ensure_admin(self, actor_id: UUID) -> None:
        if await self.repository.role(actor_id) != "admin":
            raise AdminParentAccessDeniedError(
                "Admin access is required for parent directory operations."
            )

    async def list_parents(
        self,
        actor_id: UUID,
        search: str | None,
        limit: int,
        offset: int,
    ) -> AdminParentListResult:
        await self._ensure_admin(actor_id)
        items, total = await self.repository.list_parent_rows(
            search=search,
            limit=limit,
            offset=offset,
        )
        return AdminParentListResult(
            items=items,
            total=total,
            limit=limit,
            offset=offset,
        )

    async def get_parent_detail(
        self,
        actor_id: UUID,
        parent_id: UUID,
    ) -> AdminParentDetailResult:
        await self._ensure_admin(actor_id)

        parent = await self.repository.get_parent_detail(parent_id)
        if parent is None:
            raise AdminParentNotFoundError("Parent profile was not found.")

        # Auth is an external dependency. Keep database-backed detail available
        # even if contact lookup unexpectedly raises an exception.
        try:
            contact = await self.auth_contact_provider.get_contact_info(parent_id)
        except Exception:
            contact = {
                "email": None,
                "phone": None,
                "contact_info_status": "lookup_failed",
            }

        email_value = contact.get("email") if isinstance(contact, dict) else None
        phone_value = contact.get("phone") if isinstance(contact, dict) else None
        status_value = (
            contact.get("contact_info_status")
            if isinstance(contact, dict)
            else None
        )
        valid_statuses = {
            "available",
            "not_configured",
            "user_not_found",
            "lookup_failed",
        }
        if status_value not in valid_statuses:
            status_value = "lookup_failed"

        email = (
            email_value.strip() or None
            if isinstance(email_value, str)
            else None
        )
        phone = (
            phone_value.strip() or None
            if isinstance(phone_value, str)
            else None
        )

        return AdminParentDetailResult(
            id=parent["id"],
            display_name=parent.get("display_name"),
            created_at=parent["created_at"],
            children=parent["children"],
            email=email,
            phone=phone,
            contact_info_status=status_value,
        )
