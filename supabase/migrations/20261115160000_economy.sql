-- Economy: resources, Ruler XP, the daily Keep tax, and pay for walking.
--
-- The numbers come from private.economy_rules(), which
-- scripts/generate-rules.mjs generates from Local Legend_Economy.xlsx (see
-- docs/rules.md). This file holds only how the rules are applied.
--
-- Postgres is the authority for every reward. Walking pay is computed in the
-- same transaction that claims land (private.claim_settled, called by
-- submit_location_batch and close_walk_session), so a retried batch can't pay
-- twice: a repeated batch id returns before anything runs, and every walking
-- segment is marked paid the first time it's evaluated.
--
-- How a walk pays (docs/economy.md has the full rules and examples):
--   New ground: every cell a walk claims for the first time. Its km are the
--     cell's ground area divided by the claim strip width (2 x claim radius,
--     60 m), so a straight 1 km walk on new land counts about 1 km. Cells are
--     claimed once, so new ground pays once.
--   Usual routes (your own land): a walking segment whose middle lies on a cell
--     you claimed at least economy_limits().own_land_min_age before the segment
--     started. Its km are the segment's length. Capped per day.
--   Each km pays gold for its kind, plus the terrain's resource for the cell
--     (under the segment's middle, or the new cell). Terrain comes from
--     public.terrain_areas, which the terrain Edge Function fills. When an
--     area's terrain isn't known yet, the gold and XP are paid now and the
--     terrain resources wait in public.terrain_pending until it is.
--   Ruler XP: usual routes per km up to a daily cap; new ground per km in daily
--     bands (100, 50, then 20 XP per km in the current sheet).
--
-- Days: daily caps and the Keep tax reset at rules.dailyResetHour (4 a.m.) in
-- the player's local time. The app reports its IANA time zone through
-- get_economy(p_time_zone); it's stored in player_economy.time_zone (UTC until
-- the app reports one). A walk belongs to the day of its GPS time, not of its
-- upload.

-- ---------------------------------------------------------------------------
-- Limits that aren't economy values. The sheet has no say in these; they keep
-- the accounting honest.
-- ---------------------------------------------------------------------------

create function private.economy_limits(
  out own_land_min_age interval,       -- Land claimed more recently than this before a segment doesn't count as your own land for it.
  out time_zone_min_interval interval  -- The time zone changes at most this often. The first report is always accepted.
)
language sql
immutable
parallel safe
set search_path = ''
as $$
  -- 60 s: on a first walk the strip claims cells up to 30 m ahead of you, which
  -- you reach within 60 s at any walking pace above 0.5 m/s. Those cells are
  -- new ground, not your own land.
  -- 24 h: limits squeezing extra days out of the 4 a.m. reset by switching zones.
  select interval '60 seconds', interval '24 hours'
$$;

comment on function private.economy_limits() is 'Accounting limits for the economy that are not game rules.';

-- ---------------------------------------------------------------------------
-- Terrain rules: how the terrain Edge Function classifies cells. The function
-- holds no rules; it receives this JSON with each area it fetches.
-- ---------------------------------------------------------------------------

-- Terrain per claim cell, one character each: the code of the first class
-- (in priority order) that matches, or none_code. A match is a vector tile
-- feature whose "<layer>.<field>" value is in vals, within buffer_m of the
-- cell's center (0: the center lies inside the polygon or on the line).
-- builtUp also matches when buildings cover at least building_cover.min of the
-- square of radius_m around the cell.
create function private.terrain_rules(
  out area_zoom int,          -- One vector tile per area, the same tiles as the sites. Changing it invalidates terrain_areas.
  out lease interval,         -- How long one caller owns an area fetch.
  out retry_after interval,   -- Wait after a failed fetch before trying again.
  out max_areas_per_call int  -- Tile downloads per terrain call, at most.
)
language sql
immutable
parallel safe
set search_path = ''
as $$
  select 14, interval '30 seconds', interval '10 minutes', 4
$$;

comment on function private.terrain_rules() is 'Terrain fetch thresholds, in one place.';

-- The terrain classes, in priority order. Sent to the Edge Function as is.
create function private.terrain_classes()
returns jsonb
language sql
immutable
parallel safe
set search_path = ''
as $$
  select $json${
    "none_code": "-",
    "classes": [
      { "terrain": "hills", "code": "h", "match": [
        { "key": "poi.subclass", "vals": ["viewpoint"], "buffer_m": 50 },
        { "key": "mountain_peak.class", "vals": ["peak", "volcano"], "buffer_m": 100 }
      ] },
      { "terrain": "waterside", "code": "w", "match": [
        { "key": "water.class", "vals": ["river", "lake", "ocean", "dock"], "buffer_m": 30 },
        { "key": "waterway.class", "vals": ["river", "canal"], "buffer_m": 30 }
      ] },
      { "terrain": "park", "code": "p", "match": [
        { "key": "landcover.class", "vals": ["wood"], "buffer_m": 0 },
        { "key": "landcover.subclass", "vals": ["park", "garden", "recreation_ground", "village_green"], "buffer_m": 0 },
        { "key": "park.class", "vals": ["nature_reserve", "national_park"], "buffer_m": 0 }
      ] },
      { "terrain": "builtUp", "code": "b", "match": [
        { "key": "landuse.class", "vals": ["residential", "commercial", "retail", "industrial"], "buffer_m": 0 }
      ], "building_cover": { "radius_m": 50, "min": 0.15 } }
    ]
  }$json$::jsonb
$$;

comment on function private.terrain_classes() is 'Terrain classification thresholds, in one place.';

-- The classification request for one area: the terrain rules plus the zoom
-- and the grid size (cells per side = 2^(cell zoom - area zoom), 128).
create function private.terrain_filter()
returns jsonb
language sql
immutable
parallel safe
set search_path = ''
as $$
  select private.terrain_classes() || jsonb_build_object('zoom', t.area_zoom, 'grid', (2 ^ (c.cell_zoom - t.area_zoom))::int)
  from private.terrain_rules() t, private.claim_rules() c
$$;

-- The terrain area and the position inside its grid string (1-based) of a
-- claim cell.
create function private.terrain_slot(cell bigint, out area bigint, out pos int)
language sql
immutable
strict
parallel safe
set search_path = ''
as $$
  select ((cell / n) >> k) * (2 ^ t.area_zoom)::bigint + ((cell % n) >> k),
    (((cell % n) & (g - 1)) * g + ((cell / n) & (g - 1)) + 1)::int
  from private.terrain_rules() t, private.claim_rules() c,
    lateral (select (2 ^ c.cell_zoom)::bigint as n, c.cell_zoom - t.area_zoom as k,
                    (2 ^ (c.cell_zoom - t.area_zoom))::bigint as g) s
