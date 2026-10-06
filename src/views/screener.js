import { buildChecklistContext, evaluateChecklist, CHECKLIST_GROUPS, STATUS_META } from '../checklist.js';
import { mergeSettings, putMetrics, DEFAULT_SETTINGS } from '../calc.js';
import { money, pct, escapeHtml, dte, fmtInZone, localTimeZone, toDMY, parseDMY } from '../format.js';
import { badge, tip, toast, chartColors, openModal } from '../ui.js';

const openSet = new Set();
const drafts = new Map();
const requested = new Set();
const chains = new Map();
const chainLoading = new Set();
// Curated, generally affordable and liquid ideas. The scan still checks each
// one live (price, profitability, earnings, greeks) and ranks what fits.
const IDEA_GROUPS = {
  income: {
    label: 'Safe income ideas',
    symbols: ['T', 'VZ', 'PFE', 'KMI', 'F', 'INTC', 'KHC', 'VFC', 'USB', 'FITB', 'KEY', 'HBAN'],
  },
  etf: {
    label: 'ETFs',
    symbols: ['XLF', 'KRE', 'KBE', 'EEM', 'EWZ', 'FXI', 'VWO', 'SLV', 'GDX', 'ARKK', 'KWEB', 'XOP'],
  },
  speculative: {
    label: 'Cheaper / higher risk',
    symbols: ['ACHR', 'SOFI', 'RIVN', 'LCID', 'NIO', 'SNAP', 'WBD', 'VTRS', 'XRX', 'NWL', 'APA', 'WBA'],
  },
};
const QUICK_SEEDS = ['T', 'VZ', 'PFE', 'KMI', 'F', 'INTC', 'XLF', 'EEM', 'ACHR'];
const scanState = { running: false, results: [], progress: '', group: '', total: 0, done: 0, log: [] };
let scanShowAvoid = false;
let scanExpanded = true;

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
      price: w.manual?.price ?? '',
      marketCap: w.manual?.marketCap ?? '',
      epsTTM: w.manual?.epsTTM ?? '',
      avgVolume: w.manual?.avgVolume ?? '',
      priceVsMa200: w.manual?.priceVsMa200 ?? '',
      nextEarnings: w.manual?.nextEarnings ?? '',
      exDividend: w.manual?.exDividend ?? '',
      dividendAmount: w.manual?.dividendAmount ?? '',
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

