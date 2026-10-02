import { wheelSummary } from '../store.js';
import { mergeSettings, putMetrics, findContract } from '../calc.js';
import { money, pct, signedPct, escapeHtml, fmtInZone, localTimeZone, daysBetween, isoNow, dte, todayISO, toDMY } from '../format.js';
import { badge, tip, toast, openModal, field, readForm, confirmDialog } from '../ui.js';

const openIds = new Set();
const filters = { state: 'all', mode: 'all', sort: 'recent' };
// Session caches: current option mid per leg, and next ex-dividend per ticker.
const legCache = new Map();
const divCache = new Map();
let loadingLegs = false;

const STATE_LABEL = {
  short_put: 'Short put open',
  holding: 'Holding shares',
  short_call: 'Short call open',
  recovery: 'Recovery mode',
  complete: 'Wheel complete',
  idle: 'Idle',
};

const ACTION_LABEL = {
  SELL_PUT_OPEN: 'Sold put',
  BUY_PUT_CLOSE: 'Bought put back',
  PUT_EXPIRE: 'Put expired worthless',
  PUT_ASSIGN: 'Assigned on put (bought shares)',
  SELL_CALL_OPEN: 'Sold covered call',
  BUY_CALL_CLOSE: 'Bought call back',
  CALL_EXPIRE: 'Call expired worthless',
  CALL_ASSIGN: 'Called away (sold shares)',
  SELL_SHARES: 'Sold shares manually',
  BUY_SHARES: 'Bought shares',
  DIVIDEND: 'Dividend received',
};

function stateMachine(current) {
  const nodes = [
    ['idle', 'Cash'],
    ['short_put', 'STEP 1 · Sell put'],
    ['holding', 'Assigned · own shares'],
    ['short_call', 'STEP 2 · Sell call'],
    ['complete', 'Called away · cash'],
  ];
  const recovery = current === 'recovery' ? 'holding' : current;
  return `<div class="state-machine">${nodes.map(([key, label], i) => {
    const active = key === recovery;
    return `${i > 0 ? '<span class="state-arrow">→</span>' : ''}<span class="state-node ${active ? 'active' : ''}">${label}</span>`;
  }).join('')}</div><div class="muted" style="font-size:12px;margin-top:8px">Assignment is not a failure — it is the signal to move to Step 2. Expired worthless → repeat. Called away → back to cash and start again.</div>`;
}

function timeline(w) {
  const trades = [...w.trades].sort((a, b) => String(a.executedAt).localeCompare(String(b.executedAt)));
  const items = [];
  for (const t of trades) {
    const local = localTimeZone();
    items.push({
      at: t.executedAt,
      cls: t.cashFlow < 0 ? 'warn' : '',
      title: `${ACTION_LABEL[t.action] || t.action}${t.strike ? ` · $${t.strike}` : ''}${t.expiry ? ` · exp ${t.expiry}` : ''}`,
      detail: `${t.contracts} contract(s) @ ${money(t.price)} · fees ${money(t.fees)} · cash flow ${money(t.cashFlow)}`,
    });
  }
  for (const dv of w.dividends || []) {
    items.push({ at: dv.payDate || dv.exDate || isoNow(), cls: '', title: `Dividend ${money(dv.amountPerShare)}/share`, detail: `${dv.shares} shares · total ${money(Number(dv.amountPerShare) * Number(dv.shares))}` });
  }
  items.sort((a, b) => String(b.at).localeCompare(String(a.at)));
  if (!items.length) return '<p class="muted">No events yet.</p>';
  return `<div class="timeline">${items.map((i) => `
    <div class="timeline-item ${i.cls}">
      <div class="timeline-time">${escapeHtml(fmtInZone(i.at, 'America/New_York'))} ET · ${escapeHtml(fmtInZone(i.at, localTimeZone()))} local</div>
      <div class="timeline-title">${escapeHtml(i.title)}</div>
      <div class="timeline-detail">${escapeHtml(i.detail)}</div>
    </div>`).join('')}</div>`;
}

