# Resources, walking pay, and Ruler XP

This page describes how the server pays players: starting resources, the
daily Keep tax, pay for walking, and Ruler XP. The numbers come from
`Local Legend_Economy.xlsx` through the generated rules (see
[Game rules as data](rules.md)). The SQL lives in
`supabase/migrations/*_economy.sql`.

The server is the authority for every reward. The app only shows what
`get_economy` returns.

## Resources

Each player has one row in `public.player_economy` with gold, wood, stone,
crystal, gems, and Ruler XP. The row is created on first use with the sheet's
starting resources: 2,000 gold, 20 wood, and 20 stone.

Pay is per meter, so balances are stored as decimals: 0.25 km of park at 5 wood
per km pays 1.25 wood. `get_economy` and the app show whole units (rounded
down).

Every change is also written to `public.economy_ledger`, so a balance always
equals the sum of its ledger rows. The ledger records the reason (`start`,
`keep_tax`, `walk`, `terrain`, `build`, `recruit`, `detour`, or `surge`) and
the batch, session, day, area, request, offer, or surge week that caused it.

Holding the weekly Mist surge also pays a trade ticket. Tickets are a separate
balance, `player_economy.trade_tickets`, recorded in the ledger's `tickets`
column. Nothing spends them yet. See [The weekly Mist surge](mist.md).

