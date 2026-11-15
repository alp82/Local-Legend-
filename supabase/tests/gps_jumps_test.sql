-- pgTAP tests for GPS accuracy in the walking-speed test (*_gps_accuracy.sql):
-- short GPS jumps don't count as vehicle travel, real vehicles still do.
-- Run with: npx supabase test db
begin;

select plan(25);

-- Fixtures: J walks with GPS jumps, K walks the same path without them, V1 to
-- V7 are vehicle trips.
insert into auth.users (id, aud, role, is_anonymous)
values
  ('a1000000-0000-0000-0000-00000000000a', 'authenticated', 'authenticated', true),
  ('a1000000-0000-0000-0000-00000000000b', 'authenticated', 'authenticated', true),
  ('a2000000-0000-0000-0000-000000000001', 'authenticated', 'authenticated', true),
  ('a2000000-0000-0000-0000-000000000002', 'authenticated', 'authenticated', true),
  ('a2000000-0000-0000-0000-000000000003', 'authenticated', 'authenticated', true),
  ('a2000000-0000-0000-0000-000000000004', 'authenticated', 'authenticated', true),
  ('a2000000-0000-0000-0000-000000000005', 'authenticated', 'authenticated', true),
  ('a2000000-0000-0000-0000-000000000006', 'authenticated', 'authenticated', true),
  ('a2000000-0000-0000-0000-000000000007', 'authenticated', 'authenticated', true);

-- A point (east_m, north_m) meters from (50.0, 19.9), t_s seconds after
-- 3 hours ago.
create function pg_temp.fix(t_s float8, east_m float8, north_m float8, acc float8, spd float8)
returns jsonb
language sql
stable
as $$
  select jsonb_build_object(
    't', ((extract(epoch from now()) - 10800 + t_s) * 1000)::bigint,
    'lat', 50.0 + north_m / 111320,
    'lng', 19.9 + east_m / (111320 * cos(radians(50.0))),
    'acc', acc,
    'spd', spd)
$$;

-- A 20-minute walk east at 1.4 m/s, a fix every 5 s with 6 m accuracy, like
-- tester B's walk in docs/detour-real-tracks.md. With jumps, it gets the two
-- kinds of jumps that walk had:
-- - At fixes 30, 100, and 200: an extra fix 1 s later, 7.6 m ahead, with 9 m
--   accuracy at both ends (7.6 m/s).
-- - At fixes 60 and 150: the fix lands 20 m to the side, with 9 m accuracy
--   (about 4.2 m/s there and back).
create function pg_temp.walk(with_jumps boolean)
returns jsonb
language sql
stable
as $$
  select jsonb_agg(p order by t)
  from (
    select i * 5.0 as t,
      pg_temp.fix(i * 5.0, i * 7.0,
        case when with_jumps and i in (60, 150) then 20 else 0 end,
        case when with_jumps and i in (30, 60, 100, 150, 200) then 9 else 6 end,
        1.4) as p
    from generate_series(0, 239) as i
    union all
    select i * 5.0 + 1, pg_temp.fix(i * 5.0 + 1, i * 7.0 + 7.6, 0, 9, 1.0)
    from generate_series(0, 239) as i
    where with_jumps and i in (30, 100, 200)
  ) x
$$;

-- A vehicle trip east: n fixes, dt_s apart, at speed_mps, with accuracy acc.
-- noise_m moves each fix up to that far to the side, deterministically.
create function pg_temp.trip(n int, dt_s float8, speed_mps float8, acc float8, noise_m float8 default 0)
returns jsonb
language sql
stable
as $$
  select jsonb_agg(pg_temp.fix(i * dt_s, i * dt_s * speed_mps, noise_m * sin(i * 2.3), acc, speed_mps) order by i)
  from generate_series(0, n - 1) as i
$$;

-- Elements i0 .. i1 (1-based, inclusive) of a JSON array.
create function pg_temp.slice(a jsonb, i0 int, i1 int)
returns jsonb
language sql
immutable
as $$
  select coalesce(jsonb_agg(e order by o), '[]') from jsonb_array_elements(a) with ordinality as x (e, o)
  where o between i0 and i1
$$;

