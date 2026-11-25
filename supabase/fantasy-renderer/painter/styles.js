// PROTOTYPE, throwaway. Builds a complete MapLibre style JSON for one variant.
// Everything in here is plain style spec (would port to maplibre-react-native as a style
// object), except the GeoJSON sources `settlements`, `fields` and `links`, which app.js fills
// from client-side computation (density.js).
//
//   A  Painted land     : green painted land, painted water, forests, relief + peaks, no
//                         buildings, cobbled major roads, place labels as settlement icons.
//   B  Villages by density: no buildings; settlements computed from building density; built-up
//                         land becomes a patchwork of fields/orchards/meadows with hedgerows.
//   C  Hut scatter      : every building becomes a collision-thinned hut sprite; landuse is
//                         translated (park→grove, industrial→quarry, cemetery→barrows, …).
//
// roads: 'major' (motorway..secondary), 'links' (+ tertiary + computed paths between
// settlements), 'all' (every street and path).

import { C } from './sprites.js';

const BASE = new URL('.', import.meta.url).href;
// Where tiles come from. app.js switches these to serve.py's same-origin proxy when it runs,
// because EasyPrivacy blocks "||tiles.openfreemap.org/planet" (see serve.py).
export const NET = {
  ofm: 'https://tiles.openfreemap.org/',
  dem: 'https://elevation-tiles-prod.s3.amazonaws.com/terrarium/',
};
export const FONT = { sc: 'Fell SC', it: 'Fell Italic', rm: 'Fell Regular', bold: 'Almendra Bold' };

const MAJOR = ['motorway', 'trunk', 'primary', 'secondary'];
const MINOR = ['minor', 'service'];
const PATHS = ['path', 'track'];

const z = (...stops) => ['interpolate', ['linear'], ['zoom'], ...stops];
const classIn = (list) => ['in', ['get', 'class'], ['literal', list]];
const notTunnel = ['!=', ['coalesce', ['get', 'brunnel'], ''], 'tunnel'];
const isLine = ['==', ['geometry-type'], 'LineString'];
const isPoly = ['==', ['geometry-type'], 'Polygon'];
const NAME = ['coalesce', ['get', 'name:latin'], ['get', 'name']];

