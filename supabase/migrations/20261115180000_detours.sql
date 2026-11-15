-- Detour offers: each game day, 2 to 5 rewards just off the routes a player
-- walks often, labeled with the walking time they add. Walking within 30 m of
-- one collects it. docs/detours.md describes the rules for players and testers.
--
-- Spots: offers sit only at public, walkable spots. Postgres can't fetch map
--   data, so the `detours` Edge Function downloads the OpenFreeMap vector tile
--   of each zoom 14 area (the same tiles as the sites and terrain) and sends
--   its walkable features to ingest_detour_area, which samples spots along
--   footways and residential streets, takes pedestrian squares and outdoor
--   landmarks, and drops everything private, closed to walkers, indoors, in a
--   tunnel, inside an excluded zone (private.exclude_rules: cemeteries,
--   schools, hospitals, rail yards, ...), or near a rail line or highway.
-- Routes: private.claim_settled records the zoom 19 tile (about 47 m at 52N)
--   of every walked, claimable segment per game day in public.route_tiles. A
--   route the player walks often is a tile walked on at least route_min_days
--   different days in the route_window before today.
-- Offers: private.generate_detour_offers picks spots whose detour from the
--   nearest frequent route tile fits each offer's band, in a fixed order per
--   player and day, so the same inputs always give the same offers.
-- Added time: there and back from the route, about 30% longer than a straight
--   line (IMPLEMENTATION_PLAN.md): 2 x 1.3 x distance, at walk_speed_mps.
-- Collecting: private.claim_settled, in the same transaction as the walk's
--   claims and pay, marks an offer collected the first time a settled,
--   vehicle-free walking segment passes within collect_radius_m of it during
--   the offer's game day and after it was offered, and pays its reward and XP
--   through the ledger (reason detour, ref = offer id) once.
-- Generation runs both ways: get_detour_offers (on app open) and a pg_cron job
--   every 15 minutes for players active in the last week. Both only fill the
--   day's empty slots, so they never change an offer already made.
--
-- Values that neither the economy sheet nor the plan gives are placeholders,
-- all in private.detour_rules() and private.detour_spot_settings().

-- ---------------------------------------------------------------------------
-- Settings, in one place
-- ---------------------------------------------------------------------------

create function private.detour_rules(
  out collect_radius_m float8,          -- Plan: collect by walking within about 30 m.
  out route_factor float8,              -- Plan: walking is about 30% longer than a straight line.
  out walk_speed_mps float8,            -- PLACEHOLDER: 5 km/h, to turn added meters into minutes.
  out route_zoom int,                   -- Tile zoom of route_tiles (19: about 47 m at 52N).
  out route_window_days int,            -- PLACEHOLDER: routes count from the last 28 days.
  out route_min_days int,               -- PLACEHOLDER: a tile walked on 2 different days is a frequent route.
  out bands jsonb,                      -- Design document: short 3 to 5 min, longer 10 to 15, weekend expeditions 30+ (upper bound 40 is a PLACEHOLDER).
  out offers_without_watchtower int,    -- PLACEHOLDER: offers a day before a Watchtower exists (its level 1 value).
  out offer_spacing_m float8,           -- PLACEHOLDER: offers of one day are at least this far apart.
  out repeat_after_days int,            -- PLACEHOLDER: a spot isn't offered to the same player again for this many days.
  out max_anchors int,                  -- Route tiles used per generation, most walked first. Bounds the work.
  out active_days int                   -- The scheduled job generates for players who walked in this many days.
)
language sql
immutable
parallel safe
set search_path = ''
as $$
  select 30.0, 1.3, 5.0 / 3.6, 19, 28, 2,
    '{"short": {"min": 3, "max": 5}, "long": {"min": 10, "max": 15}, "expedition": {"min": 30, "max": 40}}'::jsonb,
    2, 250.0, 7, 3000, 7
$$;

comment on function private.detour_rules() is 'Detour offer thresholds that are not in the economy sheet, in one place.';

create function private.detour_spot_settings(
  out area_zoom int,               -- One vector tile per area, the same tiles as the sites. Changing it invalidates detour_spot_areas.
  out spot_zoom int,               -- At most one spot per tile at this zoom; the tile id is the spot id.
  out sample_spacing_m float8,     -- Spots along a footway or street, this far apart.
  out hazard_buffer_m float8,      -- PLACEHOLDER: no spot this close to a rail line, motorway, or trunk road.
  out refetch_after interval,      -- Areas older than this are fetched again.
  out lease interval,              -- How long one caller owns an area fetch.
  out retry_after interval,        -- Wait after a failed fetch before trying again.
  out max_areas_per_call int       -- Tile downloads per detours call, at most.
)
language sql
immutable
parallel safe
set search_path = ''
as $$
  select 14, 19, 50.0, 20.0, interval '30 days', interval '30 seconds', interval '10 minutes', 4
