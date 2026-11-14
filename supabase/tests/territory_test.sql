-- pgTAP tests for territory ingestion (submit_location_batch) and reads (get_territory).
-- Run with: npx supabase test db
begin;

select plan(52);

-- Fixtures: four players, created as superuser.
insert into auth.users (id, aud, role, is_anonymous)
values
  ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'authenticated', 'authenticated', true),
  ('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 'authenticated', 'authenticated', true),
  ('cccccccc-cccc-cccc-cccc-cccccccccccc', 'authenticated', 'authenticated', true),
  ('dddddddd-dddd-dddd-dddd-dddddddddddd', 'authenticated', 'authenticated', true);

-- Points i0 .. i0 + n - 1 of a walk heading east from (lat, lng): one fix
-- every dt_s seconds, step_m meters apart, starting start_ago_s seconds ago.
create function pg_temp.pts(
  i0 int, n int, lat float8, lng float8, step_m float8, dt_s float8, start_ago_s float8,
  acc float8 default 5
)
returns jsonb
language sql
stable
as $$
  select coalesce(jsonb_agg(jsonb_build_object(
    't', ((extract(epoch from now()) - start_ago_s + i * dt_s) * 1000)::bigint,
    'lat', lat,
    'lng', lng + i * step_m / (111320 * cos(radians(lat))),
    'acc', acc,
    'spd', step_m / dt_s
  ) order by i), '[]'::jsonb)
  from generate_series(i0, i0 + n - 1) as i
$$;

-- Runs submit_location_batch as the given player.
create function pg_temp.submit_as(who uuid, batch text, session text, points jsonb)
returns jsonb
language plpgsql
as $$
declare
  result jsonb;
begin
  perform set_config('role', 'authenticated', true);
  perform set_config('request.jwt.claims',
    json_build_object('sub', who, 'role', 'authenticated')::text, true);
  result := public.submit_location_batch(batch, session, points);
  perform set_config('role', 'postgres', true);
  return result;
end;
$$;

create function pg_temp.cells_of(who uuid)
returns setof bigint
language sql
as $$ select cell from public.claimed_cells where user_id = who $$;

-- Structure and privileges ---------------------------------------------------

select has_table('public', 'claimed_cells', 'claimed_cells table exists');
select col_is_pk('public', 'claimed_cells', array['user_id', 'cell'], 'claimed_cells is unique per player and cell');
select ok(
  (select bool_and(relrowsecurity) from pg_class where oid in (
    'public.claimed_cells'::regclass, 'public.walk_points'::regclass,
    'public.walk_sessions'::regclass, 'public.location_batches'::regclass)),
  'RLS is enabled on every territory table'
);
select table_privs_are('public', 'claimed_cells', 'authenticated', array['SELECT'], 'authenticated can only SELECT claimed_cells');
select table_privs_are('public', 'walk_points', 'authenticated', array['SELECT'], 'authenticated can only SELECT walk_points');
select table_privs_are('public', 'walk_sessions', 'authenticated', array['SELECT'], 'authenticated can only SELECT walk_sessions');
select table_privs_are('public', 'location_batches', 'authenticated', array['SELECT'], 'authenticated can only SELECT location_batches');
select table_privs_are('public', 'claimed_cells', 'anon', array[]::text[], 'anon has no privileges on claimed_cells');
select table_privs_are('public', 'walk_points', 'anon', array[]::text[], 'anon has no privileges on walk_points');
select function_privs_are('public', 'submit_location_batch', array['text', 'text', 'jsonb'], 'anon', array[]::text[], 'anon cannot call submit_location_batch');
select function_privs_are('public', 'get_territory', array[]::text[], 'anon', array[]::text[], 'anon cannot call get_territory');
select is(
  (select prosecdef and proconfig @> array['search_path=""'] from pg_proc where oid = 'public.submit_location_batch(text, text, jsonb)'::regprocedure),
  true,
  'submit_location_batch is SECURITY DEFINER with an empty search_path'
);

-- Idempotency ----------------------------------------------------------------
-- Player A walks 200 m at 1.4 m/s, one fix every 5 s.

select is(
  pg_temp.submit_as('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'a-1', 'a-s1',
    pg_temp.pts(0, 29, 52.0, 13.0, 7, 5, 3600)) - 'newCells' - 'totalCells',
  '{"acceptedPoints": 29, "rejectedPoints": 0, "duplicate": false}'::jsonb,
  'A first batch is accepted'
);
select ok(
  (select count(*) from public.claimed_cells where user_id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa') > 50,
  'A first batch claims cells'
);

create temp table a_before as
select (select count(*) from public.claimed_cells where user_id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa') as cells,
  (select count(*) from public.walk_points where user_id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa') as points;

select is(
  pg_temp.submit_as('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'a-1', 'a-s1',
    pg_temp.pts(0, 29, 52.0, 13.1, 7, 5, 1800)),
  jsonb_build_object('acceptedPoints', 0, 'rejectedPoints', 0, 'newCells', 0,
    'totalCells', (select cells from a_before), 'duplicate', true),
  'A retry of the same batch id is a duplicate, even with different points'
);
select is(
  (select count(*) from public.claimed_cells where user_id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'),
  (select cells from a_before),
  'Duplicate batch claims nothing'
);
select is(
  (select count(*) from public.walk_points where user_id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'),
  (select points from a_before),
  'Duplicate batch stores no points'
);
select is(
  (select batch_count from public.walk_sessions where user_id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa' and session_id = 'a-s1'),
  1,
  'Duplicate batch does not change session stats'
);
select is(
  (pg_temp.submit_as('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'a-1b', 'a-s1',
    pg_temp.pts(0, 29, 52.0, 13.0, 7, 5, 3600)) ->> 'rejectedPoints')::int,
  29,
  'Re-sent points under a new batch id are rejected as duplicates'
);

-- Session stats.
select ok(
  (select distance_on_foot_m between 190 and 200 and point_count = 29 and rejected_count = 29
     and batch_count = 2 and new_cells > 50
     and last_point_at - first_point_at = interval '140 seconds'
   from public.walk_sessions where user_id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa' and session_id = 'a-s1'),
  'Session stats track points, rejects, distance on foot, and new cells'
);

-- Cross-batch connection -----------------------------------------------------
-- The same 20-fix walk (1.4 m/s, a fix every 60 s, so 84 m apart) is sent three ways:
-- B in one batch, C in two batches in order, D in two batches out of order.

select lives_ok(
  $$ select pg_temp.submit_as('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 'b-1', 'b-s1',
       pg_temp.pts(0, 20, 48.0, 2.0, 84, 60, 7200)) $$,
  'B sends the walk in one batch'
);
select lives_ok(
  $$ select pg_temp.submit_as('cccccccc-cccc-cccc-cccc-cccccccccccc', 'c-1', 'c-s1',
       pg_temp.pts(0, 10, 48.0, 2.0, 84, 60, 7200));
     select pg_temp.submit_as('cccccccc-cccc-cccc-cccc-cccccccccccc', 'c-2', 'c-s1',
       pg_temp.pts(10, 10, 48.0, 2.0, 84, 60, 7200)) $$,
  'C sends the walk in two batches'
);
select lives_ok(
  $$ select pg_temp.submit_as('dddddddd-dddd-dddd-dddd-dddddddddddd', 'd-2', 'd-s1',
       pg_temp.pts(10, 10, 48.0, 2.0, 84, 60, 7200));
     select pg_temp.submit_as('dddddddd-dddd-dddd-dddd-dddddddddddd', 'd-1', 'd-s1',
       pg_temp.pts(0, 10, 48.0, 2.0, 84, 60, 7200)) $$,
  'D sends the walk in two batches, second batch first'
);
select set_eq(
  $$ select * from pg_temp.cells_of('cccccccc-cccc-cccc-cccc-cccccccccccc') $$,
  $$ select * from pg_temp.cells_of('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb') $$,
  'Two in-order batches claim exactly the cells of one batch'
);
select set_eq(
  $$ select * from pg_temp.cells_of('dddddddd-dddd-dddd-dddd-dddddddddddd') $$,
  $$ select * from pg_temp.cells_of('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb') $$,
  'Two out-of-order batches claim exactly the cells of one batch'
);
select is(
  (select round(distance_on_foot_m) from public.walk_sessions where user_id = 'dddddddd-dddd-dddd-dddd-dddddddddddd'),
  (select round(distance_on_foot_m) from public.walk_sessions where user_id = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb'),
  'Out-of-order batches give the same distance on foot'
);
select is(
  (select sum(new_cells)::int from public.walk_sessions where user_id = 'dddddddd-dddd-dddd-dddd-dddddddddddd'),
  (select count(*)::int from public.claimed_cells where user_id = 'dddddddd-dddd-dddd-dddd-dddddddddddd'),
  'Session new_cells adds up to the claimed total'
);
-- 1596 m walk: strip of about 1596 x 60 m plus round ends.
select ok(
  (select count(*) * 19.109257 ^ 2 * cos(radians(48.0)) ^ 2
   from public.claimed_cells where user_id = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb')
    between 0.75 * (1596 * 60 + 2827) and 1.25 * (1596 * 60 + 2827),
  'A 1596 m walk claims about a 60 m wide strip'
);

-- Speed, gap, and accuracy rules (player C, new sessions) --------------------

-- Car: 15 m/s, a fix every 2 s. Every segment is too fast.
select is(
  pg_temp.submit_as('cccccccc-cccc-cccc-cccc-cccccccccccc', 'c-car', 'c-car',
    pg_temp.pts(0, 50, 50.0, 8.0, 30, 2, 3600)) - 'totalCells',
  '{"acceptedPoints": 50, "rejectedPoints": 0, "newCells": 0, "duplicate": false}'::jsonb,
  'A car trip at 15 m/s claims nothing'
);
select is(
  (select distance_on_foot_m from public.walk_sessions where user_id = 'cccccccc-cccc-cccc-cccc-cccccccccccc' and session_id = 'c-car'),
  0::float8,
  'A car trip adds no distance on foot'
);

-- Time gap: two fixes 50 m apart, 5 minutes apart. Each claims a disk; the line between them is not claimed.
select lives_ok(
  $$ select pg_temp.submit_as('cccccccc-cccc-cccc-cccc-cccccccccccc', 'c-gap', 'c-gap',
       pg_temp.pts(0, 2, 51.0, 9.0, 50, 300, 3600)) $$,
  'C sends two fixes with a 5 minute gap'
);
-- Distance gap: 300 m in 100 s (3 m/s, plausible speed but too far to bridge).
select lives_ok(
  $$ select pg_temp.submit_as('cccccccc-cccc-cccc-cccc-cccccccccccc', 'c-far', 'c-far',
       pg_temp.pts(0, 2, 51.0, 10.0, 300, 100, 3600)) $$,
  'C sends two fixes 300 m apart'
);
select set_eq(
  $$ select cell from public.claimed_cells
     where user_id = 'cccccccc-cccc-cccc-cccc-cccccccccccc'
       and cell not in (select * from pg_temp.cells_of('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb')) $$,
  $$ select private.cells_near(extensions.st_transform(extensions.st_setsrid(extensions.st_makepoint(lng, lat), 4326), 3857), 30)
     from (values
       (51.0, 9.0), (51.0, 9.0 + 50 / (111320 * cos(radians(51.0)))),
       (51.0, 10.0), (51.0, 10.0 + 300 / (111320 * cos(radians(51.0))))
     ) as p (lat, lng) $$,
  'Gaps claim a disk around each isolated fix and nothing in between'
);

-- Accuracy, time, duplicate, and malformed points.
select is(
  pg_temp.submit_as('cccccccc-cccc-cccc-cccc-cccccccccccc', 'c-bad', 'c-bad',
    jsonb_build_array(
      pg_temp.pts(0, 1, 49.0, 7.0, 0, 1, 600) -> 0,                       -- good
      pg_temp.pts(1, 1, 49.0, 7.0, 0, 1, 600, 36) -> 0,                   -- accuracy 36 m
      jsonb_set(pg_temp.pts(2, 1, 49.0, 7.0, 0, 1, 600) -> 0, '{acc}', 'null'),
      pg_temp.pts(0, 1, 49.0, 7.0, 0, 1, -600) -> 0,                      -- 10 minutes in the future
      pg_temp.pts(0, 1, 49.0, 7.0, 0, 1, 8 * 86400) -> 0,                 -- 8 days old
      pg_temp.pts(0, 1, 49.0, 7.0, 0, 1, 600) -> 0,                       -- duplicate of the first
      jsonb_set(pg_temp.pts(3, 1, 49.0, 7.0, 0, 1, 600) -> 0, '{lat}', '"49"'),
      jsonb_set(pg_temp.pts(4, 1, 49.0, 7.0, 0, 1, 600) -> 0, '{lat}', '91'),
      jsonb_set(pg_temp.pts(5, 1, 49.0, 7.0, 0, 1, 600) -> 0, '{t}', '1e400'),
      '"not an object"'::jsonb,
      pg_temp.pts(6, 1, 49.0, 7.0, 0, 1, 600, 35) -> 0                    -- accuracy 35 m, accepted
    )) - 'newCells' - 'totalCells',
  '{"acceptedPoints": 2, "rejectedPoints": 9, "duplicate": false}'::jsonb,
  'Bad accuracy, future, stale, duplicate, and malformed points are rejected'
);
select is(
  (select rejected_count from public.walk_sessions where user_id = 'cccccccc-cccc-cccc-cccc-cccccccccccc' and session_id = 'c-bad'),
  9,
  'Rejected points are counted in the session'
);

-- Input limits.
select throws_ok(
  $$ select pg_temp.submit_as('cccccccc-cccc-cccc-cccc-cccccccccccc', 'c-big', 'c-big',
       pg_temp.pts(0, 501, 49.0, 7.0, 1, 1, 3600)) $$,
  '22023', null,
  'A batch of more than 500 points is refused'
);
select throws_ok(
  $$ select pg_temp.submit_as('cccccccc-cccc-cccc-cccc-cccccccccccc', 'c-obj', 'c-obj', '{}') $$,
  '22023', null,
  'A non-array payload is refused'
);
select throws_ok(
  $$ select pg_temp.submit_as('cccccccc-cccc-cccc-cccc-cccccccccccc', '', 'c-obj', '[]') $$,
  '22023', null,
  'An empty batch id is refused'
);

-- Isolation and RLS ----------------------------------------------------------

set local role authenticated;
set local request.jwt.claims = '{"sub": "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb", "role": "authenticated"}';

select is(
  (select count(*)::int from public.claimed_cells where user_id <> 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb'),
  0,
  'B cannot read other players'' cells'
);
select is(
  (select count(*)::int from public.walk_points where user_id <> 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb'),
  0,
  'B cannot read other players'' points'
);
select is(
  (select count(*)::int from public.walk_sessions) + (select count(*)::int from public.location_batches),
  2,
  'B sees only their own session and batch'
);
select is(
  (public.submit_location_batch('a-1', 'b-s2', pg_temp.pts(0, 2, 47.0, 1.0, 5, 5, 600)) ->> 'duplicate')::boolean,
  false,
  'Batch ids are scoped per player'
);
select throws_ok(
  $$ insert into public.claimed_cells (user_id, cell, first_claimed_at)
     values ('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 1, now()) $$,
  '42501', null,
  'B cannot insert cells directly'
);
select throws_ok(
  $$ insert into public.walk_points (user_id, session_id, batch_id, recorded_at, geom, accuracy_m)
     values ('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 'x', 'x', now(), extensions.st_setsrid(extensions.st_makepoint(0, 0), 4326), 1) $$,
  '42501', null,
  'B cannot insert points directly'
);
select throws_ok(
  $$ delete from public.claimed_cells $$,
  '42501', null,
  'B cannot delete cells'
);
select throws_ok(
  $$ select private.purge_walk_points() $$,
  '42501', null,
  'B cannot call internal functions'
);

-- Read shape -----------------------------------------------------------------

select is(
  (select jsonb_build_object(
     'type', t -> 'claimed' ->> 'type',
     'features', jsonb_array_length(t -> 'claimed' -> 'features'),
     'geometry', t -> 'claimed' -> 'features' -> 0 -> 'geometry' ->> 'type',
     'cells', (t ->> 'totalCells')::int = (select count(*) from public.claimed_cells),
     'area', (t ->> 'areaM2')::float8 / ((select count(*) from public.claimed_cells) * 19.109257 ^ 2 * cos(radians(48.0)) ^ 2) between 0.97 and 1.03
   ) from (select public.get_territory() as t offset 0) x),
  '{"type": "FeatureCollection", "features": 2, "geometry": "Polygon", "cells": true, "area": true}'::jsonb,
  'get_territory returns merged polygons, totalCells, and areaM2'
);
select ok(
  (select bool_and((c ->> 0)::float8 between 0.9 and 2.2 and (c ->> 1)::float8 between 46.9 and 48.1)
   from (select public.get_territory() as t offset 0) x,
     jsonb_array_elements(t -> 'claimed' -> 'features') f,
     jsonb_array_elements(f -> 'geometry' -> 'coordinates' -> 0) c),
  'Coordinates are [lng, lat] in WGS84'
);

-- A player with no land.
set local request.jwt.claims = '{"sub": "eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee", "role": "authenticated"}';
select is(
  public.get_territory(),
  '{"claimed": {"type": "FeatureCollection", "features": []}, "totalCells": 0, "areaM2": 0}'::jsonb,
  'A new player gets an empty FeatureCollection'
);

-- Signed out.
set local role anon;
set local request.jwt.claims = '{"role": "anon"}';
select throws_ok(
  $$ select public.submit_location_batch('x', 'x', '[]') $$,
  '42501', null,
  'anon cannot submit'
);
select throws_ok(
  $$ select * from public.claimed_cells $$,
  '42501', null,
  'anon cannot read cells'
);

reset role;

-- Retention for the temporary walk_points table.
update public.walk_points set created_at = now() - interval '31 days'
where user_id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
select is(
  private.purge_walk_points(),
  29::bigint,
  'purge_walk_points deletes points older than 30 days'
);

select * from finish();
rollback;
