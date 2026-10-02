// ---------------------------------------------------------------------------
// wheelEngine.js — PURE functions for the Wheel (no DOM, no network).
// The adjusted cost basis is always DERIVED from an append-only event ledger.
// Full precision is kept internally; callers round only for display.
// ---------------------------------------------------------------------------

export const DEFAULT_WHEEL_RULES = {
  pathA_maxGapPct: 5,
  pathB_maxGapPct: 15,
  callDeltaMin: 0.15,
  callDeltaMax: 0.3,
  callDeltaHighWarn: 0.35,
  callDteNormalMin: 30,
  callDteNormalMax: 45,
  recoveryB1DteMin: 45,
  recoveryB1DteMax: 75,
  recoveryB1MinNet: 0.15,
  recoveryB2DteMin: 75,
  recoveryB2DteMax: 120,
  recoveryB2MinNet: 0.25,
  callMinAnnualizedPct: 6,
  spreadMaxAbs: 0.1,
  spreadMaxPctOfMid: 10,
  minOpenInterest: 500,
  minVolume: 50,
  commissionPerContract: 0.65,
  stockCommissionEstimate: 1.0,
  takeProfitPctOfFill: 50,
  reviewAtDte: 21,
  reviewCloseIfBelowPctOfFill: 70,
  includeDividendsInBasis: false,
};

export function mergeWheelRules(rules) {
  return { ...DEFAULT_WHEEL_RULES, ...(rules || {}) };
}

export const OPTION_PREMIUM_TYPES = ['PUT_SOLD', 'PUT_BOUGHT_TO_CLOSE', 'CALL_SOLD', 'CALL_BOUGHT_TO_CLOSE'];

const TRADE_TO_EVENT = {
  SELL_PUT_OPEN: 'PUT_SOLD',
  BUY_PUT_CLOSE: 'PUT_BOUGHT_TO_CLOSE',
  PUT_EXPIRE: 'PUT_EXPIRED',
  PUT_ASSIGN: 'PUT_ASSIGNED',
  SELL_CALL_OPEN: 'CALL_SOLD',
  BUY_CALL_CLOSE: 'CALL_BOUGHT_TO_CLOSE',
  CALL_EXPIRE: 'CALL_EXPIRED',
  CALL_ASSIGN: 'CALL_ASSIGNED',
  SELL_SHARES: 'SHARES_SOLD',
  BUY_SHARES: 'SHARES_BOUGHT',
  DIVIDEND: 'DIVIDEND_RECEIVED',
};

// Adapt the app's trade log into normalized ledger events.
export function tradesToEvents(trades = []) {
  return trades.map((t) => ({
    id: t.id,
    type: TRADE_TO_EVENT[t.action] || t.action,
    eventTime: t.executedAt,
    contracts: Number(t.contracts) || 0,
    shares: (Number(t.contracts) || 0) * 100,
    strike: t.strike != null ? Number(t.strike) : null,
    expiry: t.expiry || null,
    optionPrice: Number(t.price) || 0,
    sharePrice: Number(t.price) || 0,
    commission: Number(t.fees) || 0,
    amount: Number(t.cashFlow) || 0,
    delta: t.delta != null ? Number(t.delta) : null,
    voided: Boolean(t.voided),
    mode: (t.mode || 'paper').toUpperCase(),
  }));
}

const round = (n, d = 2) => {
  const f = Math.pow(10, d);
  const v = Number(n) || 0;
  return Math.round((v + Number.EPSILON) * f) / f;
};
export { round };

// 1. netPremium of a single event (signed cash from the option leg).
export function netPremium(event) {
  const q = Number(event.contracts) || 0;
  const p = Number(event.optionPrice) || 0;
  const fee = Number(event.commission) || 0;
  switch (event.type) {
    case 'PUT_SOLD':
    case 'CALL_SOLD':
      return p * 100 * q - fee;
    case 'PUT_BOUGHT_TO_CLOSE':
    case 'CALL_BOUGHT_TO_CLOSE':
      return -(p * 100 * q) - fee;
    default:
      return 0;
  }
}

// 2. total premiums (puts + calls, including losing buy-to-closes).
export function totalPremiums(events = []) {
  return events
    .filter((e) => !e.voided && OPTION_PREMIUM_TYPES.includes(e.type))
    .reduce((a, e) => a + netPremium(e), 0);
}

