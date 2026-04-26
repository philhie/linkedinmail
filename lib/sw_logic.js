// @ts-check

/**
 * Pure (chrome.*-free) service-worker helpers, extracted for testability.
 *
 * Anything in here takes its dependencies as arguments — no module-level
 * chrome.* access. Tests pass mock `sheetsClient` (an object with the same
 * `readRow` / `readRange` / `writeStatus` / `ping` interface as `lib/sheets.js`).
 */

import { appendLeadCache } from './state.js';

export const TIER_SCAN_LIMIT = 100;
export const PREFETCH_BATCH = 25;
export const HOURLY_WINDOW_MS = 60 * 60 * 1000;

/**
 * @typedef {{
 *   readRow:    (settings: any, row: number) => Promise<any>,
 *   readRange:  (settings: any, start: number, end: number) => Promise<any[]>,
 *   writeStatus:(settings: any, row: number, status: string, date: string) => Promise<unknown>,
 *   ping:       (settings: any) => Promise<{sheetName: string}>
 * }} SheetsClient
 */

/**
 * Walk forward (or backward) until we find a row whose tier matches the filter.
 * Batched in both directions to keep network round-trips low.
 *
 * @param {{ tierFilter: string, startRow: number }} settings
 * @param {Record<number, any>} startCache
 * @param {number} startRow
 * @param {'next'|'prev'} direction
 * @param {SheetsClient} sheetsClient
 * @param {{ scanLimit?: number, batchSize?: number }} [opts]
 */
export async function findTierMatch(settings, startCache, startRow, direction, sheetsClient, opts = {}) {
  const scanLimit = opts.scanLimit || TIER_SCAN_LIMIT;
  const batchSize = opts.batchSize || PREFETCH_BATCH;
  let cache = startCache;

  if (settings.tierFilter === 'All') {
    return { row: Math.max(startRow, settings.startRow), cache };
  }

  if (direction === 'prev') {
    let row = startRow;
    let scanned = 0;
    while (scanned < scanLimit && row >= settings.startRow) {
      const start = Math.max(settings.startRow, row - batchSize + 1);
      const leads = await sheetsClient.readRange(settings, start, row);
      cache = appendLeadCache(cache, leads);
      // Walk the batch in reverse to find the highest matching row ≤ startRow
      for (let i = leads.length - 1; i >= 0; i--) {
        if (leads[i].tier === settings.tierFilter) {
          return { row: leads[i].row, cache };
        }
      }
      if (leads.length === 0 || start === settings.startRow) break;
      row = start - 1;
      scanned += batchSize;
    }
    return { row: startRow, cache };
  }

  // direction === 'next'
  let row = startRow;
  let scanned = 0;
  while (scanned < scanLimit) {
    const end = row + batchSize - 1;
    const leads = await sheetsClient.readRange(settings, row, end);
    cache = appendLeadCache(cache, leads);
    for (const lead of leads) {
      if (lead.tier === settings.tierFilter) return { row: lead.row, cache };
    }
    if (leads.length === 0) break;
    row = end + 1;
    scanned += batchSize;
  }
  return { row: startRow, cache };
}

/**
 * Append a write to the pending queue. Returns a new array (immutable).
 * @param {Array<{row:number,status:string,date:string,queuedAt:number}>} writes
 * @param {number} row
 * @param {string} status
 * @param {string} date
 * @param {number} [now]
 */
export function appendPendingWrite(writes, row, status, date, now = Date.now()) {
  return [...(writes || []), { row, status, date, queuedAt: now }];
}

/**
 * Drain the pending writes queue by calling sheetsClient.writeStatus for each
 * entry sequentially. Returns the new (still-pending) queue and a list of
 * completed rows.
 *
 * Stops at the first failure (likely transient — network or 5xx) and leaves
 * the failing entry plus any subsequent entries in the queue for next drain.
 *
 * @param {{ appsScriptUrl?: string, appsScriptToken?: string }} settings
 * @param {Array<{row:number,status:string,date:string,queuedAt:number}>} writes
 * @param {SheetsClient} sheetsClient
 * @returns {Promise<{
 *   remaining: typeof writes,
 *   completed: Array<{row:number}>,
 *   error: string | null
 * }>}
 */
