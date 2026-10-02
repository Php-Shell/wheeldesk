// ---------------------------------------------------------------------------
// Authenticated market-data proxy. Provider keys stay in Netlify env vars.
// Every response is normalised and carries provider + timestamp. Nothing is
// ever fabricated: unavailable data returns status "unavailable".
// ---------------------------------------------------------------------------

const FINNHUB = 'https://finnhub.io/api/v1';
const cache = new Map();

const TTL = {
  quote: 60_000,
  profile: 24 * 3600_000,
  metrics: 12 * 3600_000,
  earnings: 12 * 3600_000,
  dividends: 24 * 3600_000,
  candles: 10 * 60_000,
  options: 5 * 60_000,
  search: 3600_000,
};

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'private, max-age=30' },
  });

const validSymbol = (s) => typeof s === 'string' && /^[A-Z][A-Z0-9.\-:]{0,9}$/.test(s);
const KINDS = new Set(['quote', 'profile', 'metrics', 'earnings', 'dividends', 'candles', 'options', 'search']);

async function finnhub(path, params) {
  const url = new URL(FINNHUB + path);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  url.searchParams.set('token', process.env.FINNHUB_API_KEY);
  const r = await fetch(url.toString(), { headers: { Accept: 'application/json' } });
  if (r.status === 429) throw Object.assign(new Error('Finnhub rate limit reached'), { unavailable: true });
  if (!r.ok) throw new Error(`Finnhub ${r.status}`);
  return r.json();
}

function ok(kind, symbol, provider, data, extra = {}) {
  return { symbol, kind, provider, fetchedAt: new Date().toISOString(), status: 'ok', data, ...extra };
}
function unavailable(kind, symbol, message, provider = null) {
  return { symbol, kind, provider, fetchedAt: new Date().toISOString(), status: 'unavailable', data: null, message };
}

async function getQuote(symbol) {
  const x = await finnhub('/quote', { symbol });
  if (!x || (x.c === 0 && x.pc === 0)) return unavailable('quote', symbol, 'Finnhub returned no quote for this symbol.', 'finnhub');
  return ok('quote', symbol, 'finnhub', { price: x.c ?? null, change: x.d ?? null, percent: x.dp ?? null, open: x.o ?? null, high: x.h ?? null, low: x.l ?? null, prevClose: x.pc ?? null });
}

async function getProfile(symbol) {
  const x = await finnhub('/stock/profile2', { symbol });
  if (!x || !x.name) return unavailable('profile', symbol, 'No company profile found.', 'finnhub');
  return ok('profile', symbol, 'finnhub', {
    name: x.name || null,
    exchange: x.exchange || null,
    industry: x.finnhubIndustry || null,
    ipo: x.ipo || null,
    marketCap: x.marketCapitalization != null ? x.marketCapitalization * 1_000_000 : null,
    currency: x.currency || 'USD',
    website: x.weburl || null,
    logo: x.logo || null,
  });
}

async function getMetrics(symbol) {
  const x = await finnhub('/stock/metric', { symbol, metric: 'all' });
  const m = x?.metric || {};
  const avg = m['3MonthAverageTradingVolume'] ?? m['10DayAverageTradingVolume'] ?? null;
  return ok('metrics', symbol, 'finnhub', {
    epsTTM: m.epsTTM ?? null,
    avgVolume: avg != null ? avg * 1_000_000 : null,
    high52: m['52WeekHigh'] ?? null,
    low52: m['52WeekLow'] ?? null,
    beta: m.beta ?? null,
    dividendYield: m.dividendYieldIndicatedAnnual ?? null,
    pe: m.peTTM ?? null,
    revenueGrowth: m.revenueGrowthTTMYoy ?? null,
    profitMargin: m.netProfitMarginTTM ?? null,
  });
}

