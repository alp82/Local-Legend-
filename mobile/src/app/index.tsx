import { Camera, type CameraRef, Map, NativeUserLocation } from '@maplibre/maplibre-react-native';
import { Link } from 'expo-router';
import { useEffect, useEffectEvent, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, AppState, Linking, Pressable, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import {
  DetoursLayer,
  FogLayer,
  GridLayer,
  ParchmentLayer,
  RevealLayer,
  SitesLayer,
  TerritoryLayer,
  TrackLayer,
} from '@/components/map-layers';
import { PerfReadout, type PerfStats } from '@/components/perf-readout';
import { ResourceBar } from '@/components/resource-bar';
import { useDetours } from '@/hooks/use-detours';
import { useEconomy } from '@/hooks/use-economy';
import { useFollowCamera } from '@/hooks/use-follow-camera';
import { useSites } from '@/hooks/use-sites';
import { onQueueEvent } from '@/lib/db';
import { detoursJson, offerDistance, offerPlace, offerTitle, rewardText } from '@/lib/detours';
import type { DetourOffer } from '@/lib/detoursApi';
import { useDebugSettings } from '@/lib/debugSettings';
import { fakeWorld, type FakeWorld } from '@/lib/fakeTerritory';
import { buildFog, cellGridLines, geometryStats, revealArea } from '@/lib/geo';
import { pendingTrack } from '@/lib/queue';
import type { BBox, Site } from '@/lib/sitesApi';
import { siteType } from '@/lib/siteTypes';
import { fetchTerritory, type Territory, type TerritoryGeoJSON } from '@/lib/territoryApi';
import {
  isTrackingWanted,
  openSettings,
  permissionState,
  requestBackground,
  requestForeground,
  requestNotifications,
  startTracking,
  stopTracking,
  type PermissionState,
} from '@/lib/tracking';

const STYLE_URL = 'https://tiles.openfreemap.org/styles/liberty';
const MAP_BACKGROUND = '#f2efe9';
const REVEAL_MS = 1800;
const EMPTY: GeoJSON.FeatureCollection = { type: 'FeatureCollection', features: [] };
const EMPTY_JSON = JSON.stringify(EMPTY);
const GRID_MIN_ZOOM = 17;

const PROMPTS: Record<Exclude<PermissionState, 'granted'>, { text: string; action: string }> = {
  'foreground-ask': {
    text: 'Local Legend clears the Mist wherever you walk. It needs your location to show you on the map and record your walks.',
    action: 'Allow location',
  },
  'foreground-denied': {
    text: 'Location access is turned off for Local Legend. Open Settings → Permissions → Location and allow it.',
    action: 'Open settings',
  },
  'background-ask': {
    text: 'To keep recording with the phone locked in your pocket, choose "Allow all the time" on the next screen.',
    action: 'Continue',
  },
  'background-denied': {
    text: 'Walks are only recorded with "Allow all the time". Open Settings → Permissions → Location and select it.',
    action: 'Open settings',
  },
};

function message(e: unknown) {
  return e instanceof Error ? e.message : String(e);
}

const now = () => globalThis.performance?.now() ?? Date.now();

/** Fog and outline data for the map, serialized once per territory change, with timings. */
function prepareTerritory(claimed: TerritoryGeoJSON | undefined) {
  let t0 = now();
  const fog = buildFog(claimed);
  const fogBuildMs = now() - t0;
  t0 = now();
  const fogJson = JSON.stringify(fog);
  const fogJsonMs = now() - t0;
  return { fogJson, fogBuildMs, fogJsonMs, claimedJson: claimed ? JSON.stringify(claimed) : EMPTY_JSON, ...geometryStats(claimed) };
}

/** Sites as map features; the icon, label and draw priority are worked out here. */
function sitesJson(sites: Site[]): string {
  return JSON.stringify({
    type: 'FeatureCollection',
    features: sites.map((s) => {
      const owned = s.visibility === 'owned';
      return {
        type: 'Feature',
        properties: {
          id: s.id,
          icon: siteType(s.kind, s.subtype).icon,
          type: siteType(s.kind, s.subtype).label,
          kind: s.kind,
          name: s.name,
          vis: s.visibility,
          label: owned ? (s.name ?? '') : '',
          rank: owned ? 0 : 1,
        },
        geometry: { type: 'Point', coordinates: [s.lng, s.lat] },
      };
    }),
  });
}

// The fake realm is generated once per app run, around wherever the map was first.
let fakeCache: FakeWorld | null = null;
function getFakeWorld(center: { lat: number; lng: number }) {
  fakeCache ??= fakeWorld({ center });
  return fakeCache;
}

type SelectedSite = { name: string | null; type: string; kind: string; owned: boolean };

export default function MapScreen() {
  const prevClaimed = useRef<TerritoryGeoJSON | null>(null);
  const cameraRef = useRef<CameraRef>(null);
  const [showMist, setShowMist] = useState(true);
  const [mapError, setMapError] = useState<string | null>(null);
  const [territory, setTerritory] = useState<Territory | null>(null);
  const [territoryError, setTerritoryError] = useState<string | null>(null);
  const [track, setTrack] = useState(pendingTrack);
  const [tracking, setTracking] = useState(isTrackingWanted);
  const [permission, setPermission] = useState<PermissionState | null>(null);
  const [prompt, setPrompt] = useState<Exclude<PermissionState, 'granted'> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reveal, setReveal] = useState(EMPTY);
  const [revealK, setRevealK] = useState(0);
  const [view, setView] = useState<{ bounds: BBox; zoom: number } | null>(null);
  const [selected, setSelected] = useState<SelectedSite | null>(null);
  const [selectedOffer, setSelectedOffer] = useState<number | null>(null);
  const [fake, setFake] = useState<FakeWorld | null>(fakeCache);
  const debug = useDebugSettings();

  const fakeOn = debug.fakeTerritory && fake !== null;
  const shown = fakeOn ? fake.territory : territory;
  const prepared = useMemo(() => prepareTerritory(shown?.claimed), [shown]);
  const revealJson = useMemo(() => JSON.stringify(reveal), [reveal]);
  const trackJson = useMemo(() => JSON.stringify(track), [track]);

  const sitesState = useSites(view, String(territory?.totalCells ?? 'none'), !debug.fakeTerritory);
  const sites = fakeOn ? fake.sites : sitesState.sites;
  const sitesData = useMemo(() => sitesJson(sites), [sites]);

  const detoursState = useDetours(!debug.fakeTerritory);
  const offers = useMemo(() => (fakeOn ? [] : (detoursState.detours?.offers ?? [])), [fakeOn, detoursState.detours]);
  const detoursData = useMemo(() => detoursJson(offers), [offers]);
  const offer: DetourOffer | null = offers.find((o) => o.id === selectedOffer) ?? null;

  const gridOn = debug.alignmentGrid && !!view && view.zoom >= GRID_MIN_ZOOM;
  const gridBounds = gridOn ? view.bounds.map((v) => v.toFixed(6)).join(',') : null;
  const gridJson = useMemo(() => {
    const fc = gridBounds && cellGridLines(gridBounds.split(',').map(Number) as BBox);
    return fc ? JSON.stringify(fc) : EMPTY_JSON;
  }, [gridBounds]);

  const perf: PerfStats | null =
    debug.perfReadout || debug.fakeTerritory
      ? {
          label: fakeOn ? 'FAKE realm' : 'real realm',
          fogBuildMs: prepared.fogBuildMs,
          fogJsonMs: prepared.fogJsonMs,
          fogJsonMB: prepared.fogJson.length / 1e6,
          polygons: prepared.polygons,
          rings: prepared.rings,
          vertices: prepared.vertices,
          sites: sites.length,
          zoom: view?.zoom ?? 0,
          generateMs: fakeOn ? fake.generateMs : null,
        }
      : null;

  // Fake realm: generate on first use (a second or two on the phone), centered on the map.
  const fakeCenter = view ? { lng: (view.bounds[0] + view.bounds[2]) / 2, lat: (view.bounds[1] + view.bounds[3]) / 2 } : null;
  const needFake = debug.fakeTerritory && !fake && fakeCenter !== null;
  const onNeedFake = useEffectEvent(() => {
    if (fakeCenter) setFake(getFakeWorld(fakeCenter));
  });
  useEffect(() => {
    if (!needFake) return;
    // Let the "Generating" pill render before the JS thread is busy.
    const timer = setTimeout(onNeedFake, 50);
    return () => clearTimeout(timer);
  }, [needFake]);

  function onOfferPress(feature: GeoJSON.Feature) {
    setSelected(null);
    setSelectedOffer(Number(feature.properties?.id));
  }

  function onSitePress(feature: GeoJSON.Feature) {
    const p = feature.properties ?? {};
    setSelectedOffer(null);
    setSelected({
      name: typeof p.name === 'string' ? p.name : null,
      type: String(p.type ?? ''),
      kind: String(p.kind ?? ''),
      owned: p.vis === 'owned',
    });
  }

  function onTerritory(next: Territory) {
    const fresh = revealArea(prevClaimed.current, next.claimed);
    prevClaimed.current = next.claimed;
    // Claims only grow, so the same cell count means the same land: keep the old object
    // and skip rebuilding and resending the fog.
    setTerritory((cur) => (cur && cur.totalCells === next.totalCells && cur.areaM2 === next.areaM2 ? cur : next));
    setTerritoryError(null);
    if (fresh.features.length > 0) {
      setRevealK(1);
      setReveal(fresh);
    }
  }

  function loadTerritory() {
    fetchTerritory().then(onTerritory, (e) => setTerritoryError(message(e)));
  }

  async function continueFlow(state: PermissionState) {
    setPermission(state);
    if (state !== 'granted') {
      setPrompt(state);
      return;
    }
    setPrompt(null);
    try {
      await requestNotifications();
      await startTracking();
      setTracking(true);
      setError(null);
    } catch (e) {
      setError(message(e));
    }
  }

  async function onPromptAction() {
    try {
      if (prompt === 'foreground-ask') await continueFlow(await requestForeground());
      else if (prompt === 'background-ask') await continueFlow(await requestBackground());
      else await openSettings();
    } catch (e) {
      setError(message(e));
    }
  }

  async function toggleTracking() {
    try {
      if (tracking) {
        await stopTracking();
        setTracking(false);
      } else {
        await continueFlow(await permissionState());
      }
    } catch (e) {
      setError(message(e));
    }
  }

  // Back from settings or the background: refresh everything and resume a pending permission flow.
  const onActive = useEffectEvent(() => {
    loadTerritory();
    setTrack(pendingTrack());
    setTracking(isTrackingWanted());
    permissionState().then((state) => {
      setPermission(state);
      if (prompt) continueFlow(state);
    });
  });
  const onQueue = useEffectEvent((event: 'points' | 'upload' | 'tracking') => {
    setTrack(pendingTrack());
    if (event === 'upload') loadTerritory();
    if (event === 'tracking') setTracking(isTrackingWanted());
  });

  const onMount = useEffectEvent(() => {
    loadTerritory();
    permissionState().then(setPermission);
  });

  useEffect(() => {
    onMount();
    const sub = AppState.addEventListener('change', (s) => s === 'active' && onActive());
    const unsubscribe = onQueueEvent((e) => onQueue(e));
    return () => {
      sub.remove();
      unsubscribe();
    };
  }, []);

  // Reveal: newly claimed land starts covered and the Mist over it fades away.
  useEffect(() => {
    if (reveal.features.length === 0) return;
    const start = Date.now();
    const timer = setInterval(() => {
      const k = Math.min(1, (Date.now() - start) / REVEAL_MS);
      setRevealK((1 - k) ** 2);
      if (k >= 1) clearInterval(timer);
    }, 50);
    return () => clearInterval(timer);
  }, [reveal]);

  const canShowLocation = permission === 'granted' || !!permission?.startsWith('background');

  const cam = useFollowCamera(cameraRef, canShowLocation);
  const economy = useEconomy();

  return (
    <View style={styles.container}>
      <Map
        style={styles.map}
        mapStyle={STYLE_URL}
        logo={false}
        attribution
        attributionPosition={{ top: 174, left: 12 }}
        compassPosition={{ top: 182, right: 12 }}
        onDidFinishLoadingMap={() => setMapError(null)}
        onDidFailLoadingMap={() => setMapError('The map failed to load. Check your internet connection.')}
        onRegionWillChange={cam.onRegionWillChange}
        onRegionDidChange={(e) => {
          cam.onRegionDidChange(e);
          setView({ bounds: e.nativeEvent.bounds, zoom: e.nativeEvent.zoom });
        }}
        onPress={() => {
          setSelected(null);
          setSelectedOffer(null);
        }}>
        <Camera ref={cameraRef} initialViewState={cam.initialViewState} />
        {/* Bottom to top; see components/map-layers.tsx. */}
        <ParchmentLayer />
        <FogLayer data={prepared.fogJson} visible={showMist} />
        <RevealLayer data={revealJson} k={showMist ? revealK : 0} />
        <TerritoryLayer data={prepared.claimedJson} />
        <GridLayer data={gridJson} />
        <SitesLayer data={sitesData} onPress={onSitePress} />
        <DetoursLayer data={detoursData} onPress={onOfferPress} />
        <TrackLayer data={trackJson} />
        {canShowLocation && <NativeUserLocation />}
      </Map>

      <SafeAreaView style={styles.overlay} pointerEvents="box-none">
        <View style={styles.topRow} pointerEvents="box-none">
          <View style={styles.statusPill}>
            <Text style={styles.statusText}>
              {debug.fakeTerritory && !fake
                ? 'Generating fake realm…'
                : shown
                  ? `${fakeOn ? 'FAKE · ' : ''}${shown.totalCells} cells · ${(shown.areaM2 / 1e6).toFixed(2)} km²`
                  : 'Under the Mist'}
            </Text>
          </View>
          <Pressable
            accessibilityRole="switch"
            accessibilityState={{ checked: showMist }}
            onPress={() => setShowMist((v) => !v)}
            style={styles.roundButton}>
            <Text style={styles.roundButtonText}>{showMist ? 'Hide Mist' : 'Show Mist'}</Text>
          </Pressable>
          <Link href="/kingdom" asChild>
            <Pressable accessibilityRole="button" style={styles.roundButton}>
              <Text style={styles.roundButtonText}>Kingdom</Text>
            </Pressable>
          </Link>
          <Link href="/debug" asChild>
            <Pressable accessibilityRole="button" style={styles.roundButton}>
              <Text style={styles.roundButtonText}>Debug</Text>
            </Pressable>
          </Link>
        </View>

        <ResourceBar economy={economy.economy} error={economy.error} />

        <View style={styles.middle} pointerEvents="box-none">
          {sitesState.loading && !debug.fakeTerritory && (
            <View style={styles.loadingPill}>
              <ActivityIndicator size="small" color="#fff" />
              <Text style={styles.statusText}>Loading sites…</Text>
            </View>
          )}
          {offers.length > 0 && (
            <View style={styles.loadingPill}>
              <Text style={styles.statusText}>
                {`Detours today: ${offers.filter((o) => o.collectedAt).length} of ${offers.length} collected`}
              </Text>
            </View>
          )}
          {perf && <PerfReadout stats={perf} />}
        </View>

        <View style={styles.bottom} pointerEvents="box-none">
          {!cam.follow && canShowLocation && (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Recenter on my location"
              onPress={cam.recenter}
              style={[styles.roundButton, styles.recenter]}>
              <Text style={styles.roundButtonText}>◎ Recenter</Text>
            </Pressable>
          )}

          {selected && (
            <View style={styles.card}>
              <View style={styles.siteCardRow}>
                <View style={styles.flex}>
                  <Text style={styles.siteName}>{selected.name ?? (selected.owned ? 'Unnamed' : 'Something under the Mist')}</Text>
                  <Text style={styles.siteType}>
                    {selected.type}
                    {selected.kind === 'mine' ? ' · mine' : ''}
                    {selected.owned ? '' : ' · walk closer to reveal it'}
                  </Text>
                </View>
                <Pressable accessibilityRole="button" accessibilityLabel="Close" onPress={() => setSelected(null)} hitSlop={12}>
                  <Text style={styles.close}>✕</Text>
                </Pressable>
              </View>
            </View>
          )}

          {offer && (
            <View style={styles.card}>
              <View style={styles.siteCardRow}>
                <View style={styles.flex}>
                  <Text style={styles.siteName}>{`${offerTitle(offer)} · +${offer.addedMin} min`}</Text>
                  <Text style={styles.siteType}>{`${offerPlace(offer)}, ${offerDistance(offer, detoursState.detours?.source ?? null)}`}</Text>
                  <Text style={styles.siteType}>{rewardText(offer)}</Text>
                  <Text style={styles.siteType}>
                    {offer.collectedAt
                      ? 'Collected'
                      : `Walk within 30 m to collect it before ${new Date(offer.validUntil).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`}
                  </Text>
                </View>
                <Pressable accessibilityRole="button" accessibilityLabel="Close" onPress={() => setSelectedOffer(null)} hitSlop={12}>
                  <Text style={styles.close}>✕</Text>
                </Pressable>
              </View>
            </View>
          )}

          {prompt && (
            <View style={styles.card}>
              <Text style={styles.cardText}>{PROMPTS[prompt].text}</Text>
              <View style={styles.cardActions}>
                <Pressable accessibilityRole="button" onPress={() => setPrompt(null)} style={styles.cardSecondary}>
                  <Text style={styles.cardSecondaryText}>Not now</Text>
                </Pressable>
                <Pressable accessibilityRole="button" onPress={onPromptAction} style={styles.cardPrimary}>
                  <Text style={styles.buttonText}>{PROMPTS[prompt].action}</Text>
                </Pressable>
              </View>
            </View>
          )}

          {mapError && (
            <Text style={styles.error} numberOfLines={2}>
              {mapError}
            </Text>
          )}

          {(error || territoryError) && (
            <Text style={styles.error} numberOfLines={2}>
              {error ?? `Territory: ${territoryError}`}
            </Text>
          )}

          {detoursState.error && !debug.fakeTerritory && (
            <Text style={styles.error} numberOfLines={2}>
              {`Detours: ${detoursState.error}`}
            </Text>
          )}

          {sitesState.error && !debug.fakeTerritory && (
            <Text style={styles.error} numberOfLines={2}>
              {`Sites: ${sitesState.error}`}
            </Text>
          )}

          <Pressable
            accessibilityRole="switch"
            accessibilityState={{ checked: tracking }}
            onPress={toggleTracking}
            style={({ pressed }) => [styles.trackButton, tracking && styles.trackButtonOn, pressed && styles.pressed]}>
            <Text style={styles.buttonText}>{tracking ? '■ Stop tracking' : '▶ Start tracking'}</Text>
          </Pressable>

          <Text
            style={styles.attribution}
            onPress={() => Linking.openURL('https://www.openstreetmap.org/copyright')}>
            © OpenFreeMap © OpenMapTiles © OpenStreetMap contributors
          </Text>
        </View>
      </SafeAreaView>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: MAP_BACKGROUND },
  map: { flex: 1 },
  overlay: { ...StyleSheet.absoluteFill, justifyContent: 'space-between' },
  topRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', padding: 12, gap: 8 },
  statusPill: { backgroundColor: 'rgba(20,28,44,0.75)', borderRadius: 16, paddingHorizontal: 12, paddingVertical: 6 },
  statusText: { color: '#fff', fontSize: 13, fontWeight: '600' },
  roundButton: {
    backgroundColor: 'rgba(20,28,44,0.85)',
    borderRadius: 20,
    paddingHorizontal: 14,
    paddingVertical: 8,
  },
  roundButtonText: { color: '#fff', fontSize: 14, fontWeight: '600' },
  middle: { flex: 1, paddingHorizontal: 12, paddingTop: 8, gap: 8 },
  loadingPill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    alignSelf: 'flex-start',
    backgroundColor: 'rgba(20,28,44,0.75)',
    borderRadius: 16,
    paddingHorizontal: 10,
    paddingVertical: 4,
  },
  bottom: { padding: 16, paddingBottom: 36, gap: 10 },
  flex: { flex: 1 },
  siteCardRow: { flexDirection: 'row', alignItems: 'flex-start', gap: 12 },
  siteName: { color: '#111', fontSize: 17, fontWeight: '700' },
  siteType: { color: '#555', fontSize: 14, marginTop: 2 },
  close: { color: '#555', fontSize: 18 },
  recenter: { alignSelf: 'flex-end' },
  card: { backgroundColor: '#fff', borderRadius: 12, padding: 16, gap: 12 },
  cardText: { color: '#111', fontSize: 15, lineHeight: 21 },
  cardActions: { flexDirection: 'row', justifyContent: 'flex-end', gap: 8 },
  cardPrimary: { backgroundColor: '#208AEF', borderRadius: 8, paddingHorizontal: 16, paddingVertical: 10 },
  cardSecondary: { borderRadius: 8, paddingHorizontal: 16, paddingVertical: 10 },
  cardSecondaryText: { color: '#208AEF', fontSize: 16, fontWeight: '600' },
  error: { color: '#fff', backgroundColor: 'rgba(160,30,30,0.85)', borderRadius: 8, padding: 8, fontSize: 13 },
  trackButton: { backgroundColor: '#208AEF', borderRadius: 28, paddingVertical: 16, alignItems: 'center' },
  trackButtonOn: { backgroundColor: '#C2410C' },
  pressed: { opacity: 0.7 },
  buttonText: { color: '#fff', fontSize: 16, fontWeight: '600' },
  attribution: {
    position: 'absolute',
    left: 12,
    bottom: 10,
    fontSize: 10,
    color: '#fff',
    textShadowColor: 'rgba(0,0,0,0.6)',
    textShadowRadius: 2,
  },
});
