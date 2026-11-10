"""Multi-engine adjudication, word crops, reference alignment, Vietnamese
token rules and the real-OCR fixture gate.

Groups (see the three-color acceptance spec):
  A  Vietnamese recognition rules   D  Multi-engine evidence
  B  Image quality (real engines)   E  Reference alignment
  C  Bounding box and crop
"""
from __future__ import annotations

import importlib.util
import json
import sys
import unicodedata
import unittest
from pathlib import Path
from unittest.mock import patch

import cv2
import numpy as np

from ocr_color_testkit import (
    GREEN_WORDS,
    classify_page,
    classify_word,
    completed_crop,
    corrupt,
    engine_word,
)

from app.services import ocr_engine
from app.services.admin_ocr_service import AdminOcrService
from app.services.ocr_adjudication import (
    adjudicate_word,
    adjudication_token,
    collect_word_readings,
    replace_token_core,
)
from app.services.ocr_engine import align_ocr_tokens, normalize_word
from app.services.ocr_evidence import (
    crop_word_region,
    find_split_merge_candidates,
    token_alignment_cost,
)

BACKEND_ROOT = Path(__file__).resolve().parent
SUCCESS = {"paddleocr": "success", "vietocr": "success", "tesseract": "success"}


def three_engines(text, *, paddle, vietocr, tesseract, crop=None, **kwargs):
    """A word for which Tesseract ran as the second Vietnamese engine."""
    # Without an explicit crop the builder mirrors the pipeline: "not_needed"
    # when PaddleOCR and VietOCR agree at line level, "skipped" otherwise.
    word = engine_word(text, paddle=paddle, vietocr=vietocr, statuses=dict(SUCCESS),
                       crop_evidence=crop, **kwargs)
    if tesseract is not None:
        word["ocr_evidence"]["engine_outputs"]["tesseract"] = tesseract
    return word


# --- GROUP A: Vietnamese recognition rules --------------------------------
TONE_ONLY_PAIRS = [
    ("ma", "má"), ("ma", "mà"), ("ma", "mả"), ("ma", "mã"), ("ma", "mạ"),
    ("má", "mà"), ("mả", "mã"), ("bà", "bả"), ("của", "cũa"), ("ngồi", "ngỏi"),
    ("chào", "chảo"), ("bữa", "bừa"), ("sữa", "sửa"), ("rỡ", "rõ"), ("kể", "kề"),
    ("thả", "thà"), ("nằm", "năm"), ("ấm", "ẩm"), ("tối", "tói"), ("đẹp", "đẻp"),
]
VOWEL_PAIRS = [
    ("ăn", "an"), ("ân", "an"), ("ăn", "ân"), ("ên", "en"), ("ôm", "om"),
    ("ơn", "on"), ("ôn", "ơn"), ("ưa", "ua"), ("cơm", "com"), ("mưa", "mua"),
]
D_STROKE_PAIRS = [
    ("đi", "di"), ("đẹp", "dẹp"), ("đường", "dường"), ("đêm", "dêm"), ("đất", "dất"),
    ("đậu", "dậu"), ("đũa", "dũa"), ("đồi", "dồi"), ("đèn", "dèn"), ("Đàn", "Dàn"),
]
STACKED_MARK_WORDS = [
    "bữa", "sữa", "chuẩn", "xuống", "trường", "giường", "nguyễn", "truyện", "thuở", "khuỷu",
]
UPPERCASE_WORDS = ["BỮA", "SÁNG", "CỦA", "ĐẸP", "XUỐNG"]


class VietnameseTokenRules(unittest.TestCase):
    def test_a01_tone_only_differences_are_never_equal_and_always_red(self):
        for truth, wrong in TONE_ONLY_PAIRS:
            with self.subTest(ground_truth=truth, ocr_output=wrong):
                self.assertNotEqual(normalize_word(truth), normalize_word(wrong))
                self.assertGreater(token_alignment_cost(truth, wrong), 0)
                self.assertEqual(classify_page([engine_word(wrong)], truth), ["red"])
                self.assertEqual(classify_page([engine_word(truth)], truth), ["green"])

    def test_a02_vowel_quality_differences_are_red(self):
        for truth, wrong in VOWEL_PAIRS:
            with self.subTest(ground_truth=truth, ocr_output=wrong):
                self.assertEqual(classify_page([engine_word(wrong)], truth), ["red"])
                self.assertEqual(classify_page([engine_word(truth)], wrong), ["red"])

    def test_a03_d_stroke_differences_are_red(self):
        for truth, wrong in D_STROKE_PAIRS:
            with self.subTest(ground_truth=truth, ocr_output=wrong):
                self.assertEqual(classify_page([engine_word(wrong)], truth), ["red"])

    def test_a04_words_with_stacked_marks_match_exactly_and_only_exactly(self):
        for truth in STACKED_MARK_WORDS:
            with self.subTest(word=truth):
                self.assertEqual(classify_page([engine_word(truth)], truth), ["green"])
                for category in ("tone_dropped", "all_marks_dropped", "circumflex_dropped",
                                 "horn_dropped", "breve_dropped"):
                    wrong = corrupt(truth, category)
                    if wrong:
                        self.assertEqual(classify_page([engine_word(wrong)], truth), ["red"],
                                         msg=f"{truth} vs {wrong} ({category})")

    def test_a05_uppercase_words_match_case_insensitively_but_keep_marks(self):
        for truth in UPPERCASE_WORDS:
            with self.subTest(word=truth):
                self.assertEqual(classify_page([engine_word(truth.lower())], truth), ["green"])
                self.assertEqual(classify_page([engine_word(truth.capitalize())], truth), ["green"])
                wrong = corrupt(truth, "all_marks_dropped")
                self.assertEqual(classify_page([engine_word(wrong)], truth), ["red"])

    def test_a06_unicode_nfc_and_nfd_are_the_same_token(self):
        for truth in ("bữa", "ĐẸP", "nguyễn", "khuỷu", "trường"):
            nfc = unicodedata.normalize("NFC", truth)
            nfd = unicodedata.normalize("NFD", truth)
            with self.subTest(word=truth):
                self.assertNotEqual(nfc, nfd)
                self.assertEqual(normalize_word(nfc), normalize_word(nfd))
                self.assertEqual(adjudication_token(nfc), adjudication_token(nfd))
                self.assertEqual(token_alignment_cost(nfc, nfd), 0.0)
                self.assertEqual(classify_page([engine_word(nfd)], nfc), ["green"])

    def test_a07_accent_folding_is_only_an_alignment_hint(self):
        # Diacritic-only variants pair as a substitution with a non-zero cost.
        self.assertEqual(token_alignment_cost("sáng", "sang"), 0.3)
        steps = align_ocr_tokens(["bữa", "sáng"], ["bừa", "sang"])
        self.assertEqual([step["operation"] for step in steps], ["substitute", "substitute"])

    def test_a08_adjudication_token_rejects_non_tokens(self):
        for value in (None, 5, "", "   ", "...", "hai từ", "vào li vào li"):
            with self.subTest(value=value):
                self.assertIsNone(adjudication_token(value))
        self.assertEqual(adjudication_token(' "Sáng," '), "sáng")

    def test_a09_replace_token_core_keeps_outer_punctuation_and_candidate_case(self):
        self.assertEqual(replace_token_core('"ngỏi,', "ngồi"), '"ngồi,')
        self.assertEqual(replace_token_core("BỪA", "BỮA."), "BỮA")
        self.assertEqual(replace_token_core("cô.", "cổ"), "cổ.")


