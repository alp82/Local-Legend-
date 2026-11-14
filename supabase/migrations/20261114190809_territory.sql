-- Territory: walks are reported as GPS points and saved as claimed map cells.
--
-- Cell model: square Web Mercator tiles at zoom 21 (the same grid as XYZ map
-- tiles). A tile is 19.1 m on a side at the equator and 19.1 m * cos(latitude)
-- on the ground, for example 11.8 m at 52 degrees. A cell is claimed when its
-- center lies within 30 m of a valid walking segment, so a walk claims a
-- 60 m wide strip, rounded to the cell edges. Cell id = x * 2^21 + y.
--
-- The phone only reports points. All validation and claiming happens here, in
-- public.submit_location_batch. Clients can read their own rows but can't
-- write any table directly.

create extension if not exists postgis with schema extensions;

create schema if not exists private;
revoke all on schema private from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- Rules. Every threshold lives here.
-- ---------------------------------------------------------------------------

create function private.claim_rules(
  out max_batch_points int,      -- Larger batches are refused with 22023.
  out max_accuracy_m float8,     -- Fixes with worse horizontal accuracy are dropped.
  out max_clock_skew interval,   -- Fixes further in the future than this are dropped.
  out max_point_age interval,    -- Fixes older than this are dropped.
  out claim_radius_m float8,     -- On foot you claim this far on each side of your path.
  out max_foot_speed_mps float8, -- Faster segments are not claimed (vehicle or bad fix).
  out max_gap_s float8,          -- Longer time gaps are not bridged with a straight line.
  out max_gap_m float8,          -- Longer distance gaps are not bridged with a straight line.
  out cell_zoom int              -- Changing this invalidates every stored cell id.
)
language sql
immutable
parallel safe
set search_path = ''
as $$
  select 500, 35.0, interval '1 minute', interval '7 days', 30.0, 3.5, 120.0, 250.0, 21
$$;

comment on function private.claim_rules() is 'Territory thresholds, in one place.';

-- Segment classification between two consecutive accepted points.
create function private.segment_kind(dt_s float8, dist_m float8)
returns text
language sql
immutable
parallel safe
set search_path = ''
as $$
  select case
    when dt_s is null then null
    when dt_s > r.max_gap_s or dist_m > r.max_gap_m then 'gap'
    when dist_m / greatest(dt_s, 0.001) > r.max_foot_speed_mps then 'fast'
    else 'walk'
  end
  from private.claim_rules() r
$$;

comment on function private.segment_kind(float8, float8) is
  'walk: claim a strip. fast: claim nothing. gap: claim nothing between the points; an endpoint with gaps on both sides claims a disk.';

-- ---------------------------------------------------------------------------
-- Cell helpers. Geometry is EPSG:3857 (Web Mercator, meters at the equator).
-- ---------------------------------------------------------------------------

create function private.cell_size_3857()
returns float8
language sql
immutable
parallel safe
set search_path = ''
as $$
  select 2 * 20037508.342789244 / (2 ^ r.cell_zoom) from private.claim_rules() r
$$;

-- Envelope of a vertical run of cells in one column, from cell a down to cell b
-- (same x, y_a <= y_b). cell_envelope(c) is the run from c to c.
create function private.cell_run_envelope(a bigint, b bigint)
returns extensions.geometry
language sql
immutable
strict
parallel safe
set search_path = ''
as $$
  select extensions.st_makeenvelope(
    -20037508.342789244 + (a / n) * s,
    20037508.342789244 - ((b % n) + 1) * s,
    -20037508.342789244 + ((a / n) + 1) * s,
    20037508.342789244 - (a % n) * s,
    3857)
  from (
    select private.cell_size_3857() as s, (2 ^ r.cell_zoom)::bigint as n
    from private.claim_rules() r
  ) c
$$;

create function private.cell_envelope(cell bigint)
returns extensions.geometry
language sql
immutable
strict
parallel safe
set search_path = ''
as $$
  select private.cell_run_envelope(cell, cell)
