-- pgTAP tests for the fantasy tile queue: defaults, grants, requests near the caller's own
-- ground only, cost in tile units (z15 = 5), the per-player cap, the global daily limit, the
-- queue depth, the rate limit, no queue jumping, the kill switch, input checks, fair leasing,
-- retries and the cool-down for tiles given up, and versions. Parallel calls against the caps
-- are tested in supabase/fantasy-renderer/test/queue.test.mjs (separate connections).
-- Run with: npx supabase test db
begin;

select plan(54);

-- f01..f05: players. f01 and f02 claimed land at Berlin tile 16/35209/21498; f03 has no
-- ground until it submits a position; f05 only an old position.
insert into auth.users (id, aud, role, is_anonymous)
select ('f0000000-0000-0000-0000-0000000000' || lpad(i::text, 2, '0'))::uuid, 'authenticated', 'authenticated', true
from generate_series(1, 5) as i;

create function pg_temp.u(i int) returns uuid language sql immutable as $$
  select ('f0000000-0000-0000-0000-0000000000' || lpad(i::text, 2, '0'))::uuid
$$;

-- The zoom 21 claim cell in the middle of z16 tile (x, y): id = x21 * 2^21 + y21.
create function pg_temp.cell(x int, y int) returns bigint language sql immutable as $$
  select (x::bigint * 32 + 16) * 2097152 + (y::bigint * 32 + 16)
$$;

-- A point in the middle of z16 tile (x, y), as longitude/latitude geometry.
create function pg_temp.point(x int, y int) returns extensions.geometry language sql immutable as $$
  select extensions.st_setsrid(extensions.st_makepoint(
    (x + 0.5) / 65536.0 * 360 - 180,
    degrees(atan(sinh(pi() * (1 - 2 * (y + 0.5) / 65536.0))))), 4326)
$$;

create function pg_temp.as_player(i int) returns void language sql as $$
  select set_config('role', 'authenticated', true),
    set_config('request.jwt.claims', json_build_object('sub', pg_temp.u(i), 'role', 'authenticated')::text, true);
$$;

create function pg_temp.as_service() returns void language sql as $$
  select set_config('role', 'service_role', true),
    set_config('request.jwt.claims', json_build_object('role', 'service_role')::text, true);
$$;

create function pg_temp.as_postgres() returns void language sql as $$
  select set_config('role', 'postgres', true), set_config('request.jwt.claims', '', true);
$$;

-- ---------------------------------------------------------------------------
-- Defaults and grants
-- ---------------------------------------------------------------------------

select results_eq(
  $$select enabled, daily_tiles_per_player from public.fantasy_config$$,
  $$values (false, 300)$$,
  'The map starts switched off, with a conservative cap');

select is(has_function_privilege('anon', 'public.request_fantasy_tiles(jsonb, integer)', 'execute'), false, 'Anonymous callers have no grant on request_fantasy_tiles');
select is(has_function_privilege('anon', 'public.get_fantasy_config()', 'execute'), false, 'Anonymous callers have no grant on get_fantasy_config');
select is(has_function_privilege('authenticated', 'public.request_fantasy_tiles(jsonb, integer)', 'execute'), true, 'Players have the grant on request_fantasy_tiles');
select is(has_function_privilege('anon', 'private.fantasy_z16(double precision, double precision)', 'execute'), false, 'The tile helper is private');

-- Start from a known configuration.
delete from public.fantasy_tiles;
delete from public.fantasy_requests;
delete from public.fantasy_daily;
update public.fantasy_config set enabled = true, version = 1, daily_tiles_per_player = 300, global_daily_tiles = 2000,
  max_queue_depth = 500, max_tiles_per_call = 64, max_visible_tiles = 24, near_player_m = 2000,
  recent_positions = interval '7 days', min_request_interval = interval '0', lease = interval '2 minutes',
  max_attempts = 3, retry_after = interval '10 minutes', failed_cooldown = interval '1 day', webp_quality = 0.75;
insert into public.claimed_cells (user_id, cell, first_claimed_at) values
  (pg_temp.u(1), pg_temp.cell(35209, 21498), now()),
  (pg_temp.u(2), pg_temp.cell(35209, 21498), now());

