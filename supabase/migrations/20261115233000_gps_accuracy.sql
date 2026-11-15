-- Territory: GPS accuracy in the walking-speed test. A short GPS jump on a
-- walk (a fix that lands a few meters off) looked faster than 3.5 m/s, counted
-- as a vehicle segment, and the 120 s vehicle buffer around it dropped up to
-- 4 minutes of walking: land, walking pay, route history, and detours. See
-- docs/detour-real-tracks.md.
--
-- Rule. A segment p -> q that isn't a gap is fast when
--   (span_m - credit) / span_s > max_foot_speed_mps
-- where:
--   - The span is the stretch the speed is measured over: from the latest
--     point at least speed_span_s (10 s) before q, without a gap in between,
--     to q. When p is that far back, the span is the segment itself. Without
--     an earlier point, it's the segment.
--   - credit = min(acc_start, C) + min(acc_end, C), with C =
--     max_accuracy_credit_m (10 m) and acc_* the reported accuracies of the
--     span's ends (missing counts as 0), shrunk in proportion when the span
--     is shorter than speed_span_s.
--
-- Why a span: GPS error is a distance that doesn't grow with time, so
-- subtracting it from a 1-second segment wipes out the segment. The app
-- records a fix every 10 m, so on iOS a car at 10 m/s sends a fix every
-- second: 10 m minus 2 x 5 m of accuracy would read as standing still. Over
-- 10 s the car moves 100 m, the GPS error stays the same. Together, the two
-- limits mean accuracy lowers a measured speed by at most 2 x C / speed_span_s
-- = 2 m/s: anything faster than 5.5 m/s is fast whatever accuracy the phone
-- reports.
--
-- Gaps (longer than 2 minutes or 250 m) are unchanged: they use the segment's
-- own time and length.
--
-- private.classified_points() is now the one place that classifies segments.
-- Claims, walking pay, route history, detour collection, the vehicle buffer,
-- and distance on foot all use it.

-- ---------------------------------------------------------------------------
-- Rules. Adding an OUT parameter needs drop and create; see
-- *_vehicle_buffer.sql.
-- ---------------------------------------------------------------------------

drop function private.claim_rules();

create function private.claim_rules(
  out max_batch_points int,          -- Larger batches are refused with 22023.
  out max_accuracy_m float8,         -- Fixes with worse horizontal accuracy are dropped.
  out max_clock_skew interval,       -- Fixes further in the future than this are dropped.
  out max_point_age interval,        -- Fixes older than this are dropped.
  out claim_radius_m float8,         -- On foot you claim this far on each side of your path.
  out max_foot_speed_mps float8,     -- Faster segments are not claimed (vehicle or bad fix).
  out max_gap_s float8,              -- Longer time gaps are not bridged with a straight line.
  out max_gap_m float8,              -- Longer distance gaps are not bridged with a straight line.
  out cell_zoom int,                 -- Changing this invalidates every stored cell id.
  out vehicle_buffer_s float8,       -- Nothing is claimed this close in time to a fast segment.
  out max_accuracy_credit_m float8,  -- Placeholder. The speed test subtracts at most this much of each end's accuracy.
  out speed_span_s float8            -- Placeholder. The speed test measures over at least this long, when the points allow.
)
language sql
immutable
parallel safe
set search_path = ''
as $$
  select 500, 35.0, interval '1 minute', interval '7 days', 30.0, 3.5, 120.0, 250.0, 21, 120.0, 10.0, 10.0
$$;

comment on function private.claim_rules() is 'Territory thresholds, in one place.';

-- ---------------------------------------------------------------------------
-- Classification
-- ---------------------------------------------------------------------------

-- The old two-argument rule had no accuracy. Every caller is replaced in this
-- migration, so it goes, and nothing can classify without accuracy again.
drop function private.segment_kind(float8, float8);

