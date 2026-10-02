// ---------------------------------------------------------------------------
// Wheel Desk calculation engine
// All financial formulas live here as pure, testable functions.
// Money is computed at full precision and only rounded for display.
// ---------------------------------------------------------------------------

import { toNum, round, clamp, money, dte as dteFn } from './format.js';

export const CONTRACT_MULTIPLIER = 100;

export const DEFAULT_SETTINGS = {
  budget: 10000,
  reservePct: 0.1,
  maxPerWheelPct: 0.5,
  maxWheels: 3,
  commission: 0.65,
  assignmentFee: 0,
  dteMin: 30,
  dteMax: 45,
  deltaMin: 0.15,
  deltaMax: 0.3,
  takeProfitPct: 0.5,
  timeRuleDte: 21,
  timeRuleOn: true,
  returnMin: 10,
  returnMax: 30,
  returnHigh: 50,
  currency: 'USD',
  fxRate: 1,
  timezone: '',
  theme: 'light',
  provider: 'finnhub',
  exportReminderDays: 30,
  thresholds: {
    marketCap: 10_000_000_000,
    marketCapWarn: 2_000_000_000,
    volume: 1_000_000,
    openInterest: 500,
    openInterestWarn: 100,
    spread: 0.1,
    spreadPct: 0.1,
    ivMin: 30,
    ivMax: 60,
    ivLow: 20,
    ivHigh: 70,
  },
  recovery: {
    scenarioB: 10,
    scenarioC: 25,
    cutLoss: 25,
  },
};

export function mergeSettings(settings) {
  const s = settings || {};
  return {
    ...DEFAULT_SETTINGS,
    ...s,
    thresholds: { ...DEFAULT_SETTINGS.thresholds, ...(s.thresholds || {}) },
    recovery: { ...DEFAULT_SETTINGS.recovery, ...(s.recovery || {}) },
  };
}

function midPrice({ mid, bid, ask }) {
  const m = toNum(mid, null);
  if (m !== null && m > 0) return m;
  const b = toNum(bid, null);
  const a = toNum(ask, null);
  if (b !== null && a !== null && (b > 0 || a > 0)) return round((b + a) / 2, 4);
  if (b !== null && b > 0) return b;
  if (a !== null && a > 0) return a;
  return null;
}

export function contractFees(contracts, commission = DEFAULT_SETTINGS.commission, extra = 0) {
  const q = Math.max(0, Math.floor(toNum(contracts, 0)));
  return round(q * toNum(commission, 0) + toNum(extra, 0), 2);
}

export function annualizedReturn(returnPct, daysToExpiry) {
  const r = toNum(returnPct, null);
  const d = toNum(daysToExpiry, null);
  if (r === null || !d || d <= 0) return null;
  return (r * 365) / d;
}

export function probabilityOtm(delta) {
  const d = toNum(delta, null);
  if (d === null) return null;
  // Rough textbook estimate: probability of expiring OTM ~ 1 - |delta|.
  return clamp(1 - Math.abs(d), 0, 1) * 100;
}

// ---------------------------------------------------------------------------
// Cash-secured put
// ---------------------------------------------------------------------------
export function putMetrics({
  strike,
  mid,
  bid = null,
  ask = null,
  contracts = 1,
  commission = DEFAULT_SETTINGS.commission,
  assignmentFee = 0,
  stockPrice = null,
  daysToExpiry = null,
  delta = null,
} = {}) {
  const q = Math.max(1, Math.floor(toNum(contracts, 1)));
  const k = toNum(strike, null);
  const price = midPrice({ mid, bid, ask });
  if (k === null || k <= 0 || price === null || price <= 0) return null;

  const grossPremium = price * CONTRACT_MULTIPLIER * q;
  const fees = contractFees(q, commission);
  const netPremium = round(grossPremium - fees, 2);
  const collateral = round(k * CONTRACT_MULTIPLIER * q, 2);
  const returnOnCollateral = (netPremium / collateral) * 100;
  const d = toNum(daysToExpiry, null);
  const annualized = annualizedReturn(returnOnCollateral, d);
  const netPremiumPerShare = netPremium / (CONTRACT_MULTIPLIER * q);
  const breakeven = k - netPremiumPerShare;
  const distanceToStrikePct = toNum(stockPrice, null) ? ((toNum(stockPrice) - k) / toNum(stockPrice)) * 100 : null;
  const maxLoss = round(breakeven * CONTRACT_MULTIPLIER * q + toNum(assignmentFee, 0), 2);

  return {
    contracts: q,
    strike: k,
    price,
    grossPremium: round(grossPremium, 2),
    fees,
    netPremium,
    collateral,
    returnOnCollateral,
    annualized,
    netPremiumPerShare,
    breakeven,
    distanceToStrikePct,
    probabilityOtm: probabilityOtm(delta),
    maxLoss,
    cashRequired: collateral + toNum(assignmentFee, 0),
  };
}

