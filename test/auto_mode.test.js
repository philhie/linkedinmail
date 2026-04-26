import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  resolveAutoModeProfile,
  evaluateGuards,
  withinQuietHours,
  shouldInjectLongPause,
  longPauseDuration,
  msUntilQuietHoursEnd,
  detectAuthChallengeUrl
} from '../lib/auto_mode.js';

// ---------------- resolveAutoModeProfile ----------------

test('resolveAutoModeProfile: off returns disabled profile', () => {
  const p = resolveAutoModeProfile({ autoMode: 'off' });
  assert.equal(p.enabled, false);
  assert.equal(p.dryRun, false);
});

test('resolveAutoModeProfile: dry_run returns enabled + dryRun', () => {
  const p = resolveAutoModeProfile({ autoMode: 'dry_run', minIntervalSeconds: 10 });
  assert.equal(p.enabled, true);
  assert.equal(p.dryRun, true);
  assert.equal(p.baseMs, 10_000);
});

test('resolveAutoModeProfile: on with safetyMode true keeps long-pause + cap', () => {
  const p = resolveAutoModeProfile({
    autoMode: 'on', minIntervalSeconds: 10, safetyMode: true,
    longPauseProb: 0.1, hourlyCap: 25
  });
  assert.equal(p.enabled, true);
  assert.equal(p.dryRun, false);
  assert.equal(p.safetyMode, true);
  assert.equal(p.longPauseProb, 0.1);
  assert.equal(p.hourlyCap, 25);
});

test('resolveAutoModeProfile: on with safetyMode false zeroes out the safety surface', () => {
  const p = resolveAutoModeProfile({
    autoMode: 'on', minIntervalSeconds: 10, safetyMode: false,
    longPauseProb: 0.5, hourlyCap: 25
  });
  assert.equal(p.enabled, true);
  assert.equal(p.safetyMode, false);
  // long-pause + cap explicitly disabled when safety off
  assert.equal(p.longPauseProb, 0);
  assert.equal(p.hourlyCap, Number.POSITIVE_INFINITY);
});

test('resolveAutoModeProfile: clamps out-of-range numeric inputs', () => {
  const p = resolveAutoModeProfile({
    autoMode: 'on', minIntervalSeconds: 10,
    intervalJitterPct: 9999,
    longPauseProb: 5,
    hourlyCap: -3,
    canaryEveryN: 10_000
  });
  assert.ok(p.jitterPct <= 200);
  assert.ok(p.longPauseProb <= 1);
  assert.ok(p.hourlyCap >= 1);
  assert.ok(p.canaryEveryN <= 1000);
});

test('resolveAutoModeProfile: non-numeric inputs fall back to defaults', () => {
  const p = resolveAutoModeProfile({
    autoMode: 'on', minIntervalSeconds: 10,
    intervalJitterPct: /** @type {any} */ ('garbage'),
    hourlyCap: /** @type {any} */ ('nope')
  });
  assert.equal(p.jitterPct, 30);
  assert.equal(p.hourlyCap, 30);
});

// ---------------- withinQuietHours ----------------

test('withinQuietHours: disabled flag returns false unconditionally', () => {
  const noon = new Date('2026-04-25T12:00:00Z'); // 14:00 Berlin (CEST)
  assert.equal(withinQuietHours(noon, { quietHoursEnabled: false, quietHoursStart: 0, quietHoursEnd: 23 }), false);
});

test('withinQuietHours: same-day window inclusive of start, exclusive of end', () => {
  const settings = { quietHoursEnabled: true, quietHoursStart: 9, quietHoursEnd: 17 };
  // 14:00 Berlin should match
  assert.equal(withinQuietHours(new Date('2026-04-25T12:00:00Z'), settings), true);
  // 08:00 Berlin (06:00 UTC) shouldn't
  assert.equal(withinQuietHours(new Date('2026-04-25T06:00:00Z'), settings), false);
  // 17:00 Berlin (15:00 UTC) shouldn't (exclusive of end)
  assert.equal(withinQuietHours(new Date('2026-04-25T15:00:00Z'), settings), false);
});