// 3. adjusted cost basis per share, derived from the ledger.
export function adjustedBasisPerShare(events = [], settings = {}) {
  const rules = mergeWheelRules(settings);
  const live = events.filter((e) => !e.voided);
  const assigned = live.filter((e) => e.type === 'PUT_ASSIGNED');
  const assignedShares = assigned.reduce((a, e) => a + (Number(e.shares) || 0), 0);
  const removed = live
    .filter((e) => e.type === 'CALL_ASSIGNED' || e.type === 'SHARES_SOLD')
    .reduce((a, e) => a + (Number(e.shares) || 0), 0);
  const sharesHeld = Math.max(0, assignedShares - removed);
  const weightedStrike = assignedShares > 0
    ? assigned.reduce((a, e) => a + (Number(e.strike) || 0) * (Number(e.shares) || 0), 0) / assignedShares
    : null;
  const assignmentFees = assigned.reduce((a, e) => a + (Number(e.commission) || 0), 0);
  const premiums = totalPremiums(live);
  const dividendsReceived = live
    .filter((e) => e.type === 'DIVIDEND_RECEIVED')
    .reduce((a, e) => a + (Number(e.amount) || 0), 0);

  if (!(sharesHeld > 0) || weightedStrike === null) {
    return { basisPerShare: null, sharesHeld: 0, assignmentStrike: weightedStrike, assignmentFees, totalPremiums: premiums, dividendsReceived, brokerCost: weightedStrike };
  }
  const dividendCredit = rules.includeDividendsInBasis ? dividendsReceived : 0;
  const basis = (weightedStrike * sharesHeld + assignmentFees - premiums - dividendCredit) / sharesHeld;
  return {
    basisPerShare: basis,
    sharesHeld,
    assignmentStrike: weightedStrike,
    brokerCost: weightedStrike,
    assignmentFees,
    totalPremiums: premiums,
    dividendsReceived,
  };
}

// 4. unrealized P&L in dollars.
export function unrealizedPnL(currentPrice, basisPerShare, sharesHeld) {
  if (currentPrice == null || basisPerShare == null) return null;
  return (Number(currentPrice) - Number(basisPerShare)) * Number(sharesHeld);
}

// 5. gap % — negative means the stock is ABOVE basis (Path A).
export function gapPct(basisPerShare, currentPrice) {
  if (basisPerShare == null || currentPrice == null || !(basisPerShare > 0)) return null;
  return ((Number(basisPerShare) - Number(currentPrice)) / Number(basisPerShare)) * 100;
}

export function maxCallContracts(sharesHeld) {
  return Math.floor((Number(sharesHeld) || 0) / 100);
}

