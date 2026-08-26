/* ============================================================
   store.js — data layer.
   Offline-first: state is persisted by storage.js (IndexedDB,
   with a localStorage cache) and every mutation goes through
   mutate(), which verifies the write actually landed.
   ============================================================ */

import { loadState, saveState, flushState, storageHealth } from './storage.js';

export const EVENT_TYPES = {
  meeting:  { label: 'Meeting',  color: 'var(--blue)',   soft: 'var(--blue-soft)'   },
  workout:  { label: 'Workout',  color: 'var(--green)',  soft: 'var(--green-soft)'  },
  meal:     { label: 'Meal',     color: 'var(--amber)',  soft: 'var(--amber-soft)'  },
  deadline: { label: 'Deadline', color: 'var(--red)',    soft: 'var(--red-soft)'    },
  social:   { label: 'Social',   color: 'var(--violet)', soft: 'var(--violet-soft)' },
  other:    { label: 'Other',    color: 'var(--text-3)', soft: 'var(--surface-2)'   },
};

export const MEAL_SLOTS = ['Breakfast', 'Lunch', 'Dinner', 'Snack'];

export const MEMBER_COLORS = ['#5b5bf0', '#16a06a', '#e0900c', '#e0459b', '#0fa3a3', '#8a5cf6'];

export const uid = () => Math.random().toString(36).slice(2, 9) + Date.now().toString(36).slice(-3);

/* ---------- date helpers ---------- */
export const toDateStr = (d) => {
  const y = d.getFullYear(), m = String(d.getMonth() + 1).padStart(2, '0'),
        day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
};
export const fromDateStr = (s) => {
  const [y, m, d] = s.split('-').map(Number);
  return new Date(y, m - 1, d);
};
export const todayStr = () => toDateStr(new Date());
export const addDays = (s, n) => { const d = fromDateStr(s); d.setDate(d.getDate() + n); return toDateStr(d); };
export const dowOf = (s) => fromDateStr(s).getDay();

export const fmtNice = (s) => fromDateStr(s).toLocaleDateString(undefined,
  { weekday: 'long', month: 'long', day: 'numeric' });
export const fmtShort = (s) => fromDateStr(s).toLocaleDateString(undefined,
  { weekday: 'short', month: 'short', day: 'numeric' });
export const fmtTime = (t) => {
  if (!t) return '';
  const [h, m] = t.split(':').map(Number);
  const ampm = h >= 12 ? 'PM' : 'AM';
  const h12 = h % 12 || 12;
  return m ? `${h12}:${String(m).padStart(2, '0')} ${ampm}` : `${h12} ${ampm}`;
};

/* ---------- state ---------- */
let state = null;
const listeners = new Set();

export function subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); }
function emit() { listeners.forEach((fn) => fn(state)); }

export function getState() { return state; }

export function mutate(fn) {
  fn(state);
  state.updatedAt = Date.now();
  const saved = saveState(state);
  if (!saved) {
    // Nothing accepted the write. Say so — the old code swallowed this and let
    // the UI report success while the edit only ever existed in memory.
    console.error('MAV: save failed', storageHealth());
    window.dispatchEvent(new CustomEvent('mav:savefail', { detail: storageHealth() }));
  }
  emit();
}

/** Push any queued write to disk now (app backgrounding / closing). */
export const flushStore = () => flushState();

/* ---------- seed ---------- */
function seed() {
  const luk = uid(), cam = uid(), die = uid();
  const t = todayStr();
  const dow = dowOf(t);
  // next occurrence of a given weekday (may be today)
  const next = (d) => addDays(t, (d - dow + 7) % 7);

  const defaultGoals = { calories: 2400, protein: 160, water: 8, workouts: 4 };

  return {
    v: 1,
    updatedAt: Date.now(),
    members: [
      { id: luk, name: 'Luke',    color: MEMBER_COLORS[0], goals: { ...defaultGoals } },
      { id: cam, name: 'Cameron', color: MEMBER_COLORS[1], goals: { ...defaultGoals } },
      { id: die, name: 'Diego',   color: MEMBER_COLORS[2], goals: { ...defaultGoals } },
    ],
    me: null, // chosen on first launch, per device
    events: [
      { id: uid(), title: 'MAV standup',  date: next(1), start: '09:00', end: '09:30',
        type: 'meeting', members: [luk, cam, die], notes: 'Weekly kickoff — priorities for the week', recur: 'weekly' },
      { id: uid(), title: 'Team gym session', date: t, start: '17:30', end: '18:45',
        type: 'workout', members: [luk, cam, die], notes: '', recur: 'none' },
      { id: uid(), title: 'Meal prep', date: next(0), start: '15:00', end: '17:00',
        type: 'meal', members: [luk, cam, die], notes: 'Cook lunches for the week', recur: 'weekly' },
    ],
    // blank slates — meal plans are built by hand/scanning, workout plans are
    // generated from each member's profile wizard answers
    mealPlans: { [luk]: {}, [cam]: {}, [die]: {} },
    mealLog: {},      // 'date|member' -> { mealId: true }
    mealExtras: {},   // 'date|member' -> [{id, slot, name, cal, protein, done, thumb?}] — photo-scanned / ad-hoc
    workoutPlans: { [luk]: [], [cam]: [], [die]: [] },
    workoutLog: {},   // 'date|member' -> { planId: { ex: {idx:true}, done: bool } }
    water: {},        // 'date|member' -> glasses
  };
}

