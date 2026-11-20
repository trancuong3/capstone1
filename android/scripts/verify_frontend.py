#!/usr/bin/env python3
"""CI guard: the supplied public HTTPS origin must serve a real Next.js document."""
import os
import sys
from urllib.parse import urlsplit
from urllib.request import Request, urlopen


def main() -> int:
    url = os.environ.get("VIREAD_FRONTEND_URL", "").strip()
    parsed = urlsplit(url)
    hostname = (parsed.hostname or "").lower()
    if (
        parsed.scheme != "https"
        or not hostname
        or hostname == "localhost"
        or hostname.endswith((".local", ".invalid"))
        or parsed.username is not None
        or parsed.password is not None
        or parsed.port not in (None, 443)
        or parsed.path not in ("", "/")
        or parsed.query
        or parsed.fragment
        or "." not in hostname
        or hostname.replace(".", "").isdigit()
    ):
        print("Invalid public HTTPS frontend origin.", file=sys.stderr)
        return 1

    try:
        request = Request(url, headers={"User-Agent": "ViRead-Android-CI/1.0"})
        with urlopen(request, timeout=18) as response:
            final = urlsplit(response.geturl())
            body = response.read(300_000).decode("utf-8", "replace")
            if final.scheme != "https" or final.hostname != hostname:
                raise ValueError("Redirected outside configured origin")
            if "<html" not in body.lower() or "/_next/" not in body:
                raise ValueError("Origin does not appear to serve Next.js")
    except Exception as exc:
        print(f"Frontend HTTPS readiness check failed: {type(exc).__name__}: {exc}", file=sys.stderr)
        return 1
    print("Frontend HTTPS Next.js response verified; Android packaging can proceed.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
