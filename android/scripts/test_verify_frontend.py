"""Offline & failure-mode tests for the Android HTTPS frontend/backend preflight gate.

Covers:
- valid public HTTPS origin & Next.js 307 same-origin /login redirect
- LAN acceptance mode ONLY when explicitly configured with valid PEM CA cert
- TLS errors, HTTP downgrade, redirect loops, cross-origin redirects, timeouts
- static Project Hub dashboard HTML rejection
- backend health endpoint returning HTML or malformed JSON
- CLI main() non-zero exit code blocking packaging on preflight failure
"""
import os
import ssl
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from verify_frontend import canonical_origin, main, verify_frontend


HTML = (
    '<!doctype html><html lang="vi"><head><title>Đăng nhập | ViRead</title></head>'
    '<body><script src="/_next/static/chunks/app.js"></script></body></html>'
)

PROJECT_HUB_HTML = (
    '<!doctype html><html lang="vi"><head><title>ViRead Project Hub</title></head>'
    '<body><script src="/_next/fake.js"></script><h1>ViRead Project Hub</h1></body></html>'
)

VALID_HEALTH_JSON = '{"status":"ok","database":{"status":"healthy"},"ocr":{"ready":true}}'


class Response:
    def __init__(self, status, body="", headers=None):
        self.status = status
        self.body = body.encode("utf-8")
        self.headers = headers or {}

    def getcode(self):
        return self.status

    def read(self, count):
        return self.body[:count]

    def __enter__(self):
        return self

    def __exit__(self, *_):
        return None


class Opener:
    def __init__(self, responses):
        self.responses = responses
        self.urls = []

    def open(self, request, timeout):
        self.urls.append(request.full_url)
        if timeout != 18:
            raise AssertionError("Timeout must be bounded")
        item = self.responses[request.full_url]
        if isinstance(item, BaseException):
            raise item
        return item


