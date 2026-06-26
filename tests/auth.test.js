// auth.test.js — share-safe auth primitives (scrypt hashing + role guard).
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const auth = require('../auth');

test('hashPassword/verifyPassword round-trip; rejects wrong + garbage', () => {
  const h = auth.hashPassword('s3cret');
  assert.match(h, /^[0-9a-f]{16}:[0-9a-f]{64}$/);
  assert.equal(auth.verifyPassword('s3cret', h), true);
  assert.equal(auth.verifyPassword('nope', h), false);
  assert.equal(auth.verifyPassword('x', 'garbage'), false);
});

test('requireRole throws 401 unauthenticated, 403 wrong role, passes allowed', () => {
  assert.throws(() => auth.requireRole(null, 'admin'), e => e.status === 401);
  assert.throws(() => auth.requireRole({ role: 'customer' }, 'admin'), e => e.status === 403);
  assert.doesNotThrow(() => auth.requireRole({ role: 'admin' }, 'admin', 'ops'));
});
