import { describe, expect, it } from '@jest/globals';

import { rulerProgress } from '../rulerLevel';
import { rules } from '../rules.generated';

describe('rulerProgress', () => {
  // The same table points the database test checks for private.ruler_level.
  it('matches the XP table at its edges', () => {
    const levels = [0, 99, 100, 349, 350, 48849, 48850, 1e9].map((xp) => rulerProgress(xp).level);
    expect(levels).toEqual([1, 1, 2, 2, 3, 29, 30, 30]);
  });

  it('measures progress toward the next level', () => {
    expect(rulerProgress(175)).toEqual({ level: 2, intoLevel: 75, levelSpan: 250, fraction: 0.3 });
  });

  it('stops at the top level', () => {
    const top = rules.xp.rulerLevels.at(-1)!;
    expect(rulerProgress(top.totalXp + 10)).toEqual({ level: top.level, intoLevel: 10, levelSpan: null, fraction: 1 });
  });

  it('starts at level 1 with no XP', () => {
    expect(rulerProgress(0)).toEqual({ level: 1, intoLevel: 0, levelSpan: 100, fraction: 0 });
  });
});
