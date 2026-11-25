// The fantasy map's state on the map screen: whether it shows, its tile URL, and the
// requests that get unpainted tiles painted.
//
// - The switches (kill switch, tile version) come from the server and are kept in local
//   storage, so the map still shows cached tiles offline.
// - After the camera stops, the tiles on screen and a ring around them are requested; the
//   server queues the ones never painted. While some are pending, the request repeats.
// - MapLibre doesn't fetch a missing tile again while it stays in view, so when a pending
//   tile on screen becomes ready, `revision` changes and the layer is mounted afresh under a
//   new source id (painted tiles come back from MapLibre's cache, without the network).
import { OfflineManager } from '@maplibre/maplibre-react-native';
import { useEffect, useEffectEvent, useRef, useState } from 'react';
import { AppState } from 'react-native';

import { fetchFantasyConfig, requestFantasyTiles, type FantasyConfig } from '@/lib/fantasyApi';
import { fantasyLabelUrl, fantasyTileUrl, labelsGeoJSON, tileKey, tilesForView, type FantasyLabel, type TileZXY } from '@/lib/fantasyTiles';
import type { BBox } from '@/lib/sitesApi';

const DEBOUNCE_MS = 400;
/** How often to ask again while tiles on screen are being painted. */
const PENDING_POLL_MS = 1500;
/** Stop asking after this long; the next camera move asks again. */
const PENDING_GIVE_UP_MS = 90_000;
const CONFIG_KEY = 'fantasyConfig';
const NO_LABELS = labelsGeoJSON([]);
/** Label files kept in memory (a few hundred bytes each). */
const LABEL_CACHE_MAX = 1500;
/**
 * MapLibre's on-device tile cache. The default (50 MB) holds about 400 painted tiles, less
 * than a tester's home area with the street map tiles beside it, so tiles would be fetched
 * again on every visit.
 */
const AMBIENT_CACHE_BYTES = 200 * 1024 * 1024;

export type FantasyMapState = {
  /** Raster tile URL template, or null when the server switched the fantasy map off. */
  tiles: string | null;
  /** The player's switch. Off hides the layer without unmounting it. */
  visible: boolean;
  /** Changes when tiles on screen were painted since the layer was mounted. */
  revision: number;
  /** The road and water names of the tiles around the view, as GeoJSON (from the tiles' label files). */
  labels: string;
  /** Tiles of the last request still being painted. */
  pending: number;
  /** Of those, the ones on screen. */
  pendingOnScreen: number;
  /** The daily cap stopped new tiles today. */
  capped: boolean;
  error: string | null;
};

function storedConfig(): FantasyConfig | null {
  try {
    const raw = globalThis.localStorage?.getItem(CONFIG_KEY);
    return raw ? (JSON.parse(raw) as FantasyConfig) : null;
  } catch {
    return null;
  }
}

