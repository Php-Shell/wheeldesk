// ---------------------------------------------------------------------------
// Application state: localStorage persistence, derived account values and
// all write actions. The store is tiny and synchronous; UI subscribes to it.
// ---------------------------------------------------------------------------

import { DEFAULT_SETTINGS, mergeSettings, presetSettings, wheelState, CONTRACT_MULTIPLIER } from './calc.js';
import { toNum, round, isoNow, todayISO } from './format.js';

const KEY = 'wheel-desk-v3';

export function uid() {
  return globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function emptyState() {
  return {
    version: 3,
    account: { name: 'My paper account', budget: 10000, currency: 'USD', fxRate: 1 },
    settings: structuredClone(DEFAULT_SETTINGS),
    marks: {},
    watchlist: [],
    wheels: [],
    trades: [],
    dividends: [],
    journal: [],
    snapshots: [],
    events: [],
    meta: { demo: false, lastExportAt: null, lastSyncAt: null, createdAt: isoNow() },
  };
}

let state = loadState();
const listeners = new Set();

function loadState() {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return emptyState();
    const parsed = JSON.parse(raw);
    if (parsed?.version !== 3) return emptyState();
    return { ...emptyState(), ...parsed, settings: mergeSettings(parsed.settings) };
  } catch {
    return emptyState();
  }
}

export function saveState(next = state, { silent = false } = {}) {
  state = next;
  try {
    localStorage.setItem(KEY, JSON.stringify(state));
  } catch {
    /* storage may be full or blocked; the app still works in memory */
  }
  if (!silent) listeners.forEach((fn) => fn(state));
  return state;
}

export function getState() {
  return state;
}

