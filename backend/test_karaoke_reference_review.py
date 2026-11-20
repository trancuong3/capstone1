"""Offline worksheet safety tests; no human annotation or quality assertion."""
from copy import deepcopy
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
from uuid import uuid4

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("karaoke_reference_review", ROOT / "scripts/prepare_karaoke_reference_review.py")
review = importlib.util.module_from_spec(spec)
spec.loader.exec_module(review)


class KaraokeReferenceReviewTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="karaoke-reference-test-")
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name).resolve()
        (self.root / "song.mp3").write_bytes(b"fixture: not real audio or quality evidence")
        self.lyrics = {"format_version": 2, "lines": [{"id": str(uuid4()), "text": "Bé hát", "start_ms": None, "end_ms": None,
            "syllables": [{"id": str(uuid4()), "text": word, "start_ms": None, "end_ms": None} for word in ("Bé", "hát")]}]}
        self.manifest = {"corpus_id": "fixture-only", "tracks": [{"id": "test", "title": "Bé hát", "duration_ms": 3000,
            "assets": [{"file": "song.mp3", "sha256": review.digest(self.root / "song.mp3")}],
            "lyrics_file": "lyrics.json", "lyrics_sha256": "", "attribution": "Test only", "source": {"url": "https://example.com/"},
            "license": "fixture", "license_url": "https://example.com/license"}]}
        self.sync()

    def sync(self):
        (self.root / "lyrics.json").write_text(json.dumps(self.lyrics), encoding="utf-8")
        self.manifest["tracks"][0]["lyrics_sha256"] = review.digest(self.root / "lyrics.json")
        (self.root / "manifest.json").write_text(json.dumps(self.manifest), encoding="utf-8")

    def prepare(self):
        return review.prepare(self.root / "manifest.json")

    def test_original_identity_and_null_marks_are_preserved(self):
        result = self.prepare()
        self.assertEqual(result["tracks"][0]["lyrics"]["lines"], self.lyrics["lines"])
        self.assertEqual(result["tracks"][0]["audio_url"], "song.mp3")
        self.assertEqual(result["manifest_sha256"], review.digest(self.root / "manifest.json"))
        self.assertNotIn("prediction", result)

    def test_predicted_syllable_or_line_marks_are_not_accepted_as_blind_input(self):
        for is_line in (False, True):
            with self.subTest(is_line=is_line):
                target = self.lyrics["lines"][0] if is_line else self.lyrics["lines"][0]["syllables"][0]
                target["start_ms"] = 0
                self.sync()
                with self.assertRaisesRegex(ValueError, "predicted timings"):
                    self.prepare()
                target["start_ms"] = None

    def test_audio_or_lyric_hash_drift_fails_closed(self):
        (self.root / "song.mp3").write_bytes(b"changed")
        with self.assertRaisesRegex(ValueError, "Audio identity"):
            self.prepare()
        self.manifest["tracks"][0]["assets"][0]["sha256"] = review.digest(self.root / "song.mp3")
        self.sync()
        (self.root / "lyrics.json").write_text("{}", encoding="utf-8")
        with self.assertRaisesRegex(ValueError, "Lyric identity"):
            self.prepare()

    def test_corpus_path_escape_rejected(self):
        with tempfile.TemporaryDirectory(prefix="karaoke-other-test-") as other:
            file = Path(other) / "outside.mp3"
            file.write_bytes(b"fixture")
            with self.assertRaisesRegex(ValueError, "outside corpus"):
                review.local_file(self.root, str(file.resolve()))

    def test_duplicate_track_invalid_duration_and_multiple_originals_rejected(self):
        pristine = deepcopy(self.manifest)
        for mutate in (
            lambda m: m["tracks"].append(deepcopy(m["tracks"][0])),
            lambda m: m["tracks"][0].update(duration_ms=True),
            lambda m: m["tracks"][0]["assets"].append(deepcopy(m["tracks"][0]["assets"][0])),
        ):
            self.manifest = deepcopy(pristine)
            mutate(self.manifest)
            self.sync()
            with self.assertRaises(ValueError):
                self.prepare()

    def test_text_cannot_escape_json_script_element(self):
        bundle = self.prepare()
        bundle["tracks"][0]["title"] = '</script><script>alert("x")</script>'
        page = review.render(bundle)
        self.assertNotIn('</script><script>alert', page)
        self.assertIn('\\u003c/script\\u003e', page)
        self.assertIn("connect-src 'none'", page)
        self.assertNotIn("__REVIEW_DATA__", page)

    def test_json_read_is_bounded(self):
        huge = self.root / "huge.json"
        huge.write_bytes(b" " * (review.LIMIT + 1))
        with self.assertRaisesRegex(ValueError, "exceeds limit"):
            review.read_json(huge)


if __name__ == "__main__":
    unittest.main()
