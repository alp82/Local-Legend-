-- pgTAP tests for sites: filters, mine derivation, area leases, visibility, and privileges.
-- Run with: npx supabase test db
begin;

select plan(58);

insert into auth.users (id, aud, role, is_anonymous)
values
  ('eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee', 'authenticated', 'authenticated', true),
  ('ffffffff-ffff-ffff-ffff-ffffffffffff', 'authenticated', 'authenticated', true);

-- The test area: the zoom 14 tile over Krakow's old town.
create function pg_temp.area() returns bigint language sql immutable as $$ select 149083568::bigint $$;

-- Center of grid cell i of the test area, moved dx_m east and dy_m north, as {lat, lon}.
create function pg_temp.at(i int, dx_m float8 default 0, dy_m float8 default 0)
returns jsonb
language sql
stable
as $$
  select jsonb_build_object(
    'lat', extensions.st_y(c) + dy_m / 111320.0,
    'lon', extensions.st_x(c) + dx_m / (111320.0 * cos(radians(extensions.st_y(c)))))
  from (select extensions.st_transform(extensions.st_centroid(private.area_grid_envelope(pg_temp.area(), i)), 4326) as c) t
$$;

-- A square outline of side_m meters around a point, as a GeoJSON MultiLineString.
create function pg_temp.square(p jsonb, side_m float8)
returns jsonb
language sql
immutable
as $$
  select jsonb_build_object('type', 'MultiLineString', 'coordinates', jsonb_build_array(jsonb_build_array(
    jsonb_build_array(lon - dx, lat - dy), jsonb_build_array(lon + dx, lat - dy),
    jsonb_build_array(lon + dx, lat + dy), jsonb_build_array(lon - dx, lat + dy),
    jsonb_build_array(lon - dx, lat - dy))))
  from (select (p ->> 'lat')::float8 as lat, (p ->> 'lon')::float8 as lon) q,
    lateral (select side_m / 2 / 111320.0 as dy, side_m / 2 / (111320.0 * cos(radians(lat))) as dx) d
$$;

create function pg_temp.node(id text, tags jsonb, p jsonb)
returns jsonb
language sql
immutable
as $$ select jsonb_build_object('id', id, 'tags', tags) || p $$;

-- The fixture, as one vector tile would arrive after normalizeTile.
create function pg_temp.payload()
returns jsonb
language sql
stable
as $$
  select jsonb_build_object(
    'elements', jsonb_build_array(
      pg_temp.node('node/1', '{"poi.class": "attraction", "poi.subclass": "viewpoint", "name": "Lookout"}', pg_temp.at(0)),
      pg_temp.node('node/2', '{"poi.class": "art_gallery", "poi.subclass": "artwork", "name": "Near"}', pg_temp.at(0, 100, 0)),
      pg_temp.node('node/3', '{"poi.class": "cafe", "poi.subclass": "cafe", "name": "Far"}', pg_temp.at(0, 300, 0)),
      -- A feature without an OSM id.
      pg_temp.node('hash/0123456789abcdef', '{"poi.class": "cafe", "poi.subclass": "cafe"}', pg_temp.at(10)),
      -- Not places.
      pg_temp.node('node/10', '{"poi.class": "place_of_worship", "poi.subclass": "christian", "name": "Church"}', pg_temp.at(1)),
      -- An attraction that is also a school (POI merged with its landuse) is excluded.
      pg_temp.node('node/11', '{"poi.class": "attraction", "poi.subclass": "attraction", "landuse.class": "school"}', pg_temp.at(2)),
      pg_temp.node('node/14', '{"transportation_name.class": "path", "transportation_name.subclass": "steps"}', pg_temp.at(4)),
      pg_temp.node('way/15', '{"transportation_name.class": "path", "transportation_name.subclass": "steps", "name": "Castle Steps"}', pg_temp.at(5)),
      pg_temp.node('node/17', '{"poi.class": "shop", "poi.subclass": "gift", "name": "Shop"}', pg_temp.at(7)),
      -- A named park POI without a polygon.
      pg_temp.node('node/18', '{"poi.class": "park", "poi.subclass": "park", "name": "Small Square"}', pg_temp.at(8)),
      -- A cafe inside a cemetery is excluded by the zone.
      jsonb_build_object('id', 'way/100', 'tags', '{"landuse.class": "cemetery"}'::jsonb, 'geometry', pg_temp.square(pg_temp.at(9), 100)),
      pg_temp.node('node/19', '{"poi.class": "cafe", "poi.subclass": "cafe"}', pg_temp.at(9)),
      -- Outside the area.
      pg_temp.node('node/20', '{"poi.class": "attraction", "poi.subclass": "viewpoint"}', '{"lat": 50.07, "lon": 19.94}'),
      -- A 4 ha named park, POI merged with its landcover polygon: a park place and a sawmill.
      pg_temp.node('way/101', '{"poi.class": "park", "poi.subclass": "park", "landcover.class": "grass",
          "landcover.subclass": "park", "name": "Big Park"}', pg_temp.at(60, 20, 20))
        || jsonb_build_object('geometry', pg_temp.square(pg_temp.at(60), 200)),
      -- A 0.25 ha garden is too small for a sawmill.
      jsonb_build_object('id', 'way/102', 'tags', '{"landcover.class": "grass", "landcover.subclass": "garden"}'::jsonb,
        'geometry', pg_temp.square(pg_temp.at(63), 50)),
      -- Notable places for a gold mine: 5 castles, score 10.
      pg_temp.node('way/30', '{"poi.class": "castle", "poi.subclass": "castle"}', pg_temp.at(27, -10, -10)),
      pg_temp.node('way/31', '{"poi.class": "castle", "poi.subclass": "castle"}', pg_temp.at(27, 10, -10)),
      pg_temp.node('way/32', '{"poi.class": "castle", "poi.subclass": "castle"}', pg_temp.at(27, -10, 10)),
      pg_temp.node('way/33', '{"poi.class": "castle", "poi.subclass": "castle"}', pg_temp.at(27, 10, 10)),
      pg_temp.node('way/34', '{"poi.class": "castle", "poi.subclass": "castle"}', pg_temp.at(27, 0, 0))
    ),
    -- Three dense grid cells; only the two densest become quarries.
    'building_cover', (
      select jsonb_agg(case i when 45 then 0.7 when 46 then 0.6 when 47 then 0.5 else 0.1 end order by i)
      from generate_series(0, 63) as i)
  )
