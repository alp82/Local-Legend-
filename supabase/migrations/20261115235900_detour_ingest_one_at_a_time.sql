-- Detour spot areas: limit how many areas load at once.
--
-- public.ingest_detour_area is CPU-heavy: it unions the buildings and
-- exclusion zones of a whole zoom 14 tile and tests every candidate point
-- against them, about 0.1 to 0.6 s on a laptop and several seconds on the
-- hosted database. The detours Edge Function used to ingest its 4 leased
-- areas in parallel, and every overlapping call (map focus, foreground, each
-- upload, the 20 s retry) leased 4 more. On November 15, 2026, a first walk in
-- Kassel started 8 ingests at once on the 2-core database. 7 of them, and
-- the player's own get_detour_offers, get_sites, and submit_location_batch,
-- ran past the 8 s statement timeout.
--
-- Now:
--   - The Edge Function ingests its areas one at a time (detours/areas.ts).
--   - claim_detour_areas leases new areas only while fewer than
--     max_leased_areas are leased across all players, so overlapping calls
--     don't stack. Claims take a transaction lock, so two calls can't both
--     see room. A call that finds no room reports the areas it would have
--     leased with request null, like areas another caller is fetching, so the
--     app asks again in 20 s instead of right away.
--   - The lease is 60 s instead of 30 s: a call ingests up to 4 areas in a
--     row, after downloads of at most 10 s, and each ingest can take up to
--     the 8 s statement timeout. 10 + 4 x 8 = 42 s.
-- No game rule changes: the same areas load, only fewer at a time.

-- detour_spot_settings gains max_leased_areas; a new OUT column needs a new
-- function. Its callers read it by column name.
drop function private.detour_spot_settings();

create function private.detour_spot_settings(
  out area_zoom int,               -- One vector tile per area, the same tiles as the sites. Changing it invalidates detour_spot_areas.
  out spot_zoom int,               -- At most one spot per tile at this zoom; the tile id is the spot id.
  out sample_spacing_m float8,     -- Spots along a footway or street, this far apart.
  out hazard_buffer_m float8,      -- PLACEHOLDER: no spot this close to a rail line, motorway, or trunk road.
  out refetch_after interval,      -- Areas older than this are fetched again.
  out lease interval,              -- How long one caller owns an area fetch. Covers max_areas_per_call ingests in a row.
  out retry_after interval,        -- Wait after a failed fetch before trying again.
  out max_areas_per_call int,      -- Tile downloads per detours call, at most.
  out max_leased_areas int         -- Areas leased at once across all players, at most. Each ingest is CPU-heavy.
)
language sql
immutable
parallel safe
set search_path = ''
as $$
  select 14, 19, 50.0, 20.0, interval '30 days', interval '60 seconds', interval '10 minutes', 4, 4
$$;

comment on function private.detour_spot_settings() is 'Detour spot thresholds, in one place.';

revoke all on function private.detour_spot_settings() from public, anon, authenticated;

create or replace function public.claim_detour_areas(
  p_user uuid, p_lat float8 default null, p_lng float8 default null, p_max int default null
)
returns table (area bigint, request jsonb)
language plpgsql
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  s record;
  a record;
  v_day date;
  v_limit int;
  v_room int;
begin
  select * into s from private.detour_spot_settings();
  select private.game_day(now(), coalesce(e.time_zone, 'UTC')) into v_day
  from (select 1) x left join public.player_economy e on e.user_id = p_user;
  select * into a from private.detour_anchors(p_user, v_day, p_lat, p_lng);
  if a.route is null then
    return;
  end if;

  -- One claim at a time, so two callers can't both see room.
  perform pg_advisory_xact_lock(hashtextextended('public.claim_detour_areas', 0));
  v_limit := greatest(0, least(coalesce(p_max, s.max_areas_per_call), s.max_areas_per_call));
  select greatest(0, s.max_leased_areas - count(*)::int) into v_room
  from public.detour_spot_areas da
  where da.lease_until >= now();

  return query
  with wanted as (
    select w.area as a, w.dist_m from private.detour_route_areas(a.route) w
  ),
  todo as (
    select w.a, row_number() over (order by w.dist_m, w.a) as rn
    from wanted w
    left join public.detour_spot_areas da on da.area = w.a
    where (da.area is null or da.fetched_at is null or da.fetched_at < now() - s.refetch_after)
      and (da.lease_until is null or da.lease_until < now())
      and (da.failed_at is null or da.failed_at < now() - s.retry_after)
    order by w.dist_m, w.a
    limit v_limit
  ),
  leased as (
    insert into public.detour_spot_areas as da (area, lease_until)
    select t.a, now() + s.lease from todo t where t.rn <= v_room
    on conflict on constraint detour_spot_areas_pkey do update
      set lease_until = excluded.lease_until
      where da.lease_until is null or da.lease_until < now()
    returning da.area
  )
  select l.area, private.detour_spot_filter() from leased l
  union all
  select w.a, null::jsonb
  from wanted w
  join public.detour_spot_areas da on da.area = w.a
  where da.lease_until >= now() and not exists (select 1 from leased l where l.area = w.a)
  union all
  -- Waiting for a free fetch slot: reported like areas another caller fetches.
  select t.a, null::jsonb from todo t where t.rn > v_room;
end;
$$;

comment on function public.claim_detour_areas(uuid, float8, float8, int) is
  'Service role only. Leases spot areas within reach of the player''s routes that need a tile fetch, at most max_leased_areas across all players, and returns {area, request}; request is null for areas another caller is fetching or that wait for a free fetch slot.';
