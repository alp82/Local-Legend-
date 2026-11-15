-- pgTAP tests for detour offers: spots at public, walkable places, frequent
-- routes, generation, collection within 30 m paid once (retries, reordered
-- batches, two sessions), the 4 a.m. boundary in several time zones, the
-- scheduled job, and privileges.
-- Run with: npx supabase test db
begin;

select plan(117);

insert into auth.users (id, aud, role, is_anonymous)
select ('d0000000-0000-0000-0000-0000000000' || lpad(i::text, 2, '0'))::uuid, 'authenticated', 'authenticated', true
from generate_series(1, 15) as i;

-- d01: generation, collection, retries, the next day. d02: reordered batches
-- and a second session. d03: the 30 m radius and offers made after a walk.
-- d04 to d08: the 4 a.m. boundary in two zones. d09: a new player. d10:
-- offers a day. d11: privileges. d12 to d14: offer days in Warsaw and New York.
-- d15: the short band's fallback.

-- ---------------------------------------------------------------------------
-- Helpers. Positions are meters north (n) and east (e) of a point in Krakow.
-- ---------------------------------------------------------------------------

create function pg_temp.u(i int)
returns uuid
language sql
immutable
as $$
  select ('d0000000-0000-0000-0000-0000000000' || lpad(i::text, 2, '0'))::uuid
$$;

create function pg_temp.lat(n float8)
returns float8
language sql
immutable
as $$
  select 50.057 + n / 111320.0
$$;

create function pg_temp.lng(e float8)
returns float8
language sql
immutable
as $$
  select 19.935 + e / (111320.0 * cos(radians(50.057)))
$$;

create function pg_temp.pos(n float8, e float8)
returns jsonb
language sql
immutable
as $$
  select jsonb_build_array(round(pg_temp.lng(e)::numeric, 7), round(pg_temp.lat(n)::numeric, 7))
$$;

create function pg_temp.geom(n float8, e float8)
returns extensions.geometry
language sql
immutable
as $$
  select extensions.st_setsrid(extensions.st_makepoint(pg_temp.lng(e), pg_temp.lat(n)), 4326)
$$;

-- Vector tile features in the shape the detours Edge Function sends.
create function pg_temp.point(tags jsonb, n float8, e float8)
returns jsonb
language sql
immutable
as $$
  select jsonb_build_object('type', 'point', 'tags', tags,
    'geometry', jsonb_build_object('type', 'Point', 'coordinates', pg_temp.pos(n, e)))
$$;

create function pg_temp.line(tags jsonb, n0 float8, e0 float8, n1 float8, e1 float8)
returns jsonb
language sql
immutable
as $$
  select jsonb_build_object('type', 'line', 'tags', tags,
    'geometry', jsonb_build_object('type', 'MultiLineString',
      'coordinates', jsonb_build_array(jsonb_build_array(pg_temp.pos(n0, e0), pg_temp.pos(n1, e1)))))
$$;

-- A square of half-size h, ring clockwise (an exterior ring, as tiles give them).
create function pg_temp.square(tags jsonb, n float8, e float8, h float8)
returns jsonb
language sql
immutable
as $$
  select jsonb_build_object('type', 'polygon', 'tags', tags,
    'geometry', jsonb_build_object('type', 'MultiLineString',
      'coordinates', jsonb_build_array(jsonb_build_array(
        pg_temp.pos(n + h, e - h), pg_temp.pos(n + h, e + h), pg_temp.pos(n - h, e + h),
        pg_temp.pos(n - h, e - h), pg_temp.pos(n + h, e - h)))))
$$;

-- GPS fixes on a straight line, about step_m apart, one every dt_s seconds.
create function pg_temp.track(n0 float8, e0 float8, n1 float8, e1 float8, t0 timestamptz,
  step_m float8 default 14, dt_s float8 default 10)
returns jsonb
language sql
stable
as $$
  with k as (select greatest(1, round(sqrt((n1 - n0) ^ 2 + (e1 - e0) ^ 2) / step_m))::int as steps)
  select jsonb_agg(jsonb_build_object(
    't', (extract(epoch from t0 + make_interval(secs => i * dt_s)) * 1000)::bigint,
    'lat', pg_temp.lat(n0 + (n1 - n0) * i / k.steps),
    'lng', pg_temp.lng(e0 + (e1 - e0) * i / k.steps),
    'acc', 5, 'spd', step_m / dt_s) order by i)
  from k, generate_series(0, k.steps) as i
$$;

-- Elements i0 .. i1 (1-based, inclusive) of a JSON array.
create function pg_temp.slice(a jsonb, i0 int, i1 int)
returns jsonb
language sql
immutable
as $$
  select coalesce(jsonb_agg(e order by o), '[]') from jsonb_array_elements(a) with ordinality as x (e, o)
  where o between i0 and i1
$$;

-- A local time on game day d (0 = today) in a zone. '03:59' on day d is
-- still game day d - 1.
create function pg_temp.lt(tz text, d int, hms text)
returns timestamptz
language sql
stable
as $$
  select (((private.game_day(now(), tz) + d)::text || ' ' || hms)::timestamp) at time zone tz
$$;

create function pg_temp.act_as(who uuid)
returns void
language sql
as $$
  select set_config('role', 'authenticated', true),
    set_config('request.jwt.claims', json_build_object('sub', who, 'role', 'authenticated')::text, true)
$$;

create function pg_temp.submit_as(who uuid, batch text, session text, points jsonb)
returns jsonb
language plpgsql
as $$
declare
  result jsonb;
begin
  perform pg_temp.act_as(who);
  result := public.submit_location_batch(batch, session, points);
  perform set_config('role', 'postgres', true);
  return result;
end;
$$;

create function pg_temp.close_as(who uuid, session text)
returns jsonb
language plpgsql
as $$
declare
  result jsonb;
