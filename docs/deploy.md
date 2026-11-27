# Deploys: what a merge to main puts live

Every pull request merged into `main` deploys itself. There is no approval click: the protection is that
nothing reaches `main` without a pull request whose checks passed (the `main` ruleset), and that the
production credentials can only be used by jobs running for `main` (the `legend-map-release` environment).

The pipeline is `.github/workflows/deploy.yml`. Each part of the app deploys only what changed since that
part was last deployed, in this order, and a failed step stops the ones after it:

| Step | Runs when these change | What it does |
| --- | --- | --- |
| Plan | always | Finds each part's last deploy and what changed since (`.github/scripts/deployed.mjs`, `plan.mjs`). Stops everything if a migration rule is broken. |
| Database migrations | `supabase/migrations/` | A dry run against the hosted project, then `supabase db push`. |
| Edge Functions | `supabase/functions/<name>/`, or `_shared/` or `supabase/config.toml` (then all) | Deploys those functions with their `config.toml` settings. |
| Painter | `supabase/legend-map-renderer/`, its workflow | Its tests, then its release ([legend-map-deploy.md](legend-map-deploy.md), "Releases"). |
| App update check | `mobile/` | Can the testers' builds run this app? If not: "a native build is needed", and the update waits. |
| App update | (when the check says yes) | An over-the-air update on the `preview` channel, per platform. |

Anything else (documentation, prototypes) deploys nothing.

## Pull requests

`.github/workflows/app-checks.yml` and the renderer's workflow run on every pull request, with no secrets.
The `main` ruleset requires these checks to pass, on a branch that's up to date with `main`, before a merge
(zero approvals stays):

- **Workflow lint** (actionlint, with shellcheck).
- **What merging would deploy:** the pipeline's own tests, then the plan, including exactly which migrations
  will be applied and the migration rules.
- **Renderer tests**, **Database tests** (every migration on a local stack, from scratch and from the hosted
  state) and **Golden tiles**. They're skipped, which counts as passed, when nothing they cover changed.

**App update possible** shows whether an app change can go out over the air; it isn't required, because a
native change is allowed (its update waits for the build).

There's no dry run against the hosted project on a pull request: it needs the Supabase access token, which
any branch could read by editing a workflow. The migrations the plan lists are exactly what will be applied,
because the deploy refuses anything else.

## Safety

- **One deploy at a time.** A merge waits for the running deploy. If a third merge arrives while one is
  waiting, GitHub replaces the waiting one; that's harmless, because every part deploys everything since it
  was last deployed.
- **Each part has its own "last deployed".** It's the commit of the newest Deploy run in which that part's
  job succeeded. So a part that fails (or an app update waiting for a native build) neither holds the other
  parts back nor makes every merge redeploy them.
- **Never older code over newer.** Every deploying job first checks that its part wasn't already deployed
  from a newer commit. GitHub lets a run be re-run for 30 days with its original commit; an old run's re-run
  stops there instead of rolling production back.
- **Every step can run again.** `db push` applies only what's pending; a function or an update is replaced;
  a painter release with an unchanged fingerprint carries on. After a failure, fix it and merge, or re-run
  the newest Deploy run with **Re-run all jobs**. Never **Re-run failed jobs** of an older run: it reuses
  that run's old plan (the guard would stop it).
- **No secrets outside `main`.** The deploy runs only on pushes to `main`; fork pull requests and branches
  never get its secrets. Each job reads only the secrets it names, and the painter's called workflow gets
  exactly its two. Permissions are granted per job, actions are pinned by commit, and the Supabase and EAS
  CLIs by version (`eas-cli` is a devDependency in `mobile/package.json`, installed from the lockfile).

## Credentials

All in the `legend-map-release` environment (**Settings > Environments**), usable only from `main`:

| Secret | Used by | What it needs |
| --- | --- | --- |
| `SUPABASE_ACCESS_TOKEN` | Migrations, Edge Functions | A Supabase access token that can manage the project: the Management API, and a short-lived database login the CLI opens for `db push` (so no database password is stored). |
| `EXPO_TOKEN` | App update | An Expo access token that can publish updates for `@alperortac/local-legend` and read its `preview` environment variables. |
| `LEGEND_MAP_PACKAGES_TOKEN`, `LEGEND_MAP_DEPLOY_KEY` | Painter | See [legend-map-deploy.md](legend-map-deploy.md). |

