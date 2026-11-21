"""Private, OCR-independent manual annotation state for photographed pages.

Draft records stay in the private dataset folder; text and image identifiers
must never appear in aggregate reports or GitHub. The operator supplies every
word and box by looking at ORIGINAL pixels, not model predictions.
"""
from __future__ import annotations

import json
import math
import os
import tempfile
import unicodedata
from pathlib import Path

from scripts.ocr_word_box_iou import (
    MAX_ANNOTATION_BYTES, MAX_WORDS_PER_PAGE, load_manual_annotations, valid_box,
)

SOURCE_UNVERIFIED = "unverified"
SOURCE_MANUAL = "manual_independent"
COORDINATES = "normalized_original_dimensions"


def annotation_key(image: Path, root: Path) -> str:
    """Use the same resolved dataset-relative POSIX key as the IoU runner."""
    return image.resolve().relative_to(root.resolve()).as_posix()


def validate_draft_path(dataset: Path, draft: Path, repository_root: Path) -> tuple[Path, Path]:
    root = dataset.expanduser().resolve().parent
    file_path = draft.expanduser().resolve()
    if root.is_relative_to(repository_root.resolve()):
        raise ValueError("Private dataset must be outside repository")
    if (
        not file_path.is_relative_to(root)
        or file_path.suffix.lower() != ".jsonl"
        or file_path == dataset.expanduser().resolve()
        or "draft" not in file_path.stem.lower()
    ):
        raise ValueError("Draft must be a separate .jsonl with 'draft' in its name within private dataset")
    return root, file_path


def _single_word(text: object) -> bool:
    return (
        isinstance(text, str)
        and len(unicodedata.normalize("NFC", text.strip()).split()) == 1
        and len(text) <= 160
    )


def normalized_drag_box(
    x0: float, y0: float, x1: float, y1: float, width: int, height: int,
) -> list[float]:
    """Convert original-pixel drag coordinates to a normalized x/y/w/h box."""
    values = (x0, y0, x1, y1)
    if (
        isinstance(width, bool) or isinstance(height, bool)
        or not isinstance(width, int) or not isinstance(height, int)
        or width <= 0 or height <= 0
        or any(isinstance(v, bool) or not isinstance(v, (int, float)) or not math.isfinite(v) for v in values)
    ):
        raise ValueError("Invalid image dimensions or rectangle")
    left, right = sorted((max(0.0, min(float(x0), width)), max(0.0, min(float(x1), width))))
    top, bottom = sorted((max(0.0, min(float(y0), height)), max(0.0, min(float(y1), height))))
    bbox = [
        round(left / width, 8), round(top / height, 8),
        round((right - left) / width, 8), round((bottom - top) / height, 8),
    ]
    if not valid_box(bbox):
        raise ValueError("Draw a non-empty rectangle within image bounds")
    return bbox


def new_record(image_key: str) -> dict[str, object]:
    return {
        "image": image_key,
        "annotation_source": SOURCE_UNVERIFIED,
        "reviewer_confirmed": False,
        "coordinate_space": COORDINATES,
        "words": [],
    }


def validate_draft_record(record: object, key: str) -> None:
    if not isinstance(record, dict) or record.get("image") != key:
        raise ValueError("Invalid draft image identifier")
    if record.get("coordinate_space") != COORDINATES:
        raise ValueError("Incorrect original-image coordinates")
    source = record.get("annotation_source")
    confirmed = record.get("reviewer_confirmed")
    if not (
        (source == SOURCE_UNVERIFIED and confirmed is False)
        or (source == SOURCE_MANUAL and confirmed is True)
    ):
        raise ValueError("Invalid manual-review declaration")
    words = record.get("words")
    if not isinstance(words, list) or len(words) > MAX_WORDS_PER_PAGE:
        raise ValueError("Invalid manual word list")
    for word in words:
        if (
            not isinstance(word, dict)
            or not _single_word(word.get("text"))
            or not valid_box(word.get("bbox"))
        ):
            raise ValueError("Invalid manual word or rectangle")
    if confirmed and not words:
        raise ValueError("Cannot confirm an empty manual annotation")


