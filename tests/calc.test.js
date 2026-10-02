import test from 'node:test';
import assert from 'node:assert/strict';
import {
  putMetrics,
  callMetrics,
  rollMetrics,
  adjustedCostBasis,
  recoveryScenario,
  callCandidateAnalysis,
  validatePutTrade,
  validateSize,
  annualizedReturn,
  probabilityOtm,
  wheelState,
  selfTest,
  presetSettings,
  RISK_PRESETS,
  DEFAULT_SETTINGS,
  capturedPct,
  findContract,
} from '../src/calc.js';
import { blackScholes } from '../src/greeks.js';
import { evaluateChecklist, buildChecklistContext, CHECKLIST, itemLink, manualFieldFor } from '../src/checklist.js';
import { toCsv } from '../src/export.js';
import { money, dte, marketStatus, toDMY, parseDMY } from '../src/format.js';

test('put metrics match the documented example', () => {
  const m = putMetrics({ strike: 50, mid: 1.2, contracts: 1, commission: 0.65, daysToExpiry: 30, stockPrice: 52, delta: -0.22 });
  assert.equal(m.netPremium, 119.35);
  assert.equal(m.collateral, 5000);
  assert.equal(Math.round(m.returnOnCollateral * 1000) / 1000, 2.387);
  assert.equal(Math.round(m.annualized * 10) / 10, 29);
  assert.equal(Math.round(m.breakeven * 100) / 100, 48.81);
  assert.equal(Math.round(m.probabilityOtm), 78);
});

test('put metrics scale with multiple contracts', () => {
  const m = putMetrics({ strike: 45, mid: 0.9, contracts: 2, commission: 0.65, daysToExpiry: 35 });
  assert.equal(m.netPremium, 178.7);
  assert.equal(m.collateral, 9000);
});

test('put metrics prefer the mid price and fall back to bid/ask', () => {
  const m = putMetrics({ strike: 30, bid: 0.4, ask: 0.6, contracts: 1, commission: 0, daysToExpiry: 30 });
  assert.equal(m.price, 0.5);
  assert.equal(m.netPremium, 50);
});

test('invalid put inputs return null instead of a fake number', () => {
  assert.equal(putMetrics({ strike: 0, mid: 1, daysToExpiry: 30 }), null);
  assert.equal(putMetrics({ strike: 30, mid: null, daysToExpiry: 30 }), null);
});

test('covered call flags a strike below the cost basis', () => {
  const c = callMetrics({ strike: 20, mid: 0.5, contracts: 1, commission: 0.65, costBasis: 23.44, daysToExpiry: 30 });
  assert.equal(c.belowBasis, true);
  assert.ok(c.calledAwayPnl < 0);
});

test('roll calculator reports net credit and verdict', () => {
  const good = rollMetrics({ contracts: 1, buyBackPrice: 1, sellPrice: 1.5, commission: 0.65 });
  assert.equal(good.netCredit, 48.7);
  assert.equal(good.verdict, 'good');
  const debit = rollMetrics({ contracts: 1, buyBackPrice: 2, sellPrice: 1, commission: 0.65 });
  assert.equal(debit.netCredit, -101.3);
  assert.equal(debit.verdict, 'debit');
});

test('adjusted cost basis includes premiums, fees and dividends', () => {
  assert.equal(Math.round(adjustedCostBasis({ assignmentPrice: 25, premiums: 178, fees: 2, dividends: 20, shares: 100 }) * 100) / 100, 23.44);
});

test('recovery scenarios classify by distance below cost basis', () => {
  assert.equal(recoveryScenario({ costBasis: 50, currentPrice: 51 }).key, 'A');
  assert.equal(recoveryScenario({ costBasis: 50, currentPrice: 46 }).key, 'B');
  assert.equal(recoveryScenario({ costBasis: 50, currentPrice: 40 }).key, 'C');
  assert.equal(recoveryScenario({ costBasis: 50, currentPrice: 30 }).key, 'D');
  assert.equal(recoveryScenario({ costBasis: 50, currentPrice: 49, thesisBroken: true }).key, 'D');
});