// Pick an expiry in the 25–60 DTE window, preferring the most liquid one
// (highest put open interest) with a tie-break near 40 DTE. Thin weeklies can
// otherwise make open-interest checks fail for no good reason.
function pickExpiry(expirations, rows, nextEarnings) {
  const scored = expirations
    .map((e) => ({ e, d: dte(e) }))
    .filter((x) => x.d != null && x.d > 0);
  if (!scored.length) return expirations[0] || '';
  // "No earnings before expiration" means the option must expire BEFORE the
  // next earnings date, so prefer expiries that fall on/before earnings.
  let candidates = scored;
  if (nextEarnings && /^\d{4}-\d{2}-\d{2}$/.test(nextEarnings)) {
    const before = scored.filter((x) => x.e < nextEarnings); // expires before earnings
    if (before.length) candidates = before;
  }
  const preferred = candidates.filter((x) => x.d >= 25 && x.d <= 55);
  const pool = preferred.length ? preferred : candidates;
  if (Array.isArray(rows) && rows.length) {
    const oiByExp = new Map();
    for (const r of rows) {
      if (r.type !== 'put' || r.delta == null) continue;
      const a = Math.abs(r.delta);
      if (a < 0.05 || a > 0.6) continue;
      oiByExp.set(r.expiry, (oiByExp.get(r.expiry) || 0) + (Number(r.openInterest) || 0));
    }
    if ([...oiByExp.values()].some((v) => v > 0)) {
      pool.sort((a, b) => (oiByExp.get(b.e) || 0) - (oiByExp.get(a.e) || 0) || Math.abs(a.d - 40) - Math.abs(b.d - 40));
      return pool[0].e;
    }
  }
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
  const base = chain.rows
    .filter((r) => r.type === 'put' && r.expiry === expiry)
    .filter((r) => r.strike && (r.bid > 0 || r.mid > 0))
    .filter((r) => r.delta !== null && Math.abs(r.delta) >= 0.08 && Math.abs(r.delta) <= 0.4)
    .filter((r) => r.strike * 100 <= maxCollateral);
  const withOi = base.filter((r) => (Number(r.openInterest) || 0) > 0);
  const ranked = (withOi.length ? withOi : base)
    .sort((a, b) => Math.abs(Math.abs(a.delta) - 0.22) - Math.abs(Math.abs(b.delta) - 0.22))
    .slice(0, 8)
    .sort((a, b) => b.strike - a.strike);
  const rows = ranked.length ? ranked : chain.rows.filter((r) => r.type === 'put' && r.expiry === expiry).slice(0, 6);
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
      const w = ctx.state.watchlist.find((x) => x.symbol === sym);
      populateFromChain(sym, ctx, pickExpiry(res.data.expirations, res.data.rows, w?.data?.earnings?.nextDate));
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

// ---- Auto-scan & rank -----------------------------------------------------

function bestPut(chain, expiry, ctx) {
  const s = mergeSettings(ctx.state.settings);
  const maxColl = ctx.account.budget * s.maxPerWheelPct;
  const puts = chain.rows.filter((r) => r.type === 'put' && r.expiry === expiry && r.strike && (r.bid > 0 || r.mid > 0) && r.delta != null && r.strike * 100 <= maxColl);
  const withOi = puts.filter((r) => (Number(r.openInterest) || 0) > 0);
  const pool = withOi.length ? withOi : puts.length ? puts : chain.rows.filter((r) => r.type === 'put' && r.expiry === expiry && r.delta != null && r.strike);
  if (!pool.length) return null;
  pool.sort((a, b) => Math.abs(Math.abs(a.delta) - 0.22) - Math.abs(Math.abs(b.delta) - 0.22));
  const r = pool[0];
  return { strike: r.strike, bid: r.bid, ask: r.ask, mid: r.mid, delta: r.delta, openInterest: r.openInterest, volume: r.volume, iv: r.iv, expiry, dte: dte(expiry), affordable: r.strike * 100 <= maxColl };
}

function scanScore(result) {
  return result.passCount * 2 - result.failCount * 3 - result.criticalFails.length * 10 - result.unknownCount * 0.3;
}

function scanLogLine(text) {
  scanState.log.push(text);
  if (scanState.log.length > 60) scanState.log = scanState.log.slice(-60);
}

async function runScan(ctx, symbols, label = '') {
  scanState.running = true;
  scanExpanded = true;
  scanState.results = [];
  scanState.log = [];
  scanState.total = symbols.length;
  scanState.done = 0;
  scanState.group = label;
  scanState.progress = `Starting scan: ${label || 'custom list'}…`;
  ctx.reload(); // render the progress bar and disable the buttons
  paintProgress();
  const marks = {};
  await new Promise((r) => setTimeout(r, 150));

  let i = 0;
  for (const sym of symbols) {
    i += 1;
    scanState.progress = `Loading ${sym} (${i}/${symbols.length}) — fundamentals…`;
    paintProgress();
    scanLogLine(`→ ${sym}: fetching fundamentals`);
    try {
      // Slim fetch (skip dividends, Nasdaq candles) keeps us inside the free
      // Finnhub rate limit while scanning many tickers.
      const data = await ctx.providers.loadTickerData(sym, ctx.auth.token(), { slim: true, candlesSource: 'nasdaq' });
      if (data?.quote?.price != null) marks[sym] = data.quote.price;
      const epsVal = data?.metrics?.epsTTMFromQuarters ?? data?.metrics?.epsTTM;
      scanLogLine(`  ${sym}: price ${data?.quote?.price != null ? money(data.quote.price) : 'n/a'}, EPS ${epsVal != null ? Number(epsVal).toFixed(2) : 'n/a'}, earnings ${data?.earnings?.nextDate ? toDMY(data.earnings.nextDate) : 'unknown'}`);
      scanState.progress = `Loading ${sym} (${i}/${symbols.length}) — option chain…`;
      paintProgress();
      let option = null;
      let provider = null;
      const optRes = await ctx.providers.loadOptions(sym, '', ctx.auth.token());
      if (optRes?.status === 'ok' && optRes.data?.rows?.length) {
        provider = optRes.provider;
        option = bestPut(optRes.data, pickExpiry(optRes.data.expirations, optRes.data.rows, data?.earnings?.nextDate), ctx);
        if (option) option.provider = provider;
        scanLogLine(`  ${sym}: chain from ${provider} (${optRes.data.rows.length} contracts)${option ? `, best put $${option.strike} Δ${Math.abs(option.delta).toFixed(2)} OI ${option.openInterest ?? '—'}` : ', no affordable strike'}`);
      } else {
        scanLogLine(`  ${sym}: no free chain — option items left unverified`);
      }
      const context = buildChecklistContext({ state: ctx.state, data, option, manual: {}, settings: ctx.state.settings });
      const result = evaluateChecklist(context);
      const reasons = [...result.items.filter((x) => x.status === 'fail').map((x) => `${x.id} ${x.label}`)].slice(0, 2).join('; ');
      scanLogLine(`✓ ${sym}: ${result.score} · ${result.verdict.label}${reasons ? ` (${reasons})` : ''}`);
      scanState.results.push({ sym, price: data?.quote?.price ?? null, option, result, provider, score: scanScore(result) });
    } catch (err) {
      scanLogLine(`✗ ${sym}: ${err.message}`);
      scanState.results.push({ sym, error: err.message, result: null, score: -999 });
    }
    scanState.done = i;
    paintProgress();
    await new Promise((r) => setTimeout(r, 350));
  }
  if (Object.keys(marks).length) ctx.actions.setMarks(marks);
  scanState.results.sort((a, b) => b.score - a.score);
  const usable = scanState.results.filter((r) => r.result && r.result.verdict.key !== 'avoid').length;
  scanState.progress = `Done — ${scanState.results.length} checked, ${usable} worth a closer look.`;
  scanLogLine(`— Scan complete: ${scanState.results.length} checked, ${usable} not "Avoid".`);
  scanState.running = false;
  ctx.reload();
}

function paintProgress() {
  const total = scanState.total || 0;
  const pct = total ? Math.round((scanState.done / total) * 100) : (scanState.running ? 4 : 0);
  const bar = document.getElementById('scanBar');
  if (bar) {
    bar.style.width = `${pct}%`;
    bar.style.transition = 'width .3s';
  }
  const p = document.getElementById('scanProgress');
  if (p) p.textContent = scanState.progress || '';
  const c = document.getElementById('scanCount');
  if (c) c.textContent = total ? `${scanState.done}/${total}` : '';
  const log = document.getElementById('scanLog');
  if (log) {
    log.innerHTML = scanState.log.slice(-18).map((l) => `<div>${escapeHtml(l)}</div>`).join('');
    log.scrollTop = log.scrollHeight;
  }
}

function scanWhy(r) {
  if (!r.result) return '';
  const fails = r.result.items.filter((x) => x.status === 'fail').map((x) => `${x.id} ${x.label}`);
  const warns = r.result.items.filter((x) => x.status === 'warn').map((x) => `${x.id} ${x.label}`);
  const list = [...fails, ...warns].slice(0, 3);
  return list.length ? list.join(' · ') : 'No failing items — confirm the manual items (A6/A7, C12).';
}

function scanResultsTable(ctx) {
  if (!scanState.results.length) return '';
  const usable = scanState.results.filter((r) => r.result && r.result.verdict.key !== 'avoid');
  const avoided = scanState.results.filter((r) => r.result && r.result.verdict.key === 'avoid');
  const rows = scanShowAvoid ? scanState.results : (usable.length ? usable : avoided);
  const hiddenNote = !scanShowAvoid && usable.length === 0 && avoided.length
    ? `<div class="notice info" style="margin-top:10px">All ${avoided.length} candidates were "Avoid". <label class="checkline" style="display:inline-flex"><input type="checkbox" id="scanShowAvoidInline" ${scanShowAvoid ? 'checked' : ''}/> Show them with the reasons</label></div>`
    : '';
  return `${hiddenNote}<div class="table-wrap mt"><table class="table"><thead><tr>
    <th>#</th><th>Ticker</th><th class="num">Price</th><th class="num">Score</th><th>Checklist</th><th>Verdict</th>
    <th>Best put</th><th class="num">Net premium</th><th class="num">Ann.</th><th class="num">DTE</th><th>Why / notes</th><th></th>
  </tr></thead><tbody>
  ${rows.map((r, i) => {
    if (r.error) return `<tr><td>${i + 1}</td><td class="sym">${escapeHtml(r.sym)}</td><td colspan="11" class="muted">${escapeHtml(r.error)}</td></tr>`;
    const o = r.option;
    const m = o ? putMetrics({ strike: o.strike, mid: o.mid, bid: o.bid, ask: o.ask, contracts: 1, commission: mergeSettings(ctx.state.settings).commission, daysToExpiry: o.dte, delta: o.delta }) : null;
    const vc = r.result.verdict.className === 'pass' ? 'pass' : r.result.verdict.className === 'warn' ? 'warn' : 'fail';
    return `<tr>
      <td>${i + 1}</td>
      <td class="sym">${escapeHtml(r.sym)}</td>
      <td class="num">${r.price != null ? money(r.price) : '—'}</td>
      <td class="num"><b>${r.score.toFixed(0)}</b></td>
      <td>${r.result.score}</td>
      <td>${badge(vc, r.result.verdict.label)}</td>
      <td>${o ? `$${o.strike} · Δ${Math.abs(o.delta).toFixed(2)}${!o.affordable ? ' ⚠︎' : ''}` : '—'}</td>
      <td class="num">${m ? money(m.netPremium) : '—'}</td>
      <td class="num">${m?.annualized != null ? pct(m.annualized) : '—'}</td>
      <td class="num">${o?.dte ?? '—'}</td>
      <td class="muted" style="font-size:12px;min-width:220px">${escapeHtml(scanWhy(r))}</td>
      <td>${o ? `<button class="btn btn-primary btn-sm" data-scan-open="${escapeHtml(r.sym)}" data-strike="${o.strike}" data-expiry="${o.expiry}" data-premium="${o.mid ?? ''}" data-delta="${o.delta}" data-oi="${o.openInterest ?? ''}">Open wheel →</button>` : ''}</td>
    </tr>`;
  }).join('')}
  </tbody></table></div>
  <p class="muted" style="font-size:12px;margin-top:8px">Score = passes minus fails/unknowns. Manual items (A6/A7) and IV Rank count as unknown in a scan, so open a ticker to confirm them. ⚠︎ means the strike is above your per-wheel limit. Showing ${rows.length} of ${scanState.results.length}.</p>`;
}

function sparklineSvg(closes, ma200) {
  if (!Array.isArray(closes) || closes.length < 5) return '';
  const w = 560;
  const h = 96;
  const pad = 6;
  const vals = [...closes];
  if (ma200) vals.push(ma200);
  const min = Math.min(...vals);
  const max = Math.max(...vals);
  const span = max - min || 1;
  const x = (i) => pad + (i * (w - 2 * pad)) / (closes.length - 1);
  const y = (v) => h - pad - ((v - min) / span) * (h - 2 * pad);
  const pts = closes.map((c, i) => `${x(i).toFixed(1)},${y(c).toFixed(1)}`).join(' ');
  const up = closes[closes.length - 1] >= closes[0];
  const maY = ma200 ? y(ma200).toFixed(1) : null;
  return `<svg viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" style="width:100%;height:96px;display:block">
    <polyline points="${pts}" fill="none" stroke="${up ? '#0f9d6c' : '#d9534f'}" stroke-width="2" stroke-linejoin="round" />
    ${ma200 ? `<line x1="${pad}" y1="${maY}" x2="${w - pad}" y2="${maY}" stroke="#3b6fe0" stroke-dasharray="5 4" stroke-width="1.5" /><text x="${w - pad}" y="${Number(maY) - 4}" text-anchor="end" font-size="11" fill="#3b6fe0">200-DMA ${ma200.toFixed(2)}</text>` : ''}
  </svg>`;
}

function manualField(sym, key, label, code, url, draft, placeholder = '') {
  return `<div class="field" data-field-key="${key}"><label>${escapeHtml(label)} <span class="pill" style="font-size:10px">${escapeHtml(code)}</span> <a href="${url}" target="_blank" rel="noopener" style="font-weight:600;text-transform:none;letter-spacing:0">find ↗</a></label>
    <input data-manual="${sym}" data-k="${key}" value="${escapeHtml(draft[key] ?? '')}" placeholder="${escapeHtml(placeholder)}" /></div>`;
}

const MANUAL_KEYS = ['happyToOwn', 'notMeme', 'trendOverride', 'ivRank', 'price', 'marketCap', 'epsTTM', 'avgVolume', 'priceVsMa200', 'nextEarnings', 'exDividend', 'dividendAmount'];

function manualSnapshot(draft) {
  const out = {};
  for (const k of MANUAL_KEYS) out[k] = draft[k];
  return out;
}

let saveTimer = null;
function scheduleSave(sym, ctx) {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    const d = drafts.get(sym);
    if (!d) return;
    ctx.actions.updateWatchQuiet(sym, { manual: manualSnapshot(d), candidates: d.candidates, activeCandidate: d.active, option: { expiry: d.expiry } });
  }, 600);
}

