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
  inmailSubject: 'kurze frage'
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
  pendingWrites: []
});

/**
 * @typedef {{
 *   row: number,
 *   subject?: string,
 *   inmail: string,
 *   followUp: string,
 *   stage: 'await_recruiter' | 'await_composer' | 'done',
 *   startedAt: number,
 *   expiresAt: number,
 *   tabId?: number,
 *   linkedinUrl?: string
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

export const PENDING_FILL_TTL_MS = 90_000;

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

/** @param {Partial<typeof RUNTIME_DEFAULTS>} patch */
export async function saveRuntime(patch) {
  await chrome.storage.local.set(patch);
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
