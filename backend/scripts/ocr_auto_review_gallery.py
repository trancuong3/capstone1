"""Run ViRead OCR locally and produce a PRIVATE, human-readable review gallery.

This is automated *prediction review*, NOT independent ground-truth labeling.
The report contains private OCR text, reference text, image pixels and word
boxes, so it must stay outside the repository, CI, cloud services and chat.
"""
from __future__ import annotations

import argparse
import html
import json
import os
import re
import sys
from collections import Counter
from pathlib import Path

BACKEND_ROOT = Path(__file__).resolve().parents[1]
if str(BACKEND_ROOT) not in sys.path:
    sys.path.insert(0, str(BACKEND_ROOT))

from scripts.ocr_box_tightness_probe import verify_ocr_output
from scripts.ocr_real_photo_benchmark import (
    MAX_CASES, Case, edit_distance, load_cases, normalize,
)
from scripts.ocr_word_box_iou import valid_box
from scripts.ocr_word_error_diagnostics import analyze_word_errors

MAX_PREVIEW_SIDE = 1600
MAX_BOXES = 512


def _safe_text(value: object) -> str:
    return html.escape(str(value), quote=True)


def _overlap_count(boxes: list[dict[str, object]]) -> int:
    """Count pairs with positive intersection, not a detector error metric."""
    pairs = 0
    for i, a in enumerate(boxes):
        if not valid_box(a.get("bbox")):
            continue
        ax, ay, aw, ah = a["bbox"]
        for b in boxes[i + 1:]:
            if not valid_box(b.get("bbox")):
                continue
            bx, by, bw, bh = b["bbox"]
            if min(ax + aw, bx + bw) > max(ax, bx) and (
                min(ay + ah, by + bh) > max(ay, by)
            ):
                pairs += 1
    return pairs


def inspect_case(case: Case, output: object, expected_profile: str, expected_sha: str) -> dict[str, object]:
    """Return private per-page proposal and numeric diagnostics."""
    words = verify_ocr_output(
        output, expected_profile=expected_profile, expected_sha=expected_sha,
    )
    if len(words) > MAX_BOXES:
        raise ValueError("OCR word count exceeds review limit")
    predicted = normalize(output.get("text", ""))
    expected = normalize(case.truth)
    if not isinstance(output.get("text"), str):
        raise ValueError("Missing predicted text")
    usable: list[dict[str, object]] = []
    invalid = 0
    for word in words:
        if (
            not isinstance(word, dict)
            or not valid_box(word.get("bbox"))
            or not isinstance(word.get("text"), str)
            or len(word["text"].strip().split()) != 1
        ):
            invalid += 1
            continue
        usable.append({"text": word["text"].strip(), "bbox": list(word["bbox"])})
    reference_tokens = expected.split()
    predicted_tokens = predicted.split()
    character_edits = edit_distance(list(expected), list(predicted))
    word_edits = edit_distance(reference_tokens, predicted_tokens)
    flags: list[str] = []
    if expected != predicted:
        flags.append("Nội dung OCR khác bản tham chiếu")
    if invalid:
        flags.append("Có hộp từ không hợp lệ hoặc không phải một token")
    if len(words) != len(reference_tokens):
        flags.append("Số hộp OCR khác số từ tham chiếu")
    overlaps = _overlap_count(usable)
    if overlaps:
        flags.append("Có các hộp OCR giao nhau; cần kiểm tra trực quan")
    return {
        "status": "machine_proposed_unverified",
        "reference_text": expected,
        "ocr_text": predicted,
        "char_edits": character_edits,
        "reference_chars": len(expected),
        "word_edits": word_edits,
        "reference_words": len(reference_tokens),
        "ocr_boxes": len(words),
        "machine_words": usable,
        "invalid_word_boxes": invalid,
        "overlap_pairs": overlaps,
        "flags": flags,
        "errors": analyze_word_errors(expected, predicted),
    }


