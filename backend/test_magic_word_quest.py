"""Unit & route contract tests for Ephemeral AI Magic Word Quest ('Nhiệm vụ Phép Thuật 60s')."""

from __future__ import annotations

from datetime import datetime, timedelta, timezone
import json
import os
from types import SimpleNamespace
import unittest
from unittest.mock import AsyncMock, patch
from uuid import UUID, uuid4

from fastapi import FastAPI
from fastapi.testclient import TestClient
import httpx

from app.api.deps import require_parent_id
from app.api.routes.adaptive_learning import router as adaptive_router
from app.database.session import get_db
from app.repositories.adaptive_learning_repository import AdaptiveLearningRepository
from app.schemas.magic_word_quest import (
    MagicQuestCompleteRequest,
    MagicQuestGenerateRequest,
)
from app.services.adaptive_learning_service import (
    AdaptiveLearningService,
    compute_spaced_difficult_words,
)
from app.services.active_weak_words import tokenize_focus_phrase
from app.services.magic_word_quest_service import (
    MagicWordQuestService,
    SAFE_SINGLE_SYLLABLE_DISTRACTORS_VI,
    STARTER_WORDS_BY_GRADE,
    clear_magic_quest_caches,
    is_valid_vietnamese_quest_word,
    sign_magic_quest_claims,
    verify_magic_quest_claims,
)
from app.services.rate_limiter import rate_limiter


def _make_attempt(
    word: str,
    *,
    status: str = "INCORRECT",
    version: int = 1,
    days_ago: int = 0,
    confidence: float = 0.85,
):
    norm = " ".join(tokenize_focus_phrase(word))
    ts = datetime.now(timezone.utc) - timedelta(days=days_ago)
    return SimpleNamespace(
        Id=uuid4(),
        NormalizedWord=norm,
        DisplayText=word,
        AssessmentStatus=status,
        AssessmentVersion=version,
        Confidence=confidence,
        CompletedAt=ts,
        CreatedAt=ts,
    )


class _ExpiringChildStub:
    """Simulates SQLAlchemy ORM expiration after `db.rollback()` (MissingGreenlet guard)."""

    def __init__(self, child_id: UUID, grade: int = 2, alias: str = "Bé Na") -> None:
        self._id = child_id
        self._grade = grade
        self._alias = alias
        self.expired = False

    @property
    def Id(self) -> UUID:
        if self.expired:
            raise RuntimeError("MissingGreenlet: ORM attribute accessed after rollback()")
        return self._id

    @property
    def Grade(self) -> int:
        if self.expired:
            raise RuntimeError("MissingGreenlet: ORM attribute accessed after rollback()")
        return self._grade

    @property
    def Alias(self) -> str:
        if self.expired:
            raise RuntimeError("MissingGreenlet: ORM attribute accessed after rollback()")
        return self._alias

    @property
    def Settings(self) -> dict:
        return {}


class _FakeNestedTx:
    async def __aenter__(self):
        return self

    async def __aexit__(self, exc_type, exc, tb):
        return False


class _RecordingDbSession:
    """In-memory AsyncSession double tracking rollback, commits, and table inserts."""

    def __init__(self, *, duplicate_keys: set[tuple[str, str, str]] | None = None) -> None:
        self.added_rows: list[object] = []
        self.rollback_calls = 0
        self.commit_calls = 0
        self.on_rollback = None
        self._seen_evidence: set[tuple[str, str, str]] = set(duplicate_keys or set())

    async def rollback(self) -> None:
        self.rollback_calls += 1
        if callable(self.on_rollback):
            self.on_rollback()

    def begin_nested(self) -> _FakeNestedTx:
        return _FakeNestedTx()

    def add(self, row: object) -> None:
        self.added_rows.append(row)

    async def flush(self) -> None:
        if not self.added_rows:
            return
        last = self.added_rows[-1]
        key = (
            getattr(last, "SourceModule", ""),
            getattr(last, "SourceRecordId", "") or "",
            getattr(last, "SkillKey", ""),
        )
        if key[1] and key in self._seen_evidence:
            from sqlalchemy.exc import IntegrityError

            self.added_rows.pop()
            raise IntegrityError("duplicate key", params=None, orig=Exception("unique_violation"))
        if key[1]:
            self._seen_evidence.add(key)

    async def commit(self) -> None:
        self.commit_calls += 1


