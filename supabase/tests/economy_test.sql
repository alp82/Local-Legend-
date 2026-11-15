-- pgTAP tests for the economy: starting resources, walking pay, daily caps,
-- the Keep tax and the 4 a.m. reset, terrain, Ruler XP, and privileges.
-- Run with: npx supabase test db
begin;

select plan(93);

insert into auth.users (id, aud, role, is_anonymous)
select ('e0000000-0000-0000-0000-0000000000' || lpad(i::text, 2, '0'))::uuid, 'authenticated', 'authenticated', true
from generate_series(1, 12) as i;

-- e01: first walk and retries. e02: daily cap. e03, e04: walking across the
-- reset. e05 to e08: Keep tax. e09, e10: out-of-order batches. e11: get_economy.
-- e12: privileges.

-- ---------------------------------------------------------------------------
-- Helpers
-- ---------------------------------------------------------------------------

-- A walk back and forth on an east-west line at (lat, lng): passes of seg
-- steps of step_m meters, one fix every dt_s seconds from t0. It starts at the
-- west end; each pass ends where the next turns.
create function pg_temp.shuttle(
  lat float8, lng float8, t0 timestamptz, passes int,
  seg int default 71, step_m float8 default 14, dt_s float8 default 10
)
returns jsonb
language sql
stable
as $$
  select jsonb_agg(jsonb_build_object(
    't', (extract(epoch from t0 + make_interval(secs => i * dt_s)) * 1000)::bigint,
    'lat', lat,
    'lng', lng + step_m * (seg - abs(seg - (i % (2 * seg)))) / (111320 * cos(radians(lat))),
    'acc', 5,
    'spd', step_m / dt_s
  ) order by i)
  from generate_series(0, passes * seg) as i
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

-- Every other element of a JSON array, starting with the first (odd = false)
-- or the second (odd = true).
create function pg_temp.alternate(a jsonb, odd boolean)
returns jsonb
language sql
immutable
as $$
  select coalesce(jsonb_agg(e order by o), '[]') from jsonb_array_elements(a) with ordinality as x (e, o)
  where (o % 2 = 0) = odd
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

create function pg_temp.economy_as(who uuid, tz text default null)
returns jsonb
language plpgsql
as $$
declare
  result jsonb;
begin
  perform pg_temp.act_as(who);
  result := public.get_economy(tz);
  perform set_config('role', 'postgres', true);
  return result;
end;
$$;

-- Exact balances.
create function pg_temp.bal(who uuid)
returns jsonb
language sql
as $$
  select jsonb_build_object('gold', gold, 'wood', wood, 'stone', stone, 'crystal', crystal, 'gems', gems, 'xp', ruler_xp)
  from public.player_economy where user_id = who
$$;

-- Balance change since a snapshot.
create function pg_temp.delta(who uuid, before jsonb)
returns jsonb
language sql
as $$
  select jsonb_object_agg(k, (pg_temp.bal(who) ->> k)::numeric - (before ->> k)::numeric)
  from jsonb_object_keys(before) k
$$;

-- New-ground km of all the player's land, by definition: each cell's ground
-- area divided by the 60 m strip, rounded per cell like the server.
create function pg_temp.land_km(who uuid)
returns numeric
language sql
as $$
  select coalesce(sum(round(((k.s / cosh((20037508.342789244 - ((c.cell % k.n) + 0.5) * k.s) / 6378137.0)) ^ 2
    / 60.0 / 1000)::numeric, 6)), 0)
  from public.claimed_cells c, (select private.cell_size_3857() as s, (2 ^ 21)::bigint as n) k
  where c.user_id = who
$$;

-- Length of a session's track in km, segment by segment, rounded per segment
-- like the server.
create function pg_temp.path_km(who uuid, session text)
returns numeric
language sql
as $$
  select coalesce(sum(round((d / 1000)::numeric, 6)), 0)
  from (
    select extensions.st_distance(lag(geom) over w::extensions.geography, geom::extensions.geography, false) as d
    from public.walk_points
    where user_id = who and session_id = session
    window w as (order by recorded_at)
  ) s
  where d is not null
$$;

-- A local time on the local date `days` days before today, in a time zone.
create function pg_temp.local_at(tz text, days int, hhmm text)
returns timestamptz
language sql
stable
as $$
  select ((((now() at time zone tz)::date - days)::text || ' ' || hhmm)::timestamp) at time zone tz
$$;

-- ---------------------------------------------------------------------------
-- Rules in SQL match the generated rules
-- ---------------------------------------------------------------------------

