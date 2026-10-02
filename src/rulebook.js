// ---------------------------------------------------------------------------
// Floating tools: the Beginner's rule book, a "Log the close" calculator and a
// Quick reference card. Each opens from its own bottom-right button and can be
// popped into a Document Picture-in-Picture window (Chrome/Edge) to float over
// other tabs/apps.
// ---------------------------------------------------------------------------

import { escapeHtml } from './format.js';

const RULES_KEY = 'wheel-rulebook-v1';
const LOG_KEY = 'wheel-logclose-v1';

export const RULEBOOK = [
  {
    title: 'Choosing the stock',
    items: [
      { ok: true, text: "Only companies or ETFs you'd be happy to own long-term. Never pick a stock just because its premium is high — high premium means the market expects big moves (more risk)." },
      { ok: true, text: 'Liquid options: tight bid-ask spreads (a few cents wide). Large, well-known stocks and broad ETFs are best.' },
      { ok: true, text: "Diversify: don't put more than ~50% of your Wheel money into one stock (use the Safest profile for ~20%)." },
      { ok: false, text: 'Avoid meme stocks, biotech, and anything that can drop 40% overnight.' },
    ],
  },
  {
    title: 'Choosing the option — look in THIS order',
    note: 'Only ever look at strikes BELOW the stock price, and one expiry at a time. Start with delta: it turns a wall of lines into a few candidates fastest.',
    items: [
      { ok: true, text: '1) Earnings date first — it must be AFTER your expiry. Check it before anything else (stocks can gap hugely).' },
      { ok: true, text: '2) Expiry: pick 30–45 days to expiry. Monthly expiries (3rd Friday) usually have the best liquidity.' },
      { ok: true, text: '3) Delta −0.15 to −0.30 (sweet spot −0.15 to −0.25). Scan down the strikes until the delta lands in range — this is your fast filter (~70–85% chance of expiring worthless).' },
      { ok: true, text: '4) Liquidity of THAT strike: Open Interest ≥ 500, then spread ≤ $0.10 AND ≤ 10% of mid (best ≤ $0.05 / 5%), then Volume ≥ 50.' },
      { ok: true, text: '5) Return: net premium ÷ collateral, then annualized (× 365 ÷ DTE). Target 10–30%.' },
      { ok: false, text: 'Stop if annualized < 10% (too little), or > 30% (something may be wrong). If nothing fits, widen DTE, try the next monthly, or pick another ticker.' },
    ],
  },
  {
    title: 'Managing the trade',
    items: [
      { ok: true, text: 'Close at ~50% profit. If you sold a put for $80 and can buy it back for $40, do it and open a new one. Selling before expiry reduces risk and frees up capital faster.' },
      { ok: true, text: "Never sell a covered call below your real cost basis, unless you've decided you're okay locking in a loss to exit the stock." },
      { ok: true, text: 'Watch ex-dividend dates when holding covered calls. Early assignment can happen the day before, and you would miss the dividend.' },
      { ok: true, text: 'Keep a journal: every trade, premium, outcome, and lesson.' },
    ],
  },
];

export const QUICK_REF = [
  ['LOOK', 'Only strikes BELOW the stock price; one expiry at a time'],
  ['SCREEN ORDER', 'Earnings → expiry → delta → OI → spread → volume → return'],
  ['DELTA', '−0.15 to −0.30 (ideal −0.15 to −0.25)'],
  ['DTE', '30–45 days, earnings AFTER expiry'],
  ['SPREAD', '≤ $0.10 AND ≤ 10% of mid (best: ≤ $0.05 / ≤ 5%)'],
  ['OI / VOLUME', 'OI ≥ 500 · Volume ≥ 50'],
  ['RETURN', '10–30% annualized'],
  ['CASH', 'Strike × 100 ≤ $5,000 · keep ≥ $1,000 free'],
  ['ORDER', 'Click BID → SELL → 1 → LMT @ mid → DAY → no Outside RTH'],
  ['TAKE PROFIT', 'GTC BUY LMT at 50% of fill price, placed right after fill'],
  ['REVIEW', 'at 21 DTE; never hold an option near the strike into expiry day'],
  ['TIME', '10:00–15:30 ET only'],
];

