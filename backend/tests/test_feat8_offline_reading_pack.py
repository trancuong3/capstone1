"""Feature #8 tests: Offline Reading Pack Manifest & Idempotent Session Outbox Sync.

Covers:
1. SQL migration `20261128151000_feat8_offline_sync_events.sql` RLS & unique ledger constraints.
2. Manifest access (`GET /offline/children/{child_id}/books/{book_id}/pack-manifest`) for both
   active `CATALOG` books and owner `PARENT_PRIVATE` books, including `Cache-Control: private, no-store`,
   phonics keyterms, word bboxes, and bounded `TtsAudioCacheService` metadata/clips.
3. Cross-parent & inactive/non-parent access blocks (403/404) on manifest, TTS audio, and sync-outbox.
4. Idempotent replay of identical `client_event_id` batch + in-request duplicates (0 duplicate
   sessions, reading events, or fluency scores).
5. Stale `page_revision_id` graceful reconciliation (`stale_revision_reconciled: true`), preserving
   child effort and mapping words onto the current verified revision instead of dropping progress.

Compatible with both `pytest` and `python -m unittest`.
"""
from __future__ import annotations

from contextlib import asynccontextmanager
from datetime import datetime, timezone
import os
from pathlib import Path
import sys
import unittest
from typing import Any
from unittest.mock import patch
from uuid import UUID, uuid4

_BACKEND_DIR = Path(__file__).resolve().parents[1]
_REPO_ROOT = _BACKEND_DIR.parent
if str(_BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(_BACKEND_DIR))

os.environ["APP_ENVIRONMENT"] = "test"
os.environ.setdefault("DATABASE_URL", "postgresql+asyncpg://test:test@127.0.0.1:1/test")
os.environ.setdefault("SUPABASE_URL", "https://example.supabase.co")
os.environ.setdefault("SUPABASE_KEY", "isolated-test-key")
os.environ.setdefault("SUPABASE_STORAGE_BUCKET", "viread-test-catalog")
os.environ.setdefault("SUPABASE_PRIVATE_BOOKS_BUCKET", "viread-test-private")
os.environ.setdefault("VIREAD_LOCAL_VOICE_WORKER_AUTOSTART", "false")

from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy import create_engine, event, select
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.ext.compiler import compiles
from sqlalchemy.orm import Session, sessionmaker
from sqlalchemy.pool import StaticPool

from app.api.deps import get_current_parent_id, get_db
from app.api.router import api_router
from app.database.session import Base
from app.models import (
    Book,
    BookPage,
    ChildProfile,
    FluencyAssessment,
    OfflineSyncEvent,
    PageRevision,
    PageRevisionWord,
    ParentBookPageSubmission,
    Profile,
    ReadingEvent,
    ReadingSession,
    TtsAudioCacheEntry,
)
from app.models.smart_book_studio import BookPresentationAsset
from app.services.tts_audio_cache_service import (
    CachedTtsHit,
    canonical_tts_sha256,
    canonical_tts_text,
)


@compiles(JSONB, "sqlite")
def _compile_jsonb_sqlite(_type: Any, _compiler: Any, **_kw: Any) -> str:
    return "JSON"


_REQUIRED_TABLES = (
    Profile.__table__,
    ChildProfile.__table__,
    Book.__table__,
    BookPage.__table__,
    PageRevision.__table__,
    PageRevisionWord.__table__,
    ParentBookPageSubmission.__table__,
    BookPresentationAsset.__table__,
    TtsAudioCacheEntry.__table__,
    ReadingSession.__table__,
    ReadingEvent.__table__,
    FluencyAssessment.__table__,
    OfflineSyncEvent.__table__,
)


