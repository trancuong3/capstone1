"""Offline validation of the licensed, opt-in administrator upload bundle.

These files are not a runtime fallback, and these tests never call a network.
"""
import hashlib
import json
from pathlib import Path
import unittest

from app.schemas.karaoke import Lyrics, SongCreate
from app.services.karaoke_media_service import inspect_audio


BUNDLE = Path(__file__).resolve().parents[1] / "docs" / "karaoke-demo"


class KaraokeDemoBundleTests(unittest.TestCase):
    def test_original_mp3_fingerprint_and_real_metadata(self):
        data = (BUNDLE / "ngoi-sao-nho.mp3").read_bytes()
        self.assertEqual(hashlib.sha256(data).hexdigest(),
                         "47ebba49be8b7bc776db49c7918b88f0dedfd52f8ccb21e35f6a16e7cb9cbfd6")
        media = inspect_audio(data)
        self.assertEqual(media.size_bytes, 2480796)
        self.assertLessEqual(abs(media.duration_ms - 103367), 1)

    def test_canonical_lyrics_fit_the_exact_mp3_with_intro_and_outro(self):
        lyrics = Lyrics.model_validate_json((BUNDLE / "ngoi-sao-nho.json").read_text(encoding="utf-8"))
        media = inspect_audio((BUNDLE / "ngoi-sao-nho.mp3").read_bytes())
        self.assertEqual(len(lyrics.lines), 18)
        previous = 0
        for line in lyrics.lines:
            self.assertGreaterEqual(line.start_ms, previous)
            self.assertLess(line.start_ms, line.end_ms)
            self.assertLessEqual(line.end_ms, media.duration_ms)
            previous = line.end_ms
        self.assertGreater(lyrics.lines[0].start_ms, 0)
        self.assertLess(lyrics.lines[-1].end_ms, media.duration_ms)

    def test_plain_text_matches_canonical_lines(self):
        lyrics = Lyrics.model_validate_json((BUNDLE / "ngoi-sao-nho.json").read_text(encoding="utf-8"))
        text = (BUNDLE / "ngoi-sao-nho.txt").read_text(encoding="utf-8").splitlines()
        self.assertEqual(text, [line.text for line in lyrics.lines])

    def test_metadata_retains_public_attribution_and_license_uri(self):
        metadata = SongCreate.model_validate(json.loads((BUNDLE / "song.json").read_text(encoding="utf-8")))
        self.assertEqual(metadata.title, "Ngôi sao nhỏ")
        self.assertIn("Alexander Blu", metadata.author)
        self.assertIn("https://creativecommons.org/licenses/by/4.0/", metadata.author)
        self.assertIn("https://orangefreesounds.com/", metadata.author)
        self.assertIn("CC BY 4.0", metadata.usage_note)


if __name__ == "__main__":
    unittest.main()