begin
  perform pg_temp.act_as(who);
  result := public.close_walk_session(session);
  perform set_config('role', 'postgres', true);
  return result;
end;
$$;

-- One walk: a single batch, then close. Returns the detours both collected.
create function pg_temp.walk(who uuid, session text, points jsonb)
returns jsonb
language plpgsql
as $$
declare
  a jsonb;
  b jsonb;
begin
  a := pg_temp.submit_as(who, session || '-b1', session, points);
  b := pg_temp.close_as(who, session);
  return pg_temp.collected(a) || pg_temp.collected(b);
end;
$$;

-- The commute: 600 m east from the origin, at 08:00 local on game day d.
create function pg_temp.commute(who uuid, tz text, d int)
returns jsonb
language sql
as $$
  select pg_temp.walk(who, 'commute' || d, pg_temp.track(0, 0, 0, 600, pg_temp.lt(tz, d, '08:00')))
$$;

-- A player in zone tz who walked the commute three and two days ago.
create function pg_temp.commuter(who uuid, tz text)
returns void
language plpgsql
as $$
begin
  perform private.set_time_zone(who, tz, now() - interval '10 days');
  perform pg_temp.commute(who, tz, -3);
  perform pg_temp.commute(who, tz, -2);
end;
$$;

-- A walk north-south through (n, e), from 150 m south to 150 m north, that
-- comes within 4 m of the point at about t_near.
create function pg_temp.pass_by(who uuid, session text, n float8, e float8, t_near timestamptz)
returns jsonb
language sql
as $$
  select pg_temp.walk(who, session, pg_temp.track(n - 150, e, n + 150, e, t_near - interval '107 seconds'))
$$;

create function pg_temp.offer(who uuid, day date, n int)
returns public.detour_offers
language sql
stable
as $$
  select * from public.detour_offers o where o.user_id = who and o.game_day = day and o.slot = n
$$;

-- The detours of a batch or close result, as an array (null becomes []).
create function pg_temp.collected(r jsonb)
returns jsonb
language sql
immutable
as $$
  select case when jsonb_typeof(r -> 'detours') = 'array' then r -> 'detours' else '[]'::jsonb end
$$;

create function pg_temp.detour_rows(who uuid)
returns int
language sql
stable
as $$
  select count(*)::int from public.economy_ledger where user_id = who and reason = 'detour'
$$;

-- Fixed-offset zones (no daylight saving) where it is now 14:xx and 20:xx,
-- so every time below is in the past and the days are known.
create temp table zones as
select
  (select name from pg_timezone_names where name ~ '^Etc/GMT[-+][0-9]+$'
     and extract(hour from now() at time zone name) = 14 order by name limit 1) as a,
  (select name from pg_timezone_names where name ~ '^Etc/GMT[-+][0-9]+$'
     and extract(hour from now() at time zone name) = 20 order by name limit 1) as b;

create function pg_temp.tz_a() returns text language sql stable as $$ select a from zones $$;
create function pg_temp.tz_b() returns text language sql stable as $$ select b from zones $$;

select isnt(pg_temp.tz_a(), null, 'Found a zone where it is 14:00');
select isnt(pg_temp.tz_b(), null, 'Found a zone where it is 20:00');

-- ---------------------------------------------------------------------------
-- Settings
-- ---------------------------------------------------------------------------

select is((select collect_radius_m from private.detour_rules()), 30.0::float8, 'Offers collect within 30 m (the plan)');
select is((select route_factor from private.detour_rules()), 1.3::float8, 'Walking is 30% longer than a straight line (the plan)');
select is((select array[short_route_factor, short_route_max_m] from private.detour_rules()), array[2.0, 200.0]::float8[],
  'Below 200 m from the route, walking is twice the straight line (the user''s decision)');
select is(array[private.detour_added_m(80), private.detour_added_m(199.9), private.detour_added_m(200), private.detour_added_m(400)],
  array[320, 799.6, 520, 1040]::float8[], 'There and back: 2 x 2.0 x the distance below 200 m, 2 x 1.3 from 200 m up');
select is(private.economy_rules() -> 'detours' -> 'rewards',
  '{"common": {"gold": 600, "wood": 8, "stone": 8}, "crystal": {"crystal": 3}, "gem": {"gems": 1}}'::jsonb,
  'Rewards come from the sheet''s detour section');
select is((private.economy_rules() -> 'xp' ->> 'detour')::int, 75, 'A detour pays the sheet''s 75 XP');

-- ---------------------------------------------------------------------------
-- Spots (ingest_detour_area)
-- ---------------------------------------------------------------------------

create temp table features as
select jsonb_build_array(
  -- Kept.
  pg_temp.point('{"poi.subclass": "artwork", "name": "Short statue"}', 80, 300),
  pg_temp.point('{"poi.subclass": "artwork", "name": "Long statue"}', 400, 300),
  pg_temp.point('{"poi.subclass": "monument", "name": "Far statue"}', -1100, 300),
  pg_temp.point('{"poi.subclass": "monument", "name": "Far statue 2"}', -1100, -100),
  pg_temp.line('{"transportation.class": "path", "transportation.subclass": "footway"}', 100, 100, 200, 100),
  pg_temp.line('{"transportation.class": "minor"}', 450, 0, 450, 600),
  pg_temp.square('{"transportation.class": "path", "transportation.subclass": "pedestrian"}', -120, 300, 15),
  -- Dropped.
  pg_temp.line('{"transportation.class": "path", "transportation.subclass": "footway", "transportation.access": "no"}', 130, 450, 170, 450),
  pg_temp.line('{"transportation.class": "path", "transportation.subclass": "footway", "transportation.brunnel": "tunnel"}', 130, 500, 170, 500),
  pg_temp.line('{"transportation.class": "path", "transportation.subclass": "footway", "transportation.indoor": "1"}', 130, 550, 170, 550),
  pg_temp.line('{"transportation.class": "path", "transportation.subclass": "footway", "transportation.foot": "private"}', 130, 400, 170, 400),
  pg_temp.square('{"landuse.class": "cemetery"}', 140, 200, 20),
  pg_temp.point('{"poi.subclass": "artwork", "name": "Grave art"}', 140, 200),
  pg_temp.square('{"building.render_height": 12}', 140, 250, 10),
  pg_temp.point('{"poi.subclass": "attraction", "name": "Indoor exhibit"}', 140, 250),
  pg_temp.line('{"transportation.class": "rail", "transportation.subclass": "rail"}', 160, 600, 160, 700),
  pg_temp.line('{"transportation.class": "path", "transportation.subclass": "footway"}', 150, 620, 150, 680),
  pg_temp.point('{"poi.subclass": "waste_basket"}', 130, 50),
  pg_temp.point('{"poi.subclass": "park"}', 130, 20)
) as f;