$$;

create function pg_temp.snapshot()
returns text[]
language sql
stable
as $$
  select array_agg(id || '|' || subtype || '|' || coalesce(name, '') || '|' || extensions.st_astext(geom) order by id)
  from public.sites
$$;

create function pg_temp.sites_as(who uuid, w float8, s float8, e float8, n float8)
returns table (id text, kind text, subtype text, name text, lng float8, lat float8, visibility text)
language plpgsql
as $$
begin
  perform set_config('role', 'authenticated', true);
  perform set_config('request.jwt.claims', json_build_object('sub', who, 'role', 'authenticated')::text, true);
  return query select * from public.get_sites(w, s, e, n);
  perform set_config('role', 'postgres', true);
end;
$$;

-- Structure and privileges ---------------------------------------------------

select has_table('public', 'sites', 'sites table exists');
select has_table('public', 'site_areas', 'site_areas table exists');
select ok(
  (select bool_and(relrowsecurity) from pg_class where oid in ('public.sites'::regclass, 'public.site_areas'::regclass)),
  'RLS is enabled on sites and site_areas');
select table_privs_are('public', 'sites', 'authenticated', array[]::text[], 'authenticated has no privileges on sites');
select table_privs_are('public', 'sites', 'anon', array[]::text[], 'anon has no privileges on sites');
select table_privs_are('public', 'site_areas', 'authenticated', array[]::text[], 'authenticated has no privileges on site_areas');
select table_privs_are('public', 'site_areas', 'anon', array[]::text[], 'anon has no privileges on site_areas');
select function_privs_are('public', 'get_sites', array['double precision', 'double precision', 'double precision', 'double precision'],
  'anon', array[]::text[], 'anon cannot call get_sites');
select function_privs_are('public', 'ingest_site_area', array['bigint', 'jsonb'], 'authenticated', array[]::text[],
  'authenticated cannot call ingest_site_area');
select function_privs_are('public', 'claim_site_areas',
  array['uuid', 'double precision', 'double precision', 'double precision', 'double precision', 'integer'],
  'authenticated', array[]::text[], 'authenticated cannot call claim_site_areas');
select function_privs_are('public', 'fail_site_area', array['bigint', 'text'], 'authenticated', array[]::text[],
  'authenticated cannot call fail_site_area');
