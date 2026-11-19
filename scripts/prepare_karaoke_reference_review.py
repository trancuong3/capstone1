"""Build a local, prediction-blind listening worksheet from a frozen corpus.

No server, database, model or network is used. Output must be a new HTML file
inside the corpus directory so that its original MP3 links stay local.
"""
import argparse
import hashlib
import json
from pathlib import Path
import sys
from urllib.parse import quote

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "backend"))
from app.schemas.karaoke import Lyrics

LIMIT = 2 * 1024 * 1024


def read_json(path):
    with path.open("rb") as stream:
        raw = stream.read(LIMIT + 1)
    if len(raw) > LIMIT:
        raise ValueError("JSON exceeds limit")
    return json.loads(raw.decode("utf-8"))


def local_file(root, relative):
    if not isinstance(relative, str) or not relative:
        raise ValueError("Local file required")
    path = (root / relative).resolve(strict=True)
    if not path.is_relative_to(root) or not path.is_file():
        raise ValueError("File outside corpus")
    return path


def digest(path):
    with path.open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def prepare(manifest_path):
    root = manifest_path.resolve(strict=True).parent
    manifest = read_json(manifest_path)
    tracks = manifest["tracks"]
    if not isinstance(tracks, list) or not 1 <= len(tracks) <= 10:
        raise ValueError("Expected 1-10 tracks")
    output, seen = [], set()
    for track in tracks:
        if track["id"] in seen:
            raise ValueError("Duplicate track identity")
        seen.add(track["id"])
        if type(track["duration_ms"]) is not int or not 1 <= track["duration_ms"] <= 300000:
            raise ValueError("Invalid duration")
        audio_assets = [a for a in track["assets"] if str(a["file"]).lower().endswith(".mp3")]
        if len(audio_assets) != 1:
            raise ValueError("Exactly one original MP3 required")
        asset = audio_assets[0]
        audio = local_file(root, asset["file"])
        if not 1 <= audio.stat().st_size <= 20 * 1024 * 1024 or digest(audio) != asset["sha256"]:
            raise ValueError("Audio identity mismatch")
        lyrics_file = local_file(root, track["lyrics_file"])
        if digest(lyrics_file) != track["lyrics_sha256"]:
            raise ValueError("Lyric identity mismatch")
        lyrics = Lyrics.model_validate(read_json(lyrics_file))
        if lyrics.format_version != 2 or not lyrics.lines or any(not line.syllables for line in lyrics.lines):
            raise ValueError("Nonempty v2 lyrics required")
        if any(mark is not None for line in lyrics.lines
               for mark in [line.start_ms, line.end_ms, *[m for u in line.syllables for m in (u.start_ms, u.end_ms)]]):
            raise ValueError("Reference collection must not contain predicted timings")
        output.append(dict(id=track["id"], title=track["title"], duration_ms=track["duration_ms"],
            audio_url=quote(audio.relative_to(root).as_posix(), safe="/"), audio_sha256=asset["sha256"],
            lyrics_sha256=track["lyrics_sha256"], lyrics=lyrics.model_dump(mode="json"),
            attribution=track["attribution"], source_url=track["source"]["url"],
            license=track["license"], license_url=track["license_url"]))
    return dict(corpus_id=manifest["corpus_id"], manifest_sha256=digest(manifest_path), tracks=output)


def render(bundle):
    template = (Path(__file__).with_name("karaoke_reference_review.html")).read_text(encoding="utf-8")
    # Keep arbitrary song/lyric text inside JSON, never executable markup.
    data = json.dumps(bundle, ensure_ascii=False, allow_nan=False).replace("<", "\\u003c").replace(">", "\\u003e").replace("&", "\\u0026")
    return template.replace('"__REVIEW_DATA__"', data)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--manifest", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    root = args.manifest.resolve(strict=True).parent
    target = args.output.resolve()
    if target.parent != root or target.suffix.lower() != ".html":
        raise ValueError("Output must be a new HTML file directly inside corpus directory")
    bundle = prepare(args.manifest)
    result = render(bundle)
    with target.open("x", encoding="utf-8", newline="\n") as stream:
        stream.write(result)
    print(json.dumps(dict(status="PREPARED", tracks=len(bundle["tracks"]),
        human_reference_created=False, quality_gate_status="NOT_EVALUATED")))


if __name__ == "__main__":
    main()
