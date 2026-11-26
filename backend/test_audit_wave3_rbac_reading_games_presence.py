"""Wave 3 regression tests (AUD-010 & AUD-011):
- Deactivated profile (Active=0) RBAC & avatar_path prefix security
- SQL migration verification on disposable PostgreSQL (CHECKs, FK CASCADE, INTEGER ms, indexes)
- Sentence Shooter duplicate-word token matching & active/eligible SQL guards
- Picture Description fail-closed child safety moderation
- Reading event bounds, FOR UPDATE OF readingsessions, plan actor_id, presence CAMERA_UNAVAILABLE, reminder Active=1
"""
from __future__ import annotations

from datetime import datetime, timezone
import inspect
import os
from pathlib import Path
from types import SimpleNamespace
import unittest
from unittest.mock import AsyncMock, MagicMock, patch
from uuid import uuid4

os.environ["APP_ENVIRONMENT"] = "test"
os.environ.setdefault("DATABASE_URL", "postgresql+asyncpg://test:test@127.0.0.1:5432/test")
os.environ.setdefault("SUPABASE_URL", "https://example.supabase.co")
os.environ.setdefault("SUPABASE_KEY", "isolated-test-key")

from pydantic import ValidationError
from sqlalchemy import text
from sqlalchemy.dialects import postgresql
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from app.api.routes import reading as reading_routes
from app.api.routes import reading_management as reading_management_routes
from app.repositories.reading_comparison_repository import ReadingComparisonRepository
from app.repositories.reading_content_repository import ReadingContentRepository
from app.repositories.reading_management_repository import ReadingManagementRepository
from app.repositories.sentence_shooter_repository import SentenceShooterRepository
from app.schemas.reading import ReadingEventCreate
from app.schemas.reading_presence import PresenceAlertCancel
from app.services.games.sentence_shooter_service import SentenceShooterService
from app.services.picture_description_ai import GeminiPictureDescriptionAI, PictureAiError
from app.services.profile_service import ProfileAccessDeniedError, ProfileService


