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
import { storageHealth, flushState, markThumbsRecovered, restoreThumbQuarantine } from './storage.js';

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
/* base = a small FINGERPRINT per bucket as of the last successful sync,
   PERSISTED so an app relaunch doesn't mistake untouched local data for fresh
   edits and clobber newer remote data (the stale-overwrite bug).

   This used to hold a full JSON copy of every bucket, which meant localStorage
   carried the entire app state TWICE. That doubled footprint is half of what
   pushed Safari past its ~5 MB cap and made saves start failing silently.
   Hashes are a few hundred bytes and answer the only two questions the merge
   asks: "did this bucket change?" and, for union buckets, "which keys?" */
const BASE_STORE = 'mavhealth.syncbase';
const BASE_V = 2;

/* FNV-1a run twice with different mixes — collision odds are nil at this scale */
function hash(str) {
  let a = 0x811c9dc5, b = 0x9e3779b9;
  for (let i = 0; i < str.length; i++) {
    const c = str.charCodeAt(i);
    a = Math.imul(a ^ c, 0x01000193);
    b = Math.imul(b ^ c, 0x85ebca6b);
  }
  return (a >>> 0).toString(36) + '-' + (b >>> 0).toString(36);
}
const hashOf = (v) => hash(JSON.stringify(v ?? null));

/** Whole-bucket hash, plus per-key hashes for union buckets so the merge can
    still tell which individual entries this phone touched. */
function fingerprint(bucket, val) {
  const fp = { h: hashOf(val) };
  if (BUCKETS[bucket].mode === 'union') {
    fp.k = {};
    for (const k of Object.keys(val || {})) fp.k[k] = hashOf(val[k]);
  }
  return fp;
}

function loadBase() {
  let raw;
  try { raw = JSON.parse(localStorage.getItem(BASE_STORE) || 'null'); } catch { return {}; }
  if (!raw || typeof raw !== 'object') return {};
  if (raw.v === BASE_V) return raw.b || {};
  // migrate the old full-copy format in place, so upgrading doesn't read as
  // "no baseline" and adopt the server's copy over this phone's edits
  const out = {};
  for (const [b, str] of Object.entries(raw)) {
    if (!BUCKETS[b] || typeof str !== 'string') continue;
    try { out[b] = fingerprint(b, JSON.parse(str)); } catch {}
  }
  return out;
}

let base = loadBase();
const saveBase = () => {
  try { localStorage.setItem(BASE_STORE, JSON.stringify({ v: BASE_V, b: base })); } catch {}
};
let applyingRemote = false;
let pushTimer = null;
let pollTimer = null;

const valOf = (b) => getVal(getState(), b) ?? null;
const fpNow = (b) => fingerprint(b, valOf(b));

function dirtyBuckets() {
  const h = storageHealth();
  return Object.keys(BUCKETS).filter((b) => {
    // photo-bearing buckets are withheld while this phone booted from a
    // thumb-stripped cache and hasn't recovered the durable copy — pushing
    // them would spread thumbless entries over teammates' intact ones
    if (h.strippedUnrecovered && (b === 'mealExtras' || b === 'recentMeals')) return false;
    return !base[b] || fpNow(b).h !== base[b].h;
  });
}

/** Is the CURRENT state provably held by a store? (Not a stale health sample:
    when localStorage isn't holding it, this awaits the actual IndexedDB write.) */
async function stateHeld() {
  const h = storageHealth();
  if (h.local === 'ok' || h.local === 'trimmed') return true;
  return (await flushState()) === true;
}

async function push({ keepalive = false } = {}) {
  if (!getTeamKey()) return;
  const dirty = dirtyBuckets();
  if (!dirty.length) return;
  const team = getTeamKey();
  // Fingerprint BEFORE the await: an edit made while the request is in flight
  // must stay dirty, or it gets marked synced without ever having been sent.
  const sent = dirty.map((b) => ({ b, fp: fpNow(b) }));
  const rows = dirty.map((b) => ({
    team_id: team, bucket: b,
    data: valOf(b),
    updated_at: new Date().toISOString(),
    device: `${deviceId()}@b${window.__mavBuild || 0}`,
  }));
  const opts = {
    method: 'POST',
    headers: { Prefer: 'resolution=merge-duplicates' },
    body: JSON.stringify(rows),
  };
  try {
    await api('', keepalive ? { ...opts, keepalive: true } : opts);
  } catch (err) {
    // keepalive caps the body at ~64KB — retry without it (photo thumbs etc.)
    if (!keepalive) throw err;
    await api('', opts);
  }
  // Only advance the baseline when the state itself is CONFIRMED held: base is
  // a tiny write that fits quota when the multi-MB state does not, and a
  // baseline ahead of the state resurrects the stale-overwrite bug on boot.
  // stateHeld() awaits the actual IndexedDB write in the quota-tight regime —
  // a point-in-time health sample was provably stale here.
  if (await stateHeld()) {
    sent.forEach(({ b, fp }) => { base[b] = fp; });
    saveBase();
  }
}

