"""Comprehensive tests for Flow 2 Google Drive storage abstraction, OAuth 2.0, quota guard, and security.

Covers Test Groups C (Google Drive), I (Security), J (Cost & Performance),
and Round 2 Red-Team adversarial failure simulations.
"""

from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path
import re
import tempfile
import unittest
from unittest.mock import AsyncMock, MagicMock, patch
from urllib.parse import parse_qs, urlsplit
from uuid import uuid4

from fastapi import HTTPException
import requests

os.environ.setdefault("DATABASE_URL", "postgresql+asyncpg://test:test@127.0.0.1:1/test")
os.environ.setdefault("SUPABASE_URL", "https://example.supabase.co")
os.environ.setdefault("SUPABASE_KEY", "isolated-test-key")
os.environ.setdefault("DATABASE_POOLER_MODE", "local")
os.environ.setdefault("DATABASE_SSL_REQUIRED", "false")

from app.api.routes import admin_viread_training
from app.services.training_storage import (
    GOOGLE_DRIVE_REQUIRED_SCOPE,
    RESUMABLE_CHUNK_GRANULARITY,
    DriveAuthError,
    DriveIntegrityError,
    DriveNotConnectedError,
    DriveNotFoundError,
    DrivePermissionError,
    DriveQuotaExceededError,
    DriveRateLimitError,
    GoogleDriveOAuthConfig,
    GoogleDriveTrainingStore,
    StorageProvider,
    TrainingArtifactStoreRouter,
    TrainingStorageError,
    create_oauth_authorization,
    decrypt_refresh_token,
    encrypt_refresh_token,
    format_gdrive_ref,
    parse_artifact_ref,
    sign_worker_artifact_token,
    validate_granted_scopes,
    validate_logical_path,
    verify_and_consume_oauth_state,
    verify_worker_artifact_token,
)
from app.services.training_storage.google_drive_oauth import (
    clear_consumed_oauth_nonces_for_tests,
)


class _FakeResponse:
    def __init__(
        self,
        status_code: int,
        *,
        json_data: dict | None = None,
        content: bytes = b"",
        headers: dict[str, str] | None = None,
        stream_chunks: list[bytes] | None = None,
        fail_after_chunk: int | None = None,
    ) -> None:
        self.status_code = status_code
        self._json_data = json_data
        self.content = content if content else (json.dumps(json_data).encode("utf-8") if json_data is not None else b"")
        self.headers = dict(headers or {})
        self._stream_chunks = stream_chunks
        self._fail_after_chunk = fail_after_chunk
        self.closed = False

    def json(self):
        if self._json_data is not None:
            return self._json_data
        return json.loads(self.content.decode("utf-8"))

    def iter_content(self, chunk_size: int = 1024 * 1024):
        if self._stream_chunks is not None:
            for idx, chunk in enumerate(self._stream_chunks):
                if self._fail_after_chunk is not None and idx >= self._fail_after_chunk:
                    raise requests.ConnectionError("Simulated mid-stream network drop")
                yield chunk
            return
        for offset in range(0, len(self.content), chunk_size):
            yield self.content[offset : offset + chunk_size]

    def close(self) -> None:
        self.closed = True


class InMemoryGoogleDriveServer:
    """Deterministic in-memory simulator of Google Drive API v3 & OAuth 2.0 endpoints."""

    def __init__(
        self,
        *,
        quota_limit: int = 15 * 1024**3,
        quota_usage: int = 1 * 1024**3,
        account_email: str = "admin-flow2@example.com",
    ) -> None:
        self.quota_limit = quota_limit
        self.quota_usage = quota_usage
        self.account_email = account_email
        self.valid_access_token = "access-token-initial"
        self.valid_refresh_token = "refresh-token-valid"
        self.token_revoked = False
        self.files: dict[str, dict] = {}
        self.contents: dict[str, bytes] = {}
        self.upload_sessions: dict[str, dict] = {}
        self._next_id = 1000
        self.requests_log: list[tuple[str, str]] = []
        self.injected_failures: list[tuple[str, Exception | _FakeResponse]] = []
        self.drop_next_download_at_byte: int | None = None

    def _new_file_id(self, prefix: str = "drv") -> str:
        self._next_id += 1
        return f"{prefix}_{self._next_id:012d}_viread"

    def make_session(self) -> requests.Session:
        server = self

        class _MockSession(requests.Session):
            def request(self, method, url, **kwargs):
                return server.handle(method.upper(), url, **kwargs)

            def post(self, url, **kwargs):
                return server.handle("POST", url, **kwargs)

            def put(self, url, **kwargs):
                return server.handle("PUT", url, **kwargs)

            def get(self, url, **kwargs):
                return server.handle("GET", url, **kwargs)

        return _MockSession()

    def handle(self, method: str, url: str, **kwargs) -> _FakeResponse:
        self.requests_log.append((method, url))
        for idx, (pattern, outcome) in enumerate(list(self.injected_failures)):
            if pattern in f"{method} {url}":
                self.injected_failures.pop(idx)
                if isinstance(outcome, Exception):
                    raise outcome
                return outcome

        if "oauth2.googleapis.com/token" in url:
            data = kwargs.get("data") or {}
            if data.get("grant_type") == "refresh_token":
                if self.token_revoked or data.get("refresh_token") != self.valid_refresh_token:
                    return _FakeResponse(400, json_data={"error": "invalid_grant"})
                self.valid_access_token = f"access-token-refreshed-{len(self.requests_log)}"
                return _FakeResponse(
                    200,
                    json_data={
                        "access_token": self.valid_access_token,
                        "expires_in": 3600,
                        "scope": GOOGLE_DRIVE_REQUIRED_SCOPE,
                        "token_type": "Bearer",
                    },
                )
            if data.get("grant_type") == "authorization_code":
                return _FakeResponse(
                    200,
                    json_data={
                        "access_token": self.valid_access_token,
                        "refresh_token": self.valid_refresh_token,
                        "expires_in": 3600,
                        "scope": GOOGLE_DRIVE_REQUIRED_SCOPE,
                        "token_type": "Bearer",
                    },
                )
        if "oauth2.googleapis.com/revoke" in url:
            self.token_revoked = True
            return _FakeResponse(200)

        headers = kwargs.get("headers") or {}
        if headers.get("Authorization") != f"Bearer {self.valid_access_token}":
            return _FakeResponse(401, json_data={"error": {"message": "Invalid Credentials"}})

        if "/drive/v3/about" in url:
            return _FakeResponse(
                200,
                json_data={
                    "user": {"emailAddress": self.account_email, "displayName": "ViRead Admin"},
                    "storageQuota": {
                        "limit": str(self.quota_limit),
                        "usage": str(self.quota_usage),
                        "usageInDrive": str(self.quota_usage),
                        "usageInDriveTrash": "0",
                    },
                },
            )

        if "upload/drive/v3/files" in url and method == "POST":
            body = kwargs.get("json") or {}
            session_id = self._new_file_id("sess")
            session_uri = f"https://www.googleapis.com/upload/drive/v3/resumable/{session_id}"
            self.upload_sessions[session_uri] = {
                "meta": body,
                "total": int(headers.get("X-Upload-Content-Length", "0")),
                "buffer": bytearray(),
                "completed_file_id": None,
            }
            return _FakeResponse(200, headers={"Location": session_uri})

        if "/upload/drive/v3/resumable/" in url and method == "PUT":
            sess = self.upload_sessions.get(url)
            if not sess:
                return _FakeResponse(404, json_data={"error": {"message": "Upload session expired"}})
            content_range = headers.get("Content-Range", "")
            data = kwargs.get("data") or b""
            if content_range.startswith("bytes */"):
                if sess["completed_file_id"]:
                    return _FakeResponse(200, json_data=self.files[sess["completed_file_id"]])
                committed = len(sess["buffer"])
                if committed == 0:
                    return _FakeResponse(308)
                return _FakeResponse(308, headers={"Range": f"bytes=0-{committed - 1}"})
            if sess["total"] == 0:
                return self._finalize_upload(sess)
            match = re.match(r"bytes (\d+)-(\d+)/(\d+)", content_range)
            if not match:
                return _FakeResponse(400, json_data={"error": {"message": "Bad Content-Range"}})
            start, end, total = int(match.group(1)), int(match.group(2)), int(match.group(3))
            if start != len(sess["buffer"]) or (end - start + 1) != len(data):
                return _FakeResponse(400, json_data={"error": {"message": "Out-of-order resumable chunk"}})
            sess["buffer"].extend(data)
            if len(sess["buffer"]) < total:
                return _FakeResponse(308, headers={"Range": f"bytes=0-{len(sess['buffer']) - 1}"})
            return self._finalize_upload(sess)

        if url.endswith("/drive/v3/files") and method == "GET":
            q = (kwargs.get("params") or {}).get("q", "")
            name_m = re.search(r"name = '([^']+)'", q)
            parent_m = re.search(r"'([^']+)' in parents", q)
            want_folder = "mimeType = 'application/vnd.google-apps.folder'" in q
            want_non_folder = "mimeType != 'application/vnd.google-apps.folder'" in q
            matched = []
            for item in self.files.values():
                if item.get("trashed"):
                    continue
                if name_m and item["name"] != name_m.group(1):
                    continue
                if parent_m and parent_m.group(1) not in item.get("parents", []):
                    continue
                is_folder = item["mimeType"] == "application/vnd.google-apps.folder"
                if want_folder and not is_folder:
                    continue
                if want_non_folder and is_folder:
                    continue
                matched.append(item)
            return _FakeResponse(200, json_data={"files": matched})

        if url.endswith("/drive/v3/files") and method == "POST":
            body = kwargs.get("json") or {}
            file_id = self._new_file_id("fld")
            record = {
                "id": file_id,
                "name": body["name"],
                "mimeType": body["mimeType"],
                "parents": body.get("parents", ["root"]),
                "trashed": False,
                "appProperties": body.get("appProperties", {}),
                "permissions": [{"type": "user", "role": "owner"}],
            }
            self.files[file_id] = record
            return _FakeResponse(200, json_data=record)

        file_match = re.search(r"/drive/v3/files/([^/?]+)$", url)
        if file_match:
            file_id = file_match.group(1)
            item = self.files.get(file_id)
            if not item:
                return _FakeResponse(404, json_data={"error": {"message": "File not found"}})
            if method == "DELETE":
                raw = self.contents.pop(file_id, b"")
                self.quota_usage = max(0, self.quota_usage - len(raw))
                self.files.pop(file_id, None)
                return _FakeResponse(204)
            params = kwargs.get("params") or {}
            if method == "GET" and params.get("alt") == "media":
                raw = self.contents.get(file_id, b"")
                range_hdr = headers.get("Range", "")
                start = 0
                status = 200
                if range_hdr.startswith("bytes="):
                    start = int(range_hdr.split("=", 1)[1].split("-", 1)[0])
                    status = 206
                slice_bytes = raw[start:]
                if self.drop_next_download_at_byte is not None and start == 0:
                    cut = self.drop_next_download_at_byte
                    self.drop_next_download_at_byte = None
                    return _FakeResponse(
                        status,
                        stream_chunks=[slice_bytes[:cut], slice_bytes[cut:]],
                        fail_after_chunk=1,
                    )
                return _FakeResponse(status, content=slice_bytes)
            if method == "GET":
                return _FakeResponse(200, json_data=item)

        return _FakeResponse(404, json_data={"error": {"message": f"Unhandled {method} {url}"}})

    def _finalize_upload(self, sess: dict) -> _FakeResponse:
        raw = bytes(sess["buffer"])
        meta = sess["meta"]
        file_id = self._new_file_id("obj")
        record = {
            "id": file_id,
            "name": meta["name"],
            "mimeType": meta.get("mimeType", "application/octet-stream"),
            "parents": meta.get("parents", ["root"]),
            "size": str(len(raw)),
            "sha256Checksum": hashlib.sha256(raw).hexdigest(),
            "trashed": False,
            "appProperties": meta.get("appProperties", {}),
            "permissions": [{"type": "user", "role": "owner"}],
        }
        self.files[file_id] = record
        self.contents[file_id] = raw
        self.quota_usage += len(raw)
        sess["completed_file_id"] = file_id
        return _FakeResponse(200, json_data=record)


