"""Tests for AI tutor comprehension questions generated after a reading session."""

import asyncio
import json
import os
import unittest
from types import SimpleNamespace
from unittest.mock import patch
from uuid import UUID, uuid4

os.environ.setdefault("DATABASE_URL", "postgresql+asyncpg://test:test@127.0.0.1:1/test")
os.environ.setdefault("SUPABASE_URL", "https://example.supabase.co")
os.environ.setdefault("SUPABASE_KEY", "isolated-test-key")

import httpx
from fastapi import FastAPI, HTTPException
from fastapi.testclient import TestClient

from app.api.deps import get_current_parent_id, get_db
from app.api.routes import tutor_question as tutor_routes
from app.models import ComprehensionAnswer, ComprehensionQuestion
from app.services.tutor_question_service import TutorQuestionService
from app.services.tutor_questions import (
    SourcePage,
    TutorQuestionConfig,
    TutorQuestionGenerator,
)
from app.services.tutor_questions.providers import (
    GeminiQuestionProvider,
    GroqQuestionProvider,
)
from app.services.tutor_questions.rule_based import generate_rule_based
from app.services.tutor_questions.text_utils import normalize_text
from app.services.tutor_questions.types import QuestionProviderError
from app.services.tutor_questions.validators import validate_draft, validate_drafts

PARENT_ID = UUID("11111111-1111-4111-8111-111111111111")
OTHER_PARENT_ID = UUID("22222222-2222-4222-8222-222222222222")
TEXT = (
    "Bé Na có một chú mèo nhỏ. Chú mèo thích nằm bên cửa sổ. "
    "Mỗi sáng bé Na cho mèo ăn cá. Mèo kêu meo meo rất vui."
)


def make_page(page_number=1, text=TEXT) -> SourcePage:
    return SourcePage(
        page_id=uuid4(),
        revision_id=uuid4(),
        page_number=page_number,
        text=text,
        tokens=tuple(text.split()),
    )


def good_item(**overrides):
    item = {
        "type": "FACTUAL",
        "prompt": "Chú mèo thích nằm ở đâu?",
        "choices": ["Bên cửa sổ", "Trên mái nhà", "Dưới gầm bàn"],
        "correct_index": 0,
        "page_number": 1,
        "evidence": "Chú mèo thích nằm bên cửa sổ",
        "difficulty": "EASY",
    }
    item.update(overrides)
    return item


def run(coro):
    return asyncio.run(coro)


class ValidatorTests(unittest.TestCase):
    def test_accepts_grounded_question_and_maps_word_span(self):
        page = make_page()
        draft = validate_draft(good_item(), [page], "seed")
        self.assertIsNotNone(draft)
        self.assertEqual(draft.correct_answer, "Bên cửa sổ")
        self.assertEqual(len(draft.choices), 3)
        self.assertEqual(draft.page_id, page.page_id)
        # "Chú mèo thích nằm bên cửa sổ" starts at word 7 (zero based) and has 7 words.
        self.assertEqual(
            (draft.start_word_index, draft.end_word_index_exclusive), (7, 14)
        )

    def test_rejects_evidence_that_is_not_in_the_text(self):
        item = good_item(evidence="Chú chó thích chạy ngoài vườn")
        self.assertIsNone(validate_draft(item, [make_page()], "seed"))

    def test_rejects_malformed_output(self):
        page = make_page()
        for bad in (
            good_item(choices=["a", "b"]),
            good_item(choices=["Một", "Một", "Hai"]),
            good_item(correct_index=7),
            good_item(correct_index=True),
            good_item(prompt=""),
            good_item(type="ESSAY"),
            good_item(type="CLOZE"),  # a cloze prompt needs the ____ marker
            "not a dict",
        ):
            self.assertIsNone(validate_draft(bad, [page], "seed"), bad)

    def test_unknown_difficulty_falls_back_to_easy(self):
        draft = validate_draft(good_item(difficulty="EXPERT"), [make_page()], "seed")
        self.assertEqual(draft.difficulty, "EASY")

    def test_shuffle_is_stable_and_keeps_the_right_answer(self):
        page = make_page()
        first = validate_draft(good_item(), [page], "same")
        second = validate_draft(good_item(), [page], "same")
        self.assertEqual(first.choices, second.choices)
        self.assertEqual(first.correct_answer, "Bên cửa sổ")

    def test_drafts_are_deduplicated_and_capped(self):
        page = make_page()
        payload = {"questions": [good_item(), good_item(), good_item(prompt="Bé Na cho mèo ăn gì?",
            choices=["Cá", "Thịt", "Cơm"], evidence="bé Na cho mèo ăn cá")]}
        drafts = validate_drafts(payload, [page], count=5, seed="s")
        self.assertEqual(len(drafts), 2)
        self.assertEqual(len(validate_drafts(payload, [page], count=1, seed="s")), 1)
        self.assertEqual(validate_drafts("garbage", [page], count=3, seed="s"), [])