export function buildStyle(variant, roads) {
  const L = [];
  const add = (l) => L.push(l);

  // ------------------------------------------------------------------ land
  add({ id: 'land', type: 'background', paint: { 'background-pattern': 'p_grass' } });
  // Atlas wash: as you zoom out the painted land drifts toward parchment.
  add({ id: 'atlas-wash', type: 'background', paint: { 'background-pattern': 'p_parchment', 'background-opacity': z(9, 0.55, 12, 0.35, 13.5, 0) } });

  // landuse translation
  const lu = (id, classes, paint, extra = {}) => add({ id, type: 'fill', source: 'omt', 'source-layer': 'landuse', filter: classIn(classes), paint, ...extra });
  if (variant === 'A') {
    lu('lu-settled', ['residential', 'suburb', 'quarter', 'neighbourhood', 'commercial', 'retail', 'industrial'], { 'fill-color': '#b7b866', 'fill-opacity': z(10, 0.35, 14, 0.18) });
    lu('lu-cemetery', ['cemetery'], { 'fill-pattern': 'p_grove' });
  } else if (variant === 'C') {
    lu('lu-settled', ['residential', 'suburb', 'quarter', 'neighbourhood'], { 'fill-color': '#b9b46a', 'fill-opacity': z(10, 0.45, 14, 0.4) });
    lu('lu-market', ['commercial', 'retail'], { 'fill-pattern': 'p_market', 'fill-opacity': 0.55 }, { minzoom: 12 });
    lu('lu-quarry', ['industrial', 'garages', 'quarry', 'dam'], { 'fill-pattern': 'p_quarry', 'fill-opacity': 0.85 }, { minzoom: 12 });
    lu('lu-barrows', ['cemetery'], { 'fill-pattern': 'p_barrows' });
    lu('lu-cloister', ['school', 'university', 'college', 'hospital', 'kindergarten', 'library', 'military'], { 'fill-pattern': 'p_flagstone', 'fill-opacity': 0.7 }, { minzoom: 13 });
    lu('lu-tourney', ['stadium', 'pitch', 'playground', 'track'], { 'fill-pattern': 'p_tourney', 'fill-opacity': 0.8 }, { minzoom: 13 });
  } else {
    lu('lu-cemetery', ['cemetery'], { 'fill-pattern': 'p_orchard' });
  }

  // landcover (shared)
  const lc = (id, filter, paint, extra = {}) => add({ id, type: 'fill', source: 'omt', 'source-layer': 'landcover', filter, paint, ...extra });
  const sub = (list) => ['in', ['get', 'subclass'], ['literal', list]];
  lc('lc-farmland', ['all', ['==', ['get', 'class'], 'farmland'], ['!', sub(['orchard', 'vineyard'])]], {
    'fill-pattern': ['match', ['%', ['to-number', ['id'], 0], 3], 0, 'p_field_0', 1, 'p_field_1', 'p_field_2'],
    'fill-opacity': z(9, 0.5, 13, 0.85),
  });
  lc('lc-orchard', sub(['orchard', 'vineyard']), { 'fill-pattern': 'p_orchard' });
  lc('lc-grass', ['==', ['get', 'class'], 'grass'], { 'fill-pattern': 'p_meadow', 'fill-opacity': 0.8 });
  lc('lc-wetland', ['==', ['get', 'class'], 'wetland'], { 'fill-pattern': 'p_marsh', 'fill-opacity': 0.85 });
  lc('lc-sand', ['==', ['get', 'class'], 'sand'], { 'fill-pattern': 'p_sand' });
  lc('lc-rock', ['==', ['get', 'class'], 'rock'], { 'fill-pattern': 'p_rock', 'fill-opacity': 0.75 });
  lc('lc-ice', ['==', ['get', 'class'], 'ice'], { 'fill-pattern': 'p_snow' });
  lc('lc-wood', ['==', ['get', 'class'], 'wood'], { 'fill-pattern': 'p_forest' });
  lc('lc-wood-edge', ['==', ['get', 'class'], 'wood'], { 'fill-color': 'rgba(0,0,0,0)', 'fill-outline-color': 'rgba(40,60,20,0.6)' });

  add({ id: 'park', type: 'fill', source: 'omt', 'source-layer': 'park', filter: ['==', ['get', 'class'], 'park'], paint: { 'fill-pattern': 'p_grove' } });

  if (variant === 'B') {
    // Generated patches (world.js) over the real landcover, which only shows until they arrive.
    add({ id: 'w-cells', type: 'fill', source: 'cells', paint: { 'fill-pattern': ['get', 'tex'], 'fill-opacity': z(10, 0.62, 12.5, 0.85, 13.5, 1) } });
    add({ id: 'w-tint', type: 'fill', source: 'cells', paint: { 'fill-color': ['get', 'tint'], 'fill-opacity': ['get', 'ta'] } });
    add({ id: 'w-hedge', type: 'line', source: 'borders', minzoom: 12.5, filter: ['==', ['get', 'kind'], 'hedge'], layout: { 'line-cap': 'round' }, paint: { 'line-color': '#3e6a29', 'line-width': z(12.5, 0.5, 15, 2, 17, 3.6), 'line-opacity': 0.85 } });
    add({ id: 'w-stonewall', type: 'line', source: 'borders', minzoom: 12.5, filter: ['==', ['get', 'kind'], 'wall'], paint: { 'line-color': '#8f8572', 'line-width': z(12.5, 0.5, 15, 1.6, 17, 2.6), 'line-dasharray': [2, 0.8] } });
    add({ id: 'w-fence', type: 'line', source: 'borders', minzoom: 13, filter: ['==', ['get', 'kind'], 'fence'], paint: { 'line-color': '#7a5a34', 'line-width': z(13, 0.4, 15, 1, 17, 1.8), 'line-dasharray': [1.5, 1] } });
  }

  // ------------------------------------------------------------------ relief
  if (variant === 'A' || variant === 'B') {
    add({
      id: 'relief-tint', type: 'color-relief', source: 'dem',
      paint: {
        'color-relief-color': ['interpolate', ['linear'], ['elevation'],
          0, 'rgba(0,0,0,0)', 900, 'rgba(0,0,0,0)', 1400, 'rgba(150,140,105,0.35)', 2000, 'rgba(165,155,135,0.6)', 2500, 'rgba(235,236,240,0.85)', 3500, 'rgba(250,250,252,0.95)'],
        'color-relief-opacity': 1,
      },
    });
  }
  add({
    id: 'hillshade', type: 'hillshade', source: 'dem',
    paint: {
      'hillshade-method': 'combined',
      'hillshade-exaggeration': variant === 'A' ? 0.8 : 0.5,
      'hillshade-shadow-color': '#4a3826',
      'hillshade-highlight-color': '#fff4d2',
      'hillshade-accent-color': '#6b5434',
      'hillshade-illumination-direction': 315,
    },
  });

  // ------------------------------------------------------------------ water
  const big = (a, b) => ['match', ['get', 'class'], ['river', 'canal'], a, b];
  add({ id: 'water', type: 'fill', source: 'omt', 'source-layer': 'water', filter: ['!=', ['get', 'brunnel'], 'tunnel'], paint: { 'fill-pattern': 'p_water' } });
  add({ id: 'water-shallows', type: 'line', source: 'omt', 'source-layer': 'water', paint: { 'line-color': C.waterLight, 'line-width': z(10, 2, 15, 6), 'line-blur': z(10, 2, 15, 5), 'line-opacity': 0.8 } });
  add({ id: 'water-shore', type: 'line', source: 'omt', 'source-layer': 'water', paint: { 'line-color': '#2f5e7d', 'line-width': z(10, 0.6, 15, 1.4), 'line-opacity': 0.85 } });
  add({ id: 'waterway-bank', type: 'line', source: 'omt', 'source-layer': 'waterway', filter: notTunnel, layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: { 'line-color': '#2f5e7d', 'line-width': z(9, big(1.8, 0), 12, big(3.4, 0.8), 13, big(4, 1.2), 16, big(10, 3.4)) } });
  add({ id: 'waterway', type: 'line', source: 'omt', 'source-layer': 'waterway', filter: notTunnel, layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: { 'line-color': C.water, 'line-width': z(9, big(1, 0), 12, big(2.3, 0.4), 13, big(2.8, 0.7), 16, big(8, 2.2)) } });

  // ------------------------------------------------------------------ roads
  const road = (id, classes, look, extra = {}) => {
    const f = ['all', isLine, notTunnel, ['!=', ['coalesce', ['get', 'brunnel'], ''], 'bridge'], classIn(classes)];
    for (const l of look) add({ id: `${id}-${l.k}`, type: 'line', source: 'omt', 'source-layer': 'transportation', filter: f, layout: { 'line-cap': 'round', 'line-join': 'round' }, ...l.s, ...extra });
  };
  const S_MAJOR = [9, 1.2, 12, 2.4, 14, 5, 16, 11, 18, 22];
  const S_TERT = [12, 1, 14, 3, 16, 7, 18, 14];
  const S_MINOR = [13, 0.8, 15, 2.6, 17, 6, 18, 9];
  const W_MAJOR = z(...S_MAJOR), W_TERT = z(...S_TERT), W_MINOR = z(...S_MINOR);
  const plus = (stops, d) => z(...stops.map((v, i) => (i % 2 ? v + d : v)));
  // Far zoom: a single inked "king's road" line; patterns only once they have room.
  const kingsRoad = { k: 'far', s: { maxzoom: 12.5, paint: { 'line-color': '#7b5530', 'line-width': z(8, 0.8, 12, 1.8), 'line-dasharray': [3, 1.5], 'line-opacity': 0.85 } } };
  const cobble = (w) => ({ k: 'cobble', s: { minzoom: 12, paint: { 'line-pattern': 'l_cobble', 'line-width': w } } });
  const cart = (w) => ({ k: 'cart', s: { minzoom: 12, paint: { 'line-pattern': 'l_cart', 'line-width': w } } });
  const dirtPath = (w, op = 1) => ({ k: 'dirt', s: { minzoom: 13, paint: { 'line-color': C.dirt, 'line-width': w, 'line-opacity': op } } });
  const dirtEdge = (stops, op = 1) => ({ k: 'edge', s: { minzoom: 13, paint: { 'line-color': '#8d6a3c', 'line-width': plus(stops, 1.4), 'line-opacity': op * 0.7, 'line-blur': 0.8 } } });
  const faintTrail = (w) => ({ k: 'trail', s: { minzoom: 13, paint: { 'line-color': '#9a7444', 'line-width': w, 'line-opacity': 0.45, 'line-dasharray': [2, 1.2] } } });
  const dotted = { k: 'dots', s: { minzoom: 14, paint: { 'line-color': '#7d5a32', 'line-width': z(14, 1, 17, 2.2), 'line-dasharray': [0.6, 1.6], 'line-opacity': 0.8 } } };

  if (roads === 'all') {
    if (variant === 'A') {
      road('r-minor', MINOR, [faintTrail(W_MINOR)]);
    } else {
      road('r-minor', MINOR, [dirtEdge(S_MINOR, 0.85), dirtPath(W_MINOR, 0.95)]);
    }
    road('r-path', PATHS, [dotted]);
  }
  if (roads !== 'major') {
    // computed links between settlements, then tertiary roads
    const S_LINK = [13, 1.4, 15, 3.6, 17, 7, 18, 10];
    add({ id: 'links-edge', type: 'line', source: 'links', minzoom: 13, layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: { 'line-color': '#6e4f2a', 'line-width': plus(S_LINK, 2), 'line-opacity': 0.75, 'line-blur': 0.6 } });
    add({ id: 'links', type: 'line', source: 'links', minzoom: 13, layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: { 'line-color': '#d9b77c', 'line-width': z(...S_LINK) } });
    road('r-tert', ['tertiary'], variant === 'A' ? [cobble(W_TERT)] : [cart(W_TERT)], { minzoom: 13 });
  }
  // Far zoom keeps only the trunk network; secondary roads join at z12.
  const majorLook = variant === 'C' ? [kingsRoad, cart(W_MAJOR)] : [kingsRoad, cobble(W_MAJOR)];
  road('r-sec', ['secondary'], majorLook, { minzoom: 12 });
  road('r-major', ['motorway', 'trunk', 'primary'], majorLook);

  // Bridges always survive: water is the one obstacle you can't just walk across.
  add({
    id: 'bridges', type: 'line', source: 'omt', 'source-layer': 'transportation', minzoom: 13,
    filter: ['all', isLine, ['==', ['get', 'brunnel'], 'bridge'], ['!', classIn(['rail', 'transit'])],
      roads === 'major' ? ['!', classIn(['tertiary'])] : true],
    layout: { 'line-cap': 'butt' },
    paint: { 'line-pattern': variant === 'A' ? 'l_cobble' : 'l_planks', 'line-width': z(13, ['match', ['get', 'class'], MAJOR, 4, 2], 15, ['match', ['get', 'class'], MAJOR, 8, 5], 17, ['match', ['get', 'class'], MAJOR, 16, 9]) },
  });

  if (variant === 'B') {
    add({ id: 'w-quays', type: 'line', source: 'quays', minzoom: 13.5, layout: { 'line-cap': 'butt' }, paint: { 'line-pattern': 'l_quay', 'line-width': z(13.5, 1.2, 15, 2.4, 17, 5) } });
    add({ id: 'w-walls', type: 'line', source: 'walls', minzoom: 13, layout: { 'line-join': 'round', 'line-cap': 'round' }, paint: { 'line-pattern': 'l_wall', 'line-width': z(13, 4, 15, 10, 17, 18) } });
    add({
      id: 'w-scatter', type: 'symbol', source: 'scatter', minzoom: 13.6,
      layout: {
        'icon-image': ['get', 'icon'], 'icon-anchor': 'bottom', 'icon-allow-overlap': true, 'icon-ignore-placement': true, 'symbol-z-order': 'viewport-y',
        'icon-size': ['interpolate', ['linear'], ['zoom'], 13.6, ['*', 0.62, ['get', 's']], 15.5, ['*', 1.05, ['get', 's']], 17, ['*', 1.6, ['get', 's']], 18, ['*', 2.1, ['get', 's']]],
      },
    });
    add({
      id: 'w-marks', type: 'symbol', source: 'marks', minzoom: 13.6,
      layout: { 'icon-image': ['get', 'icon'], 'icon-anchor': 'bottom', 'icon-allow-overlap': true, 'icon-ignore-placement': true, 'symbol-z-order': 'viewport-y', 'icon-size': z(13.6, 0.55, 15.5, 0.85, 17, 1.25) },
    });
    // Real points of interest as landmarks of the realm, thinned by collision.
    const POI = ['match', ['get', 'class'],
      'place_of_worship', 'lm_shrine', 'railway', 'lm_inn', ['bar', 'beer', 'pub'], 'lm_inn',
      ['museum', 'monument', 'attraction', 'archaeological_site', 'memorial'], ['case', ['==', ['%', ['to-number', ['id'], 0], 2], 0], 'lm_ruins', 'lm_stones'],
      'castle', 'lm_watchtower', ['college', 'university'], ['case', ['==', ['%', ['to-number', ['id'], 0], 2], 0], 'lm_magetower', 'lm_monastery'],
      ['school', 'library'], 'lm_monastery', 'hospital', 'lm_healer', 'stadium', 'lm_tourney',
      ['town_hall', 'theatre', 'cinema'], 'lm_guildhall', ['police', 'fire_station'], 'lm_watchtower',
      ['harbor', 'ferry_terminal'], 'lm_dockcrane', 'fountain', 'lm_well', ''];
    add({
      id: 'poi-marks', type: 'symbol', source: 'omt', 'source-layer': 'poi', minzoom: 14.2,
      filter: ['!=', POI, ''],
      layout: {
        'icon-image': POI, 'icon-anchor': 'bottom', 'icon-size': z(14.2, 0.7, 15.5, 0.95, 17, 1.35), 'icon-padding': 6,
        'symbol-sort-key': ['coalesce', ['get', 'rank'], 50],
        'text-field': ['step', ['zoom'], '', 16, NAME], 'text-font': [FONT.it], 'text-size': 11, 'text-anchor': 'top', 'text-optional': true, 'text-max-width': 8,
      },
      paint: { 'text-color': '#4e3418', 'text-halo-color': 'rgba(240,226,186,0.9)', 'text-halo-width': 1.2 },
    });
  }

  // ------------------------------------------------------------------ buildings → huts (C)
  if (variant === 'C') {
    add({
      id: 'huts', type: 'symbol', source: 'omt', 'source-layer': 'building', minzoom: 13,
      layout: {
        'icon-image': ['case', ['all', ['>=', ['coalesce', ['get', 'render_height'], 0], 30], ['==', ['%', ['to-number', ['id'], 0], 3], 0]], 'manor',
          ['concat', 'hut_', ['to-string', ['%', ['to-number', ['id'], 0], 4]]]],
        'icon-size': z(13, 0.55, 15, 0.95, 16, 1.15, 17, 1.45, 18, 1.8),
        'icon-padding': z(13, 3, 15, 1, 17, 0),
        'icon-allow-overlap': false,
        'symbol-sort-key': ['-', 0, ['coalesce', ['get', 'render_height'], 0]],
        'symbol-z-order': 'viewport-y',
        'icon-anchor': 'bottom',
      },
    });
    const lui = (id, classes, icon) => add({ id, type: 'symbol', source: 'omt', 'source-layer': 'landuse', minzoom: 14, filter: ['all', isPoly, classIn(classes)], layout: { 'icon-image': icon, 'icon-size': 0.9 } });
    lui('ico-barrow', ['cemetery'], 'i_barrow');
    lui('ico-smithy', ['industrial'], 'i_anvil');
    lui('ico-market', ['commercial', 'retail'], 'i_tent');
  }

  // ------------------------------------------------------------------ peaks
  add({
    id: 'peaks', type: 'symbol', source: 'omt', 'source-layer': 'mountain_peak', filter: ['all', classIn(['peak', 'volcano']), ['>=', ['coalesce', ['get', 'ele'], 0], 400]],
    layout: {
      'icon-image': ['case', ['>=', ['coalesce', ['get', 'ele'], 0], 2000], 'peak_big', 'peak'],
      'icon-anchor': 'bottom', 'icon-size': z(9, 0.6, 13, 0.9),
      'text-field': ['step', ['zoom'], '', 11, ['concat', NAME, '\n', ['to-string', ['coalesce', ['get', 'ele'], '']]]],
      'text-font': [FONT.it], 'text-size': 12, 'text-anchor': 'top', 'text-offset': [0, 0.2], 'text-optional': true,
      'symbol-sort-key': ['get', 'rank'],
    },
    paint: { 'text-color': '#4a3826', 'text-halo-color': 'rgba(240,228,190,0.85)', 'text-halo-width': 1.4 },
  });

  // ------------------------------------------------------------------ settlements
  const placeClasses = ['city', 'town', 'village', 'hamlet', 'suburb', 'quarter', 'neighbourhood', 'isolated_dwelling'];
  const placeIcon = ['match', ['get', 'class'],
    'city', 'settle_4', 'town', 'settle_3', 'village', 'settle_2', 'suburb', 'settle_2', 'quarter', 'settle_2',
    'hamlet', 'settle_1', 'neighbourhood', 'settle_1', 'settle_0'];
  const placeSize = ['match', ['get', 'class'], 'city', 22, 'town', 17, ['village', 'suburb'], 15, 13];
  const labelPaint = { 'text-color': C.ink, 'text-halo-color': 'rgba(244,232,196,0.9)', 'text-halo-width': 1.6, 'text-halo-blur': 0.5 };

  if (variant === 'B') {
    add({
      id: 'settlements', type: 'symbol', source: 'settlements',
      layout: {
        // Once walls and houses are drawn (z13.6+), a walled town's centre is its church and keep.
        // Three random layouts per tier (sprites2.js); the castle (tier 4) is unique. Once walls and
        // houses are drawn (z13.6+), a walled town's centre is a village-sized church cluster.
        'icon-image': ['step', ['zoom'],
          ['case', ['>=', ['get', 'tier'], 4], 'settle_4', ['concat', 'settle_', ['to-string', ['get', 'tier']], '_', ['to-string', ['get', 'v']]]], 13.6,
          ['case', ['>=', ['get', 'tier'], 3], ['concat', 'settle_2_', ['to-string', ['get', 'v']]], ['concat', 'settle_', ['to-string', ['get', 'tier']], '_', ['to-string', ['get', 'v']]]],
          14.5, ''],
        'icon-size': z(10, 0.6, 13, 0.8, 15, 1.15, 17, 1.6),
        'icon-anchor': 'bottom', 'icon-allow-overlap': ['step', ['zoom'], false, 14.5, true], 'icon-padding': 2,
        'symbol-sort-key': ['-', 10, ['get', 'tier']], 'symbol-z-order': 'viewport-y',
        'text-field': ['coalesce', ['get', 'name'], ''], 'text-font': [FONT.sc],
        'text-size': ['interpolate', ['linear'], ['zoom'], 14, ['match', ['get', 'tier'], 4, 20, 3, 17, 2, 15, 13], 16, ['match', ['get', 'tier'], 4, 24, 3, 22, 2, 19, 16]],
        'text-anchor': 'top', 'text-offset': [0, 0.2], 'text-optional': true, 'text-max-width': 9,
      },
      paint: labelPaint,
    });
    // Big-picture region names at far zoom.
    add({
      id: 'region-label', type: 'symbol', source: 'omt', 'source-layer': 'place', maxzoom: 12.5, filter: classIn(['city', 'state']),
      layout: { 'text-field': ['upcase', NAME], 'text-font': [FONT.sc], 'text-size': z(8, 18, 12, 28), 'text-letter-spacing': 0.35, 'text-anchor': 'bottom', 'text-offset': [0, -2.6] },
      paint: { 'text-color': 'rgba(61,43,31,0.75)', 'text-halo-color': 'rgba(244,232,196,0.6)', 'text-halo-width': 2 },
    });
  } else {
    add({
      id: 'places', type: 'symbol', source: 'omt', 'source-layer': 'place', filter: classIn(placeClasses),
      layout: {
        'icon-image': variant === 'C' ? ['step', ['zoom'], placeIcon, 14, ''] : placeIcon,
        'icon-size': z(9, 0.55, 13, 0.8, 16, 1.15),
        'icon-anchor': 'bottom', 'icon-optional': true,
        'symbol-sort-key': ['coalesce', ['get', 'rank'], 30],
        'text-field': NAME, 'text-font': [FONT.sc], 'text-size': placeSize,
        'text-anchor': 'top', 'text-offset': [0, 0.2], 'text-max-width': 9,
      },
      paint: labelPaint,
    });
  }

  // ------------------------------------------------------------------ other labels
  for (const [id, f, placement] of [['water-label', ['!', isLine], 'point'], ['water-label-line', isLine, 'line']]) {
    add({
      id, type: 'symbol', source: 'omt', 'source-layer': 'water_name', filter: f, ...(variant === 'B' ? { maxzoom: 14.8 } : {}),
      layout: { 'text-field': NAME, 'text-font': [FONT.it], 'text-size': 15, 'text-letter-spacing': 0.15, 'symbol-placement': placement },
      paint: { 'text-color': '#24506e', 'text-halo-color': 'rgba(200,226,240,0.8)', 'text-halo-width': 1.2 },
    });
  }
  add({
    id: 'river-label', type: 'symbol', source: 'omt', 'source-layer': 'waterway', minzoom: 12, ...(variant === 'B' ? { maxzoom: 14.8 } : {}), filter: classIn(['river', 'canal']),
    layout: { 'text-field': NAME, 'text-font': [FONT.it], 'text-size': 14, 'text-letter-spacing': 0.2, 'symbol-placement': 'line', 'symbol-spacing': variant === 'B' ? 1200 : 400, 'text-padding': variant === 'B' ? 60 : 2 },
    paint: { 'text-color': '#24506e', 'text-halo-color': 'rgba(200,226,240,0.8)', 'text-halo-width': 1.2 },
  });
  const namedRoads = roads === 'all' ? [...MAJOR, 'tertiary', ...MINOR] : roads === 'links' ? [...MAJOR, 'tertiary'] : MAJOR;
  if (variant === 'B' && false) {
    // (round 7: at walking zoom the painter places road and canal names itself, never cut by the edge)
    add({
      id: 'road-label-main', type: 'symbol', source: 'omt', 'source-layer': 'transportation_name', minzoom: 14.8, filter: classIn(['motorway', 'trunk', 'primary']),
      layout: { 'text-field': NAME, 'text-font': [FONT.it], 'text-size': z(14.8, 13, 17, 16), 'symbol-placement': 'line', 'symbol-spacing': 600, 'text-max-angle': 25 },
      paint: { 'text-color': '#4a3218', 'text-halo-color': 'rgba(236,226,190,0.85)', 'text-halo-width': 1.6 },
    });
  }
  add({
    id: 'road-label', type: 'symbol', source: 'omt', 'source-layer': 'transportation_name', minzoom: 14.5, ...(variant === 'B' ? { maxzoom: 14.8 } : {}), filter: classIn(namedRoads),
    layout: { 'text-field': NAME, 'text-font': [FONT.it], 'text-size': z(14.5, 11, 17, 14), 'symbol-placement': 'line', 'text-max-angle': 30 },
    paint: { 'text-color': '#4e3418', 'text-halo-color': 'rgba(240,226,186,0.9)', 'text-halo-width': 1.4 },
  });

  return {
    version: 8,
    name: `fantasy-${variant}-${roads}`,
    glyphs: `${NET.ofm}fonts/{fontstack}/{range}.pbf`,
    'font-faces': {
      [FONT.sc]: `${BASE}fonts/IMFeENsc28P.ttf`,
      [FONT.it]: `${BASE}fonts/IMFeENit28P.ttf`,
      [FONT.rm]: `${BASE}fonts/IMFeENrm28P.ttf`,
      [FONT.bold]: `${BASE}fonts/Almendra-Bold.ttf`,
    },
    sources: {
      omt: { type: 'vector', url: `${NET.ofm}planet` },
      dem: { type: 'raster-dem', tiles: [`${NET.dem}{z}/{x}/{y}.png`], encoding: 'terrarium', tileSize: 256, maxzoom: 14, attribution: 'Terrain: Mapzen/AWS Terrain Tiles' },
      settlements: { type: 'geojson', data: EMPTY },
      fields: { type: 'geojson', data: EMPTY },
      cells: { type: 'geojson', data: EMPTY, tolerance: 0.2 },
      borders: { type: 'geojson', data: EMPTY },
      scatter: { type: 'geojson', data: EMPTY },
      marks: { type: 'geojson', data: EMPTY },
      walls: { type: 'geojson', data: EMPTY },
      quays: { type: 'geojson', data: EMPTY },
      links: { type: 'geojson', data: EMPTY },
    },
    layers: L,
  };
}

export const EMPTY = { type: 'FeatureCollection', features: [] };
