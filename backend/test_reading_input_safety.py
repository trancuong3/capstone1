"""Reading write limits must not prevent reading older, larger history rows."""
from copy import deepcopy
from datetime import datetime, timezone
import unittest
from uuid import uuid4
from io import BytesIO
from unittest.mock import AsyncMock, patch

from pydantic import ValidationError
from fastapi import UploadFile
from starlette.datastructures import Headers
from app.schemas.reading import ReadingEventCreate, ReadingEventResponse
from app.services.admin_ocr_service import AdminOcrService
import test_admin_ocr_upload_failure as upload_fixture
import test_admin_image_validation as image_fixture


def payload(metadata):
    return dict(SessionId=uuid4(), PageId=uuid4(), PageRevisionId=uuid4(),
                Type="WORD_RETRY", StartMs=0, Status="FAILED", Metadata=metadata)


class ReadingInputSafetyTests(unittest.TestCase):
    def test_large_ascii_metadata_is_rejected_before_a_service_or_database_write(self):
        with self.assertRaises(ValidationError):
            ReadingEventCreate(**payload({"note": "a" * (64 * 1024)}))

    def test_metadata_limit_counts_utf8_bytes_and_preserves_vietnamese(self):
        with self.assertRaises(ValidationError):
            ReadingEventCreate(**payload({"note": "đ" * 40_000}))
        value = {"recognized_text": "Bé đọc đúng dấu: đỏ, đa, đi.", "retry_attempt": 1}
        before = deepcopy(value)
        result = ReadingEventCreate(**payload(value))
        self.assertEqual(result.Metadata, before)
        self.assertEqual(value, before)

    def test_non_finite_metadata_cannot_reach_jsonb(self):
        for number in (float("nan"), float("inf"), -float("inf")):
            with self.subTest(number=number), self.assertRaises(ValidationError):
                ReadingEventCreate(**payload({"confidence": number}))

    def test_larger_historical_metadata_remains_readable_without_rewriting_it(self):
        value = {"note": "legacy" * 20_000}
        row = {**payload(value), "Id": uuid4(), "WordId": None, "CreatedAt": datetime.now(timezone.utc)}
        result = ReadingEventResponse(**row)
        self.assertEqual(result.Metadata, value)


class ImageFilenameSafetyTests(unittest.IsolatedAsyncioTestCase):
    async def test_traversal_filenames_never_control_the_storage_object_key(self):
        for filename in ("../../outside.jpg", r"..\..\outside.jpg"):
            with self.subTest(filename=filename):
                service = upload_fixture.AdminOcrUploadFailureTests().make_service()
                service._read_validate_image = AdminOcrService._read_validate_image.__get__(service)
                service._cleanup_uploaded_object = AsyncMock()
                image = UploadFile(file=BytesIO(image_fixture.jpeg_bytes(width=80, height=120)),
                                   filename=filename, headers=Headers({"content-type": "image/jpeg"}))
                with patch("app.services.admin_ocr_service.upload_object", side_effect=RuntimeError("isolated storage stop")) as upload:
                    with self.assertRaisesRegex(RuntimeError, "isolated storage stop"):
                        await service.upload_page(upload_fixture.ACTOR_ID, upload_fixture.BOOK_ID, image)
                key = upload.call_args.args[0]
                self.assertRegex(key, rf"^books/{upload_fixture.BOOK_ID}/pages/[0-9a-f-]{{36}}/[0-9a-f]{{32}}\.jpg$")
                self.assertNotIn("..", key)
                self.assertNotIn("outside", key)
                self.assertNotIn("\\", key)