function exDivWarning(w, sm) {
  if (sm.state !== 'short_call' || !sm.callExpiry) return '';
  const ex = divCache.get(w.ticker);
  if (!ex || ex >= sm.callExpiry) return '';
  const itm = sm.mark != null && sm.callStrike != null && sm.mark > sm.callStrike;
  return `<div class="notice ${itm ? 'error' : 'info'} mt">Ex-dividend on <b>${escapeHtml(toDMY(ex))}</b>, before your call expiry (${escapeHtml(toDMY(sm.callExpiry))}).${itm ? ' Your call is in the money — early assignment risk is higher.' : ''} Early assignment can happen the day before.</div>`;
}

function actionsFor(w, sm, ctx) {
  const s = mergeSettings(ctx.state.settings);
  const buttons = [];
  const add = (label, action, cls = 'btn-secondary') => buttons.push(`<button class="btn ${cls} btn-sm" data-action="${action}" data-wheel="${w.id}">${label}</button>`);
  if (w.state === 'complete') {
    add('Edit lessons', 'LESSONS');
    return buttons.join('');
  }
  if (sm.state === 'short_put') {
    add('Buy to close', 'BUY_PUT_CLOSE', 'btn-primary');
    add('Update option price', 'CURRENT_PRICE');
    add('Roll put', 'ROLL_PUT');
    add('Mark expired', 'PUT_EXPIRE');
    add('Mark assigned', 'PUT_ASSIGN');
    add('Record dividend', 'DIVIDEND');
  } else if (sm.state === 'holding' || sm.state === 'short_call') {
    if (sm.openCall === 0) add('Step 2 → Sell covered call', 'COVERED_CALL', 'btn-primary');
    if (sm.openCall > 0) {
      add('Buy call back', 'BUY_CALL_CLOSE');
      add('Update option price', 'CURRENT_PRICE');
      add('Roll call', 'ROLL_CALL');
      add('Mark call expired', 'CALL_EXPIRE');
      add('Mark called away', 'CALL_ASSIGN');
    }
    add('Sell shares now', 'SELL_SHARES');
    add('Record dividend', 'DIVIDEND');
    add('Close wheel', 'COMPLETE', 'btn-danger');
  }
  add('Set review date', 'REVIEW');
  return buttons.join('');
}

function figures(w, sm, ctx) {
  const budget = ctx.account.budget;
  const capital = sm.costBasis !== null && sm.shares > 0 ? sm.costBasis * sm.shares : sm.collateral;
  const days = Math.max(1, daysBetween(w.openedAt, isoNow()) || 1);
  const annualized = capital > 0 ? (sm.pnl / capital) * 100 * (365 / days) : null;
  return `
    <div class="grid grid-3" style="margin-bottom:14px">
      <div class="kv"><span>Premium collected</span><span>${money(sm.premiums)}</span></div>
      <div class="kv"><span>Fees</span><span>${money(sm.fees)}</span></div>
      <div class="kv"><span>Dividends</span><span>${money(sm.dividends)}</span></div>
      <div class="kv"><span>Adjusted cost basis</span><span>${sm.costBasis === null ? '—' : money(sm.costBasis)}</span></div>
      <div class="kv"><span>Days in wheel</span><span>${days}</span></div>
      <div class="kv"><span>Current P&L</span><span class="${sm.pnl >= 0 ? 'positive' : 'negative'}">${money(sm.pnl)}</span></div>
      <div class="kv"><span>Annualized on capital <span class="muted">(est.)</span></span><span>${annualized === null ? '—' : pct(annualized)}</span></div>
      <div class="kv"><span>Shares held</span><span>${sm.shares}</span></div>
      <div class="kv"><span>Open put / call</span><span>${sm.openPut} / ${sm.openCall}</span></div>
      ${sm.leg ? `<div class="kv"><span>Option now sold at ${money(sm.leg.mid)} <span class="muted">(mid)</span></span><span>${sm.legMid != null ? money(sm.legMid) : 'not tracked'}</span></div>` : ''}
      ${sm.captured != null ? `<div class="kv"><span>Premium captured</span><span class="${sm.captured >= sm.target ? 'positive' : ''}">${sm.captured.toFixed(0)}% <span class="muted">(target ${sm.target}%)</span></span></div>` : ''}
      ${sm.rolls ? `<div class="kv"><span>Rolls / closes</span><span class="${sm.rolls >= 3 ? 'warning' : ''}">${sm.rolls}${sm.rolls >= 3 ? ' — avoid rolling endlessly' : ''}</span></div>` : ''}
    </div>`;
}

