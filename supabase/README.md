# Supabase backend

This directory holds the Supabase configuration, database migrations, and
database tests for Local Legend.

Players sign in anonymously, so every player gets a real auth user without an
email address. You can link an email or OAuth identity to that user later.
Each player has one row in `public.player_state`. Row level security (RLS)
allows a player to read, create, and update only their own row.

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

The pgTAP tests in `tests/` check the RLS policies, table privileges, the
`display_name` check, and the `updated_at` trigger.

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
- Anonymous sign-ins are on. The `player_state` migration is applied.
- `mobile/.env.local` and the EAS `development`, `preview`, and `production`
  environments hold `EXPO_PUBLIC_SUPABASE_URL` and `EXPO_PUBLIC_SUPABASE_KEY`
  for this project.

Anonymous sign-ins are rate limited per IP address. Consider enabling CAPTCHA
for the hosted project to limit abuse.
