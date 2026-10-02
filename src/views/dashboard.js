import { wheelSummary } from '../store.js';
import { mergeSettings } from '../calc.js';
import { money, pct, signedPct, escapeHtml, marketStatus } from '../format.js';
import { badge, chart, drawChart, chartColors, tip } from '../ui.js';

function buildActions(state, account) {
  const out = [];
  const now = Date.now();
  for (const w of state.wheels) {
    if (w.state === 'complete') continue;
    const s = wheelSummary(w);
    if (s.status === 'red') out.push({ level: 'red', ticker: w.ticker, text: s.nextAction, wheelId: w.id });
    else if (s.status === 'amber') out.push({ level: 'amber', ticker: w.ticker, text: s.nextAction, wheelId: w.id });
    if (w.reviewDate && new Date(w.reviewDate).getTime() <= now) out.push({ level: 'amber', ticker: w.ticker, text: `Review date reached — revisit your recovery plan.`, wheelId: w.id });
  }
  const reminder = mergeSettings(state.settings).exportReminderDays;
  if (state.meta?.lastExportAt) {
    const days = (Date.now() - new Date(state.meta.lastExportAt).getTime()) / 86400000;
    if (days > reminder) out.push({ level: 'amber', ticker: 'Backup', text: `No export in ${Math.floor(days)} days — export a backup from Settings.`, wheelId: null });
  } else if (state.wheels.length > 0) {
    out.push({ level: 'amber', ticker: 'Backup', text: 'You have not exported a backup yet. Export one from Settings.', wheelId: null });
  }
  return out.sort((a, b) => (a.level === 'red' ? -1 : 1) - (b.level === 'red' ? -1 : 1));
}

function cumulativeSeries(state) {
  if (state.snapshots?.length > 1) {
    return { labels: state.snapshots.map((s) => s.asOf), data: state.snapshots.map((s) => s.netLiquidation) };
  }
  const sorted = [...state.trades].sort((a, b) => String(a.executedAt).localeCompare(String(b.executedAt)));
  let running = state.account?.budget ?? 10000;
  const labels = [];
  const data = [];
  for (const t of sorted) {
    running += Number(t.cashFlow || 0);
    labels.push(String(t.executedAt).slice(0, 10));
    data.push(Number(running.toFixed(2)));
  }
  if (!labels.length) {
    labels.push('Start');
    data.push(running);
  }
  return { labels, data };
}

function monthlyPremium(state) {
  const map = new Map();
  for (const t of state.trades) {
    if (!t.action?.startsWith('SELL_')) continue;
    const key = String(t.executedAt).slice(0, 7);
    map.set(key, (map.get(key) || 0) + Number(t.cashFlow || 0));
  }
  const labels = [...map.keys()].sort();
  return { labels, data: labels.map((k) => Number(map.get(k).toFixed(2))) };
}

function pnlByTicker(state) {
  const map = new Map();
  for (const w of state.wheels) {
    const s = wheelSummary(w);
    map.set(w.ticker, (map.get(w.ticker) || 0) + s.pnl);
  }
  const entries = [...map.entries()].sort((a, b) => b[1] - a[1]);
  return { labels: entries.map((e) => e[0]), data: entries.map((e) => Number(e[1].toFixed(2))) };
}

