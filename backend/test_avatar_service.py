"""Avatar validation and Storage/DB ordering contracts."""

import os
import unittest
from datetime import datetime, timezone
from io import BytesIO
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch
from uuid import UUID

os.environ.setdefault("DATABASE_URL", "postgresql+asyncpg://test:test@127.0.0.1:1/test")
os.environ.setdefault("SUPABASE_URL", "https://example.supabase.co")
os.environ.setdefault("SUPABASE_KEY", "isolated-test-key")

from fastapi import HTTPException
from PIL import Image

from app.services import avatar_service
from app.services.profile_service import ProfileService
from app.services.storage_service import StorageUploadFailure

PARENT_ID = UUID("22222222-2222-4222-8222-222222222222")
OTHER_PARENT_ID = UUID("44444444-4444-4444-8444-444444444444")
CHILD_ID = UUID("33333333-3333-4333-8333-333333333333")


def image_bytes(image_format: str, size: tuple[int, int] = (800, 400)) -> bytes:
    buffer = BytesIO()
    Image.new("RGB", size, (30, 100, 180)).save(buffer, format=image_format)
    return buffer.getvalue()


class AvatarImageValidationTests(unittest.TestCase):
    def test_accepts_jpeg_png_and_webp_and_outputs_square_webp(self):
        formats = {
            "JPEG": "image/jpeg",
            "PNG": "image/png",
            "WEBP": "image/webp",
        }
        for image_format, content_type in formats.items():
            with self.subTest(image_format=image_format):
                normalized = avatar_service.normalize_avatar_image(
                    image_bytes(image_format), content_type
                )
                with Image.open(BytesIO(normalized)) as output:
                    self.assertEqual(output.format, "WEBP")
                    self.assertEqual(output.size, (400, 400))

    def test_large_square_image_is_reduced_to_512_pixels(self):
        normalized = avatar_service.normalize_avatar_image(
            image_bytes("PNG", (1200, 1200)), "image/png"
        )
        with Image.open(BytesIO(normalized)) as output:
            self.assertEqual(output.size, (512, 512))

    def test_rejects_empty_oversized_unsupported_and_mismatched_files(self):
        cases = (
            (b"", "image/png", 422),
            (b"x" * (avatar_service.MAX_AVATAR_BYTES + 1), "image/png", 413),
            (image_bytes("PNG"), "image/gif", 422),
            (image_bytes("PNG"), "image/jpeg", 422),
        )
        for data, content_type, expected_status in cases:
            with self.subTest(content_type=content_type, size=len(data)):
                with self.assertRaises(avatar_service.AvatarFileValidationError) as raised:
                    avatar_service.normalize_avatar_image(data, content_type)
                self.assertEqual(raised.exception.http_status, expected_status)