The environment was the painter's first and now holds every deploy credential of the app: one place to
audit, with the deployment-branch rule already in place and checked.

**How broad the tokens are (a trade-off the owner accepted: "the tokens are okay to have more
permissions").** With zero approvals, anyone with write access can merge a workflow change that uses these
tokens, so a token's reach is what such a change could do:

- **Supabase:** a classic personal access token reaches every project of its account, including ones joined
  later, and can delete projects, read service keys, change billing and reset the database password. The
  Dashboard's newer scoped tokens can be limited to chosen organizations, projects and permissions; one
  limited to this project (with what `db push` and `functions deploy` need) would narrow it.
- **Expo:** an unlimited personal access token of the owner can also download the Android keystore and iOS
  certificates, submit to the stores and delete projects. **Limit access** on the token caps it at a role,
  or a robot user with the Developer role can be used (with **Protect credentials** on in the organization).

## Migrations

Rules, checked on the pull request and again before the deploy:

- **Only add migrations.** A migration that existed at the last migration deploy or before this push may
  already be applied: modifying, renaming or deleting it is refused, because the hosted history would no
  longer match the file. Change things with a new migration.
- **New migrations sort last.** One whose timestamp is older than the newest migration on `main` is refused:
  `db push` won't apply a migration older than the last applied one. This happens when two pull requests
  add migrations in parallel. The ruleset requires a pull request to be up to date with `main` before it
  merges, so its check runs again against the other migration and asks for a rename first (`supabase
  migration new` gives a fresh timestamp).
- **Every migration sets a lock timeout for the session,** for example `set lock_timeout = '3s';` at the
  top (not `set local`, see below). A migration that waits for a lock queues every later query behind it,
  including the app's; with a timeout it fails fast and the deploy can run again. (Migrations up to
  `20261126200000` predate the rule.)
- **Never a reset, never seed data.** The pipeline only runs `db push`.
- **The escape hatch: a migration that never reached the hosted project.** A migration that fails on the
  hosted project (or one that got onto `main` out of order) stops every later migration deploy, and the
  rules above forbid changing it. List its version in `.github/migration-fixes.json` (`never_applied`) in the
  pull request that fixes, renames or deletes it. The plan then allows the change, and the deploy first
  checks the hosted history: if that version was applied after all, it refuses.

The deploy first runs `supabase db push --dry-run --output-format json` against the hosted project and
prints exactly what it would apply. If that includes anything not added since the last migration deploy, it
stops: someone changed the hosted history by hand. Then it applies them and prints the hosted history.

**What "a failed migration applies nothing" depends on.** The CLI runs each file in one transaction, so a
lock timeout or deadlock leaves nothing of it behind, and the job can simply be re-run. That's no longer
true when a file contains `CREATE INDEX CONCURRENTLY`, `VACUUM`, explicit `BEGIN`/`COMMIT`, or a
`-- pg-delta: transaction=false` line: the CLI then splits it, and whatever came before the failing part
stays committed. Make such migrations safe to run again (`if not exists`, `create or replace`). A
`set local` is lost at such a split, which is why the rule asks for a session-level `set lock_timeout`.

**Why no statement timeout is required.** `lock_timeout` covers the dangerous case, a migration queued
behind another lock while everything else queues behind it. It doesn't limit a statement that holds a lock
for long once it has it (a table rewrite, a large update). A fixed statement timeout in every migration
would cut off legitimate long data migrations halfway; instead, a migration that rewrites a big table should
set its own `statement_timeout`, and the pull request is where that's judged.

**See what was applied:** the run's **Database migrations** job, or
`npx supabase migration list --remote`, or `select version, name from supabase_migrations.schema_migrations
order by version desc limit 5` in the SQL editor.

**Undo:** there are no down migrations. Write a new migration that reverses the change and merge it.

**An emergency fix by hand:** in this order, so the next deploy doesn't apply it twice:

1. Write the fix as a migration file (a new, later timestamp), idempotent (`if not exists`,
   `create or replace`, guarded updates), with `set lock_timeout`.
