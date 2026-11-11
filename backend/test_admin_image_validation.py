import os
import unittest
from io import BytesIO
from unittest.mock import MagicMock, patch

os.environ.setdefault("DATABASE_URL", "postgresql+asyncpg://test:test@127.0.0.1:1/test")
os.environ.setdefault("SUPABASE_URL", "https://example.supabase.co")
os.environ.setdefault("SUPABASE_KEY", "isolated-test-key")

from fastapi import UploadFile
from fastapi import HTTPException
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

    async def test_fake_extension_and_mime_are_rejected_by_actual_image_content(self):
        data = jpeg_bytes(width=80, height=120)
        for filename, content_type in (("page.png", "image/jpeg"), ("page.jpg", "image/png"), ("page.exe", "image/jpeg"), ("page", "image/jpeg")):
            file = UploadFile(file=BytesIO(data), filename=filename, headers=Headers({"content-type": content_type}))
            with self.assertRaises(HTTPException) as caught:
                await AdminOcrService(MagicMock())._read_validate_image(file)
            self.assertEqual(caught.exception.status_code, 415)

    async def test_corruption_and_empty_bytes_never_reach_ocr(self):
        for data in (b"", b"not an image", b"\xff\xd8\xff\xe0truncated"):
            with self.assertRaises(HTTPException) as caught:
                await AdminOcrService(MagicMock())._read_validate_image(self.make_upload(data))
            self.assertEqual(caught.exception.status_code, 422)

    async def test_size_and_dimension_limits_are_enforced(self):
        for data in (b"x" * (12 * 1024 * 1024 + 1), jpeg_bytes(width=6001, height=2)):
            with self.assertRaises(HTTPException) as caught:
                await AdminOcrService(MagicMock())._read_validate_image(self.make_upload(data))
            self.assertEqual(caught.exception.status_code, 413)

    async def test_oversized_dimensions_are_rejected_before_pixel_decode(self):
        with patch("app.services.admin_ocr_service.ImageOps.exif_transpose") as decode:
            with self.assertRaises(HTTPException) as caught:
                await AdminOcrService(MagicMock())._read_validate_image(self.make_upload(jpeg_bytes(width=6001, height=2)))
        self.assertEqual(caught.exception.status_code, 413)
        decode.assert_not_called()

    async def test_supported_formats_and_uppercase_extensions_keep_correct_signature(self):
        for image_format, extension, content_type in (("JPEG", "JPEG", "image/jpeg"), ("PNG", "PNG", "image/png"), ("WEBP", "WEBP", "image/webp")):
            buffer = BytesIO()
            Image.new("RGB", (80, 120)).save(buffer, format=image_format)
            file = UploadFile(file=BytesIO(buffer.getvalue()), filename=f"page.{extension}", headers=Headers({"content-type": content_type}))
            data, actual_type, _, width, height = await AdminOcrService(MagicMock())._read_validate_image(file)
            self.assertEqual((actual_type, width, height), (content_type, 80, 120))
            with Image.open(BytesIO(data)) as image:
                self.assertEqual(image.format, image_format)


if __name__ == "__main__":
    unittest.main()
