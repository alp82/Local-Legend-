// Compatibility with the layer's earlier name. Remove with the compatibility section of
// supabase/migrations/20261126200000_legend_map_rename.sql.
//
// Once, at start-up and before any painting, the worker copies every file of the old bucket
// (fantasy-tiles) to the same path in legend-map-tiles, server-side. Then the database checks the
// copy (every old file present with the same size) and points app versions from before the
// rename at the new bucket. After that the candidates list is empty and this returns at once.
export const OLD_BUCKET = 'fantasy-tiles';

/**
 * @param {{ rpc: Function, copyFrom: Function }} sb
 * @param {{ log: (msg: string) => void, beat?: (state: string) => Promise<void>, concurrency?: number }} opts
 * @returns {Promise<object>} what finish_legend_map_bucket_copy returned
 */
export async function copyOldBucket(sb, { log, beat = async () => {}, concurrency = 8 }) {
  let copied = 0;
  for (;;) {
    const names = ((await sb.rpc('legend_map_bucket_copy_candidates', { p_limit: 500 })) ?? []).map((r) => r.name);
    if (!names.length) break;
    if (!copied) log(`copying the old bucket ${OLD_BUCKET} to the new one before painting`);
    const errors = [];
    let ok = 0;
    let next = 0;
    await Promise.all(
      Array.from({ length: Math.min(concurrency, names.length) }, async () => {
        while (next < names.length) {
          const name = names[next++];
          try {
            await sb.copyFrom(OLD_BUCKET, name);
            ok++;
          } catch (e) {
            errors.push(`${name}: ${e.message}`);
          }
        }
      }),
    );
    copied += ok;
    await beat(`copying the old bucket: ${copied} files`);
    // A file that can't be copied comes back in the next list; when only such files are left, stop.
    if (!ok) throw new Error(`copying the old bucket made no progress (${errors.length} failed): ${errors.slice(0, 3).join('; ')}`);
    if (errors.length) log(`copying the old bucket: ${errors.length} failed, retrying them (${errors[0]})`);
  }
  const r = await sb.rpc('finish_legend_map_bucket_copy');
  if (r?.already) return r;
  if (!r?.switched) throw new Error(`the copy of the old bucket is incomplete: ${r?.copied} of ${r?.objects} files present with the same size`);
  log(`old bucket copied and checked: ${r.objects} files, ${(Number(r.bytes) / 1048576).toFixed(1)} MB; app versions from before the rename now read the new bucket`);
  return r;
}
