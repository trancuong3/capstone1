from __future__ import annotations

import math
import os
import re
import shutil
import unicodedata
from statistics import mean

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
    # Trim surrounding punctuation but retain internal apostrophes and hyphens.
    while value and unicodedata.category(value[0]).startswith("P") and value[0] not in {"'", "-"}:
        value = value[1:]
    while value and unicodedata.category(value[-1]).startswith("P") and value[-1] not in {"'", "-"}:
        value = value[:-1]
    return re.sub(r"\s+", " ", value).strip()


def normalize_text_tokens(value: str) -> list[str]:
    return [
        token
        for raw in re.split(r"\s+", unicodedata.normalize("NFC", value).strip())
        if (token := normalize_word(raw))
    ]


def _env_int(name: str, default: int, minimum: int, maximum: int) -> int:
    try:
        return max(minimum, min(maximum, int(os.getenv(name, str(default)))))
    except (TypeError, ValueError):
        return default


def _configured_threshold() -> float:
    try:
        value = float(os.getenv("OCR_LOW_CONFIDENCE_THRESHOLD", "0.65"))
    except (TypeError, ValueError):
        return 0.65
    return max(0.0, min(1.0, value))


def _decode_image(image_bytes: bytes) -> np.ndarray:
    if not image_bytes:
        raise ValueError("Image bytes are empty")
    array = np.frombuffer(image_bytes, dtype=np.uint8)
    image = cv2.imdecode(array, cv2.IMREAD_COLOR)
    if image is None:
        raise ValueError("Image decoding failed")
    height, width = image.shape[:2]
    if width <= 0 or height <= 0:
        raise ValueError("Image dimensions are invalid")
    return image


def _build_candidates(gray: np.ndarray) -> list[tuple[str, np.ndarray, int, str]]:
    """Create a bounded set of candidates that preserve the page geometry."""
    height, width = gray.shape[:2]
    max_dimension = max(width, height)
    # Upscale only small inputs. Pure uniform scaling keeps normalized coordinates valid.
    scale = min(2.0, 1800.0 / max_dimension) if max_dimension < 1200 else 1.0
    if scale > 1.01:
        target = (max(1, round(width * scale)), max(1, round(height * scale)))
        gray = cv2.resize(gray, target, interpolation=cv2.INTER_CUBIC)

    enhanced = cv2.createCLAHE(clipLimit=2.0, tileGridSize=(8, 8)).apply(gray)
    candidates: list[tuple[str, np.ndarray, int, str]] = [
        ("clahe_psm3", enhanced, 3, "grayscale+clahe"),
        ("grayscale_psm3", gray, 3, "grayscale"),
    ]

    _, otsu = cv2.threshold(enhanced, 0, 255, cv2.THRESH_BINARY + cv2.THRESH_OTSU)
    candidates.append(("otsu_psm4", otsu, 4, "grayscale+clahe+otsu"))

    min_dimension = min(gray.shape[:2])
    if min_dimension >= 15:
        block_size = min(41, min_dimension if min_dimension % 2 else min_dimension - 1)
        block_size = max(15, block_size)
        if block_size % 2 == 0:
            block_size -= 1
        adaptive = cv2.adaptiveThreshold(
            enhanced,
            255,
            cv2.ADAPTIVE_THRESH_GAUSSIAN_C,
            cv2.THRESH_BINARY,
            block_size,
            11,
        )
        candidates.append(("adaptive_psm6", adaptive, 6, "grayscale+clahe+adaptive_threshold"))

    return candidates


