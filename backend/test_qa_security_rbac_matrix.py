"""Regression matrix for DEF-001 and DEF-002 security, RBAC, and validation fixes."""
from __future__ import annotations

import inspect
import os
import unittest
from datetime import datetime, timezone
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock, patch
from uuid import UUID, uuid4

os.environ.setdefault("APP_ENVIRONMENT", "test")
os.environ.setdefault("DATABASE_URL", "postgresql+asyncpg://test:test@127.0.0.1:55450/test")
os.environ.setdefault("SUPABASE_URL", "https://example.supabase.co")
os.environ.setdefault("SUPABASE_KEY", "test-publishable-key")

from fastapi import FastAPI, HTTPException
from fastapi.testclient import TestClient
from sqlalchemy.dialects import postgresql

from app.api.deps import (
    get_current_parent_id,
    get_db,
    require_active_profile_id,
    require_admin_id,
    require_parent_id,
)
from app.api.router import api_router
from app.api.routes import voice as voice_routes
from app.api.routes.profile import ChildProfileRepository
from app.providers.elevenlabs_voice_provider import Transcription
from app.repositories.child_progress_repository import ChildProgressRepository
from app.repositories.reading_presence_repository import ReadingPresenceRepository
from app.services.avatar_service import AvatarService

PARENT_A = UUID("11111111-1111-4111-8111-111111111111")
PARENT_B = UUID("22222222-2222-4222-8222-222222222222")
INACTIVE_PARENT = UUID("33333333-3333-4333-8333-333333333333")
ADMIN_ID = UUID("44444444-4444-4444-8444-444444444444")
CHILD_A = UUID("55555555-5555-4555-8555-555555555555")
SESSION_A = UUID("66666666-6666-4666-8666-666666666666")
BOOK_ID = UUID("77777777-7777-4777-8777-777777777777")
PAGE_ID = UUID("88888888-8888-4888-8888-888888888888")
REV_ID = UUID("99999999-9999-4999-8999-999999999999")


class _MatrixFakeDb:
    """Minimal AsyncSession substitute supporting real active/role lookups in RBAC tests."""

    def __init__(self) -> None:
        self.profiles = {
            PARENT_A: ("parent", 1),
            PARENT_B: ("parent", 1),
            INACTIVE_PARENT: ("parent", 0),
            ADMIN_ID: ("admin", 1),
        }
        self.children = {
            CHILD_A: SimpleNamespace(
                Id=CHILD_A,
                ParentId=PARENT_A,
                Alias="Bé An",
                Grade=2,
                Settings={},
                AvatarPath=None,
                CreatedAt=datetime(2026, 1, 1, tzinfo=timezone.utc),
            )
        }
        self.added: list[object] = []
        self.committed = 0

    async def scalar(self, statement):
        compiled = statement.compile(dialect=postgresql.dialect())
        sql = str(compiled).lower()
        params = compiled.params
        if "from profiles" in sql:
            for val in params.values():
                if isinstance(val, UUID) and val in self.profiles:
                    role, active = self.profiles[val]
                    if active == 1:
                        return role
                    return None
            return None
        if "from childprofiles" in sql:
            vals = list(params.values())
            for child in self.children.values():
                if child.Id in vals and child.ParentId in vals:
                    p_role, p_active = self.profiles.get(child.ParentId, (None, 0))
                    if p_active == 1 and p_role == "parent":
                        return child
            return None
        if "from readingsessions" in sql:
            return None
        return None

    async def execute(self, statement):
        compiled = statement.compile(dialect=postgresql.dialect())
        sql = str(compiled).lower()
        params = compiled.params
        result = MagicMock()
        if "from childprofiles" in sql:
            rows = []
            for child in self.children.values():
                if child.ParentId in params.values():
                    p_role, p_active = self.profiles.get(child.ParentId, (None, 0))
                    if p_active == 1 and p_role == "parent":
                        rows.append(child)
            result.scalars.return_value.all.return_value = rows
            result.scalar_one_or_none.return_value = rows[0] if rows else None
            result.first.return_value = (rows[0],) if rows else None
            return result
        if "from reading_presence_settings" in sql:
            result.scalar_one_or_none.return_value = None
            return result
        result.scalars.return_value.all.return_value = []
        result.scalar_one_or_none.return_value = None
        result.first.return_value = None
        return result

    def add(self, obj) -> None:
        self.added.append(obj)

    async def commit(self) -> None:
        self.committed += 1

    async def rollback(self) -> None:
        return None

    async def refresh(self, _obj) -> None:
        return None


