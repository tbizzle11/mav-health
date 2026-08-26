/* Scan — MacroFactor-style food logging:
   photo (or text description, or one-tap recent) → streaming AI estimate →
   itemized editable review (steppers, chips, confidence, fix-with-a-note) → log.
   Crash-safe: state is stashed in sessionStorage so an iOS camera round-trip
   that reloads the PWA can resume where it left off. */
import {
  mutate, me, memberById, logKey, todayStr, fmtShort, uid, MEAL_SLOTS,
  recentMealsFor, pushRecentMeal, frequentFoods,
} from '../store.js';
import { $, $$, esc, openSheet, closeSheet, sheetGen, toast } from '../ui.js';
import { prepImage, analyzeFoodPhoto, analyzeFoodText, fixResults, getApiKey } from '../ai.js';

const STASH_KEY = 'mavhealth.pendingScan';
const STASH_MAX_AGE = 45 * 60 * 1000;

/* one-tap chips for what cameras systematically miss */
const HIDDEN_CHIPS = [
  { name: 'Cooking oil', cal: 120, protein: 0 },
  { name: 'Butter',      cal: 100, protein: 0 },
  { name: 'Dressing',    cal: 150, protein: 1 },
  { name: 'Sauce',       cal: 80,  protein: 1 },
  { name: 'Drink',       cal: 150, protein: 0 },
];

function defaultSlot(dateStr) {
  if (dateStr !== todayStr()) return 'Lunch';
  const h = new Date().getHours() + new Date().getMinutes() / 60;
  if (h < 10.5) return 'Breakfast';
  if (h < 15)   return 'Lunch';
  if (h < 20.5) return 'Dinner';
  return 'Snack';
}

export function peekPendingScan() {
  try {
    const raw = sessionStorage.getItem(STASH_KEY);
    if (!raw) return null;
    const p = JSON.parse(raw);
    if ((!p.img && !p.result && !p.describeText) || Date.now() - p.ts > STASH_MAX_AGE) {
      sessionStorage.removeItem(STASH_KEY); return null;
    }
    return p;
  } catch { return null; }
}
const clearStash = () => { try { sessionStorage.removeItem(STASH_KEY); } catch {} };

/* review-shape an AI item: keep a baseline so the portion stepper rescales
   without compounding rounding */
const reviewItem = (it) => ({
  ...it, baseCal: it.calories, basePro: it.protein, mult: 1, touched: false,
});

