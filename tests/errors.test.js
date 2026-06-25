// errors.test.js — exception reporter (STATUS §F4). Unit-level: DSN parsing, event shape,
// stack parsing, and the unconfigured no-op path. No network is hit (no SENTRY_DSN set).
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');

delete process.env.SENTRY_DSN;
const errors = require('../errors');

test('unconfigured: configured() is false and capture() is a skipped no-op', async () => {
  assert.equal(errors.configured(), false);
  const r = await errors.capture(new Error('boom'), { transaction: '/api/x' });
  assert.equal(r.sent, false);
  assert.equal(r.skipped, true);
});

test('parseDsn — SaaS DSN', () => {
  const d = errors.parseDsn('https://abc123@o55.ingest.sentry.io/456');
  assert.equal(d.publicKey, 'abc123');
  assert.equal(d.endpoint, 'https://o55.ingest.sentry.io/api/456/store/');
});

test('parseDsn — self-hosted DSN with a path prefix', () => {
  const d = errors.parseDsn('https://key@errors.example.com/inner/path/7');
  assert.equal(d.endpoint, 'https://errors.example.com/inner/path/api/7/store/');
});

test('parseDsn — invalid input returns null', () => {
  assert.equal(errors.parseDsn('not a url'), null);
  assert.equal(errors.parseDsn('https://no-project@host.tld'), null); // missing project id
});

test('framesFromStack parses stack lines oldest-first', () => {
  const stack = 'Error: x\n    at foo (/app/server/a.js:10:5)\n    at bar (/app/server/b.js:20:9)';
  const frames = errors.framesFromStack(stack);
  assert.equal(frames.length, 2);
  // reversed → oldest (bar) first
  assert.deepEqual(frames[0], { function: 'bar', filename: '/app/server/b.js', lineno: 20, colno: 9 });
  assert.deepEqual(frames[1], { function: 'foo', filename: '/app/server/a.js', lineno: 10, colno: 5 });
});

test('buildEvent shapes a Sentry event from an Error + context', () => {
  const ev = errors.buildEvent(new TypeError('bad thing'), { transaction: '/api/orders', status: 500, req: { method: 'POST', url: '/api/orders' } });
  assert.equal(ev.platform, 'node');
  assert.equal(ev.level, 'error');
  assert.equal(ev.exception.values[0].type, 'TypeError');
  assert.equal(ev.exception.values[0].value, 'bad thing');
  assert.equal(ev.transaction, '/api/orders');
  assert.equal(ev.tags.status, '500');
  assert.equal(ev.request.method, 'POST');
  assert.match(ev.event_id, /^[0-9a-f]{32}$/);
  assert.ok(Array.isArray(ev.exception.values[0].stacktrace.frames));
});

test('buildEvent tolerates a non-Error value', () => {
  const ev = errors.buildEvent('just a string');
  assert.equal(ev.exception.values[0].value, 'just a string');
});
