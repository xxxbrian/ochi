#!/usr/bin/env python3
"""Resize the exact user artwork; do not regenerate or retouch its content."""

import hashlib
import json
import math
import shutil
from datetime import datetime, timezone
from pathlib import Path
from statistics import median

from PIL import Image, ImageDraw, ImageFont


ROOT = Path(__file__).resolve().parents[1]
BRANDING = ROOT / "build/branding"
ORIGINAL = ROOT / "assets/branding/original.png"
MOBILE = ROOT / "mobile"
WEB = ROOT / "web/public"
NATIVE_ICON = MOBILE / "ios/Ochi/Images.xcassets/AppIcon.appiconset/App-Icon-1024x1024@1x.png"
RES = MOBILE / "android/app/src/main/res"
LANCZOS = Image.Resampling.LANCZOS
DENSITIES = {"mdpi": 1, "hdpi": 1.5, "xhdpi": 2, "xxhdpi": 3, "xxxhdpi": 4}
# Measured bounding boxes enclosing the two eyes in the original 1254px artwork.
EYES = [(245, 729, 360, 935), (610, 860, 715, 1056)]


def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def mask(size, exponent=2):
    scale = 4
    large = size * scale
    result = Image.new("L", (large, large), 0)
    pixels = result.load()
    for y in range(large):
        ny = abs((y + 0.5 - large / 2) / (large / 2)) ** exponent
        for x in range(large):
            nx = abs((x + 0.5 - large / 2) / (large / 2)) ** exponent
            if nx + ny <= 1:
                pixels[x, y] = 255
    return result.resize((size, size), LANCZOS)


def masked(image, exponent=2):
    result = image.convert("RGBA")
    result.putalpha(mask(image.width, exponent))
    return result


def write(image, path):
    path.parent.mkdir(parents=True, exist_ok=True)
    if path.suffix == ".webp":
        image.save(path, lossless=True, method=6)
    else:
        image.save(path, optimize=True)
    generated.append(path)


BRANDING.mkdir(parents=True, exist_ok=True)
if not ORIGINAL.is_file():
    raise FileNotFoundError("The preserved artwork assets/branding/original.png is required")
original = Image.open(ORIGINAL).convert("RGB")
assert original.size == (1254, 1254), "Unexpected source dimensions: review framing instead of guessing"
edge = [original.getpixel((x, 0)) for x in range(original.width)]
edge += [original.getpixel((original.width - 1, y)) for y in range(600)]
background = tuple(round(median(channel)) for channel in zip(*edge))
background_hex = "#" + "".join(f"{channel:02x}" for channel in background)
assert background_hex == "#313235", "Source edge color changed; update resource/config deliberately"
generated = []

# iOS receives the complete square artwork, opaque, without a baked-in mask.
icon = original.resize((1024, 1024), LANCZOS)
write(icon, MOBILE / "assets/icon.png")
NATIVE_ICON.parent.mkdir(parents=True, exist_ok=True)
shutil.copyfile(MOBILE / "assets/icon.png", NATIVE_ICON)
generated.append(NATIVE_ICON)

# The 108dp foreground canvas has a central 72dp viewport; key eyes fit inside
# the documented central 66dp safe circle. The OS alone applies the adaptive mask.
adaptive_size = 1024
art_size = round(adaptive_size * 72 / 108)
offset = (adaptive_size - art_size) // 2
adaptive = Image.new("RGBA", (adaptive_size, adaptive_size), (0, 0, 0, 0))
adaptive.alpha_composite(original.resize((art_size, art_size), LANCZOS).convert("RGBA"), (offset, offset))
write(adaptive, MOBILE / "assets/adaptive-icon.png")

safe_center = adaptive_size / 2
safe_radius = adaptive_size * 33 / 108
eye_report = []
for box in EYES:
    mapped = tuple(offset + coordinate * art_size / original.width for coordinate in box)
    x1, y1, x2, y2 = mapped
    distances = [math.hypot(x - safe_center, y - safe_center) for x in (x1, x2) for y in (y1, y2)]
    assert max(distances) < safe_radius, "An eye would cross the guaranteed adaptive safe circle"
    eye_report.append({"source_box": box, "adaptive_box": mapped, "safe_circle_margin_px": safe_radius - max(distances)})

for density, scale in DENSITIES.items():
    folder = RES / f"mipmap-{density}"
    launcher_size = round(48 * scale)
    foreground_size = round(108 * scale)
    write(icon.resize((launcher_size, launcher_size), LANCZOS), folder / "ic_launcher.webp")
    write(masked(icon.resize((launcher_size, launcher_size), LANCZOS)), folder / "ic_launcher_round.webp")
    write(adaptive.resize((foreground_size, foreground_size), LANCZOS), folder / "ic_launcher_foreground.webp")

for size in (16, 32, 48, 192):
    write(icon.resize((size, size), LANCZOS), WEB / f"favicon-{size}.png")
write(icon.resize((180, 180), LANCZOS), WEB / "apple-touch-icon.png")
icon.save(WEB / "favicon.ico", sizes=[(16, 16), (32, 32), (48, 48)])
generated.append(WEB / "favicon.ico")

