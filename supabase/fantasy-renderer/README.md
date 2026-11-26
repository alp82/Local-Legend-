# Fantasy tile renderer

The renderer paints the fantasy map as raster tiles. The app shows them above the street
map and under every game overlay (`mobile/src/components/fantasy-layer.tsx`).

It runs the fantasy map painter from the prototype, vendored in `painter/` (see
[VENDORED.md](VENDORED.md)), in headless Chromium, the browser the painter was written
for. A Node worker leases queued tiles from Supabase, paints them, and uploads them to
the public `fantasy-tiles` bucket. The queue is in
`supabase/migrations/20261125210000_fantasy_tiles.sql`.

## Tiles

- Zoom 16 tiles are painted, 1024 × 1024 px, as WebP. The app shows them at 512 px.
- Each paint is exactly the painter's `paintTile(16, x, y)`: the tile plus its fixed
  margin, one painter Web Worker per paint (`src/page/tileworker.js`). Never paint another
  window: the painter's README says a different canvas window rounds pixels differently.
- Every decision a tile edge can see is made once per fixed world cell (the painter's README,
  round 10), so neighbouring tiles meet whichever process paints them, and whenever.
- Village names are painted into the tiles in the prototype's label style (Fell SC), from the
  labels of the tile and its eight neighbours at their fixed spots.
- Road and water names are live labels in the app, from `<tile>.json` next to each WebP:
  `[{ name, lng, lat, rot, water }]`. These are the painter's own line labels, a road name only
  where a road the painter drew runs under its spot (`drawnNear` within 4 m).
- Zoom 15 tiles are the four z16 children scaled down. Missing children are painted
  first.
- Paths: `fantasy-tiles/v<version>/<z>/<x>/<y>.webp` and `.json`, uploaded with
  `cache-control: public, max-age=31536000, immutable`.

Pixels depend on Chromium's rasteriser. The image pins it (Playwright 1.65.1, Chromium
159.0.8154.6, base image by digest), and so does `package.json` (`playwright` 1.65.1).
Treat any Chromium change as a tile version bump.

The same tile always gets the same pixels, whatever was painted before it and in
whichever browser process. `test/renderer.test.mjs` checks this.

## Source data

The painter reads OpenFreeMap vector tiles (z14) and AWS terrain tiles (z14). The local
server in `src/server.mjs` stores every source tile the first time it's fetched and
serves that copy forever after. It also pins the OpenFreeMap build in `pinned.json`.
Tiles painted weeks apart therefore read the same data and still meet at their edges.

Keep `SOURCE_CACHE_DIR` on a persistent volume. Deleting it lets OpenStreetMap changes in,
and a new tile can then disagree with an older neighbour.

After three failed fetches the painter treats a data tile as empty. So the renderer
fetches the source tiles within 2 km before painting. A paint during which any source request
failed is thrown away, and the painter page is reloaded.

## Configuration

The worker reads only environment variables:

