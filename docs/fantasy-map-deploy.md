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

First, the size of the largest territory. A tile request reads the caller's whole territory
once; at 50,000 cells it took about 40 ms in tests.

```sh
npx supabase db query --remote --read-only "select max(n) from (select count(*) n from public.claimed_cells group by user_id) s"
```

Then, from the repository root:

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
worker. Its password is made on the worker host and never leaves it.

1. On the host, write the worker's credentials with a new password. The file is readable by
   root only, and the command refuses to overwrite an existing one.

   ```sh
   ssh "$WORKER" 'mkdir -p /opt/fantasy-renderer && cd /opt/fantasy-renderer && umask 077 && test ! -e worker.env && {
     echo SUPABASE_URL=https://bvnlepwccygdkgsezgka.supabase.co
     echo SUPABASE_PUBLISHABLE_KEY=<the publishable key the app ships with>
     echo FANTASY_RENDERER_EMAIL=fantasy-renderer@renderer.invalid
     echo FANTASY_RENDERER_PASSWORD=$(openssl rand -base64 48 | tr -dc A-Za-z0-9 | head -c 40)
   } > worker.env && echo written'
   ```

2. Create the user with one call to the auth admin API, the call behind the Dashboard's
   **Create new user** with **Auto Confirm User**: confirmed, with the flag in
   `app_metadata`. A plain sign-up doesn't work: the hosted project refuses `.invalid`
   addresses there (`email_address_invalid`); the admin API accepts them.

   The call needs the project's secret key once. It's fetched with the signed-in Supabase
   CLI into a shell variable, handed to curl as headers through a file descriptor (never on
   a command line, so not in the process list), and unset afterwards. It's never printed,
   stored, or sent to the worker host. The password streams from the host's `worker.env`
   over ssh straight into the request body, so it never touches this machine's disk or
   output.

   ```sh
   (
     SK=$(npx supabase projects api-keys --remote --reveal -o json 2>/dev/null | python3 -c 'import sys, json; print(next(k["api_key"] for k in json.load(sys.stdin) if k["type"] == "secret"), end="")')
     ssh "$WORKER" 'cd /opt/fantasy-renderer && . ./worker.env && printf "{\"email\":\"%s\",\"password\":\"%s\",\"email_confirm\":true,\"app_metadata\":{\"fantasy_renderer\":true}}" "$FANTASY_RENDERER_EMAIL" "$FANTASY_RENDERER_PASSWORD"' \
       | curl -sS -o /dev/null -w '%{http_code}\n' -X POST https://bvnlepwccygdkgsezgka.supabase.co/auth/v1/admin/users \
           -H @<(printf 'apikey: %s\nAuthorization: Bearer %s\ncontent-type: application/json\n' "$SK" "$SK") --data-binary @-
     unset SK
   )
   ```

   Expect `200`. If the admin API refuses the address too, stop: remove `worker.env` and let
   the owner choose an address. Never insert into the auth tables directly.

3. Check from the host that the renderer signs in with the publishable key and is flagged.
   This prints `true`:

   ```sh
   ssh "$WORKER" 'cd /opt/fantasy-renderer && . ./worker.env &&
     TOK=$(printf "{\"email\":\"%s\",\"password\":\"%s\"}" "$FANTASY_RENDERER_EMAIL" "$FANTASY_RENDERER_PASSWORD" |
       curl -sS -X POST "$SUPABASE_URL/auth/v1/token?grant_type=password" -H "apikey: $SUPABASE_PUBLISHABLE_KEY" -H "content-type: application/json" --data-binary @- |
       python3 -c "import sys, json; print(json.load(sys.stdin)[\"access_token\"])") &&
     curl -sS -X POST "$SUPABASE_URL/rest/v1/rpc/is_fantasy_renderer" -H "apikey: $SUPABASE_PUBLISHABLE_KEY" -H "authorization: Bearer $TOK" -H "content-type: application/json" -d "{}"'
   ```

   An ordinary sign-up can't gain the flag: it lands in `user_metadata`, which
   `is_fantasy_renderer()` ignores (checked on November 26, 2026 with a throwaway anonymous
   user, deleted afterwards).

