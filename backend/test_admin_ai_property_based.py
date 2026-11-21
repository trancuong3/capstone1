"""Property-based invariant tests using Hypothesis (no external network/DB)."""
from __future__ import annotations

import os
import unicodedata
import unittest
from types import SimpleNamespace

os.environ.setdefault("DATABASE_URL", "postgresql+asyncpg://test:test@127.0.0.1:1/test")
os.environ.setdefault("SUPABASE_URL", "https://example.supabase.co")
os.environ.setdefault("SUPABASE_KEY", "isolated-test-key")

from hypothesis import given, settings, strategies as st

from app.services.admin_ocr_chunking import (
    ChunkingConfig,
    chunk_ocr_text,
    reconstruct_ocr_text,
)
from app.services.book_content_quality_service import BookContentQualityService
from app.services.ocr_ai.child_safety import _chunks as safety_chunks
from app.services.ocr_ai.child_safety import content_hash
from app.services.ocr_ai.exceptions import OcrProviderError
from app.services.ocr_ai.validators import validate_chunk_result


_VI_WORDS = st.sampled_from([
    "ngày", "xưa", "một", "chú", "mèo", "nhỏ", "đi", "học", "chăm", "chỉ",
    "người", "được", "hưởng", "thuở", "lấp", "lánh", "rộn", "ràng", "Đà", "Nẵng",
    "Sơn", "Tinh", "Thủy", "bé", "ngoan", "đẹp", "trời", "mưa", "nắng", "vui",
])
_BOUNDARY_PREFIX = st.sampled_from(["", "“", "‘", "(", "["])
_BOUNDARY_SUFFIX = st.sampled_from(["", ".", ",", "!", "?", "”", "’", ")"])
_WHITESPACE = st.sampled_from([" ", "  ", "\n", "\n\n", "\t"])


@st.composite
def vietnamese_document(draw):
    count = draw(st.integers(min_value=1, max_value=36))
    parts: list[str] = []
    for idx in range(count):
        if idx > 0:
            parts.append(draw(_WHITESPACE))
        prefix = draw(_BOUNDARY_PREFIX)
        word = draw(_VI_WORDS)
        suffix = draw(_BOUNDARY_SUFFIX)
        parts.append(f"{prefix}{word}{suffix}")
    return "".join(parts)


