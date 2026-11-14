// Contract between the app and the territory backend.
// The backend implementation replaces the bodies; the signatures are fixed.
// Server side: supabase/migrations/*_territory.sql (submit_location_batch, get_territory).

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
 * connected across batches in time order. Throws on network or server error.
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