class ReferenceAndSecurityValidationTests(unittest.TestCase):
    def test_provider_explicit_references_and_traversal_defense(self):
        ref = format_gdrive_ref("drv_0000001001_viread")
        parsed = parse_artifact_ref(ref)
        self.assertEqual(parsed.provider, StorageProvider.GOOGLE_DRIVE)
        self.assertEqual(parsed.drive_file_id, "drv_0000001001_viread")

        legacy = parse_artifact_ref("ocr-training/checkpoints/run-1/0000.part")
        self.assertEqual(legacy.provider, StorageProvider.SUPABASE_LEGACY)
        self.assertIsNone(legacy.drive_file_id)

        for bad in (
            "",
            "gdrive://short",
            "gdrive://bad/slash/id123456",
            "gdrive://../../etc/passwd",
            "https://drive.google.com/file/d/public/view",
            "http://example.com/file.png",
            "../secret.env",
            "verified-samples/rev/../../escape.png",
            "verified-samples\\windows\\slash.png",
            "/leading/slash.png",
            "verified-samples/null\x00byte.png",
        ):
            with self.assertRaises(ValueError, msg=f"Should reject {bad!r}"):
                parse_artifact_ref(bad)

        with self.assertRaises(ValueError):
            validate_logical_path("unknown-folder/file.png", require_known_category=True)
        self.assertEqual(
            validate_logical_path("verified-samples/rev-1/line-0001.png", require_known_category=True),
            "verified-samples/rev-1/line-0001.png",
        )

    def test_oauth_pkce_state_fernet_encryption_scope_and_anti_replay(self):
        clear_consumed_oauth_nonces_for_tests()
        secret_key = "k" * 48
        cfg = GoogleDriveOAuthConfig(
            client_id="viread-client-id.apps.googleusercontent.com",
            client_secret="super-secret-oauth-client",
            redirect_uri="https://viread.example.com/admin/viread-training",
            encryption_key=secret_key,
        )
        actor_a = str(uuid4())
        actor_b = str(uuid4())

        started = create_oauth_authorization(cfg, actor_id=actor_a)
        query = parse_qs(urlsplit(started.authorization_url).query)
        self.assertEqual(query["scope"], [GOOGLE_DRIVE_REQUIRED_SCOPE])
        self.assertEqual(query["access_type"], ["offline"])
        self.assertEqual(query["prompt"], ["consent"])
        self.assertEqual(query["include_granted_scopes"], ["false"])
        self.assertEqual(query["code_challenge_method"], ["S256"])
        self.assertNotIn(actor_a, started.state)

        # Cross-admin CSRF / session fixation blocked with 403
        with self.assertRaises(DrivePermissionError):
            verify_and_consume_oauth_state(
                started.state,
                expected_actor_id=actor_b,
                encryption_key=secret_key,
            )

        # Valid admin succeeds once
        payload = verify_and_consume_oauth_state(
            started.state,
            expected_actor_id=actor_a,
            encryption_key=secret_key,
        )
        self.assertEqual(payload.actor_id, actor_a)

        # Replaying same state token is rejected
        with self.assertRaises(DriveAuthError) as replay_err:
            verify_and_consume_oauth_state(
                started.state,
                expected_actor_id=actor_a,
                encryption_key=secret_key,
            )
        self.assertEqual(replay_err.exception.code, "DRIVE_OAUTH_STATE_REPLAYED")

        # Fernet refresh token encryption at rest
        cipher, fp = encrypt_refresh_token("dummy-unit-test-refresh-token", secret_key)
        self.assertNotIn("refresh-token", cipher)
        self.assertEqual(len(fp), 16)
        self.assertEqual(decrypt_refresh_token(cipher, secret_key), "dummy-unit-test-refresh-token")
        with self.assertRaises(DriveAuthError):
            decrypt_refresh_token(cipher, "z" * 48)
        with self.assertRaises(TrainingStorageError):
            encrypt_refresh_token("tok", "too-short")

        # Scope enforcement: strict allowlist drive.file ONLY, reject ANY extra scope
        self.assertEqual(validate_granted_scopes(GOOGLE_DRIVE_REQUIRED_SCOPE), GOOGLE_DRIVE_REQUIRED_SCOPE)
        with self.assertRaises(DrivePermissionError) as missing_scope:
            validate_granted_scopes("https://www.googleapis.com/auth/userinfo.email")
        self.assertEqual(missing_scope.exception.code, "DRIVE_SCOPE_MISSING")
        for extra_scope in (
            "https://www.googleapis.com/auth/drive",
            "https://www.googleapis.com/auth/drive.metadata.readonly",
            "https://www.googleapis.com/auth/cloud-platform",
        ):
            with self.assertRaises(DrivePermissionError) as broad_scope:
                validate_granted_scopes(f"{GOOGLE_DRIVE_REQUIRED_SCOPE} {extra_scope}")
            self.assertEqual(broad_scope.exception.code, "DRIVE_SCOPE_TOO_BROAD")

        # Redirect URI allowlist enforcement (H1)
        from app.services.training_storage.google_drive_oauth import load_oauth_config

        with patch.dict(
            os.environ,
            {
                "VIREAD_GDRIVE_OAUTH_CLIENT_ID": "cid",
                "VIREAD_GDRIVE_OAUTH_CLIENT_SECRET": "csec",
                "VIREAD_GDRIVE_OAUTH_REDIRECT_URI": "https://viread.example.com/admin/viread-training",
                "VIREAD_GDRIVE_TOKEN_ENCRYPTION_KEY": secret_key,
            },
        ):
            loaded = load_oauth_config(
                redirect_uri_override="https://viread.example.com/admin/viread-training"
            )
            self.assertEqual(loaded.redirect_uri, "https://viread.example.com/admin/viread-training")
            with self.assertRaises(DrivePermissionError) as bad_redir:
                load_oauth_config(redirect_uri_override="https://evil.example.com/steal")
            self.assertEqual(bad_redir.exception.code, "DRIVE_REDIRECT_URI_NOT_ALLOWED")

    def test_worker_artifact_stream_hmac_uses_server_only_key_and_prevents_idor_and_expiry(self):
        # C1 regression: worker token alone MUST NOT be accepted as HMAC signing secret!
        with patch.dict(
            os.environ,
            {
                "VIREAD_TRAINING_WORKER_TOKEN": "w" * 48,
                "VIREAD_ARTIFACT_STREAM_SIGNING_SECRET": "",
                "VIREAD_GDRIVE_TOKEN_ENCRYPTION_KEY": "",
                "SUPABASE_SECRET_KEY": "",
                "SUPABASE_SERVICE_ROLE_KEY": "",
            },
        ):
            with self.assertRaises(RuntimeError):
                sign_worker_artifact_token(
                    job_id=str(uuid4()),
                    worker_id="colab-worker-1",
                    reference=format_gdrive_ref("drv_0000001055_viread"),
                )

        with patch.dict(
            os.environ,
            {
                "VIREAD_TRAINING_WORKER_TOKEN": "w" * 48,
                "VIREAD_GDRIVE_TOKEN_ENCRYPTION_KEY": "s" * 48,
            },
        ):
            job_a = str(uuid4())
            job_b = str(uuid4())
            ref = format_gdrive_ref("drv_0000001055_viread")
            sha = "a" * 64
            tok = sign_worker_artifact_token(
                job_id=job_a,
                worker_id="colab-worker-1",
                reference=ref,
                expected_sha256=sha,
                ttl_seconds=300,
            )
            claims = verify_worker_artifact_token(
                tok, expected_job_id=job_a, expected_worker_id="colab-worker-1"
            )
            self.assertEqual(claims.reference, ref)
            self.assertEqual(claims.expected_sha256, sha)

            # Wrong job or wrong worker rejected (IDOR defense)
            with self.assertRaises(ValueError):
                verify_worker_artifact_token(tok, expected_job_id=job_b, expected_worker_id="colab-worker-1")
            with self.assertRaises(ValueError):
                verify_worker_artifact_token(tok, expected_job_id=job_a, expected_worker_id="colab-worker-2")
            # Tampered signature rejected
            with self.assertRaises(ValueError):
                verify_worker_artifact_token(tok[:-2] + "xx", expected_job_id=job_a, expected_worker_id="colab-worker-1")
            # Expired token rejected
            with self.assertRaises(ValueError):
                verify_worker_artifact_token(
                    tok,
                    expected_job_id=job_a,
                    expected_worker_id="colab-worker-1",
                    now_ts=claims.expires_at + 10,
                )


