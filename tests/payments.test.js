// payments.test.js — payment processor seam (STATUS §C.1). Unit-level: with no
// STRIPE_SECRET_KEY set every call returns a `mock` result and moves no money, preserving
// the pilot's mock-settlement behaviour.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');

delete process.env.STRIPE_SECRET_KEY;
const payments = require('../payments');

test('unconfigured: configured() is false; currency defaults to aud', () => {
  assert.equal(payments.configured(), false);
  assert.equal(payments.currency(), 'aud');
});

test('createIntent returns a mock intent carrying the amount', async () => {
  const i = await payments.createIntent({ amountCents: 3799, orderId: 'ord_1', customerEmail: 'a@b.com' });
  assert.equal(i.provider, 'mock');
  assert.equal(i.mock, true);
  assert.equal(i.status, 'mock');
  assert.equal(i.amountCents, 3799);
  assert.match(i.intentId, /^pi_mock_/);
});

test('createIntent rounds and floors the amount', async () => {
  assert.equal((await payments.createIntent({ amountCents: 12.6 })).amountCents, 13);
  assert.equal((await payments.createIntent({ amountCents: -5 })).amountCents, 0);
  assert.equal((await payments.createIntent({})).amountCents, 0);
});

test('capture of a mock intent succeeds without network', async () => {
  const c = await payments.capture('pi_mock_ord_1');
  assert.equal(c.status, 'captured');
  assert.equal(c.mock, true);
});

test('refund of a mock intent succeeds and echoes the amount', async () => {
  const r = await payments.refund({ intentId: 'pi_mock_ord_1', amountCents: 500, reason: 'requested_by_customer' });
  assert.equal(r.status, 'succeeded');
  assert.equal(r.mock, true);
  assert.equal(r.amountCents, 500);
  assert.match(r.refundId, /^rf_mock_/);
});

test('refund with no intent still returns a mock success (ledger-only path)', async () => {
  const r = await payments.refund({ amountCents: 100 });
  assert.equal(r.mock, true);
  assert.equal(r.amountCents, 100);
});
