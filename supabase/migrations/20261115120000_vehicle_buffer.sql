-- Territory: vehicle buffer. Cars in slow traffic or at a red light move at
-- walking speed, so a speed limit per segment alone lets them claim land.
--
-- Rule (W = claim_rules().vehicle_buffer_s, 120 s). A walking segment p -> q,
-- or the disk around an isolated point at time t (t_p = t_q = t), is claimed
-- only when both hold:
--   1. No vehicle nearby in time: no 'fast' segment of the same player, in any
--      of their sessions, overlaps [t_p - W, t_q + W]. Checking every session
--      means stopping and restarting tracking at a red light doesn't help.
--   2. Settled: the session has a stored point at or after t_q + W, or the
--      session is closed (public.close_walk_session), so a car that starts
--      moving again can't be missed.
-- Unsettled segments are claimed later, by the batch that settles them or by
-- close_walk_session. Claims are never taken back: a fast segment that
-- arrives after a claim (out of order, or from another session) doesn't undo it.

-- ---------------------------------------------------------------------------
-- Rules. Adding an OUT parameter needs drop and create. The functions that
-- call claim_rules() are sql or plpgsql with string bodies, so nothing depends
-- on it in pg_depend; they resolve it again at their next call.
-- ---------------------------------------------------------------------------

drop function private.claim_rules();

create function private.claim_rules(
  out max_batch_points int,      -- Larger batches are refused with 22023.
  out max_accuracy_m float8,     -- Fixes with worse horizontal accuracy are dropped.
  out max_clock_skew interval,   -- Fixes further in the future than this are dropped.
  out max_point_age interval,    -- Fixes older than this are dropped.
  out claim_radius_m float8,     -- On foot you claim this far on each side of your path.
  out max_foot_speed_mps float8, -- Faster segments are not claimed (vehicle or bad fix).
  out max_gap_s float8,          -- Longer time gaps are not bridged with a straight line.
  out max_gap_m float8,          -- Longer distance gaps are not bridged with a straight line.
  out cell_zoom int,             -- Changing this invalidates every stored cell id.
  out vehicle_buffer_s float8    -- Nothing is claimed this close in time to a fast segment.
)
language sql
immutable
parallel safe
set search_path = ''
as $$
  select 500, 35.0, interval '1 minute', interval '7 days', 30.0, 3.5, 120.0, 250.0, 21, 120.0
$$;

comment on function private.claim_rules() is 'Territory thresholds, in one place.';

-- ---------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------

alter table public.walk_sessions add column closed_at timestamptz null;

comment on column public.walk_sessions.closed_at is
  'When the app reported the session finished (close_walk_session). A closed session counts as settled: its last segments can be claimed.';

-- The vehicle check reads a player's points across sessions by time.
create index walk_points_user_time_idx on public.walk_points (user_id, recorded_at);

-- ---------------------------------------------------------------------------
-- Claiming
-- ---------------------------------------------------------------------------

-- Claims the cells of every claimable walking segment of one session whose
-- end time lies in [p_from, p_to], and of every claimable isolated point in
-- that range. Re-evaluating a range is safe: inserts skip cells the player
-- already owns. Returns the number of cells newly claimed.
-- The caller holds the walk_sessions row lock.
create function private.claim_settled(p_user uuid, p_session text, p_from timestamptz, p_to timestamptz)
returns int
language plpgsql
set search_path = ''
as $$
declare
  r record;
  v_w interval;
  v_gap interval;
  v_closed boolean;
  v_last timestamptz;
  v_new int;
begin
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
    return 0;
  end if;

  with seq as (
    -- Points around the range, so every candidate sees its true neighbors: a
    -- neighbor further than max_gap_s away is a gap whether it's loaded or not.
    select recorded_at, geom,
      lag(recorded_at) over w as prev_t,
      lag(geom) over w as prev_geom,
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
    select extensions.st_makeline(prev_geom, geom) as g, prev_t as t0, recorded_at as t1
    from kinds
    where in_kind = 'walk' and recorded_at between p_from and p_to
    union all
    -- Points with no neighbor in reach: a disk around the point.
    select geom, recorded_at, recorded_at
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
    select s.g, s.t1
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
  )
  insert into public.claimed_cells (user_id, cell, first_claimed_at)
  select p_user, cell, t from cells
  on conflict (user_id, cell) do nothing;

  get diagnostics v_new = row_count;
  return v_new;
end;
$$;

comment on function private.claim_settled(uuid, text, timestamptz, timestamptz) is
  'Claims the cells of settled, vehicle-free walking segments (and isolated points) of a session ending in [p_from, p_to]. Returns the number of new cells.';

-- ---------------------------------------------------------------------------
-- Ingestion. Same contract as before; only the claiming step changed.
-- ---------------------------------------------------------------------------

-- Validates one batch of GPS points and claims the cells around valid walking
-- segments (see the rule at the top of this file). Idempotent per (caller,
-- batch id): a repeated batch id returns duplicate = true and changes nothing.
-- Batches of one session are serialized by a row lock on walk_sessions, so
-- concurrent uploads connect correctly. A closed session still accepts batches.
--
-- p_points is a JSON array of {t: epoch ms, lat, lng, acc: meters, spd}.
-- Errors: 42501 when not signed in; 22023 for a bad id, a non-array payload,
-- or more than max_batch_points points. Bad individual points are counted as
-- rejected, not raised.
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
  -- then sees the conflict.
  insert into public.location_batches (user_id, batch_id, session_id, received_points)
  values (v_user, p_batch_id, p_session_id, v_received)
  on conflict (user_id, batch_id) do nothing;

  if not found then
    select count(*) into v_total from public.claimed_cells where user_id = v_user;
    return jsonb_build_object(
      'acceptedPoints', 0, 'rejectedPoints', 0, 'newCells', 0,
      'totalCells', v_total, 'duplicate', true);
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

    v_new_cells := private.claim_settled(
      v_user, p_session_id, v_from - make_interval(secs => r.vehicle_buffer_s), v_to);
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
    'duplicate', false);
end;
$$;

comment on function public.submit_location_batch(text, text, jsonb) is
  'Reports one batch of GPS points from a tracking session. Idempotent per batch id. Returns {acceptedPoints, rejectedPoints, newCells, totalCells, duplicate}.';

-- Marks a session finished, so its last segments count as settled, and claims
-- them (the vehicle check still applies). Call it after every point of the
-- session is uploaded. Idempotent: closing again keeps the first closed_at and
-- claims nothing new. An unknown session returns closed = false and changes
-- nothing. Errors: 42501 when not signed in; 22023 for a bad id.
create function public.close_walk_session(p_session_id text)
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
      v_new_cells := private.claim_settled(
        v_user, p_session_id, v_last - make_interval(secs => r.vehicle_buffer_s), v_last);
      update public.walk_sessions
      set new_cells = new_cells + v_new_cells
      where user_id = v_user and session_id = p_session_id;
    end if;
  end if;

  select count(*) into v_total from public.claimed_cells where user_id = v_user;

  return jsonb_build_object('newCells', v_new_cells, 'totalCells', v_total, 'closed', v_closed);
end;
$$;

comment on function public.close_walk_session(text) is
  'Marks a tracking session finished and claims its last, now settled segments. Idempotent. Returns {newCells, totalCells, closed}.';

-- Function privileges: only signed-in players call the RPCs.
revoke all on all functions in schema private from public, anon, authenticated;
revoke all on function public.close_walk_session(text) from public, anon;
grant execute on function public.close_walk_session(text) to authenticated;