test('call candidate analysis estimates recovery time', () => {
  const a = callCandidateAnalysis({ strike: 50, bid: 1, daysToExpiry: 30, costBasis: 48, currentPrice: 45, commission: 0.65 });
  assert.equal(a.netPremium, 99.35);
  assert.ok(a.recoveryMonths > 0);
  assert.equal(a.atOrAboveBasis, true);
});

test('validation rejects oversized and malformed trades', () => {
  assert.equal(validatePutTrade({ contracts: 1, strike: 90, price: 1, daysToExpiry: 30, availableCash: 5000 }).ok, false);
  assert.equal(validatePutTrade({ contracts: 1, strike: 45, price: 1, daysToExpiry: 30, availableCash: 5000 }).ok, true);
  assert.equal(validatePutTrade({ contracts: 0, strike: 45, price: 1, daysToExpiry: 30 }).ok, false);
});

test('validateSize enforces the per-wheel and reserve rules', () => {
  assert.equal(validateSize({ accountValue: 10000, shares: 100, strike: 90 }).ok, false);
  assert.equal(validateSize({ accountValue: 10000, shares: 50, strike: 90 }).remaining, 4500);
});

test('annualized return handles edge cases', () => {
  assert.equal(annualizedReturn(2, 0), null);
  assert.equal(annualizedReturn(2, 30), (2 * 365) / 30);
  assert.equal(probabilityOtm(-0.3), 70);
  assert.equal(probabilityOtm(null), null);
});

test('wheel state machine follows a full cycle', () => {
  const trades = [
    { action: 'SELL_PUT_OPEN', contracts: 1, price: 1.2, fees: 0.65, strike: 25, expiry: '2026-10-16', executedAt: '2026-09-01' },
    { action: 'PUT_ASSIGN', contracts: 1, price: 0, fees: 0, strike: 25, executedAt: '2026-10-16' },
  ];
  const s1 = wheelState({}, trades);
  assert.equal(s1.state, 'holding');
  assert.equal(s1.shares, 100);
  assert.equal(s1.premiums, 119.35);
  const s2 = wheelState({}, [...trades, { action: 'SELL_CALL_OPEN', contracts: 1, price: 0.5, fees: 0.65, strike: 27, expiry: '2026-11-20', executedAt: '2026-10-20' }]);
  assert.equal(s2.state, 'short_call');
  assert.equal(s2.premiums, 168.7);
});

test('checklist flags a stock that is not happy-to-own as avoid', () => {
  const ctx = buildChecklistContext({
    state: { account: { budget: 10000, cash: 10000 }, wheels: [], settings: DEFAULT_SETTINGS },
    data: { symbol: 'XYZ', quote: { price: 30 }, profile: { marketCap: 50e9, industry: 'Tech' }, metrics: { epsTTM: 2, avgVolume: 3e6 }, earnings: { nextDate: '2027-01-01' }, priceVsMa200: 5 },
    option: { strike: 28, bid: 0.5, ask: 0.55, mid: 0.525, delta: -0.2, dte: 35, expiry: '2026-12-01', openInterest: 800 },
    manual: { happyToOwn: false, notMeme: true },
  });
  const r = evaluateChecklist(ctx);
  assert.equal(r.verdict.key, 'avoid');
});

test('checklist passes a textbook candidate', () => {
  const ctx = buildChecklistContext({
    state: { account: { budget: 10000, cash: 10000 }, wheels: [], settings: DEFAULT_SETTINGS },
    data: { symbol: 'XYZ', quote: { price: 30 }, profile: { marketCap: 50e9, industry: 'Tech' }, metrics: { epsTTM: 2, avgVolume: 3e6 }, earnings: { nextDate: '2027-01-01' }, priceVsMa200: 5, dividends: { next: null } },
    option: { strike: 28, bid: 0.5, ask: 0.55, mid: 0.525, delta: -0.2, dte: 35, expiry: '2026-12-01', openInterest: 800, ivRank: 45 },
    manual: { happyToOwn: true, notMeme: true },
  });
  const r = evaluateChecklist(ctx);
  assert.equal(r.verdict.key, 'good');
  assert.ok(r.passCount >= 15);
  assert.equal(CHECKLIST.length, 18);
});

