-- Fantasy map tiles: the painted map players see above the street map.
--
-- The tiles are painted outside the database by supabase/fantasy-renderer (a
-- headless browser running the fantasy map painter) and stored as WebP files in
-- the public bucket fantasy-tiles, at v<version>/<z>/<x>/<y>.webp. The app shows
-- them as a raster layer straight from Storage; where a tile isn't painted yet,
-- the street map shows through.
--
-- This migration adds the player side of the queue. The app calls
-- request_fantasy_tiles with the tiles around the player; it queues the ones never
-- painted and returns those still waiting and those ready. The renderer side
-- (leasing, finishing, pre-painting, status) is in *_fantasy_renderer_role.sql.
--
-- Painting costs the worker time, storage and requests to the free map tile
-- service, so every queued tile is bounded several ways (all in fantasy_config):
--
--   - Only tiles within near_player_m of the caller's own claimed land or of the
--     positions they submitted in the last recent_positions are accepted, so a
--     script can't order the world painted.
--   - A daily cap per player and a global daily limit, in tile units: a z16 tile
--     costs 1, a z15 tile 5 (its four z16 children and itself).
--   - A maximum queue depth, in the same units.
--   - At most max_visible_tiles count as on screen (priority 0), and a player's
--     calls closer together than min_request_interval queue nothing.
--
-- fantasy_config holds the switches, one row, changed with SQL. The map starts
-- switched off; the runbook (docs/fantasy-map-deploy.md) switches it on:
--
--   update public.fantasy_config set enabled = true;         -- or false: kill switch, no app update
--   update public.fantasy_config set version = version + 1;  -- repaint everything on demand
--
-- A tile is painted once per version and kept: the renderer freezes the map data
-- it reads, so tiles painted weeks apart still meet at their edges. A new
-- version (new painter or art) starts empty and old versions stay in Storage
-- until deleted.

set lock_timeout = '5s';

-- ---------------------------------------------------------------------------
-- Configuration
-- ---------------------------------------------------------------------------

create table public.fantasy_config (
  id boolean primary key default true check (id),
  enabled boolean not null default false,                   -- Off: the app shows the street map only.
  version int not null default 1 check (version > 0),       -- Tile set the app shows and the renderer paints.
  webp_quality real not null default 0.75 check (webp_quality > 0 and webp_quality <= 1),
  daily_tiles_per_player int not null default 300 check (daily_tiles_per_player >= 0), -- Tile units one player may queue per UTC day.
  global_daily_tiles int not null default 2000 check (global_daily_tiles >= 0),       -- Tile units all players together may queue per UTC day.
  max_queue_depth int not null default 500 check (max_queue_depth >= 0),               -- Tile units waiting or painting, at most.
  max_tiles_per_call int not null default 64 check (max_tiles_per_call > 0),
  max_visible_tiles int not null default 24 check (max_visible_tiles >= 0),            -- On-screen tiles per call, at most (priority 0).
  near_player_m int not null default 2000 check (near_player_m >= 0),                  -- How far from the caller's claimed land or recent positions a tile may be.
  recent_positions interval not null default '7 days',     -- Which submitted positions count as recent.
  min_request_interval interval not null default '1 second', -- A player's calls closer together queue nothing.
  lease interval not null default '2 minutes',              -- How long the renderer owns a tile it leased.
  max_attempts int not null default 3 check (max_attempts > 0),
  retry_after interval not null default '10 minutes',       -- Wait after a failed paint before the next attempt.
  failed_cooldown interval not null default '1 day'         -- A tile given up after max_attempts is tried again after this.
);

comment on table public.fantasy_config is
  'Fantasy map switches, one row: kill switch, tile version, WebP quality, limits on what is queued, queue timing.';

insert into public.fantasy_config default values;

alter table public.fantasy_config enable row level security;
revoke all on public.fantasy_config from anon, authenticated;

-- ---------------------------------------------------------------------------
-- Tiles and requests
-- ---------------------------------------------------------------------------

