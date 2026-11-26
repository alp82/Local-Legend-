-- pgTAP tests for the rename to the Legend map (20261126200000_legend_map_rename.sql): nothing
-- keeps the earlier name except the compatibility layer; the earlier renderer flag and the earlier
-- function names still work for app versions and the worker image from before the rename; the new
-- bucket has the old one's rules; and only a complete, checked copy points those app versions at
-- the new bucket.
-- Run with: npx supabase test db
begin;

select plan(40);

insert into auth.users (id, aud, role, is_anonymous, raw_app_meta_data)
values
  ('e1000000-0000-0000-0000-000000000001', 'authenticated', 'authenticated', false, '{"fantasy_renderer": true}'),
  ('e1000000-0000-0000-0000-000000000002', 'authenticated', 'authenticated', true, '{}');

create function pg_temp.as_user(uid uuid, app jsonb)
returns void
language sql
as $$
  select set_config('role', 'authenticated', true),
    set_config('request.jwt.claims', json_build_object('sub', uid, 'role', 'authenticated', 'app_metadata', app)::text, true);
$$;

-- the renderer user as it is before the cut-over: flagged with the earlier name only
create function pg_temp.as_old_renderer() returns void language sql as $$
  select pg_temp.as_user('e1000000-0000-0000-0000-000000000001', '{"provider": "email", "fantasy_renderer": true}');
$$;

create function pg_temp.as_player() returns void language sql as $$
  select pg_temp.as_user('e1000000-0000-0000-0000-000000000002', '{"provider": "anonymous"}');
$$;

create function pg_temp.as_postgres() returns void language sql as $$
  select set_config('role', 'postgres', true), set_config('request.jwt.claims', '', true);
$$;

create function pg_temp.put(p_bucket text, p_name text, p_size int) returns void language sql as $$
  insert into storage.objects (bucket_id, name, metadata)
  values (p_bucket, p_name, jsonb_build_object('size', p_size, 'mimetype', 'image/webp'));
$$;

delete from public.legend_map_tiles;
update public.legend_map_config set enabled = true, version = 1, fingerprint = null, staging_version = null,
  staging_fingerprint = null, staging_started_at = null, min_request_interval = interval '0', old_app_bucket = 'fantasy-tiles'
where id;

-- ---------------------------------------------------------------------------
-- Nothing keeps the earlier name but the compatibility layer
-- ---------------------------------------------------------------------------

select is(
  (select count(*)::int from pg_class c join pg_namespace n on n.oid = c.relnamespace
   where c.relname ilike '%fantasy%' and n.nspname not in ('pg_catalog', 'information_schema')),
  0, 'No table, index or sequence has the earlier name');
select is(
  (select count(*)::int from pg_constraint where conname ilike '%fantasy%'), 0, 'No constraint has the earlier name');
select set_eq(
  $$select p.oid::regprocedure::text from pg_proc p where p.proname ilike '%fantasy%'$$,
  array['get_fantasy_config()', 'request_fantasy_tiles(jsonb,integer)', 'lease_fantasy_tiles(integer,text)',
    'finish_fantasy_tile(integer,integer,integer,integer,boolean,integer,integer,text)',
    'queue_fantasy_tiles(jsonb,boolean)', 'fantasy_status()'],
  'Only the six compatibility wrappers keep an earlier function name');
select is(
  (select count(*)::int from pg_policies where policyname ilike '%fantasy%'), 0, 'No policy has the earlier name');
select set_eq(
  $$select policyname::text from pg_policies where schemaname = 'storage' and tablename = 'objects'
    and (qual ilike '%fantasy-tiles%' or with_check ilike '%fantasy-tiles%')$$,
  array['Legend map renderer reads the old bucket', 'Legend map renderer writes the old bucket',
    'Legend map renderer replaces in the old bucket'],
  'Only the three compatibility policies mention the old bucket (none deletes there)');

