-- pgTAP tests for analytics: every event recorded once by the function that
-- does the work (retried app opens, batches, builds, recruits, detours, and
-- surges record nothing new), the game day of events at the 4 a.m. boundary
-- in two time zones, no positions in events, privileges, and the two beta
-- targets computed exactly from seeded synthetic players.
-- Run with: npx supabase test db
begin;

select plan(63);

insert into auth.users (id, aud, role, is_anonymous)
select ('a1000000-0000-0000-0000-0000000000' || lpad(i::text, 2, '0'))::uuid, 'authenticated', 'authenticated', true
from generate_series(1, 9) as i;

-- a01: app opens. a02: the app open cap. a03: walks and detours. a04: builds
-- and recruits. a05: surges. a06, a07: the 4 a.m. boundary of walks in two
-- zones. a08: privileges. a09: rejected batches.
-- Metrics: m01 to m07, signed up in January 2025 (see the metrics section).

-- ---------------------------------------------------------------------------
-- Helpers. Positions are meters north (n) and east (e) of a point in Krakow.
-- ---------------------------------------------------------------------------

create function pg_temp.u(i int)
returns uuid
language sql
immutable
as $$
  select ('a1000000-0000-0000-0000-0000000000' || lpad(i::text, 2, '0'))::uuid
$$;

create function pg_temp.lat(n float8) returns float8 language sql immutable as $$ select 50.057 + n / 111320.0 $$;
create function pg_temp.lng(e float8) returns float8 language sql immutable as $$
  select 19.935 + e / (111320.0 * cos(radians(50.057)))
$$;

create function pg_temp.geom(n float8, e float8)
returns extensions.geometry
language sql
immutable
as $$
  select extensions.st_setsrid(extensions.st_makepoint(pg_temp.lng(e), pg_temp.lat(n)), 4326)
$$;

-- GPS fixes on a straight line, about 14 m apart, one every 10 seconds.
create function pg_temp.track(n0 float8, e0 float8, n1 float8, e1 float8, t0 timestamptz, acc float8 default 5)
returns jsonb
language sql
stable
as $$
  with k as (select greatest(1, round(sqrt((n1 - n0) ^ 2 + (e1 - e0) ^ 2) / 14))::int as steps)
  select jsonb_agg(jsonb_build_object(
    't', (extract(epoch from t0 + make_interval(secs => i * 10)) * 1000)::bigint,
    'lat', pg_temp.lat(n0 + (n1 - n0) * i / k.steps),
    'lng', pg_temp.lng(e0 + (e1 - e0) * i / k.steps),
    'acc', acc, 'spd', 1.4) order by i)
  from k, generate_series(0, k.steps) as i
$$;

create function pg_temp.act_as(who uuid)
returns void
language sql
as $$
  select set_config('role', 'authenticated', true),
    set_config('request.jwt.claims', json_build_object('sub', who, 'role', 'authenticated')::text, true)
$$;

create function pg_temp.submit_as(who uuid, batch text, session text, points jsonb)
returns jsonb
language plpgsql
as $$
declare
  result jsonb;
begin
  perform pg_temp.act_as(who);
  result := public.submit_location_batch(batch, session, points);
  perform set_config('role', 'postgres', true);
  return result;
end;
$$;

create function pg_temp.close_as(who uuid, session text)
returns jsonb
language plpgsql
as $$
declare
  result jsonb;
begin
  perform pg_temp.act_as(who);
  result := public.close_walk_session(session);
  perform set_config('role', 'postgres', true);
  return result;
end;
$$;

create function pg_temp.open_as(who uuid, open_id uuid, tz text default null)
returns jsonb
language plpgsql
as $$
declare
  result jsonb;
begin
  perform pg_temp.act_as(who);
  result := public.record_app_open(open_id, tz);
  perform set_config('role', 'postgres', true);
  return result;
end;
$$;

create function pg_temp.events(who uuid, ev text)
returns int
language sql
stable
as $$
  select count(*)::int from public.analytics_events where user_id = who and event = ev
$$;

