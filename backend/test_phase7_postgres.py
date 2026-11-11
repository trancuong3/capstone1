"""Phase 7: real PostgreSQL locks, replays and API load in a disposable schema.

Only the dedicated loopback database created for this phase is accepted. No
application DATABASE_URL, provider credentials, storage or historical rows are
used. Each test removes only its own random schema.
"""
from __future__ import annotations

import asyncio
import json
from math import ceil
import os
from pathlib import Path
import time
from statistics import median
import tracemalloc
import unittest
from uuid import UUID, uuid4

import httpx
from fastapi import FastAPI, HTTPException
from sqlalchemy import func, select, text
from sqlalchemy.engine import make_url
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine
from sqlalchemy.pool import NullPool

from app.api.deps import get_current_parent_id, get_db
from app.api.router import api_router
from app.database.session import Base
from app.models import (
    Book, BookPage, ChildProfile, PageRevision, PageRevisionWord, Profile,
    ReadingEvent, ReadingSession, ReadingSessionPage,
)
from app.models.reading_comparison_report import ReadingComparisonReport
from app.repositories.reading_content_repository import ReadingContentRepository
from app.schemas.reading import (
    CompareReadingRequest, ReadingEventCreate, ReadingPageNavigationCreate,
)
from app.services.reading_assessment import aggregate_assessment
from app.services.reading_comparison_service import ReadingComparisonService
from app.services.reading_content_service import ReadingContentService

TEST_URL = os.getenv("VIREAD_PHASE7_TEST_DATABASE_URL")


