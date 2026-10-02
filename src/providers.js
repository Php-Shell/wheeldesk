// ---------------------------------------------------------------------------
// Market data layer. All calls go through the authenticated Netlify function
// so provider keys never reach the browser. Every result carries its source
// and timestamp; missing data is reported as "unavailable" and never invented.
// ---------------------------------------------------------------------------

const FN = '/.netlify/functions';
const memory = new Map();
const TTL = 5 * 60 * 1000;

let configCache = null;

export async function getConfig() {
  if (configCache) return configCache;
  if (window.WHEEL_SUPABASE_URL) {
    configCache = { supabaseUrl: window.WHEEL_SUPABASE_URL, supabaseAnonKey: window.WHEEL_SUPABASE_ANON_KEY || '', providers: { finnhub: true, tradier: false } };
    return configCache;
  }
  try {
    const r = await fetch(`${FN}/config`);
    if (!r.ok) throw new Error(`config ${r.status}`);
    configCache = await r.json();
  } catch {
    configCache = { supabaseUrl: '', supabaseAnonKey: '', providers: { finnhub: false, tradier: false }, offline: true };
  }
  return configCache;
}

async function call(kind, params = {}, token = null) {
  const url = new URL(`${FN}/market`, window.location.origin);
  url.searchParams.set('kind', kind);
  for (const [k, v] of Object.entries(params)) {
    if (v !== null && v !== undefined && v !== '') url.searchParams.set(k, v);
  }
  const headers = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  let r;
  try {
    r = await fetch(url.toString(), { headers });
  } catch (err) {
    return { status: 'unavailable', provider: null, message: 'Could not reach the data proxy. Are you running with Netlify?', data: null };
  }
  if (r.status === 401) return { status: 'auth', provider: null, message: 'Sign in to load live market data.', data: null };
  let body;
  try {
    body = await r.json();
  } catch {
    return { status: 'error', provider: null, message: `Bad response (${r.status}).`, data: null };
  }
  return body;
}

function cached(key, producer) {
  const hit = memory.get(key);
  if (hit && hit.expires > Date.now()) return hit.value;
  const value = producer();
  memory.set(key, { value, expires: Date.now() + TTL });
  return value;
}

export function clearCache() {
  memory.clear();
}

export async function loadTickerData(symbol, token) {
  const s = String(symbol || '').toUpperCase();
  if (!s) return null;
  return cached(`ticker:${s}:${token ? 'auth' : 'anon'}`, async () => {
    const [quote, profile, metrics, earnings, dividends, candles] = await Promise.all([
      call('quote', { symbol: s }, token),
      call('profile', { symbol: s }, token),
      call('metrics', { symbol: s }, token),
      call('earnings', { symbol: s }, token),
      call('dividends', { symbol: s }, token),
      call('candles', { symbol: s }, token),
    ]);

    const sources = [];
    const note = (env, label) => {
      if (env?.provider) sources.push({ label, provider: env.provider, fetchedAt: env.fetchedAt, cache: env.cache });
    };
    note(quote, 'Quote');
    note(profile, 'Profile');
    note(metrics, 'Fundamentals');
    note(earnings, 'Earnings');
    note(dividends, 'Dividends');
    note(candles, 'Candles');

    const q = quote?.data || {};
    const p = profile?.data || {};
    const m = metrics?.data || {};
    const e = earnings?.data || {};
    const dv = dividends?.data || {};
    const candlesData = candles?.data || {};

    const price = q.price ?? null;
    let priceVsMa200 = null;
    if (price !== null && candlesData.ma200) priceVsMa200 = ((price - candlesData.ma200) / candlesData.ma200) * 100;
    else if (m.priceVsMa200 !== undefined && m.priceVsMa200 !== null) priceVsMa200 = m.priceVsMa200;

    const avgVolume = m.avgVolume ?? candlesData.avgVolume ?? null;

    return {
      symbol: s,
      fetchedAt: new Date().toISOString(),
      sources,
      available: sources.length > 0,
      quote: {
        price,
        change: q.change ?? null,
        percent: q.percent ?? null,
        open: q.open ?? null,
        high: q.high ?? null,
        low: q.low ?? null,
        prevClose: q.prevClose ?? null,
        provider: quote?.provider || null,
        fetchedAt: quote?.fetchedAt || null,
        status: quote?.status || (price !== null ? 'ok' : 'unavailable'),
      },
      profile: {
        name: p.name || null,
        exchange: p.exchange || null,
        industry: p.industry || null,
        ipo: p.ipo || null,
        marketCap: p.marketCap ?? null,
        currency: p.currency || 'USD',
        website: p.website || null,
        status: profile?.status || (p.name ? 'ok' : 'unavailable'),
      },
      metrics: {
        epsTTM: m.epsTTM ?? null,
        avgVolume,
        high52: m.high52 ?? null,
        low52: m.low52 ?? null,
        beta: m.beta ?? null,
        dividendYield: m.dividendYield ?? null,
        pe: m.pe ?? null,
        priceVsMa200: m.priceVsMa200 ?? null,
        status: metrics?.status || 'unavailable',
      },
      earnings: {
        nextDate: e.nextDate || null,
        daysUntil: e.daysUntil ?? null,
        past: e.past || [],
        status: earnings?.status || (e.nextDate ? 'ok' : 'unavailable'),
      },
      dividends: {
        next: dv.next || null,
        list: dv.list || [],
        status: dividends?.status || 'unavailable',
      },
      ma200: candlesData.ma200 ?? null,
      priceVsMa200,
      authRequired: [quote, profile, metrics, earnings, dividends, candles].some((x) => x?.status === 'auth'),
      messages: [...new Set([quote, profile, metrics, earnings, dividends, candles].filter((x) => x?.message).map((x) => x.message))],
      raw: { quote, profile, metrics, earnings, dividends, candles },
    };
  });
}

export async function loadOptions(symbol, expiry, token) {
  const s = String(symbol || '').toUpperCase();
  const key = `options:${s}:${expiry || 'nearest'}`;
  return cached(key, () => call('options', { symbol: s, expiry }, token));
}

export async function searchSymbols(query, token) {
  const q = String(query || '').trim();
  if (q.length < 1) return [];
  const res = await call('search', { q }, token);
  return res?.data || [];
}

export async function testProvider(token) {
  return call('quote', { symbol: 'AAPL' }, token);
}