// ---------------------------------------------------------------------------
// Covered call
// ---------------------------------------------------------------------------
export function callMetrics({
  strike,
  mid,
  bid = null,
  ask = null,
  contracts = 1,
  commission = DEFAULT_SETTINGS.commission,
  costBasis = null,
  stockPrice = null,
  daysToExpiry = null,
  delta = null,
} = {}) {
  const q = Math.max(1, Math.floor(toNum(contracts, 1)));
  const k = toNum(strike, null);
  const price = midPrice({ mid, bid, ask });
  if (k === null || k <= 0 || price === null || price <= 0) return null;

  const grossPremium = price * CONTRACT_MULTIPLIER * q;
  const fees = contractFees(q, commission);
  const netPremium = round(grossPremium - fees, 2);
  const collateral = round(k * CONTRACT_MULTIPLIER * q, 2);
  const returnOnCollateral = (netPremium / collateral) * 100;
  const annualized = annualizedReturn(returnOnCollateral, toNum(daysToExpiry, null));
  const basis = toNum(costBasis, null);
  const calledAwayPnl = basis === null ? null : round((k - basis) * CONTRACT_MULTIPLIER * q + netPremium, 2);
  const belowBasis = basis !== null && k < basis;

  return {
    contracts: q,
    strike: k,
    price,
    grossPremium: round(grossPremium, 2),
    fees,
    netPremium,
    collateral,
    returnOnCollateral,
    annualized,
    calledAwayPnl,
    belowBasis,
    probabilityOtm: probabilityOtm(delta),
    distanceToStrikePct: toNum(stockPrice, null) ? ((toNum(stockPrice) - k) / toNum(stockPrice)) * 100 : null,
  };
}

// ---------------------------------------------------------------------------
// Cost basis, rolls, partial closes
// ---------------------------------------------------------------------------
export function adjustedCostBasis({ assignmentPrice, premiums = 0, fees = 0, dividends = 0, shares = CONTRACT_MULTIPLIER } = {}) {
  const price = toNum(assignmentPrice, null);
  const s = Math.max(1, toNum(shares, CONTRACT_MULTIPLIER));
  if (price === null) return null;
  const perShare = (toNum(premiums, 0) - toNum(dividends, 0) - toNum(fees, 0)) / s;
  return price - perShare;
}

export function rollMetrics({ contracts = 1, buyBackPrice = 0, sellPrice = 0, commission = DEFAULT_SETTINGS.commission } = {}) {
  const q = Math.max(1, Math.floor(toNum(contracts, 1)));
  const buy = toNum(buyBackPrice, 0);
  const sell = toNum(sellPrice, 0);
  const buyCost = buy * CONTRACT_MULTIPLIER * q + contractFees(q, commission);
  const sellCredit = sell * CONTRACT_MULTIPLIER * q - contractFees(q, commission);
  const netCredit = round(sellCredit - buyCost, 2);
  const notional = Math.max(1, sell * CONTRACT_MULTIPLIER * q);
  let verdict = 'debit';
  if (netCredit > 0 && netCredit / notional >= 0.0005) verdict = 'good';
  else if (netCredit > 0) verdict = 'small';
  return { contracts: q, buyCost: round(buyCost, 2), sellCredit: round(sellCredit, 2), netCredit, verdict };
}

export function partialClose(position, contracts, closePrice) {
  const q = Math.floor(toNum(contracts, 0));
  const open = toNum(position?.openContracts, 0);
  if (q <= 0 || q > open) throw new Error('Close quantity must be positive and no greater than open contracts.');
  const realized = (toNum(position.entryPrice, 0) - toNum(closePrice, 0)) * q * CONTRACT_MULTIPLIER;
  return { ...position, openContracts: open - q, realizedPnl: toNum(position.realizedPnl, 0) + realized, status: open - q === 0 ? 'closed' : 'partial' };
}

