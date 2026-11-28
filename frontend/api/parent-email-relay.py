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
    sender_local, sender_sep, sender_domain = sender.partition("@")
    if (
        not username
        or not password
        or not (sender_local and sender_sep and sender_domain and "." in sender_domain)
    ):
        return 503, {"code": "SMTP_NOT_CONFIGURED"}
    try:
        message = BytesParser(policy=policy.default).parsebytes(body)
        from_headers = message.get_all("From", [])
        to_headers = message.get_all("To", [])
        from_addrs = getaddresses(from_headers)
        recipients = getaddresses(to_headers)
        recipient_addr = recipients[0][1] if len(recipients) == 1 else ""
        rec_local, rec_sep, rec_domain = recipient_addr.partition("@")
        # One verified parent per delivery. Backend owns verification, limits and dedupe.
        if (
            len(from_headers) != 1
            or len(to_headers) != 1
            or any(getattr(hdr, "defects", None) for hdr in (*from_headers, *to_headers))
            or len(from_addrs) != 1
            or from_addrs[0][1].lower() != sender.lower()
            or len(recipients) != 1
            or not (rec_local and rec_sep and rec_domain and "." in rec_domain)
            or message.get_all("Cc") or message.get_all("Bcc")
            or any(name.lower().startswith("resent-") for name in message.keys())
        ):
            return 422, {"code": "MESSAGE_ENVELOPE_INVALID"}
    except (ValueError, TypeError, LookupError, IndexError):
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

    def _write_json(self, code, payload, extra_headers=None):
        data = json.dumps(payload).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Cache-Control", "no-store")
        if extra_headers:
            for key, value in extra_headers.items():
                self.send_header(key, value)
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        if getattr(self, "command", None) != "HEAD":
            self.wfile.write(data)

    def _method_not_allowed(self):
        self._write_json(
            405,
            {"code": "METHOD_NOT_ALLOWED"},
            extra_headers={"Allow": "POST"},
        )

    def do_GET(self):
        self._method_not_allowed()

    def do_HEAD(self):
        self._method_not_allowed()

    def do_OPTIONS(self):
        self._method_not_allowed()

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
        self._write_json(code, result)
