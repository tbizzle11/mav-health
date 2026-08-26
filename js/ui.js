/* ============================================================
   ui.js — shared UI helpers: sheets, toasts, icons, widgets.
   ============================================================ */

import { initialsOf, memberById } from './store.js';

export const $  = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

export const esc = (s) => String(s ?? '')
  .replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
  .replaceAll('"', '&quot;').replaceAll("'", '&#39;');

/* ---------- toast ---------- */
let toastTimer = null;
export function toast(msg) {
  const el = $('#toast');
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, 2200);
}

/* ---------- sheet ---------- */
let sheetSaveHandler = null;
let sheetBeforeClose = null;   // return false to block a user-initiated dismiss
let sheetGeneration = 0;       // bumps on every open/close — async callbacks check it

/** Current sheet generation. Capture it when opening; bail out of async
    callbacks if it changed (the sheet was closed or another one opened). */
export const sheetGen = () => sheetGeneration;

export function openSheet({ title, body, saveLabel = 'Save', onSave = null, setup = null, onBeforeClose = null }) {
  sheetGeneration++;
  const host = $('#sheetHost');
  $('#sheetTitle').textContent = title;
  $('#sheetBody').innerHTML = body;
  const saveBtn = $('#sheetSave');
  saveBtn.textContent = saveLabel;
  saveBtn.style.visibility = onSave ? 'visible' : 'hidden';
  sheetSaveHandler = onSave;
  sheetBeforeClose = onBeforeClose;
  host.hidden = false;
  document.body.style.overflow = 'hidden';
  if (setup) setup($('#sheetBody'));
}

export function closeSheet() {
  sheetGeneration++;
  $('#sheetHost').hidden = true;
  const body = $('#sheetBody');
  body.innerHTML = '';
  body.style.paddingBottom = '';
  document.body.style.overflow = '';
  sheetSaveHandler = null;
  sheetBeforeClose = null;
}

/* user-initiated dismiss (scrim / Cancel) — can be blocked by the sheet */
function requestCloseSheet() {
  if (sheetBeforeClose && sheetBeforeClose() === false) return;
  closeSheet();
}

export function initSheet() {
  $('#sheetHost').addEventListener('click', (e) => {
    if (e.target.dataset.close) requestCloseSheet();
  });
  $('#sheetSave').addEventListener('click', () => {
    if (sheetSaveHandler && sheetSaveHandler() !== false) closeSheet();
  });

  /* iOS: the software keyboard overlays the page without resizing it, hiding
     the bottom of the sheet. Pad the sheet body by the overlap so everything
     stays reachable, and keep the focused field in view. */
  if (window.visualViewport) {
    const vv = window.visualViewport;
    const adjust = () => {
      if ($('#sheetHost').hidden) return;
      const overlap = Math.max(0, window.innerHeight - vv.height - vv.offsetTop);
      $('#sheetBody').style.paddingBottom = overlap ? `${overlap + 12}px` : '';
    };
    vv.addEventListener('resize', adjust);
    vv.addEventListener('scroll', adjust);
  }
  document.addEventListener('focusin', (e) => {
    if (e.target.closest && e.target.closest('.sheet-body')) {
      setTimeout(() => e.target.scrollIntoView({ block: 'center', behavior: 'smooth' }), 250);
    }
  });
}

/* ---------- widgets ---------- */
export function avatar(member, cls = 'av') {
  if (!member) return '';
  return `<span class="${cls}" style="background:${member.color}">${esc(initialsOf(member.name))}</span>`;
}

export function avatarStack(ids, cls = 'av av-sm') {
  const items = ids.map((id) => memberById(id)).filter(Boolean)
    .map((m) => avatar(m, cls)).join('');
  return `<span class="av-stack">${items}</span>`;
}

/* gradient pairs for known ring colors */
const RING_GRADS = {
  'var(--amber)':  ['#f59e0b', '#fb7c37'],
  'var(--green)':  ['#10b981', '#14b8a6'],
  'var(--violet)': ['#8b5cf6', '#d946ef'],
  'var(--accent)': ['#6366f1', '#8b5cf6'],
  'var(--blue)':   ['#3b82f6', '#06b6d4'],
};
let ringSeq = 0;

