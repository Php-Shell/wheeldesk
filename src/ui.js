// Small DOM/UI helpers shared by every view.

import { escapeHtml } from './format.js';

export function toast(message, type = 'success', ms = 3200) {
  const host = document.getElementById('toasts');
  if (!host) return;
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.textContent = message;
  host.appendChild(el);
  setTimeout(() => {
    el.style.opacity = '0';
    el.style.transform = 'translateY(6px)';
    el.style.transition = 'all .2s';
    setTimeout(() => el.remove(), 220);
  }, ms);
}

export function openModal(title, html, onMount) {
  const dialog = document.getElementById('modal');
  document.getElementById('modalTitle').textContent = title;
  const body = document.getElementById('modalBody');
  body.innerHTML = html;
  if (typeof dialog.showModal === 'function') dialog.showModal();
  else dialog.setAttribute('open', '');
  const close = () => closeModal();
  document.getElementById('modalClose').onclick = close;
  if (typeof onMount === 'function') onMount(body, close);
  return close;
}

export function closeModal() {
  const dialog = document.getElementById('modal');
  if (dialog.open) dialog.close();
  else dialog.removeAttribute('open');
}

export function confirmDialog(message, { danger = false, confirmText = 'Confirm' } = {}) {
  return new Promise((resolve) => {
    openModal('Please confirm', `
      <p>${escapeHtml(message)}</p>
      <div class="row" style="justify-content:flex-end;gap:10px;margin-top:18px">
        <button class="btn btn-secondary" data-no>Cancel</button>
        <button class="btn ${danger ? 'btn-danger' : 'btn-primary'}" data-yes>${escapeHtml(confirmText)}</button>
      </div>`, (body, close) => {
      body.querySelector('[data-no]').onclick = () => { close(); resolve(false); };
      body.querySelector('[data-yes]').onclick = () => { close(); resolve(true); };
    });
  });
}

export function badge(status, text) {
  const map = { pass: 'pass', warn: 'warn', fail: 'fail', unknown: 'unknown', info: 'info', green: 'green', amber: 'amber', red: 'red', purple: 'purple' };
  return `<span class="badge ${map[status] || ''}">${escapeHtml(text)}</span>`;
}

export function tip(label, why) {
  return `<span class="tip" tabindex="0" data-tip="${escapeHtml(why)}">${escapeHtml(label)}</span>`;
}

export function field({ label, name, value = '', type = 'number', step = 'any', placeholder = '', hint = '', required = false, min, max, options }) {
  const attrs = `id="${name}" name="${name}" ${required ? 'required' : ''} ${min !== undefined ? `min="${min}"` : ''} ${max !== undefined ? `max="${max}"` : ''}`;
  const control = options
    ? `<select ${attrs}>${options.map((o) => `<option value="${escapeHtml(o.value)}" ${String(o.value) === String(value) ? 'selected' : ''}>${escapeHtml(o.label)}</option>`).join('')}</select>`
    : type === 'textarea'
      ? `<textarea ${attrs} placeholder="${escapeHtml(placeholder)}">${escapeHtml(value)}</textarea>`
      : `<input ${attrs} type="${type}" ${type === 'number' ? `step="${step}"` : ''} value="${escapeHtml(value)}" placeholder="${escapeHtml(placeholder)}" />`;
  return `<div class="field"><label for="${name}">${escapeHtml(label)}${hint ? ` <span class="hint">${escapeHtml(hint)}</span>` : ''}</label>${control}</div>`;
}

export function readForm(root) {
  const data = {};
  root.querySelectorAll('input, select, textarea').forEach((el) => {
    if (!el.name) return;
    data[el.name] = el.type === 'checkbox' ? el.checked : el.value;
  });
  return data;
}

export function statusDot(status) {
  const map = { green: '', amber: 'pending', red: 'error', offline: 'offline' };
  return `<span class="status-dot ${map[status] || ''}"></span>`;
}

export function chart(id, height = 240) {
  return `<div class="chart-box" style="height:${height}px"><canvas id="${id}"></canvas></div>`;
}

export function drawChart(canvasId, config) {
  const canvas = document.getElementById(canvasId);
  if (!canvas || typeof window.Chart === 'undefined') return;
  window.Chart.getChart?.(canvas)?.destroy();
  // eslint-disable-next-line no-new
  new window.Chart(canvas, config);
}

export const chartColors = ['#0f9d6c', '#3b6fe0', '#b7791f', '#7c5cff', '#d9534f', '#0ea5e9'];