function wheelCard(w, ctx, autoOpen) {
  const sm = wheelSummary(w);
  const open = openIds.has(w.id) || autoOpen;
  const dteLabel = sm.dte === null ? '—' : sm.dte <= 0 ? 'Expired' : `${sm.dte} DTE`;
  return `
    <div class="accordion ${open ? 'open' : ''}" data-wheel-acc="${w.id}">
      <div class="accordion-head" data-wheel-toggle="${w.id}">
        <b class="mono" style="font-size:15px">${escapeHtml(w.ticker)}</b>
        ${badge(w.mode, w.mode === 'live' ? 'Live' : 'Paper')}
        ${badge(sm.status, STATE_LABEL[sm.state] || sm.state)}
        <span class="pill">${escapeHtml(dteLabel)}</span>
        <span class="pill">Premium ${money(sm.premiums)}</span>
        <span class="pill ${sm.pnl >= 0 ? 'positive' : 'negative'}">P&L ${money(sm.pnl)}</span>
        <span class="chev">›</span>
      </div>
      <div class="accordion-body">
        ${stateMachine(sm.state)}
        <div class="next-step ${sm.status === 'red' ? 'fail' : sm.status === 'amber' ? 'warn' : ''} mt">
          <b>Next step</b><div>${escapeHtml(sm.nextAction)}</div>
        </div>
        ${sm.state === 'holding' ? '<div class="notice info mt">Assignment is <b>not</b> a failure — it is Step 2. You now own 100 shares per contract; get paid again by selling covered calls at or above your cost basis.</div>' : ''}
        ${exDivWarning(w, sm)}
        <div class="mt">${figures(w, sm, ctx)}</div>
        <div class="card-head"><h4>Timeline</h4></div>
        ${timeline(sm)}
        <div class="action-grid">${actionsFor(w, sm, ctx)}</div>
        ${w.reviewDate ? `<p class="muted mt" style="font-size:12px">Review date: ${escapeHtml(w.reviewDate)}</p>` : ''}
        ${w.thesis ? `<p class="muted mt" style="font-size:12px">Thesis: ${escapeHtml(w.thesis)}</p>` : ''}
      </div>
    </div>`;
}