export function ring(pct, size = 54, stroke = 6, color = 'var(--accent)', label = '') {
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  const off = c * (1 - Math.min(1, Math.max(0, pct)));
  const grad = RING_GRADS[color];
  const gid = `ringGrad${++ringSeq}`;
  const strokeRef = grad ? `url(#${gid})` : color;
  const glow = grad && pct > 0.04 ? `filter:drop-shadow(0 0 ${Math.round(size * 0.09)}px ${grad[0]}55)` : '';
  return `
  <div style="position:relative;width:${size}px;height:${size}px;flex:none">
    <svg class="ring" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}" style="${glow}">
      ${grad ? `<defs><linearGradient id="${gid}" x1="0%" y1="0%" x2="100%" y2="100%">
        <stop offset="0%" stop-color="${grad[0]}"/><stop offset="100%" stop-color="${grad[1]}"/>
      </linearGradient></defs>` : ''}
      <circle class="ring-track" cx="${size / 2}" cy="${size / 2}" r="${r}" fill="none" stroke-width="${stroke}"/>
      <circle class="ring-val" cx="${size / 2}" cy="${size / 2}" r="${r}" fill="none"
        stroke="${strokeRef}" stroke-width="${stroke}"
        stroke-dasharray="${c.toFixed(1)}" stroke-dashoffset="${off.toFixed(1)}"/>
    </svg>
    <div style="position:absolute;inset:0;display:grid;place-items:center;font-family:var(--font-display);
      font-size:${size * 0.24}px;font-weight:750;font-variant-numeric:tabular-nums;letter-spacing:-.02em">${label}</div>
  </div>`;
}

export function progressBar(pct, color = 'var(--accent)') {
  return `<div class="bar"><div class="bar-fill" style="width:${Math.min(100, pct * 100)}%;background:${color}"></div></div>`;
}

/* ---------- tab icons (SF-symbol-ish, stroke SVG) ---------- */
const ICONS = {
  today: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="4.2"/><path d="M12 2.5v2.4M12 19.1v2.4M2.5 12h2.4M19.1 12h2.4M5.3 5.3l1.7 1.7M17 17l1.7 1.7M18.7 5.3L17 7M7 17l-1.7 1.7"/></svg>`,
  calendar: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="3.2" y="4.8" width="17.6" height="16" rx="3.5"/><path d="M3.2 9.6h17.6M8 2.8v3.6M16 2.8v3.6"/><circle cx="8.2" cy="14" r="1.15" fill="currentColor" stroke="none"/><circle cx="12" cy="14" r="1.15" fill="currentColor" stroke="none"/><circle cx="15.8" cy="14" r="1.15" fill="currentColor" stroke="none"/></svg>`,
  meals: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M5.5 2.8v7.4M8.3 2.8v7.4M6.9 2.8v18.4M6.9 10.2c-1.9 0-2.8-1-2.8-2.6V2.8M17 13.5v7.7M17 13.5c-2 0-3.3-2.4-3.3-5.4 0-3 1.5-5.3 3.3-5.3s3.3 2.3 3.3 5.3c0 3-1.3 5.4-3.3 5.4z"/></svg>`,
  train: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M7.2 12h9.6"/><rect x="4" y="8.2" width="2.6" height="7.6" rx="1.2"/><rect x="17.4" y="8.2" width="2.6" height="7.6" rx="1.2"/><rect x="1.6" y="10" width="1.7" height="4" rx="0.8"/><rect x="20.7" y="10" width="1.7" height="4" rx="0.8"/></svg>`,
  team: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="9" cy="8.4" r="3.4"/><path d="M2.8 20.2c0-3.2 2.8-5.4 6.2-5.4s6.2 2.2 6.2 5.4"/><circle cx="17.2" cy="9.4" r="2.7"/><path d="M16.4 14.9c2.9.2 5 2.2 5 4.8"/></svg>`,
  gear: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" style="width:19px;height:19px"><circle cx="12" cy="12" r="3.1"/><path d="M12 2.8v2.6M12 18.6v2.6M2.8 12h2.6M18.6 12h2.6M5.5 5.5l1.8 1.8M16.7 16.7l1.8 1.8M18.5 5.5l-1.8 1.8M7.3 16.7l-1.8 1.8"/></svg>`,
  home: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" style="width:18px;height:18px"><path d="M3.5 10.8 12 3.6l8.5 7.2M5.5 9.3V20a1 1 0 0 0 1 1h11a1 1 0 0 0 1-1V9.3M9.8 21v-6.3a1 1 0 0 1 1-1h2.4a1 1 0 0 1 1 1V21"/></svg>`,
};

export const uiIcon = (name) => ICONS[name] || '';

export function mountTabIcons() {
  $$('[data-ico]').forEach((el) => { el.innerHTML = ICONS[el.dataset.ico] || ''; });
}

/* confirm helper (sheet-based, no window.confirm) */
export function confirmSheet(title, message, onYes, yesLabel = 'Delete') {
  openSheet({
    title,
    body: `<p class="muted" style="margin:4px 2px 18px">${esc(message)}</p>
      <button class="btn btn-danger btn-block" id="confirmYes">${esc(yesLabel)}</button>`,
    onSave: null,
    setup: (root) => {
      $('#confirmYes', root).addEventListener('click', () => { closeSheet(); onYes(); });
    },
  });
}
