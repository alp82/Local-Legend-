// On-map perf readout for the debug toggles: data sizes, fog build times and JS frame
// pacing. Frame pacing comes from requestAnimationFrame deltas on the JS thread, so it
// shows JS jank while panning (the map itself renders on its own native thread). Keeps
// its own state so its once-a-second refresh doesn't re-render the map screen.
import { memo, useEffect, useState } from 'react';
import { Platform, StyleSheet, Text, View } from 'react-native';

export type PerfStats = {
  label: string;
  fogBuildMs: number;
  fogJsonMs: number;
  fogJsonMB: number;
  polygons: number;
  rings: number;
  vertices: number;
  sites: number;
  zoom: number;
  generateMs: number | null;
};

const FRAME_MS = 1000 / 60;

type Pacing = { fps: number; worstMs: number; drops: number; totalDrops: number };

function useFramePacing(): Pacing {
  const [pacing, setPacing] = useState<Pacing>({ fps: 0, worstMs: 0, drops: 0, totalDrops: 0 });
  useEffect(() => {
    let frame = 0;
    let last = 0;
    let frames = 0;
    let worst = 0;
    let drops = 0;
    let totalDrops = 0;
    let windowStart = 0;
    const tick = (t: number) => {
      if (last > 0) {
        const dt = t - last;
        frames++;
        worst = Math.max(worst, dt);
        // Frames missed in this gap (a 50 ms gap at 60 Hz drops 2).
        const missed = Math.max(0, Math.round(dt / FRAME_MS) - 1);
        drops += missed;
        totalDrops += missed;
      } else windowStart = t;
      last = t;
      if (t - windowStart >= 1000) {
        setPacing({ fps: Math.round((frames * 1000) / (t - windowStart)), worstMs: Math.round(worst), drops, totalDrops });
        frames = 0;
        worst = 0;
        drops = 0;
        windowStart = t;
      }
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, []);
  return pacing;
}

export const PerfReadout = memo(function PerfReadout({ stats }: { stats: PerfStats }) {
  const p = useFramePacing();
  const lines = [
    `${stats.label} · z${stats.zoom.toFixed(1)}`,
    `fog build ${stats.fogBuildMs.toFixed(1)} ms · JSON ${stats.fogJsonMs.toFixed(0)} ms, ${stats.fogJsonMB.toFixed(2)} MB`,
    `${stats.polygons} poly · ${stats.rings} rings · ${stats.vertices} vtx · ${stats.sites} sites`,
    `JS ${p.fps} fps · worst ${p.worstMs} ms · drops ${p.drops}/s (${p.totalDrops} total)`,
  ];
  if (stats.generateMs !== null) lines.push(`fake realm generated in ${stats.generateMs} ms`);
  return (
    <View style={styles.box} pointerEvents="none">
      {lines.map((l) => (
        <Text key={l} style={styles.text}>
          {l}
        </Text>
      ))}
    </View>
  );
});

const styles = StyleSheet.create({
  box: { backgroundColor: 'rgba(0,0,0,0.7)', borderRadius: 8, padding: 8, alignSelf: 'flex-start' },
  text: { color: '#9effa0', fontSize: 11, fontFamily: Platform.select({ ios: 'Menlo', default: 'monospace' }) },
});
