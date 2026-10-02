import { mergeSettings, selfTest } from '../calc.js';
import { money, pct, escapeHtml, localTimeZone, downloadText } from '../format.js';
import { tradesToCsv, buildBackup, parseBackup } from '../export.js';
import { field, readForm, toast, openModal, confirmDialog, badge } from '../ui.js';

export default {
  title: 'Settings',
  render(ctx) {
    const s = mergeSettings(ctx.state.settings);
    const acc = ctx.state.account;
    const cfg = ctx.globalConfig || {};
    const session = ctx.auth.get();
    const tz = s.timezone || localTimeZone();

    return `
      <div class="grid grid-2">
        <div class="card">
          <h2>Account</h2>
          <p class="muted">Your dedicated "playing" budget. Changing it does not move any money — it only changes the planning maths.</p>
          ${field({ label: 'Account nickname', name: 'name', type: 'text', value: acc.name })}
          ${field({ label: 'Budget', name: 'budget', value: acc.budget })}
          ${field({ label: 'Home currency', name: 'currency', type: 'select', value: acc.currency, options: ['USD', 'EUR', 'GBP', 'CAD', 'AUD', 'CHF', 'JPY'].map((c) => ({ value: c, label: c })) })}
          ${field({ label: 'FX rate to USD', name: 'fxRate', value: acc.fxRate, hint: 'for display only' })}
          ${field({ label: 'Time zone', name: 'timezone', type: 'text', value: tz, hint: 'e.g. Europe/Paris' })}
        </div>

        <div class="card">
          <h2>Strategy parameters</h2>
          <div class="form-grid">
            ${field({ label: 'Cash reserve %', name: 'reservePct', value: (s.reservePct * 100).toFixed(1) })}
            ${field({ label: 'Max % per wheel', name: 'maxPerWheelPct', value: (s.maxPerWheelPct * 100).toFixed(1) })}
            ${field({ label: 'Max wheels', name: 'maxWheels', value: s.maxWheels })}
            ${field({ label: 'Commission / contract', name: 'commission', value: s.commission })}
            ${field({ label: 'Assignment fee', name: 'assignmentFee', value: s.assignmentFee })}
            ${field({ label: 'Take profit %', name: 'takeProfitPct', value: (s.takeProfitPct * 100).toFixed(0) })}
            ${field({ label: 'Min DTE', name: 'dteMin', value: s.dteMin })}
            ${field({ label: 'Max DTE', name: 'dteMax', value: s.dteMax })}
            ${field({ label: 'Min delta', name: 'deltaMin', value: s.deltaMin })}
            ${field({ label: 'Max delta', name: 'deltaMax', value: s.deltaMax })}
            ${field({ label: '21-DTE time rule', name: 'timeRuleOn', type: 'select', value: s.timeRuleOn ? 'yes' : 'no', options: [{ value: 'yes', label: 'On' }, { value: 'no', label: 'Off' }] })}
            ${field({ label: 'Time rule DTE', name: 'timeRuleDte', value: s.timeRuleDte })}
            ${field({ label: 'Return target min %', name: 'returnMin', value: s.returnMin })}
            ${field({ label: 'Return target max %', name: 'returnMax', value: s.returnMax })}
            ${field({ label: 'High-risk flag %', name: 'returnHigh', value: s.returnHigh })}
          </div>
        </div>
      </div>

      <div class="grid grid-2 mt">
        <div class="card">
          <h3>Checklist thresholds</h3>
          <div class="form-grid">
            ${field({ label: 'Min market cap ($)', name: 't_marketCap', value: s.thresholds.marketCap })}
            ${field({ label: 'Warn market cap ($)', name: 't_marketCapWarn', value: s.thresholds.marketCapWarn })}
            ${field({ label: 'Min avg volume (shares)', name: 't_volume', value: s.thresholds.volume })}
            ${field({ label: 'Min open interest', name: 't_openInterest', value: s.thresholds.openInterest })}
            ${field({ label: 'Warn open interest', name: 't_openInterestWarn', value: s.thresholds.openInterestWarn })}
            ${field({ label: 'Max spread ($)', name: 't_spread', value: s.thresholds.spread })}
            ${field({ label: 'Max spread (% of mid)', name: 't_spreadPct', value: (s.thresholds.spreadPct * 100).toFixed(0) })}
            ${field({ label: 'IV Rank min', name: 't_ivMin', value: s.thresholds.ivMin })}
            ${field({ label: 'IV Rank max', name: 't_ivMax', value: s.thresholds.ivMax })}
            ${field({ label: 'IV Rank low warn', name: 't_ivLow', value: s.thresholds.ivLow })}
            ${field({ label: 'IV Rank high warn', name: 't_ivHigh', value: s.thresholds.ivHigh })}
          </div>
          <h3 style="margin-top:18px">Recovery thresholds</h3>
          <div class="form-grid">
            ${field({ label: 'Scenario B: % below basis', name: 'r_scenarioB', value: s.recovery.scenarioB })}
            ${field({ label: 'Scenario C: % below basis', name: 'r_scenarioC', value: s.recovery.scenarioC })}
            ${field({ label: 'Deep-loss / cut loss %', name: 'r_cutLoss', value: s.recovery.cutLoss })}
          </div>
        </div>

        <div class="card">
          <h3>Data providers</h3>
          <div class="kv"><span>Finnhub</span><span>${cfg.providers?.finnhub ? badge('pass', 'Configured') : badge('warn', 'Missing key')}</span></div>
          <div class="kv"><span>Tradier (options + greeks)</span><span>${cfg.providers?.tradier ? badge('pass', 'Configured') : badge('warn', 'Not configured — manual entry')}</span></div>
          <div class="kv"><span>Supabase auth</span><span>${ctx.auth.configured() ? badge('pass', 'Configured') : badge('warn', 'Not configured')}</span></div>
          <div class="kv"><span>Signed in as</span><span>${escapeHtml(session?.user?.email || 'Not signed in')}</span></div>
          <button class="btn btn-secondary mt" id="testProvider">Test Finnhub connection</button>
          <div id="testOut" class="mt"></div>

          <h3 class="mt">Cloud sync</h3>
          <p class="muted" style="font-size:12.5px">Local data always works. Sync uploads your ledger to Supabase so you can use it on another device.</p>
          <div class="row wrap">
            <button class="btn btn-secondary btn-sm" id="syncUp">Sync now</button>
            <button class="btn btn-secondary btn-sm" id="syncPull">Pull from cloud</button>
          </div>
          <div id="syncOut" class="mt"></div>
        </div>
      </div>

      <div class="card mt">
        <div class="card-head"><h3>Calculation self-test</h3><button class="btn btn-secondary btn-sm" id="runSelfTest">Run self-test</button></div>
        <div id="selfTestOut" class="muted">Runs the built-in formula checks (example: sell a $50 put for $1.20, 30 DTE, $0.65 fee → net $119.35, return 2.39%, annualized ~29%).</div>
      </div>

      <div class="card mt">
        <h3>Backup & data</h3>
        <p class="muted">Export regularly. If no export is made within ${escapeHtml(String(s.exportReminderDays))} days, the dashboard reminds you.</p>
        <div class="row wrap">
          <button class="btn btn-primary btn-sm" id="exportJson">Export all data (JSON)</button>
          <button class="btn btn-secondary btn-sm" id="exportCsv">Export trades (CSV)</button>
          <label class="btn btn-secondary btn-sm">Import JSON<input id="importFile" type="file" accept="application/json" hidden /></label>
          <button class="btn btn-secondary btn-sm" id="loadDemo">Load demo data</button>
          <button class="btn btn-secondary btn-sm" id="clearDemo">Clear all data</button>
          <button class="btn btn-danger btn-sm" id="resetAll">Delete everything</button>
        </div>
        <button class="btn btn-primary mt" id="saveSettings">Save settings</button>
      </div>`;
  },
  mount(root, ctx) {
    root.querySelector('#saveSettings')?.addEventListener('click', () => {
      const v = readForm(root);
      ctx.actions.updateAccount({ name: v.name, budget: Number(v.budget) || 0, currency: v.currency, fxRate: Number(v.fxRate) || 1 });
      ctx.actions.updateSettings({
        reservePct: Number(v.reservePct) / 100,
        maxPerWheelPct: Number(v.maxPerWheelPct) / 100,
        maxWheels: Number(v.maxWheels),
        commission: Number(v.commission),
        assignmentFee: Number(v.assignmentFee),
        takeProfitPct: Number(v.takeProfitPct) / 100,
        dteMin: Number(v.dteMin),
        dteMax: Number(v.dteMax),
        deltaMin: Number(v.deltaMin),
        deltaMax: Number(v.deltaMax),
        timeRuleOn: v.timeRuleOn === 'yes',
        timeRuleDte: Number(v.timeRuleDte),
        returnMin: Number(v.returnMin),
        returnMax: Number(v.returnMax),
        returnHigh: Number(v.returnHigh),
        timezone: v.timezone,
        thresholds: {
          marketCap: Number(v.t_marketCap),
          marketCapWarn: Number(v.t_marketCapWarn),
          volume: Number(v.t_volume),
          openInterest: Number(v.t_openInterest),
          openInterestWarn: Number(v.t_openInterestWarn),
          spread: Number(v.t_spread),
          spreadPct: Number(v.t_spreadPct) / 100,
          ivMin: Number(v.t_ivMin),
          ivMax: Number(v.t_ivMax),
          ivLow: Number(v.t_ivLow),
          ivHigh: Number(v.t_ivHigh),
        },
        recovery: { scenarioB: Number(v.r_scenarioB), scenarioC: Number(v.r_scenarioC), cutLoss: Number(v.r_cutLoss) },
      });
      toast('Settings saved.');
      ctx.reload();
    });

    root.querySelector('#testProvider')?.addEventListener('click', async () => {
      const out = root.querySelector('#testOut');
      out.innerHTML = '<span class="muted">Testing…</span>';
      try {
        const res = await ctx.providers.testProvider(ctx.auth.token());
        out.innerHTML = `<div class="notice ${res.status === 'ok' ? 'info' : 'error'}">${escapeHtml(res.status === 'ok' ? `Finnhub OK — AAPL $${res.data.price} (${res.provider}, ${res.cache})` : res.message || res.status)}</div>`;
      } catch (err) {
        out.innerHTML = `<div class="notice error">${escapeHtml(err.message)}</div>`;
      }
    });

    root.querySelector('#syncUp')?.addEventListener('click', async () => {
      const out = root.querySelector('#syncOut');
      if (!ctx.auth.get()) { out.innerHTML = '<div class="notice error">Sign in first (top-right avatar).</div>'; return; }
      out.innerHTML = '<span class="muted">Syncing…</span>';
      try {
        const res = await ctx.auth.sync(ctx.state);
        out.innerHTML = `<div class="notice info">Sync: ${escapeHtml(res.status)}${res.remoteUpdatedAt ? ` (remote newer: ${escapeHtml(res.remoteUpdatedAt)})` : ''}</div>`;
      } catch (err) {
        out.innerHTML = `<div class="notice error">${escapeHtml(err.message)}</div>`;
      }
    });

    root.querySelector('#syncPull')?.addEventListener('click', async () => {
      const out = root.querySelector('#syncOut');
      try {
        const remote = await ctx.auth.pull();
        if (!remote) { out.innerHTML = '<div class="notice error">Nothing to pull.</div>'; return; }
        if (await confirmDialog('Replace local data with the cloud copy?', { danger: true, confirmText: 'Replace local' })) {
          ctx.actions.importState(remote);
          toast('Pulled from cloud.');
          ctx.reload();
        }
      } catch (err) {
        out.innerHTML = `<div class="notice error">${escapeHtml(err.message)}</div>`;
      }
    });

    root.querySelector('#runSelfTest')?.addEventListener('click', () => {
      const t = selfTest();
      root.querySelector('#selfTestOut').innerHTML = `
        <div class="notice ${t.passed === t.total ? 'info' : 'error'}">${t.passed}/${t.total} checks passed.</div>
        <div class="table-wrap"><table class="table"><thead><tr><th>Check</th><th>Expected</th><th>Actual</th><th></th></tr></thead><tbody>
        ${t.results.map((r) => `<tr><td>${escapeHtml(r.name)}</td><td class="mono">${escapeHtml(JSON.stringify(r.expected))}</td><td class="mono">${escapeHtml(JSON.stringify(r.actual))}</td><td>${r.pass ? '✅' : '❌'}</td></tr>`).join('')}
        </tbody></table></div>`;
    });

    root.querySelector('#exportJson')?.addEventListener('click', () => {
      downloadText('wheel-desk-backup.json', JSON.stringify(buildBackup(ctx.state), null, 2), 'application/json');
      ctx.actions.markExported();
      toast('Backup exported.');
    });
    root.querySelector('#exportCsv')?.addEventListener('click', () => {
      downloadText('wheel-desk-trades.csv', tradesToCsv(ctx.state.trades, ctx.state.wheels), 'text/csv');
      ctx.actions.markExported();
      toast('CSV exported.');
    });
    root.querySelector('#importFile')?.addEventListener('change', async (e) => {
      const file = e.target.files?.[0];
      if (!file) return;
      try {
        const text = await file.text();
        const data = parseBackup(text);
        if (await confirmDialog('Import will replace your current local data. Continue?', { danger: true, confirmText: 'Import' })) {
          ctx.actions.importState(data);
          toast('Backup imported.');
          ctx.reload();
        }
      } catch (err) {
        toast(err.message, 'error');
      }
    });
    root.querySelector('#loadDemo')?.addEventListener('click', async () => {
      if (await confirmDialog('Load fictional demo wheels? This replaces your current local data.', { confirmText: 'Load demo' })) {
        ctx.actions.loadDemo();
        toast('Demo data loaded.');
        ctx.reload();
      }
    });
    root.querySelector('#clearDemo')?.addEventListener('click', async () => {
      if (await confirmDialog('Delete all local data and start empty?', { danger: true, confirmText: 'Delete all' })) {
        ctx.actions.clearDemo();
        toast('All data cleared.');
        ctx.reload();
      }
    });
    root.querySelector('#resetAll')?.addEventListener('click', async () => {
      if (await confirmDialog('This permanently deletes everything on this device. Are you sure?', { danger: true, confirmText: 'I understand, delete' })) {
        if (await confirmDialog('Last chance: delete all data with no undo?', { danger: true, confirmText: 'Delete permanently' })) {
          ctx.actions.reset();
          toast('Everything deleted.');
          ctx.reload();
        }
      }
    });
  },
};
