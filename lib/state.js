// @ts-check

/**
 * State management. Three buckets:
 * - chrome.storage.sync  → settings, EXCEPT secrets (small, follows the user across machines)
 * - chrome.storage.local → secret token + runtime state and lead cache (per machine, larger)
 *
 * The split: anything secret (currently `appsScriptToken`) lives in `local` so
 * it doesn't get synced to other Chrome profiles signed into the same Google
 * account. Migration from the old "everything in sync" layout happens on
 * `chrome.runtime.onInstalled` via `migrateTokenStorageOnce`.
 */

export const SETTINGS_DEFAULTS = Object.freeze({
  sheetId: '',
  appsScriptUrl: '',
  appsScriptToken: '',
  dailyTarget: 100,
  startRow: 2,
  minIntervalSeconds: 10,
  tierFilter: 'All', // 'All' | 'S' | 'A' | 'B'
  inmailSubject: 'kurze frage',
  // ---------------- Auto-mode (off until user opts in) ----------------
  autoMode: 'off',                 // 'off' | 'dry_run' | 'on'
  autoModeAcknowledgedAt: 0,       // epoch ms — first-run dialog accepted
  safetyMode: true,                // long-pauses + hourly cap + watch-for-warning escalation
  reviewWindowMs: 2500,            // dwell between paste-done and send-click (jittered)
  hourlyCap: 30,                   // hourly send cap (auto-mode only)
  errorBackoffThreshold: 2,        // consecutive same-code errors → auto-pause
  intervalJitterPct: 30,           // log-normal σ as percentage
  longPauseProb: 0.08,             // probability of inserting a 3-7min pause per cycle
  longPauseMinSeconds: 180,
  longPauseMaxSeconds: 420,
  quietHoursEnabled: false,
  quietHoursStart: 22,             // hour 0-23 Berlin
  quietHoursEnd: 7,
  canaryEveryN: 25                 // re-canary every N successful sends OR 2h
});

/** Keys that live in chrome.storage.local instead of sync (secrets). */
const LOCAL_SETTING_KEYS = Object.freeze(['appsScriptToken']);

export const RUNTIME_DEFAULTS = Object.freeze({
  currentRow: 2,
  dailyCount: 0,
  dailySentRows: /** @type {number[]} */ ([]),
  lastResetDate: '',     // ISO yyyy-mm-dd in Berlin
  lastOpenedAt: 0,       // epoch ms — for rate limiting Open + Fill
  leadCache: /** @type {Record<number, any>} */ ({}),
  lastError: '',
  todaysTargetOverride: 0, // bumps dailyTarget for today only
  /** @type {null | PendingFill} */
  pendingFill: null,
  /** @type {Array<PendingWrite>} */
  pendingWrites: [],
  // ---------------- Auto-mode runtime ----------------
  lastSentAt: 0,                                  // epoch ms — distinct from lastOpenedAt; D5
  /** @type {Array<{ts: number}>} */
  hourlyBuckets: [],                              // events in last 60min, for hourly cap
  consecutiveErrors: 0,                           // resets to 0 on a successful send; backoff at threshold
  lastErrorCode: '',                              // most recent error code, for diagnosis
  autoPaused: false,                              // sticky user-initiated pause
  autoBackoffPausedAt: 0,                         // SW-initiated backoff (epoch ms) — D11
  /** @type {null | LastAutoCycle} */
  lastAutoCycle: null,                            // diagnostic info about last auto cycle
  /** @type {Array<TelemetryEvent>} */
  eventLog: [],                                   // ring buffer of recent events
  sendsSinceCanary: 0,                            // counter for re-canary trigger — D10
  canaryNeeded: true                              // first cycle of session is canary
});

/**
 * @typedef {'await_recruiter' | 'await_composer' | 'await_review' | 'await_send_click' | 'await_modal' | 'await_success' | 'await_advance' | 'cooldown' | 'done' | 'error'} PendingFillStage
 */

/**
 * @typedef {{
 *   row: number,
 *   subject?: string,
 *   inmail: string,
 *   followUp: string,
 *   stage: PendingFillStage,
 *   startedAt: number,
 *   expiresAt: number,
 *   tabId?: number,
 *   linkedinUrl?: string,
 *   recruiterProfileId?: string,
 *   cycleId?: string,
 *   reviewWindowMs?: number,
 *   filledAt?: number,
 *   errorCode?: string,
 *   errorAtStage?: string,
 *   stageEnteredAt?: number
 * }} PendingFill
 */

/**
 * @typedef {{
 *   row: number,
 *   status: string,
 *   date: string,
 *   queuedAt: number
 * }} PendingWrite
 */

/**
 * @typedef {{
 *   row: number,
 *   cycleId: string,
 *   signal: string,
 *   finishedAt: number,
 *   errorCode?: string
 * }} LastAutoCycle
 */

