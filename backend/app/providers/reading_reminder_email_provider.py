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
) -> EmailMessage:
    if not SMTP_FROM_EMAIL:
        raise EmailDeliveryNotConfigured()
    domain = SMTP_FROM_EMAIL.rpartition("@")[2] or "viread.local"
    message = EmailMessage()
    message["From"] = SMTP_FROM_EMAIL
    message["To"] = recipient
    message["Subject"] = "\u0110\u1ebfn gi\u1edd \u0111\u1ecdc s\u00e1ch c\u00f9ng b\u00e9"
    message["Message-ID"] = f"<reading-reminder-{occurrence_id}@{domain}>"
    message.set_content(
        "Ch\u00e0o ba m\u1eb9,\n\n"
        f"\u0110\u00e3 \u0111\u1ebfn gi\u1edd \u0111\u1ecdc s\u00e1ch c\u00f9ng {child_alias}.\n"
        f"L\u1ecbch \u0111\u1ecdc: {local_date} l\u00fac {local_time} ({timezone_name}).\n\n"
        f"Mở ViRead: {READING_REMINDER_APP_URL}\n\n"
        "Ch\u00fac gia \u0111\u00ecnh c\u00f3 m\u1ed9t bu\u1ed5i \u0111\u1ecdc s\u00e1ch vui v\u1ebb!"
    )
    return message


def send_reading_reminder_email(
    *,
    recipient: str,
    child_alias: str,
    local_date: str,
    local_time: str,
    timezone_name: str,
    occurrence_id: UUID,
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
