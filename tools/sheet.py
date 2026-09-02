#!/usr/bin/env python3
# 定点スクリーンショットを1枚の一覧表にまとめる（批評用）。
#   python3 tools/sheet.py <接頭辞> [出力名]   例: python3 tools/sheet.py r1 → shots/r1_sheet.png
#   --pair <接頭辞A> <接頭辞B>                 2つの版を左右に並べる（before/after）
import sys, os, glob
from PIL import Image, ImageDraw

ORDER = ["golden", "noon", "dawn", "cloudy", "rain", "storm", "night", "sunset_water", "forest", "ridge", "flip_half", "flip_full"]
OUT = "shots"

def load(prefix, name):
    p = os.path.join(OUT, f"{prefix}_{name}.png")
    return Image.open(p).convert("RGB") if os.path.exists(p) else None

def sheet(prefixes, outname, cell_w=800):
    cols = len(prefixes)
    rows = []
    for name in ORDER:
        ims = [load(p, name) for p in prefixes]
        if all(i is None for i in ims):
            continue
        rows.append((name, ims))
    if not rows:
        print("no shots"); return
    ratio = 900 / 1600
    cell_h = int(cell_w * ratio)
    W = cols * cell_w
    H = len(rows) * (cell_h + 26)
    out = Image.new("RGB", (W, H), (20, 20, 20))
    d = ImageDraw.Draw(out)
    for r, (name, ims) in enumerate(rows):
        y = r * (cell_h + 26)
        for c, im in enumerate(ims):
            x = c * cell_w
            if im is not None:
                out.paste(im.resize((cell_w, cell_h), Image.LANCZOS), (x, y + 26))
            d.text((x + 8, y + 6), f"{prefixes[c]} / {name}", fill=(230, 230, 230))
    path = os.path.join(OUT, f"{outname}.png")
    out.save(path)
    print(path)

args = sys.argv[1:]
if args and args[0] == "--pair":
    sheet([args[1], args[2]], args[3] if len(args) > 3 else f"{args[1]}_vs_{args[2]}", cell_w=700)
else:
    prefix = args[0] if args else "v1"
    sheet([prefix], args[1] if len(args) > 1 else f"{prefix}_sheet", cell_w=1000)
