from __future__ import annotations

import argparse
import hashlib
import json
import random
from pathlib import Path

from .contracts import DatasetRow, normalize_label, sha256_file, stable_split, write_jsonl


def generate_trdg(*, texts: list[str], font: str, output_dir: str | Path, count_per_text: int = 1,
                  seed: int = 20261112) -> tuple[list[DatasetRow], list[dict[str, object]]]:
    if not Path(font).is_file():
        raise ValueError("TRDG font file must be supplied and available")
    if not texts or count_per_text < 1:
        raise ValueError("non-empty text corpus and positive count_per_text are required")
    try:
        from trdg.generators import GeneratorFromStrings
    except ImportError as exc:
        raise RuntimeError("install the pinned ai/vietocr_v2/requirements.txt before TRDG generation") from exc
    root = Path(output_dir)
    root.mkdir(parents=True, exist_ok=True)
    rows: list[DatasetRow] = []
    provenance: list[dict[str, object]] = []
    font_hash = sha256_file(font)
    for source_index, source_text in enumerate(texts):
        label = normalize_label(source_text)
        group = hashlib.sha256(label.encode("utf-8")).hexdigest()
        sample_seed = seed + source_index
        random.seed(sample_seed)
        generator = GeneratorFromStrings([label], count=count_per_text, fonts=[font],
                                         language="vi")
        for render_index, (image, rendered) in enumerate(generator):
            rendered = normalize_label(str(rendered))
            if rendered != label:
                raise ValueError("TRDG returned a label that differs from its source string")
            relative = Path("flow2_trdg") / group[:2] / f"{group}-{render_index:05d}.png"
            target = root / relative
            target.parent.mkdir(parents=True, exist_ok=True)
            image.save(target, format="PNG")
            rows.append(DatasetRow(target.resolve().as_posix(), label, group, "FLOW2_TRDG",
                                   stable_split(group), sha256_file(target), False, None))
            provenance.append({"image": target.resolve().as_posix(), "source_string_sha256": group,
                               "font_sha256": font_hash,
                               "generator": "trdg", "seed": sample_seed, "render_index": render_index})
    return rows, provenance


def main() -> None:
    parser = argparse.ArgumentParser(description="Create Flow 2 synthetic Vietnamese line images using TRDG")
    parser.add_argument("--texts", required=True, help="UTF-8 file, one source line per record")
    parser.add_argument("--font", required=True, help="Vietnamese-capable font; its SHA is recorded")
    parser.add_argument("--output", required=True)
    parser.add_argument("--count-per-text", type=int, default=1)
    parser.add_argument("--seed", type=int, default=20261112)
    args = parser.parse_args()
    texts = Path(args.texts).read_text(encoding="utf-8").splitlines()
    rows, provenance = generate_trdg(texts=texts, font=args.font, output_dir=args.output,
                                     count_per_text=args.count_per_text, seed=args.seed)
    root = Path(args.output)
    digest = write_jsonl(root / "flow2_trdg.jsonl", rows)
    (root / "flow2_trdg_provenance.json").write_text(json.dumps(provenance, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps({"manifest_sha256": digest, "generated": len(rows), "flow": "FLOW2_TRDG"}))


if __name__ == "__main__":
    main()
