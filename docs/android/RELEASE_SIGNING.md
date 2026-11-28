# ViRead Android Release Signing & Offline Keystore Guide

ViRead enforces a **zero-secret repository contract**: upload keystores, passwords, and private keys MUST NEVER be committed to Git, stored in `gradle.properties`, or embedded in APK assets.

Debug builds (`:app:assembleDebug`), JVM unit tests (`:app:testDebugUnitTest`), and Android Lint (`:app:lintDebug`) work out-of-the-box without release credentials. Release tasks (`:app:assembleRelease`, `:app:bundleRelease`, `:app:preReleaseBuild`) **fail closed** unless all four `VIREAD_UPLOAD_*` environment variables are explicitly supplied.

---

## 1. Required Environment Variables (`signingConfigs.release`)

`android/app/build.gradle` configures `signingConfigs.release` (APK Signature Scheme v1 + v2) strictly from environment variables:

| Environment Variable           | Description                                                                                    |
| ------------------------------ | ---------------------------------------------------------------------------------------------- |
| `VIREAD_UPLOAD_STORE_FILE`     | Absolute path to an external PKCS#12 / JKS upload keystore file **outside** the Git repository |
| `VIREAD_UPLOAD_STORE_PASSWORD` | Keystore password                                                                              |
| `VIREAD_UPLOAD_KEY_ALIAS`      | Upload key alias inside the keystore (e.g. `viread-upload`)                                    |
| `VIREAD_UPLOAD_KEY_PASSWORD`   | Private key password for `VIREAD_UPLOAD_KEY_ALIAS`                                             |

In addition, release builds require:

- `VIREAD_FRONTEND_URL` set to the verified public HTTPS Next.js origin (port `443`, `VIREAD_LAN_MODE` unset/`false`).

---

## 2. Generating an Offline Upload Keystore (Owner Machine Only)

Store the upload keystore in an encrypted directory **outside** the repository checkout (for example `~/secure-keys/viread-upload.jks` or `%USERPROFILE%\secure-keys\viread-upload.jks`):

```bash
keytool -genkeypair \
  -v \
  -storetype PKCS12 \
  -keystore "$HOME/secure-keys/viread-upload.jks" \
  -alias viread-upload \
  -keyalg RSA \
  -keysize 4096 \
  -validity 9125
```

Back up both the `.jks` file and credentials in an offline password manager. Verify `git status` shows zero untracked `.jks` / `.keystore` files inside the repository.

---

## 3. Building & Verifying a Signed Release APK Locally

### Bash (Linux / macOS)

```bash
export VIREAD_FRONTEND_URL="https://your-production-domain.example.com"
export VIREAD_BACKEND_URL="https://capstone1-ssd8.onrender.com"
export VIREAD_UPLOAD_STORE_FILE="$HOME/secure-keys/viread-upload.jks"
export VIREAD_UPLOAD_STORE_PASSWORD="<store-password>"
export VIREAD_UPLOAD_KEY_ALIAS="viread-upload"
export VIREAD_UPLOAD_KEY_PASSWORD="<key-password>"

# 1. Read-only HTTPS + CORS + 401 JSON preflight against live frontend & backend
python3 android/scripts/verify_frontend.py --backend-url "$VIREAD_BACKEND_URL"

# 2. Build R8-minified, resource-shrunk, signed release APK
(cd android && gradle --no-daemon :app:assembleRelease)

# 3. Audit APK security/signature and stage SHA256SUMS.txt + RELEASE_NOTES.md
python3 android/scripts/stage_apk_release.py \
  android/app/build/outputs/apk/release/app-release.apk \
  --output-dir .runtime/apk-release-staging \
  --channel release \
  --frontend-url "$VIREAD_FRONTEND_URL"
```

### PowerShell (Windows)

```powershell
$env:VIREAD_FRONTEND_URL = "https://your-production-domain.example.com"
$env:VIREAD_BACKEND_URL = "https://capstone1-ssd8.onrender.com"
$env:VIREAD_UPLOAD_STORE_FILE = "$HOME\secure-keys\viread-upload.jks"
$env:VIREAD_UPLOAD_STORE_PASSWORD = "<store-password>"
$env:VIREAD_UPLOAD_KEY_ALIAS = "viread-upload"
$env:VIREAD_UPLOAD_KEY_PASSWORD = "<key-password>"

python android/scripts/verify_frontend.py --backend-url "$env:VIREAD_BACKEND_URL"
Push-Location android; gradle --no-daemon :app:assembleRelease; Pop-Location
python android/scripts/stage_apk_release.py `
  android/app/build/outputs/apk/release/app-release.apk `
  --output-dir .runtime/apk-release-staging `
  --channel release `
  --frontend-url "$env:VIREAD_FRONTEND_URL"
```

---

## 4. Ephemeral Keystore Materialization in GitHub Actions (Optional)

When owner-approved release signing is enabled in CI:

1. Base64-encode the upload keystore (`base64 -w0 viread-upload.jks`) into a GitHub Actions Repository Secret `VIREAD_UPLOAD_KEYSTORE_BASE64`, alongside `VIREAD_UPLOAD_STORE_PASSWORD`, `VIREAD_UPLOAD_KEY_ALIAS`, and `VIREAD_UPLOAD_KEY_PASSWORD`.
2. Decode into `"${RUNNER_TEMP}/viread-upload.jks"` with `chmod 600` for the build step only, pass `VIREAD_UPLOAD_STORE_FILE="${RUNNER_TEMP}/viread-upload.jks"`, and `shred -u` / `rm -f` in an `if: always()` cleanup step.
