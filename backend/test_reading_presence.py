"""Presence ("nobody in frame") parent-email rules.

Service-level tests over an in-memory repository that mirrors the conditional
SQL semantics of ReadingPresenceRepository (unique episode, status-guarded
updates, claim = atomic PENDING -> SENDING). Fake awaits yield to the event loop
between steps so concurrent requests really interleave.

Real PostgreSQL behaviour (unique index, FOR UPDATE SKIP LOCKED) is covered by
test_reading_presence_postgres_integration.py when a database is available.
"""

import asyncio
import os
import tempfile
import unittest
from datetime import datetime, timedelta, timezone
from email import message_from_bytes, policy as email_policy
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch
from uuid import UUID, uuid4

os.environ.setdefault("DATABASE_URL", "postgresql+asyncpg://test:test@127.0.0.1:1/test")
os.environ.setdefault("SUPABASE_URL", "https://example.supabase.co")
os.environ.setdefault("SUPABASE_KEY", "isolated-test-key")

from pydantic import ValidationError

from app.providers import reading_presence_email_provider as provider
from app.repositories.reading_presence_repository import DeliveryContext
from app.schemas.reading_presence import PresenceAlertArm, PresenceSettingsUpdate
from app.services.reading_presence_service import (
    PresenceConflict,
    PresenceLimits,
    PresenceNotFound,
    ReadingPresenceService,
)

NOW = datetime(2026, 11, 22, 3, 0, tzinfo=timezone.utc)
PARENT = UUID("11111111-1111-4111-8111-111111111111")
OTHER_PARENT = UUID("99999999-9999-4999-8999-999999999999")
CHILD = UUID("22222222-2222-4222-8222-222222222222")
SESSION = UUID("33333333-3333-4333-8333-333333333333")
LIMITS = PresenceLimits(
    grace_seconds=60,
    ttl_seconds=300,
    heartbeat_seconds=30,
    session_cooldown_seconds=1800,
    max_per_parent_per_day=3,
    max_send_attempts=3,
)


class Unavailable(Exception):
    pass


class LookupFailed(Exception):
    pass