# --- GROUP D: multi-engine evidence ---------------------------------------
def _engine_cases():
    w = "SÁNG"
    yield "D01 three engines agree", three_engines(w, paddle=w, vietocr=w, tesseract=w), "green"
    yield "D02 both Vietnamese engines agree, PaddleOCR drops the mark", three_engines(
        w, paddle="SANG", vietocr=w, tesseract=w), "green"
    yield "D03 both Vietnamese engines agree, PaddleOCR garbles the word", three_engines(
        "ngồi", paddle="ngi", vietocr="ngồi", tesseract="ngồi"), "green"
    yield "D04 both Vietnamese engines agree, PaddleOCR token missing", three_engines(
        w, paddle=None, vietocr=w, tesseract=w, alignment="unmatched"), "green"
    yield "D05 Vietnamese engines differ only in marks", three_engines(
        w, paddle=w, vietocr=w, tesseract="SẢNG"), "yellow"
    yield "D06 Tesseract reads more marks than PaddleOCR + VietOCR", three_engines(
        "ám", paddle="ám", vietocr="ám", tesseract="ấm"), "yellow"
    yield "D07 Tesseract ran but paired no token: PaddleOCR cannot confirm", three_engines(
        "canh", paddle="canh", vietocr="canh", tesseract=None), "yellow"
    yield "D08 Tesseract reads different letters once: majority still not two Vietnamese engines", three_engines(
        w, paddle=w, vietocr=w, tesseract="SÓNG"), "yellow"
    yield "D09 legacy evidence without Tesseract: PaddleOCR + VietOCR agreement", engine_word(w), "green"
    yield "D10 legacy evidence, engines disagree", engine_word(w, paddle="SANG"), "yellow"
    yield "D11 VietOCR failed", engine_word(w, statuses={
        "paddleocr": "success", "vietocr": "error", "tesseract": "not_run"}), "yellow"
    yield "D12 VietOCR not installed", engine_word(w, vietocr=None, selected="paddleocr", statuses={
        "paddleocr": "success", "vietocr": "not_installed", "tesseract": "not_run"}), "yellow"
    yield "D13 VietOCR model missing (not initialized)", engine_word(w, vietocr=None, selected="paddleocr", statuses={
        "paddleocr": "success", "vietocr": "not_initialized", "tesseract": "not_run"}), "yellow"
    yield "D14 Vietnamese traineddata missing: Tesseract errored", engine_word(w, paddle="SANG", statuses={
        "paddleocr": "success", "vietocr": "success", "tesseract": "error"}), "yellow"
    yield "D15 Tesseract not installed, engines disagree", engine_word(w, paddle="SANG", statuses={
        "paddleocr": "success", "vietocr": "success", "tesseract": "not_installed"}), "yellow"
    yield "D16 VietOCR returned an empty recognition", three_engines(
        w, paddle=w, vietocr="", tesseract=w, selected="paddleocr", alignment="unmatched"), "yellow"
    yield "D17 every recognition is empty", three_engines(
        w, paddle="", vietocr="", tesseract="", alignment="unmatched"), "yellow"
    yield "D18 a reading of the line is a repeated-token hallucination", three_engines(
        "vào", paddle="váo", vietocr="vào", tesseract=None,
        crop=completed_crop("vao", "vào li vào li vào", None)), "yellow"
    yield "D19 split candidate", three_engines(
        "BỮASÁNG", paddle=None, vietocr="BỮASÁNG", tesseract="BỮASÁNG", alignment="split"), "yellow"
    yield "D20 merge candidate", three_engines(
        "BỮA", paddle=None, vietocr="BỮA", tesseract="BỮA", alignment="merge"), "yellow"
    yield "D21 token order unknown (no anchored index)", _unanchored(), "yellow"
    yield "D22 crop readings confirm when the line engines agree too", three_engines(
        w, paddle="SANG", vietocr=w, tesseract=w, crop=completed_crop("SANG", w, w)), "green"
    yield "D23 VietOCR crop contradicts with other marks", three_engines(
        w, paddle="SANG", vietocr=w, tesseract=w, crop=completed_crop("SANG", "SẢNG", w)), "yellow"
    yield "D24 Tesseract crop contradicts its own line reading", three_engines(
        "chảo", paddle="cháo", vietocr="chảo", tesseract="chào",
        crop=completed_crop("chao", "chảo", "chảo")), "yellow"
    yield "D25 Tesseract page missed the word, both crops confirm", three_engines(
        w, paddle="SANG", vietocr=w, tesseract=None, crop=completed_crop("SANG", w, w)), "green"
    yield "D26 only VietOCR line and VietOCR crop agree: one engine", three_engines(
        w, paddle="SANG", vietocr=w, tesseract=None, crop=completed_crop("SANG", w, None)), "yellow"
    yield "D27 crop pass failed for VietOCR", three_engines(
        w, paddle="SANG", vietocr=w, tesseract=None,
        crop={"status": "partial", "vietocr_error": "RuntimeError"}), "yellow"
    yield "D28 crop reading stored together with an engine error is ignored", three_engines(
        w, paddle="SANG", vietocr=w, tesseract=None,
        crop=completed_crop("SANG", w, w, tesseract_error="TesseractError")), "yellow"
    yield "D29 bounding box rejected", three_engines(
        w, paddle=w, vietocr=w, tesseract=w, bbox_quality="rejected"), "yellow"
    yield "D30 crop clipped by the page edge", three_engines(
        w, paddle=w, vietocr=w, tesseract=w, crop_quality="weak"), "yellow"
    yield "D31 displayed text differs from what the engines confirmed", three_engines(
        "SẢNG", paddle="SANG", vietocr="SÁNG", tesseract="SÁNG", selected="vietocr"), "yellow"
    yield "D32 mark-free word confirmed by both Vietnamese engines", three_engines(
        "nay", paddle="nay", vietocr="nay", tesseract="nay"), "green"
    yield "D33 mark-free word, PaddleOCR differs, Vietnamese engines agree", three_engines(
        "nay", paddle="may", vietocr="nay", tesseract="nay"), "green"
    yield "D34 punctuation and case differ between engines", three_engines(
        "Sáng,", paddle="sang", vietocr="Sáng,", tesseract="SÁNG."), "green"
    yield "D35 NFD reading from one engine", three_engines(
        w, paddle="SANG", vietocr=w, tesseract=unicodedata.normalize("NFD", w)), "green"
    yield "D36 Tesseract status missing from stored statuses", engine_word(
        w, paddle="SANG", statuses={"paddleocr": "success", "vietocr": "success"}), "yellow"
    yield "D37 engine output present but its status is not success", _status_mismatch(), "yellow"
    yield "D38 raw crop scores are extreme but readings agree", three_engines(
        w, paddle="SANG", vietocr=w, tesseract=w, crop=completed_crop(
            "SANG", w, w, paddle_crop_recognition_score=0.0, vietocr_crop_recognition_score=0.0)), "green"
    yield "D39 raw crop scores are perfect but readings disagree", three_engines(
        w, paddle="SANG", vietocr=w, tesseract=None, crop=completed_crop(
            "SANG", "SANG", None, paddle_crop_recognition_score=1.0, vietocr_crop_recognition_score=1.0)), "yellow"
    yield "D40 two different wrong readings oppose one confirmed token", three_engines(
        w, paddle="SANG", vietocr=w, tesseract=w, crop=completed_crop("SANG", "SONG", "SING")), "yellow"
    yield "D41 single-engine Tesseract fallback page", _tesseract_fallback_word(), "yellow"
    yield "D42 insert alignment, Vietnamese engines agree", three_engines(
        w, paddle=None, vietocr=w, tesseract=w, alignment="insert"), "green"
    yield "D43 alignment not computed", three_engines(
        w, paddle=w, vietocr=w, tesseract=w, alignment="not_computed"), "yellow"
    yield "D44 unresolved alignment", three_engines(
        w, paddle=w, vietocr=w, tesseract=w, alignment="unresolved"), "yellow"
    yield "D45 selected engine is PaddleOCR and Vietnamese engines back its token", three_engines(
        "AN", paddle="AN", vietocr="AN", tesseract="AN", selected="paddleocr"), "green"


