// Placeholder resource and Ruler readout for testers. Shows what the server
// returns; the app never computes a reward.

import { StyleSheet, Text, View } from 'react-native';

import type { Economy } from '@/lib/economyApi';
import { rulerProgress } from '@/lib/rulerLevel';

const RESOURCES = [
  { key: 'gold', label: 'Gold', color: '#E8B23A' },
  { key: 'wood', label: 'Wood', color: '#B5895A' },
  { key: 'stone', label: 'Stone', color: '#B9BEC7' },
  { key: 'crystal', label: 'Crystal', color: '#8FD3F4' },
  { key: 'gems', label: 'Gems', color: '#E58FD8' },
] as const;

const number = new Intl.NumberFormat('en-US');

function km(value: number) {
  return value.toFixed(value < 10 ? 2 : 1);
}

export function ResourceBar({ economy, error }: { economy: Economy | null; error: string | null }) {
  if (!economy) {
    return (
      <View style={styles.bar}>
        <Text style={styles.muted}>{error ? `Economy: ${error}` : 'Loading resources…'}</Text>
      </View>
    );
  }
  const ruler = rulerProgress(economy.rulerXp);
  const t = economy.today;
  return (
    <View style={styles.bar} accessibilityLabel="Resources and Ruler level">
      <View style={styles.row}>
        {RESOURCES.map((r) => (
          <View key={r.key} style={styles.resource}>
            <Text style={[styles.label, { color: r.color }]}>{r.label}</Text>
            <Text style={styles.value}>{number.format(economy.resources[r.key])}</Text>
          </View>
        ))}
      </View>
      <View style={styles.row}>
        <Text style={styles.ruler}>Ruler {economy.rulerLevel}</Text>
        <View style={styles.track} accessibilityLabel={`Ruler XP ${ruler.intoLevel} of ${ruler.levelSpan ?? 'max'}`}>
          <View style={[styles.fill, { width: `${Math.round(ruler.fraction * 100)}%` }]} />
        </View>
        <Text style={styles.muted}>
          {ruler.levelSpan === null ? `${number.format(economy.rulerXp)} XP` : `${number.format(ruler.intoLevel)}/${number.format(ruler.levelSpan)} XP`}
        </Text>
      </View>
      <Text style={styles.muted}>
        {`Today: ${km(t.newGroundKm)} km new ground · ${km(t.usualPaidKm)}/${km(t.usualCapKm)} km own land`}
        {economy.pendingTerrainKm > 0 ? ' · reading terrain…' : ''}
      </Text>
      {error && <Text style={styles.error}>{error}</Text>}
    </View>
  );
}

const styles = StyleSheet.create({
  bar: {
    marginHorizontal: 12,
    backgroundColor: 'rgba(20,28,44,0.85)',
    borderRadius: 12,
    paddingHorizontal: 12,
    paddingVertical: 8,
    gap: 6,
  },
  row: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 8 },
  resource: { alignItems: 'center', flex: 1 },
  label: { fontSize: 11, fontWeight: '700' },
  value: { color: '#fff', fontSize: 15, fontWeight: '700', fontVariant: ['tabular-nums'] },
  ruler: { color: '#fff', fontSize: 14, fontWeight: '700' },
  track: { flex: 1, height: 6, borderRadius: 3, backgroundColor: 'rgba(255,255,255,0.2)', overflow: 'hidden' },
  fill: { height: 6, backgroundColor: '#E8B23A' },
  muted: { color: '#c8ccd6', fontSize: 12 },
  error: { color: '#ffb4a8', fontSize: 12 },
});
