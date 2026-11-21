#!/usr/bin/env python3
"""Validate that an HTTPS origin serves the actual server-backed ViRead Next.js login.

The check is read-only. It never submits credentials or follows redirects to other
origins. Android packaging must fail closed when the target origin is not verified.

Default mode enforces a public HTTPS origin on port 443 using system trust anchors.
Explicit LAN acceptance mode (`lan_mode=True` or `VIREAD_LAN_MODE=1`) additionally
requires a PEM CA certificate (`ca_file` or `VIREAD_LAN_CA_CERT`) and validates an
RFC1918 / `.local` / `.lan` HTTPS origin on an explicit port with strict TLS
certificate and hostname verification (never disabling TLS verification).
"""
from __future__ import annotations

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


def _read(url: str, opener, *, accept: str = "text/html") -> tuple[int, str, str, str]:
    request = Request(url, headers={"User-Agent": USER_AGENT, "Accept": accept})
    try:
        response = opener.open(request, timeout=DEFAULT_TIMEOUT_SECONDS)
    except HTTPError as exc:
        response = exc  # NoRedirect yields the redirect as an HTTPError.
    with response:
        status = response.getcode()
        headers = response.headers
        location = headers.get("Location", "") or ""
        content_type = headers.get("Content-Type", "") or ""
        body = response.read(300_000).decode("utf-8", "replace") if status == 200 else ""
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


def verify_frontend(
    origin: str,
    opener=None,
    *,
    lan_mode: bool = False,
    ca_file: str | None = None,
    backend_health_url: str | None = None,
) -> None:
    base = canonical_origin(origin, lan_mode=lan_mode)
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


def main() -> int:
    lan_mode = os.environ.get("VIREAD_LAN_MODE", "").strip().lower() in {"1", "true", "yes", "on"}
    ca_file = os.environ.get("VIREAD_LAN_CA_CERT", "").strip() or None
    backend_health_url = os.environ.get("VIREAD_BACKEND_HEALTH_URL", "").strip() or None
    try:
        verify_frontend(
            os.environ.get("VIREAD_FRONTEND_URL", ""),
            lan_mode=lan_mode,
            ca_file=ca_file,
            backend_health_url=backend_health_url,
        )
    except Exception as exc:
        print(
            f"Frontend HTTPS readiness check failed: {type(exc).__name__}: {exc}",
            file=sys.stderr,
        )
        return 1
    mode_label = "LAN acceptance HTTPS" if lan_mode else "public HTTPS"
    print(f"Frontend root routing and ViRead Next.js /login HTML verified over {mode_label}.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