class GoogleDriveStoreResilienceTests(unittest.TestCase):
    def _build_store(
        self,
        server: InMemoryGoogleDriveServer,
        *,
        chunk_bytes: int = RESUMABLE_CHUNK_GRANULARITY,
        min_free_bytes: int = 512 * 1024 * 1024,
        on_revoked=None,
    ) -> tuple[GoogleDriveTrainingStore, list[float]]:
        sleeps: list[float] = []
        store = GoogleDriveTrainingStore(
            client_id="cid",
            client_secret="csec",
            refresh_token=server.valid_refresh_token,
            access_token=server.valid_access_token,
            access_token_expires_at=9e12,
            session=server.make_session(),
            upload_chunk_bytes=chunk_bytes,
            min_free_buffer_bytes=min_free_bytes,
            base_backoff_seconds=0.1,
            sleep_fn=sleeps.append,
            jitter_fn=lambda _lo, hi: hi * 0.5,
            on_token_revoked=on_revoked,
        )
        return store, sleeps

    def test_resumable_upload_mid_drop_recovery_dedup_and_streaming_range_resume(self):
        server = InMemoryGoogleDriveServer()
        store, sleeps = self._build_store(server, chunk_bytes=RESUMABLE_CHUNK_GRANULARITY)
        # 600 KiB payload -> 3 resumable chunks (256 KiB + 256 KiB + 88 KiB)
        payload = (b"ViRead-Flow2-Checkpoint-Shard!" * 21000)[: 600 * 1024]
        expected_sha = hashlib.sha256(payload).hexdigest()

        # Inject network drop during resumable chunk PUT -> store must query Content-Range */total & resume!
        server.injected_failures.append(
            ("PUT https://www.googleapis.com/upload/drive/v3/resumable/", requests.ConnectionError("mid-upload drop"))
        )

        with tempfile.TemporaryDirectory() as tmp:
            src = Path(tmp) / "shard.bin"
            src.write_bytes(payload)
            stored = store.put(
                "checkpoints/run-1/chunk-0000.part",
                src,
                content_type="application/octet-stream",
                expected_sha256=expected_sha,
            )
            self.assertEqual(stored.provider, StorageProvider.GOOGLE_DRIVE)
            self.assertEqual(stored.sha256, expected_sha)
            self.assertEqual(stored.size_bytes, len(payload))
            self.assertFalse(stored.deduplicated)
            self.assertGreaterEqual(len(sleeps), 1)

            # Repeat upload of exact same logical path & content is deduplicated (0 extra quota)
            usage_before = server.quota_usage
            repeat = store.put(
                "checkpoints/run-1/chunk-0000.part",
                payload,
                expected_sha256=expected_sha,
            )
            self.assertTrue(repeat.deduplicated)
            self.assertEqual(repeat.reference, stored.reference)
            self.assertEqual(server.quota_usage, usage_before)

            # Attempting to overwrite an immutable path with different bytes is blocked
            with self.assertRaises(DriveIntegrityError) as conflict:
                store.put("checkpoints/run-1/chunk-0000.part", b"tampered-bytes")
            self.assertEqual(conflict.exception.code, "IMMUTABLE_ARTIFACT_CONFLICT")

            # Simulate mid-stream download drop -> HTTP Range resume completes intact
            server.drop_next_download_at_byte = 128 * 1024
            dest = Path(tmp) / "downloaded.bin"
            total, actual_sha = store.download_to_path(stored.reference, dest, expected_sha256=expected_sha)
            self.assertEqual(total, len(payload))
            self.assertEqual(actual_sha, expected_sha)
            self.assertEqual(dest.read_bytes(), payload)

    def test_tampered_deleted_trashed_and_public_artifacts_are_rejected(self):
        server = InMemoryGoogleDriveServer()
        store, _ = self._build_store(server)
        payload = b"admin-verified-line-crop"
        sha = hashlib.sha256(payload).hexdigest()
        stored = store.put("verified-samples/rev-1/line-0001.png", payload, content_type="image/png")

        # Tamper file content externally -> checksum mismatch detected
        server.contents[stored.drive_file_id] = b"corrupted-outside-viread"
        with self.assertRaises(DriveIntegrityError):
            store.get(stored.reference, expected_sha256=sha)
        server.contents[stored.drive_file_id] = payload

        # Public permission detected -> refused
        server.files[stored.drive_file_id]["permissions"].append({"type": "anyone", "role": "reader"})
        meta = store.get_metadata(stored.reference)
        self.assertTrue(meta.is_public)
        with self.assertRaises(DrivePermissionError):
            store.put("verified-samples/rev-1/line-0001.png", payload)
        server.files[stored.drive_file_id]["permissions"] = [{"type": "user", "role": "owner"}]

        # Trashed outside system -> treated as not found
        server.files[stored.drive_file_id]["trashed"] = True
        self.assertFalse(store.exists(stored.reference))
        with self.assertRaises(DriveNotFoundError):
            store.get(stored.reference)

        # Unreferenced guard refuses deletion when still referenced
        server.files[stored.drive_file_id]["trashed"] = False
        self.assertFalse(store.delete_if_unreferenced(stored.reference, is_referenced_check=lambda _r: True))
        self.assertTrue(store.exists(stored.reference))
        self.assertTrue(store.delete_if_unreferenced(stored.reference, is_referenced_check=lambda _r: False))
        self.assertFalse(store.exists(stored.reference))

    def test_http_error_matrix_401_403_404_429_5xx_token_revoked_and_backoff_jitter(self):
        revoked_codes: list[str] = []
        server = InMemoryGoogleDriveServer()
        store, sleeps = self._build_store(server, on_revoked=revoked_codes.append)

        # 429 with Retry-After + 503 exponential backoff with jitter -> eventually succeeds
        server.injected_failures.append(
            ("GET https://www.googleapis.com/drive/v3/about", _FakeResponse(429, headers={"Retry-After": "0.25"}))
        )
        server.injected_failures.append(
            ("GET https://www.googleapis.com/drive/v3/about", _FakeResponse(503, json_data={"error": {"message": "Backend Error"}}))
        )
        quota = store.quota_check()
        self.assertTrue(quota.can_accept_upload)
        self.assertEqual(len(sleeps), 2)
        self.assertAlmostEqual(sleeps[0], 0.25, places=2)
        self.assertGreater(sleeps[1], 0.1)

        # 401 -> refreshes token once automatically and succeeds
        server.valid_access_token = "rotated-on-google-side"
        health = store.health_check()
        self.assertTrue(health.healthy)
        self.assertEqual(health.status, "CONNECTED")

        # 403 insufficientPermissions -> DrivePermissionError (non-retryable)
        server.injected_failures.append(
            (
                "GET https://www.googleapis.com/drive/v3/about",
                _FakeResponse(403, json_data={"error": {"errors": [{"reason": "insufficientFilePermissions"}]}}),
            )
        )
        with self.assertRaises(DrivePermissionError):
            store.quota_check()

        # 403 rateLimitExceeded exhausted -> DriveRateLimitError
        for _ in range(5):
            server.injected_failures.append(
                (
                    "GET https://www.googleapis.com/drive/v3/about",
                    _FakeResponse(403, json_data={"error": {"errors": [{"reason": "userRateLimitExceeded"}]}}),
                )
            )
        with self.assertRaises(DriveRateLimitError):
            store.quota_check()

        # Revoked refresh token -> DriveAuthError(token_revoked=True), callback fired, never leaks token
        server.token_revoked = True
        server.valid_access_token = "expired-now"
        with self.assertRaises(DriveAuthError) as auth_err:
            store.quota_check()
        self.assertTrue(auth_err.exception.token_revoked)
        self.assertEqual(auth_err.exception.code, "DRIVE_TOKEN_REVOKED")
        self.assertNotIn(server.valid_refresh_token, str(auth_err.exception))
        self.assertEqual(revoked_codes, ["DRIVE_TOKEN_REVOKED"])

    def test_quota_guard_blocks_upload_and_router_never_falls_back_to_supabase(self):
        # Free Drive has only 100 MiB remaining, buffer is 512 MiB -> MUST block!
        server = InMemoryGoogleDriveServer(
            quota_limit=15 * 1024**3,
            quota_usage=15 * 1024**3 - 100 * 1024**2,
        )
        store, _ = self._build_store(server, min_free_bytes=512 * 1024**2)
        router = TrainingArtifactStoreRouter(
            drive_store_factory=lambda: store,
            write_provider=StorageProvider.GOOGLE_DRIVE,
        )
        with patch("app.services.storage_service.upload_object") as supabase_upload:
            with self.assertRaises(DriveQuotaExceededError):
                router.put("verified-samples/rev-1/line-0001.png", b"png-data")
            supabase_upload.assert_not_called()

        # Disconnected Drive also MUST raise DriveNotConnectedError and NEVER fall back to Supabase!
        disconnected_router = TrainingArtifactStoreRouter(
            drive_store_factory=lambda: None,
            write_provider=StorageProvider.GOOGLE_DRIVE,
        )
        with patch("app.services.storage_service.upload_object") as supabase_upload:
            with self.assertRaises(DriveNotConnectedError):
                disconnected_router.put("verified-samples/rev-1/line-0001.png", b"png-data")
            supabase_upload.assert_not_called()

    def test_self_test_uploads_verifies_private_downloads_and_cleans_up(self):
        server = InMemoryGoogleDriveServer()
        store, _ = self._build_store(server)
        res = store.self_test()
        self.assertTrue(res.ok)
        self.assertTrue(res.is_private)
        self.assertTrue(res.deleted_after_test)
        self.assertTrue(res.logical_path.startswith("_selftest/"))
        self.assertNotIn(res.drive_file_id, server.files)

    def test_resumable_upload_caps_401_retries_and_rejects_untrusted_location_host(self):
        # CRIT-05 / M3 regression: repeated 401 must terminate with DriveAuthError (no infinite loop)
        server = InMemoryGoogleDriveServer()
        store, _ = self._build_store(server)
        for _ in range(5):
            server.injected_failures.append(
                ("PUT https://www.googleapis.com/upload/drive/v3/resumable/", _FakeResponse(401, json_data={"error": {"message": "Auth failed"}}))
            )
        with self.assertRaises(DriveAuthError):
            store.put("verified-samples/rev-401/line-0001.png", b"png-bytes")

        # M3 regression: untrusted resumable Location URI host rejected before sending Bearer token
        server2 = InMemoryGoogleDriveServer()
        store2, _ = self._build_store(server2)
        server2.injected_failures.append(
            ("POST https://www.googleapis.com/upload/drive/v3/files", _FakeResponse(200, headers={"Location": "https://evil.example.com/steal-token"}))
        )
        with self.assertRaises(DrivePermissionError) as uri_err:
            store2.put("verified-samples/rev-uri/line-0001.png", b"png-bytes")
        self.assertEqual(uri_err.exception.code, "DRIVE_UNTRUSTED_UPLOAD_URI")

    def test_artifact_stream_route_blocks_legacy_paths_and_unauthorized_drive_ids(self):
        """C1 regression: /artifact-stream rejects Supabase paths and unauthorized Drive IDs with 403."""
        import asyncio
        from datetime import datetime, timedelta, timezone

        job_id = uuid4()
        worker_id = "colab-worker-sec"

        async def _run():
            with patch.dict(os.environ, {"VIREAD_GDRIVE_TOKEN_ENCRYPTION_KEY": "k" * 48}):
                # 1. Supabase relative path signed token -> MUST be blocked with 403
                legacy_tok = sign_worker_artifact_token(
                    job_id=str(job_id),
                    worker_id=worker_id,
                    reference="books/private-book/page-1.png",
                )
                with self.assertRaises(HTTPException) as legacy_err:
                    await admin_viread_training.stream_viread_colab_job_artifact(
                        job_id=job_id,
                        worker_id=worker_id,
                        token=legacy_tok,
                        _worker=None,
                        db=MagicMock(),
                    )
                self.assertEqual(legacy_err.exception.status_code, 403)

                # 2. Unauthorized Drive file ID -> DB check fails -> 403
                drive_tok = sign_worker_artifact_token(
                    job_id=str(job_id),
                    worker_id=worker_id,
                    reference=format_gdrive_ref("drv_unauthorized_001"),
                )
                fake_db = MagicMock()
                fake_db.rollback = AsyncMock()
                fake_db.commit = AsyncMock()

                class _FakeRepo:
                    async def one(self, sql, _params=None):
                        if "FROM public.viread_ocr_training_jobs" in sql:
                            return {
                                "id": job_id,
                                "target": "COLAB",
                                "status": "COLAB_RUNNING",
                                "worker_id": worker_id,
                                "lease_expires_at": datetime.now(timezone.utc) + timedelta(minutes=10),
                                "dataset_version_id": uuid4(),
                                "locked_test_version_id": None,
                                "parent_checkpoint_sha256": "a" * 64,
                                "run_id": None,
                            }
                        return {"is_authorized": False}

                fake_svc = MagicMock(repo=_FakeRepo())
                with patch.object(admin_viread_training, "VireadOcrTrainingService", return_value=fake_svc):
                    with self.assertRaises(HTTPException) as unauth_err:
                        await admin_viread_training.stream_viread_colab_job_artifact(
                            job_id=job_id,
                            worker_id=worker_id,
                            token=drive_tok,
                            _worker=None,
                            db=fake_db,
                        )
                self.assertEqual(unauth_err.exception.status_code, 403)

        asyncio.run(_run())

    def test_artifact_stream_route_raises_http_before_streaming_and_sets_content_length(self):
        """Transient Drive failures raise HTTPException before StreamingResponse starts."""
        import asyncio
        from datetime import datetime, timedelta, timezone
        from app.services.training_storage.base import ArtifactMetadata, DriveTransientError

        job_id = uuid4()
        worker_id = "colab-worker-stream"
        payload = b"png-verified-bytes-0123456789"
        sha = hashlib.sha256(payload).hexdigest()
        ref = format_gdrive_ref("drv_authorized_stream_001")

        class _AuthorizedRepo:
            async def one(self, sql, _params=None):
                if "FROM public.viread_ocr_training_jobs" in sql:
                    return {
                        "id": job_id,
                        "target": "COLAB",
                        "status": "COLAB_RUNNING",
                        "worker_id": worker_id,
                        "lease_expires_at": datetime.now(timezone.utc) + timedelta(minutes=10),
                        "dataset_version_id": uuid4(),
                        "locked_test_version_id": None,
                        "parent_checkpoint_sha256": "a" * 64,
                        "run_id": None,
                    }
                return {"is_authorized": True}

        async def _run():
            with patch.dict(
                os.environ,
                {
                    "VIREAD_GDRIVE_TOKEN_ENCRYPTION_KEY": "k" * 48,
                    "VIREAD_ARTIFACT_STREAM_SIGNING_SECRET": "s" * 48,
                },
            ):
                tok = sign_worker_artifact_token(
                    job_id=str(job_id),
                    worker_id=worker_id,
                    reference=ref,
                    expected_sha256=sha,
                )

                def _make_fake_db():
                    fake_db = MagicMock()
                    fake_db.rollback = AsyncMock()
                    fake_db.commit = AsyncMock()
                    return fake_db

                fake_svc = MagicMock(repo=_AuthorizedRepo())

                # 1. Transient/rate-limit upstream error fails BEFORE StreamingResponse 200
                failing_router = MagicMock()
                failing_router.open_stream_with_metadata.side_effect = DriveTransientError(
                    "Apps Script bridge HTTP 503",
                    http_status=503,
                )
                failing_drive_svc = MagicMock()
                failing_drive_svc.build_artifact_router = AsyncMock(return_value=failing_router)
                with (
                    patch.object(admin_viread_training, "VireadOcrTrainingService", return_value=fake_svc),
                    patch.object(admin_viread_training, "VireadDriveConnectionService", return_value=failing_drive_svc),
                ):
                    with self.assertRaises(HTTPException) as err_503:
                        await admin_viread_training.stream_viread_colab_job_artifact(
                            job_id=job_id,
                            worker_id=worker_id,
                            token=tok,
                            _worker=None,
                            db=_make_fake_db(),
                        )
                self.assertEqual(err_503.exception.status_code, 503)

                rate_router = MagicMock()
                rate_router.open_stream_with_metadata.side_effect = DriveRateLimitError("Rate limited")
                rate_drive_svc = MagicMock()
                rate_drive_svc.build_artifact_router = AsyncMock(return_value=rate_router)
                with (
                    patch.object(admin_viread_training, "VireadOcrTrainingService", return_value=fake_svc),
                    patch.object(admin_viread_training, "VireadDriveConnectionService", return_value=rate_drive_svc),
                ):
                    with self.assertRaises(HTTPException) as err_429:
                        await admin_viread_training.stream_viread_colab_job_artifact(
                            job_id=job_id,
                            worker_id=worker_id,
                            token=tok,
                            _worker=None,
                            db=_make_fake_db(),
                        )
                self.assertEqual(err_429.exception.status_code, 429)

                # 2. Successful eager open includes Content-Length & X-ViRead-SHA256 headers
                ok_meta = ArtifactMetadata(
                    provider=StorageProvider.GOOGLE_DRIVE,
                    reference=ref,
                    name="line-0001.png",
                    size_bytes=len(payload),
                    sha256=sha,
                    content_type="image/png",
                    trashed=False,
                    is_public=False,
                    drive_file_id="drv_authorized_stream_001",
                )
                ok_router = MagicMock()
                ok_router.open_stream_with_metadata.return_value = (ok_meta, iter([payload]))
                ok_drive_svc = MagicMock()
                ok_drive_svc.build_artifact_router = AsyncMock(return_value=ok_router)
                with (
                    patch.object(admin_viread_training, "VireadOcrTrainingService", return_value=fake_svc),
                    patch.object(admin_viread_training, "VireadDriveConnectionService", return_value=ok_drive_svc),
                ):
                    resp = await admin_viread_training.stream_viread_colab_job_artifact(
                        job_id=job_id,
                        worker_id=worker_id,
                        token=tok,
                        _worker=None,
                        db=_make_fake_db(),
                    )
                self.assertEqual(resp.headers.get("content-length"), str(len(payload)))
                self.assertEqual(resp.headers.get("x-viread-sha256"), sha)
                chunks = []
                async for part in resp.body_iterator:
                    chunks.append(part)
                self.assertEqual(b"".join(chunks), payload)

                # Default stream token TTL is extended to 2 hours (7200s) for large Colab downloads
                import time as _time
                from app.services.training_storage.router import DEFAULT_WORKER_STREAM_TOKEN_TTL

                self.assertEqual(DEFAULT_WORKER_STREAM_TOKEN_TTL, 7200)
                before_sign = int(_time.time())
                default_tok = sign_worker_artifact_token(
                    job_id=str(job_id),
                    worker_id=worker_id,
                    reference=ref,
                    expected_sha256=sha,
                )
                claims = verify_worker_artifact_token(
                    default_tok,
                    expected_job_id=str(job_id),
                    expected_worker_id=worker_id,
                    now_ts=before_sign,
                )
                self.assertGreaterEqual(claims.expires_at - before_sign, 7190)
                self.assertLessEqual(claims.expires_at - before_sign, 7210)

        asyncio.run(_run())

    def test_non_admin_is_blocked_from_drive_routes(self):
        async def _run():
            fake_db = MagicMock()
            with patch.object(
                admin_viread_training.VireadOcrTrainingService,
                "_admin",
                new=AsyncMock(side_effect=HTTPException(status_code=403, detail="Admin access required")),
            ):
                with self.assertRaises(HTTPException) as err:
                    await admin_viread_training.get_viread_training_drive_status(
                        actor_id=uuid4(), db=fake_db
                    )
                self.assertEqual(err.exception.status_code, 403)

        import asyncio
        asyncio.run(_run())

    def test_required_account_email_pinning_adds_login_hint_and_rejects_wrong_gmail(self):
        import asyncio
        from app.services.training_storage.google_drive_oauth import load_oauth_config
        from app.services.viread_drive_connection_service import VireadDriveConnectionService

        server = InMemoryGoogleDriveServer()
        server.account_email = "wrong.colab.account@gmail.com"
        env = {
            "VIREAD_GDRIVE_OAUTH_CLIENT_ID": "test-client-id.apps.googleusercontent.com",
            "VIREAD_GDRIVE_OAUTH_CLIENT_SECRET": "test-client-secret",
            "VIREAD_GDRIVE_OAUTH_REDIRECT_URI": "http://localhost:3000/admin/viread-training",
            "VIREAD_GDRIVE_TOKEN_ENCRYPTION_KEY": "e" * 48,
            "VIREAD_GDRIVE_REQUIRED_ACCOUNT_EMAIL": "cuongtran290605@gmail.com",
        }
        with patch.dict(os.environ, env, clear=False):
            cfg = load_oauth_config()
            self.assertEqual(cfg.required_account_email, "cuongtran290605@gmail.com")
            started = create_oauth_authorization(cfg, actor_id=str(uuid4()))
            self.assertIn("login_hint=cuongtran290605%40gmail.com", started.authorization_url)

            async def _run_wrong_email():
                from app.services.training_storage.google_drive_oauth import OAuthTokenBundle
                fake_db = MagicMock()
                svc = VireadDriveConnectionService(fake_db, session=server.make_session())
                svc.repo = MagicMock()
                svc.repo.get_primary = AsyncMock(return_value=(None, True))
                svc.repo.upsert_connected = AsyncMock()
                actor_id = uuid4()
                start_res = await svc.start_connect(actor_id=actor_id)
                from urllib.parse import parse_qs, urlsplit
                state_val = parse_qs(urlsplit(start_res["authorization_url"]).query)["state"][0]
                fake_tokens = OAuthTokenBundle(
                    access_token=server.valid_access_token,
                    refresh_token="wrong-account-refresh-token",
                    expires_in=3600,
                    scope=GOOGLE_DRIVE_REQUIRED_SCOPE,
                    token_type="Bearer",
                )
                with (
                    patch(
                        "app.services.viread_drive_connection_service.exchange_authorization_code",
                        return_value=fake_tokens,
                    ),
                    patch(
                        "app.services.viread_drive_connection_service.revoke_token",
                        return_value=True,
                    ) as mock_revoke,
                ):
                    with self.assertRaises(HTTPException) as mismatch_err:
                        await svc.complete_callback(actor_id=actor_id, code="valid-auth-code", state=state_val)
                    self.assertEqual(mismatch_err.exception.status_code, 403)
                    self.assertIn("DRIVE_ACCOUNT_EMAIL_MISMATCH", str(mismatch_err.exception.detail))
                    mock_revoke.assert_called_once()
                    svc.repo.upsert_connected.assert_not_called()

            asyncio.run(_run_wrong_email())

    def test_drive_resume_files_list_put_atomic_replace_stream_and_delete(self):
        server = InMemoryGoogleDriveServer()
        store, _ = self._build_store(server)
        job_id = str(uuid4())
        blob_payload = b"epoch-1-weights-payload"
        blob_sha = hashlib.sha256(blob_payload).hexdigest()
        stored_blob = store.put_resume_file(job_id, f"blobs/{blob_sha}", blob_payload, expected_sha256=blob_sha)
        self.assertEqual(stored_blob.sha256, blob_sha)

        manifest_v1 = b'{"schema":"viread-colab-resume-v1","v":1}'
        m1 = store.put_resume_file(job_id, "resume-manifest.json", manifest_v1, content_type="application/json")
        manifest_v2 = b'{"schema":"viread-colab-resume-v1","v":2}'
        m2 = store.put_resume_file(job_id, "resume-manifest.json", manifest_v2, content_type="application/json")
        self.assertNotEqual(m1.drive_file_id, m2.drive_file_id)
        # Superseded manifest copy was pruned after new manifest committed
        self.assertNotIn(m1.drive_file_id, server.files)

        listed = {item["name"]: item for item in store.list_resume_files(job_id)}
        self.assertIn("resume-manifest.json", listed)
        self.assertIn(f"blobs/{blob_sha}", listed)

        meta, stream = store.open_resume_file_stream(job_id, f"blobs/{blob_sha}", expected_sha256=blob_sha)
        self.assertEqual(meta.size_bytes, len(blob_payload))
        self.assertEqual(b"".join(stream), blob_payload)

        self.assertTrue(store.delete_resume_file(job_id, f"blobs/{blob_sha}"))
        listed_after = {item["name"] for item in store.list_resume_files(job_id)}
        self.assertNotIn(f"blobs/{blob_sha}", listed_after)


