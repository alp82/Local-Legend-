#!/usr/bin/env node
// Screenshots the running prototype (read only, over HTTP) at a phone camera, for comparing
// the vendored painter's tiles with the prototype's own chunks.
//   node scripts/shoot-prototype.mjs <lng> <lat> <out.png> [base=http://localhost:5181/]
import { chromium } from 'playwright';

const [lng, lat, out, base = 'http://localhost:5181/'] = process.argv.slice(2);
const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const page = await browser.newPage({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 3 });
const q = new URLSearchParams({ loc: 'berlin', v: 'B', comp: 'heart', z: '16', ov: '0', ui: '0', lng, lat });
page.on('console', (m) => m.type() === 'error' && console.error('[console]', m.text().slice(0, 200)));
page.on('pageerror', (e) => console.error('[pageerror]', e.message));
await page.goto(`${base}?${q}`);
try {
  await page.waitForFunction(() => window.__ready === true, null, { timeout: 120_000, polling: 250 });
} catch {
  console.error('timeout waiting for __ready; shooting anyway');
}
await page.waitForTimeout(1500);
await page.screenshot({ path: out });
await browser.close();
console.log(out);
