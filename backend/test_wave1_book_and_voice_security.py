"""Wave 0 + Wave 1 #1 security and reliability regression tests for Book routes & Voice worker."""
from __future__ import annotations

import os
import unittest
from datetime import datetime, timezone
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock, patch
from uuid import UUID, uuid4

os.environ.setdefault("APP_ENVIRONMENT", "test")
os.environ.setdefault("DATABASE_URL", "postgresql+asyncpg://test:test@127.0.0.1:1/test")
os.environ.setdefault("SUPABASE_URL", "https://example.supabase.co")
os.environ.setdefault("SUPABASE_KEY", "isolated-test-key")

import numpy as np
from fastapi import FastAPI, HTTPException, status
from fastapi.testclient import TestClient

from app.api.deps import get_db
from app.api.router import api_router
from test_voice_internet_resilience import _load_voice_worker_module

PARENT_ID = UUID("11111111-1111-4111-8111-111111111111")
INACTIVE_ID = UUID("22222222-2222-4222-8222-222222222222")
BOOK_ID = UUID("77777777-7777-4777-8777-777777777777")
PAGE_ID = UUID("88888888-8888-4888-8888-888888888888")
REV_ID = UUID("99999999-9999-4999-8999-999999999999")


def _sample_page() -> SimpleNamespace:
    return SimpleNamespace(
        Id=PAGE_ID,
        BookId=BOOK_ID,
        PageNumber=1,
        ImagePath="books/b1/pages/p1/page1.png",
        Width=800,
        Height=1200,
        FeaturePath="features/secret.npy",
        ProcessingMeta={"internal": "secret"},
        LifecycleStatus="ACTIVE",
        CurrentVerifiedRevisionId=REV_ID,
        CreatedAt=datetime(2026, 1, 1, tzinfo=timezone.utc),
    )


class BookRouteSecurityWave1Tests(unittest.TestCase):
    def _build_app(self, db: MagicMock) -> TestClient:
        app = FastAPI()
        app.include_router(api_router)
        app.dependency_overrides[get_db] = lambda: db
        return TestClient(app)

    def test_get_books_omits_created_by_admin_uuid(self) -> None:
        db = MagicMock()
        client = self._build_app(db)
        book_row = SimpleNamespace(
            Id=BOOK_ID,
            Name="Sách thử",
            Title="Sách thử",
            Author="Tác giả",
            MinGrade=1,
            MaxGrade=3,
            LifecycleStatus="ACTIVE",
            CreatedBy=UUID("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"),
            CreatedAt=datetime(2026, 1, 1, tzinfo=timezone.utc),
        )
        with patch(
            "app.api.routes.book.BookService.list_books",
            new=AsyncMock(return_value=[book_row]),
        ):
            resp = client.get("/books/")
        self.assertEqual(resp.status_code, 200)
        body = resp.json()
        self.assertEqual(len(body), 1)
        self.assertEqual(body[0]["Id"], str(BOOK_ID))
        self.assertNotIn("CreatedBy", body[0])

    def test_get_book_pages_rejects_forged_authorization_and_never_mints_signed_urls(self) -> None:
        db = MagicMock()
        db.rollback = AsyncMock()
        client = self._build_app(db)

        def _reject_jwt(_credentials):
            raise HTTPException(
                status_code=status.HTTP_401_UNAUTHORIZED,
                detail="Invalid authentication credentials",
            )

        with (
            patch("app.api.routes.book.BookService.list_pages", new=AsyncMock(return_value=[_sample_page()])),
            patch("app.api.routes.book.get_current_parent_id", side_effect=_reject_jwt),
            patch("app.services.storage_service.create_signed_image_urls") as sign_mock,
        ):
            # Non-Bearer garbage header must fail closed with 401
            res_garbage = client.get(
                f"/books/{BOOK_ID}/pages",
                headers={"Authorization": "forged-token"},
            )
            self.assertEqual(res_garbage.status_code, 401)

            # Invalid Bearer JWT must fail closed with 401
            res_bad_jwt = client.get(
                f"/books/{BOOK_ID}/pages",
                headers={"Authorization": "Bearer fake-jwt"},
            )
            self.assertEqual(res_bad_jwt.status_code, 401)
            sign_mock.assert_not_called()

    def test_get_book_pages_rejects_inactive_profile_and_never_mints_signed_urls(self) -> None:
        db = MagicMock()
        db.rollback = AsyncMock()
        client = self._build_app(db)

        with (
            patch("app.api.routes.book.BookService.list_pages", new=AsyncMock(return_value=[_sample_page()])),
            patch("app.api.routes.book.get_current_parent_id", return_value=INACTIVE_ID),
            patch("app.api.routes.book.get_cached_profile_role", new=AsyncMock(return_value=None)),
            patch("app.services.storage_service.create_signed_image_urls") as sign_mock,
        ):
            resp = client.get(
                f"/books/{BOOK_ID}/pages",
                headers={"Authorization": "Bearer valid-jwt-inactive-user"},
            )
        self.assertEqual(resp.status_code, 403)
        sign_mock.assert_not_called()

    def test_get_book_pages_verified_active_user_rolls_back_before_batch_signing(self) -> None:
        events: list[str] = []
        db = MagicMock()

        async def _rollback() -> None:
            events.append("rollback")

        def _sign(paths: list[str]) -> list[str]:
            events.append("sign")
            return [f"https://signed.example.com/{p}?token=abc" for p in paths]

        db.rollback = AsyncMock(side_effect=_rollback)
        client = self._build_app(db)

        with (
            patch("app.api.routes.book.BookService.list_pages", new=AsyncMock(return_value=[_sample_page()])),
            patch("app.api.routes.book.get_current_parent_id", return_value=PARENT_ID),
            patch("app.api.routes.book.get_cached_profile_role", new=AsyncMock(return_value="parent")),
            patch("app.services.storage_service.create_signed_image_urls", side_effect=_sign),
        ):
            resp = client.get(
                f"/books/{BOOK_ID}/pages",
                headers={"Authorization": "Bearer verified-active-jwt"},
            )
        self.assertEqual(resp.status_code, 200)
        body = resp.json()
        self.assertEqual(body[0]["ImagePath"], "https://signed.example.com/books/b1/pages/p1/page1.png?token=abc")
        self.assertIsNone(body[0]["FeaturePath"])
        self.assertEqual(body[0]["ProcessingMeta"], {})
        self.assertEqual(events, ["rollback", "sign"])