export function useFantasyMap(
  view: { bounds: BBox; zoom: number } | null,
  wanted: boolean,
  supabaseUrl: string | undefined,
): FantasyMapState {
  const [config, setConfig] = useState<FantasyConfig | null>(storedConfig);
  const [revision, setRevision] = useState(0);
  const [pending, setPending] = useState<string[]>([]);
  const [pendingOnScreen, setPendingOnScreen] = useState(0);
  const [capped, setCapped] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pollTick, setPollTick] = useState(0);
  const pendingSince = useRef<number | null>(null);
  const lastPending = useRef<string[]>([]);
  /** The tiles of the last answered request; the walking camera moves every second or so. */
  const lastAsked = useRef('');
  /** Label files of one tile version by tile key; null: none yet (the tile isn't painted). */
  const labelFiles = useRef({ url: '', files: new Map<string, FantasyLabel[] | null>() });
  const [labels, setLabels] = useState(NO_LABELS);

  /** Loads the label files of these tiles that aren't known yet (and aren't being painted), then shows theirs. */
  const showLabels = useEffectEvent(async (url: string, tiles: TileZXY[], painting: string[]) => {
    // a new tile version has new label files
    if (labelFiles.current.url !== url) labelFiles.current = { url, files: new Map() };
    const { files } = labelFiles.current;
    const todo = tiles.filter((t) => !painting.includes(tileKey(t)) && !files.get(tileKey(t)));
    await Promise.all(
      todo.map(async (t) => {
        try {
          const res = await fetch(fantasyLabelUrl(url, t));
          files.set(tileKey(t), res.ok ? ((await res.json()) as FantasyLabel[]) : null);
        } catch {
          // offline: keep what is known
        }
      }),
    );
    while (files.size > LABEL_CACHE_MAX) files.delete(files.keys().next().value!);
    const json = labelsGeoJSON(tiles.map((t) => files.get(tileKey(t)) ?? []));
    setLabels((cur) => (cur === json ? cur : json));
  });

  const loadConfig = useEffectEvent(() => {
    fetchFantasyConfig().then(
      (c) => {
        setConfig(c);
        globalThis.localStorage?.setItem(CONFIG_KEY, JSON.stringify(c));
      },
      (e: unknown) => setError(e instanceof Error ? e.message : String(e)),
    );
  });
  useEffect(() => {
    OfflineManager.setMaximumAmbientCacheSize(AMBIENT_CACHE_BYTES).catch(() => {});
    loadConfig();
    const sub = AppState.addEventListener('change', (s) => s === 'active' && loadConfig());
    return () => sub.remove();
  }, []);

  const available = !!config?.enabled && !!supabaseUrl;
  const on = wanted && available;
  const version = config?.version ?? 0;
  const tileUrl = available && config && supabaseUrl ? fantasyTileUrl(supabaseUrl, config.bucket, config.version) : null;

  const boundsKey = view?.bounds.map((v) => v.toFixed(5)).join(',');
  const zoom = view?.zoom ?? 0;

  useEffect(() => {
    if (!on || !boundsKey || !tileUrl) return;
    const bounds = boundsKey.split(',').map(Number) as BBox;
    const { tiles, visible } = tilesForView(bounds, zoom);
    if (tiles.length === 0) return;
    const sorted = (list: typeof tiles) => list.map(tileKey).sort().join(',');
    const asked = `${version}|${sorted(tiles.slice(0, visible))}|${sorted(tiles)}`;
    // The same tiles (in any order) as last time and nothing waiting: the answer can't have changed.
    if (asked === lastAsked.current && lastPending.current.length === 0) return;
    let cancelled = false;
    const timer = setTimeout(() => {
      requestFantasyTiles(tiles, visible).then(
        (r) => {
          if (cancelled) return;
          lastAsked.current = asked;
          const now = r.pending.map(tileKey);
          const onScreen = new Set(tiles.slice(0, visible).map(tileKey));
          // A tile on screen that was pending and isn't any more has just been painted.
          if (lastPending.current.some((k) => onScreen.has(k) && !now.includes(k))) setRevision((v) => v + 1);
          lastPending.current = now;
          setPending(now);
          setPendingOnScreen(now.filter((k) => onScreen.has(k)).length);
          setCapped(r.capped);
          setError(null);
          showLabels(tileUrl, tiles, now);
          if (!r.enabled) setConfig((c) => (c ? { ...c, enabled: false } : c));
          if (now.some((k) => onScreen.has(k))) {
            pendingSince.current ??= Date.now();
            if (Date.now() - pendingSince.current < PENDING_GIVE_UP_MS) setTimeout(() => !cancelled && setPollTick((t) => t + 1), PENDING_POLL_MS);
          } else {
            pendingSince.current = null;
          }
        },
        (e: unknown) => {
          if (cancelled) return;
          setError(e instanceof Error ? e.message : String(e));
          showLabels(tileUrl, tiles, []); // offline: the label files fetched before still show
        },
      );
    }, DEBOUNCE_MS);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [on, version, tileUrl, boundsKey, zoom, pollTick]);

  // A camera move gives pending tiles a fresh 90 s.
  useEffect(() => {
    pendingSince.current = null;
  }, [boundsKey]);

  return {
    tiles: tileUrl,
    visible: wanted,
    revision,
    labels,
    pending: pending.length,
    pendingOnScreen: on ? pendingOnScreen : 0,
    capped,
    error,
  };
}
