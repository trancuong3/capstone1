from __future__ import annotations

from pathlib import Path

import cv2
import numpy as np


def _deskew(image: np.ndarray, max_degrees: float = 10.0) -> np.ndarray:
    gray = cv2.cvtColor(image, cv2.COLOR_BGR2GRAY)
    _, foreground = cv2.threshold(gray, 0, 255, cv2.THRESH_BINARY_INV + cv2.THRESH_OTSU)
    fg_ratio = float(cv2.countNonZero(foreground)) / float(max(1, foreground.size))
    # Skip deskew on dark/illustrated children's book crops where Otsu inverts background.
    if fg_ratio < 0.02 or fg_ratio > 0.55:
        return image
    points = cv2.findNonZero(foreground)
    if points is None or len(points) < 24:
        return image
    angle = cv2.minAreaRect(points)[-1]
    angle = angle + 90.0 if angle < -45.0 else angle
    if abs(angle) < 0.15 or abs(angle) > max_degrees:
        return image
    height, width = image.shape[:2]
    pad_y = max(2, int(round(width * abs(np.sin(np.deg2rad(angle))) * 0.25)))
    pad_y = min(pad_y, max(4, height // 3))
    padded = cv2.copyMakeBorder(
        image, pad_y, pad_y, 0, 0, borderType=cv2.BORDER_REPLICATE
    )
    ph, pw = padded.shape[:2]
    matrix = cv2.getRotationMatrix2D((pw / 2.0, ph / 2.0), angle, 1.0)
    return cv2.warpAffine(
        padded,
        matrix,
        (pw, ph),
        flags=cv2.INTER_CUBIC,
        borderMode=cv2.BORDER_REPLICATE,
    )


def preprocess_line_array(image: np.ndarray) -> np.ndarray:
    """Shared, conservative line-image processing for V2 training and inference."""
    if image is None or image.size == 0:
        raise ValueError("line image is empty")
    processed = _deskew(image)
    if processed.shape[0] >= 28:
        processed = cv2.fastNlMeansDenoisingColored(processed, None, 3, 3, 7, 15)
    lab = cv2.cvtColor(processed, cv2.COLOR_BGR2LAB)
    lightness, a_channel, b_channel = cv2.split(lab)
    clahe = cv2.createCLAHE(clipLimit=2.0, tileGridSize=(8, 8))
    enhanced = cv2.merge((clahe.apply(lightness), a_channel, b_channel))
    return cv2.cvtColor(enhanced, cv2.COLOR_LAB2BGR)


def preprocess_line_image(source: str | Path, target: str | Path) -> Path:
    source_path = Path(source)
    target_path = Path(target)
    encoded = np.frombuffer(source_path.read_bytes(), dtype=np.uint8)
    image = cv2.imdecode(encoded, cv2.IMREAD_COLOR)
    if image is None or image.size == 0:
        raise ValueError(f"could not decode training image: {source_path}")
    output = preprocess_line_array(image)
    success, png = cv2.imencode(".png", output, [cv2.IMWRITE_PNG_COMPRESSION, 3])
    if not success:
        raise ValueError(f"could not encode preprocessed training image: {source_path}")
    target_path.parent.mkdir(parents=True, exist_ok=True)
    target_path.write_bytes(png.tobytes())
    return target_path
