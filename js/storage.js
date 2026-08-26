/* ============================================================
   storage.js — durable persistence for the app state.

   localStorage alone was the bug: Safari caps it near 5 MB, the
   base64 photo thumbnails live inside the state blob, and once
   the cap was hit every save failed SILENTLY — the app still
   said "Logged ✓" while nothing reached the disk, so closing the
   app threw the whole session away.

   Now IndexedDB (hundreds of MB) is the source of truth and
   localStorage is a best-effort fast cache. Every save is
   verified; if both stores fail the app says so out loud
   instead of pretending it saved.
   ============================================================ */

const LS_KEY   = 'mavhealth.v1';
const DB_NAME  = 'mavhealth';
const DB_STORE = 'kv';
const DB_KEY   = 'state';

const OPEN_TIMEOUT = 4000;   // iOS occasionally never settles indexedDB.open
const IDB_DEBOUNCE = 400;    // coalesce bursts of edits into one write

/* ---------- health ---------- */
const health = {
  idb: 'unknown',     // ok | fail
  idbWriteOk: false,  // the LAST write attempt succeeded (reads prove nothing)
  local: 'unknown',   // ok | trimmed | full | fail
  strippedUnrecovered: false, // booted from a thumb-stripped cache, durable copy not yet read
  salvageTried: false,        // the definitive pre-put durable read has completed
  durable: true,      // false once BOTH stores fail — nothing is saving
  thumbsAtRisk: false,// cache is thumb-stripped AND IndexedDB is down — photos only in memory
  lastSaveAt: 0,
  lastError: '',
  trimmedThumbs: 0,   // thumbnails left out of the localStorage cache (still in IndexedDB)
  persisted: null,    // navigator.storage.persist() result
  usage: 0,
  quota: 0,
  localBytes: 0,
  source: '',         // where boot loaded from
};

export const storageHealth = () => ({ ...health });

const announce = () => {
  try { window.dispatchEvent(new CustomEvent('mav:storage', { detail: { ...health } })); } catch {}
};

let lastDurable = true;
function setDurable(ok, err = '') {
  health.durable = ok;
  if (err) health.lastError = err;
  if (ok !== lastDurable) { lastDurable = ok; announce(); }
}

/** Single source of truth for "is anything actually holding our data". */
function recomputeDurable(err = '') {
  const lsHolding = health.local === 'ok' || health.local === 'trimmed';
  const idbOk = health.idb === 'ok';
  health.thumbsAtRisk = health.local === 'trimmed' && !idbOk;
  setDurable(idbOk || lsHolding, err);
}

/* ---------- IndexedDB ---------- */
let dbPromise = null;

function openDb() {
  if (dbPromise) return dbPromise;
  let self_p = null;
  self_p = new Promise((resolve) => {
    let settled = false;
    const finish = (v) => {
      if (settled) return;
      settled = true;
      // a failed open must NOT poison the session — clear the memo so the next
      // idbGet/idbPut retries (iOS open stalls are transient; one 4s timeout
      // used to disable IndexedDB until the app was relaunched)
      if (!v && dbPromise === self_p) dbPromise = null;
      resolve(v);
    };
    setTimeout(() => finish(null), OPEN_TIMEOUT);
    try {
      if (!self.indexedDB) return finish(null);
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(DB_STORE)) db.createObjectStore(DB_STORE);
      };
      req.onsuccess = () => {
        // open succeeded AFTER the timeout already gave up: close the orphan
        // connection instead of leaking it, and let the next call re-open fast
        if (settled) { try { req.result.close(); } catch {} }
        else finish(req.result);
      };
      req.onerror   = () => finish(null);
      req.onblocked = () => finish(null);
    } catch { finish(null); }
  });
  dbPromise = self_p;
  return self_p;
}

function idbGet(key) {
  return openDb().then((db) => {
    if (!db) throw new Error('IndexedDB unavailable');
    return new Promise((resolve, reject) => {
      try {
        const tx = db.transaction(DB_STORE, 'readonly');
        const req = tx.objectStore(DB_STORE).get(key);
        req.onsuccess = () => resolve(req.result ?? null);
        req.onerror   = () => reject(req.error || new Error('read failed'));
      } catch (err) { reject(err); }
    });
  });
}

