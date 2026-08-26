/* Team — members, goals, device identity, data export/import. */
import {
  getState, mutate, me, memberById, initialsOf, workoutsThisWeek, uid, logKey,
  todayStr, addDays, MEMBER_COLORS,
} from '../store.js';
import { $, $$, esc, avatar, openSheet, closeSheet, confirmSheet, toast } from '../ui.js';
import { openProfileWizard } from './profile.js';

export const teamView = {
  id: 'team',
  title: () => 'Team',
  subtitle: () => 'MAV — Market Mavericks',
  fab: () => openMemberSheet(null),

  render(root) { renderInto(root); },
};

let lastRoot = null;
let editingStakes = false;
function rerender() { if (lastRoot) renderInto(lastRoot); }

function renderInto(root) {
  lastRoot = root;
  const s = getState();

  root.innerHTML = `
  <div class="fade-in">
    ${s.stakes && !editingStakes ? `
      <button class="banner banner-amber" id="stakesBanner" style="width:100%;text-align:left;margin-bottom:4px">
        ⚖️ <b>The stakes:</b> ${esc(s.stakes)} <span class="tiny dim">· tap to change</span>
      </button>` : `
      <div class="row gap-8" style="margin-bottom:4px">
        <input class="input grow" id="stakesInput" placeholder="⚖️ Set the stakes — e.g. loser buys the protein shakes"
          value="${esc(s.stakes || '')}" />
        <button class="btn btn-sm btn-primary" id="stakesSave" style="flex:none">Set</button>
      </div>`}

    <div class="section-head"><h2>The scoreboard</h2></div>
    <div class="list">
      ${s.members.map((m) => {
        const must = m.checklist?.must || [];
        const yd = addDays(todayStr(), -1);
        const ydLog = s.checklistLog[logKey(yd, m.id)] || {};
        const tdLog = s.checklistLog[logKey(todayStr(), m.id)] || {};
        const ydDone = must.filter((x) => ydLog[x.id]).length;
        const tdDone = must.filter((x) => tdLog[x.id]).length;
        const slacked = must.length > 0 && ydDone < must.length;
        return `
        <button class="list-row" data-member="${m.id}">
          ${avatar(m, 'av av-lg')}
          <span class="grow" style="min-width:0">
            <div class="list-title">${esc(m.name)}
              ${m.id === me().id ? '<span class="pill" style="background:var(--accent-soft);color:var(--accent)">You</span>' : ''}
              ${!must.length ? '<span class="pill">no musts set</span>'
                : slacked ? '<span class="pill pill-owes" style="background:var(--red-soft);color:var(--red)">😈 owes the stakes</span>'
                : '<span class="pill" style="background:var(--green-soft);color:var(--green)">clear ✓</span>'}
            </div>
            <div class="list-sub">
              ${must.length ? `yesterday ${ydDone}/${must.length} musts · ` : ''}${workoutsThisWeek(m.id)}/${m.goals.workouts} workouts this wk
            </div>
          </span>
          ${must.length ? `
            <span class="col center" style="flex:none">
              <span class="stat-v num" style="font-size:19px;${tdDone === must.length ? 'color:var(--green)' : ''}">${tdDone}/${must.length}</span>
              <span class="tiny dim">today</span>
            </span>` : ''}
          <span class="chev">›</span>
        </button>`;
      }).join('')}
    </div>

    <p class="tiny dim center" style="margin-top:22px">Tap a member for goals, colors and the profile wizard.<br>Device stuff — theme, phone owner, AI key, backups — lives under ⚙️ up top.</p>
  </div>`;

  $$('[data-member]', root).forEach((b) => b.addEventListener('click', () => {
    const m = memberById(b.dataset.member);
    if (m) openMemberSheet(m);
  }));

  $('#stakesBanner', root)?.addEventListener('click', () => {
    editingStakes = true; rerender();
    $('#stakesInput', lastRoot)?.focus();
  });
  $('#stakesSave', root)?.addEventListener('click', () => {
    const v = $('#stakesInput', root).value.trim();
    editingStakes = false;
    mutate((s2) => { s2.stakes = v; });
    toast(v ? 'Stakes locked in 😈' : 'Stakes cleared');
  });
}

