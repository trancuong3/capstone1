"""Feature #4 test suite: Personalized Weak-Word 4-Page Micro-Storybook.

Compatible with both `python -m unittest` and `pytest`.

Verifies:
1. 3-5 due weak-word selection via `compute_spaced_difficult_words()` + cold-start MOET grade fill.
2. Cohesive 4-page Vietnamese story creation (Grade 1-2 vs Grade 3-5) with tokenized `PageRevisionWord`
   bboxes, `target_weak_words` metadata, Cloudflare FLUX routing + Style Bible, and 3 `ComprehensionQuestion` rows.
3. Mandatory `child_safety` rejection on unsafe parent inputs (422) and sanitization/fallback on unsafe LLM drafts.
4. Per-child daily generation quota (`VIREAD_MICRO_STORY_DAILY_LIMIT`, default 2, 429 when exceeded,
   deletion-proof, independent per sibling child).
5. Graceful deterministic PNG illustration fallback when Cloudflare FLUX / local image providers are
   unavailable or 429 quota-limited.
6. Strict `PARENT_PRIVATE` household isolation (cross-parent 404, non-parent 403, `Cache-Control: private, no-store`).
"""
from __future__ import annotations

from datetime import datetime, timedelta, timezone
from io import BytesIO
import os
from pathlib import Path
import sys
import tempfile
from typing import Any
import unittest
from unittest.mock import patch
from uuid import UUID, uuid4

_BACKEND_DIR = Path(__file__).resolve().parents[1]
if str(_BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(_BACKEND_DIR))

os.environ["APP_ENVIRONMENT"] = "test"
os.environ.setdefault("DATABASE_URL", "postgresql+asyncpg://test:test@127.0.0.1:1/test")
os.environ.setdefault("SUPABASE_URL", "https://example.supabase.co")
os.environ.setdefault("SUPABASE_KEY", "isolated-test-key")
os.environ.setdefault("SUPABASE_STORAGE_BUCKET", "viread-test-catalog")
os.environ.setdefault("SUPABASE_PRIVATE_BOOKS_BUCKET", "viread-test-private")
os.environ.setdefault("VIREAD_LOCAL_VOICE_WORKER_AUTOSTART", "false")

from fastapi import FastAPI, HTTPException
from fastapi.testclient import TestClient
import httpx
from PIL import Image
from sqlalchemy.exc import IntegrityError

from app.api.deps import get_current_parent_id, get_db
from app.api.routes import parent_private_book as parent_private_book_route
from app.api.routes import personalized_micro_story as micro_story_route
from app.database.role_cache import invalidate_cached_role
from app.models import (
    AuditLog,
    Book,
    BookPage,
    ChildProfile,
    ComprehensionQuestion,
    DifficultWordPracticeAttempt,
    PageRevision,
    PageRevisionWord,
    Profile,
    ReadingSession,
    ReadingSessionPage,
)
from app.policies.book_access import VISIBILITY_PARENT_PRIVATE
from app.schemas.personalized_micro_story import MicroStoryGenerateRequest
from app.services.ai_capability_router import AiCapabilityRouter
from app.services.book_cover_service import detect_magic_image_format
from app.services.personalized_micro_story_service import PersonalizedMicroStoryService
from test_durable_workflows_and_router import (  # noqa: E402
    FakeStudioAsyncSession,
    StudioDbState,
    _ScalarResult,
    _eval_clause,
)


_ALLOWED_READING_SESSION_STATES = {"IN_PROGRESS", "PAUSED", "COMPLETED", "ABORTED"}
_ALLOWED_COMPREHENSION_QUESTION_TYPES = {"FACTUAL", "CLOZE", "VOCABULARY"}