async function getEarnings(symbol) {
  const today = new Date();
  const from = today.toISOString().slice(0, 10);
  const to = new Date(today.getTime() + 400 * 86400000).toISOString().slice(0, 10);
  let calendar = [];
  let past = [];
  try {
    const c = await finnhub('/calendar/earnings', { from, to, symbol });
    calendar = c?.earningsCalendar || [];
  } catch { /* calendar may be restricted on some plans */ }
  try {
    const p = await finnhub('/stock/earnings', { symbol, limit: 4 });
    past = Array.isArray(p) ? p : [];
  } catch { /* ignore */ }
  const upcoming = calendar
    .filter((e) => e.date && new Date(e.date) >= new Date(from))
    .sort((a, b) => String(a.date).localeCompare(String(b.date)));
  const nextDate = upcoming[0]?.date || null;
  const daysUntil = nextDate ? Math.ceil((new Date(nextDate).getTime() - Date.now()) / 86400000) : null;
  if (!nextDate && !past.length) return unavailable('earnings', symbol, 'No earnings dates returned.', 'finnhub');
  return ok('earnings', symbol, 'finnhub', {
    nextDate,
    daysUntil,
    hour: upcoming[0]?.hour || null,
    epsEstimate: upcoming[0]?.epsEstimate ?? null,
    past: past.map((p) => ({ period: p.period, actual: p.actual, estimate: p.estimate, surprisePercent: p.surprisePercent })),
  });
}

async function getDividends(symbol) {
  const today = new Date();
  const iso = today.toISOString().slice(0, 10);
  const from = new Date(today.getTime() - 370 * 86400000).toISOString().slice(0, 10);
  const to = new Date(today.getTime() + 400 * 86400000).toISOString().slice(0, 10);
  const x = await finnhub('/stock/dividend', { symbol, from, to });
  const list = Array.isArray(x) ? x : [];
  if (!list.length) return unavailable('dividends', symbol, 'No dividend history returned.', 'finnhub');
  const upcoming = list
    .filter((d) => d.exDate && new Date(d.exDate) >= new Date(iso))
    .sort((a, b) => String(a.exDate).localeCompare(String(b.exDate)))[0] || null;
  return ok('dividends', symbol, 'finnhub', {
    next: upcoming ? { exDate: upcoming.exDate, payDate: upcoming.payDate || null, amount: upcoming.amount ?? null } : null,
    list: list.slice(-8).map((d) => ({ exDate: d.exDate, payDate: d.payDate, amount: d.amount })),
  });
}

async function getCandles(symbol) {
  const to = Math.floor(Date.now() / 1000);
  const from = to - 420 * 86400;
  const x = await finnhub('/stock/candle', { symbol, resolution: 'D', from, to });
  if (x?.s !== 'ok' || !Array.isArray(x.c) || x.c.length < 30) {
    return unavailable('candles', symbol, 'Daily candles are not available on this Finnhub plan.', 'finnhub');
  }
  const closes = x.c;
  const volumes = x.v || [];
  const last = closes.slice(-200);
  const ma200 = last.length >= 200 ? last.reduce((a, b) => a + b, 0) / last.length : null;
  const recentVol = volumes.slice(-30);
  const avgVolume = recentVol.length ? recentVol.reduce((a, b) => a + b, 0) / recentVol.length : null;
  const price = closes[closes.length - 1];
  return ok('candles', symbol, 'finnhub', {
    closes: closes.slice(-120),
    ma200,
    avgVolume,
    priceVsMa200: ma200 ? ((price - ma200) / ma200) * 100 : null,
  });
}

async function getOptions(symbol, expiry) {
  if (!process.env.TRADIER_API_KEY) {
    return unavailable('options', symbol, 'Options chains with greeks need a Tradier developer key (TRADIER_API_KEY). Enter the strike, bid/ask and delta manually from IBKR.', null);
  }
  const base = process.env.TRADIER_BASE_URL || 'https://api.tradier.com';
  const url = new URL(`${base}/v1/markets/options/chains`);
  url.searchParams.set('symbol', symbol);
  url.searchParams.set('greeks', 'true');
  if (expiry) url.searchParams.set('expiration', expiry);
  const r = await fetch(url.toString(), { headers: { Authorization: `Bearer ${process.env.TRADIER_API_KEY}`, Accept: 'application/json' } });
  if (!r.ok) throw new Error(`Tradier ${r.status}`);
  const x = await r.json();
  const chain = x?.options?.option;
  if (!chain) return unavailable('options', symbol, 'No option chain returned.', 'tradier');
  const rows = (Array.isArray(chain) ? chain : [chain]).map((o) => ({
    type: o.option_type,
    strike: o.strike,
    expiry: o.expiration_date,
    bid: o.bid ?? null,
    ask: o.ask ?? null,
    mid: o.bid != null && o.ask != null ? (Number(o.bid) + Number(o.ask)) / 2 : null,
    last: o.last ?? null,
    volume: o.volume ?? null,
    openInterest: o.open_interest ?? null,
    delta: o.greeks?.delta ?? null,
    gamma: o.greeks?.gamma ?? null,
    theta: o.greeks?.theta ?? null,
    vega: o.greeks?.vega ?? null,
    iv: o.greeks?.mid_iv ?? null,
  }));
  return ok('options', symbol, 'tradier', { expirations: [...new Set(rows.map((r) => r.expiry))].sort(), rows });
}

