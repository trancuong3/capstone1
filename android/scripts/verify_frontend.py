#!/usr/bin/env python3
"""Validate that an HTTPS origin serves the actual server-backed ViRead Next.js login,
and optionally verify mobile WebView HTTPS/CORS/auth-401 readiness against FastAPI.

The check is strictly read-only. It never submits credentials or follows redirects to
other origins. Android packaging must fail closed when the target origin is not verified.

Default mode enforces a public HTTPS origin on port 443 using system trust anchors.
Explicit LAN acceptance mode (`lan_mode=True` or `VIREAD_LAN_MODE=1`) additionally
requires a PEM CA certificate (`ca_file` or `VIREAD_LAN_CA_CERT`) and validates an
RFC1918 / `.local` / `.lan` HTTPS origin on an explicit port with strict TLS
certificate and hostname verification (never disabling TLS verification).
"""
from __future__ import annotations

import argparse
import ipaddress
import json
import os
import ssl
import sys
from pathlib import Path
from urllib.error import HTTPError
from urllib.parse import urljoin, urlsplit
from urllib.request import HTTPRedirectHandler, HTTPSHandler, Request, build_opener

REDIRECT_CODES = {301, 302, 303, 307, 308}
USER_AGENT = "ViRead-Android-CI/1.0"
DEFAULT_TIMEOUT_SECONDS = 18
BACKEND_AUTH_PREFLIGHT_PATH = "/profiles/children"


class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def _is_private_lan_ip(hostname: str) -> bool:
    try:
        ip = ipaddress.ip_address(hostname)
    except ValueError:
        return False
    # Physical phones cannot reach Windows loopback (127.0.0.1) or unspecified (0.0.0.0).
    return (
        isinstance(ip, ipaddress.IPv4Address)
        and ip.is_private
        and not ip.is_loopback
        and not ip.is_link_local
        and not ip.is_unspecified
        and not ip.is_multicast
    )


def canonical_origin(value: str, *, lan_mode: bool = False) -> str:
    url = (value or "").strip()
    try:
        parsed = urlsplit(url)
        hostname = (parsed.hostname or "").lower()
        port = parsed.port
    except ValueError as exc:
        raise ValueError("Invalid frontend URL") from exc

    if (
        parsed.scheme != "https"
        or not hostname
        or parsed.username is not None
        or parsed.password is not None
        or parsed.path not in ("", "/")
        or parsed.query
        or parsed.fragment
        or ":" in hostname
    ):
        raise ValueError(
            "VIREAD_FRONTEND_URL must be an HTTPS origin without path, credentials, query, or fragment"
        )

    if lan_mode:
        if hostname == "localhost" or hostname.endswith(".invalid"):
            raise ValueError("LAN acceptance origin cannot use localhost or .invalid")
        if port is not None and not (1 <= port <= 65535):
            raise ValueError("LAN acceptance port must be between 1 and 65535")
        is_lan_ip = _is_private_lan_ip(hostname)
        is_lan_domain = (
            "." in hostname
            and not hostname.replace(".", "").isdigit()
            and not any(part == "" for part in hostname.split("."))
            and (
                hostname.endswith((".local", ".lan", ".home.arpa"))
                or not hostname.endswith(".internal")
            )
        )
        if not (is_lan_ip or is_lan_domain):
            raise ValueError(
                "LAN acceptance origin must be a private RFC1918 IPv4 address or valid HTTPS hostname"
            )
        effective_port = 443 if port is None else port
        return f"https://{hostname}" if effective_port == 443 else f"https://{hostname}:{effective_port}"

    # Strict public production mode (default)
    if (
        hostname == "localhost"
        or hostname.endswith((".local", ".invalid", ".internal", ".test"))
        or port not in (None, 443)
        or "." not in hostname
        or hostname.replace(".", "").isdigit()
        or any(part == "" for part in hostname.split("."))
    ):
        raise ValueError(
            "VIREAD_FRONTEND_URL must be a public HTTPS origin without path, credentials or query"
        )
    return f"https://{hostname}"


