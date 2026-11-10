"""A correct word must not be yellow when the evidence is sufficient.

GROUP B  tone marks and Unicode (30)      GROUP E  RED precision (25)
GROUP D  false-yellow regression (35)     GROUP F  mixed pages (25)
GROUP A  diacritic matrix on images (60 words, real engines)
GROUP G  full-page integration per image condition (real engines)

Every scenario names its ground truth, the OCR output and the expected
result. Nothing here derives an expected answer from OCR output.
"""
from __future__ import annotations

import copy
import importlib.util
import json
import random
import sys
import unicodedata
import unittest
from pathlib import Path

import numpy as np

from ocr_color_testkit import (
    GREEN_WORDS,
    classify_page,
    classify_word,
    completed_crop,
    corrupt,
    counts,
    engine_word,
)
from test_ocr_color_matrix import _persisted_metadata, _row, api_words

from app.services import ocr_engine
from app.services.admin_ocr_service import (
    AdminOcrService,
    classify_word_evidence,
    geometry_quality,
)
from app.services.ocr_adjudication import adjudicate_word
from app.services.ocr_engine import normalize_word
from app.services.ocr_punctuation import punctuation_status

BACKEND_ROOT = Path(__file__).resolve().parent
SUCCESS = {"paddleocr": "success", "vietocr": "success", "tesseract": "success"}
T = "SÁNG"      # the token under test
BARE = "SANG"   # what a Latin-only recognizer returns for it


def viet(text=T, *, paddle=BARE, vietocr="__same__", tesseract="__same__", **kwargs):
    """A word read by the pipeline with Tesseract as second Vietnamese engine."""
    word = engine_word(
        text, paddle=paddle, vietocr=text if vietocr == "__same__" else vietocr,
        statuses=kwargs.pop("statuses", dict(SUCCESS)), **kwargs)
    reading = text if tesseract == "__same__" else tesseract
    if reading is not None:
        word["ocr_evidence"]["engine_outputs"]["tesseract"] = reading
    return word


def page(target, truth=T, *, left=None, right=None, extra=()):
    words = [left or engine_word("một"), target, right or engine_word("hai", token_index=2), *extra]
    return words, f"một {truth} hai"


# --- GROUP D --------------------------------------------------------------
def _false_yellow_scenarios():
    no_ref = None
    yield "FY01 two Vietnamese recognizers agree, PaddleOCR lacks the mark", viet(), no_ref
    yield "FY02 reference correct although the crop is weak", engine_word(T, crop_quality="weak"), T
    yield "FY03 reference correct although the box geometry is weak", engine_word(
        T, bbox_quality="rejected", crop_quality="unavailable"), T
    yield "FY04 reference correct although Tesseract did not run", engine_word(T, paddle=BARE), T
    yield "FY05 reference correct although PaddleOCR failed", engine_word(
        T, paddle=None, statuses={"paddleocr": "error", "vietocr": "success", "tesseract": "not_run"}), T
    yield "FY06 reference correct although the raw score is low", engine_word(T, ocr_confidence=0.01), T
    yield "FY07 reference correct although the line score is low", _low_line_score(), T
    yield "FY08 reference correct although another engine disagrees", viet(tesseract="SẢNG"), T
    yield "FY09 reference correct on a NEEDS_REVIEW page", engine_word(T), T
    yield "FY10 reference correct, another token on the page is RED", engine_word(T), T
    yield "FY11 reference correct, another token on the page is YELLOW", engine_word(T), T
    yield "FY12 reference correct after a retry", engine_word(T, crop_evidence={
        "status": "partial", "vietocr_error": "RuntimeError"}), T
    yield "FY13 reference correct after a reload", engine_word(T), T
    yield "FY14 reference correct after an Admin update of another word", engine_word(T), T
    yield "FY15 VietOCR and Tesseract agree on the exact marks", viet("NGỒI", paddle="NGI"), no_ref
    yield "FY16 PaddleOCR drops the mark, VietOCR and Tesseract agree", viet("BỮA", paddle="BU'A"), no_ref
    yield "FY17 Tesseract has no word data, both crops confirm", viet(
        tesseract=None, crop_evidence=completed_crop(BARE, T, T)), no_ref
    yield "FY18 one model returned an empty string", viet(paddle=""), no_ref
    yield "FY19 one model returned a duplicated token", viet(paddle="SANG SANG"), no_ref
    yield "FY20 crop is poor but the line recognition agrees", viet(
        crop_quality="weak", crop_evidence={"status": "skipped", "reason": "padding_touched_image_edge"}), no_ref
    yield "FY21 line crop good, word crop weak", viet(
        crop_quality="weak", crop_evidence={"status": "skipped", "reason": "insufficient_visual_signal"}), no_ref
    yield "FY22 word crop good, line reading of one engine missing", viet(
        tesseract=None, crop_evidence=completed_crop(None, T, T)), no_ref
    yield "FY23 local engine failure on the crop pass", viet(
        crop_evidence={"status": "partial", "paddle_error": "RuntimeError"}), no_ref
    yield "FY24 Unicode normalization does not change the marks", viet(
        tesseract=unicodedata.normalize("NFD", T)), no_ref
    yield "FY25 punctuation differs but the lexical token is right", viet(
        "sáng,", paddle="sang", vietocr="sáng,", tesseract="sáng."), no_ref
    yield "FY26 one extra token elsewhere in the alignment", engine_word(T), T
    yield "FY27 correct token next to a missing token", engine_word(T), T
    yield "FY28 correct token on a page full of punctuation", viet(
        "“Sáng!”", paddle='"Sang!"', vietocr="“Sáng!”", tesseract="“Sáng!”"), no_ref
    yield "FY29 correct token differing only in letter case", viet(
        "Sáng", paddle="sang", vietocr="Sáng", tesseract="SÁNG"), no_ref
    yield "FY30 correct token with trailing punctuation", viet(
        "sáng.", paddle="sang.", vietocr="sáng.", tesseract="sáng."), no_ref
    yield "FY31 correct token with leading punctuation", viet(
        "“Sáng", paddle='"Sang', vietocr="“Sáng", tesseract="“Sáng"), no_ref
    yield "FY32 correct token with odd whitespace", viet(
        "sáng", paddle=" sang ", vietocr="sáng ", tesseract="  sáng"), no_ref
    yield "FY33 correct token with a circumflex", viet("ÔNG", paddle="ONG"), no_ref
    yield "FY34 correct token with two stacked marks", viet("BỮA", paddle="BUA"), no_ref
    yield "FY35 correct token confirmed by the expanded crop", viet(
        tesseract=None, alignment="substitute", crop_evidence=completed_crop(BARE, T, T)), no_ref


