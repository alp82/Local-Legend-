#!/usr/bin/env node
// Proves from inside the worker container that its only way out is the egress proxy. Run it
// after every deployment:
//
//   docker compose exec -T worker node src/egress-check.mjs [<host address>:<port> ...]
//
// Checks: the allowed hosts answer through the proxy; another host is refused; nothing
// leaves directly; the Docker host itself (the network's gateway address, docker0) and any
// <address>:<port> given, such as the host's LAN address, can't be reached. Exits 1 if any
// check fails. Prints addresses only to the terminal.
import { connect } from 'node:net';
import { networkInterfaces } from 'node:os';

let failed = 0;
const report = (ok, what, detail) => {
  if (!ok) failed++;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}: ${detail}`);
};

async function reach(url) {
  try {
    const res = await fetch(url, { method: 'HEAD', redirect: 'manual', signal: AbortSignal.timeout(10_000) });
    return { ok: true, detail: `HTTP ${res.status}` };
  } catch (e) {
    return { ok: false, detail: e.cause?.code || e.cause?.message || e.message };
  }
}

const tcp = (host, port) =>
  new Promise((resolve) => {
    const s = connect({ host, port, timeout: 3000 }, () => {
      s.destroy();
      resolve('connected');
    });
    s.on('error', (e) => resolve(e.code));
    s.on('timeout', () => {
      s.destroy();
      resolve('timeout');
    });
  });

if (process.env.NODE_USE_ENV_PROXY !== '1' || !process.env.HTTPS_PROXY) {
  report(false, 'proxy settings', 'NODE_USE_ENV_PROXY=1 and HTTPS_PROXY must be set (deploy/compose.yaml)');
}

// 1. The allowed hosts, through the proxy.
const supabase = process.env.SUPABASE_URL ? new URL('/auth/v1/health', process.env.SUPABASE_URL).href : null;
for (const url of [supabase, 'https://tiles.openfreemap.org/planet', 'https://elevation-tiles-prod.s3.amazonaws.com/'].filter(Boolean)) {
  const r = await reach(url);
  report(r.ok, `allowed ${new URL(url).host}`, r.detail);
}

// 2. Any other host is refused by the proxy.
const other = await reach('https://example.com/');
report(!other.ok, 'a host not on the allow list', other.ok ? `reachable (${other.detail})` : `refused (${other.detail})`);

// 3. Nothing leaves without the proxy.
const direct = await tcp('1.1.1.1', 443);
report(direct !== 'connected', 'the internet without the proxy', direct);

// 4. The Docker host: the gateway address of each network the container is on, docker0,
//    and whatever was given on the command line.
const targets = [];
for (const addrs of Object.values(networkInterfaces())) {
  for (const a of addrs ?? []) {
    if (a.family !== 'IPv4' || a.internal) continue;
    const ip = a.address.split('.').map(Number);
    const mask = a.netmask.split('.').map(Number);
    const net = ip.map((b, i) => b & mask[i]);
    net[3] += 1;
    targets.push([net.join('.'), 22]);
  }
}
targets.push(['172.17.0.1', 22]);
for (const arg of process.argv.slice(2)) {
  const [host, port] = arg.split(/:(?=\d+$)/);
  targets.push([host, Number(port || 22)]);
}
for (const [host, port] of targets) {
  const r = await tcp(host, port);
  report(r !== 'connected', `the Docker host at ${host}:${port}`, r);
}

console.log(failed ? `${failed} check(s) failed` : 'all checks passed');
process.exit(failed ? 1 : 0);