select is(private.economy_rules() -> 'startingResources',
  '{"gold": 2000, "wood": 20, "stone": 20, "crystal": 0, "gems": 0}'::jsonb,
  'SQL rules carry the starting resources from the sheet');
select is((private.economy_rules() ->> 'dailyResetHour')::int, 4, 'Days reset at 4 a.m.');

-- XP table and bands.
select is(array[private.ruler_level(0), private.ruler_level(99), private.ruler_level(100), private.ruler_level(349),
                private.ruler_level(350), private.ruler_level(48849), private.ruler_level(48850), private.ruler_level(1e9)],
  array[1, 1, 2, 2, 3, 29, 30, 30], 'Ruler levels follow the XP table, capped at level 30');
select is(array[
    private.new_ground_xp_upto(0, private.economy_rules() -> 'xp' -> 'newGround' -> 'bands'),
    private.new_ground_xp_upto(2.5, private.economy_rules() -> 'xp' -> 'newGround' -> 'bands'),
    private.new_ground_xp_upto(3, private.economy_rules() -> 'xp' -> 'newGround' -> 'bands'),
    private.new_ground_xp_upto(4, private.economy_rules() -> 'xp' -> 'newGround' -> 'bands'),
    private.new_ground_xp_upto(6, private.economy_rules() -> 'xp' -> 'newGround' -> 'bands'),
    private.new_ground_xp_upto(7.5, private.economy_rules() -> 'xp' -> 'newGround' -> 'bands')],
  array[0, 250, 300, 350, 450, 480]::numeric[],
  'New-ground XP: 100 per km for 3 km, 50 for the next 3, then 20');

-- Game days.
select is(private.game_day('2026-11-10 03:59:59 Europe/Warsaw', 'Europe/Warsaw'), date '2026-11-09', '03:59 belongs to the day before');
select is(private.game_day('2026-11-10 04:00:00 Europe/Warsaw', 'Europe/Warsaw'), date '2026-11-10', '04:00 starts the day');
select is(
  array[private.game_day('2026-11-10 14:30 UTC', 'Pacific/Kiritimati'), private.game_day('2026-11-10 14:30 UTC', 'America/Los_Angeles')],
  array[date '2026-11-11', date '2026-11-10'],
  'The same moment is a different game day in different zones');

-- ---------------------------------------------------------------------------
-- Starting resources and the first walk (e01, Warsaw)
-- ---------------------------------------------------------------------------

select is(pg_temp.economy_as('e0000000-0000-0000-0000-000000000001', 'Europe/Warsaw') -> 'resources',
  '{"gold": 2300, "wood": 20, "stone": 20, "crystal": 0, "gems": 0}'::jsonb,
  'A new player starts with 2,000 gold, 20 wood, and 20 stone, plus the first Keep tax (300)');

create temp table snap (name text primary key, v jsonb);
insert into snap values ('e01_before_walk', pg_temp.bal('e0000000-0000-0000-0000-000000000001'));

-- 994 m east in 71 steps of 14 m, 3 hours ago, in two batches.
create temp table walk1 as
select pg_temp.shuttle(52.0, 13.0, now() - interval '3 hours', 1) as pts;

select is(pg_temp.submit_as('e0000000-0000-0000-0000-000000000001', 'e01-b1', 'e01-s1', pg_temp.slice((select pts from walk1), 1, 40)) ->> 'duplicate',
  'false', 'First batch is processed');
select ok(pg_temp.submit_as('e0000000-0000-0000-0000-000000000001', 'e01-b2', 'e01-s1', pg_temp.slice((select pts from walk1), 41, 72)) -> 'reward' is not null,
  'Second batch pays for the stretch it settles');
select ok((pg_temp.close_as('e0000000-0000-0000-0000-000000000001', 'e01-s1') -> 'reward' ->> 'newGroundKm')::numeric > 0,
  'Closing pays for the last two minutes');

-- The strip is rounded to whole cells: this east-west line covers 6 rows of
-- 11.8 m cells, 70 m instead of 60 m, so it counts about 1.2 km here. Across
-- directions and offsets the rounding averages out.
select ok(pg_temp.land_km('e0000000-0000-0000-0000-000000000001') between 0.95 and 1.25,
  'A 994 m first walk counts about 1 km of new ground (land area / 60 m)');

select is(pg_temp.delta('e0000000-0000-0000-0000-000000000001', (select v from snap where name = 'e01_before_walk')),
  jsonb_build_object(
    'gold', 250 * pg_temp.land_km('e0000000-0000-0000-0000-000000000001'),
    'wood', 0, 'stone', 0, 'crystal', 0, 'gems', 0,
    'xp', 100 * pg_temp.land_km('e0000000-0000-0000-0000-000000000001')),
  'New ground pays 250 gold and 100 XP per km; terrain resources wait for the terrain');

