# Cut the white background out of the UI Assets paintings (originals untouched).
import sys, glob, os
from collections import deque
import numpy as np
from PIL import Image, ImageFilter
src, dst = sys.argv[1], sys.argv[2]
os.makedirs(dst, exist_ok=True)
names = ['Castle', 'Fantasy Tavern', 'Sawmill', 'Stables', 'Watchtower', 'Barracks', 'Archery', 'Stone mine', 'Gold Mine Upgrade Progression', 'Crystals mine', 'Gems mine']
for base in names:
    for lvl in (1, 2, 3):
        f = os.path.join(src, f'{base} {lvl}.png') if 'Progression' not in base else os.path.join(src, f'{base}{lvl}.png')
        if not os.path.exists(f): print('missing', f); continue
        im = Image.open(f).convert('RGBA'); a = np.array(im).astype(np.int32)
        h, w = a.shape[:2]
        r, g, b = a[..., 0], a[..., 1], a[..., 2]
        mn, mx = np.minimum(np.minimum(r, g), b), np.maximum(np.maximum(r, g), b)
        bgish = (mn > 226) & (mx - mn < 22)
        seen = np.zeros((h, w), bool); q = deque()
        for x in range(w):
            for y in (0, h - 1):
                if bgish[y, x] and not seen[y, x]: seen[y, x] = True; q.append((y, x))
        for y in range(h):
            for x in (0, w - 1):
                if bgish[y, x] and not seen[y, x]: seen[y, x] = True; q.append((y, x))
        while q:
            y, x = q.popleft()
            for dy, dx in ((1, 0), (-1, 0), (0, 1), (0, -1)):
                ny, nx = y + dy, x + dx
                if 0 <= ny < h and 0 <= nx < w and not seen[ny, nx] and bgish[ny, nx]:
                    seen[ny, nx] = True; q.append((ny, nx))
        alpha = np.where(seen, 0, 255).astype(np.uint8)
        # feather the edge (blur the mask, keep the inside solid) and defringe light edge pixels
        m = Image.fromarray(alpha).filter(ImageFilter.GaussianBlur(2.2))
        soft = np.minimum(np.array(m).astype(np.int32) * 2 - 120, 255).clip(0, 255)
        light = (mn > 205) & (mx - mn < 30)
        soft = np.where(light & (soft < 255), soft // 3, soft)
        a[..., 3] = soft
        out = Image.fromarray(a.astype(np.uint8), 'RGBA')
        bb = out.getbbox(); out = out.crop(bb)
        scale = 420 / max(out.size)
        out = out.resize((round(out.size[0] * scale), round(out.size[1] * scale)), Image.LANCZOS)
        key = base.lower().replace(' upgrade progression', '').replace(' ', '_')
        out.save(os.path.join(dst, f'{key}_{lvl}.png'))
        print(key, lvl, out.size)
