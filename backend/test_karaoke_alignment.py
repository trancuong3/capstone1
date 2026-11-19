"""Pure mapping tests. Evidence is a fixture, not an engine quality benchmark."""
from copy import deepcopy
import unittest
from uuid import uuid4

from pydantic import ValidationError

from app.providers.karaoke_alignment_provider import AlignmentEvidence
from app.services.karaoke_alignment import AlignmentRejected, map_alignment_to_lyrics
from test_karaoke_syllables import lyrics_v2


def evidence(lyrics):
    units = [unit for line in lyrics["lines"] for unit in line["syllables"]]
    return dict(
        units=[dict(index=i, text=u["text"], start_ms=u["start_ms"], end_ms=u["end_ms"],
                    acoustic_support=0.9, end_evidence="silence_boundary") for i, u in enumerate(units)],
        recognized_text=" ".join(u["text"] for u in units), model_revision="fixture",
        duration_ms=2000, frames=99,
    )


class KaraokeAlignmentTests(unittest.TestCase):
    def setUp(self):
        self.lyrics, self.job = lyrics_v2(), uuid4()
        self.evidence = evidence(self.lyrics)

    def run_map(self, evidence=None, lyrics=None):
        return map_alignment_to_lyrics(lyrics or self.lyrics, evidence or self.evidence,
                                       duration_ms=2000, job_id=self.job)

    def test_complete_mapping_keeps_ids_unicode_punctuation_and_order(self):
        before = deepcopy(self.lyrics)
        result = self.run_map()
        self.assertEqual(result["lyrics"], self.lyrics)
        self.assertEqual(self.lyrics, before)
        self.assertEqual(result["quality_report"]["flags"], [])
        self.assertFalse(result["diagnostics"]["calibrated"])

    def test_measured_ctc_delimiter_is_accepted_but_unknown_evidence_is_rejected(self):
        self.evidence["units"][0]["end_evidence"] = "ctc_delimiter"
        self.assertEqual(self.run_map()["lyrics"], self.lyrics)
        self.assertFalse(self.run_map()["diagnostics"]["calibrated"])
        self.evidence["units"][0]["end_evidence"] = "next_word_interpolation"
        with self.assertRaises(ValidationError):
            self.run_map()

    def test_unknown_sustain_is_null_instead_of_extending_to_next_start(self):
        self.evidence["units"][0].update(end_ms=None, end_evidence="unsupported")
        result = self.run_map()
        first = result["lyrics"]["lines"][0]
        self.assertIsNone(first["start_ms"])
        self.assertIsNone(first["end_ms"])
        self.assertEqual(first["syllables"][0]["start_ms"], 0)
        self.assertIsNone(first["syllables"][0]["end_ms"])
        self.assertEqual(first["syllables"][1]["start_ms"], 350)
        self.assertIn("HELD_NOTE_UNCERTAIN", result["quality_report"]["flags"][0]["codes"])
        second = self.run_map()
        self.assertEqual(second["quality_report"]["flags"], result["quality_report"]["flags"])

    def test_multi_unit_word_is_not_divided_uniformly(self):
        self.evidence["units"] = [
            dict(index=0, unit_count=2, text="Bé hát,", start_ms=0, end_ms=600,
                 acoustic_support=0.9, end_evidence="silence_boundary"),
            self.evidence["units"][2],
        ]
        result = self.run_map()
        units = result["lyrics"]["lines"][0]["syllables"]
        self.assertIsNone(units[0]["start_ms"])
        self.assertIsNone(units[1]["start_ms"])
        self.assertEqual(units[2]["start_ms"], 650)
        self.assertEqual(result["quality_report"]["flags"][0]["affected_syllable_count"], 2)

    def test_partial_onset_needs_support_and_must_be_in_bounds(self):
        for start, support in ((2000, 0.9), (2001, 0.9), (0, 0.54), (0, None)):
            raw = deepcopy(self.evidence)
            raw["units"][0].update(start_ms=start, end_ms=None,
                                    end_evidence="unsupported", acoustic_support=support)
            with self.subTest(start=start, support=support):
                result = self.run_map(raw)
                self.assertIsNone(result["lyrics"]["lines"][0]["syllables"][0]["start_ms"])

    def test_partial_onset_cannot_overlap_previous_span(self):
        self.evidence["units"][1].update(start_ms=100, end_ms=None, end_evidence="unsupported")
        result = self.run_map()
        self.assertIsNone(result["lyrics"]["lines"][0]["syllables"][1]["start_ms"])

    def test_span_cannot_move_backwards_after_partial_onset(self):
        self.evidence["units"][0].update(start_ms=400, end_ms=None, end_evidence="unsupported")
        result = self.run_map()
        units = result["lyrics"]["lines"][0]["syllables"]
        self.assertEqual(units[0]["start_ms"], 400)
        self.assertIsNone(units[1]["start_ms"])
        self.assertEqual(units[2]["start_ms"], 650)

    def test_unsupported_numeric_end_is_not_retained(self):
        self.evidence["units"][0]["end_evidence"] = "unsupported"
        result = self.run_map()
        unit = result["lyrics"]["lines"][0]["syllables"][0]
        self.assertEqual(unit["start_ms"], 0)
        self.assertIsNone(unit["end_ms"])
        self.assertEqual(result["diagnostics"]["aligned_units"], 2)

    def test_only_partial_onsets_still_fail_the_existing_candidate_gate(self):
        for unit in self.evidence["units"]:
            unit.update(end_ms=None, end_evidence="unsupported")
        with self.assertRaises(AlignmentRejected) as error:
            self.run_map()
        self.assertEqual(error.exception.code, "LYRICS_NOT_MATCHED")

    def test_overlap_and_out_of_range_marks_are_dropped(self):
        self.evidence["units"][1]["start_ms"] = 150
        self.evidence["units"][2]["end_ms"] = 2001
        result = self.run_map()
        units = result["lyrics"]["lines"][0]["syllables"]
        self.assertEqual(units[0]["end_ms"], 200)
        self.assertIsNone(units[1]["start_ms"])
        self.assertIsNone(units[2]["end_ms"])

    def test_empty_or_unrelated_transcript_is_not_a_successful_candidate(self):
        for text, code in (("", "NO_USABLE_VOCALS"), ("khác hoàn toàn", "LYRICS_NOT_MATCHED")):
            self.evidence["recognized_text"] = text
            with self.subTest(text=text), self.assertRaises(AlignmentRejected) as error:
                self.run_map()
            self.assertEqual(error.exception.code, code)

    def test_duplicate_and_out_of_range_indices_rejected(self):
        for index in (0, 100):
            copy = deepcopy(self.evidence)
            copy["units"][1]["index"] = index
            with self.subTest(index=index), self.assertRaises(AlignmentRejected):
                self.run_map(copy)

    def test_unaligned_everywhere_is_failure_not_fake_complete(self):
        self.evidence["units"] = []
        with self.assertRaises(AlignmentRejected):
            self.run_map()

    def test_low_support_warns_without_claiming_accuracy(self):
        self.evidence["units"][1]["acoustic_support"] = 0.1
        result = self.run_map()
        self.assertIn("LOW_ALIGNMENT_SUPPORT", result["quality_report"]["flags"][0]["codes"])
        self.assertNotIn("accuracy", result["diagnostics"])

    def test_repeated_lines_use_sequence_indices_not_a_text_dictionary(self):
        repeated = deepcopy(self.lyrics["lines"][0])
        repeated["id"] = str(uuid4())
        for unit in repeated["syllables"]:
            unit["id"] = str(uuid4())
            unit["start_ms"] += 1300
            unit["end_ms"] += 1300
        repeated["start_ms"], repeated["end_ms"] = 1300, 2500
        lyrics = {"format_version": 2, "lines": [self.lyrics["lines"][0], repeated]}
        raw = evidence(lyrics)
        raw.update(duration_ms=3000, frames=149)
        result = map_alignment_to_lyrics(lyrics, raw, duration_ms=3000, job_id=self.job)
        self.assertEqual(result["lyrics"], lyrics)
        self.assertNotEqual(result["lyrics"]["lines"][0]["start_ms"],
                            result["lyrics"]["lines"][1]["start_ms"])

    def test_provider_nonfinite_support_is_rejected(self):
        for value in (float("nan"), float("inf")):
            raw = deepcopy(self.evidence)
            raw["units"][0]["acoustic_support"] = value
            with self.subTest(value=value), self.assertRaises(ValidationError):
                AlignmentEvidence.model_validate(raw)

    def repeated_case(self):
        lines = []
        for repeat in range(4):
            units = [dict(id=str(uuid4()), text=word,
                          start_ms=(repeat * 4 + index) * 100,
                          end_ms=(repeat * 4 + index) * 100 + 80)
                     for index, word in enumerate("a b c d".split())]
            lines.append(dict(id=str(uuid4()), text="a b c d", start_ms=units[0]["start_ms"],
                              end_ms=units[-1]["end_ms"], syllables=units))
        lyrics = dict(format_version=2, lines=lines)
        return lyrics, evidence(lyrics)

    def test_ordered_edits_keep_valid_repeats_reviewable_with_decode_substitutions(self):
        lyrics, raw = self.repeated_case()
        raw["recognized_text"] = "x b c d a x c d a x x x a b c d"
        result = self.run_map(raw, lyrics)
        self.assertEqual(result["lyrics"], lyrics)
        self.assertEqual(result["diagnostics"]["aligned_units"], 16)
        self.assertEqual(result["diagnostics"]["transcript_agreement"], 0.6875)
        self.assertTrue(all("AMBIGUOUS_REPEAT" in flag["codes"]
                            and "LYRIC_MISMATCH" in flag["codes"]
                            for flag in result["quality_report"]["flags"]))

    def test_missing_repeat_is_not_accepted_as_the_complete_song(self):
        lyrics, raw = self.repeated_case()
        raw["recognized_text"] = "a b c d"
        with self.assertRaises(AlignmentRejected) as error:
            self.run_map(raw, lyrics)
        self.assertEqual(error.exception.code, "LYRICS_NOT_MATCHED")


if __name__ == "__main__":
    unittest.main()
