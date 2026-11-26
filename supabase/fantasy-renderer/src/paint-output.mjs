// Everything outside painter/, assets/ and src/page/ that decides what a painted tile looks like or what its
// label file says. src/fingerprint.mjs hashes this file, so keep anything else out of it: a change here
// starts a new tile version.

/** Chromium's flags. Software rendering only: the same Chromium build gives the same pixels on any machine. */
export const CHROMIUM_ARGS = ['--disable-gpu', '--use-angle=swiftshader'];

const HALF = 20037508.342789244;
const lngLat = (mx, my) => [
  Math.round(((mx / HALF) * 180) * 1e6) / 1e6,
  Math.round((Math.atan(Math.exp(my / 6378137)) * 2 - Math.PI / 2) * (180 / Math.PI) * 1e6) / 1e6,
];

/** The app's live labels for a tile, as its label file: [{ name, lng, lat, rot, water }]. */
export const labelJson = (labels) =>
  JSON.stringify(
    labels.map((L) => {
      const [lng, lat] = lngLat(L.wx, L.wy);
      return { name: L.name, lng, lat, rot: L.rot, water: L.water };
    }),
  );

/** A z15 tile's children, in the order the downsample draws them: NW, NE, SW, SE ([dx, dy] from x * 2, y * 2). */
export const Z15_CHILDREN = [[0, 0], [1, 0], [0, 1], [1, 1]];

/** A z15 tile's label file: its children's labels, in Z15_CHILDREN order (each child's as its label file text). */
export const z15LabelJson = (childLabelTexts) => JSON.stringify(childLabelTexts.flatMap((t) => JSON.parse(t)));

/**
 * The source data the painter reads. It asks the local server's TileJSON stand-in for tiles[0] and fills in
 * z/x/y (always z14); a source tile stored empty (missing upstream: open sea, the poles) answers this status,
 * which the painter reads as no data.
 */
export const ofmTileJson = (origin) => ({ tiles: [`${origin}/ofm/frozen/{z}/{x}/{y}.pbf`] });
export const MISSING_SOURCE_STATUS = 404;