class InMemoryAppsScriptBridgeServer:
    """In-memory emulator of scripts/google-apps-script/viread_flow2_drive_bridge.gs."""

    def __init__(self, *, secret: str, account_email: str = "cuongtran290605@gmail.com") -> None:
        self.secret = secret
        self.account_email = account_email
        self.limit_bytes = 15 * 1024 * 1024 * 1024
        self.usage_bytes = 2 * 1024 * 1024 * 1024
        self.root_folder_id = "drv_gas_root_000001"
        self.subfolder_ids = {
            "verified-samples": "drv_gas_sub_samples_01",
            "datasets": "drv_gas_sub_datasets_01",
            "locked-tests": "drv_gas_sub_locked_01",
            "checkpoints": "drv_gas_sub_ckpts_01",
            "resume": "drv_gas_sub_resume_01",
            "benchmarks": "drv_gas_sub_bench_01",
            "audit": "drv_gas_sub_audit_01",
            "_selftest": "drv_gas_sub_self_01",
        }
        self.files: dict[str, dict] = {}
        self.force_html_login = False
        self._seq = 0

    def _next_id(self) -> str:
        self._seq += 1
        return f"drv_gas_file_{self._seq:06d}"

    def make_session(self) -> MagicMock:
        import base64 as _b64
        import hmac as _hmac

        sess = MagicMock()

        def _post(_url, json=None, **_kwargs):
            if self.force_html_login:
                resp = MagicMock()
                resp.status_code = 200
                resp.headers = {"Content-Type": "text/html; charset=utf-8"}
                resp.text = "<html><title>Sign in - Google Accounts</title>accounts.google.com/ServiceLogin</html>"
                resp.close = MagicMock()
                return resp

            env = json or {}
            action = str(env.get("action") or "")
            ts = int(env.get("ts") or 0)
            sig = str(env.get("sig") or "")
            payload_json = str(env.get("payload_json") or "{}")
            expected_sig = _hmac.new(
                self.secret.encode("utf-8"),
                f"{ts}:{action}:{hashlib.sha256(payload_json.encode('utf-8')).hexdigest()}".encode("utf-8"),
                hashlib.sha256,
            ).hexdigest()
            if not _hmac.compare_digest(sig, expected_sig):
                return self._json_resp({"ok": False, "error_code": "DRIVE_AUTH_FAILED", "message": "Invalid signature"})

            import json as _json

            payload = _json.loads(payload_json)
            if action == "health":
                return self._json_resp(
                    {
                        "ok": True,
                        "account_email": self.account_email,
                        "account_display_name": self.account_email.split("@")[0],
                        "root_folder_id": self.root_folder_id,
                        "subfolder_ids": dict(self.subfolder_ids),
                        "quota": {"limit_bytes": self.limit_bytes, "usage_bytes": self.usage_bytes, "usage_in_drive_bytes": self.usage_bytes, "usage_in_trash_bytes": None},
                    }
                )
            if action == "quota":
                return self._json_resp(
                    {
                        "ok": True,
                        "quota": {"limit_bytes": self.limit_bytes, "usage_bytes": self.usage_bytes, "usage_in_drive_bytes": self.usage_bytes, "usage_in_trash_bytes": None},
                    }
                )
            if action in {"put_file", "put_resume_file"}:
                raw = _b64.b64decode(payload.get("content_b64") or "")
                sha = hashlib.sha256(raw).hexdigest()
                lpath = payload["logical_path"]
                meta = payload.get("metadata") or {}
                is_chunked = bool(meta.get("viread_chunked_v1"))
                if action == "put_resume_file":
                    for fid, fobj in list(self.files.items()):
                        if not fobj["trashed"] and fobj["logical_path"] == lpath:
                            fobj["trashed"] = True
                fid = self._next_id()
                self.files[fid] = {
                    "file_id": fid,
                    "name": lpath.rsplit("/", 1)[-1],
                    "logical_path": lpath,
                    "content": raw,
                    "size_bytes": int(meta.get("viread_logical_size") or len(raw)) if is_chunked else len(raw),
                    "sha256": str(meta.get("viread_logical_sha256") or sha),
                    "content_type": str(meta.get("viread_logical_content_type") or payload.get("content_type") or "application/octet-stream"),
                    "trashed": False,
                    "is_public": False,
                    "is_chunked": is_chunked,
                    "extra": dict(meta),
                }
                self.usage_bytes += len(raw)
                return self._json_resp({"ok": True, "deduplicated": False, "file": self._pub(self.files[fid])})
            if action == "get_metadata":
                fobj = self.files.get(payload["file_id"])
                if not fobj or fobj["trashed"]:
                    return self._json_resp({"ok": False, "error_code": "DRIVE_OBJECT_NOT_FOUND", "message": "Not found"})
                return self._json_resp({"ok": True, "file": self._pub(fobj)})
            if action == "get_file":
                fobj = self.files.get(payload["file_id"])
                if not fobj or fobj["trashed"]:
                    return self._json_resp({"ok": False, "error_code": "DRIVE_OBJECT_NOT_FOUND", "message": "Not found"})
                return self._json_resp({"ok": True, "file": self._pub(fobj), "content_b64": _b64.b64encode(fobj["content"]).decode("ascii")})
            if action == "delete_file":
                fobj = self.files.get(payload["file_id"])
                if not fobj or fobj["trashed"]:
                    return self._json_resp({"ok": True, "deleted": False})
                if fobj["is_chunked"]:
                    manifest = _json.loads(fobj["content"].decode("utf-8"))
                    for part in manifest.get("parts") or []:
                        p = self.files.get(part["file_id"])
                        if p:
                            p["trashed"] = True
                fobj["trashed"] = True
                return self._json_resp({"ok": True, "deleted": True})
            if action == "list_resume_files":
                prefix = f"resume/jobs/{payload['job_id']}/"
                items = []
                for fobj in self.files.values():
                    if not fobj["trashed"] and fobj["logical_path"].startswith(prefix):
                        items.append(
                            {
                                "name": fobj["logical_path"][len(prefix) :],
                                "drive_file_id": fobj["file_id"],
                                "size_bytes": fobj["size_bytes"],
                                "sha256": fobj["sha256"],
                            }
                        )
                return self._json_resp({"ok": True, "files": items})
            if action == "get_resume_file_meta":
                lpath = payload["logical_path"]
                for fobj in self.files.values():
                    if not fobj["trashed"] and fobj["logical_path"] == lpath:
                        return self._json_resp({"ok": True, "file": self._pub(fobj)})
                return self._json_resp({"ok": False, "error_code": "DRIVE_OBJECT_NOT_FOUND", "message": "Not found"})
            if action == "delete_resume_file":
                lpath = payload["logical_path"]
                deleted = False
                for fobj in self.files.values():
                    if not fobj["trashed"] and fobj["logical_path"] == lpath:
                        fobj["trashed"] = True
                        deleted = True
                return self._json_resp({"ok": True, "deleted": deleted})
            return self._json_resp({"ok": False, "error_code": "UNKNOWN_ACTION", "message": action})

        sess.post = MagicMock(side_effect=_post)
        return sess

    @staticmethod
    def _pub(fobj: dict) -> dict:
        return {k: v for k, v in fobj.items() if k != "content"}

    @staticmethod
    def _json_resp(payload: dict) -> MagicMock:
        import json as _json

        resp = MagicMock()
        resp.status_code = 200
        resp.headers = {"Content-Type": "application/json"}
        resp.text = _json.dumps(payload)
        resp.close = MagicMock()
        return resp


