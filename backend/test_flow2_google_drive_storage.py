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


if __name__ == "__main__":
    unittest.main()
