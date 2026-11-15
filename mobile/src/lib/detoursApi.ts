// Contract between the app and the detour backend. The server makes the
// offers and decides every collection: walking within 30 m of an offer
// collects it, in the same upload that claims the land (see `detours` in
// BatchResult and CloseResult).
// Server side: supabase/functions/detours and get_detour_offers in
// supabase/migrations/*_detours.sql. docs/detours.md has the rules.

import { deviceTimeZone } from './economyApi';
import { ensureSession } from './playerState';
import type { Resources } from './rules.generated';
import { supabase, supabaseConfigError } from './supabase';

/** common: 600 gold, 8 wood, 8 stone. crystal: 3 crystal. gem: 1 gem (from the sheet). */
export type RewardKind = 'common' | 'crystal' | 'gem';

/** short: 3 to 5 minutes. long: 10 to 15. expedition: 30 to 40, the last offer of a weekend day. */
export type DetourBand = 'short' | 'long' | 'expedition';

export type DetourOffer = {
  id: number;
  slot: number;
  lat: number;
  lng: number;
  /** The point of the usual route the added time is measured from. */
  anchor: { lat: number; lng: number };
  /** The landmark's or park's name, or null for a footway, street, or square. */
  name: string | null;
  spotKind: 'place' | 'park' | 'square' | 'path' | 'street';
  spotSubtype: string | null;
  band: DetourBand;
  /** Straight-line distance from the route, in meters. */
  offRouteM: number;
  /** Walking there and back, in meters: 2.0 times the straight line below 200 m, 1.3 times from 200 m up. */
  addedM: number;
  /** The time the detour adds, in whole minutes. */
  addedMin: number;
  rewardKind: RewardKind;
  reward: Partial<Resources>;
  xp: number;
  /** The offer can be collected from validFrom (4 a.m. local) until validUntil (4 a.m. the next day). */
  validFrom: string;
  validUntil: string;
  /** When a walk collected it, or null while it's open. */
  collectedAt: string | null;
};

export type Detours = {
  /** The game day the offers are for (YYYY-MM-DD). */
  gameDay: string;
  /**
   * What the offers are placed around: routes (walked on at least 2 days in
   * the last 4 weeks), recent (any walk), land, position (where the phone
   * is), or null when nothing is known yet.
   */
  source: 'routes' | 'recent' | 'land' | 'position' | null;
  offers: DetourOffer[];
  offersPerDay: number;
  /** Spot areas within reach the server hasn't loaded yet; empty slots fill once they load. */
  missingAreas: number;
  validFrom: string;
  validUntil: string;
  /** Areas still loading. When it's above 0, call again later (about 20 s). */
  pending: number;
};

/** One offer a walk collected, as submit_location_batch and close_walk_session report it. */
export type CollectedDetour = {
  id: number;
  gameDay: string;
  name: string | null;
  rewardKind: RewardKind;
  reward: Partial<Resources>;
  xp: number;
  collectedAt: string;
};

/**
 * Loads today's offers. The server fills the day's empty slots first, so the
 * first call of a game day makes them. `position` is where the phone is; the
 * server only uses it for a player with no walks and no land. Throws on error.
 */
export async function fetchDetours(position?: { lat: number; lng: number } | null): Promise<Detours> {
  await ensureSession();
  const { data, error } = await client().functions.invoke<Detours>('detours', {
    body: { lat: position?.lat, lng: position?.lng, timeZone: deviceTimeZone() ?? undefined },
  });
  if (error) {
    const body = await error.context?.json?.().catch(() => null);
    throw new Error(body?.message ?? error.message);
  }
  if (!data) throw new Error('The detours function returned nothing.');
  return data;
}

function client() {
  if (!supabase) throw new Error(supabaseConfigError ?? 'Supabase is not configured.');
  return supabase;
}