// Scroll to the matching manual field, highlight it, and focus it.
function focusManualField(sym, key, root) {
  const el = root.querySelector(`[data-manual="${sym}"][data-k="${key}"]`);
  if (!el) return;
  const field = el.closest('.field');
  el.scrollIntoView({ behavior: 'smooth', block: 'center' });
  field?.classList.add('flash');
  setTimeout(() => el.focus({ preventScroll: true }), 250);
  const clear = () => field?.classList.remove('flash');
  el.addEventListener('input', () => setTimeout(clear, 500), { once: true });
  setTimeout(clear, 8000);
}

// Let the user consciously override any Borderline / Fail / Not-verified item.
function openOverride(ctx, sym, id) {
  const w = ctx.state.watchlist.find((x) => x.symbol === sym);
  const existing = w?.overrides?.[id];
  openModal(`Override checklist item ${id}`, `
    <p class="muted">Only override after checking it yourself. Your reason is saved with this ticker and shown on the item.</p>
    <div class="field"><label>Set to</label>
      <select id="ovStatus">
        <option value="pass" ${existing?.status === 'pass' ? 'selected' : ''}>Pass (accept it)</option>
        <option value="warn" ${existing?.status === 'warn' ? 'selected' : ''}>Borderline (accept, keep a warning)</option>
      </select></div>
    <div class="field"><label>Reason (required)</label>
      <textarea id="ovReason" placeholder="e.g. verified market cap on Nasdaq / happy to own it">${escapeHtml(existing?.reason || '')}</textarea></div>
    <div class="row" style="justify-content:flex-end;gap:8px">
      ${existing ? '<button class="btn btn-secondary" id="ovClear">Clear override</button>' : ''}
      <button class="btn btn-primary" id="ovSave">Save override</button>
    </div>`, (body, close) => {
    body.querySelector('#ovSave').onclick = () => {
      const status = body.querySelector('#ovStatus').value;
      const reason = body.querySelector('#ovReason').value.trim();
      if (!reason) { toast('Please write a short reason for the override.', 'warn'); return; }
      const overrides = { ...(w?.overrides || {}), [id]: { status, reason, at: new Date().toISOString() } };
      ctx.actions.updateWatchQuiet(sym, { overrides });
      close();
      toast(`Override saved for ${id}.`);
      ctx.reload();
    };
    body.querySelector('#ovClear')?.addEventListener('click', () => {
      const overrides = { ...(w?.overrides || {}) };
      delete overrides[id];
      ctx.actions.updateWatchQuiet(sym, { overrides });
      close();
      toast('Override cleared.');
      ctx.reload();
    });
  });
}

