# Fantasy tile renderer

The renderer paints the fantasy map as raster tiles. The app shows them above the street
map and under every game overlay (`mobile/src/components/fantasy-layer.tsx`).

It runs the fantasy map painter (`painter/`, see [painter/README.md](painter/README.md)) in
headless Chromium, the browser the painter was written for. A Node worker leases queued
tiles from Supabase, paints them, and uploads them to the public `fantasy-tiles` bucket. The
queue is in `supabase/migrations/20261125210000_fantasy_tiles.sql`, releases in
`supabase/migrations/20261126150000_fantasy_releases.sql`.

This folder is the source of truth for everything the renderer paints with:

| Folder | What | Change it how |
| --- | --- | --- |
| `painter/` | The painter and planner | Edit, test, open a pull request ([painter/README.md](painter/README.md)) |
| `assets/` | The finished art: atlases, textures, sprite index | Rebuilt from the raw concept art, which stays on the owner's machine ([art/README.md](art/README.md)) |
| `art/` | The art build tools and the small inputs that decide placement | Edit and rebuild |
| `src/` | The worker, the local source server, the in-browser paint path | Edit, test, open a pull request |

It used to be a copy of a local prototype; [VENDORED.md](VENDORED.md) says what was copied
and when.

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
fetches the source tiles within `SOURCE_PREFETCH_KM` before painting. A paint during which any
source request failed is thrown away, and the painter page is reloaded.

The store has two hard limits, so painting can't fill the host's disk or hammer the source
hosts:

- **Size** (`SOURCE_MAX_MB`, 8 GB in production). At the limit the store serves what it
  holds and fetches nothing new.
- **Fetches per day** (`SOURCE_FETCHES_PER_DAY`, 20,000 in production; a new area costs about
  150 to 300). The count survives restarts (`fetches.json` in the store).