def _unanchored():
    word = three_engines("SÁNG", paddle="SANG", vietocr="SÁNG", tesseract="SÁNG")
    word["ocr_evidence"]["paddle_token_index"] = None
    word["ocr_evidence"]["vietocr_token_index"] = None
    return word


def _status_mismatch():
    word = three_engines("SÁNG", paddle="SANG", vietocr="SÁNG", tesseract="SÁNG")
    word["ocr_evidence"]["engine_statuses"]["tesseract"] = "error"
    return word


def _tesseract_fallback_word():
    return {
        "text": "SÁNG", "ocr_review_status": "needs_review", "ocr_confidence": 0.96,
        "ocr_evidence": {
            "contract": "tesseract_raw_word_score_v1",
            "engine_outputs": {"tesseract": "SÁNG"},
            "engine_statuses": {"paddleocr": "not_installed", "vietocr": "not_run", "tesseract": "success"},
            "source_text": "SÁNG", "selected_engine": "tesseract", "alignment": "single_engine",
            "engine_agreement_score": None, "calibrated_word_accuracy": None,
            "verification_source": None, "reference_text": None,
            "review_reason": "single engine",
        },
    }


class MultiEngineEvidence(unittest.TestCase):
    def test_d_engine_scenarios(self):
        seen = 0
        for name, word, expected in _engine_cases():
            with self.subTest(case=name):
                self.assertEqual(classify_word(word), expected)
                seen += 1
        self.assertEqual(seen, 45)

    def test_no_engine_scenario_is_ever_red_without_a_reference(self):
        for name, word, _expected in _engine_cases():
            with self.subTest(case=name):
                self.assertNotEqual(classify_word(word), "red")

    def test_every_engine_scenario_follows_the_reference_once_one_exists(self):
        for name, word, _expected in _engine_cases():
            text = str(word["text"])
            with self.subTest(case=name, reference="match"):
                self.assertEqual(classify_page([json.loads(json.dumps(word))], text), ["green"])
            with self.subTest(case=name, reference="mismatch"):
                self.assertEqual(
                    classify_page([json.loads(json.dumps(word))], text + "x"), ["red"])

    def test_readings_require_a_successful_engine_status(self):
        word = three_engines("SÁNG", paddle="SANG", vietocr="SÁNG", tesseract="SÁNG")
        evidence = AdminOcrService._normalize_word_evidence(word["ocr_evidence"])
        self.assertEqual(set(collect_word_readings(evidence)),
                         {"paddleocr_line", "vietocr_line", "tesseract_line"})
        evidence["engine_statuses"] = {"paddleocr": "success"}
        self.assertEqual(set(collect_word_readings(evidence)), {"paddleocr_line"})

    def test_preferred_reading_is_a_display_choice_not_a_confirmation(self):
        word = three_engines("ngỏi", paddle="ngi", vietocr="ngỏi", tesseract="ngồi",
                             crop=completed_crop("ngi", "ngồi", None))
        decision = adjudicate_word(AdminOcrService._normalize_word_evidence(word["ocr_evidence"]))
        self.assertEqual(decision["status"], "unresolved")
        self.assertEqual(decision["preferred_text"], "ngồi")
        self.assertEqual(classify_word(word), "yellow")

    def test_a_barer_reading_is_never_preferred_over_a_richer_one(self):
        word = three_engines("SÁNG", paddle="SANG", vietocr="SÁNG", tesseract="SANG",
                             crop=completed_crop("SANG", "SANG", "SANG"))
        decision = adjudicate_word(AdminOcrService._normalize_word_evidence(word["ocr_evidence"]))
        self.assertIsNone(decision["preferred_text"])
        self.assertEqual(decision["status"], "unresolved")


