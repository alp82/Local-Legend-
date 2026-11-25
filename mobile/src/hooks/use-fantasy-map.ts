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
import { useEffect, useEffectEvent, useRef, useState } from 'react';
import { AppState } from 'react-native';

import { fetchFantasyConfig, requestFantasyTiles, type FantasyConfig } from '@/lib/fantasyApi';
import { fantasyTileUrl, tileKey, tilesForView } from '@/lib/fantasyTiles';
import type { BBox } from '@/lib/sitesApi';

const DEBOUNCE_MS = 400;
/** How often to ask again while tiles on screen are being painted. */
const PENDING_POLL_MS = 1500;
/** Stop asking after this long; the next camera move asks again. */
const PENDING_GIVE_UP_MS = 90_000;
const CONFIG_KEY = 'fantasyConfig';

export type FantasyMapState = {
  /** Raster tile URL template, or null when the server switched the fantasy map off. */
  tiles: string | null;
  /** The player's switch. Off hides the layer without unmounting it. */
  visible: boolean;
  /** Changes when tiles on screen were painted since the layer was mounted. */
  revision: number;
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
    loadConfig();
    const sub = AppState.addEventListener('change', (s) => s === 'active' && loadConfig());
    return () => sub.remove();
  }, []);

  const available = !!config?.enabled && !!supabaseUrl;
  const on = wanted && available;
  const boundsKey = view?.bounds.map((v) => v.toFixed(5)).join(',');
  const zoom = view?.zoom ?? 0;

  useEffect(() => {
    if (!on || !boundsKey) return;
    const bounds = boundsKey.split(',').map(Number) as BBox;
    const { tiles, visible } = tilesForView(bounds, zoom);
    if (tiles.length === 0) return;
    let cancelled = false;
    const timer = setTimeout(() => {
      requestFantasyTiles(tiles, visible).then(
        (r) => {
          if (cancelled) return;
          const now = r.pending.map(tileKey);
          const onScreen = new Set(tiles.slice(0, visible).map(tileKey));
          // A tile on screen that was pending and isn't any more has just been painted.
          if (lastPending.current.some((k) => onScreen.has(k) && !now.includes(k))) setRevision((v) => v + 1);
          lastPending.current = now;
          setPending(now);
          setPendingOnScreen(now.filter((k) => onScreen.has(k)).length);
          setCapped(r.capped);
          setError(null);
          if (!r.enabled) setConfig((c) => (c ? { ...c, enabled: false } : c));
          if (now.some((k) => onScreen.has(k))) {
            pendingSince.current ??= Date.now();
            if (Date.now() - pendingSince.current < PENDING_GIVE_UP_MS) setTimeout(() => !cancelled && setPollTick((t) => t + 1), PENDING_POLL_MS);
          } else {
            pendingSince.current = null;
          }
        },
        (e: unknown) => !cancelled && setError(e instanceof Error ? e.message : String(e)),
      );
    }, DEBOUNCE_MS);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [on, boundsKey, zoom, pollTick]);

  // A camera move gives pending tiles a fresh 90 s.
  useEffect(() => {
    pendingSince.current = null;
  }, [boundsKey]);

  return {
    tiles: available && config && supabaseUrl ? fantasyTileUrl(supabaseUrl, config.bucket, config.version) : null,
    visible: wanted,
    revision,
    pending: pending.length,
    pendingOnScreen: on ? pendingOnScreen : 0,
    capped,
    error,
  };
}