select is(
  (select bool_and(prosecdef and proconfig @> array['search_path=""']) from pg_proc
   where pronamespace = 'public'::regnamespace
     and proname in ('get_sites', 'ingest_site_area', 'claim_site_areas', 'fail_site_area')),
  true,
  'site RPCs are SECURITY DEFINER with an empty search_path');

-- Filter rules ---------------------------------------------------------------

select ok(private.is_excluded('{"poi.class": "place_of_worship", "poi.subclass": "christian"}'), 'places of worship are excluded');
select ok(private.is_excluded('{"landuse.class": "cemetery"}') and private.is_excluded('{"poi.subclass": "grave_yard"}'),
  'cemeteries are excluded');
select ok(private.is_zone('{"landuse.class": "school"}') and private.is_zone('{"landuse.class": "hospital"}')
  and private.is_zone('{"landuse.class": "military"}') and private.is_zone('{"landuse.class": "railway"}'),
  'school, hospital, military, and railway land are exclusion zones');
select ok(private.is_excluded('{"poi.class": "school"}') and private.is_excluded('{"poi.class": "hospital"}')
  and private.is_excluded('{"poi.subclass": "kindergarten"}') and private.is_excluded('{"poi.subclass": "university"}'),
  'schools and hospitals are excluded');
select ok(not private.is_zone('{"poi.class": "place_of_worship"}'), 'points are never zones');
select ok(private.is_excluded('{"poi.class": "railway", "poi.subclass": "tram_stop"}'), 'railway stops are excluded');
select ok(not private.is_excluded('{"transportation_name.subclass": "steps", "name": "X"}'), 'steps are not excluded');
select is((select subtype from private.place_rule('{"poi.class": "attraction", "poi.subclass": "viewpoint"}', false)),
  'viewpoint', 'a viewpoint is a place');
select is((select subtype from private.place_rule('{"transportation_name.subclass": "steps"}', false)), null,
  'unnamed steps are not a place');
select is((select subtype from private.place_rule('{"poi.subclass": "park", "name": "P"}', false)), null,
  'a park without a large enough polygon is not a place');
select ok((private.source_filter() ->> 'zoom')::int = 14 and (private.source_filter() ->> 'grid')::int = 8
  and private.source_filter() -> 'keys' @> '[{"key": "transportation_name.subclass", "vals": ["steps"]}]'
  and private.source_filter() -> 'keys' @> '[{"key": "landuse.class"}, {"key": "landcover.class"}]',
  'the source filter names the tile zoom, the grid, and every rule key');
select hasnt_function('private', 'overpass_query', array['bigint'], 'the Overpass query is gone');

-- Ingestion ------------------------------------------------------------------

select is(public.ingest_site_area(pg_temp.area(), pg_temp.payload()), '{"mines": 4, "places": 11}'::jsonb,
  'ingest_site_area reports places and mines');

select set_eq(
  $$ select id from public.sites where kind = 'place' $$,
  array['osm:node/1', 'osm:node/2', 'osm:node/3', 'omt:0123456789abcdef', 'osm:way/15',
        'osm:way/30', 'osm:way/31', 'osm:way/32', 'osm:way/33', 'osm:way/34', 'osm:way/101'],
  'only allowed places inside the area are stored');
select is_empty(
  $$ select 1 from public.sites where id in ('osm:node/10', 'osm:node/11', 'osm:node/14', 'osm:node/17', 'osm:node/18') $$,
  'excluded, unnamed, unlisted, and small elements do not become sites');
select is_empty($$ select 1 from public.sites where id = 'osm:node/19' $$, 'a cafe inside a cemetery is not a site');
select is_empty($$ select 1 from public.sites where id = 'osm:node/20' $$, 'elements outside the area are not stored');
select is((select subtype || ':' || name from public.sites where id = 'osm:way/101'), 'park:Big Park',
  'a large named park is a park place');
select is((select subtype from public.sites where id = 'osm:way/15'), 'steps', 'named steps are a place');
select ok((select extensions.st_dwithin(geom::extensions.geography, extensions.st_setsrid(extensions.st_point(
    (pg_temp.at(60, 20, 20) ->> 'lon')::float8, (pg_temp.at(60, 20, 20) ->> 'lat')::float8), 4326)::extensions.geography, 0.5)
  from public.sites where id = 'osm:way/101'), 'a park place sits at its POI point');
select is((select tags from public.sites where id = 'osm:way/101'),
  '{"name": "Big Park", "poi.class": "park", "poi.subclass": "park", "landcover.subclass": "park"}'::jsonb,
  'sites keep the kept tags only');