create function pg_temp.id(n int)
returns uuid
language sql
immutable
as $$
  select ('e0000000-0000-0000-0000-' || lpad(n::text, 12, '0'))::uuid
$$;

-- A local time on game day d (0 = today) in a zone.
create function pg_temp.lt(tz text, d int, hms text)
returns timestamptz
language sql
stable
as $$
  select (((private.game_day(now(), tz) + d)::text || ' ' || hms)::timestamp) at time zone tz
$$;

-- A fixed-offset zone where it is now 14:xx, so 04:00 today has passed.
create temp table zones as
select (select name from pg_timezone_names where name ~ '^Etc/GMT[-+][0-9]+$'
  and extract(hour from now() at time zone name) = 14 order by name limit 1) as a;
create function pg_temp.tz_a() returns text language sql stable as $$ select a from zones $$;

-- ---------------------------------------------------------------------------
-- App opens (a01, a02)
-- ---------------------------------------------------------------------------

select is(pg_temp.open_as(pg_temp.u(1), pg_temp.id(1), 'Europe/Warsaw') - 'timeZoneAccepted',
  jsonb_build_object('recorded', true, 'duplicate', false, 'capped', false,
    'gameDay', private.game_day(now(), 'Europe/Warsaw')),
  'An app open is recorded in the game day of the time zone the app sends');
select is(pg_temp.open_as(pg_temp.u(1), pg_temp.id(1), 'Europe/Warsaw') ->> 'duplicate', 'true',
  'A retried app open (same open id) is a duplicate');
select is(pg_temp.events(pg_temp.u(1), 'app_open'), 1, 'A retried app open records no second event');
select is(pg_temp.open_as(pg_temp.u(1), pg_temp.id(2)) ->> 'recorded', 'true',
  'A new open id records a second open');
select is(pg_temp.events(pg_temp.u(1), 'app_open'), 2, 'Two opens, two events');
select is((select max(occurred_at) from public.analytics_events where user_id = pg_temp.u(1)), now(),
  'An app open is timed by the server');
select is((select props from public.analytics_events where user_id = pg_temp.u(1) and dedup_key = pg_temp.id(1)::text),
  '{}'::jsonb, 'An app open carries no properties');

select pg_temp.open_as(pg_temp.u(9), pg_temp.id(60), 'Etc/GMT+11');
select is((select game_day from public.analytics_events where user_id = pg_temp.u(9) and event = 'app_open'),
  private.game_day(now(), 'Etc/GMT+11'), 'An app open in another zone uses that zone''s game day');

select private.record_event(pg_temp.u(2), 'app_open', 'seed' || i, private.game_day(now(), 'UTC'), now())
from generate_series(1, 49) as i;
select is(pg_temp.open_as(pg_temp.u(2), pg_temp.id(20)) ->> 'recorded', 'true', 'The 50th open of a day is recorded');
select is(pg_temp.open_as(pg_temp.u(2), pg_temp.id(21)) - 'gameDay' - 'timeZoneAccepted',
  '{"recorded": false, "duplicate": false, "capped": true}'::jsonb,
  'The 51st open of a game day is not recorded');
select is(pg_temp.open_as(pg_temp.u(2), pg_temp.id(20)) ->> 'duplicate', 'true',
  'A retry of a recorded open is still a duplicate past the cap');
select is(pg_temp.events(pg_temp.u(2), 'app_open'), 50, 'At most 50 opens a game day');

select set_config('request.jwt.claims', '{"role": "authenticated"}', true), set_config('role', 'authenticated', true);
select throws_ok($$ select public.record_app_open('e0000000-0000-0000-0000-000000000099', null) $$,
  '42501', null, 'Recording an app open needs a signed-in player');
select set_config('request.jwt.claims', '{"role": "anon"}', true), set_config('role', 'anon', true);
select throws_ok($$ select public.record_app_open('e0000000-0000-0000-0000-000000000099', null) $$,
  '42501', null, 'Signed-out clients can''t call record_app_open');
select set_config('role', 'postgres', true);
select throws_ok(format($$ select pg_temp.open_as(%L, null) $$, pg_temp.u(1)),
  '22023', null, 'An app open needs an open id');
