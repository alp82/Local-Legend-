#!/usr/bin/env node
// Generates the game rules from `Local Legend_Economy.xlsx` into one TypeScript
// file, written to two places that must stay identical:
//
//   mobile/src/lib/rules.generated.ts            (the app, bundled by Metro)
//   supabase/functions/_shared/rules.generated.ts (Edge Functions, run by Deno)
//
// It also writes the same rules as JSON into a migration that defines
// private.economy_rules(), which Postgres reads when it pays rewards:
//
//   supabase/migrations/<timestamp>_economy_rules.sql
//
// Applied migrations never change, so when the rules change the script adds a
// new migration, unless the latest one isn't tracked by git yet (then it
// rewrites that one in place, so rebalancing locally doesn't pile them up).
//
// Usage, from the repository root:
//   node scripts/generate-rules.mjs                  write all outputs
//   node scripts/generate-rules.mjs --check          fail if any output is stale
//   node scripts/generate-rules.mjs --xlsx <path>    read another workbook
//
// The script reads the values the spreadsheet app last calculated (the cached
// cell values), not the formulas, so the rules always match what the sheet
// shows. Save the workbook in LibreOffice Calc or Excel after editing it.
// Built-in Node modules only; needs Node 22+.
import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { inflateRawSync } from 'node:zlib';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUTPUTS = [
  join(root, 'mobile', 'src', 'lib', 'rules.generated.ts'),
  join(root, 'supabase', 'functions', '_shared', 'rules.generated.ts'),
];
const MIGRATIONS = join(root, 'supabase', 'migrations');
const RULES_MIGRATION = /^(\d{14})_economy_rules\.sql$/;

// ---------------------------------------------------------------------------
// Reading the workbook: a minimal ZIP and SpreadsheetML reader.

function unzip(buf) {
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65_557); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error('Not a ZIP file (no end of central directory).');
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const files = new Map();
  for (let n = 0; n < count; n++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error('Corrupt ZIP central directory.');
    const method = buf.readUInt16LE(p + 10);
    const size = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const offset = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen);
    p += 46 + nameLen + extraLen + commentLen;
    const start = offset + 30 + buf.readUInt16LE(offset + 26) + buf.readUInt16LE(offset + 28);
    const data = buf.subarray(start, start + size);
    if (method === 0) files.set(name, data);
    else if (method === 8) files.set(name, inflateRawSync(data));
    else throw new Error(`Unsupported ZIP compression method ${method} for ${name}.`);
  }
  return files;
}

function decodeXml(s) {
  return s.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (_, e) => {
    if (e[0] === '#') return String.fromCodePoint(e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10));
    return { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" }[e.toLowerCase()];
  });
}

function attr(attrs, name) {
  const m = attrs.match(new RegExp(`(?:^|\\s)${name}="([^"]*)"`));
  return m ? decodeXml(m[1]) : undefined;
}

function readWorkbook(path) {
  const files = unzip(readFileSync(path));
  const text = (name) => {
    const f = files.get(name);
    if (!f) throw new Error(`The workbook has no ${name}.`);
    return f.toString('utf8');
  };

  const shared = [];
  if (files.has('xl/sharedStrings.xml')) {
    for (const [, si] of text('xl/sharedStrings.xml').matchAll(/<si>([\s\S]*?)<\/si>/g)) {
      shared.push([...si.matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g)].map((m) => decodeXml(m[1])).join(''));
    }
  }

  const rels = new Map();
  for (const [, a] of text('xl/_rels/workbook.xml.rels').matchAll(/<Relationship\b([^>]*)\/?>/g)) {
    rels.set(attr(a, 'Id'), attr(a, 'Target'));
  }

  const wb = text('xl/workbook.xml');
  const sheets = new Map();
  for (const [, a] of wb.matchAll(/<sheet\b([^>]*)\/>/g)) {
    const target = rels.get(attr(a, 'r:id')).replace(/^\/?(xl\/)?/, '');
    sheets.set(attr(a, 'name'), parseSheet(text(`xl/${target}`), shared));
  }

  const names = new Map();
  for (const [, a, ref] of wb.matchAll(/<definedName\b([^>]*)>([^<]*)<\/definedName>/g)) {
    const m = decodeXml(ref).match(/^'?(.+?)'?!\$?([A-Z]+)\$?(\d+)$/);
    if (m) names.set(attr(a, 'name'), { sheet: m[1], ref: `${m[2]}${m[3]}` });
  }
  return { sheets, names };
}

/** Returns a Map from cell reference ("C6") to its cached value: number, string, or boolean. */
function parseSheet(xml, shared) {
  const cells = new Map();
  for (const [, a, body = ''] of xml.matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
    const ref = attr(a, 'r');
    const t = attr(a, 't');
    const v = body.match(/<v>([\s\S]*?)<\/v>/)?.[1];
    let value;
    if (t === 'inlineStr') value = decodeXml(body.match(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/)?.[1] ?? '');
    else if (v === undefined) continue;
    else if (t === 's') value = shared[Number(v)];
    else if (t === 'str') value = decodeXml(v);
    else if (t === 'b') value = v === '1';
    else if (t === 'e') value = { error: decodeXml(v) };
    else value = Number(v);
    if (value === '') continue;
    cells.set(ref, value);
  }
  return cells;
}

// ---------------------------------------------------------------------------
// Turning sheets into typed values, with errors that name the cell.

const problems = [];
function fail(msg) {
  problems.push(msg);
}

