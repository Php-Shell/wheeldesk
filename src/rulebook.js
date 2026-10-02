// ---------------------------------------------------------------------------
// The Beginner's Rule Book — a global floating checklist.
// Accessible from any tab via a bottom-right floating action button. Can also
// be popped into a Document Picture-in-Picture window (Chrome/Edge) so it
// stays floating on top of other tabs/apps, like a video PiP.
// ---------------------------------------------------------------------------

import { escapeHtml } from './format.js';

const STORE_KEY = 'wheel-rulebook-v1';

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
    title: 'Choosing the option',
    items: [
      { ok: true, text: '30–45 days to expiry (DTE): the sweet spot for time decay.' },
      { ok: true, text: 'Delta ~0.15–0.30: roughly a 70–85% chance of expiring worthless. Lower delta = safer but smaller premium.' },
      { ok: false, text: 'Avoid holding through earnings announcements. Check the earnings date before you sell — stocks can gap hugely.' },
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

let checks = load();

function load() {
  try {
    return JSON.parse(localStorage.getItem(STORE_KEY)) || {};
  } catch {
    return {};
  }
}

function persist() {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(checks));
  } catch { /* ignore */ }
}

function keyOf(sectionIndex, itemIndex) {
  return `s${sectionIndex}i${itemIndex}`;
}

function checklistHtml() {
  return RULEBOOK.map((section, si) => `
    <div class="rb-section">${escapeHtml(section.title)}</div>
    ${section.items.map((item, ii) => {
      const key = keyOf(si, ii);
      return `<label class="rb-item ${item.ok ? '' : 'rb-dont'}">
        <input type="checkbox" data-rb-key="${key}" ${checks[key] ? 'checked' : ''} />
        <span class="rb-ico">${item.ok ? '✅' : '❌'}</span>
        <span class="rb-text">${escapeHtml(item.text)}</span>
      </label>`;
    }).join('')}
  `).join('');
}

function progressText() {
  const total = RULEBOOK.reduce((n, s) => n + s.items.length, 0);
  const done = Object.values(checks).filter(Boolean).length;
  return `${done}/${total} checked`;
}

function applyChecks(rootDoc) {
  const doc = rootDoc || document;
  doc.querySelectorAll('[data-rb-key]').forEach((el) => { el.checked = Boolean(checks[el.dataset.rbKey]); });
  const prog = doc.querySelectorAll('[data-rb-progress]');
  prog.forEach((el) => { el.textContent = progressText(); });
}

function bindCheckboxes(rootDoc) {
  const doc = rootDoc || document;
  doc.querySelectorAll('[data-rb-key]').forEach((el) => {
    el.addEventListener('change', () => {
      checks[el.dataset.rbKey] = el.checked;
      persist();
      applyChecks(document);
      if (pipWindow) applyChecks(pipWindow.document);
    });
  });
}

let pipWindow = null;

async function openPip() {
  if (!('documentPictureInPicture' in window)) {
    toast('Floating window needs Chrome or Edge (Document Picture-in-Picture). The panel still works here.');
    return;
  }
  try {
    pipWindow = await window.documentPictureInPicture.requestWindow({ width: 380, height: 540 });
    // Copy stylesheets so it looks identical.
    [...document.styleSheets].forEach((sheet) => {
      try {
        const css = [...sheet.cssRules].map((r) => r.cssText).join('');
        const style = pipWindow.document.createElement('style');
        style.textContent = css;
        pipWindow.document.head.appendChild(style);
      } catch {
        if (sheet.href) {
          const link = pipWindow.document.createElement('link');
          link.rel = 'stylesheet';
          link.href = sheet.href;
          pipWindow.document.head.appendChild(link);
        }
      }
    });
    pipWindow.document.body.className = 'rb-pip-body';
    pipWindow.document.body.innerHTML = `
      <div class="rb-pip">
        <div class="rb-head"><b>Beginner's rule book</b><span class="muted" data-rb-progress></span></div>
        <div class="rb-list">${checklistHtml()}</div>
        <div class="row-between" style="padding:10px 14px;border-top:1px solid var(--line)">
          <button class="btn btn-secondary btn-sm" data-rb-clear>Clear all</button>
          <span class="muted" style="font-size:11px">Floats above other tabs</span>
        </div>
      </div>`;
    pipWindow.document.querySelector('[data-rb-clear]').addEventListener('click', clearAll);
    bindCheckboxes(pipWindow.document);
    applyChecks(pipWindow.document);
    pipWindow.addEventListener('pagehide', () => { pipWindow = null; });
  } catch (err) {
    toast(`Could not open floating window: ${err.message}`, 'warn');
  }
}

function clearAll() {
  checks = {};
  persist();
  applyChecks(document);
  if (pipWindow) applyChecks(pipWindow.document);
}

function toast(message, type = 'warn') {
  window.dispatchEvent(new CustomEvent('wheel-toast', { detail: { message, type } }));
}

export function mountRulebook() {
  if (document.getElementById('rbFab')) return;

  const fab = document.createElement('button');
  fab.id = 'rbFab';
  fab.className = 'fab';
  fab.title = "Beginner's rule book";
  fab.innerHTML = '📋<span class="fab-label">Rules</span>';

  const panel = document.createElement('div');
  panel.id = 'rbPanel';
  panel.className = 'rb-panel hidden';
  panel.innerHTML = `
    <div class="rb-head">
      <div><b>Beginner's rule book</b><div class="muted" style="font-size:11px" data-rb-progress>${progressText()}</div></div>
      <div class="row" style="gap:6px">
        <button class="btn btn-secondary btn-sm" id="rbPip" title="Float above other tabs (Chrome/Edge)">⧉ Float</button>
        <button class="icon-btn" id="rbClose" aria-label="Close">×</button>
      </div>
    </div>
    <div class="rb-list">${checklistHtml()}</div>
    <div class="row-between" style="padding:10px 14px;border-top:1px solid var(--line)">
      <button class="btn btn-secondary btn-sm" id="rbClear">Clear all</button>
      <span class="muted" style="font-size:11px">Tick as you learn</span>
    </div>`;

  document.body.appendChild(fab);
  document.body.appendChild(panel);

  fab.onclick = () => panel.classList.toggle('hidden');
  panel.querySelector('#rbClose').onclick = () => panel.classList.add('hidden');
  panel.querySelector('#rbClear').onclick = clearAll;
  panel.querySelector('#rbPip').onclick = openPip;
  bindCheckboxes(document);
}
