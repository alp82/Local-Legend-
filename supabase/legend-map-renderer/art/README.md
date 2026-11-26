# Legend map art

The painter draws with the files in [../assets/](../assets/): three atlas sheets
(`atlas.webp`, `atlas2.webp`, `atlas3.webp`), 31 ground textures (`tex-*.webp`), `index.json`
(where each sprite sits, its ground anchor, footprint and entrances) and `bundle.json` (the
sheets and textures to load). Those finished files are what the repository keeps. This folder
holds the tools and the small inputs that built them.

## What's here, and what isn't

| Here | What it is |
| --- | --- |
| `tools/sprites5.py` | Builds `assets/` from the raw concept art: crops and downscales each sprite, records its anchor, packs the atlases, finishes the textures |
| `tools/drawn-sizes.mjs` | Measures the largest size each sprite is drawn at, so the atlas packs it at least that large (writes `meta/drawn-max.json`) |
| `tools/cutout.py` | Cuts the white background out of the UI Assets building paintings |
| `tools/sidebyside.py` | Puts a target picture and a painted view side by side, for comparing |
| `meta/ASSETS.md` | Every concept sprite with its ground footprint in metres |
| `meta/placements.json` | Set piece anchors, entrances, water sides and quay lines |
| `meta/placement-templates.json` | Ground quads and anchors of the block fillers |
| `meta/drawn-max.json` | Largest drawn widths (from `tools/drawn-sizes.mjs`) |
| `meta/generation.json` | How each concept picture was generated: prompts, references, style images |

**Not here: the raw concept art.** The atlas build reads about 560 MB of full-size paintings
(the chosen sprites, set pieces, scenery, fillers and textures), from a 658 MB folder that also
holds the rejected candidates. That's too large for a public repository, so it stays on the
owner's machine. Without it:

- You can change everything about *how* the painter draws: the painter code, placement,
  scales, colours applied in code, and the meta files above, as long as the change needs no new
  or redrawn sprite.
- You can't add, redraw or re-pack a sprite or texture. Ask the owner to run the build.

## Rebuild the atlases (needs the raw art)

From `supabase/legend-map-renderer/`, with Python 3, Pillow and NumPy:

```sh
python3 art/tools/sprites5.py --concept /path/to/concept --ui-assets /path/to/ui-assets
git diff --stat assets/
```

`--ui-assets` is the folder `tools/cutout.py` wrote (`python3 art/tools/cutout.py "<UI Assets folder>"
<out>`). The build writes straight into `assets/` and takes about two minutes. With the art and
meta files unchanged it reproduces the committed files byte for byte (checked on November 26,
2026: all 36 files identical).

After a painter change that can draw sprites larger, measure first, then rebuild:

```sh
node art/tools/drawn-sizes.mjs     # needs network the first time (source data)
```

Commit the new `assets/` together with any meta changes. New art changes the painter
fingerprint, so the next release paints a new tile version by itself (see "Releases" in
[../README.md](../README.md)).
