import { wheelSummary } from '../store.js';
import { mergeSettings, adjustedCostBasis } from '../calc.js';
import {
  tradesToEvents, adjustedBasisPerShare, unrealizedPnL, gapPct, decidePath,
  gradeCall, takeProfitLimit, exitSimulator, openPositions, maxCallContracts,
} from '../wheelEngine.js';
import { money, pct, escapeHtml, todayISO, addDays, toDMY } from '../format.js';
import { badge, tip, field, toast, openModal, readForm } from '../ui.js';

let state = null;
let lastWheelId = null;

function loadFor(wheelId, ctx) {
  const w = ctx.state.wheels.find((x) => x.id === wheelId);
  if (!w) return null;
  const sm = wheelSummary(w);
  const candidates = w.recoveryPlan?.candidates?.length
    ? w.recoveryPlan.candidates
    : [{ strike: '', bid: '', ask: '', delta: '', dte: '' }];
  return {
    wheelId,
    ticker: w.ticker,
    shares: sm.shares || 100,
    currentPrice: sm.mark ?? '',
    premiums: sm.premiums,
    fees: sm.fees,
    dividends: sm.dividends,
    thesisBroken: w.recoveryPlan?.thesisBroken || false,
    nextEarnings: w.recoveryPlan?.nextEarnings || '',
    exDividend: w.recoveryPlan?.exDividend || '',
    waitMonths: w.recoveryPlan?.waitMonths || 3,
    candidates,
    exitPrice: sm.mark != null ? String(sm.mark) : '',
    acceptedLoss: false,
  };
}

