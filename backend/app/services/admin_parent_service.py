"""Business orchestration for Admin Parent CRUD.

HTTP and API response schemas deliberately remain outside this service.
"""
from dataclasses import dataclass
from datetime import datetime
from typing import Any
from uuid import UUID

from app.providers.supabase_auth_contact_provider import (
    ContactInfoStatus,
    SupabaseAuthContactProvider,
    SupabaseAuthConflictError,
    SupabaseAuthCompensationError,
    SupabaseAuthProviderError,
    SupabaseAuthProviderNotConfiguredError,
)
from app.repositories.admin_parent_repository import AdminParentRepository


class AdminParentAccessDeniedError(Exception):
    """Raised when the authenticated actor is not an Admin."""


class AdminParentNotFoundError(Exception):
    """Raised when the requested record is not a visible Parent profile."""


class AdminParentConflictError(Exception):
    """Raised when an operation conflicts with an existing account."""


class AdminParentProviderUnavailableError(Exception):
    """Raised when the Auth provider is not configured."""


class AdminParentProviderOperationError(Exception):
    """Raised when the Auth provider operation fails."""


class AdminParentConsistencyError(Exception):
    """Raised when PostgreSQL and Supabase Auth cannot be kept consistent."""


@dataclass(frozen=True)
class AdminParentListResult:
    items: list[dict[str, Any]]
    total: int
    limit: int
    offset: int


@dataclass(frozen=True)
class AdminParentDetailResult:
    id: UUID
    display_name: str | None
    created_at: datetime
    children: list[dict[str, Any]]
    email: str | None
    phone: str | None
    contact_info_status: ContactInfoStatus



class AdminParentService:
    def __init__(
        self,
        repository: AdminParentRepository,
        auth_contact_provider: SupabaseAuthContactProvider | None = None,
    ):
        self.repository = repository
        self.auth_contact_provider = auth_contact_provider or SupabaseAuthContactProvider()

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
        return AdminParentListResult(items=items, total=total, limit=limit, offset=offset)

    async def get_parent_detail(
        self,
        actor_id: UUID,
        parent_id: UUID,
    ) -> AdminParentDetailResult:
        await self._ensure_admin(actor_id)
        parent = await self.repository.get_parent_detail(parent_id)
        if parent is None:
            raise AdminParentNotFoundError("Parent profile was not found.")

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
        status_value = contact.get("contact_info_status") if isinstance(contact, dict) else None
        valid_statuses = {"available", "not_configured", "user_not_found", "lookup_failed"}
        if status_value not in valid_statuses:
            status_value = "lookup_failed"

        email = email_value.strip() or None if isinstance(email_value, str) else None
        phone = phone_value.strip() or None if isinstance(phone_value, str) else None

        return AdminParentDetailResult(
            id=parent["id"],
            display_name=parent.get("display_name"),
            created_at=parent["created_at"],
            children=parent["children"],
            email=email,
            phone=phone,
            contact_info_status=status_value,
        )

    async def _compensate_failed_invite(self, parent_id: UUID) -> None:
        """Remove only the Auth identity created by this failed Create operation."""
        try:
            await self.auth_contact_provider.compensate_failed_invite(parent_id)
        except Exception as error:
            raise AdminParentConsistencyError(
                "Parent invitation failed to synchronize; manual reconciliation is required."
            ) from error

    async def create_parent(
        self,
        actor_id: UUID,
        display_name: str,
        email: str,
        phone: str | None = None,
    ) -> AdminParentDetailResult:
        await self._ensure_admin(actor_id)
        normalized_name = display_name.strip()
        normalized_email = email.strip().lower()
        normalized_phone = phone.strip() if isinstance(phone, str) and phone.strip() else None
        if not normalized_name or not normalized_email:
            raise ValueError("Display name and email are required.")

        try:
            parent_id = await self.auth_contact_provider.invite_parent(
                normalized_email, normalized_name, normalized_phone
            )
        except SupabaseAuthProviderNotConfiguredError as error:
            raise AdminParentProviderUnavailableError() from error
        except SupabaseAuthConflictError as error:
            raise AdminParentConflictError("A user with this email already exists.") from error
        except SupabaseAuthCompensationError as error:
            raise AdminParentConsistencyError(
                "The invitation operation failed and Auth cleanup also failed."
            ) from error
        except SupabaseAuthProviderError as error:
            raise AdminParentProviderOperationError() from error

        # The Auth trigger in the existing migration creates public.profiles with
        # role='parent'. Never insert a second profile from this service.
        try:
            parent = await self.repository.get_parent_detail(parent_id)
        except Exception as error:
            await self._compensate_failed_invite(parent_id)
            raise AdminParentConsistencyError(
                "The Auth invite could not be verified against PostgreSQL."
            ) from error
        if parent is None:
            await self._compensate_failed_invite(parent_id)
            raise AdminParentConsistencyError(
                "The Auth invite did not produce a linked Parent profile."
            )

        return await self.get_parent_detail(actor_id, parent_id)

    async def update_parent(
        self,
        actor_id: UUID,
        parent_id: UUID,
        *,
        display_name: str | None = None,
        update_display_name: bool = False,
        email: str | None = None,
        update_email: bool = False,
        phone: str | None = None,
        update_phone: bool = False,
    ) -> AdminParentDetailResult:
        await self._ensure_admin(actor_id)
        parent = await self.repository.get_parent_record(parent_id)
        if parent is None:
            raise AdminParentNotFoundError("Parent profile was not found.")

        old_display_name = parent.get("display_name")
        name_changed = update_display_name and display_name is not None
        contact_changed = (update_email and email is not None) or (update_phone and phone is not None)

        if name_changed:
            previous = await self.repository.update_display_name(parent_id, display_name.strip())
            if previous is None:
                raise AdminParentNotFoundError("Parent profile was not found.")
            old_display_name = previous.get("display_name")

        if contact_changed:
            try:
                await self.auth_contact_provider.update_contact_info(
                    parent_id,
                    email=email.strip().lower() if update_email and email is not None else None,
                    phone=phone.strip() if update_phone and phone is not None else None,
                )
            except SupabaseAuthProviderNotConfiguredError as error:
                if name_changed:
                    try:
                        await self.repository.update_display_name(parent_id, old_display_name)
                    except Exception as rollback_error:
                        raise AdminParentConsistencyError() from rollback_error
                raise AdminParentProviderUnavailableError() from error
            except SupabaseAuthConflictError as error:
                if name_changed:
                    try:
                        await self.repository.update_display_name(parent_id, old_display_name)
                    except Exception as rollback_error:
                        raise AdminParentConsistencyError() from rollback_error
                raise AdminParentConflictError("The requested contact information conflicts with an existing account.") from error
            except SupabaseAuthProviderError as error:
                if name_changed:
                    try:
                        await self.repository.update_display_name(parent_id, old_display_name)
                    except Exception as rollback_error:
                        raise AdminParentConsistencyError() from rollback_error
                raise AdminParentProviderOperationError() from error

        return await self.get_parent_detail(actor_id, parent_id)