class ProductionOriginTests(unittest.TestCase):
    origin = "https://viread.example.com"

    def setUp(self):
        self.pages = {
            self.origin + "/": Response(307, headers={"Location": "/login"}),
            self.origin + "/login": Response(200, HTML, headers={"Content-Type": "text/html; charset=utf-8"}),
        }
        self.opener = Opener(self.pages)

    def test_nextjs_307_to_same_origin_login_is_expected(self):
        verify_frontend(self.origin, self.opener)
        self.assertEqual(self.opener.urls, [self.origin + "/", self.origin + "/login"])

    def test_absolute_same_origin_login_redirect_allowed(self):
        self.pages[self.origin + "/"] = Response(307, headers={"Location": self.origin + "/login"})
        verify_frontend(self.origin, self.opener)

    def test_root_200_allowed_when_it_is_real_viread_next_html(self):
        self.pages[self.origin + "/"] = Response(200, HTML, {"Content-Type": "text/html"})
        verify_frontend(self.origin, self.opener)

    def test_rejects_external_redirect_even_if_target_is_https(self):
        self.pages[self.origin + "/"] = Response(307, headers={"Location": "https://evil.example/login"})
        with self.assertRaisesRegex(ValueError, "same-origin"):
            verify_frontend(self.origin, self.opener)
        self.assertEqual(self.opener.urls, [self.origin + "/"])

    def test_rejects_redirect_with_login_query_or_fragment(self):
        for location in ["/login?next=https://evil.example", "/login#fragment", "//evil.example/login"]:
            with self.subTest(location=location):
                self.opener.urls.clear()
                self.pages[self.origin + "/"] = Response(307, headers={"Location": location})
                with self.assertRaisesRegex(ValueError, "same-origin"):
                    verify_frontend(self.origin, self.opener)

    def test_rejects_unexpected_root_redirect_path_and_login_redirect_loop(self):
        self.pages[self.origin + "/"] = Response(308, headers={"Location": "/dashboard"})
        with self.assertRaisesRegex(ValueError, "same-origin"):
            verify_frontend(self.origin, self.opener)

        self.pages[self.origin + "/"] = Response(307, headers={"Location": "/login"})
        self.pages[self.origin + "/login"] = Response(307, headers={"Location": "/login"})
        with self.assertRaisesRegex(ValueError, "redirect"):
            verify_frontend(self.origin, self.opener)

    def test_rejects_non_200_login_and_wrong_content_type(self):
        self.pages[self.origin + "/login"] = Response(302, headers={"Location": "/register"})
        with self.assertRaisesRegex(ValueError, "HTTP 302"):
            verify_frontend(self.origin, self.opener)
        self.pages[self.origin + "/login"] = Response(200, HTML, {"Content-Type": "application/json"})
        with self.assertRaisesRegex(ValueError, "not a ViRead Next.js"):
            verify_frontend(self.origin, self.opener)

    def test_rejects_project_hub_dashboard_generic_next_placeholder_and_fastapi_json(self):
        generic = HTML.replace("ViRead", "Generic Application")
        for content_type, body in [
            ("text/html", PROJECT_HUB_HTML),
            ("text/html", generic),
            ("text/html", "<html>ViRead placeholder</html>"),
            ("application/json", '{"status":"ok","name":"ViRead"}'),
        ]:
            with self.subTest(body=body[:35]):
                self.pages[self.origin + "/login"] = Response(200, body, {"Content-Type": content_type})
                with self.assertRaisesRegex(ValueError, "not a ViRead Next.js"):
                    verify_frontend(self.origin, self.opener)

    def test_rejects_tls_error_timeout_and_root_404(self):
        self.pages[self.origin + "/"] = ssl.SSLCertVerificationError(1, "certificate verify failed")
        with self.assertRaises(ssl.SSLCertVerificationError):
            verify_frontend(self.origin, self.opener)

        self.pages[self.origin + "/"] = TimeoutError("timed out")
        with self.assertRaises(TimeoutError):
            verify_frontend(self.origin, self.opener)

        self.pages[self.origin + "/"] = Response(404)
        with self.assertRaisesRegex(ValueError, "HTTP 404"):
            verify_frontend(self.origin, self.opener)

    def test_invalid_origins_rejected_before_network_call(self):
        for value in [
            "", "http://viread.example.com", "https://localhost", "https://127.0.0.1",
            "https://192.168.1.4:8443", "https://viread.example.com/extra",
            "https://viread.example.com?token=1", "https://user:pass@viread.example.com",
            "https://viread.example.com:8443", "https://viread.internal",
            "https://viread.example.com/#fragment",
        ]:
            with self.subTest(value=value):
                with self.assertRaises(ValueError):
                    canonical_origin(value)
        self.assertEqual(canonical_origin(self.origin + "/"), self.origin)