export const QUICK_MISTAKES = [
  'Clicking Ask instead of Bid.',
  'Using MKT orders.',
  'Choosing CALL instead of PUT.',
  'Forgetting the GTC close order.',
  'Forgetting to cancel the GTC before closing manually.',
  "Trusting IBKR's small margin number instead of your full collateral rule.",
];

// ---- persisted state ------------------------------------------------------

function load(key) {
  try { return JSON.parse(localStorage.getItem(key)) || {}; } catch { return {}; }
}
function save(key, val) {
  try { localStorage.setItem(key, JSON.stringify(val)); } catch { /* ignore */ }
}
let checks = load(RULES_KEY);
let logState = { entryFill: '0.64', closeFill: '0.32', contracts: '1', commOpen: '0.66', commClose: '0.66', dateOpen: '', dateClose: '', collateral: '4400', stockPrice: '48.10', gtcGone: false, positionGone: false, lesson: '', ...load(LOG_KEY) };

// ---- rule book ------------------------------------------------------------

function rbChecklistHtml() {
  return RULEBOOK.map((section, si) => `
    <div class="rb-section">${escapeHtml(section.title)}</div>
    ${section.note ? `<p class="muted" style="font-size:11.5px;margin:-2px 4px 6px">${escapeHtml(section.note)}</p>` : ''}
    ${section.items.map((item, ii) => {
      const key = `s${si}i${ii}`;
      return `<label class="rb-item ${item.ok ? '' : 'rb-dont'}">
        <input type="checkbox" data-rb-key="${key}" ${checks[key] ? 'checked' : ''} />
        <span class="rb-ico">${item.ok ? '✅' : '❌'}</span>
        <span class="rb-text">${escapeHtml(item.text)}</span>
      </label>`;
    }).join('')}`).join('');
}
function rbProgress() {
  const total = RULEBOOK.reduce((n, s) => n + s.items.length, 0);
  return `${Object.values(checks).filter(Boolean).length}/${total} checked`;
}
function applyRuleChecks(doc) {
  doc.querySelectorAll('[data-rb-key]').forEach((el) => { el.checked = Boolean(checks[el.dataset.rbKey]); });
  doc.querySelectorAll('[data-rb-progress]').forEach((el) => { el.textContent = rbProgress(); });
}

// ---- log the close --------------------------------------------------------

function logCalc() {
  const s = logState;
  const entry = Number(s.entryFill) || 0;
  const close = Number(s.closeFill) || 0;
  const q = Number(s.contracts) || 1;
  const fees = (Number(s.commOpen) || 0) + (Number(s.commClose) || 0);
  const gross = (entry - close) * 100 * q;
  const net = gross - fees;
  const coll = Number(s.collateral) || 0;
  const roc = coll > 0 ? (net / coll) * 100 : null;
  const days = s.dateOpen && s.dateClose ? Math.max(1, Math.round((new Date(s.dateClose) - new Date(s.dateOpen)) / 86400000)) : null;
  const annualized = roc != null && days ? (roc * 365) / days : null;
  const takeProfit = Math.floor((entry * 50) / 100 * 100) / 100;
  return { entry, close, q, fees, gross, net, roc, days, annualized, takeProfit };
}
function logContentHtml() {
  const c = logCalc();
  const f = (k) => `<input class="input-sm" data-log="${k}" value="${escapeHtml(String(logState[k] ?? ''))}" />`;
  const money = (n) => (n == null ? '—' : `$${Number(n).toFixed(2)}`);
  const pct = (n) => (n == null ? '—' : `${Number(n).toFixed(2)}%`);
  return `
    <div class="rb-section">Trade #001 — Close</div>
    <div class="log-grid">
      <label>Entry fill (sold at) ${f('entryFill')}</label>
      <label>Close fill (bought at) ${f('closeFill')}</label>
      <label>Contracts ${f('contracts')}</label>
      <label>Commission (each side) ${f('commOpen')}<span class="muted"> / </span>${f('commClose')}</label>
      <label>Date opened ${`<input class="input-sm" type="date" data-log="dateOpen" value="${escapeHtml(logState.dateOpen)}" />`}</label>
      <label>Date closed ${`<input class="input-sm" type="date" data-log="dateClose" value="${escapeHtml(logState.dateClose)}" />`}</label>
      <label>Collateral ($) ${f('collateral')}</label>
      <label>Stock price at close ${f('stockPrice')}</label>
    </div>
    <div class="log-out">
      <div class="kv"><span>Gross P&L</span><span>(${c.entry} − ${c.close}) × 100 × ${c.q} = ${money(c.gross)}</span></div>
      <div class="kv"><span>Total fees</span><span>${money(c.fees)}</span></div>
      <div class="kv"><span>NET P&L</span><span class="${c.net >= 0 ? 'positive' : 'negative'}">${money(c.net)}</span></div>
      <div class="kv"><span>Return on capital</span><span>${pct(c.roc)}</span></div>
      <div class="kv"><span>Annualized</span><span>${pct(c.annualized)}${c.days ? ` <span class="muted">(${c.days} days)</span>` : ''}</span></div>
      <div class="kv"><span>Suggested take-profit (50% of entry)</span><span>${money(c.takeProfit)}</span></div>
    </div>
    <label class="rb-item"><input type="checkbox" data-log="gtcGone" ${logState.gtcGone ? 'checked' : ''}/><span class="rb-ico">☐</span><span class="rb-text">Make sure no orders are left over under Orders. The GTC should be gone.</span></label>
    <label class="rb-item"><input type="checkbox" data-log="positionGone" ${logState.positionGone ? 'checked' : ''}/><span class="rb-ico">☐</span><span class="rb-text">Make sure the position no longer appears in Portfolio.</span></label>
    <div class="rb-section">Lesson learned</div>
    <textarea class="input-sm" data-log="lesson" style="width:100%;min-height:56px" placeholder="What would you do differently?">${escapeHtml(logState.lesson)}</textarea>`;
}

