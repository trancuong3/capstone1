"""Pure stdlib HTML framed email layout engine for ViRead.

Builds email-client-safe (Gmail, Apple Mail, Outlook MSO, Mobile) framed HTML
cards using ViRead's authentic warm paper cream (#fffaf0), botanical teal
(#087467), sage border (#ceded8), and mint (#d9f4eb) visual language.

Design invariants:
- Pure Python standard library only (no DB/FastAPI/HTTP dependencies).
- Table-based MSO-safe 600px layout with inline CSS (no <svg>, no data:image/,
  no external <img> URLs, no legacy #2563eb SaaS blue).
- Duplicated ``dir="ltr|rtl"`` on both ``<html>`` and the outer wrapper
  ``<table>`` because Gmail strips ``<html>``/``<body>``.
- Strict HTML escaping (``html.escape(..., quote=True)``) and URL scheme
  allowlisting (``http://``, ``https://``, and opt-in ``mailto:``).
- Zero sensitive/alarmist words in the shared shell or presence renderer.
"""

from __future__ import annotations

import html
import re
from collections.abc import Sequence
from typing import Any, Literal
from urllib.parse import quote, unquote, urlsplit

# Authentic ViRead palette tokens (mirrored from frontend/app/globals.css)
COLOR_CANVAS = "#fffaf0"
COLOR_CREAM = "#fffdf5"
COLOR_WHITE = "#ffffff"
COLOR_INK = "#233e40"
COLOR_MUTED = "#52676b"
COLOR_BORDER = "#ceded8"
COLOR_DIVIDER = "#e5ede9"
COLOR_SUBTLE_SURFACE = "#f4f7f6"

COLOR_PRIMARY = "#087467"
COLOR_PRIMARY_DARK = "#114b46"
COLOR_MINT_HEADER = "#caf0df"
COLOR_SKY_MINT = "#d9f4eb"
COLOR_MINT_BORDER = "#b5e4d6"
COLOR_TRACK_MINT = "#e6f2ee"

COLOR_GREEN_SURFACE = "#e2f4d8"
COLOR_GREEN_SOFT = "#eef6ee"
COLOR_GREEN_BORDER = "#b7dfaa"
COLOR_GREEN_INK = "#3b6a46"
COLOR_GREEN_ACCENT = "#2e7d52"
COLOR_GREEN_DARK = "#1f4f32"

COLOR_WARNING_SURFACE = "#fff3c4"
COLOR_ORANGE_SURFACE = "#ffe2c4"
COLOR_WARNING_BORDER = "#f0d58c"
COLOR_WARNING_INK = "#765b12"
COLOR_HONEY_ACCENT = "#d97706"
COLOR_GOLD_ACCENT = "#f0b645"

COLOR_DESK_SURFACE = "#e5f5f6"
COLOR_DESK_BORDER = "#bfe0e2"
COLOR_DESK_ACCENT = "#4a7c82"

COLOR_PURPLE_SURFACE = "#ece6ff"
COLOR_PURPLE_SOFT = "#faf8ff"
COLOR_PURPLE_BORDER = "#d4c8f5"
COLOR_PURPLE_INK = "#5e4b86"

COLOR_CORAL_SURFACE = "#fdebec"
COLOR_CORAL_BORDER = "#f3c1c6"
COLOR_CORAL_INK = "#8f3039"

FONT_STACK = (
    "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,'Helvetica Neue',"
    "Arial,'Noto Sans',sans-serif"
)

RTL_PRIMARY_LOCALES = frozenset({"ar", "he"})
_LANG_TAG_RE = re.compile(r"^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8}){0,2}$", re.ASCII)
_GOAL_PCT_PAREN_RE = re.compile(r"\(\s*(-?\d+(?:[.,]\d+)?)\s*%\s*\)")
_GOAL_PCT_INLINE_RE = re.compile(r"(?<![A-Za-z0-9_])(-?\d+(?:[.,]\d+)?)\s*%")
_GOAL_DATE_PREFIX_RE = re.compile(
    r"(?:ngày|tuần|tháng|week|day)\s+\d+\s*/\s*\d+",
    re.IGNORECASE,
)
_GOAL_RATIO_RE = re.compile(r"(?<![\d/])(\d+)\s*/\s*(\d+)(?![\d/])")
_TRAILING_LABEL_SEPARATORS = ":：៖-—– \t"

# Padding sequence prevents email clients from pulling body HTML into inbox previews.
_PREHEADER_PAD = "&#847;&zwnj;&nbsp;" * 28

SUPPORT_CATEGORY_STYLES: dict[str, dict[str, str]] = {
    "technical_issue": {
        "pill_bg": COLOR_CORAL_SURFACE,
        "pill_text": COLOR_CORAL_INK,
        "pill_border": COLOR_CORAL_BORDER,
    },
    "account_support": {
        "pill_bg": COLOR_WARNING_SURFACE,
        "pill_text": COLOR_WARNING_INK,
        "pill_border": COLOR_WARNING_BORDER,
    },
    "how_to": {
        "pill_bg": COLOR_SKY_MINT,
        "pill_text": COLOR_PRIMARY,
        "pill_border": COLOR_MINT_BORDER,
    },
    "feature_feedback": {
        "pill_bg": COLOR_DESK_SURFACE,
        "pill_text": COLOR_INK,
        "pill_border": COLOR_DESK_BORDER,
    },
    "feature_request": {
        "pill_bg": COLOR_PURPLE_SURFACE,
        "pill_text": COLOR_PURPLE_INK,
        "pill_border": COLOR_PURPLE_BORDER,
    },
    "other": {
        "pill_bg": COLOR_SUBTLE_SURFACE,
        "pill_text": COLOR_MUTED,
        "pill_border": COLOR_BORDER,
    },
}

MILESTONE_KIND_STYLES: dict[str, dict[str, str]] = {
    "STREAK": {
        "badge_label": "Chuỗi đọc liên tiếp",
        "accent": COLOR_GOLD_ACCENT,
        "card_bg": COLOR_CREAM,
        "border": COLOR_WARNING_BORDER,
        "pill_bg": COLOR_WARNING_SURFACE,
        "pill_text": COLOR_WARNING_INK,
        "emblem": "&#9733;",
    },
    "GOAL": {
        "badge_label": "Hoàn thành mục tiêu",
        "accent": COLOR_GREEN_INK,
        "card_bg": "#f7fcf5",
        "border": COLOR_GREEN_BORDER,
        "pill_bg": COLOR_GREEN_SURFACE,
        "pill_text": COLOR_GREEN_INK,
        "emblem": "&#10003;",
    },
    "FIRST_SESSION": {
        "badge_label": "Buổi đọc đầu tiên",
        "accent": COLOR_PURPLE_INK,
        "card_bg": COLOR_PURPLE_SOFT,
        "border": COLOR_PURPLE_BORDER,
        "pill_bg": COLOR_PURPLE_SURFACE,
        "pill_text": COLOR_PURPLE_INK,
        "emblem": "&#10022;",
    },
}

FooterContext = Literal["parent_settings", "neutral_presence", "support_ops", "none"]


def escape_text(value: Any) -> str:
    """Escape text for HTML body and quoted attributes."""
    return html.escape("" if value is None else str(value), quote=True)


def escape_multiline(value: Any) -> str:
    """Escape multiline text while preserving line breaks as ``<br />``."""
    raw = "" if value is None else str(value)
    normalized = raw.replace("\r\n", "\n").replace("\r", "\n")
    return html.escape(normalized, quote=True).replace("\n", "<br />")


def resolve_lang_and_dir(locale: str | None) -> tuple[str, Literal["ltr", "rtl"]]:
    """Return a validated BCP-47 lang attribute and matching text direction."""
    if not isinstance(locale, str):
        return "vi", "ltr"
    cleaned = locale.strip().replace("_", "-")
    if not cleaned or len(cleaned) > 32 or not _LANG_TAG_RE.fullmatch(cleaned):
        return "vi", "ltr"
    primary = cleaned.split("-", 1)[0].lower()
    direction: Literal["ltr", "rtl"] = "rtl" if primary in RTL_PRIMARY_LOCALES else "ltr"
    return cleaned, direction


def _is_valid_email_addr(value: str) -> bool:
    if not value or any(ord(ch) < 32 or ord(ch) == 127 or ch.isspace() for ch in value):
        return False
    local, sep, domain = value.partition("@")
    return bool(sep and local and domain and "@" not in domain)


