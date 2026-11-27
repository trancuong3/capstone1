"""Unified server-side email transport and Vietnamese templates for parent notifications.

Supports:
1. Local mail sink (``PARENT_EMAIL_MAIL_SINK_DIR``) for deterministic local/CI tests.
2. Resend HTTPS API (``RESEND_API_KEY``) — port 443, cloud-friendly, zero SMTP blocks.
3. SMTP / SMTP_SSL (``SMTP_HOST``, ``SMTP_PORT``, ``SMTP_USERNAME``, ``SMTP_APP_PASSWORD``, ``SMTP_FROM_EMAIL``).

Never logs recipient email addresses, SMTP passwords, or API keys.
"""

from __future__ import annotations

import html
import hashlib
import hmac
import time
import smtplib
import socket
import ssl
from dataclasses import dataclass
from email.message import EmailMessage
from email.utils import formataddr, parseaddr
from pathlib import Path
from typing import Sequence
from urllib.parse import urlparse
from uuid import UUID

import httpx

from app.database import config as settings
from app.providers.reading_reminder_email_provider import EmailDeliveryNotConfigured


class EmailTransportRetryable(RuntimeError):
    """Transient network/provider error where retrying later is safe."""


class EmailTransportPermanent(RuntimeError):
    """Non-retryable delivery failure (e.g. rejected sender/domain/auth)."""


@dataclass(frozen=True)
class ChildWeeklyDigestItem:
    child_alias: str
    sessions_count: int
    total_minutes: int
    prev_sessions_count: int
    avg_fluency_score: float | None
    goal_summary: str | None
    top_difficult_words: tuple[str, ...] = ()


@dataclass(frozen=True)
class ChildInactivityItem:
    child_alias: str
    days_inactive: int
    had_prior_sessions: bool


@dataclass(frozen=True)
class ChildMilestoneItem:
    child_alias: str
    milestone_label: str
    detail: str


def _smtp_is_configured() -> bool:
    return bool(
        settings.SMTP_HOST
        and settings.SMTP_PORT
        and settings.SMTP_USERNAME
        and settings.SMTP_APP_PASSWORD
        and (settings.SMTP_FROM_EMAIL or settings.EMAIL_FROM_ADDRESS)
    )


def _resend_is_configured() -> bool:
    return bool(
        settings.RESEND_API_KEY
        and (settings.EMAIL_FROM_ADDRESS or settings.SMTP_FROM_EMAIL)
    )


def active_email_provider() -> str:
    """Return the active delivery backend name without exposing credentials."""
    if settings.PARENT_EMAIL_MAIL_SINK_DIR:
        return "mail_sink"
    mode = settings.EMAIL_PROVIDER
    if mode == "vercel_relay":
        return "vercel_relay" if _relay_is_configured() else "unconfigured"
    if mode == "resend":
        return "resend" if _resend_is_configured() else "unconfigured"
    if mode == "smtp":
        return "smtp" if _smtp_is_configured() else "unconfigured"
    # mode == "auto": prefer Resend HTTPS API when configured, else SMTP.
    if _resend_is_configured():
        return "resend"
    if _relay_is_configured():
        return "vercel_relay"
    if _smtp_is_configured():
        return "smtp"
    return "unconfigured"


def _relay_is_configured() -> bool:
    try:
        url = urlparse(settings.EMAIL_RELAY_URL)
    except ValueError:
        return False
    return bool(
        url.scheme == "https" and url.hostname and not url.username
        and not url.password and not url.fragment
        and len(settings.EMAIL_RELAY_SECRET) >= 32
        and (settings.EMAIL_FROM_ADDRESS or settings.SMTP_FROM_EMAIL)
    )


def _send_via_vercel_relay(message: EmailMessage) -> None:
    if not _relay_is_configured():
        raise EmailDeliveryNotConfigured("Incomplete HTTPS email relay configuration")
    body = message.as_bytes()
    timestamp = str(int(time.time()))
    signature = hmac.new(
        settings.EMAIL_RELAY_SECRET.encode(),
        timestamp.encode() + b"." + body,
        hashlib.sha256,
    ).hexdigest()
    try:
        with httpx.Client(timeout=45.0, follow_redirects=False) as client:
            response = client.post(
                settings.EMAIL_RELAY_URL,
                content=body,
                headers={
                    "Content-Type": "message/rfc822",
                    "X-ViRead-Timestamp": timestamp,
                    "X-ViRead-Signature": signature,
                },
            )
    except (httpx.TransportError, OSError) as error:
        raise EmailTransportRetryable("HTTPS email relay unreachable") from error
    if response.status_code == 200:
        try:
            accepted = response.json().get("status") == "SENT"
        except (ValueError, AttributeError):
            accepted = False
        if accepted:
            return
        raise EmailTransportPermanent("Invalid email relay acknowledgement")
    if response.status_code == 429 or response.status_code >= 500:
        raise EmailTransportRetryable("HTTPS email relay temporarily unavailable")
    raise EmailTransportPermanent("HTTPS email relay rejected request")


