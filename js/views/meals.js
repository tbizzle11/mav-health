/* Meals — personal weekly meal plan per member, day strip, macro totals. */
import {
  getState, mutate, me, memberById, todayStr, addDays, dowOf, fromDateStr,
  uid, logKey, extrasFor, mealsFor, MEAL_SLOTS,
} from '../store.js';
import { $, $$, esc, avatar, openSheet, closeSheet, confirmSheet, toast, progressBar } from '../ui.js';
import { openScanSheet } from './scan.js';

let member = null;       // whose plan we're viewing
let dayCursor = todayStr();

export const mealsView = {
  id: 'meals',
  onEnter() { member = me().id; dayCursor = todayStr(); },
  title: () => 'Meal Plan',
  subtitle: () => `${(member ? memberById(member) : me()).name}'s week`,
  fab: () => openMealSheet(null),

  render(root) { renderInto(root); },
};

let lastRoot = null;
function rerender() { if (lastRoot) renderInto(lastRoot); }

function weekDays() {
  // strip = this week starting Sunday
  const t = todayStr();
  const start = addDays(t, -dowOf(t));
  return Array.from({ length: 7 }, (_, i) => addDays(start, i));
}

function renderInto(root) {
  lastRoot = root;
  const s = getState();
  if (!member || !memberById(member)) member = me().id;
  const m = memberById(member);
  const dow = dowOf(dayCursor);
  const plan = (s.mealPlans[member]?.[dow] || []);
  const extras = extrasFor(member, dayCursor);
  const doneLog = s.mealLog[logKey(dayCursor, member)] || {};
  const bySlot = MEAL_SLOTS.map((slot) => ({
    slot,
    items: plan.filter((x) => x.slot === slot),
    extras: extras.filter((x) => x.slot === slot),
  }));
  const cal = plan.reduce((sum, x) => sum + (x.cal || 0), 0) + extras.reduce((sum, x) => sum + (x.cal || 0), 0);
  const pro = plan.reduce((sum, x) => sum + (x.protein || 0), 0) + extras.reduce((sum, x) => sum + (x.protein || 0), 0);
  const t = todayStr();

  root.innerHTML = `
  <div class="fade-in">

    <!-- whose plan -->
    <div class="chips" style="margin-bottom:12px">
      ${s.members.map((x) => `
        <button class="chip ${x.id === member ? 'is-on' : ''}" data-member="${x.id}"
          ${x.id === member ? `style="background:${x.color}"` : ''}>${esc(x.name)}</button>`).join('')}
    </div>

    <!-- day strip -->
    <div class="day-strip" style="margin-bottom:14px">
      ${weekDays().map((d) => {
        const dd = fromDateStr(d);
        const has = (s.mealPlans[member]?.[dowOf(d)] || []).length > 0;
        return `
        <button class="day-btn ${d === dayCursor ? 'is-on' : ''} ${d === t ? 'is-today' : ''}" data-day="${d}">
          <div class="day-btn-d">${dd.toLocaleDateString(undefined, { weekday: 'short' }).slice(0, 2)}</div>
          <div class="day-btn-n">${dd.getDate()}</div>
          <div class="day-btn-dot ${has ? '' : 'is-hidden'}"></div>
        </button>`;
      }).join('')}
    </div>

    <!-- macro summary: numbers lead, bars support -->
    <div class="card card-pad">
      <div class="grid-2">
        <div class="col gap-4">
          <div class="hero-num" style="font-size:28px">${cal.toLocaleString()}</div>
          <span class="stat-l" style="margin-top:0">planned · goal ${m.goals.calories.toLocaleString()} cal</span>
          <div style="margin-top:7px">${progressBar(cal / m.goals.calories, 'var(--grad-amber)')}</div>
        </div>
        <div class="col gap-4">
          <div class="hero-num" style="font-size:28px">${pro}g</div>
          <span class="stat-l" style="margin-top:0">planned · goal ${m.goals.protein}g</span>
          <div style="margin-top:7px">${progressBar(pro / m.goals.protein, 'var(--grad-green)')}</div>
        </div>
      </div>
      ${(() => {
        const eaten = mealsFor(member, dayCursor).filter((x) => x.done);
        const eCal = eaten.reduce((n, x) => n + (x.cal || 0), 0);
        const ePro = eaten.reduce((n, x) => n + (x.protein || 0), 0);
        return `<p class="tiny dim" style="margin-top:9px">
          ✓ Eaten${dayCursor === t ? ' so far' : ''}: <b class="num">${eCal.toLocaleString()} cal · ${ePro}g</b> —
          the dashboard rings track what's checked ✓; the numbers above are the day's plan.</p>`;
      })()}
    </div>

    <!-- slots -->
    ${bySlot.map(({ slot, items, extras: xs }) => {
      const slotCal = items.reduce((n, x) => n + (x.cal || 0), 0) + xs.reduce((n, x) => n + (x.cal || 0), 0);
      if (!items.length && !xs.length) return `
        <div class="section-head"><h2>${slot}</h2></div>
        <button class="ghost-add" data-add="${slot}">+ Add ${slot.toLowerCase()}</button>`;
      return `
      <div class="section-head"><h2>${slot}</h2>
        <span class="row gap-12">
          <span class="tiny dim num">${slotCal} cal</span>
          <button class="link" data-add="${slot}">+ Add</button>
        </span></div>
      <div class="list">
        ${items.length || xs.length ? `
          ${items.map((meal) => `
          <div class="list-row" style="padding:0">
            <button class="row gap-12" data-meal-check="${meal.id}" aria-label="Mark eaten"
              style="padding:12px 0 12px 14px;flex:none">
              <span class="check ${doneLog[meal.id] ? 'is-on' : ''}">✓</span>
            </button>
            <button class="row grow gap-12" data-meal="${meal.id}"
              style="padding:12px 14px 12px 0;text-align:left;min-width:0">
              <span class="grow" style="min-width:0">
                <div class="list-title truncate" style="${doneLog[meal.id] ? 'opacity:.55' : ''}">${esc(meal.name)}</div>
                <div class="list-sub">${meal.cal} cal · ${meal.protein}g protein</div>
              </span>
              <span class="chev">›</span>
            </button>
          </div>`).join('')}
          ${xs.map((x) => `
          <div class="list-row" style="padding:0">
            <button class="row grow gap-12" data-extra-check="${x.id}"
              style="padding:12px 0 12px 14px;text-align:left;min-width:0">
              <span class="check ${x.done ? 'is-on' : ''}">✓</span>
              ${x.thumb ? `<img src="${x.thumb}" alt="" style="width:38px;height:38px;object-fit:cover;border-radius:9px;flex:none" />` : ''}
              <span class="grow" style="min-width:0">
                <div class="list-title truncate" style="${x.done ? 'opacity:.55' : ''}">${esc(x.name)}</div>
                <div class="list-sub">${x.cal} cal · ${x.protein}g protein · 📷 scanned</div>
              </span>
            </button>
            <button data-extra-del="${x.id}" aria-label="Remove" class="dim" style="padding:12px 14px;font-size:15px;flex:none">✕</button>
          </div>`).join('')}`
        : `<div class="empty" style="padding:16px">Nothing planned</div>`}
      </div>`; }).join('')}

    <div class="col gap-8" style="margin-top:18px">
      <button class="btn btn-block" id="scanMeal">📷 Scan food with the camera</button>
      <button class="btn btn-block" id="copyDay">Copy this day to…</button>
    </div>
  </div>`;

  $$('[data-member]', root).forEach((b) => b.addEventListener('click', () => {
    member = b.dataset.member; rerender();
    window.dispatchEvent(new CustomEvent('mav:titlechange'));
  }));
  $$('[data-day]', root).forEach((b) => b.addEventListener('click', () => {
    dayCursor = b.dataset.day; rerender();
  }));
  $$('[data-add]', root).forEach((b) => b.addEventListener('click', () =>
    openMealSheet(null, b.dataset.add)));
  $$('[data-meal]', root).forEach((b) => b.addEventListener('click', () => {
    const item = plan.find((x) => x.id === b.dataset.meal);
    if (item) openMealSheet(item);
  }));
  $('#copyDay', root).addEventListener('click', openCopySheet);
  $('#scanMeal', root).addEventListener('click', () => openScanSheet(dayCursor, member));
  $$('[data-meal-check]', root).forEach((b) => b.addEventListener('click', () => {
    const key = logKey(dayCursor, member);
    mutate((st) => {
      st.mealLog[key] = st.mealLog[key] || {};
      st.mealLog[key][b.dataset.mealCheck] = !st.mealLog[key][b.dataset.mealCheck];
    });
  }));
  $$('[data-extra-check]', root).forEach((b) => b.addEventListener('click', () => {
    const key = logKey(dayCursor, member);
    mutate((st) => {
      const x = (st.mealExtras[key] || []).find((e) => e.id === b.dataset.extraCheck);
      if (x) x.done = !x.done;
    });
  }));
  $$('[data-extra-del]', root).forEach((b) => b.addEventListener('click', () => {
    const key = logKey(dayCursor, member);
    mutate((st) => {
      st.mealExtras[key] = (st.mealExtras[key] || []).filter((x) => x.id !== b.dataset.extraDel);
    });
    toast('Removed');
  }));
}

