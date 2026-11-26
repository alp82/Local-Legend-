import { beforeEach, describe, expect, it, jest } from '@jest/globals';

import { fetchFantasyConfig } from '../fantasyApi';

// A fresh install: no session until the anonymous sign-in finishes, and the server refuses
// get_fantasy_config to signed-out callers.
let signedIn = false;
const calls: string[] = [];
const mockGetSession = jest.fn<() => Promise<unknown>>();
const mockSignInAnonymously = jest.fn<() => Promise<unknown>>();
const mockRpc = jest.fn<(name: string) => Promise<unknown>>();

jest.mock('../supabase', () => ({
  supabase: {
    auth: { getSession: () => mockGetSession(), signInAnonymously: () => mockSignInAnonymously() },
    rpc: (name: string) => mockRpc(name),
  },
  supabaseConfigError: null,
}));

const config = { enabled: true, version: 1, bucket: 'fantasy-tiles' };

describe('fetchFantasyConfig', () => {
  beforeEach(() => {
    signedIn = false;
    calls.length = 0;
    mockSignInAnonymously.mockClear();
    mockGetSession.mockImplementation(async () => ({ data: { session: signedIn ? { user: { id: 'anon-1' } } : null }, error: null }));
    mockSignInAnonymously.mockImplementation(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
      signedIn = true;
      calls.push('sign-in');
      return { data: { user: { id: 'anon-1' } }, error: null };
    });
    mockRpc.mockImplementation(async (name) => {
      calls.push(name);
      return signedIn
        ? { data: config, error: null }
        : { data: null, error: new Error('permission denied for function get_fantasy_config') };
    });
  });

  it('waits for the anonymous sign-in on a fresh install', async () => {
    await expect(fetchFantasyConfig()).resolves.toEqual(config);
    expect(calls).toEqual(['sign-in', 'get_fantasy_config']);
  });

  it('does not sign in again when a session exists', async () => {
    signedIn = true;
    await expect(fetchFantasyConfig()).resolves.toEqual(config);
    expect(mockSignInAnonymously).not.toHaveBeenCalled();
  });
});