-- ---------------------------------------------------------------------------
-- The new bucket has the old one's rules
-- ---------------------------------------------------------------------------

select results_eq(
  $$select public, file_size_limit, allowed_mime_types from storage.buckets where id = 'legend-map-tiles'$$,
  $$select public, file_size_limit, allowed_mime_types from storage.buckets where id = 'fantasy-tiles'$$,
  'The new bucket is public with the old bucket''s size limit and file types');
select set_eq(
  $$select cmd || ':' || policyname from pg_policies where schemaname = 'storage' and tablename = 'objects'
    and (qual ilike '%legend-map-tiles%' or with_check ilike '%legend-map-tiles%')$$,
  array['SELECT:Legend map renderer reads tiles', 'INSERT:Legend map renderer writes tiles',
    'UPDATE:Legend map renderer replaces tiles', 'DELETE:Legend map renderer deletes replaced versions'],
  'The new bucket has the four renderer policies');
select ok(
  (select strpos(with_check, '^v[0-9]{1,6}/1[56]/[0-9]{1,5}/[0-9]{1,5}\.(webp|json)$') > 0 from pg_policies
   where policyname = 'Legend map renderer writes tiles'),
  'and writes there are limited to tile paths');
select ok(
  (select qual like '%legend_map_object_deletable(name)%' from pg_policies where policyname = 'Legend map renderer deletes replaced versions'),
  'and deletes to versions past their grace period');

-- ---------------------------------------------------------------------------
-- The earlier flag and the earlier names still work
-- ---------------------------------------------------------------------------

select pg_temp.as_old_renderer();
select is(public.is_legend_map_renderer(), true, 'The renderer flagged with the earlier name still counts');
select pg_temp.as_user('e1000000-0000-0000-0000-000000000001', '{"legend_map_renderer": true}');
select is(public.is_legend_map_renderer(), true, 'and so does the new flag');
select pg_temp.as_user('e1000000-0000-0000-0000-000000000001', '{"fantasy_renderer": false}');
select is(public.is_legend_map_renderer(), false, 'A false flag does not');

select pg_temp.as_player();
select is(public.is_legend_map_renderer(), false, 'A player is not the renderer');
select is(public.get_legend_map_config() ->> 'bucket', 'legend-map-tiles', 'The new config names the new bucket');
select is(public.get_fantasy_config() ->> 'bucket', 'fantasy-tiles', 'The earlier config names the old bucket until the copy is checked');
select is(public.get_fantasy_config() - 'bucket', public.get_legend_map_config() - 'bucket', 'and otherwise says the same');
select is(
  public.request_fantasy_tiles('[[16, 1, 1]]'::jsonb, 1) - 'queued' - 'far' - 'pending' - 'ready' - 'capped' - 'reason',
  jsonb_build_object('enabled', true, 'version', 1),
  'A player still requests tiles under the earlier name');
select is(
  public.request_legend_map_tiles('[[16, 1, 1]]'::jsonb, 1) - 'queued' - 'far' - 'pending' - 'ready' - 'capped' - 'reason',
  jsonb_build_object('enabled', true, 'version', 1),
  'and under the new name');
select throws_ok($$select * from public.lease_fantasy_tiles(5)$$, '42501', null, 'A player cannot lease under the earlier name');
select throws_ok($$select public.finish_fantasy_tile(1, 16, 1, 1, true)$$, '42501', null, 'nor finish');
select throws_ok($$select public.queue_fantasy_tiles('[[16, 1, 1]]'::jsonb)$$, '42501', null, 'nor queue');
select throws_ok($$select public.fantasy_status()$$, '42501', null, 'nor read the status');

