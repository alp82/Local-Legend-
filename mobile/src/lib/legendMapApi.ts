// Contract between the app and the Legend map backend. The tiles themselves come straight
// from the public Storage bucket; these calls only read the switches and queue tiles.
// Server side: supabase/migrations/*_fantasy_tiles.sql (get_legend_map_config,
// request_legend_map_tiles) and supabase/legend-map-renderer (painting).
import type { TileZXY } from './legendMapTiles';
import { ensureSession } from './playerState';
import { supabase, supabaseConfigError } from './supabase';

export type LegendMapConfig = { enabled: boolean; version: number; bucket: string };

export type LegendMapRequest = {
  enabled: boolean;
  version: number;
  /** Requested tiles still waiting to be painted. */
  pending: TileZXY[];
  /** Requested tiles painted (their label files exist). */
  ready: TileZXY[];
  /** Tiles this call queued. */
  queued: number;
  /** A limit kept some tiles from being queued; reason says which. */
  capped: boolean;
  reason: 'throttled' | 'player' | 'global' | 'queue' | null;
  /** Requested tiles refused for lying too far from the player's own ground. */
  far: number;
};

function client() {
  if (!supabase) throw new Error(supabaseConfigError ?? 'Supabase is not configured.');
  return supabase;
}

/** The server's switches. Signed-out callers are refused, so this waits for the (anonymous) sign-in on a fresh install. */
export async function fetchLegendMapConfig(): Promise<LegendMapConfig> {
  await ensureSession();
  const { data, error } = await client().rpc('get_legend_map_config');
  if (error) throw error;
  return data as LegendMapConfig;
}

/** Queues the tiles never painted (the first `visible` are on screen) and returns what is still pending. */
export async function requestLegendMapTiles(tiles: TileZXY[], visible: number): Promise<LegendMapRequest> {
  await ensureSession();
  const { data, error } = await client().rpc('request_legend_map_tiles', { p_tiles: tiles, p_visible: visible });
  if (error) throw error;
  return data as LegendMapRequest;
}
