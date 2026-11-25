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
logs. It runs one painter, which measured about 1.8 GB at its peak on dense Berlin at those limits.

## Go live

Run these in order. Each step says what to check before you go on.

### 1. Apply the migrations

From the repository root:

```sh
npx supabase db push --dry-run   # lists exactly the two fantasy migrations
npx supabase db push
```

Then, in the Supabase Dashboard SQL editor, set the starting values with the map still
switched off:

```sql
update public.fantasy_config set enabled = false, webp_quality = 0.75, daily_tiles_per_player = 600;
select jsonb_pretty(public.fantasy_status());
```

Check: the status shows `"enabled": false`, the queue at 0, and `"version": 1`. Version 1
is the final painter: no tiles were ever published before it.

### 2. Create the renderer user

The worker doesn't use the service key. It signs in as one auth user flagged
`fantasy_renderer`. That user can only:

- Lease, finish and queue fantasy tiles.
- Read their status.
- Write the `fantasy-tiles` bucket.

1. Make a password: `openssl rand -base64 33`.
2. In the Dashboard, go to **Authentication > Users > Add user > Create new user**. Enter an
   address you control, such as `fantasy-renderer@<your domain>`, and the password. Turn
   **Auto Confirm User** on.
3. In the SQL editor:

   ```sql
   update auth.users
   set raw_app_meta_data = raw_app_meta_data || '{"fantasy_renderer": true}'
   where email = 'fantasy-renderer@<your domain>';
   ```

Check: **Authentication > Sign In / Providers > Email** is enabled (the worker signs in with
email and password). Also check that
`select raw_app_meta_data from auth.users where email = '…'` shows `"fantasy_renderer": true`.

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
   FANTASY_RENDERER_EMAIL=fantasy-renderer@<your domain>
   FANTASY_RENDERER_PASSWORD=<the password from step 2>
   EOF
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

- `docker compose ps` shows `(healthy)`.
- The status prints the database's view and a `worker` heartbeat a few seconds old, in state
  `idle`.
- `docker compose logs --tail 20 worker` names `renderer user fantasy-renderer@…`.

### 6. Pre-paint the testers' home areas

For each tester, take a point near home and a radius, and print the estimate first:

```sh
ssh "$WORKER" 'cd /opt/fantasy-renderer && docker compose exec -T worker node src/prepaint.mjs --at 13.4140,52.5005 --radius-km 2'
```

The estimate gives the tile count, the painting time at 1.5 s per tile, and the storage. A
2 km radius is about 120 to 170 z16 tiles plus 30 to 40 z15 tiles, 3 to 5 minutes and 15 to
25 MB. If the numbers are acceptable, run it again with `--yes`. `--bbox west,south,east,north` works instead of
`--at` and `--radius-km`.

Pre-paint every tester's home area before step 8. Ground nobody has painted yet takes about
13 s to fill a phone screen with one painter (the first tile of a new area takes 6 to 10 s);
painted ground loads in well under a second.

Run pre-painting on the worker host only. Every tile must come from the worker's frozen
source data, or tiles painted elsewhere can disagree with their neighbours at the edges.

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
2. At walking zoom, the painted map shows under the Mist and territory. New ground fills in a
   few seconds after the "Painting the map…" pill appears.
3. **Debug > Fantasy map** switches it off and on.
4. On the server, `src/status.mjs` shows `players_today` counting up.

## Watch it

| What | How |
| --- | --- |
| Queue, tiles painted, storage, last error, requests today | `ssh "$WORKER" 'cd /opt/fantasy-renderer && docker compose exec -T worker node src/status.mjs'`, or `select jsonb_pretty(public.fantasy_status());` in the SQL editor |
| Worker health | `docker compose ps` (the health check fails when the heartbeat is older than 3 minutes) |
| Worker log | `docker compose logs --tail 100 worker` (rotated: 5 files of 10 MB) |
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
     public.queue_fantasy_tiles(jsonb, boolean), public.fantasy_status(), public.is_fantasy_renderer();
   drop table public.fantasy_tiles, public.fantasy_requests, public.fantasy_config;
   ```

   Then, in the Dashboard, go to **Storage > fantasy-tiles > Empty bucket**, then
   **Delete bucket**. Storage refuses deletes made in SQL. Delete the renderer user under
   **Authentication > Users**. To keep the migration history consistent, also add a migration
   with the same statements.

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

These are the values to start testers on:

| Plan | `webp_quality` | `daily_tiles_per_player` |
| --- | --- | --- |
| Pro | 0.75 | 600 |
| Free | 0.7 | 300 |

These were measured on 27 z16 tiles in Berlin, Manhattan and Innsbruck:

| `webp_quality` | Mean z16 tile |
| --- | --- |
| 0.7 | 109 KB |
| 0.75 | 118 KB |
| 0.8 | 149 KB |

At twice the pixel size, 0.75 and 0.8 look the same. A z15 tile is about 25% larger than a
z16 tile.

How the costs work out:

- **A tile is paid for once.** It's painted, stored and served from the CDN for everyone,
  and each phone keeps it in its 200 MB MapLibre cache. A tester walking new streets needs
  roughly 15 new tiles per km, and a first visit to an area asks for about 30.
- **The daily cap bounds a player who pans across the world.** At 600 tiles that's at most
  71 MB of new storage and 15 minutes of worker time per player per day. Walking never comes
  near it.
- **Storage for 10 testers:** pre-painted home areas of 15 to 25 MB each (2 km radius), plus about 20 MB a
  day each while they explore. That's roughly 1.5 to 3 GB in the first month, then slower
  growth as home areas fill in.
  - Free (1 GB) runs out within one to two weeks, whatever the values.
  - Pro (100 GB included, then $0.0213 per GB) doesn't notice it.
- **Egress for 10 testers:** about 200 tile loads a day each at 118 KB is roughly 7 GB a
  month of cached egress.
  - Free includes 5 GB.
  - Pro includes 250 GB, then $0.03 per GB.
- **Worker time** is the host's own: 600 new tiles take about 15 minutes at 1.5 s each.

On Pro, 0.75 and 600 cost nothing extra at tester scale. On Free, 0.7 and 300 stretch the
quotas, but storage still runs out within weeks. The fantasy map needs Pro beyond a short
test.

## Secrets

| Secret | Where | Rights |
| --- | --- | --- |
| Renderer user password | `/opt/fantasy-renderer/worker.env` on the worker host (mode 600) and your password manager | Lease, finish and queue fantasy tiles; read their status; write the `fantasy-tiles` bucket. Players can't gain these: the flag is in `app_metadata`, which only the service role can set. |
| Publishable key | Same file | Public; the app ships with it |

The service key is not needed anywhere in this deployment. To rotate the password, set a
new one under **Authentication > Users**, update `worker.env`, then run
`docker compose up -d`.