def _low_line_score():
    word = engine_word(T, paddle=BARE)
    word["ocr_evidence"]["crop_evidence"] = completed_crop(
        BARE, T, None, paddle_crop_recognition_score=0.02, vietocr_crop_recognition_score=0.03)
    return word


class FalseYellowRegressionSuite(unittest.IsolatedAsyncioTestCase):
    async def test_d_false_yellow_scenarios(self):
        seen = 0
        for name, target, reference in _false_yellow_scenarios():
            with self.subTest(case=name):
                truth = str(target["text"])
                if reference is None:
                    self.assertEqual(classify_word(target), "green")
                    served = await api_words([target])
                    self.assertEqual(served[0]["review_color_group"], "green")
                else:
                    left = engine_word("mốt") if "RED" in name else None
                    extra = [engine_word("zzq", token_index=3)] if (
                        "YELLOW" in name or "extra token" in name) else []
                    words, text = page(target, truth, left=left, extra=extra)
                    if "missing token" in name:
                        text += " ba"
                    self.assertEqual(classify_page(words, text)[1], "green")
                    for status in ("NEEDS_REVIEW", "VERIFIED"):
                        served = await api_words(words, page_status=status)
                        self.assertEqual(served[1]["review_color_group"], "green")
                seen += 1
        self.assertEqual(seen, 35)

    def test_verified_correct_token_is_green_even_when_crop_is_weak(self):
        for crop_quality in ("weak", "unavailable", None):
            words, text = page(engine_word(T, crop_quality=crop_quality))
            self.assertEqual(classify_page(words, text)[1], "green")

    def test_verified_correct_token_is_green_when_paddle_lacks_diacritics(self):
        for word in GREEN_WORDS:
            bare = corrupt(word, "all_marks_dropped")
            if bare is None:
                continue
            with self.subTest(word=word):
                words, text = page(engine_word(word, paddle=bare), word)
                self.assertEqual(classify_page(words, text)[1], "green")

    def test_verified_correct_token_is_green_when_tesseract_is_unavailable(self):
        for status in ("not_installed", "error", "not_run", "no_result", "disabled"):
            target = engine_word(T, paddle=BARE, statuses={
                "paddleocr": "success", "vietocr": "success", "tesseract": status})
            words, text = page(target)
            with self.subTest(tesseract=status):
                self.assertEqual(classify_page(words, text)[1], "green")

    def test_correct_word_is_not_downgraded_by_neighboring_ambiguity(self):
        # Neighbours the two Vietnamese engines read differently: truly undecided.
        words = [viet("BỮA", paddle="BUA"), viet("zzq", paddle="zzq", tesseract="zzk", token_index=1),
                 viet(token_index=2), viet("qqz", paddle="qqz", tesseract="qqk", token_index=3)]
        self.assertEqual(classify_page(copy.deepcopy(words), None), ["green", "yellow", "green", "yellow"])
        self.assertEqual(classify_page(words, "BỮA SÁNG"), ["green", "yellow", "green", "yellow"])

    async def test_correct_word_is_not_downgraded_by_page_needs_review(self):
        words = [viet("BỮA", paddle="BUA"), viet(token_index=1)]
        for status in ("NEEDS_REVIEW", "PROCESSING"):
            served = await api_words(words, page_status=status)
            self.assertEqual([word["review_color_group"] for word in served], ["green", "green"])

    def test_correct_surface_word_with_punctuation_is_green(self):
        for surface in ("sáng.", "sáng,", "sáng!", "sáng?", "“sáng”", "(sáng)", "sáng…", "'sáng'"):
            with self.subTest(surface=surface):
                self.assertEqual(classify_page([engine_word(surface)], "sáng"), ["green"])
                target = viet(surface, paddle="sang", vietocr=surface, tesseract=surface)
                self.assertEqual(classify_word(target), "green")

    def test_correct_word_remains_green_after_retry(self):
        def run():
            words = [viet("BỮA", paddle="BUA"), viet(token_index=1)]
            return classify_page(copy.deepcopy(words), None), classify_page(words, "BỮA SÁNG")
        self.assertEqual(run(), run())
        self.assertEqual(run(), (["green", "green"], ["green", "green"]))

    async def test_correct_word_remains_green_after_reload(self):
        words, text = page(viet())
        classify_page(words, text)
        first = await api_words(words)
        second = await api_words(words)
        self.assertEqual(first, second)
        self.assertEqual(first[1]["review_color_group"], "green")

    async def test_geometry_problems_are_reported_next_to_a_green_word(self):
        weak = viet(crop_quality="weak", crop_evidence={"status": "skipped"})
        invalid = viet(bbox_quality="rejected", crop_quality="unavailable",
                       crop_evidence={"status": "skipped", "reason": "invalid_bbox"})
        served = await api_words([weak, invalid, viet(token_index=2)])
        self.assertEqual([word["review_color_group"] for word in served], ["green"] * 3)
        self.assertEqual([word["geometry_quality"] for word in served], ["weak", "invalid", "good"])

    def test_sufficient_evidence_is_still_required(self):
        # The gate was removed for geometry only; text evidence is unchanged.
        self.assertEqual(classify_word(viet(tesseract="SẢNG")), "yellow")
        self.assertEqual(classify_word(viet(tesseract=None)), "yellow")
        self.assertEqual(classify_word(viet(vietocr=BARE, text=BARE, tesseract=T)), "yellow")
        self.assertEqual(classify_word(viet(alignment="split")), "yellow")


