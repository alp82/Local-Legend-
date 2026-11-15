// Contract between the app and the kingdom backend: building levels, the daily
// construction, Treasury caps, the garrison, and recruits. The server decides
// every spend; the app previews costs from the rules and shows what the server
// returns.
// Server side: supabase/migrations/*_kingdom.sql (get_kingdom, build_building,
// recruit_units) and *_mist_surge.sql (the surge in get_kingdom, set_rest).
// docs/kingdom.md and docs/mist.md have the rules.

import { randomUUID } from 'expo-crypto';

import type { Economy } from './economyApi';
import { deviceTimeZone } from './economyApi';
import { ensureSession } from './playerState';
import type { Resources } from './rules.generated';
import type { Rest, Surge } from './surge';
import { supabase, supabaseConfigError } from './supabase';

/** The buildings on the kingdom screen, in screen order. */
export const PLOTS = ['keep', 'treasury', 'walls', 'barracks'] as const;
export type PlotId = (typeof PLOTS)[number];

export type RecruitPool = {
  /** Recruits left from last week's growth; they expire next Monday. */
  lastWeek: number;
  /** Recruits left from this week's growth. */
  thisWeek: number;
  available: number;
};

export type Kingdom = {
  /** The game day the kingdom acts on (YYYY-MM-DD). */
  gameDay: string;
  /** Building levels; 0 is an empty plot. */
  buildings: Record<PlotId, number>;
  buildsToday: number;
  buildsPerDay: number;
  /** When the next construction opens (ISO time), or null while one is open today. */
  nextBuildAt: string | null;
  /** Treasury storage caps, or null without a Treasury. */
  caps: { goldCap: number; woodCap: number; stoneCap: number } | null;
  garrison: Partial<Record<'pikeman', number>>;
  recruits: { pikeman: RecruitPool };
  /** When the next week's recruits appear (ISO time): Monday at 4 a.m. local. */
  nextRecruitsAt: string;
};

export type KingdomState = Economy & { kingdom: Kingdom; surge: Surge };

export type BuildFailure =
  | { reason: 'already_built' | 'not_next_level' | 'max_level'; level: number }
  | { reason: 'ruler_level' | 'keep_level'; level: number; required: number; current: number }
  | { reason: 'daily_limit'; level: number; nextBuildAt: string }
  | { reason: 'not_enough'; level: number; missing: Partial<Resources> };

export type BuildResult = { building: PlotId; economy: Economy; kingdom: Kingdom } & (
  | { ok: true; duplicate: boolean; level: number; cost: Resources; xp: number; rulerLevel: number; levelUp: boolean }
  | ({ ok: false } & BuildFailure)
);

export type RecruitFailure =
  | { reason: 'needs_building'; building: string; required: number }
  | { reason: 'not_enough_recruits'; available: number }
  | { reason: 'not_enough'; count: number; missing: Partial<Resources> };

export type RecruitResult = { unit: 'pikeman'; economy: Economy; kingdom: Kingdom } & (
  | { ok: true; duplicate: boolean; count: number; cost: Resources; garrison: number }
  | ({ ok: false } & RecruitFailure)
);

/** Loads the economy and the kingdom, after sending the device's time zone and paying any Keep tax due. */
export async function fetchKingdom(): Promise<KingdomState> {
  await ensureSession();
  const { data, error } = await client().rpc('get_kingdom', { p_time_zone: deviceTimeZone() ?? undefined });
  if (error) throw error;
  return data as KingdomState;
}

/**
 * Builds `level` of `building`. Makes one request id and reuses it on every
 * retry, so a request that reached the server but whose answer was lost can't
 * build twice. Resolves with `ok: false` when a game rule refuses; throws
 * when the server can't be reached.
 */
export async function buildBuilding(building: PlotId, level: number): Promise<BuildResult> {
  const requestId = randomUUID();
  return withRetries(async () => {
    const { data, error } = await client().rpc('build_building', {
      p_building: building,
      p_level: level,
      p_request_id: requestId,
    });
    if (error) throw error;
    return data as BuildResult;
  });
}

/** Recruits `count` Pikemen, with one request id across retries like `buildBuilding`. */
export async function recruitPikemen(count: number): Promise<RecruitResult> {
  const requestId = randomUUID();
  return withRetries(async () => {
    const { data, error } = await client().rpc('recruit_units', {
      p_unit: 'pikeman',
      p_count: count,
      p_request_id: requestId,
    });
    if (error) throw error;
    return data as RecruitResult;
  });
}

export type SetRestResult = { ok: true; rest: Rest } | { ok: false; reason: 'no_rest_days'; rest: Rest };

/** Turns Rest on (from today) or off. Turning it on twice, or off twice, is harmless, so retries are safe. */
export async function setRest(on: boolean): Promise<SetRestResult> {
  return withRetries(async () => {
    const { data, error } = await client().rpc('set_rest', { p_on: on });
    if (error) throw error;
    return data as SetRestResult;
  });
}

const RETRY_DELAYS_MS = [500, 2000];

/** Runs `call`, retrying on network failures. Errors the server returned (with a Postgres code) aren't retried. */
async function withRetries<T>(call: () => Promise<T>): Promise<T> {
  await ensureSession();
  for (let attempt = 0; ; attempt++) {
    try {
      return await call();
    } catch (e) {
      const serverError = typeof e === 'object' && e !== null && typeof (e as { code?: unknown }).code === 'string'
        && (e as { code: string }).code !== '';
      if (serverError || attempt >= RETRY_DELAYS_MS.length) throw e;
      await new Promise((resolve) => setTimeout(resolve, RETRY_DELAYS_MS[attempt]));
    }
  }
}

function client() {
  if (!supabase) throw new Error(supabaseConfigError ?? 'Supabase is not configured.');
  return supabase;
}
