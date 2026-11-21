from __future__ import annotations

import base64
from collections import OrderedDict
from dataclasses import dataclass
import hashlib
import json
import os
import secrets
import threading
import time
from typing import Any
from urllib.parse import urlencode, urlsplit

from cryptography.fernet import Fernet, InvalidToken
import requests

from app.services.training_storage.base import (
    DriveAuthError,
    DrivePermissionError,
    DriveTransientError,
    TrainingStorageError,
)

GOOGLE_OAUTH_AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth"
GOOGLE_OAUTH_TOKEN_URL = "https://oauth2.googleapis.com/token"
GOOGLE_OAUTH_REVOKE_URL = "https://oauth2.googleapis.com/revoke"
GOOGLE_DRIVE_REQUIRED_SCOPE = "https://www.googleapis.com/auth/drive.file"
GOOGLE_USERINFO_EMAIL_SCOPE = "https://www.googleapis.com/auth/userinfo.email"
OAUTH_STATE_TTL_SECONDS = 600
_MIN_ENCRYPTION_KEY_CHARS = 32
_MAX_CONSUMED_NONCES = 2048

_consumed_nonces_lock = threading.Lock()
_consumed_nonces: OrderedDict[str, float] = OrderedDict()


@dataclass(frozen=True)
class GoogleDriveOAuthConfig:
    client_id: str
    client_secret: str
    redirect_uri: str
    encryption_key: str
    scope: str = GOOGLE_DRIVE_REQUIRED_SCOPE
    required_account_email: str | None = None


@dataclass(frozen=True)
class OAuthStartResult:
    authorization_url: str
    state: str
    scope: str
    redirect_uri: str
    expires_in_seconds: int = OAUTH_STATE_TTL_SECONDS


@dataclass(frozen=True)
class OAuthStatePayload:
    actor_id: str
    nonce: str
    code_verifier: str
    redirect_uri: str
    issued_at: int


@dataclass(frozen=True)
class OAuthTokenBundle:
    access_token: str
    refresh_token: str | None
    expires_in: int
    scope: str
    token_type: str


def _derive_fernet(secret_key: str, *, purpose: str = "refresh-token-v1") -> tuple[Fernet, str]:
    raw = (secret_key or "").strip()
    if len(raw) < _MIN_ENCRYPTION_KEY_CHARS:
        raise TrainingStorageError(
            "VIREAD_GDRIVE_TOKEN_ENCRYPTION_KEY must be configured with at least 32 characters",
            code="DRIVE_ENCRYPTION_KEY_INVALID",
            http_status=503,
        )
    digest = hashlib.sha256(f"viread-gdrive:{purpose}:{raw}".encode("utf-8")).digest()
    fernet_key = base64.urlsafe_b64encode(digest)
    fingerprint = hashlib.sha256(digest).hexdigest()[:16]
    return Fernet(fernet_key), fingerprint


def encryption_key_fingerprint(secret_key: str) -> str:
    _, fingerprint = _derive_fernet(secret_key, purpose="refresh-token-v1")
    return fingerprint


def encrypt_refresh_token(refresh_token: str, secret_key: str) -> tuple[str, str]:
    token = (refresh_token or "").strip()
    if not token:
        raise DriveAuthError("Google OAuth did not return a refresh token", code="DRIVE_REFRESH_TOKEN_MISSING")
    fernet, fingerprint = _derive_fernet(secret_key, purpose="refresh-token-v1")
    ciphertext = fernet.encrypt(token.encode("utf-8")).decode("ascii")
    return ciphertext, fingerprint


def decrypt_refresh_token(ciphertext: str, secret_key: str) -> str:
    if not (ciphertext or "").strip():
        raise DriveAuthError("Stored Google Drive refresh token is missing", code="DRIVE_REFRESH_TOKEN_MISSING")
    fernet, _ = _derive_fernet(secret_key, purpose="refresh-token-v1")
    try:
        return fernet.decrypt(ciphertext.encode("ascii")).decode("utf-8")
    except InvalidToken as exc:
        raise DriveAuthError(
            "Stored Google Drive refresh token could not be decrypted with the current server key",
            code="DRIVE_TOKEN_DECRYPT_FAILED",
            http_status=503,
        ) from exc


