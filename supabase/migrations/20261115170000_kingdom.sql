-- The kingdom: buildings, the daily construction, Pikemen, and Treasury caps.
--
-- The numbers come from private.economy_rules(), which
-- scripts/generate-rules.mjs generates from Local Legend_Economy.xlsx (see
-- docs/rules.md). This file holds only how the rules are applied; the values
-- that the sheet doesn't give are in private.kingdom_settings(). docs/kingdom.md
-- describes the rules for players and testers.
--
-- Postgres is the authority for every spend. build_building and recruit_units
-- lock the player's economy row, so a player's actions run one at a time, and
-- record every action under the app's request id: a retried request returns
-- the first result and changes nothing.
--
-- Constructions: instant, rules.construction.buildsPerDay per game day (the
--   4 a.m. local day of *_economy.sql). A building can't pass the Keep's level
--   (requiredKeepLevel), and every level needs its Ruler level. Building pays
--   the level's cost and its construction XP.
-- Pikemen: recruits grow each Monday (the game day, so from 4 a.m. local) at
--   the Barracks level the week started with. Unrecruited ones carry over one
--   extra week.
-- Treasury caps: once a Treasury exists, gold, wood, and stone pay only up to
--   its caps. Spending is never capped.

-- ---------------------------------------------------------------------------
-- Settings the sheet doesn't give, in one place
-- ---------------------------------------------------------------------------

create function private.kingdom_settings(
  out plots text[],              -- Buildings on the kingdom screen. Only these can be built.
  out recruitable_units text[],  -- Units the Barracks recruits for now.
  out max_recruit_per_request int -- Input guard, not a game rule.
)
language sql
immutable
parallel safe
set search_path = ''
as $$
  -- Phase 2 builds four plots and only Pikemen (IMPLEMENTATION_PLAN.md).
  select array['keep', 'treasury', 'walls', 'barracks'], array['pikeman'], 1000
$$;

comment on function private.kingdom_settings() is 'Kingdom settings that are not in the economy sheet.';

-- ---------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------

-- A missing row means the building's rules.buildings.<id>.startLevel: 1 for
-- the Keep, 0 (not built) for everything else.
create table public.player_buildings (
  user_id uuid not null references auth.users (id) on delete cascade,
  building text not null,
  level int not null check (level >= 0),
  updated_at timestamptz not null default now(),
  primary key (user_id, building)
);

comment on table public.player_buildings is
  'Building levels. A missing row is the building''s start level. Written only by build_building; owner-readable.';

create table public.player_garrison (
  user_id uuid not null references auth.users (id) on delete cascade,
  unit text not null,
  count int not null check (count >= 0),
  updated_at timestamptz not null default now(),
  primary key (user_id, unit)
);

comment on table public.player_garrison is
  'Units defending the kingdom. Written only by the kingdom functions (and, later, the surge); owner-readable.';

-- Every construction and recruitment, keyed by the app's request id. Also the
-- history the daily limit and the weekly recruits are computed from.
create table public.kingdom_actions (
  id bigint generated always as identity primary key,
  user_id uuid not null references auth.users (id) on delete cascade,
  request_id uuid not null,
  kind text not null check (kind in ('build', 'recruit')),
  game_day date not null,
  building text null,
  level int null,
  unit text null,
  count int null,
  batches jsonb null,
  result jsonb not null,
  created_at timestamptz not null default now(),
  unique (user_id, request_id),
  check ((kind = 'build') = (building is not null and level is not null)),
  check ((kind = 'recruit') = (unit is not null and count is not null and batches is not null))
);

comment on table public.kingdom_actions is
  'Constructions and recruitments, one row per request id. A retried request returns result and changes nothing.';
comment on column public.kingdom_actions.game_day is
  'The game day of the action in the player''s time zone at the time.';
comment on column public.kingdom_actions.batches is
  'recruit: recruits taken from each week''s batch, {"<monday>": count}.';

create index kingdom_actions_history_idx on public.kingdom_actions (user_id, kind, game_day);

