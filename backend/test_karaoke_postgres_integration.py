"""Real migration/ORM/locks tests in an explicitly disposable loopback database.

Run with KARAOKE_TEST_DATABASE_URL pointing to the dedicated Phase 2 container.
Supabase Storage network calls are test doubles; RLS policies run in PostgreSQL.
No application DATABASE_URL is used to select this integration database.
"""
import asyncio
import hashlib
import os
from pathlib import Path
import unittest
from unittest.mock import patch
from uuid import uuid4

import asyncpg
from fastapi import HTTPException
from sqlalchemy import select
from sqlalchemy.engine import make_url
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine
from sqlalchemy.pool import NullPool

from app.models.karaoke import KaraokeSong, KaraokeSongVersion
from app.models.profile import ChildProfile, Profile
from app.repositories.karaoke_repository import KaraokeRepository
from app.schemas.karaoke import DraftWrite, RevisionRequest, SongCreate, VisibilityRequest
from app.services.karaoke_service import KaraokeService
from test_karaoke import lyrics, mp3_fixture

TEST_URL = os.getenv("KARAOKE_TEST_DATABASE_URL")
MIGRATION = Path(__file__).resolve().parents[1] / "supabase/migrations/20261114130000_add_karaoke.sql"
_prepared = False


def test_url():
    url = make_url(TEST_URL)
    if (url.host != "127.0.0.1" or url.port != 55447 or url.username != "karaoke_test"
            or url.database != "karaoke_phase2_test"):
        raise RuntimeError("Refusing any database except the dedicated karaoke loopback test database")
    return url


async def connect():
    url = test_url()
    return await asyncpg.connect(host=url.host, port=url.port, user=url.username,
                                 password=url.password, database=url.database, timeout=10)


async def prepare_database():
    global _prepared
    if _prepared:
        return
    connection = await connect()
    try:
        sql = MIGRATION.read_text(encoding="utf-8")
        fingerprint = hashlib.sha256(sql.encode()).hexdigest()
        if await connection.fetchval("SELECT to_regclass('public.karaoke_phase2_test_marker')"):
            previous = await connection.fetchval("SELECT fingerprint FROM public.karaoke_phase2_test_marker")
            if previous != fingerprint:
                raise RuntimeError("Migration changed; create a new disposable test container")
        else:
            # Refuse an existing application's schema even if its URL was misnamed.
            occupied = await connection.fetchval("SELECT count(*) FROM information_schema.tables WHERE table_schema='public'")
            if occupied:
                raise RuntimeError("Refusing a non-empty database without our disposable-test marker")
            await connection.execute("""
                DO $$ BEGIN
                    CREATE ROLE anon NOLOGIN;
                    CREATE ROLE authenticated NOLOGIN;
                    CREATE ROLE service_role NOLOGIN;
                END $$;
                CREATE TABLE public.profiles (
                    id uuid PRIMARY KEY, role text NOT NULL, displayname text,
                    contact_phone text, avatar_path text, active smallint NOT NULL DEFAULT 1,
                    createdat timestamptz NOT NULL DEFAULT now()
                );
                CREATE TABLE public.childprofiles (
                    id uuid PRIMARY KEY, parentid uuid NOT NULL REFERENCES profiles(id),
                    alias text NOT NULL, grade smallint NOT NULL, settings jsonb NOT NULL DEFAULT '{}',
                    avatar_path text, createdat timestamptz NOT NULL DEFAULT now()
                );
                CREATE SCHEMA storage;
                CREATE TABLE storage.buckets (
                    id text PRIMARY KEY, name text, public boolean, file_size_limit bigint,
                    allowed_mime_types text[]
                );
                CREATE TABLE storage.objects (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), bucket_id text);
                ALTER TABLE storage.objects ENABLE ROW LEVEL SECURITY;
                GRANT USAGE ON SCHEMA storage TO anon, authenticated, service_role;
                GRANT ALL ON storage.objects TO anon, authenticated, service_role;
                CREATE POLICY fixture_legacy_broad_access ON storage.objects
                    FOR ALL TO authenticated USING (true) WITH CHECK (true);
            """)
            await connection.execute(sql)
            await connection.execute("CREATE TABLE public.karaoke_phase2_test_marker (fingerprint text NOT NULL)")
            await connection.execute("INSERT INTO public.karaoke_phase2_test_marker VALUES ($1)", fingerprint)
        _prepared = True
    finally:
        await connection.close()


class TestStorage:
    def __init__(self, session):
        self.session, self.objects = session, {}

    def verify(self, path, song_id, expected_size=None):
        assert not self.session.in_transaction(), "Media operations must release DB transaction"
        if path not in self.objects:
            raise HTTPException(503, "Isolated missing media")
        if expected_size is not None:
            assert len(self.objects[path]) == expected_size

    def upload(self, path, song_id, data, content_type):
        assert not self.session.in_transaction()
        self.objects[path] = data

    def sign(self, path, song_id):
        self.verify(path, song_id)
        return f"https://example.supabase.co/storage/v1/object/sign/viread-karaoke/{path}?token=test"

    def remove(self, path, song_id):
        assert not self.session.in_transaction()
        self.objects.pop(path, None)