def validate_redirect_uri(redirect_uri: str) -> str:
    cleaned = (redirect_uri or "").strip()
    parsed = urlsplit(cleaned)
    if parsed.scheme not in {"https", "http"} or not parsed.netloc:
        raise TrainingStorageError(
            "VIREAD_GDRIVE_OAUTH_REDIRECT_URI must be a valid http(s) URL",
            code="DRIVE_CONFIG_INVALID",
            http_status=503,
        )
    if parsed.scheme == "http" and parsed.hostname not in {"localhost", "127.0.0.1"}:
        raise TrainingStorageError(
            "Non-localhost Google OAuth redirect URI must use HTTPS",
            code="DRIVE_CONFIG_INVALID",
            http_status=503,
        )
    if parsed.fragment or parsed.query:
        raise TrainingStorageError(
            "Google OAuth redirect URI must not include query parameters or fragments",
            code="DRIVE_CONFIG_INVALID",
            http_status=503,
        )
    return cleaned


def load_oauth_config(*, redirect_uri_override: str | None = None) -> GoogleDriveOAuthConfig:
    client_id = (os.getenv("VIREAD_GDRIVE_OAUTH_CLIENT_ID") or "").strip()
    client_secret = (os.getenv("VIREAD_GDRIVE_OAUTH_CLIENT_SECRET") or "").strip()
    configured_redirect = (os.getenv("VIREAD_GDRIVE_OAUTH_REDIRECT_URI") or "").strip()
    extra_allowed_raw = (os.getenv("VIREAD_GDRIVE_OAUTH_ALLOWED_REDIRECT_URIS") or "").strip()
    encryption_key = (os.getenv("VIREAD_GDRIVE_TOKEN_ENCRYPTION_KEY") or "").strip()
    missing = [
        name
        for name, value in (
            ("VIREAD_GDRIVE_OAUTH_CLIENT_ID", client_id),
            ("VIREAD_GDRIVE_OAUTH_CLIENT_SECRET", client_secret),
            ("VIREAD_GDRIVE_OAUTH_REDIRECT_URI", configured_redirect),
            ("VIREAD_GDRIVE_TOKEN_ENCRYPTION_KEY", encryption_key),
        )
        if not value
    ]
    if missing:
        raise TrainingStorageError(
            f"Google Drive OAuth is not configured on the server (missing: {', '.join(missing)})",
            code="DRIVE_OAUTH_NOT_CONFIGURED",
            http_status=503,
        )
    _derive_fernet(encryption_key, purpose="refresh-token-v1")
    validated_primary = validate_redirect_uri(configured_redirect)
    allowed_uris = {validated_primary}
    for entry in extra_allowed_raw.split(","):
        if entry.strip():
            allowed_uris.add(validate_redirect_uri(entry.strip()))
    if redirect_uri_override is not None and redirect_uri_override.strip():
        candidate_uri = validate_redirect_uri(redirect_uri_override)
        if candidate_uri not in allowed_uris:
            raise DrivePermissionError(
                "Requested OAuth redirect_uri is not in the server-configured allowlist",
                code="DRIVE_REDIRECT_URI_NOT_ALLOWED",
                http_status=400,
            )
        selected_redirect = candidate_uri
    else:
        selected_redirect = validated_primary
    required_account_email = (os.getenv("VIREAD_GDRIVE_REQUIRED_ACCOUNT_EMAIL") or "").strip().lower() or None
    return GoogleDriveOAuthConfig(
        client_id=client_id,
        client_secret=client_secret,
        redirect_uri=selected_redirect,
        encryption_key=encryption_key,
        scope=GOOGLE_DRIVE_REQUIRED_SCOPE,
        required_account_email=required_account_email,
    )


