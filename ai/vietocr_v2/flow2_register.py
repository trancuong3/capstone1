from __future__ import annotations

import argparse
import hashlib
import json
import mimetypes
import os
from pathlib import Path
from typing import Any

import requests

from .contracts import DatasetRow, load_jsonl


def _api_call(session: requests.Session, method: str, url: str, **kwargs: Any) -> Any:
    response = session.request(method, url, timeout=(15, 300), **kwargs)
    response.raise_for_status()
    return response.json() if response.content else {}


def _content_type(path: Path) -> str:
    value = mimetypes.guess_type(path.name)[0]
    if value not in {"image/png", "image/jpeg", "image/webp"}:
        raise ValueError(f"unsupported image file type: {path.name}")
    return value


def _read_trdg_provenance(path: str | Path | None) -> dict[str, dict[str, Any]]:
    if path is None:
        return {}
    entries = json.loads(Path(path).read_text(encoding="utf-8"))
    if not isinstance(entries, list):
        raise ValueError("TRDG provenance must be a JSON array")
    result = {}
    for item in entries:
        if not isinstance(item, dict) or not isinstance(item.get("image"), str):
            raise ValueError("TRDG provenance entries require an image path")
        key = str(Path(item["image"]).resolve())
        if key in result or item.get("generator") != "trdg":
            raise ValueError("TRDG provenance entries must be unique and name the TRDG generator")
        result[key] = item
    return result


def _locked_test_rows(path: str | Path) -> list[dict[str, Any]]:
    raw = json.loads(Path(path).read_text(encoding="utf-8"))
    if not isinstance(raw, list) or not raw:
        raise ValueError("Locked Test source must be a non-empty JSON array")
    result = []
    seen: set[str] = set()
    for item in raw:
        if not isinstance(item, dict):
            raise ValueError("Locked Test rows must be JSON objects")
        sample_id = str(item.get("sample_id", "")).strip()
        group_id = str(item.get("group_id", "")).strip()
        label = str(item.get("label", item.get("reference", ""))).strip()
        image = Path(str(item.get("image", ""))).resolve()
        annotation_id = str(item.get("annotation_id", "")).strip()
        if (not sample_id or sample_id in seen or not group_id or not label or not annotation_id
                or item.get("verified") is not True or not image.is_file()):
            raise ValueError("Locked Test rows require unique IDs, a document group, verified reference, annotation ID, and image file")
        seen.add(sample_id)
        result.append({"sample_id": sample_id, "group_id": group_id, "split": "locked_test",
                       "image": image, "label": label, "annotation_id": annotation_id,
                       "verified": True, "provenance": {"verification_source": "human_locked_test"}})
    return result


