# Builds the painter's art (assets/: atlas*.webp, tex-*.webp, index.json, bundle.json) from the raw concept art:
# downscales the concept sprites (read only), records each sprite's ground anchor, and packs the atlases.
#
#   python3 art/tools/sprites5.py --concept /path/to/concept --ui-assets /path/to/cut-out-ui-assets [--out assets]
#
# The raw concept art (about 560 MB of full-size paintings, from a larger folder of generated candidates) is not in
# the repository; it stays on the owner's machine (art/README.md). The small inputs that decide placement are
# here, in art/meta/: ASSETS.md (footprints), placements.json (set piece anchors and entrances),
# placement-templates.json (filler ground quads), drawn-max.json (art/tools/drawn-sizes.mjs).
import argparse, glob, json, os, re, tempfile
import numpy as np
from PIL import Image
ap = argparse.ArgumentParser()
ap.add_argument('--concept', required=True, help='the raw concept art folder (objects*/, setpieces/, scenery*/, fillers/, textures/)')
ap.add_argument('--ui-assets', required=True, help='the UI Assets buildings cut out by art/tools/cutout.py')
ap.add_argument('--out', default=os.path.join(os.path.dirname(__file__), '..', '..', 'assets'))
ap.add_argument('--work', default=None, help='folder for the downscaled single sprites (default: a temporary folder)')
args = ap.parse_args()
CONCEPT, UI = args.concept, args.ui_assets
META = os.path.join(os.path.dirname(__file__), '..', 'meta')
C = lambda *p: os.path.join(CONCEPT, *p)
SRC = [C('objects'), C('objects2'), C('objects3')]
# set four: whole places and scenery pieces, in their own atlas at a resolution set by their ground size
BIG = [C('setpieces'), C('scenery'), C('fillers'), C('scenery5')]
FILLS = {'river-current-painted', 'canal-reflection-painted'}  # water fills: textures, not sprites
# the few UI Assets buildings the map still uses (cut out by art/tools/cutout.py)
EXTRA = sorted(f for f in glob.glob(os.path.join(UI, '*.png')) if re.match(r'(castle|sawmill|watchtower)_[123]\.png$', os.path.basename(f)))
OUT, MAX = args.out, 480
WORK = args.work or tempfile.mkdtemp(prefix='sprites5-')
os.makedirs(OUT, exist_ok=True); os.makedirs(WORK, exist_ok=True)
PPM16 = 1024 / (2 * 3.141592653589793 * 6378137 / 65536) * 1.4  # px per map metre in a z16 tile at 1024 px
DRAWN = json.load(open(os.path.join(META, 'drawn-max.json'))) if os.path.exists(os.path.join(META, 'drawn-max.json')) else {}
# index.json records each sprite's source as the prototype did ('concept/...', 'assets/...'), so a rebuild from
# the same art gives the same file wherever the art lives
def rel(f):
    f = os.path.abspath(f)
    if f.startswith(os.path.abspath(CONCEPT) + os.sep): return 'concept/' + os.path.relpath(f, CONCEPT)
    return 'assets/' + os.path.basename(f)
index = {}
for d in SRC + ['__extra__']:
    for f in (EXTRA if d == '__extra__' else sorted(glob.glob(os.path.join(d, '*.png')))):
        name = os.path.splitext(os.path.basename(f))[0]
        im = Image.open(f).convert('RGBA')
        a = np.array(im)[..., 3]
        ys, xs = np.nonzero(a > 24)
        if not len(ys): continue
        im = im.crop((xs.min(), ys.min(), xs.max() + 1, ys.max() + 1))
        a = np.array(im)[..., 3]
        h, w = a.shape
        # ground anchor: centre of the opaque pixels in the lowest 12% of the sprite
        band = a[int(h * 0.88):, :] > 60
        cols = np.nonzero(band.any(axis=0))[0]
        ax = float((cols.min() + cols.max()) / 2 / w) if len(cols) else 0.5
        # footprint: opaque width across the lower third
        low = a[int(h * 0.66):, :] > 60
        lc = np.nonzero(low.any(axis=0))[0]
        foot = float((lc.max() - lc.min() + 1) / w) if len(lc) else 1.0
        s = min(1.0, MAX / max(w, h))
        im = im.resize((max(1, round(w * s)), max(1, round(h * s))), Image.LANCZOS)
        im.save(os.path.join(WORK, name + '.png'), optimize=True)
        index[name] = {'ow': int(a.shape[1]), 'oh': int(a.shape[0]), 'w': im.width, 'h': im.height, 'ax': round(ax, 3), 'ay': 0.94, 'foot': round(foot, 3), 'src': rel(f)}