-- Every area within 2 tiles of the origin is loaded; the features land in
-- the area that holds them.
create temp table areas as
select (x0 + dx) * 16384 + (y0 + dy) as area
from (select private.tile_of(extensions.st_transform(pg_temp.geom(0, 0), 3857), 14) / 16384 as x0,
             private.tile_of(extensions.st_transform(pg_temp.geom(0, 0), 3857), 14) % 16384 as y0) o,
  generate_series(-2, 2) dx, generate_series(-2, 2) dy;

create temp table ingested as
select area, public.ingest_detour_area(area, jsonb_build_object('features', (select f from features))) as r from areas;

select is((select sum((r ->> 'spots')::int)::int from ingested),
  (select count(*)::int from public.detour_spots), 'Every area reports the spots it stored');

select is((select jsonb_object_agg(kind, n) from (select kind, count(*) as n from public.detour_spots
           where kind <> 'street' group by kind) k),
  '{"place": 4, "path": 2, "square": 1}'::jsonb,
  'Spots: four landmarks, footway points every 50 m (100 m of footway), and the square');
-- 600 m of street sampled every 50 m gives 12 points; two can share a
-- zoom 19 tile (about 49 m here), which keeps one.
select ok((select count(*) from public.detour_spots where kind = 'street') between 10 and 12,
  'Street points every 50 m, at most one per zoom 19 tile');

select is((select array_agg(name order by name) from public.detour_spots where name is not null),
  array['Far statue', 'Far statue 2', 'Long statue', 'Short statue'], 'Named landmarks keep their names');

select is((select count(*)::int from public.detour_spots s
           where extensions.st_dwithin(s.geom::extensions.geography, pg_temp.geom(150, 450)::extensions.geography, 30)),
  0, 'No spot on a way closed to the public (access=no)');
select is((select count(*)::int from public.detour_spots s
           where extensions.st_dwithin(s.geom::extensions.geography, pg_temp.geom(150, 500)::extensions.geography, 30)),
  0, 'No spot in a tunnel');
select is((select count(*)::int from public.detour_spots s
           where extensions.st_dwithin(s.geom::extensions.geography, pg_temp.geom(150, 550)::extensions.geography, 30)),
  0, 'No spot indoors');
select is((select count(*)::int from public.detour_spots s
           where extensions.st_dwithin(s.geom::extensions.geography, pg_temp.geom(150, 400)::extensions.geography, 30)),
  0, 'No spot on a private footway');
select is((select count(*)::int from public.detour_spots where name in ('Grave art', 'Indoor exhibit')),
  0, 'No spot in a cemetery or inside a building');
select is((select count(*)::int from public.detour_spots s
           where extensions.st_dwithin(s.geom::extensions.geography, pg_temp.geom(150, 650)::extensions.geography, 40)),
  0, 'No spot next to a rail line');
select is((select count(*)::int from public.detour_spots s
           where extensions.st_dwithin(s.geom::extensions.geography, pg_temp.geom(130, 35)::extensions.geography, 25)),
  0, 'Waste baskets and unnamed parks are not spots');
select ok((select bool_and(s.id = private.tile_of(extensions.st_transform(s.geom, 3857), 19)
                       and s.area = private.tile_of(extensions.st_transform(s.geom, 3857), 14))
           from public.detour_spots s),
  'A spot''s id is its zoom 19 tile and its area the zoom 14 tile that holds it');

create temp table spots_before as select * from public.detour_spots;
select public.ingest_detour_area(area, jsonb_build_object('features', (select f from features))) from areas;
select is((select count(*)::int from (
    (select id, kind, name, geom from public.detour_spots except select id, kind, name, geom from spots_before)
    union all
    (select id, kind, name, geom from spots_before except select id, kind, name, geom from public.detour_spots)) d),
  0, 'Ingesting the same tile again gives the same spots');

select throws_ok($$select public.ingest_detour_area(1, '{"features": 3}')$$, '22023', null, 'A bad payload is refused');
select throws_ok($$select public.ingest_detour_area(-1, '{"features": []}')$$, '22023', null, 'A bad area is refused');

-- ---------------------------------------------------------------------------
-- Routes and generation (d01, zone A)
-- ---------------------------------------------------------------------------

select pg_temp.commuter(pg_temp.u(1), pg_temp.tz_a());

select ok((select count(*) from public.route_tiles where user_id = pg_temp.u(1)) > 10,
  'Walks record their route tiles');
select is((select count(distinct game_day)::int from public.route_tiles where user_id = pg_temp.u(1)), 2,
  'Route tiles are kept per game day');
select is((select source from private.detour_anchors(pg_temp.u(1), private.game_day(now(), pg_temp.tz_a()) - 1, null, null)),
  'routes', 'Tiles walked on two days are a route the player walks often');

create temp table gen as
select private.generate_detour_offers(pg_temp.u(1), pg_temp.lt(pg_temp.tz_a(), -1, '08:00')) as r;
create temp table d01_y as select private.game_day(now(), pg_temp.tz_a()) - 1 as day;

