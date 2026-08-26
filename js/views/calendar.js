/* Calendar — shared team calendar: month grid, member filter, day agenda,
   7-day upcoming list, event sheet, and .ics calendar import (Google /
   Outlook / school feeds) assigned per member. */
import {
  getState, mutate, me, memberById, eventsOn, occursOn, todayStr, toDateStr, fromDateStr,
  addDays, fmtNice, fmtShort, fmtTime, uid, EVENT_TYPES,
} from '../store.js';
import { $, $$, esc, avatar, avatarStack, openSheet, closeSheet, confirmSheet, toast } from '../ui.js';
import { parseIcs, icsToAppEvents } from '../ics.js';
import { findMeetSlots, fmtSlot, toMin, toHM } from '../planner.js';

let cursor = todayStr();          // selected day
let monthAnchor = todayStr();     // any date inside the displayed month
let memberFilter = 'all';

export const calendarView = {
  id: 'calendar',
  onEnter() { cursor = todayStr(); monthAnchor = todayStr(); },
  title: () => 'Calendar',
  subtitle: () => 'Shared team calendar',
  fab: () => openEventSheet(null, cursor),
  topAction: { ico: 'home', run: () => { cursor = todayStr(); monthAnchor = todayStr(); rerender(); } },

  render(root) { renderInto(root); },
};

let lastRoot = null;
function rerender() { if (lastRoot) renderInto(lastRoot); }

const visible = (list) => memberFilter === 'all'
  ? list
  : list.filter((e) => e.members.includes(memberFilter));

const feedName = (e) => {
  if (!e.feedId) return '';
  const f = (getState().calFeeds || []).find((x) => x.id === e.feedId);
  return f ? f.name : 'imported';
};

function evtRow(e) {
  const ty = EVENT_TYPES[e.type] || EVENT_TYPES.other;
  const feed = feedName(e);
  return `
    <button class="evt" data-evt="${e.id}" data-evt-date="${e.date}">
      <span class="evt-rail" style="background:${ty.color}"></span>
      <span class="evt-time">${fmtTime(e.start) || 'All day'}${e.end ? `<br>${fmtTime(e.end)}` : ''}</span>
      <span class="grow" style="min-width:0">
        <span class="evt-title truncate" style="display:block">${esc(e.title)}</span>
        <span class="evt-meta">${ty.label}${e.recur !== 'none' ? ' · repeats ' + e.recur : ''}${feed ? ' · 🔗 ' + esc(feed) : ''}${e.notes ? ' · ' + esc(e.notes) : ''}</span>
      </span>
      ${avatarStack(e.members)}
    </button>`;
}

