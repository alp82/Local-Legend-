#!/usr/bin/env python3
"""Composes out/proto-grid/parts.json (written by proto-grid-view.mjs) into one image."""
import json
from PIL import Image
d = json.load(open('out/proto-grid/parts.json'))
v = Image.new('RGB', (d['W'], d['H']), (255, 0, 255))
for p in d['parts']:
    im = Image.open(p['f']).convert('RGB').resize((p['size'], p['size']), Image.LANCZOS)
    v.paste(im, (p['left'], p['top']))
v.save(d['out'])
print(d['out'])