$$;

-- Cells whose center lies within radius_m (ground meters) of g (EPSG:3857).
-- Assumes g is small (one segment or point), so the scale is taken at its centroid.
create function private.cells_near(g extensions.geometry, radius_m float8)
returns setof bigint
language sql
immutable
strict
parallel safe
set search_path = ''
as $$
  with k as (
    select
      private.cell_size_3857() as s,
      20037508.342789244 as h,
      (2 ^ r.cell_zoom)::bigint as n,
      radius_m * cosh(extensions.st_y(extensions.st_centroid(g)) / 6378137.0) as rr,
      extensions.st_xmin(g::extensions.box3d) as xmin,
      extensions.st_xmax(g::extensions.box3d) as xmax,
      extensions.st_ymin(g::extensions.box3d) as ymin,
      extensions.st_ymax(g::extensions.box3d) as ymax
    from private.claim_rules() r
  ),
  b as (
    select s, h, n, rr,
      greatest(floor((xmin - rr + h) / s), 0)::bigint as x0,
      least(floor((xmax + rr + h) / s), n - 1)::bigint as x1,
      greatest(floor((h - ymax - rr) / s), 0)::bigint as y0,
      least(floor((h - ymin + rr) / s), n - 1)::bigint as y1
    from k
  )
  select x * b.n + y
  from b,
    generate_series(b.x0, b.x1) as x,
    generate_series(b.y0, b.y1) as y
  where extensions.st_dwithin(
    extensions.st_point(-b.h + (x + 0.5) * b.s, b.h - (y + 0.5) * b.s, 3857),
    g,
    b.rr)
$$;

revoke all on all functions in schema private from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------

create table public.claimed_cells (
  user_id uuid not null references auth.users (id) on delete cascade,
  cell bigint not null,
  first_claimed_at timestamptz not null,
  primary key (user_id, cell)
);

comment on table public.claimed_cells is
  'Land a player owns: zoom 21 Web Mercator tiles, id = x * 2^21 + y. Written only by submit_location_batch.';
comment on column public.claimed_cells.first_claimed_at is
  'Walk time of the point that first claimed the cell, among the batches processed so far.';

create table public.walk_sessions (
  user_id uuid not null references auth.users (id) on delete cascade,
  session_id text not null check (char_length(session_id) between 1 and 64),
  batch_count int not null default 0,
  point_count int not null default 0,
  rejected_count int not null default 0,
  first_point_at timestamptz null,
  last_point_at timestamptz null,
  distance_on_foot_m float8 not null default 0,
  new_cells int not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (user_id, session_id)
);

comment on table public.walk_sessions is
  'Per tracking session stats. point_count = accepted points; distance_on_foot_m = sum of walk segments; new_cells = cells this session claimed first.';

create table public.location_batches (
  user_id uuid not null references auth.users (id) on delete cascade,
  batch_id text not null check (char_length(batch_id) between 1 and 64),
  session_id text not null,
  received_points int not null,
  accepted_points int not null default 0,
  rejected_points int not null default 0,
  new_cells int not null default 0,
  created_at timestamptz not null default now(),
  primary key (user_id, batch_id)
);

comment on table public.location_batches is
  'One row per processed upload. The primary key makes submit_location_batch idempotent per batch id.';

-- TEMPORARY, for the commute test phase only. This table stores raw GPS
-- tracks, which conflicts with the design rule "the app stores land, not GPS
-- tracks". It lets us diagnose tracking quality, and submit_location_batch
-- uses it to connect points across batches that arrive out of order.
-- private.purge_walk_points() deletes points older than 30 days.
-- Before launch: drop this table and keep only the last point per session.
create table public.walk_points (
  id bigint generated always as identity primary key,
  user_id uuid not null references auth.users (id) on delete cascade,
  session_id text not null,
  batch_id text not null,
  recorded_at timestamptz not null,
  geom extensions.geometry(point, 4326) not null,
  accuracy_m real not null,
  speed_mps real null,
  created_at timestamptz not null default now(),
  unique (user_id, session_id, recorded_at)
);

