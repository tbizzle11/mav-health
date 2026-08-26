/* Today — daily dashboard for the selected member. */
import {
  getState, mutate, me, memberById, eventsOn, mealsFor, workoutsFor, waterFor,
  workoutsThisWeek, todayStr, fmtTime, logKey, uid, EVENT_TYPES,
} from '../store.js';
import { $, $$, esc, avatarStack, ring, progressBar, openSheet, toast } from '../ui.js';
import { openEventSheet } from './calendar.js';
import { openSession } from './train.js';
import { openScanSheet } from './scan.js';
import { openProfileWizard } from './profile.js';
import { buildDayPlan } from '../planner.js';

let prevWater = 0; // for the cascade animation on newly-filled droplets

export const todayView = {
  id: 'today',
  title: () => {
    const h = new Date().getHours();
    const name = me().name.split(' ')[0];
    return h < 12 ? `Morning, ${name}` : h < 18 ? `Afternoon, ${name}` : `Evening, ${name}`;
  },
  subtitle: () => new Date().toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' }),

  render(root) {
    const m = me();
    const t = todayStr();
    const meals = mealsFor(m.id, t);
    const workouts = workoutsFor(m.id, t);
    const events = eventsOn(t);
    const water = waterFor(m.id, t);

    const calDone = meals.filter((x) => x.done).reduce((s, x) => s + (x.cal || 0), 0);
    const proDone = meals.filter((x) => x.done).reduce((s, x) => s + (x.protein || 0), 0);
    const g = m.goals;
    const wkDone = workoutsThisWeek(m.id);

    root.innerHTML = `
    <div class="fade-in">

      <!-- hero: calories lead, the rest supports -->
      <div class="card card-pad">
        <div class="row gap-12">
          ${ring(calDone / g.calories, 96, 9, 'var(--amber)', `${Math.round((calDone / g.calories) * 100)}%`)}
          <div class="col gap-4 grow" style="min-width:0">
            <div class="hero-num">${Math.max(0, g.calories - calDone).toLocaleString()}</div>
            <span class="stat-l" style="margin-top:0">calories left today</span>
            <span class="tiny dim num" style="margin-top:4px">${calDone.toLocaleString()} eaten · goal ${g.calories.toLocaleString()}</span>
          </div>
        </div>
        <div class="divider"></div>
        <div class="row" style="justify-content:space-around">
          <div class="row gap-8">
            ${ring(proDone / g.protein, 46, 6, 'var(--green)')}
            <div class="col"><span class="small strong num">${proDone} / ${g.protein}g</span>
              <span class="tiny dim">protein</span></div>
          </div>
          <div class="row gap-8">
            ${ring(wkDone / g.workouts, 46, 6, 'var(--violet)')}
            <div class="col"><span class="small strong num">${wkDone} / ${g.workouts}</span>
              <span class="tiny dim">workouts / wk</span></div>
          </div>
        </div>
      </div>

      ${!m.profile ? `
      <div class="banner" style="margin-top:12px">
        <div class="row-between">
          <span><b>Build your profile</b><br><span class="small muted">Routines, goals, and your calorie plan — 2 minutes.</span></span>
          <button class="btn btn-sm btn-primary" id="setupProfile" style="flex:none">Start</button>
        </div>
      </div>` : ''}

      ${(() => {
        // daily checklist
        const cl = m.checklist || { must: [], should: [], want: [] };
        const total = cl.must.length + cl.should.length + cl.want.length;
        if (!total) return m.profile ? `
          <div class="section-head"><h2>Daily checklist</h2><button class="link" id="editChecklist">Set up</button></div>
          <div class="card"><div class="empty" style="padding:16px">No checklist yet — add your musts, shoulds and maybes.</div></div>` : '';
        const log = getState().checklistLog[logKey(t, m.id)] || {};
        const tier = (items, label, color) => items.length ? `
          <div class="list-row no-press" style="padding:7px 14px;background:var(--surface-2)">
            <span class="tiny strong" style="color:${color};text-transform:uppercase;letter-spacing:.04em">${label}</span>
          </div>
          ${items.map((it) => `
            <button class="list-row" data-check="${it.id}">
              <span class="check ${log[it.id] ? 'is-on' : ''}">✓</span>
              <span class="grow list-title" style="${log[it.id] ? 'opacity:.5;text-decoration:line-through' : ''}">${esc(it.text)}</span>
            </button>`).join('')}` : '';
        const mustDone = cl.must.filter((x) => log[x.id]).length;
        return `
          <div class="section-head"><h2>Daily checklist</h2>
            <span class="row gap-12">
              <span class="tiny strong ${mustDone === cl.must.length && cl.must.length ? '' : 'dim'}" style="${mustDone === cl.must.length && cl.must.length ? 'color:var(--green)' : ''}">${mustDone}/${cl.must.length} musts</span>
              <button class="link" id="editChecklist">Edit</button>
            </span>
          </div>
          <div class="list">
            ${tier(cl.must, 'Must — no exceptions', 'var(--red)')}
            ${tier(cl.should, 'Should', 'var(--amber)')}
            ${tier(cl.want, 'If there’s time', 'var(--green)')}
          </div>`;
      })()}

      ${m.profile ? (() => {
        const plan = buildDayPlan(m, t, eventsOn(t));
        if (!plan.length) return '';
        return `
        <div class="section-head"><h2>Your day plan</h2><button class="link" id="editProfile">Adjust</button></div>
        <div class="list">
          ${plan.map((b) => `
            <div class="list-row no-press">
              <span style="font-size:17px;flex:none">${b.icon}</span>
              <span class="evt-time" style="min-width:88px">${fmtTime(b.start)}${b.end ? `–${fmtTime(b.end)}` : ''}</span>
              <span class="grow list-title" style="font-weight:${b.kind === 'busy' ? 600 : 500};${b.kind === 'free' ? 'color:var(--text-2)' : ''}">${esc(b.label)}</span>
            </div>`).join('')}
        </div>`;
      })() : ''}

      <!-- schedule -->
      <div class="section-head"><h2>Today's schedule</h2><a class="link" href="#/calendar">Calendar</a></div>
      <div class="list">
        ${events.length ? events.map((e) => {
          const ty = EVENT_TYPES[e.type] || EVENT_TYPES.other;
          return `
          <button class="evt" data-evt="${e.id}">
            <span class="evt-rail" style="background:${ty.color}"></span>
            <span class="evt-time">${fmtTime(e.start) || 'All day'}</span>
            <span class="grow">
              <span class="evt-title">${esc(e.title)}</span>
              <span class="evt-meta">${ty.label}${e.notes ? ' · ' + esc(e.notes) : ''}</span>
            </span>
            ${avatarStack(e.members)}
          </button>`;
        }).join('') : `<div class="empty"><span class="empty-ico">🗓️</span>Nothing scheduled today.<br>Tap + on the Calendar tab to add something.</div>`}
      </div>

      <!-- workout -->
      <div class="section-head"><h2>Today's training</h2><a class="link" href="#/train">Plans</a></div>
      ${workouts.length ? workouts.map((p) => {
        const total = p.exercises.length;
        const done = Object.values(p.log.ex || {}).filter(Boolean).length;
        return `
        <div class="card card-pad">
          <div class="row-between">
            <div class="col gap-4 grow">
              <span class="card-title">${esc(p.name)}</span>
              <span class="small dim">${total} exercises · ${done}/${total} done</span>
              <div style="margin-top:6px">${progressBar(total ? done / total : 0, p.log.done ? 'var(--green)' : 'var(--accent)')}</div>
            </div>
            <button class="btn ${p.log.done ? 'btn-success' : 'btn-primary'} btn-sm" data-session="${p.id}">
              ${p.log.done ? 'Done ✓' : done ? 'Continue' : 'Start'}
            </button>
          </div>
        </div>`;
      }).join('') : `<div class="card"><div class="empty"><span class="empty-ico">🏖️</span>Rest day — no workout scheduled.</div></div>`}

      <!-- meals -->
      <div class="section-head"><h2>Today's meals</h2>
        <span class="row gap-12">
          <button class="link" id="scanFood">📷 Scan</button>
          <a class="link" href="#/meals">Plan</a>
        </span>
      </div>
      <div class="list">
        ${meals.length ? meals.map((meal) => meal.extra ? `
          <div class="list-row" style="padding:0">
            <button class="row grow gap-12" data-extra="${meal.id}"
              style="padding:12px 0 12px 14px;text-align:left;min-width:0">
              <span class="check ${meal.done ? 'is-on' : ''}">✓</span>
              ${meal.thumb ? `<img src="${meal.thumb}" alt="" style="width:38px;height:38px;object-fit:cover;border-radius:9px;flex:none" />` : ''}
              <span class="grow" style="min-width:0">
                <div class="list-title truncate" style="${meal.done ? 'opacity:.55' : ''}">${esc(meal.name)}</div>
                <div class="list-sub">${esc(meal.slot)} · ${meal.cal} cal · ${meal.protein}g protein · 📷 scanned</div>
              </span>
            </button>
            <button data-extra-del="${meal.id}" aria-label="Remove" class="dim"
              style="padding:12px 14px;font-size:15px;flex:none">✕</button>
          </div>` : `
          <button class="list-row" data-meal="${meal.id}">
            <span class="check ${meal.done ? 'is-on' : ''}">✓</span>
            <span class="grow">
              <div class="list-title" style="${meal.done ? 'opacity:.55;text-decoration:line-through' : ''}">${esc(meal.name)}</div>
              <div class="list-sub">${esc(meal.slot)} · ${meal.cal} cal · ${meal.protein}g protein</div>
            </span>
          </button>`).join('')
        : `<div class="empty"><span class="empty-ico">🍽️</span>No meals planned for today.<br>Set up your plan in the Meals tab, or 📷 scan what you're eating.</div>`}
      </div>

      <!-- daily habits: wins + water in one compact card -->
      ${(() => {
        const w = getState().wins[logKey(t, m.id)] || {};
        const chip = (k, ico, label) => `
          <button class="chip ${w[k] ? 'is-on' : ''}" data-win="${k}"
            style="flex:1;justify-content:center;display:inline-flex;padding:11px 8px;${w[k] ? 'background:var(--grad-green);color:var(--on-green);box-shadow:var(--glow-green)' : ''}">${ico} ${label}</button>`;
        return `
        <div class="section-head"><h2>Daily habits</h2></div>
        <div class="card card-pad">
          <div class="row gap-8">
            ${chip('physical', '💪', 'Physical')}
            ${chip('mental', '🧠', 'Mental')}
            ${chip('spiritual', '🙏', 'Spiritual')}
          </div>
          <div class="divider"></div>
          <div class="row-between" style="margin-bottom:10px">
            <span class="small strong num">${water} / ${g.water} glasses</span>
            <span class="tiny dim">${water >= g.water ? 'Goal hit 💧' : 'tap to log water'}</span>
          </div>
          <div class="row" style="gap:7px;flex-wrap:wrap">
            ${Array.from({ length: g.water }, (_, i) => `
              <button class="drop ${i < water ? 'is-full' : ''}" data-water="${i + 1}"
                ${i < water && i >= prevWater ? `style="animation-delay:${(i - prevWater) * 45}ms"` : ''}>💧</button>`).join('')}
          </div>
        </div>`;
      })()}
    </div>`;

    /* interactions */
    $$('[data-meal]', root).forEach((btn) => btn.addEventListener('click', () => {
      const key = logKey(t, m.id);
      mutate((s) => {
        s.mealLog[key] = s.mealLog[key] || {};
        s.mealLog[key][btn.dataset.meal] = !s.mealLog[key][btn.dataset.meal];
      });
    }));

    $('#scanFood', root)?.addEventListener('click', () => openScanSheet(t));

    $('#setupProfile', root)?.addEventListener('click', () => openProfileWizard(m.id));
    $('#editProfile', root)?.addEventListener('click', () => openProfileWizard(m.id));
    $('#editChecklist', root)?.addEventListener('click', () => openChecklistSheet(m.id));

    $$('[data-check]', root).forEach((btn) => btn.addEventListener('click', () => {
      const key = logKey(t, m.id);
      mutate((s) => {
        s.checklistLog[key] = s.checklistLog[key] || {};
        s.checklistLog[key][btn.dataset.check] = !s.checklistLog[key][btn.dataset.check];
      });
    }));

    $$('[data-win]', root).forEach((btn) => btn.addEventListener('click', () => {
      const key = logKey(t, m.id);
      mutate((s) => {
        s.wins[key] = s.wins[key] || {};
        s.wins[key][btn.dataset.win] = !s.wins[key][btn.dataset.win];
      });
    }));

    $$('[data-extra]', root).forEach((btn) => btn.addEventListener('click', () => {
      const key = logKey(t, m.id);
      mutate((s) => {
        const x = (s.mealExtras[key] || []).find((e) => e.id === btn.dataset.extra);
        if (x) x.done = !x.done;
      });
    }));
    $$('[data-extra-del]', root).forEach((btn) => btn.addEventListener('click', () => {
      const key = logKey(t, m.id);
      mutate((s) => {
        s.mealExtras[key] = (s.mealExtras[key] || []).filter((e) => e.id !== btn.dataset.extraDel);
      });
      toast('Removed');
    }));

    $$('[data-water]', root).forEach((btn) => btn.addEventListener('click', () => {
      const n = Number(btn.dataset.water);
      prevWater = waterFor(m.id, t);
      mutate((s) => { s.water[logKey(t, m.id)] = (waterFor(m.id, t) === n) ? n - 1 : n; });
      prevWater = waterFor(m.id, t); // settle so later re-renders don't replay the cascade
    }));

    $$('[data-session]', root).forEach((btn) => btn.addEventListener('click', () =>
      openSession(btn.dataset.session, t)));

    $$('[data-evt]', root).forEach((btn) => btn.addEventListener('click', () => {
      const evt = getState().events.find((e) => e.id === btn.dataset.evt);
      if (evt) openEventSheet(evt);
    }));
  },
};

/* quick checklist editor — one item per line, three tiers */
export function openChecklistSheet(memberId) {
  const m = memberById(memberId);
  if (!m) return;
  const cl = m.checklist || { must: [], should: [], want: [] };
  const area = (key, label, hint, color) => `
    <div class="field">
      <label class="label" style="color:${color}">${label} <span class="dim" style="text-transform:none;letter-spacing:0">${hint}</span></label>
      <textarea class="textarea" id="cl_${key}" rows="3" placeholder="one per line">${esc(cl[key].map((x) => x.text).join('\n'))}</textarea>
    </div>`;
  openSheet({
    title: 'Daily checklist',
    saveLabel: 'Save',
    body: `
      ${area('must', 'Must-dos', '— no exceptions', 'var(--red)')}
      ${area('should', 'Should-dos', '— probably should happen', 'var(--amber)')}
      ${area('want', 'If there’s time', '— free-time picks', 'var(--green)')}`,
    onSave: () => {
      const root = $('#sheetBody');
      mutate((s) => {
        const mm = s.members.find((x) => x.id === memberId);
        if (!mm) return;
        const parse = (key) => root.querySelector(`#cl_${key}`).value
          .split('\n').map((x) => x.trim()).filter(Boolean)
          .map((text) => (mm.checklist?.[key] || []).find((o) => o.text === text) || { id: uid(), text });
        mm.checklist = { must: parse('must'), should: parse('should'), want: parse('want') };
      });
      toast('Checklist saved');
    },
  });
}