class Def001BookRoutesTests(unittest.TestCase):
    def test_duplicate_admin_catalog_post_route_removed(self):
        app = FastAPI()
        app.include_router(api_router)
        post_catalog_paths = [
            route
            for route in app.routes
            if getattr(route, "path", None) == "/books/admin/catalog"
            and "POST" in (getattr(route, "methods", None) or set())
        ]
        self.assertEqual(len(post_catalog_paths), 1)
        self.assertEqual(post_catalog_paths[0].endpoint.__module__, "app.api.routes.book")

    def test_book_pages_sanitizes_raw_paths_and_processing_meta(self):
        db = MagicMock()
        app = FastAPI()
        app.include_router(api_router)
        app.dependency_overrides[get_db] = lambda: db
        client = TestClient(app)

        raw_page = SimpleNamespace(
            Id=PAGE_ID,
            BookId=BOOK_ID,
            PageNumber=1,
            ImagePath="books/b1/pages/p1/secret-raw-key.png",
            Width=800,
            Height=1200,
            FeaturePath="features/secret.npy",
            ProcessingMeta={"ocr_state": "DONE", "internal_bucket": "private"},
            LifecycleStatus="ACTIVE",
            CurrentVerifiedRevisionId=REV_ID,
            CreatedAt=datetime(2026, 1, 1, tzinfo=timezone.utc),
        )
        public_url_page = SimpleNamespace(
            Id=uuid4(),
            BookId=BOOK_ID,
            PageNumber=2,
            ImagePath="https://example.supabase.co/storage/v1/object/sign/public.png",
            Width=800,
            Height=1200,
            FeaturePath="features/secret2.npy",
            ProcessingMeta={"raw": "meta"},
            LifecycleStatus="ACTIVE",
            CurrentVerifiedRevisionId=REV_ID,
            CreatedAt=datetime(2026, 1, 1, tzinfo=timezone.utc),
        )

        with patch(
            "app.api.routes.book.BookService.list_pages",
            new=AsyncMock(return_value=[raw_page, public_url_page]),
        ):
            resp = client.get(f"/books/{BOOK_ID}/pages")

        self.assertEqual(resp.status_code, 200)
        body = resp.json()
        self.assertEqual(len(body), 2)
        self.assertEqual(body[0]["ImagePath"], "")
        self.assertIsNone(body[0]["FeaturePath"])
        self.assertEqual(body[0]["ProcessingMeta"], {})
        self.assertEqual(
            body[1]["ImagePath"],
            "https://example.supabase.co/storage/v1/object/sign/public.png",
        )
        self.assertIsNone(body[1]["FeaturePath"])
        self.assertEqual(body[1]["ProcessingMeta"], {})