class FakeRepo:
    def __init__(self):
        self.settings: dict[UUID, bool] = {}
        self.sessions: dict[UUID, SimpleNamespace] = {}
        self.children: dict[UUID, SimpleNamespace] = {}
        self.alerts: dict[UUID, SimpleNamespace] = {}

    # fixtures ----------------------------------------------------------
    def add_session(self, session_id=SESSION, parent=PARENT, state="LISTENING", ended=None):
        child = SimpleNamespace(Id=CHILD, ParentId=parent, Alias="Bé An")
        self.children[CHILD] = child
        self.sessions[session_id] = SimpleNamespace(
            Id=session_id, ChildId=CHILD, State=state, EndedAt=ended
        )

    async def _yield(self):
        await asyncio.sleep(0)

    # ownership / settings ----------------------------------------------
    async def owned_session(self, session_id, parent_id):
        await self._yield()
        session = self.sessions.get(session_id)
        if session is None:
            return None
        child = self.children[session.ChildId]
        return (session, child) if child.ParentId == parent_id else None

    async def get_settings(self, parent_id):
        await self._yield()
        if parent_id not in self.settings:
            return None
        return SimpleNamespace(EmailEnabled=self.settings[parent_id])

    async def upsert_settings(self, parent_id, enabled, now):
        await self._yield()
        self.settings[parent_id] = enabled
        return SimpleNamespace(EmailEnabled=enabled)

    # alerts ------------------------------------------------------------
    async def by_episode(self, session_id, episode_id):
        await self._yield()
        return next(
            (a for a in self.alerts.values()
             if a.SessionId == session_id and a.EpisodeId == episode_id),
            None,
        )

    async def alert_for_parent(self, alert_id, parent_id):
        await self._yield()
        alert = self.alerts.get(alert_id)
        return alert if alert and alert.ParentId == parent_id else None

    async def count_parent_alerts_since(self, parent_id, since):
        await self._yield()
        return sum(
            1 for a in self.alerts.values()
            if a.ParentId == parent_id and a.CreatedAt >= since
            and a.Status in ("PENDING", "SENDING", "SENT")
        )

    async def session_alert_since(self, session_id, since):
        await self._yield()
        return next(
            (a for a in self.alerts.values()
             if a.SessionId == session_id and a.CreatedAt >= since
             and a.Status in ("PENDING", "SENDING", "SENT")),
            None,
        )

    async def insert_idempotent(self, **values):
        await self._yield()
        # ON CONFLICT (sessionid, episodeid) DO NOTHING: atomic.
        for alert in self.alerts.values():
            if alert.SessionId == values["SessionId"] and alert.EpisodeId == values["EpisodeId"]:
                return alert, False
        alert = SimpleNamespace(
            Id=uuid4(), Attempts=0, ClaimedAt=None, SentAt=None, CancelReason=None,
            ErrorCode=None, CreatedAt=values["LastConfirmedAt"], **values,
        )
        self.alerts[alert.Id] = alert
        return alert, True

    async def confirm(self, alert_id, parent_id, now):
        await self._yield()
        alert = self.alerts.get(alert_id)
        if alert and alert.ParentId == parent_id and alert.Status == "PENDING" and alert.ExpiresAt > now:
            alert.LastConfirmedAt = now
        return alert if alert and alert.ParentId == parent_id else None

    async def cancel(self, alert_id, parent_id, reason):
        await self._yield()
        alert = self.alerts.get(alert_id)
        if alert and alert.ParentId == parent_id and alert.Status == "PENDING":
            alert.Status, alert.CancelReason = "CANCELLED", reason
        return alert if alert and alert.ParentId == parent_id else None

    async def cancel_pending_for_parent(self, parent_id, reason):
        await self._yield()
        n = 0
        for alert in self.alerts.values():
            if alert.ParentId == parent_id and alert.Status == "PENDING":
                alert.Status, alert.CancelReason = "CANCELLED", reason
                n += 1
        return n

    async def cancel_pending_for_session(self, session_id, reason):
        await self._yield()
        n = 0
        for alert in self.alerts.values():
            if alert.SessionId == session_id and alert.Status == "PENDING":
                alert.Status, alert.CancelReason = "CANCELLED", reason
                n += 1
        return n

    # worker ------------------------------------------------------------
    async def expire_and_recover(self, now, *, sending_stale_after):
        await self._yield()
        for alert in self.alerts.values():
            if alert.Status == "PENDING" and alert.ExpiresAt <= now:
                alert.Status = "EXPIRED"
            if alert.Status == "SENDING" and alert.ClaimedAt <= now - sending_stale_after:
                alert.Status, alert.ErrorCode = "FAILED", "UNKNOWN_DELIVERY"

    async def claim_due(self, now, *, heartbeat, limit=20):
        await self._yield()
        claimed = []
        for alert in sorted(self.alerts.values(), key=lambda a: a.DueAt):
            if (
                alert.Status == "PENDING" and alert.DueAt <= now and alert.ExpiresAt > now
                and alert.LastConfirmedAt >= now - heartbeat and len(claimed) < limit
            ):
                alert.Status, alert.ClaimedAt = "SENDING", now
                alert.Attempts += 1
                claimed.append(alert)
        return claimed

    async def delivery_context(self, alert):
        await self._yield()
        session = self.sessions.get(alert.SessionId)
        child = self.children.get(alert.ChildId)
        return DeliveryContext(
            session_state=session.State if session else None,
            child_alias=child.Alias if child else None,
            email_enabled=self.settings.get(alert.ParentId, False),
        )

    async def finish_alert(self, alert_id, *, status, now, error_code=None, cancel_reason=None):
        await self._yield()
        alert = self.alerts[alert_id]
        if alert.Status != "SENDING":
            return
        alert.Status, alert.ErrorCode = status, error_code
        if cancel_reason:
            alert.CancelReason = cancel_reason
        if status == "SENT":
            alert.SentAt = now

    async def release_for_retry(self, alert_id):
        await self._yield()
        alert = self.alerts[alert_id]
        if alert.Status == "SENDING":
            alert.Status, alert.ClaimedAt = "PENDING", None


class Mailbox:
    def __init__(self):
        self.sent: list[dict] = []
        self.failures: list[Exception] = []

    def __call__(self, **kwargs):
        if self.failures:
            raise self.failures.pop(0)
        self.sent.append(kwargs)