create table public.fantasy_tiles (
  version int not null,
  z smallint not null check (z in (15, 16)),
  x int not null,
  y int not null,
  status text not null default 'queued' check (status in ('queued', 'painting', 'ready', 'failed')),
  priority smallint not null default 1,          -- 0: on screen, 1: around it, 2: pre-painting.
  requested_at timestamptz not null default now(),
  requested_by uuid references auth.users (id) on delete set null,
  lease_until timestamptz,                       -- While painting: the lease. After a failure: the earliest retry.
  attempts int not null default 0,
  painted_at timestamptz,
  finished_at timestamptz,
  bytes int,
  paint_ms int,
  error text,
  primary key (version, z, x, y),
  check (x >= 0 and y >= 0 and x < (1 << z) and y < (1 << z))
);

comment on table public.fantasy_tiles is
  'One row per fantasy map tile and version: queued, painting, ready (in the fantasy-tiles bucket) or failed.';

create index fantasy_tiles_queue on public.fantasy_tiles (version, priority, requested_at)
  where status <> 'ready';
create index fantasy_tiles_requested_by on public.fantasy_tiles (requested_by);

alter table public.fantasy_tiles enable row level security;
revoke all on public.fantasy_tiles from anon, authenticated;

create table public.fantasy_requests (
  player uuid not null references auth.users (id) on delete cascade,
  day date not null,
  tiles int not null default 0,                  -- Tile units queued that day.
  last_request_at timestamptz,
  primary key (player, day)
);

comment on table public.fantasy_requests is 'Tile units each player queued per UTC day (daily cap) and their last call (rate limit).';

alter table public.fantasy_requests enable row level security;
revoke all on public.fantasy_requests from anon, authenticated;

create table public.fantasy_daily (
  day date primary key,
  tiles int not null default 0                   -- Tile units all players queued that day.
);

comment on table public.fantasy_daily is 'Tile units all players queued per UTC day, for the global daily limit.';

alter table public.fantasy_daily enable row level security;
revoke all on public.fantasy_daily from anon, authenticated;

-- ---------------------------------------------------------------------------
-- Storage
-- ---------------------------------------------------------------------------

-- Public reads (through the CDN); only the renderer writes (*_fantasy_renderer_role.sql).
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('fantasy-tiles', 'fantasy-tiles', true, 4194304, array['image/webp', 'application/json'])
on conflict (id) do nothing;

-- ---------------------------------------------------------------------------
-- App
-- ---------------------------------------------------------------------------

create function public.get_fantasy_config()
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object('enabled', c.enabled, 'version', c.version, 'bucket', 'fantasy-tiles')
  from public.fantasy_config c
$$;

comment on function public.get_fantasy_config() is
  'Whether the fantasy map is on, and which tile version and bucket the app shows.';

revoke all on function public.get_fantasy_config() from public, anon;
grant execute on function public.get_fantasy_config() to authenticated, service_role;

-- The z16 tile under a longitude/latitude.
create function private.fantasy_z16(lng float8, lat float8)
returns table (x int, y int)
language sql
immutable
parallel safe
set search_path = ''
as $$
  select floor((lng + 180) / 360 * 65536)::int,
    floor((1 - ln(tan(radians(lat)) + 1 / cos(radians(lat))) / pi()) / 2 * 65536)::int
$$;

revoke all on function private.fantasy_z16(float8, float8) from public, anon, authenticated;

-- p_tiles: [[z, x, y], ...], the tiles on screen first (the first p_visible of
-- them, at most max_visible_tiles), then the ones around. Returns
--   {"enabled", "version", "pending": [[z, x, y], ...], "ready": [[z, x, y], ...],
--    "queued": n, "capped": bool, "reason": null | "throttled" | "player" | "global" | "queue",
--    "far": n}
-- pending: requested tiles waiting to be painted; ready: requested tiles painted;
-- queued: tiles this call queued; capped/reason: a limit kept some from being
-- queued; far: tiles refused for being too far from the caller's own ground.
create function public.request_fantasy_tiles(p_tiles jsonb, p_visible int default 0)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_uid uuid := (select auth.uid());
  c public.fantasy_config;
  v_day date := (now() at time zone 'utc')::date;
  v_req jsonb;
  v_visible int;
  v_last timestamptz;
  v_used int;
  v_global int;
  v_depth int;
  v_room int;
  v_reason text;
  v_queued int := 0;
  v_cost int := 0;
  v_far int := 0;
  v_wanted int := 0;
  v_pending jsonb;
  v_ready jsonb;
  ts16 constant float8 := 40075016.686 / 65536;   -- a z16 tile's width at the equator, metres
