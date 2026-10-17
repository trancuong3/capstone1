"""Isolated HTTP/auth/service/provider integration, without live Supabase or AI."""

import json
import os
import unittest
from unittest.mock import AsyncMock, MagicMock, patch
from uuid import UUID, uuid4

import httpx

os.environ.setdefault("DATABASE_URL", "postgresql+asyncpg://test:test@127.0.0.1:1/test")
os.environ.setdefault("SUPABASE_URL", "https://example.supabase.co")
os.environ.setdefault("SUPABASE_KEY", "isolated-test-key")

from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.api.deps import get_current_parent_id
from app.api.routes import tutor as tutor_routes
from app.models import Book, BookPage, ChildProfile, PageRevision, PageRevisionWord, Profile, ReadingSession
from app.providers.gemini_tutor_provider import GeminiTutorProvider, TutorProviderError
from app.repositories.tutor_repository import TutorPageRecord, TutorRepository, TutorSessionRecord
from app.schemas.tutor import TutorExplanation
from app.services.tutor_service import TutorService


PARENT_ID = UUID("11111111-1111-4111-8111-111111111111")
CHILD_ID = UUID("22222222-2222-4222-8222-222222222222")
BOOK_ID = UUID("33333333-3333-4333-8333-333333333333")
PAGE_ID = UUID("44444444-4444-4444-8444-444444444444")
REVISION_ID = UUID("55555555-5555-4555-8555-555555555555")
WORD_ID = UUID("66666666-6666-4666-8666-666666666666")
SESSION_ID = UUID("77777777-7777-4777-8777-777777777777")

EXPLANATION = {
    "explanation": "Nghiêng là lệch sang một bên.",
    "reading_hint": "Bé đọc lại câu có từ nghiêng nhé.",
}


