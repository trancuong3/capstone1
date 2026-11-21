#!/usr/bin/env python3
"""Validate that an HTTPS origin serves the actual server-backed ViRead Next.js login.

The check is read-only. It never submits credentials or follows redirects to other
origins. Android packaging must fail closed when production is not verified.
"""
from __future__ import annotations

import os
import sys
from urllib.error import HTTPError
from urllib.parse import urljoin, urlsplit
from urllib.request import HTTPRedirectHandler, Request, build_opener

REDIRECT_CODES = {301, 302, 303, 307, 308}
USER_AGENT = "ViRead-Android-CI/1.0"


class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def canonical_origin(value: str) -> str:
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
        or hostname == "localhost"
        or hostname.endswith((".local", ".invalid", ".internal", ".test"))
        or parsed.username is not None
        or parsed.password is not None
        or port not in (None, 443)
        or parsed.path not in ("", "/")
        or parsed.query
        or parsed.fragment
        or "." not in hostname
        or hostname.replace(".", "").isdigit()
        or ":" in hostname
        or any(part == "" for part in hostname.split("."))
    ):
        raise ValueError("VIREAD_FRONTEND_URL must be a public HTTPS origin without path, credentials or query")
    return f"https://{hostname}"


def _read(url: str, opener) -> tuple[int, str, str, str]:
    request = Request(url, headers={"User-Agent": USER_AGENT, "Accept": "text/html"})
    try:
        response = opener.open(request, timeout=18)
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
    return (
        "text/html" in content_type.lower()
        and "<html" in lower
        and "/_next/" in body
        and "viread" in lower
    )


def verify_frontend(origin: str, opener=None) -> None:
    base = canonical_origin(origin)
    opener = opener or build_opener(NoRedirect())

    # Next.js frontend/app/page.tsx calls redirect("/login"). A 307 at /
    # is expected and MUST NOT be misclassified as an invalid deployment.
    root_status, location, root_type, root_body = _read(base + "/", opener)
    if root_status in REDIRECT_CODES:
        if not location:
            raise ValueError("Frontend root redirects without a Location header")
        resolved = urlsplit(urljoin(base + "/", location))
        if (
            resolved.scheme != "https"
            or resolved.hostname != urlsplit(base).hostname
            or resolved.port not in (None, 443)
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
        raise ValueError(f"Frontend root returned HTTP {root_status}, expected HTML or redirect to /login")

    login_status, _, login_type, login_body = _read(base + "/login", opener)
    if login_status != 200:
        raise ValueError(f"Frontend /login returned HTTP {login_status}, expected 200")
    if not _is_viread_next_document(login_type, login_body):
        raise ValueError("Frontend /login is not a ViRead Next.js HTML page")


def main() -> int:
    try:
        verify_frontend(os.environ.get("VIREAD_FRONTEND_URL", ""))
    except Exception as exc:
        print(f"Frontend HTTPS readiness check failed: {type(exc).__name__}: {exc}", file=sys.stderr)
        return 1
    print("Frontend root routing and ViRead Next.js /login HTML verified over HTTPS.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
