import { putMetrics, callMetrics, validatePutTrade, mergeSettings, findContract } from '../calc.js';
import { money, pct, escapeHtml, dte, todayISO, isoNow, toDMY } from '../format.js';
import { field, toast, tip, badge } from '../ui.js';

let wizard = null;
let lastKey = null;

function prefillFromParams(p = {}) {
  return {
    symbol: p.symbol || '',
    expiry: p.expiry || '',
    strike: p.strike || '',
    premium: p.premium || '',
    delta: p.delta || '',
    oi: p.oi || '',
    kind: p.type === 'call' ? 'call' : 'put',
    wheelId: p.wheel || null,
  };
}

function reset(prefill = {}) {
  wizard = {
    step: 0,
    kind: prefill.kind || 'put',
    wheelId: prefill.wheelId || null,
    ticker: prefill.symbol || '',
    name: '',
    price: null,
    marketCap: null,
    eps: null,
    nextEarnings: null,
    ma200: null,
    costBasis: null,
    shares: null,
    expiry: prefill.expiry || '',
    strike: prefill.strike || '',
    contracts: 1,
    bid: '',
    ask: '',
    mid: prefill.premium || '',
    delta: prefill.delta || '',
    openInterest: prefill.oi || '',
    accountMode: 'paper',
    loaded: false,
    loading: false,
    loadingChain: false,
    chain: null,
    recs: [],
    executedAt: isoNow(),
    filledPrice: prefill.premium || '',
    fees: '',
    notes: '',
  };
}