2. Run that file's SQL in the SQL editor.
3. Mark it applied: `npx supabase migration repair --status applied <version> --remote`.
4. Merge the pull request with the file. The deploy's dry run then finds nothing to apply.


## Edge Functions

The deploy runs `supabase functions deploy <name> --use-api` for each changed function. Settings come from
`supabase/config.toml` (`[functions.<name>]`, today `verify_jwt = true` for `sites`, `terrain` and
`detours`), so they stay as they were. A new function is deployed once it has a folder with `index.ts`; add
its `[functions.<name>]` section in the same pull request. Deleting a folder doesn't delete the hosted
function (do that by hand: `npx supabase functions delete <name> --remote`).

A change to `supabase/config.toml` redeploys every function, but nothing else in that file goes live: auth,
storage and API settings aren't pushed by this pipeline (there's no `config push`). Change those in the
Dashboard.

**See what's deployed:** `npx supabase functions list --remote` (version and update time per function), or
**Edge Functions** in the Supabase Dashboard.

**Undo:** revert the commit and merge; the function is deployed again from the reverted code. By hand:
`git checkout <good commit> -- supabase/functions/<name>` then
`npx supabase functions deploy <name> --remote --use-api`, and commit the result.

## Painter

Its tests and release run as before, now called by the deploy after the migrations and functions, so a
painter that needs a new migration never goes live first. The release fails, rather than passing without
publishing, if its two secrets are missing. Everything else is in
[legend-map-deploy.md](legend-map-deploy.md): releases, the webhook that makes Coolify deploy, rollback by
digest.

## App updates

An over-the-air update only reaches phones whose installed build has the same **runtime version**. For this
app that's its fingerprint (`runtimeVersion` policy `fingerprint` in `mobile/app.json`): it changes whenever
native code or native configuration changes. So:

1. **App update check** computes the fingerprint for Android and iOS the way `eas update` does
   (`eas fingerprint:generate --environment preview`) and compares both with `.github/app-runtimes.json`, the
   runtimes of the builds testers have.
2. If either isn't listed, nothing is published. The run stays green, with a warning and a job summary that
   say a native build is needed; the app's "last deployed" stays put, so the update goes out with the merge
   that lists the new build. Database, functions and painter carry on regardless. It never starts a store or
   EAS build.
3. If both are listed, **App update** exports the bundle once with EAS's `preview` environment (which holds
   the app's Supabase settings), checks that both platforms' bundles contain the hosted project's address (a
   missing variable would export as undefined and break the app), and publishes exactly that bundle to the
   `preview` channel, one platform at a time (the combined export fails on the web build), with the commit's
   subject as its message.

The pull request shows the expected result (**App update possible**). It computes the fingerprint without
the Expo token (`expo-updates fingerprint:generate`); for this app, whose configuration is a static
`app.json`, both ways give the same hashes.

**After a native change:** make and distribute the new build ([test-distribution.md](test-distribution.md)),
add its runtime to `.github/app-runtimes.json` in a pull request (and remove runtimes no tester has any
more), and merge it: the waiting update goes out. Get a build's runtime from `npx eas-cli build:list` (its
runtime version) or `npx eas fingerprint:generate --platform <android|ios> --environment preview` on the
commit it was built from.

**See what's live:** `npx eas update:list --branch preview` in `mobile/`, or the project's **Updates** page on
expo.dev. Each platform has its own update group. The Debug screen on a phone shows its update ID and
`BUILD_MARKER`.

**Undo:** roll back each platform's group (each platform has its own):

```sh
cd mobile
npx eas update:rollback <android group id> --platform android --message "Roll back <what>" --non-interactive
npx eas update:rollback <ios group id> --platform ios --message "Roll back <what>" --non-interactive
```

`update:rollback` republishes the group before it, and refuses if the given group isn't the latest any more.
To go back further, `npx eas update:republish --group <group id> --platform <android|ios> --message "…"
--non-interactive` republishes any earlier group. Then revert the commit on `main`, so the next app change
doesn't bring it back.

## What deployed

- **Actions > Deploy:** one run per merge. **Plan** prints each part's last deploy and what it found to
  deploy; each later job is skipped (nothing to do), green (deployed) or red (stopped there). A waiting app
  update shows as a warning with a summary.
- **Settings > Environments > legend-map-release:** every job that used it, with its run.
