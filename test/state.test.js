import './_mock_chrome.js';
import { resetChrome, getStorage } from './_mock_chrome.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  berlinIsoDate,
  berlinDeDate,
  maybeResetDaily,
  appendLeadCache,
  getCachedLead,
  activePendingFill,
  loadSettings,
  saveSettings,
  loadRuntime,
  saveRuntime,
  withRuntime,
  migrateTokenStorageOnce,
  nextExpiryFor,
  STAGE_TTLS,
  PENDING_FILL_TTL_MS,
  SETTINGS_DEFAULTS,
  RUNTIME_DEFAULTS
} from '../lib/state.js';

test('berlinIsoDate formats yyyy-mm-dd in Europe/Berlin', () => {
  const noon = new Date('2026-04-25T12:00:00Z');
  assert.equal(berlinIsoDate(noon), '2026-04-25');
});

test('berlinDeDate formats DD.MM.YYYY in Europe/Berlin', () => {
  const noon = new Date('2026-04-25T12:00:00Z');
  assert.equal(berlinDeDate(noon), '25.04.2026');
});

test('berlinDeDate handles single-digit months/days', () => {
  const jan3 = new Date('2026-01-03T12:00:00Z');
  assert.equal(berlinDeDate(jan3), '03.01.2026');
});

test('maybeResetDaily zeroes count when day rolled over', () => {
  const yesterday = new Date('2026-04-24T22:00:00Z'); // 00:00 Berlin Apr 25
  const before = {
    ...RUNTIME_DEFAULTS,
    dailyCount: 47,
    dailySentRows: [10, 11, 12],
    lastResetDate: '2026-04-24',
    todaysTargetOverride: 25
  };
  const today = new Date('2026-04-25T12:00:00Z');
  const after = maybeResetDaily(before, today);
  assert.equal(after.dailyCount, 0);
  assert.deepEqual(after.dailySentRows, []);
  assert.equal(after.lastResetDate, '2026-04-25');
  assert.equal(after.todaysTargetOverride, 0);
});

test('maybeResetDaily is no-op when same day', () => {
  const before = {
    ...RUNTIME_DEFAULTS,
    dailyCount: 47,
    lastResetDate: '2026-04-25'
  };
  const today = new Date('2026-04-25T12:00:00Z');
  const after = maybeResetDaily(before, today);
  assert.strictEqual(after, before);
  assert.equal(after.dailyCount, 47);
});

test('appendLeadCache adds new entries and evicts oldest beyond max size', () => {
  const cache = {};
  const leads = [];
  for (let i = 1; i <= 5; i++) leads.push({ row: i, firstName: `name${i}` });
  const next = appendLeadCache(cache, leads, /* max */ 3);
  // Inserted in order 1..5, max=3, evict oldest first → keeps 3,4,5.
  assert.equal(Object.keys(next).length, 3);
  assert.ok(getCachedLead(next, 3));
  assert.ok(getCachedLead(next, 4));
  assert.ok(getCachedLead(next, 5));
  assert.ok(!getCachedLead(next, 1));
  assert.ok(!getCachedLead(next, 2));
});

test('appendLeadCache does not mutate original cache', () => {
  const cache = { r1: { row: 1, firstName: 'orig' } };
  appendLeadCache(cache, [{ row: 2, firstName: 'new' }]);
  assert.deepEqual(cache, { r1: { row: 1, firstName: 'orig' } });
});

test('getCachedLead returns undefined for missing rows / null cache', () => {
  assert.equal(getCachedLead({}, 5), undefined);
  assert.equal(getCachedLead(null, 5), undefined);
  assert.equal(getCachedLead(undefined, 5), undefined);
});

test('activePendingFill returns null for missing/expired/malformed', () => {
  assert.equal(activePendingFill(null), null);
  assert.equal(activePendingFill(undefined), null);
  assert.equal(activePendingFill({}), null);
  assert.equal(activePendingFill({ expiresAt: 1000 }, 5000), null);
});

test('activePendingFill returns object when not yet expired', () => {
  const p = { row: 5, inmail: 'hi', followUp: '', stage: 'await_recruiter', startedAt: 1000, expiresAt: 5000 };
  assert.deepEqual(activePendingFill(p, 4000), p);
});

test('activePendingFill returns null when expired by exactly 1ms', () => {
  const p = { row: 1, expiresAt: 1000 };
  assert.equal(activePendingFill(p, 1001), null);
});

test('activePendingFill returns object at exact expiry boundary', () => {
  const p = { row: 1, expiresAt: 1000 };
  // 1000 is NOT > 1000, so still active.
  assert.equal(activePendingFill(p, 1000), p);
});

