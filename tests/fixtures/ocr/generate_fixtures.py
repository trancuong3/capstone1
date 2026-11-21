"""Deterministic generator for ViRead synthetic Vietnamese OCR acceptance fixtures.

All ground-truth texts are authored independently BEFORE running any OCR engine.
Do NOT edit ground_truth to match OCR outputs.
License: CC0-1.0 (project-owned synthetic text fixtures rendered locally).
"""
from __future__ import annotations

import hashlib
import json
import math
import random
import unicodedata
from pathlib import Path
from typing import Any

from PIL import Image, ImageDraw, ImageFilter, ImageFont

FIXTURE_ROOT = Path(__file__).resolve().parent
IMAGES_DIR = FIXTURE_ROOT / "images"
MANIFEST_PATH = FIXTURE_ROOT / "manifest.json"

FONT_CANDIDATES = {
    "serif": [r"C:\Windows\Fonts\times.ttf", "/usr/share/fonts/truetype/dejavu/DejaVuSerif.ttf"],
    "sans": [r"C:\Windows\Fonts\arial.ttf", "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf"],
    "book": [r"C:\Windows\Fonts\calibri.ttf", r"C:\Windows\Fonts\tahoma.ttf", "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf"],
}


def _load_font(family: str, size: int) -> ImageFont.FreeTypeFont:
    for path in FONT_CANDIDATES[family]:
        if Path(path).is_file():
            return ImageFont.truetype(path, size=size)
    raise RuntimeError(f"No Unicode Vietnamese font available for family={family}")


def _nfc(text: str) -> str:
    return unicodedata.normalize("NFC", text)