comment on table public.walk_points is
  'TEMPORARY (test phase): raw accepted GPS fixes, owner-readable. Conflicts with "store land, not GPS tracks". Purged after 30 days by private.purge_walk_points().';

create index walk_points_created_at_idx on public.walk_points (created_at);

-- Privileges: clients read their own rows and write nothing directly.
revoke all on table public.claimed_cells, public.walk_sessions, public.location_batches, public.walk_points
  from anon, authenticated;
grant select on table public.claimed_cells, public.walk_sessions, public.location_batches, public.walk_points
  to authenticated;

alter table public.claimed_cells enable row level security;
alter table public.walk_sessions enable row level security;
alter table public.location_batches enable row level security;
alter table public.walk_points enable row level security;

create policy "Players can read their own cells" on public.claimed_cells
for select to authenticated using ((select auth.uid()) = user_id);

create policy "Players can read their own sessions" on public.walk_sessions
for select to authenticated using ((select auth.uid()) = user_id);

create policy "Players can read their own batches" on public.location_batches
for select to authenticated using ((select auth.uid()) = user_id);

create policy "Players can read their own points" on public.walk_points
for select to authenticated using ((select auth.uid()) = user_id);

-- ---------------------------------------------------------------------------
-- Ingestion
-- ---------------------------------------------------------------------------

-- Validates one batch of GPS points and claims the cells around valid walking
-- segments. Idempotent per (caller, batch id): a repeated batch id returns
-- duplicate = true and changes nothing. Batches of one session are serialized
-- by a row lock on walk_sessions, so concurrent uploads connect correctly.
--
-- p_points is a JSON array of {t: epoch ms, lat, lng, acc: meters, spd}.
-- Errors: 42501 when not signed in; 22023 for a bad id, a non-array payload,
-- or more than max_batch_points points. Bad individual points are counted as
-- rejected, not raised.
create function public.submit_location_batch(p_batch_id text, p_session_id text, p_points jsonb)
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

    -- Neighborhood: this batch's points plus the nearest stored point on each side.
    select coalesce(max(recorded_at), v_tmin) into v_from
    from public.walk_points
    where user_id = v_user and session_id = p_session_id and recorded_at < v_tmin;
    select coalesce(min(recorded_at), v_tmax) into v_to
    from public.walk_points
    where user_id = v_user and session_id = p_session_id and recorded_at > v_tmax;

    with seq as (
      select recorded_at, geom, batch_id = p_batch_id as is_new,
        lag(geom) over w as prev_geom,
        lag(batch_id = p_batch_id) over w as prev_new,
        private.segment_kind(
          extract(epoch from recorded_at - lag(recorded_at) over w)::float8,
          extensions.st_distance(lag(geom) over w::extensions.geography, geom::extensions.geography, false)
        ) as in_kind
      from public.walk_points
      where user_id = v_user and session_id = p_session_id
        and recorded_at between v_from and v_to
      window w as (order by recorded_at)
    ),
    kinds as (
      select *, lead(in_kind) over (order by recorded_at) as out_kind
      from seq
    ),
    shapes as (
      -- Walking segments that touch a new point.
      select extensions.st_transform(extensions.st_makeline(prev_geom, geom), 3857) as g, recorded_at as t
      from kinds
      where in_kind = 'walk' and (is_new or prev_new)
      union all
      -- New points with no neighbor in reach: claim a disk around the point.
      select extensions.st_transform(geom, 3857), recorded_at
      from kinds
      where is_new and coalesce(in_kind, 'gap') = 'gap' and coalesce(out_kind, 'gap') = 'gap'
    ),
    cells as (
      select c.cell, min(s.t) as t
      from shapes s
      cross join lateral private.cells_near(s.g, r.claim_radius_m) as c (cell)
      group by c.cell
    )
    insert into public.claimed_cells (user_id, cell, first_claimed_at)
    select v_user, cell, t from cells
    on conflict (user_id, cell) do nothing;

    get diagnostics v_new_cells = row_count;
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