export default {
  title: 'New wheel',
  beforeRender(route) {
    const p = route?.params || {};
    const key = p.symbol
      ? `${p.symbol}|${p.type || 'put'}|${p.wheel || ''}|${p.strike || ''}|${p.expiry || ''}|${p.premium || ''}`
      : null;
    if (!wizard) { reset(prefillFromParams(p)); lastKey = key; return; }
    if (key && key !== lastKey) { reset(prefillFromParams(p)); lastKey = key; }
  },

  render(ctx) {
    if (!wizard) reset({});
    const s = mergeSettings(ctx.state.settings);
    const step = wizard.step;
    const isCall = wizard.kind === 'call';

    // Pull wheel context for covered calls.
    if (isCall && wizard.wheelId) {
      const w = ctx.state.wheels.find((x) => x.id === wizard.wheelId);
      if (w) {
        wizard.ticker = wizard.ticker || w.ticker;
        wizard.shares = wizard.shares ?? (w.shares || 100);
        if (wizard.costBasis == null) {
          const trades = ctx.state.trades.filter((t) => t.wheelId === w.id);
          const divs = ctx.state.dividends.filter((d) => d.wheelId === w.id);
          wizard.costBasis = wheelCostBasis(w, trades, divs, ctx);
        }
      }
    }

    const labels = isCall
      ? ['Shares', 'Call strike & expiry', 'Review', 'IBKR instructions', 'Log fill']
      : ['Ticker', 'Put strike & expiry', 'Review', 'IBKR instructions', 'Log fill'];
    const stepper = `<div class="stepper">${labels.map((l, i) => `<span class="step ${i === step ? 'active' : ''} ${i < step ? 'done' : ''}"><span class="step-num">${i + 1}</span>${l}</span>`).join('')}</div>`;
    const progress = `<div class="progress" style="height:6px;margin:0 0 18px"><i style="width:${((step + 1) / labels.length) * 100}%"></i></div>`;

    let body = '';
    if (step === 0) body = renderStep0(ctx, isCall);
    else if (step === 1) body = renderStep1(ctx, s, isCall);
    else if (step === 2) body = renderStep2(ctx, s, isCall);
    else if (step === 3) body = renderStep3(ctx, isCall);
    else body = renderStep4(ctx, s);

    return `${stepper}${progress}${body}
      <div class="row-between mt">
        <button class="btn btn-secondary" id="wBack" ${step === 0 ? 'disabled' : ''}>← Back</button>
        ${step < 4 ? `<button class="btn btn-primary" id="wNext">Continue →</button>` : `<button class="btn btn-primary" id="wSave">${isCall ? 'Save covered call' : 'Save wheel'}</button>`}
      </div>`;
  },

  mount(root, ctx) {
    if (!wizard) reset({});
    const s = mergeSettings(ctx.state.settings);
    const isCall = wizard.kind === 'call';

    const pick = (sym) => { if (!isCall) { wizard.ticker = sym.toUpperCase(); ctx.reload(); } };
    root.querySelectorAll('[data-pick]').forEach((b) => (b.onclick = () => pick(b.dataset.pick)));

    const load = async () => {
      const input = root.querySelector('#wTicker');
      if (input && !isCall) wizard.ticker = input.value.toUpperCase();
      if (!wizard.ticker) { toast('Enter a ticker first.', 'warn'); return; }
      wizard.loading = true;
      ctx.reload();
      try {
        const data = await ctx.providers.loadTickerData(wizard.ticker, ctx.auth.token());
        wizard.name = data?.profile?.name || wizard.ticker;
        wizard.price = data?.quote?.price ?? null;
        wizard.marketCap = data?.profile?.marketCap ?? null;
        wizard.eps = data?.metrics?.epsTTMFromQuarters ?? data?.metrics?.epsTTM ?? null;
        wizard.nextEarnings = data?.earnings?.nextDate ?? null;
        wizard.ma200 = data?.ma200 ?? null;
        if (data?.quote?.price == null) toast(data?.messages?.[0] || 'No live price available; continue manually.', 'warn');
      } catch (err) {
        toast(err.message, 'error');
        wizard.name = wizard.ticker;
      }
      wizard.loaded = true;
      wizard.loading = false;
      ctx.reload();
    };
    root.querySelector('#wLoad')?.addEventListener('click', load);
    root.querySelector('#wTicker')?.addEventListener('keydown', (e) => { if (e.key === 'Enter') load(); });

    root.querySelector('#wLoadChain')?.addEventListener('click', () => loadChain(ctx));
    root.querySelectorAll('[data-rec-index]').forEach((b) => {
      b.onclick = () => {
        const r = wizard.recs[Number(b.dataset.recIndex)];
        if (!r) return;
        wizard.strike = r.strike;
        wizard.bid = r.bid ?? '';
        wizard.ask = r.ask ?? '';
        wizard.mid = r.mid ?? r.bid ?? '';
        wizard.delta = r.delta ?? '';
        wizard.openInterest = r.openInterest ?? '';
        wizard.expiry = r.expiry || wizard.expiry;
        ctx.reload();
      };
    });

    eachNamed(root, (name, value) => { wizard[name] = value; updatePreview(ctx); });
    updatePreview(ctx);

    root.querySelector('#wBack')?.addEventListener('click', () => { wizard.step = Math.max(0, wizard.step - 1); ctx.reload(); });
    root.querySelector('#wNext')?.addEventListener('click', () => {
      sync(root);
      if (wizard.step === 0 && !wizard.ticker) { toast('Choose a ticker.', 'warn'); return; }
      if (wizard.step === 1) {
        if (!(Number(wizard.strike) > 0)) { toast('Enter a valid strike.', 'warn'); return; }
        if (wizard.kind === 'call') {
          const maxC = Math.max(1, Math.round((wizard.shares || 100) / 100));
          if (Number(wizard.contracts) > maxC) { toast(`You only have ${wizard.shares} shares (max ${maxC} contract).`, 'warn'); return; }
        }
      }
      if (wizard.step === 2) { const v = check(ctx); if (!v.ok) { toast(v.errors[0], 'warn'); return; } }
      wizard.step = Math.min(4, wizard.step + 1);
      ctx.reload();
    });

    root.querySelector('#wSave')?.addEventListener('click', async () => {
      sync(root);
      const v = check(ctx);
      if (!v.ok) { toast(v.errors[0], 'warn'); return; }
      const fees = wizard.fees === '' ? Number(wizard.contracts) * s.commission : Number(wizard.fees);
      const executed = wizard.executedAt?.length === 16 ? new Date(wizard.executedAt).toISOString() : isoNow();
      const price = Number(wizard.filledPrice || wizard.mid);
      try {
        if (isCall) {
          if (wizard.costBasis != null && Number(wizard.strike) < wizard.costBasis) {
            const ok = await ctx.confirm(`Strike $${wizard.strike} is below your cost basis $${wizard.costBasis.toFixed(2)}. You would lock in a loss if called away. Continue?`, { danger: true, confirmText: 'Continue anyway' });
            if (!ok) return;
          }
          ctx.actions.addTrade(wizard.wheelId, { action: 'SELL_CALL_OPEN', optionType: 'call', strike: Number(wizard.strike), expiry: wizard.expiry, price, contracts: Number(wizard.contracts), fees, executedAt: executed, notes: wizard.notes || 'Covered call from wizard' });
          toast('Covered call logged — Step 2 underway.');
          const id = wizard.wheelId; wizard = null; ctx.go(`/wheels?open=${id}`);
        } else {
          const wheel = ctx.actions.openWheel({
            ticker: wizard.ticker, sector: '', mode: wizard.accountMode, thesis: wizard.notes,
            plan: { strike: Number(wizard.strike), expiry: wizard.expiry, contracts: Number(wizard.contracts), premium: price, fees, dte: wizard.expiry ? dte(wizard.expiry) : null, delta: Number(wizard.delta) || null, executedAt: executed, notes: wizard.notes },
          });
          wizard = null;
          toast('Wheel created. Track it under Wheels.');
          ctx.go(wheel ? `/wheels?open=${wheel.id}` : '/wheels');
        }
      } catch (err) { toast(err.message, 'error'); }
    });
  },
};

