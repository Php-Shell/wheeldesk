// ---------------------------------------------------------------------------
// Supabase email auth + state sync. The anon key is public by design; Row Level
// Security in schema.sql is what actually protects each user's data.
// ---------------------------------------------------------------------------

const SESSION_KEY = 'wheel-session';
let cfg = { url: '', key: '' };
let session = null;

export const auth = {
  configure(next) {
    cfg = { url: next?.supabaseUrl || '', key: next?.supabaseAnonKey || '' };
    return cfg;
  },
  configured() {
    return Boolean(cfg.url && cfg.key);
  },
  get() {
    return session;
  },
  async restore() {
    try {
      const raw = localStorage.getItem(SESSION_KEY);
      if (raw) session = JSON.parse(raw);
    } catch {
      session = null;
    }
    if (session?.refresh_token && session?.expires_at && session.expires_at * 1000 < Date.now() + 60000) {
      try {
        await auth.refresh();
      } catch {
        session = null;
        localStorage.removeItem(SESSION_KEY);
      }
    }
    return session;
  },
  async refresh() {
    const r = await fetch(`${cfg.url}/auth/v1/token?grant_type=refresh_token`, {
      method: 'POST',
      headers: { apikey: cfg.key, 'Content-Type': 'application/json' },
      body: JSON.stringify({ refresh_token: session.refresh_token }),
    });
    const x = await r.json();
    if (!r.ok) throw new Error(x.error_description || x.msg || 'Could not refresh session.');
    session = x;
    localStorage.setItem(SESSION_KEY, JSON.stringify(x));
    return session;
  },
  async signIn(email, password) {
    return call('token?grant_type=password', { email, password });
  },
  async signUp(email, password) {
    return call('signup', { email, password });
  },
  async signOut() {
    session = null;
    localStorage.removeItem(SESSION_KEY);
    return true;
  },
  token() {
    return session?.access_token || null;
  },
  async sync(state) {
    if (!session || !cfg.url) return { status: 'offline' };
    const headers = { apikey: cfg.key, Authorization: `Bearer ${session.access_token}`, 'Content-Type': 'application/json' };
    const existing = await fetch(`${cfg.url}/rest/v1/user_state?select=updated_at&user_id=eq.${session.user.id}`, { headers });
    if (!existing.ok) throw new Error(`Sync read failed (${existing.status}).`);
    const rows = await existing.json();
    const remoteAt = rows?.[0]?.updated_at;
    const localAt = state?.meta?.lastSyncAt;
    if (remoteAt && localAt && new Date(remoteAt) > new Date(localAt)) {
      return { status: 'conflict', remoteUpdatedAt: remoteAt };
    }
    const r = await fetch(`${cfg.url}/rest/v1/user_state?on_conflict=user_id`, {
      method: 'POST',
      headers: { ...headers, Prefer: 'resolution=merge-duplicates' },
      body: JSON.stringify({ user_id: session.user.id, payload: state, updated_at: new Date().toISOString() }),
    });
    if (!r.ok) throw new Error(`Sync write failed (${r.status}).`);
    return { status: 'synced', at: new Date().toISOString() };
  },
  async pull() {
    if (!session || !cfg.url) return null;
    const r = await fetch(`${cfg.url}/rest/v1/user_state?select=payload&user_id=eq.${session.user.id}`, {
      headers: { apikey: cfg.key, Authorization: `Bearer ${session.access_token}` },
    });
    if (!r.ok) throw new Error(`Pull failed (${r.status}).`);
    const rows = await r.json();
    return rows?.[0]?.payload || null;
  },
};

async function call(path, body) {
  if (!cfg.url || !cfg.key) throw new Error('Supabase is not configured for this deployment.');
  const r = await fetch(`${cfg.url}/auth/v1/${path}`, {
    method: 'POST',
    headers: { apikey: cfg.key, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const x = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(x.error_description || x.msg || x.message || 'Authentication failed.');
  // Email confirmation flows may not return a session yet.
  if (x.access_token) {
    session = x;
    localStorage.setItem(SESSION_KEY, JSON.stringify(x));
  }
  return x;
}