function renderInto(root) {
  lastRoot = root;
  const s = getState();
  const anchor = fromDateStr(monthAnchor);
  const y = anchor.getFullYear(), mo = anchor.getMonth();
  const startPad = new Date(y, mo, 1).getDay();
  const gridStart = new Date(y, mo, 1 - startPad);
  const t = todayStr();

  const cells = [];
  for (let i = 0; i < 42; i++) {
    const d = new Date(gridStart);
    d.setDate(gridStart.getDate() + i);
    const ds = toDateStr(d);
    const evts = visible(eventsOn(ds));
    const dotColors = [...new Set(evts.map((e) => (EVENT_TYPES[e.type] || EVENT_TYPES.other).color))].slice(0, 3);
    cells.push(`
      <button class="cal-cell ${d.getMonth() !== mo ? 'is-out' : ''} ${ds === t ? 'is-today' : ''} ${ds === cursor ? 'is-sel' : ''}"
        data-day="${ds}">
        <span class="cal-n">${d.getDate()}</span>
        <span class="cal-dots">${dotColors.map((c) => `<span class="dot" style="background:${c}"></span>`).join('')}</span>
      </button>`);
  }

  const dayEvents = visible(eventsOn(cursor));

  // upcoming: next 7 days from today, grouped by day
  const upcoming = [];
  for (let i = 0; i < 7 && upcoming.reduce((n, g) => n + g.events.length, 0) < 12; i++) {
    const d = addDays(t, i);
    if (d === cursor) continue; // already shown in the day agenda
    const evts = visible(eventsOn(d));
    if (evts.length) upcoming.push({ date: d, events: evts.slice(0, 4) });
  }

  root.innerHTML = `
  <div class="fade-in">
    <div class="chips" style="margin-bottom:12px">
      <button class="chip ${memberFilter === 'all' ? 'is-on' : ''}" data-filter="all">Everyone</button>
      ${s.members.map((m) => `
        <button class="chip ${memberFilter === m.id ? 'is-on' : ''}" data-filter="${m.id}"
          ${memberFilter === m.id ? `style="background:${m.color}"` : ''}>${esc(m.name)}</button>`).join('')}
    </div>

    <div class="card card-pad">
      <div class="row-between" style="margin-bottom:8px">
        <button class="icon-btn" data-nav="-1" aria-label="Previous month">‹</button>
        <span class="strong">${fromDateStr(monthAnchor).toLocaleDateString(undefined, { month: 'long', year: 'numeric' })}</span>
        <button class="icon-btn" data-nav="1" aria-label="Next month">›</button>
      </div>
      <div class="cal-head">${['S','M','T','W','T','F','S'].map((d) => `<span class="cal-dow">${d}</span>`).join('')}</div>
      <div class="cal-grid">${cells.join('')}</div>
    </div>

    <div class="row-between" style="margin:20px 2px 9px">
      <h2 style="font-size:17px;letter-spacing:-.02em">${cursor === t ? 'Today' : esc(fmtNice(cursor))}</h2>
      <span class="pill">${dayEvents.length || 'no'} event${dayEvents.length === 1 ? '' : 's'}</span>
    </div>
    <div class="list">
      ${dayEvents.length ? dayEvents.map(evtRow).join('')
        : `<div class="empty"><span class="empty-ico">📭</span>Nothing on this day${memberFilter !== 'all' ? ` for ${esc(memberById(memberFilter)?.name || '')}` : ''}.<br>Tap + to add an event.</div>`}
    </div>

    ${upcoming.length ? `
      <div class="section-head"><h2>Coming up</h2></div>
      <div class="list">
        ${upcoming.map((g) => `
          <div class="list-row no-press" style="padding:8px 14px;background:var(--surface-2)">
            <span class="tiny strong dim" style="text-transform:uppercase;letter-spacing:.04em">${esc(fmtShort(g.date))}</span>
          </div>
          ${g.events.map(evtRow).join('')}`).join('')}
      </div>` : ''}

    <div class="section-head"><h2>Tools</h2></div>
    <div class="list">
      <button class="list-row" id="findMeet">
        <span style="font-size:17px;flex:none">🤝</span>
        <span class="grow"><div class="list-title">Find a time we can all meet</div>
          <div class="list-sub">Common free windows, next 7 days</div></span>
        <span class="chev">›</span>
      </button>
      <button class="list-row" id="importCal">
        <span style="font-size:17px;flex:none">🔗</span>
        <span class="grow"><div class="list-title">Import a calendar</div>
          <div class="list-sub">.ics file or live link — Google, school, work</div></span>
        <span class="chev">›</span>
      </button>
    </div>
  </div>`;

  $$('[data-filter]', root).forEach((b) => b.addEventListener('click', () => {
    memberFilter = b.dataset.filter; rerender();
  }));
  $$('[data-day]', root).forEach((b) => b.addEventListener('click', () => {
    cursor = b.dataset.day; rerender();
  }));
  $$('[data-nav]', root).forEach((b) => b.addEventListener('click', () => {
    const d = fromDateStr(monthAnchor);
    d.setMonth(d.getMonth() + Number(b.dataset.nav), 1);
    monthAnchor = toDateStr(d);
    rerender();
    window.dispatchEvent(new CustomEvent('mav:titlechange'));
  }));
  $$('[data-evt]', root).forEach((b) => b.addEventListener('click', () => {
    const evt = getState().events.find((e) => e.id === b.dataset.evt);
    if (evt) openEventSheet(evt);
  }));
  $('#importCal', root).addEventListener('click', openImportSheet);
  $('#findMeet', root).addEventListener('click', openMeetSheet);
}

/* ============================================================
   Meet-up finder — common free time across every member.
   ============================================================ */