class TutorApiTests(unittest.TestCase):
    def setUp(self):
        self.profile = Profile(Id=PARENT_ID, Role="parent", Active=1)
        self.child = ChildProfile(Id=CHILD_ID, ParentId=PARENT_ID, Grade=1)
        self.session = ReadingSession(
            Id=SESSION_ID, ChildId=CHILD_ID, BookId=BOOK_ID,
            SelectedPageId=PAGE_ID, SelectedPageRevisionId=REVISION_ID,
            State="IN_PROGRESS", EndedAt=None,
        )
        self.book = Book(Id=BOOK_ID, LifecycleStatus="ACTIVE")
        self.page = BookPage(Id=PAGE_ID, BookId=BOOK_ID, LifecycleStatus="ACTIVE")
        self.revision = PageRevision(
            Id=REVISION_ID, PageId=PAGE_ID,
            VerificationStatus="VERIFIED", VerifiedText="Bé nghiêng đầu.",
        )
        self.repository = MagicMock(spec=TutorRepository)
        self.repository.profile.return_value = self.profile
        self.repository.owned_session.return_value = TutorSessionRecord(self.session, self.child)
        self.repository.page_revision.return_value = TutorPageRecord(self.book, self.page, self.revision)
        self.repository.revision_words.return_value = [
            PageRevisionWord(
                Id=WORD_ID if index == 1 else uuid4(),
                PageRevisionId=REVISION_ID, WordIndex=index, Text=word,
            )
            for index, word in enumerate(self.revision.VerifiedText.split())
        ]
        self.provider = MagicMock()
        self.provider.explain_word = AsyncMock(return_value=TutorExplanation(**EXPLANATION))
        self.service = TutorService(self.repository, self.provider)
        self.app = FastAPI()
        self.app.include_router(tutor_routes.router, prefix="/tutor")
        self.app.dependency_overrides[tutor_routes.get_tutor_service] = lambda: self.service
        self.app.dependency_overrides[get_current_parent_id] = lambda: PARENT_ID
        self.url = f"/tutor/sessions/{SESSION_ID}/explain-word"
        self.payload = {"page_revision_id": str(REVISION_ID), "word_id": str(WORD_ID)}

    def request(self, **changes):
        with TestClient(self.app) as client:
            return client.post(self.url, json={**self.payload, **changes})

    def test_success_calls_provider_after_authorization_and_returns_public_contract(self):
        response = self.request()
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.headers["cache-control"], "no-store")
        self.assertEqual(response.json(), {
            "page_revision_id": str(REVISION_ID), "word_id": str(WORD_ID),
            "word": "nghiêng", **EXPLANATION,
        })
        self.repository.owned_session.assert_awaited_once_with(SESSION_ID, PARENT_ID)
        self.provider.explain_word.assert_awaited_once_with(
            word="nghiêng", context_text="Bé nghiêng đầu.", grade=1,
            word_start=3, word_end=10,
        )
        self.assertEqual(self.session.State, "IN_PROGRESS")
        self.assertIsNone(self.session.EndedAt)

    def test_route_service_and_real_adapter_work_together_with_mock_http(self):
        requests = []

        def google(request):
            requests.append(request)
            return httpx.Response(200, json={
                "candidates": [{
                    "finishReason": "STOP",
                    "content": {
                        "role": "model",
                        "parts": [{"text": json.dumps(EXPLANATION, ensure_ascii=False)}],
                    },
                }],
            })

        provider = GeminiTutorProvider(
            "isolated-tutor-test-key", "gemini-test", transport=httpx.MockTransport(google)
        )
        self.service = TutorService(self.repository, provider)
        response = self.request()
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["explanation"], EXPLANATION["explanation"])
        self.assertEqual(response.json()["word_id"], str(WORD_ID))
        self.assertEqual(len(requests), 1)
        payload = json.loads(requests[0].content)
        data = json.loads(payload["contents"][0]["parts"][0]["text"])
        self.assertEqual(set(data), {"word", "context_text", "grade", "word_start", "word_end"})
        self.assertEqual(data["context_text"][data["word_start"]:data["word_end"]], "nghiêng")

    def test_missing_bearer_token_is_rejected_by_existing_auth_dependency(self):
        del self.app.dependency_overrides[get_current_parent_id]
        response = self.request()
        self.assertEqual(response.status_code, 401)
        self.repository.profile.assert_not_awaited()
        self.provider.explain_word.assert_not_awaited()

    def test_invalid_token_does_not_reach_repository_or_expose_auth_error(self):
        del self.app.dependency_overrides[get_current_parent_id]
        supabase = MagicMock()
        supabase.auth.get_user.side_effect = RuntimeError("sensitive auth response")
        with patch("app.api.deps.get_supabase_client", return_value=supabase):
            with TestClient(self.app) as client:
                response = client.post(self.url, json=self.payload, headers={
                    "Authorization": "Bearer isolated-invalid-token"
                })
        self.assertEqual(response.status_code, 401)
        self.assertNotIn("sensitive", response.text)
        self.repository.profile.assert_not_awaited()
        self.provider.explain_word.assert_not_awaited()

    def test_verified_token_identity_is_used_instead_of_client_supplied_identity(self):
        del self.app.dependency_overrides[get_current_parent_id]
        supabase = MagicMock()
        supabase.auth.get_user.return_value = MagicMock(user=MagicMock(id=str(PARENT_ID)))
        with patch("app.api.deps.get_supabase_client", return_value=supabase):
            with TestClient(self.app) as client:
                response = client.post(self.url, json=self.payload, headers={
                    "Authorization": "Bearer isolated-valid-token"
                })
        self.assertEqual(response.status_code, 200)
        supabase.auth.get_user.assert_called_once_with("isolated-valid-token")
        self.repository.profile.assert_awaited_once_with(PARENT_ID)

    def test_request_rejects_extra_context_missing_fields_and_invalid_ids(self):
        invalid = [
            {}, {"page_revision_id": str(REVISION_ID)},
            {**self.payload, "word_id": "invalid"},
            {**self.payload, "parent_id": str(PARENT_ID)},
            {**self.payload, "prompt": "client instruction"},
            {**self.payload, "grade": 5},
        ]
        with TestClient(self.app) as client:
            for payload in invalid:
                with self.subTest(payload=payload):
                    response = client.post(self.url, json=payload)
                    self.assertEqual(response.status_code, 422)
            response = client.post("/tutor/sessions/invalid/explain-word", json=self.payload)
            self.assertEqual(response.status_code, 422)
        self.repository.profile.assert_not_awaited()
        self.provider.explain_word.assert_not_awaited()

    def test_admin_and_inactive_parent_are_forbidden_before_provider(self):
        for role, active in (("admin", 1), ("parent", 0)):
            with self.subTest(role=role, active=active):
                self.profile.Role, self.profile.Active = role, active
                self.assertEqual(self.request().status_code, 403)
        self.repository.owned_session.assert_not_awaited()
        self.provider.explain_word.assert_not_awaited()

    def test_missing_and_foreign_session_return_safe_not_found(self):
        self.repository.owned_session.return_value = None
        response = self.request()
        self.assertEqual(response.status_code, 404)
        self.assertEqual(response.json(), {"detail": "Reading session not found"})
        self.provider.explain_word.assert_not_awaited()

    def test_stale_revision_is_rejected_before_provider(self):
        self.assertEqual(self.request(page_revision_id=str(uuid4())).status_code, 409)
        self.repository.page_revision.assert_not_awaited()
        self.provider.explain_word.assert_not_awaited()

    def test_wrong_word_is_rejected_before_provider(self):
        self.assertEqual(self.request(word_id=str(uuid4())).status_code, 409)
        self.provider.explain_word.assert_not_awaited()

    def test_unverified_content_and_finished_session_do_not_call_provider(self):
        self.revision.VerificationStatus = "NEEDS_REVIEW"
        self.assertEqual(self.request().status_code, 409)
        self.revision.VerificationStatus = "VERIFIED"
        self.session.State = "COMPLETED"
        self.assertEqual(self.request().status_code, 409)
        self.provider.explain_word.assert_not_awaited()

    def test_provider_errors_are_safe_and_correlated_without_logging_content(self):
        for status in (502, 503):
            with self.subTest(status=status):
                self.provider.explain_word.side_effect = TutorProviderError(status)
                with self.assertLogs("app.services.tutor_service", level="WARNING") as logs:
                    response = self.request()
                self.assertEqual(response.status_code, status)
                self.assertEqual(response.json(), {"detail": "Tutor is temporarily unavailable"})
                self.assertEqual(response.headers["cache-control"], "no-store")
                self.assertIn("tutor_explanation_unavailable", " ".join(logs.output))
                self.assertNotIn("Bé nghiêng đầu", " ".join(logs.output))
                self.assertNotIn("Gemini", response.text)

    def test_missing_gemini_config_returns_real_503_instead_of_fake_explanation(self):
        with patch.dict(os.environ, {"GEMINI_API_KEY": "", "GEMINI_TUTOR_MODEL": ""}):
            self.service = TutorService(self.repository)
            with self.assertLogs("app.services.tutor_service", level="WARNING"):
                response = self.request()
        self.assertEqual(response.status_code, 503)
        self.assertNotIn("explanation", response.json())

    def test_invalid_provider_data_cannot_override_ids_or_public_response(self):
        self.provider.explain_word.return_value = {
            **EXPLANATION, "word_id": str(uuid4()), "provider_metadata": "private"
        }
        with self.assertLogs("app.services.tutor_service", level="WARNING") as logs:
            response = self.request()
        self.assertEqual(response.status_code, 502)
        self.assertNotIn("private", response.text)
        self.assertNotIn("private", " ".join(logs.output))

    def test_factory_connects_service_to_read_only_repository_without_database_io(self):
        db = MagicMock()
        service = tutor_routes.get_tutor_service(db)
        self.assertIsInstance(service, TutorService)
        self.assertIsInstance(service.repository, TutorRepository)
        self.assertIs(service.repository.db, db)
        db.execute.assert_not_called()
        db.commit.assert_not_called()

    def test_openapi_has_supabase_bearer_and_only_public_response_fields(self):
        schema = self.app.openapi()
        operation = schema["paths"]["/tutor/sessions/{session_id}/explain-word"]["post"]
        self.assertIn({"HTTPBearer": []}, operation["security"])
        response_schema = schema["components"]["schemas"]["TutorExplainWordResponse"]
        self.assertEqual(set(response_schema["properties"]), {
            "page_revision_id", "word_id", "word", "explanation", "reading_hint",
        })


if __name__ == "__main__":
    unittest.main()
