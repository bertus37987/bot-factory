import argparse
import json
import os
from pathlib import Path
from shutil import copyfile

from PIL import Image, ImageDraw

parser = argparse.ArgumentParser()
parser.add_argument("output_dir", type=Path, help="Output directory from render_bears_blender.py")
output_dir = parser.parse_args().output_dir.resolve()
raw_dir = output_dir / "raw"
web_dir = output_dir / "web"
anchors_path = output_dir / "eyeAnchors.json"
sheet_path = output_dir / "bear-contact-sheet.png"

ROLES = ["orchestrator", "team-lead", "builder", "artist", "research", "verifier", "cub"]

with anchors_path.open("r", encoding="utf-8") as f:
    anchors = json.load(f)

web_dir.mkdir(exist_ok=True)
copyfile(anchors_path, web_dir / anchors_path.name)

# Downsample 512x512 renders to crisp 256x256 RGBA PNGs
final_imgs = {}
for role in ROLES:
    src = raw_dir / f"bear-{role}.png"
    dst = web_dir / f"bear-{role}.png"
    im = Image.open(src).convert("RGBA")
    resized = im.resize((256, 256), Image.Resampling.LANCZOS)
    resized.save(dst, "PNG", optimize=True)
    final_imgs[role] = resized
    print(f"Saved {dst} ({os.path.getsize(dst)} bytes)")

# Build verification contact sheet:
# Row 0: Vanta Black #000000 (128px raw bear heads)
# Row 1: Vanta Black #000000 (128px with simulated glossy dot eyes at projected anchor coords)
# Row 2: Light Mode #FFFFFF (128px with simulated dot eyes)
# Row 3: 28px icon strip (both Vanta Black and Light Mode) to verify silhouette legibility at small chat size
cell_w, cell_h = 148, 152
cols = len(ROLES)
sheet = Image.new("RGBA", (cols * cell_w, cell_h * 3 + 64), (0, 0, 0, 255))
draw = ImageDraw.Draw(sheet)

# Backgrounds per row
draw.rectangle([0, 0, sheet.width, cell_h * 2], fill=(0, 0, 0, 255))
draw.rectangle([0, cell_h * 2, sheet.width, cell_h * 3], fill=(255, 255, 255, 255))
draw.rectangle([0, cell_h * 3, sheet.width // 2, sheet.height], fill=(0, 0, 0, 255))
draw.rectangle([sheet.width // 2, cell_h * 3, sheet.width, sheet.height], fill=(255, 255, 255, 255))

def overlay_simulated_eyes(base_rgba, size, role_anchor):
    out = base_rgba.copy()
    d = ImageDraw.Draw(out)
    has_shades = role_anchor.get("hasShades", False)
    for key in ("left", "right"):
        nx, ny = role_anchor[key]
        cx = (nx / 100.0) * size
        cy = (ny / 100.0) * size
        rx = size * 0.038
        ry = size * 0.056
        if has_shades:
            # Subtle white crescent gleam on shades lens
            d.ellipse([cx - rx * 0.65, cy - ry * 0.65, cx + rx * 0.15, cy - ry * 0.10], fill=(255, 255, 255, 190))
        else:
            d.ellipse([cx - rx, cy - ry, cx + rx, cy + ry], fill=(16, 12, 10, 255))
            hr = max(1.0, size * 0.013)
            d.ellipse([cx - rx * 0.5, cy - ry * 0.6, cx - rx * 0.5 + hr * 2, cy - ry * 0.6 + hr * 2], fill=(255, 255, 255, 235))
    return out

for i, role in enumerate(ROLES):
    x0 = i * cell_w + (cell_w - 128) // 2
    img_128 = final_imgs[role].resize((128, 128), Image.Resampling.LANCZOS)
    img_eyes_128 = overlay_simulated_eyes(img_128, 128, anchors[role])

    # Row 0: blank matte bear
    sheet.alpha_composite(img_128, (x0, 8))
    # Row 1: Vanta with dot eyes
    sheet.alpha_composite(img_eyes_128, (x0, cell_h + 8))
    # Row 2: Light with dot eyes
    sheet.alpha_composite(img_eyes_128, (x0, cell_h * 2 + 8))
    # Row 3: 28px thumbnails (dark half + light half)
    thumb_28 = overlay_simulated_eyes(final_imgs[role].resize((28, 28), Image.Resampling.LANCZOS), 28, anchors[role])
    sheet.alpha_composite(thumb_28, (24 + i * 48, cell_h * 3 + 18))
    sheet.alpha_composite(thumb_28, (sheet.width // 2 + 24 + i * 48, cell_h * 3 + 18))

sheet.convert("RGB").save(sheet_path, "PNG")
print(f"Contact sheet written to {sheet_path}")
