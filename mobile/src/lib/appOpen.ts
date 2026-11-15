// Sending one app open to the server: one open id, reused on every retry, so a
// request that reached the server but whose answer was lost counts once.
// Kept free of Supabase imports so it can be unit tested.

export type AppOpenResult = {
  recorded: boolean;
  duplicate: boolean;
  /** True when the day's open limit was reached and the open wasn't recorded. */
  capped: boolean;
  gameDay: string;
  timeZoneAccepted: boolean;
};

export const APP_OPEN_RETRY_DELAYS_MS = [1000, 5000, 15000];

/** True for an error the server returned (a Postgres code). Retrying won't change those. */
export function isServerError(e: unknown): boolean {
  return typeof e === 'object' && e !== null && typeof (e as { code?: unknown }).code === 'string'
    && (e as { code: string }).code !== '';
}

/**
 * Sends one app open with `send`, under one id from `makeId`. Retries network
 * failures after each of `delaysMs`, with the same id. Throws the last error.
 */
export async function sendAppOpen(
  send: (openId: string) => Promise<AppOpenResult>,
  makeId: () => string,
  delaysMs: readonly number[] = APP_OPEN_RETRY_DELAYS_MS,
  sleep: (ms: number) => Promise<void> = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
): Promise<AppOpenResult> {
  const openId = makeId();
  for (let attempt = 0; ; attempt++) {
    try {
      return await send(openId);
    } catch (e) {
      if (isServerError(e) || attempt >= delaysMs.length) throw e;
      await sleep(delaysMs[attempt]);
    }
  }
}
