# The kingdom

This page describes the kingdom screen's rules: building, the daily
construction, Pikemen, and Treasury caps. The numbers come from
`Local Legend_Economy.xlsx` through the generated rules (see
[Game rules as data](rules.md)). The SQL lives in
`supabase/migrations/*_kingdom.sql`.

The server is the authority for every spend. The app previews costs and
blockers from the same rules to label its buttons, then shows what the server
returns.

## Plots

The kingdom has four plots: the Keep, the Treasury, the Walls, and the
Barracks. Every player starts with a level 1 Keep and three empty plots.
`private.kingdom_settings()` lists the plots; other buildings in the sheet
can't be built yet.

The Keep and the Barracks use the art in `UI Assets/` (three tiers spread over
their levels). The Treasury and the Walls have no art yet and show a lettered
tile.

## Building

Building is instant and pays the level's cost from the **Building Costs**
sheet. It also pays the level's construction XP to Ruler XP.

To build a level, all of these must hold:

| Rule | Source |
| ---- | ------ |
| The building isn't at its top level (10, or 7 for the Barracks). | `maxLevel` |
| The Ruler level is at least the level's Ruler requirement. Keep level N needs Ruler level 3N − 2; other buildings need the same Ruler level as the Keep level they match. | `requiredRulerLevel`, `unlockRulerLevel` |
| The Keep is at least the level being built. No building can pass the Keep. | `requiredKeepLevel` |
| No construction yet on this game day. | `construction.buildsPerDay` |
| The balances cover the cost. | `cost` |

The app sends the level the player tapped. If the building already has that
level, or the level isn't the next one, the server refuses, so a tap on an
out-of-date screen can't build the level after it.

### One construction a day

A player can build once per game day. Game days start at 4 a.m. in the
player's time zone, as described in
[The game day and time zones](economy.md#the-game-day-and-time-zones). The
count comes from the server's record of constructions, so restarting or
reinstalling the app changes nothing.

Each construction records its game day in the time zone at the time. The
kingdom's game day never goes back:

- **Moving west** (for example, from Kiritimati to Los Angeles) puts the clock
  on an earlier date. The kingdom stays on the latest day it has used, so the
  player waits until that day is over locally. This can delay the next
  construction by up to a day.
- **Moving east** (for example, from Los Angeles to Kiritimati) can make the
  next 4 a.m. come sooner, but a day that already built still can't build
  again. Combined with the server accepting a time zone change at most once a
  day, a player can't build more often than once per game day.

The sheet also has a second builder from Ruler level 15 (`Builder2_Ruler`).
It isn't applied yet: phase 2 allows one construction a day.

## Pikemen

A Barracks recruits Pikemen into the garrison at 60 gold each (the **Units**
sheet). There's no upkeep.

Recruits grow weekly, as the sheet describes:

- New recruits appear every Monday at 4 a.m. local, at the start of the
  Monday game day.
- A week grows `ROUND(14 × (1 + 0.25 × (Barracks level − 1)))` recruits: 14 at
  Barracks level 1, 18 at level 2, and 21 at level 3. The base (14), the bonus
  (25% per level), and the unlock level come from the sheet.
- Recruits not recruited carry over one extra week, then expire. Recruiting
  takes last week's recruits first.
- A week grows at the Barracks level the week started with, so an upgrade
  counts from the next Monday.
- The week a Barracks is first built, its recruits appear at once. Without
  this, a new player would wait until Monday.

The garrison defends against the weekly Mist surge, which costs it 5% when it
holds and 20% (Pikemen 10%) when it breaks through. See
[The weekly Mist surge](mist.md).

## Treasury caps

Without a Treasury, nothing is capped. Once a player has one, gold, wood, and
stone pay only up to its caps: 5,000 gold and 60 wood and stone at level 1,
rising about 35% a level (the **Building Effects** sheet). Crystal and gems are
never capped.

- What doesn't fit is lost. The ledger records it in `details.capped`.
- A balance saved above a cap before the Treasury was built is kept, but
  nothing more is paid into it until it drops below the cap.
- Spending is never capped.
- The caps apply to every payment: the Keep tax, walking, and terrain. The
  `reward` of a walk and `keepTaxPaid` report what was earned before the cap;
  the balances show what was kept.

## Retries

Every construction and recruitment carries a request id: a UUID the app makes
once per tap and reuses on every retry. The server stores each successful
action under its id. A request with an id it has seen returns the first result
with `duplicate: true` and changes nothing, even on a later day.

A refused request (not enough gold, the day's construction used) changes
nothing and isn't stored, so the app can retry it safely.

## Values the sheet doesn't give

These choices fill gaps in the sheet and the design document. Each lives in
one place:

| Choice | Where |
| ------ | ----- |
| The week a Barracks is first built, its recruits appear at once. | `private.weekly_recruits` |
| A Barracks upgrade changes weekly recruits from the next Monday. | `private.weekly_recruits` |
| No caps without a Treasury; pay beyond a cap is lost; balances above a cap are kept. | `private.treasury_caps`, `private.credit` |
| At most 1,000 Pikemen per request (an input guard, not a game rule). | `private.kingdom_settings` |
| Only the four plots and Pikemen. | `private.kingdom_settings` |

`build_building` and `recruit_units` resolve a due Mist surge before they
run, so a construction or recruitment just after Monday 4 a.m. can't change
the surge that closed the week.
