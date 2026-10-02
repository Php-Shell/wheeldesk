import { wheelSummary, deriveAccount } from '../store.js';
import { recoveryScenario, callCandidateAnalysis, adjustedCostBasis, mergeSettings } from '../calc.js';
import { money, pct, escapeHtml, dte, todayISO } from '../format.js';
import { badge, tip, field, toast, openModal, readForm } from '../ui.js';

let state = null;

function loadFor(wheelId, ctx) {
  const w = ctx.state.wheels.find((x) => x.id === wheelId);
  if (!w) return null;
  const sm = wheelSummary(w);
  const candidates = w.recoveryPlan?.candidates?.length ? w.recoveryPlan.candidates : [{ strike: '', bid: '', dte: '' }];
  return {
    wheelId,
    ticker: w.ticker,
    assignmentPrice: w.assignedPrice ?? sm.putStrike ?? '',
    shares: sm.shares || 100,
    premiums: sm.premiums,
    fees: sm.fees,
    dividends: sm.dividends,
    currentPrice: sm.mark ?? '',
    thesisBroken: w.recoveryPlan?.thesisBroken || false,
    waitMonths: w.recoveryPlan?.waitMonths || 3,
    candidates,
  };
}

export default {
  title: 'Assignment & recovery',
  beforeRender(route) {
    if (route?.params?.wheel) state = null;
  },
  render(ctx) {
    const eligible = ctx.state.wheels.filter((w) => ['holding', 'short_call', 'short_put'].includes(w.state));
    const selectedId = ctx.route?.params?.wheel || state?.wheelId || eligible[0]?.id || '';
    if (!state || state.wheelId !== selectedId) state = loadFor(selectedId, ctx);

    if (!ctx.state.wheels.length) {
      return `<div class="card empty"><span class="empty-ico">⛑</span>No wheels yet. The recovery assistant opens when you are holding shares after an assignment.</div>`;
    }
    if (!state) {
      return `<div class="card"><h2>Assignment & recovery assistant</h2><p class="muted">Choose a wheel to analyse.</p>
        <select id="recWheel">${ctx.state.wheels.map((w) => `<option value="${w.id}">${escapeHtml(w.ticker)} · ${escapeHtml(w.state)}</option>`).join('')}</select></div>`;
    }

    const st = state;
    const s = mergeSettings(ctx.state.settings);
    const costBasis = adjustedCostBasis({ assignmentPrice: Number(st.assignmentPrice) || 0, premiums: Number(st.premiums) || 0, fees: Number(st.fees) || 0, dividends: Number(st.dividends) || 0, shares: Number(st.shares) || 100 });
    const price = st.currentPrice === '' ? null : Number(st.currentPrice);
    const scenario = recoveryScenario({ costBasis, currentPrice: price, thesisBroken: st.thesisBroken, settings: s });
    const loss = costBasis !== null && price !== null ? (price - costBasis) * Number(st.shares) : null;
    const lossPct = costBasis ? ((price - costBasis) / costBasis) * 100 : null;

    const candidateRows = st.candidates.map((c, i) => {
      const analysis = callCandidateAnalysis({ strike: Number(c.strike), bid: Number(c.bid), daysToExpiry: Number(c.dte), costBasis, currentPrice: price, commission: s.commission, shares: Number(st.shares) || 100 });
      return `<tr>
        <td><input class="input-sm" style="width:80px" data-rec-cand="${i}" data-k="strike" value="${escapeHtml(c.strike)}" placeholder="50" /></td>
        <td><input class="input-sm" style="width:80px" data-rec-cand="${i}" data-k="bid" value="${escapeHtml(c.bid)}" placeholder="0.80" /></td>
        <td><input class="input-sm" style="width:70px" data-rec-cand="${i}" data-k="dte" value="${escapeHtml(c.dte)}" placeholder="35" /></td>
        <td class="num">${analysis ? money(analysis.netPremium) : '—'}</td>
        <td class="num">${analysis ? pct(analysis.annualized) : '—'}</td>
        <td class="num ${analysis && analysis.calledAwayPnl < 0 ? 'negative' : 'positive'}">${analysis ? money(analysis.calledAwayPnl) : '—'}</td>
        <td class="num">${analysis?.recoveryMonths != null ? `${analysis.recoveryMonths.toFixed(1)} mo` : '—'}</td>
        <td>${analysis ? badge(analysis.atOrAboveBasis ? 'pass' : 'warn', analysis.atOrAboveBasis ? 'At/above basis' : 'Below basis') : ''}</td>
      </tr>`;
    }).join('');

    const recText = {
      A: 'Sell a covered call at or above your cost basis, 30–45 DTE, delta ~0.20–0.35.',
      B: 'Sell calls at your cost basis even if premium is small, or use 45–60 DTE for more premium.',
      C: 'Compare patient repair (small premiums), a small controlled loss, or holding without calls.',
      D: 'Honestly compare cutting the loss with patient repair. Never feel pressured to hold a loser.',
    }[scenario.key] || '';

    return `
      <div class="card">
        <div class="card-head"><div><h2>${tip('Assignment & recovery assistant', 'A calm, step-by-step plan for when you are holding shares below your cost basis.')}</h2>
          <p class="muted">All numbers are estimates. The decision is always yours.</p></div>
          <select id="recWheel" class="input-sm" style="max-width:220px">${ctx.state.wheels.map((w) => `<option value="${w.id}" ${w.id === st.wheelId ? 'selected' : ''}>${escapeHtml(w.ticker)} · ${escapeHtml(w.state)}</option>`).join('')}</select>
        </div>

        <div class="grid grid-3">
          ${field({ label: 'Assignment price / strike', name: 'assignmentPrice', value: st.assignmentPrice })}
          ${field({ label: 'Shares held', name: 'shares', value: st.shares })}
          ${field({ label: 'Current stock price', name: 'currentPrice', value: st.currentPrice, placeholder: 'from your broker' })}
          ${field({ label: 'Total premiums collected', name: 'premiums', value: st.premiums })}
          ${field({ label: 'Total fees paid', name: 'fees', value: st.fees })}
          ${field({ label: 'Total dividends received', name: 'dividends', value: st.dividends })}
        </div>
        <div class="grid grid-2">
          ${field({ label: 'Do you still believe in this company?', name: 'thesis', type: 'select', value: st.thesisBroken ? 'broken' : 'yes', options: [{ value: 'yes', label: 'Yes, thesis intact' }, { value: 'unsure', label: 'Unsure' }, { value: 'broken', label: 'No — thesis broken' }] })}
          ${field({ label: 'Time willing to wait (months)', name: 'waitMonths', value: st.waitMonths })}
        </div>
        <button class="btn btn-primary" id="recRecalc">Recalculate</button>
      </div>

      <div class="grid grid-3 mt">
        <div class="card"><div class="stat"><span class="stat-label">Adjusted cost basis</span><span class="stat-value sm">${costBasis === null ? '—' : money(costBasis)}</span><span class="stat-sub">after premiums, fees and dividends</span></div></div>
        <div class="card"><div class="stat"><span class="stat-label">Unrealized loss / gain</span><span class="stat-value sm ${loss >= 0 ? 'positive' : 'negative'}">${loss === null ? '—' : money(loss)}</span><span class="stat-sub">${lossPct === null ? '' : pct(lossPct)}</span></div></div>
        <div class="card"><div class="stat"><span class="stat-label">Situation</span><span class="stat-value sm">${escapeHtml(scenario.key)}</span><span class="stat-sub">${escapeHtml(scenario.label)}</span></div></div>
      </div>

      <div class="card mt">
        <div class="next-step ${scenario.key === 'D' ? 'fail' : scenario.key === 'A' ? '' : 'warn'}">
          <b>${escapeHtml(scenario.label)}</b><div>${escapeHtml(scenario.explanation)}</div>
          <div class="muted" style="margin-top:6px">${escapeHtml(recText)}</div>
        </div>
        ${st.thesisBroken ? '<div class="notice error mt">Because you said the thesis is broken, Scenario D is the honest default. Compare the numbers below before deciding.</div>' : ''}
      </div>

      <div class="card mt">
        <div class="card-head"><h3>Covered-call candidates</h3><button class="btn btn-secondary btn-sm" id="recAdd">+ Add candidate</button></div>
        <div class="table-wrap"><table class="table"><thead><tr><th>Strike</th><th>Bid</th><th>DTE</th><th class="num">Net premium</th><th class="num">Annualized</th><th class="num">If called away</th><th class="num">Recovery est.</th><th></th></tr></thead><tbody>${candidateRows}</tbody></table></div>
        <p class="muted" style="font-size:12px;margin-top:8px">Enter bid prices and DTE from your IBKR chain. "If called away" compares the strike with your adjusted cost basis. Recovery time assumes you repeatedly sell a call like this one.</p>
      </div>

      <div class="card mt">
        <h3>How to exit in IBKR</h3>
        <ol style="line-height:1.9;padding-left:20px">
          <li><b>Sell a covered call:</b> open the option chain → CALL side → choose a strike at/above cost basis → click BID to create a SELL order → 1 contract per 100 shares → LIMIT at the mid.</li>
          <li><b>Sell the shares directly:</b> create a SELL stock order, LIMIT near the bid, during regular hours 09:30–16:00 ET. Avoid the first and last 15 minutes for better prices, and avoid pre/post-market while learning.</li>
          <li>Liquid stocks can always be sold during market hours — the only question is the price.</li>
        </ol>
        <button class="btn btn-primary mt" id="recSave">Save plan & set review date</button>
      </div>`;
  },
  mount(root, ctx) {
    root.querySelector('#recWheel')?.addEventListener('change', (e) => { state = loadFor(e.target.value, ctx); ctx.go(`/recovery?wheel=${e.target.value}`); });
    root.querySelector('#recAdd')?.addEventListener('click', () => { state.candidates.push({ strike: '', bid: '', dte: '' }); ctx.reload(); });
    root.querySelectorAll('[data-rec-cand]').forEach((el) => {
      el.oninput = () => { state.candidates[Number(el.dataset.recCand)][el.dataset.k] = el.value; };
      el.onchange = () => ctx.reload();
    });
    root.querySelector('#recRecalc')?.addEventListener('click', () => {
      const v = readForm(root);
      state.assignmentPrice = v.assignmentPrice;
      state.shares = v.shares;
      state.currentPrice = v.currentPrice;
      state.premiums = v.premiums;
      state.fees = v.fees;
      state.dividends = v.dividends;
      state.thesisBroken = v.thesis === 'broken';
      state.waitMonths = v.waitMonths;
      ctx.reload();
    });
    root.querySelector('#recSave')?.addEventListener('click', () => {
      openModal('Set a review date', `
        ${field({ label: 'Guided exploration', name: 'note', value: `${state.ticker} recovery plan`, hint: 'saved with the wheel' })}
        ${field({ label: 'Review date', name: 'reviewDate', type: 'date', value: todayISO() })}
        <div class="row" style="justify-content:flex-end;gap:8px"><button class="btn btn-primary" data-submit>Save plan</button></div>`, (body, close) => {
        body.querySelector('[data-submit]').onclick = () => {
          const v = readForm(body);
          ctx.actions.updateWheel(state.wheelId, { reviewDate: v.reviewDate, recoveryPlan: { candidates: state.candidates, thesisBroken: state.thesisBroken, waitMonths: state.waitMonths, savedAt: new Date().toISOString() } });
          close();
          toast('Recovery plan saved. It will appear in Today’s actions when due.');
        };
      });
    });
  },
};
