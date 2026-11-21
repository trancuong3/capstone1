"""Layer 4 — Real Backend OCR Parity Test for Mobile Phone Camera Captures.

Verifies that the UNCHANGED backend OCR pipeline (`PaddleOCR + VietOCR + Tesseract vie`
via `ocr_engine.extract_text_and_boxes` and `LocalOcrScanService._validate_and_normalize_image`)
achieves parity with Web uploads across realistic Android phone camera conditions:
1. ABI-locked package versions (`numpy==1.26.4`, `protobuf==3.20.2`, `cv2==4.10.0.84`, `pytesseract==0.3.13`)
2. High-resolution portrait JPEG (`1800x2400`) with dense Vietnamese diacritics
3. Raw sensor landscape JPEGs with EXIF Orientation 6 (90 CW) and 8 (270 CW)
4. Downscaled 12MP -> `1536x2048` mobile-preprocessed JPEG vs Web PNG baseline
5. Slightly tilted (`1.6 deg`) + uneven warm indoor lighting + JPEG compression (`q=85`)
"""
from __future__ import annotations

import asyncio
import importlib.metadata as importlib_metadata
import io
import math
import os
import sys
import time
import unicodedata
import unittest
from pathlib import Path

BACKEND_ROOT = Path(__file__).resolve().parent
if str(BACKEND_ROOT) not in sys.path:
    sys.path.insert(0, str(BACKEND_ROOT))

# Enforce strict offline local OCR (zero cloud OCR calls)
os.environ["OCR_CLOUD_CORRECTION_ENABLED"] = "false"
os.environ["GEMINI_API_KEY"] = ""
os.environ["GROQ_API_KEY"] = ""
os.environ.setdefault("DATABASE_URL", "postgresql+asyncpg://test:test@127.0.0.1:5432/test")
os.environ.setdefault("SUPABASE_URL", "https://example.supabase.co")
os.environ.setdefault("SUPABASE_KEY", "test-key")

# Import torch FIRST on Windows so shm.dll initializes cleanly before cv2/paddle
import torch  # noqa: E402
from fastapi import UploadFile  # noqa: E402
from PIL import Image, ImageDraw, ImageFont  # noqa: E402

from app.services import ocr_engine  # noqa: E402
from app.services.local_ocr_scan_service import (  # noqa: E402
    LocalOcrScanService,
    _normalize_bbox,
)

PASSAGE_LINES = [
    "Buổi sáng mùa thu trời trong xanh.",
    "Đàn chim én chao liệng trên cánh đồng.",
    "Hương lúa mới thơm ngát khắp đường làng.",
]
GROUND_TRUTH = " ".join(PASSAGE_LINES)


def _normalize_vi(text: str) -> str:
    return unicodedata.normalize("NFC", " ".join(text.split()))


def _levenshtein(a: str, b: str) -> int:
    if len(b) > len(a):
        a, b = b, a
    prev = list(range(len(b) + 1))
    for i, ca in enumerate(a, 1):
        curr = [i]
        for j, cb in enumerate(b, 1):
            curr.append(min(curr[-1] + 1, prev[j] + 1, prev[j - 1] + (ca != cb)))
        prev = curr
    return prev[-1]


def _cer(reference: str, hypothesis: str) -> float:
    ref = _normalize_vi(reference)
    hyp = _normalize_vi(hypothesis)
    return _levenshtein(ref, hyp) / max(1, len(ref))


def _load_vietnamese_font(px_size: int) -> ImageFont.FreeTypeFont:
    candidates = [
        Path(r"C:\Windows\Fonts\arial.ttf"),
        Path(r"C:\Windows\Fonts\segoeui.ttf"),
        Path(r"C:\Windows\Fonts\times.ttf"),
        Path("/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf"),
    ]
    for path in candidates:
        if path.is_file():
            return ImageFont.truetype(str(path), px_size)
    raise RuntimeError("No Unicode TrueType font supporting Vietnamese diacritics found")


def _render_portrait_book_page(
    width: int,
    height: int,
    *,
    uneven_lighting: bool = False,
    tilt_degrees: float = 0.0,
) -> Image.Image:
    base_bg = (252, 249, 242) if uneven_lighting else (255, 255, 255)
    img = Image.new("RGB", (width, height), base_bg)

    if uneven_lighting:
        # Simulate subtle warm indoor lamp falloff across a phone-captured page
        px = img.load()
        assert px is not None
        for y in range(0, height, 4):
            shade = int(16 * (y / max(1, height)))
            row_color = (252 - shade, 248 - shade, 238 - shade)
            draw_band = ImageDraw.Draw(img)
            draw_band.rectangle([0, y, width, min(height, y + 4)], fill=row_color)

    draw = ImageDraw.Draw(img)
    font_px = max(28, int(round(width * 0.036)))
    font = _load_vietnamese_font(font_px)

    margin_x = int(round(width * 0.10))
    start_y = int(round(height * 0.22))
    line_gap = int(round(font_px * 2.1))

    for idx, line in enumerate(PASSAGE_LINES):
        draw.text(
            (margin_x, start_y + idx * line_gap),
            line,
            fill=(24, 34, 38),
            font=font,
        )

    if abs(tilt_degrees) > 0.01:
        img = img.rotate(
            tilt_degrees,
            resample=Image.Resampling.BICUBIC,
            expand=False,
            fillcolor=base_bg,
        )
    return img


