// Tõmbab Eleringist päeva ja järgmise päeva NPS hinnad ning agreegeerib tunniks.
// Väljund: prices.json formaadis { "fetched_at": "...", "data": { "ee": [{timestamp, price}, ...] } }
//
// `fetched_at` = millal SEE hinnakomplekt tõmmati, mitte millal skript viimati jooksis.
// Faili kirjutame ainult siis, kui hinnad päriselt muutusid — muidu tekitaks iga
// tunnijooks sisutühja commit'i (~24 päevas), sest ainus muutus oleks ajatempel.

import { readFile, writeFile } from 'node:fs/promises';

const OUT = 'prices.json';

// Mitu tulevast tundi peab vana prices.json veel katma, et Eleringi tõrge oleks
// talutav. Vanust ei saa mõõta `fetched_at`-i järgi — see seisab paigal seni, kuni
// hinnad ei muutu. Kaetus on niikuinii õigem mõõt: see on täpselt see, mis saidil loeb.
//
// 6 h on valitud nii, et normaalne päev sellest alla ei kukuks: Elering avaldab homse
// ~13:00 UTC ja enne seda katab fail päeva lõpuni (20:00 UTC), st miinimum on 13:00 UTC
// paiku ~8 h. Jääb kaks tunnijooksu varu enne häiret.
const MIN_FUTURE_HOURS = 6;

const now = new Date();
const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 0, 0, 0, 0));
const end   = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1, 23, 59, 59, 999));

const url = `https://dashboard.elering.ee/api/nps/price?start=${encodeURIComponent(start.toISOString())}&end=${encodeURIComponent(end.toISOString())}`;

// Elering vastab aeg-ajalt aeglasemalt kui 15 s ja üks katse kukutas terve jooksu:
// 11., 17., 18. ja 20. juulil 2026 lõppes voog TimeoutError-iga. Tunnine cron parandas
// olukorra järgmisel tunnil ise, aga vahepealne tund jäi värskendamata.
//
// Augustis lisandus HTTP 503 (6., 7., 10., 14., 18. ja 19. kuupäeval). Kolme katse
// aken oli ~25 s — lühem kui Eleringi tõrkeaken, seega kordused ei jõudnud aidata.
// Nüüd venitame ~110 s peale; GitHubi jooksul on aega küll.
async function fetchElering(url, tries = 5) {
  const waits = [5000, 15000, 30000, 60000];
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
      const wait = waits[i - 1] ?? waits.at(-1);
      console.warn(`Katse ${i}/${tries} kukkus (${e.message}) — uuesti ${wait / 1000} s pärast`);
      await new Promise((res) => setTimeout(res, wait));
    }
  }
  // `used`, mitte `tries` — vastasel juhul väidaks 4xx-i sõnum viit katset, kuigi tehti üks.
  throw new Error(`Elering ei vastanud (${used} ${used === 1 ? 'katse' : 'katset'}): ${last?.message}`);
}

// Agreegeeri 15-min intervallid tunniks (kuni 4 hinda → keskmine)
function toHourly(raw) {
  const byHour = new Map();
  for (const p of raw) {
    const hourTs = Math.floor(p.timestamp / 3600) * 3600;
    if (!byHour.has(hourTs)) byHour.set(hourTs, []);
    byHour.get(hourTs).push(p.price);
  }
  return [...byHour.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([timestamp, prices]) => ({
      timestamp,
      price: prices.reduce((s, x) => s + x, 0) / prices.length
    }));
}

// Sisuline nõue ei ole "iga tunnijooks õnnestub", vaid "prices.json kannab saiti".
// Sait loeb sama staatilist faili ka siis, kui see jooks kukub, nii et üksik
// Eleringi tõrge ei ole rike — ainult kestev tõrge on. Kukutame ainult viimasel juhul,
// muidu jätame vana faili puutumata ja lõpetame edukalt.
async function keepExistingOrThrow(err) {
  let prev;
  try {
    prev = JSON.parse(await readFile(OUT, 'utf8'));
  } catch (e) {
    throw new Error(`${err.message} — ja vana ${OUT} ei ole loetav (${e.message})`);
  }

  const ee = prev?.data?.ee ?? [];
  const thisHour = Math.floor(Date.now() / 1000 / 3600) * 3600;
  const future = ee.filter((p) => p.timestamp >= thisHour);

  // Sait filtreerib möödunud tunnid rippmenüüst välja, seega loeb ainult see,
  // mitu tulevast tundi failis veel alles on.
  if (future.length < MIN_FUTURE_HOURS) {
    throw new Error(
      `${err.message} — ja vana ${OUT} katab veel ainult ${future.length} tulevast tundi ` +
      `(vaja vähemalt ${MIN_FUTURE_HOURS})`
    );
  }

  console.warn(
    `HOIATUS: ${err.message}. Jätan vana ${OUT}-i alles ` +
    `(katab veel ${future.length} tundi, kuni ${new Date(ee.at(-1).timestamp * 1000).toISOString()}). ` +
    `Järgmine tunnijooks proovib uuesti.`
  );
  process.exit(0);
}

let ee;
try {
  const body = await fetchElering(url);
  const raw = body?.data?.ee ?? [];
  if (!Array.isArray(raw) || raw.length === 0) throw new Error('Elering tagastas tühja vastuse');
  ee = toHourly(raw);
} catch (e) {
  await keepExistingOrThrow(e); // ei naase: kas viskab vea või lõpetab edukalt
}

const range = `${new Date(ee[0].timestamp*1000).toISOString()} → ${new Date(ee.at(-1).timestamp*1000).toISOString()}`;

// Kirjuta ainult siis, kui hinnad ise muutusid. Muidu jääks faili ainsaks muutuseks
// uus `fetched_at` ja workflow commitiks selle iga tund, ilma et miski oleks uuenenud.
let unchanged = false;
try {
  const prev = JSON.parse(await readFile(OUT, 'utf8'));
  unchanged = JSON.stringify(prev?.data?.ee) === JSON.stringify(ee);
} catch {
  unchanged = false; // faili pole või on katki — kirjutame üle
}

if (unchanged) {
  console.log(`${OUT} on juba ajakohane: ${ee.length} hourly prices, range ${range} — ei kirjuta`);
} else {
  const output = {
    fetched_at: new Date().toISOString(),
    data: { ee }
  };
  await writeFile(OUT, JSON.stringify(output, null, 0) + '\n');
  console.log(`Wrote ${OUT}: ${ee.length} hourly prices, range ${range}`);
}