| Variable | Default | Meaning |
| --- | --- | --- |
| `SUPABASE_URL` | (required) | Project URL, such as `https://<ref>.supabase.co` |
| `SUPABASE_PUBLISHABLE_KEY` | | The app's publishable key, for signing in as the renderer user |
| `FANTASY_RENDERER_EMAIL`, `FANTASY_RENDERER_PASSWORD` | | The renderer user (production) |
| `SUPABASE_SECRET_KEY` | | Instead of the renderer user: a secret key (`sb_secret_…`) or the legacy `service_role` JWT (local stack, admin) |
| `SOURCE_CACHE_DIR` | `.source` (`/data/source` in Docker) | Frozen source tiles |
| `PAINT_WORKERS` | `4` | Painter Web Workers. Each needs about 1.5 GB in a dense city; production runs 1 |
| `SOURCE_PREFETCH_KM` | `12` | Radius (map km) of vector tiles fetched in parallel before a paint |
| `RECYCLE_TILES` | `300` | Tiles per painter page; the page is then replaced (the painter's caches only grow). Production: 100 |
| `LEASE_BATCH` | `8` | Tiles leased per round |
| `IDLE_POLL_MS` | `1000` | Wait between empty polls |
| `EXIT_WHEN_IDLE` | (unset) | `1`: stop when the queue is empty, for batch runs |
| `HEARTBEAT_FILE` | `/tmp/fantasy-worker-heartbeat.json` | Written after every round, for `src/health.mjs` and `src/status.mjs` |

In production the worker signs in as the renderer user, an auth user whose `app_metadata`
has `"fantasy_renderer": true`
(`supabase/migrations/20261126090000_fantasy_renderer_role.sql`). That user may only:

- Lease, finish and queue fantasy tiles.
- Read their status.
- Write the `fantasy-tiles` bucket.

The service key isn't needed.

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

To pre-paint an area, run this where the worker runs. It prints the tile count, time and
storage first, and queues only with `--yes`:

```sh
node src/prepaint.mjs --at 13.4140,52.5005 --radius-km 2 [--yes]
node src/prepaint.mjs --bbox 13.38,52.49,13.45,52.52 [--yes]
```

To pre-paint the testers' areas (every claimed cell plus about 1 km) without any position
leaving the database, run `sql/prepaint-territory-count.sql` (read only: tile counts, time,
storage) and then `sql/prepaint-territory-queue.sql` against the database.

To read health and progress (queue depth, tiles painted, storage, last error, requests today,
and the worker's heartbeat):

```sh
node src/status.mjs
```

Production runs `deploy/compose.yaml` on the worker host. The image is shipped by
`deploy/ship.sh`. See [docs/fantasy-map-deploy.md](../../docs/fantasy-map-deploy.md).

To paint a block of tiles to a folder without Supabase, for checks:

```sh
node src/cli.mjs --at 13.4140,52.5005 --radius 3 --out out/berlin --z15
python3 scripts/phone-view.py out/berlin <mercator x> <mercator y> view.png [approved.png]
```

## Speed and size

Measured with the round 11 painter in Docker at 2 CPUs, one painter, on a fast desktop core
(the production host's cores are likely slower):

- **Cold tile** (fresh page, no source data yet): 4 to 6 s in the Bavarian countryside, 12 to
  17 s in Manhattan. A cold tile reads 114 to 260 vector tiles (5 to 50 MB) up to about 17 km
  away, and builds the world plan for that whole area. With its data already on disk, the same
  country tile took 4.8 s instead of 11.6 s. The 12 km prefetch (`SOURCE_PREFETCH_KM`) fetches
  most of it in parallel first.
- **Warm tile** next to painted ones: median 0.7 s, 90th percentile 1.7 s (Manhattan).
- **Throughput** over 100 Manhattan tiles: 0.77 s per tile at a 4 GB limit, 1.0 to 1.1 s at 3 GB
  (including Chromium restarts).
- **Memory:** the painter's page alone peaks at about 2.4 GB in Manhattan, and the container at
  about 3.2 GB. At a 3 GB limit Chromium was killed about once per 100 tiles: the tile is painted
  again, so nothing wrong is stored. At 4 GB there were no kills.
- **Never-painted ground:** a phone screen took about 25 s to fill (Vienna, with one painter and
  empty source data).
- **Source data:** the first tile of a new area adds 5 MB (countryside) to 50 MB (Manhattan) to
  the frozen store; 340 Manhattan tiles came to 69 MB.
- **Mean z16 tile by WebP quality** (27 tiles, Berlin, Manhattan, Innsbruck): 0.7: 131 KB,
  0.75: 143 KB, 0.8: 180 KB. A z15 tile is about 15% larger.

## Tests

```sh
npm test   # tile arithmetic, determinism, z15, neighbours agreeing at edges
```

## Re-sync with the prototype

```sh
node scripts/sync-prototype.mjs
git diff painter/ VENDORED.md
npm test
```

Painter, art or Chromium changes paint different pixels. After a re-sync, raise
`fantasy_config.version`, so the app asks for new tiles instead of mixing old and new
ones.

`test/neighbours.test.mjs` paints adjacent tiles in separate browsers, from different
histories. It checks that they share plans, that sprites across the edge have one owner,
that no two set pieces stand on the same ground, and that pixels change no more across the
edge than inside a tile. Run it on every re-sync.

### Known issues (round 11, November 26, 2026)

The round 8 look is restored: roads to every heart, woods and mountain scenery before
fillers, sharp landmark trees and hamlets (no sprite is drawn above its atlas size), and every
heart named. What remains:

- **A tree avenue can run into a set piece.** Roads run solid up to a set piece's walls (round
  10), and the avenue along such a road can put its last trees over the wall (Berlin, the
  Kreuzberg walled town's north side).
- **Composition differs from round 8 by design:** hearts are decided per fixed world cell, so
  some sit at other spots, and some names differ (Berlin's camera heart is Kreuzberg; Luisenstadt
  names its neighbour).
- Church and landmark names aren't shown; only village names (painted in) and road and
  water names (live) are.
