# Supabase backend

This directory holds the Supabase configuration, database migrations, and
database tests for Local Legend.

Players sign in anonymously, so every player gets a real auth user without an
email address. You can link an email or OAuth identity to that user later.
Each player has one row in `public.player_state`. Row level security (RLS)
allows a player to read, create, and update only their own row.

## Territory

The phone reports walks as batches of GPS points. The server validates the
points and saves the land the player claimed as map cells. The migration
`migrations/*_territory.sql` defines everything below.

### Cells

A cell is a square Web Mercator tile at zoom 21, the same grid as XYZ map
tiles. A cell is about 19.1 m wide at the equator and 19.1 m × cos(latitude)
on the ground, for example 11.8 m at 52°N. The cell id is `x * 2^21 + y`. A
walk claims every cell whose center lies within 30 m of the path, which gives
the 60 m strip from the design document.

The H3 Postgres extension isn't available on Supabase, so cells are computed
in plain SQL with PostGIS. No Edge Function is needed.

### Functions

| Function                                                  | Purpose |
| --------------------------------------------------------- | ------- |
| `submit_location_batch(p_batch_id, p_session_id, p_points)` | Validates one batch and claims cells. Idempotent per player and batch id. |
| `get_territory()`                                         | Returns the caller's land as merged GeoJSON polygons, `totalCells`, and `areaM2`. |
| `private.purge_walk_points(older_than)`                   | Deletes `walk_points` rows older than 30 days by default. Not callable by clients. |

Clients can only `SELECT` their own rows from the territory tables. All
writes go through `submit_location_batch`.

`submit_location_batch` raises `42501` when the caller isn't signed in, and
`22023` when the batch is malformed or has more than 500 points. Retrying
won't fix a `22023` error. Invalid individual points don't raise an error;
they're counted in `rejectedPoints`.

### Rules

All thresholds live in `private.claim_rules()`:

- Points with accuracy worse than 35 m, or no accuracy, are rejected.
- Points more than 1 minute in the future or more than 7 days old are
  rejected, as are repeated timestamps within a session.
- Consecutive points of a session are connected in time order, across
  batches and regardless of arrival order. A segment is claimed only if its
  speed is at most 3.5 m/s.
- A segment longer than 2 minutes or 250 m is a gap and isn't claimed. A
  point with a gap on both sides claims a 30 m disk around itself. A point
  next to a too-fast segment claims nothing, so a car trip claims no land.

### Tables

- `claimed_cells`: one row per player and cell.
- `walk_sessions`: per-session stats: accepted and rejected points, first and
  last point time, distance on foot, and new cells.
- `location_batches`: one row per processed batch, used for idempotency.
- `walk_points`: raw accepted GPS points.

**Temporary:** `walk_points` exists only for the commute test phase, to
diagnose tracking quality. It stores GPS tracks, which conflicts with the
design rule that the app stores land, not tracks. It's also used to connect
batches that arrive out of order. Run `select private.purge_walk_points();`
to delete points older than 30 days. Drop the table before launch.

## Before you begin

- Install Docker and make sure it's running.
- Install Node.js. The commands below run the Supabase CLI through `npx`, so
  you don't need a global install.

Run all commands from the repository root.

## Start the local stack

```sh
npx supabase@latest start
```

The command prints the local URLs and keys. To print them again, run:

```sh
npx supabase@latest status
```

The values the mobile app needs are:

| Name              | Local value                                       |
| ----------------- | ------------------------------------------------- |
| `API_URL`         | `http://127.0.0.1:54321`                          |
| `PUBLISHABLE_KEY` | Starts with `sb_publishable_`. Use it as the client key. |

Studio runs at `http://127.0.0.1:54323`.

To stop the stack, run `npx supabase@latest stop`.

## Reset the local database

To drop the local database and apply every migration again, run:

```sh
npx supabase@latest db reset
```

## Run the database tests

The pgTAP tests in `tests/` check the RLS policies, table and function
privileges, the `player_state` constraints and trigger, and the territory
rules: idempotency, connecting batches, speed, gap, and accuracy rejection,
and the shape of `get_territory`.

```sh
npx supabase@latest test db
```

## Change the schema

1. Create a migration file:

   ```sh
   npx supabase@latest migration new <name>
   ```

1. Write the SQL, then run `db reset` and `test db`.
1. Regenerate the TypeScript types for the mobile app:

   ```sh
   npx supabase@latest gen types typescript --local > mobile/src/lib/database.types.ts
   ```

## Link a hosted project

When you're ready to use a hosted Supabase project, do the following:

1. Log in to the Supabase CLI:

   ```sh
   npx supabase@latest login
   ```

1. Link this directory to the project. Find the project ref in the project's
   dashboard URL.

   ```sh
   npx supabase@latest link --project-ref <project-ref>
   ```

1. Apply the migrations to the hosted database. In CLI 3, `db push` targets
   the local database unless you pass `--remote`.

   ```sh
   npx supabase@latest db push --remote --dry-run
   npx supabase@latest db push --remote
   ```

1. Turn on anonymous sign-ins in the dashboard under **Authentication** >
   **Sign In / Providers**. Don't run `config push`: `config.toml` holds
   local-development defaults, and pushing it would turn off email
   confirmations and MFA on the hosted project. Run `config diff` to compare.

1. In the mobile app, use the hosted project URL and publishable key from the
   dashboard instead of the local values.

## Hosted project

- Project: **Local Legend App**, ref `bvnlepwccygdkgsezgka`, region
  `eu-west-1`. This directory is linked to it.
- Anonymous sign-ins are on. The `player_state` and `territory` migrations
  are applied.
- `mobile/.env.local` and the EAS `development`, `preview`, and `production`
  environments hold `EXPO_PUBLIC_SUPABASE_URL` and `EXPO_PUBLIC_SUPABASE_KEY`
  for this project.

Anonymous sign-ins are rate limited per IP address. Consider enabling CAPTCHA
for the hosted project to limit abuse.
