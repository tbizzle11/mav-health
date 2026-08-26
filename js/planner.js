/* ============================================================
   planner.js — the math brains:
   - maintenance calories (Mifflin-St Jeor) + cut/bulk pace plans
   - recommended daily schedule built around busy blocks
   - common free slots across members for meet-ups
   ============================================================ */

import { dowOf, addDays, todayStr, fmtTime } from './store.js';

/* ---------- time helpers (minutes since midnight) ---------- */
export const toMin = (t) => {
  if (!t) return null;
  const [h, m] = t.split(':').map(Number);
  return h * 60 + (m || 0);
};
export const toHM = (min) => {
  const m = ((min % 1440) + 1440) % 1440;
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
};

/* ---------- calories ---------- */
/** Maintenance calories. profile: {heightIn, weightLb, age, sex, activity}. */
export function maintenanceCalories(p) {
  const kg = (Number(p.weightLb) || 0) * 0.45359;
  const cm = (Number(p.heightIn) || 0) * 2.54;
  const age = Number(p.age) || 25;
  const sexAdj = p.sex === 'male' ? 5 : p.sex === 'female' ? -161 : -78; // 'na' = midpoint
  const bmr = 10 * kg + 6.25 * cm - 5 * age + sexAdj;
  const tdee = bmr * (Number(p.activity) || 1.375);
  return Math.round(tdee / 10) * 10;
}

/** Sleep duration in hours between bed and wake (crosses midnight). */
export function sleepHours(bed, wake) {
  const b = toMin(bed), w = toMin(wake);
  if (b == null || w == null) return null;
  return Math.round(((w - b + 1440) % 1440) / 6) / 10;
}

/**
 * Three pace options for the member's direction (cut / bulk / maintain).
 * Each: {key, label, calories, weeklyLbs, weeksToGoal, floored, blurb}.
 */
export function paceOptions(profile) {
  const tdee = maintenanceCalories(profile);
  const w = Number(profile.weightLb) || 0;
  const g = Number(profile.goalWeightLb) || w;
  const delta = Math.abs(w - g);
  const floor = profile.sex === 'female' ? 1200 : 1500;

  const mk = (key, label, adj, weeklyLbs, blurb) => {
    let calories = Math.round((tdee + adj) / 10) * 10;
    let floored = false;
    if (calories < floor) { calories = floor; floored = true; }
    const weeksToGoal = weeklyLbs > 0 && delta > 0 ? Math.ceil(delta / weeklyLbs) : null;
    return { key, label, calories, weeklyLbs, weeksToGoal, floored, blurb };
  };

  if (g < w) {
    return { mode: 'cut', tdee, options: [
      mk('fast', 'Aggressive', -1000, 2.0, 'Fastest results — hard to sustain, protect your protein'),
      mk('moderate', 'Good pace', -500, 1.0, 'The sweet spot — steady loss you can stick to'),
      mk('slow', 'Easy does it', -250, 0.5, 'Slow and comfortable — barely feels like a diet'),
    ]};
  }
  if (g > w) {
    return { mode: 'bulk', tdee, options: [
      mk('fast', 'Fast bulk', 500, 1.0, 'Max muscle + some fat along the way'),
      mk('moderate', 'Lean bulk', 300, 0.6, 'Mostly muscle, minimal fat — the classic'),
      mk('slow', 'Slow lean', 150, 0.3, 'Very lean gains, very patient'),
    ]};
  }
  return { mode: 'maintain', tdee, options: [
    mk('maintain', 'Recomp / maintain', 0, 0, 'Eat at maintenance, lift hard, high protein — body recomposition'),
  ]};
}

/** Protein goal: ~0.9 g per lb of goal bodyweight. */
export const proteinGoal = (profile) =>
  Math.round(0.9 * (Number(profile.goalWeightLb) || Number(profile.weightLb) || 0));

/* ---------- busy intervals ---------- */
/** Member's busy intervals [{s,e,label}] for a date: profile blocks + timed events. */
export function busyIntervals(member, dateStr, events) {
  const dow = dowOf(dateStr);
  const out = [];
  (member.profile?.busy || []).forEach((b) => {
    if (!b.days?.length || b.days.includes(dow)) {
      const s = toMin(b.start), e = toMin(b.end);
      if (s != null && e != null && e > s) out.push({ s, e, label: b.label || 'Busy' });
    }
  });
  events.forEach((ev) => {
    if (!ev.members.includes(member.id)) return;
    const s = toMin(ev.start), e = toMin(ev.end);
    if (s != null && e != null && e > s) out.push({ s, e, label: ev.title });
  });
  return mergeIntervals(out);
}

function mergeIntervals(list) {
  const sorted = [...list].sort((a, b) => a.s - b.s);
  const out = [];
  for (const iv of sorted) {
    const last = out[out.length - 1];
    if (last && iv.s <= last.e) { last.e = Math.max(last.e, iv.e); last.label += ` / ${iv.label}`; }
    else out.push({ ...iv });
  }
  return out;
}

/** Free gaps within [winS, winE] around the busy list. */
export function freeGaps(busy, winS, winE) {
  const gaps = [];
  let cur = winS;
  for (const iv of busy) {
    if (iv.e <= winS || iv.s >= winE) continue;
    if (iv.s > cur) gaps.push({ s: cur, e: Math.min(iv.s, winE) });
    cur = Math.max(cur, iv.e);
  }
  if (cur < winE) gaps.push({ s: cur, e: winE });
  return gaps.filter((g) => g.e - g.s >= 15);
}

