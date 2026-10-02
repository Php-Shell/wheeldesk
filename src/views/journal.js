import { wheelSummary, deriveAccount } from '../store.js';
import { money, pct, escapeHtml, fmtInZone, localTimeZone, downloadText } from '../format.js';
import { tradesToCsv, buildBackup } from '../export.js';
import { badge, toast, openModal, field, readForm, confirmDialog } from '../ui.js';

const view = { search: '', mode: 'all', sortKey: 'executedAt', sortDir: 'desc' };

const ACTION_SHORT = {
  SELL_PUT_OPEN: 'Sell put',
  BUY_PUT_CLOSE: 'Buy put',
  PUT_EXPIRE: 'Put expired',
  PUT_ASSIGN: 'Assigned',
  SELL_CALL_OPEN: 'Sell call',
  BUY_CALL_CLOSE: 'Buy call',
  CALL_EXPIRE: 'Call expired',
  CALL_ASSIGN: 'Called away',
  SELL_SHARES: 'Sell shares',
  BUY_SHARES: 'Buy shares',
};

function summaries(state) {
  const byMonth = new Map();
  for (const t of state.trades) {
    const key = String(t.executedAt).slice(0, 7);
    if (!byMonth.has(key)) byMonth.set(key, { key, premium: 0, fees: 0, trades: 0, realized: 0 });
    const m = byMonth.get(key);
    m.trades += 1;
    m.fees += Number(t.fees || 0);
    if (t.action?.startsWith('SELL_')) m.premium += Number(t.cashFlow || 0);
    if (['BUY_CALL_CLOSE', 'BUY_PUT_CLOSE'].includes(t.action)) m.realized += Number(t.cashFlow || 0);
  }
  return [...byMonth.values()].sort((a, b) => b.key.localeCompare(a.key));
}

