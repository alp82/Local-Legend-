import { useEffect, useEffectEvent, useState } from 'react';
import { AppState } from 'react-native';

import { fetchKingdom, type BuildResult, type KingdomState, type RecruitResult } from '@/lib/kingdomApi';
import { supabaseConfigError } from '@/lib/supabase';

function message(error: unknown) {
  if (error instanceof Error) return error.message;
  if (typeof error === 'object' && error && 'message' in error) return String((error as { message: unknown }).message);
  return String(error);
}

/**
 * The player's economy and kingdom, loaded on mount and when the app comes
 * back to the foreground (which also pays the Keep tax after 4 a.m.).
 * `run` performs a construction or recruitment and shows its result.
 */
export function useKingdom() {
  const [state, setState] = useState<KingdomState | null>(null);
  const [error, setError] = useState<string | null>(supabaseConfigError);
  const [busy, setBusy] = useState(false);

  function load() {
    if (supabaseConfigError) return;
    fetchKingdom().then(
      (k) => {
        setState(k);
        setError(null);
      },
      (e) => setError(message(e)),
    );
  }

  /** Runs a build or recruit call and applies the economy and kingdom it returns. Resolves with the result, or null on error. */
  async function run<R extends BuildResult | RecruitResult>(call: () => Promise<R>): Promise<R | null> {
    setBusy(true);
    try {
      const r = await call();
      setState((s) => (s ? { ...s, ...r.economy, kingdom: r.kingdom } : s));
      setError(null);
      return r;
    } catch (e) {
      setError(message(e));
      return null;
    } finally {
      setBusy(false);
    }
  }

  const onEvent = useEffectEvent(() => {
    load();
  });

  useEffect(() => {
    onEvent();
    const sub = AppState.addEventListener('change', (s) => s === 'active' && onEvent());
    return () => sub.remove();
  }, []);

  return { state, error, busy, run, reload: load };
}
