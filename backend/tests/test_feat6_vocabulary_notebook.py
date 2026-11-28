"""Feature #6 test suite: Contextual Kids Glossary & PARENT_PRIVATE Vocabulary Notebook.

Compatible with both `pytest` and `python -m unittest`.

Verifies:
1. Grade-band explanation (`GRADE_1_2` ultra-short concrete vs `GRADE_3_5` compound/reduplicative nuance)
   routed via `AiCapabilityRouter`.
2. Shared `word_glossary_cache` hit on repeat `(normalized_word, grade_band)` lookup (0 extra AI calls)
   with zero cross-parent notebook state leakage.
3. Deterministic safe built-in Vietnamese kid-glossary fallback when AI providers are offline or 429 quota-exhausted.
4. `child_safety` guard: blocks unsafe input words (422) AND fails closed when an AI provider emits
   unsafe output (`NOT_RECOMMENDED` / `VIOLENCE` / lexical block), never caching unsafe text and returning
   safe deterministic fallback instead.
5. `PARENT_PRIVATE` CRUD ownership isolation (403/404 across different parents), duplicate prevention,
   cross-parent private `source_book_id` rejection, and mandatory `Cache-Control: private, no-store` headers.
"""

from __future__ import annotations

import json
import os
from pathlib import Path
import sys
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
os.environ.setdefault("VIREAD_LOCAL_VOICE_WORKER_AUTOSTART", "false")

from fastapi import FastAPI, HTTPException
from fastapi.testclient import TestClient
import httpx
from sqlalchemy.exc import IntegrityError

from app.api.deps import get_current_parent_id, get_db
from app.api.router import api_router
from app.api.routes import vocabulary_notebook as vocab_route
from app.models import (
    Book,
    BookPage,
    ChildFavoriteWord,
    ChildProfile,
    Profile,
    WordGlossaryCache,
)
from app.schemas.vocabulary_notebook import WordExplainRequest
from app.services.ai_capability_router import (
    ALL_TEXT_VISION_CAPABILITIES,
    AiCapabilityRouter,
    ProviderSpec,
)
from app.services.kid_glossary_service import KidGlossaryService
from test_durable_workflows_and_router import FakeStudioAsyncSession, StudioDbState


class _VocabFakeAsyncSession(FakeStudioAsyncSession):
    """Extends FakeStudioAsyncSession with delete + unique constraint checks for Feature #6 tables."""

    async def delete(self, row: Any) -> None:
        cls = type(row)
        rows = self.state.tables.get(cls)
        if rows is not None:
            self.state.tables[cls] = [item for item in rows if item is not row]

    async def commit(self) -> None:
        cache_rows = list(self.state.tables.get(WordGlossaryCache, []))
        seen_cache: set[tuple[str, str]] = set()
        for row in cache_rows:
            key = (str(row.NormalizedWord), str(row.GradeBand))
            if key in seen_cache:
                raise IntegrityError("duplicate word_glossary_cache", params=None, orig=Exception("uq"))
            seen_cache.add(key)

        fav_rows = list(self.state.tables.get(ChildFavoriteWord, []))
        seen_fav: set[tuple[UUID, str]] = set()
        for row in fav_rows:
            key_fav = (row.ChildProfileId, str(row.NormalizedWord))
            if key_fav in seen_fav:
                raise IntegrityError("duplicate child_favorite_words", params=None, orig=Exception("uq"))
            seen_fav.add(key_fav)

        await super().commit()


