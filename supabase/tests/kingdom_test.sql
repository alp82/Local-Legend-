-- pgTAP tests for the kingdom: construction costs and XP, the daily
-- construction limit across the 4 a.m. reset and time zone changes, Keep and
-- Ruler level gates, retries, Pikemen and their weekly growth, Treasury caps,
-- the Keep tax at the Keep's level, and privileges.
-- Run with: npx supabase test db
begin;

select plan(99);

insert into auth.users (id, aud, role, is_anonymous)
select ('c0000000-0000-0000-0000-0000000000' || lpad(i::text, 2, '0'))::uuid, 'authenticated', 'authenticated', true
from generate_series(1, 14) as i;

-- c01: costs and retries. c02, c03: the daily limit in two time zones. c04,
-- c05: the daily limit across a time zone change. c06, c07: gates and
-- shortfalls. c08: Treasury caps. c09: the Keep tax. c10, c11: Pikemen. c12:
-- privileges. c13: the public API. c14: input errors.

-- ---------------------------------------------------------------------------
-- Helpers
-- ---------------------------------------------------------------------------

create function pg_temp.u(n int)
returns uuid
language sql
immutable
as $$
  select ('c0000000-0000-0000-0000-0000000000' || lpad(n::text, 2, '0'))::uuid
$$;

-- Request id n.
create function pg_temp.r(n int)
returns uuid
language sql
immutable
as $$
  select ('d0000000-0000-0000-0000-' || lpad(n::text, 12, '0'))::uuid
$$;

-- Creates the economy row (UTC unless tz) and adds resources and XP through
-- the ledger, as a walk would.
create function pg_temp.give(who uuid, gold numeric, wood numeric, stone numeric,
  crystal numeric default 0, gems numeric default 0, xp numeric default 0)
returns void
language plpgsql
as $$
begin
  perform private.ensure_economy(who);
  perform private.credit(who, 'walk', 'test', gold, wood, stone, crystal, gems, xp);
end;
$$;

create function pg_temp.set_zone(who uuid, tz text)
returns void
language sql
as $$
  select private.ensure_economy(who);
  update public.player_economy set time_zone = tz where user_id = who;
$$;

create function pg_temp.bal(who uuid)
returns jsonb
language sql
as $$
  select jsonb_build_object('gold', gold, 'wood', wood, 'stone', stone, 'crystal', crystal, 'gems', gems, 'xp', ruler_xp)
  from public.player_economy where user_id = who
$$;

-- What a build or recruit result says, without the details.
create function pg_temp.outcome(result jsonb)
returns text
language sql
immutable
as $$
  select case when (result ->> 'ok')::boolean then 'ok' else result ->> 'reason' end
$$;

create function pg_temp.build(who uuid, building text, level int, req int, at timestamptz)
returns jsonb
language sql
as $$
  select private.build(who, building, level, pg_temp.r(req), at)
$$;

create function pg_temp.recruit(who uuid, n int, req int, at timestamptz)
returns jsonb
language sql
as $$
  select private.recruit(who, 'pikeman', n, pg_temp.r(req), at)
$$;

create function pg_temp.pool(who uuid, at timestamptz)
returns jsonb
language sql
as $$
  select private.kingdom_json(who, at) -> 'recruits' -> 'pikeman'
$$;

create function pg_temp.act_as(who uuid)
returns void
language sql
as $$
  select set_config('role', 'authenticated', true),
    set_config('request.jwt.claims', json_build_object('sub', who, 'role', 'authenticated')::text, true)
$$;

-- ---------------------------------------------------------------------------
-- Costs, XP, and retries (c01, UTC)
-- ---------------------------------------------------------------------------

