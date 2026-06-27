// settings.test.js — board-config engine over an injected store (current/update/history).
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createSettings } = require('../settings');

function fakeStore() {
  const db = { settings: {}, settingsHistory: [] };
  return { _db: db, load: () => db, save() {} };
}
const defaults = { feeBp: 500, maxHours: 10 };
const limits = { feeBp: [0, 2000], maxHours: [4, 16] };

test('current() = defaults merged over persisted', () => {
  const s = createSettings({ store: fakeStore(), defaults, limits });
  assert.deepEqual(s.current(), { feeBp: 500, maxHours: 10 });
});

test('update() validates, persists, returns merged, and records history', () => {
  const store = fakeStore();
  const s = createSettings({ store, defaults, limits });
  const out = s.update({ feeBp: 750, ignored: 99 }, 'admin@x');
  assert.equal(out.feeBp, 750);
  assert.equal(store._db.settings.feeBp, 750);
  const h = s.history();
  assert.equal(h.length, 1);
  assert.deepEqual(h[0].changes, { feeBp: 750 });
  assert.equal(h[0].previous.feeBp, 500);
  assert.equal(h[0].by, 'admin@x');
});

test('update() rejects out-of-range (400) and empty patches (400)', () => {
  const s = createSettings({ store: fakeStore(), defaults, limits });
  assert.throws(() => s.update({ feeBp: 99999 }, 'a'), e => e.status === 400);
  assert.throws(() => s.update({ nothingValid: 1 }, 'a'), e => e.status === 400);
});

test('history() is newest-first, capped at 50', () => {
  const s = createSettings({ store: fakeStore(), defaults, limits });
  for (let i = 0; i < 55; i++) s.update({ maxHours: 4 + (i % 12) }, 'a');
  const h = s.history();
  assert.equal(h.length, 50);
  assert.ok(h[0].at >= h[1].at);
});
