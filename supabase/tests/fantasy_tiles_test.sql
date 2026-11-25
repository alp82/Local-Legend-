-- pgTAP tests for the fantasy tile queue: requests queue new tiles once and
-- report what is still pending, the daily cap, the kill switch, input checks,
-- leasing order and expiry, failures and retries, versions, and privileges.
-- Run with: npx supabase test db
begin;

select plan(39);

insert into auth.users (id, aud, role, is_anonymous)
select ('f0000000-0000-0000-0000-0000000000' || lpad(i::text, 2, '0'))::uuid, 'authenticated', 'authenticated', true
from generate_series(1, 3) as i;

create function pg_temp.u(i int)
returns uuid
language sql
immutable
as $$
  select ('f0000000-0000-0000-0000-0000000000' || lpad(i::text, 2, '0'))::uuid
$$;

create function pg_temp.as_player(i int)
returns void
language sql
as $$
  select set_config('role', 'authenticated', true),
    set_config('request.jwt.claims', json_build_object('sub', pg_temp.u(i), 'role', 'authenticated')::text, true);
$$;

create function pg_temp.as_service()
returns void
language sql
as $$
  select set_config('role', 'service_role', true),
    set_config('request.jwt.claims', json_build_object('role', 'service_role')::text, true);
$$;

create function pg_temp.as_postgres()
returns void
language sql
as $$
  select set_config('role', 'postgres', true);
$$;

-- Start from a known configuration, whatever an earlier run left.
delete from public.fantasy_tiles;
delete from public.fantasy_requests;
update public.fantasy_config set enabled = true, version = 1, daily_tiles_per_player = 1500, max_tiles_per_call = 64,
  lease = interval '2 minutes', max_attempts = 3, retry_after = interval '10 minutes', webp_quality = 0.8;

-- ---------------------------------------------------------------------------
-- Config
-- ---------------------------------------------------------------------------

select pg_temp.as_player(1);
select is(public.get_fantasy_config(), '{"enabled": true, "version": 1, "bucket": "fantasy-tiles"}'::jsonb, 'The app reads the switch, version and bucket');
select throws_ok($$select * from public.fantasy_config$$, '42501', null, 'Players cannot read the config table');
select throws_ok($$select * from public.fantasy_tiles$$, '42501', null, 'Players cannot read the tile table');
select throws_ok($$update public.fantasy_config set enabled = false$$, '42501', null, 'Players cannot flip the switch');

-- ---------------------------------------------------------------------------
-- Requests
-- ---------------------------------------------------------------------------

select is(
  public.request_fantasy_tiles('[[16, 35209, 21498], [16, 35210, 21498], [15, 17604, 10749]]', 1),
  '{"enabled": true, "version": 1, "pending": [[16, 35209, 21498], [16, 35210, 21498], [15, 17604, 10749]], "queued": 3, "capped": false}'::jsonb,
  'New tiles are queued and reported pending, in request order');
select is(
  public.request_fantasy_tiles('[[16, 35210, 21498], [16, 35209, 21498], [16, 35209, 21498]]'),
  '{"enabled": true, "version": 1, "pending": [[16, 35210, 21498], [16, 35209, 21498]], "queued": 0, "capped": false}'::jsonb,
  'Asking again queues nothing new and repeats are folded');
select pg_temp.as_postgres();
select is((select priority from public.fantasy_tiles where z = 16 and x = 35209), 0::smallint, 'The visible tile has priority 0');
select is((select priority from public.fantasy_tiles where z = 16 and x = 35210), 1::smallint, 'A tile around the view has priority 1');
select is((select tiles from public.fantasy_requests where player = pg_temp.u(1)), 3, 'Only new tiles count against the daily cap');
select is((select requested_by from public.fantasy_tiles where z = 15), pg_temp.u(1), 'The requester is recorded');

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
select set_config('request.jwt.claims', '{"role": "anon"}', true);
select set_config('role', 'anon', true);
select throws_ok($$select public.request_fantasy_tiles('[[16, 1, 1]]')$$, '42501', null, 'Anonymous callers cannot request tiles');

-- Daily cap: player 2 may queue 2 new tiles a day.
select pg_temp.as_postgres();
update public.fantasy_config set daily_tiles_per_player = 2;
select pg_temp.as_player(2);
select is(
  public.request_fantasy_tiles('[[16, 100, 100], [16, 101, 100], [16, 102, 100], [16, 35209, 21498]]'),
  '{"enabled": true, "version": 1, "pending": [[16, 100, 100], [16, 101, 100], [16, 35209, 21498]], "queued": 2, "capped": true}'::jsonb,
  'Past the cap nothing more is queued, already queued tiles still report');
select is(
  (public.request_fantasy_tiles('[[16, 103, 100]]') ->> 'capped')::boolean, true, 'The cap holds for the rest of the day');