// 6. grade a candidate covered call.
export function gradeCall(candidate, ctx) {
  const rules = mergeWheelRules(ctx.rules);
  const basis = ctx.basisPerShare;
  const shares = Number(ctx.sharesHeld) || 0;
  const q = Number(candidate.contracts) || 1;
  const strike = Number(candidate.strike);
  const bid = candidate.bid != null ? Number(candidate.bid) : null;
  const ask = candidate.ask != null ? Number(candidate.ask) : null;
  const dte = Number(candidate.dte);
  const delta = candidate.delta != null ? Number(candidate.delta) : null;
  const mid = bid != null && ask != null ? (bid + ask) / 2 : (bid ?? ask);
  const spread = bid != null && ask != null ? ask - bid : null;
  const spreadPct = spread != null && mid > 0 ? (spread / mid) * 100 : null;
  const commission = rules.commissionPerContract * q;
  const estNetPremium = mid != null ? mid * 100 * q - commission : null;
  const capital = basis != null ? basis * shares : null;
  const returnPct = estNetPremium != null && capital ? (estNetPremium / capital) * 100 : null;
  const annualizedPct = returnPct != null && dte > 0 ? (returnPct * 365) / dte : null;
  const newBasis = estNetPremium != null && shares ? basis - estNetPremium / shares : null;
  const wheelProfitIfCalledAway = estNetPremium != null
    ? Number(ctx.totalPremiumsTotal || 0) + estNetPremium + (strike - Number(ctx.assignmentStrike || strike)) * shares - Number(ctx.assignmentFees || 0)
    : null;

  const belowBasis = basis != null && Number.isFinite(strike) ? strike < basis - 1e-9 : false;

  let spreadGrade = { key: 'unknown', label: '—' };
  if (spread != null && spreadPct != null) {
    if (spread <= 0.05 && spreadPct <= 5) spreadGrade = { key: 'great', label: 'Great' };
    else if (spread <= rules.spreadMaxAbs && spreadPct <= rules.spreadMaxPctOfMid) spreadGrade = { key: 'ok', label: 'OK' };
    else if (spreadPct <= 15) spreadGrade = { key: 'borderline', label: 'Borderline' };
    else spreadGrade = { key: 'fail', label: 'Fail' };
  }
  let deltaGrade = { key: 'unknown', label: '—' };
  if (delta != null) {
    const a = Math.abs(delta);
    if (a < rules.callDeltaMin) deltaGrade = { key: 'warn', label: 'Low premium' };
    else if (a <= rules.callDeltaMax) deltaGrade = { key: 'pass', label: 'Target' };
    else if (a <= rules.callDeltaHighWarn) deltaGrade = { key: 'warn', label: 'High' };
    else deltaGrade = { key: 'warn', label: 'Shares likely called away' };
  }
  let oiGrade = { key: 'unknown', label: '—' };
  if (candidate.openInterest != null) {
    const oi = Number(candidate.openInterest);
    oiGrade = oi >= rules.minOpenInterest ? { key: 'pass', label: 'Good' } : oi >= 100 ? { key: 'warn', label: 'Borderline' } : { key: 'fail', label: 'Too low' };
  }
  const earningsOk = ctx.earningsDate && candidate.expiry ? String(ctx.earningsDate) > String(candidate.expiry) : null;
  const exDivBeforeExpiry = Boolean(ctx.exDivDate && candidate.expiry && String(ctx.exDivDate) < String(candidate.expiry));

  const hardRejects = [];
  if (belowBasis) hardRejects.push('Strike is below your basis — would lock in a loss');
  if (spreadGrade.key === 'fail') hardRejects.push('Spread is too wide');
  if (oiGrade.key === 'fail') hardRejects.push('Open interest too low');
  if (annualizedPct != null && annualizedPct < rules.callMinAnnualizedPct) hardRejects.push(`Annualized below ${rules.callMinAnnualizedPct}%`);
  if (earningsOk === false) hardRejects.push('Earnings fall before expiry');

  const warnings = [];
  if (delta != null && Math.abs(delta) > rules.callDeltaMax) warnings.push('Delta above the beginner band — allowed because strike ≥ basis');
  if (exDivBeforeExpiry) warnings.push('Ex-dividend before expiry — early assignment is possible (fine because strike ≥ basis)');

  return {
    strike, expiry: candidate.expiry || null, dte, delta, bid, ask, mid,
    spread, spreadPct, estNetPremium, returnPct, annualizedPct, newBasis,
    wheelProfitIfCalledAway, belowBasis, spreadGrade, deltaGrade, oiGrade,
    earningsOk, exDivBeforeExpiry, hardRejects, warnings,
    passes: hardRejects.length === 0,
  };
}

// 7. take-profit buy-to-close limit: floor(fill × pct/100) to $0.01.
export function takeProfitLimit(fillPrice, pctOfFill = DEFAULT_WHEEL_RULES.takeProfitPctOfFill) {
  const f = Number(fillPrice) || 0;
  return Math.floor((f * pctOfFill) / 100 * 100) / 100;
}

// 8. Path C exit simulator.
export function exitSimulator({ salePrice, basisPerShare, sharesHeld, stockCommission = 0, openCallBuyBack = 0 } = {}) {
  const shares = Number(sharesHeld) || 0;
  const gross = (Number(salePrice) - Number(basisPerShare)) * shares;
  const realized = gross - Number(stockCommission || 0) - Number(openCallBuyBack || 0);
  return { gross, realized };
}