select is((select r ->> 'added' from gen), '2', 'Without a Watchtower, two offers a day');
select is((select r ->> 'gameDay' from gen), (select day::text from d01_y), 'Offers are for the game day of the call');
select is((pg_temp.offer(pg_temp.u(1), (select day from d01_y), 1)).name, 'Short statue',
  'Slot 1 is short (3 to 5 minutes) and prefers a landmark');
select is((select array[band, name] from pg_temp.offer(pg_temp.u(1), (select day from d01_y), 2)),
  case when extract(isodow from (select day from d01_y)) in (6, 7)
    then array['expedition', (pg_temp.offer(pg_temp.u(1), (select day from d01_y), 2)).name]
    else array['long', 'Long statue'] end,
  'Slot 2 is longer (10 to 15 minutes), or an expedition (30 to 40) as the last offer of a weekend day');
select ok((select name in ('Long statue', 'Far statue', 'Far statue 2') from pg_temp.offer(pg_temp.u(1), (select day from d01_y), 2)),
  'and also prefers a landmark');
select ok((select bool_and(case o.band
      when 'short' then o.added_min between 3 and 5
      when 'long' then o.added_min between 10 and 15
      else o.added_min between 30 and 40 end)
    from public.detour_offers o where o.user_id = pg_temp.u(1)),
  'Every offer''s added time fits its band');
select ok((select bool_and(o.added_min = round(o.added_m / (5 / 3.6) / 60)
                       and abs(o.added_m - 2 * f * o.off_route_m) <= 0.25)
           from public.detour_offers o, lateral (select case when o.off_route_m < 200 then 2.0 else 1.3 end as f) x
           where o.user_id = pg_temp.u(1)),
  'Added time is there and back at 2.0 times the straight line below 200 m and 1.3 beyond, at 5 km/h');
select is((select array[(off_route_m between 52 and 114)::int, added_min] from pg_temp.offer(pg_temp.u(1), (select day from d01_y), 1)),
  array[1, 4], 'The short landmark, about 90 m off the route, takes 4 minutes (it was 3 at 1.3)');
select ok((select bool_and(abs(extensions.st_distance(o.geom::extensions.geography, o.anchor::extensions.geography) - o.off_route_m) < 0.02 * o.off_route_m + 1)
           from public.detour_offers o where o.user_id = pg_temp.u(1)),
  'The distance is measured from the anchor, a point on the route');
select ok((select bool_and(extensions.st_distance(o.anchor::extensions.geography,
                             extensions.st_makeline(pg_temp.geom(0, 0), pg_temp.geom(0, 600))::extensions.geography) < 40)
           from public.detour_offers o where o.user_id = pg_temp.u(1)),
  'Anchors lie on the commute');
select ok((select bool_and(exists (select 1 from public.detour_spots s where s.id = o.spot_id and extensions.st_equals(s.geom, o.geom)))
           from public.detour_offers o where o.user_id = pg_temp.u(1)),
  'Offers sit exactly at spots');
select ok((select bool_and(o.reward = private.economy_rules() -> 'detours' -> 'rewards' -> o.reward_kind and o.xp = 75)
           from public.detour_offers o where o.user_id = pg_temp.u(1)),
  'Each offer carries its kind''s reward and 75 XP');
select is((select array[min(valid_from), max(valid_until)] from public.detour_offers where user_id = pg_temp.u(1)),
  array[pg_temp.lt(pg_temp.tz_a(), -1, '04:00'), pg_temp.lt(pg_temp.tz_a(), 0, '04:00')],
  'Offers are valid from 4 a.m. to 4 a.m. local');

create temp table d01_offers as select * from public.detour_offers where user_id = pg_temp.u(1);
select is(private.generate_detour_offers(pg_temp.u(1), pg_temp.lt(pg_temp.tz_a(), -1, '09:00')) ->> 'added', '0',
  'Generating again the same day adds nothing');
select is((select count(*)::int from (select * from public.detour_offers where user_id = pg_temp.u(1)
                                       except select * from d01_offers) d), 0,
  'and changes nothing');

-- Collecting: walk from the commute to the short offer and back.
create temp table snap (name text primary key, v jsonb);
insert into snap
select 'd01', jsonb_build_object('gold', gold, 'wood', wood, 'stone', stone, 'crystal', crystal, 'gems', gems, 'xp', ruler_xp)
from public.player_economy where user_id = pg_temp.u(1);

create temp table walk1 as
select pg_temp.track(0, 300, 140, 300, pg_temp.lt(pg_temp.tz_a(), -1, '09:00'))
  || pg_temp.slice(pg_temp.track(140, 300, 0, 300, pg_temp.lt(pg_temp.tz_a(), -1, '09:00') + interval '110 seconds'), 2, 100)
  as pts;

create temp table res1 as
select pg_temp.submit_as(pg_temp.u(1), 'd01-c-b1', 'd01-c', pg_temp.slice((select pts from walk1), 1, 12)) as a,
  pg_temp.submit_as(pg_temp.u(1), 'd01-c-b2', 'd01-c', pg_temp.slice((select pts from walk1), 13, 100)) as b,
  pg_temp.close_as(pg_temp.u(1), 'd01-c') as c;

select is((select jsonb_path_query_array(pg_temp.collected(a) || pg_temp.collected(b) || pg_temp.collected(c), '$[*].id')
           from res1),
  jsonb_build_array((pg_temp.offer(pg_temp.u(1), (select day from d01_y), 1)).id),
  'Walking within 30 m collects the offer, and the batch result says so');