test('appendLeadCache LRU re-inserts touched leads', () => {
  let cache = appendLeadCache({}, [
    { row: 1, firstName: 'a' },
    { row: 2, firstName: 'b' },
    { row: 3, firstName: 'c' }
  ], 3);
  // Touch row 1 — should bump it to most-recently-used.
  cache = appendLeadCache(cache, [{ row: 1, firstName: 'a-touched' }], 3);
  // Now insert row 4 — should evict row 2 (least recently used), NOT row 1.
  cache = appendLeadCache(cache, [{ row: 4, firstName: 'd' }], 3);
  assert.ok(getCachedLead(cache, 1), 'row 1 (recently touched) should remain');
  assert.ok(getCachedLead(cache, 3));
  assert.ok(getCachedLead(cache, 4));
  assert.ok(!getCachedLead(cache, 2), 'row 2 (least recently used) should be evicted');
  assert.equal(getCachedLead(cache, 1).firstName, 'a-touched');
});

test('appendLeadCache reverse-insertion order also evicts oldest insert', () => {
  // Insert 5,4,3,2,1 with maxSize=3 → cache should hold 3,2,1 (most recent).
  let cache = {};
  for (const r of [5, 4, 3, 2, 1]) {
    cache = appendLeadCache(cache, [{ row: r, firstName: 'x' }], 3);
  }
  assert.ok(getCachedLead(cache, 1), 'last-inserted row 1 should remain');
  assert.ok(getCachedLead(cache, 2));
  assert.ok(getCachedLead(cache, 3));
  assert.ok(!getCachedLead(cache, 4));
  assert.ok(!getCachedLead(cache, 5));
});

test('saveSettings + loadSettings: token goes to local, rest to sync', async () => {
  const { sync, local } = resetChrome();
  await saveSettings({
    sheetId: 'abc',
    appsScriptToken: 'secret-token',
    appsScriptUrl: 'https://example.com',
    dailyTarget: 50
  });
  assert.equal(local._dump().appsScriptToken, 'secret-token');
  assert.equal(sync._dump().sheetId, 'abc');
  assert.equal(sync._dump().appsScriptUrl, 'https://example.com');
  assert.equal(sync._dump().dailyTarget, 50);
  assert.ok(!('appsScriptToken' in sync._dump()), 'token should NOT be in sync storage');

  const settings = await loadSettings();
  assert.equal(settings.appsScriptToken, 'secret-token');
  assert.equal(settings.sheetId, 'abc');
});

test('migrateTokenStorageOnce moves legacy sync token to local', async () => {
  const { sync, local } = resetChrome();
  // Simulate legacy state: token is in sync storage.
  await sync.set({ appsScriptToken: 'legacy-token', sheetId: 'sid' });
  await migrateTokenStorageOnce();
  assert.equal(local._dump().appsScriptToken, 'legacy-token');
  assert.ok(!('appsScriptToken' in sync._dump()), 'legacy token removed from sync');
  assert.equal(sync._dump().sheetId, 'sid', 'other sync settings untouched');
});

test('migrateTokenStorageOnce is idempotent', async () => {
  resetChrome();
  await migrateTokenStorageOnce();
  await migrateTokenStorageOnce(); // second call shouldn't crash
  const settings = await loadSettings();
  assert.equal(settings.appsScriptToken, '');
});

test('migrateTokenStorageOnce does not overwrite existing local token', async () => {
  const { sync, local } = resetChrome();
  await local.set({ appsScriptToken: 'newer-local' });
  await sync.set({ appsScriptToken: 'older-sync' });
  await migrateTokenStorageOnce();
  assert.equal(local._dump().appsScriptToken, 'newer-local');
  assert.ok(!('appsScriptToken' in sync._dump()));
});

test('saveSettings empty patch is no-op', async () => {
  resetChrome();
  await saveSettings({});
  // Should not throw.
});

test('loadSettings returns defaults when storage empty', async () => {
  resetChrome();
  const s = await loadSettings();
  assert.equal(s.tierFilter, 'All');
  assert.equal(s.dailyTarget, 100);
  assert.equal(s.inmailSubject, 'kurze frage');
});

// ---------------- STAGE_TTLS / nextExpiryFor ----------------