select set_config('role', 'postgres', true);

-- ---------------------------------------------------------------------------
-- Walks and detours (a03, a09)
-- ---------------------------------------------------------------------------

select private.set_time_zone(pg_temp.u(3), pg_temp.tz_a(), now() - interval '10 days');

-- An offer 300 m east of the origin, made at 04:00 local today.
insert into public.detour_offers (user_id, game_day, slot, spot_id, spot_kind, name, geom, anchor, band,
  off_route_m, added_m, added_min, reward_kind, reward, xp, valid_from, valid_until, created_at)
select pg_temp.u(3), d, 1, 1, 'park', 'Test park', pg_temp.geom(0, 300), pg_temp.geom(0, 0), 'short',
  300, 780, 9, 'crystal', '{"crystal": 3}', 75,
  private.game_day_start(d, pg_temp.tz_a()), private.game_day_start(d + 1, pg_temp.tz_a()),
  private.game_day_start(d, pg_temp.tz_a())
from (select private.game_day(now(), pg_temp.tz_a()) as d) x;

select is(pg_temp.events(pg_temp.u(3), 'detour_offered'), 1, 'Making an offer records detour_offered');
select is((select props - 'offerId' from public.analytics_events where user_id = pg_temp.u(3) and event = 'detour_offered'),
  '{"slot": 1, "band": "short", "addedMin": 9, "spotKind": "park", "rewardKind": "crystal"}'::jsonb,
  'detour_offered has the slot, band, added time, and kinds, but no name or position');

-- A walk east past the offer, at 13:00 local today, in two batches.
create temp table walk as select pg_temp.track(0, 0, 0, 600, pg_temp.lt(pg_temp.tz_a(), 0, '13:00')) as pts;
select is(pg_temp.submit_as(pg_temp.u(3), 'w1', 's1',
  (select jsonb_path_query_array(pts, '$[0 to 21]') from walk)) ->> 'duplicate', 'false', 'First batch accepted');
select is(pg_temp.events(pg_temp.u(3), 'walk_batch'), 1, 'An accepted batch records walk_batch');
select is(pg_temp.submit_as(pg_temp.u(3), 'w1', 's1',
  (select jsonb_path_query_array(pts, '$[0 to 21]') from walk)) ->> 'duplicate', 'true', 'The retry is a duplicate');
select is(pg_temp.events(pg_temp.u(3), 'walk_batch'), 1, 'A retried batch records no second walk_batch');
select pg_temp.submit_as(pg_temp.u(3), 'w2', 's1', (select jsonb_path_query_array(pts, '$[22 to last]') from walk));
select pg_temp.close_as(pg_temp.u(3), 's1');
select is(pg_temp.events(pg_temp.u(3), 'walk_batch'), 2, 'A second batch records a second walk_batch');
select is((select array_agg(k order by k) from public.analytics_events e, jsonb_object_keys(e.props) k
           where e.user_id = pg_temp.u(3) and e.dedup_key = 'w1' and e.event = 'walk_batch'),
  array['acceptedPoints', 'newCells', 'rejectedPoints', 'sessionId'],
  'walk_batch holds counts and the session id, no points or positions');
select is((select game_day from public.analytics_events where user_id = pg_temp.u(3) and dedup_key = 'w1'),
  private.game_day(now(), pg_temp.tz_a()), 'walk_batch is in the game day of the walk');

select is(pg_temp.events(pg_temp.u(3), 'detour_collected'), 1, 'Collecting the offer records detour_collected');
select is((select (props ->> 'offerId')::bigint from public.analytics_events
           where user_id = pg_temp.u(3) and event = 'detour_collected'),
  (select id from public.detour_offers where user_id = pg_temp.u(3)), 'detour_collected names the offer');
select is((select game_day from public.analytics_events where user_id = pg_temp.u(3) and event = 'detour_collected'),
  private.game_day(now(), pg_temp.tz_a()), 'detour_collected is in the offer''s game day');

