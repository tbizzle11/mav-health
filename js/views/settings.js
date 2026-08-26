/* Settings — device-level preferences behind the ⚙️ in the top bar:
   appearance (auto/light/dark), who owns this phone, the AI key, backups.
   All of it is per-device, none of it enters the synced app state. */
import { getState, mutate, memberById, initialsOf } from '../store.js';
import { $, $$, esc, openSheet, closeSheet, confirmSheet, toast } from '../ui.js';
import { getApiKey, setApiKey } from '../ai.js';
import { getTeamKey, syncStatus, createTeamSync, joinTeamSync, leaveTeamSync, syncNow } from '../sync.js';
import { storageHealth, refreshEstimate, verifySave } from '../storage.js';

const THEME_KEY = 'mavhealth.theme';

export const getTheme = () => {
  try { return localStorage.getItem(THEME_KEY) || 'auto'; } catch { return 'auto'; }
};

export function applyTheme(t = getTheme()) {
  const root = document.documentElement;
  if (t === 'light' || t === 'dark') root.dataset.theme = t;
  else delete root.dataset.theme;
  // keep the iOS status bar / chrome color in step
  document.querySelectorAll('meta[name="theme-color"]').forEach((m) => {
    if (t === 'light') m.content = '#f4f5f9';
    else if (t === 'dark') m.content = '#0a0c13';
    else m.content = (m.media || '').includes('dark') ? '#0a0c13' : '#f4f5f9';
  });
}

export function setTheme(t) {
  try { t === 'auto' ? localStorage.removeItem(THEME_KEY) : localStorage.setItem(THEME_KEY, t); } catch {}
  applyTheme(t);
}

/* ---------- storage health ----------
   The original build kept everything in one localStorage blob with the photo
   thumbnails inside it, so a phone could quietly cross Safari's ~5 MB cap and
   stop saving with no warning at all. These rows exist so that is never again
   invisible from the phone it is happening on. */