select pg_temp.as_player(1);
select is(public.get_fantasy_config(), '{"enabled": true, "version": 1, "bucket": "fantasy-tiles"}'::jsonb, 'The app reads the switch, version and bucket');
select throws_ok($$select * from public.fantasy_config$$, '42501', null, 'Players cannot read the config table');
select throws_ok($$select * from public.fantasy_tiles$$, '42501', null, 'Players cannot read the tile table');
select throws_ok($$select * from public.fantasy_daily$$, '42501', null, 'Players cannot read the global counter');
select throws_ok($$update public.fantasy_config set enabled = false$$, '42501', null, 'Players cannot flip the switch');

-- ---------------------------------------------------------------------------
-- Requests near the caller's own ground
-- ---------------------------------------------------------------------------

select is(
  public.request_fantasy_tiles('[[16, 35209, 21498], [16, 35210, 21498], [15, 17604, 10749]]', 1),
  '{"enabled": true, "version": 1, "pending": [[16, 35209, 21498], [16, 35210, 21498], [15, 17604, 10749]], "ready": [], "queued": 3, "capped": false, "reason": null, "far": 0}'::jsonb,
  'Tiles near the caller''s claimed land are queued and reported pending, in request order');
select pg_temp.as_postgres();
select results_eq($$select priority from public.fantasy_tiles where z = 16 order by x$$, $$values (0::smallint), (1::smallint)$$, 'The on-screen tile has priority 0, the one around it 1');
select is((select tiles from public.fantasy_requests where player = pg_temp.u(1)), 7, 'A z15 tile costs 5 tile units, a z16 tile 1');
select is((select tiles from public.fantasy_daily), 7, 'The global counter counts the same units');
select is((select requested_by from public.fantasy_tiles where z = 15), pg_temp.u(1), 'The requester is recorded');
create temporary table first_request as select z, x, y, requested_at, priority from public.fantasy_tiles;

select pg_temp.as_player(1);
select is(
  public.request_fantasy_tiles('[[16, 35210, 21498], [16, 35209, 21498], [16, 35209, 21498]]', 2) ->> 'queued',
  '0', 'Asking again queues nothing and repeats are folded');
select pg_temp.as_postgres();
select is(
  (select count(*)::int from public.fantasy_tiles t join first_request f using (z, x, y) where t.requested_at = f.requested_at and t.priority = f.priority),
  3, 'Asking again moves no tile forward');

-- Far away: f03 has no ground yet.
select pg_temp.as_player(3);
select is(
  public.request_fantasy_tiles('[[16, 35209, 21498], [16, 35209, 21510], [16, 40000, 20000]]') - 'pending' - 'ready',
  '{"enabled": true, "version": 1, "queued": 0, "capped": false, "reason": null, "far": 2}'::jsonb,
  'Without own ground nothing new is queued (the tile already queued is not counted far)');
-- A recent position counts as ground, an old one doesn't.
select pg_temp.as_postgres();
insert into public.walk_points (user_id, session_id, batch_id, recorded_at, geom, accuracy_m) values
  (pg_temp.u(3), 's3', 'b3', now() - interval '1 hour', pg_temp.point(35209, 21510), 10),
  (pg_temp.u(5), 's5', 'b5', now() - interval '8 days', pg_temp.point(35209, 21520), 10);
select pg_temp.as_player(3);
select is(public.request_fantasy_tiles('[[16, 35209, 21510], [16, 35213, 21510]]') ->> 'queued', '2', 'Tiles within 2 km of a recent position are queued');
select is(public.request_fantasy_tiles('[[16, 35209, 21530]]') ->> 'far', '1', 'A tile beyond 2 km is refused');
select pg_temp.as_player(5);
select is(public.request_fantasy_tiles('[[16, 35209, 21520]]') ->> 'far', '1', 'A position older than recent_positions is not ground');

-- Input checks.
select pg_temp.as_player(1);
select throws_ok($$select public.request_fantasy_tiles('{"z": 16}')$$, '22023', null, 'An object is refused');
select throws_ok($$select public.request_fantasy_tiles('[[14, 1, 1]]')$$, '22023', null, 'Zoom 14 is refused');
select throws_ok($$select public.request_fantasy_tiles('[[16, 65536, 1]]')$$, '22023', null, 'x off the grid is refused');
select throws_ok($$select public.request_fantasy_tiles('[[16, -1, 1]]')$$, '22023', null, 'A negative coordinate is refused');
select throws_ok($$select public.request_fantasy_tiles('[[16, 1.5, 1]]')$$, '22023', null, 'A fraction is refused');
select throws_ok($$select public.request_fantasy_tiles('[[16, 1]]')$$, '22023', null, 'Two numbers are refused');
select throws_ok(
  $$select public.request_fantasy_tiles((select jsonb_agg(jsonb_build_array(16, i, 1)) from generate_series(1, 65) i))$$,
  '22023', null, 'More than max_tiles_per_call is refused');
