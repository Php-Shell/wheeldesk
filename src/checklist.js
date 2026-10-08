// Dynamic screening checklist. Each item returns a status:
//   pass | warn | fail | unknown
// "unknown" is used whenever a value could not be verified. We never guess.

import { toNum, round, money, pct, toDMY, parseDMY } from './format.js';
import { mergeSettings, putMetrics } from './calc.js';

export const CHECKLIST_GROUPS = [
  { id: 'A', title: 'Stock quality' },
  { id: 'B', title: 'Option liquidity' },
  { id: 'C', title: 'Trade quality' },
  { id: 'D', title: 'Portfolio fit' },
];

const item = (id, group, label, why, evaluate) => ({ id, group, label, why, evaluate });

export const CHECKLIST = [
  item('A1', 'A', 'Price fits my budget', 'The collateral you must set aside is strike x 100 x contracts.', (c) => {
    const s = mergeSettings(c.settings);
    const max = (toNum(c.budget, 0) * s.maxPerWheelPct);
    if (c.putMetrics) {
      const ok = c.putMetrics.collateral <= max;
      return { status: ok ? 'pass' : 'fail', detail: `Collateral ${money(c.putMetrics.collateral)} vs max ${money(max)} per wheel.` };
    }
    const price = toNum(c.price, null);
    if (price === null) return { status: 'unknown', detail: 'Current price unavailable.' };
    const collateral = price * 100;
    return { status: collateral <= max ? 'pass' : 'fail', detail: `100 shares would cost about ${money(collateral)} vs max ${money(max)}.` };
  }),

  item('A2', 'A', 'Market cap is at least $10B', 'Large caps are usually more stable and their options are more liquid.', (c) => {
    const mc = toNum(c.profile?.marketCap, null);
    const s = mergeSettings(c.settings).thresholds;
    // The standard rule is a fixed $10B pass / $2B warn. A profile may make it
    // STRICTER (lower), but must never raise the bar above the standard rule.
    const passAt = Math.min(toNum(s.marketCap, 10e9) || 10e9, 10e9);
    const warnAt = Math.min(toNum(s.marketCapWarn, 2e9) || 2e9, 2e9);
    const label = `Market cap is at least ${money(passAt, 'USD', 0)}`;
    if (mc === null) return { status: 'unknown', detail: 'Market cap unavailable — enter it manually.', label };
    if (mc >= passAt) return { status: 'pass', detail: `Market cap ${money(mc, 'USD', 0)} is at or above ${money(passAt, 'USD', 0)}.`, label };
    if (mc >= warnAt) return { status: 'warn', detail: `Market cap ${money(mc, 'USD', 0)} is between ${money(warnAt, 'USD', 0)} and ${money(passAt, 'USD', 0)}.`, label };
    return { status: 'fail', detail: `Market cap ${money(mc, 'USD', 0)} is below ${money(warnAt, 'USD', 0)}.`, label };
  }),

  item('A3', 'A', 'Profitable over the last 12 months', 'Uses diluted earnings per share (EPS) over the trailing 12 months. A profitable company is less likely to fall sharply on bad news.', (c) => {
    const vendor = toNum(c.metrics?.epsTTM, null);       // provider TTM (authoritative)
    const quarterly = toNum(c.metrics?.epsTTMFromQuarters, null); // cross-check only
    const eps = vendor ?? quarterly;
    if (eps === null) return { status: 'unknown', detail: 'Trailing EPS unavailable — enter it manually. Verify on the link: Income Statement → EPS / Loss per share (TTM).' };
    const source = vendor != null ? 'provider TTM' : 'sum of last 4 quarters';
    // Quarterly "actuals" are usually adjusted and often differ from GAAP TTM,
    // so the TTM value wins and the quarters figure is only a note.
    const note = vendor != null && quarterly != null && Math.abs(vendor - quarterly) >= 0.05
      ? ` Cross-check: last-4-quarters sum ${quarterly.toFixed(2)} (quarterly figures are often adjusted). Verify on the link: Income Statement → EPS / Loss per share (TTM).`
      : '';
    return eps > 0
      ? { status: 'pass', detail: `Trailing 12-month EPS is ${eps.toFixed(2)} (${source}).${note}` }
      : { status: 'fail', detail: `Trailing 12-month EPS is negative (${eps.toFixed(2)}, ${source}).${note}` };
  }),

  item('A4', 'A', 'Not in a severe downtrend', 'A severe downtrend (well below the 200-day average) is a falling knife. A small dip below the average is not necessarily a problem.', (c) => {
    const v = toNum(c.priceVsMa200, null);
    const s = mergeSettings(c.settings).thresholds;
    const passPct = toNum(s.trendPassPct, -5); // at/above this = not severe
    const failPct = toNum(s.trendFailPct, -10); // below this = severe
    if (v === null) {
      if (c.manual?.trendOverride) return { status: 'pass', detail: `200-day average unavailable. Your override: ${c.manual.trendOverride}` };
      return { status: 'unknown', detail: '200-day average unavailable — check the chart or override with a reason.' };
    }
    const help = `"Severe" here just means the price is more than ${Math.abs(failPct)}% below its 200-day average (200-DMA). The chart's 200-DMA line and this % are the same number: (price − 200-DMA) ÷ 200-DMA. If 200-DMA is 13.48 and the price is ~12.11, that's (12.11 − 13.48) ÷ 13.48 = −${Math.abs(v).toFixed(1)}%, which is past your −${Math.abs(failPct)}% line. It is a label, not a judgment — change the line in Settings → Checklist thresholds → "A4 fail".`;
    if (v >= 0) return { status: 'pass', detail: `Price is ${v.toFixed(1)}% above its 200-day average.` };
    if (v >= passPct) return { status: 'pass', detail: `Price is ${Math.abs(v).toFixed(1)}% below its 200-day average — within the ${Math.abs(passPct)}% tolerance, so not a severe downtrend.` };
    if (v >= failPct) return { status: 'warn', detail: `Price is ${Math.abs(v).toFixed(1)}% below its 200-day average — a mild downtrend, watch it.`, help };
    if (c.manual?.trendOverride) return { status: 'warn', detail: `Price is ${Math.abs(v).toFixed(1)}% below the 200-day average (past your −${Math.abs(failPct)}% line). Your override: ${c.manual.trendOverride}`, help };
    return { status: 'fail', detail: `Price is ${Math.abs(v).toFixed(1)}% below its 200-day average — past your −${Math.abs(failPct)}% "severe downtrend" line (default −10%).`, help };
  }),

  item('A5', 'A', 'Average daily volume at least 1M shares', 'Liquid stock is easier to trade and to exit.', (c) => {
    const vol = toNum(c.metrics?.avgVolume ?? c.metrics?.volume, null);
    if (vol === null) return { status: 'unknown', detail: 'Average volume unavailable.' };
    const s = mergeSettings(c.settings).thresholds;
    return vol >= s.volume ? { status: 'pass', detail: `Average volume ${(vol / 1e6).toFixed(2)}M shares/day.` } : { status: 'fail', detail: `Average volume ${(vol / 1e6).toFixed(2)}M shares/day is below 1M.` };
  }),

  item('A6', 'A', 'Not a meme / new IPO / binary biotech / leveraged ETF', 'These can gap violently and destroy a conservative strategy.', (c) => {
    const v = c.manual?.notMeme;
    if (v === true) return { status: 'pass', detail: 'You confirmed this is a normal, established company or broad ETF.' };
    if (v === false) return { status: 'fail', detail: 'You flagged this as a meme stock, new IPO, binary biotech or leveraged ETF.' };
    return { status: 'unknown', detail: 'Please confirm this manually (required).' };
  }),

  item('A7', 'A', 'I would be happy to own 100 shares at this price', 'The whole strategy only works if assignment is acceptable to you.', (c) => {
    const v = c.manual?.happyToOwn;
    if (v === true) return { status: 'pass', detail: 'Confirmed: you are happy to own it at this price for months.' };
    if (v === false) return { status: 'fail', detail: 'You would not be happy to own it. Do not sell this put.' };
    return { status: 'unknown', detail: 'Required confirmation — say yes only if assignment is genuinely acceptable.' };
  }),

  item('B8', 'B', 'Options exist at 30–45 DTE', 'You need a listed expiry in the 30–45 day window.', (c) => {
    const d = toNum(c.option?.dte, null);
    const s = mergeSettings(c.settings);
    if (d === null) return { status: 'unknown', detail: 'Pick an expiry in the strike picker.' };
    return d >= s.dteMin && d <= s.dteMax ? { status: 'pass', detail: `${d} days to expiry.` } : { status: 'warn', detail: `${d} days to expiry is outside the ${s.dteMin}–${s.dteMax} DTE preference.` };
  }),

  item('B9', 'B', 'Open interest at least 500', 'Use the Open Interest of the specific PUT contract at YOUR chosen strike (the OI column on that contract row), not the put/call ratio or the Call OI / Put OI totals. Higher OI means easier fills and tighter prices.', (c) => {
    const oi = toNum(c.option?.openInterest, null);
    const s = mergeSettings(c.settings).thresholds;
    if (oi === null) return { status: 'unknown', detail: 'Open interest unavailable — open the Finviz option chain and read the OI of your exact put strike (ignore the Put/Call OI totals).' };
    if (oi >= s.openInterest) return { status: 'pass', detail: `Open interest ${oi}.` };
    if (oi >= s.openInterestWarn) return { status: 'warn', detail: `Open interest ${oi} is between 100 and 500.` };
    return { status: 'fail', detail: `Open interest ${oi} is below 100.` };
  }),

  item('B10', 'B', 'Bid–ask spread is tight', 'A wide spread is a hidden cost every time you trade.', (c) => {
    const bid = toNum(c.option?.bid, null);
    const ask = toNum(c.option?.ask, null);
    const s = mergeSettings(c.settings).thresholds;
    if (bid === null || ask === null || bid <= 0 || ask <= 0) return { status: 'unknown', detail: 'Bid and ask unavailable — read the bid/ask of your exact contract (Finviz option chain) and enter them in the strike row.' };
    const spread = ask - bid;
    const mid = (ask + bid) / 2;
    const pctOfMid = mid > 0 ? spread / mid : Infinity;
    if (spread <= s.spread || pctOfMid <= s.spreadPct) return { status: 'pass', detail: `Spread ${money(spread)} (${(pctOfMid * 100).toFixed(1)}% of mid).` };
    return { status: 'fail', detail: `Spread ${money(spread)} (${(pctOfMid * 100).toFixed(1)}% of mid) is too wide.` };
  }),

  item('C11', 'C', 'Strike delta between 0.15 and 0.30', 'Lower delta = higher probability of keeping the premium.', (c) => {
    const delta = toNum(c.option?.delta, null);
    const s = mergeSettings(c.settings);
    if (delta === null) return { status: 'unknown', detail: 'Delta unavailable — read the delta of your exact contract (Finviz option chain has a Delta column) or enter it from IBKR.' };
    // Round to 2 decimals so a displayed 0.30 (e.g. 0.3049) is treated as 0.30.
    const abs = Math.round(Math.abs(delta) * 100) / 100;
    if (abs >= s.deltaMin - 1e-9 && abs <= s.deltaMax + 1e-9) return { status: 'pass', detail: `Delta ${abs.toFixed(2)} is inside the ${s.deltaMin}–${s.deltaMax} band.` };
    if (abs < s.deltaMin) return { status: 'warn', detail: `Delta ${abs.toFixed(2)} is more conservative than the ${s.deltaMin}–${s.deltaMax} band.` };
    return { status: 'warn', detail: `Delta ${abs.toFixed(2)} is more aggressive than the ${s.deltaMin}–${s.deltaMax} band.` };
  }),

  item('C12', 'C', 'Implied volatility is reasonable', 'Too low means little premium; too high often signals an event.', (c) => {
    const ivRank = toNum(c.option?.ivRank ?? c.manual?.ivRank, null);
    const iv = toNum(c.option?.iv, null);
    const s = mergeSettings(c.settings).thresholds;
    if (ivRank === null) {
      return {
        status: 'unknown',
        detail: iv !== null
          ? `Implied volatility is ${iv.toFixed(1)}%. Enter MarketChameleon's "IV Percentile Rank" (0–100) — e.g. 87 means IV was lower 87% of the last year.`
          : 'IV Rank unavailable — open the MarketChameleon link and enter its "IV Percentile Rank" (0–100).',
      };
    }
    if (ivRank >= s.ivMin && ivRank <= s.ivMax) return { status: 'pass', detail: `IV Rank ${ivRank}.` };
    if (ivRank < s.ivLow) return { status: 'warn', detail: `IV Rank ${ivRank} is low — premium may be small.` };
    if (ivRank > s.ivHigh) return { status: 'warn', detail: `IV Rank ${ivRank} is high — something may be happening.` };
    return { status: 'warn', detail: `IV Rank ${ivRank} is outside the ideal 30–60 band.` };
  }),

  item('C13', 'C', 'Annualized return is 10–30%', 'The target band for modest, repeatable income.', (c) => {
    const ann = toNum(c.putMetrics?.annualized, null);
    const s = mergeSettings(c.settings);
    if (ann === null) return { status: 'unknown', detail: 'Pick a strike and premium to compute the return.' };
    if (ann >= s.returnMin && ann <= s.returnMax) return { status: 'pass', detail: `Annualized ${ann.toFixed(1)}%.` };
    if (ann < s.returnMin) return { status: 'warn', detail: `Annualized ${ann.toFixed(1)}% is below target.` };
    if (ann > s.returnHigh) return { status: 'warn', detail: `Annualized ${ann.toFixed(1)}% is above 50% — likely volatile or news-driven.` };
    return { status: 'warn', detail: `Annualized ${ann.toFixed(1)}% is above 30%.` };
  }),

  item('C14', 'C', 'No earnings before expiration', 'A surprise earnings move can push the put deep in the money.', (c) => {
    const next = c.earnings?.nextDate;
    const expiry = c.option?.expiry;
    if (!next) return { status: 'unknown', detail: 'Next earnings date unknown — enter it manually or verify before trading.' };
    if (!expiry) return { status: 'unknown', detail: `Next earnings ${toDMY(next)}. Pick an expiry to compare.` };
    const nextMs = new Date(next).getTime();
    const expMs = new Date(`${expiry}T23:59:59Z`).getTime();
    if (!Number.isFinite(nextMs) || !Number.isFinite(expMs)) return { status: 'unknown', detail: 'Could not compare earnings and expiry dates.' };
    return nextMs <= expMs ? { status: 'fail', detail: `Earnings on ${toDMY(next)} is before the ${toDMY(expiry)} expiry.` } : { status: 'pass', detail: `Next earnings ${toDMY(next)} is after the ${toDMY(expiry)} expiry.` };
  }),

  item('C15', 'C', 'Ex-dividend dates noted', 'For a short put this is informational; it matters more for covered calls. If the company pays no dividend there is nothing to watch.', (c) => {
    const d = c.dividends?.next;
    const list = c.dividends?.list || [];
    const yieldPct = toNum(c.metrics?.dividendYield, null);
    const knownPays = c.dividends?.pays;
    const pays = knownPays !== undefined && knownPays !== null ? knownPays : yieldPct !== null ? yieldPct > 0 : d ? true : list.length ? true : null;
    if (d?.exDate) {
      return { status: 'pass', detail: `Next ex-dividend ${toDMY(d.exDate)}${d.amount ? ` (${money(d.amount)}/share)` : ''}${d.estimated ? ' — estimated from the last ex-date, verify before relying on it' : ''}.` };
    }
    if (pays === false) return { status: 'pass', detail: 'This company does not pay a dividend — nothing to watch (informational for a short put).' };
    if (pays === true) {
      const y = yieldPct != null ? `~${yieldPct.toFixed(2)}% yield` : 'pays a dividend';
      return { status: 'warn', detail: `Pays a dividend (${y}) but the next ex-date was not found — check the Nasdaq dividend link before holding shares.` };
    }
    return { status: 'pass', detail: 'No dividend record found on the free sources — treated as non-dividend-paying (nothing to watch for a short put).' };
  }),

  item('D16', 'D', 'Enough free cash after the reserve', 'Never commit money you may need elsewhere.', (c) => {
    const s = mergeSettings(c.settings);
    if (!c.putMetrics) return { status: 'unknown', detail: 'Pick a strike first.' };
    const cash = toNum(c.portfolio?.availableCash, null);
    if (cash === null) return { status: 'unknown', detail: 'Available cash unknown.' };
    const reserve = toNum(c.budget, 0) * s.reservePct;
    const after = cash - c.putMetrics.collateral;
    if (after >= reserve) return { status: 'pass', detail: `${money(after)} free after the trade, reserve is ${money(reserve)}.` };
    return { status: 'fail', detail: `Only ${money(after)} free after the trade; you need ${money(reserve)} reserve.` };
  }),

  item('D17', 'D', 'Sector diversification', 'Stacking one sector multiplies the same risk.', (c) => {
    const same = toNum(c.portfolio?.sameSectorWheels, 0);
    if (same > 0) return { status: 'warn', detail: `${same} other open wheel(s) are in the same sector (${c.profile?.industry || 'unknown'}).` };
    return { status: 'pass', detail: 'No other open wheel in this sector.' };
  }),

  item('D18', 'D', 'Max number of wheels not exceeded', 'Keeps the portfolio small and manageable.', (c) => {
    const open = toNum(c.portfolio?.openWheels, 0);
    const max = toNum(c.settings?.maxWheels, 3);
    return open < max ? { status: 'pass', detail: `${open} of ${max} wheel slots used.` } : { status: 'fail', detail: `${open} of ${max} wheel slots used — close one first.` };
  }),
];

