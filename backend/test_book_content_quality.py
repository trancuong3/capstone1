"""Pure unit tests for deterministic book-quality and local Ollama evidence validation.

These tests do not need PostgreSQL, Supabase, or a running Ollama server.
"""
import json
import os
import unittest

os.environ.setdefault(
    "DATABASE_URL",
    "postgresql+asyncpg://test:test@127.0.0.1:1/test",
)
os.environ.setdefault("SUPABASE_URL", "https://example.supabase.co")
os.environ.setdefault("SUPABASE_KEY", "isolated-test-key")

from pydantic import ValidationError

from app.services.admin_ocr_local import LocalCorrectionError
from app.services.book_quality_analyzer import (
    analyse_verified_text,
    content_fingerprint,
)
from app.services.book_quality_ollama import (
    OllamaTextResponse,
    _decode_model_response,
    _text_chunks,
    _unique_excerpt_position,
)


class DeterministicBookQualityTests(unittest.TestCase):
    def test_blank_verified_text_is_reported_with_explicit_evidence(self):
        findings = analyse_verified_text("  \n")
        self.assertEqual(len(findings), 1)
        self.assertEqual(findings[0].issue_type, "EMPTY_VERIFIED_TEXT")
        self.assertEqual(findings[0].severity, "HIGH")
        self.assertEqual(findings[0].original_excerpt, "")

    def test_replacement_character_finding_points_to_exact_source_slice(self):
        source = "Ngày xưa, bé đi học \ufffd rồi về nhà."
        findings = analyse_verified_text(source)
        finding = next(
            item for item in findings
            if item.issue_type == "REPLACEMENT_CHARACTER"
        )
        self.assertIn("\ufffd", finding.original_excerpt)
        self.assertEqual(
            source[finding.excerpt_start:finding.excerpt_end],
            finding.original_excerpt,
        )

    def test_repeated_paragraph_is_only_a_low_severity_signal(self):
        paragraph = "Đây là một đoạn văn dài được lặp lại để Admin đối chiếu."
        source = f"{paragraph}\n{paragraph}"
        findings = analyse_verified_text(source)
        finding = next(
            item for item in findings
            if item.issue_type == "REPEATED_PARAGRAPH"
        )
        self.assertEqual(finding.severity, "LOW")
        self.assertEqual(finding.original_excerpt, paragraph)
        self.assertEqual(
            source[finding.excerpt_start:finding.excerpt_end],
            finding.original_excerpt,
        )

    def test_repeated_word_is_flagged_without_rewriting_source(self):
        source = "Bé bé bé chạy về nhà."
        findings = analyse_verified_text(source)
        finding = next(
            item for item in findings if item.issue_type == "REPEATED_WORD"
        )
        self.assertEqual(finding.original_excerpt, "Bé bé bé")
        self.assertEqual(
            source[finding.excerpt_start:finding.excerpt_end],
            finding.original_excerpt,
        )

    def test_fingerprint_normalizes_whitespace_and_case(self):
        self.assertEqual(
            content_fingerprint("  Ngày Xưa\nBé ngoan "),
            content_fingerprint("ngày xưa bé NGOAN"),
        )


class OllamaEvidenceValidationTests(unittest.TestCase):
    def test_chunks_cover_source_and_preserve_exact_unicode_offsets(self):
        source = ("Ngày xưa, có một chú mèo nhỏ.\n" * 100) + "Kết thúc."
        ranges = _text_chunks(source, maximum=64, overlap=10)
        self.assertGreater(len(ranges), 1)
        self.assertEqual(ranges[0][0], 0)
        self.assertEqual(ranges[-1][1], len(source))
        for start, end in ranges:
            chunk = source[start:end]
            self.assertTrue(chunk)
            self.assertLessEqual(len(chunk.encode("utf-8")), 3072)
        self.assertTrue(
            any(source[start:end].startswith("Kết") for start, end in ranges)
        )

    def test_chunks_are_bounded_for_four_byte_unicode(self):
        source = "😀" * 4000
        ranges = _text_chunks(source, maximum=700, overlap=40)
        self.assertGreater(len(ranges), 1)
        for start, end in ranges:
            self.assertLessEqual(len(source[start:end].encode("utf-8")), 3072)

    def test_model_output_requires_findings_and_rejects_unknown_fields(self):
        with self.assertRaises(ValidationError):
            OllamaTextResponse.model_validate({})
        with self.assertRaises(ValidationError):
            OllamaTextResponse.model_validate(
                {"findings": [], "rewrite": "untrusted"}
            )

    def test_valid_ollama_json_is_decoded_as_structured_evidence(self):
        content = json.dumps(
            {
                "findings": [
                    {
                        "excerpt": "trời mua",
                        "issue_type": "SPELLING_SUSPECTED",
                        "severity": "MEDIUM",
                        "explanation": "Có thể thiếu dấu trong từ cuối.",
                        "suggested_correction": "trời mưa",
                        "confidence": 0.82,
                    }
                ]
            },
            ensure_ascii=False,
        )
        parsed = _decode_model_response(
            {"message": {"content": content}}
        )
        self.assertEqual(parsed.findings[0].excerpt, "trời mua")
        self.assertEqual(parsed.findings[0].confidence, 0.82)

    def test_malformed_or_non_object_response_fails_closed(self):
        for payload in (
            {"message": {"content": "not-json"}},
            {"message": {"content": json.dumps({"rewrite": "fabricated"})}},
            {"message": {"content": json.dumps({"findings": [{"excerpt": "a"}]})}},
            {"message": {"content": json.dumps({"findings": [], "extra": True})}},
        ):
            with self.subTest(payload=payload):
                with self.assertRaises(LocalCorrectionError) as caught:
                    _decode_model_response(payload)
                self.assertEqual(caught.exception.status_code, 502)

    def test_duplicate_excerpt_is_rejected_instead_of_using_first_match(self):
        source = "Bé thích mèo. Mèo thích bé."
        self.assertIsNone(_unique_excerpt_position(source, "thích"))
        self.assertIsNone(_unique_excerpt_position(source, "không có"))

    def test_unique_excerpt_maps_to_the_exact_source_offset(self):
        source = "Bé thích mèo. Mèo thương bé."
        position = _unique_excerpt_position(source, "thương")
        self.assertEqual(position, source.index("thương"))


if __name__ == "__main__":
    unittest.main()
