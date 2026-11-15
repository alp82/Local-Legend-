-- Sites: places worth knowing (place cards later) and mine sites, shown as map
-- overlays on and near the player's land.
--
-- Data comes from OpenStreetMap through the Overpass API. Postgres can't call
-- HTTP, so the `sites` Edge Function does the fetching:
--
--   1. claim_site_areas(user, bbox) leases the areas (zoom 14 tiles) near the
--      player's land that have never been fetched or are older than 30 days,
--      and returns the Overpass query for each one.
--   2. The function runs each query and passes the raw elements to
--      ingest_site_area(area, data), which filters and classifies them,
--      derives mine sites, and replaces the area's rows in public.sites.
--   3. get_sites(bbox) returns the caller's visible sites.
--
-- Every include, exclude, and threshold rule lives in the Rules section below,
-- including the Overpass query text, so the Edge Function holds no game rules.
-- Clients can't read or write the tables; they only call get_sites.

create schema if not exists private;

-- ---------------------------------------------------------------------------
-- Rules
-- ---------------------------------------------------------------------------

create function private.site_rules(
  out area_zoom int,                       -- Fetch and cache unit. Changing it invalidates site_areas.
  out grid_zoom int,                       -- Sub-grid for mine density: (2^(grid - area))^2 cells per area.
  out refetch_after interval,              -- Areas older than this are fetched again.
  out lease interval,                      -- How long one caller owns an area fetch.
  out retry_after interval,                -- Wait after a failed fetch before trying again.
  out max_areas_per_call int,              -- Overpass requests per get-sites call, at most.
  out max_bbox_deg float8,                 -- Larger boxes are refused with 22023.
  out silhouette_m float8,                 -- Sites this close to claimed land show as silhouettes.
  out max_sites int,                       -- Rows returned by get_sites, at most.
  out park_min_m2 float8,                  -- Smaller parks don't become place sites.
  out sawmill_min_m2 float8,               -- Green area inside the tile needed for a sawmill.
  out max_sawmills int,                    -- Per area.
  out quarry_min_buildings_per_ha float8,  -- Building density of a grid cell needed for a quarry.
  out max_quarries int,                    -- Per area.
  out gold_min_score int,                  -- Notability score of a grid cell needed for a gold mine.
  out max_gold_mines int,                  -- Per area.
  out mine_spacing_m float8,               -- Minimum distance between two mines.
  out kept_tags text[]                     -- OSM tags copied to sites.tags.
)
language sql
immutable
parallel safe
set search_path = ''
as $$
  select 14, 17, interval '30 days', interval '90 seconds', interval '10 minutes', 4, 0.25,
    150.0, 2000, 5000.0, 5000.0, 2, 20.0, 2, 8, 1, 150.0,
    array['name', 'name:en', 'tourism', 'historic', 'amenity', 'leisure', 'highway',
          'artwork_type', 'artist_name', 'start_date', 'wikipedia', 'wikidata', 'heritage']
$$;

comment on function private.site_rules() is 'Site thresholds, in one place.';

-- What becomes a place site. The first matching rule (lowest priority) wins.
-- vals null means any value. notability feeds the gold mine score.
create function private.place_rules()
returns table (priority int, subtype text, key text, vals text[], needs_name boolean, needs_polygon boolean, notability int)
language sql
immutable
parallel safe
set search_path = ''
as $$
  values
    (1,  'viewpoint',  'tourism',  array['viewpoint'], false, false, 1),
    (2,  'castle',     'historic', array['castle'], false, false, 2),
    (3,  'ruins',      'historic', array['ruins'], false, false, 1),
    (4,  'monument',   'historic', array['monument'], false, false, 1),
    (5,  'historic',   'historic', array['building', 'manor', 'palace', 'city_gate', 'tower', 'fort', 'archaeological_site'], false, false, 1),
    (6,  'artwork',    'tourism',  array['artwork'], false, false, 1),
    (7,  'museum',     'tourism',  array['museum'], false, false, 2),
    (8,  'attraction', 'tourism',  array['attraction'], false, false, 2),
    (9,  'fountain',   'amenity',  array['fountain'], false, false, 0),
    (10, 'cafe',       'amenity',  array['cafe'], false, false, 0),
    (11, 'steps',      'highway',  array['steps'], true, false, 0),
    (12, 'park',       'leisure',  array['park'], true, true, 0)
