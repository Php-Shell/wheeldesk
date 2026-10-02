// ---------------------------------------------------------------------------
// Market-data proxy. Provider keys stay in Netlify env vars. Every response is
// normalised and carries provider + timestamp. Nothing is ever fabricated:
// unavailable data returns status "unavailable". A Supabase session is
// optional (verified when present) so a private single-user site works with no
// login; a small in-memory rate limit protects the free API quota.
// ---------------------------------------------------------------------------

import { blackScholes } from '../../src/greeks.js';

const FINNHUB = 'https://finnhub.io/api/v1';
const YF_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36';
const cache = new Map();

// Simple sliding-window rate limit per client (per warm function instance).
const hits = new Map();
const RATE_MAX = 240;
const RATE_WINDOW = 60_000;
function rateLimited(req) {
  const ip = req.headers.get('x-nf-client-connection-ip') || req.headers.get('x-forwarded-for') || 'local';
  const now = Date.now();
  const recent = (hits.get(ip) || []).filter((t) => now - t < RATE_WINDOW);
  recent.push(now);
  hits.set(ip, recent);
  if (hits.size > 5000) hits.clear();
  return recent.length > RATE_MAX;
}

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

// Nasdaq's public JSON API needs no key and covers both stocks and ETFs.
// It gives historical daily closes (for the 200-day average) and the dividend
// record including the latest/next ex-dividend date.
const NASDAQ_HEADERS = { 'User-Agent': YF_UA, Accept: 'application/json', 'Accept-Language': 'en-US' };
async function nasdaqFetch(path) {
  const r = await fetch(`https://api.nasdaq.com/api${path}`, { headers: NASDAQ_HEADERS });
  if (!r.ok) throw new Error(`Nasdaq ${r.status}`);
  return r.json();
}
function usDateToISO(s) {
  const m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(String(s || '').trim());
  return m ? `${m[3]}-${m[1].padStart(2, '0')}-${m[2].padStart(2, '0')}` : null;
}
const parseMoney = (v) => parseFloat(String(v ?? '').replace(/[$,]/g, ''));

async function nasdaqHistorical(symbol) {
  const to = new Date();
  const from = new Date(Date.now() - 460 * 86400000);
  const fmt = (d) => d.toISOString().slice(0, 10);
  for (const assetclass of ['stocks', 'etf']) {
    try {
      const j = await nasdaqFetch(`/quote/${encodeURIComponent(symbol)}/historical?assetclass=${assetclass}&fromdate=${fmt(from)}&todate=${fmt(to)}&limit=320`);
      const rows = j?.data?.tradesTable?.rows || [];
      if (rows.length >= 30) {
        const ordered = [...rows].reverse();
        const closes = ordered.map((r) => parseMoney(r.close)).filter((n) => Number.isFinite(n));
        const volumes = ordered.map((r) => parseMoney(r.volume)).filter((n) => Number.isFinite(n));
        if (closes.length >= 30) return { closes, volumes };
      }
    } catch { /* try the next asset class */ }
  }
  return null;
}

// Consolidated (OPRA) put open interest by expiry|strike from Nasdaq, used to
// top up CBOE's exchange-only open interest.
function osiFromDrilldown(url) {
  const m = /([a-z]+)-+(\d{6})([cp])(\d{8})$/i.exec(String(url || ''));
  if (!m) return null;
  return { expiry: `20${m[2].slice(0, 2)}-${m[2].slice(2, 4)}-${m[2].slice(4, 6)}`, type: m[3].toLowerCase(), strike: Number(m[4]) / 1000 };
}

async function nasdaqOptionOi(symbol) {
  const from = new Date(Date.now() - 90 * 86400000).toISOString().slice(0, 10);
  const to = new Date(Date.now() + 400 * 86400000).toISOString().slice(0, 10);
  for (const assetclass of ['stocks', 'etf']) {
    try {
      const j = await nasdaqFetch(`/quote/${encodeURIComponent(symbol)}/option-chain?assetclass=${assetclass}&limit=5000&fromdate=${from}&todate=${to}&excode=oprac&callput=put&money=all&type=all`);
      const rows = j?.data?.table?.rows || [];
      if (!rows.length) continue;
      const map = new Map();
      for (const r of rows) {
        const o = osiFromDrilldown(r.drillDownURL);
        if (!o || o.type !== 'put') continue;
        const oi = Number(String(r.p_Openinterest).replace(/[^0-9]/g, '')) || 0;
        const key = `${o.expiry}|${o.strike}`;
        if (oi > (map.get(key) || 0)) map.set(key, oi);
      }
      if (map.size) return map;
    } catch { /* try next asset class */ }
  }
  return null;
}