# seamless ground textures, copied as they are (they repeat over a stated square of ground)
# one WebP atlas at the sizes actually drawn (≤ 256 px), shelf-packed, for one fetch per worker
ATL = 256
items = []
for name in sorted(index):
    im = Image.open(os.path.join(WORK, name + '.png')).convert('RGBA')
    cap = 320 if re.search(r'bridge|row-|church-', name) else 256 if re.search(r'quay|riverbank|kerb|rutted|hedge-|fence-|wall-', name) else 128 if name.startswith('decals') else 224
    cap = max(cap, round(DRAWN.get(name, 0) * 1.1 * max(im.width, im.height) / im.width))  # (never below its drawn width)
    s2 = min(1.0, cap / max(im.width, im.height)); im = im.resize((max(1, round(im.width * s2)), max(1, round(im.height * s2))), Image.LANCZOS)
    items.append((name, im))
SHEET_W = 2048; x = y = rowh = 0; rects = {}
for name, im in sorted(items, key=lambda t: -t[1].height):
    if x + im.width > SHEET_W: x = 0; y += rowh + 2; rowh = 0
    rects[name] = [x, y, im.width, im.height]; x += im.width + 2; rowh = max(rowh, im.height)
sheet = Image.new('RGBA', (SHEET_W, y + rowh), (0, 0, 0, 0))
for name, im in items: sheet.paste(im, tuple(rects[name][:2]))
sheet.save(os.path.join(OUT, 'atlas.webp'), 'WEBP', quality=88, method=6)
for name in rects: index[name]['atlas'] = rects[name]
# --- atlas 2: set pieces and scenery (footprints from concept/ASSETS.md)
foot = {}
for line in open(os.path.join(META, 'ASSETS.md')):
    m = re.match(r'\| `((?:setpieces|scenery5|scenery|fillers)/[^`]+)\.png` \|.*\| ([\d.]+) × ([\d.]+) \|\s*$', line.strip())
    if m: foot[os.path.basename(m.group(1))] = (float(m.group(2)), float(m.group(3)))
place = json.load(open(os.path.join(META, 'placements.json')))['set_pieces']
tpls = json.load(open(os.path.join(META, 'placement-templates.json')))['templates']
items2 = []
for d in BIG:
    for f in sorted(glob.glob(os.path.join(d, '*.png'))):
        name = os.path.splitext(os.path.basename(f))[0]
        if name in FILLS: continue
        im = Image.open(f).convert('RGBA'); W0, H0 = im.size
        fw, fh = foot.get(name, (60, 40))
        tk = '-'.join(name.split('-')[-2:]) if re.search(r'-(ew|ns)$', name) else '-'.join(name.split('-')[-3:])
        tpl = tpls.get(tk) if d.endswith('fillers') else None
        if tpl:  # a block filler: its ground quad gives the true scale (px per metre along the first edge)
            q = tpl['ground_quad_px']; ppm0 = ((q[1][0] - q[0][0]) ** 2 + (q[1][1] - q[0][1]) ** 2) ** 0.5 / tpl['length_m']
            img_m = W0 / ppm0 * (tpl['size_px'][0] / W0) if tpl['size_px'][0] == W0 else tpl['size_px'][0] / ppm0
        else: img_m = fw * 1.12
        # packed at least as large as it is ever drawn at tile resolution (z16, 1024 px per tile, 2.34 px per map
        # metre): the measured largest drawn width (tools/drawn-sizes.mjs), a set piece at the largest heart (270 m),
        # anything else at its own ground width × 1.3 (the largest scale the painter gives scenery); never above
        # the drawing's own size
        rule = 270 if d.endswith('setpieces') else img_m * 1.3
        target = max(40, round(max(rule * PPM16, DRAWN.get(name, 0) * 1.1)))
        s2 = min(1.0, target / W0); im2 = im.resize((max(1, round(W0 * s2)), max(1, round(H0 * s2))), Image.LANCZOS)
        meta = {'ow': W0, 'oh': H0, 'w': im2.width, 'h': im2.height, 'foot_m': [fw, fh], 'src': rel(f), 'set': d.endswith('setpieces')}
        pl = place.get(name)
        if tpl:
            meta['img_m'] = round(img_m, 2); meta['ax'] = round(tpl['anchor_px'][0] / tpl['size_px'][0], 4); meta['ay'] = round(tpl['anchor_px'][1] / tpl['size_px'][1], 4); meta['fill'] = {'L': tpl['length_m'], 'W': tpl['width_m'], 'ori': tk.split('-', 1)[1]}
        elif pl:
            meta['ax'], meta['ay'] = pl['anchor']['uv']
            meta['ports'] = [{'dir': e['direction'], 'role': e.get('role'), 'uv': e['uv']} for e in pl.get('entrances', [])]
            if pl.get('water_side'): meta['water'] = pl['water_side']
            if pl.get('quay_landline'): meta['quay'] = [q['uv'] for q in pl['quay_landline']]
        else:
            # scenery: the visual centre of the opaque pixels as anchor
            a = np.array(im2)[..., 3] > 40; ys, xs = np.nonzero(a)
            meta['ax'] = round(float(xs.mean() / im2.width), 3) if len(xs) else 0.5; meta['ay'] = round(float(ys.mean() / im2.height), 3) if len(ys) else 0.5
        meta['foot'] = 1.0
        items2.append((name, im2, meta))
