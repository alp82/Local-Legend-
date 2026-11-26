// The fantasy map's state on the map screen: whether it shows, its tile URL, and the
// requests that get unpainted tiles painted.
//
// - The switches (kill switch, tile version) come from the server and are kept in local
//   storage, so the map still shows cached tiles offline.
// - The tiles on screen and a ring around them are requested when that set of tiles
//   changes, not on every camera move (the walking camera moves every second or so). The
//   server queues the ones never painted near the player's own ground, within its limits.
// - While tiles on screen are being painted the request repeats, backing off from 1.5 s to
//   60 s, for at most PENDING_LIMIT_MS per set of tiles (lib/fantasyTiles.ts, nextPoll).
// - MapLibre doesn't fetch a missing tile again while it stays in view, so when a pending
//   tile on screen becomes ready, `revision` changes and the layer is mounted afresh under a
//   new source id (painted tiles come back from MapLibre's cache, without the network).
// - Label files are loaded only for tiles the server reports painted.
import { OfflineManager } from '@maplibre/maplibre-react-native';
import { useEffect, useEffectEvent, useRef, useState } from 'react';
import { AppState } from 'react-native';

import { fetchFantasyConfig, requestFantasyTiles, type FantasyConfig } from '@/lib/fantasyApi';
import {
  fantasyLabelUrl,
  fantasyTileUrl,
  labelsGeoJSON,
  nextPoll,
  tileKey,
  tileSetKey,
  tilesForView,
  tilesOfSetKey,
  type FantasyLabel,
  type PollState,
  type TileZXY,
} from '@/lib/fantasyTiles';
import type { BBox } from '@/lib/sitesApi';

const DEBOUNCE_MS = 400;
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
  /** A limit kept tiles from being queued (daily cap, global limit, full queue). */
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
  const lastPending = useRef<string[]>([]);
  /** Polling for the current tile set; reset only when the set changes. */
  const poll = useRef<{ key: string; state: PollState | null }>({ key: '', state: null });
  /** Label files of one tile version by tile key (only painted tiles are asked for). */
  const labelFiles = useRef({ url: '', files: new Map<string, FantasyLabel[]>() });
  const [labels, setLabels] = useState(NO_LABELS);

  /** Loads the label files of painted tiles not loaded yet, then shows those of the tiles around the view. */
  const showLabels = useEffectEvent(async (url: string, tiles: TileZXY[], ready: TileZXY[]) => {
    // a new tile version has new label files
    if (labelFiles.current.url !== url) labelFiles.current = { url, files: new Map() };
    const { files } = labelFiles.current;
    await Promise.all(
      ready
        .filter((t) => !files.has(tileKey(t)))
        .map(async (t) => {
          try {
            const res = await fetch(fantasyLabelUrl(url, t));
            if (res.ok) files.set(tileKey(t), (await res.json()) as FantasyLabel[]);
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
  const tileUrl = available && config && supabaseUrl ? fantasyTileUrl(supabaseUrl, config.bucket, config.version) : null;
  // The set of tiles the view needs, independent of their order: a camera move inside the
  // same tiles changes nothing here.
  let setKey = '';
  if (view) {
    const { tiles, visible } = tilesForView(view.bounds, view.zoom);
    if (tiles.length > 0) setKey = tileSetKey(tiles, visible);
  }

  useEffect(() => {
    if (!on || !setKey || !tileUrl) return;
    const { tiles, visible } = tilesOfSetKey(setKey);
    if (poll.current.key !== setKey) poll.current = { key: setKey, state: null };
    let cancelled = false;
    let pollTimer: ReturnType<typeof setTimeout> | null = null;
    const timer = setTimeout(() => {
      requestFantasyTiles(tiles, visible).then(
        (r) => {
          if (cancelled) return;
          const now = r.pending.map(tileKey);
          const onScreen = new Set(tiles.slice(0, visible).map(tileKey));
          // A tile on screen that was pending and isn't any more has just been painted.
          if (lastPending.current.some((k) => onScreen.has(k) && !now.includes(k))) setRevision((v) => v + 1);
          lastPending.current = now;
          const waiting = now.filter((k) => onScreen.has(k)).length;
          setPending(now);
          setPendingOnScreen(waiting);
          setCapped(r.capped && r.reason !== 'throttled');
          setError(null);
          if (!r.enabled) setConfig((c) => (c ? { ...c, enabled: false } : c));
          showLabels(tileUrl, tiles, r.ready);
          // Ask again only for tiles on screen being painted (or a call that came too soon).
          const next = nextPoll(poll.current.state, Date.now(), waiting > 0 || r.reason === 'throttled');
          poll.current = { key: setKey, state: next.state };
          if (next.delayMs !== null) pollTimer = setTimeout(() => !cancelled && setPollTick((t) => t + 1), next.delayMs);
        },
        (e: unknown) => {
          if (cancelled) return;
          setError(e instanceof Error ? e.message : String(e));
          showLabels(tileUrl, tiles, []); // offline: the label files loaded before still show
        },
      );
    }, DEBOUNCE_MS);
    return () => {
      cancelled = true;
      clearTimeout(timer);
      if (pollTimer) clearTimeout(pollTimer);
    };
  }, [on, tileUrl, setKey, pollTick]);

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
