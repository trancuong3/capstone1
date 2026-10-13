"""Server-side Supabase Auth integration for Admin Parent contact management."""
import asyncio
import logging
import re
from typing import Literal
from uuid import UUID

from app.database.supabase_client import get_supabase_admin_client

logger = logging.getLogger(__name__)

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


class SupabaseAuthRateLimitError(SupabaseAuthProviderError):
    """Supabase Auth temporarily rate-limited an email or authentication request."""


class SupabaseAuthCompensationError(SupabaseAuthProviderError):
    """A newly created Auth identity could not be safely compensated after Create failed."""


class SupabaseAuthContactProvider:
    """Return only safe contact fields; never expose a raw Auth User object."""

    @staticmethod
    def _normalize_error(
        error: Exception, *, operation: str = "request"
    ) -> SupabaseAuthProviderError:
        message = str(error).lower()
        status_code = getattr(error, "status", None) or getattr(error, "status_code", None)
        if not isinstance(status_code, int):
            status_code = None

        raw_error_code = getattr(error, "error_code", None) or getattr(error, "code", None)
        safe_error_code = None
        if isinstance(raw_error_code, (str, int)):
            candidate = str(raw_error_code)
            if re.fullmatch(r"[A-Za-z0-9_.-]{1,80}", candidate):
                safe_error_code = candidate

        # Log only structured, allow-listed diagnostics. Do not log the raw
        # provider message because it can contain contact details or credentials.
        logger.warning(
            "Supabase Auth Admin operation failed "
            "(operation=%s, exception_type=%s, status_code=%s, error_code=%s)",
            operation,
            type(error).__name__,
            status_code,
            safe_error_code,
        )

        conflict_codes = {
            "conflict",
            "email_exists",
            "phone_exists",
            "user_already_exists",
            "identity_already_exists",
            "email_conflict_identity_not_deletable",
        }
        rate_limit_codes = {
            "over_email_send_rate_limit",
            "over_request_rate_limit",
            "over_sms_send_rate_limit",
            "over_email_rate_limit",
        }
        if status_code == 429 or safe_error_code in rate_limit_codes:
            return SupabaseAuthRateLimitError()

        if status_code == 409 or safe_error_code in conflict_codes or any(
            marker in message
            for marker in (
                "already registered",
                "already exists",
                "already been registered",
                "email_exists",
                "phone_exists",
            )
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
        try:
            # Keep client initialization inside the guarded block so an SDK or
            # configuration failure is logged and normalized like other Auth errors.
            client = get_supabase_admin_client()
            if client is None:
                raise SupabaseAuthProviderNotConfiguredError()
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
                    except Exception as cleanup_error:
                        SupabaseAuthContactProvider._normalize_error(
                            cleanup_error,
                            operation="cleanup_after_phone_update_failure",
                        )
                        raise SupabaseAuthCompensationError(
                            "The newly created invitation could not be cleaned up after phone update failed."
                        ) from cleanup_error
                    raise SupabaseAuthContactProvider._normalize_error(
                        error, operation="update_phone"
                    ) from error
            return user_id
        except SupabaseAuthProviderError:
            raise
        except Exception as error:
            normalized = SupabaseAuthContactProvider._normalize_error(
                error, operation="invite_parent"
            )
            raise normalized from error

    @staticmethod
    def _delete_new_invite(user_id: UUID) -> None:
        """Compensation for a newly created invite whose profile could not be verified."""
        try:
            client = get_supabase_admin_client()
            if client is None:
                raise SupabaseAuthProviderNotConfiguredError()
            client.auth.admin.delete_user(str(user_id))
        except SupabaseAuthProviderError:
            raise
        except Exception as error:
            raise SupabaseAuthContactProvider._normalize_error(
                error, operation="compensate_delete_user"
            ) from error

    @staticmethod
    def _update_contact_info(
        user_id: UUID,
        email: str | None,
        phone: str | None,
    ) -> None:
        attributes: dict[str, str] = {}
        if email is not None:
            attributes["email"] = email
        if phone is not None:
            attributes["phone"] = phone
        if not attributes:
            return
        try:
            client = get_supabase_admin_client()
            if client is None:
                raise SupabaseAuthProviderNotConfiguredError()
            # Do not set email_confirm/phone_confirm: verification must follow the
            # project's Supabase Auth policy rather than being silently bypassed.
            client.auth.admin.update_user_by_id(str(user_id), attributes)
        except SupabaseAuthProviderError:
            raise
        except Exception as error:
            normalized = SupabaseAuthContactProvider._normalize_error(
                error, operation="update_contact_info"
            )
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

    async def compensate_failed_invite(self, user_id: UUID) -> None:
        """Delete only the Auth identity created by the current failed Create request."""
        await asyncio.to_thread(self._delete_new_invite, user_id)
