// The game overlays drawn on the base map. Each source is its own memoized component and
// takes its GeoJSON as a pre-serialized string, so unrelated map-screen renders (reveal
// animation ticks, banners, buttons) neither re-serialize nor resend large data (the
// 50 km² fake realm's fog is ~2.7 MB of JSON).
//
// Mount order is draw order (each layer is appended on top of the base style), so the
// map screen renders them bottom to top:
//   base map → parchment → Mist → reveal → territory border → alignment grid → sites →
//   detour offers → track → user location (native puck, always on top).
//
// Zoom behavior runs natively through `interpolate`/`step` on ['zoom']: below about z14.5
// the street map fades into parchment (0.9 opaque at z13), the Mist darkens, the inked
// border thickens, and site icons shrink and stop overlapping.
import {
  type FillLayerSpecification,
  GeoJSONSource,
  Images,
  Layer,
  type PressEventWithFeatures,
} from '@maplibre/maplibre-react-native';
import { memo } from 'react';
import type { NativeSyntheticEvent } from 'react-native';

import { OVERLAY_ICONS } from './overlay-icons';

export const FOG_COLOR = '#5b6b85';
/** Mist opacity at street zoom. */
export const FOG_OPACITY = 0.5;
/** Mist opacity on the zoomed-out parchment map, darker so unclaimed land stays readable. */
const FOG_OPACITY_FAR = 0.72;
const PARCHMENT = '#eadcb4';
const INK = '#3d2b1f';
/** Parchment starts fading in below this zoom… */
const FADE_START = 14.5;
/** …and is fully in (0.9) at this one. */
const FADE_END = 13;

const WORLD = JSON.stringify({
  type: 'Feature',
  properties: {},
  geometry: {
    type: 'Polygon',
    coordinates: [
      [
        [-180, -85.0511],
        [180, -85.0511],
        [180, 85.0511],
        [-180, 85.0511],
        [-180, -85.0511],
      ],
    ],
  },
});

/** Mist opacity by zoom, scaled by `k` (0..1) for the Hide Mist toggle and the reveal fade. */
function fogOpacity(k: number): NonNullable<FillLayerSpecification['paint']>['fill-opacity'] {
  return ['interpolate', ['linear'], ['zoom'], FADE_END, FOG_OPACITY_FAR * k, FADE_START, FOG_OPACITY * k];
}

export const ParchmentLayer = memo(function ParchmentLayer() {
  return (
    <GeoJSONSource id="parchment" data={WORLD}>
      <Layer
        type="fill"
        id="parchment-fill"
        maxzoom={FADE_START + 0.5}
        paint={{
          'fill-color': PARCHMENT,
          'fill-opacity': ['interpolate', ['linear'], ['zoom'], FADE_END, 0.9, FADE_START, 0],
        }}
      />
    </GeoJSONSource>
  );
});

export const FogLayer = memo(function FogLayer({ data, visible }: { data: string; visible: boolean }) {
  return (
    <GeoJSONSource id="fog" data={data}>
      <Layer type="fill" id="fog-fill" paint={{ 'fill-color': FOG_COLOR, 'fill-opacity': fogOpacity(visible ? 1 : 0) }} />
    </GeoJSONSource>
  );
});

/** Newly claimed land, covered by Mist that fades out as `k` goes from 1 to 0. */
export const RevealLayer = memo(function RevealLayer({ data, k }: { data: string; k: number }) {
  return (
    <GeoJSONSource id="reveal" data={data}>
      <Layer type="fill" id="reveal-fill" paint={{ 'fill-color': FOG_COLOR, 'fill-opacity': fogOpacity(k) }} />
    </GeoJSONSource>
  );
});

export const TerritoryLayer = memo(function TerritoryLayer({ data }: { data: string }) {
  return (
    <GeoJSONSource id="claimed" data={data}>
      {/* Soft light edge at street zoom, gone on the parchment map. */}
      <Layer
        type="line"
        id="claimed-edge"
        paint={{
          'line-color': '#eef3ff',
          'line-width': 8,
          'line-blur': 6,
          'line-opacity': ['interpolate', ['linear'], ['zoom'], FADE_END, 0, FADE_START, 0.7],
        }}
      />
      {/* Inked border, bold when zoomed out. */}
      <Layer
        type="line"
        id="claimed-border"
        layout={{ 'line-join': 'round' }}
        paint={{
          'line-color': INK,
          'line-width': ['interpolate', ['linear'], ['zoom'], 10, 2.5, FADE_END, 4, FADE_START, 2, 17, 1.2],
          'line-opacity': ['interpolate', ['linear'], ['zoom'], FADE_END, 0.95, 17, 0.6],
        }}
      />
    </GeoJSONSource>
  );
});