def parent_email_delivery_is_configured() -> bool:
    return active_email_provider() != "unconfigured"


def parent_email_automation_readiness() -> tuple[bool, str, str]:
    """Return ``(ready, provider, reason_code)`` without revealing any secret."""
    provider = active_email_provider()
    if provider == "unconfigured":
        return False, "unconfigured", "EMAIL_PROVIDER_UNCONFIGURED"
    if provider != "mail_sink" and not settings.SUPABASE_ADMIN_KEY:
        return False, provider, "SUPABASE_ADMIN_KEY_MISSING"
    return True, provider, "READY"


def extract_sender_email_and_domain(
    raw_sender: str,
    *,
    default_name: str | None = None,
) -> tuple[str, str, str]:
    """Parse ``addr`` or ``Name <addr>`` into ``(formatted_from, clean_email, domain)``."""
    display_name, parsed_addr = parseaddr(raw_sender.strip())
    clean_addr = (parsed_addr or raw_sender).strip().strip("<>").strip()
    if "@" not in clean_addr:
        raise EmailDeliveryNotConfigured("Invalid sender email address.")
    effective_name = (display_name or default_name or "").strip()
    formatted_from = (
        formataddr((effective_name, clean_addr)) if effective_name else clean_addr
    )
    domain = clean_addr.rpartition("@")[2].strip().strip(">") or "viread.local"
    return formatted_from, clean_addr, domain


def is_public_app_url(url: str) -> bool:
    try:
        parsed = urlparse(url)
    except ValueError:
        return False
    host = (parsed.hostname or "").lower()
    if parsed.scheme != "https" or "." not in host:
        return False
    if host in {"localhost", "127.0.0.1", "example.com"} or host.endswith(
        (".local", ".localhost", ".test", ".example")
    ):
        return False
    return True


def _sender_address() -> str:
    sender = settings.EMAIL_FROM_ADDRESS or settings.SMTP_FROM_EMAIL
    if not sender:
        if settings.PARENT_EMAIL_MAIL_SINK_DIR:
            return "viread@localhost"
        raise EmailDeliveryNotConfigured("Missing EMAIL_FROM_ADDRESS / SMTP_FROM_EMAIL.")
    return sender


def _app_base_url() -> str:
    return (settings.PARENT_EMAIL_APP_URL or "http://localhost:3000").rstrip("/")


def _settings_url() -> str:
    return f"{_app_base_url()}/settings#email-notifications"


def _wrap_html(*, title: str, greeting: str, body_html: str, cta_label: str, cta_url: str, footer_note: str) -> str:
    safe_title = html.escape(title)
    safe_greeting = html.escape(greeting)
    safe_cta_label = html.escape(cta_label)
    safe_cta_url = html.escape(cta_url, quote=True)
    safe_settings_url = html.escape(_settings_url(), quote=True)
    safe_footer = html.escape(footer_note)
    return (
        "<!DOCTYPE html>"
        '<html lang="vi"><body style="margin:0;padding:24px;background:#f4f7fb;'
        'font-family:-apple-system,BlinkMacSystemFont,Segoe UI,Roboto,Arial,sans-serif;color:#1e293b;">'
        '<div style="max-width:560px;margin:0 auto;background:#ffffff;border-radius:16px;'
        'border:1px solid #e2e8f0;padding:28px;">'
        '<div style="font-size:13px;font-weight:700;letter-spacing:0.04em;color:#2563eb;'
        'text-transform:uppercase;margin-bottom:8px;">ViRead</div>'
        f'<h1 style="margin:0 0 16px;font-size:20px;line-height:1.35;color:#0f172a;">{safe_title}</h1>'
        f'<p style="margin:0 0 14px;font-size:15px;line-height:1.6;">{safe_greeting}</p>'
        f'{body_html}'
        '<div style="margin:24px 0 18px;">'
        f'<a href="{safe_cta_url}" style="display:inline-block;background:#2563eb;color:#ffffff;'
        'text-decoration:none;font-weight:700;font-size:15px;padding:12px 20px;border-radius:10px;">'
        f'{safe_cta_label}</a>'
        "</div>"
        '<hr style="border:none;border-top:1px solid #e2e8f0;margin:20px 0;"/>'
        f'<p style="margin:0;font-size:12px;line-height:1.6;color:#64748b;">{safe_footer} '
        f'<a href="{safe_settings_url}" style="color:#2563eb;">Quản lý thông báo email</a>.</p>'
        "</div></body></html>"
    )