$$;

-- Green areas that can hold a sawmill. Fetched with full geometry.
create function private.green_rules()
returns table (key text, vals text[])
language sql
immutable
parallel safe
set search_path = ''
as $$
  values
    ('leisure', array['park', 'garden', 'nature_reserve']),
    ('landuse', array['forest', 'recreation_ground']),
    ('natural', array['wood'])
$$;

-- Never a site: public open space only. An element matching any rule is
-- dropped. vals null means any value; except_vals are allowed values of the
-- key. A polygon matching an is_zone rule also drops every site inside it,
-- so a fountain in a cemetery or a statue in a schoolyard never shows.
create function private.exclude_rules()
returns table (key text, vals text[], except_vals text[], is_zone boolean)
language sql
immutable
parallel safe
set search_path = ''
as $$
  values
    ('amenity', array['place_of_worship', 'grave_yard', 'school', 'hospital', 'kindergarten',
       'university', 'college', 'clinic', 'childcare', 'monastery', 'crematorium',
       'funeral_hall', 'prison'], null::text[], true),
    ('landuse', array['cemetery', 'religious', 'military', 'railway', 'education'], null, true),
    ('building', array['church', 'chapel', 'cathedral', 'mosque', 'synagogue', 'temple',
       'shrine', 'religious', 'monastery', 'school', 'hospital', 'kindergarten',
       'university', 'college'], null, true),
    ('historic', array['memorial', 'wayside_cross', 'wayside_shrine', 'tomb', 'grave',
       'church', 'monastery'], null, false),
    ('memorial', null, null, false),
    ('religion', null, null, false),
    ('healthcare', null, null, false),
    ('military', null, null, false),
    ('railway', null, null, false),
    ('access', array['private', 'no'], null, false),
    ('highway', null, array['steps', 'footway', 'path', 'pedestrian'], false)
$$;

create function private.tag_matches(tags jsonb, k text, vals text[], except_vals text[] default null)
returns boolean
language sql
immutable
parallel safe
set search_path = ''
as $$
  select coalesce(tags ? k
    and (vals is null or (tags ->> k) = any (vals))
    and (except_vals is null or not ((tags ->> k) = any (except_vals))), false)
$$;

create function private.is_excluded(tags jsonb)
returns boolean
language sql
immutable
parallel safe
set search_path = ''
as $$
  select exists (
    select 1 from private.exclude_rules() r
    where private.tag_matches(tags, r.key, r.vals, r.except_vals))
$$;

create function private.is_zone(tags jsonb)
returns boolean
language sql
immutable
parallel safe
set search_path = ''
as $$
  select exists (
    select 1 from private.exclude_rules() r
    where r.is_zone and private.tag_matches(tags, r.key, r.vals))
$$;

create function private.is_green(tags jsonb)
returns boolean
language sql
immutable
parallel safe
set search_path = ''
as $$
  select exists (select 1 from private.green_rules() r where private.tag_matches(tags, r.key, r.vals))
$$;

-- The place rule an element matches, or nothing. Excluded elements match nothing.
create function private.place_rule(tags jsonb, has_polygon boolean)
returns table (subtype text, notability int)
language sql
immutable
parallel safe
set search_path = ''
as $$
  select r.subtype, r.notability
  from private.place_rules() r
  where private.tag_matches(tags, r.key, r.vals)
    and (not r.needs_name or tags ? 'name')
    and (not r.needs_polygon or has_polygon)
    and not private.is_excluded(tags)
  order by r.priority
  limit 1
$$;

-- ---------------------------------------------------------------------------
-- Grid helpers. Areas are Web Mercator tiles at area_zoom, id = x * 2^z + y,
-- aligned with the zoom 21 claim cells (an area holds 2^(21 - z) cells per side).
-- ---------------------------------------------------------------------------