def canonical_backend_url(value: str, *, lan_mode: bool = False) -> str:
    url = (value or "").strip()
    try:
        parsed = urlsplit(url)
        hostname = (parsed.hostname or "").lower()
        port = parsed.port
    except ValueError as exc:
        raise ValueError("Invalid backend URL") from exc

    if (
        parsed.scheme != "https"
        or not hostname
        or parsed.username is not None
        or parsed.password is not None
        or parsed.query
        or parsed.fragment
        or ":" in hostname
    ):
        raise ValueError(
            "Backend URL must be an HTTPS URL without credentials, query, or fragment"
        )

    origin_only = f"https://{hostname}" if port is None else f"https://{hostname}:{port}"
    normalized_origin = canonical_origin(origin_only, lan_mode=lan_mode)
    clean_path = parsed.path.rstrip("/")
    return f"{normalized_origin}{clean_path}"


def _build_ssl_context(*, lan_mode: bool, ca_file: str | None) -> ssl.SSLContext:
    if lan_mode:
        if not ca_file or not ca_file.strip():
            raise ValueError("LAN acceptance mode requires VIREAD_LAN_CA_CERT pointing to a PEM CA file")
        ca_path = Path(ca_file.strip())
        if not ca_path.is_file():
            raise ValueError(f"LAN CA certificate file not found: {ca_path}")
        raw_pem = ca_path.read_text(encoding="utf-8", errors="replace")
        if "PRIVATE KEY" in raw_pem:
            raise ValueError("LAN CA file must contain only a public certificate, never a private key")
        if "BEGIN CERTIFICATE" not in raw_pem:
            raise ValueError("LAN CA file does not contain a valid PEM certificate")
        ctx = ssl.create_default_context(cafile=str(ca_path))
        ctx.check_hostname = True
        ctx.verify_mode = ssl.CERT_REQUIRED
        return ctx
    ctx = ssl.create_default_context()
    ctx.check_hostname = True
    ctx.verify_mode = ssl.CERT_REQUIRED
    return ctx


def _header_get(headers, name: str) -> str:
    if headers is None:
        return ""
    direct = headers.get(name)
    if direct is not None:
        return str(direct)
    target = name.lower()
    for key, value in headers.items():
        if str(key).lower() == target and value is not None:
            return str(value)
    return ""


def _request(
    url: str,
    opener,
    *,
    method: str = "GET",
    headers: dict[str, str] | None = None,
    read_body_statuses: set[int] | None = None,
) -> tuple[int, dict[str, str], str]:
    req_headers = {"User-Agent": USER_AGENT}
    if headers:
        req_headers.update(headers)
    request = Request(url, headers=req_headers, method=method)
    try:
        response = opener.open(request, timeout=DEFAULT_TIMEOUT_SECONDS)
    except HTTPError as exc:
        response = exc  # NoRedirect and 401/4xx responses surface via HTTPError.
    with response:
        status = response.getcode()
        raw_headers = response.headers or {}
        header_map = {str(k): str(v) for k, v in raw_headers.items()}
        should_read = status == 200 if read_body_statuses is None else (status in read_body_statuses)
        body = response.read(300_000).decode("utf-8", "replace") if should_read else ""
        return status, header_map, body


def _read(url: str, opener, *, accept: str = "text/html") -> tuple[int, str, str, str]:
    status, headers, body = _request(url, opener, method="GET", headers={"Accept": accept})
    location = _header_get(headers, "Location")
    content_type = _header_get(headers, "Content-Type")
    return status, location, content_type, body


def _is_viread_next_document(content_type: str, body: str) -> bool:
    lower = body.lower()
    # Explicitly reject the static GitHub Pages Project Hub dashboard.
    if "viread project hub" in lower:
        return False
    return (
        "text/html" in content_type.lower()
        and "<html" in lower
        and "/_next/" in body
        and "viread" in lower
    )


