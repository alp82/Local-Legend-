// Contract between the app and the economy backend: resources, Ruler XP, the
// Keep tax, and walking pay. The server decides every reward; the app only
// shows what get_economy returns.
// Server side: supabase/migrations/*_economy.sql (get_economy, pay for walks
// inside submit_location_batch and close_walk_session) and
// supabase/functions/terrain (terrain for walks that wait for it).

import type { Resources } from './rules.generated';
import { ensureSession } from './playerState';
import { supabase, supabaseConfigError } from './supabase';

/** What one batch or session close paid. Amounts can have fractions; the balances are whole. */
export type WalkReward = Resources & {
  xp: number;
  newGroundKm: number;
  /** Walked on land you already held, before the daily cap. */
  usualKm: number;
  /** The part of usualKm that paid. */
  usualPaidKm: number;
  /** Km whose terrain resources wait for the area's terrain. */
  pendingTerrainKm: number;
  rulerLevel: number;
  levelUp: boolean;
};

export type Economy = {
  /** Whole units. */
  resources: Resources;
  rulerXp: number;
  rulerLevel: number;
  /** The IANA time zone the server uses for the 4 a.m. reset. */
  timeZone: string;
  /** False when the server ignored the zone sent: unknown, or changed within 24 hours. */
  timeZoneAccepted: boolean;
  /** Today's date in the game: the local date, with days starting at 4 a.m. (YYYY-MM-DD). */
  gameDay: string;
  keepTaxPaidThrough: string | null;
  /** The Keep tax this call paid: one tax per game day since the last payment. */
  keepTaxPaid: { days: number; gold: number };
  today: {
    usualKm: number;
    usualPaidKm: number;
    usualCapKm: number;
    usualXp: number;
    newGroundKm: number;
    newGroundXp: number;
  };
  /** Km of walking whose terrain resources wait for the terrain function. */
  pendingTerrainKm: number;
};

/** The device's IANA time zone, such as "Europe/Warsaw", or null if the runtime doesn't say. */
export function deviceTimeZone(): string | null {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || null;
  } catch {
    return null;
  }
}

/**
 * Loads the signed-in player's economy. Sends the device's time zone, so the
 * daily reset happens at 4 a.m. local time, and lets the server pay any Keep
 * tax due. Throws on error.
 */
export async function fetchEconomy(): Promise<Economy> {
  await ensureSession();
  const { data, error } = await client().rpc('get_economy', { p_time_zone: deviceTimeZone() ?? undefined });
  if (error) throw error;
  return data as Economy;
}

/**
 * Asks the server to classify the terrain of areas where this player's walks
 * wait for it, which pays the waiting wood, stone, crystal, and gems.
 * `pending` counts areas still loading; call again later (about 20 s) for them.
 */
export async function classifyTerrain(): Promise<{ classified: number; pending: number }> {
  await ensureSession();
  const { data, error } = await client().functions.invoke<{ classified: number; pending: number }>('terrain', {
    body: {},
  });
  if (error) {
    const body = await error.context?.json?.().catch(() => null);
    throw new Error(body?.message ?? error.message);
  }
  return { classified: data?.classified ?? 0, pending: data?.pending ?? 0 };
}

function client() {
  if (!supabase) throw new Error(supabaseConfigError ?? 'Supabase is not configured.');
  return supabase;
}