Check: **Authentication > Sign In / Providers > Email** is enabled (the worker signs in with
email and password), and
`select count(*) from auth.users where raw_app_meta_data ? 'fantasy_renderer'` is 1.

To undo: `delete from auth.users where email = 'fantasy-renderer@renderer.invalid';` and
remove `/opt/fantasy-renderer/worker.env`.

### 3. Prepare the host (once)

1. Look at what runs there and check that there's room. Stop if less than about 4 GB of
   memory is available (the worker may use 3 GB) or the Docker disk has less than 10 GB free.

   ```sh
   ssh "$WORKER" 'docker version --format "{{.Server.Version}}"; free -h; df -h /var/lib/docker; uptime; docker ps --format "{{.Names}}\t{{.Status}}"; docker stats --no-stream'
   ```

2. Check that Docker is 28.0 or later. The worker's network relies on it to keep the worker
   away from services on the host itself (see
   [Isolation](../supabase/fantasy-renderer/README.md#isolation)). On an older Docker, update
   it, or block the network's bridge in the host firewall instead, on the host after step 5:

   ```sh
   BR=br-$(docker network inspect fantasy-renderer_inside --format '{{.Id}}' | cut -c1-12)
   iptables -I INPUT -i "$BR" -j DROP && ip6tables -I INPUT -i "$BR" -j DROP
   ```

   Make the rule survive reboots the way the host keeps its other firewall rules.

3. Name the Supabase host for the egress proxy, the worker's only way out. `ship.sh` keeps
   this line when it writes the image tag.

   ```sh
   ssh "$WORKER" 'echo FANTASY_SUPABASE_HOST=bvnlepwccygdkgsezgka.supabase.co >> /opt/fantasy-renderer/.env'
   ```

### 4. Ship the worker image

Once automatic releases are set up, this step is what a merge to `main` does (see
[Releases](#releases)). By hand:

```sh
supabase/fantasy-renderer/deploy/ship.sh "$WORKER"
```

The script does the following:

- Builds the image from the committed renderer folder, tagged with the commit.
- Copies it over ssh with `docker save | docker load`. It's about 1 GB compressed, sent over
  the LAN.
- Installs `compose.yaml` and writes the image name to `/opt/fantasy-renderer/.env`.
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
- The egress check passes. Give it the host's own LAN address, so it checks that too (the
  address stays in your terminal):

  ```sh
  ssh "$WORKER" 'cd /opt/fantasy-renderer && docker compose exec -T worker node src/egress-check.mjs "$(hostname -I | cut -d" " -f1):22"'
  ```

- The host's other stacks are unaffected: `docker ps` shows them as before, and `uptime`
  shows a normal load.

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

The estimate gives the tile count, the painting time at 4 s per tile (measured on the worker
host), and the storage. A 2 km radius is about 120 to 170 z16 tiles plus 30 to 40 z15 tiles,
8 to 12 minutes and 20 to
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
   [Releases](#releases)).

3. **Go back to the previous worker image** if a new image misbehaves: run the "Fantasy
   renderer rollback" workflow (see [Releases](#releases)). Without Coolify, `ship.sh` saved
   the previous image (never one from before the release mechanism, see
   [Without Coolify](#without-coolify)):

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
   drop policy "fantasy renderer deletes replaced versions" on storage.objects;
   drop function public.request_fantasy_tiles(jsonb, int), public.get_fantasy_config(),
     public.lease_fantasy_tiles(int, text), public.finish_fantasy_tile(int, int, int, int, boolean, int, int, text),
     public.queue_fantasy_tiles(jsonb, boolean), public.fantasy_status(), public.is_fantasy_renderer(),
     public.begin_fantasy_release(text), public.advance_fantasy_release(), public.fantasy_object_deletable(text),
     public.fantasy_cleanup_candidates(int), public.fantasy_forget_versions(),
     private.fantasy_z16(float8, float8), private.fantasy_queue_known(int, smallint), private.fantasy_deletable_versions();
   drop table public.fantasy_tiles, public.fantasy_requests, public.fantasy_daily, public.fantasy_versions, public.fantasy_config;
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

## Releases

Once automatic releases are set up ([Set up automatic releases](#set-up-automatic-releases-once)),
a merge to `main` that touches the renderer releases it with nobody running anything:

1. GitHub Actions runs the tests, builds the image, paints the golden tiles in it, and pushes it
   to `ghcr.io/process-roman/local-legend-fantasy-renderer` as `sha-<commit>`.
2. It attests the image's build provenance and points the `fantasy-renderer-deploy` branch at
   the image's **digest**. That branch holds the compose file with the image pinned by digest,
   the egress proxy script, `RELEASE.json` (what's deployed) and `releases.ndjson` (every
   release). No deploy ever goes through a tag, so a moved tag changes nothing.
3. It calls Coolify's deploy webhook. Coolify deploys the branch: it pulls the pinned image and
   restarts the stack. The source volume, the credentials file and the isolated network stay.
4. The worker reports its painter fingerprint at start-up:
   - **Same as the live version:** it carries on.
   - **New:** it paints the next tile version in the background for every known area, and
     phones switch when it's done. The switch is held while the staged version has no painted
     tile, or more tiles were given up than `release_max_given_up` (10) and
     `release_max_given_up_share` (1%) allow.
   - **An earlier version whose tiles are all still there:** phones switch back at once, and
     what they viewed on the version being left is queued behind players' own requests.
5. Replaced versions are deleted after `version_grace` (7 days). A version is marked before its
   first file goes, and is never rolled back to after that; its painter gets a fresh version.

Each version keeps the WebP quality it started with: a change of `webp_quality` applies from the
next release on.

### Watch a release

`node src/status.mjs`, or `select jsonb_pretty(public.fantasy_status());`:

- `staging`: the version being painted, `remaining`, `ready`, `given_up`, and `blocked` with a
  `reason` when the switch is held.
- `versions`: every version with its fingerprint, quality, and when it was released, retired and
  purged.

A release of the testers' areas (about 450 tiles) takes about half an hour at 4 s per tile.

**A held release** (`blocked: true`) means the new painter failed too many tiles: phones stay on
the live version. Look at `last_error` and the worker log, fix the cause on `main`, and merge
again. Or deploy the live painter again (the rollback workflow with the live version's
digest): that abandons the release.

### Roll back

1. In GitHub, go to **Actions > Fantasy renderer rollback > Run workflow** on `main`, with the
   digest to go back to. Digests are in `RELEASE.json` and `releases.ndjson` on the
   `fantasy-renderer-deploy` branch. The workflow accepts only a digest that a release run
   recorded and whose build provenance proves the release workflow built it on `main`.
2. Phones are back on that painter's tile version as soon as the worker starts, if its tiles are
   all still there. Otherwise its painter's version is painted again.
3. **Revert the bad commit on `main` right away.** The next merge that touches the renderer, its
   migrations or its tests releases `main` again, bad commit included.

### Without Coolify

When Coolify is down or not set up yet: `supabase/fantasy-renderer/deploy/ship.sh "$WORKER"`
builds and copies an image over ssh, then `docker compose up -d` on the host starts it. Build it
from a commit that has this release mechanism. **Never start an image from before it (the
pre-cut-over `.env.previous`) after the fingerprint is recorded:** the database refuses its
leases, because it can't tell its tiles apart.

### Fresh map data

Keep the source volume (`fantasy-renderer-source`) across releases: it's the map data the tiles
were painted from. Deleting it lets map changes in at tile edges. Do it only if map changes
should come in, and then start a new version by hand:

```sql
update public.fantasy_config set version = version + 1, fingerprint = null where id;
```

Then restart the worker, which adopts the new number as its own.

### Follow-up: migrations

CI doesn't apply database migrations. A release whose worker needs a new migration must have
that migration pushed (`npx supabase db push`) before it's merged. Applying migrations from CI
is a follow-up.

## Set up automatic releases (once)

These steps wire GitHub to the owner's Coolify (version 4.5.3). Do them in this order: A, B,
D1 to D8, then C, then D9 and D10. Step C stops the running worker's painting until D9 starts the
new one, so keep them minutes apart. Each step says what to check before you go on. They were checked against GitHub's documentation, Coolify's
documentation and Coolify's 4.5.3 source on November 26, 2026, and reviewed independently.

**Why Coolify's raw mode.** A normal Coolify Docker Compose resource adds every service to every
network in the file and to a bridge network of its own, and hands every variable to every
container. The worker would get a route round the egress proxy, and the proxy the renderer's
password. Raw mode ("deploy file as-is") runs the compose file unchanged; Coolify then only
pulls the images and runs `docker compose up`.

**Trade-offs to accept first.** Coolify always starts its `coolify-sentinel` container on a
server it manages, with the Docker socket, the host's process namespace and a restart policy;
with root SSH that gives the Coolify instance root on the worker host, which is shared with the
analytics and Windmill stacks. Coolify's deploy token (step D10) is broader than its name: on
4.5.3 it can stop, start and restart every application, database and service of its team,
restart any server's proxy, run application rollbacks and deploy previews. Keep the worker host
and this application in a Coolify team of their own, so a leaked token reaches nothing else.

### A. GitHub settings (repository admin)

Who may release is the owner's decision (required reviewers in step A3). Everything else here is
needed either way.

1. **Settings > Actions > General:** keep **Workflow permissions** at **Read repository contents
   and packages permissions**. Under **Fork pull request workflows from outside collaborators**,
   choose **Require approval for all outside collaborators**.
2. **Settings > Rules > Rulesets > New branch ruleset**, named `main`:
   - Enforcement: **Active**. Target: the default branch.
   - **Restrict deletions**, **Block force pushes**, and **Require a pull request before merging**
     (with **Required approvals: 1** if the owner wants a second person on every change).
   - Bypass list: empty.
3. **Settings > Environments > New environment** `fantasy-release`:
   - **Deployment branches and tags:** **Selected branches and tags**, add `main`.
   - **Required reviewers:** the owner's decision. With reviewers, tick **Prevent self-review**
     and untick **Allow administrators to bypass configured protection rules**.
4. **The package token.** Create a classic personal access token on the account that owns the
   repository (**Settings > Developer settings > Personal access tokens > Tokens (classic)**)
   with only **write:packages** ticked (untick **repo**, which GitHub ticks with it) and an
   expiry. GitHub's registry accepts no fine-grained or GitHub App token. Save it as the
   `fantasy-release` environment secret `FANTASY_PACKAGES_TOKEN`. It acts as that account, so
   rotate it before it expires.
5. **The deploy key.** `ssh-keygen -t ed25519 -N '' -C fantasy-renderer-deploy -f deploy_key`.
   Add `deploy_key.pub` under **Settings > Deploy keys** with **Allow write access**. Save
   `deploy_key` as the environment secret `FANTASY_DEPLOY_KEY`, then delete both files.
6. **Settings > Rules > Rulesets > New branch ruleset**, named `fantasy-renderer-deploy`:
   - Target: branch name `fantasy-renderer-deploy`.
   - **Restrict creations**, **Restrict updates**, **Restrict deletions**, **Block force pushes**.
   - Bypass list: **Deploy keys**. Only the environment's key can then move the branch.
7. Merge the pull request. The release run builds, pushes the first image with the package
   token, attests it and creates the `fantasy-renderer-deploy` branch. Without the Coolify
   secrets it stops there with a notice.
8. Under the repository's **Packages > local-legend-fantasy-renderer > Package settings**:
   - **Change visibility** to public: the worker host pulls it without a login, and it holds
     nothing that isn't in this public repository.
   - **Manage Actions access:** turn off **Inherit access from source repository** and set this
     repository's role to **Read** (or remove it). Then no workflow's `GITHUB_TOKEN`, on any
     branch, can push; only the environment's token can.
   - Check: a test push from a workflow on another branch fails with 403.

### B. The worker host

1. As `root` over ssh, check that Docker is complete, so Coolify's validation won't reinstall it
   or restart the Docker service (which would restart every stack on the host):

   ```sh
   ssh "$WORKER" 'command -v docker && docker version && docker compose version'
   ```

   All three must succeed. Then validation only creates a `coolify` Docker network.

2. Check that ports 80, 443 and 8080 are free, in case Coolify's proxy starts after all:

   ```sh
   ssh "$WORKER" "ss -ltnp '( sport = :80 or sport = :443 or sport = :8080 )'"
   ```

### C. The database (cut-over step one)

1. Check that the painter the live tiles were painted with is the one in `main`: run the golden
   tiles with the live image's commit (the tag in `/opt/fantasy-renderer/.env`) and compare
   them with `supabase/fantasy-renderer/test/golden.json`. On November 26, 2026 the live commit
   `9f70638` painted them identically. Also check that nothing that can change pixels differs:

   ```sh
   git diff --stat <live commit> main -- supabase/fantasy-renderer/painter supabase/fantasy-renderer/assets \
     supabase/fantasy-renderer/src/page supabase/fantasy-renderer/package-lock.json supabase/fantasy-renderer/Dockerfile
   ```

   Expect no changes (the code moved into `src/paint-output.mjs` and the z15 rules were extracted
   unchanged; the golden tiles prove it).
2. Apply the release migration and record the live painter in the same step, so no worker ever
   "adopts" version 1:

   ```sh
   npx supabase db push    # lists 20261126150000_fantasy_releases.sql
   FP=$(node supabase/fantasy-renderer/src/fingerprint.mjs)
   npx supabase db query --remote "update public.fantasy_config set fingerprint = '$FP' where id"
   npx supabase db query --remote "insert into public.fantasy_versions (version, fingerprint, released_at, webp_quality) select version, fingerprint, now(), webp_quality from public.fantasy_config"
   ```

   From here the running pre-cut-over worker gets no tiles (the database refuses workers without
   a fingerprint). Players' requests queue until the new worker starts in step D9.

### D. Coolify

1. In Coolify, create a team for the worker host (**Teams > Create**) and switch to it.
2. **Keys & Tokens > Private Keys > Generate ED25519**, named for the worker host. Add the public
   key to `root`'s `~/.ssh/authorized_keys` on the worker host, limited to the Coolify host:
   `from="<Coolify host address>" ssh-ed25519 AAAA… coolify`.
3. Under the server settings Coolify applies to every server, check **Docker cleanup** before
   the server exists: Coolify runs it every night at midnight and, forced by default, removes
   every image no container uses (the other stacks' rollback images and the manual fallback
   image) and prunes the build cache. Turn the forced cleanup off for this server as soon as it
   exists (step D5), or set its threshold to 100%, and keep **Delete unused volumes** off.
4. **Servers > New server:** a name for the worker host, its address, port 22, user `root`, the
   key from step 2. **Don't validate yet.**
5. On the new server, open **Proxy** and choose **Switch Proxy > Custom** (Coolify stores this as
   no proxy). Open **Docker cleanup** and apply step 3. Only then click **Validate
   connection**. Check: validated, nothing listens on 80, 443 or 8080, and the host's other
   containers are still running (`docker ps`).
6. In a project of the new team, **New resource > Public Repository**:
   - Repository `https://github.com/process-roman/Local-Legend-`, branch
     `fantasy-renderer-deploy`.
   - Build pack **Docker Compose**, base directory `/`, compose file `/compose.yaml`.
   - Destination: the worker host.
7. In the new application:
   - **Advanced > Compose deployment: Raw (deploy file as-is)** on.
   - **Connect to predefined network** off.
   - **Auto deploy** off: deploys come from GitHub after a release run, never from a bare push.
   - No domain on either service.
8. **Environment Variables:** add `FANTASY_SUPABASE_HOST` = `bvnlepwccygdkgsezgka.supabase.co`.
   Nothing else: the worker's credentials stay in `/opt/fantasy-renderer/worker.env` on the
   host, which the compose file reads by absolute path, so the password never enters Coolify.
9. **Deploy** once from Coolify, and check (next section). The compose file keeps the project
   name `fantasy-renderer`, so this replaces the manually started containers in place, with the
   same volume and network names.
10. **Webhooks:** copy **Deploy Webhook (auth required)**
    (`https://<coolify>/api/v1/deploy?uuid=<application uuid>&force=false`). Under **Keys &
    Tokens > API tokens** (still in the new team), create a token. The form starts with
    **read** ticked: untick it so only **deploy** is ticked. Save both as the `fantasy-release`
    environment secrets `COOLIFY_DEPLOY_URL` and `COOLIFY_DEPLOY_TOKEN`.

From the next merge on, releases are automatic.

### Check a deploy

After the first Coolify deploy, and whenever something changes in the setup:

```sh
ssh "$WORKER" 'docker ps --format "{{.Names}}\t{{.Image}}\t{{.Status}}" | grep fantasy'
ssh "$WORKER" 'docker inspect fantasy-renderer-worker-1 --format "{{json .NetworkSettings.Networks}}" | python3 -c "import sys, json; print(list(json.load(sys.stdin)))"'
ssh "$WORKER" 'docker exec fantasy-renderer-worker-1 node src/egress-check.mjs "$(hostname -I | cut -d" " -f1):22"'
ssh "$WORKER" 'docker logs --tail 20 fantasy-renderer-worker-1'
```

- The worker runs the image at the digest in `RELEASE.json`, and is `(healthy)`. The egress
  proxy runs `node:24-alpine` at its pinned digest.
- The worker is on `fantasy-renderer_inside` only. Any other network (a Coolify bridge network
  named after the application) means raw mode is off: stop and fix that first.
- The egress check passes.
- The log shows `painter <fingerprint>: current version 1`: the fingerprint recorded in step C2.

### Undo the cut-over

1. In Coolify, stop the application.
2. On the host: `cd /opt/fantasy-renderer && docker compose up -d` with an image built by
   `ship.sh` from a commit that has releases (not the pre-cut-over image, which the database now
   refuses).
3. If a release was staging, abandon it:
   `update public.fantasy_config set staging_version = null, staging_fingerprint = null, staging_started_at = null where id;`
4. If phones were switched, set `version` and `fingerprint` back to the earlier version's row in
   `public.fantasy_versions`.

## Starting values and what they cost

The migrations set these launch values (November 26, 2026), with the map switched off:

| Setting | Value | Why |
| --- | --- | --- |
| `webp_quality` | 0.75 | Looks the same as 0.8 at twice the pixel size, 20% smaller |
| `daily_tiles_per_player` | 300 units | Bounds one player who pans across the world |
| `global_daily_tiles` | 2000 units | About 5 testers exploring use about 150 units a day each, 750 together: 2.5 times headroom, and at most about 2 hours 15 minutes of worker time a day |
| `max_queue_depth` | 500 units | About 33 minutes of work at 4 s per tile. A deeper queue only means tiles painted long after the player has walked on |
| `near_player_m` | 2000 m | A screen and its ring at walking zoom fit well inside it |

All limits count cost units: a z16 tile is 1 unit, a z15 tile 1 plus each of its four z16
children not painted or queued yet (up to 5). Pre-painting (`queue_fantasy_tiles`) doesn't
count against the player and global limits or the queue depth, so you can pre-paint more
than 2000 tiles in a day without blocking players. Change any value in the SQL
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
- **The limits bound the worst case**, in units (z15 costs up to 5 units for up to 5 tiles' worth
  of storage and painting, so a unit is about one z16 tile either way):

  | Limit | Units a day | New storage | Worker time at 4 s per unit |
  | --- | --- | --- | --- |
  | One player (`daily_tiles_per_player`) | 300 | about 42 MB | about 20 minutes |
  | Everyone (`global_daily_tiles`) | 2000 | about 280 MB | about 2 hours 15 minutes |

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
- **Worker time** is the host's own: the global limit caps it at about 2 hours 15 minutes a day,
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

The worker never has the service key. The project's secret key is used once, transiently,
to create the renderer user (step 2), and is stored nowhere. To rotate the password, set a
new one under **Authentication > Users**, update `worker.env`, then run
`docker compose up -d`. A new password doesn't end tokens already issued; to cut the renderer
off, see [Revoke the renderer](#revoke-the-renderer).