def verify_backend_health(health_url: str, opener) -> None:
    """Verify the backend health endpoint returns valid JSON matching ViRead's health contract."""
    parsed = urlsplit(health_url)
    if parsed.scheme != "https" or not parsed.hostname:
        raise ValueError("Backend health URL must use HTTPS")
    status, _, content_type, body = _read(health_url, opener, accept="application/json")
    if status != 200:
        raise ValueError(f"Backend health returned HTTP {status}, expected 200")
    if "application/json" not in content_type.lower():
        raise ValueError("Backend health endpoint did not return application/json")
    try:
        payload = json.loads(body)
    except json.JSONDecodeError as exc:
        raise ValueError("Backend health endpoint returned invalid JSON") from exc
    if not isinstance(payload, dict) or payload.get("status") not in {"ok", "degraded"}:
        raise ValueError("Backend health JSON does not match the ViRead health contract")
    if not isinstance(payload.get("database"), dict):
        raise ValueError("Backend health JSON is missing database readiness status")


def verify_backend_mobile_preflight(
    backend_url: str,
    frontend_origin: str,
    opener,
    *,
    lan_mode: bool = False,
) -> None:
    """Read-only mobile WebView -> FastAPI HTTPS, CORS preflight, and 401 JSON verification."""
    backend_base = canonical_backend_url(backend_url, lan_mode=lan_mode)
    verify_backend_health(f"{backend_base}/health", opener)

    protected_url = f"{backend_base}{BACKEND_AUTH_PREFLIGHT_PATH}"
    opt_status, opt_headers, _ = _request(
        protected_url,
        opener,
        method="OPTIONS",
        headers={
            "Origin": frontend_origin,
            "Access-Control-Request-Method": "GET",
            "Access-Control-Request-Headers": "Authorization, Content-Type",
        },
        read_body_statuses=set(),
    )
    if opt_status not in {200, 204}:
        raise ValueError(
            f"Backend CORS preflight OPTIONS returned HTTP {opt_status}, expected 200 or 204"
        )

    allow_origin = _header_get(opt_headers, "Access-Control-Allow-Origin").strip()
    if allow_origin != frontend_origin:
        raise ValueError(
            f"Backend CORS Access-Control-Allow-Origin '{allow_origin}' does not match mobile frontend origin '{frontend_origin}'"
        )

    allow_methods = {
        token.strip().upper()
        for token in _header_get(opt_headers, "Access-Control-Allow-Methods").split(",")
        if token.strip()
    }
    if "*" not in allow_methods and "GET" not in allow_methods:
        raise ValueError("Backend CORS Access-Control-Allow-Methods does not allow GET")

    allow_headers = {
        token.strip().lower()
        for token in _header_get(opt_headers, "Access-Control-Allow-Headers").split(",")
        if token.strip()
    }
    if "*" not in allow_headers and "authorization" not in allow_headers:
        raise ValueError(
            "Backend CORS Access-Control-Allow-Headers does not allow Authorization bearer tokens"
        )

    auth_status, auth_headers, auth_body = _request(
        protected_url,
        opener,
        method="GET",
        headers={
            "Accept": "application/json",
            "Origin": frontend_origin,
        },
        read_body_statuses={401},
    )
    if auth_status != 401:
        raise ValueError(
            f"Unauthenticated backend check at {BACKEND_AUTH_PREFLIGHT_PATH} returned HTTP {auth_status}, expected 401"
        )
    auth_ct = _header_get(auth_headers, "Content-Type").lower()
    if "application/json" not in auth_ct:
        raise ValueError("Unauthenticated 401 response did not return application/json")
    try:
        auth_payload = json.loads(auth_body)
    except json.JSONDecodeError as exc:
        raise ValueError("Unauthenticated 401 response returned invalid JSON") from exc
    if not isinstance(auth_payload, dict) or not any(
        key in auth_payload for key in ("detail", "error", "message")
    ):
        raise ValueError("Unauthenticated 401 JSON payload missing error detail")