class MicroStoryFakeSession(FakeStudioAsyncSession):
    """Extends FakeStudioAsyncSession with flush(objs), refresh(obj), CHECK constraints, and multi-table queries."""

    def __init__(self, state: StudioDbState):
        super().__init__(state)
        for model_cls in (
            ChildProfile,
            DifficultWordPracticeAttempt,
            PageRevisionWord,
            ReadingSession,
            ReadingSessionPage,
            ComprehensionQuestion,
            AuditLog,
        ):
            self.state.tables.setdefault(model_cls, [])

    @staticmethod
    def _validate_check_constraints(obj: Any) -> None:
        if isinstance(obj, Book):
            if obj.Name is not None and not str(obj.Name).strip():
                raise IntegrityError(
                    "books_name_not_blank",
                    None,
                    RuntimeError("CHECK constraint failed: books_name_not_blank"),
                )
        elif isinstance(obj, ReadingSession):
            if obj.State not in _ALLOWED_READING_SESSION_STATES:
                raise IntegrityError(
                    "readingsessions_state_check",
                    None,
                    RuntimeError(
                        f"CHECK constraint failed: readingsessions_state_check ({obj.State!r})"
                    ),
                )
        elif isinstance(obj, ComprehensionQuestion):
            if obj.Type not in _ALLOWED_COMPREHENSION_QUESTION_TYPES:
                raise IntegrityError(
                    "comprehensionquestions_type_check",
                    None,
                    RuntimeError(
                        f"CHECK constraint failed: comprehensionquestions_type_check ({obj.Type!r})"
                    ),
                )

    async def flush(self, objects: Any = None) -> None:
        targets = list(objects) if objects is not None else list(self._pending_adds)
        for obj in targets:
            self._validate_check_constraints(obj)
        await super().flush()

    async def refresh(self, obj: Any) -> None:
        _ = obj

    async def rollback(self) -> None:
        await super().rollback()

    async def commit(self) -> None:
        await super().commit()

    async def execute(self, query: Any) -> Any:
        col_descs = getattr(query, "column_descriptions", None) or []
        if (
            len(col_descs) == 1
            and col_descs[0].get("name") == "Role"
            and getattr(col_descs[0].get("expr"), "table", None) is not None
            and col_descs[0]["expr"].table.name == "profiles"
        ):
            rows = list(self.state.tables.get(Profile, []))
            for crit in getattr(query, "_where_criteria", ()):
                rows = [r for r in rows if _eval_clause(r, crit)]
            return _ScalarResult([r.Role for r in rows])

        if (
            len(col_descs) == 2
            and col_descs[0].get("entity") is BookPage
            and col_descs[1].get("entity") is PageRevision
        ):
            revs_by_id = {r.Id: r for r in self.state.tables.get(PageRevision, [])}
            pages = list(self.state.tables.get(BookPage, []))
            for crit in getattr(query, "_where_criteria", ()):
                pages = [p for p in pages if _eval_clause(p, crit)]
            pages.sort(key=lambda p: int(p.PageNumber or 0))
            pairs = [(p, revs_by_id.get(p.CurrentVerifiedRevisionId)) for p in pages]
            res_obj = _ScalarResult(pairs)
            setattr(res_obj, "one_or_none", lambda: pairs[0] if pairs else None)
            return res_obj

        return await super().execute(query)

    async def scalar(self, query: Any) -> Any | None:
        col_descs = getattr(query, "column_descriptions", None) or []
        if len(col_descs) == 1:
            desc0 = col_descs[0]
            if desc0.get("name") == "Id" and getattr(desc0.get("expr"), "table", None) is not None:
                tbl_name = desc0["expr"].table.name
                if tbl_name == "books":
                    books = list(self.state.tables.get(Book, []))
                    pages = list(self.state.tables.get(BookPage, []))
                    revs = {r.Id: r for r in self.state.tables.get(PageRevision, [])}
                    profiles = {p.Id: p for p in self.state.tables.get(Profile, [])}
                    matched_ids: list[UUID] = []
                    for b in books:
                        ok = True
                        for crit in getattr(query, "_where_criteria", ()):
                            if type(crit).__name__ == "Exists":
                                continue
                            if not _eval_clause(b, crit):
                                ok = False
                                break
                        if not ok:
                            continue
                        owner = profiles.get(b.OwnerParentId)
                        if owner is None or owner.Role != "parent" or owner.Active != 1:
                            continue
                        has_ready_page = any(
                            p.BookId == b.Id
                            and p.LifecycleStatus == "ACTIVE"
                            and p.CurrentVerifiedRevisionId in revs
                            and revs[p.CurrentVerifiedRevisionId].VerificationStatus == "VERIFIED"
                            for p in pages
                        )
                        if has_ready_page:
                            matched_ids.append(b.Id)
                    return matched_ids[0] if matched_ids else None
        res = await self.execute(query)
        return res.first()


