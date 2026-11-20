"""Automatic karaoke input/config contracts; no database or provider calls."""
import unittest
from uuid import uuid4

from pydantic import ValidationError

from app.core.karaoke_processing_config import KaraokeConfigurationError, KaraokeProcessingConfig
from app.schemas.karaoke_processing import ProcessingReview, ProcessingStart, QualityFlag


class ProcessingContractTests(unittest.TestCase):
    def test_start_forbids_client_provider_paths_and_hashes(self):
        data = dict(expected_revision=1, draft_version_id=uuid4(), idempotency_key=uuid4())
        self.assertEqual(ProcessingStart(**data).mode, "VOCAL_TRACK")
        for key in ("audio_path", "provider", "input_fingerprint", "lyrics", "reviewed"):
            with self.subTest(key=key), self.assertRaises(ValidationError):
                ProcessingStart(**data, **{key: "injected"})
        with self.assertRaises(ValidationError):
            ProcessingStart(**{**data, "expected_revision": True})

    def test_review_requires_strict_confirmation_and_unique_flags(self):
        data = dict(expected_revision=2, draft_version_id=uuid4(), content_fingerprint="a" * 64,
                    confirmed_listened=True)
        ProcessingReview(**data)
        for value in ("true", 1, None):
            with self.subTest(value=value), self.assertRaises(ValidationError):
                ProcessingReview(**{**data, "confirmed_listened": value})
        key = uuid4()
        with self.assertRaises(ValidationError):
            ProcessingReview(**data, acknowledged_flag_ids=[key, key])

    def test_quality_message_must_match_a_bounded_code(self):
        data = dict(id=uuid4(), codes=["UNALIGNED_SYLLABLES"],
                    affected_syllable_count=1, message_key="UNALIGNED_SYLLABLES")
        QualityFlag(**data)
        with self.assertRaises(ValidationError):
            QualityFlag(**{**data, "message_key": "LOW_ALIGNMENT_SUPPORT"})

    def test_defaults_disable_automatic_processing(self):
        config = KaraokeProcessingConfig.from_env({})
        self.assertFalse(config.enabled)
        self.assertFalse(config.worker_enabled)
        self.assertFalse(config.configured)
        self.assertEqual(config.concurrency, 1)

    def test_missing_or_invalid_daily_caps_fail_closed_when_enabled(self):
        for enabled in ("KARAOKE_PROCESSING_ENABLED", "KARAOKE_PROCESSING_WORKER_ENABLED"):
            for value in (None, "", "0", "-1", "1.5", "infinity"):
                env = {enabled: "true"}
                if value is not None:
                    env["KARAOKE_MAX_RESERVED_AUDIO_MINUTES_PER_ADMIN_DAY"] = value
                with self.subTest(enabled=enabled, value=value), self.assertRaises(KaraokeConfigurationError):
                    KaraokeProcessingConfig.from_env(env)

    def test_heartbeat_must_leave_room_for_lease_renewal(self):
        with self.assertRaises(KaraokeConfigurationError):
            KaraokeProcessingConfig.from_env({"KARAOKE_WORKER_HEARTBEAT_SECONDS": "40"})

    def test_unknown_boolean_and_unsafe_pipeline_label_rejected(self):
        for env in ({"KARAOKE_PROCESSING_ENABLED": "yes"},
                    {"KARAOKE_PROCESSING_PIPELINE_VERSION": "two words"}):
            with self.assertRaises(KaraokeConfigurationError):
                KaraokeProcessingConfig.from_env(env)


if __name__ == "__main__":
    unittest.main()