test('STAGE_TTLS exposes the static stage TTLs', () => {
  assert.equal(typeof STAGE_TTLS.await_recruiter, 'number');
  assert.equal(typeof STAGE_TTLS.await_composer, 'number');
  assert.equal(typeof STAGE_TTLS.await_send_click, 'number');
  assert.equal(typeof STAGE_TTLS.await_modal, 'number');
  assert.equal(typeof STAGE_TTLS.await_success, 'number');
  assert.equal(typeof STAGE_TTLS.await_advance, 'number');
  // await_review and cooldown are settings-derived; not in the static map.
  assert.equal(STAGE_TTLS.await_review, undefined);
  assert.equal(STAGE_TTLS.cooldown, undefined);
});

test('PENDING_FILL_TTL_MS legacy alias is exported', () => {
  // Kept at 90s for backward-compat with the legacy single-TTL callsite.
  assert.equal(PENDING_FILL_TTL_MS, 90_000);
});

test('nextExpiryFor returns now + STAGE_TTL for static stages', () => {
  const now = 1_000_000;
  assert.equal(nextExpiryFor('await_recruiter', now), now + STAGE_TTLS.await_recruiter);
  assert.equal(nextExpiryFor('await_composer', now), now + STAGE_TTLS.await_composer);
  assert.equal(nextExpiryFor('await_send_click', now), now + STAGE_TTLS.await_send_click);
  assert.equal(nextExpiryFor('await_modal', now), now + STAGE_TTLS.await_modal);
  assert.equal(nextExpiryFor('await_success', now), now + STAGE_TTLS.await_success);
  assert.equal(nextExpiryFor('await_advance', now), now + STAGE_TTLS.await_advance);
});

test('nextExpiryFor("await_review") uses settings.reviewWindowMs + 5s grace', () => {
  const now = 1_000_000;
  const settings = { reviewWindowMs: 3000 };
  assert.equal(nextExpiryFor('await_review', now, { settings }), now + 3000 + 5000);
});

test('nextExpiryFor("await_review") accepts explicit reviewMs override', () => {
  const now = 1_000_000;
  // Explicit reviewMs (e.g. post-jitter) wins over settings.
  assert.equal(
    nextExpiryFor('await_review', now, { settings: { reviewWindowMs: 1000 }, reviewMs: 4500 }),
    now + 4500 + 5000
  );
});

test('nextExpiryFor("await_review") falls back to default when settings absent', () => {
  const now = 1_000_000;
  // Default reviewWindowMs is 2500.
  assert.equal(nextExpiryFor('await_review', now), now + 2500 + 5000);
});

test('nextExpiryFor("cooldown") uses minIntervalSeconds * 2 + 10s grace', () => {
  const now = 1_000_000;
  const settings = { minIntervalSeconds: 10 };
  // 10s base * 2.0 jitter max * 1000 = 20000ms + 10000ms grace = 30000.
  assert.equal(nextExpiryFor('cooldown', now, { settings }), now + 30_000);
});

test('nextExpiryFor("cooldown") accepts explicit cooldownMs override', () => {
  const now = 1_000_000;
  assert.equal(
    nextExpiryFor('cooldown', now, { cooldownMs: 45_000 }),
    now + 45_000 + 10_000
  );
});

test('nextExpiryFor unknown stage falls back to await_recruiter ttl', () => {
  const now = 1_000_000;
  assert.equal(nextExpiryFor('something_else', now), now + STAGE_TTLS.await_recruiter);
});

// ---------------- SETTINGS_DEFAULTS / RUNTIME_DEFAULTS ----------------

test('SETTINGS_DEFAULTS contains auto-mode keys', () => {
  assert.equal(SETTINGS_DEFAULTS.autoMode, 'off');
  assert.equal(SETTINGS_DEFAULTS.safetyMode, true);
  assert.equal(SETTINGS_DEFAULTS.reviewWindowMs, 2500);
  assert.equal(SETTINGS_DEFAULTS.hourlyCap, 30);
  assert.equal(SETTINGS_DEFAULTS.errorBackoffThreshold, 2);
  assert.equal(SETTINGS_DEFAULTS.intervalJitterPct, 30);
  assert.equal(typeof SETTINGS_DEFAULTS.longPauseProb, 'number');
  assert.equal(SETTINGS_DEFAULTS.quietHoursEnabled, false);
});

