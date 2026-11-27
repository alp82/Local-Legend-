#!/usr/bin/env node
// Which commit each part of the app was last deployed from, per the deploy pipeline's own history
// (docs/deploy.md): the newest run of deploy.yml on main in which that part's job succeeded.
//
//   node .github/scripts/deployed.mjs base --component <name>    prints that commit (empty: never deployed)
//   node .github/scripts/deployed.mjs guard --component <name>   exits 1 unless that commit is this run's commit
//                                                                or one of its ancestors
//
// The base is where the part's changes are counted from, so one part failing (or waiting for a native build)
// neither redeploys the others on every merge nor holds them back. The guard stops a re-run of an older run
// from deploying older code over newer code: GitHub lets a run be re-run for 30 days, with its original commit.
//
// Needs GITHUB_TOKEN (actions: read), GITHUB_REPOSITORY, GITHUB_SHA; GITHUB_API_URL defaults to github.com.
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

/** The job whose success means the part is deployed (a called workflow's jobs are named "<caller> / <job>"). */
export const COMPONENT_JOBS = {
  migrations: 'Database migrations',
  functions: 'Edge Functions',
  painter: 'Painter / Release (image by digest, deploy branch)',
  app: 'App update (over the air)',
};

/**
 * The head commit of the newest run (by run number) whose job `jobName` succeeded, or ''.
 * @param {(path: string) => Promise<any>} api  GET a REST path, returning the parsed JSON
 */
export async function lastDeployed(api, repo, jobName, { maxRuns = 100 } = {}) {
  let page = 1;
  let seen = 0;
  while (seen < maxRuns) {
    const { workflow_runs: runs = [] } = await api(`/repos/${repo}/actions/workflows/deploy.yml/runs?branch=main&event=push&per_page=50&page=${page}`);
    if (!runs.length) return '';
    for (const run of [...runs].sort((a, b) => b.run_number - a.run_number)) {
      seen++;
      const { jobs = [] } = await api(`/repos/${repo}/actions/runs/${run.id}/jobs?filter=latest&per_page=100`);
      if (jobs.some((j) => j.name === jobName && j.conclusion === 'success')) return run.head_sha;
    }
    page++;
  }
  return '';
}

/** True when `ancestor` is `commit` or an ancestor of it (an empty ancestor: nothing deployed yet). */
export function isAncestor(ancestor, commit, git = (...a) => execFileSync('git', a, { stdio: 'ignore' })) {
  if (!ancestor) return true;
  try {
    git('merge-base', '--is-ancestor', ancestor, commit);
    return true;
  } catch {
    return false;
  }
}

async function main() {
  const { positionals: [mode], values } = parseArgs({ allowPositionals: true, options: { component: { type: 'string' } } });
  const jobName = COMPONENT_JOBS[values.component];
  if (!['base', 'guard'].includes(mode) || !jobName) throw new Error(`usage: deployed.mjs base|guard --component ${Object.keys(COMPONENT_JOBS).join('|')}`);
  const { GITHUB_TOKEN, GITHUB_REPOSITORY, GITHUB_SHA } = process.env;
  const apiUrl = process.env.GITHUB_API_URL || 'https://api.github.com';
  const api = async (path) => {
    const res = await fetch(`${apiUrl}${path}`, { headers: { authorization: `Bearer ${GITHUB_TOKEN}`, accept: 'application/vnd.github+json' } });
    if (!res.ok) throw new Error(`GET ${path}: ${res.status}`);
    return res.json();
  };
  const sha = await lastDeployed(api, GITHUB_REPOSITORY, jobName);
  if (mode === 'base') {
    console.log(sha);
    return;
  }
  if (!isAncestor(sha, GITHUB_SHA)) {
    console.log(`::error::${values.component} was already deployed from ${sha}, which is newer than this run's ${GITHUB_SHA}. ` +
      'This is a re-run of an older run: deploying it would put older code back. Re-run the newest Deploy run instead (docs/deploy.md).');
    process.exit(1);
  }
  console.log(`${values.component}: last deployed from ${sha || 'nothing yet'}; ${GITHUB_SHA} is newer, so it may deploy`);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) await main();