// ---- quick reference ------------------------------------------------------

function quickRefHtml() {
  return `
    <div class="rb-section">Quick reference card</div>
    ${QUICK_REF.map(([k, v]) => `<div class="kv"><span>${escapeHtml(k)}</span><span style="text-align:right">${escapeHtml(v)}</span></div>`).join('')}
    <div class="rb-section">Common mistakes to avoid</div>
    ${QUICK_MISTAKES.map((m) => `<div class="rb-item rb-dont"><span class="rb-ico">❌</span><span class="rb-text">${escapeHtml(m)}</span></div>`).join('')}`;
}

// ---- tools registry -------------------------------------------------------

const TOOLS = {
  rules: {
    icon: '📋', label: 'Rules', title: "Beginner's rule book",
    sub: () => rbProgress(),
    content: () => rbChecklistHtml(),
    footer: () => '<button class="btn btn-secondary btn-sm" data-rb-clear>Clear all</button><span class="muted" style="font-size:11px">Tick as you learn</span>',
    bind: (doc, refresh) => {
      doc.querySelectorAll('[data-rb-key]').forEach((el) => el.addEventListener('change', () => { checks[el.dataset.rbKey] = el.checked; save(RULES_KEY, checks); refresh(); }));
      doc.querySelectorAll('[data-rb-clear]').forEach((b) => b.addEventListener('click', () => { checks = {}; save(RULES_KEY, checks); refresh(); }));
      applyRuleChecks(doc);
    },
  },
  logclose: {
    icon: '🧾', label: 'Log close', title: 'Log the close',
    sub: () => 'Buy to Close · Expired · Assigned',
    content: () => logContentHtml(),
    bind: (doc, refresh) => {
      doc.querySelectorAll('[data-log]').forEach((el) => {
        el.addEventListener('input', () => { logState[el.dataset.log] = el.type === 'checkbox' ? el.checked : el.value; save(LOG_KEY, logState); });
        el.addEventListener('change', () => { logState[el.dataset.log] = el.type === 'checkbox' ? el.checked : el.value; save(LOG_KEY, logState); refresh(); });
      });
    },
  },
  quickref: {
    icon: '⚡', label: 'Quick ref', title: 'Quick reference card',
    sub: () => '',
    content: () => quickRefHtml(),
    bind: () => {},
  },
};

let pipWindow = null;
let pipTool = null;

