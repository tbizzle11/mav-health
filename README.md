# MAV Health

Health scheduling app for the MAV team (Market Mavericks) — shared calendar,
personal meal plans, workout plans, and daily tracking. Built as an installable
PWA: no App Store, no build step, works offline.

## Run it locally

```
powershell -ExecutionPolicy Bypass -File tools\serve.ps1
```

Then open http://localhost:5173. (In Claude Code, the `mav-health` entry in
`.claude/launch.json` starts the same server.)

## Put it on an iPhone

The app must be reachable over **HTTPS** for iOS install + offline support.
Deploy the folder to any static host (Netlify / Cloudflare Pages / GitHub Pages),
open the URL in Safari, then **Share → Add to Home Screen**. It gets its own
icon, launches full-screen, and works offline.

## Food photo scanning

Point the camera at a plate (Today → 📷 Scan, or Meals → "Scan food with the
camera") and Claude vision estimates calories + protein per item, streaming
results in as they're found. The flow copies the best of the leading apps
(MacroFactor's review-first design, Cal AI's portion steppers — minus its
sibling-mangling fix bug):

- optional "anything the camera can't see?" context (halved portions, oil…)
- itemized, editable results; ×0.25-step portion steppers that rescale macros
- low-confidence items flagged with the AI's assumption, never silently dropped
- one-tap chips for hidden calories (oil, butter, dressing, sauce)
- "Something wrong? Tell the AI" — sibling-safe re-analysis (hand-edited rows
  are protected client-side unless the note names them)
- "Describe it instead" text fallback (keyboard mic = free voice input)
- recent meals strip — one-tap re-log, zero API cost, works offline
- nutrition-label photos are read verbatim (1 serving default)
- the member's frequently-logged foods bias recognition

Logged items land in that day's meals and count toward the rings.

Setup (once per phone): Team tab → **AI food scanning** → paste a Claude API key
from console.anthropic.com. The key is stored only on that device
(`mavhealth.apikey` in localStorage) — it is never included in the synced app
state or in Export backups. Photos are downscaled to ≤1100px JPEG before upload;
only a ~140px thumbnail is kept locally with the log entry.

## Profiles, plans & accountability

Each member runs a 6-step **profile wizard** (Today's banner, or Team → member →
Profile & plan): routines (wake/bed with live sleep math, busy blocks), daily
checklist (must / should / if-time), work & lifestyle goals, health numbers,
gym time + goal, and finally a **calorie plan** — maintenance via Mifflin-St
Jeor, then three paces (aggressive / good pace / easy) for cutting or bulking
with weekly rate and weeks-to-goal; picking one sets the calorie + protein
rings. Safety floors apply (1200/1500 kcal). Estimates, not medical advice.

Today then shows a **generated day plan** (wake → busy blocks → gym in a real
gap at your preferred time → must-dos → free time → wind-down), the
**daily checklist**, and **daily wins** (physical / mental / spiritual).
Team shows the **accountability board**: yesterday's must-do completion per
member — miss your musts and you're flagged as owing the team **stakes**
(editable line on the same card). Calendar's **"Find a time we can all meet"**
intersects everyone's calendars + busy hours over the next 7 days and turns a
tapped slot into a prefilled invite for the whole team.

## Calendar import

Calendar tab → **Import a calendar**. Takes an `.ics` file or a live link and
assigns the events to a member (their color/avatar on the shared calendar):

- **Google Calendar**: Settings → your calendar → *Integrate calendar* →
  "Secret address in iCal format" (link), or *Export* (file)
- **School portals** (Canvas etc.): look for "calendar feed" / "export"
- **Outlook**: Settings → Shared calendars → Publish → ICS link

The importer handles recurring events (weekly/daily/monthly, BYDAY, UNTIL,
COUNT, EXDATE), all-day events, UTC and wall-clock times, and auto-types events
(lecture→meeting, exam→deadline, gym→workout…). Recurrences are expanded ~6
months forward; re-importing or tapping Sync on a linked feed refreshes them.
Some feed servers block browser fetches (CORS) — the file route always works.

## Structure

```
index.html            app shell (topbar / tab bar / sheet host)
manifest.webmanifest  PWA manifest
sw.js                 service worker — network-first, offline fallback
css/app.css           design system (light + dark, iOS safe areas)
js/store.js           data layer: localStorage state + mutate/subscribe
js/ui.js              sheets, toasts, icons, rings, avatars
js/ai.js              Claude vision: image prep + food photo analysis
js/ics.js             iCalendar parser + recurrence expansion for imports
js/views/scan.js      scan sheet: photo -> estimates -> editable -> log
js/views/settings.js  device settings (⚙️): theme, phone owner, AI key, backups
js/main.js            router + chrome + first-run identity picker
js/views/today.js     daily dashboard: rings, schedule, meals, workout, water
js/views/calendar.js  shared month calendar + event sheet (recurrence, attendees)
js/views/meals.js     weekly meal plans per member, macro totals, copy-day
js/views/train.js     workout plans per member + live session check-off
js/views/team.js      members, goals, device identity, export/import backup
tools/serve.ps1       zero-dependency static server (PowerShell HttpListener)
tools/make-icons.ps1  regenerates app icons via System.Drawing
```

## Data

All state lives in `localStorage` under `mavhealth.v1` and flows through
`mutate()` in `js/store.js` — every mutation persists and re-renders the active
view. Cloud sync between phones (Supabase) plugs in at that single choke point;
until then, Team → Export/Import moves data between devices.