function idbPut(key, val) {
  return openDb().then((db) => {
    if (!db) throw new Error('IndexedDB unavailable');
    return new Promise((resolve, reject) => {
      try {
        const tx = db.transaction(DB_STORE, 'readwrite');
        tx.objectStore(DB_STORE).put(val, key);
        tx.oncomplete = () => resolve(true);
        tx.onerror    = () => reject(tx.error || new Error('write failed'));
        tx.onabort    = () => reject(tx.error || new Error('write aborted'));
      } catch (err) { reject(err); }
    });
  });
}

/* ---------- localStorage cache ----------
   The cache is best-effort. When the blob will not fit we leave photo
   thumbnails out of the COPY we write — never out of the live state, so a
   momentary squeeze can't delete the team's photos (the old code did exactly
   that, then synced the deletion to everyone else). IndexedDB always keeps
   the full-fidelity version. */

function thumbHolders(state) {
  const out = [];
  Object.values(state.mealExtras || {}).forEach((list) => {
    if (Array.isArray(list)) list.forEach((x) => { if (x && x.thumb) out.push(x); });
  });
  return out;
}
const recentHolders = (state) => (state.recentMeals || []).filter((r) => r && r.thumb);

/** Serialize with thumbnails temporarily detached, then put them straight
    back. JS is single-threaded, so nothing can observe the gap. */
function stringifyWithout(state, holders) {
  const saved = holders.map((h) => h.thumb);
  holders.forEach((h) => { h.thumb = null; });
  try { return JSON.stringify(state); }
  finally { holders.forEach((h, i) => { h.thumb = saved[i]; }); }
}

const TRIM_FLAG = 'mavhealth.cachetrim'; // "the cached copy is thumb-stripped"

function writeLocal(state, json) {
  const attempt = (str) => {
    try { localStorage.setItem(LS_KEY, str); return true; }
    catch (err) { health.lastError = String((err && err.message) || err); return false; }
  };

  if (attempt(json)) {
    health.local = 'ok';
    health.trimmedThumbs = 0;
    // Only clear the stripped marker when this state actually CONTAINS its
    // thumbs. While strippedUnrecovered, the live state is itself thumbless —
    // it fits localStorage "fully", but clearing the marker here made the next
    // boot adopt the thumbless cache as full fidelity (round-2 finding).
    try {
      if (health.strippedUnrecovered) localStorage.setItem(TRIM_FLAG, '1');
      else localStorage.removeItem(TRIM_FLAG);
    } catch {}
    return true;
  }

  // too big — shed photo thumbnails from the cache copy, recents first.
  // The marker records that this cached copy is incomplete, so a future boot
  // that can only read the cache knows not to treat it as full fidelity.
  const markTrim = () => { try { localStorage.setItem(TRIM_FLAG, '1'); } catch {} };
  const recents = recentHolders(state);
  if (recents.length && attempt(stringifyWithout(state, recents))) {
    health.local = 'trimmed';
    health.trimmedThumbs = recents.length;
    markTrim();
    return true;
  }

  const all = [...recents, ...thumbHolders(state)];
  if (all.length && attempt(stringifyWithout(state, all))) {
    health.local = 'trimmed';
    health.trimmedThumbs = all.length;
    markTrim();
    return true;
  }

  health.local = 'full';
  return false;
}

/* ---------- writes ---------- */
let idbTimer = null;
let idbRetryTimer = null;
let pendingJson = null;
let idbInFlight = null;
let flushSeq = 0;          // monotonic: which flush consumed the newest payload
let liveStateRef = null;   // the object loadState handed to the app (for thumb salvage)
let salvageTried = false;  // one completed pre-put IDB read is definitive for the session:
                           // any record read after our own put may be our thumbless write-back