export default {
  title: 'Assignment & recovery',
  beforeRender(route) {
    const id = route?.params?.wheel || null;
    if (id && id !== lastWheelId) { state = null; lastWheelId = id; }
  },
  render(ctx) {
    const eligible = ctx.state.wheels.filter((w) => ['holding', 'short_call', 'short_put'].includes(w.state));
    const selectedId = ctx.route?.params?.wheel || state?.wheelId || eligible[0]?.id || '';
    if (!state || state.wheelId !== selectedId) state = loadFor(selectedId, ctx);

    if (!ctx.state.wheels.length) {
      return `<div class="card empty"><span class="empty-ico">⛑</span>No wheels yet. The assistant opens when you hold shares after an assignment.</div>`;
    }
    if (!state) {
      return `<div class="card"><h2>Assignment assistant</h2><p class="muted">Choose a wheel to analyse.</p>
        <select id="recWheel">${ctx.state.wheels.map((w) => `<option value="${w.id}">${escapeHtml(w.ticker)} · ${escapeHtml(w.state)}</option>`).join('')}</select></div>`;
    }

    const w = ctx.state.wheels.find((x) => x.id === state.wheelId);
    const sm = wheelSummary(w);
    if (w && (w.state === 'short_put' || sm?.state === 'short_put')) return renderPutRoll(ctx, w, sm, state);
    return renderHolding(ctx, w, sm, state);
  },
  mount(root, ctx) {
    root.querySelector('#recWheel')?.addEventListener('change', (e) => { state = loadFor(e.target.value, ctx); ctx.go(`/recovery?wheel=${e.target.value}`); });
    root.querySelectorAll('[data-roll]').forEach((b) => { b.onclick = () => ctx.go(`/roll?wheel=${b.dataset.roll}&type=put`); });
    root.querySelectorAll('[data-accept]').forEach((b) => { b.onclick = () => ctx.go(`/wheels?open=${b.dataset.accept}`); });
    root.querySelector('#recAdd')?.addEventListener('click', () => { state.candidates.push({ strike: '', bid: '', ask: '', delta: '', dte: '' }); ctx.reload(); });
    root.querySelectorAll('[data-rec-cand]').forEach((el) => {
      el.oninput = () => { state.candidates[Number(el.dataset.recCand)][el.dataset.k] = el.value; };
      el.onchange = () => ctx.reload();
    });
    root.querySelectorAll('[data-rec-field]').forEach((el) => {
      const apply = () => {
        if (el.dataset.recField === 'thesis') state.thesisBroken = el.value === 'broken';
        else state[el.dataset.recField] = el.type === 'checkbox' ? el.checked : el.value;
      };
      el.oninput = apply;
      el.onchange = () => { apply(); ctx.reload(); };
    });
    root.querySelectorAll('[data-log-call]').forEach((btn) => {
      btn.onclick = async () => {
        const row = btn.closest('tr');
        const strike = Number(row?.querySelector('[data-k="strike"]')?.value);
        const bid = Number(row?.querySelector('[data-k="bid"]')?.value);
        const dteVal = Number(row?.querySelector('[data-k="dte"]')?.value) || 35;
        if (!(strike > 0) || !(bid > 0)) { toast('Enter a strike and bid first.', 'warn'); return; }
        const shares = Number(state.shares) || 100;
        const contracts = Math.max(1, Math.round(shares / 100));
        const expiry = addDays(new Date(), dteVal).toISOString().slice(0, 10);
        const wheelId = state.wheelId;
        if (!(await ctx.confirm(`Log a covered call: sell ${contracts}× $${strike} call expiring ${expiry} for $${bid}?`))) return;
        ctx.actions.addTrade(wheelId, { action: 'SELL_CALL_OPEN', optionType: 'call', strike, expiry, price: bid, contracts, fees: contracts * mergeSettings(ctx.state.settings).commission, executedAt: new Date().toISOString(), notes: 'From assignment assistant' });
        toast('Covered call logged — Step 2 underway.');
        ctx.go(`/wheels?open=${wheelId}`);
      };
    });
    root.querySelectorAll('[data-sell-shares]').forEach((btn) => {
      btn.onclick = async () => {
        const wheelId = state.wheelId;
        const price = Number(state.exitPrice);
        const shares = Number(state.shares) || 100;
        const loss = exitSimulator({ salePrice: price, basisPerShare: Number(btn.dataset.basis), sharesHeld: shares, stockCommission: mergeSettings(ctx.state.settings).wheelRules.stockCommissionEstimate });
        if (!(price > 0)) { toast('Enter a sale price first.', 'warn'); return; }
        if (!(await ctx.confirm(`Sell ${shares} shares at $${price}? Realized P&L ≈ ${money(loss.realized)}. This locks in the loss.`, { danger: true, confirmText: 'Sell and lock it in' }))) return;
        ctx.actions.addTrade(wheelId, { action: 'SELL_SHARES', optionType: 'stock', price, contracts: shares / 100, fees: mergeSettings(ctx.state.settings).wheelRules.stockCommissionEstimate, executedAt: new Date().toISOString(), notes: 'Path C exit' });
        ctx.actions.updateWheel(wheelId, { state: 'complete', closedAt: new Date().toISOString(), lessons: w?.lessons || 'Path C exit' });
        toast('Shares sold — wheel closed.');
        ctx.go('/wheels');
      };
    });
    root.querySelector('#recSave')?.addEventListener('click', () => {
      openModal('Save plan & set a review date', `
        ${field({ label: 'Review date', name: 'reviewDate', type: 'date', value: todayISO() })}
        <div class="row" style="justify-content:flex-end;gap:8px"><button class="btn btn-primary" data-submit>Save plan</button></div>`, (body, close) => {
        body.querySelector('[data-submit]').onclick = () => {
          const v = readForm(body);
          ctx.actions.updateWheel(state.wheelId, { reviewDate: v.reviewDate, recoveryPlan: { candidates: state.candidates, thesisBroken: state.thesisBroken, nextEarnings: state.nextEarnings, exDividend: state.exDividend, waitMonths: state.waitMonths, savedAt: new Date().toISOString() } });
          close();
          toast('Plan saved — it will appear in Today’s actions when due.');
        };
      });
    });
  },
};

