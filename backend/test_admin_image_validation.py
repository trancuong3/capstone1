import os
import unittest
from io import BytesIO
from unittest.mock import MagicMock

os.environ.setdefault("DATABASE_URL", "postgresql+asyncpg://test:test@127.0.0.1:1/test")
os.environ.setdefault("SUPABASE_URL", "https://example.supabase.co")
os.environ.setdefault("SUPABASE_KEY", "isolated-test-key")

from fastapi import UploadFile
from PIL import Image
from starlette.datastructures import Headers

from app.services.admin_ocr_service import AdminOcrService


def jpeg_bytes(*, width: int, height: int, orientation: int | None = None) -> bytes:
    image = Image.new("RGB", (width, height), color=(240, 230, 210))
    output = BytesIO()
    kwargs = {}
    if orientation is not None:
        exif = Image.Exif()
        exif[274] = orientation
        kwargs["exif"] = exif
    image.save(output, format="JPEG", quality=90, **kwargs)
    return output.getvalue()


class AdminImageValidationTests(unittest.IsolatedAsyncioTestCase):
    def make_upload(self, data: bytes) -> UploadFile:
        return UploadFile(
            file=BytesIO(data),
            filename="book-page.jpg",
            headers=Headers({"content-type": "image/jpeg"}),
        )

    async def test_exif_rotated_jpeg_is_normalized_before_storage_and_ocr(self):
        original = jpeg_bytes(width=80, height=160, orientation=6)
        service = AdminOcrService(MagicMock())

        normalized, content_type, extension, width, height = (
            await service._read_validate_image(self.make_upload(original))
        )

        self.assertEqual(content_type, "image/jpeg")
        self.assertEqual(extension, "jpg")
        self.assertEqual((width, height), (160, 80))
        with Image.open(BytesIO(normalized)) as image:
            self.assertEqual(image.size, (160, 80))
            self.assertIn(image.format, ("JPEG", "JPG"))
            self.assertEqual(image.getexif().get(274, 1), 1)

    async def test_image_without_exif_rotation_keeps_original_dimensions(self):
        original = jpeg_bytes(width=240, height=360)
        service = AdminOcrService(MagicMock())

        normalized, content_type, extension, width, height = (
            await service._read_validate_image(self.make_upload(original))
        )

        self.assertEqual(normalized, original)
        self.assertEqual(content_type, "image/jpeg")
        self.assertEqual(extension, "jpg")
        self.assertEqual((width, height), (240, 360))


if __name__ == "__main__":
    unittest.main()