select set_config('role', 'anon', true), set_config('request.jwt.claims', '{"role": "anon"}', true);
select throws_ok($$select public.request_fantasy_tiles('[[16, 1, 1]]')$$, '42501', null, 'Anonymous callers cannot request tiles');

-- At most max_visible_tiles count as on screen.
select pg_temp.as_postgres();
update public.fantasy_config set max_visible_tiles = 2;
select pg_temp.as_player(2);
select is(public.request_fantasy_tiles('[[16, 35208, 21497], [16, 35208, 21498], [16, 35208, 21499], [16, 35208, 21500]]', 4) ->> 'queued', '4', 'Four tiles queued');
select pg_temp.as_postgres();
select is((select count(*)::int from public.fantasy_tiles where x = 35208 and priority = 0), 2, 'Only max_visible_tiles of them are on screen, whatever p_visible says');
update public.fantasy_config set max_visible_tiles = 24;

-- ---------------------------------------------------------------------------
-- Limits
-- ---------------------------------------------------------------------------

-- Per player: f02 has used 4 units; with a cap of 9, a z16 (1) fits, the z15 after it (5) doesn't.
update public.fantasy_config set daily_tiles_per_player = 9;
select pg_temp.as_player(2);
select is(
  public.request_fantasy_tiles('[[16, 35207, 21497], [15, 17603, 10748], [16, 35207, 21498]]') - 'pending' - 'ready',
  '{"enabled": true, "version": 1, "queued": 1, "capped": true, "reason": "player", "far": 0}'::jsonb,
  'Past the per-player cap nothing more is queued, in request order');
select pg_temp.as_postgres();
select is((select tiles from public.fantasy_requests where player = pg_temp.u(2)), 5, 'Only what was queued counts');
update public.fantasy_config set daily_tiles_per_player = 10;
select pg_temp.as_player(2);
select is(public.request_fantasy_tiles('[[15, 17603, 10748]]') ->> 'queued', '1', 'A z15 tile fits exactly in 5 units');
select pg_temp.as_postgres();
update public.fantasy_requests set day = day - 1 where player = pg_temp.u(2);
select pg_temp.as_player(2);
select is(public.request_fantasy_tiles('[[16, 35207, 21499]]') ->> 'queued', '1', 'A new day has a new cap');
select pg_temp.as_postgres();
update public.fantasy_config set daily_tiles_per_player = 300;

-- Global: the units all players queued today.
update public.fantasy_config set global_daily_tiles = (select tiles + 2 from public.fantasy_daily where day = (now() at time zone 'utc')::date);
select pg_temp.as_player(1);
select is(
  public.request_fantasy_tiles('[[16, 35206, 21497], [16, 35206, 21498], [16, 35206, 21499]]') - 'pending' - 'ready',
  '{"enabled": true, "version": 1, "queued": 2, "capped": true, "reason": "global", "far": 0}'::jsonb,
  'Past the global daily limit nothing more is queued, whoever asks');
select pg_temp.as_player(2);
select is(public.request_fantasy_tiles('[[16, 35206, 21500]]') ->> 'reason', 'global', 'The global limit holds for every player');
select pg_temp.as_postgres();
update public.fantasy_config set global_daily_tiles = 2000;

-- Queue depth.
update public.fantasy_config set max_queue_depth = 3;
select pg_temp.as_player(1);
select is(public.request_fantasy_tiles('[[16, 35205, 21497]]') - 'pending' - 'ready',
  '{"enabled": true, "version": 1, "queued": 0, "capped": true, "reason": "queue", "far": 0}'::jsonb,
  'With the queue full nothing more is queued');
select pg_temp.as_postgres();
update public.fantasy_config set max_queue_depth = 500;

-- Rate limit: calls closer together than min_request_interval queue nothing, but still answer.
update public.fantasy_config set min_request_interval = interval '1 hour';
select pg_temp.as_player(1);
select is(
  public.request_fantasy_tiles('[[16, 35209, 21498], [16, 35205, 21498]]') - 'ready',
  '{"enabled": true, "version": 1, "pending": [[16, 35209, 21498]], "queued": 0, "capped": true, "reason": "throttled", "far": 0}'::jsonb,
  'A call too soon after the last queues nothing and still reports what is pending');
