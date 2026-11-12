from __future__ import annotations

import argparse
import json
import unicodedata
from pathlib import Path
from typing import Any

from PIL import Image

from .contracts import canonical_sha256, sha256_file
from .metrics import PairedLine, benchmark_metrics
from .quality_gate import GatePolicy, evaluate_gate


def _predictor(config: dict[str, Any], weights: str):
    from vietocr.tool.predictor import Predictor

    selected = dict(config)
    selected["weights"] = weights
    selected["cnn"] = dict(selected["cnn"])
    selected["cnn"]["pretrained"] = False
    return Predictor(selected)


def run_locked_benchmark(*, manifest_path: str, expected_manifest_sha256: str, original_checkpoint: str,
                         candidate_checkpoint: str, output_path: str, image_cache_dir: str | None = None,
                         policy: GatePolicy = GatePolicy()) -> dict[str, Any]:
    manifest_file = Path(manifest_path).resolve()
    actual_manifest_sha256 = sha256_file(manifest_file)
    if actual_manifest_sha256 != expected_manifest_sha256.lower():
        raise ValueError("Locked Test manifest hash mismatch; benchmark refused")
    try:
        manifest = json.loads(manifest_file.read_text(encoding="utf-8"))
    except json.JSONDecodeError as exc:
        raise ValueError("Locked Test manifest must be a JSON object") from exc
    if manifest.get("schema") != "viread-locked-test-v1" or manifest.get("source_flow") != "LOCKED_TEST" or not manifest.get("sealed") is True:
        raise ValueError("benchmark requires a separately sealed Locked Test manifest")
    rows = manifest.get("samples")
    if not isinstance(rows, list) or not rows:
        raise ValueError("Locked Test manifest contains no samples")
    import torch
    from vietocr.tool.config import Cfg
    from .contracts import assert_original_vocabulary

    config = dict(Cfg.load_config_from_name("vgg_transformer"))
    if config.get("backbone") != "vgg19_bn" or config.get("seq_modeling") != "transformer":
        raise ValueError("VietOCR Original architecture mismatch")
    assert_original_vocabulary(str(config.get("vocab", "")))
    config["device"] = "cuda" if torch.cuda.is_available() else "cpu"
    config["cnn"]["pretrained"] = False
    original_hash = sha256_file(original_checkpoint)
    if original_hash != "380512193a8b6cbf6fad80deacdc9b6939d10d473d199892fc6408d13775ea59":
        raise ValueError("VietOCR Original checkpoint hash mismatch")
    original = _predictor(config, str(Path(original_checkpoint).resolve()))
    candidate = _predictor(config, str(Path(candidate_checkpoint).resolve()))
    paired: list[PairedLine] = []
    seen: set[str] = set()
    for item in rows:
        sample_id = str(item.get("sample_id", ""))
        group_id = str(item.get("group_id", ""))
        reference = unicodedata.normalize("NFC", str(item.get("reference", item.get("label", ""))))
        raw_image = item.get("image") or item.get("image_storage_path")
        image = Path(str(raw_image or ""))
        if not sample_id or not group_id or not reference.strip() or sample_id in seen:
            raise ValueError("Locked Test sample requires unique sample_id, group_id, and human reference")
        image = image if image.is_absolute() else manifest_file.parent / image
        if not image.is_file() and image_cache_dir:
            image = Path(image_cache_dir) / str(item.get("image_sha256", ""))
        image_hash = sha256_file(image)
        if image_hash != str(item.get("image_sha256", "")).lower():
            raise ValueError(f"Locked Test image hash mismatch for {sample_id}")
        seen.add(sample_id)
        with Image.open(image) as source:
            crop = source.convert("RGB")
            original_text = unicodedata.normalize("NFC", str(original.predict(crop)))
            candidate_text = unicodedata.normalize("NFC", str(candidate.predict(crop)))
        paired.append(PairedLine(group_id, reference, original_text, candidate_text, sample_id))

    metrics = benchmark_metrics(paired)
    metrics.update({"locked_manifest_sha256": actual_manifest_sha256,
                    "locked_manifest_id": manifest.get("manifest_id"),
                    "original_checkpoint_sha256": original_hash,
                    "candidate_checkpoint_sha256": sha256_file(candidate_checkpoint),
                    "architecture_sha256": canonical_sha256({key: config.get(key) for key in ("backbone", "cnn", "transformer", "seq_modeling")}),
                    "outputs": [{"sample_id": line.sample_id, "group_id": line.group_id, "reference": line.reference,
                                 "original": line.original, "candidate": line.candidate} for line in paired]})
    metrics["quality_gate"] = evaluate_gate(metrics, paired_manifest_hash=actual_manifest_sha256,
                                             expected_locked_manifest_hash=expected_manifest_sha256, policy=policy)
    output = Path(output_path)
    if output.exists():
        raise FileExistsError(f"refusing to overwrite prior benchmark report: {output}")
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps(metrics, ensure_ascii=False, indent=2), encoding="utf-8")
    return metrics


def main() -> None:
    parser = argparse.ArgumentParser(description="Paired Original/V2 benchmark against a separately sealed Locked Test")
    parser.add_argument("--manifest", required=True)
    parser.add_argument("--manifest-sha256", required=True)
    parser.add_argument("--original", required=True)
    parser.add_argument("--candidate", required=True)
    parser.add_argument("--output", required=True)
    parser.add_argument("--image-cache", default=None)
    parser.add_argument("--min-pairs", type=int, default=200)
    parser.add_argument("--min-groups", type=int, default=30)
    args = parser.parse_args()
    policy = GatePolicy(min_pairs=args.min_pairs, min_groups=args.min_groups)
    print(json.dumps(run_locked_benchmark(manifest_path=args.manifest, expected_manifest_sha256=args.manifest_sha256,
                                          original_checkpoint=args.original, candidate_checkpoint=args.candidate,
                                          output_path=args.output, image_cache_dir=args.image_cache,
                                          policy=policy), ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
