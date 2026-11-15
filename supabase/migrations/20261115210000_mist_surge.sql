-- The weekly Mist surge: every game week ends with a surge against each
-- player's kingdom. docs/mist.md describes the rules for players and testers.
--
-- When: a game week runs from Monday 4 a.m. to the next Monday 4 a.m. in the
--   player's time zone (private.game_week, docs/analytics.md#week). The surge
--   that closes week W is due when the week ends, at the start of the next
--   Monday's game day (the end of Sunday night). A pg_cron job runs every
--   15 minutes and resolves every player whose last closed week has no result
--   yet. get_kingdom, build_building, and recruit_units also resolve a due
--   surge first, so a late job can't change the result: the surge always sees
--   the kingdom as it was when the week ended. One row per player and week in
--   public.surge_results makes it run once, even if the job runs twice, late,
--   or across a time zone or daylight saving time change.
-- Strength (design document section 7, with the sheet's values):
--   season pressure x first-surge factor x (Keep draw + Mist_Per_km x frontier km)
--   Faded frontier counts Faded_Mult times.
-- Defense (sheet): (Walls defense + garrison power) x (1 + Watchtower bonus).
-- Held (defense >= strength): Surge_Gold, Surge_Tickets, and XP_Surge_Held;
--   the garrison loses Casualty_Held.
-- Broke through: the Mist takes frontier cells, least recently visited first,
--   Max_Loss at most; the garrison loses Casualty_Lost (Pikemen half that);
--   XP_Surge_Partial if defense was at least half the strength.
-- Never lost: home (150 m around the player's first claimed cell) and roads
--   (land within one zoom 19 tile of a tile walked in 3 of the last 4 weeks).
-- Rest days: 14 a season. Turned on with set_rest, or by themselves on a day
--   of almost no walking that follows 2 such days. A surge skips a player
--   whose Sunday is a rest day.
--
-- Values the sheet has come from private.economy_rules(). The design
-- document's values and the placeholders are in private.surge_settings().

-- ---------------------------------------------------------------------------
-- Settings the sheet doesn't give, in one place
-- ---------------------------------------------------------------------------

create function private.surge_settings(
  out keep_draw numeric[],                 -- Design document 7: Keep draw by Keep level 1 to 10.
  out first_surge_factor numeric,          -- Design document 7 and 16: a new player's first surge is at half pressure.
  out first_surge_min_days int,            -- Design document 16: joining less than 5 days before a Sunday moves the first surge to the next Sunday.
  out partly_held_share numeric,           -- Design document 7: partly held when defense is at least half the strength.
  out stand_firm_units text[],             -- Design document 11: Pikemen "stand firm"...
  out stand_firm_factor numeric,           -- ...and lose half as many when a surge breaks through.
  out rest_days_per_season int,            -- Design document 7: up to 14 Rest days a season.
  out auto_rest_after_days int,            -- Design document 7: Rest turns on by itself after 2 days with almost no walking.
  out almost_no_walking_km numeric,        -- PLACEHOLDER: a game day with less walking than this is "almost no walking".
  out home_radius_m float8,                -- Design document 5: home is a 150 m clearing.
  out road_weeks int,                      -- Design document 5: roads are walked in 3...
  out road_min_weeks int,                  -- ...of the last 4 weeks.
  out road_tile_ring int,                  -- Land within this many route tiles (zoom 19) of a road tile is road, so the whole 60 m strip counts.
  out season_epoch date                    -- PLACEHOLDER: the Monday season 1 starts. Seasons are rules.seasons.weeks long.
)
language sql
immutable
parallel safe
set search_path = ''
as $$
  select
    array[800, 1200, 1800, 2700, 4050, 6080, 9110, 13670, 20500, 30750]::numeric[],
    0.5,
    5,
    0.5,
    array['pikeman'],
    0.5,
    14,
    2,
    0.5,
    150.0,
    4,
    3,
    1,
    date '2026-11-16'
$$;

comment on function private.surge_settings() is
  'Mist surge values that are not in the economy sheet: the design document''s values and placeholders, in one place.';

-- ---------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------

-- Trade tickets: a surge that holds pays one. Nothing spends them yet.
alter table public.player_economy add column trade_tickets numeric(20, 6) not null default 0 check (trade_tickets >= 0);
alter table public.economy_ledger add column tickets numeric(20, 6) not null default 0;

alter table public.economy_ledger drop constraint economy_ledger_reason_check;
alter table public.economy_ledger add constraint economy_ledger_reason_check
  check (reason in ('start', 'keep_tax', 'walk', 'terrain', 'build', 'recruit', 'detour', 'surge'));

comment on column public.economy_ledger.ref is
  'walk: the batch id, or close:<session id>. keep_tax: the last game day paid. terrain: the area. build, recruit: the request id. detour: the offer id. surge: the week (Monday).';

create unique index economy_ledger_surge_once_idx on public.economy_ledger (user_id, ref) where reason = 'surge';

-- The player's home: the first claimed cell, fixed the first time it's seen.
create table public.player_homes (
  user_id uuid primary key references auth.users (id) on delete cascade,
  cell bigint not null,
  set_at timestamptz not null default now()
);

comment on table public.player_homes is
  'Home of each player: the zoom 21 cell at the center of the 150 m home clearing. The first cell the player claimed, fixed once.';

create table public.rest_periods (
  id bigint generated always as identity primary key,
  user_id uuid not null references auth.users (id) on delete cascade,
  starts_on date not null,
  ends_on date null,
  created_at timestamptz not null default now(),
  check (ends_on is null or ends_on >= starts_on)
);

comment on table public.rest_periods is
  'Rest the player turned on, in game days from starts_on to ends_on (null: still on). Written only by set_rest.';

create unique index rest_periods_open_idx on public.rest_periods (user_id) where ends_on is null;
create index rest_periods_user_idx on public.rest_periods (user_id, starts_on);

create table public.surge_results (
  user_id uuid not null references auth.users (id) on delete cascade,
  week date not null check (extract(isodow from week) = 1),
  outcome text not null check (outcome in ('held', 'broke_through', 'rested', 'not_yet')),
  due_at timestamptz not null,
  resolved_at timestamptz not null,
  numbers jsonb not null,
  cells_lost int not null default 0,
  units_lost jsonb not null default '{}'::jsonb,
  reward jsonb null,
  primary key (user_id, week)
);

comment on table public.surge_results is
  'One row per player and game week (week = its Monday): the surge that closed it. not_yet: before the first surge. rested: Rest skipped it.';
comment on column public.surge_results.numbers is
  'Everything the result was computed from: season, pressure, Keep draw, frontier, strength, defense, and land and unit losses.';

create table public.surge_lost_cells (
  user_id uuid not null references auth.users (id) on delete cascade,
  week date not null,
  cell bigint not null,
  first_claimed_at timestamptz not null,
  primary key (user_id, week, cell)
);

comment on table public.surge_lost_cells is
  'Frontier cells a surge took back into the Mist. Walking there again claims them as new ground.';

revoke all on table public.player_homes, public.rest_periods, public.surge_results, public.surge_lost_cells
  from anon, authenticated;
grant select on table public.player_homes, public.rest_periods, public.surge_results, public.surge_lost_cells
  to authenticated;

alter table public.player_homes enable row level security;
alter table public.rest_periods enable row level security;
alter table public.surge_results enable row level security;
alter table public.surge_lost_cells enable row level security;

create policy "Players can read their own home" on public.player_homes
for select to authenticated using ((select auth.uid()) = user_id);

create policy "Players can read their own rest" on public.rest_periods
for select to authenticated using ((select auth.uid()) = user_id);

create policy "Players can read their own surges" on public.surge_results
for select to authenticated using ((select auth.uid()) = user_id);

create policy "Players can read their own lost land" on public.surge_lost_cells
for select to authenticated using ((select auth.uid()) = user_id);

-- ---------------------------------------------------------------------------
-- Seasons, signup, and Rest
-- ---------------------------------------------------------------------------

-- The season of a game week: its number (1 from season_epoch), the week within
-- it (1 to rules.seasons.weeks), the Monday it starts, and the sheet's season
-- pressure, rising linearly from Pressure_Start in week 1 to Pressure_End in
-- the last week.
create function private.season_of(p_week date, out season int, out season_week int, out starts_on date, out pressure numeric)
language sql
stable
parallel safe
set search_path = ''
as $$
  select q.si + 1, q.n - q.si * w.weeks + 1, w.epoch + q.si * w.weeks * 7,
    (w.m -> 'seasonPressure' ->> 'start')::numeric
      + ((w.m -> 'seasonPressure' ->> 'end')::numeric - (w.m -> 'seasonPressure' ->> 'start')::numeric)
        * (q.n - q.si * w.weeks) / greatest(w.weeks - 1, 1)
  from (select (private.economy_rules() -> 'seasons' ->> 'weeks')::int as weeks,
               private.economy_rules() -> 'mist' as m,
               (select x.season_epoch from private.surge_settings() x) as epoch) w,
    -- n: weeks since the epoch (negative before it); si: seasons since it.
    lateral (select (private.game_week(p_week) - w.epoch) / 7 as n) n0,
    lateral (select n0.n, floor(n0.n::numeric / w.weeks)::int as si) q
$$;

-- The game day a player signed up on, in their current time zone (the same
-- definition as analytics.players).
create function private.signup_day(p_user uuid)
returns date
language sql
stable
set search_path = ''
as $$
  select private.game_day(u.created_at, private.player_time_zone(u.id)) from auth.users u where u.id = p_user
$$;

-- The player's Rest days in the season of p_through, from the season's start
-- (or signup) up to p_through, with what turned each on: 'manual' (set_rest)
-- or 'auto' (a day of almost no walking after auto_rest_after_days such days,
-- counting only days since signup). Only the first rest_days_per_season count.
-- Walking is known only up to p_known (default: p_through); later days can
-- only be manual rest, so a forecast doesn't count the rest of the week as
-- days without walking.
create function private.rest_days(p_user uuid, p_through date, p_known date default null)
returns table (day date, source text)
language sql
stable
set search_path = ''
as $$
  with s as (
    select * from private.surge_settings()
  ),
  b as (
    select greatest((private.season_of(p_through)).starts_on, private.signup_day(p_user)) as first_day,
      private.signup_day(p_user) as signup
  ),
  days as (
    select d::date as day
    from b, generate_series(b.first_day, p_through, interval '1 day') d
  ),
  cand as (
    select days.day,
      case
        when exists (
          select 1 from public.rest_periods rp
          where rp.user_id = p_user and days.day >= rp.starts_on and (rp.ends_on is null or days.day <= rp.ends_on))
          then 'manual'
        when days.day - s.auto_rest_after_days >= b.signup
          and days.day <= coalesce(p_known, p_through)
          and not exists (
            select 1 from public.economy_days e
            where e.user_id = p_user and e.game_day between days.day - s.auto_rest_after_days and days.day
              and e.usual_km + e.new_ground_km >= s.almost_no_walking_km)
          then 'auto'
      end as source
    from days, s, b
  )
  select c.day, c.source
  from (select cand.*, row_number() over (order by cand.day) as n from cand where cand.source is not null) c, s
  where c.n <= s.rest_days_per_season
  order by c.day
$$;

-- ---------------------------------------------------------------------------
-- Land: home, roads, and frontier
-- ---------------------------------------------------------------------------

-- The player's home cell: the stored one, or else the first cell they claimed.
create function private.home_cell(p_user uuid)
returns bigint
language sql
stable
set search_path = ''
as $$
  select coalesce(
    (select h.cell from public.player_homes h where h.user_id = p_user),
    (select c.cell from public.claimed_cells c where c.user_id = p_user order by c.first_claimed_at, c.cell limit 1))
$$;

-- Fixes the home of every player who has claimed land and has no home yet.
create function private.fix_homes(p_user uuid default null)
returns void
language sql
set search_path = ''
as $$
  insert into public.player_homes (user_id, cell)
  select distinct on (c.user_id) c.user_id, c.cell
  from public.claimed_cells c
  where (p_user is null or c.user_id = p_user)
    and not exists (select 1 from public.player_homes h where h.user_id = c.user_id)
  order by c.user_id, c.first_claimed_at, c.cell
  on conflict (user_id) do nothing
$$;

-- Every cell the player owned when the surge closing p_week was due, with its
-- kind (home, road, or frontier), the last game day it was visited, whether
-- it has faded, and its km (ground area / claim strip width, as walking pay
-- counts new ground).
--   Home: the cell's center lies within home_radius_m of the home cell's.
--   Road: the cell lies within road_tile_ring route tiles of a tile walked in
--     at least road_min_weeks of the road_weeks weeks ending with p_week.
--   Visited: first claimed, or a route tile within road_tile_ring walked, on
--     that game day. Faded: the last visit is rules.mist.fadedLand.afterDays
--     or more days before the week's Sunday.
create function private.surge_land(p_user uuid, p_week date, p_due_at timestamptz)
returns table (cell bigint, kind text, last_visit date, faded boolean, km numeric, first_claimed_at timestamptz)
language sql
stable
set search_path = ''
as $$
  with s as (
    select * from private.surge_settings()
  ),
  k as (
    select private.cell_size_3857() as cs,
      20037508.342789244 as h,
      (2 ^ c.cell_zoom)::bigint as n,
      (2 ^ d.route_zoom)::bigint as rn,
      (2 ^ (c.cell_zoom - d.route_zoom))::bigint as f,
      c.claim_radius_m as radius,
      private.player_time_zone(p_user) as tz,
      (private.economy_rules() -> 'mist' -> 'fadedLand' ->> 'afterDays')::int as fade_days
    from private.claim_rules() c, private.detour_rules() d
  ),
  home as (
    select hc.c as cell
    from k, s,
      lateral (select private.home_cell(p_user) as cell) hm,
      lateral private.cells_near(
        extensions.st_point(-k.h + (hm.cell / k.n + 0.5) * k.cs, k.h - (hm.cell % k.n + 0.5) * k.cs, 3857),
        s.home_radius_m) as hc (c)
    where hm.cell is not null
  ),
  road_tiles as (
    select r.tile
    from public.route_tiles r, s
    where r.user_id = p_user and r.game_day >= p_week - 7 * (s.road_weeks - 1) and r.game_day < p_week + 7
    group by r.tile, s.road_min_weeks
    having count(distinct private.game_week(r.game_day)) >= s.road_min_weeks
  ),
  road_area as (
    select distinct (t.tile / k.rn + dx) * k.rn + (t.tile % k.rn + dy) as tile
    from road_tiles t, k, s,
      generate_series(-s.road_tile_ring, s.road_tile_ring) dx,
      generate_series(-s.road_tile_ring, s.road_tile_ring) dy
  ),
  visit_area as (
    select (v.tile / k.rn + dx) * k.rn + (v.tile % k.rn + dy) as tile, max(v.last_day) as last_day
    from (
      select r.tile, max(r.game_day) as last_day
      from public.route_tiles r
      where r.user_id = p_user and r.game_day < p_week + 7
      group by r.tile
    ) v, k, s,
      generate_series(-s.road_tile_ring, s.road_tile_ring) dx,
      generate_series(-s.road_tile_ring, s.road_tile_ring) dy
    group by 1
  ),
  cells as (
    select c.cell, c.first_claimed_at,
      ((c.cell / k.n) / k.f) * k.rn + (c.cell % k.n) / k.f as tile,
      private.game_day(c.first_claimed_at, k.tz) as claimed_day,
      round(((k.cs / cosh((k.h - ((c.cell % k.n) + 0.5) * k.cs) / 6378137.0)) ^ 2
        / (2 * k.radius) / 1000)::numeric, 6) as km
    from public.claimed_cells c, k
    where c.user_id = p_user and c.first_claimed_at < p_due_at
  )
  select c.cell,
    case when hm.cell is not null then 'home'
         when ra.tile is not null then 'road'
         else 'frontier' end,
    greatest(c.claimed_day, va.last_day),
    (p_week + 6) - greatest(c.claimed_day, va.last_day) >= k.fade_days,
    c.km,
    c.first_claimed_at
  from cells c
  cross join k
  left join home hm on hm.cell = c.cell
  left join road_area ra on ra.tile = c.tile
  left join visit_area va on va.tile = c.tile
$$;

-- ---------------------------------------------------------------------------
-- The surge's numbers
-- ---------------------------------------------------------------------------

-- Everything the surge closing p_week computes for a player, without changing
-- anything: {week, dueAt, season, seasonWeek, seasonPressure, firstSurge,
-- gentle, pressure, notYet, rested, keepLevel, keepDraw, frontierCells,
-- frontierKm, fadedKm, effectiveKm, homeCells, roadCells, strength,
-- wallsLevel, wallsDefense, garrisonPower, watchtowerBonus, defense, held,
-- partlyHeld, landLossShare, cellsLost, unitsLost}. The forecast for the
-- current week and the resolved result use the same numbers.
-- p_known is the last game day whose walking is known (for a forecast: today).
create function private.surge_numbers(p_user uuid, p_week date, p_known date default null)
returns jsonb
language plpgsql
stable
set search_path = ''
as $$
declare
  v_rules jsonb := private.economy_rules();
  v_mist jsonb := v_rules -> 'mist';
  s record;
  v_season record;
  v_tz text := private.player_time_zone(p_user);
  v_due timestamptz := private.game_day_start(p_week + 7, v_tz);
  v_signup date := private.signup_day(p_user);
  v_first boolean;
  v_not_yet boolean;
  v_rested boolean;
  v_factor numeric;
  v_pressure numeric;
  v_keep int := private.keep_level(p_user);
  v_draw numeric;
  l record;
  v_effective numeric;
  v_strength numeric;
  v_walls int := private.building_level(p_user, 'walls');
  v_walls_def numeric;
  v_power numeric;
  v_tower int := private.building_level(p_user, 'watchtower');
  v_bonus numeric;
  v_defense numeric;
  v_held boolean;
  v_share numeric := 0;
  v_cells_lost int := 0;
  v_units jsonb;
begin
  select * into s from private.surge_settings();
  select * into v_season from private.season_of(p_week);

  v_not_yet := v_signup is null or (p_week + 6) - v_signup < s.first_surge_min_days;
  v_rested := exists (select 1 from private.rest_days(p_user, p_week + 6, p_known) r where r.day = p_week + 6);
  v_first := not exists (
    select 1 from public.surge_results r
    where r.user_id = p_user and r.week < p_week and r.outcome in ('held', 'broke_through'));
  v_factor := case when v_first then s.first_surge_factor else 1 end;
  v_pressure := v_season.pressure * v_factor;

  v_draw := s.keep_draw[least(greatest(v_keep, 1), array_length(s.keep_draw, 1))];

  select
    count(*) filter (where kind = 'frontier') as frontier_cells,
    count(*) filter (where kind = 'home') as home_cells,
    count(*) filter (where kind = 'road') as road_cells,
    coalesce(sum(km) filter (where kind = 'frontier'), 0) as frontier_km,
    coalesce(sum(km) filter (where kind = 'frontier' and faded), 0) as faded_km
  into l
  from private.surge_land(p_user, p_week, v_due);

  v_effective := l.frontier_km + ((v_mist -> 'fadedLand' ->> 'multiplier')::numeric - 1) * l.faded_km;
  v_strength := round(v_pressure * (v_draw + (v_mist ->> 'strengthPerFrontierKm')::numeric * v_effective), 2);

  v_walls_def := case when v_walls > 0
    then (v_rules -> 'buildings' -> 'walls' -> 'levels' -> (v_walls - 1) -> 'effects' ->> 'defense')::numeric else 0 end;
  select coalesce(sum(g.count * (v_rules -> 'units' -> g.unit ->> 'power')::numeric), 0) into v_power
  from public.player_garrison g where g.user_id = p_user;
  v_bonus := case when v_tower > 0
    then coalesce((v_rules -> 'buildings' -> 'watchtower' -> 'levels' -> (v_tower - 1) -> 'effects' ->> 'defenseBonus')::numeric, 0)
    else 0 end;
  v_defense := round((v_walls_def + v_power) * (1 + v_bonus), 2);

  v_held := v_defense >= v_strength;
  if not v_held then
    v_share := least((v_mist ->> 'maxLandLossPerWeek')::numeric,
      (v_mist ->> 'landLossScale')::numeric * (v_strength - v_defense) / v_strength);
    v_cells_lost := floor(v_share * l.frontier_cells)::int;
  end if;

  select coalesce(jsonb_object_agg(g.unit, floor(g.count *
      case when v_held then (v_mist -> 'garrisonLoss' ->> 'held')::numeric
           else (v_mist -> 'garrisonLoss' ->> 'brokeThrough')::numeric
             * case when g.unit = any (s.stand_firm_units) then s.stand_firm_factor else 1 end
      end)::int), '{}'::jsonb)
  into v_units
  from public.player_garrison g where g.user_id = p_user and g.count > 0;

  return jsonb_build_object(
    'week', p_week, 'dueAt', v_due,
    'season', v_season.season, 'seasonWeek', v_season.season_week, 'seasonPressure', round(v_season.pressure, 4),
    'firstSurge', v_first, 'gentle', v_first, 'pressure', round(v_pressure, 4),
    'notYet', v_not_yet, 'rested', v_rested,
    'keepLevel', v_keep, 'keepDraw', v_draw,
    'frontierCells', l.frontier_cells, 'homeCells', l.home_cells, 'roadCells', l.road_cells,
    'frontierKm', round(l.frontier_km, 3), 'fadedKm', round(l.faded_km, 3), 'effectiveKm', round(v_effective, 3),
    'strength', v_strength,
    'wallsLevel', v_walls, 'wallsDefense', v_walls_def, 'garrisonPower', v_power,
    'watchtowerBonus', v_bonus, 'defense', v_defense,
    'held', v_held, 'partlyHeld', not v_held and v_defense >= s.partly_held_share * v_strength,
    'landLossShare', round(v_share, 4), 'cellsLost', v_cells_lost, 'unitsLost', v_units);
end;
$$;

-- ---------------------------------------------------------------------------
-- Resolving
-- ---------------------------------------------------------------------------

-- Resolves the surge closing p_week for a player, once: a second call returns
-- the stored result with duplicate: true and changes nothing. The caller
-- holds the player's economy row lock (private.ensure_economy).
create function private.resolve_surge(p_user uuid, p_week date, p_at timestamptz)
returns jsonb
language plpgsql
set search_path = ''
as $$
declare
  v_rules jsonb := private.economy_rules();
  v_mist jsonb := v_rules -> 'mist';
  v_prior public.surge_results;
  v_num jsonb;
  v_outcome text;
  v_reward jsonb;
  v_xp numeric := 0;
  v_gold numeric := 0;
  v_tickets numeric := 0;
  v_cells int := 0;
  v_units jsonb := '{}'::jsonb;
  v_units_total int := 0;
  v_row public.surge_results;
begin
  select * into v_prior from public.surge_results where user_id = p_user and week = p_week;
  if found then
    return to_jsonb(v_prior) || jsonb_build_object('duplicate', true);
  end if;

  v_num := private.surge_numbers(p_user, p_week);
  v_outcome := case
    when (v_num ->> 'notYet')::boolean then 'not_yet'
    when (v_num ->> 'rested')::boolean then 'rested'
    when (v_num ->> 'held')::boolean then 'held'
    else 'broke_through' end;

  if v_outcome = 'held' then
    v_gold := (v_mist -> 'heldReward' ->> 'gold')::numeric;
    v_tickets := (v_mist -> 'heldReward' ->> 'tickets')::numeric;
    v_xp := (v_rules -> 'xp' ->> 'surgeHeld')::numeric;
  elsif v_outcome = 'broke_through' and (v_num ->> 'partlyHeld')::boolean then
    v_xp := (v_rules -> 'xp' ->> 'surgePartlyHeld')::numeric;
  end if;

  if v_outcome in ('held', 'broke_through') then
    v_units := v_num -> 'unitsLost';
    -- Land: the least recently visited frontier cells, oldest claims first.
    if v_outcome = 'broke_through' and (v_num ->> 'cellsLost')::int > 0 then
      with lost as (
        select l.cell, l.first_claimed_at
        from private.surge_land(p_user, p_week, (v_num ->> 'dueAt')::timestamptz) l
        where l.kind = 'frontier'
        order by l.last_visit, l.first_claimed_at, l.cell
        limit (v_num ->> 'cellsLost')::int
      ),
      gone as (
        delete from public.claimed_cells c using lost
        where c.user_id = p_user and c.cell = lost.cell
        returning c.cell, c.first_claimed_at
      )
      insert into public.surge_lost_cells (user_id, week, cell, first_claimed_at)
      select p_user, p_week, g.cell, g.first_claimed_at from gone g;
      get diagnostics v_cells = row_count;
    end if;
    update public.player_garrison g
    set count = greatest(0, g.count - (v_units ->> g.unit)::int), updated_at = p_at
    where g.user_id = p_user and coalesce((v_units ->> g.unit)::int, 0) > 0;
    select coalesce(sum(value::int), 0) into v_units_total from jsonb_each_text(v_units);
  end if;

  if v_gold > 0 or v_tickets > 0 or v_xp > 0 then
    v_reward := jsonb_build_object('gold', v_gold, 'tickets', v_tickets, 'xp', v_xp);
    perform private.credit(p_user, 'surge', p_week::text, v_gold, 0, 0, 0, 0, v_xp,
      jsonb_build_object('outcome', v_outcome, 'partlyHeld', (v_num ->> 'partlyHeld')::boolean));
    if v_tickets > 0 then
      update public.player_economy set trade_tickets = trade_tickets + v_tickets where user_id = p_user;
      update public.economy_ledger set tickets = v_tickets
      where user_id = p_user and reason = 'surge' and ref = p_week::text;
    end if;
  end if;

  insert into public.surge_results (user_id, week, outcome, due_at, resolved_at, numbers, cells_lost, units_lost, reward)
  values (p_user, p_week, v_outcome, (v_num ->> 'dueAt')::timestamptz, p_at, v_num, v_cells, v_units, v_reward)
  returning * into v_row;

  if v_outcome in ('held', 'broke_through') then
    perform private.record_surge_result(
      p_user       => p_user,
      p_week       => p_week,
      p_held       => v_outcome = 'held',
      p_pressure   => (v_num ->> 'strength')::numeric,
      p_defense    => (v_num ->> 'defense')::numeric,
      p_cells_lost => v_cells,
      p_units_lost => v_units_total,
      p_reward     => v_reward,
      p_gentle     => (v_num ->> 'gentle')::boolean,
      p_at         => v_row.due_at);
  end if;

  return to_jsonb(v_row) || jsonb_build_object('duplicate', false);
end;
$$;

comment on function private.resolve_surge(uuid, date, timestamptz) is
  'Resolves the surge closing a game week for one player, once: rewards, lost frontier, garrison losses, and the analytics event.';

-- Resolves the player's last closed week if it has no result yet. Locks the
-- player's economy row first, so concurrent calls run one at a time and the
-- second finds the result. Returns the result, or null when nothing was due.
create function private.settle_surge(p_user uuid, p_at timestamptz)
returns jsonb
language plpgsql
set search_path = ''
as $$
declare
  v public.player_economy := private.ensure_economy(p_user);
  v_week date := private.game_week(private.game_day(p_at, v.time_zone)) - 7;
begin
  perform private.fix_homes(p_user);
  if exists (select 1 from public.surge_results r where r.user_id = p_user and r.week = v_week) then
    return null;
  end if;
  return private.resolve_surge(p_user, v_week, p_at);
end;
$$;

-- The scheduled job: fixes new homes, then resolves the last closed week of
-- every player who has no result for it. One player's error doesn't stop the
-- others. Returns the number of players resolved.
create function private.run_due_surges(p_at timestamptz default now())
returns int
language plpgsql
set search_path = ''
as $$
declare
  u record;
  v_n int := 0;
begin
  perform private.fix_homes();
  for u in
    select e.user_id
    from public.player_economy e
    where not exists (
      select 1 from public.surge_results r
      where r.user_id = e.user_id
        and r.week = private.game_week(private.game_day(p_at, e.time_zone)) - 7)
    order by e.user_id
  loop
    begin
      if private.settle_surge(u.user_id, p_at) is not null then
        v_n := v_n + 1;
      end if;
    exception when others then
      raise warning 'mist surge for %: %', u.user_id, sqlerrm;
    end;
  end loop;
  return v_n;
end;
$$;

comment on function private.run_due_surges(timestamptz) is
  'Scheduled every 15 minutes: resolves the Mist surge of every player whose last game week has no result yet.';

-- ---------------------------------------------------------------------------
-- Rest
-- ---------------------------------------------------------------------------

-- The player's Rest for the app: {on (set_rest is on), today (today is a rest
-- day), used, left, perSeason, seasonEndsOn}.
create function private.rest_json(p_user uuid, p_at timestamptz)
returns jsonb
language sql
stable
set search_path = ''
as $$
  with t as (
    select private.game_day(p_at, private.player_time_zone(p_user)) as today
  ),
  r as (
    select count(*)::int as used, bool_or(rd.day = t.today) as today
    from t, private.rest_days(p_user, t.today) rd
  )
  select jsonb_build_object(
    'on', exists (select 1 from public.rest_periods p where p.user_id = p_user and p.ends_on is null),
    'today', coalesce(r.today, false),
    'used', r.used,
    'left', greatest(0, s.rest_days_per_season - r.used),
    'perSeason', s.rest_days_per_season,
    'seasonEndsOn', (private.season_of(t.today)).starts_on
      + 7 * (private.economy_rules() -> 'seasons' ->> 'weeks')::int - 1)
  from t, r, private.surge_settings() s