class LanAcceptanceModeTests(unittest.TestCase):
    lan_origin = "https://192.168.1.4:8443"

    def setUp(self):
        self.pages = {
            self.lan_origin + "/": Response(307, headers={"Location": "/login"}),
            self.lan_origin + "/login": Response(200, HTML, {"Content-Type": "text/html; charset=utf-8"}),
            self.lan_origin + "/_viread_api/health": Response(
                200, VALID_HEALTH_JSON, {"Content-Type": "application/json"}
            ),
        }
        self.opener = Opener(self.pages)

    def test_lan_origin_accepted_only_with_lan_mode_and_valid_backend_health(self):
        # Default mode MUST reject LAN IP/port
        with self.assertRaises(ValueError):
            canonical_origin(self.lan_origin, lan_mode=False)

        # LAN mode accepts RFC1918 IP + explicit port and checks same-origin redirect + backend health
        self.assertEqual(canonical_origin(self.lan_origin + "/", lan_mode=True), self.lan_origin)
        verify_frontend(
            self.lan_origin,
            self.opener,
            lan_mode=True,
            backend_health_url=self.lan_origin + "/_viread_api/health",
        )
        self.assertEqual(
            self.opener.urls,
            [self.lan_origin + "/", self.lan_origin + "/login", self.lan_origin + "/_viread_api/health"],
        )

    def test_lan_mode_rejects_loopback_http_wrong_port_redirect_and_bad_ca_file(self):
        for bad in ["https://127.0.0.1:8443", "https://localhost:8443", "http://192.168.1.4:8443", "https://8.8.8.8:8443"]:
            with self.subTest(bad=bad):
                with self.assertRaises(ValueError):
                    canonical_origin(bad, lan_mode=True)

        # Redirect to a different port must fail
        self.pages[self.lan_origin + "/"] = Response(307, headers={"Location": "https://192.168.1.4:8444/login"})
        with self.assertRaisesRegex(ValueError, "same-origin"):
            verify_frontend(self.lan_origin, self.opener, lan_mode=True)

        # Missing CA cert when using real opener fails closed
        with self.assertRaisesRegex(ValueError, "VIREAD_LAN_CA_CERT"):
            verify_frontend(self.lan_origin, opener=None, lan_mode=True, ca_file=None)

        # CA file without BEGIN CERTIFICATE must be rejected
        with tempfile.NamedTemporaryFile("w", suffix=".pem", delete=False, encoding="utf-8") as bad_tmp:
            bad_tmp.write("not a pem certificate at all\n")
            bad_ca_path = bad_tmp.name
        try:
            with self.assertRaisesRegex(ValueError, "PEM certificate"):
                verify_frontend(self.lan_origin, self.opener, lan_mode=True, ca_file=bad_ca_path)
        finally:
            Path(bad_ca_path).unlink(missing_ok=True)

        # CA file containing a private key must be rejected
        with tempfile.NamedTemporaryFile("w", suffix=".pem", delete=False, encoding="utf-8") as tmp:
            tmp.write("-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----\n")
            key_path = tmp.name
        try:
            with self.assertRaisesRegex(ValueError, "private key"):
                verify_frontend(self.lan_origin, self.opener, lan_mode=True, ca_file=key_path)
        finally:
            Path(key_path).unlink(missing_ok=True)

    def test_backend_health_rejects_html_and_invalid_json_contract(self):
        for content_type, body in [
            ("text/html", "<html>not json</html>"),
            ("application/json", "{invalid-json"),
            ("application/json", '{"hello":"world"}'),
        ]:
            with self.subTest(body=body):
                self.pages[self.lan_origin + "/_viread_api/health"] = Response(
                    200, body, {"Content-Type": content_type}
                )
                with self.assertRaises(ValueError):
                    verify_frontend(
                        self.lan_origin,
                        self.opener,
                        lan_mode=True,
                        backend_health_url=self.lan_origin + "/_viread_api/health",
                    )

    def test_cli_main_returns_nonzero_to_block_packaging_on_failure(self):
        with patch.dict(os.environ, {"VIREAD_FRONTEND_URL": "http://192.168.1.4:3000"}, clear=True):
            self.assertEqual(main(), 1)
        with patch.dict(
            os.environ,
            {"VIREAD_FRONTEND_URL": "https://192.168.1.4:8443", "VIREAD_LAN_MODE": "1"},
            clear=True,
        ):
            # Missing VIREAD_LAN_CA_CERT blocks packaging
            self.assertEqual(main(), 1)


