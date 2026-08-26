/* ============================================================
   sync.js — team sync via Supabase (plain REST, no SDK).
   State is split into buckets; each bucket is one row keyed by
   (team_id, bucket). The team key is an unguessable secret kept
   per-device (never in the repo or exports) and sent as the
   x-team-key header — RLS only reveals rows that match it.

   Merge strategy:
   - 'union' buckets are dicts keyed by 'date|member': merged
     key-wise (remote base + locally-changed keys win) so people
     logging at the same time never clobber each other.
   - 'lww' buckets replace wholesale; pushes happen ~1s after any
     edit, so the conflict window is tiny for a 3-person team.
   ============================================================ */

import { getState, mutate, subscribe } from './store.js';

const SYNC_URL = 'https://chnxrkufwzamhpelovge.supabase.co/rest/v1/sync_buckets';
const SYNC_KEY = 'sb_publishable_FxhZ13aT4rQg3KP8hxMH7Q_jx4ziiUV'; // public by design; RLS + team key guard the data

const TEAM_STORE = 'mavhealth.teamkey';
const DEVICE_STORE = 'mavhealth.deviceid';

const BUCKETS = {
  members:      { mode: 'lww' },
  events:       { mode: 'lww' },
  mealPlans:    { mode: 'lww' },
  workoutPlans: { mode: 'lww' },
  recentMeals:  { mode: 'lww' },
  calFeeds:     { mode: 'lww' },
  stakes:       { mode: 'lww' },
  mealLog:      { mode: 'union' },
  workoutLog:   { mode: 'union' },
  mealExtras:   { mode: 'union' },
  water:        { mode: 'union' },
  checklistLog: { mode: 'union' },
  wins:         { mode: 'union' },
};
// device-local, never synced: me, plus everything outside these buckets

const getVal = (s, b) => (b === 'stakes' ? { v: s.stakes || '' } : s[b]);
const setVal = (s, b, v) => { if (b === 'stakes') s.stakes = (v && v.v) || ''; else s[b] = v; };

/* ---------- device-local config ---------- */
export const getTeamKey = () => { try { return localStorage.getItem(TEAM_STORE) || ''; } catch { return ''; } };
const setTeamKey = (k) => { try { k ? localStorage.setItem(TEAM_STORE, k) : localStorage.removeItem(TEAM_STORE); } catch {} };

const deviceId = () => {
  try {
    let d = localStorage.getItem(DEVICE_STORE);
    if (!d) { d = Math.random().toString(36).slice(2, 10); localStorage.setItem(DEVICE_STORE, d); }
    return d;
  } catch { return 'unknown'; }
};

/* ---------- status ---------- */
const status = { enabled: false, lastSync: 0, error: '', busy: false };
export const syncStatus = () => ({ ...status, enabled: !!getTeamKey() });
const announce = () => window.dispatchEvent(new CustomEvent('mav:sync'));

/* ---------- transport ---------- */
async function api(path, opts = {}) {
  const res = await fetch(SYNC_URL + path, {
    ...opts,
    headers: {
      apikey: SYNC_KEY,
      'x-team-key': getTeamKey(),
      'content-type': 'application/json',
      ...(opts.headers || {}),
    },
  });
  if (!res.ok) throw new Error(`sync ${res.status}`);
  const text = await res.text();
  return text ? JSON.parse(text) : null; // 201/204 upserts come back empty
}

/* ---------- engine ---------- */
let base = {};            // bucket -> JSON string as of last successful sync
let applyingRemote = false;
let pushTimer = null;
let pollTimer = null;

const snap = (b) => JSON.stringify(getVal(getState(), b) ?? null);

function dirtyBuckets() {
  return Object.keys(BUCKETS).filter((b) => snap(b) !== base[b]);
}

async function push() {
  if (!getTeamKey()) return;
  const dirty = dirtyBuckets();
  if (!dirty.length) return;
  const team = getTeamKey();
  const rows = dirty.map((b) => ({
    team_id: team, bucket: b,
    data: JSON.parse(snap(b)),
    updated_at: new Date().toISOString(),
    device: deviceId(),
  }));
  await api('', {
    method: 'POST',
    headers: { Prefer: 'resolution=merge-duplicates' },
    body: JSON.stringify(rows),
  });
  dirty.forEach((b) => { base[b] = snap(b); });
}

