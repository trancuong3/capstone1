from __future__ import annotations

import asyncio
import os
import smtplib
import unittest
from email.message import EmailMessage
from unittest.mock import AsyncMock, MagicMock, patch

os.environ.setdefault(
    "DATABASE_URL",
    "postgresql+asyncpg://test:test@127.0.0.1:1/test",
)
os.environ.setdefault("SUPABASE_URL", "https://example.supabase.co")
os.environ.setdefault("SUPABASE_KEY", "isolated-test-key")

from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.api.deps import require_parent_id
from app.api.routes import support as support_route
from app.database import config as settings
from app.providers.support_email_provider import (
    SupportEmailDeliveryError,
    SupportEmailNotConfiguredError,
    SupportEmailProvider,
)
from app.schemas.support import SupportFeedbackRequest
from app.services.support_service import SupportService

VALID_PAYLOAD = {
    "category": "technical_issue",
    "subject": "Không thể bắt đầu đọc sách",
    "message": "Tôi không thể bắt đầu buổi đọc.\nỨng dụng hiển thị thông báo lỗi.",
    "contact_email": "parent@example.com",
}


class SupportFeedbackTests(unittest.TestCase):
    def test_schema_normalizes_and_rejects_unsafe_or_unknown_fields(self):
        request = SupportFeedbackRequest(
            **{
                **VALID_PAYLOAD,
                "subject": "  Không thể bắt đầu đọc sách  ",
                "contact_email": " PARENT@EXAMPLE.COM ",
            }
        )
        self.assertEqual(request.subject, "Không thể bắt đầu đọc sách")
        self.assertEqual(request.contact_email, "parent@example.com")

        with self.assertRaises(ValueError):
            SupportFeedbackRequest(
                **{
                    **VALID_PAYLOAD,
                    "subject": "Tiêu đề\r\nBcc:attacker@example.com",
                }
            )
        with self.assertRaises(ValueError):
            SupportFeedbackRequest(**{**VALID_PAYLOAD, "message": "   "})
        with self.assertRaises(ValueError):
            SupportFeedbackRequest(
                **{**VALID_PAYLOAD, "recipient": "attacker@example.com"}
            )

    def test_provider_uses_backend_recipient_and_safe_reply_to(self):
        names = (
            "SMTP_HOST",
            "SMTP_PORT",
            "SMTP_USERNAME",
            "SMTP_APP_PASSWORD",
            "SMTP_FROM_EMAIL",
            "SMTP_SEND_TIMEOUT_SECONDS",
            "SUPPORT_EMAIL",
        )
        previous = {name: getattr(settings, name) for name in names}
        try:
            settings.SMTP_HOST = "smtp.example.test"
            settings.SMTP_PORT = 587
            settings.SMTP_USERNAME = "sender@example.test"
            settings.SMTP_APP_PASSWORD = "not-a-real-secret"
            settings.SMTP_FROM_EMAIL = "sender@example.test"
            settings.SMTP_SEND_TIMEOUT_SECONDS = 5
            settings.SUPPORT_EMAIL = "vireadforyou@gmail.com"

            server = MagicMock()
            server.__enter__.return_value = server
            with patch(
                "app.providers.support_email_provider.smtplib.SMTP",
                return_value=server,
            ):
                asyncio.run(
                    SupportEmailProvider().send(
                        subject="[ViRead Support] Lỗi kỹ thuật - Không mở được sách",
                        body="ViRead\nNội dung hỗ trợ",
                        reply_to="parent@example.com",
                    )
                )

            message = server.send_message.call_args.args[0]
            self.assertIsInstance(message, EmailMessage)
            self.assertEqual(message["To"], "vireadforyou@gmail.com")
            self.assertEqual(message["Reply-To"], "parent@example.com")
            self.assertEqual(message["From"], "ViRead <sender@example.test>")
            self.assertNotIn("not-a-real-secret", message.as_string())
            server.starttls.assert_called_once()
            server.login.assert_called_once_with(
                "sender@example.test",
                "not-a-real-secret",
            )
        finally:
            for name, value in previous.items():
                setattr(settings, name, value)


    def test_support_service_formats_message_subject_timestamp_and_reply_to(self):
        request = SupportFeedbackRequest(**VALID_PAYLOAD)
        provider = MagicMock()
        provider.send = AsyncMock(return_value=None)

        asyncio.run(
            SupportService(email_provider=provider).submit_feedback(request)
        )

        kwargs = provider.send.await_args.kwargs
        self.assertTrue(
            kwargs["subject"].startswith(
                "[ViRead Support] Báo lỗi kỹ thuật - Không thể bắt đầu đọc sách"
            )
        )
        self.assertIn("Sản phẩm: ViRead", kwargs["body"])
        self.assertIn("Loại yêu cầu: Báo lỗi kỹ thuật", kwargs["body"])
        self.assertIn("Email liên hệ: parent@example.com", kwargs["body"])
        self.assertIn("Thời điểm tiếp nhận (UTC):", kwargs["body"])
        self.assertIn(VALID_PAYLOAD["message"], kwargs["body"])
        self.assertEqual(kwargs["reply_to"], "parent@example.com")
        html_body = kwargs["html_body"]
        self.assertIsInstance(html_body, str)
        self.assertIn("Báo lỗi kỹ thuật", html_body)
        self.assertIn("#fdebec", html_body.lower())
        self.assertIn("mailto:parent@example.com?subject=", html_body)
        self.assertIn("Tôi không thể bắt đầu buổi đọc.<br />Ứng dụng hiển thị thông báo lỗi.", html_body)
        self.assertNotIn("#2563eb", html_body.lower())

    def test_provider_supports_multipart_html_and_sets_root_content_language(self):
        names = (
            "SMTP_HOST",
            "SMTP_PORT",
            "SMTP_USERNAME",
            "SMTP_APP_PASSWORD",
            "SMTP_FROM_EMAIL",
            "SMTP_SEND_TIMEOUT_SECONDS",
            "SUPPORT_EMAIL",
        )
        previous = {name: getattr(settings, name) for name in names}
        try:
            settings.SMTP_HOST = "smtp.example.test"
            settings.SMTP_PORT = 587
            settings.SMTP_USERNAME = "sender@example.test"
            settings.SMTP_APP_PASSWORD = "not-a-real-secret"
            settings.SMTP_FROM_EMAIL = "sender@example.test"
            settings.SMTP_SEND_TIMEOUT_SECONDS = 5
            settings.SUPPORT_EMAIL = "vireadforyou@gmail.com"

            server = MagicMock()
            server.__enter__.return_value = server
            with patch(
                "app.providers.support_email_provider.smtplib.SMTP",
                return_value=server,
            ):
                asyncio.run(
                    SupportEmailProvider().send(
                        subject="[ViRead Support] Góp ý",
                        body="Nội dung thuần",
                        html_body="<html><body><p>Nội dung HTML</p></body></html>",
                        reply_to="parent@example.com",
                        locale="vi",
                    )
                )

            message = server.send_message.call_args.args[0]
            self.assertIsInstance(message, EmailMessage)
            self.assertTrue(message.is_multipart())
            self.assertEqual(message["Content-Language"], "vi")
            self.assertEqual(
                message.get_body(preferencelist=("plain",)).get_content().strip(),
                "Nội dung thuần",
            )
            self.assertIn(
                "Nội dung HTML",
                message.get_body(preferencelist=("html",)).get_content(),
            )

            # Whitespace-only html_body must stay plain text (never attach a blank HTML part)
            server.send_message.reset_mock()
            with patch(
                "app.providers.support_email_provider.smtplib.SMTP",
                return_value=server,
            ):
                asyncio.run(
                    SupportEmailProvider().send(
                        subject="[ViRead Support] Plain only",
                        body="Chỉ văn bản thuần",
                        html_body="   \n\t  ",
                        reply_to="parent@example.com",
                        locale="vi",
                    )
                )
            plain_only_msg = server.send_message.call_args.args[0]
            self.assertFalse(plain_only_msg.is_multipart())
            self.assertEqual(plain_only_msg["Content-Language"], "vi")
            self.assertEqual(plain_only_msg.get_content().strip(), "Chỉ văn bản thuần")
        finally:
            for name, value in previous.items():
                setattr(settings, name, value)

    def test_provider_fails_closed_without_smtp_credentials(self):
        names = ("SMTP_USERNAME", "SMTP_APP_PASSWORD", "SMTP_FROM_EMAIL")
        previous = {name: getattr(settings, name) for name in names}
        try:
            settings.SMTP_USERNAME = None
            settings.SMTP_APP_PASSWORD = None
            settings.SMTP_FROM_EMAIL = None
            with self.assertRaises(SupportEmailNotConfiguredError):
                SupportEmailProvider._required_settings()
        finally:
            for name, value in previous.items():
                setattr(settings, name, value)

    def test_provider_normalizes_transport_failures(self):
        names = (
            "SMTP_HOST",
            "SMTP_PORT",
            "SMTP_USERNAME",
            "SMTP_APP_PASSWORD",
            "SMTP_FROM_EMAIL",
            "SMTP_SEND_TIMEOUT_SECONDS",
            "SUPPORT_EMAIL",
        )
        previous = {name: getattr(settings, name) for name in names}
        try:
            settings.SMTP_HOST = "smtp.example.test"
            settings.SMTP_PORT = 587
            settings.SMTP_USERNAME = "sender@example.test"
            settings.SMTP_APP_PASSWORD = "not-a-real-secret"
            settings.SMTP_FROM_EMAIL = "sender@example.test"
            settings.SMTP_SEND_TIMEOUT_SECONDS = 5
            settings.SUPPORT_EMAIL = "vireadforyou@gmail.com"

            with patch(
                "app.providers.support_email_provider.smtplib.SMTP",
                side_effect=smtplib.SMTPConnectError(
                    421,
                    "private transport details",
                ),
            ):
                with self.assertRaises(SupportEmailDeliveryError):
                    asyncio.run(
                        SupportEmailProvider().send(
                            subject="Feedback",
                            body="Message",
                            reply_to="parent@example.com",
                        )
                    )
        finally:
            for name, value in previous.items():
                setattr(settings, name, value)

    def test_feedback_route_requires_authentication_and_rejects_recipient_override(self):
        app = FastAPI()
        app.include_router(support_route.router, prefix="/support")
        client = TestClient(app)

        unauthorized = client.post("/support/feedback", json=VALID_PAYLOAD)
        self.assertEqual(unauthorized.status_code, 401)

        app.dependency_overrides[require_parent_id] = (
            lambda: "10000000-0000-4000-8000-000000000001"
        )
        invalid = client.post(
            "/support/feedback",
            json={**VALID_PAYLOAD, "recipient": "attacker@example.com"},
        )
        self.assertEqual(invalid.status_code, 422)


    def test_feedback_route_returns_accepted_only_after_provider_accepts(self):
        app = FastAPI()
        app.include_router(support_route.router, prefix="/support")
        app.dependency_overrides[require_parent_id] = (
            lambda: "10000000-0000-4000-8000-000000000001"
        )
        client = TestClient(app)

        with patch.object(
            support_route,
            "SupportService",
            return_value=MagicMock(
                submit_feedback=AsyncMock(return_value=None)
            ),
        ):
            response = client.post("/support/feedback", json=VALID_PAYLOAD)

        self.assertEqual(response.status_code, 202)
        self.assertEqual(response.json()["accepted"], True)
        self.assertEqual(response.json()["delivery_status"], "accepted_by_smtp")

    def test_feedback_route_returns_503_when_smtp_is_not_configured(self):
        app = FastAPI()
        app.include_router(support_route.router, prefix="/support")
        app.dependency_overrides[require_parent_id] = (
            lambda: "10000000-0000-4000-8000-000000000001"
        )
        client = TestClient(app)

        with patch.object(
            support_route,
            "SupportService",
            return_value=MagicMock(
                submit_feedback=MagicMock(
                    side_effect=SupportEmailNotConfiguredError()
                )
            ),
        ):
            response = client.post("/support/feedback", json=VALID_PAYLOAD)

        self.assertEqual(response.status_code, 503)


if __name__ == "__main__":
    unittest.main()