def sanitize_url(url: str | None, *, allow_mailto: bool = False) -> str | None:
    """Allow only safe http/https URLs (and mailto: when explicitly opted in)."""
    if not isinstance(url, str):
        return None
    cleaned = url.strip()
    if not cleaned:
        return None
    if any(ord(ch) < 32 or ord(ch) == 127 or ch.isspace() for ch in cleaned):
        return None
    try:
        parsed = urlsplit(cleaned)
    except ValueError:
        return None
    scheme = parsed.scheme.lower()
    if scheme in {"http", "https"}:
        if not parsed.netloc:
            return None
        return cleaned
    if allow_mailto and scheme == "mailto":
        if not _is_valid_email_addr(unquote(parsed.path)):
            return None
        decoded_query = unquote(parsed.query)
        if any(ord(ch) < 32 or ord(ch) == 127 for ch in decoded_query):
            return None
        return cleaned
    return None


def build_mailto_url(contact_email: str, subject: str) -> str | None:
    """Construct a percent-encoded RFC 6068 mailto: URL safe for HTML href."""
    cleaned_email = (contact_email or "").strip()
    if not _is_valid_email_addr(cleaned_email):
        return None
    encoded_email = quote(cleaned_email, safe="@.-_")
    clean_subject = " ".join((subject or "").splitlines()).strip()
    if clean_subject:
        encoded_subject = quote(f"Re: {clean_subject}", safe="")
        candidate = f"mailto:{encoded_email}?subject={encoded_subject}"
    else:
        candidate = f"mailto:{encoded_email}"
    return sanitize_url(candidate, allow_mailto=True)


def extract_cta_label_from_line(
    line: str,
    url_token: str,
    *,
    fallback: str = "ViRead",
) -> str:
    """Extract a clean localized button label from a ``Label: {url}`` line."""
    text = line or ""
    token = (url_token or "").strip()
    if token and token in text:
        text = text.replace(token, "")
    cleaned = text.strip().rstrip(_TRAILING_LABEL_SEPARATORS).strip()
    return cleaned or fallback


def _parse_goal_percent(goal_summary: str) -> int | None:
    """Extract an integer 0..100 completion percentage from ``goal_summary``."""
    for pattern in (_GOAL_PCT_PAREN_RE, _GOAL_PCT_INLINE_RE):
        match = pattern.search(goal_summary)
        if match is not None:
            parsed = round(float(match.group(1).replace(",", ".")))
            return max(0, min(100, parsed))
    scrubbed = _GOAL_DATE_PREFIX_RE.sub("", goal_summary)
    ratio_match = _GOAL_RATIO_RE.search(scrubbed)
    if ratio_match is not None:
        current = int(ratio_match.group(1))
        target = int(ratio_match.group(2))
        if target > 0:
            return max(0, min(100, round(current * 100 / target)))
    return None


def _render_pill(
    label: str,
    *,
    bg: str,
    text_color: str,
    border_color: str,
    margin: str = "0",
    ltr_isolate: bool = False,
    nowrap: bool = False,
) -> str:
    safe_label = escape_text(label)
    inner = (
        f'<span dir="ltr" style="unicode-bidi:isolate;">{safe_label}</span>'
        if ltr_isolate
        else safe_label
    )
    wrap_style = (
        "white-space:nowrap;"
        if nowrap
        else "max-width:100%;box-sizing:border-box;word-break:break-word;overflow-wrap:anywhere;"
    )
    return (
        f'<span style="display:inline-block;margin:{margin};padding:4px 10px;'
        f'border-radius:14px;background-color:{bg};border:1px solid {border_color};'
        f'font-family:{FONT_STACK};font-size:12px;font-weight:700;line-height:1.3;'
        f'color:{text_color};vertical-align:middle;{wrap_style}">{inner}</span>'
    )


def _split_four_part_plain_body(plain_body: str) -> tuple[str, str, str, str]:
    """Split normalized ``plain_body`` into ``(greeting, body, cta_line, closing)``.

    Anchors from both ends so multiline child aliases inside paragraph 2 do not
    shift the CTA or closing/opt-out paragraphs, while handling 1/2/3-paragraph
    inputs without dropping or duplicating sections.
    """
    normalized = (plain_body or "").replace("\r\n", "\n").replace("\r", "\n")
    paragraphs = [part.strip() for part in normalized.split("\n\n") if part.strip()]
    if not paragraphs:
        return "", "", "", ""
    if len(paragraphs) == 1:
        return paragraphs[0], "", "", ""
    if len(paragraphs) == 2:
        return paragraphs[0], paragraphs[1], "", ""
    if len(paragraphs) == 3:
        return paragraphs[0], paragraphs[1], paragraphs[2], ""
    return (
        paragraphs[0],
        "\n\n".join(paragraphs[1:-2]),
        paragraphs[-2],
        paragraphs[-1],
    )


def _isolate_rtl_tokens(escaped_html: str, raw_tokens: Sequence[str]) -> str:
    """Wrap LTR schedule tokens (dates, times, timezones) in bidi-isolated spans."""
    escaped_tokens = sorted(
        {escape_text(tok) for tok in raw_tokens if tok and tok.strip()},
        key=len,
        reverse=True,
    )
    if not escaped_tokens:
        return escaped_html
    pattern = re.compile("|".join(re.escape(tok) for tok in escaped_tokens))
    return pattern.sub(
        lambda m: f'<span dir="ltr" style="unicode-bidi:isolate;">{m.group(0)}</span>',
        escaped_html,
    )


def _render_cta_button(
    *,
    label: str,
    url: str,
    bg_color: str,
    align: Literal["left", "right"],
) -> str:
    safe_label = escape_text(label)
    safe_url = escape_text(url)
    return (
        '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" '
        'border="0" style="width:100%;border-collapse:collapse;margin:22px 0 4px;">'
        "<tr>"
        f'<td align="{align}" style="padding:0;">'
        '<table role="presentation" cellpadding="0" cellspacing="0" border="0" '
        'style="border-collapse:separate;border-spacing:0;">'
        "<tr>"
        f'<td align="center" bgcolor="{bg_color}" '
        f'style="background-color:{bg_color};border-radius:10px;">'
        f'<a href="{safe_url}" target="_blank" rel="noopener noreferrer" '
        f'style="display:inline-block;padding:13px 22px;font-family:{FONT_STACK};'
        "font-size:15px;font-weight:700;line-height:1.25;color:#ffffff;"
        f'text-decoration:none;border-radius:10px;border:1px solid {bg_color};">'
        f"{safe_label}</a>"
        "</td></tr></table>"
        "</td></tr></table>"
    )


def _render_progress_bar(percent: int) -> str:
    clamped = max(0, min(100, int(percent)))
    fill_color = COLOR_GREEN_ACCENT if clamped >= 100 else COLOR_PRIMARY
    if clamped <= 0:
        cells = (
            f'<td width="100%" height="8" bgcolor="{COLOR_TRACK_MINT}" '
            f'style="height:8px;line-height:8px;mso-line-height-rule:exactly;font-size:0;'
            f'background-color:{COLOR_TRACK_MINT};border-radius:999px;">&nbsp;</td>'
        )
    elif clamped >= 100:
        cells = (
            f'<td width="100%" height="8" bgcolor="{fill_color}" '
            f'style="height:8px;line-height:8px;mso-line-height-rule:exactly;font-size:0;'
            f'background-color:{fill_color};border-radius:999px;">&nbsp;</td>'
        )
    else:
        remainder = 100 - clamped
        cells = (
            f'<td width="{clamped}%" height="8" bgcolor="{fill_color}" '
            f'style="height:8px;line-height:8px;mso-line-height-rule:exactly;font-size:0;'
            f'background-color:{fill_color};border-radius:999px 0 0 999px;">&nbsp;</td>'
            f'<td width="{remainder}%" height="8" bgcolor="{COLOR_TRACK_MINT}" '
            f'style="height:8px;line-height:8px;mso-line-height-rule:exactly;font-size:0;'
            f'background-color:{COLOR_TRACK_MINT};border-radius:0 999px 999px 0;">&nbsp;</td>'
        )
    return (
        '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" '
        'border="0" style="width:100%;border-collapse:collapse;table-layout:fixed;'
        'margin-top:6px;">'
        f"<tr>{cells}</tr></table>"
    )