export default {
  title: 'Journal & ledger',
  render(ctx) {
    const state = ctx.state;
    let rows = state.trades.slice();
    const q = view.search.toLowerCase();
    if (view.mode !== 'all') rows = rows.filter((t) => (t.mode || 'paper') === view.mode);
    if (q) rows = rows.filter((t) => [t.ticker, t.action, t.notes, String(t.strike)].join(' ').toLowerCase().includes(q));
    rows.sort((a, b) => {
      const k = view.sortKey;
      const av = a[k] ?? 0;
      const bv = b[k] ?? 0;
      const cmp = typeof av === 'number' && typeof bv === 'number' ? av - bv : String(av).localeCompare(String(bv));
      return view.sortDir === 'asc' ? cmp : -cmp;
    });

    const monthly = summaries(state);
    const closed = state.wheels.filter((w) => w.state === 'complete');
    const arrow = (k) => (view.sortKey === k ? (view.sortDir === 'asc' ? ' ↑' : ' ↓') : '');

    return `
      <div class="card">
        <div class="card-head"><div><h2>Full trade log</h2><p class="muted">Every logged event across all wheels, paper and live.</p></div>
          <div class="row"><button class="btn btn-secondary btn-sm" id="csvTrades">Export CSV</button><button class="btn btn-secondary btn-sm" id="jsonBackup">Export JSON</button></div></div>
        <div class="row wrap" style="gap:10px">
          <input id="jSearch" class="input-sm" placeholder="Search ticker, action, notes…" value="${escapeHtml(view.search)}" style="max-width:280px" />
          <select id="jMode" class="input-sm" style="max-width:150px">
            <option value="all" ${view.mode === 'all' ? 'selected' : ''}>Paper + Live</option>
            <option value="paper" ${view.mode === 'paper' ? 'selected' : ''}>Paper</option>
            <option value="live" ${view.mode === 'live' ? 'selected' : ''}>Live</option>
          </select>
        </div>
        <div class="table-wrap mt">
          <table class="table"><thead><tr>
            <th class="sortable" data-sort="executedAt">Date${arrow('executedAt')}</th>
            <th class="sortable" data-sort="ticker">Ticker${arrow('ticker')}</th>
            <th>Action</th><th>Type</th>
            <th class="num sortable" data-sort="strike">Strike${arrow('strike')}</th>
            <th>Expiry</th>
            <th class="num">Qty</th><th class="num sortable" data-sort="price">Price${arrow('price')}</th>
            <th class="num">Fees</th><th class="num sortable" data-sort="cashFlow">Cash flow${arrow('cashFlow')}</th>
            <th>Mode</th><th>Notes</th>
          </tr></thead><tbody>
          ${rows.length ? rows.map((t) => `<tr>
            <td class="mono">${escapeHtml(fmtInZone(t.executedAt, 'America/New_York'))}<br><small class="muted">${escapeHtml(fmtInZone(t.executedAt, localTimeZone()))} local</small></td>
            <td class="sym">${escapeHtml(t.ticker || '')}</td>
            <td>${escapeHtml(ACTION_SHORT[t.action] || t.action)}</td>
            <td>${escapeHtml(t.optionType || '')}</td>
            <td class="num">${t.strike ? '$' + t.strike : ''}</td>
            <td>${escapeHtml(t.expiry || '')}</td>
            <td class="num">${t.contracts ?? ''}</td>
            <td class="num">${t.price != null ? money(t.price) : ''}</td>
            <td class="num">${money(t.fees)}</td>
            <td class="num ${Number(t.cashFlow) >= 0 ? 'positive' : 'negative'}">${money(t.cashFlow)}</td>
            <td>${badge(t.mode === 'live' ? 'info' : 'unknown', t.mode || 'paper')}</td>
            <td>${escapeHtml(t.notes || '')}</td>
          </tr>`).join('') : '<tr><td colspan="12" class="muted center">No trades logged yet.</td></tr>'}
          </tbody></table>
        </div>
      </div>

      <div class="grid grid-2 mt">
        <div class="card"><div class="card-head"><h3>Monthly summary</h3></div>
          <div class="table-wrap"><table class="table"><thead><tr><th>Month</th><th class="num">Premium</th><th class="num">Fees</th><th class="num">Trades</th></tr></thead>
          <tbody>${monthly.length ? monthly.map((m) => `<tr><td class="mono">${m.key}</td><td class="num positive">${money(m.premium)}</td><td class="num">${money(m.fees)}</td><td class="num">${m.trades}</td></tr>`).join('') : '<tr><td colspan="4" class="muted center">No data.</td></tr>'}</tbody></table></div>
        </div>
        <div class="card"><div class="card-head"><h3>Closed wheels</h3></div>
          ${closed.length ? closed.map((w) => {
            const sm = wheelSummary(w);
            return `<div class="action-card ${sm.pnl >= 0 ? 'green' : 'red'} mb">
              <div class="row-between"><b>${escapeHtml(w.ticker)}</b>${badge(sm.pnl >= 0 ? 'pass' : 'fail', money(sm.pnl))}</div>
              <div class="muted" style="font-size:12px">Premium ${money(sm.premiums)} · closed ${escapeHtml(String(w.closedAt || '').slice(0, 10))}</div>
              ${w.lessons ? `<div class="mt" style="font-size:12.5px"><b>Lessons:</b> ${escapeHtml(w.lessons)}</div>` : ''}
            </div>`;
          }).join('') : '<p class="muted">No closed wheels yet.</p>'}
        </div>
      </div>

      <div class="card mt">
        <div class="card-head"><h3>Journal notes</h3></div>
        ${state.journal.length ? state.journal.map((j) => `<div class="action-card mb"><div class="muted" style="font-size:11.5px">${escapeHtml(fmtInZone(j.at, localTimeZone()))}</div><div>${escapeHtml(j.body)}</div></div>`).join('') : '<p class="muted">No notes yet.</p>'}
      </div>`;
  },
  mount(root, ctx) {
    root.querySelector('#jSearch')?.addEventListener('input', (e) => { view.search = e.target.value; });
    root.querySelector('#jSearch')?.addEventListener('change', () => ctx.reload());
    root.querySelector('#jMode')?.addEventListener('change', (e) => { view.mode = e.target.value; ctx.reload(); });
    root.querySelectorAll('[data-sort]').forEach((th) => th.addEventListener('click', () => {
      const k = th.dataset.sort;
      if (view.sortKey === k) view.sortDir = view.sortDir === 'asc' ? 'desc' : 'asc';
      else { view.sortKey = k; view.sortDir = 'desc'; }
      ctx.reload();
    }));
    root.querySelector('#csvTrades')?.addEventListener('click', () => {
      downloadText('wheel-desk-trades.csv', tradesToCsv(ctx.state.trades, ctx.state.wheels), 'text/csv');
      ctx.actions.markExported();
      toast('CSV exported.');
    });
    root.querySelector('#jsonBackup')?.addEventListener('click', () => {
      downloadText('wheel-desk-backup.json', JSON.stringify(buildBackup(ctx.state), null, 2), 'application/json');
      ctx.actions.markExported();
      toast('Backup exported.');
    });
  },
};
