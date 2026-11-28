"""Feature #3 test suite: Regional Phonetic Profile & 30s Ear-Before-Voice Minimal-Pair Trainer.

Compatible with both `pytest` and `python -m unittest`.

Verifies:
1. `GET / PUT /dialect/children/{child_id}/profile`: default `"STRICT_SGK"`, persistence in
   `ChildProfile.Settings["phonetic_profile"]`, and preservation of existing `ChildProfile.Settings` keys.
2. Dual-score alignment (`POST /dialect/children/{child_id}/evaluate-alignment` + `align_text_with_regional_profile`):
   surfaces BOTH `strict_sgk_accuracy` AND `regional_tolerant_accuracy` side-by-side across:
   - `STRICT_SGK`
   - `NORTH_TOLERANT` (`l<->n`, `s<->x`, `tr<->ch`, `r<->d<->gi` including `giếng/diếng`, `gìn/dìn`)
   - `CENTRAL_TOLERANT` (`hoi<->nga`, Zipformer int8 `sac<->nang`, coda `n<->ng`, `t<->c`)
   - `SOUTH_TOLERANT` (onset `v<->d`, tone `hoi<->nga`, coda `n<->ng`, `t<->c`, `n<->nh`)
   while STILL catching real omissions and unrelated substitutions (`true_error_words`)!
3. 30-second "Tai Thính Miệng Xinh" ear-trainer generation (`GET .../ear-trainer-30s`) biasing toward
   child's weak phonics categories + `build_contrastive_vietnamese_keyterms()`, and completion
   (`POST .../ear-trainer-30s/complete`) for both STT-free `CALM_TAP` and `VOICE_ECHO`.
4. `PARENT_PRIVATE` household isolation: cross-parent `403`, missing child `404`, and
   `Cache-Control: private, no-store` on every `/dialect` endpoint.
"""

from __future__ import annotations

import os
from pathlib import Path
import sys
import unittest
from unittest.mock import AsyncMock, patch
from uuid import UUID, uuid4

_BACKEND_DIR = Path(__file__).resolve().parents[1]
if str(_BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(_BACKEND_DIR))

os.environ["APP_ENVIRONMENT"] = "test"
os.environ.setdefault("DATABASE_URL", "postgresql+asyncpg://test:test@127.0.0.1:1/test")
os.environ.setdefault("SUPABASE_URL", "https://example.supabase.co")
os.environ.setdefault("SUPABASE_KEY", "isolated-test-key")
os.environ.setdefault("VIREAD_LOCAL_VOICE_WORKER_AUTOSTART", "false")

from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.api.deps import get_current_parent_id, get_db
from app.api.router import api_router
from app.models import ChildProfile, Profile
from app.services.regional_phonetics_service import (
    evaluate_dual_score_alignment,
    is_regional_phonetic_variant,
)
from app.services.text_alignment import align_text_with_regional_profile
from test_durable_workflows_and_router import FakeStudioAsyncSession, StudioDbState


def _seed_households() -> tuple[StudioDbState, dict[str, UUID]]:
    state = StudioDbState()
    parent_a = uuid4()
    parent_b = uuid4()
    child_a = uuid4()
    child_b = uuid4()

    state.tables[Profile] = [
        Profile(Id=parent_a, Role="parent", DisplayName="Parent A", Active=1),
        Profile(Id=parent_b, Role="parent", DisplayName="Parent B", Active=1),
    ]
    state.tables[ChildProfile] = [
        ChildProfile(
            Id=child_a,
            ParentId=parent_a,
            Alias="Bé An",
            Grade=2,
            Settings={"preferred_voice": "vi_VN-vais1000-medium"},
        ),
        ChildProfile(
            Id=child_b,
            ParentId=parent_b,
            Alias="Bé Bình",
            Grade=3,
            Settings={},
        ),
    ]
    return state, {
        "parent_a": parent_a,
        "parent_b": parent_b,
        "child_a": child_a,
        "child_b": child_b,
    }


def _build_client(
    state: StudioDbState,
    actor_holder: dict[str, UUID],
) -> TestClient:
    app = FastAPI()
    app.include_router(api_router)

    async def _override_db():
        yield FakeStudioAsyncSession(state)

    def _override_parent_id() -> UUID:
        return actor_holder["actor_id"]

    app.dependency_overrides[get_db] = _override_db
    app.dependency_overrides[get_current_parent_id] = _override_parent_id
    return TestClient(app)