// ---- Step renderers -------------------------------------------------------

function renderStep0(ctx, isCall) {
  if (isCall) {
    const w = ctx.state.wheels.find((x) => x.id === wizard.wheelId);
    return `
      <div class="card pad-lg">
        <h2>Step 1 · Your shares (Step 2 of the wheel)</h2>
        <p class="muted">Assignment is not a failure — it is the signal to sell a covered call. You are now being paid to wait to sell the shares at a higher price.</p>
        <div class="grid grid-3 mt">
          <div class="kv"><span>Ticker</span><span>${escapeHtml(wizard.ticker)}</span></div>
          <div class="kv"><span>Shares held</span><span>${wizard.shares ?? '—'}</span></div>
          <div class="kv"><span>Adjusted cost basis</span><span>${wizard.costBasis != null ? money(wizard.costBasis) : '—'}</span></div>
          <div class="kv"><span>Current price</span><span>${wizard.price != null ? money(wizard.price) : (w?.mark != null ? money(w.mark) : '—')}</span></div>
          <div class="kv"><span>Next earnings</span><span>${wizard.nextEarnings ? toDMY(wizard.nextEarnings) : '—'}</span></div>
          <div class="kv"><span>Wheel</span><span>${w ? escapeHtml(w.state) : '—'}</span></div>
        </div>
        <div class="notice info" style="margin-top:12px">Rule: never sell a call below your cost basis unless you accept locking in a loss. The next step will flag it if you do.</div>
      </div>`;
  }
  const suggestions = ctx.state.watchlist.map((w) => `<button class="chip" data-pick="${w.symbol}">${w.symbol}</button>`).join('');
  const loadedInfo = wizard.loaded
    ? `<div class="grid grid-3 mt">
        <div class="kv"><span>Company</span><span>${escapeHtml(wizard.name || wizard.ticker)}</span></div>
        <div class="kv"><span>Price</span><span>${wizard.price != null ? money(wizard.price) : '—'}</span></div>
        <div class="kv"><span>Market cap</span><span>${wizard.marketCap != null ? money(wizard.marketCap, 'USD', 0) : '—'}</span></div>
        <div class="kv"><span>TTM EPS</span><span>${wizard.eps != null ? Number(wizard.eps).toFixed(2) : '—'}</span></div>
        <div class="kv"><span>Next earnings</span><span>${wizard.nextEarnings ? toDMY(wizard.nextEarnings) : '—'}</span></div>
        <div class="kv"><span>200-DMA</span><span>${wizard.ma200 != null ? money(wizard.ma200) : '—'}</span></div>
      </div>`
    : '';
  return `
    <div class="card pad-lg">
      <h2>Step 1 · Which ticker?</h2>
      <p class="muted">Only sell puts on a stock or ETF you would be happy to own. Step 1 of the wheel: you get paid to wait to buy it lower.</p>
      <div class="row" style="gap:10px;flex-wrap:wrap">
        <input id="wTicker" name="ticker" placeholder="Ticker (e.g. KO)" value="${escapeHtml(wizard.ticker)}" style="max-width:220px" />
        <button class="btn btn-secondary" id="wLoad" ${wizard.loading ? 'disabled' : ''}>${wizard.loading ? 'Loading…' : 'Load price & info'}</button>
      </div>
      ${suggestions ? `<div class="chip-row mt">${suggestions}</div>` : ''}
      ${wizard.loading ? `<div class="progress indeterminate" style="height:5px;margin-top:14px"><i></i></div><p class="muted" style="font-size:12px;margin-top:6px">Fetching quote, fundamentals, earnings and 200-day average…</p>` : ''}
      ${loadedInfo}
      <div class="notice info" style="margin-top:14px"><b>The wheel:</b> sell a cash-secured put → if assigned you own 100 shares (not a failure) → sell covered calls → if called away you are back to cash and repeat.</div>
    </div>`;
}