def _private_thumbnail(original: Path, target: Path) -> tuple[int, int]:
    from PIL import Image

    with Image.open(original) as opened:
        # Intentionally avoid EXIF transposition; ViRead normalized boxes
        # describe original raster pixels, not a rotated display rendition.
        canvas = opened.convert("RGB")
    canvas.thumbnail((MAX_PREVIEW_SIDE, MAX_PREVIEW_SIDE), Image.Resampling.LANCZOS)
    width, height = canvas.size
    canvas.save(target, "PNG", optimize=True)
    return width, height


def _preview_svg(words: list[dict[str, object]], width: int, height: int) -> str:
    shapes: list[str] = []
    for i, word in enumerate(words, 1):
        box = word["bbox"]
        x, y, w, h = [float(v) for v in box]
        tooltip = _safe_text(f"{i}. {word['text']}")
        shapes.append(
            f'<rect x="{x * width:.3f}" y="{y * height:.3f}" '
            f'width="{w * width:.3f}" height="{h * height:.3f}" '
            f'fill="none" stroke="#087bf4" stroke-width="2" '
            f'vector-effect="non-scaling-stroke"><title>{tooltip}</title></rect>'
        )
    return (
        f'<svg class="overlay" viewBox="0 0 {width} {height}" '
        f'preserveAspectRatio="none" aria-label="Hộp OCR xanh dương">'
        + "".join(shapes) + "</svg>"
    )


def _html_card(
    index: int, case: Case, inspected: dict[str, object],
    image_name: str, width: int, height: int,
) -> str:
    expected, predicted = inspected["reference_text"], inspected["ocr_text"]
    cref = inspected["reference_chars"]
    wref = inspected["reference_words"]
    cer = inspected["char_edits"] / cref if cref else 0.0
    wer = inspected["word_edits"] / wref if wref else 0.0
    flags = inspected["flags"]
    cssclass = "needs-attention" if flags else "exact"
    flag_text = "".join(f"<li>{_safe_text(flag)}</li>" for flag in flags)
    if not flag_text:
        flag_text = "<li>Không phát hiện sai khác theo các phép kiểm tra tự động.</li>"
    error_items: list[str] = []
    for error in inspected["errors"]["errors"]:
        pair = f"{error.get('expected') or '∅'} → {error.get('observed') or '∅'}"
        error_items.append(
            f"<li>{_safe_text(error['kind'])}: {_safe_text(pair)}</li>"
        )
    if inspected["errors"]["status"] != "complete":
        error_items = ["<li>Chưa phân tích được lỗi từ vì giới hạn độ dài.</li>"]
    if not error_items:
        error_items = ["<li>Không có từ sai khác.</li>"]
    words = inspected["machine_words"]
    wordlist = " · ".join(f"{i}. {word['text']}" for i, word in enumerate(words, 1))
    svg = _preview_svg(words, width, height)
    return f"""
    <section class="card {cssclass}">
      <header><h2>Trang {index:02d} — {_safe_text(case.condition)}</h2>
        <span>OCR CER {cer:.2%} · WER {wer:.2%} · {len(words)} hộp hợp lệ</span>
      </header>
      <div class="photo"><img src="{_safe_text(image_name)}" alt="Ảnh gốc trang {index}"
        width="{width}" height="{height}" loading="lazy">{svg}</div>
      <details open><summary>Đối chiếu nội dung</summary>
        <p><strong>Bản tham chiếu:</strong> {_safe_text(expected)}</p>
        <p><strong>OCR nhận ra:</strong> {_safe_text(predicted)}</p>
        <p class="wordlist"><strong>Các từ có hộp:</strong> {_safe_text(wordlist)}</p>
      </details>
      <details><summary>Cần kiểm tra và danh sách lỗi</summary>
        <strong>Cảnh báo</strong><ul>{flag_text}</ul>
        <strong>Khác biệt văn bản</strong><ul>{''.join(error_items)}</ul>
      </details>
    </section>
    """


