-- Fantasy map releases: a new painter replaces the tiles phones see without old and new pictures side by side.
--
-- Each painter has a fingerprint (supabase/fantasy-renderer/src/fingerprint.mjs): a hash of everything that can
-- change painted output. The worker reports it when it starts (begin_fantasy_release), and the database decides:
--
--   - same fingerprint as the live version: nothing to do, the worker carries on;
--   - a fingerprint never released: a new tile version is staged. The worker paints it in the background for
--     every known area (claimed land plus release_buffer_m, and the live tiles requested within release_recent),
--     while phones keep the live version. When nothing is left to paint, advance_fantasy_release switches
--     fantasy_config.version, and phones pick up the new version at their next configuration check;
--   - the fingerprint of a version released before whose tiles still exist (a rollback): phones switch back to it
--     at once, and the tiles it misses are queued;
--   - the fingerprint of a staged version never released (an abandoned release, deployed again): its staging
--     resumes where it stopped.
--
-- A version replaced by another is retired; after version_grace its files are deleted from Storage by the worker
-- (fantasy_cleanup_candidates, the storage policy below) and its rows forgotten (fantasy_forget_versions).
-- Nobody runs SQL for any of it, and GitHub needs no database credential: the worker does it on start-up, as the
-- renderer user.
--
-- While a release stages, players' new tiles go to the staged version (the running worker can only paint with
-- its own painter); the live version gets no new tiles until the switch.

set lock_timeout = '5s';

-- ---------------------------------------------------------------------------
-- Configuration and versions
-- ---------------------------------------------------------------------------

alter table public.fantasy_config
  add column fingerprint text,                           -- painter fingerprint of `version` (null until a worker reports it)
  add column staging_version int,                        -- the version being painted for a release, or null
  add column staging_fingerprint text,
  add column staging_started_at timestamptz,
  add column release_buffer_m int not null default 1000 check (release_buffer_m >= 0), -- painted round claimed land for a release
  add column release_recent interval not null default '30 days', -- live tiles requested this recently are painted for a release
  add column version_grace interval not null default '7 days',   -- a replaced version's files are deleted after this
  add constraint fantasy_config_staging check ((staging_version is null) = (staging_fingerprint is null));

create table public.fantasy_versions (
  version int primary key check (version > 0),
  fingerprint text not null,
  created_at timestamptz not null default now(),
  released_at timestamptz,                               -- last time phones were switched to it
  retired_at timestamptz,                                -- last time another version replaced it
  deleted_at timestamptz                                 -- its files and rows are gone; the number is never reused
);

comment on table public.fantasy_versions is
  'Fantasy tile versions and the painter fingerprint each was painted with: released, retired, deleted.';

-- not unique: after a manual version bump (new source data) the same painter owns two versions; the newest counts
create index fantasy_versions_fingerprint on public.fantasy_versions (fingerprint) where deleted_at is null;

alter table public.fantasy_versions enable row level security;
revoke all on public.fantasy_versions from anon, authenticated;

alter table public.fantasy_tiles add column last_requested_at timestamptz; -- last request by a player (at most daily)

-- ---------------------------------------------------------------------------
-- Leasing: a worker paints only versions painted with its own painter
-- ---------------------------------------------------------------------------

drop function public.lease_fantasy_tiles(int);

-- Leases up to p_limit tiles of the versions this painter may paint: the live version if p_fingerprint is its
-- fingerprint (or none is recorded yet), and the staged version if p_fingerprint is the staged one. Without a
-- fingerprint (a worker from before releases) only the live version. Order as before: on screen, around, then
-- pre-painting and release staging; within a priority players take turns, oldest first, z16 before z15.
create function public.lease_fantasy_tiles(p_limit int, p_fingerprint text default null)
returns table (version int, z smallint, x int, y int, webp_quality real)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  c public.fantasy_config;
  v_versions int[];