-- Uploads a track as the given player in batches of 40 points, as the app
-- does, then closes the session. Returns the session's new cells.
create function pg_temp.replay(who uuid, session text, points jsonb)
returns int
language plpgsql
as $$
declare
  n int := jsonb_array_length(points);
  cells int;
begin
  perform set_config('role', 'authenticated', true);
  perform set_config('request.jwt.claims',
    json_build_object('sub', who, 'role', 'authenticated')::text, true);
  for i in 0 .. (n - 1) / 40 loop
    perform public.submit_location_batch(session || '-' || i, session, pg_temp.slice(points, i * 40 + 1, i * 40 + 40));
  end loop;
  perform public.close_walk_session(session);
  perform set_config('role', 'postgres', true);
  select new_cells into cells from public.walk_sessions where user_id = who and session_id = session;
  return cells;
end;
$$;

-- The cells a perfect walk along the path claims.
create function pg_temp.path_cells()
returns setof bigint
language sql
stable
as $$
  select private.cells_near(extensions.st_transform(extensions.st_makeline(array[
    extensions.st_setsrid(extensions.st_makepoint((pg_temp.fix(0, 0, 0, 6, 0) ->> 'lng')::float8, 50.0), 4326),
    extensions.st_setsrid(extensions.st_makepoint((pg_temp.fix(0, 239 * 7.0, 0, 6, 0) ->> 'lng')::float8, 50.0), 4326)
  ]), 3857), 30)
$$;

create function pg_temp.cells_of(who uuid)
returns setof bigint
language sql
as $$ select cell from public.claimed_cells where user_id = who $$;

create function pg_temp.walk_gold(who uuid)
returns numeric
language sql
as $$ select coalesce(sum(gold), 0) from public.economy_ledger where user_id = who and reason = 'walk' $$;

-- An open detour offer for each walker, on the path 20 s after the second
-- 1-second jump (fix 104), so its collection falls inside that jump's
-- vehicle buffer.
insert into public.detour_offers (user_id, game_day, slot, spot_id, spot_kind, geom, anchor, band,
  off_route_m, added_m, added_min, reward_kind, reward, xp, valid_from, valid_until, created_at)
select u, current_date, 1, 1, 'landmark', g, g, 'short', 100, 200, 3, 'common', '{"gold": 7}', 1,
  now() - interval '1 day', now() + interval '1 hour', now() - interval '1 day'
from (values ('a1000000-0000-0000-0000-00000000000a'::uuid), ('a1000000-0000-0000-0000-00000000000b'::uuid)) as v (u),
  lateral (select extensions.st_setsrid(extensions.st_makepoint(
    (pg_temp.fix(0, 104 * 7.0, 0, 6, 0) ->> 'lng')::float8, 50.0), 4326) as g) x;

-- GPS jumps on a walk -------------------------------------------------------

select ok(pg_temp.replay('a1000000-0000-0000-0000-00000000000b', 'k-walk', pg_temp.walk(false)) > 0,
  'K walks the path without GPS jumps');
select ok(pg_temp.replay('a1000000-0000-0000-0000-00000000000a', 'j-walk', pg_temp.walk(true)) > 0,
  'J walks the same path with 5 GPS jumps');

select ok(
  (select count(*) from pg_temp.cells_of('a1000000-0000-0000-0000-00000000000b') c
   where c in (select * from pg_temp.path_cells()))
    >= 0.99 * (select count(*) from pg_temp.path_cells()),
  'The walk without jumps claims the whole path'
);
select ok(
  (select count(*) from pg_temp.cells_of('a1000000-0000-0000-0000-00000000000a') c
   where c in (select * from pg_temp.path_cells()))
    >= 0.99 * (select count(*) from pg_temp.path_cells()),
  'The walk with GPS jumps claims the whole path too'
);
select is_empty(
  $$ select * from pg_temp.cells_of('a1000000-0000-0000-0000-00000000000b')
     except select * from pg_temp.cells_of('a1000000-0000-0000-0000-00000000000a') $$,
  'GPS jumps lose no land'
);
select is_empty(
  $$ select tile, game_day from public.route_tiles where user_id = 'a1000000-0000-0000-0000-00000000000b'
     except
     select tile, game_day from public.route_tiles where user_id = 'a1000000-0000-0000-0000-00000000000a' $$,
  'GPS jumps lose no route history'
);
select ok(pg_temp.walk_gold('a1000000-0000-0000-0000-00000000000b') > 0, 'The walk without jumps pays');
select ok(
  pg_temp.walk_gold('a1000000-0000-0000-0000-00000000000a')
    >= pg_temp.walk_gold('a1000000-0000-0000-0000-00000000000b'),
  'GPS jumps lose no walking pay'
);
select ok(
  (select distance_on_foot_m from public.walk_sessions where session_id = 'j-walk')
    >= (select distance_on_foot_m from public.walk_sessions where session_id = 'k-walk'),
  'GPS jumps lose no distance on foot'
);
select ok(
  (select collected_at is not null from public.detour_offers where user_id = 'a1000000-0000-0000-0000-00000000000b'),
  'The walk without jumps collects the detour offer'
);
select ok(
  (select collected_at is not null from public.detour_offers where user_id = 'a1000000-0000-0000-0000-00000000000a'),
  'A detour offer reached 20 s after a GPS jump is collected'
);

