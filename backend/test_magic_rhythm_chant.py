"""Unit & route contract tests for Ephemeral AI Magic Rhythm Chant ('Đồng Dao Phép Thuật 80 BPM')."""

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
from app.schemas.magic_rhythm_chant import (
    MagicRhythmChantCompleteRequest,
    MagicRhythmChantGenerateRequest,
)
from app.services.active_weak_words import tokenize_focus_phrase
from app.services.magic_rhythm_chant_service import (
    MagicRhythmChantService,
    clear_magic_chant_caches,
    sign_magic_chant_claims,
    verify_magic_chant_claims,
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


class _FakeNestedTx:
    async def __aenter__(self):
        return self

    async def __aexit__(self, exc_type, exc, tb):
        return False


class _RecordingDbSession:
    def __init__(self) -> None:
        self.added_rows: list[object] = []
        self.rollback_calls = 0
        self.commit_calls = 0
        self.on_rollback = None
        self._seen_evidence: set[tuple[str, str, str]] = set()

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
    return repo


class MagicRhythmChantTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self) -> None:
        clear_magic_chant_caches()
        rate_limiter.reset()

    def tearDown(self) -> None:
        clear_magic_chant_caches()
        rate_limiter.reset()

    async def test_generate_chant_rolls_back_db_before_llm_http_call(self) -> None:
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
                                            "title_vi": "Đồng dao trăng sáng",
                                            "lines": [
                                                {
                                                    "target_word": "lung linh",
                                                    "line_text": "Đèn ông sao sáng lung linh đêm rằm.",
                                                    "clap_hint_vi": "Vỗ 4 nhịp đều rồi đọc nhé!",
                                                },
                                                {
                                                    "target_word": "lung linh",
                                                    "line_text": "Mặt hồ soi bóng lung linh trăng vàng.",
                                                    "clap_hint_vi": "Vỗ 4 nhịp đều rồi đọc nhé!",
                                                },
                                                {
                                                    "target_word": "rực rỡ",
                                                    "line_text": "Vườn hoa xuân nở rực rỡ nắng mai.",
                                                    "clap_hint_vi": "Vỗ 4 nhịp đều rồi đọc nhé!",
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
            "VIREAD_QUEST_HMAC_SECRET": "chant-rollback-secret",
            "GEMINI_API_KEY": "fake-gemini",
            "GROQ_API_KEY": "",
        }
        with patch.dict(os.environ, env, clear=False):
            svc = MagicRhythmChantService(repo, transport=httpx.MockTransport(_mock_gemini))
            chant = await svc.generate_chant(child_id, parent_id, MagicRhythmChantGenerateRequest())

        self.assertEqual(
            events[:4],
            ["get_owned_child", "list_difficult_word_attempts", "db.rollback", "gemini_http"],
        )
        self.assertEqual(chant.bpm, 80)
        self.assertEqual(chant.provider_tier, "GEMINI")
        self.assertEqual([line.is_weak_target for line in chant.lines], [True, True, False])

    def test_chant_hkdf_hmac_tamper_expiry_and_cross_domain_separation(self) -> None:
        chant_id = uuid4()
        child_id = uuid4()
        parent_id = uuid4()
        exp = 2_000_000_000
        words = ["lung linh", "rực rỡ"]

        with patch.dict(os.environ, {"VIREAD_QUEST_HMAC_SECRET": "chant-hmac-secret"}, clear=False):
            sig = sign_magic_chant_claims(
                chant_id=chant_id,
                child_id=child_id,
                parent_id=parent_id,
                child_grade=3,
                target_words=words,
                chant_exp=exp,
            )
            verify_magic_chant_claims(
                chant_sig=sig,
                chant_id=chant_id,
                child_id=child_id,
                parent_id=parent_id,
                child_grade=3,
                target_words=words,
                chant_exp=exp,
                now_ts=exp - 5,
            )

            # Tampered target_words or child_id -> 403
            for bad_kwargs in (
                {"target_words": ["lung linh", "khác"]},
                {"child_id": uuid4()},
                {"parent_id": uuid4()},
            ):
                with self.assertRaises(Exception) as bad_ctx:
                    verify_magic_chant_claims(
                        chant_sig=sig,
                        chant_id=chant_id,
                        child_id=bad_kwargs.get("child_id", child_id),  # type: ignore[arg-type]
                        parent_id=bad_kwargs.get("parent_id", parent_id),  # type: ignore[arg-type]
                        child_grade=3,
                        target_words=bad_kwargs.get("target_words", words),  # type: ignore[arg-type]
                        chant_exp=exp,
                        now_ts=exp - 5,
                    )
                self.assertEqual(getattr(bad_ctx.exception, "status_code", None), 403)

            # Expired chant_exp -> 410
            with self.assertRaises(Exception) as exp_ctx:
                verify_magic_chant_claims(
                    chant_sig=sig,
                    chant_id=chant_id,
                    child_id=child_id,
                    parent_id=parent_id,
                    child_grade=3,
                    target_words=words,
                    chant_exp=exp,
                    now_ts=exp + 1,
                )
            self.assertEqual(getattr(exp_ctx.exception, "status_code", None), 410)

    async def test_idor_ownership_enforced_on_chant_generate_and_complete(self) -> None:
        parent_a = uuid4()
        parent_b = uuid4()
        child_of_a = uuid4()
        svc = MagicRhythmChantService(_build_fake_repo(child=None))

        with self.assertRaises(Exception) as gen_exc:
            await svc.generate_chant(child_of_a, parent_b, MagicRhythmChantGenerateRequest())
        self.assertEqual(getattr(gen_exc.exception, "status_code", None), 404)

        with patch.dict(os.environ, {"VIREAD_QUEST_HMAC_SECRET": "chant-idor"}, clear=False):
            cid = uuid4()
            exp = 2_000_000_000
            sig = sign_magic_chant_claims(
                chant_id=cid,
                child_id=child_of_a,
                parent_id=parent_a,
                child_grade=2,
                target_words=["lung linh"],
                chant_exp=exp,
            )
            with self.assertRaises(Exception) as comp_exc:
                await svc.complete_chant(
                    child_of_a,
                    parent_b,
                    MagicRhythmChantCompleteRequest(
                        chant_id=cid,
                        chant_exp=exp,
                        chant_sig=sig,
                        target_words=["lung linh"],
                        lines_completed=3,
                        total_lines=3,
                        beat_taps_on_time=10,
                        beat_taps_total=12,
                        spoken_correct_count=2,
                        stars_earned=2,
                    ),
                )
            self.assertEqual(getattr(comp_exc.exception, "status_code", None), 404)

    async def test_llm_fallback_chain_and_grade_syllable_nfc_safety_validation(self) -> None:
        child_id = uuid4()
        parent_id = uuid4()
        child_g1 = SimpleNamespace(Id=child_id, Alias="Bé Bo", Grade=1, Settings={})
        repo = _build_fake_repo(child=child_g1, word_attempts=[])

        def _gemini_429_groq_ok(request: httpx.Request) -> httpx.Response:
            if "generativelanguage.googleapis.com" in str(request.url):
                return httpx.Response(429, json={"error": "quota"})
            groq_json = {
                "title_vi": "Đồng dao nắng sớm",
                "lines": [
                    {
                        "target_word": "chăm chỉ",
                        "line_text": "Chú ong chăm chỉ bay tìm hoa.",
                        "clap_hint_vi": "Vỗ 4 nhịp đều nhé!",
                    },
                    {
                        "target_word": "lung linh",
                        "line_text": "Đèn sao sáng lung linh đêm rằm.",
                        "clap_hint_vi": "Vỗ 4 nhịp đều nhé!",
                    },
                    {
                        "target_word": "nắng sớm",
                        "line_text": "Giọt nắng sớm chiếu ấm sân trường.",
                        "clap_hint_vi": "Vỗ 4 nhịp đều nhé!",
                    },
                ],
            }
            return httpx.Response(
                200,
                json={
                    "choices": [
                        {"message": {"content": f"<think>nhịp 80 bpm</think>{json.dumps(groq_json, ensure_ascii=False)}"}}
                    ]
                },
            )

        env = {
            "VIREAD_QUEST_HMAC_SECRET": "chant-chain",
            "GEMINI_API_KEY": "fake-gemini",
            "GROQ_API_KEY": "fake-groq",
        }
        with patch.dict(os.environ, env, clear=False):
            svc_groq = MagicRhythmChantService(repo, transport=httpx.MockTransport(_gemini_429_groq_ok))
            chant_groq = await svc_groq.generate_chant(
                child_id,
                parent_id,
                MagicRhythmChantGenerateRequest(
                    focus_words=["chăm chỉ", "lung linh", "nắng sớm"], refresh=True
                ),
            )
            self.assertEqual(chant_groq.provider_tier, "GROQ")

            # Tone-stripped / unsafe / wrong-length LLM lines -> rejected to DETERMINISTIC_FALLBACK
            def _unsafe_llm(request: httpx.Request) -> httpx.Response:
                bad = {
                    "title_vi": "Đồng dao lỗi",
                    "lines": [
                        {
                            "target_word": "diều",
                            "line_text": "Cánh dieu bay cao trên đồng xanh.",
                            "clap_hint_vi": "Vỗ tay nhé!",
                        },
                        {
                            "target_word": "sao",
                            "line_text": "Ngôi nhà ma quỷ có ánh sao.",
                            "clap_hint_vi": "Vỗ tay nhé!",
                        },
                        {
                            "target_word": "trăng",
                            "line_text": "Một hai ba bốn năm sáu bảy tám chín mười trăng.",
                            "clap_hint_vi": "Vỗ tay nhé!",
                        },
                    ],
                }
                return httpx.Response(
                    200,
                    json={"candidates": [{"content": {"parts": [{"text": json.dumps(bad, ensure_ascii=False)}]}}]},
                )

            svc_bad = MagicRhythmChantService(repo, transport=httpx.MockTransport(_unsafe_llm))
            chant_det = await svc_bad.generate_chant(
                child_id,
                parent_id,
                MagicRhythmChantGenerateRequest(focus_words=["diều", "sao", "trăng"], refresh=True),
            )
            self.assertEqual(chant_det.provider_tier, "DETERMINISTIC_FALLBACK")
            for line in chant_det.lines:
                syl = len(tokenize_focus_phrase(line.line_text))
                self.assertGreaterEqual(syl, 5)
                self.assertLessEqual(syl, 8)
                self.assertNotIn("ma quỷ", line.line_text.lower())

        # Grade 4 starter fallback produces 4 lines within 7..12 syllables
        child_g4 = SimpleNamespace(Id=child_id, Alias="Bé Lớn", Grade=4, Settings={})
        repo_g4 = _build_fake_repo(child=child_g4, word_attempts=[_make_attempt("xqz12")])
        with patch.dict(
            os.environ,
            {"VIREAD_QUEST_HMAC_SECRET": "chant-g4", "GEMINI_API_KEY": "", "GROQ_API_KEY": ""},
            clear=False,
        ):
            chant_g4 = await MagicRhythmChantService(repo_g4).generate_chant(
                child_id, parent_id, MagicRhythmChantGenerateRequest()
            )
            self.assertEqual(chant_g4.source_kind, "STARTER_FALLBACK")
            self.assertEqual(len(chant_g4.lines), 4)
            self.assertTrue(all(not line.is_weak_target for line in chant_g4.lines))
            for line in chant_g4.lines:
                syl = len(tokenize_focus_phrase(line.line_text))
                self.assertGreaterEqual(syl, 7)
                self.assertLessEqual(syl, 12)

    async def test_60s_dedupe_route_rate_limit_and_idempotent_rhythm_lyric_evidence(self) -> None:
        child_id = uuid4()
        parent_id = uuid4()
        child = SimpleNamespace(Id=child_id, Alias="Bé Ca", Grade=2, Settings={})
        db = _RecordingDbSession()
        repo = _build_fake_repo(
            child=child,
            word_attempts=[
                _make_attempt("dịu dàng"),
                _make_attempt("rực rỡ"),
                _make_attempt("trong trẻo"),
            ],
            db=db,
        )
        llm_calls = 0

        def _counting_gemini(request: httpx.Request) -> httpx.Response:
            nonlocal llm_calls
            llm_calls += 1
            payload = {
                "title_vi": "Khúc đồng dao vườn xuân",
                "lines": [
                    {
                        "target_word": "dịu dàng",
                        "line_text": "Gió mùa thu thổi dịu dàng qua sân.",
                        "clap_hint_vi": "Vỗ 4 nhịp đều nhé!",
                    },
                    {
                        "target_word": "rực rỡ",
                        "line_text": "Đàn bướm khoe cánh rực rỡ nắng vàng.",
                        "clap_hint_vi": "Vỗ 4 nhịp đều nhé!",
                    },
                    {
                        "target_word": "trong trẻo",
                        "line_text": "Tiếng chim ca hát trong trẻo trên cành.",
                        "clap_hint_vi": "Vỗ 4 nhịp đều nhé!",
                    },
                ],
            }
            return httpx.Response(
                200,
                json={"candidates": [{"content": {"parts": [{"text": json.dumps(payload, ensure_ascii=False)}]}}]},
            )

        env = {
            "VIREAD_QUEST_HMAC_SECRET": "chant-dedupe-secret",
            "GEMINI_API_KEY": "fake-gemini",
            "GROQ_API_KEY": "",
        }
        with patch.dict(os.environ, env, clear=False):
            svc = MagicRhythmChantService(repo, transport=httpx.MockTransport(_counting_gemini))
            c1 = await svc.generate_chant(child_id, parent_id, MagicRhythmChantGenerateRequest(refresh=False))
            c2 = await svc.generate_chant(child_id, parent_id, MagicRhythmChantGenerateRequest(refresh=False))
            self.assertEqual(llm_calls, 1)
            self.assertNotEqual(c1.chant_id, c2.chant_id)

            # Complete chant -> writes rhythm_timing + lyric_delivery ONLY (zero karaoke_songs / mastery double count)
            complete_req = MagicRhythmChantCompleteRequest(
                chant_id=c1.chant_id,
                chant_exp=c1.chant_exp,
                chant_sig=c1.chant_sig,
                target_words=c1.target_words,
                lines_completed=3,
                total_lines=3,
                beat_taps_on_time=11,
                beat_taps_total=12,
                spoken_correct_count=2,
                effort_rescued_count=1,
                used_phonics_hint=True,
                mic_mode="VOICE",
                stars_earned=3,
                duration_seconds=58,
            )
            res1 = await svc.complete_chant(child_id, parent_id, complete_req)
            self.assertFalse(res1.already_recorded)
            self.assertEqual(res1.recorded_evidence_skills, ["rhythm_timing", "lyric_delivery"])
            self.assertEqual(len(db.added_rows), 2)

            forbidden_tables = {
                "karaoke_songs",
                "karaoke_practice_sessions",
                "books",
                "bookpages",
                "tts_audio_cache_entries",
            }
            inserted_tables = {getattr(row, "__tablename__", "") for row in db.added_rows}
            self.assertEqual(inserted_tables & forbidden_tables, set())
            self.assertEqual(inserted_tables, {"learning_skill_evidence"})
            for row in db.added_rows:
                self.assertNotEqual(getattr(row, "SkillKey", ""), "difficult_word_mastery")
                meta_str = json.dumps(getattr(row, "MetadataJson", {}) or {}, ensure_ascii=False)
                for line in c1.lines:
                    self.assertNotIn(line.line_text, meta_str)

            # Replay both via cache and after cache clear -> idempotent
            res2 = await svc.complete_chant(child_id, parent_id, complete_req)
            self.assertTrue(res2.already_recorded)
            clear_magic_chant_caches()
            res3 = await svc.complete_chant(child_id, parent_id, complete_req)
            self.assertTrue(res3.already_recorded)
            self.assertEqual(len(db.added_rows), 2)

            # Route contract + Cache-Control + sliding-window 429 rate limit
            app = FastAPI()
            app.include_router(adaptive_router, prefix="/learning")
            app.dependency_overrides[require_parent_id] = lambda: parent_id
            app.dependency_overrides[get_db] = lambda: db
            with (
                patch(
                    "app.api.routes.adaptive_learning.AdaptiveLearningRepository",
                    return_value=repo,
                ),
                patch.dict(os.environ, {"GEMINI_API_KEY": "", "GROQ_API_KEY": ""}, clear=False),
                TestClient(app) as client,
            ):
                for _ in range(6):
                    ok_resp = client.post(
                        f"/learning/children/{child_id}/magic-rhythm-chant",
                        json={"focus_words": [], "refresh": False},
                    )
                    self.assertEqual(ok_resp.status_code, 200)
                    self.assertEqual(ok_resp.headers.get("Cache-Control"), "private, no-store")
                throttled = client.post(
                    f"/learning/children/{child_id}/magic-rhythm-chant",
                    json={"focus_words": [], "refresh": False},
                )
                self.assertEqual(throttled.status_code, 429)
                self.assertIn("Retry-After", throttled.headers)


if __name__ == "__main__":
    unittest.main()