class _AsyncSqliteSessionAdapter:
    """Thin AsyncSession adapter over a real SQLite in-memory SQLAlchemy Session."""

    def __init__(self, sync_session: Session) -> None:
        self._sync = sync_session
        self.bind = sync_session.bind

    def get_bind(self) -> Any:
        return self._sync.get_bind()

    def add(self, instance: Any) -> None:
        self._sync.add(instance)

    async def execute(self, statement: Any, *args: Any, **kwargs: Any) -> Any:
        return self._sync.execute(statement, *args, **kwargs)

    async def scalar(self, statement: Any, *args: Any, **kwargs: Any) -> Any:
        return self._sync.scalar(statement, *args, **kwargs)

    async def scalars(self, statement: Any, *args: Any, **kwargs: Any) -> Any:
        return self._sync.scalars(statement, *args, **kwargs)

    async def flush(self) -> None:
        self._sync.flush()

    async def commit(self) -> None:
        self._sync.commit()

    async def rollback(self) -> None:
        self._sync.rollback()

    @asynccontextmanager
    async def begin_nested(self):
        nested = self._sync.begin_nested()
        try:
            yield nested
            nested.commit()
        except Exception:
            nested.rollback()
            raise


def _build_sqlite_engine():
    engine = create_engine(
        "sqlite://",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )

    @event.listens_for(engine, "connect")
    def _register_pg_functions(dbapi_conn: Any, _record: Any) -> None:
        dbapi_conn.create_function("gen_random_uuid", 0, lambda: str(uuid4()))

    # Strip Postgres-only `::jsonb` / `interval` server_defaults before DDL on SQLite
    saved_defaults: list[tuple[Any, Any]] = []
    try:
        for table in _REQUIRED_TABLES:
            for col in table.columns:
                if col.server_default is not None:
                    arg_text = str(getattr(col.server_default, "arg", ""))
                    if "::" in arg_text or "interval" in arg_text or "gen_random_uuid" in arg_text:
                        saved_defaults.append((col, col.server_default))
                        col.server_default = None
        Base.metadata.create_all(engine, tables=list(_REQUIRED_TABLES))
    finally:
        for col, default in saved_defaults:
            col.server_default = default

    return engine


