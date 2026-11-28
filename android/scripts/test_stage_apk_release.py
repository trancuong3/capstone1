"""Unit tests for `stage_apk_release.py` covering APK quality enforcement,
SHA256SUMS.txt formatting, in-place staging, and structured release notes rendering.
"""
from __future__ import annotations

import hashlib
import tempfile
import unittest
from pathlib import Path

from stage_apk_release import DEFAULT_TEMPLATE_PATH, main, stage_apk_release
from test_verify_apk_quality import VALID_BADGING, VALID_XMLTREE, _write_synthetic_apk


def _fake_valid_runner(cmd: list[str]) -> tuple[int, str, str]:
    if "badging" in cmd:
        return 0, VALID_BADGING, ""
    if "xmltree" in cmd:
        return 0, VALID_XMLTREE, ""
    if "verify" in cmd:
        return 0, "Verified using v2 scheme (APK Signature Scheme v2): true\n", ""
    raise AssertionError(f"Unexpected command: {cmd}")


class StageApkReleaseTests(unittest.TestCase):
    def test_stages_valid_apk_writes_sha256sums_and_renders_release_notes(self) -> None:
        self.assertTrue(DEFAULT_TEMPLATE_PATH.is_file(), "APK_RELEASE_NOTES_TEMPLATE.md must exist")
        with tempfile.TemporaryDirectory() as tmp:
            tmp_dir = Path(tmp)
            fake_aapt2 = tmp_dir / "aapt2"
            fake_signer = tmp_dir / "apksigner"
            fake_aapt2.write_text("stub", encoding="utf-8")
            fake_signer.write_text("stub", encoding="utf-8")

            src_apk = tmp_dir / "build" / "app-release.apk"
            src_apk.parent.mkdir(parents=True)
            _write_synthetic_apk(src_apk)
            expected_sha = hashlib.sha256(src_apk.read_bytes()).hexdigest()

            out_dir = tmp_dir / "staged"
            summary = stage_apk_release(
                src_apk,
                out_dir,
                channel="release",
                frontend_url="https://viread.example.com",
                version_name="0.2.0",
                version_code=2,
                git_sha="ec44b4ce1234",
                staged_filename="viread-0.2.0-release.apk",
                aapt2_bin=str(fake_aapt2),
                apksigner_bin=str(fake_signer),
                runner=_fake_valid_runner,
            )

            staged_apk = Path(str(summary["staged_apk"]))
            sha_file = Path(str(summary["sha256sums_path"]))
            notes_file = Path(str(summary["release_notes_path"]))

            self.assertTrue(staged_apk.is_file())
            self.assertEqual(staged_apk.name, "viread-0.2.0-release.apk")
            self.assertEqual(summary["sha256"], expected_sha)
            self.assertEqual(
                sha_file.read_text(encoding="utf-8"),
                f"{expected_sha}  viread-0.2.0-release.apk\n",
            )

            notes = notes_file.read_text(encoding="utf-8")
            self.assertIn("vn.viread.android", notes)
            self.assertIn("0.2.0", notes)
            self.assertIn("https://viread.example.com", notes)
            self.assertIn(expected_sha, notes)
            self.assertIn("viread-0.2.0-release.apk: OK", notes)
            self.assertNotIn("{{", notes)

    def test_in_place_staging_preserves_apk_and_rejects_secret_leaking_apk(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            tmp_dir = Path(tmp)
            fake_aapt2 = tmp_dir / "aapt2"
            fake_signer = tmp_dir / "apksigner"
            fake_aapt2.write_text("stub", encoding="utf-8")
            fake_signer.write_text("stub", encoding="utf-8")

            in_place_apk = tmp_dir / "app-debug.apk"
            _write_synthetic_apk(in_place_apk)
            summary = stage_apk_release(
                in_place_apk,
                tmp_dir,
                channel="debug",
                aapt2_bin=str(fake_aapt2),
                apksigner_bin=str(fake_signer),
                runner=_fake_valid_runner,
            )
            self.assertEqual(Path(str(summary["staged_apk"])), in_place_apk.resolve())
            self.assertTrue((tmp_dir / "SHA256SUMS.txt").is_file())

            bad_apk = tmp_dir / "leaked.apk"
            _write_synthetic_apk(
                bad_apk,
                extra_entries={"assets/secret.txt": b"SUPABASE_SERVICE_ROLE_KEY=eyJhbGci"},
            )
            bad_out = tmp_dir / "bad-staged"
            with self.assertRaisesRegex(ValueError, "SUPABASE_SERVICE_ROLE_KEY"):
                stage_apk_release(
                    bad_apk,
                    bad_out,
                    channel="release",
                    aapt2_bin=str(fake_aapt2),
                    apksigner_bin=str(fake_signer),
                    runner=_fake_valid_runner,
                )
            self.assertFalse((bad_out / "SHA256SUMS.txt").exists())
            self.assertFalse((bad_out / "RELEASE_NOTES.md").exists())

    def test_cli_main_returns_nonzero_on_missing_apk(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            rc = main([str(Path(tmp) / "missing.apk"), "--output-dir", tmp])
            self.assertEqual(rc, 1)


if __name__ == "__main__":
    unittest.main()
