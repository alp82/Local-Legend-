-- pgTAP tests for the fantasy renderer's own credential: only the user flagged
-- fantasy_renderer in app_metadata (or the service role) leases, finishes and queues
-- tiles, reads the status, and writes tile and label files to the fantasy-tiles bucket, at
-- tile paths only; players can't, and the renderer gains nothing through player functions.
-- Run with: npx supabase test db
begin;

select plan(37);

insert into auth.users (id, aud, role, is_anonymous, raw_app_meta_data)
values
  ('e0000000-0000-0000-0000-000000000001', 'authenticated', 'authenticated', false, '{"fantasy_renderer": true}'),
  ('e0000000-0000-0000-0000-000000000002', 'authenticated', 'authenticated', true, '{}');

-- The JWT carries app_metadata, as GoTrue issues it.
create function pg_temp.as_user(uid uuid, app jsonb)
returns void
language sql
as $$
  select set_config('role', 'authenticated', true),
    set_config('request.jwt.claims', json_build_object('sub', uid, 'role', 'authenticated', 'app_metadata', app)::text, true);
$$;

create function pg_temp.as_renderer() returns void language sql as $$
  select pg_temp.as_user('e0000000-0000-0000-0000-000000000001', '{"provider": "email", "fantasy_renderer": true}');
$$;

create function pg_temp.as_player() returns void language sql as $$
  select pg_temp.as_user('e0000000-0000-0000-0000-000000000002', '{"provider": "anonymous"}');
$$;

create function pg_temp.as_postgres() returns void language sql as $$
  select set_config('role', 'postgres', true), set_config('request.jwt.claims', '', true);
$$;

delete from public.fantasy_tiles;
update public.fantasy_config set enabled = true, version = 1, max_attempts = 3, retry_after = interval '10 minutes',
  min_request_interval = interval '0', daily_tiles_per_player = 300, global_daily_tiles = 2000, max_queue_depth = 500;

-- ---------------------------------------------------------------------------
-- Grants: none of the renderer functions is callable without signing in
-- ---------------------------------------------------------------------------

select is(has_function_privilege('anon', 'public.lease_fantasy_tiles(integer)', 'execute'), false, 'Anonymous callers have no grant on lease_fantasy_tiles');
select is(has_function_privilege('anon', 'public.finish_fantasy_tile(integer, integer, integer, integer, boolean, integer, integer, text)', 'execute'), false, 'Anonymous callers have no grant on finish_fantasy_tile');
select is(has_function_privilege('anon', 'public.queue_fantasy_tiles(jsonb, boolean)', 'execute'), false, 'Anonymous callers have no grant on queue_fantasy_tiles');
select is(has_function_privilege('anon', 'public.fantasy_status()', 'execute'), false, 'Anonymous callers have no grant on fantasy_status');
select is(has_function_privilege('anon', 'public.is_fantasy_renderer()', 'execute'), false, 'Anonymous callers have no grant on is_fantasy_renderer');

-- ---------------------------------------------------------------------------
-- Players
-- ---------------------------------------------------------------------------

select pg_temp.as_player();
select is(public.is_fantasy_renderer(), false, 'A player is not the renderer');
select throws_ok($$select * from public.lease_fantasy_tiles(1)$$, '42501', null, 'A player cannot lease tiles');
select throws_ok($$select public.finish_fantasy_tile(1, 16, 1, 1, true)$$, '42501', null, 'A player cannot finish tiles');
select throws_ok($$select public.queue_fantasy_tiles('[[16, 1, 1]]')$$, '42501', null, 'A player cannot queue pre-painting');
select throws_ok($$select public.fantasy_status()$$, '42501', null, 'A player cannot read the status');
select throws_ok(
  $$insert into storage.objects (bucket_id, name) values ('fantasy-tiles', 'v1/16/1/1.webp')$$,
  '42501', null, 'A player cannot upload a tile');

-- A player who sets their own user_metadata gains nothing: only app_metadata counts.
select pg_temp.as_user('e0000000-0000-0000-0000-000000000002', '{}');
select set_config('request.jwt.claims', json_build_object('sub', 'e0000000-0000-0000-0000-000000000002', 'role', 'authenticated',
  'user_metadata', json_build_object('fantasy_renderer', true))::text, true);
select is(public.is_fantasy_renderer(), false, 'user_metadata does not make a renderer');

select set_config('role', 'anon', true), set_config('request.jwt.claims', '{"role": "anon"}', true);
select throws_ok($$select public.is_fantasy_renderer()$$, '42501', null, 'Anonymous callers cannot even ask');

