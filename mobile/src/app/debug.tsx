import * as Battery from 'expo-battery';
import Constants from 'expo-constants';
import * as Updates from 'expo-updates';
import { useEffect, useState } from 'react';
import { Linking, Platform, Pressable, ScrollView, Share, StyleSheet, Switch, Text, View, useColorScheme } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { PlayerSection } from '@/components/player-section';
import { onQueueEvent } from '@/lib/db';
import { setDebugSetting, useDebugSettings, type DebugSettings } from '@/lib/debugSettings';
import { batchLog, getDiagnostics, sessionLog } from '@/lib/diagnostics';
import { uploadNow } from '@/lib/queue';

// Change this value and publish with `npm run update:preview -- "message"` to verify OTA delivery.
const BUILD_MARKER = 'v3';

function formatDate(date: Date | null) {
  return date ? date.toISOString() : '—';
}

const time = (t: number | null | undefined) => (t ? new Date(t).toLocaleTimeString() : '—');

function useDiagnostics() {
  const [snapshot, setSnapshot] = useState(() => ({ diag: getDiagnostics(), log: sessionLog() }));
  const [battery, setBattery] = useState<number | null>(null);
  const [optimized, setOptimized] = useState<boolean | null>(null);

  useEffect(() => {
    const refresh = () => {
      setSnapshot({ diag: getDiagnostics(), log: sessionLog() });
      Battery.getBatteryLevelAsync().then(setBattery, () => setBattery(null));
    };
    refresh();
    Battery.isBatteryOptimizationEnabledAsync().then(setOptimized, () => setOptimized(null));
    const unsubscribe = onQueueEvent(refresh);
    const timer = setInterval(refresh, 5000);
    return () => {
      unsubscribe();
      clearInterval(timer);
    };
  }, []);

  return { ...snapshot, battery, optimized };
}