function colName(n) {
  let s = '';
  for (n += 1; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s;
  return s;
}

function sheet(wb, name) {
  const s = wb.sheets.get(name);
  if (!s) throw new Error(`The workbook has no sheet named "${name}".`);
  return s;
}

/**
 * Reads the table whose header row has `firstHeader` in column A. Returns one
 * object per row below it, keyed by header text, until column A is empty.
 * With `gaps`, single empty rows between groups are skipped and two in a row
 * end the table. Every header in `required` must exist.
 */
function table(wb, sheetName, firstHeader, required, { gaps = false } = {}) {
  const s = sheet(wb, sheetName);
  let headerRow = 0;
  for (let r = 1; r < 500 && !headerRow; r++) if (s.get(`A${r}`) === firstHeader) headerRow = r;
  if (!headerRow) throw new Error(`${sheetName}: no table with "${firstHeader}" in column A.`);
  const cols = [];
  for (let c = 0; c < 60; c++) {
    const h = s.get(`${colName(c)}${headerRow}`);
    if (typeof h === 'string') cols.push({ col: colName(c), header: h.trim() });
  }
  for (const h of required) {
    if (!cols.some((c) => c.header === h)) throw new Error(`${sheetName}: the table at row ${headerRow} has no "${h}" column.`);
  }
  const rows = [];
  for (let r = headerRow + 1; s.has(`A${r}`) || (gaps && s.has(`A${r + 1}`)); r++) {
    if (!s.has(`A${r}`)) continue;
    const row = { _sheet: sheetName, _row: r, _cols: {} };
    for (const { col, header } of cols) {
      row[header] = s.get(`${col}${r}`);
      row._cols[header] = col;
    }
    rows.push(row);
  }
  return rows;
}

function where(row, header) {
  return `${row._sheet}!${row._cols[header] ?? '?'}${row._row}`;
}

function num(row, header, { int = false, min = 0 } = {}) {
  const v = row[header];
  if (typeof v !== 'number' || !Number.isFinite(v)) {
    fail(`${where(row, header)} ("${header}") should be a number but is ${JSON.stringify(v)}.`);
    return NaN;
  }
  if (int && !Number.isInteger(v)) fail(`${where(row, header)} ("${header}") should be a whole number but is ${v}.`);
  if (v < min) fail(`${where(row, header)} ("${header}") should be at least ${min} but is ${v}.`);
  return clean(v);
}

function str(row, header) {
  const v = row[header];
  if (typeof v !== 'string' || !v.trim()) {
    fail(`${where(row, header)} ("${header}") should be text but is ${JSON.stringify(v)}.`);
    return '';
  }
  return v.trim();
}

/** Drops float noise such as 0.30000000000000004 and 0.466666666666667. */
function clean(v) {
  return Number.isInteger(v) ? v : Number(v.toPrecision(15));
}

/** Reads a named input cell ("Walk_Gold_km") from the Inputs sheet. */
function makeInput(wb) {
  const used = new Set();
  const input = (name, { int = false, min = 0, max = Infinity } = {}) => {
    used.add(name);
    const n = wb.names.get(name);
    if (!n) {
      fail(`The workbook has no named cell "${name}".`);
      return NaN;
    }
    const v = sheet(wb, n.sheet).get(n.ref);
    const at = `${n.sheet}!${n.ref} (${name})`;
    if (typeof v !== 'number' || !Number.isFinite(v)) {
      fail(`${at} should be a number but is ${JSON.stringify(v)}.`);
      return NaN;
    }
    if (int && !Number.isInteger(v)) fail(`${at} should be a whole number but is ${v}.`);
    if (v < min || v > max) fail(`${at} should be between ${min} and ${max} but is ${v}.`);
    return clean(v);
  };
  /** The Notes column (F) next to a named input cell. */
  const note = (name) => {
    const n = wb.names.get(name);
    if (!n) return undefined;
    const v = sheet(wb, n.sheet).get(`F${n.ref.match(/\d+$/)[0]}`);
    return typeof v === 'string' ? { text: v, at: `${n.sheet}!F${n.ref.match(/\d+$/)[0]}` } : undefined;
  };
  return { input, used, note };
}

// Named inputs that are deliberately not copied as constants: they only feed
// formulas whose results the generated tables already carry, or they describe
// the modeled players rather than the rules. A named cell missing from both this
// list and the code below stops the generator, so new inputs are never dropped
// silently.
const INPUTS_IN_TABLES = [
  'Cost_Growth', 'Keep_Ruler_Mult', 'Keep_Ruler_Offset', 'Mine_Slot_Div',
  'Cap_Gold_Base', 'Cap_Mat_Base', 'Cap_Growth', 'Keep_Tax_Base', 'Keep_Tax_Step',
  'GoldMine_Base', 'GoldMine_Step', 'MatMine_Base', 'MatMine_Step',
  'GoldMine_Gold', 'GoldMine_Wood', 'GoldMine_Stone', 'MatMine_Gold', 'MatMine_Mat',
  'Mine_Crystal_From', 'Mine_Crystal', 'Mine_Gems_From', 'Mine_Gems',
  'Walls_Base', 'Walls_Growth', 'Watchtower_Def', 'WT_Offers_Base', 'WT_Sight_Base', 'WT_Sight_Step',
  'Tavern_Reroll1', 'Tavern_Reroll2', 'Detour_Gem_Odds_Tavern',
  'Stable_Strip_Step', 'Bike_Factor_Max', 'Carto_Strip_Step', 'Carto_Gold_Bonus',
  'Beacon_Radius_Base', 'Beacon_Radius_Step', 'TP_Tickets_Base',
  'Trade_Improve', 'Trade_Cap_Crystal', 'Trade_Cap_Gems', 'Rate_Buy3Crystal', 'Rate_BuyGem',
  'Rate_Swap_In', 'Rate_Swap_Out', 'Rate_SellMat', 'Rate_SellCrystal', 'Rate_SellGem',
  'XP_Build_Base', 'XP_Build_Per_Level', 'XP_L2', 'XP_L3', 'XP_L4', 'XP_L5', 'XP_Step',
];
const INPUTS_MODEL_ONLY = [
  'Share_Route_BuiltUp', 'Share_Route_Park', 'Share_Route_Water',
  'Share_New_BuiltUp', 'Share_New_Park', 'Share_New_Water', 'Share_New_Hills',
];

// ---------------------------------------------------------------------------
// Ids for the names the sheet uses. A name missing here stops the generator.

const BUILDING_IDS = {
  Keep: 'keep',
  Treasury: 'treasury',
  Walls: 'walls',
  Barracks: 'barracks',
  Watchtower: 'watchtower',
  Tavern: 'tavern',
  Stable: 'stable',
  'Mage Guild': 'mageGuild',
  'Trading Post': 'tradingPost',
  "Cartographers' Guild": 'cartographersGuild',
  'Order of the Dawn': 'orderOfTheDawn',
  'Dragon Roost': 'dragonRoost',
  'Grail Wonder': 'grailWonder',
};
const MINE_IDS = { 'Gold Mine': 'goldMine', Quarry: 'quarry', Sawmill: 'sawmill' };
const UNIT_IDS = { Pikeman: 'pikeman', Archer: 'archer', Knight: 'knight', Battlemage: 'battlemage', Dragon: 'dragon' };
const SPELL_IDS = { Lure: 'lure', Scry: 'scry', Ward: 'ward', Rally: 'rally', 'Far Sight': 'farSight' };
const RESOURCES = ['gold', 'wood', 'stone', 'crystal', 'gems'];

/** "Building Effects" column header -> [building id, effect key]. */
const EFFECT_COLUMNS = {
  'Keep: gold tax/day': ['keep', 'goldTaxPerDay'],
  'Keep: mine slots': ['keep', 'mineSlots'],
  'Treasury: gold cap': ['treasury', 'goldCap'],
  'Treasury: wood cap': ['treasury', 'woodCap'],
  'Treasury: stone cap': ['treasury', 'stoneCap'],
  'Walls: defense': ['walls', 'defense'],
  'Watchtower: offers/day': ['watchtower', 'offersPerDay'],
  'Watchtower: sight into Mist (m)': ['watchtower', 'mistSightM'],
  'Watchtower: defense bonus': ['watchtower', 'defenseBonus'],
  'Tavern: gem offer share': ['tavern', 'gemOfferShare'],
  'Tavern: free rerolls/day': ['tavern', 'freeRerollsPerDay'],
  'Stable: bike strip each side (m)': ['stable', 'bikeStripM'],
  'Stable: bike km counts as': ['stable', 'bikeKmFactor'],
  'Trading Post: rate improvement': ['tradingPost', 'rateImprovement'],
  'Trading Post: free tickets/week': ['tradingPost', 'freeTicketsPerWeek'],
  "Cartographers': walking strip (m)": ['cartographersGuild', 'walkingStripM'],
  "Cartographers': new-ground gold bonus": ['cartographersGuild', 'newGroundGoldBonus'],
  'Order: beacons': ['orderOfTheDawn', 'beacons'],
  'Order: beacon radius (m)': ['orderOfTheDawn', 'beaconRadiusM'],
  'Dragon Roost: dragons/week': ['dragonRoost', 'dragonsPerWeek'],
};
/** Checked against the Building Costs table instead of copied. */
const EFFECT_COLUMNS_CHECKED = { 'Keep: needs Ruler level': ['keep', 'requiredRulerLevel'] };

/** Trading sheet column header -> key. */
const TRADING_COLUMNS = {
  'Free tickets / week': 'freeTicketsPerWeek',
  'Buy 3 crystal (gold)': 'buy3CrystalGold',
  'Buy 1 gem (gold)': 'buy1GemGold',
  'Swap: give': 'swapGive',
  'Swap: get': 'swapGet',
  'Sell 20 wood or stone (gold)': 'sell20MaterialGold',
  'Sell 1 crystal (gold)': 'sell1CrystalGold',
  'Sell 1 gem (gold)': 'sell1GemGold',
  'Weekly limit: crystal from the game': 'weeklyCrystalLimit',
  'Weekly limit: gems from the game': 'weeklyGemLimit',
};

function idFor(map, name, what, row, header) {
  const id = map[name];
  if (!id) fail(`${where(row, header)}: unknown ${what} "${name}". Add it to the id table in scripts/generate-rules.mjs.`);
  return id;
}

function cost(row, headers) {
  const c = {};
  RESOURCES.forEach((r, i) => {
    c[r] = headers[i] ? num(row, headers[i], { int: true }) : 0;
  });
  return c;
}

// ---------------------------------------------------------------------------
// Building the rules.

function buildRules(wb, sourceName) {
  const { input, used, note } = makeInput(wb);

  // Buildings: what they are, plus every level from Building Costs.
  const buildingRows = table(wb, 'Buildings', 'Building', [
    'Building', 'Unlocks at Ruler level', 'Max level', 'Base gold', 'Base wood', 'Base stone', 'What it does',
  ]);
  const costRows = table(wb, 'Building Costs', 'Building', [
    'Building', 'Level', 'Gold', 'Wood', 'Stone', 'Crystal', 'Gems', 'Construction XP', 'Needs Keep level', 'Needs Ruler level',
  ]);
  const costHeaders = ['Gold', 'Wood', 'Stone', 'Crystal', 'Gems'];

  function levelsFor(name, maxLevel) {
    const rows = costRows.filter((r) => r.Building === name);
    const levels = [];
    for (const r of rows) {
      const level = num(r, 'Level', { int: true, min: 1 });
      if (level > maxLevel) {
        if (r.Gold !== undefined) fail(`${where(r, 'Gold')}: ${name} level ${level} has a cost above its max level ${maxLevel}.`);
        continue;
      }
      if (level !== levels.length + 1) fail(`${where(r, 'Level')}: expected ${name} level ${levels.length + 1}, found ${level}.`);
      const xp = r['Construction XP'];
      const starting = typeof xp === 'string' && /starting level/i.test(xp);
      const keepLevel = r['Needs Keep level'];
      levels.push({
        level,
        cost: cost(r, costHeaders),
        constructionXp: starting ? 0 : num(r, 'Construction XP', { int: true }),
        requiredKeepLevel: keepLevel === '-' ? null : num(r, 'Needs Keep level', { int: true, min: 1 }),
        requiredRulerLevel: num(r, 'Needs Ruler level', { int: true, min: 1 }),
        starting,
      });
    }
    if (levels.length !== maxLevel) fail(`Building Costs: ${name} has ${levels.length} levels, but its max level is ${maxLevel}.`);
    return levels;
  }

  const buildings = {};
  for (const b of buildingRows) {
    const id = idFor(BUILDING_IDS, b.Building, 'building', b, 'Building');
    if (!id) continue;
    const maxLevel = num(b, 'Max level', { int: true, min: 1 });
    const levels = levelsFor(b.Building, maxLevel);
    const startLevel = levels.filter((l) => l.starting).length;
    const first = levels[startLevel];
    // A blue base cost edited without recalculating leaves stale cached levels.
    if (startLevel === 0 && first) {
      for (const [res, header] of [['gold', 'Base gold'], ['wood', 'Base wood'], ['stone', 'Base stone']]) {
        if (first.cost[res] !== b[header]) {
          fail(`${b.Building}: level 1 ${res} on Building Costs is ${first.cost[res]}, but the base on Buildings is ${b[header]}. ` +
            'Recalculate the workbook in a spreadsheet app and save it.');
        }
      }
    }
    buildings[id] = {
      id,
      name: b.Building,
      description: str(b, 'What it does'),
      unlockRulerLevel: num(b, 'Unlocks at Ruler level', { int: true, min: 1 }),
      maxLevel,
      startLevel,
      levels: levels.map(({ starting, ...l }) => ({ ...l, effects: {} })),
    };
  }
  for (const [name, id] of Object.entries(BUILDING_IDS)) {
    if (!buildings[id]) fail(`Buildings: "${name}" is missing. Remove it from the id table in scripts/generate-rules.mjs if it was dropped on purpose.`);
  }
  for (const r of costRows) {
    if (!(r.Building in BUILDING_IDS) && !(r.Building in MINE_IDS)) idFor({}, r.Building, 'building or mine', r, 'Building');
  }

  // Building effects per level.
  const effectRows = table(wb, 'Building Effects', 'Level', ['Level']);
  const effectHeaders = Object.keys(effectRows[0] ?? {}).filter((h) => !h.startsWith('_') && h !== 'Level');
  for (const h of effectHeaders) {
    if (!EFFECT_COLUMNS[h] && !EFFECT_COLUMNS_CHECKED[h]) {
      fail(`Building Effects: unknown column "${h}". Add it to EFFECT_COLUMNS in scripts/generate-rules.mjs and to the BuildingEffects type.`);
    }
  }
  for (const h of [...Object.keys(EFFECT_COLUMNS), ...Object.keys(EFFECT_COLUMNS_CHECKED)]) {
    if (!effectHeaders.includes(h)) fail(`Building Effects: the column "${h}" is missing.`);
  }
  for (const r of effectRows) {
    const level = num(r, 'Level', { int: true, min: 1 });
    for (const [h, [id, key]] of Object.entries(EFFECT_COLUMNS)) {
      const b = buildings[id];
      if (!b) continue;
      if (level > b.maxLevel) {
        if (r[h] !== undefined) fail(`${where(r, h)}: ${b.name} has an effect above its max level ${b.maxLevel}.`);
        continue;
      }
      b.levels[level - 1].effects[key] = num(r, h);
    }
    for (const [h, [id, key]] of Object.entries(EFFECT_COLUMNS_CHECKED)) {
      const l = buildings[id]?.levels[level - 1];
      if (l && r[h] !== l[key]) fail(`${where(r, h)} is ${r[h]}, but Building Costs says ${l[key]}.`);
    }
  }

  // Mines: costs from Building Costs, output from Mines.
  const mineRows = table(wb, 'Mines', 'Mine', ['Mine', 'Level', 'Produces', 'Output per day', 'Upgrade cost: gold'], {
    gaps: true,
  });
  const mineMaxLevel = input('Mine_Max_Level', { int: true, min: 1 });
  const mines = {};
  for (const [name, id] of Object.entries(MINE_IDS)) {
    const levels = levelsFor(name, mineMaxLevel);
    const rows = mineRows.filter((r) => r.Mine === name);
    if (rows.length === 0) fail(`Mines: "${name}" is missing.`);
    const produces = rows[0] ? str(rows[0], 'Produces') : '';
    if (rows[0] && !RESOURCES.includes(produces)) fail(`${where(rows[0], 'Produces')}: unknown resource "${produces}".`);
    for (const r of rows) {
      const level = num(r, 'Level', { int: true, min: 1 });
      const l = levels[level - 1];
      if (!l) continue;
      if (r.Produces !== produces) fail(`${where(r, 'Produces')}: ${name} should produce ${produces} at every level.`);
      if (r['Upgrade cost: gold'] !== l.cost.gold) fail(`${where(r, 'Upgrade cost: gold')} doesn't match Building Costs (${l.cost.gold}). Recalculate the workbook.`);
      l.outputPerDay = num(r, 'Output per day', { int: true });
    }
    for (const l of levels) if (l.outputPerDay === undefined) fail(`Mines: ${name} level ${l.level} has no output.`);
    mines[id] = {
      id,
      name,
      produces,
      maxLevel: mineMaxLevel,
      levels: levels.map(({ starting, ...l }) => l),
    };
  }
  for (const r of mineRows) if (!(r.Mine in MINE_IDS)) idFor(MINE_IDS, r.Mine, 'mine', r, 'Mine');

  // Units.
  const unitRows = table(wb, 'Units', 'Unit', ['Unit', 'Building needed', 'At level', 'Recruits per week (base)', 'Gold', 'Crystal', 'Gems', 'Power']);
  const units = {};
  for (const u of unitRows) {
    if (!u['Building needed']) continue; // the notes row under the table
    const id = idFor(UNIT_IDS, u.Unit, 'unit', u, 'Unit');
    const building = idFor(BUILDING_IDS, u['Building needed'], 'building', u, 'Building needed');
    if (!id || !building) continue;
    const buildingLevel = num(u, 'At level', { int: true, min: 1 });
    if (buildings[building] && buildingLevel > buildings[building].maxLevel) {
      fail(`${where(u, 'At level')}: ${u.Unit} needs ${u['Building needed']} level ${buildingLevel}, above its max level.`);
    }
    units[id] = {
      id,
      name: u.Unit,
      building,
      buildingLevel,
      recruitsPerWeek: num(u, 'Recruits per week (base)', { int: true }),
      cost: { gold: num(u, 'Gold', { int: true }), wood: 0, stone: 0, crystal: num(u, 'Crystal', { int: true }), gems: num(u, 'Gems', { int: true }) },
      power: num(u, 'Power'),
    };
  }
  for (const [name, id] of Object.entries(UNIT_IDS)) if (!units[id]) fail(`Units: "${name}" is missing.`);

  // Spells.
  const spellRows = table(wb, 'Spells', 'Mage Guild level', ['Mage Guild level', 'Spell', 'Crystal', 'Gems', 'Limit', 'Effect']);
  const spells = {};
  for (const s of spellRows) {
    const id = idFor(SPELL_IDS, s.Spell, 'spell', s, 'Spell');
    if (!id) continue;
    spells[id] = {
      id,
      name: s.Spell,
      mageGuildLevel: num(s, 'Mage Guild level', { int: true, min: 1 }),
      cost: { gold: 0, wood: 0, stone: 0, crystal: num(s, 'Crystal', { int: true }), gems: num(s, 'Gems', { int: true }) },
      limit: typeof s.Limit === 'string' ? s.Limit.trim() : null,
      effect: str(s, 'Effect'),
    };
  }
  for (const [name, id] of Object.entries(SPELL_IDS)) if (!spells[id]) fail(`Spells: "${name}" is missing.`);

  // Trading Post rates per level.
  const tradeRows = table(wb, 'Trading', 'Trading Post level', ['Trading Post level', ...Object.keys(TRADING_COLUMNS)]);
  const tradingLevels = tradeRows
    .filter((r) => typeof r['Trading Post level'] === 'number')
    .map((r, i) => {
      const level = num(r, 'Trading Post level', { int: true, min: 1 });
      if (level !== i + 1) fail(`${where(r, 'Trading Post level')}: expected level ${i + 1}.`);
      const out = { level };
      for (const [h, key] of Object.entries(TRADING_COLUMNS)) out[key] = num(r, h);
      return out;
    });
  if (buildings.tradingPost && tradingLevels.length !== buildings.tradingPost.maxLevel) {
    fail(`Trading: ${tradingLevels.length} levels, but the Trading Post's max level is ${buildings.tradingPost.maxLevel}.`);
  }

  // Ruler levels.
  const xpRows = table(wb, 'XP', 'Ruler level', ['Ruler level', 'XP for this level', 'Total XP']);
  const rulerLevels = xpRows.map((r, i) => {
    const level = num(r, 'Ruler level', { int: true, min: 1 });
    if (level !== i + 1) fail(`${where(r, 'Ruler level')}: expected level ${i + 1}.`);
    const xp = num(r, 'XP for this level', { int: true });
    const totalXp = num(r, 'Total XP', { int: true });
    return { level, xp, totalXp };
  });
  rulerLevels.forEach((l, i) => {
    const prev = rulerLevels[i - 1];
    if (prev && l.totalXp !== prev.totalXp + l.xp) fail(`XP: total XP for level ${l.level} should be ${prev.totalXp + l.xp}, found ${l.totalXp}.`);
  });

  // Constants from Inputs.
  const share = { max: 1 };

  // The daily reset hour has no input cell; it's only written in the note next
  // to Build_Per_Day ("... resets 4 a.m."). Read it from there so the sheet
  // stays the one source, and stop if the note no longer says it.
  const resetNote = note('Build_Per_Day');
  const resetMatch = resetNote?.text.match(/resets (\d{1,2})(?::00)?\s*(a\.?m\.?|p\.?m\.?)/i);
  let dailyResetHour = NaN;
  if (!resetMatch) {
    fail(`${resetNote?.at ?? 'Inputs (Build_Per_Day notes)'} should say when the day resets, like "resets 4 a.m.", but is ${JSON.stringify(resetNote?.text)}.`);
  } else {
    const h = Number(resetMatch[1]) % 12;
    dailyResetHour = /^p/i.test(resetMatch[2]) ? h + 12 : h;
  }

  const rules = {
    source: sourceName,
    dailyResetHour,
    startingResources: {
      gold: input('Start_Gold', { int: true }),
      wood: input('Start_Wood', { int: true }),
      stone: input('Start_Stone', { int: true }),
      crystal: 0,
      gems: 0,
    },
    construction: {
      buildsPerDay: input('Build_Per_Day', { int: true, min: 1 }),
      secondBuilderRulerLevel: input('Builder2_Ruler', { int: true, min: 1 }),
    },
    buildings,
    mines: {
      unlockRulerLevel: input('Mine_Unlock_Ruler', { int: true, min: 1 }),
      visitEveryDays: input('Mine_Visit_Days', { int: true, min: 1 }),
      types: mines,
    },
    walking: {
      walkStripM: input('Walk_Strip'),
      bikeStripM: input('Bike_Strip_Base'),
      bikeKmFactor: input('Bike_Factor', share),
      usualRoutes: {
        goldPerKm: input('Walk_Gold_km'),
        perKmByTerrain: {
          builtUp: { stone: input('Walk_Stone_km') },
          park: { wood: input('Walk_Wood_km') },
          waterside: { crystal: input('Walk_Crystal_km') },
          hills: {},
        },
        dailyCapKm: input('Walk_Cap_km', { min: 0.1 }),
      },
      newGround: {
        goldPerKm: input('New_Gold_km'),
        perKmByTerrain: {
          builtUp: { stone: input('New_Stone_km') },
          park: { wood: input('New_Wood_km') },
          waterside: { crystal: input('New_Crystal_km') },
          hills: { gems: input('New_Gems_km') },
        },
      },
      boosterMultiplier: input('Booster_Mult', { min: 1 }),
    },
    detours: {
      rewards: {
        common: { gold: input('Detour_Common_Gold', { int: true }), wood: input('Detour_Common_Wood', { int: true }), stone: input('Detour_Common_Stone', { int: true }) },
        crystal: { crystal: input('Detour_Crystal', { int: true }) },
        gem: { gems: input('Detour_Gems', { int: true }) },
      },
      crystalOfferShare: input('Detour_Crystal_Odds', share),
      gemOfferShare: input('Detour_Gem_Odds_Base', share),
      relicRumorsTavernLevel: input('Tavern_Relic', { int: true, min: 1 }),
    },
    placeCards: {
      perNewGroundKm: {
        common: input('Card_Common_Rate'),
        uncommon: input('Card_Uncommon_Rate'),
        rare: input('Card_Rare_Rate'),
        epic: input('Card_Epic_Rate'),
      },
      rewards: {
        common: { gold: input('Card_Common_Gold', { int: true }) },
        uncommon: { woodOrStone: input('Card_Uncommon_Mat', { int: true }) },
        rare: { crystal: input('Card_Rare_Crystal', { int: true }) },
        epic: { gems: input('Card_Epic_Gems', { int: true }) },
        legendary: { gems: input('Card_Legendary_Gems', { int: true }) },
      },
    },
    units,
    recruitment: { barracksBonusPerLevel: input('Barracks_Bonus') },
    spells,
    trading: { levels: tradingLevels },
    xp: {
      usualRoutes: { perKm: input('XP_Routine_km'), dailyCap: input('XP_Routine_Cap', { int: true }) },
      newGround: {
        bands: [
          { km: input('XP_New_T1_km', { min: 0.1 }), xpPerKm: input('XP_New_T1') },
          { km: input('XP_New_T2_km', { min: 0.1 }), xpPerKm: input('XP_New_T2') },
          { km: null, xpPerKm: input('XP_New_T3') },
        ],
      },
      detour: input('XP_Detour', { int: true }),
      weeklyGoals: [
        { km: input('XP_Goal1_km'), xp: input('XP_Goal1', { int: true }) },
        { km: input('XP_Goal2_km'), xp: input('XP_Goal2', { int: true }) },
        { km: input('XP_Goal3_km'), xp: input('XP_Goal3', { int: true }) },
      ],
      surgeHeld: input('XP_Surge_Held', { int: true }),
      surgePartlyHeld: input('XP_Surge_Partial', { int: true }),
      bossDefeated: input('XP_Boss', { int: true }),
      placeCards: {
        common: input('XP_Card_Common', { int: true }),
        uncommon: input('XP_Card_Uncommon', { int: true }),
        rare: input('XP_Card_Rare', { int: true }),
        epic: input('XP_Card_Epic', { int: true }),
        legendary: input('XP_Card_Legendary', { int: true }),
      },
      outpost: input('XP_Outpost', { int: true }),
      importMaxRulerLevel: input('Import_XP_Max_Level', { int: true, min: 1 }),
      rulerLevels,
    },
    mist: {
      strengthPerFrontierKm: input('Mist_Per_km'),
      seasonPressure: { start: input('Pressure_Start'), end: input('Pressure_End') },
      fadedLand: { afterDays: input('Faded_Days', { int: true, min: 1 }), multiplier: input('Faded_Mult') },
      landLossScale: input('Loss_Scale'),
      maxLandLossPerWeek: input('Max_Loss', share),
      garrisonLoss: { held: input('Casualty_Held', share), brokeThrough: input('Casualty_Lost', share) },
      heldReward: { gold: input('Surge_Gold', { int: true }), tickets: input('Surge_Tickets', { int: true }) },
    },
    seasons: {
      weeks: input('Season_Weeks', { int: true, min: 1 }),
      bossHealth: [input('Boss_HP_S1'), input('Boss_HP_S2'), input('Boss_HP_S3')],
      bossReward: { gold: input('Boss_Gold', { int: true }), crystal: input('Boss_Crystal', { int: true }), gems: input('Boss_Gems', { int: true }) },
      siegeUnitLoss: input('Casualty_Siege', share),
      rallyBonus: input('Rally_Bonus'),
    },
  };

  for (const n of [...INPUTS_IN_TABLES, ...INPUTS_MODEL_ONLY]) {
    if (!wb.names.has(n)) fail(`scripts/generate-rules.mjs lists the named cell "${n}", but the workbook no longer has it.`);
    used.add(n);
  }
  for (const n of wb.names.keys()) {
    if (!used.has(n)) {
      fail(`The workbook has a new named cell "${n}". Map it in scripts/generate-rules.mjs, or add it to INPUTS_IN_TABLES or INPUTS_MODEL_ONLY.`);
    }
  }

  // Cross-checks between sheets.
  for (const b of Object.values(buildings)) {
    b.levels.forEach((l) => {
      if (b.id !== 'keep' && l.requiredKeepLevel !== l.level) fail(`Building Costs: ${b.name} level ${l.level} needs Keep level ${l.requiredKeepLevel}; the rule is that no building exceeds the Keep.`);
      if (l.requiredRulerLevel < b.unlockRulerLevel) fail(`Building Costs: ${b.name} level ${l.level} needs Ruler level ${l.requiredRulerLevel}, below its unlock level ${b.unlockRulerLevel}.`);
      if (l.requiredRulerLevel > rulerLevels.length) fail(`Building Costs: ${b.name} level ${l.level} needs Ruler level ${l.requiredRulerLevel}, above the top of the XP table.`);
    });
  }
  if (rules.walking.usualRoutes.dailyCapKm * rules.xp.usualRoutes.perKm !== rules.xp.usualRoutes.dailyCap) {
    // Not an error: the sheet keeps both. Surfaced so a rebalance doesn't drift unnoticed.
    console.warn(
      `Note: usual-route XP cap (${rules.xp.usualRoutes.dailyCap}) differs from the km cap × XP per km ` +
        `(${rules.walking.usualRoutes.dailyCapKm} × ${rules.xp.usualRoutes.perKm}).`,
    );
  }

  return rules;
}

// ---------------------------------------------------------------------------
// Output.

const TYPES = `/** The five resources. Crystal and gems are never capped by the Treasury. */
export type ResourceId = 'gold' | 'wood' | 'stone' | 'crystal' | 'gems';
export type Resources = Record<ResourceId, number>;

export type BuildingId =
  | 'keep'
  | 'treasury'
  | 'walls'
  | 'barracks'
  | 'watchtower'
  | 'tavern'
  | 'stable'
  | 'mageGuild'
  | 'tradingPost'
  | 'cartographersGuild'
  | 'orderOfTheDawn'
  | 'dragonRoost'
  | 'grailWonder';
export type MineId = 'goldMine' | 'quarry' | 'sawmill';
export type UnitId = 'pikeman' | 'archer' | 'knight' | 'battlemage' | 'dragon';
export type SpellId = 'lure' | 'scry' | 'ward' | 'rally' | 'farSight';
/** Terrain under a walked km. Each terrain pays one resource on top of gold. */
export type Terrain = 'builtUp' | 'park' | 'waterside' | 'hills';
export type CardRarity = 'common' | 'uncommon' | 'rare' | 'epic';

/** What a building gives at one level. Shares are fractions: 0.05 means 5%. */
export interface BuildingEffects {
  keep: { goldTaxPerDay: number; mineSlots: number };
  treasury: { goldCap: number; woodCap: number; stoneCap: number };
  walls: { defense: number };
  /** Barracks levels unlock units; see \`Unit.building\` and \`recruitment\`. */
  barracks: Record<string, never>;
  watchtower: { offersPerDay: number; mistSightM: number; defenseBonus: number };
  tavern: { gemOfferShare: number; freeRerollsPerDay: number };
  stable: { bikeStripM: number; bikeKmFactor: number };
  /** Mage Guild levels unlock spells; see \`Spell.mageGuildLevel\`. */
  mageGuild: Record<string, never>;
  tradingPost: { rateImprovement: number; freeTicketsPerWeek: number };
  cartographersGuild: { walkingStripM: number; newGroundGoldBonus: number };
  orderOfTheDawn: { beacons: number; beaconRadiusM: number };
  dragonRoost: { dragonsPerWeek: number };
  /** The sheet describes the Grail's effects only in text (\`description\`). */
  grailWonder: Record<string, never>;
}

export interface Level {
  level: number;
  /** What it costs to reach this level. */
  cost: Resources;
  /** Ruler XP for building this level. 0 for a starting level. */
  constructionXp: number;
  /** The Keep must be at least this level. null for the Keep itself. */
  requiredKeepLevel: number | null;
  requiredRulerLevel: number;
}

export interface BuildingLevel<Id extends BuildingId> extends Level {
  effects: BuildingEffects[Id];
}

export interface Building<Id extends BuildingId = BuildingId> {
  id: Id;
  name: string;
  description: string;
  unlockRulerLevel: number;
  maxLevel: number;
  /** The level every player starts with: 1 for the Keep, 0 otherwise. */
  startLevel: number;
  /** \`levels[n - 1]\` is level n. */
  levels: BuildingLevel<Id>[];
}

export interface MineLevel extends Level {
  outputPerDay: number;
}

export interface Mine {
  id: MineId;
  name: string;
  produces: ResourceId;
  maxLevel: number;
  /** \`levels[n - 1]\` is level n. Mine levels are also capped by the Keep. */
  levels: MineLevel[];
}

export interface Unit {
  id: UnitId;
  name: string;
  /** The building, and its level, that unlocks recruiting this unit. */
  building: BuildingId;
  buildingLevel: number;
  /** Recruits that appear each Monday at the unlocking level. */
  recruitsPerWeek: number;
  cost: Resources;
  /** Counts toward surge defense and siege damage. */
  power: number;
}

export interface Spell {
  id: SpellId;
  name: string;
  mageGuildLevel: number;
  cost: Resources;
  limit: string | null;
  effect: string;
}

export interface TradingLevel {
  level: number;
  freeTicketsPerWeek: number;
  buy3CrystalGold: number;
  buy1GemGold: number;
  swapGive: number;
  swapGet: number;
  sell20MaterialGold: number;
  sell1CrystalGold: number;
  sell1GemGold: number;
  weeklyCrystalLimit: number;
  weeklyGemLimit: number;
}

export interface WalkPay {
  /** Gold for every km, whatever the terrain. */
  goldPerKm: number;
  /** Extra resources per km of each terrain. */
  perKmByTerrain: Record<Terrain, Partial<Resources>>;
}

export interface RulerLevel {
  level: number;
  /** XP needed from the previous level. */
  xp: number;
  /** XP needed from zero. */
  totalXp: number;
}

export interface Rules {
  /** The workbook these rules were generated from. */
  source: string;
  /**
   * Daily limits, daily caps, and the Keep tax reset at this hour (0 to 23) in
   * the player's local time. From the note next to Build_Per_Day on Inputs.
   */
  dailyResetHour: number;
  startingResources: Resources;
  construction: {
    /** Constructions are instant; this many a day. */
    buildsPerDay: number;
    /** From this Ruler level, one more construction a day. */
    secondBuilderRulerLevel: number;
  };
  buildings: { [Id in BuildingId]: Building<Id> };
  mines: {
    unlockRulerLevel: number;
    /** A mine not visited for this many days pauses. */
    visitEveryDays: number;
    types: Record<MineId, Mine>;
  };
  walking: {
    /** Claim strip on each side of a walked path. */
    walkStripM: number;
    /** Claim strip on each side of a bike path without a Stable. */
    bikeStripM: number;
    /** A bike km counts as this share of a walking km without a Stable. */
    bikeKmFactor: number;
    /** Walking land you already hold. */
    usualRoutes: WalkPay & { dailyCapKm: number };
    /** The first walk on land. */
    newGround: WalkPay;
    /** Paid booster day: multiplies walking and new-ground resources, never XP. */
    boosterMultiplier: number;
  };
  detours: {
    rewards: { common: Partial<Resources>; crystal: Partial<Resources>; gem: Partial<Resources> };
    /** Share of offers that are crystal detours. */
    crystalOfferShare: number;
    /** Share of offers that are gem detours without a Tavern (the Tavern's \`gemOfferShare\` replaces it). */
    gemOfferShare: number;
    relicRumorsTavernLevel: number;
  };
  placeCards: {
    perNewGroundKm: Record<CardRarity, number>;
    rewards: {
      common: { gold: number };
      uncommon: { woodOrStone: number };
      rare: { crystal: number };
      epic: { gems: number };
      legendary: { gems: number };
    };
  };
  units: Record<UnitId, Unit>;
  recruitment: {
    /** Extra weekly recruits per Barracks level above the unit's unlock level. */
    barracksBonusPerLevel: number;
  };
  spells: Record<SpellId, Spell>;
  trading: { levels: TradingLevel[] };
  xp: {
    usualRoutes: { perKm: number; dailyCap: number };
    /** New-ground XP per km in daily bands; the last band (km: null) has no end. */
    newGround: { bands: { km: number | null; xpPerKm: number }[] };
    /** Average XP for finishing a detour. */
    detour: number;
    /** Each goal pays once a week when the week's km reach it. */
    weeklyGoals: { km: number; xp: number }[];
    surgeHeld: number;
    surgePartlyHeld: number;
    bossDefeated: number;
    placeCards: Record<CardRarity | 'legendary', number>;
    /** First visit to a new city. */
    outpost: number;
    /** Imported history gives XP up to this Ruler level. */
    importMaxRulerLevel: number;
    /** \`rulerLevels[n - 1]\` is level n. */
    rulerLevels: RulerLevel[];
  };
  /**
   * The weekly surge, as the sheet models it:
   * strength = strengthPerFrontierKm × effective frontier km × season pressure, where faded
   * land counts \`fadedLand.multiplier\` times and pressure rises linearly from
   * \`seasonPressure.start\` in week 1 to \`seasonPressure.end\` in the last week;
   * defense = (Walls defense + garrison power) × (1 + Watchtower defense bonus).
   * Held when defense ≥ strength. Otherwise land lost =
   * min(maxLandLossPerWeek, landLossScale × (strength − defense) ÷ strength).
   */
  mist: {
    strengthPerFrontierKm: number;
    seasonPressure: { start: number; end: number };
    fadedLand: { afterDays: number; multiplier: number };
    landLossScale: number;
    maxLandLossPerWeek: number;
    /** Share of the garrison lost. */
    garrisonLoss: { held: number; brokeThrough: number };
    heldReward: { gold: number; tickets: number };
  };
  seasons: {
    weeks: number;
    /** Boss health in seasons 1, 2 and 3. */
    bossHealth: number[];
    bossReward: { gold: number; crystal: number; gems: number };
    /** Share of the units sent that each siege loses. */
    siegeUnitLoss: number;
    rallyBonus: number;
  };
}
`;

function render(rules, sourceName) {
  return `// GENERATED FILE. DO NOT EDIT.
// Source: ${sourceName}
// Regenerate with \`node scripts/generate-rules.mjs\` from the repository root;
// see docs/rules.md. Identical copies live in mobile/src/lib/ and
// supabase/functions/_shared/, and the same values are in the latest
// supabase/migrations/*_economy_rules.sql as private.economy_rules().

${TYPES}
export const rules: Rules = ${JSON.stringify(rules, null, 2)};
`;
}

function renderSql(rules, sourceName) {
  const json = JSON.stringify(rules, null, 2);
  if (json.includes('$json$')) throw new Error('The rules contain the text "$json$", which would end the SQL quote.');
  return `-- GENERATED FILE. DO NOT EDIT.
-- Source: ${sourceName}
-- Regenerate with \`node scripts/generate-rules.mjs\` from the repository root;
-- see docs/rules.md. The JSON is the \`rules\` object of
-- mobile/src/lib/rules.generated.ts, value for value, so Postgres pays rewards
-- from the same numbers the app shows. When the rules change, the script adds
-- a new migration that replaces this function.

create schema if not exists private;

create or replace function private.economy_rules()
returns jsonb
language sql
immutable
parallel safe
set search_path = ''
as $rules$
  select $json$${json}$json$::jsonb
$rules$;

comment on function private.economy_rules() is
  'The game rules from ${sourceName}, as JSON. Generated by scripts/generate-rules.mjs; identical to the TypeScript rules.';

revoke all on function private.economy_rules() from public, anon, authenticated;
`;
}

/** Migration file names that define private.economy_rules(), oldest first. */
function rulesMigrations() {
  let names = [];
  try {
    names = readdirSync(MIGRATIONS);
  } catch {}
  return names.filter((n) => RULES_MIGRATION.test(n)).sort();
}

/** True only when git positively reports the file as untracked. Without git, files count as committed. */
function isUntrackedByGit(path) {
  try {
    const out = execFileSync('git', ['status', '--porcelain', '--', path], { cwd: root, encoding: 'utf8' });
    return out.startsWith('??');
  } catch {
    return false;
  }
}

/** A migration timestamp (UTC, YYYYMMDDHHMMSS) later than every existing migration. */
function nextMigrationStamp() {
  const stamp = (d) => d.toISOString().replace(/\D/g, '').slice(0, 14);
  let latest = '';
  try {
    for (const n of readdirSync(MIGRATIONS)) {
      const m = n.match(/^(\d{14})_/);
      if (m && m[1] > latest) latest = m[1];
    }
  } catch {}
  let next = stamp(new Date());
  if (next <= latest) {
    const t = latest;
    next = stamp(new Date(Date.UTC(+t.slice(0, 4), +t.slice(4, 6) - 1, +t.slice(6, 8), +t.slice(8, 10), +t.slice(10, 12), +t.slice(12, 14) + 1)));
  }
  return next;
}

const args = process.argv.slice(2);
const check = args.includes('--check');
const xlsxIdx = args.indexOf('--xlsx');
const xlsxPath = xlsxIdx >= 0 ? args[xlsxIdx + 1] : join(root, 'Local Legend_Economy.xlsx');
if (xlsxIdx >= 0 && !xlsxPath) {
  console.error('--xlsx needs a path.');
  process.exit(2);
}

// Always record the canonical workbook name, so regenerating from a copy
// produces a diff only where values changed.
const sourceName = 'Local Legend_Economy.xlsx';
let rules;
try {
  rules = buildRules(readWorkbook(xlsxPath), sourceName);
} catch (e) {
  problems.push(e.message);
}
if (problems.length) {
  console.error(`Couldn't generate the rules from ${xlsxPath}:`);
  for (const p of problems) console.error(`  - ${p}`);
  process.exit(1);
}

const output = render(rules, sourceName);
let stale = false;
for (const out of OUTPUTS) {
  const rel = relative(root, out);
  let current = null;
  try {
    current = readFileSync(out, 'utf8');
  } catch {}
  if (check) {
    if (current !== output) {
      console.error(`${rel} is out of date. Run: node scripts/generate-rules.mjs`);
      stale = true;
    }
  } else if (current === output) {
    console.log(`${rel} is up to date.`);
  } else {
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, output);
    console.log(`Wrote ${rel}.`);
  }
}

