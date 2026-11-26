-- Pre-painting the testers' areas, step 1 of 2: what it would cost. Read only.
--
-- The z16 tiles within about 1 km of any claimed land (public.claimed_cells), and their z15
-- parents, minus the ones already queued or painted for the current tile version. Everything
-- is computed inside the database and only totals come out: no position, cell or player ever
-- leaves it.
--
--   npx supabase db query --remote --read-only -f supabase/fantasy-renderer/sql/prepaint-territory-count.sql
--
-- A claim cell id is x * 2^21 + y at zoom 21 (supabase/README.md, Cells), so its z16 tile is
-- (x >> 5, y >> 5). The 1 km buffer is a disc of tiles whose radius is 1 km over the tile's
-- ground width at its latitude. The estimate uses 2 s per tile on the worker host and the mean
-- tile sizes at WebP quality 0.75 (143 KB at z16, 165 KB at z15).
with buffer as (select 1000.0 as metres),
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
fresh16 as (
  select t.x, t.y from tiles t
  where not exists (
    select 1 from public.fantasy_tiles f, public.fantasy_config c
    where f.version = c.version and f.z = 16 and f.x = t.x and f.y = t.y
  )
),
parents as (select distinct x >> 1 as x, y >> 1 as y from tiles),
fresh15 as (
  select p.x, p.y from parents p
  where not exists (
    select 1 from public.fantasy_tiles f, public.fantasy_config c
    where f.version = c.version and f.z = 15 and f.x = p.x and f.y = p.y
  )
)
select
  (select count(*) from tiles) as z16_tiles,
  (select count(*) from fresh16) as z16_new,
  (select count(*) from parents) as z15_tiles,
  (select count(*) from fresh15) as z15_new,
  round(((select count(*) from fresh16) * 2 + (select count(*) from fresh15) * 0.3) / 60.0, 1) as painting_minutes,
  round(((select count(*) from fresh16) * 143 + (select count(*) from fresh15) * 165) / 1024.0) as storage_mb;
