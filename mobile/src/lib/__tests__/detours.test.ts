import { describe, expect, it } from '@jest/globals';

import { detoursJson, offerLabel, offerPlace, offerTitle, REWARD_COLORS, rewardText } from '../detours';
import type { DetourOffer } from '../detoursApi';
import { rules } from '../rules.generated';

function offer(overrides: Partial<DetourOffer> = {}): DetourOffer {
  return {
    id: 7,
    slot: 1,
    lat: 50.0531,
    lng: 19.933,
    anchor: { lat: 50.054, lng: 19.932 },
    name: 'Smok Wawelski',
    spotKind: 'place',
    spotSubtype: 'artwork',
    band: 'short',
    offRouteM: 120,
    addedM: 312,
    addedMin: 4,
    rewardKind: 'common',
    reward: rules.detours.rewards.common,
    xp: rules.xp.detour,
    validFrom: '2026-11-15T03:00:00Z',
    validUntil: '2026-11-16T03:00:00Z',
    collectedAt: null,
    ...overrides,
  };
}

describe('offer text', () => {
  it('names the offer by its reward kind', () => {
    expect(offerTitle(offer())).toBe('Supply cache');
    expect(offerTitle(offer({ rewardKind: 'crystal' }))).toBe('Crystal vein');
    expect(offerTitle(offer({ rewardKind: 'gem' }))).toBe('Gem cache');
  });

  it('labels open offers with the added time and collected ones with a check', () => {
    expect(offerLabel(offer())).toBe('+4 min');
    expect(offerLabel(offer({ collectedAt: '2026-11-15T08:00:00Z' }))).toBe('✓');
  });

  it('shows the reward from the sheet and the XP', () => {
    expect(rewardText(offer())).toBe('600 gold, 8 wood, 8 stone · 75 XP');
    expect(rewardText(offer({ rewardKind: 'crystal', reward: rules.detours.rewards.crystal }))).toBe('3 crystal · 75 XP');
  });

  it('says where the offer is', () => {
    expect(offerPlace(offer())).toBe('at Smok Wawelski');
    expect(offerPlace(offer({ name: null, spotKind: 'path' }))).toBe('on a footway');
    expect(offerPlace(offer({ name: null, spotKind: 'street' }))).toBe('on a side street');
    expect(offerPlace(offer({ name: null, spotKind: 'square' }))).toBe('on a pedestrian square');
    expect(offerPlace(offer({ name: null }))).toBe('by an artwork');
    expect(offerPlace(offer({ name: null, spotSubtype: null }))).toBe('by a landmark');
  });
});

describe('detoursJson', () => {
  it('draws a pennant per offer and a line from the route to it', () => {
    const fc = JSON.parse(detoursJson([offer(), offer({ id: 8, rewardKind: 'gem', collectedAt: '2026-11-15T08:00:00Z' })]));
    expect(fc.features).toHaveLength(4);
    const [line, point] = fc.features;
    expect(line.geometry).toEqual({ type: 'LineString', coordinates: [[19.932, 50.054], [19.933, 50.0531]] });
    expect(point.geometry).toEqual({ type: 'Point', coordinates: [19.933, 50.0531] });
    expect(point.properties).toEqual({ id: 7, kind: 'offer', label: '+4 min', color: REWARD_COLORS.common, collected: false });
    expect(fc.features[3].properties).toMatchObject({ id: 8, label: '✓', color: REWARD_COLORS.gem, collected: true });
  });

  it('is an empty collection without offers', () => {
    expect(JSON.parse(detoursJson([]))).toEqual({ type: 'FeatureCollection', features: [] });
  });
});