select results_eq(
  $$ select subtype, count(*)::int from public.sites where kind = 'mine' group by subtype order by subtype $$,
  $$ values ('gold_mine', 1), ('quarry', 2), ('sawmill', 1) $$,
  'mines: one gold mine, two quarries (capped), one sawmill');
select ok(
  (select extensions.st_dwithin(m.geom::extensions.geography, c.geom::extensions.geography, 30)
   from public.sites m, public.sites c where m.subtype = 'gold_mine' and c.id = 'osm:way/34'),
  'the gold mine sits at the notable places');
select ok(
  (select extensions.st_contains(extensions.st_buildarea(extensions.st_setsrid(extensions.st_geomfromgeojson(pg_temp.square(pg_temp.at(60), 200)), 4326)), geom)
   from public.sites where subtype = 'sawmill'),
  'the sawmill lies inside the park');
select is(
  (select array_agg(id order by id) from public.sites where subtype = 'quarry'),
  (select array_agg('mine:quarry:' || pg_temp.area() || ':' ||
     private.tile_of(extensions.st_centroid(private.area_grid_envelope(pg_temp.area(), i)), 17) order by 1)
   from unnest(array[45, 46]) as i),
  'quarries are the two densest grid cells');
select ok(
  (select min(extensions.st_distance(a.geom::extensions.geography, b.geom::extensions.geography))
   from public.sites a, public.sites b where a.kind = 'mine' and b.kind = 'mine' and a.id < b.id) >= 150,
  'mines are at least 150 m apart');
select is((select fetched_at is not null and place_count = 11 and mine_count = 4 from public.site_areas where area = pg_temp.area()),
  true, 'the area is marked fetched with counts');

-- Determinism: same input, same rows, regardless of element order.
create temp table first_run as select pg_temp.snapshot() as s;
select public.ingest_site_area(pg_temp.area(), pg_temp.payload());
select is(pg_temp.snapshot(), (select s from first_run), 'ingesting the same data again gives the same rows');
select public.ingest_site_area(pg_temp.area(), jsonb_set(pg_temp.payload(), '{elements}',
  (select jsonb_agg(e order by ord desc) from jsonb_array_elements(pg_temp.payload() -> 'elements') with ordinality as x (e, ord))));
select is(pg_temp.snapshot(), (select s from first_run), 'element order does not change the result');

-- A refetch replaces the area's rows.
select public.ingest_site_area(pg_temp.area(), jsonb_build_object('elements',
  jsonb_build_array(pg_temp.node('node/1', '{"poi.subclass": "viewpoint", "name": "Lookout"}', pg_temp.at(0)))));
select is((select count(*)::int from public.sites where area = pg_temp.area()), 1, 'a refetch removes sites that disappeared');
select public.ingest_site_area(pg_temp.area(), pg_temp.payload());

select throws_ok($$ select public.ingest_site_area(pg_temp.area(), '{"elements": [], "building_cover": [0.1, 0.2]}') $$,
  '22023', null, 'a wrong number of building cover entries is refused');

-- Visibility -----------------------------------------------------------------

-- Player E owns the cell under the viewpoint. node/2 is 100 m away, node/3 300 m.
insert into public.claimed_cells (user_id, cell, first_claimed_at)
select 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee', s.cell, now() from public.sites s where s.id = 'osm:node/1';

select results_eq(
  $$ select id, visibility, name from pg_temp.sites_as('eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee', 19.9, 50.0, 20.0, 50.1)
     order by id $$,
  $$ values ('osm:node/1', 'owned', 'Lookout'), ('osm:node/2', 'silhouette', null::text) $$,
  'owned on claimed land, silhouette without a name within 150 m, nothing farther');
select is_empty($$ select * from pg_temp.sites_as('ffffffff-ffff-ffff-ffff-ffffffffffff', 19.9, 50.0, 20.0, 50.1) $$,
  'a player without land sees no sites');
select is_empty($$ select * from pg_temp.sites_as('eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee', 19.95, 50.0, 20.0, 50.1) $$,
  'sites outside the box are not returned');

-- The grid neighborhood test agrees with a brute-force distance check, away
-- from the 150 m edge. Land: a 600 m line of cells east of the viewpoint.
insert into public.claimed_cells (user_id, cell, first_claimed_at)
select 'ffffffff-ffff-ffff-ffff-ffffffffffff', private.tile_of(extensions.st_transform(extensions.st_setsrid(
  extensions.st_point((pg_temp.at(16, d, 0) ->> 'lon')::float8, (pg_temp.at(16, d, 0) ->> 'lat')::float8), 4326), 3857), 21), now()
