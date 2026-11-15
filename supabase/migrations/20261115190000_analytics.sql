-- Analytics: one event table in our own Postgres, written only by the server,
-- and SQL that computes the beta targets from it. See docs/analytics.md.
--
-- Events:
--   app_open          public.record_app_open, called by the app on launch and
--                     on every return to the foreground. Deduplicated by the
--                     app's open id.
--   walk_batch        A location batch that stored at least one point
--                     (submit_location_batch). Deduplicated by the batch id.
--   detour_offered    A detour offer was made (generate_detour_offers).
--   detour_collected  A detour offer was collected (claim_settled).
--   building_built    A construction (build_building).
--   units_recruited   A recruitment (recruit_units).
--   surge_result      The weekly Mist surge's result for a player. Step 5
--                     calls private.record_surge_result.
--
-- Server-side events come from triggers on the rows the game functions write
-- (location_batches, detour_offers, kingdom_actions). A trigger runs inside
-- the transaction of the function that writes the row, so an event exists
-- exactly when the fact it records was committed: a rolled-back walk or build
-- leaves no event, and a retried request that writes no new row records none.
-- The unique key (user_id, event, dedup_key) backs that up.
--
-- Events never hold GPS points or positions: no coordinates, no spot names,
-- only counts, ids, and labels. A check constraint refuses the usual location
-- keys as a second line of defense.

-- ---------------------------------------------------------------------------
-- Settings
-- ---------------------------------------------------------------------------

create schema if not exists analytics;
revoke all on schema analytics from public, anon, authenticated;
grant usage on schema analytics to service_role;

comment on schema analytics is
  'Beta metrics over public.analytics_events. Not exposed through the API; readable by service_role and the database owner.';

-- Every analytics definition in one place. Targets come from the plan; the
-- rest are choices described in docs/analytics.md.
create function analytics.settings(
  out activity_events text[],
  out active_days_per_week int,
  out retention_from_week int,
  out detours_per_week int,
  out max_app_opens_per_day int
)
language sql
immutable
parallel safe
set search_path = ''
as $$
  select
    -- Events that make a game day an active day: things a player does with
    -- the app open. Walks and detour collections alone don't count, because
    -- background tracking keeps uploading for players who stopped opening
    -- the app.
    array['app_open', 'building_built', 'units_recruited'],
    4,   -- "4+ days a week" (the plan)
    3,   -- "after three weeks": from the player's third full week (the plan)
    1,   -- "at least one detour a week" (the plan)
    50   -- Placeholder: app opens recorded per player and game day, against spam.
$$;

comment on function analytics.settings() is
  'Analytics definitions: which events make an active day, the beta targets, and the app open cap.';

-- ---------------------------------------------------------------------------
-- The event table
-- ---------------------------------------------------------------------------

create table public.analytics_events (
  id bigint generated always as identity primary key,
  user_id uuid not null references auth.users (id) on delete cascade,
  event text not null check (event in (
    'app_open', 'walk_batch', 'detour_offered', 'detour_collected',
    'building_built', 'units_recruited', 'surge_result')),
  dedup_key text not null check (char_length(dedup_key) between 1 and 128),
  game_day date not null,
  occurred_at timestamptz not null,
  props jsonb not null default '{}'::jsonb check (
    jsonb_typeof(props) = 'object'
    and not props ?| array['lat', 'lng', 'lon', 'latitude', 'longitude', 'geom', 'geometry',
      'position', 'location', 'points', 'coordinates', 'name']),
  created_at timestamptz not null default now(),
  unique (user_id, event, dedup_key)
);

comment on table public.analytics_events is
  'Analytics events, one per fact. Written only by server functions and triggers; owner-readable. No GPS points or positions.';
comment on column public.analytics_events.dedup_key is
  'What makes the event unique per player and event: the open id, batch id, offer id, request id, or surge week.';
comment on column public.analytics_events.game_day is
  'The game day the event belongs to (4 a.m. local reset), in the player''s time zone when it was recorded.';
comment on column public.analytics_events.occurred_at is
  'When it happened: server time, or for walk_batch the GPS time of the batch''s last point.';

create index analytics_events_day_idx on public.analytics_events (event, game_day);
create index analytics_events_user_day_idx on public.analytics_events (user_id, game_day);

revoke all on table public.analytics_events from anon, authenticated;
grant select on table public.analytics_events to authenticated;
alter table public.analytics_events enable row level security;

create policy "Players can read their own analytics events" on public.analytics_events
for select to authenticated using ((select auth.uid()) = user_id);

