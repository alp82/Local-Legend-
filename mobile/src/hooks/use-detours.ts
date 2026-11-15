import * as Location from 'expo-location';
import { useNavigation } from 'expo-router';
import { useEffect, useEffectEvent, useRef, useState } from 'react';
import { AppState } from 'react-native';

import { onQueueEvent } from '@/lib/db';
import { fetchDetours, type Detours } from '@/lib/detoursApi';
import { supabaseConfigError } from '@/lib/supabase';

/** Wait before asking again for spot areas that were still loading. */
const PENDING_RETRY_MS = 20_000;
/**
 * Follow-up calls per load, at most. The server loads 4 areas per call; a long commute
 * needs a few calls. An area whose download failed is retried only after 10 minutes, so
 * without a limit the hook would keep asking.
 */
const MAX_RETRIES = 6;
/** A position older than this isn't worth sending. */
const POSITION_MAX_AGE_MS = 30 * 60 * 1000;

function message(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

/** The phone's last known position, if location access is granted. Never prompts. */
async function lastPosition(): Promise<{ lat: number; lng: number } | null> {
  try {
    const permission = await Location.getForegroundPermissionsAsync();
    if (!permission.granted) return null;
    const last = await Location.getLastKnownPositionAsync({ maxAge: POSITION_MAX_AGE_MS });
    return last ? { lat: last.coords.latitude, lng: last.coords.longitude } : null;
  } catch {
    return null;
  }
}

/**
 * Today's detour offers. Loaded when the screen gains focus, when the app
 * comes back to the foreground (after 4 a.m. that makes the new day's
 * offers), and after every upload (an upload can collect one). While the
 * server still has map areas to load for spots, it asks again: after 1 s
 * when areas wait their turn, after 20 s when downloads are in progress.
 */
export function useDetours(enabled: boolean) {
  const [detours, setDetours] = useState<Detours | null>(null);
  const [error, setError] = useState<string | null>(supabaseConfigError);
  const retryTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  async function load(retry = 0) {
    if (supabaseConfigError || !enabled) return;
    try {
      const d = await fetchDetours(await lastPosition());
      setDetours(d);
      setError(null);
      // Areas still loading, or within reach and not loaded yet: the day's empty offer
      // slots fill once they are.
      if ((d.pending > 0 || d.missingAreas > 0) && retry < MAX_RETRIES && !retryTimer.current) {
        retryTimer.current = setTimeout(() => {
          retryTimer.current = null;
          load(retry + 1);
        }, d.pending > 0 ? PENDING_RETRY_MS : 1_000);
      }
    } catch (e) {
      setError(message(e));
    }
  }

  const onEvent = useEffectEvent(() => {
    load();
  });

  const navigation = useNavigation();

  useEffect(() => {
    onEvent();
    const unfocus = navigation.addListener('focus', () => onEvent());
    const sub = AppState.addEventListener('change', (s) => s === 'active' && onEvent());
    const unsubscribe = onQueueEvent((e) => e === 'upload' && onEvent());
    return () => {
      unfocus();
      sub.remove();
      unsubscribe();
      if (retryTimer.current) clearTimeout(retryTimer.current);
      retryTimer.current = null;
    };
  }, [navigation, enabled]);

  return { detours, error, reload: () => load() };
}