def register_datasets(*, api_base: str, bearer_token: str, external_manifest: str | Path | None = None,
                      trdg_manifest: str | Path | None = None, trdg_provenance: str | Path | None = None,
                      locked_test_manifest: str | Path | None = None,
                      split_seed: str = "viread-vietocr-v2-split-v1") -> list[dict[str, Any]]:
    base = api_base.strip().rstrip("/")
    if not base or not bearer_token.strip():
        raise ValueError("API base and Admin bearer token are required")
    trdg_sources = _read_trdg_provenance(trdg_provenance)
    rows: list[DatasetRow] = []
    external_images: set[str] = set()
    trdg_images: set[str] = set()
    if external_manifest:
        rows.extend(load_jsonl(external_manifest))
        external_images = {str(Path(row.image).resolve()) for row in rows}
        if any(row.source_flow != "FLOW2_EXTERNAL" for row in rows):
            raise ValueError("external manifest may contain FLOW2_EXTERNAL rows only")
    if trdg_manifest:
        trdg_rows = load_jsonl(trdg_manifest)
        if any(row.source_flow != "FLOW2_TRDG" for row in trdg_rows):
            raise ValueError("TRDG manifest may contain FLOW2_TRDG rows only")
        trdg_images = {str(Path(row.image).resolve()) for row in trdg_rows}
        if set(trdg_sources) != trdg_images:
            raise ValueError("every TRDG image must have exactly one matching provenance entry")
        if external_images.intersection(trdg_images):
            raise ValueError("an image cannot be registered as both external and TRDG data")
        rows.extend(trdg_rows)
    if not rows and not locked_test_manifest:
        raise ValueError("provide Flow 2 manifest(s), a Locked Test manifest, or both")

    results = []
    with requests.Session() as session:
        session.headers.update({"Authorization": f"Bearer {bearer_token}"})
        if rows:
            group_splits: dict[str, str] = {}
            samples = []
            flow_by_image = {**{path: "FLOW2_EXTERNAL" for path in external_images},
                             **{path: "FLOW2_TRDG" for path in trdg_images}}
            for row in rows:
                group_split = group_splits.setdefault(row.group_id, row.split)
                if group_split != row.split:
                    raise ValueError("one source document appears in multiple dataset splits")
                image_path = Path(row.image).resolve()
                data = image_path.read_bytes()
                digest = hashlib.sha256(data).hexdigest()
                if digest != row.image_sha256:
                    raise ValueError(f"image hash changed after manifest creation: {image_path}")
                source_flow = flow_by_image[str(image_path)]
                uploaded = _api_call(session, "POST", f"{base}/books/admin/viread-training/datasets/objects",
                                     data={"source_flow": source_flow},
                                     files={"file": (image_path.name, data, _content_type(image_path))})
                if uploaded.get("image_sha256") != digest:
                    raise ValueError("server uploaded image hash differs from the local manifest")
                if source_flow == "FLOW2_EXTERNAL":
                    provenance = {"source": "external_human_annotation", "dbnet_crop_match": True,
                                  "annotation_id": row.annotation_id}
                else:
                    provenance = dict(trdg_sources[str(image_path)])
                sample_id = hashlib.sha256(
                    f"{source_flow}\0{row.group_id}\0{digest}\0{row.label}".encode("utf-8")
                ).hexdigest()
                samples.append({"source_flow": source_flow, "sample_id": sample_id,
                                "group_id": row.group_id, "split": row.split,
                                "image_storage_path": uploaded["image_storage_path"], "image_sha256": digest,
                                "label": row.label, "verified": row.verified,
                                "annotation_id": row.annotation_id, "provenance": provenance})
            dataset_flow = "FLOW2_EXTERNAL_TRDG" if len({sample["source_flow"] for sample in samples}) > 1 else samples[0]["source_flow"]
            result = _api_call(session, "POST", f"{base}/books/admin/viread-training/datasets",
                               json={"source_flow": dataset_flow, "samples": samples,
                                     "split_seed": split_seed,
                                     "provenance": {"pipeline": "flow2_dbnet_external_trdg_v1"}})
            results.append({"dataset_version": result, "source_flow": dataset_flow,
                            "sample_count": len(samples)})

        if locked_test_manifest:
            locked_samples = []
            for item in _locked_test_rows(locked_test_manifest):
                image_path = item["image"]
                data = image_path.read_bytes()
                digest = hashlib.sha256(data).hexdigest()
                uploaded = _api_call(session, "POST", f"{base}/books/admin/viread-training/datasets/objects",
                                     data={"source_flow": "LOCKED_TEST"},
                                     files={"file": (image_path.name, data, _content_type(image_path))})
                if uploaded.get("image_sha256") != digest:
                    raise ValueError("server uploaded Locked Test image hash differs from its local file")
                locked_samples.append({"sample_id": item["sample_id"], "group_id": item["group_id"],
                                       "split": "locked_test", "image_storage_path": uploaded["image_storage_path"],
                                       "image_sha256": digest, "label": item["label"], "verified": True,
                                       "annotation_id": item["annotation_id"], "provenance": item["provenance"]})
            result = _api_call(session, "POST", f"{base}/books/admin/viread-training/datasets",
                               json={"source_flow": "LOCKED_TEST", "samples": locked_samples,
                                     "split_seed": split_seed,
                                     "provenance": {"pipeline": "independent_human_locked_test_v1"}})
            results.append({"dataset_version": result, "source_flow": "LOCKED_TEST",
                            "sample_count": len(locked_samples)})
    return results


def main() -> None:
    parser = argparse.ArgumentParser(description="Upload separate Flow 2 and Locked Test manifests to the Admin API")
    parser.add_argument("--external-manifest")
    parser.add_argument("--trdg-manifest")
    parser.add_argument("--trdg-provenance")
    parser.add_argument("--locked-test-manifest", help="JSON array of human-verified image, label, sample, group and annotation IDs")
    parser.add_argument("--split-seed", default="viread-vietocr-v2-split-v1")
    args = parser.parse_args()
    api_base = os.environ.get("VIREAD_API_BASE", "")
    bearer_token = os.environ.get("VIREAD_ADMIN_BEARER", "")
    results = register_datasets(api_base=api_base, bearer_token=bearer_token,
                                external_manifest=args.external_manifest,
                                trdg_manifest=args.trdg_manifest, trdg_provenance=args.trdg_provenance,
                                locked_test_manifest=args.locked_test_manifest,
                                split_seed=args.split_seed)
    print(json.dumps(results, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