test('RUNTIME_DEFAULTS contains auto-mode keys', () => {
  assert.equal(RUNTIME_DEFAULTS.lastSentAt, 0);
  assert.deepEqual(RUNTIME_DEFAULTS.hourlyBuckets, []);
  assert.equal(RUNTIME_DEFAULTS.consecutiveErrors, 0);
  assert.equal(RUNTIME_DEFAULTS.lastErrorCode, '');
  assert.equal(RUNTIME_DEFAULTS.autoPaused, false);
  assert.equal(RUNTIME_DEFAULTS.autoBackoffPausedAt, 0);
  assert.equal(RUNTIME_DEFAULTS.lastAutoCycle, null);
  assert.deepEqual(RUNTIME_DEFAULTS.eventLog, []);
  assert.equal(RUNTIME_DEFAULTS.sendsSinceCanary, 0);
  assert.equal(RUNTIME_DEFAULTS.canaryNeeded, true);
});

test('loadSettings merges new auto-mode defaults over empty storage', async () => {
  resetChrome();
  const s = await loadSettings();
  assert.equal(s.autoMode, 'off');
  assert.equal(s.safetyMode, true);
});

test('loadRuntime merges new auto-mode defaults over empty storage', async () => {
  resetChrome();
  const r = await loadRuntime();
  assert.equal(r.lastSentAt, 0);
  assert.equal(r.canaryNeeded, true);
  assert.deepEqual(r.hourlyBuckets, []);
});

// ---------------- saveRuntime / withRuntime serialization ----------------

test('saveRuntime serializes overlapping writes (last write wins on overlap)', async () => {
  resetChrome();
  // Two writes in flight; serialization queue ensures the second runs after
  // the first. For chrome.storage.local the merge is shallow, so a key written
  // twice ends up with the second value.
  const p1 = saveRuntime({ dailyCount: 5 });
  const p2 = saveRuntime({ dailyCount: 7 });
  await Promise.all([p1, p2]);
  const r = await loadRuntime();
  assert.equal(r.dailyCount, 7);
});

test('saveRuntime serializes non-overlapping writes (both visible)', async () => {
  resetChrome();
  const p1 = saveRuntime({ dailyCount: 1 });
  const p2 = saveRuntime({ lastError: 'boom' });
  await Promise.all([p1, p2]);
  const r = await loadRuntime();
  assert.equal(r.dailyCount, 1);
  assert.equal(r.lastError, 'boom');
});

test('withRuntime increments a counter atomically across concurrent calls', async () => {
  resetChrome();
  // 10 concurrent increments — without the mutex these would race.
  const ops = [];
  for (let i = 0; i < 10; i++) {
    ops.push(withRuntime((rt) => ({ dailyCount: (rt.dailyCount || 0) + 1 })));
  }
  await Promise.all(ops);
  const r = await loadRuntime();
  assert.equal(r.dailyCount, 10);
});

test('withRuntime appends to an array atomically', async () => {
  resetChrome();
  const ops = [];
  for (let i = 0; i < 5; i++) {
    ops.push(withRuntime((rt) => ({
      dailySentRows: [...(rt.dailySentRows || []), i + 100]
    })));
  }
  await Promise.all(ops);
  const r = await loadRuntime();
  assert.equal(r.dailySentRows.length, 5);
  // All 100..104 should be present (set semantics, order not asserted).
  const set = new Set(r.dailySentRows);
  for (let i = 0; i < 5; i++) assert.ok(set.has(i + 100), `row ${i + 100} missing`);
});

test('withRuntime: mutator returning null is a no-op (no write)', async () => {
  resetChrome();
  await saveRuntime({ dailyCount: 42 });
  await withRuntime(() => null);
  const r = await loadRuntime();
  assert.equal(r.dailyCount, 42);
});

test('withRuntime: mutator throwing leaves storage untouched and queue unblocked', async () => {
  resetChrome();
  await saveRuntime({ dailyCount: 1 });
  await assert.rejects(
    () => withRuntime(() => { throw new Error('boom'); }),
    /boom/
  );
  // Queue should still accept subsequent writes after the rejection.
  await withRuntime((rt) => ({ dailyCount: (rt.dailyCount || 0) + 1 }));
  const r = await loadRuntime();
  assert.equal(r.dailyCount, 2);
});

test('withRuntime serializes async mutators (no interleaving)', async () => {
  resetChrome();
  await saveRuntime({ dailyCount: 0 });
  // Two mutators that "await something" mid-flight; the serialization should
  // still ensure each sees the previous one's write before computing.
  const ops = [];
  for (let i = 0; i < 5; i++) {
    ops.push(withRuntime(async (rt) => {
      // micro-yield to maximize overlap risk
      await new Promise((r) => setImmediate(r));
      return { dailyCount: (rt.dailyCount || 0) + 1 };
    }));
  }
  await Promise.all(ops);
  const r = await loadRuntime();
  assert.equal(r.dailyCount, 5);
});
