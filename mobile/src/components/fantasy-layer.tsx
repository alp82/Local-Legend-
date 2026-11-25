// The painted fantasy map: server-painted raster tiles (supabase/fantasy-renderer) drawn
// above the street map and under every game overlay. Where a tile isn't painted yet, the
// layer is empty there and the street map shows through, so a missing tile needs no code.
//
// Tiles exist at z15 and z16 (1024 px, shown at 512 to match the painter's 2x resolution).
// MapLibre picks the nearest tile zoom for raster sources, so z16 tiles cover zooms 15.5 to
// 16.5 and are stretched above that; z15 tiles cover 14.5 to 15.5. Below FANTASY_MIN_ZOOM
// the parchment layer covers everything, as it always has.
//
// Village names are painted into the tiles. Road and water names are live labels on the
// street map's own vector source ("openmaptiles" in the OpenFreeMap style), styled like the
// prototype's (supabase/fantasy-renderer/painter/styles.js) in the fonts that style serves.
import { Layer, LogManager, RasterSource } from '@maplibre/maplibre-react-native';
import { memo, useState } from 'react';

import { FANTASY_MIN_ZOOM } from '@/lib/fantasyTiles';

/**
 * Every layer goes under the parchment, the first game overlay, whenever it mounts: the
 * config arrives after the overlays are on the map. The names mount first and the raster goes
 * under them, also when a revision mounts it again.
 */
const BELOW = 'parchment-fill';
/** The street map style's vector source. */
const BASE_SOURCE = 'openmaptiles';
/** The roads the painter keeps and names (painter5.js). */
const NAMED_ROADS = ['trunk', 'primary', 'secondary', 'tertiary'];

// A tile that isn't painted yet answers 400 from Storage, which MapLibre logs as an error
// for every such tile. That is the expected fallback, not a fault.
LogManager.onLog(({ message }) => /for source fantasy\b/.test(message));

/** Mounts so far: each mount gets ids of its own (see the RasterSource comment). */
let mounts = 0;

export const FantasyLayer = memo(function FantasyLayer({
  tiles,
  revision,
  visible,
}: {
  tiles: string;
  revision: number;
  visible: boolean;
}) {
  const [m] = useState(() => ++mounts);
  const visibility = visible ? 'visible' : 'none';
  const waterNames = `fantasy-water-names-${m}`;
  return (
    <>
      <Layer
        type="symbol"
        id={waterNames}
        beforeId={BELOW}
        source={BASE_SOURCE}
        source-layer="waterway"
        minzoom={FANTASY_MIN_ZOOM}
        filter={['all', ['in', ['get', 'class'], ['literal', ['river', 'canal']]], ['has', 'name']]}
        layout={{
          visibility,
          'symbol-placement': 'line',
          'symbol-spacing': 600,
          'text-field': ['coalesce', ['get', 'name:latin'], ['get', 'name']],
          'text-font': ['Noto Sans Italic'],
          'text-size': 14,
          'text-letter-spacing': 0.15,
          'text-max-angle': 25,
        }}
        paint={{ 'text-color': '#24506e', 'text-halo-color': 'rgba(200,226,240,0.8)', 'text-halo-width': 1.2 }}
      />
      <Layer
        type="symbol"
        id={`fantasy-road-names-${m}`}
        beforeId={BELOW}
        source={BASE_SOURCE}
        source-layer="transportation_name"
        minzoom={FANTASY_MIN_ZOOM}
        filter={['in', ['get', 'class'], ['literal', NAMED_ROADS]]}
        layout={{
          visibility,
          'symbol-placement': 'line',
          'symbol-spacing': 600,
          'text-field': ['coalesce', ['get', 'name:latin'], ['get', 'name']],
          'text-font': ['Noto Sans Italic'],
          'text-size': ['interpolate', ['linear'], ['zoom'], 14.8, 12, 17, 15],
          'text-max-angle': 25,
        }}
        paint={{ 'text-color': '#4a3218', 'text-halo-color': 'rgba(236,226,190,0.85)', 'text-halo-width': 1.6 }}
      />
      {/* New ids on each mount and revision. MapLibre then asks again for tiles that were
          missing; a source mounted again under the same id keeps its failed tiles, or doesn't
          come back at all. Painted tiles come from MapLibre's cache. */}
      <RasterSource key={revision} id={`fantasy-${m}-${revision}`} tiles={[tiles]} tileSize={512} minzoom={15} maxzoom={16}>
        <Layer
          type="raster"
          id={`fantasy-raster-${m}-${revision}`}
          beforeId={waterNames}
          layout={{ visibility }}
          minzoom={FANTASY_MIN_ZOOM}
          paint={{ 'raster-fade-duration': 200, 'raster-resampling': 'linear' }}
        />
      </RasterSource>
    </>
  );
});