select pg_temp.as_postgres();
select is(has_function_privilege('anon', 'public.get_fantasy_config()', 'execute'), false, 'Anonymous callers have no grant on get_fantasy_config');
select is(has_function_privilege('anon', 'public.request_fantasy_tiles(jsonb, integer)', 'execute'), false, 'nor on request_fantasy_tiles');
select is(has_function_privilege('anon', 'public.lease_fantasy_tiles(integer, text)', 'execute'), false, 'nor on lease_fantasy_tiles');
select is(has_function_privilege('anon', 'public.finish_legend_map_bucket_copy()', 'execute'), false, 'nor on finish_legend_map_bucket_copy');
insert into public.legend_map_tiles (version, z, x, y) values (1, 16, 2, 2);

-- The worker image from before the rename: no fingerprint, the earlier names, the earlier flag.
select pg_temp.as_old_renderer();
select is((select count(*)::int from public.lease_fantasy_tiles(5)), 1, 'The worker from before the rename leases under the earlier name (no fingerprint recorded yet)');
select lives_ok($$select public.finish_fantasy_tile(1, 16, 2, 2, true, 1000, 50)$$, 'and finishes a tile');
select is(public.fantasy_status() -> 'painted' ->> 'total', '1', 'and reads the status');
select is(public.queue_fantasy_tiles('[[16, 3, 3]]'::jsonb) ->> 'queued', '1', 'and queues tiles');
select pg_temp.as_postgres();
update public.legend_map_config set fingerprint = 'ea50df47c283491d' where id;
select pg_temp.as_old_renderer();
select throws_ok($$select * from public.lease_fantasy_tiles(5)$$, '42501', null,
  'Once a painter fingerprint is recorded, that worker gets nothing (as before the rename)');

-- ---------------------------------------------------------------------------
-- The copy into the new bucket
-- ---------------------------------------------------------------------------

select pg_temp.as_postgres();
select is((select count(*)::int from storage.objects where bucket_id in ('fantasy-tiles', 'legend-map-tiles')), 0,
  'The tile buckets start empty in this test');
select pg_temp.put('fantasy-tiles', 'v1/16/2/2.webp', 1000);
select pg_temp.put('fantasy-tiles', 'v1/16/2/2.json', 80);
select pg_temp.put('fantasy-tiles', 'v1/15/1/1.webp', 3000);
select pg_temp.put('legend-map-tiles', 'v1/16/2/2.webp', 1000);
select pg_temp.put('legend-map-tiles', 'v1/16/2/2.json', 79);   -- a broken copy: wrong size

select pg_temp.as_player();
select throws_ok($$select * from public.legend_map_bucket_copy_candidates()$$, '42501', null, 'A player cannot list the copy');
select throws_ok($$select public.finish_legend_map_bucket_copy()$$, '42501', null, 'nor switch the old app''s bucket');

select pg_temp.as_old_renderer();
select set_eq($$select name from public.legend_map_bucket_copy_candidates()$$, array['v1/15/1/1.webp', 'v1/16/2/2.json'],
  'The copy lists files missing from the new bucket or of another size');
select is(public.finish_legend_map_bucket_copy(), '{"switched": false, "objects": 3, "bytes": 4080, "copied": 1}'::jsonb,
  'An incomplete copy does not switch');

select pg_temp.as_postgres();
update storage.objects set metadata = metadata || '{"size": 80}' where bucket_id = 'legend-map-tiles' and name = 'v1/16/2/2.json';
select pg_temp.put('legend-map-tiles', 'v1/15/1/1.webp', 3000);
select pg_temp.as_old_renderer();
select is(public.finish_legend_map_bucket_copy(), '{"switched": true, "objects": 3, "bytes": 4080, "copied": 3}'::jsonb,
  'A complete copy (every file, same sizes) switches');
select is(public.get_fantasy_config() ->> 'bucket', 'legend-map-tiles', 'and the earlier config then names the new bucket');
select is((select count(*)::int from public.legend_map_bucket_copy_candidates()), 0, 'Nothing is left to copy');
select is(public.finish_legend_map_bucket_copy(), '{"switched": false, "already": true}'::jsonb, 'and checking again changes nothing');

select * from finish();
rollback;