begin
  if not public.is_fantasy_renderer() then
    raise exception 'only the fantasy renderer leases tiles' using errcode = '42501';
  end if;
  select * into c from public.fantasy_config;
  v_versions := array_remove(array[
    case when p_fingerprint is null or c.fingerprint is null or c.fingerprint = p_fingerprint then c.version end,
    case when p_fingerprint is not null and c.staging_fingerprint = p_fingerprint then c.staging_version end
  ], null);

  -- Leases that expired max_attempts times: given up, like a tile that failed that often.
  update public.fantasy_tiles t
  set status = 'failed', finished_at = now(), error = 'lease expired ' || t.attempts || ' times (the worker stopped while painting it)'
  where t.version = any (v_versions) and t.status = 'painting' and t.lease_until < now() and t.attempts >= c.max_attempts;

  return query
  with waiting as (
    select t.version, t.z, t.x, t.y, t.priority, t.requested_at,
      row_number() over (
        partition by t.priority, coalesce(t.requested_by, '00000000-0000-0000-0000-000000000000'::uuid)
        order by t.requested_at, t.z desc, t.x, t.y
      ) as turn
    from public.fantasy_tiles t
    where t.version = any (v_versions)
      and (t.status = 'queued'
        or (t.status = 'painting' and t.lease_until < now())
        or (t.status = 'failed' and t.lease_until < now()
          and (t.attempts < c.max_attempts or t.finished_at < now() - c.failed_cooldown)))
  ),
  picked as (
    select t.version, t.z, t.x, t.y
    from public.fantasy_tiles t
    join waiting w on w.version = t.version and w.z = t.z and w.x = t.x and w.y = t.y
    order by w.priority, w.turn, w.requested_at, w.z desc, w.x, w.y
    limit greatest(0, least(p_limit, 64))
    for update of t skip locked
  ),
  leased as (
    update public.fantasy_tiles t
    set status = 'painting', lease_until = now() + c.lease, attempts = t.attempts + 1
    from picked p
    where t.version = p.version and t.z = p.z and t.x = p.x and t.y = p.y
    returning t.version, t.z, t.x, t.y
  )
  select l.version, l.z, l.x, l.y, c.webp_quality
  from leased l
  join waiting w on w.version = l.version and w.z = l.z and w.x = l.x and w.y = l.y
  order by w.priority, w.turn, w.requested_at, w.z desc, w.x, w.y;
end;
$$;

comment on function public.lease_fantasy_tiles(int, text) is
  'Renderer only. Leases up to p_limit fantasy tiles of the versions painted with painter p_fingerprint.';

revoke all on function public.lease_fantasy_tiles(int, text) from public, anon;
grant execute on function public.lease_fantasy_tiles(int, text) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Releases
-- ---------------------------------------------------------------------------

-- Queues for version p_version every known area: z16 tiles within release_buffer_m of claimed land and their
-- z15 parents, and every tile of the live version requested within release_recent. Tiles the version already
-- has are left alone. Returns how many were queued. Positions never leave the database.
create function private.fantasy_queue_known(p_version int, p_priority smallint)
returns int
language sql
volatile
set search_path = ''
as $$
  with c as (select * from public.fantasy_config),
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
    select t.z, t.x, t.y from public.fantasy_tiles t, c
    where t.version = c.version and t.status = 'ready'
      and coalesce(t.last_requested_at, t.requested_at) > now() - c.release_recent
  ),
  ins as (
    insert into public.fantasy_tiles (version, z, x, y, priority)
    select p_version, k.z, k.x, k.y, p_priority from known k
    where k.x >= 0 and k.y >= 0 and k.x < (1 << k.z) and k.y < (1 << k.z)
    on conflict do nothing
    returning 1
  )
  select count(*)::int from ins
$$;

revoke all on function private.fantasy_queue_known(int, smallint) from public, anon, authenticated;

-- Called by the worker when it starts, with its painter fingerprint. Returns
--   {"action": "adopted" | "current" | "staging" | "rolled_back", "version", "queued"?, "abandoned"?}
-- adopted: no fingerprint was recorded yet (the first worker since this migration): the live version is taken to
-- be this painter's. current: this painter painted the live version. staging: this painter's version is being
-- painted for a release (new, resumed, or replacing another staged release). rolled_back: phones are back on
-- this painter's earlier version.
create function public.begin_fantasy_release(p_fingerprint text)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  c public.fantasy_config;
  v public.fantasy_versions;
  v_queued int;
  v_abandoned int;
