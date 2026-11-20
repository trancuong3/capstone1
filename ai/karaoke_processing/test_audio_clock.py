"""Clock checks with deterministic waveforms, not music-quality benchmarks."""
import unittest
import numpy as np
from audio_clock import verify_encoded_clock, verify_reference_clock


class AudioClockTests(unittest.TestCase):
    def setUp(self):
        self.sample_rate = 1000
        rng = np.random.default_rng(14)
        self.signal = rng.standard_normal(15000)
        # Broad, varying amplitude envelopes make tempo/cut shifts measurable.
        amplitude = np.repeat(rng.uniform(0.02, 1, 150), 100)
        self.signal *= amplitude

    def test_codec_noise_without_offset_keeps_clock(self):
        rng = np.random.default_rng(1)
        result = verify_encoded_clock(self.signal, self.signal + rng.normal(0, 0.001, 15000), 1000)
        self.assertEqual(result["offset_ms"], 0)
        self.assertEqual(result["anchors"], 3)

    def test_same_duration_does_not_hide_a_shift(self):
        shifted = np.roll(self.signal, 200)
        for check in (verify_encoded_clock, verify_reference_clock):
            with self.subTest(check=check.__name__), self.assertRaises(ValueError):
                check(self.signal, shifted, 1000)

    def test_matching_reference_requires_measured_common_music(self):
        result = verify_reference_clock(self.signal, self.signal * 0.7, 1000)
        self.assertTrue(result["verified"])
        self.assertEqual(result["max_absolute_offset_ms"], 0)

    def test_flat_envelope_or_changed_tempo_is_not_proof(self):
        with self.assertRaises(ValueError):
            verify_reference_clock(np.ones(15000), np.ones(15000), 1000)
        warped = np.interp(np.linspace(0, 14999, 15000) ** 1.01 / 14999 ** 0.01,
                           np.arange(15000), self.signal)
        with self.assertRaises(ValueError):
            verify_reference_clock(self.signal, warped, 1000)

    def sparse_vocal(self):
        values = np.zeros(30000)
        rng = np.random.default_rng(41)
        for start, end in ((4000, 8000), (10000, 13000), (20000, 24000)):
            values[start:end] = rng.normal(0, 0.1, end - start)
        return values

    def test_quiet_fixed_windows_use_informative_original_anchors(self):
        signal = self.sparse_vocal()
        result = verify_encoded_clock(signal, signal.copy(), 1000)
        self.assertEqual(result["anchors"], 3)
        self.assertEqual(result["offset_ms"], 0)
        self.assertEqual(len(result["anchor_starts_ms"]), 3)
        self.assertEqual(result["algorithm_version"], "active-anchors-v2")

    def test_constant_dc_is_not_mistaken_for_informative_audio(self):
        signal = self.sparse_vocal()
        result = verify_encoded_clock(signal + 0.1, signal, 1000)
        self.assertEqual(result["anchors"], 3)
        self.assertEqual(result["offset_ms"], 0)

    def test_uninformative_audio_never_proves_clock(self):
        rng = np.random.default_rng(7)
        for signal in (np.zeros(15000), np.ones(15000) * 0.2, rng.normal(0, 1e-6, 15000)):
            with self.subTest(signal=signal[0]), self.assertRaises(ValueError):
                verify_encoded_clock(signal, signal, 1000)

    def test_informative_fixed_anchor_mismatch_is_not_skipped(self):
        decoded = self.signal.copy()
        decoded[:3000] = 0
        with self.assertRaises(ValueError):
            verify_encoded_clock(self.signal, decoded, 1000)

    def test_fallback_does_not_hide_large_timing_shift(self):
        signal = self.sparse_vocal()
        with self.assertRaises(ValueError):
            verify_encoded_clock(signal, np.roll(signal, 80), 1000)

    def test_existing_twenty_ms_timing_limit_is_unchanged(self):
        result = verify_encoded_clock(self.signal, np.roll(self.signal, 19), 1000)
        self.assertEqual(result["max_absolute_offset_ms"], 19)
        with self.assertRaises(ValueError):
            verify_encoded_clock(self.signal, np.roll(self.signal, 21), 1000)

    def test_low_correlation_cannot_pass_using_another_anchor(self):
        unrelated = np.random.default_rng(92).normal(0, 0.2, len(self.signal))
        with self.assertRaises(ValueError):
            verify_encoded_clock(self.signal, unrelated, 1000)

    def test_length_change_cannot_be_hidden_by_active_anchors(self):
        signal = self.sparse_vocal()
        with self.assertRaises(ValueError):
            verify_encoded_clock(signal, np.pad(signal, (0, 60)), 1000)

    def test_short_audio_does_not_count_the_same_anchor_three_times(self):
        signal = self.signal[:500]
        result = verify_encoded_clock(signal, signal, 1000)
        self.assertEqual(result["anchors"], 1)
        self.assertEqual(result["anchor_starts_ms"], [0])

    def test_invalid_or_nonfinite_signal_fails_closed(self):
        for original, decoded, rate in (([], [], 1000), (self.signal, self.signal, 0),
                                       (self.signal, self.signal, True),
                                       (np.ones((1000, 2)), np.ones((1000, 2)), 1000),
                                       (np.full(1000, np.nan), np.ones(1000), 1000),
                                       (np.ones(1000), np.full(1000, np.inf), 1000)):
            with self.subTest(rate=rate), self.assertRaises(ValueError):
                verify_encoded_clock(original, decoded, rate)


if __name__ == "__main__":
    unittest.main()
