/* ============================================================
   ics.js — iCalendar (.ics) parsing + expansion.
   Understands what Google Calendar, Outlook, and school systems
   (Canvas etc.) export: VEVENTs with TZID/UTC/all-day dates,
   weekly/daily/monthly/yearly RRULEs, EXDATE, folded lines.
   Timezone note: UTC times are converted to local; TZID times are
   taken as wall-clock (right whenever the feed is in your own TZ).
   ============================================================ */

import { uid, toDateStr, fromDateStr, addDays, dowOf } from './store.js';

const unescapeIcs = (s) => String(s)
  .replace(/\\n/gi, ' ')
  .replace(/\\([,;\\])/g, '$1')
  .trim();

/** Parse raw .ics text → {calName, events:[{summary, start, end, rrule, exdates, location, description, status, uid}]} */
export function parseIcs(text) {
  // unfold wrapped lines (CRLF or LF followed by space/tab)
  const unfolded = String(text).replace(/\r\n/g, '\n').replace(/\n[ \t]/g, '');
  const lines = unfolded.split('\n');
  const events = [];
  let calName = '';
  let cur = null;

  for (const line of lines) {
    if (line.startsWith('BEGIN:VEVENT')) { cur = {}; continue; }
    if (line.startsWith('END:VEVENT')) { if (cur) events.push(cur); cur = null; continue; }
    const ci = line.indexOf(':');
    if (ci < 0) continue;
    const left = line.slice(0, ci);
    const value = line.slice(ci + 1);
    const [rawName, ...paramParts] = left.split(';');
    const key = rawName.toUpperCase();

    if (!cur) {
      if (key === 'X-WR-CALNAME') calName = unescapeIcs(value);
      continue;
    }
    const params = {};
    paramParts.forEach((p) => {
      const eq = p.indexOf('=');
      if (eq > 0) params[p.slice(0, eq).toUpperCase()] = p.slice(eq + 1).replace(/^"|"$/g, '');
    });
    switch (key) {
      case 'DTSTART':     cur.start = { value: value.trim(), params }; break;
      case 'DTEND':       cur.end = { value: value.trim(), params }; break;
      case 'SUMMARY':     cur.summary = unescapeIcs(value); break;
      case 'DESCRIPTION': cur.description = unescapeIcs(value); break;
      case 'LOCATION':    cur.location = unescapeIcs(value); break;
      case 'RRULE':       cur.rrule = value.trim(); break;
      case 'UID':         cur.uid = value.trim(); break;
      case 'STATUS':      cur.status = value.trim().toUpperCase(); break;
      case 'EXDATE':
        (cur.exdates = cur.exdates || []).push(...value.split(',').map((v) => v.trim()));
        break;
    }
  }
  return { calName, events };
}

/** ICS date/datetime → {date:'YYYY-MM-DD', time:'HH:MM'|null} (null on garbage). */
export function parseIcsDate(v) {
  if (!v) return null;
  const s = (typeof v === 'string' ? v : v.value).trim();
  const m = s.match(/^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})?(Z)?)?$/);
  if (!m) return null;
  if (!m[4]) return { date: `${m[1]}-${m[2]}-${m[3]}`, time: null }; // all-day
  if (m[7]) { // UTC → local clock
    const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +(m[6] || 0)));
    return {
      date: toDateStr(d),
      time: `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`,
    };
  }
  return { date: `${m[1]}-${m[2]}-${m[3]}`, time: `${m[4]}:${m[5]}` }; // wall clock
}

/** Guess an app event type from the title. */
export function classifyType(title) {
  const t = String(title).toLowerCase();
  if (/\b(exam|midterm|final|quiz|due|deadline|assignment|submit)\b/.test(t)) return 'deadline';
  if (/\b(gym|workout|lift|training|practice|run|yoga|swim)\b/.test(t)) return 'workout';
  if (/\b(lunch|dinner|breakfast|brunch|meal)\b/.test(t)) return 'meal';
  if (/\b(party|social|hangout|birthday|game night|happy hour)\b/.test(t)) return 'social';
  if (/\b(class|lecture|lab|seminar|meeting|standup|sync|1:1|call|interview|office hours|review)\b/.test(t)) return 'meeting';
  return 'other';
}

const BYDAY = { SU: 0, MO: 1, TU: 2, WE: 3, TH: 4, FR: 5, SA: 6 };

