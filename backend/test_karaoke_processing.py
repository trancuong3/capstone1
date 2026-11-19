"""Processing HTTP/auth and bounded-download tests, with no network or SQL."""
import unittest
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock, patch
from uuid import uuid4

import httpx
from fastapi import FastAPI, HTTPException
from fastapi.testclient import TestClient

from test_karaoke import ADMIN, PARENT, INACTIVE, MemoryRepository, MemoryStorage
from app.api.deps import get_current_parent_id
from app.api.routes.karaoke_processing import router, get_processing_service
from app.core.karaoke_processing_config import KaraokeProcessingConfig
from app.services.karaoke_processing_service import KaraokeProcessingService
from app.services.karaoke_storage_service import KaraokeStorage


class ProcessingApiTests(unittest.TestCase):
    def setUp(self):
        songs = MemoryRepository()
        repository = SimpleNamespace(songs=songs, read=songs.read, write=songs.write)
        self.service = KaraokeProcessingService(repository, MemoryStorage(songs), KaraokeProcessingConfig())
        self.app = FastAPI()
        self.app.include_router(router, prefix="/karaoke")
        self.app.dependency_overrides[get_processing_service] = lambda: self.service
        self.client = TestClient(self.app)
        self.song_id, self.job_id, self.draft_id = uuid4(), uuid4(), uuid4()

    def requests(self):
        for route in router.routes:
            path = "/karaoke" + route.path.replace("{song_id}", str(self.song_id)).replace("{job_id}", str(self.job_id))
            body = dict(expected_revision=1, draft_version_id=str(self.draft_id))
            if path.endswith("/processing-jobs") or path.endswith("/retry"):
                body["idempotency_key"] = str(uuid4())
            if path.endswith("/cancel"):
                body = {"draft_version_id": str(self.draft_id)}
            if path.endswith("/review"):
                body.update(content_fingerprint="a" * 64, confirmed_listened=True, acknowledged_flag_ids=[])
            yield next(iter(route.methods)), path, body

    def test_every_route_requires_auth(self):
        def deny():
            raise HTTPException(401, "Authentication required")
        self.app.dependency_overrides[get_current_parent_id] = deny
        for method, path, body in self.requests():
            with self.subTest(method=method, path=path):
                self.assertEqual(self.client.request(method, path, json=body).status_code, 401)

    def test_every_route_denies_parent_and_inactive_admin(self):
        for actor in (PARENT, INACTIVE):
            self.app.dependency_overrides[get_current_parent_id] = lambda: actor
            for method, path, body in self.requests():
                with self.subTest(actor=actor, method=method, path=path):
                    response = self.client.request(method, path, json=body)
                    self.assertEqual(response.status_code, 403, response.text)

    def test_capabilities_disabled_and_not_a_worker_health_claim(self):
        self.app.dependency_overrides[get_current_parent_id] = lambda: ADMIN
        response = self.client.get("/karaoke/admin/processing-capabilities")
        self.assertEqual(response.status_code, 200, response.text)
        data = response.json()
        self.assertEqual(data["unavailable_reason"], "DISABLED")
        self.assertFalse(data["enabled"])
        self.assertFalse(data["configured"])
        self.assertEqual(data["supported_modes"], [])
        self.assertEqual(data["limits"]["max_duration_ms"], 300000)
        self.assertNotIn("worker_alive", data)
        self.assertNotIn("python_path", data)

    def test_unknown_input_fields_and_unbounded_lists_rejected(self):
        self.app.dependency_overrides[get_current_parent_id] = lambda: ADMIN
        response = self.client.post(f"/karaoke/admin/songs/{self.song_id}/processing-jobs", json={
            "expected_revision": 1, "draft_version_id": str(self.draft_id),
            "idempotency_key": str(uuid4()), "audio_path": "arbitrary/injected",
        })
        self.assertEqual(response.status_code, 422)
        for query in ("limit=0", "limit=51", "offset=-1"):
            result = self.client.get(f"/karaoke/admin/songs/{self.song_id}/processing-jobs?{query}")
            self.assertEqual(result.status_code, 422)


class BoundedKaraokeDownloadTests(unittest.TestCase):
    def test_stream_is_bounded_and_rejects_redirect_encoding_truncation(self):
        storage, bucket, song_id = KaraokeStorage(), MagicMock(), uuid4()
        path = f"songs/{song_id}/versions/{uuid4()}/audio/{uuid4()}.mp3"
        bucket.info.return_value = {"size": 3, "content_type": "audio/mpeg"}
        for response, success in (
            (httpx.Response(200, content=b"abc"), True),
            (httpx.Response(200, content=b"ab"), False),
            (httpx.Response(200, content=b"abcd"), False),
            (httpx.Response(302, headers={"location": "https://evil.test/file"}), False),
            (httpx.Response(200, headers={"content-encoding": "identity", "content-length": "100"}, content=b"abc"), False),
        ):
            with self.subTest(status=response.status_code, success=success):
                requests = []
                def handle(request):
                    requests.append(request)
                    return response
                with httpx.Client(transport=httpx.MockTransport(handle)) as client:
                    def stream(method, url, **kwargs):
                        self.assertFalse(kwargs["follow_redirects"])
                        self.assertFalse(kwargs["trust_env"])
                        self.assertEqual(kwargs["headers"]["Accept-Encoding"], "identity")
                        return client.stream(method, url, follow_redirects=False, headers=kwargs["headers"])
                    with patch.object(storage, "_bucket", return_value=bucket), patch.object(
                        storage, "sign", return_value="https://example.supabase.co/test?token=not-a-secret"
                    ), patch("app.services.karaoke_storage_service.httpx.stream", side_effect=stream):
                        if success:
                            self.assertEqual(storage.download(path, song_id, 3), b"abc")
                        else:
                            with self.assertRaises(HTTPException) as error:
                                storage.download(path, song_id, 3)
                            self.assertEqual(error.exception.status_code, 503)
                            self.assertNotIn("token", str(error.exception.detail))
                    self.assertEqual(len(requests), 1)

    def test_invalid_scope_or_size_does_not_download(self):
        storage, song_id = KaraokeStorage(), uuid4()
        for size in (0, -1, True, 20971521):
            with self.subTest(size=size), patch("app.services.karaoke_storage_service.httpx.stream") as stream:
                with self.assertRaises(HTTPException):
                    storage.download("https://evil.test/file", song_id, size)
                stream.assert_not_called()


if __name__ == "__main__":
    unittest.main()