export async function drainPendingWrites(settings, writes, sheetsClient) {
  if (!writes || writes.length === 0) {
    return { remaining: [], completed: [], error: null };
  }
  // If we don't have credentials yet, don't even try — keep the queue.
  if (!settings.appsScriptUrl || !settings.appsScriptToken) {
    return { remaining: writes, completed: [], error: 'not_configured' };
  }
  const completed = [];
  let error = null;
  let i = 0;
  for (; i < writes.length; i++) {
    const w = writes[i];
    try {
      await sheetsClient.writeStatus(settings, w.row, w.status, w.date);
      completed.push({ row: w.row });
    } catch (err) {
      error = String(err && err.message || err);
      break;
    }
  }
  const remaining = writes.slice(i);
  return { remaining, completed, error };
}

// ---------------------------------------------------------------------------
// Auto-mode helpers
// ---------------------------------------------------------------------------

/**
 * Drop hourly-bucket entries older than the rolling window. Pure.
 *
 * @param {Array<{ts: number}> | null | undefined} buckets
 * @param {number} now
 * @param {number} [windowMs]
 * @returns {Array<{ts: number}>}
 */
export function pruneHourlyBuckets(buckets, now, windowMs = HOURLY_WINDOW_MS) {
  if (!Array.isArray(buckets)) return [];
  const cutoff = now - windowMs;
  return buckets.filter(b => b && typeof b.ts === 'number' && b.ts >= cutoff);
}

/**
 * Append a new event timestamp, returning the pruned bucket list. Pure.
 *
 * @param {Array<{ts: number}> | null | undefined} buckets
 * @param {number} now
 * @param {number} [windowMs]
 */
export function appendHourlyBucket(buckets, now, windowMs = HOURLY_WINDOW_MS) {
  const pruned = pruneHourlyBuckets(buckets, now, windowMs);
  return [...pruned, { ts: now }];
}

/**
 * Count entries within the rolling window.
 *
 * @param {Array<{ts: number}> | null | undefined} buckets
 * @param {number} now
 * @param {number} [windowMs]
 */
export function hourlyCount(buckets, now, windowMs = HOURLY_WINDOW_MS) {
  return pruneHourlyBuckets(buckets, now, windowMs).length;
}

/**
 * Log-normal jittered delay around a base interval. Mean ≈ baseMs (median
 * exactly = baseMs), variance grows with `pctRange`. Clamped to
 * [baseMs * 0.7, baseMs * 2.0] so we never go below the user's floor or
 * stretch absurdly long on a tail draw.
 *
 * `rand` is injectable for deterministic tests.
 *
 * @param {number} baseMs
 * @param {number} pctRange   — percent (e.g. 30 for ±30%)
 * @param {() => number} [rand]
 * @returns {number}
 */
export function jitteredDelay(baseMs, pctRange, rand = Math.random) {
  if (!Number.isFinite(baseMs) || baseMs <= 0) return 0;
  const sigma = Math.max(0, Number(pctRange || 0)) / 100;
  if (sigma <= 0) return Math.round(baseMs);
  // Box-Muller: two uniform → one standard normal.
  const u1 = Math.max(rand(), 1e-9);  // avoid log(0)
  const u2 = rand();
  const z = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
  // Lognormal: exp(z * sigma) gives a multiplier with median = 1.
  const multiplier = Math.exp(z * sigma);
  let delay = baseMs * multiplier;
  // Clamp to keep behavior bounded under tail draws.
  delay = Math.max(baseMs * 0.7, Math.min(baseMs * 2.0, delay));
  return Math.round(delay);
}

