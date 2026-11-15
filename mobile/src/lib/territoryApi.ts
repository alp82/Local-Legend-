// Contract between the app and the territory backend.
// The backend implementation replaces the bodies; the signatures are fixed.
// Server side: supabase/migrations/*_territory.sql (submit_location_batch, get_territory) and
// *_vehicle_buffer.sql (the claiming rule, close_walk_session).

import type { WalkReward } from './economyApi';
import { ensureSession } from './playerState';
import { supabase, supabaseConfigError } from './supabase';

/** One GPS fix as recorded on the phone. */
export type LocationPoint = {
  /** Fix time, epoch milliseconds. */
  t: number;
  lat: number;
  lng: number;
  /** Horizontal accuracy in meters, if known. */
  acc: number | null;
  /** Speed in meters per second, if known. */
  spd: number | null;
};

export type BatchResult = {
  acceptedPoints: number;
  rejectedPoints: number;
  newCells: number;
  totalCells: number;
  /** True when this batchId was already processed; nothing changed. */
  duplicate: boolean;
  /** What the walking this batch settled paid, or null when nothing paid (always null for a duplicate). */
  reward: WalkReward | null;
};

export type CloseResult = {
  newCells: number;
  totalCells: number;
  /** False when the server has no such session (no batch of it was ever processed). */
  closed: boolean;
  /** What the walking the close settled paid, or null when nothing paid. */
  reward: WalkReward | null;
};

export type TerritoryGeoJSON = {
  type: 'FeatureCollection';
  features: {
    type: 'Feature';
    properties: Record<string, unknown> | null;
    geometry: { type: 'Polygon' | 'MultiPolygon'; coordinates: unknown };
  }[];
};

export type Territory = {
  /** Claimed land, as polygons in WGS84 [lng, lat]. */
  claimed: TerritoryGeoJSON;
  totalCells: number;
  areaM2: number;
};

/**
 * Uploads one batch of points from a tracking session. Idempotent per
 * batchId: retrying a batch never claims twice. Points within a session are
 * connected across batches in time order. The server claims a walking stretch
 * only once the next 2 minutes of the session are known (or the session is closed)
 * and no fast, vehicle-like movement lies within 2 minutes of it, so the end of the
 * latest batch is claimed later. Throws on network or server error.
 */
export async function submitLocationBatch(
  batchId: string,
  sessionId: string,
  points: LocationPoint[],
): Promise<BatchResult> {
  await ensureSession();
  const { data, error } = await client().rpc('submit_location_batch', {
    p_batch_id: batchId,
    p_session_id: sessionId,
    p_points: points,
  });
  // PostgrestError. code '22023' means the batch itself is invalid (bad id,
  // more than 500 points): retrying won't help. Other errors are transient.
  if (error) throw error;
  return data as BatchResult;
}

/**
 * Tells the server a stopped session is finished, so it claims the session's
 * last 2 minutes. Call it after every point of the session is uploaded.
 * Idempotent. Throws on network or server error.
 */
export async function closeWalkSession(sessionId: string): Promise<CloseResult> {
  await ensureSession();
  const { data, error } = await client().rpc('close_walk_session', { p_session_id: sessionId });
  if (error) throw error;
  return data as CloseResult;
}

/** Loads the signed-in player's claimed territory. Throws on error. */
export async function fetchTerritory(): Promise<Territory> {
  await ensureSession();
  const { data, error } = await client().rpc('get_territory');
  if (error) throw error;
  return data as Territory;
}

function client() {
  if (!supabase) throw new Error(supabaseConfigError ?? 'Supabase is not configured.');
  return supabase;
}