def _build_fake_repo(
    *,
    child: object | None,
    word_attempts: list | None = None,
    db: _RecordingDbSession | None = None,
) -> AdaptiveLearningRepository:
    session = db or _RecordingDbSession()
    repo = AdaptiveLearningRepository(session)  # type: ignore[arg-type]
    repo.get_owned_child = AsyncMock(return_value=child)  # type: ignore[method-assign]
    repo.list_difficult_word_attempts = AsyncMock(return_value=list(word_attempts or []))  # type: ignore[method-assign]
    repo.list_skill_evidence = AsyncMock(return_value=[])  # type: ignore[method-assign]
    repo.list_picture_sessions = AsyncMock(return_value=[])  # type: ignore[method-assign]
    repo.list_shooter_sessions = AsyncMock(return_value=[])  # type: ignore[method-assign]
    repo.list_karaoke_sessions = AsyncMock(return_value=[])  # type: ignore[method-assign]
    repo.list_memory_sessions = AsyncMock(return_value=[])  # type: ignore[method-assign]
    return repo


class MagicWordQuestTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self) -> None:
        clear_magic_quest_caches()
        rate_limiter.reset()

    def tearDown(self) -> None:
        clear_magic_quest_caches()
        rate_limiter.reset()

    async def test_mastered_non_due_words_excluded_from_hub_focus_and_unpin_shooter(self) -> None:
        child_id = uuid4()
        parent_id = uuid4()
        child = SimpleNamespace(Id=child_id, Alias="Bé An", Grade=2, Settings={})
        # AssessmentVersion=1 + CORRECT + days_since=0 (< 3d interval) => mastered & not due!
        mastered_attempt = _make_attempt("lung linh", status="CORRECT", version=1, days_ago=0)
        repo = _build_fake_repo(child=child, word_attempts=[mastered_attempt])
        service = AdaptiveLearningService(repo)

        recs = await service.get_entertainment_recommendations(child_id, parent_id)
        analytics = await service.get_parent_analytics(child_id, parent_id)

        self.assertEqual(len(analytics.practiced_difficult_words), 1)
        self.assertFalse(analytics.practiced_difficult_words[0].is_due)
        self.assertEqual(recs.focus_difficult_words, [])
        # With 0 due focus words and 0 memory sessions, MEMORY_GAME takes priority 1 while SENTENCE_SHOOTER is unpinned
        shooter_rec = next(r for r in recs.recommendations if r.game_key == "SENTENCE_SHOOTER")
        self.assertEqual(shooter_rec.target_words, [])
        self.assertNotEqual(recs.primary_recommendation.game_key, "SENTENCE_SHOOTER")

    def test_due_words_always_sort_ahead_of_high_history_mastered_words(self) -> None:
        # Mastered word with 6 old INCORRECTs + 1 fresh isolated CORRECT today (is_due=False)
        mastered_history = [
            _make_attempt("rực rỡ", status="INCORRECT", version=1, days_ago=5) for _ in range(6)
        ] + [_make_attempt("rực rỡ", status="CORRECT", version=1, days_ago=0)]
        # Unmastered word with only 1 INCORRECT (is_due=True)
        active_due = [_make_attempt("nắng sớm", status="INCORRECT", version=1, days_ago=0)]

        ranked = compute_spaced_difficult_words([*mastered_history, *active_due], limit=8)
        self.assertEqual([w.normalized_word for w in ranked], ["nắng sớm", "rực rỡ"])
        self.assertTrue(ranked[0].is_due)
        self.assertFalse(ranked[1].is_due)

    async def test_generate_quest_rolls_back_db_before_llm_http_call(self) -> None:
        child_id = uuid4()
        parent_id = uuid4()
        events: list[str] = []
        expiring_child = _ExpiringChildStub(child_id, grade=2)
        db = _RecordingDbSession()

        def _expire_on_rollback() -> None:
            events.append("db.rollback")
            expiring_child.expired = True

        db.on_rollback = _expire_on_rollback
        repo = AdaptiveLearningRepository(db)  # type: ignore[arg-type]

        async def _get_child(cid: UUID, pid: UUID):
            events.append("get_owned_child")
            return expiring_child

        async def _list_attempts(cid: UUID, window_days: int = 90):
            events.append("list_difficult_word_attempts")
            return [_make_attempt("lung linh", status="INCORRECT", days_ago=1)]

        repo.get_owned_child = _get_child  # type: ignore[method-assign]
        repo.list_difficult_word_attempts = _list_attempts  # type: ignore[method-assign]

        def _mock_gemini(request: httpx.Request) -> httpx.Response:
            events.append("gemini_http")
            self.assertTrue(expiring_child.expired)
            body = {
                "candidates": [
                    {
                        "content": {
                            "parts": [
                                {
                                    "text": json.dumps(
                                        {
                                            "title_vi": "Cuộn sao lung linh",
                                            "rounds": [
                                                {
                                                    "target_word": "lung linh",
                                                    "sentence_text": "Đèn ông sao tỏa sáng lung linh trên trời.",
                                                    "prompt_hint_vi": "Chọn từ đúng rồi đọc to nhé!",
                                                    "distractors": ["bông hoa", "cơn gió", "chiếc lá"],
                                                },
                                                {
                                                    "target_word": "lung linh",
                                                    "sentence_text": "Mặt hồ đêm thu lấp lánh ánh lung linh.",
                                                    "prompt_hint_vi": "Chọn từ đúng rồi đọc to nhé!",
                                                    "distractors": ["đám mây", "con thuyền", "quả chín"],
                                                },
                                                {
                                                    "target_word": "rực rỡ",
                                                    "sentence_text": "Vườn hoa mùa xuân nở rộ sắc màu rực rỡ.",
                                                    "prompt_hint_vi": "Chọn từ đúng rồi đọc to nhé!",
                                                    "distractors": ["ánh trăng", "ngôi sao", "cánh diều"],
                                                },
                                            ],
                                        },
                                        ensure_ascii=False,
                                    )
                                }
                            ]
                        }
                    }
                ]
            }
            return httpx.Response(200, json=body)

        env = {
            "VIREAD_QUEST_HMAC_SECRET": "unit-test-quest-secret-key-32bytes",
            "GEMINI_API_KEY": "fake-gemini-key",
            "GROQ_API_KEY": "",
        }
        with patch.dict(os.environ, env, clear=False):
            svc = MagicWordQuestService(repo, transport=httpx.MockTransport(_mock_gemini))
            quest = await svc.generate_quest(child_id, parent_id, MagicQuestGenerateRequest())

        self.assertEqual(
            events[:4],
            ["get_owned_child", "list_difficult_word_attempts", "db.rollback", "gemini_http"],
        )
        self.assertEqual(quest.provider_tier, "GEMINI")
        self.assertEqual([r.is_weak_target for r in quest.rounds], [True, True, False])
        self.assertNotEqual(quest.rounds[2].normalized_word, "lung linh")

    def test_hkdf_hmac_signing_fallback_chain_and_tamper_expiry_rejection(self) -> None:
        quest_id = uuid4()
        child_id = uuid4()
        parent_id = uuid4()
        exp = 2_000_000_000
        words = ["lung linh", "rực rỡ"]

        with patch.dict(os.environ, {"VIREAD_QUEST_HMAC_SECRET": "explicit-secret-123"}, clear=False):
            sig_explicit = sign_magic_quest_claims(
                quest_id=quest_id,
                child_id=child_id,
                parent_id=parent_id,
                child_grade=2,
                target_words=words,
                quest_exp=exp,
            )
            verify_magic_quest_claims(
                quest_sig=sig_explicit,
                quest_id=quest_id,
                child_id=child_id,
                parent_id=parent_id,
                child_grade=2,
                target_words=words,
                quest_exp=exp,
                now_ts=exp - 10,
            )

            # Tampered target_words / wrong child_id / wrong parent_id -> 403
            for bad_kwargs in (
                {"target_words": ["lung linh", "khác"]},
                {"child_id": uuid4()},
                {"parent_id": uuid4()},
            ):
                with self.assertRaises(Exception) as ctx:
                    verify_magic_quest_claims(
                        quest_sig=sig_explicit,
                        quest_id=quest_id,
                        child_id=bad_kwargs.get("child_id", child_id),  # type: ignore[arg-type]
                        parent_id=bad_kwargs.get("parent_id", parent_id),  # type: ignore[arg-type]
                        child_grade=2,
                        target_words=bad_kwargs.get("target_words", words),  # type: ignore[arg-type]
                        quest_exp=exp,
                        now_ts=exp - 10,
                    )
                self.assertEqual(getattr(ctx.exception, "status_code", None), 403)
                self.assertNotIn("explicit-secret-123", str(ctx.exception))

            # Expired quest_exp -> 410
            with self.assertRaises(Exception) as exp_ctx:
                verify_magic_quest_claims(
                    quest_sig=sig_explicit,
                    quest_id=quest_id,
                    child_id=child_id,
                    parent_id=parent_id,
                    child_grade=2,
                    target_words=words,
                    quest_exp=exp,
                    now_ts=exp + 1,
                )
            self.assertEqual(getattr(exp_ctx.exception, "status_code", None), 410)

        # Fallback to SUPABASE_ADMIN_KEY / DATABASE_URL when VIREAD_QUEST_HMAC_SECRET is unset
        with (
            patch.dict(os.environ, {"VIREAD_QUEST_HMAC_SECRET": ""}, clear=False),
            patch("app.services.magic_word_quest_service.SUPABASE_ADMIN_KEY", "sb-fallback-admin-key"),
            patch("app.services.magic_word_quest_service.DATABASE_URL", ""),
        ):
            sig_sb = sign_magic_quest_claims(
                quest_id=quest_id,
                child_id=child_id,
                parent_id=parent_id,
                child_grade=2,
                target_words=words,
                quest_exp=exp,
            )
            self.assertEqual(len(sig_sb), 64)
            self.assertNotEqual(sig_sb, sig_explicit)

        with (
            patch.dict(os.environ, {"VIREAD_QUEST_HMAC_SECRET": ""}, clear=False),
            patch("app.services.magic_word_quest_service.SUPABASE_ADMIN_KEY", ""),
            patch("app.services.magic_word_quest_service.DATABASE_URL", "postgresql://postgres:pw@db/viread"),
        ):
            sig_db = sign_magic_quest_claims(
                quest_id=quest_id,
                child_id=child_id,
                parent_id=parent_id,
                child_grade=2,
                target_words=words,
                quest_exp=exp,
            )
            self.assertEqual(len(sig_db), 64)

    async def test_idor_ownership_enforced_on_generate_and_complete(self) -> None:
        parent_a = uuid4()
        parent_b = uuid4()
        child_of_a = uuid4()
        repo_unowned = _build_fake_repo(child=None)
        svc = MagicWordQuestService(repo_unowned)

        with self.assertRaises(Exception) as gen_exc:
            await svc.generate_quest(child_of_a, parent_b, MagicQuestGenerateRequest())
        self.assertEqual(getattr(gen_exc.exception, "status_code", None), 404)

        with patch.dict(os.environ, {"VIREAD_QUEST_HMAC_SECRET": "idor-secret"}, clear=False):
            qid = uuid4()
            exp = 2_000_000_000
            sig = sign_magic_quest_claims(
                quest_id=qid,
                child_id=child_of_a,
                parent_id=parent_a,
                child_grade=2,
                target_words=["lung linh"],
                quest_exp=exp,
            )
            with self.assertRaises(Exception) as comp_exc:
                await svc.complete_quest(
                    child_of_a,
                    parent_b,
                    MagicQuestCompleteRequest(
                        quest_id=qid,
                        quest_exp=exp,
                        quest_sig=sig,
                        target_words=["lung linh"],
                        rounds_completed=3,
                        total_rounds=3,
                        tap_correct_count=3,
                        tap_mistake_count=0,
                        spoken_correct_count=2,
                        stars_earned=3,
                    ),
                )
            self.assertEqual(getattr(comp_exc.exception, "status_code", None), 404)

    async def test_llm_fallback_chain_gemini_to_groq_to_deterministic_template(self) -> None:
        child_id = uuid4()
        parent_id = uuid4()
        child = SimpleNamespace(Id=child_id, Alias="Bé Minh", Grade=1, Settings={})
        attempts = [
            _make_attempt("lung linh", status="INCORRECT", days_ago=1),
            _make_attempt("nắng sớm", status="INCORRECT", days_ago=1),
            _make_attempt("chăm chỉ", status="INCORRECT", days_ago=1),
        ]
        repo = _build_fake_repo(child=child, word_attempts=attempts)

        def _gemini_429_groq_200(request: httpx.Request) -> httpx.Response:
            url = str(request.url)
            if "generativelanguage.googleapis.com" in url:
                return httpx.Response(429, json={"error": {"message": "Quota exceeded"}})
            groq_payload = {
                "title_vi": "Khu vườn nắng sớm",
                "rounds": [
                    {
                        "target_word": "chăm chỉ",
                        "sentence_text": "Chú ong chăm chỉ bay tìm mật.",
                        "prompt_hint_vi": "Chạm từ đúng nhé!",
                        "distractors": ["ánh trăng", "cánh diều", "vườn cây"],
                    },
                    {
                        "target_word": "lung linh",
                        "sentence_text": "Đèn sao sáng lung linh trong đêm.",
                        "prompt_hint_vi": "Chạm từ đúng nhé!",
                        "distractors": ["bông hoa", "cơn gió", "chiếc lá"],
                    },
                    {
                        "target_word": "nắng sớm",
                        "sentence_text": "Giọt nắng sớm ấm áp trên cành.",
                        "prompt_hint_vi": "Chạm từ đúng nhé!",
                        "distractors": ["đám mây", "con thuyền", "quả chín"],
                    },
                ],
            }
            return httpx.Response(
                200,
                json={
                    "choices": [
                        {
                            "message": {
                                "content": f"<think>chọn câu ngắn lớp 1</think>{json.dumps(groq_payload, ensure_ascii=False)}"
                            }
                        }
                    ]
                },
            )

        env = {
            "VIREAD_QUEST_HMAC_SECRET": "chain-test-secret",
            "GEMINI_API_KEY": "fake-gemini",
            "GROQ_API_KEY": "fake-groq",
        }
        with patch.dict(os.environ, env, clear=False):
            svc = MagicWordQuestService(repo, transport=httpx.MockTransport(_gemini_429_groq_200))
            quest_groq = await svc.generate_quest(child_id, parent_id, MagicQuestGenerateRequest(refresh=True))
            self.assertEqual(quest_groq.provider_tier, "GROQ")

            # Both providers fail -> deterministic fallback with Grade-1 6..8 syllable frames
            def _both_fail(request: httpx.Request) -> httpx.Response:
                return httpx.Response(503, json={"error": "unavailable"})

            svc_det = MagicWordQuestService(repo, transport=httpx.MockTransport(_both_fail))
            quest_det = await svc_det.generate_quest(
                child_id,
                parent_id,
                MagicQuestGenerateRequest(focus_words=["thuyền", "biển", "sóng"], refresh=True),
            )
            self.assertEqual(quest_det.provider_tier, "DETERMINISTIC_FALLBACK")
            for r in quest_det.rounds:
                syl_count = len(tokenize_focus_phrase(r.sentence_text))
                self.assertGreaterEqual(syl_count, 6)
                self.assertLessEqual(syl_count, 8)
                non_target_choices = [c.text for c in r.choices if not c.is_target]
                self.assertTrue(all(c in SAFE_SINGLE_SYLLABLE_DISTRACTORS_VI for c in non_target_choices))

    async def test_post_llm_validator_enforces_nfc_tones_grade_bounds_and_child_safety(self) -> None:
        child_id = uuid4()
        parent_id = uuid4()
        child = SimpleNamespace(Id=child_id, Alias="Bé Bo", Grade=1, Settings={})
        repo = _build_fake_repo(child=child, word_attempts=[])

        def _bad_llm_output(request: httpx.Request) -> httpx.Response:
            # Round 1 strips Vietnamese tone ("dieu" instead of "diều"), Round 2 has unsafe word ("ma quỷ"),
            # Round 3 uses minimal-pair Grade-1 distractor ("lung" vs "nung") and URL
            bad_json = {
                "title_vi": "Câu lỗi",
                "rounds": [
                    {
                        "target_word": "diều",
                        "sentence_text": "Em thả cánh dieu bay cao trên đồng.",
                        "prompt_hint_vi": "Đọc to nhé!",
                        "distractors": ["mây", "gió", "hoa"],
                    },
                    {
                        "target_word": "lung",
                        "sentence_text": "Ngôi nhà ma quỷ có chữ lung https://bad.example",
                        "prompt_hint_vi": "Đọc to nhé!",
                        "distractors": ["nung", "lưng", "lùng"],
                    },
                    {
                        "target_word": "sao",
                        "sentence_text": "Quá dài một hai ba bốn năm sáu bảy tám chín mười mười một mười hai sao.",
                        "prompt_hint_vi": "Đọc to nhé!",
                        "distractors": ["mây", "gió", "cá"],
                    },
                ],
            }
            return httpx.Response(
                200,
                json={"candidates": [{"content": {"parts": [{"text": json.dumps(bad_json, ensure_ascii=False)}]}}]},
            )

        env = {
            "VIREAD_QUEST_HMAC_SECRET": "validator-secret",
            "GEMINI_API_KEY": "fake-gemini",
            "GROQ_API_KEY": "",
        }
        with patch.dict(os.environ, env, clear=False):
            svc = MagicWordQuestService(repo, transport=httpx.MockTransport(_bad_llm_output))
            quest = await svc.generate_quest(
                child_id,
                parent_id,
                MagicQuestGenerateRequest(focus_words=["diều", "lung", "sao"], refresh=True),
            )

        self.assertEqual(quest.provider_tier, "DETERMINISTIC_FALLBACK")
        self.assertIn("diều", quest.rounds[0].sentence_text)
        for r in quest.rounds:
            self.assertNotIn("ma quỷ", r.sentence_text.lower())
            self.assertNotIn("http", r.sentence_text.lower())

    async def test_pre_llm_sanitizer_drops_ocr_garbage_and_handles_starter_fallback(self) -> None:
        for bad in ("xqz12", "SGK", "abc\ufffd", "một hai ba bốn", "đồ ngu"):
            self.assertFalse(is_valid_vietnamese_quest_word(bad), f"Expected {bad!r} to be rejected")
        for good in ("nghiêng", "khúc khuỷu", "trường học"):
            self.assertTrue(is_valid_vietnamese_quest_word(good), f"Expected {good!r} to be valid")

        child_id = uuid4()
        parent_id = uuid4()
        child = SimpleNamespace(Id=child_id, Alias="Bé Mầm", Grade=3, Settings={})
        garbage_attempts = [
            _make_attempt("xqz12", status="INCORRECT"),
            _make_attempt("SGK", status="INCORRECT"),
        ]
        repo = _build_fake_repo(child=child, word_attempts=garbage_attempts)
        with patch.dict(
            os.environ,
            {"VIREAD_QUEST_HMAC_SECRET": "starter-secret", "GEMINI_API_KEY": "", "GROQ_API_KEY": ""},
            clear=False,
        ):
            svc = MagicWordQuestService(repo)
            quest = await svc.generate_quest(
                child_id,
                parent_id,
                MagicQuestGenerateRequest(focus_words=["xqz12", "SGK", "\ufffd"]),
            )

        self.assertEqual(quest.source_kind, "STARTER_FALLBACK")
        self.assertEqual(tuple(quest.target_words), STARTER_WORDS_BY_GRADE[3])
        self.assertTrue(all(not r.is_weak_target for r in quest.rounds))

    async def test_60s_dedupe_cache_reuses_llm_output_with_fresh_quest_id_and_rate_limit(self) -> None:
        child_id = uuid4()
        parent_id = uuid4()
        child = SimpleNamespace(Id=child_id, Alias="Bé Sóc", Grade=2, Settings={})
        attempts = [
            _make_attempt("rực rỡ", status="INCORRECT"),
            _make_attempt("trong trẻo", status="INCORRECT"),
            _make_attempt("dịu dàng", status="INCORRECT"),
        ]
        db = _RecordingDbSession()
        repo = _build_fake_repo(child=child, word_attempts=attempts, db=db)
        llm_calls = 0

        def _counting_gemini(request: httpx.Request) -> httpx.Response:
            nonlocal llm_calls
            llm_calls += 1
            payload = {
                "title_vi": " Sắc màu khu vườn ",
                "rounds": [
                    {
                        "target_word": "dịu dàng",
                        "sentence_text": "Làn gió mùa thu thổi dịu dàng qua khung cửa.",
                        "prompt_hint_vi": "Đọc vang nhé!",
                        "distractors": ["ánh trăng", "cánh diều", "ngôi sao"],
                    },
                    {
                        "target_word": "rực rỡ",
                        "sentence_text": "Đàn bướm khoe cánh sắc màu rực rỡ dưới nắng.",
                        "prompt_hint_vi": "Đọc vang nhé!",
                        "distractors": ["bông hoa", "cơn gió", "chiếc lá"],
                    },
                    {
                        "target_word": "trong trẻo",
                        "sentence_text": "Tiếng chim ca hát trong trẻo trên cành cây cao.",
                        "prompt_hint_vi": "Đọc vang nhé!",
                        "distractors": ["đám mây", "con thuyền", "quả chín"],
                    },
                ],
            }
            return httpx.Response(
                200,
                json={"candidates": [{"content": {"parts": [{"text": json.dumps(payload, ensure_ascii=False)}]}}]},
            )

        env = {
            "VIREAD_QUEST_HMAC_SECRET": "dedupe-secret",
            "GEMINI_API_KEY": "fake-gemini",
            "GROQ_API_KEY": "",
        }
        with patch.dict(os.environ, env, clear=False):
            svc = MagicWordQuestService(repo, transport=httpx.MockTransport(_counting_gemini))
            q1 = await svc.generate_quest(child_id, parent_id, MagicQuestGenerateRequest(refresh=False))
            q2 = await svc.generate_quest(child_id, parent_id, MagicQuestGenerateRequest(refresh=False))

            self.assertEqual(llm_calls, 1)
            self.assertNotEqual(q1.quest_id, q2.quest_id)
            verify_magic_quest_claims(
                quest_sig=q2.quest_sig,
                quest_id=q2.quest_id,
                child_id=child_id,
                parent_id=parent_id,
                child_grade=2,
                target_words=q2.target_words,
                quest_exp=q2.quest_exp,
            )

            # Route-level rate limit: 6 allowed in 10 minutes, 7th returns 429 + Retry-After
            app = FastAPI()
            app.include_router(adaptive_router, prefix="/api/v1/adaptive")
            app.dependency_overrides[require_parent_id] = lambda: parent_id
            app.dependency_overrides[get_db] = lambda: db
            with (
                patch(
                    "app.api.routes.adaptive_learning.AdaptiveLearningRepository",
                    return_value=repo,
                ),
                TestClient(app) as client,
            ):
                for _ in range(6):
                    ok_resp = client.post(
                        f"/api/v1/adaptive/children/{child_id}/magic-word-quest",
                        json={"focus_words": [], "refresh": False},
                    )
                    self.assertEqual(ok_resp.status_code, 200)
                    self.assertEqual(ok_resp.headers.get("Cache-Control"), "private, no-store")
                limited = client.post(
                    f"/api/v1/adaptive/children/{child_id}/magic-word-quest",
                    json={"focus_words": [], "refresh": False},
                )
                self.assertEqual(limited.status_code, 429)
                self.assertIn("Retry-After", limited.headers)
                self.assertEqual(limited.json()["detail"]["code"], "RATE_LIMIT_EXCEEDED")

    async def test_complete_quest_idempotent_and_no_mastery_double_count(self) -> None:
        child_id = uuid4()
        parent_id = uuid4()
        child = SimpleNamespace(Id=child_id, Alias="Bé Thỏ", Grade=2, Settings={})
        db = _RecordingDbSession()
        repo = _build_fake_repo(child=child, db=db)

        with patch.dict(
            os.environ,
            {"VIREAD_QUEST_HMAC_SECRET": "complete-secret", "GEMINI_API_KEY": "", "GROQ_API_KEY": ""},
            clear=False,
        ):
            svc = MagicWordQuestService(repo)
            quest = await svc.generate_quest(
                child_id, parent_id, MagicQuestGenerateRequest(focus_words=["lung linh", "nắng sớm"])
            )
            req = MagicQuestCompleteRequest(
                quest_id=quest.quest_id,
                quest_exp=quest.quest_exp,
                quest_sig=quest.quest_sig,
                target_words=quest.target_words,
                rounds_completed=3,
                total_rounds=3,
                tap_correct_count=3,
                tap_mistake_count=1,
                spoken_correct_count=2,
                effort_rescued_count=1,
                used_phonics_hint=True,
                mic_mode="VOICE",
                stars_earned=2,
                duration_seconds=54,
            )
            res1 = await svc.complete_quest(child_id, parent_id, req)
            self.assertFalse(res1.already_recorded)
            self.assertEqual(res1.recorded_evidence_skills, ["sentence_cloze", "phonics_decoding"])
            self.assertNotIn("difficult_word_mastery", res1.recorded_evidence_skills)
            self.assertEqual(len(db.added_rows), 2)
            self.assertTrue(all(getattr(r, "SourceModule", None) == "DIFFICULT_WORD" for r in db.added_rows))
            self.assertTrue(
                all(getattr(r, "SkillKey", None) != "difficult_word_mastery" for r in db.added_rows)
            )

            # Replay 1: hit in-memory idempotency fast path
            res2 = await svc.complete_quest(child_id, parent_id, req)
            self.assertTrue(res2.already_recorded)
            self.assertEqual(len(db.added_rows), 2)

            # Replay 2: even after cache eviction (multi-worker restart), DB unique constraint keeps it idempotent
            clear_magic_quest_caches()
            res3 = await svc.complete_quest(child_id, parent_id, req)
            self.assertTrue(res3.already_recorded)
            self.assertEqual(len(db.added_rows), 2)

    async def test_ephemeral_zero_book_and_zero_tts_cache_pollution(self) -> None:
        child_id = uuid4()
        parent_id = uuid4()
        child = SimpleNamespace(Id=child_id, Alias="Bé Mây", Grade=1, Settings={})
        db = _RecordingDbSession()
        repo = _build_fake_repo(
            child=child,
            word_attempts=[_make_attempt("lung linh", status="INCORRECT", days_ago=1)],
            db=db,
        )

        with patch.dict(
            os.environ,
            {"VIREAD_QUEST_HMAC_SECRET": "ephemeral-secret", "GEMINI_API_KEY": "", "GROQ_API_KEY": ""},
            clear=False,
        ):
            svc = MagicWordQuestService(repo)
            quest = await svc.generate_quest(child_id, parent_id, MagicQuestGenerateRequest())
            self.assertEqual(db.added_rows, [])

            await svc.complete_quest(
                child_id,
                parent_id,
                MagicQuestCompleteRequest(
                    quest_id=quest.quest_id,
                    quest_exp=quest.quest_exp,
                    quest_sig=quest.quest_sig,
                    target_words=quest.target_words,
                    rounds_completed=len(quest.rounds),
                    total_rounds=len(quest.rounds),
                    tap_correct_count=len(quest.rounds),
                    tap_mistake_count=0,
                    spoken_correct_count=0,
                    mic_mode="NO_MIC_FALLBACK",
                    stars_earned=1,
                    duration_seconds=45,
                ),
            )

        forbidden_tables = {
            "books",
            "bookpages",
            "readingsessions",
            "gamesessions",
            "tts_audio_cache_entries",
        }
        inserted_tables = {getattr(row, "__tablename__", "") for row in db.added_rows}
        self.assertEqual(inserted_tables & forbidden_tables, set())
        self.assertEqual(inserted_tables, {"learning_skill_evidence"})
        for row in db.added_rows:
            meta = getattr(row, "MetadataJson", {}) or {}
            # Story sentences must never be persisted into metadata_json
            for round_item in quest.rounds:
                self.assertNotIn(round_item.sentence_text, json.dumps(meta, ensure_ascii=False))


if __name__ == "__main__":
    unittest.main()
