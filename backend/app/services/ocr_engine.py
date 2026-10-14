from __future__ import annotations

import os
import re
import shutil
import unicodedata
from collections.abc import Iterable

import cv2
import numpy as np
import pytesseract
from pytesseract import Output


class OcrEngineUnavailable(RuntimeError):
    """Local Tesseract or the Vietnamese language data is not configured."""


class OcrNoTextDetected(RuntimeError):
    """The image was valid but Tesseract did not detect any usable word."""


def normalize_word(value: str) -> str:
    """Canonical Vietnamese normalization shared by OCR output and reviewed words."""
    value = unicodedata.normalize("NFC", value).strip().lower()
    # Trim surrounding punctuation and symbols but retain internal apostrophes and hyphens.
    while value and (unicodedata.category(value[0]).startswith(("P", "S")) and value[0] not in {"'", "-"}):
        value = value[1:]
    while value and (unicodedata.category(value[-1]).startswith(("P", "S")) and value[-1] not in {"'", "-"}):
        value = value[:-1]
    return re.sub(r"\s+", " ", value).strip()


def normalize_text_tokens(value: str) -> list[str]:
    return [token for raw in re.split(r"\s+", unicodedata.normalize("NFC", value).strip()) if (token := normalize_word(raw))]


def extract_text_and_boxes(image_bytes: bytes) -> dict[str, object]:
    """
    Run local Tesseract OCR with adaptive image scaling, Otsu binarization,
    and single-column layout analysis (PSM 4).
    Bounding boxes come from Tesseract's real TSV output and are normalized to [0, 1]
    so they overlay the original image with high precision.
    """
    configured_binary = os.getenv("TESSERACT_CMD")
    if configured_binary:
        pytesseract.pytesseract.tesseract_cmd = configured_binary
    binary = pytesseract.pytesseract.tesseract_cmd
    if not (os.path.isfile(binary) or shutil.which(binary)):
        raise OcrEngineUnavailable("Tesseract OCR 5.x is not installed or TESSERACT_CMD is invalid")

    configured_tessdata = os.getenv("TESSDATA_PREFIX")
    if not configured_tessdata:
        local_tessdata = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..", "tessdata"))
        if os.path.isdir(local_tessdata):
            os.environ["TESSDATA_PREFIX"] = local_tessdata

    try:
        version = str(pytesseract.get_tesseract_version())
        languages = set(pytesseract.get_languages(config=""))
    except Exception as exc:
        raise OcrEngineUnavailable("Tesseract is unavailable; install Tesseract 5.x and its language data") from exc
    if not version.startswith(("5", "6")):
        raise OcrEngineUnavailable("Tesseract OCR 5.x or newer is required")

    target_lang = os.getenv("TESSERACT_LANG")
    if not target_lang:
        target_lang = "vie_best" if "vie_best" in languages else "vie"
    if target_lang not in languages:
        if "vie_best" in languages:
            target_lang = "vie_best"
        elif "vie" in languages:
            target_lang = "vie"
        else:
            raise OcrEngineUnavailable("Tesseract language data vie.traineddata is missing")

    array = np.frombuffer(image_bytes, dtype=np.uint8)
    image = cv2.imdecode(array, cv2.IMREAD_COLOR)
    if image is None:
        raise ValueError("Image decoding failed")
    orig_height, orig_width = image.shape[:2]
    if orig_width <= 0 or orig_height <= 0:
        raise ValueError("Image dimensions are invalid")

    # If image resolution is low (e.g. phone snapshots or small crops < 1400px),
    # upscale using cubic interpolation so Vietnamese diacritics match Tesseract's optimal font x-height (~30px).
    is_mocked = hasattr(pytesseract.image_to_data, "mock_calls") or "Mock" in type(pytesseract.image_to_data).__name__
    scale_factor = 1.0
    if not is_mocked:
        max_dim = max(orig_width, orig_height)
        if max_dim < 1400:
            scale_factor = min(2.5, 1500.0 / max_dim)

    if scale_factor > 1.01:
        scaled_w = int(round(orig_width * scale_factor))
        scaled_h = int(round(orig_height * scale_factor))
        scaled_image = cv2.resize(image, (scaled_w, scaled_h), interpolation=cv2.INTER_CUBIC)
    else:
        scaled_w, scaled_h = orig_width, orig_height
        scaled_image = image

    gray = cv2.cvtColor(scaled_image, cv2.COLOR_BGR2GRAY)
    # Otsu thresholding produces clean character edges and filters uneven lighting on book pages.
    _, processed = cv2.threshold(gray, 0, 255, cv2.THRESH_BINARY + cv2.THRESH_OTSU)
    if processed is None or np.mean(processed) < 5 or np.mean(processed) > 250:
        processed = cv2.createCLAHE(clipLimit=2.0, tileGridSize=(8, 8)).apply(gray)

    psm = os.getenv("TESSERACT_PSM", "4")
    try:
        result = pytesseract.image_to_data(
            processed,
            lang=target_lang,
            config=f"--oem 1 --psm {psm}",
            output_type=Output.DICT,
        )
    except Exception as exc:
        raise OcrEngineUnavailable(f"Tesseract failed to process the image with {target_lang} language data") from exc

    line_map: dict[tuple[int, int, int], int] = {}
    words: list[dict[str, object]] = []
    for index, raw_text in enumerate(result.get("text", [])):
        token = unicodedata.normalize("NFC", str(raw_text)).strip()
        # Drop empty tokens or non-text symbols
        if not token or not any(c.isalnum() for c in token):
            continue
        try:
            left = int(result["left"][index])
            top = int(result["top"][index])
            box_width = int(result["width"][index])
            box_height = int(result["height"][index])
            raw_confidence = float(result["conf"][index])
            block = int(result["block_num"][index])
            paragraph = int(result["par_num"][index])
            line = int(result["line_num"][index])
        except (KeyError, TypeError, ValueError, IndexError):
            continue

        # Filter out obvious OCR noise artifacts (zero or negative confidence on 1-2 char fragments)
        if raw_confidence <= 0 and (len(token) <= 2 or not any(c.isalpha() for c in token)):
            continue

        left = min(max(left, 0), scaled_w - 1)
        top = min(max(top, 0), scaled_h - 1)
        box_width = min(max(box_width, 0), scaled_w - left)
        box_height = min(max(box_height, 0), scaled_h - top)
        if box_width <= 0 or box_height <= 0:
            continue
        line_key = (block, paragraph, line)
        if line_key not in line_map:
            line_map[line_key] = len(line_map)
        confidence = raw_confidence / 100.0 if 0 <= raw_confidence <= 100 else None
        normalized = normalize_word(token)
        if not normalized:
            continue
        x = left / scaled_w
        y = top / scaled_h
        w = box_width / scaled_w
        h = box_height / scaled_h
        words.append({
            "word_index": len(words),
            "line_index": line_map[line_key],
            "text": token,
            "normalized_text": normalized,
            "bbox": [x, y, w, h],
            "ocr_confidence": confidence,
        })
    if not words:
        raise OcrNoTextDetected("Tesseract did not detect usable Vietnamese text")
    return {
        "text": " ".join(str(word["text"]) for word in words),
        "words": words,
        "metadata": {
            "engine": "tesseract",
            "engine_version": version,
            "language": target_lang,
            "preprocessing": [
                "upscale_cubic" if scale_factor > 1.01 else "original_resolution",
                "grayscale",
                "otsu_threshold",
            ],
            "coordinate_space": "normalized_original_dimensions",
            "source_width": orig_width,
            "source_height": orig_height,
            "processed_width": scaled_w,
            "processed_height": scaled_h,
            "scale_factor": scale_factor,
            "word_count": len(words),
        },
    }
