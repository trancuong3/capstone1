"""Stable machine-readable backend error code registry and detail formatter."""

from __future__ import annotations

from dataclasses import dataclass
import re
from typing import Any


@dataclass(frozen=True)
class ErrorDefinition:
    code: str
    message_key: str
    default_message: str


_RAW_ERROR_DEFINITIONS: tuple[ErrorDefinition, ...] = (
    # Auth & authorization
    ErrorDefinition("AUTHENTICATION_REQUIRED", "errors.authentication_required", "Authentication required"),
    ErrorDefinition("INVALID_CREDENTIALS", "errors.invalid_credentials", "Invalid authentication credentials"),
    ErrorDefinition("AUTH_PROVIDER_UNAVAILABLE", "errors.auth_provider_unavailable", "Authentication service temporarily unavailable"),
    ErrorDefinition("ACCESS_DENIED", "errors.access_denied", "Access denied"),
    ErrorDefinition("FORBIDDEN", "errors.forbidden", "Access denied"),
    ErrorDefinition("PARENT_ACCESS_REQUIRED", "errors.parent_access_required", "Parent access required"),
    ErrorDefinition("ADMIN_ACCESS_REQUIRED", "errors.admin_access_required", "Admin access required"),
    ErrorDefinition("ACCOUNT_INACTIVE", "errors.account_inactive", "Account is inactive or unavailable"),
    # Generic resource / validation / system
    ErrorDefinition("RESOURCE_NOT_FOUND", "errors.resource_not_found", "Resource not found"),
    ErrorDefinition("VALIDATION_ERROR", "errors.validation_error", "Validation error"),
    ErrorDefinition("INVALID_PAGINATION", "errors.invalid_pagination", "Invalid pagination parameters"),
    ErrorDefinition("INVALID_DATE_WINDOW", "errors.invalid_date_window", "Invalid date window"),
    ErrorDefinition("DATABASE_OPERATION_FAILED", "errors.database_operation_failed", "The operation could not be completed"),
    ErrorDefinition("DATABASE_UNAVAILABLE", "errors.database_unavailable", "Database temporarily unavailable"),
    ErrorDefinition("INTERNAL_SERVER_ERROR", "errors.internal_server_error", "Internal server error"),
    ErrorDefinition("RATE_LIMITED", "errors.rate_limited", "Too many requests; please try again later"),
    # Reading management conflicts (reading_management_rules.py)
    ErrorDefinition("GOAL_DUPLICATE", "errors.goal_duplicate", "An active goal with the same metric and period already overlaps these dates"),
    ErrorDefinition("GOAL_ALREADY_EXPIRED", "errors.goal_already_expired", "The end date is already in the past"),
    ErrorDefinition("GOAL_END_BEFORE_START", "errors.goal_end_before_start", "The end date must not be before the start date"),
    ErrorDefinition("PLAN_ALREADY_EXPIRED", "errors.plan_already_expired", "The plan end date is already in the past"),
    ErrorDefinition("PLAN_NO_SCHEDULED_DAY", "errors.plan_no_scheduled_day", "The plan has no reading day between its start and end dates"),
    ErrorDefinition("BOOK_UNAVAILABLE", "errors.book_unavailable", "The selected book is not available to read"),
    ErrorDefinition("REMINDER_DUPLICATE", "errors.reminder_duplicate", "A reminder with the same time and overlapping days already exists"),
    ErrorDefinition("INVALID_TRANSITION", "errors.invalid_transition", "The requested state transition is not allowed"),
    ErrorDefinition("REPORT_NOT_AVAILABLE", "errors.report_not_available", "Report contract is not available yet"),
    ErrorDefinition("NO_COMPLETED_SESSIONS", "errors.no_completed_sessions", "No completed reading sessions in period"),
    # Reading presence & email delivery
    ErrorDefinition("PRESENCE_ALERT_DISABLED", "errors.presence_alert_disabled", "Presence email alerts are disabled"),
    ErrorDefinition("SESSION_NOT_ACTIVE", "errors.session_not_active", "Reading session is not active"),
    ErrorDefinition("SESSION_COOLDOWN", "errors.session_cooldown", "Presence alert cooldown is active for this session"),
    ErrorDefinition("DAILY_LIMIT", "errors.daily_limit", "Daily presence alert limit reached"),
    ErrorDefinition("PARENT_EMAIL_UNVERIFIED", "errors.parent_email_unverified", "Parent email address is unavailable or unverified"),
    ErrorDefinition("PARENT_EMAIL_LOOKUP_FAILED", "errors.parent_email_lookup_failed", "Parent contact lookup temporarily failed"),
    ErrorDefinition("EMAIL_NOT_CONFIGURED", "errors.email_not_configured", "Email delivery is not configured"),
    ErrorDefinition("SMTP_UNAVAILABLE", "errors.smtp_unavailable", "Email delivery service is temporarily unavailable"),
    ErrorDefinition("DELIVERY_UNCERTAIN", "errors.delivery_uncertain", "Email delivery status could not be confirmed"),
    # Support feedback
    ErrorDefinition("SUPPORT_EMAIL_NOT_CONFIGURED", "errors.support_email_not_configured", "Support email service is not configured"),
    ErrorDefinition("SUPPORT_EMAIL_UNAVAILABLE", "errors.support_email_unavailable", "Support email service is temporarily unavailable"),
    # Profile / parent admin / avatar
    ErrorDefinition("PARENT_CONFLICT", "errors.parent_conflict", "The requested Parent data conflicts with an existing account"),
    ErrorDefinition("PARENT_AUTH_OPERATION_FAILED", "errors.parent_auth_operation_failed", "The Parent authentication operation could not be completed"),
    ErrorDefinition("AVATAR_INVALID", "errors.avatar_invalid", "Uploaded avatar file is invalid"),
    # Voice & audio
    ErrorDefinition("TOO_MANY_KEYTERMS", "errors.too_many_keyterms", "Too many speech keyterms provided"),
    ErrorDefinition("KEYTERM_TOO_LONG", "errors.keyterm_too_long", "Speech keyterm exceeds allowed length"),
    ErrorDefinition("UNSUPPORTED_AUDIO", "errors.unsupported_audio", "Unsupported audio format"),
    ErrorDefinition("EMPTY_AUDIO", "errors.empty_audio", "Audio payload is empty"),
    ErrorDefinition("AUDIO_TOO_LARGE", "errors.audio_too_large", "Audio payload exceeds maximum allowed size"),
    ErrorDefinition("UNAUTHORIZED", "errors.unauthorized", "Authentication required"),
    ErrorDefinition("STT_WS_DISABLED", "errors.stt_ws_disabled", "Streaming speech recognition is disabled"),
    ErrorDefinition("LOCAL_STT_UNAVAILABLE", "errors.local_stt_unavailable", "Local speech recognition is unavailable"),
    # Karaoke / processing
    ErrorDefinition("PROVIDER_NOT_CONFIGURED", "errors.provider_not_configured", "Required media processing provider is not configured"),
    ErrorDefinition("REVISION_CONFLICT", "errors.revision_conflict", "Target revision is no longer current"),
    ErrorDefinition("PROCESSING_UNAVAILABLE", "errors.processing_unavailable", "Media processing service is unavailable"),
)