def _render_html(cards: list[str], report: dict[str, object]) -> str:
    summary = report["aggregate"]
    cer_display = f"{summary['micro_cer']:.2%}" if summary["micro_cer"] is not None else "Chưa đo"
    wer_display = f"{summary['micro_wer']:.2%}" if summary["micro_wer"] is not None else "Chưa đo"
    return f"""<!doctype html>
<html lang="vi"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>ViRead — Bản đối chứng OCR nội bộ</title>
<style>
body {{ margin:0; background:#f3f5f9; color:#15223c;
font:16px/1.55 system-ui,-apple-system,'Segoe UI',Arial,sans-serif; }}
main {{ max-width:1240px; margin:0 auto; padding:24px; }}
h1 {{ margin:0 0 6px; }} .notice {{ background:#fff8e5; border-left:4px solid #d48b00;
padding:12px 16px; margin:18px 0; }}
.stats {{ display:flex; gap:12px; flex-wrap:wrap; }}
.stats div {{ background:white; border-radius:12px; padding:12px 18px; }}
.card {{ margin:20px 0; padding:16px; background:white; border-radius:16px;
box-shadow:0 2px 12px #172c4f16; }}
.card.needs-attention {{ border-left:5px solid #da861c; }}
.card.exact {{ border-left:5px solid #318b61; }}
.card header {{ display:flex; flex-wrap:wrap; align-items:baseline; justify-content:space-between;gap:8px; }}
.card h2 {{ font-size:20px; margin:0 0 12px; }}
.photo {{ position:relative; display:block; width:100%; max-width:100%; line-height:0; }}
.photo img {{ width:100%; height:auto; display:block; }}
.overlay {{ position:absolute; inset:0; width:100%; height:100%; pointer-events:auto; }}
details {{ margin:12px 0; }} summary {{ cursor:pointer; font-weight:600; }}
.wordlist {{ font-size:14px; overflow-wrap:anywhere; }}
</style></head><body><main>
<h1>ViRead — Tự động đọc và tạo bản đối chứng</h1>
<p>Dữ liệu ở ngay trên máy. Chỉ xem và so sánh, không tự xác nhận nhãn.</p>
<div class="notice"><b>Không phải ground truth độc lập.</b> Hộp xanh là dự đoán
OCR của chính mô hình cần kiểm tra. Không dùng nhãn này để tính IoU nghiệm
thu trên ảnh thật. Bản tham chiếu văn bản lấy từ pages.jsonl; nguồn gốc
và độ chính xác của bản đó chưa được công cụ kiểm toán.</div>
<div class="stats">
<div>Trang thành công: <b>{summary['successful_cases']}/{summary['dataset_case_count']}</b></div>
<div>Micro CER: <b>{cer_display}</b></div>
<div>Micro WER: <b>{wer_display}</b></div>
<div>Trang cần xem kỹ: <b>{summary['flagged_cases']}</b></div>
<div>Hộp từ khả dụng: <b>{summary['proposed_word_boxes']}</b></div>
</div>
<p><b>Chú thích:</b> Khung xanh dương = từ OCR dự đoán; rê chuột lên khung để xem
từ tương ứng. Khung xanh không phải nhãn đã được con người phê duyệt.</p>
{''.join(cards)}
</main></body></html>"""