# --- GROUP B --------------------------------------------------------------
def _tone_scenarios():
    # name, ground truth, OCR output, expected color with a verified reference
    yield "B01 NFC truth, NFD OCR", "bữa", unicodedata.normalize("NFD", "bữa"), "green"
    yield "B02 uppercase with marks", "BỮA", "BỮA", "green"
    yield "B03 lowercase with marks", "bữa", "bữa", "green"
    yield "B04 mixed case", "Bữa", "bỮA", "green"
    yield "B05 grave missing", "bà", "ba", "red"
    yield "B06 acute missing", "sáng", "sang", "red"
    yield "B07 hook missing", "của", "cua", "red"
    yield "B08 tilde missing", "mỹ", "my", "red"
    yield "B09 dot below missing", "mẹ", "me", "red"
    yield "B10 wrong circumflex", "ông", "ong", "red"
    yield "B11 wrong horn", "ơn", "on", "red"
    yield "B12 wrong đ", "đi", "di", "red"
    yield "B13 tone cut at the crop edge", "ngồi", "ngôi", "red"
    yield "B14 tone hidden by a shadow", "nằm", "năm", "red"
    yield "B15 tone on a low-resolution image", "rỡ", "rõ", "red"
    yield "B16 tone on a colored background, read right", "nắng", "nắng", "green"
    yield "B17 tone on italic text, read right", "nhỏ", "nhỏ", "green"
    yield "B18 tone on a serif font, read right", "giường", "giường", "green"
    yield "B19 tone on a sans-serif font, read right", "trường", "trường", "green"
    yield "B20 two stacked marks, one lost", "bữa", "bưa", "red"
    yield "B21 circumflex with a tone, tone swapped", "ấm", "ầm", "red"
    yield "B22 horn with a tone, tone swapped", "bữa", "bừa", "red"
    yield "B23 dot below lost", "chị", "chi", "red"
    yield "B24 faint grave read as none", "bàn", "ban", "red"
    yield "B25 tilde read as hook", "sữa", "sửa", "red"
    yield "B26 hook read as tilde", "cổ", "cỗ", "red"
    yield "B27 small acute read as grave", "líu", "lìu", "red"
    yield "B28 dot of i is not a tone", "đi", "đi", "green"
    yield "B29 Vietnamese mark next to punctuation", "mẹ.", "mẹ.", "green"
    yield "B30 several marks in one word", "nguyễn", "nguyển", "red"


