import unittest
from datetime import datetime, timedelta, timezone
from uuid import uuid4

from app.models.difficult_word_practice import DifficultWordPracticeAttempt
from app.models.karaoke import KaraokeSongVersion, utcnow
from app.schemas.karaoke import MelodyProfileRead
from app.services.active_weak_words import (
    classify_vietnamese_phonics_category,
    is_word_mastered_across_contexts,
    match_focus_words_in_text,
    match_focus_words_in_tokens,
)
from app.services.difficult_words_service import compute_word_practice_progress
from app.services.karaoke_children_catalog import (
    CHILDREN_KARAOKE_PACK,
    build_melody_profile_for_v2_lyrics,
    build_ngoi_sao_nho_melody_profile,
    build_timed_lyrics_for_spec,
)
from app.services.karaoke_service import content_issues


def _make_attempt(
    *,
    normalized_word: str = "lung linh",
    display_text: str = "lung linh",
    attempt_number: int = 1,
    is_correct: bool,
    assessment_version: int = 1,
    minutes_ago: int = 0,
) -> DifficultWordPracticeAttempt:
    created = datetime.now(timezone.utc) - timedelta(minutes=minutes_ago)
    return DifficultWordPracticeAttempt(
        Id=uuid4(),
        ChildId=uuid4(),
        ParentId=uuid4(),
        NormalizedWord=normalized_word,
        DisplayText=display_text,
        AttemptNumber=attempt_number,
        RequestId=uuid4(),
        CompletionRequestId=uuid4(),
        State="COMPLETED",
        AssessmentStatus="CORRECT" if is_correct else "INCORRECT",
        RecognitionSource="SERVER_STT_KEYTERM",
        SpokenTranscript=display_text if is_correct else "sai",
        Confidence=0.95 if is_correct else 0.35,
        AssessmentVersion=assessment_version,
        StartedAt=created,
        CompletedAt=created,
        CreatedAt=created,
        UpdatedAt=created,
    )


