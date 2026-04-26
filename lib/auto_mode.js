// @ts-check

/**
 * Auto-mode logic — pure helpers (no chrome.*).
 *
 * The auto-mode pipeline (D5 in the plan) wraps Phil's chosen base interval
 * (`settings.minIntervalSeconds`) in non-metronomic safety: log-normal jitter,
 * occasional long pauses, hourly cap, optional quiet hours, watch-for-warning
 * escalation. This module is the home for those rules so the SW can stay thin
 * and the tests can stay fast.
 */

/**
 * @typedef {{
 *   autoMode?: string,
 *   safetyMode?: boolean,
 *   minIntervalSeconds?: number,
 *   intervalJitterPct?: number,
 *   longPauseProb?: number,
 *   longPauseMinSeconds?: number,
 *   longPauseMaxSeconds?: number,
 *   hourlyCap?: number,
 *   quietHoursEnabled?: boolean,
 *   quietHoursStart?: number,
 *   quietHoursEnd?: number,
 *   canaryEveryN?: number,
 *   reviewWindowMs?: number,
 *   errorBackoffThreshold?: number
 * }} AutoModeSettings
 */

/**
 * @typedef {{
 *   enabled: boolean,
 *   dryRun: boolean,
 *   safetyMode: boolean,
 *   baseMs: number,
 *   jitterPct: number,
 *   longPauseProb: number,
 *   longPauseMinMs: number,
 *   longPauseMaxMs: number,
 *   hourlyCap: number,
 *   reviewWindowMs: number,
 *   canaryEveryN: number
 * }} AutoModeProfile
 */

/**
 * Resolve the runtime profile for the current settings.
 *
 * The plan only exposes three modes (off / dry_run / on); 'on' carries the
 * full safety set when `safetyMode` is true and degrades to bare jitter when
 * the user explicitly opts out.
 *
 * @param {AutoModeSettings} settings
 * @returns {AutoModeProfile}
 */
export function resolveAutoModeProfile(settings) {
  const mode = String(settings.autoMode || 'off');
  const baseMs = Math.max(0, Number(settings.minIntervalSeconds || 0)) * 1000;
  const jitterPct = clampNum(settings.intervalJitterPct, 30, 0, 200);
  const reviewWindowMs = clampNum(settings.reviewWindowMs, 2500, 500, 30_000);
  const canaryEveryN = clampNum(settings.canaryEveryN, 25, 1, 1000);
  const safetyMode = settings.safetyMode !== false; // default true
  const longPauseProb = safetyMode ? clampNum(settings.longPauseProb, 0.08, 0, 1) : 0;
  const longPauseMinMs = Math.max(0, Number(settings.longPauseMinSeconds || 180)) * 1000;
  const longPauseMaxMs = Math.max(longPauseMinMs, Number(settings.longPauseMaxSeconds || 420) * 1000);
  const hourlyCap = safetyMode ? clampNum(settings.hourlyCap, 30, 1, 1000) : Number.POSITIVE_INFINITY;

  if (mode === 'off') {
    return {
      enabled: false, dryRun: false, safetyMode,
      baseMs, jitterPct, longPauseProb, longPauseMinMs, longPauseMaxMs,
      hourlyCap, reviewWindowMs, canaryEveryN
    };
  }
  return {
    enabled: true,
    dryRun: mode === 'dry_run',
    safetyMode,
    baseMs, jitterPct,
    longPauseProb, longPauseMinMs, longPauseMaxMs,
    hourlyCap, reviewWindowMs, canaryEveryN
  };
}

/**
 * Whether the current Berlin-local hour falls within the user's quiet
 * hours window. Handles wrap-around windows (e.g. 22:00–07:00).
 *
 * @param {Date | number} now
 * @param {AutoModeSettings} settings
 */
