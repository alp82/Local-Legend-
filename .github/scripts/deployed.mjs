#!/usr/bin/env node
// Where each part of the app stands, from the deploy pipeline's own history (docs/deploy.md, Safety):
//
//   node .github/scripts/deployed.mjs bases                     prints {"migrations": "<sha>", …} for every part
//   node .github/scripts/deployed.mjs guard --component <part>  exits 1 if a newer run already started deploying it
//
// bases — one pass over earlier Deploy runs on main, newest first. A part is up to date at a run's commit when
//   its job succeeded there, or when it was skipped because nothing of it had changed (the plan succeeded and
//   every job before it succeeded or was skipped). An app update waiting for a native build is not up to date.
//   A skipped job counts only in a run that wasn't cancelled (a cancel can skip jobs that had work to do), and
//   a job missing from the run counts as not up to date (a renamed job must not pass silently).
//   A part never deployed by this pipeline counts from ANCHOR, main's head when the pipeline was introduced
//   (everything was deployed by hand or by the earlier painter pipeline up to there). So does a part with no
//   answer within MAX_RUNS runs (with a warning): every step is safe to repeat, so deploying everything since
//   the anchor deploys more, never less, and a part that's behind (an app update waiting for a native build for
//   a long time) never blocks the others.
// guard — a run may deploy a part only if no newer run (higher run number) has started deploying it, whether that
//   job succeeded or failed partway (one platform published, some functions deployed): GitHub lets a run be
//   re-run for 30 days with its original commit, and that must never put older code back.
//
// Needs GITHUB_TOKEN (actions: read), GITHUB_REPOSITORY, GITHUB_RUN_ID, GITHUB_RUN_NUMBER.
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

export const ANCHOR = '76f388d17c5c900cb6328bddc95e2d1270e81491';
export const MAX_RUNS = 100;

/** The jobs of a run that matter per part (a called workflow's jobs are named "<caller> / <job>"). */
export const JOBS = {
  plan: 'Plan (what changed since each part was deployed)',
  migrations: 'Database migrations',
  functions: 'Edge Functions',
  painterCaller: 'Painter',
  painter: 'Painter / Release (image by digest, deploy branch)',
  appCheck: 'App update check (runtime fingerprint)',
  app: 'App update (over the air)',
};
export const PARTS = ['migrations', 'functions', 'painter', 'app'];
/** The job whose start means the part is being deployed. */
export const DEPLOYING_JOB = { migrations: JOBS.migrations, functions: JOBS.functions, painter: JOBS.painter, app: JOBS.app };

const ok = (c) => c === 'success' || c === 'skipped';

/**
 * Whether a run left each part up to date at its commit.
 * @param {Record<string, string>} c  job name → conclusion (absent: the job didn't appear in the run, which
 *   never counts: every job of deploy.yml is listed, skipped or not)
 * @param {string} runConclusion  the run's conclusion; in a cancelled run only successes count
 */
export function upToDate(c, runConclusion = 'success') {
  const planOk = c[JOBS.plan] === 'success';
  const before = { migrations: true, functions: ok(c[JOBS.migrations]) };
  before.painter = before.functions && ok(c[JOBS.functions]);
  before.app = before.painter && (c[JOBS.painter] ? c[JOBS.painter] === 'success' : ok(c[JOBS.painterCaller]));
  const skippedClean = (job, part) => runConclusion !== 'cancelled' && planOk && before[part] && c[job] === 'skipped';
  return {
    migrations: c[JOBS.migrations] === 'success' || skippedClean(JOBS.migrations, 'migrations'),
    functions: c[JOBS.functions] === 'success' || skippedClean(JOBS.functions, 'functions'),
    painter: c[JOBS.painter] === 'success' || (!c[JOBS.painter] && skippedClean(JOBS.painterCaller, 'painter')),
    // the check skipped: no app changes; the check passed but the update didn't run: waiting for a native build
    app: c[JOBS.app] === 'success' || skippedClean(JOBS.appCheck, 'app'),
  };
}