select isnt((pg_temp.offer(pg_temp.u(1), (select day from d01_y), 1)).collected_at, null, 'The offer is marked collected');
select is((pg_temp.offer(pg_temp.u(1), (select day from d01_y), 2)).collected_at, null, 'The other offer is still open');
select is(pg_temp.detour_rows(pg_temp.u(1)), 1, 'One detour ledger row');
select is((select jsonb_build_object('gold', gold, 'wood', wood, 'stone', stone, 'crystal', crystal, 'gems', gems, 'xp', xp)
           from public.economy_ledger where user_id = pg_temp.u(1) and reason = 'detour'),
  (select jsonb_build_object(
     'gold', coalesce((reward ->> 'gold')::numeric, 0), 'wood', coalesce((reward ->> 'wood')::numeric, 0),
     'stone', coalesce((reward ->> 'stone')::numeric, 0), 'crystal', coalesce((reward ->> 'crystal')::numeric, 0),
     'gems', coalesce((reward ->> 'gems')::numeric, 0), 'xp', xp)
   from pg_temp.offer(pg_temp.u(1), (select day from d01_y), 1)),
  'The ledger pays exactly the offer''s reward and XP');
select is((select ref from public.economy_ledger where user_id = pg_temp.u(1) and reason = 'detour'),
  (pg_temp.offer(pg_temp.u(1), (select day from d01_y), 1)).id::text, 'The ledger row names the offer');

-- Retries.
insert into snap
select 'd01_after', jsonb_build_object('gold', gold, 'wood', wood, 'stone', stone, 'crystal', crystal, 'gems', gems, 'xp', ruler_xp)
from public.player_economy where user_id = pg_temp.u(1);

select is(pg_temp.submit_as(pg_temp.u(1), 'd01-c-b1', 'd01-c', pg_temp.slice((select pts from walk1), 1, 12)) -> 'detours',
  'null'::jsonb, 'Resending a batch collects nothing');
select is(pg_temp.submit_as(pg_temp.u(1), 'd01-c-b2', 'd01-c', pg_temp.slice((select pts from walk1), 13, 100)) -> 'detours',
  'null'::jsonb, 'Resending the batch that collected collects nothing');
select is(pg_temp.submit_as(pg_temp.u(1), 'd01-c-again', 'd01-c', (select pts from walk1)) -> 'detours',
  'null'::jsonb, 'The same points under a new batch id collect nothing');
select is(pg_temp.close_as(pg_temp.u(1), 'd01-c') -> 'detours', 'null'::jsonb, 'Closing again collects nothing');
select is(pg_temp.walk(pg_temp.u(1), 'd01-again', pg_temp.track(0, 300, 140, 300, pg_temp.lt(pg_temp.tz_a(), -1, '11:00'))),
  '[]'::jsonb, 'Walking past a collected offer again collects nothing');
select is(pg_temp.detour_rows(pg_temp.u(1)), 1, 'Still one detour ledger row');
select is((select gold - ((select v from snap where name = 'd01_after') ->> 'gold')::numeric
           from public.player_economy where user_id = pg_temp.u(1)),
  (select coalesce(sum(gold), 0) from public.economy_ledger l
   where l.user_id = pg_temp.u(1) and l.ref = 'd01-again-b1' or (l.user_id = pg_temp.u(1) and l.ref = 'close:d01-again')),
  'Only the new walk''s own pay changed the balance');
select throws_ok(
  format($$select private.credit(%L, 'detour', %L, 1, 0, 0, 0, 0, 0)$$, pg_temp.u(1),
    (pg_temp.offer(pg_temp.u(1), (select day from d01_y), 1)).id::text),
  '23505', null, 'The ledger refuses a second payment for the same offer');

-- The next day: new offers, at other spots.
select is(private.generate_detour_offers(pg_temp.u(1), pg_temp.lt(pg_temp.tz_a(), 0, '06:00')) ->> 'added', '2',
  'The next game day gets its own offers');
select is((select count(*)::int from public.detour_offers o
           where o.user_id = pg_temp.u(1) and o.game_day = (select day from d01_y) + 1
             and o.spot_id in (select spot_id from public.detour_offers where user_id = pg_temp.u(1) and game_day = (select day from d01_y))),
  0, 'A spot isn''t offered again within a week');
select ok((select bool_and(extensions.st_distance(a.geom::extensions.geography, b.geom::extensions.geography) >= 250)
           from public.detour_offers a join public.detour_offers b on a.user_id = b.user_id and a.game_day = b.game_day and a.slot < b.slot
           where a.user_id = pg_temp.u(1)),
  'Offers of one day are at least 250 m apart');

-- The app's call.
create temp table api as
select (pg_temp.act_as(pg_temp.u(1)) is not null or true) as x, public.get_detour_offers(pg_temp.tz_a()) as r;
reset role;

select is((select array(select jsonb_object_keys(r) order by 1) from api),
  array['gameDay', 'missingAreas', 'offers', 'offersPerDay', 'source', 'timeZoneAccepted', 'validFrom', 'validUntil'],
  'get_detour_offers returns the day, its offers, and where they came from');
select is((select r ->> 'gameDay' from api), (select (day + 1)::text from d01_y), 'The app sees today''s offers');
select is((select jsonb_array_length(r -> 'offers') from api), 2, 'Two offers today');
select is((select r ->> 'source' from api), 'routes', 'Placed around the player''s usual routes');
select is((select array(select jsonb_object_keys(r -> 'offers' -> 0) order by 1) from api),
  array['addedM', 'addedMin', 'anchor', 'band', 'collectedAt', 'id', 'lat', 'lng', 'name', 'offRouteM', 'reward',
        'rewardKind', 'slot', 'spotKind', 'spotSubtype', 'validFrom', 'validUntil', 'xp'],
  'Each offer has its position, added time, reward, and validity');

-- ---------------------------------------------------------------------------
-- Reordered batches and a second session (d02, zone A)
-- ---------------------------------------------------------------------------