$$;

-- Turns Rest on (from today's game day) or off (after yesterday; a Rest that
-- started today is dropped). Turning it on with no Rest days left this season
-- fails with reason no_rest_days.
create function private.set_rest(p_user uuid, p_on boolean, p_at timestamptz)
returns jsonb
language plpgsql
set search_path = ''
as $$
declare
  v public.player_economy := private.ensure_economy(p_user);
  v_today date := private.game_day(p_at, v.time_zone);
  v_open public.rest_periods;
begin
  if p_on is null then
    raise exception 'on is required' using errcode = '22023';
  end if;
  select * into v_open from public.rest_periods where user_id = p_user and ends_on is null;
  if p_on and v_open.id is null then
    if (private.rest_json(p_user, p_at) ->> 'left')::int < 1 then
      return jsonb_build_object('ok', false, 'reason', 'no_rest_days', 'rest', private.rest_json(p_user, p_at));
    end if;
    insert into public.rest_periods (user_id, starts_on) values (p_user, v_today);
  elsif not p_on and v_open.id is not null then
    if v_open.starts_on >= v_today then
      delete from public.rest_periods where id = v_open.id;
    else
      update public.rest_periods set ends_on = v_today - 1 where id = v_open.id;
    end if;
  end if;
  return jsonb_build_object('ok', true, 'rest', private.rest_json(p_user, p_at));