def _seed_two_households() -> tuple[StudioDbState, dict[str, UUID]]:
    state = StudioDbState()
    parent_a = uuid4()
    parent_b = uuid4()
    child_a_g1 = uuid4()
    child_a_g4 = uuid4()
    child_b_g2 = uuid4()
    private_book_b = uuid4()

    state.tables[Profile] = [
        Profile(Id=parent_a, Role="parent", DisplayName="Parent A", Active=1),
        Profile(Id=parent_b, Role="parent", DisplayName="Parent B", Active=1),
    ]
    state.tables[ChildProfile] = [
        ChildProfile(Id=child_a_g1, ParentId=parent_a, Alias="Bé Na", Grade=1, Settings={}),
        ChildProfile(Id=child_a_g4, ParentId=parent_a, Alias="Anh Minh", Grade=4, Settings={}),
        ChildProfile(Id=child_b_g2, ParentId=parent_b, Alias="Bé Bo", Grade=2, Settings={}),
    ]
    state.tables[Book] = [
        Book(
            Id=private_book_b,
            Title="Sách riêng nhà B",
            MinGrade=1,
            MaxGrade=3,
            LifecycleStatus="PUBLISHED",
            VisibilityScope="PARENT_PRIVATE",
            OwnerParentId=parent_b,
            ModerationStatus="ACTIVE",
            IsDeleted=False,
        )
    ]
    state.tables[BookPage] = []
    state.tables[WordGlossaryCache] = []
    state.tables[ChildFavoriteWord] = []
    return state, {
        "parent_a": parent_a,
        "parent_b": parent_b,
        "child_a_g1": child_a_g1,
        "child_a_g4": child_a_g4,
        "child_b_g2": child_b_g2,
        "private_book_b": private_book_b,
    }


def _build_test_client(
    state: StudioDbState,
    active_actor_holder: dict[str, UUID],
) -> TestClient:
    app = FastAPI()
    app.include_router(api_router)

    async def _override_db():
        yield _VocabFakeAsyncSession(state)

    def _override_current_actor() -> UUID:
        return active_actor_holder["actor_id"]

    app.dependency_overrides[get_db] = _override_db
    app.dependency_overrides[get_current_parent_id] = _override_current_actor
    return TestClient(app)