// ---------------------------------------------------------------------------
// Recovery assistant
// ---------------------------------------------------------------------------
export function recoveryScenario({ costBasis, currentPrice, thesisBroken = false, settings = DEFAULT_SETTINGS } = {}) {
  const s = mergeSettings(settings);
  const basis = toNum(costBasis, null);
  const price = toNum(currentPrice, null);
  if (basis === null || price === null) return { key: 'UNKNOWN', label: 'Not enough data', explanation: 'Enter the cost basis and current price to classify the situation.' };
  if (thesisBroken) return { key: 'D', label: 'Scenario D — thesis broken', explanation: 'You no longer believe in the company. Compare cutting the loss with a patient repair.' };
  if (price >= basis) return { key: 'A', label: 'Scenario A — at or above cost basis', explanation: 'Sell a covered call at or above your cost basis (30–45 DTE, delta ~0.20–0.35) and let it get called away for a profit.' };
  const dropPct = ((basis - price) / basis) * 100;
  if (dropPct <= s.recovery.scenarioB) return { key: 'B', label: 'Scenario B — slightly below cost basis', explanation: `Only ${dropPct.toFixed(1)}% below basis. Sell calls at your cost basis, or use a longer 45–60 DTE expiry for more premium.` };
  if (dropPct <= s.recovery.scenarioC) return { key: 'C', label: 'Scenario C — well below cost basis', explanation: `${dropPct.toFixed(1)}% below basis. Compare patient repair, a small controlled loss, or holding without calls.` };
  return { key: 'D', label: 'Scenario D — deep loss', explanation: `${dropPct.toFixed(1)}% below basis. Honestly compare cutting the loss with a patient repair. Never feel pressured to keep a losing position.` };
}

export function callCandidateAnalysis({ strike, bid, daysToExpiry, costBasis, currentPrice, commission = DEFAULT_SETTINGS.commission, shares = CONTRACT_MULTIPLIER } = {}) {
  const k = toNum(strike, null);
  const b = toNum(bid, null);
  const d = toNum(daysToExpiry, null);
  const basis = toNum(costBasis, null);
  const price = toNum(currentPrice, null);
  if (k === null || b === null || !d || d <= 0) return null;
  const netPremium = round(b * CONTRACT_MULTIPLIER - contractFees(1, commission), 2);
  const collateral = k * CONTRACT_MULTIPLIER;
  const annualized = (netPremium / collateral) * 100 * (365 / d);
  const calledAwayPnl = basis === null ? null : round((k - basis) * shares + netPremium, 2);
  const lossPerShare = price !== null ? Math.max(0, basis - price) : null;
  const perSharePremium = netPremium / shares;
  const monthlyPremiumPerShare = perSharePremium * (30 / d);
  const recoveryMonths = lossPerShare !== null && monthlyPremiumPerShare > 0 ? lossPerShare / monthlyPremiumPerShare : null;
  return { strike: k, bid: b, daysToExpiry: d, netPremium, annualized, calledAwayPnl, recoveryMonths, atOrAboveBasis: basis !== null && k >= basis };
}

// ---------------------------------------------------------------------------
// Portfolio summary
// ---------------------------------------------------------------------------
export function portfolioSummary({ budget = 10000, wheels = [], trades = [], dividends = [], marks = {}, settings = DEFAULT_SETTINGS } = {}) {
  const s = mergeSettings(settings);
  const reserve = budget * s.reservePct;
  let collateral = 0;
  let sharesValue = 0;
  let premiums = 0;
  let fees = 0;
  let divided = 0;
  let realized = 0;
  let unrealized = 0;
  let openWheels = 0;

  for (const w of wheels) {
    const wTrades = trades.filter((t) => t.wheelId === w.id);
    const wDiv = dividends.filter((x) => x.wheelId === w.id);
    const st = wheelState(w, wTrades, wDiv);
    premiums += st.premiums;
    fees += st.fees;
    divided += st.dividends;
    realized += st.realized;
    collateral += st.collateral;
    const mark = toNum(marks[w.ticker] ?? w.mark, null);
    const holdings = st.shares * (mark ?? toNum(w.assignedPrice, st.assignmentPrice) ?? 0);
    sharesValue += holdings;
    if (mark !== null) unrealized += (mark - (st.costBasis ?? mark)) * st.shares;
    if (w.state !== 'complete') openWheels += 1;
  }

  const cash =
    toNum(budget, 0) +
    premiums -
    fees +
    divided +
    realized -
    collateral -
    (sharesValue > 0 ? 0 : 0);
  const used = collateral + sharesValue + reserve;
  return {
    budget,
    reserve,
    collateral,
    sharesValue,
    premiums,
    fees,
    dividends: divided,
    realized,
    unrealized,
    cash,
    freeCash: Math.max(0, budget - collateral - sharesValue),
    openWheels,
    returnPct: budget > 0 ? (premiums + realized) / budget * 100 : 0,
    allocation: { free: Math.max(0, budget - collateral - sharesValue - reserve), reserve, collateral, shares: sharesValue },
    used,
  };
}

