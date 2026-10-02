import { rollMetrics, findContract, putMetrics, callMetrics, mergeSettings } from '../calc.js';
import { wheelSummary } from '../store.js';
import { money, pct, escapeHtml, dte, toDMY, isoNow } from '../format.js';
import { field, badge, tip, toast } from '../ui.js';

let rstate = null;
let lastWheel = null;

function ensureState(ctx) {
  const wheelId = ctx.route?.params?.wheel || null;
  const type = ctx.route?.params?.type === 'call' ? 'call' : 'put';
  if (!rstate || lastWheel !== `${wheelId}|${type}`) {
    lastWheel = `${wheelId}|${type}`;
    const w = wheelId ? ctx.state.wheels.find((x) => x.id === wheelId) : null;
    const sm = w ? wheelSummary(w) : null;
    rstate = {
      wheelId,
      type,
      ticker: w?.ticker || '',
      contracts: sm?.openPut || sm?.openCall || 1,
      commission: mergeSettings(ctx.state.settings).commission,
      oldStrike: sm?.leg?.strike ?? (type === 'put' ? sm?.putStrike : sm?.callStrike) ?? '',
      oldExpiry: sm?.leg?.expiry ?? (type === 'put' ? sm?.putExpiry : sm?.callExpiry) ?? '',
      buyBack: sm?.legMid != null ? String(sm.legMid) : '',
      sellPrice: '',
      newStrike: '',
      newExpiry: '',
      chain: null,
      loading: false,
      recs: [],
    };
  }
  return rstate;
}

