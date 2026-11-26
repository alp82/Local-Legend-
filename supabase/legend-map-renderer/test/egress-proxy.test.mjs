// The egress proxy: allowed hosts on 443 only, never private addresses, never plain HTTP.
// Needs DNS (resolves real names).
import assert from 'node:assert/strict';
import { request } from 'node:http';
import { test } from 'node:test';

import { isPrivate, resolveAllowed, server } from '../src/egress-proxy.mjs';

const allowed = new Set(['tiles.openfreemap.org', 'localhost']);

test('private ranges are blocked and public addresses are not', () => {
  for (const a of ['10.20.30.40', '172.17.0.1', '192.168.1.1', '127.0.0.1', '169.254.169.254', '100.64.0.1', '::1', 'fd00::1', 'fe80::1']) assert.ok(isPrivate(a), a);
  for (const a of ['104.26.6.23', '52.216.219.18', '172.67.74.56', '2606:4700:20::681a:717']) assert.ok(!isPrivate(a), a);
});

test('only allowed names on port 443, and never a private address', async () => {
  const ok = await resolveAllowed('tiles.openfreemap.org', 443, allowed);
  assert.ok(ok.address, 'an allowed public host passes');
  assert.ok(!ok.address.includes(':'), 'IPv4 is preferred');
  assert.match((await resolveAllowed('tiles.openfreemap.org', 80, allowed)).refused, /port 80/);
  assert.match((await resolveAllowed('example.com', 443, allowed)).refused, /not on the allow list/);
  assert.match((await resolveAllowed('10.0.0.1', 443, allowed)).refused, /only names/);
  assert.match((await resolveAllowed('192.168.1.1', 443, allowed)).refused, /only names/);
  assert.match((await resolveAllowed('localhost', 443, allowed)).refused, /private/, 'an allowed name that resolves privately is refused');
});

test('the proxy refuses CONNECT to anything else and never forwards plain HTTP', async () => {
  process.env.EGRESS_ALLOW = '';
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address();
  try {
    const connectTo = (target) => new Promise((resolve) => {
      const req = request({ host: '127.0.0.1', port, method: 'CONNECT', path: target });
      req.on('connect', (res, socket) => { socket.destroy(); resolve(res.statusCode); });
      req.on('response', (res) => resolve(res.statusCode));
      req.on('error', () => resolve(0));
      req.end();
    });
    assert.equal(await connectTo('10.20.30.40:22'), 403, 'a private address');
    assert.equal(await connectTo('example.com:443'), 403, 'a host not on the list');
    const plain = await new Promise((resolve) => {
      const req = request({ host: '127.0.0.1', port, path: 'http://example.com/' }, (res) => resolve(res.statusCode));
      req.on('error', () => resolve(0));
      req.end();
    });
    assert.equal(plain, 403, 'plain HTTP');
  } finally {
    await new Promise((r) => server.close(r));
  }
});