class EnginePipelineAdjudication(unittest.TestCase):
    """The pipeline step that applies adjudication to freshly recognized words."""

    def _image(self):
        image = np.full((200, 400, 3), 255, dtype=np.uint8)
        cv2.putText(image, "ngoi", (120, 110), cv2.FONT_HERSHEY_SIMPLEX, 1.4, (0, 0, 0), 3)
        return image

    def _word(self, **overrides):
        word = three_engines("ngỏi,", paddle="ngi", vietocr="ngỏi,", tesseract="ngồi",
                             crop=completed_crop("ngi", "ngồi", None))
        word["bbox"] = [0.25, 0.35, 0.35, 0.3]
        word["line_index"] = 0
        word.update(overrides)
        return word

    def test_text_switches_to_the_better_supported_reading_and_keeps_history(self):
        word = self._word()
        with patch.object(ocr_engine, "_recognize_crop_with_tesseract", return_value=("ngồi", None)):
            stats = ocr_engine._adjudicate_disputed_words(self._image(), [word])
        self.assertEqual(word["text"], "ngồi,")              # punctuation preserved
        self.assertEqual(word["normalized_text"], "ngồi")
        evidence = word["ocr_evidence"]
        self.assertEqual(evidence["crop_evidence"]["text_before_adjudication"], "ngỏi,")
        self.assertEqual(evidence["engine_outputs"]["vietocr"], "ngỏi,")   # original output kept
        self.assertEqual(evidence["source_text"], "ngồi,")
        self.assertEqual(stats["text_changed"], 1)
        # Vietnamese engines still differ in marks: displayed, not confirmed.
        self.assertEqual(classify_word(word), "yellow")

    def test_settled_words_are_not_touched(self):
        word = three_engines("SÁNG", paddle="SANG", vietocr="SÁNG", tesseract="SÁNG",
                             crop={"status": "not_needed"})
        with patch.object(ocr_engine, "_recognize_crop_with_tesseract") as tesseract:
            stats = ocr_engine._adjudicate_disputed_words(self._image(), [word])
        tesseract.assert_not_called()
        self.assertEqual(word["text"], "SÁNG")
        self.assertEqual(stats["text_changed"], 0)
        self.assertEqual(word["ocr_evidence"]["crop_evidence"]["adjudication_status"], "resolved")
        self.assertEqual(classify_word(word), "green")

    def test_tesseract_failure_on_a_crop_leaves_the_word_unresolved(self):
        word = self._word()
        word["ocr_evidence"]["engine_outputs"]["tesseract"] = None
        with patch.object(ocr_engine, "_recognize_crop_with_tesseract",
                          return_value=(None, "TesseractError")):
            ocr_engine._adjudicate_disputed_words(self._image(), [word])
        self.assertEqual(word["text"], "ngỏi,")
        self.assertEqual(word["ocr_evidence"]["crop_evidence"]["tesseract_error"], "TesseractError")
        self.assertEqual(classify_word(word), "yellow")

    def test_tesseract_lines_are_paired_by_alignment_not_by_position(self):
        words = []
        for index, text in enumerate(["Hôm", "nay", "trời"]):
            word = engine_word(text, paddle=text, token_index=index)
            word["bbox"] = [0.05 + index * 0.3, 0.4, 0.25, 0.2]
            word["line_index"] = 0
            words.append(word)
        data = {
            # Tesseract dropped the middle word; pairing must not shift.
            "text": ["", "Hôm", "trời", ""],
            "left": [0, 20, 260, 0], "top": [0, 80, 80, 0],
            "width": [0, 100, 100, 0], "height": [0, 40, 40, 0],
            "block_num": [1, 1, 1, 1], "par_num": [1, 1, 1, 1], "line_num": [1, 1, 1, 1],
        }
        with (
            patch.object(ocr_engine, "_configure_tesseract", return_value=True),
            patch.object(ocr_engine.pytesseract, "image_to_data", return_value=data),
        ):
            stats = ocr_engine._attach_tesseract_line_readings(self._image(), words)
        self.assertEqual(stats["status"], "success")
        outputs = [word["ocr_evidence"]["engine_outputs"].get("tesseract") for word in words]
        self.assertEqual(outputs, ["Hôm", None, "trời"])
        self.assertTrue(all(
            word["ocr_evidence"]["engine_statuses"]["tesseract"] == "success" for word in words))

    def test_missing_tesseract_is_reported_truthfully(self):
        word = engine_word("Hôm")
        word["bbox"], word["line_index"] = [0.1, 0.4, 0.3, 0.2], 0
        with patch.object(ocr_engine, "_configure_tesseract", return_value=False):
            stats = ocr_engine._attach_tesseract_line_readings(self._image(), [word])
        self.assertEqual(stats["status"], "not_installed")
        self.assertEqual(word["ocr_evidence"]["engine_statuses"]["tesseract"], "not_installed")

    def test_background_normalization_keeps_dark_text_dark_on_a_dim_page(self):
        dim = np.full((120, 300), 80, dtype=np.uint8)
        cv2.putText(dim, "nang", (40, 80), cv2.FONT_HERSHEY_SIMPLEX, 1.5, 10, 3)
        normalized = ocr_engine._normalize_text_background(dim)
        self.assertGreater(float(np.median(normalized)), 200)      # background became light
        self.assertLess(float(normalized.min()), 80)               # text stayed dark
        inverted = cv2.bitwise_not(dim)                            # light text on dark
        self.assertGreater(float(np.median(ocr_engine._normalize_text_background(inverted))), 200)