def render_viread_email_shell(
    *,
    locale: str = "vi",
    title: str,
    preheader: str,
    accent_color: str,
    header_bg: str,
    header_text_color: str = COLOR_INK,
    header_border_color: str = COLOR_BORDER,
    badge_label: str | None = None,
    badge_bg: str = COLOR_WHITE,
    badge_text_color: str | None = None,
    badge_border: str = COLOR_BORDER,
    badge_ltr_isolate: bool = False,
    subtitle: str | None = None,
    greeting: str | None = None,
    body_html: str,
    cta_label: str | None = None,
    cta_url: str | None = None,
    cta_bg: str | None = None,
    allow_mailto_cta: bool = False,
    after_cta_html: str = "",
    footer_context: FooterContext = "parent_settings",
    footer_note: str = "",
    settings_url: str | None = None,
) -> str:
    """Render the shared MSO-safe framed ViRead email container."""
    safe_lang, direction = resolve_lang_and_dir(locale)
    start_align: Literal["left", "right"] = "right" if direction == "rtl" else "left"
    end_align: Literal["left", "right"] = "left" if direction == "rtl" else "right"

    safe_title = escape_text(title)
    safe_preheader = escape_text(preheader)

    badge_cell = ""
    if badge_label:
        pill_html = _render_pill(
            badge_label,
            bg=badge_bg,
            text_color=badge_text_color or accent_color,
            border_color=badge_border,
            ltr_isolate=badge_ltr_isolate,
        )
        badge_pad = "padding:0 10px 0 0;" if direction == "rtl" else "padding:0 0 0 10px;"
        badge_cell = (
            f'<td align="{end_align}" valign="middle" '
            f'style="{badge_pad}text-align:'
            f'{end_align};vertical-align:middle;">{pill_html}</td>'
        )

    subtitle_html = ""
    if subtitle:
        subtitle_html = (
            f'<p style="margin:6px 0 0;font-family:{FONT_STACK};font-size:13px;'
            f'line-height:1.5;color:{COLOR_MUTED};word-break:break-word;'
            f'overflow-wrap:anywhere;">{escape_text(subtitle)}</p>'
        )

    greeting_html = ""
    if greeting:
        greeting_html = (
            f'<p style="margin:0 0 16px;font-family:{FONT_STACK};font-size:15px;'
            f'line-height:1.6;font-weight:600;color:{COLOR_INK};'
            f'word-break:break-word;overflow-wrap:anywhere;">'
            f"{escape_text(greeting)}</p>"
        )

    cta_html = ""
    sanitized_cta = (
        sanitize_url(cta_url, allow_mailto=allow_mailto_cta) if cta_url else None
    )
    if cta_label and sanitized_cta:
        cta_html = _render_cta_button(
            label=cta_label,
            url=sanitized_cta,
            bg_color=cta_bg or accent_color,
            align=start_align,
        )

    footer_row = ""
    safe_footer_note = escape_text(footer_note) if footer_note else ""
    if footer_context == "parent_settings":
        sanitized_settings = sanitize_url(settings_url) if settings_url else None
        link_part = (
            f' <a href="{escape_text(sanitized_settings)}" '
            f'style="color:{COLOR_PRIMARY};font-weight:700;text-decoration:underline;">'
            "Quản lý thông báo email</a>."
            if sanitized_settings
            else ""
        )
        if safe_footer_note or link_part:
            footer_row = (
                "<tr>"
                f'<td bgcolor="{COLOR_CREAM}" align="{start_align}" '
                f'style="background-color:{COLOR_CREAM};border-top:1px solid {COLOR_BORDER};'
                f'padding:16px 24px;text-align:{start_align};">'
                f'<p style="margin:0;font-family:{FONT_STACK};font-size:12px;'
                f'line-height:1.6;color:{COLOR_MUTED};word-break:break-word;'
                f'overflow-wrap:anywhere;">{safe_footer_note}{link_part}</p>'
                "</td></tr>"
            )
    elif footer_context == "neutral_presence":
        if safe_footer_note:
            footer_row = (
                "<tr>"
                f'<td bgcolor="{COLOR_SUBTLE_SURFACE}" align="{start_align}" '
                f'style="background-color:{COLOR_SUBTLE_SURFACE};'
                f'border-top:1px solid {COLOR_BORDER};padding:16px 24px;'
                f'text-align:{start_align};">'
                f'<p style="margin:0;font-family:{FONT_STACK};font-size:12px;'
                f'line-height:1.6;color:{COLOR_MUTED};word-break:break-word;'
                f'overflow-wrap:anywhere;">{safe_footer_note}</p>'
                "</td></tr>"
            )
    elif footer_context == "support_ops" and safe_footer_note:
        footer_row = (
            "<tr>"
            f'<td bgcolor="{COLOR_SUBTLE_SURFACE}" align="{start_align}" '
            f'style="background-color:{COLOR_SUBTLE_SURFACE};'
            f'border-top:1px solid {COLOR_BORDER};padding:15px 24px;'
            f'text-align:{start_align};">'
            f'<p style="margin:0;font-family:{FONT_STACK};font-size:12px;'
            f'line-height:1.6;color:{COLOR_MUTED};word-break:break-word;'
            f'overflow-wrap:anywhere;">{safe_footer_note}</p>'
            "</td></tr>"
        )

    brand_gap = "padding-left:10px;" if direction == "rtl" else "padding-right:10px;"

    return (
        "<!DOCTYPE html>"
        f'<html lang="{safe_lang}" dir="{direction}">'
        "<head>"
        '<meta charset="utf-8" />'
        '<meta name="viewport" content="width=device-width, initial-scale=1.0" />'
        '<meta name="x-apple-disable-message-reformatting" />'
        '<meta name="color-scheme" content="light" />'
        '<meta name="supported-color-schemes" content="light" />'
        f"<title>{safe_title}</title>"
        "</head>"
        f'<body style="margin:0;padding:0;background-color:{COLOR_CANVAS};'
        f'font-family:{FONT_STACK};color:{COLOR_INK};'
        '-webkit-text-size-adjust:100%;-ms-text-size-adjust:100%;">'
        '<div style="display:none;max-height:0;max-width:0;opacity:0;'
        f'overflow:hidden;mso-hide:all;font-size:1px;line-height:1px;color:{COLOR_CANVAS};">'
        f"{safe_preheader}{_PREHEADER_PAD}</div>"
        '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" '
        f'border="0" dir="{direction}" bgcolor="{COLOR_CANVAS}" '
        f'style="width:100%;margin:0;padding:0;background-color:{COLOR_CANVAS};'
        'border-collapse:collapse;">'
        "<tr>"
        '<td align="center" style="padding:24px 12px;">'
        '<!--[if mso]><table role="presentation" align="center" border="0" '
        'cellpadding="0" cellspacing="0" width="600"><tr><td><![endif]-->'
        '<table role="presentation" align="center" width="100%" cellpadding="0" '
        f'cellspacing="0" border="0" dir="{direction}" bgcolor="{COLOR_WHITE}" '
        f'style="width:100%;max-width:600px;margin:0 auto;background-color:{COLOR_WHITE};'
        f'border:1px solid {COLOR_BORDER};border-radius:16px;'
        'border-collapse:separate;border-spacing:0;overflow:hidden;table-layout:fixed;">'
        "<tr>"
        f'<td height="5" bgcolor="{accent_color}" style="height:5px;line-height:5px;'
        f'mso-line-height-rule:exactly;font-size:0;background-color:{accent_color};">&nbsp;</td>'
        "</tr>"
        "<tr>"
        f'<td bgcolor="{header_bg}" align="{start_align}" '
        f'style="background-color:{header_bg};'
        f'border-bottom:1px solid {header_border_color};padding:22px 24px 20px;'
        f'text-align:{start_align};">'
        '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" '
        'border="0" style="width:100%;border-collapse:collapse;">'
        "<tr>"
        f'<td align="{start_align}" valign="middle" style="padding:0;vertical-align:middle;">'
        '<table role="presentation" cellpadding="0" cellspacing="0" border="0" '
        'style="border-collapse:collapse;">'
        "<tr>"
        f'<td style="{brand_gap}vertical-align:middle;">'
        '<table role="presentation" cellpadding="0" cellspacing="0" border="0" '
        'style="border-collapse:separate;border-spacing:0;">'
        "<tr>"
        f'<td width="32" height="32" align="center" valign="middle" bgcolor="{COLOR_SKY_MINT}" '
        f'style="width:32px;height:32px;background-color:{COLOR_SKY_MINT};'
        f'border:1px solid {COLOR_MINT_BORDER};border-radius:9px;'
        f'font-family:{FONT_STACK};font-size:17px;font-weight:800;'
        f'line-height:30px;color:{COLOR_PRIMARY};text-align:center;">V</td>'
        "</tr></table>"
        "</td>"
        '<td valign="middle" style="vertical-align:middle;">'
        f'<span style="font-family:{FONT_STACK};font-size:17px;font-weight:800;'
        f'letter-spacing:-0.01em;color:{COLOR_PRIMARY};">ViRead</span>'
        "</td>"
        "</tr></table>"
        "</td>"
        f"{badge_cell}"
        "</tr></table>"
        f'<h1 style="margin:14px 0 0;font-family:{FONT_STACK};font-size:21px;'
        f'line-height:1.32;font-weight:800;color:{header_text_color};'
        f'word-break:break-word;overflow-wrap:anywhere;">{safe_title}</h1>'
        f"{subtitle_html}"
        "</td></tr>"
        "<tr>"
        f'<td bgcolor="{COLOR_WHITE}" align="{start_align}" '
        f'style="background-color:{COLOR_WHITE};padding:24px 24px 22px;'
        f'text-align:{start_align};word-break:break-word;overflow-wrap:anywhere;">'
        f"{greeting_html}"
        f"{body_html}"
        f"{cta_html}"
        f"{after_cta_html}"
        "</td></tr>"
        f"{footer_row}"
        "</table>"
        '<table role="presentation" align="center" width="100%" cellpadding="0" '
        'cellspacing="0" border="0" style="width:100%;max-width:600px;margin:0 auto;'
        'border-collapse:collapse;">'
        "<tr>"
        '<td align="center" style="padding:14px 12px 0;text-align:center;">'
        f'<p style="margin:0;font-family:{FONT_STACK};font-size:11px;'
        f'line-height:1.5;color:{COLOR_MUTED};">ViRead</p>'
        "</td></tr></table>"
        "<!--[if mso]></td></tr></table><![endif]-->"
        "</td></tr></table>"
        "</body></html>"
    )