-- The ledger records spending too.
alter table public.economy_ledger drop constraint economy_ledger_reason_check;
alter table public.economy_ledger add constraint economy_ledger_reason_check
  check (reason in ('start', 'keep_tax', 'walk', 'terrain', 'build', 'recruit'));

comment on column public.economy_ledger.ref is
  'walk: the batch id, or close:<session id>. keep_tax: the last game day paid. terrain: the area. build, recruit: the request id.';

revoke all on table public.player_buildings, public.player_garrison, public.kingdom_actions
  from anon, authenticated;
grant select on table public.player_buildings, public.player_garrison, public.kingdom_actions
  to authenticated;

alter table public.player_buildings enable row level security;
alter table public.player_garrison enable row level security;
alter table public.kingdom_actions enable row level security;

create policy "Players can read their own buildings" on public.player_buildings
for select to authenticated using ((select auth.uid()) = user_id);

create policy "Players can read their own garrison" on public.player_garrison
for select to authenticated using ((select auth.uid()) = user_id);

create policy "Players can read their own kingdom actions" on public.kingdom_actions
for select to authenticated using ((select auth.uid()) = user_id);

-- ---------------------------------------------------------------------------
-- Rule helpers
-- ---------------------------------------------------------------------------

-- The player's level of a building: the stored level, or the start level.
create function private.building_level(p_user uuid, p_building text)
returns int
language sql
stable
set search_path = ''
as $$
  select coalesce(
    (select b.level from public.player_buildings b where b.user_id = p_user and b.building = p_building),
    (private.economy_rules() -> 'buildings' -> p_building ->> 'startLevel')::int,
    0)
$$;

-- The Keep level now comes from the kingdom. The Keep tax (settle_keep_tax in
-- *_economy.sql) reads it; build_building settles the tax before it builds, so
-- days that passed before an upgrade pay at the level they had.
create or replace function private.keep_level(p_user uuid)
returns int
language sql
stable
set search_path = ''
as $$
  select private.building_level(p_user, 'keep')
$$;

-- The Treasury's storage caps {goldCap, woodCap, stoneCap}, or null without a
-- Treasury. The sheet has caps only from level 1, so nothing is capped before.
create function private.treasury_caps(p_user uuid)
returns jsonb
language sql
stable
set search_path = ''
as $$
  select case when l.level > 0
    then private.economy_rules() -> 'buildings' -> 'treasury' -> 'levels' -> (l.level - 1) -> 'effects'
  end
  from (select private.building_level(p_user, 'treasury') as level) l
$$;

-- The Monday that starts the game week of a game day.
create function private.game_week(p_day date)
returns date
language sql
immutable
parallel safe
set search_path = ''
as $$
  select p_day - (extract(isodow from p_day)::int - 1)
$$;

-- The moment a game day starts in a time zone: rules.dailyResetHour local.
create function private.game_day_start(p_day date, p_time_zone text)
returns timestamptz
language sql
stable
parallel safe
set search_path = ''
as $$
  select (p_day + make_interval(hours => (private.economy_rules() ->> 'dailyResetHour')::int)) at time zone p_time_zone
$$;

-- The player's current game day and week for kingdom actions. They never go
-- back: after a time zone change to the west, the day stays at the latest one
-- an action already used until the clock catches up. That way a zone change
-- can't reopen a day that already built or a batch of recruits that expired.
create function private.kingdom_today(p_user uuid, p_at timestamptz, out today date, out week date)
language sql
stable
set search_path = ''
as $$
  select d.day, private.game_week(d.day)
  from (
    select greatest(
      private.game_day(p_at, e.time_zone),
      (select max(a.game_day) from public.kingdom_actions a where a.user_id = p_user)) as day
    from public.player_economy e
    where e.user_id = p_user
  ) d
$$;