select pg_temp.as_postgres();
update public.fantasy_config set min_request_interval = interval '0';

-- Kill switch.
update public.fantasy_config set enabled = false;
select pg_temp.as_player(1);
select is(public.request_fantasy_tiles('[[16, 35205, 21499]]') ->> 'enabled', 'false', 'Switched off, nothing is queued');
select is((public.get_fantasy_config() ->> 'enabled')::boolean, false, 'The app sees the switch off');
select pg_temp.as_postgres();
update public.fantasy_config set enabled = true;

-- ---------------------------------------------------------------------------
-- Leasing
-- ---------------------------------------------------------------------------

select pg_temp.as_player(1);
select throws_ok($$select * from public.lease_fantasy_tiles(1)$$, '42501', null, 'Players cannot lease tiles');
select throws_ok($$select public.finish_fantasy_tile(1, 16, 1, 1, true)$$, '42501', null, 'Players cannot finish tiles');

-- Fair share: f01 asked for three tiles before f02 asked for one; f02's comes second.
select pg_temp.as_postgres();
delete from public.fantasy_tiles;
insert into public.fantasy_tiles (version, z, x, y, priority, requested_by, requested_at) values
  (1, 16, 101, 100, 1, pg_temp.u(1), now() - interval '4 minutes'),
  (1, 16, 102, 100, 1, pg_temp.u(1), now() - interval '3 minutes'),
  (1, 16, 103, 100, 1, pg_temp.u(1), now() - interval '2 minutes'),
  (1, 16, 201, 100, 1, pg_temp.u(2), now() - interval '1 minute'),
  (1, 15, 50, 50, 2, null, now() - interval '9 minutes'),
  (1, 16, 100, 100, 2, null, now() - interval '9 minutes'),
  (1, 16, 300, 100, 0, pg_temp.u(2), now());
select pg_temp.as_service();
select results_eq($$select z, x, webp_quality from public.lease_fantasy_tiles(1)$$, $$values (16::smallint, 300, 0.75::real)$$, 'On-screen tiles are leased first, with the WebP quality');
select results_eq($$select x from public.lease_fantasy_tiles(2)$$, $$values (101), (201)$$, 'Then players take turns: each one''s oldest tile');
select results_eq($$select x from public.lease_fantasy_tiles(2)$$, $$values (102), (103)$$, 'Then the rest, oldest first');
select results_eq($$select z from public.lease_fantasy_tiles(2)$$, $$values (16::smallint), (15::smallint)$$, 'Pre-painting last, z16 before z15');
select is((select count(*)::int from public.lease_fantasy_tiles(64)), 0, 'Leased tiles are not leased twice');

select pg_temp.as_postgres();
update public.fantasy_tiles set lease_until = now() - interval '1 second' where x = 101;
select pg_temp.as_service();
select results_eq($$select x from public.lease_fantasy_tiles(64)$$, $$values (101)$$, 'An expired lease comes back');

select public.finish_fantasy_tile(1, 16, 101, 100, true, 140000, 950);
select public.finish_fantasy_tile(1, 16, 102, 100, false, p_error => 'source data failed');
select pg_temp.as_postgres();
select results_eq(
  $$select status, error, lease_until > now() + interval '9 minutes' from public.fantasy_tiles where x = 102$$,
  $$values ('failed', 'source data failed', true)$$,
  'A failed tile waits retry_after');
update public.fantasy_tiles set status = 'failed', attempts = 3, lease_until = now() - interval '1 second', finished_at = now() - interval '1 hour' where x = 102;
select pg_temp.as_service();
select is((select count(*)::int from public.lease_fantasy_tiles(64) where x = 102), 0, 'Given up after max_attempts');
select pg_temp.as_postgres();
update public.fantasy_tiles set finished_at = now() - interval '25 hours' where x = 102;
select pg_temp.as_service();
select is((select count(*)::int from public.lease_fantasy_tiles(64) where x = 102), 1, 'Tried again after failed_cooldown');

-- Versions.
select pg_temp.as_postgres();
update public.fantasy_config set version = 2;
select pg_temp.as_player(1);
select is((public.request_fantasy_tiles('[[16, 35209, 21498]]') ->> 'queued'), '1', 'A new version starts empty');
select pg_temp.as_service();
select results_eq($$select version from public.lease_fantasy_tiles(64)$$, $$values (2)$$, 'Only the current version is leased');

select * from finish();
rollback;
