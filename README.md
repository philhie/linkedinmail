# Kengo InMail Helper

Chrome extension that speeds up LinkedIn Recruiter InMail outreach by reading
pre-rendered messages from a Google Sheet, opening the LinkedIn profile, and
pre-filling the InMail composer (and follow-up). **By default you click Send
yourself**; an opt-in auto-mode (off by default) chains the full cycle —
click Send, verify success, mark sent, advance to the next person.

Goal: drop 20s/lead → ~5s/lead — and with auto-mode on, drop ~50min/day to
~5min/day for the same volume. Volume target: 100–500 InMails/day.

## What this extension does NOT do

- Does **not** auto-send by default. Auto-mode is off out of the box and
  requires explicit confirmation before it can be enabled.
- Does **not** scrape LinkedIn or call LinkedIn APIs.
- Does **not** run in the background. Only when the popup is open or a
  profile is being filled.
- Does **not** store LinkedIn credentials.

## Auto-mode (opt-in)

Auto-mode is a feature flag (default: **off**). When armed, a successful send
chains automatically into the next lead. Three modes:

- **Off** — default. Manual flow as today.
- **Dry-run** — runs the full pipeline (paste, verify composer state, locate
  Send button) but never clicks Send. Logs telemetry. Use this first to
  verify selectors against your Recruiter DOM.
- **On** — live. Clicks Send, handles confirmation modal, watches for success
  toast, marks sent, advances to next person, schedules next cycle on a
  jittered cooldown.

Safety surface (when `safetyMode` is on, default true):

- Log-normal jittered interval around `minIntervalSeconds` (σ=30%, clamped
  to [0.7×, 2.0×]) — breaks metronomic rhythm that LinkedIn flags.
- 8% chance of a 3–7min long pause between cycles.
- Hourly cap (default 30/hr).
- Daily cap = `dailyTarget`.
- Optional quiet hours (off by default).
- Hard-stop on negative toast classifier (rate-limit / spam / restriction).
- Hard-stop on auth challenge / checkpoint / captcha tab navigation.
- Hard-stop on consecutive errors hitting `errorBackoffThreshold`.
- Pre-send composer state re-verification (subject + body + follow-up).
- Send-button selector is composer-scoped + multi-criteria; refuses to
  click if multiple primary buttons match.
- Multi-signal success verification: positive toast OR composer-removed.

Toolbar badge reflects state: blank (off), `DRY` (dry-run), `N` (today's
sends in 'on' mode), `⏸` (paused/backoff), `✗` (last cycle errored).

## Status

- **Phase 1**: popup + Google Sheets read/write working end-to-end. ✅
- **Phase 2**: LinkedIn content script opens the composer and pre-fills text. ✅
  Selectors live at the top of `content/linkedin.js` — adjust them when
  LinkedIn rotates their DOM.

**Important — selector verification before first real use:** LinkedIn changes
DOM frequently and the selectors in `content/linkedin.js` are best-effort
defaults. Before sending real outreach, do a dry run with a throwaway test
contact. If the InMail composer doesn't open or text doesn't get inserted, open
DevTools on a Recruiter profile, find the actual aria-labels of the Message
button, composer modal, and message editor, and update the `SELECTORS` /
`LOCALE` blocks at the top of `content/linkedin.js`.

## Setup

### 1. Deploy the Apps Script proxy (one time, ~5 minutes)

The extension talks to your sheet via a tiny Google Apps Script you deploy
yourself. No Google Cloud Console, no OAuth client. The proxy enforces a shared
secret token so only your extension can read/write.

1. Open your **Outreach** Google Sheet.
2. **Extensions → Apps Script** (top menu).
3. Replace the default file with the contents of `apps-script/Code.gs` from this
   repo. Copy *everything*.
4. Replace `SECRET_TOKEN = 'REPLACE_ME_WITH_A_RANDOM_STRING'` at the top with a
   long random string. Keep this — you'll paste it into the extension settings.
   Suggestion: open any browser DevTools console and run `crypto.randomUUID()`.
5. Save (floppy-disk icon).
6. **Deploy → New deployment** (top right).
7. Click the gear ⚙ → **Web app**.
8. Settings:
   - Description: `Kengo InMail proxy`
   - Execute as: **Me**
   - Who has access: **Anyone** (the SECRET_TOKEN gates real access)
