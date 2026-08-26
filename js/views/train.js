/* Train — workout plans per member + live session check-off. */
import {
  getState, mutate, me, memberById, todayStr, dowOf, logKey, uid,
} from '../store.js';
import { $, $$, esc, openSheet, closeSheet, confirmSheet, toast, progressBar } from '../ui.js';

let member = null;
const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

export const trainView = {
  id: 'train',
  title: () => 'Training',
  subtitle: () => `${(member ? memberById(member) : me()).name}'s plans`,
  fab: () => openPlanSheet(null),

  render(root) { renderInto(root); },
};

let lastRoot = null;
function rerender() { if (lastRoot) renderInto(lastRoot); }

function renderInto(root) {
  lastRoot = root;
  const s = getState();
  if (!member || !memberById(member)) member = me().id;
  const plans = s.workoutPlans[member] || [];
  const t = todayStr();
  const todayDow = dowOf(t);

  root.innerHTML = `
  <div class="fade-in">
    <div class="chips" style="margin-bottom:12px">
      ${s.members.map((x) => `
        <button class="chip ${x.id === member ? 'is-on' : ''}" data-member="${x.id}"
          ${x.id === member ? `style="background:${x.color}"` : ''}>${esc(x.name)}</button>`).join('')}
    </div>

    ${plans.length ? plans.map((p) => {
      const isToday = p.dows.includes(todayDow);
      const log = (s.workoutLog[logKey(t, member)] || {})[p.id];
      const done = log?.done;
      return `
      <div class="card card-pad">
        <div class="row-between" style="margin-bottom:8px">
          <div class="col gap-4 grow">
            <div class="row gap-8">
              <span class="card-title">${esc(p.name)}</span>
              ${p.auto ? `<span class="pill">from your profile</span>` : ''}
              ${isToday ? `<span class="pill" style="background:var(--accent-soft);color:var(--accent)">Today</span>` : ''}
              ${done ? `<span class="pill" style="background:var(--green-soft);color:var(--green)">Done ✓</span>` : ''}
            </div>
            <span class="small dim">${p.exercises.length} exercises · ${p.dows.map((d) => DOW[d]).join(' · ') || 'unscheduled'}</span>
          </div>
          <button class="btn btn-sm" data-edit="${p.id}">Edit</button>
        </div>
        <ul>
          ${p.exercises.slice(0, 3).map((e) => `
            <li class="small muted" style="padding:2px 0">• ${esc(e.name)} — ${e.sets}×${esc(String(e.reps))}</li>`).join('')}
          ${p.exercises.length > 3 ? `<li class="small dim" style="padding:2px 0">+ ${p.exercises.length - 3} more…</li>` : ''}
        </ul>
        ${member === me().id && isToday ? `
          <button class="btn ${done ? 'btn-success' : 'btn-primary'} btn-block" style="margin-top:11px" data-session="${p.id}">
            ${done ? 'Review session' : 'Start session'}
          </button>` : ''}
      </div>`;
    }).join('') : `
      <div class="card"><div class="empty"><span class="empty-ico">🏋️</span>
        No workout plans yet for ${esc(memberById(member).name)}.<br>
        Run the <b>profile wizard</b> (Today banner, or Team → member) and a split gets built from the answers — or tap + to make one by hand.</div></div>`}
  </div>`;

  $$('[data-member]', root).forEach((b) => b.addEventListener('click', () => {
    member = b.dataset.member; rerender();
    window.dispatchEvent(new CustomEvent('mav:titlechange'));
  }));
  $$('[data-edit]', root).forEach((b) => b.addEventListener('click', () => {
    const p = plans.find((x) => x.id === b.dataset.edit);
    if (p) openPlanSheet(p);
  }));
  $$('[data-session]', root).forEach((b) => b.addEventListener('click', () =>
    openSession(b.dataset.session, t)));
}

/* ---------- live session sheet ---------- */
export function openSession(planId, dateStr) {
  const s = getState();
  const mId = me().id;
  const plan = (s.workoutPlans[mId] || []).find((p) => p.id === planId);
  if (!plan) { toast('Plan not found'); return; }

  const key = logKey(dateStr, mId);
  const getLog = () => (getState().workoutLog[key] || {})[planId] || { ex: {}, done: false };

  const body = () => {
    const log = getLog();
    const doneCount = plan.exercises.filter((_, i) => log.ex[i]).length;
    return `
      <div style="margin-bottom:14px">${progressBar(plan.exercises.length ? doneCount / plan.exercises.length : 0,
        log.done ? 'var(--green)' : 'var(--accent)')}</div>
      <div class="list" style="margin-bottom:16px">
        ${plan.exercises.map((e, i) => `
          <button class="list-row" data-ex="${i}">
            <span class="check ${log.ex[i] ? 'is-on' : ''}">✓</span>
            <span class="grow">
              <div class="list-title" style="${log.ex[i] ? 'opacity:.55' : ''}">${esc(e.name)}</div>
              <div class="list-sub">${e.sets} sets × ${esc(String(e.reps))}</div>
            </span>
          </button>`).join('')}
      </div>
      <button class="btn ${log.done ? 'btn-success' : 'btn-primary'} btn-block" id="finishBtn">
        ${log.done ? 'Session complete ✓ (tap to reopen)' : 'Finish workout'}
      </button>`;
  };

  const wire = (root) => {
    $$('[data-ex]', root).forEach((b) => b.addEventListener('click', () => {
      const i = Number(b.dataset.ex);
      mutate((st) => {
        st.workoutLog[key] = st.workoutLog[key] || {};
        const l = st.workoutLog[key][planId] = st.workoutLog[key][planId] || { ex: {}, done: false };
        l.ex[i] = !l.ex[i];
      });
      refresh(root);
    }));
    $('#finishBtn', root).addEventListener('click', () => {
      mutate((st) => {
        st.workoutLog[key] = st.workoutLog[key] || {};
        const l = st.workoutLog[key][planId] = st.workoutLog[key][planId] || { ex: {}, done: false };
        l.done = !l.done;
        if (l.done) plan.exercises.forEach((_, i) => { l.ex[i] = true; });
      });
      const l = getLog();
      if (l.done) { toast('Workout logged 💪'); closeSheet(); }
      else refresh(root);
    });
  };
  const refresh = (root) => { root.innerHTML = body(); wire(root); };

  openSheet({ title: plan.name, body: body(), onSave: null, setup: wire });
}