select is((select sum(km) from public.terrain_pending where user_id = 'e0000000-0000-0000-0000-000000000001'),
  pg_temp.land_km('e0000000-0000-0000-0000-000000000001'),
  'Every new-ground km waits for its terrain');

select is((select count(*)::int from public.economy_ledger where user_id = 'e0000000-0000-0000-0000-000000000001' and reason = 'walk'),
  3, 'Each batch and the close that paid wrote one ledger row');

-- Retries pay nothing.
insert into snap values ('e01_after_walk', pg_temp.bal('e0000000-0000-0000-0000-000000000001'));

select is(pg_temp.submit_as('e0000000-0000-0000-0000-000000000001', 'e01-b1', 'e01-s1', pg_temp.slice((select pts from walk1), 1, 40)) - 'totalCells',
  '{"acceptedPoints": 0, "rejectedPoints": 0, "newCells": 0, "duplicate": true, "reward": null}'::jsonb,
  'Resending the first batch is a duplicate with no reward');
select is(pg_temp.submit_as('e0000000-0000-0000-0000-000000000001', 'e01-b2', 'e01-s1', pg_temp.slice((select pts from walk1), 41, 72)) -> 'reward',
  'null'::jsonb, 'Resending the second batch pays nothing');
select is(pg_temp.close_as('e0000000-0000-0000-0000-000000000001', 'e01-s1') -> 'reward',
  'null'::jsonb, 'Closing again pays nothing');
-- The same points under a new batch id: the points are already stored, so
-- nothing is accepted and nothing pays.
select is(pg_temp.submit_as('e0000000-0000-0000-0000-000000000001', 'e01-b2-again', 'e01-s1', pg_temp.slice((select pts from walk1), 1, 72)) -> 'reward',
  'null'::jsonb, 'The same points under a new batch id pay nothing');
select is(pg_temp.delta('e0000000-0000-0000-0000-000000000001', (select v from snap where name = 'e01_after_walk')),
  '{"gold": 0, "wood": 0, "stone": 0, "crystal": 0, "gems": 0, "xp": 0}'::jsonb,
  'Balances are unchanged after every retry');

select is((pg_temp.economy_as('e0000000-0000-0000-0000-000000000001') ->> 'rulerLevel')::int, 2,
  'Over 100 XP the player reaches Ruler level 2');
select is((select count(*)::int from public.economy_ledger where user_id = 'e0000000-0000-0000-0000-000000000001' and reason = 'walk'
            and (details ->> 'newGroundKm')::numeric > 0),
  3, 'No retry wrote a ledger row');

-- ---------------------------------------------------------------------------
-- Terrain arrives and pays what waited; later walks pay terrain at once (e01)
-- ---------------------------------------------------------------------------

insert into snap values ('e01_before_terrain', pg_temp.bal('e0000000-0000-0000-0000-000000000001'));

create temp table e01_areas as
select distinct (private.terrain_slot(cell)).area
from public.claimed_cells where user_id = 'e0000000-0000-0000-0000-000000000001';

select is(
  (select array_agg(area order by area) from public.claim_terrain_areas('e0000000-0000-0000-0000-000000000001') where request is not null),
  (select array_agg(area order by area) from e01_areas),
  'claim_terrain_areas leases the areas the player waits for');
select is(
  (select request ->> 'grid' from public.claim_terrain_areas('e0000000-0000-0000-0000-000000000001') limit 1),
  null, 'A second call gets the areas as busy (request null) while the lease lasts');
select is((select (request ->> 'grid')::int from public.claim_terrain_areas('e0000000-0000-0000-0000-000000000002') limit 1),
  null, 'A player with nothing pending gets no areas');

select throws_ok(format('select public.ingest_terrain_area(%s, %L)', (select min(area) from e01_areas), repeat('p', 100)),
  '22023', null, 'A grid of the wrong size is refused');
select throws_ok(format('select public.ingest_terrain_area(%s, %L)', (select min(area) from e01_areas), repeat('x', 16384)),
  '22023', null, 'A grid with unknown codes is refused');

-- All park.
select is((select sum((public.ingest_terrain_area(area, repeat('p', 16384)) ->> 'playersPaid')::int)::int from e01_areas),
  (select count(*)::int from e01_areas), 'Storing each area''s terrain pays the one player waiting in it');