class Feat3RegionalPhoneticsTests(unittest.IsolatedAsyncioTestCase):
    def test_profile_get_put_persistence_and_settings_preservation(self) -> None:
        state, ids = _seed_households()
        actor = {"actor_id": ids["parent_a"]}
        client = _build_client(state, actor)

        # 1. Default profile is STRICT_SGK with private no-store header
        res_get = client.get(f"/dialect/children/{ids['child_a']}/profile")
        self.assertEqual(res_get.status_code, 200)
        self.assertEqual(res_get.headers.get("cache-control"), "private, no-store")
        self.assertEqual(res_get.json()["phonetic_profile"], "STRICT_SGK")
        self.assertEqual(res_get.json()["visibility"], "PARENT_PRIVATE")

        # 2. Update to CENTRAL_TOLERANT and verify persistence + preservation of other Settings keys
        res_put = client.put(
            f"/dialect/children/{ids['child_a']}/profile",
            json={"phonetic_profile": "CENTRAL_TOLERANT"},
        )
        self.assertEqual(res_put.status_code, 200)
        self.assertEqual(res_put.headers.get("cache-control"), "private, no-store")
        self.assertEqual(res_put.json()["phonetic_profile"], "CENTRAL_TOLERANT")

        res_after = client.get(f"/dialect/children/{ids['child_a']}/profile")
        self.assertEqual(res_after.status_code, 200)
        self.assertEqual(res_after.json()["phonetic_profile"], "CENTRAL_TOLERANT")

        saved_child = state.tables[ChildProfile][0]
        self.assertEqual(saved_child.Settings["phonetic_profile"], "CENTRAL_TOLERANT")
        self.assertEqual(saved_child.Settings["preferred_voice"], "vi_VN-vais1000-medium")

        # 3. Invalid enum rejected with 422
        res_invalid = client.put(
            f"/dialect/children/{ids['child_a']}/profile",
            json={"phonetic_profile": "UNKNOWN_DIALECT"},
        )
        self.assertEqual(res_invalid.status_code, 422)

    def test_dual_score_alignment_north_central_south_and_true_errors(self) -> None:
        state, ids = _seed_households()
        actor = {"actor_id": ids["parent_a"]}
        client = _build_client(state, actor)

        # --- NORTH_TOLERANT: l/n, s/x, tr/ch, r/d/gi + omitted word + unrelated sub ---
        client.put(
            f"/dialect/children/{ids['child_a']}/profile",
            json={"phonetic_profile": "NORTH_TOLERANT"},
        )
        # Reference has 7 words:
        # - "mùa" (exact)
        # - "lúa" -> "núa" (NORTH l/n)
        # - "sẻ" -> "xẻ" (NORTH s/x)
        # - "bay" -> OMITTED (true error!)
        # - "trên" -> "chên" (NORTH tr/ch)
        # - "rừng" -> "dừng" (NORTH r/d/gi)
        # - "xanh" -> "đỏ" (unrelated substitution -> true error!)
        res_north = client.post(
            f"/dialect/children/{ids['child_a']}/evaluate-alignment",
            json={
                "reference_text": "Mùa lúa sẻ bay trên rừng xanh",
                "spoken_text": "Mùa núa xẻ chên dừng đỏ",
            },
        )
        self.assertEqual(res_north.status_code, 200)
        self.assertEqual(res_north.headers.get("cache-control"), "private, no-store")
        north_data = res_north.json()
        self.assertEqual(north_data["phonetic_profile"], "NORTH_TOLERANT")
        self.assertEqual(north_data["total_reference_words"], 7)
        # Only "mùa" is strict exact (1/7 = 0.1429), while 1 + 4 regional = 5/7 = 0.7143
        self.assertAlmostEqual(north_data["strict_sgk_accuracy"], round(1 / 7, 4))
        self.assertAlmostEqual(north_data["regional_tolerant_accuracy"], round(5 / 7, 4))
        self.assertEqual(len(north_data["regional_variant_matches"]), 4)
        self.assertEqual(north_data["true_error_words"], ["bay", "xanh"])

        # Also check `gi` underlying rhyme cases in NORTH_TOLERANT (`giếng/diếng`, `gìn/dìn`)
        self.assertTrue(is_regional_phonetic_variant("giếng", "diếng", "NORTH_TOLERANT")[0])
        self.assertTrue(is_regional_phonetic_variant("gìn", "dìn", "NORTH_TOLERANT")[0])
        # Northern l/n must NOT be accepted under SOUTH_TOLERANT
        self.assertFalse(is_regional_phonetic_variant("lúa", "núa", "SOUTH_TOLERANT")[0])

        # --- CENTRAL_TOLERANT: hoi/nga, sac/nang (Zipformer int8), coda n/ng, t/c ---
        client.put(
            f"/dialect/children/{ids['child_a']}/profile",
            json={"phonetic_profile": "CENTRAL_TOLERANT"},
        )
        # Reference has 6 words:
        # - "gió" (exact)
        # - "mát" -> "mác" (CENTRAL coda t<->c)
        # - "qua" (exact)
        # - "ngõ" -> "ngỏ" (CENTRAL tone hoi<->nga)
        # - "bán" -> "báng" (CENTRAL coda n<->ng)
        # - "sách" -> "mèo" (unrelated error!)
        res_central = client.post(
            f"/dialect/children/{ids['child_a']}/evaluate-alignment",
            json={
                "reference_text": "Gió mát qua ngõ bán sách",
                "spoken_text": "Gió mác qua ngỏ báng mèo",
            },
        )
        self.assertEqual(res_central.status_code, 200)
        central_data = res_central.json()
        self.assertEqual(central_data["phonetic_profile"], "CENTRAL_TOLERANT")
        self.assertAlmostEqual(central_data["strict_sgk_accuracy"], round(2 / 6, 4))
        self.assertAlmostEqual(central_data["regional_tolerant_accuracy"], round(5 / 6, 4))
        self.assertEqual(central_data["true_error_words"], ["sách"])
        # Ensure false positive like "má" (no coda) vs "mạng" (ng coda) is REJECTED
        self.assertFalse(is_regional_phonetic_variant("má", "mạng", "CENTRAL_TOLERANT")[0])
        # Zipformer int8 sac<->nang with matching onset+nucleus+coda IS accepted
        self.assertTrue(is_regional_phonetic_variant("mát", "mạt", "CENTRAL_TOLERANT")[0])

        # --- SOUTH_TOLERANT: onset v<->d, tone hoi<->nga, coda n<->ng, t<->c, n<->nh ---
        client.put(
            f"/dialect/children/{ids['child_a']}/profile",
            json={"phonetic_profile": "SOUTH_TOLERANT"},
        )
        # Reference has 6 words:
        # - "bé" (exact)
        # - "về" -> "dề" (SOUTH onset v<->d)
        # - "mang" -> "man" (SOUTH coda n<->ng)
        # - "tin" -> "tinh" (SOUTH coda n<->nh)
        # - "cũ" -> "củ" (SOUTH tone hoi<->nga)
        # - "nhà" -> OMITTED (true error!)
        res_south = client.post(
            f"/dialect/children/{ids['child_a']}/evaluate-alignment",
            json={
                "reference_text": "Bé về mang tin cũ nhà",
                "spoken_text": "Bé dề man tinh củ",
            },
        )
        self.assertEqual(res_south.status_code, 200)
        south_data = res_south.json()
        self.assertEqual(south_data["phonetic_profile"], "SOUTH_TOLERANT")
        self.assertAlmostEqual(south_data["strict_sgk_accuracy"], round(1 / 6, 4))
        self.assertAlmostEqual(south_data["regional_tolerant_accuracy"], round(5 / 6, 4))
        self.assertEqual(south_data["true_error_words"], ["nhà"])

        # --- Non-breaking helper in text_alignment.py & STRICT_SGK parity ---
        strict_eval = evaluate_dual_score_alignment(
            "Mùa lúa chín", "Mùa núa chín", "STRICT_SGK"
        )
        self.assertEqual(strict_eval.strict_sgk_accuracy, strict_eval.regional_tolerant_accuracy)
        self.assertEqual(strict_eval.regional_variant_matches, [])
        self.assertEqual(strict_eval.true_error_words, ["lúa"])

        helper_out = align_text_with_regional_profile(
            "Mùa lúa chín", "Mùa núa chín", "NORTH_TOLERANT"
        )
        self.assertAlmostEqual(helper_out["strict_sgk_accuracy"], round(2 / 3, 4))
        self.assertEqual(helper_out["regional_tolerant_accuracy"], 1.0)

    def test_ear_trainer_30s_generation_weak_category_bias_and_completion(self) -> None:
        state, ids = _seed_households()
        actor = {"actor_id": ids["parent_a"]}
        client = _build_client(state, actor)

        client.put(
            f"/dialect/children/{ids['child_a']}/profile",
            json={"phonetic_profile": "CENTRAL_TOLERANT"},
        )

        # Mock active weak words so ear trainer biases toward child's struggled categories (`s_x`, `hoi_nga`)
        with patch(
            "app.services.regional_phonetics_service.list_active_weak_words_for_child",
            new=AsyncMock(return_value=["chim sẻ", "ngõ cũ"]),
        ):
            res_drill = client.get(f"/dialect/children/{ids['child_a']}/ear-trainer-30s")

        self.assertEqual(res_drill.status_code, 200)
        self.assertEqual(res_drill.headers.get("cache-control"), "private, no-store")
        drill = res_drill.json()
        self.assertEqual(drill["phonetic_profile"], "CENTRAL_TOLERANT")
        self.assertEqual(drill["total_rounds"], 3)
        self.assertEqual(drill["duration_seconds"], 30)
        self.assertEqual(len(drill["rounds"]), 3)
        categories = [r["phonics_category"] for r in drill["rounds"]]
        self.assertIn("s_x", categories)
        self.assertIn("hoi_nga", categories)

        for r in drill["rounds"]:
            self.assertIn(r["target_word"], r["options"])
            self.assertIn(r["distractor_word"], r["options"])
            self.assertEqual(len(r["options"]), 2)
            self.assertGreaterEqual(len(r["contrastive_keyterms"]), 2)
            self.assertIn(r["target_word"], r["contrastive_keyterms"])

        # Complete via STT-free Phase A calm tap fallback
        res_calm = client.post(
            f"/dialect/children/{ids['child_a']}/ear-trainer-30s/complete",
            json={
                "rounds_attempted": 3,
                "rounds_correct": 3,
                "phase_b_spoken": False,
                "practiced_words": [r["target_word"] for r in drill["rounds"]],
            },
        )
        self.assertEqual(res_calm.status_code, 200)
        self.assertEqual(res_calm.headers.get("cache-control"), "private, no-store")
        calm_body = res_calm.json()
        self.assertEqual(calm_body["accuracy"], 1.0)
        self.assertEqual(calm_body["completion_mode"], "CALM_TAP")
        self.assertEqual(calm_body["xp_earned"], 30)

        # Complete with optional Phase B spoken echo
        res_voice = client.post(
            f"/dialect/children/{ids['child_a']}/ear-trainer-30s/complete",
            json={
                "rounds_attempted": 3,
                "rounds_correct": 2,
                "phase_b_spoken": True,
            },
        )
        self.assertEqual(res_voice.status_code, 200)
        voice_body = res_voice.json()
        self.assertAlmostEqual(voice_body["accuracy"], round(2 / 3, 4))
        self.assertEqual(voice_body["completion_mode"], "VOICE_ECHO")
        self.assertEqual(voice_body["xp_earned"], 25)

    def test_cross_parent_403_and_missing_child_404_isolation(self) -> None:
        state, ids = _seed_households()
        actor = {"actor_id": ids["parent_a"]}
        client = _build_client(state, actor)

        other_child = ids["child_b"]
        missing_child = uuid4()

        # Parent A attempting to access Parent B's child -> 403 across all endpoints
        self.assertEqual(client.get(f"/dialect/children/{other_child}/profile").status_code, 403)
        self.assertEqual(
            client.put(
                f"/dialect/children/{other_child}/profile",
                json={"phonetic_profile": "NORTH_TOLERANT"},
            ).status_code,
            403,
        )
        self.assertEqual(
            client.post(
                f"/dialect/children/{other_child}/evaluate-alignment",
                json={"reference_text": "lúa chín", "spoken_text": "núa chín"},
            ).status_code,
            403,
        )
        self.assertEqual(
            client.get(f"/dialect/children/{other_child}/ear-trainer-30s").status_code,
            403,
        )
        self.assertEqual(
            client.post(
                f"/dialect/children/{other_child}/ear-trainer-30s/complete",
                json={"rounds_attempted": 3, "rounds_correct": 2, "phase_b_spoken": False},
            ).status_code,
            403,
        )

        # Missing child -> 404
        self.assertEqual(client.get(f"/dialect/children/{missing_child}/profile").status_code, 404)
        self.assertEqual(
            client.get(f"/dialect/children/{missing_child}/ear-trainer-30s").status_code,
            404,
        )


if __name__ == "__main__":
    unittest.main()