function openMeetSheet() {
  const s = getState();
  const slots = findMeetSlots(s.members, s.events, { days: 7, minMinutes: 60, max: 10 });

  openSheet({
    title: 'Find a time',
    body: `
      <p class="small muted" style="margin-bottom:12px">Windows in the next 7 days when <b>all ${s.members.length} of you</b> are free — based on everyone's calendars and busy hours. Tap one to send the invite.</p>
      ${slots.length ? `
        <div class="list">
          ${slots.map((sl, i) => `
            <button class="list-row" data-slot="${i}">
              <span style="font-size:17px;flex:none">🤝</span>
              <span class="grow">
                <div class="list-title">${esc(fmtShort(sl.date))}</div>
                <div class="list-sub">${fmtSlot(sl)} · ${Math.floor(sl.minutes / 60) ? `${Math.floor(sl.minutes / 60)}h ` : ''}${sl.minutes % 60 ? `${sl.minutes % 60}m` : ''} free</div>
              </span>
              <span class="chev">›</span>
            </button>`).join('')}
        </div>` : `
        <div class="empty"><span class="empty-ico">😵</span>No common window found in the next 7 days.<br>Check that everyone's busy hours and calendars are up to date.</div>`}`,
    onSave: null,
    setup: (root) => {
      $$('[data-slot]', root).forEach((b) => b.addEventListener('click', () => {
        const sl = slots[Number(b.dataset.slot)];
        closeSheet();
        openEventSheet(null, sl.date, {
          title: 'MAV meetup',
          type: 'social',
          start: sl.start,
          end: toHM(Math.min(toMin(sl.start) + 60, toMin(sl.end))),
          notes: 'Auto-found — everyone’s free 🤝',
        });
      }));
    },
  });
}

/* ============================================================
   Calendar import — .ics file or subscription link, per member.
   ============================================================ */