def setup(enabled=True, **session_kwargs):
    repo = FakeRepo()
    repo.add_session(**session_kwargs)
    if enabled:
        repo.settings[PARENT] = True
    return repo, ReadingPresenceService(repo, LIMITS)


async def resolver(_parent_id):
    return "parent@example.test"


def deliver(service, now, mailbox, resolve=resolver):
    return service.deliver_due(
        now,
        recipient_resolver=resolve,
        email_sender=mailbox,
        parent_email_unavailable=Unavailable,
        parent_lookup_failed=LookupFailed,
    )


async def armed(service, episode=None, now=NOW):
    alert, created = await service.arm(PARENT, SESSION, episode or uuid4(), now)
    assert created
    return alert


class ArmingTests(unittest.IsolatedAsyncioTestCase):
    async def test_off_by_default_and_creates_nothing(self):
        repo, service = setup(enabled=False)
        self.assertFalse(await service.email_enabled(PARENT))
        with self.assertRaises(PresenceConflict) as raised:
            await service.arm(PARENT, SESSION, uuid4(), NOW)
        self.assertEqual(raised.exception.reason, "PRESENCE_ALERT_DISABLED")
        self.assertEqual(repo.alerts, {})

    async def test_other_family_cannot_arm_confirm_or_cancel(self):
        repo, service = setup()
        with self.assertRaises(PresenceNotFound):
            await service.arm(OTHER_PARENT, SESSION, uuid4(), NOW)
        alert = await armed(service)
        with self.assertRaises(PresenceNotFound):
            await service.confirm(OTHER_PARENT, alert.Id, NOW)
        with self.assertRaises(PresenceNotFound):
            await service.cancel(OTHER_PARENT, alert.Id)
        self.assertEqual(alert.Status, "PENDING")
        with self.assertRaises(PresenceNotFound):
            await service.arm(PARENT, uuid4(), uuid4(), NOW)

    async def test_finished_or_aborted_sessions_cannot_be_armed(self):
        for state, ended in (("FINISHED", None), ("COMPLETED", None), ("ABORTED", None), ("LISTENING", NOW)):
            repo, service = setup(state=state, ended=ended)
            with self.assertRaises(PresenceConflict) as raised:
                await service.arm(PARENT, SESSION, uuid4(), NOW)
            self.assertEqual(raised.exception.reason, "SESSION_NOT_ACTIVE")
            self.assertEqual(repo.alerts, {})

    async def test_timing_is_decided_by_the_server(self):
        _, service = setup()
        alert = await armed(service)
        self.assertEqual(alert.DueAt, NOW + timedelta(seconds=60))
        self.assertEqual(alert.ExpiresAt, NOW + timedelta(seconds=360))
        self.assertEqual(alert.Status, "PENDING")

    def test_client_cannot_name_a_recipient_or_send_media(self):
        for field in ("email", "recipient", "to", "image", "audio", "transcript"):
            with self.assertRaises(ValidationError):
                PresenceAlertArm(session_id=SESSION, episode_id=uuid4(), **{field: "x@y.z"})
        with self.assertRaises(ValidationError):
            PresenceSettingsUpdate(email_enabled=True, email="x@y.z")

    async def test_same_episode_is_idempotent_even_for_concurrent_requests(self):
        repo, service = setup()
        episode = uuid4()
        results = await asyncio.gather(
            *[service.arm(PARENT, SESSION, episode, NOW) for _ in range(8)]
        )
        self.assertEqual(len(repo.alerts), 1)
        self.assertEqual(len({r[0].Id for r in results}), 1)
        self.assertEqual(sum(1 for _, created in results if created), 1)

    async def test_cooldown_and_daily_limit(self):
        repo, service = setup()
        await armed(service)
        with self.assertRaises(PresenceConflict) as raised:
            await service.arm(PARENT, SESSION, uuid4(), NOW + timedelta(minutes=5))
        self.assertEqual(raised.exception.reason, "SESSION_COOLDOWN")
        later = NOW + timedelta(minutes=31)
        await armed(service, now=later)
        later2 = later + timedelta(minutes=31)
        await armed(service, now=later2)
        with self.assertRaises(PresenceConflict) as raised:
            await service.arm(PARENT, SESSION, uuid4(), later2 + timedelta(minutes=31))
        self.assertEqual(raised.exception.reason, "DAILY_LIMIT")

    async def test_opting_out_cancels_what_is_waiting(self):
        repo, service = setup()
        alert = await armed(service)
        self.assertTrue(await service.set_email_enabled(PARENT, True, NOW))
        self.assertFalse(await service.set_email_enabled(PARENT, False, NOW))
        self.assertEqual((alert.Status, alert.CancelReason), ("CANCELLED", "OPT_OUT"))
        mailbox = Mailbox()
        await deliver(service, NOW + timedelta(seconds=90), mailbox)
        self.assertEqual(mailbox.sent, [])


