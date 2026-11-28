"""Comprehensive layout, i18n, RTL, XSS, privacy, and size-cap tests for ViRead emails."""

from __future__ import annotations

import asyncio
import os
import unittest
from datetime import UTC, datetime, timedelta
from email.message import EmailMessage
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock, patch
from uuid import UUID, uuid4

os.environ.setdefault("DATABASE_URL", "postgresql+asyncpg://test:test@127.0.0.1:1/test")
os.environ.setdefault("SUPABASE_URL", "https://example.supabase.co")
os.environ.setdefault("SUPABASE_KEY", "isolated-test-key")

from app.providers import email_layout
from app.providers import parent_email_transport as transport
from app.providers import reading_presence_email_provider as presence_provider
from app.providers import reading_reminder_email_provider as reminder_provider
from app.schemas.support import SupportFeedbackRequest
from app.services.i18n.email_templates import (
    render_reading_presence_email,
    render_reading_reminder_email,
)
from app.services.i18n.locales import RTL_LOCALES, SUPPORTED_LOCALES
from app.services.parent_email_notification_service import (
    ParentEmailNotificationService,
)
from app.services.support_service import CATEGORY_LABELS, SupportService

GMAIL_CLIP_LIMIT_BYTES = 102 * 1024
RELAY_PAYLOAD_LIMIT_BYTES = 256 * 1024

PRESENCE_FORBIDDEN_TERMS: tuple[str, ...] = (
    "nguy hiểm",
    "ở đâu",
    "mất tích",
    "bỏ đi",
    "transcript",
    "bản ghi",
    "hình ảnh",
    "ảnh chụp",
    "ảnh",
    "ghi âm",
    "đã đọc",
    "trang ",
    "danger",
    "missing",
    "photo",
)


def _extract_parts(message: EmailMessage) -> tuple[str, str]:
    plain_part = message.get_body(preferencelist=("plain",))
    html_part = message.get_body(preferencelist=("html",))
    assert plain_part is not None, "Expected text/plain alternative"
    assert html_part is not None, "Expected text/html alternative"
    return plain_part.get_content(), html_part.get_content()


