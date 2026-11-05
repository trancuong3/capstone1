from __future__ import annotations

import asyncio
import logging
import smtplib
import ssl
from email.message import EmailMessage
from email.utils import formataddr
from typing import Any

from app.database import config as settings

logger = logging.getLogger(__name__)


class SupportEmailNotConfiguredError(Exception):
    """Required server-side SMTP settings are missing."""


class SupportEmailDeliveryError(Exception):
    """The configured SMTP server did not accept the support message."""


class SupportEmailProvider:
    """SMTP transport whose recipient is fixed by backend configuration."""

    @staticmethod
    def _required_settings() -> dict[str, Any]:
        values = {
            "host": settings.SMTP_HOST,
            "port": settings.SMTP_PORT,
            "username": settings.SMTP_USERNAME,
            "password": settings.SMTP_APP_PASSWORD,
            "sender": settings.SMTP_FROM_EMAIL,
            "recipient": settings.SUPPORT_EMAIL,
            "timeout": settings.SMTP_SEND_TIMEOUT_SECONDS,
        }
        required = (
            "host",
            "port",
            "username",
            "password",
            "sender",
            "recipient",
            "timeout",
        )
        if not all(values[name] for name in required):
            raise SupportEmailNotConfiguredError()
        return values

    @staticmethod
    def _send_sync(message: EmailMessage, smtp_settings: dict[str, Any]) -> None:
        host = str(smtp_settings["host"])
        port = int(smtp_settings["port"])
        timeout = float(smtp_settings["timeout"])
        username = str(smtp_settings["username"])
        password = str(smtp_settings["password"])

        if port == 465:
            with smtplib.SMTP_SSL(
                host,
                port,
                timeout=timeout,
                context=ssl.create_default_context(),
            ) as server:
                server.login(username, password)
                server.send_message(message)
            return

        with smtplib.SMTP(host, port, timeout=timeout) as server:
            server.ehlo()
            server.starttls(context=ssl.create_default_context())
            server.ehlo()
            server.login(username, password)
            server.send_message(message)

    async def send(self, *, subject: str, body: str, reply_to: str) -> None:
        smtp_settings = self._required_settings()
        message = EmailMessage()
        message["Subject"] = subject
        message["From"] = formataddr(("ViRead", str(smtp_settings["sender"])))
        message["To"] = str(smtp_settings["recipient"])
        message["Reply-To"] = reply_to
        message.set_content(body)

        try:
            await asyncio.to_thread(self._send_sync, message, smtp_settings)
        except (smtplib.SMTPException, OSError, TimeoutError) as error:
            logger.warning(
                "Support email delivery failed (exception_type=%s)",
                type(error).__name__,
            )
            raise SupportEmailDeliveryError() from error
        except Exception as error:
            logger.error(
                "Unexpected support email provider failure (exception_type=%s)",
                type(error).__name__,
            )
            raise SupportEmailDeliveryError() from error