class Def002RbacMatrixTests(unittest.IsolatedAsyncioTestCase):
    def _client(self, actor_id: UUID | None, db: _MatrixFakeDb) -> TestClient:
        app = FastAPI()
        app.include_router(api_router)
        app.dependency_overrides[get_db] = lambda: db
        if actor_id is not None:
            app.dependency_overrides[get_current_parent_id] = lambda: actor_id
        return TestClient(app)

    def test_role_resource_action_matrix(self):
        protected_parent_endpoints = [
            ("GET", "/profiles/children", None),
            ("POST", "/profiles/children", {"alias": "Bé", "grade": 2}),
            ("GET", f"/profiles/children/{CHILD_A}", None),
            ("PUT", f"/profiles/children/{CHILD_A}", {"alias": "Bé Mới", "grade": 3}),
            ("DELETE", f"/profiles/children/{CHILD_A}", None),
            ("DELETE", f"/profiles/children/{CHILD_A}/avatar", None),
            ("GET", "/reading-presence/settings", None),
            ("PUT", "/reading-presence/settings", {"email_enabled": True}),
            (
                "POST",
                "/support/feedback",
                {"category": "other", "subject": "Giúp tôi", "message": "Nội dung hỗ trợ đủ dài"},
            ),
        ]
        active_profile_endpoints = [
            ("DELETE", "/profiles/me/avatar", None),
            ("GET", "/voice/status", None),
            ("GET", "/voice/voices", None),
        ]

        # 1. Guest (unauthenticated) -> 401 across all protected routes, DB untouched
        guest_db = _MatrixFakeDb()
        guest_client = self._client(None, guest_db)
        for method, path, body in protected_parent_endpoints + active_profile_endpoints:
            res = guest_client.request(method, path, json=body)
            self.assertEqual(res.status_code, 401, f"guest {method} {path}")
        self.assertEqual(guest_db.committed, 0)
        self.assertEqual(guest_db.added, [])

        # 2. Inactive parent (Active=0) -> 403 across ALL parent + active-profile routes
        inactive_db = _MatrixFakeDb()
        inactive_client = self._client(INACTIVE_PARENT, inactive_db)
        for method, path, body in protected_parent_endpoints + active_profile_endpoints:
            res = inactive_client.request(method, path, json=body)
            self.assertEqual(res.status_code, 403, f"inactive {method} {path}")
        self.assertEqual(inactive_db.committed, 0)
        self.assertEqual(inactive_db.added, [])

        # 3. Admin (Active=1, Role="admin"): 403 on parent-only routes, allowed on active-profile routes
        admin_db = _MatrixFakeDb()
        admin_client = self._client(ADMIN_ID, admin_db)
        for method, path, body in protected_parent_endpoints:
            res = admin_client.request(method, path, json=body)
            self.assertEqual(res.status_code, 403, f"admin blocked on {method} {path}")
        with patch.object(
            voice_routes,
            "get_voice_orchestrator",
            return_value=SimpleNamespace(
                get_status=AsyncMock(return_value={"status": "ok"}),
                list_voices=AsyncMock(
                    return_value={
                        "voices": [],
                        "default_voice_id": "v1",
                        "local_worker_ready": True,
                        "google_tts_available": False,
                    }
                ),
            ),
        ):
            self.assertEqual(admin_client.get("/voice/status").status_code, 200)
            self.assertEqual(admin_client.get("/voice/voices").status_code, 200)

        # 4. Parent B accessing Parent A's child/avatar -> 404 (no cross-family access)
        b_db = _MatrixFakeDb()
        b_client = self._client(PARENT_B, b_db)
        for method, path, body in (
            ("GET", f"/profiles/children/{CHILD_A}", None),
            ("PUT", f"/profiles/children/{CHILD_A}", {"alias": "Hack", "grade": 2}),
            ("DELETE", f"/profiles/children/{CHILD_A}", None),
            ("DELETE", f"/profiles/children/{CHILD_A}/avatar", None),
        ):
            res = b_client.request(method, path, json=body)
            self.assertEqual(res.status_code, 404, f"parent_b {method} {path}")
        self.assertEqual(b_db.committed, 0)

        # 5. Active Parent A succeeds on own child
        a_db = _MatrixFakeDb()
        a_client = self._client(PARENT_A, a_db)
        res_list = a_client.get("/profiles/children")
        self.assertEqual(res_list.status_code, 200)
        self.assertEqual(len(res_list.json()), 1)

    async def test_require_dependencies_enforce_active_flag_and_roles(self):
        db = _MatrixFakeDb()
        self.assertEqual(await require_parent_id(PARENT_A, db), PARENT_A)
        self.assertEqual(await require_admin_id(ADMIN_ID, db), ADMIN_ID)
        self.assertEqual(await require_active_profile_id(PARENT_A, db), PARENT_A)
        self.assertEqual(await require_active_profile_id(ADMIN_ID, db), ADMIN_ID)

        for bad_call in (
            require_parent_id(INACTIVE_PARENT, db),
            require_parent_id(ADMIN_ID, db),
            require_admin_id(PARENT_A, db),
            require_active_profile_id(INACTIVE_PARENT, db),
        ):
            with self.assertRaises(HTTPException) as ctx:
                await bad_call
            self.assertEqual(ctx.exception.status_code, 403)

    async def test_repositories_and_avatar_service_enforce_active_parent(self):
        db = MagicMock()
        db.execute = AsyncMock(return_value=MagicMock())
        db.scalar = AsyncMock(return_value=None)

        await ChildProfileRepository(db).list_by_parent(PARENT_A)
        sql_list = str(db.execute.await_args.args[0].compile(dialect=postgresql.dialect())).lower()
        self.assertIn("join profiles", sql_list)
        self.assertIn("profiles.active =", sql_list)

        await ChildProgressRepository(db).owned_child(CHILD_A, PARENT_A)
        sql_child = str(db.scalar.await_args.args[0].compile(dialect=postgresql.dialect())).lower()
        self.assertIn("join profiles", sql_child)
        self.assertIn("profiles.active =", sql_child)

        await ReadingPresenceRepository(db).owned_session(SESSION_A, PARENT_A)
        sql_pres = str(db.execute.await_args.args[0].compile(dialect=postgresql.dialect())).lower()
        self.assertIn("join profiles", sql_pres)
        self.assertIn("profiles.active =", sql_pres)

        # AvatarService rejects Active=0 before touching storage
        inactive_profile = SimpleNamespace(Id=INACTIVE_PARENT, Active=0, AvatarPath=None)
        profile_repo = MagicMock(get_by_id=AsyncMock(return_value=inactive_profile))
        child_repo = MagicMock()
        svc = AvatarService(profile_repo, child_repo)
        with patch("app.services.avatar_service.upload_object") as upload_mock:
            with self.assertRaises(HTTPException) as ctx:
                await svc.upload_parent_avatar(INACTIVE_PARENT, b"fake", "image/png")
            self.assertEqual(ctx.exception.status_code, 403)
            upload_mock.assert_not_called()

    def test_stt_keyterms_bounded_and_nfc_normalized(self):
        app = FastAPI()
        app.include_router(voice_routes.router, prefix="/voice")
        app.dependency_overrides[require_active_profile_id] = lambda: PARENT_A
        client = TestClient(app)

        fake_orch = MagicMock()
        fake_orch.transcribe = AsyncMock(
            return_value=SimpleNamespace(
                text="con mèo",
                language_code="vi",
                language_probability=0.99,
                words=[],
                provider="local",
                model_version="v1",
                fallback_used=False,
                fallback_reason=None,
            )
        )

        with patch.object(voice_routes, "get_voice_orchestrator", return_value=fake_orch):
            # > 50 items rejected
            res_many = client.post(
                "/voice/speech-to-text",
                files={"file": ("a.webm", b"audio-bytes", "audio/webm")},
                data={"keyterms": [f"tu{i}" for i in range(51)]},
            )
            self.assertEqual(res_many.status_code, 422)
            self.assertEqual(res_many.json()["detail"]["code"], "TOO_MANY_KEYTERMS")

            # > 80 chars rejected
            res_long = client.post(
                "/voice/speech-to-text",
                files={"file": ("a.webm", b"audio-bytes", "audio/webm")},
                data={"keyterms": ["a" * 81]},
            )
            self.assertEqual(res_long.status_code, 422)
            self.assertEqual(res_long.json()["detail"]["code"], "KEYTERM_TOO_LONG")

            # NFD + duplicate normalized to single NFC item
            res_ok = client.post(
                "/voice/speech-to-text",
                files={"file": ("a.webm", b"audio-bytes", "audio/webm")},
                data={"keyterms": ["me\u0300o", "mèo", "  chó  "]},
            )
            self.assertEqual(res_ok.status_code, 200)
            self.assertEqual(fake_orch.transcribe.await_args.kwargs["keyterms"], ["mèo", "chó"])


if __name__ == "__main__":
    unittest.main()
