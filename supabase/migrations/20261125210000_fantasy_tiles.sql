-- Fantasy map tiles: the painted map players see above the street map.
--
-- The tiles are painted outside the database by supabase/fantasy-renderer (a
-- headless browser running the fantasy map painter) and stored as WebP files in
-- the public bucket fantasy-tiles, at v<version>/<z>/<x>/<y>.webp. The app shows
-- them as a raster layer straight from Storage; where a tile isn't painted yet,
-- the street map shows through.
--
-- This migration adds the queue between the two:
--
--   - The app calls request_fantasy_tiles with the tiles around the player. It
--     queues the ones never painted and returns those still waiting, so the app
--     knows when to look again.
--   - The renderer leases queued tiles (lease_fantasy_tiles), paints and uploads
--     them, and reports each one (finish_fantasy_tile).
--
-- fantasy_config holds the switches, one row, changed with SQL:
--
--   update public.fantasy_config set enabled = false;    -- kill switch, no app update
--   update public.fantasy_config set version = version + 1;  -- repaint everything on demand
--   update public.fantasy_config set daily_tiles_per_player = 3000, webp_quality = 0.75;
--
-- A tile is painted once per version and kept: the renderer freezes the map data
-- it reads, so tiles painted weeks apart still meet at their edges. A new
-- version (new painter or art) starts empty and old versions stay in Storage
-- until deleted.

-- ---------------------------------------------------------------------------
-- Configuration
-- ---------------------------------------------------------------------------

create table public.fantasy_config (
  id boolean primary key default true check (id),
  enabled boolean not null default true,                    -- Off: the app shows the street map only.
  version int not null default 1 check (version > 0),       -- Tile set the app shows and the renderer paints.
  webp_quality real not null default 0.8 check (webp_quality > 0 and webp_quality <= 1),
  daily_tiles_per_player int not null default 1500 check (daily_tiles_per_player >= 0), -- New tiles one player may queue per UTC day.
  max_tiles_per_call int not null default 64 check (max_tiles_per_call > 0),
  lease interval not null default '2 minutes',              -- How long the renderer owns a tile it leased.
  max_attempts int not null default 3 check (max_attempts > 0),
  retry_after interval not null default '10 minutes'        -- Wait after a failed paint before the next attempt.
);

comment on table public.fantasy_config is
  'Fantasy map switches, one row: kill switch, tile version, WebP quality, per-player daily cap, queue timing.';

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
  priority smallint not null default 1,          -- 0: on screen, 1: around it.
  requested_at timestamptz not null default now(),
  requested_by uuid references auth.users (id) on delete set null,
  lease_until timestamptz,                       -- While painting: the lease. After a failure: the earliest retry.
  attempts int not null default 0,
  painted_at timestamptz,
  bytes int,
  paint_ms int,
  error text,
  primary key (version, z, x, y),
  check (x >= 0 and y >= 0 and x < (1 << z) and y < (1 << z))
);

comment on table public.fantasy_tiles is
  'One row per fantasy map tile and version: queued, painting, ready (in the fantasy-tiles bucket) or failed.';

create index fantasy_tiles_queue on public.fantasy_tiles (version, priority, requested_at desc)
  where status <> 'ready';

alter table public.fantasy_tiles enable row level security;
revoke all on public.fantasy_tiles from anon, authenticated;

create table public.fantasy_requests (
  player uuid not null references auth.users (id) on delete cascade,
  day date not null,
  tiles int not null default 0,
  primary key (player, day)
);

comment on table public.fantasy_requests is 'New fantasy tiles each player queued per UTC day, for the daily cap.';

alter table public.fantasy_requests enable row level security;
revoke all on public.fantasy_requests from anon, authenticated;

-- ---------------------------------------------------------------------------
-- Storage
-- ---------------------------------------------------------------------------

-- Public reads (through the CDN); only the service role writes.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('fantasy-tiles', 'fantasy-tiles', true, 4194304, array['image/webp'])
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

revoke all on function public.get_fantasy_config() from public;
grant execute on function public.get_fantasy_config() to anon, authenticated, service_role;

