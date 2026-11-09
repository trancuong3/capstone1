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
from app.services.ocr_evidence import HYBRID_OCR_EVIDENCE_CONTRACT


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
        self.assertEqual(result.ocr_review_status, "needs_review")
        self.assertEqual(result.review_color_group, "yellow")
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

    async def test_revision_detail_uses_persisted_review_evidence_without_promoting_legacy_suspect(self):
        service = AdminOcrService(MagicMock())
        service.repo.words = AsyncMock(return_value=[word(0, "ma", 0.96)])
        detail = await service.revision_detail(
            page(),
            revision(
                metadata={
                    "ocr_score_contract": OCR_SCORE_CONTRACT,
                    "word_review_statuses": ["suspect"],
                }
            ),
        )

        self.assertEqual(detail.words[0].ocr_review_status, "needs_review")
        self.assertEqual(detail.words[0].review_color_group, "yellow")
        self.assertEqual(detail.words[0].ocr_confidence, 0.96)
        self.assertEqual(detail.words[0].ocr_score_source, OCR_SCORE_CONTRACT)

    async def test_stale_verified_word_status_does_not_greenlight_unverified_revision(self):
        service = AdminOcrService(MagicMock())
        service.repo.words = AsyncMock(return_value=[word(0, "ma", 0.99)])
        detail = await service.revision_detail(
            page(),
            revision(
                status="NEEDS_REVIEW",
                metadata={"word_review_statuses": ["verified"]},
            ),
        )

        self.assertEqual(detail.words[0].ocr_review_status, "needs_review")
        self.assertEqual(detail.words[0].review_color_group, "yellow")

    async def test_revision_detail_exposes_sanitized_legacy_and_hybrid_engine_evidence(self):
        service = AdminOcrService(MagicMock())
        service.repo.words = AsyncMock(return_value=[word(0, "on", 0.97)])
        detail = await service.revision_detail(
            page(),
            revision(
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
            ),
        )

        self.assertIsNone(detail.words[0].ocr_confidence)
        self.assertEqual(detail.words[0].ocr_review_status, "engine_agreement")
        self.assertEqual(detail.words[0].ocr_evidence.engine_outputs["paddleocr"], "on")
        self.assertIsNone(detail.words[0].ocr_evidence.calibrated_word_accuracy)
        self.assertEqual(detail.ocr_metadata["line_evidence"][0]["paddle_line_confidence"], 0.81)
        self.assertNotIn("source_image_path", detail.ocr_metadata)

    async def test_revision_detail_recovers_word_evidence_from_legacy_line_metadata(self):
        service = AdminOcrService(MagicMock())
        service.repo.words = AsyncMock(return_value=[word(0, "về", None)])
        detail = await service.revision_detail(
            page(),
            revision(
                metadata={
                    "word_review_statuses": ["needs_review"],
                    "word_evidence_v2": [None],
                    "word_evidence_v2_authoritative": True,
                    "line_evidence": [
                        {
                            "line_index": 0,
                            "paddle_output": "vé",
                            "vietocr_output": "về",
                            "vietocr_output_used": True,
                            "selection_reason": "vietocr_nonempty_nonrepetitive_provisional",
                            "alignment_operations": [
                                {
                                    "operation": "substitute",
                                    "paddle_token": "vé",
                                    "vietocr_token": "về",
                                }
                            ],
                        }
                    ],
                }
            ),
        )

        evidence = detail.words[0].ocr_evidence
        self.assertIsNotNone(evidence)
        self.assertEqual(evidence.engine_outputs["paddleocr"], "vé")
        self.assertEqual(evidence.engine_outputs["vietocr"], "về")
        self.assertEqual(evidence.source_text, "về")
        self.assertEqual(evidence.selected_engine, "vietocr")
        self.assertEqual(evidence.alignment, "substitute")
        self.assertIsNone(evidence.engine_agreement_score)
        self.assertIsNone(evidence.calibrated_word_accuracy)
        self.assertEqual(detail.words[0].ocr_review_status, "needs_review")

    async def test_revision_detail_merges_partial_v2_evidence_with_safe_line_candidates(self):
        service = AdminOcrService(MagicMock())
        service.repo.words = AsyncMock(return_value=[word(0, "về", None)])
        detail = await service.revision_detail(
            page(),
            revision(metadata={
                "word_review_statuses": ["needs_review"],
                "word_evidence_v2": [{
                    "contract": "hybrid_ocr_evidence_v4",
                    "engine_outputs": {"paddleocr": None, "vietocr": "về"},
                    "alignment": "not_computed",
                    "paddle_token_index": -1,
                    "vietocr_token_index": 0,
                    "selected_engine": "vietocr",
                }],
                "line_evidence": [{
                    "line_index": 0,
                    "paddle_output": "vé",
                    "vietocr_output": "về",
                    "vietocr_output_used": True,
                    "engine_statuses": {
                        "paddleocr": "success",
                        "vietocr": "success",
                        "tesseract": "not_run",
                    },
                    "alignment_operations": [{
                        "operation": "substitute",
                        "selected_token_index": 0,
                        "paddle_token_index": -1,
                        "vietocr_token_index": 0,
                        "paddle_token": "vé",
                        "vietocr_token": "về",
                    }],
                }],
            }),
        )

        evidence = detail.words[0].ocr_evidence
        self.assertIsNotNone(evidence)
        self.assertEqual(evidence.engine_outputs["paddleocr"], "vé")
        self.assertEqual(evidence.engine_outputs["vietocr"], "về")
        self.assertEqual(evidence.alignment, "substitute")
        self.assertEqual(evidence.vietocr_token_index, 0)
        # Invalid source indexes are sanitized, not allowed to invalidate all
        # candidate evidence at Pydantic or frontend Zod parsing.
        self.assertIsNone(evidence.paddle_token_index)
        self.assertEqual(detail.words[0].review_color_group, "yellow")

    async def test_revision_detail_preserves_suspect_only_when_word_candidates_disagree(self):
        service = AdminOcrService(MagicMock())
        service.repo.words = AsyncMock(return_value=[word(0, "bà", None)])
        detail = await service.revision_detail(
            page(),
            revision(metadata={
                "word_review_statuses": ["suspect"],
                "word_evidence_v2": [{
                    "contract": "hybrid_ocr_evidence_v4",
                    "engine_outputs": {"paddleocr": "ba", "vietocr": "bà"},
                    "alignment": "substitute",
                }],
            }),
        )

        self.assertEqual(detail.words[0].ocr_review_status, "engine_disagreement")
        self.assertEqual(detail.words[0].review_color_group, "yellow")
        self.assertEqual(detail.words[0].ocr_evidence.engine_outputs["paddleocr"], "ba")
        self.assertEqual(detail.words[0].ocr_evidence.engine_outputs["vietocr"], "bà")

    async def test_admin_verification_is_the_only_green_state_for_legacy_words(self):
        service = AdminOcrService(MagicMock())
        service.repo.words = AsyncMock(return_value=[word(0, "ma", 0.99)])
        detail = await service.revision_detail(
            page(), revision(status="VERIFIED", metadata={"engine": "unknown"})
        )

        self.assertEqual(detail.words[0].ocr_review_status, "verified")
        self.assertIsNone(detail.words[0].ocr_confidence)

    async def test_client_cannot_rewrite_scores_but_keeps_original_engine_evidence(self):
        revision_row = revision(
            metadata={
                "ocr_score_contract": OCR_SCORE_CONTRACT,
                "word_review_statuses": ["suspect", "suspect"],
                "word_evidence_v2": [
                    {"contract": "dual_engine_agreement_v2", "engine_outputs": {}, "alignment": "match"},
                    {
                        "contract": "hybrid_ocr_evidence_v4",
                        "engine_outputs": {"paddleocr": "ba", "vietocr": "bà"},
                        "alignment": "substitute",
                    },
                ],
            }
        )
        existing = [word(0, "ma", 0.94), word(1, "ba", 0.81)]
        submitted = [
            {
                "word_index": 0, "line_index": 0, "text": "má",
                "bbox": existing[0].BoundingBox, "ocr_confidence": 1.0,
            },
            {
                "word_index": 1, "line_index": 0, "text": "ba",
                "bbox": existing[1].BoundingBox, "ocr_confidence": 0.01,
            },
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
        edited_evidence = revision_row.ProcessingMeta["word_evidence_v2"][0]
        self.assertIsNotNone(edited_evidence)
        self.assertEqual(edited_evidence["source_text"], "ma")
        self.assertEqual(edited_evidence["alignment"], "match")
        self.assertEqual(
            revision_row.ProcessingMeta["word_evidence_v2"][1]["alignment"],
            "substitute",
        )
        self.assertEqual(
            revision_row.ProcessingMeta["word_evidence_v2"][1]["engine_outputs"],
            {"paddleocr": "ba", "vietocr": "bà", "tesseract": None},
        )

    async def test_invalid_stored_scores_are_removed(self):
        self.assertIsNone(AdminOcrService._normalize_confidence(float("nan")))
        self.assertIsNone(AdminOcrService._normalize_confidence(float("inf")))
        self.assertIsNone(AdminOcrService._normalize_confidence(True))
        self.assertIsNone(AdminOcrService._normalize_confidence("bad score"))

    def test_hybrid_crop_evidence_is_preserved_as_original_provenance_after_edit(self):
        source_evidence = {
            "contract": "hybrid_ocr_evidence_v3",
            "engine_outputs": {"paddleocr": "vé", "vietocr": "về"},
            "alignment": "substitute",
            "engine_agreement_score": 0.5,
            "calibrated_word_accuracy": None,
            "selected_engine": "vietocr",
            "source_text": "vé",
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
            [{
                "word_index": 0, "line_index": 0, "text": "vé",
                "bbox": word(0, "vé", None).BoundingBox,
            }],
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
            [{
                "word_index": 0, "line_index": 0, "text": "về",
                "bbox": word(0, "vé", None).BoundingBox,
            }],
            [word(0, "vé", None)],
        )
        edited_evidence = changed_revision.ProcessingMeta["word_evidence_v2"][0]
        self.assertIsNotNone(edited_evidence)
        self.assertEqual(edited_evidence["source_text"], "vé")
        self.assertEqual(
            edited_evidence["crop_evidence"]["vietocr_crop_recognition_score"],
            0.73,
        )
        self.assertEqual(
            changed_revision.ProcessingMeta["word_review_statuses"][0],
            "needs_review",
        )


    def test_bbox_identity_keeps_evidence_attached_after_inserting_at_line_start(self):
        old_rows = [word(0, "ma", 0.94), word(1, "ba", 0.81)]
        first_evidence = {
            "contract": "dual_engine_agreement_v2",
            "engine_outputs": {"paddleocr": "ma", "vietocr": "ma"},
            "alignment": "match",
            "source_text": "ma",
            "review_reason": "Engine agreement only; not verified.",
        }
        second_evidence = {
            "contract": "dual_engine_agreement_v2",
            "engine_outputs": {"paddleocr": "ba", "vietocr": "ba"},
            "alignment": "match",
            "source_text": "ba",
            "review_reason": "Engine agreement only; not verified.",
        }
        revision_row = revision(metadata={
            "ocr_score_contract": OCR_SCORE_CONTRACT,
            "word_review_statuses": ["engine_agreement", "engine_disagreement"],
            "word_score_sources": [OCR_SCORE_CONTRACT, OCR_SCORE_CONTRACT],
            "word_evidence_v2": [first_evidence, second_evidence],
        })
        inserted_bbox = [0.02, 0.1, 0.06, 0.05]
        submitted = [
            {
                "word_index": 0, "line_index": 0, "text": "mới",
                "bbox": inserted_bbox, "ocr_confidence": 0.99,
            },
            {
                "word_index": 1, "line_index": 0, "text": "ma",
                "bbox": old_rows[0].BoundingBox,
            },
            {
                "word_index": 2, "line_index": 0, "text": "ba",
                "bbox": old_rows[1].BoundingBox,
            },
        ]

        AdminOcrService._preserve_trusted_word_scores(
            revision_row, submitted, old_rows
        )
        AdminOcrService._set_word_review_statuses(
            revision_row, submitted, old_rows
        )

        self.assertEqual([item["ocr_confidence"] for item in submitted], [None, 0.94, 0.81])
        self.assertEqual(
            revision_row.ProcessingMeta["word_review_statuses"],
            ["needs_review", "engine_agreement", "engine_disagreement"],
        )
        evidence = revision_row.ProcessingMeta["word_evidence_v2"]
        self.assertIsNone(evidence[0])
        self.assertEqual(evidence[1]["source_text"], "ma")
        self.assertEqual(evidence[2]["source_text"], "ba")

    def test_bbox_identity_keeps_remaining_candidate_after_deleting_first_word(self):
        old_rows = [word(0, "ma", 0.94), word(1, "ba", 0.81)]
        evidence_items = [
            {
                "contract": "dual_engine_agreement_v2",
                "engine_outputs": {"paddleocr": "ma", "vietocr": "ma"},
                "alignment": "match",
                "source_text": "ma",
                "review_reason": "Both engines agreed.",
            },
            {
                "contract": "dual_engine_agreement_v2",
                "engine_outputs": {"paddleocr": "ba", "vietocr": "ba"},
                "alignment": "match",
                "source_text": "ba",
                "review_reason": "Both engines agreed.",
            },
        ]
        revision_row = revision(metadata={
            "word_review_statuses": ["engine_agreement", "engine_disagreement"],
            "word_score_sources": [None, None],
            "word_evidence_v2": evidence_items,
        })
        remaining = [{
            "word_index": 0,
            "line_index": 0,
            "text": "ba",
            "bbox": old_rows[1].BoundingBox,
        }]
        AdminOcrService._set_word_review_statuses(
            revision_row, remaining, old_rows
        )
        self.assertEqual(
            revision_row.ProcessingMeta["word_review_statuses"],
            ["engine_disagreement"],
        )
        self.assertEqual(
            revision_row.ProcessingMeta["word_evidence_v2"][0]["source_text"],
            "ba",
        )

    def test_word_color_classification_uses_consensus_and_trusted_reference_evidence(self):
        classify = AdminOcrService._classify_word_color_group
        safe_agreement = {
            "contract": "hybrid_ocr_evidence_v4",
            "engine_outputs": {
                "paddleocr": "Chuyện",
                "vietocr": "Chuyện",
                "tesseract": None,
            },
            "engine_statuses": {
                "paddleocr": "success",
                "vietocr": "success",
                "tesseract": "not_run",
            },
            "paddle_token_index": 3,
            "vietocr_token_index": 2,
            "source_text": "Chuyện",
            "alignment": "match",
            "selected_engine": "vietocr",
            "selection_reason": "vietocr_nonempty_nonrepetitive_provisional",
            "bbox_quality": "valid",
            "crop_quality": "usable",
            "crop_evidence": {
                "status": "not_needed",
                "score_semantics": "raw_recognition_output_not_probability",
            },
            "engine_agreement_score": 0.83,
            "calibrated_word_accuracy": None,
            "reference_text": None,
            "verification_source": None,
        }

        self.assertEqual(classify("engine_agreement", safe_agreement, "Chuyện"), "green")
        self.assertEqual(classify("engine_disagreement", safe_agreement, "Chuyện"), "green")
        self.assertEqual(
            classify("needs_review", safe_agreement, "Chuye\u0323\u0302n"), "green"
        )
        self.assertEqual(classify("needs_review", None, "Chuyện"), "yellow")
        self.assertEqual(classify("engine_disagreement", None, "Chuyện"), "yellow")
        self.assertEqual(classify("needs_review", safe_agreement, "Chuyén"), "yellow")
        self.assertEqual(
            classify(
                "needs_review",
                {
                    **safe_agreement,
                    "engine_outputs": {
                        "paddleocr": "Chuyén",
                        "vietocr": "Chuyện",
                        "tesseract": None,
                    },
                    "alignment": "substitute",
                    "crop_evidence": {
                        "status": "completed",
                        "paddleocr_candidate": "Chuyen",
                        "vietocr_candidate": "Chuyện",
                    },
                },
                "Chuyện",
            ),
            "yellow",
        )
        self.assertEqual(
            classify(
                "needs_review",
                {
                    **safe_agreement,
                    "engine_outputs": {
                        "paddleocr": "lui",
                        "vietocr": "hui",
                        "tesseract": None,
                    },
                    "source_text": "hui",
                    "alignment": "substitute",
                    "paddle_crop_recognition_score": 0.99,
                    "vietocr_crop_recognition_score": 0.99,
                },
                "hui",
            ),
            "yellow",
        )
        self.assertEqual(
            classify(
                "needs_review",
                {
                    **safe_agreement,
                    "engine_statuses": {
                        "paddleocr": "success",
                        "vietocr": "error",
                        "tesseract": "not_run",
                    },
                },
                "Chuyện",
            ),
            "yellow",
        )
        self.assertEqual(
            classify("needs_review", {**safe_agreement, "bbox_quality": "rejected"}, "Chuyện"),
            "yellow",
        )
        self.assertEqual(
            classify("needs_review", {**safe_agreement, "crop_quality": "weak"}, "Chuyện"),
            "yellow",
        )
        self.assertEqual(
            classify(
                "needs_review",
                {
                    **safe_agreement,
                    "crop_evidence": {
                        "status": "completed",
                        "paddleocr_candidate": "Chuyen",
                        "vietocr_candidate": "Chuyện",
                    },
                },
                "Chuyện",
            ),
            "yellow",
        )
        self.assertEqual(classify("needs_review", safe_agreement, "Chuyện đã sửa"), "yellow")

        verified_mismatch = {
            **safe_agreement,
            "source_text": "hui",
            "reference_text": "lui",
            "verification_source": "verified_revision",
            "reference_alignment": "substitute",
        }
        verified_match = {
            **safe_agreement,
            "source_text": "lui",
            "reference_text": "lui",
            "verification_source": "verified_revision",
            "reference_alignment": "match",
        }
        self.assertEqual(classify("confirmed_mismatch", verified_mismatch, "hui"), "red")
        self.assertEqual(
            classify("needs_review", verified_mismatch, "hui"), "yellow"
        )
        self.assertEqual(classify("reference_match", verified_match, "lui"), "green")
        self.assertEqual(
            classify(
                "engine_agreement",
                {
                    **safe_agreement,
                    "verification_source": "verified_revision",
                    "reference_text": None,
                    "reference_alignment": "unmatched",
                },
                "Chuyện",
            ),
            "yellow",
        )
        self.assertEqual(
            classify("confirmed_mismatch", safe_agreement, "Chuyện"), "green"
        )
        self.assertEqual(classify("verified", None, "Chuyện"), "green")
        self.assertEqual(
            classify(
                "confirmed_mismatch",
                {**verified_mismatch, "reference_alignment": "unresolved"},
                "hui",
            ),
            "yellow",
        )

    def test_legacy_recovery_refuses_filtered_operation_index_shift(self):
        metadata = {
            "line_evidence": [{
                "line_index": 0,
                "paddle_output": "một hai ba",
                "vietocr_output": "một hai ba",
                "vietocr_output_used": False,
                "alignment_operations": [{
                    "operation": "match",
                    "paddle_token": "một",
                    "vietocr_token": "một",
                }, {
                    "operation": "insert",
                    "paddle_token": None,
                    "vietocr_token": "hai",
                }, {
                    "operation": "match",
                    "paddle_token": "ba",
                    "vietocr_token": "ba",
                }],
            }]
        }
        self.assertIsNone(
            AdminOcrService._line_word_evidence(
                metadata, 0, 1, ["một", "hai", "ba"]
            )
        )

    def test_legacy_recovery_refuses_to_map_evidence_after_line_edit_or_insert(self):
        metadata = {
            "line_evidence": [{
                "line_index": 0,
                "paddle_output": "ve ban",
                "vietocr_output": "về bạn",
                "vietocr_output_used": True,
                "alignment_operations": [{
                    "operation": "match",
                    "selected_token_index": 0,
                    "paddle_token_index": 0,
                    "vietocr_token_index": 0,
                    "paddle_token": "ve",
                    "vietocr_token": "về",
                }, {
                    "operation": "match",
                    "selected_token_index": 1,
                    "paddle_token_index": 1,
                    "vietocr_token_index": 1,
                    "paddle_token": "ban",
                    "vietocr_token": "bạn",
                }],
            }]
        }
        self.assertIsNone(
            AdminOcrService._line_word_evidence(
                metadata, 0, 0, ["thêm", "về", "bạn"]
            )
        )
        self.assertIsNone(
            AdminOcrService._line_word_evidence(
                metadata, 0, 1, ["về", "bạn", "mới"]
            )
        )

    def test_reconstructs_legacy_word_evidence_from_line_metadata(self):
        metadata = {
            "line_evidence": [
                {
                    "line_index": 0,
                    "paddle_output": "vé bạn",
                    "vietocr_output": "về bạn",
                    "vietocr_output_used": True,
                    "selection_reason": "vietocr_nonempty_nonrepetitive_provisional",
                    "alignment_operations": [
                        {
                            "operation": "substitute",
                            "paddle_token": "vé",
                            "vietocr_token": "về",
                        },
                        {
                            "operation": "match",
                            "paddle_token": "bạn",
                            "vietocr_token": "bạn",
                        },
                    ],
                }
            ]
        }

        first = AdminOcrService._line_word_evidence(metadata, 0, 0)
        second = AdminOcrService._line_word_evidence(metadata, 0, 1)

        self.assertEqual(first["source_text"], "về")
        self.assertEqual(first["engine_outputs"]["paddleocr"], "vé")
        self.assertEqual(first["engine_outputs"]["vietocr"], "về")
        self.assertEqual(first["selected_engine"], "vietocr")
        self.assertEqual(first["alignment"], "substitute")
        self.assertIsNone(first["engine_agreement_score"])
        self.assertIsNone(first["calibrated_word_accuracy"])
        self.assertEqual(second["source_text"], "bạn")
        self.assertEqual(second["alignment"], "match")
        self.assertIsNone(AdminOcrService._line_word_evidence(metadata, 1, 0))
        self.assertIsNone(AdminOcrService._line_word_evidence({}, 0, 0))

    def test_authoritative_null_word_evidence_is_recovered_on_draft_sync_when_line_is_unchanged(self):
        source_row = word(0, "về", None)
        revision_row = revision(metadata={
            "word_review_statuses": ["needs_review"],
            "word_evidence_v2": [None],
            "word_evidence_v2_authoritative": True,
            "line_evidence": [{
                "line_index": 0,
                "paddle_output": "vé",
                "vietocr_output": "về",
                "vietocr_output_used": True,
                "selection_reason": "vietocr_nonempty_nonrepetitive_provisional",
                "alignment_operations": [{
                    "operation": "substitute",
                    "selected_token_index": 0,
                    "paddle_token_index": 0,
                    "vietocr_token_index": 0,
                    "paddle_token": "vé",
                    "vietocr_token": "về",
                }],
            }],
        })
        submitted = [{
            "word_index": 0,
            "line_index": 0,
            "text": "về",
            "bbox": source_row.BoundingBox,
        }]

        AdminOcrService._set_word_review_statuses(
            revision_row, submitted, [source_row]
        )

        evidence = revision_row.ProcessingMeta["word_evidence_v2"][0]
        self.assertIsNotNone(evidence)
        self.assertEqual(evidence["engine_outputs"]["paddleocr"], "vé")
        self.assertEqual(evidence["engine_outputs"]["vietocr"], "về")
        self.assertEqual(evidence["alignment"], "substitute")

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