class TestAppsScriptDriveBridge(unittest.TestCase):
    VALID_URL = "https://script.google.com/macros/s/AKfycbzViReadFlow2BridgeDeployment0123456789/exec"
    SECRET = "s" * 48

    def test_small_large_chunked_self_test_resume_and_error_handling(self):
        from app.services.training_storage.google_apps_script_store import GoogleAppsScriptDriveStore

        server = InMemoryAppsScriptBridgeServer(secret=self.SECRET)
        store = GoogleAppsScriptDriveStore(
            web_app_url=self.VALID_URL,
            bridge_secret=self.SECRET,
            session=server.make_session(),
            chunk_bytes=64 * 1024,
            sleep_fn=lambda _s: None,
        )

        # 1. Health & self-test
        health = store.health_check()
        self.assertTrue(health.healthy)
        self.assertEqual(health.account_email, "cuongtran290605@gmail.com")
        self_test = store.self_test()
        self.assertTrue(self_test.ok)
        self.assertTrue(self_test.is_private)
        self.assertTrue(self_test.deleted_after_test)

        # 2. Large file (> 64 KiB chunk size) transparently chunks and streams back with SHA-256 verification
        large_payload = os.urandom(150 * 1024)
        large_sha = hashlib.sha256(large_payload).hexdigest()
        stored = store.put(
            "checkpoints/runs/run-1/candidate.pth",
            large_payload,
            content_type="application/octet-stream",
            expected_sha256=large_sha,
        )
        self.assertTrue(stored.reference.startswith("gdrive://"))
        self.assertEqual(stored.metadata.get("chunked_parts"), 3)
        meta = store.get_metadata(stored.reference)
        self.assertEqual(meta.size_bytes, len(large_payload))
        self.assertEqual(meta.sha256, large_sha)
        downloaded = b"".join(store.open_stream(stored.reference, expected_sha256=large_sha))
        self.assertEqual(downloaded, large_payload)
        self.assertTrue(store.delete_if_unreferenced(stored.reference, is_referenced_check=lambda _r: False))
        self.assertFalse(store.exists(stored.reference))

        # 3. Cross-account Colab resume state over Apps Script Bridge
        job_id = str(uuid4())
        resume_blob = b"resume-checkpoint-part-0"
        resume_sha = hashlib.sha256(resume_blob).hexdigest()
        store.put_resume_file(job_id, f"blobs/{resume_sha}.part0000", resume_blob, expected_sha256=resume_sha)
        store.put_resume_file(job_id, "resume-manifest.json", b'{"v":1}', content_type="application/json")
        store.put_resume_file(job_id, "resume-manifest.json", b'{"v":2}', content_type="application/json")
        listed = {f["name"]: f for f in store.list_resume_files(job_id)}
        self.assertIn("resume-manifest.json", listed)
        self.assertIn(f"blobs/{resume_sha}.part0000", listed)
        rmeta, rstream = store.open_resume_file_stream(job_id, "resume-manifest.json")
        self.assertEqual(b"".join(rstream), b'{"v":2}')
        self.assertEqual(rmeta.size_bytes, 7)
        self.assertTrue(store.delete_resume_file(job_id, f"blobs/{resume_sha}.part0000"))

        # 4. HTML Google Sign-In response raises clear DRIVE_BRIDGE_ACCESS_DENIED
        server.force_html_login = True
        with self.assertRaises(DrivePermissionError) as html_err:
            store.quota_check()
        self.assertEqual(html_err.exception.code, "DRIVE_BRIDGE_ACCESS_DENIED")

    def test_retries_transient_bridge_error_and_caches_quota_within_safe_ttl(self):
        from app.services.training_storage.base import DrivePermissionError
        from app.services.training_storage.google_apps_script_store import GoogleAppsScriptDriveStore

        server = InMemoryAppsScriptBridgeServer(secret=self.SECRET)
        raw_session = server.make_session()
        raw_post = raw_session.post
        action_log: list[str] = []
        put_failures_left = {"count": 2}
        force_fatal = {"active": False}

        def _post_with_faults(*args, **kwargs):
            envelope = kwargs.get("json") or {}
            action = str(envelope.get("action") or "")
            action_log.append(action)
            if action == "put_file" and force_fatal["active"]:
                return InMemoryAppsScriptBridgeServer._json_resp(
                    {"ok": False, "error_code": "DRIVE_PERMISSION_DENIED", "message": "Forbidden"}
                )
            if action == "put_file" and put_failures_left["count"] > 0:
                put_failures_left["count"] -= 1
                return InMemoryAppsScriptBridgeServer._json_resp(
                    {"ok": False, "error_code": "DRIVE_BRIDGE_ERROR", "message": "Temporary lock busy"}
                )
            return raw_post(*args, **kwargs)

        raw_session.post = _post_with_faults
        now_clock = {"t": 100.0}
        with patch("app.services.training_storage.google_apps_script_store.time.monotonic", side_effect=lambda: now_clock["t"]):
            store = GoogleAppsScriptDriveStore(
                web_app_url=self.VALID_URL,
                bridge_secret=self.SECRET,
                session=raw_session,
                max_retries=3,
                sleep_fn=lambda _s: None,
            )
            p1 = b"first-line-image"
            p2 = b"second-line-image"
            s1 = store.put("verified-samples/g1/line-0.png", p1, content_type="image/png", expected_sha256=hashlib.sha256(p1).hexdigest())
            self.assertTrue(s1.reference.startswith("gdrive://"))
            # 1 quota call + 3 put_file attempts (2 transient DRIVE_BRIDGE_ERROR + 1 ok)
            self.assertEqual(action_log.count("quota"), 1)
            self.assertEqual(action_log.count("put_file"), 3)

            # Second put within 45s TTL and > 500 MiB free MUST reuse cached quota (no extra quota RPC)
            now_clock["t"] = 120.0
            store.put("verified-samples/g1/line-1.png", p2, content_type="image/png", expected_sha256=hashlib.sha256(p2).hexdigest())
            self.assertEqual(action_log.count("quota"), 1)

            # Advancing past 45s TTL refreshes quota
            now_clock["t"] = 150.0
            p3 = b"third-line-image"
            store.put("verified-samples/g1/line-2.png", p3, content_type="image/png", expected_sha256=hashlib.sha256(p3).hexdigest())
            self.assertEqual(action_log.count("quota"), 2)

            # Fatal permission error MUST fail immediately with 0 retries
            force_fatal["active"] = True
            puts_before = action_log.count("put_file")
            with self.assertRaises(DrivePermissionError):
                store.put("verified-samples/g1/line-3.png", b"x", content_type="image/png")
            self.assertEqual(action_log.count("put_file") - puts_before, 1)

    def test_open_stream_with_metadata_single_call_eager_validation(self):
        from app.services.training_storage.google_apps_script_store import GoogleAppsScriptDriveStore

        server = InMemoryAppsScriptBridgeServer(secret=self.SECRET)
        session = server.make_session()
        raw_post = session.post
        recorded_actions: list[str] = []

        def _spied_post(*args, **kwargs):
            envelope = kwargs.get("json") or {}
            recorded_actions.append(str(envelope.get("action") or ""))
            return raw_post(*args, **kwargs)

        session.post = _spied_post
        store = GoogleAppsScriptDriveStore(
            web_app_url=self.VALID_URL,
            bridge_secret=self.SECRET,
            session=session,
            chunk_bytes=64 * 1024,
            sleep_fn=lambda _s: None,
        )
        router = TrainingArtifactStoreRouter(drive_store_factory=lambda: store)

        small_data = b"flow2-line-image-bytes"
        small_sha = hashlib.sha256(small_data).hexdigest()
        s_small = store.put("verified-samples/p1/line-0.png", small_data, content_type="image/png", expected_sha256=small_sha)

        recorded_actions.clear()
        meta, stream = router.open_stream_with_metadata(s_small.reference, expected_sha256=small_sha)
        self.assertEqual(recorded_actions, ["get_file"])
        self.assertEqual(meta.size_bytes, len(small_data))
        self.assertEqual(meta.sha256, small_sha)
        self.assertEqual(b"".join(stream), small_data)

        # SHA mismatch fails eagerly BEFORE returning stream iterator
        with self.assertRaises(DriveIntegrityError):
            router.open_stream_with_metadata(s_small.reference, expected_sha256="f" * 64)

        # Chunked file (> 64 KiB) streams cleanly with full logical size
        large_payload = os.urandom(140 * 1024)
        large_sha = hashlib.sha256(large_payload).hexdigest()
        s_large = store.put("checkpoints/runs/run-2/candidate.pth", large_payload, expected_sha256=large_sha)
        l_meta, l_stream = router.open_stream_with_metadata(s_large.reference, expected_sha256=large_sha)
        self.assertEqual(l_meta.size_bytes, len(large_payload))
        self.assertEqual(b"".join(l_stream), large_payload)

        # Public sharing & trashed files rejected eagerly
        server.files[s_small.drive_file_id]["is_public"] = True
        with self.assertRaises(DrivePermissionError):
            router.open_stream_with_metadata(s_small.reference)
        server.files[s_small.drive_file_id]["is_public"] = False
        server.files[s_small.drive_file_id]["trashed"] = True
        with self.assertRaises(DriveNotFoundError):
            router.open_stream_with_metadata(s_small.reference)

    def test_connect_apps_script_enforces_owner_email_and_hydrates_without_oauth_env(self):
        import asyncio
        from app.services.training_storage.google_apps_script_store import (
            APPS_SCRIPT_BRIDGE_SCOPE,
            GoogleAppsScriptDriveStore,
        )
        from app.services.viread_drive_connection_service import (
            VireadDriveConnectionService,
            build_google_drive_store_from_row,
            invalidate_sync_google_drive_store_cache,
        )

        invalidate_sync_google_drive_store_cache()
        env = {
            "VIREAD_GDRIVE_TOKEN_ENCRYPTION_KEY": "e" * 48,
            "VIREAD_GDRIVE_APPS_SCRIPT_SECRET": self.SECRET,
            "VIREAD_GDRIVE_REQUIRED_ACCOUNT_EMAIL": "cuongtran290605@gmail.com",
            "VIREAD_GDRIVE_OAUTH_CLIENT_ID": "",
            "VIREAD_GDRIVE_OAUTH_CLIENT_SECRET": "",
        }
        with patch.dict(os.environ, env, clear=False):
            # Wrong owner Gmail MUST be rejected with 403 DRIVE_ACCOUNT_EMAIL_MISMATCH
            wrong_server = InMemoryAppsScriptBridgeServer(secret=self.SECRET, account_email="other.acc@gmail.com")
            svc_wrong = VireadDriveConnectionService(MagicMock(), session=wrong_server.make_session())
            svc_wrong.repo = MagicMock()
            svc_wrong.repo.get_primary = AsyncMock(return_value=(None, True))
            svc_wrong.repo.upsert_connected = AsyncMock()
            with self.assertRaises(HTTPException) as mismatch:
                asyncio.run(
                    svc_wrong.connect_apps_script(actor_id=uuid4(), web_app_url=self.VALID_URL)
                )
            self.assertEqual(mismatch.exception.status_code, 403)
            self.assertIn("DRIVE_ACCOUNT_EMAIL_MISMATCH", str(mismatch.exception.detail))
            svc_wrong.repo.upsert_connected.assert_not_called()

            # Correct owner Gmail succeeds and DB row hydrates GoogleAppsScriptDriveStore with zero OAuth vars!
            ok_server = InMemoryAppsScriptBridgeServer(secret=self.SECRET, account_email="cuongtran290605@gmail.com")
            saved_rows: list[dict] = []

            async def _fake_upsert(**kwargs):
                row = {"status": "CONNECTED", **kwargs}
                saved_rows.append(row)
                return row

            svc_ok = VireadDriveConnectionService(MagicMock(), session=ok_server.make_session())
            svc_ok.repo = MagicMock()
            svc_ok.repo.get_primary = AsyncMock(return_value=(None, True))
            svc_ok.repo.upsert_connected = AsyncMock(side_effect=_fake_upsert)
            status = asyncio.run(svc_ok.connect_apps_script(actor_id=uuid4(), web_app_url=self.VALID_URL))
            self.assertTrue(status["connected"])
            self.assertEqual(status["connection_mode"], "apps_script_bridge")
            self.assertEqual(status["account_email"], "cuongtran290605@gmail.com")
            self.assertTrue(status["scope_valid"])
            self.assertEqual(saved_rows[0]["oauth_scope"], APPS_SCRIPT_BRIDGE_SCOPE)

            rebuilt = build_google_drive_store_from_row(
                saved_rows[0],
                session=ok_server.make_session(),
                use_warm_cache=False,
            )
            self.assertIsInstance(rebuilt, GoogleAppsScriptDriveStore)
            self.assertTrue(rebuilt.health_check().healthy)


