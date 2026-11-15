import * as Network from 'expo-network';
import { DarkTheme, DefaultTheme, Stack, ThemeProvider } from 'expo-router';
import { useEffect } from 'react';
import { AppState, useColorScheme } from 'react-native';

import { recordAppOpen } from '@/lib/analyticsApi';
import { uploadNow } from '@/lib/queue';
// Importing tracking also defines the background location task at module load (needed for headless starts).
import { resumeTrackingIfWanted } from '@/lib/tracking';

function onForeground() {
  // Analytics: every launch and every return to the foreground is one app open.
  recordAppOpen().catch(() => {});
  resumeTrackingIfWanted().catch(() => {});
  void uploadNow();
}

export default function RootLayout() {
  const colorScheme = useColorScheme();

  useEffect(() => {
    onForeground();
    const appState = AppState.addEventListener('change', (state) => {
      if (state === 'active') onForeground();
    });
    let online = true;
    const network = Network.addNetworkStateListener(({ isConnected, isInternetReachable }) => {
      const nowOnline = Boolean(isConnected) && isInternetReachable !== false;
      if (nowOnline && !online) void uploadNow();
      online = nowOnline;
    });
    return () => {
      appState.remove();
      network.remove();
    };
  }, []);

  return (
    <ThemeProvider value={colorScheme === 'dark' ? DarkTheme : DefaultTheme}>
      <Stack screenOptions={{ headerShown: false }}>
        <Stack.Screen name="debug" options={{ headerShown: true, title: 'Debug' }} />
        <Stack.Screen name="kingdom" options={{ headerShown: true, title: 'Kingdom' }} />
      </Stack>
    </ThemeProvider>
  );
}
