# ViRead Android APK Release (`{{VERSION_NAME}}` — Build `{{VERSION_CODE}}`, `{{CHANNEL}}`)

## Artifact Metadata

| Field                              | Value                                                                         |
| ---------------------------------- | ----------------------------------------------------------------------------- |
| **Application Label**              | `{{APP_LABEL}}`                                                               |
| **Android Package ID**             | `{{PACKAGE_NAME}}`                                                            |
| **Version**                        | `{{VERSION_NAME}}` (`versionCode={{VERSION_CODE}}`)                           |
| **Distribution Channel**           | `{{CHANNEL}}`                                                                 |
| **Git Commit SHA**                 | `{{GIT_SHA}}`                                                                 |
| **SDK Compatibility**              | `minSdk={{MIN_SDK}}` (Android 8.0+) / `targetSdk={{TARGET_SDK}}` (Android 15) |
| **Verified HTTPS Frontend Origin** | `{{FRONTEND_URL}}`                                                            |
| **APK Filename**                   | `{{APK_FILENAME}}`                                                            |
| **APK Size**                       | `{{APK_SIZE_MB}} MB` (`{{APK_SIZE_BYTES}}` bytes)                             |
| **SHA-256 Digest**                 | `{{SHA256}}`                                                                  |

---

## Integrity Verification

Download both `{{APK_FILENAME}}` and `SHA256SUMS.txt` into the same folder and verify before installing:

```bash
sha256sum -c SHA256SUMS.txt
```

Expected output:

```text
{{APK_FILENAME}}: OK
```

On Windows PowerShell:

```powershell
(Get-FileHash .\{{APK_FILENAME}} -Algorithm SHA256).Hash.ToLower() -eq "{{SHA256}}"
```

---

## Automated Security & Packaging Audit (`verify_apk_quality.py`)

- **Cryptographic Signature (`apksigner verify`)**: `VERIFIED`
- **Cleartext HTTP Disabled (`android:usesCleartextTraffic="false"`)**: `VERIFIED`
- **Unencrypted Backup Disabled (`android:allowBackup="false"`)**: `VERIFIED`
- **Scoped Unexported `FileProvider` (`vn.viread.android.fileprovider`)**: `VERIFIED`
- **Launcher Icons**: `{{LAUNCHER_PNG_COUNT}}` raster PNGs across `mdpi`..`xxxhdpi` + `{{ADAPTIVE_XML_COUNT}}` adaptive XML descriptors
- **Zero Embedded Secrets / Loopback / Static Bundles**: `VERIFIED`

---

## Installation & Acceptance Notes

1. Requires Android 8.0 (`API 26`) or newer with network connectivity to `{{FRONTEND_URL}}`.
2. Camera (book page scanning) and microphone (child reading aloud & karaoke practice) permissions are requested at runtime only when entering those flows.
3. Do **not** publish pre-release or debug builds to public app stores; promote to GitHub Releases only after owner sign-off.