export default {
  title: 'Dashboard',
  render(ctx) {
    const { state, account } = ctx;
    const mkt = marketStatus();
    const s = mergeSettings(state.settings);
    const actions = buildActions(state, account);
    const activeWheels = state.wheels.filter((w) => w.state !== 'complete');
    const alloc = account.allocation;
    const allocTotal = Math.max(1, alloc.free + alloc.reserve + alloc.collateral + alloc.shares);

    const metric = (label, value, sub, cls = '') => `
      <div class="card"><div class="stat"><span class="stat-label">${escapeHtml(label)}</span>
      <span class="stat-value ${cls}">${value}</span><span class="stat-sub">${sub}</span></div></div>`;

    return `
      <div class="grid grid-4">
        ${metric('Budget', money(account.budget), `Net worth ${money(account.netLiquidation)}`, account.netLiquidation >= account.budget ? 'positive' : 'negative')}
        ${metric('Available cash', money(account.availableCash), `Reserve ${money(account.reserve)} protected`)}
        ${metric('Collateral reserved', money(account.reserved), `${account.openWheels} open wheel(s)`)}
        ${metric('Premium collected', money(account.premiums), `${account.wins} won · ${account.closedWheels} closed`)}
      </div>

      <div class="grid grid-4 mt">
        ${metric('Realized P&L', money(account.realized), 'Closed legs')}
        ${metric('Unrealized P&L', money(account.unrealized), 'Shares vs cost basis', account.unrealized >= 0 ? 'positive' : 'negative')}
        ${metric('Total return', signedPct(account.totalReturnPct), 'Versus starting budget', account.totalReturnPct >= 0 ? 'positive' : 'negative')}
        ${metric('Win rate', account.winRate === null ? '—' : pct(account.winRate, 0), `${account.sharesValue > 0 ? 'Shares held' : 'No shares held'}`)}
      </div>

      <div class="grid grid-2-1 mt">
        <div class="card">
          <div class="card-head"><h3>${tip('Today’s actions', 'Generated automatically from your strategy rules and each wheel’s state.')}</h3>
            <span class="market-badge ${mkt.state === 'open' ? '' : 'closed'}">${escapeHtml(mkt.label)} · ${escapeHtml(mkt.clock)}</span></div>
          ${actions.length ? `<div class="grid" style="gap:10px">${actions.slice(0, 6).map((a) => `
            <div class="action-card ${a.level}">
              <div class="row-between"><b>${escapeHtml(a.ticker)}</b><span class="badge ${a.level}">${a.level === 'red' ? 'Action needed' : 'Action soon'}</span></div>
              <div class="muted" style="font-size:13px;margin-top:4px">${escapeHtml(a.text)}</div>
              ${a.wheelId ? `<button class="btn btn-secondary btn-sm" style="margin-top:8px" data-open-wheel="${a.wheelId}">Open wheel →</button>` : ''}
            </div>`).join('')}</div>`
            : `<div class="empty"><span class="empty-ico">🌤️</span>Nothing needs your attention right now.<br><small>${mkt.state === 'open' ? 'Market is open.' : `Next open ${escapeHtml(mkt.nextOpenLabel || '')}.`}</small></div>`}
        </div>

        <div class="card">
          <div class="card-head"><h3>Budget allocation</h3></div>
          <div class="gauge" role="img" aria-label="Budget allocation">
            <span class="free" style="width:${(alloc.free / allocTotal) * 100}%"></span>
            <span class="reserve" style="width:${(alloc.reserve / allocTotal) * 100}%"></span>
            <span class="collateral" style="width:${(alloc.collateral / allocTotal) * 100}%"></span>
            <span class="shares" style="width:${(alloc.shares / allocTotal) * 100}%"></span>
          </div>
          <div class="legend">
            <span><i style="background:var(--brand)"></i>Free ${money(alloc.free)}</span>
            <span><i style="background:var(--blue)"></i>Reserve ${money(alloc.reserve)}</span>
            <span><i style="background:var(--amber)"></i>Collateral ${money(alloc.collateral)}</span>
            <span><i style="background:var(--purple)"></i>Shares ${money(alloc.shares)}</span>
          </div>
          <div class="kv" style="margin-top:14px"><span>Max per wheel (${pct(s.maxPerWheelPct * 100, 0)})</span><span>${money(account.budget * s.maxPerWheelPct)}</span></div>
          <div class="kv"><span>Cash reserve (${pct(s.reservePct * 100, 0)})</span><span>${money(account.reserve)}</span></div>
          <div class="kv"><span>Wheel slots used</span><span>${account.openWheels} / ${s.maxWheels}</span></div>
        </div>
      </div>

      <div class="section-head"><h2>Active wheels</h2><a class="btn btn-secondary btn-sm" href="#/wheels">View all →</a></div>
      ${activeWheels.length ? `<div class="grid grid-3">${activeWheels.map((w) => {
        const sm = wheelSummary(w);
        const dteLabel = sm.dte === null ? '—' : sm.dte <= 0 ? 'Expired' : `${sm.dte} DTE`;
        return `<a class="card" href="#/wheels" style="text-decoration:none;color:inherit">
          <div class="row-between"><b class="mono">${escapeHtml(w.ticker)}</b>${badge(sm.status, sm.state.replace('_', ' '))}</div>
          <div class="stat-value sm" style="margin:8px 0 2px">${money(sm.pnl)}</div>
          <div class="stat-sub">${escapeHtml(dteLabel)} · Premium ${money(sm.premiums)}</div>
          <div class="muted" style="font-size:12px;margin-top:6px">${escapeHtml(sm.nextAction)}</div>
        </a>`;
      }).join('')}</div>` : `<div class="card empty"><span class="empty-ico">◐</span>No wheels yet — start with the <a href="#/screener">Screener</a> or add one manually.</div>`}

      <div class="section-head"><h2>Progress & income</h2></div>
      <div class="grid grid-2">
        <div class="card"><h3>Net liquidation over time</h3><div class="muted" style="font-size:12px;margin-bottom:8px">From your daily snapshots and trade cash flows.</div>${chart('chartNet')}</div>
        <div class="card"><h3>Monthly premium income</h3><div class="muted" style="font-size:12px;margin-bottom:8px">Premium collected per month.</div>${chart('chartPremium')}</div>
      </div>
      <div class="grid grid-2 mt">
        <div class="card"><h3>P&L by ticker</h3><div class="muted" style="font-size:12px;margin-bottom:8px">Premium + realized + unrealized per ticker.</div>${chart('chartTicker')}</div>
        <div class="card"><h3>Capital allocation</h3><div class="muted" style="font-size:12px;margin-bottom:8px">Where your budget currently sits.</div>${chart('chartAlloc')}</div>
      </div>
    `;
  },
  mount(root, ctx) {
    const { state, account } = ctx;
    root.querySelectorAll('[data-open-wheel]').forEach((b) => {
      b.onclick = () => ctx.go(`/wheels?open=${b.dataset.openWheel}`);
    });

    const net = cumulativeSeries(state);
    drawChart('chartNet', {
      type: 'line',
      data: { labels: net.labels, datasets: [{ label: 'Net liquidation', data: net.data, borderColor: chartColors[0], backgroundColor: 'rgba(15,157,108,.12)', fill: true, tension: 0.3, pointRadius: 2 }] },
      options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { display: false } }, scales: { y: { ticks: { callback: (v) => `$${v}` } } } },
    });

    const prem = monthlyPremium(state);
    drawChart('chartPremium', {
      type: 'bar',
      data: { labels: prem.labels.length ? prem.labels : ['No data'], datasets: [{ label: 'Premium', data: prem.data.length ? prem.data : [0], backgroundColor: chartColors[0], borderRadius: 6 }] },
      options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { display: false } }, scales: { y: { ticks: { callback: (v) => `$${v}` } } } },
    });

    const tick = pnlByTicker(state);
    drawChart('chartTicker', {
      type: 'bar',
      data: { labels: tick.labels.length ? tick.labels : ['No data'], datasets: [{ label: 'P&L', data: tick.data.length ? tick.data : [0], backgroundColor: tick.data.map((v) => (v >= 0 ? chartColors[0] : chartColors[4])), borderRadius: 6 }] },
      options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { display: false } }, scales: { y: { ticks: { callback: (v) => `$${v}` } } } },
    });

    const a = account.allocation;
    drawChart('chartAlloc', {
      type: 'doughnut',
      data: { labels: ['Free cash', 'Reserve', 'Collateral', 'Shares'], datasets: [{ data: [a.free, a.reserve, a.collateral, a.shares], backgroundColor: [chartColors[0], chartColors[1], chartColors[2], chartColors[3]], borderWidth: 0 }] },
      options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { position: 'bottom' } } },
    });
  },
};