class BackendMobileCorsPreflightTests(unittest.TestCase):
    origin = "https://viread.example.com"
    backend = "https://api.viread.example.com"

    def setUp(self):
        self.routes = {
            ("GET", self.origin + "/"): Response(307, headers={"Location": "/login"}),
            ("GET", self.origin + "/login"): Response(
                200, HTML, headers={"Content-Type": "text/html; charset=utf-8"}
            ),
            ("GET", self.backend + "/health"): Response(
                200, VALID_HEALTH_JSON, headers={"Content-Type": "application/json"}
            ),
            ("OPTIONS", self.backend + "/profiles/children"): Response(
                200,
                "",
                headers={
                    "Access-Control-Allow-Origin": self.origin,
                    "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
                    "Access-Control-Allow-Headers": "Authorization, Content-Type",
                    "Access-Control-Allow-Credentials": "true",
                },
            ),
            ("GET", self.backend + "/profiles/children"): Response(
                401,
                '{"detail":"Not authenticated"}',
                headers={
                    "Content-Type": "application/json",
                    "Access-Control-Allow-Origin": self.origin,
                },
            ),
        }
        self.requests = []

        outer = self

        class MethodAwareOpener:
            def open(self, request, timeout):
                if timeout != 18:
                    raise AssertionError("Timeout must be bounded")
                method = request.get_method()
                headers = {k.lower(): v for k, v in request.header_items()}
                outer.requests.append((method, request.full_url, headers))
                item = outer.routes[(method, request.full_url)]
                if isinstance(item, BaseException):
                    raise item
                return item

        self.opener = MethodAwareOpener()

    def test_valid_backend_url_verifies_health_cors_options_and_401_json(self):
        verify_frontend(self.origin, self.opener, backend_url=self.backend + "/")
        self.assertEqual(
            [(m, u) for m, u, _ in self.requests],
            [
                ("GET", self.origin + "/"),
                ("GET", self.origin + "/login"),
                ("GET", self.backend + "/health"),
                ("OPTIONS", self.backend + "/profiles/children"),
                ("GET", self.backend + "/profiles/children"),
            ],
        )
        options_headers = self.requests[3][2]
        self.assertEqual(options_headers["origin"], self.origin)
        self.assertIn("authorization", options_headers["access-control-request-headers"].lower())

    def test_rejects_wildcard_or_mismatched_cors_origin_and_missing_auth_header_allowance(self):
        for bad_headers, expected_msg in [
            (
                {
                    "Access-Control-Allow-Origin": "*",
                    "Access-Control-Allow-Methods": "GET, OPTIONS",
                    "Access-Control-Allow-Headers": "Authorization",
                },
                "Access-Control-Allow-Origin",
            ),
            (
                {
                    "Access-Control-Allow-Origin": "https://other.example.com",
                    "Access-Control-Allow-Methods": "GET, OPTIONS",
                    "Access-Control-Allow-Headers": "Authorization",
                },
                "Access-Control-Allow-Origin",
            ),
            (
                {
                    "Access-Control-Allow-Origin": self.origin,
                    "Access-Control-Allow-Methods": "GET, OPTIONS",
                    "Access-Control-Allow-Headers": "Content-Type",
                },
                "Authorization",
            ),
        ]:
            with self.subTest(expected_msg=expected_msg):
                self.routes[("OPTIONS", self.backend + "/profiles/children")] = Response(
                    200, "", headers=bad_headers
                )
                with self.assertRaisesRegex(ValueError, expected_msg):
                    verify_frontend(self.origin, self.opener, backend_url=self.backend)

    def test_rejects_non_401_or_html_on_unauthenticated_endpoint_and_http_backend(self):
        with self.assertRaisesRegex(ValueError, "HTTPS"):
            verify_frontend(self.origin, self.opener, backend_url="http://api.viread.example.com")

        self.routes[("GET", self.backend + "/profiles/children")] = Response(
            200, "[]", headers={"Content-Type": "application/json"}
        )
        with self.assertRaisesRegex(ValueError, "expected 401"):
            verify_frontend(self.origin, self.opener, backend_url=self.backend)

        self.routes[("GET", self.backend + "/profiles/children")] = Response(
            401, "<html>login</html>", headers={"Content-Type": "text/html"}
        )
        with self.assertRaisesRegex(ValueError, "application/json"):
            verify_frontend(self.origin, self.opener, backend_url=self.backend)

    def test_cli_backend_url_flag_rejects_invalid_backend_url(self):
        with patch.dict(os.environ, {"VIREAD_FRONTEND_URL": self.origin}, clear=True):
            self.assertEqual(main(["--backend-url", "http://insecure.example.com"]), 1)


if __name__ == "__main__":
    unittest.main()
