"""Pure event-evidence tests; no model, media, or music-quality claims."""
from copy import deepcopy
import unittest
from ctc_boundaries import trusted_delimiters


def tokens():
    return [dict(text="b", start=44, end=45, support=.95),
            dict(text="a", start=46, end=47, support=.9),
            dict(text="|", start=87, end=88, support=.99),
            dict(text="b", start=96, end=97, support=.95),
            dict(text="a", start=98, end=99, support=.9)]


class CTCDelimiterTests(unittest.TestCase):
    def test_same_greedy_event_can_support_a_held_word_end(self):
        result = trusted_delimiters(["ba", "ba"], tokens(), tokens())
        self.assertEqual(result, {0: dict(time_ms=1750, support=.99)})
        self.assertNotEqual(result[0]["time_ms"], 1920)
        self.assertNotIn(1, result, "Never invent the last word's end")

    def test_forced_only_delimiter_or_wrong_neighbor_is_not_evidence(self):
        for greedy in (tokens()[:2] + tokens()[3:],
                       [dict(token, text="m") if i == 0 else token for i, token in enumerate(tokens())]):
            self.assertEqual(trusted_delimiters(["ba", "ba"], tokens(), greedy), {})

    def test_low_support_or_long_delimiter_is_ambiguous(self):
        for change in (dict(support=.84), dict(end=94)):
            forced = tokens(); forced[2].update(change)
            self.assertEqual(trusted_delimiters(["ba", "ba"], forced, forced), {})
        forced = tokens(); forced[0]["support"] = .54
        self.assertEqual(trusted_delimiters(["ba", "ba"], forced, forced), {})

    def test_independent_neighbors_must_also_have_sufficient_support(self):
        for index in (0, 3):
            greedy = tokens(); greedy[index]["support"] = .54
            self.assertEqual(trusted_delimiters(["ba", "ba"], tokens(), greedy), {})

    def test_repeats_match_their_own_audio_positions_not_the_first_word(self):
        stream = tokens() + [dict(text="|", start=130, end=131, support=.99),
                             dict(text="b", start=140, end=141, support=.95),
                             dict(text="a", start=142, end=143, support=.9)]
        result = trusted_delimiters(["ba", "ba", "ba"], stream, stream)
        self.assertEqual({i: v["time_ms"] for i, v in result.items()}, {0: 1750, 1: 2610})

    def test_shifted_greedy_span_and_extra_separator_are_not_equivalent(self):
        greedy = tokens(); greedy[2]["start"] += 1; greedy[2]["end"] += 1
        self.assertEqual(trusted_delimiters(["ba", "ba"], tokens(), greedy), {})
        greedy = tokens(); greedy.insert(3, dict(text="|", start=89, end=90, support=.99))
        self.assertEqual(trusted_delimiters(["ba", "ba"], tokens(), greedy), {})

    def test_invalid_nonfinite_or_out_of_order_events_are_rejected(self):
        for change in (dict(support=float("nan")), dict(start=True), dict(end=43)):
            malformed = deepcopy(tokens()); malformed[0].update(change)
            with self.assertRaisesRegex(ValueError, "INVALID_ALIGNMENT_PATH"):
                trusted_delimiters(["ba", "ba"], malformed, tokens())
        with self.assertRaisesRegex(ValueError, "INVALID_ALIGNMENT_PATH"):
            trusted_delimiters(["ma", "ba"], tokens(), tokens())


if __name__ == "__main__":
    unittest.main()
