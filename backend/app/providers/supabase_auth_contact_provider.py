"""Server-side Supabase Auth integration for Admin Parent contact management."""
import asyncio
from typing import Literal
from uuid import UUID

from app.database.supabase_client import get_supabase_admin_client

ContactInfoStatus = Literal[
    "available",
    "not_configured",
    "user_not_found",
    "lookup_failed",
]


class SupabaseAuthProviderError(Exception):
    """Normalized safe failure from Supabase Auth Admin."""


class SupabaseAuthProviderNotConfiguredError(SupabaseAuthProviderError):
    """The server-only Admin client is not configured."""


class SupabaseAuthConflictError(SupabaseAuthProviderError):
    """The requested Auth identity or contact field conflicts with an existing user."""


class SupabaseAuthContactProvider:
    """Return only safe contact fields; never expose a raw Auth User object."""

    @staticmethod
    def _normalize_error(error: Exception) -> SupabaseAuthProviderError:
        message = str(error).lower()
        status_code = getattr(error, "status", None) or getattr(error, "status_code", None)
        if status_code in {409, 422} or any(
            marker in message
            for marker in ("already registered", "already exists", "already been registered", "email_exists", "phone_exists")
        ):
            return SupabaseAuthConflictError()
        return SupabaseAuthProviderError()

    @staticmethod
    def _lookup(user_id: UUID) -> dict[str, str | None | ContactInfoStatus]:
        client = get_supabase_admin_client()
        if client is None:
            return {"email": None, "phone": None, "contact_info_status": "not_configured"}
        try:
            response = client.auth.admin.get_user_by_id(str(user_id))
            user = getattr(response, "user", None)
            if user is None:
                return {"email": None, "phone": None, "contact_info_status": "user_not_found"}
            email = getattr(user, "email", None)
            phone = getattr(user, "phone", None)
            return {
                "email": email if isinstance(email, str) and email.strip() else None,
                "phone": phone if isinstance(phone, str) and phone.strip() else None,
                "contact_info_status": "available",
            }
        except Exception as error:
            message = str(error).lower()
            status_code = getattr(error, "status", None) or getattr(error, "status_code", None)
            if status_code == 404 or "user not found" in message or "user_not_found" in message:
                return {"email": None, "phone": None, "contact_info_status": "user_not_found"}
            return {"email": None, "phone": None, "contact_info_status": "lookup_failed"}

    @staticmethod
    def _invite_parent(email: str, display_name: str, phone: str | None) -> UUID:
        client = get_supabase_admin_client()
        if client is None:
            raise SupabaseAuthProviderNotConfiguredError()
        try:
            response = client.auth.admin.invite_user_by_email(
                email,
                {"data": {"display_name": display_name}},
            )
            user = getattr(response, "user", None)
            if user is None or not getattr(user, "id", None):
                raise SupabaseAuthProviderError()
            user_id = UUID(str(user.id))
            if phone:
                try:
                    client.auth.admin.update_user_by_id(str(user_id), {"phone": phone})
                except Exception as error:
                    # Compensation is limited to the newly-created invite in this same
                    # operation. This is never used by Hide/Restore and the user has no
                    # linked reading history at creation time.
                    try:
                        client.auth.admin.delete_user(str(user_id))
                    except Exception:
                        pass
                    raise SupabaseAuthContactProvider._normalize_error(error) from error
            return user_id
        except SupabaseAuthProviderError:
            raise
        except Exception as error:
            normalized = SupabaseAuthContactProvider._normalize_error(error)
            raise normalized from error

    @staticmethod
    def _update_contact_info(
        user_id: UUID,
        email: str | None,
        phone: str | None,
    ) -> None:
        client = get_supabase_admin_client()
        if client is None:
            raise SupabaseAuthProviderNotConfiguredError()
        attributes: dict[str, str] = {}
        if email is not None:
            attributes["email"] = email
        if phone is not None:
            attributes["phone"] = phone
        if not attributes:
            return
        try:
            # Do not set email_confirm/phone_confirm: verification must follow the
            # project's Supabase Auth policy rather than being silently bypassed.
            client.auth.admin.update_user_by_id(str(user_id), attributes)
        except Exception as error:
            normalized = SupabaseAuthContactProvider._normalize_error(error)
            raise normalized from error

    async def get_contact_info(
        self, user_id: UUID
    ) -> dict[str, str | None | ContactInfoStatus]:
        return await asyncio.to_thread(self._lookup, user_id)

    async def invite_parent(
        self, email: str, display_name: str, phone: str | None = None
    ) -> UUID:
        return await asyncio.to_thread(self._invite_parent, email, display_name, phone)

    async def update_contact_info(
        self, user_id: UUID, *, email: str | None = None, phone: str | None = None
    ) -> None:
        await asyncio.to_thread(self._update_contact_info, user_id, email, phone)
