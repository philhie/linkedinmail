import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  findTierMatch, appendPendingWrite, drainPendingWrites,
  TIER_SCAN_LIMIT, PREFETCH_BATCH
} from '../lib/sw_logic.js';

function makeMockSheets({ rowsByNumber = {}, throwOn = null } = {}) {
  const calls = { readRange: [], writeStatus: [] };
  return {
    calls,
    async readRow(_settings, row) {
      return rowsByNumber[row] || { row, tier: '', firstName: '', lastName: '' };
    },
    async readRange(_settings, start, end) {
      calls.readRange.push({ start, end });
      const out = [];
      for (let r = start; r <= end; r++) {
        out.push(rowsByNumber[r] || { row: r, tier: '' });
      }
      return out;
    },
    async writeStatus(_settings, row, status, date) {
      calls.writeStatus.push({ row, status, date });
      if (throwOn && throwOn.row === row) {
        throw new Error(throwOn.message || 'mock_write_failed');
      }
      return { ok: true, row };
    },
    async ping() { return { sheetName: 'Outreach' }; }
  };
}

// ----- findTierMatch -----

test('findTierMatch returns startRow immediately when filter is All', async () => {
  const sheetsClient = makeMockSheets();
  const out = await findTierMatch(
    { tierFilter: 'All', startRow: 2 }, {}, 5, 'next', sheetsClient
  );
  assert.equal(out.row, 5);
  assert.equal(sheetsClient.calls.readRange.length, 0);
});

test('findTierMatch forward batches via readRange and finds first matching tier', async () => {
  const rows = {};
  for (let r = 2; r <= 100; r++) rows[r] = { row: r, tier: r === 17 ? 'S' : 'B' };
  const sheetsClient = makeMockSheets({ rowsByNumber: rows });
  const out = await findTierMatch(
    { tierFilter: 'S', startRow: 2 }, {}, 5, 'next', sheetsClient,
    { batchSize: 5, scanLimit: 50 }
  );
  assert.equal(out.row, 17);
  // Should have batched 5,6,7,8,9 then 10..14 then 15..19 → 3 calls
  assert.equal(sheetsClient.calls.readRange.length, 3);
});

test('findTierMatch forward returns startRow when no match in scan window', async () => {
  const rows = {};
  for (let r = 2; r <= 100; r++) rows[r] = { row: r, tier: 'B' };
  const sheetsClient = makeMockSheets({ rowsByNumber: rows });
  const out = await findTierMatch(
    { tierFilter: 'S', startRow: 2 }, {}, 5, 'next', sheetsClient,
    { batchSize: 5, scanLimit: 25 }
  );
  assert.equal(out.row, 5);
});

test('findTierMatch backward batches and finds matching tier', async () => {
  const rows = {};
  for (let r = 2; r <= 100; r++) rows[r] = { row: r, tier: r === 30 ? 'S' : 'B' };
  const sheetsClient = makeMockSheets({ rowsByNumber: rows });
  const out = await findTierMatch(
    { tierFilter: 'S', startRow: 2 }, {}, 50, 'prev', sheetsClient,
    { batchSize: 10, scanLimit: 50 }
  );
  assert.equal(out.row, 30);
});

test('findTierMatch backward stops at startRow boundary', async () => {
  const rows = {};
  for (let r = 2; r <= 100; r++) rows[r] = { row: r, tier: 'B' };
  const sheetsClient = makeMockSheets({ rowsByNumber: rows });
  const out = await findTierMatch(
    { tierFilter: 'S', startRow: 2 }, {}, 10, 'prev', sheetsClient,
    { batchSize: 5, scanLimit: 50 }
  );
  assert.equal(out.row, 10); // no match → returns startRow
});

test('findTierMatch caches scanned leads', async () => {
  const rows = {};
  for (let r = 2; r <= 50; r++) rows[r] = { row: r, tier: r === 7 ? 'S' : 'B' };
  const sheetsClient = makeMockSheets({ rowsByNumber: rows });
  const out = await findTierMatch(
    { tierFilter: 'S', startRow: 2 }, {}, 2, 'next', sheetsClient,
    { batchSize: 5, scanLimit: 50 }
  );
  assert.equal(out.row, 7);
  // Cache uses prefixed keys (r2, r7) — see lib/state.js getCachedLead.
  assert.ok(out.cache.r2, 'should have cached row 2');
  assert.ok(out.cache.r7, 'should have cached row 7');
});

