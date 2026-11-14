-- pgTAP tests for public.player_state access rules.
-- Run with: npx supabase test db
begin;

select plan(25);

-- Fixtures: two players, created as superuser.
insert into auth.users (id, aud, role, is_anonymous)
values
  ('11111111-1111-1111-1111-111111111111', 'authenticated', 'authenticated', true),
  ('22222222-2222-2222-2222-222222222222', 'authenticated', 'authenticated', true);

-- Structure and privileges.
select has_table('public', 'player_state', 'player_state table exists');
select col_is_pk('public', 'player_state', 'user_id', 'user_id is the primary key');
select ok(
  (select relrowsecurity from pg_class where oid = 'public.player_state'::regclass),
  'RLS is enabled on player_state'
);
select table_privs_are(
  'public', 'player_state', 'anon', array[]::text[],
  'anon has no table privileges'
);
select table_privs_are(
  'public', 'player_state', 'authenticated', array['SELECT', 'INSERT', 'UPDATE'],
  'authenticated has only SELECT, INSERT, UPDATE'
);

-- Player B saves a row.
set local role authenticated;
set local request.jwt.claims = '{"sub": "22222222-2222-2222-2222-222222222222", "role": "authenticated", "is_anonymous": true}';

insert into public.player_state (state) values ('{"level": 7}');

-- Player A.
set local request.jwt.claims = '{"sub": "11111111-1111-1111-1111-111111111111", "role": "authenticated", "is_anonymous": true}';

select lives_ok(
  $$ insert into public.player_state (user_id, display_name, state)
     values ('11111111-1111-1111-1111-111111111111', 'Alice', '{"level": 1}') $$,
  'A can insert own row'
);
select results_eq(
  $$ select user_id, display_name, state from public.player_state $$,
  $$ values ('11111111-1111-1111-1111-111111111111'::uuid, 'Alice'::text, '{"level": 1}'::jsonb) $$,
  'A sees only own row'
);
select lives_ok(
  $$ insert into public.player_state (user_id, state)
     values ('11111111-1111-1111-1111-111111111111', '{"level": 2}')
     on conflict (user_id) do update set state = excluded.state $$,
  'A can upsert own row'
);
select is(
  (select state from public.player_state where user_id = '11111111-1111-1111-1111-111111111111'),
  '{"level": 2}'::jsonb,
  'A upsert updated own state'
);
select is_empty(
  $$ select 1 from public.player_state where user_id = '22222222-2222-2222-2222-222222222222' $$,
  'A cannot see B''s row'
);
select is_empty(
  $$ update public.player_state set state = '{"hacked": true}'
     where user_id = '22222222-2222-2222-2222-222222222222' returning 1 $$,
  'A cannot update B''s row'
);
select throws_ok(
  $$ insert into public.player_state (user_id, state)
     values ('22222222-2222-2222-2222-222222222222', '{"hacked": true}') $$,
  '42501', null,
  'A cannot insert a row with B''s user_id'
);
select throws_ok(
  $$ insert into public.player_state (user_id, state)
     values ('22222222-2222-2222-2222-222222222222', '{"hacked": true}')
     on conflict (user_id) do update set state = excluded.state $$,
  '42501', null,
  'A cannot upsert onto B''s row'
);
select throws_ok(
  $$ update public.player_state set user_id = '22222222-2222-2222-2222-222222222222'
     where user_id = '11111111-1111-1111-1111-111111111111' $$,
  '42501', null,
  'A cannot change user_id to B''s'
);
select throws_ok(
  $$ delete from public.player_state $$,
  '42501', null,
  'A cannot delete rows (no DELETE privilege)'
);

-- display_name check.
select throws_ok(
  $$ update public.player_state set display_name = '   ' $$,
  '23514', null,
  'display_name of only whitespace is rejected'
);
select throws_ok(
  $$ update public.player_state set display_name = repeat('x', 33) $$,
  '23514', null,
  'display_name longer than 32 characters is rejected'
);
select lives_ok(
  $$ update public.player_state set display_name = '  ' || repeat('x', 32) || '  ' $$,
  'display_name of 32 characters plus surrounding spaces is accepted'
);
select lives_ok(
  $$ update public.player_state set display_name = null $$,
  'display_name can be null'
);

-- Anonymous (signed-out) role gets nothing.
set local role anon;
set local request.jwt.claims = '{"role": "anon"}';

select throws_ok(
  $$ select * from public.player_state $$,
  '42501', null,
  'anon cannot select'
);
select throws_ok(
  $$ insert into public.player_state (user_id) values ('11111111-1111-1111-1111-111111111111') $$,
  '42501', null,
  'anon cannot insert'
);

-- Back to superuser to check rows were not changed by the failed attempts.
reset role;

select is(
  (select state from public.player_state where user_id = '22222222-2222-2222-2222-222222222222'),
  '{"level": 7}'::jsonb,
  'B''s row is unchanged'
);
select is(
  (select count(*)::int from public.player_state),
  2,
  'both rows still exist'
);

-- updated_at trigger. now() is fixed within a transaction, so backdate first.
update public.player_state
set created_at = '2020-01-01', updated_at = '2020-01-01'
where user_id = '11111111-1111-1111-1111-111111111111';

update public.player_state
set state = '{"level": 3}'
where user_id = '11111111-1111-1111-1111-111111111111';

select is(
  (select updated_at from public.player_state where user_id = '11111111-1111-1111-1111-111111111111'),
  now(),
  'updated_at is set to now() on update'
);
select is(
  (select created_at from public.player_state where user_id = '11111111-1111-1111-1111-111111111111'),
  '2020-01-01'::timestamptz,
  'created_at is unchanged on update'
);

select * from finish();
rollback;