function renderPutRoll(ctx, w, sm, st) {
  const itm = sm.mark != null && sm.putStrike != null && sm.mark < sm.putStrike;
  const rolled = sm.rolls >= 3;
  return `
    <div class="stepper">
      <span class="step active"><span class="step-num">1</span>Short put</span>
      <span class="step"><span class="step-num">2</span>Roll for a credit</span>
      <span class="step"><span class="step-num">3</span>Or accept assignment</span>
      <span class="step"><span class="step-num">4</span>Log it</span>
    </div>
    <div class="card">
      <div class="card-head"><div><h2>${tip('Put recovery — roll or accept assignment', 'Rolling = buy back the put and sell a new one further out (often lower) for a net credit.')}</h2>
        <p class="muted">If the stock moves against you before expiry, rolling is usually better than panic-buying it back at a loss.</p></div>
        <select id="recWheel" class="input-sm" style="max-width:220px">${ctx.state.wheels.map((x) => `<option value="${x.id}" ${x.id === w.id ? 'selected' : ''}>${escapeHtml(x.ticker)} · ${escapeHtml(x.state)}</option>`).join('')}</select>
      </div>
      <div class="grid grid-3">
        <div class="kv"><span>Put strike</span><span>${sm.putStrike != null ? money(sm.putStrike) : '—'}</span></div>
        <div class="kv"><span>Expiry</span><span>${sm.putExpiry ? toDMY(sm.putExpiry) : '—'}${sm.dte != null ? ` (${sm.dte} DTE)` : ''}</span></div>
        <div class="kv"><span>Stock now</span><span>${sm.mark != null ? money(sm.mark) : '—'}</span></div>
        <div class="kv"><span>Sold at (mid)</span><span>${sm.leg ? money(sm.leg.mid) : '—'}</span></div>
        <div class="kv"><span>Option now</span><span>${sm.legMid != null ? money(sm.legMid) : '—'}</span></div>
        <div class="kv"><span>Captured</span><span class="${sm.captured != null && sm.captured >= sm.target ? 'positive' : ''}">${sm.captured != null ? `${sm.captured.toFixed(0)}%` : '—'} <span class="muted">(target ${sm.target}%)</span></span></div>
      </div>
      <div class="notice ${itm ? 'error' : 'info'}" style="margin-top:12px">
        ${itm ? 'The put is <b>in the money</b> — assignment is possible.' : 'The put is out of the money — you may not need to do anything yet.'}
        Rolling means: buy back this put and sell a new one further out (sometimes lower strike), <b>ideally for a net credit</b>.
      </div>
      ${rolled ? '<div class="notice warn" style="margin-top:10px">You have rolled/closed this position several times. Rolling endlessly to avoid a bad pick is how small losses become big ones. Sometimes taking assignment — or the loss — is the right call.</div>' : ''}
      <div class="action-grid">
        <button class="btn btn-primary btn-sm" data-roll="${w.id}">Open roll calculator →</button>
        <button class="btn btn-secondary btn-sm" data-accept="${w.id}">Accept assignment (go to Step 2)</button>
      </div>
    </div>`;
}