$$;

-- Terrain name (a key of rules.walking.*.perKmByTerrain) for a code, or null
-- for none_code and unknown codes.
create function private.terrain_name(code text)
returns text
language sql
immutable
parallel safe
set search_path = ''
as $$
  select c ->> 'terrain'
  from jsonb_array_elements(private.terrain_classes() -> 'classes') c
  where c ->> 'code' = code
$$;

-- ---------------------------------------------------------------------------
-- Rule helpers
-- ---------------------------------------------------------------------------

-- The game day a moment belongs to: the local date, where days start at
-- rules.dailyResetHour. 03:59 local on May 2 is May 1; 04:00 is May 2.
create function private.game_day(p_at timestamptz, p_time_zone text)
returns date
language sql
stable
parallel safe
set search_path = ''
as $$
  select ((p_at at time zone p_time_zone)
    - make_interval(hours => (private.economy_rules() ->> 'dailyResetHour')::int))::date
$$;

comment on function private.game_day(timestamptz, text) is
  'Local date of p_at in p_time_zone, with days starting at rules.dailyResetHour.';

-- The Ruler level for an XP total, from rules.xp.rulerLevels.
create function private.ruler_level(p_xp numeric)
returns int
language sql
stable
parallel safe
set search_path = ''
as $$
  select coalesce(max((l ->> 'level')::int), 1)
  from jsonb_array_elements(private.economy_rules() -> 'xp' -> 'rulerLevels') l
  where (l ->> 'totalXp')::numeric <= p_xp
$$;

-- New-ground XP for the first p_km km of a day, from bands
-- [{km, xpPerKm}, ...] where the last band has km null and no end.
create function private.new_ground_xp_upto(p_km numeric, p_bands jsonb)
returns numeric
language sql
immutable
parallel safe
set search_path = ''
as $$
  select coalesce(sum(b.rate * greatest(0, least(p_km, b.hi) - b.lo)), 0)
  from (
    select (e ->> 'xpPerKm')::numeric as rate,
      coalesce(sum((e ->> 'km')::numeric) over (order by o rows between unbounded preceding and 1 preceding), 0) as lo,
      case when e ->> 'km' is not null then sum((e ->> 'km')::numeric) over (order by o) end as hi
    from jsonb_array_elements(p_bands) with ordinality as x (e, o)
  ) b
$$;

-- The player's Keep level. Buildings arrive with the kingdom screen; until
-- then every player has the Keep's starting level.
create function private.keep_level(p_user uuid)
returns int
language sql
stable
set search_path = ''
as $$
  select (private.economy_rules() -> 'buildings' -> 'keep' ->> 'startLevel')::int
$$;

revoke all on all functions in schema private from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------

