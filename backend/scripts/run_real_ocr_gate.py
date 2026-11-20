"""Fail-closed PaddleOCR + VietOCR + Tesseract integration gate.

Runs the existing full synthetic image quality fixtures in a fresh process.
Never accepts missing engine imports/checkpoints as passing test skips.
Real photographs remain an independently blocked acceptance item unless
separately verified; this job claims only the synthetic real-engine gates.
"""
from __future__ import annotations

import os
from pathlib import Path
import sys
import unittest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

if os.environ.get("VIREAD_REAL_OCR_GATE") != "1":
    raise SystemExit("FAIL: VIREAD_REAL_OCR_GATE must be 1 for the real-engine CI gate")

names = (
    "test_ocr_adjudication.RealOcrFixtureGate",
    "test_ocr_false_yellow_suite.RealOcrIntegration",
)
required = []
for name in names:
    group = unittest.defaultTestLoader.loadTestsFromName(name)
    # Both groups have only ordinary unittest.TestCase children.
    for test in group:
        if isinstance(test, unittest.TestSuite):
            required.extend(list(test))
        else:
            required.append(test)

# Gate E requires independently verified real-book photographs, which are not
# in this repository. Preserve its test in regular discovery, but never claim
# this synthetic quality job certifies that unavailable manual acceptance gate.
real_photo_placeholder = "test_g_real_book_photographs_are_not_available"
synthetic = [t for t in required if not t.id().endswith(real_photo_placeholder)]
deferred = [t for t in required if t.id().endswith(real_photo_placeholder)]
expected_tests = 14
if len(synthetic) != expected_tests or len(deferred) != 1:
    raise SystemExit(
        f"FAIL: real OCR gate inventory changed: got {len(synthetic)} mandatory "
        f"synthetic tests and {len(deferred)} separately deferred photo checks "
        f"(expected {expected_tests} and 1)"
    )
print(
    f"REAL OCR GATE: mandatory_synthetic={len(synthetic)}, "
    "real_photograph_acceptance=NOT_VERIFIED (separate dataset required)",
    flush=True,
)
result = unittest.TextTestRunner(verbosity=2).run(unittest.TestSuite(synthetic))
if result.skipped:
    for test, reason in result.skipped:
        print(f"FAIL: mandatory OCR check skipped: {test.id()}: {reason}", file=sys.stderr)
if result.testsRun != expected_tests or result.skipped or not result.wasSuccessful():
    raise SystemExit(1)
print("PASS: all synthetic real-engine OCR checks executed without skips", flush=True)