# shelf-packed into sheets of 4096 × at most 8192 px (atlas2.webp, atlas3.webp, ...)
SW2, SH2 = 4096, 8192; sheets2 = [[]]; x = y = rowh = 0
for name, im, meta in sorted(items2, key=lambda t: -t[1].height):
    if x + im.width > SW2: x = 0; y += rowh + 2; rowh = 0
    if y + im.height > SH2: sheets2.append([]); x = y = rowh = 0
    meta['atlas'] = [x, y, im.width, im.height]; meta['sheet'] = len(sheets2); sheets2[-1].append((name, im, meta)); x += im.width + 2; rowh = max(rowh, im.height)
sheet_files = []
for si, group in enumerate(sheets2):
    if not group: continue
    hgt = max(m['atlas'][1] + m['atlas'][3] for _, _, m in group)
    sheet = Image.new('RGBA', (SW2, hgt), (0, 0, 0, 0))
    for name, im, meta in group: sheet.paste(im, tuple(meta['atlas'][:2])); index[name] = meta
    fn = f'atlas{si + 2}.webp'; sheet.save(os.path.join(OUT, fn), 'WEBP', quality=86, method=6); sheet_files.append(fn)
    print(fn, sheet.size, len(group))
# the meadow and water tiles get their finish here, not at run time: more local contrast (the painted
# finish has strong light and dark in the grass), and the older meadows a warm tint towards the targets
MEADOWS = {'meadow-sunlit', 'meadow-soft', 'meadow-cool', 'wildflower-meadow', 'pasture'}
CRISP = MEADOWS | {'meadow-swales', 'meadow-dry-patches', 'meadow-deep-green', 'river-water', 'lake-water'}
def finish(n, im):
    if n not in CRISP: return im
    a = np.asarray(im).astype(np.float32) / 255
    a = np.clip((a - 0.5) * (1.3 if n in ('river-water', 'lake-water') else 0.85) + 0.5, 0, 1)  # contrast (round 7: softer meadows)
    l = a @ np.array([0.2126, 0.7152, 0.0722], np.float32)            # saturate(1.08)
    sat = 1.08 if n in ('river-water', 'lake-water') else 0.8  # round 7: calmer, less saturated meadows
    a = np.clip(l[..., None] + (a - l[..., None]) * sat, 0, 1)
    if n in MEADOWS:
        a = a * np.array([226, 206, 236], np.float32) / 255           # multiply
        s2 = np.array([26, 4, 18], np.float32) / 255; a = 1 - (1 - a) * (1 - s2)  # screen
    return Image.fromarray((a * 255 + 0.5).astype(np.uint8))
for f in sorted(glob.glob(C('textures', '*.png'))) + [C('scenery', n + '.png') for n in sorted(FILLS) if os.path.exists(C('scenery', n + '.png'))]:
    n = os.path.splitext(os.path.basename(f))[0]
    finish(n, Image.open(f).convert('RGB')).save(os.path.join(OUT, 'tex-' + n + '.webp'), 'WEBP', quality=90)
json.dump(index, open(os.path.join(OUT, 'index.json'), 'w'), indent=1)
json.dump({'textures': sorted([os.path.splitext(os.path.basename(f))[0] for f in glob.glob(C('textures', '*.png'))] + [n for n in FILLS if os.path.exists(C('scenery', n + '.png'))]), 'sheets': ['atlas.webp'] + sheet_files}, open(os.path.join(OUT, 'bundle.json'), 'w'))
print(len(index), 'sprites')