function parseRrule(s) {
  const r = {};
  String(s).split(';').forEach((p) => {
    const [k, v] = p.split('=');
    if (k && v) r[k.toUpperCase()] = v;
  });
  return r;
}

/** Occurrence dates for one event within [winStart, winEnd] (date strings). */
function occurrenceDates(startDate, rruleStr, winStart, winEnd) {
  if (!rruleStr) {
    return startDate >= winStart && startDate <= winEnd ? [startDate] : [];
  }
  const r = parseRrule(rruleStr);
  const freq = (r.FREQ || '').toUpperCase();
  const interval = Math.max(1, Number(r.INTERVAL) || 1);
  const until = r.UNTIL ? parseIcsDate(r.UNTIL)?.date : null;
  const count = Number(r.COUNT) || null;
  const stopDate = until && until < winEnd ? until : winEnd;
  const out = [];
  let made = 0; // occurrences generated since series start (COUNT semantics)

  const push = (d) => {
    made++;
    if (d >= winStart && d <= winEnd) out.push(d);
  };

  if (freq === 'WEEKLY') {
    const days = (r.BYDAY ? r.BYDAY.split(',') : [])
      .map((x) => BYDAY[x.replace(/^[+-]?\d+/, '').toUpperCase()])
      .filter((x) => x !== undefined);
    if (!days.length) days.push(dowOf(startDate));
    days.sort((a, b) => a - b);
    // walk week by week from the week containing startDate
    let weekStart = addDays(startDate, -dowOf(startDate));
    for (let guard = 0; guard < 400; guard++) {
      for (const day of days) {
        const d = addDays(weekStart, day);
        if (d < startDate) continue;
        if (d > stopDate || (count && made >= count)) return out;
        push(d);
      }
      weekStart = addDays(weekStart, 7 * interval);
      if (weekStart > stopDate) return out;
    }
    return out;
  }

  if (freq === 'DAILY') {
    let d = startDate;
    for (let guard = 0; guard < 1000; guard++) {
      if (d > stopDate || (count && made >= count)) return out;
      push(d);
      d = addDays(d, interval);
    }
    return out;
  }

  if (freq === 'MONTHLY' || freq === 'YEARLY') {
    const base = fromDateStr(startDate);
    for (let i = 0, guard = 0; guard < 240; guard++, i++) {
      const d = new Date(base);
      if (freq === 'MONTHLY') d.setMonth(base.getMonth() + i * interval);
      else d.setFullYear(base.getFullYear() + i * interval);
      if (d.getDate() !== base.getDate()) continue; // e.g. Jan 31 → Feb skipped
      const ds = toDateStr(d);
      if (ds > stopDate || (count && made >= count)) return out;
      push(ds);
    }
    return out;
  }

  // unknown FREQ — at least keep the first occurrence
  return startDate >= winStart && startDate <= winEnd ? [startDate] : [];
}

/**
 * Expand parsed ICS events into app calendar events for one member.
 * Window: a week back → `horizonDays` forward. Returns {events, skipped}.
 */
export function icsToAppEvents(parsed, memberId, feedId, { horizonDays = 180, cap = 600 } = {}) {
  const today = toDateStr(new Date());
  const winStart = addDays(today, -7);
  const winEnd = addDays(today, horizonDays);
  const events = [];
  let skipped = 0;

  for (const ev of parsed.events) {
    if (ev.status === 'CANCELLED') { skipped++; continue; }
    const st = parseIcsDate(ev.start);
    if (!st) { skipped++; continue; }
    const en = parseIcsDate(ev.end);
    const endTime = (st.time && en?.time && en.date === st.date) ? en.time : '';

    const exSet = new Set((ev.exdates || []).map((x) => parseIcsDate(x)?.date).filter(Boolean));
    const title = ev.summary || '(untitled)';
    const bits = [];
    if (ev.location) bits.push(ev.location);
    if (ev.description) bits.push(ev.description.slice(0, 90));
    const notes = bits.join(' · ').slice(0, 140);

    for (const date of occurrenceDates(st.date, ev.rrule, winStart, winEnd)) {
      if (exSet.has(date)) continue;
      if (events.length >= cap) return { events, skipped: skipped + 1 };
      events.push({
        id: uid(), title, date,
        start: st.time || '', end: endTime,
        type: classifyType(title),
        members: [memberId],
        notes, recur: 'none', feedId,
      });
    }
  }
  return { events, skipped };
}