def _parse_tsv(
    result: dict[str, list[object]],
    processed_width: int,
    processed_height: int,
) -> tuple[str, list[dict[str, object]]]:
    line_indexes: dict[tuple[int, int, int], int] = {}
    line_tokens: dict[tuple[int, int, int], list[str]] = {}
    words: list[dict[str, object]] = []
    row_count = len(result.get("text", []))

    for index in range(row_count):
        token = unicodedata.normalize("NFC", str(result["text"][index])).strip()
        if not token:
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

        left = min(max(left, 0), processed_width - 1)
        top = min(max(top, 0), processed_height - 1)
        box_width = min(max(box_width, 0), processed_width - left)
        box_height = min(max(box_height, 0), processed_height - top)
        if box_width <= 0 or box_height <= 0:
            continue

        line_key = (block, paragraph, line)
        if line_key not in line_indexes:
            line_indexes[line_key] = len(line_indexes)
            line_tokens[line_key] = []

        normalized = normalize_word(token)
        if not normalized:
            continue
        confidence = raw_confidence / 100.0 if math.isfinite(raw_confidence) and 0 <= raw_confidence <= 100 else None
        words.append(
            {
                "word_index": len(words),
                "line_index": line_indexes[line_key],
                "text": token,
                "normalized_text": normalized,
                # Coordinates are normalized to the processed image. The preprocessing
                # uses uniform scaling only, so normalized coordinates map to the source.
                "bbox": [
                    left / processed_width,
                    top / processed_height,
                    box_width / processed_width,
                    box_height / processed_height,
                ],
                "ocr_confidence": confidence,
            }
        )
        line_tokens[line_key].append(token)

    text = "\n".join(" ".join(tokens) for tokens in line_tokens.values() if tokens).strip()
    return text, words


def _candidate_score(words: list[dict[str, object]], max_word_count: int) -> tuple[float, float | None]:
    if not words:
        return -1.0, None

    confidences = [
        float(word["ocr_confidence"])
        for word in words
        if isinstance(word.get("ocr_confidence"), (int, float))
        and math.isfinite(float(word["ocr_confidence"]))
        and 0.0 <= float(word["ocr_confidence"]) <= 1.0
    ]
    mean_confidence = mean(confidences) if confidences else None
    confidence_coverage = len(confidences) / len(words)
    completeness = len(words) / max(1, max_word_count)
    all_text = " ".join(str(word["text"]) for word in words)
    printable = sum(character.isprintable() for character in all_text) / max(1, len(all_text))
    replacement_ratio = all_text.count("\ufffd") / max(1, len(all_text))

    # Heuristic ranking only. Tesseract confidence is not a calibrated probability
    # and is not proof that a recognized word is correct.
    score = (
        0.68 * (mean_confidence or 0.0)
        + 0.10 * confidence_coverage
        + 0.16 * completeness
        + 0.06 * printable
        - 0.35 * replacement_ratio
    )
    return score, mean_confidence


def _run_tesseract(
    image: np.ndarray,
    psm: int,
    timeout_seconds: int,
    *,
    preserve_interword_spaces: bool = True,
) -> dict[str, object]:
    processed_height, processed_width = image.shape[:2]
    config = f"--oem 1 --psm {psm}"
    if preserve_interword_spaces:
        config += " -c preserve_interword_spaces=1"
    result = pytesseract.image_to_data(
        image,
        lang="vie",
        config=config,
        output_type=Output.DICT,
        timeout=timeout_seconds,
    )
    text, words = _parse_tsv(result, processed_width, processed_height)
    return {"text": text, "words": words}