select pg_temp.submit_as(pg_temp.u(3), 'w2', 's1', (select jsonb_path_query_array(pts, '$[22 to last]') from walk));
select pg_temp.close_as(pg_temp.u(3), 's1');
select pg_temp.submit_as(pg_temp.u(3), 'w3', 's2',
  pg_temp.track(-50, 300, 50, 300, pg_temp.lt(pg_temp.tz_a(), 0, '13:30')));
select pg_temp.close_as(pg_temp.u(3), 's2');
select is(pg_temp.events(pg_temp.u(3), 'detour_collected'), 1,
  'Retried batches and a second walk past the offer record no second detour_collected');
select is(pg_temp.events(pg_temp.u(3), 'walk_batch'), 3, 'The second walk records one more walk_batch');

select pg_temp.submit_as(pg_temp.u(9), 'bad', 's1', pg_temp.track(0, 0, 0, 100, now() - interval '1 hour', 100));
select is(pg_temp.events(pg_temp.u(9), 'walk_batch'), 0, 'A batch with no accepted points records nothing');

-- ---------------------------------------------------------------------------
-- The 4 a.m. boundary for walks in two zones (a06 UTC+10, a07 UTC-5)
-- ---------------------------------------------------------------------------

select private.set_time_zone(pg_temp.u(6), 'Etc/GMT-10', now() - interval '10 days');
select private.set_time_zone(pg_temp.u(7), 'Etc/GMT+5', now() - interval '10 days');
-- Each walk lasts 30 s; the last point decides the day.
select pg_temp.submit_as(pg_temp.u(i), 'early', 'e', pg_temp.track(0, 0, 0, 42, pg_temp.lt(tz, -1, '03:59:00') - interval '30 seconds')),
  pg_temp.submit_as(pg_temp.u(i), 'late', 'l', pg_temp.track(0, 0, 0, 42, pg_temp.lt(tz, -1, '04:00:00')))
from (values (6, 'Etc/GMT-10'), (7, 'Etc/GMT+5')) as z (i, tz);

select is((select game_day from public.analytics_events where user_id = pg_temp.u(6) and dedup_key = 'early'),
  private.game_day(now(), 'Etc/GMT-10') - 2, 'UTC+10: a walk ending at 03:59 local belongs to the previous game day');
select is((select game_day from public.analytics_events where user_id = pg_temp.u(6) and dedup_key = 'late'),
  private.game_day(now(), 'Etc/GMT-10') - 1, 'UTC+10: a walk at 04:00 local starts the next game day');
select is((select game_day from public.analytics_events where user_id = pg_temp.u(7) and dedup_key = 'early'),
  private.game_day(now(), 'Etc/GMT+5') - 2, 'UTC-5: a walk ending at 03:59 local belongs to the previous game day');
select is((select game_day from public.analytics_events where user_id = pg_temp.u(7) and dedup_key = 'late'),
  private.game_day(now(), 'Etc/GMT+5') - 1, 'UTC-5: a walk at 04:00 local starts the next game day');

-- ---------------------------------------------------------------------------
-- Builds and recruits (a04, Warsaw)
-- ---------------------------------------------------------------------------

select private.set_time_zone(pg_temp.u(4), 'Europe/Warsaw', '2026-11-01 00:00 UTC');
select private.credit(pg_temp.u(4), 'walk', 'test', 10000, 200, 200, 0, 0, 0);

select is(private.build(pg_temp.u(4), 'barracks', 1, pg_temp.id(401), '2026-11-17 03:59 Europe/Warsaw') ->> 'ok', 'true',
  'Barracks built at 03:59 local');
select private.build(pg_temp.u(4), 'barracks', 1, pg_temp.id(401), '2026-11-17 10:00 Europe/Warsaw');
select is(pg_temp.events(pg_temp.u(4), 'building_built'), 1, 'A retried build records no second building_built');
select is((select (game_day, props) from public.analytics_events where user_id = pg_temp.u(4) and event = 'building_built'),
  ('2026-11-16'::date, '{"building": "barracks", "level": 1}'::jsonb),
  'building_built has the building, level, and the game day of the build (03:59 is the day before)');
