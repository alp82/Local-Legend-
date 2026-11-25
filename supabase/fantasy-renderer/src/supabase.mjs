// The few Supabase calls the worker makes, over plain HTTP: RPCs, and uploads to and
// downloads from the public fantasy-tiles bucket.
//
// Two ways to authenticate (see README.md):
//   - The renderer user (production): the publishable key plus the email and password of
//     the auth user flagged fantasy_renderer. It may only lease, finish and queue tiles,
//     read the status and write the fantasy-tiles bucket.
//   - A secret key (local stack, admin): sb_secret_... or the legacy service_role JWT.
const BUCKET = 'fantasy-tiles';
/** Tiles never change once painted (a new painter is a new version path). */
const CACHE_CONTROL = 'public, max-age=31536000, immutable';
/** Refresh the renderer's session this long before it expires. */
const REFRESH_MARGIN_MS = 5 * 60_000;

/**
 * @param {string} url Project URL, such as https://<ref>.supabase.co or http://127.0.0.1:54321
 * @param {{ secretKey?: string, publishableKey?: string, email?: string, password?: string }} auth
 */
export function createSupabase(url, auth) {
  const base = url.replace(/\/$/, '');
  const asUser = !auth.secretKey;
  if (asUser && !(auth.publishableKey && auth.email && auth.password)) {
    throw new Error('set SUPABASE_SECRET_KEY, or SUPABASE_PUBLISHABLE_KEY with FANTASY_RENDERER_EMAIL and FANTASY_RENDERER_PASSWORD');
  }
  let session = null; // { access, refresh, expiresAt }

  async function check(res, what) {
    if (res.ok) return res;
    throw Object.assign(new Error(`${what}: HTTP ${res.status} ${(await res.text()).slice(0, 300)}`), { status: res.status });
  }

  async function token(body, grant) {
    const res = await check(
      await fetch(`${base}/auth/v1/token?grant_type=${grant}`, {
        method: 'POST',
        headers: { apikey: auth.publishableKey, 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(30_000),
      }),
      `sign-in (${grant})`,
    );
    const j = await res.json();
    session = { access: j.access_token, refresh: j.refresh_token, expiresAt: Date.now() + j.expires_in * 1000 };
  }

  async function headers() {
    if (!asUser) {
      const key = auth.secretKey;
      // Secret keys go in apikey only; a legacy JWT also goes in Authorization.
      return { apikey: key, ...(key.startsWith('eyJ') ? { authorization: `Bearer ${key}` } : {}) };
    }
    if (!session) await token({ email: auth.email, password: auth.password }, 'password');
    else if (Date.now() > session.expiresAt - REFRESH_MARGIN_MS) {
      await token({ refresh_token: session.refresh }, 'refresh_token').catch(() => token({ email: auth.email, password: auth.password }, 'password'));
    }
    return { apikey: auth.publishableKey, authorization: `Bearer ${session.access}` };
  }

  /** One request; on 401 the session is dropped and the request made once more. */
  async function call(what, make) {
    try {
      return await check(await make(await headers()), what);
    } catch (e) {
      if (!asUser || e.status !== 401) throw e;
      session = null;
      return check(await make(await headers()), what);
    }
  }

  return {
    mode: asUser ? `renderer user ${auth.email}` : 'secret key',
    async rpc(fn, args) {
      const res = await call(fn, (h) =>
        fetch(`${base}/rest/v1/rpc/${fn}`, {
          method: 'POST',
          headers: { ...h, 'content-type': 'application/json' },
          body: JSON.stringify(args ?? {}),
          signal: AbortSignal.timeout(30_000),
        }),
      );
      const text = await res.text();
      return text ? JSON.parse(text) : null;
    },
    async upload(path, bytes, contentType = 'image/webp') {
      await call(`upload ${path}`, (h) =>
        fetch(`${base}/storage/v1/object/${BUCKET}/${path}`, {
          method: 'POST',
          headers: { ...h, 'content-type': contentType, 'cache-control': CACHE_CONTROL, 'x-upsert': 'true' },
          body: bytes,
          signal: AbortSignal.timeout(60_000),
        }),
      );
    },
    /** A stored tile or label file, or null when there is none. Public: no credential needed. */
    async download(path) {
      const res = await fetch(`${base}/storage/v1/object/public/${BUCKET}/${path}`, { signal: AbortSignal.timeout(30_000) });
      // Storage answers a missing object with 400 (code NoSuchKey) or 404.
      if (res.status === 400 || res.status === 404) return null;
      await check(res, `download ${path}`);
      return Buffer.from(await res.arrayBuffer());
    },
  };
}

/** The Supabase client from the environment (README.md, Configuration). */
export function supabaseFromEnv(env = process.env) {
  const url = env.SUPABASE_URL;
  if (!url || !/^https?:\/\//.test(url)) throw new Error(`SUPABASE_URL must be an http(s) URL, got "${url ?? ''}"`);
  return createSupabase(url, {
    secretKey: env.SUPABASE_SECRET_KEY || undefined,
    publishableKey: env.SUPABASE_PUBLISHABLE_KEY || undefined,
    email: env.FANTASY_RENDERER_EMAIL || undefined,
    password: env.FANTASY_RENDERER_PASSWORD || undefined,
  });
}
