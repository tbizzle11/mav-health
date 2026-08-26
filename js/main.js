/* ============================================================
   main.js — boot, router, chrome (topbar / tabbar / fab).
   ============================================================ */
import { initStore, subscribe, getState, mutate, me, initialsOf } from './store.js';
import { $, $$, esc, mountTabIcons, initSheet, openSheet, closeSheet, toast, uiIcon } from './ui.js';
import { todayView } from './views/today.js';
import { calendarView } from './views/calendar.js';
import { mealsView } from './views/meals.js';
import { trainView } from './views/train.js';
import { teamView } from './views/team.js';
import { openMemberSheet } from './views/team.js';
import { openScanSheet, peekPendingScan } from './views/scan.js';
import { openSettingsSheet, applyTheme } from './views/settings.js';
import { initSync } from './sync.js';

const VIEWS = { today: todayView, calendar: calendarView, meals: mealsView, train: trainView, team: teamView };

let current = 'today';
let fabEl = null;

function routeFromHash() {
  const h = (location.hash || '#/today').replace('#/', '');
  return VIEWS[h] ? h : 'today';
}

function renderChrome() {
  const v = VIEWS[current];
  $('#viewTitle').textContent = typeof v.title === 'function' ? v.title() : v.title;
  $('#viewSubtitle').textContent = typeof v.subtitle === 'function' ? v.subtitle() : (v.subtitle || '');

  const m = me();
  const av = $('#profileBtn');
  av.textContent = initialsOf(m.name);
  av.style.background = m.color;

  $$('.tab').forEach((t) => t.classList.toggle('is-active', t.dataset.tab === current));

  // fab
  if (fabEl) { fabEl.remove(); fabEl = null; }
  if (v.fab) {
    fabEl = document.createElement('button');
    fabEl.className = 'fab';
    fabEl.textContent = '+';
    fabEl.setAttribute('aria-label', 'Add');
    fabEl.addEventListener('click', () => v.fab());
    document.body.appendChild(fabEl);
  }

  // top action (e.g. calendar "jump to today")
  const ta = $('#topAction');
  if (v.topAction) {
    ta.hidden = false;
    if (v.topAction.ico) ta.innerHTML = uiIcon(v.topAction.ico);
    else ta.textContent = v.topAction.icon;
    ta.onclick = () => v.topAction.run();
  } else { ta.hidden = true; ta.onclick = null; }
}

function render() {
  current = routeFromHash();
  renderChrome();
  const root = $('#view');
  root.scrollTop = 0;
  VIEWS[current].render(root);
}

/* first-run: who is using this phone? */
function firstRun() {
  const s = getState();
  if (s.me && s.members.some((m) => m.id === s.me)) return;
  openSheet({
    title: 'Who are you?',
    body: `
      <p class="small muted" style="margin-bottom:14px">Pick yourself so this phone shows your meals, workouts and goals. You can change this any time in the Team tab.</p>
      <div class="col gap-8" id="whoList">
        ${s.members.map((m) => `
          <button class="btn btn-block" data-iam="${m.id}" style="justify-content:flex-start">
            <span class="av" style="background:${m.color}">${esc(initialsOf(m.name))}</span> ${esc(m.name)}
          </button>`).join('')}
        <button class="btn btn-quiet btn-block" id="whoNew">+ I'm someone else</button>
      </div>`,
    onSave: null,
    setup: (root) => {
      $$('[data-iam]', root).forEach((b) => b.addEventListener('click', () => {
        mutate((st) => { st.me = b.dataset.iam; });
        closeSheet();
        toast(`Welcome, ${me().name}!`);
        render();
      }));
      $('#whoNew', root).addEventListener('click', () => {
        closeSheet();
        openMemberSheet(null);
      });
    },
  });
}

/* boot */
window.__mavBuild = 12; // bump to verify which build the page runs
applyTheme();
initStore();
mountTabIcons();
initSheet();

window.addEventListener('hashchange', render);
window.addEventListener('mav:titlechange', renderChrome);
// any data mutation re-renders the active view so the UI never goes stale
subscribe(() => {
  renderChrome();
  const root = $('#view');
  VIEWS[current].render(root);
  // skip the entry animation on data refreshes (it's for navigation only)
  $$('.fade-in', root).forEach((el) => el.classList.remove('fade-in'));
});

$('#profileBtn').addEventListener('click', () => { location.hash = '#/team'; });
$('#settingsBtn').addEventListener('click', openSettingsSheet);

// re-render Today at midnight-ish / on focus so dates stay fresh
window.addEventListener('focus', () => render());

render();
firstRun();
initSync();

/* If iOS reloaded the app mid-scan (camera round-trip under memory pressure),
   pick the scan back up instead of silently losing the photo. */
const pendingScan = getState().me ? peekPendingScan() : null;
if (pendingScan) openScanSheet(pendingScan.targetDate, pendingScan.member, pendingScan);

/* PWA service worker */
if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost' || location.hostname === '127.0.0.1')) {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}
