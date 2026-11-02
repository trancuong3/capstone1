
from __future__ import annotations

import unittest
from app.services.text_alignment import align_text, normalize_text


class TextAlignmentTests(unittest.TestCase):
    def test_text_alignment_matching_and_distance(self):
        book_text = "Hôm nay em đi học. Em gặp cô giáo."
        transcript = "Hôm nay em đi đi học. Em gặp cô giáo."

        result = align_text(book_text, transcript)
        self.assertIn("distance", result)
        self.assertIn("alignment", result)
        self.assertGreater(len(result["alignment"]), 0)
        self.assertEqual(result["alignment"][0]["status"], "MATCH")
    def test_vietnamese_normalization_preserves_diacritics_and_d_stroke(self):
        self.assertEqual(
            normalize_text("KHỎE, không? Đường dừng!"),
            ["khỏe", "không", "đường", "dừng"],
        )
        self.assertNotEqual(normalize_text("d"), normalize_text("đ"))

    def test_vietnamese_normalization_uses_unicode_nfc(self):
        self.assertEqual(normalize_text("a\\u0306\\u0301"), ["ắ"])



if __name__ == "__main__":
    unittest.main()
