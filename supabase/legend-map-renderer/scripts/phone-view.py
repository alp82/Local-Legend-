#!/usr/bin/env python3
"""Composes painted z16 tiles into a phone-sized view (390x844 CSS px at z16, 2x), centred
on a mercator point, for side-by-side checks. Usage:
  phone-view.py <tiles-dir> <mx> <my> <out.png> [approved.png]
"""
import sys
from PIL import Image

HALF = 20037508.342789244
TS = 2 * HALF / 2 ** 16
PX = TS / 1024  # mercator metres per tile pixel
W, H = 780, 1688

d, mx, my, out = sys.argv[1], float(sys.argv[2]), float(sys.argv[3]), sys.argv[4]
x0, y0 = mx - W / 2 * PX, my + H / 2 * PX  # top-left in mercator
view = Image.new('RGB', (W, H), (255, 0, 255))
tx0, tx1 = int((x0 + HALF) // TS), int((x0 + W * PX + HALF) // TS)
ty0, ty1 = int((HALF - y0) // TS), int((HALF - (y0 - H * PX)) // TS)
missing = 0
for tx in range(tx0, tx1 + 1):
    for ty in range(ty0, ty1 + 1):
        try:
            t = Image.open(f'{d}/16/{tx}/{ty}.webp').convert('RGB')
        except FileNotFoundError:
            missing += 1
            continue
        left = round((tx * TS - HALF - x0) / PX)
        top = round((y0 - (HALF - ty * TS)) / PX)
        view.paste(t, (left, top))
if len(sys.argv) > 5:
    ref = Image.open(sys.argv[5]).convert('RGB').resize((W, H), Image.LANCZOS)
    both = Image.new('RGB', (W * 2 + 20, H), (255, 255, 255))
    both.paste(ref, (0, 0))
    both.paste(view, (W + 20, 0))
    view = both
view.save(out)
print(out, 'missing tiles:', missing)
