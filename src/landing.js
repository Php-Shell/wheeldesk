// Landing / account gate. Shown before the dashboard when Supabase is
// configured and the visitor is not signed in. Each account gets its own data
// (Supabase RLS), so two people can share the site safely.
import { auth } from './supabase.js';
import { escapeHtml } from './format.js';

let mode = 'signin';

export function showGate({ onAuthed, onLocal }) {
  const gate = document.getElementById('gate');
  const shell = document.querySelector('.app-shell');
  if (shell) shell.style.display = 'none';
  gate.classList.remove('hidden');
  gate.innerHTML = render();
  bind(gate, { onAuthed, onLocal });
  const first = gate.querySelector('#gateEmail');
  if (first) setTimeout(() => first.focus(), 50);
}

export function hideGate() {
  const gate = document.getElementById('gate');
  gate.classList.add('hidden');
  gate.innerHTML = '';
  const shell = document.querySelector('.app-shell');
  if (shell) shell.style.display = '';
}

function render() {
  const isSignup = mode === 'signup';
  return `
    <div class="gate-inner">
      <div class="gate-hero">
        <div class="brand" style="margin-bottom:18px"><span class="brand-mark">☸</span><div><b>Wheel Desk</b><small>learn · plan · record</small></div></div>
        <h1>Get paid to wait.</h1>
        <p class="muted">A calm, beginner-friendly dashboard for the cash-secured put &amp; wheel strategy: screen quality puts, size them safely, log every trade, and recover with a plan if you get assigned.</p>
        <ul class="gate-list">
          <li>✅ Live checklist from free market data (or enter everything manually).</li>
          <li>✅ Step-by-step IBKR wizards and an assignment assistant.</li>
          <li>✅ Your own private account — your friend gets their own.</li>
          <li>⚖️ Educational tool, not financial advice.</li>
        </ul>
      </div>
      <div class="gate-card card pad-lg">
        <div class="gate-tabs">
          <button class="gate-tab ${!isSignup ? 'active' : ''}" data-mode="signin">Sign in</button>
          <button class="gate-tab ${isSignup ? 'active' : ''}" data-mode="signup">Create account</button>
        </div>
        <h2>${isSignup ? 'Create your account' : 'Welcome back'}</h2>
        <p class="muted" style="font-size:13px">${isSignup ? 'Your data is private to your account.' : 'Sign in to load your wheels.'}</p>
        <div class="field"><label>Email</label><input id="gateEmail" type="email" placeholder="you@example.com" autocomplete="email" /></div>
        <div class="field"><label>Password</label><input id="gatePassword" type="password" placeholder="At least 6 characters" autocomplete="${isSignup ? 'new-password' : 'current-password'}" /></div>
        ${isSignup ? '<div class="field"><label>Confirm password</label><input id="gateConfirm" type="password" placeholder="Repeat password" autocomplete="new-password" /></div>' : ''}
        <div id="gateMsg" class="mt"></div>
        <button class="btn btn-primary" id="gateSubmit" style="width:100%">${isSignup ? 'Create account' : 'Sign in'}</button>
        <p class="muted center" style="font-size:11.5px;margin-top:12px">By continuing you agree this is an educational tool and not financial advice.</p>
        <div class="notice info" style="margin-top:12px">
          <button class="btn btn-ghost btn-sm" id="gateLocal">Continue without an account →</button>
          <div class="muted" style="font-size:11.5px;margin-top:4px">Data stays only in this browser (no sync, no sharing).</div>
        </div>
      </div>
    </div>`;
}

function bind(gate, { onAuthed, onLocal }) {
  gate.querySelectorAll('[data-mode]').forEach((b) => {
    b.onclick = () => { mode = b.dataset.mode; gate.innerHTML = render(); bind(gate, { onAuthed, onLocal }); gate.querySelector('#gateEmail')?.focus(); };
  });
  gate.querySelector('#gateLocal').onclick = () => onLocal();

  const submit = async () => {
    const email = gate.querySelector('#gateEmail').value.trim();
    const password = gate.querySelector('#gatePassword').value;
    const confirm = gate.querySelector('#gateConfirm')?.value;
    const msg = gate.querySelector('#gateMsg');
    const btn = gate.querySelector('#gateSubmit');
    msg.innerHTML = '';
    btn.disabled = true;
    const label = btn.textContent;
    btn.textContent = 'Please wait…';
    try {
      const res = mode === 'signup' ? await auth.signUp(email, password, confirm) : await auth.signIn(email, password);
      if (res?.access_token) { onAuthed(); return; }
      msg.innerHTML = '<div class="notice info">Account created. Check your email to confirm it, then sign in.</div>';
      mode = 'signin';
      gate.innerHTML = render(); bind(gate, { onAuthed, onLocal });
    } catch (err) {
      msg.innerHTML = `<div class="notice error">${escapeHtml(err.message)}</div>`;
    } finally {
      btn.disabled = false;
      btn.textContent = label;
    }
  };
  gate.querySelector('#gateSubmit').onclick = submit;
  gate.querySelectorAll('#gateEmail,#gatePassword,#gateConfirm').forEach((el) => {
    el.addEventListener('keydown', (e) => { if (e.key === 'Enter') submit(); });
  });
}