-- Recruits of a unit that grow in the week starting p_week: the sheet's
-- ROUND(base × (1 + Barracks_Bonus × (level − unlock level))) at the level of
-- the unit's building when the week started. A week in which the building is
-- first built grows at the level it was first built to, at once.
create function private.weekly_recruits(p_user uuid, p_unit text, p_week date)
returns int
language sql
stable
set search_path = ''
as $$
  with u as (
    select private.economy_rules() -> 'units' -> p_unit as unit
  ),
  lvl as (
    select coalesce(
      (select max(a.level) from public.kingdom_actions a
        where a.user_id = p_user and a.kind = 'build' and a.building = u.unit ->> 'building'
          and a.game_day < p_week),
      (select a.level from public.kingdom_actions a
        where a.user_id = p_user and a.kind = 'build' and a.building = u.unit ->> 'building'
          and a.game_day >= p_week and a.game_day < p_week + 7
        order by a.game_day, a.id limit 1),
      (private.economy_rules() -> 'buildings' -> (u.unit ->> 'building') ->> 'startLevel')::int) as level,
      (u.unit ->> 'buildingLevel')::int as unlock,
      (u.unit ->> 'recruitsPerWeek')::numeric as base
    from u
  )
  select case when level < unlock then 0
    else round(base * (1 + (private.economy_rules() -> 'recruitment' ->> 'barracksBonusPerLevel')::numeric
      * (level - unlock)))::int
  end
  from lvl
$$;

-- Recruits of p_unit available in p_week: what grew this week and last week,
-- minus what was taken from each batch.
create function private.recruit_pool(p_user uuid, p_unit text, p_week date)
returns jsonb
language sql
stable
set search_path = ''
as $$
  with b as (
    select w.week, private.weekly_recruits(p_user, p_unit, w.week) as grown,
      (select coalesce(sum((a.batches ->> w.week::text)::int), 0) from public.kingdom_actions a
        where a.user_id = p_user and a.kind = 'recruit' and a.unit = p_unit) as taken
    from (values (p_week - 7), (p_week)) as w (week)
  )
  select jsonb_build_object(
    'lastWeek', (select greatest(0, grown - taken) from b where week = p_week - 7),
    'thisWeek', (select greatest(0, grown - taken) from b where week = p_week),
    'available', (select sum(greatest(0, grown - taken)) from b))
$$;

-- What a cost would leave missing: {resource: amount} for each resource short,
-- or null when the player can pay.
create function private.missing(v public.player_economy, p_cost jsonb)
returns jsonb
language sql
stable
set search_path = ''
as $$
  select jsonb_object_agg(r.key, ceil(r.need - r.have))
  from (values
    ('gold', (p_cost ->> 'gold')::numeric, v.gold),
    ('wood', (p_cost ->> 'wood')::numeric, v.wood),
    ('stone', (p_cost ->> 'stone')::numeric, v.stone),
    ('crystal', (p_cost ->> 'crystal')::numeric, v.crystal),
    ('gems', (p_cost ->> 'gems')::numeric, v.gems)
  ) as r (key, need, have)
  where r.have < r.need
$$;

revoke all on all functions in schema private from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- Balances, now with Treasury caps
-- ---------------------------------------------------------------------------

-- Adds to a player's balances and records the change. The row must exist and
-- should be locked. With a Treasury, gold, wood, and stone are paid only up to
-- its caps; what doesn't fit is recorded in details.capped and lost. A balance
-- already above a cap (saved before the Treasury) is kept. Negative amounts
-- (spending) are never capped. Crystal, gems, and XP have no cap.
create or replace function private.credit(
  p_user uuid, p_reason text, p_ref text,
  p_gold numeric, p_wood numeric, p_stone numeric, p_crystal numeric, p_gems numeric, p_xp numeric,
  p_details jsonb default null
)
returns void
language plpgsql
set search_path = ''
as $$
declare
  v_caps jsonb := private.treasury_caps(p_user);
  v_gold numeric := p_gold;
  v_wood numeric := p_wood;
  v_stone numeric := p_stone;
  v_capped jsonb;
  e record;