class TestGoogleDriveDesktopStore(unittest.TestCase):
    def test_put_dedup_stream_selftest_resume_and_connect_with_owner_pinning(self):
        import asyncio
        import tempfile
        from types import SimpleNamespace
        from app.services.training_storage.google_drive_desktop_store import (
            DRIVE_DESKTOP_SYNC_SCOPE,
            GoogleDriveDesktopStore,
        )
        from app.services.viread_drive_connection_service import (
            VireadDriveConnectionService,
            build_google_drive_store_from_row,
            invalidate_sync_google_drive_store_cache,
        )

        invalidate_sync_google_drive_store_cache()
        fake_disk_usage = SimpleNamespace(
            total=20 * 1024 * 1024 * 1024,
            used=5 * 1024 * 1024 * 1024,
            free=15 * 1024 * 1024 * 1024,
        )
        with tempfile.TemporaryDirectory() as tmpdir:
            my_drive = Path(tmpdir) / "My Drive"
            my_drive.mkdir()
            env = {
                "VIREAD_GDRIVE_TOKEN_ENCRYPTION_KEY": "e" * 48,
                "VIREAD_GDRIVE_REQUIRED_ACCOUNT_EMAIL": "cuongtran290605@gmail.com",
                "VIREAD_GDRIVE_OAUTH_CLIENT_ID": "",
                "VIREAD_GDRIVE_OAUTH_CLIENT_SECRET": "",
                "VIREAD_GDRIVE_DESKTOP_ALLOWED_ROOTS": str(tmpdir),
            }
            with patch.dict(os.environ, env, clear=False), patch(
                "app.services.training_storage.google_drive_desktop_store.shutil.disk_usage",
                return_value=fake_disk_usage,
            ):
                # Wrong owner email rejected with 403
                svc_bad = VireadDriveConnectionService(MagicMock())
                svc_bad.repo = MagicMock()
                svc_bad.repo.get_primary = AsyncMock(return_value=(None, True))
                svc_bad.repo.upsert_connected = AsyncMock()
                with self.assertRaises(HTTPException) as bad_err:
                    asyncio.run(
                        svc_bad.connect_drive_desktop(
                            actor_id=uuid4(),
                            sync_root_path=str(my_drive),
                            account_email="wrong@gmail.com",
                        )
                    )
                self.assertEqual(bad_err.exception.status_code, 403)
                self.assertIn("DRIVE_ACCOUNT_EMAIL_MISMATCH", str(bad_err.exception.detail))

                # Valid owner connects, creates Flow2 folders, and hydrates cleanly
                saved_rows: list[dict] = []

                async def _fake_upsert(**kwargs):
                    row = {"status": "CONNECTED", **kwargs}
                    saved_rows.append(row)
                    return row

                svc_ok = VireadDriveConnectionService(MagicMock())
                svc_ok.repo = MagicMock()
                svc_ok.repo.get_primary = AsyncMock(return_value=(None, True))
                svc_ok.repo.upsert_connected = AsyncMock(side_effect=_fake_upsert)
                status = asyncio.run(
                    svc_ok.connect_drive_desktop(
                        actor_id=uuid4(),
                        sync_root_path=str(my_drive),
                        account_email="cuongtran290605@gmail.com",
                    )
                )
                self.assertTrue(status["connected"])
                self.assertEqual(status["connection_mode"], "drive_desktop_sync")
                self.assertEqual(status["account_email"], "cuongtran290605@gmail.com")
                self.assertEqual(saved_rows[0]["oauth_scope"], DRIVE_DESKTOP_SYNC_SCOPE)

                store = build_google_drive_store_from_row(saved_rows[0], use_warm_cache=False)
                self.assertIsInstance(store, GoogleDriveDesktopStore)
                self.assertTrue(store.self_test().ok)

                # Put + dedup + stream + delete_if_unreferenced
                data = b"vietnamese-ocr-crop-bytes-001"
                sha = hashlib.sha256(data).hexdigest()
                s1 = store.put("verified-samples/rev-1/line-0001.png", data, content_type="image/png", expected_sha256=sha)
                s2 = store.put("verified-samples/rev-1/line-0001.png", data, content_type="image/png", expected_sha256=sha)
                self.assertTrue(s2.deduplicated)
                self.assertEqual(s1.reference, s2.reference)
                self.assertEqual(b"".join(store.open_stream(s1.reference, expected_sha256=sha)), data)
                self.assertFalse(store.delete_if_unreferenced(s1.reference, is_referenced_check=lambda _r: True))
                self.assertTrue(store.delete_if_unreferenced(s1.reference, is_referenced_check=lambda _r: False))
                self.assertFalse(store.exists(s1.reference))

                # Cross-account Colab resume state round-trip
                job_id = str(uuid4())
                blob = b"colab-checkpoint-part-0000"
                bsha = hashlib.sha256(blob).hexdigest()
                store.put_resume_file(job_id, f"blobs/{bsha}.part0000", blob, expected_sha256=bsha)
                store.put_resume_file(job_id, "resume-manifest.json", b'{"step":5}', content_type="application/json")
                listed = {f["name"]: f for f in store.list_resume_files(job_id)}
                self.assertIn("resume-manifest.json", listed)
                self.assertIn(f"blobs/{bsha}.part0000", listed)
                rmeta, rstream = store.open_resume_file_stream(job_id, f"blobs/{bsha}.part0000", expected_sha256=bsha)
                self.assertEqual(rmeta.size_bytes, len(blob))
                self.assertEqual(b"".join(rstream), blob)
                self.assertTrue(store.delete_resume_file(job_id, f"blobs/{bsha}.part0000"))

    def test_apps_script_bridge_surfaces_trash_fallback_telemetry_and_warning(self):
        import asyncio
        from app.services.training_storage.google_apps_script_store import GoogleAppsScriptDriveStore
        from app.services.training_storage.base import StorageQuotaStatus
        from app.services.viread_drive_connection_service import VireadDriveConnectionService

        store = GoogleAppsScriptDriveStore(
            web_app_url="https://script.google.com/macros/s/AKfycbzTestDeployment0123456789/exec",
            bridge_secret="s" * 40,
        )

        def fake_bridge(action: str, payload=None):
            if action == "health":
                return {
                    "ok": True,
                    "account_email": "owner@example.com",
                    "root_folder_id": "drv_root_12345",
                    "subfolder_ids": {"_selftest": "drv_sub_12345"},
                    "quota": {"limit_bytes": 15 * 1024**3, "usage_bytes": 1024},
                    "advanced_drive_enabled": False,
                    "delete_mode": "trash_fallback",
                }
            if action == "delete_file":
                return {
                    "ok": True,
                    "deleted": True,
                    "delete_mode": "trash_fallback",
                    "permanent_delete": False,
                    "trashed_fallback": True,
                }
            if action == "quota":
                return {"ok": True, "quota": {"limit_bytes": 15 * 1024**3, "usage_bytes": 1024}}
            raise AssertionError(f"Unexpected action {action}")

        with patch.object(store, "_call_bridge", side_effect=fake_bridge):
            health = store.health_check()
            self.assertFalse(health.advanced_drive_enabled)
            self.assertEqual(health.delete_mode, "trash_fallback")
            self.assertTrue(health.warnings)

            from app.services.training_storage.base import ArtifactMetadata, StoredArtifact
            from app.services.training_storage.references import StorageProvider

            captured_payload: list[bytes] = []

            def _fake_put(_path, data, **_kwargs):
                raw = data if isinstance(data, bytes) else data.read()
                captured_payload.append(raw)
                return StoredArtifact(
                    provider=StorageProvider.GOOGLE_DRIVE,
                    reference="gdrive://drv_selftest_12345",
                    logical_path=_path,
                    sha256=hashlib.sha256(raw).hexdigest(),
                    size_bytes=len(raw),
                    content_type="text/plain",
                    drive_file_id="drv_selftest_12345",
                )

            fake_meta = ArtifactMetadata(
                provider=StorageProvider.GOOGLE_DRIVE,
                reference="gdrive://drv_selftest_12345",
                name="selftest-1.txt",
                size_bytes=10,
                sha256="a" * 64,
                content_type="text/plain",
                trashed=False,
                is_public=False,
                drive_file_id="drv_selftest_12345",
            )
            with (
                patch.object(store, "put", side_effect=_fake_put),
                patch.object(store, "get", side_effect=lambda *a, **kw: captured_payload[-1]),
                patch.object(store, "get_metadata", return_value=fake_meta),
            ):
                self_test_res = store.self_test()
            self.assertTrue(self_test_res.ok)
            self.assertEqual(self_test_res.delete_mode, "trash_fallback")
            self.assertFalse(self_test_res.permanent_delete)
            self.assertIsNotNone(self_test_res.warning)

        # Service check_health & run_self_test pass fields through
        svc = VireadDriveConnectionService(MagicMock())
        svc.repo = MagicMock()
        svc.repo.get_primary = AsyncMock(
            return_value=(
                {
                    "status": "CONNECTED",
                    "oauth_scope": "apps_script_bridge",
                    "account_email": "owner@example.com",
                    "subfolder_ids": {},
                },
                True,
            )
        )
        svc.repo.update_health_and_quota = AsyncMock(return_value={})
        svc._release_read_txn = AsyncMock()
        svc._build_store_async = AsyncMock(return_value=store)

        with patch.object(store, "_call_bridge", side_effect=fake_bridge):
            payload = asyncio.run(svc.check_health())
        self.assertFalse(payload["advanced_drive_enabled"])
        self.assertEqual(payload["delete_mode"], "trash_fallback")
        self.assertTrue(payload["warnings"])