-- Start: 2,000 gold, 20 wood, 20 stone. Building settles the day's Keep tax
-- (300) first. Treasury level 1 costs 700 gold, 5 wood, 10 stone, and pays 75 XP.
select is(pg_temp.build(pg_temp.u(1), 'treasury', 1, 101, '2026-11-16 10:00 UTC') - 'rulerLevel' - 'levelUp',
  '{"ok": true, "duplicate": false, "building": "treasury", "level": 1, "xp": 75,
    "cost": {"gold": 700, "wood": 5, "stone": 10, "crystal": 0, "gems": 0}}'::jsonb,
  'Building pays the level''s cost from the rules and reports its XP');
select is(pg_temp.bal(pg_temp.u(1)),
  '{"gold": 1600, "wood": 15, "stone": 10, "crystal": 0, "gems": 0, "xp": 75}'::jsonb,
  'Balances drop by the cost and Ruler XP rises by the construction XP');
select is((select level from public.player_buildings where user_id = pg_temp.u(1) and building = 'treasury'), 1,
  'The Treasury is at level 1');

select is(pg_temp.build(pg_temp.u(1), 'treasury', 1, 101, '2026-11-16 10:01 UTC') ->> 'duplicate', 'true',
  'A retried request returns the first result as a duplicate');
select is(pg_temp.build(pg_temp.u(1), 'treasury', 1, 101, '2026-11-17 10:00 UTC') ->> 'duplicate', 'true',
  'A request retried on a later day is still a duplicate');
select is(pg_temp.bal(pg_temp.u(1)),
  '{"gold": 1600, "wood": 15, "stone": 10, "crystal": 0, "gems": 0, "xp": 75}'::jsonb,
  'Retries spend nothing and pay no XP or tax');
select is((select count(*)::int from public.kingdom_actions where user_id = pg_temp.u(1)), 1,
  'Retries record no action');
select is((select count(*)::int from public.economy_ledger where user_id = pg_temp.u(1) and reason = 'build'), 1,
  'Retries write no ledger row');

select is(pg_temp.outcome(pg_temp.build(pg_temp.u(1), 'treasury', 1, 102, '2026-11-17 10:00 UTC')), 'already_built',
  'A new request for a level already built fails, even on a day that can build');
select is(pg_temp.outcome(pg_temp.build(pg_temp.u(1), 'treasury', 3, 103, '2026-11-17 10:00 UTC')), 'not_next_level',
  'A request for a level past the next one fails');
select is((select level from public.player_buildings where user_id = pg_temp.u(1) and building = 'treasury'), 1,
  'Failed requests build nothing');
select pg_temp.give(pg_temp.u(1), 0, 0, 100);
select is(pg_temp.outcome(pg_temp.build(pg_temp.u(1), 'walls', 1, 104, '2026-11-17 10:00 UTC')), 'ok',
  'Failed requests don''t use up the day''s construction');

-- ---------------------------------------------------------------------------
-- The daily limit across the 4 a.m. reset (c02 Warsaw, c03 New York)
-- ---------------------------------------------------------------------------

select pg_temp.set_zone(pg_temp.u(2), 'Europe/Warsaw');
select pg_temp.give(pg_temp.u(2), 10000, 100, 100);

select is(pg_temp.outcome(pg_temp.build(pg_temp.u(2), 'walls', 1, 201, '2026-11-10 12:00 Europe/Warsaw')), 'ok',
  'Warsaw: first construction of the day');
select is(pg_temp.outcome(pg_temp.build(pg_temp.u(2), 'barracks', 1, 202, '2026-11-10 23:59 Europe/Warsaw')), 'daily_limit',
  'Warsaw: a second construction the same evening fails');
select is(pg_temp.build(pg_temp.u(2), 'barracks', 1, 203, '2026-11-11 03:59 Europe/Warsaw') - 'building' - 'level',
  jsonb_build_object('ok', false, 'reason', 'daily_limit', 'nextBuildAt', '2026-11-11 04:00 Europe/Warsaw'::timestamptz),
  'Warsaw: 03:59 is still the same game day and says when the next construction opens');