begin
  if not public.is_fantasy_renderer() then
    raise exception 'only the fantasy renderer starts releases' using errcode = '42501';
  end if;
  if p_fingerprint is null or p_fingerprint !~ '^[0-9a-f]{16}$' then
    raise exception 'p_fingerprint must be 16 hex digits' using errcode = '22023';
  end if;
  select * into c from public.fantasy_config for update;

  if c.fingerprint is null then
    update public.fantasy_config set fingerprint = p_fingerprint where id;
    insert into public.fantasy_versions (version, fingerprint, released_at) values (c.version, p_fingerprint, now())
    on conflict (version) do update set fingerprint = excluded.fingerprint, released_at = coalesce(public.fantasy_versions.released_at, now());
    return jsonb_build_object('action', 'adopted', 'version', c.version);
  end if;

  if p_fingerprint = c.fingerprint then
    -- the live painter is back while another one was staging: that release is abandoned (its tiles are kept;
    -- deploying its image again resumes it)
    v_abandoned := c.staging_version;
    update public.fantasy_config set staging_version = null, staging_fingerprint = null, staging_started_at = null where id;
    return jsonb_build_object('action', 'current', 'version', c.version, 'abandoned', v_abandoned);
  end if;

  if p_fingerprint = c.staging_fingerprint then
    return jsonb_build_object('action', 'staging', 'version', c.staging_version, 'resumed', true);
  end if;

  select * into v from public.fantasy_versions where fingerprint = p_fingerprint and deleted_at is null
  order by version desc limit 1;

  if v.version is not null and v.released_at is not null then
    -- a rollback: phones switch back now; the areas it misses (explored since) are queued
    update public.fantasy_versions set retired_at = now() where version = c.version;
    update public.fantasy_versions set released_at = now(), retired_at = null where version = v.version;
    update public.fantasy_config
      set version = v.version, fingerprint = p_fingerprint, staging_version = null, staging_fingerprint = null, staging_started_at = null
    where id;
    v_queued := private.fantasy_queue_known(v.version, 1::smallint);
    return jsonb_build_object('action', 'rolled_back', 'version', v.version, 'from', c.version, 'queued', v_queued);
  end if;

  if v.version is null then
    insert into public.fantasy_versions (version, fingerprint)
    values (greatest(c.version, (select coalesce(max(version), 0) from public.fantasy_versions)) + 1, p_fingerprint)
    returning * into v;
  end if;
  update public.fantasy_config set staging_version = v.version, staging_fingerprint = p_fingerprint, staging_started_at = now() where id;
  v_queued := private.fantasy_queue_known(v.version, 2::smallint);
  return jsonb_build_object('action', 'staging', 'version', v.version, 'queued', v_queued, 'replaced', c.staging_version);
end;
$$;

comment on function public.begin_fantasy_release(text) is
  'Renderer only. The worker''s start-up call with its painter fingerprint: carries on, stages a new tile version, or rolls back.';

revoke all on function public.begin_fantasy_release(text) from public, anon;
grant execute on function public.begin_fantasy_release(text) to authenticated, service_role;

