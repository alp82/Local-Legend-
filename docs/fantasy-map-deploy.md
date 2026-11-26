# Fantasy map: deploy and roll back

This runbook takes the fantasy map live for testers, and back out again. Testers only means:

- The branch is merged to `main`.
- The migrations are applied to the hosted Supabase project.
- The tile worker runs on the worker host.
- An over-the-air (OTA) update goes to the `preview` channel.

There is no store build and no `production` channel. How the pieces fit is described in
`supabase/fantasy-renderer/README.md`.

| Piece | Where |
| --- | --- |
| Queue, switches, status, renderer rights | `supabase/migrations/20261125210000_fantasy_tiles.sql`, `20261126090000_fantasy_renderer_role.sql` |
| Tiles | Public Storage bucket `fantasy-tiles`, paths `v<version>/<z>/<x>/<y>.webp` |
| Worker | Docker on the worker host (ssh login in `$WORKER`), compose project `fantasy-renderer` in `/opt/fantasy-renderer` |
| App | `mobile/src/components/fantasy-layer.tsx`, `mobile/src/hooks/use-fantasy-map.ts` (JavaScript only; the runtime fingerprint is unchanged) |

## Before you begin

- The branch `fantasy-map-layer` is merged to `main`, and you're on an up-to-date `main`.
- The Supabase CLI is linked to the hosted project. `npx supabase projects list` marks
  **Local Legend App** as linked.
