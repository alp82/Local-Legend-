-- pgTAP tests for the weekly Mist surge (supabase/migrations/*_mist_surge.sql):
-- holding and breaking through, home, roads, and frontier, the 5% cap, the
-- gentle first surge, Rest days, running once per week across time zones and
-- the night daylight saving time ends, the Monday result, the analytics
-- event, and privileges.
-- Run with: npx supabase test db
begin;

select plan(65);

-- f01 to f04: scheduling in New York, London, Kiritimati, and Pago Pago.
-- f05: a late job (Tokyo). f06: a time zone change. a01: holds. b01: breaks
-- through (land). c01: partly held. d01: gentle first surge, then a full one.
-- e01: joined too late for the first Sunday. g01: manual Rest. g02: automatic
-- Rest. g03: walked on Sunday. g04: Rest days run out. p01: the public API.
insert into auth.users (id, aud, role, is_anonymous, created_at)
values
  ('f0000000-0000-0000-0000-000000000001', 'authenticated', 'authenticated', true, '2026-09-01 12:00 UTC'),
  ('f0000000-0000-0000-0000-000000000002', 'authenticated', 'authenticated', true, '2026-09-01 12:00 UTC'),
  ('f0000000-0000-0000-0000-000000000003', 'authenticated', 'authenticated', true, '2026-09-01 12:00 UTC'),
  ('f0000000-0000-0000-0000-000000000004', 'authenticated', 'authenticated', true, '2026-09-01 12:00 UTC'),
  ('f0000000-0000-0000-0000-000000000005', 'authenticated', 'authenticated', true, '2026-09-01 12:00 UTC'),
  ('f0000000-0000-0000-0000-000000000006', 'authenticated', 'authenticated', true, '2026-09-01 12:00 UTC'),
  ('a0000000-0000-0000-0000-000000000001', 'authenticated', 'authenticated', true, '2026-10-01 12:00 UTC'),
  ('b0000000-0000-0000-0000-000000000001', 'authenticated', 'authenticated', true, '2026-10-01 12:00 UTC'),
  ('c0000000-0000-0000-0000-0000000000c1', 'authenticated', 'authenticated', true, '2026-10-01 12:00 UTC'),
  ('d0000000-0000-0000-0000-000000000001', 'authenticated', 'authenticated', true, '2026-11-17 12:00 Europe/Warsaw'),
  ('e0000000-0000-0000-0000-0000000000e1', 'authenticated', 'authenticated', true, '2026-11-18 12:00 Europe/Warsaw'),
  ('90000000-0000-0000-0000-000000000001', 'authenticated', 'authenticated', true, '2026-10-01 12:00 UTC'),
  ('90000000-0000-0000-0000-000000000002', 'authenticated', 'authenticated', true, '2026-10-01 12:00 UTC'),
  ('90000000-0000-0000-0000-000000000003', 'authenticated', 'authenticated', true, '2026-10-01 12:00 UTC'),
  ('90000000-0000-0000-0000-000000000004', 'authenticated', 'authenticated', true, '2026-10-01 12:00 UTC'),
  ('80000000-0000-0000-0000-000000000001', 'authenticated', 'authenticated', true, now() - interval '60 days');

-- ---------------------------------------------------------------------------
-- Helpers
-- ---------------------------------------------------------------------------

create function pg_temp.zone(who uuid, tz text)
returns void
language sql
as $$
  select private.ensure_economy(who);
  update public.player_economy set time_zone = tz where user_id = who;
$$;

-- km walked on every game day from d0 to d1.
create function pg_temp.walked(who uuid, d0 date, d1 date, km numeric)
returns void
language sql
as $$
  insert into public.economy_days (user_id, game_day, usual_km)
  select who, d::date, km from generate_series(d0, d1, interval '1 day') d
  on conflict (user_id, game_day) do update set usual_km = excluded.usual_km;
$$;

create function pg_temp.kingdom(who uuid, walls int, pikemen int)
returns void
language sql
as $$
  insert into public.player_buildings (user_id, building, level) values (who, 'walls', walls)
  on conflict (user_id, building) do update set level = excluded.level;
  insert into public.player_garrison (user_id, unit, count) values (who, 'pikeman', pikemen)
  on conflict (user_id, unit) do update set count = excluded.count;
$$;

-- A surge before the tested ones, so the tested one isn't the gentle first.
create function pg_temp.had_surge(who uuid, week date)
returns void
language sql
as $$
  insert into public.surge_results (user_id, week, outcome, due_at, resolved_at, numbers)
  values (who, week, 'held', private.game_day_start(week + 7, 'UTC'), private.game_day_start(week + 7, 'UTC'), '{}');
$$;

-- Zoom 21 cells: the cell at (lat, lng) moved to the north-west corner of its
-- zoom 19 tile, and the cell dx columns east and dy rows south of a cell.
create function pg_temp.base(lat float8, lng float8)
returns bigint
language sql
immutable
as $$
  select ((c / 2097152) / 4 * 4) * 2097152 + (c % 2097152) / 4 * 4
  from (select private.tile_of(extensions.st_transform(extensions.st_setsrid(extensions.st_point(lng, lat), 4326), 3857), 21) as c) x
$$;

create function pg_temp.cell(base bigint, dx int, dy int)
returns bigint
language sql
immutable
as $$
  select base + dx::bigint * 2097152 + dy
$$;

-- The zoom 19 route tile of a cell, and of the tile tx columns and ty rows away.
create function pg_temp.tile(base bigint, tx int, ty int)
returns bigint
language sql
immutable
as $$
  select ((base / 2097152) / 4 + tx) * 524288 + (base % 2097152) / 4 + ty
$$;

create function pg_temp.claim(who uuid, base bigint, x0 int, x1 int, y0 int, y1 int, at timestamptz)
returns void
language sql
as $$
  insert into public.claimed_cells (user_id, cell, first_claimed_at)
  select who, pg_temp.cell(base, x, y), at
  from generate_series(x0, x1) x, generate_series(y0, y1) y
  on conflict do nothing;
$$;

create function pg_temp.walk_tiles(who uuid, base bigint, tx0 int, tx1 int, ty int, days date[])
returns void
language sql
as $$
  insert into public.route_tiles (user_id, tile, game_day)
  select who, pg_temp.tile(base, tx, ty), d
  from generate_series(tx0, tx1) tx, unnest(days) d
  on conflict do nothing;
$$;

create function pg_temp.result(p_who uuid, p_week date)
returns public.surge_results
language sql
as $$
  select * from public.surge_results r where r.user_id = p_who and r.week = p_week
$$;

create function pg_temp.events(who uuid)
returns bigint
language sql
as $$
  select count(*) from public.analytics_events where user_id = who and event = 'surge_result'
$$;

create function pg_temp.act_as(who uuid)
returns void
language sql
as $$
  select set_config('role', 'authenticated', true),
    set_config('request.jwt.claims', json_build_object('sub', who, 'role', 'authenticated')::text, true)
$$;

-- ---------------------------------------------------------------------------
-- Once per week, across time zones and the night daylight saving time ends
-- (f01 to f06). This runs first: the job resolves every player with an
-- economy row, and the other players don't have one yet.
-- ---------------------------------------------------------------------------

select pg_temp.zone('f0000000-0000-0000-0000-000000000001', 'America/New_York');
select pg_temp.zone('f0000000-0000-0000-0000-000000000002', 'Europe/London');
select pg_temp.zone('f0000000-0000-0000-0000-000000000003', 'Pacific/Kiritimati');
select pg_temp.zone('f0000000-0000-0000-0000-000000000004', 'Pacific/Pago_Pago');
select pg_temp.zone('f0000000-0000-0000-0000-000000000006', 'Pacific/Kiritimati');
select pg_temp.walked(('f0000000-0000-0000-0000-00000000000' || i)::uuid, '2026-09-01', '2026-11-10', 2)
from generate_series(1, 6) i;

-- The job every hour from Saturday, October 24, to Tuesday, November 3, 2026,
-- twice each time. London leaves summer time on Sunday, October 25 (2 a.m.
-- becomes 1 a.m.), New York on Sunday, November 1.
select private.run_due_surges(t) from generate_series('2026-10-24 00:00 UTC'::timestamptz, '2026-11-03 00:00 UTC', interval '1 hour') t;
select is(
  (select sum(private.run_due_surges(t)) from generate_series('2026-10-24 00:00 UTC'::timestamptz, '2026-11-03 00:00 UTC', interval '1 hour') t),
  0::bigint, 'Running the job again at every hour resolves nothing new');

select is(
  (select array_agg(r.week::text || ' ' || to_char(r.due_at at time zone 'UTC', 'MM-DD HH24:MI') order by r.week)
   from public.surge_results r where r.user_id = 'f0000000-0000-0000-0000-000000000001'),
  array['2026-10-12 10-19 08:00', '2026-10-19 10-26 08:00', '2026-10-26 11-02 09:00'],
  'New York: one surge a week, due Monday 4 a.m. local (EDT, then EST after the night DST ends)');
select is(
  (select array_agg(r.week::text || ' ' || to_char(r.due_at at time zone 'UTC', 'MM-DD HH24:MI') order by r.week)
   from public.surge_results r where r.user_id = 'f0000000-0000-0000-0000-000000000002'),
  array['2026-10-12 10-19 03:00', '2026-10-19 10-26 04:00', '2026-10-26 11-02 04:00'],
  'London: due Monday 4 a.m. local, BST before October 25 and GMT after');
select is(
  (select array_agg(r.week::text || ' ' || to_char(r.due_at at time zone 'UTC', 'MM-DD HH24:MI') order by r.week)
   from public.surge_results r where r.user_id = 'f0000000-0000-0000-0000-000000000003'),
  array['2026-10-12 10-18 14:00', '2026-10-19 10-25 14:00', '2026-10-26 11-01 14:00'],
  'Kiritimati (UTC+14): due Monday 4 a.m. local, Sunday 14:00 UTC');
select is(
  (select array_agg(r.week::text || ' ' || to_char(r.due_at at time zone 'UTC', 'MM-DD HH24:MI') order by r.week)
   from public.surge_results r where r.user_id = 'f0000000-0000-0000-0000-000000000004'),
  array['2026-10-12 10-19 15:00', '2026-10-19 10-26 15:00', '2026-10-26 11-02 15:00'],
  'Pago Pago (UTC-11): due Monday 4 a.m. local, Monday 15:00 UTC');
select is(
  (select count(*) from public.surge_results r
   where r.user_id::text like 'f0000000-%' and r.week > '2026-10-12' and r.resolved_at <> r.due_at),
  0::bigint, 'With the job every hour, each surge resolves at the first run after it''s due, never before');
select is(
  array(select pg_temp.events(('f0000000-0000-0000-0000-00000000000' || i)::uuid) from generate_series(1, 4) i),
  array[3, 3, 3, 3]::bigint[], 'One analytics event per player and week');
select is(
  (select array_agg(e.game_day::text order by e.game_day) from public.analytics_events e
   where e.user_id = 'f0000000-0000-0000-0000-000000000001' and e.event = 'surge_result'),
  array['2026-10-19', '2026-10-26', '2026-11-02'],
  'The event belongs to Monday''s game day, when the surge is due');

-- f05: a late job. The first run for this player is on Tuesday.
select pg_temp.zone('f0000000-0000-0000-0000-000000000005', 'Asia/Tokyo');
select is(private.run_due_surges('2026-11-03 06:00 UTC'), 1, 'A late run resolves the player who was due');
select is(
  (select array[r.week::text, (r.due_at = '2026-11-02 04:00 Asia/Tokyo')::text, (r.resolved_at = '2026-11-03 06:00 UTC')::text]
   from public.surge_results r where r.user_id = 'f0000000-0000-0000-0000-000000000005'),
  array['2026-10-26', 'true', 'true'], 'Late: only the last closed week resolves, due Monday 4 a.m. Tokyo');
select is(
  (select array[e.game_day::text, (e.occurred_at = '2026-11-02 04:00 Asia/Tokyo')::text] from public.analytics_events e
   where e.user_id = 'f0000000-0000-0000-0000-000000000005' and e.event = 'surge_result'),
  array['2026-11-02', 'true'], 'Late: the event still records the time the surge was due');

-- f06: resolved in Kiritimati on Sunday 14:00 UTC, then moved to Pago Pago,
-- where it's still Saturday. The week can't resolve again.
update public.player_economy set time_zone = 'Pacific/Pago_Pago' where user_id = 'f0000000-0000-0000-0000-000000000006';
select private.settle_surge('f0000000-0000-0000-0000-000000000006', t)
from generate_series('2026-11-01 15:00 UTC'::timestamptz, '2026-11-03 00:00 UTC', interval '1 hour') t;
select is(
  (select count(*) from public.surge_results where user_id = 'f0000000-0000-0000-0000-000000000006' and week = '2026-10-26'),
  1::bigint, 'A time zone change to the west after the surge doesn''t run the week again');

-- ---------------------------------------------------------------------------
-- A surge holds (a01)
-- ---------------------------------------------------------------------------

select pg_temp.zone('a0000000-0000-0000-0000-000000000001', 'Europe/Warsaw');
select pg_temp.walked('a0000000-0000-0000-0000-000000000001', '2026-11-01', '2026-12-06', 2);
select pg_temp.kingdom('a0000000-0000-0000-0000-000000000001', 5, 200);
select pg_temp.had_surge('a0000000-0000-0000-0000-000000000001', '2026-11-16');
-- Home is a single cell in Krakow; 2,000 fresh frontier cells in Warsaw.
select pg_temp.claim('a0000000-0000-0000-0000-000000000001', pg_temp.base(50.06, 19.94), 0, 0, 0, 0, '2026-10-01 08:00 UTC');
select pg_temp.claim('a0000000-0000-0000-0000-000000000001', pg_temp.base(52.23, 21.01), 0, 99, 0, 19, '2026-11-20 08:00 UTC');
select private.settle_keep_tax('a0000000-0000-0000-0000-000000000001', '2026-11-29 12:00 Europe/Warsaw');

select is(private.settle_surge('a0000000-0000-0000-0000-000000000001', '2026-11-30 03:59 Europe/Warsaw'), null,
  'At 03:59 on Monday the week isn''t over yet');
select is((private.settle_surge('a0000000-0000-0000-0000-000000000001', '2026-11-30 04:00 Europe/Warsaw') ->> 'outcome'),
  'held', 'At 04:00 on Monday the surge resolves: it holds');
select is(
  (select array[(numbers ->> 'seasonPressure')::numeric, (numbers ->> 'keepDraw')::numeric,
                (numbers ->> 'strength')::numeric
                  - (select round(1.125 * 10 * sum(l.km), 2)
                     from private.surge_land('a0000000-0000-0000-0000-000000000001', '2026-11-23', '2026-11-30 04:00 Europe/Warsaw') l
                     where l.kind = 'frontier'),
                (numbers ->> 'wallsDefense')::numeric, (numbers ->> 'garrisonPower')::numeric, (numbers ->> 'defense')::numeric]
   from pg_temp.result('a0000000-0000-0000-0000-000000000001', '2026-11-23')),
  array[1.125, 0, 0, 760, 200, 960]::numeric[],
  'Strength = 1.125 x 10 per frontier km, with no Keep draw; defense 760 + 200 = 960');
select is(
  (select array[gold, tickets, xp] from public.economy_ledger
   where user_id = 'a0000000-0000-0000-0000-000000000001' and reason = 'surge'),
  array[500, 1, 150]::numeric[], 'A hold pays 500 gold, 1 trade ticket, and 150 XP');
select is(
  (select count from public.player_garrison where user_id = 'a0000000-0000-0000-0000-000000000001'),
  190, 'A hold costs 5% of the garrison (10 of 200 Pikemen)');
select is(
  (select array[e.gold, e.trade_tickets, e.ruler_xp] from public.player_economy e where e.user_id = 'a0000000-0000-0000-0000-000000000001'),
  (select array[sum(l.gold), sum(l.tickets), sum(l.xp)] from public.economy_ledger l where l.user_id = 'a0000000-0000-0000-0000-000000000001'),
  'Balances, trade tickets, and XP still equal the ledger');
select is(
  array[private.settle_surge('a0000000-0000-0000-0000-000000000001', '2026-11-30 04:00 Europe/Warsaw')::text,
        private.settle_surge('a0000000-0000-0000-0000-000000000001', '2026-12-07 03:59 Europe/Warsaw')::text],
  array[null, null]::text[], 'Settling again in the same week does nothing');
select is((private.resolve_surge('a0000000-0000-0000-0000-000000000001', '2026-11-23', '2026-11-30 09:00 Europe/Warsaw') ->> 'duplicate'),
  'true', 'Resolving the same week again returns the stored result');
select is(
  (select array[(select count(*) from public.economy_ledger where user_id = 'a0000000-0000-0000-0000-000000000001' and reason = 'surge'),
                pg_temp.events('a0000000-0000-0000-0000-000000000001')]),
  array[1, 1]::bigint[], 'The reward and the analytics event happen once');
select is(
  (select props - 'week' from public.analytics_events where user_id = 'a0000000-0000-0000-0000-000000000001' and event = 'surge_result'),
  '{"held": true, "gentle": false, "reward": {"xp": 150, "gold": 500, "tickets": 1}, "defense": 960.00, "cellsLost": 0, "unitsLost": 10}'::jsonb
    || jsonb_build_object('pressure', (select numbers -> 'strength' from pg_temp.result('a0000000-0000-0000-0000-000000000001', '2026-11-23'))),
  'The analytics event has the result, strength as pressure, and counts only');

-- The Monday result as the app sees it.
select is(
  (select jsonb_build_object('week', s -> 'last' -> 'week', 'outcome', s -> 'last' -> 'outcome', 'reward', s -> 'last' -> 'reward',
     'unitsLost', s -> 'last' -> 'unitsLost', 'nextWeek', s -> 'next' -> 'week')
   from (select private.surge_json('a0000000-0000-0000-0000-000000000001', '2026-11-30 08:00 Europe/Warsaw') as s) x),
  '{"week": "2026-11-23", "outcome": "held", "reward": {"xp": 150, "gold": 500, "tickets": 1}, "unitsLost": {"pikeman": 10}, "nextWeek": "2026-11-30"}'::jsonb,
  'On Monday morning the app gets last week''s result and the forecast for the new week');

-- ---------------------------------------------------------------------------
-- A surge breaks through: home, roads, frontier, and the 5% cap (b01)
-- ---------------------------------------------------------------------------

-- A 100 x 40 block of cells in Warsaw. The first cell claimed is the home, at
-- the north-west corner. Columns 0 to 59 were claimed on November 20; columns
-- 60 to 99 on October 1 and never visited since, so they've faded. Road: tile
-- row 7 (cell rows 28 to 31), tile columns 0 to 14, walked in 3 of the last
-- 4 weeks; with the one-tile ring, cell rows 24 to 35 and columns 0 to 63 are
-- road. Tile row 1, columns 12 to 13, walked in only 2 weeks, isn't road.
select pg_temp.zone('b0000000-0000-0000-0000-000000000001', 'Europe/Warsaw');
select pg_temp.walked('b0000000-0000-0000-0000-000000000001', '2026-11-01', '2026-12-06', 2);
select pg_temp.kingdom('b0000000-0000-0000-0000-000000000001', 0, 20);
select pg_temp.had_surge('b0000000-0000-0000-0000-000000000001', '2026-11-16');
select pg_temp.claim('b0000000-0000-0000-0000-000000000001', pg_temp.base(52.23, 21.01), 0, 0, 0, 0, '2026-09-30 08:00 UTC');
select pg_temp.claim('b0000000-0000-0000-0000-000000000001', pg_temp.base(52.23, 21.01), 60, 99, 0, 39, '2026-10-01 08:00 UTC');
select pg_temp.claim('b0000000-0000-0000-0000-000000000001', pg_temp.base(52.23, 21.01), 0, 59, 0, 39, '2026-11-20 08:00 UTC');
select pg_temp.walk_tiles('b0000000-0000-0000-0000-000000000001', pg_temp.base(52.23, 21.01), 0, 14, 7,
  array['2026-11-10', '2026-11-17', '2026-11-26']::date[]);
select pg_temp.walk_tiles('b0000000-0000-0000-0000-000000000001', pg_temp.base(52.23, 21.01), 12, 13, 1,
  array['2026-11-17', '2026-11-26']::date[]);

create temp table b_land as
select * from private.surge_land('b0000000-0000-0000-0000-000000000001', '2026-11-23', '2026-11-30 04:00 Europe/Warsaw');

select is(
  (select array_agg(kind order by o) from (values
    (1, pg_temp.cell(pg_temp.base(52.23, 21.01), 0, 0)),
    (2, pg_temp.cell(pg_temp.base(52.23, 21.01), 9, 0)),     -- about 105 m east of home
    (3, pg_temp.cell(pg_temp.base(52.23, 21.01), 14, 0)),    -- about 164 m east of home
    (4, pg_temp.cell(pg_temp.base(52.23, 21.01), 30, 24)),   -- road ring, one tile north of the road
    (5, pg_temp.cell(pg_temp.base(52.23, 21.01), 30, 35)),   -- road ring, one tile south
    (6, pg_temp.cell(pg_temp.base(52.23, 21.01), 30, 36)),   -- two tiles south: frontier
    (7, pg_temp.cell(pg_temp.base(52.23, 21.01), 50, 5))     -- walked in only 2 of 4 weeks
  ) v (o, c) join b_land l on l.cell = v.c),
  array['home', 'home', 'frontier', 'road', 'road', 'frontier', 'frontier'],
  'Home is the 150 m around the first cell claimed; roads are tiles walked in 3 of 4 weeks, with a one-tile ring');
select is((select count(*) from b_land where kind = 'road'), 768::bigint, 'Road: 64 x 12 cells');
select is(
  (select array[count(*) filter (where faded), count(*) filter (where faded and (cell / 2097152) - (pg_temp.base(52.23, 21.01) / 2097152) >= 60)]
   from b_land where kind = 'frontier'),
  (select array[count(*), count(*)] from b_land where kind = 'frontier' and (cell / 2097152) - (pg_temp.base(52.23, 21.01) / 2097152) >= 60),
  'Only the cells claimed on October 1 and never visited have faded');

select is((private.settle_surge('b0000000-0000-0000-0000-000000000001', '2026-11-30 04:00 Europe/Warsaw') ->> 'outcome'),
  'broke_through', 'No Walls and 20 Pikemen can''t hold');
select is(
  (select array[(numbers ->> 'frontierCells')::numeric + (numbers ->> 'homeCells')::numeric + (numbers ->> 'roadCells')::numeric,
                (numbers ->> 'landLossShare')::numeric,
                (numbers ->> 'cellsLost')::numeric,
                floor(0.05 * (numbers ->> 'frontierCells')::numeric),
                cells_lost]
   from pg_temp.result('b0000000-0000-0000-0000-000000000001', '2026-11-23')),
  (select array[4000, 0.05, floor(0.05 * count(*)), floor(0.05 * count(*)), floor(0.05 * count(*))]::numeric[]
   from b_land where kind = 'frontier'),
  'A big gap takes 5% of the frontier, never more');
select is(
  (select round((numbers ->> 'strength')::numeric, 2) from pg_temp.result('b0000000-0000-0000-0000-000000000001', '2026-11-23')),
  (select round(1.125 * 10 * (sum(km) + sum(km) filter (where faded)), 2) from b_land where kind = 'frontier'),
  'Strength = pressure x 10 per frontier km, faded km counted twice');
select is(
  (select count(*) from public.surge_lost_cells s join b_land l on l.cell = s.cell
   where s.user_id = 'b0000000-0000-0000-0000-000000000001' and (l.kind <> 'frontier' or not l.faded)),
  0::bigint, 'Only frontier is lost, least recently visited first: home, roads, and fresh land stay');
select is(
  (select count(*) from b_land l
   where l.kind in ('home', 'road')
     and not exists (select 1 from public.claimed_cells c where c.user_id = 'b0000000-0000-0000-0000-000000000001' and c.cell = l.cell)),
  0::bigint, 'Every home and road cell is still owned');
select is(
  (select count(*) from public.claimed_cells where user_id = 'b0000000-0000-0000-0000-000000000001'),
  4000 - (select cells_lost from pg_temp.result('b0000000-0000-0000-0000-000000000001', '2026-11-23'))::bigint,
  'The lost cells are gone from the player''s land');
select is(
  (select array[(select count from public.player_garrison where user_id = 'b0000000-0000-0000-0000-000000000001'),
                (select count(*)::int from public.economy_ledger where user_id = 'b0000000-0000-0000-0000-000000000001' and reason = 'surge')]),
  array[18, 0], 'A breakthrough costs Pikemen 10% (half of 20%), and pays nothing below half the strength');
select is(
  (select array[(props ->> 'cellsLost')::int, (props ->> 'unitsLost')::int, (props ->> 'held')::boolean::int]
   from public.analytics_events where user_id = 'b0000000-0000-0000-0000-000000000001' and event = 'surge_result'),
  array[(select cells_lost from pg_temp.result('b0000000-0000-0000-0000-000000000001', '2026-11-23')), 2, 0],
  'The analytics event counts the lost cells and units');

-- A week of five more breakthroughs never touches home or roads.
select pg_temp.walk_tiles('b0000000-0000-0000-0000-000000000001', pg_temp.base(52.23, 21.01), 0, 14, 7,
  array['2026-12-01', '2026-12-08', '2026-12-15', '2026-12-22', '2026-12-29', '2027-01-05']::date[]);
select pg_temp.walked('b0000000-0000-0000-0000-000000000001', '2026-12-07', '2027-01-10', 2);
select private.settle_surge('b0000000-0000-0000-0000-000000000001', t)
from unnest(array['2026-12-07 05:00', '2026-12-14 05:00', '2026-12-21 05:00', '2026-12-28 05:00', '2027-01-04 05:00']::timestamp[]) w (l),
  lateral (select w.l at time zone 'Europe/Warsaw' as t) x;
select is(
  (select array[count(*) filter (where outcome = 'broke_through'), max(cells_lost * 1.0 / ((numbers ->> 'frontierCells')::numeric)) <= 0.05]::text[]
   from public.surge_results where user_id = 'b0000000-0000-0000-0000-000000000001' and week >= '2026-11-23'),
  array['6', 'true'], 'Six breakthroughs in a row, each at most 5% of that week''s frontier');
select is(
  (select count(*) from b_land l
   where l.kind in ('home', 'road')
     and not exists (select 1 from public.claimed_cells c where c.user_id = 'b0000000-0000-0000-0000-000000000001' and c.cell = l.cell)),
  0::bigint, 'After six breakthroughs, every home and road cell is still owned');

-- ---------------------------------------------------------------------------
-- Partly held: a small gap takes less than 5% (c01)
-- ---------------------------------------------------------------------------

-- Home is a single cell far away; the 1,000-cell block is all fresh frontier.
select pg_temp.zone('c0000000-0000-0000-0000-0000000000c1', 'Europe/Warsaw');
select pg_temp.walked('c0000000-0000-0000-0000-0000000000c1', '2026-11-01', '2026-12-06', 2);
select pg_temp.kingdom('c0000000-0000-0000-0000-0000000000c1', 0, 21);
select pg_temp.had_surge('c0000000-0000-0000-0000-0000000000c1', '2026-11-16');
select pg_temp.claim('c0000000-0000-0000-0000-0000000000c1', pg_temp.base(50.06, 19.94), 0, 0, 0, 0, '2026-10-01 08:00 UTC');
select pg_temp.claim('c0000000-0000-0000-0000-0000000000c1', pg_temp.base(52.23, 21.01), 0, 49, 0, 19, '2026-11-20 08:00 UTC');
select private.settle_surge('c0000000-0000-0000-0000-0000000000c1', '2026-11-30 06:00 Europe/Warsaw');
select is(
  (select array[outcome, numbers ->> 'frontierCells', (numbers ->> 'partlyHeld')]
   from pg_temp.result('c0000000-0000-0000-0000-0000000000c1', '2026-11-23')),
  array['broke_through', '1000', 'true'], 'Defense 21 against strength about 25.7: broke through, but partly held');
select is(
  (select array[(numbers ->> 'landLossShare')::numeric,
                cells_lost::numeric]
   from pg_temp.result('c0000000-0000-0000-0000-0000000000c1', '2026-11-23')),
  (select array[round(0.1 * ((numbers ->> 'strength')::numeric - (numbers ->> 'defense')::numeric) / (numbers ->> 'strength')::numeric, 4),
                floor(0.1 * ((numbers ->> 'strength')::numeric - (numbers ->> 'defense')::numeric) / (numbers ->> 'strength')::numeric * 1000)]
   from pg_temp.result('c0000000-0000-0000-0000-0000000000c1', '2026-11-23')),
  'Land lost is 10% x gap / strength of the frontier, under the 5% cap');
select ok((select cells_lost between 1 and 49 from pg_temp.result('c0000000-0000-0000-0000-0000000000c1', '2026-11-23')),
  'A small gap loses some land, less than 5%');
select is(
  (select array[gold, xp] from public.economy_ledger where user_id = 'c0000000-0000-0000-0000-0000000000c1' and reason = 'surge'),
  array[0, 75]::numeric[], 'Partly held pays 75 XP and no gold');
select is((select count from public.player_garrison where user_id = 'c0000000-0000-0000-0000-0000000000c1'),
  19, 'Breakthrough: Pikemen lose 10% (2 of 21)');

-- ---------------------------------------------------------------------------
-- The gentle first surge (d01, e01)
-- ---------------------------------------------------------------------------

-- d01 joined on Tuesday, November 17 (5 days before Sunday): the first surge
-- closes that week, at half pressure.
select pg_temp.zone('d0000000-0000-0000-0000-000000000001', 'Europe/Warsaw');
select pg_temp.walked('d0000000-0000-0000-0000-000000000001', '2026-11-17', '2026-12-06', 2);
select pg_temp.kingdom('d0000000-0000-0000-0000-000000000001', 0, 25);
-- Home is a single cell in Krakow; 2,000 fresh frontier cells in Warsaw.
select pg_temp.claim('d0000000-0000-0000-0000-000000000001', pg_temp.base(50.06, 19.94), 0, 0, 0, 0, '2026-11-18 08:00 UTC');
select pg_temp.claim('d0000000-0000-0000-0000-000000000001', pg_temp.base(52.23, 21.01), 0, 99, 0, 19, '2026-11-18 09:00 UTC');
select private.settle_surge('d0000000-0000-0000-0000-000000000001', '2026-11-23 04:30 Europe/Warsaw');
select is(
  (select array[outcome, numbers ->> 'gentle', numbers ->> 'pressure', numbers ->> 'defense',
                ((numbers ->> 'strength')::numeric
                  = (select round(0.5 * 10 * sum(l.km), 2)
                     from private.surge_land('d0000000-0000-0000-0000-000000000001', '2026-11-16', '2026-11-23 04:00 Europe/Warsaw') l
                     where l.kind = 'frontier'))::text]
   from pg_temp.result('d0000000-0000-0000-0000-000000000001', '2026-11-16')),
  array['held', 'true', '0.5000', '25.00', 'true'], 'First surge: half of pressure 1.0, strength about 22.8; 25 holds it');
select is(
  (select (props ->> 'gentle')::boolean from public.analytics_events where user_id = 'd0000000-0000-0000-0000-000000000001' and event = 'surge_result'),
  true, 'The analytics event marks the gentle surge');
select private.settle_surge('d0000000-0000-0000-0000-000000000001', '2026-11-30 04:30 Europe/Warsaw');
select is(
  (select array[w2.outcome, w2.numbers ->> 'gentle', w2.numbers ->> 'pressure',
                round((w2.numbers ->> 'strength')::numeric / (w1.numbers ->> 'strength')::numeric, 2)::text]
   from pg_temp.result('d0000000-0000-0000-0000-000000000001', '2026-11-16') w1, pg_temp.result('d0000000-0000-0000-0000-000000000001', '2026-11-23') w2),
  array['broke_through', 'false', '1.1250', '2.25'], 'The second surge is at full pressure (1.125): 2.25 times the first on the same land');

-- e01 joined on Wednesday, November 18 (4 days before Sunday): no surge that
-- week; the first one closes the next week.
select pg_temp.zone('e0000000-0000-0000-0000-0000000000e1', 'Europe/Warsaw');
select pg_temp.walked('e0000000-0000-0000-0000-0000000000e1', '2026-11-18', '2026-12-06', 2);
select pg_temp.claim('e0000000-0000-0000-0000-0000000000e1', pg_temp.base(52.23, 21.01), 0, 49, 0, 1, '2026-11-19 08:00 UTC');
select private.settle_surge('e0000000-0000-0000-0000-0000000000e1', '2026-11-23 04:30 Europe/Warsaw');
select private.settle_surge('e0000000-0000-0000-0000-0000000000e1', '2026-11-30 04:30 Europe/Warsaw');
select is(
  (select array_agg(outcome || ' ' || coalesce(numbers ->> 'gentle', '') || ' ' || coalesce(numbers ->> 'pressure', '') order by week)
   from public.surge_results where user_id = 'e0000000-0000-0000-0000-0000000000e1'),
  array['not_yet true 0.5000', 'broke_through true 0.5625'],
  'Joined 4 days before Sunday: the first surge is the following Sunday, at half pressure');
select is(pg_temp.events('e0000000-0000-0000-0000-0000000000e1'), 1::bigint, 'A week before the first surge records no event');

-- ---------------------------------------------------------------------------
-- Rest days (g01 to g04)
-- ---------------------------------------------------------------------------

select pg_temp.zone(('90000000-0000-0000-0000-00000000000' || i)::uuid, 'Europe/Warsaw') from generate_series(1, 4) i;
select pg_temp.had_surge(('90000000-0000-0000-0000-00000000000' || i)::uuid, '2026-11-16') from generate_series(1, 3) i;
select pg_temp.kingdom(('90000000-0000-0000-0000-00000000000' || i)::uuid, 0, 20) from generate_series(1, 4) i;
select pg_temp.claim(('90000000-0000-0000-0000-00000000000' || i)::uuid, pg_temp.base(52.23, 21.01), 0, 79, 0, 39, '2026-10-01 08:00 UTC')
from generate_series(1, 4) i;

-- g01: turns Rest on on Sunday evening.
select pg_temp.walked('90000000-0000-0000-0000-000000000001', '2026-11-01', '2026-12-06', 2);
select is((private.set_rest('90000000-0000-0000-0000-000000000001', true, '2026-11-29 20:00 Europe/Warsaw') -> 'rest' ->> 'on'),
  'true', 'Rest turns on');
select private.settle_surge('90000000-0000-0000-0000-000000000001', '2026-11-30 04:00 Europe/Warsaw');
select is(
  (select array[outcome, cells_lost::text, (select count::text from public.player_garrison where user_id = '90000000-0000-0000-0000-000000000001')]
   from pg_temp.result('90000000-0000-0000-0000-000000000001', '2026-11-23')),
  array['rested', '0', '20'], 'Resting on Sunday: the surge skips you, nothing is lost');
select is(pg_temp.events('90000000-0000-0000-0000-000000000001'), 0::bigint, 'A skipped surge records no event');
select is(
  (select jsonb_build_object('on', r -> 'on', 'used', r -> 'used', 'left', r -> 'left')
   from (select private.set_rest('90000000-0000-0000-0000-000000000001', false, '2026-11-30 10:00 Europe/Warsaw') -> 'rest' as r) x),
  '{"on": false, "used": 1, "left": 13}'::jsonb, 'Turning Rest off on Monday keeps Sunday as the one day used');

-- g02: stops walking after Thursday. Friday and Saturday have almost no
-- walking, so Rest turns on by itself on Sunday.
select pg_temp.walked('90000000-0000-0000-0000-000000000002', '2026-11-01', '2026-11-26', 2);
select pg_temp.walked('90000000-0000-0000-0000-000000000002', '2026-11-27', '2026-11-29', 0.2);
select is(
  (select array_agg(day::text || ' ' || source) from private.rest_days('90000000-0000-0000-0000-000000000002', '2026-11-29')),
  array['2026-11-29 auto'], 'The third day in a row with almost no walking is a rest day');
select private.settle_surge('90000000-0000-0000-0000-000000000002', '2026-11-30 04:00 Europe/Warsaw');
select is((pg_temp.result('90000000-0000-0000-0000-000000000002', '2026-11-23')).outcome, 'rested',
  'Automatic Rest skips the surge');

-- g03: no walking on Friday and Saturday, but a walk on Sunday.
select pg_temp.walked('90000000-0000-0000-0000-000000000003', '2026-11-01', '2026-11-26', 2);
select pg_temp.walked('90000000-0000-0000-0000-000000000003', '2026-11-29', '2026-11-29', 2);
select private.settle_surge('90000000-0000-0000-0000-000000000003', '2026-11-30 04:00 Europe/Warsaw');
select is((pg_temp.result('90000000-0000-0000-0000-000000000003', '2026-11-23')).outcome, 'broke_through',
  'Walking on Sunday ends automatic Rest before the surge');

-- g04: Rest on from the first day of the season. It covers 14 days, through
-- Sunday, November 29; the next Sunday the season has none left.
select private.set_rest('90000000-0000-0000-0000-000000000004', true, '2026-11-16 09:00 Europe/Warsaw');
select private.settle_surge('90000000-0000-0000-0000-000000000004', '2026-11-30 04:00 Europe/Warsaw');
select private.settle_surge('90000000-0000-0000-0000-000000000004', '2026-12-07 04:00 Europe/Warsaw');
select is(
  (select array_agg(outcome order by week) from public.surge_results
   where user_id = '90000000-0000-0000-0000-000000000004' and week >= '2026-11-23'),
  array['rested', 'broke_through'], 'Rest days run out after 14 a season');
select private.set_rest('90000000-0000-0000-0000-000000000004', false, '2026-12-08 09:00 Europe/Warsaw');
select is(
  (select jsonb_build_object('ok', r -> 'ok', 'reason', r -> 'reason', 'left', r -> 'rest' -> 'left')
   from (select private.set_rest('90000000-0000-0000-0000-000000000004', true, '2026-12-08 09:00 Europe/Warsaw') as r) x),
  '{"ok": false, "reason": "no_rest_days", "left": 0}'::jsonb, 'With no Rest days left, Rest can''t turn on');
select pg_temp.walked('90000000-0000-0000-0000-000000000004', '2027-01-10', '2027-01-18', 2);
select is((private.rest_json('90000000-0000-0000-0000-000000000004', '2027-01-18 09:00 Europe/Warsaw') ->> 'left')::int,
  14, 'A new season (from January 18, 2027) has 14 Rest days again');

-- ---------------------------------------------------------------------------
-- The public API (p01)
-- ---------------------------------------------------------------------------

-- p01 signed up 60 days ago and walks every day; its last closed week has no
-- result yet. Building first resolves that surge with the Keep as it was.
select pg_temp.zone('80000000-0000-0000-0000-000000000001', 'UTC');
select pg_temp.walked('80000000-0000-0000-0000-000000000001', (now() - interval '70 days')::date, (now() + interval '1 day')::date, 2);
select pg_temp.kingdom('80000000-0000-0000-0000-000000000001', 1, 0);
update public.player_economy set gold = 100000, wood = 1000, stone = 1000, ruler_xp = 10000
where user_id = '80000000-0000-0000-0000-000000000001';

select pg_temp.act_as('80000000-0000-0000-0000-000000000001');
select is((public.build_building('keep', 2, 'b1000000-0000-0000-0000-000000000001') ->> 'ok'), 'true', 'Keep level 2 built');
select set_config('role', 'postgres', true);
select is(
  (select array[(numbers ->> 'keepLevel')::int, (select level from public.player_buildings where user_id = '80000000-0000-0000-0000-000000000001' and building = 'keep')]
   from public.surge_results
   where user_id = '80000000-0000-0000-0000-000000000001'
     and week = private.game_week((now() at time zone 'UTC' - interval '4 hours')::date) - 7),
  array[1, 2], 'The due surge resolved before the build, with the Keep at level 1');
select pg_temp.act_as('80000000-0000-0000-0000-000000000001');
select is(
  (select array(select jsonb_object_keys(public.get_kingdom('UTC') -> 'surge') order by 1)),
  array['last', 'next', 'rest'], 'get_kingdom returns the surge: last result, forecast, and Rest');
select is((public.set_rest(true) -> 'rest' ->> 'on'), 'true', 'Players can turn Rest on');
select is((public.set_rest(false) -> 'rest' ->> 'on'), 'false', 'And off again');
select is((select count(*) from public.surge_results where user_id <> '80000000-0000-0000-0000-000000000001'), 0::bigint,
  'Players read only their own surge results');
select throws_ok($$insert into public.rest_periods (user_id, starts_on) values ('80000000-0000-0000-0000-000000000001', current_date)$$,
  '42501', null, 'Players can''t write Rest directly');
select throws_ok($$select private.settle_surge('80000000-0000-0000-0000-000000000001', now())$$,
  '42501', null, 'Players can''t run the surge');
select set_config('role', 'anon', true);
select throws_ok($$select public.set_rest(true)$$, '42501', null, 'Signed-out clients can''t call set_rest');
select set_config('role', 'postgres', true);

select * from finish();
rollback;
