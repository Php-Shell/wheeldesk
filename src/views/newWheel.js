import { putMetrics, validatePutTrade, mergeSettings } from '../calc.js';
import { money, pct, escapeHtml, dte, todayISO, isoNow } from '../format.js';
import { field, toast, tip, badge } from '../ui.js';

let wizard = null;

function reset(prefill = {}, cfg = {}) {
  wizard = {
    step: 0,
    ticker: prefill.symbol || '',
    name: '',
    price: null,
    expiry: prefill.expiry || '',
    strike: prefill.strike || '',
    contracts: 1,
    bid: '',
    ask: '',
    mid: prefill.premium || '',
    delta: prefill.delta || '',
    openInterest: prefill.oi || '',
    mode: 'paper',
    loaded: false,
    loading: false,
    executedAt: isoNow(),
    filledPrice: prefill.premium || '',
    fees: '',
    notes: '',
  };
}

export default {
  title: 'New wheel',
  beforeRender(route) {
    if (!wizard || route?.params?.symbol) {
      reset({ symbol: route?.params?.symbol, expiry: route?.params?.expiry, strike: route?.params?.strike, premium: route?.params?.premium, delta: route?.params?.delta, oi: route?.params?.oi });
    }
  },
  render(ctx) {
    if (!wizard) reset({});
    const s = mergeSettings(ctx.state.settings);
    const step = wizard.step;
    const labels = ['Ticker', 'Strike & expiry', 'Review', 'IBKR instructions', 'Log fill'];
    const stepper = `<div class="stepper">${labels.map((l, i) => `<span class="step ${i === step ? 'active' : ''} ${i < step ? 'done' : ''}"><span class="step-num">${i + 1}</span>${l}</span>`).join('')}</div>`;

    let body = '';
    if (step === 0) {
      const suggestions = ctx.state.watchlist.map((w) => `<button class="chip" data-pick="${w.symbol}">${w.symbol}</button>`).join('');
      body = `
        <div class="card pad-lg">
          <h2>Step 1 · Which ticker?</h2>
          <p class="muted">Only sell puts on a stock or ETF you would be happy to own. Preferably a name that passed the checklist.</p>
          <div class="row" style="gap:10px;flex-wrap:wrap">
            <input id="wTicker" name="ticker" placeholder="Ticker (e.g. KO)" value="${escapeHtml(wizard.ticker)}" style="max-width:220px" />
            <button class="btn btn-secondary" id="wLoad">Load price & info</button>
          </div>
          ${suggestions ? `<div class="chip-row mt">${suggestions}</div>` : ''}
          ${wizard.loaded ? `<div class="notice info" style="margin-top:14px">${escapeHtml(wizard.name || wizard.ticker)} · price ${money(wizard.price)}</div>` : ''}
          ${wizard.loading ? '<p class="muted mt">Loading…</p>' : ''}
        </div>`;
    } else if (step === 1) {
      body = `
        <div class="card pad-lg">
          <h2>Step 2 · Choose expiry and strike</h2>
          <p class="muted">Prefer 30–45 days to expiry and a delta between 0.15 and 0.30. Enter the numbers from your IBKR option chain.</p>
          ${field({ label: 'Expiry date', name: 'expiry', type: 'date', value: wizard.expiry })}
          ${field({ label: 'Contracts', name: 'contracts', type: 'number', min: 1, value: wizard.contracts })}
          <div class="form-grid-3">
            ${field({ label: 'Strike', name: 'strike', value: wizard.strike, placeholder: '60' })}
            ${field({ label: 'Bid', name: 'bid', value: wizard.bid, placeholder: '0.90' })}
            ${field({ label: 'Ask', name: 'ask', value: wizard.ask, placeholder: '1.00' })}
          </div>
          <div class="form-grid">
            ${field({ label: 'Mid / premium', name: 'mid', value: wizard.mid, placeholder: '0.95', hint: 'or leave blank to use bid/ask mid' })}
            ${field({ label: 'Delta', name: 'delta', value: wizard.delta, placeholder: '-0.20' })}
          </div>
          ${field({ label: 'Open interest', name: 'openInterest', value: wizard.openInterest, placeholder: '500' })}
        </div>`;
    } else if (step === 2) {
      const m = metrics();
      const validation = check(ctx);
      body = `
        <div class="card pad-lg">
          <h2>Step 3 · Review the numbers honestly</h2>
          ${!m ? '<p class="error">Enter a strike and a premium to see the calculation.</p>' : `
          <div class="grid grid-2">
            <div>
              <div class="kv"><span>Premium received (net of commission)</span><span>${money(m.netPremium)}</span></div>
              <div class="kv"><span>Collateral required</span><span>${money(m.collateral)}</span></div>
              <div class="kv"><span>Return on collateral</span><span>${pct(m.returnOnCollateral)}</span></div>
              <div class="kv"><span>Annualized return <span class="muted">(estimated)</span></span><span>${m.annualized === null ? '—' : pct(m.annualized)}</span></div>
              <div class="kv"><span>Breakeven price</span><span>${money(m.breakeven)}</span></div>
            </div>
            <div>
              <div class="kv"><span>Distance from current price</span><span>${m.distanceToStrikePct === null ? '—' : `${m.distanceToStrikePct.toFixed(1)}%`}</span></div>
              <div class="kv"><span>Probability of expiring OTM <span class="muted">(estimate)</span></span><span>${m.probabilityOtm === null ? '—' : pct(m.probabilityOtm, 0)}</span></div>
              <div class="kv"><span>Max theoretical loss if stock → $0</span><span class="negative">${money(m.maxLoss)}</span></div>
              <div class="kv"><span>Free cash after this trade</span><span>${money(ctx.account.availableCash - m.collateral)}</span></div>
              <div class="kv"><span>Fees</span><span>${money(m.fees)}</span></div>
            </div>
          </div>
          <div class="notice ${validation.ok ? 'info' : 'error'}" style="margin-top:14px">${validation.ok ? 'All sizing and cash rules pass. This is a valid cash-secured put under your settings.' : escapeHtml(validation.errors.join(' '))}</div>`}
        </div>`;
    } else if (step === 3) {
      const m = metrics();
      body = `
        <div class="card pad-lg">
          <h2>Step 4 · How to place it in IBKR</h2>
          <p class="muted">This app never connects to your broker. Follow these steps manually in Interactive Brokers.</p>
          <ol style="line-height:1.9;padding-left:20px">
            <li>Open the option chain for <b>${escapeHtml(wizard.ticker)}</b>.</li>
            <li>Choose expiry <b>${escapeHtml(wizard.expiry || '—')}</b> → choose the <b>PUT</b> side.</li>
            <li>Find strike <b>${escapeHtml(String(wizard.strike || '—'))}</b> and click the <b>BID</b> to create a SELL order.</li>
            <li>Quantity: <b>${escapeHtml(String(wizard.contracts))}</b> contract(s).</li>
            <li>Order type: <b>LIMIT</b> at about <b>${money(Number(wizard.mid) || 0)}</b> (the mid).</li>
            <li>Double-check it says <b>SELL / SELL TO OPEN</b> and the collateral shown matches <b>${m ? money(m.collateral) : '—'}</b>.</li>
            <li>Transmit the order during regular market hours.</li>
          </ol>
          <div class="notice info">Once filled, continue to log the real fill price so your ledger stays accurate.</div>
        </div>`;
    } else {
      body = `
        <div class="card pad-lg">
          <h2>Step 5 · Log the trade</h2>
          <p class="muted">Log the actual fill so P&L, cost basis and recovery maths are correct.</p>
          <div class="form-grid">
            ${field({ label: 'Executed at', name: 'executedAt', type: 'datetime-local', value: wizard.executedAt.slice(0, 16) })}
            ${field({ label: 'Fill price per share', name: 'filledPrice', value: wizard.filledPrice, placeholder: '0.95' })}
          </div>
          <div class="form-grid">
            ${field({ label: 'Commission (total)', name: 'fees', value: wizard.fees, placeholder: `${(Number(wizard.contracts) * s.commission).toFixed(2)}` })}
            ${field({ label: 'Mode', name: 'mode', options: [{ value: 'paper', label: 'Paper' }, { value: 'live', label: 'Live' }], value: wizard.mode, type: 'text' })}
          </div>
          ${field({ label: 'Notes', name: 'notes', type: 'textarea', value: wizard.notes, placeholder: 'Why this trade?' })}
        </div>`;
    }

    return `${stepper}${body}
      <div class="row-between mt">
        <button class="btn btn-secondary" id="wBack" ${step === 0 ? 'disabled' : ''}>← Back</button>
        ${step < 4 ? `<button class="btn btn-primary" id="wNext">Continue →</button>` : `<button class="btn btn-primary" id="wSave">Save wheel</button>`}
      </div>`;
  },
  mount(root, ctx) {
    if (!wizard) reset({});
    const s = mergeSettings(ctx.state.settings);

    const pick = (sym) => { wizard.ticker = sym.toUpperCase(); ctx.reload(); };
    root.querySelectorAll('[data-pick]').forEach((b) => (b.onclick = () => pick(b.dataset.pick)));

    const load = async () => {
      const input = root.querySelector('#wTicker');
      if (input) wizard.ticker = input.value.toUpperCase();
      if (!wizard.ticker) { toast('Enter a ticker first.', 'warn'); return; }
      if (!ctx.auth.get() && ctx.auth.configured()) {
        toast('Sign in (top-right) to load live data, or continue and enter values manually.', 'warn');
        wizard.name = wizard.ticker;
        wizard.loaded = true;
        ctx.reload();
        return;
      }
      wizard.loading = true;
      ctx.reload();
      try {
        const data = await ctx.providers.loadTickerData(wizard.ticker, ctx.auth.token());
        if (data?.quote?.price != null) {
          wizard.price = data.quote.price;
          wizard.name = data.profile?.name || wizard.ticker;
          if (!wizard.mid && data.quote.price) { /* keep manual */ }
        } else {
          toast(data?.messages?.[0] || 'No live price available; you can continue manually.', 'warn');
          wizard.name = wizard.ticker;
        }
      } catch (err) {
        toast(err.message, 'error');
      }
      wizard.loaded = true;
      wizard.loading = false;
      ctx.reload();
    };
    root.querySelector('#wLoad')?.addEventListener('click', load);
    root.querySelector('#wTicker')?.addEventListener('keydown', (e) => { if (e.key === 'Enter') load(); });

    eachNamed(root, (name, value) => { wizard[name] = value; });

    root.querySelector('#wBack')?.addEventListener('click', () => { wizard.step = Math.max(0, wizard.step - 1); ctx.reload(); });
    root.querySelector('#wNext')?.addEventListener('click', () => {
      sync(root);
      if (wizard.step === 0 && !wizard.ticker) { toast('Choose a ticker.', 'warn'); return; }
      if (wizard.step === 1 && !(Number(wizard.strike) > 0)) { toast('Enter a valid strike.', 'warn'); return; }
      if (wizard.step === 2) {
        const v = check(ctx);
        if (!v.ok) { toast('Fix the issues before continuing.', 'warn'); return; }
      }
      wizard.step = Math.min(4, wizard.step + 1);
      ctx.reload();
    });
    root.querySelector('#wSave')?.addEventListener('click', () => {
      sync(root);
      const v = check(ctx);
      if (!v.ok) { toast(v.errors[0], 'warn'); return; }
      const m = metrics();
      const fees = wizard.fees === '' ? Number(wizard.contracts) * s.commission : Number(wizard.fees);
      const executed = wizard.executedAt?.length === 16 ? new Date(wizard.executedAt).toISOString() : isoNow();
      const wheel = ctx.actions.openWheel({
        ticker: wizard.ticker,
        sector: '',
        mode: wizard.mode,
        thesis: wizard.notes,
        plan: { strike: Number(wizard.strike), expiry: wizard.expiry, contracts: Number(wizard.contracts), premium: Number(wizard.filledPrice || wizard.mid), fees, dte: wizard.expiry ? dte(wizard.expiry) : null, delta: Number(wizard.delta) || null, executedAt: executed, notes: wizard.notes },
      });
      wizard = null;
      toast('Wheel created. Track it under Wheels.');
      ctx.go(wheel ? `/wheels?open=${wheel.id}` : '/wheels');
    });
  },
};

function eachNamed(root, cb) {
  // Bind change handlers for the wizard inputs so values survive step changes.
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

function check(ctx) {
  const s = mergeSettings(ctx.state.settings);
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
