"""Create PRIVATE image-crop review of frozen Tesseract OCR tone proposals.

The generated HTML includes original cropped photos and OCR/manifest text.
Never upload it to Git, CI, Vercel, chat, or cloud storage. Suggestions are
proposed from engine evidence BEFORE reference text is read for scoring.
Production OCR/checkpoints/word boxes are not modified.
"""
from __future__ import annotations

import argparse
import html
import json
import math
import os
import re
import sys
from collections import Counter
from pathlib import Path

BACKEND_ROOT = Path(__file__).resolve().parents[1]
if str(BACKEND_ROOT) not in sys.path:
    sys.path.insert(0, str(BACKEND_ROOT))

from scripts.ocr_box_tightness_probe import verify_ocr_output
from scripts.ocr_real_photo_benchmark import MAX_CASES, Case, load_cases, normalize
from scripts.ocr_tone_blind_policy import propose_text
from scripts.ocr_tesseract_review_risk import assess_review_risk
from scripts.ocr_vietnamese_artifact_ab import _word_surface_sequence, score_pair
from scripts.ocr_word_error_diagnostics import analyze_word_errors

REVIEW_RULES = (
    "tesseract_line_priority",
    "tesseract_line_vietocr_crop_agreement",
)
MAX_CROPS_PER_PAGE = 64


def _safe(value: object) -> str:
    return html.escape(str(value), quote=True)


def _bbox_crop(image: Path, box: object, target: Path) -> None:
    """Crop only a valid normalized source word box and a small surrounding margin."""
    from PIL import Image

    if not isinstance(box, (list, tuple)) or len(box) != 4:
        raise ValueError("Invalid word box")
    x, y, w, h = [float(v) for v in box]
    if (
        not all(map(math.isfinite, (x, y, w, h)))
        or x < 0 or y < 0 or w <= 0 or h <= 0
        or x + w > 1.00001 or y + h > 1.00001
    ):
        raise ValueError("Invalid normalized bounds")
    with Image.open(image) as src:
        # No EXIF transform: OCR boxes refer to original pixel coordinates.
        width, height = src.size
        mx, my = max(w * .30, 8 / width), max(h * .35, 8 / height)
        left = max(0, int((x - mx) * width))
        top = max(0, int((y - my) * height))
        right = min(width, math.ceil((x + w + mx) * width))
        bottom = min(height, math.ceil((y + h + my) * height))
        if left >= right or top >= bottom:
            raise ValueError("Empty crop")
        cropped = src.crop((left, top, right, bottom)).convert("RGB")
        cropped.thumbnail((900, 450), Image.Resampling.LANCZOS)
        cropped.save(target, "PNG", optimize=True)


def _flip_category(
    reference_tokens: list[str], baseline_tokens: list[str],
    index: int, changed: str, *, positional_alignment_safe: bool,
) -> str:
    if not positional_alignment_safe or index >= len(reference_tokens):
        return "ambiguous"
    old = baseline_tokens[index]
    truth = reference_tokens[index]
    if old == truth and changed != truth:
        return "regressed"
    if old != truth and changed == truth:
        return "corrected"
    return "changed_other"


