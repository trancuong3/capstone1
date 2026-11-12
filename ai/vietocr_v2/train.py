from __future__ import annotations

import argparse
import hashlib
import json
import os
import random
import shutil
from collections import Counter
from pathlib import Path
from typing import Any

from .contracts import (
    ORIGINAL_CHECKPOINT_SHA256, ORIGINAL_MODEL_FAMILY, ORIGINAL_VOCAB_SHA256,
    canonical_sha256, load_jsonl, sha256_file,
)

PROFILES = {
    "FLOW1_VERIFIED": {"flows": {"FLOW1_VERIFIED"}, "learning_rate": 0.0001, "weight_decay": 0.0001, "image_aug": False},
    "FLOW2_EXTERNAL_TRDG": {"flows": {"FLOW2_EXTERNAL", "FLOW2_TRDG"}, "learning_rate": 0.00008, "weight_decay": 0.0005, "image_aug": True},
}
ORIGINAL_WEIGHTS_URL = "https://vocr.vn/data/vietocr/vgg_transformer.pth"


def _architecture(config: dict[str, Any]) -> dict[str, Any]:
    return {key: config.get(key) for key in ("backbone", "cnn", "transformer", "seq_modeling", "vocab")}


def _assert_original_config(config: dict[str, Any]) -> str:
    from .contracts import ORIGINAL_CHECKPOINT_SHA256, ORIGINAL_VOCAB_SHA256, assert_original_vocabulary, vocabulary_fingerprint

    lock = json.loads((Path(__file__).parent / "original_artifact.json").read_text(encoding="utf-8"))
    actual = {"backbone": config.get("backbone"),
              "cnn": {key: config.get("cnn", {}).get(key) for key in ("ss", "ks", "hidden")},
              "seq_modeling": config.get("seq_modeling"), "transformer": dict(config.get("transformer", {})),
              "input": {key: config.get("dataset", {}).get(key) for key in ("image_height", "image_min_width", "image_max_width")}}
    if lock.get("checkpoint", {}).get("sha256") != ORIGINAL_CHECKPOINT_SHA256:
        raise ValueError("repository Original checkpoint lock is inconsistent")
    if lock.get("vocabulary", {}).get("canonical_json_sha256") != ORIGINAL_VOCAB_SHA256:
        raise ValueError("repository Original vocabulary lock is inconsistent")
    assert_original_vocabulary(str(config.get("vocab", "")))
    if vocabulary_fingerprint(str(config["vocab"]))[0] != lock["vocabulary"]["unicode_scalar_count"]:
        raise ValueError("VietOCR Original vocabulary length mismatch")
    if actual != lock.get("architecture"):
        raise ValueError("VietOCR Original architecture or input dimensions differ from the locked config")
    return canonical_sha256(actual)


def _profile_config(profile: str, config: dict[str, Any], data_root: Path, train_tsv: Path, valid_tsv: Path,
                    run_dir: Path, steps: int, batch_size: int, seed: int, dataset_version_sha256: str) -> dict[str, Any]:
    from copy import deepcopy

    cfg = deepcopy(config)
    cfg["device"] = "cuda" if __import__("torch").cuda.is_available() else "cpu"
    cfg["quiet"] = True
    cfg["cnn"]["pretrained"] = False
    cfg["dataset"].update({"name": f"viread_v2_{profile.lower()}_{dataset_version_sha256[:12]}", "data_root": str(data_root),
                          "train_annotation": str(train_tsv), "valid_annotation": str(valid_tsv)})
    cfg["trainer"].update({"iters": steps, "batch_size": batch_size, "print_every": 50, "valid_every": 500,
                           "checkpoint": str(run_dir / "latest.pt"), "export": str(run_dir / "candidate.pth"),
                           "metrics": None, "log": None})
    cfg["aug"]["image_aug"] = PROFILES[profile]["image_aug"]
    cfg["aug"]["masked_language_model"] = True
    cfg["optimizer"].update({"max_lr": PROFILES[profile]["learning_rate"]})
    cfg["training_weight_decay"] = PROFILES[profile]["weight_decay"]
    cfg["dataloader"].update({"num_workers": 0, "pin_memory": cfg["device"] == "cuda"})
    cfg["training_seed"] = seed
    return cfg


