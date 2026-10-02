import { rollMetrics } from '../calc.js';
import { money, pct, escapeHtml } from '../format.js';
import { field, badge, tip } from '../ui.js';

export default {
  title: 'Roll calculator',
  render(ctx) {
    const type = ctx.route?.params?.type || 'put';
    const wheel = ctx.route?.params?.wheel ? ctx.state.wheels.find((w) => w.id === ctx.route.params.wheel) : null;
    const s = ctx.state.settings;
    const prefill = wheel
      ? { contracts: type === 'put' ? 1 : Math.max(1, Math.round((wheel.plan?.contracts || 1))), buyBackPrice: '', sellPrice: '' }
      : { contracts: 1, buyBackPrice: '', sellPrice: '' };

    return `
      <div class="card pad-lg">
        <h2>${tip('Roll calculator', 'Rolling means buying back the option you sold and selling a new one further out in time or at a different strike.')}</h2>
        <p class="muted">Used for both puts and calls. A good roll brings in a net credit — never pay a debit without a clear reason.</p>
        ${wheel ? `<div class="notice info">Rolling ${escapeHtml(wheel.ticker)} ${escapeHtml(type)}${wheel.plan?.strike ? ` at strike $${wheel.plan.strike}` : ''}.</div>` : ''}
        <div class="form-grid">
          ${field({ label: 'Contracts', name: 'contracts', value: prefill.contracts })}
          ${field({ label: 'Commission per contract', name: 'commission', value: s.commission })}
          ${field({ label: 'Cost to buy back (debit)', name: 'buyBackPrice', value: prefill.buyBackPrice, placeholder: '1.20' })}
          ${field({ label: 'Premium received from new option', name: 'sellPrice', value: prefill.sellPrice, placeholder: '1.60' })}
        </div>
        <button class="btn btn-primary" id="rollCalc">Calculate roll</button>
        <div id="rollOut" class="mt"></div>
      </div>`;
  },
  mount(root, ctx) {
    const calc = () => {
      const v = {};
      root.querySelectorAll('input[name]').forEach((el) => { v[el.name] = Number(el.value) || 0; });
      const r = rollMetrics({ contracts: v.contracts, buyBackPrice: v.buyBackPrice, sellPrice: v.sellPrice, commission: v.commission });
      const out = root.querySelector('#rollOut');
      const good = r.verdict === 'good';
      const small = r.verdict === 'small';
      out.innerHTML = `
        <div class="grid grid-3">
          <div class="kv"><span>Cost to close</span><span>${money(r.buyCost)}</span></div>
          <div class="kv"><span>Credit from new option</span><span>${money(r.sellCredit)}</span></div>
          <div class="kv"><span>Net credit / debit</span><span class="${r.netCredit >= 0 ? 'positive' : 'negative'}">${money(r.netCredit)}</span></div>
        </div>
        <div class="notice ${good ? 'info' : 'error'}" style="margin-top:14px">
          ${good ? '✅ Good roll — this brings in a net credit.' : small ? '⚠️ Small credit — consider a further expiry or different strike for a better roll.' : '❌ Debit roll — not recommended. Only do this if you fully accept paying to extend the position.'}
        </div>
        <p class="muted" style="font-size:12px;margin-top:8px">Net credit is after commissions on both legs. Rolling is only worthwhile if it improves your breakeven or buys you meaningful time.</p>`;
    };
    root.querySelector('#rollCalc')?.addEventListener('click', calc);
    calc();
  },
};