/* ---------- meal add/edit sheet ---------- */
function openMealSheet(item = null, defaultSlot = 'Breakfast') {
  const isNew = !item;
  const data = item || { id: uid(), slot: defaultSlot, name: '', cal: 500, protein: 30 };
  const dow = dowOf(dayCursor);

  openSheet({
    title: isNew ? 'Add meal' : 'Edit meal',
    saveLabel: isNew ? 'Add' : 'Save',
    body: `
      <div class="field">
        <label class="label" for="mName">Meal</label>
        <input class="input" id="mName" placeholder="e.g. Chicken rice bowl" value="${esc(data.name)}" />
      </div>
      <div class="field">
        <label class="label">Slot</label>
        <div class="seg" id="mSlot">
          ${MEAL_SLOTS.map((sl) => `
            <button class="seg-item ${data.slot === sl ? 'is-on' : ''}" data-slot="${sl}">${sl}</button>`).join('')}
        </div>
      </div>
      <div class="field field-row">
        <div>
          <label class="label" for="mCal">Calories</label>
          <input class="input" id="mCal" type="number" inputmode="numeric" value="${data.cal}" />
        </div>
        <div>
          <label class="label" for="mPro">Protein (g)</label>
          <input class="input" id="mPro" type="number" inputmode="numeric" value="${data.protein}" />
        </div>
      </div>
      ${isNew ? '' : `<button class="btn btn-danger btn-block" id="mDelete">Remove meal</button>`}
    `,
    setup: (root) => {
      $$('#mSlot .seg-item', root).forEach((b) => b.addEventListener('click', () => {
        $$('#mSlot .seg-item', root).forEach((x) => x.classList.remove('is-on'));
        b.classList.add('is-on');
      }));
      const del = $('#mDelete', root);
      if (del) del.addEventListener('click', () => {
        closeSheet();
        mutate((s) => {
          s.mealPlans[member][dow] = (s.mealPlans[member][dow] || []).filter((x) => x.id !== data.id);
        });
        toast('Meal removed');
        rerender();
      });
      $('#mName', root).focus();
    },
    onSave: () => {
      const root = $('#sheetBody');
      const name = $('#mName', root).value.trim();
      if (!name) { toast('Name the meal'); return false; }
      const next = {
        ...data, name,
        slot: $('#mSlot .is-on', root)?.dataset.slot || 'Breakfast',
        cal: Number($('#mCal', root).value) || 0,
        protein: Number($('#mPro', root).value) || 0,
      };
      mutate((s) => {
        s.mealPlans[member] = s.mealPlans[member] || {};
        const day = s.mealPlans[member][dow] = s.mealPlans[member][dow] || [];
        const i = day.findIndex((x) => x.id === next.id);
        if (i >= 0) day[i] = next; else day.push(next);
      });
      toast(isNew ? 'Meal added' : 'Meal updated');
      rerender();
    },
  });
}

