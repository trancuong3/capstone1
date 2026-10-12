"""Read-only lookup of contact fields from Supabase Auth for Admin parent details."""
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


class SupabaseAuthContactProvider:
    """Fetch only email and phone, never returning the raw Supabase Auth record."""

    @staticmethod
    def _lookup(user_id: UUID) -> dict[str, str | None | ContactInfoStatus]:
        client = get_supabase_admin_client()
        if client is None:
            return {
                "email": None,
                "phone": None,
                "contact_info_status": "not_configured",
            }

        try:
            response = client.auth.admin.get_user_by_id(str(user_id))
            user = getattr(response, "user", None)
            if user is None:
                return {
                    "email": None,
                    "phone": None,
                    "contact_info_status": "user_not_found",
                }

            email = getattr(user, "email", None)
            phone = getattr(user, "phone", None)
            return {
                "email": email if isinstance(email, str) and email.strip() else None,
                "phone": phone if isinstance(phone, str) and phone.strip() else None,
                "contact_info_status": "available",
            }
        except Exception as error:
            # Do not log or expose exception details because Auth errors may include
            # implementation details. Only normalize an unambiguous missing-user case.
            message = str(error).lower()
            status_code = getattr(error, "status", None) or getattr(error, "status_code", None)
            if status_code == 404 or "user not found" in message or "user_not_found" in message:
                return {
                    "email": None,
                    "phone": None,
                    "contact_info_status": "user_not_found",
                }
            return {
                "email": None,
                "phone": None,
                "contact_info_status": "lookup_failed",
            }

    async def get_contact_info(
        self, user_id: UUID
    ) -> dict[str, str | None | ContactInfoStatus]:
        # The Supabase Python client is synchronous; keep network I/O off the event loop.
        return await asyncio.to_thread(self._lookup, user_id)