$$;

comment on function private.detour_spot_settings() is 'Detour spot thresholds, in one place.';

-- What becomes a spot. Keys are "<layer>.<field>" of the OpenMapTiles schema.
-- geom: point (the feature's point), area (a point inside the polygon), or
-- line (points every sample_spacing_m). The lowest priority wins a spot tile.
create function private.detour_spot_rules()
returns table (priority int, kind text, key text, vals text[], geom text, needs_name boolean)
language sql
immutable
parallel safe
set search_path = ''
as $$
  values
    (1, 'place',  'poi.subclass', array['viewpoint', 'artwork', 'monument', 'attraction', 'castle', 'ruins'], 'point', false),
    (2, 'park',   'poi.subclass', array['park'], 'point', true),
    (3, 'square', 'transportation.subclass', array['pedestrian'], 'area', false),
    (4, 'path',   'transportation.subclass', array['footway', 'pedestrian', 'path', 'steps'], 'line', false),
    (5, 'street', 'transportation.class', array['minor'], 'line', false)
$$;

-- A feature with any of these tags never gives a spot: private, closed to
-- walkers, in a tunnel, or indoors.
create function private.detour_blockers()
returns table (key text, vals text[])
language sql
immutable
parallel safe
set search_path = ''
as $$
  values
    ('transportation.access', array['no', 'private']),
    ('transportation.foot', array['no', 'private', 'customers', 'use_sidepath', 'discouraged']),
    ('transportation.brunnel', array['tunnel']),
    ('transportation.indoor', array['1'])
$$;

-- Lines no spot may be near (hazard_buffer_m), unless they run in a tunnel.
create function private.detour_hazards()
returns table (key text, vals text[])
language sql
immutable
parallel safe
set search_path = ''
as $$
  values
    ('transportation.class', array['rail', 'motorway', 'trunk'])
$$;

-- Polygons no spot may be inside: the sites' exclusion zones, playgrounds,
-- and buildings, so a landmark indoors (a museum exhibit, an altar) or a
-- passage through a building never holds an offer. Every building feature
-- has render_height. vals null means any value.
create function private.detour_zones()
returns table (key text, vals text[])
language sql
immutable
parallel safe
set search_path = ''
as $$
  select x.key, x.vals from private.exclude_rules() x where x.is_zone
  union all
  values ('landuse.class', array['playground']), ('building.render_height', null::text[])
$$;

-- The request for one area: the zoom and every key a rule, hazard, or zone can
-- match. The Edge Function forwards the features that match a key, with all
-- their properties and full geometry.
create function private.detour_spot_filter()
returns jsonb
language sql
immutable
parallel safe
set search_path = ''
as $$
  select jsonb_build_object(
    'zoom', s.area_zoom,
    'keys', (
      select jsonb_agg(jsonb_build_object('key', k.key, 'vals', to_jsonb(k.vals)) order by k.key, k.vals)
      from (
        select r.key, r.vals from private.detour_spot_rules() r
        union
        select h.key, h.vals from private.detour_hazards() h
        union
        select z.key, z.vals from private.detour_zones() z
      ) k))
  from private.detour_spot_settings() s
$$;

revoke all on all functions in schema private from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------

create table public.detour_spot_areas (
  area bigint primary key,
  fetched_at timestamptz null,
  lease_until timestamptz null,
  failed_at timestamptz null,
  last_error text null,
  spot_count int not null default 0
);

comment on table public.detour_spot_areas is
  'Vector tile fetch cache for detour spots: one row per area (zoom 14 tile, id = x * 2^14 + y). Written only by the detours Edge Function through service-role RPCs.';

create table public.detour_spots (
  id bigint primary key,
  area bigint not null,
  kind text not null check (kind in ('place', 'park', 'square', 'path', 'street')),
  subtype text null,
  name text null,
  geom extensions.geometry(point, 4326) not null
);

comment on table public.detour_spots is
  'Public, walkable places an offer may sit at. id is the zoom 19 tile of geom (one spot per tile); area is the zoom 14 tile that owns the row.';

create index detour_spots_geom_idx on public.detour_spots using gist (geom);
create index detour_spots_area_idx on public.detour_spots (area);

create table public.route_tiles (
  user_id uuid not null references auth.users (id) on delete cascade,
  tile bigint not null,
  game_day date not null,
  primary key (user_id, tile, game_day)
);

comment on table public.route_tiles is
  'Where a player walked, per game day: zoom 19 tiles of settled, vehicle-free walking. Written by claim_settled; frequent routes for detour offers come from it.';

create index route_tiles_day_idx on public.route_tiles (user_id, game_day);

create table public.detour_days (
  user_id uuid not null references auth.users (id) on delete cascade,
  game_day date not null,
  source text null check (source in ('routes', 'recent', 'land', 'position')),
  generated_at timestamptz not null,
  updated_at timestamptz not null,
  primary key (user_id, game_day)
);

comment on table public.detour_days is
  'One row per player and game day that offers were generated for. source says what the offers were placed around (null: nothing known yet).';

create table public.detour_offers (
  id bigint generated always as identity primary key,
  user_id uuid not null references auth.users (id) on delete cascade,
  game_day date not null,
  slot int not null check (slot >= 1),
  spot_id bigint not null,
  spot_kind text not null,
  spot_subtype text null,
  name text null,
  geom extensions.geometry(point, 4326) not null,
  anchor extensions.geometry(point, 4326) not null,
  band text not null check (band in ('short', 'long', 'expedition')),
  off_route_m numeric(10, 1) not null,
  added_m numeric(10, 1) not null,
  added_min int not null,
  reward_kind text not null check (reward_kind in ('common', 'crystal', 'gem')),
  reward jsonb not null,
  xp numeric(20, 6) not null,
  valid_from timestamptz not null,
  valid_until timestamptz not null,
  created_at timestamptz not null,
  collected_at timestamptz null,
  collected_ref text null,
  unique (user_id, game_day, slot),
  check (valid_from < valid_until)
);

comment on table public.detour_offers is
  'Detour offers. Collectable once, by walking within collect_radius_m between greatest(valid_from, created_at) and valid_until. reward and xp are fixed when offered.';
comment on column public.detour_offers.anchor is
  'The point of the frequent route the added time is measured from.';
comment on column public.detour_offers.collected_ref is
  'The batch id, or close:<session id>, that collected the offer.';

create index detour_offers_open_idx on public.detour_offers (user_id, valid_until) where collected_at is null;
create index detour_offers_spot_idx on public.detour_offers (user_id, spot_id, game_day);

-- The ledger pays detours too, at most once per offer.
alter table public.economy_ledger drop constraint economy_ledger_reason_check;
alter table public.economy_ledger add constraint economy_ledger_reason_check
  check (reason in ('start', 'keep_tax', 'walk', 'terrain', 'build', 'recruit', 'detour'));

comment on column public.economy_ledger.ref is
  'walk: the batch id, or close:<session id>. keep_tax: the last game day paid. terrain: the area. build, recruit: the request id. detour: the offer id.';

create unique index economy_ledger_detour_once_idx on public.economy_ledger (user_id, ref) where reason = 'detour';

revoke all on table public.detour_spot_areas, public.detour_spots, public.route_tiles,
  public.detour_days, public.detour_offers from anon, authenticated;
grant select on table public.route_tiles, public.detour_days, public.detour_offers to authenticated;

alter table public.detour_spot_areas enable row level security;
alter table public.detour_spots enable row level security;
alter table public.route_tiles enable row level security;
alter table public.detour_days enable row level security;
alter table public.detour_offers enable row level security;

create policy "Players can read their own route tiles" on public.route_tiles
for select to authenticated using ((select auth.uid()) = user_id);

create policy "Players can read their own detour days" on public.detour_days
for select to authenticated using ((select auth.uid()) = user_id);

create policy "Players can read their own detour offers" on public.detour_offers
for select to authenticated using ((select auth.uid()) = user_id);

-- Route history from the walks already stored (walk_points keeps 30 days):
-- the end point of every walking segment.
insert into public.route_tiles (user_id, tile, game_day)
select distinct w.user_id,
  private.tile_of(extensions.st_transform(w.geom, 3857), (select route_zoom from private.detour_rules())),
  ((w.recorded_at at time zone coalesce(e.time_zone, 'UTC'))
    - make_interval(hours => (private.economy_rules() ->> 'dailyResetHour')::int))::date
from (
  select p.user_id, p.recorded_at, p.geom,
    private.segment_kind(
      extract(epoch from p.recorded_at - lag(p.recorded_at) over w)::float8,
      extensions.st_distance(lag(p.geom) over w::extensions.geography, p.geom::extensions.geography, false)) as kind
  from public.walk_points p
  window w as (partition by p.user_id, p.session_id order by p.recorded_at)
) w
left join public.player_economy e on e.user_id = w.user_id
where w.kind = 'walk'
on conflict do nothing;

-- ---------------------------------------------------------------------------
-- Spots: the detours Edge Function leases areas, sends their features here.
-- ---------------------------------------------------------------------------

-- Ground meters per EPSG:3857 unit at a Web Mercator y: 1 / cosh(y / R).
create function private.mercator_scale(y float8)
returns float8
language sql
immutable
parallel safe
set search_path = ''
as $$
  select cosh(y / 6378137.0)
$$;

comment on function private.mercator_scale(float8) is 'EPSG:3857 units per ground meter at Web Mercator y.';

-- The area of vector tile polygon rings (a MultiLineString in EPSG:3857): the
-- union of the exterior rings. Exterior rings are clockwise once the tile's
-- downward y is flipped; holes (counterclockwise) are ignored, so a courtyard
-- counts as part of its building. ST_BuildArea fails on the self-touching
-- rings of merged buildings; building each ring on its own doesn't.
create function private.ring_area(p_rings extensions.geometry)
returns extensions.geometry
language sql
immutable
parallel safe
set search_path = ''
as $$
  select extensions.st_union(extensions.st_collectionextract(extensions.st_makevalid(r.poly), 3))
  from (
    select extensions.st_makepolygon(d.geom) as poly
    from extensions.st_dump(p_rings) d
    where extensions.geometrytype(d.geom) = 'LINESTRING'
      and extensions.st_isclosed(d.geom) and extensions.st_npoints(d.geom) >= 4
  ) r
  where extensions.st_ispolygoncw(r.poly)
$$;

-- Builds the spots of one area from its vector tile features, replacing the
-- area's previous spots. Same input, same rows.
--
-- p_data = {features: [{tags: {"<layer>.<field>": value, name, ...},
--                       geometry: GeoJSON Point, or MultiLineString (lines,
--                       or polygon rings for type polygon),
--                       type: "point" | "line" | "polygon"}]}
-- Errors: 22023 for a bad area or payload.
create function public.ingest_detour_area(p_area bigint, p_data jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
set client_min_messages = warning
as $$
declare
  s record;
  v_tile extensions.geometry;
  v_scale float8;
  v_spots int;
begin
  select * into s from private.detour_spot_settings();
  if p_area is null or p_area < 0 or p_area >= (4 ^ s.area_zoom)::bigint then
    raise exception 'invalid area' using errcode = '22023';
  end if;
  if p_data is null or jsonb_typeof(p_data -> 'features') <> 'array' then
    raise exception 'features must be a JSON array' using errcode = '22023';
  end if;

  v_tile := private.tile_envelope(p_area, s.area_zoom);
  v_scale := private.mercator_scale(extensions.st_y(extensions.st_centroid(v_tile)));

  drop table if exists detour_features;
  create temp table detour_features on commit drop as
  with raw as (
    select coalesce(f -> 'tags', '{}'::jsonb) as tags, f ->> 'type' as type, f -> 'geometry' as gj
    from jsonb_array_elements(p_data -> 'features') f
    where jsonb_typeof(f) = 'object'
      and jsonb_typeof(coalesce(f -> 'tags', '{}'::jsonb)) = 'object'
      and f ->> 'type' in ('point', 'line', 'polygon')
      and jsonb_typeof(f -> 'geometry') = 'object'
      and f -> 'geometry' ->> 'type' in ('Point', 'MultiLineString')
  ),
  parsed as (
    select tags, type, extensions.st_transform(extensions.st_setsrid(extensions.st_geomfromgeojson(gj), 4326), 3857) as g
    from raw
  )
  select p.tags, p.type,
    case p.type when 'polygon' then private.ring_area(p.g) else p.g end as g
  from parsed p
  where (p.type = 'point') = (extensions.geometrytype(p.g) = 'POINT');

  delete from public.detour_spots where area = p_area;

  -- Drop features that never give a spot, then build the candidates.
  with zones as (
    select extensions.st_union(f.g) as g
    from detour_features f
    where f.type = 'polygon' and f.g is not null and not extensions.st_isempty(f.g)
      and exists (select 1 from private.detour_zones() z where private.tag_matches(f.tags, z.key, z.vals))
  ),
  hazards as (
    select extensions.st_collect(f.g) as g
    from detour_features f
    where f.type = 'line'
      and exists (select 1 from private.detour_hazards() h where private.tag_matches(f.tags, h.key, h.vals))
      and not private.tag_matches(f.tags, 'transportation.brunnel', array['tunnel'])
  ),
  matched as (
    select f.tags, f.g, r.priority, r.kind, r.geom as how,
      f.tags ->> r.key as subtype
    from detour_features f
    cross join lateral (
      select * from private.detour_spot_rules() r
      where private.tag_matches(f.tags, r.key, r.vals)
        and (not r.needs_name or f.tags ? 'name')
        and r.geom = case f.type when 'polygon' then 'area' else f.type end
      order by r.priority limit 1
    ) r
    where f.g is not null and not extensions.st_isempty(f.g)
      and not exists (select 1 from private.detour_blockers() b where private.tag_matches(f.tags, b.key, b.vals))
  ),
  parts as (
    select m.*, (extensions.st_dump(m.g)).geom as part
    from matched m
    where m.how = 'line'
  ),
  points as (
    select m.priority, m.kind, m.subtype, m.tags ->> 'name' as name, m.g as pt
    from matched m where m.how = 'point'
    union all
    select m.priority, m.kind, m.subtype, m.tags ->> 'name', extensions.st_pointonsurface(m.g)
    from matched m where m.how = 'area'
    union all
    select p.priority, p.kind, p.subtype, null, (extensions.st_dump(
      case when extensions.st_length(p.part) > s.sample_spacing_m * v_scale
        then extensions.st_lineinterpolatepoints(p.part, s.sample_spacing_m * v_scale / extensions.st_length(p.part), true)
        else extensions.st_lineinterpolatepoint(p.part, 0.5)
      end)).geom
    from parts p
    where extensions.st_length(p.part) > 0
  ),
  allowed as (
    select pt.*, private.tile_of(pt.pt, s.spot_zoom) as id
    from points pt
    left join zones z on true
    left join hazards h on true
    where extensions.st_intersects(pt.pt, v_tile)
      and (z.g is null or not extensions.st_intersects(pt.pt, z.g))
      and (h.g is null or not extensions.st_dwithin(pt.pt, h.g, s.hazard_buffer_m * v_scale))
  ),
  chosen as (
    select distinct on (a.id) a.*
    from allowed a
    order by a.id, a.priority, a.name nulls last, extensions.st_x(a.pt), extensions.st_y(a.pt)
  )
  insert into public.detour_spots (id, area, kind, subtype, name, geom)
  select c.id, p_area, c.kind, c.subtype, left(c.name, 200), extensions.st_transform(c.pt, 4326)
  from chosen c;

  get diagnostics v_spots = row_count;

  insert into public.detour_spot_areas as a (area, fetched_at, spot_count)
  values (p_area, now(), v_spots)
  on conflict (area) do update
  set fetched_at = excluded.fetched_at, spot_count = excluded.spot_count,
    lease_until = null, failed_at = null, last_error = null;

  return jsonb_build_object('area', p_area, 'spots', v_spots);
end;
$$;

comment on function public.ingest_detour_area(bigint, jsonb) is
  'Service role only. Replaces the detour spots of an area from its vector tile features.';

create function public.fail_detour_area(p_area bigint, p_error text)
returns void
language sql
security definer
set search_path = ''
as $$
  update public.detour_spot_areas
  set lease_until = null, failed_at = now(), last_error = left(p_error, 500)
  where area = p_area
$$;

comment on function public.fail_detour_area(bigint, text) is
  'Service role only. Releases an area lease after a failed fetch; it is retried after detour_spot_settings().retry_after.';

-- ---------------------------------------------------------------------------
-- Routes and the areas they need
-- ---------------------------------------------------------------------------

-- What a day's offers are placed around, as a multipoint in EPSG:3857, and
-- where it came from, in order:
--   routes:   tiles walked on route_min_days different days in the
--             route_window before p_day (the routes the player walks often).
--   recent:   any tile walked in the window, today included (a new player's
--             first walks).
--   land:     the player's claimed land.
--   position: the point the app sent (a player who never walked).
-- Both are null when nothing is known.
create function private.detour_anchors(
  p_user uuid, p_day date, p_lat float8, p_lng float8,
  out source text, out route extensions.geometry
)
language plpgsql
stable
set search_path = ''
as $$
declare
  d record;
  v_shift int;
begin
  select * into d from private.detour_rules();
  source := null;
  route := null;

  select extensions.st_collect(extensions.st_centroid(private.tile_envelope(t.tile, d.route_zoom)))
  into route
  from (
    select r.tile from public.route_tiles r
    where r.user_id = p_user and r.game_day >= p_day - d.route_window_days and r.game_day < p_day
    group by r.tile
    having count(*) >= d.route_min_days
    order by count(*) desc, r.tile
    limit d.max_anchors
  ) t;
  if route is not null then
    source := 'routes';
    return;
  end if;

  select extensions.st_collect(extensions.st_centroid(private.tile_envelope(t.tile, d.route_zoom)))
  into route
  from (
    select r.tile from public.route_tiles r
    where r.user_id = p_user and r.game_day >= p_day - d.route_window_days and r.game_day <= p_day
    group by r.tile
    order by count(*) desc, max(r.game_day) desc, r.tile
    limit d.max_anchors
  ) t;
  if route is not null then
    source := 'recent';
    return;
  end if;

  v_shift := (select cell_zoom from private.claim_rules()) - d.route_zoom;
  select extensions.st_collect(extensions.st_centroid(private.tile_envelope(t.tile, d.route_zoom)))
  into route
  from (
    select distinct ((c.cell / n) >> v_shift) * (n >> v_shift) + ((c.cell % n) >> v_shift) as tile
    from public.claimed_cells c,
      (select (2 ^ (select cell_zoom from private.claim_rules()))::bigint as n) k
    where c.user_id = p_user
    order by 1
    limit d.max_anchors
  ) t;
  if route is not null then
    source := 'land';
    return;
  end if;

  if p_lat between -85 and 85 and p_lng between -180 and 180 then
    route := extensions.st_transform(extensions.st_setsrid(extensions.st_makepoint(p_lng, p_lat), 4326), 3857);
    source := 'position';
  end if;
end;
$$;

-- The longest straight-line distance from the route an offer can sit at:
-- the expedition band's upper bound, there and back.
create function private.detour_max_off_route_m()
returns float8
language sql
immutable
parallel safe
set search_path = ''
as $$
  select (d.bands -> 'expedition' ->> 'max')::float8 * 60 * d.walk_speed_mps / (2 * d.route_factor)
  from private.detour_rules() d
$$;

-- The spot areas within reach of a route, each with its distance to the
-- nearest route point in ground meters, nearest first.
create function private.detour_route_areas(p_route extensions.geometry)
returns table (area bigint, dist_m float8)
language sql
stable
set search_path = ''
as $$
  with s as (
    select a.area_zoom as z, private.detour_max_off_route_m() as reach,
      private.mercator_scale(extensions.st_y(extensions.st_centroid(p_route))) as k
    from private.detour_spot_settings() a
  ),
  pts as (
    select (extensions.st_dump(p_route)).geom as g
  ),
  near as (
    select distinct private.tile_of(extensions.st_translate(p.g, dx * s.reach * s.k, dy * s.reach * s.k), s.z) as area
    from pts p, s, unnest(array[-1, 0, 1]) dx, unnest(array[-1, 0, 1]) dy
  )
  select n.area, extensions.st_distance(private.tile_envelope(n.area, s.z), p_route) / s.k
  from near n, s
  where extensions.st_dwithin(private.tile_envelope(n.area, s.z), p_route, s.reach * s.k)
  order by 2, 1
$$;

-- Leases up to p_max spot areas within reach of the player's routes (see
-- detour_anchors) that need a fetch, nearest first, and returns each with the
-- request. Areas another caller is fetching come back with request null.
create function public.claim_detour_areas(
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
begin
  select * into s from private.detour_spot_settings();
  select private.game_day(now(), coalesce(e.time_zone, 'UTC')) into v_day
  from (select 1) x left join public.player_economy e on e.user_id = p_user;
  select * into a from private.detour_anchors(p_user, v_day, p_lat, p_lng);
  if a.route is null then
    return;
  end if;

  return query
  with wanted as (
    select w.area as a, w.dist_m from private.detour_route_areas(a.route) w
  ),
  todo as (
    select w.a
    from wanted w
    left join public.detour_spot_areas da on da.area = w.a
    where (da.area is null or da.fetched_at is null or da.fetched_at < now() - s.refetch_after)
      and (da.lease_until is null or da.lease_until < now())
      and (da.failed_at is null or da.failed_at < now() - s.retry_after)
    order by w.dist_m, w.a
    limit least(coalesce(p_max, s.max_areas_per_call), s.max_areas_per_call)
  ),
  leased as (
    insert into public.detour_spot_areas as da (area, lease_until)
    select t.a, now() + s.lease from todo t
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
  where da.lease_until >= now() and not exists (select 1 from leased l where l.area = w.a);
end;
$$;

comment on function public.claim_detour_areas(uuid, float8, float8, int) is
  'Service role only. Leases spot areas within reach of the player''s routes that need a tile fetch and returns {area, request}; request is null for areas another caller is fetching.';

-- ---------------------------------------------------------------------------
-- Generating offers
-- ---------------------------------------------------------------------------

-- Offers a day: the Watchtower's offersPerDay, or offers_without_watchtower
-- before it is built.
create function private.detour_offers_per_day(p_user uuid)
returns int
language sql
stable
set search_path = ''
as $$
  select case when l.level > 0
    then (private.economy_rules() -> 'buildings' -> 'watchtower' -> 'levels' -> (l.level - 1) -> 'effects' ->> 'offersPerDay')::int
    else (select offers_without_watchtower from private.detour_rules())
  end
  from (select private.building_level(p_user, 'watchtower') as level) l
$$;

-- A number in [0, 1) from text, the same for the same text.
create function private.unit_hash(p_text text)
returns float8
language sql
immutable
parallel safe
set search_path = ''
as $$
  select ('x' || substr(md5(p_text), 1, 8))::bit(32)::bigint / 4294967296.0
$$;

-- The day's offers as the app shows them.
create function private.detour_offers_json(p_user uuid, p_day date)
returns jsonb
language sql
stable
set search_path = ''
as $$
  select coalesce(jsonb_agg(jsonb_build_object(
    'id', o.id,
    'slot', o.slot,
    'lat', round(extensions.st_y(o.geom)::numeric, 7),
    'lng', round(extensions.st_x(o.geom)::numeric, 7),
    'anchor', jsonb_build_object('lat', round(extensions.st_y(o.anchor)::numeric, 7),
                                 'lng', round(extensions.st_x(o.anchor)::numeric, 7)),
    'name', o.name,
    'spotKind', o.spot_kind,
    'spotSubtype', o.spot_subtype,
    'band', o.band,
    'offRouteM', o.off_route_m,
    'addedM', o.added_m,
    'addedMin', o.added_min,
    'rewardKind', o.reward_kind,
    'reward', o.reward,
    'xp', o.xp,
    'validFrom', o.valid_from,
    'validUntil', o.valid_until,
    'collectedAt', o.collected_at
  ) order by o.slot), '[]'::jsonb)
  from public.detour_offers o
  where o.user_id = p_user and o.game_day = p_day
$$;

-- Fills the empty offer slots of the player's current game day at p_at and
-- returns {gameDay, source, added, missingAreas}. Offers already made never
-- change. p_lat and p_lng, when given, are the app's position, used only when
-- the player has no walks and no land (detour_anchors).
--
-- Slot n's band: the last slot of a Saturday or Sunday is an expedition, odd
-- slots are short, even slots long. Each slot takes the best spot whose added
-- time fits the band, at least offer_spacing_m from the day's other offers and
-- not offered to the player in the last repeat_after_days days: landmarks,
-- then parks, squares, footways, and streets, in a fixed order per player and
-- day. If no spot fits while areas within reach still lack spots, the slot
-- waits for them; once every area is known, it takes the nearest fit from any
-- band. The reward kind comes from rules.detours shares (gem, then crystal,
-- else common; the Tavern's gemOfferShare replaces the gem share).
create function private.generate_detour_offers(
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
    select m.*, 2 * d.route_factor * m.off_m as added_m,
      round(2 * d.route_factor * m.off_m / d.walk_speed_mps / 60)::int as added_min
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

-- The scheduled job: generates the day's offers for every player who walked
-- in the last active_days days and has none for their current game day yet,
-- and drops route tiles older than the route window. One player's error
-- doesn't stop the others. Returns the number of players generated for.
create function private.generate_due_detour_offers(p_at timestamptz default now())
returns int
language plpgsql
set search_path = ''
as $$
declare
  d record;
  u record;
  v_n int := 0;
begin
  select * into d from private.detour_rules();

  delete from public.route_tiles
  where game_day < (p_at at time zone 'UTC')::date - d.route_window_days - 2;

  for u in
    select e.user_id
    from public.player_economy e
    where exists (
        select 1 from public.route_tiles r
        where r.user_id = e.user_id and r.game_day >= private.game_day(p_at, e.time_zone) - d.active_days)
      and not exists (
        select 1 from public.detour_days x
        where x.user_id = e.user_id and x.game_day >= private.game_day(p_at, e.time_zone))
    order by e.user_id
  loop
    begin
      perform private.generate_detour_offers(u.user_id, p_at);
      v_n := v_n + 1;
    exception when others then
      raise warning 'detour offers for %: %', u.user_id, sqlerrm;
    end;
  end loop;
  return v_n;
end;
$$;

comment on function private.generate_due_detour_offers(timestamptz) is
  'Scheduled every 15 minutes: generates today''s detour offers for recently active players who have none yet.';

-- ---------------------------------------------------------------------------
-- Claiming, now with route history and detour collection. Same claim and pay
-- rules as *_economy.sql.
-- ---------------------------------------------------------------------------

drop function private.claim_settled(uuid, text, timestamptz, timestamptz, text);

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
create function private.claim_settled(
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
    -- Points around the range, so every candidate sees its true neighbors: a
    -- neighbor further than max_gap_s away is a gap whether it's loaded or not.
    select recorded_at, geom,
      lag(recorded_at) over w as prev_t,
      lag(geom) over w as prev_geom,
      extensions.st_distance(lag(geom) over w::extensions.geography, geom::extensions.geography, false) as dist_m,
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
    'duplicate', false,
    'reward', v_reward,
    'detours', v_detours);
end;
$$;

comment on function public.submit_location_batch(text, text, jsonb) is
  'Reports one batch of GPS points from a tracking session, pays for the walking it settles, and collects detour offers. Idempotent per batch id. Returns {acceptedPoints, rejectedPoints, newCells, totalCells, duplicate, reward, detours}.';

-- Same contract as *_economy.sql, plus detours: the offers closing collected.
create or replace function public.close_walk_session(p_session_id text)
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
  v_reward jsonb;
  v_detours jsonb;
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
      select c.new_cells, c.reward, c.detours into v_new_cells, v_reward, v_detours
      from private.claim_settled(
        v_user, p_session_id, v_last - make_interval(secs => r.vehicle_buffer_s), v_last,
        'close:' || p_session_id) c;
      update public.walk_sessions
      set new_cells = new_cells + v_new_cells
      where user_id = v_user and session_id = p_session_id;
    end if;
  end if;

  select count(*) into v_total from public.claimed_cells where user_id = v_user;

  return jsonb_build_object('newCells', v_new_cells, 'totalCells', v_total, 'closed', v_closed,
    'reward', v_reward, 'detours', v_detours);
end;
$$;

comment on function public.close_walk_session(text) is
  'Marks a tracking session finished, claims its last, now settled segments, pays for them, and collects detour offers. Idempotent. Returns {newCells, totalCells, closed, reward, detours}.';

-- ---------------------------------------------------------------------------
-- API
-- ---------------------------------------------------------------------------

-- Returns the caller's offers for the current game day, after storing their
-- time zone (when given, like get_economy) and filling any empty offer slots.
-- p_lat and p_lng are the app's position, used only for a player with no
-- walks and no land. Returns {gameDay, source, offers, offersPerDay,
-- missingAreas, validFrom, validUntil, timeZoneAccepted}. missingAreas counts
-- spot areas within reach that the detours function hasn't loaded yet.
-- Errors: 42501 when not signed in.
create function public.get_detour_offers(
  p_time_zone text default null, p_lat float8 default null, p_lng float8 default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user uuid := auth.uid();
  v_tz_ok boolean;
  v_gen jsonb;
begin
  if v_user is null then
    raise exception 'Not signed in' using errcode = '42501';
  end if;
  v_tz_ok := private.set_time_zone(v_user, p_time_zone, now());
  v_gen := private.generate_detour_offers(v_user, now(), p_lat, p_lng);
  return jsonb_build_object(
    'gameDay', v_gen -> 'gameDay',
    'source', v_gen -> 'source',
    'offers', private.detour_offers_json(v_user, (v_gen ->> 'gameDay')::date),
    'offersPerDay', private.detour_offers_per_day(v_user),
    'missingAreas', v_gen -> 'missingAreas',
    'validFrom', v_gen -> 'validFrom',
    'validUntil', v_gen -> 'validUntil',
    'timeZoneAccepted', v_tz_ok);
end;
$$;

comment on function public.get_detour_offers(text, float8, float8) is
  'Fills and returns the caller''s detour offers for the current game day: {gameDay, source, offers, offersPerDay, missingAreas, validFrom, validUntil, timeZoneAccepted}.';

-- Function privileges.
revoke all on all functions in schema private from public, anon, authenticated;
revoke all on function public.get_detour_offers(text, float8, float8) from public, anon;
revoke all on function public.claim_detour_areas(uuid, float8, float8, int) from public, anon, authenticated;
revoke all on function public.ingest_detour_area(bigint, jsonb) from public, anon, authenticated;
revoke all on function public.fail_detour_area(bigint, text) from public, anon, authenticated;
grant execute on function public.get_detour_offers(text, float8, float8) to authenticated;
grant execute on function public.claim_detour_areas(uuid, float8, float8, int) to service_role;
grant execute on function public.ingest_detour_area(bigint, jsonb) to service_role;
grant execute on function public.fail_detour_area(bigint, text) to service_role;

-- ---------------------------------------------------------------------------
-- Schedule: every 15 minutes, so a player's offers exist soon after 4 a.m.
-- in any time zone (including those 30 or 45 minutes off the hour), even if
-- they walk before opening the app.
-- ---------------------------------------------------------------------------

create extension if not exists pg_cron;

select cron.schedule('detour-offers', '*/15 * * * *', $$select private.generate_due_detour_offers(now())$$);