select is(pg_temp.outcome(pg_temp.build(pg_temp.u(2), 'barracks', 1, 204, '2026-11-11 04:00 Europe/Warsaw')), 'ok',
  'Warsaw: 04:00 opens the next construction');
select is(pg_temp.outcome(pg_temp.build(pg_temp.u(2), 'treasury', 1, 205, '2026-11-12 03:59 Europe/Warsaw')), 'daily_limit',
  'Warsaw: one construction per game day, again');
select is(pg_temp.outcome(pg_temp.build(pg_temp.u(2), 'treasury', 1, 206, '2026-11-12 04:00 Europe/Warsaw')), 'ok',
  'Warsaw: and again at 04:00');
select is(pg_temp.bal(pg_temp.u(2)) - 'xp',
  jsonb_build_object('gold', 12000 + 3 * 300 - 700 - 850 - 700, 'wood', 120 - 4 - 7 - 5, 'stone', 120 - 16 - 10 - 10,
    'crystal', 0, 'gems', 0),
  'Warsaw: three constructions spent exactly their costs, plus three days of Keep tax');

-- New York: the US leaves daylight saving time on November 1, 2026. The game
-- day still ends at 04:00 local.
select pg_temp.set_zone(pg_temp.u(3), 'America/New_York');
select pg_temp.give(pg_temp.u(3), 0, 0, 100);
select is(pg_temp.outcome(pg_temp.build(pg_temp.u(3), 'walls', 1, 301, '2026-10-31 12:00 America/New_York')), 'ok',
  'New York: first construction');
select is(pg_temp.outcome(pg_temp.build(pg_temp.u(3), 'barracks', 1, 302, '2026-11-01 03:59 America/New_York')), 'daily_limit',
  'New York: 03:59 on the night the clocks change is still the same game day');
select is(pg_temp.outcome(pg_temp.build(pg_temp.u(3), 'barracks', 1, 303, '2026-11-01 04:00 America/New_York')), 'ok',
  'New York: 04:00 local opens the next construction');

-- ---------------------------------------------------------------------------
-- The daily limit across a time zone change (c04 west, c05 east)
-- ---------------------------------------------------------------------------

-- c04 builds in Kiritimati (UTC+14), then moves to Los Angeles (UTC-8), where
-- the clock is a day behind.
select pg_temp.give(pg_temp.u(4), 0, 0, 100);
select is(private.set_time_zone(pg_temp.u(4), 'Pacific/Kiritimati', '2026-11-09 00:00 UTC'), true, 'c04 starts in Kiritimati');
select is(pg_temp.outcome(pg_temp.build(pg_temp.u(4), 'walls', 1, 401, '2026-11-10 15:00 UTC')), 'ok',
  'West: builds at 05:00 on November 11 in Kiritimati');
select is(private.set_time_zone(pg_temp.u(4), 'America/Los_Angeles', '2026-11-10 15:30 UTC'), true,
  'West: moves to Los Angeles, where it is 07:30 on November 10');
select is(private.kingdom_json(pg_temp.u(4), '2026-11-10 15:30 UTC') ->> 'gameDay', '2026-11-11',
  'West: the kingdom''s day doesn''t go back after the move');
select is(pg_temp.build(pg_temp.u(4), 'barracks', 1, 402, '2026-11-10 15:30 UTC') - 'building' - 'level',
  jsonb_build_object('ok', false, 'reason', 'daily_limit', 'nextBuildAt', '2026-11-12 04:00 America/Los_Angeles'::timestamptz),
  'West: the earlier local day can''t build again');
select is(pg_temp.outcome(pg_temp.build(pg_temp.u(4), 'barracks', 1, 403, '2026-11-11 04:00 America/Los_Angeles')), 'daily_limit',
  'West: November 11 in Los Angeles is the day that already built');
select is(pg_temp.outcome(pg_temp.build(pg_temp.u(4), 'barracks', 1, 404, '2026-11-12 04:00 America/Los_Angeles')), 'ok',
  'West: November 12 builds');