class TestVpackAndPackShardFlow2Support(unittest.TestCase):
    VALID_URL = "https://script.google.com/macros/s/AKfycbzViReadFlow2BridgeDeployment0123456789/exec"
    SECRET = "s" * 48

    @staticmethod
    def _build_tar_bytes(entries: list[tuple[str, bytes]]) -> bytes:
        import io as _io
        import tarfile as _tarfile

        buf = _io.BytesIO()
        with _tarfile.open(fileobj=buf, mode="w") as tf:
            for name, content in entries:
                info = _tarfile.TarInfo(name=name)
                info.size = len(content)
                tf.addfile(info, _io.BytesIO(content))
        return buf.getvalue()

    def test_vpack_reference_helpers_and_validation(self):
        from app.services.training_storage import (
            VPACK_FILE_ID_PREFIX,
            build_vpack_storage_ref,
            parse_vpack_drive_file_id,
            parse_vpack_ref,
        )

        self.assertEqual(VPACK_FILE_ID_PREFIX, "vpack--")
        pack_id = "drv_pack_with--dashes_" + ("x" * 35)
        member_sha = "a" * 64
        ref = build_vpack_storage_ref(pack_id, member_sha.upper())
        self.assertEqual(ref, f"gdrive://vpack--{pack_id}--{member_sha}")
        self.assertEqual(parse_vpack_drive_file_id(f"vpack--{pack_id}--{member_sha}"), (pack_id, member_sha))
        self.assertEqual(parse_vpack_ref(ref), (pack_id, member_sha))

        parsed = parse_artifact_ref(ref)
        self.assertEqual(parsed.provider, StorageProvider.GOOGLE_DRIVE)
        self.assertEqual(parsed.drive_file_id, f"vpack--{pack_id}--{member_sha}")

        self.assertIsNone(parse_vpack_drive_file_id("regular_drive_id_12345"))
        self.assertIsNone(parse_vpack_drive_file_id("vpack--missing_separator"))
        self.assertIsNone(parse_vpack_drive_file_id(f"vpack--short--{member_sha}"))
        self.assertIsNone(parse_vpack_drive_file_id(f"vpack--{pack_id}--{'A' * 64}"))
        self.assertIsNone(parse_vpack_drive_file_id(f"vpack--vpack--{pack_id}--{member_sha}"))
        self.assertIsNone(parse_vpack_ref("ocr-training/legacy/file.png"))
        with self.assertRaises(ValueError):
            parse_artifact_ref("gdrive://vpack--short--" + member_sha)
        with self.assertRaises(ValueError):
            build_vpack_storage_ref(f"vpack--{pack_id}--{member_sha}", member_sha)

    def test_apps_script_vpack_resolution_lru_cache_and_corruption_checks(self):
        from app.services.training_storage import (
            GoogleAppsScriptDriveStore,
            build_vpack_storage_ref,
        )

        server = InMemoryAppsScriptBridgeServer(secret=self.SECRET)
        session = server.make_session()
        raw_post = session.post
        get_file_calls: list[str] = []

        def _spied_post(*args, **kwargs):
            env = kwargs.get("json") or {}
            if env.get("action") == "get_file":
                payload = json.loads(env.get("payload_json") or "{}")
                get_file_calls.append(str(payload.get("file_id") or ""))
            return raw_post(*args, **kwargs)

        session.post = _spied_post
        store = GoogleAppsScriptDriveStore(
            web_app_url=self.VALID_URL,
            bridge_secret=self.SECRET,
            session=session,
            chunk_bytes=64 * 1024,
            sleep_fn=lambda _s: None,
        )

        # Create 5 tar packs to test LRU capacity = 4
        pack_refs: list[tuple[str, str, bytes]] = []
        for idx in range(5):
            raw_a = b"\x89PNG\r\n\x1a\n" + f"crop-{idx}-a".encode("utf-8")
            sha_a = hashlib.sha256(raw_a).hexdigest()
            raw_b = f"raw-crop-{idx}-b".encode("utf-8")
            sha_b = hashlib.sha256(raw_b).hexdigest()
            tar_bytes = self._build_tar_bytes([(f"{sha_a}.png", raw_a), (sha_b, raw_b)])
            stored_pack = store.put(
                f"verified-samples/pack-{idx:02d}.tar",
                tar_bytes,
                content_type="application/x-tar",
                expected_sha256=hashlib.sha256(tar_bytes).hexdigest(),
            )
            pack_refs.append((stored_pack.drive_file_id, sha_a, raw_a))

        # Test get_metadata, exists, open_stream, open_stream_with_metadata, get on pack 0
        p0_id, p0_sha, p0_bytes = pack_refs[0]
        vref0 = build_vpack_storage_ref(p0_id, p0_sha)
        get_file_calls.clear()
        meta0 = store.get_metadata(vref0)
        self.assertEqual(meta0.size_bytes, len(p0_bytes))
        self.assertEqual(meta0.sha256, p0_sha)
        self.assertEqual(meta0.content_type, "image/png")
        self.assertTrue(store.exists(vref0))
        self.assertEqual(store.get(vref0, expected_sha256=p0_sha), p0_bytes)
        self.assertEqual(b"".join(store.open_stream(vref0, expected_sha256=p0_sha)), p0_bytes)
        sm_meta, sm_iter = store.open_stream_with_metadata(vref0, expected_sha256=p0_sha)
        self.assertEqual(sm_meta.size_bytes, len(p0_bytes))
        self.assertEqual(b"".join(sm_iter), p0_bytes)
        # Only 1 get_file call for all operations on pack 0!
        self.assertEqual(get_file_calls, [p0_id])

        # Missing member returns exists=False and raises DriveNotFoundError
        missing_ref = build_vpack_storage_ref(p0_id, "f" * 64)
        self.assertFalse(store.exists(missing_ref))
        with self.assertRaises(DriveNotFoundError):
            store.get(missing_ref)

        # Populate packs 1, 2, 3 (total 4 cached); touch pack 0 again to promote it; then load pack 4 -> evicts pack 1!
        for idx in (1, 2, 3):
            pid, sha, raw = pack_refs[idx]
            self.assertEqual(store.get(build_vpack_storage_ref(pid, sha)), raw)
        # Touch pack 0 (still cached, 0 bridge calls)
        before_touch = len(get_file_calls)
        self.assertEqual(store.get(vref0), p0_bytes)
        self.assertEqual(len(get_file_calls), before_touch)
        # Load pack 4 -> capacity 4 evicts pack 1 (LRU), keeps pack 0
        p4_id, p4_sha, p4_bytes = pack_refs[4]
        self.assertEqual(store.get(build_vpack_storage_ref(p4_id, p4_sha)), p4_bytes)
        before_recheck = len(get_file_calls)
        self.assertEqual(store.get(vref0), p0_bytes)
        self.assertEqual(len(get_file_calls), before_recheck)
        # Pack 1 was evicted, so fetching it performs 1 bridge get_file call
        p1_id, p1_sha, p1_bytes = pack_refs[1]
        self.assertEqual(store.get(build_vpack_storage_ref(p1_id, p1_sha)), p1_bytes)
        self.assertEqual(get_file_calls[-1], p1_id)

        # Corrupted member bytes inside tar -> raises DriveIntegrityError
        bad_bytes = b"corrupted-member-payload"
        claimed_sha = "b" * 64
        bad_tar = self._build_tar_bytes([(f"{claimed_sha}.png", bad_bytes)])
        stored_bad = store.put(
            "verified-samples/corrupt-pack.tar",
            bad_tar,
            content_type="application/x-tar",
            expected_sha256=hashlib.sha256(bad_tar).hexdigest(),
        )
        with self.assertRaises(DriveIntegrityError):
            store.get(build_vpack_storage_ref(stored_bad.drive_file_id, claimed_sha))

        # Public & trashed pack checks
        server.files[p0_id]["is_public"] = True
        store._vpack_cache.clear()
        with self.assertRaises(DrivePermissionError):
            store.get(vref0)
        server.files[p0_id]["is_public"] = False
        server.files[p0_id]["trashed"] = True
        with self.assertRaises(DriveNotFoundError):
            store.get(vref0)

    def test_sync_status_filter_locked_test_reuse_pack_shards_and_route_auth_and_delete(self):
        import asyncio
        from datetime import datetime, timedelta, timezone
        from io import BytesIO
        from PIL import Image
        from app.services import viread_ocr_training_service as training_svc
        from app.services.training_storage.google_drive_desktop_store import GoogleDriveDesktopStore

        actor_id = uuid4()
        dataset_id = uuid4()
        locked_id = uuid4()
        job_id = uuid4()
        worker_id = "colab-worker-pack"

        async def _run():
            # 1. admin_verified_manifest filters sync_status='SYNCED' and propagates pack_shards without changing version_sha256
            with tempfile.TemporaryDirectory() as tmp:
                store = GoogleDriveDesktopStore(root_dir=tmp)
                router = TrainingArtifactStoreRouter(
                    drive_store_factory=lambda: store,
                    write_provider=StorageProvider.GOOGLE_DRIVE,
                )

                def _make_png(seed: int) -> bytes:
                    im = Image.new("RGB", (240, 48), (255, 255, 255))
                    for x in range(8, 228, 12):
                        im.paste((seed * 10 % 120, 15, 15), (x, 8, x + 3, 40))
                    b = BytesIO()
                    im.save(b, format="PNG")
                    return b.getvalue()

                b1 = _make_png(1)
                b2 = _make_png(2)
                s1_sha = hashlib.sha256(b1).hexdigest()
                s2_sha = hashlib.sha256(b2).hexdigest()
                ref1 = store.put(f"verified-samples/g1/{s1_sha}.png", b1, content_type="image/png", expected_sha256=s1_sha).reference
                ref2 = store.put(f"verified-samples/g2/{s2_sha}.png", b2, content_type="image/png", expected_sha256=s2_sha).reference
                pack_shard_meta = {"storage_ref": "gdrive://drv_pack_shard_001", "sha256": "c" * 64, "shard_index": 0}

                captured_sql: list[str] = []
                inserted_dataset_prov: list[dict] = []

                class _ManifestRepo:
                    async def execute(self, sql, params=None):
                        captured_sql.append(" ".join(str(sql).split()))
                        return MagicMock(rowcount=1)

                    async def all(self, sql, params=None):
                        sql_norm = " ".join(str(sql).split())
                        captured_sql.append(sql_norm)
                        if "FROM public.viread_ocr_samples sample" in sql_norm:
                            return [
                                {
                                    "sample_id": str(uuid4()),
                                    "group_id": "g1",
                                    "split": "train",
                                    "image_storage_path": ref1,
                                    "image_sha256": s1_sha,
                                    "label": "Con mèo trèo cây cau",
                                    "source_page_id": None,
                                    "source_revision_id": None,
                                    "sync_status": "SYNCED",
                                    "provenance": {"verified_by_admin": True, "verification_source": "admin", "pack_shard": pack_shard_meta},
                                },
                                {
                                    "sample_id": str(uuid4()),
                                    "group_id": "g2",
                                    "split": "validation",
                                    "image_storage_path": ref2,
                                    "image_sha256": s2_sha,
                                    "label": "Chú gà trống gáy sáng",
                                    "source_page_id": None,
                                    "source_revision_id": None,
                                    "sync_status": "PENDING_PACK",
                                    "provenance": {"verified_by_admin": True, "verification_source": "admin", "pack_shard": {"storage_ref": "gdrive://drv_unsynced", "sha256": "d" * 64}},
                                },
                            ]
                        return [
                            {
                                "sample_id": "1",
                                "group_id": "g1",
                                "split": "train",
                                "image_storage_path": ref1,
                                "image_sha256": s1_sha,
                                "label": "Con mèo trèo cây cau",
                                "source_revision_id": None,
                            }
                        ]

                    async def one(self, sql, params=None):
                        sql_norm = " ".join(str(sql).split())
                        captured_sql.append(sql_norm)
                        if "INSERT INTO public.viread_ocr_dataset_versions" in sql_norm:
                            inserted_dataset_prov.append(json.loads(params["provenance"]))
                            return {"id": dataset_id, "manifest_storage_path": params["manifest_path"]}
                        if "SELECT count(*)::integer AS total" in sql_norm:
                            return {"total": 1}
                        return None

                    async def commit(self):
                        return None

                    async def rollback(self):
                        return None

                svc = training_svc.VireadOcrTrainingService(MagicMock())
                svc.repo = _ManifestRepo()
                svc._admin = AsyncMock()
                svc._artifact_router = AsyncMock(return_value=router)
                with patch.object(training_svc, "ensure_database_capacity", new=AsyncMock(return_value={})):
                    manifest_res = await svc.admin_verified_manifest(actor_id, limit=20, offset=0)

                self.assertEqual(manifest_res["total"], 1)
                self.assertTrue(any("COALESCE(to_jsonb(sample)->>'sync_status', 'SYNCED') = 'SYNCED'" in s for s in captured_sql))
                self.assertEqual(inserted_dataset_prov[0]["pack_shards"], [pack_shard_meta])

                # 2. ensure_locked_test reuses gdrive:// refs without per-crop router.put and propagates pack_shards
                put_calls: list[str] = []
                orig_put = router.put

                def _spy_put(lpath, data, **kwargs):
                    put_calls.append(lpath)
                    return orig_put(lpath, data, **kwargs)

                router.put = _spy_put
                holdout_rows = [
                    {
                        "sample_id": str(uuid4()),
                        "source_flow": "FLOW1_VERIFIED",
                        "group_id": "holdout-g1",
                        "image_storage_path": ref1,
                        "image_sha256": s1_sha,
                        "label": "Con mèo trèo cây cau",
                        "source_page_id": None,
                        "source_revision_id": None,
                        "provenance": {"verified_by_admin": True, "verification_source": "admin", "pack_shard": pack_shard_meta},
                    },
                    {
                        "sample_id": str(uuid4()),
                        "source_flow": "FLOW1_VERIFIED",
                        "group_id": "holdout-g2",
                        "image_storage_path": ref2,
                        "image_sha256": s2_sha,
                        "label": "Chú gà trống gáy sáng",
                        "source_page_id": None,
                        "source_revision_id": None,
                        "provenance": {"verified_by_admin": True, "verification_source": "admin", "pack_shard": pack_shard_meta},
                    },
                ]
                locked_prov: list[dict] = []

                class _LockedRepo:
                    async def execute(self, sql, params=None):
                        return MagicMock(rowcount=1)

                    async def one(self, sql, params=None):
                        sql_norm = " ".join(str(sql).split())
                        if "WITH verified_holdout AS" in sql_norm:
                            return {"sample_count": 2, "group_count": 2}
                        if "INSERT INTO public.viread_ocr_dataset_versions" in sql_norm:
                            locked_prov.append(json.loads(params["provenance"]))
                            return {
                                "id": locked_id,
                                "source_flow": "LOCKED_TEST",
                                "version_sha256": params["version_sha"],
                                "manifest_storage_path": params["storage_path"],
                                "sample_count": 2,
                                "is_locked_test": True,
                            }
                        if "INSERT INTO public.viread_ocr_evaluation_cohorts" in sql_norm:
                            return {"id": uuid4(), "evaluation_type": "PRODUCTION", "manifest_sha256": params["manifest_sha"], "sample_count": 2, "group_count": 2}
                        return None

                    async def all(self, sql, params=None):
                        return list(holdout_rows)

                    async def commit(self):
                        return None

                    async def rollback(self):
                        return None

                svc_locked = training_svc.VireadOcrTrainingService(MagicMock())
                svc_locked.repo = _LockedRepo()
                svc_locked._admin = AsyncMock()
                svc_locked._artifact_router = AsyncMock(return_value=router)
                with (
                    patch.object(training_svc, "MIN_LOCKED_PAIRS", 2),
                    patch.object(training_svc, "MIN_LOCKED_GROUPS", 2),
                    patch.object(training_svc, "ensure_database_capacity", new=AsyncMock(return_value={})),
                ):
                    locked_res = await svc_locked.ensure_locked_test(actor_id)
                self.assertEqual(locked_res["status"], "READY")
                self.assertEqual(len(put_calls), 1)
                self.assertTrue(put_calls[0].startswith("locked-tests/manifests/"))
                self.assertEqual(locked_prov[0]["pack_shards"], [pack_shard_meta])

            # 3. dataset_samples attaches signed download_url to dataset["pack_shards"]
            class _SamplesRepo:
                async def one(self, sql, params=None):
                    return {
                        "id": dataset_id,
                        "source_flow": "FLOW1_VERIFIED",
                        "version_sha256": "e" * 64,
                        "sample_count": 1,
                        "is_locked_test": False,
                        "manifest_storage_path": "gdrive://drv_manifest_001",
                        "provenance": {"pack_shards": [pack_shard_meta]},
                    }

                async def all(self, sql, params=None):
                    return [
                        {
                            "sample_id": "s1",
                            "source_annotation_id": "s1",
                            "source_flow": "FLOW1_VERIFIED",
                            "group_id": "g1",
                            "split": "train",
                            "image_storage_path": "gdrive://vpack--drv_pack_shard_001--" + ("a" * 64),
                            "image_sha256": "a" * 64,
                            "label": "Con mèo",
                        }
                    ]

            with patch.dict(os.environ, {"VIREAD_GDRIVE_TOKEN_ENCRYPTION_KEY": "k" * 48}):
                svc_samples = training_svc.VireadOcrTrainingService(MagicMock())
                svc_samples.repo = _SamplesRepo()
                svc_samples._admin = AsyncMock()
                ds_out = await svc_samples.dataset_samples(
                    actor_id, dataset_id, limit=10, offset=0, job_id=job_id, worker_id=worker_id
                )
                self.assertIn("pack_shards", ds_out["dataset"])
                self.assertEqual(len(ds_out["dataset"]["pack_shards"]), 1)
                self.assertIn("/artifact-stream?", ds_out["dataset"]["pack_shards"][0]["download_url"])

                # 4. stream_viread_colab_job_artifact SQL authorizes pack_shards storage_ref
                seen_auth_sql: list[str] = []

                class _PackAuthRepo:
                    async def one(self, sql, params=None):
                        if "FROM public.viread_ocr_training_jobs" in sql:
                            return {
                                "id": job_id,
                                "target": "COLAB",
                                "status": "COLAB_RUNNING",
                                "worker_id": worker_id,
                                "lease_expires_at": datetime.now(timezone.utc) + timedelta(minutes=10),
                                "dataset_version_id": dataset_id,
                                "locked_test_version_id": locked_id,
                                "parent_checkpoint_sha256": "a" * 64,
                                "run_id": None,
                            }
                        seen_auth_sql.append(" ".join(str(sql).split()))
                        return {"is_authorized": True}

                pack_tok = sign_worker_artifact_token(
                    job_id=str(job_id),
                    worker_id=worker_id,
                    reference=pack_shard_meta["storage_ref"],
                    expected_sha256=pack_shard_meta["sha256"],
                )
                from app.services.training_storage.base import ArtifactMetadata
                ok_meta = ArtifactMetadata(
                    provider=StorageProvider.GOOGLE_DRIVE,
                    reference=pack_shard_meta["storage_ref"],
                    name="pack-0.tar",
                    size_bytes=5,
                    sha256=pack_shard_meta["sha256"],
                    content_type="application/x-tar",
                    trashed=False,
                    is_public=False,
                    drive_file_id="drv_pack_shard_001",
                )
                ok_router = MagicMock()
                ok_router.open_stream_with_metadata.return_value = (ok_meta, iter([b"12345"]))
                ok_drive_svc = MagicMock()
                ok_drive_svc.build_artifact_router = AsyncMock(return_value=ok_router)
                fake_db = MagicMock()
                fake_db.rollback = AsyncMock()
                fake_db.commit = AsyncMock()
                with (
                    patch.object(admin_viread_training, "VireadOcrTrainingService", return_value=MagicMock(repo=_PackAuthRepo())),
                    patch.object(admin_viread_training, "VireadDriveConnectionService", return_value=ok_drive_svc),
                ):
                    resp = await admin_viread_training.stream_viread_colab_job_artifact(
                        job_id=job_id, worker_id=worker_id, token=pack_tok, _worker=None, db=fake_db
                    )
                self.assertEqual(resp.headers.get("content-length"), "5")
                self.assertIn("jsonb_array_elements", seen_auth_sql[0])
                self.assertIn("pack_shards", seen_auth_sql[0])
                self.assertIn("shard->>'storage_ref' = :ref", seen_auth_sql[0])

            # 5. delete_viread_training_job allows unleased queued jobs and blocks leased/running with 409
            for st in ("WAITING_FOR_COLAB_WORKER", "FALLBACK_QUEUED_COLAB", "WAITING_FOR_DATA", "QUEUED"):
                exec_calls: list[tuple[str, dict]] = []

                class _DeleteOkDb:
                    async def execute(self, stmt, params=None):
                        exec_calls.append((" ".join(str(stmt).split()), dict(params or {})))
                        return MagicMock(scalar_one_or_none=MagicMock(return_value=job_id))

                    async def commit(self):
                        return None

                    async def rollback(self):
                        return None

                with patch.object(admin_viread_training.VireadOcrTrainingService, "_admin", new=AsyncMock()):
                    del_res = await admin_viread_training.delete_viread_training_job(
                        job_id=job_id, actor_id=actor_id, db=_DeleteOkDb()
                    )
                self.assertEqual(del_res, {"job_id": job_id, "deleted": True})
                del_sql, del_params = exec_calls[0]
                self.assertIn("worker_id IS NULL", del_sql)
                self.assertIn("run_id IS NULL", del_sql)
                self.assertIn(st, del_params["unleased_queued_statuses"])

            class _DeleteConflictDb:
                def __init__(self):
                    self.step = 0

                async def execute(self, stmt, params=None):
                    self.step += 1
                    if self.step == 1:
                        return MagicMock(scalar_one_or_none=MagicMock(return_value=None))
                    return MagicMock(scalar_one_or_none=MagicMock(return_value="COLAB_RUNNING"))

                async def commit(self):
                    return None

                async def rollback(self):
                    return None

            with patch.object(admin_viread_training.VireadOcrTrainingService, "_admin", new=AsyncMock()):
                with self.assertRaises(HTTPException) as conflict_err:
                    await admin_viread_training.delete_viread_training_job(
                        job_id=job_id, actor_id=actor_id, db=_DeleteConflictDb()
                    )
                self.assertEqual(conflict_err.exception.status_code, 409)

        asyncio.run(_run())


if __name__ == "__main__":
    unittest.main()