def _make_png_bytes(color: tuple[int, int, int] = (120, 190, 240)) -> bytes:
    im = Image.new("RGB", (512, 384), color)
    buf = BytesIO()
    im.save(buf, format="PNG")
    return buf.getvalue()


def _seed_household(state: StudioDbState) -> tuple[UUID, UUID, UUID, UUID, UUID]:
    invalidate_cached_role()
    now = datetime.now(timezone.utc)
    parent_a = uuid4()
    parent_b = uuid4()
    child_user = uuid4()
    child_a1 = uuid4()
    child_a2 = uuid4()

    state.tables[Profile].extend(
        [
            Profile(Id=parent_a, Role="parent", DisplayName="Mẹ Minh", Active=1, CreatedAt=now),
            Profile(Id=parent_b, Role="parent", DisplayName="Bố Nam", Active=1, CreatedAt=now),
            Profile(Id=child_user, Role="student", DisplayName="Student", Active=1, CreatedAt=now),
        ]
    )
    state.tables[ChildProfile].extend(
        [
            ChildProfile(
                Id=child_a1,
                ParentId=parent_a,
                Alias="Bé Bông",
                Grade=1,
                Settings={},
                CreatedAt=now,
            ),
            ChildProfile(
                Id=child_a2,
                ParentId=parent_a,
                Alias="Anh Khoa",
                Grade=4,
                Settings={},
                CreatedAt=now,
            ),
        ]
    )
    return parent_a, parent_b, child_user, child_a1, child_a2


def _seed_weak_words(
    state: StudioDbState,
    *,
    parent_id: UUID,
    child_id: UUID,
    words: list[tuple[str, str, str]],
) -> None:
    now = datetime.now(timezone.utc) - timedelta(days=2)
    for idx, (norm, disp, status_val) in enumerate(words):
        state.tables.setdefault(DifficultWordPracticeAttempt, []).append(
            DifficultWordPracticeAttempt(
                Id=uuid4(),
                ChildId=child_id,
                ParentId=parent_id,
                NormalizedWord=norm,
                DisplayText=disp,
                AttemptNumber=idx + 1,
                RequestId=uuid4(),
                CompletionRequestId=uuid4(),
                State="COMPLETED",
                AssessmentStatus=status_val,
                RecognitionSource="SERVER_STT_KEYTERM",
                Confidence=0.82,
                AssessmentVersion=1,
                EvidenceWordIds=[],
                StartedAt=now,
                CompletedAt=now,
                CreatedAt=now,
                UpdatedAt=now,
            )
        )


def _build_test_app(
    session: MicroStoryFakeSession,
    active_actor_ref: dict[str, UUID],
) -> FastAPI:
    app = FastAPI()
    app.include_router(micro_story_route.router, prefix="/micro-stories")
    app.include_router(parent_private_book_route.router, prefix="/books")

    def _override_parent() -> UUID:
        return active_actor_ref["actor_id"]

    async def _override_db():
        yield session

    app.dependency_overrides[get_current_parent_id] = _override_parent
    app.dependency_overrides[get_db] = _override_db
    return app


