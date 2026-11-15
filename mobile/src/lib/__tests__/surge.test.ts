import { describe, expect, it } from '@jest/globals';

import { isThisWeeksResult, surgeSummary, type SurgeNumbers, type SurgeResult } from '../surge';

const numbers: SurgeNumbers = {
  week: '2026-11-23',
  dueAt: '2026-11-30T03:00:00Z',
  season: 1,
  seasonWeek: 2,
  seasonPressure: 1.125,
  gentle: false,
  pressure: 1.125,
  notYet: false,
  rested: false,
  keepLevel: 1,
  keepDraw: 800,
  frontierCells: 3090,
  homeCells: 142,
  roadCells: 768,
  frontierKm: 7.05,
  fadedKm: 3.54,
  effectiveKm: 10.59,
  strength: 1019.23,
  wallsLevel: 1,
  wallsDefense: 150,
  garrisonPower: 20,
  watchtowerBonus: 0,
  defense: 170,
  held: false,
  partlyHeld: false,
  landLossShare: 0.05,
  cellsLost: 154,
  unitsLost: { pikeman: 2 },
};

function result(overrides: Partial<SurgeResult> = {}): SurgeResult {
  return {
    week: '2026-11-23',
    outcome: 'broke_through',
    dueAt: '2026-11-30T03:00:00Z',
    resolvedAt: '2026-11-30T03:00:00Z',
    cellsLost: 154,
    unitsLost: { pikeman: 2 },
    reward: null,
    numbers,
    ...overrides,
  };
}

describe('surgeSummary', () => {
  it('words a breakthrough with the land and units lost', () => {
    expect(surgeSummary(result())).toEqual({
      title: 'The Mist broke through',
      lines: [
        'Defense 170 against strength 1,019.',
        'The Mist took 154 cells of frontier (5%). Home and roads are safe.',
        'The garrison lost 2 units.',
      ],
    });
  });

  it('words a hold with its reward', () => {
    const held = result({
      outcome: 'held',
      cellsLost: 0,
      unitsLost: { pikeman: 10 },
      reward: { gold: 500, tickets: 1, xp: 150 },
      numbers: { ...numbers, strength: 900, defense: 960, held: true, gentle: true },
    });
    expect(surgeSummary(held)).toEqual({
      title: 'Your walls held the Mist',
      lines: [
        'Defense 960 against strength 900 (a gentle first surge).',
        '+500 gold, +1 trade ticket, +150 XP.',
        'The garrison lost 10 units.',
      ],
    });
  });

  it('mentions the partly-held XP', () => {
    const partly = result({ reward: { gold: 0, tickets: 0, xp: 75 } });
    expect(surgeSummary(partly).lines.at(-1)).toBe('You held half its strength: +75 XP.');
  });

  it('words a rested week and a week before the first surge', () => {
    expect(surgeSummary(result({ outcome: 'rested' })).title).toBe('You rested; the Mist passed you by');
    expect(surgeSummary(result({ outcome: 'not_yet' })).title).toBe('The Mist is gathering');
  });
});

describe('isThisWeeksResult', () => {
  it('is true all week for the surge that closed last week', () => {
    expect(isThisWeeksResult(result(), '2026-11-30')).toBe(true); // Monday
    expect(isThisWeeksResult(result(), '2026-12-06')).toBe(true); // Sunday
  });

  it('is false for older results, the week before, and no result', () => {
    expect(isThisWeeksResult(result(), '2026-12-07')).toBe(false);
    expect(isThisWeeksResult(result(), '2026-11-29')).toBe(false);
    expect(isThisWeeksResult(null, '2026-11-30')).toBe(false);
  });
});