class ToneMarkAndUnicodeRules(unittest.TestCase):
    def test_b_tone_and_unicode_scenarios(self):
        seen = 0
        for name, truth, ocr, expected in _tone_scenarios():
            with self.subTest(case=name, ground_truth=truth, ocr_output=ocr):
                self.assertEqual(classify_page([engine_word(ocr)], truth), [expected])
                # Without a reference the same pair is never called wrong.
                self.assertNotEqual(classify_word(viet(ocr, paddle=ocr, tesseract=truth)), "red")
                # Vietnamese engines differing only in marks never confirm.
                if expected == "red":
                    self.assertEqual(classify_word(viet(ocr, paddle=ocr, tesseract=truth)), "yellow")
                seen += 1
        self.assertEqual(seen, 30)

    def test_every_tone_and_vowel_form_is_distinct(self):
        forms = ("a á à ả ã ạ ă ắ ằ ẳ ẵ ặ â ấ ầ ẩ ẫ ậ e é è ẻ ẽ ẹ ê ế ề ể ễ ệ i í ì ỉ ĩ ị "
                 "o ó ò ỏ õ ọ ô ố ồ ổ ỗ ộ ơ ớ ờ ở ỡ ợ u ú ù ủ ũ ụ ư ứ ừ ử ữ ự y ý ỳ ỷ ỹ ỵ d đ").split()
        self.assertEqual(len(set(forms)), len(forms))
        keys = [normalize_word(form) for form in forms]
        self.assertEqual(len(set(keys)), len(forms))
        for form in forms:
            nfd = unicodedata.normalize("NFD", form)
            self.assertEqual(normalize_word(nfd), normalize_word(form))
            self.assertEqual(normalize_word(form.upper()), normalize_word(form))


# --- GROUP E --------------------------------------------------------------
RED_SCENARIOS = [
    ("E01", "BỮA", "BỪA"), ("E02", "SÁNG", "SANG"), ("E03", "NGỒI", "NGÀI"),
    ("E04", "PHÒNG", "PHONG"), ("E05", "KHÁCH", "KHACH"), ("E06", "BÀN", "BAN"),
    ("E07", "ĂN", "AN"), ("E08", "SỮA", "SUA"), ("E09", "MẸ", "ME"), ("E10", "BỐ", "BO"),
    ("E11", "CẢM", "CAM"), ("E12", "ƠN", "ON"), ("E13", "ĐI", "DI"), ("E14", "ĐẸP", "DEP"),
    ("E15 extra character", "nhà", "nhàn"), ("E16 missing character", "trường", "trườn"),
    ("E17 swapped characters", "chim", "chmi"), ("E18 repeated character", "hoa", "hooa"),
]


class RedPrecision(unittest.IsolatedAsyncioTestCase):
    async def test_e_mismatches_are_red_and_stay_red(self):
        for name, truth, wrong in RED_SCENARIOS:
            with self.subTest(case=name, ground_truth=truth, ocr_output=wrong):
                words, text = page(engine_word(wrong, token_index=1), truth)
                self.assertEqual(classify_page(words, text), ["green", "red", "green"])
                served = await api_words(words, page_status="VERIFIED")
                self.assertEqual(served[1]["review_color_group"], "red")
                self.assertEqual(served[1]["ocr_review_status"], "confirmed_mismatch")

    def test_e19_engine_consensus_on_a_wrong_token_is_red(self):
        target = viet("BỪA", paddle="BỪA", vietocr="BỪA", tesseract="BỪA",
                      crop_evidence=completed_crop("BỪA", "BỪA", "BỪA"))
        self.assertEqual(classify_word(copy.deepcopy(target)), "green")   # no reference: agreement
        words, text = page(target, "BỮA")
        self.assertEqual(classify_page(words, text)[1], "red")           # reference overrules it

    def test_e20_wrong_selected_candidate_is_red_although_engines_read_it_right(self):
        target = viet("BỪA", paddle="BUA", vietocr="BỮA", tesseract="BỮA", selected="vietocr")
        words, text = page(target, "BỮA")
        self.assertEqual(classify_page(words, text)[1], "red")

    def test_e21_high_raw_score_does_not_rescue_a_wrong_token(self):
        words, text = page(engine_word("SANG", ocr_confidence=1.0), "SÁNG")
        self.assertEqual(classify_page(words, text)[1], "red")

    def test_e22_wrong_mark_with_one_to_one_mapping_is_red(self):
        for truth, wrong in (("rỡ", "rõ"), ("kể", "kề"), ("thả", "thà"), ("nắng", "năng")):
            self.assertEqual(classify_page([engine_word(wrong)], truth), ["red"])

    def test_e23_misspelling_with_ground_truth_is_red(self):
        self.assertEqual(classify_page([engine_word("ngiêng")], "nghiêng"), ["red"])

    async def test_e24_red_follows_the_new_reference_after_a_revision_update(self):
        words, text = page(engine_word("SANG", token_index=1), "SÁNG")
        classify_page(words, text)
        revision = type("Revision", (), {"ProcessingMeta": _persisted_metadata(words)})()
        rows = [_row(index, str(word["text"])) for index, word in enumerate(words)]
        draft = [{"word_index": i, "text": t, "bbox": list(rows[i].BoundingBox), "ocr_confidence": None}
                 for i, t in enumerate(["một", "SÁNG", "hai"])]
        AdminOcrService._set_word_review_statuses(revision, draft, rows)
        meta = revision.ProcessingMeta
        self.assertEqual(classify_word_evidence(
            meta["word_review_statuses"][1], meta["word_evidence_v2"][1], "SÁNG"), "green")
        self.assertEqual(meta["word_evidence_v2"][1]["source_text"], "SANG")   # history kept

    async def test_e25_red_persists_through_reload_and_retry(self):
        words, text = page(engine_word("BỪA", token_index=1), "BỮA")
        classify_page(words, text)
        snapshots = [await api_words(words) for _ in range(3)]
        self.assertTrue(all(snapshot == snapshots[0] for snapshot in snapshots))
        retried, _ = page(engine_word("BỪA", token_index=1), "BỮA")
        self.assertEqual(classify_page(retried, text)[1], "red")

    def test_mapping_that_is_not_one_to_one_is_ambiguity_not_red(self):
        for ocr, reference in (("bừa zzq sáng", "bữa sáng"), ("bừa", "bữa sáng của"),
                               ("bữasáng", "bữa sáng"), ("bữ a", "bữa")):
            with self.subTest(ocr=ocr, reference=reference):
                words = [engine_word(token, token_index=i) for i, token in enumerate(ocr.split())]
                self.assertNotIn("red", [
                    color for word, color in zip(words, classify_page(words, reference))
                    if normalize_word(str(word["text"])) not in {"zzq", "sáng"}])


