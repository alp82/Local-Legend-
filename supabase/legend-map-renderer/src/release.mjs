// The worker's side of releases (supabase/migrations/*_fantasy_releases.sql): it reports its painter fingerprint
// when it starts, switches phones to a staged version once it's painted, and deletes the files of replaced
// versions after their grace period. Everything runs as the renderer user; nobody runs SQL, and the deploy
// pipeline needs no database credential.

const ADVANCE_EVERY_MS = 30_000;
const CLEANUP_EVERY_MS = 60 * 60_000;
const CLEANUP_BATCH = 500;

/**
 * Release handling for one worker. `begin()` once at start-up; `tick()` whenever the queue is idle.
 * Without the release functions in the database (migration not applied yet) it carries on as before: leasing
 * the live version only.
 */
export function createRelease(sb, fingerprint, log) {
  const state = { fingerprint, enabled: false, action: null, version: null, staging: null, lastAdvance: 0, lastCleanup: 0 };

  async function begin() {
    try {
      const r = await sb.rpc('begin_legend_map_release', { p_fingerprint: fingerprint });
      Object.assign(state, { enabled: true, action: r.action, version: r.version });
      const extra = [r.queued != null && `${r.queued} tiles queued`, r.from != null && `from version ${r.from}`, r.abandoned && `abandoned version ${r.abandoned}`]
        .filter(Boolean).join(', ');
      log(`painter ${fingerprint}: ${r.action} version ${r.version}${extra ? ` (${extra})` : ''}`);
      if (r.action === 'staging') state.staging = { version: r.version };
    } catch (e) {
      if (!/PGRST202|Could not find the function/.test(e.message)) throw e;
      log(`painter ${fingerprint}: the database has no releases yet; painting the live version only`);
    }
  }

  /** The lease arguments for this painter. */
  const leaseArgs = (limit) => (state.enabled ? { p_limit: limit, p_fingerprint: fingerprint } : { p_limit: limit });

  async function tick(now = Date.now()) {
    if (!state.enabled) return;
    if (now - state.lastAdvance >= ADVANCE_EVERY_MS) {
      state.lastAdvance = now;
      const r = await sb.rpc('advance_legend_map_release', {});
      if (r.switched) {
        log(`release: phones switched from version ${r.from} to version ${r.to}`);
        state.staging = null;
        state.version = r.to;
        state.lastCleanup = 0;
      } else {
        if (r.blocked && !state.staging?.blocked) log(`release: version ${r.version} held, phones stay on version ${state.version ?? '?'}: ${r.reason}`);
        state.staging = r.staging ? { version: r.version, remaining: r.remaining, blocked: !!r.blocked, reason: r.reason ?? null } : null;
      }
    }
    if (now - state.lastCleanup >= CLEANUP_EVERY_MS) {
      state.lastCleanup = now;
      await cleanup();
    }
  }

  /** Deletes the files of replaced versions past their grace period, then forgets those versions. */
  async function cleanup() {
    let removed = 0;
    let previous = '';
    for (;;) {
      const names = await sb.rpc('legend_map_cleanup_candidates', { p_limit: CLEANUP_BATCH });
      if (!names?.length) break;
      // the same batch again: the last delete removed nothing (Storage refused it); try again in an hour
      const key = names.join('\n');
      if (key === previous) {
        log(`cleanup: Storage deleted none of ${names.length} files; stopping until the next round`);
        break;
      }
      previous = key;
      await sb.remove(names);
      removed += names.length;
      if (names.length < CLEANUP_BATCH) break;
    }
    const forgotten = await sb.rpc('legend_map_forget_versions', {});
    if (removed || forgotten?.length) log(`cleanup: ${removed} old files deleted${forgotten?.length ? `, versions ${forgotten.join(', ')} forgotten` : ''}`);
  }

  return { begin, tick, leaseArgs, state };
}
