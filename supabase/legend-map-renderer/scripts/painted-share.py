#!/usr/bin/env python3
"""Share of a phone screenshot's map area showing painted Legend map tiles rather than the
street map, for timing checks. The painted meadow is yellow-green (green and red well
above blue, even under the Mist); the street map is grey, white or blue. The status bar,
the top buttons and the bottom button rows are left out.
Usage: painted-share.py <screenshot.png> [...]
"""
import sys
from PIL import Image

for path in sys.argv[1:]:
    im = Image.open(path).convert('RGB')
    w, h = im.size
    box = im.crop((0, int(h * 0.30), w, int(h * 0.86))).resize((120, 200))
    b = box.tobytes()
    px = [(b[i], b[i + 1], b[i + 2]) for i in range(0, len(b), 3)]
    painted = sum(1 for r, g, b in px if g - b > 22 and r - b > 10)
    print(f'{path}\t{painted / len(px):.2f}')
