# Supabase backend

This directory holds the Supabase configuration, database migrations, and
database tests for Local Legend.

Players sign in anonymously, so every player gets a real auth user without an
email address. You can link an email or OAuth identity to that user later.
Each player has one row in `public.player_state`. Row level security (RLS)
allows a player to read, create, and update only their own row.

## Territory

The phone reports walks as batches of GPS points. The server validates the
points and saves the land the player claimed as map cells. The migrations
`migrations/*_territory.sql` and `migrations/*_vehicle_buffer.sql` define
everything below.

### Cells

A cell is a square Web Mercator tile at zoom 21, the same grid as XYZ map
tiles. A cell is about 19.1 m wide at the equator and 19.1 m × cos(latitude)
on the ground, for example 11.8 m at 52°N. The cell id is `x * 2^21 + y`. A
walk claims every cell whose center lies within 30 m of the path, which gives
the 60 m strip from the design document.

The H3 Postgres extension isn't available on Supabase, so cells are computed
in plain SQL with PostGIS. No Edge Function is needed.

### Functions

| Function                                                  | Purpose |
| --------------------------------------------------------- | ------- |
| `submit_location_batch(p_batch_id, p_session_id, p_points)` | Validates one batch and claims cells. Idempotent per player and batch id. |
| `close_walk_session(p_session_id)`                        | Marks a session finished and claims its last, now settled segments. Idempotent. Returns `newCells`, `totalCells`, and `closed` (false for an unknown session). |
| `get_territory()`                                         | Returns the caller's land as merged GeoJSON polygons, `totalCells`, and `areaM2`. |
| `private.purge_walk_points(older_than)`                   | Deletes `walk_points` rows older than 30 days by default. Not callable by clients. |

Clients can only `SELECT` their own rows from the territory tables. All
writes go through `submit_location_batch` and `close_walk_session`.

`submit_location_batch` raises `42501` when the caller isn't signed in, and
`22023` when the batch is malformed or has more than 500 points. Retrying
won't fix a `22023` error. `close_walk_session` raises the same codes for a
caller who isn't signed in or a bad session id. The app closes a session
after it stops and all its points are uploaded. Invalid individual points don't raise an error;
they're counted in `rejectedPoints`.

### Rules

All thresholds live in `private.claim_rules()`:

- Points with accuracy worse than 35 m, or no accuracy, are rejected.
- Points more than 1 minute in the future or more than 7 days old are
  rejected, as are repeated timestamps within a session.
- Consecutive points of a session are connected in time order, across
  batches and regardless of arrival order. A segment with a speed of at most
  3.5 m/s is a walking segment; a faster one is a fast segment and is never
  claimed.
- A segment longer than 2 minutes or 250 m is a gap and isn't claimed. A
  point with a gap on both sides claims a 30 m disk around itself.
- Vehicle buffer: a car in slow traffic or at a red light moves at walking
  speed, so a walking segment (or an isolated point) is claimed only if both
  hold:
  - No fast segment of the same player, in any of their sessions, lies
    within 2 minutes before its start or after its end. Stopping and restarting
    tracking at a red light doesn't get around this.
  - It's settled: the session has a point at least 2 minutes after its end, or
    the session is closed with `close_walk_session`.
- So the last 2 minutes of a walk are claimed by the next batch or when the
  session is closed, not right away. Claims are never taken back: a fast
  segment that arrives later doesn't undo a claim.

### Tables

- `claimed_cells`: one row per player and cell.
- `walk_sessions`: per-session stats: accepted and rejected points, first and
  last point time, distance on foot, new cells, and `closed_at`.
- `location_batches`: one row per processed batch, used for idempotency.
- `walk_points`: raw accepted GPS points.

**Temporary:** `walk_points` exists only for the commute test phase, to
diagnose tracking quality. It stores GPS tracks, which conflicts with the
design rule that the app stores land, not tracks. It's also used to connect
batches that arrive out of order. Run `select private.purge_walk_points();`
to delete points older than 30 days. Drop the table before launch.

## Sites

Sites are the map overlays near the player's land: places worth knowing
(future place cards) and mine sites. The migrations `migrations/*_sites.sql`
and `migrations/*_sites_openfreemap.sql` and the Edge Function
`functions/sites/` define everything below.

### How it works