select is(private.set_time_zone(pg_temp.u(4), 'Pacific/Kiritimati', '2026-11-11 00:00 UTC'), false,
  'West: switching back within 24 hours is ignored');

-- c05 builds in Los Angeles, then moves to Kiritimati, where the clock is a
-- day ahead.
select pg_temp.give(pg_temp.u(5), 0, 0, 100);
select is(private.set_time_zone(pg_temp.u(5), 'America/Los_Angeles', '2026-11-09 00:00 UTC'), true, 'c05 starts in Los Angeles');
select is(pg_temp.outcome(pg_temp.build(pg_temp.u(5), 'walls', 1, 501, '2026-11-10 04:00 America/Los_Angeles')), 'ok',
  'East: builds at 04:00 on November 10 in Los Angeles');
select is(private.set_time_zone(pg_temp.u(5), 'Pacific/Kiritimati', '2026-11-10 13:00 UTC'), true,
  'East: moves to Kiritimati, where it is 03:00 on November 11');
select is(pg_temp.outcome(pg_temp.build(pg_temp.u(5), 'barracks', 1, 502, '2026-11-10 13:00 UTC')), 'daily_limit',
  'East: before 04:00 it is still November 10, which already built');
select is(pg_temp.outcome(pg_temp.build(pg_temp.u(5), 'barracks', 1, 503, '2026-11-11 04:00 Pacific/Kiritimati')), 'ok',
  'East: 04:00 on November 11 builds');
select is(
  (select count(*)::int from (
     select user_id, game_day from public.kingdom_actions where kind = 'build'
     group by user_id, game_day having count(*) > 1) d),
  0, 'No player built twice on one game day');

-- ---------------------------------------------------------------------------
-- Keep and Ruler level gates, the top level, and shortfalls (c06, c07)
-- ---------------------------------------------------------------------------

-- No Treasury, so no caps.
select pg_temp.give(pg_temp.u(6), 100000, 1000, 1000, 100);
select is(pg_temp.build(pg_temp.u(6), 'keep', 2, 601, '2026-11-10 12:00 UTC') - 'building',
  '{"ok": false, "reason": "ruler_level", "level": 2, "required": 4, "current": 1}'::jsonb,
  'Keep level 2 needs Ruler level 4');
select is(pg_temp.outcome(pg_temp.build(pg_temp.u(6), 'walls', 1, 602, '2026-11-10 12:00 UTC')), 'ok',
  'Walls level 1 needs only Ruler and Keep level 1');
-- Walls gave 75 XP; top up to exactly Ruler level 4 (750 XP).
select private.credit(pg_temp.u(6), 'walk', 'test', 0, 0, 0, 0, 0, 750 - 75);
select is(pg_temp.build(pg_temp.u(6), 'walls', 2, 603, '2026-11-11 12:00 UTC') - 'building',
  '{"ok": false, "reason": "keep_level", "level": 2, "required": 2, "current": 1}'::jsonb,
  'Walls can''t pass the Keep''s level');
select is(pg_temp.outcome(pg_temp.build(pg_temp.u(6), 'keep', 2, 604, '2026-11-11 12:00 UTC')), 'ok',
  'Keep level 2 builds at Ruler level 4');
select is(pg_temp.build(pg_temp.u(6), 'keep', 3, 605, '2026-11-12 12:00 UTC') - 'building',
  '{"ok": false, "reason": "ruler_level", "level": 3, "required": 7, "current": 4}'::jsonb,
  'Keep level 3 needs Ruler level 7');
select is(pg_temp.outcome(pg_temp.build(pg_temp.u(6), 'walls', 2, 606, '2026-11-12 12:00 UTC')), 'ok',
  'Walls level 2 builds once the Keep is level 2');
select private.credit(pg_temp.u(6), 'walk', 'test', 0, 0, 0, 0, 0, 5000);
select is(pg_temp.build(pg_temp.u(6), 'walls', 3, 607, '2026-11-13 12:00 UTC') - 'building',
  '{"ok": false, "reason": "keep_level", "level": 3, "required": 3, "current": 2}'::jsonb,
  'With Ruler level 7, Walls level 3 still waits for the Keep');