begin
  if p_gold = 0 and p_wood = 0 and p_stone = 0 and p_crystal = 0 and p_gems = 0 and p_xp = 0 then
    return;
  end if;
  if v_caps is not null then
    select gold, wood, stone into e from public.player_economy where user_id = p_user;
    if p_gold > 0 then v_gold := least(p_gold, greatest(0, (v_caps ->> 'goldCap')::numeric - e.gold)); end if;
    if p_wood > 0 then v_wood := least(p_wood, greatest(0, (v_caps ->> 'woodCap')::numeric - e.wood)); end if;
    if p_stone > 0 then v_stone := least(p_stone, greatest(0, (v_caps ->> 'stoneCap')::numeric - e.stone)); end if;
    select jsonb_object_agg(k, v) into v_capped
    from (values ('gold', p_gold - v_gold), ('wood', p_wood - v_wood), ('stone', p_stone - v_stone)) as c (k, v)
    where v > 0;
  end if;
  update public.player_economy
  set gold = gold + v_gold, wood = wood + v_wood, stone = stone + v_stone,
    crystal = crystal + p_crystal, gems = gems + p_gems, ruler_xp = ruler_xp + p_xp,
    updated_at = now()
  where user_id = p_user;
  insert into public.economy_ledger (user_id, reason, ref, gold, wood, stone, crystal, gems, xp, details)
  values (p_user, p_reason, p_ref, v_gold, v_wood, v_stone, p_crystal, p_gems, p_xp,
    case when v_capped is null then p_details
         else coalesce(p_details, '{}'::jsonb) || jsonb_build_object('capped', v_capped) end);
end;
$$;

-- ---------------------------------------------------------------------------
-- The kingdom as the app shows it
-- ---------------------------------------------------------------------------

create function private.kingdom_json(p_user uuid, p_at timestamptz)
returns jsonb
language sql
stable
set search_path = ''
as $$
  with e as (
    select * from public.player_economy where user_id = p_user
  ),
  t as (
    select * from private.kingdom_today(p_user, p_at)
  ),
  s as (
    select * from private.kingdom_settings()
  ),
  builds as (
    select count(*)::int as n, max(a.game_day) as last_day
    from public.kingdom_actions a, t
    where a.user_id = p_user and a.kind = 'build' and a.game_day >= t.today
  ),
  per_day as (
    select (private.economy_rules() -> 'construction' ->> 'buildsPerDay')::int as n
  )
  select jsonb_build_object(
    'gameDay', t.today,
    'buildings', (select jsonb_object_agg(p, private.building_level(p_user, p)) from s, unnest(s.plots) p),
    'buildsToday', builds.n,
    'buildsPerDay', per_day.n,
    'nextBuildAt', case when builds.n >= per_day.n
      then private.game_day_start(builds.last_day + 1, e.time_zone) end,
    'caps', private.treasury_caps(p_user),
    'garrison', (select coalesce(jsonb_object_agg(g.unit, g.count), '{}'::jsonb)
                 from public.player_garrison g where g.user_id = p_user),
    'recruits', (select jsonb_object_agg(u, private.recruit_pool(p_user, u, t.week)) from s, unnest(s.recruitable_units) u),
    'nextRecruitsAt', private.game_day_start(t.week + 7, e.time_zone))
  from e, t, builds, per_day
$$;

-- ---------------------------------------------------------------------------
-- Building
-- ---------------------------------------------------------------------------

-- Builds the next level of p_building for p_request_id at p_at. p_level, when
-- given, is the level the player tapped; any other next level fails with
-- already_built or not_next_level, so a tap on a stale screen can't build the
-- level after it. Returns {ok: true, building, level, cost, xp, rulerLevel,
-- levelUp} or {ok: false, reason, ...}: max_level, ruler_level, keep_level,
-- daily_limit, or not_enough. A repeated request id returns the first success
-- with duplicate: true; failures change nothing and aren't stored.
create function private.build(p_user uuid, p_building text, p_level int, p_request_id uuid, p_at timestamptz)
returns jsonb
language plpgsql
set search_path = ''
as $$
declare
  v_rules jsonb := private.economy_rules();
  v_def jsonb := v_rules -> 'buildings' -> p_building;
  v public.player_economy;
  v_prior jsonb;
  t record;
  v_current int;
  v_target int;
  v_lvl jsonb;
  v_cost jsonb;
  v_ruler int;
  v_need_ruler int;
  v_keep int;
  v_builds int;
  v_last_day date;
  v_missing jsonb;
  v_xp numeric;
  v_result jsonb;
