// The kingdom screen: four plots (Keep, Treasury, Walls, Barracks), the day's
// construction, and Pikemen. Placeholder layout; Keep and Barracks use the art
// from UI Assets/, Treasury and Walls a plain tile.

import { useState } from 'react';
import { ActivityIndicator, Image, type ImageSourcePropType, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { ResourceBar } from '@/components/resource-bar';
import { useKingdom } from '@/hooks/use-kingdom';
import { affordablePikemen, artTier, formatResources, nextLevel, pikemenCost, type Blocker } from '@/lib/kingdom';
import {
  buildBuilding,
  PLOTS,
  recruitPikemen,
  type BuildResult,
  type PlotId,
  type RecruitResult,
} from '@/lib/kingdomApi';
import { rules } from '@/lib/rules.generated';

const ART: Partial<Record<PlotId, Record<1 | 2 | 3, ImageSourcePropType>>> = {
  keep: {
    1: require('@/assets/kingdom/keep-1.png'),
    2: require('@/assets/kingdom/keep-2.png'),
    3: require('@/assets/kingdom/keep-3.png'),
  },
  barracks: {
    1: require('@/assets/kingdom/barracks-1.png'),
    2: require('@/assets/kingdom/barracks-2.png'),
    3: require('@/assets/kingdom/barracks-3.png'),
  },
};

const TILE_COLORS: Record<PlotId, string> = {
  keep: '#6B5B95',
  treasury: '#B8860B',
  walls: '#7A7F87',
  barracks: '#8B3A3A',
};

function timeOf(iso: string | null) {
  if (!iso) return 'tomorrow';
  const d = new Date(iso);
  return d.toLocaleString('en-US', { weekday: 'short', hour: 'numeric', minute: '2-digit' });
}

function blockerText(b: Blocker) {
  switch (b.reason) {
    case 'ruler_level':
      return `Needs Ruler level ${b.required}`;
    case 'keep_level':
      return `Needs Keep level ${b.required}`;
    case 'daily_limit':
      return `Next construction ${timeOf(b.nextBuildAt)}`;
    case 'not_enough':
      return `Missing ${formatResources(b.missing)}`;
  }
}

function buildOutcome(r: BuildResult) {
  const name = rules.buildings[r.building].name;
  if (r.ok) return `${name} level ${r.level} built. +${r.xp} XP${r.levelUp ? ` · Ruler level ${r.rulerLevel}!` : ''}`;
  switch (r.reason) {
    case 'already_built':
    case 'not_next_level':
      return `${name} is already level ${r.level}.`;
    case 'max_level':
      return `${name} is at its top level.`;
    case 'ruler_level':
      return `${name} level ${r.level} needs Ruler level ${r.required}.`;
    case 'keep_level':
      return `${name} level ${r.level} needs Keep level ${r.required}.`;
    case 'daily_limit':
      return `You've built today. Next construction ${timeOf(r.nextBuildAt)}.`;
    case 'not_enough':
      return `Missing ${formatResources(r.missing)}.`;
  }
}

function recruitOutcome(r: RecruitResult) {
  if (r.ok) return `${r.count} Pikemen recruited. Garrison: ${r.garrison}.`;
  switch (r.reason) {
    case 'needs_building':
      return 'Build a Barracks to recruit Pikemen.';
    case 'not_enough_recruits':
      return `Only ${r.available} recruits are available this week.`;
    case 'not_enough':
      return `Missing ${formatResources(r.missing)}.`;
  }
}

export default function KingdomScreen() {
  const { state, error, busy, run } = useKingdom();
  const [notice, setNotice] = useState<string | null>(null);
  const [recruitCount, setRecruitCount] = useState(1);

  async function act<R extends BuildResult | RecruitResult>(call: () => Promise<R>, describe: (r: R) => string) {
    setNotice(null);
    const r = await run(call);
    if (r) setNotice(describe(r));
  }

  if (!state) {
    return (
      <SafeAreaView style={styles.center} edges={['bottom']}>
        {error ? <Text style={styles.error}>{error}</Text> : <ActivityIndicator color="#fff" />}
      </SafeAreaView>
    );
  }

  const k = state.kingdom;
  const balances = state.resources;
  const pool = k.recruits.pikeman;
  const canRecruit = affordablePikemen(k, balances);
  const count = Math.max(1, Math.min(recruitCount, Math.max(1, canRecruit)));

  return (
    <SafeAreaView style={styles.screen} edges={['bottom']}>
      <ScrollView contentContainerStyle={styles.content}>
        <ResourceBar economy={state} error={null} />

        <View style={styles.status}>
          <Text style={styles.statusText}>
            {k.buildsToday < k.buildsPerDay
              ? 'You can build once today.'
              : `You've built today. Next construction ${timeOf(k.nextBuildAt)}.`}
          </Text>
          {k.caps && (
            <Text style={styles.muted}>
              {`Treasury holds up to ${formatResources({ gold: k.caps.goldCap, wood: k.caps.woodCap, stone: k.caps.stoneCap })}.`}
            </Text>
          )}
        </View>

        {notice && (
          <Text style={styles.notice} accessibilityLiveRegion="polite">
            {notice}
          </Text>
        )}
        {error && <Text style={styles.error}>{error}</Text>}

        <View style={styles.grid}>
          {PLOTS.map((id) => {
            const def = rules.buildings[id];
            const level = k.buildings[id];
            const next = nextLevel(id, k, balances, state.rulerLevel);
            const art = ART[id]?.[artTier(level, def.maxLevel)];
            return (
              <View key={id} style={styles.plot} accessibilityLabel={`${def.name}, level ${level}`}>
                {art ? (
                  <Image source={art} style={[styles.art, level === 0 && styles.empty]} resizeMode="contain" />
                ) : (
                  <View style={[styles.tile, { backgroundColor: TILE_COLORS[id] }, level === 0 && styles.empty]}>
                    <Text style={styles.tileText}>{def.name.slice(0, 1)}</Text>
                  </View>
                )}
                <Text style={styles.name}>{def.name}</Text>
                <Text style={styles.muted}>{level === 0 ? 'Empty plot' : `Level ${level} of ${def.maxLevel}`}</Text>
                {next ? (
                  <>
                    <Text style={styles.cost}>{formatResources(next.cost)}</Text>
                    <Pressable
                      accessibilityRole="button"
                      accessibilityState={{ disabled: busy || next.blocker !== null }}
                      disabled={busy || next.blocker !== null}
                      onPress={() => act(() => buildBuilding(id, next.level), buildOutcome)}
                      style={({ pressed }) => [styles.button, (busy || next.blocker) && styles.buttonOff, pressed && styles.pressed]}>
                      <Text style={styles.buttonText}>{level === 0 ? 'Build' : `Upgrade to ${next.level}`}</Text>
                    </Pressable>
                    <Text style={styles.hint}>{next.blocker ? blockerText(next.blocker) : `+${next.constructionXp} XP`}</Text>
                  </>
                ) : (
                  <Text style={styles.hint}>Top level</Text>
                )}
              </View>
            );
          })}
        </View>

        <View style={styles.card}>
          <Text style={styles.name}>Garrison</Text>
          <Text style={styles.statusText}>{`${k.garrison.pikeman ?? 0} Pikemen`}</Text>
          {k.buildings.barracks < rules.units.pikeman.buildingLevel ? (
            <Text style={styles.muted}>Build a Barracks to recruit Pikemen.</Text>
          ) : (
            <>
              <Text style={styles.muted}>
                {`${pool.available} recruits available`}
                {pool.lastWeek > 0 ? ` (${pool.lastWeek} leave on Monday)` : ''}
                {` · new recruits ${timeOf(k.nextRecruitsAt)}`}
              </Text>
              <View style={styles.stepper}>
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel="Fewer"
                  onPress={() => setRecruitCount(Math.max(1, count - 1))}
                  style={styles.stepButton}>
                  <Text style={styles.buttonText}>−</Text>
                </Pressable>
                <Text style={styles.count}>{count}</Text>
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel="More"
                  onPress={() => setRecruitCount(Math.min(Math.max(1, canRecruit), count + 1))}
                  style={styles.stepButton}>
                  <Text style={styles.buttonText}>+</Text>
                </Pressable>
                <Pressable
                  accessibilityRole="button"
                  onPress={() => setRecruitCount(Math.max(1, canRecruit))}
                  style={styles.stepButton}>
                  <Text style={styles.buttonText}>Max</Text>
                </Pressable>
              </View>
              <Pressable
                accessibilityRole="button"
                accessibilityState={{ disabled: busy || canRecruit < 1 }}
                disabled={busy || canRecruit < 1}
                onPress={() => act(() => recruitPikemen(count), recruitOutcome)}
                style={({ pressed }) => [styles.button, (busy || canRecruit < 1) && styles.buttonOff, pressed && styles.pressed]}>
                <Text style={styles.buttonText}>{`Recruit ${count} for ${formatResources(pikemenCost(count))}`}</Text>
              </Pressable>
            </>
          )}
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: '#1B2333' },
  center: { flex: 1, backgroundColor: '#1B2333', alignItems: 'center', justifyContent: 'center', padding: 16 },
  content: { paddingVertical: 12, gap: 12 },
  status: { marginHorizontal: 12, gap: 4 },
  statusText: { color: '#fff', fontSize: 15, fontWeight: '600' },
  muted: { color: '#c8ccd6', fontSize: 13 },
  notice: { marginHorizontal: 12, color: '#fff', backgroundColor: 'rgba(32,138,239,0.35)', borderRadius: 8, padding: 10 },
  error: { marginHorizontal: 12, color: '#fff', backgroundColor: 'rgba(160,30,30,0.85)', borderRadius: 8, padding: 10 },
  grid: { flexDirection: 'row', flexWrap: 'wrap', paddingHorizontal: 6 },
  plot: {
    width: '50%',
    padding: 6,
    alignItems: 'center',
    gap: 4,
  },
  art: { width: '100%', height: 130 },
  tile: { width: 110, height: 110, borderRadius: 16, alignItems: 'center', justifyContent: 'center', marginVertical: 10 },
  tileText: { color: '#fff', fontSize: 44, fontWeight: '800' },
  empty: { opacity: 0.35 },
  name: { color: '#fff', fontSize: 17, fontWeight: '700' },
  cost: { color: '#E8B23A', fontSize: 13, textAlign: 'center' },
  hint: { color: '#c8ccd6', fontSize: 12, textAlign: 'center', minHeight: 32 },
  button: { backgroundColor: '#208AEF', borderRadius: 8, paddingHorizontal: 14, paddingVertical: 10, alignItems: 'center', alignSelf: 'stretch' },
  buttonOff: { backgroundColor: '#4A5263' },
  buttonText: { color: '#fff', fontSize: 15, fontWeight: '600' },
  pressed: { opacity: 0.7 },
  card: { marginHorizontal: 12, backgroundColor: 'rgba(20,28,44,0.85)', borderRadius: 12, padding: 14, gap: 8 },
  stepper: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  stepButton: { backgroundColor: '#2F3A50', borderRadius: 8, paddingHorizontal: 14, paddingVertical: 8 },
  count: { color: '#fff', fontSize: 18, fontWeight: '700', minWidth: 36, textAlign: 'center' },
});