class RuleBasedTests(unittest.TestCase):
    def test_builds_cloze_questions_only_from_the_text(self):
        page = make_page()
        questions = generate_rule_based([page], count=3, seed="seed")
        self.assertGreaterEqual(len(questions), 1)
        words = {normalize_text(token) for token in page.tokens}
        for question in questions:
            self.assertEqual(question.type, "CLOZE")
            self.assertIn("____", question.prompt)
            self.assertIn(normalize_text(question.correct_answer), words)
            self.assertEqual(len({normalize_text(c) for c in question.choices}), len(question.choices))

    def test_is_deterministic(self):
        page = make_page()
        a = generate_rule_based([page], count=3, seed="x")
        b = generate_rule_based([page], count=3, seed="x")
        self.assertEqual([q.prompt for q in a], [q.prompt for q in b])

    def test_too_little_text_gives_no_question(self):
        self.assertEqual(generate_rule_based([make_page(text="Mèo ngủ.")], count=3, seed="x"), [])


def gemini_body(items):
    return {"candidates": [{"content": {"parts": [{"text": json.dumps({"questions": items})}]}}]}


def groq_body(items):
    return {"choices": [{"message": {"content": json.dumps({"questions": items})}}]}


class ProviderTests(unittest.TestCase):
    def test_gemini_parses_structured_json_and_sends_key_in_header_only(self):
        seen = {}

        def handler(request: httpx.Request) -> httpx.Response:
            seen["url"] = str(request.url)
            seen["key"] = request.headers.get("x-goog-api-key")
            seen["body"] = request.content.decode()
            return httpx.Response(200, json=gemini_body([good_item()]))

        provider = GeminiQuestionProvider(
            name="gemini-primary", model="m", api_key="SECRET", timeout_seconds=5,
            transport=httpx.MockTransport(handler),
        )
        payload = run(provider.generate(pages=[make_page()], count=3, max_chars=1000))
        self.assertEqual(payload["questions"][0]["type"], "FACTUAL")
        self.assertEqual(seen["key"], "SECRET")
        self.assertNotIn("SECRET", seen["url"])
        self.assertNotIn("SECRET", seen["body"])
        # Only book text is sent: no child or session identifiers.
        self.assertIn("Bé Na có một chú mèo", seen["body"])

    def test_http_errors_are_classified_without_vendor_details(self):
        for status_code, code in ((401, "PROVIDER_AUTHENTICATION"), (429, "PROVIDER_QUOTA"), (503, "PROVIDER_UNAVAILABLE")):
            provider = GeminiQuestionProvider(
                name="g", model="m", api_key="k", timeout_seconds=5,
                transport=httpx.MockTransport(lambda r, s=status_code: httpx.Response(s, text="vendor secret detail")),
            )
            with self.assertRaises(QuestionProviderError) as raised:
                run(provider.generate(pages=[make_page()], count=3, max_chars=1000))
            self.assertEqual(raised.exception.code, code)
            self.assertNotIn("vendor", str(raised.exception))

    def test_invalid_json_is_rejected(self):
        provider = GroqQuestionProvider(
            name="groq", model="m", api_key="k", timeout_seconds=5,
            transport=httpx.MockTransport(
                lambda r: httpx.Response(200, json={"choices": [{"message": {"content": "not json"}}]})
            ),
        )
        with self.assertRaises(QuestionProviderError) as raised:
            run(provider.generate(pages=[make_page()], count=3, max_chars=1000))
        self.assertEqual(raised.exception.code, "INVALID_RESPONSE")


