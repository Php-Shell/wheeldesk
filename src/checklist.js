// Dynamic screening checklist. Each item returns a status:
//   pass | warn | fail | unknown
// "unknown" is used whenever a value could not be verified. We never guess.

import { toNum, round, money, pct } from './format.js';
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
    if (mc === null) return { status: 'unknown', detail: 'Market cap unavailable — enter it manually.' };
    if (mc >= s.marketCap) return { status: 'pass', detail: `Market cap ${money(mc, 'USD', 0)}.` };
    if (mc >= s.marketCapWarn) return { status: 'warn', detail: `Market cap ${money(mc, 'USD', 0)} is between $2B and $10B.` };
    return { status: 'fail', detail: `Market cap ${money(mc, 'USD', 0)} is below $2B.` };
  }),

  item('A3', 'A', 'Profitable over the last 12 months', 'A profitable company is less likely to fall sharply on bad news.', (c) => {
    const eps = toNum(c.metrics?.epsTTM, null);
    if (eps === null) return { status: 'unknown', detail: 'Trailing EPS unavailable — verify manually.' };
    return eps > 0 ? { status: 'pass', detail: `Trailing 12-month EPS is ${eps.toFixed(2)}.` } : { status: 'fail', detail: `Trailing 12-month EPS is negative (${eps.toFixed(2)}).` };
  }),

  item('A4', 'A', 'Not in a severe downtrend', 'Buying a falling knife increases the chance of staying assigned at a loss.', (c) => {
    const v = toNum(c.priceVsMa200, null);
    if (v === null) {
      if (c.manual?.trendOverride) return { status: 'warn', detail: `200-day average unavailable. Override: ${c.manual.trendOverride}` };
      return { status: 'unknown', detail: '200-day average unavailable — check the chart or override with a reason.' };
    }
    if (v >= 0) return { status: 'pass', detail: `Price is ${v.toFixed(1)}% above its 200-day average.` };
    if (c.manual?.trendOverride) return { status: 'warn', detail: `Price is ${Math.abs(v).toFixed(1)}% below the 200-day average. Override: ${c.manual.trendOverride}` };
    return { status: 'fail', detail: `Price is ${Math.abs(v).toFixed(1)}% below its 200-day average.` };
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

  item('B9', 'B', 'Open interest at least 500', 'Higher open interest means easier fills and tighter prices.', (c) => {
    const oi = toNum(c.option?.openInterest, null);
    const s = mergeSettings(c.settings).thresholds;
    if (oi === null) return { status: 'unknown', detail: 'Open interest unavailable — enter it from IBKR.' };
    if (oi >= s.openInterest) return { status: 'pass', detail: `Open interest ${oi}.` };
    if (oi >= s.openInterestWarn) return { status: 'warn', detail: `Open interest ${oi} is between 100 and 500.` };
    return { status: 'fail', detail: `Open interest ${oi} is below 100.` };
  }),

  item('B10', 'B', 'Bid–ask spread is tight', 'A wide spread is a hidden cost every time you trade.', (c) => {
    const bid = toNum(c.option?.bid, null);
    const ask = toNum(c.option?.ask, null);
    const s = mergeSettings(c.settings).thresholds;
    if (bid === null || ask === null || bid <= 0 || ask <= 0) return { status: 'unknown', detail: 'Bid and ask unavailable — enter them manually.' };
    const spread = ask - bid;
    const mid = (ask + bid) / 2;
    const pctOfMid = mid > 0 ? spread / mid : Infinity;
    if (spread <= s.spread || pctOfMid <= s.spreadPct) return { status: 'pass', detail: `Spread ${money(spread)} (${(pctOfMid * 100).toFixed(1)}% of mid).` };
    return { status: 'fail', detail: `Spread ${money(spread)} (${(pctOfMid * 100).toFixed(1)}% of mid) is too wide.` };
  }),

  item('C11', 'C', 'Strike delta between 0.15 and 0.30', 'Lower delta = higher probability of keeping the premium.', (c) => {
    const delta = toNum(c.option?.delta, null);
    const s = mergeSettings(c.settings);
    if (delta === null) return { status: 'unknown', detail: 'Delta unavailable — enter it from IBKR.' };
    const abs = Math.abs(delta);
    if (abs >= s.deltaMin && abs <= s.deltaMax) return { status: 'pass', detail: `Delta ${abs.toFixed(2)}.` };
    if (abs < s.deltaMin) return { status: 'warn', detail: `Delta ${abs.toFixed(2)} is more conservative than the target band.` };
    return { status: 'warn', detail: `Delta ${abs.toFixed(2)} is more aggressive than the target band.` };
  }),

  item('C12', 'C', 'Implied volatility is reasonable', 'Too low means little premium; too high often signals an event.', (c) => {
    const ivRank = toNum(c.option?.ivRank ?? c.manual?.ivRank, null);
    const iv = toNum(c.option?.iv, null);
    const s = mergeSettings(c.settings).thresholds;
    if (ivRank === null) {
      return {
        status: 'unknown',
        detail: iv !== null
          ? `Implied volatility is ${iv.toFixed(1)}%. IV Rank is not available from free data — enter it manually if you have it.`
          : 'IV Rank unavailable — enter it manually if you have it.',
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
    if (!next) return { status: 'unknown', detail: 'Next earnings date unknown — verify before trading.' };
    if (!expiry) return { status: 'unknown', detail: `Next earnings ${next}. Pick an expiry to compare.` };
    const nextMs = new Date(next).getTime();
    const expMs = new Date(`${expiry}T23:59:59Z`).getTime();
    if (!Number.isFinite(nextMs) || !Number.isFinite(expMs)) return { status: 'unknown', detail: 'Could not compare earnings and expiry dates.' };
    return nextMs <= expMs ? { status: 'fail', detail: `Earnings on ${next} is before the ${expiry} expiry.` } : { status: 'pass', detail: `Next earnings ${next} is after the ${expiry} expiry.` };
  }),

  item('C15', 'C', 'Ex-dividend dates noted', 'For a short put this is informational; it matters more for covered calls.', (c) => {
    const d = c.dividends?.next;
    if (!d) return { status: 'unknown', detail: 'No upcoming ex-dividend date found — verify manually.' };
    return { status: 'pass', detail: `Next ex-dividend ${d.exDate}${d.amount ? ` (${money(d.amount)}/share)` : ''}.` };
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

export const CRITICAL_ITEMS = new Set(['A1', 'A7', 'C14', 'D16']);

export const STATUS_META = {
  pass: { icon: '✅', label: 'Pass', className: 'pass' },
  warn: { icon: '⚠️', label: 'Borderline', className: 'warn' },
  fail: { icon: '❌', label: 'Fail', className: 'fail' },
  unknown: { icon: '❔', label: 'Not verified', className: 'unknown' },
};

export function evaluateChecklist(context) {
  const results = CHECKLIST.map((entry) => {
    let out;
    try {
      out = entry.evaluate(context) || { status: 'unknown', detail: '' };
    } catch (err) {
      out = { status: 'unknown', detail: 'Could not evaluate with the available data.' };
    }
    return { ...entry, ...out, meta: STATUS_META[out.status] || STATUS_META.unknown };
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
export function buildChecklistContext({ state, data, option, manual, settings }) {
  const s = mergeSettings(settings || state?.settings);
  const budget = toNum(state?.account?.budget, s.budget);
  const cash = toNum(state?.account?.cash, budget);
  const metrics = putMetrics({
    strike: option?.strike,
    mid: option?.mid,
    bid: option?.bid,
    ask: option?.ask,
    contracts: 1,
    commission: s.commission,
    stockPrice: data?.quote?.price,
    daysToExpiry: option?.dte,
    delta: option?.delta,
  });
  const profile = data?.profile || {};
  const openWheels = (state?.wheels || []).filter((w) => w.state !== 'complete');
  const sameSectorWheels = profile.industry ? openWheels.filter((w) => (w.sector || '') === profile.industry).length : 0;
  return {
    symbol: data?.symbol,
    price: data?.quote?.price,
    profile,
    metrics: data?.metrics || {},
    dividends: data?.dividends || {},
    earnings: data?.earnings || {},
    priceVsMa200: data?.priceVsMa200 ?? null,
    option: option || null,
    putMetrics: metrics,
    manual: manual || {},
    settings: s,
    budget,
    portfolio: {
      availableCash: cash,
      openWheels: openWheels.length,
      sameSectorWheels,
    },
  };
}