async function pull({ replace = false } = {}) {
  if (!getTeamKey()) return { changed: 0 };
  const rows = await api(`?select=bucket,data,updated_at&team_id=eq.${encodeURIComponent(getTeamKey())}`, { method: 'GET' });
  let changed = 0;

  const stripped = storageHealth().strippedUnrecovered;
  const sawPhotoBucket = { mealExtras: false, recentMeals: false };

  applyingRemote = true;
  try {
    mutate((s) => {
      for (const row of rows) {
        const b = row.bucket;
        if (!BUCKETS[b]) continue;
        const remoteFp = fingerprint(b, row.data ?? null);
        const localFp = fpNow(b);

        // stripped-cache quarantine: this phone's photo entries are thumbless
        // copies — the server's versions win per-entry, and only genuinely NEW
        // local entries (absent remotely) survive the merge
        if (stripped && (b === 'mealExtras' || b === 'recentMeals')) {
          sawPhotoBucket[b] = true;
          setVal(s, b, preferRemotePhotos(b, row.data, getVal(s, b)));
          base[b] = remoteFp; // additions stay dirty and push once the quarantine lifts
          changed++;
          continue;
        }
        if (remoteFp.h === localFp.h) { base[b] = remoteFp; continue; }

        const noLocalEdits = !!base[b] && localFp.h === base[b].h;
        // no baseline = we cannot prove local edits, so the server is the
        // source of truth for BOTH modes. (Union used to treat every local key
        // as "locally changed" here, which pushed stale copies of teammates'
        // entries over their newer ones — the clobber bug reborn.)
        if (replace || noLocalEdits || !base[b]) {
          // adopt remote wholly when: joining, no local edits since last sync,
          // or we have no baseline to prove local edits (fresh boot after
          // upgrade) — the server is the source of truth in that case
          setVal(s, b, row.data);
          base[b] = remoteFp;
          changed++;
          continue;
        }
        // both sides changed since last sync
        if (BUCKETS[b].mode === 'union') {
          const baseKeys = (base[b] && base[b].k) || {};
          const localObj = getVal(s, b) || {};
          const merged = { ...(row.data || {}) };
          for (const k of Object.keys(localObj)) {
            const changedLocally = hashOf(localObj[k]) !== baseKeys[k];
            if (changedLocally || !(k in merged)) merged[k] = localObj[k];
          }
          setVal(s, b, merged);
          base[b] = remoteFp; // remote as baseline; our overlay stays dirty and pushes next
          changed++;
        }
        // lww conflict: keep local (it's dirty and will push over remote momentarily)
      }
    });
  } finally { applyingRemote = false; }
  // the quarantine lifts when every photo bucket was either merged from the
  // server OR simply has no server row (nothing to recover from) — without
  // the absent-row case, a team created after a stripped boot would withhold
  // new scans forever (its initial push omitted the photo buckets).
  // salvageTried is REQUIRED: lifting before the definitive local read would
  // un-gate the flush retry and let it overwrite still-recoverable thumbs.
  const rowSet = new Set(rows.map((r) => r.bucket));
  if (stripped && storageHealth().salvageTried &&
      ['mealExtras', 'recentMeals'].every((b) => sawPhotoBucket[b] || !rowSet.has(b))) {
    markThumbsRecovered();
  }
  if (await stateHeld()) saveBase(); // never record "synced" for state we couldn't keep
  return { changed, rows: rows.length };
}

/** Remote photo entries win by id; local entries that don't exist remotely
    (new scans made during the quarantine) are kept. */
function preferRemotePhotos(bucket, remote, local) {
  if (bucket === 'recentMeals') {
    const merged = Array.isArray(remote) ? [...remote] : [];
    const have = new Set(merged.map((r) => r && r.id));
    (Array.isArray(local) ? local : []).forEach((r) => { if (r && !have.has(r.id)) merged.push(r); });
    return merged;
  }
  const merged = {};
  Object.entries(remote || {}).forEach(([k, v]) => { merged[k] = Array.isArray(v) ? [...v] : v; });
  Object.entries(local || {}).forEach(([k, list]) => {
    if (!Array.isArray(list)) return;
    const cur = Array.isArray(merged[k]) ? merged[k] : (merged[k] = []);
    const have = new Set(cur.map((x) => x && x.id));
    list.forEach((x) => { if (x && !have.has(x.id)) cur.push(x); });
  });
  return merged;
}

