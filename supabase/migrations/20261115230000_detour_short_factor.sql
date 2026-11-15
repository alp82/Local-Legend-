-- Short detours get a more realistic added time.
--
-- The added time was 2 x 1.3 x the straight-line distance from the route, at
-- 5 km/h. On testers' real tracks (docs/detour-real-tracks.md), 1.3 fit
-- expeditions (median 1.26 on real streets) but not short offers (median
-- 2.53): 8 of 12 spots labeled 3 to 5 minutes took longer. The user chose a
-- street factor of 2.0 for spots less than 200 m from the route, and 1.3 from
-- 200 m up. Both factors and the 200 m are in private.detour_rules().
--
-- With 2.0, the short band (3 to 5 minutes) holds spots about 52 to 114 m
-- from the route, instead of 80 to 176 m. Longer and expedition offers sit
-- beyond 200 m and keep 1.3. private.detour_max_off_route_m() uses the
-- expedition band, so it keeps 1.3 too.

-- detour_rules() gains two columns, so it's dropped and created again. The
-- functions that call it look it up by name when they run.
drop function private.detour_rules();

create function private.detour_rules(
  out collect_radius_m float8,          -- Plan: collect by walking within about 30 m.
  out route_factor float8,              -- Plan: walking is about 30% longer than a straight line (from short_route_max_m up).
  out walk_speed_mps float8,            -- PLACEHOLDER: 5 km/h, to turn added meters into minutes.
  out route_zoom int,                   -- Tile zoom of route_tiles (19: about 47 m at 52N).
  out route_window_days int,            -- PLACEHOLDER: routes count from the last 28 days.
  out route_min_days int,               -- PLACEHOLDER: a tile walked on 2 different days is a frequent route.
  out bands jsonb,                      -- Design document: short 3 to 5 min, longer 10 to 15, weekend expeditions 30+ (upper bound 40 is a PLACEHOLDER).
  out offers_without_watchtower int,    -- PLACEHOLDER: offers a day before a Watchtower exists (its level 1 value).
  out offer_spacing_m float8,           -- PLACEHOLDER: offers of one day are at least this far apart.
  out repeat_after_days int,            -- PLACEHOLDER: a spot isn't offered to the same player again for this many days.
  out max_anchors int,                  -- Route tiles used per generation, most walked first. Bounds the work.
  out active_days int,                  -- The scheduled job generates for players who walked in this many days.
  out short_route_factor float8,        -- The user's decision: below short_route_max_m, streets add more (real tracks: median 2.53).
  out short_route_max_m float8          -- The user's decision: spots closer than this to the route use short_route_factor.
)
language sql
immutable
parallel safe
set search_path = ''
as $$
  select 30.0, 1.3, 5.0 / 3.6, 19, 28, 2,
    '{"short": {"min": 3, "max": 5}, "long": {"min": 10, "max": 15}, "expedition": {"min": 30, "max": 40}}'::jsonb,
    2, 250.0, 7, 3000, 7, 2.0, 200.0
$$;

comment on function private.detour_rules() is 'Detour offer thresholds that are not in the economy sheet, in one place.';

-- The walk there and back to a spot off_m meters (straight line) from the
-- route: 2 x the street factor x off_m, with short_route_factor below
-- short_route_max_m and route_factor from there up.
create function private.detour_added_m(off_m float8)
returns float8
language sql
immutable
parallel safe
set search_path = ''
as $$
  select 2 * case when off_m < d.short_route_max_m then d.short_route_factor else d.route_factor end * off_m
  from private.detour_rules() d
$$;

-- Same as *_detours.sql, except the added time comes from detour_added_m.
create or replace function private.generate_detour_offers(
  p_user uuid, p_at timestamptz, p_lat float8 default null, p_lng float8 default null
)
returns jsonb
language plpgsql
set search_path = ''
set client_min_messages = warning
as $$
declare
  d record;
  a record;
  v public.player_economy := private.ensure_economy(p_user);
  v_rules jsonb := private.economy_rules();
  v_day date;
  v_from timestamptz;
  v_until timestamptz;
  v_target int;
  v_have int;
  v_slot int;
  v_band text;
  v_bmin int;
  v_bmax int;
  v_k float8;
  v_missing int := 0;
  v_added int := 0;
  v_tavern int;
  v_gem float8;
  v_crystal float8;
  v_u float8;
  v_kind text;
  c record;