/* ---------- recommended daily schedule ---------- */
/**
 * Build a suggested plan for one member's day.
 * Returns [{start, end, label, icon, kind}] sorted by time.
 */
export function buildDayPlan(member, dateStr, events) {
  const p = member.profile;
  if (!p) return [];
  const wake = toMin(p.wake) ?? 420;
  const bed = toMin(p.bed) ?? 1380;
  const dayEnd = bed > wake ? bed : 1440; // same-day portion only
  const busy = busyIntervals(member, dateStr, events);
  const plan = [];
  const claimed = [];

  const claim = (s, e, label, icon, kind) => {
    plan.push({ start: toHM(s), end: toHM(e), label, icon, kind });
    claimed.push({ s, e, label });
  };

  claim(wake, Math.min(wake + 45, dayEnd), 'Wake up & morning routine', '🌅', 'routine');
  busy.forEach((iv) => claim(iv.s, iv.e, iv.label, '📌', 'busy'));

  const gapsFor = () => freeGaps(mergeIntervals(claimed), wake, dayEnd);

  // gym block — honor preferred time of day when a big-enough gap exists there
  const gymMin = Number(p.gymMinutes) || 0;
  if (gymMin >= 20) {
    const pref = p.gymTime || 'evening';
    const windows = { morning: [wake, 12 * 60], afternoon: [12 * 60, 17 * 60], evening: [16 * 60, 21.5 * 60] };
    const [ps, pe] = windows[pref] || windows.evening;
    const fit = (gaps) => gaps.find((g) => g.e - g.s >= gymMin + 15);
    let gap = fit(gapsFor().map((g) => ({ s: Math.max(g.s, ps), e: Math.min(g.e, pe) })).filter((g) => g.e > g.s))
           || fit(gapsFor());
    if (gap) claim(gap.s, gap.s + gymMin, 'Gym session', '🏋️', 'gym');
  }

  // must-dos block (only if they have musts)
  const mustCount = member.checklist?.must?.length || 0;
  if (mustCount) {
    const gap = gapsFor().find((g) => g.e - g.s >= 45);
    if (gap) claim(gap.s, Math.min(gap.s + 60, gap.e), `Knock out must-dos (${mustCount})`, '✅', 'musts');
  }

  // free time = the biggest remaining gap before wind-down
  const windDown = Math.max(wake, dayEnd - 60);
  const freeGap = gapsFor().filter((g) => g.s < windDown)
    .map((g) => ({ s: g.s, e: Math.min(g.e, windDown) }))
    .filter((g) => g.e - g.s >= 30)
    .sort((a, b) => (b.e - b.s) - (a.e - a.s))[0];
  if (freeGap) claim(freeGap.s, freeGap.e, 'Free time', '🎮', 'free');

  claim(windDown, dayEnd, 'Wind down — screens off, tomorrow set up', '🌙', 'winddown');
  plan.push({ start: toHM(bed), end: '', label: `Lights out (${sleepHours(p.bed, p.wake) ?? '?'}h sleep)`, icon: '😴', kind: 'sleep' });

  return plan.sort((a, b) => toMin(a.start) - toMin(b.start));
}

/* ---------- meet-up finder ---------- */
/**
 * Common free slots for ALL given members over the next `days` days.
 * Window: latest wake+30 … earliest bed-30 (bounded 9:00–22:00 default).
 * Returns [{date, start, end, minutes}] best-first (longest, soonest).
 */
export function findMeetSlots(members, events, { days = 7, minMinutes = 60, max = 8 } = {}) {
  const slots = [];
  const wakes = members.map((m) => toMin(m.profile?.wake) ?? 540);
  const beds = members.map((m) => toMin(m.profile?.bed) ?? 1320);
  const winS = Math.max(9 * 60, ...wakes.map((w) => w + 30));
  const winE = Math.min(22 * 60, ...beds.map((b) => b - 30));
  if (winE - winS < minMinutes) return [];

  const t = todayStr();
  for (let i = 0; i < days; i++) {
    const date = addDays(t, i);
    let common = [{ s: i === 0 ? Math.max(winS, nowMin() + 30) : winS, e: winE }];
    for (const m of members) {
      const busy = busyIntervals(m, date, events.filter((e) => occursOnDate(e, date)));
      common = common.flatMap((g) => freeGaps(busy, g.s, g.e));
      if (!common.length) break;
    }
    common.filter((g) => g.e - g.s >= minMinutes).forEach((g) =>
      slots.push({ date, start: toHM(g.s), end: toHM(g.e), minutes: g.e - g.s }));
  }
  return slots
    .sort((a, b) => (a.date === b.date ? toMin(a.start) - toMin(b.start) : a.date < b.date ? -1 : 1))
    .slice(0, max);
}

const nowMin = () => { const d = new Date(); return d.getHours() * 60 + d.getMinutes(); };

// local copy to avoid circular import of occursOn
function occursOnDate(evt, dateStr) {
  if (evt.recur === 'daily') return dateStr >= evt.date;
  if (evt.recur === 'weekly') return dateStr >= evt.date && dowOf(dateStr) === dowOf(evt.date);
  return evt.date === dateStr;
}

export const fmtSlot = (s) => `${fmtTime(s.start)} – ${fmtTime(s.end)}`;
