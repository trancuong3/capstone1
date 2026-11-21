"""All-optimal-path alignment prevents fictional OCR review corrections."""
from __future__ import annotations

import unittest

from scripts.ocr_tesseract_alignment import unambiguous_optimal_token_alignment


class AllOptimalTokenAlignmentTests(unittest.TestCase):
    def test_exact_and_single_tone_substitution(self):
        self.assertEqual(
            unambiguous_optimal_token_alignment(
                ["Bé", "mỉm", "hôm", "nay"],
                ["Bé", "mìm", "hôm", "nay"],
            ),
            {0: 0, 1: 1, 2: 2, 3: 3},
        )

    def test_false_trailing_tokens_do_not_make_anchored_word_unscorable(self):
        matches = unambiguous_optimal_token_alignment(
            ["Bé", "mỉm", "hôm", "nay"],
            ["Bé", "mìm", "hôm", "nay", "I", "I", "V"],
        )
        self.assertEqual(matches, {0: 0, 1: 1, 2: 2, 3: 3})
        self.assertNotIn(4, matches)
        self.assertNotIn(5, matches)
        self.assertNotIn(6, matches)

    def test_repeated_identical_words_can_create_nonunique_alignment(self):
        self.assertEqual(
            unambiguous_optimal_token_alignment(["a", "a"], ["a"]),
            {},
        )

    def test_ambiguous_reference_to_single_observed_word_abstains(self):
        self.assertEqual(
            unambiguous_optimal_token_alignment(["Bé", "mỉm"], ["mìm"]),
            {},
        )

    def test_empty_and_overlong_documents_abstain(self):
        self.assertEqual(unambiguous_optimal_token_alignment([], ["a"]), {})
        self.assertEqual(unambiguous_optimal_token_alignment(["a"], []), {})
        self.assertEqual(
            unambiguous_optimal_token_alignment(["a"] * 513, ["a"]), {},
        )

    def test_returns_only_integer_indices_without_source_words(self):
        result = unambiguous_optimal_token_alignment(
            ["Mèo", "vui"], ["Mẻo", "vui"],
        )
        self.assertEqual(result, {0: 0, 1: 1})
        self.assertTrue(all(type(k) is int and type(v) is int for k, v in result.items()))


if __name__ == "__main__":
    unittest.main()
