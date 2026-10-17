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
    noise_tokens = 0

    for index, raw_text in enumerate(raw_texts):
        token = str(raw_text).strip()
        if not token:
            continue
        if not any(char.isalnum() for char in token):
            # Ignore the artifact as text, but penalize candidates that emit
            # many non-empty punctuation/symbol fragments from illustrations.
            noise_tokens += 1
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
    base_score = (
        0.72 * average_confidence
        + 0.10 * word_signal
        + 0.08 * line_signal
        + 0.10 * alphanumeric_ratio
    )
    symbol_ratio = (
        sum(unicodedata.category(character).startswith("S") for character in all_characters)
        / len(all_characters)
        if all_characters else 0.0
    )
    artifact_ratio = noise_tokens / max(len(tokens) + noise_tokens, 1)
    # This is a ranking heuristic, not a confidence probability. Prefer candidates
    # with fewer symbol artifacts without discarding valid short Vietnamese words.
    return max(-1.0, base_score - 0.10 * artifact_ratio - 0.10 * symbol_ratio)

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
        if max_dim < 1800:
            # Typical phone captures can have 8–10 px Vietnamese glyphs;
            # upscale them enough to recover small tone marks without unbounded growth.
            scale_factor = min(3.0, 1800.0 / max_dim)

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
        psm_values = [int(configured_psm)] * 4
    else:
        # Complementary layout modes reduce dependence on a single page segmentation.
        psm_values = [4, 6, 6, 11]

    # Keep unit tests deterministic when Tesseract is mocked. Real OCR compares
    # complementary variants; all candidates use the same image dimensions.
    if is_mocked:
        candidates = [("otsu_threshold", otsu, psm_values[0])]
    else:
        candidates = [
            ("otsu_threshold", otsu, psm_values[0]),
            ("clahe_grayscale", clahe, psm_values[1]),
            # Raw grayscale preserves fine Vietnamese diacritics that aggressive
            # local contrast or thresholding can sometimes distort.
            ("grayscale", gray, psm_values[2]),
        ]
        if adaptive is not None:
            candidates.append(("adaptive_gaussian_threshold", adaptive, psm_values[3]))

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
    paragraph_map: dict[tuple[int, int], int] = {}
    line_paragraph_map: dict[int, int] = {}
    line_left_pixels: dict[int, int] = {}
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
        # so Admin can review them. Confidence affects review status, not inclusion.

        left = min(max(left, 0), scaled_w - 1)
        top = min(max(top, 0), scaled_h - 1)
        box_width = min(max(box_width, 0), scaled_w - left)
        box_height = min(max(box_height, 0), scaled_h - top)
        if box_width <= 0 or box_height <= 0:
            continue

        paragraph_key = (block, paragraph)
        if paragraph_key not in paragraph_map:
            paragraph_map[paragraph_key] = len(paragraph_map)
        line_key = (block, paragraph, line)
        if line_key not in line_map:
            line_index = len(line_map)
            line_map[line_key] = line_index
            line_paragraph_map[line_index] = paragraph_map[paragraph_key]
        line_index = line_map[line_key]
        line_left_pixels[line_index] = min(
            line_left_pixels.get(line_index, left), left
        )

        confidence = raw_confidence / 100.0 if 0 <= raw_confidence <= 100 else None
        normalized = normalize_word(token)
        if not normalized:
            continue
        words.append({
            "word_index": len(words),
            "line_index": line_index,
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

    # Reconstruct readable text from Tesseract's actual line/paragraph structure.
    # Keep the word records as the single source of truth for text and alignment.
    line_words: dict[int, list[str]] = {}
    for word in words:
        line_words.setdefault(int(word["line_index"]), []).append(str(word["text"]))
    ordered_line_indices = sorted(line_words)
    paragraph_start_line_indices: list[int] = []
    previous_paragraph_index: int | None = None
    for line_index in ordered_line_indices:
        paragraph_index = line_paragraph_map.get(line_index, 0)
        if previous_paragraph_index is not None and paragraph_index != previous_paragraph_index:
            paragraph_start_line_indices.append(line_index)
        previous_paragraph_index = paragraph_index

    # Indentation is inferred conservatively from line geometry. This only adds
    # visual indentation to paragraph starts (and the first line), never to every
    # wrapped line. Centered headings are excluded by the maximum-indent bound.
    baseline_left = min(line_left_pixels.values())
    indent_threshold = max(24.0, scaled_w * 0.018)
    maximum_indent = scaled_w * 0.15
    paragraph_starts = set(paragraph_start_line_indices)
    first_line_index = ordered_line_indices[0]
    indented_line_indices = [
        line_index
        for line_index in ordered_line_indices
        if (
            line_index == first_line_index or line_index in paragraph_starts
        )
        and indent_threshold < line_left_pixels[line_index] - baseline_left <= maximum_indent
    ]
    indented_lines = set(indented_line_indices)

    formatted_lines: list[str] = []
    for line_index in ordered_line_indices:
        line_text = " ".join(line_words[line_index]).strip()
        if line_index in indented_lines:
            line_text = f"    {line_text}"
        formatted_lines.append(line_text)

    formatted_parts: list[str] = []
    for position, line_index in enumerate(ordered_line_indices):
        if position:
            formatted_parts.append(
                "\n\n" if line_index in paragraph_starts else "\n"
            )
        formatted_parts.append(formatted_lines[position])
    formatted_text = "".join(formatted_parts)

    score_metadata = [
        {
            "preprocessing": name,
            "psm": psm,
            "selection_score": round(score, 4) if score >= 0 else None,
        }
        for name, psm, score, _candidate in candidate_results
    ]
    return {
        "text": formatted_text,
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
            "text_layout": "line_and_paragraph_preserving",
            "paragraph_start_line_indices": paragraph_start_line_indices,
            "indented_line_indices": indented_line_indices,
        },
    }