-- ---------------------------------------------------------------------------
-- Recording
-- ---------------------------------------------------------------------------

-- The player's stored time zone, UTC before their economy row exists.
create function private.player_time_zone(p_user uuid)
returns text
language sql
stable
set search_path = ''
as $$
  select coalesce((select e.time_zone from public.player_economy e where e.user_id = p_user), 'UTC')
$$;

-- Records one event once. Returns false when it was recorded before.
create function private.record_event(
  p_user uuid, p_event text, p_key text, p_day date, p_at timestamptz, p_props jsonb default '{}'::jsonb
)
returns boolean
language plpgsql
set search_path = ''
as $$
begin
  insert into public.analytics_events (user_id, event, dedup_key, game_day, occurred_at, props)
  values (p_user, p_event, p_key, p_day, p_at, coalesce(p_props, '{}'::jsonb))
  on conflict (user_id, event, dedup_key) do nothing;
  return found;
end;
$$;

-- walk_batch: submit_location_batch sets a new batch's counts once, at its
-- end. A retried batch id returns before that, so it never gets here. The
-- event's day is the GPS time of the batch's last point, like walking pay.
create function private.analytics_walk_batch()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_at timestamptz;
begin
  select max(p.recorded_at) into v_at
  from public.walk_points p
  where p.user_id = new.user_id and p.session_id = new.session_id and p.batch_id = new.batch_id;
  v_at := least(coalesce(v_at, now()), now());

  perform private.record_event(new.user_id, 'walk_batch', new.batch_id,
    private.game_day(v_at, private.player_time_zone(new.user_id)), v_at,
    jsonb_build_object('sessionId', new.session_id, 'acceptedPoints', new.accepted_points,
      'rejectedPoints', new.rejected_points, 'newCells', new.new_cells));
  return null;
end;
$$;

create trigger analytics_walk_batch
after update of accepted_points on public.location_batches
for each row
when (new.accepted_points > 0 and old.accepted_points = 0)
execute function private.analytics_walk_batch();

-- detour_offered and detour_collected. An offer row is inserted once and
-- marked collected once (claim_settled updates only open offers).
create function private.analytics_detour()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'INSERT' then
    perform private.record_event(new.user_id, 'detour_offered', new.id::text, new.game_day, new.created_at,
      jsonb_build_object('offerId', new.id, 'slot', new.slot, 'band', new.band, 'addedMin', new.added_min,
        'spotKind', new.spot_kind, 'rewardKind', new.reward_kind));
  else
    perform private.record_event(new.user_id, 'detour_collected', new.id::text, new.game_day, new.collected_at,
      jsonb_build_object('offerId', new.id, 'slot', new.slot, 'band', new.band, 'addedMin', new.added_min,
        'rewardKind', new.reward_kind, 'reward', new.reward, 'xp', new.xp));
  end if;
  return null;
end;
$$;

create trigger analytics_detour_offered
after insert on public.detour_offers
for each row
execute function private.analytics_detour();

create trigger analytics_detour_collected
after update of collected_at on public.detour_offers
for each row
when (old.collected_at is null and new.collected_at is not null)
execute function private.analytics_detour();

-- building_built and units_recruited: build_building and recruit_units write
-- one kingdom_actions row per successful request id. A retry finds the row and
-- returns its result without writing; a refused request writes nothing.
create function private.analytics_kingdom_action()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.kind = 'build' then
    perform private.record_event(new.user_id, 'building_built', new.request_id::text, new.game_day, new.created_at,
      jsonb_build_object('building', new.building, 'level', new.level));
  else
    perform private.record_event(new.user_id, 'units_recruited', new.request_id::text, new.game_day, new.created_at,
      jsonb_build_object('unit', new.unit, 'count', new.count));
  end if;
  return null;
end;
$$;

create trigger analytics_kingdom_action
after insert on public.kingdom_actions
for each row
execute function private.analytics_kingdom_action();