select is(pg_temp.delta('e0000000-0000-0000-0000-000000000001', (select v from snap where name = 'e01_before_terrain')),
  jsonb_build_object('gold', 0, 'wood', 12 * pg_temp.land_km('e0000000-0000-0000-0000-000000000001'),
    'stone', 0, 'crystal', 0, 'gems', 0, 'xp', 0),
  'Park new ground pays 12 wood per km once the terrain is known');
select is((select count(*)::int from public.terrain_pending where user_id = 'e0000000-0000-0000-0000-000000000001'), 0,
  'Nothing waits any more');
select is((select sum((public.ingest_terrain_area(area, repeat('p', 16384)) ->> 'playersPaid')::int)::int from e01_areas),
  0, 'Storing the terrain again pays nobody');

-- Walking the same line again an hour later: all of it is the player's own
-- land, and the terrain is known.
insert into snap values ('e01_before_usual', pg_temp.bal('e0000000-0000-0000-0000-000000000001'));
select is((pg_temp.submit_as('e0000000-0000-0000-0000-000000000001', 'e01-u1', 'e01-s2',
             pg_temp.shuttle(52.0, 13.0, now() - interval '2 hours', 1)) ->> 'newCells')::int,
  0, 'Walking known land claims nothing new');
select is((pg_temp.close_as('e0000000-0000-0000-0000-000000000001', 'e01-s2') ->> 'newCells')::int, 0, 'Closing claims nothing new');
select is(pg_temp.delta('e0000000-0000-0000-0000-000000000001', (select v from snap where name = 'e01_before_usual')),
  jsonb_build_object(
    'gold', 100 * pg_temp.path_km('e0000000-0000-0000-0000-000000000001', 'e01-s2'),
    'wood', 5 * pg_temp.path_km('e0000000-0000-0000-0000-000000000001', 'e01-s2'),
    'stone', 0, 'crystal', 0, 'gems', 0,
    'xp', 15 * pg_temp.path_km('e0000000-0000-0000-0000-000000000001', 'e01-s2')),
  'A usual route through a park pays 100 gold, 5 wood, and 15 XP per km walked, at once');
select ok(pg_temp.path_km('e0000000-0000-0000-0000-000000000001', 'e01-s2') between 0.98 and 1.0,
  'The usual route is the 994 m walked');

-- ---------------------------------------------------------------------------
-- Daily cap on usual routes (e02, New York, two days ago)
-- ---------------------------------------------------------------------------

select is(pg_temp.economy_as('e0000000-0000-0000-0000-000000000002', 'America/New_York') ->> 'timeZone',
  'America/New_York', 'The app reports its time zone');

-- Claim the line at 08:00 local, then walk it 7 times (about 7 km) from 10:00.
select ok(pg_temp.submit_as('e0000000-0000-0000-0000-000000000002', 'e02-a', 'e02-a',
  pg_temp.shuttle(48.0, 11.0, pg_temp.local_at('America/New_York', 2, '08:00'), 1)) is not null, 'e02 claims the line');
select ok(pg_temp.close_as('e0000000-0000-0000-0000-000000000002', 'e02-a') is not null, 'e02 closes the first walk');

insert into snap values ('e02_before_usual', pg_temp.bal('e0000000-0000-0000-0000-000000000002'));
create temp table walk2 as
select pg_temp.shuttle(48.0, 11.0, pg_temp.local_at('America/New_York', 2, '10:00'), 7) as pts;

select ok(pg_temp.submit_as('e0000000-0000-0000-0000-000000000002', 'e02-b1', 'e02-b', pg_temp.slice((select pts from walk2), 1, 250)) is not null, 'Batch 1 of 7 km');
select ok(pg_temp.submit_as('e0000000-0000-0000-0000-000000000002', 'e02-b2', 'e02-b', pg_temp.slice((select pts from walk2), 251, 500)) is not null, 'Batch 2 of 7 km');
select ok(pg_temp.close_as('e0000000-0000-0000-0000-000000000002', 'e02-b') is not null, 'Close the 7 km walk');

select ok(pg_temp.path_km('e0000000-0000-0000-0000-000000000002', 'e02-b') between 6.8 and 7.0, 'The walk is about 7 km');
select is(
  (select jsonb_build_object('usualKm', usual_km, 'usualPaidKm', usual_paid_km, 'usualXp', usual_xp)
   from public.economy_days
   where user_id = 'e0000000-0000-0000-0000-000000000002' and game_day = (now() at time zone 'America/New_York')::date - 2),
  jsonb_build_object('usualKm', pg_temp.path_km('e0000000-0000-0000-0000-000000000002', 'e02-b'), 'usualPaidKm', 5.000000, 'usualXp', 75.000000),
  'Usual routes pay for at most 5 km and 75 XP a day');
