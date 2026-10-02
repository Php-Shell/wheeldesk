import { buildChecklistContext, evaluateChecklist, CHECKLIST_GROUPS, STATUS_META } from '../checklist.js';
import { mergeSettings, putMetrics, DEFAULT_SETTINGS } from '../calc.js';
import { money, pct, escapeHtml, dte, fmtInZone, localTimeZone } from '../format.js';
import { badge, tip, toast, chartColors } from '../ui.js';

const openSet = new Set();
const drafts = new Map();
const requested = new Set();
const chains = new Map();
const chainLoading = new Set();

function draftFor(w) {
  if (!drafts.has(w.symbol)) {
    drafts.set(w.symbol, {
      expiry: w.option?.expiry || '',
      candidates: w.candidates?.length ? w.candidates : [{ strike: '', bid: '', ask: '', delta: '', oi: '', volume: '', ivRank: '', iv: '' }],
      active: w.activeCandidate ?? 0,
      happyToOwn: w.manual?.happyToOwn ?? '',
      notMeme: w.manual?.notMeme ?? '',
      trendOverride: w.manual?.trendOverride || '',
      ivRank: w.manual?.ivRank ?? '',
    });
  }
  return drafts.get(w.symbol);
}

function activeOption(w, draft) {
  const row = draft.candidates[draft.active];
  if (!row) return null;
  const strike = Number(row.strike);
  if (!strike) return null;
  const bid = row.bid === '' ? null : Number(row.bid);
  const ask = row.ask === '' ? null : Number(row.ask);
  return {
    strike,
    bid,
    ask,
    mid: bid !== null && ask !== null ? (bid + ask) / 2 : bid ?? ask,
    delta: row.delta === '' ? null : Number(row.delta),
    openInterest: row.oi === '' ? null : Number(row.oi),
    volume: row.volume === '' ? null : Number(row.volume),
    ivRank: (row.ivRank !== '' ? Number(row.ivRank) : draft.ivRank === '' ? null : Number(draft.ivRank)),
    iv: row.iv === '' || row.iv === undefined ? null : Number(row.iv),
    expiry: draft.expiry || null,
    dte: draft.expiry ? dte(draft.expiry) : null,
  };
}

// Pick the listed expiry closest to a 40-DTE target (the strategy's sweet spot).
function pickExpiry(expirations) {
  const scored = expirations
    .map((e) => ({ e, d: dte(e) }))
    .filter((x) => x.d != null && x.d > 0);
  if (!scored.length) return expirations[0] || '';
  const preferred = scored.filter((x) => x.d >= 25 && x.d <= 55);
  const pool = preferred.length ? preferred : scored;
  pool.sort((a, b) => Math.abs(a.d - 40) - Math.abs(b.d - 40));
  return pool[0].e;
}

// Fill the strike picker with real puts from the fetched chain.
function populateFromChain(sym, ctx, expiry) {
  const chain = chains.get(sym);
  const draft = drafts.get(sym);
  if (!chain || !draft) return;
  const s = mergeSettings(ctx.state.settings);
  const maxCollateral = ctx.account.budget * s.maxPerWheelPct;
  const puts = chain.rows
    .filter((r) => r.type === 'put' && r.expiry === expiry)
    .filter((r) => r.strike && (r.bid > 0 || r.mid > 0))
    .filter((r) => r.delta !== null && Math.abs(r.delta) >= 0.08 && Math.abs(r.delta) <= 0.4)
    .filter((r) => r.strike * 100 <= maxCollateral)
    .sort((a, b) => Math.abs(Math.abs(a.delta) - 0.22) - Math.abs(Math.abs(b.delta) - 0.22))
    .slice(0, 8)
    .sort((a, b) => b.strike - a.strike);
  const rows = puts.length ? puts : chain.rows.filter((r) => r.type === 'put' && r.expiry === expiry).slice(0, 6);
  draft.expiry = expiry;
  draft.candidates = rows.map((r) => ({
    strike: r.strike,
    bid: r.bid ?? '',
    ask: r.ask ?? '',
    delta: r.delta ?? '',
    oi: r.openInterest ?? '',
    volume: r.volume ?? '',
    ivRank: '',
    iv: r.iv ?? '',
  }));
  draft.active = 0;
}