// Where to verify each item online, for the current ticker.
const yahoo = (s) => `https://finance.yahoo.com/quote/${encodeURIComponent(s)}`;
export const ITEM_LINKS = {
  A2: (s) => `${yahoo(s)}/key-statistics`,
  A3: (s) => `https://stockanalysis.com/stocks/${encodeURIComponent(s.toLowerCase())}/statistics/`,
  A4: (s) => `https://www.tradingview.com/chart/?symbol=${encodeURIComponent(s)}`,
  A5: (s) => `${yahoo(s)}/key-statistics`,
  A6: (s) => `https://finviz.com/quote.ashx?t=${encodeURIComponent(s)}`,
  B8: (s) => `${yahoo(s)}/options`,
  B9: (s) => `https://finviz.com/quote.ashx?t=${encodeURIComponent(s)}&ty=oc`,
  B10: (s) => `https://finviz.com/quote.ashx?t=${encodeURIComponent(s)}&ty=oc`,
  C11: (s) => `https://finviz.com/quote.ashx?t=${encodeURIComponent(s)}&ty=oc`,
  C12: (s) => `https://marketchameleon.com/Overview/${encodeURIComponent(s)}/IV/`,
  C14: (s) => `https://www.nasdaq.com/market-activity/stocks/${encodeURIComponent(s.toLowerCase())}/earnings`,
  C15: (s) => `https://www.nasdaq.com/market-activity/stocks/${encodeURIComponent(s.toLowerCase())}/dividend-history`,
};

