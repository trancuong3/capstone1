"""Fingerprints bind full content, while text hashes ignore timing only."""
from copy import deepcopy
from types import SimpleNamespace
import unittest
import unicodedata
from uuid import uuid4

from app.services.karaoke_processing_review import clear_review, content_fingerprint, fingerprint, lyrics_hashes, reviewed_current
from test_karaoke_syllables import lyrics_v2


class ProcessingFingerprintTests(unittest.TestCase):
    def test_canonical_json_ignores_key_order_and_unicode_composition(self):
        self.assertEqual(fingerprint({"b": 1, "a": "Bé"}),
                         fingerprint({"a": unicodedata.normalize("NFD", "Bé"), "b": 1}))
        with self.assertRaises(ValueError):
            fingerprint({"x": float("nan")})

    def test_full_snapshot_detects_timing_but_text_hash_does_not(self):
        original = lyrics_v2()
        changed = deepcopy(original)
        changed["lines"][0]["syllables"][0]["end_ms"] = 190
        text, full = lyrics_hashes(original)
        changed_text, changed_full = lyrics_hashes(changed)
        self.assertEqual(text, changed_text)
        self.assertNotEqual(full, changed_full)
        changed["lines"][0]["syllables"].reverse()
        self.assertNotEqual(text, lyrics_hashes(changed)[0])

    def test_review_requires_same_content_and_mutation_clears_stamp(self):
        version = SimpleNamespace(id=uuid4(), title="Bé hát", author="", min_grade=1,
            max_grade=5, source_note="own", usage_note="test", audio_sha256="a" * 64,
            cover_path=None, lyrics=lyrics_v2(), origin_job_id=uuid4(), reference_audio_sha256=None,
            reviewed_content_sha256=None, reviewed_at=None)
        version.reviewed_content_sha256 = content_fingerprint(version)
        version.reviewed_at = "test-time"
        self.assertTrue(reviewed_current(version))
        version.title = "Đã sửa"
        self.assertFalse(reviewed_current(version))
        clear_review(version)
        self.assertIsNone(version.reviewed_content_sha256)
        self.assertIsNone(version.reviewed_at)
        self.assertEqual(version.review_acknowledged_flag_ids, [])


if __name__ == "__main__":
    unittest.main()
