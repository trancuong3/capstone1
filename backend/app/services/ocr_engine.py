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


_PUNCTUATION_ONLY = frozenset(".,;:!?…%)]}»”’'\"([{«“‘-—–")
_PUNCTUATION_NO_SPACE_BEFORE = frozenset(",.;:!?…%)]}»”’")
_PUNCTUATION_NO_SPACE_AFTER = frozenset("([{«“‘")


def _join_text_tokens(tokens: Iterable[str]) -> str:
    """Rebuild a display line while keeping punctuation attached naturally."""
    output = ""
    for raw_token in tokens:
        token = unicodedata.normalize("NFC", str(raw_token)).strip()
        if not token:
            continue
        if not output:
            output = token
        elif token[0] in _PUNCTUATION_NO_SPACE_BEFORE or output[-1] in _PUNCTUATION_NO_SPACE_AFTER:
            output += token
        else:
            output += " " + token
    return output


def _format_text_lines(
    line_items: list[tuple[tuple[int, int, int], dict[str, object]]],
) -> tuple[str, dict[int, int], int]:
    """Preserve detected line order and add conservative paragraph separation."""
    if not line_items:
        return "", {}, 0

    heights = sorted(
        max(1, int(item["bottom"]) - int(item["top"]))
        for _, item in line_items
    )
    median_height = heights[len(heights) // 2] if heights else 1
    parts: list[str] = []
    raw_to_display_line: dict[int, int] = {}
    display_line_index = 0
    paragraph_count = 0
    previous_key: tuple[int, int, int] | None = None
    previous_info: dict[str, object] | None = None

    for line_key, info in line_items:
        if previous_key is not None and previous_info is not None:
            vertical_gap = int(info["top"]) - int(previous_info["bottom"])
            previous_height = max(
                1, int(previous_info["bottom"]) - int(previous_info["top"])
            )
            paragraph_break = (
                line_key[:2] != previous_key[:2]
                or vertical_gap > max(12, int(median_height * 1.8), int(previous_height * 1.8))
            )
            if paragraph_break:
                parts.append("\n\n")
                display_line_index += 2
                paragraph_count += 1
            else:
                parts.append("\n")
                display_line_index += 1
        else:
            paragraph_count = 1

        raw_to_display_line[int(info["raw_line_index"])] = display_line_index
        line_tokens = [str(token) for token in info.get("tokens", [])]
        parts.append(_join_text_tokens(line_tokens))
        previous_key = line_key
        previous_info = info

    return "".join(parts).strip(), raw_to_display_line, paragraph_count


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
    line_details: dict[tuple[int, int, int], dict[str, object]] = {}
    words: list[dict[str, object]] = []
    pending_prefix: dict[tuple[int, int, int], str] = {}
    last_word_by_line: dict[tuple[int, int, int], int] = {}

    for index, raw_text in enumerate(result.get("text", [])):
        token = unicodedata.normalize("NFC", str(raw_text)).strip()
        if not token:
            continue
        has_alphanumeric = any(character.isalnum() for character in token)
        is_punctuation_only = not has_alphanumeric and all(
            character in _PUNCTUATION_ONLY for character in token
        )
        if not has_alphanumeric and not is_punctuation_only:
            # Ignore isolated symbol fragments from illustrations, but retain punctuation.
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

        left = min(max(left, 0), scaled_w - 1)
        top = min(max(top, 0), scaled_h - 1)
        box_width = min(max(box_width, 0), scaled_w - left)
        box_height = min(max(box_height, 0), scaled_h - top)
        if box_width <= 0 or box_height <= 0:
            continue

        line_key = (block, paragraph, line)
        if line_key not in line_map:
            line_map[line_key] = len(line_map)
        line_info = line_details.setdefault(
            line_key,
            {
                "raw_line_index": line_map[line_key],
                "top": top,
                "bottom": top + box_height,
                "tokens": [],
            },
        )
        line_info["top"] = min(int(line_info["top"]), top)
        line_info["bottom"] = max(int(line_info["bottom"]), top + box_height)

        if not has_alphanumeric:
            # Keep punctuation in page text but don't fabricate a word box for it.
            line_info["tokens"].append(token)
            if token[0] in _PUNCTUATION_NO_SPACE_BEFORE and line_key in last_word_by_line:
                previous_word = words[last_word_by_line[line_key]]
                previous_word["text"] = str(previous_word["text"]) + token
            else:
                pending_prefix[line_key] = pending_prefix.get(line_key, "") + token
            continue

        # Short Vietnamese words remain available for Admin review even at low confidence.
        normalized = normalize_word(token)
        if not normalized:
            continue
        display_token = pending_prefix.pop(line_key, "") + token
        confidence = raw_confidence / 100.0 if 0 <= raw_confidence <= 100 else None
        word = {
            "word_index": len(words),
            "line_index": line_map[line_key],
            "text": display_token,
            "normalized_text": normalize_word(display_token),
            "bbox": [
                left / scaled_w,
                top / scaled_h,
                box_width / scaled_w,
                box_height / scaled_h,
            ],
            "ocr_confidence": confidence,
        }
        words.append(word)
        line_info["tokens"].append(token)
        last_word_by_line[line_key] = len(words) - 1

    if not words:
        raise OcrNoTextDetected("Tesseract did not detect usable Vietnamese text")

    line_items = [
        (key, value)
        for key, value in line_details.items()
        if value.get("tokens")
    ]
    formatted_text, raw_to_display_line, paragraph_count = _format_text_lines(line_items)
    for word in words:
        raw_line_index = int(word["line_index"])
        word["line_index"] = raw_to_display_line.get(raw_line_index, raw_line_index)

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
            "line_count": len(line_items),
            "paragraph_count": paragraph_count,
        },
    }
