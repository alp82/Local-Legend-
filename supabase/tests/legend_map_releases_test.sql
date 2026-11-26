-- pgTAP tests for Legend map releases (20261126150000_fantasy_releases.sql): the worker's start-up call adopts,
-- carries on, stages a new version for every known area, rolls back, resumes or abandons a release; leasing
-- follows the painter fingerprint (and refuses workers without one once it's recorded); the switch waits for
-- the staged version and is held when too little of it painted; each version keeps its WebP quality; a rollback
-- queues what players viewed on the version being left; replaced versions are marked, then cleaned up after the
-- grace period, through the Storage API only, and never rolled back to; players can't touch any of it.
-- Run with: npx supabase test db
begin;

select plan(52);

insert into auth.users (id, aud, role, is_anonymous, raw_app_meta_data)
values
  ('e1000000-0000-0000-0000-000000000001', 'authenticated', 'authenticated', false, '{"legend_map_renderer": true}'),
  ('e1000000-0000-0000-0000-000000000002', 'authenticated', 'authenticated', true, '{}');

create function pg_temp.as_user(uid uuid, app jsonb) returns void language sql as $$
  select set_config('role', 'authenticated', true),
    set_config('request.jwt.claims', json_build_object('sub', uid, 'role', 'authenticated', 'app_metadata', app)::text, true);
$$;
create function pg_temp.as_renderer() returns void language sql as $$
  select pg_temp.as_user('e1000000-0000-0000-0000-000000000001', '{"provider": "email", "legend_map_renderer": true}');
$$;
create function pg_temp.as_player() returns void language sql as $$
  select pg_temp.as_user('e1000000-0000-0000-0000-000000000002', '{"provider": "anonymous"}');
$$;
create function pg_temp.as_postgres() returns void language sql as $$
  select set_config('role', 'postgres', true), set_config('request.jwt.claims', '', true);
$$;
-- the claim cell in the middle of z16 tile (x, y)
create function pg_temp.cell(x int, y int) returns bigint language sql immutable as $$
  select (x::bigint * 32 + 16) * 2097152 + (y::bigint * 32 + 16)
$$;

-- A live version 1 painted before releases existed: no fingerprint recorded.
-- (an empty bucket: this transaction is rolled back, the files stay)
select set_config('storage.allow_delete_query', 'true', true);
delete from storage.objects where bucket_id = 'legend-map-tiles';
select set_config('storage.allow_delete_query', 'false', true);
delete from public.legend_map_tiles;
delete from public.legend_map_versions;
delete from public.legend_map_requests;
delete from public.legend_map_daily;
update public.legend_map_config set enabled = true, version = 1, fingerprint = null, staging_version = null,
  staging_fingerprint = null, staging_started_at = null, release_buffer_m = 0, release_recent = interval '30 days',
  version_grace = interval '7 days', max_attempts = 3, min_request_interval = interval '0',
  daily_tiles_per_player = 300, global_daily_tiles = 2000, max_queue_depth = 500, near_player_m = 2000;
-- the player's land: one tile (no buffer), so the known areas are that tile, its z15 parent and the recent tiles
insert into public.claimed_cells (user_id, cell, first_claimed_at) values ('e1000000-0000-0000-0000-000000000002', pg_temp.cell(35209, 21498), now());
insert into public.legend_map_tiles (version, z, x, y, status, requested_at, last_requested_at) values
  (1, 16, 35209, 21498, 'ready', now() - interval '90 days', now()),           -- on the land
  (1, 16, 40000, 20000, 'ready', now() - interval '90 days', now() - interval '60 days'), -- not seen for 60 days
  (1, 16, 40001, 20000, 'ready', now() - interval '90 days', now() - interval '1 day');   -- seen yesterday

-- ---------------------------------------------------------------------------
-- Grants
-- ---------------------------------------------------------------------------

select is(has_function_privilege('anon', 'public.begin_legend_map_release(text)', 'execute'), false, 'Anonymous callers have no grant on begin_legend_map_release');
select is(has_function_privilege('anon', 'public.advance_legend_map_release()', 'execute'), false, 'nor on advance_legend_map_release');
select is(has_function_privilege('anon', 'public.legend_map_cleanup_candidates(integer)', 'execute'), false, 'nor on legend_map_cleanup_candidates');
select is(has_function_privilege('anon', 'public.legend_map_forget_versions()', 'execute'), false, 'nor on legend_map_forget_versions');
select is(has_function_privilege('authenticated', 'private.legend_map_queue_known(integer, smallint, integer)', 'execute'), false, 'The queueing helper is private');
select pg_temp.as_player();
select throws_ok($$select public.begin_legend_map_release('aaaaaaaaaaaaaaaa')$$, '42501', null, 'A player cannot start a release');
select throws_ok($$select public.advance_legend_map_release()$$, '42501', null, 'nor switch versions');
select throws_ok($$select public.legend_map_cleanup_candidates()$$, '42501', null, 'nor list files to delete');
select throws_ok($$select public.legend_map_forget_versions()$$, '42501', null, 'nor forget versions');
select throws_ok($$select * from public.legend_map_versions$$, '42501', null, 'nor read the versions');

-- ---------------------------------------------------------------------------
-- Adopt, carry on, stage
-- ---------------------------------------------------------------------------

select pg_temp.as_renderer();
select throws_ok($$select public.begin_legend_map_release('not-a-fingerprint')$$, '22023', null, 'A fingerprint is 16 hex digits');
select is(public.begin_legend_map_release('aaaaaaaaaaaaaaaa') ->> 'action', 'adopted', 'The first worker adopts the live version as its own');
select is(public.begin_legend_map_release('aaaaaaaaaaaaaaaa') - 'abandoned', '{"action": "current", "version": 1}'::jsonb, 'The same painter again: nothing to do');
select throws_ok($$select * from public.lease_legend_map_tiles(1)$$, '42501', null, 'Once a fingerprint is recorded, a worker without one gets no tiles');

select is(public.begin_legend_map_release('bbbbbbbbbbbbbbbb') - 'replaced', '{"action": "staging", "version": 2, "queued": 3}'::jsonb,
  'A new painter stages version 2 for every known area');
select pg_temp.as_postgres();
select results_eq($$select z, x, priority from public.legend_map_tiles where version = 2 order by z desc, x$$,
  $$values (16::smallint, 35209, 2::smallint), (16::smallint, 40001, 2::smallint), (15::smallint, 17604, 2::smallint)$$,
  'Staged: the land, its z15 parent and the tile seen yesterday, not the one unseen for 60 days');
select results_eq($$select version, fingerprint, staging_version, staging_fingerprint from public.legend_map_config$$,
  $$values (1, 'aaaaaaaaaaaaaaaa', 2, 'bbbbbbbbbbbbbbbb')$$, 'Phones keep version 1 while version 2 is painted');
select is((public.legend_map_status() -> 'staging' ->> 'remaining')::int, 3, 'The status shows the release');

-- leasing follows the painter
insert into public.legend_map_tiles (version, z, x, y) values (1, 16, 50000, 20000);
select pg_temp.as_renderer();
select is((select count(*)::int from public.lease_legend_map_tiles(64, 'cccccccccccccccc')), 0, 'A painter that painted neither version leases nothing');
select results_eq($$select version, x from public.lease_legend_map_tiles(64, 'aaaaaaaaaaaaaaaa')$$, $$values (1, 50000)$$,
  'The live painter leases only live tiles');
select pg_temp.as_postgres();
update public.legend_map_config set webp_quality = 0.9 where id;
select pg_temp.as_renderer();
select results_eq($$select version, webp_quality from public.lease_legend_map_tiles(64, 'bbbbbbbbbbbbbbbb')$$, $$values (2, 0.75::real), (2, 0.75::real), (2, 0.75::real)$$,
  'The staged painter leases the staged tiles, at the quality the version started with');
select pg_temp.as_postgres();
update public.legend_map_config set webp_quality = 0.75 where id;
update public.legend_map_tiles set status = 'queued', lease_until = null, attempts = 0 where version in (1, 2);

-- players' new tiles go to the staged version
select pg_temp.as_player();
select is(public.request_legend_map_tiles('[[16, 35210, 21498]]') ->> 'queued', '1', 'A player''s new tile during a release is queued');
select pg_temp.as_postgres();
select results_eq($$select version, priority from public.legend_map_tiles where x = 35210$$, $$values (2, 1::smallint)$$,
  'into the staged version, at the player''s priority');
select is((select last_requested_at > now() - interval '1 minute' from public.legend_map_tiles where version = 1 and x = 35209), true,
  'Requests keep track of what phones still look at');

-- ---------------------------------------------------------------------------
-- The switch
-- ---------------------------------------------------------------------------

select pg_temp.as_renderer();
select is(public.advance_legend_map_release(), '{"staging": true, "version": 2, "remaining": 4, "blocked": false, "reason": null}'::jsonb, 'No switch while tiles remain');
select pg_temp.as_postgres();
-- the reviewer's case: a painter that fails every tile at run time
update public.legend_map_tiles set status = 'failed', attempts = 3 where version = 2;
select pg_temp.as_renderer();
select is(public.advance_legend_map_release() - 'reason', '{"staging": true, "version": 2, "remaining": 0, "blocked": true}'::jsonb,
  'A painter that failed every tile never switches phones');
select pg_temp.as_postgres();
select is(public.legend_map_status() -> 'staging' ->> 'reason', 'no staged tile was painted (4 given up)', 'The status says why the release is held');
-- one of four given up: more than release_max_given_up_share (1%)
update public.legend_map_tiles set status = 'ready' where version = 2 and x <> 40001;
select pg_temp.as_renderer();
select is((public.advance_legend_map_release() ->> 'blocked')::boolean, true, 'Too many tiles given up (1 of 4) still holds it');
select pg_temp.as_postgres();
select matches(public.legend_map_status() -> 'staging' ->> 'reason', 'release_max_given_up_share', 'naming the limit');
update public.legend_map_config set release_max_given_up_share = 0.5 where id;
select pg_temp.as_renderer();
select is(public.advance_legend_map_release(), '{"switched": true, "from": 1, "to": 2}'::jsonb, 'Within the limits it switches once nothing is left');
select is(public.advance_legend_map_release(), '{"staging": false}'::jsonb, 'Then no release');
select pg_temp.as_postgres();
select results_eq($$select version, fingerprint, staging_version from public.legend_map_config$$, $$values (2, 'bbbbbbbbbbbbbbbb', null::int)$$,
  'Phones now get version 2');
select results_eq($$select version, released_at is not null, retired_at is not null from public.legend_map_versions order by version$$,
  $$values (1, true, true), (2, true, false)$$, 'Version 1 is retired, version 2 released');

-- ---------------------------------------------------------------------------
-- Rollback, roll forward, abandon, resume
-- ---------------------------------------------------------------------------

select pg_temp.as_renderer();
select is(public.begin_legend_map_release('aaaaaaaaaaaaaaaa') - 'queued', '{"action": "rolled_back", "version": 1, "from": 2}'::jsonb,
  'The previous image again: phones go straight back to version 1');
select pg_temp.as_postgres();
select results_eq($$select version, fingerprint from public.legend_map_config$$, $$values (1, 'aaaaaaaaaaaaaaaa')$$, 'Version 1 is live again');
select results_eq($$select z, x, priority from public.legend_map_tiles where version = 1 and priority = 2 and status = 'queued' order by z desc, x$$,
  $$values (16::smallint, 35210, 2::smallint), (15::smallint, 17604, 2::smallint)$$,
  'and what players viewed on version 2 that version 1 lacks is queued, behind players'' own requests');
select pg_temp.as_renderer();
select is(public.begin_legend_map_release('bbbbbbbbbbbbbbbb') ->> 'action', 'rolled_back', 'The newer image again: straight back to version 2');
select is(public.begin_legend_map_release('cccccccccccccccc') ->> 'version', '3', 'A third painter stages version 3');
select is(public.begin_legend_map_release('bbbbbbbbbbbbbbbb') ->> 'abandoned', '3', 'The live painter back before the switch abandons it');
select is(public.begin_legend_map_release('cccccccccccccccc') - 'queued' - 'replaced', '{"action": "staging", "version": 3}'::jsonb,
  'Deployed again, the abandoned release resumes in version 3, not a new one');

-- ---------------------------------------------------------------------------
-- Cleanup
-- ---------------------------------------------------------------------------

select pg_temp.as_postgres();
update public.legend_map_versions set retired_at = now() - interval '8 days' where version = 1;
insert into storage.objects (bucket_id, name) values ('legend-map-tiles', 'v1/16/1/1.webp'), ('legend-map-tiles', 'v2/16/1/1.webp'), ('legend-map-tiles', 'v3/16/1/1.webp');
select is(public.legend_map_object_deletable('v1/16/1/1.webp'), true, 'A version retired longer than the grace period may go');
select is(public.legend_map_object_deletable('v2/16/1/1.webp'), false, 'The live version may not');
select is(public.legend_map_object_deletable('v3/16/1/1.webp'), false, 'nor the staged one');
select is(public.legend_map_object_deletable('index.html'), false, 'nor anything else');
select is(public.legend_map_object_deletable('v1/../v2/16/1/1.webp'), false, 'nor a path that only starts like a deletable one');
select pg_temp.as_renderer();
select results_eq($$select * from public.legend_map_cleanup_candidates()$$, $$values ('v1/16/1/1.webp'::text)$$, 'The worker is told to delete version 1''s files');
select is(public.legend_map_forget_versions(), '{}'::int[], 'A version is forgotten only once its files are gone');
select is(public.begin_legend_map_release('aaaaaaaaaaaaaaaa') - 'queued' - 'replaced', '{"action": "staging", "version": 4}'::jsonb,
  'Its painter deployed again while its files are being deleted: a fresh version, not a rollback into holes');
select is(public.begin_legend_map_release('cccccccccccccccc') ->> 'version', '3', '(and back to the release under test)');
-- the Storage API's delete (it sets storage.allow_delete_query), as the renderer: only deletable files go
select set_config('storage.allow_delete_query', 'true', true);
delete from storage.objects where bucket_id = 'legend-map-tiles' and name in ('v1/16/1/1.webp', 'v2/16/1/1.webp');
select pg_temp.as_postgres();
select results_eq($$select name from storage.objects where bucket_id = 'legend-map-tiles' and name like 'v_/%' order by name$$,
  $$values ('v2/16/1/1.webp'::text), ('v3/16/1/1.webp'::text)$$, 'The renderer could delete version 1''s file and not version 2''s');
select pg_temp.as_renderer();
select is(public.legend_map_forget_versions(), '{1}'::int[], 'Then version 1 is forgotten');
select pg_temp.as_postgres();
select is((select count(*)::int from public.legend_map_tiles where version = 1), 0, 'with its rows');

select * from finish();
rollback;