-- ---------------------------------------------------------------------------
-- The renderer
-- ---------------------------------------------------------------------------

select pg_temp.as_renderer();
select is(public.is_fantasy_renderer(), true, 'The flagged user is the renderer');
select is(
  public.queue_fantasy_tiles('[[16, 35209, 21498], [16, 35210, 21498], [15, 17604, 10749]]', true),
  '{"version": 1, "queued": 3, "existing": 0, "dry_run": true}'::jsonb,
  'A dry run counts the new tiles and queues nothing');
select is(
  public.queue_fantasy_tiles('[[16, 35209, 21498], [16, 35210, 21498], [16, 35210, 21498], [15, 17604, 10749]]'),
  '{"version": 1, "queued": 3, "existing": 0}'::jsonb,
  'Pre-painting queues new tiles once');
select is(
  public.queue_fantasy_tiles('[[16, 35209, 21498], [16, 1, 1]]'),
  '{"version": 1, "queued": 1, "existing": 1}'::jsonb,
  'Tiles already known are not queued again');
select throws_ok($$select public.queue_fantasy_tiles('[[14, 1, 1]]')$$, '22023', null, 'Zoom 14 is refused');
select throws_ok(
  $$select public.queue_fantasy_tiles((select jsonb_agg(jsonb_build_array(16, i, 1)) from generate_series(1, 5001) i))$$,
  '22023', null, 'More than 5000 tiles are refused');

select pg_temp.as_postgres();
select is((select count(*)::int from public.fantasy_tiles where priority = 2), 4, 'Pre-painted tiles have priority 2');
select is((public.fantasy_status() -> 'limits' ->> 'queue_depth')::int, 0, 'Pre-painting doesn''t count toward the players'' queue depth');
insert into public.fantasy_tiles (version, z, x, y, priority) values (1, 16, 500, 500, 0);

select pg_temp.as_renderer();
select results_eq($$select x from public.lease_fantasy_tiles(1)$$, $$values (500)$$, 'A tile on screen goes before pre-painting');
select is((select count(*)::int from public.lease_fantasy_tiles(64)), 4, 'Then the pre-painting');
select lives_ok($$select public.finish_fantasy_tile(1, 16, 500, 500, true, 140000, 900)$$, 'The renderer finishes a tile');
select lives_ok($$select public.finish_fantasy_tile(1, 16, 1, 1, false, p_error => 'source data failed twice')$$, 'and reports a failure');

select is((public.fantasy_status() -> 'queue' ->> 'painting')::int, 3, 'The status counts tiles being painted');
select is(public.fantasy_status() -> 'last_error' ->> 'error', 'source data failed twice', 'The status shows the last error');
select is((public.fantasy_status() -> 'painted' ->> 'total')::int, 1, 'The status counts painted tiles');

select lives_ok(
  $$insert into storage.objects (bucket_id, name) values ('fantasy-tiles', 'v1/16/500/500.webp')$$,
  'The renderer uploads a tile');
select lives_ok(
  $$insert into storage.objects (bucket_id, name) values ('fantasy-tiles', 'v12/15/250/250.json')$$,
  'and a label file, at any version, at z15');
select throws_ok(
  $$insert into storage.objects (bucket_id, name) values ('fantasy-tiles', 'index.html')$$,
  '42501', null, 'The renderer cannot write any other name');
select throws_ok(
  $$insert into storage.objects (bucket_id, name) values ('fantasy-tiles', 'v1/14/1/1.webp')$$,
  '42501', null, 'nor a zoom it doesn''t paint');
select throws_ok(
  $$insert into storage.objects (bucket_id, name) values ('fantasy-tiles', 'v1/16/1/1.webp.html')$$,
  '42501', null, 'nor another file type behind a tile name');
select throws_ok(
  $$insert into storage.objects (bucket_id, name) values ('fantasy-tiles', 'v1/16/1/../../x.webp')$$,
  '42501', null, 'nor a path that climbs out');

-- Through player functions the renderer gains nothing: it has no ground of its own.
select is(public.request_fantasy_tiles('[[16, 35209, 21490], [16, 40000, 20000]]') - 'pending' - 'ready',
  '{"enabled": true, "version": 1, "queued": 0, "capped": false, "reason": null, "far": 2}'::jsonb,
  'Asking like a player queues nothing for the renderer');
select throws_ok($$select * from public.fantasy_tiles$$, '42501', null, 'The renderer cannot read the tile table directly');
select is((public.fantasy_status() -> 'limits' ->> 'global_daily_tiles')::int, 2000, 'The status shows the limits');

select * from finish();
rollback;