/**
 * @typedef {{
 *   ts: number,
 *   cycleId?: string,
 *   row?: number,
 *   stage?: string,
 *   action: string,
 *   outcome: 'ok' | 'fail' | 'skip',
 *   detail?: string,
 *   errorCode?: string,
 *   durationMs?: number
 * }} TelemetryEvent
 */

/**
 * Legacy alias — equals STAGE_TTLS.await_recruiter under the new model, but
 * kept at 90s for now to avoid behavior change in service-worker callsites
 * that haven't migrated to nextExpiryFor yet.
 */
export const PENDING_FILL_TTL_MS = 90_000;

/**
 * Per-stage TTL (ms). The single 90s window in the original design didn't fit
 * the chained cycle (composer cold-load alone can take 30s+; quiet cooldowns
 * can span minutes). Stage-aware deadlines let each phase get appropriate
 * patience without weakening detection of stuck cycles overall.
 *
 * `nextExpiryFor(stage, now, opts)` is the canonical way to compute expiry.
 */
export const STAGE_TTLS = Object.freeze({
  await_recruiter:   60_000,   // /in/ → /talent/ navigation
  await_composer:   300_000,   // composer open + paste + follow-up open
  await_send_click:  10_000,
  await_modal:        5_000,
  await_success:     20_000,   // toast/composer-removed observation window
  await_advance:      5_000
  // await_review and cooldown are settings-derived; computed in nextExpiryFor.
});

/**
 * Compute the absolute expiry timestamp for a given stage transition.
 *
 * @param {PendingFillStage | string} stage
 * @param {number} now epoch ms
 * @param {{
 *   settings?: Partial<typeof SETTINGS_DEFAULTS>,
 *   reviewMs?: number,
 *   cooldownMs?: number
 * }} [opts]
 * @returns {number}
 */
export function nextExpiryFor(stage, now, opts = {}) {
  const settings = opts.settings || {};
  const reviewMs = typeof opts.reviewMs === 'number'
    ? opts.reviewMs
    : Number(settings.reviewWindowMs ?? SETTINGS_DEFAULTS.reviewWindowMs);
  const cooldownMs = typeof opts.cooldownMs === 'number'
    ? opts.cooldownMs
    : Math.max(0, Number(settings.minIntervalSeconds ?? SETTINGS_DEFAULTS.minIntervalSeconds)) * 2 * 1000;

  let ttl;
  switch (stage) {
    case 'await_recruiter':  ttl = STAGE_TTLS.await_recruiter; break;
    case 'await_composer':   ttl = STAGE_TTLS.await_composer; break;
    case 'await_review':     ttl = Math.max(0, reviewMs) + 5_000; break;
    case 'await_send_click': ttl = STAGE_TTLS.await_send_click; break;
    case 'await_modal':      ttl = STAGE_TTLS.await_modal; break;
    case 'await_success':    ttl = STAGE_TTLS.await_success; break;
    case 'await_advance':    ttl = STAGE_TTLS.await_advance; break;
    case 'cooldown':         ttl = Math.max(0, cooldownMs) + 10_000; break;
    case 'done':
    case 'error':            ttl = 5_000; break;
    default:                 ttl = STAGE_TTLS.await_recruiter; break;
  }
  return now + ttl;
}

/**
 * Returns pendingFill if still valid, otherwise null. Does not persist; caller
 * should write the cleared state back if it returns null.
 * @param {any} pendingFill
 * @param {number} [now]
 * @returns {PendingFill | null}
 */
export function activePendingFill(pendingFill, now = Date.now()) {
  if (!pendingFill || typeof pendingFill !== 'object') return null;
  if (typeof pendingFill.expiresAt !== 'number') return null;
  if (now > pendingFill.expiresAt) return null;
  return pendingFill;
}

const BERLIN_TZ = 'Europe/Berlin';

/**
 * Today's date in Berlin as ISO yyyy-mm-dd.
 * @param {Date} [now]
 */
export function berlinIsoDate(now = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: BERLIN_TZ, year: 'numeric', month: '2-digit', day: '2-digit'
  }).formatToParts(now);
  const y = parts.find(p => p.type === 'year')?.value || '';
  const m = parts.find(p => p.type === 'month')?.value || '';
  const d = parts.find(p => p.type === 'day')?.value || '';
  return `${y}-${m}-${d}`;
}

/**
 * Today's date in Berlin formatted DD.MM.YYYY (for column R).
 * @param {Date} [now]
 */
export function berlinDeDate(now = new Date()) {
  const iso = berlinIsoDate(now);
  const [y, m, d] = iso.split('-');
  return `${d}.${m}.${y}`;
}

export async function loadSettings() {
  const sync = await chrome.storage.sync.get(SETTINGS_DEFAULTS);
  const local = await chrome.storage.local.get(LOCAL_SETTING_KEYS);
  return { ...SETTINGS_DEFAULTS, ...sync, ...local };
}

