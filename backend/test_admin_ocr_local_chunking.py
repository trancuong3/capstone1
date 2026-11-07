"""Bounded local OCR chunking and exact reconstruction tests."""
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


class LocalOcrChunkingTests(unittest.TestCase):
    def test_long_articles_are_chunked_without_dropping_source_tokens(self):
        plan = chunk_ocr_text(" ".join(f"tu{i}" for i in range(3000)))

        self.assertEqual(ChunkingConfig().max_words, 48)
        self.assertEqual(ChunkingConfig().max_chunks, 128)
        self.assertEqual(len(plan.chunks), 63)
        self.assertLessEqual(
            max(chunk.expected_word_count for chunk in plan.chunks), 48
        )
        self.assertEqual(
            [token.index for chunk in plan.chunks for token in chunk.tokens],
            list(range(3000)),
        )
        unchanged = {
            chunk.chunk_id: tuple(token.text for token in chunk.tokens)
            for chunk in plan.chunks
        }
        self.assertEqual(reconstruct_ocr_text(plan, unchanged), plan.text)

    def test_nfc_utf8_byte_word_and_chunk_limits_are_enforced(self):
        text = unicodedata.normalize("NFD", "Ngày xưa bé đi học. Trời mưa.")
        config = ChunkingConfig(
            max_bytes=18, max_words=3, max_chunks=10,
            context_bytes=8, max_document_bytes=1000,
        )
        plan = chunk_ocr_text(text, config)

        self.assertEqual(plan.text, unicodedata.normalize("NFC", text))
        self.assertGreater(len(plan.chunks), 1)
        self.assertTrue(all(len(chunk.target_text.encode("utf-8")) <= 18 for chunk in plan.chunks))
        self.assertTrue(all(chunk.expected_word_count <= 3 for chunk in plan.chunks))
        self.assertEqual(
            [token.index for chunk in plan.chunks for token in chunk.tokens],
            list(range(len(plan.tokens))),
        )

    def test_context_limits_are_utf8_safe_and_whitespace_reconstruction_is_lossless(self):
        text = "Trước đoạn.\n\nNgày  xưa,\ttrời mưa.  Sau đoạn."
        plan = chunk_ocr_text(
            text,
            ChunkingConfig(max_bytes=18, max_words=3, max_chunks=10,
                           context_bytes=7, max_document_bytes=1000),
        )
        corrected = {
            chunk.chunk_id: tuple(token.text for token in chunk.tokens)
            for chunk in plan.chunks
        }
        result = reconstruct_ocr_text(plan, corrected)

        self.assertEqual(result, text)
        self.assertIn("\n\n", result)
        self.assertIn("  xưa,\t", result)
        for chunk in plan.chunks:
            self.assertLessEqual(len(chunk.previous_context.encode("utf-8")), 7)
            self.assertLessEqual(len(chunk.next_context.encode("utf-8")), 7)

    def test_document_single_word_and_chunk_count_limits_fail_closed(self):
        with self.assertRaisesRegex(ChunkingError, "MAX_DOCUMENT_BYTES"):
            chunk_ocr_text(
                "Ngày xưa bé.",
                ChunkingConfig(max_bytes=20, max_words=10, max_chunks=10,
                               context_bytes=0, max_document_bytes=5),
            )
        with self.assertRaises(ChunkingError):
            chunk_ocr_text(
                "vietnamese",
                ChunkingConfig(max_bytes=4, max_words=10, max_chunks=10,
                               context_bytes=0, max_document_bytes=100),
            )
        with self.assertRaisesRegex(ChunkingError, "MAX_CHUNKS"):
            chunk_ocr_text(
                "một hai ba bốn",
                ChunkingConfig(max_bytes=5, max_words=1, max_chunks=2,
                               context_bytes=0, max_document_bytes=100),
            )

    def test_reconstruction_rejects_bad_counts_and_preserves_source_punctuation(self):
        plan = chunk_ocr_text("Ngày xưa có bé.")
        with self.assertRaises(ChunkingError):
            reconstruct_ocr_text(plan, {})
        with self.assertRaisesRegex(ChunkingError, "token count"):
            reconstruct_ocr_text(plan, {0: ("Ngày", "xưa")})
        corrected = reconstruct_ocr_text(
            plan, {0: ("Ngày?", "xưa!", "có,", "bé!")}
        )
        self.assertEqual(corrected, "Ngày xưa có bé.")

    def test_reconstruction_keeps_boundary_punctuation_and_skips_internal_punctuation(self):
        plan = chunk_ocr_text("“ngay,” (xua). tu-tu")
        corrected = reconstruct_ocr_text(
            plan,
            {0: ("ngày?", "xưa!", "từ_từ")},
        )
        self.assertEqual(corrected, "“ngày,” (xưa). tu-tu")


if __name__ == "__main__":
    unittest.main()