async function nasdaqDividends(symbol) {
  for (const assetclass of ['stocks', 'etf']) {
    try {
      const j = await nasdaqFetch(`/quote/${encodeURIComponent(symbol)}/dividends?assetclass=${assetclass}`);
      const d = j?.data;
      if (!d) continue;
      const rows = d.dividends?.rows || [];
      const announcedRaw = usDateToISO(d.exDividendDate);
      if (!rows.length && !announcedRaw) continue; // "N/A" or no data → try next asset class
      const lastEx = rows[0] ? usDateToISO(rows[0].exOrEffDate) : announcedRaw;
      const lastAmount = rows[0] ? parseMoney(rows[0].amount) : d.annualizedDividend ? Number(d.annualizedDividend) / 4 : null;
      const today = new Date().toISOString().slice(0, 10);
      const announced = usDateToISO(d.exDividendDate);
      let next = null;
      let estimated = false;
      if (announced && announced >= today) {
        next = announced;
      } else if (lastEx) {
        const n = new Date(lastEx);
        n.setDate(n.getDate() + 91);
        next = n.toISOString().slice(0, 10);
        estimated = true;
      }
      return ok('dividends', symbol, 'nasdaq', {
        next: next ? { exDate: next, amount: lastAmount, estimated } : null,
        yield: d.yield || null,
        list: rows.slice(0, 8).map((r) => ({ exDate: usDateToISO(r.exOrEffDate), payDate: usDateToISO(r.paymentDate), amount: parseMoney(r.amount) })),
      });
    } catch { /* try the next asset class */ }
  }
  return null;
}