-- One segment. dt_s and dist_m are the segment's own time and length; span_s
-- and span_m the stretch its speed is measured over (see the top of this
-- file); acc0_m and acc1_m the reported accuracies at the span's ends.
create function private.segment_kind(
  dt_s float8, dist_m float8, span_s float8, span_m float8, acc0_m float8, acc1_m float8
)
returns text
language sql
immutable
parallel safe
set search_path = ''
as $$
  select case
    when dt_s is null then null
    when dt_s > r.max_gap_s or dist_m > r.max_gap_m then 'gap'
    when (span_m
          - (least(greatest(coalesce(acc0_m, 0), 0), r.max_accuracy_credit_m)
             + least(greatest(coalesce(acc1_m, 0), 0), r.max_accuracy_credit_m))
            * least(1.0, greatest(span_s, 0) / r.speed_span_s))
         / greatest(span_s, 0.001) > r.max_foot_speed_mps then 'fast'
    else 'walk'
  end
  from private.claim_rules() r
$$;

comment on function private.segment_kind(float8, float8, float8, float8, float8, float8) is
  'walk: claim a strip. fast: claim nothing, and nothing within vehicle_buffer_s. gap: claim nothing between the points; an endpoint with gaps on both sides claims a disk. The speed test subtracts the capped GPS accuracy of the span''s ends.';

-- Every stored point of a player (one session, or all when p_session is null)
-- recorded in [p_from, p_to], with the segment that ends there: the previous
-- point of the session, the segment's length, and its kind (null for a
-- session's first point). Points before p_from are read as needed, so each
-- point sees its true neighbors and span.
create function private.classified_points(p_user uuid, p_session text, p_from timestamptz, p_to timestamptz)
returns table (
  session_id text, recorded_at timestamptz, geom extensions.geometry,
  prev_t timestamptz, prev_geom extensions.geometry, dist_m float8, kind text
)
language plpgsql
stable
set search_path = ''
as $$
#variable_conflict use_column
declare
  r record;
  v_span interval;
  v_margin interval;
begin
  select * into r from private.claim_rules();
  v_span := make_interval(secs => r.speed_span_s);
  -- A span starts at most speed_span_s + max_gap_s before its end.
  v_margin := make_interval(secs => r.speed_span_s + r.max_gap_s);

  return query
  with pts as (
    select w.session_id, w.recorded_at, w.geom, w.accuracy_m::float8 as acc,
      lag(w.recorded_at) over s as prev_t,
      lag(w.geom) over s as prev_geom,
      lag(w.accuracy_m::float8) over s as prev_acc
    from public.walk_points w
    where w.user_id = p_user
      and (p_session is null or w.session_id = p_session)
      and w.recorded_at between p_from - v_margin and p_to
    window s as (partition by w.session_id order by w.recorded_at)
  ),
  segs as (
    select p.*,
      extract(epoch from p.recorded_at - p.prev_t)::float8 as dt_s,
      extensions.st_distance(p.prev_geom::extensions.geography, p.geom::extensions.geography, false) as d
    from pts p
  ),
  runs as (
    -- Stretches without a gap: a span never reaches across one.
    select g.*,
      count(*) filter (where g.dt_s > r.max_gap_s or g.d > r.max_gap_m)
        over (partition by g.session_id order by g.recorded_at) as run
    from segs g
  ),
  spans as (
    -- The latest point of the same stretch at least speed_span_s earlier.
    select u.*,
      last_value(u.recorded_at) over f as span_t,
      last_value(u.geom) over f as span_geom,
      last_value(u.acc) over f as span_acc
    from runs u
    window f as (partition by u.session_id, u.run order by u.recorded_at
                 range between unbounded preceding and v_span preceding)
  )
  select x.session_id, x.recorded_at, x.geom, x.prev_t, x.prev_geom, x.d,
    private.segment_kind(
      x.dt_s, x.d,
      extract(epoch from x.recorded_at - coalesce(x.span_t, x.prev_t))::float8,
      extensions.st_distance(coalesce(x.span_geom, x.prev_geom)::extensions.geography,
        x.geom::extensions.geography, false),
      case when x.span_t is null then x.prev_acc else x.span_acc end,
      x.acc)
  from spans x
  where x.recorded_at between p_from and p_to;
