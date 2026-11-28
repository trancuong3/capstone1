"""Tests for ViRead backend i18n core, email templates, error formatting, and workers."""

from __future__ import annotations

import asyncio
from datetime import date, datetime, time, timezone
from email.message import EmailMessage
import os
from types import SimpleNamespace
import unittest
from unittest.mock import AsyncMock, MagicMock, patch
from uuid import UUID

os.environ.setdefault("DATABASE_URL", "postgresql+asyncpg://test:test@127.0.0.1:1/test")
os.environ.setdefault("SUPABASE_URL", "https://example.supabase.co")
os.environ.setdefault("SUPABASE_KEY", "isolated-test-key")

from app.database import config as settings
from app.jobs.reading_reminder_worker import deliver_claimed_occurrences
from app.providers.reading_presence_email_provider import (
    SUBJECT as LEGACY_PRESENCE_SUBJECT,
    build_presence_message,
)
from app.providers.reading_reminder_email_provider import build_reading_reminder_message
from app.providers.support_email_provider import SupportEmailProvider
from app.services.i18n.email_templates import (
    PRESENCE_ALERT_TEMPLATES,
    READING_REMINDER_TEMPLATES,
    render_reading_presence_email,
    render_reading_reminder_email,
)
from app.services.i18n.errors import ERROR_REGISTRY, format_error_detail, get_error_definition
from app.services.i18n.locales import (
    DEFAULT_LOCALE,
    LOCALE_REGISTRY,
    RTL_LOCALES,
    SUPPORTED_LOCALES,
    is_rtl_locale,
    locale_direction,
    normalize_locale,
    resolve_explicit_locale,
    resolve_supported_locale,
)


class LocaleAllowlistAndSecurityTests(unittest.TestCase):
    def test_allowlist_contains_all_30_locales_and_rtl_metadata(self):
        expected = {
            "vi", "en", "zh-Hans", "zh-Hant", "ja", "ko", "fr", "de", "es", "pt",
            "it", "ru", "th", "id", "ms", "fil", "hi", "bn", "ar", "tr",
            "nl", "sv", "pl", "uk", "el", "he", "km", "lo", "my", "ne",
        }
        self.assertEqual(DEFAULT_LOCALE, "vi")
        self.assertEqual(len(SUPPORTED_LOCALES), 30)
        self.assertEqual(set(SUPPORTED_LOCALES), expected)
        self.assertEqual(set(LOCALE_REGISTRY.keys()), expected)
        self.assertEqual(RTL_LOCALES, frozenset({"ar", "he"}))
        for code in SUPPORTED_LOCALES:
            self.assertEqual(resolve_supported_locale(code), code)
            expected_dir = "rtl" if code in {"ar", "he"} else "ltr"
            self.assertEqual(locale_direction(code), expected_dir)
            self.assertEqual(is_rtl_locale(code), code in {"ar", "he"})

    def test_normalization_aliases_and_security_rejection(self):
        self.assertEqual(normalize_locale("EN"), "en")
        self.assertEqual(normalize_locale("en-US"), "en")
        self.assertEqual(normalize_locale("vi_VN"), "vi")
        self.assertEqual(normalize_locale("zh-CN"), "zh-Hans")
        self.assertEqual(normalize_locale("zh_sg"), "zh-Hans")
        self.assertEqual(normalize_locale("zh-TW"), "zh-Hant")
        self.assertEqual(normalize_locale("zh-HK"), "zh-Hant")
        self.assertEqual(normalize_locale("in-ID"), "id")
        self.assertEqual(normalize_locale("iw"), "he")
        self.assertEqual(normalize_locale("he-IL"), "he")
        self.assertEqual(normalize_locale("tl-PH"), "fil")

        malicious_or_invalid = [
            None,
            "",
            "   ",
            "../vi",
            "..\\en",
            "en/../../etc/passwd",
            "en\x00vi",
            "vi\r\nX-Injected: 1",
            "<script>alert(1)</script>",
            "en-US,vi;q=0.9",
            "xx",
            "zz-ZZ",
            "zh-invalid",
            "a" * 64,
            "vi;DROP TABLE profiles",
        ]
        for bad in malicious_or_invalid:
            self.assertIsNone(normalize_locale(bad), repr(bad))
            self.assertEqual(resolve_supported_locale(bad), "vi", repr(bad))

    def test_explicit_locale_priority_never_reads_accept_language(self):
        headers_with_accept_only = {"Accept-Language": "en-US,en;q=0.9"}
        self.assertEqual(
            resolve_explicit_locale(headers=headers_with_accept_only),
            "vi",
        )
        headers_with_viread = {
            "Accept-Language": "fr-FR,fr;q=0.9",
            "x-viread-locale": "ja",
        }
        self.assertEqual(
            resolve_explicit_locale(headers=headers_with_viread, user_preference="de"),
            "ja",
        )
        self.assertEqual(
            resolve_explicit_locale(
                explicit_locale="ar",
                headers=headers_with_viread,
                user_preference="de",
            ),
            "ar",
        )
        self.assertEqual(
            resolve_explicit_locale(
                explicit_locale="../evil",
                headers={"X-ViRead-Locale": "bad<script>"},
                user_preference="zh-TW",
            ),
            "zh-Hant",
        )