select is(private.build(pg_temp.u(4), 'treasury', 1, pg_temp.id(402), '2026-11-17 03:30 Europe/Warsaw') ->> 'reason',
  'daily_limit', 'A second build the same game day is refused');
select is(pg_temp.events(pg_temp.u(4), 'building_built'), 1, 'A refused build records nothing');

select is(private.recruit(pg_temp.u(4), 'pikeman', 2, pg_temp.id(403), '2026-11-17 12:00 Europe/Warsaw') ->> 'ok', 'true',
  'Pikemen recruited');
select private.recruit(pg_temp.u(4), 'pikeman', 2, pg_temp.id(403), '2026-11-17 12:01 Europe/Warsaw');
select is(pg_temp.events(pg_temp.u(4), 'units_recruited'), 1, 'A retried recruitment records no second event');
select is((select (game_day, props) from public.analytics_events where user_id = pg_temp.u(4) and event = 'units_recruited'),
  ('2026-11-17'::date, '{"unit": "pikeman", "count": 2}'::jsonb), 'units_recruited has the unit, count, and game day');

-- ---------------------------------------------------------------------------
-- Surges (a05). Step 5 calls private.record_surge_result.
-- ---------------------------------------------------------------------------

select is(private.record_surge_result(pg_temp.u(5), '2026-11-09', true, 120, 150, 0, 0,
  '{"gold": 500}', true, '2026-11-16 03:00 UTC'), true, 'A surge result is recorded');
select is(private.record_surge_result(pg_temp.u(5), '2026-11-09', false, 1, 0, 9, 9, null, false, '2026-11-16 03:05 UTC'),
  false, 'A second result for the same week is not recorded');
select is((select (game_day, props) from public.analytics_events where user_id = pg_temp.u(5) and event = 'surge_result'),
  ('2026-11-15'::date, '{"week": "2026-11-09", "held": true, "pressure": 120, "defense": 150, "cellsLost": 0,
    "unitsLost": 0, "reward": {"gold": 500}, "gentle": true}'::jsonb),
  'The first result stands, in the game day it was run (Sunday night before 4 a.m.)');
select throws_ok(format($$ select private.record_surge_result(%L, '2026-11-10', true, 1, 1) $$, pg_temp.u(5)),
  '22023', null, 'The surge week must be a Monday');

-- ---------------------------------------------------------------------------
-- Privileges (a08)
-- ---------------------------------------------------------------------------

select pg_temp.act_as(pg_temp.u(8));
select is((select count(*)::int from public.analytics_events), 0, 'A player reads no other player''s events');
select throws_ok(format($$ insert into public.analytics_events (user_id, event, dedup_key, game_day, occurred_at)
  values (%L, 'app_open', 'x', current_date, now()) $$, pg_temp.u(8)),
  '42501', null, 'A player can''t insert events, even their own');
select throws_ok($$ update public.analytics_events set game_day = current_date $$,
  '42501', null, 'A player can''t change events');
select throws_ok($$ delete from public.analytics_events $$, '42501', null, 'A player can''t delete events');
select throws_ok(format($$ select private.record_event(%L, 'building_built', 'x', current_date, now()) $$, pg_temp.u(8)),
  '42501', null, 'A player can''t call the event recorder');
select throws_ok(format($$ select private.record_surge_result(%L, '2026-11-09', true, 1, 1) $$, pg_temp.u(8)),
  '42501', null, 'A player can''t record a surge result');
select throws_ok($$ select * from analytics.beta_targets('2025-01-01', '2025-02-01') $$,
  '42501', null, 'A player can''t read the metrics');
select set_config('role', 'postgres', true);
select pg_temp.open_as(pg_temp.u(8), pg_temp.id(80));
select pg_temp.act_as(pg_temp.u(8));
select is((select count(*)::int from public.analytics_events), 1, 'A player reads their own events');
select set_config('role', 'postgres', true);