The data comes from OpenStreetMap through
[OpenFreeMap](https://openfreemap.org) vector tiles in the
[OpenMapTiles schema](https://openmaptiles.org/schema/), the same tiles the
app's map uses. Postgres can't make HTTP requests, so the `sites` Edge
Function fetches the data:

1. The app calls the function with a bounding box. The function verifies the
   caller's JWT.
1. `claim_site_areas` finds the areas in the box within 150 m of the caller's
   land that were never fetched or are older than 30 days. An area is a zoom
   14 Web Mercator tile, about 1.6 km wide at 50°N. The function leases at
   most 4 areas per call, so two requests never fetch the same area. With
   each area it returns the source filter: the tile layers and values the
   rules can match.
1. The function reads the current tile URL from the OpenFreeMap TileJSON at
   `https://tiles.openfreemap.org/planet` and caches it for 6 hours. The URL
   names a dated build, so it's never hardcoded. The function then downloads
   the zoom 14 vector tile of each area, in parallel, and decodes it.
1. The function turns the tile into elements that `ingest_site_area`
   understands:
   - The element id is the OSM id, such as `way/785550415`. OpenFreeMap
     encodes it in the feature id as `osm_id * 10 + type`. A feature without
     an id gets `hash/<16 hex digits>`, a hash of its layer, class, subclass,
     name, and first vertex.
   - The tags are the feature properties as `<layer>.<field>`, such as
     `poi.subclass: castle`, plus `name` and `name:en`. Features that share
     an OSM id are merged, so a park POI carries its landcover polygon.
   - Polygons arrive as rings, lines as their middle vertex.
   - `building_cover` holds the share of each of the 8 × 8 grid cells (about
     200 m) covered by building footprints.
1. `ingest_site_area` filters and classifies the elements, derives mine
   sites, and replaces the area's rows in `sites`.
1. `get_sites` returns the caller's visible sites.

A tile downloads in about 200 ms and an area ingests in about 300 ms in
total, so the first call for a new area usually returns its sites directly.
If fetching takes longer than 8 seconds, the function answers from the cache
and keeps fetching in the background. The response's `pending` field counts
the areas still loading; a later call returns their sites. A tile download
stops after 10 seconds. A failed fetch is retried after 10 minutes. A cached
call takes about 50 ms locally.

The function holds no game rules. The filters and all thresholds live in the
migrations, in `private.site_rules()`, `private.place_rules()`,
`private.green_rules()`, `private.exclude_rules()`, and
`private.source_filter()`.

### Rules

Rules match OpenMapTiles layers and fields.

| Site | Matches |
| ---- | ------- |
| Viewpoint | `poi` subclass `viewpoint` |
| Castle | `poi` subclass `castle`, which includes palaces |
| Ruins, monument | `poi` subclass `ruins`, `monument` |
| Historic | named `poi` subclass `sally_port` (city gates) |
| Artwork, museum, attraction, café | `poi` subclass `artwork`, `museum`, `attraction`, `cafe` |
| Steps | named `transportation_name` subclass `steps` |
| Park | named `poi` subclass `park` whose polygon (landcover subclass `park`) has at least 0.5 ha |
| Exclusion zone | `landuse` class `cemetery`, `religious`, `military`, `railway`, `education`, `school`, `university`, `college`, `kindergarten`, `hospital`, `prison` |
| Never a place | `poi` class `place_of_worship`, `cemetery`, `school`, `college`, `hospital`, `railway`, and subclass `grave_yard`, `kindergarten`, `university`, `clinic`, `doctors`, `dentist`, `nursing_home`, `prison`, `memorial` |
| Sawmill area | `landcover` class `wood`, landcover subclass `park`, `garden`, `recreation_ground`, and `park` class `nature_reserve`, `national_park` |

No site lies inside an exclusion zone, so a café in a cemetery or a statue in
a schoolyard never shows.

OpenMapTiles leaves out some OSM data, which changes these rules compared
with the earlier Overpass version:

- There are no fountains, memorials, or historic buildings other than the
  classes above.
- There are no `access`, `memorial`, `religion`, or Wikipedia tags, so
  private places can't be filtered and notability has no Wikipedia bonus.
- Churches are POI points without a polygon, so they're not exclusion zones.

**Mines,** at most 5 per area and at least 150 m apart:

- Gold mine (at most 1): the zoom 17 grid cell (about 200 m) whose places
  score at least 10, at the centroid of those places. Castles, museums, and
  attractions score 2; viewpoints, ruins, monuments, gates, and artworks 1.
- Sawmill (at most 2): sawmill areas with at least 0.5 ha inside the area,
  largest first, at a point inside the polygon.
- Quarry (at most 2): grid cells at least 40% covered by buildings, densest
  first, at the cell center. Tiles merge many buildings into one feature, so
  the rule uses footprint area instead of a building count.

The same tile always gives the same sites. Areas are fetched again after 30
days, from the build the TileJSON names at that time.

### Attribution and terms

OpenFreeMap is free, has no usage limits, and needs no API key. Its tiles
are served from a CDN. The data is © OpenStreetMap contributors under the
[ODbL](https://www.openstreetmap.org/copyright), and the schema is ©
OpenMapTiles. Show "OpenFreeMap © OpenMapTiles Data from OpenStreetMap" in
the app, as the map style's attribution already does, and keep it if place
cards show the names. Requests identify the app with the user agent
`LocalLegendPrototype/0.1`.

### Visibility

`get_sites(west, south, east, north)` returns each site with `visibility`:

- `owned`: the site's cell is claimed by the caller.
- `silhouette`: the center of a claimed cell is within 150 m of the site. The
  name is withheld.

Sites farther from the caller's land aren't returned. The check uses the cell
grid, one index range scan per cell column, so it stays fast with many
thousands of claimed cells. Boxes larger than 0.25° per side are refused
with `22023`.

### Tables and functions

- `sites`: shared by all players. One row per site, with `osm:<type>/<id>`,
  `omt:<hash>`, or a derived mine id, `kind`, `subtype`, `name`, the point, its claim `cell`,
  its `area`, and a few source tags.
- `site_areas`: the fetch cache, with `fetched_at`, the lease, and the last
  error.

Clients have no access to either table and call only `get_sites`.
`claim_site_areas`, `ingest_site_area`, and `fail_site_area` are callable
only with the service role.

## Economy

Resources, the daily Keep tax, walking pay, and Ruler XP. The migration
`migrations/*_economy.sql` and the Edge Function `functions/terrain/` define
everything below; [docs/economy.md](../docs/economy.md) explains the rules.
The numbers come from `private.economy_rules()`, which
`scripts/generate-rules.mjs` writes into `migrations/*_economy_rules.sql` from
the spreadsheet (see [docs/rules.md](../docs/rules.md)).

### How it works

- `submit_location_batch` and `close_walk_session` pay for the walking they
  claim, in the same transaction, and return it as `reward` (null when
  nothing paid). A repeated batch pays nothing.
- Cells claimed for the first time pay as new ground. Walking segments on land
  claimed earlier pay as usual routes, up to 5 km a day.
- Days reset at 4 a.m. in the player's time zone, which the app sends to
  `get_economy`.
- Terrain resources need the area's terrain. When it isn't stored yet, the
  gold and XP pay at once and the rest waits in `terrain_pending` until the
  `terrain` function classifies the area.

### Functions

| Function | Purpose |
| -------- | ------- |
| `get_economy(p_time_zone)` | Stores the time zone, pays any Keep tax due, and returns resources (whole units), `rulerXp`, `rulerLevel`, today's walking, and `pendingTerrainKm`. |
| `claim_terrain_areas(p_user, p_max)` | Service role only. Leases areas where the player has terrain pay waiting. |
| `ingest_terrain_area(p_area, p_grid)` | Service role only. Stores an area's terrain and pays everyone waiting on it. Raises `22023` for a malformed grid. |
| `fail_terrain_area(p_area, p_error)` | Service role only. Releases a lease after a failed fetch. |

### Tables

- `player_economy`: balances, Ruler XP, time zone, and the last day the Keep
  tax was paid.
- `economy_days`: walking per game day, for the caps and XP bands.
- `economy_ledger`: every change to a balance. Balances equal the sums.
- `terrain_pending`: paid km whose terrain resources wait for terrain.
- `terrain_areas`: terrain per claim cell, one string per zoom 14 area. No
  client access.

Clients can only `SELECT` their own rows from the first four tables. All
writes go through the functions.

### The terrain function

`POST /functions/v1/terrain` with a signed-in user's token and an empty body
returns `{classified, pending}`. It classifies at most 4 areas per call, from
the same OpenFreeMap tiles as `sites`, in about half a second each. `pending`
counts areas still loading; call again later for them. The classes and
distances live in `private.terrain_classes()`, not in the function.

## Kingdom

Buildings, the daily construction, Pikemen, and Treasury caps. The migration
`migrations/*_kingdom.sql` defines everything below;
[docs/kingdom.md](../docs/kingdom.md) explains the rules.

### How it works

- `build_building` and `recruit_units` take a request id, a UUID the app makes
  once per tap and reuses on retries. A repeated id returns the first result
  with `duplicate: true` and changes nothing. A request a game rule refuses
  changes nothing and isn't stored.
- Each player's actions run one at a time: both functions lock the player's
  `player_economy` row first.
- A refused request returns `{ok: false, reason}` rather than an error, so the
  app can say why. Errors are for bad input (`22023`) and signed-out callers
  (`42501`).

### Functions

| Function | Purpose |
| -------- | ------- |
| `get_kingdom(p_time_zone)` | Like `get_economy`, plus `kingdom`: building levels, `buildsToday`, `buildsPerDay`, `nextBuildAt`, Treasury `caps`, the `garrison`, `recruits`, and `nextRecruitsAt`. |
| `build_building(p_building, p_level, p_request_id)` | Builds level `p_level` of a Keep, Treasury, Walls, or Barracks. Refusals: `already_built`, `not_next_level`, `max_level`, `ruler_level`, `keep_level`, `daily_limit`, `not_enough`. |
| `recruit_units(p_unit, p_count, p_request_id)` | Recruits Pikemen (`pikeman`) into the garrison. Refusals: `needs_building`, `not_enough_recruits`, `not_enough`. |

Both actions return the result together with `economy` and `kingdom` as they
are afterward.

### Tables

- `player_buildings`: building levels. A missing row is the start level (Keep
  1, everything else 0).
- `player_garrison`: units per player.
- `kingdom_actions`: every construction and recruitment, keyed by request id,
  with its game day and result.

Clients can only `SELECT` their own rows. All writes go through the functions.

## Detours

Daily detour offers just off the routes a player walks often, collected by
walking within 30 m. The migration `migrations/*_detours.sql` and the
`functions/detours` Edge Function define everything below;
[docs/detours.md](../docs/detours.md) explains the rules.

### How it works

1. The app calls the `detours` function. It leases the zoom 14 areas within
   reach of the player's routes that have no spots yet
   (`claim_detour_areas`), downloads their OpenFreeMap tiles, and passes the
   walkable features to `ingest_detour_area`, which stores the spots.
1. The function then calls `get_detour_offers` as the player, which fills the
   day's empty offer slots and returns them.
1. `submit_location_batch` and `close_walk_session` collect offers in
   `private.claim_settled` and return them in `detours`.
1. A `pg_cron` job, `detour-offers`, runs `private.generate_due_detour_offers()`
   every 15 minutes for players who walked in the last week.

### Functions

| Function | Purpose |
| -------- | ------- |
| `get_detour_offers(p_time_zone, p_lat, p_lng)` | Stores the time zone like `get_economy`, fills the day's empty offer slots, and returns `gameDay`, `source`, `offers`, `offersPerDay`, `missingAreas`, `validFrom`, `validUntil`, and `timeZoneAccepted`. `p_lat` and `p_lng` are only used for a player with no walks and no land. |
| `claim_detour_areas(p_user, p_lat, p_lng, p_max)` | Service role only. Leases spot areas to fetch. |
| `ingest_detour_area(p_area, p_data)` | Service role only. Replaces an area's spots from its tile features. |
| `fail_detour_area(p_area, p_error)` | Service role only. Releases a lease after a failed fetch. |

### Tables

- `route_tiles`: zoom 19 tiles walked per player and game day.
- `detour_offers`: offers, with their spot, added time, reward, validity, and
  `collected_at`.
- `detour_days`: one row per player and day that offers were made for.
- `detour_spots` and `detour_spot_areas`: the spot cache. Clients can't read
  them.

Clients can only `SELECT` their own rows of the first three. All writes go
through the functions.

## Before you begin

- Install Docker and make sure it's running.
- Install Node.js. The commands below run the Supabase CLI through `npx`, so
  you don't need a global install.

Run all commands from the repository root.

## Start the local stack

```sh
npx supabase@latest start
```

The command prints the local URLs and keys. To print them again, run:

```sh
npx supabase@latest status
```

The values the mobile app needs are:

| Name              | Local value                                       |
| ----------------- | ------------------------------------------------- |
| `API_URL`         | `http://127.0.0.1:54321`                          |
| `PUBLISHABLE_KEY` | Starts with `sb_publishable_`. Use it as the client key. |

Studio runs at `http://127.0.0.1:54323`.

To stop the stack, run `npx supabase@latest stop`.

## Reset the local database

To drop the local database and apply every migration again, run:

```sh
npx supabase@latest db reset
```

## Run the database tests

The pgTAP tests in `tests/` check the RLS policies, table and function
privileges, the `player_state` constraints and trigger, the territory
rules (idempotency, connecting batches, speed, gap, and accuracy rejection,
and the shape of `get_territory`), the site rules (filters, mine
derivation and its determinism, area leases, and visibility), and the economy
(starting resources, pay that happens once despite retries and out-of-order
batches, daily caps, the Keep tax and walks across the 4 a.m. reset in several
time zones, terrain settlement, Ruler levels, the ledger, and privileges),
and the kingdom (construction costs and XP, the daily construction across the
4 a.m. reset and time zone changes, Keep and Ruler level gates, retries,
Pikemen and their weekly recruits, Treasury caps, and privileges).

```sh
npx supabase@latest test db
```

The Edge Functions have Deno unit tests for decoding and classifying vector
tiles. They use a real tile of Krakow's old town,
`functions/sites/testdata/krakow_14_9099_5552.pbf`. The terrain tests read
the classes from `migrations/*_economy.sql`:

```sh
deno test --allow-read --allow-env supabase/functions/sites/ supabase/functions/terrain/
```

## Run the Edge Function locally

To serve the functions in `functions/` with their logs, run:

```sh
npx supabase@latest functions serve
```

The functions are at `http://127.0.0.1:54321/functions/v1/sites` and
`http://127.0.0.1:54321/functions/v1/terrain`. They need a signed-in user's
access token in the `Authorization` header. They download real tiles from
OpenFreeMap.

The function needs no secrets. To use another tile server with the
OpenMapTiles schema, set `TILEJSON_URL` to its TileJSON URL in
`functions/.env`.

## Change the schema

1. Create a migration file:

   ```sh
   npx supabase@latest migration new <name>
   ```

1. Write the SQL, then run `db reset` and `test db`.
1. Regenerate the TypeScript types for the mobile app:

   ```sh
   npx supabase@latest gen types typescript --local > mobile/src/lib/database.types.ts
   ```

## Link a hosted project

When you're ready to use a hosted Supabase project, do the following:

1. Log in to the Supabase CLI:

   ```sh
   npx supabase@latest login
   ```

1. Link this directory to the project. Find the project ref in the project's
   dashboard URL.

   ```sh
   npx supabase@latest link --project-ref <project-ref>
   ```

1. Apply the migrations to the hosted database. In CLI 3, `db push` targets
   the local database unless you pass `--remote`.

   ```sh
   npx supabase@latest db push --remote --dry-run
   npx supabase@latest db push --remote
   ```

1. Turn on anonymous sign-ins in the dashboard under **Authentication** >
   **Sign In / Providers**. Don't run `config push`: `config.toml` holds
   local-development defaults, and pushing it would turn off email
   confirmations and MFA on the hosted project. Run `config diff` to compare.

1. Deploy the Edge Functions:

   ```sh
   npx supabase@latest functions deploy sites
   npx supabase@latest functions deploy terrain
   ```

   To use another tile server, run
   `npx supabase@latest secrets set TILEJSON_URL=<url>`.

1. In the mobile app, use the hosted project URL and publishable key from the
   dashboard instead of the local values.

## Hosted project

- Project: **Local Legend App**, ref `bvnlepwccygdkgsezgka`, region
  `eu-west-1`. This directory is linked to it.
- Anonymous sign-ins are on. The `player_state` and `territory` migrations
  are applied.
- `mobile/.env.local` and the EAS `development`, `preview`, and `production`
  environments hold `EXPO_PUBLIC_SUPABASE_URL` and `EXPO_PUBLIC_SUPABASE_KEY`
  for this project.

Anonymous sign-ins are rate limited per IP address. Consider enabling CAPTCHA
for the hosted project to limit abuse.