class ErrorRegistryTests(unittest.TestCase):
    def test_known_and_unknown_error_codes_preserve_backward_compatible_shape(self):
        known = get_error_definition("GOAL_DUPLICATE")
        self.assertIsNotNone(known)
        detail = format_error_detail("GOAL_DUPLICATE")
        self.assertEqual(detail["code"], "GOAL_DUPLICATE")
        self.assertEqual(detail["message_key"], "errors.goal_duplicate")
        self.assertEqual(detail["message_params"], {})
        self.assertIn("overlap", detail["message"].lower())

        custom = format_error_detail(
            "custom_rate_limit",
            "Wait {seconds} seconds before retrying",
            seconds=30,
        )
        self.assertEqual(custom["code"], "CUSTOM_RATE_LIMIT")
        self.assertEqual(custom["message_key"], "errors.custom_rate_limit")
        self.assertEqual(custom["message_params"], {"seconds": 30})
        self.assertEqual(custom["message"], "Wait 30 seconds before retrying")

        self.assertIn("PRESENCE_ALERT_DISABLED", ERROR_REGISTRY)
        self.assertIn("RESOURCE_NOT_FOUND", ERROR_REGISTRY)


class EmailLocalizationTests(unittest.TestCase):
    def test_all_30_locales_render_reminder_and_presence_without_key_error(self):
        self.assertEqual(set(READING_REMINDER_TEMPLATES.keys()), set(SUPPORTED_LOCALES))
        self.assertEqual(set(PRESENCE_ALERT_TEMPLATES.keys()), set(SUPPORTED_LOCALES))

        for code in SUPPORTED_LOCALES:
            rem = render_reading_reminder_email(
                locale=code,
                child_alias="Bé An",
                local_date="2026-11-04",
                local_time="19:30",
                timezone_name="Asia/Ho_Chi_Minh",
                app_url="https://viread.example/reading-management",
            )
            self.assertEqual(rem.locale, code)
            self.assertTrue(rem.subject.strip(), code)
            self.assertIn("Bé An", rem.body, code)
            self.assertIn("2026-11-04", rem.body, code)
            self.assertIn("19:30", rem.body, code)
            self.assertIn("Asia/Ho_Chi_Minh", rem.body, code)
            self.assertIn("https://viread.example/reading-management", rem.body, code)

            pres_child = render_reading_presence_email(
                locale=code,
                child_alias="Bé An",
                app_url="https://viread.example/reading-management",
            )
            pres_no_child = render_reading_presence_email(
                locale=code,
                child_alias=None,
                app_url="https://viread.example/reading-management",
            )
            self.assertEqual(pres_child.locale, code)
            self.assertTrue(pres_child.subject.strip(), code)
            self.assertIn("Bé An", pres_child.body, code)
            self.assertIn("ViRead", pres_no_child.body, code)
            self.assertIn("https://viread.example/reading-management", pres_no_child.body, code)

    def test_legacy_vietnamese_copy_exact_preservation(self):
        occ_id = UUID("11111111-1111-4111-8111-111111111111")
        alert_id = UUID("44444444-4444-4444-8444-444444444444")

        with (
            patch("app.providers.reading_reminder_email_provider.SMTP_FROM_EMAIL", "sender@example.test"),
            patch("app.providers.reading_reminder_email_provider.READING_REMINDER_APP_URL", "https://viread.test/app"),
            patch("app.providers.reading_presence_email_provider.SMTP_FROM_EMAIL", "sender@example.test"),
            patch("app.providers.reading_presence_email_provider.READING_REMINDER_APP_URL", "https://viread.test/app"),
        ):
            rem_default = build_reading_reminder_message(
                recipient="parent@example.test",
                child_alias="Bé An",
                local_date="2026-11-04",
                local_time="19:30",
                timezone_name="Asia/Ho_Chi_Minh",
                occurrence_id=occ_id,
            )
            rem_vi = build_reading_reminder_message(
                recipient="parent@example.test",
                child_alias="Bé An",
                local_date="2026-11-04",
                local_time="19:30",
                timezone_name="Asia/Ho_Chi_Minh",
                occurrence_id=occ_id,
                locale="vi",
            )
            rem_fallback = build_reading_reminder_message(
                recipient="parent@example.test",
                child_alias="Bé An",
                local_date="2026-11-04",
                local_time="19:30",
                timezone_name="Asia/Ho_Chi_Minh",
                occurrence_id=occ_id,
                locale="../../etc/passwd",
            )
            expected_rem_body = (
                "Chào ba mẹ,\n\n"
                "Đã đến giờ đọc sách cùng Bé An.\n"
                "Lịch đọc: 2026-11-04 lúc 19:30 (Asia/Ho_Chi_Minh).\n\n"
                "Mở ViRead: https://viread.test/app\n\n"
                "Chúc gia đình có một buổi đọc sách vui vẻ!\n"
            )
            for msg in (rem_default, rem_vi, rem_fallback):
                self.assertEqual(msg["Subject"], "Đến giờ đọc sách cùng bé")
                self.assertEqual(msg["Content-Language"], "vi")
                plain_part = msg.get_body(preferencelist=("plain",))
                html_part = msg.get_body(preferencelist=("html",))
                self.assertIsNotNone(plain_part)
                self.assertIsNotNone(html_part)
                self.assertEqual(plain_part.get_content(), expected_rem_body)
                html_content = html_part.get_content()
                self.assertIn("Bé An", html_content)
                self.assertIn("2026-11-04", html_content)
                self.assertIn("19:30", html_content)
                self.assertIn("Asia/Ho_Chi_Minh", html_content)
                self.assertIn("https://viread.test/app", html_content)

            pres_vi = build_presence_message(
                recipient="parent@example.test",
                child_alias="Bé An",
                alert_id=alert_id,
                locale="vi",
            )
            pres_no_alias = build_presence_message(
                recipient="parent@example.test",
                child_alias=None,
                alert_id=alert_id,
            )
            self.assertEqual(pres_vi["Subject"], LEGACY_PRESENCE_SUBJECT)
            self.assertEqual(pres_vi["Content-Language"], "vi")
            self.assertEqual(
                pres_vi.get_body(preferencelist=("plain",)).get_content(),
                "Chào ba mẹ,\n\n"
                "ViRead đã tạm dừng buổi đọc của Bé An vì một lúc không thấy người đọc trong khung hình.\n\n"
                "Khi sẵn sàng, ba mẹ có thể mở ViRead để tiếp tục: https://viread.test/app\n\n"
                'Bạn nhận email này vì đã bật "Nhắc qua email khi không thấy người đọc". '
                "Ba mẹ có thể tắt bất kỳ lúc nào trong phần cài đặt đọc sách.\n",
            )
            self.assertIn(
                "ViRead đã tạm dừng buổi đọc của Bé An",
                pres_vi.get_body(preferencelist=("html",)).get_content(),
            )
            self.assertIn(
                "tạm dừng buổi đọc vì một lúc",
                pres_no_alias.get_body(preferencelist=("plain",)).get_content(),
            )
            self.assertIn(
                "tạm dừng buổi đọc vì một lúc",
                pres_no_alias.get_body(preferencelist=("html",)).get_content(),
            )

    def test_selected_locales_preserve_timezone_and_set_content_language(self):
        occ_id = UUID("11111111-1111-4111-8111-111111111111")
        alert_id = UUID("44444444-4444-4444-8444-444444444444")
        with (
            patch("app.providers.reading_reminder_email_provider.SMTP_FROM_EMAIL", "sender@example.test"),
            patch("app.providers.reading_presence_email_provider.SMTP_FROM_EMAIL", "sender@example.test"),
        ):
            for code in SUPPORTED_LOCALES:
                expected_dir = "rtl" if code in RTL_LOCALES else "ltr"
                rem = build_reading_reminder_message(
                    recipient="parent@example.test",
                    child_alias="Minh",
                    local_date="2026-11-25",
                    local_time="20:15",
                    timezone_name="America/Los_Angeles",
                    occurrence_id=occ_id,
                    locale=code,
                )
                self.assertEqual(rem["Content-Language"], code)
                rem_plain = rem.get_body(preferencelist=("plain",)).get_content()
                rem_html = rem.get_body(preferencelist=("html",)).get_content()
                for body in (rem_plain, rem_html):
                    self.assertIn("2026-11-25", body, code)
                    self.assertIn("20:15", body, code)
                    self.assertIn("America/Los_Angeles", body, code)
                self.assertIn(f'<html lang="{code}" dir="{expected_dir}">', rem_html, code)
                self.assertIn(f'dir="{expected_dir}" bgcolor="#fffaf0"', rem_html, code)

                pres = build_presence_message(
                    recipient="parent@example.test",
                    child_alias="Minh",
                    alert_id=alert_id,
                    locale=code,
                )
                self.assertEqual(pres["Content-Language"], code)
                pres_plain = pres.get_body(preferencelist=("plain",)).get_content()
                pres_html = pres.get_body(preferencelist=("html",)).get_content()
                self.assertIn(f'<html lang="{code}" dir="{expected_dir}">', pres_html, code)
                self.assertIn(f'dir="{expected_dir}" bgcolor="#fffaf0"', pres_html, code)
                for body in (pres_plain, pres_html):
                    self.assertIn("Minh", body, code)
                    lowered = body.lower()
                    for forbidden in (
                        "danger", "missing", "transcript", "photo",
                        "nguy hiểm", "mất tích", "ảnh", "trang ",
                    ):
                        self.assertNotIn(forbidden, lowered, f"{code}: {forbidden}")

    def test_support_provider_sets_content_language_safely(self):
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
            with patch("app.providers.support_email_provider.smtplib.SMTP", return_value=server):
                asyncio.run(
                    SupportEmailProvider().send(
                        subject="[ViRead Support] Feedback",
                        body="Message",
                        reply_to="parent@example.com",
                        locale="ja",
                    )
                )
            sent_msg = server.send_message.call_args.args[0]
            self.assertIsInstance(sent_msg, EmailMessage)
            self.assertEqual(sent_msg["Content-Language"], "ja")
        finally:
            for name, value in previous.items():
                setattr(settings, name, value)

    def test_reminder_worker_passes_locale_when_supported_and_preserves_legacy_senders(self):
        occurrence = SimpleNamespace(
            Id=UUID("11111111-1111-4111-8111-111111111111"),
            EmailAttempts=1,
            ScheduledLocalDate=date(2026, 11, 4),
        )
        reminder = SimpleNamespace(RemindAt=time(19, 30), Timezone="Asia/Ho_Chi_Minh")
        child = SimpleNamespace(
            ParentId=UUID("22222222-2222-4222-8222-222222222222"),
            Alias="Bé An",
            Settings={"preferred_locale": "de"},
        )
        repo = MagicMock()
        repo.update_email_delivery = AsyncMock()

        async def recipient(_parent_id):
            return "parent@example.com"

        legacy_calls = []

        def legacy_sender(*, recipient, child_alias, local_date, local_time, timezone_name, occurrence_id):
            legacy_calls.append(child_alias)

        locale_calls = []

        def locale_sender(*, recipient, child_alias, local_date, local_time, timezone_name, occurrence_id, locale="vi"):
            locale_calls.append(locale)

        asyncio.run(
            deliver_claimed_occurrences(
                repo,
                [(occurrence, reminder, child)],
                datetime(2026, 11, 4, 12, tzinfo=timezone.utc),
                recipient_resolver=recipient,
                email_sender=legacy_sender,
            )
        )
        self.assertEqual(legacy_calls, ["Bé An"])

        asyncio.run(
            deliver_claimed_occurrences(
                repo,
                [(occurrence, reminder, child)],
                datetime(2026, 11, 4, 12, tzinfo=timezone.utc),
                recipient_resolver=recipient,
                email_sender=locale_sender,
            )
        )
        self.assertEqual(locale_calls, ["de"])

    def test_presence_worker_forwards_explicit_locale_and_keeps_vi_default(self):
        from contextlib import asynccontextmanager
        from app.jobs import reading_presence_alert_worker as worker

        @asynccontextmanager
        async def _fake_lock(_key: int):
            yield True

        @asynccontextmanager
        async def _fake_session():
            yield MagicMock()

        captured_senders = []

        class FakeService:
            def __init__(self, _repo):
                pass

            async def deliver_due(self, _now, **kwargs):
                captured_senders.append(kwargs["email_sender"])
                return 0

        with (
            patch.object(worker, "_advisory_lock_guard", side_effect=_fake_lock),
            patch.object(worker, "AsyncSessionLocal", side_effect=_fake_session),
            patch.object(worker, "ReadingPresenceService", FakeService),
            patch.object(worker, "record_worker_success"),
        ):
            asyncio.run(worker.process_due_alerts_once(datetime(2026, 11, 4, 12, tzinfo=timezone.utc)))
            asyncio.run(worker.process_due_alerts_once(datetime(2026, 11, 4, 12, tzinfo=timezone.utc), locale="en"))

        self.assertIs(captured_senders[0], worker.send_presence_email)
        self.assertEqual(captured_senders[1].keywords.get("locale"), "en")


if __name__ == "__main__":
    unittest.main()
