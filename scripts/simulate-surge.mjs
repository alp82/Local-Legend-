// Simulates typical players over their first 6 weeks of Mist surges and
// compares strength with defense under several balance variants. It reads the
// generated rules, so walking pay, costs, Walls, and Pikemen match the server.
// The game has no Keep draw (private.surge_settings() in
// supabase/migrations/*_surge_keep_draw.sql sets it to 0, the sheet's own
// surge model). KEEP_DRAW is the design document's table, used only by the
// comparison variants. docs/mist.md explains the assumptions and the results.
//
// Usage, from the repository root: node scripts/simulate-surge.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const rulesPath = process.argv[2]
  ?? path.join(path.dirname(fileURLToPath(import.meta.url)), '../mobile/src/lib/rules.generated.ts');
const src = fs.readFileSync(rulesPath, 'utf8');
const R = JSON.parse(src.slice(src.indexOf('export const rules: Rules = ') + 28).replace(/;\s*$/, ''));

// Design document, section 7. Not used by the game; for the comparisons only.
const KEEP_DRAW = [800, 1200, 1800, 2700, 4050, 6080, 9110, 13670, 20500, 30750];
const TERRAIN = { builtUp: 0.5, park: 0.3, waterside: 0.2 }; // assumed share of km by terrain

// Player types from the sheet's Players tab (mid-game example), first weeks.
const TYPES = {
  routine: { usualWeekday: 2.5, usualWeekend: 3, detoursPerWeek: 0, kmPerDetour: 0.6, weekendNew: 0, incidental: 0.4 },
  detour: { usualWeekday: 2.5, usualWeekend: 3, detoursPerWeek: 3, kmPerDetour: 0.6, weekendNew: 1.5, incidental: 0.4 },
  explorer: { usualWeekday: 3, usualWeekend: 4, detoursPerWeek: 6, kmPerDetour: 0.7, weekendNew: 6, incidental: 0.4 },
};

const VARIANTS = {
  'as built: no Keep draw, 10/km (the sheet model)': { draw: () => 0, perKm: R.mist.strengthPerFrontierKm },
  'before the fix: design Keep draw 800+, 10/km': { draw: (k) => KEEP_DRAW[k - 1], perKm: R.mist.strengthPerFrontierKm },
  'design Keep draw x 0.1 (80+), 10/km': { draw: (k) => KEEP_DRAW[k - 1] * 0.1, perKm: R.mist.strengthPerFrontierKm },
  'design Keep draw 800+, 20/km (design doc per km)': { draw: (k) => KEEP_DRAW[k - 1], perKm: 20 },
};

function rulerLevel(xp) {
  let lvl = 1;
  for (const l of R.xp.rulerLevels) if (l.totalXp <= xp) lvl = l.level;
  return lvl;
}

function newGroundXp(kmBefore, km) {
  const f = (x) => {
    let total = 0, lo = 0;
    for (const b of R.xp.newGround.bands) {
      const hi = b.km === null ? Infinity : lo + b.km;
      total += b.xpPerKm * Math.max(0, Math.min(x, hi) - lo);
      lo = hi;
    }
    return total;
  };
  return f(kmBefore + km) - f(kmBefore);
}

function pressure(seasonWeek) {
  const { start, end } = R.mist.seasonPressure;
  return start + ((end - start) * (seasonWeek - 1)) / (R.seasons.weeks - 1);
}

