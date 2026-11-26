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