async function fetchChain(sym, ctx) {
  chainLoading.add(sym);
  ctx.reload();
  try {
    const res = await ctx.providers.loadOptions(sym, '', ctx.auth.token());
    if (res?.status === 'ok' && res.data?.rows?.length) {
      chains.set(sym, res.data);
      if (res.data.underlying?.price != null) ctx.actions.setMark(sym, res.data.underlying.price);
      populateFromChain(sym, ctx, pickExpiry(res.data.expirations));
      toast(`${sym}: loaded ${res.data.rows.length} contracts from ${res.provider} (delayed).`);
    } else {
      toast(res?.message || `No chain available for ${sym} — enter strikes manually.`, 'warn');
    }
  } catch (err) {
    toast(`Chain fetch failed: ${err.message}`, 'error');
  }
  chainLoading.delete(sym);
  ctx.reload();
}

function checklistHtml(w, ctx) {
  const draft = draftFor(w);
  const option = activeOption(w, draft);
  const manual = {
    happyToOwn: draft.happyToOwn === 'yes' ? true : draft.happyToOwn === 'no' ? false : null,
    notMeme: draft.notMeme === 'yes' ? true : draft.notMeme === 'no' ? false : null,
    trendOverride: draft.trendOverride || null,
    ivRank: draft.ivRank === '' ? null : Number(draft.ivRank),
  };
  const context = buildChecklistContext({ state: ctx.state, data: w.data, option, manual, settings: ctx.state.settings });
  const result = evaluateChecklist(context);
  const verdictClass = result.verdict.className === 'pass' ? 'pass' : result.verdict.className === 'warn' ? 'warn' : 'fail';
  const ringColor = `var(--${verdictClass === 'pass' ? 'brand' : verdictClass === 'warn' ? 'amber' : 'red'})`;
  const groupHtml = CHECKLIST_GROUPS.map((g) => {
    const items = result.items.filter((i) => i.group === g.id);
    if (!items.length) return '';
    return `<div class="check-group-title">${escapeHtml(g.title)}</div>
      <div class="checklist">${items.map((i) => `
        <div class="check-item ${i.status}">
          <span class="check-ico" title="${escapeHtml(i.meta.label)}">${i.meta.icon}</span>
          <div><div class="check-label">${i.id} · ${tip(escapeHtml(i.label), i.why)}</div>
          <div class="check-detail">${escapeHtml(i.detail || i.meta.label)}</div></div>
          <span class="badge ${i.status}">${escapeHtml(i.meta.label)}</span>
        </div>`).join('')}</div>`;
  }).join('');

  return `
    <div class="row-between" style="margin:16px 0 6px">
      <div class="row">
        <div class="score-ring" style="background:${ringColor}1a;color:${ringColor};border:3px solid ${ringColor}">${result.score}</div>
        <div style="margin-left:12px">
          ${badge(verdictClass, result.verdict.label)}
          <div class="muted" style="font-size:12px;margin-top:6px">${result.failCount} fail · ${result.unknownCount} not verified</div>
        </div>
      </div>
      <button class="btn btn-secondary btn-sm" data-refresh="${w.symbol}">↻ Refresh data</button>
    </div>
    ${result.verdict.reasons?.length ? `<div class="notice error">Avoid: ${escapeHtml(result.verdict.reasons.join(', '))}</div>` : ''}
    ${groupHtml}
    <div class="mt" style="display:flex;gap:8px;flex-wrap:wrap">
      <button class="btn btn-primary btn-sm" data-open-wheel="${w.symbol}" ${!option ? 'disabled' : ''}>Open a wheel with this setup →</button>
      <span class="muted" style="font-size:12px;align-self:center">${option ? `Strike $${option.strike} · ${money(putMetrics({ strike: option.strike, mid: option.mid, contracts: 1, commission: mergeSettings(ctx.state.settings).commission, daysToExpiry: option.dte, delta: option.delta })?.netPremium)} net premium` : 'Pick a strike to enable'}</span>
    </div>`;
}