# --- GROUP F --------------------------------------------------------------
def build(states: str, rng: random.Random, *, tesseract: bool = True):
    """C correct, W wrong, U unpaired extra token, P correct word with wrong punctuation."""
    vocabulary = rng.sample(GREEN_WORDS, len(states))
    words, reference = [], []
    for index, (state, truth) in enumerate(zip(states, vocabulary)):
        if state == "U":
            words.append(engine_word(f"zq{index}x", token_index=index))
            continue
        bare = corrupt(truth, "all_marks_dropped") or truth
        if state == "W":
            wrong = next(c for cat in ("tone_dropped", "all_marks_dropped", "last_char_missing",
                                       "extra_char", "wrong_first_char")
                         if (c := corrupt(truth, cat)) is not None)
            words.append(engine_word(wrong, token_index=index))
            reference.append(truth)
        elif state == "P":
            words.append(viet(truth + ".", paddle=bare, token_index=index))
            reference.append(truth + "!")
        else:
            words.append(viet(truth, paddle=bare, token_index=index) if tesseract
                         else engine_word(truth, paddle=bare, token_index=index))
            reference.append(truth)
    return words, " ".join(reference)


def spaced(correct: int, wrong: int, unknown: int, rng: random.Random) -> str:
    for _ in range(4000):
        states = list("C" * correct + "W" * wrong + "U" * unknown)
        rng.shuffle(states)
        if all({states[i], states[i + 1]} != {"W", "U"} for i in range(len(states) - 1)):
            return "".join(states)
    raise AssertionError("no non-adjacent layout")


EXPECTED = {"C": "green", "W": "red", "U": "yellow", "P": "green"}


