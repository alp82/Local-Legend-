-- Sites from OpenFreeMap vector tiles instead of the Overpass API.
--
-- The public Overpass servers are overloaded and their policy rules out app
-- backends. The `sites` Edge Function now downloads one zoom 14 vector tile
-- (OpenMapTiles schema) per area from OpenFreeMap, the tile server the app's
-- map already uses, and normalizes its features:
--
--   - Each feature becomes an element with id "node/1", "way/2", or
--     "relation/3" (OpenFreeMap encodes the OSM id as id * 10 + type), or
--     "hash/<16 hex>" when the tile has no id.
--   - Its tags are the feature's properties as "<layer>.<field>", for example
--     {"poi.class": "castle", "poi.subclass": "castle", "name": "Zamek Wawel"}.
--     Features that share an OSM id across layers, such as a park POI and its
--     landcover polygon, are merged into one element.
--   - Building cover per grid cell replaces the Overpass building counts:
--     tiles hold real footprints, but merge many buildings into one feature.
--
-- claim_site_areas now returns, per area, the filter that tells the function
-- which features to forward (private.source_filter). The rules below are
-- rewritten for OpenMapTiles layers; the matching, mine derivation, and
-- get_sites are unchanged.

-- ---------------------------------------------------------------------------
-- Rules
-- ---------------------------------------------------------------------------

drop function private.overpass_query(bigint);
drop function private.overpass_filter(text, text[]);
drop function private.overpass_bbox(extensions.geometry);
drop function public.claim_site_areas(uuid, float8, float8, float8, float8, int);
drop function private.site_rules();

create function private.site_rules(
  out area_zoom int,                       -- Fetch and cache unit, one vector tile. Changing it invalidates site_areas.
  out grid_zoom int,                       -- Sub-grid for mine density: (2^(grid - area))^2 cells per area.
  out refetch_after interval,              -- Areas older than this are fetched again.
  out lease interval,                      -- How long one caller owns an area fetch.
  out retry_after interval,                -- Wait after a failed fetch before trying again.
  out max_areas_per_call int,              -- Tile downloads per get-sites call, at most.
  out max_bbox_deg float8,                 -- Larger boxes are refused with 22023.
  out silhouette_m float8,                 -- Sites this close to claimed land show as silhouettes.
  out max_sites int,                       -- Rows returned by get_sites, at most.
  out park_min_m2 float8,                  -- Smaller parks don't become place sites.
  out sawmill_min_m2 float8,               -- Green area inside the tile needed for a sawmill.
  out max_sawmills int,                    -- Per area.
  out quarry_min_building_cover float8,    -- Share of a grid cell covered by buildings needed for a quarry.
  out max_quarries int,                    -- Per area.
  out gold_min_score int,                  -- Notability score of a grid cell needed for a gold mine.
  out max_gold_mines int,                  -- Per area.
  out mine_spacing_m float8,               -- Minimum distance between two mines.
  out kept_tags text[]                     -- Element tags copied to sites.tags.
)
language sql
immutable
parallel safe
set search_path = ''
as $$
  select 14, 17, interval '30 days', interval '30 seconds', interval '10 minutes', 4, 0.25,
    150.0, 2000, 5000.0, 5000.0, 2, 0.4, 2, 10, 1, 150.0,
    array['name', 'name:en', 'poi.class', 'poi.subclass', 'landcover.subclass', 'park.class',
          'transportation_name.subclass']
$$;

comment on function private.site_rules() is 'Site thresholds, in one place.';

