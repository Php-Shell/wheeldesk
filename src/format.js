// Formatting and time helpers. DOM-free so they can be unit tested in Node.

export const CURRENCY_SYMBOLS = { USD: '$', EUR: '€', GBP: '£', CAD: 'C$', AUD: 'A$', CHF: 'CHF ', JPY: '¥' };

export function toNum(value, fallback = null) {
  if (value === null || value === undefined || value === '') return fallback;
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

export function round(n, digits = 2) {
  const v = toNum(n, 0);
  const f = Math.pow(10, digits);
  return Math.round((v + Number.EPSILON) * f) / f;
}

export function clamp(n, min, max) {
  return Math.min(max, Math.max(min, n));
}

export function money(value, currency = 'USD', digits = 2) {
  const n = toNum(value, null);
  if (n === null) return '—';
  const symbol = CURRENCY_SYMBOLS[currency] || '';
  const sign = n < 0 ? '-' : '';
  const abs = Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits });
  return `${sign}${symbol}${abs}`;
}

export function num(value, digits = 2) {
  const n = toNum(value, null);
  if (n === null) return '—';
  return n.toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits });
}

export function pct(value, digits = 2) {
  const n = toNum(value, null);
  if (n === null) return '—';
  return `${n.toFixed(digits)}%`;
}

export function signedPct(value, digits = 2) {
  const n = toNum(value, null);
  if (n === null) return '—';
  return `${n > 0 ? '+' : ''}${n.toFixed(digits)}%`;
}

export function minutesToLabel(minutes) {
  const m = Math.round(minutes);
  if (!Number.isFinite(m)) return '—';
  const d = Math.floor(m / 1440);
  const h = Math.floor((m % 1440) / 60);
  const mm = m % 60;
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${mm}m`;
  return `${mm}m`;
}

// ---- Dates & times -------------------------------------------------------

export function isoNow(date = new Date()) {
  return date.toISOString();
}

export function todayISO(date = new Date()) {
  return date.toISOString().slice(0, 10);
}

export function daysBetween(fromISO, toISO) {
  const from = new Date(fromISO).getTime();
  const to = new Date(toISO).getTime();
  if (!Number.isFinite(from) || !Number.isFinite(to)) return null;
  return Math.round((to - from) / 86400000);
}

export function addDays(date, days) {
  const d = new Date(date);
  d.setDate(d.getDate() + days);
  return d;
}

// Days to expiry (calendar days) measured from a reference moment.
export function dte(expiryISO, from = new Date()) {
  if (!expiryISO) return null;
  const exp = new Date(`${expiryISO}T20:00:00Z`).getTime();
  const now = new Date(from).getTime();
  if (!Number.isFinite(exp)) return null;
  return Math.ceil((exp - now) / 86400000);
}

export function fmtInZone(iso, timeZone, opts = {}) {
  const date = iso ? new Date(iso) : new Date();
  if (!Number.isFinite(date.getTime())) return '—';
  return new Intl.DateTimeFormat('en-GB', {
    timeZone,
    year: 'numeric',
    month: 'short',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
    ...opts,
  }).format(date);
}

export function localTimeZone() {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
}

// US Eastern Time helpers (market time).
export function etParts(date = new Date()) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    weekday: 'short',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(date);
  const get = (type) => parts.find((p) => p.type === type)?.value;
  const hour = Number(get('hour')) % 24;
  const minute = Number(get('minute'));
  return { weekday: get('weekday'), year: Number(get('year')), month: Number(get('month')), day: Number(get('day')), hour, minute, minutes: hour * 60 + minute };
}

const WEEKEND = new Set(['Sat', 'Sun']);

export function marketStatus(now = new Date()) {
  const { weekday, minutes, hour, minute } = etParts(now);
  const open = minutes >= 570 && minutes < 960;
  const isWeekend = WEEKEND.has(weekday);
  let state = 'closed';
  if (isWeekend) state = 'closed';
  else if (open) state = 'open';
  else if (minutes < 570) state = 'pre';
  else state = 'after';
  const clock = `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;

  // Next open label (browse forward up to 7 days).
  let nextOpenLabel = null;
  if (state !== 'open') {
    const probe = new Date(now.getTime());
    for (let i = 0; i < 8; i += 1) {
      const { weekday: wd, minutes: mins } = etParts(probe);
      if (!WEEKEND.has(wd) && mins < 570) {
        nextOpenLabel = `${wd} 09:30 ET`;
        break;
      }
      probe.setDate(probe.getDate() + 1);
    }
    if (!nextOpenLabel) nextOpenLabel = 'Mon 09:30 ET';
  }
  const label = { open: 'Market open', pre: 'Pre-market', after: 'After hours', closed: 'Market closed' }[state];
  return { state, label, open, clock: `${clock} ET`, weekday, nextOpenLabel };
}

// ---- Text ----------------------------------------------------------------

export function escapeHtml(str) {
  return String(str ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

export function titleCase(str) {
  return String(str || '')
    .toLowerCase()
    .replace(/(^|[\s_-])([a-z])/g, (m) => m.toUpperCase());
}

export function downloadText(filename, text, type = 'text/plain') {
  const blob = new Blob([text], { type });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
