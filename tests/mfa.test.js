// mfa.test.js — encoding-agnostic TOTP engine. Proves byte-equivalence across hex/base32
// (so neither app's stored secrets break) + an RFC 6238 known-answer vector.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const mfa = require('../mfa');

test('hex and base32 of the SAME bytes yield identical TOTP (encoding-agnostic)', () => {
  const bytes = crypto.randomBytes(20);
  const at = 1700000000000;
  assert.equal(mfa.totp(bytes.toString('hex'), { encoding: 'hex', at }),
               mfa.totp(mfa.base32Encode(bytes), { encoding: 'base32', at }));
});

test('RFC 6238 known-answer vector (SHA1, secret "12345678901234567890", T=59)', () => {
  const hex = Buffer.from('12345678901234567890', 'ascii').toString('hex');
  assert.equal(mfa.totp(hex, { encoding: 'hex', at: 59000 }), '287082'); // 94287082 → 6-digit
});

test('verify round-trips for hex secrets', () => {
  const s = mfa.generateSecret('hex');
  assert.match(s, /^[0-9a-f]{40}$/);
  assert.equal(mfa.verify(s, mfa.totp(s, { encoding: 'hex' }), { encoding: 'hex' }), true);
  assert.equal(mfa.verify(s, '000000', { encoding: 'hex' }), false);
});

test('verify round-trips for base32 secrets (default encoding)', () => {
  const s = mfa.generateSecret('base32');
  assert.match(s, /^[A-Z2-7]+$/);
  assert.equal(mfa.verify(s, mfa.totp(s)), true);
});

test('±1 step window tolerates clock skew; window 0 does not', () => {
  const s = mfa.generateSecret('base32');
  const now = 1700000000000;
  const prev = mfa.totp(s, { at: now - 30000 });
  assert.equal(mfa.verify(s, prev, { at: now, window: 1 }), true);
  assert.equal(mfa.verify(s, prev, { at: now, window: 0 }), false);
});

test('otpauthUrl emits a base32 secret regardless of input encoding', () => {
  const url = mfa.otpauthUrl(mfa.generateSecret('hex'), { encoding: 'hex', label: 'a@b.com', issuer: 'X' });
  assert.match(url, /^otpauth:\/\/totp\/X:a%40b\.com\?secret=[A-Z2-7]+&issuer=X&algorithm=SHA1&digits=6&period=30$/);
});

test('numericCode is 6 digits', () => assert.match(mfa.numericCode(), /^\d{6}$/));