export default {
  title: 'Wheels',
  render(ctx) {
    const autoOpen = ctx.route?.params?.open || null;
    let list = ctx.state.wheels.slice();
    if (filters.state !== 'all') list = list.filter((w) => (w.state === 'complete' ? 'complete' : 'open') === filters.state);
    if (filters.mode !== 'all') list = list.filter((w) => w.mode === filters.mode);
    if (filters.sort === 'recent') list.sort((a, b) => String(b.openedAt).localeCompare(String(a.openedAt)));
    else if (filters.sort === 'pnl') list.sort((a, b) => wheelSummary(b).pnl - wheelSummary(a).pnl);
    else list.sort((a, b) => a.ticker.localeCompare(b.ticker));

    const body = list.length ? list.map((w) => wheelCard(w, ctx, w.id === autoOpen)).join('')
      : `<div class="card empty"><span class="empty-ico">◐</span>No wheels match this filter. ${ctx.state.wheels.length ? '' : 'Create one from the Screener or New wheel page.'}</div>`;

    return `
      <div class="card">
        <div class="card-head"><div><h2>Your wheel ledger</h2><p class="muted">Every wheel is event-sourced: each action is a dated trade, and the state machine is derived from that history.</p></div>
          <button class="btn btn-primary" id="wheelsNew">+ New wheel</button></div>
        <div class="row wrap" style="gap:10px">
          <select id="filterState" class="input-sm" style="max-width:160px">
            <option value="all" ${filters.state === 'all' ? 'selected' : ''}>All statuses</option>
            <option value="open" ${filters.state === 'open' ? 'selected' : ''}>Open</option>
            <option value="complete" ${filters.state === 'complete' ? 'selected' : ''}>Closed archive</option>
          </select>
          <select id="filterMode" class="input-sm" style="max-width:140px">
            <option value="all" ${filters.mode === 'all' ? 'selected' : ''}>Paper + Live</option>
            <option value="paper" ${filters.mode === 'paper' ? 'selected' : ''}>Paper</option>
            <option value="live" ${filters.mode === 'live' ? 'selected' : ''}>Live</option>
          </select>
          <select id="filterSort" class="input-sm" style="max-width:160px">
            <option value="recent" ${filters.sort === 'recent' ? 'selected' : ''}>Newest first</option>
            <option value="pnl" ${filters.sort === 'pnl' ? 'selected' : ''}>P&L</option>
            <option value="ticker" ${filters.sort === 'ticker' ? 'selected' : ''}>Ticker</option>
          </select>
        </div>
      </div>
      <div class="mt">${body}</div>`;
  },
  mount(root, ctx) {
    root.querySelector('#wheelsNew')?.addEventListener('click', () => ctx.go('/new'));
    const bind = (id, key) => root.querySelector(id)?.addEventListener('change', (e) => { filters[key] = e.target.value; ctx.reload(); });
    bind('#filterState', 'state');
    bind('#filterMode', 'mode');
    bind('#filterSort', 'sort');

    root.querySelectorAll('[data-wheel-toggle]').forEach((head) => {
      head.onclick = (e) => {
        if (e.target.closest('button,a,input,select')) return;
        const id = head.dataset.wheelToggle;
        if (openIds.has(id)) openIds.delete(id); else openIds.add(id);
        ctx.reload();
      };
    });

    root.querySelectorAll('[data-action]').forEach((b) => {
      b.onclick = () => openAction(ctx, b.dataset.wheel, b.dataset.action);
    });

    // Fetch current option prices + dividends in the background (once per session).
    if (!loadingLegs && ctx.state.wheels.some((w) => w.state !== 'complete')) loadLive(ctx);
  },
};

async function loadLive(ctx) {
  loadingLegs = true;
  const marks = {};
  for (const w of ctx.state.wheels) {
    if (w.state === 'complete') continue;
    const sm = wheelSummary(w);
    if (sm.leg && sm.legKey) {
      if (legCache.has(sm.legKey)) marks[sm.legKey] = legCache.get(sm.legKey);
      else {
        try {
          const res = await ctx.providers.loadOptions(w.ticker, sm.leg.expiry, ctx.auth.token());
          if (res?.status === 'ok') {
            const c = findContract(res.data.rows, { type: sm.leg.type, strike: sm.leg.strike, expiry: sm.leg.expiry });
            const mid = c?.mid ?? c?.bid ?? null;
            if (mid != null) { legCache.set(sm.legKey, mid); marks[sm.legKey] = mid; }
          }
        } catch { /* ignore */ }
      }
    }
    if ((w.state === 'holding' || w.state === 'short_call') && !divCache.has(w.ticker)) {
      try {
        const res = await ctx.providers.loadDividends(w.ticker, ctx.auth.token());
        const ex = res?.data?.next?.exDate || null;
        divCache.set(w.ticker, ex);
      } catch { divCache.set(w.ticker, null); }
    }
  }
  const added = Object.keys(marks).filter((k) => ctx.state.legMarks?.[k] !== marks[k]);
  if (added.length) ctx.actions.setLegMarks(marks);
  loadingLegs = false;
  if (added.length) ctx.reload();
}

