import unittest

from app.services.games.memory_scene_generator import (
    SPRITE_CATALOG,
    _sprite_matches_focus_word,
    generate_scene_spec,
)


class TestMemoryPersonalizationRegressions(unittest.TestCase):
    def test_tone_marks_and_whole_words_distinguish_unrelated_reading_words(self):
        kite = next(sprite for sprite in SPRITE_CATALOG if sprite.sprite_key == "paper_kite")
        self.assertTrue(_sprite_matches_focus_word(kite, "diều"))
        self.assertTrue(_sprite_matches_focus_word(kite, "diều giấy"))
        self.assertFalse(_sprite_matches_focus_word(kite, "điều"))
        self.assertFalse(_sprite_matches_focus_word(kite, "giấy tờ"))

    def test_scene_keeps_real_focus_word_and_does_not_claim_unrelated_word(self):
        scene = generate_scene_spec(
            theme_key="sunny_garden", child_grade=2,
            difficulty_level=2, scene_seed=42, focus_words=["điều", "diều"],
        )
        self.assertIn("diều", scene.matched_focus_words)
        self.assertNotIn("điều", scene.matched_focus_words)


if __name__ == "__main__":
    unittest.main()