begin
  if p_request_id is null then
    raise exception 'request id is required' using errcode = '22023';
  end if;
  if v_def is null or not p_building = any ((private.kingdom_settings()).plots) then
    raise exception 'unknown building %', p_building using errcode = '22023';
  end if;

  v := private.ensure_economy(p_user);
  select a.result into v_prior from public.kingdom_actions a where a.user_id = p_user and a.request_id = p_request_id;
  if found then
    return v_prior || jsonb_build_object('duplicate', true);
  end if;

  -- Pay missed Keep tax first, at the Keep level those days had.
  perform private.settle_keep_tax(p_user, p_at);
  select * into v from public.player_economy where user_id = p_user;

  v_current := private.building_level(p_user, p_building);
  v_target := v_current + 1;
  if p_level is not null and p_level <> v_target then
    return jsonb_build_object('ok', false,
      'reason', case when p_level <= v_current then 'already_built' else 'not_next_level' end,
      'building', p_building, 'level', v_current);
  end if;
  if v_target > (v_def ->> 'maxLevel')::int then
    return jsonb_build_object('ok', false, 'reason', 'max_level', 'building', p_building, 'level', v_current);
  end if;

  v_lvl := v_def -> 'levels' -> (v_target - 1);
  v_cost := v_lvl -> 'cost';
  v_ruler := private.ruler_level(v.ruler_xp);
  v_need_ruler := greatest((v_def ->> 'unlockRulerLevel')::int, (v_lvl ->> 'requiredRulerLevel')::int);
  if v_ruler < v_need_ruler then
    return jsonb_build_object('ok', false, 'reason', 'ruler_level', 'building', p_building, 'level', v_target,
      'required', v_need_ruler, 'current', v_ruler);
  end if;
  v_keep := private.keep_level(p_user);
  if v_lvl ->> 'requiredKeepLevel' is not null and v_keep < (v_lvl ->> 'requiredKeepLevel')::int then
    return jsonb_build_object('ok', false, 'reason', 'keep_level', 'building', p_building, 'level', v_target,
      'required', (v_lvl ->> 'requiredKeepLevel')::int, 'current', v_keep);
  end if;

  select * into t from private.kingdom_today(p_user, p_at);
  select count(*), max(a.game_day) into v_builds, v_last_day
  from public.kingdom_actions a
  where a.user_id = p_user and a.kind = 'build' and a.game_day >= t.today;
  if v_builds >= (v_rules -> 'construction' ->> 'buildsPerDay')::int then
    return jsonb_build_object('ok', false, 'reason', 'daily_limit', 'building', p_building, 'level', v_target,
      'nextBuildAt', private.game_day_start(v_last_day + 1, v.time_zone));
  end if;

  v_missing := private.missing(v, v_cost);
  if v_missing is not null then
    return jsonb_build_object('ok', false, 'reason', 'not_enough', 'building', p_building, 'level', v_target,
      'missing', v_missing);
  end if;

  v_xp := (v_lvl ->> 'constructionXp')::numeric;
  perform private.credit(p_user, 'build', p_request_id::text,
    -(v_cost ->> 'gold')::numeric, -(v_cost ->> 'wood')::numeric, -(v_cost ->> 'stone')::numeric,
    -(v_cost ->> 'crystal')::numeric, -(v_cost ->> 'gems')::numeric, v_xp,
    jsonb_build_object('building', p_building, 'level', v_target));

  insert into public.player_buildings as b (user_id, building, level, updated_at)
  values (p_user, p_building, v_target, p_at)
  on conflict (user_id, building) do update set level = excluded.level, updated_at = excluded.updated_at;

  v_result := jsonb_build_object('ok', true, 'duplicate', false, 'building', p_building, 'level', v_target,
    'cost', v_cost, 'xp', v_xp,
    'rulerLevel', private.ruler_level(v.ruler_xp + v_xp),
    'levelUp', private.ruler_level(v.ruler_xp + v_xp) > v_ruler);

  insert into public.kingdom_actions (user_id, request_id, kind, game_day, building, level, result, created_at)
  values (p_user, p_request_id, 'build', t.today, p_building, v_target, v_result, p_at);

  return v_result;
