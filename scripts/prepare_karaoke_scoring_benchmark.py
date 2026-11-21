"""Prepare the reviewed ELLA research cache for live-scoring evaluation.

No network or microphone access. The corpus must contain source-manifest.json,
asset-0.mp3 and lyrics.txt under app-2, app-3 and app-6. See the source/license
review in docs/karaoke-auto-import/ELLA-CALIBRATION-20261119.md.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import shutil
import subprocess
import uuid
import wave
from pathlib import Path


def convert(source: Path, destination: Path, seconds: int | None = None) -> None:
    command = ["ffmpeg", "-y", "-v", "error", "-i", str(source)]
    if seconds is not None:
        command.extend(["-t", str(seconds)])
    subprocess.run(command + ["-ar", "44100", "-ac", "1", str(destination)], check=True)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--corpus-root", type=Path, required=True)
    parser.add_argument("--output-dir", type=Path, required=True)
    args = parser.parse_args()
    root = args.output_dir.resolve()
    root.mkdir(parents=True, exist_ok=True)
    repository = Path(__file__).resolve().parents[1]
    records = []
    for app in (2, 3, 6):
        folder = args.corpus_root / f"app-{app}"
        origin = json.loads((folder / "source-manifest.json").read_text(encoding="utf-8"))
        mp3 = folder / "asset-0.mp3"
        if hashlib.sha256(mp3.read_bytes()).hexdigest() != origin["assets"][0]["sha256"]:
            raise ValueError(f"Source hash mismatch for app {app}")
        audio = root / f"app-{app}.wav"
        reference = root / f"app-{app}.txt"
        lyric_path = root / f"app-{app}.json"
        convert(mp3, audio)
        shutil.copyfile(folder / "lyrics.txt", reference)
        with wave.open(str(audio)) as stream:
            duration = round(1000 * stream.getnframes() / stream.getframerate())
        lyric = {"format_version": 1, "lines": [{
            "id": str(uuid.uuid5(uuid.NAMESPACE_URL, origin["assets"][0]["url"])),
            "text": reference.read_text(encoding="utf-8").strip(),
            "start_ms": 0, "end_ms": duration,
        }]}
        lyric_path.write_text(json.dumps(lyric, ensure_ascii=False), encoding="utf-8")
        records.append({
            "id": f"app-{app}", "split": "diagnostic" if app == 3 else "calibration",
            "audio": str(audio), "reference": str(reference), "lyrics": str(lyric_path),
            "source": origin["assets"][0]["url"], "duration_ms": duration,
            "sha256": hashlib.sha256(audio.read_bytes()).hexdigest(),
        })
    convert(repository / "docs/karaoke-demo/ngoi-sao-nho.mp3", root / "piano.wav", 16)
    with wave.open(str(root / "silence.wav"), "wb") as stream:
        stream.setnchannels(1)
        stream.setsampwidth(2)
        stream.setframerate(44100)
        stream.writeframes(bytes(44100 * 2 * 5))
    (root / "empty.txt").write_text("", encoding="utf-8")
    for name in ("piano", "silence"):
        audio = root / f"{name}.wav"
        records.append({
            "id": name, "split": "negative", "audio": str(audio),
            "reference": str(root / "empty.txt"),
            "lyrics": str(repository / "docs/karaoke-demo/ngoi-sao-nho-v2.json"),
            "sha256": hashlib.sha256(audio.read_bytes()).hexdigest(),
        })
    manifest = {
        "attribution": "ELLA, Commonwealth of Australia, CC BY-NC 4.0. WAV conversion and whole-line timing modified for noncommercial evaluation. Piano: existing project fixture.",
        "reference_quality": "Published lyrics; not independent human-labelled singing timestamps or child speakers. App 3 was held out for the first run, then inspected for digit normalization; reuse is diagnostic.",
        "records": records,
    }
    (root / "manifest.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"Prepared {len(records)} verified public/synthetic recordings in {root}")


if __name__ == "__main__":
    main()
