import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  findTierMatch, appendPendingWrite, drainPendingWrites,
  TIER_SCAN_LIMIT, PREFETCH_BATCH, HOURLY_WINDOW_MS,
  pruneHourlyBuckets, appendHourlyBucket, hourlyCount,
  jitteredDelay, classifySendToast, recordSentInternal
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

// ----- hourly buckets -----

test('HOURLY_WINDOW_MS equals 1 hour', () => {
  assert.equal(HOURLY_WINDOW_MS, 60 * 60 * 1000);
});

test('pruneHourlyBuckets drops entries older than the window', () => {
  const now = 10 * 60 * 60_000; // 10h
  const buckets = [
    { ts: now - 90 * 60_000 },  // 90min old → drop
    { ts: now - 30 * 60_000 },  // 30min old → keep
    { ts: now - 5  * 60_000 }   //  5min old → keep
  ];
  const out = pruneHourlyBuckets(buckets, now);
  assert.equal(out.length, 2);
});

test('pruneHourlyBuckets ignores malformed entries', () => {
  const now = 1_000_000;
  const out = pruneHourlyBuckets(
    /** @type {any} */ ([null, undefined, { ts: 'string' }, { ts: now }]),
    now
  );
  assert.equal(out.length, 1);
});

test('pruneHourlyBuckets returns empty array on null/undefined input', () => {
  assert.deepEqual(pruneHourlyBuckets(null, 0), []);
  assert.deepEqual(pruneHourlyBuckets(undefined, 0), []);
});

test('appendHourlyBucket prunes then appends', () => {
  const now = 10 * 60 * 60_000;
  const before = [
    { ts: now - 90 * 60_000 }, // expired
    { ts: now - 10 * 60_000 }
  ];
  const after = appendHourlyBucket(before, now);
  assert.equal(after.length, 2); // pruned to 1, then +1
  assert.equal(after[after.length - 1].ts, now);
});

test('hourlyCount counts only window-active entries', () => {
  const now = 1_000_000_000;
  const buckets = [
    { ts: now - 90 * 60_000 },
    { ts: now - 30 * 60_000 },
    { ts: now - 10 * 60_000 }
  ];
  assert.equal(hourlyCount(buckets, now), 2);
});

// ----- jitteredDelay -----

test('jitteredDelay: zero pctRange returns base unchanged', () => {
  assert.equal(jitteredDelay(10_000, 0), 10_000);
  assert.equal(jitteredDelay(10_000, 0, () => 0.123), 10_000);
});

test('jitteredDelay: result is bounded by [0.7×, 2.0×]', () => {
  // High variance — many draws should still stay within clamp range.
  for (let i = 0; i < 200; i++) {
    const d = jitteredDelay(10_000, 50);
    assert.ok(d >= 7_000, `${d} below floor`);
    assert.ok(d <= 20_000, `${d} above ceiling`);
  }
});

test('jitteredDelay: deterministic with injected rand', () => {
  // Same seed → same result.
  const seq = [0.1, 0.2, 0.3, 0.4];
  let i = 0;
  const rand = () => seq[(i++) % seq.length];
  let j = 0;
  const rand2 = () => seq[(j++) % seq.length];
  assert.equal(jitteredDelay(10_000, 30, rand), jitteredDelay(10_000, 30, rand2));
});

test('jitteredDelay: median-ish over many draws is close to base', () => {
  const draws = [];
  for (let i = 0; i < 1000; i++) draws.push(jitteredDelay(10_000, 30));
  draws.sort((a, b) => a - b);
  const median = draws[500];
  // Lognormal median with σ=30% should sit close to base — allow ±15% slack.
  assert.ok(median >= 8_500 && median <= 11_500, `median ${median} out of range`);
});

test('jitteredDelay: zero/negative base returns 0', () => {
  assert.equal(jitteredDelay(0, 30), 0);
  assert.equal(jitteredDelay(-100, 30), 0);
});

// ----- classifySendToast -----

test('classifySendToast: positive German', () => {
  assert.equal(classifySendToast('InMail gesendet'), 'positive');
  assert.equal(classifySendToast('Nachricht gesendet'), 'positive');
  assert.equal(classifySendToast('Ihre InMail wurde gesendet'), 'positive');
  assert.equal(classifySendToast('Gesendet'), 'positive');
});

test('classifySendToast: positive English', () => {
  assert.equal(classifySendToast('InMail sent'), 'positive');
  assert.equal(classifySendToast('Message sent'), 'positive');
  assert.equal(classifySendToast('Sent'), 'positive');
});

test('classifySendToast: negative rate-limit / spam', () => {
  assert.equal(classifySendToast('Sie haben zu viele Nachrichten gesendet'), 'negative');
  assert.equal(classifySendToast('You have sent too many messages'), 'negative');
  assert.equal(classifySendToast('Please wait before trying again'), 'negative');
  assert.equal(classifySendToast('Your account has been flagged for spam'), 'negative');
  assert.equal(classifySendToast('Account is restricted'), 'negative');
  assert.equal(classifySendToast('Ihr Konto wurde eingeschränkt'), 'negative');
});

