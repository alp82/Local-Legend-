-- pgTAP tests for the 7-day cap on missed Keep tax
-- (supabase/migrations/*_keep_tax_cap.sql).
-- Run with: npx supabase test db
begin;

select plan(12);

insert into auth.users (id, aud, role, is_anonymous)
select ('70000000-0000-0000-0000-0000000000' || lpad(i::text, 2, '0'))::uuid, 'authenticated', 'authenticated', true
from generate_series(1, 5) as i;

create function pg_temp.u(i int) returns uuid language sql immutable as $$
  select ('70000000-0000-0000-0000-0000000000' || lpad(i::text, 2, '0'))::uuid
$$;

-- Every player pays their first day on Nov 1, 2026 (Keep level 1: 300 gold a day).
select private.ensure_economy(pg_temp.u(i)) from generate_series(1, 5) as i;
update public.player_economy set time_zone = 'America/Los_Angeles' where user_id = pg_temp.u(4);
select private.settle_keep_tax(pg_temp.u(i), '2026-11-01 12:00 UTC') from generate_series(1, 5) as i;

select is((select keep_tax_max_days from private.economy_placeholders()), 7, 'The cap is 7 days, kept in private.economy_placeholders()');

-- 6, 7, and 30 days since the last payment.
select is(private.settle_keep_tax(pg_temp.u(1), '2026-11-07 12:00 UTC'),
  '{"days": 6, "gold": 1800}'::jsonb, 'Back after 6 days: 6 days of tax');
select is(private.settle_keep_tax(pg_temp.u(2), '2026-11-08 12:00 UTC'),
  '{"days": 7, "gold": 2100}'::jsonb, 'Back after 7 days: 7 days of tax');
select is(private.settle_keep_tax(pg_temp.u(3), '2026-12-01 12:00 UTC'),
  '{"days": 7, "gold": 2100}'::jsonb, 'Back after 30 days: only 7 days of tax');

select is(
  (select details from public.economy_ledger where user_id = pg_temp.u(3) and reason = 'keep_tax' order by id desc limit 1),
  '{"days": 7, "owedDays": 30, "keepLevel": 1, "perDay": 300}'::jsonb,
  'The ledger records the 30 days owed and the 7 paid');
select is((select keep_tax_paid_through from public.player_economy where user_id = pg_temp.u(3)),
  date '2026-12-01', 'After the capped payment the tax is paid through today');
select is(array[
    (private.settle_keep_tax(pg_temp.u(3), '2026-12-01 20:00 UTC') ->> 'gold')::numeric,
    (private.settle_keep_tax(pg_temp.u(3), '2026-12-02 12:00 UTC') ->> 'gold')::numeric],
  array[0, 300]::numeric[], 'The capped days are gone: the same day pays nothing, the next day pays one day');
select is(
  (select gold from public.player_economy where user_id = pg_temp.u(3)),
  (select sum(gold) from public.economy_ledger where user_id = pg_temp.u(3)),
  'The balance still equals the ledger');

-- The cap counts game days, which start at 4 a.m. local (Los Angeles; its
-- first day was paid at 12:00 UTC on Nov 1, 04:00 local after daylight saving time ended, game day Nov 1).
select is(array[
    (private.settle_keep_tax(pg_temp.u(4), '2026-11-08 03:59 America/Los_Angeles') ->> 'days')::int,
    (private.settle_keep_tax(pg_temp.u(4), '2026-11-08 04:00 America/Los_Angeles') ->> 'days')::int],
  array[6, 1], 'At 03:59 on Nov 8 it''s still Nov 7 (6 days); 04:00 starts the 7th day');
select private.settle_keep_tax(pg_temp.u(4), '2026-11-16 03:59 America/Los_Angeles');
select is(
  (select details ->> 'days' from public.economy_ledger where user_id = pg_temp.u(4) and reason = 'keep_tax' order by id desc limit 1),
  '7', 'Back on Nov 16 at 03:59 (game day Nov 15, 7 days since Nov 8): 7 days');

-- Each owed day pays at the Keep level it had: a level 2 Keep pays 400 a day.
insert into public.player_buildings (user_id, building, level) values (pg_temp.u(5), 'keep', 2);
select is(private.settle_keep_tax(pg_temp.u(5), '2026-12-01 12:00 UTC'),
  '{"days": 7, "gold": 2800}'::jsonb, 'A level 2 Keep back after 30 days: 7 days at 400');

-- Building settles the tax first, so a 30-day absence followed by a Keep
-- upgrade pays the 7 days at the old level.
update public.player_economy set ruler_xp = 10000, gold = 1000000, wood = 1000, stone = 1000 where user_id = pg_temp.u(1);
select private.build(pg_temp.u(1), 'keep', 2, gen_random_uuid(), '2026-12-07 12:00 UTC');
select is(
  (select array[gold, (details ->> 'days')::numeric, (details ->> 'owedDays')::numeric]
   from public.economy_ledger where user_id = pg_temp.u(1) and reason = 'keep_tax' order by id desc limit 1),
  array[2100, 7, 30]::numeric[], 'An upgrade after 30 days away pays the 7 days at the old Keep level');

select * from finish();
rollback;