select is(pg_temp.delta('e0000000-0000-0000-0000-000000000002', (select v from snap where name = 'e02_before_usual')),
  '{"gold": 500, "wood": 0, "stone": 0, "crystal": 0, "gems": 0, "xp": 75}'::jsonb,
  'The capped day pays 500 gold and 75 XP; terrain waits');
select is((select sum(km) from public.terrain_pending where user_id = 'e0000000-0000-0000-0000-000000000002' and kind = 'usual'),
  5.000000, 'Only the paid 5 km wait for terrain');

-- More walking the same day pays nothing; the next day pays again.
insert into snap values ('e02_capped', pg_temp.bal('e0000000-0000-0000-0000-000000000002'));
select ok(pg_temp.submit_as('e0000000-0000-0000-0000-000000000002', 'e02-c', 'e02-c',
  pg_temp.shuttle(48.0, 11.0, pg_temp.local_at('America/New_York', 2, '18:00'), 1)) is not null, 'Another walk the same evening');
select ok(pg_temp.close_as('e0000000-0000-0000-0000-000000000002', 'e02-c') is not null, 'Close it');
select is(pg_temp.delta('e0000000-0000-0000-0000-000000000002', (select v from snap where name = 'e02_capped')),
  '{"gold": 0, "wood": 0, "stone": 0, "crystal": 0, "gems": 0, "xp": 0}'::jsonb,
  'The cap holds across sessions on the same day');

select ok(pg_temp.submit_as('e0000000-0000-0000-0000-000000000002', 'e02-d', 'e02-d',
  pg_temp.shuttle(48.0, 11.0, pg_temp.local_at('America/New_York', 1, '10:00'), 1)) is not null, 'A walk the next day');
select ok(pg_temp.close_as('e0000000-0000-0000-0000-000000000002', 'e02-d') is not null, 'Close it');
select is(pg_temp.delta('e0000000-0000-0000-0000-000000000002', (select v from snap where name = 'e02_capped')),
  jsonb_build_object('gold', 100 * pg_temp.path_km('e0000000-0000-0000-0000-000000000002', 'e02-d'),
    'wood', 0, 'stone', 0, 'crystal', 0, 'gems', 0,
    'xp', 15 * pg_temp.path_km('e0000000-0000-0000-0000-000000000002', 'e02-d')),
  'The next day pays again');

-- ---------------------------------------------------------------------------
-- Walking across the 4 a.m. reset, in two time zones (e03, e04)
-- ---------------------------------------------------------------------------

-- Claim the line at 00:30 local yesterday. Walk it 4 times (about 4 km)
-- ending 03:50, and 4 times from 04:05. Each half is under the 5 km cap, so
-- the cap only holds both halves if they fall on the same day.
create function pg_temp.reset_walk(who uuid, tz text, lat float8)
returns void
language plpgsql
as $$
begin
  perform pg_temp.economy_as(who, tz);
  perform pg_temp.submit_as(who, 'a', 'a', pg_temp.shuttle(lat, 9.0, pg_temp.local_at(tz, 1, '00:30'), 1));
  perform pg_temp.close_as(who, 'a');
  perform pg_temp.submit_as(who, 'b', 'b', pg_temp.shuttle(lat, 9.0, pg_temp.local_at(tz, 1, '03:50') - interval '2840 seconds', 4));
  perform pg_temp.close_as(who, 'b');
  perform pg_temp.submit_as(who, 'c', 'c', pg_temp.shuttle(lat, 9.0, pg_temp.local_at(tz, 1, '04:05'), 4));
  perform pg_temp.close_as(who, 'c');
end;
$$;

select lives_ok($$select pg_temp.reset_walk('e0000000-0000-0000-0000-000000000003', 'America/Los_Angeles', 40.0)$$, 'Los Angeles walks');
select lives_ok($$select pg_temp.reset_walk('e0000000-0000-0000-0000-000000000004', 'Asia/Tokyo', 35.0)$$, 'Tokyo walks');

select is(
  (select jsonb_object_agg(game_day::text, usual_paid_km) from public.economy_days where user_id = 'e0000000-0000-0000-0000-000000000003'),
  jsonb_build_object(
    ((now() at time zone 'America/Los_Angeles')::date - 2)::text, pg_temp.path_km('e0000000-0000-0000-0000-000000000003', 'b'),
    ((now() at time zone 'America/Los_Angeles')::date - 1)::text, pg_temp.path_km('e0000000-0000-0000-0000-000000000003', 'c')),
  'Los Angeles: the walk before 4 a.m. counts for the day before, the walk after for the new day');
