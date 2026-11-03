"""Generate the Model Download Manager app icons.

Run with: python scripts/gen-icons.py
Requires Pillow. Produces src-tauri/icons/*.png and icon.ico.
"""
from __future__ import annotations

import math
import os

from PIL import Image, ImageDraw, ImageFilter

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ICON_DIR = os.path.join(ROOT, "src-tauri", "icons")

SIZE = 1024
BG_TOP = (37, 99, 235)      # blue-600
BG_BOTTOM = (6, 182, 212)   # cyan-500
WHITE = (255, 255, 255, 255)


def lerp(a: tuple[int, int, int], b: tuple[int, int, int], t: float) -> tuple[int, int, int]:
    return tuple(round(a[i] + (b[i] - a[i]) * t) for i in range(3))


def rounded_mask(size: int, radius: int) -> Image.Image:
    mask = Image.new("L", (size, size), 0)
    draw = ImageDraw.Draw(mask)
    draw.rounded_rectangle((0, 0, size - 1, size - 1), radius=radius, fill=255)
    return mask


def build_icon() -> Image.Image:
    # Vertical gradient background.
    bg = Image.new("RGB", (SIZE, SIZE), BG_TOP)
    pixels = bg.load()
    for y in range(SIZE):
        color = lerp(BG_TOP, BG_BOTTOM, y / (SIZE - 1))
        for x in range(SIZE):
            pixels[x, y] = color

    # Soft highlight blob for depth.
    glow = Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0))
    gdraw = ImageDraw.Draw(glow)
    gdraw.ellipse((SIZE * 0.05, -SIZE * 0.25, SIZE * 0.95, SIZE * 0.45), fill=(255, 255, 255, 38))
    glow = glow.filter(ImageFilter.GaussianBlur(SIZE * 0.06))
    bg = Image.alpha_composite(bg.convert("RGBA"), glow)

    # Foreground glyph: download arrow into a tray, with a small model cube.
    glyph = Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0))
    gd = ImageDraw.Draw(glyph)

    cx = SIZE / 2
    arrow_top = SIZE * 0.20
    arrow_bottom = SIZE * 0.615
    shaft_w = SIZE * 0.115
    head_w = SIZE * 0.30
    head_h = SIZE * 0.155

    # Arrow shaft.
    gd.rounded_rectangle(
        (cx - shaft_w / 2, arrow_top, cx + shaft_w / 2, arrow_bottom - head_h * 0.55),
        radius=shaft_w * 0.22,
        fill=WHITE,
    )
    # Arrow head (triangle with rounded joins drawn via polygon + circles).
    head_pts = [
        (cx - head_w / 2, arrow_bottom - head_h * 1.15),
        (cx + head_w / 2, arrow_bottom - head_h * 1.15),
        (cx, arrow_bottom),
    ]
    gd.polygon(head_pts, fill=WHITE)

    # Tray / disk line.
    tray_y = SIZE * 0.735
    tray_w = SIZE * 0.50
    gd.rounded_rectangle(
        (cx - tray_w / 2, tray_y, cx + tray_w / 2, tray_y + SIZE * 0.070),
        radius=SIZE * 0.035,
        fill=WHITE,
    )

    # Three small dots beneath the tray to suggest a task queue.
    dot_r = SIZE * 0.021
    for i, alpha in enumerate((255, 200, 145)):
        dx = (i - 1) * SIZE * 0.105
        color = (255, 255, 255, alpha)
        gd.ellipse(
            (cx + dx - dot_r, SIZE * 0.875 - dot_r, cx + dx + dot_r, SIZE * 0.875 + dot_r),
            fill=color,
        )
    glyph = glyph.filter(ImageFilter.GaussianBlur(SIZE * 0.0045))

    composed = Image.alpha_composite(bg, glyph)
    composed.putalpha(rounded_mask(SIZE, int(SIZE * 0.235)))
    return composed


def main() -> None:
    os.makedirs(ICON_DIR, exist_ok=True)
    master = build_icon()
    master.save(os.path.join(ICON_DIR, "icon-source.png"))

    png_sizes = {
        "32x32.png": 32,
        "64x64.png": 64,
        "128x128.png": 128,
        "128x128@2x.png": 256,
        "icon.png": 512,
    }
    for name, size in png_sizes.items():
        master.resize((size, size), Image.LANCZOS).save(os.path.join(ICON_DIR, name))

    ico_sizes = [(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)]
    master.save(
        os.path.join(ICON_DIR, "icon.ico"),
        format="ICO",
        sizes=ico_sizes,
        append_images=[master.resize(s, Image.LANCZOS) for s in ico_sizes],
    )
    # Windows Store style square logos.
    for name, size in {
        "Square30x30Logo.png": 30,
        "Square44x44Logo.png": 44,
        "Square71x71Logo.png": 71,
        "Square89x89Logo.png": 89,
        "Square107x107Logo.png": 107,
        "Square142x142Logo.png": 142,
        "Square150x150Logo.png": 150,
        "Square284x284Logo.png": 284,
        "Square310x310Logo.png": 310,
        "StoreLogo.png": 50,
    }.items():
        master.resize((size, size), Image.LANCZOS).save(os.path.join(ICON_DIR, name))
    print(f"Icons written to {ICON_DIR}")


if __name__ == "__main__":
    main()