When either limit is reached, tiles whose source data is already stored still paint. A tile
that needs new data fails at once with `not painted, needs new source data: <reason>`, and
isn't retried. Then `src/status.mjs` starts with `WARNING: NEW AREAS ARE NOT PAINTED:
<reason>` (also in its `warnings` list), and so does the health check's output
(`docker inspect --format '{{json .State.Health}}'`). Free disk under 2 GB gets a warning the
same way. The status also shows the store size, fetches today and free disk space
(`worker.source`).

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
| `SOURCE_MAX_MB` | `8000` | The frozen store's size limit |
| `SOURCE_FETCHES_PER_DAY` | `20000` | Upstream source fetches per UTC day |
| `SOURCE_FETCH_CONCURRENCY` | `6` | Upstream source fetches at a time |
| `NODE_USE_ENV_PROXY`, `HTTPS_PROXY`, `NO_PROXY` | (unset) | Send every outbound request through the egress proxy (set in `deploy/compose.yaml`) |
| `RECYCLE_TILES` | `300` | Tiles per painter page; the page is then replaced (the painter's caches only grow). Production: 100 |
| `LEASE_BATCH` | `8` | Tiles leased per round |
| `IDLE_POLL_MS` | `1000` | Wait between empty polls |
| `IDLE_RELEASE_MS` | `60000` | Idle time after which Chromium is closed to give its memory back; the next lease launches it again |
| `EXIT_WHEN_IDLE` | (unset) | `1`: stop when the queue is empty, for batch runs |
| `HEARTBEAT_FILE` | `/tmp/fantasy-worker-heartbeat.json` | Written after every round, for `src/health.mjs` and `src/status.mjs` |

In production the worker signs in as the renderer user, an auth user whose `app_metadata`
has `"fantasy_renderer": true`
(`supabase/migrations/20261126090000_fantasy_renderer_role.sql`). That user may only:

- Lease, finish and queue fantasy tiles.
- Read their status.
- Write the `fantasy-tiles` bucket.

The service key isn't needed.

The kill switch, the tile version, WebP quality, the limits and queue timing are in
`public.fantasy_config` in the database, so they change without touching the worker. A
fresh migration leaves the map switched off.

## Queue and limits

The app calls `request_fantasy_tiles` with the tiles around its view. The database decides
what gets queued, in this order:

1. **Kill switch.** Off: nothing is queued.
2. **Throttle.** A second call from the same player within `min_request_interval` (1 s)
   queues nothing and answers `reason: "throttled"`.
3. **Distance.** Only tiles within `near_player_m` (2 km) of the caller's own ground are
   accepted: their claimed cells, and the positions they uploaded in the last
   `recent_positions` (7 days). Other tiles are counted in `far` and ignored. Positions
   never leave the database.
4. **Room.** Each tile costs units: a z16 tile 1, a z15 tile up to 5 (see the following
   paragraphs).
   Tiles are taken in order while they fit in the smallest of these:
   - The player's allowance for the day (`daily_tiles_per_player`, 300).
   - Everyone's allowance for the day (`global_daily_tiles`, 2000).
   - The room left in the queue (`max_queue_depth`, 500 units of players' tiles).

   The answer names the limit that stopped it (`reason`: `player`, `global` or `queue`).

The player's row and the day's row are locked first, so parallel calls can't overshoot
either allowance. At most `max_tiles_per_call` (64) tiles per call are read, and at most
`max_visible_tiles` (24) of them count as on screen.

The worker leases tiles in this order:

1. Priority: on screen (0), around the screen (1), pre-painting (2).
2. Within a priority, players take turns: each player's oldest tile, then each player's
   second oldest, and so on. One player can't fill the queue ahead of the others.
3. Arrival order, then z16 before z15.

A tile that was already queued keeps its place; asking again doesn't move it forward. A tile
that failed `max_attempts` (3) times is given up, then leased again after `failed_cooldown`
(1 day), or at once with the operator query in the runbook.

`queue_fantasy_tiles` (pre-painting, renderer only) skips the distance rule and the player
and global allowances, at the lowest priority. Pre-painting doesn't count toward the queue
depth either, so a large pre-paint never blocks players' requests; it's leased after them.

A z15 tile costs 1 plus each of its four z16 children not painted or queued yet, so a z15
tile over painted ground costs 1. When a limit cuts a request short, the tiles on screen are
queued first, then those nearest the middle of the screen.

A lease that expires is leased again, at most `max_attempts` times in all. After that the
tile is given up like a failed one, so a tile that crashes the browser every time can't
restart the worker forever.

The distance rule reads `public.claimed_cells` and `public.walk_points` (`user_id`,
`recorded_at`, `geom`). A change to either table must keep `request_fantasy_tiles` working,
or every request comes back `far`; the pgTAP tests cover both.

### Follow-up: positions forged to open new areas

A player can upload forged positions, and the distance rule then accepts tiles around them.
Each forged spot opens a new area: new source data (150 to 300 fetches) and up to the
player's 300 units a day. Nothing yet limits how many new areas one player opens per day.
The source store's 8 GB limit and the 20,000 fetches a day bound the damage to the host and
the source hosts, and the global 2000 units a day bound the painting. The fix is a cap on
new areas per player per day: count the z14 source tiles a player's requests would add
first, and refuse past a small number.

## Isolation

The worker container is the security boundary, with these settings
(`deploy/compose.yaml`):

- **Network.** The worker is only on a Docker network with no route out (`internal: true`).
  Its one way out is the egress proxy (`src/egress-proxy.mjs`), a second container from the
  same image. The proxy accepts only `CONNECT` on port 443, to exactly these names: the
  Supabase project, `tiles.openfreemap.org` and `elevation-tiles-prod.s3.amazonaws.com`. It
  never connects to a private, loopback or link-local address, even when an allowed name
  resolves to one, and it connects to the address it checked. The worker therefore can't
  reach the host's private network or any other machine on it.
- **The host itself.** An internal Docker network still gets an address on the host, and
  through it a container reaches every host service listening on all addresses (sshd, for
  one). The `inside` network is created with `gateway_mode_ipv4: isolated` (and IPv6), so
  the bridge has no host address at all. This needs Docker 28.0 or later; older engines
  ignore the option without an error.
- **Proof after every deploy.** `src/egress-check.mjs`, run inside the worker container,
  checks that the allowed hosts answer through the proxy, that another host is refused,
  that nothing leaves directly, and that the host can't be reached on its network gateway
  address, `docker0`, or any address given on the command line.
- **Chromium runs without its own sandbox.** Playwright launches Chromium with
  `--no-sandbox` by default (`chromiumSandbox: false`). Chromium's sandbox needs user
  namespaces or a setuid helper, and Docker's default seccomp profile blocks the system calls
  it uses. Turning it on would need a custom seccomp profile or extra capabilities, which
  would weaken the container instead.
- **What the browser loads.** Chromium opens only the worker's own local pages and the
  painter files on `127.0.0.1`. Map data comes through that local server, which fetches
  only vector and terrain tiles from the allowed hosts, never pages or scripts.
- **The container.** It runs as the image's non-root `pwuser`, with every Linux capability
  dropped, `no-new-privileges`, no published ports, and CPU, memory and process limits.

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

Production runs `deploy/compose.yaml` on the worker host, deployed by Coolify from the
registry image after every merge to `main` (see "Releases"); `deploy/ship.sh` is the manual
fallback. See [docs/fantasy-map-deploy.md](../../docs/fantasy-map-deploy.md).

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
- **On the worker host** (November 26, 2026, 4 cores shared with other stacks, one painter at a
  3 GB limit): the testers' pre-paint (362 tiles queued, 445 painted with the missing z15
  children) took 24 minutes, about 4 s per z16 paint, with no failures or Chromium restarts. The
  container peaked at 2.4 GB, and the host's available memory went no lower than 1.6 GB. Idle,
  the worker held about 2.1 GB until its page was recycled; since then it closes Chromium after
  a minute idle (`IDLE_RELEASE_MS`). The 445 tiles came to 50 MB (113 KB
  per z16 tile, 120 KB per z15 tile on average) and 61 MB of source data from 1,134 fetches.
- **Mean z16 tile by WebP quality** (27 tiles, Berlin, Manhattan, Innsbruck): 0.7: 131 KB,
  0.75: 143 KB, 0.8: 180 KB. A z15 tile is about 15% larger.

## Tests

```sh
npm test   # tile arithmetic, determinism, z15, neighbours agreeing at edges, golden tiles,
           # source limits, the egress proxy, the queue under parallel calls, releases via the API