insert into public.player_buildings (user_id, building, level) values (pg_temp.u(6), 'barracks', 7);
select is(pg_temp.outcome(pg_temp.build(pg_temp.u(6), 'barracks', 8, 608, '2026-11-13 12:00 UTC')), 'max_level',
  'Nothing builds past its top level');

-- c07: 2,300 gold, 20 wood, 20 stone after the first tax. Barracks level 1
-- takes 10 stone; Walls level 1 needs 16.
select is(pg_temp.outcome(pg_temp.build(pg_temp.u(7), 'barracks', 1, 701, '2026-11-10 12:00 UTC')), 'ok', 'c07 builds a Barracks');
select is(pg_temp.build(pg_temp.u(7), 'walls', 1, 702, '2026-11-11 12:00 UTC') - 'building' - 'level',
  '{"ok": false, "reason": "not_enough", "missing": {"stone": 6}}'::jsonb,
  'Building without enough stone fails and says what''s missing');
select is((select stone from public.player_economy where user_id = pg_temp.u(7)), 10.0, 'The failed construction spent nothing');

-- ---------------------------------------------------------------------------
-- Treasury caps (c08, UTC)
-- ---------------------------------------------------------------------------

select pg_temp.give(pg_temp.u(8), 10000, 100, 0);
select is(pg_temp.bal(pg_temp.u(8)) ->> 'gold', '12000.000000', 'Without a Treasury, nothing is capped');
select is(pg_temp.outcome(pg_temp.build(pg_temp.u(8), 'treasury', 1, 801, '2026-11-10 12:00 UTC')), 'ok', 'c08 builds a Treasury');
-- Level 1 caps: 5,000 gold, 60 wood, 60 stone. Now 11,600 gold, 115 wood, 10 stone.
select pg_temp.give(pg_temp.u(8), 500, 10, 100, 7);
select is(pg_temp.bal(pg_temp.u(8)) - 'xp',
  '{"gold": 11600, "wood": 115, "stone": 60, "crystal": 7, "gems": 0}'::jsonb,
  'With a Treasury, pay fills stone up to its cap, keeps balances saved above a cap, and never caps crystal');
select is((select details -> 'capped' from public.economy_ledger where user_id = pg_temp.u(8) order by id desc limit 1),
  '{"gold": 500, "wood": 10, "stone": 50}'::jsonb, 'The ledger records what the Treasury couldn''t hold');
select private.credit(pg_temp.u(8), 'walk', 'test', -7000, 0, 0, 0, 0, 0);
select is(pg_temp.bal(pg_temp.u(8)) ->> 'gold', '4600.000000', 'Spending is never capped');
select pg_temp.give(pg_temp.u(8), 1000, 0, 0);
select is(pg_temp.bal(pg_temp.u(8)) ->> 'gold', '5000.000000', 'Pay fills gold up to the cap exactly');
select private.settle_keep_tax(pg_temp.u(8), '2026-11-11 12:00 UTC');
select is((select gold from public.economy_ledger where user_id = pg_temp.u(8) and reason = 'keep_tax' order by id desc limit 1),
  0.0, 'A full Treasury holds no Keep tax');
update public.player_buildings set level = 2 where user_id = pg_temp.u(8) and building = 'treasury';
select pg_temp.give(pg_temp.u(8), 5000, 0, 0);
select is(pg_temp.bal(pg_temp.u(8)) ->> 'gold', '6800.000000', 'A higher Treasury level raises the cap');
select is(private.kingdom_json(pg_temp.u(8), '2026-11-11 12:00 UTC') -> 'caps',
  '{"goldCap": 6800, "woodCap": 81, "stoneCap": 81}'::jsonb, 'The kingdom reports the caps');

