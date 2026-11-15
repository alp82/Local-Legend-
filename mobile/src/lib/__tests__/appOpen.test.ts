import { describe, expect, it, jest } from '@jest/globals';

import { type AppOpenResult, sendAppOpen } from '../appOpen';

const ok: AppOpenResult = { recorded: true, duplicate: false, capped: false, gameDay: '2026-11-16', timeZoneAccepted: true };
const noSleep = () => Promise.resolve();

describe('sendAppOpen', () => {
  it('reuses one open id across network retries', async () => {
    const ids: string[] = [];
    const send = jest.fn(async (id: string) => {
      ids.push(id);
      if (ids.length < 3) throw new TypeError('Network request failed');
      return ok;
    });
    let n = 0;
    const result = await sendAppOpen(send, () => `open-${++n}`, [10, 10, 10], noSleep);
    expect(result).toEqual(ok);
    expect(ids).toEqual(['open-1', 'open-1', 'open-1']);
  });

  it('makes a new id for each open', async () => {
    const ids: string[] = [];
    let n = 0;
    const makeId = () => `open-${++n}`;
    const send = async (id: string) => {
      ids.push(id);
      return ok;
    };
    await sendAppOpen(send, makeId, [], noSleep);
    await sendAppOpen(send, makeId, [], noSleep);
    expect(ids).toEqual(['open-1', 'open-2']);
  });

  it('does not retry an error the server returned', async () => {
    const send = jest.fn(async () => {
      throw { code: '42501', message: 'Not signed in' };
    });
    await expect(sendAppOpen(send, () => 'id', [10, 10], noSleep)).rejects.toEqual({ code: '42501', message: 'Not signed in' });
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('gives up after the last delay', async () => {
    const send = jest.fn(async () => {
      throw new TypeError('Network request failed');
    });
    await expect(sendAppOpen(send, () => 'id', [10, 10], noSleep)).rejects.toThrow('Network request failed');
    expect(send).toHaveBeenCalledTimes(3);
  });
});