end;
$$;

-- ---------------------------------------------------------------------------
-- The surge as the app shows it
-- ---------------------------------------------------------------------------

-- {last: the latest resolved result or null, next: the forecast for the week
-- in progress, rest}. last.week is the Monday of the week it closed.
create function private.surge_json(p_user uuid, p_at timestamptz)
returns jsonb
language sql
stable
set search_path = ''
as $$
  with w as (
    select d.today, private.game_week(d.today) as week
    from (select private.game_day(p_at, private.player_time_zone(p_user)) as today) d
  )
  select jsonb_build_object(
    'last', (
      select jsonb_build_object('week', r.week, 'outcome', r.outcome, 'dueAt', r.due_at,
        'resolvedAt', r.resolved_at, 'cellsLost', r.cells_lost, 'unitsLost', r.units_lost,
        'reward', r.reward, 'numbers', r.numbers)
      from public.surge_results r
      where r.user_id = p_user
      order by r.week desc limit 1),
    'next', private.surge_numbers(p_user, w.week, w.today),
    'rest', private.rest_json(p_user, p_at))
  from w
$$;

-- The economy as the app shows it, now with trade tickets. Same as
-- *_economy.sql otherwise.
create or replace function private.economy_json(p_user uuid, p_at timestamptz)
returns jsonb
language sql
stable
set search_path = ''
as $$
  select jsonb_build_object(
    'resources', jsonb_build_object(
      'gold', floor(e.gold), 'wood', floor(e.wood), 'stone', floor(e.stone),
      'crystal', floor(e.crystal), 'gems', floor(e.gems)),
    'tradeTickets', floor(e.trade_tickets),
    'rulerXp', floor(e.ruler_xp),
    'rulerLevel', private.ruler_level(e.ruler_xp),
    'timeZone', e.time_zone,
    'gameDay', private.game_day(p_at, e.time_zone),
    'keepTaxPaidThrough', e.keep_tax_paid_through,
    'today', jsonb_build_object(
      'usualKm', coalesce(d.usual_km, 0),
      'usualPaidKm', coalesce(d.usual_paid_km, 0),
      'usualCapKm', (private.economy_rules() -> 'walking' -> 'usualRoutes' ->> 'dailyCapKm')::numeric,
      'usualXp', coalesce(d.usual_xp, 0),
      'newGroundKm', coalesce(d.new_ground_km, 0),
      'newGroundXp', coalesce(d.new_ground_xp, 0)),
    'pendingTerrainKm', (select coalesce(sum(km), 0) from public.terrain_pending tp where tp.user_id = p_user))
  from public.player_economy e
  left join public.economy_days d on d.user_id = e.user_id and d.game_day = private.game_day(p_at, e.time_zone)
  where e.user_id = p_user
