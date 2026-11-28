"""Pure-stdlib unit tests for frontend/api/parent-email-relay.py."""

import hashlib
import hmac
import importlib.util
import io
import json
import os
import smtplib
import time
import unittest
from email.message import EmailMessage
from pathlib import Path
from unittest.mock import MagicMock, patch


def _load_relay_module():
    relay_path = (
        Path(__file__).resolve().parents[2] / "api" / "parent-email-relay.py"
    )
    spec = importlib.util.spec_from_file_location(
        "viread_parent_email_relay", relay_path
    )
    module = importlib.util.module_from_spec(spec)
    assert spec and spec.loader
    spec.loader.exec_module(module)
    return module


relay = _load_relay_module()

TEST_SECRET = "test-relay-hmac-secret-at-least-32-chars"
TEST_SENDER = "noreply@viread.example.com"


def _build_mime(
    *,
    from_addr: str = TEST_SENDER,
    to_addr: str = "parent@example.com",
    extra_headers: dict[str, str] | None = None,
) -> bytes:
    msg = EmailMessage()
    msg["From"] = from_addr
    msg["To"] = to_addr
    msg["Subject"] = "ViRead test"
    for k, v in (extra_headers or {}).items():
        msg[k] = v
    msg.set_content("Xin chao ba me.")
    return msg.as_bytes()


def _sign(body: bytes, secret: str = TEST_SECRET, ts: int | None = None):
    stamp = str(int(time.time()) if ts is None else ts)
    sig = hmac.new(
        secret.encode(), stamp.encode() + b"." + body, hashlib.sha256
    ).hexdigest()
    return stamp, sig