/* ---------- plan builder sheet ---------- */
function openPlanSheet(plan = null) {
  const isNew = !plan;
  const data = plan
    ? { ...plan, exercises: plan.exercises.map((e) => ({ ...e })) }
    : { id: uid(), name: '', dows: [], exercises: [{ name: '', sets: 3, reps: '10' }] };

  const exRow = (e, i) => `
    <div class="row gap-8" data-exrow="${i}" style="margin-bottom:8px">
      <input class="input grow" data-f="name" placeholder="Exercise" value="${esc(e.name)}" />
      <input class="input" data-f="sets" type="number" inputmode="numeric" value="${e.sets}" style="width:64px;flex:none" aria-label="Sets" />
      <input class="input" data-f="reps" value="${esc(String(e.reps))}" style="width:76px;flex:none" aria-label="Reps" />
      <button class="icon-btn" data-rm="${i}" aria-label="Remove" style="color:var(--red)">✕</button>
    </div>`;

  openSheet({
    title: isNew ? 'New plan' : 'Edit plan',
    saveLabel: isNew ? 'Create' : 'Save',
    body: `
      <div class="field">
        <label class="label" for="pName">Plan name</label>
        <input class="input" id="pName" placeholder="e.g. Push Day" value="${esc(data.name)}" />
      </div>
      <div class="field">
        <label class="label">Days</label>
        <div class="picker" id="pDows">
          ${DOW.map((d, i) => `
            <button class="picker-opt ${data.dows.includes(i) ? 'is-on' : ''}" data-dow="${i}">${d}</button>`).join('')}
        </div>
      </div>
      <div class="field">
        <label class="label">Exercises <span class="dim" style="text-transform:none;letter-spacing:0">(name · sets · reps)</span></label>
        <div id="exList">${data.exercises.map(exRow).join('')}</div>
        <button class="btn btn-sm" id="addEx">+ Add exercise</button>
      </div>
      ${isNew ? '' : `<button class="btn btn-danger btn-block" id="pDelete">Delete plan</button>`}
    `,
    setup: (root) => {
      $$('#pDows .picker-opt', root).forEach((b) =>
        b.addEventListener('click', () => b.classList.toggle('is-on')));

      const list = $('#exList', root);
      const wireRemoves = () => $$('[data-rm]', list).forEach((b) => {
        b.onclick = () => { b.closest('[data-exrow]').remove(); };
      });
      wireRemoves();
      $('#addEx', root).addEventListener('click', () => {
        const div = document.createElement('div');
        div.innerHTML = exRow({ name: '', sets: 3, reps: '10' }, Date.now());
        list.appendChild(div.firstElementChild);
        wireRemoves();
      });

      const del = $('#pDelete', root);
      if (del) del.addEventListener('click', () => {
        closeSheet();
        confirmSheet('Delete plan', `Delete “${data.name}”?`, () => {
          mutate((s) => {
            s.workoutPlans[member] = (s.workoutPlans[member] || []).filter((p) => p.id !== data.id);
          });
          toast('Plan deleted');
          rerender();
        });
      });
      $('#pName', root).focus();
    },
    onSave: () => {
      const root = $('#sheetBody');
      const name = $('#pName', root).value.trim();
      if (!name) { toast('Name the plan'); return false; }
      const exercises = $$('[data-exrow]', root).map((row) => ({
        name: $('[data-f="name"]', row).value.trim(),
        sets: Number($('[data-f="sets"]', row).value) || 3,
        reps: $('[data-f="reps"]', row).value.trim() || '10',
      })).filter((e) => e.name);
      if (!exercises.length) { toast('Add at least one exercise'); return false; }
      const next = {
        ...data, name, exercises,
        dows: $$('#pDows .is-on', root).map((b) => Number(b.dataset.dow)).sort(),
      };
      mutate((s) => {
        s.workoutPlans[member] = s.workoutPlans[member] || [];
        const i = s.workoutPlans[member].findIndex((p) => p.id === next.id);
        if (i >= 0) s.workoutPlans[member][i] = next; else s.workoutPlans[member].push(next);
      });
      toast(isNew ? 'Plan created' : 'Plan saved');
      rerender();
    },
  });
}