def render_weekly_digest_html(
    *,
    greeting: str,
    week_label: str,
    items: Sequence[Any],
    cta_url: str,
    settings_url: str,
) -> str:
    """Render framed family KPI + per-child progress cards for WEEKLY_DIGEST."""
    total_sessions = sum(int(item.sessions_count) for item in items)
    total_minutes = sum(int(item.total_minutes) for item in items)
    child_count = len(items)

    kpi_card = (
        '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" '
        f'border="0" bgcolor="{COLOR_CREAM}" '
        f'style="width:100%;background-color:{COLOR_CREAM};'
        f'border:1px solid {COLOR_BORDER};border-radius:12px;'
        'border-collapse:separate;border-spacing:0;table-layout:fixed;margin:0 0 18px;">'
        "<tr>"
        '<td width="33.33%" align="center" valign="top" '
        f'style="padding:14px 8px;border-right:1px solid {COLOR_DIVIDER};text-align:center;">'
        f'<div style="font-family:{FONT_STACK};font-size:24px;font-weight:800;'
        f'line-height:1.15;color:{COLOR_PRIMARY};">{total_sessions}</div>'
        f'<div style="margin-top:4px;font-family:{FONT_STACK};font-size:11px;'
        f'font-weight:600;line-height:1.35;color:{COLOR_MUTED};">Tổng buổi đọc</div>'
        "</td>"
        '<td width="33.33%" align="center" valign="top" '
        f'style="padding:14px 8px;border-right:1px solid {COLOR_DIVIDER};text-align:center;">'
        f'<div style="font-family:{FONT_STACK};font-size:24px;font-weight:800;'
        f'line-height:1.15;color:{COLOR_PRIMARY};">{total_minutes}</div>'
        f'<div style="margin-top:4px;font-family:{FONT_STACK};font-size:11px;'
        f'font-weight:600;line-height:1.35;color:{COLOR_MUTED};">Tổng phút đọc</div>'
        "</td>"
        '<td width="33.34%" align="center" valign="top" '
        'style="padding:14px 8px;text-align:center;">'
        f'<div style="font-family:{FONT_STACK};font-size:24px;font-weight:800;'
        f'line-height:1.15;color:{COLOR_INK};">{child_count}</div>'
        f'<div style="margin-top:4px;font-family:{FONT_STACK};font-size:11px;'
        f'font-weight:600;line-height:1.35;color:{COLOR_MUTED};">Số bé</div>'
        "</td>"
        "</tr></table>"
    )

    cards: list[str] = [kpi_card]
    if not items:
        cards.append(
            '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" '
            f'border="0" bgcolor="{COLOR_CREAM}" '
            f'style="width:100%;background-color:{COLOR_CREAM};'
            f'border:1px solid {COLOR_BORDER};border-left:4px solid {COLOR_PRIMARY};'
            'border-radius:12px;border-collapse:separate;border-spacing:0;'
            'margin:0 0 12px;">'
            "<tr><td style=\"padding:16px;\">"
            f'<p style="margin:0;font-family:{FONT_STACK};font-size:14px;'
            f'line-height:1.6;color:{COLOR_MUTED};">'
            "Tuần này gia đình chưa có buổi đọc nào được ghi nhận. "
            "Ba mẹ có thể cùng bé chọn một truyện ngắn 5–10 phút để khởi động tuần mới nhé."
            "</p></td></tr></table>"
        )
    else:
        for item in items:
            sessions_count = int(item.sessions_count)
            total_min = int(item.total_minutes)
            prev_count = int(item.prev_sessions_count)
            safe_alias = escape_text(item.child_alias)

            if sessions_count > 0:
                delta = sessions_count - prev_count
                if delta > 0:
                    delta_pill = _render_pill(
                        f"+{delta} so với tuần trước",
                        bg=COLOR_GREEN_SURFACE,
                        text_color=COLOR_GREEN_INK,
                        border_color=COLOR_GREEN_BORDER,
                        nowrap=True,
                    )
                elif delta < 0:
                    delta_pill = _render_pill(
                        f"{delta} so với tuần trước",
                        bg=COLOR_WARNING_SURFACE,
                        text_color=COLOR_WARNING_INK,
                        border_color=COLOR_WARNING_BORDER,
                        nowrap=True,
                    )
                elif prev_count > 0:
                    delta_pill = _render_pill(
                        "Giữ nhịp tuần trước",
                        bg=COLOR_SUBTLE_SURFACE,
                        text_color=COLOR_MUTED,
                        border_color=COLOR_BORDER,
                        nowrap=True,
                    )
                else:
                    delta_pill = ""

                metrics_pills = [
                    _render_pill(
                        f"{sessions_count} buổi đọc",
                        bg=COLOR_SUBTLE_SURFACE,
                        text_color=COLOR_INK,
                        border_color=COLOR_BORDER,
                        margin="0 6px 6px 0",
                    ),
                    _render_pill(
                        f"{total_min} phút",
                        bg=COLOR_SUBTLE_SURFACE,
                        text_color=COLOR_INK,
                        border_color=COLOR_BORDER,
                        margin="0 6px 6px 0",
                    ),
                ]
                if item.avg_fluency_score is not None:
                    metrics_pills.append(
                        _render_pill(
                            f"Độ trôi chảy TB: {round(item.avg_fluency_score)}%",
                            bg=COLOR_SKY_MINT,
                            text_color=COLOR_PRIMARY,
                            border_color=COLOR_MINT_BORDER,
                            margin="0 6px 6px 0",
                        )
                    )
                detail_block = (
                    '<div style="margin-top:10px;line-height:1.4;">'
                    + "".join(metrics_pills)
                    + "</div>"
                )
                left_accent = COLOR_PRIMARY
            else:
                delta_pill = _render_pill(
                    "Chưa đọc tuần này",
                    bg=COLOR_WARNING_SURFACE,
                    text_color=COLOR_WARNING_INK,
                    border_color=COLOR_WARNING_BORDER,
                    nowrap=True,
                )
                detail_block = (
                    f'<p style="margin:10px 0 0;font-family:{FONT_STACK};font-size:14px;'
                    f'line-height:1.6;color:{COLOR_MUTED};">'
                    "Tuần này bé chưa có buổi đọc nào. Một buổi đọc ngắn 5–10 phút cùng ba mẹ "
                    "sẽ giúp bé giữ thói quen tốt.</p>"
                )
                left_accent = COLOR_GOLD_ACCENT

            goal_block = ""
            if item.goal_summary:
                parsed_pct = _parse_goal_percent(str(item.goal_summary))
                bar_html = (
                    _render_progress_bar(parsed_pct) if parsed_pct is not None else ""
                )
                goal_block = (
                    f'<div style="margin-top:12px;padding:10px 12px;background-color:{COLOR_CREAM};'
                    f'border:1px solid {COLOR_DIVIDER};border-radius:10px;">'
                    f'<div style="font-family:{FONT_STACK};font-size:13px;font-weight:700;'
                    f'line-height:1.45;color:{COLOR_PRIMARY};">'
                    f"Mục tiêu: {escape_text(item.goal_summary)}</div>"
                    f"{bar_html}</div>"
                )

            words_block = ""
            raw_words = [
                str(word).strip()
                for word in (item.top_difficult_words or ())[:5]
                if str(word).strip()
            ]
            if raw_words:
                chips = "".join(
                    _render_pill(
                        word,
                        bg=COLOR_WARNING_SURFACE,
                        text_color=COLOR_WARNING_INK,
                        border_color=COLOR_WARNING_BORDER,
                        margin="6px 6px 0 0",
                    )
                    for word in raw_words
                )
                words_block = (
                    f'<div style="margin-top:12px;padding-top:10px;'
                    f'border-top:1px solid {COLOR_DIVIDER};">'
                    f'<div style="font-family:{FONT_STACK};font-size:12px;font-weight:700;'
                    f'color:{COLOR_MUTED};">Từ cần luyện thêm</div>'
                    f'<div style="line-height:1.4;">{chips}</div>'
                    "</div>"
                )

            header_right = (
                f'<td width="1%" align="right" valign="middle" style="width:1%;padding:0 0 0 10px;'
                f'text-align:right;vertical-align:middle;white-space:nowrap;">{delta_pill}</td>'
                if delta_pill
                else ""
            )

            cards.append(
                '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" '
                f'border="0" bgcolor="{COLOR_WHITE}" '
                f'style="width:100%;background-color:{COLOR_WHITE};'
                f'border:1px solid {COLOR_BORDER};border-left:4px solid {left_accent};'
                'border-radius:12px;border-collapse:separate;border-spacing:0;'
                'table-layout:fixed;margin:0 0 12px;">'
                '<tr><td style="padding:15px 16px;word-break:break-word;'
                'overflow-wrap:anywhere;">'
                '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" '
                'border="0" style="width:100%;border-collapse:collapse;">'
                "<tr>"
                '<td align="left" valign="middle" style="padding:0;vertical-align:middle;'
                'word-break:break-word;overflow-wrap:anywhere;">'
                f'<span style="font-family:{FONT_STACK};font-size:16px;font-weight:800;'
                f'line-height:1.35;color:{COLOR_INK};">{safe_alias}</span>'
                "</td>"
                f"{header_right}"
                "</tr></table>"
                f"{detail_block}"
                f"{goal_block}"
                f"{words_block}"
                "</td></tr></table>"
            )

    return render_viread_email_shell(
        locale="vi",
        title=f"Báo cáo đọc sách tuần {week_label}",
        preheader=(
            f"Tổng kết tuần {week_label}: {total_sessions} buổi đọc "
            f"({total_minutes} phút) của gia đình trên ViRead."
        ),
        accent_color=COLOR_PRIMARY,
        header_bg=COLOR_MINT_HEADER,
        header_text_color=COLOR_PRIMARY_DARK,
        header_border_color=COLOR_MINT_BORDER,
        badge_label=f"Tuần {week_label}",
        badge_bg=COLOR_WHITE,
        badge_text_color=COLOR_PRIMARY,
        badge_border=COLOR_MINT_BORDER,
        greeting=greeting,
        body_html="".join(cards),
        cta_label="Xem báo cáo tiến độ",
        cta_url=cta_url,
        cta_bg=COLOR_PRIMARY,
        footer_context="parent_settings",
        footer_note="ViRead chỉ gửi báo cáo tổng hợp tối đa 1 lần mỗi tuần.",
        settings_url=settings_url,
    )