function openWheelFromSetup(sym, ctx) {
  const draft = drafts.get(sym);
  const w = ctx.state.watchlist.find((x) => x.symbol === sym);
  const opt = activeOption(w, draft);
  const p = new URLSearchParams({ symbol: sym });
  if (opt) {
    p.set('strike', opt.strike);
    if (opt.expiry) p.set('expiry', opt.expiry);
    if (opt.mid) p.set('premium', opt.mid);
    if (opt.delta) p.set('delta', opt.delta);
    if (opt.openInterest) p.set('oi', opt.openInterest);
  }
  ctx.go(`/new?${p.toString()}`);
}

function dataLinks(sym) {
  const s = encodeURIComponent(sym);
  const sl = encodeURIComponent(sym.toLowerCase());
  return {
    quote: `https://finance.yahoo.com/quote/${s}`,
    stats: `https://finance.yahoo.com/quote/${s}/key-statistics`,
    chart: `https://www.tradingview.com/chart/?symbol=${s}`,
    stockcharts: `https://stockcharts.com/h-sc/ui?s=${s}`,
    finviz: `https://finviz.com/quote.ashx?t=${s}`,
    earnings: `https://www.nasdaq.com/market-activity/stocks/${sl}/earnings`,
    dividends: `https://www.nasdaq.com/market-activity/stocks/${sl}/dividend-history`,
    options: `https://finance.yahoo.com/quote/${s}/options`,
  };
}

