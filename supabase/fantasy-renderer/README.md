# Fantasy tile renderer

The renderer paints the fantasy map as raster tiles. The app shows them above the street
map and under every game overlay (`mobile/src/components/fantasy-layer.tsx`).

It runs the fantasy map painter from the prototype, vendored in `painter/` (see
[VENDORED.md](VENDORED.md)), in headless Chromium, the browser the painter was written
for. A Node worker leases queued tiles from Supabase, paints them, and uploads them to
the public `fantasy-tiles` bucket. The queue is in
`supabase/migrations/20261125210000_fantasy_tiles.sql`.

## Tiles

- Zoom 16 tiles are painted, 1024 × 1024 px, as WebP. That is the painter's own
  resolution (quality 2 at band 16). The app shows them at 512 px.
- A z16 tile is exactly one of the painter's chunks: chunk `i = x - 2^15`,
  `j = 2^15 - 1 - y` with the chunk width set to the tile width. Its sprites come from
  the plans of the 3 × 3 neighbourhood, as in the prototype, so neighbouring tiles meet.
- Village names are painted into the tiles in the prototype's label style (Fell SC).
  Road and water names are live labels in the app.
- Zoom 15 tiles are the four z16 children scaled down. Missing children are painted
  first.
- Paths: `fantasy-tiles/v<version>/<z>/<x>/<y>.webp`, uploaded with
  `cache-control: public, max-age=31536000, immutable`.

The same tile always gets the same pixels, whatever was painted before it and in
whichever browser process. `test/renderer.test.mjs` checks this.

## Source data

The painter reads OpenFreeMap vector tiles (z14) and AWS terrain tiles (z14). The local
server in `src/server.mjs` stores every source tile the first time it's fetched and
serves that copy forever after. It also pins the OpenFreeMap build in `pinned.json`.
Tiles painted weeks apart therefore read the same data and still meet at their edges.

Keep `SOURCE_CACHE_DIR` on a persistent volume. Deleting it lets OpenStreetMap changes in,
and a new tile can then disagree with an older neighbour.

The painter treats a failed source fetch as "no data". So the renderer fetches every
source tile a paint needs before painting. A paint during which any source request
failed is thrown away, and the painter page is reloaded.

## Configuration

The worker reads only environment variables:

| Variable | Default | Meaning |
| --- | --- | --- |
| `SUPABASE_URL` | (required) | Project URL, such as `https://<ref>.supabase.co` |
| `SUPABASE_SECRET_KEY` | (required) | A secret key (`sb_secret_…`) or the legacy `service_role` JWT |
| `SOURCE_CACHE_DIR` | `.source` (`/data/source` in Docker) | Frozen source tiles |
| `PAINT_WORKERS` | `4` | Painter Web Workers; about one per CPU core |
| `LEASE_BATCH` | `8` | Tiles leased per round |
| `IDLE_POLL_MS` | `1000` | Wait between empty polls |
| `EXIT_WHEN_IDLE` | (unset) | `1`: stop when the queue is empty, for batch runs |

The kill switch, the tile version, WebP quality, the per-player daily cap and queue timing
are in `public.fantasy_config` in the database, so they change without touching the
worker.

## Run

```sh
npm ci
npx playwright install chromium   # once, outside Docker

# The worker against the local stack
SUPABASE_URL=http://127.0.0.1:54321 SUPABASE_SECRET_KEY=<local secret key> npm run worker

# In Docker
docker build -t fantasy-renderer .
docker run -e SUPABASE_URL=... -e SUPABASE_SECRET_KEY=... -v fantasy-source:/data fantasy-renderer
```

To paint a block of tiles to a folder without Supabase, for checks:

```sh
node src/cli.mjs --at 13.4140,52.5005 --radius 3 --out out/berlin --z15
python3 scripts/phone-view.py out/berlin <mercator x> <mercator y> view.png [approved.png]
```

## Speed and size

These numbers were measured on a 32-thread desktop with 8 painter workers, for Berlin
Kreuzberg:

- About 110 ms per tile throughput.
- 1.0 to 2.5 s for one tile in a fresh process.
- At WebP quality 0.8, a z16 tile averages 135 KB (up to 160 KB). A z15 tile is about
  175 KB.

## Tests

```sh
npm test   # tile arithmetic, plan agreement, determinism, z15
```

## Re-sync with the prototype

```sh
node scripts/sync-prototype.mjs
git diff painter/ VENDORED.md
npm test   # fails if tileworker.js no longer matches chunkworker.js
```

Painter or art changes paint different pixels. After a re-sync, raise
`fantasy_config.version`, so the app asks for new tiles instead of mixing old and new
ones.