def _build_multipart_message(
    *,
    recipient: str,
    subject: str,
    text_body: str,
    html_body: str,
    message_id_key: str,
) -> EmailMessage:
    formatted_from, _clean_email, domain = extract_sender_email_and_domain(
        _sender_address(),
        default_name=settings.EMAIL_FROM_NAME,
    )
    message = EmailMessage()
    message["From"] = formatted_from
    message["To"] = recipient
    message["Subject"] = subject
    message["Message-ID"] = f"<{message_id_key}@{domain}>"
    message["List-Unsubscribe"] = f"<{_settings_url()}>"
    message.set_content(text_body)
    message.add_alternative(html_body, subtype="html")
    return message


def build_weekly_digest_message(
    *,
    recipient: str,
    parent_name: str | None,
    week_label: str,
    items: Sequence[ChildWeeklyDigestItem],
    delivery_id: UUID,
) -> EmailMessage:
    greeting = f"Chào {parent_name}," if parent_name else "Chào ba mẹ,"
    subject = f"Báo cáo đọc sách tuần {week_label} của gia đình trên ViRead"
    total_sessions = sum(item.sessions_count for item in items)
    total_minutes = sum(item.total_minutes for item in items)

    text_lines = [
        greeting,
        "",
        f"Tổng kết 7 ngày qua ({week_label}) trên ViRead: {total_sessions} buổi đọc ({total_minutes} phút).",
        "",
    ]
    html_blocks = [
        '<p style="margin:0 0 16px;font-size:15px;line-height:1.6;">'
        f'Tổng kết 7 ngày qua ({html.escape(week_label)}): '
        f'<strong>{total_sessions} buổi đọc</strong> ({total_minutes} phút).</p>'
    ]

    for item in items:
        if item.sessions_count > 0:
            delta = item.sessions_count - item.prev_sessions_count
            trend = (
                f" (+{delta} so với tuần trước)"
                if delta > 0
                else f" ({delta} so với tuần trước)"
                if delta < 0
                else ""
            )
            score_part = (
                f" • Độ trôi chảy TB: {round(item.avg_fluency_score)}%"
                if item.avg_fluency_score is not None
                else ""
            )
            line = f"- {item.child_alias}: {item.sessions_count} buổi ({item.total_minutes} phút){trend}{score_part}"
        else:
            line = f"- {item.child_alias}: Tuần này bé chưa có buổi đọc nào. Ba mẹ có thể chọn một truyện ngắn 5–10 phút để khởi động lại nhé."
        text_lines.append(line)
        if item.goal_summary:
            text_lines.append(f"  Mục tiêu: {item.goal_summary}")
        if item.top_difficult_words:
            text_lines.append(
                f"  Từ cần luyện thêm: {', '.join(item.top_difficult_words[:5])}"
            )

        safe_alias = html.escape(item.child_alias)
        card_parts = [
            f'<div style="font-weight:700;color:#0f172a;margin-bottom:4px;">{safe_alias}</div>'
        ]
        if item.sessions_count > 0:
            card_parts.append(
                f'<div style="font-size:14px;color:#334155;">'
                f'{item.sessions_count} buổi đọc · {item.total_minutes} phút'
                + (
                    f' · Độ trôi chảy TB: {round(item.avg_fluency_score)}%'
                    if item.avg_fluency_score is not None
                    else ""
                )
                + "</div>"
            )
        else:
            card_parts.append(
                '<div style="font-size:14px;color:#475569;">Tuần này bé chưa có buổi đọc nào. '
                "Một buổi đọc ngắn 5–10 phút cùng ba mẹ sẽ giúp bé giữ thói quen tốt.</div>"
            )
        if item.goal_summary:
            card_parts.append(
                f'<div style="font-size:13px;color:#2563eb;margin-top:4px;">Mục tiêu: {html.escape(item.goal_summary)}</div>'
            )
        if item.top_difficult_words:
            words_csv = ", ".join(html.escape(w) for w in item.top_difficult_words[:5])
            card_parts.append(
                f'<div style="font-size:13px;color:#64748b;margin-top:4px;">Từ cần luyện thêm: {words_csv}</div>'
            )
        html_blocks.append(
            '<div style="background:#f8fafc;border:1px solid #e2e8f0;border-radius:12px;'
            'padding:14px;margin-bottom:10px;">' + "".join(card_parts) + "</div>"
        )

    cta_url = f"{_app_base_url()}/reports"
    text_lines.extend(
        [
            "",
            f"Xem báo cáo chi tiết: {cta_url}",
            f"Quản lý tần suất hoặc tắt email này: {_settings_url()}",
        ]
    )
    html_body = _wrap_html(
        title=f"Báo cáo đọc sách tuần {week_label}",
        greeting=greeting,
        body_html="".join(html_blocks),
        cta_label="Xem báo cáo tiến độ",
        cta_url=cta_url,
        footer_note="ViRead chỉ gửi báo cáo tổng hợp tối đa 1 lần mỗi tuần.",
    )
    return _build_multipart_message(
        recipient=recipient,
        subject=subject,
        text_body="\n".join(text_lines),
        html_body=html_body,
        message_id_key=f"parent-weekly-digest-{delivery_id}",
    )