-- ---------------------------------------------------------------------------
-- Read
-- ---------------------------------------------------------------------------

-- The caller's land as a GeoJSON FeatureCollection of merged polygons in
-- WGS84, plus the cell count and ground area. A player with no land gets an
-- empty FeatureCollection and zeros.
create function public.get_territory()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_user uuid := auth.uid();
  v_cells int;
  v_area float8;
  v_features jsonb;
begin
  if v_user is null then
    raise exception 'Not signed in' using errcode = '42501';
  end if;

  -- Ground area of a cell: Mercator scale at latitude L is 1 / cos(L) = cosh(y / R).
  -- Computed inline because helper calls with set search_path can't be inlined.
  select count(*),
    coalesce(sum((k.s / cosh((20037508.342789244 - ((c.cell % k.n) + 0.5) * k.s) / 6378137.0)) ^ 2), 0)
  into v_cells, v_area
  from public.claimed_cells c,
    (select private.cell_size_3857() as s, (2 ^ r.cell_zoom)::bigint as n from private.claim_rules() r) k
  where c.user_id = v_user;

  -- Cells are aligned squares in EPSG:3857, so the union is exact there.
  -- Merging each column's consecutive cells into one rectangle first makes the
  -- union several times faster. Simplifying with a tiny tolerance then drops
  -- the collinear vertices along straight edges.
  with ranked as (
    select cell, cell / k.n as x, cell - row_number() over (partition by cell / k.n order by cell) as run
    from public.claimed_cells,
      (select (2 ^ r.cell_zoom)::bigint as n from private.claim_rules() r) k
    where user_id = v_user
  ),
  merged as (
    select extensions.st_union(private.cell_run_envelope(a, b)) as g
    from (select min(cell) as a, max(cell) as b from ranked group by x, run) runs
  ),
  parts as (
    select (extensions.st_dump(g)).geom as g from merged
  )
  select coalesce(jsonb_agg(jsonb_build_object(
    'type', 'Feature',
    'properties', null,
    'geometry', extensions.st_asgeojson(
      extensions.st_transform(extensions.st_simplifypreservetopology(g, 0.05), 4326), 6
    )::jsonb
  )), '[]'::jsonb)
  into v_features
  from parts;

  return jsonb_build_object(
    'claimed', jsonb_build_object('type', 'FeatureCollection', 'features', v_features),
    'totalCells', v_cells,
    'areaM2', round(v_area::numeric, 1));
end;
$$;

comment on function public.get_territory() is
  'Returns the caller''s claimed land: {claimed: GeoJSON FeatureCollection of polygons, totalCells, areaM2}.';

-- ---------------------------------------------------------------------------
-- Retention for the temporary walk_points table. No schedule yet; run it by
-- hand or from pg_cron: select private.purge_walk_points();
-- ---------------------------------------------------------------------------

create function private.purge_walk_points(older_than interval default interval '30 days')
returns bigint
language sql
set search_path = ''
as $$
  with d as (
    delete from public.walk_points where created_at < now() - older_than returning 1
  )
  select count(*) from d
$$;

comment on function private.purge_walk_points(interval) is
  'Deletes walk_points rows older than the given age (default 30 days). Returns the number deleted.';

-- Function privileges: only signed-in players call the RPCs.
revoke all on all functions in schema private from public, anon, authenticated;
revoke all on function public.submit_location_batch(text, text, jsonb) from public, anon;
revoke all on function public.get_territory() from public, anon;
grant execute on function public.submit_location_batch(text, text, jsonb) to authenticated;
grant execute on function public.get_territory() to authenticated;