def oauth_config_readiness() -> dict[str, Any]:
    """Return safe boolean diagnostics about server-side Google Drive OAuth configuration."""
    client_id = bool((os.getenv("VIREAD_GDRIVE_OAUTH_CLIENT_ID") or "").strip())
    client_secret = bool((os.getenv("VIREAD_GDRIVE_OAUTH_CLIENT_SECRET") or "").strip())
    redirect_uri = (os.getenv("VIREAD_GDRIVE_OAUTH_REDIRECT_URI") or "").strip()
    enc_key = (os.getenv("VIREAD_GDRIVE_TOKEN_ENCRYPTION_KEY") or "").strip()
    required_account_email = (os.getenv("VIREAD_GDRIVE_REQUIRED_ACCOUNT_EMAIL") or "").strip().lower() or None
    redirect_valid = False
    if redirect_uri:
        try:
            validate_redirect_uri(redirect_uri)
            redirect_valid = True
        except TrainingStorageError:
            redirect_valid = False
    enc_key_valid = len(enc_key) >= _MIN_ENCRYPTION_KEY_CHARS
    return {
        "oauth_configured": client_id and client_secret and redirect_valid and enc_key_valid,
        "client_id_configured": client_id,
        "client_secret_configured": client_secret,
        "redirect_uri_configured": redirect_valid,
        "encryption_key_configured": enc_key_valid,
        "required_scope": GOOGLE_DRIVE_REQUIRED_SCOPE,
        "required_account_email": required_account_email,
    }


def _pkce_pair() -> tuple[str, str]:
    verifier = secrets.token_urlsafe(64)
    digest = hashlib.sha256(verifier.encode("ascii")).digest()
    challenge = base64.urlsafe_b64encode(digest).decode("ascii").rstrip("=")
    return verifier, challenge


def create_oauth_authorization(
    config: GoogleDriveOAuthConfig,
    *,
    actor_id: str,
) -> OAuthStartResult:
    """Create a least-privilege PKCE S256 OAuth 2.0 URL with encrypted, actor-bound state."""
    verifier, challenge = _pkce_pair()
    nonce = secrets.token_urlsafe(24)
    payload = {
        "actor_id": str(actor_id),
        "nonce": nonce,
        "code_verifier": verifier,
        "redirect_uri": config.redirect_uri,
        "iat": int(time.time()),
    }
    fernet, _ = _derive_fernet(config.encryption_key, purpose="oauth-state-v1")
    state_token = fernet.encrypt(json.dumps(payload, separators=(",", ":")).encode("utf-8")).decode("ascii")
    params = {
        "client_id": config.client_id,
        "redirect_uri": config.redirect_uri,
        "response_type": "code",
        "scope": config.scope,
        "access_type": "offline",
        "prompt": "consent",
        "include_granted_scopes": "false",
        "code_challenge": challenge,
        "code_challenge_method": "S256",
        "state": state_token,
    }
    if config.required_account_email:
        params["login_hint"] = config.required_account_email
    return OAuthStartResult(
        authorization_url=f"{GOOGLE_OAUTH_AUTH_URL}?{urlencode(params)}",
        state=state_token,
        scope=config.scope,
        redirect_uri=config.redirect_uri,
        expires_in_seconds=OAUTH_STATE_TTL_SECONDS,
    )