def build_inactivity_alert_message(
    *,
    recipient: str,
    parent_name: str | None,
    items: Sequence[ChildInactivityItem],
    delivery_id: UUID,
) -> EmailMessage:
    greeting = f"Chào {parent_name}," if parent_name else "Chào ba mẹ,"
    if len(items) == 1:
        subject = f"Nhắc nhẹ: {items[0].child_alias} đã {items[0].days_inactive} ngày chưa đọc sách trên ViRead"
    else:
        subject = "Nhắc nhẹ: Các bé đã vài ngày chưa đọc sách trên ViRead"

    text_lines = [
        greeting,
        "",
        "ViRead gửi lời nhắc nhẹ để giúp bé giữ thói quen đọc sách đều đặn:",
        "",
    ]
    html_items = []
    for item in items:
        if item.had_prior_sessions:
            line = f"- {item.child_alias}: đã {item.days_inactive} ngày kể từ buổi đọc gần nhất."
        else:
            line = f"- {item.child_alias}: đã {item.days_inactive} ngày nhưng chưa bắt đầu buổi đọc đầu tiên."
        text_lines.append(line)
        html_items.append(
            f'<li style="margin-bottom:6px;font-size:14px;color:#334155;">{html.escape(line[2:])}</li>'
        )

    cta_url = f"{_app_base_url()}/books"
    text_lines.extend(
        [
            "",
            "Chỉ cần 5–10 phút đọc một truyện ngắn hôm nay là bé đã duy trì được thói quen tốt rồi!",
            f"Chọn sách cho bé: {cta_url}",
            "",
            "Để không làm phiền ba mẹ, ViRead giới hạn nhắc tối đa 1 lần/tuần và sẽ tự tạm dừng nếu gia đình đang bận.",
            f"Thay đổi ngưỡng ngày hoặc tắt nhắc: {_settings_url()}",
        ]
    )
    html_body = _wrap_html(
        title="Nhắc nhẹ giữ thói quen đọc sách",
        greeting=greeting,
        body_html=(
            '<p style="margin:0 0 12px;font-size:15px;line-height:1.6;">'
            "ViRead gửi lời nhắc nhẹ để ba mẹ cùng bé duy trì thói quen đọc đều đặn:</p>"
            f'<ul style="margin:0 0 14px;padding-left:20px;">{"".join(html_items)}</ul>'
            '<p style="margin:0;font-size:14px;line-height:1.6;color:#475569;">'
            "Chỉ cần 5–10 phút đọc một truyện ngắn hôm nay là bé đã duy trì được đà tiến bộ rồi.</p>"
        ),
        cta_label="Chọn sách đọc cùng bé",
        cta_url=cta_url,
        footer_note="ViRead tự động giới hạn tần suất và dừng nhắc nếu gia đình đang nghỉ dài ngày.",
    )
    return _build_multipart_message(
        recipient=recipient,
        subject=subject,
        text_body="\n".join(text_lines),
        html_body=html_body,
        message_id_key=f"parent-inactivity-{delivery_id}",
    )