export default {
  title: 'Roll calculator',
  render(ctx) {
    const st = ensureState(ctx);
    const m = st.buyBack !== '' && st.sellPrice !== '' ? rollMetrics({ contracts: st.contracts, buyBackPrice: Number(st.buyBack), sellPrice: Number(st.sellPrice), commission: st.commission }) : null;
    const w = st.wheelId ? ctx.state.wheels.find((x) => x.id === st.wheelId) : null;

    const result = m ? `
      <div class="grid grid-3 mt">
        <div class="kv"><span>Cost to close</span><span>${money(m.buyCost)}</span></div>
        <div class="kv"><span>Credit from new option</span><span>${money(m.sellCredit)}</span></div>
        <div class="kv"><span>Net credit / debit</span><span class="${m.netCredit >= 0 ? 'positive' : 'negative'}">${money(m.netCredit)}</span></div>
      </div>
      <div class="notice ${m.verdict === 'good' ? 'info' : 'error'}" style="margin-top:14px">
        ${m.verdict === 'good' ? '✅ Good roll — net credit. This buys time and lowers your breakeven.' : m.verdict === 'small' ? '⚠️ Small credit — consider a further expiry or different strike.' : '❌ Debit roll — not recommended. Only roll for a credit unless you have a written reason.'}
      </div>` : '';

    const recs = st.recs.length ? `
      <div class="card-head" style="margin-top:14px"><h4>Roll suggestions (from the free chain)</h4><span class="muted" style="font-size:12px">Net credit after fees · click Use</span></div>
      <div class="table-wrap"><table class="table"><thead><tr><th>New strike</th><th>New expiry</th><th>DTE</th><th>Credit</th><th class="num">Net credit</th><th></th></tr></thead><tbody>
      ${st.recs.map((r, i) => `<tr>
        <td>$${r.strike}${r.belowCurrent ? ' ↓' : ''}</td><td>${toDMY(r.expiry)}</td><td>${r.dte}</td><td>${money(r.bid)}</td>
        <td class="num ${r.netCredit >= 0 ? 'positive' : 'negative'}">${money(r.netCredit)}</td>
        <td><button class="btn btn-secondary btn-sm" data-roll-use="${i}">Use</button></td>
      </tr>`).join('')}
      </tbody></table></div>` : '';

    return `
      <div class="card pad-lg">
        <h2>${tip('Roll calculator', 'Rolling means buying back the option you sold and selling a new one further out in time (and sometimes at a different strike). Do it for a net credit when possible.')}</h2>
        <p class="muted">Buy back the current option and sell a later one. A good roll brings in a net credit and buys time; a debit roll is not recommended.</p>
        ${w ? `<div class="notice info">Rolling <b>${escapeHtml(st.ticker)}</b> ${escapeHtml(st.type)}${st.oldStrike ? ` — currently short $${st.oldStrike} ${st.oldExpiry ? `exp ${toDMY(st.oldExpiry)}` : ''}` : ''}.</div>` : ''}
        <div class="row" style="gap:8px;margin:12px 0">
          ${w ? `<button class="btn btn-primary btn-sm" id="rollLoad" ${st.loading ? 'disabled' : ''}>${st.loading ? 'Loading…' : '⤓ Load chain & suggest rolls'}</button>` : ''}
          ${st.oldStrike ? `<span class="muted" style="font-size:12px;align-self:center">Old: $${st.oldStrike} ${st.oldExpiry ? `· ${toDMY(st.oldExpiry)}` : ''}</span>` : ''}
        </div>
        <div class="form-grid">
          ${field({ label: 'Contracts', name: 'contracts', value: st.contracts })}
          ${field({ label: 'Commission per contract', name: 'commission', value: st.commission })}
          ${field({ label: 'Cost to buy back (debit)', name: 'buyBack', value: st.buyBack, placeholder: '1.20' })}
          ${field({ label: 'Premium received from new option', name: 'sellPrice', value: st.sellPrice, placeholder: '1.60' })}
          ${field({ label: 'New strike', name: 'newStrike', value: st.newStrike, placeholder: st.type === 'put' ? '45' : '50' })}
          ${field({ label: 'New expiry', name: 'newExpiry', type: 'date', value: st.newExpiry })}
        </div>
        ${recs}
        <div id="rollOut">${result}</div>
        ${w ? `<div class="row" style="justify-content:flex-end;gap:8px;margin-top:14px"><button class="btn btn-primary" id="rollLog">Log this roll</button></div>` : ''}
      </div>`;
  },
  mount(root, ctx) {
    const st = ensureState(ctx);
    const s = mergeSettings(ctx.state.settings);

    root.querySelectorAll('input[name]').forEach((el) => {
      el.oninput = () => { st[el.name] = el.value; };
    });
    const calc = () => {
      const v = {};
      root.querySelectorAll('input[name]').forEach((el) => { v[el.name] = el.value; });
      st.contracts = v.contracts; st.commission = Number(v.commission) || s.commission;
      st.buyBack = v.buyBack; st.sellPrice = v.sellPrice; st.newStrike = v.newStrike; st.newExpiry = v.newExpiry;
      ctx.reload();
    };
    root.querySelectorAll('input[name]').forEach((el) => el.addEventListener('change', calc));

    root.querySelector('#rollLoad')?.addEventListener('click', () => loadChain(ctx));
    root.querySelectorAll('[data-roll-use]').forEach((b) => {
      b.onclick = () => {
        const r = st.recs[Number(b.dataset.rollUse)];
        if (!r) return;
        st.newStrike = r.strike; st.newExpiry = r.expiry; st.sellPrice = r.bid;
        if (!st.buyBack) st.buyBack = r.buyBack ?? st.buyBack;
        ctx.reload();
      };
    });

    root.querySelector('#rollLog')?.addEventListener('click', async () => {
      const w = ctx.state.wheels.find((x) => x.id === st.wheelId);
      if (!w) return;
      if (!(Number(st.buyBack) >= 0) || !(Number(st.sellPrice) > 0)) { toast('Enter the buy-back cost and new premium.', 'warn'); return; }
      const m = rollMetrics({ contracts: Number(st.contracts) || 1, buyBackPrice: Number(st.buyBack), sellPrice: Number(st.sellPrice), commission: st.commission });
      if (m.netCredit < 0 && !(await ctx.confirm('This roll is a DEBIT (you pay to extend). Log it anyway?', { danger: true, confirmText: 'Log debit roll' }))) return;
      const contracts = Number(st.contracts) || 1;
      const fees = contracts * st.commission;
      const now = isoNow();
      const closeAction = st.type === 'call' ? 'BUY_CALL_CLOSE' : 'BUY_PUT_CLOSE';
      const openAction = st.type === 'call' ? 'SELL_CALL_OPEN' : 'SELL_PUT_OPEN';
      try {
        if (st.oldStrike) ctx.actions.addTrade(st.wheelId, { action: closeAction, optionType: st.type, strike: Number(st.oldStrike), expiry: st.oldExpiry || null, price: Number(st.buyBack), contracts, fees, executedAt: now, notes: 'Roll — buy back' });
        ctx.actions.addTrade(st.wheelId, { action: openAction, optionType: st.type, strike: Number(st.newStrike) || Number(st.oldStrike), expiry: st.newExpiry || null, price: Number(st.sellPrice), contracts, fees, executedAt: now, notes: 'Roll — sell new' });
        toast('Roll logged.');
        ctx.go(`/wheels?open=${st.wheelId}`);
      } catch (err) { toast(err.message, 'error'); }
    });
  },
};

