// bank.test.js — payout bank-account verification seam (STATUS §C). Unconfigured (no
// Stripe key): sessions are mock and completion is simulated.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');

delete process.env.STRIPE_SECRET_KEY;
const bank = require('../bank');

test('unconfigured: configured() is false', () => {
  assert.equal(bank.configured(), false);
});

test('createSession returns a mock session when Stripe is unset', async () => {
  const s = await bank.createSession({ userId: 'u_1', accountHolderName: 'Asha', email: 'a@b.com' });
  assert.equal(s.provider, 'mock');
  assert.equal(s.mock, true);
  assert.equal(s.clientSecret, null);
  assert.match(s.sessionId, /^fcs_mock_/);
});

test('complete simulates a verified account in mock mode', async () => {
  const r = await bank.complete('fcs_mock_u_1');
  assert.equal(r.status, 'verified');
  assert.equal(r.last4, '4242');
  assert.equal(r.mock, true);
  assert.ok(r.verifiedAt);
});

test('complete with no session id is still mock-verified when unconfigured', async () => {
  const r = await bank.complete('');
  assert.equal(r.status, 'verified');
  assert.equal(r.provider, 'mock');
});
