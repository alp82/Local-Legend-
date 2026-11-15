import type { User } from '@supabase/supabase-js';

import type { Json, Tables } from './database.types';
import { supabase, supabaseConfigError } from './supabase';

export type PlayerState = Tables<'player_state'>;

function client() {
  if (!supabase) throw new Error(supabaseConfigError ?? 'Supabase is not configured.');
  return supabase;
}

let pendingSignIn: Promise<User> | null = null;

/**
 * Returns the signed-in user, signing in anonymously on first launch. The
 * session persists across restarts. Callers that arrive while a sign-in is in
 * flight share it, so parallel API calls on a fresh install create one user,
 * not one each.
 */
export function ensureSession(): Promise<User> {
  pendingSignIn ??= signIn().finally(() => {
    pendingSignIn = null;
  });
  return pendingSignIn;
}

async function signIn(): Promise<User> {
  const db = client();
  const { data, error } = await db.auth.getSession();
  if (error) throw error;
  if (data.session) return data.session.user;

  const result = await db.auth.signInAnonymously();
  if (result.error) throw result.error;
  if (!result.data.user) throw new Error('Anonymous sign-in returned no user.');
  return result.data.user;
}

/** Loads the current player's row, or null if they have never saved. */
export async function loadPlayerState(): Promise<PlayerState | null> {
  const user = await ensureSession();
  const { data, error } = await client()
    .from('player_state')
    .select()
    .eq('user_id', user.id)
    .maybeSingle();
  if (error) throw error;
  return data;
}

/** Creates or replaces the current player's row and returns it as stored. */
export async function savePlayerState({
  displayName,
  state,
}: {
  displayName: string | null;
  state: { [key: string]: Json | undefined };
}): Promise<PlayerState> {
  const user = await ensureSession();
  const trimmed = displayName?.trim() || null;
  const { data, error } = await client()
    .from('player_state')
    .upsert({ user_id: user.id, display_name: trimmed, state }, { onConflict: 'user_id' })
    .select()
    .single();
  if (error) throw error;
  return data;
}