end;
$$;

comment on function private.build(uuid, text, int, uuid, timestamptz) is
  'Builds the next level of a building if the Ruler and Keep levels, the daily limit, and the balances allow. Once per request id.';

-- ---------------------------------------------------------------------------
-- Recruiting
-- ---------------------------------------------------------------------------

-- Recruits p_count units of p_unit into the garrison for p_request_id at p_at.
-- Takes last week's leftover recruits first, then this week's. Returns {ok:
-- true, unit, count, cost, garrison} or {ok: false, reason, ...}:
-- needs_building, not_enough_recruits (with available), or not_enough. A
-- repeated request id returns the first success with duplicate: true.
create function private.recruit(p_user uuid, p_unit text, p_count int, p_request_id uuid, p_at timestamptz)
returns jsonb
language plpgsql
set search_path = ''
as $$
declare
  v_rules jsonb := private.economy_rules();
  v_def jsonb := v_rules -> 'units' -> p_unit;
  v public.player_economy;
  v_prior jsonb;
  t record;
  v_pool jsonb;
  v_last int;
  v_from_last int;
  v_cost jsonb;
  v_missing jsonb;
  v_garrison int;
  v_result jsonb;
begin
  if p_request_id is null then
    raise exception 'request id is required' using errcode = '22023';
  end if;
  if v_def is null or not p_unit = any ((private.kingdom_settings()).recruitable_units) then
    raise exception 'unknown unit %', p_unit using errcode = '22023';
  end if;
  if p_count is null or p_count < 1 or p_count > (private.kingdom_settings()).max_recruit_per_request then
    raise exception 'count must be between 1 and %', (private.kingdom_settings()).max_recruit_per_request
      using errcode = '22023';
  end if;

  v := private.ensure_economy(p_user);
  select a.result into v_prior from public.kingdom_actions a where a.user_id = p_user and a.request_id = p_request_id;
  if found then
    return v_prior || jsonb_build_object('duplicate', true);
  end if;

  perform private.settle_keep_tax(p_user, p_at);
  select * into v from public.player_economy where user_id = p_user;

  if private.building_level(p_user, v_def ->> 'building') < (v_def ->> 'buildingLevel')::int then
    return jsonb_build_object('ok', false, 'reason', 'needs_building', 'unit', p_unit,
      'building', v_def ->> 'building', 'required', (v_def ->> 'buildingLevel')::int);
  end if;

  select * into t from private.kingdom_today(p_user, p_at);
  v_pool := private.recruit_pool(p_user, p_unit, t.week);
  if p_count > (v_pool ->> 'available')::int then
    return jsonb_build_object('ok', false, 'reason', 'not_enough_recruits', 'unit', p_unit,
      'available', (v_pool ->> 'available')::int);
  end if;

  select jsonb_object_agg(r.key, (v_def -> 'cost' ->> r.key)::numeric * p_count) into v_cost
  from jsonb_each(v_def -> 'cost') r;
  v_missing := private.missing(v, v_cost);
  if v_missing is not null then
    return jsonb_build_object('ok', false, 'reason', 'not_enough', 'unit', p_unit, 'count', p_count,
      'missing', v_missing);
  end if;

  perform private.credit(p_user, 'recruit', p_request_id::text,
    -(v_cost ->> 'gold')::numeric, -(v_cost ->> 'wood')::numeric, -(v_cost ->> 'stone')::numeric,
    -(v_cost ->> 'crystal')::numeric, -(v_cost ->> 'gems')::numeric, 0,
    jsonb_build_object('unit', p_unit, 'count', p_count));

  insert into public.player_garrison as g (user_id, unit, count, updated_at)
  values (p_user, p_unit, p_count, p_at)
  on conflict (user_id, unit) do update set count = g.count + excluded.count, updated_at = excluded.updated_at
  returning g.count into v_garrison;

  v_last := (v_pool ->> 'lastWeek')::int;
  v_from_last := least(p_count, v_last);
  v_result := jsonb_build_object('ok', true, 'duplicate', false, 'unit', p_unit, 'count', p_count,
    'cost', v_cost, 'garrison', v_garrison);

  insert into public.kingdom_actions (user_id, request_id, kind, game_day, unit, count, batches, result, created_at)
  values (p_user, p_request_id, 'recruit', t.today, p_unit, p_count,
    (select coalesce(jsonb_object_agg(k, n), '{}'::jsonb)
     from (values ((t.week - 7)::text, v_from_last), (t.week::text, p_count - v_from_last)) as b (k, n)
     where n > 0),
    v_result, p_at);

  return v_result;