- `WORKER` holds the worker host's ssh login (`export WORKER=root@<worker host>`), `ssh "$WORKER"` works with your key, and Docker runs on this machine.
- The EAS CLI is logged in as `alperortac` (see [test-distribution.md](test-distribution.md)).
- You've chosen the starting values. See
  [Starting values and what they cost](#starting-values-and-what-they-cost).

The worker host is shared with an analytics stack and a Windmill worker. Its compose file
caps it at 2 CPUs and 3 GB of memory (swap included), with no published ports and rotated
logs. It runs one painter. With the round 11 painter that peaked at about 3.2 GB in dense
Manhattan: at 3 GB Chromium was killed about once per 100 tiles (the tile is painted again,
so nothing wrong is stored, but each restart costs time); at 4 GB there were no kills.
The limit is `FANTASY_RENDERER_MEMORY` in `/opt/fantasy-renderer/.env` (default `3g`). The owner
kept 3 GB (November 26, 2026): the host's memory is shared with an analytics database, and a
restart about once per 100 dense-city tiles is acceptable because the tile is painted again.

## Go live

Run these in order. Each step says what to check before you go on.

### 1. Apply the migrations

From the repository root:

```sh
npx supabase db push --dry-run   # lists exactly the two fantasy migrations
npx supabase db push
```

The migrations create the map switched off, with the launch values (see
[Starting values and what they cost](#starting-values-and-what-they-cost)). Nothing needs
setting here. In the Supabase Dashboard SQL editor, check them:

```sql
select jsonb_pretty(public.fantasy_status());
```

Check: the status shows `"enabled": false`, `"version": 1`, the queue at 0, and under
`limits` a per-player cap of 300, a global limit of 2000 and a queue depth of 500. Version 1
is the final painter: no tiles were ever published before it.

### 2. Create the renderer user

The worker doesn't use the service key. It signs in as one auth user flagged
`fantasy_renderer`. That user can only:

- Lease, finish and queue fantasy tiles.
- Read their status.
- Write the `fantasy-tiles` bucket.

The user's address is `fantasy-renderer@renderer.invalid`. It's synthetic: the `.invalid`
domain can never receive mail, and the address names nobody. Nobody signs in with it but the
worker.

1. Make a password: `openssl rand -base64 33`.
2. In the Dashboard, go to **Authentication > Users > Add user > Create new user**. Enter
   `fantasy-renderer@renderer.invalid` and the password, and turn **Auto Confirm User** on.
   This creates the user directly and sends no mail, so the project's email confirmation
   doesn't get in the way. If Supabase rejects the address, stop and report it. Don't use a
   real address instead.
3. In the SQL editor:

   ```sql
   update auth.users
   set raw_app_meta_data = raw_app_meta_data || '{"fantasy_renderer": true}'
   where email = 'fantasy-renderer@renderer.invalid';
   ```

Check: **Authentication > Sign In / Providers > Email** is enabled (the worker signs in with
email and password). Also check that
`select raw_app_meta_data from auth.users where email = 'fantasy-renderer@renderer.invalid'`
shows `"fantasy_renderer": true`.

### 3. Prepare the host (once)

1. Check that there's room:

   ```sh
   ssh "$WORKER" 'free -h; df -h /var/lib/docker; docker stats --no-stream'
   ```

2. Write the worker's credentials. The file stays on the host, readable by root only.

   ```sh
   ssh "$WORKER" 'mkdir -p /opt/fantasy-renderer && umask 077 && cat > /opt/fantasy-renderer/worker.env' <<'EOF'
   SUPABASE_URL=https://bvnlepwccygdkgsezgka.supabase.co
   SUPABASE_PUBLISHABLE_KEY=<the publishable key the app ships with>
   FANTASY_RENDERER_EMAIL=fantasy-renderer@renderer.invalid
   FANTASY_RENDERER_PASSWORD=<the password from step 2>
   EOF
   ```

3. Name the Supabase host for the egress proxy, the worker's only way out (see
   [Isolation](../supabase/fantasy-renderer/README.md#isolation)). `ship.sh` keeps this line
   when it writes the image tag.

   ```sh
   ssh "$WORKER" 'echo FANTASY_SUPABASE_HOST=bvnlepwccygdkgsezgka.supabase.co >> /opt/fantasy-renderer/.env'
   ```

### 4. Ship the worker image

```sh
supabase/fantasy-renderer/deploy/ship.sh "$WORKER"
```

The script does the following:

- Builds the image from the committed renderer folder, tagged with the commit.
- Copies it over ssh with `docker save | docker load`. It's about 1 GB compressed, sent over
  the LAN.
- Installs `compose.yaml` and writes the tag to `/opt/fantasy-renderer/.env`.
- Starts nothing.

The image goes over ssh rather than through a registry or a build on the host, for these
reasons:

- No registry is set up.
- The Playwright base image is on mcr.microsoft.com, which the host isn't known to reach.
- A build on the host would compete with the other stacks for minutes.
- The host runs exactly the image tested here. Its Chromium is pinned by digest, and a
  container's tiles were byte-identical to tiles painted outside Docker.

### 5. Start the worker

```sh
ssh "$WORKER" 'cd /opt/fantasy-renderer && docker compose up -d && sleep 70 && docker compose ps'
ssh "$WORKER" 'cd /opt/fantasy-renderer && docker compose exec -T worker node src/status.mjs'
```

Check:

- `docker compose ps` shows the worker `(healthy)` and the `egress` proxy running.
- The status prints the database's view and a `worker` heartbeat a few seconds old, in state
  `idle`, with `worker.source.limited` null.
- `docker compose logs --tail 20 worker` names `renderer user fantasy-renderer@…`.
- `docker compose logs --tail 20 egress` shows `listening on 3128, allowing …` with the three
  hosts, and no `refused` lines once the worker signed in.

### 6. Pre-paint the testers' home areas

First, every tester's claimed land plus about 1 km. This runs inside the database; only totals
come out, never a position:

```sh
npx supabase db query --remote --read-only -f supabase/fantasy-renderer/sql/prepaint-territory-count.sql
npx supabase db query --remote -f supabase/fantasy-renderer/sql/prepaint-territory-queue.sql
```

Then, for testers who haven't walked yet, take a point near home and a radius, and print the
estimate first:

```sh
ssh "$WORKER" 'cd /opt/fantasy-renderer && docker compose exec -T worker node src/prepaint.mjs --at 13.4140,52.5005 --radius-km 2'
```

The estimate gives the tile count, the painting time at 2 s per tile, and the storage. A
2 km radius is about 120 to 170 z16 tiles plus 30 to 40 z15 tiles, 4 to 6 minutes and 20 to
30 MB. If the numbers are acceptable, run it again with `--yes`. `--bbox west,south,east,north` works instead of
`--at` and `--radius-km`.

Pre-paint every tester's home area before step 8. It matters more because of the distance
rule: the app only gets tiles painted within 2 km of the player's claimed cells or of the
positions they uploaded in the last 7 days. A new player who hasn't walked yet gets
painting only in pre-painted areas, and around themselves once their first walk is
uploaded.

Ground nobody has painted yet took about
25 s to fill a phone screen with one painter on a fast desktop, and will take longer on the
host. The first tile of a new area takes 4 to 17 s there (countryside to Manhattan), the ones
next to it about 1 s. Painted ground loads in well under a second.

Both ways only queue tiles; the worker paints them. Never paint tiles on another machine and
upload them: every tile must come from the worker's frozen source data, or tiles painted
elsewhere can disagree with their neighbours at the edges.

Check: run `src/status.mjs` until `queue.queued` is 0 and `last_error` is null.

### 7. Switch the map on

```sql
update public.fantasy_config set enabled = true;
```

### 8. Publish the OTA update

From `mobile/` on `main`:

```sh
npx expo-updates fingerprint:generate --platform android | python3 -c 'import sys, json; print(json.load(sys.stdin)["hash"])'   # expect 9a7d01507a267455935fb24f0ba772cc5f474935
npm run update:preview -- "Fantasy map for testers"
```

If the fingerprint differs, stop: something native changed, and the update wouldn't reach the
installed builds. The iOS fingerprint is `290857d25ef8e4ef500d44c44b43105e4625b2e4`.

### 9. Check on a phone

1. Open the app, close it and open it again: the update applies on the next launch.
2. At walking zoom, the painted map shows under the Mist and territory. New ground near your
   own territory or recent walks fills in a few seconds after the "Painting the map…" pill
   appears. Ground farther away shows the street map unless it was pre-painted.
3. **Debug > Fantasy map** switches it off and on.
4. On the server, `src/status.mjs` shows `players_today` counting up.

## Watch it

| What | How |
| --- | --- |
| Queue, tiles painted, storage, last error, requests today | `ssh "$WORKER" 'cd /opt/fantasy-renderer && docker compose exec -T worker node src/status.mjs'`, or `select jsonb_pretty(public.fantasy_status());` in the SQL editor |
| Global use and queue depth against their limits | The status's `limits`: `global_today` of `global_daily_tiles`, `queue_depth` of `max_queue_depth` (cost units) |
| Frozen source store, fetches today, free disk | The status's `worker.source`: `mb` of `maxMb`, `fetchesToday` of `maxFetchesPerDay`, `diskFreeMb`. `limited` is set when a limit stopped new areas. Also `ssh "$WORKER" 'df -h /var/lib/docker'` |
| Worker health | `docker compose ps` (the health check fails when the heartbeat is older than 3 minutes; its output also prints the source store and `LIMITED`) |
| Worker log | `docker compose logs --tail 100 worker` (rotated: 5 files of 10 MB) |
| Egress refusals | `docker compose logs --tail 100 egress` (`refused …` lines: anything the worker tried to reach outside the allow list) |
| Tiles given up | The status's `queue.failed_given_up` (see [Failed tiles](#failed-tiles)) |
| Storage used by tiles | SQL: `select pg_size_pretty(sum((metadata->>'size')::bigint)) from storage.objects where bucket_id = 'fantasy-tiles';` |
| Plan, storage and egress against quotas | Dashboard: **Organization settings > Usage**, filtered to **Local Legend App**. It shows storage size and cached and uncached egress for the billing period. **Organization settings > Billing** shows the plan. |

## Roll back

Run these in order, and stop as soon as the problem is gone.

1. **Kill switch.** No app update is needed. The app hides the layer at its next
   configuration check (app start or return to the foreground), and the server queues nothing
   more:

   ```sql
   update public.fantasy_config set enabled = false;
   ```

2. **Stop the worker.** This keeps the image, the configuration and the source volume:

   ```sh
   ssh "$WORKER" 'cd /opt/fantasy-renderer && docker compose stop'
   ```

   Never run `docker compose down -v`. It deletes the frozen source data (see
   [Repaint after a painter change](#repaint-after-a-painter-change)).

3. **Go back to the previous worker image** if a new image misbehaves. `ship.sh` saved the
   previous tag:

   ```sh
   ssh "$WORKER" 'cd /opt/fantasy-renderer && cp .env.previous .env && docker compose up -d'
   ```

4. **Take the app code back** only if the app itself misbehaves with the map switched off.
   Republish the previous `preview` update:

   ```sh
   npx eas-cli@latest update:list --branch preview      # find the update group before the fantasy map
   npx eas-cli@latest update:republish --group <that group id>
   ```

5. **The migrations stay.** With the kill switch off, the tables, functions and bucket do
   nothing, and the painted tiles can be reused later. To remove everything, do the following.
   Back up first if the tiles should be kept.

   ```sql
   drop policy "fantasy renderer reads tiles" on storage.objects;
   drop policy "fantasy renderer writes tiles" on storage.objects;
   drop policy "fantasy renderer replaces tiles" on storage.objects;
   drop function public.request_fantasy_tiles(jsonb, int), public.get_fantasy_config(),
     public.lease_fantasy_tiles(int), public.finish_fantasy_tile(int, int, int, int, boolean, int, int, text),
     public.queue_fantasy_tiles(jsonb, boolean), public.fantasy_status(), public.is_fantasy_renderer(),
     private.fantasy_z16(float8, float8);
   drop table public.fantasy_tiles, public.fantasy_requests, public.fantasy_daily, public.fantasy_config;
   ```

   Then delete the tiles and the bucket through Storage itself: in the Dashboard, go to
   **Storage > fantasy-tiles > Empty bucket**, then **Delete bucket** (or use the Storage
   API). Don't delete rows of `storage.objects` in SQL: Storage's `protect_delete` trigger
   refuses it, and even where a delete got through, the files would stay in the object store,
   still stored and billed, with nothing pointing at them. Delete the renderer user under
   **Authentication > Users**. To keep the migration history consistent, also add a migration
   with the same statements.

## Failed tiles

A tile that fails is retried after `retry_after` (10 minutes). After `max_attempts` (3)
failures it's given up, and the app shows the street map there. A given-up tile is leased
again by itself after `failed_cooldown` (1 day). To retry every given-up tile of the current
version now, for example after fixing the cause:

```sql
update public.fantasy_tiles
set status = 'queued', attempts = 0, lease_until = null
where status = 'failed' and version = (select version from public.fantasy_config);
```

A tile that failed with `not painted, needs new source data` was stopped by a source limit
(see [Watch it](#watch-it)). It's retried the same way once the limit allows it again:
fetches reset at midnight UTC, and the size limit needs a larger `SOURCE_MAX_MB` or more
disk.

## Revoke the renderer

The renderer's rights come from its access token, which stays valid until it expires (one
project's JWT expiry, one hour by default), even after the flag is removed or the password changes. To cut
it off at once, stop the worker first, then revoke:

1. Stop the worker: `ssh "$WORKER" 'cd /opt/fantasy-renderer && docker compose stop'`.
2. In the SQL editor, remove the flag and end the user's sessions, so its refresh token stops
   working too:

   ```sql
   update auth.users set raw_app_meta_data = raw_app_meta_data - 'fantasy_renderer'
   where email = 'fantasy-renderer@renderer.invalid';
   delete from auth.sessions
   where user_id = (select id from auth.users where email = 'fantasy-renderer@renderer.invalid');
   ```

   Or delete the user under **Authentication > Users**.

A token issued before this keeps working until it expires, unless the worker that holds it
is stopped. Any copy of the token outside the worker would have to have leaked from the host.

## Repaint after a painter change

A new painter, new art or a new Chromium build paints different pixels. The image pins
Chromium; when it changes (a new Playwright version or base image), treat it like a
painter change. After `scripts/sync-prototype.mjs`,
`npm test` and shipping the new worker image (steps 4 and 5), start a new tile set:

```sql
update public.fantasy_config set version = version + 1;
```

The app picks up the new version at its next configuration check and requests tiles at the
new paths. Pre-paint the testers' areas again (step 6). Old versions stay in Storage until
you delete the folder `v<old version>` under **Storage > fantasy-tiles**.

Keep the source volume (`fantasy-renderer-source`) across painter changes. It's the map data
the tiles were painted from. Delete it only together with a version bump, and only if map
changes should come in.

## Starting values and what they cost

The migrations set these launch values (November 26, 2026), with the map switched off:

| Setting | Value | Why |
| --- | --- | --- |
| `webp_quality` | 0.75 | Looks the same as 0.8 at twice the pixel size, 20% smaller |
| `daily_tiles_per_player` | 300 units | Bounds one player who pans across the world |
| `global_daily_tiles` | 2000 units | About 5 testers exploring use about 150 units a day each, 750 together: 2.5 times headroom, and at most about 67 minutes of worker time a day |
| `max_queue_depth` | 500 units | About 17 minutes of work at 2 s per tile. A deeper queue only means tiles painted long after the player has walked on |
| `near_player_m` | 2000 m | A screen and its ring at walking zoom fit well inside it |

All limits count cost units: a z16 tile is 1 unit, a z15 tile 5 (its four z16 children
plus itself). Pre-painting (`queue_fantasy_tiles`) doesn't count against the player and
global limits, so you can pre-paint more than 2000 tiles in a day. Change any value in the SQL
editor, for example `update public.fantasy_config set global_daily_tiles = 3000;`.

These were measured on 27 z16 tiles in Berlin, Manhattan and Innsbruck:

| `webp_quality` | Mean z16 tile |
| --- | --- |
| 0.7 | 131 KB |
| 0.75 | 143 KB |
| 0.8 | 180 KB |

At twice the pixel size, 0.75 and 0.8 look the same. A z15 tile is about 15% larger than a
z16 tile.

How the costs work out:

- **A tile is paid for once.** It's painted, stored and served from the CDN for everyone,
  and each phone keeps it in its 200 MB MapLibre cache. A tester walking new streets needs
  roughly 15 new tiles per km, and a first visit to an area asks for about 30.
- **The limits bound the worst case**, in units (z15 costs 5 units for about 5 tiles' worth
  of storage and painting, so a unit is about one z16 tile either way):

  | Limit | Units a day | New storage | Worker time at 2 s per unit |
  | --- | --- | --- | --- |
  | One player (`daily_tiles_per_player`) | 300 | about 42 MB | about 10 minutes |
  | Everyone (`global_daily_tiles`) | 2000 | about 280 MB | about 67 minutes |

  Walking never comes near the player limit. The distance rule keeps a player from spending
  it far from their own ground.
- **Storage for 10 testers:** pre-painted home areas of 20 to 30 MB each (2 km radius), plus about 25 MB a
  day each while they explore. That's roughly 2 to 4 GB in the first month, then slower
  growth as home areas fill in.
  - Free (1 GB) runs out within one to two weeks, whatever the values.
  - Pro (100 GB included, then $0.0213 per GB) doesn't notice it.
- **Egress for 10 testers:** about 200 tile loads a day each at 143 KB is roughly 9 GB a
  month of cached egress.
  - Free includes 5 GB.
  - Pro includes 250 GB, then $0.03 per GB.
- **Worker time** is the host's own: the global limit caps it at about 67 minutes a day,
  plus pre-painting.
- **Host disk:** the frozen source store stops at 8 GB (`SOURCE_MAX_MB`), and upstream
  fetches at 20,000 a day (`SOURCE_FETCHES_PER_DAY`).

On Pro, these values cost nothing extra at tester scale. On Free, storage runs out within
weeks whatever the values. The fantasy map needs Pro beyond a short test.

## Secrets

| Secret | Where | Rights |
| --- | --- | --- |
| Renderer user password | `/opt/fantasy-renderer/worker.env` on the worker host (mode 600) and your password manager | Lease, finish and queue fantasy tiles; read their status; write the `fantasy-tiles` bucket. Players can't gain these: the flag is in `app_metadata`, which only the service role can set. |
| Publishable key | Same file | Public; the app ships with it |

The service key is not needed anywhere in this deployment. To rotate the password, set a
new one under **Authentication > Users**, update `worker.env`, then run
`docker compose up -d`. A new password doesn't end tokens already issued; to cut the renderer
off, see [Revoke the renderer](#revoke-the-renderer).
