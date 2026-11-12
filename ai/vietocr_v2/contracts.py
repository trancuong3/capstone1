from __future__ import annotations

import hashlib
import json
import unicodedata
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Iterable, Literal

Split = Literal["train", "validation", "holdout", "locked_test"]
Flow = Literal["FLOW1_VERIFIED", "FLOW2_EXTERNAL", "FLOW2_TRDG"]

ORIGINAL_CHECKPOINT_SHA256 = "380512193a8b6cbf6fad80deacdc9b6939d10d473d199892fc6408d13775ea59"
ORIGINAL_CHECKPOINT_BYTES = 151_815_373
ORIGINAL_VOCAB_SIZE = 229
ORIGINAL_VOCAB_SHA256 = "b4ec9437ef82d952a65c101ea7ec6748a7168777c2d84cdb6a1bba7540bd163d"
ORIGINAL_MODEL_FAMILY = "vietocr_v2"


class DatasetContractError(ValueError):
    pass


def sha256_file(path: str | Path, chunk_size: int = 1024 * 1024) -> str:
    digest = hashlib.sha256()
    with Path(path).open("rb") as source:
        for chunk in iter(lambda: source.read(chunk_size), b""):
            digest.update(chunk)
    return digest.hexdigest()


def canonical_sha256(value: Any) -> str:
    encoded = json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode("utf-8")
    return hashlib.sha256(encoded).hexdigest()


def normalize_label(label: str) -> str:
    if not isinstance(label, str):
        raise DatasetContractError("label must be text")
    normalized = unicodedata.normalize("NFC", label).strip()
    if not normalized:
        raise DatasetContractError("label must not be blank")
    return normalized


def vocabulary_fingerprint(vocab: str) -> tuple[int, str]:
    normalized = unicodedata.normalize("NFC", vocab)
    encoded = json.dumps(normalized, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode("utf-8")
    return len(normalized), hashlib.sha256(encoded).hexdigest()


def assert_original_vocabulary(vocab: str) -> None:
    size, digest = vocabulary_fingerprint(vocab)
    if size != ORIGINAL_VOCAB_SIZE or digest != ORIGINAL_VOCAB_SHA256:
        raise DatasetContractError("VietOCR Original vocabulary differs from the locked baseline")


def stable_split(group_id: str, *, seed: str = "viread-vietocr-v2-split-v1") -> Split:
    """Keep every crop from a document/page together in one deterministic split."""
    if not group_id.strip():
        raise DatasetContractError("group_id must not be blank")
    value = int(hashlib.sha256(f"{seed}\0{group_id}".encode("utf-8")).hexdigest()[:8], 16) / 0xFFFFFFFF
    if value < 0.70:
        return "train"
    if value < 0.85:
        return "validation"
    return "holdout"


@dataclass(frozen=True)
class DatasetRow:
    image: str
    label: str
    group_id: str
    source_flow: Flow
    split: Split
    image_sha256: str | None = None
    verified: bool = False
    annotation_id: str | None = None

    @classmethod
    def from_mapping(cls, raw: dict[str, Any]) -> "DatasetRow":
        try:
            flow = raw["source_flow"]
            if flow not in {"FLOW1_VERIFIED", "FLOW2_EXTERNAL", "FLOW2_TRDG"}:
                raise DatasetContractError("unknown source_flow")
            split = raw["split"]
            if split not in {"train", "validation", "holdout", "locked_test"}:
                raise DatasetContractError("unknown split")
            if split == "locked_test":
                raise DatasetContractError("Locked Test rows must be stored in a separately sealed benchmark manifest")
            image = str(raw["image"]).strip()
            group_id = str(raw["group_id"]).strip()
            if not image or not group_id:
                raise DatasetContractError("image and group_id are required")
            label = normalize_label(raw["label"])
            verified = raw.get("verified") is True
            if flow == "FLOW1_VERIFIED" and not verified:
                raise DatasetContractError("Flow 1 samples must originate from an Admin VERIFIED revision")
            if flow == "FLOW2_EXTERNAL" and not raw.get("annotation_id"):
                raise DatasetContractError("external labels require an annotation_id")
            if flow == "FLOW2_EXTERNAL" and not verified:
                raise DatasetContractError("external labels must be explicitly human-verified")
            if flow == "FLOW2_TRDG" and raw.get("verified"):
                raise DatasetContractError("synthetic samples cannot claim Admin verification")
            digest = raw.get("image_sha256")
            if digest is not None and (len(str(digest)) != 64 or any(c not in "0123456789abcdef" for c in str(digest).lower())):
                raise DatasetContractError("image_sha256 must be a 64-character hexadecimal digest")
            return cls(image, label, group_id, flow, split, str(digest).lower() if digest else None, verified,
                       str(raw["annotation_id"]) if raw.get("annotation_id") is not None else None)
        except KeyError as exc:
            raise DatasetContractError(f"missing required field: {exc.args[0]}") from exc


def validate_rows(rows: Iterable[DatasetRow], *, expected_flow: Flow | None = None) -> list[DatasetRow]:
    materialized = list(rows)
    seen: set[tuple[str, str]] = set()
    group_splits: dict[str, str] = {}
    for row in materialized:
        if expected_flow is not None and row.source_flow != expected_flow:
            raise DatasetContractError("source flows must remain independent")
        key = (row.image, row.source_flow)
        if key in seen:
            raise DatasetContractError("duplicate source image within a flow")
        seen.add(key)
        previous = group_splits.setdefault(row.group_id, row.split)
        if previous != row.split:
            raise DatasetContractError("group leakage across dataset splits")
    return materialized


def load_jsonl(path: str | Path, *, expected_flow: Flow | None = None, verify_files: bool = True) -> list[DatasetRow]:
    manifest = Path(path)
    rows: list[DatasetRow] = []
    for line_no, line in enumerate(manifest.read_text(encoding="utf-8").splitlines(), start=1):
        if not line.strip():
            continue
        try:
            row = DatasetRow.from_mapping(json.loads(line))
        except (json.JSONDecodeError, DatasetContractError) as exc:
            raise DatasetContractError(f"{manifest}:{line_no}: {exc}") from exc
        image_path = Path(row.image)
        resolved = image_path if image_path.is_absolute() else manifest.parent / image_path
        if verify_files and not resolved.is_file():
            raise DatasetContractError(f"{manifest}:{line_no}: image file does not exist")
        if verify_files and row.image_sha256 and sha256_file(resolved) != row.image_sha256:
            raise DatasetContractError(f"{manifest}:{line_no}: image SHA-256 mismatch")
        rows.append(row)
    return validate_rows(rows, expected_flow=expected_flow)


def write_jsonl(path: str | Path, rows: Iterable[DatasetRow]) -> str:
    target = Path(path)
    target.parent.mkdir(parents=True, exist_ok=True)
    materialized = validate_rows(rows)
    with target.open("w", encoding="utf-8", newline="\n") as output:
        for row in materialized:
            output.write(json.dumps(row.__dict__, ensure_ascii=False, sort_keys=True) + "\n")
    return sha256_file(target)
