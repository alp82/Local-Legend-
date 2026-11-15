// Loads the sites around the visible map area: debounced after the camera stops, padded,
// cached per grid tile, and refetched when the territory changes (visibility depends on it).
import { useEffect, useRef, useState } from 'react';

import { padBBox } from '@/lib/geo';
import { bboxOfTiles, SiteCache } from '@/lib/siteCache';
import { fetchSites, type BBox, type Site } from '@/lib/sitesApi';

const DEBOUNCE_MS = 500;
/** How long to wait before asking again for areas the server is still loading. */
const PENDING_RETRY_MS = 20_000;
const PAD = 0.2;
/** Below this zoom the box gets too large to fetch; the map keeps what it already has. */
export const MIN_FETCH_ZOOM = 12;

export type SitesState = { sites: Site[]; loading: boolean; error: string | null };

export function useSites(view: { bounds: BBox; zoom: number } | null, territoryKey: string, enabled: boolean): SitesState {
  const cache = useRef<SiteCache | null>(null);
  /** Bumped when the territory changes; answers to older requests are dropped. */
  const generation = useRef(0);
  /** Tiles being fetched right now, so a pan during a slow fetch doesn't ask again. */
  const pending = useRef(new Set<string>());
  const [state, setState] = useState<SitesState>({ sites: [], loading: false, error: null });
  /** Bumped to refetch areas the server was still loading. */
  const [retryTick, setRetryTick] = useState(0);
  const retryTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => {
    if (retryTimer.current) clearTimeout(retryTimer.current);
  }, []);

  // Territory changed: what's owned or a silhouette may have changed everywhere. Keep
  // showing the old sites until the visible area is refetched.
  useEffect(() => {
    cache.current?.clear();
    pending.current.clear();
    generation.current++;
  }, [territoryKey]);

  const bounds = view?.bounds;
  const zoom = view?.zoom ?? 0;
  const boundsKey = bounds?.map((v) => v.toFixed(5)).join(',');

  useEffect(() => {
    if (!enabled || !bounds || zoom < MIN_FETCH_ZOOM) return;
    const timer = setTimeout(() => {
      cache.current ??= new SiteCache();
      const store = cache.current;
      const missing = store.missing(padBBox(bounds, PAD)).filter((k) => !pending.current.has(k));
      if (missing.length === 0) return;
      const gen = generation.current;
      for (const k of missing) pending.current.add(k);
      setState((s) => ({ ...s, loading: true }));
      const stale = () => gen !== generation.current;
      const done = () => {
        if (stale()) setState((s) => ({ ...s, loading: pending.current.size > 0 }));
        else for (const k of missing) pending.current.delete(k);
        return !stale();
      };
      fetchSites(bboxOfTiles(missing)).then(
        ({ sites, pending: loadingAreas }) => {
          if (!done()) return;
          if (loadingAreas > 0) {
            // The server is still loading some of these areas. Show what came back,
            // but leave the tiles uncached so the retry asks for them again.
            const shown = new Map(store.all().map((site) => [site.id, site]));
            for (const site of sites) shown.set(site.id, site);
            setState({ sites: [...shown.values()], loading: true, error: null });
            if (retryTimer.current) clearTimeout(retryTimer.current);
            retryTimer.current = setTimeout(() => setRetryTick((t) => t + 1), PENDING_RETRY_MS);
            return;
          }
          store.store(missing, sites);
          setState({ sites: store.all(), loading: pending.current.size > 0, error: null });
        },
        (e: unknown) => {
          if (!done()) return;
          const error = e instanceof Error ? e.message : String(e);
          setState((s) => ({ ...s, loading: pending.current.size > 0, error }));
        },
      );
    }, DEBOUNCE_MS);
    return () => clearTimeout(timer);
    // boundsKey stands in for bounds (a new array on every camera event).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [boundsKey, zoom, territoryKey, enabled, retryTick]);

  return state;
}