/**
 * Classify a LinkedIn toast/snackbar text into one of:
 *   - 'positive'  (the InMail was sent — proceed)
 *   - 'negative'  (rate-limit / spam / restriction — auto-pause)
 *   - 'unknown'   (something else — ignore for success-detection purposes)
 *
 * Pure. The regex sets are deliberately narrow on the negative side: false
 * positives there silently disable auto-mode for the day, so we only match
 * on phrases we're confident indicate trouble.
 *
 * @param {string} text
 * @returns {'positive' | 'negative' | 'unknown'}
 */
export function classifySendToast(text) {
  if (typeof text !== 'string' || !text.trim()) return 'unknown';
  const t = text.trim();

  const negative = [
    /\bzu\s+viele\b/i,
    /\btoo\s+many\b/i,
    /\bplease\s+wait\b/i,
    /\btry\s+again\s+later\b/i,
    /\bspam\b/i,
    /\bflagged\b/i,
    /\brestricted\b/i,
    /\beingeschr(ä|a)nkt\b/i,
    /\bgesperrt\b/i,
    /\bblocked\b/i,
    /\bmessage\s+limit\b/i
  ];
  for (const re of negative) if (re.test(t)) return 'negative';

  const positive = [
    /InMail\s+(gesendet|sent)/i,
    /Nachricht\s+(gesendet|sent)/i,
    /Ihre\s+InMail\s+wurde\s+gesendet/i,
    /^(Gesendet|Sent)$/i,
    /\bMessage\s+sent\b/i
  ];
  for (const re of positive) if (re.test(t)) return 'positive';

  return 'unknown';
}

/**
 * Compute the runtime patch for "this row has been sent" — single source of
 * truth for both manual MARK_SENT and the auto-mode RECORD_SEND_SUCCESS path.
 *
 * Pure: takes the runtime + settings + row + date and returns the patch the
 * caller should apply via withRuntime/saveRuntime. Increments dailyCount,
 * appends to dailySentRows, queues the sheet write, advances hourlyBuckets,
 * stamps lastSentAt, and bumps sendsSinceCanary.
 *
 * `source` controls a subtle behavior: when 'auto' (the success came via the
 * auto-mode pipeline) we reset `consecutiveErrors` back to 0 since a clean
 * cycle breaks the streak. When 'manual' (Phil clicked Mark Sent) we do NOT
 * reset — the streak should reflect auto-mode health independently of
 * whatever Phil is doing manually on other rows.
 *
 * @param {{
 *   pendingWrites?: Array<any>,
 *   dailyCount?: number,
 *   dailySentRows?: number[],
 *   hourlyBuckets?: Array<{ts: number}>,
 *   sendsSinceCanary?: number,
 *   lastResetDate?: string
 * }} runtime
 * @param {number} row
 * @param {string} date  — Berlin DE format ("DD.MM.YYYY") for column R
 * @param {number} [now]
 * @param {'auto' | 'manual'} [source]
 */
export function recordSentInternal(runtime, row, date, now = Date.now(), source = 'manual') {
  const pendingWrites = appendPendingWrite(runtime.pendingWrites || [], row, 'gesendet', date, now);
  const dailySentRows = [...(runtime.dailySentRows || []), row];
  const hourlyBuckets = appendHourlyBucket(runtime.hourlyBuckets || [], now);
  /** @type {Record<string, any>} */
  const patch = {
    pendingWrites,
    dailyCount: (runtime.dailyCount || 0) + 1,
    dailySentRows,
    hourlyBuckets,
    lastSentAt: now,
    sendsSinceCanary: (runtime.sendsSinceCanary || 0) + 1,
    lastResetDate: runtime.lastResetDate,
    lastError: ''
  };
  if (source === 'auto') {
    // Successful auto cycle = streak broken.
    patch.consecutiveErrors = 0;
  }
  return patch;
}
