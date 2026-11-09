"""OCR score provenance and per-word review-state safety tests."""
from __future__ import annotations

import os
import unittest
from datetime import datetime, timezone
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock
from uuid import UUID

os.environ.setdefault("DATABASE_URL", "postgresql+asyncpg://test:test@127.0.0.1:1/test")
os.environ.setdefault("SUPABASE_URL", "https://example.supabase.co")
os.environ.setdefault("SUPABASE_KEY", "isolated-test-key")

from app.services.admin_ocr_service import AdminOcrService, OCR_SCORE_CONTRACT
from app.services.book_service import AdminCatalogService


ACTOR = UUID("11111111-1111-4111-8111-111111111111")
PAGE_ID = UUID("33333333-3333-4333-8333-333333333333")
REVISION_ID = UUID("44444444-4444-4444-8444-444444444444")
CREATED_AT = datetime(2026, 11, 8, tzinfo=timezone.utc)


def revision(*, status="NEEDS_REVIEW", metadata=None):
    return SimpleNamespace(
        Id=REVISION_ID,
        PageId=PAGE_ID,
        RevisionNo="1",
        VerificationStatus=status,
        DraftText="ma ba",
        VerifiedText="ma ba" if status == "VERIFIED" else None,
        ProcessingMeta=metadata or {},
        CreatedAt=CREATED_AT,
        VerifiedAt=CREATED_AT if status == "VERIFIED" else None,
        VerifiedBy=ACTOR if status == "VERIFIED" else None,
    )


def page():
    return SimpleNamespace(Id=PAGE_ID, LifecycleStatus="ACTIVE")


def word(index, text, score):
    return SimpleNamespace(
        WordIndex=index,
        LineIndex=0,
        Text=text,
        NormalizedText=text.lower(),
        BoundingBox=[0.1 + index * 0.2, 0.1, 0.15, 0.05],
        OCRConfidence=score,
    )