```

`test/queue.test.mjs` runs against the local Supabase stack (never another one) and skips
itself when the stack isn't running. The database rules are also covered by pgTAP:
`npx supabase test db`.

`test/neighbours.test.mjs` paints adjacent tiles in separate browsers, from different
histories. It checks that they share plans, that sprites across the edge have one owner,
that no two set pieces stand on the same ground, and that pixels change no more across the
edge than inside a tile.

`test/golden.test.mjs` paints a fixed 2 × 2 block of tiles and its z15 parent from frozen
source data (`test/fixtures/golden-source`, 3.7 MB, no network) and compares them by hash
with `test/golden.json`. It proves the painter fingerprint (see "Releases"). After a change
that paints differently on purpose, record the new hashes with `npm run golden:update`.

## Releases

A merge to `main` that touches the renderer releases it by itself
(`.github/workflows/fantasy-renderer.yml`):

1. GitHub runs the tests, builds the image, paints the golden tiles in it, pushes it to the
   container registry as `sha-<commit>` and `:release`, and calls Coolify's deploy webhook.
2. Coolify pulls `:release` and restarts the stack on the worker host.
3. The worker computes its **painter fingerprint** (`src/fingerprint.mjs`) and reports it
   (`begin_fantasy_release`):
   - **Same as the live version:** it carries on. Changes to the worker loop, the queue or the
     deploy files are just a restart.
   - **New:** a new tile version is staged. The worker paints it in the background for every
     known area (claimed land plus 1 km, and the live tiles players requested within 30
     days) while phones keep the live version. When nothing is left, phones switch to it at
     their next configuration check (app start or return to the foreground). Players' new
     tiles go to the staged version meanwhile.
   - **An earlier released version whose tiles still exist:** phones switch back to it at
     once, and the areas it misses are queued.
4. Replaced versions are deleted after 7 days (`version_grace`) by the worker itself, through
   the Storage API.

Phones never see old and new tiles side by side: they show one version, and an unpainted tile
shows the street map. GitHub holds no database credential; the worker does all of it as the
renderer user.

**The fingerprint** hashes everything that can change painted output: `painter/`, `assets/`,
`src/page/`, `src/paint-output.mjs` (Chromium's flags and the label format), the Playwright
version and the Dockerfile's pinned base image. `node src/fingerprint.mjs --list` shows each
input. A change to any of them, even a comment, starts a new version (a repaint costs about 4 s
per tile on the worker host); keep unrelated edits out of those files.

**Roll back** with the "Fantasy renderer rollback" workflow (Actions tab): it points
`:release` at an earlier `sha-<commit>` image and deploys it.

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