test('withinQuietHours: wrap-around window (22:00-07:00) catches both halves', () => {
  const settings = { quietHoursEnabled: true, quietHoursStart: 22, quietHoursEnd: 7 };
  // 23:00 Berlin → 21:00 UTC (in CEST)
  assert.equal(withinQuietHours(new Date('2026-04-25T21:00:00Z'), settings), true);
  // 03:00 Berlin → 01:00 UTC (next day)
  assert.equal(withinQuietHours(new Date('2026-04-25T01:00:00Z'), settings), true);
  // 14:00 Berlin → 12:00 UTC
  assert.equal(withinQuietHours(new Date('2026-04-25T12:00:00Z'), settings), false);
});

test('withinQuietHours: empty window (start === end) returns false', () => {
  const settings = { quietHoursEnabled: true, quietHoursStart: 10, quietHoursEnd: 10 };
  assert.equal(withinQuietHours(new Date('2026-04-25T08:00:00Z'), settings), false);
});

test('msUntilQuietHoursEnd: returns 0 when not in window', () => {
  const settings = { quietHoursEnabled: false, quietHoursStart: 22, quietHoursEnd: 7 };
  assert.equal(msUntilQuietHoursEnd(Date.now(), settings), 0);
});

test('msUntilQuietHoursEnd: same-day window — counts ms until end hour', () => {
  // Berlin local 10:00 (08:00 UTC during CEST), window 09-17 → 7h to go
  const settings = { quietHoursEnabled: true, quietHoursStart: 9, quietHoursEnd: 17 };
  const noon = new Date('2026-04-25T08:00:00Z'); // 10:00 Berlin
  const ms = msUntilQuietHoursEnd(noon, settings);
  // Expect approximately 7h = 25_200_000 ms (allow 1min slack for tz seconds)
  assert.ok(ms >= 7 * 60 * 60_000 - 60_000 && ms <= 7 * 60 * 60_000 + 60_000, `got ${ms}`);
});

test('msUntilQuietHoursEnd: wrap-around window evening half — until tomorrow morning', () => {
  // Berlin 23:00 (21:00 UTC), window 22-07 → 8h to go
  const settings = { quietHoursEnabled: true, quietHoursStart: 22, quietHoursEnd: 7 };
  const evening = new Date('2026-04-25T21:00:00Z');
  const ms = msUntilQuietHoursEnd(evening, settings);
  assert.ok(ms >= 8 * 60 * 60_000 - 60_000 && ms <= 8 * 60 * 60_000 + 60_000, `got ${ms}`);
});

test('msUntilQuietHoursEnd: wrap-around window morning half — until end this morning', () => {
  // Berlin 03:00 (01:00 UTC), window 22-07 → 4h to go
  const settings = { quietHoursEnabled: true, quietHoursStart: 22, quietHoursEnd: 7 };
  const earlyAm = new Date('2026-04-25T01:00:00Z');
  const ms = msUntilQuietHoursEnd(earlyAm, settings);
  assert.ok(ms >= 4 * 60 * 60_000 - 60_000 && ms <= 4 * 60 * 60_000 + 60_000, `got ${ms}`);
});

// ---------------- shouldInjectLongPause / longPauseDuration ----------------

test('shouldInjectLongPause: prob=0 never fires', () => {
  for (let i = 0; i < 50; i++) {
    assert.equal(shouldInjectLongPause(() => i / 50, { longPauseProb: 0 }), false);
  }
});

test('shouldInjectLongPause: prob=1 always fires', () => {
  for (let i = 0; i < 10; i++) {
    assert.equal(shouldInjectLongPause(Math.random, { longPauseProb: 1 }), true);
  }
});