select pg_temp.commuter(pg_temp.u(2), pg_temp.tz_a());
select private.generate_detour_offers(pg_temp.u(2), pg_temp.lt(pg_temp.tz_a(), -1, '08:00'));

-- 200 m north through the short offer (at 120 m): 15 fixes, the offer between
-- fixes 9 and 10. Sent as batches 3, 1, 2, then 2 again, then closed.
create temp table walk2 as
select pg_temp.track(0, 300, 200, 300, pg_temp.lt(pg_temp.tz_a(), -1, '09:00')) as pts;

create temp table res2 (step int, r jsonb);
insert into res2 values (1, pg_temp.submit_as(pg_temp.u(2), 'd02-b3', 'd02-s', pg_temp.slice((select pts from walk2), 11, 15)));
insert into res2 values (2, pg_temp.submit_as(pg_temp.u(2), 'd02-b1', 'd02-s', pg_temp.slice((select pts from walk2), 1, 5)));
insert into res2 values (3, pg_temp.submit_as(pg_temp.u(2), 'd02-b2', 'd02-s', pg_temp.slice((select pts from walk2), 6, 10)));
insert into res2 values (4, pg_temp.submit_as(pg_temp.u(2), 'd02-b2', 'd02-s', pg_temp.slice((select pts from walk2), 6, 10)));
insert into res2 values (5, pg_temp.close_as(pg_temp.u(2), 'd02-s'));

select is((select jsonb_agg(d -> 'id') from res2, jsonb_array_elements(pg_temp.collected(r)) d),
  jsonb_build_array((pg_temp.offer(pg_temp.u(2), private.game_day(now(), pg_temp.tz_a()) - 1, 1)).id),
  'Out-of-order batches collect the offer exactly once');
select is(pg_temp.detour_rows(pg_temp.u(2)), 1, 'One detour ledger row after reordered and repeated batches');
select is(pg_temp.walk(pg_temp.u(2), 'd02-s2', pg_temp.track(0, 300, 200, 300, pg_temp.lt(pg_temp.tz_a(), -1, '10:00'))),
  '[]'::jsonb, 'A second session past the same offer collects nothing');
select is(pg_temp.detour_rows(pg_temp.u(2)), 1, 'Still one detour ledger row');

-- ---------------------------------------------------------------------------
-- The radius and the offer time (d03, zone A)
-- ---------------------------------------------------------------------------

select pg_temp.commuter(pg_temp.u(3), pg_temp.tz_a());
select private.generate_detour_offers(pg_temp.u(3), pg_temp.lt(pg_temp.tz_a(), -1, '12:00'));

select is(pg_temp.walk(pg_temp.u(3), 'd03-early', pg_temp.track(0, 300, 200, 300, pg_temp.lt(pg_temp.tz_a(), -1, '10:00'))),
  '[]'::jsonb, 'A walk from before the offer was made doesn''t collect it, even uploaded later');
select is(pg_temp.walk(pg_temp.u(3), 'd03-far', pg_temp.track(0, 340, 200, 340, pg_temp.lt(pg_temp.tz_a(), -1, '13:00'))),
  '[]'::jsonb, 'Passing 40 m away collects nothing');
select is(jsonb_array_length(pg_temp.walk(pg_temp.u(3), 'd03-near',
    pg_temp.track(0, 320, 200, 320, pg_temp.lt(pg_temp.tz_a(), -1, '14:00')))),
  1, 'Passing 20 m away collects it');
select is(pg_temp.detour_rows(pg_temp.u(3)), 1, 'and pays once');

-- ---------------------------------------------------------------------------
-- The 4 a.m. boundary in two zones (d04 to d08). Each player gets yesterday's
-- offers, then walks past the short one around 4 a.m. today.
-- ---------------------------------------------------------------------------

select pg_temp.commuter(pg_temp.u(i), case when i <= 5 then pg_temp.tz_a() else pg_temp.tz_b() end)
from generate_series(4, 8) i;
select private.generate_detour_offers(pg_temp.u(i),
  pg_temp.lt(case when i <= 5 then pg_temp.tz_a() else pg_temp.tz_b() end, -1, '08:00'))
from generate_series(4, 8) i;

select is(jsonb_array_length(pg_temp.pass_by(pg_temp.u(4), 'd04-p', 120, 300, pg_temp.lt(pg_temp.tz_a(), 0, '03:59'))),
  1, 'Zone A: at 03:59 local, yesterday''s offer is still collectable');
select is(pg_temp.pass_by(pg_temp.u(5), 'd05-p', 120, 300, pg_temp.lt(pg_temp.tz_a(), 0, '04:01')),
  '[]'::jsonb, 'Zone A: at 04:01 local, yesterday''s offer is gone');
select is(jsonb_array_length(pg_temp.pass_by(pg_temp.u(6), 'd06-p', 120, 300, pg_temp.lt(pg_temp.tz_b(), 0, '03:59'))),
  1, 'Zone B: at 03:59 local, yesterday''s offer is still collectable');
select is(pg_temp.pass_by(pg_temp.u(7), 'd07-p', 120, 300, pg_temp.lt(pg_temp.tz_b(), 0, '04:01')),
  '[]'::jsonb, 'Zone B: at 04:01 local, yesterday''s offer is gone');
select is(pg_temp.pass_by(pg_temp.u(8), 'd08-p', 120, 300, pg_temp.lt(pg_temp.tz_a(), 0, '03:59')),
  '[]'::jsonb, 'The moment that still collects in zone A is already the next day in zone B');
select is((select array_agg(pg_temp.detour_rows(pg_temp.u(i)) order by i) from generate_series(4, 8) i),
  array[1, 0, 1, 0, 0], 'Only the walks before 4 a.m. paid');
select is((select count(*)::int from public.detour_offers
           where user_id in (pg_temp.u(5), pg_temp.u(7), pg_temp.u(8)) and collected_at is not null),
  0, 'Their offers stay uncollected');

