"""Private template generator must never pre-fill OCR outputs or truth."""
from __future__ import annotations

import contextlib
import io
import json
import tempfile
import unittest
from pathlib import Path

from scripts import ocr_bbox_annotation_template


class AnnotationTemplateTests(unittest.TestCase):
    def test_unlabeled_only_and_no_overwrite(self):
        with tempfile.TemporaryDirectory() as dirname:
            root = Path(dirname)
            (root / "page.png").write_bytes(b"test image")
            manifest = root / "pages.jsonl"
            manifest.write_text(
                json.dumps(
                    {"image": "page.png", "ground_truth": "Nội dung riêng tư"},
                    ensure_ascii=False,
                ) + "\n", encoding="utf-8",
            )
            output = root / "labels-skeleton.jsonl"
            stdout = io.StringIO()
            with contextlib.redirect_stdout(stdout):
                code = ocr_bbox_annotation_template.main([
                    str(manifest), "--output", str(output)
                ])
            self.assertEqual(code, 0)
            rows = [json.loads(line) for line in output.read_text(encoding="utf-8").splitlines()]
            self.assertEqual(len(rows), 1)
            self.assertEqual(rows[0]["image"], "page.png")
            self.assertEqual(rows[0]["words"], [])
            self.assertEqual(rows[0]["annotation_source"], "unverified")
            self.assertFalse(rows[0]["reviewer_confirmed"])
            self.assertNotIn("Nội dung riêng tư", output.read_text(encoding="utf-8"))
            self.assertNotIn(str(root), stdout.getvalue())
            with contextlib.redirect_stderr(io.StringIO()):
                with self.assertRaises(SystemExit) as caught:
                    ocr_bbox_annotation_template.main([
                        str(manifest), "--output", str(output)
                    ])
            self.assertEqual(caught.exception.code, 2)


if __name__ == "__main__":
    unittest.main()
