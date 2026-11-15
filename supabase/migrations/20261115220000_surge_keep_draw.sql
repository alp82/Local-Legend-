-- The Mist surge drops the Keep draw: strength is the sheet's own surge model,
-- season pressure x first-surge factor x Mist_Per_km x effective frontier km.
--
-- The user's decision (docs/mist.md#balance-the-first-six-weeks): with the
-- design document's Keep draw (800 at Keep level 1, 30,750 at level 10) next
-- to the sheet's Walls (150 at level 1) and Pikemen (1 defense each), no
-- simulated player ever held a surge. The sheet's Mist and Bosses calculator
-- has no Keep draw, so the draw is 0 at every Keep level. Strength per
-- frontier km stays at the sheet's 10 (the design document says 20).
--
-- The keep_draw column stays, so a Keep draw can come back by changing this
-- one array. The design document's table, for reference:
-- 800, 1200, 1800, 2700, 4050, 6080, 9110, 13670, 20500, 30750.

create or replace function private.surge_settings(
  out keep_draw numeric[],                 -- The user's decision: no Keep draw (the sheet's surge model). Was design document 7's table.
  out first_surge_factor numeric,          -- Design document 7 and 16: a new player's first surge is at half pressure.
  out first_surge_min_days int,            -- Design document 16: joining less than 5 days before a Sunday moves the first surge to the next Sunday.
  out partly_held_share numeric,           -- Design document 7: partly held when defense is at least half the strength.
  out stand_firm_units text[],             -- Design document 11: Pikemen "stand firm"...
  out stand_firm_factor numeric,           -- ...and lose half as many when a surge breaks through.
  out rest_days_per_season int,            -- Design document 7: up to 14 Rest days a season.
  out auto_rest_after_days int,            -- Design document 7: Rest turns on by itself after 2 days with almost no walking.
  out almost_no_walking_km numeric,        -- PLACEHOLDER: a game day with less walking than this is "almost no walking".
  out home_radius_m float8,                -- Design document 5: home is a 150 m clearing.
  out road_weeks int,                      -- Design document 5: roads are walked in 3...
  out road_min_weeks int,                  -- ...of the last 4 weeks.
  out road_tile_ring int,                  -- Land within this many route tiles (zoom 19) of a road tile is road, so the whole 60 m strip counts.
  out season_epoch date                    -- PLACEHOLDER: the Monday season 1 starts. Seasons are rules.seasons.weeks long.
)
language sql
immutable
parallel safe
set search_path = ''
as $$
  select
    array[0, 0, 0, 0, 0, 0, 0, 0, 0, 0]::numeric[],
    0.5,
    5,
    0.5,
    array['pikeman'],
    0.5,
    14,
    2,
    0.5,
    150.0,
    4,
    3,
    1,
    date '2026-11-16'
$$;

comment on function private.surge_settings() is
  'Mist surge values that are not in the economy sheet: the design document''s values, the user''s decisions, and placeholders, in one place.';

revoke all on all functions in schema private from public, anon, authenticated;