/** @param {Partial<typeof SETTINGS_DEFAULTS>} patch */
export async function saveSettings(patch) {
  /** @type {Record<string, unknown>} */
  const localPatch = {};
  /** @type {Record<string, unknown>} */
  const syncPatch = {};
  for (const [key, val] of Object.entries(patch)) {
    if (LOCAL_SETTING_KEYS.includes(/** @type {any} */ (key))) {
      localPatch[key] = val;
    } else {
      syncPatch[key] = val;
    }
  }
  if (Object.keys(syncPatch).length > 0) await chrome.storage.sync.set(syncPatch);
  if (Object.keys(localPatch).length > 0) await chrome.storage.local.set(localPatch);
}

/**
 * One-time migration: if appsScriptToken lives in chrome.storage.sync (legacy
 * layout from before C5 was fixed), copy it to chrome.storage.local and
 * remove from sync. Idempotent — safe to call repeatedly.
 */
export async function migrateTokenStorageOnce() {
  const sync = await chrome.storage.sync.get(['appsScriptToken']);
  if (!sync.appsScriptToken) return;
  const local = await chrome.storage.local.get(['appsScriptToken']);
  if (!local.appsScriptToken) {
    await chrome.storage.local.set({ appsScriptToken: sync.appsScriptToken });
  }
  await chrome.storage.sync.remove('appsScriptToken');
}

export async function loadRuntime() {
  const obj = await chrome.storage.local.get(RUNTIME_DEFAULTS);
  return { ...RUNTIME_DEFAULTS, ...obj };
}

// ---------------------------------------------------------------------------
// Runtime-write serialization
//
// Multiple message handlers can call saveRuntime concurrently. Without a
// queue, two callers that loaded the same runtime state and write overlapping
// patches can lose one update each (TOCTOU). The mutex below serializes writes
// across the whole module; combine with `withRuntime` for atomic
// load-modify-save.
// ---------------------------------------------------------------------------

let _runtimeQueue = /** @type {Promise<unknown>} */ (Promise.resolve());

/** @param {Partial<typeof RUNTIME_DEFAULTS>} patch */
export async function saveRuntime(patch) {
  const next = _runtimeQueue.then(() => chrome.storage.local.set(patch));
  _runtimeQueue = next.catch(() => {});
  return next;
}

/**
 * Atomic read-modify-write. The mutator receives the current runtime and
 * returns a patch (or a promise of one). The whole load+mutate+save runs
 * under the same serialization queue, eliminating the TOCTOU class of races.
 *
 * @param {(runtime: typeof RUNTIME_DEFAULTS) =>
 *          (Partial<typeof RUNTIME_DEFAULTS> | null | undefined |
 *           Promise<Partial<typeof RUNTIME_DEFAULTS> | null | undefined>)} mutator
 * @returns {Promise<typeof RUNTIME_DEFAULTS>}
 */
export async function withRuntime(mutator) {
  const next = _runtimeQueue.then(async () => {
    const runtime = await loadRuntime();
    const patch = await mutator(runtime);
    if (patch && typeof patch === 'object') {
      await chrome.storage.local.set(patch);
      return /** @type {typeof RUNTIME_DEFAULTS} */ ({ ...runtime, ...patch });
    }
    return runtime;
  });
  _runtimeQueue = next.catch(() => {});
  return next;
}

/**
 * If the day rolled over since the last reset, zero the daily count.
 * Returns the (possibly mutated) runtime object.
 * @param {typeof RUNTIME_DEFAULTS} runtime
 * @param {Date} [now]
 */
export function maybeResetDaily(runtime, now = new Date()) {
  const today = berlinIsoDate(now);
  if (runtime.lastResetDate !== today) {
    return {
      ...runtime,
      dailyCount: 0,
      dailySentRows: [],
      lastResetDate: today,
      todaysTargetOverride: 0
    };
  }
  return runtime;
}

/**
 * LRU sliding-window cache of recently fetched/touched leads.
 *
 * Implementation note: V8 (and most engines) iterate integer-keyed object
 * properties in ascending numeric order regardless of insertion. To preserve
 * true insertion order for LRU eviction, we prefix keys with `r` so they
 * become non-numeric strings, which DO iterate in insertion order.
 *
 * Use `getCachedLead(cache, row)` to read; the prefix is an implementation
 * detail.
 *
 * @param {Record<string, any>} cache
 * @param {Array<{row: number}>} newLeads
 * @param {number} [maxSize]
 */
export function appendLeadCache(cache, newLeads, maxSize = 200) {
  /** @type {Record<string, any>} */
  const next = { ...cache };
  for (const lead of newLeads) {
    const k = `r${lead.row}`;
    if (k in next) delete next[k]; // pop old position
    next[k] = lead;                // push to end (most-recently-used)
  }
  const keys = Object.keys(next);
  while (keys.length > maxSize) {
    const drop = keys.shift();
    if (drop !== undefined) delete next[drop];
  }
  return next;
}

/**
 * Read a lead from the cache by row number. Hides the key-prefix detail.
 * @param {Record<string, any> | null | undefined} cache
 * @param {number} row
 */
export function getCachedLead(cache, row) {
  if (!cache) return undefined;
  return cache[`r${row}`];
}