-- Vehicles ------------------------------------------------------------------
-- The app records a fix every 10 m. On iOS that's a fix every second in a car
-- at 10 m/s; on Android at most one every 5 s.

select is(pg_temp.replay('a2000000-0000-0000-0000-000000000001', 'v-car-ios', pg_temp.trip(120, 1, 10, 5)), 0,
  'A car at 10 m/s with a fix every second claims nothing');
select is(pg_temp.replay('a2000000-0000-0000-0000-000000000002', 'v-car-android', pg_temp.trip(60, 5, 10, 5)), 0,
  'A car at 10 m/s with a fix every 5 s claims nothing');
select is(pg_temp.replay('a2000000-0000-0000-0000-000000000003', 'v-bus', pg_temp.trip(60, 5, 6, 8, 5)), 0,
  'A bus at 6 m/s with 8 m accuracy and 5 m of noise claims nothing');
select is(pg_temp.replay('a2000000-0000-0000-0000-000000000004', 'v-train', pg_temp.trip(60, 5, 25, 15)), 0,
  'A train at 25 m/s with 15 m accuracy claims nothing');
select is(pg_temp.replay('a2000000-0000-0000-0000-000000000005', 'v-acc-ios', pg_temp.trip(120, 1.5, 7, 35)), 0,
  'A car at 7 m/s reporting 35 m accuracy, a fix every 1.5 s, claims nothing');
select is(pg_temp.replay('a2000000-0000-0000-0000-000000000006', 'v-acc-android', pg_temp.trip(60, 5, 7, 35)), 0,
  'A car at 7 m/s reporting 35 m accuracy, a fix every 5 s, claims nothing');
select is(pg_temp.replay('a2000000-0000-0000-0000-000000000007', 'v-acc-start', pg_temp.trip(8, 1, 7, 35)), 0,
  'A 7-second car trip reporting 35 m accuracy, a fix every second, claims nothing');

select is(
  (select sum(distance_on_foot_m) from public.walk_sessions where session_id like 'v-%'),
  0::float8,
  'No vehicle trip adds distance on foot'
);
select is(
  (select count(*)::int from public.route_tiles where user_id::text like 'a2000000-%'),
  0,
  'No vehicle trip adds route history'
);
select is(
  (select count(*)::int from public.economy_ledger where user_id::text like 'a2000000-%' and reason = 'walk'),
  0,
  'No vehicle trip pays'
);

-- The rule ------------------------------------------------------------------
-- segment_kind(dt_s, dist_m, span_s, span_m, acc0_m, acc1_m).

select is(private.segment_kind(10, 20, 10, 20, 35, 35), 'walk',
  'Accuracy is subtracted from the distance');
select is(private.segment_kind(10, 55.1, 10, 55.1, 35, 35), 'fast',
  'At most 10 m per fix is subtracted: 5.51 m/s with 35 m accuracy is fast');
select is(private.segment_kind(1, 5.6, 1, 5.6, 35, 35), 'fast',
  'Over less than 10 s, the credit shrinks in proportion: 5.6 m in 1 s is fast');
select is(private.segment_kind(5, 20, 10, 40, null, null), 'fast',
  'Missing accuracy subtracts nothing');

select * from finish();
rollback;