export async function initStore() {
  const { state: loaded } = await loadState();
  state = loaded || seed();
  if (!state.members?.length) state = seed();
  state.mealExtras = state.mealExtras || {};   // migration for pre-scan data
  state.recentMeals = state.recentMeals || []; // migration: one-tap re-log
  state.calFeeds = state.calFeeds || [];       // migration: imported calendars
  state.checklistLog = state.checklistLog || {}; // 'date|member' -> {taskId:true}
  state.wins = state.wins || {};                 // 'date|member' -> {physical,mental,spiritual}
  state.stakes = state.stakes || '';             // team accountability stakes
  state.members.forEach((m) => {
    m.checklist = m.checklist || { must: [], should: [], want: [] };
    // m.profile stays undefined until the wizard runs
  });
  saveState(state);   // never throws — a full store can no longer white-screen boot
  return state;
}

/* ---------- derived helpers ---------- */
export const me = () => state.members.find((m) => m.id === state.me) || state.members[0];
export const memberById = (id) => state.members.find((m) => m.id === id);
export const initialsOf = (name) => name.trim().split(/\s+/).map((w) => w[0]).slice(0, 2).join('').toUpperCase();

export function occursOn(evt, dateStr) {
  if (evt.recur === 'daily')  return dateStr >= evt.date;
  if (evt.recur === 'weekly') return dateStr >= evt.date && dowOf(dateStr) === dowOf(evt.date);
  return evt.date === dateStr;
}

export function eventsOn(dateStr) {
  return state.events
    .filter((e) => occursOn(e, dateStr))
    .sort((a, b) => (a.start || '99') < (b.start || '99') ? -1 : 1);
}

export const logKey = (dateStr, memberId) => `${dateStr}|${memberId}`;

export function mealsFor(memberId, dateStr) {
  const plan = state.mealPlans[memberId]?.[dowOf(dateStr)] || [];
  const done = state.mealLog[logKey(dateStr, memberId)] || {};
  const extras = extrasFor(memberId, dateStr).map((x) => ({ ...x, extra: true }));
  const all = [...plan.map((m) => ({ ...m, done: !!done[m.id] })), ...extras];
  const slotIdx = (s) => { const i = MEAL_SLOTS.indexOf(s); return i < 0 ? 99 : i; };
  return all.sort((a, b) => slotIdx(a.slot) - slotIdx(b.slot));
}

export function extrasFor(memberId, dateStr) {
  return state.mealExtras[logKey(dateStr, memberId)] || [];
}

/** Recent scanned/logged meals for one member, newest first (for one-tap re-log). */
export function recentMealsFor(memberId, limit = 12) {
  return (state.recentMeals || []).filter((r) => r.member === memberId).slice(0, limit);
}

/** Add to the recents list (call inside mutate). Capped, deduped by label. */
export function pushRecentMeal(s, entry) {
  s.recentMeals = (s.recentMeals || []).filter((r) => !(r.member === entry.member && r.label === entry.label));
  s.recentMeals.unshift(entry);
  s.recentMeals = s.recentMeals.slice(0, 20);
}

/** The ~15 foods this member logs most — fed to the AI to bias recognition. */
export function frequentFoods(memberId, limit = 15) {
  const tally = {};
  const bump = (name, w) => {
    const n = String(name || '').trim();
    if (n) tally[n] = (tally[n] || 0) + w;
  };
  Object.entries(state.mealExtras).forEach(([k, list]) => {
    if (k.endsWith('|' + memberId)) list.forEach((x) => bump(x.name, 1));
  });
  Object.values(state.mealPlans[memberId] || {}).forEach((day) => day.forEach((m) => bump(m.name, 0.5)));
  return Object.entries(tally).sort((a, b) => b[1] - a[1]).slice(0, limit).map(([n]) => n);
}

export function workoutsFor(memberId, dateStr) {
  const dow = dowOf(dateStr);
  const plans = (state.workoutPlans[memberId] || []).filter((p) => p.dows.includes(dow));
  const log = state.workoutLog[logKey(dateStr, memberId)] || {};
  return plans.map((p) => ({ ...p, log: log[p.id] || { ex: {}, done: false } }));
}

export function waterFor(memberId, dateStr) {
  return state.water[logKey(dateStr, memberId)] || 0;
}

/* Weekly workout completion count (last 7 days incl today) */
export function workoutsThisWeek(memberId) {
  let n = 0;
  for (let i = 0; i < 7; i++) {
    const d = addDays(todayStr(), -i);
    const log = state.workoutLog[logKey(d, memberId)] || {};
    if (Object.values(log).some((l) => l.done)) n++;
  }
  return n;
}
