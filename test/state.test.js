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
  migrateTokenStorageOnce,
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