function checklistHtml(w, ctx) {
  const draft = draftFor(w);
  const option = activeOption(w, draft);
  const manual = {
    happyToOwn: draft.happyToOwn === 'yes' ? true : draft.happyToOwn === 'no' ? false : null,
    notMeme: draft.notMeme === 'yes' ? true : draft.notMeme === 'no' ? false : null,
    trendOverride: draft.trendOverride || null,
    ivRank: draft.ivRank === '' ? null : Number(draft.ivRank),
    price: draft.price === '' ? null : draft.price,
    marketCap: draft.marketCap === '' ? null : draft.marketCap,
    epsTTM: draft.epsTTM === '' ? null : draft.epsTTM,
    avgVolume: draft.avgVolume === '' ? null : draft.avgVolume,
    priceVsMa200: draft.priceVsMa200 === '' ? null : draft.priceVsMa200,
    nextEarnings: draft.nextEarnings === '' ? null : draft.nextEarnings,
    exDividend: draft.exDividend === '' ? null : draft.exDividend,
    dividendAmount: draft.dividendAmount === '' ? null : draft.dividendAmount,
  };
  const context = buildChecklistContext({ state: ctx.state, data: w.data, option, manual, settings: ctx.state.settings, overrides: w.overrides });
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
          <div class="check-detail">${escapeHtml(i.detail || i.meta.label)}${i.link ? ` <a href="${i.link}" target="_blank" rel="noopener" style="font-weight:600;white-space:nowrap">find ↗</a>` : ''}</div>
          ${i.manualField && i.status !== 'pass' ? `<button class="btn btn-ghost btn-sm" data-manual-entry="${i.manualField}" data-sym="${w.symbol}" style="padding:2px 8px;margin-top:4px">✎ manual entry ↓</button>` : ''}
          ${i.overridden ? `<button class="btn btn-ghost btn-sm" data-override="${i.id}" data-sym="${w.symbol}" style="padding:2px 8px;margin-top:4px">↺ clear override</button>` : (i.status !== 'pass' ? `<button class="btn btn-ghost btn-sm" data-override="${i.id}" data-sym="${w.symbol}" style="padding:2px 8px;margin-top:4px">✔ override</button>` : '')}</div>
          <span class="badge ${i.status}">${escapeHtml(i.meta.label)}${i.overridden ? ' (override)' : ''}</span>
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
  const authBanner = '';
  const links = dataLinks(w.symbol);
  const eff = (k, v) => (draft[k] !== '' && draft[k] !== undefined && draft[k] !== null ? draft[k] : v);
  const closes = data?.raw?.candles?.data?.closes;
  const ma200 = data?.raw?.candles?.data?.ma200 ?? null;
  const vsMa = eff('priceVsMa200', data?.priceVsMa200);
  const div = data?.dividends?.next;
  const divEx = eff('exDividend', div?.exDate);
  const divAmt = draft.dividendAmount !== '' ? draft.dividendAmount : div?.amount;
  const divEst = !draft.exDividend && div?.estimated;

  return `
    <div class="grid grid-3" style="margin-bottom:8px">
      <div class="kv"><span>Price</span><span>${eff('price', data?.quote?.price) != null ? money(eff('price', data?.quote?.price)) : '—'}</span></div>
      <div class="kv"><span>Market cap</span><span>${eff('marketCap', data?.profile?.marketCap) != null ? money(eff('marketCap', data?.profile?.marketCap), 'USD', 0) : '—'}</span></div>
      <div class="kv"><span>TTM EPS <span class="muted">(last 4 quarters)</span></span><span>${(() => {
        const manualEps = draft.epsTTM !== '' ? draft.epsTTM : null;
        const quarterly = data?.metrics?.epsTTMFromQuarters;
        const vendor = data?.metrics?.epsTTM;
        const primary = manualEps ?? quarterly ?? vendor;
        if (primary == null) return '—';
        const note = !manualEps && quarterly != null && vendor != null && Math.abs(Number(quarterly) - Number(vendor)) >= 0.01 ? ` <span class="muted" title="provider TTM">(vendor ${Number(vendor).toFixed(2)})</span>` : '';
        return `${Number.isFinite(Number(primary)) ? Number(primary).toFixed(2) : fmt(primary)}${note}`;
      })()}</span></div>
      <div class="kv"><span>Avg volume</span><span>${eff('avgVolume', data?.metrics?.avgVolume) != null ? `${(Number(eff('avgVolume', data?.metrics?.avgVolume)) / 1e6).toFixed(2)}M` : '—'}</span></div>
      <div class="kv"><span>52-week range</span><span>${data?.metrics?.low52 != null && data?.metrics?.high52 != null ? `${money(data.metrics.low52)} – ${money(data.metrics.high52)}` : '—'}</span></div>
      <div class="kv"><span>Price vs 200-DMA</span><span>${vsMa != null ? `${Number(vsMa) >= 0 ? '+' : ''}${Number(vsMa).toFixed(1)}%` : '—'}</span></div>
      <div class="kv"><span>Next earnings</span><span>${eff('nextEarnings', data?.earnings?.nextDate) ? `${toDMY(eff('nextEarnings', data?.earnings?.nextDate))}${data?.earnings?.daysUntil != null && draft.nextEarnings === '' ? ` (in ${data.earnings.daysUntil}d)` : ''}` : '—'}</span></div>
      <div class="kv"><span>Next ex-dividend</span><span>${divEx ? `${toDMY(divEx)}${divAmt ? ` · ${money(divAmt)}` : ''}${divEst ? ' (est.)' : ''}` : '—'}</span></div>
      <div class="kv"><span>Industry</span><span>${escapeHtml(data?.profile?.industry || '—')}</span></div>
    </div>
    <div class="source-line">${sourceLine}</div>
    ${authBanner}
    ${data?.messages?.length ? `<div class="notice info" style="margin-top:10px">${escapeHtml(data.messages.join(' '))}</div>` : ''}

    <div class="card-head" style="margin-top:16px"><h4>Price trend (200-day)</h4>
      <span class="link-list"><a href="${links.chart}" target="_blank" rel="noopener">TradingView ↗</a><a href="${links.stockcharts}" target="_blank" rel="noopener">StockCharts ↗</a><a href="${links.quote}" target="_blank" rel="noopener">Yahoo ↗</a></span></div>
    ${closes?.length ? `${sparklineSvg(closes, ma200)}<p class="muted" style="font-size:12px;margin:6px 0 0">${ma200 ? `${Number(eff('price', data?.quote?.price)) >= ma200 ? 'Above' : 'Below'} the 200-day average — item A4 is judged from this.` : 'Last ~120 daily closes.'}</p>`
      : `<div class="notice info" style="margin:0">Historical prices were unavailable from the free sources. <a href="${links.chart}" target="_blank" rel="noopener">Open the chart ↗</a> to check the trend, then enter the % vs 200-DMA below or write an override reason.</div>`}

    <div class="card-head" style="margin-top:18px"><h4>Manual / override values</h4><span class="muted" style="font-size:12px">Optional. Manual values override fetched data, feed the checklist, and auto-save as you type. Codes match the checklist items.</span></div>
    <div class="grid grid-3">
      ${manualField(w.symbol, 'price', 'Price', 'A1', links.quote, draft, '61.20')}
      ${manualField(w.symbol, 'marketCap', 'Market cap ($)', 'A2', links.stats, draft, '260000000000')}
      ${manualField(w.symbol, 'epsTTM', 'TTM EPS (diluted)', 'A3', links.stats, draft, '2.40')}
      ${manualField(w.symbol, 'priceVsMa200', 'Price vs 200-DMA (%)', 'A4', links.chart, draft, '+3.5 or -6')}
      ${manualField(w.symbol, 'avgVolume', 'Average daily volume', 'A5', links.stats, draft, '14000000')}
      ${manualField(w.symbol, 'ivRank', 'IV Rank (0–100)', 'C12', links.options, draft, '45')}
      ${manualField(w.symbol, 'nextEarnings', 'Next earnings date', 'C14', links.earnings, draft, 'DD/MM/YYYY')}
      ${manualField(w.symbol, 'exDividend', 'Next ex-dividend date', 'C15', links.dividends, draft, 'DD/MM/YYYY')}
      ${manualField(w.symbol, 'dividendAmount', 'Dividend per share ($)', 'C15', links.dividends, draft, '0.27')}
    </div>

    <div class="grid grid-3 mt">
      <div class="field" data-field-key="happyToOwn"><label>Would you happily own 100 shares at this price? <span class="pill" style="font-size:10px">A7</span></label>
        <select data-manual="${w.symbol}" data-k="happyToOwn">
          <option value="">Choose…</option>
          <option value="yes" ${draft.happyToOwn === 'yes' ? 'selected' : ''}>Yes, I'd own it for months</option>
          <option value="no" ${draft.happyToOwn === 'no' ? 'selected' : ''}>No</option>
        </select></div>
      <div class="field" data-field-key="notMeme"><label>Confirmed not a meme / IPO / binary biotech / leveraged ETF? <span class="pill" style="font-size:10px">A6</span></label>
        <select data-manual="${w.symbol}" data-k="notMeme">
          <option value="">Choose…</option>
          <option value="yes" ${draft.notMeme === 'yes' ? 'selected' : ''}>Confirmed normal company/ETF</option>
          <option value="no" ${draft.notMeme === 'no' ? 'selected' : ''}>It is one of those</option>
        </select></div>
      <div class="field" data-field-key="trendOverride"><label>200-DMA override <span class="pill" style="font-size:10px">A4</span> <span class="hint">(only if the chart data is missing)</span></label>
        <input data-manual="${w.symbol}" data-k="trendOverride" value="${escapeHtml(draft.trendOverride)}" placeholder="e.g. long-term uptrend intact" /></div>
    </div>

    <div class="card-head" style="margin-top:14px"><h4>${tip('Strike picker', 'Load a free delayed CBOE option chain (with greeks), or type values from your IBKR screen.')}</h4>
      <div class="row" style="gap:8px">
        <button class="btn btn-primary btn-sm" data-fetch-chain="${w.symbol}" ${chainLoading.has(w.symbol) ? 'disabled' : ''}>${chainLoading.has(w.symbol) ? 'Loading…' : '⤓ Load free chain (greeks)'}</button>
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
      <div class="field"><label>Chain source</label><input value="${chainLoading.has(w.symbol) ? 'Loading…' : chains.has(w.symbol) ? `Free delayed chain loaded (${escapeHtml(String(chains.get(w.symbol).rows.length))} contracts)` : 'Not loaded — press the button above'}" disabled /></div>
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

    return `
      <div class="card">
        <div class="card-head">
          <div><h2>Find a put to sell</h2><p class="muted">Type a ticker, load its free metrics, and let the checklist tell you whether it is safe. Data is never invented — unverified items stay "Not verified".</p></div>
        </div>
        <div class="row" style="gap:10px;flex-wrap:wrap">
          <input id="screenerInput" placeholder="Ticker (e.g. KO)" style="max-width:220px" />
          <button class="btn btn-primary" id="screenerAdd">Add / load</button>
          <span class="muted" style="font-size:12px">Starting ideas (must pass the checklist with live data):</span>
          <span class="chip-row">${QUICK_SEEDS.map((s) => `<button class="chip" data-seed="${s}">${s}</button>`).join('')}</span>
        </div>
      </div>

      <div class="card mt">
        <div class="card-head">
          <div><h3>Auto-scan &amp; rank</h3><p class="muted">Loads live data and free option chains for every ticker, scores each against the checklist, and ranks the best puts to sell. Only affordable names score well. Confirm the manual items before trading.</p></div>
          <div class="row wrap" style="gap:8px">
            ${Object.entries(IDEA_GROUPS).map(([key, g]) => `<button class="btn btn-secondary btn-sm" data-scan-group="${key}" ${scanState.running ? 'disabled' : ''}>${escapeHtml(g.label)}</button>`).join('')}
            <button class="btn btn-primary btn-sm" id="scanWatch" ${scanState.running ? 'disabled' : ''}>Scan my watchlist</button>
          </div>
        </div>
        <div class="progress" style="height:8px;margin:12px 0 6px"><i id="scanBar" style="width:${scanState.total ? Math.round((scanState.done / scanState.total) * 100) : 0}%"></i></div>
        <div class="row-between" style="font-size:12.5px">
          <span id="scanProgress" class="muted">${escapeHtml(scanState.progress)}${!scanState.progress && scanState.group ? `Last scan: ${escapeHtml(scanState.group)}` : ''}</span>
          <span id="scanCount" class="muted">${scanState.total ? `${scanState.done}/${scanState.total}` : ''}</span>
        </div>
        ${(() => {
          const usable = scanState.results.filter((r) => r.result && r.result.verdict.key !== 'avoid').length;
          const summary = scanState.running
            ? `Scanning… ${scanState.done}/${scanState.total}`
            : `${usable} worth a closer look · ${scanState.results.length} checked`;
          if (!scanState.results.length && !scanState.running) return '';
          const open = scanExpanded || scanState.running;
          return `<div class="accordion ${open ? 'open' : ''}" style="margin-top:12px" id="scanAccordion">
            <div class="accordion-head" data-scan-toggle>
              <b>Scan results</b>
              <span class="muted" style="font-size:12.5px">${escapeHtml(summary)}</span>
              <span class="chev">›</span>
            </div>
            <div class="accordion-body">
              <div id="scanLog" class="scan-log">${scanState.log.slice(-18).map((l) => `<div>${escapeHtml(l)}</div>`).join('')}</div>
              <label class="checkline" style="margin-top:10px"><input type="checkbox" id="scanShowAvoid" ${scanShowAvoid ? 'checked' : ''}/> Show "Avoid" rows too (with reasons)</label>
              ${scanResultsTable(ctx)}
            </div>
          </div>`;
        })()}
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

    root.querySelectorAll('[data-scan-group]').forEach((b) => {
      b.addEventListener('click', () => {
        const g = IDEA_GROUPS[b.dataset.scanGroup];
        if (g) runScan(ctx, g.symbols, g.label);
      });
    });
    root.querySelectorAll('[data-scan-toggle]').forEach((head) => {
      head.onclick = () => { scanExpanded = !scanExpanded; ctx.reload(); };
    });
    const showAvoid = root.querySelector('#scanShowAvoid');
    if (showAvoid) showAvoid.onchange = (e) => { scanShowAvoid = e.target.checked; ctx.reload(); };
    const showAvoidInline = root.querySelector('#scanShowAvoidInline');
    if (showAvoidInline) showAvoidInline.onchange = (e) => { scanShowAvoid = e.target.checked; ctx.reload(); };
    root.querySelector('#scanWatch')?.addEventListener('click', () => {
      const watch = ctx.state.watchlist.map((w) => w.symbol);
      if (!watch.length) { toast('Your watchlist is empty — scanning the safe income ideas instead.', 'warn'); runScan(ctx, IDEA_GROUPS.income.symbols, IDEA_GROUPS.income.label); return; }
      runScan(ctx, [...new Set(watch)], 'My watchlist');
    });
    root.querySelectorAll('[data-scan-open]').forEach((b) => {
      b.onclick = () => {
        const p = new URLSearchParams({ symbol: b.dataset.scanOpen, strike: b.dataset.strike, expiry: b.dataset.expiry, premium: b.dataset.premium, delta: b.dataset.delta, oi: b.dataset.oi });
        ctx.go(`/new?${p.toString()}`);
      };
    });

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

    root.querySelectorAll('[data-signin]').forEach((b) => { b.onclick = () => ctx.openAccount(); });

    root.querySelectorAll('[data-fetch-chain]').forEach((b) => {
      b.onclick = async () => { await fetchChain(b.dataset.fetchChain, ctx); };
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
      const handle = () => {
        const sym = el.dataset.manual || el.dataset.expiry;
        const draft = drafts.get(sym);
        if (!draft) return;
        if (el.dataset.expiry) draft.expiry = el.value;
        else draft[el.dataset.k] = el.value;
        recalc(sym);
        scheduleSave(sym, ctx);
      };
      el.oninput = handle;
      el.onchange = handle;
    });
    root.querySelectorAll('[data-cand]').forEach((el) => {
      el.oninput = () => {
        const draft = drafts.get(el.dataset.cand);
        if (!draft) return;
        draft.candidates[Number(el.dataset.i)][el.dataset.k] = el.value;
        recalc(el.dataset.cand);
        scheduleSave(el.dataset.cand, ctx);
      };
      el.onchange = () => { recalc(el.dataset.cand); scheduleSave(el.dataset.cand, ctx); };
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
    // Delegated so it keeps working after the checklist is re-rendered in place.
    root.onclick = (e) => {
      const me = e.target.closest('[data-manual-entry]');
      if (me) { e.preventDefault(); focusManualField(me.dataset.sym, me.dataset.manualEntry, root); return; }
      const ov = e.target.closest('[data-override]');
      if (ov) { e.preventDefault(); openOverride(ctx, ov.dataset.sym, ov.dataset.override); return; }
      const r = e.target.closest('[data-refresh]');
      if (r) { requested.delete(r.dataset.refresh); loadData(r.dataset.refresh, ctx).then(() => ctx.reload()); return; }
      const o = e.target.closest('[data-open-wheel]');
      if (o) { openWheelFromSetup(o.dataset.openWheel, ctx); }
    };

    // Auto-load any open ticker that has no data yet.
    if (openSet.size) loadAll(ctx);
  },
};

async function loadData(sym, ctx) {
  const w = ctx.state.watchlist.find((x) => x.symbol === sym);
  if (!w) return;
  requested.add(sym);
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