def verify_and_consume_oauth_state(
    state_token: str,
    *,
    expected_actor_id: str,
    encryption_key: str,
    ttl_seconds: int = OAUTH_STATE_TTL_SECONDS,
) -> OAuthStatePayload:
    """Decrypt, validate actor binding & TTL, and prevent replay of OAuth state tokens."""
    if not (state_token or "").strip():
        raise DriveAuthError("Missing Google OAuth state parameter", code="DRIVE_OAUTH_STATE_INVALID", http_status=400)
    fernet, _ = _derive_fernet(encryption_key, purpose="oauth-state-v1")
    try:
        raw = fernet.decrypt(state_token.encode("ascii"), ttl=ttl_seconds)
        data = json.loads(raw.decode("utf-8"))
    except (InvalidToken, ValueError, TypeError) as exc:
        raise DriveAuthError(
            "Google OAuth state is invalid or expired; restart Drive connection",
            code="DRIVE_OAUTH_STATE_INVALID",
            http_status=400,
        ) from exc

    actor_id = str(data.get("actor_id") or "")
    nonce = str(data.get("nonce") or "")
    code_verifier = str(data.get("code_verifier") or "")
    redirect_uri = str(data.get("redirect_uri") or "")
    issued_at = int(data.get("iat") or 0)
    if actor_id != str(expected_actor_id):
        raise DrivePermissionError(
            "Google OAuth state does not belong to the authenticated admin session",
            code="DRIVE_OAUTH_STATE_MISMATCH",
            http_status=403,
        )
    if not nonce or not code_verifier or not redirect_uri:
        raise DriveAuthError("Incomplete Google OAuth state payload", code="DRIVE_OAUTH_STATE_INVALID", http_status=400)

    now = time.monotonic()
    with _consumed_nonces_lock:
        expired = [key for key, ts in _consumed_nonces.items() if (now - ts) > ttl_seconds]
        for key in expired:
            _consumed_nonces.pop(key, None)
        if nonce in _consumed_nonces:
            raise DriveAuthError(
                "Google OAuth callback state was already used; restart Drive connection",
                code="DRIVE_OAUTH_STATE_REPLAYED",
                http_status=400,
            )
        _consumed_nonces[nonce] = now
        while len(_consumed_nonces) > _MAX_CONSUMED_NONCES:
            _consumed_nonces.popitem(last=False)

    return OAuthStatePayload(
        actor_id=actor_id,
        nonce=nonce,
        code_verifier=code_verifier,
        redirect_uri=redirect_uri,
        issued_at=issued_at,
    )


def validate_granted_scopes(scope_str: str | None) -> str:
    """Enforce strict allowlist equality on least-privilege drive.file scope only."""
    scopes = {token.strip() for token in (scope_str or "").split() if token.strip()}
    if GOOGLE_DRIVE_REQUIRED_SCOPE not in scopes:
        raise DrivePermissionError(
            "Google OAuth did not grant the required least-privilege drive.file permission",
            code="DRIVE_SCOPE_MISSING",
            http_status=403,
        )
    extra_scopes = scopes - {GOOGLE_DRIVE_REQUIRED_SCOPE}
    if extra_scopes:
        raise DrivePermissionError(
            "Overly broad Google Drive scope was returned; ViRead strictly allows drive.file only",
            code="DRIVE_SCOPE_TOO_BROAD",
            http_status=403,
        )
    return GOOGLE_DRIVE_REQUIRED_SCOPE


def _safe_oauth_error_code(response: requests.Response) -> str:
    try:
        body = response.json()
        if isinstance(body, dict):
            code = str(body.get("error") or "").strip()
            if code:
                return code[:64]
    except Exception:
        pass
    return f"http_{response.status_code}"


def exchange_authorization_code(
    config: GoogleDriveOAuthConfig,
    *,
    code: str,
    code_verifier: str,
    redirect_uri: str,
    session: requests.Session | None = None,
    timeout: float = 20.0,
) -> OAuthTokenBundle:
    """Exchange an authorization code + PKCE verifier for access and offline refresh tokens."""
    clean_code = (code or "").strip()
    if not clean_code or len(clean_code) > 4096:
        raise DriveAuthError("Authorization code is missing or invalid", code="DRIVE_OAUTH_CODE_INVALID", http_status=400)
    http = session or requests.Session()
    try:
        response = http.post(
            GOOGLE_OAUTH_TOKEN_URL,
            data={
                "client_id": config.client_id,
                "client_secret": config.client_secret,
                "code": clean_code,
                "code_verifier": code_verifier,
                "grant_type": "authorization_code",
                "redirect_uri": redirect_uri,
            },
            timeout=timeout,
        )
    except requests.RequestException as exc:
        raise DriveTransientError("Could not reach Google OAuth token endpoint") from exc

    if response.status_code >= 500:
        raise DriveTransientError(
            f"Google OAuth token endpoint returned HTTP {response.status_code}",
            http_status=response.status_code,
        )
    if response.status_code >= 400:
        err_code = _safe_oauth_error_code(response)
        raise DriveAuthError(
            f"Google OAuth code exchange failed ({err_code})",
            code="DRIVE_OAUTH_EXCHANGE_FAILED",
            http_status=400 if response.status_code == 400 else 401,
        )
    try:
        payload = response.json()
    except ValueError as exc:
        raise DriveTransientError("Google OAuth token endpoint returned invalid JSON") from exc

    access_token = str(payload.get("access_token") or "").strip()
    refresh_token = str(payload.get("refresh_token") or "").strip() or None
    if not access_token:
        raise DriveAuthError("Google OAuth token response missing access_token", code="DRIVE_OAUTH_EXCHANGE_FAILED")
    try:
        granted_scope = validate_granted_scopes(str(payload.get("scope") or ""))
    except DrivePermissionError:
        if refresh_token:
            revoke_token(refresh_token, session=http, timeout=timeout)
        elif access_token:
            revoke_token(access_token, session=http, timeout=timeout)
        raise
    expires_in = int(payload.get("expires_in") or 3600)
    token_type = str(payload.get("token_type") or "Bearer")
    return OAuthTokenBundle(
        access_token=access_token,
        refresh_token=refresh_token,
        expires_in=max(60, expires_in),
        scope=granted_scope,
        token_type=token_type,
    )