create function private.tile_envelope(id bigint, z int)
returns extensions.geometry
language sql
immutable
strict
parallel safe
set search_path = ''
as $$
  select extensions.st_makeenvelope(
    -20037508.342789244 + (id / n) * s,
    20037508.342789244 - ((id % n) + 1) * s,
    -20037508.342789244 + ((id / n) + 1) * s,
    20037508.342789244 - (id % n) * s,
    3857)
  from (select 2 * 20037508.342789244 / (2 ^ z) as s, (2 ^ z)::bigint as n) k
$$;

-- Tile id at zoom z of a point in EPSG:3857.
create function private.tile_of(g extensions.geometry, z int)
returns bigint
language sql
immutable
strict
parallel safe
set search_path = ''
as $$
  select least(greatest(floor((extensions.st_x(g) + 20037508.342789244) / s), 0), n - 1)::bigint * n
       + least(greatest(floor((20037508.342789244 - extensions.st_y(g)) / s), 0), n - 1)::bigint
  from (select 2 * 20037508.342789244 / (2 ^ z) as s, (2 ^ z)::bigint as n) k
$$;

-- Grid cell i (row-major from the north-west corner) of an area, at grid_zoom.
create function private.area_grid_envelope(area bigint, i int)
returns extensions.geometry
language sql
immutable
strict
parallel safe
set search_path = ''
as $$
  select private.tile_envelope(
    ((area / n) * m + i % m) * (n * m) + (area % n) * m + i / m,
    r.grid_zoom)
  from private.site_rules() r,
    lateral (select (2 ^ r.area_zoom)::bigint as n, (2 ^ (r.grid_zoom - r.area_zoom))::int as m) k
$$;

-- Bounding box text "south,west,north,east" for Overpass.
create function private.overpass_bbox(env extensions.geometry)
returns text
language sql
immutable
strict
parallel safe
set search_path = ''
as $$
  select format('%s,%s,%s,%s',
    round(extensions.st_ymin(b)::numeric, 7), round(extensions.st_xmin(b)::numeric, 7),
    round(extensions.st_ymax(b)::numeric, 7), round(extensions.st_xmax(b)::numeric, 7))
  from (select extensions.st_transform(env, 4326)::extensions.box2d as b) t
$$;

create function private.overpass_filter(k text, vals text[])
returns text
language sql
immutable
parallel safe
set search_path = ''
as $$
  select case
    when vals is null then format('[%s]', to_json(k))
    when cardinality(vals) = 1 then format('[%s=%s]', to_json(k), to_json(vals[1]))
    else format('[%s~%s]', to_json(k), to_json('^(' || array_to_string(vals, '|') || ')$'))
  end
$$;

-- The Overpass query for one area. Output order, which the Edge Function and
-- ingest_site_area rely on: place candidates (tags and center), green areas
-- and exclusion zones (full geometry), then one building count per grid cell
-- in row-major order.
create function private.overpass_query(area bigint)
returns text
language sql
immutable
strict
parallel safe
set search_path = ''
as $$
  select format('[out:json][timeout:25][bbox:%s];', private.overpass_bbox(private.tile_envelope(area, r.area_zoom)))
    || '(' || (
      select string_agg(format('nwr%s%s;', private.overpass_filter(p.key, p.vals),
               case when p.needs_name then '["name"]' else '' end), '' order by p.priority)
      from private.place_rules() p where not p.needs_polygon
    ) || ')->.p;.p out tags center qt;'
    || '(' || (
      select string_agg(format('wr%s;', private.overpass_filter(g.key, g.vals)), '')
      from private.green_rules() g
    ) || ')->.g;.g out geom qt;'
    || '(' || (
      select string_agg(format('wr%s;', private.overpass_filter(x.key, x.vals)), '')
      from private.exclude_rules() x where x.is_zone
    ) || ')->.z;.z out geom qt;'
    || (
      select string_agg(format('way["building"](%s);out count;',
               private.overpass_bbox(private.area_grid_envelope(area, i))), '' order by i)
      from generate_series(0, (4 ^ (r.grid_zoom - r.area_zoom))::int - 1) as i
    )
  from private.site_rules() r
