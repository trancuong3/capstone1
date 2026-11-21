"""Offline ASR candidate evaluation, never a runtime scoring provider.

Uses the locally reviewed pdnhan/PhoWhisper-small-mobile ONNX export. No lyric
prompt, forced alignment, microphone access, model download or backend calls.
Run in the research Python environment with transformers + onnxruntime.
References are read only AFTER free decoding. Published lyric WER is not an
independent human assessment of the child's singing or timestamp correctness.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import re
import subprocess
import sys
import time
import unicodedata
from pathlib import Path


def tokens(text: str) -> list[str]:
    return re.findall(r"\w+", unicodedata.normalize("NFC", text).lower(), re.UNICODE)


def edit_distance(expected: list[str], actual: list[str]) -> int:
    row = list(range(len(actual) + 1))
    for i, word in enumerate(expected, 1):
        next_row = [i]
        for j, heard in enumerate(actual, 1):
            next_row.append(min(next_row[-1] + 1, row[j] + 1, row[j - 1] + (word != heard)))
        row = next_row
    return row[-1]


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--model-dir", type=Path, required=True)
    parser.add_argument("--manifest", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--ort-packages", type=Path)
    args = parser.parse_args()
    if args.ort_packages:
        sys.path.insert(0, str(args.ort_packages.resolve()))
    pinned = {
        "encoder_model_quantized.onnx": "59994c14fb3e9523e1b518ffd2d9eb2152c8c6c8743bf22d8bd8adcb5870ae2f",
        "decoder_model_merged_quantized.onnx": "c524f278845ec1fdc157f5c0fc6b05a541f90ca11d9f6362c2e63dc78168e09c",
    }
    for filename, expected_hash in pinned.items():
        if hashlib.sha256((args.model_dir / "onnx" / filename).read_bytes()).hexdigest() != expected_hash:
            raise ValueError(f"Model differs from the reviewed revision: {filename}")
    import numpy as np
    import onnxruntime as ort
    import torch
    from transformers import WhisperFeatureExtractor, WhisperTokenizer

    torch.set_num_threads(2)
    start = time.perf_counter()
    options = ort.SessionOptions()
    options.intra_op_num_threads = 2
    options.inter_op_num_threads = 1
    encoder_path = args.model_dir / "onnx/encoder_model_quantized.onnx"
    decoder_path = args.model_dir / "onnx/decoder_model_merged_quantized.onnx"
    encoder = ort.InferenceSession(str(encoder_path), options, providers=["CPUExecutionProvider"])
    decoder = ort.InferenceSession(str(decoder_path), options, providers=["CPUExecutionProvider"])
    extractor = WhisperFeatureExtractor.from_pretrained(str(args.model_dir), local_files_only=True)
    tokenizer = WhisperTokenizer.from_pretrained(str(args.model_dir), local_files_only=True)
    generation = json.loads((args.model_dir / "generation_config.json").read_text(encoding="utf-8"))
    suppress = generation.get("suppress_tokens", [])
    begin_suppress = generation.get("begin_suppress_tokens", [])
    load_seconds = time.perf_counter() - start
    manifest = json.loads(args.manifest.read_text(encoding="utf-8"))
    results = []
    for record in manifest["records"]:
        audio_path = Path(record["audio"])
        audio_bytes = audio_path.read_bytes()
        digest = hashlib.sha256(audio_bytes).hexdigest()
        if digest != record["sha256"]:
            raise ValueError(f"Audio hash changed: {record['id']}")
        pcm = subprocess.run([
            "ffmpeg", "-v", "error", "-i", str(audio_path), "-ar", "16000",
            "-ac", "1", "-f", "f32le", "pipe:1",
        ], check=True, capture_output=True).stdout
        audio = np.frombuffer(pcm, dtype=np.float32)
        if len(audio) > 30 * 16000:
            raise ValueError("This fixed-corpus probe accepts recordings up to 30 seconds")
        started = time.perf_counter()
        features = extractor(audio, sampling_rate=16000, return_tensors="np").input_features
        hidden = encoder.run(None, {"input_features": features})[0]
        feed = {
            "input_ids": np.array([[50258, 50278, 50359, 50363]], dtype=np.int64),
            "encoder_hidden_states": hidden,
            "use_cache_branch": np.array([False]),
        }
        for item in decoder.get_inputs():
            if item.name.startswith("past_key_values."):
                feed[item.name] = np.zeros((1, 12, 0, 64), dtype=np.float32)
        decoded = []
        finished = False
        for step in range(128):
            outputs = dict(zip([o.name for o in decoder.get_outputs()], decoder.run(None, feed)))
            logits = outputs["logits"][0, -1].copy()
            logits[suppress] = -np.inf
            if step == 0:
                logits[begin_suppress] = -np.inf
            token = int(logits.argmax())
            if token == 50257:
                finished = True
                break
            decoded.append(token)
            feed["input_ids"] = np.array([[token]], dtype=np.int64)
            feed["use_cache_branch"] = np.array([True])
            for name, value in outputs.items():
                if name.startswith("present.") and (".decoder." in name or step == 0):
                    feed[name.replace("present.", "past_key_values.", 1)] = value
        transcript = tokenizer.decode(decoded, skip_special_tokens=True).strip()
        seconds = time.perf_counter() - started
        reference = Path(record["reference"]).read_text(encoding="utf-8")
        expected, heard = tokens(reference), tokens(transcript)
        errors = edit_distance(expected, heard)
        result = {
            "id": record["id"], "split": record["split"], "sha256": digest,
            "duration_seconds": len(audio) / 16000, "inference_seconds": round(seconds, 3),
            "transcript": transcript, "reference_words": len(expected),
            "recognized_words": len(heard), "word_edits": errors,
            "wer": round(errors / len(expected), 4) if expected else None,
            "completed_decode": finished,
        }
        results.append(result)
        print(json.dumps({k: v for k, v in result.items() if k != "transcript"}), flush=True)
    report = {
        "model": "pdnhan/PhoWhisper-small-mobile",
        "revision": "9b0cc3c44a701d6107b5ad0052e5546626e41bad",
        "model_hashes": {p.name: hashlib.sha256(p.read_bytes()).hexdigest() for p in [encoder_path, decoder_path]},
        "runtime": ort.__version__, "threads": 2, "load_seconds": round(load_seconds, 3),
        "reference_quality": manifest["reference_quality"], "results": results,
    }
    args.output.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")


if __name__ == "__main__":
    main()
