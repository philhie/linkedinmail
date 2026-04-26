import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appendEvent, recentEvents, DEFAULT_MAX_EVENTS } from '../lib/telemetry.js';

test('appendEvent: adds an event and returns a new array (does not mutate)', () => {
  const before = [];
  const after = appendEvent(before, { ts: 1, action: 'enter_stage', outcome: 'ok' });
  assert.equal(before.length, 0);
  assert.equal(after.length, 1);
  assert.equal(after[0].action, 'enter_stage');
});

test('appendEvent: trims oldest entries when over max', () => {
  let buf = [];
  for (let i = 0; i < 5; i++) {
    buf = appendEvent(buf, { ts: i, action: `act_${i}`, outcome: 'ok' }, /* max */ 3);
  }
  assert.equal(buf.length, 3);
  assert.equal(buf[0].action, 'act_2');
  assert.equal(buf[2].action, 'act_4');
});

test('appendEvent: defaults max to DEFAULT_MAX_EVENTS (50)', () => {
  let buf = [];
  for (let i = 0; i < DEFAULT_MAX_EVENTS + 10; i++) {
    buf = appendEvent(buf, { ts: i, action: 'x', outcome: 'ok' });
  }
  assert.equal(buf.length, DEFAULT_MAX_EVENTS);
});

test('appendEvent: handles null/undefined buffer', () => {
  const a = appendEvent(null, { ts: 1, action: 'x', outcome: 'ok' });
  const b = appendEvent(undefined, { ts: 1, action: 'x', outcome: 'ok' });
  assert.equal(a.length, 1);
  assert.equal(b.length, 1);
});

test('appendEvent: sanitizes — drops fields not in the allowlist', () => {
  const evt = {
    ts: 1, action: 'send_clicked', outcome: 'ok',
    cycleId: 'c1', row: 5,
    inmail: 'SECRET BODY', followUp: 'SECRET FOLLOWUP',
    randomField: 'should be dropped'
  };
  const buf = appendEvent([], evt);
  assert.equal(buf.length, 1);
  const stored = buf[0];
  assert.equal(stored.cycleId, 'c1');
  assert.equal(stored.row, 5);
  assert.ok(!('inmail' in stored), 'inmail must be dropped');
  assert.ok(!('followUp' in stored), 'followUp must be dropped');
  assert.ok(!('randomField' in stored));
});

test('appendEvent: outcome defaults to "ok" when invalid', () => {
  const buf = appendEvent([], { ts: 1, action: 'x', outcome: /** @type {any} */ ('bogus') });
  assert.equal(buf[0].outcome, 'ok');
});

test('appendEvent: detail is truncated to 200 chars', () => {
  const long = 'a'.repeat(500);
  const buf = appendEvent([], { ts: 1, action: 'x', outcome: 'ok', detail: long });
  assert.equal(buf[0].detail.length, 200);
});

test('appendEvent: missing ts falls back to Date.now()', () => {
  const before = Date.now();
  const buf = appendEvent([], /** @type {any} */ ({ action: 'x', outcome: 'ok' }));
  const after = Date.now();
  assert.ok(buf[0].ts >= before && buf[0].ts <= after);
});

test('recentEvents: returns last N entries', () => {
  let buf = [];
  for (let i = 0; i < 10; i++) {
    buf = appendEvent(buf, { ts: i, action: `a${i}`, outcome: 'ok' });
  }
  const last3 = recentEvents(buf, 3);
  assert.equal(last3.length, 3);
  assert.equal(last3[0].action, 'a7');
  assert.equal(last3[2].action, 'a9');
});

test('recentEvents: handles null / 0 / negative N', () => {
  assert.deepEqual(recentEvents(null), []);
  assert.deepEqual(recentEvents([{ ts: 1, action: 'x', outcome: 'ok' }], 0), []);
  assert.deepEqual(recentEvents([{ ts: 1, action: 'x', outcome: 'ok' }], -5), []);
});

test('recentEvents: returns whole array if N exceeds size', () => {
  const buf = appendEvent([], { ts: 1, action: 'x', outcome: 'ok' });
  assert.equal(recentEvents(buf, 100).length, 1);
});
