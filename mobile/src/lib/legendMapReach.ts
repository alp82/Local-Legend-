// How far the camera may pan while the Legend map shows. The server paints only tiles within
// near_player_m of the player's own ground (claimed land and positions walked in the last 7
// days; supabase/migrations/*_legend_map_rename.sql, request_legend_map_tiles), so past that
// there would only be parchment. The camera's centre is kept close enough to the player that
// the whole screen stays inside that reach. Pure functions; hooks/use-legend-map-reach.ts
// applies them.
import type { BBox } from './sitesApi';

/** legend_map_config.near_player_m on the server. */
export const LEGEND_MAP_REACH_M = 2000;
/** Kept off the reach's edge: the quantizing below moves the bounds by up to about 70 m. */
const EDGE_MARGIN_M = 150;
/** The least the centre may move from the player, so the map never locks in place. */
const MIN_PAN_M = 200;
/** Bounds are rounded to this, so GPS jitter and small zooms don't reset them. */
const STEP_M = 100;
const CENTRE_STEP_DEG = 0.001;
const M_PER_DEG = 111_320;

/**
 * Where the camera's centre may go: [west, south, east, north] around the player `me`
 * ([lng, lat]) for a screen showing `view`. Zoomed out, the screen is bigger, so the centre may
 * move less.
 */
export function panBounds(me: [number, number], view: BBox | null): BBox {
  const round = (v: number) => Math.round(v / CENTRE_STEP_DEG) * CENTRE_STEP_DEG;
  const [lng, lat] = [round(me[0]), round(me[1])];
  const mLng = M_PER_DEG * Math.cos((lat * Math.PI) / 180);
  const halfW = view ? ((view[2] - view[0]) / 2) * mLng : 0;
  const halfH = view ? ((view[3] - view[1]) / 2) * M_PER_DEG : 0;
  const room = (half: number) => {
    const ceiledHalf = Math.ceil(half / STEP_M) * STEP_M;
    return Math.max(MIN_PAN_M, LEGEND_MAP_REACH_M - EDGE_MARGIN_M - ceiledHalf);
  };
  const rx = room(halfW) / mLng;
  const ry = room(halfH) / M_PER_DEG;
  return [lng - rx, lat - ry, lng + rx, lat + ry];
}
