"""Three-color contract: GREEN/RED/YELLOW hard assertions, mixed pages,
persistence through the API serializer and the 16 classification invariants.

Every scenario states its ground truth, the OCR output, the engine outputs,
the reference provenance, the expected color and the reason. Ground truth is
authored text; nothing here derives the expected answer from OCR output.
"""
from __future__ import annotations

import copy
import json
import random
import unicodedata
import unittest
from datetime import datetime, timezone
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock
from uuid import UUID

from ocr_color_testkit import (
    GREEN_WORDS,
    MANDATORY_GREEN_WORDS,
    MANDATORY_RED_PAIRS,
    RED_PAIRS,
    classify_page,
    classify_word,
    completed_crop,
    corrupt,
    counts,
    engine_word,
)

from app.services.admin_ocr_service import AdminOcrService, classify_word_evidence
from app.services.ocr_engine import normalize_word

ACTOR = UUID("11111111-1111-4111-8111-111111111111")
PAGE_ID = UUID("33333333-3333-4333-8333-333333333333")
CREATED_AT = datetime(2026, 11, 10, tzinfo=timezone.utc)
LEFT, RIGHT = "một", "hai"  # neighbours that never collide with the vocabulary


def _row(index: int, text: str) -> SimpleNamespace:
    return SimpleNamespace(
        WordIndex=index,
        LineIndex=index // 20,
        Text=text,
        NormalizedText=normalize_word(text),
        BoundingBox=[0.01 + (index % 20) * 0.045, 0.02 + (index // 20) * 0.06, 0.04, 0.04],
        OCRConfidence=None,
    )


def _persisted_metadata(words: list[dict[str, object]]) -> dict[str, object]:
    """ProcessingMeta exactly as stored, including the JSONB round trip."""
    metadata = {
        "word_review_statuses": [str(word["ocr_review_status"]) for word in words],
        "word_evidence_v2": [
            AdminOcrService._normalize_word_evidence(word.get("ocr_evidence"))
            for word in words
        ],
        "word_evidence_v2_authoritative": True,
    }
    return json.loads(json.dumps(metadata, ensure_ascii=False))


async def api_words(
    words: list[dict[str, object]],
    *,
    page_status: str = "NEEDS_REVIEW",
    revision_id: str = "44444444-4444-4444-8444-444444444444",
) -> list[dict[str, object]]:
    """Persist, reload and serialize a revision; return the JSON API words."""
    service = AdminOcrService(MagicMock())
    service.repo.words = AsyncMock(
        return_value=[_row(index, str(word["text"])) for index, word in enumerate(words)]
    )
    text = " ".join(str(word["text"]) for word in words)
    revision = SimpleNamespace(
        Id=UUID(revision_id),
        PageId=PAGE_ID,
        RevisionNo="1",
        VerificationStatus=page_status,
        DraftText=text,
        VerifiedText=text if page_status == "VERIFIED" else None,
        ProcessingMeta=_persisted_metadata(words),
        CreatedAt=CREATED_AT,
        VerifiedAt=CREATED_AT if page_status == "VERIFIED" else None,
        VerifiedBy=ACTOR if page_status == "VERIFIED" else None,
    )
    detail = await service.revision_detail(
        SimpleNamespace(Id=PAGE_ID, LifecycleStatus="ACTIVE"), revision
    )
    return json.loads(detail.model_dump_json())["words"]


def _target_page(target: dict[str, object], truth: str, **neighbour_overrides):
    """[left, target, right] with reference "một <truth> hai"."""
    left = neighbour_overrides.get("left", engine_word(LEFT, token_index=0))
    right = neighbour_overrides.get("right", engine_word(RIGHT, token_index=2))
    extra = neighbour_overrides.get("extra", [])
    return [left, target, right, *extra], f"{LEFT} {truth} {RIGHT}"


# --- GROUP A: GREEN -------------------------------------------------------
def _green_variants(word: str):
    wrong = corrupt(word, "all_marks_dropped") or word + "x"
    yield "exact_match", "OCR token equals the verified reference", _target_page(
        engine_word(word, token_index=1), word)
    yield "other_engine_wrong", "another engine misread, selected candidate is right", _target_page(
        engine_word(word, paddle=wrong, vietocr=word, selected="vietocr", token_index=1), word)
    yield "raw_score_low", "raw score cannot overrule ground truth", _target_page(
        engine_word(word, ocr_confidence=0.01, token_index=1,
                    paddle=wrong, crop_evidence=completed_crop(
                        wrong, word, paddle_crop_recognition_score=0.01,
                        vietocr_crop_recognition_score=0.02)), word)
    yield "engine_not_run", "one engine did not run", _target_page(
        engine_word(word, vietocr=None, selected="paddleocr", token_index=1, statuses={
            "paddleocr": "success", "vietocr": "not_run", "tesseract": "not_run"}), word)
    yield "engine_empty_result", "one engine returned nothing", _target_page(
        engine_word(word, vietocr="", selected="paddleocr", token_index=1, statuses={
            "paddleocr": "success", "vietocr": "no_result", "tesseract": "not_run"}), word)
    yield "tesseract_unavailable", "Tesseract is not installed", _target_page(
        engine_word(word, token_index=1, statuses={
            "paddleocr": "success", "vietocr": "success", "tesseract": "not_installed"}), word)
    yield "neighbour_red", "another token on the page is RED", _target_page(
        engine_word(word, token_index=1), word, left=engine_word("mốt", token_index=0))
    yield "neighbour_yellow", "another token on the page is YELLOW", _target_page(
        engine_word(word, token_index=1), word,
        extra=[engine_word("zzq", token_index=3)])
    yield "neighbour_crop_failed", "another token's crop failed", _target_page(
        engine_word(word, token_index=1), word, left=engine_word(
            LEFT, paddle="mot", bbox_quality="rejected", crop_quality="unavailable",
            crop_evidence={"status": "skipped", "reason": "invalid_bbox"}))
    missing = engine_word(LEFT)
    missing["ocr_evidence"] = None
    yield "neighbour_metadata_missing", "another token has no evidence at all", _target_page(
        engine_word(word, token_index=1), word, left=missing)


class GreenHardAssertions(unittest.IsolatedAsyncioTestCase):
    def test_vocabulary_is_large_and_contains_the_mandatory_words(self):
        self.assertGreaterEqual(len(GREEN_WORDS), 125)
        self.assertEqual(GREEN_WORDS[:25], MANDATORY_GREEN_WORDS)

    async def test_verified_exact_match_is_green_in_every_variant(self):
        checked = 0
        for word in GREEN_WORDS:
            for variant, reason, (words, reference) in _green_variants(word):
                with self.subTest(ground_truth=word, ocr_output=word, variant=variant, reason=reason):
                    colors = classify_page(words, reference)
                    self.assertEqual(colors[1], "green")
                    for page_status in ("NEEDS_REVIEW", "VERIFIED"):
                        served = await api_words(words, page_status=page_status)
                        self.assertEqual(served[1]["review_color_group"], "green")
                    checked += 1
        self.assertGreaterEqual(checked, 1250)

    def test_unicode_nfd_reference_matches_nfc_ocr_output(self):
        for word in GREEN_WORDS:
            with self.subTest(word=word):
                reference = unicodedata.normalize("NFD", f"{LEFT} {word} {RIGHT}")
                words, _ = _target_page(engine_word(word, token_index=1), word)
                self.assertEqual(classify_page(words, reference)[1], "green")

    def test_case_and_outer_punctuation_do_not_break_a_match(self):
        for word in MANDATORY_GREEN_WORDS:
            for surface in (word.lower(), word.capitalize(), f"{word},", f'"{word}"', f"{word}."):
                with self.subTest(ground_truth=word, ocr_output=surface):
                    words, reference = _target_page(engine_word(surface, token_index=1), word)
                    self.assertEqual(classify_page(words, reference)[1], "green")


# --- GROUP B: RED ---------------------------------------------------------
def _red_variants(truth: str, wrong: str):
    yield "selected_wrong", "stored token differs from the verified reference", _target_page(
        engine_word(wrong, token_index=1), truth)
    yield "other_engine_right", "an engine read it right but the stored token is wrong", _target_page(
        engine_word(wrong, paddle=truth, vietocr=wrong, selected="vietocr", token_index=1), truth)
    yield "engines_agree_on_wrong", "engine consensus cannot overrule ground truth", _target_page(
        engine_word(wrong, paddle=wrong, vietocr=wrong, token_index=1,
                    crop_evidence=completed_crop(wrong, wrong, wrong)), truth)
    yield "crop_says_right", "crop engines read the truth, stored token is still wrong", _target_page(
        engine_word(wrong, paddle=wrong, vietocr=truth, selected="paddleocr", token_index=1,
                    crop_evidence=completed_crop(truth, truth)), truth)
    yield "engine_not_run", "an engine did not run", _target_page(
        engine_word(wrong, vietocr=None, selected="paddleocr", token_index=1, statuses={
            "paddleocr": "success", "vietocr": "not_run", "tesseract": "not_run"}), truth)
    yield "crop_quality_changed", "crop quality changed", _target_page(
        engine_word(wrong, token_index=1, crop_quality="weak", bbox_quality="rejected",
                    crop_evidence={"status": "skipped", "reason": "insufficient_visual_signal"}), truth)
    yield "retry_failed", "an inference retry failed", _target_page(
        engine_word(wrong, paddle=truth, token_index=1, crop_evidence={
            "status": "partial", "vietocr_error": "RuntimeError"}), truth)
    yield "high_confidence", "a high raw score cannot make it green", _target_page(
        engine_word(wrong, ocr_confidence=0.999, token_index=1), truth)
    yield "low_confidence", "a low raw score cannot make it yellow", _target_page(
        engine_word(wrong, ocr_confidence=0.001, token_index=1), truth)


class RedHardAssertions(unittest.IsolatedAsyncioTestCase):
    def test_pair_table_is_large_and_contains_the_mandatory_pairs(self):
        self.assertGreaterEqual(len(RED_PAIRS), 120)
        self.assertEqual([(t, w) for t, w, _ in RED_PAIRS[:20]], MANDATORY_RED_PAIRS)
        categories = {category for _, _, category in RED_PAIRS}
        self.assertGreaterEqual(len(categories), 10)
        for truth, wrong, _ in RED_PAIRS:
            self.assertNotEqual(normalize_word(truth), normalize_word(wrong))

    async def test_verified_mismatch_is_red_in_every_variant_and_layer(self):
        checked = 0
        for truth, wrong, category in RED_PAIRS:
            for variant, reason, (words, reference) in _red_variants(truth, wrong):
                with self.subTest(ground_truth=truth, ocr_output=wrong, category=category,
                                  variant=variant, reason=reason):
                    # Backend classification.
                    self.assertEqual(classify_page(words, reference)[1], "red")
                    self.assertEqual(words[1]["ocr_review_status"], "confirmed_mismatch")
                    evidence = words[1]["ocr_evidence"]
                    # Stored provenance explains the verdict.
                    self.assertEqual(evidence["verification_source"], "verified_revision")
                    self.assertEqual(normalize_word(evidence["reference_text"]), normalize_word(truth))
                    self.assertEqual(evidence["reference_alignment"], "substitute")
                    self.assertTrue(evidence["review_reason"])
                    # Persisted -> reloaded -> serialized, for either page status.
                    for page_status in ("NEEDS_REVIEW", "VERIFIED"):
                        served = await api_words(words, page_status=page_status)
                        self.assertEqual(served[1]["review_color_group"], "red")
                        self.assertEqual(served[1]["ocr_review_status"], "confirmed_mismatch")
                        self.assertEqual(served[1]["text"], unicodedata.normalize("NFC", wrong))
                        self.assertEqual(
                            normalize_word(served[1]["ocr_evidence"]["reference_text"]),
                            normalize_word(truth),
                        )
                        # A second reload is identical (no cache/default drift).
                        again = await api_words(words, page_status=page_status)
                        self.assertEqual(again, served)
                    checked += 1
        self.assertGreaterEqual(checked, 1080)

    def test_stale_word_status_never_downgrades_red(self):
        for truth, wrong, _ in RED_PAIRS:
            words, reference = _target_page(engine_word(wrong, token_index=1), truth)
            classify_page(words, reference)
            for stale in ("verified", "engine_agreement", "needs_review", "reference_match",
                          "engine_disagreement", "matched", "suspect", "not-a-status"):
                with self.subTest(ground_truth=truth, ocr_output=wrong, stale_status=stale):
                    word = copy.deepcopy(words[1])
                    word["ocr_review_status"] = stale
                    self.assertEqual(classify_word(word), "red")

    def test_badly_misread_word_between_matching_neighbours_is_red(self):
        # No character in common: the aligner alone would call this delete+insert.
        for truth in MANDATORY_GREEN_WORDS:
            with self.subTest(ground_truth=truth, ocr_output="qwxz"):
                words, reference = _target_page(engine_word("qwxz", token_index=1), truth)
                self.assertEqual(classify_page(words, reference), ["green", "red", "green"])

    async def test_red_does_not_leak_into_another_revision(self):
        truth, wrong = "BỮA", "BỪA"
        words, reference = _target_page(engine_word(wrong, token_index=1), truth)
        classify_page(words, reference)
        red_revision = await api_words(words, revision_id="44444444-4444-4444-8444-444444444444")
        # A new OCR revision of the same page has its own evidence only.
        fresh, _ = _target_page(engine_word(truth, token_index=1), truth)
        other_revision = await api_words(fresh, revision_id="55555555-5555-4555-8555-555555555555")
        self.assertEqual(red_revision[1]["review_color_group"], "red")
        self.assertEqual(other_revision[1]["review_color_group"], "green")
        self.assertIsNone(other_revision[1]["ocr_evidence"]["reference_text"])

    def test_reference_reverified_by_admin_gets_new_provenance_and_keeps_history(self):
        truth, wrong = "SÁNG", "SANG"
        words, reference = _target_page(engine_word(wrong, token_index=1), truth)
        classify_page(words, reference)
        evidence = dict(words[1]["ocr_evidence"])
        # Admin now verifies the page with the OCR token as the new reference.
        evidence.update({"verification_source": "admin", "reference_text": wrong,
                         "reference_alignment": "match"})
        self.assertEqual(classify_word_evidence("verified", evidence, wrong), "green")
        self.assertEqual(evidence["source_text"], wrong)  # OCR history intact
        self.assertEqual(evidence["engine_outputs"]["vietocr"], wrong)


# --- GROUP C: YELLOW ------------------------------------------------------
def _yellow_cases():
    yield "Y01 no reference, single engine candidate", [engine_word(
        "SÁNG", vietocr=None, selected="paddleocr", statuses={
            "paddleocr": "success", "vietocr": "not_run", "tesseract": "not_run"})], None, 0
    yield "Y02 engines disagree, nothing verified", [engine_word(
        "SÁNG", paddle="SANG")], None, 0
    yield "Y03 crop lost the diacritic", [engine_word(
        "SÁNG", paddle="SANG", crop_evidence=completed_crop("SANG", "SANG"))], None, 0
    yield "Y04 bounding box invalid", [engine_word(
        "SÁNG", bbox_quality="rejected", crop_quality="unavailable",
        crop_evidence={"status": "skipped", "reason": "invalid_bbox"})], None, 0
    yield "Y05 token mapping unclear (split/merge)", [engine_word(
        "BỮASÁNG", paddle=None, alignment="merge")], None, 0
    yield "Y06 several equally good alignments", [engine_word("ba")], "bà bà", 0
    yield "Y07 all three engines failed", [engine_word(
        "SÁNG", paddle=None, vietocr=None, selected="tesseract", statuses={
            "paddleocr": "error", "vietocr": "error", "tesseract": "error"})], None, 0
    no_evidence = engine_word("SÁNG")
    no_evidence["ocr_evidence"] = None
    yield "Y08 no valid candidate stored", [no_evidence], None, 0
    yield "Y09 image too blurry to read the crop", [engine_word(
        "SÁNG", paddle="SANG", crop_quality="weak",
        crop_evidence={"status": "skipped", "reason": "insufficient_visual_signal"})], None, 0
    yield "Y10 diacritic cannot be told apart on the image", [engine_word(
        "SÁNG", paddle="SANG", crop_evidence=completed_crop("SANG", "SÁNG", "SẢNG"))], None, 0
    yield "Y11 crop and line recognition contradict", [engine_word(
        "SÁNG", paddle="SANG", crop_evidence=completed_crop("SANG", "SẢNG", "SẢNG"))], None, 0
    uncalibrated = engine_word("SÁNG", paddle="SANG", ocr_confidence=0.99)
    uncalibrated["ocr_evidence"]["calibrated_word_accuracy"] = 0.99
    yield "Y12 no compatible calibration and weak evidence", [uncalibrated], None, 0
    unsourced = engine_word("SÁNG", paddle="SANG")
    unsourced["ocr_evidence"].update({"reference_text": "SÁNG", "reference_alignment": "match"})
    yield "Y13 reference without provenance", [unsourced], None, 0
    foreign = engine_word("SÁNG", paddle="SANG")
    foreign["ocr_evidence"].update({"reference_text": "SÁNG", "reference_alignment": "match",
                                    "verification_source": "another_revision"})
    yield "Y14 reference belongs to another revision", [foreign], None, 0
    yield "Y15 token cannot be paired one-to-one with the reference", [
        engine_word(LEFT), engine_word("zzq"), engine_word(RIGHT)], f"{LEFT} {RIGHT}", 1


class YellowHardAssertions(unittest.IsolatedAsyncioTestCase):
    async def test_only_genuinely_undecidable_tokens_are_yellow(self):
        seen = 0
        for name, words, reference, index in _yellow_cases():
            with self.subTest(case=name):
                self.assertEqual(classify_page(words, reference)[index], "yellow")
                served = await api_words(words)
                self.assertEqual(served[index]["review_color_group"], "yellow")
                seen += 1
        self.assertEqual(seen, 15)

    def test_available_evidence_is_used_before_settling_on_yellow(self):
        # Same disagreement as Y02, but the crop readings settle it.
        resolved = engine_word("SÁNG", paddle="SANG", crop_evidence=completed_crop("SÁNG", "SÁNG"))
        self.assertEqual(classify_word(resolved), "green")
        # Same disagreement, a verified reference settles it either way.
        self.assertEqual(classify_page([engine_word("SÁNG", paddle="SANG")], "SÁNG"), ["green"])
        self.assertEqual(classify_page([engine_word("SANG", vietocr="SANG", paddle="SÁNG",
                                                    selected="vietocr")], "SÁNG"), ["red"])

    def test_substitution_next_to_a_gap_is_ambiguous_not_red(self):
        words = [engine_word("sư"), engine_word("on"), engine_word("cửa")]
        self.assertEqual(classify_page(words, "sư ơn"), ["green", "yellow", "yellow"])
        self.assertEqual(words[1]["ocr_evidence"]["reference_alignment"], "ambiguous")
        self.assertEqual(words[1]["ocr_review_status"], "needs_review")


# --- Mixed pages ----------------------------------------------------------
def build_page(states: list[str], rng: random.Random):
    """states: C (correct), W (wrong), U (extra OCR token with no reference)."""
    vocabulary = rng.sample(GREEN_WORDS, len(states))
    words: list[dict[str, object]] = []
    reference: list[str] = []
    for index, (state, truth) in enumerate(zip(states, vocabulary)):
        if state == "U":
            words.append(engine_word(f"zq{index}x", token_index=index))
            continue
        reference.append(truth)
        if state == "C":
            # Every third correct token carries an engine disagreement that
            # the reference overrules.
            noisy = corrupt(truth, "all_marks_dropped") if index % 3 == 0 else None
            words.append(engine_word(truth, paddle=noisy or truth, token_index=index))
        else:
            wrong = next(
                candidate for category in ("tone_dropped", "all_marks_dropped",
                                           "last_char_missing", "extra_char", "wrong_first_char")
                if (candidate := corrupt(truth, category)) is not None
            )
            words.append(engine_word(wrong, token_index=index))
    return words, " ".join(reference)


def _spaced_states(correct: int, wrong: int, unknown: int, rng: random.Random) -> list[str]:
    """Shuffle, keeping W and U apart (a gap beside a mismatch is ambiguous)."""
    for _ in range(2000):
        states = ["C"] * correct + ["W"] * wrong + ["U"] * unknown
        rng.shuffle(states)
        if all(
            not ({states[i], states[i + 1]} == {"W", "U"})
            for i in range(len(states) - 1)
        ):
            return states
    raise AssertionError("could not build a non-adjacent layout")


EXPECTED_COLOR = {"C": "green", "W": "red", "U": "yellow"}


class MixedPageScenarios(unittest.IsolatedAsyncioTestCase):
    async def _assert_page(self, states: list[str], rng: random.Random, page_status="NEEDS_REVIEW"):
        words, reference = build_page(states, rng)
        colors = classify_page(words, reference)
        self.assertEqual(colors, [EXPECTED_COLOR[state] for state in states])
        served = await api_words(words, page_status=page_status)
        self.assertEqual([word["review_color_group"] for word in served], colors)
        return counts(colors)

    async def test_scenario_01_fully_correct_page_of_100_words(self):
        result = await self._assert_page(["C"] * 100, random.Random(1))
        self.assertEqual(result, {"green": 100, "red": 0, "yellow": 0})

    async def test_scenario_02_one_wrong_word_among_correct_ones(self):
        result = await self._assert_page(list("CCCWCC"), random.Random(2))
        self.assertEqual(result, {"green": 5, "red": 1, "yellow": 0})

    async def test_scenario_03_one_uncertain_word_among_correct_ones(self):
        result = await self._assert_page(list("CCUCC"), random.Random(3))
        self.assertEqual(result, {"green": 4, "red": 0, "yellow": 1})

    async def test_scenario_04_all_three_colors(self):
        result = await self._assert_page(list("CCWCUCWC"), random.Random(4))
        self.assertEqual(result, {"green": 5, "red": 2, "yellow": 1})

    async def test_scenario_05_needs_review_page_keeps_word_colors(self):
        rng = random.Random(5)
        result = await self._assert_page(_spaced_states(85, 5, 10, rng), rng, "NEEDS_REVIEW")
        self.assertEqual(result, {"green": 85, "red": 5, "yellow": 10})

    async def test_scenario_06_verified_page_keeps_word_colors(self):
        rng = random.Random(6)
        result = await self._assert_page(_spaced_states(17, 2, 1, rng), rng, "VERIFIED")
        self.assertEqual(result, {"green": 17, "red": 2, "yellow": 1})

    async def test_scenario_07_local_engine_disagreement(self):
        rng = random.Random(7)
        states = _spaced_states(95, 0, 5, rng)
        words, reference = build_page(states, rng)
        disagreeing = sum(
            1 for word, state in zip(words, states)
            if state == "C" and word["ocr_evidence"]["alignment"] == "substitute"
        )
        self.assertGreaterEqual(disagreeing, 5)
        self.assertEqual(counts(classify_page(words, reference)),
                         {"green": 95, "red": 0, "yellow": 5})

    def test_scenario_08_engine_consensus_on_a_wrong_token(self):
        word = engine_word("BỪA", paddle="BỪA", vietocr="BỮA", selected="paddleocr",
                           crop_evidence=completed_crop("BỮA", "BỮA", "BỮA"))
        self.assertEqual(classify_page([word], "BỮA"), ["red"])
        agreed = engine_word("BỪA", crop_evidence=completed_crop("BỪA", "BỪA", "BỪA"))
        self.assertEqual(classify_page([agreed], "BỮA"), ["red"])

    def test_scenario_09_wrong_candidate_selected_although_one_engine_was_right(self):
        word = engine_word("BỪA", paddle="BỮA", vietocr="BỪA", selected="vietocr")
        self.assertEqual(classify_page([word], "BỮA"), ["red"])

    def test_scenario_10_right_candidate_selected_although_one_engine_was_wrong(self):
        word = engine_word("SÁNG", paddle="SANG", vietocr="SÁNG", selected="vietocr")
        self.assertEqual(classify_page([word], "SÁNG"), ["green"])

    async def test_generated_state_matrix(self):
        """120 pages covering every size/ratio combination of the three states."""
        rng = random.Random(20261110)
        pages = 0
        for size in (5, 8, 13, 21, 34, 40):
            for wrong_share, unknown_share in (
                (0.0, 0.0), (0.2, 0.0), (0.0, 0.2), (0.1, 0.1), (0.3, 0.1),
                (0.1, 0.3), (0.34, 0.0), (0.0, 0.34), (0.25, 0.25), (1 / size, 1 / size),
            ):
                for page_status in ("NEEDS_REVIEW", "VERIFIED"):
                    wrong = int(round(size * wrong_share))
                    unknown = int(round(size * unknown_share))
                    states = _spaced_states(size - wrong - unknown, wrong, unknown, rng)
                    with self.subTest(size=size, wrong=wrong, unknown=unknown, page=page_status):
                        result = await self._assert_page(states, rng, page_status)
                        self.assertEqual(result, {
                            "green": size - wrong - unknown, "red": wrong, "yellow": unknown})
                        pages += 1
        self.assertEqual(pages, 120)

    def test_pages_without_reference_never_produce_red(self):
        rng = random.Random(11)
        for _ in range(40):
            words = []
            expected = []
            for index, truth in enumerate(rng.sample(GREEN_WORDS, 12)):
                wrong = corrupt(truth, "all_marks_dropped")
                kind = rng.choice(["agree", "disagree", "resolved"]) if wrong else "agree"
                if kind == "agree":
                    words.append(engine_word(truth, token_index=index))
                    expected.append("green")
                elif kind == "disagree":
                    words.append(engine_word(truth, paddle=wrong, token_index=index))
                    expected.append("yellow")
                else:
                    words.append(engine_word(truth, paddle=wrong, token_index=index,
                                             crop_evidence=completed_crop(truth, truth)))
                    expected.append("green")
            self.assertEqual(classify_page(words, None), expected)


# --- Persistence, admin correction and OCR retry --------------------------
class PersistenceAndCorrection(unittest.IsolatedAsyncioTestCase):
    def _saved_page(self):
        words = [engine_word("BỮA", token_index=0), engine_word("SANG", token_index=1),
                 engine_word("CỦA", token_index=2), engine_word("AN", token_index=3)]
        classify_page(words, "BỮA SÁNG CỦA AN")
        revision = SimpleNamespace(ProcessingMeta=_persisted_metadata(words))
        rows = [_row(index, str(word["text"])) for index, word in enumerate(words)]
        return words, revision, rows

    @staticmethod
    def _draft(rows, texts):
        return [{"word_index": index, "text": text, "bbox": list(row.BoundingBox),
                 "ocr_confidence": None}
                for index, (row, text) in enumerate(zip(rows, texts))]

    def test_admin_correction_turns_the_token_green_and_keeps_ocr_history(self):
        _, revision, rows = self._saved_page()
        draft = self._draft(rows, ["BỮA", "SÁNG", "CỦA", "AN"])
        AdminOcrService._set_word_review_statuses(revision, draft, rows)
        metadata = revision.ProcessingMeta
        colors = [
            classify_word_evidence(status, evidence, word["text"])
            for status, evidence, word in zip(
                metadata["word_review_statuses"], metadata["word_evidence_v2"], draft)
        ]
        self.assertEqual(colors, ["green", "green", "green", "green"])
        corrected = metadata["word_evidence_v2"][1]
        self.assertEqual(corrected["source_text"], "SANG")           # original OCR kept
        self.assertEqual(corrected["engine_outputs"]["vietocr"], "SANG")
        self.assertEqual(corrected["reference_text"], "SÁNG")
        # Untouched tokens keep their status.
        self.assertEqual(metadata["word_review_statuses"][0], "reference_match")

    def test_editing_another_token_does_not_change_a_red_or_green_token(self):
        _, revision, rows = self._saved_page()
        draft = self._draft(rows, ["BỮA", "SANG", "CỦA", "ANH"])
        AdminOcrService._set_word_review_statuses(revision, draft, rows)
        metadata = revision.ProcessingMeta
        colors = [
            classify_word_evidence(status, evidence, word["text"])
            for status, evidence, word in zip(
                metadata["word_review_statuses"], metadata["word_evidence_v2"], draft)
        ]
        # The edited token no longer equals its verified reference and its
        # OCR evidence describes the previous text: undecided until verified.
        self.assertEqual(colors, ["green", "red", "green", "yellow"])

    def test_admin_verification_makes_every_word_verified(self):
        _, revision, rows = self._saved_page()
        draft = self._draft(rows, ["BỮA", "SÁNG", "CỦA", "AN"])
        AdminOcrService._set_word_review_statuses(revision, draft, rows, verified=True)
        self.assertEqual(revision.ProcessingMeta["word_review_statuses"], ["verified"] * 4)

    def test_ocr_retry_on_the_same_image_is_stable(self):
        def run():
            words = [engine_word("BỮA", token_index=0),
                     engine_word("SANG", paddle="SÁNG", token_index=1),
                     engine_word("CỦA", paddle="CUA", token_index=2),
                     engine_word("AN", token_index=3)]
            return classify_page(words, "BỮA SÁNG CỦA AN"), words
        first_colors, first_words = run()
        second_colors, second_words = run()
        self.assertEqual(first_colors, ["green", "red", "green", "green"])
        self.assertEqual(first_colors, second_colors)
        self.assertEqual(
            [word["ocr_evidence"]["reference_text"] for word in first_words],
            [word["ocr_evidence"]["reference_text"] for word in second_words],
        )

    async def test_api_serialization_exposes_the_full_contract(self):
        words = [engine_word("BỪA", paddle="BỮA", token_index=0)]
        classify_page(words, "BỮA")
        served = (await api_words(words))[0]
        self.assertEqual(served["text"], "BỪA")
        self.assertEqual(served["review_color_group"], "red")
        self.assertEqual(served["ocr_review_status"], "confirmed_mismatch")
        evidence = served["ocr_evidence"]
        self.assertEqual(evidence["source_text"], "BỪA")
        self.assertEqual(evidence["engine_outputs"]["paddleocr"], "BỮA")
        self.assertEqual(evidence["reference_text"], "BỮA")
        self.assertEqual(evidence["verification_source"], "verified_revision")
        self.assertEqual(evidence["reference_alignment"], "substitute")

    async def test_malformed_or_missing_evidence_never_crashes_or_invents_a_color(self):
        for broken in (None, {}, {"contract": "unknown"}, "text", 5, [],
                       {"contract": "hybrid_ocr_evidence_v4", "engine_outputs": "x"},
                       {"contract": "hybrid_ocr_evidence_v4", "crop_evidence": {"status": 3}}):
            with self.subTest(evidence=broken):
                word = {"text": "SÁNG", "ocr_review_status": "needs_review", "ocr_evidence": broken}
                self.assertEqual(classify_word(word), "yellow")
                served = await api_words([word])
                self.assertEqual(served[0]["review_color_group"], "yellow")


# --- Invariants (seeded property tests) -----------------------------------
def _random_word(rng: random.Random, text: str, index: int = 0) -> dict[str, object]:
    """A word with arbitrary engine noise around a fixed stored text."""
    variants = [text, corrupt(text, "all_marks_dropped") or text + "q",
                corrupt(text, "extra_char") or text + "n", None, ""]
    crop = rng.choice([
        None,
        {"status": "skipped"},
        {"status": "partial", "paddle_error": "RuntimeError"},
        completed_crop(rng.choice(variants), rng.choice(variants), rng.choice(variants)),
    ])
    word = engine_word(
        text,
        paddle=rng.choice(variants),
        vietocr=rng.choice(variants),
        selected=rng.choice(["paddleocr", "vietocr", "tesseract"]),
        statuses={engine: rng.choice(["success", "error", "not_run", "no_result", "not_installed"])
                  for engine in ("paddleocr", "vietocr", "tesseract")},
        alignment=rng.choice(["match", "substitute", "insert", "unmatched", "split", "merge"]),
        bbox_quality=rng.choice(["valid", "rejected", "not_checked"]),
        crop_quality=rng.choice(["usable", "weak", "unavailable"]),
        crop_evidence=crop,
        token_index=index,
        review_status=rng.choice(["needs_review", "engine_agreement", "engine_disagreement",
                                  "verified", "reference_match", "confirmed_mismatch", "matched"]),
        ocr_confidence=rng.choice([None, 0.0, 0.01, 0.5, 0.99, 1.0]),
    )
    return word


class ClassificationInvariants(unittest.IsolatedAsyncioTestCase):
    SAMPLES = 400

    def _pairs(self, seed: int):
        rng = random.Random(seed)
        for _ in range(self.SAMPLES):
            truth, wrong, _category = rng.choice(RED_PAIRS)
            yield rng, truth, wrong

    def test_inv01_02_07_08_09_reference_decides_regardless_of_engine_noise(self):
        for rng, truth, wrong in self._pairs(1):
            for stored, expected in ((truth, "green"), (wrong, "red")):
                target = _random_word(rng, stored, 1)
                words, reference = _target_page(target, truth)
                self.assertEqual(
                    classify_page(words, reference)[1], expected,
                    msg=f"truth={truth} stored={stored} evidence={target['ocr_evidence']}",
                )

    def test_inv03_red_survives_any_later_change_while_reference_is_unchanged(self):
        for rng, truth, wrong in self._pairs(3):
            words, reference = _target_page(engine_word(wrong, token_index=1), truth)
            classify_page(words, reference)
            evidence = words[1]["ocr_evidence"]
            noise = _random_word(rng, wrong, 1)["ocr_evidence"]
            for key in ("engine_outputs", "engine_statuses", "alignment", "bbox_quality",
                        "crop_quality", "crop_evidence", "selected_engine"):
                evidence[key] = noise[key]
            words[1]["ocr_review_status"] = rng.choice(["verified", "needs_review", "matched"])
            self.assertEqual(classify_word(words[1]), "red")

    def test_inv04_05_12_neighbour_changes_never_move_a_decided_token(self):
        for rng, truth, wrong in self._pairs(4):
            for stored, expected in ((truth, "green"), (wrong, "red")):
                baseline, reference = _target_page(engine_word(stored, token_index=1), truth)
                self.assertEqual(classify_page(baseline, reference)[1], expected)
                changed, _ = _target_page(
                    engine_word(stored, token_index=1), truth,
                    left=_random_word(rng, LEFT, 0), right=_random_word(rng, RIGHT, 2))
                changed[0]["ocr_evidence"] = rng.choice([changed[0]["ocr_evidence"], None])
                self.assertEqual(classify_page(changed, reference)[1], expected)

    async def test_inv06_page_status_never_changes_word_colors(self):
        rng = random.Random(6)
        for _ in range(60):
            states = _spaced_states(rng.randint(3, 12), rng.randint(0, 3), rng.randint(0, 3), rng)
            words, reference = build_page(states, rng)
            colors = classify_page(words, reference)
            for page_status in ("NEEDS_REVIEW", "VERIFIED", "PROCESSING"):
                served = await api_words(words, page_status=page_status)
                self.assertEqual([word["review_color_group"] for word in served], colors)

    def test_inv10_unicode_forms_match_but_different_marks_do_not(self):
        for word in GREEN_WORDS:
            nfd = unicodedata.normalize("NFD", word)
            self.assertEqual(classify_page([engine_word(nfd)], word), ["green"])
            self.assertEqual(classify_page([engine_word(word)], nfd), ["green"])
            stripped = corrupt(word, "all_marks_dropped")
            if stripped:
                self.assertEqual(classify_page([engine_word(stripped)], word), ["red"])
                self.assertEqual(classify_page([engine_word(word)], stripped), ["red"])

    async def test_inv11_evidence_of_one_revision_is_not_applied_to_another(self):
        rng = random.Random(11)
        for _ in range(40):
            truth, wrong, _category = rng.choice(RED_PAIRS)
            red_words, reference = _target_page(engine_word(wrong, token_index=1), truth)
            classify_page(red_words, reference)
            before = await api_words(red_words, revision_id="44444444-4444-4444-8444-444444444444")
            other, _ = _target_page(engine_word(wrong, paddle=truth, token_index=1), truth)
            unrelated = await api_words(other, revision_id="55555555-5555-4555-8555-555555555555")
            after = await api_words(red_words, revision_id="44444444-4444-4444-8444-444444444444")
            self.assertEqual(before, after)
            self.assertEqual(before[1]["review_color_group"], "red")
            # No reference was attached to the other revision: undecided, not red.
            self.assertEqual(unrelated[1]["review_color_group"], "yellow")

    def test_inv14_same_snapshot_same_color(self):
        rng = random.Random(14)
        for _ in range(self.SAMPLES):
            truth, wrong, _category = rng.choice(RED_PAIRS)
            word = _random_word(rng, rng.choice([truth, wrong]))
            if rng.random() < 0.5:
                classify_page([word], truth)
            snapshot = json.loads(json.dumps(word, ensure_ascii=False))
            self.assertEqual(
                {classify_word(copy.deepcopy(snapshot)) for _ in range(3)},
                {classify_word(word)},
            )

    def test_inv15_low_confidence_alone_never_makes_red(self):
        rng = random.Random(15)
        for _ in range(self.SAMPLES):
            word = _random_word(rng, rng.choice(GREEN_WORDS))
            word["ocr_confidence"] = 0.0
            self.assertNotEqual(classify_word(word), "red")

    def test_inv15b_no_engine_only_evidence_can_make_red(self):
        rng = random.Random(151)
        for _ in range(self.SAMPLES * 2):
            self.assertNotEqual(classify_word(_random_word(rng, rng.choice(GREEN_WORDS))), "red")

    def test_inv16_reference_decided_tokens_are_never_defaulted_to_yellow(self):
        rng = random.Random(16)
        for _ in range(100):
            states = _spaced_states(rng.randint(2, 15), rng.randint(1, 4), 0, rng)
            words, reference = build_page(states, rng)
            self.assertNotIn("yellow", classify_page(words, reference))

    def test_inv13_missing_unrelated_fields_do_not_change_a_reference_verdict(self):
        optional = ("engine_statuses", "engine_errors", "paddle_token_index", "vietocr_token_index",
                    "engine_agreement_score", "calibrated_word_accuracy", "selected_engine",
                    "selection_reason", "bbox_quality", "crop_quality", "crop_evidence")
        for truth, wrong, _category in RED_PAIRS[:40]:
            for stored, expected in ((truth, "green"), (wrong, "red")):
                words, reference = _target_page(engine_word(stored, token_index=1), truth)
                classify_page(words, reference)
                for field in optional:
                    evidence = dict(words[1]["ocr_evidence"])
                    evidence.pop(field, None)
                    self.assertEqual(
                        classify_word_evidence(words[1]["ocr_review_status"], evidence, stored),
                        expected, msg=f"dropping {field} changed the color",
                    )


if __name__ == "__main__":
    unittest.main()
