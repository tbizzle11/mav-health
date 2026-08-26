/* ============================================================
   ai.js — food analysis via the Claude API.
   The API key lives ONLY on this device (separate localStorage
   key), never inside the synced/exported app state.
   ============================================================ */

const KEY_STORE = 'mavhealth.apikey';
const MODEL = 'claude-sonnet-5';
const API_URL = 'https://api.anthropic.com/v1/messages';

export const getApiKey = () => { try { return localStorage.getItem(KEY_STORE) || ''; } catch { return ''; } };
export const setApiKey = (k) => {
  try { k ? localStorage.setItem(KEY_STORE, k) : localStorage.removeItem(KEY_STORE); } catch {}
};

/* ---------- image prep ---------- */
/** Downscale + re-encode a photo File to JPEG. Returns {dataUrl, base64, thumb}. */
export function prepImage(file, maxDim = 1100) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      try {
        const scale = Math.min(1, maxDim / Math.max(img.naturalWidth, img.naturalHeight));
        const w = Math.max(1, Math.round(img.naturalWidth * scale));
        const h = Math.max(1, Math.round(img.naturalHeight * scale));
        const canvas = document.createElement('canvas');
        canvas.width = w; canvas.height = h;
        canvas.getContext('2d').drawImage(img, 0, 0, w, h);
        const dataUrl = canvas.toDataURL('image/jpeg', 0.8);

        // small thumbnail for the meal log (kept tiny so localStorage stays happy)
        const ts = Math.min(1, 140 / Math.max(w, h));
        const tc = document.createElement('canvas');
        tc.width = Math.max(1, Math.round(w * ts));
        tc.height = Math.max(1, Math.round(h * ts));
        tc.getContext('2d').drawImage(img, 0, 0, tc.width, tc.height);
        let thumb = tc.toDataURL('image/jpeg', 0.6);
        if (thumb.length > 24000) thumb = null;

        resolve({ dataUrl, base64: dataUrl.split(',')[1], thumb });
      } catch (err) { reject(new AiError('image', 'Couldn’t process that image.')); }
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new AiError('image', 'Couldn’t read that image format on this device.'));
    };
    img.src = url;
  });
}

/* ---------- errors ---------- */
export class AiError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}

/* ---------- prompt ---------- */
const JSON_SHAPE = `{"items":[{"name":"item name","portion":"portion estimate","calories":0,"protein":0,"confidence":"high","assumed":""}],"notes":"one short sentence about overall confidence or assumptions"}`;

const RULES = `Rules:
- calories and protein are integers for the whole visible portion
- confidence is "low" when you are partly guessing (hidden ingredients, unclear portion, mixed dish); ALWAYS include uncertain items with a conservative estimate rather than omitting them, and put the key assumption in that item's "assumed" (a few words)
- if the photo shows a nutrition label or packaged food, read the printed values; portion = the label's serving size; assume exactly 1 serving and mention the package's total servings in notes
- combine identical items into one entry with the combined portion
- realistic estimates; count cooking fats and dressings you can reasonably infer`;

function buildPromptParts({ context = '', frequentFoods = [] } = {}) {
  let extra = '';
  if (context.trim()) extra += `\nThe person eating adds this context — trust it over the photo: "${context.trim()}"\n`;
  if (frequentFoods.length) extra += `\nFoods this person logs often — prefer these names and typical portions when the food plausibly matches: ${frequentFoods.join(', ')}\n`;
  return extra;
}

/* ---------- transport ---------- */
async function callClaude(content, { onText = null } = {}) {
  const key = getApiKey();
  if (!key) throw new AiError('no-key', 'No API key set on this device.');

  let res;
  try {
    res = await fetch(API_URL, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': key,
        'anthropic-version': '2023-06-01',
        'anthropic-dangerous-direct-browser-access': 'true',
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 1500,
        stream: true,
        messages: [{ role: 'user', content }],
      }),
    });
  } catch {
    throw new AiError('network', 'Couldn’t reach the AI — check your connection.');
  }

  if (!res.ok) {
    let detail = '';
    try { detail = (await res.json())?.error?.message || ''; } catch {}
    if (res.status === 401 || res.status === 403) throw new AiError('bad-key', 'That API key was rejected — check it in the Team tab.');
    if (res.status === 429) throw new AiError('rate', 'Rate limited — wait a moment and try again.');
    if (res.status === 529) throw new AiError('api', 'The AI is overloaded right now — try again shortly.');
    throw new AiError('api', detail || `AI request failed (${res.status}).`);
  }

  const ctype = res.headers.get('content-type') || '';
  if (ctype.includes('text/event-stream') && res.body) return readSse(res, onText);

  // non-stream fallback (also what test mocks return)
  try {
    const body = await res.json();
    const text = (body.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('');
    if (onText) onText(text);
    return text;
  } catch {
    throw new AiError('parse', 'Unexpected response from the AI.');
  }
}