// Which "Manual / override values" field feeds each checklist item, so the UI
// can offer a "manual entry" jump for items that are not verified.
export const ITEM_MANUAL_FIELD = {
  A1: 'price',
  A2: 'marketCap',
  A3: 'epsTTM',
  A4: 'priceVsMa200',
  A5: 'avgVolume',
  A6: 'notMeme',
  A7: 'happyToOwn',
  C12: 'ivRank',
  C14: 'nextEarnings',
  C15: 'exDividend',
};

export function manualFieldFor(id) {
  return ITEM_MANUAL_FIELD[id] || null;
}

export function itemLink(id, symbol) {
  if (!symbol) return null;
  try {
    return ITEM_LINKS[id]?.(symbol) || null;
  } catch {
    return null;
  }
}

export const CRITICAL_ITEMS = new Set(['A1', 'A7', 'C14', 'D16']);

export const STATUS_META = {
  pass: { icon: '✅', label: 'Pass', className: 'pass' },
  warn: { icon: '⚠️', label: 'Borderline', className: 'warn' },
  fail: { icon: '❌', label: 'Fail', className: 'fail' },
  unknown: { icon: '❔', label: 'Not verified', className: 'unknown' },
};

export function evaluateChecklist(context) {
  const overrides = context.overrides || {};
  const results = CHECKLIST.map((entry) => {
    let out;
    try {
      out = entry.evaluate(context) || { status: 'unknown', detail: '' };
    } catch (err) {
      out = { status: 'unknown', detail: 'Could not evaluate with the available data.' };
    }
    const base = { ...entry, ...out, link: itemLink(entry.id, context.symbol), manualField: manualFieldFor(entry.id) };
    // A user override wins (with a reason), so any Borderline/Fail/Not-verified
    // item can be consciously accepted.
    const ov = overrides[entry.id];
    if (ov && ov.status) {
      const meta = STATUS_META[ov.status] || STATUS_META.pass;
      return { ...base, status: ov.status, overridden: true, overrideReason: ov.reason || '', originalStatus: out.status, detail: `Overridden to ${meta.label}${ov.reason ? ` — ${ov.reason}` : ''} (was: ${STATUS_META[out.status]?.label || out.status}).`, meta };
    }
    return { ...base, meta: STATUS_META[out.status] || STATUS_META.unknown };
  });
  const passCount = results.filter((r) => r.status === 'pass').length;
  const failCount = results.filter((r) => r.status === 'fail').length;
  const unknownCount = results.filter((r) => r.status === 'unknown').length;
  const criticalFails = results.filter((r) => r.status === 'fail' && CRITICAL_ITEMS.has(r.id));
  const criticalUnknown = results.filter((r) => r.status === 'unknown' && CRITICAL_ITEMS.has(r.id));

  let verdict = { key: 'good', label: 'Good candidate', className: 'pass' };
  if (criticalFails.length > 0) {
    verdict = { key: 'avoid', label: 'Avoid', className: 'fail', reasons: criticalFails.map((r) => `${r.id} ${r.label}`) };
  } else if (failCount >= 3) {
    verdict = { key: 'avoid', label: 'Avoid', className: 'fail', reasons: results.filter((r) => r.status === 'fail').map((r) => `${r.id} ${r.label}`) };
  } else if (criticalUnknown.length > 0 || failCount > 0 || unknownCount > 4) {
    verdict = { key: 'caution', label: 'Proceed with caution', className: 'warn' };
  }

  return {
    items: results,
    passCount,
    total: results.length,
    failCount,
    unknownCount,
    criticalFails,
    criticalUnknown,
    score: `${passCount}/${results.length}`,
    verdict,
  };
}

