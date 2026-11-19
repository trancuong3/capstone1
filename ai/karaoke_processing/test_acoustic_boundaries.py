"""Pure envelope tests: no checkpoint, network or singing-quality claims."""
import unittest
import numpy as np
from acoustic_boundaries import refine_held_notes


class AcousticBoundaryTests(unittest.TestCase):
    def test_sustained_vowel_ends_at_measured_quiet(self):
        samples = np.zeros(32000)
        samples[8000:24000] = 0.2
        result = refine_held_notes(samples, [dict(start_ms=500, end_ms=560)])
        self.assertLess(abs(result[0]["end_ms"] - 1500), 80)
        self.assertEqual(result[0]["ctc_end_ms"], 560)
        self.assertEqual(result[0]["end_evidence"], "silence_boundary")

    def test_continuous_ambiguous_audio_never_becomes_uniform_spans(self):
        samples = np.ones(48000) * 0.2
        units = [dict(start_ms=500, end_ms=560), dict(start_ms=1500, end_ms=1560)]
        result = refine_held_notes(samples, units)
        self.assertTrue(all(item["end_ms"] is None for item in result))
        self.assertTrue(all(item["end_evidence"] == "unsupported" for item in result))
        self.assertEqual(units[0]["end_ms"], 560)

    def test_silence_does_not_invent_vocal_duration(self):
        result = refine_held_notes(np.zeros(32000), [dict(start_ms=100, end_ms=160)])
        self.assertIsNone(result[0]["end_ms"])

    def test_measured_delimiter_supports_legato_without_equal_partition(self):
        samples = np.ones(48000) * 0.2
        units = [dict(start_ms=500, end_ms=560), dict(start_ms=1900, end_ms=1960)]
        output = refine_held_notes(samples, units, ctc_boundaries={0: dict(time_ms=1750, support=.99)})
        self.assertEqual(output[0]["end_ms"], 1750)
        self.assertEqual(output[0]["end_evidence"], "ctc_delimiter")
        self.assertIsNone(output[1]["end_ms"])

    def test_low_support_outside_interval_or_silent_events_are_not_accepted(self):
        units = [dict(start_ms=500, end_ms=560), dict(start_ms=1900, end_ms=1960)]
        for event in (dict(time_ms=1750, support=.84), dict(time_ms=1900, support=.99),
                      dict(time_ms=550, support=.99), dict(time_ms=1750, support=float("nan"))):
            result = refine_held_notes(np.ones(48000) * .2, units, ctc_boundaries={0: event})
            self.assertIsNone(result[0]["end_ms"])
        result = refine_held_notes(np.zeros(48000), units, ctc_boundaries={0: dict(time_ms=1750, support=.99)})
        self.assertIsNone(result[0]["end_ms"])


class TransitionWindowTests(unittest.TestCase):
    def setUp(self):
        self.samples = np.ones(48000) * .2
        self.samples[46 * 320:49 * 320] = 0
        self.units = [dict(start_ms=500, end_ms=560), dict(start_ms=1000, end_ms=1060)]

    def test_valley_near_next_onset_can_use_right_hand_audio_context(self):
        result = refine_held_notes(self.samples, self.units)
        self.assertEqual(result[0]["end_ms"], 940)
        self.assertEqual(result[0]["end_evidence"], "energy_valley")
        self.assertLess(result[0]["end_ms"], self.units[1]["start_ms"])
        self.assertEqual(self.units[0]["end_ms"], 560)

    def test_existing_delimiter_measurement_is_not_replaced_by_new_valley(self):
        result = refine_held_notes(self.samples, self.units,
                                   ctc_boundaries={0: dict(time_ms=850, support=.99)})
        self.assertEqual(result[0]["end_ms"], 850)
        self.assertEqual(result[0]["end_evidence"], "ctc_delimiter")

    def test_small_dip_does_not_invent_a_transition(self):
        self.samples[46 * 320:49 * 320] = .18
        result = refine_held_notes(self.samples, self.units)
        self.assertIsNone(result[0]["end_ms"])

    def test_valley_at_following_onset_is_outside_the_current_word(self):
        self.samples[:] = .2
        self.samples[49 * 320:52 * 320] = 0
        result = refine_held_notes(self.samples, self.units)
        self.assertIsNone(result[0]["end_ms"])

    def test_insufficient_right_context_does_not_use_padded_silence(self):
        result = refine_held_notes(self.samples[:50 * 320], self.units)
        self.assertIsNone(result[0]["end_ms"])

    def test_transition_search_does_not_invent_an_end_for_the_last_word(self):
        result = refine_held_notes(self.samples, self.units[:1])
        self.assertIsNone(result[0]["end_ms"])


if __name__ == "__main__":
    unittest.main()
