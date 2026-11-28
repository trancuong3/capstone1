from __future__ import annotations

import importlib.util
import sys
import tempfile
import unittest
from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parents[1]
SCRIPT_PATH = REPO_ROOT / "scripts" / "verify_repository_hygiene.py"


def _load_hygiene_module():
    spec = importlib.util.spec_from_file_location("verify_repository_hygiene", SCRIPT_PATH)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"Unable to load hygiene script from {SCRIPT_PATH}")
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


hygiene = _load_hygiene_module()


class RepositoryHygieneTests(unittest.TestCase):
    def test_catches_seven_chevron_conflict_markers(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            conflict_file = root / "sample.sql"
            conflict_file.write_text(
                "<<<<<<< HEAD\nselect 1;\n=======\nselect 2;\n>>>>>>> feature/branch\n",
                encoding="utf-8",
            )
            violations = hygiene.scan_text_hygiene_violations(root, ["sample.sql"])
            self.assertEqual(len(violations), 2)
            self.assertTrue(any("sample.sql:1:" in item and "conflict marker" in item for item in violations))
            self.assertTrue(any("sample.sql:5:" in item and "conflict marker" in item for item in violations))

    def test_catches_eight_chevron_conflict_markers(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            conflict_file = root / "rollback.sql"
            conflict_file.write_text(
                "<<<<<<<< HEAD:supabase/rollbacks/a.sql\n"
                "-- old\n"
                "========\n"
                "-- new\n"
                ">>>>>>>> origin/main:supabase/rollbacks/b.sql\n"
                "begin;\ncommit;\n",
                encoding="utf-8",
            )
            violations = hygiene.scan_text_hygiene_violations(root, ["rollback.sql"])
            self.assertEqual(len(violations), 2)
            self.assertTrue(any("rollback.sql:1:" in item for item in violations))
            self.assertTrue(any("rollback.sql:5:" in item for item in violations))

    def test_catches_form_feed_control_byte_and_preserves_valid_whitespace(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            bad_doc = root / "RELEASE_GATE.md"
            bad_doc.write_bytes(
                b"# RELEASE GATE (\x0ceat/branch)\r\n\tTi\xe1\xba\xbfng Vi\xe1\xbb\x87t h\xe1\xbb\x8dc \xc4\x91\xe1\xbb\x8dc\r\n"
            )
            violations = hygiene.scan_text_hygiene_violations(root, ["RELEASE_GATE.md"])
            self.assertEqual(len(violations), 1)
            self.assertIn("RELEASE_GATE.md:1:", violations[0])
            self.assertIn("0x0C", violations[0])

            clean_doc = root / "CLEAN.md"
            clean_doc.write_bytes(
                b"# RELEASE GATE (`feat/branch`)\r\n\tTi\xe1\xba\xbfng Vi\xe1\xbb\x87t h\xe1\xbb\x8dc \xc4\x91\xe1\xbb\x8dc\r\n"
            )
            self.assertEqual(hygiene.scan_text_hygiene_violations(root, ["CLEAN.md"]), [])

    def test_ignores_standalone_markdown_setext_headings_and_binaries(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            (root / "README.md").write_text(
                "Main Heading\n=======\n\nAnother Section\n========\n\nBody text.\n",
                encoding="utf-8",
            )
            (root / "image.png").write_bytes(b"\x89PNG\r\n\x1a\n\x00\x0c<<<<<<< HEAD\n")
            (root / ".coverage").write_bytes(b"SQLite format 3\x00\x0c\xff\xfe")

            violations = hygiene.scan_text_hygiene_violations(
                root,
                ["README.md", "image.png", ".coverage"],
            )
            self.assertEqual(violations, [])

    def test_real_repository_passes_verify(self) -> None:
        hygiene.verify()


if __name__ == "__main__":
    unittest.main()