# --- GROUP C: bounding box and crop ---------------------------------------
def _page(background=255, ink=20, *, text="SÁNG", origin=(160, 230), scale=2.0, size=(400, 600)):
    image = np.full((size[0], size[1], 3), background, dtype=np.uint8)
    cv2.putText(image, text, origin, cv2.FONT_HERSHEY_SIMPLEX, scale, (ink, ink, ink), 4)
    return image


WORD_BOX = [0.25, 0.42, 0.42, 0.18]  # around the rendered word


def _crop_cases():
    page = _page()
    yield "C01 correct box", page, WORD_BOX, "valid", "usable", None
    yield "C02 shifted box still containing ink", page, [0.3, 0.44, 0.42, 0.18], "valid", "usable", None
    yield "C03 box below the minimum size", page, [0.3, 0.45, 0.01, 0.01], "rejected", "unavailable", "bbox_too_small"
    yield "C04 box larger than the word", page, [0.15, 0.3, 0.65, 0.42], "valid", "usable", None
    yield "C05 box with implausibly tall geometry", page, [0.3, 0.1, 0.02, 0.8], "rejected", "unavailable", "implausible_word_geometry"
    yield "C06 box with implausibly wide geometry", page, [0.0, 0.48, 1.0, 0.03], "rejected", "unavailable", "implausible_word_geometry"
    yield "C07 box at the top edge (marks could be cut)", _page(origin=(160, 60)), [0.25, 0.0, 0.42, 0.18], "valid", "weak", "padding_touched_image_edge"
    yield "C08 box at the bottom edge", _page(origin=(160, 390)), [0.25, 0.82, 0.42, 0.18], "valid", "weak", "padding_touched_image_edge"
    yield "C09 box at the left edge", _page(origin=(2, 230)), [0.0, 0.42, 0.42, 0.18], "valid", "weak", "padding_touched_image_edge"
    yield "C10 box at the right edge", _page(origin=(340, 230)), [0.58, 0.42, 0.42, 0.18], "valid", "weak", "padding_touched_image_edge"
    yield "C11 box containing two words", _page(text="BUA SANG", origin=(60, 230)), [0.08, 0.42, 0.84, 0.18], "valid", "usable", None
    yield "C12 box with no text", page, [0.05, 0.05, 0.3, 0.1], "valid", "weak", "insufficient_visual_signal"
    yield "C13 white background crop", _page(255, 0), WORD_BOX, "valid", "usable", None
    yield "C14 dark background, light text", _page(15, 240), WORD_BOX, "valid", "usable", None
    yield "C15 low contrast text", _page(200, 170), WORD_BOX, "valid", "usable", None
    yield "C16 contrast too low to read", _page(200, 197), WORD_BOX, "valid", "weak", "insufficient_visual_signal"
    yield "C17 high contrast text", _page(255, 0, scale=2.4), WORD_BOX, "valid", "usable", None
    yield "C18 box extending past the right border", page, [0.7, 0.42, 0.42, 0.18], "rejected", "unavailable", "invalid_bbox"
    yield "C19 box extending past the bottom border", page, [0.25, 0.9, 0.42, 0.18], "rejected", "unavailable", "invalid_bbox"
    yield "C20 negative origin", page, [-0.1, 0.42, 0.42, 0.18], "rejected", "unavailable", "invalid_bbox"
    yield "C21 zero width", page, [0.25, 0.42, 0.0, 0.18], "rejected", "unavailable", "invalid_bbox"
    yield "C22 zero height", page, [0.25, 0.42, 0.42, 0.0], "rejected", "unavailable", "invalid_bbox"
    yield "C23 NaN coordinate", page, [float("nan"), 0.42, 0.42, 0.18], "rejected", "unavailable", "invalid_bbox"
    yield "C24 infinite coordinate", page, [0.25, float("inf"), 0.42, 0.18], "rejected", "unavailable", "invalid_bbox"
    yield "C25 boolean coordinate", page, [True, 0.42, 0.42, 0.18], "rejected", "unavailable", "invalid_bbox"
    yield "C26 string coordinates", page, ["0.25", "0.42", "0.42", "0.18"], "rejected", "unavailable", "invalid_bbox"
    yield "C27 three coordinates", page, [0.25, 0.42, 0.42], "rejected", "unavailable", "invalid_bbox"
    yield "C28 box is None", page, None, "rejected", "unavailable", "invalid_bbox"
    yield "C29 pixel coordinates instead of normalized", page, [150, 170, 250, 70], "rejected", "unavailable", "invalid_bbox"
    yield "C30 source image is not an array", "not-an-image", WORD_BOX, "rejected", "unavailable", "invalid_source_image"
    yield "C31 source image too small", np.full((6, 6, 3), 255, np.uint8), WORD_BOX, "rejected", "unavailable", "invalid_source_dimensions"
    yield "C32 four-channel source image", np.full((400, 600, 4), 255, np.uint8), WORD_BOX, "rejected", "unavailable", "unsupported_source_channels"
    yield "C33 grayscale source image", cv2.cvtColor(page, cv2.COLOR_BGR2GRAY), WORD_BOX, "valid", "usable", None
    yield "C34 solid ink (no glyph shape)", np.full((400, 600, 3), 0, np.uint8), WORD_BOX, "valid", "weak", "insufficient_visual_signal"
    yield "C35 small word on a large page", _page(scale=0.8, origin=(250, 215), size=(800, 1200)), [0.2, 0.24, 0.1, 0.045], "valid", "usable", None
    yield "C36 tuple coordinates", page, tuple(WORD_BOX), "valid", "usable", None
    yield "C37 integer zero origin with fractional size", _page(origin=(2, 60)), [0, 0, 0.5, 0.25], "valid", "weak", "padding_touched_image_edge"
    yield "C38 noisy background", _noisy_page(), WORD_BOX, "valid", "usable", None
    yield "C39 colored background", _colored_page(), WORD_BOX, "valid", "usable", None
    yield "C40 blurred word", cv2.GaussianBlur(page, (9, 9), 2.5), WORD_BOX, "valid", "usable", None