9. **Deploy**. Authorize when prompted (your script, your data).
10. Copy the **Web app URL**: `https://script.google.com/macros/s/AKfy.../exec`.

### 2. Load the extension

1. Open `chrome://extensions` in Chrome.
2. Toggle **Developer mode** (top right).
3. Click **Load unpacked** → select this folder (`tikal/`).
4. The Kengo "K" icon appears in your toolbar.

### 3. Configure the extension

1. Right-click the K icon → **Options** (or click the ⚙ in the popup).
2. Fill in:
   - **Google Sheet ID** — from your sheet URL: `docs.google.com/spreadsheets/d/SHEET_ID/edit`
   - **Apps Script Web App URL** — from step 1.10 above
   - **Shared Secret Token** — the same string you put in `SECRET_TOKEN`
   - **Daily target** — defaults to 100
   - **Start row** — defaults to 2 (row 1 is headers)
   - **Min seconds between profile opens** — defaults to 10 (rate limit, used in Phase 2)
3. Click **Test connection** → should show ✓ Connected to "Outreach".
4. Click **Save**.

### 4. Use it

1. Click the K icon → popup opens with the first lead.
2. **Next / Previous** to walk through leads.
3. **Skip** advances without writing anything.
4. **Open Profile + Fill InMail** → opens a new tab to the lead's LinkedIn URL
   and (when LinkedIn loads) clicks the Message/InMail button, fills in the
   InMail body from column L, and — if column M is non-empty — clicks "Add
   follow-up" and fills the follow-up editor.
5. Review the text in LinkedIn. **Click Send manually**. The extension never
   clicks Send for you.
6. Come back to the popup, click **Mark Sent** → writes `gesendet` + today's date
   (DD.MM.YYYY, Berlin) to columns Q+R, increments your daily count, advances
   to the next lead.
7. **Tier filter** dropdown skips to leads matching S/A/B (or All).
8. The footer shows `dailyCount / dailyTarget today · row N`.

When you hit your daily target, "Mark Sent" and "Open + Fill" are disabled and
a banner appears with an "Extend by 25" override (resets at midnight Berlin time).

There's a configurable **rate limit** (default 10s) between profile opens, to
keep your activity looking human. Adjust in Settings.

## Sheet schema

Tab name: `Outreach`. Columns:

| Col | Field |
|-----|-------|
| A   | # (row number) |
| B   | Tier (S/A/B) |
| C   | Score |
| D   | First name |
| E   | Last name |
| F   | Title |
| G   | Company |
| H   | Domain |
| I   | Finding (short) |
| J   | Findings count |
| K   | Connection note (300 chars) |
| L   | InMail (full body) |
| M   | Follow-Up InMail |
| N   | LinkedIn URL |
| O   | Email |
| P   | (separator, ignored) |
| Q   | Status (`gesendet` / `akzeptiert` / `call gebucht` / `abgelehnt` / `antwort`) |
| R   | Status date (DD.MM.YYYY, Berlin) |
| S   | Follow-up status |
| T   | Notes |

If your tab is not named `Outreach`, change `SHEET_NAME` at the top of
`apps-script/Code.gs` and redeploy (Deploy → Manage deployments → pencil →
Version: New version → Deploy).

## Architecture (one-line tour)

- `popup/` — thin view, sends messages to the service worker.
- `background/service-worker.js` — message router + state machine. Talks to the
  sheet via the Apps Script proxy.
- `content/linkedin.js` — runs on every linkedin.com/in/ and /talent/profile/
  page; pulls pending fill from SW, navigates from /in/ to /talent/, fills the
  composer.
- `lib/sheets.js` — HTTP client to the proxy.
- `lib/lead.js` — parses A:T row → typed `Lead` object.
- `lib/state.js` — `chrome.storage` wrappers, daily-reset, Berlin date helpers, LRU lead cache.
- `lib/sw_logic.js` — pure SW helpers (tier scan, write queue) extracted for testability.
- `lib/errors.js` — error code → friendly string + stage transition validation.
- `options/` — settings page.
- `apps-script/Code.gs` — proxy you deploy in your sheet's Apps Script project.