test('CSV export escapes commas and quotes', async () => {
  const { toCsv } = await import('../src/export.js');
  assert.match(toCsv([{ a: 'x,y', b: 'q"' }]), /"x,y"/);
});

test('money and dte format predictably', () => {
  assert.equal(money(1234.5), '$1,234.50');
  assert.equal(money(null), '—');
  const days = dte('2030-01-01', new Date('2029-12-02T12:00:00Z'));
  assert.equal(days, 31);
});

test('market status returns a known shape', () => {
  const s = marketStatus(new Date('2026-10-02T15:00:00Z'));
  assert.ok(['open', 'pre', 'after', 'closed'].includes(s.state));
  assert.match(s.clock, /ET/);
});

test('manual values override missing fetched data in the checklist', () => {
  const ctx = buildChecklistContext({
    state: { account: { budget: 10000, cash: 10000 }, wheels: [], settings: DEFAULT_SETTINGS },
    data: { symbol: 'XYZ', quote: { price: 30 }, profile: { marketCap: null }, metrics: { epsTTM: null, avgVolume: null }, priceVsMa200: null, earnings: {}, dividends: {} },
    option: { strike: 28, mid: 0.5, delta: -0.2, dte: 35, expiry: '2026-12-01', openInterest: 800 },
    manual: { marketCap: 50e9, epsTTM: 2, avgVolume: 3e6, priceVsMa200: 5, nextEarnings: '2027-01-01', exDividend: '2026-11-01', happyToOwn: true, notMeme: true, ivRank: 45 },
  });
  const byId = Object.fromEntries(evaluateChecklist(ctx).items.map((i) => [i.id, i.status]));
  assert.notEqual(byId.A2, 'unknown');
  assert.notEqual(byId.A3, 'unknown');
  assert.notEqual(byId.A4, 'unknown');
  assert.notEqual(byId.A5, 'unknown');
  assert.notEqual(byId.C14, 'unknown');
  assert.notEqual(byId.C15, 'unknown');
});

test('delta 0.30 is a pass (rounding tolerance) and A4 tolerates a small dip', () => {
  const base = {
    state: { account: { budget: 10000, cash: 10000 }, wheels: [], settings: DEFAULT_SETTINGS },
    data: { symbol: 'X', quote: { price: 30 }, profile: { marketCap: 50e9 }, metrics: { epsTTM: 2, avgVolume: 3e6 }, priceVsMa200: -3.4, earnings: {}, dividends: {} },
    option: { strike: 28, mid: 0.5, delta: -0.3049, dte: 35, expiry: '2026-12-01', openInterest: 800 },
  };
  const byId = (ctx) => Object.fromEntries(evaluateChecklist(buildChecklistContext(ctx)).items.map((i) => [i.id, i.status]));
  assert.equal(byId(base).C11, 'pass');
  assert.equal(byId(base).A4, 'pass');
  const deep = { ...base, data: { ...base.data, priceVsMa200: -22 } };
  assert.equal(byId(deep).A4, 'fail');
});

test('C15 resolves dividend status instead of staying unverified', () => {
  const mk = (dividends, metrics) => buildChecklistContext({
    state: { account: { budget: 10000, cash: 10000 }, wheels: [], settings: DEFAULT_SETTINGS },
    data: { symbol: 'X', quote: { price: 30 }, profile: { marketCap: 50e9 }, metrics: { epsTTM: 2, avgVolume: 3e6, ...metrics }, priceVsMa200: 1, earnings: {}, dividends },
    option: { strike: 28, mid: 0.5, delta: -0.2, dte: 35, expiry: '2026-12-01', openInterest: 800 },
  });
  const c15 = (ctx) => evaluateChecklist(ctx).items.find((i) => i.id === 'C15').status;
  assert.equal(c15(mk({ next: null }, { dividendYield: 0 })), 'pass');       // no dividend
  assert.equal(c15(mk({ next: null }, { dividendYield: 6.8 })), 'warn');     // pays, date unknown
  assert.equal(c15(mk({ next: { exDate: '2026-11-09', estimated: true } }, { dividendYield: 6.8 })), 'pass');
});

