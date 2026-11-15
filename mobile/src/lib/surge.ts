// The weekly Mist surge as the app shows it: last week's result on Monday
// morning, the forecast for the week in progress, and Rest. The server
// resolves every surge (supabase/migrations/*_mist_surge.sql); the app only
// words what get_kingdom returns. docs/mist.md has the rules.

import type { Resources } from './rules.generated';

/** What a surge was computed from. A forecast has the same fields. */
export type SurgeNumbers = {
  /** Monday of the game week the surge closes (YYYY-MM-DD). */
  week: string;
  /** When the surge is due: the next Monday at 4 a.m. local (ISO time). */
  dueAt: string;
  season: number;
  seasonWeek: number;
  seasonPressure: number;
  /** The player's first surge, at half pressure. */
  gentle: boolean;
  /** Season pressure, halved for the first surge. */
  pressure: number;
  /** Before the player's first surge: nothing happens this week. */
  notYet: boolean;
  /** Sunday is a rest day, so the surge skips the player. */
  rested: boolean;
  keepLevel: number;
  keepDraw: number;
  frontierCells: number;
  homeCells: number;
  roadCells: number;
  frontierKm: number;
  fadedKm: number;
  effectiveKm: number;
  strength: number;
  wallsLevel: number;
  wallsDefense: number;
  garrisonPower: number;
  watchtowerBonus: number;
  defense: number;
  held: boolean;
  /** Broke through, but defense was at least half the strength. */
  partlyHeld: boolean;
  landLossShare: number;
  cellsLost: number;
  unitsLost: Record<string, number>;
};

export type SurgeOutcome = 'held' | 'broke_through' | 'rested' | 'not_yet';

export type SurgeResult = {
  week: string;
  outcome: SurgeOutcome;
  dueAt: string;
  resolvedAt: string;
  cellsLost: number;
  unitsLost: Record<string, number>;
  reward: (Pick<Resources, 'gold'> & { tickets: number; xp: number }) | null;
  numbers: SurgeNumbers;
};

export type Rest = {
  /** Rest is turned on (it stays on until turned off or the season's days run out). */
  on: boolean;
  /** Today is a rest day, turned on by the player or by itself. */
  today: boolean;
  used: number;
  left: number;
  perSeason: number;
  /** The last game day of the season (YYYY-MM-DD). */
  seasonEndsOn: string;
};

export type Surge = {
  /** The latest resolved surge, or null before the first week ends. */
  last: SurgeResult | null;
  /** The forecast for the week in progress, from the kingdom as it is now. */
  next: SurgeNumbers;
  rest: Rest;
};

const whole = (n: number) => new Intl.NumberFormat('en-US').format(Math.round(n));

function units(lost: Record<string, number>) {
  const n = Object.values(lost).reduce((a, b) => a + b, 0);
  return n === 1 ? '1 unit' : `${whole(n)} units`;
}

/** The headline and details of a resolved surge, for the Monday card. */
export function surgeSummary(r: SurgeResult): { title: string; lines: string[] } {
  const n = r.numbers;
  const versus = `Defense ${whole(n.defense)} against strength ${whole(n.strength)}${n.gentle ? ' (a gentle first surge)' : ''}.`;
  switch (r.outcome) {
    case 'held': {
      const lines = [versus];
      if (r.reward) lines.push(`+${whole(r.reward.gold)} gold, +${whole(r.reward.tickets)} trade ticket, +${whole(r.reward.xp)} XP.`);
      lines.push(`The garrison lost ${units(r.unitsLost)}.`);
      return { title: 'Your walls held the Mist', lines };
    }
    case 'broke_through': {
      const lines = [versus];
      lines.push(
        r.cellsLost > 0
          ? `The Mist took ${whole(r.cellsLost)} cells of frontier (${Math.round(n.landLossShare * 1000) / 10}%). Home and roads are safe.`
          : 'The Mist found no frontier to take. Home and roads are safe.',
      );
      lines.push(`The garrison lost ${units(r.unitsLost)}.`);
      if (r.reward) lines.push(`You held half its strength: +${whole(r.reward.xp)} XP.`);
      return { title: 'The Mist broke through', lines };
    }
    case 'rested':
      return { title: 'You rested; the Mist passed you by', lines: ['Nothing was lost or won.'] };
    case 'not_yet':
      return { title: 'The Mist is gathering', lines: ['Your first surge comes next Sunday night, at half strength.'] };
  }
}

/** True when `r` closed the week before the one `gameDay` is in: the result to show this week. */
export function isThisWeeksResult(r: SurgeResult | null, gameDay: string): boolean {
  if (!r) return false;
  const day = new Date(`${gameDay}T00:00:00Z`);
  const monday = new Date(day);
  monday.setUTCDate(day.getUTCDate() - ((day.getUTCDay() + 6) % 7) - 7);
  return r.week === monday.toISOString().slice(0, 10);
}