def _write_annotations(rows, manifest_dir: Path, root: Path) -> tuple[Path, Path]:
    root.mkdir(parents=True, exist_ok=True)
    train_path, valid_path = root / "train.tsv", root / "validation.tsv"
    for split, target in (("train", train_path), ("validation", valid_path)):
        with target.open("w", encoding="utf-8", newline="\n") as stream:
            for row in rows:
                if row.split != split:
                    continue
                image = Path(row.image)
                if not image.is_absolute():
                    image = (manifest_dir / image).resolve()
                if not image.is_file():
                    raise ValueError(f"dataset image missing: {image}")
                if "\t" in row.label or "\n" in row.label:
                    raise ValueError("Training labels must not contain tab or newline characters")
                stream.write(f"{image.as_posix()}\t{row.label}\n")
    if not train_path.stat().st_size or not valid_path.stat().st_size:
        raise ValueError("training requires both train and validation groups")
    return train_path, valid_path


def _validate_dataset_receipt(rows, receipt_path: str, expected_version_sha256: str) -> None:
    receipt_file = Path(receipt_path).resolve()
    if not receipt_file.is_file() or sha256_file(receipt_file) != expected_version_sha256:
        raise ValueError("registered source dataset receipt is missing or its SHA-256 does not match")
    receipt = json.loads(receipt_file.read_text(encoding="utf-8"))
    if receipt.get("schema") != "viread-dataset-v1":
        raise ValueError("unsupported registered dataset receipt")
    source_flow = receipt.get("source_flow")
    expected = Counter((item.get("source_flow", source_flow), item["group_id"], item["split"], item["image_sha256"], item["label"])
                       for item in receipt.get("samples", []))
    actual = Counter((row.source_flow, row.group_id, row.split, row.image_sha256, row.label) for row in rows)
    if expected != actual:
        raise ValueError("local training rows differ from the registered dataset receipt")


def _rng_state(torch):
    state = {"python": random.getstate(), "numpy": __import__("numpy").random.get_state(), "torch": torch.get_rng_state()}
    if torch.cuda.is_available():
        state["cuda"] = torch.cuda.get_rng_state_all()
    return state


def _restore_rng(torch, state: dict[str, Any]) -> None:
    random.setstate(state["python"])
    __import__("numpy").random.set_state(state["numpy"])
    torch.set_rng_state(state["torch"])
    if "cuda" in state and torch.cuda.is_available():
        torch.cuda.set_rng_state_all(state["cuda"])


