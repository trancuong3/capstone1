"""Allowlisted ViRead UI/notification locales and safe resolution helpers."""

from __future__ import annotations

from dataclasses import dataclass
import re
from typing import Literal, Mapping

DEFAULT_LOCALE = "vi"
LOCALE_HEADER_NAME = "X-ViRead-Locale"
LOCALE_COOKIE_NAME = "viread_locale"

SUPPORTED_LOCALES: tuple[str, ...] = (
    "vi",
    "en",
    "zh-Hans",
    "zh-Hant",
    "ja",
    "ko",
    "fr",
    "de",
    "es",
    "pt",
    "it",
    "ru",
    "th",
    "id",
    "ms",
    "fil",
    "hi",
    "bn",
    "ar",
    "tr",
    "nl",
    "sv",
    "pl",
    "uk",
    "el",
    "he",
    "km",
    "lo",
    "my",
    "ne",
)
SUPPORTED_LOCALE_SET: frozenset[str] = frozenset(SUPPORTED_LOCALES)
RTL_LOCALES: frozenset[str] = frozenset({"ar", "he"})


@dataclass(frozen=True)
class LocaleMetadata:
    code: str
    native_name: str
    english_name: str
    direction: Literal["ltr", "rtl"]
    bcp47: str


LOCALE_REGISTRY: dict[str, LocaleMetadata] = {
    "vi": LocaleMetadata("vi", "Tiếng Việt", "Vietnamese", "ltr", "vi-VN"),
    "en": LocaleMetadata("en", "English", "English", "ltr", "en-US"),
    "zh-Hans": LocaleMetadata("zh-Hans", "简体中文", "Chinese (Simplified)", "ltr", "zh-Hans"),
    "zh-Hant": LocaleMetadata("zh-Hant", "繁體中文", "Chinese (Traditional)", "ltr", "zh-Hant"),
    "ja": LocaleMetadata("ja", "日本語", "Japanese", "ltr", "ja-JP"),
    "ko": LocaleMetadata("ko", "한국어", "Korean", "ltr", "ko-KR"),
    "fr": LocaleMetadata("fr", "Français", "French", "ltr", "fr-FR"),
    "de": LocaleMetadata("de", "Deutsch", "German", "ltr", "de-DE"),
    "es": LocaleMetadata("es", "Español", "Spanish", "ltr", "es-ES"),
    "pt": LocaleMetadata("pt", "Português", "Portuguese", "ltr", "pt-PT"),
    "it": LocaleMetadata("it", "Italiano", "Italian", "ltr", "it-IT"),
    "ru": LocaleMetadata("ru", "Русский", "Russian", "ltr", "ru-RU"),
    "th": LocaleMetadata("th", "ไทย", "Thai", "ltr", "th-TH"),
    "id": LocaleMetadata("id", "Bahasa Indonesia", "Indonesian", "ltr", "id-ID"),
    "ms": LocaleMetadata("ms", "Bahasa Melayu", "Malay", "ltr", "ms-MY"),
    "fil": LocaleMetadata("fil", "Filipino", "Filipino", "ltr", "fil-PH"),
    "hi": LocaleMetadata("hi", "हिन्दी", "Hindi", "ltr", "hi-IN"),
    "bn": LocaleMetadata("bn", "বাংলা", "Bengali", "ltr", "bn-BD"),
    "ar": LocaleMetadata("ar", "العربية", "Arabic", "rtl", "ar"),
    "tr": LocaleMetadata("tr", "Türkçe", "Turkish", "ltr", "tr-TR"),
    "nl": LocaleMetadata("nl", "Nederlands", "Dutch", "ltr", "nl-NL"),
    "sv": LocaleMetadata("sv", "Svenska", "Swedish", "ltr", "sv-SE"),
    "pl": LocaleMetadata("pl", "Polski", "Polish", "ltr", "pl-PL"),
    "uk": LocaleMetadata("uk", "Українська", "Ukrainian", "ltr", "uk-UA"),
    "el": LocaleMetadata("el", "Ελληνικά", "Greek", "ltr", "el-GR"),
    "he": LocaleMetadata("he", "עברית", "Hebrew", "rtl", "he-IL"),
    "km": LocaleMetadata("km", "ខ្មែរ", "Khmer", "ltr", "km-KH"),
    "lo": LocaleMetadata("lo", "ລາວ", "Lao", "ltr", "lo-LA"),
    "my": LocaleMetadata("my", "မြန်မာ", "Burmese", "ltr", "my-MM"),
    "ne": LocaleMetadata("ne", "नेपाली", "Nepali", "ltr", "ne-NP"),
}

