"""Pure tests for Vietnamese OCR chunk boundaries and lossless reconstruction."""

import os
import unittest
import unicodedata

os.environ.setdefault("DATABASE_URL", "postgresql+asyncpg://test:test@127.0.0.1:1/test")
os.environ.setdefault("SUPABASE_URL", "https://example.supabase.co")
os.environ.setdefault("SUPABASE_KEY", "isolated-test-key")

from app.services.admin_ocr_chunking import (
    ChunkingConfig,
    ChunkingError,
    chunk_ocr_text,
    reconstruct_ocr_text,
)


class AdminOcrChunkingTests(unittest.TestCase):
    def test_empty_and_whitespace_text_are_rejected(self):
        for value in ("", " \t\n  "):
            with self.subTest(value=repr(value)), self.assertRaises(ChunkingError):
                chunk_ocr_text(value)

    def test_short_vietnamese_text_uses_one_chunk_and_normalizes_nfc(self):
        decomposed = unicodedata.normalize("NFD", "Ngày xưa có bé.")
        plan = chunk_ocr_text(decomposed)

        self.assertEqual(plan.text, "Ngày xưa có bé.")
        self.assertEqual(len(plan.chunks), 1)
        self.assertEqual(plan.chunks[0].chunk_id, 0)
        self.assertEqual(plan.chunks[0].start_token_index, 0)
        self.assertEqual(plan.chunks[0].end_token_index, 4)
        self.assertEqual(plan.chunks[0].expected_word_count, 4)
        self.assertEqual(plan.chunks[0].target_text, "Ngày xưa có bé.")

    def test_prefers_paragraph_then_line_then_sentence_boundaries(self):
        paragraph_plan = chunk_ocr_text(
            "A one. B two.\n\nC three.",
            ChunkingConfig(max_chars=14, max_chunks=10, context_chars=10),
        )
        self.assertEqual(
            paragraph_plan.chunks[0].target_text,
            "A one. B two.",
        )
        self.assertEqual(paragraph_plan.chunks[1].target_text, "C three.")

        line_plan = chunk_ocr_text(
            "A one.\nB two. C three.",
            ChunkingConfig(max_chars=13, max_chunks=10, context_chars=10),
        )
        self.assertIn("\n", line_plan.text)
        self.assertEqual(line_plan.chunks[0].target_text, "A one.")

        sentence_plan = chunk_ocr_text(
            "A one. B two C three",
            ChunkingConfig(max_chars=13, max_chunks=10, context_chars=10),
        )
        self.assertEqual(sentence_plan.chunks[0].target_text, "A one.")

    def test_long_paragraph_falls_back_to_safe_whitespace(self):
        text = "Ngày xưa có một gia đình sống ở làng nhỏ."
        plan = chunk_ocr_text(
            text,
            ChunkingConfig(max_chars=14, max_chunks=10, context_chars=12),
        )

        self.assertGreater(len(plan.chunks), 1)
        self.assertTrue(all(len(chunk.target_text) <= 14 for chunk in plan.chunks))
        self.assertEqual(
            [token.index for chunk in plan.chunks for token in chunk.tokens],
            list(range(10)),
        )
        self.assertEqual(
            [chunk.chunk_id for chunk in plan.chunks],
            list(range(len(plan.chunks))),
        )

    def test_oversized_single_token_and_chunk_count_limit_fail_closed(self):
        with self.assertRaises(ChunkingError):
            chunk_ocr_text(
                "supercalifragilistic",
                ChunkingConfig(max_chars=5, max_chunks=10, context_chars=0),
            )
        with self.assertRaises(ChunkingError):
            chunk_ocr_text(
                "một hai ba bốn",
                ChunkingConfig(max_chars=3, max_chunks=2, context_chars=0),
            )

    def test_context_is_read_only_adjacent_source_and_stable(self):
        text = "Trước đoạn. TARGET words. Sau đoạn."
        first = chunk_ocr_text(
            text,
            ChunkingConfig(max_chars=12, max_chunks=10, context_chars=40),
        )
        second = chunk_ocr_text(
            text,
            ChunkingConfig(max_chars=12, max_chunks=10, context_chars=40),
        )

        self.assertEqual(
            [(c.chunk_id, c.start_token_index, c.end_token_index) for c in first.chunks],
            [(c.chunk_id, c.start_token_index, c.end_token_index) for c in second.chunks],
        )
        target = next(chunk for chunk in first.chunks if "TARGET" in chunk.target_text)
        self.assertIn("Trước đoạn.", target.previous_context)
        self.assertIn("Sau đoạn.", target.next_context)
        self.assertNotIn("TARGET", target.previous_context)
        self.assertNotIn("TARGET", target.next_context)

    def test_reconstruction_preserves_every_original_separator_and_offset(self):
        text = "Ngày  xưa,\ttrời mưa.\r\n\r\nBé đi học.  "
        plan = chunk_ocr_text(
            text,
            ChunkingConfig(max_chars=12, max_chunks=10, context_chars=6),
        )
        corrected = {
            chunk.chunk_id: tuple(token.text for token in chunk.tokens)
            for chunk in plan.chunks
        }
        result = reconstruct_ocr_text(plan, corrected)

        self.assertEqual(result, text)
        self.assertEqual(result.count("\r\n\r\n"), 1)
        self.assertIn("  xưa,\t", result)
        self.assertTrue(result.endswith("  "))

    def test_reconstruction_replaces_tokens_without_touching_spacing(self):
        text = "Ngày   xưa.\nBé\tđi học."
        plan = chunk_ocr_text(
            text,
            ChunkingConfig(max_chars=9, max_chunks=10, context_chars=4),
        )
        corrected = {
            chunk.chunk_id: tuple(
                "đến" if token.text == "đi" else token.text
                for token in chunk.tokens
            )
            for chunk in plan.chunks
        }

        result = reconstruct_ocr_text(plan, corrected)

        self.assertEqual(result, "Ngày   xưa.\nBé\tđến học.")
        self.assertEqual(len(result.split()), len(text.split()))

    def test_reconstruction_rejects_missing_chunks_and_multiword_tokens(self):
        plan = chunk_ocr_text("Ngày xưa có bé.")
        with self.assertRaises(ChunkingError):
            reconstruct_ocr_text(plan, {})
        with self.assertRaises(ChunkingError):
            reconstruct_ocr_text(plan, {0: ("Ngày", "xưa", "một bé", "bé.")})

    def test_reconstruction_rejects_changed_punctuation(self):
        plan = chunk_ocr_text("Ngày xưa có bé.")
        with self.assertRaisesRegex(ChunkingError, "preserve source punctuation"):
            reconstruct_ocr_text(plan, {0: ("Ngày", "xưa", "có", "bé!")})

    def test_nfd_correction_is_normalized_without_changing_token_count(self):
        plan = chunk_ocr_text("Ngày xưa.")
        decomposed = unicodedata.normalize("NFD", "xưa.")

        result = reconstruct_ocr_text(plan, {0: ("Ngày", decomposed)})

        self.assertEqual(result, "Ngày xưa.")
        self.assertEqual(result, unicodedata.normalize("NFC", result))


if __name__ == "__main__":
    unittest.main()
