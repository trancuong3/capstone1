"""Processing constraints/RLS in the explicit disposable loopback harness."""
import json
from pathlib import Path
import unittest
from uuid import uuid4

import asyncpg

from test_karaoke_postgres_integration import TEST_URL, connect, prepare_database, test_url


@unittest.skipUnless(TEST_URL, "Set KARAOKE_TEST_DATABASE_URL to the disposable karaoke database")
class ProcessingSchemaPostgresTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        test_url()
        await prepare_database()
        self.db = await connect()
        self.addAsyncCleanup(self.db.close)
        self.actor, self.song, self.draft = uuid4(), uuid4(), uuid4()
        await self.db.execute("INSERT INTO profiles(id,role,active) VALUES($1,'admin',1)", self.actor)
        await self.db.execute("INSERT INTO karaoke_songs(id,created_by) VALUES($1,$2)", self.song, self.actor)
        await self.db.execute("INSERT INTO karaoke_song_versions(id,song_id,version_no,created_by) VALUES($1,$2,1,$3)", self.draft, self.song, self.actor)

    async def job(self, *, song=None, draft=None, key=None):
        job_id = uuid4()
        await self.db.execute("""
            INSERT INTO karaoke_processing_jobs
            (id,song_id,draft_version_id,created_by,idempotency_key,request_fingerprint,
             mode,source_kind,pipeline_version,base_revision,input_fingerprint,
             base_audio_sha256,input_lyrics,lyrics_text_sha256,lyrics_snapshot_sha256,
             input_audio_path,input_audio_sha256,input_audio_size_bytes,input_duration_ms,
             quota_day,reserved_audio_ms)
            VALUES($1,$2,$3,$4,$5,$6,'VOCAL_TRACK','DRAFT_AUDIO','fixture-v1',1,$6,$6,
                   '{"format_version":2,"lines":[]}'::jsonb,$6,$6,'fixture/audio.mp3',$6,100,1000,
                   (now() AT TIME ZONE 'UTC')::date,1000)
        """, job_id, song or self.song, draft or self.draft, self.actor, key or uuid4(), "a" * 64)
        return job_id

    async def test_one_outstanding_job_and_cross_song_draft_constraint(self):
        job = await self.job()
        with self.assertRaises(asyncpg.UniqueViolationError):
            await self.job()
        await self.db.execute("UPDATE karaoke_processing_jobs SET status='CANCELLED' WHERE id=$1", job)
        second = await self.job()
        await self.db.execute("UPDATE karaoke_processing_jobs SET status='CANCELLED' WHERE id=$1", second)
        other = uuid4()
        await self.db.execute("INSERT INTO karaoke_songs(id) VALUES($1)", other)
        with self.assertRaises(asyncpg.ForeignKeyViolationError):
            await self.job(song=other)

    async def test_browser_roles_denied_and_service_role_can_read(self):
        job = await self.job()
        for role in ("anon", "authenticated"):
            async with self.db.transaction():
                await self.db.execute("SET LOCAL ROLE " + role)
                with self.assertRaises(asyncpg.InsufficientPrivilegeError):
                    async with self.db.transaction():
                        await self.db.fetch("SELECT id FROM karaoke_processing_jobs")
        async with self.db.transaction():
            await self.db.execute("SET LOCAL ROLE service_role")
            self.assertEqual(await self.db.fetchval("SELECT id FROM karaoke_processing_jobs WHERE id=$1", job), job)

    async def test_operation_identity_uses_step_not_ui_stage(self):
        job = await self.job()
        async def operation(step):
            await self.db.execute("""INSERT INTO karaoke_processing_operations
                (id,job_id,stage,step_key,step_input_fingerprint,attempt,operation_key,
                 provider,model_version,pipeline_version,lease_token)
                VALUES($1,$2,'ALIGNING_LYRICS',$3,$4,1,$5,'fixture','fixture','fixture-v1',$6)
            """, uuid4(), job, step, "a" * 64, uuid4(), uuid4())
        await operation("TRANSCRIBE_REFERENCE")
        await operation("ALIGN_PROVIDED_LYRICS")
        with self.assertRaises(asyncpg.UniqueViolationError):
            await operation("ALIGN_PROVIDED_LYRICS")

    async def test_partial_output_reference_and_changed_snapshot_are_rejected(self):
        job = await self.job()
        for statement in (
            "UPDATE karaoke_processing_jobs SET status='READY' WHERE id=$1",
            "UPDATE karaoke_processing_jobs SET input_audio_sha256=repeat('b',64) WHERE id=$1",
            "UPDATE karaoke_processing_jobs SET input_reference_path='incomplete' WHERE id=$1",
        ):
            with self.subTest(statement=statement), self.assertRaises(asyncpg.CheckViolationError):
                await self.db.execute(statement, job)
        with self.assertRaises(asyncpg.CheckViolationError):
            await self.db.execute("UPDATE karaoke_song_versions SET reference_audio_path='partial' WHERE id=$1", self.draft)

    async def test_ready_output_is_immutable_and_actor_delete_keeps_provenance(self):
        job = await self.job()
        await self.db.execute("""UPDATE karaoke_processing_jobs SET status='NEEDS_REVIEW',
            result_lyrics='{"format_version":2,"lines":[]}',result_audio_path='fixture/result.mp3',
            result_audio_sha256=repeat('b',64),result_audio_size_bytes=100,
            result_duration_ms=1000,quality_report='{}' WHERE id=$1""", job)
        with self.assertRaises(asyncpg.CheckViolationError):
            await self.db.execute("UPDATE karaoke_processing_jobs SET result_audio_sha256=repeat('c',64) WHERE id=$1", job)
        await self.db.execute("DELETE FROM profiles WHERE id=$1", self.actor)
        self.assertIsNone(await self.db.fetchval("SELECT created_by FROM karaoke_processing_jobs WHERE id=$1", job))
        self.assertEqual(await self.db.fetchval("SELECT status FROM karaoke_processing_jobs WHERE id=$1", job), "NEEDS_REVIEW")

    async def test_auto_review_defaults_do_not_change_legacy_draft(self):
        row = await self.db.fetchrow("SELECT requires_processing_review,origin_job_id,reviewed_at FROM karaoke_song_versions WHERE id=$1", self.draft)
        self.assertEqual(tuple(row), (False, None, None))


if __name__ == "__main__":
    unittest.main()