function renderStep1(ctx, s, isCall) {
  const maxColl = ctx.account.budget * s.maxPerWheelPct;
  const affordable = Math.floor(maxColl / 100);
  const info = isCall
    ? `You hold <b>${wizard.shares || 100} shares</b>. Selling calls is covered, so there is no extra collateral.${wizard.costBasis != null ? ` Keep the strike at or above your cost basis <b>${money(wizard.costBasis)}</b> to avoid locking in a loss.` : ''}`
    : `Your per-wheel limit is <b>${money(maxColl)}</b> (${pct(s.maxPerWheelPct * 100, 0)} of ${money(ctx.account.budget)}), so one contract fits strikes up to about <b>$${affordable}</b>.${wizard.price != null ? ` Current price ${money(wizard.price)}.` : ''}`;
  const recs = wizard.recs?.length
    ? `<div class="card-head" style="margin-top:14px"><h4>Recommended ${isCall ? 'calls' : 'puts'} (from the free chain)</h4><span class="muted" style="font-size:12px">Expiry ${escapeHtml(wizard.expiry || '—')} · click Use to fill</span></div>
       <div class="table-wrap"><table class="table"><thead><tr><th>Strike</th><th>Bid</th><th>Ask</th><th>Delta</th><th>OI</th><th></th></tr></thead><tbody>
       ${wizard.recs.map((r, i) => `<tr><td>$${r.strike}</td><td>${r.bid != null ? money(r.bid) : '—'}</td><td>${r.ask != null ? money(r.ask) : '—'}</td><td>${r.delta != null ? r.delta.toFixed(2) : '—'}</td><td>${r.openInterest ?? '—'}</td><td><button class="btn btn-secondary btn-sm" data-rec-index="${i}">Use</button></td></tr>`).join('')}
       </tbody></table></div>`
    : '';
  return `
    <div class="card pad-lg">
      <h2>Step 2 · Choose ${isCall ? 'call strike' : 'strike'} and expiry</h2>
      <p class="muted">Aim for 30–45 DTE and delta 0.15–0.30. Load the free chain for suggestions, or type the numbers from IBKR.</p>
      <div class="notice info">${info}</div>
      <div class="row" style="gap:8px;margin:12px 0">
        <button class="btn btn-primary btn-sm" id="wLoadChain" ${wizard.loadingChain ? 'disabled' : ''}>${wizard.loadingChain ? 'Loading…' : '⤓ Load free chain & recommend'}</button>
        ${wizard.nextEarnings ? `<span class="muted" style="font-size:12px;align-self:center">Avoid expiry after earnings (${toDMY(wizard.nextEarnings)})</span>` : ''}
      </div>
      <div class="form-grid">
        ${field({ label: 'Expiry date', name: 'expiry', type: 'date', value: wizard.expiry })}
        ${field({ label: 'Contracts', name: 'contracts', type: 'number', min: 1, value: wizard.contracts, hint: isCall ? `max ${Math.max(1, Math.round((wizard.shares || 100) / 100))} (one per 100 shares)` : '' })}
      </div>
      <div class="form-grid-3">
        ${field({ label: 'Strike', name: 'strike', value: wizard.strike, placeholder: isCall && wizard.costBasis ? Math.ceil(wizard.costBasis) : '60' })}
        ${field({ label: 'Bid', name: 'bid', value: wizard.bid, placeholder: '0.90' })}
        ${field({ label: 'Ask', name: 'ask', value: wizard.ask, placeholder: '1.00' })}
      </div>
      <div class="form-grid">
        ${field({ label: 'Mid / premium', name: 'mid', value: wizard.mid, placeholder: '0.95', hint: 'or leave blank to use bid/ask mid' })}
        ${field({ label: 'Delta', name: 'delta', value: wizard.delta, placeholder: isCall ? '0.25' : '-0.20' })}
      </div>
      ${field({ label: 'Open interest', name: 'openInterest', value: wizard.openInterest, placeholder: '500' })}
      ${recs}
      <div id="wPreview" class="mt"></div>
    </div>`;
}