class DeliveryTests(unittest.IsolatedAsyncioTestCase):
    async def test_sends_exactly_one_neutral_email_to_the_verified_address(self):
        repo, service = setup()
        alert = await armed(service)
        mailbox = Mailbox()
        self.assertEqual(await deliver(service, NOW + timedelta(seconds=30), mailbox), 0)
        self.assertEqual(await deliver(service, NOW + timedelta(seconds=61), mailbox), 0)  # heartbeat stale
        await service.confirm(PARENT, alert.Id, NOW + timedelta(seconds=55))
        self.assertEqual(await deliver(service, NOW + timedelta(seconds=61), mailbox), 1)
        self.assertEqual(await deliver(service, NOW + timedelta(seconds=70), mailbox), 0)
        self.assertEqual(len(mailbox.sent), 1)
        self.assertEqual(mailbox.sent[0]["recipient"], "parent@example.test")
        self.assertEqual(alert.Status, "SENT")

    async def test_heartbeat_keeps_the_alert_alive_and_silence_cancels_the_send(self):
        repo, service = setup()
        alert = await armed(service)
        mailbox = Mailbox()
        # Tab closed / app left: no confirm after arming -> never sent.
        self.assertEqual(await deliver(service, NOW + timedelta(seconds=75), mailbox), 0)
        self.assertEqual(mailbox.sent, [])
        self.assertEqual(alert.Status, "PENDING")

    async def test_returning_ending_or_leaving_before_due_sends_nothing(self):
        for action in ("cancel", "session-ended", "opt-out", "session-state"):
            repo, service = setup()
            alert = await armed(service)
            await service.confirm(PARENT, alert.Id, NOW + timedelta(seconds=55))
            if action == "cancel":
                await service.cancel(PARENT, alert.Id, "RETURNED")
            elif action == "session-ended":
                await service.cancel_for_session(SESSION)
            elif action == "opt-out":
                repo.settings[PARENT] = False  # change that bypassed cancellation
            else:
                repo.sessions[SESSION].State = "FINISHED"  # ended without notifying us
            mailbox = Mailbox()
            await deliver(service, NOW + timedelta(seconds=61), mailbox)
            self.assertEqual(mailbox.sent, [], action)

    async def test_expired_alerts_are_never_sent_late(self):
        repo, service = setup()
        alert = await armed(service)
        await service.confirm(PARENT, alert.Id, NOW + timedelta(seconds=55))
        mailbox = Mailbox()
        await deliver(service, NOW + timedelta(seconds=361), mailbox)
        self.assertEqual(mailbox.sent, [])
        self.assertEqual(alert.Status, "EXPIRED")

    async def test_unverified_email_fails_without_sending(self):
        repo, service = setup()
        alert = await armed(service)
        await service.confirm(PARENT, alert.Id, NOW + timedelta(seconds=55))

        async def unverified(_):
            raise Unavailable()

        mailbox = Mailbox()
        await deliver(service, NOW + timedelta(seconds=61), mailbox, unverified)
        self.assertEqual(mailbox.sent, [])
        self.assertEqual((alert.Status, alert.ErrorCode), ("FAILED", "PARENT_EMAIL_UNVERIFIED"))

    async def test_temporary_lookup_failure_retries_and_still_sends_once(self):
        repo, service = setup()
        alert = await armed(service)
        await service.confirm(PARENT, alert.Id, NOW + timedelta(seconds=55))
        calls = {"n": 0}

        async def flaky(_):
            calls["n"] += 1
            if calls["n"] == 1:
                raise LookupFailed()
            return "parent@example.test"

        mailbox = Mailbox()
        await deliver(service, NOW + timedelta(seconds=61), mailbox, flaky)
        self.assertEqual((alert.Status, mailbox.sent), ("PENDING", []))
        await service.confirm(PARENT, alert.Id, NOW + timedelta(seconds=66))
        await deliver(service, NOW + timedelta(seconds=70), mailbox, flaky)
        await deliver(service, NOW + timedelta(seconds=80), mailbox, flaky)
        self.assertEqual(len(mailbox.sent), 1)

    async def test_failure_before_the_message_left_retries_ambiguous_failure_does_not(self):
        repo, service = setup()
        alert = await armed(service)
        await service.confirm(PARENT, alert.Id, NOW + timedelta(seconds=55))
        mailbox = Mailbox()
        mailbox.failures = [provider.PresenceEmailRetryable()]
        await deliver(service, NOW + timedelta(seconds=61), mailbox)
        self.assertEqual(alert.Status, "PENDING")
        await service.confirm(PARENT, alert.Id, NOW + timedelta(seconds=63))
        await deliver(service, NOW + timedelta(seconds=64), mailbox)
        self.assertEqual((alert.Status, len(mailbox.sent)), ("SENT", 1))

        repo2, service2 = setup()
        alert2 = await armed(service2)
        await service2.confirm(PARENT, alert2.Id, NOW + timedelta(seconds=55))
        mailbox2 = Mailbox()
        mailbox2.failures = [RuntimeError("connection reset after DATA")]
        await deliver(service2, NOW + timedelta(seconds=61), mailbox2)
        await service2.confirm(PARENT, alert2.Id, NOW + timedelta(seconds=63))
        await deliver(service2, NOW + timedelta(seconds=64), mailbox2)
        self.assertEqual((alert2.Status, alert2.ErrorCode), ("FAILED", "DELIVERY_UNCERTAIN"))
        self.assertEqual(mailbox2.sent, [])

    async def test_two_workers_at_once_send_one_email(self):
        repo, service = setup()
        alert = await armed(service)
        await service.confirm(PARENT, alert.Id, NOW + timedelta(seconds=55))
        mailbox = Mailbox()
        other_worker = ReadingPresenceService(repo, LIMITS)
        results = await asyncio.gather(
            deliver(service, NOW + timedelta(seconds=61), mailbox),
            deliver(other_worker, NOW + timedelta(seconds=61), mailbox),
        )
        self.assertEqual(sorted(results), [0, 1])
        self.assertEqual(len(mailbox.sent), 1)

    async def test_worker_restart_after_a_crash_does_not_resend(self):
        repo, service = setup()
        alert = await armed(service)
        await service.confirm(PARENT, alert.Id, NOW + timedelta(seconds=55))
        # Worker claimed the alert and died before recording the outcome.
        claimed = await repo.claim_due(NOW + timedelta(seconds=61), heartbeat=timedelta(seconds=30))
        self.assertEqual(len(claimed), 1)
        restarted = ReadingPresenceService(repo, LIMITS)
        mailbox = Mailbox()
        await deliver(restarted, NOW + timedelta(minutes=10), mailbox)
        self.assertEqual(mailbox.sent, [])
        self.assertEqual((alert.Status, alert.ErrorCode), ("FAILED", "UNKNOWN_DELIVERY"))

    async def test_refresh_retry_and_second_device_do_not_create_a_second_email(self):
        repo, service = setup()
        episode = uuid4()
        first, _ = await service.arm(PARENT, SESSION, episode, NOW)
        for _ in range(3):
            again, created = await service.arm(PARENT, SESSION, episode, NOW + timedelta(seconds=5))
            self.assertFalse(created)
            self.assertEqual(again.Id, first.Id)
        await service.confirm(PARENT, first.Id, NOW + timedelta(seconds=55))
        mailbox = Mailbox()
        await deliver(service, NOW + timedelta(seconds=61), mailbox)
        await deliver(service, NOW + timedelta(seconds=62), mailbox)
        self.assertEqual(len(mailbox.sent), 1)


