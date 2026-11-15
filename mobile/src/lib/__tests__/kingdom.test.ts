import { describe, expect, it } from '@jest/globals';

import { affordablePikemen, artTier, formatResources, nextLevel, pikemenCost, shortfall } from '../kingdom';
import type { Kingdom } from '../kingdomApi';
import { rules, type Resources } from '../rules.generated';

function kingdom(overrides: Partial<Kingdom> = {}): Kingdom {
  return {
    gameDay: '2026-11-16',
    buildings: { keep: 1, treasury: 0, walls: 0, barracks: 0 },
    buildsToday: 0,
    buildsPerDay: 1,
    nextBuildAt: null,
    caps: null,
    garrison: {},
    recruits: { pikeman: { lastWeek: 0, thisWeek: 0, available: 0 } },
    nextRecruitsAt: '2026-11-23T03:00:00Z',
    ...overrides,
  };
}

const rich: Resources = { gold: 1e6, wood: 1e4, stone: 1e4, crystal: 1e3, gems: 1e3 };
const start: Resources = { ...rules.startingResources, gold: rules.startingResources.gold + 300 };

describe('nextLevel', () => {
  it('previews the next level from the rules', () => {
    const next = nextLevel('treasury', kingdom(), start, 1);
    expect(next).toEqual({
      level: 1,
      cost: rules.buildings.treasury.levels[0].cost,
      constructionXp: rules.buildings.treasury.levels[0].constructionXp,
      blocker: null,
    });
  });

  it('applies the Ruler level, then the Keep level, then the daily limit, then the cost', () => {
    const k = kingdom({ buildings: { keep: 1, treasury: 1, walls: 0, barracks: 0 } });
    expect(nextLevel('keep', k, rich, 1)?.blocker).toEqual({ reason: 'ruler_level', required: 4 });
    expect(nextLevel('treasury', k, rich, 4)?.blocker).toEqual({ reason: 'keep_level', required: 2 });
    const used = kingdom({ buildsToday: 1, nextBuildAt: '2026-11-17T03:00:00Z' });
    expect(nextLevel('walls', used, rich, 1)?.blocker).toEqual({ reason: 'daily_limit', nextBuildAt: '2026-11-17T03:00:00Z' });
    expect(nextLevel('walls', kingdom(), { ...start, stone: 10 }, 1)?.blocker).toEqual({
      reason: 'not_enough',
      missing: { stone: 6 },
    });
  });

  it('returns null at the top level', () => {
    const k = kingdom({ buildings: { keep: 10, treasury: 0, walls: 0, barracks: 7 } });
    expect(nextLevel('barracks', k, rich, 30)).toBeNull();
    expect(nextLevel('keep', k, rich, 30)).toBeNull();
  });
});

describe('Pikemen', () => {
  it('costs the unit cost from the rules per Pikeman', () => {
    expect(pikemenCost(10)).toEqual({ gold: 600, wood: 0, stone: 0, crystal: 0, gems: 0 });
  });

  it('limits recruiting by the recruits available and the gold', () => {
    const k = kingdom({
      buildings: { keep: 1, treasury: 0, walls: 0, barracks: 1 },
      recruits: { pikeman: { lastWeek: 4, thisWeek: 14, available: 18 } },
    });
    expect(affordablePikemen(k, rich)).toBe(18);
    expect(affordablePikemen(k, { ...rich, gold: 125 })).toBe(2);
    expect(affordablePikemen(kingdom(), rich)).toBe(0);
  });
});

describe('helpers', () => {
  it('reports what a cost is missing', () => {
    expect(shortfall(start, rules.buildings.treasury.levels[0].cost)).toBeNull();
    expect(shortfall({ ...start, gold: 99.5 }, { ...start, gold: 100 })).toEqual({ gold: 1 });
  });

  it('spreads three art tiers over the levels', () => {
    expect([1, 2, 3, 4, 5, 6, 7].map((l) => artTier(l, 7))).toEqual([1, 1, 1, 2, 2, 3, 3]);
    expect([0, 1, 4, 5, 7, 8, 10].map((l) => artTier(l, 10))).toEqual([1, 1, 1, 2, 2, 3, 3]);
  });

  it('formats non-zero amounts', () => {
    expect(formatResources({ gold: 2400, wood: 8, stone: 0 })).toBe('2,400 gold, 8 wood');
    expect(formatResources({ gold: 0 })).toBe('free');
  });
});