test('shouldInjectLongPause: rand below threshold returns true', () => {
  assert.equal(shouldInjectLongPause(() => 0.05, { longPauseProb: 0.1 }), true);
  assert.equal(shouldInjectLongPause(() => 0.15, { longPauseProb: 0.1 }), false);
});

test('longPauseDuration: bounded by [min, max]', () => {
  const settings = { longPauseMinSeconds: 180, longPauseMaxSeconds: 420 };
  assert.equal(longPauseDuration(() => 0,   settings), 180_000);
  assert.equal(longPauseDuration(() => 1,   settings), 420_000);
  assert.equal(longPauseDuration(() => 0.5, settings), 300_000);
});

// ---------------- evaluateGuards ----------------

function baseInput() {
  return {
    runtime: {
      dailyCount: 0,
      autoPaused: false,
      autoBackoffPausedAt: 0,
      hourlyBuckets: [],
      pendingWrites: []
    },
    settings: {
      autoMode: 'on',
      safetyMode: true,
      minIntervalSeconds: 10,
      hourlyCap: 30,
      dailyTarget: 100,
      quietHoursEnabled: false
    },
    now: 1_700_000_000_000
  };
}

test('evaluateGuards: blocks when auto is off', () => {
  const i = baseInput();
  i.settings.autoMode = 'off';
  const r = evaluateGuards(i);
  assert.equal(r.proceed, false);
  assert.equal(r.reason, 'auto_off');
});

test('evaluateGuards: blocks when user paused', () => {
  const i = baseInput();
  i.runtime.autoPaused = true;
  const r = evaluateGuards(i);
  assert.equal(r.proceed, false);
  assert.equal(r.reason, 'auto_paused_by_user');
});

test('evaluateGuards: blocks on backoff', () => {
  const i = baseInput();
  i.runtime.autoBackoffPausedAt = i.now - 1000;
  const r = evaluateGuards(i);
  assert.equal(r.proceed, false);
  assert.equal(r.reason, 'auto_backoff');
});

test('evaluateGuards: blocks on daily target reached', () => {
  const i = baseInput();
  i.runtime.dailyCount = 100;
  const r = evaluateGuards(i);
  assert.equal(r.proceed, false);
  assert.equal(r.reason, 'daily_target_reached');
});

test('evaluateGuards: blocks when pendingWrites > 5', () => {
  const i = baseInput();
  for (let n = 0; n < 6; n++) {
    i.runtime.pendingWrites.push({ row: n, status: 'gesendet', date: '', queuedAt: i.now });
  }
  const r = evaluateGuards(i);
  assert.equal(r.proceed, false);
  assert.equal(r.reason, 'pending_writes_backlog');
});

test('evaluateGuards: blocks when oldest pendingWrite > 5 min', () => {
  const i = baseInput();
  i.runtime.pendingWrites.push({ row: 1, status: 'gesendet', date: '', queuedAt: i.now - 6 * 60_000 });
  const r = evaluateGuards(i);
  assert.equal(r.proceed, false);
  assert.equal(r.reason, 'pending_writes_backlog');
});

test('evaluateGuards: soft-throttles in quiet hours with retryAfterMs', () => {
  const i = baseInput();
  i.settings.quietHoursEnabled = true;
  i.settings.quietHoursStart = 0;
  i.settings.quietHoursEnd = 23;
  // Time within quiet window
  i.now = new Date('2026-04-25T08:00:00Z').getTime(); // 10:00 Berlin
  const r = evaluateGuards(i);
  assert.equal(r.proceed, false);
  assert.equal(r.reason, 'quiet_hours');
  assert.ok(typeof r.retryAfterMs === 'number' && r.retryAfterMs > 0);
});