def _noisy_page():
    rng = np.random.default_rng(7)
    page = _page().astype(np.float32) + rng.normal(0, 18, (400, 600, 3))
    return np.clip(page, 0, 255).astype(np.uint8)


def _colored_page():
    image = np.zeros((400, 600, 3), dtype=np.uint8)
    image[:] = (172, 226, 244)
    cv2.putText(image, "SÁNG", (160, 230), cv2.FONT_HERSHEY_SIMPLEX, 2.0, (110, 30, 20), 4)
    return image


class BoundingBoxAndCrop(unittest.TestCase):
    def test_c_crop_scenarios(self):
        seen = 0
        for name, image, bbox, bbox_quality, crop_quality, reason in _crop_cases():
            with self.subTest(case=name):
                crop, quality = crop_word_region(image, bbox)
                self.assertEqual(quality["bbox_quality"], bbox_quality)
                self.assertEqual(quality["crop_quality"], crop_quality)
                self.assertEqual(quality.get("reason"), reason)
                if crop_quality == "unavailable" or reason == "insufficient_visual_signal":
                    self.assertIsNone(crop)
                else:
                    self.assertIsNotNone(crop)
                    self.assertGreaterEqual(crop.shape[0], 48)   # upscaled for recognition
                seen += 1
        self.assertEqual(seen, 40)

    def test_expanded_crop_keeps_vertical_room_for_vietnamese_marks(self):
        page = _page()
        crop, quality = crop_word_region(page, WORD_BOX)
        box_height = WORD_BOX[3] * page.shape[0]
        scale = crop.shape[0] / (box_height * 1.9)   # 45% padding above and below
        self.assertFalse(quality["padding_clipped"])
        self.assertAlmostEqual(scale, 1.0, delta=0.15)

    def test_low_contrast_crop_is_contrast_enhanced(self):
        _crop, quality = crop_word_region(_page(200, 170), WORD_BOX)
        self.assertIn("clahe", quality["preprocessing"])

    def test_an_unusable_region_can_never_be_confirmed_by_engines(self):
        for bbox_quality, crop_quality in (("rejected", "unavailable"), ("valid", "weak"),
                                           ("not_checked", None)):
            word = three_engines("SÁNG", paddle="SÁNG", vietocr="SÁNG", tesseract="SÁNG",
                                 bbox_quality=bbox_quality, crop_quality=crop_quality)
            with self.subTest(bbox=bbox_quality, crop=crop_quality):
                self.assertEqual(classify_word(word), "yellow")
                # A verified reference still decides it.
                self.assertEqual(classify_page([word], "SÁNG"), ["green"])

    def test_line_crop_for_vietocr_is_not_stretched(self):
        image = _page(text="Hom nay troi nang dep", origin=(20, 230), scale=1.3)
        quad = [[15.0, 190.0], [560.0, 190.0], [560.0, 245.0], [15.0, 245.0]]
        items = ocr_engine._extract_curved_lines_from_items([[quad, ("x", 0.9)]], image)
        line = items[0]
        text_height = 55.0
        # 20% padding of the quad plus a 4 px border, nothing more.
        self.assertLessEqual(line["dewarped_img"].shape[0], text_height * 1.4 + 8 + 2)
        self.assertGreaterEqual(line["dewarped_img"].shape[0], text_height)