class Feat8OfflineReadingPackTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self) -> None:
        self.engine = _build_sqlite_engine()
        self.SessionFactory = sessionmaker(bind=self.engine, expire_on_commit=False)
        self.sync_db = self.SessionFactory()
        self.async_db = _AsyncSqliteSessionAdapter(self.sync_db)

        now = datetime.now(timezone.utc)
        self.parent_a = uuid4()
        self.parent_b = uuid4()
        self.staff_user = uuid4()
        self.child_a = uuid4()
        self.child_b = uuid4()

        self.sync_db.add_all(
            [
                Profile(
                    Id=self.parent_a,
                    Role="parent",
                    DisplayName="Mẹ Bé An",
                    Active=1,
                    CreatedAt=now,
                ),
                Profile(
                    Id=self.parent_b,
                    Role="parent",
                    DisplayName="Bố Bé Bình",
                    Active=1,
                    CreatedAt=now,
                ),
                Profile(
                    Id=self.staff_user,
                    Role="admin",
                    DisplayName="Admin",
                    Active=1,
                    CreatedAt=now,
                ),
                ChildProfile(
                    Id=self.child_a,
                    ParentId=self.parent_a,
                    Alias="Bé An",
                    Grade=2,
                    Settings={
                        "voice_preferences": {
                            "voice_id": "local_north_truc_ly",
                            "gender": "female",
                            "region": "north",
                            "speed": 1.0,
                        }
                    },
                    CreatedAt=now,
                ),
                ChildProfile(
                    Id=self.child_b,
                    ParentId=self.parent_b,
                    Alias="Bé Bình",
                    Grade=1,
                    Settings={},
                    CreatedAt=now,
                ),
            ]
        )

        # 1. Active verified CATALOG book
        self.catalog_book_id = uuid4()
        self.catalog_page_id = uuid4()
        self.catalog_rev_v1 = uuid4()
        self.catalog_word_1 = uuid4()
        self.catalog_word_2 = uuid4()
        self.catalog_text = "Con thuyền nhỏ"

        self.sync_db.add(
            Book(
                Id=self.catalog_book_id,
                Title="Truyện Con Thuyền Nhỏ",
                Author="Nguyễn Văn A",
                MinGrade=1,
                MaxGrade=3,
                LifecycleStatus="ACTIVE",
                VisibilityScope="CATALOG",
                ModerationStatus="ACTIVE",
                IsDeleted=False,
                CreatedAt=now,
            )
        )
        self.sync_db.add(
            BookPage(
                Id=self.catalog_page_id,
                BookId=self.catalog_book_id,
                PageNumber=1,
                ImagePath="catalog/books/thuyen-p1.webp",
                Width=800,
                Height=1000,
                ContentType="CONTENT",
                ProcessingMeta={},
                CurrentVerifiedRevisionId=self.catalog_rev_v1,
                LifecycleStatus="ACTIVE",
                CreatedAt=now,
            )
        )
        self.sync_db.add(
            PageRevision(
                Id=self.catalog_rev_v1,
                PageId=self.catalog_page_id,
                RevisionNo="1",
                VerificationStatus="VERIFIED",
                VerifiedText=self.catalog_text,
                ContentHash="hash-cat-v1",
                ProcessingMeta={},
                CreatedAt=now,
            )
        )
        self.sync_db.add_all(
            [
                PageRevisionWord(
                    Id=self.catalog_word_1,
                    PageRevisionId=self.catalog_rev_v1,
                    WordIndex=0,
                    LineIndex=0,
                    Text="Con",
                    NormalizedText="con",
                    BoundingBox=[0.1, 0.2, 0.15, 0.06],
                ),
                PageRevisionWord(
                    Id=self.catalog_word_2,
                    PageRevisionId=self.catalog_rev_v1,
                    WordIndex=1,
                    LineIndex=0,
                    Text="thuyền",
                    NormalizedText="thuyền",
                    BoundingBox=[0.28, 0.2, 0.22, 0.06],
                ),
                PageRevisionWord(
                    Id=uuid4(),
                    PageRevisionId=self.catalog_rev_v1,
                    WordIndex=2,
                    LineIndex=0,
                    Text="nhỏ",
                    NormalizedText="nhỏ",
                    BoundingBox=[0.52, 0.2, 0.14, 0.06],
                ),
            ]
        )

        # Pre-cached CATALOG TTS entry
        cat_norm = canonical_tts_text(self.catalog_text)
        self.sync_db.add(
            TtsAudioCacheEntry(
                Id=uuid4(),
                Scope="CATALOG",
                OwnerParentId=None,
                BookId=self.catalog_book_id,
                PageId=self.catalog_page_id,
                PageRevisionId=self.catalog_rev_v1,
                ContentSha256=canonical_tts_sha256(cat_norm),
                NormalizedText=cat_norm,
                VoiceId="local_north_truc_ly",
                ModelVersion="vieneu-v3",
                Speed=1.0,
                AudioFormat="audio/mpeg",
                StorageBucket="viread-tts-cache",
                StoragePath="catalog/thuyen/clip.mp3",
                ByteSize=24_576,
                DurationSeconds=2.1,
                WordTimingsJson=[
                    {"index": 0, "start": 0.0, "end": 0.55},
                    {"index": 1, "start": 0.56, "end": 1.35},
                    {"index": 2, "start": 1.36, "end": 2.05},
                ],
                Status="ACTIVE",
                LastAccessedAt=now,
                HitCount=3,
                CreatedAt=now,
                UpdatedAt=now,
            )
        )

        # 2. PARENT_PRIVATE book owned by parent_a
        self.private_book_id = uuid4()
        self.private_page_id = uuid4()
        self.private_rev_v1 = uuid4()
        self.private_word_1 = uuid4()
        self.private_text = "Bông sen hồng"

        self.sync_db.add(
            Book(
                Id=self.private_book_id,
                Title="Sách Gia Đình Của An",
                Author="Mẹ An",
                MinGrade=1,
                MaxGrade=2,
                LifecycleStatus="ACTIVE",
                VisibilityScope="PARENT_PRIVATE",
                OwnerParentId=self.parent_a,
                ModerationStatus="ACTIVE",
                IsDeleted=False,
                CreatedAt=now,
            )
        )
        self.sync_db.add(
            BookPage(
                Id=self.private_page_id,
                BookId=self.private_book_id,
                PageNumber=1,
                ImagePath=f"private-books/{self.parent_a}/{self.private_book_id}/p1.webp",
                Width=900,
                Height=1200,
                ContentType="CONTENT",
                ProcessingMeta={},
                CurrentVerifiedRevisionId=self.private_rev_v1,
                LifecycleStatus="ACTIVE",
                CreatedAt=now,
            )
        )
        self.sync_db.add(
            PageRevision(
                Id=self.private_rev_v1,
                PageId=self.private_page_id,
                RevisionNo="1",
                VerificationStatus="VERIFIED",
                VerifiedText=self.private_text,
                ContentHash="hash-priv-v1",
                ProcessingMeta={},
                CreatedAt=now,
            )
        )
        self.sync_db.add_all(
            [
                PageRevisionWord(
                    Id=self.private_word_1,
                    PageRevisionId=self.private_rev_v1,
                    WordIndex=0,
                    LineIndex=0,
                    Text="Bông",
                    NormalizedText="bông",
                    BoundingBox=[0.12, 0.18, 0.16, 0.06],
                ),
                PageRevisionWord(
                    Id=uuid4(),
                    PageRevisionId=self.private_rev_v1,
                    WordIndex=1,
                    LineIndex=0,
                    Text="sen",
                    NormalizedText="sen",
                    BoundingBox=[0.30, 0.18, 0.12, 0.06],
                ),
                PageRevisionWord(
                    Id=uuid4(),
                    PageRevisionId=self.private_rev_v1,
                    WordIndex=2,
                    LineIndex=0,
                    Text="hồng",
                    NormalizedText="hồng",
                    BoundingBox=[0.44, 0.18, 0.16, 0.06],
                ),
            ]
        )

        priv_norm = canonical_tts_text(self.private_text)
        self.sync_db.add(
            TtsAudioCacheEntry(
                Id=uuid4(),
                Scope="PRIVATE",
                OwnerParentId=self.parent_a,
                BookId=self.private_book_id,
                PageId=self.private_page_id,
                PageRevisionId=self.private_rev_v1,
                ContentSha256=canonical_tts_sha256(priv_norm),
                NormalizedText=priv_norm,
                VoiceId="local_north_truc_ly",
                ModelVersion="vieneu-v3",
                Speed=1.0,
                AudioFormat="audio/mpeg",
                StorageBucket="viread-test-private",
                StoragePath=f"private-books/{self.parent_a}/{self.private_book_id}/tts-cache/clip.mp3",
                ByteSize=18_432,
                DurationSeconds=1.6,
                WordTimingsJson=None,
                Status="ACTIVE",
                LastAccessedAt=now,
                HitCount=1,
                CreatedAt=now,
                UpdatedAt=now,
            )
        )
        self.sync_db.commit()

        self.current_actor: UUID = self.parent_a
        self.app = FastAPI()
        self.app.include_router(api_router)
        self.app.dependency_overrides[get_current_parent_id] = lambda: self.current_actor

        async def _override_get_db():
            yield self.async_db

        self.app.dependency_overrides[get_db] = _override_get_db
        self.client = TestClient(self.app)

    def tearDown(self) -> None:
        self.sync_db.close()
        self.engine.dispose()

    def test_sql_migration_defines_rls_and_unique_ledger(self) -> None:
        migration_path = (
            _REPO_ROOT
            / "supabase"
            / "migrations"
            / "20261128151000_feat8_offline_sync_events.sql"
        )
        self.assertTrue(migration_path.is_file(), "Feat 8 SQL migration must exist")
        sql = migration_path.read_text(encoding="utf-8").lower()
        self.assertIn("create table if not exists public.offline_sync_events", sql)
        self.assertIn("unique (parent_id, client_event_id)", sql)
        self.assertIn("alter table public.offline_sync_events enable row level security", sql)
        self.assertIn("parent_id = (select auth.uid())", sql)
        self.assertIn("revoke all privileges on table public.offline_sync_events from anon", sql)

    def test_pack_manifest_catalog_and_parent_private_with_bounded_tts(self) -> None:
        with (
            patch(
                "app.services.offline_reading_pack_service.CatalogRepository.is_eligible",
                return_value=True,
            ),
            patch(
                "app.services.offline_reading_pack_service.create_cached_signed_image_urls",
                return_value=["https://cdn.example.test/signed/thuyen-p1.webp"],
            ),
        ):
            res_cat = self.client.get(
                f"/offline/children/{self.child_a}/books/{self.catalog_book_id}/pack-manifest"
            )
            self.assertEqual(res_cat.status_code, 200, res_cat.text)
            self.assertEqual(res_cat.headers.get("cache-control"), "private, no-store")
            body_cat = res_cat.json()
            self.assertEqual(body_cat["book_id"], str(self.catalog_book_id))
            self.assertEqual(body_cat["parent_account_id"], str(self.parent_a))
            self.assertEqual(body_cat["child_profile_id"], str(self.child_a))
            self.assertEqual(body_cat["visibility_scope"], "CATALOG")
            self.assertEqual(body_cat["grade"], 2)
            self.assertEqual(len(body_cat["pages"]), 1)
            page_cat = body_cat["pages"][0]
            self.assertEqual(page_cat["page_id"], str(self.catalog_page_id))
            self.assertEqual(page_cat["page_revision_id"], str(self.catalog_rev_v1))
            self.assertEqual(page_cat["verified_text"], self.catalog_text)
            self.assertEqual(len(page_cat["words"]), 3)
            self.assertIn("thuyền", page_cat["phonics_keyterms"])
            self.assertEqual(
                page_cat["image_url"],
                "https://cdn.example.test/signed/thuyen-p1.webp",
            )
            self.assertTrue(page_cat["tts_audio"]["cached"])
            self.assertEqual(page_cat["tts_audio"]["cache_scope"], "CATALOG")
            self.assertEqual(page_cat["tts_audio"]["byte_size"], 24_576)
            self.assertEqual(len(page_cat["tts_audio"]["word_timings"]), 3)

            # Bounded TTS size enforcement: shrink max_tts_bytes below clip size (65536 vs 90000)
            self.sync_db.query(TtsAudioCacheEntry).filter(
                TtsAudioCacheEntry.BookId == self.catalog_book_id
            ).update({"ByteSize": 90_000})
            self.sync_db.commit()
            res_bounded = self.client.get(
                f"/offline/children/{self.child_a}/books/{self.catalog_book_id}/pack-manifest?max_tts_bytes=65536"
            )
            self.assertEqual(res_bounded.status_code, 200)
            self.assertFalse(res_bounded.json()["pages"][0]["tts_audio"]["cached"])

        # PARENT_PRIVATE book manifest for owning parent_a (with inline TTS clip)
        fake_mp3 = b"ID3\x04\x00\x00\x00\x00\x00\x00private-audio-bytes"
        fake_hit = CachedTtsHit(
            content=fake_mp3,
            content_type="audio/mpeg",
            resolved_voice_id="local_north_truc_ly",
            model_version="vieneu-v3",
            duration_seconds=1.6,
            word_timings_json=None,
            scope="PRIVATE",
            storage_bucket="viread-test-private",
            storage_path=f"private-books/{self.parent_a}/{self.private_book_id}/tts-cache/clip.mp3",
        )
        with patch(
            "app.services.tts_audio_cache_service.TtsAudioCacheService.lookup_cached_audio",
            return_value=fake_hit,
        ):
            res_priv = self.client.get(
                f"/offline/children/{self.child_a}/books/{self.private_book_id}/pack-manifest?include_inline_tts=true"
            )
            self.assertEqual(res_priv.status_code, 200, res_priv.text)
            self.assertEqual(res_priv.headers.get("cache-control"), "private, no-store")
            body_priv = res_priv.json()
            self.assertEqual(body_priv["visibility_scope"], "PARENT_PRIVATE")
            priv_page = body_priv["pages"][0]
            self.assertIn(f"/books/my-books/{self.private_book_id}/pages/", priv_page["image_url"])
            self.assertNotIn("/storage/v1/object/public/", priv_page["image_url"])
            self.assertTrue(priv_page["tts_audio"]["cached"])
            self.assertEqual(priv_page["tts_audio"]["cache_scope"], "PRIVATE")
            self.assertNotIn(
                "/storage/v1/object/public/",
                priv_page["tts_audio"]["audio_url"] or "",
            )
            self.assertIsNotNone(priv_page["tts_audio"]["inline_audio_base64"])

            # Owner can fetch private TTS audio endpoint with private, no-store
            res_audio = self.client.get(
                f"/offline/children/{self.child_a}/books/{self.private_book_id}/pages/{self.private_page_id}/tts-audio"
            )
            self.assertEqual(res_audio.status_code, 200)
            self.assertEqual(res_audio.headers.get("cache-control"), "private, no-store")
            self.assertEqual(res_audio.content, fake_mp3)

    def test_cross_parent_and_non_parent_access_blocked_403_404(self) -> None:
        # 1. Parent B tries to read manifest for Parent A's child -> 404
        self.current_actor = self.parent_b
        res_other_child = self.client.get(
            f"/offline/children/{self.child_a}/books/{self.catalog_book_id}/pack-manifest"
        )
        self.assertIn(res_other_child.status_code, (403, 404))

        # 2. Parent B (using own child_b) tries to read Parent A's PARENT_PRIVATE book -> 404
        res_other_priv_book = self.client.get(
            f"/offline/children/{self.child_b}/books/{self.private_book_id}/pack-manifest"
        )
        self.assertIn(res_other_priv_book.status_code, (403, 404))

        # 3. Non-parent role -> 403
        self.current_actor = self.staff_user
        res_non_parent = self.client.get(
            f"/offline/children/{self.child_a}/books/{self.catalog_book_id}/pack-manifest"
        )
        self.assertEqual(res_non_parent.status_code, 403)

        # 4. Parent B tries to sync outbox for Parent A's child -> 404
        self.current_actor = self.parent_b
        res_sync_other_child = self.client.post(
            f"/offline/children/{self.child_a}/sync-outbox",
            json={
                "events": [
                    {
                        "client_event_id": str(uuid4()),
                        "client_session_id": str(uuid4()),
                        "book_id": str(self.catalog_book_id),
                        "page_id": str(self.catalog_page_id),
                        "page_revision_id": str(self.catalog_rev_v1),
                        "event_kind": "WORD_ATTEMPT",
                    }
                ]
            },
        )
        self.assertIn(res_sync_other_child.status_code, (403, 404))

        # 5. Parent B (using own child_b) tries to sync outbox referencing Parent A's private book -> 404
        res_sync_other_priv = self.client.post(
            f"/offline/children/{self.child_b}/sync-outbox",
            json={
                "events": [
                    {
                        "client_event_id": str(uuid4()),
                        "client_session_id": str(uuid4()),
                        "book_id": str(self.private_book_id),
                        "page_id": str(self.private_page_id),
                        "page_revision_id": str(self.private_rev_v1),
                        "event_kind": "WORD_ATTEMPT",
                    }
                ]
            },
        )
        self.assertIn(res_sync_other_priv.status_code, (403, 404))

    def test_sync_outbox_idempotent_replay_creates_zero_duplicates(self) -> None:
        self.current_actor = self.parent_a
        client_session_id = uuid4()
        ev_word = uuid4()
        ev_page = uuid4()
        ev_finish = uuid4()

        batch_payload = {
            "events": [
                {
                    "client_event_id": str(ev_word),
                    "client_session_id": str(client_session_id),
                    "book_id": str(self.catalog_book_id),
                    "page_id": str(self.catalog_page_id),
                    "page_revision_id": str(self.catalog_rev_v1),
                    "event_kind": "WORD_ATTEMPT",
                    "word_id": str(self.catalog_word_2),
                    "word_text": "thuyền",
                    "transcript": "thuyền",
                    "is_correct": True,
                    "start_ms": 120,
                    "end_ms": 680,
                    "confidence": 0.94,
                    "metadata": {"retry_attempt": 1},
                },
                # Intentional duplicate inside the very same HTTP batch
                {
                    "client_event_id": str(ev_word),
                    "client_session_id": str(client_session_id),
                    "book_id": str(self.catalog_book_id),
                    "page_id": str(self.catalog_page_id),
                    "page_revision_id": str(self.catalog_rev_v1),
                    "event_kind": "WORD_ATTEMPT",
                    "word_id": str(self.catalog_word_2),
                    "word_text": "thuyền",
                    "transcript": "thuyền",
                    "is_correct": True,
                    "start_ms": 120,
                    "end_ms": 680,
                },
                {
                    "client_event_id": str(ev_page),
                    "client_session_id": str(client_session_id),
                    "book_id": str(self.catalog_book_id),
                    "page_id": str(self.catalog_page_id),
                    "page_revision_id": str(self.catalog_rev_v1),
                    "event_kind": "PAGE_READ",
                    "transcript": "con thuyền nhỏ",
                    "is_correct": True,
                    "score": 92.5,
                    "duration_ms": 4200,
                },
                {
                    "client_event_id": str(ev_finish),
                    "client_session_id": str(client_session_id),
                    "book_id": str(self.catalog_book_id),
                    "page_id": str(self.catalog_page_id),
                    "page_revision_id": str(self.catalog_rev_v1),
                    "event_kind": "SESSION_FINISH",
                    "duration_ms": 5000,
                },
            ]
        }

        first_res = self.client.post(
            f"/offline/children/{self.child_a}/sync-outbox",
            headers={"Idempotency-Key": "batch-offline-001"},
            json=batch_payload,
        )
        self.assertEqual(first_res.status_code, 200, first_res.text)
        self.assertEqual(first_res.headers.get("cache-control"), "private, no-store")
        first_body = first_res.json()
        self.assertEqual(first_body["batch_idempotency_key"], "batch-offline-001")
        self.assertEqual(first_body["total_received"], 4)
        self.assertEqual(first_body["applied_count"], 3)
        self.assertEqual(first_body["deduplicated_count"], 1)
        self.assertEqual(first_body["reconciled_stale_count"], 0)
        self.assertEqual(len(first_body["session_ids"]), 1)
        server_session_id = UUID(first_body["session_ids"][0])

        sessions_after_first = self.sync_db.scalars(
            select(ReadingSession).where(ReadingSession.ChildId == self.child_a)
        ).all()
        events_after_first = self.sync_db.scalars(
            select(ReadingEvent).where(ReadingEvent.SessionId == server_session_id)
        ).all()
        fluency_after_first = self.sync_db.scalars(
            select(FluencyAssessment).where(
                FluencyAssessment.SessionId == server_session_id
            )
        ).all()
        self.assertEqual(len(sessions_after_first), 1)
        self.assertEqual(sessions_after_first[0].State, "COMPLETED")
        self.assertEqual(len(events_after_first), 2)
        self.assertEqual(len(fluency_after_first), 1)
        self.assertAlmostEqual(fluency_after_first[0].Score or 0.0, 92.5)

        # Replay identical batch over flaky network -> 0 new DB writes!
        replay_res = self.client.post(
            f"/offline/children/{self.child_a}/sync-outbox",
            headers={"Idempotency-Key": "batch-offline-001"},
            json=batch_payload,
        )
        self.assertEqual(replay_res.status_code, 200, replay_res.text)
        replay_body = replay_res.json()
        self.assertEqual(replay_body["applied_count"], 0)
        self.assertEqual(replay_body["deduplicated_count"], 4)
        self.assertEqual(replay_body["session_ids"], [str(server_session_id)])
        self.assertTrue(all(r["deduplicated"] and not r["applied"] for r in replay_body["results"]))

        self.assertEqual(
            len(
                self.sync_db.scalars(
                    select(ReadingSession).where(ReadingSession.ChildId == self.child_a)
                ).all()
            ),
            1,
        )
        self.assertEqual(
            len(
                self.sync_db.scalars(
                    select(ReadingEvent).where(ReadingEvent.SessionId == server_session_id)
                ).all()
            ),
            2,
        )
        self.assertEqual(
            len(
                self.sync_db.scalars(
                    select(FluencyAssessment).where(
                        FluencyAssessment.SessionId == server_session_id
                    )
                ).all()
            ),
            1,
        )

    def test_sync_outbox_reconciles_stale_page_revision_without_dropping_progress(self) -> None:
        self.current_actor = self.parent_a
        now = datetime.now(timezone.utc)

        # Simulate Admin publishing a new verified revision v2 while child read v1 offline
        rev_v2 = uuid4()
        word_v2_thuyen = uuid4()
        self.sync_db.add(
            PageRevision(
                Id=rev_v2,
                PageId=self.catalog_page_id,
                RevisionNo="2",
                VerificationStatus="VERIFIED",
                VerifiedText="Con thuyền nhỏ xinh",
                ContentHash="hash-cat-v2",
                ProcessingMeta={},
                CreatedAt=now,
            )
        )
        self.sync_db.add(
            PageRevisionWord(
                Id=word_v2_thuyen,
                PageRevisionId=rev_v2,
                WordIndex=1,
                LineIndex=0,
                Text="thuyền",
                NormalizedText="thuyền",
                BoundingBox=[0.28, 0.2, 0.22, 0.06],
            )
        )
        page_row = self.sync_db.get(BookPage, self.catalog_page_id)
        assert page_row is not None
        page_row.CurrentVerifiedRevisionId = rev_v2
        self.sync_db.commit()

        stale_event_id = uuid4()
        retired_rev_event_id = uuid4()
        unknown_retired_rev_id = uuid4()
        offline_session_id = uuid4()

        res = self.client.post(
            f"/offline/children/{self.child_a}/sync-outbox",
            json={
                "events": [
                    {
                        "client_event_id": str(stale_event_id),
                        "client_session_id": str(offline_session_id),
                        "book_id": str(self.catalog_book_id),
                        "page_id": str(self.catalog_page_id),
                        "page_revision_id": str(self.catalog_rev_v1),  # Stale v1!
                        "event_kind": "WORD_ATTEMPT",
                        "word_id": str(self.catalog_word_2),  # v1 word_id
                        "word_text": "thuyền",
                        "transcript": "thuyền",
                        "is_correct": True,
                    },
                    {
                        "client_event_id": str(retired_rev_event_id),
                        "client_session_id": str(offline_session_id),
                        "book_id": str(self.catalog_book_id),
                        "page_id": str(self.catalog_page_id),
                        "page_revision_id": str(unknown_retired_rev_id),  # Purged revision!
                        "event_kind": "SESSION_FINISH",
                        "score": 88.0,
                        "duration_ms": 3800,
                    },
                ]
            },
        )
        self.assertEqual(res.status_code, 200, res.text)
        body = res.json()
        self.assertEqual(body["applied_count"], 2)
        self.assertEqual(body["reconciled_stale_count"], 2)

        first_res_item = body["results"][0]
        self.assertTrue(first_res_item["stale_revision_reconciled"])
        self.assertEqual(first_res_item["original_page_revision_id"], str(self.catalog_rev_v1))
        self.assertEqual(first_res_item["effective_page_revision_id"], str(rev_v2))

        saved_event = self.sync_db.get(
            ReadingEvent, UUID(first_res_item["reading_event_id"])
        )
        self.assertIsNotNone(saved_event)
        assert saved_event is not None
        self.assertEqual(saved_event.PageRevisionId, rev_v2)
        self.assertEqual(saved_event.WordId, word_v2_thuyen)
        self.assertTrue(saved_event.Metadata.get("stale_revision_reconciled"))
        self.assertEqual(
            saved_event.Metadata.get("original_page_revision_id"),
            str(self.catalog_rev_v1),
        )


if __name__ == "__main__":
    unittest.main()
