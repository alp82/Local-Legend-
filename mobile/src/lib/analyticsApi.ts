// Contract between the app and analytics. The app reports only app opens; the
// server records walks, detours, builds, recruits, and surges itself, in the
// functions that do the work.
// Server side: supabase/migrations/*_analytics.sql (record_app_open).
// docs/analytics.md has the events and the beta metrics.

import { randomUUID } from 'expo-crypto';

import { type AppOpenResult, sendAppOpen } from './appOpen';
import { deviceTimeZone } from './economyApi';
import { ensureSession } from './playerState';
import { supabase, supabaseConfigError } from './supabase';

/**
 * Records that the player opened the app (a launch or a return to the
 * foreground). Call once per open. Retries keep the same open id, so the
 * server counts the open once. Throws when the server can't be reached.
 */
export async function recordAppOpen(): Promise<AppOpenResult> {
  await ensureSession();
  return sendAppOpen(async (openId) => {
    const { data, error } = await client().rpc('record_app_open', {
      p_open_id: openId,
      p_time_zone: deviceTimeZone() ?? undefined,
    });
    if (error) throw error;
    return data as AppOpenResult;
  }, randomUUID);
}

function client() {
  if (!supabase) throw new Error(supabaseConfigError ?? 'Supabase is not configured.');
  return supabase;
}