// Yahoo's chart endpoint needs no key or crumb and is a fallback for the
// underlying quote and for the 200-day average / average volume.
async function yahooChart(symbol, range = '1y') {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=${range}&interval=1d`;
  const r = await fetch(url, { headers: { 'User-Agent': YF_UA, Accept: 'application/json' } });
  if (!r.ok) throw new Error(`Yahoo ${r.status}`);
  const x = await r.json();
  const res = x?.chart?.result?.[0];
  if (!res) return null;
  const q = res.indicators?.quote?.[0] || {};
  return { meta: res.meta || {}, closes: (q.close || []).filter((v) => v != null), volumes: (q.volume || []).filter((v) => v != null) };
}

async function getQuote(symbol) {
  try {
    const x = await finnhub('/quote', { symbol });
    if (x && !(x.c === 0 && x.pc === 0)) {
      return ok('quote', symbol, 'finnhub', { price: x.c ?? null, change: x.d ?? null, percent: x.dp ?? null, open: x.o ?? null, high: x.h ?? null, low: x.l ?? null, prevClose: x.pc ?? null });
    }
  } catch { /* fall through to Yahoo */ }
  const y = await yahooChart(symbol, '5d').catch(() => null);
  const m = y?.meta;
  if (m?.regularMarketPrice != null) {
    return ok('quote', symbol, 'yahoo', {
      price: m.regularMarketPrice,
      change: m.regularMarketPrice - (m.chartPreviousClose ?? m.previousClose ?? m.regularMarketPrice),
      percent: m.chartPreviousClose ? ((m.regularMarketPrice - m.chartPreviousClose) / m.chartPreviousClose) * 100 : null,
      open: m.regularMarketOpen ?? null,
      high: m.regularMarketDayHigh ?? null,
      low: m.regularMarketDayLow ?? null,
      prevClose: m.chartPreviousClose ?? m.previousClose ?? null,
    });
  }
  return unavailable('quote', symbol, 'No quote available from Finnhub or Yahoo.', null);
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
  // Trailing-twelve-month EPS computed from the last four reported quarters.
  // This is often more faithful than a vendor's single epsTTM number.
  const quarters = past.filter((p) => p.actual != null).slice(0, 4);
  const epsTTMFromQuarters = quarters.length === 4 ? quarters.reduce((a, p) => a + Number(p.actual), 0) : null;
  if (!nextDate && !past.length) return unavailable('earnings', symbol, 'No earnings dates returned.', 'finnhub');
  return ok('earnings', symbol, 'finnhub', {
    nextDate,
    daysUntil,
    hour: upcoming[0]?.hour || null,
    epsEstimate: upcoming[0]?.epsEstimate ?? null,
    epsTTMFromQuarters,
    past: past.map((p) => ({ period: p.period, actual: p.actual, estimate: p.estimate, surprisePercent: p.surprisePercent })),
  });
}

async function getDividends(symbol) {
  // Finnhub's dividend endpoint is premium on the free plan (403), so fall back
  // to Nasdaq, which also gives us the announced/last ex-dividend date.
  try {
    const today = new Date();
    const iso = today.toISOString().slice(0, 10);
    const from = new Date(today.getTime() - 370 * 86400000).toISOString().slice(0, 10);
    const to = new Date(today.getTime() + 400 * 86400000).toISOString().slice(0, 10);
    const x = await finnhub('/stock/dividend', { symbol, from, to });
    const list = Array.isArray(x) ? x : [];
    if (list.length) {
      const upcoming = list
        .filter((d) => d.exDate && new Date(d.exDate) >= new Date(iso))
        .sort((a, b) => String(a.exDate).localeCompare(String(b.exDate)))[0] || null;
      return ok('dividends', symbol, 'finnhub', {
        next: upcoming ? { exDate: upcoming.exDate, payDate: upcoming.payDate || null, amount: upcoming.amount ?? null } : null,
        list: list.slice(-8).map((d) => ({ exDate: d.exDate, payDate: d.payDate, amount: d.amount })),
      });
    }
  } catch { /* fall through to Nasdaq */ }

  const n = await nasdaqDividends(symbol).catch(() => null);
  if (n) return n;
  return unavailable('dividends', symbol, 'No dividend data found. The company may not pay a dividend — verify manually.', null);
}

async function getCandles(symbol, source) {
  let provider = 'finnhub';
  let closes = [];
  let volumes = [];
  // source=nasdaq lets the screener scan skip the (free-plan-blocked) Finnhub
  // candle call to stay inside the rate limit.
  if (source !== 'nasdaq') {
    try {
      const to = Math.floor(Date.now() / 1000);
      const from = to - 420 * 86400;
      const x = await finnhub('/stock/candle', { symbol, resolution: 'D', from, to });
      if (x?.s === 'ok' && Array.isArray(x.c) && x.c.length >= 30) {
        closes = x.c;
        volumes = x.v || [];
      }
    } catch { /* fall through */ }
  }

  if (!closes.length) {
    const n = await nasdaqHistorical(symbol).catch(() => null);
    if (n?.closes?.length >= 30) {
      provider = 'nasdaq';
      closes = n.closes;
      volumes = n.volumes || [];
    }
  }
  if (!closes.length) {
    const y = await yahooChart(symbol, '1y').catch(() => null);
    if (y?.closes?.length >= 30) {
      provider = 'yahoo';
      closes = y.closes;
      volumes = y.volumes || [];
    }
  }
  if (!closes.length) return unavailable('candles', symbol, 'Historical prices are not available on this Finnhub plan; Nasdaq/Yahoo did not respond either. Use the chart link or enter the 200-day average manually.', null);

  const last = closes.slice(-200);
  const ma200 = last.length >= 200 ? last.reduce((a, b) => a + b, 0) / last.length : null;
  const recentVol = volumes.slice(-30);
  const avgVolume = recentVol.length ? recentVol.reduce((a, b) => a + b, 0) / recentVol.length : null;
  const price = closes[closes.length - 1];
  return ok('candles', symbol, provider, {
    closes: closes.slice(-120),
    ma200,
    avgVolume,
    priceVsMa200: ma200 ? ((price - ma200) / ma200) * 100 : null,
  });
}

// CBOE publishes free delayed option chains that already include greeks,
// implied volatility, open interest and volume. No key or signup required.
function parseOsi(osi) {
  // CBOE returns ROOT + YYMMDD + C/P + strike*1000 (8 digits). The root is not
  // padded, so read the fixed 15-character suffix from the end.
  if (typeof osi !== 'string' || osi.length < 16) return null;
  const ymd = osi.slice(-15, -9);
  const cp = osi[osi.length - 9];
  const strikeRaw = osi.slice(-8);
  if (!/^\d{6}$/.test(ymd) || (cp !== 'C' && cp !== 'P') || !/^\d{8}$/.test(strikeRaw)) return null;
  const yy = ymd.slice(0, 2);
  const mm = ymd.slice(2, 4);
  const dd = ymd.slice(4, 6);
  return { expiry: `20${yy}-${mm}-${dd}`, type: cp === 'C' ? 'call' : 'put', strike: Number(strikeRaw) / 1000 };
}

async function getCboeChain(symbol) {
  const url = `https://cdn.cboe.com/api/global/delayed_quotes/options/${encodeURIComponent(symbol)}.json`;
  const r = await fetch(url, {
    redirect: 'follow',
    headers: { 'User-Agent': 'Mozilla/5.0 (compatible; WheelDesk/2.0)', Accept: 'application/json' },
  });
  if (r.status === 404) return unavailable('options', symbol, `CBOE does not list options for ${symbol}.`, 'cboe');
  if (!r.ok) throw new Error(`CBOE ${r.status}`);
  const x = await r.json();
  const list = x?.data?.options;
  if (!Array.isArray(list) || !list.length) return unavailable('options', symbol, `No CBOE chain returned for ${symbol}.`, 'cboe');
  const rows = [];
  for (const o of list) {
    const parsed = parseOsi(o.option);
    if (!parsed) continue;
    const bid = o.bid ?? null;
    const ask = o.ask ?? null;
    rows.push({
      ...parsed,
      bid,
      ask,
      mid: bid != null && ask != null && (bid > 0 || ask > 0) ? (bid + ask) / 2 : null,
      last: o.last_trade_price ?? null,
      volume: o.volume ?? null,
      openInterest: o.open_interest ?? null,
      delta: o.delta ?? null,
      gamma: o.gamma ?? null,
      theta: o.theta ?? null,
      vega: o.vega ?? null,
      iv: o.iv != null ? o.iv * 100 : null,
    });
  }
  if (!rows.length) return unavailable('options', symbol, 'CBOE chain could not be parsed.', 'cboe');
  // Merge consolidated OI from Nasdaq: CBOE only reports its own exchange's OI,
  // which understates heavily NYSE/ARCA-traded names.
  try {
    const oiMap = await nasdaqOptionOi(symbol);
    if (oiMap) {
      for (const row of rows) {
        const key = `${row.expiry}|${row.strike}`;
        const alt = oiMap.get(key);
        if (alt != null && (row.openInterest == null || alt > row.openInterest)) row.openInterest = alt;
      }
    }
  } catch { /* keep CBOE OI */ }
  return ok('options', symbol, 'cboe', {
    underlying: {
      price: x?.data?.current_price ?? null,
      change: x?.data?.price_change ?? null,
      percent: x?.data?.price_change_percent ?? null,
      iv30: x?.data?.iv30 ?? null,
      asOf: x?.timestamp ?? null,
    },
    expirations: [...new Set(rows.map((r) => r.expiry))].sort(),
    rows,
  });
}

