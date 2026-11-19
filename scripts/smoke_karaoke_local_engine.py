"""Research-only technical composite smoke; NOT a representative song benchmark.

Run in the isolated AI environment. Output stays local; no DB, account, provider,
publication or upload. Caller must supply recordings licensed for this analysis.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile

REPO = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPO / "ai/karaoke_processing"))


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--vocal", type=Path, required=True)
    parser.add_argument("--background", type=Path, required=True)
    parser.add_argument("--model", type=Path, required=True)
    parser.add_argument("--stem-model", type=Path, required=True)
    parser.add_argument("--output-root", type=Path, required=True)
    parser.add_argument("--texts", nargs="+", default=["ba", "ba"])
    parser.add_argument("--research-only", action="store_true", required=True)
    args = parser.parse_args()
    from media_engine import decode, encode
    import numpy as np
    root = args.output_root.resolve()
    if len(root.parts) < 3 or root == Path.home().resolve() or root == REPO:
        raise ValueError("Unsafe output directory")
    root.mkdir(parents=True, exist_ok=True)
    work = Path(tempfile.mkdtemp(prefix="composite-smoke-", dir=root))
    vocal = decode(args.vocal, channels=2)
    background = decode(args.background, channels=2)
    count = min(len(vocal), len(background), 5 * 44100)
    mixed = vocal[:count] * 0.65 + background[:count] * 0.25
    mixed *= min(1.0, 0.9 / max(1e-9, float(np.max(abs(mixed)))))
    source = work / "source.mp3"
    input_clock = encode(mixed, 44100, source)

    def call(step, audio, **extra):
        payload = dict(step=step, workspace=str(work), audio=str(audio),
                       model_path=str(args.model.resolve()), stem_model_path=str(args.stem_model.resolve()),
                       **extra)
        env = dict(os.environ, PYTHONUTF8="1", PYTHONIOENCODING="utf-8",
                   HF_HUB_OFFLINE="1", TRANSFORMERS_OFFLINE="1")
        process = subprocess.run(
            [sys.executable, "-B", str(REPO / "ai/karaoke_processing/runner.py"), "--json"],
            input=json.dumps(payload).encode(), capture_output=True, timeout=180, env=env,
            creationflags=subprocess.CREATE_NO_WINDOW if hasattr(subprocess, "CREATE_NO_WINDOW") else 0)
        response = json.loads(process.stdout)
        if process.returncode != 0 or not response["ok"]:
            raise ValueError(response.get("error", "INVALID_PROVIDER_RESULT"))
        return response["result"]

    try:
        stems = call("separate", source)
        alignment = call("align", stems["vocal"], texts=args.texts)
        report = dict(status="technical_smoke_passed", evidence_kind="research_composite",
                      representative_song_benchmark=False, production_quality_gate="NOT_EVALUATED",
                      workspace=str(work), source_sha256=hashlib.sha256(source.read_bytes()).hexdigest(),
                      source_encoder_clock=input_clock, stems=stems, alignment=alignment)
        (work / "report.json").write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
        print(json.dumps(report, ensure_ascii=True))
        return 0
    except (ValueError, subprocess.TimeoutExpired) as error:
        print(json.dumps(dict(status="failed", workspace=str(work), safe_error=str(error)[:80])))
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
