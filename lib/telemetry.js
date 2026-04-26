// @ts-check

/**
 * Tiny ring-buffer + helpers for telemetry events. Pure (no chrome.*) so
 * tests can run in plain Node.
 *
 * Events are stored in `runtime.eventLog` (chrome.storage.local). The buffer
 * is intentionally small — diagnostic, not analytics — and is stripped of
 * any lead body content. Only `row` ever leaves chrome.storage so PII never
 * lands in a log surface beyond Phil's own machine.
 */

export const DEFAULT_MAX_EVENTS = 50;

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
 *   durationMs?: number,
 *   signal?: string
 * }} TelemetryEvent
 */

/**
 * Append an event to the ring buffer, dropping oldest entries when over `max`.
 * Pure (returns a new array, does not mutate input).
 *
 * @param {Array<TelemetryEvent> | null | undefined} buffer
 * @param {TelemetryEvent} event
 * @param {number} [max]
 * @returns {Array<TelemetryEvent>}
 */
export function appendEvent(buffer, event, max = DEFAULT_MAX_EVENTS) {
  const arr = Array.isArray(buffer) ? buffer.slice() : [];
  arr.push(sanitizeEvent(event));
  while (arr.length > max) arr.shift();
  return arr;
}

/**
 * Last `n` events (most recent at the end). Returns a new array.
 *
 * @param {Array<TelemetryEvent> | null | undefined} buffer
 * @param {number} [n]
 * @returns {Array<TelemetryEvent>}
 */
export function recentEvents(buffer, n = 10) {
  const arr = Array.isArray(buffer) ? buffer : [];
  if (n <= 0) return [];
  return arr.slice(-n);
}

/**
 * Trim event objects to a known-safe shape (no lead body, no message text).
 * Strict allowlist — anything not in this list is dropped on the floor so a
 * caller that accidentally passes `{ inmail: '...' }` doesn't leak it.
 *
 * @param {any} event
 * @returns {TelemetryEvent}
 */
function sanitizeEvent(event) {
  const e = (event && typeof event === 'object') ? event : {};
  const out = /** @type {TelemetryEvent} */ ({
    ts:        typeof e.ts === 'number' ? e.ts : Date.now(),
    action:    typeof e.action === 'string' ? e.action : 'unknown',
    outcome:   (e.outcome === 'ok' || e.outcome === 'fail' || e.outcome === 'skip') ? e.outcome : 'ok'
  });
  if (typeof e.cycleId === 'string')   out.cycleId = e.cycleId;
  if (typeof e.row === 'number')       out.row = e.row;
  if (typeof e.stage === 'string')     out.stage = e.stage;
  if (typeof e.detail === 'string')    out.detail = e.detail.slice(0, 200);
  if (typeof e.errorCode === 'string') out.errorCode = e.errorCode;
  if (typeof e.durationMs === 'number')out.durationMs = e.durationMs;
  if (typeof e.signal === 'string')    out.signal = e.signal;
  return out;
}