def verify_frontend(
    origin: str,
    opener=None,
    *,
    lan_mode: bool = False,
    ca_file: str | None = None,
    backend_health_url: str | None = None,
    backend_url: str | None = None,
) -> None:
    base = canonical_origin(origin, lan_mode=lan_mode)
    if backend_url:
        canonical_backend_url(backend_url, lan_mode=lan_mode)
    base_parsed = urlsplit(base)
    expected_host = (base_parsed.hostname or "").lower()
    expected_port = 443 if base_parsed.port is None else base_parsed.port

    if opener is None:
        ssl_ctx = _build_ssl_context(lan_mode=lan_mode, ca_file=ca_file)
        opener = build_opener(NoRedirect(), HTTPSHandler(context=ssl_ctx))
    elif lan_mode and ca_file is not None:
        # Validate CA file rules even when a test supplies a custom opener.
        _build_ssl_context(lan_mode=True, ca_file=ca_file)

    # Next.js frontend/app/page.tsx calls redirect("/login"). A 307 at /
    # is expected and MUST NOT be misclassified as an invalid deployment.
    root_status, location, root_type, root_body = _read(base + "/", opener)
    if root_status in REDIRECT_CODES:
        if not location:
            raise ValueError("Frontend root redirects without a Location header")
        resolved = urlsplit(urljoin(base + "/", location))
        resolved_port = 443 if resolved.port is None else resolved.port
        if (
            resolved.scheme != "https"
            or (resolved.hostname or "").lower() != expected_host
            or resolved_port != expected_port
            or resolved.username is not None
            or resolved.password is not None
            or resolved.path not in ("/login", "/login/")
            or resolved.query
            or resolved.fragment
        ):
            raise ValueError("Frontend root must redirect only to same-origin /login")
    elif root_status == 200:
        if not _is_viread_next_document(root_type, root_body):
            raise ValueError("Frontend root is not a ViRead Next.js HTML page")
    else:
        raise ValueError(
            f"Frontend root returned HTTP {root_status}, expected HTML or redirect to /login"
        )

    login_status, login_location, login_type, login_body = _read(base + "/login", opener)
    if login_status in REDIRECT_CODES:
        raise ValueError(
            f"Frontend /login returned redirect HTTP {login_status} (location={login_location}); redirect loops are rejected"
        )
    if login_status != 200:
        raise ValueError(f"Frontend /login returned HTTP {login_status}, expected 200")
    if not _is_viread_next_document(login_type, login_body):
        raise ValueError("Frontend /login is not a ViRead Next.js HTML page")

    if backend_health_url:
        verify_backend_health(backend_health_url, opener)

    if backend_url:
        verify_backend_mobile_preflight(backend_url, base, opener, lan_mode=lan_mode)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description="Read-only HTTPS readiness preflight for ViRead Android WebView frontend & backend."
    )
    parser.add_argument(
        "--frontend-url",
        default=None,
        help="Override VIREAD_FRONTEND_URL HTTPS origin",
    )
    parser.add_argument(
        "--backend-url",
        default=None,
        help="Optional FastAPI HTTPS base URL for /health + OPTIONS CORS + 401 JSON preflight",
    )
    args = parser.parse_args([] if argv is None else argv)

    lan_mode = os.environ.get("VIREAD_LAN_MODE", "").strip().lower() in {"1", "true", "yes", "on"}
    ca_file = os.environ.get("VIREAD_LAN_CA_CERT", "").strip() or None
    frontend_origin = (args.frontend_url or os.environ.get("VIREAD_FRONTEND_URL", "")).strip()
    backend_health_url = os.environ.get("VIREAD_BACKEND_HEALTH_URL", "").strip() or None
    backend_url = (args.backend_url or os.environ.get("VIREAD_BACKEND_URL", "")).strip() or None
    try:
        verify_frontend(
            frontend_origin,
            lan_mode=lan_mode,
            ca_file=ca_file,
            backend_health_url=backend_health_url,
            backend_url=backend_url,
        )
    except Exception as exc:
        print(
            f"Frontend HTTPS readiness check failed: {type(exc).__name__}: {exc}",
            file=sys.stderr,
        )
        return 1
    mode_label = "LAN acceptance HTTPS" if lan_mode else "public HTTPS"
    backend_note = " + FastAPI CORS/401 preflight" if backend_url else ""
    print(f"Frontend root routing and ViRead Next.js /login HTML{backend_note} verified over {mode_label}.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