-- ---------------------------------------------------------------------------
-- The Keep tax at the Keep's level (c09, UTC)
-- ---------------------------------------------------------------------------

select pg_temp.give(pg_temp.u(9), 10000, 100, 100, 0, 0, 750);
select private.settle_keep_tax(pg_temp.u(9), '2026-11-10 12:00 UTC');
select is(pg_temp.outcome(pg_temp.build(pg_temp.u(9), 'keep', 2, 901, '2026-11-13 12:00 UTC')), 'ok',
  'c09 builds Keep level 2 three days later');
select private.settle_keep_tax(pg_temp.u(9), '2026-11-14 12:00 UTC');
select is(
  (select array_agg(gold order by id) from public.economy_ledger where user_id = pg_temp.u(9) and reason = 'keep_tax'),
  array[300, 900, 400]::numeric[],
  'Days before the upgrade pay 300 each when building; the day after pays Keep level 2''s 400');

-- ---------------------------------------------------------------------------
-- Pikemen (c10 Warsaw, c11 New York)
-- ---------------------------------------------------------------------------

select pg_temp.set_zone(pg_temp.u(10), 'Europe/Warsaw');
select pg_temp.give(pg_temp.u(10), 5000, 100, 100);
select is(pg_temp.recruit(pg_temp.u(10), 1, 1001, '2026-11-10 12:00 Europe/Warsaw') - 'unit',
  '{"ok": false, "reason": "needs_building", "building": "barracks", "required": 1}'::jsonb,
  'Pikemen need a Barracks');
-- Wednesday.
select is(pg_temp.outcome(pg_temp.build(pg_temp.u(10), 'barracks', 1, 1002, '2026-11-11 12:00 Europe/Warsaw')), 'ok',
  'c10 builds a Barracks on Wednesday');
select is(pg_temp.pool(pg_temp.u(10), '2026-11-11 12:00 Europe/Warsaw'),
  '{"available": 14, "thisWeek": 14, "lastWeek": 0}'::jsonb,
  'The week the Barracks is built, its 14 weekly recruits appear at once');
select is(pg_temp.recruit(pg_temp.u(10), 10, 1003, '2026-11-11 13:00 Europe/Warsaw'),
  '{"ok": true, "duplicate": false, "unit": "pikeman", "count": 10, "garrison": 10,
    "cost": {"gold": 600, "wood": 0, "stone": 0, "crystal": 0, "gems": 0}}'::jsonb,
  'Recruiting 10 Pikemen costs 600 gold');
-- 7,000 gold, plus two days of tax, minus 850 for the Barracks, is 6,750.
select is((pg_temp.bal(pg_temp.u(10)) ->> 'gold')::numeric, 6750.0 - 600, 'Recruiting spent the gold');
select is(pg_temp.recruit(pg_temp.u(10), 10, 1003, '2026-11-11 13:05 Europe/Warsaw') ->> 'duplicate', 'true',
  'A retried recruitment returns the first result as a duplicate');
select is(
  array[(pg_temp.bal(pg_temp.u(10)) ->> 'gold')::numeric,
        (select count from public.player_garrison where user_id = pg_temp.u(10) and unit = 'pikeman')::numeric],
  array[6150, 10]::numeric[],
  'A retried recruitment spends nothing and adds no Pikemen');
select is(pg_temp.recruit(pg_temp.u(10), 5, 1004, '2026-11-12 12:00 Europe/Warsaw') - 'unit',
  '{"ok": false, "reason": "not_enough_recruits", "available": 4}'::jsonb,
  'Only the week''s recruits can be recruited');
select is(pg_temp.pool(pg_temp.u(10), '2026-11-16 03:59 Europe/Warsaw') ->> 'available', '4',
  'Monday 03:59 is still last week');
select is(pg_temp.pool(pg_temp.u(10), '2026-11-16 04:00 Europe/Warsaw'),
  '{"available": 18, "thisWeek": 14, "lastWeek": 4}'::jsonb,
  'Monday 04:00 brings 14 new recruits; last week''s 4 carry over');
