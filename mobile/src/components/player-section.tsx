import { useEffect, useEffectEvent, useState } from 'react';
import { Platform, Pressable, StyleSheet, Text, TextInput, View, useColorScheme } from 'react-native';

import { ensureSession, loadPlayerState, savePlayerState, type PlayerState } from '@/lib/playerState';
import { supabaseConfigError } from '@/lib/supabase';

// Test-only game state used to verify save/reload. Replaced once real tracking state exists.
function stepsFrom(state: PlayerState['state'] | undefined): number {
  if (state && typeof state === 'object' && !Array.isArray(state) && typeof state.steps === 'number') {
    return state.steps;
  }
  return 0;
}

async function fetchPlayer() {
  const user = await ensureSession();
  return { user, row: await loadPlayerState() };
}

function message(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

export function PlayerSection() {
  const dark = useColorScheme() === 'dark';
  const [userId, setUserId] = useState<string | null>(null);
  const [displayName, setDisplayName] = useState('');
  const [steps, setSteps] = useState(0);
  const [updatedAt, setUpdatedAt] = useState<string | null>(null);
  const [busy, setBusy] = useState<'loading' | 'saving' | null>(supabaseConfigError ? null : 'loading');
  const [error, setError] = useState<string | null>(supabaseConfigError);

  function apply(row: PlayerState | null) {
    setDisplayName(row?.display_name ?? '');
    setSteps(stepsFrom(row?.state));
    setUpdatedAt(row?.updated_at ?? null);
  }

  function onLoaded({ user, row }: Awaited<ReturnType<typeof fetchPlayer>>) {
    setUserId(user.id);
    apply(row);
    setBusy(null);
  }

  function onFailed(e: unknown) {
    setError(message(e));
    setBusy(null);
  }

  function reload() {
    setBusy('loading');
    setError(null);
    fetchPlayer().then(onLoaded, onFailed);
  }

  async function save() {
    setBusy('saving');
    setError(null);
    try {
      apply(await savePlayerState({ displayName, state: { steps } }));
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(null);
    }
  }

  // Sign in (anonymously on first launch) and load the saved row once on mount.
  const onMountLoaded = useEffectEvent(onLoaded);
  const onMountFailed = useEffectEvent(onFailed);
  useEffect(() => {
    if (supabaseConfigError) return;
    fetchPlayer().then(
      (result) => onMountLoaded(result),
      (e) => onMountFailed(e),
    );
  }, []);

  const text = { color: dark ? '#f2f2f2' : '#111' };
  const muted = { color: dark ? '#a0a0a0' : '#555' };
  const disabled = busy !== null || supabaseConfigError !== null;

  return (
    <View style={styles.section}>
      <Text style={[styles.heading, text]}>Player</Text>

      <View style={styles.row}>
        <Text style={[styles.label, muted]}>User ID</Text>
        <Text style={[styles.value, text]} selectable>
          {userId ? `${userId.slice(0, 8)}…${userId.slice(-4)}` : '—'}
        </Text>
      </View>

      <View style={styles.row}>
        <Text style={[styles.label, muted]}>Display name</Text>
        <TextInput
          value={displayName}
          onChangeText={setDisplayName}
          placeholder="1–32 characters"
          placeholderTextColor={dark ? '#666' : '#999'}
          maxLength={32}
          autoCorrect={false}
          editable={!disabled}
          style={[styles.input, text, { borderColor: dark ? '#444' : '#ccc' }]}
        />
      </View>

      <View style={styles.row}>
        <Text style={[styles.label, muted]}>Steps walked (test state)</Text>
        <View style={styles.inline}>
          <Text style={[styles.value, text]}>{steps}</Text>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Add 100 steps"
            disabled={disabled}
            onPress={() => setSteps((s) => s + 100)}
            style={({ pressed }) => [styles.smallButton, (pressed || disabled) && styles.pressed]}>
            <Text style={styles.buttonText}>+100</Text>
          </Pressable>
        </View>
      </View>

      <View style={styles.row}>
        <Text style={[styles.label, muted]}>Last saved</Text>
        <Text style={[styles.value, text]}>{updatedAt ? new Date(updatedAt).toISOString() : 'Never'}</Text>
      </View>

      <View style={styles.inline}>
        <Pressable
          accessibilityRole="button"
          disabled={disabled}
          onPress={save}
          style={({ pressed }) => [styles.button, (pressed || disabled) && styles.pressed]}>
          <Text style={styles.buttonText}>{busy === 'saving' ? 'Saving…' : 'Save'}</Text>
        </Pressable>
        <Pressable
          accessibilityRole="button"
          disabled={disabled}
          onPress={reload}
          style={({ pressed }) => [styles.button, (pressed || disabled) && styles.pressed]}>
          <Text style={styles.buttonText}>{busy === 'loading' ? 'Loading…' : 'Reload'}</Text>
        </Pressable>
      </View>

      {error && <Text style={styles.error}>{error}</Text>}
    </View>
  );
}

const styles = StyleSheet.create({
  section: { gap: 12 },
  heading: { fontSize: 22, fontWeight: '700' },
  row: { gap: 2 },
  inline: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  label: { fontSize: 13 },
  value: { fontSize: 16, fontFamily: Platform.select({ ios: 'Menlo', default: 'monospace' }) },
  input: { fontSize: 16, borderWidth: 1, borderRadius: 8, paddingHorizontal: 12, paddingVertical: 10 },
  button: { flex: 1, backgroundColor: '#208AEF', borderRadius: 8, paddingVertical: 14, alignItems: 'center' },
  smallButton: { backgroundColor: '#208AEF', borderRadius: 8, paddingVertical: 6, paddingHorizontal: 12 },
  pressed: { opacity: 0.6 },
  buttonText: { color: '#fff', fontSize: 16, fontWeight: '600' },
  error: { color: '#D93025', fontSize: 14 },
});