class Feat6VocabularyNotebookTests(unittest.IsolatedAsyncioTestCase):
    async def test_grade_band_explanation_and_shared_cache_hit(self) -> None:
        state, ids = _seed_two_households()
        db = _VocabFakeAsyncSession(state)

        gemini_calls: list[str] = []

        def _mock_handler(request: httpx.Request) -> httpx.Response:
            body = json.loads(request.content.decode("utf-8"))
            sys_text = body["systemInstruction"]["parts"][0]["text"]
            gemini_calls.append(sys_text)
            if "Lớp 1–2" in sys_text:
                payload = {
                    "part_of_speech_vi": "từ láy",
                    "definition_vi": "Sáng đẹp và rung rinh nhẹ như ánh sao.",
                    "example_sentence_vi": "Đèn lồng của bé sáng lung linh.",
                }
            else:
                payload = {
                    "part_of_speech_vi": "từ láy gợi tả",
                    "definition_vi": "Tỏa ánh sáng dịu nhẹ, huyền ảo và như rung rinh trong đêm.",
                    "example_sentence_vi": "Đêm Trung thu, sân trường rực ánh đèn lồng lung linh.",
                    "nuance_note_vi": "Từ láy âm đầu «l» gợi vẻ đẹp mềm mại của ánh sáng.",
                }
            return httpx.Response(
                200,
                json={"candidates": [{"content": {"parts": [{"text": json.dumps(payload)}]}}]},
            )

        transport = httpx.MockTransport(_mock_handler)
        router = AiCapabilityRouter(
            providers=[
                ProviderSpec(
                    provider_id="gemini_primary",
                    family="google",
                    model_id="gemini-2.5-flash",
                    capabilities=ALL_TEXT_VISION_CAPABILITIES,
                    quota_group="gemini_free_shared",
                    enabled=True,
                )
            ],
            env={"GEMINI_API_KEY": "test-gemini-key"},
        )
        safety_calls: list[str] = []

        async def _safe_checker(text: str) -> dict[str, Any]:
            safety_calls.append(text)
            return {"suitability": "SUITABLE", "findings": []}

        svc = KidGlossaryService(
            db,
            ai_router=router,
            safety_checker=_safe_checker,
            transport=transport,
            env={"GEMINI_API_KEY": "test-gemini-key"},
        )

        # 1. Grade 1 child gets ultra-short concrete GRADE_1_2 explanation (no nuance overload)
        res_g1 = await svc.explain_word(
            ids["parent_a"],
            ids["child_a_g1"],
            WordExplainRequest(word=' "Lung linh!" '),
        )
        self.assertEqual(res_g1.normalized_word, "lung linh")
        self.assertEqual(res_g1.grade_band, "GRADE_1_2")
        self.assertFalse(res_g1.fallback_used)
        self.assertFalse(res_g1.cached)
        self.assertIsNone(res_g1.nuance_note_vi)
        self.assertIn("ánh sao", res_g1.definition_vi)
        self.assertEqual(len(gemini_calls), 1)
        self.assertEqual(len(safety_calls), 1)

        # 2. Grade 4 child gets GRADE_3_5 explanation with reduplicative nuance
        res_g4 = await svc.explain_word(
            ids["parent_a"],
            ids["child_a_g4"],
            WordExplainRequest(word="lung linh"),
        )
        self.assertEqual(res_g4.grade_band, "GRADE_3_5")
        self.assertIsNotNone(res_g4.nuance_note_vi)
        self.assertIn("Từ láy", res_g4.nuance_note_vi or "")
        self.assertEqual(len(gemini_calls), 2)

        # 3. Repeat lookup for Grade 2 child (same GRADE_1_2 band, different household) hits DB cache (0 AI calls)
        res_cached = await svc.explain_word(
            ids["parent_b"],
            ids["child_b_g2"],
            WordExplainRequest(word="lung linh"),
        )
        self.assertEqual(res_cached.grade_band, "GRADE_1_2")
        self.assertTrue(res_cached.cached)
        self.assertEqual(res_cached.source_provider, "CACHE")
        self.assertEqual(res_cached.definition_vi, res_g1.definition_vi)
        self.assertFalse(res_cached.is_saved_in_notebook)
        self.assertEqual(len(gemini_calls), 2)

    async def test_offline_or_quota_exhausted_falls_back_to_safe_builtin_glossary(self) -> None:
        state, ids = _seed_two_households()
        db = _VocabFakeAsyncSession(state)

        def _quota_handler(_request: httpx.Request) -> httpx.Response:
            return httpx.Response(429, json={"error": {"message": "Resource_exhausted quota exceeded"}})

        router = AiCapabilityRouter(
            providers=[
                ProviderSpec(
                    provider_id="gemini_primary",
                    family="google",
                    model_id="gemini-2.5-flash",
                    capabilities=ALL_TEXT_VISION_CAPABILITIES,
                    quota_group="gemini_free_shared",
                    enabled=True,
                )
            ],
            env={"GEMINI_API_KEY": "test-gemini-key"},
        )
        svc = KidGlossaryService(
            db,
            ai_router=router,
            transport=httpx.MockTransport(_quota_handler),
            env={"GEMINI_API_KEY": "test-gemini-key"},
        )

        res_curated = await svc.explain_word(
            ids["parent_a"],
            ids["child_a_g4"],
            WordExplainRequest(word="chăm chỉ"),
        )
        self.assertTrue(res_curated.fallback_used)
        self.assertEqual(res_curated.source_provider, "FALLBACK")
        self.assertEqual(res_curated.grade_band, "GRADE_3_5")
        self.assertIn("Siêng năng", res_curated.definition_vi)
        self.assertIsNotNone(res_curated.nuance_note_vi)
        self.assertIn("chăm chỉ", res_curated.example_sentence_vi.lower())

        res_generic = await svc.explain_word(
            ids["parent_a"],
            ids["child_a_g1"],
            WordExplainRequest(word="xanh biếc"),
        )
        self.assertTrue(res_generic.fallback_used)
        self.assertEqual(res_generic.grade_band, "GRADE_1_2")
        self.assertIn("xanh biếc", res_generic.definition_vi.lower())
        self.assertEqual(len(state.tables[WordGlossaryCache]), 0)

    async def test_child_safety_guard_blocks_unsafe_input_and_fails_closed_on_unsafe_ai_output(
        self,
    ) -> None:
        state, ids = _seed_two_households()
        db = _VocabFakeAsyncSession(state)

        def _unsafe_ai_handler(_request: httpx.Request) -> httpx.Response:
            bad_payload = {
                "part_of_speech_vi": "động từ",
                "definition_vi": "Hành động nguy hiểm đáng sợ.",
                "example_sentence_vi": "Cảnh tượng đâm nhau trong ngõ tối.",
            }
            return httpx.Response(
                200,
                json={"candidates": [{"content": {"parts": [{"text": json.dumps(bad_payload)}]}}]},
            )

        async def _flagging_safety_checker(_text: str) -> dict[str, Any]:
            return {
                "suitability": "NOT_RECOMMENDED",
                "findings": [{"category": "VIOLENCE", "severity": "HIGH"}],
            }

        router = AiCapabilityRouter(
            providers=[
                ProviderSpec(
                    provider_id="gemini_primary",
                    family="google",
                    model_id="gemini-2.5-flash",
                    capabilities=ALL_TEXT_VISION_CAPABILITIES,
                    enabled=True,
                )
            ],
            env={"GEMINI_API_KEY": "test-gemini-key"},
        )
        svc = KidGlossaryService(
            db,
            ai_router=router,
            safety_checker=_flagging_safety_checker,
            transport=httpx.MockTransport(_unsafe_ai_handler),
            env={"GEMINI_API_KEY": "test-gemini-key"},
        )

        # 1. Unsafe AI output is rejected by child_safety, never cached, and replaced by safe fallback
        safe_res = await svc.explain_word(
            ids["parent_a"],
            ids["child_a_g1"],
            WordExplainRequest(word="dũng cảm"),
        )
        self.assertTrue(safe_res.fallback_used)
        self.assertEqual(safe_res.source_provider, "FALLBACK_SAFE")
        self.assertNotIn("đâm nhau", safe_res.example_sentence_vi.lower())
        self.assertIn("Mạnh dạn", safe_res.definition_vi)
        self.assertEqual(len(state.tables[WordGlossaryCache]), 0)

        # 2. Directly unsafe input word is blocked with 422 before calling AI
        with self.assertRaises(HTTPException) as ctx:
            await svc.explain_word(
                ids["parent_a"],
                ids["child_a_g1"],
                WordExplainRequest(word="ma túy"),
            )
        self.assertEqual(ctx.exception.status_code, 422)

    def test_http_routes_crud_duplicate_prevention_ownership_isolation_and_no_store_headers(
        self,
    ) -> None:
        state, ids = _seed_two_households()
        actor_holder = {"actor_id": ids["parent_a"]}
        client = _build_test_client(state, actor_holder)

        offline_router = AiCapabilityRouter(providers=[], env={})
        orig_service = vocab_route.KidGlossaryService
        with patch.object(
            vocab_route,
            "KidGlossaryService",
            side_effect=lambda db: orig_service(db, ai_router=offline_router, env={}),
        ):
            child_a = str(ids["child_a_g1"])
            child_b = str(ids["child_b_g2"])

            # 1. Explain endpoint sets Cache-Control: private, no-store
            r_explain = client.post(
                f"/vocabulary/children/{child_a}/explain",
                json={"word": "ríu rít"},
            )
            self.assertEqual(r_explain.status_code, 200)
            self.assertEqual(r_explain.headers.get("Cache-Control"), "private, no-store")
            explain_body = r_explain.json()
            self.assertEqual(explain_body["normalized_word"], "ríu rít")
            self.assertFalse(explain_body["is_saved_in_notebook"])

            # 2. Save word to Parent A's child notebook (201 Created, PARENT_PRIVATE)
            r_save_1 = client.post(
                f"/vocabulary/children/{child_a}/notebook",
                json={
                    "word": "Ríu rít",
                    "definition_vi": explain_body["definition_vi"],
                    "example_sentence_vi": explain_body["example_sentence_vi"],
                },
            )
            self.assertEqual(r_save_1.status_code, 201)
            self.assertEqual(r_save_1.headers.get("Cache-Control"), "private, no-store")
            saved_item = r_save_1.json()
            self.assertEqual(saved_item["visibility"], "PARENT_PRIVATE")
            self.assertFalse(saved_item["already_saved"])
            item_id = saved_item["id"]

            # 3. Duplicate save (different case/punctuation) is deduplicated cleanly (200 OK)
            r_save_dup = client.post(
                f"/vocabulary/children/{child_a}/notebook",
                json={"word": ' "ríu   rít!" '},
            )
            self.assertEqual(r_save_dup.status_code, 200)
            self.assertEqual(r_save_dup.json()["id"], item_id)
            self.assertTrue(r_save_dup.json()["already_saved"])

            # 4. Explain again reflects `is_saved_in_notebook: True`
            r_explain_after = client.post(
                f"/vocabulary/children/{child_a}/explain",
                json={"word": "ríu rít"},
            )
            self.assertEqual(r_explain_after.status_code, 200)
            self.assertTrue(r_explain_after.json()["is_saved_in_notebook"])
            self.assertEqual(r_explain_after.json()["notebook_item_id"], item_id)

            # 5. List notebook returns 1 item + storytelling_words
            r_list = client.get(f"/vocabulary/children/{child_a}/notebook")
            self.assertEqual(r_list.status_code, 200)
            self.assertEqual(r_list.headers.get("Cache-Control"), "private, no-store")
            list_body = r_list.json()
            self.assertEqual(list_body["total"], 1)
            self.assertEqual(list_body["storytelling_words"], ["Ríu rít"])

            # 6. Cross-parent private source_book_id probing is rejected with 403
            r_cross_book = client.post(
                f"/vocabulary/children/{child_a}/notebook",
                json={
                    "word": "trong xanh",
                    "source_book_id": str(ids["private_book_b"]),
                },
            )
            self.assertEqual(r_cross_book.status_code, 403)

            # 7. Switch actor to Parent B -> 403 Forbidden on Parent A's child across ALL endpoints!
            actor_holder["actor_id"] = ids["parent_b"]

            self.assertEqual(client.get(f"/vocabulary/children/{child_a}/notebook").status_code, 403)
            self.assertEqual(
                client.post(
                    f"/vocabulary/children/{child_a}/explain",
                    json={"word": "lung linh"},
                ).status_code,
                403,
            )
            self.assertEqual(
                client.post(
                    f"/vocabulary/children/{child_a}/notebook",
                    json={"word": "lung linh"},
                ).status_code,
                403,
            )
            self.assertEqual(
                client.delete(f"/vocabulary/children/{child_a}/notebook/{item_id}").status_code,
                403,
            )
            self.assertEqual(
                client.delete(f"/vocabulary/children/{child_b}/notebook/{item_id}").status_code,
                403,
            )
            self.assertEqual(
                client.get(f"/vocabulary/children/{uuid4()}/notebook").status_code,
                404,
            )

            # 8. Switch back to Parent A -> delete succeeds and empties notebook
            actor_holder["actor_id"] = ids["parent_a"]
            r_del = client.delete(f"/vocabulary/children/{child_a}/notebook/{item_id}")
            self.assertEqual(r_del.status_code, 200)
            self.assertEqual(r_del.headers.get("Cache-Control"), "private, no-store")
            self.assertEqual(r_del.json(), {"deleted": True, "item_id": item_id})

            r_list_empty = client.get(f"/vocabulary/children/{child_a}/notebook")
            self.assertEqual(r_list_empty.status_code, 200)
            self.assertEqual(r_list_empty.json()["total"], 0)


if __name__ == "__main__":
    unittest.main()