async function* completedRuns(api, repo, currentRunId) {
  for (let page = 1; ; page++) {
    const { workflow_runs: runs = [] } = await api(`/repos/${repo}/actions/workflows/deploy.yml/runs?branch=main&event=push&per_page=50&page=${page}`);
    if (!runs.length) return;
    for (const run of [...runs].sort((a, b) => b.run_number - a.run_number)) {
      if (String(run.id) === String(currentRunId) || run.status !== 'completed') continue;
      yield run;
    }
  }
}

async function conclusions(api, repo, run) {
  const { jobs = [] } = await api(`/repos/${repo}/actions/runs/${run.id}/jobs?filter=latest&per_page=100`);
  return Object.fromEntries(jobs.map((j) => [j.name, j.conclusion]));
}

/**
 * Every part's base: the newest commit it's up to date at; ANCHOR when the history runs out or a part has no
 * answer within `maxRuns` runs (those parts are listed in `behind`).
 * @returns {Promise<{ bases: Record<string, string>, behind: string[] }>}
 */
export async function bases(api, repo, currentRunId, { maxRuns = MAX_RUNS } = {}) {
  const found = {};
  let seen = 0;
  let capped = false;
  for await (const run of completedRuns(api, repo, currentRunId)) {
    if (++seen > maxRuns) {
      capped = true;
      break;
    }
    const state = upToDate(await conclusions(api, repo, run), run.conclusion);
    for (const p of PARTS) if (!found[p] && state[p]) found[p] = run.head_sha;
    if (PARTS.every((p) => found[p])) break;
  }
  return {
    bases: Object.fromEntries(PARTS.map((p) => [p, found[p] ?? ANCHOR])),
    behind: capped ? PARTS.filter((p) => !found[p]) : [],
  };
}

/** Newer runs that started deploying `part` (the reason to refuse), as "#<number> (<conclusion>)" strings. */
export async function newerAttempts(api, repo, part, currentRunNumber) {
  const attempts = [];
  for await (const run of completedRuns(api, repo, null)) {
    if (run.run_number <= Number(currentRunNumber)) break;
    const c = (await conclusions(api, repo, run))[DEPLOYING_JOB[part]];
    if (c && c !== 'skipped') attempts.push(`#${run.run_number} (${c})`);
  }
  return attempts;
}

async function main() {
  const { positionals: [mode], values } = parseArgs({ allowPositionals: true, options: { component: { type: 'string' } } });
  const { GITHUB_TOKEN, GITHUB_REPOSITORY, GITHUB_RUN_ID, GITHUB_RUN_NUMBER } = process.env;
  const apiUrl = process.env.GITHUB_API_URL || 'https://api.github.com';
  let calls = 0;
  const api = async (path) => {
    calls++;
    const res = await fetch(`${apiUrl}${path}`, { headers: { authorization: `Bearer ${GITHUB_TOKEN}`, accept: 'application/vnd.github+json' } });
    if (!res.ok) throw new Error(`GET ${path}: ${res.status}`);
    return res.json();
  };
  if (mode === 'bases') {
    const { bases: b, behind } = await bases(api, GITHUB_REPOSITORY, GITHUB_RUN_ID);
    for (const p of behind) {
      console.error(`::warning title=${p} counts from the anchor::No run in the last ${MAX_RUNS} left ${p} up to date, so it deploys everything since ${ANCHOR} (safe to repeat).`);
    }
    console.log(JSON.stringify(b));
    console.error(`(${calls} API calls)`);
    return;
  }
  if (mode !== 'guard' || !PARTS.includes(values.component)) throw new Error(`usage: deployed.mjs bases | guard --component ${PARTS.join('|')}`);
  const newer = await newerAttempts(api, GITHUB_REPOSITORY, values.component, GITHUB_RUN_NUMBER);
  if (newer.length) {
    console.log(`::error::A newer Deploy run already started deploying ${values.component}: ${newer.join(', ')}. This run (#${GITHUB_RUN_NUMBER}) ` +
      'is older; deploying it would put older code back. Re-run the newest Deploy run instead (docs/deploy.md, Safety).');
    process.exit(1);
  }
  console.log(`${values.component}: no newer run has deployed it; run #${GITHUB_RUN_NUMBER} may (${calls} API calls)`);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => {
    console.log(`::error::${e.message}`);
    process.exit(1);
  });
}