export function withinQuietHours(now, settings) {
  if (!settings || !settings.quietHoursEnabled) return false;
  const date = now instanceof Date ? now : new Date(now);
  const hourStr = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/Berlin', hour: 'numeric', hour12: false
  }).format(date);
  const hour = parseInt(hourStr, 10);
  if (Number.isNaN(hour)) return false;
  const start = clampNum(settings.quietHoursStart, 22, 0, 23);
  const end = clampNum(settings.quietHoursEnd, 7, 0, 23);
  if (start === end) return false;            // empty window
  if (start < end) return hour >= start && hour < end;     // same-day
  return hour >= start || hour < end;          // wraps midnight
}

/**
 * @param {() => number} rand
 * @param {AutoModeSettings} settings
 */
export function shouldInjectLongPause(rand, settings) {
  const prob = clampNum(settings && settings.longPauseProb, 0, 0, 1);
  if (prob <= 0) return false;
  return (rand || Math.random)() < prob;
}

/**
 * Random duration within [longPauseMinSeconds, longPauseMaxSeconds] in ms.
 * @param {() => number} rand
 * @param {AutoModeSettings} settings
 */
export function longPauseDuration(rand, settings) {
  const r = (rand || Math.random)();
  const min = Math.max(0, Number((settings && settings.longPauseMinSeconds) || 180)) * 1000;
  const max = Math.max(min, Number((settings && settings.longPauseMaxSeconds) || 420) * 1000);
  return Math.round(min + r * (max - min));
}

/**
 * Top-level guard chain run before scheduling the next auto-cycle.
 *
 * Returns an object: `proceed: true` when the cycle may run; otherwise
 * `proceed: false` plus a reason code (matches `lib/errors.js` mapping) and
 * optionally a `retryAfterMs` for soft-throttle conditions (cap, quiet hours).
 *
 * @param {{
 *   runtime: any,
 *   settings: AutoModeSettings & { dailyTarget?: number },
 *   now?: number,
 *   profile?: AutoModeProfile,
 *   dailyCount?: number,
 *   effectiveTarget?: number,
 *   pendingWritesCount?: number,
 *   pendingWritesOldestQueuedAt?: number
 * }} input
 * @returns {{ proceed: boolean, reason?: string, retryAfterMs?: number }}
 */
export function evaluateGuards(input) {
  const now = typeof input.now === 'number' ? input.now : Date.now();
  const runtime = input.runtime || {};
  const settings = input.settings || {};
  const profile = input.profile || resolveAutoModeProfile(settings);

  if (!profile.enabled) return { proceed: false, reason: 'auto_off' };
  if (runtime.autoPaused) return { proceed: false, reason: 'auto_paused_by_user' };
  if (runtime.autoBackoffPausedAt) return { proceed: false, reason: 'auto_backoff' };

  // Daily target.
  const target = typeof input.effectiveTarget === 'number'
    ? input.effectiveTarget
    : Number(settings.dailyTarget || 0) + Number(runtime.todaysTargetOverride || 0);
  const dailyCount = typeof input.dailyCount === 'number' ? input.dailyCount : Number(runtime.dailyCount || 0);
  if (target > 0 && dailyCount >= target) {
    return { proceed: false, reason: 'daily_target_reached' };
  }

  // Pending-writes backlog (D8): if the sheet is desyncing, stop sending.
  const writesCount = typeof input.pendingWritesCount === 'number'
    ? input.pendingWritesCount
    : (Array.isArray(runtime.pendingWrites) ? runtime.pendingWrites.length : 0);
  const oldest = typeof input.pendingWritesOldestQueuedAt === 'number'
    ? input.pendingWritesOldestQueuedAt
    : (Array.isArray(runtime.pendingWrites) && runtime.pendingWrites.length > 0
        ? runtime.pendingWrites[0].queuedAt || now
        : now);
  if (writesCount > 5 || (writesCount > 0 && (now - oldest) > 5 * 60_000)) {
    return { proceed: false, reason: 'pending_writes_backlog' };
  }

  // Quiet hours — soft throttle: defer until the window ends.
  if (withinQuietHours(now, settings)) {
    return { proceed: false, reason: 'quiet_hours', retryAfterMs: msUntilQuietHoursEnd(now, settings) };
  }

  // Hourly cap — soft throttle: defer until oldest bucket ages out.
  if (profile.safetyMode && Number.isFinite(profile.hourlyCap)) {
    const buckets = Array.isArray(runtime.hourlyBuckets) ? runtime.hourlyBuckets : [];
    const recent = buckets.filter(b => b && typeof b.ts === 'number' && b.ts >= now - 60 * 60_000);
    if (recent.length >= profile.hourlyCap) {
      const oldestTs = Math.min(...recent.map(b => b.ts));
      return {
        proceed: false,
        reason: `hourly_cap_throttled:${profile.hourlyCap}`,
        retryAfterMs: Math.max(0, oldestTs + 60 * 60_000 - now)
      };
    }
  }

  return { proceed: true };
}

