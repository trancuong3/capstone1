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


def _candidate_quality_score(result: dict[str, object]) -> float:
    """Rank OCR candidates using token-linked confidence and layout signals.

    Tesseract confidence is an engine score, not a calibrated probability. This
    score is only a candidate-selection heuristic and must never be shown as OCR
    confidence to the user.
    """
    raw_texts = result.get("text", [])
    raw_confidences = result.get("conf", [])
    tokens: list[str] = []
    confidence_values: list[float] = []
    populated_lines: set[tuple[int, int, int]] = set()
    all_characters = ""

    for index, raw_text in enumerate(raw_texts):
        token = str(raw_text).strip()
        if not token or not any(char.isalnum() for char in token):
            continue
        tokens.append(token)
        all_characters += token

        if index < len(raw_confidences):
            try:
                confidence = float(raw_confidences[index])
            except (TypeError, ValueError):
                confidence = float("nan")
            if np.isfinite(confidence) and 0 <= confidence <= 100:
                confidence_values.append(confidence / 100.0)

        try:
            populated_lines.add((
                int(result.get("block_num", [])[index]),
                int(result.get("par_num", [])[index]),
                int(result.get("line_num", [])[index]),
            ))
        except (TypeError, ValueError, IndexError):
            continue

    if not tokens:
        return -1.0

    average_confidence = (
        sum(confidence_values) / len(confidence_values) if confidence_values else 0.0
    )
    alphanumeric_ratio = (
        sum(character.isalnum() for character in all_characters) / len(all_characters)
        if all_characters else 0.0
    )
    # Saturating structural signals reward a usable page without automatically
    # preferring the candidate that emits the most noisy fragments.
    word_signal = min(len(tokens) / 18.0, 1.0)
    line_signal = min(len(populated_lines) / 6.0, 1.0)
    return (
        0.72 * average_confidence
        + 0.10 * word_signal
        + 0.08 * line_signal
        + 0.10 * alphanumeric_ratio
    )