begin
  select * into d from private.detour_rules();

  -- The day never goes back: after a time zone change to the west, it stays
  -- at the latest day already generated.
  select greatest(private.game_day(p_at, v.time_zone), max(x.game_day)) into v_day
  from public.detour_days x where x.user_id = p_user;
  v_from := private.game_day_start(v_day, v.time_zone);
  v_until := private.game_day_start(v_day + 1, v.time_zone);

  select count(*) into v_have from public.detour_offers o where o.user_id = p_user and o.game_day = v_day;
  v_target := private.detour_offers_per_day(p_user);
  select * into a from private.detour_anchors(p_user, v_day, p_lat, p_lng);

  if v_have < v_target and a.route is not null then
    v_k := private.mercator_scale(extensions.st_y(extensions.st_centroid(a.route)));

    select count(*) into v_missing
    from private.detour_route_areas(a.route) w
    left join public.detour_spot_areas da on da.area = w.area
    where da.fetched_at is null;

    -- Built in one statement: API sessions load safeupdate, which refuses an
    -- UPDATE without a WHERE clause, even on a temporary table.
    drop table if exists detour_candidates;
    create temp table detour_candidates on commit drop as
    with near as (
      select sp.id, sp.kind, sp.subtype, sp.name, sp.geom,
        extensions.st_transform(sp.geom, 3857) as g,
        case sp.kind when 'place' then 1 when 'park' then 2 when 'square' then 3 when 'path' then 4 else 5 end as priority,
        private.unit_hash(p_user::text || v_day::text || sp.id::text) as h
      from public.detour_spots sp
      where sp.geom operator(extensions.&&) extensions.st_transform(
          extensions.st_expand(a.route, private.detour_max_off_route_m() * v_k), 4326)
        and not exists (
          select 1 from public.detour_offers o
          where o.user_id = p_user and o.spot_id = sp.id and o.game_day > v_day - d.repeat_after_days)
    ),
    measured as (
      select n.*, extensions.st_distance(n.g, a.route) / v_k as off_m, extensions.st_closestpoint(a.route, n.g) as anchor
      from near n
    )
    select m.*, private.detour_added_m(m.off_m) as added_m,
      round(private.detour_added_m(m.off_m) / d.walk_speed_mps / 60)::int as added_min
    from measured m;

    v_tavern := private.building_level(p_user, 'tavern');
    v_gem := case when v_tavern > 0
      then (v_rules -> 'buildings' -> 'tavern' -> 'levels' -> (v_tavern - 1) -> 'effects' ->> 'gemOfferShare')::float8
      else (v_rules -> 'detours' ->> 'gemOfferShare')::float8 end;
    v_crystal := (v_rules -> 'detours' ->> 'crystalOfferShare')::float8;

    for v_slot in v_have + 1 .. v_target loop
      v_band := case
        when extract(isodow from v_day) in (6, 7) and v_slot = v_target then 'expedition'
        when v_slot % 2 = 1 then 'short'
        else 'long' end;
      v_bmin := (d.bands -> v_band ->> 'min')::int;
      v_bmax := (d.bands -> v_band ->> 'max')::int;

      select dc.* into c
      from detour_candidates dc
      where dc.added_min between v_bmin and v_bmax
        and not exists (
          select 1 from public.detour_offers o
          where o.user_id = p_user and o.game_day = v_day
            and (o.spot_id = dc.id
              or extensions.st_dwithin(extensions.st_transform(o.geom, 3857), dc.g, d.offer_spacing_m * v_k)))
      order by dc.priority, dc.h, dc.id
      limit 1;

      if not found and v_missing = 0 then
        select dc.* into c
        from detour_candidates dc
        where dc.added_min >= (d.bands -> 'short' ->> 'min')::int
          and dc.added_min <= (d.bands -> 'expedition' ->> 'max')::int
          and not exists (
            select 1 from public.detour_offers o
            where o.user_id = p_user and o.game_day = v_day
              and (o.spot_id = dc.id
                or extensions.st_dwithin(extensions.st_transform(o.geom, 3857), dc.g, d.offer_spacing_m * v_k)))
        order by least(abs(dc.added_min - v_bmin), abs(dc.added_min - v_bmax)), dc.priority, dc.h, dc.id
        limit 1;
      end if;

      exit when not found;

      v_u := private.unit_hash(p_user::text || v_day::text || 'reward' || v_slot::text);
      v_kind := case when v_u < v_gem then 'gem' when v_u < v_gem + v_crystal then 'crystal' else 'common' end;

      insert into public.detour_offers (user_id, game_day, slot, spot_id, spot_kind, spot_subtype, name, geom, anchor,
        band, off_route_m, added_m, added_min, reward_kind, reward, xp, valid_from, valid_until, created_at)
      values (p_user, v_day, v_slot, c.id, c.kind, c.subtype, c.name, c.geom,
        extensions.st_transform(c.anchor, 4326), v_band, round(c.off_m::numeric, 1), round(c.added_m::numeric, 1),
        c.added_min, v_kind, v_rules -> 'detours' -> 'rewards' -> v_kind, (v_rules -> 'xp' ->> 'detour')::numeric,
        v_from, v_until, p_at);
      v_added := v_added + 1;
    end loop;
  end if;

  insert into public.detour_days as x (user_id, game_day, source, generated_at, updated_at)
  values (p_user, v_day, a.source, p_at, p_at)
  on conflict (user_id, game_day) do update
  set source = coalesce(x.source, excluded.source), updated_at = excluded.updated_at;

  return jsonb_build_object('gameDay', v_day, 'source', coalesce(
      (select x.source from public.detour_days x where x.user_id = p_user and x.game_day = v_day), a.source),
    'added', v_added, 'missingAreas', v_missing, 'validFrom', v_from, 'validUntil', v_until);
end;
$$;

comment on function private.generate_detour_offers(uuid, timestamptz, float8, float8) is
  'Fills the empty detour offer slots of the player''s game day at p_at. Never changes an offer already made.';

revoke all on all functions in schema private from public, anon, authenticated;