select is(pg_temp.outcome(pg_temp.recruit(pg_temp.u(10), 6, 1005, '2026-11-16 05:00 Europe/Warsaw')), 'ok',
  'c10 recruits 6');
select is((select batches from public.kingdom_actions where request_id = pg_temp.r(1005)),
  '{"2026-11-09": 4, "2026-11-16": 2}'::jsonb, 'Recruiting takes last week''s recruits first');
select is(pg_temp.pool(pg_temp.u(10), '2026-11-23 04:00 Europe/Warsaw'),
  '{"available": 26, "thisWeek": 14, "lastWeek": 12}'::jsonb, 'The next Monday, 12 unrecruited carry over');
select is(pg_temp.pool(pg_temp.u(10), '2026-11-30 04:00 Europe/Warsaw'),
  '{"available": 28, "thisWeek": 14, "lastWeek": 14}'::jsonb, 'Recruits carry over only one extra week');
select private.credit(pg_temp.u(10), 'walk', 'test', 0, 0, 0, 0, 0, 750);
select is(pg_temp.outcome(pg_temp.build(pg_temp.u(10), 'keep', 2, 1006, '2026-11-30 12:00 Europe/Warsaw')), 'ok', 'c10 builds Keep level 2');
select is(pg_temp.outcome(pg_temp.build(pg_temp.u(10), 'barracks', 2, 1007, '2026-12-02 12:00 Europe/Warsaw')), 'ok',
  'c10 builds Barracks level 2 on Wednesday');
select is(pg_temp.pool(pg_temp.u(10), '2026-12-02 12:00 Europe/Warsaw') ->> 'available', '28',
  'An upgrade doesn''t change the current week''s recruits');
select is(pg_temp.pool(pg_temp.u(10), '2026-12-07 04:00 Europe/Warsaw'),
  '{"available": 32, "thisWeek": 18, "lastWeek": 14}'::jsonb,
  'From the next Monday, Barracks level 2 grows ROUND(14 × 1.25) = 18 a week');
select is((select count from public.player_garrison where user_id = pg_temp.u(10) and unit = 'pikeman'), 16,
  'The garrison holds every Pikeman recruited');

-- c11: the Monday boundary in New York, and running out of gold.
select pg_temp.set_zone(pg_temp.u(11), 'America/New_York');
select is(pg_temp.outcome(pg_temp.build(pg_temp.u(11), 'barracks', 1, 1101, '2026-11-14 12:00 America/New_York')), 'ok',
  'c11 builds a Barracks on Saturday');
select is(pg_temp.outcome(pg_temp.recruit(pg_temp.u(11), 14, 1102, '2026-11-14 13:00 America/New_York')), 'ok', 'c11 recruits all 14');
select is(pg_temp.recruit(pg_temp.u(11), 1, 1103, '2026-11-16 03:59 America/New_York') ->> 'available', '0',
  'New York: no recruits before Monday 04:00 local');
select is(pg_temp.pool(pg_temp.u(11), '2026-11-16 04:00 America/New_York') ->> 'available', '14',
  'New York: Monday 04:00 local brings the new week''s recruits');
select private.settle_keep_tax(pg_temp.u(11), '2026-11-16 04:00 America/New_York');
select private.credit(pg_temp.u(11), 'walk', 'test', 100 - gold, 0, 0, 0, 0, 0) from public.player_economy where user_id = pg_temp.u(11);
select is(pg_temp.recruit(pg_temp.u(11), 2, 1104, '2026-11-16 04:00 America/New_York') - 'unit' - 'count',
  '{"ok": false, "reason": "not_enough", "missing": {"gold": 20}}'::jsonb,
  'Recruiting without enough gold fails and says what''s missing');
select is((select count from public.player_garrison where user_id = pg_temp.u(11) and unit = 'pikeman'), 14,
  'The failed recruitment added no Pikemen');