-- surge_result: the weekly Mist surge (step 5) calls this for each player, in
-- the same transaction that applies the result. p_week is the Monday of the
-- game week the surge closes. Once per player and week; returns false for a
-- repeat. Lost land is a cell count, never which cells.
create function private.record_surge_result(
  p_user uuid,
  p_week date,
  p_held boolean,
  p_pressure numeric,
  p_defense numeric,
  p_cells_lost int default 0,
  p_units_lost int default 0,
  p_reward jsonb default null,
  p_gentle boolean default false,
  p_at timestamptz default now()
)
returns boolean
language plpgsql
set search_path = ''
as $$
begin
  if p_user is null or p_held is null or p_week is null then
    raise exception 'user, week, and held are required' using errcode = '22023';
  end if;
  if extract(isodow from p_week) <> 1 then
    raise exception 'surge week must be a Monday, got %', p_week using errcode = '22023';
  end if;
  if p_reward is not null and jsonb_typeof(p_reward) <> 'object' then
    raise exception 'surge reward must be a JSON object' using errcode = '22023';
  end if;

  return private.record_event(p_user, 'surge_result', p_week::text,
    private.game_day(p_at, private.player_time_zone(p_user)), p_at,
    jsonb_build_object('week', p_week, 'held', p_held, 'pressure', p_pressure, 'defense', p_defense,
      'cellsLost', coalesce(p_cells_lost, 0), 'unitsLost', coalesce(p_units_lost, 0),
      'reward', p_reward, 'gentle', coalesce(p_gentle, false)));
end;
$$;

comment on function private.record_surge_result(uuid, date, boolean, numeric, numeric, int, int, jsonb, boolean, timestamptz) is
  'Records a player''s Mist surge result for the week starting p_week (a Monday). Once per player and week. For step 5.';

-- ---------------------------------------------------------------------------
-- API
-- ---------------------------------------------------------------------------

-- Records that the caller opened the app (a launch or a return to the
-- foreground). p_open_id is made by the app once per open and reused on
-- retries, so a retry records nothing new. The time is the server's. Stores
-- p_time_zone like get_economy, so the first open of a new player already
-- counts in their local game day. At most max_app_opens_per_day opens a game
-- day are recorded. Returns {recorded, duplicate, capped, gameDay,
-- timeZoneAccepted}. Errors: 42501 when not signed in; 22023 without an id.
create function public.record_app_open(p_open_id uuid, p_time_zone text default null)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user uuid := auth.uid();
  v_tz_ok boolean;
  v_day date;
  v_count int;
  v_recorded boolean := false;
  v_duplicate boolean;
begin
  if v_user is null then
    raise exception 'Not signed in' using errcode = '42501';
  end if;
  if p_open_id is null then
    raise exception 'open id is required' using errcode = '22023';
  end if;

  v_tz_ok := private.set_time_zone(v_user, p_time_zone, now());
  v_day := private.game_day(now(), private.player_time_zone(v_user));

  v_duplicate := exists (
    select 1 from public.analytics_events
    where user_id = v_user and event = 'app_open' and dedup_key = p_open_id::text);

  if not v_duplicate then
    select count(*) into v_count
    from public.analytics_events
    where user_id = v_user and event = 'app_open' and game_day = v_day;
    if v_count < (select max_app_opens_per_day from analytics.settings()) then
      v_recorded := private.record_event(v_user, 'app_open', p_open_id::text, v_day, now());
      v_duplicate := not v_recorded;
    end if;
  end if;

  return jsonb_build_object('recorded', v_recorded, 'duplicate', v_duplicate,
    'capped', not v_recorded and not v_duplicate, 'gameDay', v_day, 'timeZoneAccepted', v_tz_ok);
end;
$$;

comment on function public.record_app_open(uuid, text) is
  'Records an app open once per open id, at server time, in the caller''s game day. Returns {recorded, duplicate, capped, gameDay, timeZoneAccepted}.';

-- ---------------------------------------------------------------------------
-- Metrics (docs/analytics.md)
-- ---------------------------------------------------------------------------

-- Every player: signup time, signup game day in their current time zone, and
-- the Monday of their first full game week (week 1).
create view analytics.players as
select u.id as user_id,
  u.created_at as signed_up_at,
  private.player_time_zone(u.id) as time_zone,
  private.game_day(u.created_at, private.player_time_zone(u.id)) as signup_day,
  private.game_week(private.game_day(u.created_at, private.player_time_zone(u.id)) + 6) as first_week
from auth.users u;

comment on view analytics.players is
  'Players with their signup game day and first_week, the Monday of their first full game week (week 1).';

-- Game days on which a player was active (analytics.settings().activity_events).
create view analytics.active_days as
select distinct e.user_id, e.game_day
from public.analytics_events e, analytics.settings() s
where e.event = any (s.activity_events);

comment on view analytics.active_days is
  'One row per player and active game day.';

