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
    from app.database import config as settings

    has_smtp = bool(
        SMTP_HOST
        and SMTP_PORT
        and SMTP_USERNAME
        and SMTP_APP_PASSWORD
        and (SMTP_FROM_EMAIL or settings.EMAIL_FROM_ADDRESS)
    )
    has_resend = bool(
        settings.RESEND_API_KEY and (settings.EMAIL_FROM_ADDRESS or SMTP_FROM_EMAIL)
    )
    if settings.EMAIL_PROVIDER == "resend":
        return has_resend
    if settings.EMAIL_PROVIDER == "smtp":
        return has_smtp
    return has_resend or has_smtp


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
    from app.database import config as settings
    from app.providers.parent_email_transport import extract_sender_email_and_domain

    raw_sender = SMTP_FROM_EMAIL or settings.EMAIL_FROM_ADDRESS
    if not raw_sender:
        if settings.PARENT_EMAIL_MAIL_SINK_DIR:
            raw_sender = "viread@localhost"
        else:
            raise EmailDeliveryNotConfigured()
    formatted_from, _clean_email, domain = extract_sender_email_and_domain(
        raw_sender,
        default_name=settings.EMAIL_FROM_NAME,
    )
    rendered = render_reading_reminder_email(
        locale=locale,
        child_alias=child_alias,
        local_date=local_date,
        local_time=local_time,
        timezone_name=timezone_name,
        app_url=READING_REMINDER_APP_URL,
    )
    message = EmailMessage()
    message["From"] = formatted_from
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
    from app.providers.parent_email_transport import (
        active_email_provider,
        send_email_message,
    )

    provider = active_email_provider()
    if provider != "mail_sink" and not email_delivery_is_configured():
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
    if provider in {"resend", "mail_sink"}:
        send_email_message(message)
        return
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
