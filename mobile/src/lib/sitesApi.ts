// Contract between the app and the sites backend (landmarks and building sites).
// Server side: supabase/functions/sites and get_sites in supabase/migrations/*_sites.sql.

import { ensureSession } from './playerState';
import { supabase, supabaseConfigError } from './supabase';

/**
 * place: a real place worth knowing (place card later): viewpoint, artwork/mural,
 *   historic building or monument, notable staircase, cafe, and similar.
 * mine: a building site derived from the terrain: park or forest -> sawmill,
 *   dense urban blocks -> quarry, old town or landmark district -> gold_mine.
 */
export type SiteKind = 'place' | 'mine';

export type Site = {
  /** Stable id, e.g. "osm:node/123" or "mine:<id>". */
  id: string;
  kind: SiteKind;
  /** Finer type for the icon and label, e.g. "viewpoint", "artwork", "sawmill". */
  subtype: string;
  name: string | null;
  lng: number;
  lat: number;
  /**
   * owned: on the player's claimed land, shown fully.
   * silhouette: under the Mist near the border, shown faintly without a name.
   * Sites deeper in the Mist are never returned.
   */
  visibility: 'owned' | 'silhouette';
};

export type SitesResult = {
  sites: Site[];
  /**
   * Areas in the box still loading from OpenStreetMap. When it's above 0, call
   * again later (about 20 s) to get their sites. Don't cache this answer.
   */
  pending: number;
};

/** [west, south, east, north] in WGS84 degrees. */
export type BBox = [number, number, number, number];

/**
 * Returns the sites in the box that the signed-in player may see. The server
 * fetches and caches map data for areas it hasn't seen yet, so the first call
 * for a new area takes longer, usually under a few seconds. If it's slower,
 * the answer has `pending` > 0. Throws on error.
 */
export async function fetchSites(bbox: BBox): Promise<SitesResult> {
  await ensureSession();
  const { data, error } = await client().functions.invoke<{ sites: Site[]; pending: number }>(
    'sites',
    { body: { bbox } },
  );
  if (error) {
    // FunctionsHttpError: the JSON body has a message, e.g. 400 for a box
    // over 0.25 degrees per side. Other errors are network failures.
    const body = await error.context?.json?.().catch(() => null);
    throw new Error(body?.message ?? error.message);
  }
  return { sites: data?.sites ?? [], pending: data?.pending ?? 0 };
}

function client() {
  if (!supabase) throw new Error(supabaseConfigError ?? 'Supabase is not configured.');
  return supabase;
}