function renderStep2(ctx, s, isCall) {
  const m = isCall ? callMetricsFor(ctx) : metrics();
  const validation = check(ctx);
  if (!m) return `<div class="card pad-lg"><h2>Step 3 · Review</h2><p class="error">Enter a strike and a premium to see the calculation.</p></div>`;
  const rows = isCall
    ? [
        ['Premium received (net)', money(m.netPremium)],
        ['Strike (sale price if called away)', money(m.strike)],
        ['Return on shares', pct(m.returnOnCollateral)],
        ['Annualized (est.)', m.annualized == null ? '—' : pct(m.annualized)],
        ['Profit if called away (vs cost basis)', m.calledAwayPnl == null ? '—' : money(m.calledAwayPnl)],
      ]
    : [
        ['Premium received (net)', money(m.netPremium)],
        ['Collateral required', money(m.collateral)],
        ['Return on collateral', pct(m.returnOnCollateral)],
        ['Annualized (est.)', m.annualized == null ? '—' : pct(m.annualized)],
        ['Breakeven price', money(m.breakeven)],
      ];
  const rows2 = isCall
    ? [
        ['Distance from current price', m.distanceToStrikePct == null ? '—' : `${m.distanceToStrikePct.toFixed(1)}%`],
        ['Probability OTM (est.)', m.probabilityOtm == null ? '—' : pct(m.probabilityOtm, 0)],
        ['Fees', money(m.fees)],
      ]
    : [
        ['Distance from current price', m.distanceToStrikePct == null ? '—' : `${m.distanceToStrikePct.toFixed(1)}%`],
        ['Probability OTM (est.)', m.probabilityOtm == null ? '—' : pct(m.probabilityOtm, 0)],
        ['Max theoretical loss if stock → $0', money(m.maxLoss)],
        ['Free cash after this trade', money(ctx.account.availableCash - m.collateral)],
        ['Fees', money(m.fees)],
      ];
  return `
    <div class="card pad-lg">
      <h2>Step 3 · Review the numbers honestly</h2>
      <div class="grid grid-2">
        <div>${rows.map(([k, v]) => `<div class="kv"><span>${k}</span><span>${v}</span></div>`).join('')}</div>
        <div>${rows2.map(([k, v]) => `<div class="kv"><span>${k}</span><span>${v}</span></div>`).join('')}</div>
      </div>
      ${isCall && wizard.costBasis != null && Number(wizard.strike) < wizard.costBasis ? `<div class="notice error" style="margin-top:14px">Strike ${money(Number(wizard.strike))} is below your cost basis ${money(wizard.costBasis)} — if called away you lock in a loss.</div>` : ''}
      <div class="notice ${validation.ok ? 'info' : 'error'}" style="margin-top:14px">${validation.ok ? (isCall ? 'Valid covered call under your settings.' : 'All sizing and cash rules pass. This is a valid cash-secured put.') : escapeHtml(validation.errors.join(' '))}</div>
    </div>`;
}