async function cycle(opts = {}) {
  if (status.busy || !getTeamKey()) return;
  status.busy = true; announce();
  try {
    await pull(opts);
    await push({ keepalive: !!opts.keepalive });
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
  // when storage recovers, persist the baseline that was withheld while the
  // state itself couldn't be kept — closes the state-ahead-of-base window
  window.addEventListener('mav:storage', (e) => {
    if (e.detail && e.detail.durable && getTeamKey()) { try { saveBase(); } catch {} }
  });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') cycle();
    else if (getTeamKey() && !status.busy) {
      // app going to background — flush pending edits NOW so a close/kill
      // can't strand them un-synced (they're always safe locally regardless).
      // Full cycle, not a bare push: pushing a union bucket without pulling
      // first would wholesale-replace teammates' entries added since the last
      // poll. The busy guard keeps this from racing a mid-flight cycle.
      clearTimeout(pushTimer);
      cycle({ keepalive: true });
    }
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

/** Join an EXISTING team: adopt the team's shared data, but CARRY OVER this
    phone's personal data — logs are re-keyed to the matching team member by
    name and merged, and locally-created events come along. Nothing logged
    before joining is thrown away. */
export async function joinTeamSync(key) {
  const prev = getTeamKey();
  const localBefore = JSON.parse(JSON.stringify(getState()));
  const baseBefore = { ...base };
  const strippedBefore = storageHealth().strippedUnrecovered;
  setTeamKey(key.trim());
  base = {};
  try {
    const { rows } = await pull({ replace: true });
    if (!rows) throw new Error('No team found for that key — check it and try again.');

    applyingRemote = true;
    try {
      mutate((s) => {
        // map this phone's old member ids -> team member ids by name
        const nameToNew = {};
        s.members.forEach((m) => { nameToNew[m.name.trim().toLowerCase()] = m.id; });
        const oldToNew = {};
        (localBefore.members || []).forEach((m) => {
          const nid = nameToNew[m.name.trim().toLowerCase()];
          if (nid) oldToNew[m.id] = nid;
        });
        const remapKey = (k) => {
          const i = k.lastIndexOf('|');
          if (i < 0) return k;
          const nid = oldToNew[k.slice(i + 1)];
          return nid ? k.slice(0, i + 1) + nid : k;
        };

        // personal logs: remap + merge (team data wins on exact conflicts)
        ['mealLog', 'workoutLog', 'water', 'checklistLog', 'wins', 'mealExtras'].forEach((b) => {
          Object.entries(localBefore[b] || {}).forEach(([k, v]) => {
            const nk = remapKey(k);
            const cur = s[b][nk];
            if (cur === undefined) s[b][nk] = v;
            else if (Array.isArray(v) && Array.isArray(cur)) {
              v.forEach((x) => { if (!cur.some((y) => y.id === x.id)) cur.push(x); });
            } else if (v && cur && typeof v === 'object' && typeof cur === 'object') {
              s[b][nk] = { ...v, ...cur };
            }
          });
        });

        // events created on this phone come along (skip dupes of team events)
        const dupe = (ev) => s.events.some((t) =>
          t.id === ev.id || (t.title === ev.title && t.date === ev.date && t.start === ev.start));
        (localBefore.events || []).forEach((ev) => {
          if (ev.feedId || dupe(ev)) return;
          const members = ev.members.map((id) => oldToNew[id] || id)
            .filter((id) => s.members.some((m) => m.id === id));
          s.events.push({ ...ev, members: members.length ? members : s.members.map((m) => m.id) });
        });
        // (meal/workout PLANS deliberately start from the team's truth)

        s.me = null; // re-pick identity against the team's member list
      });
    } finally { applyingRemote = false; }

    await push(); // send the merged result up so the team sees it too
    status.lastSync = Date.now(); status.error = '';
    if (!pollTimer) pollTimer = setInterval(() => cycle(), 45000);
    announce();
    return true;
  } catch (err) {
    // full rollback: by the time a late failure lands, pull(replace) may have
    // already overwritten and PERSISTED the other team's data — restoring only
    // the team key would leave the phone half-joined to a team it can't reach
    setTeamKey(prev);
    base = baseBefore;
    saveBase();
    // the aborted join's pull may have lifted the thumb quarantine off the
    // TARGET team's rows — the original team's recovery never happened
    if (strippedBefore && !storageHealth().strippedUnrecovered) restoreThumbQuarantine();
    applyingRemote = true;
    try {
      mutate((s) => {
        Object.keys(s).forEach((k) => { delete s[k]; });
        Object.assign(s, JSON.parse(JSON.stringify(localBefore)));
      });
    } finally { applyingRemote = false; }
    throw err;
  }
}

export function leaveTeamSync() {
  setTeamKey('');
  clearInterval(pollTimer); pollTimer = null;
  base = {};
  try { localStorage.removeItem(BASE_STORE); } catch {}
  status.error = ''; status.lastSync = 0;
  announce();
}

/** Manual "sync now" for the settings sheet. */
export const syncNow = () => cycle();