// ----- appendPendingWrite -----

test('appendPendingWrite returns new array, original unchanged', () => {
  const before = [];
  const after = appendPendingWrite(before, 5, 'gesendet', '25.04.2026', 1000);
  assert.equal(before.length, 0);
  assert.equal(after.length, 1);
  assert.deepEqual(after[0], { row: 5, status: 'gesendet', date: '25.04.2026', queuedAt: 1000 });
});

test('appendPendingWrite preserves existing queue', () => {
  const before = [{ row: 1, status: 'gesendet', date: 'd', queuedAt: 0 }];
  const after = appendPendingWrite(before, 2, 'gesendet', 'd', 100);
  assert.equal(after.length, 2);
  assert.equal(after[0].row, 1);
  assert.equal(after[1].row, 2);
});

test('appendPendingWrite handles null queue', () => {
  const after = appendPendingWrite(null, 5, 'gesendet', 'd', 1);
  assert.equal(after.length, 1);
});

// ----- drainPendingWrites -----

test('drainPendingWrites empty queue is no-op', async () => {
  const sheetsClient = makeMockSheets();
  const res = await drainPendingWrites(
    { appsScriptUrl: 'x', appsScriptToken: 'y' }, [], sheetsClient
  );
  assert.deepEqual(res.remaining, []);
  assert.deepEqual(res.completed, []);
  assert.equal(res.error, null);
});

test('drainPendingWrites refuses to drain without credentials', async () => {
  const sheetsClient = makeMockSheets();
  const res = await drainPendingWrites(
    {}, [{ row: 5, status: 'gesendet', date: 'd', queuedAt: 0 }], sheetsClient
  );
  assert.equal(res.remaining.length, 1);
  assert.equal(res.completed.length, 0);
  assert.equal(res.error, 'not_configured');
});

test('drainPendingWrites drains all on success', async () => {
  const sheetsClient = makeMockSheets();
  const writes = [
    { row: 2, status: 'gesendet', date: 'd', queuedAt: 1 },
    { row: 3, status: 'gesendet', date: 'd', queuedAt: 2 },
    { row: 4, status: 'gesendet', date: 'd', queuedAt: 3 }
  ];
  const res = await drainPendingWrites(
    { appsScriptUrl: 'x', appsScriptToken: 'y' }, writes, sheetsClient
  );
  assert.equal(res.remaining.length, 0);
  assert.equal(res.completed.length, 3);
  assert.equal(res.error, null);
  assert.equal(sheetsClient.calls.writeStatus.length, 3);
});

test('drainPendingWrites stops at first failure', async () => {
  const sheetsClient = makeMockSheets({ throwOn: { row: 3, message: 'http_500' } });
  const writes = [
    { row: 2, status: 'gesendet', date: 'd', queuedAt: 1 },
    { row: 3, status: 'gesendet', date: 'd', queuedAt: 2 },
    { row: 4, status: 'gesendet', date: 'd', queuedAt: 3 }
  ];
  const res = await drainPendingWrites(
    { appsScriptUrl: 'x', appsScriptToken: 'y' }, writes, sheetsClient
  );
  // Row 2 succeeded, row 3 failed → row 3 and 4 stay in queue.
  assert.equal(res.remaining.length, 2);
  assert.equal(res.remaining[0].row, 3);
  assert.equal(res.remaining[1].row, 4);
  assert.equal(res.completed.length, 1);
  assert.equal(res.completed[0].row, 2);
  assert.equal(res.error, 'http_500');
});

test('TIER_SCAN_LIMIT and PREFETCH_BATCH are exported', () => {
  assert.equal(typeof TIER_SCAN_LIMIT, 'number');
  assert.equal(typeof PREFETCH_BATCH, 'number');
});