const fmtBytes = (n) => {
  if (!n) return '0 KB';
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1048576).toFixed(1)} MB`;
  return `${(n / 1073741824).toFixed(1)} GB`;
};
const agoText = (t) => {
  if (!t) return 'not yet';
  const s = Math.round((Date.now() - t) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  return `${Math.round(s / 3600)} h ago`;
};

function storageRowsHtml() {
  const h = storageHealth();
  const row = (label, value, tone = '') =>
    `<div class="row-between" style="padding:3px 0">
       <span class="small muted">${label}</span>
       <span class="small strong num"${tone ? ` style="color:var(--${tone})"` : ''}>${esc(value)}</span>
     </div>`;

  const saving = h.durable !== false;
  const parts = [
    saving
      ? row('Saving', '✓ working', 'green')
      : row('Saving', '⚠️ FAILING', 'red'),
    row('Permanent store', h.idb === 'fail' ? 'unavailable' : 'IndexedDB ✓', h.idb === 'fail' ? 'red' : ''),
    row('Quick cache', {
      ok: 'localStorage ✓', trimmed: `full — photos in IndexedDB`,
      full: 'full', fail: 'blocked',
    }[h.local] || '—', (h.local === 'fail' || h.local === 'full') ? 'amber' : ''),
    row('Last saved', agoText(h.lastSaveAt)),
  ];
  if (h.quota) parts.push(row('Used', `${fmtBytes(h.usage)} of ${fmtBytes(h.quota)}`));
  parts.push(row('Eviction-protected', h.persisted === true ? 'yes' : h.persisted === false ? 'no' : 'unknown',
    h.persisted === false ? 'amber' : ''));

  let note = '';
  if (!saving) {
    note = `<div class="banner banner-red" style="margin-top:10px">
      <b>Nothing is saving on this phone.</b><br>
      Anything you add now disappears when the app closes. Most likely this phone is out of
      space or is in a Private tab. Free up space, or export a backup before closing.
      ${h.lastError ? `<br><span class="tiny dim">${esc(h.lastError)}</span>` : ''}
    </div>`;
  } else if (h.thumbsAtRisk) {
    note = `<div class="banner banner-red" style="margin-top:10px">
      <b>Photos are at risk on this phone.</b><br>
      Storage is tight and the permanent store isn't answering, so new photo
      thumbnails only exist in memory until it recovers. Everything else is saved.
    </div>`;
  } else if (h.local === 'trimmed' || h.local === 'full') {
    note = `<div class="banner banner-amber" style="margin-top:10px">
      The quick cache is full, so photo thumbnails load from the permanent store instead.
      Everything is still saved — nothing is lost.
    </div>`;
  }
  return parts.join('') + note;
}

export function openSettingsSheet() {
  const s = getState();
  const meId = s.me;

  openSheet({
    title: 'Settings',
    body: `
      <div class="field">
        <label class="label">Appearance</label>
        <div class="seg" id="setTheme">
          ${[['auto', '🌗 Auto'], ['light', '☀️ Light'], ['dark', '🌙 Dark']].map(([v, l]) => `
            <button class="seg-item ${getTheme() === v ? 'is-on' : ''}" data-theme-opt="${v}">${l}</button>`).join('')}
        </div>
        <p class="tiny dim" style="margin-top:6px">Auto follows your phone's light/dark setting.</p>
      </div>

      <div class="field">
        <label class="label">Team sync</label>
        <div id="setSyncWrap">
          ${getTeamKey() ? `
            <div class="row-between" style="margin-bottom:10px">
              <span class="small strong" style="color:var(--green)" id="syncState">✓ Syncing with the team</span>
              <button class="btn btn-sm" id="syncNowBtn">Sync now</button>
            </div>
            <button class="btn btn-block" id="syncCopyKey" style="margin-bottom:8px">📋 Copy team key (share with the guys)</button>
            <button class="btn btn-danger btn-block" id="syncLeave">Turn off sync on this phone</button>` : `
            <p class="tiny dim" style="margin-bottom:10px">Share calendars, plans and the scoreboard across all three phones. One person creates the team; the others join with the key.</p>
            <button class="btn btn-primary btn-block" id="syncCreate" style="margin-bottom:8px">🚀 Create team sync (start from this phone's data)</button>
            <div class="row gap-8">
              <input class="input grow" id="syncJoinKey" placeholder="mav-… team key" autocomplete="off" />
              <button class="btn btn-sm" id="syncJoin" style="flex:none">Join</button>
            </div>`}
        </div>
      </div>

      <div class="field">
        <label class="label">This phone belongs to</label>
        <div class="picker" id="setWho">
          ${s.members.map((m) => `
            <button class="picker-opt ${m.id === meId ? 'is-on' : ''}" data-iam="${m.id}">${esc(m.name)}</button>`).join('')}
        </div>
        <p class="tiny dim" style="margin-top:6px">Today, Meals and Train default to this person.</p>
      </div>

      <div class="field">
        <label class="label">AI food scanning</label>
        <div id="setAiWrap">
          ${getApiKey() ? `
            <div class="row-between">
              <span class="small strong" style="color:var(--green)">✓ Key saved on this device</span>
              <button class="btn btn-sm btn-danger" id="setKeyClear">Remove</button>
            </div>` : `
            <div class="row gap-8">
              <input class="input grow" id="setKeyInput" type="password" placeholder="sk-ant-…" autocomplete="off" />
              <button class="btn btn-sm btn-primary" id="setKeySave" style="flex:none">Save</button>
            </div>
            <p class="tiny dim" style="margin-top:6px">From console.anthropic.com → API Keys. Stored only on this device — never in backups or shared data.</p>`}
        </div>
      </div>

      <div class="field">
        <label class="label">Storage health</label>
        <div id="setStorage">${storageRowsHtml()}</div>
        <button class="btn btn-sm btn-block" id="setStorageTest" style="margin-top:8px">Test a save now</button>
      </div>

      <div class="field">
        <label class="label">Data</label>
        <div class="col gap-8">
          <button class="btn btn-block" id="setExport">⬇️ Export backup (JSON)</button>
          <button class="btn btn-block" id="setImport">⬆️ Import backup</button>
          <input type="file" id="setImportFile" accept="application/json" hidden />
        </div>
      </div>

      <p class="tiny dim center" style="margin-top:6px">MAV Health · build ${window.__mavBuild || '?'} · data lives on this device</p>`,
    onSave: null,
    setup: (root) => {
      $$('#setTheme .seg-item', root).forEach((b) => b.addEventListener('click', () => {
        setTheme(b.dataset.themeOpt);
        $$('#setTheme .seg-item', root).forEach((x) => x.classList.toggle('is-on', x === b));
      }));

      /* team sync */
      $('#syncCreate', root)?.addEventListener('click', async () => {
        const btn = $('#syncCreate', root);
        btn.disabled = true; btn.textContent = 'Creating…';
        try {
          const key = await createTeamSync();
          try { await navigator.clipboard.writeText(key); } catch {}
          toast('Team sync is live — key copied 📋');
          closeSheet(); openSettingsSheet();
        } catch (err) {
          btn.disabled = false; btn.textContent = '🚀 Create team sync (start from this phone\'s data)';
          toast('Couldn’t reach the sync server — try again');
        }
      });
      $('#syncJoin', root)?.addEventListener('click', async () => {
        const key = $('#syncJoinKey', root).value.trim();
        if (!key.startsWith('mav-')) { toast('Paste the team key (starts with mav-)'); return; }
        const btn = $('#syncJoin', root);
        btn.disabled = true; btn.textContent = '…';
        try {
          await joinTeamSync(key);
          toast('Joined! Pick who you are 👇');
          location.reload(); // fresh boot: team data + identity picker
        } catch (err) {
          btn.disabled = false; btn.textContent = 'Join';
          toast(err.message || 'Join failed');
        }
      });
      $('#syncCopyKey', root)?.addEventListener('click', async () => {
        try { await navigator.clipboard.writeText(getTeamKey()); toast('Team key copied 📋'); }
        catch { toast(`Key: ${getTeamKey()}`); }
      });
      $('#syncNowBtn', root)?.addEventListener('click', async () => {
        await syncNow();
        const s2 = syncStatus();
        toast(s2.error ? `Sync problem: ${s2.error}` : 'Synced ✓');
      });
      $('#syncLeave', root)?.addEventListener('click', () => {
        closeSheet();
        confirmSheet('Turn off sync', 'This phone keeps its data but stops sharing with the team. Rejoin any time with the key.', () => {
          leaveTeamSync();
          toast('Sync off on this phone');
        }, 'Turn off');
      });

      $$('#setWho [data-iam]', root).forEach((b) => b.addEventListener('click', () => {
        mutate((st) => { st.me = b.dataset.iam; });
        $$('#setWho [data-iam]', root).forEach((x) => x.classList.toggle('is-on', x === b));
        toast(`Hi, ${memberById(b.dataset.iam)?.name}!`);
      }));

      $('#setKeySave', root)?.addEventListener('click', () => {
        const k = $('#setKeyInput', root).value.trim();
        if (!k) { toast('Paste your API key first'); return; }
        if (!k.startsWith('sk-ant-')) { toast('That doesn’t look like a Claude API key (sk-ant-…)'); return; }
        setApiKey(k);
        toast('Key saved — scanning is ready 📷');
        closeSheet(); openSettingsSheet();
      });
      $('#setKeyClear', root)?.addEventListener('click', () => {
        setApiKey('');
        toast('Key removed from this device');
        closeSheet(); openSettingsSheet();
      });

      /* storage health */
      refreshEstimate().then(() => {
        const box = $('#setStorage', root);
        if (box) box.innerHTML = storageRowsHtml();
      });
      $('#setStorageTest', root)?.addEventListener('click', async () => {
        const btn = $('#setStorageTest', root);
        btn.disabled = true; btn.textContent = 'Testing…';
        const r = await verifySave();
        const box = $('#setStorage', root);
        if (box) box.innerHTML = storageRowsHtml();
        btn.disabled = false; btn.textContent = 'Test a save now';
        toast(r.idbOk || r.lsOk
          ? 'Saves are working on this phone ✓'
          : 'This phone is NOT saving — export a backup now');
      });

      $('#setExport', root).addEventListener('click', () => {
        const blob = new Blob([JSON.stringify(getState(), null, 2)], { type: 'application/json' });
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = `mav-health-backup-${new Date().toISOString().slice(0, 10)}.json`;
        a.click();
        URL.revokeObjectURL(a.href);
        toast('Backup downloaded');
      });

      const fileInput = $('#setImportFile', root);
      $('#setImport', root).addEventListener('click', () => fileInput.click());
      fileInput.addEventListener('change', () => {
        const f = fileInput.files[0];
        if (!f) return;
        f.text().then((txt) => {
          try {
            const data = JSON.parse(txt);
            if (!data.members?.length) throw new Error('bad file');
            closeSheet();
            confirmSheet('Import backup', 'Replace everything on this device with the backup?', () => {
              mutate((s2) => Object.assign(s2, data));
              toast('Backup imported');
            }, 'Import');
          } catch { toast('That file doesn’t look like a MAV backup'); }
        });
        fileInput.value = '';
      });
    },
  });
}