function renderStep3(ctx, isCall) {
  const m = isCall ? callMetricsFor(ctx) : metrics();
  return `
    <div class="card pad-lg">
      <h2>Step 4 · How to place it in IBKR</h2>
      <p class="muted">This app never connects to your broker. Follow these steps manually in Interactive Brokers.</p>
      <ol style="line-height:1.9;padding-left:20px">
        <li>Open the option chain for <b>${escapeHtml(wizard.ticker)}</b>.</li>
        <li>Choose expiry <b>${escapeHtml(wizard.expiry || '—')}</b> → choose the <b>${isCall ? 'CALL' : 'PUT'}</b> side.</li>
        <li>Find strike <b>${escapeHtml(String(wizard.strike || '—'))}</b> and click the <b>BID</b> to create a SELL order.</li>
        <li>Quantity: <b>${escapeHtml(String(wizard.contracts))}</b> contract(s)${isCall ? ` (you hold ${wizard.shares || 100} shares)` : ''}.</li>
        <li>Order type: <b>LIMIT</b> at about <b>${money(Number(wizard.mid) || 0)}</b> (the mid).</li>
        <li>Verify it says <b>SELL / SELL TO OPEN</b>${isCall ? ' and that your shares are covered' : ` and the collateral matches ${m ? money(m.collateral) : '—'}`}.</li>
        <li>Transmit during regular market hours. Then log the real fill.</li>
      </ol>
      ${isCall ? '<div class="notice warn">Watch the ex-dividend date: if the call is in the money and its remaining time value is less than the dividend, early assignment is more likely.</div>' : ''}
    </div>`;
}

function renderStep4(ctx, s) {
  return `
    <div class="card pad-lg">
      <h2>Step 5 · Log the trade</h2>
      <p class="muted">Log the actual fill so P&L, cost basis and recovery maths are correct.</p>
      <div class="form-grid">
        ${field({ label: 'Executed at', name: 'executedAt', type: 'datetime-local', value: wizard.executedAt.slice(0, 16) })}
        ${field({ label: 'Fill price per share', name: 'filledPrice', value: wizard.filledPrice, placeholder: '0.95' })}
      </div>
      <div class="form-grid">
        ${field({ label: 'Commission (total)', name: 'fees', value: wizard.fees, placeholder: `${(Number(wizard.contracts) * s.commission).toFixed(2)}` })}
        ${field({ label: 'Mode', name: 'accountMode', options: [{ value: 'paper', label: 'Paper' }, { value: 'live', label: 'Live' }], value: wizard.accountMode, type: 'text' })}
      </div>
      ${field({ label: 'Notes', name: 'notes', type: 'textarea', value: wizard.notes, placeholder: 'Why this trade?' })}
    </div>`;
}

// ---- Helpers --------------------------------------------------------------

function eachNamed(root, cb) {
  root.querySelectorAll('input[name], select[name], textarea[name]').forEach((el) => {
    el.onchange = () => cb(el.name, el.type === 'checkbox' ? el.checked : el.value);
    if (el.type !== 'date' && el.type !== 'datetime-local') el.oninput = () => cb(el.name, el.value);
  });
}

function sync(root) {
  root.querySelectorAll('input[name], select[name], textarea[name]').forEach((el) => {
    wizard[el.name] = el.type === 'checkbox' ? el.checked : el.value;
  });
}

function metrics() {
  if (!wizard) return null;
  return putMetrics({
    strike: Number(wizard.strike),
    mid: wizard.mid === '' ? null : Number(wizard.mid),
    bid: wizard.bid === '' ? null : Number(wizard.bid),
    ask: wizard.ask === '' ? null : Number(wizard.ask),
    contracts: Number(wizard.contracts) || 1,
    daysToExpiry: wizard.expiry ? dte(wizard.expiry) : null,
    delta: wizard.delta === '' ? null : Number(wizard.delta),
    stockPrice: wizard.price,
  });
}

function callMetricsFor(ctx) {
  if (!wizard) return null;
  return callMetrics({
    strike: Number(wizard.strike),
    mid: wizard.mid === '' ? null : Number(wizard.mid),
    bid: wizard.bid === '' ? null : Number(wizard.bid),
    ask: wizard.ask === '' ? null : Number(wizard.ask),
    contracts: Number(wizard.contracts) || 1,
    daysToExpiry: wizard.expiry ? dte(wizard.expiry) : null,
    delta: wizard.delta === '' ? null : Number(wizard.delta),
    stockPrice: wizard.price,
    costBasis: wizard.costBasis,
    commission: mergeSettings(ctx.state.settings).commission,
  });
}