class GeneratorTests(unittest.TestCase):
    def config(self, **overrides):
        values = dict(gemini_api_key="g", groq_api_key="q")
        values.update(overrides)
        return TutorQuestionConfig(**values)

    def test_falls_back_from_gemini_quota_to_groq_and_skips_other_gemini_model(self):
        calls = []

        def handler(request: httpx.Request) -> httpx.Response:
            calls.append(request.url.host)
            if "googleapis" in request.url.host:
                return httpx.Response(429)
            return httpx.Response(200, json=groq_body([good_item()]))

        generator = TutorQuestionGenerator(self.config(), transport=httpx.MockTransport(handler))
        result = run(generator.generate([make_page()], seed="s"))
        self.assertEqual((result.source, result.provider), ("AI", "groq"))
        self.assertEqual(calls.count("generativelanguage.googleapis.com"), 1)
        self.assertIn("gemini-fallback:SKIPPED_FAMILY", result.attempts)

    def test_hallucinated_output_falls_back_to_rule_based(self):
        bad = good_item(evidence="Một đoạn không có trong bài đọc")
        generator = TutorQuestionGenerator(
            self.config(),
            transport=httpx.MockTransport(lambda r: httpx.Response(200, json=gemini_body([bad]) if "google" in r.url.host else groq_body([bad]))),
        )
        result = run(generator.generate([make_page()], seed="s"))
        self.assertEqual(result.source, "RULE_BASED")
        self.assertTrue(result.questions)
        self.assertIn("gemini-primary:NO_VALID_QUESTIONS", result.attempts)

    def test_no_keys_or_ai_disabled_uses_rules_without_network(self):
        def forbidden(request):
            raise AssertionError("network must not be used")

        for cfg in (TutorQuestionConfig(), self.config(ai_enabled=False)):
            generator = TutorQuestionGenerator(cfg, transport=httpx.MockTransport(forbidden))
            self.assertEqual(run(generator.generate([make_page()], seed="s")).source, "RULE_BASED")

    def test_empty_text_gives_no_questions(self):
        generator = TutorQuestionGenerator(TutorQuestionConfig())
        self.assertEqual(run(generator.generate([], seed="s")).questions, [])

    def test_question_count_is_random_in_range_and_capped_by_text(self):
        class FixedRng:
            def __init__(self, value):
                self.value = value
                self.bounds = None

            def randint(self, low, high):
                self.bounds = (low, high)
                return self.value

        long_page = make_page(text=" ".join(["mèo"] * 100))
        rng = FixedRng(7)
        generator = TutorQuestionGenerator(TutorQuestionConfig(), rng=rng)
        self.assertEqual(generator.target_count([long_page]), 7)
        self.assertEqual(rng.bounds, (5, 10))

        # Short reading cannot support that many different questions.
        short = make_page(text=" ".join(["mèo"] * 20))
        tiny = make_page(text="Mèo ngủ trên ghế đệm êm.")
        self.assertEqual(generator.target_count([short]), 2)
        self.assertEqual(generator.target_count([tiny]), 1)

        fixed = TutorQuestionGenerator(
            TutorQuestionConfig(min_questions=4, max_questions=4)
        )
        self.assertEqual(fixed.target_count([long_page]), 4)

    def test_default_range_is_five_to_ten_and_varies(self):
        generator = TutorQuestionGenerator(TutorQuestionConfig())
        page = make_page(text=" ".join(["mèo"] * 200))
        counts = {generator.target_count([page]) for _ in range(300)}
        self.assertTrue(counts <= set(range(5, 11)))
        self.assertEqual(min(counts), 5)
        self.assertEqual(max(counts), 10)

    def test_environment_range_is_validated(self):
        with patch.dict(
            os.environ,
            {"TUTOR_QUESTIONS_MIN_COUNT": "7", "TUTOR_QUESTIONS_MAX_COUNT": "3"},
        ):
            cfg = TutorQuestionConfig.from_environment()
        self.assertEqual((cfg.min_questions, cfg.max_questions), (7, 7))
        with patch.dict(
            os.environ,
            {"TUTOR_QUESTIONS_MIN_COUNT": "x", "TUTOR_QUESTIONS_MAX_COUNT": "99"},
        ):
            cfg = TutorQuestionConfig.from_environment()
        self.assertEqual((cfg.min_questions, cfg.max_questions), (5, 10))

    def test_prompt_asks_the_model_for_the_chosen_count(self):
        seen = {}

        def handler(request: httpx.Request) -> httpx.Response:
            seen["body"] = request.content.decode()
            return httpx.Response(200, json=gemini_body([good_item()]))

        class FixedRng:
            def randint(self, low, high):
                return 8

        page = make_page(text=" ".join(["mèo"] * 120) + " " + TEXT)
        generator = TutorQuestionGenerator(
            self.config(), transport=httpx.MockTransport(handler), rng=FixedRng()
        )
        run(generator.generate([page], seed="s"))
        self.assertIn("đúng 8 câu hỏi", json.loads(seen["body"])["contents"][0]["parts"][0]["text"])


