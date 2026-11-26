"""ViRead backend internationalization core package."""

from app.services.i18n.email_templates import (
    PRESENCE_ALERT_TEMPLATES,
    READING_REMINDER_TEMPLATES,
    RenderedEmailTemplate,
    render_reading_presence_email,
    render_reading_reminder_email,
)
from app.services.i18n.errors import (
    ERROR_REGISTRY,
    ErrorDefinition,
    format_error_detail,
    get_error_definition,
)
from app.services.i18n.locales import (
    DEFAULT_LOCALE,
    LOCALE_COOKIE_NAME,
    LOCALE_HEADER_NAME,
    LOCALE_REGISTRY,
    RTL_LOCALES,
    SUPPORTED_LOCALES,
    SUPPORTED_LOCALE_SET,
    LocaleMetadata,
    is_rtl_locale,
    locale_direction,
    normalize_locale,
    resolve_explicit_locale,
    resolve_supported_locale,
)

__all__ = [
    "DEFAULT_LOCALE",
    "ERROR_REGISTRY",
    "ErrorDefinition",
    "LOCALE_COOKIE_NAME",
    "LOCALE_HEADER_NAME",
    "LOCALE_REGISTRY",
    "LocaleMetadata",
    "PRESENCE_ALERT_TEMPLATES",
    "READING_REMINDER_TEMPLATES",
    "RTL_LOCALES",
    "RenderedEmailTemplate",
    "SUPPORTED_LOCALES",
    "SUPPORTED_LOCALE_SET",
    "format_error_detail",
    "get_error_definition",
    "is_rtl_locale",
    "locale_direction",
    "normalize_locale",
    "render_reading_presence_email",
    "render_reading_reminder_email",
    "resolve_explicit_locale",
    "resolve_supported_locale",
]