test('classifySendToast: unknown text', () => {
  assert.equal(classifySendToast('Saved as draft'), 'unknown');
  assert.equal(classifySendToast('Connection accepted'), 'unknown');
  assert.equal(classifySendToast(''), 'unknown');
  assert.equal(classifySendToast(/** @type {any} */ (null)), 'unknown');
});

test('classifySendToast: negative wins over coincidental positive substring', () => {
  // If a toast says "too many messages, but message sent", we treat it as
  // negative — hard fail closed. (Synthetic example to lock the priority.)
  assert.equal(classifySendToast('too many; message sent earlier was lost'), 'negative');
});

// ----- recordSentInternal -----

test('recordSentInternal: builds the patch for a fresh runtime (auto)', () => {
  const runtime = {
    pendingWrites: [],
    dailyCount: 0,
    dailySentRows: [],
    hourlyBuckets: [],
    sendsSinceCanary: 0,
    lastResetDate: '2026-04-25'
  };
  const now = 1_700_000_000_000;
  const patch = recordSentInternal(runtime, /* row */ 7, '25.04.2026', now, 'auto');
  assert.equal(patch.dailyCount, 1);
  assert.deepEqual(patch.dailySentRows, [7]);
  assert.equal(patch.pendingWrites.length, 1);
  assert.equal(patch.pendingWrites[0].row, 7);
  assert.equal(patch.pendingWrites[0].status, 'gesendet');
  assert.equal(patch.hourlyBuckets.length, 1);
  assert.equal(patch.hourlyBuckets[0].ts, now);
  assert.equal(patch.lastSentAt, now);
  assert.equal(patch.sendsSinceCanary, 1);
  assert.equal(patch.consecutiveErrors, 0, 'auto source resets the error streak');
  assert.equal(patch.lastError, '');
});

test('recordSentInternal (auto): resets consecutiveErrors back to 0', () => {
  const runtime = {
    pendingWrites: [], dailyCount: 0, dailySentRows: [], hourlyBuckets: [],
    sendsSinceCanary: 0, lastResetDate: '',
    // Pretend a streak of 3 errors preceded this auto success
    consecutiveErrors: 3
  };
  const patch = recordSentInternal(runtime, 1, '25.04.2026', 1000, 'auto');
  assert.equal(patch.consecutiveErrors, 0);
});

test('recordSentInternal (manual): does NOT touch consecutiveErrors', () => {
  const runtime = {
    pendingWrites: [], dailyCount: 0, dailySentRows: [], hourlyBuckets: [],
    sendsSinceCanary: 0, lastResetDate: '',
    consecutiveErrors: 3
  };
  // Default `source` is 'manual' to avoid masking auto-mode error streaks
  // when Phil happens to mark another row sent by hand.
  const patch = recordSentInternal(runtime, 1, '25.04.2026', 1000);
  assert.ok(!('consecutiveErrors' in patch),
            'manual source must not include consecutiveErrors in the patch');
});

test('recordSentInternal: increments existing counters', () => {
  const runtime = {
    pendingWrites: [{ row: 1, status: 'gesendet', date: 'x', queuedAt: 1 }],
    dailyCount: 5,
    dailySentRows: [1, 2, 3],
    hourlyBuckets: [{ ts: 100 }, { ts: 200 }],
    sendsSinceCanary: 3,
    lastResetDate: '2026-04-25'
  };
  const now = 10 * 60 * 60_000;
  const patch = recordSentInternal(runtime, 9, '25.04.2026', now);
  assert.equal(patch.dailyCount, 6);
  assert.deepEqual(patch.dailySentRows, [1, 2, 3, 9]);
  assert.equal(patch.pendingWrites.length, 2);
  assert.equal(patch.sendsSinceCanary, 4);
});

test('recordSentInternal: prunes hourlyBuckets when appending', () => {
  const now = 10 * 60 * 60_000;
  const runtime = {
    pendingWrites: [],
    dailyCount: 0,
    dailySentRows: [],
    hourlyBuckets: [{ ts: now - 90 * 60_000 }], // expired
    sendsSinceCanary: 0,
    lastResetDate: ''
  };
  const patch = recordSentInternal(runtime, 1, 'x', now);
  assert.equal(patch.hourlyBuckets.length, 1, 'expired bucket pruned, only the new one remains');
  assert.equal(patch.hourlyBuckets[0].ts, now);
});

test('recordSentInternal: handles missing/undefined fields on runtime', () => {
  const patch = recordSentInternal(/** @type {any} */ ({}), 1, 'x', 1000);
  assert.equal(patch.dailyCount, 1);
  assert.deepEqual(patch.dailySentRows, [1]);
  assert.equal(patch.pendingWrites.length, 1);
  assert.equal(patch.lastSentAt, 1000);
});