class EmailLayoutEngineAndSecurityTests(unittest.TestCase):
    def test_sanitize_url_blocks_unsafe_schemes_and_control_characters(self):
        self.assertEqual(
            email_layout.sanitize_url("https://viread.app/reports"),
            "https://viread.app/reports",
        )
        self.assertEqual(
            email_layout.sanitize_url("http://localhost:3000/settings#email"),
            "http://localhost:3000/settings#email",
        )
        unsafe_inputs = (
            None,
            "",
            "   ",
            "javascript:alert(1)",
            "JAVASCRIPT:alert(1)",
            "data:text/html,<script>alert(1)</script>",
            "vbscript:msgbox(1)",
            "file:///etc/passwd",
            "//evil.example.com/phish",
            "https://viread.app/path\r\nX-Injected: 1",
            "https://viread.app/has space",
            "mailto:parent@example.com",  # disallowed unless allow_mailto=True
        )
        for candidate in unsafe_inputs:
            self.assertIsNone(email_layout.sanitize_url(candidate), repr(candidate))

        self.assertEqual(
            email_layout.sanitize_url("mailto:parent@example.com", allow_mailto=True),
            "mailto:parent@example.com",
        )
        for bad_mailto in (
            "mailto:not-an-email",
            "mailto:@",
            "mailto:user@",
            "mailto:@example.com",
            "mailto:a@b@c.com",
            "mailto:a%0Ab@example.com",
        ):
            self.assertIsNone(
                email_layout.sanitize_url(bad_mailto, allow_mailto=True),
                repr(bad_mailto),
            )

    def test_build_mailto_url_percent_encodes_plus_and_special_subject_chars(self):
        mailto = email_layout.build_mailto_url(
            "parent+viread@example.com",
            "Lỗi đọc & <test>? #1",
        )
        self.assertIsNotNone(mailto)
        assert mailto is not None
        self.assertTrue(mailto.startswith("mailto:parent%2Bviread@example.com?subject="))
        self.assertNotIn(" ", mailto)
        self.assertNotIn("<", mailto)
        self.assertNotIn("#", mailto)
        self.assertIn("%26", mailto)
        for bad_addr in ("", "@", "user@", "@example.com", "a@b@c.com", "a\nb@example.com"):
            self.assertIsNone(email_layout.build_mailto_url(bad_addr, "Hi"), repr(bad_addr))

    def test_resolve_lang_and_dir_rejects_malicious_locale_and_handles_rtl(self):
        self.assertEqual(email_layout.resolve_lang_and_dir("ar"), ("ar", "rtl"))
        self.assertEqual(email_layout.resolve_lang_and_dir("he"), ("he", "rtl"))
        self.assertEqual(email_layout.resolve_lang_and_dir("zh-Hans"), ("zh-Hans", "ltr"))
        self.assertEqual(email_layout.resolve_lang_and_dir('vi" onclick="x'), ("vi", "ltr"))
        self.assertEqual(email_layout.resolve_lang_and_dir("../en"), ("vi", "ltr"))

    def test_parse_goal_percent_handles_bounds_ratios_decimals_and_dates(self):
        self.assertEqual(email_layout._parse_goal_percent("3/5 buổi/tuần (60%)"), 60)
        self.assertEqual(email_layout._parse_goal_percent("3/5 buổi (66.7%)"), 67)
        self.assertEqual(email_layout._parse_goal_percent("3/5 buổi (66,7%)"), 67)
        self.assertEqual(email_layout._parse_goal_percent("0/5 buổi/tuần (0%)"), 0)
        self.assertEqual(email_layout._parse_goal_percent("8/5 buổi/tuần (160%)"), 100)
        self.assertEqual(email_layout._parse_goal_percent("Đạt -10%"), 0)
        self.assertEqual(email_layout._parse_goal_percent("Hoàn thành 75%"), 75)
        self.assertEqual(email_layout._parse_goal_percent("3/5 buổi"), 60)
        self.assertIsNone(email_layout._parse_goal_percent("3/0 buổi"))
        self.assertIsNone(email_layout._parse_goal_percent("Tuần 23/11 đọc cùng ba mẹ"))
        self.assertIsNone(email_layout._parse_goal_percent("Đọc cùng ba mẹ cuối tuần"))

    def test_reminder_and_presence_handle_multiline_aliases_crlf_3para_and_whitespace_url(self):
        # Multiline child_alias in READING_REMINDER keeps full headline separate from schedule card
        rem_ml = render_reading_reminder_email(
            locale="vi",
            child_alias="Bé\nAn",
            local_date="2026-11-25",
            local_time="19:30",
            timezone_name="Asia/Ho_Chi_Minh",
            app_url="https://viread.app ",
        )
        rendered_rem = email_layout.render_reading_reminder_html(
            locale="vi",
            subject=rem_ml.subject,
            plain_body=rem_ml.body.replace("\n", "\r\n"),
            child_alias="Bé\nAn",
            local_date="2026-11-25",
            local_time="19:30",
            timezone_name="Asia/Ho_Chi_Minh",
            app_url="https://viread.app ",
        )
        self.assertIn("Bé<br />An.", rendered_rem)
        self.assertNotIn("An.<br />Lịch đọc", rendered_rem)
        self.assertIn(">Mở ViRead<", rendered_rem)
        self.assertNotIn("https://viread.app<", rendered_rem)

        # 3-paragraph fallback (no closing / no opt-out) preserves CTA without duplicating body
        rendered_rem3 = email_layout.render_reading_reminder_html(
            locale="vi",
            subject="Nhắc giờ đọc",
            plain_body=(
                "Chào ba mẹ,\n\n"
                "Đã đến giờ đọc sách cùng Bé An.\n"
                "Lịch đọc: 2026-11-25 lúc 19:30 (Asia/Ho_Chi_Minh).\n\n"
                "Mở ViRead: https://viread.app"
            ),
            child_alias="Bé An",
            local_date="2026-11-25",
            local_time="19:30",
            timezone_name="Asia/Ho_Chi_Minh",
            app_url="https://viread.app",
        )
        self.assertIn(">Mở ViRead<", rendered_rem3)

        rendered_pres3 = email_layout.render_reading_presence_html(
            locale="vi",
            subject="ViRead đã tạm dừng buổi đọc",
            plain_body=(
                "Chào ba mẹ,\r\n\r\n"
                "Nội dung tạm dừng duy nhất.\r\n\r\n"
                "Khi sẵn sàng, mở ViRead: https://viread.app"
            ),
            app_url="https://viread.app",
            cta_label="Mở ViRead",
        )
        self.assertIn("Khi sẵn sàng, mở ViRead", rendered_pres3)
        self.assertEqual(rendered_pres3.count("Nội dung tạm dừng duy nhất."), 2)  # preheader + card

    def test_presence_html_handles_multiline_child_alias_without_losing_optout(self):
        rendered = email_layout.render_reading_presence_html(
            locale="vi",
            subject="ViRead đã tạm dừng buổi đọc",
            plain_body=(
                "Chào ba mẹ,\r\n\r\n"
                "ViRead đã tạm dừng buổi đọc của Bé\r\n\r\nAn vì một lúc không thấy người đọc trong khung hình.\r\n\r\n"
                "Khi sẵn sàng, ba mẹ có thể mở ViRead để tiếp tục: https://viread.app\r\n\r\n"
                "Ba mẹ có thể tắt bất kỳ lúc nào trong phần cài đặt đọc sách."
            ),
            app_url="https://viread.app",
            cta_label="Mở ViRead",
        )
        self.assertIn("phần cài đặt đọc sách", rendered)
        self.assertIn('href="https://viread.app"', rendered)
        self.assertIn(">Mở ViRead<", rendered)

    def test_shell_omits_cta_when_url_is_javascript_and_has_zero_legacy_blue_or_svg(self):
        rendered = email_layout.render_viread_email_shell(
            locale="vi",
            title="Test <script>alert(1)</script>",
            preheader="Preview & safe",
            accent_color=email_layout.COLOR_PRIMARY,
            header_bg=email_layout.COLOR_MINT_HEADER,
            body_html="<p>Hello</p>",
            cta_label="Click me",
            cta_url="javascript:alert(1)",
            settings_url="javascript:evil()",
        )
        self.assertNotIn("javascript:", rendered.lower())
        self.assertNotIn("<script>", rendered.lower())
        self.assertNotIn("<svg", rendered.lower())
        self.assertNotIn("data:image/", rendered.lower())
        self.assertNotIn("#2563eb", rendered.lower())
        self.assertIn("&zwnj;&nbsp;", rendered)
        self.assertIn("<!--[if mso]>", rendered)
        self.assertIn('<html lang="vi" dir="ltr">', rendered)
        self.assertIn('dir="ltr" bgcolor="#fffaf0"', rendered)


