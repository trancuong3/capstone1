from __future__ import annotations

import importlib.util
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch


REPO_ROOT = Path(__file__).resolve().parents[1]
BACKEND_ROOT = REPO_ROOT / "backend"
BUNDLE_SCRIPT_PATH = REPO_ROOT / "scripts" / "build_hf_space_bundle.py"


def _load_bundle_module():
    spec = importlib.util.spec_from_file_location("build_hf_space_bundle", BUNDLE_SCRIPT_PATH)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"Unable to load bundle script from {BUNDLE_SCRIPT_PATH}")
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


bundle_mod = _load_bundle_module()


class HfSpaceBundleZeroDbTests(unittest.TestCase):
    def test_build_and_verify_bundle_imports_without_app_database(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            bundle_dir = Path(tmp) / "hf-ocr-space"
            summary = bundle_mod.build_hf_space_bundle(bundle_dir)
            self.assertLess(summary["total_bytes"], bundle_mod.MAX_BUNDLE_TOTAL_BYTES)
            self.assertTrue(summary["standalone_imports_verified"])
            self.assertFalse((bundle_dir / "backend" / "app" / "database").exists())

    def test_verify_bundle_fails_closed_if_ocr_engine_reintroduces_app_database_import(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            bundle_dir = Path(tmp) / "hf-ocr-space"
            bundle_mod.build_hf_space_bundle(bundle_dir)

            ocr_engine_copy = bundle_dir / "backend" / "app" / "services" / "ocr_engine.py"
            original = ocr_engine_copy.read_text(encoding="utf-8")
            injected = original.replace(
                "from __future__ import annotations\n",
                "from __future__ import annotations\nfrom app.database.session import AsyncSessionLocal\n",
                1,
            )
            self.assertNotEqual(injected, original)
            ocr_engine_copy.write_text(injected, encoding="utf-8")

            with self.assertRaisesRegex(AssertionError, "app.database"):
                bundle_mod.verify_hf_space_bundle(bundle_dir)

    def test_ocr_engine_fallback_supabase_admin_headers_contract(self) -> None:
        ocr_engine_path = BACKEND_ROOT / "app" / "services" / "ocr_engine.py"
        spec = importlib.util.spec_from_file_location(
            "_standalone_ocr_engine_test", ocr_engine_path
        )
        self.assertIsNotNone(spec)
        assert spec is not None and spec.loader is not None

        added_backend_path = False
        if str(BACKEND_ROOT) not in sys.path:
            sys.path.insert(0, str(BACKEND_ROOT))
            added_backend_path = True

        saved_db = sys.modules.get("app.database")
        saved_cfg = sys.modules.get("app.database.config")
        try:
            # Setting module entries to None causes Python import machinery to raise ModuleNotFoundError.
            sys.modules["app.database"] = None  # type: ignore[assignment]
            sys.modules["app.database.config"] = None  # type: ignore[assignment]
            with patch.dict(
                "os.environ",
                {
                    "SUPABASE_URL": "https://example.supabase.co",
                    "SUPABASE_SECRET_KEY": "sb_secret_zero_db_worker_key",
                },
                clear=False,
            ):
                standalone_mod = importlib.util.module_from_spec(spec)
                spec.loader.exec_module(standalone_mod)

            self.assertEqual(standalone_mod.SUPABASE_URL, "https://example.supabase.co")
            self.assertEqual(standalone_mod.SUPABASE_ADMIN_KEY, "sb_secret_zero_db_worker_key")
            self.assertEqual(
                standalone_mod.supabase_admin_headers(),
                {"apikey": "sb_secret_zero_db_worker_key"},
            )
            self.assertEqual(
                standalone_mod.supabase_admin_headers(
                    "sb_secret_override.with.two_dots",
                    extra={"Accept": "application/json"},
                ),
                {
                    "apikey": "sb_secret_override.with.two_dots",
                    "Accept": "application/json",
                },
            )
            legacy_jwt = "eyJhbGciOiJIUzI1NiJ9.eyJyb2xlIjoic2VydmljZV9yb2xlIn0.signature"
            self.assertEqual(
                standalone_mod.supabase_admin_headers(legacy_jwt),
                {
                    "apikey": legacy_jwt,
                    "Authorization": f"Bearer {legacy_jwt}",
                },
            )
        finally:
            if added_backend_path and str(BACKEND_ROOT) in sys.path:
                sys.path.remove(str(BACKEND_ROOT))
            if saved_db is None:
                sys.modules.pop("app.database", None)
            else:
                sys.modules["app.database"] = saved_db
            if saved_cfg is None:
                sys.modules.pop("app.database.config", None)
            else:
                sys.modules["app.database.config"] = saved_cfg


if __name__ == "__main__":
    unittest.main()