function shellHtml(tool, withChrome) {
  return `
    <div class="rb-head">
      <div><b>${escapeHtml(tool.title)}</b>${tool.sub() ? `<div class="muted" style="font-size:11px">${escapeHtml(tool.sub())}</div>` : ''}</div>
      ${withChrome ? '<div class="row" style="gap:6px"><button class="btn btn-secondary btn-sm" data-ft-float="1">⧉ Float</button><button class="icon-btn" data-ft-close="1">×</button></div>' : ''}
    </div>
    <div class="rb-list">${tool.content()}</div>
    ${tool.footer ? `<div class="rb-foot">${tool.footer()}</div>` : ''}`;
}

function refreshAll() {
  for (const id of Object.keys(TOOLS)) {
    const panel = document.getElementById(`ftPanel-${id}`);
    if (panel && !panel.classList.contains('hidden')) {
      const tool = TOOLS[id];
      panel.innerHTML = shellHtml(tool, true);
      wirePanel(id, panel);
      tool.bind(panel, () => refreshAll());
    }
  }
  if (pipWindow && pipTool) {
    pipWindow.document.body.innerHTML = `<div class="rb-pip">${shellHtml(pipTool, false)}</div>`;
    pipTool.bind(pipWindow.document, () => refreshAll());
  }
}

function wirePanel(id, panel) {
  panel.querySelector('[data-ft-close]')?.addEventListener('click', () => panel.classList.add('hidden'));
  panel.querySelector('[data-ft-float]')?.addEventListener('click', () => openPip(id));
}

function togglePanel(id) {
  const panel = document.getElementById(`ftPanel-${id}`);
  if (!panel) return;
  const willOpen = panel.classList.contains('hidden');
  Object.keys(TOOLS).forEach((k) => document.getElementById(`ftPanel-${k}`)?.classList.add('hidden'));
  if (willOpen) {
    const tool = TOOLS[id];
    panel.innerHTML = shellHtml(tool, true);
    wirePanel(id, panel);
    tool.bind(panel, () => refreshAll());
    panel.classList.remove('hidden');
  }
}

async function openPip(id) {
  const tool = TOOLS[id];
  if (!('documentPictureInPicture' in window)) {
    window.dispatchEvent(new CustomEvent('wheel-toast', { detail: { message: 'Floating window needs Chrome or Edge. The panel still works here.', type: 'warn' } }));
    return;
  }
  try {
    pipWindow = await window.documentPictureInPicture.requestWindow({ width: 400, height: 580 });
    pipTool = tool;
    [...document.styleSheets].forEach((sheet) => {
      try {
        const css = [...sheet.cssRules].map((r) => r.cssText).join('');
        const style = pipWindow.document.createElement('style');
        style.textContent = css;
        pipWindow.document.head.appendChild(style);
      } catch {
        if (sheet.href) {
          const link = pipWindow.document.createElement('link');
          link.rel = 'stylesheet'; link.href = sheet.href;
          pipWindow.document.head.appendChild(link);
        }
      }
    });
    pipWindow.document.body.className = 'rb-pip-body';
    pipWindow.document.body.innerHTML = `<div class="rb-pip">${shellHtml(tool, false)}</div>`;
    tool.bind(pipWindow.document, () => refreshAll());
    pipWindow.addEventListener('pagehide', () => { pipWindow = null; pipTool = null; });
  } catch (err) {
    window.dispatchEvent(new CustomEvent('wheel-toast', { detail: { message: `Could not open floating window: ${err.message}`, type: 'warn' } }));
  }
}

export function mountRulebook() {
  if (document.getElementById('ftFabWrap')) return;
  const wrap = document.createElement('div');
  wrap.id = 'ftFabWrap';
  wrap.className = 'fab-stack';
  wrap.innerHTML = Object.entries(TOOLS).map(([id, t]) => `<button class="fab" data-ft-open="${id}" title="${escapeHtml(t.title)}">${t.icon}<span class="fab-label">${escapeHtml(t.label)}</span></button>`).join('');
  document.body.appendChild(wrap);
  wrap.querySelectorAll('[data-ft-open]').forEach((b) => { b.onclick = () => togglePanel(b.dataset.ftOpen); });

  // Panels (kept outside #view so they survive navigation)
  Object.keys(TOOLS).forEach((id) => {
    const panel = document.createElement('div');
    panel.id = `ftPanel-${id}`;
    panel.className = 'rb-panel hidden';
    document.body.appendChild(panel);
  });
}