def _render_page(
    case: Case, index: int, output: dict[str, object], private_dir: Path,
) -> tuple[str, dict[str, int]]:
    """Create proposed flips first; use reference only for review labels afterward."""
    proposals = {rule: propose_text(output, rule) for rule in REVIEW_RULES}
    baseline = normalize(output["text"])
    words_and_tokens = _word_surface_sequence(output)
    stats: Counter[str] = Counter()
    stats["pages"] = 1
    if words_and_tokens is None:
        stats["unaligned_pages"] = 1
        return "", dict(stats)
    words, base_tokens = words_and_tokens
    reference = normalize(case.truth)
    reference_tokens = reference.split()
    differences = analyze_word_errors(reference, baseline)
    positional_safe = (
        differences.get("status") == "complete"
        and len(reference_tokens) == len(base_tokens)
        and not any(
            entry["kind"] in {"missing_token", "extra_token"}
            for entry in differences["errors"]
        )
    )
    index_to_policies: dict[int, dict[str, str]] = {}
    for rule, proposal in proposals.items():
        if proposal["status"] == "not_evaluable":
            stats["unevaluable_proposals"] += 1
            continue
        proposed_text = proposal["candidate_text"]
        if not isinstance(proposed_text, str):
            stats["unevaluable_proposals"] += 1
            continue
        candidate_tokens = normalize(proposed_text).split()
        if len(candidate_tokens) != len(base_tokens):
            stats["unevaluable_proposals"] += 1
            continue
        for position in proposal["flip_indices"]:
            if not isinstance(position, int) or position not in range(len(words)):
                raise ValueError("Invalid proposal token index")
            index_to_policies.setdefault(position, {})[rule] = candidate_tokens[position]
            stats[f"{rule}_flips"] += 1
    if not index_to_policies:
        return "", dict(stats)
    if len(index_to_policies) > MAX_CROPS_PER_PAGE:
        raise ValueError("Too many proposed flips to display safely")
    # View suspected damage FIRST; the 18 original flips included 3
    # positional regressions concentrated on a single page.
    severity = {"regressed": 0, "ambiguous": 1, "changed_other": 2, "corrected": 3}
    cards: list[tuple[int, int, str]] = []
    for position, choices in sorted(index_to_policies.items()):
        filename = f"crop_{index:04d}_{position + 1:04d}.png"
        _bbox_crop(case.image, words[position]["bbox"], private_dir / filename)
        predicted = base_tokens[position]
        comparisons: list[str] = []
        candidate_categories: list[str] = []
        for rule, new_text in choices.items():
            category = _flip_category(
                reference_tokens, base_tokens, position, new_text,
                positional_alignment_safe=positional_safe,
            )
            stats[f"{rule}_{category}"] += 1
            candidate_categories.append(category)
            comparisons.append(
                f"<li><b>{_safe(rule)}</b>: {_safe(predicted)} → "
                f"<strong>{_safe(new_text)}</strong> "
                f"<small>({category}; chỉ để kiểm tra)</small></li>"
            )
        ref_word = (
            reference_tokens[position] if positional_safe else
            "Không tự suy luận từ tham chiếu khi lệch vị trí"
        )
        risk_rank = min(severity[label] for label in candidate_categories)
        stats[f"positions_{candidate_categories[0]}"] += 1 if len(
            set(candidate_categories)
        ) == 1 else 0
        stats["positions_to_check_first"] += risk_rank < severity["corrected"]
        cards.append((
            risk_rank, position,
            f'<article class="flip"><img src="crops/{_safe(filename)}" '
            f'alt="Cắt ảnh từ OCR số {position + 1}" loading="lazy">'
            f'<div><p><b>Từ #{position + 1}</b> · '
            f'<span>Đối chứng theo vị trí: {_safe(ref_word)}</span></p>'
            f'<ul>{"".join(comparisons)}</ul></div></article>',
        ))
    stats["distinct_positions"] = len(index_to_policies)
    before = score_pair(reference, baseline)
    original = (
        f"Baseline CER edits {before['character_edits']}, "
        f"WER edits {before['word_edits']}"
    )
    body = f"""
    <section class="page"><h2>Trang {index:02d} — {_safe(case.condition)}</h2>
    <p>{_safe(original)} · {len(index_to_policies)} vị trí cần đối chứng</p>
    <p><b>Ưu tiên kiểm tra:</b> {stats['positions_to_check_first']}
    vị trí có sửa sai, chưa căn chỉnh được, hoặc vẫn sai theo tham chiếu.
    Các vị trí nghi ngờ được xếp đầu trang.</p>
    {''.join(markup for _priority, _position, markup in sorted(cards))}
    <details><summary>Nội dung tham chiếu trang (riêng tư)</summary>
    <p><b>Văn bản tham chiếu:</b> {_safe(reference)}</p>
    <p><b>OCR gốc:</b> {_safe(baseline)}</p>
    </details></section>"""
    return body, dict(stats)


def _render_html(sections: list[str], stats: dict[str, object]) -> str:
    return f"""<!DOCTYPE html><html lang="vi"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src 'self'; style-src 'unsafe-inline'">
<title>ViRead — Private OCR word-change review</title>
<style>
body {{ background:#f3f5f9;color:#192743;font:16px/1.55 system-ui,sans-serif; }}
main {{ max-width:1120px; margin:auto;padding:20px; }}
.page {{ background:white;border-radius:14px;padding:18px;margin:20px 0; }}
.flip {{ display:grid;grid-template-columns:minmax(150px,300px) 1fr;gap:20px;
align-items:center;padding:14px 0;border-top:1px solid #e3e8f0; }}
.flip img {{ width:100%; height:auto; max-height:220px; object-fit:contain;
background:#eef2f7; border:1px solid #b5c7db;border-radius:8px; }}
.notice {{ background:#fff5d7;border-left:4px solid #bb8b16;padding:12px; }}
li {{ margin:7px 0; }} small {{ color:#6b6670; }}
@media(max-width:700px){{.flip{{grid-template-columns:1fr}}}}
</style></head><body><main>
<h1>ViRead — So sánh những từ OCR định thay đổi</h1>
<div class="notice"><b>Chỉ dùng để đối chứng riêng tư.</b> Đưa các vị trí
có khả năng gây sai hoặc chưa xác định lên đầu danh sách.
Ảnh, chữ,
văn bản tham chiếu KHÔNG được gửi lên GitHub, chat hay cloud.
Nhãn corrected/regressed dựa trên token ở cùng vị trí và có thể
không phản ánh căn chỉnh thực; hãy kiểm tra lại trên ảnh gốc.
Đây không phải nhãn ground truth độc lập, không bật trong production.</div>
<p>Đã xử lý {_safe(stats["successful_pages"])}/{_safe(stats["dataset_pages"])} trang;
vị trí khác nhau cần đối chứng: {_safe(stats["distinct_positions"])}.</p>
{''.join(sections)}
</main></body></html>"""


