from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path
from typing import Any

from .contracts import sha256_file

MAX_STORAGE_OBJECT_BYTES = 40 * 1024 * 1024


def shard_file(source_path: str | Path, output_dir: str | Path, *, chunk_bytes: int = MAX_STORAGE_OBJECT_BYTES) -> dict[str, Any]:
    source = Path(source_path)
    if not source.is_file() or chunk_bytes <= 0 or chunk_bytes > MAX_STORAGE_OBJECT_BYTES:
        raise ValueError("source must exist and shard size must be between 1 byte and 40 MiB")
    target = Path(output_dir)
    target.mkdir(parents=True, exist_ok=True)
    chunks: list[dict[str, Any]] = []
    with source.open("rb") as stream:
        index = 0
        while True:
            block = stream.read(chunk_bytes)
            if not block:
                break
            digest = hashlib.sha256(block).hexdigest()
            name = f"part-{index:04d}-{digest[:12]}.bin"
            path = target / name
            if path.exists():
                raise FileExistsError(f"refusing to overwrite existing shard: {path}")
            path.write_bytes(block)
            chunks.append({"index": index, "name": name, "bytes": len(block), "sha256": digest})
            index += 1
    manifest = {"schema": "viread-checkpoint-shards-v1", "filename": source.name,
                "bytes": source.stat().st_size, "sha256": sha256_file(source), "chunk_bytes_limit": chunk_bytes,
                "chunks": chunks}
    manifest_path = target / "shards.manifest.json"
    if manifest_path.exists():
        raise FileExistsError(f"refusing to overwrite existing shard manifest: {manifest_path}")
    manifest_path.write_text(json.dumps(manifest, ensure_ascii=False, sort_keys=True, indent=2), encoding="utf-8")
    return manifest


def assemble_shards(manifest: dict[str, Any], shard_dir: str | Path, destination: str | Path) -> str:
    if manifest.get("schema") != "viread-checkpoint-shards-v1":
        raise ValueError("unsupported checkpoint shard manifest")
    output = Path(destination)
    if output.exists():
        raise FileExistsError(f"refusing to overwrite existing checkpoint: {output}")
    output.parent.mkdir(parents=True, exist_ok=True)
    temporary = output.with_name(output.name + ".assembling")
    digest = hashlib.sha256()
    written = 0
    try:
        with temporary.open("xb") as stream:
            chunks = sorted(manifest.get("chunks", []), key=lambda chunk: int(chunk["index"]))
            if [int(chunk["index"]) for chunk in chunks] != list(range(len(chunks))):
                raise ValueError("checkpoint shard indices are incomplete")
            for chunk in chunks:
                part = Path(shard_dir) / str(chunk["name"])
                data = part.read_bytes()
                if len(data) != int(chunk["bytes"]) or hashlib.sha256(data).hexdigest() != chunk["sha256"]:
                    raise ValueError(f"checkpoint shard failed integrity check: {part.name}")
                stream.write(data)
                digest.update(data)
                written += len(data)
        if written != int(manifest["bytes"]) or digest.hexdigest() != manifest["sha256"]:
            raise ValueError("assembled checkpoint failed integrity check")
        os.replace(temporary, output)
    except Exception:
        temporary.unlink(missing_ok=True)
        raise
    return digest.hexdigest()