function candidateRows(w, draft) {
  const s = mergeSettings(ctxGlobal.state.settings);
  return draft.candidates.map((row, i) => `
    <tr>
      <td><input class="input-sm" style="width:80px" data-cand="${w.symbol}" data-i="${i}" data-k="strike" value="${escapeHtml(row.strike)}" placeholder="50" /></td>
      <td><input class="input-sm" style="width:70px" data-cand="${w.symbol}" data-i="${i}" data-k="bid" value="${escapeHtml(row.bid)}" placeholder="0.50" /></td>
      <td><input class="input-sm" style="width:70px" data-cand="${w.symbol}" data-i="${i}" data-k="ask" value="${escapeHtml(row.ask)}" placeholder="0.55" /></td>
      <td><input class="input-sm" style="width:70px" data-cand="${w.symbol}" data-i="${i}" data-k="delta" value="${escapeHtml(row.delta)}" placeholder="-0.20" /></td>
      <td><input class="input-sm" style="width:70px" data-cand="${w.symbol}" data-i="${i}" data-k="oi" value="${escapeHtml(row.oi)}" placeholder="500" /></td>
      <td><input class="input-sm" style="width:70px" data-cand="${w.symbol}" data-i="${i}" data-k="volume" value="${escapeHtml(row.volume)}" placeholder="120" /></td>
      <td><input class="input-sm" style="width:60px" data-cand="${w.symbol}" data-i="${i}" data-k="ivRank" value="${escapeHtml(row.ivRank)}" placeholder="45" /></td>
      <td class="num muted" title="Implied volatility (from the chain)">${row.iv ? `${Number(row.iv).toFixed(1)}%` : '—'}</td>
      <td style="white-space:nowrap">
        <button class="btn btn-${draft.active === i ? 'primary' : 'secondary'} btn-sm" data-use="${w.symbol}" data-i="${i}">${draft.active === i ? 'Selected' : 'Use'}</button>
        <button class="btn btn-ghost btn-sm" data-remove-row="${w.symbol}" data-i="${i}" title="Remove row">×</button>
      </td>
    </tr>`).join('');
}

let ctxGlobal = null;