test('captured % follows the 50%-profit rule', () => {
  assert.equal(Math.round(capturedPct({ entryMid: 1, currentMid: 0.4, contracts: 1, commission: 0 })), 60);
  assert.ok(capturedPct({ entryMid: 1, currentMid: 0.4, contracts: 1, commission: 0.65 }) > 55);
  assert.equal(capturedPct({ entryMid: 0, currentMid: 0.4 }), null);
});

test('findContract matches type/strike/expiry', () => {
  const rows = [
    { type: 'put', strike: 45, expiry: '2026-12-18', mid: 0.5 },
    { type: 'call', strike: 45, expiry: '2026-12-18', mid: 0.6 },
  ];
  assert.equal(findContract(rows, { type: 'put', strike: 45, expiry: '2026-12-18' }).mid, 0.5);
  assert.equal(findContract(rows, { type: 'call', strike: 45 }).mid, 0.6);
  assert.equal(findContract(rows, { type: 'put', strike: 99 }), null);
});

test('wheelState counts rolls/closes and tracks the last entry leg', () => {
  const trades = [
    { action: 'SELL_PUT_OPEN', contracts: 1, price: 1, fees: 0.65, strike: 45, expiry: '2026-11-20', executedAt: '2026-10-01' },
    { action: 'BUY_PUT_CLOSE', contracts: 1, price: 0.4, fees: 0.65, strike: 45, expiry: '2026-11-20', executedAt: '2026-10-20' },
    { action: 'SELL_PUT_OPEN', contracts: 1, price: 0.8, fees: 0.65, strike: 44, expiry: '2026-12-18', executedAt: '2026-10-20' },
  ];
  const st = wheelState({}, trades);
  assert.equal(st.rolls, 1);
  assert.equal(st.lastEntry.type, 'put');
  assert.equal(st.lastEntry.strike, 44);
  assert.equal(st.state, 'short_put');
});

test('dates display as DD/MM/YYYY and parse back to ISO', () => {
  assert.equal(toDMY('2026-11-09'), '09/11/2026');
  assert.equal(toDMY('09/11/2026'), '09/11/2026');
  assert.equal(parseDMY('09/11/2026'), '2026-11-09');
  assert.equal(parseDMY('2026-11-09'), '2026-11-09');
  assert.equal(parseDMY('not a date'), null);
});

test('checklist items map to a manual override field', () => {
  assert.equal(manualFieldFor('C15'), 'exDividend');
  assert.equal(manualFieldFor('C14'), 'nextEarnings');
  assert.equal(manualFieldFor('A7'), 'happyToOwn');
  assert.equal(manualFieldFor('B9'), null);
});

test('checklist items expose external verification links', () => {
  assert.match(itemLink('C14', 'AAPL'), /nasdaq\.com/);
  assert.match(itemLink('A4', 'KO'), /tradingview/);
  assert.equal(itemLink('A1', 'KO'), null);
});

test('black-scholes greeks have the expected signs and magnitudes', () => {
  const call = blackScholes({ type: 'call', S: 100, K: 100, daysToExpiry: 30, iv: 25 });
  const put = blackScholes({ type: 'put', S: 100, K: 100, daysToExpiry: 30, iv: 25 });
  assert.ok(call.delta > 0 && call.delta < 1);
  assert.ok(put.delta < 0 && put.delta > -1);
  assert.ok(Math.abs(call.delta - put.delta - 1) < 1e-9);
  assert.ok(call.gamma > 0);
  assert.ok(put.theta < 0);
  assert.ok(call.price > 0 && put.price > 0);
  assert.equal(blackScholes({ type: 'call', S: 0, K: 100, daysToExpiry: 30, iv: 25 }), null);
});

test('risk presets override the right settings', () => {
  const safest = presetSettings('safest');
  assert.equal(safest.reservePct, 0.2);
  assert.equal(safest.deltaMax, 0.2);
  assert.ok(safest.thresholds.openInterest > DEFAULT_SETTINGS.thresholds.openInterest);
  assert.equal(presetSettings('nope'), null);
  assert.equal(Object.keys(RISK_PRESETS).length, 3);
});

test('self-test suite is fully green', () => {
  const t = selfTest();
  const failed = t.results.filter((r) => !r.pass);
  assert.equal(failed.length, 0, JSON.stringify(failed));
});