select is(
  (select jsonb_object_agg(game_day::text, usual_paid_km) from public.economy_days where user_id = 'e0000000-0000-0000-0000-000000000004'),
  jsonb_build_object(
    ((now() at time zone 'Asia/Tokyo')::date - 2)::text, pg_temp.path_km('e0000000-0000-0000-0000-000000000004', 'b'),
    ((now() at time zone 'Asia/Tokyo')::date - 1)::text, pg_temp.path_km('e0000000-0000-0000-0000-000000000004', 'c')),
  'Tokyo: the same split at 4 a.m. local time');
select ok(pg_temp.path_km('e0000000-0000-0000-0000-000000000004', 'b') + pg_temp.path_km('e0000000-0000-0000-0000-000000000004', 'c') > 7.5,
  'Both halves were paid in full, about 8 km, beyond one day''s cap');
select is(
  (select new_ground_km from public.economy_days
   where user_id = 'e0000000-0000-0000-0000-000000000004' and game_day = (now() at time zone 'Asia/Tokyo')::date - 2),
  pg_temp.land_km('e0000000-0000-0000-0000-000000000004'),
  'The 00:30 first walk is new ground of the day before');

-- ---------------------------------------------------------------------------
-- Keep tax across the 4 a.m. reset in several time zones (e05 to e08)
-- ---------------------------------------------------------------------------

select private.ensure_economy(('e0000000-0000-0000-0000-00000000000' || i)::uuid) from generate_series(5, 8) as i;
update public.player_economy set time_zone = 'Europe/Warsaw' where user_id = 'e0000000-0000-0000-0000-000000000005';
update public.player_economy set time_zone = 'America/New_York' where user_id = 'e0000000-0000-0000-0000-000000000006';
update public.player_economy set time_zone = 'Pacific/Kiritimati' where user_id = 'e0000000-0000-0000-0000-000000000007';
update public.player_economy set time_zone = 'America/Los_Angeles' where user_id = 'e0000000-0000-0000-0000-000000000008';

-- Warsaw.
select is(array[
    (private.settle_keep_tax('e0000000-0000-0000-0000-000000000005', '2026-11-10 03:59:00 Europe/Warsaw') ->> 'gold')::numeric,
    (private.settle_keep_tax('e0000000-0000-0000-0000-000000000005', '2026-11-10 03:59:59 Europe/Warsaw') ->> 'gold')::numeric,
    (private.settle_keep_tax('e0000000-0000-0000-0000-000000000005', '2026-11-10 04:00:00 Europe/Warsaw') ->> 'gold')::numeric,
    (private.settle_keep_tax('e0000000-0000-0000-0000-000000000005', '2026-11-10 23:59:00 Europe/Warsaw') ->> 'gold')::numeric,
    (private.settle_keep_tax('e0000000-0000-0000-0000-000000000005', '2026-11-11 03:59:00 Europe/Warsaw') ->> 'gold')::numeric,
    (private.settle_keep_tax('e0000000-0000-0000-0000-000000000005', '2026-11-11 04:00:00 Europe/Warsaw') ->> 'gold')::numeric],
  array[300, 0, 300, 0, 0, 300]::numeric[],
  'Warsaw: the Keep tax pays once per day, and the day turns at 4:00 local');
select is((select keep_tax_paid_through from public.player_economy where user_id = 'e0000000-0000-0000-0000-000000000005'),
  date '2026-11-11', 'Warsaw: paid through Nov 11');
select is(private.settle_keep_tax('e0000000-0000-0000-0000-000000000005', '2026-11-14 09:00 Europe/Warsaw'),
  '{"days": 3, "gold": 900}'::jsonb, 'Days without opening the app still pay, one tax per day');

-- New York, on the night daylight saving time ends (Nov 1, 2026, 2 a.m.).
select is(array[
    (private.settle_keep_tax('e0000000-0000-0000-0000-000000000006', '2026-11-01 03:59:00 America/New_York') ->> 'gold')::numeric,
    (private.settle_keep_tax('e0000000-0000-0000-0000-000000000006', '2026-11-01 04:00:00 America/New_York') ->> 'gold')::numeric,
    (private.settle_keep_tax('e0000000-0000-0000-0000-000000000006', '2026-11-02 03:59:00 America/New_York') ->> 'gold')::numeric,
    (private.settle_keep_tax('e0000000-0000-0000-0000-000000000006', '2026-11-02 04:00:00 America/New_York') ->> 'gold')::numeric],
  array[300, 300, 0, 300]::numeric[],
  'New York: same rule across the end of daylight saving time');

