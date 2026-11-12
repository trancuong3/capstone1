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
from uuid import uuid4

from .contracts import (
    ORIGINAL_CHECKPOINT_SHA256, ORIGINAL_MODEL_FAMILY, ORIGINAL_VOCAB_SHA256,
    canonical_sha256, load_jsonl, sha256_file,
)

# The two public profiles follow the product flow numbering. The source_flow values
# remain legacy database identifiers so existing Admin VERIFIED rows stay readable.
PROFILES = {
    "FLOW1_EXTERNAL_TRDG": {"flows": {"FLOW2_EXTERNAL", "FLOW2_TRDG"}, "learning_rate": 1e-4, "weight_decay": 5e-4, "image_aug": True,
                             "sample_volume_limits": {"FLOW2_EXTERNAL": (500, 1_000), "FLOW2_TRDG": (20_000, 50_000)}},
    "FLOW2_ADMIN_VERIFIED": {"flows": {"FLOW1_VERIFIED"}, "learning_rate": 1e-4, "weight_decay": 1e-4, "image_aug": False},
    # Read/resume compatibility for runs created before the public flow names were corrected.
    "FLOW1_VERIFIED": {"flows": {"FLOW1_VERIFIED"}, "learning_rate": 1e-4, "weight_decay": 1e-4, "image_aug": False},
    "FLOW2_EXTERNAL_TRDG": {"flows": {"FLOW2_EXTERNAL", "FLOW2_TRDG"}, "learning_rate": 1e-4, "weight_decay": 5e-4, "image_aug": True},
}


def validate_flow1_sample_counts(counts: dict[str, int]) -> None:
    limits = PROFILES["FLOW1_EXTERNAL_TRDG"]["sample_volume_limits"]
    out_of_range = {
        flow: {"count": int(counts.get(flow, 0)), "minimum": minimum, "maximum": maximum}
        for flow, (minimum, maximum) in limits.items()
        if not minimum <= int(counts.get(flow, 0)) <= maximum
    }
    if out_of_range:
        raise ValueError(f"Flow 1 dataset must contain 500-1,000 real and 20,000-50,000 TRDG samples: {out_of_range}")
ORIGINAL_WEIGHTS_URL = "https://vocr.vn/data/vietocr/vgg_transformer.pth"
PREPROCESSING_CONFIG = {
    "pipeline": "opencv-line-v1",
    "deskew_max_degrees": 10.0,
    "denoise_h": 3,
    "clahe_clip_limit": 2.0,
    "clahe_grid_size": [8, 8],
    "vietnamese_labels_are_never_autocorrected": True,
}


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
    import sys

    service_dir = Path(__file__).resolve().parents[2] / "backend" / "app" / "services"
    if str(service_dir) not in sys.path:
        sys.path.insert(0, str(service_dir))
    from viread_vietocr_v2_preprocessing import preprocess_line_image

    root.mkdir(parents=True, exist_ok=True)
    processed_root = root / "preprocessed" / PREPROCESSING_CONFIG["pipeline"]
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
                processed = processed_root / f"{sha256_file(image)}.png"
                if not processed.exists():
                    preprocess_line_image(image, processed)
                stream.write(f"{processed.as_posix()}\t{row.label}\n")
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


def _store_best_model(torch, model, run_dir: Path) -> tuple[Path, str]:
    """Store an immutable validation-best weights file for crash-safe resume."""
    temporary = run_dir / f".best-{uuid4().hex}.tmp"
    torch.save(model.state_dict(), temporary)
    digest = sha256_file(temporary)
    target = run_dir / f"best-{digest}.pth"
    if target.exists():
        if sha256_file(target) != digest:
            raise ValueError("existing best validation checkpoint path has different bytes")
        temporary.unlink()
    else:
        temporary.replace(target)
    return target, digest


def _should_resume(requested: bool, checkpoint_path: Path, run_dir: Path) -> bool:
    if requested and not checkpoint_path.is_file():
        if any(run_dir.glob("best-*.pth")):
            raise FileNotFoundError("best validation weights exist but the resumable checkpoint is missing")
        return False
    return requested


