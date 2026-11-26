# The fantasy map painter

This folder is the painter itself, and the source of truth for it. It used to be a copy of a
local prototype; since November 26, 2026 it's edited here (see [../VENDORED.md](../VENDORED.md)
for where it came from). [HISTORY.md](HISTORY.md) explains how the look and the rules were
reached, round by round.

## Files

| File | What it is |
| --- | --- |
| `fmcore.js` | World constants (`KF`, `NET`), projection, hash and noise, elevation (`demAt`, throws `NeedDem`), geometry helpers |
| `tiledata.js` | z14 vector tile loader and decoder; throws `NeedTiles`; `withData()` loads missing vector and elevation tiles and runs again |
| `vendor/vt.mjs` | Vector tile and protobuf reader, used by `tiledata.js` |
| `fmworld.js` | The world plan: terrain, hearts and their names, compounds, abbeys, road survival, bridges, town and canal water, labels, and every ground piece |
| `painter5.js` | Ground painter, tile planner (`paintRegion`), sprite bake (`bake`), asset intake (`provide`) |
| `tilepainter.js` | The entry point: `loadAssets`, `paintTile`, `planTile`, `paintWindow` |

The art the painter draws with is in [../assets/](../assets/): `bundle.json` lists the atlas
sheets and the 31 ground textures, and `index.json` places every sprite on its sheet. How the
art is built is in [../art/README.md](../art/README.md).

## Rules that keep tiles seamless

Tiles are painted weeks apart, by different processes, and must still meet at their edges.

- **One paint unit.** The server paints exactly `paintTile(16, x, y)`: the tile plus its fixed
  margin. Never paint another window: the same world pixel in a different canvas frame rounds
  differently (up to 3% of pixels, at most 7 levels).
- **Decisions per fixed world cell.** Every decision a tile edge can see (hearts, compounds,
  roads, bridges, labels, ground pieces) is made once per cell of a fixed world grid (the grid
  table in HISTORY.md, round 10), so neighbouring tiles agree whoever paints them, and whenever.
- **No state between tiles.** A tile painted twice, in any order, from any cache state, in any
  process, is bit-identical in the same browser engine.
- **Pinned engine.** Pixels depend on Chromium's rasteriser, so the worker image pins
  Playwright, Chromium and the base image by digest. Changing any of them changes pixels.

The tests prove the last three: `test/renderer.test.mjs` (same tile, same bytes, any browser
and order), `test/neighbours.test.mjs` (neighbours from different histories share plans and meet
at the edge), and `test/golden.test.mjs` (a fixed set of tiles still paints the recorded
bytes).

## Inputs

- **Vector tiles:** OpenMapTiles schema, zoom 14 only, from OpenFreeMap. The renderer pins the
  OpenFreeMap build and freezes every tile it fetches (`src/server.mjs`).
- **Terrain:** Terrarium PNG at zoom 14 from AWS `elevation-tiles-prod`.
- **Reach:** the world plan reads the z14 tile under a z16 tile, its neighbours, and often a ring
  further (a village joins the road network up to 2 km away).

## Change the painter

1. Edit the files here (or the art, see [../art/README.md](../art/README.md)).
2. Check the look: `node src/cli.mjs --at 13.4140,52.5005 --radius 3 --out out/berlin --z15`,
   then `python3 scripts/phone-view.py out/berlin <x> <y> view.png` for a phone-sized view.
3. Run `npm test`. If pixels changed on purpose, `test/golden.test.mjs` fails: record the new
   golden hashes with `npm run golden:update` and commit them with your change. They show the
   reviewer exactly which tiles changed.
4. Open a pull request. The workflow runs the tests. Once it's merged, the release goes out by
   itself: see "Releases" in [../README.md](../README.md).

You don't bump the tile version by hand. The painter fingerprint (`src/fingerprint.mjs`) changes
whenever painted output can change, and a new fingerprint starts a new tile version.
