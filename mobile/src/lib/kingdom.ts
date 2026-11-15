// Previews for the kingdom screen: the next level of a building, what blocks
// it, and what recruiting costs. The server applies the same rules
// (private.build and private.recruit in supabase/migrations/*_kingdom.sql) and
// has the last word; these only decide what the buttons say.

import type { Kingdom, PlotId } from './kingdomApi';
import { rules, type Level, type ResourceId, type Resources } from './rules.generated';

const RESOURCE_IDS: ResourceId[] = ['gold', 'wood', 'stone', 'crystal', 'gems'];

/** The next level of a building and why it can't be built now, if it can't. */
export type NextLevel = {
  level: number;
  cost: Resources;
  constructionXp: number;
  /** null when the server should accept it. */
  blocker: Blocker | null;
};

export type Blocker =
  | { reason: 'ruler_level'; required: number }
  | { reason: 'keep_level'; required: number }
  | { reason: 'daily_limit'; nextBuildAt: string | null }
  | { reason: 'not_enough'; missing: Partial<Resources> };

/** The next level of `building`, or null at its top level. */
export function nextLevel(
  building: PlotId,
  kingdom: Kingdom,
  balances: Resources,
  rulerLevel: number,
): NextLevel | null {
  const def = rules.buildings[building];
  const current = kingdom.buildings[building];
  const lvl: Level | undefined = def.levels[current];
  if (current >= def.maxLevel || !lvl) return null;
  return {
    level: lvl.level,
    cost: lvl.cost,
    constructionXp: lvl.constructionXp,
    blocker: blocker(def.unlockRulerLevel, lvl, kingdom, balances, rulerLevel),
  };
}

function blocker(unlockRulerLevel: number, lvl: Level, kingdom: Kingdom, balances: Resources, rulerLevel: number): Blocker | null {
  const ruler = Math.max(unlockRulerLevel, lvl.requiredRulerLevel);
  if (rulerLevel < ruler) return { reason: 'ruler_level', required: ruler };
  if (lvl.requiredKeepLevel !== null && kingdom.buildings.keep < lvl.requiredKeepLevel) {
    return { reason: 'keep_level', required: lvl.requiredKeepLevel };
  }
  if (kingdom.buildsToday >= kingdom.buildsPerDay) return { reason: 'daily_limit', nextBuildAt: kingdom.nextBuildAt };
  const missing = shortfall(balances, lvl.cost);
  return missing ? { reason: 'not_enough', missing } : null;
}

/** What's missing to pay `cost`, or null when the balances cover it. */
export function shortfall(balances: Resources, cost: Resources): Partial<Resources> | null {
  const missing: Partial<Resources> = {};
  for (const id of RESOURCE_IDS) if (balances[id] < cost[id]) missing[id] = Math.ceil(cost[id] - balances[id]);
  return Object.keys(missing).length > 0 ? missing : null;
}

/** The cost of `count` Pikemen. */
export function pikemenCost(count: number): Resources {
  const unit = rules.units.pikeman.cost;
  return Object.fromEntries(RESOURCE_IDS.map((id) => [id, unit[id] * count])) as Resources;
}

/** How many Pikemen the player can recruit now: the recruits available, limited by gold and other costs. */
export function affordablePikemen(kingdom: Kingdom, balances: Resources): number {
  if (kingdom.buildings.barracks < rules.units.pikeman.buildingLevel) return 0;
  let n = kingdom.recruits.pikeman.available;
  for (const id of RESOURCE_IDS) {
    const each = rules.units.pikeman.cost[id];
    if (each > 0) n = Math.min(n, Math.floor(balances[id] / each));
  }
  return Math.max(0, n);
}

/** Art tier 1 to 3 for a building level, spread evenly over its levels. */
export function artTier(level: number, maxLevel: number): 1 | 2 | 3 {
  if (level <= 1) return 1;
  return Math.min(3, 1 + Math.floor(((level - 1) * 3) / maxLevel)) as 1 | 2 | 3;
}

/** "120 gold, 5 wood" for the non-zero amounts. */
export function formatResources(amounts: Partial<Resources>): string {
  const parts = RESOURCE_IDS.filter((id) => (amounts[id] ?? 0) > 0).map(
    (id) => `${new Intl.NumberFormat('en-US').format(amounts[id]!)} ${id}`,
  );
  return parts.length > 0 ? parts.join(', ') : 'free';
}
