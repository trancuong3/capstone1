"""Geometry regressions use controlled glyph masks, never live OCR/providers."""
from copy import deepcopy
import unittest
from unittest.mock import patch

import cv2
import numpy as np

from app.services.ocr_engine import _extract_text_and_boxes_tesseract, _map_curved_word_boxes, _segment_words_by_ink


class InkWordSegmentationTests(unittest.TestCase):
    words = ["Bé", "mèo", "đọc"]
    spans = [(20, 88), (135, 192), (241, 366)]

    def line_image(self, light_text=False):
        background, foreground = (48, 245) if light_text else (255, 30)
        image = np.full((68, 390, 3), background, dtype=np.uint8)
        for left, right in self.spans:
            # Independent visible glyph groups, with marks above the baseline.
            cv2.rectangle(image, (left, 24), (right - 1, 48), (foreground,) * 3, -1)
            cv2.rectangle(image, (left + 12, 12), (left + 18, 18), (foreground,) * 3, -1)
        return image

    def test_light_on_dark_boxes_cover_the_actual_words_instead_of_the_background(self):
        for polarity in (False, True):
            with self.subTest(light_text=polarity):
                boxes = _segment_words_by_ink(self.line_image(polarity), self.words)
                self.assertEqual(len(boxes), len(self.words))
                for box, (left, right) in zip(boxes, self.spans):
                    start, end = box[0] * 390, box[2] * 390
                    overlap = max(0, min(end, right) - max(start, left))
                    union = max(end, right) - min(start, left)
                    self.assertGreater(overlap / union, 0.85, (polarity, box, left, right))
                    self.assertLessEqual(box[1] * 68, 12)
                    self.assertGreaterEqual(box[3] * 68, 49)

    def test_blank_or_forcibly_split_regions_are_not_declared_reliable(self):
        for image, words in ((np.full((68, 390, 3), 255, dtype=np.uint8), self.words),
                             (self.line_image(), self.words + ["thêm"])):
            geometry = {}
            boxes = _segment_words_by_ink(image, words, geometry=geometry)
            self.assertEqual(len(boxes), len(words))
            self.assertIs(geometry["reliable"], False)

    def test_unforced_normalized_word_regions_report_reliable_geometry(self):
        geometry = {}
        original = self.line_image(light_text=True)
        before = original.copy()
        _segment_words_by_ink(original, self.words, geometry=geometry)
        self.assertIs(geometry["reliable"], True)
        np.testing.assert_array_equal(original, before)

    def test_measured_spans_map_back_to_source_coordinates_and_content_bound_evidence(self):
        from app.services.word_box_geometry import build_geometry_evidence, has_verified_geometry
        geometry = {}
        item = {"rect_img": self.line_image(light_text=True),
                "quad": np.float32([[100, 50], [490, 50], [490, 118], [100, 118]])}
        boxes = _map_curved_word_boxes(self.words, item, 800, 600, geometry=geometry)
        for box, (left, right) in zip(boxes, self.spans):
            self.assertLessEqual(abs(box[0] * 800 - (100 + left)), 4)
            self.assertLessEqual(abs((box[0] + box[2]) * 800 - (100 + right)), 4)
        words = [dict(word_index=i, line_index=0, text=text, bbox=box)
                 for i, (text, box) in enumerate(zip(self.words, boxes))]
        evidence = build_geometry_evidence(words, 800, 600, reliable=geometry["reliable"])
        self.assertTrue(has_verified_geometry(evidence, words, 800, 600))

    def test_tesseract_fallback_normalizes_dark_background_and_preserves_measured_coordinates(self):
        from app.services.word_box_geometry import has_verified_geometry
        image = self.line_image(light_text=True)
        success, encoded = cv2.imencode(".png", image)
        self.assertTrue(success)
        measured = dict(text=self.words, left=[20, 135, 241], top=[12] * 3,
                        width=[68, 57, 125], height=[37] * 3, conf=[90] * 3, line_num=[1] * 3)
        def recognize(binary, **_kwargs):
            self.assertGreater(float(np.mean(binary == 255)), 0.5)
            return measured
        with patch("app.services.ocr_engine._resolve_tesseract_command", return_value=None), \
             patch("app.services.ocr_engine.pytesseract.image_to_data", side_effect=recognize):
            result = _extract_text_and_boxes_tesseract(encoded.tobytes())
        self.assertEqual([word["text"] for word in result["words"]], self.words)
        self.assertEqual(result["words"][0]["bbox"], [20/390, 12/68, 68/390, 37/68])
        self.assertTrue(has_verified_geometry(result["metadata"]["word_box_geometry"], result["words"], 390, 68))


class WordGeometryEvidenceTests(unittest.TestCase):
    def words(self):
        return [dict(word_index=0, line_index=0, text="đỏ", bbox=[0.1, 0.2, 0.3, 0.1])]

    def test_evidence_is_bound_to_text_order_boxes_and_source_dimensions(self):
        from app.services.word_box_geometry import build_geometry_evidence, has_verified_geometry
        words = self.words()
        evidence = build_geometry_evidence(words, 600, 800, reliable=True)
        self.assertTrue(has_verified_geometry(evidence, words, 600, 800))
        for changes in (dict(text="do"), dict(word_index=1), dict(line_index=1),
                        dict(bbox=[0.2, 0.2, 0.3, 0.1])):
            changed = [{**words[0], **changes}]
            self.assertFalse(has_verified_geometry(evidence, changed, 600, 800))
        self.assertFalse(has_verified_geometry(evidence, words, 800, 600))
        self.assertEqual(words, self.words())

    def test_missing_malformed_unreliable_or_unknown_version_is_not_proof(self):
        from app.services.word_box_geometry import build_geometry_evidence, has_verified_geometry
        words = self.words()
        good = build_geometry_evidence(words, 600, 800, reliable=True)
        for value in (None, {}, [], {**good, "reliable": False}, {**good, "reliable": "true"},
                      {**good, "version": "future"}, {**good, "fingerprint": None}):
            with self.subTest(evidence=value):
                self.assertFalse(has_verified_geometry(value, words, 600, 800))

    def test_invalid_or_overlapping_word_boxes_cannot_obtain_geometry_proof(self):
        from app.services.word_box_geometry import build_geometry_evidence, has_verified_geometry
        for box in ([0, 0, 0, 0], [float("nan"), 0, 0.1, 0.1], [0.9, 0, 0.2, 0.1]):
            words = [{**self.words()[0], "bbox": box}]
            evidence = build_geometry_evidence(words, 600, 800, reliable=True)
            self.assertFalse(has_verified_geometry(evidence, words, 600, 800))
        words = self.words()
        words.append({**deepcopy(words[0]), "word_index": 1, "text": "đọc"})
        evidence = build_geometry_evidence(words, 600, 800, reliable=True)
        self.assertFalse(has_verified_geometry(evidence, words, 600, 800))
