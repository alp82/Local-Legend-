-- The fantasy tile renderer without the service key.
--
-- The renderer (supabase/fantasy-renderer) needs only: lease and finish tiles, queue
-- tiles for pre-painting, read the queue's status, and write to the fantasy-tiles bucket.
-- Instead of the service key, it signs in as one dedicated auth user whose app_metadata
-- has "fantasy_renderer": true. Only the service role can set app_metadata, so a player
-- can't grant it to themselves. The service role keeps every right (local testing, admin).
--
-- Set up the renderer user once (docs/fantasy-map-deploy.md):
--   1. Dashboard > Authentication > Users > Add user: an email and a long random
--      password, "Auto Confirm User" on.
--   2. SQL: update auth.users
--             set raw_app_meta_data = raw_app_meta_data || '{"fantasy_renderer": true}'
--           where email = '<that email>';
--
-- Also: queue_fantasy_tiles (pre-painting, priority 2, no daily cap), fantasy_status
-- (queue depth, throughput, storage, last error), and finished_at on each tile.

create function public.is_fantasy_renderer()
returns boolean
language sql
stable
set search_path = ''
as $$
  select coalesce((select auth.jwt()) ->> 'role' = 'service_role', false)
      or coalesce(((select auth.jwt()) -> 'app_metadata' ->> 'fantasy_renderer')::boolean, false)
$$;

comment on function public.is_fantasy_renderer() is
  'True for the service role and for the user whose app_metadata has fantasy_renderer: true.';

revoke all on function public.is_fantasy_renderer() from public, anon;
grant execute on function public.is_fantasy_renderer() to authenticated, service_role;

alter table public.fantasy_tiles add column finished_at timestamptz;
comment on column public.fantasy_tiles.priority is '0: on screen, 1: around it, 2: pre-painting.';

-- ---------------------------------------------------------------------------
-- Renderer functions: the renderer user or the service role
-- ---------------------------------------------------------------------------

drop function public.lease_fantasy_tiles(int);

create function public.lease_fantasy_tiles(p_limit int)
returns table (version int, z smallint, x int, y int, webp_quality real)
language plpgsql
volatile
security definer
set search_path = ''
as $$
begin
  if not public.is_fantasy_renderer() then
    raise exception 'only the fantasy renderer leases tiles' using errcode = '42501';
  end if;
  return query
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
  returning t.version, t.z, t.x, t.y, c.webp_quality;
end;
$$;

comment on function public.lease_fantasy_tiles(int) is
  'Renderer only. Leases up to p_limit fantasy tiles to paint (on screen, then around, then pre-painting; newest first).';

revoke all on function public.lease_fantasy_tiles(int) from public, anon;
grant execute on function public.lease_fantasy_tiles(int) to authenticated, service_role;

drop function public.finish_fantasy_tile(int, int, int, int, boolean, int, int, text);

create function public.finish_fantasy_tile(
  p_version int, p_z int, p_x int, p_y int, p_ok boolean,
  p_bytes int default null, p_paint_ms int default null, p_error text default null
)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
begin
  if not public.is_fantasy_renderer() then
    raise exception 'only the fantasy renderer finishes tiles' using errcode = '42501';
  end if;
  insert into public.fantasy_tiles as t (version, z, x, y, status, painted_at, finished_at, bytes, paint_ms, error, lease_until, attempts)
  select p_version, p_z::smallint, p_x, p_y,
    case when p_ok then 'ready' else 'failed' end,
    case when p_ok then now() end, now(), p_bytes, p_paint_ms, left(p_error, 2000),
    case when p_ok then null else now() + c.retry_after end, 1
  from public.fantasy_config c
  on conflict (version, z, x, y) do update set
    status = excluded.status,
    painted_at = excluded.painted_at,
    finished_at = excluded.finished_at,
    bytes = excluded.bytes,
    paint_ms = excluded.paint_ms,
    error = excluded.error,
    lease_until = excluded.lease_until;
end;
$$;

comment on function public.finish_fantasy_tile(int, int, int, int, boolean, int, int, text) is
  'Renderer only. Marks a fantasy tile ready (uploaded) or failed (retried after retry_after, up to max_attempts).';

revoke all on function public.finish_fantasy_tile(int, int, int, int, boolean, int, int, text) from public, anon;
grant execute on function public.finish_fantasy_tile(int, int, int, int, boolean, int, int, text) to authenticated, service_role;

-- Pre-painting: queues tiles of the current version that have no row yet, at the lowest
-- priority, outside any player's daily cap. p_tiles: [[z, x, y], ...], at most 5000.
-- Returns {"version", "queued", "existing"}; with p_dry_run only counts (queued = would be).
create function public.queue_fantasy_tiles(p_tiles jsonb, p_dry_run boolean default false)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_version int := (select c.version from public.fantasy_config c);
  v_n int;
  v_queued int;
