"""Offline tests for the production HTTPS /login and safe-root-redirect gate."""
import unittest

from verify_frontend import canonical_origin, verify_frontend


HTML = (
    '<!doctype html><html lang="vi"><head><title>Đăng nhập | ViRead</title></head>'
    '<body><script src="/_next/static/chunks/app.js"></script></body></html>'
)


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
        return self.responses[request.full_url]


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

    def test_rejects_unexpected_root_redirect_path(self):
        self.pages[self.origin + "/"] = Response(308, headers={"Location": "/dashboard"})
        with self.assertRaisesRegex(ValueError, "same-origin"):
            verify_frontend(self.origin, self.opener)

    def test_rejects_non_200_login_and_wrong_content_type(self):
        self.pages[self.origin + "/login"] = Response(302, headers={"Location": "/register"})
        with self.assertRaisesRegex(ValueError, "HTTP 302"):
            verify_frontend(self.origin, self.opener)
        self.pages[self.origin + "/login"] = Response(200, HTML, {"Content-Type": "application/json"})
        with self.assertRaisesRegex(ValueError, "not a ViRead Next.js"):
            verify_frontend(self.origin, self.opener)

    def test_rejects_generic_nextjs_application(self):
        generic = HTML.replace("ViRead", "Generic Application")
        self.pages[self.origin + "/login"] = Response(200, generic, {"Content-Type": "text/html"})
        with self.assertRaisesRegex(ValueError, "not a ViRead Next.js"):
            verify_frontend(self.origin, self.opener)

    def test_rejects_static_placeholder_and_fastapi_json(self):
        for content_type, body in [
            ("text/html", "<html>ViRead placeholder</html>"),
            ("application/json", '{"status":"ok","name":"ViRead"}'),
        ]:
            with self.subTest(content_type=content_type):
                self.pages[self.origin + "/login"] = Response(200, body, {"Content-Type": content_type})
                with self.assertRaisesRegex(ValueError, "not a ViRead Next.js"):
                    verify_frontend(self.origin, self.opener)

    def test_rejects_root_404(self):
        self.pages[self.origin + "/"] = Response(404)
        with self.assertRaisesRegex(ValueError, "HTTP 404"):
            verify_frontend(self.origin, self.opener)

    def test_invalid_origins_rejected_before_network_call(self):
        for value in [
            "", "http://viread.example.com", "https://localhost", "https://127.0.0.1",
            "https://viread.example.com/extra", "https://viread.example.com?token=1",
            "https://user:pass@viread.example.com", "https://viread.example.com:8443",
            "https://viread.internal", "https://viread.example.com/#fragment",
        ]:
            with self.subTest(value=value):
                with self.assertRaises(ValueError):
                    canonical_origin(value)
        self.assertEqual(canonical_origin(self.origin + "/"), self.origin)


if __name__ == "__main__":
    unittest.main()