def run_training(*, profile: str, manifest_path: str, output_dir: str, parent_checkpoint: str,
                 total_steps: int, dataset_receipt_path: str, dataset_version_sha256: str,
                 batch_size: int = 32, seed: int = 20261112, resume: bool = False,
                 freeze_epochs: int = 5, use_fp16: bool = True) -> dict[str, Any]:
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
    if PROFILES[profile].get("sample_volume_limits"):
        validate_flow1_sample_counts(dict(Counter(row.source_flow for row in rows)))
    if total_steps < 2 or freeze_epochs < 1:
        raise ValueError("training requires at least two steps and one VGG freeze epoch")
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
    amp_enabled = bool(use_fp16 and cfg["device"] == "cuda")
    config_sha = canonical_sha256({"architecture_sha256": architecture_sha, "profile": profile,
                                  "optimizer": cfg["optimizer"], "trainer": {"steps": total_steps, "batch_size": batch_size},
                                  "freeze_epochs": freeze_epochs, "freeze_encoder_lr": 1e-5,
                                  "full_model_lr": 1e-5, "fp16": amp_enabled,
                                  "scheduler": "CosineAnnealingLR",
                                  "preprocessing": PREPROCESSING_CONFIG,
                                  "training_weight_decay": cfg["training_weight_decay"], "image_aug": cfg["aug"]["image_aug"],
                                  "dataset_version_sha256": dataset_version_sha256.lower(),
                                  "local_manifest_sha256": sha256_file(manifest)})
    random.seed(seed)
    __import__("numpy").random.seed(seed)
    torch.manual_seed(seed)
    if torch.cuda.is_available():
        torch.cuda.manual_seed_all(seed)

    checkpoint_path = run_dir / "latest.pt"
    best_model_path: Path | None = None
    candidate_path = run_dir / f"candidate-{profile.lower()}-{dataset_version_sha256[:12]}-{uuid4().hex}.pth"
    trainer = Trainer(cfg, pretrained=False)
    parent_state = torch.load(parent_path, map_location=cfg["device"], weights_only=True)
    if isinstance(parent_state, dict) and "model_state" in parent_state:
        parent_state = parent_state["model_state"]
    trainer.model.load_state_dict(parent_state, strict=True)
    trainer.iter = 0
    train_batches_per_epoch = max(1, len(trainer.train_gen))
    freeze_steps = min(freeze_epochs * train_batches_per_epoch, total_steps - 1)
    cnn_parameters = list(trainer.model.cnn.parameters())
    cnn_ids = {id(parameter) for parameter in cnn_parameters}
    decoder_parameters = [parameter for parameter in trainer.model.parameters() if id(parameter) not in cnn_ids]
    for parameter in cnn_parameters:
        parameter.requires_grad_(False)
    optimizer = torch.optim.AdamW(
        [
            {"params": cnn_parameters, "lr": 1e-5},
            {"params": decoder_parameters, "lr": PROFILES[profile]["learning_rate"]},
        ],
        betas=(0.9, 0.98), eps=1e-9, weight_decay=cfg["training_weight_decay"],
    )
    scheduler = torch.optim.lr_scheduler.CosineAnnealingLR(
        optimizer, T_max=max(1, freeze_steps), eta_min=1e-7,
    )
    scaler = torch.amp.GradScaler("cuda", enabled=amp_enabled)
    trainer.optimizer = optimizer
    trainer.scheduler = scheduler
    stage = "freeze_vgg"
    best_validation_loss: float | None = None
    best_step = 0
    best_model_sha256: str | None = None
    # Colab defaults to resume so reruns keep working, but a new run folder
    # must still start from the selected parent checkpoint.
    resume = _should_resume(resume, checkpoint_path, run_dir)
    if resume:
        saved = torch.load(checkpoint_path, map_location=cfg["device"], weights_only=False)
        if saved.get("model_family") != ORIGINAL_MODEL_FAMILY or saved.get("parent_checkpoint_sha256") != parent_hash:
            raise ValueError("resume checkpoint has a different lineage parent")
        if saved.get("profile") != profile or saved.get("config_sha256") != config_sha or saved.get("manifest_sha256") != dataset_version_sha256.lower():
            raise ValueError("resume checkpoint config, profile, or dataset manifest changed")
        trainer.model.load_state_dict(saved["model_state"], strict=True)
        trainer.iter = int(saved["step"])
        stage = saved.get("stage", "freeze_vgg" if trainer.iter < freeze_steps else "unfreeze_all")
        if stage == "unfreeze_all":
            for parameter in cnn_parameters:
                parameter.requires_grad_(True)
            scheduler = torch.optim.lr_scheduler.CosineAnnealingLR(
                optimizer, T_max=max(1, total_steps - trainer.iter), eta_min=1e-7,
            )
            trainer.scheduler = scheduler
        trainer.optimizer.load_state_dict(saved["optimizer_state"])
        trainer.scheduler.load_state_dict(saved["scheduler_state"])
        if saved.get("scaler_state"):
            scaler.load_state_dict(saved["scaler_state"])
        validation_loss = saved.get("validation_loss")
        stored_best_loss = saved.get("best_validation_loss")
        stored_best_step = saved.get("best_step")
        stored_best_sha = saved.get("best_model_sha256")
        stored_best_filename = saved.get("best_model_filename")
        if stored_best_loss is not None:
            if (not isinstance(stored_best_filename, str)
                    or Path(stored_best_filename).name != stored_best_filename
                    or not stored_best_filename.startswith("best-")
                    or not stored_best_filename.endswith(".pth")
                    or not stored_best_sha):
                raise ValueError("resume checkpoint references a missing best validation model")
            best_model_path = run_dir / stored_best_filename
            if not best_model_path.is_file():
                raise ValueError("resume checkpoint references a missing best validation model")
            if sha256_file(best_model_path) != stored_best_sha:
                raise ValueError("best validation model failed integrity verification")
            best_payload = torch.load(best_model_path, map_location="cpu", weights_only=True)
            trainer.model.load_state_dict(best_payload, strict=True)
            best_validation_loss = float(stored_best_loss)
            best_step = int(stored_best_step or 0)
            best_model_sha256 = stored_best_sha
            # Restore the latest-step weights after validating the saved best payload.
            trainer.model.load_state_dict(saved["model_state"], strict=True)
        else:
            # Older resumable checkpoints did not save a best model. Revalidate
            # the exact resumed weights and use them as the starting best.
            validation_loss = float(trainer.validate())
            if not __import__("math").isfinite(validation_loss):
                raise ValueError("resumed model validation loss is non-finite")
            best_validation_loss = validation_loss
            best_step = trainer.iter
            best_model_path, best_model_sha256 = _store_best_model(torch, trainer.model, run_dir)
        _restore_rng(torch, saved["rng_state"])
    elif checkpoint_path.exists() or any(run_dir.glob("best-*.pth")):
        raise FileExistsError("run directory already has a checkpoint; pass --resume or choose a new path")

    iterator = iter(trainer.train_gen)
    step = trainer.iter
    if not resume:
        validation_loss = None
    while step < total_steps:
        if step >= freeze_steps and stage == "freeze_vgg":
            for parameter in cnn_parameters:
                parameter.requires_grad_(True)
            for group in trainer.optimizer.param_groups:
                group["lr"] = 1e-5
            trainer.scheduler = torch.optim.lr_scheduler.CosineAnnealingLR(
                trainer.optimizer, T_max=max(1, total_steps - step), eta_min=1e-7,
            )
            stage = "unfreeze_all"
        try:
            batch = next(iterator)
        except StopIteration:
            iterator = iter(trainer.train_gen)
            batch = next(iterator)
        trainer.model.train()
        if stage == "freeze_vgg":
            trainer.model.cnn.eval()
        batch = trainer.batch_to_device(batch)
        with torch.autocast(device_type=cfg["device"], dtype=torch.float16, enabled=amp_enabled):
            outputs = trainer.model(batch["img"], batch["tgt_input"], tgt_key_padding_mask=batch["tgt_padding_mask"])
            outputs = outputs.reshape(-1, outputs.size(2))
            targets = batch["tgt_output"].reshape(-1)
            loss = trainer.criterion(outputs, targets)
        trainer.optimizer.zero_grad(set_to_none=True)
        scaler.scale(loss).backward()
        scaler.unscale_(trainer.optimizer)
        torch.nn.utils.clip_grad_norm_((p for p in trainer.model.parameters() if p.requires_grad), 1.0)
        scaler.step(trainer.optimizer)
        scaler.update()
        trainer.scheduler.step()
        step += 1
        trainer.iter = step
        validated = step % int(cfg["trainer"]["valid_every"]) == 0 or step == total_steps
        if validated:
            validation_loss = float(trainer.validate())
            if not __import__("math").isfinite(validation_loss):
                raise ValueError("validation loss became non-finite; candidate training stopped")
            if best_validation_loss is None or validation_loss < best_validation_loss:
                best_model_path, best_model_sha256 = _store_best_model(torch, trainer.model, run_dir)
                best_validation_loss = validation_loss
                best_step = step
        if step % 100 == 0 or step == total_steps or validated:
            state = {"model_family": ORIGINAL_MODEL_FAMILY, "profile": profile, "step": step,
                     "stage": stage,
                     "parent_checkpoint_sha256": parent_hash, "manifest_sha256": dataset_version_sha256.lower(),
                     "local_manifest_sha256": sha256_file(manifest),
                     "config_sha256": config_sha, "architecture_sha256": architecture_sha,
                     "vocabulary_sha256": ORIGINAL_VOCAB_SHA256, "validation_loss": validation_loss,
                     "best_validation_loss": best_validation_loss, "best_step": best_step,
                     "best_model_sha256": best_model_sha256,
                     "best_model_filename": best_model_path.name if best_model_path else None,
                     "model_state": trainer.model.state_dict(), "optimizer_state": trainer.optimizer.state_dict(),
                     "scheduler_state": trainer.scheduler.state_dict(), "scaler_state": scaler.state_dict(),
                     "rng_state": _rng_state(torch)}
            temporary = checkpoint_path.with_suffix(".tmp")
            torch.save(state, temporary)
            temporary.replace(checkpoint_path)
    if (best_model_path is None or not best_model_path.is_file()
            or best_model_sha256 != sha256_file(best_model_path)):
        raise ValueError("no intact best validation checkpoint is available")
    best_model = torch.load(best_model_path, map_location=cfg["device"], weights_only=True)
    trainer.model.load_state_dict(best_model, strict=True)
    torch.save(trainer.model.state_dict(), candidate_path)
    result = {"model_family": ORIGINAL_MODEL_FAMILY, "profile": profile, "parent_checkpoint_sha256": parent_hash,
              "checkpoint_sha256": sha256_file(candidate_path), "config_sha256": config_sha,
              "architecture_sha256": architecture_sha, "vocabulary_sha256": ORIGINAL_VOCAB_SHA256,
              "manifest_sha256": dataset_version_sha256.lower(), "local_manifest_sha256": sha256_file(manifest),
              "dataset_receipt_sha256": sha256_file(dataset_receipt_path), "steps": step, "candidate_path": str(candidate_path),
              "validation_loss": validation_loss, "best_validation_loss": best_validation_loss,
              "best_step": best_step, "best_model_sha256": best_model_sha256,
              "best_model_filename": best_model_path.name,
              "device": cfg["device"], "fp16": amp_enabled,
              "freeze_steps": freeze_steps, "batch_size": batch_size,
              "status": "CANDIDATE_REQUIRES_LOCKED_BENCHMARK"}
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
    parser.add_argument("--batch-size", type=int, default=32)
    parser.add_argument("--freeze-epochs", type=int, default=5)
    parser.add_argument("--no-fp16", action="store_true", help="Disable CUDA mixed precision")
    parser.add_argument("--seed", type=int, default=20261112)
    parser.add_argument("--resume", action="store_true")
    args = parser.parse_args()
    print(json.dumps(run_training(profile=args.profile, manifest_path=args.manifest, output_dir=args.output,
                                  parent_checkpoint=args.parent, total_steps=args.steps, batch_size=args.batch_size,
                                  dataset_receipt_path=args.dataset_receipt, dataset_version_sha256=args.dataset_version_sha256,
                                  seed=args.seed, resume=args.resume, freeze_epochs=args.freeze_epochs,
                                  use_fp16=not args.no_fp16), ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
