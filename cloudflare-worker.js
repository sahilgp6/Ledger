// Ledger price relay: a tiny Cloudflare Worker that fetches NSE/BSE prices for the symbols Ledger asks for
// and returns them to your Ledger app. Holds no data and logs nothing; only ticker symbols pass through.
//
// Deploy: dash.cloudflare.com > Workers & Pages > Create > Create Worker > Deploy > Edit code >
// replace everything with this file > Deploy. Then paste the worker's URL into Ledger (More > Live stock prices).

const ALLOWED_ORIGINS = ['https://sahilgp6.github.io']; // your Ledger site
const MAX_SYMBOLS = 60;

export default {
  async fetch(request, env, ctx) {
    const origin = request.headers.get('Origin') || '';
    const cors = {
      'Access-Control-Allow-Origin': ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0],
      'Access-Control-Allow-Methods': 'GET, OPTIONS',
      'Vary': 'Origin',
    };
    if (request.method === 'OPTIONS') return new Response(null, { headers: cors });
    const url = new URL(request.url);
    if (url.pathname === '/' ) return json({ ok: true, service: 'ledger-price-relay' }, cors);
    if (url.pathname !== '/quote') return json({ error: 'not found' }, cors, 404);
    if (origin && !ALLOWED_ORIGINS.includes(origin)) return json({ error: 'origin not allowed' }, cors, 403);

    const symbols = [...new Set((url.searchParams.get('symbols') || '').split(',').map((s) => s.trim().toUpperCase()).filter((s) => /^[A-Z0-9&_.-]{1,20}$/.test(s)))].slice(0, MAX_SYMBOLS);
    if (!symbols.length) return json({ error: 'no symbols' }, cors, 400);

    const quotes = {};
    await Promise.all(symbols.map(async (sym) => {
      for (const suffix of ['.NS', '.BO']) {
        const q = await yahoo(sym + suffix, ctx).catch(() => null);
        if (q) { quotes[sym] = { ...q, exchange: suffix === '.NS' ? 'NSE' : 'BSE' }; break; }
      }
    }));
    return json({ quotes, at: Date.now() }, cors);
  },
};

async function yahoo(ticker, ctx) {
  const api = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}?range=1d&interval=1d`;
  const cache = caches.default;
  const key = new Request(api);
  let res = await cache.match(key);
  if (!res) {
    res = await fetch(api, { headers: { 'User-Agent': 'Mozilla/5.0 (compatible; LedgerPriceRelay/1.0)', 'Accept': 'application/json' } });
    if (!res.ok) return null;
    res = new Response(res.body, res);
    res.headers.set('Cache-Control', 'max-age=60'); // share one fetch per minute per symbol
    ctx.waitUntil(cache.put(key, res.clone()));
  }
  const data = await res.json();
  const m = data?.chart?.result?.[0]?.meta;
  if (!m || !(m.regularMarketPrice > 0)) return null;
  return { price: m.regularMarketPrice, prevClose: m.chartPreviousClose ?? m.previousClose ?? null, time: (m.regularMarketTime || 0) * 1000 };
}

function json(obj, cors, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { ...cors, 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });
}