select throws_ok($$ insert into public.analytics_events (user_id, event, dedup_key, game_day, occurred_at, props)
  values ('a1000000-0000-0000-0000-000000000001', 'app_open', 'geo', current_date, now(), '{"lat": 50}') $$,
  '23514', null, 'Events refuse location keys');

-- ---------------------------------------------------------------------------
-- Metrics. Synthetic players signed up in January 2025 (UTC unless noted);
-- events are seeded with their game days. Weeks start on Monday.
--
-- Player  Signup (week 1)         Week of Jan 27            Week of Feb 3
-- m01     Mon Jan 6  (Jan 6)      wk 4: 4 days, 1 detour    wk 5: 4 days
-- m02     Tue Jan 7  (Jan 13)     wk 3: 3 days, 1 detour    wk 4: 4 days, 2 detours
-- m03     Mon Jan 13 (Jan 13)     wk 3: 4 days              wk 4: none
-- m04     Tue Jan 14 (Jan 20)     wk 2: 5 days              wk 3: 4 days, 1 detour
-- m05     Tue Jan 28 (Feb 3)      new: 1 day, 1 detour      wk 1: 2 days
-- m06     Mon Jan 6  (Jan 6)      none                      none
-- m07     Tue Jan 21 05:00 UTC, UTC-5: Mon Jan 20 local (Jan 20)
--                                 wk 2: walks and a detour  wk 3: 4 days
--                                 only (not active)
--
-- Week of Jan 27: eligible m01 m02 m03 m06, retained m01 m03: 2/4.
--   Active m01 to m05, with a detour m01 m02 m05: 3/5.
-- Week of Feb 3: eligible m01 m02 m03 m04 m06 m07, retained m01 m02 m04 m07:
--   4/6. Active m01 m02 m04 m05 m07, with a detour m02 m04: 2/5.
-- ---------------------------------------------------------------------------

create function pg_temp.m(i int)
returns uuid
language sql
immutable
as $$
  select ('a2000000-0000-0000-0000-0000000000' || lpad(i::text, 2, '0'))::uuid
$$;

insert into auth.users (id, aud, role, is_anonymous, created_at)
values
  (pg_temp.m(1), 'authenticated', 'authenticated', true, '2025-01-06 10:00 UTC'),
  (pg_temp.m(2), 'authenticated', 'authenticated', true, '2025-01-07 10:00 UTC'),
  (pg_temp.m(3), 'authenticated', 'authenticated', true, '2025-01-13 10:00 UTC'),
  (pg_temp.m(4), 'authenticated', 'authenticated', true, '2025-01-14 10:00 UTC'),
  (pg_temp.m(5), 'authenticated', 'authenticated', true, '2025-01-28 10:00 UTC'),
  (pg_temp.m(6), 'authenticated', 'authenticated', true, '2025-01-06 10:00 UTC'),
  (pg_temp.m(7), 'authenticated', 'authenticated', true, '2025-01-21 05:00 UTC');
select private.set_time_zone(pg_temp.m(7), 'Etc/GMT+5', '2025-01-21 05:00 UTC');

create function pg_temp.seed(who int, ev text, days text[])
returns void
language sql
as $$
  select private.record_event(pg_temp.m(who), ev, ev || '-' || d || '-' || n, d::date, d::date + time '12:00')
  from unnest(days) with ordinality as x (d, n)
$$;