function flushIdb() {
  clearTimeout(idbTimer); idbTimer = null;
  const json = pendingJson;
  if (json == null) return idbInFlight || Promise.resolve(true);
  pendingJson = null;
  const mySeq = ++flushSeq;

  // Strictly serialize puts: overlapping transactions made failure ordering
  // ambiguous — a stale rejected payload could re-queue over a newer success.
  const prev = idbInFlight ? idbInFlight.catch(() => {}) : Promise.resolve();
  idbInFlight = prev
    .then(async () => {
      // If we booted from a thumb-stripped cache and haven't salvaged the
      // durable copy yet, do it NOW — writing the stripped state over the
      // full-fidelity record is how the team's photos die. Only the FIRST
      // completed read counts: after we've put anything, a read-back may be
      // our own thumbless state masquerading as a recovery source.
      if (health.strippedUnrecovered && liveStateRef && !salvageTried) {
        try {
          const raw = await idbGet(DB_KEY);
          salvageTried = true; health.salvageTried = true;
          const dur = raw ? (typeof raw === 'string' ? JSON.parse(raw) : raw) : null;
          if (dur) rehydrateThumbs(liveStateRef, dur);
          // With a team configured, ONLY the server merge (markThumbsRecovered)
          // may lift the quarantine — a local record can be stale. With no
          // team, this read was the last possible source either way.
          if (!teamConfigured()) health.strippedUnrecovered = false;
        } catch { /* durable copy still unreadable — flag stays, retry next flush */ }
      }
      // NEVER put while quarantined without the definitive read: a transient
      // stall can fail the read yet let the put succeed (openDb retries), and
      // that put would overwrite the sole full-fidelity record — the round-4
      // self-poisoning hole. Abort into the retry path instead.
      if (health.strippedUnrecovered && !salvageTried) {
        throw new Error('salvage pending — durable record protected');
      }
      // Serialize FRESH from the live state at write time (the queued snapshot
      // may predate a rehydration — round-2's stale-snapshot hole). State only
      // moves forward, so writing the freshest version never loses anything.
      const out = liveStateRef ? JSON.stringify(liveStateRef) : json;
      return idbPut(DB_KEY, out);
    })
    .then(() => {
      health.idb = 'ok';
      health.idbWriteOk = true;
      health.lastSaveAt = Date.now();
      recomputeDurable();
      return true;
    })
    .catch((err) => {
      health.idb = 'fail';
      health.idbWriteOk = false; // a failure DIS-proves writability until the next success
      // Re-queue for retry — but only if no newer flush has started since this
      // payload was consumed, so a stale payload can never overwrite or block
      // a newer one.
      if (pendingJson == null && mySeq === flushSeq) {
        pendingJson = json;
        clearTimeout(idbRetryTimer);
        idbRetryTimer = setTimeout(flushIdb, 3000);
      }
      recomputeDurable(String((err && err.message) || err));
      return false;
    });
  return idbInFlight;
}

/**
 * Persist the state. Returns true only when a store has PROVABLY accepted a
 * write — localStorage synchronously, or IndexedDB proven writable earlier
 * this session. A boot-time read never counts as proof (it says nothing about
 * write quota), so a first-save-while-full can briefly report false and the
 * red bar self-clears when the IndexedDB write lands moments later.
 */
export function saveState(state) {
  liveStateRef = state;                 // flushIdb serializes fresh from here
  const json = JSON.stringify(state);   // one serialization feeds both stores
  const lsOk = writeLocal(state, json);

  pendingJson = json;
  if (lsOk) {
    health.lastSaveAt = Date.now();
    if (!idbTimer) idbTimer = setTimeout(flushIdb, IDB_DEBOUNCE);
    recomputeDurable();
  } else {
    flushIdb();
  }
  return lsOk || health.idbWriteOk;
}

/** Force any queued write out — call before the app can be killed. */
export const flushState = () => flushIdb();

/* ---------- boot ---------- */
export async function loadState() {
  let local = null;
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (raw) local = JSON.parse(raw);
    health.local = 'ok';
  } catch (err) {
    health.local = 'fail';
    health.lastError = String((err && err.message) || err);
  }

  let durable = null;
  try {
    const raw = await idbGet(DB_KEY);
    if (raw) durable = typeof raw === 'string' ? JSON.parse(raw) : raw;
    health.idb = 'ok';
  } catch (err) {
    health.idb = 'fail';
    health.lastError = String((err && err.message) || err);
  }
  if (health.idb !== 'ok' && health.local !== 'ok') setDurable(false);

  // IndexedDB is full fidelity, so it wins ties — the localStorage copy may be
  // the same state minus thumbnails that didn't fit.
  let state = null, source = 'new';
  if (durable && local) {
    const pickDurable = (durable.updatedAt || 0) >= (local.updatedAt || 0);
    state = pickDurable ? durable : local;
    source = pickDurable ? 'indexeddb' : 'localstorage';
    // A strictly-newer cache copy can be thumb-stripped. Rehydrate photos from
    // the durable copy BEFORE this state gets re-persisted — otherwise the
    // stripped version overwrites IndexedDB and the deletion syncs to the team.
    if (!pickDurable) rehydrateThumbs(state, durable);
  } else if (durable) { state = durable; source = 'indexeddb'; }
  else if (local) {
    state = local; source = 'localstorage';
    // The durable read failed AND the cache copy is marked thumb-stripped:
    // don't treat it as full fidelity. One more read attempt (openDb retries
    // now); if that also fails, flag it — flushIdb salvages thumbs from the
    // durable copy before its first write, and sync withholds photo buckets
    // until then.
    let trimmed = false;
    try { trimmed = localStorage.getItem(TRIM_FLAG) === '1'; } catch {}
    if (trimmed) {
      health.strippedUnrecovered = true;
      try {
        const raw = await idbGet(DB_KEY);
        salvageTried = true; health.salvageTried = true; // boot read precedes any put — definitive
        const dur = raw ? (typeof raw === 'string' ? JSON.parse(raw) : raw) : null;
        if (dur) { rehydrateThumbs(state, dur); health.idb = 'ok'; }
        // team configured -> only the server merge lifts the quarantine
        // (a local record can be stale); no team -> nothing else can hold
        // thumbs, so this read settles it either way
        if (!teamConfigured()) health.strippedUnrecovered = false;
      } catch { /* IDB still down — flushIdb retries the salvage */ }
      health.thumbsAtRisk = health.strippedUnrecovered;
    }
  }

  health.source = source;
  liveStateRef = state;
  return { state, source };
}

