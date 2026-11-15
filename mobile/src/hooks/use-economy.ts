import { useNavigation } from 'expo-router';
import { useEffect, useEffectEvent, useRef, useState } from 'react';
import { AppState } from 'react-native';

import { onQueueEvent } from '@/lib/db';
import { classifyTerrain, fetchEconomy, type Economy } from '@/lib/economyApi';
import { supabaseConfigError } from '@/lib/supabase';

/** Wait before asking again for terrain that was still loading. */
const TERRAIN_RETRY_MS = 20_000;

function message(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

/**
 * The player's economy, loaded whenever the screen gains focus (so it shows
 * what the kingdom screen spent), when the app comes back to the foreground
 * (which also pays the Keep tax after 4 a.m.), and after every upload. When walks wait for terrain, it asks the terrain function to
 * classify it, then reloads.
 */
export function useEconomy() {
  const [economy, setEconomy] = useState<Economy | null>(null);
  const [error, setError] = useState<string | null>(supabaseConfigError);
  const terrainTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  async function load() {
    if (supabaseConfigError) return;
    try {
      const e = await fetchEconomy();
      setEconomy(e);
      setError(null);
      if (e.pendingTerrainKm > 0 && !terrainTimer.current) {
        const { classified, pending } = await classifyTerrain();
        if (classified > 0) setEconomy(await fetchEconomy());
        if (pending > 0) {
          terrainTimer.current = setTimeout(() => {
            terrainTimer.current = null;
            load();
          }, TERRAIN_RETRY_MS);
        }
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
      if (terrainTimer.current) clearTimeout(terrainTimer.current);
    };
  }, [navigation]);

  return { economy, error, reload: load };
}