end;
$$;

comment on function private.classified_points(uuid, text, timestamptz, timestamptz) is
  'A player''s stored points in [p_from, p_to] (one session, or all), each with the segment ending there and its kind (walk, fast, gap, or null). The one place segments are classified.';

-- ---------------------------------------------------------------------------
-- Claiming and ingestion: the same as *_detours.sql, with segments classified
-- by private.classified_points().
-- ---------------------------------------------------------------------------


-- Claims the cells of every claimable walking segment of one session whose
-- end time lies in [p_from, p_to], and of every claimable isolated point in
-- that range, then pays for them: the new cells as new ground, and the
-- not-yet-paid claimable segments that run on the player's own land as usual
-- routes. It also records the walked route tiles, and collects every open
-- detour offer that a claimable shape passes within collect_radius_m of while
-- the offer is valid, paying its reward once. Re-evaluating a range is safe:
-- inserts skip owned cells and known route tiles, paid segments are skipped,
-- and a collected offer stays collected. The caller holds the walk_sessions
-- row lock.
create or replace function private.claim_settled(
  p_user uuid, p_session text, p_from timestamptz, p_to timestamptz, p_ref text,
  out new_cells int, out reward jsonb, out detours jsonb
)
language plpgsql
set search_path = ''
as $$
declare
  r record;
  dr record;
  v_w interval;
  v_gap interval;
  v_own interval := (select own_land_min_age from private.economy_limits());
  v_reset interval := make_interval(hours => (private.economy_rules() ->> 'dailyResetHour')::int);
  v_tz text;
  v_closed boolean;
  v_last timestamptz;
  v_new jsonb;
  v_usual jsonb;
  v_segments int;
  v_routes int;
  v_offer record;
