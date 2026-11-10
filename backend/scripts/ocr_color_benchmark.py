"""Real-OCR benchmark on images with independently authored ground truth.

The script renders Vietnamese book-style pages from authored sentences (the
ground truth is the text that was drawn, never OCR output), degrades them
under 15 image-quality conditions, runs the production OCR pipeline and
reports recognition metrics plus the GREEN/RED/YELLOW confusion matrix.

Usage (from ``backend/``):
    python scripts/ocr_color_benchmark.py --write-fixtures --report ../docs/ocr-color-benchmark.md

Synthetic pages are a controlled proxy, not a substitute for scanned books:
the report states the sample size and confidence intervals, and makes no
claim beyond the measured data.
"""
from __future__ import annotations

import argparse
import copy
import json
import math
import os
import sys
import time
import unicodedata
from pathlib import Path

BACKEND_ROOT = Path(__file__).resolve().parents[1]
if str(BACKEND_ROOT) not in sys.path:
    sys.path.insert(0, str(BACKEND_ROOT))

os.environ.setdefault("DATABASE_URL", "postgresql+asyncpg://test:test@127.0.0.1:1/test")
os.environ.setdefault("SUPABASE_URL", "https://example.supabase.co")
os.environ.setdefault("SUPABASE_KEY", "isolated-test-key")

import cv2
import numpy as np
from PIL import Image, ImageDraw, ImageFont

FIXTURE_ROOT = BACKEND_ROOT / "tests" / "fixtures" / "ocr"

# Authored ground truth. Do not replace with OCR output.
SENTENCES = [
    "BỮA SÁNG CỦA AN",
    "Hôm nay trời nắng đẹp.",
    "Mẹ chuẩn bị bánh mì và sữa.",
    "An ngồi vào bàn ăn.",
    "Ông bà đang ngồi ở phòng khách.",
    "An chào ông bà rồi xuống nhà.",
    "Bữa sáng thật là ngon.",
    "An nói lời cảm ơn mẹ.",
    "Chú mèo nhỏ nằm ngủ dưới gốc cây.",
    "Những bông hoa nở rực rỡ trong vườn.",
    "Bé Lan thích đọc truyện cổ tích mỗi tối.",
    "Đàn chim hót líu lo trên cành.",
    "Buổi chiều, hai chị em thả diều ngoài đồng.",
    "Dòng sông quê em nước chảy hiền hòa.",
    "Thầy giáo dạy chúng em viết chữ đẹp.",
    "Trăng rằm sáng tỏ giữa trời đêm.",
    "Bà kể chuyện ngày xưa cho cháu nghe.",
    "Cả nhà quây quần bên mâm cơm ấm cúng.",
]
LINES_PER_PAGE = 3
PAGES_PER_CONDITION = 3

CONDITIONS = [
    "clean", "blur", "low_light", "over_exposed", "uneven_light", "shadow",
    "mixed_background", "bold", "italic", "small_text", "near_edge",
    "compressed", "noise", "rotated", "curved",
]

_FONT_CANDIDATES = {
    "regular": ["arial.ttf", "DejaVuSans.ttf", "LiberationSans-Regular.ttf"],
    "bold": ["arialbd.ttf", "DejaVuSans-Bold.ttf", "LiberationSans-Bold.ttf"],
    "italic": ["ariali.ttf", "DejaVuSans-Oblique.ttf", "LiberationSans-Italic.ttf"],
}
_FONT_DIRS = [
    Path(os.environ.get("WINDIR", r"C:\Windows")) / "Fonts",
    Path("/usr/share/fonts/truetype/dejavu"),
    Path("/usr/share/fonts/truetype/liberation"),
    Path("/Library/Fonts"),
]


def find_font(style: str) -> Path | None:
    for directory in _FONT_DIRS:
        for name in _FONT_CANDIDATES[style]:
            candidate = directory / name
            if candidate.is_file():
                return candidate
    return None