begin
  if v_uid is null then
    raise exception 'not signed in' using errcode = '42501';
  end if;
  select * into c from public.fantasy_config;
  if p_tiles is null or jsonb_typeof(p_tiles) <> 'array' then
    raise exception 'p_tiles must be an array of [z, x, y]' using errcode = '22023';
  end if;
  if jsonb_array_length(p_tiles) > c.max_tiles_per_call then
    raise exception 'at most % tiles per call', c.max_tiles_per_call using errcode = '22023';
  end if;
  if exists (
    select 1 from jsonb_array_elements(p_tiles) e(t)
    where jsonb_typeof(e.t) <> 'array' or jsonb_array_length(e.t) <> 3
      or jsonb_typeof(e.t -> 0) <> 'number' or jsonb_typeof(e.t -> 1) <> 'number' or jsonb_typeof(e.t -> 2) <> 'number'
      or (e.t ->> 0) !~ '^\d+$' or (e.t ->> 1) !~ '^\d+$' or (e.t ->> 2) !~ '^\d+$'
      or (e.t ->> 0)::int not in (15, 16)
      or (e.t ->> 1)::bigint >= (1::bigint << (e.t ->> 0)::int)
      or (e.t ->> 2)::bigint >= (1::bigint << (e.t ->> 0)::int)
  ) then
    raise exception 'each tile must be [z, x, y] with z 15 or 16 and x, y on the grid' using errcode = '22023';
  end if;

  if not c.enabled then
    return jsonb_build_object('enabled', false, 'version', c.version, 'pending', '[]'::jsonb, 'ready', '[]'::jsonb,
      'queued', 0, 'capped', false, 'reason', null, 'far', 0);
  end if;

  v_visible := least(greatest(coalesce(p_visible, 0), 0), c.max_visible_tiles);

  -- The request as rows: n is its first position (screen tiles first), repeats folded.
  select coalesce(jsonb_agg(jsonb_build_object('n', r.n, 'z', r.z, 'x', r.x, 'y', r.y)), '[]'::jsonb) into v_req
  from (
    select min(e.n)::int as n, (e.t ->> 0)::int as z, (e.t ->> 1)::int as x, (e.t ->> 2)::int as y
    from jsonb_array_elements(p_tiles) with ordinality e(t, n)
    group by 2, 3, 4
  ) r;

  -- The player's row for today, locked: parallel calls of one player wait for each other,
  -- so the cap is checked against what the others queued.
  insert into public.fantasy_requests (player, day) values (v_uid, v_day) on conflict do nothing;
  select r.tiles, r.last_request_at into v_used, v_last
  from public.fantasy_requests r where r.player = v_uid and r.day = v_day for update;

  if v_last is not null and v_last > now() - c.min_request_interval then
    v_reason := 'throttled';
  else
    update public.fantasy_requests r set last_request_at = now() where r.player = v_uid and r.day = v_day;

    -- Today's global row, locked the same way (always after the player's row: no deadlock).
    insert into public.fantasy_daily (day) values (v_day) on conflict do nothing;
    select d.tiles into v_global from public.fantasy_daily d where d.day = v_day for update;

    select coalesce(sum(case when t.z = 15 then 5 else 1 end), 0)::int into v_depth
    from public.fantasy_tiles t
    where t.version = c.version
      and (t.status in ('queued', 'painting') or (t.status = 'failed' and t.attempts < c.max_attempts));

    -- The caller's own ground, as z16 tiles: claimed cells (a cell id is x * 2^21 + y at
    -- zoom 21) and the positions they submitted recently.
    with ground as (
      select distinct (cc.cell / 2097152)::int >> 5 as gx, (cc.cell % 2097152)::int >> 5 as gy
      from public.claimed_cells cc where cc.user_id = v_uid
      union
      select distinct p.x, p.y
      from public.walk_points w, private.fantasy_z16(extensions.st_x(w.geom), extensions.st_y(w.geom)) p
      where w.user_id = v_uid and w.recorded_at > now() - c.recent_positions
    ),
    req as (
      select q.n, q.z::smallint as z, q.x, q.y,
        case when q.z = 15 then 5 else 1 end as cost,
        -- the tile in z16 coordinates, and the reach in z16 tiles at its latitude
        case when q.z = 15 then q.x * 2 else q.x end as x16,
        case when q.z = 15 then q.y * 2 else q.y end as y16
      from jsonb_to_recordset(v_req) q(n int, z int, x int, y int)
    ),
    fresh as (
      select r.*,
        exists (
          select 1 from ground g
          where abs(g.gx - r.x16) <= reach.n + (r.z = 15)::int and abs(g.gy - r.y16) <= reach.n + (r.z = 15)::int
        ) as near
      from req r
      cross join lateral (
        select ceil(c.near_player_m / (ts16 * cos(atan(sinh(pi() * (1 - 2 * (r.y16 + 0.5) / 65536.0))))))::int as n
      ) reach
      where not exists (
        select 1 from public.fantasy_tiles t
        where t.version = c.version and t.z = r.z and t.x = r.x and t.y = r.y
      )
    ),
    near_fresh as (
      select f.*, sum(f.cost) over (order by f.n) as cum from fresh f where f.near
    ),
    limits as (
      select greatest(0, least(c.daily_tiles_per_player - v_used, c.global_daily_tiles - v_global, c.max_queue_depth - v_depth)) as room
    ),
    ins as (
      insert into public.fantasy_tiles (version, z, x, y, priority, requested_by)
      select c.version, nf.z, nf.x, nf.y, case when nf.n <= v_visible then 0 else 1 end, v_uid
      from near_fresh nf, limits l
      where nf.cum <= l.room
      on conflict do nothing
      returning case when z = 15 then 5 else 1 end as cost
    )
    select
      (select count(*) from ins)::int,
      coalesce((select sum(cost) from ins), 0)::int,
      (select count(*) from fresh where not near)::int,
      coalesce((select sum(cost) from fresh where near), 0)::int
    into v_queued, v_cost, v_far, v_wanted;

    if v_cost < v_wanted then
      v_room := least(c.daily_tiles_per_player - v_used, c.global_daily_tiles - v_global, c.max_queue_depth - v_depth);
      v_reason := case
        when c.daily_tiles_per_player - v_used = v_room then 'player'
        when c.global_daily_tiles - v_global = v_room then 'global'
        else 'queue' end;
    end if;

    if v_cost > 0 then
      update public.fantasy_requests r set tiles = r.tiles + v_cost where r.player = v_uid and r.day = v_day;
      update public.fantasy_daily d set tiles = d.tiles + v_cost where d.day = v_day;
    end if;
  end if;

  select
    coalesce(jsonb_agg(jsonb_build_array(t.z, t.x, t.y) order by q.n) filter (
      where t.status in ('queued', 'painting') or (t.status = 'failed' and t.attempts < c.max_attempts)), '[]'::jsonb),
    coalesce(jsonb_agg(jsonb_build_array(t.z, t.x, t.y) order by q.n) filter (where t.status = 'ready'), '[]'::jsonb)
  into v_pending, v_ready
  from jsonb_to_recordset(v_req) q(n int, z int, x int, y int)
  join public.fantasy_tiles t on t.version = c.version and t.z = q.z and t.x = q.x and t.y = q.y;

  return jsonb_build_object('enabled', true, 'version', c.version, 'pending', v_pending, 'ready', v_ready,
    'queued', v_queued, 'capped', v_reason is not null, 'reason', v_reason, 'far', v_far);
end;
$$;

comment on function public.request_fantasy_tiles(jsonb, int) is
  'Queues the requested fantasy tiles never painted that lie near the caller''s own ground, within the limits in fantasy_config; returns {enabled, version, pending, ready, queued, capped, reason, far}.';

revoke all on function public.request_fantasy_tiles(jsonb, int) from public, anon;
grant execute on function public.request_fantasy_tiles(jsonb, int) to authenticated;
