-- pgTAP tests for territory ingestion (submit_location_batch, close_walk_session) and reads (get_territory).
-- Run with: npx supabase test db
begin;

select plan(89);

-- Fixtures: four players, created as superuser.
insert into auth.users (id, aud, role, is_anonymous)
values
  ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'authenticated', 'authenticated', true),
  ('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 'authenticated', 'authenticated', true),
  ('cccccccc-cccc-cccc-cccc-cccccccccccc', 'authenticated', 'authenticated', true),
  ('dddddddd-dddd-dddd-dddd-dddddddddddd', 'authenticated', 'authenticated', true),
  ('10000000-0000-0000-0000-000000000001', 'authenticated', 'authenticated', true),
  ('10000000-0000-0000-0000-000000000002', 'authenticated', 'authenticated', true),
  ('10000000-0000-0000-0000-000000000003', 'authenticated', 'authenticated', true),
  ('10000000-0000-0000-0000-000000000004', 'authenticated', 'authenticated', true),
  ('10000000-0000-0000-0000-000000000005', 'authenticated', 'authenticated', true),
  ('10000000-0000-0000-0000-000000000006', 'authenticated', 'authenticated', true),
  ('10000000-0000-0000-0000-000000000007', 'authenticated', 'authenticated', true);

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

-- Runs submit_location_batch as the given player. The reward field is left
-- out here; economy_test.sql covers it.
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
  result := public.submit_location_batch(batch, session, points) - 'reward';
  perform set_config('role', 'postgres', true);
  return result;
end;
$$;

-- Runs close_walk_session as the given player, without the reward field.
create function pg_temp.close_as(who uuid, session text)
returns jsonb
language plpgsql
as $$
declare
  result jsonb;
begin
  perform set_config('role', 'authenticated', true);
  perform set_config('request.jwt.claims',
    json_build_object('sub', who, 'role', 'authenticated')::text, true);
  result := public.close_walk_session(session) - 'reward';
  perform set_config('role', 'postgres', true);
  return result;
end;
$$;

-- A track heading east from (lat, lng), starting start_ago_s seconds ago, made
-- of legs {n, step_m, dt_s}: after the first fix, each leg adds n fixes,
-- step_m meters and dt_s seconds apart.
create function pg_temp.legs(lat float8, lng float8, start_ago_s float8, legs float8[])
returns jsonb
language plpgsql
stable
as $$
declare
  leg float8[];
  t float8 := extract(epoch from now()) - start_ago_s;
  x float8 := 0;
  spd float8 := 0;
  result jsonb := '[]';
begin
  result := result || jsonb_build_object('t', (t * 1000)::bigint, 'lat', lat, 'lng', lng, 'acc', 5, 'spd', 0);
  if cardinality(legs) = 0 then
    return result;
  end if;
  foreach leg slice 1 in array legs loop
    for i in 1 .. leg[1]::int loop
      t := t + leg[3];
      x := x + leg[2];
      spd := leg[2] / leg[3];
      result := result || jsonb_build_object(
        't', (t * 1000)::bigint,
        'lat', lat,
        'lng', lng + x / (111320 * cos(radians(lat))),
        'acc', 5,
        'spd', spd);
    end loop;
  end loop;
  return result;
end;
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

-- Cells of every walking segment of a session, as the old rule claimed them.
create function pg_temp.walk_cells(who uuid, session text)
returns setof bigint
language sql
as $$
  select distinct private.cells_near(extensions.st_transform(extensions.st_makeline(prev, geom), 3857), 30)
  from (
    select geom, lag(geom) over w as prev,
      private.segment_kind(
        extract(epoch from recorded_at - lag(recorded_at) over w)::float8,
        extensions.st_distance(lag(geom) over w::extensions.geography, geom::extensions.geography, false)) as kind
    from public.walk_points
    where user_id = who and session_id = session
    window w as (order by recorded_at)
  ) s
  where kind = 'walk'
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
select function_privs_are('public', 'close_walk_session', array['text'], 'anon', array[]::text[], 'anon cannot call close_walk_session');
select function_privs_are('public', 'close_walk_session', array['text'], 'authenticated', array['EXECUTE'], 'authenticated can call close_walk_session');
select is(
  (select prosecdef and proconfig @> array['search_path=""'] from pg_proc where oid = 'public.close_walk_session(text)'::regprocedure),
  true,
  'close_walk_session is SECURITY DEFINER with an empty search_path'
);
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
  (select count(*) from public.claimed_cells where user_id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa') > 10,
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
     and batch_count = 2 and new_cells > 10
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
-- The last minute of each walk is claimed when the session is closed.
select is(
  (select array_agg((r ->> 'closed')::boolean and (r ->> 'newCells')::int > 0)
   from (values
     (pg_temp.close_as('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 'b-s1')),
     (pg_temp.close_as('cccccccc-cccc-cccc-cccc-cccccccccccc', 'c-s1')),
     (pg_temp.close_as('dddddddd-dddd-dddd-dddd-dddddddddddd', 'd-s1'))) v (r)),
  array[true, true, true],
  'Closing B, C, and D claims the end of each walk'
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
-- (Both gap tests start well after the car trip ended, so the vehicle buffer doesn't apply.)
select lives_ok(
  $$ select pg_temp.submit_as('cccccccc-cccc-cccc-cccc-cccccccccccc', 'c-gap', 'c-gap',
       pg_temp.pts(0, 2, 51.0, 9.0, 50, 300, 2400));
     select pg_temp.close_as('cccccccc-cccc-cccc-cccc-cccccccccccc', 'c-gap') $$,
  'C sends two fixes with a 5 minute gap'
);
-- Distance gap: 300 m in 100 s (3 m/s, plausible speed but too far to bridge).
select lives_ok(
  $$ select pg_temp.submit_as('cccccccc-cccc-cccc-cccc-cccccccccccc', 'c-far', 'c-far',
       pg_temp.pts(0, 2, 51.0, 10.0, 300, 100, 1800));
     select pg_temp.close_as('cccccccc-cccc-cccc-cccc-cccccccccccc', 'c-far') $$,
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

-- Vehicle buffer --------------------------------------------------------------
-- Nothing is claimed within 120 s of a fast segment (any session of the player),
-- and a segment is claimed only once the next 120 s of its session are known
-- or the session is closed. Car: 15 m/s, a fix every 2 s. Walk: 1.4 m/s, a fix every 5 s.

-- Red light (player 1): drive 40 s, stop 20 s, creep at 0.5 m/s for 20 s, drive 40 s.
select is(
  (pg_temp.submit_as('10000000-0000-0000-0000-000000000001', 'r-1', 'r-s1',
    pg_temp.legs(40.0, 5.0, 3000, array[[20, 30, 2], [10, 0, 2], [10, 1, 2], [20, 30, 2]])) ->> 'newCells')::int,
  0,
  'A car stopped at a red light claims nothing'
);
select is(
  pg_temp.close_as('10000000-0000-0000-0000-000000000001', 'r-s1') - 'totalCells',
  '{"newCells": 0, "closed": true}'::jsonb,
  'A car stopped at a red light claims nothing after the session closes'
);

-- Long red light at the end of batch 1 (player 2): drive 40 s, then 200 s at
-- 0.5 m/s. The car drives on in batch 2.
create temp table light as
select pg_temp.legs(40.1, 5.0, 3000, array[[20, 30, 2], [100, 1, 2], [20, 30, 2]]) as track;
select is(
  (pg_temp.submit_as('10000000-0000-0000-0000-000000000002', 'l-1', 'l-s1',
    (select pg_temp.slice(track, 1, 121) from light)) ->> 'newCells')::int,
  0,
  'The slow tail of a batch is not claimed yet'
);
select is(
  (pg_temp.submit_as('10000000-0000-0000-0000-000000000002', 'l-2', 'l-s1',
    (select pg_temp.slice(track, 122, 141) from light)) ->> 'newCells')::int
  + (pg_temp.close_as('10000000-0000-0000-0000-000000000002', 'l-s1') ->> 'newCells')::int,
  0,
  'Driving on in the next batch means the slow tail is never claimed'
);
-- Control (player 7): the same batch 1 with no drive after it. Closing claims
-- the slow segments that start more than 120 s after the first drive.
select is(
  (pg_temp.submit_as('10000000-0000-0000-0000-000000000007', 'l-ctl', 'l-ctl',
    (select pg_temp.slice(track, 1, 121) from light)) ->> 'newCells')::int,
  0,
  'Control: the slow tail is not claimed before close'
);
select ok(
  (pg_temp.close_as('10000000-0000-0000-0000-000000000007', 'l-ctl') ->> 'newCells')::int > 0,
  'Control: without a drive after it, the slow tail is claimed on close'
);

-- Walking after a drive (player 3): drive 60 s, then walk 360 s in the same session.
select is(
  (pg_temp.submit_as('10000000-0000-0000-0000-000000000003', 'w-1', 'w-s1',
    pg_temp.legs(40.2, 5.0, 2000, array[[30, 30, 2], [72, 7, 5]])) ->> 'newCells')::int > 0,
  true,
  'Walking for 6 minutes after a drive claims land'
);
select ok(
  (select min(first_claimed_at) >= now() - interval '2000 seconds' + interval '60 seconds' + interval '119.9 seconds'
     and max(first_claimed_at) <= now() - interval '2000 seconds' + interval '420 seconds' - interval '119.9 seconds'
   from public.claimed_cells where user_id = '10000000-0000-0000-0000-000000000003'),
  'Only walking more than 120 s after the drive and 120 s before the last fix is claimed'
);
-- (A statement doesn't see the rows its own function calls insert, so results are checked in a later statement.)
create temp table w_close as
select pg_temp.close_as('10000000-0000-0000-0000-000000000003', 'w-s1') as r;
select ok(
  (select (r ->> 'newCells')::int > 0 from w_close)
  and (select max(first_claimed_at) from public.claimed_cells where user_id = '10000000-0000-0000-0000-000000000003')
    between now() - interval '1580.01 seconds' and now() - interval '1579.99 seconds',
  'Closing the session claims the walk up to the last fix'
);

-- Plain walk (player 4): 180 s, then the session is closed, then a late batch.
create temp table plain as
select pg_temp.legs(40.3, 5.0, 1500, array[[48, 7, 5]]) as track;
select is(
  (pg_temp.submit_as('10000000-0000-0000-0000-000000000004', 'p-1', 'p-s1',
    (select pg_temp.slice(track, 1, 37) from plain)) ->> 'newCells')::int > 0,
  true,
  'A plain walk claims land right away'
);
select ok(
  (select max(first_claimed_at) <= now() - interval '1500 seconds' + interval '180 seconds' - interval '119.9 seconds'
   from public.claimed_cells where user_id = '10000000-0000-0000-0000-000000000004'),
  'The last 120 s of a walk are not claimed before the session closes'
);
create temp table p_open as
select count(*) as cells from public.claimed_cells where user_id = '10000000-0000-0000-0000-000000000004';
create temp table p_close as
select pg_temp.close_as('10000000-0000-0000-0000-000000000004', 'p-s1') as r;
select is(
  (select r from p_close),
  jsonb_build_object(
    'newCells', (select count(*) from public.claimed_cells where user_id = '10000000-0000-0000-0000-000000000004') - (select cells from p_open),
    'totalCells', (select count(*) from public.claimed_cells where user_id = '10000000-0000-0000-0000-000000000004'),
    'closed', true),
  'close_walk_session returns newCells, totalCells, and closed'
);
select ok(
  (select count(*) from public.claimed_cells where user_id = '10000000-0000-0000-0000-000000000004') > (select cells from p_open),
  'Closing claims the last 120 s'
);
select set_eq(
  $$ select * from pg_temp.cells_of('10000000-0000-0000-0000-000000000004') $$,
  $$ select * from pg_temp.walk_cells('10000000-0000-0000-0000-000000000004', 'p-s1') $$,
  'After close, a plain walk owns exactly the strip of every walking segment'
);
select is(
  (select sum(new_cells)::int from public.walk_sessions where user_id = '10000000-0000-0000-0000-000000000004'),
  (select count(*)::int from public.claimed_cells where user_id = '10000000-0000-0000-0000-000000000004'),
  'Session new_cells includes the cells claimed on close'
);
update public.walk_sessions set closed_at = '2026-01-01T00:00:00Z'
where user_id = '10000000-0000-0000-0000-000000000004' and session_id = 'p-s1';
select is(
  pg_temp.close_as('10000000-0000-0000-0000-000000000004', 'p-s1') - 'totalCells',
  '{"newCells": 0, "closed": true}'::jsonb,
  'Closing twice claims nothing more'
);
select is(
  (select closed_at from public.walk_sessions where user_id = '10000000-0000-0000-0000-000000000004' and session_id = 'p-s1'),
  '2026-01-01T00:00:00Z'::timestamptz,
  'Closing twice keeps the first closed_at'
);
create temp table p_late as
select pg_temp.submit_as('10000000-0000-0000-0000-000000000004', 'p-2', 'p-s1',
  (select pg_temp.slice(track, 38, 49) from plain)) as r;
select ok(
  (select (r ->> 'newCells')::int > 0 from p_late)
  and (select max(first_claimed_at) from public.claimed_cells where user_id = '10000000-0000-0000-0000-000000000004')
    between now() - interval '1260.01 seconds' and now() - interval '1259.99 seconds',
  'A batch for a closed session is processed and claimed up to its last fix'
);
select is(
  pg_temp.close_as('10000000-0000-0000-0000-000000000004', 'no-such-session'),
  jsonb_build_object('newCells', 0,
    'totalCells', (select count(*) from public.claimed_cells where user_id = '10000000-0000-0000-0000-000000000004'),
    'closed', false),
  'Closing an unknown session returns closed false'
);
select is(
  (select count(*)::int from public.walk_sessions where session_id = 'no-such-session'),
  0,
  'Closing an unknown session creates nothing'
);

-- Cross-session (player 5).
-- Drive in session x-car (ends 1140 s ago), start session x-walk 10 s later and walk 180 s.
select lives_ok(
  $$ select pg_temp.submit_as('10000000-0000-0000-0000-000000000005', 'x-1', 'x-car',
       pg_temp.legs(40.4, 5.0, 1200, array[[30, 30, 2]]));
     select pg_temp.close_as('10000000-0000-0000-0000-000000000005', 'x-car');
     select pg_temp.submit_as('10000000-0000-0000-0000-000000000005', 'x-2', 'x-walk',
       pg_temp.legs(40.4, 5.1, 1130, array[[36, 7, 5]]));
     select pg_temp.close_as('10000000-0000-0000-0000-000000000005', 'x-walk') $$,
  'A player drives, stops tracking, and starts a walk 10 s later'
);
select ok(
  (select count(*) > 0 and min(first_claimed_at) >= now() - interval '1140 seconds' + interval '119.9 seconds'
   from public.claimed_cells where user_id = '10000000-0000-0000-0000-000000000005'),
  'A drive in another session blocks the first 120 s of the walk'
);
-- Walk 180 s in x-walk2 (ends 720 s ago), then drive in x-car2 from 20 s later.
select lives_ok(
  $$ select pg_temp.submit_as('10000000-0000-0000-0000-000000000005', 'x-3', 'x-walk2',
       pg_temp.legs(40.4, 5.2, 900, array[[36, 7, 5]]));
     select pg_temp.submit_as('10000000-0000-0000-0000-000000000005', 'x-4', 'x-car2',
       pg_temp.legs(40.4, 5.3, 700, array[[30, 30, 2]]));
     select pg_temp.close_as('10000000-0000-0000-0000-000000000005', 'x-walk2') $$,
  'A player walks, stops tracking, and drives 20 s later'
);
select ok(
  (select count(*) > 0 and max(first_claimed_at) <= now() - interval '720 seconds' - interval '99.9 seconds'
   from public.claimed_cells
   where user_id = '10000000-0000-0000-0000-000000000005' and first_claimed_at > now() - interval '900 seconds'),
  'A drive in a later session blocks the last 120 s before it'
);

-- Isolated points (player 6).
select is(
  (pg_temp.submit_as('10000000-0000-0000-0000-000000000006', 'i-1', 'i-one',
    pg_temp.legs(40.5, 5.0, 1000, array[]::float8[])) ->> 'newCells')::int,
  0,
  'A lone fix is not claimed before its session closes'
);
select is(
  (pg_temp.close_as('10000000-0000-0000-0000-000000000006', 'i-one') ->> 'newCells')::int,
  (select count(*)::int from private.cells_near(
    extensions.st_transform(extensions.st_setsrid(extensions.st_makepoint(5.0, 40.5), 4326), 3857), 30)),
  'Closing claims the disk around a lone fix'
);
select is(
  (pg_temp.submit_as('10000000-0000-0000-0000-000000000006', 'i-2', 'i-car',
     pg_temp.legs(40.5, 5.1, 600, array[[30, 30, 2]])) ->> 'newCells')::int
  + (pg_temp.close_as('10000000-0000-0000-0000-000000000006', 'i-car') ->> 'newCells')::int
  + (pg_temp.submit_as('10000000-0000-0000-0000-000000000006', 'i-3', 'i-two',
     pg_temp.legs(40.5, 5.2, 510, array[]::float8[])) ->> 'newCells')::int
  + (pg_temp.close_as('10000000-0000-0000-0000-000000000006', 'i-two') ->> 'newCells')::int,
  0,
  'A lone fix 30 s after a drive claims nothing'
);
select is(
  (pg_temp.submit_as('10000000-0000-0000-0000-000000000006', 'i-4', 'i-gap',
    pg_temp.legs(40.5, 5.3, 300, array[[1, 50, 150]])) ->> 'newCells')::int,
  (select count(*)::int from private.cells_near(
    extensions.st_transform(extensions.st_setsrid(extensions.st_makepoint(5.3, 40.5), 4326), 3857), 30)),
  'A lone fix followed by a fix 150 s later claims its disk right away'
);

-- Validation.
select throws_ok(
  $$ select pg_temp.close_as('10000000-0000-0000-0000-000000000007', '') $$,
  '22023', null,
  'close_walk_session refuses an empty session id'
);
select throws_ok(
  $$ select pg_temp.close_as('10000000-0000-0000-0000-000000000007', null) $$,
  '22023', null,
  'close_walk_session refuses a null session id'
);
select throws_ok(
  $$ select pg_temp.close_as('10000000-0000-0000-0000-000000000007', repeat('x', 65)) $$,
  '22023', null,
  'close_walk_session refuses a session id over 64 characters'
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
select is(
  (select (r ->> 'closed')::boolean and (r ->> 'newCells')::int > 0
   from (select public.close_walk_session('b-s2') as r offset 0) x),
  true,
  'Closing a session claims its last segment'
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
  $$ select public.close_walk_session('x') $$,
  '42501', null,
  'anon cannot close a session'
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
