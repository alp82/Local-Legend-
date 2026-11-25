// The painted fantasy map: server-painted raster tiles (supabase/fantasy-renderer) drawn
// above the street map and under every game overlay. Where a tile isn't painted yet, the
// layer is empty there and the street map shows through, so a missing tile needs no code.
//
// Tiles exist at z15 and z16 (1024 px, shown at 512 to match the painter's 2x resolution).
// MapLibre picks the nearest tile zoom for raster sources, so z16 tiles cover zooms 15.5 to
// 16.5 and are stretched above that; z15 tiles cover 14.5 to 15.5. Below FANTASY_MIN_ZOOM
// the parchment layer covers everything, as it always has.
//
// Village names are painted into the tiles. Road and water names are live labels from each
// tile's label file: the painter places them at fixed spots, only on roads it drew and on
// rivers and canals, turned with the line. MapLibre hides the ones that collide. They're
// styled like the prototype's (lm-names in its app.js) in the italic the street map's font
// server has.
import { GeoJSONSource, Layer, LogManager, RasterSource } from '@maplibre/maplibre-react-native';
import { memo, useState } from 'react';

import { FANTASY_MIN_ZOOM } from '@/lib/fantasyTiles';

/**
 * Every layer goes under the parchment, the first game overlay, whenever it mounts: the
 * config arrives after the overlays are on the map. The names mount first and the raster goes
 * under them, also when a revision mounts it again.
 */
const BELOW = 'parchment-fill';

// A tile that isn't painted yet answers 400 from Storage, which MapLibre logs as an error
// for every such tile. That is the expected fallback, not a fault.
LogManager.onLog(({ message }) => /for source fantasy\b/.test(message));

/** Mounts so far: each mount gets ids of its own (see the RasterSource comment). */
let mounts = 0;

export const FantasyLayer = memo(function FantasyLayer({
  tiles,
  revision,
  labels,
  visible,
}: {
  tiles: string;
  revision: number;
  /** Road and water names, GeoJSON points with name, rot (degrees) and water (0 or 1). */
  labels: string;
  visible: boolean;
}) {
  const [m] = useState(() => ++mounts);
  const visibility = visible ? 'visible' : 'none';
  const names = `fantasy-names-${m}`;
  return (
    <>
      <GeoJSONSource id={`fantasy-labels-${m}`} data={labels}>
        <Layer
          type="symbol"
          id={names}
          beforeId={BELOW}
          minzoom={FANTASY_MIN_ZOOM}
          layout={{
            visibility,
            'text-field': ['get', 'name'],
            'text-font': ['Noto Sans Italic'],
            'text-size': ['interpolate', ['linear'], ['zoom'], 14.6, 12, 16, 14, 17, 16],
            'text-rotate': ['get', 'rot'],
            'text-rotation-alignment': 'map',
            'text-pitch-alignment': 'map',
            'text-letter-spacing': ['case', ['==', ['get', 'water'], 1], 0.15, 0.05],
            'text-padding': 4,
            'symbol-sort-key': ['case', ['==', ['get', 'water'], 1], 0, 1],
          }}
          paint={{
            'text-color': ['case', ['==', ['get', 'water'], 1], '#24506e', '#3a2410'],
            'text-halo-color': ['case', ['==', ['get', 'water'], 1], 'rgba(200,226,240,0.8)', 'rgba(252,240,205,0.85)'],
            'text-halo-width': 1.4,
            'text-halo-blur': 0.8,
          }}
        />
      </GeoJSONSource>
      {/* New ids on each mount and revision. MapLibre then asks again for tiles that were
          missing; a source mounted again under the same id keeps its failed tiles, or doesn't
          come back at all. Painted tiles come from MapLibre's cache. */}
      <RasterSource key={revision} id={`fantasy-${m}-${revision}`} tiles={[tiles]} tileSize={512} minzoom={15} maxzoom={16}>
        <Layer
          type="raster"
          id={`fantasy-raster-${m}-${revision}`}
          beforeId={names}
          layout={{ visibility }}
          minzoom={FANTASY_MIN_ZOOM}
          paint={{ 'raster-fade-duration': 200, 'raster-resampling': 'linear' }}
        />
      </RasterSource>
    </>
  );
});