class VoiceWorkerWave0RegressionTests(unittest.TestCase):
    def test_quiz_choice_normalization_and_norm_v_bump(self) -> None:
        vw = _load_voice_worker_module()
        self.assertEqual(
            vw.normalize_vietnamese_tts_text("Đáp án B: Quyển sách."),
            "Đáp án bê, Quyển sách.",
        )
        self.assertEqual(
            vw.normalize_vietnamese_tts_text("C: Con mèo"),
            "xê, Con mèo",
        )
        self.assertIn("chỗ trống", vw.normalize_vietnamese_tts_text("Bé cầm … màu đỏ."))
        k1 = vw.make_cache_key(voice_id="v1", speed=1.0, mode="sentence", payload="xin chào")
        self.assertEqual(len(k1), 64)

    def test_sustained_clipping_and_client_vad_mode_flush_ack(self) -> None:
        vw = _load_voice_worker_module()

        # 1. Brief transient spike (<480 samples) must NOT trigger false CLIPPING.
        sess = vw._WsSttSession()
        sess.session_id = "s1"
        sess.turn_id = "t1"
        chunk = np.full(3200, 0.05, dtype=np.float32)  # 200ms voiced
        chunk[:100] = 1.0  # 100 samples < 480 min threshold
        sess.push_pcm16k(chunk)
        quality = sess._build_quality()
        self.assertEqual(quality["status"], "OK")

        # 2. Sustained clipping (>=5% AND >=480 samples) triggers CLIPPING.
        sess2 = vw._WsSttSession()
        sess2.session_id = "s2"
        sess2.turn_id = "t2"
        clipped = np.full(3200, 0.05, dtype=np.float32)
        clipped[:640] = 1.0  # 20% and 640 >= 480
        sess2.push_pcm16k(clipped)
        self.assertEqual(sess2._build_quality()["status"], "CLIPPING")

        # 3. vad_mode='client' does NOT auto-flush on silence and emits empty ACK on explicit flush.
        sess3 = vw._WsSttSession()
        sess3.session_id = "s3"
        sess3.turn_id = "turn-a"
        sess3.vad_mode = "client"
        sess3.push_pcm16k(np.full(3200, 0.05, dtype=np.float32))
        for _ in range(10):
            sess3.push_pcm16k(np.zeros(1600, dtype=np.float32))
        self.assertEqual(len(sess3.pending_flushes), 0)

        # Empty flush with emit_empty_ack=True produces an empty ACK job carrying turn_id_override.
        sess4 = vw._WsSttSession()
        sess4.session_id = "s4"
        sess4.vad_mode = "client"
        sess4.enqueue_flush(carry_tail=False, turn_id_override="turn-empty", emit_empty_ack=True)
        self.assertEqual(len(sess4.pending_flushes), 1)
        self.assertEqual(sess4.pending_flushes[0].turn_id, "turn-empty")
        self.assertEqual(sess4.pending_flushes[0].audio_window.size, 0)


if __name__ == "__main__":
    unittest.main()