# --- GROUP E: reference alignment -----------------------------------------
def _alignment_cases():
    # name, OCR tokens, reference, expected colors
    yield "E01 exact match", "bữa sáng của an", "bữa sáng của an", "GGGG"
    yield "E02 one substitution", "bữa sang của an", "bữa sáng của an", "GRGG"
    yield "E03 substitution at the first token", "bừa sáng của an", "bữa sáng của an", "RGGG"
    yield "E04 substitution at the last token", "bữa sáng của ân", "bữa sáng của an", "GGGR"
    yield "E05 two separate substitutions", "bừa sáng cua an", "bữa sáng của an", "RGRG"
    yield "E06 two adjacent substitutions", "bữa sang cua an", "bữa sáng của an", "GRRG"
    yield "E07 extra OCR token in the middle", "bữa zzq sáng của an", "bữa sáng của an", "GYGGG"
    yield "E08 extra OCR token at the start", "zzq bữa sáng của an", "bữa sáng của an", "YGGGG"
    yield "E09 extra OCR token at the end", "bữa sáng của an zzq", "bữa sáng của an", "GGGGY"
    yield "E10 OCR missed a token", "bữa của an", "bữa sáng của an", "GGG"
    yield "E11 OCR missed the first token", "sáng của an", "bữa sáng của an", "GGG"
    yield "E12 OCR missed the last token", "bữa sáng của", "bữa sáng của an", "GGG"
    yield "E13 substitution next to an extra token is ambiguous", "bữa sang zzq của an", "bữa sáng của an", "GYYGG"
    yield "E14 substitution next to a missed token is ambiguous", "bừa của an", "bữa sáng của an", "YGG"
    yield "E15 OCR split one word in two", "bữa sá ng của an", "bữa sáng của an", "GYYGG"
    yield "E16 OCR merged two words", "bữasáng của an", "bữa sáng của an", "YGG"
    yield "E17 repeated word, all present", "bà bà đi chợ", "bà bà đi chợ", "GGGG"
    yield "E18 repeated word, one copy wrong", "bà ba đi chợ", "bà bà đi chợ", "GRGG"
    yield "E19 duplicate token read twice by OCR: one copy is extra", "bữa bữa sáng", "bữa sáng", "YGG"
    yield "E20 shifted by one extra leading token", "x bữa sáng của", "bữa sáng của", "YGGG"
    yield "E21 missing punctuation", "hôm nay trời nắng", "hôm nay, trời nắng.", "GGGG"
    yield "E22 different punctuation", "hôm nay; trời nắng!", "hôm nay, trời nắng.", "GGGG"
    yield "E23 a standalone dash is an extra token, neighbours unaffected", "hôm nay - trời", "hôm nay trời", "GGYG"
    yield "E24 several possible pairings for a repeated wrong word", "ba", "bà bà", "Y"
    yield "E25 ambiguous: wrong word between two gaps", "x bừa y", "bữa", "YYY"
    yield "E26 diacritic-only difference", "nha", "nhà", "R"
    yield "E27 same base letter, different vowel", "ôn", "ơn", "R"
    yield "E28 completely different word between matching neighbours", "bữa qwxz của", "bữa sáng của", "GRG"
    yield "E29 completely different single word", "qwxz", "sáng", "R"
    yield "E30 two unrelated words in a row stay undecided", "bữa qwxz plmk an", "bữa sáng của an", "GYYG"
    yield "E31 case differs only", "BỮA Sáng CỦA", "bữa sáng của", "GGG"
    yield "E32 NFD reference", "bữa sáng", unicodedata.normalize("NFD", "bữa sáng"), "GG"
    yield "E33 reference on several lines", "bữa sáng của an", "bữa sáng\ncủa an", "GGGG"
    yield "E34 hyphenated and apostrophe tokens are kept whole", "xì-gà d'accord", "xì-gà d'accord", "GG"
    yield "E35 number tokens", "năm 2026 có 12 tháng", "năm 2025 có 12 tháng", "GRGGG"


COLOR = {"G": "green", "R": "red", "Y": "yellow"}


class ReferenceAlignment(unittest.TestCase):
    def test_e_alignment_scenarios(self):
        seen = 0
        for name, ocr_text, reference, expected in _alignment_cases():
            with self.subTest(case=name):
                words = [engine_word(token, token_index=index)
                         for index, token in enumerate(ocr_text.split())
                         if normalize_word(token)]
                colors = classify_page(words, reference)
                self.assertEqual(colors, [COLOR[letter] for letter in expected])
                # Status, evidence and color always tell the same story.
                for word, color in zip(words, colors):
                    status = word["ocr_review_status"]
                    alignment = word["ocr_evidence"]["reference_alignment"]
                    if color == "red":
                        self.assertEqual((status, alignment), ("confirmed_mismatch", "substitute"))
                    elif color == "green":
                        self.assertEqual((status, alignment), ("reference_match", "match"))
                    else:
                        self.assertEqual(status, "needs_review")
                        self.assertNotIn(alignment, {"match", "substitute"})
                seen += 1
        self.assertEqual(seen, 35)

    def test_alignment_report_lists_every_reference_and_ocr_token(self):
        words = [engine_word(token) for token in "bữa sang zzq của".split()]
        report = AdminOcrService._apply_verified_reference(words, "bữa sáng của an")
        self.assertEqual([step["operation"] for step in report],
                         ["match", "substitute", "insert", "match", "delete"])
        self.assertEqual(report[-1], {"operation": "delete", "reference_token": "an", "ocr_token": None})

    def test_split_and_merge_candidates_are_detected(self):
        self.assertEqual(
            find_split_merge_candidates(["bữasáng"], ["bữa", "sáng"])[0]["operation"], "merge")
        self.assertEqual(
            find_split_merge_candidates(["bữa", "sáng"], ["bữasáng"])[0]["operation"], "split")

    def test_one_gap_does_not_hide_a_mismatch_elsewhere_on_the_page(self):
        tokens = GREEN_WORDS[:30]
        ocr = list(tokens)
        ocr[3] = corrupt(tokens[3], "all_marks_dropped") or tokens[3] + "x"   # wrong word
        ocr.insert(20, "zzq")                                                  # unrelated extra token
        words = [engine_word(token, token_index=index) for index, token in enumerate(ocr)]
        colors = classify_page(words, " ".join(tokens))
        self.assertEqual(colors[3], "red")
        self.assertEqual(colors[20], "yellow")
        self.assertEqual(colors.count("green"), 29)