$$;

-- ---------------------------------------------------------------------------
-- API
-- ---------------------------------------------------------------------------

-- get_kingdom now resolves a due surge first and returns the surge too.
create or replace function public.get_kingdom(p_time_zone text default null)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user uuid := auth.uid();
  v_tz_ok boolean;
  v_tax jsonb;
begin
  if v_user is null then
    raise exception 'Not signed in' using errcode = '42501';
  end if;
  v_tz_ok := private.set_time_zone(v_user, p_time_zone, now());
  perform private.settle_surge(v_user, now());
  v_tax := private.settle_keep_tax(v_user, now());
  return private.economy_json(v_user, now())
    || jsonb_build_object('keepTaxPaid', v_tax, 'timeZoneAccepted', v_tz_ok,
      'kingdom', private.kingdom_json(v_user, now()),
      'surge', private.surge_json(v_user, now()));
end;
$$;

comment on function public.get_kingdom(text) is
  'get_economy plus the kingdom (building levels, the daily construction, Treasury caps, the garrison, recruits) and the Mist surge (last result, forecast, Rest).';

-- Building and recruiting resolve a due surge first, so the surge sees the
-- kingdom as it was when the week ended.
create or replace function public.build_building(p_building text, p_level int, p_request_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user uuid := auth.uid();
  v_result jsonb;
begin
  if v_user is null then
    raise exception 'Not signed in' using errcode = '42501';
  end if;
  perform private.settle_surge(v_user, now());
  v_result := private.build(v_user, p_building, p_level, p_request_id, now());
  return v_result || jsonb_build_object('economy', private.economy_json(v_user, now()),
    'kingdom', private.kingdom_json(v_user, now()));
end;
$$;

create or replace function public.recruit_units(p_unit text, p_count int, p_request_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user uuid := auth.uid();
  v_result jsonb;
begin
  if v_user is null then
    raise exception 'Not signed in' using errcode = '42501';
  end if;
  perform private.settle_surge(v_user, now());
  v_result := private.recruit(v_user, p_unit, p_count, p_request_id, now());
  return v_result || jsonb_build_object('economy', private.economy_json(v_user, now()),
    'kingdom', private.kingdom_json(v_user, now()));
end;
$$;

-- Turns Rest on or off for the caller. Returns {ok, rest} or {ok: false,
-- reason: 'no_rest_days', rest}. Errors: 42501 when not signed in; 22023
-- without p_on.
create function public.set_rest(p_on boolean)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user uuid := auth.uid();
begin
  if v_user is null then
    raise exception 'Not signed in' using errcode = '42501';
  end if;
  return private.set_rest(v_user, p_on, now());
end;
$$;

comment on function public.set_rest(boolean) is
  'Turns Rest on (from today) or off for the caller. A surge skips a player whose Sunday is a rest day. 14 days a season.';

-- Function privileges.
revoke all on all functions in schema private from public, anon, authenticated;
revoke all on function public.set_rest(boolean) from public, anon;
grant execute on function public.set_rest(boolean) to authenticated;

-- ---------------------------------------------------------------------------
-- Schedule: every 15 minutes, so each player's surge resolves soon after
-- their Monday 4 a.m., in every time zone (including those 30 or 45 minutes
-- off the hour).
-- ---------------------------------------------------------------------------

select cron.schedule('mist-surge', '*/15 * * * *', $$select private.run_due_surges(now())$$);