def render_inactivity_alert_html(
    *,
    greeting: str,
    items: Sequence[Any],
    cta_url: str,
    settings_url: str,
) -> str:
    """Render warm apricot/honey gentle nudge frame for INACTIVITY_ALERT."""
    blocks: list[str] = [
        (
            f'<p style="margin:0 0 14px;font-family:{FONT_STACK};font-size:15px;'
            f'line-height:1.6;color:{COLOR_INK};">'
            "ViRead gửi lời nhắc nhẹ để ba mẹ cùng bé duy trì thói quen đọc sách đều đặn:</p>"
        )
    ]

    for item in items:
        days = int(item.days_inactive)
        safe_alias = escape_text(item.child_alias)
        if item.had_prior_sessions:
            detail_line = f"Đã {days} ngày kể từ buổi đọc gần nhất."
        else:
            detail_line = f"Đã {days} ngày nhưng bé chưa bắt đầu buổi đọc đầu tiên."
        days_pill = _render_pill(
            f"{days} ngày chưa đọc",
            bg=COLOR_ORANGE_SURFACE,
            text_color=COLOR_WARNING_INK,
            border_color=COLOR_GOLD_ACCENT,
            nowrap=True,
        )
        blocks.append(
            '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" '
            f'border="0" bgcolor="{COLOR_CREAM}" '
            f'style="width:100%;background-color:{COLOR_CREAM};'
            f'border:1px solid {COLOR_WARNING_BORDER};border-left:4px solid {COLOR_GOLD_ACCENT};'
            'border-radius:12px;border-collapse:separate;border-spacing:0;'
            'table-layout:fixed;margin:0 0 10px;">'
            '<tr><td style="padding:14px 16px;word-break:break-word;overflow-wrap:anywhere;">'
            '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" '
            'border="0" style="width:100%;border-collapse:collapse;">'
            "<tr>"
            '<td align="left" valign="middle" style="padding:0;vertical-align:middle;'
            'word-break:break-word;overflow-wrap:anywhere;">'
            f'<span style="font-family:{FONT_STACK};font-size:15px;font-weight:800;'
            f'color:{COLOR_INK};">{safe_alias}</span>'
            "</td>"
            '<td width="1%" align="right" valign="middle" style="width:1%;padding:0 0 0 10px;'
            f'text-align:right;vertical-align:middle;white-space:nowrap;">{days_pill}</td>'
            "</tr></table>"
            f'<p style="margin:8px 0 0;font-family:{FONT_STACK};font-size:14px;'
            f'line-height:1.55;color:{COLOR_MUTED};">{escape_text(detail_line)}</p>'
            "</td></tr></table>"
        )

    blocks.append(
        '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" '
        f'border="0" bgcolor="{COLOR_SKY_MINT}" '
        f'style="width:100%;background-color:{COLOR_SKY_MINT};'
        f'border:1px solid {COLOR_MINT_BORDER};border-radius:12px;'
        'border-collapse:separate;border-spacing:0;margin:16px 0 0;">'
        '<tr><td style="padding:14px 16px;">'
        f'<div style="font-family:{FONT_STACK};font-size:12px;font-weight:800;'
        f'letter-spacing:0.03em;text-transform:uppercase;color:{COLOR_PRIMARY};">'
        "Gợi ý nhỏ 5–10 phút hôm nay</div>"
        f'<p style="margin:6px 0 0;font-family:{FONT_STACK};font-size:14px;'
        f'line-height:1.6;color:{COLOR_INK};">'
        "Chỉ cần 5–10 phút đọc một truyện ngắn hôm nay là bé đã duy trì được đà tiến bộ "
        "và niềm vui đọc sách rồi!</p>"
        "</td></tr></table>"
    )

    return render_viread_email_shell(
        locale="vi",
        title="Nhắc nhẹ giữ thói quen đọc sách",
        preheader=(
            "Chỉ cần 5–10 phút đọc một truyện ngắn hôm nay là bé đã duy trì được "
            "thói quen đọc sách đều đặn."
        ),
        accent_color=COLOR_HONEY_ACCENT,
        header_bg=COLOR_WARNING_SURFACE,
        header_text_color=COLOR_WARNING_INK,
        header_border_color=COLOR_WARNING_BORDER,
        badge_label="Nhắc nhẹ giữ nhịp",
        badge_bg=COLOR_ORANGE_SURFACE,
        badge_text_color=COLOR_WARNING_INK,
        badge_border=COLOR_GOLD_ACCENT,
        greeting=greeting,
        body_html="".join(blocks),
        cta_label="Chọn sách đọc cùng bé",
        cta_url=cta_url,
        cta_bg=COLOR_PRIMARY,
        footer_context="parent_settings",
        footer_note=(
            "Để không làm phiền ba mẹ, ViRead giới hạn nhắc tối đa 1 lần/tuần "
            "và tự tạm dừng nếu gia đình đang nghỉ dài ngày."
        ),
        settings_url=settings_url,
    )