// Build the context object from the fetched data + manual inputs.
// Any manual value the user types overrides the fetched one (manual wins).
export function buildChecklistContext({ state, data, option, manual, settings, overrides }) {
  const s = mergeSettings(settings || state?.settings);
  const m = manual || {};
  const has = (v) => v !== undefined && v !== null && v !== '';
  const budget = toNum(state?.account?.budget, s.budget);
  const cash = toNum(state?.account?.cash, budget);

  const price = has(m.price) ? toNum(m.price, null) : (data?.quote?.price ?? null);
  const metrics = putMetrics({
    strike: option?.strike,
    mid: option?.mid,
    bid: option?.bid,
    ask: option?.ask,
    contracts: 1,
    commission: s.commission,
    stockPrice: price,
    daysToExpiry: option?.dte,
    delta: option?.delta,
  });

  const profile = { ...(data?.profile || {}) };
  if (has(m.marketCap)) profile.marketCap = toNum(m.marketCap, profile.marketCap);
  const marketMetrics = { ...(data?.metrics || {}) };
  if (has(m.epsTTM)) {
    const v = toNum(m.epsTTM, null);
    // A manual EPS overrides both the vendor TTM and the quarterly sum.
    marketMetrics.epsTTM = v;
    marketMetrics.epsTTMFromQuarters = v;
  }
  if (has(m.avgVolume)) marketMetrics.avgVolume = toNum(m.avgVolume, marketMetrics.avgVolume);

  const earnings = { ...(data?.earnings || {}) };
  if (has(m.nextEarnings)) earnings.nextDate = parseDMY(m.nextEarnings) || m.nextEarnings;

  const dividends = { ...(data?.dividends || {}) };
  if (has(m.exDividend)) dividends.next = { exDate: parseDMY(m.exDividend) || m.exDividend, amount: has(m.dividendAmount) ? toNum(m.dividendAmount, null) : dividends.next?.amount ?? null, estimated: false };

  const priceVsMa200 = has(m.priceVsMa200) ? toNum(m.priceVsMa200, null) : (data?.priceVsMa200 ?? null);

  const openWheels = (state?.wheels || []).filter((w) => w.state !== 'complete');
  const sameSectorWheels = profile.industry ? openWheels.filter((w) => (w.sector || '') === profile.industry).length : 0;
  return {
    symbol: data?.symbol,
    price,
    profile,
    metrics: marketMetrics,
    dividends,
    earnings,
    priceVsMa200,
    option: option || null,
    putMetrics: metrics,
    manual: m,
    overrides: overrides || {},
    settings: s,
    budget,
    portfolio: {
      availableCash: cash,
      openWheels: openWheels.length,
      sameSectorWheels,
    },
  };
}