class EntertainmentWeakWordsAndCatalogTests(unittest.TestCase):
    def test_vietnamese_phonics_classifier_covers_gdpt_2018_groups(self) -> None:
        cases = {
            "lung linh": "compound_reduplicative",
            "lá": "l_n",
            "nắng": "l_n",
            "xinh": "s_x",
            "trăng": "tr_ch",
            "rực": "r_d_gi",
            "ngã": "hoi_nga",
            "mắt": "coda_n_ng_t_c",
        }
        for word, expected_key in cases.items():
            key, label_vi = classify_vietnamese_phonics_category(word)
            self.assertEqual(key, expected_key, f"Unexpected phonics group for {word!r}: got {key!r}")
            self.assertTrue(label_vi.strip())

    def test_ngram_focus_word_matcher_handles_multisyllable_and_strict_vietnamese_tones(self) -> None:
        focus = ["lung linh", "hoa hướng dương", "diều", "trăng sáng"]
        text = "Đêm rằm có điều thú vị: đèn ông sao lung linh bên hoa hướng dương!"
        matched = match_focus_words_in_text(text, focus)
        self.assertEqual(matched, ["lung linh", "hoa hướng dương"])
        # "điều" must NOT match tone/letter-distinct "diều"
        self.assertNotIn("diều", matched)

        tokens = ["Chú", "thả", "diều", "dưới", "ánh", "trăng", "sáng."]
        matched_words, matched_indices = match_focus_words_in_tokens(tokens, focus)
        self.assertEqual(matched_words, ["diều", "trăng sáng"])
        self.assertEqual(matched_indices, {2, 5, 6})

    def test_empty_and_blank_inputs_return_clean_empty_matches(self) -> None:
        self.assertEqual(match_focus_words_in_text("", ["lung linh"]), [])
        self.assertEqual(match_focus_words_in_text("lung linh", []), [])
        words, indices = match_focus_words_in_tokens([], ["lung linh"])
        self.assertEqual(words, [])
        self.assertEqual(indices, set())

    def test_two_tier_graduation_requires_two_entertainment_voice_passes_or_one_isolated_pass(self) -> None:
        isolated_attempts = [
            _make_attempt(attempt_number=1, is_correct=False, assessment_version=1, minutes_ago=10),
            _make_attempt(attempt_number=2, is_correct=True, assessment_version=1, minutes_ago=2),
        ]
        isolated_mastered = compute_word_practice_progress("lung linh", isolated_attempts)
        self.assertEqual(isolated_mastered.practice_status, "COMPLETED")
        self.assertEqual(isolated_mastered.consecutive_correct_count, 1)
        self.assertTrue(is_word_mastered_across_contexts(isolated_attempts))

        one_ent_attempts = [
            _make_attempt(attempt_number=1, is_correct=False, assessment_version=1, minutes_ago=10),
            _make_attempt(attempt_number=2, is_correct=True, assessment_version=2, minutes_ago=2),
        ]
        one_ent_pass = compute_word_practice_progress("lung linh", one_ent_attempts)
        self.assertNotEqual(one_ent_pass.practice_status, "COMPLETED")
        self.assertEqual(one_ent_pass.consecutive_correct_count, 1)
        self.assertEqual(one_ent_pass.required_consecutive_correct, 2)
        self.assertFalse(is_word_mastered_across_contexts(one_ent_attempts))

        two_ent_attempts = [
            _make_attempt(attempt_number=1, is_correct=False, assessment_version=1, minutes_ago=10),
            _make_attempt(attempt_number=2, is_correct=True, assessment_version=2, minutes_ago=5),
            _make_attempt(attempt_number=3, is_correct=True, assessment_version=2, minutes_ago=1),
        ]
        two_ent_passes = compute_word_practice_progress("lung linh", two_ent_attempts)
        self.assertEqual(two_ent_passes.practice_status, "COMPLETED")
        self.assertEqual(two_ent_passes.consecutive_correct_count, 2)
        self.assertTrue(is_word_mastered_across_contexts(two_ent_attempts))

        # Regression: an earlier Entertainment v2 attempt followed by an INCORRECT reset
        # must reset required_consecutive_correct back to 1 for isolated room practice.
        reset_after_ent = [
            _make_attempt(attempt_number=1, is_correct=True, assessment_version=2, minutes_ago=10),
            _make_attempt(attempt_number=2, is_correct=False, assessment_version=1, minutes_ago=3),
        ]
        reset_prog = compute_word_practice_progress("lung linh", reset_after_ent)
        self.assertEqual(reset_prog.practice_status, "NEEDS_MORE_PRACTICE")
        self.assertEqual(reset_prog.consecutive_correct_count, 0)
        self.assertEqual(reset_prog.required_consecutive_correct, 1)

        # Same-timestamp tie-breaker: an INCORRECT reading comparison report at the exact
        # same timestamp must never be masked by a CORRECT attempt.
        tied_ts = datetime.now(timezone.utc)
        tied_correct = _make_attempt(attempt_number=1, is_correct=True, assessment_version=1, minutes_ago=0)
        tied_incorrect = _make_attempt(attempt_number=2, is_correct=False, assessment_version=1, minutes_ago=0)
        tied_correct.CompletedAt = tied_ts
        tied_incorrect.CompletedAt = tied_ts
        self.assertFalse(is_word_mastered_across_contexts([tied_incorrect, tied_correct]))

    def test_memory_evaluator_and_vocal_writeback_reject_aliases_and_wrong_tones(self) -> None:
        from app.services.games.memory_game_evaluator import evaluate_memory_attempt_deterministic
        from app.services.games.memory_scene_generator import generate_scene_spec

        scene = generate_scene_spec(
            theme_key="sunny_garden",
            child_grade=2,
            difficulty_level=2,
            scene_seed=42,
            focus_words=["diều giấy", "vững chãi"],
        )
        # Child uses alias "con diều" and wrong tone "vưng chai" -> object recall matches,
        # but `used_focus_words` must NOT falsely credit unpronounced "diều giấy" or wrong-tone "vững chãi"!
        alias_eval = evaluate_memory_attempt_deterministic(
            scene_spec=scene,
            stage="RECALL",
            response_text="Bé thấy con diều màu đỏ bay vưng chai trên trời.",
        )
        self.assertEqual(alias_eval.used_focus_words, [])

        # Exact NFC tone pronunciation ("diều giấy", "vững chãi") IS credited!
        exact_eval = evaluate_memory_attempt_deterministic(
            scene_spec=scene,
            stage="CREATIVE",
            response_text="Chiếc diều giấy bay lên thật vững chãi giữa bầu trời.",
        )
        self.assertIn("vững chãi", exact_eval.used_focus_words)

    def test_karaoke_practice_requires_actual_lyrics_score_before_vocal_word_graduation(self) -> None:
        import asyncio
        from unittest.mock import AsyncMock, patch
        from app.schemas.karaoke_practice import KaraokePracticeSessionCreate
        from app.services.karaoke_practice_service import KaraokePracticeService

        child_id = uuid4()
        parent_id = uuid4()
        song_id = uuid4()
        version_id = uuid4()

        repo = AsyncMock()
        repo.db = None
        repo.get_child_for_parent.return_value = type("Child", (), {"Id": child_id, "Grade": 2})()
        repo.get_song_and_published_version.return_value = (
            type("Song", (), {"id": song_id, "published_version_id": version_id, "status": "PUBLISHED"})(),
            type("Ver", (), {"id": version_id})(),
        )
        repo.create_practice_session.side_effect = lambda row, _ev: row

        svc = KaraokePracticeService(repo)
        with patch(
            "app.services.active_weak_words.record_entertainment_vocal_word_practice",
            new_callable=AsyncMock,
        ) as mock_record:
            # 1. Humming / DSP-only session (`lyrics_score=None`) must NOT record vocal word mastery
            asyncio.run(
                svc.create_practice_session(
                    parent_id,
                    KaraokePracticeSessionCreate(
                        child_id=child_id,
                        song_id=song_id,
                        song_version_id=version_id,
                        practice_mode="FULL_SONG",
                        scoring_mode="FULL_MUSICAL",
                        playback_rate=1.0,
                        headphone_mode=False,
                        overall_score=82,
                        rhythm_score=80,
                        pitch_score=84,
                        lyrics_score=None,
                        fluency_score=80,
                        stars=3,
                        report_payload={"matched_difficult_words": ["lung linh"]},
                    ),
                )
            )
            mock_record.assert_not_called()

            # 2. Sung session with verified `lyrics_score >= 55` DOES record vocal word mastery
            asyncio.run(
                svc.create_practice_session(
                    parent_id,
                    KaraokePracticeSessionCreate(
                        child_id=child_id,
                        song_id=song_id,
                        song_version_id=version_id,
                        practice_mode="FULL_SONG",
                        scoring_mode="FULL_MUSICAL",
                        playback_rate=1.0,
                        headphone_mode=False,
                        overall_score=85,
                        rhythm_score=82,
                        pitch_score=86,
                        lyrics_score=80,
                        fluency_score=82,
                        stars=3,
                        report_payload={"matched_difficult_words": ["lung linh"]},
                    ),
                )
            )
            mock_record.assert_called_once()

    def test_picture_ai_single_bonus_and_strict_tone_vocal_writeback(self) -> None:
        import asyncio
        from unittest.mock import AsyncMock, patch
        from app.services.picture_description_ai import GeminiPictureDescriptionAI

        captured_prompts: list[str] = []

        async def fake_gen(**kwargs):
            captured_prompts.append(kwargs["prompt"])
            # Simulate LLM grading base score=6 without pre-adding target bonus
            return (
                {
                    "is_relevant": True,
                    "score_out_of_10": 6,
                    "matched_details": ["Chú mèo cam ngủ trên ghế"],
                    "missed_details": ["Hoa hướng dương"],
                    "praise_message": "Thầy khen bé kể đúng bức tranh!",
                    "improvement_tip": "Bé nối câu dài hơn nhé.",
                    "upgraded_sentences": ["Chú mèo cam nằm ngủ vững chãi trên ghế gỗ."],
                    "vocabulary_highlights": ["vững chãi", "ghế gỗ"],
                    "scaffolding_step": "EXPAND",
                    "next_prompt_question": "Thầy đố bé ghế gỗ có màu gì?",
                },
                "gemini-3.5-flash-lite",
            )

        ai = GeminiPictureDescriptionAI()
        with patch.object(ai, "_generate_json", side_effect=fake_gen):
            feedback, _ = asyncio.run(
                ai.evaluate_description(
                    image_bytes=b"fake",
                    mime_type="image/jpeg",
                    child_grade=2,
                    scene_title="Khu vườn đầy nắng",
                    guiding_questions=["Trong tranh có con vật gì?"],
                    child_transcript="Chú mèo cam nằm ngủ vững chãi trên chiếc ghế gỗ",
                    target_words=["vững chãi"],
                    teacher_gender="male",
                )
            )
        # Deterministic +1 applied ONCE: 6 -> 7 (2 stars), NOT 8 (3 stars)!
        self.assertEqual(feedback.score_out_of_10, 7)
        self.assertIn("KHÔNG tự cộng điểm thưởng", captured_prompts[0])

    def test_all_children_karaoke_songs_and_ngoi_sao_nho_melody_profile_pass_strict_validation(self) -> None:
        self.assertEqual(len(CHILDREN_KARAOKE_PACK), 7)
        now = utcnow()
        seen_slugs: set[str] = set()
        for spec in CHILDREN_KARAOKE_PACK:
            self.assertNotIn(spec.slug, seen_slugs)
            seen_slugs.add(spec.slug)
            self.assertGreaterEqual(spec.min_grade, 1)
            self.assertLessEqual(spec.max_grade, 5)
            self.assertLessEqual(spec.min_grade, spec.max_grade)
            lyrics, duration_ms = build_timed_lyrics_for_spec(spec)
            self.assertGreater(duration_ms, 20_000)
            version_row = KaraokeSongVersion(
                id=spec.deterministic_version_id,
                song_id=spec.deterministic_song_id,
                version_no=1,
                state="PUBLISHED",
                title=spec.title,
                author=spec.author,
                min_grade=spec.min_grade,
                max_grade=spec.max_grade,
                source_note=spec.source_note,
                usage_note=spec.usage_note,
                audio_path=f"songs/{spec.deterministic_song_id}/audio.mp3",
                cover_path=f"songs/{spec.deterministic_song_id}/cover.webp",
                audio_sha256="a" * 64,
                timed_audio_sha256="a" * 64,
                requires_processing_review=False,
                audio_size_bytes=120_000,
                duration_ms=duration_ms,
                lyrics=lyrics,
                created_at=now,
                updated_at=now,
                published_at=now,
            )
            issues = content_issues(version_row)
            self.assertEqual(issues, [], f"Issues found in {spec.slug}: {issues}")
            melody = build_melody_profile_for_v2_lyrics(
                lyrics,
                line_midis=tuple(midis for _text, midis in spec.lines),
                duration_ms=duration_ms,
                bpm=spec.bpm,
            )
            validated_melody = MelodyProfileRead.model_validate(melody)
            self.assertEqual(
                len(validated_melody.notes),
                sum(len(midis) for _text, midis in spec.lines),
            )

        demo_lyrics = {
            "lines": [
                {
                    "id": str(uuid4()),
                    "text": "Kìa ngôi sao nhỏ lung linh trên cao",
                    "start_ms": 1000,
                    "end_ms": 4800,
                    "syllables": [
                        {
                            "id": str(uuid4()),
                            "text": word,
                            "start_ms": 1000 + idx * 450,
                            "end_ms": 1400 + idx * 450,
                        }
                        for idx, word in enumerate(
                            ["Kìa", "ngôi", "sao", "nhỏ", "lung", "linh", "trên", "cao"]
                        )
                    ],
                }
            ]
        }
        demo_melody = MelodyProfileRead.model_validate(
            build_ngoi_sao_nho_melody_profile(demo_lyrics, duration_ms=103_366)
        )
        self.assertEqual(len(demo_melody.notes), 8)
        self.assertGreaterEqual(demo_melody.min_midi, 60.0)


if __name__ == "__main__":
    unittest.main()