class MixedPages(unittest.IsolatedAsyncioTestCase):
    async def _check(self, states: str, seed: int, page_status="NEEDS_REVIEW"):
        words, reference = build(states, random.Random(seed))
        colors = classify_page(words, reference)
        self.assertEqual(colors, [EXPECTED[state] for state in states])
        served = await api_words(words, page_status=page_status)
        self.assertEqual([word["review_color_group"] for word in served], colors)
        return counts(colors), served

    async def test_f01_hundred_correct_words(self):
        self.assertEqual((await self._check("C" * 100, 1))[0], {"green": 100, "red": 0, "yellow": 0})

    async def test_f02_ninety_nine_correct_one_wrong(self):
        self.assertEqual((await self._check("C" * 60 + "W" + "C" * 39, 2))[0],
                         {"green": 99, "red": 1, "yellow": 0})

    async def test_f03_ninety_nine_correct_one_uncertain(self):
        self.assertEqual((await self._check("C" * 40 + "U" + "C" * 59, 3))[0],
                         {"green": 99, "red": 0, "yellow": 1})

    async def test_f04_ninety_five_five(self):
        rng = random.Random(4)
        self.assertEqual((await self._check(spaced(90, 5, 5, rng), 4))[0],
                         {"green": 90, "red": 5, "yellow": 5})

    async def test_f05_eighty_five_ten_five(self):
        rng = random.Random(5)
        self.assertEqual((await self._check(spaced(85, 10, 5, rng), 5))[0],
                         {"green": 85, "red": 10, "yellow": 5})

    async def test_f06_spec_example_94_3_3(self):
        rng = random.Random(6)
        self.assertEqual((await self._check(spaced(94, 3, 3, rng), 6))[0],
                         {"green": 94, "red": 3, "yellow": 3})

    def test_f07_one_engine_disagreement_among_hundred_correct_words_without_reference(self):
        words, _ = build("C" * 101, random.Random(7))
        words[50]["ocr_evidence"]["engine_outputs"]["tesseract"] = "khác"
        colors = classify_page(words, None)
        self.assertEqual(counts(colors), {"green": 100, "red": 0, "yellow": 1})
        self.assertEqual(colors[50], "yellow")

    async def test_f08_one_weak_crop_among_hundred_correct_words(self):
        words, _ = build("C" * 100, random.Random(8))
        words[10]["ocr_evidence"]["crop_quality"] = "weak"
        self.assertEqual(counts(classify_page(copy.deepcopy(words), None))["green"], 100)
        served = await api_words(words)
        self.assertEqual([w["geometry_quality"] for w in served].count("weak"), 1)
        self.assertEqual(served[10]["review_color_group"], "green")

    async def test_f09_one_invalid_box_among_hundred_correct_words(self):
        words, reference = build("C" * 100, random.Random(9))
        words[33]["ocr_evidence"]["bbox_quality"] = "rejected"
        self.assertEqual(counts(classify_page(words, reference))["green"], 100)
        served = await api_words(words)
        self.assertEqual(served[33]["geometry_quality"], "invalid")
        self.assertEqual(served[33]["review_color_group"], "green")

    async def test_f10_one_wrong_punctuation_mark_among_correct_words(self):
        result, served = await self._check("CCCPCCC", 10)
        self.assertEqual(result, {"green": 7, "red": 0, "yellow": 0})
        self.assertEqual([w["punctuation_status"] for w in served],
                         ["correct"] * 3 + ["incorrect"] + ["correct"] * 3)

    def test_f11_many_words_with_the_same_text(self):
        words = [engine_word(token, token_index=i) for i, token in enumerate("bà bà ba bà bà".split())]
        self.assertEqual(classify_page(words, "bà bà bà bà bà"),
                         ["green", "green", "red", "green", "green"])

    def test_f12_several_sentences(self):
        text = "An ăn sáng. Mẹ đi chợ! Bà ở nhà?"
        words = [engine_word(token, token_index=i) for i, token in enumerate(text.split())]
        self.assertEqual(set(classify_page(words, text)), {"green"})

    def test_f13_several_paragraphs_and_lines(self):
        reference = "An ăn sáng.\n\nMẹ đi chợ.\nBà ở nhà."
        words = [engine_word(token, token_index=i) for i, token in enumerate(reference.split())]
        words[4]["text"] = "di"   # "đi" misread on the second paragraph
        words[4]["ocr_evidence"]["engine_outputs"] = {"paddleocr": "di", "vietocr": "di"}
        colors = classify_page(words, reference)
        self.assertEqual(counts(colors), {"green": 8, "red": 1, "yellow": 0})
        self.assertEqual(colors[4], "red")

    def test_f14_line_with_many_punctuation_marks(self):
        ocr = "“Tại sao?” – bé hỏi. “Vì trời mưa.”"
        words = [engine_word(token, token_index=i)
                 for i, token in enumerate(t for t in ocr.split() if normalize_word(t))]
        colors = classify_page(words, ocr)
        self.assertEqual(set(colors), {"green"})
        self.assertEqual(len(colors), 7)      # the standalone dash is not a word

    async def test_f15_page_needs_review_and_f16_page_verified(self):
        rng = random.Random(15)
        states = spaced(20, 3, 2, rng)
        for status in ("NEEDS_REVIEW", "VERIFIED"):
            result, _ = await self._check(states, 15, status)
            self.assertEqual(result, {"green": 20, "red": 3, "yellow": 2})

    def test_f17_page_with_an_engine_failure(self):
        words, reference = build("CCCWCC", random.Random(17), tesseract=False)
        for word in words:
            word["ocr_evidence"]["engine_statuses"] = {
                "paddleocr": "success", "vietocr": "success", "tesseract": "error"}
        self.assertEqual(counts(classify_page(words, reference)), {"green": 5, "red": 1, "yellow": 0})

    def test_f18_page_after_a_retry(self):
        first = classify_page(*build("CCWCUC", random.Random(18)))
        second = classify_page(*build("CCWCUC", random.Random(18)))
        self.assertEqual(first, second)

    def test_f19_page_with_an_admin_correction_and_f20_text_update(self):
        words, reference = build("CCWCC", random.Random(19))
        classify_page(words, reference)
        revision = type("Revision", (), {"ProcessingMeta": _persisted_metadata(words)})()
        rows = [_row(index, str(word["text"])) for index, word in enumerate(words)]
        texts = [str(word["text"]) for word in words]
        texts[2] = reference.split()[2]          # Admin corrects the wrong word
        texts[4] = texts[4] + "x"                # and changes another one
        draft = [{"word_index": i, "text": t, "bbox": list(rows[i].BoundingBox), "ocr_confidence": None}
                 for i, t in enumerate(texts)]
        AdminOcrService._set_word_review_statuses(revision, draft, rows)
        meta = revision.ProcessingMeta
        colors = [classify_word_evidence(s, e, t) for s, e, t in zip(
            meta["word_review_statuses"], meta["word_evidence_v2"], texts)]
        self.assertEqual(colors, ["green", "green", "green", "green", "yellow"])

    def test_f21_page_with_a_punctuation_correction(self):
        words, reference = build("CCPCC", random.Random(21))
        classify_page(words, reference)
        evidence = words[2]["ocr_evidence"]
        fixed = str(words[2]["text"])[:-1] + "!"
        self.assertEqual(punctuation_status(str(words[2]["text"]), evidence), "incorrect")
        self.assertEqual(punctuation_status(fixed, evidence), "correct")
        self.assertEqual(classify_word_evidence("needs_review", evidence, fixed), "green")

    def test_f22_page_with_an_inserted_token_and_f23_a_deleted_token(self):
        inserted = classify_page(*build("CCUCC", random.Random(22)))
        self.assertEqual(inserted, ["green", "green", "yellow", "green", "green"])
        words, reference = build("CCCC", random.Random(23))
        self.assertEqual(classify_page(words[:2] + words[3:], reference), ["green"] * 3)

    def test_f24_page_with_split_and_merge(self):
        words = [engine_word(t, token_index=i) for i, t in enumerate("bữa sá ng củaan".split())]
        self.assertEqual(classify_page(words, "bữa sáng của an"),
                         ["green", "yellow", "yellow", "yellow"])

    def test_f25_page_with_reference_alignment_ambiguity(self):
        words = [engine_word(t, token_index=i) for i, t in enumerate("bữa sang zzq của".split())]
        colors = classify_page(words, "bữa sáng của")
        self.assertEqual(colors, ["green", "yellow", "yellow", "green"])
        self.assertNotIn("red", colors)