-- ---------------------------------------------------------------------------
-- The public API: what the app calls after a restart (c13)
-- ---------------------------------------------------------------------------

select pg_temp.act_as(pg_temp.u(13));
select is(public.get_kingdom('Europe/Warsaw') -> 'kingdom' -> 'buildings',
  '{"keep": 1, "treasury": 0, "walls": 0, "barracks": 0}'::jsonb, 'A new kingdom has only the Keep, at level 1');
select is(public.build_building('walls', 1, pg_temp.r(1301)) ->> 'ok', 'true', 'build_building builds');
select is(
  (select jsonb_build_object('buildsToday', k -> 'buildsToday', 'walls', k -> 'buildings' -> 'walls', 'blocked', k ? 'nextBuildAt' and k ->> 'nextBuildAt' is not null)
   from (select public.get_kingdom('Europe/Warsaw') -> 'kingdom' as k) x),
  '{"buildsToday": 1, "walls": 1, "blocked": true}'::jsonb,
  'Reloading the kingdom shows the day''s construction as used');
select is(public.build_building('barracks', 1, pg_temp.r(1302)) ->> 'reason', 'daily_limit',
  'A second construction after a reload still fails');
select is(public.build_building('walls', 1, pg_temp.r(1301)) -> 'economy' -> 'resources' ->> 'gold', '1600',
  'A retried request after a reload returns the balances once spent');
select set_config('role', 'postgres', true);

-- ---------------------------------------------------------------------------
-- Input errors (c14)
-- ---------------------------------------------------------------------------

select throws_ok($$select private.build('c0000000-0000-0000-0000-000000000014', 'stable', 1, gen_random_uuid(), now())$$,
  '22023', null, 'Only the four plots can be built');
select throws_ok($$select private.build('c0000000-0000-0000-0000-000000000014', 'walls', 1, null, now())$$,
  '22023', null, 'Building needs a request id');
select throws_ok($$select private.recruit('c0000000-0000-0000-0000-000000000014', 'archer', 1, gen_random_uuid(), now())$$,
  '22023', null, 'Only Pikemen can be recruited');
select throws_ok($$select private.recruit('c0000000-0000-0000-0000-000000000014', 'pikeman', 0, gen_random_uuid(), now())$$,
  '22023', null, 'Recruiting needs a positive count');

-- ---------------------------------------------------------------------------
-- Ledger and privileges (c12)
-- ---------------------------------------------------------------------------

select is(
  (select count(*)::int
   from public.player_economy e
   join (select user_id, sum(gold) g, sum(wood) w, sum(stone) s, sum(crystal) c, sum(gems) m, sum(xp) x
         from public.economy_ledger group by user_id) l on l.user_id = e.user_id
   where (e.gold, e.wood, e.stone, e.crystal, e.gems, e.ruler_xp) is distinct from (l.g, l.w, l.s, l.c, l.m, l.x)),
  0, 'Every balance still equals the sum of its ledger');

select pg_temp.act_as(pg_temp.u(12));
select is((select count(*)::int from public.kingdom_actions), 0, 'A player sees no one else''s kingdom actions');
select is((select count(*)::int from public.player_buildings), 0, 'A player sees no one else''s buildings');
select throws_ok($$insert into public.player_buildings (user_id, building, level) values (auth.uid(), 'keep', 10)$$,
  '42501', null, 'Players can''t write buildings');
select throws_ok($$update public.player_garrison set count = 1000$$, '42501', null, 'Players can''t write the garrison');
select throws_ok($$select private.build(auth.uid(), 'walls', 1, gen_random_uuid(), now())$$, '42501', null,
  'Players can''t call the private kingdom functions');
select set_config('role', 'anon', true);
select throws_ok($$select public.build_building('walls', 1, gen_random_uuid())$$, '42501', null,
  'Signed-out callers can''t build');
select set_config('role', 'postgres', true);

select * from finish();
rollback;