def refresh_access_token(
    *,
    client_id: str,
    client_secret: str,
    refresh_token: str,
    session: requests.Session | None = None,
    timeout: float = 20.0,
) -> OAuthTokenBundle:
    """Exchange a server-held offline refresh token for a fresh short-lived access token."""
    http = session or requests.Session()
    try:
        response = http.post(
            GOOGLE_OAUTH_TOKEN_URL,
            data={
                "client_id": client_id,
                "client_secret": client_secret,
                "refresh_token": refresh_token,
                "grant_type": "refresh_token",
            },
            timeout=timeout,
        )
    except requests.RequestException as exc:
        raise DriveTransientError("Could not reach Google OAuth token refresh endpoint") from exc

    if response.status_code >= 500:
        raise DriveTransientError(
            f"Google OAuth token refresh returned HTTP {response.status_code}",
            http_status=response.status_code,
        )
    if response.status_code >= 400:
        err_code = _safe_oauth_error_code(response)
        revoked = err_code in {"invalid_grant", "unauthorized_client"}
        raise DriveAuthError(
            f"Google Drive refresh token failed ({err_code}); admin must reconnect Google Drive"
            if revoked
            else f"Google Drive token refresh rejected ({err_code})",
            code="DRIVE_TOKEN_REVOKED" if revoked else "DRIVE_TOKEN_REFRESH_FAILED",
            http_status=401,
            token_revoked=revoked,
        )
    try:
        payload = response.json()
    except ValueError as exc:
        raise DriveTransientError("Google OAuth refresh endpoint returned invalid JSON") from exc

    access_token = str(payload.get("access_token") or "").strip()
    if not access_token:
        raise DriveAuthError("Google OAuth refresh response missing access_token", code="DRIVE_TOKEN_REFRESH_FAILED")
    scope_raw = str(payload.get("scope") or GOOGLE_DRIVE_REQUIRED_SCOPE)
    granted_scope = validate_granted_scopes(scope_raw)
    return OAuthTokenBundle(
        access_token=access_token,
        refresh_token=str(payload.get("refresh_token") or "").strip() or None,
        expires_in=max(60, int(payload.get("expires_in") or 3600)),
        scope=granted_scope,
        token_type=str(payload.get("token_type") or "Bearer"),
    )


def revoke_token(
    token: str,
    *,
    session: requests.Session | None = None,
    timeout: float = 15.0,
) -> bool:
    """Best-effort Google OAuth token revocation during safe disconnect."""
    if not (token or "").strip():
        return False
    http = session or requests.Session()
    try:
        response = http.post(
            GOOGLE_OAUTH_REVOKE_URL,
            data={"token": token.strip()},
            headers={"Content-Type": "application/x-www-form-urlencoded"},
            timeout=timeout,
        )
        return response.status_code in {200, 400}
    except requests.RequestException:
        return False


def clear_consumed_oauth_nonces_for_tests() -> None:
    with _consumed_nonces_lock:
        _consumed_nonces.clear()
