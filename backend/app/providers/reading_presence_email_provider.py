import smtplib
import socket
import ssl
from email.message import EmailMessage
from pathlib import Path
from uuid import UUID

from app.database.config import (
    READING_PRESENCE_MAIL_SINK_DIR,
    READING_REMINDER_APP_URL,
    SMTP_APP_PASSWORD,
    SMTP_FROM_EMAIL,
    SMTP_HOST,
    SMTP_PORT,
    SMTP_SEND_TIMEOUT_SECONDS,
    SMTP_USERNAME,
)
from app.providers.reading_reminder_email_provider import (
    EmailDeliveryNotConfigured,
    email_delivery_is_configured,
)
from app.services.i18n.email_templates import render_reading_presence_email
from app.services.i18n.locales import DEFAULT_LOCALE

SUBJECT = "ViRead đã tạm dừng buổi đọc"


class PresenceEmailRetryable(Exception):
    """A failure that provably happened BEFORE the message left (safe to retry)."""


def build_presence_message(
    *,
    recipient: str,
    child_alias: str | None,
    alert_id: UUID,
    from_email: str | None = None,
    locale: str = DEFAULT_LOCALE,
) -> EmailMessage:
    """The only copy a presence alert may contain.

    It states one fact (ViRead paused because nobody was seen in the frame for a
    while) and nothing else: no book text, transcript, image, location or
    conclusion about the child's safety.
    """
    sender = from_email or SMTP_FROM_EMAIL or "viread@localhost"
    domain = sender.rpartition("@")[2] or "viread.local"
    rendered = render_reading_presence_email(
        locale=locale,
        child_alias=child_alias,
        app_url=READING_REMINDER_APP_URL,
    )
    message = EmailMessage()
    message["From"] = sender
    message["To"] = recipient
    message["Subject"] = rendered.subject
    message["Message-ID"] = f"<reading-presence-{alert_id}@{domain}>"
    message.set_content(rendered.body)
    message["Content-Language"] = rendered.locale
    return message


def _write_to_sink(message: EmailMessage, directory: str) -> None:
    folder = Path(directory)
    folder.mkdir(parents=True, exist_ok=True)
    name = str(message["Message-ID"]).strip("<>").split("@")[0] + ".eml"
    # Mode "x": a second delivery of the same alert fails instead of overwriting.
    with open(folder / name, "xb") as handle:
        handle.write(bytes(message))


def send_presence_email(
    *,
    recipient: str,
    child_alias: str | None,
    alert_id: UUID,
    locale: str = DEFAULT_LOCALE,
) -> None:
    message = build_presence_message(
        recipient=recipient,
        child_alias=child_alias,
        alert_id=alert_id,
        locale=locale,
    )
    if READING_PRESENCE_MAIL_SINK_DIR:
        _write_to_sink(message, READING_PRESENCE_MAIL_SINK_DIR)
        return
    if not email_delivery_is_configured():
        raise EmailDeliveryNotConfigured()
    context = ssl.create_default_context()
    try:
        if SMTP_PORT == 465:
            client = smtplib.SMTP_SSL(
                SMTP_HOST, SMTP_PORT, timeout=SMTP_SEND_TIMEOUT_SECONDS, context=context
            )
        else:
            client = smtplib.SMTP(SMTP_HOST, SMTP_PORT, timeout=SMTP_SEND_TIMEOUT_SECONDS)
    except (smtplib.SMTPConnectError, ConnectionError, socket.gaierror, TimeoutError) as error:
        raise PresenceEmailRetryable() from error
    with client:
        try:
            if SMTP_PORT != 465:
                client.ehlo()
                client.starttls(context=context)
                client.ehlo()
            client.login(SMTP_USERNAME, SMTP_APP_PASSWORD)
        except (smtplib.SMTPException, ConnectionError, TimeoutError) as error:
            # Nothing was sent yet: login/negotiation happens before DATA.
            raise PresenceEmailRetryable() from error
        client.send_message(message)