-- ---------------------------------------------------------------------------
-- A new player (d09, zone A)
-- ---------------------------------------------------------------------------

select private.set_time_zone(pg_temp.u(9), pg_temp.tz_a(), now() - interval '1 day');
create temp table g9 as select private.generate_detour_offers(pg_temp.u(9), now()) as r;
select is((select r -> 'source' from g9), 'null'::jsonb, 'With no walks, no land, and no position, nothing is known');
select is((select r ->> 'added' from g9), '0', 'and there are no offers yet');

create temp table g9b as select private.generate_detour_offers(pg_temp.u(9), now(), pg_temp.lat(0), pg_temp.lng(300)) as r;
select is((select r ->> 'source' from g9b), 'position', 'With the app''s position, offers go around it');
select is((select r ->> 'added' from g9b), '2', 'and the empty slots fill the same day');
select ok((select bool_and(extensions.st_dwithin(anchor::extensions.geography, pg_temp.geom(0, 300)::extensions.geography, 1))
           from public.detour_offers where user_id = pg_temp.u(9)),
  'Measured from the position');

select pg_temp.walk(pg_temp.u(9), 'd09-w', pg_temp.track(0, 0, 0, 600, now() - interval '1 hour'));
select is((select source from private.detour_anchors(pg_temp.u(9), private.game_day(now(), pg_temp.tz_a()), null, null)),
  'recent', 'After a first walk, offers go around it, even walked today');
delete from public.route_tiles where user_id = pg_temp.u(9);
select is((select source from private.detour_anchors(pg_temp.u(9), private.game_day(now(), pg_temp.tz_a()), null, null)),
  'land', 'Without recent walks, offers go around the player''s land');

-- ---------------------------------------------------------------------------
-- Offers a day (d10)
-- ---------------------------------------------------------------------------

select is(private.detour_offers_per_day(pg_temp.u(10)), 2, 'Two offers a day before a Watchtower');
insert into public.player_buildings (user_id, building, level) values (pg_temp.u(10), 'watchtower', 3);
select is(private.detour_offers_per_day(pg_temp.u(10)), 3, 'Watchtower level 3: three offers a day');
update public.player_buildings set level = 7 where user_id = pg_temp.u(10);
select is(private.detour_offers_per_day(pg_temp.u(10)), 5, 'Watchtower level 7: five offers a day');

-- ---------------------------------------------------------------------------
-- Offer days in Warsaw and New York (d12, d13)
-- ---------------------------------------------------------------------------

select private.set_time_zone(pg_temp.u(12), 'Europe/Warsaw', '2026-11-01');
select private.set_time_zone(pg_temp.u(13), 'America/New_York', '2026-11-01');
create temp table g12 as
select private.generate_detour_offers(pg_temp.u(12), '2026-11-10 12:00 Europe/Warsaw', pg_temp.lat(0), pg_temp.lng(300)) as w,
  private.generate_detour_offers(pg_temp.u(13), '2026-11-10 03:30 America/New_York', pg_temp.lat(0), pg_temp.lng(300)) as ny;

select is((select array[w ->> 'gameDay', ((w ->> 'validFrom')::timestamptz = '2026-11-10 04:00 Europe/Warsaw')::text,
                        ((w ->> 'validUntil')::timestamptz = '2026-11-11 04:00 Europe/Warsaw')::text] from g12),
  array['2026-11-10', 'true', 'true'], 'Warsaw at noon: today''s offers, valid 4 a.m. to 4 a.m. Warsaw time');
select is((select array[ny ->> 'gameDay', ((ny ->> 'validFrom')::timestamptz = '2026-11-09 04:00 America/New_York')::text,
                        ((ny ->> 'validUntil')::timestamptz = '2026-11-10 04:00 America/New_York')::text] from g12),
  array['2026-11-09', 'true', 'true'], 'New York at 03:30: still the previous game day, ending at 4 a.m. New York time');

select is((select array_agg(band || ': ' || name order by slot) from public.detour_offers where user_id = pg_temp.u(12)),
  array['short: Short statue', 'long: Long statue'], 'On a weekday (Tuesday): a short offer and a longer one');

select private.set_time_zone(pg_temp.u(14), 'Europe/Warsaw', '2026-11-01');
select private.generate_detour_offers(pg_temp.u(14), '2026-11-14 12:00 Europe/Warsaw', pg_temp.lat(0), pg_temp.lng(300));
select is((select array_agg(band order by slot) from public.detour_offers where user_id = pg_temp.u(14)),
  array['short', 'expedition'], 'On a Saturday the last offer is an expedition');
select ok((select name in ('Far statue', 'Far statue 2') and added_min between 30 and 40
           from public.detour_offers where user_id = pg_temp.u(14) and slot = 2),
  'at a landmark 30 to 40 minutes away');

-- d15: from 300 m south of the short landmark, no spot is 3 to 5 minutes
-- away. The nearest is the pedestrian square 180 m off: 9 minutes at 2.0 (it
-- was 6 at 1.3). With every area loaded, the short slot takes the closest fit
-- from any band, as documented.
select private.set_time_zone(pg_temp.u(15), 'Europe/Warsaw', '2026-11-01');
select private.generate_detour_offers(pg_temp.u(15), '2026-11-10 12:00 Europe/Warsaw', pg_temp.lat(-300), pg_temp.lng(300));
select is((select array[band, spot_kind, added_min::text] from public.detour_offers where user_id = pg_temp.u(15) and slot = 1),
  array['short', 'square', '9'], 'With no spot 3 to 5 minutes away, the short slot takes the closest fit (9 minutes)');

-- ---------------------------------------------------------------------------
-- The scheduled job
-- ---------------------------------------------------------------------------