_CANONICAL_LOWER_MAP: dict[str, str] = {code.lower(): code for code in SUPPORTED_LOCALES}
_LOCALE_TAG_RE = re.compile(r"^[A-Za-z]{2,3}(?:[-_][A-Za-z0-9]{2,8}){0,2}$", re.ASCII)

_EXPLICIT_ALIASES: dict[str, str] = {
    "zh": "zh-Hans",
    "zh-cn": "zh-Hans",
    "zh-sg": "zh-Hans",
    "zh-hans": "zh-Hans",
    "zh-hans-cn": "zh-Hans",
    "zh-hans-sg": "zh-Hans",
    "zh-tw": "zh-Hant",
    "zh-hk": "zh-Hant",
    "zh-mo": "zh-Hant",
    "zh-hant": "zh-Hant",
    "zh-hant-tw": "zh-Hant",
    "zh-hant-hk": "zh-Hant",
    "in": "id",
    "in-id": "id",
    "iw": "he",
    "iw-il": "he",
    "he-il": "he",
    "tl": "fil",
    "tl-ph": "fil",
    "fil-ph": "fil",
}


def normalize_locale(raw: str | None) -> str | None:
    """Validate and normalize a single explicit locale tag against the allowlist.

    Rejects path traversal, null bytes, multi-value headers, HTML/XSS payloads,
    and unsupported language codes by returning ``None``.
    """
    if not isinstance(raw, str):
        return None
    candidate = raw.strip()
    if not candidate or len(candidate) > 32:
        return None
    if "\x00" in candidate or ".." in candidate or "/" in candidate or "\\" in candidate:
        return None
    if not _LOCALE_TAG_RE.fullmatch(candidate):
        return None

    hyphenated = candidate.replace("_", "-").lower()
    if hyphenated in _CANONICAL_LOWER_MAP:
        return _CANONICAL_LOWER_MAP[hyphenated]
    if hyphenated in _EXPLICIT_ALIASES:
        return _EXPLICIT_ALIASES[hyphenated]

    primary = hyphenated.split("-", 1)[0]
    if primary == "zh":
        return None
    if primary in _EXPLICIT_ALIASES:
        return _EXPLICIT_ALIASES[primary]
    if primary in _CANONICAL_LOWER_MAP:
        return _CANONICAL_LOWER_MAP[primary]
    return None


def resolve_supported_locale(raw: str | None) -> str:
    """Resolve an untrusted locale input to an allowlisted locale, defaulting to ``'vi'``."""
    return normalize_locale(raw) or DEFAULT_LOCALE


def resolve_explicit_locale(
    *,
    explicit_locale: str | None = None,
    headers: Mapping[str, str] | None = None,
    user_preference: str | None = None,
) -> str:
    """Resolve explicit ViRead locale preference without reading OS or Accept-Language.

    Priority:
      1. Explicit parameter (``explicit_locale``)
      2. Explicit ``X-ViRead-Locale`` request header
      3. Explicit saved account preference (``user_preference``)
      4. ``DEFAULT_LOCALE`` (``"vi"``)
    """
    for candidate in (explicit_locale,):
        normalized = normalize_locale(candidate)
        if normalized is not None:
            return normalized

    if headers is not None:
        header_value: str | None = None
        for key, value in headers.items():
            if isinstance(key, str) and key.lower() == LOCALE_HEADER_NAME.lower():
                header_value = value
                break
        normalized_header = normalize_locale(header_value)
        if normalized_header is not None:
            return normalized_header

    normalized_pref = normalize_locale(user_preference)
    if normalized_pref is not None:
        return normalized_pref

    return DEFAULT_LOCALE


def is_rtl_locale(locale: str | None) -> bool:
    """Return True when the resolved locale uses right-to-left layout."""
    return resolve_supported_locale(locale) in RTL_LOCALES


def locale_direction(locale: str | None) -> Literal["rtl", "ltr"]:
    """Return ``'rtl'`` for Arabic/Hebrew or ``'ltr'`` otherwise."""
    return "rtl" if is_rtl_locale(locale) else "ltr"
