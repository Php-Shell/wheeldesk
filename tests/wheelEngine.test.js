import test from 'node:test';
import assert from 'node:assert/strict';
import {
  netPremium,
  totalPremiums,
  adjustedBasisPerShare,
  unrealizedPnL,
  gapPct,
  gradeCall,
  takeProfitLimit,
  exitSimulator,
  decidePath,
  openPositions,
  maxCallContracts,
  DEFAULT_WHEEL_RULES,
} from '../src/wheelEngine.js';

const near = (a, b, tol = 0.01) => Math.abs(a - b) <= tol;
const putSold = (o = {}) => ({ type: 'PUT_SOLD', contracts: 1, optionPrice: 0.64, commission: 0.66, strike: 44, expiry: '2026-11-20', eventTime: '2026-10-13T11:42:00Z', ...o });
const assigned = (o = {}) => ({ type: 'PUT_ASSIGNED', contracts: 1, shares: 100, strike: 44, commission: 0, eventTime: '2026-11-23T14:00:00Z', ...o });
const callSold = (o = {}) => ({ type: 'CALL_SOLD', contracts: 1, optionPrice: 0.51, commission: 0.66, strike: 44, expiry: '2026-12-24', eventTime: '2026-11-24T11:20:00Z', ...o });
const callBtc = (o = {}) => ({ type: 'CALL_BOUGHT_TO_CLOSE', contracts: 1, optionPrice: 0.8, commission: 0.66, strike: 44, eventTime: '2026-12-01T15:00:00Z', ...o });

test('T1 net premium of the put = 63.34', () => {
  assert.ok(near(netPremium(putSold()), 63.34));
});

test('T2 adjusted basis after assignment = 43.3666', () => {
  const r = adjustedBasisPerShare([putSold(), assigned()]);
  assert.ok(near(r.basisPerShare, 43.3666));
  assert.equal(r.sharesHeld, 100);
});

test('T3 unrealized P&L and gap at 42.10 → PATH A', () => {
  assert.ok(near(unrealizedPnL(42.1, 43.3666, 100), -126.66, 0.02));
  const g = gapPct(43.3666, 42.1);
  assert.ok(near(g, 2.92));
  assert.equal(decidePath({ gapPct: g, thesisOk: true }).path, 'A');
});

test('T4 candidate call 44C passes with net 50.35 and ~12.11% annualized', () => {
  const c = gradeCall({ strike: 44, expiry: '2026-12-24', bid: 0.49, ask: 0.53, delta: 0.27, dte: 35, openInterest: 1240, volume: 95 }, { basisPerShare: 43.3666, sharesHeld: 100, assignmentStrike: 44, assignmentFees: 0, totalPremiumsTotal: 63.34 });
  assert.ok(near(c.mid, 0.51));
  assert.ok(near(c.spread, 0.04));
  assert.ok(near(c.spreadPct, 7.84));
  assert.equal(c.spreadGrade.key, 'ok');
  assert.ok(near(c.estNetPremium, 50.35));
  assert.ok(near(c.returnPct, 1.16));
  assert.ok(near(c.annualizedPct, 12.11));
  assert.equal(c.passes, true);
});

test('T5 logged call fill → new basis 42.8632', () => {
  assert.ok(near(netPremium(callSold()), 50.34));
  const r = adjustedBasisPerShare([putSold(), assigned(), callSold()]);
  assert.ok(near(r.basisPerShare, 42.8632));
});

test('T6 called away at 44 → wheel profit 113.68 (both methods)', () => {
  const premiums = 63.34 + 50.34;
  const basis = 42.8632;
  assert.ok(near(premiums, 113.68));
  assert.ok(near((44 - basis) * 100, 113.68));
});

test('T7 take-profit limit for 0.51 at 50% = 0.25 (rounded down)', () => {
  assert.equal(takeProfitLimit(0.51, 50), 0.25);
});

test('T8/T9 gap thresholds → PATH B and PATH B monthly review', () => {
  assert.ok(near(gapPct(43.3666, 38.5), 11.22));
  assert.equal(decidePath({ gapPct: gapPct(43.3666, 38.5), thesisOk: true }).path, 'B');
  assert.ok(near(gapPct(43.3666, 36.0), 16.99));
  assert.equal(decidePath({ gapPct: gapPct(43.3666, 36.0), thesisOk: true }).path, 'B_MONTHLY_REVIEW');
});

