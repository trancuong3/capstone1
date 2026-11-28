"""Contract/security checks for Render -> HTTPS -> Vercel -> Gmail, without mail."""
import hashlib
import hmac
import importlib.util
import io
import os
from pathlib import Path
import smtplib
import time
import unittest
from unittest.mock import MagicMock, patch

os.environ.setdefault("DATABASE_URL", "postgresql+asyncpg://test:test@127.0.0.1:1/test")
os.environ.setdefault("SUPABASE_URL", "https://example.supabase.co")
os.environ.setdefault("SUPABASE_KEY", "isolated-test-key")

import httpx
from app.providers import parent_email_transport as transport

spec = importlib.util.spec_from_file_location(
    "email_relay", Path(__file__).resolve().parents[1] / "frontend/api/parent-email-relay.py"
)
relay = importlib.util.module_from_spec(spec)
spec.loader.exec_module(relay)


class EmailRelayTests(unittest.TestCase):
    def setUp(self):
        self.secret = "test-only-secret-" * 3
        self.env = patch.dict(os.environ, {
            "EMAIL_RELAY_SECRET": self.secret,
            "SMTP_USERNAME": "sender@example.test",
            "SMTP_APP_PASSWORD": "test password",
            "SMTP_FROM_EMAIL": "sender@example.test",
        })
        self.env.start()
        self.addCleanup(self.env.stop)
        self.smtp = patch.object(relay.smtplib, "SMTP_SSL")
        self.smtp_mock = self.smtp.start()
        self.addCleanup(self.smtp.stop)
        with patch.object(transport.settings, "EMAIL_FROM_ADDRESS", "sender@example.test"):
            from uuid import uuid4
            self.message = transport.build_test_email_message(
                recipient="parent@example.test", parent_name="Ba mẹ", delivery_id=uuid4()
            )

    def signed_send(self, body=None, age=0):
        body = self.message.as_bytes() if body is None else body
        timestamp = str(int(time.time()) - age)
        signature = hmac.new(
            self.secret.encode(), timestamp.encode() + b"." + body, hashlib.sha256
        ).hexdigest()
        return relay.deliver(body, timestamp, signature)

    def test_rejects_unsigned_expired_and_tampered_requests_before_smtp(self):
        for timestamp, signature in [(None, None), (str(int(time.time())), "bad"), (str(int(time.time())), "é")]:
            self.assertEqual(relay.deliver(self.message.as_bytes(), timestamp, signature)[0], 401)
        self.assertEqual(self.signed_send(age=120)[0], 401)
        timestamp = str(int(time.time()))
        body = self.message.as_bytes()
        signature = hmac.new(self.secret.encode(), timestamp.encode() + b"." + body, hashlib.sha256).hexdigest()
        self.assertEqual(relay.deliver(body + b"tampered", timestamp, signature)[0], 401)
        self.smtp_mock.assert_not_called()

    def test_http_handler_rejects_invalid_length_and_unsigned_request(self):
        for size, expected in [("invalid", 413), ("262145", 413), ("4", 401)]:
            handler = relay.handler.__new__(relay.handler)
            handler.headers = {"Content-Length": size}
            handler.rfile = io.BytesIO(b"mail")
            handler.wfile = io.BytesIO()
            handler.send_response = MagicMock()
            handler.send_header = MagicMock()
            handler.end_headers = MagicMock()
            handler.do_POST()
            handler.send_response.assert_called_once_with(expected)
            self.assertNotIn(b"SENT", handler.wfile.getvalue())
        self.smtp_mock.assert_not_called()

    def test_rejects_wrong_sender_and_extra_recipient(self):
        self.message.replace_header("From", "attacker@example.test")
        self.assertEqual(self.signed_send()[0], 422)
        self.message.replace_header("From", "sender@example.test")
        self.message["Bcc"] = "hidden@example.test"
        self.assertEqual(self.signed_send()[0], 422)
        self.smtp_mock.assert_not_called()

    def test_sends_exact_mime_to_only_parent_with_tls(self):
        self.assertEqual(self.signed_send(), (200, {"status": "SENT"}))
        self.smtp_mock.assert_called_once()
        args, kwargs = self.smtp_mock.call_args
        self.assertEqual(args, ("smtp.gmail.com", 465))
        self.assertEqual(kwargs["timeout"], 20)
        self.assertTrue(kwargs["context"].check_hostname)
        client = self.smtp_mock.return_value.__enter__.return_value
        client.login.assert_called_once_with("sender@example.test", "testpassword")
        client.sendmail.assert_called_once_with(
            "sender@example.test", ["parent@example.test"], self.message.as_bytes()
        )

    def test_smtp_failure_is_safe_and_not_reported_sent(self):
        self.smtp_mock.side_effect = smtplib.SMTPAuthenticationError(535, b"private detail")
        self.assertEqual(self.signed_send(), (422, {"code": "SMTP_REJECTED"}))
        self.smtp_mock.side_effect = TimeoutError("private detail")
        self.assertEqual(self.signed_send(), (503, {"code": "SMTP_UNAVAILABLE"}))

    def test_backend_signing_matches_relay_and_requires_sent_ack(self):
        def post(_url, *, content, headers):
            status, result = relay.deliver(
                content, headers["X-Email-Relay-Timestamp"], headers["X-Email-Relay-Signature"]
            )
            return httpx.Response(status, json=result)

        client = MagicMock()
        client.__enter__.return_value.post.side_effect = post
        with patch.object(transport.settings, "EMAIL_RELAY_URL", "https://viread.example/api/parent-email-relay"), patch.object(
            transport.settings, "EMAIL_RELAY_SECRET", self.secret
        ), patch.object(transport.settings, "EMAIL_PROVIDER", "vercel_relay"), patch.object(
            transport.settings, "EMAIL_FROM_ADDRESS", "sender@example.test"
        ), patch.object(transport.settings, "PARENT_EMAIL_MAIL_SINK_DIR", None), patch.object(
            transport.httpx, "Client", return_value=client
        ):
            self.assertEqual(transport.send_email_message(self.message), "vercel_relay")
            client.__enter__.return_value.post.side_effect = None
            for response, exception in [
                (httpx.Response(200, text="login page"), transport.EmailTransportPermanent),
                (httpx.Response(401), transport.EmailTransportPermanent),
                (httpx.Response(503), transport.EmailTransportRetryable),
            ]:
                client.__enter__.return_value.post.return_value = response
                with self.assertRaises(exception):
                    transport.send_email_message(self.message)

    def test_incomplete_relay_never_falls_back_to_smtp(self):
        with patch.object(transport.settings, "EMAIL_PROVIDER", "vercel_relay"), patch.object(
            transport.settings, "EMAIL_RELAY_SECRET", "short"
        ), patch.object(transport.settings, "PARENT_EMAIL_MAIL_SINK_DIR", None):
            self.assertEqual(transport.active_email_provider(), "unconfigured")

    def test_reminder_and_presence_use_https_instead_of_render_smtp(self):
        from uuid import uuid4
        from app.providers import reading_reminder_email_provider as reminder
        from app.providers import reading_presence_email_provider as presence

        with patch.object(transport.settings, "EMAIL_PROVIDER", "vercel_relay"), patch.object(
            transport.settings, "EMAIL_RELAY_SECRET", self.secret
        ), patch.object(transport.settings, "EMAIL_RELAY_URL", "https://viread.example/api/parent-email-relay"), patch.object(
            transport.settings, "PARENT_EMAIL_MAIL_SINK_DIR", None
        ), patch.object(presence, "READING_PRESENCE_MAIL_SINK_DIR", None), patch.object(
            transport.settings, "EMAIL_FROM_ADDRESS", "sender@example.test"
        ), patch.object(transport, "send_email_message") as send, patch.object(
            reminder.smtplib, "SMTP"
        ) as direct_smtp:
            self.assertTrue(reminder.email_delivery_is_configured())
            reminder.send_reading_reminder_email(
                recipient="parent@example.test", child_alias="Bé", local_date="2026-11-27",
                local_time="09:00", timezone_name="Asia/Ho_Chi_Minh", occurrence_id=uuid4()
            )
            presence.send_presence_email(
                recipient="parent@example.test", child_alias="Bé", alert_id=uuid4()
            )
            self.assertEqual(send.call_count, 2)
            direct_smtp.assert_not_called()
            self.smtp_mock.assert_not_called()


if __name__ == "__main__":
    unittest.main()