Once a player has a Treasury, gold, wood, and stone pay only up to its storage
caps. See [The kingdom](kingdom.md#treasury-caps).

## The game day and time zones

Daily limits reset at 4 a.m. in the player's local time. The sheet has no
input cell for this; the hour comes from the note next to `Build_Per_Day` on
the **Inputs** sheet ("resets 4 a.m."), which the generator reads into
`rules.dailyResetHour`.

The server stores the time zone instead of deriving it:

- The app sends the device's IANA time zone, such as `Europe/Warsaw`, with
  every `get_economy` call. The server stores it in
  `player_economy.time_zone`. Until the app reports one, the zone is UTC.
- The server ignores unknown names, and changes that come less than 24 hours
  after the previous change. Without this limit, switching zones back and
  forth could fit extra days into one real day. The first report is always
  accepted. `timeZoneAccepted` in the response says whether the zone sent is
  now in use.
- A moment belongs to the game day `(local time - 4 hours)::date`: 03:59 on
  May 2 belongs to May 1, and 04:00 starts May 2.

A walk counts toward the day of its GPS time, not the day it was uploaded. A
walk queued offline and uploaded the next morning still counts toward the day
it was walked.

## The Keep tax

`get_economy` pays the Keep tax for every game day since the last one paid,
up to 7 days: one day on the first call, then one per game day since. Days the
player didn't open the app still pay, because the design document says busy
weeks still pay and that Treasury caps limit what a player can save up.
Calling again on the same game day pays nothing.

Missed days pile up for at most 7 days. A player who comes back 30 game days
after the last payment gets 7 days' tax, and the other 23 are gone. Days are
counted from the last day paid up to today, so a player who last paid on
Monday and comes back on the next Monday gets 7 days. The ledger row records
both numbers in `details`: `days` (paid) and `owedDays` (before the cap). The
sheet has no cell for the cap, so the 7 is a placeholder in
`private.economy_placeholders()` (`supabase/migrations/*_keep_tax_cap.sql`).

The tax comes from the Keep level's `goldTaxPerDay`: 300 gold a day at
level 1 in the sheet (the design document says 500; the sheet wins), and 100
more for each Keep level. Every day pays at the Keep level it had: building
settles the tax first, so the Keep level can't change between the last
payment and today, and days before an upgrade pay at the old level. The whole
rule is `private.settle_keep_tax`, last replaced in
`supabase/migrations/*_keep_tax_cap.sql`.

## Walking pay

Postgres pays for walking in the same transaction that claims land, inside
`private.claim_settled`, which `submit_location_batch` and
`close_walk_session` call. The batch result has a `reward` field with what
that batch paid.

A walk pays in two ways:

| Kind | What counts | Km | Rates in the sheet |
| ---- | ----------- | -- | ------------------ |
| New ground | Each cell claimed for the first time | The cell's ground area divided by the 60 m claim strip | 250 gold per km, plus 10 stone (built-up), 12 wood (park), 8 crystal (waterside), or 4 gems (hills) |
| Usual routes | Each walking segment whose middle lies on a cell the player claimed at least 60 seconds before the segment started | The segment's length | 100 gold per km, plus 5 stone (built-up), 5 wood (park), or 1 crystal (waterside), up to 5 km a day |

Some details:

- New-ground km come from land area, so standing still or GPS noise can't add
  new ground. A straight walk on new land counts about its length. Because the
  strip is rounded to whole cells, a single straight walk can count up to
  about 20% more or less, depending on how it lines up with the cell grid;
  across walks the rounding evens out.
- The 60 second rule keeps cells claimed just ahead of you on a first walk
  from counting as your own land. Walking back over land you claimed earlier
  on the same walk counts as a usual route once the 60 seconds have passed.
- Usual routes are capped at 5 km a day for resources and XP, from the sheet's
  `Walk_Cap_km`. The cap applies to km in time order, across batches and
  sessions.
- New ground has no daily cap. The design document halves new-ground pay after
  6 km a day, but the sheet has no value for it, so the server leaves it out.

### Paying once

- A repeated batch id returns `duplicate: true` before anything runs, so it
  pays nothing.
- Every segment is marked paid in `walk_points.paid_segment_start` the first
  time it's evaluated. A later batch that re-evaluates the segment, or an
  out-of-order batch that splits it, skips it.
- New cells are inserted once, so new ground pays once.

### Terrain

Each cell has one terrain: built-up, park, waterside, hills, or none (gold
only). Postgres can't fetch map data, so the `terrain` Edge Function
classifies it and stores it in `public.terrain_areas`:

- **Granularity:** one terrain code per claim cell (zoom 21, about 12 m at
  50°N), packed as a 16,384-character string per zoom 14 area (128 × 128
  cells). Pay is per cell, so terrain per cell needs no averaging and no
  second grid. The area is the same vector tile the `sites` function
  downloads, and the tile's geometry is precise to well under a meter.
- **When:** a walk on cells whose area has no terrain yet pays its gold and XP
  at once. Its terrain resources wait in `public.terrain_pending`, already
  capped. The app then calls the `terrain` function, which leases those areas,
  classifies their tiles, and calls `ingest_terrain_area`. That function
  stores the terrain and pays every player who was waiting, in one
  transaction.
- **Rules:** `private.terrain_classes()` holds the classes, in priority order.
  The first match wins:
  1. Hills: within 50 m of a viewpoint, or 100 m of a mountain peak or
     volcano. OpenMapTiles has no elevation data, so slopes can't be detected.
  1. Waterside: within 30 m of a river, lake, ocean, or dock, or of a river or
     canal line.
  1. Park: inside woods, a park, garden, recreation ground, village green,
     nature reserve, or national park.
  1. Built-up: inside residential, commercial, retail, or industrial land use,
     or where buildings cover at least 15% of the 100 m square around the
     cell.

  Everything else is none and pays gold only.

## Ruler XP and levels

| Source | XP |
| ------ | -- |
| Usual routes | 15 per km, at most 75 a day |
| New ground | 100 per km for the first 3 km of the day, 50 for the next 3 km, then 20 |

The Ruler level is the highest level in the sheet's XP table whose total XP
the player has reached: level 2 at 100 XP, level 3 at 350, up to level 30 at
48,850.

## What isn't paid yet

These rules are in the sheet or the design document but aren't paid yet:

- Weekly distance goals (10, 20, and 40 km). The sheet has the values, but not
  when a week starts.
- Boss, place card, and outpost XP. They come with the features that award
  them. Construction XP is paid when building (see
  [The kingdom](kingdom.md)), detour XP when an offer is collected (see
  [Detour offers](detours.md)), and surge XP when a surge holds or partly
  holds (see [The weekly Mist surge](mist.md)).
- Feast Days (the booster multiplier) and bike km.
- Half pay for new ground after 6 km a day, which the sheet has no value for.
