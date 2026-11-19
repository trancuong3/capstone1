"""Ordered agreement regression; no model or accepted-song quality claims."""
import itertools
import random
import unittest

from app.services.karaoke_transcript_agreement import transcript_agreement


def reference_distance(left, right):
    # Deliberately independent, ordinary matrix recurrence for small test inputs.
    row = list(range(len(right) + 1))
    for index, word in enumerate(left, 1):
        next_row = [index]
        for other, token in enumerate(right, 1):
            next_row.append(min(next_row[-1] + 1, row[other] + 1,
                                row[other - 1] + (word != token)))
        row = next_row
    return row[-1]


class TranscriptAgreementTests(unittest.TestCase):
    def test_repeated_chorus_substitutions_do_not_hide_earlier_matches(self):
        left = "a b c d a b c d a b c d a b c d".split()
        right = "a b c d x b c x a b c d a b x x".split()
        self.assertEqual(transcript_agreement(left, right), 0.75)

    def test_insertions_deletions_substitutions_and_missing_repeat_count(self):
        for left, right, agreement in [
            (["a", "b", "c"], ["a", "b", "c"], 1),
            (["a", "b"], ["a", "x", "b"], 2 / 3),
            (["a", "b", "c"], ["a", "c"], 2 / 3),
            (["a", "b"], ["x", "y"], 0),
            (["a", "b"] * 4, ["a", "b"], 0.25),
            (["a", "b", "c", "d"], ["d", "c", "b", "a"], 0),
            ([], [], 0), ([], ["a"], 0),
        ]:
            with self.subTest(left=left, right=right):
                self.assertAlmostEqual(transcript_agreement(left, right), agreement)
                self.assertAlmostEqual(transcript_agreement(right, left), agreement)

    def test_matches_matrix_distance_exhaustively_on_short_sequences(self):
        sequences = [list(tokens) for size in range(5)
                     for tokens in itertools.product(("bé", "hát"), repeat=size)]
        for left in sequences:
            for right in sequences:
                length = max(len(left), len(right))
                expected = 1 - reference_distance(left, right) / length if length else 0
                self.assertAlmostEqual(transcript_agreement(left, right), expected)

    def test_crosses_machine_word_boundaries_and_accepts_long_lyrics(self):
        rng = random.Random(741)
        for length in (63, 64, 65, 127, 256):
            left = [rng.choice(("bé", "hát", "vui", "bạn")) for _ in range(length)]
            right = [rng.choice(("bé", "hát", "vui", "bạn")) for _ in range(length + 9)]
            self.assertAlmostEqual(transcript_agreement(left, right),
                                   1 - reference_distance(left, right) / max(len(left), len(right)))
        long = ["bé", "hát"] * 5000
        self.assertEqual(transcript_agreement(long, long), 1)
        self.assertEqual(transcript_agreement(long, ["khác"] * 10000), 0)


if __name__ == "__main__":
    unittest.main()