end;
$$;

comment on function private.recruit(uuid, text, int, uuid, timestamptz) is
  'Recruits units into the garrison from this week''s and last week''s recruits, if the balances allow. Once per request id.';

-- ---------------------------------------------------------------------------
-- API
-- ---------------------------------------------------------------------------

-- Returns the caller's economy and kingdom, after storing their time zone
-- (when given) and paying any Keep tax due, like get_economy.
-- Errors: 42501 when not signed in.
create function public.get_kingdom(p_time_zone text default null)
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
    || jsonb_build_object('keepTaxPaid', v_tax, 'timeZoneAccepted', v_tz_ok,
      'kingdom', private.kingdom_json(v_user, now()));
end;
$$;

comment on function public.get_kingdom(text) is
  'get_economy plus the kingdom: building levels, the daily construction, Treasury caps, the garrison, and recruits.';

-- Builds the next level of p_building. p_level is the level the player tapped;
-- p_request_id is a UUID the app makes once per tap and reuses on retries.
-- Returns the result of private.build plus the caller's economy and kingdom.
-- Errors: 42501 when not signed in, 22023 for an unknown building or a missing
-- request id.
create function public.build_building(p_building text, p_level int, p_request_id uuid)
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
  v_result := private.build(v_user, p_building, p_level, p_request_id, now());
  return v_result || jsonb_build_object('economy', private.economy_json(v_user, now()),
    'kingdom', private.kingdom_json(v_user, now()));
end;
$$;

comment on function public.build_building(text, int, uuid) is
  'Builds the next level of a building, once per request id. Returns {ok, ...} with the economy and kingdom after it.';

-- Recruits p_count units of p_unit ('pikeman'). p_request_id is a UUID the app
-- makes once per tap and reuses on retries. Returns the result of
-- private.recruit plus the caller's economy and kingdom.
-- Errors: 42501 when not signed in, 22023 for an unknown unit, a count out of
-- range, or a missing request id.
create function public.recruit_units(p_unit text, p_count int, p_request_id uuid)
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
  v_result := private.recruit(v_user, p_unit, p_count, p_request_id, now());
  return v_result || jsonb_build_object('economy', private.economy_json(v_user, now()),
    'kingdom', private.kingdom_json(v_user, now()));
end;
$$;

comment on function public.recruit_units(text, int, uuid) is
  'Recruits units into the garrison, once per request id. Returns {ok, ...} with the economy and kingdom after it.';

-- Function privileges.
revoke all on all functions in schema private from public, anon, authenticated;
revoke all on function public.get_kingdom(text) from public, anon;
revoke all on function public.build_building(text, int, uuid) from public, anon;
revoke all on function public.recruit_units(text, int, uuid) from public, anon;
grant execute on function public.get_kingdom(text) to authenticated;
grant execute on function public.build_building(text, int, uuid) to authenticated;
grant execute on function public.recruit_units(text, int, uuid) to authenticated;
