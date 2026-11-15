# Detour offers

Each game day, the server offers every player 2 to 5 rewards just off the
routes they walk often, each labeled with the walking time it adds. Walking
within 30 m of an offer collects it. This page describes the rules for
testers and how the parts fit together. The SQL lives in
`supabase/migrations/*_detours.sql`, the tile download in
`supabase/functions/detours`, and the map layer in
`mobile/src/components/map-layers.tsx`.

The server is the authority for every offer and every collection. The app only
shows what the server returns.

## How a day's offers are made

### Routes the player walks often

Every walk the server claims land for is also recorded as route history: the
zoom 19 map tiles (about 47 m on a side at 52°N) of each settled, vehicle-free
walking segment, per game day, in `public.route_tiles`.
`private.claim_settled` writes these rows in the same transaction that claims
the land, so the history follows exactly the same rules as land and pay.

A tile walked on at least 2 different game days in the 28 days before today
counts as a route the player walks often. Offers are placed around those
tiles, most-walked first. Today's walks don't count, so a day's offers don't
depend on what the player already walked that morning.

A player without such routes falls back, in this order, to:

1. **Recent walks:** any tile walked in the last 28 days, today included. A
   new player who walked this morning gets offers around that walk.
1. **Land:** the player's claimed cells, for a player whose walks are older
   than 28 days.
1. **Position:** the phone's last known position, which the app sends when
   location access is granted. A player who never walked gets offers around
   where they are.

If none of these is known, the day has no offers yet. The next call fills the
day's empty slots once something is known.

### Where offers can be

Offers sit only at public, walkable spots, from the OpenFreeMap vector tiles
the map already uses. The `detours` Edge Function downloads the zoom 14 tile of
each area within reach of the player's routes, and `ingest_detour_area` turns
its features into spots, at most one per zoom 19 tile:

| Kind | From | Priority |
| ---- | ---- | -------- |
| Landmark | Viewpoints, artworks, monuments, attractions, castles, and ruins | 1 |
| Park | A named park | 2 |
| Square | A pedestrian area | 3 |
| Footway | A point every 50 m along footways, pedestrian ways, paths, and steps | 4 |
| Street | A point every 50 m along residential and other minor streets | 5 |

A feature never gives a spot when it is:

- Private or closed to walkers (`access` no or private; `foot` no, private,
  customers, use_sidepath, or discouraged).
- In a tunnel or indoors.
- Inside a building, a playground, or one of the sites' exclusion zones:
  cemeteries, places of worship, military land, rail yards, schools and
  universities, kindergartens, hospitals, and prisons.
- Within 20 m of a rail line, motorway, or trunk road.

The rules are in `private.detour_spot_rules()`, `private.detour_blockers()`,
`private.detour_zones()`, and `private.detour_hazards()`. The Edge Function
holds no rules: it forwards the features that the database's filter names.

### Added time

The added time is the walk there and back from the nearest route point:
twice the straight-line distance times a street factor, at 5 km/h, rounded to
whole minutes.

| Straight-line distance from the route | Street factor | Source |
| ------------------------------------- | ------------- | ------ |
| Less than 200 m | 2.0 | The user's decision, from testers' real tracks |
| 200 m or more | 1.3 | The plan's estimate (walking is about 30% longer) |