class FakeRepository:
    """In-memory stand-in for TutorQuestionRepository."""

    def __init__(self, state="COMPLETED", owner=PARENT_ID):
        self.session = SimpleNamespace(
            Id=uuid4(), State=state, SelectedPageId=None, SelectedPageRevisionId=None
        )
        self.owner = owner
        self.page = make_page()
        self.rows = [
            SimpleNamespace(
                Id=uuid4(), PageId=self.page.page_id, PageRevisionId=self.page.revision_id,
                PageNumber=1, Status="COMPLETED",
            )
        ]
        self.question_rows = []
        self.answer_rows = []
        self.commits = 0
        self.releases = 0

    async def owned_session(self, session_id, parent_id):
        ok = session_id == self.session.Id and parent_id == self.owner
        return self.session if ok else None

    owned_session_for_update = owned_session

    async def session_page_rows(self, session_id):
        return self.rows

    async def revision(self, revision_id):
        return SimpleNamespace(VerifiedText=TEXT)

    async def page_number(self, page_id):
        return 1

    async def revision_word_texts(self, revision_id):
        return list(self.page.tokens)

    async def questions(self, session_id):
        return list(self.question_rows)

    async def question(self, session_id, question_id):
        return next((q for q in self.question_rows if q.Id == question_id), None)

    async def answers(self, question_ids):
        return [a for a in self.answer_rows if a.QuestionId in question_ids]

    def add_questions(self, questions):
        for question in questions:
            question.Id = uuid4()
            question.PageId = question.PageId or self.page.page_id
        self.question_rows.extend(questions)

    def add_answer(self, answer):
        answer.Id = uuid4()
        self.answer_rows.append(answer)

    async def commit(self):
        self.commits += 1

    async def release(self):
        self.releases += 1

    async def refresh(self, instance):
        return None


def make_service(repo, **config_overrides):
    config = TutorQuestionConfig(**config_overrides)
    return TutorQuestionService(repo, TutorQuestionGenerator(config), config)