async function readSse(res, onText) {
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '', full = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    const lines = buf.split('\n');
    buf = lines.pop();
    for (const line of lines) {
      if (!line.startsWith('data:')) continue;
      const payload = line.slice(5).trim();
      if (!payload) continue;
      let ev;
      try { ev = JSON.parse(payload); } catch { continue; }
      if (ev.type === 'content_block_delta' && ev.delta?.type === 'text_delta') {
        full += ev.delta.text;
        if (onText) onText(full);
      } else if (ev.type === 'error') {
        throw new AiError('api', ev.error?.message || 'The AI stream failed.');
      }
    }
  }
  return full;
}

/* Extract complete item objects from a partial JSON stream — item objects are
   flat, so a brace-balanced match is safe. Used to render rows as they arrive. */
export function partialItems(text) {
  const out = [];
  for (const m of String(text).match(/\{[^{}]*"name"[^{}]*\}/g) || []) {
    try {
      const it = normalizeItem(JSON.parse(m));
      if (it.name) out.push(it);
    } catch { /* not complete yet */ }
  }
  return out;
}

/* ---------- analysis calls ---------- */

/** Analyze a food photo. opts: {context, frequentFoods, onItems(items[])}. */
export async function analyzeFoodPhoto(base64Jpeg, opts = {}) {
  const text = `Analyze this photo of food. Identify each distinct food and drink item you can see, and estimate its portion size, calories, and protein in grams.
${buildPromptParts(opts)}
Reply with ONLY this JSON — no markdown, no code fences, no other text:
${JSON_SHAPE}
${RULES}
- if the photo contains no food or drink, return {"items":[],"notes":"say what you see instead"}`;

  const raw = await callClaude([
    { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: base64Jpeg } },
    { type: 'text', text },
  ], { onText: opts.onItems ? (t) => opts.onItems(partialItems(t)) : null });
  return parseResult(raw);
}

/** Text-only estimate — "describe it instead". Same schema, same review UI. */
export async function analyzeFoodText(description, opts = {}) {
  const text = `Estimate nutrition for this meal, described by the person who ate it: "${description.trim()}"
${buildPromptParts(opts)}
Reply with ONLY this JSON — no markdown, no code fences, no other text:
${JSON_SHAPE}
${RULES}
- if the description isn't food, return {"items":[],"notes":"why"}`;

  const raw = await callClaude([{ type: 'text', text }],
    { onText: opts.onItems ? (t) => opts.onItems(partialItems(t)) : null });
  return parseResult(raw);
}

/** Sibling-safe re-analysis: correct ONLY what the note refers to.
    base64Jpeg may be null (text-described meals). */
export async function fixResults(base64Jpeg, currentItems, note) {
  const items = currentItems.map((it) => ({
    name: it.name, portion: it.portion || '', calories: it.calories, protein: it.protein,
  }));
  const text = `${base64Jpeg ? 'Here is a photo of a meal and the current itemized nutrition estimate for it.' : 'Here is the current itemized nutrition estimate for a meal.'}
Current items:
${JSON.stringify(items)}
The person eating says: "${note.trim()}"
Return the corrected FULL items array in this exact JSON shape:
${JSON_SHAPE}
Correction rules:
- change ONLY the items the person's note refers to — update, remove, or add items as the note implies
- every other item MUST be copied verbatim with identical name, portion, calories and protein
${RULES}`;

  const content = base64Jpeg
    ? [{ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: base64Jpeg } }, { type: 'text', text }]
    : [{ type: 'text', text }];
  return parseResult(await callClaude(content));
}

/* ---------- parsing ---------- */
export function normalizeItem(it) {
  return {
    name: String(it.name || '').trim(),
    portion: String(it.portion || '').trim(),
    calories: Math.max(0, Math.round(Number(it.calories) || 0)),
    protein: Math.max(0, Math.round(Number(it.protein) || 0)),
    confidence: it.confidence === 'low' ? 'low' : 'high',
    assumed: String(it.assumed || '').trim(),
  };
}

/** Tolerant JSON extraction — survives stray prose or code fences. */
export function parseResult(text) {
  const cleaned = String(text).replace(/```(?:json)?/gi, '');
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start < 0 || end <= start) throw new AiError('parse', 'The AI reply wasn’t in the expected format.');
  let obj;
  try { obj = JSON.parse(cleaned.slice(start, end + 1)); }
  catch { throw new AiError('parse', 'The AI reply wasn’t valid JSON.'); }

  const items = Array.isArray(obj.items) ? obj.items : [];
  return {
    items: items.map(normalizeItem).filter((it) => it.name),
    notes: String(obj.notes || '').trim(),
  };
}
