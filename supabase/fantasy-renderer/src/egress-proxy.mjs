#!/usr/bin/env node
// The worker's only way out: an HTTPS (CONNECT) proxy that lets through exactly the hosts
// in EGRESS_ALLOW, on port 443, and never a private, loopback or link-local address. The
// worker container sits on a Docker network with no route out (deploy/compose.yaml); this
// proxy sits on that network and on the outside one. The host the worker runs on shares a
// private network with other machines, which the worker therefore can't reach.
//
// Each name is resolved here and the connection goes to the address that was checked, so a
// DNS answer can't switch it to a private address in between.
//
//   EGRESS_ALLOW=<project>.supabase.co,tiles.openfreemap.org,elevation-tiles-prod.s3.amazonaws.com node src/egress-proxy.mjs
import { lookup } from 'node:dns/promises';
import { createServer } from 'node:http';
import { BlockList, isIP, connect } from 'node:net';

const PORT = Number(process.env.EGRESS_PORT || 3128);
const allow = new Set((process.env.EGRESS_ALLOW || '').split(',').map((h) => h.trim().toLowerCase()).filter(Boolean));

const blocked = new BlockList();
for (const [net, bits] of [['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16],
  ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['224.0.0.0', 4], ['240.0.0.0', 4]]) {
  blocked.addSubnet(net, bits, 'ipv4');
}
// (No ::ffff:0:0/96 rule: BlockList checks plain IPv4 addresses against it too.)
for (const [net, bits] of [['::', 128], ['::1', 128], ['fc00::', 7], ['fe80::', 10], ['ff00::', 8]]) {
  blocked.addSubnet(net, bits, 'ipv6');
}
const isPrivate = (address) => blocked.check(address, isIP(address) === 6 ? 'ipv6' : 'ipv4');

/** The address to connect to for host:port, or the reason it is refused. */
export async function resolveAllowed(host, port, allowed = allow) {
  const name = String(host).toLowerCase().replace(/^\[|\]$/g, '');
  if (Number(port) !== 443) return { refused: `port ${port} not allowed` };
  if (isIP(name)) return { refused: 'addresses are not allowed, only names' };
  if (!allowed.has(name)) return { refused: `${name} is not on the allow list` };
  // IPv4 first: containers often have no IPv6 route.
  const addresses = (await lookup(name, { all: true }).catch(() => [])).sort((a, b) => a.family - b.family);
  if (!addresses.length) return { refused: `${name} does not resolve` };
  const ok = addresses.find((a) => !isPrivate(a.address));
  if (!ok) return { refused: `${name} resolves only to private addresses` };
  return { address: ok.address };
}

const log = (msg) => console.log(`${new Date().toISOString()} egress ${msg}`);

const server = createServer((req, res) => {
  // Plain HTTP is never forwarded: everything the worker needs is HTTPS.
  res.writeHead(403).end('only CONNECT to allowed hosts on port 443\n');
});

server.on('connect', async (req, client, head) => {
  const [host, port] = String(req.url).split(/:(?=\d+$)/);
  const r = await resolveAllowed(host, port);
  if (r.refused) {
    log(`refused ${req.url}: ${r.refused}`);
    client.end('HTTP/1.1 403 Forbidden\r\n\r\n');
    return;
  }
  const upstream = connect(Number(port), r.address, () => {
    client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
    if (head?.length) upstream.write(head);
    upstream.pipe(client);
    client.pipe(upstream);
  });
  upstream.on('error', () => client.destroy());
  client.on('error', () => upstream.destroy());
});

if (import.meta.url === `file://${process.argv[1]}`) {
  if (!allow.size) throw new Error('EGRESS_ALLOW is empty');
  server.listen(PORT, '0.0.0.0', () => log(`listening on ${PORT}, allowing ${[...allow].join(', ')}`));
}
export { server, isPrivate };