@unittest.skipUnless(TEST_URL, "Set VIREAD_PHASE7_TEST_DATABASE_URL to the dedicated Phase 7 loopback database")
class Phase7PostgresTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        url = make_url(TEST_URL)
        if (url.host != "127.0.0.1" or url.port != 55439
                or url.database != "viread_phase7_test" or url.username != "phase7"):
            raise RuntimeError("Refusing any database except the disposable Phase 7 database")
        self.schema = "phase7_" + uuid4().hex
        self.admin = create_async_engine(TEST_URL, poolclass=NullPool)
        async with self.admin.begin() as connection:
            await connection.execute(text(f'CREATE SCHEMA "{self.schema}"'))
        self.engine = create_async_engine(TEST_URL, poolclass=NullPool, connect_args={
            "server_settings": {"search_path": self.schema, "application_name": "viread_phase7"},
        })
        self.addAsyncCleanup(self.cleanup_schema)
        tables = [model.__table__ for model in (
            Profile, ChildProfile, Book, BookPage, PageRevision, PageRevisionWord,
            ReadingSession, ReadingSessionPage, ReadingEvent, ReadingComparisonReport,
        )]
        async with self.engine.begin() as connection:
            await connection.run_sync(lambda sync: Base.metadata.create_all(sync, tables=tables))
        self.sessions = async_sessionmaker(self.engine, expire_on_commit=False)
        self.actor = UUID("11111111-1111-4111-8111-111111111111")
        self.foreign_actor = UUID("11111111-1111-4111-8111-111111111112")
        self.child = UUID("22222222-2222-4222-8222-222222222222")
        self.book = UUID("33333333-3333-4333-8333-333333333333")
        self.pages = [UUID(f"55555555-5555-4555-8555-{number:012d}") for number in (555555555555, 555555555556)]
        self.revisions = [UUID(f"66666666-6666-4666-8666-{number:012d}") for number in (666666666666, 666666666667)]
        self.words = [[UUID(f"90000000-0000-4000-8000-{index*10+position+1:012d}") for position in range(3)] for index in range(2)]
        async with self.sessions() as db:
            db.add_all([Profile(Id=self.actor, Role="parent"), Profile(Id=self.foreign_actor, Role="parent")])
            await db.flush()
            db.add(ChildProfile(Id=self.child, ParentId=self.actor, Alias="Phase 7 fixture", Grade=2))
            db.add(Book(Id=self.book, Title="Phase 7 fixture", MinGrade=1, MaxGrade=3, LifecycleStatus="ACTIVE"))
            await db.flush()
            for index in range(2):
                db.add(BookPage(Id=self.pages[index], BookId=self.book, PageNumber=index+1,
                                ImagePath="", Width=600, Height=800, LifecycleStatus="ACTIVE"))
            await db.flush()
            for index in range(2):
                db.add(PageRevision(Id=self.revisions[index], PageId=self.pages[index], RevisionNo="1",
                                    VerificationStatus="VERIFIED", VerifiedText="Bé mèo đọc", ContentHash="phase7-fixture"))
            await db.flush()
            for index in range(2):
                page = await db.get(BookPage, self.pages[index])
                page.CurrentVerifiedRevisionId = self.revisions[index]
                for position, token in enumerate(("Bé", "mèo", "đọc")):
                    db.add(PageRevisionWord(Id=self.words[index][position], PageRevisionId=self.revisions[index],
                                            WordIndex=position, LineIndex=0, Text=token, NormalizedText=token.lower(),
                                            BoundingBox=[0.1+position*0.2, 0.1, 0.15, 0.1]))
            await db.commit()
        self.session_id = await self.new_session(UUID("44444444-4444-4444-8444-444444444444"))

    async def cleanup_schema(self):
        await self.engine.dispose()
        async with self.admin.begin() as connection:
            await connection.execute(text(f'DROP SCHEMA "{self.schema}" CASCADE'))
        await self.admin.dispose()

    async def new_session(self, session_id=None):
        session_id = session_id or uuid4()
        async with self.sessions() as db:
            db.add(ReadingSession(Id=session_id, ChildId=self.child, BookId=self.book,
                                 SelectedPageId=self.pages[0], SelectedPageRevisionId=self.revisions[0],
                                 StartPageId=self.pages[0], EndPageId=self.pages[1], CurrentPageId=self.pages[0],
                                 State="IN_PROGRESS", Mode="realtime"))
            await db.flush()
            for index in range(2):
                db.add(ReadingSessionPage(SessionId=session_id, PageId=self.pages[index],
                                         PageRevisionId=self.revisions[index], PageNumber=index+1,
                                         PageOrder=index, Status="IN_PROGRESS" if index == 0 else "PENDING"))
            await db.commit()
        return session_id

    def comparison(self, *, correct=False):
        return CompareReadingRequest(
            transcript="Bé mèo đọc" if correct else "Bé chó đọc",
            page_id=self.pages[0], page_revision_id=self.revisions[0], finalize=True,
            initial_assessment=[{"word_id": word, "status": "MISPRONUNCIATION" if index == 1 and not correct else "CORRECT"}
                                for index, word in enumerate(self.words[0])],
        )

    async def compare(self, payload=None, session_id=None):
        async with self.sessions() as db:
            return await ReadingComparisonService(db).compare(session_id or self.session_id, self.actor,
                                                               payload or self.comparison())

    def retry_payload(self, attempt=1, status="CONFIRMED"):
        return ReadingEventCreate(SessionId=self.session_id, PageId=self.pages[0], PageRevisionId=self.revisions[0],
                                  WordId=self.words[0][1], Type="WORD_RETRY", StartMs=0, Status=status,
                                  Metadata={"retry_attempt": attempt, "incorrect_retry_count": attempt if status == "FAILED" else attempt-1})

    async def save_retry(self, payload):
        async with self.sessions() as db:
            return await ReadingContentService(ReadingContentRepository(db)).create_reading_event(self.actor, payload)

    async def reports_and_events(self):
        async with self.sessions() as db:
            reports = list((await db.scalars(select(ReadingComparisonReport))).all())
            events = list((await db.scalars(select(ReadingEvent))).all())
            return reports, events

    async def test_twenty_simultaneous_finalizations_persist_one_immutable_snapshot(self):
        results = await asyncio.gather(*(self.compare() for _ in range(20)))
        self.assertEqual(len({row.report_id for row in results}), 1)
        reports, events = await self.reports_and_events()
        self.assertEqual(len(reports), 1)
        self.assertEqual(reports[0].Transcript, "Bé chó đọc")
        self.assertEqual(aggregate_assessment(self.session_id, reports, events)["assessment"].first_pass_incorrect, 1)

    async def test_conflicting_finalizations_have_one_winner_and_one_conflict(self):
        results = await asyncio.gather(self.compare(), self.compare(self.comparison(correct=True)), return_exceptions=True)
        errors = [value for value in results if isinstance(value, Exception)]
        self.assertEqual(len(errors), 1)
        self.assertIsInstance(errors[0], HTTPException)
        self.assertEqual(errors[0].status_code, 409)
        reports, _ = await self.reports_and_events()
        self.assertEqual(len(reports), 1)
        winning = next(value for value in results if not isinstance(value, Exception))
        self.assertEqual(reports[0].Transcript, winning.transcript)

    async def test_parallel_retry_replays_are_counted_once_and_do_not_improve_first_pass(self):
        await self.compare()
        results = await asyncio.gather(*(self.save_retry(self.retry_payload()) for _ in range(10)))
        self.assertEqual(len({event.Id for event in results}), 1)
        reports, events = await self.reports_and_events()
        self.assertEqual(len(events), 1)
        assessed = aggregate_assessment(self.session_id, reports, events)
        self.assertEqual(assessed["score"], 67)
        self.assertEqual(assessed["assessment"].first_pass_incorrect, 1)
        self.assertEqual(assessed["assessment"].self_corrected_words, 1)
        self.assertEqual(assessed["assessment"].retry_attempts, 1)

    async def test_simultaneous_third_failure_does_not_create_a_fourth_attempt(self):
        await self.compare()
        for attempt in (1, 2):
            await self.save_retry(self.retry_payload(attempt, "FAILED"))
        results = await asyncio.gather(*(self.save_retry(self.retry_payload(3, "FAILED")) for _ in range(10)))
        self.assertEqual(len({event.Id for event in results}), 1)
        with self.assertRaises(HTTPException) as caught:
            await self.save_retry(self.retry_payload(4, "FAILED"))
        self.assertEqual(caught.exception.status_code, 409)
        reports, events = await self.reports_and_events()
        self.assertEqual(len(events), 3)
        assessed = aggregate_assessment(self.session_id, reports, events)["assessment"]
        self.assertEqual(assessed.retry_attempts, 3)
        self.assertEqual(assessed.skipped_after_retry_limit, 1)

    async def test_stale_identity_map_cannot_write_retry_after_another_client_finishes(self):
        await self.compare()
        async with self.sessions() as stale_db:
            stale_repository = ReadingContentRepository(stale_db)
            stale = await stale_repository.session(self.session_id)
            self.assertEqual(stale.State, "IN_PROGRESS")
            async with self.sessions() as other_db:
                await ReadingContentService(ReadingContentRepository(other_db)).finish_session(self.session_id, self.actor)
            with self.assertRaises(HTTPException) as caught:
                await ReadingContentService(stale_repository).create_reading_event(self.actor, self.retry_payload())
            self.assertEqual(caught.exception.status_code, 409)
        self.assertEqual((await self.reports_and_events())[1], [])

    async def test_committed_retry_response_can_be_replayed_after_session_finish(self):
        await self.compare()
        event = await self.save_retry(self.retry_payload())
        async with self.sessions() as db:
            await ReadingContentService(ReadingContentRepository(db)).finish_session(self.session_id, self.actor)
        replay = await self.save_retry(self.retry_payload())
        self.assertEqual(event.Id, replay.Id)
        self.assertEqual(len((await self.reports_and_events())[1]), 1)

    async def test_parallel_navigation_completes_the_previous_page_once(self):
        async def navigate():
            async with self.sessions() as db:
                return await ReadingContentService(ReadingContentRepository(db)).navigate_session_page(
                    self.session_id, self.actor, ReadingPageNavigationCreate(target_page_id=self.pages[1]))
        results = await asyncio.gather(*(navigate() for _ in range(10)))
        self.assertTrue(all(result.current_page_id == self.pages[1] and result.completed_pages == 1 for result in results))
        async with self.sessions() as db:
            rows = list((await db.scalars(select(ReadingSessionPage).where(ReadingSessionPage.SessionId == self.session_id))).all())
            self.assertEqual(len(rows), 2)
            self.assertEqual(sum(row.Status == "COMPLETED" for row in rows), 1)

    async def test_real_api_database_load_at_one_five_ten_twenty_sessions(self):
        app = FastAPI()
        app.include_router(api_router)
        async def database():
            async with self.sessions() as db:
                yield db
        app.dependency_overrides[get_db] = database
        app.dependency_overrides[get_current_parent_id] = lambda: self.actor
        metrics = []
        try:
            async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://phase7.test") as client:
                # Ownership is still checked by the real service and database.
                app.dependency_overrides[get_current_parent_id] = lambda: self.foreign_actor
                denied = await client.post(f"/reading/sessions/{self.session_id}/compare", json=self.comparison().model_dump(mode="json"))
                self.assertIn(denied.status_code, (403, 404))
                app.dependency_overrides[get_current_parent_id] = lambda: self.actor
                for concurrency in (1, 5, 10, 20):
                    ids = [await self.new_session() for _ in range(concurrency)]
                    samples = []
                    async def request(session_id):
                        started = time.perf_counter()
                        response = await client.post(f"/reading/sessions/{session_id}/compare", json=self.comparison().model_dump(mode="json"))
                        samples.append((time.perf_counter()-started)*1000)
                        self.assertEqual(response.status_code, 200, response.text)
                        self.assertEqual(response.json()["summary"]["initial_assessment"][1]["status"], "MISPRONUNCIATION")
                    for _ in range(3):
                        await asyncio.gather(*(request(session_id) for session_id in ids))
                    ordered = sorted(samples)
                    # Measure memory separately: tracing allocations inside the
                    # timed batch distorts SQLAlchemy/asyncio latency severely.
                    tracemalloc.start()
                    try:
                        memory_response = await client.post(f"/reading/sessions/{ids[0]}/compare", json=self.comparison().model_dump(mode="json"))
                        self.assertEqual(memory_response.status_code, 200)
                        current, peak = tracemalloc.get_traced_memory()
                    finally:
                        tracemalloc.stop()
                    metrics.append({"sessions": concurrency, "requests": len(samples), "errors": 0,
                                    "p50_ms": median(ordered), "p95_ms": ordered[ceil(len(ordered)*0.95)-1],
                                    "memory_sample_requests": 1, "python_heap_bytes": current, "python_heap_peak_bytes": peak})
                async with self.sessions() as db:
                    count = await db.scalar(select(func.count()).select_from(ReadingComparisonReport))
                    self.assertEqual(count, 36)
            target = os.getenv("VIREAD_PHASE7_METRICS_PATH")
            if target:
                Path(target).write_text(json.dumps({"scope": "real FastAPI routes + PostgreSQL 17; synthetic auth identity; ASGI in-process; no provider/audio/storage/network HTTP latency", "measurements": metrics}, indent=2), encoding="utf-8")
        finally:
            tracemalloc.stop()
