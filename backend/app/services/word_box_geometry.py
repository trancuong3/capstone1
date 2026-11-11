"""Bind measured word geometry to its exact revision content without DB writes."""
import hashlib
import json
import math
import unicodedata

GEOMETRY_VERSION = "word-box-geometry-v1"


def _fingerprint(words: list[dict], width: int, height: int) -> str | None:
    if type(width) is not int or type(height) is not int or width <= 0 or height <= 0 or not words:
        return None
    content = []
    seen_boxes = set()
    previous_index = -1
    previous_by_line = {}
    for word in words:
        index, line = word.get("word_index"), word.get("line_index", 0)
        text, box = word.get("text"), word.get("bbox")
        if (type(index) is not int or index <= previous_index or type(line) is not int or line < 0
                or not isinstance(text, str) or not text.strip()
                or not isinstance(box, (list, tuple)) or len(box) != 4):
            return None
        if any(type(value) not in (int, float) or not math.isfinite(value) for value in box):
            return None
        x, y, w, h = (float(value) for value in box)
        if x < 0 or y < 0 or w <= 0 or h <= 0 or x + w > 1.000001 or y + h > 1.000001:
            return None
        key = (x, y, w, h)
        if key in seen_boxes:
            return None
        previous = previous_by_line.get(line)
        if previous is not None:
            px, py, pw, ph = previous
            intersection = max(0, min(x + w, px + pw) - max(x, px)) * max(0, min(y + h, py + ph) - max(y, py))
            if x + w / 2 <= px + pw / 2 or intersection > 0.5 * min(w * h, pw * ph):
                return None
        previous_by_line[line] = key
        previous_index = index
        seen_boxes.add(key)
        content.append([index, line, unicodedata.normalize("NFC", text), list(key)])
    encoded = json.dumps([width, height, content], ensure_ascii=False, allow_nan=False, separators=(",", ":"))
    return hashlib.sha256(encoded.encode("utf-8")).hexdigest()


def build_geometry_evidence(words: list[dict], width: int, height: int, *, reliable: bool) -> dict:
    fingerprint = _fingerprint(words, width, height)
    return {"version": GEOMETRY_VERSION, "reliable": reliable is True and fingerprint is not None,
            "fingerprint": fingerprint}


def has_verified_geometry(evidence: object, words: list[dict], width: int, height: int) -> bool:
    if (not isinstance(evidence, dict) or evidence.get("version") != GEOMETRY_VERSION
            or evidence.get("reliable") is not True or not isinstance(evidence.get("fingerprint"), str)):
        return False
    fingerprint = _fingerprint(words, width, height)
    return fingerprint is not None and fingerprint == evidence["fingerprint"]