-- Called by the worker while idle. When the staged version has nothing left to paint (tiles given up after
-- max_attempts don't hold it back), phones are switched to it. Returns {"staging": false} without a release,
-- {"staging": true, "version", "remaining"} while one is painted, {"switched": true, "from", "to"} at the switch.
create function public.advance_fantasy_release()
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  c public.fantasy_config;
  v_remaining int;
begin
  if not public.is_fantasy_renderer() then
    raise exception 'only the fantasy renderer advances releases' using errcode = '42501';
  end if;
  select * into c from public.fantasy_config for update;
  if c.staging_version is null then
    return jsonb_build_object('staging', false);
  end if;
  select count(*) into v_remaining from public.fantasy_tiles t
  where t.version = c.staging_version
    and (t.status in ('queued', 'painting') or (t.status = 'failed' and t.attempts < c.max_attempts));
  if v_remaining > 0 then
    return jsonb_build_object('staging', true, 'version', c.staging_version, 'remaining', v_remaining);
  end if;
  update public.fantasy_versions set retired_at = now() where version = c.version;
  update public.fantasy_versions set released_at = now(), retired_at = null where version = c.staging_version;
  update public.fantasy_config
    set version = c.staging_version, fingerprint = c.staging_fingerprint,
        staging_version = null, staging_fingerprint = null, staging_started_at = null
    where id;
  return jsonb_build_object('switched', true, 'from', c.version, 'to', c.staging_version);
end;
$$;

comment on function public.advance_fantasy_release() is
  'Renderer only. Switches phones to the staged tile version once it has nothing left to paint.';

revoke all on function public.advance_fantasy_release() from public, anon;
grant execute on function public.advance_fantasy_release() to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Cleanup of replaced versions
-- ---------------------------------------------------------------------------

-- Versions whose files may go: neither live nor staged, not deleted yet, and replaced (or, never released,
-- created) more than version_grace ago.
create function private.fantasy_deletable_versions()
returns setof int
language sql
stable
set search_path = ''
as $$
  select v.version
  from public.fantasy_versions v, public.fantasy_config c
  where v.deleted_at is null
    and v.version <> c.version and v.version is distinct from c.staging_version
    and coalesce(v.retired_at, case when v.released_at is null then v.created_at end) < now() - c.version_grace
$$;

revoke all on function private.fantasy_deletable_versions() from public, anon, authenticated;

-- Whether a Storage object in fantasy-tiles belongs to a deletable version (for the delete policy below).
create function public.fantasy_object_deletable(p_name text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(substring(p_name from '^v([0-9]{1,6})/')::int in (select private.fantasy_deletable_versions()), false)
$$;

revoke all on function public.fantasy_object_deletable(text) from public, anon;
grant execute on function public.fantasy_object_deletable(text) to authenticated, service_role;

-- Up to p_limit files of deletable versions, for the worker to delete through the Storage API.
create function public.fantasy_cleanup_candidates(p_limit int default 500)
returns setof text
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if not public.is_fantasy_renderer() then
    raise exception 'only the fantasy renderer cleans up tiles' using errcode = '42501';
  end if;
  return query
  select o.name from storage.objects o
  where o.bucket_id = 'fantasy-tiles'
    and substring(o.name from '^v([0-9]{1,6})/')::int in (select private.fantasy_deletable_versions())
  order by o.name
  limit greatest(0, least(p_limit, 1000));
end;
$$;

revoke all on function public.fantasy_cleanup_candidates(int) from public, anon;
grant execute on function public.fantasy_cleanup_candidates(int) to authenticated, service_role;

-- Forgets deletable versions with no files left: their tile rows go and they're marked deleted. Returns the
-- versions forgotten.
create function public.fantasy_forget_versions()
returns int[]
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_done int[];
begin
  if not public.is_fantasy_renderer() then
    raise exception 'only the fantasy renderer cleans up tiles' using errcode = '42501';
  end if;
  select coalesce(array_agg(d.v), '{}') into v_done
  from private.fantasy_deletable_versions() d(v)
  where not exists (select 1 from storage.objects o where o.bucket_id = 'fantasy-tiles' and o.name like 'v' || d.v || '/%');
  delete from public.fantasy_tiles where version = any (v_done);
  update public.fantasy_versions set deleted_at = now() where version = any (v_done);
  return v_done;
end;
$$;

revoke all on function public.fantasy_forget_versions() from public, anon;
grant execute on function public.fantasy_forget_versions() to authenticated, service_role;

-- The renderer may delete exactly the files of deletable versions (through the Storage API; SQL deletes are
-- refused by Storage).
create policy "fantasy renderer deletes replaced versions" on storage.objects
  for delete to authenticated
  using (bucket_id = 'fantasy-tiles' and public.is_fantasy_renderer() and public.fantasy_object_deletable(name));

-- ---------------------------------------------------------------------------
-- Requests, pre-painting and status, release-aware
-- ---------------------------------------------------------------------------

create or replace function public.request_fantasy_tiles(p_tiles jsonb, p_visible int default 0)
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
  v_target int;                                  -- the version being painted: the staged one during a release
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

    -- Players' tiles waiting or painting (pre-painting has its own pace and doesn't count).
    select coalesce(sum(t.cost), 0)::int into v_depth
    from public.fantasy_tiles t
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
      from public.walk_points w, private.fantasy_z16(extensions.st_x(w.geom), extensions.st_y(w.geom)) p
      where w.user_id = v_uid and w.recorded_at > now() - c.recent_positions
    ),
    req as (
      select q.n, q.z::smallint as z, q.x, q.y,
        -- a z15 tile is made from its four z16 children: charge the ones not painted or queued
        case when q.z = 15 then 1 + (
          select 4 - count(*) from public.fantasy_tiles k
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
        select 1 from public.fantasy_tiles t
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
      insert into public.fantasy_tiles (version, z, x, y, priority, requested_by, cost, last_requested_at)
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
      update public.fantasy_requests r set tiles = r.tiles + v_cost where r.player = v_uid and r.day = v_day;
      update public.fantasy_daily d set tiles = d.tiles + v_cost where d.day = v_day;
    end if;
  end if;

  -- What phones still look at: a release re-paints tiles requested within release_recent (at most one write per
  -- tile and day).
  update public.fantasy_tiles t set last_requested_at = now()
  from jsonb_to_recordset(v_req) q(n int, z int, x int, y int)
  where t.version = c.version and t.z = q.z and t.x = q.x and t.y = q.y
    and (t.last_requested_at is null or t.last_requested_at < now() - interval '1 day');

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

create or replace function public.queue_fantasy_tiles(p_tiles jsonb, p_dry_run boolean default false)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_version int := (select coalesce(c.staging_version, c.version) from public.fantasy_config c); -- the staged version during a release
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

create or replace function public.fantasy_status()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  c public.fantasy_config;
  v_day date := (now() at time zone 'utc')::date;
begin
  -- API requests always carry JWT claims; the SQL editor and psql sessions don't.
  if not (public.is_fantasy_renderer() or coalesce(current_setting('request.jwt.claims', true), '') = '') then
    raise exception 'only the fantasy renderer reads the status' using errcode = '42501';
  end if;
  select * into c from public.fantasy_config;
  return jsonb_build_object(
    'enabled', c.enabled,
    'version', c.version,
    'fingerprint', c.fingerprint,
    'staging', case when c.staging_version is null then null else jsonb_build_object(
      'version', c.staging_version,
      'fingerprint', c.staging_fingerprint,
      'started_at', c.staging_started_at,
      'remaining', (select count(*) from public.fantasy_tiles t where t.version = c.staging_version
        and (t.status in ('queued', 'painting') or (t.status = 'failed' and t.attempts < c.max_attempts))),
      'ready', (select count(*) from public.fantasy_tiles t where t.version = c.staging_version and t.status = 'ready')
    ) end,
    'versions', (select coalesce(jsonb_agg(jsonb_build_object('version', v.version, 'fingerprint', v.fingerprint,
        'released_at', v.released_at, 'retired_at', v.retired_at, 'deleted_at', v.deleted_at) order by v.version), '[]'::jsonb)
      from public.fantasy_versions v),
    'webp_quality', c.webp_quality,
    'limits', jsonb_build_object(
      'daily_tiles_per_player', c.daily_tiles_per_player,
      'global_daily_tiles', c.global_daily_tiles,
      'global_today', coalesce((select d.tiles from public.fantasy_daily d where d.day = v_day), 0),
      'max_queue_depth', c.max_queue_depth,
      -- players' tiles waiting or painting, in units (what max_queue_depth limits)
      'queue_depth', (
        select coalesce(sum(t.cost), 0)
        from public.fantasy_tiles t
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
      from public.fantasy_requests r where r.day = v_day
    )
  );
end;
$$;
