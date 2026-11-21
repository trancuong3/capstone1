"""Unit tests for `verify_apk_quality.py` covering badging, manifest security,
mipmap/adaptive icons, secret-leak detection, static-bundle rejection, and signing.
"""
from __future__ import annotations

import tempfile
import unittest
import zipfile
from pathlib import Path

from verify_apk_quality import (
    REQUIRED_ICON_DENSITIES,
    inspect_apk_zip_contents,
    verify_apk,
    verify_badging_output,
    verify_manifest_xmltree,
)

VALID_BADGING = """\
package: name='vn.viread.android' versionCode='1' versionName='0.1.0' compileSdkVersion='35'
sdkVersion:'26'
targetSdkVersion:'35'
application-label:'ViRead'
application-icon-160:'res/mipmap-mdpi-v4/ic_launcher.png'
application-icon-240:'res/mipmap-hdpi-v4/ic_launcher.png'
application-icon-320:'res/mipmap-xhdpi-v4/ic_launcher.png'
application-icon-480:'res/mipmap-xxhdpi-v4/ic_launcher.png'
application-icon-640:'res/mipmap-xxxhdpi-v4/ic_launcher.png'
launchable-activity: name='vn.viread.android.MainActivity'  label='ViRead' icon=''
"""

VALID_XMLTREE = """\
N: android=http://schemas.android.com/apk/res/android
  E: manifest (line=2)
    A: package="vn.viread.android" (Raw: "vn.viread.android")
    E: application (line=10)
      A: http://schemas.android.com/apk/res/android:allowBackup(0x01010280)=(type 0x12)0x0
      A: http://schemas.android.com/apk/res/android:usesCleartextTraffic(0x010104ec)=(type 0x12)0x0
      E: provider (line=31)
        A: http://schemas.android.com/apk/res/android:name(0x01010003)="androidx.core.content.FileProvider"
        A: http://schemas.android.com/apk/res/android:authorities(0x01010018)="vn.viread.android.fileprovider"
        A: http://schemas.android.com/apk/res/android:exported(0x01010010)=(type 0x12)0x0
"""


def _write_synthetic_apk(
    apk_path: Path,
    *,
    extra_entries: dict[str, bytes] | None = None,
    include_icons: bool = True,
) -> None:
    with zipfile.ZipFile(apk_path, "w") as zf:
        zf.writestr("classes.dex", b"dex\n039\x00https://192.168.1.4:8443")
        zf.writestr("AndroidManifest.xml", b"<binary-xml/>")
        if include_icons:
            zf.writestr("res/mipmap-anydpi-v26/ic_launcher.xml", b"<adaptive-icon/>")
            zf.writestr("res/mipmap-anydpi-v26/ic_launcher_round.xml", b"<adaptive-icon/>")
            for density in ("mdpi", "hdpi", "xhdpi", "xxhdpi", "xxxhdpi"):
                zf.writestr(f"res/mipmap-{density}-v4/ic_launcher.png", b"\x89PNG\r\n\x1a\nvalid")
                zf.writestr(f"res/mipmap-{density}-v4/ic_launcher_round.png", b"\x89PNG\r\n\x1a\nvalid")
        for name, data in (extra_entries or {}).items():
            zf.writestr(name, data)


class VerifyApkQualityTests(unittest.TestCase):
    def test_valid_synthetic_apk_passes_full_pipeline(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            tmp_dir = Path(tmp)
            fake_aapt2 = tmp_dir / "aapt2"
            fake_signer = tmp_dir / "apksigner"
            fake_aapt2.write_text("stub", encoding="utf-8")
            fake_signer.write_text("stub", encoding="utf-8")
            apk_file = tmp_dir / "app-debug.apk"
            _write_synthetic_apk(apk_file)

            def fake_runner(cmd: list[str]) -> tuple[int, str, str]:
                if "badging" in cmd:
                    return 0, VALID_BADGING, ""
                if "xmltree" in cmd:
                    return 0, VALID_XMLTREE, ""
                if "verify" in cmd:
                    return 0, "Verified using v2 scheme (APK Signature Scheme v2): true\n", ""
                raise AssertionError(f"Unexpected command: {cmd}")

            report = verify_apk(
                apk_file,
                aapt2_bin=str(fake_aapt2),
                apksigner_bin=str(fake_signer),
                runner=fake_runner,
            )
            self.assertEqual(report["package"], "vn.viread.android")
            self.assertEqual(report["label"], "ViRead")
            self.assertEqual(report["target_sdk"], 35)
            self.assertEqual(report["launcher_png_count"], 10)
            self.assertEqual(report["adaptive_xml_count"], 2)
            self.assertTrue(report["signature_verified"])
            self.assertEqual(len(str(report["sha256"])), 64)

    def test_rejects_wrong_label_sdk_or_missing_icon_density(self) -> None:
        with self.assertRaisesRegex(ValueError, "ViRead"):
            verify_badging_output(VALID_BADGING.replace("application-label:'ViRead'", "application-label:'MyApp'"))

        with self.assertRaisesRegex(ValueError, "targetSdk"):
            verify_badging_output(VALID_BADGING.replace("targetSdkVersion:'35'", "targetSdkVersion:'33'"))

        for density in REQUIRED_ICON_DENSITIES:
            broken = VALID_BADGING.replace(f"application-icon-{density}:", "removed:")
            with self.assertRaisesRegex(ValueError, f"application-icon-{density}"):
                verify_badging_output(broken)

    def test_rejects_cleartext_traffic_backup_or_missing_fileprovider(self) -> None:
        with self.assertRaisesRegex(ValueError, "cleartext"):
            verify_manifest_xmltree(
                VALID_XMLTREE.replace("usesCleartextTraffic(0x010104ec)=(type 0x12)0x0",
                                      "usesCleartextTraffic(0x010104ec)=(type 0x12)0xffffffff")
            )
        with self.assertRaisesRegex(ValueError, "backup"):
            verify_manifest_xmltree(
                VALID_XMLTREE.replace("allowBackup(0x01010280)=(type 0x12)0x0",
                                      "allowBackup(0x01010280)=(type 0x12)0xffffffff")
            )
        with self.assertRaisesRegex(ValueError, "FileProvider"):
            verify_manifest_xmltree(VALID_XMLTREE.replace("androidx.core.content.FileProvider", "OtherProvider"))

    def test_rejects_secrets_private_keys_loopback_and_static_export_in_apk(self) -> None:
        bad_payloads = [
            {"classes2.dex": b"leak SUPABASE_SERVICE_ROLE_KEY=secret"},
            {"res/raw/ca.pem": b"-----BEGIN PRIVATE KEY-----\nabc"},
            {"classes2.dex": b"origin https://127.0.0.1:8443"},
            {"classes2.dex": b"origin https://example.org"},
            {"assets/_next/static/chunk.js": b"console.log(1)"},
        ]
        with tempfile.TemporaryDirectory() as tmp:
            for idx, extra in enumerate(bad_payloads):
                with self.subTest(extra=list(extra.keys())[0], idx=idx):
                    apk = Path(tmp) / f"bad_{idx}.apk"
                    _write_synthetic_apk(apk, extra_entries=extra)
                    with self.assertRaises(ValueError):
                        inspect_apk_zip_contents(apk)

            missing_icons_apk = Path(tmp) / "no_icons.apk"
            _write_synthetic_apk(missing_icons_apk, include_icons=False)
            with self.assertRaisesRegex(ValueError, "launcher PNGs"):
                inspect_apk_zip_contents(missing_icons_apk)


if __name__ == "__main__":
    unittest.main()
