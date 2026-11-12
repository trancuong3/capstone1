"""Safety tests for the disposable VietOCR migration database bootstrap."""

import os
import unittest
from unittest.mock import patch

from prepare_viread_ocr_test_schema import _test_database_dsn


class TestDatabaseDsnTests(unittest.TestCase):
    def test_accepts_only_loopback_test_database(self):
        with patch.dict(
            os.environ,
            {
                "ADMIN_OCR_TEST_DATABASE_URL": (
                    "postgresql+asyncpg://test:test@127.0.0.1:5432/test"
                )
            },
        ):
            self.assertEqual(
                _test_database_dsn(),
                "postgresql://test:test@127.0.0.1:5432/test",
            )

    def test_rejects_remote_database(self):
        with patch.dict(
            os.environ,
            {
                "ADMIN_OCR_TEST_DATABASE_URL": (
                    "postgresql+asyncpg://test:test@db.example.test:5432/test"
                )
            },
        ):
            with self.assertRaisesRegex(RuntimeError, "Refusing to prepare"):
                _test_database_dsn()

    def test_rejects_other_local_database_names(self):
        with patch.dict(
            os.environ,
            {
                "ADMIN_OCR_TEST_DATABASE_URL": (
                    "postgresql+asyncpg://test:test@localhost:5432/production"
                )
            },
        ):
            with self.assertRaisesRegex(RuntimeError, "Refusing to prepare"):
                _test_database_dsn()

    def test_requires_explicit_test_database_url(self):
        with patch.dict(os.environ, {}, clear=True):
            with self.assertRaisesRegex(
                RuntimeError, "ADMIN_OCR_TEST_DATABASE_URL must point"
            ):
                _test_database_dsn()


if __name__ == "__main__":
    unittest.main()