create temp view due as
select e.user_id
from public.player_economy e
where exists (select 1 from public.route_tiles r
              where r.user_id = e.user_id and r.game_day >= private.game_day(now(), e.time_zone) - 7)
  and not exists (select 1 from public.detour_days x
                  where x.user_id = e.user_id and x.game_day >= private.game_day(now(), e.time_zone));

create temp table due_before as select count(*)::int as n from due;
select ok((select n from due_before) >= 5, 'Several active players have no offers today yet');
select is(private.generate_due_detour_offers(now()), (select n from due_before),
  'The job generates for every active player without offers today');
select is((select count(*)::int from due), 0, 'Afterwards every active player has today''s offers');
select is((select count(*)::int from public.detour_offers
           where user_id = pg_temp.u(2) and game_day = private.game_day(now(), pg_temp.tz_a())), 2,
  'with the day''s offers');
select is(private.generate_due_detour_offers(now()), 0, 'Running the job again does nothing');
select is((select count(*)::int from public.detour_days where user_id = pg_temp.u(10)), 0,
  'Players who never walked are left to the app');
select is((select schedule from cron.job where jobname = 'detour-offers'), '*/15 * * * *', 'The job runs every 15 minutes');

-- ---------------------------------------------------------------------------
-- Area leases: few at once (d16 in Kassel, d17 in Gdansk, by position)
-- ---------------------------------------------------------------------------

-- Each ingest is CPU-heavy; on November 15, 2026, 8 at once timed out on the
-- hosted database. Leases are capped across all players.
insert into auth.users (id, aud, role, is_anonymous)
values (pg_temp.u(16), 'authenticated', 'authenticated', true), (pg_temp.u(17), 'authenticated', 'authenticated', true);
update public.detour_spot_areas set lease_until = null where lease_until is not null;

select is((select array[extract(epoch from lease)::int, max_areas_per_call, max_leased_areas] from private.detour_spot_settings()),
  array[60, 4, 4], 'A lease lasts 60 s; a call leases up to 4 areas, and at most 4 are leased at once');

create temp table kassel as select * from public.claim_detour_areas(pg_temp.u(16), 51.33, 9.45);
select is((select count(*)::int from kassel where request is not null), 4, 'A first call leases 4 areas');
create temp table gdansk as select * from public.claim_detour_areas(pg_temp.u(17), 54.35, 18.65);
select is((select count(*)::int from gdansk where request is not null), 0,
  'While 4 are leased, another player''s call leases none');
select is((select count(*)::int from gdansk), 4,
  'and reports the 4 areas it would have leased as busy (request null), so the app asks again later');
select is((select count(*)::int from public.claim_detour_areas(pg_temp.u(16), 51.33, 9.45) where request is not null), 0,
  'An overlapping call of the same player leases none either');

-- Two of the Kassel areas finish loading: two slots free up.
select public.ingest_detour_area(k.area, '{"features": []}') from (select area from kassel where request is not null order by area limit 1) k;
select public.fail_detour_area(k.area, 'test') from (select area from kassel where request is not null order by area desc limit 1) k;
create temp table gdansk2 as select * from public.claim_detour_areas(pg_temp.u(17), 54.35, 18.65);
select is((select count(*)::int from gdansk2 where request is not null), 2, 'Once 2 areas finish, the next call leases 2');
select is((select count(*)::int from gdansk2 where request is null), 2, 'and reports the other 2 as waiting');
select is((select count(*)::int from public.detour_spot_areas where lease_until >= now()), 4, 'Still 4 leased at once');
update public.detour_spot_areas set lease_until = null where lease_until is not null;

-- ---------------------------------------------------------------------------
-- Every balance still equals its ledger
-- ---------------------------------------------------------------------------

select is((select count(*)::int from public.player_economy e
           cross join lateral (
             select sum(gold) as gold, sum(wood) as wood, sum(stone) as stone, sum(crystal) as crystal,
               sum(gems) as gems, sum(xp) as xp
             from public.economy_ledger l where l.user_id = e.user_id) l
           where e.user_id::text like 'd0000000-%'
             and (e.gold, e.wood, e.stone, e.crystal, e.gems, e.ruler_xp)
               is distinct from (l.gold, l.wood, l.stone, l.crystal, l.gems, l.xp)),
  0, 'Balances equal the sum of their ledger rows');

-- ---------------------------------------------------------------------------
-- Privileges (d11)
-- ---------------------------------------------------------------------------

select ok(has_function_privilege('authenticated', 'public.get_detour_offers(text, float8, float8)', 'execute'),
  'Players can ask for their offers');
select ok(not has_function_privilege('anon', 'public.get_detour_offers(text, float8, float8)', 'execute'),
  'Signed-out callers can''t');
select ok(not has_function_privilege('authenticated', 'public.claim_detour_areas(uuid, float8, float8, int)', 'execute')
  and not has_function_privilege('authenticated', 'public.ingest_detour_area(bigint, jsonb)', 'execute')
  and not has_function_privilege('authenticated', 'public.fail_detour_area(bigint, text)', 'execute'),
  'Only the service role loads spots');
select ok(not has_function_privilege('authenticated', 'private.generate_detour_offers(uuid, timestamptz, float8, float8)', 'execute'),
  'Players can''t generate offers for a chosen time');
select ok(not has_table_privilege('authenticated', 'public.detour_spots', 'select')
  and not has_table_privilege('authenticated', 'public.detour_offers', 'insert')
  and not has_table_privilege('authenticated', 'public.detour_offers', 'update'),
  'Players can''t read the spot cache or write offers');

select pg_temp.act_as(pg_temp.u(11));
select is((select count(*)::int from public.detour_offers), 0, 'A player sees no one else''s offers');
reset role;
select pg_temp.act_as(pg_temp.u(1));
select is((select count(*)::int from public.detour_offers),
  (select count(*)::int from public.detour_offers o where o.user_id = pg_temp.u(1)) , 'A player sees their own offers');
reset role;

select * from finish();
rollback;