export default function DebugScreen() {
  const dark = useColorScheme() === 'dark';
  const [status, setStatus] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const { diag, log, battery, optimized } = useDiagnostics();
  const mapSettings = useDebugSettings();

  const rows: [string, string][] = [
    ['Build marker', BUILD_MARKER],
    ['App version', Constants.expoConfig?.version ?? '—'],
    ['Updates enabled', String(Updates.isEnabled)],
    ['Channel', Updates.channel ?? '—'],
    ['Runtime version', Updates.runtimeVersion ?? '—'],
    ['Update ID', Updates.updateId ?? '—'],
    ['Created at', formatDate(Updates.createdAt)],
    ['Embedded launch', String(Updates.isEmbeddedLaunch)],
  ];

  const upload = diag.lastUpload;
  const trackingRows: [string, string][] = [
    ['Tracking', diag.tracking ? 'On' : 'Off'],
    ['Session', diag.sessionId ?? '—'],
    ['Points today', String(diag.pointsToday)],
    ['Queued / sent (7 days)', `${diag.queued} / ${diag.sent}`],
    [
      'Last fix',
      diag.lastFix ? `${time(diag.lastFix.t)}, ±${Math.round(diag.lastFix.acc ?? 0)} m` : '—',
    ],
    [
      'Last upload',
      !upload
        ? '—'
        : upload.ok
          ? `${time(upload.at)} OK, ${upload.points} pts, +${upload.result.newCells} cells${upload.result.duplicate ? ' (duplicate)' : ''}`
          : `${time(upload.at)} failed: ${upload.error}`,
    ],
    ['Retry', diag.nextRetryAt ? `${time(diag.nextRetryAt)} (${diag.failedAttempts} failures)` : '—'],
    ['Battery', battery === null || battery < 0 ? '—' : `${Math.round(battery * 100)}%`],
    ['Last task error', diag.lastTaskError ?? '—'],
    ['Last close error', diag.lastCloseError ?? '—'],
  ];

  async function checkForUpdate() {
    if (__DEV__) {
      setStatus('Update checks are unavailable in development mode. Use a preview build.');
      return;
    }
    if (!Updates.isEnabled) {
      setStatus('expo-updates is disabled in this build.');
      return;
    }
    setBusy(true);
    setStatus('Checking for update…');
    try {
      const check = await Updates.checkForUpdateAsync();
      if (!check.isAvailable) {
        setStatus('Already up to date.');
        return;
      }
      setStatus('Downloading update…');
      await Updates.fetchUpdateAsync();
      setStatus('Restarting…');
      await Updates.reloadAsync();
    } catch (error) {
      setStatus(`Update failed: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setBusy(false);
    }
  }

  function shareLog() {
    const header = `Local Legend ${BUILD_MARKER} · ${Platform.OS} ${Platform.Version} · ${Updates.updateId ?? 'embedded'}`;
    const status = trackingRows.map(([k, v]) => `${k}: ${v}`).join('\n');
    Share.share({ message: `${header}\n\n${status}\n\n${log}\n\nBatches:\n${batchLog()}` });
  }

  const text = { color: dark ? '#f2f2f2' : '#111' };
  const muted = { color: dark ? '#a0a0a0' : '#555' };

  const toggle = (key: keyof DebugSettings, label: string, hint: string) => (
    <View style={styles.inline}>
      <View style={styles.flex}>
        <Text style={[styles.value, text]}>{label}</Text>
        <Text style={[styles.label, muted]}>{hint}</Text>
      </View>
      <Switch accessibilityLabel={label} value={mapSettings[key]} onValueChange={(v) => setDebugSetting(key, v)} />
    </View>
  );

  const table = (items: [string, string][]) => (
    <View style={styles.table}>
      {items.map(([label, value]) => (
        <View key={label} style={styles.row}>
          <Text style={[styles.label, muted]}>{label}</Text>
          <Text style={[styles.value, text]} selectable>
            {value}
          </Text>
        </View>
      ))}
    </View>
  );

  return (
    <SafeAreaView edges={['bottom', 'left', 'right']} style={[styles.container, { backgroundColor: dark ? '#000' : '#fff' }]}>
      <ScrollView contentContainerStyle={styles.content}>
        <Text style={[styles.heading, text]}>Tracking</Text>
        {table(trackingRows)}
        {optimized && (
          <View style={styles.inline}>
            <Text style={[styles.status, muted, styles.flex]}>
              Battery optimization is on for this app. Some phones stop tracking when the screen is off.
            </Text>
            <Pressable
              accessibilityRole="button"
              onPress={() =>
                Linking.sendIntent('android.settings.IGNORE_BATTERY_OPTIMIZATION_SETTINGS').catch(() =>
                  Linking.openSettings(),
                )
              }
              style={({ pressed }) => [styles.smallButton, pressed && styles.buttonPressed]}>
              <Text style={styles.buttonText}>Settings</Text>
            </Pressable>
          </View>
        )}
        <View style={styles.inline}>
          <Pressable
            accessibilityRole="button"
            onPress={() => void uploadNow()}
            style={({ pressed }) => [styles.button, styles.flex, pressed && styles.buttonPressed]}>
            <Text style={styles.buttonText}>Upload now</Text>
          </Pressable>
          <Pressable
            accessibilityRole="button"
            onPress={shareLog}
            style={({ pressed }) => [styles.button, styles.flex, pressed && styles.buttonPressed]}>
            <Text style={styles.buttonText}>Share log</Text>
          </Pressable>
        </View>
        <Text style={[styles.heading, text]}>Session log</Text>
        <Text style={[styles.log, text]} selectable>
          {log}
        </Text>

        <Text style={[styles.heading, text]}>Map overlays</Text>
        {toggle(
          'legendMap',
          'Legend map',
          'The painted map over the street map. While it shows, the map does not zoom out past where the painting ends. Where a tile is not painted yet, the street map shows. Kept after a restart.',
        )}
        {toggle('alignmentGrid', 'Show alignment grid', 'Claim cell outlines (zoom 21 tiles) at map zoom 17+.')}
        {toggle(
          'fakeTerritory',
          'Fake territory (50 km²)',
          'Replaces your land and sites on this phone with a synthetic realm around the map center. Nothing is uploaded.',
        )}
        {toggle('perfReadout', 'Perf readout', 'Fog build time, feature counts and JS frame drops on the map.')}

        <Text style={[styles.heading, text]}>Build</Text>
        {table(rows)}
        <Pressable
          accessibilityRole="button"
          disabled={busy}
          onPress={checkForUpdate}
          style={({ pressed }) => [styles.button, (pressed || busy) && styles.buttonPressed]}>
          <Text style={styles.buttonText}>{busy ? 'Working…' : 'Check for update'}</Text>
        </Pressable>
        {status && <Text style={[styles.status, muted]}>{status}</Text>}
        <PlayerSection />
      </ScrollView>
    </SafeAreaView>
  );
}

const mono = Platform.select({ ios: 'Menlo', default: 'monospace' });

const styles = StyleSheet.create({
  container: { flex: 1 },
  content: { padding: 24, gap: 24 },
  heading: { fontSize: 22, fontWeight: '700' },
  table: { gap: 12 },
  row: { gap: 2 },
  inline: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  flex: { flex: 1 },
  label: { fontSize: 13 },
  value: { fontSize: 16, fontFamily: mono },
  log: { fontSize: 12, fontFamily: mono },
  button: { backgroundColor: '#208AEF', borderRadius: 8, paddingVertical: 14, alignItems: 'center' },
  smallButton: { backgroundColor: '#208AEF', borderRadius: 8, paddingVertical: 8, paddingHorizontal: 12 },
  buttonPressed: { opacity: 0.6 },
  buttonText: { color: '#fff', fontSize: 16, fontWeight: '600' },
  status: { fontSize: 14 },
});