export function subscribe(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function mutate(fn) {
  const draft = structuredClone(state);
  fn(draft);
  return saveState(draft);
}

function record(draft, type, detail = {}) {
  draft.events.push({ id: uid(), at: isoNow(), type, ...detail });
  if (draft.events.length > 500) draft.events = draft.events.slice(-500);
}

// ---- Derived account -----------------------------------------------------

export function deriveAccount(s = state) {
  const settings = mergeSettings(s.settings);
  const budget = toNum(s.account.budget, settings.budget);
  let cashFlow = 0;
  for (const t of s.trades) cashFlow += toNum(t.cashFlow, 0);
  for (const d of s.dividends) cashFlow += toNum(d.amountPerShare, 0) * toNum(d.shares, 0);
  const cash = budget + cashFlow;

  let reserved = 0;
  let sharesCost = 0;
  let sharesValue = 0;
  let premiums = 0;
  let fees = 0;
  let realized = 0;
  let openWheels = 0;
  let closedWheels = 0;
  let wins = 0;
  const marks = s.marks || {};

  for (const w of s.wheels) {
    const wTrades = s.trades.filter((t) => t.wheelId === w.id);
    const wDiv = s.dividends.filter((d) => d.wheelId === w.id);
    const st = wheelState(w, wTrades, wDiv);
    reserved += st.collateral;
    premiums += st.premiums;
    fees += st.fees;
    const mark = toNum(marks[w.ticker], null);
    sharesCost += (st.assignmentPrice ?? 0) * st.shares;
    sharesValue += (mark ?? st.assignmentPrice ?? 0) * st.shares;
    const wRealized = st.realized + (mark !== null && st.shares > 0 ? (mark - (st.costBasis ?? mark)) * st.shares : 0);
    realized += wRealized;
    if (w.state === 'complete') {
      closedWheels += 1;
      if ((st.premiums + st.realized) > 0) wins += 1;
    } else {
      openWheels += 1;
    }
  }

  const reserve = budget * settings.reservePct;
  const availableCash = cash - reserved;
  const netLiquidation = cash + sharesValue;
  const unrealized = sharesValue - sharesCost;
  return {
    budget,
    cash,
    reserved,
    availableCash,
    sharesCost,
    sharesValue,
    unrealized,
    premiums,
    fees,
    realized,
    reserve,
    openWheels,
    closedWheels,
    wins,
    winRate: closedWheels > 0 ? (wins / closedWheels) * 100 : null,
    netLiquidation,
    totalReturnPct: budget > 0 ? ((netLiquidation - budget) / budget) * 100 : 0,
    incomePct: budget > 0 ? (premiums / budget) * 100 : 0,
    allocation: {
      free: Math.max(0, availableCash - reserve),
      reserve: Math.min(reserve, Math.max(0, availableCash)),
      collateral: reserved,
      shares: sharesValue,
    },
  };
}

export function wheelById(id, s = state) {
  return s.wheels.find((w) => w.id === id) || null;
}

export function wheelSummary(w, s = state) {
  const trades = s.trades.filter((t) => t.wheelId === w.id);
  const dividends = s.dividends.filter((d) => d.wheelId === w.id);
  const st = wheelState(w, trades, dividends);
  const mark = toNum(s.marks?.[w.ticker], null);
  const dte = st.daysToExpiry;
  const settings = mergeSettings(s.settings);
  const put = st.openPut > 0;
  const entries = { short_put: 'Short put open', holding: 'Holding shares', short_call: 'Short call open', complete: 'Wheel complete', idle: 'Idle' };

  let status = 'green';
  let nextAction = 'No action needed right now.';

  if (st.state === 'short_put') {
    const gross = st.premiums;
    const profitPct = gross / Math.max(1, st.collateral);
    if (dte !== null && dte <= 0) {
      status = 'red';
      nextAction = 'Expiry reached — mark it expired or assigned in the Actions panel.';
    } else if (dte !== null && dte <= 7 && mark !== null && st.putStrike && mark < st.putStrike) {
      status = 'red';
      nextAction = `Expires in ${dte} days and is in the money — open the Assignment Assistant.`;
    } else if (dte !== null && settings.timeRuleOn && dte <= settings.timeRuleDte) {
      status = 'amber';
      nextAction = `${dte} DTE — consider closing or rolling (only for a net credit).`;
    } else if (profitPct >= settings.takeProfitPct * 0.9) {
      status = 'amber';
      nextAction = 'Approaching the 50% profit target — consider buying to close.';
    }
  } else if (st.state === 'holding') {
    status = 'amber';
    nextAction = 'You own 100 shares per contract. Sell a covered call at or above your cost basis.';
  } else if (st.state === 'short_call') {
    if (dte !== null && dte <= settings.timeRuleDte) {
      status = 'amber';
      nextAction = `${dte} DTE on the covered call — consider rolling up/out for a net credit.`;
    } else {
      nextAction = 'Covered call open. Let it decay; watch ex-dividend dates.';
    }
  } else if (st.state === 'complete') {
    status = 'green';
    nextAction = 'Wheel complete. Consider the next candidate in the Screener.';
  }

  return { ...st, mark, dte, status, nextAction, trades, dividends, pnl: st.premiums + st.realized + (mark !== null && st.shares > 0 ? (mark - (st.costBasis ?? mark)) * st.shares : 0) };
}

// ---- Actions -------------------------------------------------------------

export const actions = {
  updateSettings(patch) {
    return mutate((d) => {
      d.settings = mergeSettings({ ...d.settings, ...patch, thresholds: { ...d.settings.thresholds, ...(patch.thresholds || {}) }, recovery: { ...d.settings.recovery, ...(patch.recovery || {}) } });
    });
  },
  applyPreset(name) {
    const preset = presetSettings(name);
    if (!preset) return state;
    return mutate((d) => {
      d.settings = mergeSettings({ ...d.settings, ...preset });
      d.meta.riskProfile = name;
    });
  },
  updateAccount(patch) {
    return mutate((d) => {
      d.account = { ...d.account, ...patch };
    });
  },
  setMarks(marks) {
    return mutate((d) => {
      for (const [ticker, price] of Object.entries(marks || {})) {
        const n = toNum(price, null);
        if (n !== null) d.marks[ticker] = n;
      }
    });
  },
  setMark(ticker, price) {
    return mutate((d) => {
      if (price === null || price === undefined) delete d.marks[ticker];
      else d.marks[ticker] = toNum(price, null);
    });
  },
  addWatch(symbol, notes = '') {
    const ticker = String(symbol || '').trim().toUpperCase();
    if (!ticker) return state;
    return mutate((d) => {
      if (d.watchlist.some((w) => w.symbol === ticker)) return;
      d.watchlist.push({ symbol: ticker, notes, addedAt: isoNow(), checklist: null, manual: {}, option: null, data: null });
      record(d, 'WATCH_ADD', { symbol: ticker });
    });
  },
  removeWatch(symbol) {
    return mutate((d) => {
      d.watchlist = d.watchlist.filter((w) => w.symbol !== symbol);
    });
  },
  updateWatch(symbol, patch) {
    return mutate((d) => {
      d.watchlist = d.watchlist.map((w) => (w.symbol === symbol ? { ...w, ...patch } : w));
    });
  },
  openWheel({ ticker, sector = '', mode = 'paper', plan = {}, thesis = '' }) {
    const id = uid();
    return mutate((d) => {
      const price = toNum(plan.premium, 0);
      const contracts = Math.max(1, Math.floor(toNum(plan.contracts, 1)));
      const fees = toNum(plan.fees, round(contracts * toNum(d.settings.commission, 0)));
      const wheel = {
        id,
        ticker: String(ticker).toUpperCase(),
        sector,
        mode,
        state: 'short_put',
        openedAt: plan.executedAt || isoNow(),
        closedAt: null,
        reviewDate: null,
        thesis,
        plan,
        assignedPrice: null,
        lessons: '',
      };
      d.wheels.push(wheel);
      d.trades.push({
        id: uid(),
        wheelId: id,
        ticker: wheel.ticker,
        executedAt: plan.executedAt || isoNow(),
        action: 'SELL_PUT_OPEN',
        optionType: 'put',
        strike: toNum(plan.strike, null),
        expiry: plan.expiry || null,
        contracts,
        price,
        fees,
        cashFlow: round(price * CONTRACT_MULTIPLIER * contracts - fees, 2),
        mode,
        notes: plan.notes || '',
      });
      record(d, 'WHEEL_OPEN', { wheelId: id, ticker: wheel.ticker });
    }).wheels.find((w) => w.id === id);
  },
  addTrade(wheelId, trade) {
    const id = uid();
    return mutate((d) => {
      const w = d.wheels.find((x) => x.id === wheelId);
      if (!w) throw new Error('Wheel not found.');
      const contracts = Math.max(1, Math.floor(toNum(trade.contracts, 1)));
      const price = toNum(trade.price, 0);
      const fees = toNum(trade.fees, 0);
      const multiplier = CONTRACT_MULTIPLIER * contracts;
      let cashFlow = 0;
      switch (trade.action) {
        case 'SELL_PUT_OPEN':
        case 'SELL_CALL_OPEN':
          cashFlow = price * multiplier - fees;
          break;
        case 'BUY_PUT_CLOSE':
        case 'BUY_CALL_CLOSE':
          cashFlow = -(price * multiplier) - fees;
          break;
        case 'PUT_ASSIGN':
          cashFlow = -(toNum(trade.strike, 0) * multiplier) - fees;
          w.assignedPrice = toNum(trade.strike, w.assignedPrice);
          break;
        case 'CALL_ASSIGN':
          cashFlow = toNum(trade.strike, 0) * multiplier - fees;
          break;
        case 'SELL_SHARES':
          cashFlow = price * multiplier - fees;
          break;
        case 'BUY_SHARES':
          cashFlow = -(price * multiplier) - fees;
          break;
        default:
          cashFlow = -fees;
      }
      d.trades.push({
        id,
        wheelId,
        ticker: w.ticker,
        executedAt: trade.executedAt || isoNow(),
        action: trade.action,
        optionType: trade.optionType || (trade.action.includes('CALL') ? 'call' : trade.action.includes('PUT') ? 'put' : 'stock'),
        strike: toNum(trade.strike, null),
        expiry: trade.expiry || null,
        contracts,
        price,
        fees,
        cashFlow: round(cashFlow, 2),
        mode: trade.mode || w.mode,
        notes: trade.notes || '',
      });
      record(d, 'TRADE', { wheelId, action: trade.action });
      const closed = ['CALL_EXPIRE', 'CALL_ASSIGN', 'SELL_SHARES'];
      if (closed.includes(trade.action) && d.trades.filter((t) => t.wheelId === wheelId && ['CALL_EXPIRE', 'CALL_ASSIGN', 'SELL_SHARES'].includes(t.action)).length > 0) {
        const st = wheelState(w, d.trades.filter((t) => t.wheelId === wheelId), d.dividends.filter((x) => x.wheelId === wheelId));
        if (st.shares === 0 && st.openCall === 0 && st.openPut === 0) {
          w.state = 'complete';
          w.closedAt = isoNow();
        }
      }
    });
  },
  recordDividend(wheelId, dividend) {
    return mutate((d) => {
      const w = d.wheels.find((x) => x.id === wheelId);
      d.dividends = d.dividends;
      d.dividends.push({ id: uid(), wheelId, ticker: w?.ticker || '', exDate: dividend.exDate || null, payDate: dividend.payDate || null, amountPerShare: toNum(dividend.amountPerShare, 0), shares: toNum(dividend.shares, 100) });
      record(d, 'DIVIDEND', { wheelId });
    });
  },
  updateWheel(id, patch) {
    return mutate((d) => {
      d.wheels = d.wheels.map((w) => (w.id === id ? { ...w, ...patch } : w));
    });
  },
  completeWheel(id, lessons = '') {
    return mutate((d) => {
      const w = d.wheels.find((x) => x.id === id);
      if (w) {
        w.state = 'complete';
        w.closedAt = isoNow();
        w.lessons = lessons;
      }
      record(d, 'WHEEL_COMPLETE', { wheelId: id });
    });
  },
  addJournal(body) {
    const text = String(body || '').trim();
    if (!text) return state;
    return mutate((d) => {
      d.journal.unshift({ id: uid(), at: isoNow(), body: text });
    });
  },
  takeSnapshot() {
    return mutate((d) => {
      const a = deriveAccount(d);
      d.snapshots.push({ asOf: todayISO(), cash: a.cash, reserved: a.reserved, shares: a.sharesValue, netLiquidation: a.netLiquidation, premiums: a.premiums, realized: a.realized });
      d.snapshots = d.snapshots.slice(-365);
    });
  },
  markExported() {
    return mutate((d) => {
      d.meta.lastExportAt = isoNow();
    });
  },
  importState(data) {
    return saveState({ ...emptyState(), ...data, version: 3, settings: mergeSettings(data.settings) });
  },
  reset() {
    return saveState(emptyState());
  },
  loadDemo() {
    return saveState(demoState());
  },
  clearDemo() {
    return saveState(emptyState());
  },
};

// ---- Demo data -----------------------------------------------------------

function demoTrade(ticker, action, patch) {
  return { id: uid(), ticker, action, optionType: action.includes('CALL') ? 'call' : action.includes('PUT') ? 'put' : 'stock', executedAt: isoNow(), contracts: 1, price: 0, fees: 0.65, strike: null, expiry: null, cashFlow: 0, mode: 'paper', notes: 'Fictional demo data', ...patch };
}

export function demoState() {
  const d = emptyState();
  d.meta.demo = true;
  d.settings = mergeSettings({ ...DEFAULT_SETTINGS });

  const open = {
    id: uid(),
    ticker: 'KO',
    sector: 'Consumer Defensive',
    mode: 'paper',
    state: 'short_put',
    openedAt: '2026-09-15T14:30:00Z',
    closedAt: null,
    reviewDate: null,
    thesis: 'Boring, profitable, I would happily own Coca-Cola at $60.',
    plan: { strike: 60, expiry: '2026-10-16', contracts: 1, premium: 0.95, dte: 31 },
    assignedPrice: null,
    lessons: '',
  };
  const recovery = {
    id: uid(),
    ticker: 'T',
    sector: 'Communication Services',
    mode: 'paper',
    state: 'holding',
    openedAt: '2026-07-01T14:00:00Z',
    closedAt: null,
    reviewDate: null,
    thesis: 'Demo recovery wheel: assigned and waiting for a covered call.',
    plan: { strike: 20, expiry: '2026-07-17', contracts: 1, premium: 0.42, dte: 16 },
    assignedPrice: 20,
    lessons: '',
  };
  const done = {
    id: uid(),
    ticker: 'PFE',
    sector: 'Healthcare',
    mode: 'paper',
    state: 'complete',
    openedAt: '2026-03-02T15:00:00Z',
    closedAt: '2026-05-20T15:00:00Z',
    reviewDate: null,
    thesis: 'Demo completed wheel.',
    plan: { strike: 25, expiry: '2026-03-20', contracts: 1, premium: 0.6, dte: 18 },
    assignedPrice: 25,
    lessons: 'Patience paid; kept calls at cost basis.',
  };

  d.wheels = [open, recovery, done];
  d.trades = [
    demoTrade('KO', 'SELL_PUT_OPEN', { wheelId: open.id, strike: 60, expiry: '2026-10-16', price: 0.95, cashFlow: 94.35, executedAt: '2026-09-15T14:30:00Z' }),
    demoTrade('T', 'SELL_PUT_OPEN', { wheelId: recovery.id, strike: 20, expiry: '2026-07-17', price: 0.42, cashFlow: 41.35, executedAt: '2026-07-01T14:00:00Z' }),
    demoTrade('T', 'PUT_ASSIGN', { wheelId: recovery.id, strike: 20, price: 0, cashFlow: -2000, executedAt: '2026-07-17T20:00:00Z' }),
    demoTrade('T', 'SELL_CALL_OPEN', { wheelId: recovery.id, strike: 21, expiry: '2026-08-21', price: 0.35, cashFlow: 34.35, executedAt: '2026-07-20T14:00:00Z' }),
    demoTrade('T', 'CALL_EXPIRE', { wheelId: recovery.id, strike: 21, price: 0, cashFlow: 0, executedAt: '2026-08-21T20:00:00Z' }),
    demoTrade('PFE', 'SELL_PUT_OPEN', { wheelId: done.id, strike: 25, expiry: '2026-03-20', price: 0.6, cashFlow: 59.35, executedAt: '2026-03-02T15:00:00Z' }),
    demoTrade('PFE', 'PUT_ASSIGN', { wheelId: done.id, strike: 25, price: 0, cashFlow: -2500, executedAt: '2026-03-20T20:00:00Z' }),
    demoTrade('PFE', 'SELL_CALL_OPEN', { wheelId: done.id, strike: 26, expiry: '2026-04-17', price: 0.55, cashFlow: 54.35, executedAt: '2026-03-23T14:00:00Z' }),
    demoTrade('PFE', 'CALL_ASSIGN', { wheelId: done.id, strike: 26, price: 0, cashFlow: 2600, executedAt: '2026-04-17T20:00:00Z' }),
  ];
  d.dividends = [{ id: uid(), wheelId: recovery.id, ticker: 'T', exDate: '2026-07-09', payDate: '2026-08-01', amountPerShare: 0.2775, shares: 100 }];
  d.marks = { KO: 61.2, T: 19.1, PFE: 26.4 };
  d.watchlist = [
    { symbol: 'T', notes: 'Demo watch', addedAt: isoNow(), manual: { happyToOwn: true, notMeme: true }, checklist: null, data: null, option: null },
    { symbol: 'VZ', notes: 'Demo watch', addedAt: isoNow(), manual: {}, checklist: null, data: null, option: null },
  ];
  d.journal = [{ id: uid(), at: isoNow(), body: 'Demo note: I only sell puts on names I would happily own for months.' }];
  d.snapshots = [];
  return d;
}