def page_lines(condition_index: int, page: int) -> list[str]:
    start = ((condition_index * PAGES_PER_CONDITION + page) * LINES_PER_PAGE) % len(SENTENCES)
    return [SENTENCES[(start + offset) % len(SENTENCES)] for offset in range(LINES_PER_PAGE)]


def render_page(
    lines: list[str],
    *,
    style: str = "regular",
    font_size: int = 34,
    margin: int = 44,
    foreground=(25, 25, 25),
    background=(255, 255, 255),
) -> tuple[np.ndarray, list[dict[str, object]]]:
    """Draw the lines; return a BGR image and the true pixel box of each word."""
    font_path = find_font(style)
    if font_path is None:
        raise RuntimeError(f"No Vietnamese-capable font found for style {style!r}")
    font = ImageFont.truetype(str(font_path), font_size)
    line_height = int(font_size * 2.1)
    probe = ImageDraw.Draw(Image.new("RGB", (8, 8)))
    width = max(int(probe.textlength(line, font=font)) for line in lines) + 2 * margin
    height = line_height * len(lines) + 2 * margin
    image = Image.new("RGB", (width, height), background)
    draw = ImageDraw.Draw(image)
    space = probe.textlength(" ", font=font)
    boxes: list[dict[str, object]] = []
    for line_index, line in enumerate(lines):
        x = float(margin)
        y = margin + line_index * line_height
        for token in line.split():
            draw.text((x, y), token, font=font, fill=foreground)
            left, top, right, bottom = draw.textbbox((x, y), token, font=font)
            boxes.append({"text": token, "line_index": line_index,
                          "box": [left, top, right, bottom]})
            x += probe.textlength(token, font=font) + space
    return cv2.cvtColor(np.asarray(image), cv2.COLOR_RGB2BGR), boxes


def apply_condition(condition: str, lines: list[str], seed: int):
    """Return (image, true boxes or None when geometry was warped)."""
    rng = np.random.default_rng(seed)
    if condition == "bold":
        return render_page(lines, style="bold")
    if condition == "italic":
        return render_page(lines, style="italic")
    if condition == "small_text":
        return render_page(lines, font_size=17, margin=30)
    if condition == "near_edge":
        return render_page(lines, margin=5)
    if condition == "mixed_background":
        return render_page(lines, foreground=(20, 30, 110), background=(244, 226, 172))

    image, boxes = render_page(lines)
    height, width = image.shape[:2]
    if condition == "clean":
        return image, boxes
    if condition == "blur":
        return cv2.GaussianBlur(image, (7, 7), 1.7), boxes
    if condition == "low_light":
        return np.clip(image.astype(np.float32) * 0.34, 0, 255).astype(np.uint8), boxes
    if condition == "over_exposed":
        return np.clip(image.astype(np.float32) * 0.42 + 150, 0, 255).astype(np.uint8), boxes
    if condition == "uneven_light":
        gradient = np.linspace(0.42, 1.0, width, dtype=np.float32)[None, :, None]
        return np.clip(image.astype(np.float32) * gradient, 0, 255).astype(np.uint8), boxes
    if condition == "shadow":
        mask = np.ones((height, width), dtype=np.float32)
        ys, xs = np.mgrid[0:height, 0:width]
        band = np.abs(xs - (width * 0.25 + ys * 1.3)) < width * 0.16
        mask[band] = 0.5
        mask = cv2.GaussianBlur(mask, (31, 31), 9)
        return np.clip(image.astype(np.float32) * mask[..., None], 0, 255).astype(np.uint8), boxes
    if condition == "compressed":
        ok, encoded = cv2.imencode(".jpg", image, [cv2.IMWRITE_JPEG_QUALITY, 16])
        assert ok
        return cv2.imdecode(encoded, cv2.IMREAD_COLOR), boxes
    if condition == "noise":
        noisy = image.astype(np.float32) + rng.normal(0, 24, image.shape)
        speckle = rng.random(image.shape[:2])
        noisy[speckle < 0.004] = 0
        noisy[speckle > 0.996] = 255
        return np.clip(noisy, 0, 255).astype(np.uint8), boxes
    if condition == "rotated":
        matrix = cv2.getRotationMatrix2D((width / 2, height / 2), 2.5, 1.0)
        rotated = cv2.warpAffine(image, matrix, (width, height),
                                 borderMode=cv2.BORDER_CONSTANT, borderValue=(255, 255, 255))
        return rotated, None
    if condition == "curved":
        ys, xs = np.mgrid[0:height, 0:width].astype(np.float32)
        shifted = ys + 6.0 * np.sin(xs / width * 2 * math.pi)
        curved = cv2.remap(image, xs, shifted, cv2.INTER_LINEAR,
                           borderMode=cv2.BORDER_CONSTANT, borderValue=(255, 255, 255))
        return curved, None
    raise ValueError(condition)