test('evaluateGuards: soft-throttles when hourly cap met', () => {
  const i = baseInput();
  i.settings.hourlyCap = 3;
  // 3 buckets all within last hour
  i.runtime.hourlyBuckets = [
    { ts: i.now - 30 * 60_000 },
    { ts: i.now - 20 * 60_000 },
    { ts: i.now - 10 * 60_000 }
  ];
  const r = evaluateGuards(i);
  assert.equal(r.proceed, false);
  assert.match(String(r.reason), /^hourly_cap_throttled/);
  assert.ok(typeof r.retryAfterMs === 'number' && r.retryAfterMs > 0);
});

test('evaluateGuards: ages out hourly buckets older than the window', () => {
  const i = baseInput();
  i.settings.hourlyCap = 3;
  i.runtime.hourlyBuckets = [
    { ts: i.now - 90 * 60_000 },        // older than 1h — should be ignored
    { ts: i.now - 80 * 60_000 },
    { ts: i.now - 70 * 60_000 }
  ];
  const r = evaluateGuards(i);
  assert.equal(r.proceed, true);
});

test('evaluateGuards: passes when nothing blocks', () => {
  const r = evaluateGuards(baseInput());
  assert.equal(r.proceed, true);
});

test('evaluateGuards: hourly cap ignored when safetyMode false', () => {
  const i = baseInput();
  i.settings.safetyMode = false;
  i.settings.hourlyCap = 1;
  i.runtime.hourlyBuckets = [
    { ts: i.now - 5 * 60_000 },
    { ts: i.now - 2 * 60_000 }
  ];
  const r = evaluateGuards(i);
  assert.equal(r.proceed, true);
});

// ---------------- detectAuthChallengeUrl ----------------

test('detectAuthChallengeUrl: matches /checkpoint/', () => {
  assert.equal(detectAuthChallengeUrl('https://www.linkedin.com/checkpoint/lg/login-submit'), true);
  assert.equal(detectAuthChallengeUrl('https://linkedin.com/checkpoint/challenge/AgEFr'), true);
  assert.equal(detectAuthChallengeUrl('https://www.linkedin.com/checkpoint?next=foo'), true);
});

test('detectAuthChallengeUrl: matches /uas/login', () => {
  assert.equal(detectAuthChallengeUrl('https://www.linkedin.com/uas/login'), true);
  assert.equal(detectAuthChallengeUrl('https://www.linkedin.com/uas/consumer/something'), true);
});

test('detectAuthChallengeUrl: matches /captcha', () => {
  assert.equal(detectAuthChallengeUrl('https://www.linkedin.com/captcha/v2'), true);
});

test('detectAuthChallengeUrl: matches /login', () => {
  assert.equal(detectAuthChallengeUrl('https://linkedin.com/login'), true);
  assert.equal(detectAuthChallengeUrl('https://www.linkedin.com/login?session=foo'), true);
});

test('detectAuthChallengeUrl: does NOT match normal Recruiter URLs', () => {
  assert.equal(detectAuthChallengeUrl('https://www.linkedin.com/talent/profile/AgEAA'), false);
  assert.equal(detectAuthChallengeUrl('https://www.linkedin.com/in/jondoe/'), false);
  assert.equal(detectAuthChallengeUrl('https://www.linkedin.com/feed/'), false);
});

test('detectAuthChallengeUrl: handles malformed input', () => {
  assert.equal(detectAuthChallengeUrl(''), false);
  assert.equal(detectAuthChallengeUrl(/** @type {any} */ (null)), false);
  assert.equal(detectAuthChallengeUrl(/** @type {any} */ (undefined)), false);
  assert.equal(detectAuthChallengeUrl(/** @type {any} */ (123)), false);
});

test('detectAuthChallengeUrl: does not false-positive on substrings inside /talent/ paths', () => {
  // Defensive: if LinkedIn ever named a recruiter route "checkpoint-something",
  // we should only fire on a leading-slash path segment.
  assert.equal(detectAuthChallengeUrl('https://www.linkedin.com/talent/checkpointed-team'), false);
});