begin
  if not public.is_fantasy_renderer() then
    raise exception 'only the fantasy renderer queues tiles' using errcode = '42501';
  end if;
  if p_tiles is null or jsonb_typeof(p_tiles) <> 'array' or jsonb_array_length(p_tiles) > 5000 then
    raise exception 'p_tiles must be an array of at most 5000 [z, x, y]' using errcode = '22023';
  end if;
  if exists (
    select 1 from jsonb_array_elements(p_tiles) e(t)
    where jsonb_typeof(e.t) <> 'array' or jsonb_array_length(e.t) <> 3
      or (e.t ->> 0) !~ '^\d+$' or (e.t ->> 1) !~ '^\d+$' or (e.t ->> 2) !~ '^\d+$'
      or (e.t ->> 0)::int not in (15, 16)
      or (e.t ->> 1)::bigint >= (1::bigint << (e.t ->> 0)::int)
      or (e.t ->> 2)::bigint >= (1::bigint << (e.t ->> 0)::int)
  ) then
    raise exception 'each tile must be [z, x, y] with z 15 or 16 and x, y on the grid' using errcode = '22023';
  end if;
  select count(distinct e.t) into v_n from jsonb_array_elements(p_tiles) e(t);
  if p_dry_run then
    select count(*) into v_queued from (
      select distinct (e.t ->> 0)::smallint z, (e.t ->> 1)::int x, (e.t ->> 2)::int y from jsonb_array_elements(p_tiles) e(t)
    ) q
    where not exists (select 1 from public.fantasy_tiles t where t.version = v_version and t.z = q.z and t.x = q.x and t.y = q.y);
    return jsonb_build_object('version', v_version, 'queued', v_queued, 'existing', v_n - v_queued, 'dry_run', true);
  end if;
  with ins as (
    insert into public.fantasy_tiles (version, z, x, y, priority)
    select distinct v_version, (e.t ->> 0)::smallint, (e.t ->> 1)::int, (e.t ->> 2)::int, 2::smallint
    from jsonb_array_elements(p_tiles) e(t)
    on conflict do nothing
    returning 1
  )
  select count(*) into v_queued from ins;
  return jsonb_build_object('version', v_version, 'queued', v_queued, 'existing', v_n - v_queued);
end;
$$;

comment on function public.queue_fantasy_tiles(jsonb, boolean) is
  'Renderer only. Queues fantasy tiles for pre-painting (priority 2, no daily cap); returns {version, queued, existing}.';

revoke all on function public.queue_fantasy_tiles(jsonb, boolean) from public, anon;
grant execute on function public.queue_fantasy_tiles(jsonb, boolean) to authenticated, service_role;

-- Health and progress, for the renderer's status script and for the SQL editor:
--   select jsonb_pretty(public.fantasy_status());
create function public.fantasy_status()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  c public.fantasy_config;
begin
  -- API requests always carry JWT claims; the SQL editor and psql sessions don't.
  if not (public.is_fantasy_renderer() or coalesce(current_setting('request.jwt.claims', true), '') = '') then
    raise exception 'only the fantasy renderer reads the status' using errcode = '42501';
  end if;
  select * into c from public.fantasy_config;
  return jsonb_build_object(
    'enabled', c.enabled,
    'version', c.version,
    'webp_quality', c.webp_quality,
    'daily_tiles_per_player', c.daily_tiles_per_player,
    'queue', (
      select jsonb_build_object(
        'queued', count(*) filter (where t.status = 'queued'),
        'queued_on_screen', count(*) filter (where t.status = 'queued' and t.priority = 0),
        'queued_prepaint', count(*) filter (where t.status = 'queued' and t.priority = 2),
        'painting', count(*) filter (where t.status = 'painting'),
        'failed_retrying', count(*) filter (where t.status = 'failed' and t.attempts < c.max_attempts),
        'failed_given_up', count(*) filter (where t.status = 'failed' and t.attempts >= c.max_attempts),
        'oldest_queued_s', round(extract(epoch from now() - min(t.requested_at) filter (where t.status = 'queued')))
      )
      from public.fantasy_tiles t where t.version = c.version
    ),
    'painted', (
      select jsonb_build_object(
        'last_hour', count(*) filter (where t.painted_at > now() - interval '1 hour'),
        'last_day', count(*) filter (where t.painted_at > now() - interval '1 day'),
        'total', count(*),
        'last_at', max(t.painted_at),
        'avg_ms_last_hour', round(avg(t.paint_ms) filter (where t.painted_at > now() - interval '1 hour')),
        'mb', round(coalesce(sum(t.bytes), 0) / 1048576.0, 1),
        'avg_kb_z16', round(avg(t.bytes) filter (where t.z = 16) / 1024.0),
        'avg_kb_z15', round(avg(t.bytes) filter (where t.z = 15) / 1024.0)
      )
      from public.fantasy_tiles t where t.version = c.version and t.status = 'ready'
    ),
    'last_error', (
      select jsonb_build_object('tile', format('%s/%s/%s', t.z, t.x, t.y), 'error', t.error, 'at', t.finished_at, 'attempts', t.attempts)
      from public.fantasy_tiles t
      where t.version = c.version and t.status = 'failed'
      order by t.finished_at desc nulls last
      limit 1
    ),
    'players_today', (
      select jsonb_build_object('players', count(*), 'tiles', coalesce(sum(r.tiles), 0), 'max_tiles', coalesce(max(r.tiles), 0))
      from public.fantasy_requests r where r.day = (now() at time zone 'utc')::date
    )
  );
end;
$$;

comment on function public.fantasy_status() is
  'Renderer and SQL editor. Queue depth, throughput, storage, the last error and today''s requests, as JSON.';

revoke all on function public.fantasy_status() from public, anon;
grant execute on function public.fantasy_status() to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Storage: the renderer writes the fantasy-tiles bucket (an upsert needs all three)
-- ---------------------------------------------------------------------------

create policy "fantasy renderer reads tiles" on storage.objects
  for select to authenticated
  using (bucket_id = 'fantasy-tiles' and public.is_fantasy_renderer());

create policy "fantasy renderer writes tiles" on storage.objects
  for insert to authenticated
  with check (bucket_id = 'fantasy-tiles' and public.is_fantasy_renderer());

create policy "fantasy renderer replaces tiles" on storage.objects
  for update to authenticated
  using (bucket_id = 'fantasy-tiles' and public.is_fantasy_renderer())
  with check (bucket_id = 'fantasy-tiles' and public.is_fantasy_renderer());
