"""JSON-only offline engine subprocess; all media stays in its job workspace."""
import argparse
from contextlib import redirect_stdout
import json
import os
from pathlib import Path
import sys

SAFE = {
    "NO_USABLE_VOCALS", "REFERENCE_TIMELINE_MISMATCH", "LYRICS_NOT_MATCHED",
    "INVALID_PROVIDER_RESULT", "MEDIA_UNAVAILABLE", "PROCESSING_CONFIGURATION_INVALID",
    "UNSUPPORTED_LYRIC_UNIT", "INVALID_ALIGNMENT_PATH", "MODEL_ARCHITECTURE_MISMATCH",
}


def _pairs(items):
    result = {}
    for key, value in items:
        if key in result:
            raise ValueError("INVALID_PROVIDER_RESULT")
        result[key] = value
    return result


def _media(root, raw):
    path = Path(raw).resolve(strict=True)
    if not path.is_file() or not path.is_relative_to(root):
        raise ValueError("MEDIA_UNAVAILABLE")
    return path


def run(request):
    if not isinstance(request, dict) or set(request) - {
        "step", "workspace", "audio", "reference", "model_path", "stem_model_path", "texts"
    }:
        raise ValueError("INVALID_PROVIDER_RESULT")
    root = Path(request["workspace"]).resolve(strict=True)
    if not root.is_dir():
        raise ValueError("MEDIA_UNAVAILABLE")
    audio = _media(root, request["audio"])
    step = request["step"]
    if step == "separate":
        from media_engine import separate
        return separate(audio, root, request["stem_model_path"])
    if step == "verify_reference":
        from media_engine import verify_reference
        return verify_reference(audio, _media(root, request["reference"]))
    if step == "align":
        from ctc_engine import LocalSingingAligner, decode_audio
        texts = request["texts"]
        if (not isinstance(texts, list) or not 1 <= len(texts) <= 10000
                or any(not isinstance(item, str) or not 1 <= len(item) <= 300 for item in texts)
                or sum(map(len, texts)) > 50000):
            raise ValueError("LYRICS_NOT_MATCHED")
        evidence = LocalSingingAligner(request["model_path"]).align(decode_audio(audio), texts)
        for index, (unit, text) in enumerate(zip(evidence["units"], texts)):
            unit.update(index=index, text=text)
            unit.pop("ctc_end_ms", None)
        return evidence
    raise ValueError("INVALID_PROVIDER_RESULT")


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--json", action="store_true", required=True)
    parser.parse_args()
    os.environ["HF_HUB_OFFLINE"] = "1"
    os.environ["TRANSFORMERS_OFFLINE"] = "1"
    os.environ["HF_HUB_DISABLE_TELEMETRY"] = "1"
    try:
        data = sys.stdin.buffer.read(2 * 1024 * 1024 + 1)
        if len(data) > 2 * 1024 * 1024:
            raise ValueError("INVALID_PROVIDER_RESULT")
        request = json.loads(data.decode("utf-8"), object_pairs_hook=_pairs,
                             parse_constant=lambda value: (_ for _ in ()).throw(ValueError()))
        with redirect_stdout(sys.stderr):
            result = run(request)
        print(json.dumps({"ok": True, "result": result}, ensure_ascii=False, allow_nan=False))
        return 0
    except Exception as error:
        code = str(error) if isinstance(error, ValueError) and str(error) in SAFE else "INVALID_PROVIDER_RESULT"
        if code in {"UNSUPPORTED_LYRIC_UNIT", "INVALID_ALIGNMENT_PATH"}:
            code = "LYRICS_NOT_MATCHED"
        if code == "MODEL_ARCHITECTURE_MISMATCH":
            code = "PROCESSING_CONFIGURATION_INVALID"
        print(json.dumps({"ok": False, "error": code}))
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
