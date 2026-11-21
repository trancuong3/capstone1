#!/usr/bin/env python3
"""Generate official ViRead Android launcher icons (mdpi..xxxhdpi) deterministically.

Matches the ViRead visual identity in `frontend/components/common/viread-logo.tsx`
and `frontend/app/globals.css`:
- Deep navy/teal container (#153A53 -> #087467)
- Soft sky badge (#D9F4EB / #F6FAF8)
- Open-book emblem (#087467) within the 66/108 safe zone
"""
from __future__ import annotations

from pathlib import Path
from PIL import Image, ImageDraw

DENSITIES: dict[str, int] = {
    "mipmap-mdpi": 48,
    "mipmap-hdpi": 72,
    "mipmap-xhdpi": 96,
    "mipmap-xxhdpi": 144,
    "mipmap-xxxhdpi": 192,
}

NAVY = (21, 58, 83, 255)        # #153A53
PRIMARY = (8, 116, 103, 255)    # #087467
TEAL = (15, 118, 110, 255)      # #0F766E
SKY = (217, 244, 235, 255)      # #D9F4EB
CREAM = (246, 250, 248, 255)    # #F6FAF8
GOLD = (255, 219, 112, 255)     # #FFDB70


def _draw_open_book_icon(size: int, *, round_mask: bool) -> Image.Image:
    scale = 4
    canvas_px = size * scale
    img = Image.new("RGBA", (canvas_px, canvas_px), (0, 0, 0, 0))
    draw = ImageDraw.Draw(img)

    margin = int(round(canvas_px * 0.04))
    outer_box = [margin, margin, canvas_px - margin - 1, canvas_px - margin - 1]

    if round_mask:
        draw.ellipse(outer_box, fill=NAVY)
        inner_pad = int(round(canvas_px * 0.10))
        draw.ellipse(
            [inner_pad, inner_pad, canvas_px - inner_pad - 1, canvas_px - inner_pad - 1],
            fill=PRIMARY,
        )
    else:
        radius = int(round(canvas_px * 0.22))
        draw.rounded_rectangle(outer_box, radius=radius, fill=NAVY)
        inner_pad = int(round(canvas_px * 0.09))
        draw.rounded_rectangle(
            [inner_pad, inner_pad, canvas_px - inner_pad - 1, canvas_px - inner_pad - 1],
            radius=int(round(canvas_px * 0.18)),
            fill=PRIMARY,
        )

    # Inner soft sky card inside safe zone (24% .. 76%)
    badge_pad = int(round(canvas_px * 0.20))
    badge_radius = int(round(canvas_px * 0.14))
    draw.rounded_rectangle(
        [badge_pad, badge_pad, canvas_px - badge_pad - 1, canvas_px - badge_pad - 1],
        radius=badge_radius,
        fill=SKY,
    )

    # Open book pages (left & right wings + crisp spine matching Lucide BookOpen)
    cx = canvas_px // 2
    top_y = int(round(canvas_px * 0.33))
    bot_y = int(round(canvas_px * 0.68))
    left_x = int(round(canvas_px * 0.28))
    right_x = canvas_px - left_x
    dip = int(round(canvas_px * 0.05))
    stroke = max(3, int(round(canvas_px * 0.030)))

    left_page = [
        (left_x, top_y),
        (cx, top_y + dip),
        (cx, bot_y),
        (left_x, bot_y - dip),
    ]
    right_page = [
        (right_x, top_y),
        (cx, top_y + dip),
        (cx, bot_y),
        (right_x, bot_y - dip),
    ]
    draw.polygon(left_page, fill=CREAM, outline=PRIMARY, width=stroke)
    draw.polygon(right_page, fill=CREAM, outline=PRIMARY, width=stroke)

    # Subtle page text lines for instant book legibility
    line_w = max(2, stroke // 2)
    for frac in (0.45, 0.54):
        ly = int(round(canvas_px * frac))
        draw.line([(left_x + stroke * 2, ly), (cx - stroke * 2, ly + dip // 2)], fill=TEAL, width=line_w)
        draw.line([(cx + stroke * 2, ly + dip // 2), (right_x - stroke * 2, ly)], fill=TEAL, width=line_w)

    spark_r = max(3, int(round(canvas_px * 0.030)))
    spark_y = int(round(canvas_px * 0.27))
    draw.ellipse([cx - spark_r, spark_y - spark_r, cx + spark_r, spark_y + spark_r], fill=GOLD)

    return img.resize((size, size), Image.Resampling.LANCZOS)


def generate_all(res_dir: Path) -> list[Path]:
    written: list[Path] = []
    for folder_name, px in DENSITIES.items():
        target_dir = res_dir / folder_name
        target_dir.mkdir(parents=True, exist_ok=True)

        square_path = target_dir / "ic_launcher.png"
        round_path = target_dir / "ic_launcher_round.png"

        _draw_open_book_icon(px, round_mask=False).save(square_path, format="PNG", optimize=True)
        _draw_open_book_icon(px, round_mask=True).save(round_path, format="PNG", optimize=True)
        written.extend([square_path, round_path])
    return written


def main() -> int:
    res_dir = Path(__file__).resolve().parents[1] / "app" / "src" / "main" / "res"
    files = generate_all(res_dir)
    print(f"Generated {len(files)} launcher PNGs in {res_dir}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