def build_milestone_message(
    *,
    recipient: str,
    parent_name: str | None,
    items: Sequence[ChildMilestoneItem],
    delivery_id: UUID,
) -> EmailMessage:
    greeting = f"Chào {parent_name}," if parent_name else "Chào ba mẹ,"
    if len(items) == 1:
        subject = f"Chúc mừng {items[0].child_alias}: {items[0].milestone_label}!"
    else:
        subject = "Chúc mừng cột mốc đọc sách mới của gia đình trên ViRead!"

    text_lines = [greeting, "", "Tin vui từ hành trình đọc sách trên ViRead:", ""]
    html_cards = []
    for item in items:
        text_lines.append(f"- {item.child_alias}: {item.milestone_label} — {item.detail}")
        html_cards.append(
            '<div style="background:#eff6ff;border:1px solid #bfdbfe;border-radius:12px;'
            'padding:14px;margin-bottom:10px;">'
            f'<div style="font-weight:700;color:#1d4ed8;">{html.escape(item.child_alias)} · {html.escape(item.milestone_label)}</div>'
            f'<div style="font-size:14px;color:#1e3a8a;margin-top:4px;">{html.escape(item.detail)}</div>'
            "</div>"
        )

    cta_url = f"{_app_base_url()}/reports"
    text_lines.extend(
        [
            "",
            "Ba mẹ nhớ dành cho bé một lời khen thật ấm áp nhé!",
            f"Xem thành tích của bé: {cta_url}",
            f"Quản lý thông báo email: {_settings_url()}",
        ]
    )
    html_body = _wrap_html(
        title="Chúc mừng cột mốc đọc sách mới!",
        greeting=greeting,
        body_html=(
            "".join(html_cards)
            + '<p style="margin:6px 0 0;font-size:14px;line-height:1.6;color:#475569;">'
            "Ba mẹ nhớ dành cho bé một lời khen thật ấm áp nhé!</p>"
        ),
        cta_label="Xem thành tích của bé",
        cta_url=cta_url,
        footer_note="Mỗi cột mốc chỉ được gửi chúc mừng một lần duy nhất.",
    )
    return _build_multipart_message(
        recipient=recipient,
        subject=subject,
        text_body="\n".join(text_lines),
        html_body=html_body,
        message_id_key=f"parent-milestone-{delivery_id}",
    )


def build_test_email_message(
    *,
    recipient: str,
    parent_name: str | None,
    delivery_id: UUID,
) -> EmailMessage:
    greeting = f"Chào {parent_name}," if parent_name else "Chào ba mẹ,"
    subject = "ViRead: Xác nhận kết nối email thông báo thành công"
    cta_url = _settings_url()
    text_body = (
        f"{greeting}\n\n"
        "Email thông báo phụ huynh từ ViRead đã hoạt động bình thường.\n"
        "Ba mẹ sẽ chỉ nhận những email hữu ích theo đúng lựa chọn và giới hạn chống spam đã cài đặt.\n\n"
        f"Điều chỉnh cài đặt thông báo: {cta_url}\n"
    )
    html_body = _wrap_html(
        title="Kết nối email thông báo thành công",
        greeting=greeting,
        body_html=(
            '<p style="margin:0 0 12px;font-size:15px;line-height:1.6;">'
            "Email thông báo phụ huynh từ <strong>ViRead</strong> đã hoạt động bình thường.</p>"
            '<p style="margin:0;font-size:14px;line-height:1.6;color:#475569;">'
            "Ba mẹ luôn có thể tùy chỉnh báo cáo tuần, nhắc nghỉ đọc lâu, chúc mừng cột mốc và khung giờ yên tĩnh.</p>"
        ),
        cta_label="Mở cài đặt thông báo",
        cta_url=cta_url,
        footer_note="Email này được gửi theo yêu cầu kiểm tra từ trang Cài đặt tài khoản.",
    )
    return _build_multipart_message(
        recipient=recipient,
        subject=subject,
        text_body=text_body,
        html_body=html_body,
        message_id_key=f"parent-test-email-{delivery_id}",
    )


def _write_to_mail_sink(message: EmailMessage, directory: str) -> None:
    folder = Path(directory)
    folder.mkdir(parents=True, exist_ok=True)
    name = str(message["Message-ID"]).strip("<>").split("@")[0] + ".eml"
    with open(folder / name, "xb") as handle:
        handle.write(bytes(message))