-- What becomes a place site. The first matching rule (lowest priority) wins.
-- Keys are "<layer>.<field>" of the OpenMapTiles schema; vals null means any
-- value. notability feeds the gold mine score. OpenMapTiles has no fountains,
-- memorials, or historic buildings other than castles, palaces (class
-- castle), ruins, monuments, and gates (barrier=sally_port).
create or replace function private.place_rules()
returns table (priority int, subtype text, key text, vals text[], needs_name boolean, needs_polygon boolean, notability int)
language sql
immutable
parallel safe
set search_path = ''
as $$
  values
    (1,  'viewpoint',  'poi.subclass', array['viewpoint'], false, false, 1),
    (2,  'castle',     'poi.subclass', array['castle'], false, false, 2),
    (3,  'ruins',      'poi.subclass', array['ruins'], false, false, 1),
    (4,  'monument',   'poi.subclass', array['monument'], false, false, 1),
    (5,  'historic',   'poi.subclass', array['sally_port'], true, false, 1),
    (6,  'artwork',    'poi.subclass', array['artwork'], false, false, 1),
    (7,  'museum',     'poi.subclass', array['museum'], false, false, 2),
    (8,  'attraction', 'poi.subclass', array['attraction'], false, false, 2),
    (9,  'cafe',       'poi.subclass', array['cafe'], false, false, 0),
    (10, 'steps',      'transportation_name.subclass', array['steps'], true, false, 0),
    -- A park POI is merged with its landcover polygon, which gives the area.
    (11, 'park',       'poi.subclass', array['park'], true, true, 0)
$$;

-- Green areas that can hold a sawmill.
create or replace function private.green_rules()
returns table (key text, vals text[])
language sql
immutable
parallel safe
set search_path = ''
as $$
  values
    ('landcover.class', array['wood']),
    ('landcover.subclass', array['park', 'garden', 'recreation_ground']),
    ('park.class', array['nature_reserve', 'national_park'])
$$;

-- Never a site: public open space only. An element matching any rule is
-- dropped. vals null means any value; except_vals are allowed values of the
-- key. A polygon matching an is_zone rule also drops every site inside it,
-- so a café in a cemetery or a statue in a schoolyard never shows.
-- OpenMapTiles has no access, memorial, or religion tags and no church
-- polygons, so those rules from the Overpass version are gone.
create or replace function private.exclude_rules()
returns table (key text, vals text[], except_vals text[], is_zone boolean)
language sql
immutable
parallel safe
set search_path = ''
as $$
  values
    ('landuse.class', array['cemetery', 'religious', 'military', 'railway', 'education', 'school',
       'university', 'college', 'kindergarten', 'hospital', 'prison'], null::text[], true),
    ('poi.class', array['place_of_worship', 'cemetery', 'school', 'college', 'hospital', 'railway'], null, false),
    ('poi.subclass', array['grave_yard', 'kindergarten', 'university', 'clinic', 'doctors', 'dentist',
       'nursing_home', 'prison', 'memorial'], null, false)
$$;

-- The features the Edge Function forwards for one area: every key a place,
-- green, or zone rule can match, plus the tile and building grid sizes.
create function private.source_filter()
returns jsonb
language sql
immutable
parallel safe
set search_path = ''
as $$
  select jsonb_build_object(
    'zoom', r.area_zoom,
    'grid', (2 ^ (r.grid_zoom - r.area_zoom))::int,
    'keys', (
      select jsonb_agg(jsonb_build_object('key', k.key, 'vals', to_jsonb(k.vals)) order by k.key, k.vals)
      from (
        select p.key, p.vals from private.place_rules() p
        union
        select g.key, g.vals from private.green_rules() g
        union
        select x.key, x.vals from private.exclude_rules() x where x.is_zone
      ) k))
  from private.site_rules() r
$$;

revoke all on all functions in schema private from public, anon, authenticated;

-- Sites and cache entries from the Overpass version are dropped, so every
-- area is fetched again from the tiles.
truncate public.sites, public.site_areas;

comment on table public.site_areas is
  'Vector tile fetch cache: one row per area (zoom 14 tile, id = x * 2^14 + y). Written only by the sites Edge Function through service-role RPCs.';
comment on table public.sites is
  'Shared map sites. id is "osm:<type>/<id>" or "omt:<hash>" for places and "mine:<subtype>:<area>:<key>" for derived mines. cell is the zoom 21 claim cell of geom; area is the zoom 14 tile that owns the row.';

-- ---------------------------------------------------------------------------
-- Ingestion (service role only)
-- ---------------------------------------------------------------------------

