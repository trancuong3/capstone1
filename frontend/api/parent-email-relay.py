"""Private SMTP relay: Render calls HTTPS; only this Vercel function opens SMTP.

Uses Python's standard library, with no frontend or OCR dependencies.
"""

import hashlib
import hmac
import json
import os
import smtplib
import ssl
import time
from email import policy
from email.parser import BytesParser
from email.utils import getaddresses, parseaddr
from http.server import BaseHTTPRequestHandler

MAX_MESSAGE_BYTES = 256 * 1024


def deliver(body, timestamp, signature):
    """Return a safe HTTP result; never include credentials or SMTP responses."""
    secret = os.environ.get("EMAIL_RELAY_SECRET", "").strip()
    if len(secret) < 32:
        return 503, {"code": "RELAY_NOT_CONFIGURED"}
    try:
        fresh = abs(time.time() - int(timestamp)) <= 60
    except (ValueError, TypeError):
        fresh = False
    expected = hmac.new(
        secret.encode(), str(timestamp).encode() + b"." + body, hashlib.sha256
    ).hexdigest()
    if not fresh or not hmac.compare_digest(expected.encode(), (signature or "").encode()):
        return 401, {"code": "RELAY_UNAUTHORIZED"}
    if not body or len(body) > MAX_MESSAGE_BYTES:
        return 413, {"code": "MESSAGE_SIZE_INVALID"}
    username = os.environ.get("SMTP_USERNAME", "").strip()
    password = os.environ.get("SMTP_APP_PASSWORD", "").replace(" ", "").strip()
    sender = parseaddr(os.environ.get("SMTP_FROM_EMAIL") or username)[1]
    if not username or not password or not sender:
        return 503, {"code": "SMTP_NOT_CONFIGURED"}
    try:
        message = BytesParser(policy=policy.default).parsebytes(body)
        recipients = getaddresses(message.get_all("To", []))
        # One verified parent per delivery. Backend owns verification, limits and dedupe.
        if (
            len(message.get_all("From", [])) != 1
            or len(message.get_all("To", [])) != 1
            or parseaddr(str(message["From"]))[1].lower() != sender.lower()
            or len(recipients) != 1
            or "@" not in recipients[0][1]
            or message.get_all("Cc") or message.get_all("Bcc")
            or any(name.lower().startswith("resent-") for name in message.keys())
        ):
            return 422, {"code": "MESSAGE_ENVELOPE_INVALID"}
    except (ValueError, TypeError):
        return 422, {"code": "MESSAGE_INVALID"}
    # Gmail's TLS submission endpoint is fixed: callers cannot supply an SMTP host.
    try:
        with smtplib.SMTP_SSL(
            "smtp.gmail.com", 465, timeout=10, context=ssl.create_default_context()
        ) as client:
            client.login(username, password)
            client.sendmail(sender, [recipients[0][1]], body)
    except (smtplib.SMTPAuthenticationError, smtplib.SMTPRecipientsRefused,
            smtplib.SMTPSenderRefused):
        return 422, {"code": "SMTP_REJECTED"}
    except (smtplib.SMTPException, OSError):
        return 503, {"code": "SMTP_UNAVAILABLE"}
    return 200, {"status": "SENT"}


class handler(BaseHTTPRequestHandler):
    def log_message(self, *args):
        # Do not let access logs capture request headers, bodies, or recipients.
        pass

    def do_POST(self):
        try:
            size = int(self.headers.get("Content-Length", "0"))
        except ValueError:
            size = 0
        if not 0 < size <= MAX_MESSAGE_BYTES:
            code, result = 413, {"code": "MESSAGE_SIZE_INVALID"}
        else:
            code, result = deliver(
                self.rfile.read(size),
                self.headers.get("X-Email-Relay-Timestamp"),
                self.headers.get("X-Email-Relay-Signature"),
            )
        data = json.dumps(result).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)
