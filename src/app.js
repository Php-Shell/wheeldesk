// ---------------------------------------------------------------------------
// Wheel Desk — application shell, hash router and global wiring.
// ---------------------------------------------------------------------------

import { getState, subscribe, actions, deriveAccount } from './store.js';
import { auth } from './supabase.js';
import { getConfig, loadTickerData, loadOptions, searchSymbols, testProvider } from './providers.js';
import * as ui from './ui.js';
import * as format from './format.js';
import { views, DEFAULT_VIEW } from './views/index.js';
import { marketStatus, fmtInZone, localTimeZone, downloadText, escapeHtml } from './format.js';
import { buildBackup, parseBackup } from './export.js';
import { mountRulebook } from './rulebook.js';

let globalConfig = { providers: {} };
let route = { name: DEFAULT_VIEW, params: {} };

const root = document.getElementById('view');

function parseHash() {
  const raw = location.hash.replace(/^#\/?/, '');
  const [path, query] = raw.split('?');
  const name = (path || DEFAULT_VIEW).split('/')[0] || DEFAULT_VIEW;
  const params = {};
  new URLSearchParams(query || '').forEach((v, k) => { params[k] = v; });
  return { name: views[name] ? name : DEFAULT_VIEW, params };
}

function makeContext() {
  return {
    get state() { return getState(); },
    get account() { return deriveAccount(getState()); },
    get globalConfig() { return globalConfig; },
    auth,
    actions,
    providers: { loadTickerData, loadOptions, searchSymbols, testProvider },
    ui,
    format,
    get route() { return route; },
    go: (path) => { location.hash = `#${path.startsWith('/') ? path : `/${path}`}`; },
    toast: ui.toast,
    confirm: ui.confirmDialog,
    openAccount: () => openAccount(),
    reload: render,
  };
}

let ctx = null;

function render() {
  if (!ctx) ctx = makeContext();
  route = parseHash();
  const view = views[route.name] || views[DEFAULT_VIEW];

  try {
    view.beforeRender?.(route);
  } catch (err) {
    console.error(err);
  }

  const cfg = getState().settings || {};
  document.getElementById('pageTitle').textContent = view.title || 'Wheel Desk';
  const mkt = marketStatus();
  document.getElementById('topEyebrow').textContent = `${getState().account.name || 'Paper account'} / ${mkt.label.toUpperCase()} / ${mkt.clock}`;
  const mb = document.getElementById('marketBadge');
  mb.textContent = `${mkt.state === 'open' ? '●' : '○'} ${mkt.label}`;
  mb.className = `market-badge ${mkt.state === 'open' ? '' : 'closed'}`;

  document.querySelectorAll('.nav-item').forEach((a) => a.classList.toggle('active', a.dataset.view === route.name));

  try {
    root.innerHTML = view.render(ctx);
  } catch (err) {
    console.error(err);
    root.innerHTML = `<div class="card"><h2>Something went wrong rendering this page</h2><p class="muted">${escapeHtml(err.message)}</p><button class="btn btn-secondary" onclick="location.reload()">Reload</button></div>`;
  }
  try {
    view.mount?.(root, ctx);
  } catch (err) {
    console.error(err);
    ui.toast(`Page error: ${err.message}`, 'error');
  }

  updateChrome();
}

function updateChrome() {
  const s = getState();
  const toggle = document.getElementById('modeToggle');
  const live = (s.account.mode || 'paper') === 'live';
  toggle.classList.toggle('on', !live);
  toggle.classList.toggle('off', live);
  const dot = document.getElementById('syncDot');
  const text = document.getElementById('syncText');
  if (auth.get()) { dot.className = 'status-dot'; text.textContent = `Signed in · ${auth.get().user?.email || ''}`; }
  else if (!auth.configured()) { dot.className = 'status-dot offline'; text.textContent = 'Local ledger'; }
  else { dot.className = 'status-dot pending'; text.textContent = 'Local ledger (not synced)'; }
  const avatar = document.getElementById('accountBtn');
  if (avatar) avatar.textContent = (s.account.name || 'WD').split(/\s+/).map((w) => w[0]).join('').slice(0, 2).toUpperCase();
}

// ---- Global controls -----------------------------------------------------

function wireControls() {
  document.getElementById('modeToggle').onclick = () => {
    const s = getState();
    const next = (s.account.mode || 'paper') === 'live' ? 'paper' : 'live';
    actions.updateAccount({ mode: next });
    ui.toast(`Switched to ${next} mode. New wheels default to ${next}.`);
    render();
  };

  document.getElementById('themeBtn').onclick = (e) => {
    const dark = document.body.classList.toggle('dark');
    e.currentTarget.textContent = dark ? '☾' : '☼';
    e.currentTarget.title = dark ? 'Switch to light' : 'Switch to dark';
  };

  document.getElementById('newWheelBtn').onclick = () => { location.hash = '#/new'; };

  document.getElementById('exportBtn').onclick = () => {
    downloadText('wheel-desk-backup.json', JSON.stringify(buildBackup(getState()), null, 2), 'application/json');
    actions.markExported();
    ui.toast('Backup exported.');
  };

  document.getElementById('importInput').onchange = async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      const data = parseBackup(await file.text());
      if (await ui.confirmDialog('Importing replaces your local data. Continue?', { danger: true, confirmText: 'Import' })) {
        actions.importState(data);
        ui.toast('Backup imported.');
        render();
      }
    } catch (err) {
      ui.toast(err.message, 'error');
    }
    e.target.value = '';
  };

  document.getElementById('accountBtn').onclick = openAccount;

  document.getElementById('modal').addEventListener('click', (e) => {
    if (e.target.id === 'modal') ui.closeModal();
  });

  window.addEventListener('hashchange', render);
  window.addEventListener('resize', () => {});

  // Auto-refresh the market clock every minute.
  setInterval(() => {
    const mkt = marketStatus();
    document.getElementById('topEyebrow').textContent = `${getState().account.name || 'Paper account'} / ${mkt.label.toUpperCase()} / ${mkt.clock}`;
  }, 60000);
}

