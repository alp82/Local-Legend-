// Contract between the app and the fantasy map backend. The tiles themselves come straight
// from the public Storage bucket; these calls only read the switches and queue tiles.
// Server side: supabase/migrations/*_fantasy_tiles.sql (get_fantasy_config,
// request_fantasy_tiles) and supabase/fantasy-renderer (painting).
import type { TileZXY } from './fantasyTiles';
import { ensureSession } from './playerState';
import { supabase, supabaseConfigError } from './supabase';

export type FantasyConfig = { enabled: boolean; version: number; bucket: string };

export type FantasyRequest = {
  enabled: boolean;
  version: number;
  /** Requested tiles still waiting to be painted. */
  pending: TileZXY[];
  /** Tiles this call queued. */
  queued: number;
  /** The player's daily cap kept some tiles from being queued. */
  capped: boolean;
};

function client() {
  if (!supabase) throw new Error(supabaseConfigError ?? 'Supabase is not configured.');
  return supabase;
}

export async function fetchFantasyConfig(): Promise<FantasyConfig> {
  const { data, error } = await client().rpc('get_fantasy_config');
  if (error) throw error;
  return data as FantasyConfig;
}

/** Queues the tiles never painted (the first `visible` are on screen) and returns what is still pending. */
export async function requestFantasyTiles(tiles: TileZXY[], visible: number): Promise<FantasyRequest> {
  await ensureSession();
  const { data, error } = await client().rpc('request_fantasy_tiles', { p_tiles: tiles, p_visible: visible });
  if (error) throw error;
  return data as FantasyRequest;
}