# Ground truth authored independently BEFORE any OCR run.
FIXTURE_SPECS: list[dict[str, Any]] = [
    # ---------------- DEV SPLIT (used to measure baseline & lock thresholds) ----------------
    {
        "id": "dev_clean_01",
        "split": "dev",
        "group": "clean",
        "expected_outcome": "readable",
        "font": "serif",
        "font_size": 42,
        "lines": [
            "Buổi sáng mùa thu trời trong xanh.",
            "Bé An mở sách đọc từng câu rõ ràng.",
            "Con mèo nhỏ nằm ngoan bên cửa sổ.",
        ],
    },
    {
        "id": "dev_tilted_01",
        "split": "dev",
        "group": "tilted",
        "expected_outcome": "readable",
        "font": "sans",
        "font_size": 42,
        "angle_deg": 2.8,
        "lines": [
            "Chiều nay cả nhà cùng đi dạo công viên.",
            "Hàng cây xanh tỏa bóng mát dọc lối đi.",
            "Tiếng chim hót vang trên cành lá non.",
        ],
    },
    {
        "id": "dev_low_light_01",
        "split": "dev",
        "group": "low_light",
        "expected_outcome": "readable",
        "font": "serif",
        "font_size": 42,
        "lines": [
            "Ánh đèn bàn dịu nhẹ chiếu lên trang giấy.",
            "Bà kể chuyện cổ tích cho hai anh em nghe.",
            "Ngoài sân gió thổi qua giàn hoa giấy.",
        ],
    },
    {
        "id": "dev_diacritics_01",
        "split": "dev",
        "group": "diacritics",
        "expected_outcome": "readable",
        "font": "serif",
        "font_size": 44,
        "lines": [
            "Đàn ngỗng trắng bơi giữa hồ nước phẳng lặng.",
            "Những chiếc thuyền gỗ lướt nhẹ qua bãi sậy.",
            "Mùa gặt về thơm mùi lúa mới chín vàng.",
        ],
    },
    {
        "id": "dev_edge_crop_01",
        "split": "dev",
        "group": "edge_crop",
        "expected_outcome": "readable",
        "font": "sans",
        "font_size": 40,
        "margin_x": 14,
        "margin_y": 14,
        "lines": [
            "Mỗi ngày bé dành mười phút luyện đọc.",
            "Đọc chậm từng tiếng sẽ ít nhầm dấu hơn.",
            "Ba mẹ luôn lắng nghe và động viên con.",
        ],
    },
    {
        "id": "dev_blurry_01",
        "split": "dev",
        "group": "blurry",
        "expected_outcome": "readable",
        "font": "sans",
        "font_size": 44,
        "blur_radius": 1.1,
        "lines": [
            "Cơn mưa rào đầu hạ đến rất nhanh.",
            "Giọt nước long lanh đọng trên tán lá.",
            "Cầu vồng hiện ra sau rặng tre xanh.",
        ],
    },
    {
        "id": "dev_blank_01",
        "split": "dev",
        "group": "blank",
        "expected_outcome": "no_text",
        "font": "serif",
        "font_size": 42,
        "lines": [],
    },
    # ---------------- HOLDOUT SPLIT (never inspected during tuning; final locked gate) ----------------
    {
        "id": "holdout_clean_01",
        "split": "holdout",
        "group": "clean",
        "expected_outcome": "readable",
        "font": "serif",
        "font_size": 42,
        "lines": [
            "Mùa xuân đến mang theo hương hoa bưởi.",
            "Bé Minh giúp mẹ tưới những chậu cây nhỏ.",
            "Đôi chim sâu nhảy nhót quanh hàng rào.",
        ],
    },
    {
        "id": "holdout_tilted_01",
        "split": "holdout",
        "group": "tilted",
        "expected_outcome": "readable",
        "font": "sans",
        "font_size": 42,
        "angle_deg": -2.6,
        "lines": [
            "Trên cánh đồng rộng có đàn cò trắng bay.",
            "Dòng sông uốn lượn quanh ngôi làng yên bình.",
            "Các bạn nhỏ thả diều khi gió chiều lên.",
        ],
    },
    {
        "id": "holdout_low_light_01",
        "split": "holdout",
        "group": "low_light",
        "expected_outcome": "readable",
        "font": "serif",
        "font_size": 42,
        "lines": [
            "Đêm trung thu trăng tròn và sáng vằng vặc.",
            "Trẻ em rước đèn ông sao khắp con ngõ nhỏ.",
            "Tiếng trống lân rộn rã vang cả khu phố.",
        ],
    },
    {
        "id": "holdout_diacritics_01",
        "split": "holdout",
        "group": "diacritics",
        "expected_outcome": "readable",
        "font": "serif",
        "font_size": 44,
        "lines": [
            "Đường lên đỉnh núi quanh co giữa mây mù.",
            "Suối chảy róc rách qua những tảng đá rêu phong.",
            "Tiếng sáo trúc ngân nga giữa rừng thông già.",
        ],
    },
    {
        "id": "holdout_edge_crop_01",
        "split": "holdout",
        "group": "edge_crop",
        "expected_outcome": "readable",
        "font": "sans",
        "font_size": 40,
        "margin_x": 14,
        "margin_y": 14,
        "lines": [
            "Quyển truyện tranh nằm ngay ngắn trên bàn học.",
            "Bé giữ gìn sách sạch đẹp và không gấp mép.",
            "Đọc xong bé cất sách đúng vị trí cũ.",
        ],
    },
    {
        "id": "holdout_blurry_01",
        "split": "holdout",
        "group": "blurry",
        "expected_outcome": "readable",
        "font": "sans",
        "font_size": 44,
        "blur_radius": 1.1,
        "lines": [
            "Chú cún con chạy lon ton đón bé tan trường.",
            "Cái đuôi nhỏ vẫy liên hồi trông thật vui mắt.",
            "Hai bạn cùng chạy về phía cổng nhà.",
        ],
    },
    {
        "id": "holdout_blank_01",
        "split": "holdout",
        "group": "blank",
        "expected_outcome": "no_text",
        "font": "serif",
        "font_size": 42,
        "lines": [],
    },
]