class AdminOcrConfidenceTests(unittest.IsolatedAsyncioTestCase):
    async def test_only_versioned_tesseract_token_scores_are_exposed(self):
        service = AdminOcrService(MagicMock())
        service.repo.words = AsyncMock(return_value=[word(0, "ma", 0.97)])
        detail = await service.revision_detail(
            page(),
            revision(
                metadata={
                    "ocr_score_contract": OCR_SCORE_CONTRACT,
                    "word_review_statuses": ["suspect"],
                }
            ),
        )

        result = detail.words[0]
        self.assertEqual(result.ocr_confidence, 0.97)
        self.assertEqual(result.ocr_score_source, OCR_SCORE_CONTRACT)
        self.assertEqual(result.ocr_review_status, "engine_disagreement")
        self.assertNotIn("word_review_statuses", detail.ocr_metadata)
        self.assertNotIn("word_score_sources", detail.ocr_metadata)
        self.assertNotIn("ocr_score_contract", detail.ocr_metadata)

    async def test_legacy_line_scores_and_missing_statuses_are_safe(self):
        service = AdminOcrService(MagicMock())
        service.repo.words = AsyncMock(return_value=[word(0, "ma", 0.99)])
        detail = await service.revision_detail(
            page(),
            revision(metadata={"engine": "paddleocr_vietocr_dual"}),
        )

        self.assertIsNone(detail.words[0].ocr_confidence)
        self.assertIsNone(detail.words[0].ocr_score_source)
        self.assertEqual(detail.words[0].ocr_review_status, "needs_review")

    async def test_word_score_source_is_preserved_for_consensus_and_line_scores(self):
        service = AdminOcrService(MagicMock())
        service.repo.words = AsyncMock(
            return_value=[word(0, "má", 0.97), word(1, "mèo", 0.82)]
        )
        detail = await service.revision_detail(
            page(),
            revision(
                metadata={
                    "ocr_score_contract": "dual_engine_consensus_v1",
                    "word_score_sources": [
                        "dual_engine_consensus_v1",
                        "paddle_line_score_v1",
                    ],
                    "word_review_statuses": ["matched", "needs_review"],
                }
            ),
        )

        self.assertEqual(
            [word.ocr_score_source for word in detail.words],
            ["dual_engine_consensus_v1", "paddle_line_score_v1"],
        )
        self.assertEqual(
            [word.ocr_confidence for word in detail.words], [None, None]
        )
        self.assertEqual(
            [word.ocr_review_status for word in detail.words],
            ["engine_agreement", "needs_review"],
        )
        self.assertNotIn("word_score_sources", detail.ocr_metadata)

    async def test_admin_revision_read_endpoint_uses_persisted_review_evidence(self):
        service = AdminCatalogService(MagicMock())
        service.page = AsyncMock(return_value=page())
        service.repository.revision = AsyncMock(
            return_value=revision(
                metadata={
                    "ocr_score_contract": OCR_SCORE_CONTRACT,
                    "word_review_statuses": ["suspect"],
                }
            )
        )
        service.repository.words = AsyncMock(return_value=[word(0, "ma", 0.96)])

        detail = await service.revision(PAGE_ID, REVISION_ID)

        self.assertEqual(detail.words[0].ocr_review_status, "engine_disagreement")
        self.assertEqual(detail.words[0].ocr_confidence, 0.96)
        self.assertEqual(detail.words[0].ocr_score_source, OCR_SCORE_CONTRACT)

    async def test_revision_read_exposes_sanitized_engine_and_line_evidence(self):
        service = AdminCatalogService(MagicMock())
        service.page = AsyncMock(return_value=page())
        service.repository.revision = AsyncMock(
            return_value=revision(
                metadata={
                    "ocr_evidence_contract": "dual_engine_agreement_v2",
                    "word_review_statuses": ["engine_agreement"],
                    "word_score_sources": [None],
                    "word_evidence_v2": [
                        {
                            "contract": "dual_engine_agreement_v2",
                            "engine_outputs": {"paddleocr": "on", "vietocr": "on"},
                            "alignment": "match",
                            "engine_agreement_score": 1.0,
                            "calibrated_word_accuracy": None,
                            "verification_source": None,
                            "reference_text": None,
                            "review_reason": "Both engines returned the same token.",
                        }
                    ],
                    "line_evidence": [
                        {
                            "line_index": 0,
                            "paddle_output": "on",
                            "vietocr_output": "on",
                            "paddle_line_confidence": 0.81,
                            "paddle_line_score_contract": "paddle_line_score_v1",
                        }
                    ],
                    "source_image_path": "private/storage/path.jpg",
                }
            )
        )
        service.repository.words = AsyncMock(return_value=[word(0, "on", 0.97)])

        detail = await service.revision(PAGE_ID, REVISION_ID)

        self.assertIsNone(detail.words[0].ocr_confidence)
        self.assertEqual(detail.words[0].ocr_review_status, "engine_agreement")
        self.assertEqual(detail.words[0].ocr_evidence.engine_outputs["paddleocr"], "on")
        self.assertIsNone(detail.words[0].ocr_evidence.calibrated_word_accuracy)
        self.assertEqual(detail.ocr_metadata["line_evidence"][0]["paddle_line_confidence"], 0.81)
        self.assertNotIn("source_image_path", detail.ocr_metadata)

    async def test_admin_verification_is_the_only_green_state_for_legacy_words(self):
        service = AdminOcrService(MagicMock())
        service.repo.words = AsyncMock(return_value=[word(0, "ma", 0.99)])
        detail = await service.revision_detail(
            page(), revision(status="VERIFIED", metadata={"engine": "unknown"})
        )

        self.assertEqual(detail.words[0].ocr_review_status, "verified")
        self.assertIsNone(detail.words[0].ocr_confidence)

    async def test_client_cannot_rewrite_scores_and_accent_edits_clear_old_evidence(self):
        revision_row = revision(
            metadata={
                "ocr_score_contract": OCR_SCORE_CONTRACT,
                "word_review_statuses": ["suspect", "suspect"],
                "word_evidence_v2": [
                    {"contract": "dual_engine_agreement_v2", "engine_outputs": {}, "alignment": "match"},
                    {"contract": "dual_engine_agreement_v2", "engine_outputs": {}, "alignment": "match"},
                ],
            }
        )
        existing = [word(0, "ma", 0.94), word(1, "ba", 0.81)]
        submitted = [
            {"word_index": 0, "line_index": 0, "text": "má", "ocr_confidence": 1.0},
            {"word_index": 1, "line_index": 0, "text": "ba", "ocr_confidence": 0.01},
        ]

        AdminOcrService._preserve_trusted_word_scores(
            revision_row, submitted, existing
        )
        AdminOcrService._set_word_review_statuses(
            revision_row, submitted, existing
        )

        self.assertEqual(
            [item["ocr_confidence"] for item in submitted], [None, 0.81]
        )
        self.assertEqual(
            revision_row.ProcessingMeta["word_review_statuses"],
            ["needs_review", "engine_disagreement"],
        )
        self.assertEqual(
            revision_row.ProcessingMeta["word_score_sources"],
            [None, OCR_SCORE_CONTRACT],
        )
        self.assertIsNone(revision_row.ProcessingMeta["word_evidence_v2"][0])
        self.assertEqual(
            revision_row.ProcessingMeta["word_evidence_v2"][1]["alignment"],
            "match",
        )

    async def test_invalid_stored_scores_are_removed(self):
        self.assertIsNone(AdminOcrService._normalize_confidence(float("nan")))
        self.assertIsNone(AdminOcrService._normalize_confidence(float("inf")))
        self.assertIsNone(AdminOcrService._normalize_confidence(True))
        self.assertIsNone(AdminOcrService._normalize_confidence("bad score"))

    def test_hybrid_crop_evidence_is_preserved_for_unchanged_tokens_and_cleared_on_edit(self):
        source_evidence = {
            "contract": "hybrid_ocr_evidence_v3",
            "engine_outputs": {"paddleocr": "vé", "vietocr": "về"},
            "alignment": "substitute",
            "engine_agreement_score": 0.5,
            "calibrated_word_accuracy": None,
            "selected_engine": "vietocr",
            "selection_reason": "provisional_candidate",
            "bbox_quality": "valid",
            "crop_quality": "usable",
            "crop_evidence": {
                "status": "completed",
                "paddleocr_candidate": "về",
                "vietocr_candidate": "vé",
                "paddle_crop_recognition_score": 0.82,
                "vietocr_crop_recognition_score": 0.73,
                "score_semantics": "raw_recognition_output_not_probability",
            },
            "review_reason": "Two engines disagree.",
        }

        unchanged_revision = revision(metadata={
            "word_review_statuses": ["engine_disagreement"],
            "word_score_sources": [None],
            "word_evidence_v2": [source_evidence],
        })
        AdminOcrService._set_word_review_statuses(
            unchanged_revision,
            [{"word_index": 0, "line_index": 0, "text": "vé"}],
            [word(0, "vé", None)],
        )
        preserved = unchanged_revision.ProcessingMeta["word_evidence_v2"][0]
        self.assertEqual(preserved["contract"], "hybrid_ocr_evidence_v3")
        self.assertEqual(
            preserved["crop_evidence"]["vietocr_crop_recognition_score"], 0.73
        )

        changed_revision = revision(metadata={
            "word_review_statuses": ["engine_disagreement"],
            "word_score_sources": [None],
            "word_evidence_v2": [source_evidence],
        })
        AdminOcrService._set_word_review_statuses(
            changed_revision,
            [{"word_index": 0, "line_index": 0, "text": "về"}],
            [word(0, "vé", None)],
        )
        self.assertIsNone(changed_revision.ProcessingMeta["word_evidence_v2"][0])
        self.assertEqual(
            changed_revision.ProcessingMeta["word_review_statuses"][0],
            "needs_review",
        )

    def test_hybrid_crop_evidence_is_preserved_as_raw_engine_evidence(self):
        evidence = AdminOcrService._normalize_word_evidence({
            "contract": "hybrid_ocr_evidence_v3",
            "engine_outputs": {"paddleocr": "vé", "vietocr": "về"},
            "alignment": "substitute",
            "engine_agreement_score": 0.5,
            "calibrated_word_accuracy": None,
            "selected_engine": "vietocr",
            "selection_reason": "provisional_candidate",
            "bbox_quality": "valid",
            "crop_quality": "usable",
            "crop_evidence": {
                "status": "completed",
                "paddleocr_candidate": "về",
                "vietocr_candidate": "vé",
                "paddle_crop_recognition_score": 0.82,
                "vietocr_crop_recognition_score": 0.73,
                "score_semantics": "raw_recognition_output_not_probability",
                "contrast_std": 44.2,
                "ink_ratio": 0.08,
            },
            "review_reason": "Two engines disagree.",
        })
        self.assertIsNotNone(evidence)
        self.assertEqual(evidence["contract"], "hybrid_ocr_evidence_v3")
        self.assertEqual(evidence["selected_engine"], "vietocr")
        self.assertEqual(evidence["crop_evidence"]["paddleocr_candidate"], "về")
        self.assertEqual(
            evidence["crop_evidence"]["score_semantics"],
            "raw_recognition_output_not_probability",
        )
        self.assertIsNone(evidence["calibrated_word_accuracy"])



if __name__ == "__main__":
    unittest.main()