@unittest.skipUnless(TEST_URL, "Set KARAOKE_TEST_DATABASE_URL to the dedicated disposable loopback database")
class KaraokePostgresTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        test_url()
        await prepare_database()
        self.engine = create_async_engine(TEST_URL, poolclass=NullPool)
        self.addAsyncCleanup(self.engine.dispose)
        self.sessions = async_sessionmaker(self.engine, expire_on_commit=False)
        self.db = self.sessions()
        self.addAsyncCleanup(self.db.close)
        self.admin, self.parent, self.child = uuid4(), uuid4(), uuid4()
        self.title = "Integration " + uuid4().hex
        self.db.add_all([Profile(Id=self.admin, Role="admin", Active=1),
                         Profile(Id=self.parent, Role="parent", Active=1)])
        await self.db.flush()
        self.db.add(ChildProfile(Id=self.child, ParentId=self.parent, Alias="Test only", Grade=2))
        await self.db.commit()
        self.repository = KaraokeRepository(self.db)
        self.storage = TestStorage(self.db)
        self.service = KaraokeService(self.repository, self.storage)
        self.detail = await self.service.create(self.admin, SongCreate(title=self.title))
        self.song_id = self.detail.song_id

    async def ready(self, detail=None):
        from fastapi import UploadFile
        from io import BytesIO
        from app.schemas.karaoke import DraftRequest
        detail = detail or self.detail
        uploaded = await self.service.upload(self.admin, self.song_id, DraftRequest(
            expected_revision=detail.revision, draft_version_id=detail.draft.id,
        ), UploadFile(file=BytesIO(mp3_fixture()), filename="synthetic.mp3"))
        return await self.service.save(self.admin, self.song_id, DraftWrite(
            expected_revision=uploaded.revision, draft_version_id=uploaded.draft.id,
            title=self.title, source_note="Synthetic parser fixture", usage_note="Tests only",
            min_grade=1, max_grade=3, lyrics=lyrics(),
        ))

    async def publish(self, ready):
        from app.schemas.karaoke import DraftRequest
        return await self.service.publish(self.admin, self.song_id, DraftRequest(
            expected_revision=ready.revision, draft_version_id=ready.draft.id,
        ))

    async def test_migration_schema_private_bucket_and_rls_against_legacy_policy(self):
        connection = await connect()
        try:
            for model in (KaraokeSong, KaraokeSongVersion):
                columns = await connection.fetch("SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name=$1", model.__tablename__)
                self.assertEqual({r["column_name"] for r in columns}, {c.name for c in model.__table__.columns})
                enabled = await connection.fetchval("SELECT relrowsecurity FROM pg_class WHERE oid=$1::regclass", "public." + model.__tablename__)
                self.assertTrue(enabled)
                self.assertFalse(await connection.fetchval("SELECT has_table_privilege('authenticated', $1, 'SELECT')", "public." + model.__tablename__))
            bucket = await connection.fetchrow("SELECT * FROM storage.buckets WHERE id='viread-karaoke'")
            self.assertFalse(bucket["public"])
            self.assertEqual(bucket["file_size_limit"], 20 * 1024 * 1024)
            object_id, other_id = uuid4(), uuid4()
            await connection.execute("INSERT INTO storage.objects(id,bucket_id) VALUES ($1,'viread-karaoke'),($2,'unrelated-test-bucket')", object_id, other_id)
            async with connection.transaction():
                await connection.execute("SET LOCAL ROLE authenticated")
                self.assertIsNone(await connection.fetchval("SELECT id FROM storage.objects WHERE id=$1", object_id))
                self.assertEqual(await connection.fetchval("SELECT id FROM storage.objects WHERE id=$1", other_id), other_id)
            async with connection.transaction():
                await connection.execute("SET LOCAL ROLE service_role")
                self.assertEqual(await connection.fetchval("SELECT id FROM storage.objects WHERE id=$1", object_id), object_id)
            for role in ("anon", "authenticated"):
                with self.assertRaises(asyncpg.InsufficientPrivilegeError):
                    async with connection.transaction():
                        await connection.execute(f"SET LOCAL ROLE {role}")
                        await connection.fetch("SELECT * FROM public.karaoke_songs")
        finally:
            await connection.close()

    async def test_real_publication_replacement_and_catalog(self):
        from app.schemas.karaoke import DraftRequest
        ready = await self.ready()
        self.assertTrue((await self.service.validation(self.admin, self.song_id)).valid)
        published = await self.publish(ready)
        admin_list = await self.service.admin_list(self.admin, search=self.title)
        self.assertEqual(admin_list.total, 1)
        self.assertNotIn("lyrics", admin_list.items[0].model_dump())
        first = await self.service.playback(self.parent, self.song_id, self.child)
        catalog = await self.service.catalog(self.parent, self.child, search=self.title)
        self.assertEqual(catalog.total, 1)
        self.assertEqual(catalog.items[0].version_id, first.version_id)
        draft = await self.service.draft(self.admin, self.song_id, RevisionRequest(expected_revision=published.revision))
        self.assertEqual(draft.draft.version_no, 2)
        self.assertEqual((await self.service.playback(self.parent, self.song_id, self.child)).version_id, first.version_id)
        replacement = await self.ready(draft)
        second = await self.publish(replacement)
        self.assertNotEqual(second.published.id, first.version_id)
        with self.assertRaises(HTTPException) as caught:
            await self.service.playback(self.parent, self.song_id, self.child, first.version_id)
        self.assertEqual(caught.exception.status_code, 409)
        async with self.repository.read():
            old = await self.db.scalar(select(KaraokeSongVersion).where(KaraokeSongVersion.id == first.version_id))
            self.assertEqual(old.state, "SUPERSEDED")
            self.assertIn(old.audio_path, self.storage.objects)
        await self.service.visibility(self.admin, self.song_id, VisibilityRequest(expected_revision=second.revision, visible=False))
        self.assertEqual((await self.service.catalog(self.parent, self.child, search=self.title)).total, 0)

    async def test_two_connections_only_one_stale_revision_writer_succeeds(self):
        async def write(title):
            async with self.sessions() as db:
                service = KaraokeService(KaraokeRepository(db), self.storage)
                return await service.save(self.admin, self.song_id, DraftWrite(
                    expected_revision=1, draft_version_id=self.detail.draft.id, title=title,
                ))
        outcomes = await asyncio.gather(write("Writer A"), write("Writer B"), return_exceptions=True)
        self.assertEqual(sum(not isinstance(result, BaseException) for result in outcomes), 1)
        failure = next(result for result in outcomes if isinstance(result, BaseException))
        self.assertIsInstance(failure, HTTPException)
        self.assertEqual(failure.status_code, 409)
        result = await self.service.detail(self.admin, self.song_id)
        self.assertEqual(result.revision, 2)
        self.assertIn(result.draft.title, {"Writer A", "Writer B"})

    async def test_publish_database_failure_rolls_back_every_business_change(self):
        ready = await self.ready()
        original = self.repository.bump
        async def fail_after_flush(*args):
            await original(*args)
            raise SQLAlchemyError("isolated post-update failure")
        with patch.object(self.repository, "bump", side_effect=fail_after_flush):
            with self.assertRaises(SQLAlchemyError):
                await self.publish(ready)
        restored = await self.service.detail(self.admin, self.song_id)
        self.assertEqual(restored.status, "DRAFT")
        self.assertEqual(restored.revision, ready.revision)
        self.assertIsNone(restored.published)
        self.assertEqual(restored.draft.state, "DRAFT")
        self.assertIsNone(restored.draft.published_at)

    async def test_database_rejects_duplicate_draft_and_cross_song_published_pointer(self):
        other = await self.service.create(self.admin, SongCreate(title="Other fixture"))
        connection = await connect()
        try:
            with self.assertRaises(asyncpg.UniqueViolationError):
                await connection.execute("INSERT INTO public.karaoke_song_versions(song_id,version_no) VALUES ($1,2)", self.song_id)
            with self.assertRaises(asyncpg.ForeignKeyViolationError):
                async with connection.transaction():
                    await connection.execute("UPDATE public.karaoke_songs SET status='PUBLISHED',published_version_id=$1 WHERE id=$2", other.draft.id, self.song_id)
        finally:
            await connection.close()

    async def test_parent_ownership_grade_active_and_literal_search(self):
        await self.publish(await self.ready())
        with self.assertRaises(HTTPException) as caught:
            await self.service.catalog(self.parent, uuid4())
        self.assertEqual(caught.exception.status_code, 404)
        self.assertEqual((await self.service.catalog(self.parent, self.child, search="%" + self.title)).total, 0)
        async with self.repository.write():
            child = await self.db.get(ChildProfile, self.child)
            child.Grade = 5
        self.assertEqual((await self.service.catalog(self.parent, self.child, search=self.title)).total, 0)
        async with self.repository.write():
            actor = await self.db.get(Profile, self.parent)
            actor.Active = 0
        with self.assertRaises(HTTPException) as caught:
            await self.service.catalog(self.parent, self.child)
        self.assertEqual(caught.exception.status_code, 403)


if __name__ == "__main__":
    unittest.main()
