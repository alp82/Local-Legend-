# Deploys: what a merge to main puts live

Every pull request merged into `main` deploys itself. There is no approval click: the protection is that
nothing reaches `main` without a pull request (the `main` ruleset), and that the production credentials
can only be used by jobs running for `main` (the `legend-map-release` environment).

The pipeline is `.github/workflows/deploy.yml`. It deploys only what changed since the last successful
deploy, in this order, and a failed step stops the ones after it:

| Step | Runs when these change | What it does |
| --- | --- | --- |
| Plan | always | Lists what changed (`.github/scripts/plan.mjs`). Stops everything if a migration rule is broken. |
| Database migrations | `supabase/migrations/` | A dry run against the hosted project, then `supabase db push`. |
| Edge Functions | `supabase/functions/<name>/`, or `_shared/` or `supabase/config.toml` (then all) | Deploys those functions with their `config.toml` settings. |
| Painter | `supabase/legend-map-renderer/`, its workflow | Its tests, then its release ([legend-map-deploy.md](legend-map-deploy.md), "Releases"). |
| App update | `mobile/` | An over-the-air update on the `preview` channel, if the testers' builds can run it. |

Anything else (documentation, prototypes) deploys nothing.

Pull requests get `.github/workflows/app-checks.yml`, with no secrets: the workflow lint, the pipeline's
tests, what merging would deploy (including the exact migrations), and whether an app change can go out
over the air. The renderer's workflow also runs every migration on a local stack.

## Safety

- **One deploy at a time.** Merges queue behind each other; none is cancelled. If a newer merge replaces a
  queued one, the newer run deploys both: it always deploys everything since the last successful run.
- **Every step can run again.** `db push` applies only what's pending; a function or an update is replaced;
  a painter release with an unchanged fingerprint carries on. So the fix for a failed step is to re-run
  it (**Actions > Deploy > the run > Re-run failed jobs**) or merge the fix: the next run picks up
  everything since the last success.
- **No secrets outside `main`.** The deploy runs only on pushes to `main`; fork pull requests and branches
  never get its secrets. Each job reads only the secrets it names. Permissions are granted per job, and
  actions are pinned by commit.

## Credentials

All in the `legend-map-release` environment (**Settings > Environments**), usable only from `main`:

| Secret | Used by | What it needs |
| --- | --- | --- |
| `SUPABASE_ACCESS_TOKEN` | Migrations, Edge Functions | A Supabase personal access token of an account that can manage the project. The CLI uses it for the Management API and to open a short-lived database login for `db push`, so no database password is stored. |
| `EXPO_TOKEN` | App update | An Expo access token that can publish updates for `@alperortac/local-legend` and read its `preview` environment variables. |
| `LEGEND_MAP_PACKAGES_TOKEN`, `LEGEND_MAP_DEPLOY_KEY` | Painter | See [legend-map-deploy.md](legend-map-deploy.md). |

The environment was the painter's first and now holds every deploy credential of the app: one place to
audit, with the deployment-branch rule already in place and checked. Supabase and Expo tokens can't be
narrowed to one project or to read-only; the owner accepted broader tokens ("the tokens are okay to have
more permissions").

## Migrations

Rules, checked on the pull request and again before the deploy:

- **Only add migrations.** A migration that already exists on `main` may already be applied: modifying,
  renaming or deleting it is refused, because the hosted history would no longer match the file. Change
  things with a new migration.
- **Every migration sets a lock timeout,** for example `set lock_timeout = '3s';` at the top. A migration
  that waits for a lock queues every later query behind it, including the app's; with a timeout it fails
  fast and the deploy can run again. (Migrations up to `20261126200000` predate the rule.)
- **Never a reset, never seed data.** The pipeline only runs `db push`.

The deploy first runs `supabase db push --dry-run` against the hosted project and prints exactly what it
would apply. If that includes anything the merged changes didn't add, it stops: someone changed the hosted
history by hand. Then it applies them and prints the hosted history.

**See what was applied:** the run's **Database migrations** job, or
`npx supabase migration list --remote`, or `select version, name from supabase_migrations.schema_migrations
order by version desc limit 5` in the SQL editor.

**Undo:** there are no down migrations. Write a new migration that reverses the change and merge it. In an
emergency, fix it in the SQL editor, then commit the same change as a migration and mark it applied
(`npx supabase migration repair --status applied <version> --remote`) so the history matches.

**If the deploy stops on a lock timeout or a deadlock:** nothing of that migration was applied. Re-run the
job.

## Edge Functions

The deploy runs `supabase functions deploy <name> --use-api` for each changed function. Settings come from
`supabase/config.toml` (`[functions.<name>]`, today `verify_jwt = true` for `sites`, `terrain` and
`detours`), so they stay as they were. A new function is deployed once it has a folder with `index.ts`; add
its `[functions.<name>]` section in the same pull request. Deleting a folder doesn't delete the hosted
function (do that by hand: `npx supabase functions delete <name> --remote`).

**See what's deployed:** `npx supabase functions list --remote` (version and update time per function), or
**Edge Functions** in the Supabase Dashboard.

**Undo:** revert the commit and merge; the function is deployed again from the reverted code. By hand:
`git checkout <good commit> -- supabase/functions/<name>` then
`npx supabase functions deploy <name> --remote --use-api`, and commit the result.

## Painter

Its tests and release run as before, now called by the deploy after the migrations and functions, so a
painter that needs a new migration never goes live first. Everything else is in
[legend-map-deploy.md](legend-map-deploy.md): releases, the webhook that makes Coolify deploy, rollback by
digest.

## App updates

An over-the-air update only reaches phones whose installed build has the same **runtime version**. For this
app that's its fingerprint (`runtimeVersion` policy `fingerprint` in `mobile/app.json`): it changes whenever
native code or native configuration changes. So the deploy:

1. Computes the fingerprint for Android and iOS.
2. Compares both with `.github/app-runtimes.json`, the runtimes of the builds testers have.
3. If both are listed, publishes the update to the `preview` channel, one platform at a time (the combined
   command fails on the web export), with the commit's subject as its message. EAS's `preview` environment
   supplies the app's Supabase settings.
4. If either isn't listed, publishes nothing and fails with "a native build is needed": testers never get an
   update their build can't run. It never starts a store or EAS build.

The pull request already shows the result (**App checks > App update possible**).

**After a native change:** make and distribute the new build ([test-distribution.md](test-distribution.md)),
add its runtime to `.github/app-runtimes.json` in a pull request (and remove runtimes no tester has any
more), and merge it: the update for the new runtime goes out. Get a build's runtime from
`npx eas-cli@latest build:list` (its runtime version) or `npx expo-updates fingerprint:generate --platform
<android|ios>` on the commit it was built from.

**See what's live:** `npx eas-cli@latest update:list --branch preview` in `mobile/`, or the project's
**Updates** page on expo.dev. The Debug screen on a phone shows its update ID and `BUILD_MARKER`.

**Undo:** republish the previous update group per platform:
`npx eas-cli@latest update:republish --group <previous group id> --platform android` (and `ios`). Phones pick
it up like any update. Then revert the commit on `main`, so the next app change doesn't bring it back.

## What deployed

- **Actions > Deploy:** one run per merge. The **Plan** job prints what it found to deploy and from which
  commit; each later job is skipped (nothing to do), green (deployed) or red (stopped there).
- **Settings > Environments > legend-map-release:** every job that used it, with its run.
