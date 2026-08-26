/* Profile wizard — per-member onboarding across life categories:
   routines → daily checklist → goals → health numbers → gym → calorie plan.
   Finishing sets the member's calorie + protein goals from the chosen pace. */
import { getState, mutate, memberById, uid } from '../store.js';
import { $, $$, esc, openSheet, closeSheet, toast } from '../ui.js';
import { maintenanceCalories, paceOptions, proteinGoal, sleepHours, generateWorkoutPlans, splitName } from '../planner.js';

const DOW = ['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa'];
const ACTIVITIES = [
  { v: 1.2,   label: 'Desk life — little exercise outside the gym' },
  { v: 1.375, label: 'Lightly active — on my feet some of the day' },
  { v: 1.55,  label: 'Active — moving most of the day' },
  { v: 1.725, label: 'Very active — hard physical days' },
];
const GYM_GOALS = [
  { v: 'cut',      label: 'Lose fat' },
  { v: 'recomp',   label: 'Muscle up while leaning out' },
  { v: 'leanbulk', label: 'Lean bulk' },
  { v: 'bulk',     label: 'Full bulk' },
  { v: 'maintain', label: 'Maintain' },
];

export function openProfileWizard(memberId) {
  const m = memberById(memberId);
  if (!m) return;
  const p = m.profile || {};
  const draft = {
    wake: p.wake || '07:00',
    bed: p.bed || '23:00',
    busy: (p.busy || []).map((b) => ({ ...b, days: [...(b.days || [])] })),
    checklist: {
      must: (m.checklist?.must || []).map((x) => x.text),
      should: (m.checklist?.should || []).map((x) => x.text),
      want: (m.checklist?.want || []).map((x) => x.text),
    },
    goalsWork: p.goalsWork || '',
    goalsLife: p.goalsLife || '',
    heightFt: p.heightIn ? Math.floor(p.heightIn / 12) : 5,
    heightInch: p.heightIn ? p.heightIn % 12 : 10,
    weightLb: p.weightLb || '',
    goalWeightLb: p.goalWeightLb || '',
    age: p.age || '',
    sex: p.sex || 'na',
    activity: p.activity || 1.375,
    gymMinutes: p.gymMinutes || 60,
    gymGoal: p.gymGoal || 'recomp',
    gymTime: p.gymTime || 'evening',
    gymDays: p.gymDays ? [...p.gymDays] : [1, 2, 4, 5],
    planKey: p.plan?.pace || null,
  };
  let step = 0;
  const STEPS = ['Routines', 'Checklist', 'Goals', 'Health', 'Gym', 'Your plan'];

  const dots = () => `<div class="row" style="justify-content:center;gap:6px;margin-bottom:14px">
    ${STEPS.map((_, i) => `<span class="dot" style="background:${i === step ? 'var(--accent)' : 'var(--surface-3)'};width:${i === step ? 20 : 8}px;border-radius:999px;transition:all .2s"></span>`).join('')}
  </div>`;

  const nav = (nextLabel = 'Next') => `
    <div class="row gap-8" style="margin-top:18px">
      ${step > 0 ? `<button class="btn grow" id="wzBack">← Back</button>` : ''}
      <button class="btn btn-primary grow" id="wzNext">${nextLabel}</button>
    </div>`;

  const render = () => {
    const root = $('#sheetBody');
    $('#sheetTitle').textContent = `${m.name} — ${STEPS[step]}`;

    /* ---------- step 0: routines ---------- */
    if (step === 0) {
      const sh = sleepHours(draft.bed, draft.wake);
      const shColor = sh == null ? 'var(--text-3)' : sh >= 7 && sh <= 9 ? 'var(--green)' : sh >= 6 ? 'var(--amber)' : 'var(--red)';
      root.innerHTML = `${dots()}
        <div class="field field-row">
          <div><label class="label">I want to wake up at</label>
            <input class="input" id="wzWake" type="time" value="${draft.wake}" /></div>
          <div><label class="label">In bed by</label>
            <input class="input" id="wzBed" type="time" value="${draft.bed}" /></div>
        </div>
        <p class="small" style="margin:-6px 2px 16px;color:${shColor};font-weight:650" id="wzSleep">
          ${sh == null ? '' : `= ${sh}h of sleep ${sh >= 7 && sh <= 9 ? '— perfect ✓' : sh >= 6 ? '— on the edge (aim 7–9h)' : '— not enough (aim 7–9h)'}`}</p>
        <div class="field">
          <label class="label">When are you occupied? <span class="dim" style="text-transform:none;letter-spacing:0">(work, school…)</span></label>
          <div id="wzBusy">
            ${draft.busy.map((b, i) => `
              <div class="card card-pad" data-busy="${i}" style="margin-bottom:10px">
                <div class="row gap-8">
                  <input class="input grow" data-f="label" placeholder="e.g. Work" value="${esc(b.label || '')}" />
                  <button class="icon-btn" data-rmbusy="${i}" style="color:var(--red)">✕</button>
                </div>
                <div class="field-row" style="margin-top:8px">
                  <div><input class="input" data-f="start" type="time" value="${b.start || '08:00'}" /></div>
                  <div><input class="input" data-f="end" type="time" value="${b.end || '13:00'}" /></div>
                </div>
                <div class="picker" style="margin-top:8px">
                  ${DOW.map((d, di) => `<button class="picker-opt ${b.days.includes(di) ? 'is-on' : ''}" data-day="${di}" style="padding:6px 10px">${d}</button>`).join('')}
                </div>
              </div>`).join('')}
          </div>
          <button class="btn btn-sm" id="wzAddBusy">+ Add a busy block</button>
        </div>
        ${nav()}`;
      const sync = () => {
        draft.wake = $('#wzWake', root).value || draft.wake;
        draft.bed = $('#wzBed', root).value || draft.bed;
        $$('#wzBusy [data-busy]', root).forEach((row) => {
          const b = draft.busy[Number(row.dataset.busy)];
          if (!b) return;
          b.label = $('[data-f="label"]', row).value;
          b.start = $('[data-f="start"]', row).value;
          b.end = $('[data-f="end"]', row).value;
        });
      };
      ['#wzWake', '#wzBed'].forEach((sel) => $(sel, root).addEventListener('change', () => { sync(); render(); }));
      $$('#wzBusy [data-busy] .picker-opt', root).forEach((btn) => btn.addEventListener('click', () => {
        sync();
        const b = draft.busy[Number(btn.closest('[data-busy]').dataset.busy)];
        const d = Number(btn.dataset.day);
        b.days = b.days.includes(d) ? b.days.filter((x) => x !== d) : [...b.days, d].sort();
        render();
      }));
      $$('[data-rmbusy]', root).forEach((btn) => btn.addEventListener('click', () => {
        sync(); draft.busy.splice(Number(btn.dataset.rmbusy), 1); render();
      }));
      $('#wzAddBusy', root).addEventListener('click', () => {
        sync(); draft.busy.push({ id: uid(), label: '', start: '08:00', end: '13:00', days: [1, 2, 3, 4, 5] }); render();
      });
      wireNav(sync);
      return;
    }

    /* ---------- step 1: daily checklist ---------- */
    if (step === 1) {
      const area = (key, label, hint, color) => `
        <div class="field">
          <label class="label" style="color:${color}">${label} <span class="dim" style="text-transform:none;letter-spacing:0">${hint}</span></label>
          <textarea class="textarea" id="wz_${key}" rows="3" placeholder="one per line">${esc(draft.checklist[key].join('\n'))}</textarea>
        </div>`;
      root.innerHTML = `${dots()}
        <p class="small muted" style="margin-bottom:14px">Your daily checklist — it shows up on the Today tab every day, and the team sees whether you cleared your musts. 😈</p>
        ${area('must', 'Must-dos', '— no exceptions', 'var(--red)')}
        ${area('should', 'Should-dos', '— probably should happen', 'var(--amber)')}
        ${area('want', 'If there’s time', '— free-time picks', 'var(--green)')}
        ${nav()}`;
      wireNav(() => {
        ['must', 'should', 'want'].forEach((k) => {
          draft.checklist[k] = $(`#wz_${k}`, root).value.split('\n').map((s) => s.trim()).filter(Boolean);
        });
      });
      return;
    }

    /* ---------- step 2: goals ---------- */
    if (step === 2) {
      root.innerHTML = `${dots()}
        <div class="field">
          <label class="label">Work / school goals</label>
          <textarea class="textarea" id="wzGoalsWork" rows="3" placeholder="What are you building toward right now?">${esc(draft.goalsWork)}</textarea>
        </div>
        <div class="field">
          <label class="label">Lifestyle goals</label>
          <textarea class="textarea" id="wzGoalsLife" rows="3" placeholder="Habits, faith, relationships, mental — what does a win look like?">${esc(draft.goalsLife)}</textarea>
        </div>
        ${nav()}`;
      wireNav(() => {
        draft.goalsWork = $('#wzGoalsWork', root).value.trim();
        draft.goalsLife = $('#wzGoalsLife', root).value.trim();
      });
      return;
    }

    /* ---------- step 3: health numbers ---------- */
    if (step === 3) {
      root.innerHTML = `${dots()}
        <div class="field field-row">
          <div><label class="label">Height (ft)</label>
            <input class="input" id="wzFt" type="number" inputmode="numeric" value="${draft.heightFt}" /></div>
          <div><label class="label">(in)</label>
            <input class="input" id="wzIn" type="number" inputmode="numeric" value="${draft.heightInch}" /></div>
          <div><label class="label">Age</label>
            <input class="input" id="wzAge" type="number" inputmode="numeric" value="${draft.age}" /></div>
        </div>
        <div class="field field-row">
          <div><label class="label">Current weight (lb)</label>
            <input class="input" id="wzW" type="number" inputmode="decimal" value="${draft.weightLb}" /></div>
          <div><label class="label">Goal weight (lb)</label>
            <input class="input" id="wzGW" type="number" inputmode="decimal" value="${draft.goalWeightLb}" /></div>
        </div>
        <div class="field">
          <label class="label">Calorie formula uses</label>
          <div class="seg" id="wzSex">
            ${[['male', 'Male'], ['female', 'Female'], ['na', 'Skip']].map(([v, l]) => `
              <button class="seg-item ${draft.sex === v ? 'is-on' : ''}" data-sex="${v}">${l}</button>`).join('')}
          </div>
        </div>
        <div class="field">
          <label class="label">Day-to-day activity (outside workouts)</label>
          <select class="select" id="wzAct">
            ${ACTIVITIES.map((a) => `<option value="${a.v}" ${Number(draft.activity) === a.v ? 'selected' : ''}>${a.label}</option>`).join('')}
          </select>
        </div>
        ${nav()}`;
      $$('#wzSex .seg-item', root).forEach((b) => b.addEventListener('click', () => {
        draft.sex = b.dataset.sex;
        $$('#wzSex .seg-item', root).forEach((x) => x.classList.toggle('is-on', x === b));
      }));
      wireNav(() => {
        draft.heightFt = Number($('#wzFt', root).value) || 0;
        draft.heightInch = Number($('#wzIn', root).value) || 0;
        draft.age = Number($('#wzAge', root).value) || '';
        draft.weightLb = Number($('#wzW', root).value) || '';
        draft.goalWeightLb = Number($('#wzGW', root).value) || '';
        draft.activity = Number($('#wzAct', root).value) || 1.375;
      }, () => {
        if (!draft.weightLb || !draft.age) { toast('Weight and age are needed for the calorie math'); return false; }
        return true;
      });
      return;
    }

    /* ---------- step 4: gym ---------- */
    if (step === 4) {
      root.innerHTML = `${dots()}
        <div class="field">
          <label class="label">Time you can give the gym per day</label>
          <div class="picker" id="wzGymMin">
            ${[30, 45, 60, 90, 120].map((v) => `<button class="picker-opt ${draft.gymMinutes === v ? 'is-on' : ''}" data-min="${v}">${v} min</button>`).join('')}
          </div>
        </div>
        <div class="field">
          <label class="label">Gym goal</label>
          <div class="picker" id="wzGymGoal">
            ${GYM_GOALS.map((g) => `<button class="picker-opt ${draft.gymGoal === g.v ? 'is-on' : ''}" data-goal="${g.v}">${g.label}</button>`).join('')}
          </div>
        </div>
        <div class="field">
          <label class="label">Which days can you train?</label>
          <div class="picker" id="wzGymDays">
            ${DOW.map((d, i) => `<button class="picker-opt ${draft.gymDays.includes(i) ? 'is-on' : ''}" data-gymday="${i}">${d}</button>`).join('')}
          </div>
          <p class="tiny dim" style="margin-top:6px">Your workout split in the Train tab is built from these answers.</p>
        </div>
        <div class="field">
          <label class="label">Best time to train</label>
          <div class="seg" id="wzGymTime">
            ${[['morning', 'Morning'], ['afternoon', 'Afternoon'], ['evening', 'Evening']].map(([v, l]) => `
              <button class="seg-item ${draft.gymTime === v ? 'is-on' : ''}" data-time="${v}">${l}</button>`).join('')}
          </div>
        </div>
        ${nav('See my plan →')}`;
      $$('#wzGymMin .picker-opt', root).forEach((b) => b.addEventListener('click', () => {
        draft.gymMinutes = Number(b.dataset.min);
        $$('#wzGymMin .picker-opt', root).forEach((x) => x.classList.toggle('is-on', x === b));
      }));
      $$('#wzGymGoal .picker-opt', root).forEach((b) => b.addEventListener('click', () => {
        draft.gymGoal = b.dataset.goal;
        $$('#wzGymGoal .picker-opt', root).forEach((x) => x.classList.toggle('is-on', x === b));
      }));
      $$('#wzGymDays .picker-opt', root).forEach((b) => b.addEventListener('click', () => {
        const d = Number(b.dataset.gymday);
        draft.gymDays = draft.gymDays.includes(d)
          ? draft.gymDays.filter((x) => x !== d)
          : [...draft.gymDays, d].sort((a, z) => a - z);
        b.classList.toggle('is-on');
      }));
      $$('#wzGymTime .seg-item', root).forEach((b) => b.addEventListener('click', () => {
        draft.gymTime = b.dataset.time;
        $$('#wzGymTime .seg-item', root).forEach((x) => x.classList.toggle('is-on', x === b));
      }));
      wireNav(() => {}, () => {
        if (!draft.gymDays.length) { toast('Pick at least one training day (or… zero? Pick one 😅)'); return false; }
        return true;
      });
      return;
    }

    /* ---------- step 5: the plan ---------- */
    const prof = draftProfile();
    const tdee = maintenanceCalories(prof);
    const { mode, options } = paceOptions(prof);
    const pro = proteinGoal(prof);
    if (!draft.planKey || !options.some((o) => o.key === draft.planKey)) draft.planKey = options[Math.min(1, options.length - 1)].key;

    root.innerHTML = `${dots()}
      <div class="card card-pad center" style="margin-bottom:14px">
        <div class="stat-v" style="font-size:26px">${tdee} cal</div>
        <div class="stat-l">your maintenance (TDEE)</div>
        <p class="tiny dim" style="margin-top:6px">${mode === 'cut' ? `Cutting ${prof.weightLb} → ${prof.goalWeightLb} lb` : mode === 'bulk' ? `Bulking ${prof.weightLb} → ${prof.goalWeightLb} lb` : 'Holding steady — recomp mode'}</p>
      </div>
      <div class="col gap-8" id="wzPlans">
        ${options.map((o) => `
          <button class="card card-pad ${draft.planKey === o.key ? '' : ''}" data-plan="${o.key}" style="text-align:left;border:2px solid ${draft.planKey === o.key ? 'var(--accent)' : 'transparent'}">
            <div class="row-between">
              <span class="strong">${o.label}</span>
              <span class="strong num" style="color:var(--accent)">${o.calories} cal/day</span>
            </div>
            <div class="small dim" style="margin-top:3px">
              ${o.weeklyLbs ? `${mode === 'cut' ? '−' : '+'}${o.weeklyLbs} lb/week${o.weeksToGoal ? ` · goal in ~${o.weeksToGoal} weeks` : ''}` : 'at maintenance'}
              ${o.floored ? ' · raised to a safe minimum' : ''}
            </div>
            <div class="tiny dim" style="margin-top:2px">${o.blurb}</div>
          </button>`).join('')}
      </div>
      <p class="small muted" style="margin:12px 2px">Picking a plan sets your daily rings: <b class="num">${options.find((o) => o.key === draft.planKey)?.calories} cal</b> · <b class="num">${pro}g protein</b> (0.9 g per lb of goal weight). Estimates, not medical advice — adjust any time in Team.</p>
      <div class="banner" style="margin-bottom:4px">🏋️ Finishing also builds your <b>${draft.gymDays.length}-day ${esc(splitName(draft.gymDays.length))}</b> split in the Train tab — ${draft.gymMinutes}-minute sessions tuned for <b>${esc((GYM_GOALS.find((g) => g.v === draft.gymGoal) || {}).label || draft.gymGoal)}</b>. Tweak any exercise afterwards.</div>
      ${nav('Finish ✓')}`;
    $$('#wzPlans [data-plan]', root).forEach((b) => b.addEventListener('click', () => {
      draft.planKey = b.dataset.plan; render();
    }));
    wireNav(() => {}, null, true);
  };

  const draftProfile = () => ({
    wake: draft.wake, bed: draft.bed, busy: draft.busy,
    goalsWork: draft.goalsWork, goalsLife: draft.goalsLife,
    heightIn: draft.heightFt * 12 + draft.heightInch,
    weightLb: draft.weightLb, goalWeightLb: draft.goalWeightLb || draft.weightLb,
    age: draft.age, sex: draft.sex, activity: draft.activity,
    gymMinutes: draft.gymMinutes, gymGoal: draft.gymGoal, gymTime: draft.gymTime,
    gymDays: [...draft.gymDays],
  });

  function wireNav(syncFn, validateFn = null, isFinish = false) {
    const root = $('#sheetBody');
    $('#wzBack', root)?.addEventListener('click', () => { syncFn(); step--; render(); });
    $('#wzNext', root).addEventListener('click', () => {
      syncFn();
      if (validateFn && validateFn() === false) return;
      if (!isFinish) { step++; render(); return; }
      finish();
    });
  }

  function finish() {
    const prof = draftProfile();
    const { options } = paceOptions(prof);
    const chosen = options.find((o) => o.key === draft.planKey) || options[0];
    const keep = (key, olds) => {
      // preserve ids for unchanged checklist items so today's checkmarks survive
      return draft.checklist[key].map((text) => {
        const old = olds.find((x) => x.text === text);
        return old || { id: uid(), text };
      });
    };
    mutate((s) => {
      const mm = s.members.find((x) => x.id === m.id);
      if (!mm) return;
      mm.profile = { ...prof, plan: { pace: chosen.key, calories: chosen.calories, weeklyLbs: chosen.weeklyLbs, mode: paceOptions(prof).mode } };
      mm.checklist = {
        must: keep('must', mm.checklist?.must || []),
        should: keep('should', mm.checklist?.should || []),
        want: keep('want', mm.checklist?.want || []),
      };
      mm.goals.calories = chosen.calories;
      mm.goals.protein = proteinGoal(prof);
      mm.goals.workouts = prof.gymDays.length;
      // (re)build the generated workout split; hand-made plans are kept
      const manual = (s.workoutPlans[m.id] || []).filter((pl) => !pl.auto);
      s.workoutPlans[m.id] = [...manual, ...generateWorkoutPlans(prof)];
    });
    closeSheet();
    toast(`${m.name}'s plan is set — ${chosen.calories} cal/day + a ${prof.gymDays.length}-day split 🎯`);
  }

  openSheet({ title: `${m.name} — ${STEPS[0]}`, body: '', onSave: null, setup: render });
}