select pg_temp.as_postgres();
update public.fantasy_requests set day = day - 1 where player = pg_temp.u(2);
select pg_temp.as_player(2);
select is((public.request_fantasy_tiles('[[16, 103, 100]]') ->> 'queued')::int, 1, 'A new day has a new cap');
select pg_temp.as_postgres();
update public.fantasy_config set daily_tiles_per_player = 1500;

-- Kill switch.
update public.fantasy_config set enabled = false;
select pg_temp.as_player(3);
select is(
  public.request_fantasy_tiles('[[16, 200, 200]]'),
  '{"enabled": false, "version": 1, "pending": [], "queued": 0, "capped": false}'::jsonb,
  'Switched off, nothing is queued');
select is((public.get_fantasy_config() ->> 'enabled')::boolean, false, 'The app sees the switch off');
select pg_temp.as_postgres();
update public.fantasy_config set enabled = true;

-- ---------------------------------------------------------------------------
-- Renderer
-- ---------------------------------------------------------------------------

select pg_temp.as_player(1);
select throws_ok($$select * from public.lease_fantasy_tiles(1)$$, '42501', null, 'Players cannot lease tiles');
select throws_ok($$select public.finish_fantasy_tile(1, 16, 1, 1, true)$$, '42501', null, 'Players cannot finish tiles');

select pg_temp.as_service();
select results_eq(
  $$select z, x, y, webp_quality from public.lease_fantasy_tiles(1)$$,
  $$values (16::smallint, 35209, 21498, 0.8::real)$$,
  'On-screen tiles are leased first, with the WebP quality');
select is((select count(*)::int from public.lease_fantasy_tiles(64)), 5, 'The rest are leased once each');
select is((select count(*)::int from public.lease_fantasy_tiles(64)), 0, 'Leased tiles are not leased twice');

select pg_temp.as_postgres();
update public.fantasy_tiles set lease_until = now() - interval '1 second' where z = 16 and x = 100;
select pg_temp.as_service();
select results_eq($$select x from public.lease_fantasy_tiles(64)$$, $$values (100)$$, 'An expired lease comes back');

select public.finish_fantasy_tile(1, 16, 35209, 21498, true, 140000, 950);
select pg_temp.as_postgres();
select results_eq(
  $$select status, bytes, paint_ms, lease_until is null from public.fantasy_tiles where z = 16 and x = 35209$$,
  $$values ('ready', 140000, 950, true)$$,
  'A painted tile is ready with its size and time');

select pg_temp.as_player(1);
select is(
  public.request_fantasy_tiles('[[16, 35209, 21498], [16, 35210, 21498]]') -> 'pending',
  '[[16, 35210, 21498]]'::jsonb,
  'A ready tile is no longer pending');

-- Failures and retries.
select pg_temp.as_service();
select public.finish_fantasy_tile(1, 16, 35210, 21498, false, p_error => 'source data failed');
select pg_temp.as_postgres();
select results_eq(
  $$select status, error, lease_until > now() + interval '9 minutes' from public.fantasy_tiles where z = 16 and x = 35210$$,
  $$values ('failed', 'source data failed', true)$$,
  'A failed tile waits retry_after');
select pg_temp.as_service();
select is((select count(*)::int from public.lease_fantasy_tiles(64) where x = 35210), 0, 'Not retried before retry_after');
select pg_temp.as_postgres();
update public.fantasy_tiles set lease_until = now() - interval '1 second' where z = 16 and x = 35210;
select pg_temp.as_service();
select is((select count(*)::int from public.lease_fantasy_tiles(64) where x = 35210), 1, 'Retried after retry_after');
select pg_temp.as_postgres();
update public.fantasy_tiles set status = 'failed', attempts = 3, lease_until = now() - interval '1 second' where z = 16 and x = 35210;
select pg_temp.as_service();
select is((select count(*)::int from public.lease_fantasy_tiles(64) where x = 35210), 0, 'Given up after max_attempts');
select pg_temp.as_player(1);
select is(public.request_fantasy_tiles('[[16, 35210, 21498]]') -> 'pending', '[]'::jsonb, 'A tile given up on is not pending');

-- A z15 job paints its children; finishing an unrequested child creates its row.
select pg_temp.as_service();
select public.finish_fantasy_tile(1, 16, 35208, 21498, true, 120000, 800);
select pg_temp.as_postgres();
select is((select status from public.fantasy_tiles where z = 16 and x = 35208), 'ready', 'An unrequested tile can be recorded ready');

-- Versions.
update public.fantasy_config set version = 2;
select pg_temp.as_player(1);
select is(
  (public.request_fantasy_tiles('[[16, 35209, 21498]]') ->> 'queued')::int, 1, 'A new version starts empty');
select pg_temp.as_service();
select results_eq($$select version from public.lease_fantasy_tiles(64)$$, $$values (2)$$, 'Only the current version is leased');

select * from finish();
rollback;