function openImportSheet() {
  const s = getState();
  let who = me().id;

  const feedRows = () => (getState().calFeeds || []).map((f) => {
    const m = memberById(f.member);
    return `
    <div class="list-row no-press">
      ${m ? avatar(m, 'av av-sm') : ''}
      <span class="grow" style="min-width:0">
        <div class="list-title truncate">${esc(f.name)}</div>
        <div class="list-sub">${f.count} events · ${m ? esc(m.name) : '?'}${f.url ? ' · linked' : ' · file'}</div>
      </span>
      ${f.url ? `<button class="btn btn-sm" data-sync="${f.id}">Sync</button>` : ''}
      <button class="btn btn-sm btn-danger" data-unfeed="${f.id}">Remove</button>
    </div>`;
  }).join('');

  openSheet({
    title: 'Import calendar',
    body: `
      <div class="field">
        <label class="label">Whose calendar is this?</label>
        <div class="picker" id="impWho">
          ${s.members.map((m) => `
            <button class="picker-opt ${m.id === who ? 'is-on' : ''}" data-who="${m.id}">${esc(m.name)}</button>`).join('')}
        </div>
      </div>
      <button class="btn btn-primary btn-block" id="impFile">📄 Choose an .ics file</button>
      <input type="file" id="impFileInput" accept=".ics,text/calendar" hidden />
      <div class="divider"></div>
      <div class="field" style="margin-bottom:8px">
        <label class="label" for="impUrl">Or paste a calendar link</label>
        <div class="row gap-8">
          <input class="input grow" id="impUrl" type="url" placeholder="https://…/calendar.ics" autocomplete="off" />
          <button class="btn btn-sm btn-primary" id="impUrlGo" style="flex:none">Add</button>
        </div>
      </div>
      <p class="tiny dim" style="margin-bottom:14px">
        Google Calendar: Settings → your calendar → <b>Integrate calendar</b> → "Secret address in iCal format" (or Export for a file).
        School/work portals usually have a "calendar feed" or "export" link. If a link is blocked by the calendar's server, download the .ics file instead — that always works.</p>
      <div class="section-head" style="margin-top:4px"><h2>Imported calendars</h2></div>
      <div class="list" id="feedList">
        ${(s.calFeeds || []).length ? feedRows() : `<div class="empty" style="padding:16px">None yet</div>`}
      </div>`,
    onSave: null,
    setup: (root) => {
      $$('#impWho .picker-opt', root).forEach((b) => b.addEventListener('click', () => {
        $$('#impWho .picker-opt', root).forEach((x) => x.classList.remove('is-on'));
        b.classList.add('is-on');
        who = b.dataset.who;
      }));

      const fileInput = $('#impFileInput', root);
      $('#impFile', root).addEventListener('click', () => fileInput.click());
      fileInput.addEventListener('change', async () => {
        const f = fileInput.files[0];
        if (!f) return;
        const text = await f.text();
        importFeed(text, { fallbackName: f.name.replace(/\.ics$/i, ''), url: null, who });
        fileInput.value = '';
      });

      $('#impUrlGo', root).addEventListener('click', async () => {
        const url = $('#impUrl', root).value.trim().replace(/^webcal:/i, 'https:');
        if (!/^https?:\/\//i.test(url)) { toast('Paste a full calendar link first'); return; }
        const btn = $('#impUrlGo', root);
        btn.disabled = true; btn.textContent = '…';
        try {
          const res = await fetch(url);
          if (!res.ok) throw new Error(`fetch ${res.status}`);
          const text = await res.text();
          importFeed(text, { fallbackName: new URL(url).hostname, url, who });
        } catch {
          toast('That link blocks browser access — download the .ics file instead');
          btn.disabled = false; btn.textContent = 'Add';
        }
      });

      $$('[data-sync]', root).forEach((b) => b.addEventListener('click', async () => {
        const feed = getState().calFeeds.find((f) => f.id === b.dataset.sync);
        if (!feed?.url) return;
        b.disabled = true; b.textContent = '…';
        try {
          const res = await fetch(feed.url);
          if (!res.ok) throw new Error();
          importFeed(await res.text(), { fallbackName: feed.name, url: feed.url, who: feed.member });
        } catch {
          toast('Sync failed — the link may block browser access');
          b.disabled = false; b.textContent = 'Sync';
        }
      }));

      $$('[data-unfeed]', root).forEach((b) => b.addEventListener('click', () => {
        const feed = getState().calFeeds.find((f) => f.id === b.dataset.unfeed);
        if (!feed) return;
        closeSheet();
        confirmSheet('Remove calendar', `Remove “${feed.name}” and its ${feed.count} events?`, () => {
          mutate((st) => {
            st.events = st.events.filter((e) => e.feedId !== feed.id);
            st.calFeeds = st.calFeeds.filter((f) => f.id !== feed.id);
          });
          toast('Calendar removed');
          rerender();
        }, 'Remove');
      }));
    },
  });
}

function importFeed(icsText, { fallbackName, url, who }) {
  let parsed;
  try { parsed = parseIcs(icsText); }
  catch { toast('That file doesn’t look like a calendar'); return; }
  if (!parsed.events.length) { toast('No events found in that calendar'); return; }

  const name = (parsed.calName || fallbackName || 'Imported').slice(0, 40);
  const feedId = uid();
  const { events, skipped } = icsToAppEvents(parsed, who, feedId);
  if (!events.length) { toast('No events in the next 6 months in that calendar'); return; }

  mutate((st) => {
    // replace a previous import of the same calendar for the same person
    const dupe = (st.calFeeds || []).find((f) =>
      f.member === who && (url ? f.url === url : f.name === name));
    if (dupe) {
      st.events = st.events.filter((e) => e.feedId !== dupe.id);
      st.calFeeds = st.calFeeds.filter((f) => f.id !== dupe.id);
    }
    st.calFeeds.push({ id: feedId, name, url: url || null, member: who, addedAt: Date.now(), count: events.length });
    st.events.push(...events);
  });
  closeSheet();
  toast(`Imported ${events.length} events from ${name}${skipped ? ` (${skipped} skipped)` : ''}`);
  rerender();
}

/* ---------- event sheet (add / edit) ---------- */
export function openEventSheet(evt = null, defaultDate = null, seed = {}) {
  const s = getState();
  const isNew = !evt;
  const data = evt || {
    id: uid(), title: '', date: defaultDate || todayStr(), start: '09:00', end: '',
    type: 'meeting', members: s.members.map((m) => m.id), notes: '', recur: 'none',
    ...seed,
  };

  openSheet({
    title: isNew ? 'New event' : 'Edit event',
    saveLabel: isNew ? 'Add' : 'Save',
    body: `
      ${data.feedId ? `<div class="banner" style="margin-bottom:14px">🔗 From “${esc(feedName(data))}”. Edits apply to this occurrence only, and a re-sync of that calendar replaces them.</div>` : ''}
      <div class="field">
        <label class="label" for="evTitle">Title</label>
        <input class="input" id="evTitle" placeholder="e.g. Team standup" value="${esc(data.title)}" />
      </div>
      <div class="field field-row">
        <div>
          <label class="label" for="evDate">Date</label>
          <input class="input" id="evDate" type="date" value="${data.date}" />
        </div>
        <div>
          <label class="label" for="evStart">Start</label>
          <input class="input" id="evStart" type="time" value="${data.start}" />
        </div>
        <div>
          <label class="label" for="evEnd">End</label>
          <input class="input" id="evEnd" type="time" value="${data.end}" />
        </div>
      </div>
      <div class="field">
        <label class="label">Type</label>
        <div class="picker" id="evType">
          ${Object.entries(EVENT_TYPES).map(([k, v]) => `
            <button class="picker-opt ${data.type === k ? 'is-on' : ''}" data-type="${k}">
              <span class="dot" style="background:${v.color};display:inline-block;margin-right:5px"></span>${v.label}
            </button>`).join('')}
        </div>
      </div>
      <div class="field">
        <label class="label">Who's in</label>
        <div class="picker" id="evWho">
          ${s.members.map((m) => `
            <button class="picker-opt ${data.members.includes(m.id) ? 'is-on' : ''}" data-who="${m.id}">${esc(m.name)}</button>`).join('')}
        </div>
      </div>
      <div class="field">
        <label class="label">Repeats</label>
        <div class="seg" id="evRecur">
          ${['none', 'daily', 'weekly'].map((r) => `
            <button class="seg-item ${data.recur === r ? 'is-on' : ''}" data-recur="${r}">${r === 'none' ? 'Once' : r[0].toUpperCase() + r.slice(1)}</button>`).join('')}
        </div>
      </div>
      <div class="field">
        <label class="label" for="evNotes">Notes</label>
        <textarea class="textarea" id="evNotes" placeholder="Optional">${esc(data.notes)}</textarea>
      </div>
      ${isNew ? '' : `<button class="btn btn-danger btn-block" id="evDelete">Delete event</button>`}
    `,
    setup: (root) => {
      $$('#evType .picker-opt', root).forEach((b) => b.addEventListener('click', () => {
        $$('#evType .picker-opt', root).forEach((x) => x.classList.remove('is-on'));
        b.classList.add('is-on');
      }));
      $$('#evWho .picker-opt', root).forEach((b) => b.addEventListener('click', () =>
        b.classList.toggle('is-on')));
      $$('#evRecur .seg-item', root).forEach((b) => b.addEventListener('click', () => {
        $$('#evRecur .seg-item', root).forEach((x) => x.classList.remove('is-on'));
        b.classList.add('is-on');
      }));
      const del = $('#evDelete', root);
      if (del) del.addEventListener('click', () => {
        closeSheet();
        confirmSheet('Delete event', `Delete “${data.title}” for everyone?`, () => {
          mutate((st) => { st.events = st.events.filter((e) => e.id !== data.id); });
          toast('Event deleted');
        });
      });
      if (isNew) $('#evTitle', root).focus();
    },
    onSave: () => {
      const root = $('#sheetBody');
      const title = $('#evTitle', root).value.trim();
      if (!title) { toast('Give it a title'); return false; }
      const next = {
        ...data,
        title,
        date: $('#evDate', root).value || todayStr(),
        start: $('#evStart', root).value,
        end: $('#evEnd', root).value,
        type: $('#evType .is-on', root)?.dataset.type || 'other',
        members: $$('#evWho .is-on', root).map((b) => b.dataset.who),
        recur: $('#evRecur .is-on', root)?.dataset.recur || 'none',
        notes: $('#evNotes', root).value.trim(),
      };
      mutate((st) => {
        const i = st.events.findIndex((e) => e.id === next.id);
        if (i >= 0) st.events[i] = next; else st.events.push(next);
      });
      cursor = next.date;
      monthAnchor = next.date;
      toast(isNew ? 'Event added' : 'Event updated');
    },
  });
}
