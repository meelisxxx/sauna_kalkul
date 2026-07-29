// Tõmbab Eleringist päeva ja järgmise päeva NPS hinnad ning agreegeerib tunniks.
// Väljund: prices.json formaadis { "fetched_at": "...", "data": { "ee": [{timestamp, price}, ...] } }

import { writeFile } from 'node:fs/promises';

const now = new Date();
const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 0, 0, 0, 0));
const end   = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1, 23, 59, 59, 999));

const url = `https://dashboard.elering.ee/api/nps/price?start=${encodeURIComponent(start.toISOString())}&end=${encodeURIComponent(end.toISOString())}`;

// Elering vastab aeg-ajalt aeglasemalt kui 15 s ja üks katse kukutas terve jooksu:
// 11., 17., 18. ja 20. juulil 2026 lõppes voog TimeoutError-iga. Tunnine cron parandas
// olukorra järgmisel tunnil ise, aga vahepealne tund jäi värskendamata.
async function fetchElering(url, tries = 3) {
  let last, used = 0;
  for (let i = 1; i <= tries; i++) {
    used = i;
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(15000) });
      // 4xx on meiepoolne viga — kordamine ei paranda seda, kukume kohe.
      if (r.status >= 400 && r.status < 500) throw new Error(`Elering HTTP ${r.status} (ei korda)`);
      if (!r.ok) throw new Error(`Elering HTTP ${r.status}`);
      return await r.json();
    } catch (e) {
      last = e;
      if (e.message?.includes('ei korda') || i === tries) break;
      const wait = i * 5000;
      console.warn(`Katse ${i}/${tries} kukkus (${e.message}) — uuesti ${wait / 1000} s pärast`);
      await new Promise((res) => setTimeout(res, wait));
    }
  }
  // `used`, mitte `tries` — vastasel juhul väidaks 4xx-i sõnum kolme katset, kuigi tehti üks.
  throw new Error(`Elering ei vastanud (${used} ${used === 1 ? 'katse' : 'katset'}): ${last?.message}`);
}

const body = await fetchElering(url);
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