-- Week of Jan 27 (Mon Jan 27 to Sun Feb 2).
select pg_temp.seed(1, 'app_open', array['2025-01-27', '2025-01-27', '2025-01-28', '2025-02-01', '2025-02-02']);
select pg_temp.seed(1, 'detour_collected', array['2025-01-28']);
select pg_temp.seed(2, 'app_open', array['2025-01-27', '2025-01-28', '2025-01-29']);
select pg_temp.seed(2, 'walk_batch', array['2025-01-30', '2025-01-31']);
select pg_temp.seed(2, 'detour_collected', array['2025-01-31']);
select pg_temp.seed(2, 'app_open', array['2025-01-26']); -- Sunday: the week before.
select pg_temp.seed(3, 'app_open', array['2025-01-27', '2025-01-28']);
select pg_temp.seed(3, 'building_built', array['2025-01-29']);
select pg_temp.seed(3, 'units_recruited', array['2025-01-30']);
select pg_temp.seed(3, 'detour_offered', array['2025-01-27', '2025-01-28']);
select pg_temp.seed(4, 'app_open', array['2025-01-27', '2025-01-28', '2025-01-29', '2025-01-30', '2025-01-31']);
select pg_temp.seed(5, 'app_open', array['2025-01-29']);
select pg_temp.seed(5, 'detour_collected', array['2025-01-29']);
select pg_temp.seed(7, 'walk_batch', array['2025-01-28']);
select pg_temp.seed(7, 'detour_collected', array['2025-01-28']);
select pg_temp.seed(6, 'surge_result', array['2025-02-02']);

-- Week of Feb 3 (Mon Feb 3 to Sun Feb 9).
select pg_temp.seed(1, 'app_open', array['2025-02-03', '2025-02-04', '2025-02-05', '2025-02-09']);
select pg_temp.seed(2, 'app_open', array['2025-02-03', '2025-02-04', '2025-02-05', '2025-02-06']);
select pg_temp.seed(2, 'detour_collected', array['2025-02-04', '2025-02-05']);
select pg_temp.seed(4, 'app_open', array['2025-02-03', '2025-02-05', '2025-02-07']);
select pg_temp.seed(4, 'building_built', array['2025-02-08']);
select pg_temp.seed(4, 'detour_collected', array['2025-02-08']);
select pg_temp.seed(5, 'app_open', array['2025-02-04', '2025-02-05']);
select pg_temp.seed(7, 'app_open', array['2025-02-03', '2025-02-04', '2025-02-05', '2025-02-06']);

-- The week after the range: must not count.
select pg_temp.seed(3, 'app_open', array['2025-02-10', '2025-02-11', '2025-02-12', '2025-02-13']);
select pg_temp.seed(3, 'detour_collected', array['2025-02-10']);

select is((select (signup_day, first_week) from analytics.players where user_id = pg_temp.m(2)),
  ('2025-01-07'::date, '2025-01-13'::date), 'Week 1 is the first full game week after signup');
select is((select (signup_day, first_week) from analytics.players where user_id = pg_temp.m(1)),
  ('2025-01-06'::date, '2025-01-06'::date), 'Signing up on a Monday makes that week week 1');
select is((select (signup_day, first_week) from analytics.players where user_id = pg_temp.m(7)),
  ('2025-01-20'::date, '2025-01-20'::date), 'The signup day is in the player''s time zone (UTC-5: Monday, not Tuesday)');
select is((select active_days from analytics.player_weeks where user_id = pg_temp.m(1) and week = '2025-01-27'), 4,
  'Two opens on one day are one active day, and Sunday ends the week');

select results_eq(
  $$ select * from analytics.weekly_retention('2025-01-27', '2025-02-09') $$,
  $$ values ('2025-01-27'::date, 4, 2, 2 / 4::numeric), ('2025-02-03'::date, 6, 4, 4 / 6::numeric) $$,
  'Retention: players in week 3 or later who were active 4+ days, per week');
select results_eq(
  $$ select * from analytics.weekly_detour_share('2025-01-29', '2025-02-05') $$,
  $$ values ('2025-01-27'::date, 5, 3, 3 / 5::numeric), ('2025-02-03'::date, 5, 2, 2 / 5::numeric) $$,
  'Detour share: active players who collected a detour, per week (any day in a week selects it)');
select results_eq(
  $$ select * from analytics.beta_targets('2025-01-27', '2025-02-09') $$,
  $$ values (10, 6, 6 / 10::numeric, 10, 5, 5 / 10::numeric) $$,
  'Both targets pooled over player-weeks');
select results_eq(
  $$ select week, eligible_players, retention from analytics.weekly_retention('2025-01-13', '2025-01-13') $$,
  $$ values ('2025-01-13'::date, 0, null::numeric) $$,
  'A week without eligible players has no retention');

select * from finish();
rollback;