/**
 * Number of ms until the quiet-hours window ends, given the user is currently
 * inside it. Returns 0 if not in quiet hours or if input is malformed.
 * @param {Date | number} now
 * @param {AutoModeSettings} settings
 */
export function msUntilQuietHoursEnd(now, settings) {
  if (!withinQuietHours(now, settings)) return 0;
  const date = now instanceof Date ? new Date(now) : new Date(now);
  const tz = 'Europe/Berlin';
  // Compute current Berlin hour & minute.
  const fmt = new Intl.DateTimeFormat('en-GB', {
    timeZone: tz, hour: 'numeric', minute: 'numeric', second: 'numeric', hour12: false
  });
  const parts = fmt.formatToParts(date);
  const h = parseInt(parts.find(p => p.type === 'hour')?.value || '0', 10);
  const m = parseInt(parts.find(p => p.type === 'minute')?.value || '0', 10);
  const s = parseInt(parts.find(p => p.type === 'second')?.value || '0', 10);

  const end = clampNum(settings.quietHoursEnd, 7, 0, 23);
  const start = clampNum(settings.quietHoursStart, 22, 0, 23);
  // Minutes from "now" to next occurrence of `end:00:00` Berlin.
  const nowMinutes = h * 60 + m;
  const endMinutes = end * 60;
  let deltaMin;
  if (start < end) {
    // same-day window — end is later today
    deltaMin = endMinutes - nowMinutes;
  } else {
    // wraps midnight — if we're past start (h >= start), end is tomorrow;
    // if we're before end (h < end), end is today.
    if (h >= start) deltaMin = 24 * 60 - nowMinutes + endMinutes;
    else deltaMin = endMinutes - nowMinutes;
  }
  return Math.max(0, deltaMin * 60_000 - s * 1_000);
}

/**
 * Detect a LinkedIn auth-challenge / interstitial URL (checkpoint, captcha,
 * login). The SW listens for tab URL updates filtered to the active fill's
 * tabId — when it sees one of these we abort the cycle and engage
 * `auth_challenge` backoff. Pure function so it's trivially testable.
 *
 * @param {string} url
 * @returns {boolean}
 */
export function detectAuthChallengeUrl(url) {
  if (typeof url !== 'string' || !url) return false;
  // Path-segment matches with leading slash so "/talent/checkpoint-team-x" doesn't
  // false-positive (LinkedIn never names a /talent/ subroute "checkpoint" today,
  // but defense in depth).
  if (/\/checkpoint(\/|\?|$)/i.test(url)) return true;
  if (/\/uas\/(?:login|consumer)/i.test(url)) return true;
  if (/\/captcha(\/|\?|$)/i.test(url)) return true;
  if (/linkedin\.com\/login(\/|\?|$)/i.test(url)) return true;
  return false;
}

/**
 * Clamp a numeric setting, falling back to a default for non-numeric input.
 * @param {unknown} v
 * @param {number} fallback
 * @param {number} min
 * @param {number} max
 */
function clampNum(v, fallback, min, max) {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  if (n < min) return min;
  if (n > max) return max;
  return n;
}
