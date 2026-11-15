# The weekly Mist surge

This page describes the weekly Mist surge: when it runs, how strong it is,
what it takes and pays, the land it can and can't take, the gentle first surge,
and Rest days. It ends with a balance simulation of the first six weeks.

The SQL lives in `supabase/migrations/*_mist_surge.sql`, and the tests in
`supabase/tests/mist_surge_test.sql`. The app shows the result on the kingdom
screen (`mobile/src/app/kingdom.tsx`, `mobile/src/lib/surge.ts`).

The server is the authority for every surge. The app only words what
`get_kingdom` returns.

## When the surge runs

Every game week ends with a surge. A game week runs from Monday 4 a.m. to the
next Monday 4 a.m. in the player's time zone (see
[Week](analytics.md#week)). The surge that closes a week is due when the week
ends: at 4 a.m. on Monday, the end of Sunday night's game day.

- **The job.** A pg_cron job (`mist-surge`) runs every 15 minutes and resolves
  every player whose last closed week has no result yet. Every 15 minutes
  covers time zones 30 or 45 minutes off the hour.
- **Resolving on use.** `get_kingdom`, `build_building`, and `recruit_units`
  resolve a due surge before anything else. If the job is late, the surge
  still sees the kingdom as it was when the week ended: a player who opens the
  app at 4:05 a.m. on Monday can't build Walls first.
- **Once per week.** `public.surge_results` has one row per player and week,
  keyed by the week's Monday. Resolving locks the player's economy row and
  checks for the row first, so a job that runs twice, two jobs that overlap,
  or a job and an app call at the same moment resolve the week once. The
  ledger has a unique index on the surge's week, and the analytics event is
  unique per week too.
- **Time zones and daylight saving time.** The due time is
  `private.game_day_start(Monday, time zone)`, the same function the kingdom
  uses for its daily limit. It follows the zone's rules, so the night daylight
  saving time ends (a 25-hour Sunday) still has one surge, due at the next
  Monday's 4 a.m. in the new offset. Moving west after a surge can't run the
  week again, because the week's row already exists.
- **A late job.** If the job doesn't run for more than a week, only the last
  closed week resolves. Earlier weeks are skipped, not resolved with today's
  kingdom.

The analytics event's `game_day` is the Monday the surge was due, and its
`occurred_at` is the due time, even if the job ran late.

## Strength and defense

```text
strength = season pressure × first-surge factor × 10 × effective frontier km
defense  = (Walls defense + garrison power) × (1 + Watchtower defense bonus)
```

The surge holds when defense is at least the strength.

| Value | Where it comes from | Value now |
| ----- | ------------------- | --------- |
| Season pressure | Sheet (`Pressure_Start`, `Pressure_End`): rises linearly over the season's weeks | 1.0 in week 1 to 2.0 in week 9 |
| First-surge factor | Design document, section 7 and 16 | 0.5 for the first surge, then 1 |
| Keep draw | The user's decision: none, as in the sheet's own surge model. See [Balance](#balance-the-first-six-weeks) | 0 at every Keep level |
| Strength per frontier km | Sheet (`Mist_Per_km`). The design document says 20; the user chose the sheet's value | 10 |
| Faded frontier | Sheet (`Faded_Mult`, `Faded_Days`) | Counts twice after 30 days without a visit |
| Walls defense | Sheet (**Building Effects**) | 150 at level 1, about ×1.5 a level |
| Garrison power | Sheet (**Units**: `power`) | 1 per Pikeman |
| Watchtower bonus | Sheet (**Building Effects**) | 0 for now: the Watchtower can't be built yet |

Frontier km are counted like new ground in walking pay: each cell's ground
area divided by the 60 m claim strip.

## What happens

| Result | When | What happens |
| ------ | ---- | ------------ |
| Held | Defense ≥ strength | +500 gold (Treasury caps apply), +1 trade ticket, +150 Ruler XP. The garrison loses 5% (rounded down). |
| Broke through | Defense < strength | The Mist takes `min(5%, 10% × (strength − defense) ÷ strength)` of the frontier cells (rounded down). The garrison loses 20%, Pikemen 10% (rounded down). |
| Partly held | Broke through, but defense ≥ half the strength | Everything a breakthrough does, plus +75 Ruler XP. |
| Rested | Sunday is a rest day | Nothing. No event is recorded. |
| Not yet | Before the player's first surge | Nothing. No event is recorded. |

The gold, ticket, XP, loss shares, and 5% cap come from the sheet. The
partly-held threshold (half the strength) and Pikemen losing half as many come
from the design document.

Trade tickets are a new balance in `player_economy.trade_tickets`, recorded in
the ledger's `tickets` column. Nothing spends them yet.

## Home, roads, and frontier

The design document defines four kinds of land (section 5). The surge uses
three of them; dormant land doesn't exist yet, because nothing imports walks.

- **Home**: every cell whose center lies within 150 m of the home cell's
  center. The home cell is the first cell the player claimed (the earliest
  `first_claimed_at`). It's fixed the first time the server sees it, in
  `public.player_homes`, so a walk uploaded later can't move it. The app
  doesn't ask for a home yet, so the first walk's start stands in for it.
- **Roads**: every cell within one zoom 19 route tile (about 47 m at 52° N) of
  a tile the player walked on in at least 3 of the last 4 game weeks, counting
  the week the surge closes. Route tiles are what detour offers already
  record per game day (`public.route_tiles`). The one-tile ring covers the
  whole 60 m strip a walk claims, not only the tiles the path crosses.
- **Frontier**: everything else the player owned when the surge was due.

Home and roads are never lost. Only frontier counts toward strength, and only
frontier can be taken.

A frontier cell is **visited** on the game day it was first claimed and on any
game day the player walked a route tile within one tile of it. It **fades**
when its last visit is 30 or more days before the week's Sunday.

The Mist takes the least recently visited frontier first: faded land, then
older claims, then by cell id. Lost cells are deleted from `claimed_cells` and
recorded in `public.surge_lost_cells`. Walking there again claims them as new
ground, which pays again.

Usual routes count as frontier until they become roads. A new player's routes
become roads at the surge of their third week.

## The gentle first surge

A player's first surge is at half pressure. It's the first week whose Sunday is
at least 5 days after the signup day (design document, section 16): a player
who joins on Tuesday has a surge that Sunday, and one who joins on Wednesday
waits until the next Sunday. Weeks before it are recorded as `not_yet`. The
first surge that's held or broken through is the gentle one; rested weeks
don't count.

## Rest days

A surge skips a player whose Sunday is a rest day. A season has 14 rest days
(design document, section 7).

- **Turned on.** `set_rest(true)` turns Rest on from today's game day until
  `set_rest(false)`. Turning it off ends it after yesterday; a Rest turned on
  and off on the same day uses no days. Turning it on with no days left fails
  with `no_rest_days`.
- **On by itself.** A game day with almost no walking (less than 0.5 km) that
  follows 2 such days is a rest day. Walking on a day ends it for that day.
  Days before signup don't count as days without walking.
- **The budget.** Manual and automatic rest days both count, in date order.
  Once 14 days in a season are rest days, later days aren't, even with Rest
  turned on.

Requiring a third quiet day keeps a commuter who doesn't walk at the weekend
from resting through every Monday, and keeps them facing their Sunday surge.

## Seasons

A season is 9 weeks (sheet, `Season_Weeks`). Neither the sheet nor the plan
says when seasons start, so season 1 starts on Monday, November 16, 2026, and
seasons follow each other from there. Season pressure and the rest day budget
both use this calendar.

## In the app

`get_kingdom` returns a `surge` object:

| Field | What it is |
| ----- | ---------- |
| `last` | The latest resolved week: `week`, `outcome`, `cellsLost`, `unitsLost`, `reward`, and `numbers` (everything it was computed from). |
| `next` | A forecast for the week in progress, computed from the kingdom as it is now. |
| `rest` | `on`, `today`, `used`, `left`, `perSeason`, and `seasonEndsOn`. |

The kingdom screen shows a card at the top. All week after a surge, it shows
the surge's result: held or broke through, the numbers, what was paid, and
what was lost. Under it are the forecast for the coming Sunday and a **Rest**
button with the days left.

## Tests

`supabase/tests/mist_surge_test.sql` checks:

- A surge that holds pays 500 gold, 1 ticket, and 150 XP once, costs 5% of the
  garrison, and records one analytics event.
- A surge that breaks through takes exactly 5% of the frontier when the gap is
  big, and 10% × gap ÷ strength when it's small. It takes only frontier, least
  recently visited first, and never home or road cells, also over six
  breakthroughs in a row.
- Land kinds: cells 105 m and 164 m from home, both sides of a road's ring,
  and a tile walked in only 2 of 4 weeks.
- Partly held pays 75 XP; Pikemen lose 10% on a breakthrough.
- The first surge is at half pressure, the second at full, and a player who
  joins 4 days before Sunday waits a week.
- Rest turned on, Rest on by itself, a walk on Sunday that prevents it, and the
  14-day budget.
- The job every hour for 10 days, twice each hour, in New York, London,
  Kiritimati, and Pago Pago, across the nights London and New York leave
  summer time: one surge per week, at Monday 4 a.m. local. A job that runs a
  day late resolves the last week only. A time zone change after a surge
  doesn't run the week again.
- The Monday result as the app sees it, `get_kingdom`, `set_rest`, and that
  building resolves a due surge first.
- Players read only their own results and can't write Rest or run the surge.

## Balance: the first six weeks

The brief asked whether mixing the sheet's values with the design document's
can make surges both hold and break through. `scripts/simulate-surge.mjs`
simulates the first six weeks of three players from the sheet's **Players**
tab (routine, detour-taker, and explorer), with these assumptions:

- Pay, costs, Walls, Pikemen, and XP come from the generated rules.
- The usual routes (2.5 or 3 km) are new ground in week 1 and roads from week
  3, minus about 0.3 km inside the home clearing. Detours and weekend walks add
  frontier every week.
- One construction a day. "Balanced" keeps Walls level with the Keep, builds a
  Barracks, and upgrades the Keep whenever the Ruler level allows. "Defensive"
  never upgrades the Keep. All recruits are recruited, keeping 1,000 gold for
  the next construction.
- The player joins at the start of a season (pressure 1.0) or in week 4
  (pressure 1.375). No Rest.

Results, as surges held out of 6, over the four scenarios (joining in season
week 1 or 4, balanced or defensive):

| Variant | Routine | Detour-taker | Explorer |
| ------- | ------- | ------------ | -------- |
| **As built: no Keep draw, 10 per km** (the sheet's own surge calculator) | 6 | 2 to 6 | 1 to 3 |
| Before the fix: design document Keep draw (800 and up), 10 per km | 0 | 0 | 0 |
| Design document Keep draw × 0.1 (80 and up), 10 per km | 4 to 6 | 1 to 3 | 1 |
| Design document Keep draw (800 and up), 20 per km | 0 | 0 | 0 |

### The decision

The first version used the design document's Keep draw: 800 at Keep level 1,
up to 30,750 at level 10. Next to the sheet's Walls (150 at level 1) and
Pikemen (1 defense each, 14 a week), no simulated player ever held a surge,
not even the gentle first one. In week 2 a balanced detour-taker faced a
strength of 1,455 with a defense of 248.

The user chose to drop the Keep draw, which is the sheet's own surge model:
its **Mist and Bosses** calculator has no Keep draw. Strength per frontier km
stays at the sheet's 10. `supabase/migrations/*_surge_keep_draw.sql` sets
every level's Keep draw to 0 in `private.surge_settings()`. The column stays,
so a Keep draw can come back by changing that one array.

With no Keep draw:

- Routine players hold every surge: their frontier stays small, because their
  usual routes become roads in week 3.
- Balanced detour-takers hold. Detour-takers who stay at Keep and Walls
  level 1 start breaking through in week 3 or 4.
- Explorers break through from week 2 to 4 onward, as their frontier grows
  faster than their Walls and garrison.

The design document's own numbers (Walls 600, Pikeman Defense 6, 20 per km,
with the Keep draw) also break through from week 2 in this simulation,
because the Keep draw grows ×1.5 per Keep level while Pikemen grow by 14 a
week. Its constants are marked as starting values to calibrate.

## Values the sheet doesn't give

The design document's values, the user's decisions, and the placeholders are
all in `private.surge_settings()`, last replaced in
`supabase/migrations/*_surge_keep_draw.sql`:

| Value | Source | Value |
| ----- | ------ | ----- |
| Keep draw by Keep level | The user's decision (was design document 7) | 0 at every level |
| First-surge factor | Design document 7, 16 | 0.5 |
| Days before Sunday to have a first surge that week | Design document 16 | 5 |
| Partly held threshold | Design document 7 | Defense ≥ 0.5 × strength |
| Units that stand firm, and their factor | Design document 11 | Pikemen, 0.5 |
| Rest days a season | Design document 7 | 14 |
| Days of almost no walking before Rest turns on | Design document 7 | 2 |
| Home radius | Design document 5 | 150 m |
| Roads | Design document 5 | Walked in 3 of the last 4 weeks |
| **Placeholder:** almost no walking | None | Less than 0.5 km in a game day |
| **Placeholder:** road ring | None | 1 route tile (zoom 19) around a road tile |
| **Placeholder:** season 1 start | None | Monday, November 16, 2026 |

Other choices made on this page, not values:

- The surge is due at the end of the game week (Monday 4 a.m. local).
- The home cell is the first cell claimed.
- A frontier cell is visited when its route tile or a neighbor is walked.
- Lost land is chosen least recently visited first.
- Losses round down.
- A job that misses more than a week resolves only the last week.

## Not done yet

- Surge themes ("the Mist rises from the river"), Watchtower warnings, Ward,
  beacons, Battlemages, angels, and the Grail.
- Blight: roads and mines at half production for a week after a breakthrough.
- The travel shield, and Rest pausing fading.
- The Founder's Signet relic for holding the first surge.
- Dormant land, which needs imported walks.
- A home the player sets.