# --- GROUP A + G: real engines --------------------------------------------
def _benchmark():
    scripts = str(BACKEND_ROOT / "scripts")
    if scripts not in sys.path:
        sys.path.insert(0, scripts)
    name = "ocr_color_benchmark"
    if name in sys.modules:
        return sys.modules[name]
    spec = importlib.util.spec_from_file_location(name, BACKEND_ROOT / "scripts" / f"{name}.py")
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


# Measured floors per image condition (exact word accuracy, GREEN recall on
# correct words). They are regression floors a little below the measured
# values in docs/ocr-color-benchmark.md, not acceptance targets.
CONDITION_FLOORS = {
    "clean": (0.96, 0.90), "low_light": (0.90, 0.85), "shadow": (0.92, 0.85),
    "curved": (0.96, 0.90), "rotated": (0.96, 0.90), "small_text": (0.95, 0.88),
    "mixed_background": (0.90, 0.75), "bold": (0.96, 0.88), "italic": (0.96, 0.85),
    "blur": (0.96, 0.90), "noise": (0.92, 0.85), "compressed": (0.96, 0.90),
    "over_exposed": (0.96, 0.90), "uneven_light": (0.94, 0.88), "near_edge": (0.96, 0.90),
    "serif": (0.96, 0.90), "punctuation": (0.96, 0.85), "dialogue": (0.92, 0.80),
    "diacritic_matrix": (0.85, 0.75), "diacritic_matrix_lowercase": (0.92, 0.85),
}