-- Per player and game week (Monday start): active days and detours collected.
-- Only weeks with at least one event appear.
create view analytics.player_weeks as
select e.user_id,
  private.game_week(e.game_day) as week,
  (count(distinct e.game_day) filter (where e.event = any (s.activity_events)))::int as active_days,
  (count(*) filter (where e.event = 'detour_collected'))::int as detours_collected
from public.analytics_events e, analytics.settings() s
group by e.user_id, private.game_week(e.game_day);

comment on view analytics.player_weeks is
  'Active days and detours collected per player and game week (weeks start Monday at 4 a.m. local).';

-- Beta target 1, per game week from the week of p_from to the week of p_to:
-- of the players in their third full week or later (eligible), how many were
-- active on 4 or more game days (retained). retention is null for a week
-- without eligible players.
create function analytics.weekly_retention(p_from date, p_to date)
returns table (week date, eligible_players int, retained_players int, retention numeric)
language sql
stable
security definer
set search_path = ''
as $$
  with s as (select * from analytics.settings()),
  w as (
    select d::date as week
    from generate_series(private.game_week(p_from), private.game_week(p_to), interval '7 days') d
  ),
  e as (
    select w.week, p.user_id, coalesce(pw.active_days, 0) as active_days
    from w
    cross join s
    join analytics.players p on p.first_week + 7 * (s.retention_from_week - 1) <= w.week
    left join analytics.player_weeks pw on pw.user_id = p.user_id and pw.week = w.week
  )
  select w.week,
    count(e.user_id)::int,
    (count(e.user_id) filter (where e.active_days >= s.active_days_per_week))::int,
    (count(e.user_id) filter (where e.active_days >= s.active_days_per_week))::numeric
      / nullif(count(e.user_id), 0)
  from w
  cross join s
  left join e on e.week = w.week
  group by w.week, s.active_days_per_week
  order by w.week
$$;

comment on function analytics.weekly_retention(date, date) is
  'Per game week: players in week 3 or later since signup, those active 4+ game days, and the share.';

-- Beta target 2, per game week: of the players active at least one day that
-- week, how many collected at least one detour that week.
create function analytics.weekly_detour_share(p_from date, p_to date)
returns table (week date, active_players int, detour_players int, detour_share numeric)
language sql
stable
security definer
set search_path = ''
as $$
  with s as (select * from analytics.settings()),
  w as (
    select d::date as week
    from generate_series(private.game_week(p_from), private.game_week(p_to), interval '7 days') d
  )
  select w.week,
    count(pw.user_id)::int,
    (count(pw.user_id) filter (where pw.detours_collected >= s.detours_per_week))::int,
    (count(pw.user_id) filter (where pw.detours_collected >= s.detours_per_week))::numeric
      / nullif(count(pw.user_id), 0)
  from w
  cross join s
  left join analytics.player_weeks pw on pw.week = w.week and pw.active_days >= 1
  group by w.week, s.detours_per_week
  order by w.week
$$;

comment on function analytics.weekly_detour_share(date, date) is
  'Per game week: players active at least one day, those who collected a detour, and the share.';

-- Both targets over a range of weeks, pooled over player-weeks: every eligible
-- player in every week counts once.
create function analytics.beta_targets(p_from date, p_to date)
returns table (
  eligible_player_weeks int, retained_player_weeks int, retention numeric,
  active_player_weeks int, detour_player_weeks int, detour_share numeric
)
language sql
stable
security definer
set search_path = ''
as $$
  select r.eligible, r.retained, r.retained::numeric / nullif(r.eligible, 0),
    d.active, d.detour, d.detour::numeric / nullif(d.active, 0)
  from
    (select coalesce(sum(eligible_players), 0)::int as eligible, coalesce(sum(retained_players), 0)::int as retained
     from analytics.weekly_retention(p_from, p_to)) r,
    (select coalesce(sum(active_players), 0)::int as active, coalesce(sum(detour_players), 0)::int as detour
     from analytics.weekly_detour_share(p_from, p_to)) d
$$;

comment on function analytics.beta_targets(date, date) is
  'Both beta targets over the game weeks from p_from to p_to, pooled over player-weeks.';

-- ---------------------------------------------------------------------------
-- Privileges
-- ---------------------------------------------------------------------------

revoke all on all functions in schema private from public, anon, authenticated;
revoke all on all functions in schema analytics from public, anon, authenticated;
revoke all on all tables in schema analytics from public, anon, authenticated;
grant execute on all functions in schema analytics to service_role;
grant select on all tables in schema analytics to service_role;
revoke all on function public.record_app_open(uuid, text) from public, anon;
grant execute on function public.record_app_open(uuid, text) to authenticated;