function wheelCostBasis(w, trades, dividends, ctx) {
  // Cost basis without importing the whole store summary: assignment price minus credits.
  const premiums = trades.reduce((a, t) => a + (Number(t.cashFlow) || 0), 0);
  const div = dividends.reduce((a, d) => a + Number(d.amountPerShare || 0) * Number(d.shares || 0), 0);
  const fees = trades.reduce((a, t) => a + (Number(t.fees) || 0), 0);
  const shares = Math.max(100, Number(w.shares) || 100);
  const basis = Number(w.assignedPrice) || Number(w.plan?.strike) || 0;
  return (basis * shares + 0) / shares - (premiums - div - fees) / shares;
}

function updatePreview(ctx) {
  const host = document.getElementById('wPreview');
  if (!host || !wizard || wizard.step !== 1) return;
  const s = mergeSettings(ctx.state.settings);
  const isCall = wizard.kind === 'call';
  const m = isCall ? callMetricsFor(ctx) : metrics();
  const maxColl = ctx.account.budget * s.maxPerWheelPct;
  if (!m) {
    host.innerHTML = '<p class="muted" style="font-size:12.5px">Enter a strike and a premium (mid, or bid/ask) to see the live calculation.</p>';
    return;
  }
  const feasible = isCall ? true : m.collateral <= maxColl && m.collateral <= ctx.account.availableCash;
  const belowBasis = isCall && wizard.costBasis != null && Number(wizard.strike) < wizard.costBasis;
  host.innerHTML = `<div class="next-step ${feasible && !belowBasis ? '' : 'warn'}">
    <b>Live preview</b>
    <div class="grid grid-3" style="margin-top:8px">
      <div class="kv"><span>Net premium</span><span>${money(m.netPremium)}</span></div>
      ${isCall ? '' : `<div class="kv"><span>Collateral</span><span>${money(m.collateral)}</span></div>`}
      <div class="kv"><span>Return</span><span>${pct(m.returnOnCollateral)}</span></div>
      <div class="kv"><span>Annualized (est.)</span><span>${m.annualized == null ? '—' : pct(m.annualized)}</span></div>
      ${isCall ? `<div class="kv"><span>If called away</span><span>${m.calledAwayPnl == null ? '—' : money(m.calledAwayPnl)}</span></div>` : `<div class="kv"><span>Breakeven</span><span>${money(m.breakeven)}</span></div>`}
      <div class="kv"><span>Prob. OTM (est.)</span><span>${m.probabilityOtm == null ? '—' : pct(m.probabilityOtm, 0)}</span></div>
    </div>
    <div class="muted" style="font-size:12px;margin-top:6px">${belowBasis ? '⚠︎ Strike is below your cost basis.' : feasible ? (isCall ? 'Covered — no extra collateral.' : 'Within your per-wheel limit and available cash.') : `⚠︎ Exceeds your per-wheel limit (${money(maxColl)}) or available cash.`}</div>
  </div>`;
}

function recommend(chain, expiry, kind, ctx, costBasis) {
  const s = mergeSettings(ctx.state.settings);
  const maxColl = ctx.account.budget * s.maxPerWheelPct;
  const band = [s.deltaMin, s.deltaMax];
  const mid = (band[0] + band[1]) / 2;
  const rows = (chain.rows || []).filter((r) => r.type === kind && r.expiry === expiry && r.strike && (r.bid > 0 || r.mid > 0) && r.delta != null);
  const graded = rows.filter((r) => {
    const a = Math.abs(r.delta);
    if (a < band[0] - 0.03 || a > band[1] + 0.03) return false;
    if (kind === 'put' && r.strike * 100 > maxColl) return false;
    return true;
  });
  const withOi = graded.filter((r) => (Number(r.openInterest) || 0) > 0);
  const pool = withOi.length ? withOi : graded;
  pool.sort((a, b) => Math.abs(Math.abs(a.delta) - mid) - Math.abs(Math.abs(b.delta) - mid));
  let list = pool.slice(0, 8);
  if (kind === 'call' && costBasis != null) {
    // Prefer strikes at/above cost basis, but still show the closest ones.
    list = list.sort((a, b) => (a.strike >= costBasis ? 0 : 1) - (b.strike >= costBasis ? 0 : 1) || a.strike - b.strike);
  }
  return list;
}

