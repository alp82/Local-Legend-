import { beforeEach, describe, expect, it, jest } from '@jest/globals';

import { ensureSession } from '../playerState';

const mockGetSession = jest.fn<() => Promise<unknown>>();
const mockSignInAnonymously = jest.fn<() => Promise<unknown>>();

jest.mock('../supabase', () => ({
  supabase: { auth: { getSession: () => mockGetSession(), signInAnonymously: () => mockSignInAnonymously() } },
  supabaseConfigError: null,
}));

const user = { id: 'anon-1' };

describe('ensureSession', () => {
  beforeEach(() => {
    mockGetSession.mockReset();
    mockSignInAnonymously.mockReset();
  });

  it('signs in once for parallel callers on a fresh install', async () => {
    let saved = false;
    mockGetSession.mockImplementation(async () => ({ data: { session: saved ? { user } : null }, error: null }));
    mockSignInAnonymously.mockImplementation(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
      saved = true;
      return { data: { user }, error: null };
    });

    const users = await Promise.all(Array.from({ length: 6 }, () => ensureSession()));

    expect(mockSignInAnonymously).toHaveBeenCalledTimes(1);
    expect(users.every((u) => u === user)).toBe(true);
  });

  it('tries again after a failed sign-in', async () => {
    mockGetSession.mockResolvedValue({ data: { session: null }, error: null });
    mockSignInAnonymously
      .mockResolvedValueOnce({ data: { user: null }, error: new Error('offline') })
      .mockResolvedValueOnce({ data: { user }, error: null });

    await expect(Promise.all([ensureSession(), ensureSession()])).rejects.toThrow('offline');
    await expect(ensureSession()).resolves.toBe(user);
    expect(mockSignInAnonymously).toHaveBeenCalledTimes(2);
  });
});
