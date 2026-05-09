// Tõmbab Eleringist päeva ja järgmise päeva NPS hinnad ning agreegeerib tunniks.
// Väljund: prices.json formaadis { "fetched_at": "...", "data": { "ee": [{timestamp, price}, ...] } }

import { writeFile } from 'node:fs/promises';

const now = new Date();
const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 0, 0, 0, 0));
const end   = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1, 23, 59, 59, 999));

const url = `https://dashboard.elering.ee/api/nps/price?start=${encodeURIComponent(start.toISOString())}&end=${encodeURIComponent(end.toISOString())}`;

const r = await fetch(url, { signal: AbortSignal.timeout(15000) });
if (!r.ok) throw new Error(`Elering HTTP ${r.status}`);
const body = await r.json();
const raw = body?.data?.ee ?? [];
if (!Array.isArray(raw) || raw.length === 0) throw new Error('Elering tagastas tühja vastuse');

// Agreegeeri 15-min intervallid tunniks (kuni 4 hinda → keskmine)
const byHour = new Map();
for (const p of raw) {
  const hourTs = Math.floor(p.timestamp / 3600) * 3600;
  if (!byHour.has(hourTs)) byHour.set(hourTs, []);
  byHour.get(hourTs).push(p.price);
}
const ee = [...byHour.entries()]
  .sort((a, b) => a[0] - b[0])
  .map(([timestamp, prices]) => ({
    timestamp,
    price: prices.reduce((s, x) => s + x, 0) / prices.length
  }));

const output = {
  fetched_at: new Date().toISOString(),
  data: { ee }
};

await writeFile('prices.json', JSON.stringify(output, null, 0) + '\n');
console.log(`Wrote prices.json: ${ee.length} hourly prices, range ${new Date(ee[0].timestamp*1000).toISOString()} → ${new Date(ee.at(-1).timestamp*1000).toISOString()}`);
