"""Dependency-free tests for opt-in private word-error alignment."""
from __future__ import annotations

import unittest

from scripts.ocr_word_error_diagnostics import (
    MAX_ALIGNMENT_TOKENS,
    analyze_word_errors,
    classify_substitution,
    edge_punctuation_neutral_tokens,
)


class WordErrorDiagnosticsTests(unittest.TestCase):
    def test_diacritic_case_and_punctuation(self):
        self.assertEqual(classify_substitution("sách", "sach"), "diacritic_or_d_stroke")
        self.assertEqual(classify_substitution("đọc", "doc"), "diacritic_or_d_stroke")
        self.assertEqual(classify_substitution("Bé", "bé"), "case_only")
        self.assertEqual(classify_substitution("sách.", "sách"), "punctuation_only")
        self.assertEqual(classify_substitution("nhà", "ngà"), "other_substitution")

    def test_mixed_substitution_missing_and_extra(self):
        result = analyze_word_errors("Bé đang đọc sách.", "Bé đọc sach.")
        self.assertEqual(result["status"], "complete")
        self.assertEqual(result["error_count"], 2)
        self.assertEqual([e["kind"] for e in result["errors"]], ["missing_token", "diacritic_or_d_stroke"])
        self.assertEqual(result["errors"][0]["expected"], "đang")
        self.assertEqual(result["errors"][1]["expected_position"], 4)
        extra = analyze_word_errors("An đọc", "An đọc rõ")
        self.assertEqual(extra["error_count"], 1)
        self.assertEqual(extra["errors"][0]["kind"], "extra_token")

    def test_identical_text_and_position(self):
        self.assertEqual(analyze_word_errors("Bé An", "Bé An")["errors"], [])
        self.assertEqual(analyze_word_errors("", "")["error_count"], 0)

    def test_edge_punctuation_neutral_scoring_preserves_vietnamese_letters(self):
        self.assertEqual(
            edge_punctuation_neutral_tokens("“Bé” đang đọc sách!!! —"),
            ["Bé", "đang", "đọc", "sách"],
        )
        self.assertEqual(
            edge_punctuation_neutral_tokens("đọc sách"), ["đọc", "sách"],
        )
        self.assertNotEqual(
            edge_punctuation_neutral_tokens("đọc sách"),
            edge_punctuation_neutral_tokens("doc sach"),
        )
        self.assertEqual(
            edge_punctuation_neutral_tokens("xì-gà 'd'accord'"),
            ["xì-gà", "d'accord"],
        )

    def test_bounded_memory(self):
        result = analyze_word_errors("A " * (MAX_ALIGNMENT_TOKENS + 1), "B")
        self.assertEqual(result["status"], "skipped_token_limit")
        self.assertIsNone(result["error_count"])
        self.assertEqual(result["errors"], [])


if __name__ == "__main__":
    unittest.main()
