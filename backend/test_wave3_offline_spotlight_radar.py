"""Wave 3 Backend tests: H^-1 Line Spotlight, Offline Reading Pack/Sync, and OCR Hard-Sample Radar."""
from __future__ import annotations

from contextlib import asynccontextmanager
from datetime import datetime, timedelta, timezone
import json
import os
from types import SimpleNamespace
import unittest
from uuid import UUID, uuid4

os.environ["APP_ENVIRONMENT"] = "test"
os.environ.setdefault(
    "DATABASE_URL", "postgresql+asyncpg://test:test@127.0.0.1:1/test"
)
os.environ.setdefault("SUPABASE_URL", "https://example.supabase.co")
os.environ.setdefault("SUPABASE_KEY", "isolated-test-key")

import cv2
from fastapi import HTTPException, Response
import numpy as np
from sqlalchemy import select
from sqlalchemy.dialects import postgresql
from sqlalchemy.exc import IntegrityError

from app.api.routes.book_content_quality import get_admin_ocr_hard_sample_radar
from app.models import (
    Book,
    BookPage,
    PageRevision,
    ParentBookOcrContributionConsent,
    ReadingSession,
)
from app.schemas.reading import (
    OfflineReadingSyncEventInput,
    OfflineReadingSyncPageInput,
    OfflineReadingSyncRequest,
)
from app.services.ocr_hard_sample_radar_service import (
    OcrHardSampleRadarService,
    _eligible_radar_book_clause,
)
from app.services.offline_reading_service import (
    OfflineReadingService,
    derive_offline_sync_session_id,
)
from app.services.vision_page_matcher import (
    ViReadPageMatcher,
    project_page_lines_to_camera,
)