// The SQL copy: the latest economy_rules migration must hold exactly these rules.
const sql = renderSql(rules, sourceName);
const latest = rulesMigrations().at(-1);
const latestPath = latest ? join(MIGRATIONS, latest) : null;
const latestSql = latestPath ? readFileSync(latestPath, 'utf8') : null;
if (check) {
  if (latestSql !== sql) {
    console.error(
      latest
        ? `supabase/migrations/${latest} doesn't match the rules. Run: node scripts/generate-rules.mjs (it adds a new migration).`
        : 'No supabase/migrations/*_economy_rules.sql defines private.economy_rules(). Run: node scripts/generate-rules.mjs',
    );
    stale = true;
  }
} else if (latestSql === sql) {
  console.log(`supabase/migrations/${latest} is up to date.`);
} else if (latestPath && isUntrackedByGit(latestPath)) {
  writeFileSync(latestPath, sql);
  console.log(`Rewrote supabase/migrations/${latest} in place: git doesn't track it yet.`);
} else {
  const name = `${nextMigrationStamp()}_economy_rules.sql`;
  mkdirSync(MIGRATIONS, { recursive: true });
  writeFileSync(join(MIGRATIONS, name), sql);
  console.log(`Wrote supabase/migrations/${name}. Apply it locally with: npx supabase@latest migration up`);
}

if (check && !stale) console.log('Rules are up to date.');
process.exit(stale ? 1 : 0);
