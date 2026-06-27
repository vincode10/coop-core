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

test('tokenSign/tokenVerify round-trip; tamper + junk rejected', () => {
  process.env.COOP_SECRET = 'k1';
  const t = auth.tokenSign({ uid: 'u1', role: 'admin', exp: Date.now() + 1000 });
  const p = auth.tokenVerify(t);
  assert.equal(p.uid, 'u1');
  assert.equal(auth.tokenVerify(t.slice(0, -2) + 'xx'), null);  // bad mac
  assert.equal(auth.tokenVerify('garbage'), null);
  assert.equal(auth.tokenVerify(null), null);
  delete process.env.COOP_SECRET;
});

test('createUserFromReq resolves Bearer → unexpired token → store.getUser', async () => {
  process.env.COOP_SECRET = 'k1';
  const store = { getUser: async id => (id === 'u1' ? { id: 'u1', role: 'rider' } : null) };
  const userFromReq = auth.createUserFromReq(store);
  const good = auth.tokenSign({ uid: 'u1', role: 'rider', exp: Date.now() + 60000 });
  const expired = auth.tokenSign({ uid: 'u1', role: 'rider', exp: Date.now() - 1 });
  assert.equal((await userFromReq({ headers: { authorization: 'Bearer ' + good } })).id, 'u1');
  assert.equal(await userFromReq({ headers: { authorization: 'Bearer ' + expired } }), null);
  assert.equal(await userFromReq({ headers: {} }), null);
  delete process.env.COOP_SECRET;
});
