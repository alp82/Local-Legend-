// GENERATED FILE. DO NOT EDIT.
// Source: Local Legend_Economy.xlsx
// Regenerate with `node scripts/generate-rules.mjs` from the repository root;
// see docs/rules.md. Identical copies live in mobile/src/lib/ and
// supabase/functions/_shared/.

/** The five resources. Crystal and gems are never capped by the Treasury. */
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
  /** Barracks levels unlock units; see `Unit.building` and `recruitment`. */
  barracks: Record<string, never>;
  watchtower: { offersPerDay: number; mistSightM: number; defenseBonus: number };
  tavern: { gemOfferShare: number; freeRerollsPerDay: number };
  stable: { bikeStripM: number; bikeKmFactor: number };
  /** Mage Guild levels unlock spells; see `Spell.mageGuildLevel`. */
  mageGuild: Record<string, never>;
  tradingPost: { rateImprovement: number; freeTicketsPerWeek: number };
  cartographersGuild: { walkingStripM: number; newGroundGoldBonus: number };
  orderOfTheDawn: { beacons: number; beaconRadiusM: number };
  dragonRoost: { dragonsPerWeek: number };
  /** The sheet describes the Grail's effects only in text (`description`). */
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
  /** `levels[n - 1]` is level n. */
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
  /** `levels[n - 1]` is level n. Mine levels are also capped by the Keep. */
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
    /** Share of offers that are gem detours without a Tavern (the Tavern's `gemOfferShare` replaces it). */
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
    /** `rulerLevels[n - 1]` is level n. */
    rulerLevels: RulerLevel[];
  };
  /**
   * The weekly surge, as the sheet models it:
   * strength = strengthPerFrontierKm × effective frontier km × season pressure, where faded
   * land counts `fadedLand.multiplier` times and pressure rises linearly from
   * `seasonPressure.start` in week 1 to `seasonPressure.end` in the last week;
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

export const rules: Rules = {
  "source": "Local Legend_Economy.xlsx",
  "startingResources": {
    "gold": 2000,
    "wood": 20,
    "stone": 20,
    "crystal": 0,
    "gems": 0
  },
  "construction": {
    "buildsPerDay": 1,
    "secondBuilderRulerLevel": 15
  },
  "buildings": {
    "keep": {
      "id": "keep",
      "name": "Keep",
      "description": "Gold tax, mine slots, caps every other building's level. You start at level 1.",
      "unlockRulerLevel": 1,
      "maxLevel": 10,
      "startLevel": 1,
      "levels": [
        {
          "level": 1,
          "cost": {
            "gold": 0,
            "wood": 0,
            "stone": 0,
            "crystal": 0,
            "gems": 0
          },
          "constructionXp": 0,
          "requiredKeepLevel": null,
          "requiredRulerLevel": 1,
          "effects": {
            "goldTaxPerDay": 300,
            "mineSlots": 1
          }
        },
        {
          "level": 2,
          "cost": {
            "gold": 2400,
            "wood": 8,
            "stone": 22,
            "crystal": 0,
            "gems": 0
          },
          "constructionXp": 90,
          "requiredKeepLevel": null,
          "requiredRulerLevel": 4,
          "effects": {
            "goldTaxPerDay": 400,
            "mineSlots": 1
          }
        },
        {
          "level": 3,
          "cost": {
            "gold": 3200,
            "wood": 11,
            "stone": 29,
            "crystal": 0,
            "gems": 0
          },
          "constructionXp": 105,
          "requiredKeepLevel": null,
          "requiredRulerLevel": 7,
          "effects": {
            "goldTaxPerDay": 500,
            "mineSlots": 2
          }
        },
        {
          "level": 4,
          "cost": {
            "gold": 4300,
            "wood": 15,
            "stone": 39,
            "crystal": 2,
            "gems": 0
          },
          "constructionXp": 120,
          "requiredKeepLevel": null,
          "requiredRulerLevel": 10,
          "effects": {
            "goldTaxPerDay": 600,
            "mineSlots": 2
          }
        },
        {
          "level": 5,
          "cost": {
            "gold": 5800,
            "wood": 20,
            "stone": 53,
            "crystal": 3,
            "gems": 0
          },
          "constructionXp": 135,
          "requiredKeepLevel": null,
          "requiredRulerLevel": 13,
          "effects": {
            "goldTaxPerDay": 700,
            "mineSlots": 3
          }
        },
        {
          "level": 6,
          "cost": {
            "gold": 7800,
            "wood": 27,
            "stone": 72,
            "crystal": 4,
            "gems": 0
          },
          "constructionXp": 150,
          "requiredKeepLevel": null,
          "requiredRulerLevel": 16,
          "effects": {
            "goldTaxPerDay": 800,
            "mineSlots": 3
          }
        },
        {
          "level": 7,
          "cost": {
            "gold": 11000,
            "wood": 36,
            "stone": 97,
            "crystal": 5,
            "gems": 1
          },
          "constructionXp": 165,
          "requiredKeepLevel": null,
          "requiredRulerLevel": 19,
          "effects": {
            "goldTaxPerDay": 900,
            "mineSlots": 4
          }
        },
        {
          "level": 8,
          "cost": {
            "gold": 14000,
            "wood": 49,
            "stone": 131,
            "crystal": 7,
            "gems": 1
          },
          "constructionXp": 180,
          "requiredKeepLevel": null,
          "requiredRulerLevel": 22,
          "effects": {
            "goldTaxPerDay": 1000,
            "mineSlots": 4
          }
        },
        {
          "level": 9,
          "cost": {
            "gold": 19000,
            "wood": 66,
            "stone": 177,
            "crystal": 9,
            "gems": 2
          },
          "constructionXp": 195,
          "requiredKeepLevel": null,
          "requiredRulerLevel": 25,
          "effects": {
            "goldTaxPerDay": 1100,
            "mineSlots": 5
          }
        },
        {
          "level": 10,
          "cost": {
            "gold": 26000,
            "wood": 89,
            "stone": 238,
            "crystal": 12,
            "gems": 2
          },
          "constructionXp": 210,
          "requiredKeepLevel": null,
          "requiredRulerLevel": 28,
          "effects": {
            "goldTaxPerDay": 1200,
            "mineSlots": 5
          }
        }
      ]
    },
    "treasury": {
      "id": "treasury",
      "name": "Treasury",
      "description": "Storage caps for gold, wood and stone.",
      "unlockRulerLevel": 1,
      "maxLevel": 10,
      "startLevel": 0,
      "levels": [
        {
          "level": 1,
          "cost": {
            "gold": 700,
            "wood": 5,
            "stone": 10,
            "crystal": 0,
            "gems": 0
          },
          "constructionXp": 75,
          "requiredKeepLevel": 1,
          "requiredRulerLevel": 1,
          "effects": {
            "goldCap": 5000,
            "woodCap": 60,
            "stoneCap": 60
          }
        },
        {
          "level": 2,
          "cost": {
            "gold": 900,
            "wood": 7,
            "stone": 14,
            "crystal": 0,
            "gems": 0
          },
          "constructionXp": 90,
          "requiredKeepLevel": 2,
          "requiredRulerLevel": 4,
          "effects": {
            "goldCap": 6800,
            "woodCap": 81,
            "stoneCap": 81
          }
        },
        {
          "level": 3,
          "cost": {
            "gold": 1300,
            "wood": 9,
            "stone": 18,
            "crystal": 0,
            "gems": 0
          },
          "constructionXp": 105,
          "requiredKeepLevel": 3,
          "requiredRulerLevel": 7,
          "effects": {
            "goldCap": 9100,
            "woodCap": 109,
            "stoneCap": 109
          }
        },
        {
          "level": 4,
          "cost": {
            "gold": 1700,
            "wood": 12,
            "stone": 25,
            "crystal": 0,
            "gems": 0
          },
          "constructionXp": 120,
          "requiredKeepLevel": 4,
          "requiredRulerLevel": 10,
          "effects": {
            "goldCap": 12300,
            "woodCap": 148,
            "stoneCap": 148
          }
        },
        {
          "level": 5,
          "cost": {
            "gold": 2300,
            "wood": 17,
            "stone": 33,
            "crystal": 1,
            "gems": 0
          },
          "constructionXp": 135,
          "requiredKeepLevel": 5,
          "requiredRulerLevel": 13,
          "effects": {
            "goldCap": 16600,
            "woodCap": 199,
            "stoneCap": 199
          }
        },
        {
          "level": 6,
          "cost": {
            "gold": 3100,
            "wood": 22,
            "stone": 45,
            "crystal": 1,
            "gems": 0
          },
          "constructionXp": 150,
          "requiredKeepLevel": 6,
          "requiredRulerLevel": 16,
          "effects": {
            "goldCap": 22400,
            "woodCap": 269,
            "stoneCap": 269
          }
        },
        {
          "level": 7,
          "cost": {
            "gold": 4200,
            "wood": 30,
            "stone": 61,
            "crystal": 2,
            "gems": 0
          },
          "constructionXp": 165,
          "requiredKeepLevel": 7,
          "requiredRulerLevel": 19,
          "effects": {
            "goldCap": 30300,
            "woodCap": 363,
            "stoneCap": 363
          }
        },
        {
          "level": 8,
          "cost": {
            "gold": 5700,
            "wood": 41,
            "stone": 82,
            "crystal": 2,
            "gems": 1
          },
          "constructionXp": 180,
          "requiredKeepLevel": 8,
          "requiredRulerLevel": 22,
          "effects": {
            "goldCap": 40900,
            "woodCap": 490,
            "stoneCap": 490
          }
        },
        {
          "level": 9,
          "cost": {
            "gold": 7700,
            "wood": 55,
            "stone": 110,
            "crystal": 3,
            "gems": 1
          },
          "constructionXp": 195,
          "requiredKeepLevel": 9,
          "requiredRulerLevel": 25,
          "effects": {
            "goldCap": 55200,
            "woodCap": 662,
            "stoneCap": 662
          }
        },
        {
          "level": 10,
          "cost": {
            "gold": 10000,
            "wood": 74,
            "stone": 149,
            "crystal": 4,
            "gems": 2
          },
          "constructionXp": 210,
          "requiredKeepLevel": 10,
          "requiredRulerLevel": 28,
          "effects": {
            "goldCap": 74500,
            "woodCap": 894,
            "stoneCap": 894
          }
        }
      ]
    },
    "walls": {
      "id": "walls",
      "name": "Walls",
      "description": "Defense against Mist surges.",
      "unlockRulerLevel": 1,
      "maxLevel": 10,
      "startLevel": 0,
      "levels": [
        {
          "level": 1,
          "cost": {
            "gold": 700,
            "wood": 4,
            "stone": 16,
            "crystal": 0,
            "gems": 0
          },
          "constructionXp": 75,
          "requiredKeepLevel": 1,
          "requiredRulerLevel": 1,
          "effects": {
            "defense": 150
          }
        },
        {
          "level": 2,
          "cost": {
            "gold": 900,
            "wood": 5,
            "stone": 22,
            "crystal": 0,
            "gems": 0
          },
          "constructionXp": 90,
          "requiredKeepLevel": 2,
          "requiredRulerLevel": 4,
          "effects": {
            "defense": 230
          }
        },
        {
          "level": 3,
          "cost": {
            "gold": 1300,
            "wood": 7,
            "stone": 29,
            "crystal": 0,
            "gems": 0
          },
          "constructionXp": 105,
          "requiredKeepLevel": 3,
          "requiredRulerLevel": 7,
          "effects": {
            "defense": 340
          }
        },
        {
          "level": 4,
          "cost": {
            "gold": 1700,
            "wood": 10,
            "stone": 39,
            "crystal": 0,
            "gems": 0
          },
          "constructionXp": 120,
          "requiredKeepLevel": 4,
          "requiredRulerLevel": 10,
          "effects": {
            "defense": 510
          }
        },
        {
          "level": 5,
          "cost": {
            "gold": 2300,
            "wood": 13,
            "stone": 53,
            "crystal": 1,
            "gems": 0
          },
          "constructionXp": 135,
          "requiredKeepLevel": 5,
          "requiredRulerLevel": 13,
          "effects": {
            "defense": 760
          }
        },
        {
          "level": 6,
          "cost": {
            "gold": 3100,
            "wood": 18,
            "stone": 72,
            "crystal": 1,
            "gems": 0
          },
          "constructionXp": 150,
          "requiredKeepLevel": 6,
          "requiredRulerLevel": 16,
          "effects": {
            "defense": 1140
          }
        },
        {
          "level": 7,
          "cost": {
            "gold": 4200,
            "wood": 24,
            "stone": 97,
            "crystal": 2,
            "gems": 0
          },
          "constructionXp": 165,
          "requiredKeepLevel": 7,
          "requiredRulerLevel": 19,
          "effects": {
            "defense": 1710
          }
        },
        {
          "level": 8,
          "cost": {
            "gold": 5700,
            "wood": 33,
            "stone": 131,
            "crystal": 2,
            "gems": 1
          },
          "constructionXp": 180,
          "requiredKeepLevel": 8,
          "requiredRulerLevel": 22,
          "effects": {
            "defense": 2560
          }
        },
        {
          "level": 9,
          "cost": {
            "gold": 7700,
            "wood": 44,
            "stone": 177,
            "crystal": 3,
            "gems": 1
          },
          "constructionXp": 195,
          "requiredKeepLevel": 9,
          "requiredRulerLevel": 25,
          "effects": {
            "defense": 3840
          }
        },
        {
          "level": 10,
          "cost": {
            "gold": 10000,
            "wood": 60,
            "stone": 238,
            "crystal": 4,
            "gems": 2
          },
          "constructionXp": 210,
          "requiredKeepLevel": 10,
          "requiredRulerLevel": 28,
          "effects": {
            "defense": 5770
          }
        }
      ]
    },
    "barracks": {
      "id": "barracks",
      "name": "Barracks",
      "description": "L1 Pikemen, L3 Archers, L5 Knights, L7 Battlemages; other levels +25% weekly recruits.",
      "unlockRulerLevel": 1,
      "maxLevel": 7,
      "startLevel": 0,
      "levels": [
        {
          "level": 1,
          "cost": {
            "gold": 850,
            "wood": 7,
            "stone": 10,
            "crystal": 0,
            "gems": 0
          },
          "constructionXp": 75,
          "requiredKeepLevel": 1,
          "requiredRulerLevel": 1,
          "effects": {}
        },
        {
          "level": 2,
          "cost": {
            "gold": 1100,
            "wood": 9,
            "stone": 14,
            "crystal": 0,
            "gems": 0
          },
          "constructionXp": 90,
          "requiredKeepLevel": 2,
          "requiredRulerLevel": 4,
          "effects": {}
        },
        {
          "level": 3,
          "cost": {
            "gold": 1500,
            "wood": 13,
            "stone": 18,
            "crystal": 0,
            "gems": 0
          },
          "constructionXp": 105,
          "requiredKeepLevel": 3,
          "requiredRulerLevel": 7,
          "effects": {}
        },
        {
          "level": 4,
          "cost": {
            "gold": 2100,
            "wood": 17,
            "stone": 25,
            "crystal": 1,
            "gems": 0
          },
          "constructionXp": 120,
          "requiredKeepLevel": 4,
          "requiredRulerLevel": 10,
          "effects": {}
        },
        {
          "level": 5,
          "cost": {
            "gold": 2800,
            "wood": 23,
            "stone": 33,
            "crystal": 1,
            "gems": 0
          },
          "constructionXp": 135,
          "requiredKeepLevel": 5,
          "requiredRulerLevel": 13,
          "effects": {}
        },
        {
          "level": 6,
          "cost": {
            "gold": 3800,
            "wood": 31,
            "stone": 45,
            "crystal": 2,
            "gems": 1
          },
          "constructionXp": 150,
          "requiredKeepLevel": 6,
          "requiredRulerLevel": 16,
          "effects": {}
        },
        {
          "level": 7,
          "cost": {
            "gold": 5100,
            "wood": 42,
            "stone": 61,
            "crystal": 2,
            "gems": 1
          },
          "constructionXp": 165,
          "requiredKeepLevel": 7,
          "requiredRulerLevel": 19,
          "effects": {}
        }
      ]
    },
    "watchtower": {
      "id": "watchtower",
      "name": "Watchtower",
      "description": "More daily detour offers, sight into the Mist, surge warning, defense bonus.",
      "unlockRulerLevel": 3,
      "maxLevel": 7,
      "startLevel": 0,
      "levels": [
        {
          "level": 1,
          "cost": {
            "gold": 850,
            "wood": 9,
            "stone": 6,
            "crystal": 0,
            "gems": 0
          },
          "constructionXp": 75,
          "requiredKeepLevel": 1,
          "requiredRulerLevel": 3,
          "effects": {
            "offersPerDay": 2,
            "mistSightM": 200,
            "defenseBonus": 0.05
          }
        },
        {
          "level": 2,
          "cost": {
            "gold": 1100,
            "wood": 12,
            "stone": 8,
            "crystal": 0,
            "gems": 0
          },
          "constructionXp": 90,
          "requiredKeepLevel": 2,
          "requiredRulerLevel": 4,
          "effects": {
            "offersPerDay": 2,
            "mistSightM": 300,
            "defenseBonus": 0.1
          }
        },
        {
          "level": 3,
          "cost": {
            "gold": 1500,
            "wood": 16,
            "stone": 11,
            "crystal": 1,
            "gems": 0
          },
          "constructionXp": 105,
          "requiredKeepLevel": 3,
          "requiredRulerLevel": 7,
          "effects": {
            "offersPerDay": 3,
            "mistSightM": 400,
            "defenseBonus": 0.15
          }
        },
        {
          "level": 4,
          "cost": {
            "gold": 2100,
            "wood": 22,
            "stone": 15,
            "crystal": 1,
            "gems": 0
          },
          "constructionXp": 120,
          "requiredKeepLevel": 4,
          "requiredRulerLevel": 10,
          "effects": {
            "offersPerDay": 3,
            "mistSightM": 500,
            "defenseBonus": 0.2
          }
        },
        {
          "level": 5,
          "cost": {
            "gold": 2800,
            "wood": 30,
            "stone": 20,
            "crystal": 2,
            "gems": 0
          },
          "constructionXp": 135,
          "requiredKeepLevel": 5,
          "requiredRulerLevel": 13,
          "effects": {
            "offersPerDay": 4,
            "mistSightM": 600,
            "defenseBonus": 0.25
          }
        },
        {
          "level": 6,
          "cost": {
            "gold": 3800,
            "wood": 40,
            "stone": 27,
            "crystal": 2,
            "gems": 1
          },
          "constructionXp": 150,
          "requiredKeepLevel": 6,
          "requiredRulerLevel": 16,
          "effects": {
            "offersPerDay": 4,
            "mistSightM": 700,
            "defenseBonus": 0.3
          }
        },
        {
          "level": 7,
          "cost": {
            "gold": 5100,
            "wood": 54,
            "stone": 36,
            "crystal": 3,
            "gems": 1
          },
          "constructionXp": 165,
          "requiredKeepLevel": 7,
          "requiredRulerLevel": 19,
          "effects": {
            "offersPerDay": 5,
            "mistSightM": 800,
            "defenseBonus": 0.35
          }
        }
      ]
    },
    "tavern": {
      "id": "tavern",
      "name": "Tavern",
      "description": "Better detour offers (more gem offers), free rerolls, relic rumors.",
      "unlockRulerLevel": 3,
      "maxLevel": 7,
      "startLevel": 0,
      "levels": [
        {
          "level": 1,
          "cost": {
            "gold": 850,
            "wood": 9,
            "stone": 6,
            "crystal": 0,
            "gems": 0
          },
          "constructionXp": 75,
          "requiredKeepLevel": 1,
          "requiredRulerLevel": 3,
          "effects": {
            "gemOfferShare": 0.13,
            "freeRerollsPerDay": 0
          }
        },
        {
          "level": 2,
          "cost": {
            "gold": 1100,
            "wood": 12,
            "stone": 8,
            "crystal": 0,
            "gems": 0
          },
          "constructionXp": 90,
          "requiredKeepLevel": 2,
          "requiredRulerLevel": 4,
          "effects": {
            "gemOfferShare": 0.16,
            "freeRerollsPerDay": 0
          }
        },
        {
          "level": 3,
          "cost": {
            "gold": 1500,
            "wood": 16,
            "stone": 11,
            "crystal": 1,
            "gems": 0
          },
          "constructionXp": 105,
          "requiredKeepLevel": 3,
          "requiredRulerLevel": 7,
          "effects": {
            "gemOfferShare": 0.19,
            "freeRerollsPerDay": 1
          }
        },
        {
          "level": 4,
          "cost": {
            "gold": 2100,
            "wood": 22,
            "stone": 15,
            "crystal": 1,
            "gems": 0
          },
          "constructionXp": 120,
          "requiredKeepLevel": 4,
          "requiredRulerLevel": 10,
          "effects": {
            "gemOfferShare": 0.22,
            "freeRerollsPerDay": 1
          }
        },
        {
          "level": 5,
          "cost": {
            "gold": 2800,
            "wood": 30,
            "stone": 20,
            "crystal": 2,
            "gems": 1
          },
          "constructionXp": 135,
          "requiredKeepLevel": 5,
          "requiredRulerLevel": 13,
          "effects": {
            "gemOfferShare": 0.25,
            "freeRerollsPerDay": 1
          }
        },
        {
          "level": 6,
          "cost": {
            "gold": 3800,
            "wood": 40,
            "stone": 27,
            "crystal": 2,
            "gems": 1
          },
          "constructionXp": 150,
          "requiredKeepLevel": 6,
          "requiredRulerLevel": 16,
          "effects": {
            "gemOfferShare": 0.28,
            "freeRerollsPerDay": 1
          }
        },
        {
          "level": 7,
          "cost": {
            "gold": 5100,
            "wood": 54,
            "stone": 36,
            "crystal": 3,
            "gems": 2
          },
          "constructionXp": 165,
          "requiredKeepLevel": 7,
          "requiredRulerLevel": 19,
          "effects": {
            "gemOfferShare": 0.31,
            "freeRerollsPerDay": 2
          }
        }
      ]
    },
    "stable": {
      "id": "stable",
      "name": "Stable",
      "description": "Bike rides claim a wider strip and count more toward harvest.",
      "unlockRulerLevel": 5,
      "maxLevel": 5,
      "startLevel": 0,
      "levels": [
        {
          "level": 1,
          "cost": {
            "gold": 1050,
            "wood": 9,
            "stone": 6,
            "crystal": 0,
            "gems": 0
          },
          "constructionXp": 75,
          "requiredKeepLevel": 1,
          "requiredRulerLevel": 5,
          "effects": {
            "bikeStripM": 15,
            "bikeKmFactor": 0.4
          }
        },
        {
          "level": 2,
          "cost": {
            "gold": 1400,
            "wood": 12,
            "stone": 8,
            "crystal": 0,
            "gems": 0
          },
          "constructionXp": 90,
          "requiredKeepLevel": 2,
          "requiredRulerLevel": 5,
          "effects": {
            "bikeStripM": 20,
            "bikeKmFactor": 0.466666666666667
          }
        },
        {
          "level": 3,
          "cost": {
            "gold": 1900,
            "wood": 16,
            "stone": 11,
            "crystal": 1,
            "gems": 0
          },
          "constructionXp": 105,
          "requiredKeepLevel": 3,
          "requiredRulerLevel": 7,
          "effects": {
            "bikeStripM": 25,
            "bikeKmFactor": 0.533333333333333
          }
        },
        {
          "level": 4,
          "cost": {
            "gold": 2600,
            "wood": 22,
            "stone": 15,
            "crystal": 1,
            "gems": 0
          },
          "constructionXp": 120,
          "requiredKeepLevel": 4,
          "requiredRulerLevel": 10,
          "effects": {
            "bikeStripM": 30,
            "bikeKmFactor": 0.6
          }
        },
        {
          "level": 5,
          "cost": {
            "gold": 3500,
            "wood": 30,
            "stone": 20,
            "crystal": 2,
            "gems": 1
          },
          "constructionXp": 135,
          "requiredKeepLevel": 5,
          "requiredRulerLevel": 13,
          "effects": {
            "bikeStripM": 35,
            "bikeKmFactor": 0.666666666666667
          }
        }
      ]
    },
    "mageGuild": {
      "id": "mageGuild",
      "name": "Mage Guild",
      "description": "One new spell per level (see Spells).",
      "unlockRulerLevel": 5,
      "maxLevel": 5,
      "startLevel": 0,
      "levels": [
        {
          "level": 1,
          "cost": {
            "gold": 1400,
            "wood": 5,
            "stone": 12,
            "crystal": 3,
            "gems": 0
          },
          "constructionXp": 75,
          "requiredKeepLevel": 1,
          "requiredRulerLevel": 5,
          "effects": {}
        },
        {
          "level": 2,
          "cost": {
            "gold": 1900,
            "wood": 7,
            "stone": 16,
            "crystal": 4,
            "gems": 0
          },
          "constructionXp": 90,
          "requiredKeepLevel": 2,
          "requiredRulerLevel": 5,
          "effects": {}
        },
        {
          "level": 3,
          "cost": {
            "gold": 2600,
            "wood": 9,
            "stone": 22,
            "crystal": 5,
            "gems": 1
          },
          "constructionXp": 105,
          "requiredKeepLevel": 3,
          "requiredRulerLevel": 7,
          "effects": {}
        },
        {
          "level": 4,
          "cost": {
            "gold": 3400,
            "wood": 12,
            "stone": 30,
            "crystal": 7,
            "gems": 1
          },
          "constructionXp": 120,
          "requiredKeepLevel": 4,
          "requiredRulerLevel": 10,
          "effects": {}
        },
        {
          "level": 5,
          "cost": {
            "gold": 4700,
            "wood": 17,
            "stone": 40,
            "crystal": 10,
            "gems": 2
          },
          "constructionXp": 135,
          "requiredKeepLevel": 5,
          "requiredRulerLevel": 13,
          "effects": {}
        }
      ]
    },
    "tradingPost": {
      "id": "tradingPost",
      "name": "Trading Post",
      "description": "Trade with the game using tickets; better rates and more free tickets per level.",
      "unlockRulerLevel": 10,
      "maxLevel": 5,
      "startLevel": 0,
      "levels": [
        {
          "level": 1,
          "cost": {
            "gold": 2100,
            "wood": 9,
            "stone": 12,
            "crystal": 0,
            "gems": 0
          },
          "constructionXp": 75,
          "requiredKeepLevel": 1,
          "requiredRulerLevel": 10,
          "effects": {
            "rateImprovement": 0,
            "freeTicketsPerWeek": 2
          }
        },
        {
          "level": 2,
          "cost": {
            "gold": 2800,
            "wood": 12,
            "stone": 16,
            "crystal": 2,
            "gems": 0
          },
          "constructionXp": 90,
          "requiredKeepLevel": 2,
          "requiredRulerLevel": 10,
          "effects": {
            "rateImprovement": 0.08,
            "freeTicketsPerWeek": 2
          }
        },
        {
          "level": 3,
          "cost": {
            "gold": 3800,
            "wood": 16,
            "stone": 22,
            "crystal": 3,
            "gems": 0
          },
          "constructionXp": 105,
          "requiredKeepLevel": 3,
          "requiredRulerLevel": 10,
          "effects": {
            "rateImprovement": 0.16,
            "freeTicketsPerWeek": 3
          }
        },
        {
          "level": 4,
          "cost": {
            "gold": 5200,
            "wood": 22,
            "stone": 30,
            "crystal": 4,
            "gems": 1
          },
          "constructionXp": 120,
          "requiredKeepLevel": 4,
          "requiredRulerLevel": 10,
          "effects": {
            "rateImprovement": 0.24,
            "freeTicketsPerWeek": 3
          }
        },
        {
          "level": 5,
          "cost": {
            "gold": 7000,
            "wood": 30,
            "stone": 40,
            "crystal": 5,
            "gems": 1
          },
          "constructionXp": 135,
          "requiredKeepLevel": 5,
          "requiredRulerLevel": 13,
          "effects": {
            "rateImprovement": 0.32,
            "freeTicketsPerWeek": 4
          }
        }
      ]
    },
    "cartographersGuild": {
      "id": "cartographersGuild",
      "name": "Cartographers' Guild",
      "description": "Wider walking strip, more new-ground gold, detour offers near work and stations.",
      "unlockRulerLevel": 15,
      "maxLevel": 5,
      "startLevel": 0,
      "levels": [
        {
          "level": 1,
          "cost": {
            "gold": 2800,
            "wood": 9,
            "stone": 12,
            "crystal": 4,
            "gems": 0
          },
          "constructionXp": 75,
          "requiredKeepLevel": 1,
          "requiredRulerLevel": 15,
          "effects": {
            "walkingStripM": 35,
            "newGroundGoldBonus": 0.1
          }
        },
        {
          "level": 2,
          "cost": {
            "gold": 3800,
            "wood": 12,
            "stone": 16,
            "crystal": 5,
            "gems": 2
          },
          "constructionXp": 90,
          "requiredKeepLevel": 2,
          "requiredRulerLevel": 15,
          "effects": {
            "walkingStripM": 40,
            "newGroundGoldBonus": 0.2
          }
        },
        {
          "level": 3,
          "cost": {
            "gold": 5100,
            "wood": 16,
            "stone": 22,
            "crystal": 7,
            "gems": 3
          },
          "constructionXp": 105,
          "requiredKeepLevel": 3,
          "requiredRulerLevel": 15,
          "effects": {
            "walkingStripM": 45,
            "newGroundGoldBonus": 0.3
          }
        },
        {
          "level": 4,
          "cost": {
            "gold": 6900,
            "wood": 22,
            "stone": 30,
            "crystal": 10,
            "gems": 4
          },
          "constructionXp": 120,
          "requiredKeepLevel": 4,
          "requiredRulerLevel": 15,
          "effects": {
            "walkingStripM": 50,
            "newGroundGoldBonus": 0.4
          }
        },
        {
          "level": 5,
          "cost": {
            "gold": 9300,
            "wood": 30,
            "stone": 40,
            "crystal": 13,
            "gems": 5
          },
          "constructionXp": 135,
          "requiredKeepLevel": 5,
          "requiredRulerLevel": 15,
          "effects": {
            "walkingStripM": 55,
            "newGroundGoldBonus": 0.5
          }
        }
      ]
    },
    "orderOfTheDawn": {
      "id": "orderOfTheDawn",
      "name": "Order of the Dawn",
      "description": "Beacons at real places you visit weekly; land inside them is safe from surges.",
      "unlockRulerLevel": 20,
      "maxLevel": 5,
      "startLevel": 0,
      "levels": [
        {
          "level": 1,
          "cost": {
            "gold": 3500,
            "wood": 12,
            "stone": 20,
            "crystal": 5,
            "gems": 2
          },
          "constructionXp": 75,
          "requiredKeepLevel": 1,
          "requiredRulerLevel": 20,
          "effects": {
            "beacons": 1,
            "beaconRadiusM": 400
          }
        },
        {
          "level": 2,
          "cost": {
            "gold": 4700,
            "wood": 16,
            "stone": 27,
            "crystal": 7,
            "gems": 3
          },
          "constructionXp": 90,
          "requiredKeepLevel": 2,
          "requiredRulerLevel": 20,
          "effects": {
            "beacons": 1,
            "beaconRadiusM": 500
          }
        },
        {
          "level": 3,
          "cost": {
            "gold": 6400,
            "wood": 22,
            "stone": 36,
            "crystal": 9,
            "gems": 4
          },
          "constructionXp": 105,
          "requiredKeepLevel": 3,
          "requiredRulerLevel": 20,
          "effects": {
            "beacons": 2,
            "beaconRadiusM": 600
          }
        },
        {
          "level": 4,
          "cost": {
            "gold": 8600,
            "wood": 30,
            "stone": 49,
            "crystal": 12,
            "gems": 5
          },
          "constructionXp": 120,
          "requiredKeepLevel": 4,
          "requiredRulerLevel": 20,
          "effects": {
            "beacons": 2,
            "beaconRadiusM": 700
          }
        },
        {
          "level": 5,
          "cost": {
            "gold": 12000,
            "wood": 40,
            "stone": 66,
            "crystal": 17,
            "gems": 7
          },
          "constructionXp": 135,
          "requiredKeepLevel": 5,
          "requiredRulerLevel": 20,
          "effects": {
            "beacons": 3,
            "beaconRadiusM": 800
          }
        }
      ]
    },
    "dragonRoost": {
      "id": "dragonRoost",
      "name": "Dragon Roost",
      "description": "Dragons: 1, 2 or 3 a week.",
      "unlockRulerLevel": 25,
      "maxLevel": 3,
      "startLevel": 0,
      "levels": [
        {
          "level": 1,
          "cost": {
            "gold": 7000,
            "wood": 18,
            "stone": 24,
            "crystal": 8,
            "gems": 4
          },
          "constructionXp": 75,
          "requiredKeepLevel": 1,
          "requiredRulerLevel": 25,
          "effects": {
            "dragonsPerWeek": 1
          }
        },
        {
          "level": 2,
          "cost": {
            "gold": 9500,
            "wood": 24,
            "stone": 32,
            "crystal": 11,
            "gems": 5
          },
          "constructionXp": 90,
          "requiredKeepLevel": 2,
          "requiredRulerLevel": 25,
          "effects": {
            "dragonsPerWeek": 2
          }
        },
        {
          "level": 3,
          "cost": {
            "gold": 13000,
            "wood": 33,
            "stone": 44,
            "crystal": 15,
            "gems": 7
          },
          "constructionXp": 105,
          "requiredKeepLevel": 3,
          "requiredRulerLevel": 25,
          "effects": {
            "dragonsPerWeek": 3
          }
        }
      ]
    },
    "grailWonder": {
      "id": "grailWonder",
      "name": "Grail Wonder",
      "description": "One-time. +3,000 gold a day, +25% walking harvest, frontier can never be lost.",
      "unlockRulerLevel": 30,
      "maxLevel": 1,
      "startLevel": 0,
      "levels": [
        {
          "level": 1,
          "cost": {
            "gold": 30000,
            "wood": 200,
            "stone": 200,
            "crystal": 30,
            "gems": 15
          },
          "constructionXp": 75,
          "requiredKeepLevel": 1,
          "requiredRulerLevel": 30,
          "effects": {}
        }
      ]
    }
  },
  "mines": {
    "unlockRulerLevel": 3,
    "visitEveryDays": 7,
    "types": {
      "goldMine": {
        "id": "goldMine",
        "name": "Gold Mine",
        "produces": "gold",
        "maxLevel": 5,
        "levels": [
          {
            "level": 1,
            "cost": {
              "gold": 1050,
              "wood": 5,
              "stone": 6,
              "crystal": 0,
              "gems": 0
            },
            "constructionXp": 75,
            "requiredKeepLevel": 1,
            "requiredRulerLevel": 3,
            "outputPerDay": 200
          },
          {
            "level": 2,
            "cost": {
              "gold": 1400,
              "wood": 7,
              "stone": 8,
              "crystal": 0,
              "gems": 0
            },
            "constructionXp": 90,
            "requiredKeepLevel": 2,
            "requiredRulerLevel": 4,
            "outputPerDay": 300
          },
          {
            "level": 3,
            "cost": {
              "gold": 1900,
              "wood": 9,
              "stone": 11,
              "crystal": 0,
              "gems": 0
            },
            "constructionXp": 105,
            "requiredKeepLevel": 3,
            "requiredRulerLevel": 7,
            "outputPerDay": 400
          },
          {
            "level": 4,
            "cost": {
              "gold": 2600,
              "wood": 12,
              "stone": 15,
              "crystal": 2,
              "gems": 0
            },
            "constructionXp": 120,
            "requiredKeepLevel": 4,
            "requiredRulerLevel": 10,
            "outputPerDay": 500
          },
          {
            "level": 5,
            "cost": {
              "gold": 3500,
              "wood": 17,
              "stone": 20,
              "crystal": 2,
              "gems": 1
            },
            "constructionXp": 135,
            "requiredKeepLevel": 5,
            "requiredRulerLevel": 13,
            "outputPerDay": 600
          }
        ]
      },
      "quarry": {
        "id": "quarry",
        "name": "Quarry",
        "produces": "stone",
        "maxLevel": 5,
        "levels": [
          {
            "level": 1,
            "cost": {
              "gold": 700,
              "wood": 6,
              "stone": 0,
              "crystal": 0,
              "gems": 0
            },
            "constructionXp": 75,
            "requiredKeepLevel": 1,
            "requiredRulerLevel": 3,
            "outputPerDay": 3
          },
          {
            "level": 2,
            "cost": {
              "gold": 900,
              "wood": 8,
              "stone": 0,
              "crystal": 0,
              "gems": 0
            },
            "constructionXp": 90,
            "requiredKeepLevel": 2,
            "requiredRulerLevel": 4,
            "outputPerDay": 5
          },
          {
            "level": 3,
            "cost": {
              "gold": 1300,
              "wood": 11,
              "stone": 0,
              "crystal": 0,
              "gems": 0
            },
            "constructionXp": 105,
            "requiredKeepLevel": 3,
            "requiredRulerLevel": 7,
            "outputPerDay": 7
          },
          {
            "level": 4,
            "cost": {
              "gold": 1700,
              "wood": 15,
              "stone": 0,
              "crystal": 2,
              "gems": 0
            },
            "constructionXp": 120,
            "requiredKeepLevel": 4,
            "requiredRulerLevel": 10,
            "outputPerDay": 9
          },
          {
            "level": 5,
            "cost": {
              "gold": 2300,
              "wood": 20,
              "stone": 0,
              "crystal": 2,
              "gems": 1
            },
            "constructionXp": 135,
            "requiredKeepLevel": 5,
            "requiredRulerLevel": 13,
            "outputPerDay": 11
          }
        ]
      },
      "sawmill": {
        "id": "sawmill",
        "name": "Sawmill",
        "produces": "wood",
        "maxLevel": 5,
        "levels": [
          {
            "level": 1,
            "cost": {
              "gold": 700,
              "wood": 0,
              "stone": 6,
              "crystal": 0,
              "gems": 0
            },
            "constructionXp": 75,
            "requiredKeepLevel": 1,
            "requiredRulerLevel": 3,
            "outputPerDay": 3
          },
          {
            "level": 2,
            "cost": {
              "gold": 900,
              "wood": 0,
              "stone": 8,
              "crystal": 0,
              "gems": 0
            },
            "constructionXp": 90,
            "requiredKeepLevel": 2,
            "requiredRulerLevel": 4,
            "outputPerDay": 5
          },
          {
            "level": 3,
            "cost": {
              "gold": 1300,
              "wood": 0,
              "stone": 11,
              "crystal": 0,
              "gems": 0
            },
            "constructionXp": 105,
            "requiredKeepLevel": 3,
            "requiredRulerLevel": 7,
            "outputPerDay": 7
          },
          {
            "level": 4,
            "cost": {
              "gold": 1700,
              "wood": 0,
              "stone": 15,
              "crystal": 2,
              "gems": 0
            },
            "constructionXp": 120,
            "requiredKeepLevel": 4,
            "requiredRulerLevel": 10,
            "outputPerDay": 9
          },
          {
            "level": 5,
            "cost": {
              "gold": 2300,
              "wood": 0,
              "stone": 20,
              "crystal": 2,
              "gems": 1
            },
            "constructionXp": 135,
            "requiredKeepLevel": 5,
            "requiredRulerLevel": 13,
            "outputPerDay": 11
          }
        ]
      }
    }
  },
  "walking": {
    "walkStripM": 30,
    "bikeStripM": 10,
    "bikeKmFactor": 0.333333333333333,
    "usualRoutes": {
      "goldPerKm": 100,
      "perKmByTerrain": {
        "builtUp": {
          "stone": 5
        },
        "park": {
          "wood": 5
        },
        "waterside": {
          "crystal": 1
        },
        "hills": {}
      },
      "dailyCapKm": 5
    },
    "newGround": {
      "goldPerKm": 250,
      "perKmByTerrain": {
        "builtUp": {
          "stone": 10
        },
        "park": {
          "wood": 12
        },
        "waterside": {
          "crystal": 8
        },
        "hills": {
          "gems": 4
        }
      }
    },
    "boosterMultiplier": 2
  },
  "detours": {
    "rewards": {
      "common": {
        "gold": 600,
        "wood": 8,
        "stone": 8
      },
      "crystal": {
        "crystal": 3
      },
      "gem": {
        "gems": 1
      }
    },
    "crystalOfferShare": 0.35,
    "gemOfferShare": 0.1,
    "relicRumorsTavernLevel": 5
  },
  "placeCards": {
    "perNewGroundKm": {
      "common": 2,
      "uncommon": 0.5,
      "rare": 0.1,
      "epic": 0.02
    },
    "rewards": {
      "common": {
        "gold": 100
      },
      "uncommon": {
        "woodOrStone": 5
      },
      "rare": {
        "crystal": 2
      },
      "epic": {
        "gems": 2
      },
      "legendary": {
        "gems": 5
      }
    }
  },
  "units": {
    "pikeman": {
      "id": "pikeman",
      "name": "Pikeman",
      "building": "barracks",
      "buildingLevel": 1,
      "recruitsPerWeek": 14,
      "cost": {
        "gold": 60,
        "wood": 0,
        "stone": 0,
        "crystal": 0,
        "gems": 0
      },
      "power": 1
    },
    "archer": {
      "id": "archer",
      "name": "Archer",
      "building": "barracks",
      "buildingLevel": 3,
      "recruitsPerWeek": 9,
      "cost": {
        "gold": 150,
        "wood": 0,
        "stone": 0,
        "crystal": 0,
        "gems": 0
      },
      "power": 3
    },
    "knight": {
      "id": "knight",
      "name": "Knight",
      "building": "barracks",
      "buildingLevel": 5,
      "recruitsPerWeek": 5,
      "cost": {
        "gold": 400,
        "wood": 0,
        "stone": 0,
        "crystal": 0,
        "gems": 0
      },
      "power": 8
    },
    "battlemage": {
      "id": "battlemage",
      "name": "Battlemage",
      "building": "barracks",
      "buildingLevel": 7,
      "recruitsPerWeek": 3,
      "cost": {
        "gold": 700,
        "wood": 0,
        "stone": 0,
        "crystal": 1,
        "gems": 0
      },
      "power": 15
    },
    "dragon": {
      "id": "dragon",
      "name": "Dragon",
      "building": "dragonRoost",
      "buildingLevel": 1,
      "recruitsPerWeek": 1,
      "cost": {
        "gold": 3000,
        "wood": 0,
        "stone": 0,
        "crystal": 0,
        "gems": 2
      },
      "power": 60
    }
  },
  "recruitment": {
    "barracksBonusPerLevel": 0.25
  },
  "spells": {
    "lure": {
      "id": "lure",
      "name": "Lure",
      "mageGuildLevel": 1,
      "cost": {
        "gold": 0,
        "wood": 0,
        "stone": 0,
        "crystal": 2,
        "gems": 0
      },
      "limit": "Once a day",
      "effect": "Pull one detour reward up to 300 m closer to your route"
    },
    "scry": {
      "id": "scry",
      "name": "Scry",
      "mageGuildLevel": 2,
      "cost": {
        "gold": 0,
        "wood": 0,
        "stone": 0,
        "crystal": 1,
        "gems": 0
      },
      "limit": null,
      "effect": "Reveal what is inside a 500 m patch of Mist without claiming it"
    },
    "ward": {
      "id": "ward",
      "name": "Ward",
      "mageGuildLevel": 3,
      "cost": {
        "gold": 0,
        "wood": 0,
        "stone": 0,
        "crystal": 4,
        "gems": 1
      },
      "limit": null,
      "effect": "One district cannot lose land for 7 days (the vacation tool)"
    },
    "rally": {
      "id": "rally",
      "name": "Rally",
      "mageGuildLevel": 4,
      "cost": {
        "gold": 0,
        "wood": 0,
        "stone": 0,
        "crystal": 3,
        "gems": 0
      },
      "limit": null,
      "effect": "Army power bonus on your next siege (see Rally_Bonus on Inputs)"
    },
    "farSight": {
      "id": "farSight",
      "name": "Far Sight",
      "mageGuildLevel": 5,
      "cost": {
        "gold": 0,
        "wood": 0,
        "stone": 0,
        "crystal": 2,
        "gems": 0
      },
      "limit": null,
      "effect": "See tomorrow's detour offers tonight and choose them"
    }
  },
  "trading": {
    "levels": [
      {
        "level": 1,
        "freeTicketsPerWeek": 2,
        "buy3CrystalGold": 1200,
        "buy1GemGold": 1200,
        "swapGive": 20,
        "swapGet": 16,
        "sell20MaterialGold": 500,
        "sell1CrystalGold": 200,
        "sell1GemGold": 600,
        "weeklyCrystalLimit": 6,
        "weeklyGemLimit": 2
      },
      {
        "level": 2,
        "freeTicketsPerWeek": 2,
        "buy3CrystalGold": 1100,
        "buy1GemGold": 1100,
        "swapGive": 20,
        "swapGet": 17,
        "sell20MaterialGold": 540,
        "sell1CrystalGold": 220,
        "sell1GemGold": 650,
        "weeklyCrystalLimit": 6,
        "weeklyGemLimit": 2
      },
      {
        "level": 3,
        "freeTicketsPerWeek": 3,
        "buy3CrystalGold": 1010,
        "buy1GemGold": 1010,
        "swapGive": 20,
        "swapGet": 19,
        "sell20MaterialGold": 580,
        "sell1CrystalGold": 230,
        "sell1GemGold": 700,
        "weeklyCrystalLimit": 6,
        "weeklyGemLimit": 2
      },
      {
        "level": 4,
        "freeTicketsPerWeek": 3,
        "buy3CrystalGold": 910,
        "buy1GemGold": 910,
        "swapGive": 20,
        "swapGet": 19,
        "sell20MaterialGold": 620,
        "sell1CrystalGold": 250,
        "sell1GemGold": 740,
        "weeklyCrystalLimit": 6,
        "weeklyGemLimit": 2
      },
      {
        "level": 5,
        "freeTicketsPerWeek": 4,
        "buy3CrystalGold": 820,
        "buy1GemGold": 820,
        "swapGive": 20,
        "swapGet": 19,
        "sell20MaterialGold": 660,
        "sell1CrystalGold": 260,
        "sell1GemGold": 790,
        "weeklyCrystalLimit": 6,
        "weeklyGemLimit": 2
      }
    ]
  },
  "xp": {
    "usualRoutes": {
      "perKm": 15,
      "dailyCap": 75
    },
    "newGround": {
      "bands": [
        {
          "km": 3,
          "xpPerKm": 100
        },
        {
          "km": 3,
          "xpPerKm": 50
        },
        {
          "km": null,
          "xpPerKm": 20
        }
      ]
    },
    "detour": 75,
    "weeklyGoals": [
      {
        "km": 10,
        "xp": 100
      },
      {
        "km": 20,
        "xp": 100
      },
      {
        "km": 40,
        "xp": 150
      }
    ],
    "surgeHeld": 150,
    "surgePartlyHeld": 75,
    "bossDefeated": 600,
    "placeCards": {
      "common": 10,
      "uncommon": 25,
      "rare": 75,
      "epic": 200,
      "legendary": 500
    },
    "outpost": 300,
    "importMaxRulerLevel": 3,
    "rulerLevels": [
      {
        "level": 1,
        "xp": 0,
        "totalXp": 0
      },
      {
        "level": 2,
        "xp": 100,
        "totalXp": 100
      },
      {
        "level": 3,
        "xp": 250,
        "totalXp": 350
      },
      {
        "level": 4,
        "xp": 400,
        "totalXp": 750
      },
      {
        "level": 5,
        "xp": 600,
        "totalXp": 1350
      },
      {
        "level": 6,
        "xp": 700,
        "totalXp": 2050
      },
      {
        "level": 7,
        "xp": 800,
        "totalXp": 2850
      },
      {
        "level": 8,
        "xp": 900,
        "totalXp": 3750
      },
      {
        "level": 9,
        "xp": 1000,
        "totalXp": 4750
      },
      {
        "level": 10,
        "xp": 1100,
        "totalXp": 5850
      },
      {
        "level": 11,
        "xp": 1200,
        "totalXp": 7050
      },
      {
        "level": 12,
        "xp": 1300,
        "totalXp": 8350
      },
      {
        "level": 13,
        "xp": 1400,
        "totalXp": 9750
      },
      {
        "level": 14,
        "xp": 1500,
        "totalXp": 11250
      },
      {
        "level": 15,
        "xp": 1600,
        "totalXp": 12850
      },
      {
        "level": 16,
        "xp": 1700,
        "totalXp": 14550
      },
      {
        "level": 17,
        "xp": 1800,
        "totalXp": 16350
      },
      {
        "level": 18,
        "xp": 1900,
        "totalXp": 18250
      },
      {
        "level": 19,
        "xp": 2000,
        "totalXp": 20250
      },
      {
        "level": 20,
        "xp": 2100,
        "totalXp": 22350
      },
      {
        "level": 21,
        "xp": 2200,
        "totalXp": 24550
      },
      {
        "level": 22,
        "xp": 2300,
        "totalXp": 26850
      },
      {
        "level": 23,
        "xp": 2400,
        "totalXp": 29250
      },
      {
        "level": 24,
        "xp": 2500,
        "totalXp": 31750
      },
      {
        "level": 25,
        "xp": 2600,
        "totalXp": 34350
      },
      {
        "level": 26,
        "xp": 2700,
        "totalXp": 37050
      },
      {
        "level": 27,
        "xp": 2800,
        "totalXp": 39850
      },
      {
        "level": 28,
        "xp": 2900,
        "totalXp": 42750
      },
      {
        "level": 29,
        "xp": 3000,
        "totalXp": 45750
      },
      {
        "level": 30,
        "xp": 3100,
        "totalXp": 48850
      }
    ]
  },
  "mist": {
    "strengthPerFrontierKm": 10,
    "seasonPressure": {
      "start": 1,
      "end": 2
    },
    "fadedLand": {
      "afterDays": 30,
      "multiplier": 2
    },
    "landLossScale": 0.1,
    "maxLandLossPerWeek": 0.05,
    "garrisonLoss": {
      "held": 0.05,
      "brokeThrough": 0.2
    },
    "heldReward": {
      "gold": 500,
      "tickets": 1
    }
  },
  "seasons": {
    "weeks": 9,
    "bossHealth": [
      300,
      1200,
      2500
    ],
    "bossReward": {
      "gold": 5000,
      "crystal": 10,
      "gems": 5
    },
    "siegeUnitLoss": 0.15,
    "rallyBonus": 0.25
  }
};