def run_review(
    cases: list[Case], destination: Path,
    expected_profile: str, expected_sha: str,
) -> dict[str, object]:
    """Perform the real OCR once per case and write only private local files."""
    # Match the validated Windows GPU/Paddle loading order.
    import torch  # noqa: F401
    from app.services.ocr_engine import extract_text_and_boxes

    previews = destination / "previews"
    previews.mkdir(mode=0o700)
    cards: list[str] = []
    totals: Counter[str] = Counter()
    failures: Counter[str] = Counter()
    condition_counts: Counter[str] = Counter()
    with (destination / "machine-proposals.jsonl").open("x", encoding="utf-8") as proposals:
        for index, case in enumerate(cases, 1):
            try:
                out = extract_text_and_boxes(case.image.read_bytes())
                inspected = inspect_case(case, out, expected_profile, expected_sha)
                filename = f"page_{index:04}.png"
                width, height = _private_thumbnail(case.image, previews / filename)
                cards.append(
                    _html_card(index, case, inspected, f"previews/{filename}", width, height)
                )
                key = case.image.resolve().relative_to(destination.parent).as_posix()
                proposals.write(json.dumps({
                    "image": key,
                    "annotation_source": "machine_proposed",
                    "reviewer_confirmed": False,
                    "coordinate_space": "normalized_original_dimensions",
                    "words": inspected["machine_words"],
                }, ensure_ascii=False) + "\n")
                totals["successful_cases"] += 1
                totals["char_edits"] += inspected["char_edits"]
                totals["reference_chars"] += inspected["reference_chars"]
                totals["word_edits"] += inspected["word_edits"]
                totals["reference_words"] += inspected["reference_words"]
                totals["proposed_word_boxes"] += len(inspected["machine_words"])
                totals["invalid_word_boxes"] += inspected["invalid_word_boxes"]
                totals["overlap_pairs"] += inspected["overlap_pairs"]
                totals["flagged_cases"] += bool(inspected["flags"])
                condition_counts[case.condition] += 1
            except Exception as exc:
                # Do NOT log exception messages: some contain private words/paths.
                failures[type(exc).__name__] += 1
    summary = {
        "dataset_case_count": len(cases),
        "successful_cases": totals["successful_cases"],
        "failed_cases": len(cases) - totals["successful_cases"],
        "failure_exception_types": dict(sorted(failures.items())),
        "micro_cer": round(totals["char_edits"] / totals["reference_chars"], 6)
        if totals["reference_chars"] else None,
        "micro_wer": round(totals["word_edits"] / totals["reference_words"], 6)
        if totals["reference_words"] else None,
        "flagged_cases": totals["flagged_cases"],
        "proposed_word_boxes": totals["proposed_word_boxes"],
        "invalid_word_boxes": totals["invalid_word_boxes"],
        "overlap_pairs": totals["overlap_pairs"],
        "condition_success_counts": dict(sorted(condition_counts.items())),
    }
    report = {
        "aggregate": summary,
        "model_profile": expected_profile,
        "checkpoint_sha256": expected_sha,
        "annotation_source": "machine_proposed",
        "human_annotated": False,
        "independent_ground_truth_verified": False,
        "real_photo_iou_acceptance": False,
        "reading_feedback_colors_tested": False,
        "note": "Local visual review of actual OCR outputs, NOT independent box ground truth.",
        "all_runtime_checks_passed": totals["successful_cases"] == len(cases),
    }
    (destination / "aggregate.json").write_text(
        json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )
    (destination / "index.html").write_text(
        _render_html(cards, report), encoding="utf-8"
    )
    return report


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("dataset", type=Path)
    parser.add_argument("--env-file", type=Path, required=True)
    parser.add_argument("--expected-profile", required=True)
    parser.add_argument("--expected-sha", required=True)
    parser.add_argument("--output-dir", type=Path, required=True)
    parser.add_argument("--min-pages", type=int, default=10)
    args = parser.parse_args(argv)

    dataset = args.dataset.expanduser().resolve()
    root = dataset.parent
    destination = args.output_dir.expanduser().resolve()
    if root.is_relative_to(BACKEND_ROOT.parent.resolve()):
        parser.error("Private dataset must be outside Git repository")
    if destination.parent != root or destination.exists():
        parser.error("Choose a NEW review subdirectory directly in private dataset root")
    if not re.fullmatch(r"[a-f0-9]{64}", args.expected_sha):
        parser.error("Expected SHA must be a lowercase 64-character digest")
    if not 1 <= args.min_pages <= MAX_CASES:
        parser.error("Invalid --min-pages")
    if not args.env_file.expanduser().is_file():
        parser.error("Missing backend private .env")
    try:
        cases = load_cases(dataset)
        if len(cases) < args.min_pages:
            raise ValueError("Insufficient unique images")
    except (OSError, ValueError) as exc:
        print(f"Private dataset rejected: {type(exc).__name__}", file=sys.stderr)
        return 2

    from dotenv import dotenv_values
    for key, value in dotenv_values(args.env_file.expanduser()).items():
        if value is not None and not (os.getenv(key) or "").strip():
            os.environ[key] = value

    try:
        destination.mkdir(mode=0o700)
        report = run_review(cases, destination, args.expected_profile, args.expected_sha)
    except Exception as exc:
        print(f"Local auto-review failed: {type(exc).__name__}", file=sys.stderr)
        return 2
    print(json.dumps(report, ensure_ascii=False, indent=2))
    return 0 if report["all_runtime_checks_passed"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