# Contact sheet masks are simulated previews only; these masks are NOT baked into
# iOS or adaptive source assets. Legacy round icons necessarily carry alpha masks.
canvas = Image.new("RGB", (1000, 790), "#eeeeef")
draw = ImageDraw.Draw(canvas)
font_path = Path("/System/Library/Fonts/Helvetica.ttc")
font = ImageFont.truetype(str(font_path), 20) if font_path.exists() else ImageFont.load_default(size=20)
small = ImageFont.truetype(str(font_path), 15) if font_path.exists() else ImageFont.load_default(size=15)
panel_size = 266


def panel(column, row, label, image):
    x, y = 28 + column * 324, 66 + row * 350
    draw.text((x, y - 29), label, fill="#202124", font=font)
    image = image.resize((panel_size, panel_size), LANCZOS).convert("RGBA")
    for cy in range(0, panel_size, 16):
        for cx in range(0, panel_size, 16):
            fill = "#dedee0" if (cx // 16 + cy // 16) % 2 else "#f9f9fa"
            draw.rectangle((x + cx, y + cy, x + min(cx + 15, panel_size - 1), y + min(cy + 15, panel_size - 1)), fill=fill)
    canvas.paste(image, (x, y), image)


viewport = adaptive.crop((offset, offset, offset + art_size, offset + art_size))
viewport = Image.alpha_composite(Image.new("RGBA", viewport.size, background + (255,)), viewport)
panel(0, 0, "Exact user composition", icon)
panel(1, 0, "iOS mask preview (approx.)", masked(icon.resize((266, 266), LANCZOS), 5))
panel(2, 0, "Android adaptive circle", masked(viewport.resize((266, 266), LANCZOS)))
panel(0, 1, "Android squircle (approx.)", masked(viewport.resize((266, 266), LANCZOS), 4))
safe = Image.alpha_composite(Image.new("RGBA", adaptive.size, background + (255,)), adaptive).resize((266, 266), LANCZOS)
safe_draw = ImageDraw.Draw(safe)
safe_radius_panel = 266 * 33 / 108
safe_draw.ellipse((133 - safe_radius_panel, 133 - safe_radius_panel, 133 + safe_radius_panel, 133 + safe_radius_panel), outline="#76e6ff", width=2)
for eye in eye_report:
    safe_draw.rectangle(tuple(coordinate * 266 / adaptive_size for coordinate in eye["adaptive_box"]), outline="#76e6ff", width=2)
panel(1, 1, "66dp safe circle / both eyes", safe)
favicon_panel = Image.new("RGB", (266, 266), "#eeeeef")
favicon_draw = ImageDraw.Draw(favicon_panel)
for size, x, y, factor in ((16, 8, 24, 4), (32, 97, 8, 3), (48, 87, 130, 2)):
    preview = Image.open(WEB / f"favicon-{size}.png").resize((size * factor, size * factor), Image.Resampling.NEAREST)
    favicon_panel.paste(preview, (x, y))
    favicon_draw.text((x, y + size * factor + 5), f"{size}px", fill="#202124", font=small)
panel(2, 1, "Web favicon pixel previews", favicon_panel)
draw.text((28, 766), "Original artwork only. Native/adaptive masks are platform-owned. Background #313235.", fill="#56575a", font=small)
write(canvas, BRANDING / "icon-mask-contact-sheet.png")

resources = []
for file in generated:
    with Image.open(file) as image:
        entry = {"path": str(file.relative_to(ROOT)), "sha256": sha(file), "size": image.size, "mode": image.mode}
        if "A" in image.getbands():
            entry["alpha_range"] = image.getchannel("A").getextrema()
        resources.append(entry)

report = {
    "generated_at": datetime.now(timezone.utc).isoformat(),
    "source": {"path": str(ORIGINAL.relative_to(ROOT)), "sha256": sha(ORIGINAL), "dimensions": original.size},
    "provenance": "User-supplied artwork, explicitly authorized for app icons. Original bytes preserved. Any original image-generation prompt is provenance, not an instruction to regenerate. This pipeline uses only Pillow resampling and platform masks; no AI generation, retouching, recoloring or additional mascot UI.",
    "ios": "Opaque RGB1024 square, full original composition, no baked-in rounding.",
    "android": {"foreground_canvas_dp": 108, "artwork_viewport_dp": 72, "safe_circle_diameter_dp": 66, "background": background_hex, "eye_safe_zone_checks": eye_report, "foregrounds": "Lossless WebP resized from the exact Expo adaptive source; legacy launchers use original composition, round variants apply an antialiased circle."},
    "contact_sheet_scope": "Simulated circle/superellipse masks, safe-zone proof and favicon pixels. Not a native launcher screenshot or proof of on-device appearance.",
    "resources": resources,
}
(BRANDING / "icon-manifest.json").write_text(json.dumps(report, indent=2) + "\n")
assert Image.open(NATIVE_ICON).mode == "RGB"
assert sha(NATIVE_ICON) == sha(MOBILE / "assets/icon.png")
print(f"Generated {len(generated)} assets from original SHA256 {sha(ORIGINAL)}")
print(f"Adaptive background {background_hex}; minimum eye safe-circle margin {min(eye['safe_circle_margin_px'] for eye in eye_report):.2f}px")
print(BRANDING / "icon-mask-contact-sheet.png")