class AvatarStorageLifecycleTests(unittest.IsolatedAsyncioTestCase):
    def make_service(self, *, parent=None, child=None):
        profile_repository = SimpleNamespace(
            get_by_id=AsyncMock(return_value=parent),
            update_avatar_path=AsyncMock(return_value=parent),
        )
        child_repository = SimpleNamespace(
            get_by_id_and_parent=AsyncMock(return_value=child),
            update_avatar_path=AsyncMock(return_value=child),
        )
        return (
            avatar_service.AvatarService(profile_repository, child_repository),
            profile_repository,
            child_repository,
        )

    async def test_parent_replacement_persists_new_path_before_deleting_old_object(self):
        parent = SimpleNamespace(AvatarPath=f"profiles/{PARENT_ID}/avatar/old.webp")
        service, repository, _ = self.make_service(parent=parent)
        events: list[str] = []

        def upload(*args, **kwargs):
            events.append("upload")

        async def persist(*args, **kwargs):
            events.append("persist")
            return parent

        def delete(*args, **kwargs):
            events.append("delete")

        repository.update_avatar_path.side_effect = persist
        with (
            patch.object(avatar_service, "upload_object", side_effect=upload),
            patch.object(avatar_service, "delete_object", side_effect=delete),
        ):
            await service.upload_parent_avatar(PARENT_ID, image_bytes("PNG"), "image/png")

        self.assertEqual(events, ["upload", "persist", "delete"])
        args = repository.update_avatar_path.await_args.args
        self.assertEqual(args[0], PARENT_ID)
        self.assertRegex(args[1], rf"^profiles/{PARENT_ID}/avatar/.+\.webp$")

    async def test_child_upload_checks_parent_ownership_before_storage(self):
        service, _, child_repository = self.make_service(child=None)
        with patch.object(avatar_service, "upload_object") as upload:
            with self.assertRaises(avatar_service.AvatarResourceNotFoundError):
                await service.upload_child_avatar(
                    OTHER_PARENT_ID,
                    CHILD_ID,
                    image_bytes("PNG"),
                    "image/png",
                )
        child_repository.get_by_id_and_parent.assert_awaited_once_with(
            CHILD_ID, OTHER_PARENT_ID
        )
        upload.assert_not_called()

    async def test_child_avatar_uses_child_object_path(self):
        child = SimpleNamespace(AvatarPath=None)
        service, _, child_repository = self.make_service(child=child)
        stored_paths: list[str] = []

        async def persist(child_id, parent_id, path):
            stored_paths.append(path)
            return child

        child_repository.update_avatar_path.side_effect = persist
        with patch.object(avatar_service, "upload_object") as upload:
            await service.upload_child_avatar(
                PARENT_ID,
                CHILD_ID,
                image_bytes("PNG"),
                "image/png",
            )

        self.assertRegex(stored_paths[0], rf"^children/{CHILD_ID}/avatar/.+\.webp$")
        upload.assert_called_once()
        self.assertEqual(upload.call_args.args[0], stored_paths[0])

    async def test_profile_reads_parent_and_child_signed_urls(self):
        child = SimpleNamespace(
            Id=CHILD_ID,
            Alias="Bé An",
            Grade=2,
            CreatedAt=datetime(2026, 10, 2, tzinfo=timezone.utc),
            AvatarPath=f"children/{CHILD_ID}/avatar/child.webp",
        )
        profile = SimpleNamespace(
            Id=PARENT_ID,
            DisplayName="Ba mẹ An",
            Role="parent",
            CreatedAt=child.CreatedAt,
            ContactPhone=None,
            AvatarPath=f"profiles/{PARENT_ID}/avatar/parent.webp",
            children=[child],
        )
        repository = SimpleNamespace(get_by_id=AsyncMock(return_value=profile))
        contact_provider = SimpleNamespace(
            get_contact_info=AsyncMock(
                return_value={
                    "email": "parent@example.com",
                    "pending_email": None,
                    "email_verified": True,
                    "contact_info_status": "available",
                }
            )
        )
        service = ProfileService(repository, contact_provider)

        with patch(
            "app.services.profile_service.create_signed_image_url",
            side_effect=lambda path, **_: f"https://signed.example/{path}",
        ) as sign_url:
            result = await service.get_current_profile(PARENT_ID)

        self.assertEqual(result["avatar_url"], f"https://signed.example/{profile.AvatarPath}")
        self.assertEqual(
            result["children"][0]["avatar_url"],
            f"https://signed.example/{child.AvatarPath}",
        )
        self.assertEqual(sign_url.call_count, 2)

    async def test_parent_removal_clears_database_before_deleting_object(self):
        old_path = f"profiles/{PARENT_ID}/avatar/parent.webp"
        parent = SimpleNamespace(AvatarPath=old_path)
        service, repository, _ = self.make_service(parent=parent)
        events: list[str] = []

        async def clear(*args):
            events.append("clear")
            return parent

        repository.update_avatar_path.side_effect = clear
        with patch.object(
            avatar_service,
            "delete_object",
            side_effect=lambda *args, **kwargs: events.append("delete"),
        ):
            await service.remove_parent_avatar(PARENT_ID)

        self.assertEqual(events, ["clear", "delete"])
        repository.update_avatar_path.assert_awaited_once_with(PARENT_ID, None)

    async def test_database_failure_cleans_new_object_and_preserves_old_avatar(self):
        old_path = f"profiles/{PARENT_ID}/avatar/old.webp"
        parent = SimpleNamespace(AvatarPath=old_path)
        service, repository, _ = self.make_service(parent=parent)
        repository.update_avatar_path.side_effect = RuntimeError("private database detail")
        uploaded: list[str] = []
        deleted: list[str] = []

        def upload(path, *args, **kwargs):
            uploaded.append(path)

        with (
            patch.object(avatar_service, "upload_object", side_effect=upload),
            patch.object(avatar_service, "delete_object", side_effect=lambda path, **_: deleted.append(path)),
        ):
            with self.assertRaises(HTTPException) as raised:
                await service.upload_parent_avatar(PARENT_ID, image_bytes("PNG"), "image/png")

        self.assertEqual(raised.exception.status_code, 503)
        self.assertNotIn("private database detail", raised.exception.detail)
        self.assertEqual(deleted, uploaded)
        self.assertEqual(parent.AvatarPath, old_path)

    async def test_ambiguous_storage_failure_attempts_new_object_cleanup(self):
        parent = SimpleNamespace(AvatarPath=None)
        service, _, _ = self.make_service(parent=parent)
        with (
            patch.object(
                avatar_service,
                "upload_object",
                side_effect=StorageUploadFailure(
                    "safe failure", cleanup_may_be_needed=True
                ),
            ),
            patch.object(avatar_service, "delete_object") as delete,
        ):
            with self.assertRaises(StorageUploadFailure):
                await service.upload_parent_avatar(PARENT_ID, image_bytes("PNG"), "image/png")

        delete.assert_called_once()
        self.assertRegex(delete.call_args.args[0], rf"^profiles/{PARENT_ID}/avatar/.+\.webp$")

    async def test_removal_clears_database_before_deleting_owned_object(self):
        old_path = f"children/{CHILD_ID}/avatar/old.webp"
        child = SimpleNamespace(AvatarPath=old_path)
        service, _, child_repository = self.make_service(child=child)
        events: list[str] = []

        async def clear(*args):
            events.append("clear")
            return child

        child_repository.update_avatar_path.side_effect = clear
        with patch.object(
            avatar_service,
            "delete_object",
            side_effect=lambda *args, **kwargs: events.append("delete"),
        ):
            await service.remove_child_avatar(PARENT_ID, CHILD_ID)

        self.assertEqual(events, ["clear", "delete"])
        child_repository.update_avatar_path.assert_awaited_once_with(
            CHILD_ID, PARENT_ID, None
        )


if __name__ == "__main__":
    unittest.main()
