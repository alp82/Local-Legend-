-- The layer is now called the Legend map (Local Legend's own name for it). This renames every
-- database object of the fantasy map that came before it, in one transaction, and keeps what is
-- already out there working through the switch:
--
--   - Tables, their constraints and indexes, and every function: legend_map_* (data, grants,
--     row level security and dependants move along; function bodies are rewritten for the new
--     names, with no change in behavior).
--   - Storage: a new public bucket legend-map-tiles with the same strict renderer policies. New
--     tiles are painted there. The old bucket fantasy-tiles stays public and readable.
--   - The renderer user's flag: legend_map_renderer in app_metadata. The earlier flag
--     fantasy_renderer still counts until the compatibility section is removed.
--
-- Compatibility (the last section, "Compatibility until the rename is adopted"): app versions from
-- before the rename call get_fantasy_config and request_fantasy_tiles, and the worker image from
-- before the rename calls lease_fantasy_tiles, finish_fantasy_tile, queue_fantasy_tiles and
-- fantasy_status. Those names stay as thin wrappers around the new functions. get_fantasy_config
-- names the bucket those app versions read from (legend_map_config.old_app_bucket): fantasy-tiles
-- until the worker has copied every old file into legend-map-tiles and the database has checked
-- the copy (finish_legend_map_bucket_copy), then legend-map-tiles.
--
-- Remove the compatibility section once the app update with the new names is adopted
-- (docs/legend-map-deploy.md, "Rename cut-over", step 9): drop the wrappers, the old bucket's
-- policies, old_app_bucket and the copy functions, take fantasy_renderer out of
-- is_legend_map_renderer, then empty and delete the fantasy-tiles bucket.

-- ---------------------------------------------------------------------------
-- Tables, constraints, indexes
-- ---------------------------------------------------------------------------

alter table public.fantasy_config rename to legend_map_config;
alter table public.fantasy_tiles rename to legend_map_tiles;
alter table public.fantasy_requests rename to legend_map_requests;
alter table public.fantasy_daily rename to legend_map_daily;
alter table public.fantasy_versions rename to legend_map_versions;

alter table public.legend_map_config rename constraint fantasy_config_pkey to legend_map_config_pkey;
alter table public.legend_map_config rename constraint fantasy_config_id_check to legend_map_config_id_check;
alter table public.legend_map_config rename constraint fantasy_config_version_check to legend_map_config_version_check;
alter table public.legend_map_config rename constraint fantasy_config_webp_quality_check to legend_map_config_webp_quality_check;
alter table public.legend_map_config rename constraint fantasy_config_daily_tiles_per_player_check to legend_map_config_daily_tiles_per_player_check;
alter table public.legend_map_config rename constraint fantasy_config_global_daily_tiles_check to legend_map_config_global_daily_tiles_check;
alter table public.legend_map_config rename constraint fantasy_config_max_queue_depth_check to legend_map_config_max_queue_depth_check;
alter table public.legend_map_config rename constraint fantasy_config_max_tiles_per_call_check to legend_map_config_max_tiles_per_call_check;
alter table public.legend_map_config rename constraint fantasy_config_max_visible_tiles_check to legend_map_config_max_visible_tiles_check;
alter table public.legend_map_config rename constraint fantasy_config_near_player_m_check to legend_map_config_near_player_m_check;
alter table public.legend_map_config rename constraint fantasy_config_max_attempts_check to legend_map_config_max_attempts_check;
alter table public.legend_map_config rename constraint fantasy_config_release_buffer_m_check to legend_map_config_release_buffer_m_check;
alter table public.legend_map_config rename constraint fantasy_config_release_max_given_up_check to legend_map_config_release_max_given_up_check;
alter table public.legend_map_config rename constraint fantasy_config_release_max_given_up_share_check to legend_map_config_release_max_given_up_share_check;
alter table public.legend_map_config rename constraint fantasy_config_staging to legend_map_config_staging;
alter table public.legend_map_tiles rename constraint fantasy_tiles_pkey to legend_map_tiles_pkey;
alter table public.legend_map_tiles rename constraint fantasy_tiles_requested_by_fkey to legend_map_tiles_requested_by_fkey;
alter table public.legend_map_tiles rename constraint fantasy_tiles_z_check to legend_map_tiles_z_check;
alter table public.legend_map_tiles rename constraint fantasy_tiles_status_check to legend_map_tiles_status_check;
alter table public.legend_map_tiles rename constraint fantasy_tiles_check to legend_map_tiles_check;
alter table public.legend_map_requests rename constraint fantasy_requests_pkey to legend_map_requests_pkey;
alter table public.legend_map_requests rename constraint fantasy_requests_player_fkey to legend_map_requests_player_fkey;
alter table public.legend_map_daily rename constraint fantasy_daily_pkey to legend_map_daily_pkey;
alter table public.legend_map_versions rename constraint fantasy_versions_pkey to legend_map_versions_pkey;
alter table public.legend_map_versions rename constraint fantasy_versions_version_check to legend_map_versions_version_check;

alter index public.fantasy_tiles_queue rename to legend_map_tiles_queue;
alter index public.fantasy_tiles_requested_by rename to legend_map_tiles_requested_by;
alter index public.fantasy_versions_fingerprint rename to legend_map_versions_fingerprint;

comment on table public.legend_map_config is
  'Legend map switches, one row: kill switch, tile version, WebP quality, limits on what is queued, queue timing.';
comment on table public.legend_map_tiles is
  'One row per Legend map tile and version: queued, painting, ready (in the legend-map-tiles bucket) or failed.';
comment on table public.legend_map_versions is
  'Legend map tile versions and the painter fingerprint each was painted with: released, retired, deleted.';

-- ---------------------------------------------------------------------------
-- Functions: renamed (grants and the policies that use them move along), then their bodies
-- rewritten for the new names. Behavior is unchanged except for the bucket name and the flag.
-- ---------------------------------------------------------------------------

alter function private.fantasy_deletable_versions() rename to legend_map_deletable_versions;
alter function private.fantasy_queue_known(int, smallint, int) rename to legend_map_queue_known;
alter function private.fantasy_release_state() rename to legend_map_release_state;
alter function private.fantasy_z16(float8, float8) rename to legend_map_z16;
alter function public.advance_fantasy_release() rename to advance_legend_map_release;
alter function public.begin_fantasy_release(text) rename to begin_legend_map_release;
alter function public.fantasy_cleanup_candidates(int) rename to legend_map_cleanup_candidates;
alter function public.fantasy_forget_versions() rename to legend_map_forget_versions;
alter function public.fantasy_object_deletable(text) rename to legend_map_object_deletable;
alter function public.fantasy_status() rename to legend_map_status;
alter function public.finish_fantasy_tile(int, int, int, int, boolean, int, int, text) rename to finish_legend_map_tile;
alter function public.get_fantasy_config() rename to get_legend_map_config;
alter function public.is_fantasy_renderer() rename to is_legend_map_renderer;
alter function public.lease_fantasy_tiles(int, text) rename to lease_legend_map_tiles;
alter function public.queue_fantasy_tiles(jsonb, boolean) rename to queue_legend_map_tiles;
alter function public.request_fantasy_tiles(jsonb, int) rename to request_legend_map_tiles;

create or replace function private.legend_map_deletable_versions()
 RETURNS SETOF integer
 LANGUAGE sql
 STABLE
 SET search_path TO ''
AS $function$
  select v.version
  from public.legend_map_versions v, public.legend_map_config c
  where v.deleted_at is null
    and v.version <> c.version and v.version is distinct from c.staging_version
    and coalesce(v.retired_at, case when v.released_at is null then v.created_at end) < now() - c.version_grace
$function$;

create or replace function private.legend_map_queue_known(p_version integer, p_priority smallint, p_viewed integer)
 RETURNS integer
 LANGUAGE sql
 SET search_path TO ''
AS $function$
  with c as (select * from public.legend_map_config),
  cells as (
    select distinct (cell / 2097152)::int >> 5 as tx, (cell % 2097152)::int >> 5 as ty from public.claimed_cells
  ),
  radius as (
    select tx, ty, ceil(c.release_buffer_m / (40075016.686 / 65536 * cos(atan(sinh(pi() * (1 - 2 * (ty + 0.5) / 65536.0))))))::int as n
    from cells, c
  ),
  ground as (
    select distinct tx + dx as x, ty + dy as y
    from radius, generate_series(-n, n) dx, generate_series(-n, n) dy
    where dx * dx + dy * dy <= n * n
  ),
  known as (
    select 16::smallint as z, g.x, g.y from ground g
    union select 15::smallint, g.x >> 1, g.y >> 1 from ground g
    union
    select t.z, t.x, t.y from public.legend_map_tiles t, c
    where t.version = p_viewed and t.status = 'ready'
      and coalesce(t.last_requested_at, t.requested_at) > now() - c.release_recent
  ),
  ins as (
    insert into public.legend_map_tiles (version, z, x, y, priority)
    select p_version, k.z, k.x, k.y, p_priority from known k
    where k.x >= 0 and k.y >= 0 and k.x < (1 << k.z) and k.y < (1 << k.z)
    on conflict do nothing
    returning 1
  )
  select count(*)::int from ins
$function$;

create or replace function private.legend_map_release_state()
 RETURNS jsonb
 LANGUAGE sql
 STABLE
 SET search_path TO ''
AS $function$
  select case when c.staging_version is null then null else (
    select jsonb_build_object(
      'version', c.staging_version, 'remaining', s.remaining, 'ready', s.ready, 'given_up', s.given_up,
      'blocked', s.remaining = 0 and b.reason is not null, 'reason', case when s.remaining = 0 then b.reason end)
    from (
      select
        count(*) filter (where t.status in ('queued', 'painting') or (t.status = 'failed' and t.attempts < c.max_attempts)) as remaining,
        count(*) filter (where t.status = 'ready') as ready,
        count(*) filter (where t.status = 'failed' and t.attempts >= c.max_attempts) as given_up,
        count(*) as total
      from public.legend_map_tiles t where t.version = c.staging_version
    ) s
    cross join lateral (select case
      when s.total > 0 and s.ready = 0 then 'no staged tile was painted (' || s.given_up || ' given up)'
      when s.given_up > c.release_max_given_up then s.given_up || ' tiles given up, more than release_max_given_up (' || c.release_max_given_up || ')'
      when s.total > 0 and s.given_up > c.release_max_given_up_share * s.total then s.given_up || ' of ' || s.total || ' tiles given up, more than release_max_given_up_share (' || c.release_max_given_up_share || ')'
    end as reason) b
  ) end
  from public.legend_map_config c
$function$;

create or replace function private.legend_map_z16(lng double precision, lat double precision)
 RETURNS TABLE(x integer, y integer)
 LANGUAGE sql
 IMMUTABLE PARALLEL SAFE
 SET search_path TO ''
AS $function$
  select floor((lng + 180) / 360 * 65536)::int,
    floor((1 - ln(tan(radians(lat)) + 1 / cos(radians(lat))) / pi()) / 2 * 65536)::int
$function$;

create or replace function public.advance_legend_map_release()
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  c public.legend_map_config;
  v_state jsonb;
begin
  if not public.is_legend_map_renderer() then
    raise exception 'only the Legend map renderer advances releases' using errcode = '42501';
  end if;
  select * into c from public.legend_map_config for update;
  if c.staging_version is null then
    return jsonb_build_object('staging', false);
  end if;
  v_state := private.legend_map_release_state();
  if (v_state ->> 'remaining')::int > 0 or (v_state ->> 'blocked')::boolean then
    return jsonb_build_object('staging', true, 'version', c.staging_version, 'remaining', (v_state ->> 'remaining')::int,
      'blocked', (v_state ->> 'blocked')::boolean, 'reason', v_state ->> 'reason');
  end if;
  update public.legend_map_versions set retired_at = now() where version = c.version;
  update public.legend_map_versions set released_at = now(), retired_at = null where version = c.staging_version;
  update public.legend_map_config
    set version = c.staging_version, fingerprint = c.staging_fingerprint,
        staging_version = null, staging_fingerprint = null, staging_started_at = null
    where id;
  return jsonb_build_object('switched', true, 'from', c.version, 'to', c.staging_version);
end;
$function$;

create or replace function public.begin_legend_map_release(p_fingerprint text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  c public.legend_map_config;
  v public.legend_map_versions;
  v_queued int;
  v_abandoned int;
begin
  if not public.is_legend_map_renderer() then
    raise exception 'only the Legend map renderer starts releases' using errcode = '42501';
  end if;
  if p_fingerprint is null or p_fingerprint !~ '^[0-9a-f]{16}$' then
    raise exception 'p_fingerprint must be 16 hex digits' using errcode = '22023';
  end if;
  select * into c from public.legend_map_config for update;

  if c.fingerprint is null then
    update public.legend_map_config set fingerprint = p_fingerprint where id;
    insert into public.legend_map_versions (version, fingerprint, released_at, webp_quality) values (c.version, p_fingerprint, now(), c.webp_quality)
    on conflict (version) do update set fingerprint = excluded.fingerprint, released_at = coalesce(public.legend_map_versions.released_at, now());
    return jsonb_build_object('action', 'adopted', 'version', c.version);
  end if;

  if p_fingerprint = c.fingerprint then
    -- the live painter is back while another one was staging: that release is abandoned (its tiles are kept;
    -- deploying its image again resumes it)
    v_abandoned := c.staging_version;
    update public.legend_map_config set staging_version = null, staging_fingerprint = null, staging_started_at = null where id;
    return jsonb_build_object('action', 'current', 'version', c.version, 'abandoned', v_abandoned);
  end if;

  if p_fingerprint = c.staging_fingerprint then
    return jsonb_build_object('action', 'staging', 'version', c.staging_version, 'resumed', true);
  end if;

  -- (a version whose files are being deleted doesn't count: its painter gets a fresh version instead)
  select * into v from public.legend_map_versions where fingerprint = p_fingerprint and deleted_at is null and purge_started_at is null
  order by version desc limit 1;

  if v.version is not null and v.released_at is not null then
    -- a rollback: phones switch back now; what they viewed on the version being left, and the land, is queued
    -- (behind players' own requests, so a large backlog doesn't fill the queue for them)
    v_queued := private.legend_map_queue_known(v.version, 2::smallint, c.version);
    update public.legend_map_versions set retired_at = now() where version = c.version;
    update public.legend_map_versions set released_at = now(), retired_at = null where version = v.version;
    update public.legend_map_config
      set version = v.version, fingerprint = p_fingerprint, staging_version = null, staging_fingerprint = null, staging_started_at = null
    where id;
    return jsonb_build_object('action', 'rolled_back', 'version', v.version, 'from', c.version, 'queued', v_queued);
  end if;

  if v.version is null then
    insert into public.legend_map_versions (version, fingerprint, webp_quality)
    values (greatest(c.version, (select coalesce(max(version), 0) from public.legend_map_versions)) + 1, p_fingerprint, c.webp_quality)
    returning * into v;
  end if;
  update public.legend_map_config set staging_version = v.version, staging_fingerprint = p_fingerprint, staging_started_at = now() where id;
  v_queued := private.legend_map_queue_known(v.version, 2::smallint, c.version);
  return jsonb_build_object('action', 'staging', 'version', v.version, 'queued', v_queued, 'replaced', c.staging_version);
end;
$function$;

create or replace function public.legend_map_cleanup_candidates(p_limit integer DEFAULT 500)
 RETURNS SETOF text
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  if not public.is_legend_map_renderer() then
    raise exception 'only the Legend map renderer cleans up tiles' using errcode = '42501';
  end if;
  update public.legend_map_versions set purge_started_at = now()
  where purge_started_at is null and version in (select private.legend_map_deletable_versions());
  return query
  select o.name from storage.objects o
  where o.bucket_id = 'legend-map-tiles'
    and substring(o.name from '^v([0-9]{1,6})/')::int in (select private.legend_map_deletable_versions())
  order by o.name
  limit greatest(0, least(p_limit, 1000));
end;
$function$;

create or replace function public.legend_map_forget_versions()
 RETURNS integer[]
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_done int[];
begin
  if not public.is_legend_map_renderer() then
    raise exception 'only the Legend map renderer cleans up tiles' using errcode = '42501';
  end if;
  select coalesce(array_agg(d.v), '{}') into v_done
  from private.legend_map_deletable_versions() d(v)
  where not exists (select 1 from storage.objects o where o.bucket_id = 'legend-map-tiles' and o.name like 'v' || d.v || '/%');
  delete from public.legend_map_tiles where version = any (v_done);
  update public.legend_map_versions set deleted_at = now() where version = any (v_done);
  return v_done;
end;
$function$;

create or replace function public.legend_map_object_deletable(p_name text)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  select coalesce(
    p_name ~ '^v[0-9]{1,6}/1[56]/[0-9]{1,5}/[0-9]{1,5}\.(webp|json)$'
      and substring(p_name from '^v([0-9]{1,6})/')::int in (select private.legend_map_deletable_versions()),
    false)
$function$;

create or replace function public.legend_map_status()
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  c public.legend_map_config;
  v_day date := (now() at time zone 'utc')::date;
begin
  -- API requests always carry JWT claims; the SQL editor and psql sessions don't.
  if not (public.is_legend_map_renderer() or coalesce(current_setting('request.jwt.claims', true), '') = '') then
    raise exception 'only the Legend map renderer reads the status' using errcode = '42501';
  end if;
  select * into c from public.legend_map_config;
  return jsonb_build_object(
    'enabled', c.enabled,
    'version', c.version,
    'fingerprint', c.fingerprint,
    'staging', case when c.staging_version is null then null else private.legend_map_release_state()
      || jsonb_build_object('fingerprint', c.staging_fingerprint, 'started_at', c.staging_started_at) end,
    'versions', (select coalesce(jsonb_agg(jsonb_build_object('version', v.version, 'fingerprint', v.fingerprint,
        'webp_quality', v.webp_quality, 'released_at', v.released_at, 'retired_at', v.retired_at,
        'purge_started_at', v.purge_started_at, 'deleted_at', v.deleted_at) order by v.version), '[]'::jsonb)
      from public.legend_map_versions v),
    'webp_quality', c.webp_quality,
    'limits', jsonb_build_object(
      'daily_tiles_per_player', c.daily_tiles_per_player,
      'global_daily_tiles', c.global_daily_tiles,
      'global_today', coalesce((select d.tiles from public.legend_map_daily d where d.day = v_day), 0),
      'max_queue_depth', c.max_queue_depth,
      -- players' tiles waiting or painting, in units (what max_queue_depth limits)
      'queue_depth', (
        select coalesce(sum(t.cost), 0)
        from public.legend_map_tiles t
        where t.version = c.version and t.priority < 2
          and (t.status in ('queued', 'painting') or (t.status = 'failed' and t.attempts < c.max_attempts))
      ),
      'near_player_m', c.near_player_m
    ),
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
      from public.legend_map_tiles t where t.version = c.version
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
      from public.legend_map_tiles t where t.version = c.version and t.status = 'ready'
    ),
    'last_error', (
      select jsonb_build_object('tile', format('%s/%s/%s', t.z, t.x, t.y), 'error', t.error, 'at', t.finished_at, 'attempts', t.attempts)
      from public.legend_map_tiles t
      where t.version = c.version and t.status = 'failed'
      order by t.finished_at desc nulls last
      limit 1
    ),
    'players_today', (
      select jsonb_build_object('players', count(*), 'tiles', coalesce(sum(r.tiles), 0), 'max_tiles', coalesce(max(r.tiles), 0))
      from public.legend_map_requests r where r.day = v_day
    )
  );
end;
$function$;

create or replace function public.finish_legend_map_tile(p_version integer, p_z integer, p_x integer, p_y integer, p_ok boolean, p_bytes integer DEFAULT NULL::integer, p_paint_ms integer DEFAULT NULL::integer, p_error text DEFAULT NULL::text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  if not public.is_legend_map_renderer() then
    raise exception 'only the Legend map renderer finishes tiles' using errcode = '42501';
  end if;
  insert into public.legend_map_tiles as t (version, z, x, y, status, painted_at, finished_at, bytes, paint_ms, error, lease_until, attempts)
  select p_version, p_z::smallint, p_x, p_y,
    case when p_ok then 'ready' else 'failed' end,
    case when p_ok then now() end, now(), p_bytes, p_paint_ms, left(p_error, 2000),
    case when p_ok then null else now() + c.retry_after end, 1
  from public.legend_map_config c
  on conflict (version, z, x, y) do update set
    status = excluded.status,
    painted_at = excluded.painted_at,
    finished_at = excluded.finished_at,
    bytes = excluded.bytes,
    paint_ms = excluded.paint_ms,
    error = excluded.error,
    lease_until = excluded.lease_until;
end;
$function$;

create or replace function public.get_legend_map_config()
 RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  select jsonb_build_object('enabled', c.enabled, 'version', c.version, 'bucket', 'legend-map-tiles')
  from public.legend_map_config c
$function$;

create or replace function public.is_legend_map_renderer()
 RETURNS boolean
 LANGUAGE sql
 STABLE
 SET search_path TO ''
AS $function$
  select coalesce((select auth.jwt()) ->> 'role' = 'service_role', false)
      or coalesce(((select auth.jwt()) -> 'app_metadata' ->> 'legend_map_renderer')::boolean, false)
      -- the flag's earlier name, until the compatibility section at the end is removed
      or coalesce(((select auth.jwt()) -> 'app_metadata' ->> 'fantasy_renderer')::boolean, false)
$function$;

create or replace function public.lease_legend_map_tiles(p_limit integer, p_fingerprint text DEFAULT NULL::text)
 RETURNS TABLE(version integer, z smallint, x integer, y integer, webp_quality real)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  c public.legend_map_config;
  v_versions int[];
begin
  if not public.is_legend_map_renderer() then
    raise exception 'only the Legend map renderer leases tiles' using errcode = '42501';
  end if;
  select * into c from public.legend_map_config;
  if p_fingerprint is null and c.fingerprint is not null then
    raise exception 'this worker reports no painter fingerprint: it predates releases and may not paint version % (deploy a current image)', c.version
      using errcode = '42501';
  end if;
  v_versions := array_remove(array[
    case when c.fingerprint is null or c.fingerprint = p_fingerprint then c.version end,
    case when p_fingerprint is not null and c.staging_fingerprint = p_fingerprint then c.staging_version end
  ], null);

  -- Leases that expired max_attempts times: given up, like a tile that failed that often.
  update public.legend_map_tiles t
  set status = 'failed', finished_at = now(), error = 'lease expired ' || t.attempts || ' times (the worker stopped while painting it)'
  where t.version = any (v_versions) and t.status = 'painting' and t.lease_until < now() and t.attempts >= c.max_attempts;

  return query
  with waiting as (
    select t.version, t.z, t.x, t.y, t.priority, t.requested_at,
      row_number() over (
        partition by t.priority, coalesce(t.requested_by, '00000000-0000-0000-0000-000000000000'::uuid)
        order by t.requested_at, t.z desc, t.x, t.y
      ) as turn
    from public.legend_map_tiles t
    where t.version = any (v_versions)
      and (t.status = 'queued'
        or (t.status = 'painting' and t.lease_until < now())
        or (t.status = 'failed' and t.lease_until < now()
          and (t.attempts < c.max_attempts or t.finished_at < now() - c.failed_cooldown)))
  ),
  picked as (
    select t.version, t.z, t.x, t.y
    from public.legend_map_tiles t
    join waiting w on w.version = t.version and w.z = t.z and w.x = t.x and w.y = t.y
    order by w.priority, w.turn, w.requested_at, w.z desc, w.x, w.y
    limit greatest(0, least(p_limit, 64))
    for update of t skip locked
  ),
  leased as (
    update public.legend_map_tiles t
    set status = 'painting', lease_until = now() + c.lease, attempts = t.attempts + 1
    from picked p
    where t.version = p.version and t.z = p.z and t.x = p.x and t.y = p.y
    returning t.version, t.z, t.x, t.y
  )
  select l.version, l.z, l.x, l.y, coalesce(fv.webp_quality, c.webp_quality)
  from leased l
  join waiting w on w.version = l.version and w.z = l.z and w.x = l.x and w.y = l.y
  left join public.legend_map_versions fv on fv.version = l.version
  order by w.priority, w.turn, w.requested_at, w.z desc, w.x, w.y;
end;
$function$;

create or replace function public.queue_legend_map_tiles(p_tiles jsonb, p_dry_run boolean DEFAULT false)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_version int := (select coalesce(c.staging_version, c.version) from public.legend_map_config c); -- the staged version during a release
  v_n int;
  v_queued int;
begin
  if not public.is_legend_map_renderer() then
    raise exception 'only the Legend map renderer queues tiles' using errcode = '42501';
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
    where not exists (select 1 from public.legend_map_tiles t where t.version = v_version and t.z = q.z and t.x = q.x and t.y = q.y);
    return jsonb_build_object('version', v_version, 'queued', v_queued, 'existing', v_n - v_queued, 'dry_run', true);
  end if;
  with ins as (
    insert into public.legend_map_tiles (version, z, x, y, priority)
    select distinct v_version, (e.t ->> 0)::smallint, (e.t ->> 1)::int, (e.t ->> 2)::int, 2::smallint
    from jsonb_array_elements(p_tiles) e(t)
    on conflict do nothing
    returning 1
  )
  select count(*) into v_queued from ins;
  return jsonb_build_object('version', v_version, 'queued', v_queued, 'existing', v_n - v_queued);
end;
$function$;

create or replace function public.request_legend_map_tiles(p_tiles jsonb, p_visible integer DEFAULT 0)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_uid uuid := (select auth.uid());
  c public.legend_map_config;
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
  v_target int;                                  -- the version being painted: the staged one during a release
  v_ready jsonb;
  ts16 constant float8 := 40075016.686 / 65536;   -- a z16 tile's width at the equator, metres
begin
  if v_uid is null then
    raise exception 'not signed in' using errcode = '42501';
  end if;
  select * into c from public.legend_map_config;
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
  -- During a release the worker paints the staged version (its painter); new tiles go there, so they're
  -- ready when phones switch. The live version gets no new tiles in the meantime.
  v_target := coalesce(c.staging_version, c.version);

  -- The request as rows: n is its first position (screen tiles first), repeats folded.
  select coalesce(jsonb_agg(jsonb_build_object('n', r.n, 'z', r.z, 'x', r.x, 'y', r.y)), '[]'::jsonb) into v_req
  from (
    select min(e.n)::int as n, (e.t ->> 0)::int as z, (e.t ->> 1)::int as x, (e.t ->> 2)::int as y
    from jsonb_array_elements(p_tiles) with ordinality e(t, n)
    group by 2, 3, 4
  ) r;

  -- The player's row for today, locked: parallel calls of one player wait for each other,
  -- so the cap is checked against what the others queued.
  insert into public.legend_map_requests (player, day) values (v_uid, v_day) on conflict do nothing;
  select r.tiles, r.last_request_at into v_used, v_last
  from public.legend_map_requests r where r.player = v_uid and r.day = v_day for update;

  if v_last is not null and v_last > now() - c.min_request_interval then
    v_reason := 'throttled';
  else
    update public.legend_map_requests r set last_request_at = now() where r.player = v_uid and r.day = v_day;

    -- Today's global row, locked the same way (always after the player's row: no deadlock).
    insert into public.legend_map_daily (day) values (v_day) on conflict do nothing;
    select d.tiles into v_global from public.legend_map_daily d where d.day = v_day for update;

    -- Players' tiles waiting or painting (pre-painting has its own pace and doesn't count).
    select coalesce(sum(t.cost), 0)::int into v_depth
    from public.legend_map_tiles t
    where t.version = v_target and t.priority < 2
      and (t.status in ('queued', 'painting') or (t.status = 'failed' and t.attempts < c.max_attempts));

    -- The caller's own ground, as z16 tiles: claimed cells (a cell id is x * 2^21 + y at
    -- zoom 21) and the positions they submitted recently. Materialized: read once, not
    -- once per requested tile (a big territory would otherwise hold the global lock for
    -- seconds).
    with ground as materialized (
      select distinct (cc.cell / 2097152)::int >> 5 as gx, (cc.cell % 2097152)::int >> 5 as gy
      from public.claimed_cells cc where cc.user_id = v_uid
      union
      select distinct p.x, p.y
      from public.walk_points w, private.legend_map_z16(extensions.st_x(w.geom), extensions.st_y(w.geom)) p
      where w.user_id = v_uid and w.recorded_at > now() - c.recent_positions
    ),
    req as (
      select q.n, q.z::smallint as z, q.x, q.y,
        -- a z15 tile is made from its four z16 children: charge the ones not painted or queued
        case when q.z = 15 then 1 + (
          select 4 - count(*) from public.legend_map_tiles k
          where k.version = v_target and k.z = 16 and k.x in (q.x * 2, q.x * 2 + 1) and k.y in (q.y * 2, q.y * 2 + 1)
        ) else 1 end::int as cost,
        -- the tile in z16 coordinates (its corner, and its middle)
        case when q.z = 15 then q.x * 2 else q.x end as x16,
        case when q.z = 15 then q.y * 2 else q.y end as y16,
        case when q.z = 15 then q.x * 2 + 1.0 else q.x + 0.5 end as mx16,
        case when q.z = 15 then q.y * 2 + 1.0 else q.y + 0.5 end as my16
      from jsonb_to_recordset(v_req) q(n int, z int, x int, y int)
    ),
    -- the middle of the screen: of the tiles on screen, or of all if none is
    mid as (
      select avg(r.mx16) as mx, avg(r.my16) as my from req r where r.n <= v_visible or v_visible = 0
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
        select 1 from public.legend_map_tiles t
        where t.version = v_target and t.z = r.z and t.x = r.x and t.y = r.y
      )
    ),
    -- on screen first, then nearest the middle of the screen
    near_fresh as (
      select f.*, sum(f.cost) over (
        order by f.n > v_visible, (f.mx16 - m.mx) ^ 2 + (f.my16 - m.my) ^ 2, f.n
        rows unbounded preceding) as cum
      from fresh f, mid m where f.near
    ),
    limits as (
      select greatest(0, least(c.daily_tiles_per_player - v_used, c.global_daily_tiles - v_global, c.max_queue_depth - v_depth)) as room
    ),
    ins as (
      insert into public.legend_map_tiles (version, z, x, y, priority, requested_by, cost, last_requested_at)
      select v_target, nf.z, nf.x, nf.y, case when nf.n <= v_visible then 0 else 1 end, v_uid, nf.cost, now()
      from near_fresh nf, limits l
      where nf.cum <= l.room
      on conflict do nothing
      returning cost
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
      update public.legend_map_requests r set tiles = r.tiles + v_cost where r.player = v_uid and r.day = v_day;
      update public.legend_map_daily d set tiles = d.tiles + v_cost where d.day = v_day;
    end if;
  end if;

  -- What phones still look at: a release re-paints tiles requested within release_recent (at most one write per
  -- tile and day).
  update public.legend_map_tiles t set last_requested_at = now()
  from jsonb_to_recordset(v_req) q(n int, z int, x int, y int)
  where t.version = c.version and t.z = q.z and t.x = q.x and t.y = q.y
    and (t.last_requested_at is null or t.last_requested_at < now() - interval '1 day');

  select
    coalesce(jsonb_agg(jsonb_build_array(t.z, t.x, t.y) order by q.n) filter (
      where t.status in ('queued', 'painting') or (t.status = 'failed' and t.attempts < c.max_attempts)), '[]'::jsonb),
    coalesce(jsonb_agg(jsonb_build_array(t.z, t.x, t.y) order by q.n) filter (where t.status = 'ready'), '[]'::jsonb)
  into v_pending, v_ready
  from jsonb_to_recordset(v_req) q(n int, z int, x int, y int)
  join public.legend_map_tiles t on t.version = c.version and t.z = q.z and t.x = q.x and t.y = q.y;

  return jsonb_build_object('enabled', true, 'version', c.version, 'pending', v_pending, 'ready', v_ready,
    'queued', v_queued, 'capped', v_reason is not null, 'reason', v_reason, 'far', v_far);
end;
$function$;

comment on function public.advance_legend_map_release() is
  'Renderer only. Switches phones to the staged tile version once it has nothing left to paint.';
comment on function public.begin_legend_map_release(p_fingerprint text) is
  'Renderer only. The worker''s start-up call with its painter fingerprint: carries on, stages a new tile version, or rolls back.';
comment on function public.legend_map_status() is
  'Renderer and SQL editor. Limits and today''s use, queue depth, throughput, storage, the last error and today''s requests, as JSON.';
comment on function public.finish_legend_map_tile(p_version integer, p_z integer, p_x integer, p_y integer, p_ok boolean, p_bytes integer, p_paint_ms integer, p_error text) is
  'Renderer only. Marks a Legend map tile ready (uploaded) or failed (retried after retry_after, up to max_attempts, then after failed_cooldown).';
comment on function public.get_legend_map_config() is
  'Whether the Legend map is on, and which tile version and bucket the app shows.';
comment on function public.is_legend_map_renderer() is
  'True for the service role and for the user whose app_metadata has legend_map_renderer: true (or, until the compatibility section is removed, the earlier fantasy_renderer: true).';
comment on function public.lease_legend_map_tiles(p_limit integer, p_fingerprint text) is
  'Renderer only. Leases up to p_limit Legend map tiles of the versions painted with painter p_fingerprint.';
comment on function public.queue_legend_map_tiles(p_tiles jsonb, p_dry_run boolean) is
  'Renderer only. Queues Legend map tiles for pre-painting (priority 2, outside the players'' limits); returns {version, queued, existing}.';
comment on function public.request_legend_map_tiles(p_tiles jsonb, p_visible integer) is
  'Queues the requested Legend map tiles never painted that lie near the caller''s own ground, within the limits in legend_map_config; returns {enabled, version, pending, ready, queued, capped, reason, far}.';

-- ---------------------------------------------------------------------------
-- Storage: the new bucket, with the same rules the old one had. Public reads (through the CDN);
-- the renderer writes v<version>/<15|16>/<x>/<y>.webp|json and nothing else (an upsert needs
-- the first three policies), and deletes only files of versions past their grace period.
-- ---------------------------------------------------------------------------

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('legend-map-tiles', 'legend-map-tiles', true, 4194304, array['image/webp', 'application/json'])
on conflict (id) do nothing;

drop policy "fantasy renderer reads tiles" on storage.objects;
drop policy "fantasy renderer writes tiles" on storage.objects;
drop policy "fantasy renderer replaces tiles" on storage.objects;
drop policy "fantasy renderer deletes replaced versions" on storage.objects;

create policy "Legend map renderer reads tiles" on storage.objects
  for select to authenticated
  using (bucket_id = 'legend-map-tiles' and public.is_legend_map_renderer());

create policy "Legend map renderer writes tiles" on storage.objects
  for insert to authenticated
  with check (
    bucket_id = 'legend-map-tiles' and public.is_legend_map_renderer()
    and name ~ '^v[0-9]{1,6}/1[56]/[0-9]{1,5}/[0-9]{1,5}\.(webp|json)$'
  );

create policy "Legend map renderer replaces tiles" on storage.objects
  for update to authenticated
  using (bucket_id = 'legend-map-tiles' and public.is_legend_map_renderer())
  with check (
    bucket_id = 'legend-map-tiles' and public.is_legend_map_renderer()
    and name ~ '^v[0-9]{1,6}/1[56]/[0-9]{1,5}/[0-9]{1,5}\.(webp|json)$'
  );

create policy "Legend map renderer deletes replaced versions" on storage.objects
  for delete to authenticated
  using (bucket_id = 'legend-map-tiles' and public.is_legend_map_renderer() and public.legend_map_object_deletable(name));

-- ===========================================================================
-- Compatibility until the rename is adopted. Remove all of this section in one later migration
-- (see the top of this file).
-- ===========================================================================

-- The bucket app versions from before the rename read tiles from.
alter table public.legend_map_config
  add column old_app_bucket text not null default 'fantasy-tiles'
    constraint legend_map_config_old_app_bucket_check check (old_app_bucket in ('fantasy-tiles', 'legend-map-tiles'));
comment on column public.legend_map_config.old_app_bucket is
  'Compatibility, removed later: the bucket app versions from before the rename read tiles from (get_fantasy_config). fantasy-tiles until finish_legend_map_bucket_copy has checked the copy, then legend-map-tiles.';

-- The old bucket: the renderer may still read it (the copy's source) and write it (so the worker
-- image from before the rename keeps working if the cut-over is undone before the copy). It may no
-- longer delete there: the old files stay until the bucket is emptied on purpose.
create policy "Legend map renderer reads the old bucket" on storage.objects
  for select to authenticated
  using (bucket_id = 'fantasy-tiles' and public.is_legend_map_renderer());

create policy "Legend map renderer writes the old bucket" on storage.objects
  for insert to authenticated
  with check (
    bucket_id = 'fantasy-tiles' and public.is_legend_map_renderer()
    and name ~ '^v[0-9]{1,6}/1[56]/[0-9]{1,5}/[0-9]{1,5}\.(webp|json)$'
  );

create policy "Legend map renderer replaces in the old bucket" on storage.objects
  for update to authenticated
  using (bucket_id = 'fantasy-tiles' and public.is_legend_map_renderer())
  with check (
    bucket_id = 'fantasy-tiles' and public.is_legend_map_renderer()
    and name ~ '^v[0-9]{1,6}/1[56]/[0-9]{1,5}/[0-9]{1,5}\.(webp|json)$'
  );

-- The copy. The worker copies every old file server-side (Storage's copy call), then asks the
-- database to check it; only a complete copy (every old file present in the new bucket with the
-- same size) switches old_app_bucket.

create function public.legend_map_bucket_copy_candidates(p_limit int default 500)
returns table (name text)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if not public.is_legend_map_renderer() then
    raise exception 'only the Legend map renderer copies tiles' using errcode = '42501';
  end if;
  return query
  select o.name from storage.objects o, public.legend_map_config c
  where c.old_app_bucket = 'fantasy-tiles'
    and o.bucket_id = 'fantasy-tiles'
    and not exists (
      select 1 from storage.objects n
      where n.bucket_id = 'legend-map-tiles' and n.name = o.name and n.metadata ->> 'size' = o.metadata ->> 'size'
    )
  order by o.name
  limit greatest(0, least(p_limit, 1000));
end;
$$;

comment on function public.legend_map_bucket_copy_candidates(int) is
  'Compatibility, removed later. Renderer only. Old-bucket files not yet in legend-map-tiles with the same size; none once old_app_bucket is switched.';

revoke all on function public.legend_map_bucket_copy_candidates(int) from public, anon;
grant execute on function public.legend_map_bucket_copy_candidates(int) to authenticated, service_role;

create function public.finish_legend_map_bucket_copy()
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  c public.legend_map_config;
  v_objects bigint;
  v_bytes numeric;
  v_copied bigint;
begin
  if not public.is_legend_map_renderer() then
    raise exception 'only the Legend map renderer copies tiles' using errcode = '42501';
  end if;
  select * into c from public.legend_map_config for update;
  if c.old_app_bucket = 'legend-map-tiles' then
    return jsonb_build_object('switched', false, 'already', true);
  end if;
  select count(*), coalesce(sum((o.metadata ->> 'size')::bigint), 0),
    count(n.id) filter (where n.metadata ->> 'size' = o.metadata ->> 'size')
  into v_objects, v_bytes, v_copied
  from storage.objects o
  left join storage.objects n on n.bucket_id = 'legend-map-tiles' and n.name = o.name
  where o.bucket_id = 'fantasy-tiles';
  if v_copied <> v_objects then
    return jsonb_build_object('switched', false, 'objects', v_objects, 'bytes', v_bytes, 'copied', v_copied);
  end if;
  update public.legend_map_config set old_app_bucket = 'legend-map-tiles' where id;
  return jsonb_build_object('switched', true, 'objects', v_objects, 'bytes', v_bytes, 'copied', v_copied);
end;
$$;

comment on function public.finish_legend_map_bucket_copy() is
  'Compatibility, removed later. Renderer only. Checks that every old-bucket file is in legend-map-tiles with the same size and, if so, points app versions from before the rename at legend-map-tiles.';

revoke all on function public.finish_legend_map_bucket_copy() from public, anon;
grant execute on function public.finish_legend_map_bucket_copy() to authenticated, service_role;

-- The names app versions and the worker image from before the rename call: thin wrappers.

create function public.get_fantasy_config()
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select public.get_legend_map_config() || jsonb_build_object('bucket', c.old_app_bucket)
  from public.legend_map_config c
$$;

create function public.request_fantasy_tiles(p_tiles jsonb, p_visible int default 0)
returns jsonb
language sql
set search_path = ''
as $$
  select public.request_legend_map_tiles(p_tiles, p_visible)
$$;

create function public.lease_fantasy_tiles(p_limit int, p_fingerprint text default null)
returns table (version int, z smallint, x int, y int, webp_quality real)
language sql
set search_path = ''
as $$
  select * from public.lease_legend_map_tiles(p_limit, p_fingerprint)
$$;

create function public.finish_fantasy_tile(p_version int, p_z int, p_x int, p_y int, p_ok boolean,
  p_bytes int default null, p_paint_ms int default null, p_error text default null)
returns void
language sql
set search_path = ''
as $$
  select public.finish_legend_map_tile(p_version, p_z, p_x, p_y, p_ok, p_bytes, p_paint_ms, p_error)
$$;

create function public.queue_fantasy_tiles(p_tiles jsonb, p_dry_run boolean default false)
returns jsonb
language sql
set search_path = ''
as $$
  select public.queue_legend_map_tiles(p_tiles, p_dry_run)
$$;

create function public.fantasy_status()
returns jsonb
language sql
stable
set search_path = ''
as $$
  select public.legend_map_status()
$$;

comment on function public.get_fantasy_config() is 'Compatibility, removed later: get_legend_map_config for app versions from before the rename, with the bucket they read from.';
comment on function public.request_fantasy_tiles(jsonb, int) is 'Compatibility, removed later: request_legend_map_tiles under its earlier name.';
comment on function public.lease_fantasy_tiles(int, text) is 'Compatibility, removed later: lease_legend_map_tiles under its earlier name.';
comment on function public.finish_fantasy_tile(int, int, int, int, boolean, int, int, text) is 'Compatibility, removed later: finish_legend_map_tile under its earlier name.';
comment on function public.queue_fantasy_tiles(jsonb, boolean) is 'Compatibility, removed later: queue_legend_map_tiles under its earlier name.';
comment on function public.fantasy_status() is 'Compatibility, removed later: legend_map_status under its earlier name.';

revoke all on function public.get_fantasy_config() from public, anon;
grant execute on function public.get_fantasy_config() to authenticated, service_role;
revoke all on function public.request_fantasy_tiles(jsonb, int) from public, anon;
grant execute on function public.request_fantasy_tiles(jsonb, int) to authenticated;
revoke all on function public.lease_fantasy_tiles(int, text) from public, anon;
grant execute on function public.lease_fantasy_tiles(int, text) to authenticated, service_role;
revoke all on function public.finish_fantasy_tile(int, int, int, int, boolean, int, int, text) from public, anon;
grant execute on function public.finish_fantasy_tile(int, int, int, int, boolean, int, int, text) to authenticated, service_role;
revoke all on function public.queue_fantasy_tiles(jsonb, boolean) from public, anon;
grant execute on function public.queue_fantasy_tiles(jsonb, boolean) to authenticated, service_role;
revoke all on function public.fantasy_status() from public, anon;
grant execute on function public.fantasy_status() to authenticated, service_role;