def load_or_create_draft(path: Path, keys: list[str]) -> dict[str, dict[str, object]]:
    if not keys or len(set(keys)) != len(keys):
        raise ValueError("Image identifiers must be distinct")
    if path.exists():
        if not path.is_file() or path.stat().st_size > MAX_ANNOTATION_BYTES:
            raise ValueError("Existing draft file is not valid")
        records: dict[str, dict[str, object]] = {}
        try:
            with path.open("r", encoding="utf-8-sig") as handle:
                for line in handle:
                    if not line.strip():
                        continue
                    row = json.loads(line)
                    key = row.get("image") if isinstance(row, dict) else None
                    if not isinstance(key, str) or key not in keys or key in records:
                        raise ValueError("Duplicate, unknown or missing image in draft")
                    validate_draft_record(row, key)
                    records[key] = row
        except (OSError, UnicodeError, json.JSONDecodeError) as exc:
            raise ValueError("Unable to read existing draft") from exc
        if set(records) != set(keys):
            raise ValueError("Draft does not contain exactly the requested images")
        return records

    # Exclusive create: never replace an unrelated pre-existing user file.
    records = {key: new_record(key) for key in keys}
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("x", encoding="utf-8") as handle:
        for key in keys:
            handle.write(json.dumps(records[key], ensure_ascii=False) + "\n")
    return records


def _mark_unreviewed(record: dict[str, object]) -> None:
    record["annotation_source"] = SOURCE_UNVERIFIED
    record["reviewer_confirmed"] = False


def add_word(record: dict[str, object], text: str, bbox: list[float]) -> None:
    if not _single_word(text) or not valid_box(bbox):
        raise ValueError("Every box requires exactly one visible word and valid geometry")
    words = record["words"]
    if len(words) >= MAX_WORDS_PER_PAGE:
        raise ValueError("Too many words for one page")
    words.append({"text": unicodedata.normalize("NFC", text.strip()), "bbox": list(bbox)})
    _mark_unreviewed(record)


def edit_word(record: dict[str, object], index: int, text: str) -> None:
    words = record["words"]
    if not 0 <= index < len(words) or not _single_word(text):
        raise ValueError("Select one word and enter exactly one token")
    words[index]["text"] = unicodedata.normalize("NFC", text.strip())
    _mark_unreviewed(record)


def remove_word(record: dict[str, object], index: int) -> None:
    words = record["words"]
    if not 0 <= index < len(words):
        raise ValueError("Select a word to delete")
    words.pop(index)
    _mark_unreviewed(record)


def move_word(record: dict[str, object], index: int, step: int) -> None:
    words = record["words"]
    next_index = index + step
    if step not in (-1, 1) or not 0 <= index < len(words) or not 0 <= next_index < len(words):
        raise ValueError("Cannot move word outside its page")
    words[index], words[next_index] = words[next_index], words[index]
    _mark_unreviewed(record)


def confirm_page(record: dict[str, object]) -> None:
    if not record["words"]:
        raise ValueError("Annotate visible words before human confirmation")
    validate_draft_record(record, record["image"])
    record["annotation_source"] = SOURCE_MANUAL
    record["reviewer_confirmed"] = True


def persist_draft(path: Path, keys: list[str], records: dict[str, dict[str, object]]) -> None:
    if set(keys) != set(records):
        raise ValueError("Cannot save missing page annotations")
    for key in keys:
        validate_draft_record(records[key], key)
    temp_path: Path | None = None
    try:
        with tempfile.NamedTemporaryFile(
            mode="w", encoding="utf-8", dir=path.parent,
            prefix=".ocr-manual-draft-", suffix=".tmp", delete=False,
        ) as handle:
            temp_path = Path(handle.name)
            for key in keys:
                handle.write(json.dumps(records[key], ensure_ascii=False) + "\n")
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temp_path, path)
    finally:
        if temp_path is not None:
            temp_path.unlink(missing_ok=True)


def export_reviewed(
    target: Path, draft: Path, keys: list[str],
    records: dict[str, dict[str, object]],
    repository_root: Path,
) -> None:
    """Only a real reviewer may confirm; exporting never self-confirms pages."""
    root = draft.resolve().parent
    resolved = target.expanduser().resolve()
    if (
        root.is_relative_to(repository_root.resolve())
        or resolved.suffix.lower() != ".jsonl"
        or not resolved.is_relative_to(root)
        or resolved == draft.resolve()
    ):
        raise ValueError("Export must be a different private JSONL outside repository")
    if set(records) != set(keys):
        raise ValueError("Missing pages in manual annotations")
    for key in keys:
        validate_draft_record(records[key], key)
        if records[key]["annotation_source"] != SOURCE_MANUAL or records[key]["reviewer_confirmed"] is not True:
            raise ValueError("All pages require explicit manual review before export")
    with resolved.open("x", encoding="utf-8") as handle:
        for key in keys:
            handle.write(json.dumps(records[key], ensure_ascii=False) + "\n")
    # Validate against the scorer's exact contract.
    load_manual_annotations(resolved, set(keys))