begin
  new_cells := 0;
  reward := null;
  detours := null;
  select * into r from private.claim_rules();
  select * into dr from private.detour_rules();
  v_w := make_interval(secs => r.vehicle_buffer_s);
  v_gap := make_interval(secs => r.max_gap_s);
  v_tz := coalesce((select e.time_zone from public.player_economy e where e.user_id = p_user), 'UTC');

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
    -- Points around the range, so every candidate also sees its next
    -- neighbor: one further than max_gap_s away is a gap whether it's loaded
    -- or not.
    select c.recorded_at, c.geom, c.prev_t, c.prev_geom, c.dist_m, c.kind as in_kind
    from private.classified_points(p_user, p_session, p_from - v_gap, p_to + v_gap) c
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
    select c.prev_t as t0, c.recorded_at as t1
    from private.classified_points(p_user, null, p_from - v_w - 2 * v_gap, p_to + v_w + v_gap) c
    where c.kind = 'fast'
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
  ),
  routes as (
    -- Route history: the tiles of each claimable shape's ends and middle, on
    -- the game day of its end. Same day rule as private.game_day, inlined.
    insert into public.route_tiles (user_id, tile, game_day)
    select distinct p_user, private.tile_of(extensions.st_transform(p.pt, 3857), dr.route_zoom),
      ((s.t1 at time zone v_tz) - v_reset)::date
    from claimable s
    cross join lateral (
      select (extensions.st_dumppoints(s.g)).geom as pt
      union all
      select extensions.st_lineinterpolatepoint(s.g, 0.5) where s.is_segment
    ) p
    on conflict do nothing
    returning 1
  ),
  hits as (
    -- Open offers a claimable shape passes within the collect radius of,
    -- while the offer is valid and after it was offered: the earliest pass.
    select o.id, min(s.t1) as t
    from public.detour_offers o
    join claimable s
      on extensions.st_dwithin(o.geom::extensions.geography, s.g::extensions.geography, dr.collect_radius_m)
    where o.user_id = p_user and o.collected_at is null
      and o.valid_until > p_from - v_gap
      and s.t1 >= greatest(o.valid_from, o.created_at) and s.t1 < o.valid_until
    group by o.id
  ),
  collected as (
    update public.detour_offers o
    set collected_at = h.t, collected_ref = p_ref
    from hits h
    where o.id = h.id and o.collected_at is null
    returning o.id, o.game_day, o.name, o.reward_kind, o.reward, o.xp, o.collected_at
  )
  select
    (select count(*) from inserted),
    (select coalesce(jsonb_agg(jsonb_build_object('cell', cell, 't', first_claimed_at)), '[]'::jsonb) from inserted),
    (select coalesce(jsonb_agg(jsonb_build_object('cell', mid, 't1', t1, 'm', dist_m)), '[]'::jsonb) from usual),
    (select count(*) from marked),
    (select count(*) from routes),
    (select jsonb_agg(jsonb_build_object('id', c.id, 'gameDay', c.game_day, 'name', c.name,
       'rewardKind', c.reward_kind, 'reward', c.reward, 'xp', c.xp, 'collectedAt', c.collected_at)
       order by c.collected_at, c.id) from collected c)
  into new_cells, v_new, v_usual, v_segments, v_routes, detours;

  if jsonb_array_length(v_new) > 0 or jsonb_array_length(v_usual) > 0 then
    reward := private.pay_walk(p_user, p_ref, v_new, v_usual);
  end if;

  -- Detour rewards, one ledger row per offer. The unique index on
  -- (user_id, ref) for reason detour makes a second payment fail loudly.
  for v_offer in
    select * from jsonb_to_recordset(coalesce(detours, '[]'::jsonb))
      as x (id bigint, "gameDay" date, "rewardKind" text, reward jsonb, xp numeric)
    order by id
  loop
    perform private.ensure_economy(p_user);
    perform private.credit(p_user, 'detour', v_offer.id::text,
      coalesce((v_offer.reward ->> 'gold')::numeric, 0), coalesce((v_offer.reward ->> 'wood')::numeric, 0),
      coalesce((v_offer.reward ->> 'stone')::numeric, 0), coalesce((v_offer.reward ->> 'crystal')::numeric, 0),
      coalesce((v_offer.reward ->> 'gems')::numeric, 0), v_offer.xp,
      jsonb_build_object('rewardKind', v_offer."rewardKind", 'gameDay', v_offer."gameDay", 'batch', p_ref));
  end loop;
end;
$$;

comment on function private.claim_settled(uuid, text, timestamptz, timestamptz, text) is
  'Claims the cells of settled, vehicle-free walking segments (and isolated points) of a session ending in [p_from, p_to], pays for them, records route tiles, and collects detour offers passed within reach. Returns the new cells, the walk reward (null when nothing paid), and the collected detours (null when none).';

-- Same contract as *_economy.sql, plus detours in the result: the offers this
-- batch collected (null when none).
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
  v_detours jsonb;
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
      'totalCells', v_total, 'duplicate', true, 'reward', null, 'detours', null);
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

    select c.new_cells, c.reward, c.detours into v_new_cells, v_reward, v_detours
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
    select count(*)::int as n, min(c.recorded_at) as t0, max(c.recorded_at) as t1,
      coalesce(sum(c.dist_m) filter (where c.kind = 'walk'), 0) as dist
    from private.classified_points(v_user, p_session_id, '-infinity', 'infinity') c
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
    'reward', v_reward,
    'detours', v_detours);
end;
$$;

comment on function public.submit_location_batch(text, text, jsonb) is
  'Reports one batch of GPS points from a tracking session, pays for the walking it settles, and collects detour offers. Idempotent per batch id. Returns {acceptedPoints, rejectedPoints, newCells, totalCells, duplicate, reward, detours}.';


-- Function privileges: only signed-in players call the RPCs.
revoke all on all functions in schema private from public, anon, authenticated;