class ServiceTests(unittest.TestCase):
    def test_generation_requires_a_finished_session(self):
        repo = FakeRepository(state="ACTIVE")
        with self.assertRaises(HTTPException) as raised:
            run(make_service(repo).generate_for_session(repo.session.Id, PARENT_ID))
        self.assertEqual(raised.exception.status_code, 409)

    def test_another_parent_gets_not_found_everywhere(self):
        repo = FakeRepository()
        service = make_service(repo)
        for call in (
            service.generate_for_session(repo.session.Id, OTHER_PARENT_ID),
            service.next_question(repo.session.Id, OTHER_PARENT_ID),
            service.submit_answer(repo.session.Id, uuid4(), OTHER_PARENT_ID, "x"),
        ):
            with self.assertRaises(HTTPException) as raised:
                run(call)
            self.assertEqual(raised.exception.status_code, 404)

    def test_generation_is_idempotent_and_releases_the_db_before_ai(self):
        repo = FakeRepository()
        service = make_service(repo)
        first = run(service.generate_for_session(repo.session.Id, PARENT_ID))
        second = run(service.generate_for_session(repo.session.Id, PARENT_ID))
        self.assertTrue(first.created)
        self.assertFalse(second.created)
        self.assertEqual(first.total, second.total)
        self.assertEqual(len(repo.question_rows), first.total)
        self.assertEqual(first.source, "RULE_BASED")
        self.assertGreaterEqual(repo.releases, 1)

    def test_disabled_feature_creates_nothing(self):
        repo = FakeRepository()
        result = run(make_service(repo, enabled=False).generate_for_session(repo.session.Id, PARENT_ID))
        self.assertEqual((result.total, result.created), (0, False))
        self.assertEqual(repo.question_rows, [])

    def test_question_flow_grades_on_the_server_and_never_leaks_the_answer(self):
        repo = FakeRepository()
        service = make_service(repo)
        run(service.generate_for_session(repo.session.Id, PARENT_ID))
        total = len(repo.question_rows)

        seen = 0
        while True:
            nxt = run(service.next_question(repo.session.Id, PARENT_ID))
            if nxt.completed:
                break
            seen += 1
            self.assertEqual(nxt.position, seen)
            self.assertEqual(nxt.progress_label, f"Câu {seen}/{total}")
            self.assertNotIn("expected", json.dumps(nxt.model_dump(mode="json")).lower())
            question = repo.question_rows[seen - 1]
            wrong = next(c.value for c in nxt.choices if normalize_text(c.value) != normalize_text(question.ExpectedAnswer))
            miss = run(service.submit_answer(repo.session.Id, nxt.question.id, PARENT_ID, wrong))
            self.assertFalse(miss.is_correct)
            self.assertEqual(miss.feedback_code, "TRY_AGAIN")
            # A wrong answer keeps the same question as the next one.
            self.assertEqual(run(service.next_question(repo.session.Id, PARENT_ID)).question.id, nxt.question.id)
            hit = run(service.submit_answer(repo.session.Id, nxt.question.id, PARENT_ID, question.ExpectedAnswer.upper()))
            self.assertTrue(hit.is_correct)
            self.assertEqual(hit.score, 1.0)

        self.assertEqual(seen, total)
        again = run(service.submit_answer(repo.session.Id, repo.question_rows[0].Id, PARENT_ID, "anything"))
        self.assertTrue(again.is_correct)  # idempotent after success
        correct_rows = [a for a in repo.answer_rows if a.IsCorrect]
        self.assertEqual(len(correct_rows), total)

    def test_legacy_questions_without_choices_are_ignored(self):
        repo = FakeRepository()
        repo.question_rows.append(
            SimpleNamespace(Id=uuid4(), SourceSpan=[], Type="FACTUAL", Prompt="p",
                            ExpectedAnswer="secret", AcceptedAnswers=[], Difficulty="EASY", PageRevisionId=uuid4())
        )
        nxt = run(make_service(repo).next_question(repo.session.Id, PARENT_ID))
        self.assertTrue(nxt.completed)
        self.assertEqual(nxt.total, 0)


class RouteTests(unittest.TestCase):
    def client(self, authenticated=True):
        app = FastAPI()
        app.include_router(tutor_routes.router, prefix="/tutor")
        app.dependency_overrides[get_db] = lambda: None
        if authenticated:
            app.dependency_overrides[get_current_parent_id] = lambda: PARENT_ID
        return TestClient(app)

    def test_all_endpoints_require_authentication(self):
        client = self.client(authenticated=False)
        sid, qid = uuid4(), uuid4()
        self.assertEqual(client.post(f"/tutor/sessions/{sid}/questions/generate").status_code, 401)
        self.assertEqual(client.get(f"/tutor/sessions/{sid}/questions/next").status_code, 401)
        self.assertEqual(
            client.post(f"/tutor/sessions/{sid}/questions/{qid}/answer", json={"answer": "x"}).status_code, 401
        )

    def test_answer_body_is_validated(self):
        client = self.client()
        url = f"/tutor/sessions/{uuid4()}/questions/{uuid4()}/answer"
        self.assertEqual(client.post(url, json={"answer": "   "}).status_code, 422)
        self.assertEqual(client.post(url, json={"answer": "x" * 201}).status_code, 422)
        self.assertEqual(client.post(url, json={"answer": "x", "is_correct": True}).status_code, 422)
        self.assertEqual(client.post(url, json={}).status_code, 422)

    def test_router_delegates_to_the_service(self):
        repo = FakeRepository()
        service = make_service(repo)
        original = tutor_routes._service
        tutor_routes._service = lambda db: service
        try:
            client = self.client()
            body = client.post(f"/tutor/sessions/{repo.session.Id}/questions/generate").json()
            self.assertTrue(body["created"])
            nxt = client.get(f"/tutor/sessions/{repo.session.Id}/questions/next").json()
            self.assertFalse(nxt["completed"])
            self.assertEqual(set(nxt["question"]), {"id", "type", "prompt", "page_revision_id", "source_span", "difficulty", "answered"})
            self.assertEqual(client.get(f"/tutor/sessions/{uuid4()}/questions/next").status_code, 404)
        finally:
            tutor_routes._service = original


if __name__ == "__main__":
    unittest.main()