class MessageTests(unittest.TestCase):
    def build(self, alias="Bé An"):
        with patch.object(provider, "SMTP_FROM_EMAIL", "sender@example.test"):
            return provider.build_presence_message(
                recipient="parent@example.test",
                child_alias=alias,
                alert_id=UUID("44444444-4444-4444-8444-444444444444"),
            )

    def test_copy_states_one_neutral_fact_and_nothing_else(self):
        message = self.build()
        body = message.get_content()
        self.assertEqual(message["Subject"], "ViRead đã tạm dừng buổi đọc")
        self.assertIn("một lúc không thấy người đọc trong khung hình", body)
        self.assertIn("tạm dừng", body)
        lowered = body.lower()
        for forbidden in (
            "nguy hiểm", "ở đâu", "mất tích", "bỏ đi", "transcript", "bản ghi",
            "hình ảnh", "ảnh chụp", "ghi âm", "đã đọc", "trang ",
        ):
            self.assertNotIn(forbidden, lowered)
        self.assertEqual(message["To"], "parent@example.test")

    def test_message_id_is_stable_per_alert(self):
        self.assertEqual(self.build()["Message-ID"], self.build("Bé Bo")["Message-ID"])

    def test_mail_sink_writes_one_file_and_refuses_a_second_delivery(self):
        message = self.build()
        with tempfile.TemporaryDirectory() as folder:
            provider._write_to_sink(message, folder)
            files = list(Path(folder).glob("*.eml"))
            self.assertEqual(len(files), 1)
            parsed = message_from_bytes(files[0].read_bytes(), policy=email_policy.default)
            self.assertEqual(parsed["Subject"], "ViRead đã tạm dừng buổi đọc")
            self.assertIn("không thấy người đọc trong khung hình", parsed.get_content())
            with self.assertRaises(FileExistsError):
                provider._write_to_sink(message, folder)