def extract_text_and_boxes(image_bytes: bytes, *, strategy: str = "best") -> dict[str, object]:
    """
    Run local Vietnamese OCR and return text, per-word boxes and diagnostic metadata.

    strategy="best" tests a bounded number of preprocessing/page-segmentation candidates.
    strategy="baseline" runs the previous grayscale+CLAHE, PSM 3 implementation and is
    intended for reproducible comparison, not as the production default.

    All candidate transforms are geometry-preserving or uniform scaling; normalized
    bounding boxes therefore continue to map to the stored source image.
    """
    if strategy not in {"best", "baseline"}:
        raise ValueError("strategy must be 'best' or 'baseline'")

    configured_binary = os.getenv("TESSERACT_CMD")
    if configured_binary:
        pytesseract.pytesseract.tesseract_cmd = configured_binary
    binary = pytesseract.pytesseract.tesseract_cmd
    if not (os.path.isfile(binary) or shutil.which(binary)):
        raise OcrEngineUnavailable("Tesseract OCR 5.x is not installed or TESSERACT_CMD is invalid")

    try:
        version = str(pytesseract.get_tesseract_version())
        languages = set(pytesseract.get_languages(config=""))
    except Exception as exc:
        raise OcrEngineUnavailable("Tesseract is unavailable; install Tesseract 5.x and its language data") from exc
    if not version.startswith(("5", "6")):
        raise OcrEngineUnavailable("Tesseract OCR 5.x or newer is required")
    if "vie" not in languages:
        raise OcrEngineUnavailable("Tesseract language data vie.traineddata is missing")

    image = _decode_image(image_bytes)
    source_height, source_width = image.shape[:2]
    gray = cv2.cvtColor(image, cv2.COLOR_BGR2GRAY)
    timeout_seconds = _env_int("OCR_TESSERACT_TIMEOUT_SECONDS", 20, 5, 60)

    if strategy == "baseline":
        enhanced = cv2.createCLAHE(clipLimit=2.0, tileGridSize=(8, 8)).apply(gray)
        candidates = [("baseline_clahe_psm3", enhanced, 3, "grayscale+clahe")]
        upscale_factor = 1.0
    else:
        max_dimension = max(source_width, source_height)
        upscale_factor = min(2.0, 1800.0 / max_dimension) if max_dimension < 1200 else 1.0
        candidates = _build_candidates(gray)

    completed: list[dict[str, object]] = []
    diagnostics: list[dict[str, object]] = []
    engine_errors = 0

    for name, processed_image, psm, preprocessing in candidates:
        try:
            candidate = _run_tesseract(
                processed_image,
                psm,
                timeout_seconds,
                preserve_interword_spaces=strategy != "baseline",
            )
            words = candidate["words"]
            assert isinstance(words, list)
            confidence_values = [
                float(word["ocr_confidence"])
                for word in words
                if isinstance(word.get("ocr_confidence"), (int, float))
            ]
            diagnostics.append(
                {
                    "candidate": name,
                    "psm": psm,
                    "word_count": len(words),
                    "mean_confidence": round(mean(confidence_values), 4) if confidence_values else None,
                    "error": False,
                }
            )
            completed.append(
                {
                    "candidate": name,
                    "psm": psm,
                    "preprocessing": preprocessing,
                    "text": candidate["text"],
                    "words": words,
                }
            )
        except Exception:
            # One failed candidate must not discard usable output from other candidates.
            engine_errors += 1
            diagnostics.append(
                {
                    "candidate": name,
                    "psm": psm,
                    "word_count": 0,
                    "mean_confidence": None,
                    "error": True,
                }
            )

    usable = [item for item in completed if item["words"]]
    if not usable:
        if engine_errors == len(candidates):
            raise OcrEngineUnavailable("Tesseract failed to process the image using the configured Vietnamese data")
        raise OcrNoTextDetected("Tesseract did not detect usable Vietnamese text")

    max_word_count = max(len(item["words"]) for item in usable)
    scored: list[tuple[float, dict[str, object], float | None]] = []
    for item in usable:
        score, mean_confidence = _candidate_score(item["words"], max_word_count)
        scored.append((score, item, mean_confidence))
        for diagnostic in diagnostics:
            if diagnostic["candidate"] == item["candidate"]:
                diagnostic["score"] = round(score, 4)
                break

    best_score, selected, mean_confidence = max(scored, key=lambda entry: entry[0])
    words = selected["words"]
    text = str(selected["text"])
    threshold = _configured_threshold()
    low_confidence_count = sum(
        1
        for word in words
        if word.get("ocr_confidence") is None
        or float(word["ocr_confidence"]) < threshold
    )
    warnings: list[str] = []
    if mean_confidence is None:
        warnings.append("confidence_unavailable")
    elif mean_confidence < threshold:
        warnings.append("low_mean_confidence")
    if low_confidence_count:
        warnings.append("words_need_review")

    selected_diagnostics = next(
        (item for item in diagnostics if item["candidate"] == selected["candidate"]),
        {},
    )
    selected_diagnostics["score"] = round(best_score, 4)

    return {
        "text": text,
        "words": words,
        "metadata": {
            "engine": "tesseract",
            "engine_version": version,
            "language": "vie",
            "strategy": strategy,
            "selected_candidate": selected["candidate"],
            "selected_psm": selected["psm"],
            "preprocessing": selected["preprocessing"],
            "candidate_count": len(candidates),
            "candidate_diagnostics": diagnostics,
            "coordinate_space": "normalized_original_dimensions",
            "source_width": source_width,
            "source_height": source_height,
            "processed_width": candidates[0][1].shape[1],
            "processed_height": candidates[0][1].shape[0],
            "upscale_factor": round(upscale_factor, 3),
            "word_count": len(words),
            "mean_confidence": round(mean_confidence, 4) if mean_confidence is not None else None,
            "low_confidence_threshold": threshold,
            "low_confidence_word_count": low_confidence_count,
            "warnings": warnings,
        },
    }