/* ---------- member sheet ---------- */
export function openMemberSheet(m = null) {
  const s = getState();
  const isNew = !m;
  const data = m || {
    id: uid(), name: '',
    color: MEMBER_COLORS[s.members.length % MEMBER_COLORS.length],
    goals: { calories: 2400, protein: 160, water: 8, workouts: 4 },
  };

  openSheet({
    title: isNew ? 'Add member' : data.name,
    saveLabel: isNew ? 'Add' : 'Save',
    body: `
      <div class="field">
        <label class="label" for="memName">Name</label>
        <input class="input" id="memName" placeholder="Name" value="${esc(data.name)}" />
      </div>
      <div class="field">
        <label class="label">Color</label>
        <div class="picker" id="memColor">
          ${MEMBER_COLORS.map((c) => `
            <button class="picker-opt ${data.color === c ? 'is-on' : ''}" data-color="${c}" aria-label="color"
              style="width:42px;height:42px;padding:0;border-radius:50%;background:${c};border-width:3px;
                     border-color:${data.color === c ? 'var(--text)' : 'transparent'}"></button>`).join('')}
        </div>
      </div>
      <div class="field field-row">
        <div>
          <label class="label" for="gCal">Calories / day</label>
          <input class="input" id="gCal" type="number" inputmode="numeric" value="${data.goals.calories}" />
        </div>
        <div>
          <label class="label" for="gPro">Protein (g)</label>
          <input class="input" id="gPro" type="number" inputmode="numeric" value="${data.goals.protein}" />
        </div>
      </div>
      <div class="field field-row">
        <div>
          <label class="label" for="gWater">Water (glasses)</label>
          <input class="input" id="gWater" type="number" inputmode="numeric" value="${data.goals.water}" />
        </div>
        <div>
          <label class="label" for="gWk">Workouts / week</label>
          <input class="input" id="gWk" type="number" inputmode="numeric" value="${data.goals.workouts}" />
        </div>
      </div>
      ${isNew ? '' : `<button class="btn btn-block" id="memProfile" style="margin-bottom:8px">📋 Profile &amp; plan wizard</button>`}
      ${isNew || s.members.length <= 1 ? '' :
        `<button class="btn btn-danger btn-block" id="memDelete">Remove ${esc(data.name)}</button>`}
    `,
    setup: (root) => {
      $$('#memColor .picker-opt', root).forEach((b) => b.addEventListener('click', () => {
        $$('#memColor .picker-opt', root).forEach((x) => {
          x.classList.remove('is-on'); x.style.borderColor = 'transparent';
        });
        b.classList.add('is-on'); b.style.borderColor = 'var(--text)';
      }));
      const prof = $('#memProfile', root);
      if (prof) prof.addEventListener('click', () => {
        closeSheet();
        openProfileWizard(data.id);
      });
      const del = $('#memDelete', root);
      if (del) del.addEventListener('click', () => {
        closeSheet();
        confirmSheet('Remove member', `Remove ${data.name} and their plans from the team?`, () => {
          mutate((s2) => {
            s2.members = s2.members.filter((x) => x.id !== data.id);
            delete s2.mealPlans[data.id];
            delete s2.workoutPlans[data.id];
            s2.events.forEach((e) => { e.members = e.members.filter((id) => id !== data.id); });
            if (s2.me === data.id) s2.me = s2.members[0]?.id || null;
          });
          toast('Member removed');
          rerender();
        }, 'Remove');
      });
      if (isNew) $('#memName', root).focus();
    },
    onSave: () => {
      const root = $('#sheetBody');
      const name = $('#memName', root).value.trim();
      if (!name) { toast('Add a name'); return false; }
      const next = {
        ...data, name,
        color: $('#memColor .is-on', root)?.dataset.color || data.color,
        goals: {
          calories: Number($('#gCal', root).value) || 2400,
          protein:  Number($('#gPro', root).value) || 160,
          water:    Number($('#gWater', root).value) || 8,
          workouts: Number($('#gWk', root).value) || 4,
        },
      };
      mutate((s2) => {
        const i = s2.members.findIndex((x) => x.id === next.id);
        if (i >= 0) s2.members[i] = next;
        else {
          s2.members.push(next);
          s2.mealPlans[next.id] = {};
          s2.workoutPlans[next.id] = [];
        }
      });
      toast(isNew ? `${name} added to the team` : 'Saved');
      rerender();
    },
  });
}
