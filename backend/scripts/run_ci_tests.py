"""Run the backend suite and fail if an unapproved test was silently skipped.

The real PaddleOCR/VietOCR suites intentionally run only in a separate strict
quality-gate job. All database suites must run against isolated loopback DBs.
"""
from __future__ import annotations

import os
from pathlib import Path
import sys
import unittest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

# A normal backend job must not inadvertently load large production OCR weights.
if os.getenv("VIREAD_REAL_OCR_GATE") == "1":
    raise SystemExit("Backend unit runner refuses VIREAD_REAL_OCR_GATE=1; run the dedicated real OCR gate")
os.environ.setdefault("DATABASE_FORCE_NULL_POOL", "true")

suite = unittest.defaultTestLoader.discover(
    start_dir=str(ROOT), pattern="test*.py", top_level_dir=str(ROOT)
)
result = unittest.TextTestRunner(verbosity=2).run(suite)
approved = {
    "test_ocr_adjudication.RealOcrFixtureGate": "dedicated OCR gate",
    "test_ocr_false_yellow_suite.RealOcrIntegration": "dedicated OCR gate",
    "test_karaoke_processing_engine_smoke.RealLocalEngineSmoke": "opt-in audio research smoke",
    "test_admin_ai_real_ollama_live.RealLocalOllamaFallbackTests": "opt-in real local Ollama integration",
}
unexpected = [
    (test.id(), reason)
    for test, reason in result.skipped
    if not any(name in test.id() for name in approved)
]
print(
    f"CI SKIP AUDIT: executed={result.testsRun}, skipped={len(result.skipped)}, "
    f"unexpected_skips={len(unexpected)}",
    flush=True,
)
for test_id, reason in unexpected:
    print(f"UNEXPECTED SKIP: {test_id}: {reason}", file=sys.stderr)
if not any("test_ocr_adjudication.RealOcrFixtureGate" in test.id() for test, _ in result.skipped):
    print("Missing expected separately gated OCR integration tests", file=sys.stderr)
    raise SystemExit(1)
if not any("test_ocr_false_yellow_suite.RealOcrIntegration" in test.id() for test, _ in result.skipped):
    print("Missing expected separately gated false-yellow integration tests", file=sys.stderr)
    raise SystemExit(1)
raise SystemExit(0 if result.wasSuccessful() and not unexpected else 1)