class AllSevenEmailTypesFramedLayoutTests(unittest.TestCase):
    def assertCommonHygiene(self, html_body: str, raw_bytes: bytes, *, expected_dir: str = "ltr"):
        lowered = html_body.lower()
        self.assertIn("<!doctype html>", lowered)
        self.assertIn("<!--[if mso]>", html_body)
        self.assertIn("#fffaf0", lowered)
        self.assertIn("#ceded8", lowered)
        self.assertIn("#d9f4eb", lowered)
        self.assertIn("#087467", lowered)
        self.assertIn(">V<", html_body)
        self.assertIn("ViRead", html_body)
        self.assertIn("&zwnj;&nbsp;", html_body)
        self.assertIn(f'dir="{expected_dir}"', html_body)
        self.assertIn(f'dir="{expected_dir}" bgcolor="#fffaf0"', html_body)
        self.assertNotIn("<svg", lowered)
        self.assertNotIn("data:image/", lowered)
        self.assertNotIn("<img", lowered)
        self.assertNotIn("#2563eb", lowered)
        self.assertNotIn("javascript:", lowered)
        self.assertLess(len(html_body.encode("utf-8")), GMAIL_CLIP_LIMIT_BYTES)
        self.assertLess(len(raw_bytes), RELAY_PAYLOAD_LIMIT_BYTES)

    def test_weekly_digest_multi_child_delta_goal_bars_chips_and_empty_fallback(self):
        with patch.object(transport.settings, "EMAIL_FROM_ADDRESS", "no-reply@viread.app"):
            msg = transport.build_weekly_digest_message(
                recipient="parent@example.test",
                parent_name='Mẹ <Lan & "Hoa">',
                week_label="23/11–29/11",
                items=[
                    transport.ChildWeeklyDigestItem(
                        child_alias="Bé An <script>x</script>",
                        sessions_count=6,
                        total_minutes=75,
                        prev_sessions_count=4,
                        avg_fluency_score=92.6,
                        goal_summary="6/5 buổi/tuần (100%)",
                        top_difficult_words=("nghiêng", "khúc khuỷu", "<b>xoáy</b>", "trống", "sương", "extra6"),
                    ),
                    transport.ChildWeeklyDigestItem(
                        child_alias="Bé Bo",
                        sessions_count=2,
                        total_minutes=20,
                        prev_sessions_count=5,
                        avg_fluency_score=80.2,
                        goal_summary="2/5 buổi/tuần (40%)",
                        top_difficult_words=(),
                    ),
                    transport.ChildWeeklyDigestItem(
                        child_alias="Bé Chi",
                        sessions_count=3,
                        total_minutes=30,
                        prev_sessions_count=3,
                        avg_fluency_score=None,
                        goal_summary="Đọc cùng ba mẹ cuối tuần",
                        top_difficult_words=(),
                    ),
                    transport.ChildWeeklyDigestItem(
                        child_alias="Bé Na",
                        sessions_count=0,
                        total_minutes=0,
                        prev_sessions_count=2,
                        avg_fluency_score=None,
                        goal_summary="0/5 buổi/tuần (0%)",
                        top_difficult_words=(),
                    ),
                ],
                delivery_id=uuid4(),
            )
            empty_msg = transport.build_weekly_digest_message(
                recipient="parent@example.test",
                parent_name=None,
                week_label="23/11–29/11",
                items=[],
                delivery_id=uuid4(),
            )

        self.assertEqual(msg["Content-Language"], "vi")
        plain, html_body = _extract_parts(msg)
        self.assertCommonHygiene(html_body, msg.as_bytes())
        # Family KPI totals: 6+2+3+0=11 sessions, 75+20+30+0=125 minutes, 4 children
        self.assertIn(">11<", html_body)
        self.assertIn(">125<", html_body)
        self.assertIn(">4<", html_body)
        self.assertIn("+2 so với tuần trước", html_body)
        self.assertIn("-3 so với tuần trước", html_body)
        self.assertIn("Giữ nhịp tuần trước", html_body)
        self.assertIn("Chưa đọc tuần này", html_body)
        self.assertIn("Độ trôi chảy TB: 93%", html_body)
        self.assertIn("Độ trôi chảy TB: 80%", html_body)
        self.assertIn('width="40%"', html_body)
        self.assertIn('width="60%"', html_body)
        self.assertIn("Đọc cùng ba mẹ cuối tuần", html_body)
        self.assertIn("&lt;b&gt;xoáy&lt;/b&gt;", html_body)
        self.assertNotIn("extra6", html_body)
        self.assertNotIn("<script>", html_body)
        self.assertIn("(+2 so với tuần trước)", plain)

        empty_plain, empty_html = _extract_parts(empty_msg)
        self.assertCommonHygiene(empty_html, empty_msg.as_bytes())
        self.assertIn("chưa có buổi đọc nào được ghi nhận", empty_html)
        self.assertIn("0 buổi đọc (0 phút)", empty_plain)

    def test_inactivity_alert_warm_palette_and_prior_vs_no_prior_copy(self):
        with patch.object(transport.settings, "EMAIL_FROM_ADDRESS", "no-reply@viread.app"):
            single = transport.build_inactivity_alert_message(
                recipient="parent@example.test",
                parent_name="Mẹ Lan",
                items=[
                    transport.ChildInactivityItem(
                        child_alias="Bé An",
                        days_inactive=6,
                        had_prior_sessions=True,
                    )
                ],
                delivery_id=uuid4(),
            )
            multi = transport.build_inactivity_alert_message(
                recipient="parent@example.test",
                parent_name=None,
                items=[
                    transport.ChildInactivityItem("Bé An", 6, True),
                    transport.ChildInactivityItem("Bé Bo <img onerror=1>", 9, False),
                ],
                delivery_id=uuid4(),
            )

        self.assertEqual(single["Content-Language"], "vi")
        self.assertEqual(multi["Content-Language"], "vi")
        _plain, html_body = _extract_parts(multi)
        self.assertCommonHygiene(html_body, multi.as_bytes())
        self.assertIn("#d97706", html_body.lower())
        self.assertIn("#fff3c4", html_body.lower())
        self.assertIn("#ffe2c4", html_body.lower())
        self.assertNotIn("#8f3039", html_body.lower())
        self.assertNotIn("#fdebec", html_body.lower())
        self.assertIn("6 ngày chưa đọc", html_body)
        self.assertIn("9 ngày chưa đọc", html_body)
        self.assertIn("kể từ buổi đọc gần nhất", html_body)
        self.assertIn("chưa bắt đầu buổi đọc đầu tiên", html_body)
        self.assertIn("5–10 phút", html_body)
        self.assertNotIn("<img", html_body.lower())

    def test_milestone_supports_explicit_kinds_and_legacy_label_fallback(self):
        with patch.object(transport.settings, "EMAIL_FROM_ADDRESS", "no-reply@viread.app"):
            explicit_msg = transport.build_milestone_message(
                recipient="parent@example.test",
                parent_name="Mẹ Lan",
                items=[
                    transport.ChildMilestoneItem(
                        child_alias="Bé An",
                        milestone_label="Chuỗi 7 ngày đọc liên tiếp",
                        detail="Bé An đã duy trì 7 ngày liên tiếp.",
                        milestone_kind="STREAK",
                    ),
                    transport.ChildMilestoneItem(
                        child_alias="Bé Bo",
                        milestone_label="Hoàn thành mục tiêu tuần này",
                        detail="Bé Bo đạt 5/5 buổi đọc.",
                        milestone_kind="GOAL",
                    ),
                    transport.ChildMilestoneItem(
                        child_alias="Bé Chi",
                        milestone_label="Hoàn thành buổi đọc đầu tiên",
                        detail="Khởi đầu tuyệt vời!",
                        milestone_kind="FIRST_SESSION",
                    ),
                ],
                delivery_id=uuid4(),
            )
            legacy_msg = transport.build_milestone_message(
                recipient="parent@example.test",
                parent_name="Ba Minh",
                items=[
                    transport.ChildMilestoneItem("Bé An", "Chuỗi 3 ngày đọc liên tiếp", "Chi tiết 1"),
                    transport.ChildMilestoneItem("Bé Bo", "Hoàn thành mục tiêu hôm nay", "Chi tiết 2"),
                    transport.ChildMilestoneItem("Bé Chi", "Hoàn thành buổi đọc đầu tiên", "Chi tiết 3"),
                ],
                delivery_id=uuid4(),
            )

        for msg in (explicit_msg, legacy_msg):
            self.assertEqual(msg["Content-Language"], "vi")
            _plain, html_body = _extract_parts(msg)
            self.assertCommonHygiene(html_body, msg.as_bytes())
            self.assertIn("Chuỗi đọc liên tiếp", html_body)
            self.assertIn("Hoàn thành mục tiêu", html_body)
            self.assertIn("Buổi đọc đầu tiên", html_body)
            self.assertIn("#f0b645", html_body.lower())
            self.assertIn("#3b6a46", html_body.lower())
            self.assertIn("#5e4b86", html_body.lower())
            self.assertIn("Lời khen dành cho bé", html_body)

    def test_milestone_service_populates_milestone_kind_for_all_three_types(self):
        now = datetime(2026, 11, 29, 2, 0, tzinfo=UTC)
        child_id = UUID("22222222-2222-4222-8222-222222222222")
        parent_id = UUID("11111111-1111-4111-8111-111111111111")
        child = SimpleNamespace(Id=child_id, ParentId=parent_id, Alias="Bé An", CreatedAt=now - timedelta(days=20))

        class StubRepo:
            async def last_sent_for_category(self, _pid, _cat):
                return None

            async def get_delivery_by_dedupe_key(self, _key):
                return None

        service = ParentEmailNotificationService(StubRepo())
        from zoneinfo import ZoneInfo

        zone = ZoneInfo("Asia/Ho_Chi_Minh")
        local_today = now.astimezone(zone).date()

        # 1. STREAK
        streak_sessions = tuple(
            SimpleNamespace(
                Id=uuid4(),
                State="COMPLETED",
                StartedAt=now - timedelta(days=offset, hours=1),
                EndedAt=now - timedelta(days=offset, minutes=45),
            )
            for offset in range(7)
        )
        snap_streak = SimpleNamespace(
            child=child,
            sessions_last_7d=streak_sessions,
            sessions_last_35d=streak_sessions,
            active_goals=(),
            first_completed_session_at=now - timedelta(days=10),
            total_completed_sessions=10,
        )
        picked_streak = asyncio.run(
            service._select_milestone_candidate(parent_id, [snap_streak], now, local_today, zone)
        )
        self.assertIsNotNone(picked_streak)
        self.assertEqual(picked_streak[2].milestone_kind, "STREAK")

        # 2. GOAL
        single_session = (
            SimpleNamespace(
                Id=uuid4(),
                State="COMPLETED",
                StartedAt=now - timedelta(hours=1),
                EndedAt=now - timedelta(minutes=45),
            ),
        )
        goal = SimpleNamespace(
            Id=uuid4(),
            Metric="SESSIONS",
            Period="DAILY",
            TargetValue=1,
            Timezone="Asia/Ho_Chi_Minh",
            IsActive=True,
            StartsOn=local_today - timedelta(days=1),
            EndsOn=None,
        )
        snap_goal = SimpleNamespace(
            child=child,
            sessions_last_7d=single_session,
            sessions_last_35d=single_session,
            active_goals=(goal,),
            first_completed_session_at=now - timedelta(days=10),
            total_completed_sessions=5,
        )
        picked_goal = asyncio.run(
            service._select_milestone_candidate(parent_id, [snap_goal], now, local_today, zone)
        )
        self.assertIsNotNone(picked_goal)
        self.assertEqual(picked_goal[2].milestone_kind, "GOAL")

        # 3. FIRST_SESSION
        snap_first = SimpleNamespace(
            child=child,
            sessions_last_7d=single_session,
            sessions_last_35d=single_session,
            active_goals=(),
            first_completed_session_at=now - timedelta(hours=1),
            total_completed_sessions=1,
        )
        picked_first = asyncio.run(
            service._select_milestone_candidate(parent_id, [snap_first], now, local_today, zone)
        )
        self.assertIsNotNone(picked_first)
        self.assertEqual(picked_first[2].milestone_kind, "FIRST_SESSION")

    def test_test_email_verified_banner_and_four_item_checklist(self):
        with patch.object(transport.settings, "EMAIL_FROM_ADDRESS", "no-reply@viread.app"):
            msg = transport.build_test_email_message(
                recipient="parent@example.test",
                parent_name="Mẹ Lan",
                delivery_id=uuid4(),
            )
        self.assertEqual(msg["Content-Language"], "vi")
        _plain, html_body = _extract_parts(msg)
        self.assertCommonHygiene(html_body, msg.as_bytes())
        self.assertIn("Kết nối thành công", html_body)
        self.assertIn("#2e7d52", html_body.lower())
        self.assertIn("#e2f4d8", html_body.lower())
        for expected_item in (
            "Báo cáo đọc sách hằng tuần",
            "Nhắc nhẹ khi bé nghỉ đọc",
            "Chúc mừng cột mốc mới",
            "Khung giờ yên tĩnh &amp; chống spam",
        ):
            self.assertIn(expected_item, html_body)

    def test_reading_reminder_all_30_locales_rtl_cta_and_plain_exact_match(self):
        occ_id = UUID("11111111-1111-4111-8111-111111111111")
        app_url = "https://viread.example/reading-management"
        with (
            patch.object(reminder_provider, "SMTP_FROM_EMAIL", "sender@example.test"),
            patch.object(reminder_provider, "READING_REMINDER_APP_URL", app_url),
        ):
            for code in SUPPORTED_LOCALES:
                expected_dir = "rtl" if code in RTL_LOCALES else "ltr"
                expected_border = "border-right:4px solid #087467" if expected_dir == "rtl" else "border-left:4px solid #087467"
                expected_plain = (
                    render_reading_reminder_email(
                        locale=code,
                        child_alias="Bé <An>",
                        local_date="2026-11-25",
                        local_time="19:30",
                        timezone_name="Asia/Ho_Chi_Minh",
                        app_url=app_url,
                    ).body
                    + "\n"
                )
                msg = reminder_provider.build_reading_reminder_message(
                    recipient="parent@example.test",
                    child_alias="Bé <An>",
                    local_date="2026-11-25",
                    local_time="19:30",
                    timezone_name="Asia/Ho_Chi_Minh",
                    occurrence_id=occ_id,
                    locale=code,
                )
                self.assertEqual(msg["Content-Language"], code)
                plain, html_body = _extract_parts(msg)
                self.assertEqual(plain, expected_plain, code)
                self.assertCommonHygiene(html_body, msg.as_bytes(), expected_dir=expected_dir)
                self.assertIn(f'<html lang="{code}" dir="{expected_dir}">', html_body, code)
                self.assertIn(expected_border, html_body, code)
                self.assertIn("Bé &lt;An&gt;", html_body, code)
                self.assertNotIn("Bé <An>", html_body, code)
                self.assertIn("2026-11-25", html_body, code)
                self.assertIn("19:30", html_body, code)
                self.assertIn("Asia/Ho_Chi_Minh", html_body, code)
                self.assertIn(f'href="{app_url}"', html_body, code)
                if code == "vi":
                    self.assertIn("Lịch đọc sách", html_body)
                    self.assertIn(">Mở ViRead<", html_body)
                else:
                    self.assertNotIn("Lịch đọc sách", html_body, code)
                    self.assertNotIn("Mở ViRead", html_body, code)
                    self.assertNotIn("Quản lý thông báo", html_body, code)
                if code == "ar":
                    self.assertIn(">افتح ViRead<", html_body)
                    self.assertIn(
                        '<span dir="ltr" style="unicode-bidi:isolate;">2026-11-25 · 19:30</span>',
                        html_body,
                    )
                    self.assertEqual(
                        html_body.count(
                            '<span dir="ltr" style="unicode-bidi:isolate;">2026-11-25</span>'
                        ),
                        2,
                    )
                if code == "he":
                    self.assertIn(">פתיחת ViRead<", html_body)
                    self.assertIn(
                        '<span dir="ltr" style="unicode-bidi:isolate;">2026-11-25 · 19:30</span>',
                        html_body,
                    )
                    self.assertEqual(
                        html_body.count(
                            '<span dir="ltr" style="unicode-bidi:isolate;">2026-11-25</span>'
                        ),
                        2,
                    )

    def test_reading_presence_all_30_locales_zero_forbidden_words_and_rtl(self):
        alert_id = UUID("44444444-4444-4444-8444-444444444444")
        app_url = "https://viread.example/reading-management"
        with (
            patch.object(presence_provider, "SMTP_FROM_EMAIL", "sender@example.test"),
            patch.object(presence_provider, "READING_REMINDER_APP_URL", app_url),
        ):
            for code in SUPPORTED_LOCALES:
                expected_dir = "rtl" if code in RTL_LOCALES else "ltr"
                expected_border = "border-right:4px solid #4a7c82" if expected_dir == "rtl" else "border-left:4px solid #4a7c82"
                for alias in ("Bé <An>", None):
                    expected_plain = (
                        render_reading_presence_email(
                            locale=code,
                            child_alias=alias,
                            app_url=app_url,
                        ).body
                        + "\n"
                    )
                    msg = presence_provider.build_presence_message(
                        recipient="parent@example.test",
                        child_alias=alias,
                        alert_id=alert_id,
                        locale=code,
                    )
                    self.assertEqual(msg["Content-Language"], code)
                    plain, html_body = _extract_parts(msg)
                    self.assertEqual(plain, expected_plain, f"{code}/{alias}")
                    self.assertCommonHygiene(html_body, msg.as_bytes(), expected_dir=expected_dir)
                    self.assertIn(f'<html lang="{code}" dir="{expected_dir}">', html_body, code)
                    self.assertIn(expected_border, html_body, code)
                    self.assertIn("#4a7c82", html_body.lower(), code)
                    self.assertIn("#e5f5f6", html_body.lower(), code)
                    self.assertNotIn("#8f3039", html_body.lower(), code)
                    if alias is not None:
                        self.assertIn("Bé &lt;An&gt;", html_body, code)
                        self.assertNotIn("Bé <An>", html_body, code)
                    for content_kind, text in (("plain", plain), ("html", html_body)):
                        lowered = text.lower()
                        for forbidden in PRESENCE_FORBIDDEN_TERMS:
                            self.assertNotIn(
                                forbidden,
                                lowered,
                                f"Forbidden term {forbidden!r} leaked in {code} ({content_kind})",
                            )
                    if code == "vi":
                        self.assertIn("Tạm dừng buổi đọc", html_body)
                        self.assertIn(">Mở ViRead<", html_body)
                    else:
                        self.assertNotIn("Tạm dừng buổi đọc", html_body, code)
                        self.assertNotIn("Mở ViRead", html_body, code)
                        self.assertNotIn("Quản lý thông báo", html_body, code)

    def test_support_feedback_all_6_categories_xss_and_5000_char_message_size(self):
        expected_colors = {
            "technical_issue": ("#fdebec", "#8f3039"),
            "account_support": ("#fff3c4", "#765b12"),
            "how_to": ("#d9f4eb", "#087467"),
            "feature_feedback": ("#e5f5f6", "#233e40"),
            "feature_request": ("#ece6ff", "#5e4b86"),
            "other": ("#f4f7f6", "#52676b"),
        }
        self.assertEqual(set(CATEGORY_LABELS.keys()), set(expected_colors.keys()))

        for category, (bg, ink) in expected_colors.items():
            long_message = (
                "Dòng 1: <script>alert('xss')</script> & \"quote\"\n"
                + ("Chi tiết lỗi đọc sách tiếng Việt có dấu.\n" * 110)
            )[:4990]
            request = SupportFeedbackRequest(
                category=category,
                subject=f'Hỗ trợ & <kiểm tra> ({category})',
                message=long_message,
                contact_email="parent+tag@example.com",
            )
            provider = MagicMock()
            provider.send = AsyncMock(return_value=None)
            asyncio.run(SupportService(email_provider=provider).submit_feedback(request))

            kwargs = provider.send.await_args.kwargs
            html_body = kwargs["html_body"]
            # Build a real RFC 822 EmailMessage to verify total wire size < limits
            msg = EmailMessage()
            msg["Subject"] = kwargs["subject"]
            msg["From"] = "ViRead <sender@example.test>"
            msg["To"] = "support@example.test"
            msg["Reply-To"] = kwargs["reply_to"]
            msg.set_content(kwargs["body"])
            msg.add_alternative(html_body, subtype="html")
            msg["Content-Language"] = "vi"

            self.assertCommonHygiene(html_body, msg.as_bytes())
            self.assertIn(bg, html_body.lower(), category)
            self.assertIn(ink, html_body.lower(), category)
            self.assertIn(CATEGORY_LABELS[category], html_body, category)
            self.assertIn("&lt;script&gt;alert(", html_body, category)
            self.assertNotIn("<script>", html_body, category)
            self.assertIn("<br />", html_body, category)
            self.assertIn("mailto:parent%2Btag@example.com?subject=", html_body, category)

    def test_sanitize_url_rejects_encoded_crlf_in_mailto_query(self):
        self.assertIsNone(
            email_layout.sanitize_url(
                "mailto:parent@example.com?subject=Hi%0ABcc:evil@example.com",
                allow_mailto=True,
            )
        )
        self.assertIsNone(
            email_layout.sanitize_url(
                "mailto:parent@example.com?subject=Hi%0D%0ABcc:evil@example.com",
                allow_mailto=True,
            )
        )


if __name__ == "__main__":
    unittest.main()