async function loadChain(ctx) {
  const st = rstate;
  st.loading = true;
  ctx.reload();
  try {
    const res = await ctx.providers.loadOptions(st.ticker, '', ctx.auth.token());
    if (res?.status === 'ok' && res.data?.rows?.length) {
      st.chain = res.data;
      const cur = findContract(res.data.rows, { type: st.type, strike: Number(st.oldStrike), expiry: st.oldExpiry });
      if (cur?.mid != null && !st.buyBack) st.buyBack = String(cur.mid);
      if (!st.buyBack && st.oldStrike) st.buyBack = '0';
      st.recs = suggestRolls(res.data, st, ctx);
      if (!st.recs.length) toast('No roll candidates matched — adjust the new strike/expiry manually.', 'warn');
    } else {
      toast(res?.message || 'No free chain — enter values from IBKR.', 'warn');
    }
  } catch (err) {
    toast(`Chain fetch failed: ${err.message}`, 'error');
  }
  st.loading = false;
  ctx.reload();
}

function suggestRolls(chain, st, ctx) {
  const oldExpiry = st.oldExpiry;
  const buyBack = Number(st.buyBack) || 0;
  const oldK = Number(st.oldStrike) || null;
  const all = [];
  for (const r of chain.rows) {
    if (r.type !== st.type) continue;
    if (oldExpiry && r.expiry <= oldExpiry) continue; // roll further out
    const d = dte(r.expiry);
    if (d == null || d < 20 || d > 75) continue;
    if (!(r.bid > 0)) continue;
    if (oldK) {
      const k = Number(r.strike);
      // Roll a put out and DOWN (never up = more risk); roll a call out and UP.
      if (st.type === 'put' && (k > oldK || k < oldK * 0.6)) continue;
      if (st.type === 'call' && (k < oldK || k > oldK * 1.4)) continue;
    }
    const close = buyBack * 100 * st.contracts + st.contracts * st.commission;
    const open = r.bid * 100 * st.contracts - st.contracts * st.commission;
    const netCredit = Math.round((open - close) * 100) / 100;
    all.push({ strike: r.strike, expiry: r.expiry, dte: d, bid: r.bid, netCredit, oi: Number(r.openInterest) || 0, belowCurrent: oldK && Number(r.strike) < oldK });
  }
  const liquid = all.filter((x) => x.oi > 0);
  const pool = liquid.length ? liquid : all;
  const positive = pool.filter((x) => x.netCredit >= 0);
  const list = positive.length ? positive : pool;
  list.sort((a, b) => b.netCredit - a.netCredit);
  return list.slice(0, 8);
}