ERROR_REGISTRY: dict[str, ErrorDefinition] = {
    definition.code: definition for definition in _RAW_ERROR_DEFINITIONS
}


class _SafeFormatMap(dict[str, Any]):
    def __missing__(self, key: str) -> str:
        return "{" + key + "}"


def _sanitize_code(raw_code: str) -> str:
    cleaned = re.sub(r"[^A-Za-z0-9_.-]+", "_", raw_code.strip()).strip("_")
    return cleaned.upper() if cleaned else "INTERNAL_SERVER_ERROR"


def get_error_definition(code: str) -> ErrorDefinition | None:
    """Look up a registered backend error definition by machine code."""
    if not isinstance(code, str) or not code.strip():
        return None
    return ERROR_REGISTRY.get(code.strip().upper())


def format_error_detail(
    code: str,
    default_message: str | None = None,
    **params: Any,
) -> dict[str, Any]:
    """Build a backward-compatible structured HTTP error ``detail`` payload.

    Always returns ``code``, ``message_key``, ``message_params``, and ``message``.
    Frontend clients translate ``message_key`` + ``message_params`` using the
    active UI locale while legacy clients still receive ``code`` and ``message``.
    """
    normalized_code = _sanitize_code(code if isinstance(code, str) else "INTERNAL_SERVER_ERROR")
    definition = ERROR_REGISTRY.get(normalized_code)

    message_key = (
        definition.message_key
        if definition is not None
        else f"errors.{normalized_code.lower()}"
    )

    template = (
        default_message.strip()
        if isinstance(default_message, str) and default_message.strip()
        else (definition.default_message if definition is not None else "An unexpected error occurred")
    )

    rendered_message = template
    if params and "{" in template:
        try:
            rendered_message = template.format_map(_SafeFormatMap(params))
        except (ValueError, KeyError, TypeError):
            rendered_message = template

    return {
        "code": normalized_code,
        "message_key": message_key,
        "message_params": dict(params),
        "message": rendered_message,
    }