class TestFeat4PersonalizedMicroStory(unittest.IsolatedAsyncioTestCase):
    def setUp(self) -> None:
        self._tmp_dir = tempfile.TemporaryDirectory()
        self._env_patcher = patch.dict(
            os.environ,
            {
                "VIREAD_LOCAL_STORAGE_DIR": self._tmp_dir.name,
                "VIREAD_MICRO_STORY_DAILY_LIMIT": "2",
                "SMART_AI_IMAGE_GEN_ENABLED": "false",
                "LOCAL_OCR_ENABLED": "false",
                "OCR_CLOUD_CORRECTION_ENABLED": "false",
            },
            clear=False,
        )
        self._env_patcher.start()

    def tearDown(self) -> None:
        self._env_patcher.stop()
        self._tmp_dir.cleanup()

    def test_preview_words_ranks_due_weak_words_and_cold_start_fills_grade_words(self) -> None:
        state = StudioDbState()
        session = MicroStoryFakeSession(state)
        parent_a, _parent_b, _student, child_g1, child_g4 = _seed_household(state)

        _seed_weak_words(
            state,
            parent_id=parent_a,
            child_id=child_g1,
            words=[
                ("xinh xắn", "xinh xắn", "INCORRECT"),
                ("nắng ấm", "nắng ấm", "INCORRECT"),
                ("tròn xoe", "tròn xoe", "UNCERTAIN"),
                ("rực rỡ", "rực rỡ", "INCORRECT"),
            ],
        )

        actor_ref = {"actor_id": parent_a}
        client = TestClient(_build_test_app(session, actor_ref))

        res1 = client.get(f"/micro-stories/children/{child_g1}/preview-words")
        self.assertEqual(res1.status_code, 200)
        self.assertIn("no-store", res1.headers.get("cache-control", ""))
        body1 = res1.json()
        self.assertFalse(body1["cold_start_filled"])
        rec_words_1 = [w["display_text"] for w in body1["recommended_words"]]
        self.assertTrue(3 <= len(rec_words_1) <= 5)
        self.assertEqual(set(rec_words_1), {"xinh xắn", "nắng ấm", "tròn xoe", "rực rỡ"})
        self.assertEqual(body1["quota"]["daily_limit"], 2)
        self.assertEqual(body1["quota"]["remaining_today"], 2)

        _seed_weak_words(
            state,
            parent_id=parent_a,
            child_id=child_g4,
            words=[("khúc khuỷu", "khúc khuỷu", "INCORRECT")],
        )
        res2 = client.get(f"/micro-stories/children/{child_g4}/preview-words")
        self.assertEqual(res2.status_code, 200)
        body2 = res2.json()
        self.assertTrue(body2["cold_start_filled"])
        self.assertTrue(3 <= len(body2["recommended_words"]) <= 5)
        self.assertEqual(body2["recommended_words"][0]["display_text"], "khúc khuỷu")
        self.assertEqual(body2["recommended_words"][0]["source"], "WEAK_WORD")
        self.assertTrue(any(w["source"] == "COLD_START_GRADE" for w in body2["recommended_words"]))

    async def test_generate_4_page_story_with_cloudflare_flux_tokenized_words_and_comprehension(
        self,
    ) -> None:
        state = StudioDbState()
        session = MicroStoryFakeSession(state)
        parent_a, _parent_b, _student, child_g1, child_g4 = _seed_household(state)

        _seed_weak_words(
            state,
            parent_id=parent_a,
            child_id=child_g1,
            words=[
                ("lung linh", "lung linh", "INCORRECT"),
                ("chim sẻ", "chim sẻ", "INCORRECT"),
                ("rộn ràng", "rộn ràng", "INCORRECT"),
            ],
        )

        flux_calls: list[dict[str, Any]] = []
        png_bytes = _make_png_bytes((240, 180, 120))

        async def _mock_flux_handler(request: httpx.Request) -> httpx.Response:
            import json as _json

            flux_calls.append(_json.loads(request.content.decode("utf-8")))
            return httpx.Response(
                200,
                headers={"content-type": "image/png"},
                content=png_bytes,
            )

        router_env = {
            "SMART_AI_IMAGE_GEN_ENABLED": "true",
            "CLOUDFLARE_ACCOUNT_ID": "cf-test-acct",
            "CLOUDFLARE_API_TOKEN": "cf-test-token",
            "LOCAL_OCR_ENABLED": "false",
            "OCR_CLOUD_CORRECTION_ENABLED": "false",
        }
        ai_router = AiCapabilityRouter(env=router_env)
        orig_generate = ai_router.generate_image

        async def _generate_with_mock_transport(req):
            return await orig_generate(req, transport=httpx.MockTransport(_mock_flux_handler))

        ai_router.generate_image = _generate_with_mock_transport  # type: ignore[method-assign]

        svc = PersonalizedMicroStoryService(session, ai_router=ai_router, env=router_env)
        result = await svc.generate_micro_story(
            parent_a,
            child_g1,
            MicroStoryGenerateRequest(
                selected_words=["lung linh", "chim sẻ", "rộn ràng"],
                theme_hint="vườn hoa mùa xuân",
            ),
            base_url="http://testserver",
        )

        self.assertEqual(result.visibility_scope, "PARENT_PRIVATE")
        self.assertTrue(result.readable_for_children)
        self.assertEqual(result.illustration_provider, "cloudflare_flux")
        self.assertFalse(result.illustration_fallback_used)
        self.assertEqual(len(flux_calls), 4)
        self.assertTrue(all("NO text" in c["prompt"] for c in flux_calls))
        self.assertEqual(len(result.pages), 4)
        self.assertTrue(2 <= len(result.comprehension_questions) <= 3)

        combined_story = " ".join(p.text.lower() for p in result.pages)
        for target in ("lung linh", "chim sẻ", "rộn ràng"):
            self.assertIn(target, combined_story)

        book_rows = [b for b in state.tables[Book] if b.Id == result.book_id]
        self.assertEqual(len(book_rows), 1)
        self.assertEqual(book_rows[0].VisibilityScope, VISIBILITY_PARENT_PRIVATE)
        self.assertEqual(book_rows[0].OwnerParentId, parent_a)

        page_rows = [p for p in state.tables[BookPage] if p.BookId == result.book_id]
        self.assertEqual(len(page_rows), 4)
        for p_row in page_rows:
            self.assertTrue(
                p_row.ImagePath.startswith(f"private-books/{parent_a}/{result.book_id}/pages/")
            )
            self.assertIsInstance(p_row.ProcessingMeta.get("target_weak_words"), list)
            words_for_rev = [
                w
                for w in state.tables[PageRevisionWord]
                if w.PageRevisionId == p_row.CurrentVerifiedRevisionId
            ]
            self.assertGreaterEqual(len(words_for_rev), 8)
            self.assertTrue(all(len(w.BoundingBox) == 4 for w in words_for_rev))

        comp_rows = [
            q for q in state.tables[ComprehensionQuestion] if q.SessionId == result.seeded_session_id
        ]
        self.assertEqual(len(comp_rows), len(result.comprehension_questions))
        self.assertTrue(all(q.Type in {"FACTUAL", "CLOZE", "VOCABULARY"} for q in comp_rows))
        self.assertIn("VOCABULARY", {q.Type for q in comp_rows})

        session_rows = [s for s in state.tables[ReadingSession] if s.Id == result.seeded_session_id]
        self.assertEqual(len(session_rows), 1)
        self.assertEqual(session_rows[0].State, "IN_PROGRESS")

        svc_g4 = PersonalizedMicroStoryService(session, ai_router=ai_router, env=router_env)
        res_g4 = await svc_g4.generate_micro_story(
            parent_a,
            child_g4,
            MicroStoryGenerateRequest(selected_words=["ngân nga", "rực rỡ", "bình yên"]),
        )
        avg_words_g1 = sum(p.word_count for p in result.pages) / 4.0
        avg_words_g4 = sum(p.word_count for p in res_g4.pages) / 4.0
        self.assertGreater(avg_words_g4, avg_words_g1)

    async def test_child_safety_rejects_unsafe_input_and_sanitizes_unsafe_llm_output(self) -> None:
        state = StudioDbState()
        session = MicroStoryFakeSession(state)
        parent_a, _parent_b, _student, child_g1, _child_g4 = _seed_household(state)

        router_env = {
            "SMART_AI_IMAGE_GEN_ENABLED": "false",
            "LOCAL_OCR_ENABLED": "false",
            "OCR_CLOUD_CORRECTION_ENABLED": "false",
        }
        svc = PersonalizedMicroStoryService(
            session,
            ai_router=AiCapabilityRouter(env=router_env),
            env=router_env,
        )
        with self.assertRaises(HTTPException) as ctx:
            await svc.generate_micro_story(
                parent_a,
                child_g1,
                MicroStoryGenerateRequest(
                    selected_words=["lung linh", "chim sẻ", "rộn ràng"],
                    theme_hint="câu chuyện bạo lực máu me đáng sợ",
                ),
            )
        self.assertEqual(ctx.exception.status_code, 422)
        self.assertEqual(len(state.tables[Book]), 0)

        async def _unsafe_llm_draft(_grade: int, _alias: str, _words: list[str], _theme: str | None):
            return {
                "_provider_id": "mock_llm",
                "title": "Truyện ma quỷ kinh dị",
                "pages": [
                    {
                        "page_number": 1,
                        "text": "Cảnh bạo lực kinh dị trong đêm tối lung linh.",
                        "scene_description_en": "dark scene",
                    },
                    {
                        "page_number": 2,
                        "text": "Chim sẻ gặp nguy hiểm súng đạn.",
                        "scene_description_en": "scene 2",
                    },
                    {
                        "page_number": 3,
                        "text": "Tiếng la hét rộn ràng đáng sợ.",
                        "scene_description_en": "scene 3",
                    },
                    {
                        "page_number": 4,
                        "text": "Kết thúc rùng rợn.",
                        "scene_description_en": "scene 4",
                    },
                ],
                "questions": [],
            }

        svc_sanitize = PersonalizedMicroStoryService(
            session,
            ai_router=AiCapabilityRouter(env=router_env),
            story_llm_fn=_unsafe_llm_draft,
            env=router_env,
        )
        safe_res = await svc_sanitize.generate_micro_story(
            parent_a,
            child_g1,
            MicroStoryGenerateRequest(selected_words=["lung linh", "chim sẻ", "rộn ràng"]),
        )
        self.assertEqual(safe_res.safety_status, "SANITIZED_FALLBACK")
        self.assertEqual(safe_res.story_provider, "deterministic_wholesome_vi")
        for p in safe_res.pages:
            self.assertNotIn("kinh dị", p.text.lower())
            self.assertNotIn("bạo lực", p.text.lower())

    def test_daily_per_child_quota_enforced_429_and_isolated_per_child(self) -> None:
        state = StudioDbState()
        session = MicroStoryFakeSession(state)
        parent_a, _parent_b, _student, child_a1, child_a2 = _seed_household(state)
        actor_ref = {"actor_id": parent_a}
        client = TestClient(_build_test_app(session, actor_ref))

        r1 = client.post(
            f"/micro-stories/children/{child_a1}/generate",
            json={"selected_words": ["lung linh", "nắng sớm", "chim sẻ"]},
        )
        self.assertEqual(r1.status_code, 201)
        self.assertEqual(r1.json()["quota"]["used_today"], 1)
        self.assertEqual(r1.json()["quota"]["remaining_today"], 1)
        self.assertFalse(r1.json()["quota"]["quota_exceeded"])

        r2 = client.post(
            f"/micro-stories/children/{child_a1}/generate",
            json={"selected_words": ["lung linh", "nắng sớm", "rộn ràng"]},
        )
        self.assertEqual(r2.status_code, 201)
        self.assertEqual(r2.json()["quota"]["used_today"], 2)
        self.assertEqual(r2.json()["quota"]["remaining_today"], 0)
        self.assertTrue(r2.json()["quota"]["quota_exceeded"])

        first_book_id = UUID(r1.json()["book_id"])
        for b in state.tables[Book]:
            if b.Id == first_book_id:
                b.IsDeleted = True
                b.LifecycleStatus = "RETIRED"

        r3 = client.post(
            f"/micro-stories/children/{child_a1}/generate",
            json={"selected_words": ["lung linh", "nắng sớm", "trong trẻo"]},
        )
        self.assertEqual(r3.status_code, 429)
        self.assertEqual(r3.json()["detail"]["code"], "MICRO_STORY_DAILY_QUOTA_EXCEEDED")

        q_sibling = client.get(f"/micro-stories/children/{child_a2}/quota")
        self.assertEqual(q_sibling.status_code, 200)
        self.assertEqual(q_sibling.json()["remaining_today"], 2)
        self.assertFalse(q_sibling.json()["quota_exceeded"])

    async def test_image_provider_unavailable_or_429_falls_back_to_deterministic_png_gracefully(
        self,
    ) -> None:
        state = StudioDbState()
        session = MicroStoryFakeSession(state)
        parent_a, _parent_b, _student, child_g1, _child_g4 = _seed_household(state)

        async def _flux_429_handler(_request: httpx.Request) -> httpx.Response:
            return httpx.Response(
                429,
                json={"errors": [{"message": "Daily free neurons quota exceeded"}]},
            )

        router_env = {
            "SMART_AI_IMAGE_GEN_ENABLED": "true",
            "CLOUDFLARE_ACCOUNT_ID": "cf-acct",
            "CLOUDFLARE_API_TOKEN": "cf-tok",
            "LOCAL_OCR_ENABLED": "false",
            "OCR_CLOUD_CORRECTION_ENABLED": "false",
        }
        ai_router = AiCapabilityRouter(env=router_env)
        orig_generate = ai_router.generate_image

        async def _gen_429(req):
            return await orig_generate(req, transport=httpx.MockTransport(_flux_429_handler))

        ai_router.generate_image = _gen_429  # type: ignore[method-assign]

        uploaded_blobs: list[tuple[str, bytes, str]] = []

        def _capture_upload(path: str, data: bytes, mime: str, _bucket: str) -> None:
            uploaded_blobs.append((path, data, mime))

        svc = PersonalizedMicroStoryService(
            session,
            ai_router=ai_router,
            storage_upload_fn=_capture_upload,
            env=router_env,
        )
        res = await svc.generate_micro_story(
            parent_a,
            child_g1,
            MicroStoryGenerateRequest(selected_words=["lung linh", "nắng sớm", "chim sẻ"]),
        )

        self.assertTrue(res.illustration_fallback_used)
        self.assertEqual(res.illustration_provider, "deterministic_illustrated_png")
        self.assertEqual(len(uploaded_blobs), 4)
        for _path, raw_png, mime in uploaded_blobs:
            self.assertEqual(mime, "image/png")
            self.assertEqual(detect_magic_image_format(raw_png), "PNG")

    def test_strict_parent_private_cross_parent_isolation_and_non_parent_rejection(self) -> None:
        state = StudioDbState()
        session = MicroStoryFakeSession(state)
        parent_a, parent_b, student_actor, child_a1, _child_a2 = _seed_household(state)
        actor_ref = {"actor_id": parent_a}
        client = TestClient(_build_test_app(session, actor_ref))

        created_resp = client.post(
            f"/micro-stories/children/{child_a1}/generate",
            json={"selected_words": ["lung linh", "nắng sớm", "chim sẻ"]},
        )
        self.assertEqual(created_resp.status_code, 201)
        book_id = created_resp.json()["book_id"]
        first_page_id = created_resp.json()["pages"][0]["page_id"]
        self.assertIn("no-store", created_resp.headers.get("cache-control", ""))

        own_img = client.get(f"/books/my-books/{book_id}/pages/{first_page_id}/image")
        self.assertEqual(own_img.status_code, 200)
        self.assertEqual(own_img.headers.get("content-type"), "image/png")

        actor_ref["actor_id"] = parent_b
        self.assertEqual(
            client.get(f"/micro-stories/children/{child_a1}/preview-words").status_code, 404
        )
        self.assertEqual(client.get(f"/micro-stories/children/{child_a1}/quota").status_code, 404)
        self.assertEqual(
            client.post(
                f"/micro-stories/children/{child_a1}/generate",
                json={"selected_words": ["lung linh", "nắng sớm", "chim sẻ"]},
            ).status_code,
            404,
        )
        self.assertEqual(client.get(f"/books/my-books/{book_id}").status_code, 404)
        self.assertEqual(
            client.get(f"/books/my-books/{book_id}/pages/{first_page_id}/image").status_code,
            404,
        )

        actor_ref["actor_id"] = student_actor
        self.assertEqual(client.get(f"/micro-stories/children/{child_a1}/quota").status_code, 403)

    async def test_db_failure_during_persistence_is_atomic_rolls_back_book_quota_and_storage(
        self,
    ) -> None:
        state = StudioDbState()
        session = MicroStoryFakeSession(state)
        parent_a, _parent_b, _student, child_g1, _child_g4 = _seed_household(state)

        router_env = {
            "SMART_AI_IMAGE_GEN_ENABLED": "false",
            "LOCAL_OCR_ENABLED": "false",
            "OCR_CLOUD_CORRECTION_ENABLED": "false",
        }
        svc = PersonalizedMicroStoryService(
            session,
            ai_router=AiCapabilityRouter(env=router_env),
            env=router_env,
        )

        orig_flush = session.flush

        async def _fail_on_session_flush(objects: Any = None) -> None:
            if objects and any(isinstance(obj, ReadingSession) for obj in objects):
                raise IntegrityError(
                    "simulated_session_failure",
                    None,
                    RuntimeError("simulated DB failure during ReadingSession flush"),
                )
            await orig_flush(objects)

        session.flush = _fail_on_session_flush  # type: ignore[method-assign]

        with self.assertRaises(IntegrityError):
            await svc.generate_micro_story(
                parent_a,
                child_g1,
                MicroStoryGenerateRequest(selected_words=["lung linh", "nắng sớm", "chim sẻ"]),
            )

        self.assertEqual(len(state.tables[Book]), 0)
        self.assertEqual(len(state.tables[BookPage]), 0)
        self.assertEqual(len(state.tables[PageRevision]), 0)
        self.assertEqual(len(state.tables[ReadingSession]), 0)
        self.assertEqual(len(state.tables[ComprehensionQuestion]), 0)
        quota_after_failure = await svc.get_quota(parent_a, child_g1)
        self.assertEqual(quota_after_failure.used_today, 0)
        self.assertEqual(list(Path(self._tmp_dir.name).rglob("*.png")), [])

    async def test_llm_malformed_json_maps_to_invalid_output_and_falls_back_cleanly(self) -> None:
        state = StudioDbState()
        session = MicroStoryFakeSession(state)
        parent_a, _parent_b, _student, child_g1, _child_g4 = _seed_household(state)

        router_env = {
            "SMART_AI_IMAGE_GEN_ENABLED": "false",
            "LOCAL_OCR_ENABLED": "false",
            "OCR_CLOUD_CORRECTION_ENABLED": "false",
            "GEMINI_API_KEY": "test-gemini-key",
        }
        ai_router = AiCapabilityRouter(env=router_env)

        async def _bad_json_transport(_request: httpx.Request) -> httpx.Response:
            return httpx.Response(
                200,
                json={"candidates": [{"content": {"parts": [{"text": "{not-valid-json"}]}}]},
            )

        orig_route = ai_router.route_and_execute

        async def _route_with_bad_json(capability, fn, **kwargs):
            async def _wrapped(provider, timeout_s):
                with patch("app.services.personalized_micro_story_service.httpx.AsyncClient") as mock_cls:
                    mock_cls.return_value = httpx.AsyncClient(
                        transport=httpx.MockTransport(_bad_json_transport)
                    )
                    return await fn(provider, timeout_s)

            return await orig_route(capability, _wrapped, **kwargs)

        ai_router.route_and_execute = _route_with_bad_json  # type: ignore[method-assign]

        svc = PersonalizedMicroStoryService(session, ai_router=ai_router, env=router_env)
        res = await svc.generate_micro_story(
            parent_a,
            child_g1,
            MicroStoryGenerateRequest(selected_words=["lung linh", "nắng sớm", "chim sẻ"]),
        )
        self.assertEqual(res.story_provider, "deterministic_wholesome_vi")
        self.assertEqual(len(res.pages), 4)


if __name__ == "__main__":
    unittest.main()