/** Debug: zoom-21 claim cell outlines, to check overlays line up with streets and land. */
export const GridLayer = memo(function GridLayer({ data }: { data: string }) {
  return (
    <GeoJSONSource id="cell-grid" data={data}>
      <Layer
        type="line"
        id="cell-grid-line"
        minzoom={17}
        paint={{ 'line-color': '#d0006f', 'line-width': 0.6, 'line-opacity': 0.75 }}
      />
    </GeoJSONSource>
  );
});

/**
 * Site icons. Badges are round (places) or square (mines) and anchored at their center
 * (`icon-anchor: center`), so the coordinate is the middle of the badge. Owned sites
 * show their name from z15; silhouettes are faint and nameless.
 */
export const SitesLayer = memo(function SitesLayer({
  data,
  onPress,
}: {
  data: string;
  onPress: (feature: GeoJSON.Feature) => void;
}) {
  return (
    <>
      <Images images={OVERLAY_ICONS} />
      <GeoJSONSource
        id="sites"
        data={data}
        hitbox={{ top: 12, right: 12, bottom: 12, left: 12 }}
        onPress={(e: NativeSyntheticEvent<PressEventWithFeatures>) => {
          e.stopPropagation();
          const feature = e.nativeEvent.features[0];
          if (feature) onPress(feature);
        }}>
        <Layer
          type="symbol"
          id="sites-symbol"
          layout={{
            'icon-image': ['get', 'icon'],
            'icon-anchor': 'center',
            'icon-size': ['interpolate', ['linear'], ['zoom'], 11, 0.55, 14, 0.8, 16, 1],
            'icon-allow-overlap': ['step', ['zoom'], false, 16, true],
            'symbol-sort-key': ['get', 'rank'],
            'text-field': ['step', ['zoom'], '', 15, ['get', 'label']],
            'text-font': ['Noto Sans Bold'],
            'text-size': 12,
            'text-anchor': 'top',
            'text-offset': [0, 1.1],
            'text-max-width': 8,
            'text-optional': true,
          }}
          paint={{
            'icon-opacity': ['case', ['==', ['get', 'vis'], 'owned'], 1, 0.4],
            'text-color': '#1d2433',
            'text-halo-color': '#ffffff',
            'text-halo-width': 1.5,
          }}
        />
      </GeoJSONSource>
    </>
  );
});

/**
 * Detour offers: a pennant (placeholder: a colored dot by reward kind) labeled with the
 * time it adds, and a dashed line from the usual route to it. Collected offers fade and
 * show a check mark. Offers always draw, at every zoom, above the sites.
 */
export const DetoursLayer = memo(function DetoursLayer({
  data,
  onPress,
}: {
  data: string;
  onPress: (feature: GeoJSON.Feature) => void;
}) {
  return (
    <GeoJSONSource
      id="detours"
      data={data}
      hitbox={{ top: 16, right: 16, bottom: 16, left: 16 }}
      onPress={(e: NativeSyntheticEvent<PressEventWithFeatures>) => {
        e.stopPropagation();
        const feature = e.nativeEvent.features.find((f) => f.properties?.kind === 'offer');
        if (feature) onPress(feature);
      }}>
      <Layer
        type="line"
        id="detours-route"
        filter={['==', ['get', 'kind'], 'route']}
        layout={{ 'line-cap': 'round' }}
        paint={{
          'line-color': INK,
          'line-width': 2,
          'line-dasharray': [1, 2],
          'line-opacity': ['case', ['get', 'collected'], 0.25, 0.8],
        }}
      />
      <Layer
        type="circle"
        id="detours-pennant"
        filter={['==', ['get', 'kind'], 'offer']}
        paint={{
          'circle-radius': ['interpolate', ['linear'], ['zoom'], 11, 5, 15, 9],
          'circle-color': ['get', 'color'],
          'circle-stroke-color': INK,
          'circle-stroke-width': 2,
          'circle-opacity': ['case', ['get', 'collected'], 0.4, 1],
          'circle-stroke-opacity': ['case', ['get', 'collected'], 0.4, 1],
        }}
      />
      <Layer
        type="symbol"
        id="detours-label"
        filter={['==', ['get', 'kind'], 'offer']}
        layout={{
          'text-field': ['get', 'label'],
          'text-font': ['Noto Sans Bold'],
          'text-size': 13,
          'text-anchor': 'bottom',
          'text-offset': [0, -0.9],
          'text-allow-overlap': true,
          'text-ignore-placement': true,
        }}
        paint={{ 'text-color': INK, 'text-halo-color': '#ffffff', 'text-halo-width': 2 }}
      />
    </GeoJSONSource>
  );
});

export const TrackLayer = memo(function TrackLayer({ data }: { data: string }) {
  return (
    <GeoJSONSource id="track" data={data}>
      <Layer
        type="line"
        id="track-line"
        layout={{ 'line-cap': 'round', 'line-join': 'round' }}
        paint={{ 'line-color': '#ff8a00', 'line-width': 3 }}
      />
    </GeoJSONSource>
  );
});
