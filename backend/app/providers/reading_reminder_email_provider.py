from email.message import EmailMessage
import smtplib
import ssl
from uuid import UUID

from app.database.config import (
    READING_REMINDER_APP_URL,
    SMTP_APP_PASSWORD,
    SMTP_FROM_EMAIL,
    SMTP_HOST,
    SMTP_PORT,
    SMTP_SEND_TIMEOUT_SECONDS,
    SMTP_USERNAME,
)
from app.services.i18n.email_templates import render_reading_reminder_email
from app.services.i18n.locales import DEFAULT_LOCALE


class EmailDeliveryNotConfigured(RuntimeError):
    """Raised when the server does not have complete SMTP credentials."""


def email_delivery_is_configured() -> bool:
    return bool(SMTP_HOST and SMTP_PORT and SMTP_USERNAME and SMTP_APP_PASSWORD and SMTP_FROM_EMAIL)


def build_reading_reminder_message(
    *,
    recipient: str,
    child_alias: str,
    local_date: str,
    local_time: str,
    timezone_name: str,
    occurrence_id: UUID,
    locale: str = DEFAULT_LOCALE,
) -> EmailMessage:
    if not SMTP_FROM_EMAIL:
        raise EmailDeliveryNotConfigured()
    rendered = render_reading_reminder_email(
        locale=locale,
        child_alias=child_alias,
        local_date=local_date,
        local_time=local_time,
        timezone_name=timezone_name,
        app_url=READING_REMINDER_APP_URL,
    )
    domain = SMTP_FROM_EMAIL.rpartition("@")[2] or "viread.local"
    message = EmailMessage()
    message["From"] = SMTP_FROM_EMAIL
    message["To"] = recipient
    message["Subject"] = rendered.subject
    message["Message-ID"] = f"<reading-reminder-{occurrence_id}@{domain}>"
    message.set_content(rendered.body)
    message["Content-Language"] = rendered.locale
    return message


def send_reading_reminder_email(
    *,
    recipient: str,
    child_alias: str,
    local_date: str,
    local_time: str,
    timezone_name: str,
    occurrence_id: UUID,
    locale: str = DEFAULT_LOCALE,
) -> None:
    if not email_delivery_is_configured():
        raise EmailDeliveryNotConfigured()
    message = build_reading_reminder_message(
        recipient=recipient,
        child_alias=child_alias,
        local_date=local_date,
        local_time=local_time,
        timezone_name=timezone_name,
        occurrence_id=occurrence_id,
        locale=locale,
    )
    context = ssl.create_default_context()
    if SMTP_PORT == 465:
        with smtplib.SMTP_SSL(
            SMTP_HOST, SMTP_PORT, timeout=SMTP_SEND_TIMEOUT_SECONDS, context=context
        ) as client:
            client.login(SMTP_USERNAME, SMTP_APP_PASSWORD)
            client.send_message(message)
        return

    with smtplib.SMTP(SMTP_HOST, SMTP_PORT, timeout=SMTP_SEND_TIMEOUT_SECONDS) as client:
        client.ehlo()
        client.starttls(context=context)
        client.ehlo()
        client.login(SMTP_USERNAME, SMTP_APP_PASSWORD)
        client.send_message(message)