function watchBody(w, ctx) {
  const draft = draftFor(w);
  const data = w.data;
  const sources = data?.sources || [];
  const fmt = (v) => (v === null || v === undefined ? '—' : v);
  const sourceLine = sources.length
    ? sources.map((s) => `<span class="source-tag">${escapeHtml(s.label)} · ${escapeHtml(s.provider)} · ${escapeHtml(s.fetchedAt ? fmtInZone(s.fetchedAt, 'America/New_York') + ' ET' : '')}</span>`).join('')
    : '<span class="source-tag">No live data yet — sign in and press Refresh, or enter values manually.</span>';
  const authBanner = data?.authRequired
    ? `<div class="notice info" style="margin-top:10px">Live market data needs a signed-in session (the proxy verifies it so your API key stays safe). <button class="btn btn-primary btn-sm" data-signin>Sign in</button> You can still enter every value manually.</div>`
    : '';

  return `
    <div class="grid grid-3" style="margin-bottom:8px">
      <div class="kv"><span>Price</span><span>${data?.quote?.price != null ? money(data.quote.price) : '—'}</span></div>
      <div class="kv"><span>Market cap</span><span>${data?.profile?.marketCap != null ? money(data.profile.marketCap, 'USD', 0) : '—'}</span></div>
      <div class="kv"><span>Trailing EPS</span><span>${fmt(data?.metrics?.epsTTM)}</span></div>
      <div class="kv"><span>Avg volume</span><span>${data?.metrics?.avgVolume != null ? `${(data.metrics.avgVolume / 1e6).toFixed(2)}M` : '—'}</span></div>
      <div class="kv"><span>52-week range</span><span>${data?.metrics?.low52 != null && data?.metrics?.high52 != null ? `${money(data.metrics.low52)} – ${money(data.metrics.high52)}` : '—'}</span></div>
      <div class="kv"><span>Price vs 200-DMA</span><span>${data?.priceVsMa200 != null ? `${data.priceVsMa200 >= 0 ? '+' : ''}${data.priceVsMa200.toFixed(1)}%` : '—'}</span></div>
      <div class="kv"><span>Next earnings</span><span>${data?.earnings?.nextDate ? `${data.earnings.nextDate}${data.earnings.daysUntil != null ? ` (in ${data.earnings.daysUntil}d)` : ''}` : '—'}</span></div>
      <div class="kv"><span>Next ex-dividend</span><span>${data?.dividends?.next?.exDate ? `${data.dividends.next.exDate}${data.dividends.next.amount ? ` · ${money(data.dividends.next.amount)}` : ''}` : '—'}</span></div>
      <div class="kv"><span>Industry</span><span>${escapeHtml(data?.profile?.industry || '—')}</span></div>
    </div>
    <div class="source-line">${sourceLine}</div>
    ${authBanner}
    ${!data?.authRequired && data?.messages?.length ? `<div class="notice info" style="margin-top:10px">${escapeHtml(data.messages.join(' '))}</div>` : ''}

    <div class="grid grid-3 mt">
      <div class="field"><label>Would you happily own 100 shares at this price?</label>
        <select data-manual="${w.symbol}" data-k="happyToOwn">
          <option value="">Choose…</option>
          <option value="yes" ${draft.happyToOwn === 'yes' ? 'selected' : ''}>Yes, I'd own it for months</option>
          <option value="no" ${draft.happyToOwn === 'no' ? 'selected' : ''}>No</option>
        </select></div>
      <div class="field"><label>Confirmed not a meme / IPO / binary biotech / leveraged ETF?</label>
        <select data-manual="${w.symbol}" data-k="notMeme">
          <option value="">Choose…</option>
          <option value="yes" ${draft.notMeme === 'yes' ? 'selected' : ''}>Confirmed normal company/ETF</option>
          <option value="no" ${draft.notMeme === 'no' ? 'selected' : ''}>It is one of those</option>
        </select></div>
      <div class="field"><label>200-DMA override <span class="hint">(only if the chart data is missing)</span></label>
        <input data-manual="${w.symbol}" data-k="trendOverride" value="${escapeHtml(draft.trendOverride)}" placeholder="e.g. long-term uptrend intact" /></div>
    </div>

    <div class="card-head" style="margin-top:14px"><h4>${tip('Strike picker', 'Load a free delayed CBOE option chain (with greeks), or type values from your IBKR screen.')}</h4>
      <div class="row" style="gap:8px">
        <button class="btn btn-primary btn-sm" data-fetch-chain="${w.symbol}" ${chainLoading.has(w.symbol) ? 'disabled' : ''}>${chainLoading.has(w.symbol) ? 'Loading…' : '⤓ Load CBOE chain (greeks)'}</button>
      </div>
    </div>
    ${(() => {
      const chain = chains.get(w.symbol);
      if (!chain) return '<p class="muted" style="font-size:12px">Free delayed chain from CBOE — no signup. If your symbol is not listed, enter values manually from IBKR.</p>';
      const expiries = chain.expirations.filter((e) => dte(e) > 0);
      const src = `${chain.underlying?.asOf || ''}`;
      return `<div class="notice info" style="margin:0 0 10px">Loaded ${escapeHtml(String(chain.rows.length))} contracts (delayed). Underlying ${money(chain.underlying?.price)}${src ? ` · ${escapeHtml(src)}` : ''}. Expiries within reach:
        <select class="input-sm" data-chain-expiry="${w.symbol}" style="max-width:200px;margin-left:8px">
          ${expiries.map((e) => `<option value="${e}" ${e === draft.expiry ? 'selected' : ''}>${e} (${dte(e)} DTE)</option>`).join('')}
        </select></div>`;
    })()}
    <div class="form-grid">
      <div class="field"><label>Expiry date</label><input type="date" data-expiry="${w.symbol}" value="${escapeHtml(draft.expiry)}" /></div>
      <div class="field"><label>IV Rank <span class="hint">optional, if you have it</span></label><input data-manual="${w.symbol}" data-k="ivRank" value="${escapeHtml(draft.ivRank)}" placeholder="45" /></div>
    </div>
    <div class="table-wrap">
      <table class="table"><thead><tr><th>Strike</th><th>Bid</th><th>Ask</th><th>Delta</th><th>OI</th><th>Volume</th><th>IV Rank</th><th>IV</th><th></th></tr></thead>
      <tbody>${candidateRows(w, draft)}</tbody></table>
    </div>
    <button class="btn btn-secondary btn-sm mt" data-add-row="${w.symbol}">+ Add candidate strike</button>

    <div id="checklist-${w.symbol}">${checklistHtml(w, ctx)}</div>

    <div class="grid grid-2 mt">
      <div class="field"><label>Research notes</label><textarea data-notes="${w.symbol}" placeholder="Why this company? What would make you change your mind?">${escapeHtml(w.notes || '')}</textarea>
        <button class="btn btn-secondary btn-sm" data-save-notes="${w.symbol}">Save notes</button></div>
      <div><label class="stat-label">Quick links</label>
        <div class="link-list mt">
          <a href="https://finance.yahoo.com/quote/${encodeURIComponent(w.symbol)}" target="_blank" rel="noopener">Yahoo Finance ↗</a>
          <a href="https://finviz.com/quote.ashx?t=${encodeURIComponent(w.symbol)}" target="_blank" rel="noopener">Finviz ↗</a>
          <a href="https://www.google.com/search?q=${encodeURIComponent(w.symbol + ' investor relations')}" target="_blank" rel="noopener">Investor relations ↗</a>
          <a href="https://www.google.com/search?q=${encodeURIComponent(w.symbol + ' earnings date')}" target="_blank" rel="noopener">Earnings calendar ↗</a>
        </div>
        <button class="btn btn-danger btn-sm mt" data-remove="${w.symbol}">Remove from watchlist</button>
      </div>
    </div>`;
}