def _resolve_milestone_kind(item: Any) -> str:
    explicit = getattr(item, "milestone_kind", None)
    if isinstance(explicit, str):
        normalized = explicit.strip().upper()
        if normalized in MILESTONE_KIND_STYLES:
            return normalized
    label_lower = str(getattr(item, "milestone_label", "") or "").lower()
    if any(token in label_lower for token in ("chuỗi", "liên tiếp", "streak")):
        return "STREAK"
    if any(token in label_lower for token in ("mục tiêu", "goal")):
        return "GOAL"
    if any(token in label_lower for token in ("đầu tiên", "first")):
        return "FIRST_SESSION"
    return "STREAK"


def render_milestone_html(
    *,
    greeting: str,
    items: Sequence[Any],
    cta_url: str,
    settings_url: str,
) -> str:
    """Render festive celebration certificate frames for MILESTONE."""
    blocks: list[str] = [
        (
            f'<p style="margin:0 0 14px;font-family:{FONT_STACK};font-size:15px;'
            f'line-height:1.6;color:{COLOR_INK};">'
            "Tin vui từ hành trình đọc sách của gia đình trên ViRead:</p>"
        )
    ]

    for item in items:
        kind = _resolve_milestone_kind(item)
        style = MILESTONE_KIND_STYLES[kind]
        safe_alias = escape_text(item.child_alias)
        safe_label = escape_text(item.milestone_label)
        safe_detail = escape_text(item.detail)

        kind_pill = _render_pill(
            style["badge_label"],
            bg=style["pill_bg"],
            text_color=style["pill_text"],
            border_color=style["border"],
        )

        blocks.append(
            '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" '
            f'border="0" bgcolor="{style["card_bg"]}" '
            f'style="width:100%;background-color:{style["card_bg"]};'
            f'border:1px solid {style["border"]};border-left:5px solid {style["accent"]};'
            'border-radius:14px;border-collapse:separate;border-spacing:0;'
            'table-layout:fixed;margin:0 0 12px;">'
            '<tr><td style="padding:16px 18px;word-break:break-word;overflow-wrap:anywhere;">'
            '<table role="presentation" cellpadding="0" cellspacing="0" border="0" '
            'style="border-collapse:collapse;">'
            "<tr>"
            '<td style="padding-right:8px;vertical-align:middle;">'
            '<table role="presentation" cellpadding="0" cellspacing="0" border="0" '
            'style="border-collapse:separate;border-spacing:0;">'
            "<tr>"
            f'<td width="28" height="28" align="center" valign="middle" bgcolor="{style["pill_bg"]}" '
            f'style="width:28px;height:28px;background-color:{style["pill_bg"]};'
            f'border:1px solid {style["border"]};border-radius:999px;'
            f'font-family:{FONT_STACK};font-size:14px;font-weight:800;'
            f'line-height:26px;color:{style["pill_text"]};text-align:center;">'
            f'{style["emblem"]}</td>'
            "</tr></table>"
            "</td>"
            f'<td valign="middle" style="vertical-align:middle;">{kind_pill}</td>'
            "</tr></table>"
            f'<div style="margin-top:10px;font-family:{FONT_STACK};font-size:16px;'
            f'font-weight:800;line-height:1.35;color:{COLOR_INK};">'
            f"{safe_alias} &middot; {safe_label}</div>"
            f'<p style="margin:6px 0 0;font-family:{FONT_STACK};font-size:14px;'
            f'line-height:1.6;color:{COLOR_MUTED};">{safe_detail}</p>'
            "</td></tr></table>"
        )

    blocks.append(
        '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" '
        f'border="0" bgcolor="{COLOR_GREEN_SOFT}" '
        f'style="width:100%;background-color:{COLOR_GREEN_SOFT};'
        f'border:1px solid {COLOR_GREEN_BORDER};border-radius:12px;'
        'border-collapse:separate;border-spacing:0;margin:14px 0 0;">'
        '<tr><td style="padding:14px 16px;">'
        f'<div style="font-family:{FONT_STACK};font-size:12px;font-weight:800;'
        f'letter-spacing:0.03em;text-transform:uppercase;color:{COLOR_GREEN_INK};">'
        "Lời khen dành cho bé</div>"
        f'<p style="margin:6px 0 0;font-family:{FONT_STACK};font-size:14px;'
        f'line-height:1.6;color:{COLOR_INK};">'
        "Ba mẹ nhớ dành cho bé một lời khen thật ấm áp để tiếp thêm động lực đọc sách "
        "mỗi ngày nhé!</p>"
        "</td></tr></table>"
    )

    return render_viread_email_shell(
        locale="vi",
        title="Chúc mừng cột mốc đọc sách mới!",
        preheader="Tin vui từ hành trình đọc sách của gia đình trên ViRead!",
        accent_color=COLOR_GOLD_ACCENT,
        header_bg=COLOR_WARNING_SURFACE,
        header_text_color=COLOR_INK,
        header_border_color=COLOR_WARNING_BORDER,
        badge_label="Chúc mừng cột mốc",
        badge_bg=COLOR_WHITE,
        badge_text_color=COLOR_PRIMARY,
        badge_border=COLOR_GOLD_ACCENT,
        greeting=greeting,
        body_html="".join(blocks),
        cta_label="Xem thành tích của bé",
        cta_url=cta_url,
        cta_bg=COLOR_PRIMARY,
        footer_context="parent_settings",
        footer_note="Mỗi cột mốc chỉ được gửi chúc mừng một lần duy nhất.",
        settings_url=settings_url,
    )