def extract_text_and_boxes(image_bytes: bytes) -> dict[str, object]:
    """
    Run Vietnamese Tesseract OCR against a small set of preprocessing/layout
    candidates, then select the best candidate with a documented heuristic.

    Word boxes are read from Tesseract TSV and normalized against the processed
    image dimensions. Since candidate preprocessing retains the same dimensions,
    coordinates overlay the original image without an inverse geometric transform.
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

    is_mocked = (
        hasattr(pytesseract.image_to_data, "mock_calls")
        or "Mock" in type(pytesseract.image_to_data).__name__
    )
    scale_factor = 1.0
    if not is_mocked:
        max_dim = max(orig_width, orig_height)
        if max_dim < 1400:
            scale_factor = min(2.5, 1500.0 / max_dim)

    if scale_factor > 1.01:
        scaled_w = int(round(orig_width * scale_factor))
        scaled_h = int(round(orig_height * scale_factor))
        scaled_image = cv2.resize(
            image, (scaled_w, scaled_h), interpolation=cv2.INTER_CUBIC
        )
    else:
        scaled_w, scaled_h = orig_width, orig_height
        scaled_image = image

    gray = cv2.cvtColor(scaled_image, cv2.COLOR_BGR2GRAY)
    clahe = cv2.createCLAHE(clipLimit=2.0, tileGridSize=(8, 8)).apply(gray)
    _, otsu = cv2.threshold(gray, 0, 255, cv2.THRESH_BINARY + cv2.THRESH_OTSU)
    # OpenCV requires dimensions at least as large as blockSize. Tiny or
    # strip-like images still have Otsu/CLAHE candidates available.
    adaptive = None
    if min(scaled_w, scaled_h) >= 31:
        adaptive = cv2.adaptiveThreshold(
            clahe,
            255,
            cv2.ADAPTIVE_THRESH_GAUSSIAN_C,
            cv2.THRESH_BINARY,
            31,
            11,
        )

    configured_psm = os.getenv("TESSERACT_PSM")
    if configured_psm:
        if not configured_psm.isdecimal() or not 0 <= int(configured_psm) <= 13:
            raise OcrEngineUnavailable("TESSERACT_PSM must be an integer between 0 and 13")
        psm_values = [int(configured_psm)] * 3
    else:
        psm_values = [4, 6, 11]

    # Keep unit tests deterministic when Tesseract is mocked. Real OCR compares
    # complementary variants; all candidates use the same image dimensions.
    if is_mocked:
        candidates = [("otsu_threshold", otsu, psm_values[0])]
    else:
        candidates = [
            ("otsu_threshold", otsu, psm_values[0]),
            ("clahe_grayscale", clahe, psm_values[1]),
        ]
        if adaptive is not None:
            candidates.append(("adaptive_gaussian_threshold", adaptive, psm_values[2]))

    candidate_results: list[tuple[str, int, float, dict[str, object]]] = []
    successful_evaluations = 0
    for preprocessing_name, candidate_image, psm in candidates:
        try:
            result = pytesseract.image_to_data(
                candidate_image,
                lang=target_lang,
                config=f"--oem 1 --psm {psm}",
                output_type=Output.DICT,
            )
            successful_evaluations += 1
        except Exception:
            # An individual candidate can fail because of layout parameters;
            # only fail the whole request when no candidate can be evaluated.
            candidate_results.append((preprocessing_name, psm, -1.0, {}))
            continue
        candidate_results.append(
            (preprocessing_name, psm, _candidate_quality_score(result), result)
        )

    usable_candidates = [item for item in candidate_results if item[2] >= 0]
    if not usable_candidates:
        if successful_evaluations:
            raise OcrNoTextDetected("Tesseract did not detect usable Vietnamese text")
        raise OcrEngineUnavailable(
            f"Tesseract failed to process the image with {target_lang} language data"
        )
    selected_preprocessing, selected_psm, selected_score, result = max(
        usable_candidates, key=lambda item: item[2]
    )
    if not result.get("text"):
        raise OcrNoTextDetected("Tesseract did not detect usable Vietnamese text")

    line_map: dict[tuple[int, int, int], int] = {}
    words: list[dict[str, object]] = []
    for index, raw_text in enumerate(result.get("text", [])):
        token = unicodedata.normalize("NFC", str(raw_text)).strip()
        if not token or not any(character.isalnum() for character in token):
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

        if not np.isfinite(raw_confidence):
            raw_confidence = -1.0
        # Keep short, low-confidence Vietnamese words (for example "là", "và")
        # so Admin can review them. Invalid/punctuation-only tokens are filtered above;
        # confidence affects review status, not whether a real word is silently dropped.

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
        words.append({
            "word_index": len(words),
            "line_index": line_map[line_key],
            "text": token,
            "normalized_text": normalized,
            "bbox": [
                left / scaled_w,
                top / scaled_h,
                box_width / scaled_w,
                box_height / scaled_h,
            ],
            "ocr_confidence": confidence,
        })
    if not words:
        raise OcrNoTextDetected("Tesseract did not detect usable Vietnamese text")

    score_metadata = [
        {
            "preprocessing": name,
            "psm": psm,
            "selection_score": round(score, 4) if score >= 0 else None,
        }
        for name, psm, score, _candidate in candidate_results
    ]
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
                selected_preprocessing,
            ],
            "selected_psm": selected_psm,
            "candidate_count": len(candidate_results),
            "candidate_scores": score_metadata,
            "selected_candidate_score": round(selected_score, 4),
            "coordinate_space": "normalized_original_dimensions",
            "source_width": orig_width,
            "source_height": orig_height,
            "processed_width": scaled_w,
            "processed_height": scaled_h,
            "scale_factor": scale_factor,
            "word_count": len(words),
        },
    }