def _render_synthetic_book_page() -> bytes:
    """Create a high-contrast synthetic page image with rich ORB corner features."""
    canvas = np.full((1120, 800), 242, dtype=np.uint8)
    rng = np.random.default_rng(20261128)
    for idx in range(90):
        x = int(rng.integers(50, 740))
        y = int(rng.integers(60, 1050))
        w = int(rng.integers(14, 48))
        h = int(rng.integers(10, 32))
        cv2.rectangle(canvas, (x, y), (x + w, y + h), 25 + (idx % 40), 2)
        cv2.circle(canvas, (x + w // 2, y + h // 2), 4, 15, -1)
    cv2.putText(
        canvas,
        "VIREAD LUC BAT TRANG 1",
        (80, 220),
        cv2.FONT_HERSHEY_SIMPLEX,
        1.2,
        20,
        3,
    )
    ok, buf = cv2.imencode(".png", canvas)
    assert ok
    return buf.tobytes()


class _FakeResult:
    def __init__(self, rows: list) -> None:
        self._rows = list(rows)

    def all(self) -> list:
        return list(self._rows)

    def scalars(self) -> "_FakeResult":
        return self


class _ScriptedAsyncSession:
    """Deterministic zero-driver AsyncSession test double."""

    def __init__(
        self,
        *,
        scalars_queue: list | None = None,
        execute_queue: list[list] | None = None,
    ) -> None:
        self.scalars_queue = list(scalars_queue or [])
        self.execute_queue = list(execute_queue or [])
        self.added: list = []
        self.committed = 0
        self.rolled_back = 0
        self.raise_integrity_on_commit = False

    async def scalar(self, _stmt):
        return self.scalars_queue.pop(0) if self.scalars_queue else None

    async def execute(self, _stmt) -> _FakeResult:
        rows = self.execute_queue.pop(0) if self.execute_queue else []
        return _FakeResult(rows)

    def add(self, obj: object) -> None:
        self.added.append(obj)

    async def flush(self) -> None:
        return None

    async def commit(self) -> None:
        if self.raise_integrity_on_commit:
            self.raise_integrity_on_commit = False
            raise IntegrityError("INSERT INTO readingsessions", {}, Exception("pk"))
        self.committed += 1

    async def rollback(self) -> None:
        self.rolled_back += 1

    @asynccontextmanager
    async def begin_nested(self):
        yield


class Wave3BackendTests(unittest.IsolatedAsyncioTestCase):
    def test_inverse_homography_projects_lines_and_rejects_degenerate_matrices(self) -> None:
        db_bytes = _render_synthetic_book_page()
        db_img = cv2.imdecode(np.frombuffer(db_bytes, np.uint8), cv2.IMREAD_GRAYSCALE)
        assert db_img is not None

        # Warp page slightly into a simulated camera perspective view (800 x 1120)
        src_quad = np.float32([[0, 0], [800, 0], [800, 1120], [0, 1120]])
        dst_quad = np.float32([[60, 75], [735, 95], [755, 1045], [45, 1025]])
        h_db_to_cam = cv2.getPerspectiveTransform(src_quad, dst_quad)
        cam_img = cv2.warpPerspective(
            db_img, h_db_to_cam, (800, 1120), borderValue=200
        )
        ok, cam_buf = cv2.imencode(".png", cam_img)
        assert ok

        matcher = ViReadPageMatcher(max_cache_entries=32)
        match_res = matcher.match_page(
            cam_buf.tobytes(),
            [
                {
                    "cache_key": ("page-1", "books/p1.png"),
                    "image_bytes": db_bytes,
                }
            ],
        )
        self.assertTrue(match_res["matched"])
        self.assertIsNotNone(match_res["homography_cam_to_db"])

        sample_words = [
            {
                "word_index": 0,
                "line_index": 0,
                "text": "Công",
                "bbox": (0.10, 0.18, 0.14, 0.04),
            },
            {
                "word_index": 1,
                "line_index": 0,
                "text": "cha",
                "bbox": (0.26, 0.18, 0.12, 0.04),
            },
            {
                "word_index": 2,
                "line_index": 1,
                "text": "Nghĩa",
                "bbox": (0.10, 0.28, 0.16, 0.04),
            },
        ]
        projected = project_page_lines_to_camera(
            match_res["homography_cam_to_db"],
            cam_size=match_res["cam_resized_size"],
            db_size=match_res["db_resized_size"],
            words=sample_words,
        )
        self.assertIsNotNone(projected["homography_matrix"])
        self.assertEqual(len(projected["homography_matrix"]), 9)
        self.assertEqual(len(projected["page_quad"]), 4)
        self.assertEqual(len(projected["spotlight_lines"]), 2)
        first_line = projected["spotlight_lines"][0]
        self.assertEqual(first_line["text"], "Công cha")
        self.assertEqual(first_line["word_count"], 2)
        for px, py in first_line["points"]:
            self.assertGreater(px, 0.05)
            self.assertLess(px, 0.95)
            self.assertGreater(py, 0.10)
            self.assertLess(py, 0.90)

        # Singular & mirror-flipped homographies must degrade safely to empty spotlight
        singular = np.array([[0.0, 0.0, 1.0], [0.0, 0.0, 1.0], [0.0, 0.0, 1.0]])
        rejected_singular = project_page_lines_to_camera(
            singular,
            cam_size=(800, 1120),
            db_size=(800, 1120),
            words=sample_words,
        )
        self.assertIsNone(rejected_singular["homography_matrix"])
        self.assertEqual(rejected_singular["spotlight_lines"], [])

        mirror_h = np.array([[-1.0, 0.0, 800.0], [0.0, 1.0, 0.0], [0.0, 0.0, 1.0]])
        rejected_mirror = project_page_lines_to_camera(
            mirror_h,
            cam_size=(800, 1120),
            db_size=(800, 1120),
            words=sample_words,
        )
        self.assertIsNone(rejected_mirror["homography_matrix"])
        self.assertEqual(rejected_mirror["spotlight_lines"], [])

    async def test_offline_pack_and_idempotent_sync_replay_and_stale_revision_skip(self) -> None:
        parent_id = uuid4()
        child_id = uuid4()
        book_id = uuid4()
        page1_id = uuid4()
        rev1_id = uuid4()
        word1_id = uuid4()
        word2_id = uuid4()
        stale_page_id = uuid4()
        stale_rev_id = uuid4()

        fake_book = SimpleNamespace(
            Id=book_id,
            Title="Ca dao Lục Bát",
            Name="Ca dao Lục Bát",
            Author="Dân gian",
            MinGrade=1,
            MaxGrade=3,
            VisibilityScope="PARENT_PRIVATE",
            OwnerParentId=parent_id,
        )
        fake_page = SimpleNamespace(
            Id=page1_id,
            BookId=book_id,
            PageNumber=1,
            ImagePath="private/p1.png",
            Width=800,
            Height=1120,
            CurrentVerifiedRevisionId=rev1_id,
        )
        fake_rev = SimpleNamespace(
            Id=rev1_id,
            PageId=page1_id,
            VerifiedText="Công cha như núi Thái Sơn",
            ProcessingMeta={},
        )
        fake_words = [
            SimpleNamespace(
                Id=word1_id,
                PageRevisionId=rev1_id,
                WordIndex=0,
                LineIndex=0,
                Text="Công",
                BoundingBox=[0.1, 0.2, 0.12, 0.04],
            ),
            SimpleNamespace(
                Id=word2_id,
                PageRevisionId=rev1_id,
                WordIndex=1,
                LineIndex=0,
                Text="cha",
                BoundingBox=[0.24, 0.2, 0.10, 0.04],
            ),
        ]

        pack_db = _ScriptedAsyncSession(
            scalars_queue=["parent", fake_book],
            execute_queue=[
                [(fake_page, fake_rev)],  # pages + revisions
                fake_words,  # words
                [],  # illustrations
                [],  # ocr extractions
            ],
        )
        pack = await OfflineReadingService(pack_db).build_offline_pack(
            parent_id, book_id, base_url="https://api.viread.local"
        )
        self.assertEqual(pack.book.book_id, book_id)
        self.assertEqual(pack.book.page_count, 1)
        self.assertEqual(len(pack.pages[0].words), 2)
        self.assertGreaterEqual(pack_db.rolled_back, 1)

        now = datetime.now(timezone.utc)
        sync_req = OfflineReadingSyncRequest(
            client_sync_id="offline-client-pack-001",
            child_id=child_id,
            book_id=book_id,
            started_at=now - timedelta(minutes=6),
            ended_at=now,
            pages=[
                OfflineReadingSyncPageInput(
                    page_id=page1_id,
                    page_revision_id=rev1_id,
                    completed=True,
                    transcript="Công cha như núi Thái Sơn",
                ),
                OfflineReadingSyncPageInput(
                    page_id=stale_page_id,
                    page_revision_id=stale_rev_id,
                    completed=True,
                    transcript="Trang đã bị gỡ",
                ),
            ],
            events=[
                OfflineReadingSyncEventInput(
                    page_id=page1_id,
                    page_revision_id=rev1_id,
                    word_id=word1_id,
                    type="WORD_RETRY",
                    status="CONFIRMED",
                    start_ms=120,
                    end_ms=650,
                )
            ],
        )

        sync_db = _ScriptedAsyncSession(
            scalars_queue=[
                "parent",
                child_id,
                None,  # existing ReadingSession -> None
                book_id,  # accessible book
            ],
            execute_queue=[
                [(page1_id, 1, rev1_id, "Công cha như núi Thái Sơn")],
                [(rev1_id, word1_id, "Công"), (rev1_id, word2_id, "cha")],
            ],
        )
        first_sync = await OfflineReadingService(sync_db).sync_offline_session(
            parent_id, sync_req
        )
        expected_sid = derive_offline_sync_session_id(
            parent_id, child_id, "offline-client-pack-001"
        )
        self.assertEqual(first_sync.session_id, expected_sid)
        self.assertFalse(first_sync.idempotent_replay)
        self.assertEqual(first_sync.synced_pages_count, 1)
        self.assertEqual(first_sync.synced_reports_count, 1)
        self.assertEqual(first_sync.synced_events_count, 1)
        self.assertEqual(first_sync.skipped_page_ids, [stale_page_id])
        self.assertEqual(sync_db.committed, 1)

        persisted_session = next(
            obj for obj in sync_db.added if isinstance(obj, ReadingSession)
        )

        # Exact replay returns idempotent_replay=True without writing duplicate rows
        replay_db = _ScriptedAsyncSession(
            scalars_queue=[
                "parent",
                child_id,
                persisted_session,
                1,  # pages_count
                1,  # reports_count
                1,  # events_count
            ]
        )
        replay_sync = await OfflineReadingService(replay_db).sync_offline_session(
            parent_id, sync_req
        )
        self.assertEqual(replay_sync.session_id, expected_sid)
        self.assertTrue(replay_sync.idempotent_replay)
        self.assertEqual(replay_sync.synced_pages_count, 1)
        self.assertEqual(replay_sync.skipped_page_ids, [stale_page_id])
        self.assertEqual(replay_db.committed, 0)

    async def test_ocr_hard_sample_radar_enforces_consent_rights_and_zero_pii(self) -> None:
        # Compile SQL clause against PostgreSQL dialect to verify strict Flow 2 consent SQL
        stmt = (
            select(Book.Id)
            .join(BookPage, BookPage.BookId == Book.Id)
            .join(PageRevision, PageRevision.PageId == BookPage.Id)
            .outerjoin(
                ParentBookOcrContributionConsent,
                ParentBookOcrContributionConsent.BookId == Book.Id,
            )
            .where(_eligible_radar_book_clause())
        )
        compiled_sql = str(
            stmt.compile(
                dialect=postgresql.dialect(),
                compile_kwargs={"literal_binds": True},
            )
        )
        self.assertIn("'CATALOG'", compiled_sql)
        self.assertIn("'PARENT_PRIVATE'", compiled_sql)
        self.assertIn("'OPTED_IN'", compiled_sql)
        self.assertIn("rights_confirmed IS true", compiled_sql)
        self.assertIn("revoked_at IS NULL", compiled_sql)

        admin_id = uuid4()
        parent_id = uuid4()
        catalog_book_id = uuid4()
        consented_book_id = uuid4()
        physical_book_id = uuid4()
        pii_book_id = uuid4()

        cat_w_id = uuid4()
        con_w_id = uuid4()
        phys_w_id = uuid4()
        pii_w_id = uuid4()
        cat_rev_id = uuid4()
        con_rev_id = uuid4()
        phys_rev_id = uuid4()
        pii_rev_id = uuid4()
        cat_page_id = uuid4()
        con_page_id = uuid4()
        sess_id = uuid4()

        # Non-admin must be denied with 403
        non_admin_db = _ScriptedAsyncSession(scalars_queue=["parent"])
        with self.assertRaises(HTTPException) as ctx:
            await OcrHardSampleRadarService(non_admin_db).get_hard_sample_radar(
                parent_id
            )
        self.assertEqual(ctx.exception.status_code, 403)

        candidate_rows = [
            (
                SimpleNamespace(
                    Id=cat_w_id,
                    LineIndex=0,
                    WordIndex=0,
                    Text="khuỷu",
                    OCRConfidence=0.61,
                ),
                cat_rev_id,
                cat_page_id,
                1,
                catalog_book_id,
                "Truyện Cổ Tích",
                "Truyện Cổ Tích",
                "CATALOG",
                None,
            ),
            (
                SimpleNamespace(
                    Id=con_w_id,
                    LineIndex=0,
                    WordIndex=0,
                    Text="ngoằn",
                    OCRConfidence=0.58,
                ),
                con_rev_id,
                con_page_id,
                2,
                consented_book_id,
                "Thơ Tự Sáng Tác",
                "Thơ Tự Sáng Tác",
                "PARENT_PRIVATE",
                "[SELF_AUTHORED] Tác phẩm gia đình",
            ),
            # OWNED_PHYSICAL_BOOK must be rejected even if SQL returned it
            (
                SimpleNamespace(
                    Id=phys_w_id,
                    LineIndex=0,
                    WordIndex=0,
                    Text="thương",
                    OCRConfidence=0.40,
                ),
                phys_rev_id,
                uuid4(),
                1,
                physical_book_id,
                "Sách Mua Ngoài Hiệu",
                "Sách Mua Ngoài Hiệu",
                "PARENT_PRIVATE",
                "[OWNED_PHYSICAL_BOOK] Sách thương mại",
            ),
            # Phone number PII must be filtered out strictly
            (
                SimpleNamespace(
                    Id=pii_w_id,
                    LineIndex=0,
                    WordIndex=0,
                    Text="0912345678",
                    OCRConfidence=0.35,
                ),
                pii_rev_id,
                uuid4(),
                1,
                pii_book_id,
                "Sách Có SĐT",
                "Sách Có SĐT",
                "PARENT_PRIVATE",
                "[SELF_AUTHORED] SĐT",
            ),
        ]

        admin_db = _ScriptedAsyncSession(
            scalars_queue=["admin"],
            execute_queue=[
                [(con_w_id, 3, 2)],  # retry_rows
                [
                    (
                        cat_rev_id,
                        sess_id,
                        [{"book_index": 0, "status": "SUBSTITUTE"}],
                        {},
                    )
                ],  # report_rows
                candidate_rows,
                [
                    (cat_rev_id, 0, "khuỷu"),
                    (cat_rev_id, 0, "tay"),
                    (con_rev_id, 0, "ngoằn"),
                    (con_rev_id, 0, "ngoèo"),
                    (pii_rev_id, 0, "0912345678"),
                ],  # sibling_rows
            ],
        )

        # Direct-call route handler without FastAPI DI (Query default objects intact)
        resp = Response()
        radar = await get_admin_ocr_hard_sample_radar(
            response=resp,
            actor_id=admin_id,
            db=admin_db,
        )
        returned_books = {item.book_id for item in radar.items}
        self.assertEqual(returned_books, {catalog_book_id, consented_book_id})
        self.assertEqual(radar.catalog_count, 1)
        self.assertEqual(radar.consented_private_count, 1)

        serialized = json.dumps(
            radar.model_dump(mode="json"), ensure_ascii=False
        ).lower()
        self.assertNotIn("email", serialized)
        self.assertNotIn("child", serialized)
        self.assertNotIn("0912345678", serialized)
        self.assertNotIn(str(parent_id).lower(), serialized)


if __name__ == "__main__":
    unittest.main()
