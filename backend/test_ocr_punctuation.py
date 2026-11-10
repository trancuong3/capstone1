"""Punctuation is recognized, kept and judged separately from the word text.

GROUP C of the recognition spec: 55 punctuation scenarios, each with ground
truth, OCR output and the expected verdict, plus pipeline tests proving that
punctuation is never dropped, never moved to a neighbour and never shifts the
word alignment or the text color.
"""
from __future__ import annotations

import importlib.util
import os
import sys
import unittest
from pathlib import Path
from unittest.mock import MagicMock, patch

import cv2
import numpy as np

from ocr_color_testkit import classify_page, engine_word

from app.services import ocr_engine
from app.services.admin_ocr_service import AdminOcrService
from app.services.ocr_engine import normalize_text_tokens, normalize_word
from app.services.ocr_punctuation import (
    canonical_punctuation,
    compare_punctuation,
    punctuation_marks,
    punctuation_status,
    split_surface_token,
)

BACKEND_ROOT = Path(__file__).resolve().parent
SUCCESS = {"paddleocr": "success", "vietocr": "success", "tesseract": "success"}


def _metrics():
    scripts = str(BACKEND_ROOT / "scripts")
    if scripts not in sys.path:
        sys.path.insert(0, scripts)
    spec = importlib.util.spec_from_file_location(
        "ocr_benchmark_metrics", BACKEND_ROOT / "scripts" / "ocr_benchmark_metrics.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


# name, ground truth token, OCR token, word color with reference, punctuation verdict
PUNCTUATION_SCENARIOS = [
    ("P01 full stop at the end of a sentence", "ngon.", "ngon.", "green", "correct"),
    ("P02 comma inside a sentence", "sáng,", "sáng,", "green", "correct"),
    ("P03 semicolon", "chạy;", "chạy;", "green", "correct"),
    ("P04 colon", "hỏi:", "hỏi:", "green", "correct"),
    ("P05 question mark", "gì?", "gì?", "green", "correct"),
    ("P06 exclamation mark", "quá!", "quá!", "green", "correct"),
    ("P07 ellipsis character equals three dots", "thỏ…", "thỏ...", "green", "correct"),
    ("P08 straight double quotes", '"An"', '"An"', "green", "correct"),
    ("P09 round brackets", "(nhanh)", "(nhanh)", "green", "correct"),
    ("P10 square brackets", "[một]", "[một]", "green", "correct"),
    ("P11 hyphen inside a word is part of the word", "xì-gà", "xì-gà", "green", "correct"),
    ("P12 en dash after a word", "hỏi–", "hỏi–", "green", "correct"),
    ("P13 em dash read as en dash is the same mark", "hỏi—", "hỏi–", "green", "correct"),
    ("P14 full stop right after a Vietnamese mark", "mẹ.", "mẹ.", "green", "correct"),
    ("P15 comma after a short word", "ạ,", "ạ,", "green", "correct"),
    ("P16 comma after a long word", "nghiêng,", "nghiêng,", "green", "correct"),
    ("P17 two consecutive marks", "sao?!", "sao?!", "green", "correct"),
    ("P18 mark missed by OCR", "ngon.", "ngon", "green", "incorrect"),
    ("P19 mark added by OCR", "ngon", "ngon.", "green", "incorrect"),
    ("P20 mark read as another mark", "ngon!", "ngon.", "green", "incorrect"),
    ("P21 mark attached to the token keeps the word intact", "nhà.", "nhà.", "green", "correct"),
    ("P22 only one of two marks read", "sao?!", "sao?", "green", "incorrect"),
    ("P23 noise read as a full stop", "trời", "trời.", "green", "incorrect"),
    ("P24 comma read as a full stop", "cam,", "cam.", "green", "incorrect"),
    ("P25 question mark that lost its dot", "gì?", "gì7", "red", "incorrect"),
    ("P26 exclamation mark read as the letter l", "ạ!", "ạl", "red", "incorrect"),
    ("P27 curly quotes equal straight quotes", "“An”", '"An"', "green", "correct"),
    ("P28 curly single quote equals apostrophe mark", "‘An’", "'An'", "green", "correct"),
    ("P29 dialogue: closing quote after the mark", "rồi!”", "rồi!”", "green", "correct"),
    ("P30 opening quote at paragraph start", "“Mẹ", "“Mẹ", "green", "correct"),
    ("P31 closing mark at paragraph end", "đấy.”", "đấy.”", "green", "correct"),
    ("P32 opening bracket at line start", "(rất", "(rất", "green", "correct"),
    ("P33 closing bracket at line end", "nhanh)", "nhanh)", "green", "correct"),
    ("P34 mark separated by a space is still that word's mark", "sao ?", "sao?", "green", "correct"),
    ("P35 mark without a space", "sao?", "sao?", "green", "correct"),
    ("P36 question sentence with wrong word", "gì?", "gi?", "red", "correct"),
    ("P37 exclamation sentence with wrong word", "quá!", "qua!", "red", "correct"),
    ("P38 mark on a dark page: same token", "đêm.", "đêm.", "green", "correct"),
    ("P39 blurred mark read as comma", "tối.", "tối,", "green", "incorrect"),
    ("P40 JPEG artefact added a quote", "vườn", "vườn'", "green", "incorrect"),
    ("P41 very small mark missed", "lo,", "lo", "green", "incorrect"),
    ("P42 mark near the spine missed, word wrong too", "sách.", "sach", "red", "incorrect"),
    ("P43 mark at the box edge kept", "cành.", "cành.", "green", "correct"),
    ("P44 mark after a repeated word", "bà,", "bà,", "green", "correct"),
    ("P45 mark after a word with stacked marks", "truyện.", "truyện.", "green", "correct"),
    ("P46 mark before a closing bracket", "nhanh.)", "nhanh.)", "green", "correct"),
    ("P47 mark after a closing quote", "sao”?", "sao”?", "green", "correct"),
    ("P48 comma in a list", "táo,", "táo,", "green", "correct"),
    ("P49 semicolon in a list read as comma", "lê;", "lê,", "green", "incorrect"),
    ("P50 ellipsis at the end shortened", "theo...", "theo..", "green", "incorrect"),
    ("P51 exclamation with closing quote", "rồi!”", "rồi!\"", "green", "correct"),
    ("P52 question with closing quote lost", "ạ?”", "ạ?", "green", "incorrect"),
    ("P53 Unicode NFD word with a mark", "bữa.", "bữa.", "green", "correct"),
    ("P54 double quote read as single quote", '"An', "'An", "green", "incorrect"),
    ("P55 colon that lost one dot", "hỏi:", "hỏi.", "green", "incorrect"),
]


class PunctuationScenarios(unittest.TestCase):
    def test_c_punctuation_scenarios(self):
        self.assertEqual(len(PUNCTUATION_SCENARIOS), 55)
        self.assertEqual(len({name for name, *_ in PUNCTUATION_SCENARIOS}), 55)
        for name, truth, ocr, expected_color, expected_punctuation in PUNCTUATION_SCENARIOS:
            with self.subTest(case=name, ground_truth=truth, ocr_output=ocr):
                # "sao ?" stands for a mark the page prints after a space.
                reference = truth.replace(" ", "")
                words = [engine_word("An"), engine_word(ocr, token_index=1), engine_word("ăn", token_index=2)]
                colors = classify_page(words, f"An {reference} ăn")
                # The word color follows the lexical core only.
                self.assertEqual(colors, ["green", expected_color, "green"])
                evidence = words[1]["ocr_evidence"]
                self.assertEqual(punctuation_status(ocr, evidence), expected_punctuation)
                # Nothing was removed from the stored surface or the reference.
                self.assertEqual(words[1]["text"], ocr)
                self.assertEqual(evidence["reference_text"], reference)

    def test_surface_split_is_lossless(self):
        for _name, truth, ocr, *_ in PUNCTUATION_SCENARIOS:
            for token in (truth.replace(" ", ""), ocr):
                parts = split_surface_token(token)
                with self.subTest(token=token):
                    self.assertEqual(parts.leading + parts.core + parts.trailing, parts.surface)
                    self.assertEqual(normalize_word(parts.core), normalize_word(token))

    def test_split_examples_from_the_spec(self):
        self.assertEqual(
            (split_surface_token("giường.").core, split_surface_token("giường.").trailing),
            ("giường", "."))
        self.assertEqual(
            (split_surface_token("“An").leading, split_surface_token("“An").core), ("“", "An"))
        only_marks = split_surface_token("...")
        self.assertEqual((only_marks.core, only_marks.trailing), ("", "..."))
        self.assertEqual(split_surface_token("d'accord").core, "d'accord")

    def test_canonical_form_only_unifies_equivalent_glyphs(self):
        self.assertEqual(canonical_punctuation("“”"), '""')
        self.assertEqual(canonical_punctuation("…"), "...")
        self.assertEqual(canonical_punctuation("—"), canonical_punctuation("–"))
        for a, b in ((".", ","), ("!", "?"), (":", ";"), ('"', "'"), ("(", "[")):
            self.assertNotEqual(canonical_punctuation(a), canonical_punctuation(b))
        self.assertEqual(punctuation_marks("“rồi!”"), ['"', "!", '"'])

    def test_wrong_punctuation_never_changes_the_word_colors_after_it(self):
        ocr = "An ăn sáng thật ngon."
        truth = "An ăn sáng thật ngon!"
        words = [engine_word(token, token_index=i) for i, token in enumerate(ocr.split())]
        self.assertEqual(classify_page(words, truth), ["green"] * 5)
        self.assertEqual(
            [punctuation_status(str(w["text"]), w["ocr_evidence"]) for w in words],
            ["correct", "correct", "correct", "correct", "incorrect"])
        self.assertEqual(compare_punctuation("ngon.", "ngon!"), "incorrect")

    def test_extra_comma_does_not_shift_later_tokens(self):
        metrics = _metrics()
        result = metrics.text_metrics("An ăn sáng ngon.".split(), "An ăn sáng, ngon.".split())
        self.assertEqual(result["exact"], 4)
        self.assertEqual(result["paired_without_shift"], (4, 4))
        self.assertEqual((result["punct_tp"], result["punct_fp"], result["punct_fn"]), (1, 1, 0))

    def test_standalone_mark_is_not_a_word_and_is_not_lost_in_metrics(self):
        metrics = _metrics()
        truth = "– Con chào ông ạ!".split()
        kept = metrics.text_metrics(truth, "– Con chào ông ạ!".split())
        dropped = metrics.text_metrics(truth, "Con chào ông ạ!".split())
        self.assertEqual(kept["truth_words"], 4)
        self.assertEqual((kept["punct_tp"], kept["punct_fn"]), (2, 0))
        self.assertEqual(dropped["exact"], 4)                 # words unaffected
        self.assertEqual((dropped["punct_tp"], dropped["punct_fn"]), (1, 1))
        self.assertEqual(kept["sentence_boundary"], (1, 1))

    def test_status_without_reference_reports_engine_agreement_only(self):
        def word(vietocr, tesseract, paddle="rồi"):
            item = engine_word(vietocr, paddle=paddle, statuses=dict(SUCCESS))
            item["ocr_evidence"]["engine_outputs"]["tesseract"] = tesseract
            return AdminOcrService._normalize_word_evidence(item["ocr_evidence"])

        self.assertEqual(punctuation_status("rồi!", word("rồi!", "rồi!")), "consistent")
        self.assertEqual(punctuation_status("rồi!", word("rồi!", "rồi.")), "uncertain")
        self.assertEqual(punctuation_status("rồi!", word("rồi!", None)), "uncertain")
        self.assertEqual(punctuation_status("rồi!", None), "not_assessed")
        self.assertEqual(punctuation_status("rồi!", {"engine_outputs": {}, "engine_statuses": {}}),
                         "not_assessed")

    def test_ambiguous_reference_mapping_gives_no_punctuation_verdict(self):
        words = [engine_word("sư"), engine_word("on,"), engine_word("cửa")]
        classify_page(words, "sư ơn")
        self.assertEqual(words[1]["ocr_evidence"]["reference_alignment"], "ambiguous")
        self.assertNotIn(
            punctuation_status("on,", words[1]["ocr_evidence"]), {"correct", "incorrect"})


class PunctuationReconciliation(unittest.TestCase):
    """Majority of engines that read the same word decides its punctuation."""

    @staticmethod
    def _word(text, *, vietocr, tesseract, paddle):
        item = engine_word(text, paddle=paddle, vietocr=vietocr, statuses=dict(SUCCESS),
                           crop_evidence={"status": "not_needed"})
        if tesseract is not None:
            item["ocr_evidence"]["engine_outputs"]["tesseract"] = tesseract
        item["ocr_evidence"]["source_text"] = text
        return item

    def test_missing_full_stop_is_restored_when_two_engines_read_it(self):
        word = self._word("ngon", vietocr="ngon", tesseract="ngon.", paddle="ngon.")
        stats = ocr_engine._reconcile_punctuation([word])
        self.assertEqual(word["text"], "ngon.")
        self.assertEqual(stats["changed_words"], 1)
        self.assertEqual(
            word["ocr_evidence"]["crop_evidence"]["punctuation_before_reconciliation"], "ngon")
        self.assertEqual(word["ocr_evidence"]["engine_outputs"]["vietocr"], "ngon")  # history kept

    def test_one_engine_alone_never_changes_punctuation(self):
        word = self._word("ngon", vietocr="ngon", tesseract="ngon.", paddle="ngon")
        ocr_engine._reconcile_punctuation([word])
        self.assertEqual(word["text"], "ngon")

    def test_a_tie_keeps_the_stored_punctuation(self):
        word = self._word("ngon!", vietocr="ngon!", tesseract="ngon.", paddle=None)
        stats = ocr_engine._reconcile_punctuation([word])
        self.assertEqual(word["text"], "ngon!")
        self.assertEqual(stats["disputed_sides"], 1)

    def test_engine_that_read_other_letters_does_not_vote(self):
        # PaddleOCR read a different word here: its full stop is not this word's.
        word = self._word("ngon", vietocr="ngon", tesseract=None, paddle="nhà.")
        ocr_engine._reconcile_punctuation([word])
        self.assertEqual(word["text"], "ngon")

    def test_paddle_votes_on_punctuation_even_when_it_misses_marks(self):
        word = self._word("đẹp", vietocr="đẹp", tesseract="đẹp.", paddle="dep.")
        ocr_engine._reconcile_punctuation([word])
        self.assertEqual(word["text"], "đẹp.")       # letters untouched, mark restored

    def test_leading_quote_is_restored_with_its_original_glyph(self):
        word = self._word("Mẹ", vietocr="Mẹ", tesseract="“Mẹ", paddle='"Me')
        ocr_engine._reconcile_punctuation([word])
        self.assertEqual(word["text"], "“Mẹ")

    def test_spurious_mark_is_removed_when_two_engines_read_none(self):
        word = self._word("trời.", vietocr="trời.", tesseract="trời", paddle="troi")
        ocr_engine._reconcile_punctuation([word])
        self.assertEqual(word["text"], "trời")

    def test_lexical_core_and_color_evidence_are_never_altered(self):
        word = self._word("sáng", vietocr="sáng", tesseract="sáng,", paddle="sang,")
        before = normalize_word(str(word["text"]))
        ocr_engine._reconcile_punctuation([word])
        self.assertEqual(word["text"], "sáng,")
        self.assertEqual(normalize_word(str(word["text"])), before)
        self.assertEqual(normalize_word(word["ocr_evidence"]["source_text"]), before)

    def test_reconciliation_is_idempotent_after_a_retry(self):
        word = self._word("ngon", vietocr="ngon", tesseract="ngon.", paddle="ngon.")
        ocr_engine._reconcile_punctuation([word])
        first = (word["text"], dict(word["ocr_evidence"]["crop_evidence"]))
        stats = ocr_engine._reconcile_punctuation([word])
        self.assertEqual((word["text"], dict(word["ocr_evidence"]["crop_evidence"])), first)
        self.assertEqual(stats["changed_words"], 0)

    def test_punctuation_is_not_moved_to_the_neighbouring_word(self):
        left = self._word("ngon", vietocr="ngon", tesseract="ngon.", paddle="ngon.")
        right = self._word("An", vietocr="An", tesseract="An", paddle="An")
        ocr_engine._reconcile_punctuation([left, right])
        self.assertEqual((left["text"], right["text"]), ("ngon.", "An"))


class PageTextKeepsPunctuation(unittest.TestCase):
    """End to end through the dual-engine pipeline with mocked recognizers."""

    def _run(self, paddle_text, vietocr_text):
        quad = [[40.0, 60.0], [560.0, 60.0], [560.0, 110.0], [40.0, 110.0]]
        mock_paddle = MagicMock()
        mock_paddle.ocr.return_value = [[[quad, (paddle_text, 0.95)]]]
        mock_vietocr = MagicMock()
        mock_vietocr.predict.return_value = vietocr_text
        mock_vietocr.predict_batch.return_value = ([], [])
        image = np.full((200, 600, 3), 255, dtype=np.uint8)
        ok, encoded = cv2.imencode(".png", image)
        self.assertTrue(ok)
        with (
            patch.dict(os.environ, {"OCR_DEBUG_BOXES_PATH": ""}),
            patch.object(ocr_engine, "_get_ocr_engines", return_value=(mock_paddle, mock_vietocr)),
            patch.object(ocr_engine, "_attach_tesseract_line_readings",
                         return_value={"status": "not_run", "paired_words": 0}),
        ):
            return ocr_engine.extract_text_and_boxes(encoded.tobytes())

    def test_dialogue_dash_stays_in_the_page_text_but_is_not_a_word(self):
        result = self._run("- Con chao ong a!", "– Con chào ông ạ!")
        self.assertEqual(result["text"], "– Con chào ông ạ!")
        self.assertEqual([word["text"] for word in result["words"]], ["Con", "chào", "ông", "ạ!"])
        # Page text and word list still describe the same lexical tokens.
        self.assertEqual(
            normalize_text_tokens(result["text"]),
            [word["normalized_text"] for word in result["words"]])

    def test_ellipsis_token_and_quotes_survive(self):
        result = self._run('"A, co bay roi!" ...', "“A, cò bay rồi!” ...")
        self.assertEqual(result["text"], "“A, cò bay rồi!” ...")
        self.assertEqual([word["text"] for word in result["words"]],
                         ["“A,", "cò", "bay", "rồi!”"])

    def test_word_indexes_stay_contiguous_around_standalone_marks(self):
        result = self._run("An - me - oi", "An – mẹ – ơi")
        self.assertEqual(result["text"], "An – mẹ – ơi")
        self.assertEqual([word["word_index"] for word in result["words"]], [0, 1, 2])
        self.assertEqual([word["text"] for word in result["words"]], ["An", "mẹ", "ơi"])

    def test_text_without_standalone_marks_is_unchanged(self):
        result = self._run("Hom nay troi nang dep.", "Hôm nay trời nắng đẹp.")
        self.assertEqual(result["text"], "Hôm nay trời nắng đẹp.")
        self.assertEqual(result["words"][-1]["text"], "đẹp.")


if __name__ == "__main__":
    unittest.main()