def _render_fixture(spec: dict[str, Any], seed: int) -> Image.Image:
    rng = random.Random(seed)
    group = spec["group"]
    width, height = (1160, 460) if group != "edge_crop" else (1060, 260)
    bg_color = (248, 246, 239) if group != "low_light" else (138, 134, 126)
    ink_color = (24, 24, 28) if group != "low_light" else (34, 34, 38)

    img = Image.new("RGB", (width, height), bg_color)
    draw = ImageDraw.Draw(img)

    if group == "blank":
        # Subtle paper texture only — zero text glyphs
        for _ in range(180):
            x = rng.randint(0, width - 1)
            y = rng.randint(0, height - 1)
            c = rng.randint(241, 250)
            draw.point((x, y), fill=(c, c - 1, c - 3))
        return img

    font = _load_font(spec["font"], int(spec["font_size"]))
    margin_x = int(spec.get("margin_x", 72))
    margin_y = int(spec.get("margin_y", 72))
    line_step = int(spec["font_size"]) + 38

    y = margin_y
    for line in spec["lines"]:
        draw.text((margin_x, y), _nfc(line), font=font, fill=ink_color)
        y += line_step

    if group == "low_light":
        # Subtle warm shadow gradient across the page
        px = img.load()
        for py in range(height):
            for px_i in range(width):
                r, g, b = px[px_i, py]
                factor = 0.80 + 0.20 * math.cos((px_i / width) * 1.1)
                px[px_i, py] = (
                    max(0, min(255, int(r * factor))),
                    max(0, min(255, int(g * factor * 0.98))),
                    max(0, min(255, int(b * factor * 0.94))),
                )

    if group == "tilted":
        angle = float(spec.get("angle_deg", 2.5))
        img = img.rotate(angle, resample=Image.Resampling.BICUBIC, expand=True, fillcolor=bg_color)

    if group == "blurry":
        radius = float(spec.get("blur_radius", 1.1))
        img = img.filter(ImageFilter.GaussianBlur(radius=radius))

    return img


def main() -> None:
    IMAGES_DIR.mkdir(parents=True, exist_ok=True)
    cases: list[dict[str, Any]] = []
    for idx, spec in enumerate(FIXTURE_SPECS, start=1):
        img = _render_fixture(spec, seed=20261121 + idx)
        filename = f"{spec['id']}.png"
        out_path = IMAGES_DIR / filename
        img.save(out_path, format="PNG")
        sha256 = hashlib.sha256(out_path.read_bytes()).hexdigest()
        gt = _nfc("\n".join(spec["lines"])) if spec["lines"] else ""
        cases.append(
            {
                "id": spec["id"],
                "split": spec["split"],
                "group": spec["group"],
                "image": f"images/{filename}",
                "image_sha256": sha256,
                "source": "Synthetic Vietnamese children's book fixture generated by tests/fixtures/ocr/generate_fixtures.py",
                "license": "CC0-1.0",
                "expected_outcome": spec["expected_outcome"],
                "ground_truth": gt,
            }
        )

    manifest = {
        "schema_version": 1,
        "normalization": "Unicode NFC + collapse whitespace; Vietnamese diacritics and case preserved (case-sensitive CER).",
        "ground_truth_provenance": "Authored independently before running any OCR engine; never adjusted to OCR output.",
        "thresholds": {
            "locked": False,
            "note": "Thresholds will be locked after measuring the dev split baseline, BEFORE running the holdout split.",
            "clean_max_cer": None,
            "photo_perturbed_max_cer": None,
            "overall_readable_max_cer": None,
            "warm_latency_max_ms": None,
        },
        "cases": cases,
    }
    MANIFEST_PATH.write_text(json.dumps(manifest, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    print(f"Generated {len(cases)} OCR fixtures and wrote {MANIFEST_PATH}")


if __name__ == "__main__":
    main()
