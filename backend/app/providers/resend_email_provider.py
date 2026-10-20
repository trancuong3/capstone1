"""Server-side Resend adapter for parent reading reminders."""
from __future__ import annotations

import html
from datetime import datetime
from urllib.parse import urljoin, urlparse
from zoneinfo import ZoneInfo

import httpx

from app.database.config import READING_REMINDER_APP_URL, READING_REMINDER_FROM_EMAIL, RESEND_API_KEY


class ResendEmailProviderError(Exception):
    """Sanitized provider failure safe to persist as a normalized error code."""

    def __init__(self, code: str, *, retryable: bool):
        self.code = code
        self.retryable = retryable
        super().__init__(code)


def build_reminder_message(scheduled_for: datetime, timezone_name: str, app_url: str) -> tuple[str, str, str]:
    """Build equivalent Vietnamese plain-text and HTML reminder messages."""
    local = scheduled_for.astimezone(ZoneInfo(timezone_name))
    local_time = local.strftime("%H:%M")
    local_date = local.strftime("%d/%m/%Y")
    link = urljoin(app_url.rstrip("/") + "/", "reading-management")
    subject = "ViRead nhắc ba mẹ: Đã đến giờ đọc sách cùng bé"
    text_body = (
        "Chào ba mẹ,\n\n"
        "Đây là lời nhắc từ ViRead rằng đã đến thời gian đọc sách theo lịch gia đình đã cài đặt.\n"
        f"Thời gian theo lịch: {local_time}, ngày {local_date} ({timezone_name}).\n\n"
        "Ba mẹ hãy dành ít phút đồng hành cùng bé, cùng đọc một câu chuyện và khuyến khích bé "
        "đọc thành tiếng trong không khí thoải mái.\n\n"
        "Ba mẹ có thể mở ViRead để tiếp tục theo dõi kế hoạch đọc và tiến độ của bé:\n"
        f"{link}\n\nTrân trọng,\n\nViRead — Duy Tan University"
    )
    safe_link = html.escape(link, quote=True)
    html_body = (
        '<div style="font-family:Arial,sans-serif;line-height:1.6;color:#213547">'
        "<p>Chào ba mẹ,</p>"
        "<p>Đây là lời nhắc từ ViRead rằng đã đến thời gian đọc sách theo lịch gia đình đã cài đặt.</p>"
        f"<p><strong>Thời gian theo lịch:</strong> {html.escape(local_time)} ngày "
        f"{html.escape(local_date)} ({html.escape(timezone_name)}).</p>"
        "<p>Ba mẹ hãy dành ít phút đồng hành cùng bé, cùng đọc một câu chuyện và khuyến khích "
        "bé đọc thành tiếng trong không khí thoải mái.</p>"
        "<p>Ba mẹ có thể mở ViRead để tiếp tục theo dõi kế hoạch đọc và tiến độ của bé.</p>"
        f'<p><a href="{safe_link}">Mở ViRead</a></p>'
        "<p>Trân trọng,<br>ViRead — Duy Tan University</p></div>"
    )
    return subject, text_body, html_body


class ResendEmailProvider:
    """Injectable Resend adapter; credentials remain server-side."""

    endpoint = "https://api.resend.com/emails"

    def __init__(self, api_key: str | None = RESEND_API_KEY,
                 from_email: str | None = READING_REMINDER_FROM_EMAIL,
                 app_url: str | None = READING_REMINDER_APP_URL,
                 transport: httpx.AsyncBaseTransport | None = None):
        self._api_key = api_key.strip() if api_key else None
        self._from_email = from_email.strip() if from_email else None
        self._app_url = app_url.strip() if app_url else None
        self._transport = transport

    @property
    def is_configured(self) -> bool:
        if not self._api_key or not self._from_email or not self._app_url:
            return False
        parsed = urlparse(self._app_url)
        return parsed.scheme in {"http", "https"} and bool(parsed.netloc)

    async def send_reminder(self, *, to_email: str, scheduled_for: datetime,
                            timezone_name: str, idempotency_key: str) -> str | None:
        if not self.is_configured:
            raise ResendEmailProviderError("email_provider_not_configured", retryable=False)
        if not to_email or "@" not in to_email:
            raise ResendEmailProviderError("recipient_email_invalid", retryable=False)
        subject, text_body, html_body = build_reminder_message(
            scheduled_for, timezone_name, self._app_url or ""
        )
        payload = {
            "from": self._from_email, "to": [to_email], "subject": subject,
            "text": text_body, "html": html_body,
        }
        headers = {
            "Authorization": "Bearer " + (self._api_key or ""),
            "Content-Type": "application/json",
            "Idempotency-Key": "viread-reading-reminder-" + idempotency_key,
        }
        try:
            async with httpx.AsyncClient(timeout=httpx.Timeout(12.0), transport=self._transport) as client:
                response = await client.post(self.endpoint, headers=headers, json=payload)
        except (httpx.TimeoutException, httpx.NetworkError):
            raise ResendEmailProviderError("provider_network_or_timeout", retryable=True) from None
        except httpx.HTTPError:
            raise ResendEmailProviderError("provider_transport_error", retryable=True) from None
        if response.status_code == 429:
            raise ResendEmailProviderError("provider_rate_limited", retryable=True)
        if response.status_code >= 500:
            raise ResendEmailProviderError("provider_server_error", retryable=True)
        if response.status_code < 200 or response.status_code >= 300:
            raise ResendEmailProviderError("provider_rejected_request", retryable=False)
        try:
            result = response.json()
        except ValueError:
            result = {}
        provider_id = result.get("id") if isinstance(result, dict) else None
        return provider_id if isinstance(provider_id, str) and provider_id else None
