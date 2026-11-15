# Analytics

This page describes the events the game records, how they're kept honest and
private, and the SQL that computes the phase 2 beta targets from them. The SQL
lives in `supabase/migrations/*_analytics.sql`, and the tests in
`supabase/tests/analytics_test.sql`.

Events are stored in our own Supabase Postgres, in `public.analytics_events`.
There's no third-party analytics service or SDK.

## Events

| Event | Recorded when | Recorded by | Unique per player by | Properties |
| ----- | ------------- | ----------- | -------------------- | ---------- |
| `app_open` | The app launches or comes back to the foreground. | `record_app_open`, called by the app | The app's open id | None |
| `walk_batch` | A location batch stores at least one GPS point. | `submit_location_batch` | Batch id | `sessionId`, `acceptedPoints`, `rejectedPoints`, `newCells` |
| `detour_offered` | A detour offer is made, on app open or by the scheduled job. | `generate_detour_offers` | Offer id | `offerId`, `slot`, `band`, `addedMin`, `spotKind`, `rewardKind` |
| `detour_collected` | A walk collects a detour offer. | `claim_settled` | Offer id | `offerId`, `slot`, `band`, `addedMin`, `rewardKind`, `reward`, `xp` |
| `building_built` | A construction succeeds. | `build_building` | Request id | `building`, `level` |
| `units_recruited` | A recruitment succeeds. | `recruit_units` | Request id | `unit`, `count` |
| `surge_result` | The weekly Mist surge resolves for a player. | `private.record_surge_result`, called by step 5 | Surge week | See [Surge results](#surge-results) |

"Walks captured" are counted from `walk_batch`: the number of distinct
`(user_id, props->>'sessionId')` pairs is the number of walks, and the batch
count is the number of uploads.

Every event has:

- `game_day`: the game day it belongs to. Game days start at 4 a.m. in the
  player's time zone, as described in
  [The game day and time zones](economy.md#the-game-day-and-time-zones). The
  day is fixed when the event is recorded, in the player's time zone at that
  moment.
- `occurred_at`: when it happened. This is the server's time, except for
  `walk_batch`, where it's the GPS time of the batch's last point (never later
  than the server's time). A walk queued offline counts toward the day it was
  walked, like walking pay.
- `dedup_key`: what makes the event unique for the player and event type.

For detours, `game_day` is the offer's game day. An offer can only be
collected on its own game day, so the collection's day is the same.

### Server-side events can't be faked or doubled

The app can't write events. Server-side events come from triggers on the rows
that the game functions already write: `location_batches`, `detour_offers`,
and `kingdom_actions`. A trigger runs inside the transaction of the function
that writes the row, so:

- An event exists exactly when the fact it records was committed. A walk or
  build that fails and rolls back leaves no event.
- A retried request writes no new row, so it records no new event. A repeated
  batch id returns before its counts are set, and a repeated build or recruit
  request id returns the stored result without writing.
- A refused build or recruitment (daily limit, not enough resources) writes no
  `kingdom_actions` row and records nothing.
- The unique key `(user_id, event, dedup_key)` makes a second copy fail
  silently even if a code path ran twice.

Triggers keep the event code in one migration instead of in copies of the
large walk and detour functions, which every migration that changes them
replaces in full.

### App opens

The app calls `record_app_open(p_open_id, p_time_zone)` from the root layout on
launch and on every return to the foreground (`mobile/src/lib/analyticsApi.ts`).
The app makes one open id per open and reuses it when it retries after a
network failure, so a request that reached the server but whose answer was
lost counts once.

- The server records the time, never the app.
- `p_time_zone` is stored like `get_economy` does, so the first open of a new
  player already counts in their local game day.
- At most 50 opens a game day are recorded per player, so a modified app can't
  fill the table. Retries of an open already recorded still answer
  `duplicate: true`.
- The function returns `{recorded, duplicate, capped, gameDay,
  timeZoneAccepted}`.

### Surge results

The Mist surge (plan step 5) isn't built yet. Its result event is defined now:
step 5 calls `private.record_surge_result` for each player, in the same
transaction that applies the result:

```sql
perform private.record_surge_result(
  p_user       => v_user,
  p_week       => v_week,         -- Monday of the game week the surge closes
  p_held       => v_pressure <= v_defense,
  p_pressure   => v_pressure,     -- strength: Keep draw and frontier length
  p_defense    => v_defense,      -- Walls and garrison
  p_cells_lost => v_cells_lost,   -- frontier cells lost (a count, never which cells)
  p_units_lost => v_units_lost,   -- garrison losses
  p_reward     => v_reward,       -- JSON object of what a hold paid, or null
  p_gentle     => v_first_surge,  -- the half-pressure first surge
  p_at         => now());
```

- It records once per player and week and returns `false` for a repeat, so a
  rerun of the surge job records nothing new. Step 5 should still guard its
  own payouts.
- `p_week` must be a Monday; anything else raises `22023`.
- The event's `game_day` is the game day of `p_at` in the player's time zone.
  A surge that runs on Sunday night before 4 a.m. Monday belongs to Sunday.
- Clients can't call it.

## Privacy

- Events never hold GPS points or positions. They hold counts, ids, and
  labels: no coordinates, spot names, or cells. A detour event names the
  offer's id; the offer row with its position is readable only by its owner.
- A check constraint on `props` refuses the usual location keys (`lat`, `lng`,
  `geom`, `location`, `points`, `name`, and others) as a second line of
  defense.
- Events are deleted with the player's account (`on delete cascade`).

## Who can read and write

| Who | `public.analytics_events` | `analytics` schema (metrics) |
| --- | ------------------------- | ---------------------------- |
| A signed-in player | Read their own rows only (row level security). No insert, update, or delete. | No access. |
| Signed-out clients | No access. | No access. |
| `service_role` and the database owner | Full access. | Read and execute. |

The `analytics` schema isn't exposed through the Data API. Run the metrics in
the SQL editor of the Supabase dashboard, through `psql`, or with the service
role.

## Definitions

### Game day

A game day starts at 4 a.m. in the player's time zone and lasts until 4 a.m.
the next day. This is the same day the game uses for daily limits, the Keep
tax, and detour offers (`rules.dailyResetHour`). Someone who plays at 1 a.m.
after a late evening is still in that evening's day, which matches how players
think about "today".

### Active day

A game day on which the player recorded at least one `app_open`,
`building_built`, or `units_recruited` event. These are things a player does
with the app open.

Walks and detour collections alone don't make a day active. Background
tracking keeps uploading walks for a player who stopped opening the app, and
the beta question is whether the loop brings players back to the game.
Building and recruiting happen in the app, so they always come with an open;
they're included so an active day doesn't depend on the open reaching the
server.

The list is `activity_events` in `analytics.settings()`.

### Week

A week is 7 game days starting on Monday: from Monday at 4 a.m. local to the
next Monday at 4 a.m. (`private.game_week`, the same weeks that Pikemen grow
in).

Monday fits the game: the Mist surge runs on Sunday night and its result is
shown on Monday morning, so a week ends with its surge. A player's activity on
Saturday and Sunday counts in the same week as the surge it prepares for.

### Signup and week numbers

A player signs up when their account is created (`auth.users.created_at`,
the first anonymous sign-in). The signup day is that moment's game day in the
player's current time zone.

Week 1 is the first full week that starts on or after the signup day. A player
who signs up on a Monday starts week 1 that day; one who signs up on a
Tuesday starts week 1 the next Monday. The partial week of signup is week 0.

Counting from the first full week means week 3 starts 14 to 20 days after
signup, so "the third week" always means at least two full weeks of play
before it. A partial first week would let players who signed up late in a week
reach week 3 after only 8 days.

## Beta targets

### Retention: 4 or more active days a week, from week 3

For each week: of the players who are in their week 3 or later (eligible), the
share who had 4 or more active days that week (retained). Players who never
came back count as eligible and not retained.

```sql
select * from analytics.weekly_retention('2026-12-01', '2027-01-31');
-- week | eligible_players | retained_players | retention
```

### Detour share: active players who collect a detour

For each week: of the players with at least one active day that week, the
share who collected at least one detour that week.

```sql
select * from analytics.weekly_detour_share('2026-12-01', '2027-01-31');
-- week | active_players | detour_players | detour_share
```

### Both targets over a period

`analytics.beta_targets(p_from, p_to)` pools the weeks from the week of
`p_from` to the week of `p_to`: every eligible or active player counts once in
every week.

```sql
select * from analytics.beta_targets('2026-12-01', '2027-01-31');
-- eligible_player_weeks | retained_player_weeks | retention
-- active_player_weeks | detour_player_weeks | detour_share
```

Each function takes any day in the first and last weeks. The current week
counts with the days it has so far, so leave it out for final numbers. A
share is null when its week has no eligible or active players.

### Building blocks

| View | One row per |
| ---- | ----------- |
| `analytics.players` | Player: `signed_up_at`, `time_zone`, `signup_day`, and `first_week` (the Monday that starts week 1). |
| `analytics.active_days` | Player and active game day. |
| `analytics.player_weeks` | Player and week with any event: `active_days` and `detours_collected`. |

## Tests

`supabase/tests/analytics_test.sql` checks:

- Every event type is recorded by the function that does the work, once: a
  retried app open, batch, build, recruitment, or surge, and a second walk
  past a collected offer, record nothing new. Refused builds and batches with
  no accepted points record nothing.
- App opens use the server's time and the player's time zone, and stop at the
  daily cap.
- Walk days at the 4 a.m. boundary in UTC+10 and UTC−5, and builds at 03:59
  local.
- No positions in event properties.
- Players read only their own events and can't write any; they can't call the
  recorders or read the metrics.
- Seven synthetic players over two weeks, covering signup on a Monday and a
  Tuesday, a signup day that differs by time zone, a player in week 2, a
  churned player, walks without opens, two opens on one day, Sunday as the
  last day of a week, and events outside the range. Both targets match the
  hand-computed values exactly (2/4 and 4/6 retention, 3/5 and 2/5 detour
  share, 6/10 and 5/10 pooled).

## Placeholder values

Neither the sheet nor the plan gives these values. They're in
`analytics.settings()`:

| Value | Placeholder |
| ----- | ----------- |
| App opens recorded per player and game day | 50 |

The week start (Monday), the events that make a day active, and counting weeks
from the first full week after signup are definitions chosen on this page, not
values from the plan.