-- p_tiles: [[z, x, y], ...], the tiles on screen first (the first p_visible of
-- them), then the ones around. Returns
--   {"enabled", "version", "pending": [[z, x, y], ...], "queued": n, "capped": bool}
-- where pending lists the requested tiles still waiting to be painted (new ones
-- included) and capped says the daily cap kept some from being queued.
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
  v_used int;
  v_room int;
  v_new int;
  v_queued int;
  v_pending jsonb;
  v_req jsonb;
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
    return jsonb_build_object('enabled', false, 'version', c.version, 'pending', '[]'::jsonb, 'queued', 0, 'capped', false);
  end if;

  select coalesce((select r.tiles from public.fantasy_requests r where r.player = v_uid and r.day = v_day), 0) into v_used;
  v_room := greatest(0, c.daily_tiles_per_player - v_used);

  -- The request as rows: n is its first position (screen tiles first), repeats folded.
  select coalesce(jsonb_agg(jsonb_build_object('n', r.n, 'z', r.z, 'x', r.x, 'y', r.y)), '[]'::jsonb) into v_req
  from (
    select min(e.n)::int as n, (e.t ->> 0)::int as z, (e.t ->> 1)::int as x, (e.t ->> 2)::int as y
    from jsonb_array_elements(p_tiles) with ordinality e(t, n)
    group by 2, 3, 4
  ) r;

  select count(*) into v_new
  from jsonb_to_recordset(v_req) q(n int, z smallint, x int, y int)
  where not exists (
    select 1 from public.fantasy_tiles t
    where t.version = c.version and t.z = q.z and t.x = q.x and t.y = q.y
  );

  with fresh as (
    select q.* from jsonb_to_recordset(v_req) q(n int, z smallint, x int, y int)
    where not exists (
      select 1 from public.fantasy_tiles t
      where t.version = c.version and t.z = q.z and t.x = q.x and t.y = q.y
    )
    order by q.n
    limit v_room
  ), ins as (
    insert into public.fantasy_tiles (version, z, x, y, priority, requested_by)
    select c.version, f.z, f.x, f.y, case when f.n <= p_visible then 0 else 1 end, v_uid from fresh f
    on conflict do nothing
    returning 1
  )
  select count(*) into v_queued from ins;

  -- Tiles asked for again move to the front of their priority (the newest requests are painted first).
  update public.fantasy_tiles t
  set requested_at = now(), priority = least(t.priority, case when q.n <= p_visible then 0 else 1 end)
  from jsonb_to_recordset(v_req) q(n int, z smallint, x int, y int)
  where t.version = c.version and t.z = q.z and t.x = q.x and t.y = q.y
    and t.status in ('queued', 'failed');

  if v_queued > 0 then
    insert into public.fantasy_requests as r (player, day, tiles) values (v_uid, v_day, v_queued)
    on conflict (player, day) do update set tiles = r.tiles + excluded.tiles;
  end if;

  select coalesce(jsonb_agg(jsonb_build_array(t.z, t.x, t.y) order by q.n), '[]'::jsonb) into v_pending
  from jsonb_to_recordset(v_req) q(n int, z smallint, x int, y int)
  join public.fantasy_tiles t on t.version = c.version and t.z = q.z and t.x = q.x and t.y = q.y
  where t.status in ('queued', 'painting') or (t.status = 'failed' and t.attempts < c.max_attempts);

  return jsonb_build_object('enabled', true, 'version', c.version, 'pending', v_pending,
    'queued', v_queued, 'capped', v_queued < v_new);
end;
$$;

comment on function public.request_fantasy_tiles(jsonb, int) is
  'Queues the requested fantasy tiles never painted (within the daily cap) and returns {enabled, version, pending, queued, capped}.';

revoke all on function public.request_fantasy_tiles(jsonb, int) from public;
grant execute on function public.request_fantasy_tiles(jsonb, int) to authenticated;

-- ---------------------------------------------------------------------------
-- Renderer (service role only)
-- ---------------------------------------------------------------------------

-- Leases up to p_limit tiles of the current version: on-screen tiles first, the
-- newest requests first. Expired leases and failed tiles past their retry time
-- come back. Returns each tile with the WebP quality to paint it at.
create function public.lease_fantasy_tiles(p_limit int)
returns table (version int, z smallint, x int, y int, webp_quality real)
language sql
volatile
security definer
set search_path = ''
as $$
  with c as (select * from public.fantasy_config),
  picked as (
    select t.version, t.z, t.x, t.y
    from public.fantasy_tiles t, c
    where t.version = c.version
      and (t.status = 'queued'
        or (t.status = 'painting' and t.lease_until < now())
        or (t.status = 'failed' and t.attempts < c.max_attempts and t.lease_until < now()))
    order by t.priority, t.requested_at desc
    limit greatest(0, least(p_limit, 64))
    for update of t skip locked
  )
  update public.fantasy_tiles t
  set status = 'painting', lease_until = now() + c.lease, attempts = t.attempts + 1
  from picked p, c
  where t.version = p.version and t.z = p.z and t.x = p.x and t.y = p.y
  returning t.version, t.z, t.x, t.y, c.webp_quality
$$;

comment on function public.lease_fantasy_tiles(int) is
  'Service role only. Leases up to p_limit fantasy tiles to paint; returns version, z, x, y and the WebP quality.';

revoke all on function public.lease_fantasy_tiles(int) from public, anon, authenticated;
grant execute on function public.lease_fantasy_tiles(int) to service_role;

-- Records a paint. A tile the renderer painted without a request (the children
-- of a z15 tile) gets its row here.
create function public.finish_fantasy_tile(
  p_version int, p_z int, p_x int, p_y int, p_ok boolean,
  p_bytes int default null, p_paint_ms int default null, p_error text default null
)
returns void
language sql
volatile
security definer
set search_path = ''
as $$
  insert into public.fantasy_tiles as t (version, z, x, y, status, painted_at, bytes, paint_ms, error, lease_until, attempts)
  select p_version, p_z::smallint, p_x, p_y,
    case when p_ok then 'ready' else 'failed' end,
    case when p_ok then now() end, p_bytes, p_paint_ms, left(p_error, 2000),
    case when p_ok then null else now() + c.retry_after end, 1
  from public.fantasy_config c
  on conflict (version, z, x, y) do update set
    status = excluded.status,
    painted_at = excluded.painted_at,
    bytes = excluded.bytes,
    paint_ms = excluded.paint_ms,
    error = excluded.error,
    lease_until = excluded.lease_until
$$;

comment on function public.finish_fantasy_tile(int, int, int, int, boolean, int, int, text) is
  'Service role only. Marks a fantasy tile ready (uploaded) or failed (retried after retry_after, up to max_attempts).';

revoke all on function public.finish_fantasy_tile(int, int, int, int, boolean, int, int, text) from public, anon, authenticated;
grant execute on function public.finish_fantasy_tile(int, int, int, int, boolean, int, int, text) to service_role;