function openAccount() {
  const session = auth.get();
  ui.openModal('Account & sync', `
    <p class="muted">${auth.configured() ? 'Sign in to sync your ledger to Supabase.' : 'Supabase is not configured for this deployment. Local data still works.'}</p>
    ${session ? `<div class="notice info">Signed in as ${escapeHtml(session.user?.email || '')}</div>
      <button class="btn btn-danger mt" id="signOut">Sign out</button>` : `
      <div class="field"><label>Email</label><input id="authEmail" type="email" placeholder="you@example.com" /></div>
      <div class="field"><label>Password</label><input id="authPassword" type="password" placeholder="••••••••" /></div>
      <div class="row wrap"><button class="btn btn-primary" id="signIn">Sign in</button><button class="btn btn-secondary" id="signUp">Create account</button></div>`}
    <div id="authMsg" class="mt"></div>`, (body, close) => {
    body.querySelector('#signOut')?.addEventListener('click', async () => {
      await auth.signOut();
      close();
      ui.toast('Signed out.');
      render();
    });
    const doAuth = async (kind) => {
      const email = body.querySelector('#authEmail').value;
      const password = body.querySelector('#authPassword').value;
      const msg = body.querySelector('#authMsg');
      try {
        const res = await auth[kind](email, password);
        msg.innerHTML = res?.access_token ? '<div class="notice info">Signed in.</div>' : '<div class="notice info">Check your email to confirm your account, then sign in.</div>';
        render();
      } catch (err) {
        msg.innerHTML = `<div class="notice error">${escapeHtml(err.message)}</div>`;
      }
    };
    body.querySelector('#signIn')?.addEventListener('click', () => doAuth('signIn'));
    body.querySelector('#signUp')?.addEventListener('click', () => doAuth('signUp'));
  });
}

// ---- Boot ----------------------------------------------------------------

async function boot() {
  const cfg = await getConfig();
  globalConfig = cfg;
  auth.configure(cfg);
  await auth.restore().catch(() => null);
  ctx = makeContext();
  wireControls();
  mountRulebook();
  window.addEventListener('wheel-toast', (e) => ui.toast(e.detail.message, e.detail.type));
  subscribe(() => render());
  if (!location.hash) location.hash = `#/${DEFAULT_VIEW}`;
  render();
}

boot();
