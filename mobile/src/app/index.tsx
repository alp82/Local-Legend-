import Constants from 'expo-constants';
import * as Updates from 'expo-updates';
import { useState } from 'react';
import { Platform, Pressable, ScrollView, StyleSheet, Text, View, useColorScheme } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { PlayerSection } from '@/components/player-section';

// Change this value and publish with `npm run update:preview -- "message"` to verify OTA delivery.
const BUILD_MARKER = 'v2';

function formatDate(date: Date | null) {
  return date ? date.toISOString() : '—';
}

export default function HomeScreen() {
  const dark = useColorScheme() === 'dark';
  const [status, setStatus] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

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

  const text = { color: dark ? '#f2f2f2' : '#111' };
  const muted = { color: dark ? '#a0a0a0' : '#555' };

  return (
    <SafeAreaView style={[styles.container, { backgroundColor: dark ? '#000' : '#fff' }]}>
      <ScrollView contentContainerStyle={styles.content}>
        <Text style={[styles.title, text]}>Local Legend</Text>
        <View style={styles.table}>
          {rows.map(([label, value]) => (
            <View key={label} style={styles.row}>
              <Text style={[styles.label, muted]}>{label}</Text>
              <Text style={[styles.value, text]} selectable>
                {value}
              </Text>
            </View>
          ))}
        </View>
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

const styles = StyleSheet.create({
  container: { flex: 1 },
  content: { padding: 24, gap: 24 },
  title: { fontSize: 32, fontWeight: '700' },
  table: { gap: 12 },
  row: { gap: 2 },
  label: { fontSize: 13 },
  value: { fontSize: 16, fontFamily: Platform.select({ ios: 'Menlo', default: 'monospace' }) },
  button: { backgroundColor: '#208AEF', borderRadius: 8, paddingVertical: 14, alignItems: 'center' },
  buttonPressed: { opacity: 0.6 },
  buttonText: { color: '#fff', fontSize: 16, fontWeight: '600' },
  status: { fontSize: 14 },
});