On real streets, 1.3 fit expeditions (a median of 1.26) but not short offers,
where a fence, a block without a cut-through, or a river decides the route (a
median of 2.53). See
[Added time against real streets](detour-real-tracks.md#added-time-against-real-streets).

Some examples:

- A spot 90 m off the route adds 2 × 2.0 × 90 m = 360 m, about 4 minutes.
- A spot 400 m off the route adds 2 × 1.3 × 400 m = 1,040 m, about 12 minutes.

With 2.0, the short band (3 to 5 minutes) holds spots about 52 to 114 m off
the route. Longer offers and expeditions are more than 200 m off, so they keep
1.3. The added time jumps down at 200 m: a spot 199 m off is labeled
10 minutes, and one 200 m off 6 minutes.

Both factors and the 200 m are in `private.detour_rules()`
(`short_route_factor`, `short_route_max_m`, and `route_factor`), and
`private.detour_added_m` applies them. Real walking routes come later.

### Offers a day and their lengths

The number of offers comes from the Watchtower's `offersPerDay` in the sheet:
2 at level 1, 3 at level 3, 4 at level 5, and 5 at level 7. Without a
Watchtower, a player gets 2.

Each offer slot has a length band, from the design document:

| Slot | Band | Added time |
| ---- | ---- | ---------- |
| Odd (1, 3, 5) | Short | 3 to 5 minutes |
| Even (2, 4) | Longer | 10 to 15 minutes |
| The last slot on a Saturday or Sunday | Expedition | 30 to 40 minutes |

Each slot takes the best spot that fits its band: landmarks first, then parks,
squares, footways, and streets, in a fixed order per player and day. Offers of
one day are at least 250 m apart, and a spot isn't offered to the same player
again for 7 days. If no spot fits a band while areas within reach are still
loading, the slot waits for them. Once every area is loaded, the slot takes
the closest fit from any band.

### Rewards

The reward comes from the sheet's detour section. Each offer rolls its kind
from the sheet's shares, the same way for the same player, day, and slot:

| Kind | Share | Reward |
| ---- | ----- | ------ |
| Gem cache | 10% (the Tavern's `gemOfferShare` replaces it) | 1 gem |
| Crystal vein | 35% | 3 crystal |
| Supply cache | The rest | 600 gold, 8 wood, and 8 stone |

Every offer also pays 75 Ruler XP, the sheet's `xp.detour`. The design
document scales detour XP from 50 to 150 by size, but the sheet gives only the
average, so every offer pays the average. The reward and XP are fixed when the
offer is made.

## When offers are made

Generation runs two ways, and both only fill the day's empty slots, so an
offer never changes once made:

- **On app open.** The app calls the `detours` function when the map gains
  focus, when it comes back to the foreground, and after every upload. The
  function loads missing spot areas (4 tile downloads per call), then calls
  `get_detour_offers`, which fills the empty slots. The app calls again while
  areas remain to load.

  Loading an area is CPU-heavy for the database, so the function downloads
  its tiles together but ingests them one at a time, and at most 4 areas
  are leased at once across all players (`max_leased_areas` in
  `private.detour_spot_settings()`). A call that finds no free slot reports
  its areas as pending, and the app asks again in 20 s. Before this limit,
  overlapping calls loaded 8 Kassel areas at once and pushed every statement,
  the player's own included, past the 8 s statement timeout. See
  `migrations/*_detour_ingest_one_at_a_time.sql`.
- **A scheduled job.** `pg_cron` runs `private.generate_due_detour_offers()`
  every 15 minutes. It makes the day's offers for every player who walked in
  the last 7 days and has none for their current game day yet. That way the
  offers exist soon after 4 a.m. local time, in any time zone, even if the
  player walks before opening the app. The job can't download tiles, so it
  uses the spots the app already loaded.

## Collecting an offer

`private.claim_settled`, in the same transaction that claims the walk's land
and pays for it, collects every open offer that a claimable walking segment
passes within 30 m of. Claimable means the same thing as for land: settled, and
not near a vehicle segment. A segment counts when it ends:

- after the offer was made (a walk from before the offer existed, uploaded
  later, doesn't count), and
- between the offer's `valid_from` and `valid_until`: 4 a.m. local on its game
  day to 4 a.m. the next day, fixed when the offer is made. An offer from
  yesterday can't be collected today, even by a walk uploaded late.

The collection pays the offer's reward and XP through the ledger, with reason
`detour` and the offer id as `ref`. The batch result's `detours` field lists
what the batch collected.

### Paying once

- A repeated batch id returns `duplicate: true` before anything runs.
- The offer is marked collected in the same statement that finds it, and only
  if it's still open. A later batch, a reordered batch, or another session
  that passes the offer again finds it collected.
- A unique index on the ledger (`user_id`, `ref`) for reason `detour` makes a
  second payment for the same offer fail.

## Placeholder values

Neither the sheet nor the plan gives these values. They are in
`private.detour_rules()` and `private.detour_spot_settings()`:

| Value | Placeholder |
| ----- | ----------- |
| Walking speed for the added time | 5 km/h |
| Street factor for spots close to the route (the user's decision, from real tracks) | 2.0, below 200 m |
| Route history window | 28 days |
| Days a tile must be walked to count as a frequent route | 2 |
| Upper bound of an expedition (the design document says 30+ minutes) | 40 minutes |
| Offers a day without a Watchtower | 2 |
| Minimum distance between two offers of one day | 250 m |
| Days before a spot is offered again | 7 |
| Distance from rail lines, motorways, and trunk roads | 20 m |
| Days of activity for the scheduled job | 7 |

The band of each slot (odd short, even longer, the last weekend slot an
expedition) is also a placeholder. The design document wants short offers for
mornings and longer ones for the way home, which needs to know the route's
direction.

## Not done yet

- No offers in parks after dark (design document).
- Rerolls (Tavern), Lure, Far Sight, and the season pass's extra offer.
- "On your way to work": offers don't know which route or direction they belong to.
- Detour XP by size.
- Real walking routes for the added time.