/* ---------- copy day sheet ---------- */
function openCopySheet() {
  const dowNames = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  const src = dowOf(dayCursor);
  openSheet({
    title: `Copy ${dowNames[src]}'s meals`,
    saveLabel: 'Copy',
    body: `
      <p class="small muted" style="margin-bottom:12px">Copy this day's plan onto other days (replaces what's there).</p>
      <div class="picker" id="copyTargets">
        ${dowNames.map((n, i) => i === src ? '' : `
          <button class="picker-opt" data-dow="${i}">${n}</button>`).join('')}
      </div>`,
    setup: (root) => {
      $$('#copyTargets .picker-opt', root).forEach((b) =>
        b.addEventListener('click', () => b.classList.toggle('is-on')));
    },
    onSave: () => {
      const root = $('#sheetBody');
      const targets = $$('#copyTargets .is-on', root).map((b) => Number(b.dataset.dow));
      if (!targets.length) { toast('Pick at least one day'); return false; }
      mutate((s) => {
        const srcMeals = s.mealPlans[member]?.[src] || [];
        targets.forEach((d) => {
          s.mealPlans[member][d] = srcMeals.map((x) => ({ ...x, id: uid() }));
        });
      });
      toast(`Copied to ${targets.length} day${targets.length > 1 ? 's' : ''}`);
      rerender();
    },
  });
}