function openAction(ctx, wheelId, kind) {
  const w = ctx.state.wheels.find((x) => x.id === wheelId);
  if (!w) return;
  const sm = wheelSummary(w);
  const s = mergeSettings(ctx.state.settings);

  if (kind === 'COVERED_CALL') { ctx.go(`/new?type=call&wheel=${wheelId}`); return; }
  if (kind === 'ROLL_PUT') { ctx.go(`/roll?wheel=${wheelId}&type=put`); return; }
  if (kind === 'ROLL_CALL') { ctx.go(`/roll?wheel=${wheelId}&type=call`); return; }
  if (kind === 'CURRENT_PRICE') {
    openModal(`Current ${sm.leg?.type || 'option'} price for ${w.ticker}`, `
      <p class="muted">Enter the current mid (or bid) of your open ${escapeHtml(sm.leg?.type || 'option')} at strike ${escapeHtml(String(sm.leg?.strike ?? ''))}. This is used to check the 50% profit target. You can read it from IBKR or the Finviz chain.</p>
      ${field({ label: 'Current option price per share', name: 'mid', value: sm.legMid != null ? String(sm.legMid) : '', placeholder: '0.40' })}
      ${sm.leg ? `<p class="muted" style="font-size:12px">Sold at ${money(sm.leg.mid)}. ${sm.captured != null ? `Currently captured ${sm.captured.toFixed(0)}%.` : ''}</p>` : ''}
      <div class="row" style="justify-content:flex-end;gap:8px"><button class="btn btn-primary" data-submit>Save</button></div>`, (body, close) => {
      body.querySelector('[data-submit]').onclick = () => {
        const v = Number(readForm(body).mid);
        if (!(v >= 0) || !sm.legKey) { toast('Enter a valid price.', 'warn'); return; }
        ctx.actions.setLegMarks({ [sm.legKey]: v });
        close();
        toast('Updated — profit target rechecked.');
        ctx.reload();
      };
    });
    return;
  }

  const now = isoNow().slice(0, 16);
  const forms = {
    BUY_PUT_CLOSE: { title: `Buy back ${w.ticker} put`, action: 'BUY_PUT_CLOSE', optionType: 'put', fields: [['price', 'Buy price per share', 'number'], ['executedAt', 'Executed at', 'datetime-local', now], ['fees', 'Fees', 'number', (Number(sm.openPut) * s.commission).toFixed(2)]] },
    BUY_CALL_CLOSE: { title: `Buy back ${w.ticker} call`, action: 'BUY_CALL_CLOSE', optionType: 'call', fields: [['price', 'Buy price per share', 'number'], ['executedAt', 'Executed at', 'datetime-local', now], ['fees', 'Fees', 'number', (Number(sm.openCall) * s.commission).toFixed(2)]] },
    PUT_EXPIRE: { title: `Mark ${w.ticker} put expired`, action: 'PUT_EXPIRE', optionType: 'put', fields: [['executedAt', 'Expiry date/time', 'datetime-local', now]] },
    CALL_EXPIRE: { title: `Mark ${w.ticker} call expired`, action: 'CALL_EXPIRE', optionType: 'call', fields: [['executedAt', 'Expiry date/time', 'datetime-local', now]] },
    PUT_ASSIGN: { title: `Mark ${w.ticker} put assigned`, action: 'PUT_ASSIGN', optionType: 'put', fields: [['strike', 'Assignment price (strike)', 'number', sm.putStrike ?? ''], ['executedAt', 'Assignment date/time', 'datetime-local', now], ['fees', 'Assignment fee', 'number', s.assignmentFee]] },
    CALL_ASSIGN: { title: `Mark ${w.ticker} called away`, action: 'CALL_ASSIGN', optionType: 'call', fields: [['strike', 'Call strike (sale price)', 'number', sm.callStrike ?? ''], ['executedAt', 'Date/time', 'datetime-local', now], ['fees', 'Fees', 'number', '0']] },
    SELL_CALL_OPEN: {
      title: `Sell a covered call on ${w.ticker}`,
      action: 'SELL_CALL_OPEN',
      optionType: 'call',
      fields: [['strike', 'Call strike', 'number', ''], ['expiry', 'Expiry', 'date', ''], ['price', 'Premium per share', 'number', ''], ['contracts', 'Contracts', 'number', Math.max(1, Math.round(sm.shares / 100))], ['executedAt', 'Executed at', 'datetime-local', now], ['fees', 'Fees', 'number', '']],
      validate: (values) => {
        const k = Number(values.strike);
        const basis = sm.costBasis;
        if (basis !== null && k < basis) return `Warning: strike $${k} is below your cost basis $${basis.toFixed(2)}. Only do this with a clear recovery plan.`;
        return null;
      },
    },
    SELL_SHARES: { title: `Sell ${w.ticker} shares at market`, action: 'SELL_SHARES', optionType: 'stock', fields: [['price', 'Sale price per share', 'number', sm.mark ?? ''], ['contracts', 'Shares / 100', 'number', Math.max(1, Math.round(sm.shares / 100))], ['executedAt', 'Executed at', 'datetime-local', now], ['fees', 'Fees', 'number', '']] },
  };

  if (kind === 'DIVIDEND') {
    openModal(`Record a ${w.ticker} dividend`, `
      ${field({ label: 'Ex-dividend date', name: 'exDate', type: 'date', value: todayISO() })}
      ${field({ label: 'Pay date', name: 'payDate', type: 'date', value: todayISO() })}
      ${field({ label: 'Amount per share', name: 'amountPerShare', value: '', placeholder: '0.2775' })}
      ${field({ label: 'Shares', name: 'shares', value: sm.shares || 100 })}
      <div class="row" style="justify-content:flex-end;gap:8px"><button class="btn btn-primary" data-submit>Save dividend</button></div>`, (body, close) => {
      body.querySelector('[data-submit]').onclick = () => {
        const v = readForm(body);
        if (!v.amountPerShare) { toast('Enter the amount per share.', 'warn'); return; }
        ctx.actions.recordDividend(wheelId, v);
        close();
        toast('Dividend recorded.');
      };
    });
    return;
  }

  if (kind === 'REVIEW') {
    openModal(`Set a review date for ${w.ticker}`, `
      ${field({ label: 'Review date', name: 'reviewDate', type: 'date', value: w.reviewDate || todayISO() })}
      <div class="row" style="justify-content:flex-end;gap:8px"><button class="btn btn-primary" data-submit>Save</button></div>`, (body, close) => {
      body.querySelector('[data-submit]').onclick = () => {
        ctx.actions.updateWheel(wheelId, { reviewDate: readForm(body).reviewDate });
        close();
        toast('Review date saved.');
      };
    });
    return;
  }

  if (kind === 'LESSONS' || kind === 'COMPLETE') {
    openModal(`Close ${w.ticker} wheel`, `
      ${field({ label: 'Lessons learned', name: 'lessons', type: 'textarea', value: w.lessons || '', placeholder: 'What would you do differently?' })}
      <p class="muted" style="font-size:12px">Closing archives the wheel. Its trades stay in the ledger for tax/CSV export.</p>
      <div class="row" style="justify-content:flex-end;gap:8px"><button class="btn ${kind === 'COMPLETE' ? 'btn-danger' : 'btn-primary'}" data-submit>Save</button></div>`, (body, close) => {
      body.querySelector('[data-submit]').onclick = async () => {
        const v = readForm(body);
        if (kind === 'COMPLETE' && !(await confirmDialog('Close this wheel? You can still see it in the archive.', { confirmText: 'Close wheel' }))) return;
        ctx.actions.updateWheel(wheelId, { lessons: v.lessons });
        if (kind === 'COMPLETE') ctx.actions.completeWheel(wheelId, v.lessons);
        close();
        toast('Saved.');
      };
    });
    return;
  }

  const def = forms[kind];
  if (!def) return;
  openModal(def.title, `
    ${def.fields.map(([name, label, type, value]) => field({ label, name, type, value: value ?? '' })).join('')}
    <div id="actionWarning"></div>
    <div class="row" style="justify-content:flex-end;gap:8px"><button class="btn btn-primary" data-submit>Save trade</button></div>`, (body, close) => {
    const submit = body.querySelector('[data-submit]');
    submit.onclick = async () => {
      const v = readForm(body);
      if (def.validate) {
        const warning = def.validate(v);
        if (warning) {
          body.querySelector('#actionWarning').innerHTML = `<div class="notice error">${escapeHtml(warning)}</div>`;
          if (!(await confirmDialog(`${warning}\n\nContinue anyway?`, { danger: true, confirmText: 'Continue' }))) return;
        }
      }
      try {
        ctx.actions.addTrade(wheelId, { ...v, action: def.action, optionType: def.optionType });
        close();
        toast('Trade logged.');
      } catch (err) {
        toast(err.message, 'error');
      }
    };
  });
}
