// Client setup follows the Supabase Expo React Native quickstart:
// https://supabase.com/docs/guides/getting-started/quickstarts/expo-react-native
import 'react-native-url-polyfill/auto';
import 'expo-sqlite/localStorage/install';

import { createClient } from '@supabase/supabase-js';
import { AppState, Platform } from 'react-native';

import type { Database } from './database.types';

const supabaseUrl = process.env.EXPO_PUBLIC_SUPABASE_URL;
const supabaseKey = process.env.EXPO_PUBLIC_SUPABASE_KEY;

/** Human-readable reason the client can't be created, or null when configured. */
export const supabaseConfigError =
  supabaseUrl && supabaseKey
    ? null
    : `Missing ${[
        !supabaseUrl && 'EXPO_PUBLIC_SUPABASE_URL',
        !supabaseKey && 'EXPO_PUBLIC_SUPABASE_KEY',
      ]
        .filter(Boolean)
        .join(' and ')}. Set it in mobile/.env (see .env.example) or the EAS environment, then rebuild or republish.`;

export const supabase =
  supabaseUrl && supabaseKey
    ? createClient<Database>(supabaseUrl, supabaseKey, {
        auth: {
          storage: localStorage,
          autoRefreshToken: true,
          persistSession: true,
          detectSessionInUrl: false,
        },
      })
    : null;

// Refresh tokens only while the app is foregrounded (supabase.auth.startAutoRefresh docs).
// Registered once, at module load.
if (supabase && Platform.OS !== 'web') {
  AppState.addEventListener('change', (state) => {
    if (state === 'active') {
      supabase.auth.startAutoRefresh();
    } else {
      supabase.auth.stopAutoRefresh();
    }
  });
}