class AuditWave3RbacReadingGamesPresenceTests(unittest.IsolatedAsyncioTestCase):
    async def test_aud010_deactivated_profile_denied_and_avatar_path_prefix_enforced(
        self,
    ) -> None:
        me_id = uuid4()
        child_id = uuid4()
        inactive_profile = SimpleNamespace(
            Id=me_id,
            DisplayName="Inactive Parent",
            Role="parent",
            Active=0,
            CreatedAt=datetime.now(timezone.utc),
            ContactPhone=None,
            AvatarPath=None,
            children=[],
        )
        repo = MagicMock()
        repo.get_by_id = AsyncMock(return_value=inactive_profile)
        contact_prov = MagicMock()
        contact_prov.get_contact_info = AsyncMock(
            return_value={"email": "p@example.com", "contact_info_status": "available"}
        )
        svc = ProfileService(repo, contact_prov)

        with self.assertRaises(ProfileAccessDeniedError):
            await svc.get_current_profile(me_id)
        with self.assertRaises(ProfileAccessDeniedError):
            await svc.get_profile_for_owner(me_id, me_id)

        # Active profile with forged cross-user avatar_path must NOT sign the foreign path
        active_profile = SimpleNamespace(
            Id=me_id,
            DisplayName="Active Parent",
            Role="parent",
            Active=1,
            CreatedAt=datetime.now(timezone.utc),
            ContactPhone=None,
            AvatarPath=f"profiles/{uuid4()}/avatar/stolen.png",
            children=[
                SimpleNamespace(
                    Id=child_id,
                    Alias="Bé Na",
                    Grade=2,
                    CreatedAt=datetime.now(timezone.utc),
                    AvatarPath=f"children/{child_id}/avatar/valid.png",
                )
            ],
        )
        repo.get_by_id = AsyncMock(return_value=active_profile)
        with patch(
            "app.services.profile_service.create_cached_signed_image_urls",
            side_effect=lambda paths, **_: [f"https://signed.example/{path}" for path in paths],
        ) as sign_mock:
            result = await svc.get_current_profile(me_id)
            self.assertIsNone(result["avatar_url"])
            self.assertEqual(
                result["children"][0]["avatar_url"],
                f"https://signed.example/children/{child_id}/avatar/valid.png",
            )
            self.assertEqual(sign_mock.call_count, 1)
            self.assertEqual(
                sign_mock.call_args.args[0],
                [f"children/{child_id}/avatar/valid.png"],
            )

        # SentenceShooterRepository bundle queries must enforce Profile.Active == 1
        shot_src = inspect.getsource(SentenceShooterRepository.load_shot_bundle)
        result_src = inspect.getsource(SentenceShooterRepository.load_result_bundle)
        self.assertIn("Profile.Active == 1", shot_src)
        self.assertIn("Profile.Active == 1", result_src)
        self.assertIn("eligible_book", result_src)

    async def test_aud011_sentence_shooter_accepts_duplicate_word_tokens_and_picture_ai_fails_closed(
        self,
    ) -> None:
        # 1. Duplicate word tokens ("mèo con thấy mèo"): shooting the 2nd "mèo" bubble first must succeed!
        actor_id = uuid4()
        session_id = uuid4()
        round_id = uuid4()
        t1, t2, t3, t4 = uuid4(), uuid4(), uuid4(), uuid4()
        game_session = SimpleNamespace(
            Id=session_id,
            Status="IN_PROGRESS",
            CompletedRounds=0,
            TotalRounds=1,
            CorrectCount=0,
            MistakeCount=0,
            TotalStars=0,
            CompletedAt=None,
        )
        game_round = SimpleNamespace(
            Id=round_id,
            GameSessionId=session_id,
            RoundNumber=1,
            Status="IN_PROGRESS",
            SentenceSnapshot="Mèo con thấy mèo.",
            TokensSnapshot=[
                {"id": str(t1), "text": "Mèo"},
                {"id": str(t2), "text": "con"},
                {"id": str(t3), "text": "thấy"},
                {"id": str(t4), "text": "mèo"},
            ],
            ExpectedTokenIds=[str(t1), str(t2), str(t3), str(t4)],
            ShuffledTokenIds=[str(t4), str(t2), str(t1), str(t3)],
            NextExpectedPosition=0,
            CorrectCount=0,
            MistakeCount=0,
            HintCount=0,
            Stars=0,
            CompletedAt=None,
        )
        repo = MagicMock()
        repo.load_shot_bundle = AsyncMock(return_value=(game_session, game_round, None))
        repo.add = MagicMock()
        repo.commit = AsyncMock()
        shooter = SentenceShooterService(repo)

        shot_res = await shooter.shoot(actor_id, session_id, round_id, t4, uuid4())
        self.assertTrue(shot_res.is_correct)
        self.assertEqual(game_round.MistakeCount, 0)
        self.assertEqual(game_round.NextExpectedPosition, 1)
        # And t1 must now occupy position 3 so the child can still shoot t1 at the end!
        self.assertEqual(game_round.ExpectedTokenIds[0], str(t4))
        self.assertEqual(game_round.ExpectedTokenIds[3], str(t1))

        # 2. GeminiPictureDescriptionAI must fail CLOSED when is_child_safe is missing/null
        pic_ai = GeminiPictureDescriptionAI()
        pic_ai._generate_json = AsyncMock(  # type: ignore[method-assign]
            return_value=({"scene_title": "Tranh tải lên"}, "ollama:qwen3-vl")
        )
        with self.assertRaises(PictureAiError) as ctx:
            await pic_ai.analyze_picture(
                image_bytes=b"fake",
                mime_type="image/png",
                child_grade=2,
            )
        self.assertEqual(ctx.exception.code, "UNSAFE_PICTURE")

    async def test_aud011_reading_event_bounds_row_lock_scope_plan_actor_and_presence_cancel_reason(
        self,
    ) -> None:
        # 1. ReadingEventCreate rejects EndMs < StartMs and > 32-bit INT max
        with self.assertRaises(ValidationError):
            ReadingEventCreate(
                SessionId=uuid4(),
                PageId=uuid4(),
                PageRevisionId=uuid4(),
                Type="WORD_READ",
                StartMs=5000,
                EndMs=3000,
                Status="DETECTED",
            )
        with self.assertRaises(ValidationError):
            ReadingEventCreate(
                SessionId=uuid4(),
                PageId=uuid4(),
                PageRevisionId=uuid4(),
                Type="WORD_READ",
                StartMs=3_000_000_000,
                Status="DETECTED",
            )
        # Reading > 32,767 ms (e.g. 120,000 ms = 2 min) is valid
        valid_ev = ReadingEventCreate(
            SessionId=uuid4(),
            PageId=uuid4(),
            PageRevisionId=uuid4(),
            Type="WORD_READ",
            StartMs=120_000,
            EndMs=121_500,
            Status="DETECTED",
        )
        self.assertEqual(valid_ev.StartMs, 120_000)

        # 2. FOR UPDATE OF readingsessions (not locking shared books row)
        rc_src = inspect.getsource(ReadingContentRepository.session_for_update)
        cmp_src = inspect.getsource(ReadingComparisonRepository.lock_session)
        self.assertIn("of=ReadingSession", rc_src)
        self.assertIn("of=ReadingSession", cmp_src)

        # 3. PresenceAlertCancel accepts CAMERA_UNAVAILABLE
        cancel_payload = PresenceAlertCancel(reason="CAMERA_UNAVAILABLE")
        self.assertEqual(cancel_payload.reason, "CAMERA_UNAVAILABLE")

        # 4. reading_management plan routes pass actor_id=actor_id & reminder claim checks Profile.Active == 1
        rm_src = inspect.getsource(reading_management_routes.create_plan)
        self.assertIn("actor_id=actor_id", rm_src)
        claim_src = inspect.getsource(ReadingManagementRepository.claim_due_email_occurrences)
        self.assertIn("Profile.Active == 1", claim_src)

        # 5. match_book_page_from_camera does NOT fall back to unverified PageRevision
        match_src = inspect.getsource(reading_routes.match_book_page_from_camera)
        self.assertIn("CurrentVerifiedRevisionId.is_not(None)", match_src)
        self.assertNotIn("order_by(PageRevision.CreatedAt.desc())", match_src)

        # 6. AUD-012: text_alignment.align_text handles hyphenated Vietnamese words ("ô-tô", "ra-đi-ô")
        from app.services.text_alignment import align_text

        aligned = align_text("Chiếc ô-tô có ra-đi-ô đỏ.", "Chiếc ô tô có ra đi ô đỏ")
        self.assertEqual(aligned["distance"], 0)
        self.assertTrue(all(item["status"] == "MATCH" for item in aligned["alignment"]))

    async def test_aud010_sql_migration_applies_cleanly_on_disposable_pg_and_enforces_checks(
        self,
    ) -> None:
        migration_path = (
            Path(__file__).resolve().parents[1]
            / "supabase"
            / "migrations"
            / "20261122060000_audit_security_fk_and_indexes.sql"
        )
        self.assertTrue(migration_path.is_file(), "Expected new audit SQL migration file")

        import psycopg2
        from parent_private_book_pg_fixture import DisposablePrivateBookDatabase

        harness = DisposablePrivateBookDatabase()
        harness.setup()
        try:
            sync_url = harness.async_url.replace("postgresql+asyncpg://", "postgresql://", 1)
            sql_text = migration_path.read_text(encoding="utf-8")
            with psycopg2.connect(sync_url) as sync_conn:
                sync_conn.autocommit = True
                with sync_conn.cursor() as cur:
                    cur.execute("ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS avatar_path text;")
                    cur.execute(sql_text)
                    # Idempotency check: running a second time must also succeed cleanly!
                    cur.execute(sql_text)

            Session = harness.sessions
            parent_id = uuid4()
            book_id = uuid4()
            async with Session() as db:
                await db.execute(
                    text(
                        "INSERT INTO public.profiles (id, role, displayname, active) "
                        "VALUES (:id, 'parent', 'Parent Mig', 1)"
                    ),
                    {"id": parent_id},
                )
                await db.execute(
                    text(
                        "INSERT INTO public.books "
                        "(id, name, title, mingrade, maxgrade, lifecyclestatus, visibility_scope, owner_parent_id) "
                        "VALUES (:bid, 'Private Book', 'Private Book', 1, 5, 'ACTIVE', 'PARENT_PRIVATE', :pid)"
                    ),
                    {"bid": book_id, "pid": parent_id},
                )
                await db.commit()

                # 1. Forged URL in avatar_path is blocked at PostgreSQL CHECK level
                with self.assertRaises(Exception):
                    await db.execute(
                        text("UPDATE public.profiles SET avatar_path = 'https://evil.test/x.png' WHERE id = :id"),
                        {"id": parent_id},
                    )
                await db.rollback()

                # 2. Deleting parent cascades private book cleanly (no RESTRICT violation!)
                await db.execute(
                    text("DELETE FROM public.profiles WHERE id = :id"),
                    {"id": parent_id},
                )
                await db.commit()
                remaining = await db.scalar(
                    text("SELECT count(*) FROM public.books WHERE id = :bid"),
                    {"bid": book_id},
                )
                self.assertEqual(remaining, 0)
        finally:
            await harness.teardown()


if __name__ == "__main__":
    unittest.main()
