# Detour offers on testers' real walks

This page reports how detour offers (see [Detour offers](detours.md)) behave
on the GPS tracks testers recorded in the remote Supabase project. It gives
aggregate results only: no locations, routes, or user ids. The checks ran on
November 15, 2026, against the local Supabase stack, with the detour code from
`supabase/migrations/20261115180000_detours.sql` unchanged.

## Summary

- **The data is small.** 2 testers, 3 game days in all (one tester walked on
  2 days, the other on 1), 7 sessions, and 713 GPS points. About 1.3 km of the
  tracks was on foot. The rest was a 13 km vehicle trip.
- **GPS position noise doesn't break the "2 of 28 days" rule.** When the same
  real walk is replayed on a second day with up to 15 m of offset and GPS
  noise, 85% to 100% of its route tiles count as frequent.
- **GPS jumps do break it.** A single jump that looks faster than 3.5 m/s
  counts as a vehicle segment, and the 120 s vehicle buffer around it drops
  up to 4 minutes of walking from route history. On the one real 1 km walk, 5
  such jumps removed 65% of the walk. This is the biggest problem found. See
  [GPS jumps remove most of a real walk](#gps-jumps-remove-most-of-a-real-walk).
- **Offers land in sensible places.** All 168 generated offers were in their
  band or the documented fallback, every spot was on or next to a public way,
  and no spot was inside a building or an excluded zone. No offer was within
  30 m of where a tester walked on foot.
- **The added time is too low for short offers.** The 1.3 detour factor fits
  expeditions (median 1.26 on real streets) but not short offers (median 2.53).
  8 of 12 short spots labeled 3 to 5 minutes take more than 5 minutes there
  and back on real streets, up to 15 minutes.
- **Collection works.** Walking to the spot collected 41 of 41 open offers.
  Walking the usual tracks again collected none, as intended.

## Data and method

The remote project was read with `supabase db query --remote --read-only`
only. Nothing was written there. The remote project has the migrations up to
`20261115120000_vehicle_buffer.sql`, so it has walks but no route history or
offers. The walk points were copied, with testers and sessions renamed, to a
scratch folder, and replayed on the local stack through the public API
(`submit_location_batch` and `close_walk_session`) as new players, in batches
of 40 points.

| Tester | Game days walked | Sessions | Points | On foot | Notes |
| ------ | ---------------- | -------- | ------ | ------- | ----- |
| A | 2 | 4 | 536 | About 320 m | Day 1: a 9-point session. Day 2: a 77-minute trip, 13.3 km of it in a vehicle. |
| B | 1 | 3 | 177 | About 1,000 m | A 21-minute round walk. |

"On foot" counts segments the server classes as walking (at most 3.5 m/s)
where the phone also reported under 2.5 m/s. The median GPS accuracy was 5.5 m
to 5.9 m on the long sessions, and fixes came every 5 to 7 seconds.

The checks, in order:

1. **Real history.** Each tester's walks replayed one day earlier, so that the
   last walked day is yesterday, then the real `detours` Edge Function, which
   downloaded the OpenFreeMap tiles and made today's offers.
1. **Offer sample.** 48 copies of the two histories (different user ids give a
   different spot order), with offers made at 05:00 on Sunday (today, with an
   expedition) and Monday, with no Watchtower (2 offers) and with a level 7
   Watchtower (5 offers). That gives 168 offers on 44 distinct spots. Each
   offer was measured against the tester's real on-foot track and against the
   walkable ways of the same OpenFreeMap tiles.
1. **Repeat walks.** Tester B's walk replayed on two days, the second day with
   a constant offset of 0, 5, 10, or 15 m (GPS bias, or the other sidewalk)
   plus correlated GPS noise (σ 3 m), 3 runs each. Run once with the walk's
   GPS jumps removed, and once with them kept on day 1 and as many added at
   random places on day 2.
1. **Collection.** On the 24 Sunday copies: the real tracks walked again
   today, then a walk from the nearest point of the real track to each open
   offer and back, with GPS noise (σ 4 m, accuracy values drawn from the real
   data). Half the copies turned back 25 m before the spot; the other half
   turned back 40 m before it, then walked all the way.

## Frequent routes

### Real history

| Tester | Route tiles, day 1 | Route tiles, day 2 | Frequent tiles | Offers placed around |
| ------ | ------------------ | ------------------ | -------------- | -------------------- |
| A | 2 | 2 | 2 | `routes` (the 2 frequent tiles) |
| B | 6 | None | 0 | `recent` (the 6 tiles) |

Tester A's 2 frequent tiles are where the 9-point session and the long trip
overlap. Tester B walked on one day only, so the `recent` fallback applied, as
documented. Neither tester walked a repeated commute, so the real data can't
show a commute becoming a frequent route by itself. The repeat test covers
that.

### Repeat walks

The following table gives the average of 3 runs for each offset. "Walk
covered" is the share of the walk's GPS points whose tile counts as frequent.

| Day 2 offset | Without GPS jumps: frequent / day 1 tiles | Walk covered | With GPS jumps: frequent / day 1 tiles | Walk covered |
| ------------ | ------------------------------------------ | ------------ | --------------------------------------- | ------------ |
| 0 m | 11 / 13 (85%) | 91% | 4.3 / 6 (72%) | 68% |
| 5 m | 12.3 / 13 (95%) | 99% | 4.7 / 6 (78%) | 69% |
| 10 m | 12.3 / 13 (95%) | 99% | 4.0 / 6 (67%) | 67% |
| 15 m | 11.7 / 13 (90%) | 97% | 5.3 / 6 (89%) | 74% |

The 47 m tiles absorb position noise well. Every run without a fast segment
kept at least 85% of its tiles, and offsets didn't matter. The one weak run
at 0 m is not a tile edge effect: the synthetic noise alone made 2 fast
segments there, and the vehicle buffer dropped 6 of 13 tiles. With GPS jumps,
the walk makes 6 tiles instead of 13 on the first day, so less than half of
the walk can ever become a frequent route.

### GPS jumps remove most of a real walk

Tester B's 1 km walk has 163 walking segments and 5 segments faster than
3.5 m/s. For 3 of them the phone itself reported walking speed (0.3 to
1.7 m/s), for example 7.6 m in 1 second with 9 m accuracy at both ends. The
other 2 came 5 seconds apart, at 4.2 and 5.7 m/s, with the phone reporting
5.3 m/s, which could be a short run. Each fast segment blocks walking within
120 s on either side (`claim_rules().vehicle_buffer_s`), so:

- 668 m of the 1,026 m walked (65%) is never claimed and never enters route
  history.
- The replay claims 108 cells. The remote project recorded 191 new cells for
  the same session, probably claimed before the vehicle buffer reached it.
- Route history has 6 tiles instead of 13.

On tester A's vehicle trip, the buffer works as intended: only 2 of 270 fast
segments look like jumps.

This rule lives in the territory code (`*_vehicle_buffer.sql`), not in the
detour code, but route history, frequent routes, and detour collection all
inherit it. Suggested fixes, with how much of the session's 1,119 m (walking
and fast segments together) each would keep claimable, against 359 m today:

- **Subtract the accuracies.** Count a segment as fast only when (distance −
  accuracy₁ − accuracy₂) / time is above 3.5 m/s. All 5 segments fall under
  3.5 m/s this way, so the whole walk is kept (1,119 m). A vehicle at 10 m/s
  with 5 s fixes and 15 m of combined accuracy still measures 7 m/s.
- **Trust the phone's speed.** Ignore a fast segment when the phone reported
  under 2.5 m/s at both ends: 752 m kept. The 2 segments with 5.3 m/s phone
  speed remain.
- **Require a sustained vehicle.** Apply the buffer only around at least 2
  consecutive fast segments: 752 m kept, for the same reason.

## Offers

### Bands and distances

All 168 slots were filled, and areas loaded in 2 calls of the `detours`
function per tester.

| Band | Offers | Added time (labeled) | In band | Server off-route distance | Distance to the real on-foot track |
| ---- | ------ | -------------------- | ------- | ------------------------- | ---------------------------------- |
| Short | 84 | 3 to 9 min, median 5 | 78 | 82 to 301 m, median 145 m | 62 to 299 m, median 138 m |
| Long | 60 | 10 to 14 min, median 10 | 60 | 307 to 438 m, median 322 m | 139 to 438 m, median 322 m |
| Expedition | 24 | 32 to 40 min, median 35 | 24 | 1,024 to 1,280 m, median 1,109 m | 939 to 1,180 m, median 1,075 m |

The 6 short offers outside 3 to 5 minutes (7 to 9 minutes) come from the
documented fallback that takes the closest fit from any band when no spot fits.

