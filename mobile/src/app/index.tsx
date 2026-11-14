import {
  Camera,
  type CameraRef,
  GeoJSONSource,
  Layer,
  Map,
  NativeUserLocation,
} from '@maplibre/maplibre-react-native';
import * as Location from 'expo-location';
import { Link } from 'expo-router';
import { useEffect, useEffectEvent, useMemo, useRef, useState } from 'react';
import { AppState, Linking, Pressable, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { onQueueEvent } from '@/lib/db';
import { buildFog, revealArea } from '@/lib/geo';
import { pendingTrack } from '@/lib/queue';
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
const FOG_COLOR = '#5b6b85';
const FOG_OPACITY = 0.5;
const MAP_BACKGROUND = '#f2efe9';
const REVEAL_MS = 1800;
const EMPTY: GeoJSON.FeatureCollection = { type: 'FeatureCollection', features: [] };

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

export default function MapScreen() {
  const prevClaimed = useRef<TerritoryGeoJSON | null>(null);
  const cameraRef = useRef<CameraRef>(null);
  const [showMist, setShowMist] = useState(true);
  const [mapError, setMapError] = useState<string | null>(null);
  const [follow, setFollow] = useState(true);
  const [territory, setTerritory] = useState<Territory | null>(null);
  const [territoryError, setTerritoryError] = useState<string | null>(null);
  const [track, setTrack] = useState(pendingTrack);
  const [tracking, setTracking] = useState(isTrackingWanted);
  const [permission, setPermission] = useState<PermissionState | null>(null);
  const [prompt, setPrompt] = useState<Exclude<PermissionState, 'granted'> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reveal, setReveal] = useState(EMPTY);
  const [revealOpacity, setRevealOpacity] = useState(0);

  const fog = useMemo(() => buildFog(territory?.claimed), [territory]);
  const claimed = (territory?.claimed as GeoJSON.FeatureCollection | undefined) ?? EMPTY;

  function onTerritory(next: Territory) {
    const fresh = revealArea(prevClaimed.current, next.claimed);
    prevClaimed.current = next.claimed;
    setTerritory(next);
    setTerritoryError(null);
    if (fresh.features.length > 0) {
      setRevealOpacity(FOG_OPACITY);
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
      setRevealOpacity(FOG_OPACITY * (1 - k) ** 2);
      if (k >= 1) clearInterval(timer);
    }, 50);
    return () => clearInterval(timer);
  }, [reveal]);

  const canShowLocation = permission === 'granted' || !!permission?.startsWith('background');

  // Without a center the camera starts at 0°, 0° in the ocean. Jump to the phone's
  // position as soon as location is allowed, then let the camera follow it.
  useEffect(() => {
    if (!canShowLocation) return;
    let cancelled = false;
    (async () => {
      try {
        const pos =
          (await Location.getLastKnownPositionAsync()) ??
          (await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Balanced }));
        if (cancelled) return;
        cameraRef.current?.jumpTo({ center: [pos.coords.longitude, pos.coords.latitude], zoom: 16 });
        setFollow(true);
      } catch (e) {
        if (!cancelled) setError(`Location: ${message(e)}`);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [canShowLocation]);

  return (
    <View style={styles.container}>
      <Map
        style={styles.map}
        mapStyle={STYLE_URL}
        logo={false}
        attribution
        attributionPosition={{ top: 64, left: 12 }}
        compassPosition={{ top: 72, right: 12 }}
        onDidFinishLoadingMap={() => setMapError(null)}
        onDidFailLoadingMap={() => setMapError('The map failed to load. Check your internet connection.')}>
        <Camera
          ref={cameraRef}
          initialViewState={{ zoom: 16 }}
          trackUserLocation={follow && canShowLocation ? 'default' : undefined}
          onTrackUserLocationChange={(e) => setFollow(e.nativeEvent.trackUserLocation !== null)}
        />
        <GeoJSONSource id="fog" data={fog}>
          <Layer type="fill" id="fog-fill" paint={{ 'fill-color': FOG_COLOR, 'fill-opacity': showMist ? FOG_OPACITY : 0 }} />
        </GeoJSONSource>
        <GeoJSONSource id="reveal" data={reveal}>
          <Layer type="fill" id="reveal-fill" paint={{ 'fill-color': FOG_COLOR, 'fill-opacity': showMist ? revealOpacity : 0 }} />
        </GeoJSONSource>
        <GeoJSONSource id="claimed" data={claimed}>
          <Layer
            type="line"
            id="claimed-edge"
            paint={{ 'line-color': '#eef3ff', 'line-width': 8, 'line-blur': 6, 'line-opacity': 0.7 }}
          />
        </GeoJSONSource>
        <GeoJSONSource id="track" data={track}>
          <Layer
            type="line"
            id="track-line"
            layout={{ 'line-cap': 'round', 'line-join': 'round' }}
            paint={{ 'line-color': '#ff8a00', 'line-width': 3 }}
          />
        </GeoJSONSource>
        {canShowLocation && <NativeUserLocation />}
      </Map>

      <SafeAreaView style={styles.overlay} pointerEvents="box-none">
        <View style={styles.topRow} pointerEvents="box-none">
          <View style={styles.statusPill}>
            <Text style={styles.statusText}>
              {territory ? `${territory.totalCells} cells · ${(territory.areaM2 / 1e6).toFixed(2)} km²` : 'Under the Mist'}
            </Text>
          </View>
          <Pressable
            accessibilityRole="switch"
            accessibilityState={{ checked: showMist }}
            onPress={() => setShowMist((v) => !v)}
            style={styles.roundButton}>
            <Text style={styles.roundButtonText}>{showMist ? 'Hide Mist' : 'Show Mist'}</Text>
          </Pressable>
          <Link href="/debug" asChild>
            <Pressable accessibilityRole="button" style={styles.roundButton}>
              <Text style={styles.roundButtonText}>Debug</Text>
            </Pressable>
          </Link>
        </View>

        <View style={styles.bottom} pointerEvents="box-none">
          {!follow && canShowLocation && (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Recenter on my location"
              onPress={() => setFollow(true)}
              style={[styles.roundButton, styles.recenter]}>
              <Text style={styles.roundButtonText}>◎ Recenter</Text>
            </Pressable>
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
  bottom: { padding: 16, paddingBottom: 36, gap: 10 },
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
