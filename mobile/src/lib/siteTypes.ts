// The one table that maps a site subtype to its map icon, color and label.
// scripts/generate-overlay-icons.mjs reads it (with Node's type stripping) to draw the
// placeholder PNGs in assets/overlays/, so keep this file free of imports and of
// non-erasable TypeScript (no enums or namespaces).
// After changing icons, shapes, colors or glyphs: `node scripts/generate-overlay-icons.mjs`.

export type IconShape = 'circle' | 'square';

export type SiteType = {
  /** Image name in the map style; also the PNG file name in assets/overlays/. */
  icon: string;
  /** Shown on the tap card. */
  label: string;
  /** Badge fill color. */
  color: string;
  /** Places are circles, mines are squares. */
  shape: IconShape;
  /** 9x9 pictogram drawn on the badge, '#' = ink. */
  glyph: string[];
  /** Pictogram color, white unless the fill is too light. */
  ink?: string;
};

const PEAK = ['.........', '.........', '....#....', '...###...', '..#####..', '.#######.', '#########', '.........', '.........'];
const BRUSH = ['......##.', '.....###.', '....###..', '...###...', '..###....', '.##......', '###......', '##.......', '.........'];
const TEMPLE = ['....#....', '..#####..', '#########', '.#.#.#.#.', '.#.#.#.#.', '.#.#.#.#.', '.#.#.#.#.', '#########', '.........'];
const OBELISK = ['....#....', '...###...', '...###...', '...###...', '...###...', '...###...', '..#####..', '.#######.', '.........'];
const STEPS = ['.......##', '.......##', '.....####', '.....####', '...######', '...######', '.########', '.########', '.........'];
const CUP = ['..#..#...', '.#..#....', '.........', '#######..', '#######.#', '#######.#', '.#####.#.', '..###....', '.........'];
const FOUNTAIN = ['....#....', '..#.#.#..', '.#..#..#.', '....#....', '.#######.', '#########', '.#######.', '.........', '.........'];
const STAR = ['....#....', '....#....', '...###...', '#########', '.#######.', '..#####..', '..##.##..', '.##...##.', '.........'];
const TREE = ['....#....', '...###...', '..#####..', '...###...', '..#####..', '.#######.', '#########', '....#....', '....#....'];
const ROCKS = ['.........', '.........', '...###...', '..#####..', '.###.###.', '#####.###', '#########', '.........', '.........'];
const GEM = ['.........', '..#####..', '.#.#.#.#.', '#########', '.#######.', '..#####..', '...###...', '....#....', '.........'];
const PICK = ['.#######.', '#...#...#', '....#....', '....#....', '....#....', '....#....', '....#....', '....#....', '.........'];

/** Known subtypes. Unknown ones fall back to FALLBACK by kind. */
export const SITE_TYPES: Record<string, SiteType> = {
  viewpoint: { icon: 'site-viewpoint', label: 'Viewpoint', color: '#0f8b8d', shape: 'circle', glyph: PEAK },
  artwork: { icon: 'site-artwork', label: 'Artwork', color: '#c2185b', shape: 'circle', glyph: BRUSH },
  mural: { icon: 'site-artwork', label: 'Mural', color: '#c2185b', shape: 'circle', glyph: BRUSH },
  historic: { icon: 'site-historic', label: 'Historic site', color: '#8d5524', shape: 'circle', glyph: TEMPLE },
  monument: { icon: 'site-monument', label: 'Monument', color: '#546e7a', shape: 'circle', glyph: OBELISK },
  staircase: { icon: 'site-staircase', label: 'Staircase', color: '#5c6bc0', shape: 'circle', glyph: STEPS },
  cafe: { icon: 'site-cafe', label: 'Café', color: '#ef6c00', shape: 'circle', glyph: CUP },
  fountain: { icon: 'site-fountain', label: 'Fountain', color: '#1e88e5', shape: 'circle', glyph: FOUNTAIN },
  sawmill: { icon: 'site-sawmill', label: 'Sawmill', color: '#2e7d32', shape: 'square', glyph: TREE },
  quarry: { icon: 'site-quarry', label: 'Quarry', color: '#757575', shape: 'square', glyph: ROCKS },
  gold_mine: { icon: 'site-gold-mine', label: 'Gold mine', color: '#f9a825', shape: 'square', glyph: GEM, ink: '#3e2723' },
};

export const FALLBACK: Record<'place' | 'mine', SiteType> = {
  place: { icon: 'site-place', label: 'Place', color: '#7e57c2', shape: 'circle', glyph: STAR },
  mine: { icon: 'site-mine', label: 'Mine', color: '#455a64', shape: 'square', glyph: PICK },
};

export function siteType(kind: 'place' | 'mine', subtype: string): SiteType {
  const known = SITE_TYPES[subtype];
  return known && (known.shape === 'square') === (kind === 'mine') ? known : FALLBACK[kind];
}

/** Every distinct icon, for the generator and the map's image registry. */
export function allSiteIcons(): SiteType[] {
  const byIcon = new Map<string, SiteType>();
  for (const t of [...Object.values(SITE_TYPES), ...Object.values(FALLBACK)]) byIcon.set(t.icon, t);
  return [...byIcon.values()];
}
