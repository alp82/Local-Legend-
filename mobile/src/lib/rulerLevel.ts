// Ruler level progress for display. The server computes the level the game
// uses (private.ruler_level); this reads the same XP table from the rules to
// draw progress toward the next level.

import { rules, type RulerLevel } from './rules.generated';

export type RulerProgress = {
  level: number;
  /** XP earned since reaching this level. */
  intoLevel: number;
  /** XP from this level to the next, or null at the top level. */
  levelSpan: number | null;
  /** 0 to 1; 1 at the top level. */
  fraction: number;
};

export function rulerProgress(xp: number, levels: RulerLevel[] = rules.xp.rulerLevels): RulerProgress {
  let current = levels[0];
  for (const l of levels) if (l.totalXp <= xp) current = l;
  const next = levels[current.level];
  const intoLevel = Math.max(0, Math.floor(xp - current.totalXp));
  if (!next) return { level: current.level, intoLevel, levelSpan: null, fraction: 1 };
  const levelSpan = next.totalXp - current.totalXp;
  return { level: current.level, intoLevel, levelSpan, fraction: Math.min(1, intoLevel / levelSpan) };
}