class OcrAndSafetyPropertyTests(unittest.TestCase):
    @settings(max_examples=60, deadline=None)
    @given(doc=vietnamese_document(), max_words=st.integers(min_value=8, max_value=24))
    def test_chunk_and_reconstruct_identity_preserves_exact_text_and_whitespace(
        self, doc: str, max_words: int
    ):
        cfg = ChunkingConfig(
            max_bytes=512,
            max_words=max_words,
            max_chunks=64,
            context_bytes=48,
            max_document_bytes=16384,
        )
        plan = chunk_ocr_text(doc, cfg)
        corrected_by_chunk = {
            chunk.chunk_id: tuple(token.text for token in chunk.tokens)
            for chunk in plan.chunks
        }
        reconstructed = reconstruct_ocr_text(plan, corrected_by_chunk)
        self.assertEqual(reconstructed, unicodedata.normalize("NFC", doc))
        self.assertEqual(
            sum(chunk.expected_word_count for chunk in plan.chunks),
            len(plan.tokens),
        )

    @settings(max_examples=60, deadline=None)
    @given(
        prefix=st.sampled_from(["", "‘", "“", "("]),
        suffix=st.sampled_from(["", ".", ",", "!", "?", "”"]),
        model_prefix=st.sampled_from(["", '"', "«"]),
        model_suffix=st.sampled_from(["", ";", ":", "..."]),
    )
    def test_validator_always_preserves_source_boundary_punctuation(
        self, prefix: str, suffix: str, model_prefix: str, model_suffix: str
    ):
        source = f"{prefix}ngay{suffix} xua"
        chunk = chunk_ocr_text(source, ChunkingConfig(max_words=16)).chunks[0]
        result = validate_chunk_result(
            {
                "chunk_id": chunk.chunk_id,
                "corrected_words": [f"{model_prefix}ngày{model_suffix}", "xưa"],
                "uncertain_word_indices": [],
            },
            chunk=chunk,
            provider="hypothesis",
        )
        self.assertEqual(result.corrected_words[0], f"{prefix}ngày{suffix}")
        self.assertEqual(result.corrected_words[1], "xưa")

    @settings(max_examples=50, deadline=None)
    @given(
        words=st.lists(_VI_WORDS, min_size=2, max_size=12),
        bad_split_idx=st.integers(min_value=0, max_value=11),
    )
    def test_validator_never_accepts_token_splitting_or_count_drift(
        self, words: list[str], bad_split_idx: int
    ):
        idx = bad_split_idx % len(words)
        chunk = chunk_ocr_text(" ".join(words), ChunkingConfig(max_words=32)).chunks[0]

        split_words = list(words)
        split_words[idx] = f"{words[idx]} thêm"
        with self.assertRaises(OcrProviderError):
            validate_chunk_result(
                {
                    "chunk_id": chunk.chunk_id,
                    "corrected_words": split_words,
                    "uncertain_word_indices": [],
                },
                chunk=chunk,
                provider="hypothesis",
            )

        short_words = words[:-1]
        with self.assertRaises(OcrProviderError):
            validate_chunk_result(
                {
                    "chunk_id": chunk.chunk_id,
                    "corrected_words": short_words,
                    "uncertain_word_indices": [],
                },
                chunk=chunk,
                provider="hypothesis",
            )

    @settings(max_examples=60, deadline=None)
    @given(
        text=st.lists(
            st.sampled_from(
                list("aăâbcdđeêghiklmnoôơpqrstuưvxyáàảãạéèẻẽẹíìỉĩịóòỏõọúùủũụ \n")
                + ["e\u0301", "a\u0302\u0323"]
            ),
            min_size=10,
            max_size=800,
        ).map("".join),
        target_chars=st.integers(min_value=40, max_value=300),
    )
    def test_safety_chunks_cover_every_character_and_never_split_combining_marks(
        self, text: str, target_chars: int
    ):
        overlap = max(5, target_chars // 8)
        chunks = safety_chunks(text, target_chars=target_chars, overlap_chars=overlap)
        self.assertGreaterEqual(len(chunks), 1)
        self.assertEqual(chunks[0][0], 0)
        last_start, last_chunk = chunks[-1]
        self.assertEqual(last_start + len(last_chunk), len(text))
        for prev, curr in zip(chunks, chunks[1:]):
            prev_end = prev[0] + len(prev[1])
            self.assertLessEqual(curr[0], prev_end)
            self.assertGreater(curr[0], prev[0])
        for start, chunk in chunks:
            self.assertEqual(text[start : start + len(chunk)], chunk)
            if start > 0 and start < len(text):
                self.assertEqual(unicodedata.combining(text[start]), 0)
            end = start + len(chunk)
            if end < len(text):
                self.assertEqual(unicodedata.combining(text[end]), 0)

    @settings(max_examples=60, deadline=None)
    @given(
        lines=st.lists(
            st.text(
                alphabet="abcdeêghiklmnôơpqrstuưvxyáàảãạ ",
                min_size=1,
                max_size=40,
            ),
            min_size=1,
            max_size=6,
        )
    )
    def test_content_hash_invariant_across_nfc_nfd_and_crlf_lf(self, lines: list[str]):
        lf_nfc = unicodedata.normalize("NFC", "\n".join(lines))
        crlf_nfd = unicodedata.normalize("NFD", "\r\n".join(lines))
        self.assertEqual(content_hash(lf_nfc), content_hash(crlf_nfd))

    @settings(max_examples=60, deadline=None)
    @given(
        status=st.sampled_from([
            "UNASSESSED",
            "INSUFFICIENT_EVIDENCE",
            "CONCERN_FLAGGED",
            "RIGHTS_REVIEWED",
        ]),
        source=st.one_of(st.none(), st.just(""), st.just("Thư viện mở")),
        basis=st.one_of(st.none(), st.just(""), st.just("OPEN_LICENSE")),
        evidence=st.one_of(st.none(), st.just(""), st.just("https://example.org/ref")),
        fp_matches=st.booleans(),
    )
    def test_rights_evaluation_invariant_never_marks_valid_without_complete_fresh_evidence(
        self,
        status: str,
        source: str | None,
        basis: str | None,
        evidence: str | None,
        fp_matches: bool,
    ):
        row = SimpleNamespace(
            Status=status,
            SourceDescription=source,
            UsageBasis=basis,
            EvidenceUrlOrRef=evidence,
            ContentFingerprint="a" * 64,
        )
        current_fp = "a" * 64 if fp_matches else "b" * 64
        effective, is_stale, is_valid = BookContentQualityService._evaluate_rights_status(
            row, current_fp
        )
        expected_valid = bool(
            status == "RIGHTS_REVIEWED"
            and source
            and basis
            and evidence
            and fp_matches
        )
        self.assertEqual(is_valid, expected_valid)
        if is_valid:
            self.assertEqual(effective, "RIGHTS_REVIEWED")
            self.assertFalse(is_stale)


if __name__ == "__main__":
    unittest.main()
