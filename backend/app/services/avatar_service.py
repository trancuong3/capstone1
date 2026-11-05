"""Persistent profile and child avatar storage orchestration."""

from __future__ import annotations

import logging
from io import BytesIO
from uuid import UUID, uuid4

from fastapi import HTTPException, status
from PIL import Image, ImageOps, UnidentifiedImageError

from app.database.config import SUPABASE_AVATAR_BUCKET
from app.services.storage_service import (
    StorageUploadFailure,
    delete_object,
    upload_object,
)

logger = logging.getLogger(__name__)
MAX_AVATAR_BYTES = 5 * 1024 * 1024
MAX_AVATAR_PIXELS = 25_000_000
AVATAR_SIZE = 512
SUPPORTED_FORMATS = {
    "image/jpeg": "JPEG",
    "image/png": "PNG",
    "image/webp": "WEBP",
}


class AvatarFileValidationError(Exception):
    def __init__(self, message: str, http_status: int = status.HTTP_422_UNPROCESSABLE_ENTITY):
        super().__init__(message)
        self.http_status = http_status


class AvatarResourceNotFoundError(Exception):
    """Raised when an avatar owner or owned child cannot be found."""


def normalize_avatar_image(data: bytes, content_type: str | None) -> bytes:
    """Validate image bytes, strip metadata, and create a centered square WebP."""
    if not data:
        raise AvatarFileValidationError("Tệp ảnh đang trống.")
    if len(data) > MAX_AVATAR_BYTES:
        raise AvatarFileValidationError(
            "Ảnh cần có dung lượng tối đa 5 MB.",
            status.HTTP_413_CONTENT_TOO_LARGE,
        )

    normalized_type = (content_type or "").split(";", 1)[0].strip().lower()
    expected_format = SUPPORTED_FORMATS.get(normalized_type)
    if expected_format is None:
        raise AvatarFileValidationError("Chỉ hỗ trợ ảnh PNG, JPG hoặc WEBP.")

    try:
        with Image.open(BytesIO(data)) as source:
            if source.format != expected_format:
                raise AvatarFileValidationError(
                    "Định dạng tệp không khớp với nội dung ảnh."
                )
            if source.width * source.height > MAX_AVATAR_PIXELS:
                raise AvatarFileValidationError("Kích thước ảnh vượt quá giới hạn xử lý.")
            source.load()
            oriented = ImageOps.exif_transpose(source)
            has_alpha = "A" in oriented.getbands()
            image = oriented.convert("RGBA" if has_alpha else "RGB")

        side = min(image.size)
        left = (image.width - side) // 2
        top = (image.height - side) // 2
        image = image.crop((left, top, left + side, top + side))
        if side > AVATAR_SIZE:
            image.thumbnail(
                (AVATAR_SIZE, AVATAR_SIZE),
                Image.Resampling.LANCZOS,
            )

        output = BytesIO()
        image.save(output, format="WEBP", quality=90, method=6)
        return output.getvalue()
    except AvatarFileValidationError:
        raise
    except (UnidentifiedImageError, OSError, ValueError, Image.DecompressionBombError) as error:
        raise AvatarFileValidationError(
            "Tệp không phải là ảnh hợp lệ hoặc không thể đọc được."
        ) from error


def _old_object_to_remove(path: object, expected_prefix: str) -> str | None:
    if not isinstance(path, str) or not path.startswith(expected_prefix):
        return None
    if path.startswith(("http://", "https://")):
        return None
    return path


def _cleanup_object(path: str) -> None:
    delete_object(path, bucket_name=SUPABASE_AVATAR_BUCKET)