// ---------------------------------------------------------------------------
// Wheel state machine
// ---------------------------------------------------------------------------
export function wheelState(wheel, trades = [], dividends = []) {
  const sorted = [...trades].sort((a, b) => String(a.executedAt).localeCompare(String(b.executedAt)));
  let openPut = 0;
  let openCall = 0;
  let shares = 0;
  let premiums = 0;
  let fees = 0;
  let realized = 0;
  let assignmentPrice = toNum(wheel.assignedPrice, null);
  let putStrike = null;
  let putExpiry = null;
  let callStrike = null;
  let callExpiry = null;

  for (const t of sorted) {
    const q = toNum(t.contracts, 0);
    const px = toNum(t.price, 0);
    const fee = toNum(t.fees, 0);
    fees += fee;
    const action = t.action;
    if (action === 'SELL_PUT_OPEN') {
      openPut += q;
      premiums += px * CONTRACT_MULTIPLIER * q - fee;
      putStrike = toNum(t.strike, putStrike);
      putExpiry = t.expiry || putExpiry;
    } else if (action === 'BUY_PUT_CLOSE') {
      openPut = Math.max(0, openPut - q);
      realized += (putStrike !== null ? 0 : 0);
      premiums -= px * CONTRACT_MULTIPLIER * q + fee;
    } else if (action === 'PUT_EXPIRE') {
      openPut = Math.max(0, openPut - q);
      premiums += -0;
    } else if (action === 'PUT_ASSIGN') {
      openPut = Math.max(0, openPut - q);
      shares += CONTRACT_MULTIPLIER * q;
      assignmentPrice = toNum(t.strike, putStrike) ?? assignmentPrice;
    } else if (action === 'SELL_CALL_OPEN') {
      openCall += q;
      premiums += px * CONTRACT_MULTIPLIER * q - fee;
      callStrike = toNum(t.strike, callStrike);
      callExpiry = t.expiry || callExpiry;
    } else if (action === 'BUY_CALL_CLOSE') {
      openCall = Math.max(0, openCall - q);
      premiums -= px * CONTRACT_MULTIPLIER * q + fee;
    } else if (action === 'CALL_EXPIRE') {
      openCall = Math.max(0, openCall - q);
      callExpiry = null;
    } else if (action === 'CALL_ASSIGN') {
      openCall = Math.max(0, openCall - q);
      shares = Math.max(0, shares - CONTRACT_MULTIPLIER * q);
      realized += (toNum(t.strike, callStrike) - (assignmentPrice ?? 0)) * CONTRACT_MULTIPLIER * q;
    } else if (action === 'SELL_SHARES') {
      shares = Math.max(0, shares - CONTRACT_MULTIPLIER * q);
    } else if (action === 'BUY_SHARES') {
      shares += CONTRACT_MULTIPLIER * q;
    }
  }

  const dividendTotal = dividends.reduce((acc, d) => acc + toNum(d.amountPerShare, 0) * toNum(d.shares, 0), 0);
  const costBasis = assignmentPrice !== null ? adjustedCostBasis({ assignmentPrice, premiums, fees, dividends: dividendTotal, shares: Math.max(shares, CONTRACT_MULTIPLIER) }) : null;

  let state = 'idle';
  if (openPut > 0) state = 'short_put';
  else if (shares > 0 && openCall > 0) state = 'short_call';
  else if (shares > 0) state = 'holding';
  if (wheel.state === 'complete') state = 'complete';

  const currentExpiry = openPut > 0 ? putExpiry : openCall > 0 ? callExpiry : null;
  const daysToExpiry = currentExpiry ? dteFn(currentExpiry) : null;

  return {
    state,
    shares,
    openPut,
    openCall,
    premiums: round(premiums, 2),
    fees: round(fees, 2),
    dividends: round(dividendTotal, 2),
    realized: round(realized, 2),
    costBasis: costBasis === null ? null : round(costBasis, 4),
    assignmentPrice: assignmentPrice === null ? null : round(assignmentPrice, 4),
    putStrike,
    putExpiry,
    callStrike,
    callExpiry,
    currentExpiry,
    daysToExpiry,
    collateral: openPut > 0 ? round((putStrike || 0) * CONTRACT_MULTIPLIER * openPut, 2) : 0,
  };
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------
export function validatePutTrade({ contracts, strike, price, daysToExpiry, availableCash, maxPerWheel, assignmentFee = 0 } = {}) {
  const errors = [];
  const q = toNum(contracts, 0);
  const k = toNum(strike, 0);
  const p = toNum(price, 0);
  if (!Number.isFinite(q) || q < 1 || !Number.isInteger(q)) errors.push('Contracts must be a whole number of at least 1.');
  if (!(k > 0)) errors.push('Strike must be greater than 0.');
  if (!(p > 0)) errors.push('Premium must be greater than 0.');
  if (daysToExpiry !== null && daysToExpiry !== undefined && !(toNum(daysToExpiry, 0) > 0)) errors.push('Expiry must be after the open date.');
  const collateral = k * CONTRACT_MULTIPLIER * q;
  if (availableCash !== null && availableCash !== undefined && collateral + toNum(assignmentFee, 0) > availableCash + 1e-9) {
    errors.push(`Collateral ${money(collateral)} exceeds available cash ${money(availableCash)}.`);
  }
  if (maxPerWheel !== null && maxPerWheel !== undefined && collateral > maxPerWheel + 1e-9) {
    errors.push(`Collateral ${money(collateral)} exceeds the max per wheel (${money(maxPerWheel)}).`);
  }
  return { ok: errors.length === 0, errors, collateral };
}

export function validateSize({ accountValue = 0, shares = 0, strike = 0, settings = DEFAULT_SETTINGS } = {}) {
  const s = mergeSettings(settings);
  const max = accountValue * s.maxPerWheelPct;
  const reserve = accountValue * s.reservePct;
  const collateral = Math.max(0, toNum(shares, 0)) * Math.max(0, toNum(strike, 0));
  return {
    ok: collateral <= max,
    collateral,
    max,
    reserve,
    remaining: accountValue - collateral - reserve,
    reason: collateral > max ? `Collateral ${money(collateral)} exceeds the per-wheel limit (${money(max)}).` : '',
  };
}

// ---------------------------------------------------------------------------
// Self-test (shown in Settings, and asserted by the Node test suite)
// ---------------------------------------------------------------------------
export function selfTest() {
  const results = [];
  const add = (name, actual, expected) => {
    const pass = JSON.stringify(actual) === JSON.stringify(expected);
    results.push({ name, actual, expected, pass });
  };

  const m = putMetrics({ strike: 50, mid: 1.2, contracts: 1, commission: 0.65, daysToExpiry: 30, stockPrice: 52, delta: -0.22 });
  add('net premium (sell $50 put @ $1.20, $0.65 fee)', m.netPremium, 119.35);
  add('collateral ($50 x 100)', m.collateral, 5000);
  add('return on collateral', round(m.returnOnCollateral, 4), 2.387);
  add('annualized return (30 DTE)', round(m.annualized, 1), 29);
  add('breakeven', round(m.breakeven, 2), 48.81);
  add('probability OTM from delta -0.22', round(m.probabilityOtm, 0), 78);

  const roll = rollMetrics({ contracts: 1, buyBackPrice: 1, sellPrice: 1.5, commission: 0.65 });
  add('roll net credit', roll.netCredit, 48.7);
  add('roll verdict', roll.verdict, 'good');

  add('adjusted cost basis', round(adjustedCostBasis({ assignmentPrice: 25, premiums: 178, fees: 2, dividends: 20, shares: 100 }), 3), 23.44);

  const r = recoveryScenario({ costBasis: 50, currentPrice: 46, settings: DEFAULT_SETTINGS });
  add('recovery scenario B for 8% below basis', r.key, 'B');

  return { results, passed: results.filter((x) => x.pass).length, total: results.length };
}