@unittest.skipUnless(
    ocr_engine.PaddleOCR is not None and ocr_engine.Predictor is not None,
    "PaddleOCR and VietOCR are not installed; real-OCR tests need both engines",
)
class RealOcrIntegration(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        try:
            _paddle, vietocr = ocr_engine._get_ocr_engines()
        except ocr_engine.OcrEngineUnavailable as exc:
            raise unittest.SkipTest(f"OCR models are not available: {exc}")
        if vietocr is None or not ocr_engine._configure_tesseract():
            raise unittest.SkipTest("VietOCR weights or Tesseract are not available")
        cls.benchmark = _benchmark()
        cls.results = {}
        for fixture in cls.benchmark.load_fixtures():
            cls.results.setdefault(fixture["condition"], []).append(
                cls.benchmark.evaluate_fixture(fixture))

    def _rows(self, condition):
        return [row for result in self.results[condition] for row in result["words"]]

    def test_a_diacritic_matrix_words_on_images(self):
        """60 look-alike words drawn on images: each is colored from its own truth."""
        seen = set()
        for condition in ("diacritic_matrix", "diacritic_matrix_lowercase"):
            for row in self._rows(condition):
                if row["truth"] is None:
                    continue
                seen.add(normalize_word(row["truth"]))
                with self.subTest(condition=condition, ground_truth=row["truth"], ocr_output=row["text"]):
                    if row["truth_state"] == "correct":
                        self.assertEqual(row["with_reference_color"], "green")
                    elif row["reference_alignment"] == "substitute":
                        self.assertEqual(row["with_reference_color"], "red")
                    # Without a reference a misread look-alike is never confirmed.
                    if row["truth_state"] == "incorrect":
                        self.assertNotEqual(row["no_reference_color"], "red")
        self.assertGreaterEqual(len(seen), 60)

    def test_a_no_misread_look_alike_is_confirmed_green(self):
        wrong_green = [
            (row["truth"], row["text"]) for condition in ("diacritic_matrix", "diacritic_matrix_lowercase")
            for row in self._rows(condition)
            if row["truth_state"] == "incorrect" and row["no_reference_color"] == "green"]
        self.assertEqual(wrong_green, [])

    def test_g_recognition_and_green_recall_floor_per_condition(self):
        for condition, (accuracy_floor, recall_floor) in CONDITION_FLOORS.items():
            results = self.results[condition]
            rows = self._rows(condition)
            truth = sum(result["truth_words"] for result in results)
            correct = [row for row in rows if row["truth_state"] == "correct"]
            green = [row for row in correct if row["no_reference_color"] == "green"]
            with self.subTest(condition=condition):
                self.assertGreaterEqual(len(correct) / truth, accuracy_floor)
                self.assertGreaterEqual(len(green) / len(correct), recall_floor)

    def test_g_childrens_font_is_a_known_recognition_limit(self):
        """Both Vietnamese engines misread this font; the words must stay unconfirmed."""
        rows = self._rows("childrens_font")
        wrong = [row for row in rows if row["truth_state"] == "incorrect"]
        self.assertTrue(wrong, "expected misreadings on the children's-book font")
        self.assertEqual([row for row in wrong if row["no_reference_color"] == "green"], [])
        self.assertTrue(all(row["with_reference_color"] in {"red", "yellow"} for row in wrong))

    def test_g_dense_punctuation_pages_keep_their_marks(self):
        for condition, floor in (("punctuation", 0.85), ("dialogue", 0.80)):
            data = self.benchmark.metrics.merge_text_metrics(
                [result["engine_metrics"]["hybrid"] for result in self.results[condition]])
            hits, total = data["punct_recall"]
            with self.subTest(condition=condition):
                self.assertGreaterEqual(hits / total, floor)
                self.assertEqual(data["alignment"][0], data["alignment"][1])

    def test_g_dialogue_dash_is_kept_in_the_page_text(self):
        fixture = next(f for f in self.benchmark.load_fixtures() if f["fixture_id"] == "vi_dialogue_01")
        result = ocr_engine.extract_text_and_boxes(fixture["_png"])
        first_tokens = [line.split()[0] for line in result["text"].splitlines() if line.split()]
        self.assertTrue(any(not normalize_word(token) for token in first_tokens),
                        msg=f"no line keeps its opening dash: {result['text']!r}")

    def test_g_uppercase_title_line(self):
        rows = [row for row in self._rows("clean") if row["truth"] in {"BỮA", "SÁNG", "CỦA", "AN"}]
        self.assertEqual(len(rows), 4)
        self.assertTrue(all(row["truth_state"] == "correct" for row in rows))

    def test_g_measured_boxes_cover_the_words(self):
        ious = [row["iou"] for condition in ("clean", "serif", "bold", "punctuation")
                for row in self._rows(condition) if row["iou"] is not None]
        self.assertGreaterEqual(float(np.mean(ious)), 0.80)

    def test_g_whole_set_gates(self):
        rows = [row for results in self.results.values() for result in results for row in result["words"]]
        paired = [row for row in rows if row["truth_state"] != "ambiguous"]
        green = [row for row in paired if row["no_reference_color"] == "green"]
        self.assertEqual([row for row in green if row["truth_state"] != "correct"], [])
        self.assertFalse([row for row in rows if row["no_reference_color"] == "red"])
        for row in paired:
            expected = "green" if row["truth_state"] == "correct" else None
            if expected:
                self.assertEqual(row["with_reference_color"], "green")

    def test_g_real_book_photographs_are_not_available(self):
        real_books = BACKEND_ROOT / "tests" / "fixtures" / "ocr_real_books"
        if not any(real_books.glob("*.json")):
            self.skipTest(
                "No independently verified photographs or scans of real books are in the "
                "repository; Gate E (real book images) is NOT met and is not claimed.")


if __name__ == "__main__":
    unittest.main()