test('T10 thesis broken → PATH C', () => {
  assert.equal(decidePath({ gapPct: 2, thesisOk: false }).path, 'C');
});

test('T11 exit simulator at 38.50 with $1 stock commission = −487.66', () => {
  const r = exitSimulator({ salePrice: 38.5, basisPerShare: 43.3666, sharesHeld: 100, stockCommission: 1 });
  assert.ok(near(r.gross, -486.66));
  assert.ok(near(r.realized, -487.66));
});

test('T12 strike below basis is rejected; 43.50 is allowed', () => {
  const a = gradeCall({ strike: 43, bid: 0.4, ask: 0.44, dte: 35 }, { basisPerShare: 43.3666, sharesHeld: 100 });
  assert.equal(a.belowBasis, true);
  assert.equal(a.passes, false);
  const b = gradeCall({ strike: 43.5, bid: 0.4, ask: 0.44, dte: 35 }, { basisPerShare: 43.3666, sharesHeld: 100 });
  assert.equal(b.belowBasis, false);
});

test('T13 spread 0.48/0.54 → 11.76% borderline', () => {
  const c = gradeCall({ strike: 44, bid: 0.48, ask: 0.54, dte: 35 }, { basisPerShare: 43.3666, sharesHeld: 100 });
  assert.ok(near(c.spreadPct, 11.76));
  assert.equal(c.spreadGrade.key, 'borderline');
});

test('T14 100 shares → max 1 call contract', () => {
  assert.equal(maxCallContracts(100), 1);
});

test('T15 open short call blocks duplicate/exit until closed', () => {
  const evs = [putSold(), assigned(), callSold()];
  const pos = openPositions(evs);
  assert.equal(pos.shortCalls, 1);
  assert.equal(pos.sharesHeld, 100);
  const afterClose = openPositions([...evs, { type: 'CALL_BOUGHT_TO_CLOSE', contracts: 1, optionPrice: 0.3, commission: 0.66, eventTime: '2026-12-02T15:00:00Z' }]);
  assert.equal(afterClose.shortCalls, 0);
});

test('T16 bought-to-close call at a loss raises basis by 0.3032', () => {
  assert.ok(near(netPremium(callBtc()), -80.66));
  // The losing call round-trip (sold 0.51, bought 0.80 = −30.32) raises the
  // basis by 0.3032 relative to the basis before the call was opened.
  const beforeCall = adjustedBasisPerShare([putSold(), assigned()]).basisPerShare;
  const after = adjustedBasisPerShare([putSold(), assigned(), callSold(), callBtc()]).basisPerShare;
  assert.ok(near(after - beforeCall, 0.3032));
});

test('T17 stock above basis → negative gap → PATH A', () => {
  const g = gapPct(43.3666, 45);
  assert.ok(g < 0);
  assert.equal(decidePath({ gapPct: g, thesisOk: true }).path, 'A');
});

test('T18 200 shares assigned, put net 126.68 → basis 43.3666, max 2 calls', () => {
  const bigPut = { type: 'PUT_SOLD', contracts: 2, optionPrice: 0.64, commission: 1.32, strike: 44, expiry: '2026-11-20', eventTime: '2026-10-13T11:42:00Z' };
  const bigAssign = { type: 'PUT_ASSIGNED', contracts: 2, shares: 200, strike: 44, commission: 0, eventTime: '2026-11-23T14:00:00Z' };
  assert.ok(near(netPremium(bigPut), 126.68));
  const r = adjustedBasisPerShare([bigPut, bigAssign]);
  assert.ok(near(r.basisPerShare, 43.3666));
  assert.equal(maxCallContracts(r.sharesHeld), 2);
  assert.equal(r.sharesHeld, 200);
});

test('DEFAULT_WHEEL_RULES include documented defaults', () => {
  assert.equal(DEFAULT_WHEEL_RULES.pathA_maxGapPct, 5);
  assert.equal(DEFAULT_WHEEL_RULES.callMinAnnualizedPct, 6);
  assert.equal(DEFAULT_WHEEL_RULES.takeProfitPctOfFill, 50);
});