export default {
  title: 'Screener & research',
  render(ctx) {
    ctxGlobal = ctx;
    const items = ctx.state.watchlist;
    const body = items.length
      ? items.map((w) => `
        <div class="accordion ${openSet.has(w.symbol) ? 'open' : ''}" data-acc="${w.symbol}">
          <div class="accordion-head" data-toggle="${w.symbol}">
            <b class="mono" style="font-size:15px">${escapeHtml(w.symbol)}</b>
            <span class="muted">${escapeHtml(w.data?.profile?.name || 'Click to load live data')}</span>
            ${w.data?.quote?.price != null ? `<span class="pill">${money(w.data.quote.price)}</span>` : ''}
            ${w.verdict ? badge(w.verdict.className, w.verdict.label) : ''}
            <span class="chev">›</span>
          </div>
          <div class="accordion-body">${openSet.has(w.symbol) ? watchBody(w, ctx) : ''}</div>
        </div>`).join('')
      : `<div class="card empty"><span class="empty-ico">⌕</span>Your watchlist is empty. Add a ticker above, or start with the suggested ideas.</div>`;

    const seeds = ['T', 'VZ', 'PFE', 'BAC', 'KO', 'KMI', 'CSCO', 'F', 'XLF'];
    return `
      <div class="card">
        <div class="card-head">
          <div><h2>Find a put to sell</h2><p class="muted">Type a ticker, load its free metrics, and let the checklist tell you whether it is safe. Data is never invented — unverified items stay "Not verified".</p></div>
        </div>
        <div class="row" style="gap:10px;flex-wrap:wrap">
          <input id="screenerInput" placeholder="Ticker (e.g. KO)" style="max-width:220px" />
          <button class="btn btn-primary" id="screenerAdd">Add / load</button>
          <span class="muted" style="font-size:12px">Starting ideas only — must pass the checklist with live data:</span>
          <span class="chip-row">${seeds.map((s) => `<button class="chip" data-seed="${s}">${s}</button>`).join('')}</span>
        </div>
      </div>
      <div class="section-head"><h2>Watchlist</h2><button class="btn btn-secondary btn-sm" id="screenerReload">↻ Reload all data</button></div>
      ${body}
    `;
  },
  mount(root, ctx) {
    const input = root.querySelector('#screenerInput');
    const add = (sym) => {
      const ticker = String(sym || '').trim().toUpperCase();
      if (!ticker) return;
      ctx.actions.addWatch(ticker);
      openSet.add(ticker);
      ctx.reload();
    };
    root.querySelector('#screenerAdd').onclick = () => add(input?.value);
    if (input) input.onkeydown = (e) => { if (e.key === 'Enter') add(input.value); };
    root.querySelectorAll('[data-seed]').forEach((b) => (b.onclick = () => add(b.dataset.seed)));
    root.querySelector('#screenerReload')?.addEventListener('click', () => { requested.clear(); loadAll(ctx); });

    root.querySelectorAll('[data-toggle]').forEach((head) => {
      head.onclick = async (e) => {
        if (e.target.closest('input,select,button,a')) return;
        const sym = head.dataset.toggle;
        if (openSet.has(sym)) { openSet.delete(sym); ctx.reload(); return; }
        openSet.add(sym);
        const w = ctx.state.watchlist.find((x) => x.symbol === sym);
        if (!w?.data) await loadData(sym, ctx);
        ctx.reload();
      };
    });

    root.querySelectorAll('[data-refresh]').forEach((b) => {
      b.onclick = async () => {
        requested.delete(b.dataset.refresh);
        await loadData(b.dataset.refresh, ctx);
        ctx.reload();
      };
    });

    root.querySelectorAll('[data-signin]').forEach((b) => { b.onclick = () => ctx.openAccount(); });

    root.querySelectorAll('[data-fetch-chain]').forEach((b) => {
      b.onclick = async () => {
        if (!ctx.auth.get() && ctx.auth.configured()) { ctx.openAccount(); return; }
        await fetchChain(b.dataset.fetchChain, ctx);
      };
    });
    root.querySelectorAll('[data-chain-expiry]').forEach((sel) => {
      sel.onchange = () => {
        const sym = sel.dataset.chainExpiry;
        populateFromChain(sym, ctx, sel.value);
        ctx.reload();
      };
    });

    // Manual / expiry inputs update drafts and recalc the checklist in place.
    const recalc = (sym) => {
      const host = root.querySelector(`#checklist-${sym}`);
      const w = ctx.state.watchlist.find((x) => x.symbol === sym);
      if (host && w) host.innerHTML = checklistHtml(w, ctx);
    };
    root.querySelectorAll('[data-manual],[data-expiry]').forEach((el) => {
      el.onchange = () => {
        const sym = el.dataset.manual || el.dataset.expiry;
        const draft = drafts.get(sym);
        if (!draft) return;
        if (el.dataset.expiry) draft.expiry = el.value;
        else draft[el.dataset.k] = el.value;
        recalc(sym);
      };
    });
    root.querySelectorAll('[data-cand]').forEach((el) => {
      el.oninput = () => {
        const draft = drafts.get(el.dataset.cand);
        if (!draft) return;
        draft.candidates[Number(el.dataset.i)][el.dataset.k] = el.value;
      };
      el.onchange = () => recalc(el.dataset.cand);
    });
    root.querySelectorAll('[data-use]').forEach((b) => {
      b.onclick = () => {
        const draft = drafts.get(b.dataset.use);
        draft.active = Number(b.dataset.i);
        ctx.reload();
      };
    });
    root.querySelectorAll('[data-remove-row]').forEach((b) => {
      b.onclick = () => {
        const draft = drafts.get(b.dataset.removeRow);
        if (draft.candidates.length <= 1) return;
        draft.candidates.splice(Number(b.dataset.i), 1);
        draft.active = 0;
        ctx.reload();
      };
    });
    root.querySelectorAll('[data-add-row]').forEach((b) => {
      b.onclick = () => {
        drafts.get(b.dataset.addRow).candidates.push({ strike: '', bid: '', ask: '', delta: '', oi: '', volume: '', ivRank: '', iv: '' });
        ctx.reload();
      };
    });
    root.querySelectorAll('[data-save-notes]').forEach((b) => {
      b.onclick = () => {
        const sym = b.dataset.saveNotes;
        const area = root.querySelector(`[data-notes="${sym}"]`);
        ctx.actions.updateWatch(sym, { notes: area.value });
        toast('Notes saved.');
      };
    });
    root.querySelectorAll('[data-remove]').forEach((b) => {
      b.onclick = async () => {
        if (await ctx.confirm(`Remove ${b.dataset.remove} from the watchlist?`)) {
          ctx.actions.removeWatch(b.dataset.remove);
          drafts.delete(b.dataset.remove);
          openSet.delete(b.dataset.remove);
          ctx.reload();
        }
      };
    });
    root.querySelectorAll('[data-open-wheel]').forEach((b) => {
      b.onclick = () => {
        const sym = b.dataset.openWheel;
        const draft = drafts.get(sym);
        const opt = activeOption(ctx.state.watchlist.find((x) => x.symbol === sym), draft);
        const p = new URLSearchParams({ symbol: sym });
        if (opt) {
          p.set('strike', opt.strike);
          if (opt.expiry) p.set('expiry', opt.expiry);
          if (opt.mid) p.set('premium', opt.mid);
          if (opt.delta) p.set('delta', opt.delta);
          if (opt.openInterest) p.set('oi', opt.openInterest);
        }
        ctx.go(`/new?${p.toString()}`);
      };
    });

    // Auto-load any open ticker that has no data yet.
    if (openSet.size) loadAll(ctx);
  },
};

async function loadData(sym, ctx) {
  const w = ctx.state.watchlist.find((x) => x.symbol === sym);
  if (!w) return;
  requested.add(sym);
  if (!ctx.auth.get() && ctx.auth.configured()) {
    ctx.actions.updateWatch(sym, { data: { available: false, authRequired: true, messages: ['Sign in to load live market data.'] } });
    return;
  }
  try {
    const data = await ctx.providers.loadTickerData(sym, ctx.auth.token());
    if (data?.quote?.price != null) ctx.actions.setMark(sym, data.quote.price);
    ctx.actions.updateWatch(sym, { data });
    if (data?.quote?.price == null && data?.messages?.length) toast(`${sym}: ${data.messages[0]}`, 'warn');
  } catch (err) {
    toast(`Could not load ${sym}: ${err.message}`, 'error');
  }
}

function loadAll(ctx) {
  for (const sym of openSet) {
    const w = ctx.state.watchlist.find((x) => x.symbol === sym);
    if (w && !w.data && !requested.has(sym)) {
      loadData(sym, ctx).then(() => ctx.reload());
    }
  }
}