def _send_via_resend(message: EmailMessage) -> None:
    api_key = settings.RESEND_API_KEY
    if not api_key:
        raise EmailDeliveryNotConfigured("RESEND_API_KEY is missing.")
    plain_part = message.get_body(preferencelist=("plain",))
    html_part = message.get_body(preferencelist=("html",))
    payload: dict[str, object] = {
        "from": str(message["From"]),
        "to": [str(message["To"])],
        "subject": str(message["Subject"]),
        "text": plain_part.get_content() if plain_part is not None else "",
        "headers": {
            "X-Entity-Ref-ID": str(message["Message-ID"]).strip("<>"),
        },
    }
    if html_part is not None:
        payload["html"] = html_part.get_content()
    if message["List-Unsubscribe"]:
        headers = payload["headers"]
        assert isinstance(headers, dict)
        headers["List-Unsubscribe"] = str(message["List-Unsubscribe"])

    url = f"{settings.RESEND_API_BASE_URL}/emails"
    try:
        with httpx.Client(
            timeout=httpx.Timeout(settings.SMTP_SEND_TIMEOUT_SECONDS),
            follow_redirects=False,
        ) as client:
            response = client.post(
                url,
                headers={
                    "Authorization": f"Bearer {api_key}",
                    "Content-Type": "application/json",
                },
                json=payload,
            )
    except (httpx.TimeoutException, httpx.TransportError, OSError) as error:
        raise EmailTransportRetryable("Resend API unreachable") from error

    if 200 <= response.status_code < 300:
        return
    if response.status_code == 429 or response.status_code >= 500:
        raise EmailTransportRetryable(f"Resend temporary status {response.status_code}")
    raise EmailTransportPermanent(f"Resend rejected message ({response.status_code})")


def _send_via_smtp(message: EmailMessage) -> None:
    if not _smtp_is_configured():
        raise EmailDeliveryNotConfigured("Incomplete SMTP configuration.")
    context = ssl.create_default_context()
    try:
        if settings.SMTP_PORT == 465:
            client: smtplib.SMTP = smtplib.SMTP_SSL(
                settings.SMTP_HOST,
                settings.SMTP_PORT,
                timeout=settings.SMTP_SEND_TIMEOUT_SECONDS,
                context=context,
            )
        else:
            client = smtplib.SMTP(
                settings.SMTP_HOST,
                settings.SMTP_PORT,
                timeout=settings.SMTP_SEND_TIMEOUT_SECONDS,
            )
    except (smtplib.SMTPConnectError, ConnectionError, socket.gaierror, TimeoutError, OSError) as error:
        raise EmailTransportRetryable("SMTP connection failed") from error

    with client:
        try:
            if settings.SMTP_PORT != 465:
                client.ehlo()
                client.starttls(context=context)
                client.ehlo()
            client.login(settings.SMTP_USERNAME, settings.SMTP_APP_PASSWORD)
        except smtplib.SMTPAuthenticationError as error:
            raise EmailTransportPermanent("SMTP authentication rejected") from error
        except (smtplib.SMTPException, ConnectionError, TimeoutError, OSError) as error:
            raise EmailTransportRetryable("SMTP negotiation failed") from error
        try:
            client.send_message(message)
        except smtplib.SMTPRecipientsRefused as error:
            raise EmailTransportPermanent("SMTP recipient refused") from error
        except (smtplib.SMTPException, ConnectionError, TimeoutError, OSError) as error:
            raise EmailTransportRetryable("SMTP send failed") from error


def send_email_message(message: EmailMessage) -> str:
    """Deliver a built EmailMessage via the active provider. Returns provider name."""
    provider = active_email_provider()
    if provider == "mail_sink":
        assert settings.PARENT_EMAIL_MAIL_SINK_DIR is not None
        _write_to_mail_sink(message, settings.PARENT_EMAIL_MAIL_SINK_DIR)
        return provider
    if provider == "resend":
        _send_via_resend(message)
        return provider
    if provider == "smtp":
        _send_via_smtp(message)
        return provider
    if provider == "vercel_relay":
        _send_via_vercel_relay(message)
        return provider
    raise EmailDeliveryNotConfigured(
        "Configure RESEND_API_KEY + EMAIL_FROM_ADDRESS or SMTP_* credentials."
    )
