// CSV / JSON export and backup validation.

export function toCsv(rows) {
  if (!Array.isArray(rows) || !rows.length) return '';
  const keys = [...new Set(rows.flatMap((r) => Object.keys(r || {})))];
  const esc = (v) => `"${String(v ?? '').replaceAll('"', '""')}"`;
  return [keys.join(','), ...rows.map((r) => keys.map((k) => esc(r?.[k])).join(','))].join('\n');
}

export function tradesToCsv(trades = [], wheels = []) {
  const wheelById = new Map(wheels.map((w) => [w.id, w]));
  return toCsv(
    trades.map((t) => ({
      date: t.executedAt,
      ticker: t.ticker || wheelById.get(t.wheelId)?.ticker || '',
      wheel: t.wheelId,
      action: t.action,
      option_type: t.optionType || '',
      strike: t.strike ?? '',
      expiry: t.expiry ?? '',
      contracts: t.contracts ?? '',
      price: t.price ?? '',
      fees: t.fees ?? '',
      cash_flow: t.cashFlow ?? '',
      mode: t.mode || 'paper',
      notes: t.notes || '',
    })),
  );
}

export const BACKUP_VERSION = 3;

export function buildBackup(state) {
  return {
    app: 'wheel-desk',
    version: BACKUP_VERSION,
    exportedAt: new Date().toISOString(),
    data: state,
  };
}

export function parseBackup(text) {
  let payload;
  try {
    payload = JSON.parse(text);
  } catch {
    throw new Error('That file is not valid JSON.');
  }
  // Accept both the wrapped backup and a raw state object.
  const data = payload?.data ?? payload;
  if (!data || typeof data !== 'object') throw new Error('Backup is missing data.');
  if (!Array.isArray(data.wheels) || !Array.isArray(data.trades)) {
    throw new Error('Backup must contain "wheels" and "trades" arrays.');
  }
  if ((data.version ?? 0) > BACKUP_VERSION) {
    throw new Error('This backup was made with a newer version of Wheel Desk.');
  }
  return data;
}