function renderHolding(ctx, w, sm, st) {
  const s = mergeSettings(ctx.state.settings);
  const rules = s.wheelRules;
  const events = tradesToEvents(ctx.state.trades.filter((t) => t.wheelId === w.id));
  const info = adjustedBasisPerShare(events, rules);
  // Fallback to the legacy cost basis if the ledger has no PUT_ASSIGNED event.
  const basis = info.basisPerShare ?? adjustedCostBasis({ assignmentPrice: Number(w.assignedPrice) || 0, premiums: Number(st.premiums) || 0, fees: Number(st.fees) || 0, dividends: Number(st.dividends) || 0, shares: Number(st.shares) || 100 });
  const shares = info.sharesHeld || Number(st.shares) || 100;
  const current = st.currentPrice === '' ? null : Number(st.currentPrice);
  const unreal = unrealizedPnL(current, basis, shares);
  const gap = gapPct(basis, current);
  const pos = openPositions(events);
  const maxCalls = maxCallContracts(shares);
  const decision = decidePath({ thesisOk: !st.thesisBroken, gapPct: gap }, rules);

  const candCtx = { basisPerShare: basis, sharesHeld: shares, assignmentStrike: info.assignmentStrike ?? basis, assignmentFees: info.assignmentFees || 0, totalPremiumsTotal: info.totalPremiums || 0, rules, earningsDate: st.nextEarnings || null, exDivDate: st.exDividend || null };
  const rows = st.candidates.map((c, i) => {
    const g = (Number(c.strike) > 0 && (Number(c.bid) > 0 || Number(c.ask) > 0)) ? gradeCall({ ...c, contracts: 1 }, candCtx) : null;
    const tag = (grade) => (grade ? `<span class="chip ${grade.key === 'pass' || grade.key === 'great' ? 'ok' : grade.key === 'fail' ? 'bad' : 'warn'}">${escapeHtml(grade.label)}</span>` : '—');
    return `<tr class="${g && g.belowBasis ? 'muted' : ''}">
      <td><input class="input-sm" style="width:70px" data-rec-cand="${i}" data-k="strike" value="${escapeHtml(c.strike)}" placeholder="44" /></td>
      <td><input class="input-sm" style="width:70px" data-rec-cand="${i}" data-k="bid" value="${escapeHtml(c.bid)}" placeholder="0.49" /></td>
      <td><input class="input-sm" style="width:70px" data-rec-cand="${i}" data-k="ask" value="${escapeHtml(c.ask || '')}" placeholder="0.53" /></td>
      <td><input class="input-sm" style="width:64px" data-rec-cand="${i}" data-k="delta" value="${escapeHtml(c.delta || '')}" placeholder="0.27" /></td>
      <td><input class="input-sm" style="width:60px" data-rec-cand="${i}" data-k="dte" value="${escapeHtml(c.dte)}" placeholder="35" /></td>
      <td class="num">${g ? money(g.estNetPremium) : '—'}</td>
      <td class="num">${g && g.spreadPct != null ? `${g.spreadPct.toFixed(1)}%` : '—'}</td>
      <td class="num">${g && g.annualizedPct != null ? pct(g.annualizedPct) : '—'}</td>
      <td class="num">${g && g.newBasis != null ? money(g.newBasis) : '—'}</td>
      <td class="num ${g && g.wheelProfitIfCalledAway < 0 ? 'negative' : 'positive'}">${g ? money(g.wheelProfitIfCalledAway) : '—'}</td>
      <td>${g ? tag(g.spreadGrade) : ''}</td>
      <td>${g && g.belowBasis ? '🔒 below basis' : g && g.passes ? badge('pass', 'OK') : g ? badge('warn', g.hardRejects[0] || 'check') : ''}</td>
      <td>${g && g.passes ? `<button class="btn btn-primary btn-sm" data-log-call="${i}">Sell</button>` : ''}</td>
    </tr>`;
  }).join('');

  // Running basis table.
  const sorted = [...events].sort((a, b) => String(a.eventTime).localeCompare(String(b.eventTime)));
  const basisRows = [];
  let premiumsSoFar = 0;
  let assignedShares = 0;
  let weighted = 0;
  for (const e of sorted) {
    if (e.voided) continue;
    if (['PUT_SOLD', 'PUT_BOUGHT_TO_CLOSE', 'CALL_SOLD', 'CALL_BOUGHT_TO_CLOSE'].includes(e.type)) {
      const np = e.type.includes('SOLD') && !e.type.includes('BOUGHT') ? (e.optionPrice * 100 * e.contracts - e.commission) : -(e.optionPrice * 100 * e.contracts) - e.commission;
      premiumsSoFar += np;
      basisRows.push({ label: e.type, perShare: np / Math.max(1, assignedShares || 100), basis: assignedShares > 0 ? (weighted - premiumsSoFar) / assignedShares : null });
    } else if (e.type === 'PUT_ASSIGNED') {
      assignedShares += e.shares;
      weighted += e.strike * e.shares;
      basisRows.push({ label: 'PUT_ASSIGNED', perShare: null, basis: (weighted - premiumsSoFar) / assignedShares });
    }
  }

  const pathLabel = { A: 'Path A — Normal covered call', B: 'Path B — Recovery mode', B_MONTHLY_REVIEW: 'Path B — Recovery + monthly review', C: 'Path C — Exit' }[decision.path];
  const pathClass = decision.path === 'A' ? 'pass' : decision.path === 'C' ? 'fail' : 'warn';

  const exit = exitSimulator({ salePrice: Number(st.exitPrice) || 0, basisPerShare: basis, sharesHeld: shares, stockCommission: rules.stockCommissionEstimate, openCallBuyBack: pos.shortCalls ? 99999 : 0 });

  const pathPanel = decision.path === 'C'
    ? `<div class="card mt">
        <h3>Path C — Exit plan</h3>
        <div class="notice ${pos.shortCalls ? 'error' : 'info'} mt">${pos.shortCalls ? `⚠️ You have an open short call. Close it FIRST — selling shares with a call open makes it naked.` : 'No open call — you can sell the shares.'}</div>
        <div class="form-grid mt">
          ${field({ label: 'Sale price', name: 'exitPrice', value: st.exitPrice, hint: 'you can edit this' })}
          <div class="kv" style="align-self:end"><span>Realized P&L</span><span class="${exit.realized >= 0 ? 'positive' : 'negative'}">${money(exit.realized)}</span></div>
        </div>
        <label class="checkline"><input type="checkbox" data-rec-field="acceptedLoss" ${st.acceptedLoss ? 'checked' : ''}/> I accept this exact loss: ${money(exit.realized)}</label>
        <div class="grid grid-2 mt">
          <div><h4>IBKR ticket</h4><div class="kv"><span>Action</span><span>SELL</span></div><div class="kv"><span>Quantity</span><span>${shares}</span></div><div class="kv"><span>Type</span><span>LMT @ mid</span></div><div class="kv"><span>TIF</span><span>DAY · no Outside RTH</span></div><div class="kv"><span>When</span><span>10:00–15:30 ET</span></div></div>
          <div><h4>Then</h4><p class="muted" style="font-size:12.5px">Verify the position is gone, log it, and return to the Screener with the freed cash.</p>
          <button class="btn btn-danger btn-sm" data-sell-shares="1" data-basis="${basis}" ${pos.shortCalls || !st.acceptedLoss ? 'disabled' : ''}>Sell ${shares} shares & close wheel</button></div>
        </div>
      </div>`
    : `<div class="card mt">
        <div class="card-head"><h3>${decision.path === 'A' ? 'Path A — Candidate covered calls' : 'Path B — Recovery steps'}</h3><button class="btn btn-secondary btn-sm" id="recAdd">+ Add candidate</button></div>
        ${decision.path !== 'A' ? `<div class="notice info">Try in order, stop at the first that works: <b>B1</b> strike ≥ basis, 45–75 DTE, net ≥ $0.${rules.recoveryB1MinNet * 100}/share · <b>B2</b> 75–120 DTE, net ≥ $0.${rules.recoveryB2MinNet * 100}/share · <b>B3</b> hold &amp; wait (valid) · <b>B4</b> strike below basis (not for beginners).</div>` : ''}
        <div class="table-wrap mt"><table class="table"><thead><tr><th>Strike</th><th>Bid</th><th>Ask</th><th>Delta</th><th>DTE</th><th class="num">Net</th><th class="num">Spread%</th><th class="num">Ann.</th><th class="num">New basis</th><th class="num">If called away</th><th>Spread</th><th>Verdict</th><th></th></tr></thead><tbody>${rows}</tbody></table></div>
        <p class="muted" style="font-size:12px;margin-top:8px">Hard rule: strike ≥ your adjusted basis ${money(basis)}. Take-profit for a fill is 50% (e.g. ${money(takeProfitLimit(0.5))}). Max calls: ${maxCalls} (you hold ${shares} shares).</p>
      </div>`;

  return `
    <div class="stepper">
      <span class="step active"><span class="step-num">1</span>Confirm</span>
      <span class="step"><span class="step-num">2</span>Your numbers</span>
      <span class="step"><span class="step-num">3</span>Path</span>
      <span class="step"><span class="step-num">4</span>Act</span>
    </div>
    <div class="card">
      <div class="card-head"><div><h2>${tip('Assignment assistant', 'Assignment is not a failure — you are in Step 2 of the Wheel. IBKR shows your cost as the strike; the number that matters is your adjusted basis.')}</h2>
        <p class="muted">You are not stuck — you are in Step 2 of the Wheel. Shares of a liquid stock can always be sold during market hours; the only question is the price.</p></div>
        <select id="recWheel" class="input-sm" style="max-width:220px">${ctx.state.wheels.map((x) => `<option value="${x.id}" ${x.id === w.id ? 'selected' : ''}>${escapeHtml(x.ticker)} · ${escapeHtml(x.state)}</option>`).join('')}</select>
      </div>
      <div class="grid grid-3 mt">
        <div class="card"><div class="stat"><span class="stat-label">${tip('Broker cost (IBKR)', 'This is the strike × 100. IBKR does not subtract the premiums you collected.')}</span><span class="stat-value sm">${info.assignmentStrike != null ? money(info.assignmentStrike) : '—'}</span><span class="stat-sub">what IBKR shows</span></div></div>
        <div class="card"><div class="stat"><span class="stat-label">${tip('Your real (adjusted) basis', 'Adjusted basis = (strike×100 + assignment fees − all premiums collected) ÷ shares. This is the number that matters.')}</span><span class="stat-value sm">${money(basis)}</span><span class="stat-sub">use this number, not IBKR's</span></div></div>
        <div class="card"><div class="stat"><span class="stat-label">Current price</span><span class="stat-value sm">${current != null ? money(current) : '—'}</span>
          <input class="input-sm mt" data-rec-field="currentPrice" value="${escapeHtml(String(st.currentPrice))}" placeholder="from IBKR" /></div></div>
        <div class="card"><div class="stat"><span class="stat-label">Unrealized P&L</span><span class="stat-value sm ${unreal >= 0 ? 'positive' : 'negative'}">${unreal == null ? '—' : money(unreal)}</span><span class="stat-sub">(price − basis) × ${shares}</span></div></div>
        <div class="card"><div class="stat"><span class="stat-label">${tip('Gap %', '(basis − price) ÷ basis × 100. Negative means the stock is above your basis.')}</span><span class="stat-value sm">${gap == null ? '—' : `${gap.toFixed(2)}%`}</span><span class="stat-sub">decides your path</span></div></div>
        <div class="card"><div class="stat"><span class="stat-label">Shares / max calls</span><span class="stat-value sm">${shares} / ${maxCalls}</span><span class="stat-sub">${pos.shortCalls} open call(s)</span></div></div>
      </div>
      <div class="grid grid-3 mt">
        <div class="field"><label>Thesis</label><select data-rec-field="thesis"><option value="ok" ${!st.thesisBroken ? 'selected' : ''}>Still valid</option><option value="broken" ${st.thesisBroken ? 'selected' : ''}>Broken (bad news)</option></select></div>
        <div class="field"><label>Next earnings</label><input type="date" data-rec-field="nextEarnings" value="${escapeHtml(st.nextEarnings)}" /></div>
        <div class="field"><label>Next ex-dividend</label><input type="date" data-rec-field="exDividend" value="${escapeHtml(st.exDividend)}" /></div>
      </div>
    </div>
    <div class="card mt">
      <div class="row-between"><h3>Your path</h3>${badge(pathClass, pathLabel)}</div>
      <ul style="margin:10px 0 0;padding-left:18px" class="muted">${decision.reasons.map((r) => `<li>${escapeHtml(r)}</li>`).join('')}</ul>
    </div>
    ${pathPanel}
    <div class="card mt">
      <div class="card-head"><h3>Running basis</h3><button class="btn btn-primary btn-sm" id="recSave">Save plan &amp; review date</button></div>
      <div class="table-wrap"><table class="table"><thead><tr><th>Event</th><th class="num">Premium / share</th><th class="num">Basis after</th></tr></thead><tbody>
        ${basisRows.length ? basisRows.map((r) => `<tr><td>${escapeHtml(r.label)}</td><td class="num">${r.perShare == null ? '—' : money(r.perShare)}</td><td class="num">${r.basis == null ? '—' : money(r.basis)}</td></tr>`).join('') : '<tr><td colspan="3" class="muted">No events yet.</td></tr>'}
      </tbody></table></div>
      <p class="muted" style="font-size:12px;margin-top:8px">Every premium lowers your break-even — that is how the wheel repairs an assignment over time.</p>
    </div>`;
}
