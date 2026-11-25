// The few Supabase calls the worker makes, over plain HTTP: RPCs with the secret key, and
// uploads to and downloads from the public fantasy-tiles bucket.
const BUCKET = 'fantasy-tiles';
/** Tiles never change once painted (a new painter is a new version path). */
const CACHE_CONTROL = 'public, max-age=31536000, immutable';

/**
 * @param {string} url Project URL, such as https://<ref>.supabase.co or http://127.0.0.1:54321
 * @param {string} key Secret key (sb_secret_...) or a legacy service_role JWT
 */
export function createSupabase(url, key) {
  const base = url.replace(/\/$/, '');
  // Secret keys go in apikey only; a legacy JWT also goes in Authorization.
  const auth = { apikey: key, ...(key.startsWith('eyJ') ? { authorization: `Bearer ${key}` } : {}) };

  async function check(res, what) {
    if (res.ok) return res;
    throw new Error(`${what}: HTTP ${res.status} ${(await res.text()).slice(0, 300)}`);
  }

  return {
    async rpc(fn, args) {
      const res = await check(
        await fetch(`${base}/rest/v1/rpc/${fn}`, {
          method: 'POST',
          headers: { ...auth, 'content-type': 'application/json' },
          body: JSON.stringify(args),
          signal: AbortSignal.timeout(30_000),
        }),
        fn,
      );
      const text = await res.text();
      return text ? JSON.parse(text) : null;
    },
    async upload(path, bytes) {
      await check(
        await fetch(`${base}/storage/v1/object/${BUCKET}/${path}`, {
          method: 'POST',
          headers: { ...auth, 'content-type': 'image/webp', 'cache-control': CACHE_CONTROL, 'x-upsert': 'true' },
          body: bytes,
          signal: AbortSignal.timeout(60_000),
        }),
        `upload ${path}`,
      );
    },
    /** The stored tile, or null when there is none. */
    async download(path) {
      const res = await fetch(`${base}/storage/v1/object/public/${BUCKET}/${path}`, { signal: AbortSignal.timeout(30_000) });
      // Storage answers a missing object with 400 (code NoSuchKey) or 404.
      if (res.status === 400 || res.status === 404) return null;
      await check(res, `download ${path}`);
      return Buffer.from(await res.arrayBuffer());
    },
  };
}