-- Leases up to p_max areas in the box that lie within silhouette range of the
-- player's land and need a fetch, nearest to the box center first. Returns
-- each area with the source filter. A leased area isn't handed to another
-- caller until the lease ends; areas another caller is fetching are returned
-- with a null source, so the caller can report them as pending.
create function public.claim_site_areas(
  p_user uuid, west float8, south float8, east float8, north float8, p_max int default null
)
returns table (area bigint, source jsonb)
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
  select l.area, private.source_filter() from leased l
  union all
  -- Areas another request is fetching right now.
  select w.a, null::jsonb
  from wanted w
  join public.site_areas sa on sa.area = w.a
  where sa.lease_until >= now();
end;
$$;

comment on function public.claim_site_areas(uuid, float8, float8, float8, float8, int) is
  'Service role only. Leases areas near the player''s land that need a tile fetch and returns {area, source}; source is null for areas another caller is fetching.';

-- Replaces the sites of one area from a normalized vector tile.
--
-- p_data = {
--   elements: [{id: "node/1" | "way/2" | "relation/3" | "hash/<16 hex>",
--               tags: {"<layer>.<field>": value, name, ...},
--               lat, lon (point position, optional),
--               geometry (optional GeoJSON MultiLineString of polygon rings)}],
--   building_cover: [one share 0 to 1 per grid cell, row-major from the north-west]
-- }
--
-- Places: elements matching a place rule, not excluded, whose point (or a
-- point on the polygon when there is none) lies in this area and outside
-- every exclusion zone. Mines, in this order, each at least mine_spacing_m
-- from the others and outside exclusion zones:
--   gold_mine: grid cells whose places score at least gold_min_score, at the
--     centroid of their notable places.
--   sawmill: green polygons with at least sawmill_min_m2 inside the area, at a
--     point on that part of the polygon. Largest first.
--   quarry: grid cells with at least quarry_min_building_cover, at the cell
--     center. Densest first.
-- The same input always gives the same rows.
create or replace function public.ingest_site_area(p_area bigint, p_data jsonb)
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
  v_cover jsonb := p_data -> 'building_cover';
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
  if v_cover is not null and (jsonb_typeof(v_cover) <> 'array' or jsonb_array_length(v_cover) <> v_cells) then
    raise exception 'building_cover must have % entries', v_cells using errcode = '22023';
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
    where (e ->> 'id') ~ '^((node|way|relation)/[0-9]+|hash/[0-9a-f]{16})$'
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
  order by osm_id, (poly is not null) desc, (pt is not null) desc;

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
  select case when e.osm_id like 'hash/%' then 'omt:' || substr(e.osm_id, 6) else 'osm:' || e.osm_id end,
    'place', pr.subtype, e.tags ->> 'name', p.g,
    (select coalesce(jsonb_object_agg(k, e.tags -> k), '{}'::jsonb) from unnest(r.kept_tags) k where e.tags ? k),
    pr.notability
  from pg_temp.site_elements e
  cross join lateral (
    select coalesce(e.pt, extensions.st_pointonsurface(e.poly)) as g
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
        (v_cover ->> g.i)::float8 as score
      from grid g
      where v_cover is not null and jsonb_typeof(v_cover -> g.i) = 'number'
    )
    select * from gold
    union all select * from saw where score >= r.sawmill_min_m2
    union all select * from quarry where score >= r.quarry_min_building_cover
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
  'Service role only. Replaces one area''s sites from a normalized vector tile. Returns {places, mines}.';

-- Function privileges.
revoke all on all functions in schema private from public, anon, authenticated;
revoke all on function public.claim_site_areas(uuid, float8, float8, float8, float8, int) from public, anon, authenticated;
revoke all on function public.ingest_site_area(bigint, jsonb) from public, anon, authenticated;
grant execute on function public.claim_site_areas(uuid, float8, float8, float8, float8, int) to service_role;
grant execute on function public.ingest_site_area(bigint, jsonb) to service_role;