/** Copy photo thumbnails by entry id from `from` into `into` where missing. */
function rehydrateThumbs(into, from) {
  const thumbs = {};
  Object.values(from.mealExtras || {}).forEach((list) => {
    if (Array.isArray(list)) list.forEach((x) => { if (x && x.id && x.thumb) thumbs[x.id] = x.thumb; });
  });
  (from.recentMeals || []).forEach((r) => { if (r && r.id && r.thumb) thumbs[r.id] = r.thumb; });
  let restored = 0;
  Object.values(into.mealExtras || {}).forEach((list) => {
    if (Array.isArray(list)) list.forEach((x) => { if (x && x.id && !x.thumb && thumbs[x.id]) { x.thumb = thumbs[x.id]; restored++; } });
  });
  (into.recentMeals || []).forEach((r) => { if (r && r.id && !r.thumb && thumbs[r.id]) { r.thumb = thumbs[r.id]; restored++; } });
  return restored;
}

const teamConfigured = () => { try { return !!localStorage.getItem('mavhealth.teamkey'); } catch { return false; } };

/** Sync recovered the photo buckets from the team server — the stripped-cache
    quarantine can lift. */
export function markThumbsRecovered() {
  health.strippedUnrecovered = false;
  recomputeDurable();
}

/** Re-arm the quarantine (join rollback: a pull for the WRONG team may have
    lifted it — the original team's recovery hasn't happened). */
export function restoreThumbQuarantine() {
  health.strippedUnrecovered = true;
  health.thumbsAtRisk = true;
  try { localStorage.setItem(TRIM_FLAG, '1'); } catch {}
  announce();
}

/** Ask the browser not to evict us when the device gets tight on space. */
export async function initStorage() {
  try {
    if (navigator.storage && navigator.storage.persist) {
      health.persisted = navigator.storage.persisted ? await navigator.storage.persisted() : false;
      if (!health.persisted) health.persisted = await navigator.storage.persist();
    }
  } catch { health.persisted = null; }
  await refreshEstimate();
  announce();
}

export async function refreshEstimate() {
  try {
    const est = navigator.storage && navigator.storage.estimate ? await navigator.storage.estimate() : null;
    if (est) { health.usage = est.usage || 0; health.quota = est.quota || 0; }
  } catch {}
  try { health.localBytes = (localStorage.getItem(LS_KEY) || '').length * 2; } catch {}
  return { ...health };
}

/** Settings' "test a save" — proves a write survives a full round trip. */
export async function verifySave() {
  const probe = { t: Date.now(), n: Math.random() };
  let lsOk = false, idbOk = false;
  try {
    localStorage.setItem('mavhealth.probe', JSON.stringify(probe));
    lsOk = JSON.parse(localStorage.getItem('mavhealth.probe')).n === probe.n;
  } catch {}
  try { localStorage.removeItem('mavhealth.probe'); } catch {}
  try {
    await idbPut('probe', probe);
    const back = await idbGet('probe');
    idbOk = !!back && back.n === probe.n;
  } catch {}
  await refreshEstimate();
  return { lsOk, idbOk, ...health };
}