export function openScanSheet(targetDate = todayStr(), targetMemberId = null, restore = null) {
  const member = memberById(targetMemberId) || me();
  let mode = restore?.mode || 'capture';        // capture | describe
  let img = restore?.img || null;               // {dataUrl, base64, thumb}
  let result = restore?.result || null;         // {items(review-shaped), notes}
  let context = restore?.context || '';         // "anything the camera can't see"
  let describeText = restore?.describeText || '';
  let recentThumb = restore?.recentThumb || null;
  let slot = restore?.slot || defaultSlot(targetDate);
  let busy = false, fixBusy = false;
  let discardArmedAt = 0;

  if (img && !img.base64 && img.dataUrl) img.base64 = img.dataUrl.split(',')[1];

  const isToday = targetDate === todayStr();
  const forSelf = member.id === me().id;
  const dateLabel = (forSelf ? '' : `${member.name} · `) + (isToday ? 'today' : fmtShort(targetDate));

  const stash = () => {
    try {
      sessionStorage.setItem(STASH_KEY, JSON.stringify({
        v: 2, ts: Date.now(), targetDate, member: member.id, mode, slot, context,
        describeText, recentThumb,
        img: img ? { dataUrl: img.dataUrl, thumb: img.thumb } : null,
        result,
      }));
    } catch { /* storage full — resume just won't work */ }
  };

  const enterReview = (r, opts = {}) => {
    result = { notes: r.notes || '', items: r.items.map(reviewItem) };
    if (opts.flashAll) result.items.forEach((it) => { it.flash = true; });
    stash();
  };

  /* sync in-progress DOM edits into result.items so re-renders never revert
     what the user typed; manual edits re-baseline the row (stepper back to ×1) */
  const syncEdits = () => {
    if (!result) return;
    $$('#scanItems [data-item]').forEach((row) => {
      const it = result.items[Number(row.dataset.item)];
      if (!it) return;
      const name = $('[data-f="name"]', row).value;
      const cal = Math.max(0, Number($('[data-f="cal"]', row).value) || 0);
      const pro = Math.max(0, Number($('[data-f="pro"]', row).value) || 0);
      if (name !== it.name) { it.name = name; it.touched = true; }
      if (cal !== it.calories || pro !== it.protein) {
        it.calories = cal; it.protein = pro;
        it.baseCal = cal; it.basePro = pro; it.mult = 1;
        it.touched = true;
      }
    });
  };

  const myGen = sheetGen() + 1; // openSheet below bumps to exactly this
  const stale = () => sheetGen() !== myGen;

  const render = () => {
    if (stale()) return;
    const root = $('#sheetBody');

    /* ---------- no key ---------- */
    if (!getApiKey() && !result) {
      const recents = recentMealsFor(member.id);
      root.innerHTML = `
        <div class="empty" style="padding-top:8px"><span class="empty-ico">📷</span>
          Food scanning uses AI vision, which needs an API key on this phone (one-time setup, takes a minute).</div>
        <button class="btn btn-primary btn-block" id="scanGoTeam">Set it up in the Team tab</button>
        ${recents.length ? `
          <div class="section-head"><h2>Or log a recent meal</h2></div>
          <div class="recents-strip">${recentsHtml(recents)}</div>` : ''}`;
      $('#scanGoTeam', root).addEventListener('click', () => { closeSheet(); location.hash = '#/team'; });
      wireRecents(root);
      return;
    }

    /* ---------- review ---------- */
    if (result) { renderReview(root); return; }

    /* ---------- analyzing ---------- */
    if (busy) {
      root.innerHTML = `
        ${img ? `<img src="${img.dataUrl}" alt="" style="width:100%;max-height:220px;object-fit:cover;border-radius:var(--r-lg);display:block;margin-bottom:12px" />` : ''}
        <p class="small dim center" style="margin-bottom:12px">✨ Reading ${img ? 'your plate' : 'your description'} — items appear as they're found…</p>
        <div id="liveItems"></div>
        <div class="skel"></div><div class="skel" style="opacity:.6"></div>`;
      return;
    }

    /* ---------- describe mode ---------- */
    if (mode === 'describe') {
      root.innerHTML = `
        <p class="small muted" style="margin-bottom:12px">Describe what you ate (the 🎤 mic on your keyboard works great). Logs to <b>${esc(dateLabel)}</b>.</p>
        <textarea class="textarea" id="descText" rows="3"
          placeholder="e.g. chipotle bowl with double chicken, no rice, extra guac">${esc(describeText)}</textarea>
        <button class="btn btn-primary btn-block" id="descGo" style="margin-top:12px">✨ Estimate it</button>
        <button class="btn btn-quiet btn-block" id="descBack" style="margin-top:8px">← Back to camera</button>`;
      const ta = $('#descText', root);
      ta.addEventListener('change', () => { describeText = ta.value; stash(); });
      $('#descBack', root).addEventListener('click', () => { mode = 'capture'; describeText = ta.value; stash(); render(); });
      $('#descGo', root).addEventListener('click', () => {
        describeText = ta.value.trim();
        if (!describeText) { toast('Describe the meal first'); return; }
        stash();
        runAnalysis(() => analyzeFoodText(describeText, aiOpts()));
      });
      return;
    }

    /* ---------- capture ---------- */
    const recents = recentMealsFor(member.id);
    if (!img) {
      root.innerHTML = `
        <p class="small muted" style="margin-bottom:12px">Snap your plate and the AI estimates each item. Logs to <b>${esc(dateLabel)}</b>.</p>
        ${recents.length ? `
          <div class="recents-strip" style="margin-bottom:12px">${recentsHtml(recents)}</div>` : ''}
        <div class="col gap-8">
          <button class="btn btn-primary btn-block" id="scanCam">📷 Take photo</button>
          <button class="btn btn-block" id="scanLib">🖼️ Choose from library</button>
          <button class="btn btn-quiet btn-block" id="scanDescribe">💬 No photo? Describe it</button>
        </div>
        <div class="field" style="margin-top:14px;margin-bottom:0">
          <label class="label" for="scanContext">Anything the camera can't see? <span class="dim" style="text-transform:none;letter-spacing:0">(optional)</span></label>
          <input class="input" id="scanContext" placeholder="e.g. only ate half · cooked in oil · protein shake with water"
            value="${esc(context)}" />
        </div>
        <input type="file" accept="image/*" capture="environment" id="scanCamInput" hidden />
        <input type="file" accept="image/*" id="scanLibInput" hidden />`;
      wireRecents(root);
      const cam = $('#scanCamInput', root), lib = $('#scanLibInput', root);
      const ctxInput = $('#scanContext', root);
      ctxInput.addEventListener('change', () => { context = ctxInput.value; stash(); });
      $('#scanCam', root).addEventListener('click', () => { context = ctxInput.value; stash(); cam.click(); });
      $('#scanLib', root).addEventListener('click', () => { context = ctxInput.value; stash(); lib.click(); });
      $('#scanDescribe', root).addEventListener('click', () => { mode = 'describe'; context = ctxInput.value; stash(); render(); });
      const onPick = async (input) => {
        const f = input.files[0];
        if (!f) return;
        try {
          const prepped = await prepImage(f);
          if (stale()) return;
          img = prepped; stash(); render();
        } catch (err) { toast(err.message || 'Couldn’t read that image'); }
      };
      cam.addEventListener('change', () => onPick(cam));
      lib.addEventListener('change', () => onPick(lib));
      return;
    }

    /* ---------- photo preview ---------- */
    root.innerHTML = `
      <img src="${img.dataUrl}" alt="Your food photo" style="width:100%;max-height:300px;object-fit:cover;border-radius:var(--r-lg);display:block" />
      ${context ? `<p class="tiny dim" style="margin:8px 2px 0">📝 ${esc(context)}</p>` : ''}
      <div class="col gap-8" style="margin-top:14px">
        <button class="btn btn-primary btn-block" id="scanGo">✨ Analyze photo</button>
        <button class="btn btn-quiet btn-block" id="scanRetake">Retake</button>
      </div>`;
    $('#scanRetake', root).addEventListener('click', () => { img = null; result = null; stash(); render(); });
    $('#scanGo', root).addEventListener('click', () =>
      runAnalysis(() => analyzeFoodPhoto(img.base64, aiOpts())));
  };

  /* ---------- helpers ---------- */
  const aiOpts = () => ({
    context,
    frequentFoods: frequentFoods(member.id),
    onItems: (items) => {
      if (stale() || !busy) return;
      const live = $('#liveItems');
      if (!live) return;
      live.innerHTML = items.map((it) => `
        <div class="card card-pad" style="margin-bottom:10px">
          <div class="row-between">
            <span class="strong small">${esc(it.name)}</span>
            <span class="small dim num">${it.calories} cal · ${it.protein}g</span>
          </div>
        </div>`).join('');
    },
  });

  const runAnalysis = async (call) => {
    busy = true; render();
    try {
      const r = await call();
      busy = false;
      if (stale()) return;
      if (!r.items.length) {
        toast(r.notes || 'No food detected — try again or describe it');
        render();
      } else {
        enterReview(r);
        render();
      }
    } catch (err) {
      busy = false;
      if (stale()) return;
      render();
      toast(err.message || 'Analysis failed');
      if (err.code === 'no-key' || err.code === 'bad-key') { clearStash(); closeSheet(); location.hash = '#/team'; }
    }
  };

  const recentsHtml = (recents) => recents.map((r) => `
    <button class="recent-card" data-recent="${r.id}">
      ${r.thumb ? `<img src="${r.thumb}" alt="" />` : `<span class="rc-ph">🍽️</span>`}
      <span class="rc-name">${esc(r.label)}</span>
      <span class="rc-cal">${r.items.reduce((s, x) => s + x.calories, 0)} cal · log again</span>
    </button>`).join('');

  const wireRecents = (root) => {
    $$('[data-recent]', root).forEach((b) => b.addEventListener('click', () => {
      const r = recentMealsFor(member.id, 20).find((x) => x.id === b.dataset.recent);
      if (!r) return;
      recentThumb = r.thumb || null;
      img = null; mode = 'capture';
      enterReview({ items: r.items.map((x) => ({ confidence: 'high', assumed: '', portion: '', ...x })), notes: 'From your recent meals — adjust if needed.' });
      render();
    }));
  };

  /* ---------- review screen ---------- */
  function renderReview(root) {
    const itemRow = (it, i) => `
      <div class="card card-pad ${it.flash ? 'flash' : ''}" data-item="${i}" style="margin-bottom:10px">
        <div class="row gap-8">
          <input class="input grow" data-f="name" value="${esc(it.name)}" aria-label="Food name" />
          <button class="icon-btn" data-rm="${i}" aria-label="Remove" style="color:var(--red)">✕</button>
        </div>
        <div class="row-between" style="margin-top:6px">
          <span class="tiny dim">${esc(it.portion || 'portion')}${it.mult !== 1 ? ` × ${it.mult}` : ''}</span>
          <span class="stepper">
            <button data-step="-1" data-i="${i}" aria-label="Smaller portion">−</button>
            <span class="stepper-x">×${it.mult}</span>
            <button data-step="1" data-i="${i}" aria-label="Bigger portion">+</button>
          </span>
        </div>
        ${it.confidence === 'low' ? `<div class="conf-low" style="margin-top:5px">Best guess${it.assumed ? ` — ${esc(it.assumed)}` : ''}</div>` : ''}
        <div class="field-row" style="margin-top:8px">
          <div><label class="label">Calories</label>
            <input class="input" data-f="cal" type="number" inputmode="numeric" value="${it.calories}" /></div>
          <div><label class="label">Protein (g)</label>
            <input class="input" data-f="pro" type="number" inputmode="numeric" value="${it.protein}" /></div>
        </div>
      </div>`;

    const headThumb = img?.dataUrl || recentThumb;
    root.innerHTML = `
      <div id="scanRoot">
        <div class="row gap-12" style="margin-bottom:12px">
          ${headThumb ? `<img src="${headThumb}" alt="" style="width:56px;height:56px;object-fit:cover;border-radius:12px;flex:none" />` : ''}
          <div class="col gap-4 grow">
            <span class="strong">Check before logging</span>
            ${result.notes ? `<span class="tiny dim">${esc(result.notes)}</span>` : ''}
          </div>
        </div>
        <div id="scanItems">${result.items.map(itemRow).join('')}</div>
        <div class="ingredient-chips">
          ${HIDDEN_CHIPS.map((c, i) => `<button class="chip" data-chip="${i}">+ ${c.name} ~${c.cal}</button>`).join('')}
          <button class="chip" id="scanAddItem">+ Other item</button>
        </div>
        ${(img || describeText) ? `
        <div class="field" style="margin-bottom:14px">
          <label class="label" for="fixNote">Something wrong? Tell the AI</label>
          <div class="row gap-8">
            <input class="input grow" id="fixNote" placeholder="e.g. that's turkey not beef · half portion of rice" />
            <button class="btn btn-sm btn-primary" id="fixGo" style="flex:none" ${fixBusy ? 'disabled' : ''}>${fixBusy ? '…' : 'Fix'}</button>
          </div>
        </div>` : ''}
        <div class="field">
          <label class="label">Meal slot</label>
          <div class="seg" id="scanSlot">
            ${MEAL_SLOTS.map((sl) => `<button class="seg-item ${slot === sl ? 'is-on' : ''}" data-slot="${sl}">${sl}</button>`).join('')}
          </div>
        </div>
        <div class="row-between" style="margin:4px 2px 12px">
          <span class="small strong">Total</span>
          <span class="small strong num" id="scanTotal"></span>
        </div>
        <button class="btn btn-success btn-block" id="scanSave"></button>
        <p class="tiny dim center" style="margin-top:10px">Estimates only — tweak anything that looks off.</p>
      </div>`;
    result.items.forEach((it) => { delete it.flash; });

    const readItems = () => $$('#scanItems [data-item]', root).map((row) => ({
      name: $('[data-f="name"]', row).value.trim(),
      cal: Math.max(0, Number($('[data-f="cal"]', row).value) || 0),
      protein: Math.max(0, Number($('[data-f="pro"]', row).value) || 0),
    })).filter((it) => it.name);

    const refreshTotals = () => {
      const items = readItems();
      const cal = items.reduce((s, it) => s + it.cal, 0);
      const pro = items.reduce((s, it) => s + it.protein, 0);
      $('#scanTotal', root).textContent = `${cal} cal · ${pro}g protein`;
      $('#scanSave', root).textContent = `Log ${items.length} item${items.length === 1 ? '' : 's'} to ${dateLabel}`;
      $('#scanSave', root).disabled = !items.length;
    };
    refreshTotals();

    // listeners live on #scanRoot, replaced by every re-render — nothing
    // leaks onto the persistent #sheetBody host
    const scanRoot = $('#scanRoot', root);
    scanRoot.addEventListener('input', refreshTotals);
    scanRoot.addEventListener('change', () => { syncEdits(); stash(); });

    $$('#scanItems [data-rm]', root).forEach((b) => b.addEventListener('click', () => {
      syncEdits();
      result.items.splice(Number(b.dataset.rm), 1);
      stash(); render();
    }));
    $$('[data-step]', root).forEach((b) => b.addEventListener('click', () => {
      syncEdits();
      const it = result.items[Number(b.dataset.i)];
      if (!it) return;
      const next = Math.min(4, Math.max(0.25, Math.round((it.mult + Number(b.dataset.step) * 0.25) * 100) / 100));
      it.mult = next;
      it.calories = Math.round(it.baseCal * next);
      it.protein = Math.round(it.basePro * next);
      it.touched = true;
      stash(); render();
    }));
    $$('[data-chip]', root).forEach((b) => b.addEventListener('click', () => {
      syncEdits();
      const c = HIDDEN_CHIPS[Number(b.dataset.chip)];
      result.items.push(reviewItem({ name: c.name, portion: 'estimate', calories: c.cal, protein: c.protein, confidence: 'low', assumed: 'typical amount' }));
      result.items[result.items.length - 1].touched = true;
      stash(); render();
    }));
    $('#scanAddItem', root).addEventListener('click', () => {
      syncEdits();
      result.items.push(reviewItem({ name: '', portion: '', calories: 0, protein: 0, confidence: 'high', assumed: '' }));
      stash(); render();
    });
    $$('#scanSlot .seg-item', root).forEach((b) => b.addEventListener('click', () => {
      slot = b.dataset.slot; stash();
      $$('#scanSlot .seg-item', root).forEach((x) => x.classList.toggle('is-on', x === b));
    }));

    const fixGo = $('#fixGo', root);
    if (fixGo) fixGo.addEventListener('click', async () => {
      const note = $('#fixNote', root).value.trim();
      if (!note) { toast('Tell the AI what to fix first'); return; }
      syncEdits();
      fixBusy = true; render();
      try {
        const fixed = await fixResults(img?.base64 || null,
          result.items.map((it) => ({ name: it.name, portion: it.portion, calories: it.calories, protein: it.protein })),
          note);
        fixBusy = false;
        if (stale()) return;
        applyFix(fixed, note);
        render();
        toast('Updated ✨');
      } catch (err) {
        fixBusy = false;
        if (stale()) return;
        render();
        toast(err.message || 'Fix failed — edit by hand instead');
      }
    });

    $('#scanSave', root).addEventListener('click', () => {
      const items = readItems();
      if (!items.length) { toast('Nothing to log'); return; }
      const key = logKey(targetDate, member.id);
      const thumb = img?.thumb || recentThumb || null;
      const label = items[0].name + (items.length > 1 ? ` +${items.length - 1}` : '');
      mutate((s) => {
        s.mealExtras[key] = s.mealExtras[key] || [];
        items.forEach((it, i) => s.mealExtras[key].push({
          id: uid(), slot, name: it.name, cal: it.cal, protein: it.protein,
          done: true, thumb: i === 0 ? thumb : null,
        }));
        pushRecentMeal(s, {
          id: uid(), member: member.id, label, thumb, ts: Date.now(),
          items: items.map((it) => ({ name: it.name, calories: it.cal, protein: it.protein })),
        });
      });
      clearStash();
      toast(`Logged ${items.length} item${items.length === 1 ? '' : 's'} 📷`);
      closeSheet();
    });
  }

  /* Sibling-safe merge of a fix: rows the user hand-edited keep their values
     unless the note actually refers to them; changed/new rows flash. */
  function applyFix(fixed, note) {
    const noteLower = note.toLowerCase();
    const noteRefs = (name) => name.toLowerCase().split(/\W+/)
      .some((w) => w.length >= 4 && noteLower.includes(w));
    const old = result.items;
    const merged = fixed.items.map((f) => {
      const o = old.find((x) => x.name.toLowerCase() === f.name.toLowerCase());
      if (o && o.touched && !noteRefs(o.name)) return o;
      const changed = !o || o.calories !== f.calories || o.protein !== f.protein || o.portion !== f.portion;
      const r = reviewItem(f);
      if (changed) r.flash = true;
      return r;
    });
    // defensive: restore untouched-by-the-note items the model dropped anyway
    old.forEach((o) => {
      if (!noteRefs(o.name) && o.name &&
          !merged.some((m) => m.name.toLowerCase() === o.name.toLowerCase())) merged.push(o);
    });
    result = { notes: fixed.notes || result.notes, items: merged };
    stash();
  }

  openSheet({
    title: 'Scan food',
    body: '',
    onSave: null,
    setup: render,
    onBeforeClose: () => {
      // photo taken / analysis paid for — require a second tap to discard
      if (!img && !result && !describeText.trim()) return true;
      if (Date.now() - discardArmedAt < 3000) { clearStash(); return true; }
      discardArmedAt = Date.now();
      toast('Scan in progress — tap again to discard');
      return false;
    },
  });

  if (restore) toast('Restored your scan 📷');
}