def _encode_jpeg_with_exif_orientation(upright: Image.Image, orientation: int, quality: int = 90) -> bytes:
    """Counter-rotate pixels as a phone sensor does and embed the matching EXIF Orientation tag."""
    if orientation == 6:
        # Upright = 90 CW of raw -> raw = 90 CCW (ROTATE_90 in PIL)
        raw_img = upright.transpose(Image.Transpose.ROTATE_90)
    elif orientation == 8:
        # Upright = 270 CW of raw -> raw = 270 CCW (ROTATE_270 in PIL)
        raw_img = upright.transpose(Image.Transpose.ROTATE_270)
    elif orientation == 3:
        raw_img = upright.transpose(Image.Transpose.ROTATE_180)
    else:
        raw_img = upright

    exif = Image.Exif()
    exif[0x0112] = orientation
    buf = io.BytesIO()
    raw_img.save(buf, format="JPEG", quality=quality, exif=exif.tobytes())
    return buf.getvalue()


class MobileCameraOcrParityTests(unittest.TestCase):
    def test_abi_locked_python_dependencies_remain_untouched(self) -> None:
        self.assertEqual(importlib_metadata.version("numpy"), "1.26.4")
        self.assertEqual(importlib_metadata.version("protobuf"), "3.20.2")
        self.assertEqual(importlib_metadata.version("opencv-python-headless"), "4.10.0.84")
        self.assertEqual(importlib_metadata.version("pytesseract"), "0.3.13")
        self.assertTrue(torch.__version__)

    def test_web_png_baseline_vs_mobile_12mp_downscaled_jpeg_parity(self) -> None:
        # 1. Web clean PNG baseline (1200x1600)
        web_page = _render_portrait_book_page(1200, 1600)
        web_buf = io.BytesIO()
        web_page.save(web_buf, format="PNG")
        web_out = ocr_engine.extract_text_and_boxes(web_buf.getvalue())
        web_cer = _cer(GROUND_TRUTH, str(web_out.get("text", "")))
        self.assertLessEqual(web_cer, 0.05, f"Web PNG baseline CER too high: {web_cer}")

        # 2. Simulate 12MP phone camera capture (3000x4000) downscaled client-side to 1536x2048 JPEG q=90
        phone_12mp = _render_portrait_book_page(3000, 4000)
        phone_optimized = phone_12mp.resize((1536, 2048), Image.Resampling.LANCZOS)
        mob_buf = io.BytesIO()
        phone_optimized.save(mob_buf, format="JPEG", quality=90)

        t0 = time.perf_counter()
        mob_out = ocr_engine.extract_text_and_boxes(mob_buf.getvalue())
        elapsed_ms = (time.perf_counter() - t0) * 1000.0
        mob_text = _normalize_vi(str(mob_out.get("text", "")))
        mob_cer = _cer(GROUND_TRUTH, mob_text)

        self.assertLessEqual(mob_cer, 0.05, f"Mobile optimized JPEG CER={mob_cer} ('{mob_text}')")
        self.assertLessEqual(abs(mob_cer - web_cer), 0.04, "Mobile OCR diverged from Web baseline")
        self.assertLess(elapsed_ms, 30_000.0)

        words = mob_out.get("words", [])
        self.assertGreaterEqual(len(words), len(GROUND_TRUTH.split()) - 2)
        for w in words:
            nx, ny, nw, nh = _normalize_bbox(w.get("bbox"))
            self.assertTrue(0.0 <= nx <= 1.0 and 0.0 <= ny <= 1.0)
            self.assertTrue(0.0 < nw <= 1.0 and 0.0 < nh <= 1.0)
            self.assertFalse(math.isnan(nx) or math.isnan(ny))

    def test_exif_rotated_90_and_270_mobile_jpegs_normalize_and_recognize_diacritics(self) -> None:
        service = LocalOcrScanService(repository=None)  # type: ignore[arg-type]
        upright = _render_portrait_book_page(1500, 2000)

        for orientation in (6, 8):
            with self.subTest(exif_orientation=orientation):
                raw_jpeg = _encode_jpeg_with_exif_orientation(upright, orientation, quality=90)
                upload = UploadFile(
                    filename=f"camera_exif_{orientation}.jpg",
                    file=io.BytesIO(raw_jpeg),
                )
                clean_png_bytes, sha256 = asyncio.run(
                    service._validate_and_normalize_image(upload)
                )
                self.assertEqual(len(sha256), 64)
                with Image.open(io.BytesIO(clean_png_bytes)) as normalized_img:
                    # Must be transposed back to portrait (1500x2000), NOT sideways (2000x1500)!
                    self.assertEqual(normalized_img.size, (1500, 2000))

                ocr_out = ocr_engine.extract_text_and_boxes(clean_png_bytes)
                recognized = _normalize_vi(str(ocr_out.get("text", "")))
                cer = _cer(GROUND_TRUTH, recognized)
                self.assertLessEqual(
                    cer,
                    0.05,
                    f"EXIF={orientation} OCR failed: CER={cer}, got='{recognized}'",
                )
                for accented_word in ("Buổi", "trời", "liệng", "cánh", "đồng", "đường"):
                    self.assertIn(accented_word.lower(), recognized.lower())

    def test_tilted_uneven_lighting_jpeg_mobile_photo_stays_accurate(self) -> None:
        tilted_page = _render_portrait_book_page(
            1536,
            2048,
            uneven_lighting=True,
            tilt_degrees=1.6,
        )
        buf = io.BytesIO()
        tilted_page.save(buf, format="JPEG", quality=85)

        out = ocr_engine.extract_text_and_boxes(buf.getvalue())
        recognized = _normalize_vi(str(out.get("text", "")))
        cer = _cer(GROUND_TRUTH, recognized)
        self.assertLessEqual(
            cer,
            0.08,
            f"Tilted/uneven-lit mobile JPEG CER={cer} exceeded 0.08: '{recognized}'",
        )
        meta = out.get("metadata", {})
        self.assertFalse(bool(meta.get("cloud_ocr_used", False)))


if __name__ == "__main__":
    unittest.main()