-- Balances are numeric because pay is per meter: 0.4 km of park pays 2 wood at
-- 5 wood per km, and 0.25 km pays 1.25. The app shows whole units (floor).
create table public.player_economy (
  user_id uuid primary key references auth.users (id) on delete cascade,
  gold numeric(20, 6) not null check (gold >= 0),
  wood numeric(20, 6) not null check (wood >= 0),
  stone numeric(20, 6) not null check (stone >= 0),
  crystal numeric(20, 6) not null check (crystal >= 0),
  gems numeric(20, 6) not null check (gems >= 0),
  ruler_xp numeric(20, 6) not null default 0 check (ruler_xp >= 0),
  time_zone text not null default 'UTC',
  time_zone_set_at timestamptz null,
  keep_tax_paid_through date null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table public.player_economy is
  'Resources and Ruler XP, one row per player. Written only by the economy functions; owner-readable.';
comment on column public.player_economy.time_zone is
  'IANA time zone the app last reported (UTC until then). Days reset at rules.dailyResetHour in this zone.';
comment on column public.player_economy.keep_tax_paid_through is
  'Last game day the Keep tax was paid for. Null before the first payment.';

create table public.economy_days (
  user_id uuid not null references auth.users (id) on delete cascade,
  game_day date not null,
  usual_km numeric(14, 6) not null default 0,
  usual_paid_km numeric(14, 6) not null default 0,
  usual_xp numeric(14, 6) not null default 0,
  new_ground_km numeric(14, 6) not null default 0,
  new_ground_xp numeric(14, 6) not null default 0,
  primary key (user_id, game_day)
);

comment on table public.economy_days is
  'Walking per game day, for the daily caps and XP bands. usual_km is walked on your own land before the cap; usual_paid_km after it.';

create table public.economy_ledger (
  id bigint generated always as identity primary key,
  user_id uuid not null references auth.users (id) on delete cascade,
  created_at timestamptz not null default now(),
  reason text not null check (reason in ('start', 'keep_tax', 'walk', 'terrain')),
  ref text null,
  gold numeric(20, 6) not null default 0,
  wood numeric(20, 6) not null default 0,
  stone numeric(20, 6) not null default 0,
  crystal numeric(20, 6) not null default 0,
  gems numeric(20, 6) not null default 0,
  xp numeric(20, 6) not null default 0,
  details jsonb null
);

comment on table public.economy_ledger is
  'Every change to a player''s resources and XP. The balances in player_economy equal the sums of this table.';
comment on column public.economy_ledger.ref is
  'walk: the batch id, or close:<session id>. keep_tax: the last game day paid. terrain: the area.';

create index economy_ledger_user_idx on public.economy_ledger (user_id, created_at);

-- Terrain resources earned on cells whose terrain isn't known yet.
create table public.terrain_pending (
  user_id uuid not null references auth.users (id) on delete cascade,
  area bigint not null,
  pos int not null,
  game_day date not null,
  kind text not null check (kind in ('usual', 'new')),
  km numeric(14, 6) not null check (km > 0),
  primary key (user_id, area, pos, game_day, kind)
);

comment on table public.terrain_pending is
  'Paid km whose terrain resources wait for the area''s terrain. Settled by ingest_terrain_area. usual km are already capped.';

create index terrain_pending_area_idx on public.terrain_pending (area);

-- Terrain per claim cell, packed one character per cell per area.
create table public.terrain_areas (
  area bigint primary key,
  grid text null,
  fetched_at timestamptz null,
  lease_until timestamptz null,
  failed_at timestamptz null,
  last_error text null
);

comment on table public.terrain_areas is
  'Terrain of every claim cell in a zoom 14 area: grid has one character per cell (see terrain_rules), row by row from the north-west. Filled by the terrain Edge Function.';

-- Which walking segments have been paid: the segment that ends at a point
-- started at paid_segment_start. Points of the same segment can't be paid
-- again, even after an out-of-order batch splits the segment.
alter table public.walk_points add column paid_segment_start timestamptz null;

comment on column public.walk_points.paid_segment_start is
  'Set when the walking segment ending at this point was evaluated for pay: the start time of that segment.';

-- Privileges: clients read their own rows and write nothing directly.
revoke all on table public.player_economy, public.economy_days, public.economy_ledger,
  public.terrain_pending, public.terrain_areas from anon, authenticated;
grant select on table public.player_economy, public.economy_days, public.economy_ledger,
  public.terrain_pending to authenticated;

alter table public.player_economy enable row level security;
alter table public.economy_days enable row level security;
alter table public.economy_ledger enable row level security;
alter table public.terrain_pending enable row level security;
alter table public.terrain_areas enable row level security;

create policy "Players can read their own economy" on public.player_economy
for select to authenticated using ((select auth.uid()) = user_id);

create policy "Players can read their own days" on public.economy_days
for select to authenticated using ((select auth.uid()) = user_id);

create policy "Players can read their own ledger" on public.economy_ledger
for select to authenticated using ((select auth.uid()) = user_id);

create policy "Players can read their own pending terrain" on public.terrain_pending
for select to authenticated using ((select auth.uid()) = user_id);

-- ---------------------------------------------------------------------------
-- Balances
-- ---------------------------------------------------------------------------

-- Creates the player's economy row with the starting resources if it doesn't
-- exist, then returns it locked for update.
create function private.ensure_economy(p_user uuid)
returns public.player_economy
language plpgsql
set search_path = ''
as $$
declare
  s jsonb := private.economy_rules() -> 'startingResources';
  v public.player_economy;
begin
  insert into public.player_economy (user_id, gold, wood, stone, crystal, gems)
  values (p_user, (s ->> 'gold')::numeric, (s ->> 'wood')::numeric, (s ->> 'stone')::numeric,
    (s ->> 'crystal')::numeric, (s ->> 'gems')::numeric)
  on conflict (user_id) do nothing;

  if found then
    insert into public.economy_ledger (user_id, reason, gold, wood, stone, crystal, gems)
    values (p_user, 'start', (s ->> 'gold')::numeric, (s ->> 'wood')::numeric, (s ->> 'stone')::numeric,
      (s ->> 'crystal')::numeric, (s ->> 'gems')::numeric);
  end if;

  select * into v from public.player_economy where user_id = p_user for update;
  return v;
end;
$$;

-- Adds to a player's balances and records the change. The row must exist.
create function private.credit(
  p_user uuid, p_reason text, p_ref text,
  p_gold numeric, p_wood numeric, p_stone numeric, p_crystal numeric, p_gems numeric, p_xp numeric,
  p_details jsonb default null
)
returns void
language plpgsql
set search_path = ''
as $$
begin
  if p_gold = 0 and p_wood = 0 and p_stone = 0 and p_crystal = 0 and p_gems = 0 and p_xp = 0 then
    return;
  end if;
  update public.player_economy
  set gold = gold + p_gold, wood = wood + p_wood, stone = stone + p_stone,
    crystal = crystal + p_crystal, gems = gems + p_gems, ruler_xp = ruler_xp + p_xp,
    updated_at = now()
  where user_id = p_user;
  insert into public.economy_ledger (user_id, reason, ref, gold, wood, stone, crystal, gems, xp, details)
  values (p_user, p_reason, p_ref, p_gold, p_wood, p_stone, p_crystal, p_gems, p_xp, p_details);
end;
$$;

-- ---------------------------------------------------------------------------
-- Time zone and the Keep tax
-- ---------------------------------------------------------------------------

-- Stores the app's time zone. Ignores unknown names, and changes sooner than
-- time_zone_min_interval after the last one. Returns whether p_time_zone is
-- now the player's zone.
create function private.set_time_zone(p_user uuid, p_time_zone text, p_at timestamptz)
returns boolean
language plpgsql
set search_path = ''
as $$
declare
  v public.player_economy := private.ensure_economy(p_user);
begin
  if p_time_zone is null or p_time_zone = v.time_zone then
    return p_time_zone is not null;
  end if;
  if char_length(p_time_zone) > 64
    or not exists (select 1 from pg_catalog.pg_timezone_names where name = p_time_zone) then
    return false;
  end if;
  if v.time_zone_set_at is not null
    and p_at < v.time_zone_set_at + (select time_zone_min_interval from private.economy_limits()) then
    return false;
  end if;
  update public.player_economy
  set time_zone = p_time_zone, time_zone_set_at = p_at, updated_at = now()
  where user_id = p_user;
  return true;
end;
$$;

-- Pays the Keep tax for every game day from the last one paid up to the day of
-- p_at: one day for the first payment, then one per day since. Days the player
-- didn't open the app still pay. Paying again on the same day pays nothing.
create function private.settle_keep_tax(p_user uuid, p_at timestamptz)
returns jsonb
language plpgsql
set search_path = ''
as $$
declare
  v public.player_economy := private.ensure_economy(p_user);
  v_level int := private.keep_level(p_user);
  v_today date := private.game_day(p_at, v.time_zone);
  v_days int;
  v_per_day numeric;
begin
  v_days := case when v.keep_tax_paid_through is null then 1
                 else greatest(0, v_today - v.keep_tax_paid_through) end;
  if v_days = 0 then
    return jsonb_build_object('days', 0, 'gold', 0);
  end if;
  v_per_day := (private.economy_rules() -> 'buildings' -> 'keep' -> 'levels' -> (v_level - 1) -> 'effects' ->> 'goldTaxPerDay')::numeric;
  update public.player_economy set keep_tax_paid_through = v_today where user_id = p_user;
  perform private.credit(p_user, 'keep_tax', v_today::text, v_days * v_per_day, 0, 0, 0, 0, 0,
    jsonb_build_object('days', v_days, 'keepLevel', v_level, 'perDay', v_per_day));
  return jsonb_build_object('days', v_days, 'gold', v_days * v_per_day);
end;
$$;

-- ---------------------------------------------------------------------------
-- Walking pay
-- ---------------------------------------------------------------------------

-- Pays for one claim step. p_new: [{cell, t}] cells claimed for the first time,
-- t = first_claimed_at. p_usual: [{cell, t1, m}] walking segments on the
-- player's own land: the cell under the middle, the end time, and the length
-- in meters. Caps and bands apply per game day of t / t1, in order of time.
-- Returns what was paid.
create function private.pay_walk(p_user uuid, p_ref text, p_new jsonb, p_usual jsonb)
returns jsonb
language plpgsql
set search_path = ''
as $$
declare
  v_rules jsonb := private.economy_rules();
  v_walk jsonb := v_rules -> 'walking';
  v_xp jsonb := v_rules -> 'xp';
  v public.player_economy := private.ensure_economy(p_user);
  v_level_before int := private.ruler_level(v.ruler_xp);
  v_reset interval := make_interval(hours => (v_rules ->> 'dailyResetHour')::int);
  v_names jsonb;
  v_n bigint;   -- cells per side of the world at the claim zoom
  v_k int;      -- claim zoom - terrain area zoom
  v_g bigint;   -- cells per side of a terrain area
  v_an bigint;  -- areas per side of the world
  v_pieces jsonb;
  t record;
begin
  select jsonb_object_agg(c ->> 'code', c ->> 'terrain') into v_names
  from jsonb_array_elements(private.terrain_classes() -> 'classes') c;
  select (2 ^ c.cell_zoom)::bigint, c.cell_zoom - tr.area_zoom, (2 ^ (c.cell_zoom - tr.area_zoom))::bigint,
    (2 ^ tr.area_zoom)::bigint
  into v_n, v_k, v_g, v_an
  from private.claim_rules() c, private.terrain_rules() tr;

  -- One row per piece of walking, with its day, terrain, and pay. Rules are
  -- read into variables first: calling a rule function per row would parse
  -- the rules JSON once per row.
  with c as (
    select private.cell_size_3857() as s, v_n as n, r.claim_radius_m as radius
    from private.claim_rules() r
  ),
  raw as (
    select 'new'::text as kind, n.cell, n.t,
      -- Ground area of the cell / strip width. Mercator scale at latitude L is 1 / cos(L) = cosh(y / R).
      round(((c.s / cosh((20037508.342789244 - ((n.cell % c.n) + 0.5) * c.s) / 6378137.0)) ^ 2
        / (2 * c.radius) / 1000)::numeric, 6) as km
    from jsonb_to_recordset(p_new) as n (cell bigint, t timestamptz), c
    union all
    select 'usual', u.cell, u.t1, round((u.m / 1000)::numeric, 6)
    from jsonb_to_recordset(p_usual) as u (cell bigint, t1 timestamptz, m float8)
  ),
  slotted as (
    -- Same as private.game_day and private.terrain_slot, inlined.
    select p.*, ((p.t at time zone v.time_zone) - v_reset)::date as day,
      ((p.cell / v_n) >> v_k) * v_an + ((p.cell % v_n) >> v_k) as area,
      (((p.cell % v_n) & (v_g - 1)) * v_g + ((p.cell / v_n) & (v_g - 1)) + 1)::int as pos
    from raw p
  ),
  placed as (
    select p.*, ta.grid is not null as terrain_known, v_names ->> substr(ta.grid, p.pos, 1) as terrain
    from slotted p
    left join public.terrain_areas ta on ta.area = p.area
  ),
  running as (
    select p.*,
      coalesce(case p.kind when 'usual' then d.usual_km else d.new_ground_km end, 0)
        + sum(p.km) over (partition by p.day, p.kind order by p.t, p.cell) as km_after,
      coalesce(d.usual_xp, 0) as day_usual_xp
    from placed p
    left join public.economy_days d on d.user_id = p_user and d.game_day = p.day
  ),
  capped as (
    select r.*,
      case r.kind
        when 'usual' then least((v_walk -> 'usualRoutes' ->> 'dailyCapKm')::numeric, r.km_after)
                        - least((v_walk -> 'usualRoutes' ->> 'dailyCapKm')::numeric, r.km_after - r.km)
        else r.km end as pay_km
    from running r
  ),
  usual_xp as (
    select c.*,
      case c.kind when 'usual' then
        c.day_usual_xp + sum(c.pay_km * (v_xp -> 'usualRoutes' ->> 'perKm')::numeric)
          over (partition by c.day, c.kind order by c.t, c.cell)
      end as usual_xp_after
    from capped c
  ),
  priced as (
    select u.*,
      case u.kind
        when 'usual' then
          least((v_xp -> 'usualRoutes' ->> 'dailyCap')::numeric, u.usual_xp_after)
          - least((v_xp -> 'usualRoutes' ->> 'dailyCap')::numeric,
                  u.usual_xp_after - u.pay_km * (v_xp -> 'usualRoutes' ->> 'perKm')::numeric)
        else private.new_ground_xp_upto(u.km_after, v_xp -> 'newGround' -> 'bands')
           - private.new_ground_xp_upto(u.km_after - u.km, v_xp -> 'newGround' -> 'bands')
      end as xp,
      u.pay_km * (v_walk -> (case u.kind when 'usual' then 'usualRoutes' else 'newGround' end) ->> 'goldPerKm')::numeric as gold,
      coalesce(v_walk -> (case u.kind when 'usual' then 'usualRoutes' else 'newGround' end)
        -> 'perKmByTerrain' -> u.terrain, '{}'::jsonb) as rates
    from usual_xp u
  )
  select coalesce(jsonb_agg(jsonb_build_object(
    'kind', kind, 'day', day, 'area', area, 'pos', pos, 'known', terrain_known, 'terrain', terrain,
    'km', km, 'payKm', pay_km, 'xp', xp, 'gold', gold,
    'wood', case when terrain_known then pay_km * coalesce((rates ->> 'wood')::numeric, 0) else 0 end,
    'stone', case when terrain_known then pay_km * coalesce((rates ->> 'stone')::numeric, 0) else 0 end,
    'crystal', case when terrain_known then pay_km * coalesce((rates ->> 'crystal')::numeric, 0) else 0 end,
    'gems', case when terrain_known then pay_km * coalesce((rates ->> 'gems')::numeric, 0) else 0 end
  )), '[]'::jsonb)
  into v_pieces
  from priced;

  -- Day totals, for the caps and bands of later walks.
  insert into public.economy_days as d (user_id, game_day, usual_km, usual_paid_km, usual_xp, new_ground_km, new_ground_xp)
  select p_user, x.day,
    coalesce(sum(x.km) filter (where x.kind = 'usual'), 0),
    coalesce(sum(x."payKm") filter (where x.kind = 'usual'), 0),
    coalesce(sum(x.xp) filter (where x.kind = 'usual'), 0),
    coalesce(sum(x.km) filter (where x.kind = 'new'), 0),
    coalesce(sum(x.xp) filter (where x.kind = 'new'), 0)
  from jsonb_to_recordset(v_pieces) as x (kind text, day date, km numeric, "payKm" numeric, xp numeric)
  group by x.day
  on conflict (user_id, game_day) do update
  set usual_km = d.usual_km + excluded.usual_km,
    usual_paid_km = d.usual_paid_km + excluded.usual_paid_km,
    usual_xp = d.usual_xp + excluded.usual_xp,
    new_ground_km = d.new_ground_km + excluded.new_ground_km,
    new_ground_xp = d.new_ground_xp + excluded.new_ground_xp;

  -- Terrain resources for cells whose terrain isn't known yet.
  insert into public.terrain_pending as tp (user_id, area, pos, game_day, kind, km)
  select p_user, x.area, x.pos, x.day, x.kind, sum(x."payKm")
  from jsonb_to_recordset(v_pieces) as x (kind text, day date, area bigint, pos int, known boolean, "payKm" numeric)
  where not x.known and x."payKm" > 0
  group by x.area, x.pos, x.day, x.kind
  on conflict (user_id, area, pos, game_day, kind) do update set km = tp.km + excluded.km;

  select
    coalesce(sum(x.gold), 0) as gold, coalesce(sum(x.wood), 0) as wood, coalesce(sum(x.stone), 0) as stone,
    coalesce(sum(x.crystal), 0) as crystal, coalesce(sum(x.gems), 0) as gems, coalesce(sum(x.xp), 0) as xp,
    coalesce(sum(x.km) filter (where x.kind = 'new'), 0) as new_km,
    coalesce(sum(x.km) filter (where x.kind = 'usual'), 0) as usual_km,
    coalesce(sum(x."payKm") filter (where x.kind = 'usual'), 0) as usual_paid_km,
    coalesce(sum(x."payKm") filter (where not x.known), 0) as pending_km
  into t
  from jsonb_to_recordset(v_pieces) as x (kind text, known boolean, km numeric, "payKm" numeric, xp numeric,
    gold numeric, wood numeric, stone numeric, crystal numeric, gems numeric);

  perform private.credit(p_user, 'walk', p_ref, t.gold, t.wood, t.stone, t.crystal, t.gems, t.xp,
    jsonb_build_object('newGroundKm', t.new_km, 'usualKm', t.usual_km, 'usualPaidKm', t.usual_paid_km,
      'pendingTerrainKm', t.pending_km));

  return jsonb_build_object(
    'gold', t.gold, 'wood', t.wood, 'stone', t.stone, 'crystal', t.crystal, 'gems', t.gems, 'xp', t.xp,
    'newGroundKm', t.new_km, 'usualKm', t.usual_km, 'usualPaidKm', t.usual_paid_km,
    'pendingTerrainKm', t.pending_km,
    'rulerLevel', private.ruler_level(v.ruler_xp + t.xp),
    'levelUp', private.ruler_level(v.ruler_xp + t.xp) > v_level_before);
end;
$$;

comment on function private.pay_walk(uuid, text, jsonb, jsonb) is
  'Pays new-ground cells and usual-route segments of one claim step, applying the daily caps and XP bands. Returns the totals.';

-- ---------------------------------------------------------------------------
-- Claiming, now with pay. Same claim rule as *_vehicle_buffer.sql; it also
-- pays for what it claims, in the same statement order and transaction.
-- ---------------------------------------------------------------------------

drop function private.claim_settled(uuid, text, timestamptz, timestamptz);

-- Claims the cells of every claimable walking segment of one session whose
-- end time lies in [p_from, p_to], and of every claimable isolated point in
-- that range, then pays for them: the new cells as new ground, and the
-- not-yet-paid claimable segments that run on the player's own land as usual
-- routes. Re-evaluating a range is safe: inserts skip owned cells, and paid
-- segments are skipped. The caller holds the walk_sessions row lock.
create function private.claim_settled(
  p_user uuid, p_session text, p_from timestamptz, p_to timestamptz, p_ref text,
  out new_cells int, out reward jsonb
)
language plpgsql
set search_path = ''
as $$
declare
  r record;
  v_w interval;
  v_gap interval;
  v_own interval := (select own_land_min_age from private.economy_limits());
  v_closed boolean;
  v_last timestamptz;
  v_new jsonb;
  v_usual jsonb;
  v_segments int;
begin
  new_cells := 0;
  reward := null;
  select * into r from private.claim_rules();
  v_w := make_interval(secs => r.vehicle_buffer_s);
  v_gap := make_interval(secs => r.max_gap_s);

  select closed_at is not null into v_closed
  from public.walk_sessions
  where user_id = p_user and session_id = p_session;

  select max(recorded_at) into v_last
  from public.walk_points
  where user_id = p_user and session_id = p_session;

  if v_last is null or p_from > p_to then
    return;
  end if;

  with seq as (
    -- Points around the range, so every candidate sees its true neighbors: a
    -- neighbor further than max_gap_s away is a gap whether it's loaded or not.
    select recorded_at, geom,
      lag(recorded_at) over w as prev_t,
      lag(geom) over w as prev_geom,
      extensions.st_distance(lag(geom) over w::extensions.geography, geom::extensions.geography, false) as dist_m,
      private.segment_kind(
        extract(epoch from recorded_at - lag(recorded_at) over w)::float8,
        extensions.st_distance(lag(geom) over w::extensions.geography, geom::extensions.geography, false)
      ) as in_kind
    from public.walk_points
    where user_id = p_user and session_id = p_session
      and recorded_at between p_from - v_gap and p_to + v_gap
    window w as (order by recorded_at)
  ),
  kinds as (
    select *, lead(in_kind) over (order by recorded_at) as out_kind
    from seq
  ),
  shapes as (
    -- Walking segments, as [t0, t1] = [t_p, t_q].
    select extensions.st_makeline(prev_geom, geom) as g, prev_t as t0, recorded_at as t1, dist_m, true as is_segment
    from kinds
    where in_kind = 'walk' and recorded_at between p_from and p_to
    union all
    -- Points with no neighbor in reach: a disk around the point.
    select geom, recorded_at, recorded_at, 0, false
    from kinds
    where coalesce(in_kind, 'gap') = 'gap' and coalesce(out_kind, 'gap') = 'gap'
      and recorded_at between p_from and p_to
  ),
  fast as (
    -- The player's fast segments in every session that could overlap a
    -- candidate's buffer. A fast segment is at most max_gap_s long, so its
    -- start lies within max_gap_s before its end and is loaded too.
    select t0, t1
    from (
      select lag(recorded_at) over w as t0, recorded_at as t1,
        private.segment_kind(
          extract(epoch from recorded_at - lag(recorded_at) over w)::float8,
          extensions.st_distance(lag(geom) over w::extensions.geography, geom::extensions.geography, false)
        ) as kind
      from public.walk_points
      where user_id = p_user
        and recorded_at between p_from - v_w - 2 * v_gap and p_to + v_w + v_gap
      window w as (partition by session_id order by recorded_at)
    ) s
    where kind = 'fast'
  ),
  claimable as (
    select s.*
    from shapes s
    where (v_closed or s.t1 + v_w <= v_last)
      and not exists (
        select 1 from fast f
        where f.t0 <= s.t1 + v_w and f.t1 >= s.t0 - v_w)
  ),
  cells as (
    select c.cell, min(s.t1) as t
    from claimable s
    cross join lateral private.cells_near(extensions.st_transform(s.g, 3857), r.claim_radius_m) as c (cell)
    group by c.cell
  ),
  inserted as (
    insert into public.claimed_cells (user_id, cell, first_claimed_at)
    select p_user, cell, t from cells
    on conflict (user_id, cell) do nothing
    returning cell, first_claimed_at
  ),
  segments as (
    -- Claimable walking segments that no earlier evaluation paid.
    select s.t0, s.t1, s.dist_m,
      private.tile_of(extensions.st_transform(extensions.st_lineinterpolatepoint(s.g, 0.5), 3857), r.cell_zoom) as mid
    from claimable s
    where s.is_segment
      and not exists (
        select 1 from public.walk_points x
        where x.user_id = p_user and x.session_id = p_session
          and x.paid_segment_start is not null
          and x.paid_segment_start < s.t1 and x.recorded_at > s.t0)
  ),
  marked as (
    update public.walk_points w
    set paid_segment_start = s.t0
    from segments s
    where w.user_id = p_user and w.session_id = p_session and w.recorded_at = s.t1
    returning 1
  ),
  usual as (
    -- On your own land: the cell under the middle was claimed well before the
    -- segment started, by an earlier walk or earlier in this one. A cell this
    -- statement inserts has first_claimed_at = cells.t.
    select s.mid, s.t1, s.dist_m
    from segments s
    left join public.claimed_cells cc on cc.user_id = p_user and cc.cell = s.mid
    left join cells nc on nc.cell = s.mid
    where coalesce(cc.first_claimed_at, nc.t) < s.t0 - v_own
      and s.dist_m > 0
  )
  select
    (select count(*) from inserted),
    (select coalesce(jsonb_agg(jsonb_build_object('cell', cell, 't', first_claimed_at)), '[]'::jsonb) from inserted),
    (select coalesce(jsonb_agg(jsonb_build_object('cell', mid, 't1', t1, 'm', dist_m)), '[]'::jsonb) from usual),
    (select count(*) from marked)
  into new_cells, v_new, v_usual, v_segments;

  if jsonb_array_length(v_new) > 0 or jsonb_array_length(v_usual) > 0 then
    reward := private.pay_walk(p_user, p_ref, v_new, v_usual);
  end if;
end;
$$;

comment on function private.claim_settled(uuid, text, timestamptz, timestamptz, text) is
  'Claims the cells of settled, vehicle-free walking segments (and isolated points) of a session ending in [p_from, p_to], and pays for them. Returns the number of new cells and the reward (null when nothing paid).';

-- Same contract as before, plus reward in the result: what this batch paid
-- (null when nothing). See *_vehicle_buffer.sql for the claim rule.
create or replace function public.submit_location_batch(p_batch_id text, p_session_id text, p_points jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  r record;
  v_user uuid := auth.uid();
  v_received int;
  v_accepted int := 0;
  v_new_cells int := 0;
  v_reward jsonb;
  v_total int;
  v_tmin timestamptz;
  v_tmax timestamptz;
  v_from timestamptz;
  v_to timestamptz;
begin
  if v_user is null then
    raise exception 'Not signed in' using errcode = '42501';
  end if;

  select * into r from private.claim_rules();

  if p_batch_id is null or char_length(p_batch_id) not between 1 and 64 then
    raise exception 'batch id must be 1 to 64 characters' using errcode = '22023';
  end if;
  if p_session_id is null or char_length(p_session_id) not between 1 and 64 then
    raise exception 'session id must be 1 to 64 characters' using errcode = '22023';
  end if;
  if p_points is null or jsonb_typeof(p_points) <> 'array' then
    raise exception 'points must be a JSON array' using errcode = '22023';
  end if;
  v_received := jsonb_array_length(p_points);
  if v_received > r.max_batch_points then
    raise exception 'too many points in one batch (max %)', r.max_batch_points using errcode = '22023';
  end if;

  -- Idempotency. A concurrent retry blocks here until the first call commits,
  -- then sees the conflict. A repeated batch pays nothing.
  insert into public.location_batches (user_id, batch_id, session_id, received_points)
  values (v_user, p_batch_id, p_session_id, v_received)
  on conflict (user_id, batch_id) do nothing;

  if not found then
    select count(*) into v_total from public.claimed_cells where user_id = v_user;
    return jsonb_build_object(
      'acceptedPoints', 0, 'rejectedPoints', 0, 'newCells', 0,
      'totalCells', v_total, 'duplicate', true, 'reward', null);
  end if;

  -- Serialize batches of the same session.
  insert into public.walk_sessions (user_id, session_id)
  values (v_user, p_session_id)
  on conflict (user_id, session_id) do nothing;
  perform 1 from public.walk_sessions
  where user_id = v_user and session_id = p_session_id
  for update;

  -- Validate and store points. Values are compared as numeric before any cast,
  -- so malformed input is rejected instead of raising.
  with raw as (
    select e, ord
    from jsonb_array_elements(p_points) with ordinality as x (e, ord)
  ),
  typed as (
    select ord,
      case when jsonb_typeof(e -> 't') = 'number' then (e ->> 't')::numeric end as t_ms,
      case when jsonb_typeof(e -> 'lat') = 'number' then (e ->> 'lat')::numeric end as lat,
      case when jsonb_typeof(e -> 'lng') = 'number' then (e ->> 'lng')::numeric end as lng,
      case when jsonb_typeof(e -> 'acc') = 'number' then (e ->> 'acc')::numeric end as acc,
      case when jsonb_typeof(e -> 'spd') = 'number' then (e ->> 'spd')::numeric end as spd
    from raw
    where jsonb_typeof(e) = 'object'
  ),
  checked as (
    select ord, to_timestamp((t_ms / 1000)::float8) as recorded_at, lat, lng, acc, spd
    from typed
    where t_ms between 0 and 1e14
      and lat between -85 and 85
      and lng between -180 and 180
      and acc between 0 and r.max_accuracy_m
  ),
  fresh as (
    select distinct on (recorded_at) *
    from checked
    where recorded_at <= now() + r.max_clock_skew
      and recorded_at >= now() - r.max_point_age
    order by recorded_at, ord
  )
  insert into public.walk_points (user_id, session_id, batch_id, recorded_at, geom, accuracy_m, speed_mps)
  select v_user, p_session_id, p_batch_id, recorded_at,
    extensions.st_setsrid(extensions.st_makepoint(lng::float8, lat::float8), 4326),
    acc::real,
    case when spd between -1e6 and 1e6 then spd::real end
  from fresh
  on conflict (user_id, session_id, recorded_at) do nothing;

  get diagnostics v_accepted = row_count;

  if v_accepted > 0 then
    select min(recorded_at), max(recorded_at) into v_tmin, v_tmax
    from public.walk_points
    where user_id = v_user and session_id = p_session_id and batch_id = p_batch_id;

    -- Segments that may have changed state: the new ones (touching this
    -- batch's points, from the nearest stored point before it to the nearest
    -- after it), and the older ones that were unsettled until now. With
    -- batches in time order, an older segment was unsettled exactly when it
    -- ends after (previous last point - W), and the previous last point is v_from.
    select coalesce(max(recorded_at), v_tmin) into v_from
    from public.walk_points
    where user_id = v_user and session_id = p_session_id and recorded_at < v_tmin;
    select coalesce(min(recorded_at), v_tmax) into v_to
    from public.walk_points
    where user_id = v_user and session_id = p_session_id and recorded_at > v_tmax;

    select c.new_cells, c.reward into v_new_cells, v_reward
    from private.claim_settled(
      v_user, p_session_id, v_from - make_interval(secs => r.vehicle_buffer_s), v_to, p_batch_id) c;
  end if;

  -- Session stats, recomputed over the stored points of the session.
  update public.walk_sessions ws
  set batch_count = ws.batch_count + 1,
    rejected_count = ws.rejected_count + (v_received - v_accepted),
    new_cells = ws.new_cells + v_new_cells,
    point_count = s.n,
    first_point_at = s.t0,
    last_point_at = s.t1,
    distance_on_foot_m = s.dist,
    updated_at = now()
  from (
    select count(*)::int as n, min(recorded_at) as t0, max(recorded_at) as t1,
      coalesce(sum(d) filter (where private.segment_kind(dt, d) = 'walk'), 0) as dist
    from (
      select recorded_at,
        extract(epoch from recorded_at - lag(recorded_at) over w)::float8 as dt,
        extensions.st_distance(lag(geom) over w::extensions.geography, geom::extensions.geography, false) as d
      from public.walk_points
      where user_id = v_user and session_id = p_session_id
      window w as (order by recorded_at)
    ) p
  ) s
  where ws.user_id = v_user and ws.session_id = p_session_id;

  update public.location_batches
  set accepted_points = v_accepted,
    rejected_points = v_received - v_accepted,
    new_cells = v_new_cells
  where user_id = v_user and batch_id = p_batch_id;

  select count(*) into v_total from public.claimed_cells where user_id = v_user;

  return jsonb_build_object(
    'acceptedPoints', v_accepted,
    'rejectedPoints', v_received - v_accepted,
    'newCells', v_new_cells,
    'totalCells', v_total,
    'duplicate', false,
    'reward', v_reward);
end;
$$;

comment on function public.submit_location_batch(text, text, jsonb) is
  'Reports one batch of GPS points from a tracking session and pays for the walking it settles. Idempotent per batch id. Returns {acceptedPoints, rejectedPoints, newCells, totalCells, duplicate, reward}.';

-- Same contract as before, plus reward: what closing paid (null when nothing).
create or replace function public.close_walk_session(p_session_id text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  r record;
  v_user uuid := auth.uid();
  v_last timestamptz;
  v_closed boolean;
  v_new_cells int := 0;
  v_reward jsonb;
  v_total int;
begin
  if v_user is null then
    raise exception 'Not signed in' using errcode = '42501';
  end if;
  if p_session_id is null or char_length(p_session_id) not between 1 and 64 then
    raise exception 'session id must be 1 to 64 characters' using errcode = '22023';
  end if;

  select * into r from private.claim_rules();

  -- Same lock as submit_location_batch, so a batch in flight finishes first.
  update public.walk_sessions
  set closed_at = coalesce(closed_at, now()), updated_at = now()
  where user_id = v_user and session_id = p_session_id;
  v_closed := found;

  if v_closed then
    -- Everything ending before (last point - W) was settled already.
    select max(recorded_at) into v_last
    from public.walk_points
    where user_id = v_user and session_id = p_session_id;

    if v_last is not null then
      select c.new_cells, c.reward into v_new_cells, v_reward
      from private.claim_settled(
        v_user, p_session_id, v_last - make_interval(secs => r.vehicle_buffer_s), v_last,
        'close:' || p_session_id) c;
      update public.walk_sessions
      set new_cells = new_cells + v_new_cells
      where user_id = v_user and session_id = p_session_id;
    end if;
  end if;

  select count(*) into v_total from public.claimed_cells where user_id = v_user;

  return jsonb_build_object('newCells', v_new_cells, 'totalCells', v_total, 'closed', v_closed, 'reward', v_reward);
end;
$$;

comment on function public.close_walk_session(text) is
  'Marks a tracking session finished, claims its last, now settled segments, and pays for them. Idempotent. Returns {newCells, totalCells, closed, reward}.';

-- ---------------------------------------------------------------------------
-- Terrain: the terrain Edge Function leases areas with pending pay, classifies
-- their vector tile, and stores the result here, which pays what waited.
-- ---------------------------------------------------------------------------

-- Leases up to p_max areas where the player has pending terrain pay and no
-- terrain is stored, and returns each with the classification request. Areas
-- another caller is fetching come back with request null.
create function public.claim_terrain_areas(p_user uuid, p_max int default null)
returns table (area bigint, request jsonb)
language plpgsql
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  t record;
begin
  select * into t from private.terrain_rules();

  return query
  with wanted as (
    select distinct tp.area as a from public.terrain_pending tp where tp.user_id = p_user
  ),
  todo as (
    select w.a
    from wanted w
    left join public.terrain_areas ta on ta.area = w.a
    where (ta.area is null or ta.grid is null)
      and (ta.lease_until is null or ta.lease_until < now())
      and (ta.failed_at is null or ta.failed_at < now() - t.retry_after)
    order by w.a
    limit least(coalesce(p_max, t.max_areas_per_call), t.max_areas_per_call)
  ),
  leased as (
    insert into public.terrain_areas as ta (area, lease_until)
    select d.a, now() + t.lease from todo d
    on conflict on constraint terrain_areas_pkey do update
      set lease_until = excluded.lease_until
      where ta.lease_until is null or ta.lease_until < now()
    returning ta.area
  )
  select l.area, private.terrain_filter() from leased l
  union all
  select w.a, null::jsonb
  from wanted w
  join public.terrain_areas ta on ta.area = w.a
  where ta.grid is null and ta.lease_until >= now();
end;
$$;

comment on function public.claim_terrain_areas(uuid, int) is
  'Service role only. Leases areas whose terrain the player is waiting for and returns {area, request}; request is null for areas another caller is fetching.';

-- Stores an area's terrain and pays every player's pending terrain resources
-- in it. Errors: 22023 for a grid of the wrong size or with unknown codes.
create function public.ingest_terrain_area(p_area bigint, p_grid text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_filter jsonb := private.terrain_filter();
  v_walk jsonb := private.economy_rules() -> 'walking';
  v_cells int := ((v_filter ->> 'grid')::int) ^ 2;
  v_codes text;
  v_paid jsonb;
  u record;
  v_players int := 0;
begin
  select string_agg(c ->> 'code', '') || (v_filter ->> 'none_code') into v_codes
  from jsonb_array_elements(v_filter -> 'classes') c;
  if p_grid is null or char_length(p_grid) <> v_cells then
    raise exception 'grid must have % characters', v_cells using errcode = '22023';
  end if;
  if translate(p_grid, v_codes, '') <> '' then
    raise exception 'grid may only contain the characters %', v_codes using errcode = '22023';
  end if;

  insert into public.terrain_areas as ta (area, grid, fetched_at)
  values (p_area, p_grid, now())
  on conflict on constraint terrain_areas_pkey do update
  set grid = excluded.grid, fetched_at = excluded.fetched_at,
    lease_until = null, failed_at = null, last_error = null;

  -- Take what waited, priced per player.
  with settled as (
    delete from public.terrain_pending tp where tp.area = p_area
    returning tp.user_id, tp.kind, tp.km, private.terrain_name(substr(p_grid, tp.pos, 1)) as terrain
  ),
    priced as (
    select s.user_id, s.km,
      coalesce(v_walk -> (case s.kind when 'usual' then 'usualRoutes' else 'newGround' end)
        -> 'perKmByTerrain' -> s.terrain, '{}'::jsonb) as rates
      from settled s
  ),
  per_player as (
    select p.user_id,
      sum(p.km * coalesce((p.rates ->> 'wood')::numeric, 0)) as wood,
      sum(p.km * coalesce((p.rates ->> 'stone')::numeric, 0)) as stone,
      sum(p.km * coalesce((p.rates ->> 'crystal')::numeric, 0)) as crystal,
      sum(p.km * coalesce((p.rates ->> 'gems')::numeric, 0)) as gems,
      sum(p.km) as km
    from priced p
    group by p.user_id
  )
  select coalesce(jsonb_agg(to_jsonb(pp) order by pp.user_id), '[]'::jsonb) into v_paid
  from per_player pp;

  -- Pay, one player at a time, in a fixed order.
  for u in
    select * from jsonb_to_recordset(v_paid)
      as x (user_id uuid, wood numeric, stone numeric, crystal numeric, gems numeric, km numeric)
    order by user_id
  loop
    perform private.ensure_economy(u.user_id);
    perform private.credit(u.user_id, 'terrain', p_area::text, 0, u.wood, u.stone, u.crystal, u.gems, 0,
      jsonb_build_object('km', u.km));
    v_players := v_players + 1;
  end loop;

  return jsonb_build_object('area', p_area, 'playersPaid', v_players);
end;
$$;

comment on function public.ingest_terrain_area(bigint, text) is
  'Service role only. Stores the terrain grid of an area and pays the terrain resources that waited for it.';

create function public.fail_terrain_area(p_area bigint, p_error text)
returns void
language sql
security definer
set search_path = ''
as $$
  update public.terrain_areas
  set lease_until = null, failed_at = now(), last_error = left(p_error, 500)
  where area = p_area
$$;

comment on function public.fail_terrain_area(bigint, text) is
  'Service role only. Releases an area lease after a failed fetch; it is retried after terrain_rules().retry_after.';

-- ---------------------------------------------------------------------------
-- Read
-- ---------------------------------------------------------------------------

-- The economy as the app shows it. Whole units (floor) for resources and XP.
create function private.economy_json(p_user uuid, p_at timestamptz)
returns jsonb
language sql
stable
set search_path = ''
as $$
  select jsonb_build_object(
    'resources', jsonb_build_object(
      'gold', floor(e.gold), 'wood', floor(e.wood), 'stone', floor(e.stone),
      'crystal', floor(e.crystal), 'gems', floor(e.gems)),
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

-- Returns the caller's economy, after storing their time zone (when given)
-- and paying any Keep tax due. Creates the economy with the starting
-- resources on first use. p_time_zone is an IANA name such as Europe/Warsaw;
-- an unknown name, or a change within 24 hours of the last one, is ignored
-- (timeZoneAccepted false). Errors: 42501 when not signed in.
create function public.get_economy(p_time_zone text default null)
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
  v_tax := private.settle_keep_tax(v_user, now());
  return private.economy_json(v_user, now())
    || jsonb_build_object('keepTaxPaid', v_tax, 'timeZoneAccepted', v_tz_ok);
end;
$$;

comment on function public.get_economy(text) is
  'Stores the app''s time zone, pays any Keep tax due, and returns the caller''s resources, Ruler XP and level, and today''s walking.';

-- Function privileges.
revoke all on all functions in schema private from public, anon, authenticated;
revoke all on function public.get_economy(text) from public, anon;
revoke all on function public.claim_terrain_areas(uuid, int) from public, anon, authenticated;
revoke all on function public.ingest_terrain_area(bigint, text) from public, anon, authenticated;
revoke all on function public.fail_terrain_area(bigint, text) from public, anon, authenticated;
grant execute on function public.get_economy(text) to authenticated;
grant execute on function public.claim_terrain_areas(uuid, int) to service_role;
grant execute on function public.ingest_terrain_area(bigint, text) to service_role;
grant execute on function public.fail_terrain_area(bigint, text) to service_role;