async function getTradierOptions(symbol, expiry) {
  if (!process.env.TRADIER_API_KEY) return unavailable('options', symbol, 'Tradier is not configured.', null);
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
    iv: o.greeks?.mid_iv != null ? o.greeks.mid_iv * 100 : null,
  }));
  return ok('options', symbol, 'tradier', { expirations: [...new Set(rows.map((r) => r.expiry))].sort(), rows });
}

const asArray = (v) => (Array.isArray(v) ? v : v == null ? [] : [v]);

// Optional paid-ish provider with real greeks. Needs MARKETDATA_TOKEN.
async function getMarketDataOptions(symbol, expiry) {
  const token = process.env.MARKETDATA_TOKEN;
  if (!token) return unavailable('options', symbol, 'MarketData.app token not configured.', null);
  const url = new URL(`https://api.marketdata.app/v1/options/chain/${encodeURIComponent(symbol)}/`);
  url.searchParams.set('token', token);
  if (expiry) url.searchParams.set('expiration', expiry);
  const r = await fetch(url, { headers: { Accept: 'application/json' } });
  if (r.status === 404) return unavailable('options', symbol, 'No MarketData.app chain.', 'marketdata');
  if (!r.ok) throw new Error(`MarketData.app ${r.status}`);
  const x = await r.json();
  if (x?.s !== 'ok' || !Array.isArray(x.strike)) return unavailable('options', symbol, 'MarketData.app returned no chain.', 'marketdata');
  const side = asArray(x.side);
  const strike = asArray(x.strike);
  const expiration = asArray(x.expiration);
  const rows = strike
    .map((k, i) => ({
      type: side[i] === 'call' ? 'call' : 'put',
      strike: k,
      expiry: expiration[i] ? new Date(expiration[i] * 1000).toISOString().slice(0, 10) : null,
      bid: asArray(x.bid)[i] ?? null,
      ask: asArray(x.ask)[i] ?? null,
      mid: asArray(x.mid)[i] ?? null,
      last: asArray(x.last)[i] ?? null,
      volume: asArray(x.volume)[i] ?? null,
      openInterest: asArray(x.openInterest)[i] ?? null,
      delta: asArray(x.delta)[i] ?? null,
      gamma: asArray(x.gamma)[i] ?? null,
      theta: asArray(x.theta)[i] ?? null,
      vega: asArray(x.vega)[i] ?? null,
      iv: asArray(x.iv)[i] != null ? asArray(x.iv)[i] * 100 : null,
    }))
    .filter((r) => r.strike && r.expiry);
  if (!rows.length) return unavailable('options', symbol, 'MarketData.app chain was empty.', 'marketdata');
  return ok('options', symbol, 'marketdata', { expirations: [...new Set(rows.map((r) => r.expiry))].sort(), rows });
}