def run_training(*, profile: str, manifest_path: str, output_dir: str, parent_checkpoint: str,
                 total_steps: int, dataset_receipt_path: str, dataset_version_sha256: str,
                 batch_size: int = 16, seed: int = 20261112, resume: bool = False) -> dict[str, Any]:
    if profile not in PROFILES:
        raise ValueError(f"profile must be one of {sorted(PROFILES)}")
    manifest = Path(manifest_path).resolve()
    run_dir = Path(output_dir).resolve()
    if len(dataset_version_sha256) != 64 or any(c not in "0123456789abcdef" for c in dataset_version_sha256.lower()):
        raise ValueError("dataset_version_sha256 must be a 64-character SHA-256 digest")
    run_dir.mkdir(parents=True, exist_ok=True)
    rows = load_jsonl(manifest, verify_files=True)
    _validate_dataset_receipt(rows, dataset_receipt_path, dataset_version_sha256.lower())
    allowed = PROFILES[profile]["flows"]
    if not rows or any(row.source_flow not in allowed for row in rows):
        raise ValueError("manifest contains no eligible samples or mixes a different data flow/profile")
    if any(row.split == "holdout" or row.split == "locked_test" for row in rows) and all(row.split != "train" for row in rows):
        raise ValueError("holdout or Locked Test samples cannot be used as training data")
    original_parent = parent_checkpoint.lower() in {"original", ORIGINAL_CHECKPOINT_SHA256}
    if original_parent:
        parent_path = run_dir / "vgg_transformer_original.pth"
        if not parent_path.exists():
            from vietocr.tool.utils import download_weights
            downloaded = Path(download_weights(ORIGINAL_WEIGHTS_URL, quiet=True))
            if sha256_file(downloaded) != ORIGINAL_CHECKPOINT_SHA256:
                raise ValueError("downloaded VietOCR Original checkpoint hash mismatch; refusing to train")
            shutil.copyfile(downloaded, parent_path)
        if sha256_file(parent_path) != ORIGINAL_CHECKPOINT_SHA256:
            raise ValueError("Original checkpoint hash mismatch; refusing to overwrite or continue")
    else:
        parent_path = Path(parent_checkpoint).resolve()
        if not parent_path.is_file():
            raise ValueError("parent checkpoint file does not exist")
    parent_hash = sha256_file(parent_path)

    import torch
    from vietocr.model.trainer import Trainer
    from vietocr.tool.config import Cfg

    config = dict(Cfg.load_config_from_name("vgg_transformer"))
    architecture_sha = _assert_original_config(config)
    train_tsv, valid_tsv = _write_annotations(rows, manifest.parent, run_dir / "dataset")
    cfg = _profile_config(profile, config, run_dir / "dataset", train_tsv, valid_tsv, run_dir,
                          total_steps, batch_size, seed, dataset_version_sha256)
    config_sha = canonical_sha256({"architecture_sha256": architecture_sha, "profile": profile,
                                  "optimizer": cfg["optimizer"], "trainer": {"steps": total_steps, "batch_size": batch_size},
                                  "training_weight_decay": cfg["training_weight_decay"], "image_aug": cfg["aug"]["image_aug"],
                                  "dataset_version_sha256": dataset_version_sha256.lower(),
                                  "local_manifest_sha256": sha256_file(manifest)})
    random.seed(seed)
    __import__("numpy").random.seed(seed)
    torch.manual_seed(seed)
    if torch.cuda.is_available():
        torch.cuda.manual_seed_all(seed)

    checkpoint_path = run_dir / "latest.pt"
    from uuid import uuid4
    candidate_path = run_dir / f"candidate-{profile.lower()}-{dataset_version_sha256[:12]}-{uuid4().hex}.pth"
    trainer = Trainer(cfg, pretrained=False)
    for parameter_group in trainer.optimizer.param_groups:
        parameter_group["weight_decay"] = cfg["training_weight_decay"]
    parent_state = torch.load(parent_path, map_location=cfg["device"], weights_only=True)
    if isinstance(parent_state, dict) and "model_state" in parent_state:
        parent_state = parent_state["model_state"]
    trainer.model.load_state_dict(parent_state, strict=True)
    trainer.iter = 0
    if resume:
        saved = torch.load(checkpoint_path, map_location=cfg["device"], weights_only=False)
        if saved.get("model_family") != ORIGINAL_MODEL_FAMILY or saved.get("parent_checkpoint_sha256") != parent_hash:
            raise ValueError("resume checkpoint has a different lineage parent")
        if saved.get("profile") != profile or saved.get("config_sha256") != config_sha or saved.get("manifest_sha256") != dataset_version_sha256.lower():
            raise ValueError("resume checkpoint config, profile, or dataset manifest changed")
        trainer.model.load_state_dict(saved["model_state"], strict=True)
        trainer.optimizer.load_state_dict(saved["optimizer_state"])
        trainer.scheduler.load_state_dict(saved["scheduler_state"])
        trainer.iter = int(saved["step"])
        validation_loss = saved.get("validation_loss")
        _restore_rng(torch, saved["rng_state"])
    elif checkpoint_path.exists():
        raise FileExistsError("run directory already has a checkpoint; pass --resume or choose a new path")

    iterator = iter(trainer.train_gen)
    step = trainer.iter
    if not resume:
        validation_loss = None
    while step < total_steps:
        try:
            batch = next(iterator)
        except StopIteration:
            iterator = iter(trainer.train_gen)
            batch = next(iterator)
        trainer.step(batch)
        step += 1
        trainer.iter = step
        if step % int(cfg["trainer"]["valid_every"]) == 0 or step == total_steps:
            validation_loss = float(trainer.validate())
            if not __import__("math").isfinite(validation_loss):
                raise ValueError("validation loss became non-finite; candidate training stopped")
        if step % 100 == 0 or step == total_steps:
            state = {"model_family": ORIGINAL_MODEL_FAMILY, "profile": profile, "step": step,
                     "parent_checkpoint_sha256": parent_hash, "manifest_sha256": dataset_version_sha256.lower(),
                     "local_manifest_sha256": sha256_file(manifest),
                     "config_sha256": config_sha, "architecture_sha256": architecture_sha,
                     "vocabulary_sha256": ORIGINAL_VOCAB_SHA256, "validation_loss": validation_loss,
                     "model_state": trainer.model.state_dict(), "optimizer_state": trainer.optimizer.state_dict(),
                     "scheduler_state": trainer.scheduler.state_dict(), "rng_state": _rng_state(torch)}
            temporary = checkpoint_path.with_suffix(".tmp")
            torch.save(state, temporary)
            temporary.replace(checkpoint_path)
    torch.save(trainer.model.state_dict(), candidate_path)
    result = {"model_family": ORIGINAL_MODEL_FAMILY, "profile": profile, "parent_checkpoint_sha256": parent_hash,
              "checkpoint_sha256": sha256_file(candidate_path), "config_sha256": config_sha,
              "architecture_sha256": architecture_sha, "vocabulary_sha256": ORIGINAL_VOCAB_SHA256,
              "manifest_sha256": dataset_version_sha256.lower(), "local_manifest_sha256": sha256_file(manifest),
              "dataset_receipt_sha256": sha256_file(dataset_receipt_path), "steps": step, "candidate_path": str(candidate_path),
              "validation_loss": validation_loss, "device": cfg["device"], "status": "CANDIDATE_REQUIRES_LOCKED_BENCHMARK"}
    (run_dir / f"{candidate_path.stem}.manifest.json").write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8")
    return result


def main() -> None:
    parser = argparse.ArgumentParser(description="Fine-tune one ViOCR V2 profile with resumable strict checkpoints")
    parser.add_argument("--profile", choices=sorted(PROFILES), required=True)
    parser.add_argument("--manifest", required=True)
    parser.add_argument("--dataset-receipt", required=True)
    parser.add_argument("--dataset-version-sha256", required=True)
    parser.add_argument("--output", required=True)
    parser.add_argument("--parent", default="original", help="Original or an approved V2 checkpoint path")
    parser.add_argument("--steps", type=int, default=5000)
    parser.add_argument("--batch-size", type=int, default=16)
    parser.add_argument("--seed", type=int, default=20261112)
    parser.add_argument("--resume", action="store_true")
    args = parser.parse_args()
    print(json.dumps(run_training(profile=args.profile, manifest_path=args.manifest, output_dir=args.output,
                                  parent_checkpoint=args.parent, total_steps=args.steps, batch_size=args.batch_size,
                                  dataset_receipt_path=args.dataset_receipt, dataset_version_sha256=args.dataset_version_sha256,
                                  seed=args.seed, resume=args.resume), ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
