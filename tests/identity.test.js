// identity.test.js — Stripe Identity proofing seam (STATUS §C.3). Unconfigured → mock.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
delete process.env.STRIPE_SECRET_KEY;
const identity = require('../identity');

test('unconfigured: configured() false', () => assert.equal(identity.configured(), false));

test('createSession returns a mock session', async () => {
  const s = await identity.createSession({ userId: 'u_1', email: 'a@b.com' });
  assert.equal(s.provider, 'mock');
  assert.equal(s.mock, true);
  assert.match(s.sessionId, /^vs_mock_/);
});

test('complete simulates a verified identity in mock mode', async () => {
  const r = await identity.complete('vs_mock_u_1');
  assert.equal(r.verified, true);
  assert.equal(r.status, 'verified');
  assert.equal(r.mock, true);
});