# --- Frontend parity fixture ----------------------------------------------
class FrontendParityFixture(unittest.TestCase):
    def test_exported_cases_match_the_current_backend_classifier(self):
        spec = importlib.util.spec_from_file_location(
            "export_ocr_color_parity", BACKEND_ROOT / "scripts" / "export_ocr_color_parity.py")
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        if not module.OUTPUT.is_file():
            self.skipTest("frontend checkout is not present next to backend")
        self.assertEqual(
            json.loads(module.OUTPUT.read_text(encoding="utf-8")), json.loads(module.render()),
            "Backend color rules changed: run `python scripts/export_ocr_color_parity.py` "
            "and update the frontend classifier to match.",
        )


# --- GROUP B: image quality, real engines ---------------------------------
def _load_benchmark():
    spec = importlib.util.spec_from_file_location(
        "ocr_color_benchmark", BACKEND_ROOT / "scripts" / "ocr_color_benchmark.py")
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


class GroundTruthFixtures(unittest.TestCase):
    def test_fixture_set_is_complete_and_ground_truth_is_authored(self):
        benchmark = _load_benchmark()
        fixtures = benchmark.load_fixtures()
        self.assertEqual(len(fixtures), 45)
        self.assertEqual({fixture["condition"] for fixture in fixtures}, set(benchmark.CONDITIONS))
        authored = {token for sentence in benchmark.SENTENCES for token in sentence.split()}
        for fixture in fixtures:
            with self.subTest(fixture=fixture["fixture_id"]):
                self.assertTrue(fixture["verified"])
                self.assertEqual(fixture["expected_text"].split(), fixture["expected_words"])
                self.assertTrue(set(fixture["expected_words"]) <= authored)
                image = cv2.imdecode(np.frombuffer(fixture["_png"], np.uint8), cv2.IMREAD_COLOR)
                self.assertEqual((image.shape[1], image.shape[0]), (fixture["width"], fixture["height"]))


@unittest.skipUnless(
    ocr_engine.PaddleOCR is not None and ocr_engine.Predictor is not None,
    "PaddleOCR and VietOCR are not installed; the real-OCR gate needs both engines",
)
class RealOcrFixtureGate(unittest.TestCase):
    """Runs the production pipeline on all 45 image-quality fixtures."""

    @classmethod
    def setUpClass(cls):
        try:
            _paddle, vietocr = ocr_engine._get_ocr_engines()
        except ocr_engine.OcrEngineUnavailable as exc:
            raise unittest.SkipTest(f"OCR models are not available: {exc}")
        if vietocr is None:
            raise unittest.SkipTest("VietOCR weights are not available")
        if not ocr_engine._configure_tesseract():
            raise unittest.SkipTest("Tesseract is not installed")
        cls.benchmark = _load_benchmark()
        cls.results = [cls.benchmark.evaluate_fixture(fixture)
                       for fixture in cls.benchmark.load_fixtures()]
        cls.rows = [dict(row, fixture=result["fixture_id"])
                    for result in cls.results for row in result["words"]]

    def test_b_every_fixture_ran_on_the_dual_engine_pipeline(self):
        self.assertEqual(len(self.results), 45)
        for result in self.results:
            with self.subTest(fixture=result["fixture_id"]):
                self.assertEqual(result["engine"], "paddleocr_vietocr_dual")
                self.assertTrue(result["words"])

    def test_gate_a_reference_colors_are_exact_on_real_ocr_output(self):
        for row in self.rows:
            with self.subTest(fixture=row["fixture"], ocr=row["text"], truth=row["truth"]):
                if row["truth_state"] == "correct":
                    self.assertEqual(row["with_reference_color"], "green")
                elif row["truth_state"] == "incorrect" and row["reference_alignment"] == "substitute":
                    self.assertEqual(row["with_reference_color"], "red")
                else:
                    self.assertEqual(row["with_reference_color"], "yellow")

    def test_no_red_without_a_reference(self):
        self.assertFalse([row for row in self.rows if row["no_reference_color"] == "red"])

    def test_gate_b_green_precision_and_recall_on_the_fixture_set(self):
        paired = [row for row in self.rows if row["truth_state"] != "ambiguous"]
        green = [row for row in paired if row["no_reference_color"] == "green"]
        correct = [row for row in paired if row["truth_state"] == "correct"]
        true_green = [row for row in green if row["truth_state"] == "correct"]
        precision = len(true_green) / len(green)
        recall = len(true_green) / len(correct)
        self.assertGreaterEqual(precision, 0.99, msg=f"GREEN precision {precision:.4f}")
        self.assertGreaterEqual(recall, 0.90, msg=f"GREEN recall {recall:.4f}")

    def test_recognition_quality_on_the_fixture_set(self):
        truth = sum(result["truth_words"] for result in self.results)
        correct = sum(1 for row in self.rows if row["truth_state"] == "correct")
        self.assertGreaterEqual(correct / truth, 0.96)
        self.assertLessEqual(float(np.mean([result["cer"] for result in self.results])), 0.02)


if __name__ == "__main__":
    unittest.main()