class RouteTests(unittest.TestCase):
    """HTTP contract: auth, validation, ownership and the shape of the answer."""

    def make_client(self, actor=PARENT, enabled=True):
        from fastapi import FastAPI
        from fastapi.testclient import TestClient

        from app.api import deps
        from app.api.routes import reading_presence as route

        repo, service = setup(enabled=enabled)
        app = FastAPI()
        app.include_router(route.router, prefix="/reading-presence")
        app.dependency_overrides[deps.get_db] = lambda: None
        if actor is not None:
            app.dependency_overrides[deps.require_parent_id] = lambda: actor
        patcher = patch.object(route, "build_service", lambda _db: service)
        patcher.start()
        self.addCleanup(patcher.stop)
        return TestClient(app), repo

    def test_requires_authentication(self):
        client, _ = self.make_client(actor=None)
        body = {"session_id": str(SESSION), "episode_id": str(uuid4())}
        self.assertIn(client.post("/reading-presence/alerts", json=body).status_code, (401, 403))
        self.assertIn(client.get("/reading-presence/settings").status_code, (401, 403))

    def test_arm_rejects_unknown_fields_and_never_echoes_an_address(self):
        client, repo = self.make_client()
        base = {"session_id": str(SESSION), "episode_id": str(uuid4())}
        for extra in ({"email": "evil@example.test"}, {"recipient": "evil@example.test"}, {"image": "AAAA"}):
            response = client.post("/reading-presence/alerts", json={**base, **extra})
            self.assertEqual(response.status_code, 422)
        self.assertEqual(repo.alerts, {})
        ok = client.post("/reading-presence/alerts", json=base)
        self.assertEqual(ok.status_code, 201)
        self.assertNotIn("@", ok.text)
        self.assertEqual(ok.json()["status"], "PENDING")

    def test_settings_default_off_and_toggle(self):
        client, _ = self.make_client(enabled=False)
        self.assertEqual(client.get("/reading-presence/settings").json(), {"email_enabled": False})
        self.assertEqual(
            client.put("/reading-presence/settings", json={"email_enabled": True}).json(),
            {"email_enabled": True},
        )
        self.assertEqual(
            client.put("/reading-presence/settings", json={"email_enabled": False}).json(),
            {"email_enabled": False},
        )

    def test_disabled_and_foreign_sessions_are_refused(self):
        client, _ = self.make_client(enabled=False)
        body = {"session_id": str(SESSION), "episode_id": str(uuid4())}
        refused = client.post("/reading-presence/alerts", json=body)
        self.assertEqual((refused.status_code, refused.json()["detail"]), (409, {"code": "PRESENCE_ALERT_DISABLED"}))
        foreign, _ = self.make_client(actor=OTHER_PARENT, enabled=True)
        self.assertEqual(foreign.post("/reading-presence/alerts", json=body).status_code, 404)

if __name__ == "__main__":
    unittest.main()