// Last-resort free source: Yahoo chain (IV only) + Black-Scholes greeks.
// Yahoo often rate-limits server-side, so this is best-effort.
async function getYahooOptions(symbol) {
  try {
    const cookieRes = await fetch('https://fc.yahoo.com', { headers: { 'User-Agent': YF_UA }, redirect: 'manual' });
    const setCookie = cookieRes.headers.get('set-cookie') || '';
    const cookie = setCookie.split(',').map((c) => c.split(';')[0]).join('; ');
    const crumbRes = await fetch('https://query1.finance.yahoo.com/v1/test/getcrumb', { headers: { 'User-Agent': YF_UA, cookie } });
    const crumb = (await crumbRes.text()).trim();
    if (!crumb || /\s/.test(crumb)) return unavailable('options', symbol, 'Yahoo rate-limited the request.', 'yahoo');
    const base = `https://query2.finance.yahoo.com/v7/finance/options/${encodeURIComponent(symbol)}`;
    const get = async (date) => {
      const u = date ? `${base}?date=${date}&crumb=${encodeURIComponent(crumb)}` : `${base}?crumb=${encodeURIComponent(crumb)}`;
      const r = await fetch(u, { headers: { 'User-Agent': YF_UA, cookie, Accept: 'application/json' } });
      if (!r.ok) throw new Error(`Yahoo ${r.status}`);
      return r.json();
    };
    let j = await get();
    let res = j?.optionChain?.result?.[0];
    if (!res) return unavailable('options', symbol, 'Yahoo returned no chain.', 'yahoo');
    const S = res.quote?.regularMarketPrice;
    const dates = res.expirationDates || [];
    // Prefer the expiry closest to 40 DTE.
    let chosen = res.options?.[0];
    if (dates.length > 1 && S) {
      const target = Date.now() / 1000 + 40 * 86400;
      const best = [...dates].sort((a, b) => Math.abs(a - target) - Math.abs(b - target))[0];
      if (best && best !== dates[0]) {
        j = await get(best);
        res = j?.optionChain?.result?.[0];
        chosen = res?.options?.[0];
      }
    }
    if (!chosen) return unavailable('options', symbol, 'Yahoo chain was empty.', 'yahoo');
    const expiry = chosen.expirationDate ? new Date(chosen.expirationDate * 1000).toISOString().slice(0, 10) : null;
    const dte = expiry ? Math.max(1, Math.round((new Date(expiry).getTime() - Date.now()) / 86400000)) : 40;
    const rows = [];
    for (const side of ['puts', 'calls']) {
      for (const o of chosen[side] || []) {
        const iv = o.impliedVolatility != null ? o.impliedVolatility * 100 : null;
        const mid = o.bid != null && o.ask != null && (o.bid > 0 || o.ask > 0) ? (o.bid + o.ask) / 2 : o.lastPrice ?? null;
        let greeks = null;
        if (iv && S && o.strike) greeks = blackScholes({ type: side === 'puts' ? 'put' : 'call', S, K: o.strike, daysToExpiry: dte, iv });
        rows.push({
          type: side === 'puts' ? 'put' : 'call',
          strike: o.strike,
          expiry,
          bid: o.bid ?? null,
          ask: o.ask ?? null,
          mid,
          last: o.lastPrice ?? null,
          volume: o.volume ?? null,
          openInterest: o.openInterest ?? null,
          iv,
          delta: greeks?.delta ?? null,
          gamma: greeks?.gamma ?? null,
          theta: greeks?.theta ?? null,
          vega: greeks?.vega ?? null,
        });
      }
    }
    if (!rows.length) return unavailable('options', symbol, 'Yahoo chain was empty.', 'yahoo');
    return ok('options', symbol, 'yahoo', {
      underlying: { price: S ?? null, asOf: new Date().toISOString() },
      expirations: [expiry].filter(Boolean),
      rows,
      greeksComputed: true,
      note: 'Greeks computed with Black-Scholes from Yahoo implied volatility — estimates, not exchange values.',
    });
  } catch (err) {
    return unavailable('options', symbol, `Yahoo request failed (${err.message}).`, 'yahoo');
  }
}