// Open positions derived from the ledger (used to block naked calls etc.).
export function openPositions(events = []) {
  let shortPuts = 0;
  let shortCalls = 0;
  let sharesHeld = 0;
  const live = [...events].filter((e) => !e.voided).sort((a, b) => String(a.eventTime).localeCompare(String(b.eventTime)));
  for (const e of live) {
    const c = Number(e.contracts) || 0;
    const sh = Number(e.shares) || c * 100;
    if (e.type === 'PUT_SOLD') shortPuts += c;
    else if (e.type === 'PUT_BOUGHT_TO_CLOSE' || e.type === 'PUT_EXPIRED') shortPuts -= c;
    else if (e.type === 'PUT_ASSIGNED') { shortPuts -= c; sharesHeld += sh; }
    else if (e.type === 'CALL_SOLD') shortCalls += c;
    else if (e.type === 'CALL_BOUGHT_TO_CLOSE' || e.type === 'CALL_EXPIRED') shortCalls -= c;
    else if (e.type === 'CALL_ASSIGNED') { shortCalls -= c; sharesHeld -= sh; }
    else if (e.type === 'SHARES_SOLD') sharesHeld -= sh;
    else if (e.type === 'SHARES_BOUGHT') sharesHeld += sh;
  }
  return { shortPuts: Math.max(0, shortPuts), shortCalls: Math.max(0, shortCalls), sharesHeld: Math.max(0, sharesHeld) };
}

// 9. Full wheel closed summary.
export function wheelClosedSummary({ events = [], finalSalePrice = null, closeDate = null, putContracts = 1, settings = {} } = {}) {
  const rules = mergeWheelRules(settings);
  const live = events.filter((e) => !e.voided);
  const premiums = totalPremiums(live);
  const assigned = live.filter((e) => e.type === 'PUT_ASSIGNED');
  const shares = assigned.reduce((a, e) => a + (Number(e.shares) || 0), 0);
  const assignmentStrike = assigned.length ? Number(assigned[0].strike) : null;
  const allFees = live.reduce((a, e) => a + (Number(e.commission) || 0), 0);
  const dividends = live.filter((e) => e.type === 'DIVIDEND_RECEIVED').reduce((a, e) => a + (Number(e.amount) || 0), 0);
  const sharePnl = shares && finalSalePrice != null && assignmentStrike != null ? (Number(finalSalePrice) - assignmentStrike) * shares : 0;
  const net = premiums + sharePnl - (shares ? allFees : allFees) + dividends;
  const first = [...live].sort((a, b) => String(a.eventTime).localeCompare(String(b.eventTime)))[0];
  const days = closeDate && first ? Math.max(1, Math.round((new Date(closeDate) - new Date(first.eventTime)) / 86400000)) : null;
  const capital = assignmentStrike != null ? assignmentStrike * 100 * putContracts : null;
  const returnOnCapital = capital ? (net / capital) * 100 : null;
  const annualized = returnOnCapital != null && days ? (returnOnCapital * 365) / days : null;
  return { premiums, sharePnl, fees: allFees, dividends, net, daysInWheel: days, returnOnCapital, annualized };
}

// E. Decision engine — first match wins.
export function decidePath(state = {}, settings = {}) {
  const rules = mergeWheelRules(settings);
  const reasons = [];
  if (state.thesisOk === false) {
    reasons.push('Your reason to own this stock is gone (thesis broken).');
    return { path: 'C', reasons, actions: ['Close any open call first', 'Sell the shares', 'Log the exit'] };
  }
  const gap = state.gapPct;
  if (gap == null) {
    reasons.push('Not enough data to compute your gap — enter the current price.');
    return { path: 'B', reasons, actions: [] };
  }
  if (gap <= rules.pathA_maxGapPct) {
    reasons.push(`Stock is within ${rules.pathA_maxGapPct}% of your basis (gap ${gap.toFixed(2)}%).`);
    return { path: 'A', reasons, actions: ['Sell a covered call at or above your basis'] };
  }
  if (gap <= rules.pathB_maxGapPct) {
    reasons.push(`Stock is ${gap.toFixed(2)}% below your basis (between ${rules.pathA_maxGapPct}% and ${rules.pathB_maxGapPct}%).`);
    return { path: 'B', reasons, actions: ['Try a longer-dated call at/above basis', 'Otherwise hold and wait'] };
  }
  reasons.push(`Stock is ${gap.toFixed(2)}% below your basis (over ${rules.pathB_maxGapPct}%).`);
  return { path: 'B_MONTHLY_REVIEW', reasons, actions: ['Hold and wait, re-check monthly', 'Ask: would you buy this stock today with fresh money?'] };
}