def make_report(
    cases: list[Case], target: Path, expected_profile: str, expected_sha: str,
) -> dict[str, object]:
    """Only private local output; errors sanitized into exception-type counts."""
    import torch  # noqa: F401; matches Windows Paddle/CUDA import order
    from app.services.ocr_engine import extract_text_and_boxes

    crops = target / "crops"
    crops.mkdir(mode=0o700)
    summaries: Counter[str] = Counter()
    failures: Counter[str] = Counter()
    sections: list[tuple[int, int, str]] = []
    for index, case in enumerate(cases, 1):
        try:
            output = extract_text_and_boxes(case.image.read_bytes())
            verify_ocr_output(
                output, expected_profile=expected_profile, expected_sha=expected_sha,
            )
            section, counts = _render_page(case, index, output, crops)
            summaries.update(counts)
            summaries["successful_pages"] += 1
            if section:
                # Risk-first across pages as well, but keep source page
                # numbers and deterministic order among equal risks.
                if counts.get("tesseract_line_priority_regressed", 0):
                    priority = 0
                elif counts.get("positions_to_check_first", 0):
                    priority = 1
                else:
                    priority = 2
                sections.append((priority, index, section))
        except Exception as exc:
            # Critical: NEVER print exception messages (may contain image text).
            failures[type(exc).__name__] += 1
    generated_crops = list(crops.glob("crop_*.png"))
    crop_files_consistent = (
        len(generated_crops) == summaries["distinct_positions"]
        and all(file.is_file() and file.stat().st_size > 0 for file in generated_crops)
    )
    stats = {
        "dataset_pages": len(cases),
        "successful_pages": summaries["successful_pages"],
        "failed_pages": len(cases) - summaries["successful_pages"],
        "failure_exception_types": dict(sorted(failures.items())),
        "distinct_positions": summaries["distinct_positions"],
        "positions_to_check_first": summaries["positions_to_check_first"],
        "crop_artifact_count": len(generated_crops),
        "crop_artifacts_consistent": crop_files_consistent,
        "policy_flip_review_counts": {
            rule: {
                name: summaries[f"{rule}_{name}"]
                for name in ("flips", "corrected", "regressed", "changed_other", "ambiguous")
            } for rule in REVIEW_RULES
        },
        "reference_only_used_after_proposals": True,
        "review_is_private": True,
        "human_verified_independent_box_truth": False,
        "ocr_production_modified": False,
        "complete": summaries["successful_pages"] == len(cases) and crop_files_consistent,
    }
    stats["risk_assessment"] = assess_review_risk(stats)
    (target / "aggregate.json").write_text(
        json.dumps(stats, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    (target / "index.html").write_text(
        _render_html([section for _, _, section in sorted(sections)], stats),
        encoding="utf-8",
    )
    return stats


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("dataset", type=Path)
    parser.add_argument("--env-file", type=Path, required=True)
    parser.add_argument("--expected-profile", required=True)
    parser.add_argument("--expected-sha", required=True)
    parser.add_argument("--min-pages", type=int, default=10)
    parser.add_argument("--output-dir", type=Path, required=True)
    args = parser.parse_args(argv)
    dataset = args.dataset.expanduser().resolve()
    root = dataset.parent
    target = args.output_dir.expanduser().resolve()
    if root.is_relative_to(BACKEND_ROOT.parent.resolve()):
        parser.error("Dataset must remain outside the repository")
    if target.parent != root or target.exists():
        parser.error("Output must be a NEW private subdirectory directly under dataset root")
    if not 1 <= args.min_pages <= MAX_CASES:
        parser.error("Invalid minimum page count")
    if not re.fullmatch(r"[a-f0-9]{64}", args.expected_sha):
        parser.error("Expected lowercase SHA256")
    if not args.env_file.expanduser().is_file():
        parser.error("Missing private env file")
    try:
        cases = load_cases(dataset)
        if len(cases) < args.min_pages:
            raise ValueError("Not enough private image cases")
    except (OSError, ValueError) as exc:
        print(f"Private dataset validation failed: {type(exc).__name__}", file=sys.stderr)
        return 2
    from dotenv import dotenv_values
    for key, value in dotenv_values(args.env_file.expanduser()).items():
        if value is not None and not (os.getenv(key) or "").strip():
            os.environ[key] = value
    try:
        target.mkdir(mode=0o700)
        report = make_report(
            cases, target, args.expected_profile, args.expected_sha,
        )
    except Exception as exc:
        print(f"Private review failed: {type(exc).__name__}", file=sys.stderr)
        return 2
    print(json.dumps(report, ensure_ascii=False, indent=2))
    return 0 if report["complete"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