from generate_series(0, 600, 5) as d
on conflict do nothing;
insert into public.sites (id, kind, subtype, geom, cell, area)
select 'test:' || gx || ':' || gy, 'place', 'cafe', g, private.tile_of(extensions.st_transform(g, 3857), 21), pg_temp.area()
from generate_series(-300, 900, 37) as gx, generate_series(-300, 300, 23) as gy,
  lateral (select extensions.st_setsrid(extensions.st_point((pg_temp.at(16, gx, gy) ->> 'lon')::float8,
    (pg_temp.at(16, gx, gy) ->> 'lat')::float8), 4326) as g) p;
create temp table brute as
select s.id, min(extensions.st_distance(s.geom::extensions.geography,
  extensions.st_transform(extensions.st_centroid(private.cell_envelope(c.cell)), 4326)::extensions.geography)) as d
from public.sites s, public.claimed_cells c
where s.id like 'test:%' and c.user_id = 'ffffffff-ffff-ffff-ffff-ffffffffffff'
group by s.id;
create temp table seen as
select id, visibility from pg_temp.sites_as('ffffffff-ffff-ffff-ffff-ffffffffffff', 19.9, 50.0, 20.0, 50.1)
where id like 'test:%';
select is(
  (select count(*)::int from brute b left join seen v using (id)
   where (b.d < 147 and v.visibility is null) or (b.d > 153 and v.visibility is not null)),
  0, 'the silhouette range matches a brute-force 150 m distance check');
select ok((select count(*) from seen where visibility = 'silhouette') > 100
  and (select count(*) from seen where visibility = 'owned') > 0
  and (select count(*) from brute where d > 153) > 100, 'the brute-force check covers all three cases');
delete from public.sites where id like 'test:%';

select throws_ok($$ select * from pg_temp.sites_as('eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee', 19.0, 50.0, 20.0, 50.1) $$,
  '22023', null, 'a box larger than the limit is refused');
select throws_ok($$ select * from pg_temp.sites_as('eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee', 20.0, 50.0, 19.9, 50.1) $$,
  '22023', null, 'an inverted box is refused');

-- Area leases ----------------------------------------------------------------

delete from public.site_areas;
select results_eq(
  $$ select area, source from public.claim_site_areas('eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee', 19.93, 50.05, 19.95, 50.064) $$,
  $$ values (pg_temp.area(), private.source_filter()) $$,
  'claim_site_areas leases the area under the player''s land, with the source filter');
select results_eq(
  $$ select area, source from public.claim_site_areas('eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee', 19.93, 50.05, 19.95, 50.064) $$,
  $$ values (pg_temp.area(), null::jsonb) $$,
  'a leased area is not handed out twice; it is reported without a source');
select public.fail_site_area(pg_temp.area(), 'test');
select is_empty(
  $$ select * from public.claim_site_areas('eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee', 19.93, 50.05, 19.95, 50.064) $$,
  'a failed area waits before the next try');
select public.ingest_site_area(pg_temp.area(), pg_temp.payload());
select is_empty(
  $$ select * from public.claim_site_areas('eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee', 19.93, 50.05, 19.95, 50.064) $$,
  'a fresh area is not fetched again');
update public.site_areas set fetched_at = now() - interval '31 days' where area = pg_temp.area();
select is(
  (select count(*)::int from public.claim_site_areas('eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee', 19.93, 50.05, 19.95, 50.064)),
  1, 'an area older than 30 days is fetched again');

-- Access ---------------------------------------------------------------------

set local role authenticated;
set local request.jwt.claims = '{"sub": "eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee", "role": "authenticated"}';
select throws_ok('select * from public.sites', '42501', null, 'clients cannot read sites directly');
select throws_ok($$ insert into public.sites (id, kind, subtype, geom, cell, area)
  values ('x', 'place', 'cafe', extensions.st_setsrid(extensions.st_point(0, 0), 4326), 0, 0) $$,
  '42501', null, 'clients cannot write sites');

set local request.jwt.claims = '{"role": "authenticated"}';
select throws_ok('select * from public.get_sites(19.9, 50.0, 20.0, 50.1)', '42501', null,
  'get_sites requires a signed-in player');

select * from finish();
rollback;