-- Two zones 22 hours apart: Kiritimati (UTC+14) turns the day at 14:00 UTC,
-- Los Angeles (PST, UTC-8) at 12:00 UTC.
select is(array[
    (private.settle_keep_tax('e0000000-0000-0000-0000-000000000007', '2026-11-10 13:59 UTC') ->> 'gold')::numeric,
    (private.settle_keep_tax('e0000000-0000-0000-0000-000000000007', '2026-11-10 14:30 UTC') ->> 'gold')::numeric,
    (private.settle_keep_tax('e0000000-0000-0000-0000-000000000008', '2026-11-10 11:59 UTC') ->> 'gold')::numeric,
    (private.settle_keep_tax('e0000000-0000-0000-0000-000000000008', '2026-11-10 12:00 UTC') ->> 'gold')::numeric,
    (private.settle_keep_tax('e0000000-0000-0000-0000-000000000008', '2026-11-10 14:30 UTC') ->> 'gold')::numeric,
    (private.settle_keep_tax('e0000000-0000-0000-0000-000000000008', '2026-11-11 11:59 UTC') ->> 'gold')::numeric,
    (private.settle_keep_tax('e0000000-0000-0000-0000-000000000008', '2026-11-11 12:00 UTC') ->> 'gold')::numeric],
  array[300, 300, 300, 300, 0, 0, 300]::numeric[],
  'Kiritimati turns the day at 14:00 UTC, Los Angeles at 12:00 UTC (PST)');
select is(
  array[(select keep_tax_paid_through from public.player_economy where user_id = 'e0000000-0000-0000-0000-000000000007'),
        (select keep_tax_paid_through from public.player_economy where user_id = 'e0000000-0000-0000-0000-000000000008')],
  array[date '2026-11-11', date '2026-11-11'],
  'Each zone tracks its own local days');

-- ---------------------------------------------------------------------------
-- get_economy and the time zone (e11)
-- ---------------------------------------------------------------------------

create temp table e11 as select pg_temp.economy_as('e0000000-0000-0000-0000-000000000011', 'Asia/Kolkata') as first;
select is((select first -> 'keepTaxPaid' from e11), '{"days": 1, "gold": 300}'::jsonb, 'The first call pays today''s Keep tax');
select is(pg_temp.economy_as('e0000000-0000-0000-0000-000000000011', 'Asia/Kolkata') -> 'keepTaxPaid',
  '{"days": 0, "gold": 0}'::jsonb, 'A second call the same day pays nothing');
select is((select first ->> 'timeZone' from e11), 'Asia/Kolkata', 'The first time zone is accepted');
select is(pg_temp.economy_as('e0000000-0000-0000-0000-000000000011', 'Europe/Lisbon') - array['resources', 'rulerXp', 'rulerLevel', 'gameDay', 'keepTaxPaidThrough', 'today', 'pendingTerrainKm', 'keepTaxPaid'],
  '{"timeZone": "Asia/Kolkata", "timeZoneAccepted": false}'::jsonb, 'A change within 24 hours is ignored');
select is(pg_temp.economy_as('e0000000-0000-0000-0000-000000000011', 'Not/AZone') ->> 'timeZoneAccepted',
  'false', 'An unknown time zone is ignored');
update public.player_economy set time_zone_set_at = now() - interval '25 hours' where user_id = 'e0000000-0000-0000-0000-000000000011';
select is(pg_temp.economy_as('e0000000-0000-0000-0000-000000000011', 'Europe/Lisbon') ->> 'timeZone',
  'Europe/Lisbon', 'A change after 24 hours is accepted');
select is((select first -> 'resources' from e11), '{"gold": 2300, "wood": 20, "stone": 20, "crystal": 0, "gems": 0}'::jsonb,
  'Resources are whole numbers');
select is((select first ->> 'rulerLevel' from e11)::int, 1, 'A new player is Ruler level 1');

-- ---------------------------------------------------------------------------
-- Out-of-order batches never pay twice (e09 out of order, e10 in order)
-- ---------------------------------------------------------------------------

create temp table walk9 as
select pg_temp.shuttle(45.0, 7.0, now() - interval '5 hours', 1) as first_walk,
       pg_temp.shuttle(45.0, 7.0, now() - interval '4 hours', 1) as second_walk;