function pickExpiry(expirations, rows, nextEarnings) {
  const scored = expirations.map((e) => ({ e, d: dte(e) })).filter((x) => x.d != null && x.d > 0);
  if (!scored.length) return expirations[0] || '';
  let candidates = scored;
  if (nextEarnings && /^\d{4}-\d{2}-\d{2}$/.test(nextEarnings)) {
    const before = scored.filter((x) => x.e < nextEarnings);
    if (before.length) candidates = before;
  }
  const preferred = candidates.filter((x) => x.d >= 25 && x.d <= 55);
  const pool = preferred.length ? preferred : candidates;
  if (Array.isArray(rows) && rows.length) {
    const oi = new Map();
    for (const r of rows) {
      if (r.delta == null) continue;
      const a = Math.abs(r.delta);
      if (a < 0.05 || a > 0.6) continue;
      oi.set(r.expiry, (oi.get(r.expiry) || 0) + (Number(r.openInterest) || 0));
    }
    if ([...oi.values()].some((v) => v > 0)) pool.sort((a, b) => (oi.get(b.e) || 0) - (oi.get(a.e) || 0) || Math.abs(a.d - 40) - Math.abs(b.d - 40));
    else pool.sort((a, b) => Math.abs(a.d - 40) - Math.abs(b.d - 40));
  } else pool.sort((a, b) => Math.abs(a.d - 40) - Math.abs(b.d - 40));
  return pool[0].e;
}

async function loadChain(ctx) {
  const isCall = wizard.kind === 'call';
  wizard.loadingChain = true;
  ctx.reload();
  try {
    const res = await ctx.providers.loadOptions(wizard.ticker, '', ctx.auth.token());
    if (res?.status === 'ok' && res.data?.rows?.length) {
      wizard.chain = res.data;
      if (!wizard.price && res.data.underlying?.price != null) wizard.price = res.data.underlying.price;
      wizard.expiry = wizard.expiry || pickExpiry(res.data.expirations, res.data.rows, wizard.nextEarnings);
      wizard.recs = recommend(res.data, wizard.expiry, isCall ? 'call' : 'put', ctx, wizard.costBasis);
      if (!wizard.recs.length) toast('No strikes matched your delta/affordability filters — adjust manually.', 'warn');
    } else {
      toast(res?.message || 'No free chain available — enter values manually.', 'warn');
    }
  } catch (err) {
    toast(`Chain fetch failed: ${err.message}`, 'error');
  }
  wizard.loadingChain = false;
  ctx.reload();
}

function check(ctx) {
  const s = mergeSettings(ctx.state.settings);
  if (wizard.kind === 'call') {
    const errors = [];
    if (!(Number(wizard.strike) > 0)) errors.push('Strike must be greater than 0.');
    if (!(Number(wizard.mid) > 0 || Number(wizard.bid) > 0)) errors.push('Enter a premium (mid or bid).');
    if (!Number.isInteger(Number(wizard.contracts)) || Number(wizard.contracts) < 1) errors.push('Contracts must be a whole number ≥ 1.');
    if (wizard.expiry && !(dte(wizard.expiry) > 0)) errors.push('Expiry must be after today.');
    return { ok: errors.length === 0, errors };
  }
  const m = metrics();
  if (!m) return { ok: false, errors: ['Enter a strike and a premium (mid or bid/ask).'] };
  return validatePutTrade({
    contracts: Number(wizard.contracts),
    strike: Number(wizard.strike),
    price: m.price,
    daysToExpiry: wizard.expiry ? dte(wizard.expiry) : null,
    availableCash: ctx.account.availableCash,
    maxPerWheel: ctx.account.budget * s.maxPerWheelPct,
  });
}