def render_test_email_html(
    *,
    greeting: str,
    cta_url: str,
    settings_url: str,
) -> str:
    """Render verified status banner + 4-item feature checklist for TEST_EMAIL."""
    checklist_items = (
        (
            "Báo cáo đọc sách hằng tuần",
            "Tổng kết số buổi đọc, phút đọc, mục tiêu và các từ bé cần luyện thêm.",
        ),
        (
            "Nhắc nhẹ khi bé nghỉ đọc",
            "Gửi lời nhắc dịu nhẹ theo ngưỡng ngày nghỉ ba mẹ chủ động lựa chọn.",
        ),
        (
            "Chúc mừng cột mốc mới",
            "Ghi nhận chuỗi ngày đọc liên tiếp, hoàn thành mục tiêu và buổi đọc đầu tiên.",
        ),
        (
            "Khung giờ yên tĩnh & chống spam",
            "Tự động tôn trọng giờ nghỉ ngơi và giới hạn số email tối đa mỗi tuần.",
        ),
    )

    rows_html: list[str] = []
    for idx, (label, desc) in enumerate(checklist_items):
        border_bottom = (
            f"border-bottom:1px solid {COLOR_DIVIDER};"
            if idx < len(checklist_items) - 1
            else ""
        )
        rows_html.append(
            "<tr>"
            f'<td width="34" valign="top" style="width:34px;padding:11px 10px 11px 0;'
            f'{border_bottom}vertical-align:top;">'
            '<table role="presentation" cellpadding="0" cellspacing="0" border="0" '
            'style="border-collapse:separate;border-spacing:0;">'
            "<tr>"
            f'<td width="22" height="22" align="center" valign="middle" bgcolor="{COLOR_SKY_MINT}" '
            f'style="width:22px;height:22px;background-color:{COLOR_SKY_MINT};'
            f'border:1px solid {COLOR_MINT_BORDER};border-radius:999px;'
            f'font-family:{FONT_STACK};font-size:12px;font-weight:800;'
            f'line-height:20px;color:{COLOR_PRIMARY};text-align:center;">&#10003;</td>'
            "</tr></table>"
            "</td>"
            f'<td valign="top" style="padding:10px 0;{border_bottom}vertical-align:top;">'
            f'<div style="font-family:{FONT_STACK};font-size:14px;font-weight:700;'
            f'line-height:1.4;color:{COLOR_INK};">{escape_text(label)}</div>'
            f'<div style="margin-top:2px;font-family:{FONT_STACK};font-size:13px;'
            f'line-height:1.5;color:{COLOR_MUTED};">{escape_text(desc)}</div>'
            "</td>"
            "</tr>"
        )

    body_html = (
        '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" '
        f'border="0" bgcolor="{COLOR_GREEN_SOFT}" '
        f'style="width:100%;background-color:{COLOR_GREEN_SOFT};'
        f'border:1px solid {COLOR_GREEN_BORDER};border-left:4px solid {COLOR_GREEN_ACCENT};'
        'border-radius:12px;border-collapse:separate;border-spacing:0;margin:0 0 16px;">'
        '<tr><td style="padding:14px 16px;">'
        f'<div style="font-family:{FONT_STACK};font-size:15px;font-weight:800;'
        f'line-height:1.4;color:{COLOR_GREEN_DARK};">'
        "Email thông báo phụ huynh từ ViRead đã hoạt động bình thường</div>"
        f'<p style="margin:6px 0 0;font-family:{FONT_STACK};font-size:14px;'
        f'line-height:1.6;color:{COLOR_INK};">'
        "Ba mẹ sẽ chỉ nhận những email hữu ích theo đúng lựa chọn và giới hạn chống spam "
        "đã cài đặt.</p>"
        "</td></tr></table>"
        '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" '
        f'border="0" bgcolor="{COLOR_CREAM}" '
        f'style="width:100%;background-color:{COLOR_CREAM};'
        f'border:1px solid {COLOR_BORDER};border-radius:12px;'
        'border-collapse:separate;border-spacing:0;table-layout:fixed;">'
        '<tr><td style="padding:14px 16px 6px;">'
        f'<div style="font-family:{FONT_STACK};font-size:12px;font-weight:800;'
        f'letter-spacing:0.03em;text-transform:uppercase;color:{COLOR_MUTED};'
        'margin-bottom:4px;">Danh sách thông báo có thể tùy chỉnh</div>'
        '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" '
        'border="0" style="width:100%;border-collapse:collapse;">'
        + "".join(rows_html)
        + "</table>"
        "</td></tr></table>"
    )

    return render_viread_email_shell(
        locale="vi",
        title="Kết nối email thông báo thành công",
        preheader="Email thông báo phụ huynh từ ViRead đã hoạt động ổn định.",
        accent_color=COLOR_GREEN_ACCENT,
        header_bg=COLOR_GREEN_SURFACE,
        header_text_color=COLOR_GREEN_DARK,
        header_border_color=COLOR_GREEN_BORDER,
        badge_label="✓ Kết nối thành công",
        badge_bg=COLOR_WHITE,
        badge_text_color=COLOR_GREEN_ACCENT,
        badge_border=COLOR_GREEN_BORDER,
        greeting=greeting,
        body_html=body_html,
        cta_label="Mở cài đặt thông báo",
        cta_url=cta_url,
        cta_bg=COLOR_PRIMARY,
        footer_context="parent_settings",
        footer_note="Email này được gửi theo yêu cầu kiểm tra từ trang Cài đặt tài khoản.",
        settings_url=settings_url,
    )


def render_reading_reminder_html(
    *,
    locale: str,
    subject: str,
    plain_body: str,
    child_alias: str,
    local_date: str,
    local_time: str,
    timezone_name: str,
    app_url: str,
) -> str:
    """Render Emerald/Mint schedule ticket frame for READING_REMINDER (30 locales + RTL)."""
    safe_lang, direction = resolve_lang_and_dir(locale)
    accent_side = "border-right" if direction == "rtl" else "border-left"
    pill_margin = "0 0 6px 6px" if direction == "rtl" else "0 6px 6px 0"

    greeting, middle_block, cta_line, closing = _split_four_part_plain_body(plain_body)

    middle_lines = [line.strip() for line in middle_block.splitlines() if line.strip()]
    if len(middle_lines) >= 2:
        headline_line = "\n".join(middle_lines[:-1])
        schedule_text = middle_lines[-1]
    elif len(middle_lines) == 1:
        headline_line = middle_lines[0]
        schedule_text = ""
    else:
        headline_line = child_alias
        schedule_text = ""

    cta_label = extract_cta_label_from_line(
        cta_line,
        app_url,
        fallback="Mở ViRead" if safe_lang == "vi" else "ViRead",
    )

    badge_label = (
        "Lịch đọc sách"
        if safe_lang == "vi"
        else f"{local_date} · {local_time}"
    )

    schedule_pills = "".join(
        (
            _render_pill(
                local_date,
                bg=COLOR_SKY_MINT,
                text_color=COLOR_PRIMARY,
                border_color=COLOR_MINT_BORDER,
                margin=pill_margin,
                ltr_isolate=True,
                nowrap=True,
            ),
            _render_pill(
                local_time,
                bg=COLOR_WHITE,
                text_color=COLOR_INK,
                border_color=COLOR_BORDER,
                margin=pill_margin,
                ltr_isolate=True,
                nowrap=True,
            ),
            _render_pill(
                timezone_name,
                bg=COLOR_SUBTLE_SURFACE,
                text_color=COLOR_MUTED,
                border_color=COLOR_BORDER,
                margin=pill_margin,
                ltr_isolate=True,
            ),
        )
    )

    escaped_schedule = escape_multiline(schedule_text) if schedule_text else ""
    if escaped_schedule and direction == "rtl":
        escaped_schedule = _isolate_rtl_tokens(
            escaped_schedule,
            (local_date, local_time, timezone_name),
        )

    schedule_line_html = (
        f'<p style="margin:8px 0 0;font-family:{FONT_STACK};font-size:14px;'
        f'line-height:1.55;color:{COLOR_INK};">{escaped_schedule}</p>'
        if escaped_schedule
        else ""
    )

    closing_html = (
        '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" '
        f'border="0" bgcolor="{COLOR_GREEN_SOFT}" '
        f'style="width:100%;background-color:{COLOR_GREEN_SOFT};'
        f'border:1px solid {COLOR_GREEN_BORDER};border-radius:10px;'
        'border-collapse:separate;border-spacing:0;margin:18px 0 0;">'
        '<tr><td style="padding:12px 14px;">'
        f'<p style="margin:0;font-family:{FONT_STACK};font-size:14px;'
        f'line-height:1.55;color:{COLOR_INK};">{escape_multiline(closing)}</p>'
        "</td></tr></table>"
        if closing
        else ""
    )

    body_html = (
        f'<p style="margin:0 0 14px;font-family:{FONT_STACK};font-size:16px;'
        f'font-weight:700;line-height:1.55;color:{COLOR_INK};">'
        f"{escape_multiline(headline_line)}</p>"
        '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" '
        f'border="0" bgcolor="{COLOR_CREAM}" '
        f'style="width:100%;background-color:{COLOR_CREAM};'
        f'border:1px solid {COLOR_MINT_BORDER};{accent_side}:4px solid {COLOR_PRIMARY};'
        'border-radius:12px;border-collapse:separate;border-spacing:0;'
        'table-layout:fixed;margin:0 0 4px;">'
        '<tr><td style="padding:16px;word-break:break-word;overflow-wrap:anywhere;">'
        f'<div style="line-height:1.4;">{schedule_pills}</div>'
        f"{schedule_line_html}"
        "</td></tr></table>"
    )

    return render_viread_email_shell(
        locale=safe_lang,
        title=subject,
        preheader=headline_line or subject,
        accent_color=COLOR_PRIMARY,
        header_bg=COLOR_MINT_HEADER,
        header_text_color=COLOR_PRIMARY_DARK,
        header_border_color=COLOR_MINT_BORDER,
        badge_label=badge_label,
        badge_bg=COLOR_WHITE,
        badge_text_color=COLOR_PRIMARY,
        badge_border=COLOR_MINT_BORDER,
        badge_ltr_isolate=(safe_lang != "vi"),
        greeting=greeting,
        body_html=body_html,
        cta_label=cta_label,
        cta_url=app_url,
        cta_bg=COLOR_PRIMARY,
        after_cta_html=closing_html,
        footer_context="none",
        footer_note="",
    )


