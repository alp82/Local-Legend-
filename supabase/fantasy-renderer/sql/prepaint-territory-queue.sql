-- Pre-painting the testers' areas, step 2 of 2: queue the tiles. Writes to the queue only.
--
-- The same tiles as prepaint-territory-count.sql (within about 1 km of any claimed land),
-- queued at the lowest priority (2, after every player request) for the current tile version.
-- Run step 1 first and check its estimate. Only totals come out.
--
--   npx supabase db query --remote -f supabase/fantasy-renderer/sql/prepaint-territory-queue.sql
--
-- The worker leases in arrival order and, at the same time, z16 before z15, so the children
-- are painted before their parents, which then only need scaling down.
with buffer as (select 1000.0 as metres),
cfg as (select version from public.fantasy_config),
cells as (
  select distinct (cell / 2097152) >> 5 as tx, (cell % 2097152) >> 5 as ty
  from public.claimed_cells
),
radius as (
  select tx, ty,
    ceil((select metres from buffer)
      / (40075016.686 / 65536 * cos(atan(sinh(pi() * (1 - 2 * (ty + 0.5) / 65536.0))))))::int as n
  from cells
),
tiles as (
  select distinct tx + dx as x, ty + dy as y
  from radius, generate_series(-n, n) dx, generate_series(-n, n) dy
  where dx * dx + dy * dy <= n * n
),
q15 as (
  insert into public.fantasy_tiles (version, z, x, y, priority)
  select distinct cfg.version, 15::smallint, t.x >> 1, t.y >> 1, 2::smallint
  from tiles t, cfg
  on conflict do nothing
  returning 1
),
q16 as (
  insert into public.fantasy_tiles (version, z, x, y, priority)
  select cfg.version, 16::smallint, t.x, t.y, 2::smallint
  from tiles t, cfg
  on conflict do nothing
  returning 1
)
select (select count(*) from q16) as z16_queued, (select count(*) from q15) as z15_queued;