For tester A, the server's off-route distance matches the real on-foot track
within 20 m. For tester B, long and expedition offers are a median 100 m and
127 m closer to the real walk than the server assumes (up to 171 m), because
route history holds only the part of the walk the GPS jumps left. A long offer
labeled 10 minutes can sit 139 m from where the player walked.

No offer was within 30 m of the real on-foot track. Two offers were within
30 m of tester A's vehicle trip, where the phone reported 4 to 6 m/s. The
server correctly left those stretches out of route history.

### Spots

| Kind | Tester A | Tester B |
| ---- | -------- | -------- |
| Landmark | 42 | 67 |
| Square | 0 | 12 |
| Footway | 37 | 5 |
| Street | 5 | 0 |

- Footway and street spots lie on a walkable way of the tile (median 0 m).
  Landmarks lie at most 37 m from one.
- None of the 44 distinct spots is inside a building, cemetery, school,
  hospital, place of worship, military area, rail area, or prison polygon of
  the tile. They lie in residential (12), suburb (25), commercial (7), grass
  (11), wood (2), or historic park (1) polygons.
- Landmarks dominate where they exist, as the priority order intends. Near
  tester B, 1 landmark took 24 of the 42 short slots across copies. For one
  player, the 7-day repeat rule spreads this out.

### Added time against real streets

The following table compares the labeled time with the walk there and back on
the tile's walkable ways, from the nearest point of the real track, at
5 km/h. It covers the distinct spots where a path was found; for 15 of 42
spots, the graph built from the tiles had no connected path, so those are
left out.

| Band | Spots with a path | Network / straight-line distance | Real-street minutes | Labeled minutes |
| ---- | ----------------- | -------------------------------- | ------------------- | --------------- |
| Short | 15 | 1.02 to 6.13, median 2.53 | 1 to 29, median 6 | 3 to 9, median 5 |
| Long | 4 | 1.08 to 2.48, median 1.97 | 6 to 25, median 9 | 10 to 14, median 10 |
| Expedition | 8 | 1.05 to 1.37, median 1.26 | 25 to 36, median 32 | 32 to 40, median 35 |

The 1.3 factor from the plan fits long distances, where streets average out.
At 100 to 300 m the street layout decides: a footway behind a fence, a block
without a cut-through, or a river. Of the 12 short spots labeled 3 to 5
minutes, 8 take more than 5 minutes on real streets, and 4 take 11 to 15. The
tile data is simplified at zoom 14, so some network distances may be too long,
but the pattern holds for spots in both testers' areas.

Suggested fix, until real walking routes exist: measure the off-route
distance on the walkable ways that `ingest_detour_area` already reads, or
raise `route_factor` for short offers (for example to 2.0 below 200 m), so a
"3 to 5 minute" offer rarely takes 10.

## Collection

| Check | Walks | Collected | Expected |
| ----- | ----- | --------- | -------- |
| The real tracks walked again today | 24 players, 84 offers | 0 | 0 (no offer is on a walked track) |
| Walk to the spot and back | 41 | 41 | All |
| Turn back 25 m before the spot | 42 | 35 | Most |
| Turn back 40 m before the spot | 42 | 1 | None |

- With σ 4 m of noise, the closest fix to the spot was a median 4 m away (at
  most 10 m) on full walks, so the 30 m rule is comfortable for a player who
  walks to the marker.
- The 7 misses at 25 m are walks whose closest fix was 30 to 35 m from the
  spot. That's the rule working as written.
- The 1 collection at 40 m is the offer next to tester A's vehicle trip: the
  test walk started from the nearest track point, which was 4 m from the
  spot. A real walk there would collect it, because the server doesn't know
  the player walks there. That's correct behavior, not a bug.
- No collection test walk had a fast segment. On a real walk, a GPS jump
  within 2 minutes of reaching the spot would block the collection the same
  way it blocks land. That wasn't observed here, but it follows from the
  vehicle buffer.

## What this couldn't check

- **Real repeated commutes.** No tester walked the same route on 2 days, so
  frequent routes from real commutes are simulated by replaying one real walk.
- **Many testers and areas.** 2 testers in one city. The spot mix and the
  network distances depend on the area.
- **Spots after dark, Watchtower levels other than 0 and 7, and the scheduled
  job.** The scheduled job uses the same `generate_detour_offers` that this
  check called directly.
- **Exact walking distances.** The street graph comes from zoom 14 vector
  tiles, which are simplified and split at tile borders.