def build_fixtures() -> list[dict[str, object]]:
    fixtures = []
    for condition_index, condition in enumerate(CONDITIONS):
        for page in range(PAGES_PER_CONDITION):
            lines = page_lines(condition_index, page)
            seed = 1000 + condition_index * 10 + page
            image, boxes = apply_condition(condition, lines, seed)
            ok, encoded = cv2.imencode(".png", image)
            assert ok
            fixture_id = f"vi_{condition}_{page + 1:02d}"
            fixtures.append({
                "fixture_id": fixture_id,
                "condition": condition,
                "image": f"{fixture_id}.png",
                "expected_text": "\n".join(lines),
                "expected_words": [token for line in lines for token in line.split()],
                "verified": True,
                "ground_truth_source": "authored_text_rendered_by_benchmark_script",
                "word_boxes_px": boxes,
                "width": int(image.shape[1]),
                "height": int(image.shape[0]),
                "_png": encoded.tobytes(),
            })
    return fixtures


def write_fixtures(fixtures: list[dict[str, object]]) -> None:
    for fixture in fixtures:
        directory = FIXTURE_ROOT / str(fixture["condition"])
        directory.mkdir(parents=True, exist_ok=True)
        (directory / str(fixture["image"])).write_bytes(fixture["_png"])
        metadata = {key: value for key, value in fixture.items() if not key.startswith("_")}
        (directory / f"{fixture['fixture_id']}.json").write_text(
            json.dumps(metadata, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def load_fixtures() -> list[dict[str, object]]:
    fixtures = []
    for path in sorted(FIXTURE_ROOT.glob("*/*.json")):
        fixture = json.loads(path.read_text(encoding="utf-8"))
        fixture["_png"] = (path.parent / fixture["image"]).read_bytes()
        fixtures.append(fixture)
    return fixtures


# --- Evaluation -----------------------------------------------------------
def wilson(successes: int, total: int) -> tuple[float, float] | None:
    """95% Wilson score interval."""
    if total == 0:
        return None
    z = 1.959964
    p = successes / total
    denominator = 1 + z * z / total
    centre = (p + z * z / (2 * total)) / denominator
    half = z * math.sqrt(p * (1 - p) / total + z * z / (4 * total * total)) / denominator
    return max(0.0, centre - half), min(1.0, centre + half)


def _has_marks(token: str) -> bool:
    decomposed = unicodedata.normalize("NFD", token)
    return any(unicodedata.category(ch) == "Mn" for ch in decomposed) or "đ" in token.lower()


def _iou(a: list[float], b: list[float]) -> float:
    x0, y0, x1, y1 = max(a[0], b[0]), max(a[1], b[1]), min(a[2], b[2]), min(a[3], b[3])
    inter = max(0.0, x1 - x0) * max(0.0, y1 - y0)
    union = (a[2] - a[0]) * (a[3] - a[1]) + (b[2] - b[0]) * (b[3] - b[1]) - inter
    return inter / union if union > 0 else 0.0


def evaluate_fixture(fixture: dict[str, object]) -> dict[str, object]:
    """Run the production pipeline on one fixture and score every word."""
    import jiwer

    from app.services.admin_ocr_service import AdminOcrService, classify_word_evidence
    from app.services.ocr_engine import align_ocr_tokens, extract_text_and_boxes, normalize_word

    started = time.perf_counter()
    result = extract_text_and_boxes(fixture["_png"])
    latency = time.perf_counter() - started
    words = AdminOcrService._word_data(copy.deepcopy(result["words"]))
    truth_tokens = [unicodedata.normalize("NFC", token) for token in fixture["expected_words"]]
    truth_keys = [normalize_word(token) for token in truth_tokens]
    ocr_keys = [str(word["normalized_text"]) for word in words]

    alignment = AdminOcrService._collapse_isolated_replacements(
        align_ocr_tokens(truth_tokens, [str(word["text"]) for word in words]))
    truth_for_word: dict[int, int | None] = {}
    for step in alignment:
        if step["secondary_index"] is not None:
            truth_for_word[int(step["secondary_index"])] = (
                int(step["primary_index"]) if step["primary_index"] is not None else None)

    # Colors without any reference: what an Admin sees right after upload.
    no_reference = [
        classify_word_evidence(str(word["ocr_review_status"]), word["ocr_evidence"], str(word["text"]))
        for word in words
    ]
    # The same words as the pipeline would have left them before adjudication.
    baseline_keys, baseline_colors = [], []
    for word in words:
        evidence = copy.deepcopy(word["ocr_evidence"]) or {}
        crop = evidence.get("crop_evidence") or {}
        before = crop.get("text_before_adjudication")
        text = before if isinstance(before, str) else str(word["text"])
        # Previous behaviour: only PaddleOCR + VietOCR line agreement counted.
        if evidence.get("alignment") != "match":
            evidence["crop_evidence"] = {"status": "skipped"}
        if isinstance(evidence.get("engine_outputs"), dict):
            evidence["engine_outputs"]["tesseract"] = None
        if isinstance(evidence.get("engine_statuses"), dict):
            evidence["engine_statuses"]["tesseract"] = "not_run"
        evidence["source_text"] = text
        baseline_keys.append(normalize_word(text))
        baseline_colors.append(
            classify_word_evidence(str(word["ocr_review_status"]), evidence, text))

    # Colors once the authored ground truth is the verified reference.
    referenced = copy.deepcopy(words)
    AdminOcrService._apply_verified_reference(referenced, " ".join(truth_tokens))
    with_reference = [
        classify_word_evidence(
            str(word["ocr_review_status"]),
            AdminOcrService._normalize_word_evidence(word["ocr_evidence"]),
            str(word["text"]),
        )
        for word in referenced
    ]

    rows = []
    true_boxes = fixture.get("word_boxes_px")
    for index, word in enumerate(words):
        truth_index = truth_for_word.get(index)
        is_correct = truth_index is not None and ocr_keys[index] == truth_keys[truth_index]
        baseline_correct = truth_index is not None and baseline_keys[index] == truth_keys[truth_index]
        iou = None
        if is_correct and isinstance(true_boxes, list):
            x, y, w, h = (float(value) for value in word["bbox"])
            predicted = [x * fixture["width"], y * fixture["height"],
                         (x + w) * fixture["width"], (y + h) * fixture["height"]]
            iou = _iou(predicted, [float(v) for v in true_boxes[truth_index]["box"]])
        evidence = word["ocr_evidence"] or {}
        rows.append({
            "text": word["text"],
            "truth": truth_tokens[truth_index] if truth_index is not None else None,
            "truth_state": "correct" if is_correct else "incorrect" if truth_index is not None else "ambiguous",
            "baseline_correct": baseline_correct,
            "no_reference_color": no_reference[index],
            "baseline_color": baseline_colors[index],
            "with_reference_color": with_reference[index],
            "reference_alignment": (referenced[index]["ocr_evidence"] or {}).get("reference_alignment"),
            "engine_alignment": evidence.get("alignment"),
            "crop_quality": evidence.get("crop_quality"),
            "bbox_quality": evidence.get("bbox_quality"),
            "adjudication": (evidence.get("crop_evidence") or {}).get("adjudication_status"),
            "has_marks": _has_marks(truth_tokens[truth_index]) if truth_index is not None else None,
            "iou": iou,
        })

    truth_text = " ".join(truth_keys)
    return {
        "fixture_id": fixture["fixture_id"],
        "condition": fixture["condition"],
        "engine": result["metadata"].get("engine"),
        "latency_s": latency,
        "truth_words": len(truth_tokens),
        "cer": float(jiwer.cer(truth_text, " ".join(ocr_keys))) if ocr_keys else 1.0,
        "wer": float(jiwer.wer(truth_text, " ".join(ocr_keys))) if ocr_keys else 1.0,
        "baseline_cer": float(jiwer.cer(truth_text, " ".join(baseline_keys))) if baseline_keys else 1.0,
        "missed_truth_words": sum(1 for step in alignment if step["operation"] == "delete"),
        "adjudication_stats": result["metadata"].get("adjudication_stats"),
        "words": rows,
    }


def summarize(results: list[dict[str, object]]) -> dict[str, object]:
    rows = [row for result in results for row in result["words"]]
    truth_total = sum(int(result["truth_words"]) for result in results)

    def matrix(color_key: str):
        table = {state: {"green": 0, "red": 0, "yellow": 0}
                 for state in ("correct", "incorrect", "ambiguous")}
        for row in rows:
            table[row["truth_state"]][row[color_key]] += 1
        return table

    def rates(table):
        # Precision is computed over words that have an unambiguous ground
        # truth pairing. Words the page layout left unpaired are reported
        # separately instead of being guessed correct or incorrect.
        green_total = table["correct"]["green"] + table["incorrect"]["green"]
        red_total = table["correct"]["red"] + table["incorrect"]["red"]
        correct_total = sum(table["correct"].values())
        incorrect_total = sum(table["incorrect"].values())
        return {
            "unpaired_green": (table["ambiguous"]["green"], sum(table["ambiguous"].values())),
            "unpaired_red": (table["ambiguous"]["red"], sum(table["ambiguous"].values())),
            "green_precision": (table["correct"]["green"], green_total),
            "green_recall": (table["correct"]["green"], correct_total),
            "red_precision": (table["incorrect"]["red"], red_total),
            "red_recall": (table["incorrect"]["red"], incorrect_total),
            "false_green": (green_total - table["correct"]["green"], green_total),
            "false_red": (red_total - table["incorrect"]["red"], red_total),
            "false_yellow": (table["correct"]["yellow"], correct_total),
        }

    correct = sum(1 for row in rows if row["truth_state"] == "correct")
    baseline_correct = sum(1 for row in rows if row["baseline_correct"])
    marked = [row for row in rows if row["has_marks"]]
    ious = [row["iou"] for row in rows if row["iou"] is not None]
    crops = [row for row in rows if row["bbox_quality"] is not None]
    summary = {
        "fixtures": len(results),
        "truth_words": truth_total,
        "ocr_words": len(rows),
        "exact_word_accuracy": (correct, truth_total),
        "baseline_exact_word_accuracy": (baseline_correct, truth_total),
        "diacritic_word_accuracy": (
            sum(1 for row in marked if row["truth_state"] == "correct"),
            sum(1 for result in results for token in result["truth_tokens_marked"]),
        ),
        "mean_cer": float(np.mean([result["cer"] for result in results])),
        "mean_baseline_cer": float(np.mean([result["baseline_cer"] for result in results])),
        "mean_wer": float(np.mean([result["wer"] for result in results])),
        "mean_iou": float(np.mean(ious)) if ious else None,
        "iou_samples": len(ious),
        "crop_success": (sum(1 for row in crops if row["crop_quality"] == "usable"), len(crops)),
        "mean_latency_s": float(np.mean([result["latency_s"] for result in results])),
        "max_latency_s": float(np.max([result["latency_s"] for result in results])),
        "adjudicated_words": sum(1 for row in rows if row["adjudication"] == "resolved"),
        "matrix_no_reference": matrix("no_reference_color"),
        "matrix_baseline": matrix("baseline_color"),
        "matrix_with_reference": matrix("with_reference_color"),
    }
    for key in ("no_reference", "baseline", "with_reference"):
        summary[f"rates_{key}"] = rates(summary[f"matrix_{key}"])
    return summary


def run(fixtures: list[dict[str, object]]) -> tuple[list[dict[str, object]], dict[str, object]]:
    from app.services.ocr_engine import normalize_word

    results = []
    for fixture in fixtures:
        result = evaluate_fixture(fixture)
        result["truth_tokens_marked"] = [
            token for token in fixture["expected_words"]
            if _has_marks(token) and normalize_word(token)
        ]
        results.append(result)
        print(f"{result['fixture_id']:<28} engine={result['engine']} "
              f"cer={result['cer']:.3f} latency={result['latency_s']:.1f}s", flush=True)
    return results, summarize(results)


def _fraction(pair) -> str:
    successes, total = pair
    if total == 0:
        return "n/a (0 samples)"
    low, high = wilson(successes, total)
    return f"{successes}/{total} = {successes / total:.1%} (95% CI {low:.1%}–{high:.1%})"


def _matrix_table(table) -> str:
    lines = ["| Ground truth | Predicted GREEN | Predicted RED | Predicted YELLOW |",
             "|---|---:|---:|---:|"]
    for state in ("correct", "incorrect", "ambiguous"):
        row = table[state]
        lines.append(f"| {state.capitalize()} | {row['green']} | {row['red']} | {row['yellow']} |")
    return "\n".join(lines)


def render_report(results, summary, versions: dict[str, str]) -> str:
    by_condition: dict[str, list[dict[str, object]]] = {}
    for result in results:
        by_condition.setdefault(str(result["condition"]), []).append(result)
    condition_rows = []
    for condition, items in by_condition.items():
        rows = [row for item in items for row in item["words"]]
        truth = sum(int(item["truth_words"]) for item in items)
        correct = sum(1 for row in rows if row["truth_state"] == "correct")
        green = sum(1 for row in rows if row["no_reference_color"] == "green")
        false_green = sum(1 for row in rows
                          if row["no_reference_color"] == "green" and row["truth_state"] != "correct")
        yellow_correct = sum(1 for row in rows
                             if row["no_reference_color"] == "yellow" and row["truth_state"] == "correct")
        condition_rows.append(
            f"| {condition} | {len(items)} | {truth} | {correct / truth:.1%} | "
            f"{np.mean([item['cer'] for item in items]):.3f} | {green} | {false_green} | {yellow_correct} |")

    nr, base, wr = (summary["rates_no_reference"], summary["rates_baseline"],
                    summary["rates_with_reference"])
    return f"""# OCR color benchmark (measured)

Generated by `backend/scripts/ocr_color_benchmark.py`. Every number below was
measured on this run; none is a target or an estimate.

- Fixtures: {summary['fixtures']} synthetic pages in `backend/tests/fixtures/ocr/`,
  {len(by_condition)} image-quality conditions × {PAGES_PER_CONDITION} pages, {summary['truth_words']} ground-truth words.
- Ground truth: the authored text that was rendered into each image. It is
  never derived from OCR output.
- Engines: {", ".join(f"{name} {version}" for name, version in versions.items())}.
- **Limit of this evidence:** these are computer-rendered pages with one font
  family. They are a controlled proxy and do not prove accuracy on scanned or
  photographed books. Gate B is not claimed for real book images.

## Recognition

| Metric | Value |
|---|---|
| Exact word accuracy (final text) | {_fraction(summary['exact_word_accuracy'])} |
| Exact word accuracy (before crop adjudication) | {_fraction(summary['baseline_exact_word_accuracy'])} |
| Vietnamese diacritic word accuracy | {_fraction(summary['diacritic_word_accuracy'])} |
| Mean CER (final / before adjudication) | {summary['mean_cer']:.4f} / {summary['mean_baseline_cer']:.4f} |
| Mean WER | {summary['mean_wer']:.4f} |
| Bounding-box IoU (correct words, unwarped pages) | {summary['mean_iou'] if summary['mean_iou'] is None else round(summary['mean_iou'], 3)} over {summary['iou_samples']} words |
| Crop success rate (usable padded crop) | {_fraction(summary['crop_success'])} |
| Inference latency per page (CPU) | mean {summary['mean_latency_s']:.2f}s, max {summary['max_latency_s']:.2f}s |
| Words resolved by crop adjudication | {summary['adjudicated_words']} |

## Colors without a reference (right after OCR)

RED is impossible here by design: without a verified reference nothing can be
confirmed wrong.

{_matrix_table(summary['matrix_no_reference'])}

| Metric | After this change | Before (engine agreement only) |
|---|---|---|
| GREEN precision | {_fraction(nr['green_precision'])} | {_fraction(base['green_precision'])} |
| GREEN recall on correct words | {_fraction(nr['green_recall'])} | {_fraction(base['green_recall'])} |
| False GREEN | {_fraction(nr['false_green'])} | {_fraction(base['false_green'])} |
| False YELLOW (correct word shown yellow) / unnecessary review | {_fraction(nr['false_yellow'])} | {_fraction(base['false_yellow'])} |
| GREEN among OCR words with no unambiguous ground-truth pairing | {nr['unpaired_green'][0]} of {nr['unpaired_green'][1]} | {base['unpaired_green'][0]} of {base['unpaired_green'][1]} |

Precision and recall are computed over words that pair one-to-one with the
ground truth. "Before" replays the previous rule on the same OCR output:
GREEN only when PaddleOCR and VietOCR returned the same token.

## Colors with the ground truth as verified reference

{_matrix_table(summary['matrix_with_reference'])}

| Metric | Value |
|---|---|
| Correct word → GREEN | {_fraction(wr['green_recall'])} |
| Incorrect word → RED | {_fraction(wr['red_recall'])} |
| GREEN precision | {_fraction(wr['green_precision'])} |
| RED precision | {_fraction(wr['red_precision'])} |
| False GREEN | {_fraction(wr['false_green'])} |
| False RED | {_fraction(wr['false_red'])} |

"Incorrect word → RED" below 100% means the wrong OCR token sat next to a
missing/extra token, so its mapping to the reference is ambiguous and it is
YELLOW by rule, not GREEN.

## By image condition (no reference)

| Condition | Pages | Truth words | Exact word accuracy | Mean CER | GREEN | False GREEN | Correct but YELLOW |
|---|---:|---:|---:|---:|---:|---:|---:|
{chr(10).join(condition_rows)}
"""


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--write-fixtures", action="store_true",
                        help="(re)generate the fixture images and JSON files")
    parser.add_argument("--report", type=Path, help="write the Markdown report here")
    parser.add_argument("--json", type=Path, help="write raw per-word results here")
    args = parser.parse_args()

    if args.write_fixtures:
        write_fixtures(build_fixtures())
    fixtures = load_fixtures()
    if not fixtures:
        raise SystemExit("No fixtures found; run with --write-fixtures first.")

    from app.services import ocr_engine

    results, summary = run(fixtures)
    versions = {
        "paddleocr": ocr_engine._package_version("paddleocr") or "missing",
        "vietocr": ocr_engine._package_version("vietocr") or "missing",
        "pytesseract": ocr_engine._package_version("pytesseract") or "missing",
    }
    report = render_report(results, summary, versions)
    if args.report:
        args.report.write_text(report, encoding="utf-8")
    if args.json:
        args.json.write_text(json.dumps(
            {"summary": summary, "results": results}, ensure_ascii=False, indent=2), encoding="utf-8")
    print(report)


if __name__ == "__main__":
    main()