class AvatarService:
    """Coordinate ownership checks, Storage, and avatar-path persistence."""

    def __init__(self, profile_repository, child_repository):
        self.profile_repository = profile_repository
        self.child_repository = child_repository

    async def upload_parent_avatar(
        self,
        parent_id: UUID,
        data: bytes,
        content_type: str | None,
    ) -> None:
        profile = await self.profile_repository.get_by_id(parent_id)
        if profile is None:
            raise AvatarResourceNotFoundError()

        normalized_image = normalize_avatar_image(data, content_type)
        path = f"profiles/{parent_id}/avatar/{uuid4().hex}.webp"
        await self._persist_new_avatar(
            path,
            normalized_image,
            getattr(profile, "AvatarPath", None),
            lambda avatar_path: self.profile_repository.update_avatar_path(
                parent_id,
                avatar_path,
            ),
            f"profiles/{parent_id}/avatar/",
        )

    async def remove_parent_avatar(self, parent_id: UUID) -> None:
        profile = await self.profile_repository.get_by_id(parent_id)
        if profile is None:
            raise AvatarResourceNotFoundError()

        old_path = getattr(profile, "AvatarPath", None)
        try:
            updated = await self.profile_repository.update_avatar_path(
                parent_id,
                None,
            )
        except Exception as error:
            logger.error(
                "Avatar removal metadata update failed (exception_type=%s)",
                type(error).__name__,
            )
            raise HTTPException(
                status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
                detail="Could not update the avatar profile",
            ) from error
        if updated is None:
            raise AvatarResourceNotFoundError()
        path_to_remove = _old_object_to_remove(
            old_path,
            f"profiles/{parent_id}/avatar/",
        )
        if path_to_remove:
            _cleanup_object(path_to_remove)

    async def upload_child_avatar(
        self,
        parent_id: UUID,
        child_id: UUID,
        data: bytes,
        content_type: str | None,
    ) -> None:
        child = await self.child_repository.get_by_id_and_parent(child_id, parent_id)
        if child is None:
            raise AvatarResourceNotFoundError()

        normalized_image = normalize_avatar_image(data, content_type)
        path = f"children/{child_id}/avatar/{uuid4().hex}.webp"
        await self._persist_new_avatar(
            path,
            normalized_image,
            getattr(child, "AvatarPath", None),
            lambda avatar_path: self.child_repository.update_avatar_path(
                child_id,
                parent_id,
                avatar_path,
            ),
            f"children/{child_id}/avatar/",
        )

    async def remove_child_avatar(self, parent_id: UUID, child_id: UUID) -> None:
        child = await self.child_repository.get_by_id_and_parent(child_id, parent_id)
        if child is None:
            raise AvatarResourceNotFoundError()

        old_path = getattr(child, "AvatarPath", None)
        try:
            updated = await self.child_repository.update_avatar_path(
                child_id,
                parent_id,
                None,
            )
        except Exception as error:
            logger.error(
                "Child avatar removal metadata update failed (exception_type=%s)",
                type(error).__name__,
            )
            raise HTTPException(
                status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
                detail="Could not update the child avatar profile",
            ) from error
        if updated is None:
            raise AvatarResourceNotFoundError()
        path_to_remove = _old_object_to_remove(
            old_path,
            f"children/{child_id}/avatar/",
        )
        if path_to_remove:
            _cleanup_object(path_to_remove)

    async def _persist_new_avatar(
        self,
        path: str,
        image: bytes,
        previous_path: object,
        persist_path,
        old_path_prefix: str,
    ) -> None:
        try:
            upload_object(
                path,
                image,
                "image/webp",
                bucket_name=SUPABASE_AVATAR_BUCKET,
            )
        except StorageUploadFailure as error:
            if error.cleanup_may_be_needed:
                _cleanup_object(path)
            raise

        try:
            updated_entity = await persist_path(path)
            if updated_entity is None:
                _cleanup_object(path)
                raise AvatarResourceNotFoundError()
        except AvatarResourceNotFoundError:
            raise
        except Exception as error:
            _cleanup_object(path)
            logger.error(
                "Avatar metadata persistence failed (exception_type=%s)",
                type(error).__name__,
            )
            raise HTTPException(
                status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
                detail="Could not save the avatar profile",
            ) from error

        old_path = _old_object_to_remove(
            previous_path,
            old_path_prefix,
        )
        if old_path and old_path != path:
            _cleanup_object(old_path)