async function search(query) {
  const x = await finnhub('/search', { q: query });
  const results = (x?.result || []).slice(0, 8).map((r) => ({ symbol: r.symbol, description: r.description, type: r.type }));
  return ok('search', query.toUpperCase(), 'finnhub', results);
}

export default async (req) => {
  const url = new URL(req.url);
  const kind = url.searchParams.get('kind') || 'quote';
  const rawSymbol = (url.searchParams.get('symbol') || '').toUpperCase();
  const query = url.searchParams.get('q') || '';
  const expiry = url.searchParams.get('expiry') || '';

  if (!KINDS.has(kind)) return json({ status: 'error', message: 'Unknown kind.' }, 400);
  if (kind === 'search') {
    if (!query || query.length > 40) return json({ status: 'error', message: 'Invalid search query.' }, 400);
  } else if (!validSymbol(rawSymbol)) {
    return json({ status: 'error', message: 'Invalid symbol.' }, 400);
  }

  // Verify the Supabase session so the proxy cannot be abused.
  const authHeader = req.headers.get('authorization');
  const supabaseUrl = process.env.SUPABASE_URL;
  const anon = process.env.SUPABASE_ANON_KEY;
  if (!authHeader?.startsWith('Bearer ') || !supabaseUrl || !anon) {
    return json({ symbol: rawSymbol, kind, status: 'auth', message: 'Authenticated Supabase session required.' }, 401);
  }
  const user = await fetch(`${supabaseUrl}/auth/v1/user`, { headers: { authorization: authHeader, apikey: anon } }).catch(() => null);
  if (!user || !user.ok) return json({ symbol: rawSymbol, kind, status: 'auth', message: 'Invalid or expired session.' }, 401);

  if (!process.env.FINNHUB_API_KEY && kind !== 'options') {
    return json(unavailable(kind, rawSymbol, 'FINNHUB_API_KEY is not configured. Enter values manually.'), 200);
  }

  const cacheKey = `${kind}:${rawSymbol}:${expiry}:${query}`;
  const hit = cache.get(cacheKey);
  if (hit && hit.expires > Date.now()) return json({ ...hit.body, cache: 'hit' });

  try {
    let body;
    switch (kind) {
      case 'quote': body = await getQuote(rawSymbol); break;
      case 'profile': body = await getProfile(rawSymbol); break;
      case 'metrics': body = await getMetrics(rawSymbol); break;
      case 'earnings': body = await getEarnings(rawSymbol); break;
      case 'dividends': body = await getDividends(rawSymbol); break;
      case 'candles': body = await getCandles(rawSymbol); break;
      case 'options': body = await getOptions(rawSymbol, expiry); break;
      case 'search': body = await search(query); break;
      default: return json({ status: 'error', message: 'Unknown kind.' }, 400);
    }
    body.cache = 'miss';
    if (body.status === 'ok') cache.set(cacheKey, { body, expires: Date.now() + (TTL[kind] || 60_000) });
    return json(body);
  } catch (err) {
    if (err?.unavailable) return json(unavailable(kind, rawSymbol, err.message), 200);
    return json({ symbol: rawSymbol, kind, provider: null, fetchedAt: new Date().toISOString(), status: 'error', data: null, message: 'Provider request failed.', detail: String(err?.message || err) }, 200);
  }
};
