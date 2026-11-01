
from __future__ import annotations

import unittest
from app.services.text_alignment import align_text


class TextAlignmentTests(unittest.TestCase):
    def test_text_alignment_matching_and_distance(self):
        book_text = "Hôm nay em đi học. Em gặp cô giáo."
        transcript = "Hôm nay em đi đi học. Em gặp cô giáo."

        result = align_text(book_text, transcript)
        self.assertIn("distance", result)
        self.assertIn("alignment", result)
        self.assertGreater(len(result["alignment"]), 0)
        self.assertEqual(result["alignment"][0]["status"], "MATCH")


if __name__ == "__main__":
    unittest.main()