// Try sources in order of quality: CBOE (real greeks) → Tradier → MarketData.app
// → Yahoo (computed greeks). Each returns an honest "unavailable" on failure.
async function getOptions(symbol, expiry) {
  const sources = [];
  try { sources.push(await getCboeChain(symbol)); } catch (err) { sources.push(unavailable('options', symbol, `CBOE: ${err.message}`, 'cboe')); }
  for (const s of sources) if (s.status === 'ok') return s;
  if (process.env.TRADIER_API_KEY) {
    try { const t = await getTradierOptions(symbol, expiry); if (t.status === 'ok') return t; sources.push(t); } catch (err) { sources.push(unavailable('options', symbol, `Tradier: ${err.message}`, 'tradier')); }
  }
  if (process.env.MARKETDATA_TOKEN) {
    try { const m = await getMarketDataOptions(symbol, expiry); if (m.status === 'ok') return m; sources.push(m); } catch (err) { sources.push(unavailable('options', symbol, `MarketData.app: ${err.message}`, 'marketdata')); }
  }
  try { const y = await getYahooOptions(symbol); if (y.status === 'ok') return y; sources.push(y); } catch (err) { sources.push(unavailable('options', symbol, `Yahoo: ${err.message}`, 'yahoo')); }
  const primary = sources[0];
  return { ...primary, message: `No free chain available for ${symbol}. ${primary?.message || ''}`.trim() };
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

  // Single-user friendly: no login required. If a Supabase bearer IS supplied
  // we verify it (useful for audit), but anonymous requests are allowed and
  // protected by a rate limit instead.
  if (rateLimited(req)) {
    return json({ symbol: rawSymbol, kind, status: 'error', message: 'Too many requests — please slow down.' }, 429);
  }
  const authHeader = req.headers.get('authorization');
  const supabaseUrl = process.env.SUPABASE_URL;
  const anon = process.env.SUPABASE_ANON_KEY;
  if (authHeader?.startsWith('Bearer ') && supabaseUrl && anon) {
    await fetch(`${supabaseUrl}/auth/v1/user`, { headers: { authorization: authHeader, apikey: anon } }).catch(() => null);
  }

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
      case 'candles': body = await getCandles(rawSymbol, url.searchParams.get('source') || ''); break;
      case 'options': body = await getOptions(rawSymbol, expiry); break;
      case 'search': body = await search(query); break;
      default: return json({ status: 'error', message: 'Unknown kind.' }, 400);
    }
    body.cache = 'miss';
    if (body.status === 'ok') cache.set(cacheKey, { body, expires: Date.now() + (TTL[kind] || 60_000) });
    return json(body);
  } catch (err) {
    if (err?.unavailable) return json(unavailable(kind, rawSymbol, err.message), 200);
    return json(unavailable(kind, rawSymbol, `Could not load ${kind} (${err?.message || 'provider error'}). Enter it manually below.`, null), 200);
  }
};
