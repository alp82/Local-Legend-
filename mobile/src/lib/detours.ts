// What the map shows for detour offers: titles, labels, and map features. The
// server decides every offer and collection; this only formats them.

import type { DetourOffer, RewardKind } from './detoursApi';
import { formatResources } from './kingdom';

const TITLES: Record<RewardKind, string> = {
  common: 'Supply cache',
  crystal: 'Crystal vein',
  gem: 'Gem cache',
};

/** Pennant colors by reward kind, matching the resource bar. */
export const REWARD_COLORS: Record<RewardKind, string> = {
  common: '#E8B23A',
  crystal: '#8FD3F4',
  gem: '#E58FD8',
};

export function offerTitle(offer: Pick<DetourOffer, 'rewardKind'>): string {
  return TITLES[offer.rewardKind];
}

/** The pennant label: the time the detour adds, or a check mark once collected. */
export function offerLabel(offer: Pick<DetourOffer, 'addedMin' | 'collectedAt'>): string {
  return offer.collectedAt ? '✓' : `+${offer.addedMin} min`;
}

/** "600 gold, 8 wood, 8 stone · 75 XP". */
export function rewardText(offer: Pick<DetourOffer, 'reward' | 'xp'>): string {
  return `${formatResources(offer.reward)} · ${Math.round(offer.xp)} XP`;
}

const UNNAMED: Record<string, string> = {
  artwork: 'by an artwork',
  monument: 'by a monument',
  viewpoint: 'at a viewpoint',
  attraction: 'by a landmark',
  castle: 'by a castle',
  ruins: 'by ruins',
};

/** Where the offer is, for the card: "at Smok Wawelski", "by an artwork", "on a footway". */
export function offerPlace(offer: Pick<DetourOffer, 'name' | 'spotKind' | 'spotSubtype'>): string {
  if (offer.name) return `at ${offer.name}`;
  switch (offer.spotKind) {
    case 'place':
      return UNNAMED[offer.spotSubtype ?? ''] ?? 'by a landmark';
    case 'square':
      return 'on a pedestrian square';
    case 'path':
      return 'on a footway';
    case 'street':
      return 'on a side street';
    default:
      return 'nearby';
  }
}

/**
 * Offers as map features: a point per offer, and a line from the route to it
 * so the player sees which way to step off. Collected offers stay on the map,
 * faded, until the day ends.
 */
export function detoursJson(offers: DetourOffer[]): string {
  const features: GeoJSON.Feature[] = [];
  for (const o of offers) {
    const collected = o.collectedAt !== null;
    features.push({
      type: 'Feature',
      properties: { kind: 'route', collected },
      geometry: { type: 'LineString', coordinates: [[o.anchor.lng, o.anchor.lat], [o.lng, o.lat]] },
    });
    features.push({
      type: 'Feature',
      properties: {
        id: o.id,
        kind: 'offer',
        label: offerLabel(o),
        color: REWARD_COLORS[o.rewardKind],
        collected,
      },
      geometry: { type: 'Point', coordinates: [o.lng, o.lat] },
    });
  }
  return JSON.stringify({ type: 'FeatureCollection', features });
}