def render_reading_presence_html(
    *,
    locale: str,
    subject: str,
    plain_body: str,
    app_url: str,
    cta_label: str | None = None,
) -> str:
    """Render calm neutral desk-sky pause frame for READING_PRESENCE (30 locales + RTL).

    States one neutral fact only and avoids every restricted term across both
    markup and visible copy.
    """
    safe_lang, direction = resolve_lang_and_dir(locale)
    accent_side = "border-right" if direction == "rtl" else "border-left"

    greeting, fact_paragraph, resume_paragraph, optout_paragraph = (
        _split_four_part_plain_body(plain_body)
    )

    resume_prompt = extract_cta_label_from_line(
        resume_paragraph,
        app_url,
        fallback="",
    )

    if cta_label and cta_label.strip():
        effective_cta = cta_label.strip()
    elif safe_lang == "vi":
        effective_cta = "Mở ViRead"
    elif safe_lang == "en":
        effective_cta = "Open ViRead"
    else:
        effective_cta = "ViRead"

    badge_label = "Tạm dừng buổi đọc" if safe_lang == "vi" else None

    resume_html = (
        f'<p style="margin:0 0 2px;font-family:{FONT_STACK};font-size:14px;'
        f'line-height:1.6;color:{COLOR_MUTED};">{escape_multiline(resume_prompt)}</p>'
        if resume_prompt
        else ""
    )

    body_html = (
        '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" '
        f'border="0" bgcolor="{COLOR_SUBTLE_SURFACE}" '
        f'style="width:100%;background-color:{COLOR_SUBTLE_SURFACE};'
        f'border:1px solid {COLOR_BORDER};{accent_side}:4px solid {COLOR_DESK_ACCENT};'
        'border-radius:12px;border-collapse:separate;border-spacing:0;'
        'table-layout:fixed;margin:0 0 16px;">'
        '<tr><td style="padding:16px 18px;word-break:break-word;overflow-wrap:anywhere;">'
        f'<p style="margin:0;font-family:{FONT_STACK};font-size:15px;'
        f'line-height:1.6;color:{COLOR_INK};">{escape_multiline(fact_paragraph)}</p>'
        "</td></tr></table>"
        f"{resume_html}"
    )

    return render_viread_email_shell(
        locale=safe_lang,
        title=subject,
        preheader=fact_paragraph or subject,
        accent_color=COLOR_DESK_ACCENT,
        header_bg=COLOR_DESK_SURFACE,
        header_text_color=COLOR_INK,
        header_border_color=COLOR_DESK_BORDER,
        badge_label=badge_label,
        badge_bg=COLOR_WHITE,
        badge_text_color=COLOR_DESK_ACCENT,
        badge_border=COLOR_DESK_BORDER,
        greeting=greeting,
        body_html=body_html,
        cta_label=effective_cta,
        cta_url=app_url,
        cta_bg=COLOR_PRIMARY,
        footer_context="neutral_presence",
        footer_note=optout_paragraph,
    )


def render_support_feedback_html(
    *,
    category: str,
    category_label: str,
    subject: str,
    contact_email: str,
    submitted_at_utc: str,
    message: str,
) -> str:
    """Render framed support operations ticket for SUPPORT_FEEDBACK (6 categories)."""
    style = SUPPORT_CATEGORY_STYLES.get(category, SUPPORT_CATEGORY_STYLES["other"])
    category_pill = _render_pill(
        category_label,
        bg=style["pill_bg"],
        text_color=style["pill_text"],
        border_color=style["pill_border"],
    )

    reply_mailto = build_mailto_url(contact_email, subject)
    plain_mailto = build_mailto_url(contact_email, "")
    contact_cell_html = (
        f'<a href="{escape_text(plain_mailto)}" '
        f'style="color:{COLOR_PRIMARY};font-weight:700;text-decoration:underline;">'
        f"{escape_text(contact_email)}</a>"
        if plain_mailto
        else escape_text(contact_email)
    )

    metadata_rows = (
        ("Sản phẩm", "ViRead"),
        ("Loại yêu cầu", category_pill),
        ("Tiêu đề", escape_text(subject)),
        ("Email liên hệ", contact_cell_html),
        (
            "Thời điểm (UTC)",
            f'<span dir="ltr" style="unicode-bidi:isolate;">{escape_text(submitted_at_utc)}</span>',
        ),
    )

    rendered_rows: list[str] = []
    for idx, (label, value_html) in enumerate(metadata_rows):
        border_bottom = (
            f"border-bottom:1px solid {COLOR_DIVIDER};"
            if idx < len(metadata_rows) - 1
            else ""
        )
        rendered_rows.append(
            "<tr>"
            f'<td width="36%" valign="top" style="width:36%;padding:10px 12px;'
            f'{border_bottom}font-family:{FONT_STACK};font-size:12px;font-weight:700;'
            f'line-height:1.45;color:{COLOR_MUTED};vertical-align:top;'
            f'word-break:break-word;overflow-wrap:anywhere;">{escape_text(label)}</td>'
            f'<td width="64%" valign="top" style="width:64%;padding:10px 12px;'
            f'{border_bottom}font-family:{FONT_STACK};font-size:14px;'
            f'line-height:1.5;color:{COLOR_INK};vertical-align:top;'
            f'word-break:break-word;overflow-wrap:anywhere;">{value_html}</td>'
            "</tr>"
        )

    body_html = (
        '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" '
        f'border="0" bgcolor="{COLOR_CREAM}" '
        f'style="width:100%;background-color:{COLOR_CREAM};'
        f'border:1px solid {COLOR_BORDER};border-radius:12px;'
        'border-collapse:separate;border-spacing:0;overflow:hidden;'
        'table-layout:fixed;margin:0 0 18px;">'
        + "".join(rendered_rows)
        + "</table>"
        '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" '
        f'border="0" bgcolor="{COLOR_WHITE}" '
        f'style="width:100%;background-color:{COLOR_WHITE};'
        f'border:1px solid {COLOR_BORDER};border-left:4px solid {COLOR_PURPLE_INK};'
        'border-radius:12px;border-collapse:separate;border-spacing:0;'
        'table-layout:fixed;">'
        '<tr><td style="padding:16px 18px;word-break:break-word;overflow-wrap:anywhere;">'
        f'<div style="font-family:{FONT_STACK};font-size:12px;font-weight:800;'
        f'letter-spacing:0.03em;text-transform:uppercase;color:{COLOR_PURPLE_INK};'
        'margin-bottom:8px;">Nội dung phản hồi</div>'
        f'<div style="font-family:{FONT_STACK};font-size:14px;line-height:1.65;'
        f'color:{COLOR_INK};word-break:break-word;overflow-wrap:anywhere;">'
        f"{escape_multiline(message)}</div>"
        "</td></tr></table>"
    )

    return render_viread_email_shell(
        locale="vi",
        title=subject,
        subtitle="Phiếu tiếp nhận Trợ giúp & Hỗ trợ · ViRead",
        preheader=f"[{category_label}] {subject} — {contact_email}",
        accent_color=COLOR_PURPLE_INK,
        header_bg=COLOR_PURPLE_SURFACE,
        header_text_color=COLOR_INK,
        header_border_color=COLOR_PURPLE_BORDER,
        badge_label=category_label,
        badge_bg=(
            COLOR_WHITE
            if style["pill_bg"] == COLOR_PURPLE_SURFACE
            else style["pill_bg"]
        ),
        badge_text_color=style["pill_text"],
        badge_border=style["pill_border"],
        greeting=None,
        body_html=body_html,
        cta_label="Phản hồi qua email" if reply_mailto else None,
        cta_url=reply_mailto,
        cta_bg=COLOR_PURPLE_INK,
        allow_mailto_cta=True,
        footer_context="support_ops",
        footer_note="Email này được gửi từ biểu mẫu Trợ giúp & hỗ trợ của ViRead.",
    )