class ParentEmailRelayTests(unittest.TestCase):
    def setUp(self):
        self._env_patch = patch.dict(
            os.environ,
            {
                "EMAIL_RELAY_SECRET": TEST_SECRET,
                "SMTP_USERNAME": TEST_SENDER,
                "SMTP_APP_PASSWORD": "app password 1234",
                "SMTP_FROM_EMAIL": TEST_SENDER,
            },
            clear=False,
        )
        self._env_patch.start()

    def tearDown(self):
        self._env_patch.stop()

    def test_fails_closed_when_relay_secret_missing_or_short(self):
        body = _build_mime()
        ts, sig = _sign(body)
        for bad_secret in ("", "short-secret"):
            with patch.dict(os.environ, {"EMAIL_RELAY_SECRET": bad_secret}):
                code, res = relay.deliver(body, ts, sig)
                self.assertEqual(code, 503)
                self.assertEqual(res, {"code": "RELAY_NOT_CONFIGURED"})

    def test_rejects_invalid_missing_expired_or_future_hmac(self):
        body = _build_mime()
        now = int(time.time())

        # Wrong signature
        code, res = relay.deliver(body, str(now), "bad-sig")
        self.assertEqual(code, 401)
        self.assertEqual(res, {"code": "RELAY_UNAUTHORIZED"})

        # Expired timestamp (> 60s)
        ts_old, sig_old = _sign(body, ts=now - 120)
        code, _ = relay.deliver(body, ts_old, sig_old)
        self.assertEqual(code, 401)

        # Future skew timestamp (> 60s)
        ts_future, sig_future = _sign(body, ts=now + 120)
        code, _ = relay.deliver(body, ts_future, sig_future)
        self.assertEqual(code, 401)

        # Non-numeric timestamp
        code, _ = relay.deliver(body, "not-a-timestamp", "abc")
        self.assertEqual(code, 401)

    def test_rejects_empty_or_oversized_body(self):
        ts_empty, sig_empty = _sign(b"")
        code, res = relay.deliver(b"", ts_empty, sig_empty)
        self.assertEqual(code, 413)
        self.assertEqual(res, {"code": "MESSAGE_SIZE_INVALID"})

        oversized = b"x" * (relay.MAX_MESSAGE_BYTES + 1)
        ts_big, sig_big = _sign(oversized)
        code, res = relay.deliver(oversized, ts_big, sig_big)
        self.assertEqual(code, 413)
        self.assertEqual(res, {"code": "MESSAGE_SIZE_INVALID"})

    def test_fails_closed_when_smtp_config_missing_or_invalid_sender(self):
        body = _build_mime()
        ts, sig = _sign(body)
        with patch.dict(os.environ, {"SMTP_APP_PASSWORD": ""}):
            code, res = relay.deliver(body, ts, sig)
            self.assertEqual(code, 503)
            self.assertEqual(res, {"code": "SMTP_NOT_CONFIGURED"})

        with patch.dict(os.environ, {"SMTP_FROM_EMAIL": "invalid-sender"}):
            code, res = relay.deliver(body, ts, sig)
            self.assertEqual(code, 503)
            self.assertEqual(res, {"code": "SMTP_NOT_CONFIGURED"})

    def test_rejects_multi_address_from_wrong_sender_multi_to_cc_bcc_resent_and_malformed_recipient(self):
        bad_cases = [
            _build_mime(from_addr=f"{TEST_SENDER}, evil@example.com"),
            _build_mime(from_addr="attacker@example.com"),
            _build_mime(to_addr="a@example.com, b@example.com"),
            _build_mime(to_addr="@"),
            _build_mime(to_addr="a@"),
            _build_mime(to_addr="@b.com"),
            _build_mime(to_addr="user@localhost"),
            _build_mime(extra_headers={"Cc": "leak@example.com"}),
            _build_mime(extra_headers={"Bcc": "leak@example.com"}),
            _build_mime(extra_headers={"Resent-To": "leak@example.com"}),
        ]
        for body in bad_cases:
            ts, sig = _sign(body)
            code, res = relay.deliver(body, ts, sig)
            self.assertEqual(code, 422)
            self.assertEqual(res, {"code": "MESSAGE_ENVELOPE_INVALID"})

    def test_maps_malformed_rfc_header_to_422_message_invalid(self):
        raw = b"From: " + TEST_SENDER.encode() + b"\r\nTo: invalid\r\n\r\n"
        ts, sig = _sign(raw)
        with patch.object(
            relay.BytesParser,
            "parsebytes",
            side_effect=LookupError("unknown encoding"),
        ):
            code, res = relay.deliver(raw, ts, sig)
            self.assertEqual(code, 422)
            self.assertEqual(res, {"code": "MESSAGE_INVALID"})

    def test_delivers_valid_message_and_maps_smtp_errors_safely(self):
        body = _build_mime()
        ts, sig = _sign(body)

        smtp_client = MagicMock()
        smtp_cm = MagicMock()
        smtp_cm.__enter__.return_value = smtp_client
        smtp_cm.__exit__.return_value = False

        with patch.object(relay.smtplib, "SMTP_SSL", return_value=smtp_cm) as smtp_cls:
            code, res = relay.deliver(body, ts, sig)
            self.assertEqual(code, 200)
            self.assertEqual(res, {"status": "SENT"})
            smtp_cls.assert_called_once()
            smtp_client.login.assert_called_once_with(TEST_SENDER, "apppassword1234")
            smtp_client.sendmail.assert_called_once_with(
                TEST_SENDER, ["parent@example.com"], body
            )

        smtp_client.login.side_effect = smtplib.SMTPAuthenticationError(
            535, b"Bad credentials"
        )
        with patch.object(relay.smtplib, "SMTP_SSL", return_value=smtp_cm):
            code, res = relay.deliver(body, ts, sig)
            self.assertEqual(code, 422)
            self.assertEqual(res, {"code": "SMTP_REJECTED"})
            self.assertNotIn("Bad credentials", json.dumps(res))

        smtp_client.login.side_effect = TimeoutError("timed out")
        with patch.object(relay.smtplib, "SMTP_SSL", return_value=smtp_cm):
            code, res = relay.deliver(body, ts, sig)
            self.assertEqual(code, 503)
            self.assertEqual(res, {"code": "SMTP_UNAVAILABLE"})

    def test_http_handler_writes_no_store_response_and_suppresses_logs(self):
        body = _build_mime()
        ts, sig = _sign(body)

        smtp_client = MagicMock()
        smtp_cm = MagicMock()
        smtp_cm.__enter__.return_value = smtp_client
        smtp_cm.__exit__.return_value = False

        handler = relay.handler.__new__(relay.handler)
        handler.headers = {
            "Content-Length": str(len(body)),
            "X-Email-Relay-Timestamp": ts,
            "X-Email-Relay-Signature": sig,
        }
        handler.rfile = io.BytesIO(body)
        handler.wfile = io.BytesIO()
        sent_headers = []
        handler.send_response = MagicMock()
        handler.send_header = MagicMock(
            side_effect=lambda k, v: sent_headers.append((k, v))
        )
        handler.end_headers = MagicMock()

        # Verify log_message is silent (no PII/secrets leaked to logs)
        handler.log_message("POST /api/parent-email-relay %s", "secret@example.com")

        with patch.object(relay.smtplib, "SMTP_SSL", return_value=smtp_cm):
            handler.do_POST()

        handler.send_response.assert_called_once_with(200)
        self.assertIn(("Cache-Control", "no-store"), sent_headers)
        self.assertEqual(json.loads(handler.wfile.getvalue().decode()), {"status": "SENT"})


if __name__ == "__main__":
    unittest.main()