State buckets:
- `chrome.storage.sync`: non-secret settings (sheet ID, URL, target, subject, etc.) — syncs across your Chrome installs
- `chrome.storage.local`: SECRET_TOKEN, runtime (current row, daily count, LRU lead cache, pending fill, pending write queue, last error)

Daily reset uses `chrome.alarms` at local midnight, with a belt-and-suspenders
check on every `GET_STATE` (compares stored `lastResetDate` vs Berlin today).

**Multi-stage fill flow** (Phase 2 details):

1. Click *Open Profile + Fill InMail* → SW writes `pendingFill` to storage with
   the current lead's row, subject, body, follow-up, **plus the new tab's `tabId`
   and `linkedinUrl`**.
2. Tab loads `linkedin.com/in/<slug>/` → content script asks SW for pending →
   SW only delivers if `sender.tab.id === pendingFill.tabId`. CS finds
   "In Recruiter anzeigen" link, advances stage to `await_composer`, navigates.
3. Tab loads `linkedin.com/talent/profile/<id>/` (same tab) → CS pulls pending →
   clicks Recruiter Message button → fills subject + body + follow-up.
4. CS clears pending. Phil reviews and clicks Send manually.

**Optimistic Mark Sent**: clicking Mark Sent advances the popup immediately and
queues the sheet write. The drain happens in background and survives SW death
(retry on next SW startup or popup open). If the write fails, the popup shows
"N writes pending — will retry".

## Editing the proxy after deployment

If you ever change `apps-script/Code.gs`:

1. Apps Script editor → paste the new code, Save.
2. **Deploy → Manage deployments** → pencil ✏️ on the active deployment.
3. **Version**: pick **New version**.
4. **Deploy**. The URL stays the same — no extension change needed.

## Replacing the icons

The current icons are placeholders (teal rounded square with a white "K").
To swap:

1. Open `icons/source.html` in a browser. Three canvases preview the design.
2. Edit the `draw()` function (color, glyph, font) and reload.
3. Right-click each canvas → "Save image as…" → save over `icons/icon16.png`,
   `icon48.png`, `icon128.png`.
4. Reload the extension at `chrome://extensions`.

Or replace the PNGs directly with your own designs at the same dimensions.

## Development

```bash
npm install     # installs eslint
npm run lint    # eslint
npm run check   # syntax check all .js files via node --check
npm test        # unit tests via node --test
npm run zip     # package dist/extension.zip for distribution
```

After editing extension code, hit "Reload" on the extension card at
`chrome://extensions` to pick up changes. Service worker logs show in the card
under "service worker → inspect views". Popup logs show in DevTools when you
right-click the popup → Inspect.

## Security notes

- The Apps Script Web App is set to "Anyone with the link" by Google's design,
  but it returns `forbidden` for any request without the correct
  `SECRET_TOKEN`. Treat the token like a password.
- The token lives in `chrome.storage.sync`, which is encrypted at rest by Chrome
  and not exposed to web content.
- All Sheets traffic goes browser → `script.google.com`, never touches LinkedIn.
- The extension never reads or stores LinkedIn cookies / credentials.
- The extension never writes to LinkedIn or clicks the Send button. Always
  manual.

## Troubleshooting

**"Test connection" returns "non_json_response"**
Most often: the Apps Script deployment isn't actually live, or "Who has access"
isn't set to "Anyone". Re-check the deployment.

**"Test connection" returns "forbidden"**
The token in Settings doesn't match `SECRET_TOKEN` in `Code.gs`. Re-check both.

**"sheet_not_found:Outreach"**
Your sheet's tab is named something else. Either rename it to `Outreach` or
change `SHEET_NAME` at the top of `Code.gs` and redeploy.

**Leads aren't loading**
Open the popup → ⚙ Settings → Test connection. If it passes, try Reloading the
extension and re-opening the popup. Check the service worker logs at
`chrome://extensions → Kengo InMail → service worker (inspect views)`.

**Daily count not resetting**
Open the service worker DevTools console and run:
```js
chrome.storage.local.get('lastResetDate').then(console.log);
```
If it shows yesterday's date, opening the popup once will trigger the reset.