// policy: 'balanced' upgrades the Keep whenever it can; 'defensive' keeps the Keep at level 1.
function simulate(typeName, policy, startSeasonWeek, variantName) {
  const T = TYPES[typeName];
  const V = VARIANTS[variantName];
  const s = { gold: R.startingResources.gold, wood: R.startingResources.wood, stone: R.startingResources.stone, xp: 0 };
  const b = { keep: 1, walls: 0, barracks: 0 };
  let pikemen = 0;
  let recruitsLeft = 0;
  const network = T.usualWeekday; // distinct km of usual routes, claimed in week 1
  const home = 0.3; // km of the network inside the 150 m home clearing
  const claims = []; // {day, km} frontier claims other than the network
  let surges = 0;
  const out = [];

  for (let day = 1; day <= 42; day++) {
    const dow = ((day - 1) % 7) + 1; // 1 = Monday
    const week = Math.ceil(day / 7);
    const weekend = dow >= 6;
    if (dow === 1) recruitsLeft += b.barracks > 0 ? Math.round(14 * (1 + 0.25 * (b.barracks - 1))) : 0;

    // Income.
    s.gold += R.buildings.keep.levels[b.keep - 1].effects.goldTaxPerDay;
    const usual = weekend ? T.usualWeekend : T.usualWeekday;
    let newKm = 0;
    let usualKm = usual;
    if (week === 1 && dow <= 2) { newKm += network / 2; usualKm = Math.max(0, usual - network / 2); }
    const detours = !weekend ? T.detoursPerWeek / 5 : 0;
    const extraNew = detours * T.kmPerDetour + (dow === 6 ? T.weekendNew : 0) + T.incidental / 7;
    newKm += extraNew;
    claims.push({ day, km: extraNew });
    const paidUsual = Math.min(usualKm, R.walking.usualRoutes.dailyCapKm);
    s.gold += 100 * paidUsual + 250 * newKm + 330 * detours;
    s.stone += paidUsual * 5 * TERRAIN.builtUp + newKm * 10 * TERRAIN.builtUp + 4.4 * detours;
    s.wood += paidUsual * 5 * TERRAIN.park + newKm * 12 * TERRAIN.park + 4.4 * detours;
    s.xp += Math.min(75, 15 * paidUsual) + newGroundXp(0, newKm) + 75 * detours;

    // One construction a day.
    const ruler = rulerLevel(s.xp);
    const can = (id) => {
      const lvl = R.buildings[id].levels[b[id]];
      if (!lvl) return null;
      if (ruler < Math.max(R.buildings[id].unlockRulerLevel, lvl.requiredRulerLevel)) return null;
      if (lvl.requiredKeepLevel !== null && b.keep < lvl.requiredKeepLevel) return null;
      if (s.gold < lvl.cost.gold || s.wood < lvl.cost.wood || s.stone < lvl.cost.stone) return null;
      return lvl;
    };
    const order = [];
    if (b.walls < b.keep) order.push('walls');
    if (b.barracks === 0) order.push('barracks');
    if (policy === 'balanced' && b.walls >= b.keep) order.push('keep');
    if (b.barracks < b.keep) order.push('barracks');
    for (const id of order) {
      const lvl = can(id);
      if (lvl) {
        s.gold -= lvl.cost.gold; s.wood -= lvl.cost.wood; s.stone -= lvl.cost.stone; s.xp += lvl.constructionXp;
        b[id]++;
        break;
      }
    }
    // Recruit what's left, keeping 1,000 gold for the next construction.
    const n = Math.max(0, Math.min(recruitsLeft, Math.floor((s.gold - 1000) / 60)));
    pikemen += n; recruitsLeft -= n; s.gold -= n * 60;

    if (dow === 7) {
      // Frontier at the surge: the network until it's a road (week 3), plus other claims; faded counts twice.
      const networkFrontier = week < 3 ? network - home : 0;
      let fresh = networkFrontier, faded = 0;
      for (const c of claims) (day - c.day >= R.mist.fadedLand.afterDays ? (faded += c.km) : (fresh += c.km));
      const frontier = fresh + faded;
      const effective = fresh + R.mist.fadedLand.multiplier * faded;
      const gentle = surges === 0 ? 0.5 : 1;
      const p = pressure(startSeasonWeek + week - 1) * gentle;
      const strength = p * (V.draw(b.keep) + V.perKm * effective);
      const walls = b.walls > 0 ? R.buildings.walls.levels[b.walls - 1].effects.defense : 0;
      const defense = walls + pikemen * R.units.pikeman.power;
      const held = defense >= strength;
      out.push({ week, keep: b.keep, walls: b.walls, pikemen, frontier: +frontier.toFixed(1), strength: Math.round(strength), defense: Math.round(defense), held });
      surges++;
      if (held) {
        s.gold += 500; s.xp += 150; pikemen -= Math.floor(pikemen * 0.05);
      } else {
        const share = Math.min(0.05, (0.1 * (strength - defense)) / strength);
        let lose = share * frontier;
        claims.sort((a, c) => a.day - c.day);
        for (const c of claims) { const t = Math.min(c.km, lose); c.km -= t; lose -= t; }
        if (defense >= strength / 2) s.xp += 75;
        pikemen -= Math.floor(pikemen * 0.1);
      }
    }
  }
  return out;
}

for (const variant of Object.keys(VARIANTS)) {
  console.log(`\n=== ${variant} ===`);
  for (const startSeasonWeek of [1, 4]) {
    for (const policy of ['balanced', 'defensive']) {
      for (const type of Object.keys(TYPES)) {
        const r = simulate(type, policy, startSeasonWeek, variant);
        const line = r.map((w) => `${w.held ? 'H' : 'B'} ${w.strength}/${w.defense} (K${w.keep} W${w.walls} P${w.pikemen} F${w.frontier})`).join(' | ');
        console.log(`join season wk ${startSeasonWeek}, ${policy.padEnd(9)}, ${type.padEnd(8)}: ${r.filter((w) => w.held).length}/6 held | ${line}`);
      }
    }
  }
}

// The design document's own model, for reference: Walls 600 x 1.5 per level,
// Pikemen Defense 6, 20 per frontier km, pressure 1.0 to 1.5.
console.log('\n=== design document model (Walls 600, Pikeman Defense 6, 20/km, pressure 1.0 to 1.5) ===');
for (const type of Object.keys(TYPES)) {
  const r = simulate(type, 'balanced', 1, 'design Keep draw 800+, 20/km (design doc per km)');
  const line = r.map((w) => {
    const walls = w.walls > 0 ? 600 * 1.5 ** (w.walls - 1) : 0;
    const def = walls + 6 * w.pikemen;
    const p = (1 + (0.5 * (w.week - 1)) / 8) * (w.week === 1 ? 0.5 : 1);
    const str = p * (KEEP_DRAW[w.keep - 1] + 20 * w.frontier);
    return `${def >= str ? 'H' : 'B'} ${Math.round(str)}/${Math.round(def)}`;
  });
  console.log(`${type.padEnd(8)}: ${line.join(' | ')}`);
}