-- In order.
select ok(pg_temp.submit_as('e0000000-0000-0000-0000-000000000010', 'x1', 'x1', (select first_walk from walk9)) is not null, 'e10 first walk');
select ok(pg_temp.close_as('e0000000-0000-0000-0000-000000000010', 'x1') is not null, 'e10 closes');
select ok(pg_temp.submit_as('e0000000-0000-0000-0000-000000000010', 'y1', 'y1', (select second_walk from walk9)) is not null, 'e10 second walk');
select ok(pg_temp.close_as('e0000000-0000-0000-0000-000000000010', 'y1') is not null, 'e10 closes');

-- Out of order: the second half first, and for the second walk every other
-- point first, so the later batch splits segments that were already paid.
select ok(pg_temp.submit_as('e0000000-0000-0000-0000-000000000009', 'x2', 'x', pg_temp.slice((select first_walk from walk9), 37, 72)) is not null, 'e09 second half first');
select ok(pg_temp.submit_as('e0000000-0000-0000-0000-000000000009', 'x1', 'x', pg_temp.slice((select first_walk from walk9), 1, 36)) is not null, 'e09 first half later');
select ok(pg_temp.close_as('e0000000-0000-0000-0000-000000000009', 'x') is not null, 'e09 closes');
select ok(pg_temp.submit_as('e0000000-0000-0000-0000-000000000009', 'y1', 'y', pg_temp.alternate((select second_walk from walk9), false)) is not null, 'e09 even points first');
select ok(pg_temp.submit_as('e0000000-0000-0000-0000-000000000009', 'y2', 'y', pg_temp.alternate((select second_walk from walk9), true)) is not null, 'e09 odd points later');
select ok(pg_temp.close_as('e0000000-0000-0000-0000-000000000009', 'y') is not null, 'e09 closes');

select is(
  (select sum(new_ground_km) from public.economy_days where user_id = 'e0000000-0000-0000-0000-000000000009'),
  (select sum(new_ground_km) from public.economy_days where user_id = 'e0000000-0000-0000-0000-000000000010'),
  'Out of order, the same land pays the same new ground');
select ok(
  (select sum(usual_km) from public.economy_days where user_id = 'e0000000-0000-0000-0000-000000000009')
    between 0.9 * (select sum(usual_km) from public.economy_days where user_id = 'e0000000-0000-0000-0000-000000000010')
        and (select sum(usual_km) from public.economy_days where user_id = 'e0000000-0000-0000-0000-000000000010') + 0.001,
  'A batch that splits paid segments pays no more than the route walked');

-- ---------------------------------------------------------------------------
-- Ledger and privileges
-- ---------------------------------------------------------------------------

select is(
  (select count(*)::int
   from public.player_economy e
   join (select user_id, sum(gold) g, sum(wood) w, sum(stone) s, sum(crystal) c, sum(gems) m, sum(xp) x
         from public.economy_ledger group by user_id) l on l.user_id = e.user_id
   where (e.gold, e.wood, e.stone, e.crystal, e.gems, e.ruler_xp) is distinct from (l.g, l.w, l.s, l.c, l.m, l.x)),
  0, 'Every balance equals the sum of its ledger');

select is((select count(*)::int from public.player_economy where gold < 0 or wood < 0 or stone < 0 or crystal < 0 or gems < 0),
  0, 'No balance is negative');

-- As e12.
select pg_temp.act_as('e0000000-0000-0000-0000-000000000012');
select is((select count(*)::int from public.player_economy), 0, 'A player sees no one else''s economy');
select is((select count(*)::int from public.economy_ledger), 0, 'A player sees no one else''s ledger');
select throws_ok($$update public.player_economy set gold = 1e9$$, '42501', null, 'Players can''t write balances');
select throws_ok($$insert into public.economy_ledger (user_id, reason, gold) values (auth.uid(), 'walk', 1)$$, '42501', null,
  'Players can''t write the ledger');
select throws_ok($$select private.credit(auth.uid(), 'walk', null, 1, 0, 0, 0, 0, 0)$$, '42501', null,
  'Players can''t call the private pay functions');
select throws_ok($$select * from public.claim_terrain_areas(auth.uid())$$, '42501', null,
  'Players can''t lease terrain areas');
select throws_ok($$select public.ingest_terrain_area(1, repeat('p', 16384))$$, '42501', null,
  'Players can''t store terrain');
select throws_ok($$select * from public.terrain_areas$$, '42501', null, 'Players can''t read the terrain cache');
select set_config('role', 'postgres', true);

select * from finish();
rollback;
