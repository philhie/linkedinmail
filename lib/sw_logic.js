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
