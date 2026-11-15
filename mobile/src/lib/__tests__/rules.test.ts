import { describe, expect, it } from '@jest/globals';

import { rules } from '../rules.generated';

describe('generated rules', () => {
  it('has one entry per level for every building and mine', () => {
    for (const b of [...Object.values(rules.buildings), ...Object.values(rules.mines.types)]) {
      expect(b.levels.map((l) => l.level)).toEqual(Array.from({ length: b.maxLevel }, (_, i) => i + 1));
    }
  });

  it('has the Ruler level table in increasing order', () => {
    const totals = rules.xp.rulerLevels.map((l) => l.totalXp);
    expect(totals[0]).toBe(0);
    expect([...totals].sort((a, b) => a - b)).toEqual(totals);
  });
});