$$;

revoke all on all functions in schema private from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------

create table public.site_areas (
  area bigint primary key,
  fetched_at timestamptz null,
  lease_until timestamptz null,
  failed_at timestamptz null,
  fail_count int not null default 0,
  last_error text null,
  place_count int not null default 0,
  mine_count int not null default 0
);

comment on table public.site_areas is
  'Overpass fetch cache: one row per area (zoom 14 tile, id = x * 2^14 + y). Written only by the sites Edge Function through service-role RPCs.';

create table public.sites (
  id text primary key,
  kind text not null check (kind in ('place', 'mine')),
  subtype text not null,
  name text null,
  geom extensions.geometry(point, 4326) not null,
  cell bigint not null,
  area bigint not null,
  tags jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

comment on table public.sites is
  'Shared map sites. id is "osm:<type>/<id>" for places and "mine:<subtype>:<area>:<key>" for derived mines. cell is the zoom 21 claim cell of geom; area is the zoom 14 tile that owns the row.';

create index sites_geom_idx on public.sites using gist (geom);
create index sites_area_idx on public.sites (area);

revoke all on table public.sites, public.site_areas from anon, authenticated;

alter table public.sites enable row level security;
alter table public.site_areas enable row level security;
-- No policies: clients read sites only through get_sites, which hides sites
-- deep in the Mist.

-- ---------------------------------------------------------------------------
-- Ingestion (service role only)
-- ---------------------------------------------------------------------------

create function private.check_bbox(west float8, south float8, east float8, north float8)
returns extensions.geometry
language plpgsql
immutable
set search_path = ''
as $$
declare
  r record;
begin
  select * into r from private.site_rules();
  if west is null or south is null or east is null or north is null
    or west < -180 or east > 180 or south < -85 or north > 85
    or west >= east or south >= north then
    raise exception 'invalid bbox' using errcode = '22023';
  end if;
  if east - west > r.max_bbox_deg or north - south > r.max_bbox_deg then
    raise exception 'bbox too large (max % degrees per side)', r.max_bbox_deg using errcode = '22023';
  end if;
  return extensions.st_makeenvelope(west, south, east, north, 4326);
end;
$$;

revoke all on function private.check_bbox(float8, float8, float8, float8) from public, anon, authenticated;

-- Leases up to p_max areas in the box that lie within silhouette range of the
-- player's land and need a fetch, nearest to the box center first. Returns
-- each area with its Overpass query. A leased area isn't handed to another
-- caller until the lease ends; areas another caller is fetching are returned
-- with a null query, so the caller can report them as pending.
create function public.claim_site_areas(
  p_user uuid, west float8, south float8, east float8, north float8, p_max int default null
)
returns table (area bigint, query text)
language plpgsql
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  r record;
  v_box extensions.geometry;
  v_box3857 extensions.geometry;
  v_center extensions.geometry;
  v_s21 float8;
  v_k int;
  v_shift int;
  v_n21 bigint;
  v_nz bigint;
begin
  select * into r from private.site_rules();
  v_box := private.check_bbox(west, south, east, north);
  v_box3857 := extensions.st_transform(v_box, 3857);
  v_center := extensions.st_centroid(v_box3857);
  v_s21 := private.cell_size_3857();
  v_n21 := (2 ^ (select cell_zoom from private.claim_rules()))::bigint;
  v_nz := (2 ^ r.area_zoom)::bigint;
  v_shift := (select cell_zoom from private.claim_rules()) - r.area_zoom;
  -- Silhouette range in cells, at the box edge farthest from the equator.
  v_k := ceil(r.silhouette_m
    * cosh(greatest(abs(extensions.st_ymin(v_box3857)), abs(extensions.st_ymax(v_box3857))) / 6378137.0)
    / v_s21)::int;

  return query
  with box_tiles as (
    select private.tile_of(extensions.st_point(extensions.st_xmin(v_box3857), extensions.st_ymax(v_box3857), 3857), r.area_zoom) as nw,
           private.tile_of(extensions.st_point(extensions.st_xmax(v_box3857), extensions.st_ymin(v_box3857), 3857), r.area_zoom) as se
  ),
  cells as (
    select c.cell / v_n21 as x, c.cell % v_n21 as y
    from public.claimed_cells c
    where c.user_id = p_user
  ),
  near as (
    select distinct ((c.x + dx) >> v_shift) as tx, ((c.y + dy) >> v_shift) as ty
    from cells c,
      unnest(array[-v_k, 0, v_k]) as dx,
      unnest(array[-v_k, 0, v_k]) as dy
  ),
  wanted as (
    select n.tx * v_nz + n.ty as a
    from near n, box_tiles b
    where n.tx between b.nw / v_nz and b.se / v_nz
      and n.ty between b.nw % v_nz and b.se % v_nz
  ),
  todo as (
    select w.a
    from wanted w
    left join public.site_areas sa on sa.area = w.a
    where (sa.area is null or sa.fetched_at is null or sa.fetched_at < now() - r.refetch_after)
      and (sa.lease_until is null or sa.lease_until < now())
      and (sa.failed_at is null or sa.failed_at < now() - r.retry_after)
    order by extensions.st_distance(extensions.st_centroid(private.tile_envelope(w.a, r.area_zoom)), v_center), w.a
    limit least(coalesce(p_max, r.max_areas_per_call), r.max_areas_per_call)
  ),
  leased as (
    insert into public.site_areas as sa (area, lease_until)
    select t.a, now() + r.lease from todo t
    on conflict on constraint site_areas_pkey do update
      set lease_until = excluded.lease_until
      where sa.lease_until is null or sa.lease_until < now()
    returning sa.area
  )
  select l.area, private.overpass_query(l.area) from leased l
  union all
  -- Areas another request is fetching right now.
  select w.a, null::text
  from wanted w
  join public.site_areas sa on sa.area = w.a
  where sa.lease_until >= now();
end;
$$;

comment on function public.claim_site_areas(uuid, float8, float8, float8, float8, int) is
  'Service role only. Leases areas near the player''s land that need an Overpass fetch and returns {area, query}; query is null for areas another caller is fetching.';

-- Marks a leased area as failed so it is retried after retry_after.
create function public.fail_site_area(p_area bigint, p_error text)
returns void
language sql
security definer
set search_path = ''
as $$
  update public.site_areas
  set failed_at = now(), lease_until = null, fail_count = fail_count + 1, last_error = left(p_error, 500)
  where area = p_area
$$;

comment on function public.fail_site_area(bigint, text) is 'Service role only. Records a failed fetch.';

-- Replaces the sites of one area from an Overpass response.
--
-- p_data = {
--   elements: [{id: "node/1" | "way/2" | "relation/3", tags: {...},
--               lat, lon (node position or way center, optional),
--               geometry (optional GeoJSON MultiLineString of the outline)}],
--   building_counts: [one integer per grid cell, row-major from the north-west]
-- }
--
-- Places: elements matching a place rule, not excluded, whose point lies in
-- this area and outside every exclusion zone. Mines, in this order, each at
-- least mine_spacing_m from the others and outside exclusion zones:
--   gold_mine: grid cells whose places score at least gold_min_score, at the
--     centroid of their notable places.
--   sawmill: green polygons with at least sawmill_min_m2 inside the area, at a
--     point on that part of the polygon. Largest first.
--   quarry: grid cells with at least quarry_min_buildings_per_ha buildings,
--     at the cell center. Densest first.
-- The same input always gives the same rows.
create function public.ingest_site_area(p_area bigint, p_data jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
set client_min_messages = warning
as $$
declare
  r record;
  v_tile extensions.geometry;
  v_cells int;
  v_places int;
  v_mines int := 0;
  v_counts jsonb := p_data -> 'building_counts';
  c record;
  v_chosen extensions.geometry[] := array[]::extensions.geometry[];
  v_taken jsonb := '{}'::jsonb;
begin
  select * into r from private.site_rules();
  v_cells := (4 ^ (r.grid_zoom - r.area_zoom))::int;

  if p_area is null or p_area < 0 or p_area >= (4 ^ r.area_zoom)::bigint then
    raise exception 'invalid area' using errcode = '22023';
  end if;
  if p_data is null or jsonb_typeof(p_data -> 'elements') <> 'array' then
    raise exception 'elements must be a JSON array' using errcode = '22023';
  end if;
  if v_counts is not null and (jsonb_typeof(v_counts) <> 'array' or jsonb_array_length(v_counts) <> v_cells) then
    raise exception 'building_counts must have % entries', v_cells using errcode = '22023';
  end if;

  v_tile := private.tile_envelope(p_area, r.area_zoom);

  drop table if exists site_elements;
  create temp table site_elements on commit drop as
  with raw as (
    select e ->> 'id' as osm_id,
      coalesce(e -> 'tags', '{}'::jsonb) as tags,
      case when jsonb_typeof(e -> 'lat') = 'number' and jsonb_typeof(e -> 'lon') = 'number'
        then extensions.st_setsrid(extensions.st_makepoint((e ->> 'lon')::float8, (e ->> 'lat')::float8), 4326)
      end as pt,
      case when jsonb_typeof(e -> 'geometry') = 'object' then e -> 'geometry' end as gj
    from jsonb_array_elements(p_data -> 'elements') as e
    where (e ->> 'id') ~ '^(node|way|relation)/[0-9]+$'
      and jsonb_typeof(coalesce(e -> 'tags', '{}'::jsonb)) = 'object'
  ),
  built as (
    select osm_id, tags, pt,
      (select extensions.st_collectionextract(extensions.st_makevalid(a), 3)
       from (select extensions.st_buildarea(extensions.st_setsrid(extensions.st_geomfromgeojson(gj), 4326)) as a) b
       where a is not null) as poly
    from raw
  )
  select distinct on (osm_id) osm_id, tags,
    extensions.st_transform(case when poly is not null and not extensions.st_isempty(poly) then poly end, 3857) as poly,
    extensions.st_transform(pt, 3857) as pt
  from built
  order by osm_id, (poly is not null) desc;

  drop table if exists site_zones;
  create temp table site_zones on commit drop as
  select poly from pg_temp.site_elements
  where poly is not null and private.is_zone(tags);

  drop table if exists site_new;
  create temp table site_new (
    id text primary key, kind text, subtype text, name text, geom extensions.geometry, tags jsonb, notability int
  ) on commit drop;

  -- Places.
  insert into pg_temp.site_new
  select 'osm:' || e.osm_id, 'place', pr.subtype, e.tags ->> 'name', p.g,
    (select coalesce(jsonb_object_agg(k, e.tags -> k), '{}'::jsonb) from unnest(r.kept_tags) k where e.tags ? k),
    pr.notability
      + case when e.tags ?| array['wikipedia', 'wikidata', 'heritage'] and pr.notability > 0 then 1 else 0 end
  from pg_temp.site_elements e
  cross join lateral (
    select case when e.poly is not null then extensions.st_pointonsurface(e.poly) else e.pt end as g
  ) p
  cross join lateral private.place_rule(e.tags, e.poly is not null
    and extensions.st_area(extensions.st_transform(e.poly, 4326)::extensions.geography) >= r.park_min_m2) pr
  where p.g is not null
    and private.tile_of(p.g, r.area_zoom) = p_area
    and not exists (select 1 from pg_temp.site_zones z where extensions.st_intersects(z.poly, p.g));

  get diagnostics v_places = row_count;

  -- Mines. Candidates in selection order; each must keep its distance.
  for c in
    with grid as (
      select i, private.area_grid_envelope(p_area, i) as env
      from generate_series(0, v_cells - 1) as i
    ),
    gold as (
      select 'gold_mine'::text as subtype, 1 as stage, private.tile_of(n.geom, r.grid_zoom)::text as key,
        null::text as name,
        extensions.st_centroid(extensions.st_collect(n.geom order by n.id)) as g,
        sum(n.notability)::float8 as score
      from pg_temp.site_new n
      where n.notability > 0
      group by private.tile_of(n.geom, r.grid_zoom)
      having sum(n.notability) >= r.gold_min_score
    ),
    green as (
      select 'sawmill'::text as subtype, 2 as stage, e.osm_id as key, e.tags ->> 'name' as name,
        extensions.st_intersection(e.poly, v_tile) as part
      from pg_temp.site_elements e
      where e.poly is not null and private.is_green(e.tags) and not private.is_excluded(e.tags)
        and extensions.st_intersects(e.poly, v_tile)
    ),
    saw as (
      select subtype, stage, key, name, extensions.st_pointonsurface(part) as g,
        extensions.st_area(extensions.st_transform(part, 4326)::extensions.geography) as score
      from green
      where not extensions.st_isempty(part)
    ),
    quarry as (
      select 'quarry'::text as subtype, 3 as stage,
        private.tile_of(extensions.st_centroid(g.env), r.grid_zoom)::text as key, null::text as name,
        extensions.st_centroid(g.env) as g,
        (v_counts ->> g.i)::float8
          / (extensions.st_area(extensions.st_transform(g.env, 4326)::extensions.geography) / 10000.0) as score
      from grid g
      where v_counts is not null and jsonb_typeof(v_counts -> g.i) = 'number'
    )
    select * from gold
    union all select * from saw where score >= r.sawmill_min_m2
    union all select * from quarry where score >= r.quarry_min_buildings_per_ha
    order by stage, score desc, key
  loop
    continue when coalesce((v_taken ->> c.subtype)::int, 0) >=
      case c.subtype when 'gold_mine' then r.max_gold_mines when 'sawmill' then r.max_sawmills else r.max_quarries end;
    continue when exists (select 1 from pg_temp.site_zones z where extensions.st_intersects(z.poly, c.g));
    continue when exists (
      select 1 from unnest(v_chosen) m
      where extensions.st_distance(extensions.st_transform(m, 4326)::extensions.geography,
                                   extensions.st_transform(c.g, 4326)::extensions.geography) < r.mine_spacing_m);

    insert into pg_temp.site_new
    values ('mine:' || c.subtype || ':' || p_area || ':' || c.key, 'mine', c.subtype, c.name, c.g, '{}'::jsonb, 0);
    v_chosen := v_chosen || c.g;
    v_taken := jsonb_set(v_taken, array[c.subtype], to_jsonb(coalesce((v_taken ->> c.subtype)::int, 0) + 1));
    v_mines := v_mines + 1;
  end loop;

  delete from public.sites where area = p_area;

  insert into public.sites (id, kind, subtype, name, geom, cell, area, tags, updated_at)
  select n.id, n.kind, n.subtype, n.name, extensions.st_transform(n.geom, 4326),
    private.tile_of(n.geom, (select cell_zoom from private.claim_rules())), p_area, n.tags, now()
  from pg_temp.site_new n
  on conflict (id) do update
    set kind = excluded.kind, subtype = excluded.subtype, name = excluded.name, geom = excluded.geom,
      cell = excluded.cell, area = excluded.area, tags = excluded.tags, updated_at = excluded.updated_at;

  insert into public.site_areas as sa (area, fetched_at, place_count, mine_count)
  values (p_area, now(), v_places, v_mines)
  on conflict on constraint site_areas_pkey do update
    set fetched_at = now(), lease_until = null, failed_at = null, last_error = null,
      place_count = v_places, mine_count = v_mines;

  return jsonb_build_object('places', v_places, 'mines', v_mines);
end;
$$;

comment on function public.ingest_site_area(bigint, jsonb) is
  'Service role only. Replaces one area''s sites from Overpass elements. Returns {places, mines}.';

-- ---------------------------------------------------------------------------
-- Read
-- ---------------------------------------------------------------------------

-- The caller's visible sites in the box:
--   owned: the site's claim cell is claimed by the caller.
--   silhouette: a claimed cell's center lies within silhouette_m of the site.
--     The name is withheld.
-- Other sites are omitted. The neighborhood test uses the cell grid: for each
-- cell column in range, one primary key range scan on claimed_cells.
create function public.get_sites(west float8, south float8, east float8, north float8)
returns table (id text, kind text, subtype text, name text, lng float8, lat float8, visibility text)
language plpgsql
stable
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  v_user uuid := auth.uid();
  v_box extensions.geometry;
  r record;
  -- Grid constants, computed once: helper calls inside the query would run per row.
  v_s float8 := private.cell_size_3857();
  v_n bigint := (2 ^ (select cell_zoom from private.claim_rules()))::bigint;
  v_h constant float8 := 20037508.342789244;
begin
  if v_user is null then
    raise exception 'Not signed in' using errcode = '42501';
  end if;
  v_box := private.check_bbox(west, south, east, north);
  select * into r from private.site_rules();

  return query
  with cand as (
    select si.id, si.kind, si.subtype, si.name, si.geom, si.cell,
      extensions.st_x(m.g) as px, extensions.st_y(m.g) as py,
      r.silhouette_m * cosh(extensions.st_y(m.g) / 6378137.0) as rr
    from public.sites si
    cross join lateral (select extensions.st_transform(si.geom, 3857) as g) m
    where si.geom operator(extensions.&&) v_box
      and extensions.st_intersects(si.geom, v_box)
  ),
  vis as (
    select c.*,
      case
        when exists (select 1 from public.claimed_cells cc where cc.user_id = v_user and cc.cell = c.cell)
          then 'owned'
        when exists (
          select 1
          from generate_series(floor((c.px - c.rr + v_h) / v_s)::bigint, floor((c.px + c.rr + v_h) / v_s)::bigint) as x,
            lateral (select sqrt(greatest(c.rr ^ 2 - (-v_h + (x + 0.5) * v_s - c.px) ^ 2, 0)) as half) hw
          where abs(-v_h + (x + 0.5) * v_s - c.px) <= c.rr
            and exists (
              select 1 from public.claimed_cells cc
              where cc.user_id = v_user
                and cc.cell between x * v_n + ceil((v_h - c.py - hw.half) / v_s - 0.5)::bigint
                                and x * v_n + floor((v_h - c.py + hw.half) / v_s - 0.5)::bigint)
        ) then 'silhouette'
      end as visibility
    from cand c
  )
  select v.id, v.kind, v.subtype,
    case when v.visibility = 'owned' then v.name end,
    round(extensions.st_x(v.geom)::numeric, 7)::float8,
    round(extensions.st_y(v.geom)::numeric, 7)::float8,
    v.visibility
  from vis v
  where v.visibility is not null
  order by v.visibility, v.id
  limit r.max_sites;
end;
$$;

comment on function public.get_sites(float8, float8, float8, float8) is
  'Returns the caller''s visible sites in the box: owned on claimed land, silhouette (no name) within 150 m of it.';

-- Function privileges.
revoke all on all functions in schema private from public, anon, authenticated;
revoke all on function public.claim_site_areas(uuid, float8, float8, float8, float8, int) from public, anon, authenticated;
revoke all on function public.fail_site_area(bigint, text) from public, anon, authenticated;
revoke all on function public.ingest_site_area(bigint, jsonb) from public, anon, authenticated;
revoke all on function public.get_sites(float8, float8, float8, float8) from public, anon;
grant execute on function public.claim_site_areas(uuid, float8, float8, float8, float8, int) to service_role;
grant execute on function public.fail_site_area(bigint, text) to service_role;
grant execute on function public.ingest_site_area(bigint, jsonb) to service_role;
grant execute on function public.get_sites(float8, float8, float8, float8) to authenticated;