async function pull({ replace = false } = {}) {
  if (!getTeamKey()) return { changed: 0 };
  const rows = await api(`?select=bucket,data,updated_at&team_id=eq.${encodeURIComponent(getTeamKey())}`, { method: 'GET' });
  let changed = 0;

  applyingRemote = true;
  try {
    mutate((s) => {
      for (const row of rows) {
        const b = row.bucket;
        if (!BUCKETS[b]) continue;
        const remoteStr = JSON.stringify(row.data);
        const localStr = snap(b);
        if (remoteStr === localStr) { base[b] = remoteStr; continue; }

        if (replace || localStr === base[b]) {
          // no local edits since last sync (or joining) — adopt remote wholly
          setVal(s, b, row.data);
          base[b] = remoteStr;
          changed++;
          continue;
        }
        // both sides changed since last sync
        if (BUCKETS[b].mode === 'union') {
          const baseObj = base[b] ? JSON.parse(base[b]) : {};
          const localObj = getVal(s, b) || {};
          const merged = { ...(row.data || {}) };
          for (const k of Object.keys(localObj)) {
            const changedLocally = JSON.stringify(localObj[k]) !== JSON.stringify(baseObj[k]);
            if (changedLocally || !(k in merged)) merged[k] = localObj[k];
          }
          setVal(s, b, merged);
          base[b] = remoteStr; // remote as baseline; our overlay stays dirty and pushes next
          changed++;
        }
        // lww conflict: keep local (it's dirty and will push over remote momentarily)
      }
    });
  } finally { applyingRemote = false; }
  return { changed, rows: rows.length };
}

async function cycle(opts = {}) {
  if (status.busy || !getTeamKey()) return;
  status.busy = true; announce();
  try {
    await pull(opts);
    await push();
    status.lastSync = Date.now();
    status.error = '';
  } catch (err) {
    status.error = /Failed to fetch|network/i.test(String(err)) ? 'offline' : String(err.message || err);
  } finally {
    status.busy = false; announce();
  }
}

function schedulePush() {
  if (!getTeamKey() || applyingRemote) return;
  clearTimeout(pushTimer);
  pushTimer = setTimeout(() => cycle(), 1200);
}

/* ---------- public API ---------- */
export function initSync() {
  subscribe(() => schedulePush());
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') cycle();
  });
  if (getTeamKey()) {
    cycle();
    pollTimer = setInterval(() => cycle(), 45000);
  }
}

/** Start a NEW team: this phone's data becomes the shared starting point. */
export async function createTeamSync() {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  const key = 'mav-' + [...bytes].map((x) => x.toString(36).padStart(2, '0')).join('').slice(0, 28);
  setTeamKey(key);
  base = {}; // everything dirty -> full push
  try {
    await push();
    status.lastSync = Date.now(); status.error = '';
    if (!pollTimer) pollTimer = setInterval(() => cycle(), 45000);
    announce();
    return key;
  } catch (err) {
    setTeamKey('');
    throw err;
  }
}

/** Join an EXISTING team: adopt the team's data (replaces shared data on this phone). */
export async function joinTeamSync(key) {
  const prev = getTeamKey();
  setTeamKey(key.trim());
  base = {};
  try {
    const { rows } = await pull({ replace: true });
    if (!rows) throw new Error('No team found for that key — check it and try again.');
    // identity re-pick: remote member ids differ from this phone's old seed
    applyingRemote = true;
    try { mutate((s) => { s.me = null; }); } finally { applyingRemote = false; }
    status.lastSync = Date.now(); status.error = '';
    if (!pollTimer) pollTimer = setInterval(() => cycle(), 45000);
    announce();
    return true;
  } catch (err) {
    setTeamKey(prev);
    throw err;
  }
}

export function leaveTeamSync() {
  setTeamKey('');
  clearInterval(pollTimer); pollTimer = null;
  base = {};
  status.error = ''; status.lastSync = 0;
  announce();
}

/** Manual "sync now" for the settings sheet. */
export const syncNow = () => cycle();
