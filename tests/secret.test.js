// secret.test.js — signing-key rotation (STATUS §D). Unit-level: multi-key parse, sign with
// current, verify against any active key, and clean cutover when an old key is dropped.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const secret = require('../secret');
const ORIG = process.env.COOPBITE_SECRET;
test.after(() => { if (ORIG === undefined) delete process.env.COOPBITE_SECRET; else process.env.COOPBITE_SECRET = ORIG; });

test('falls back to a single key when unset', () => {
  delete process.env.COOPBITE_SECRET;
  assert.deepEqual(secret.all(), [secret.FALLBACK]);
  assert.equal(secret.current(), secret.FALLBACK);
});

test('single key: sign/verify round-trip', () => {
  process.env.COOPBITE_SECRET = 'k1';
  const mac = secret.signB64('hello');
  assert.equal(secret.verifyB64('hello', mac), true);
  assert.equal(secret.verifyB64('tampered', mac), false);
});

test('rotation: a token signed under the old key stays valid during the overlap, then cuts over', () => {
  process.env.COOPBITE_SECRET = 'oldkey';
  const macOld = secret.signB64('payload');

  process.env.COOPBITE_SECRET = 'newkey,oldkey'; // prepend new, keep old
  assert.equal(secret.current(), 'newkey');
  assert.equal(secret.verifyB64('payload', macOld), true, 'old token still accepted during overlap');
  const macNew = secret.signB64('payload');
  assert.equal(secret.verifyB64('payload', macNew), true, 'new token accepted');

  process.env.COOPBITE_SECRET = 'newkey'; // drop the old key
  assert.equal(secret.verifyB64('payload', macOld), false, 'old token rejected after old key removed');
  assert.equal(secret.verifyB64('payload', macNew), true);
});

test('hashHex uses current key; hashesHex covers every key', () => {
  process.env.COOPBITE_SECRET = 'a,b';
  const h = secret.hashHex('x');                 // under 'a'
  assert.equal(secret.hashesHex('x').length, 2);
  assert.ok(secret.hashesHex('x').includes(h));
  process.env.COOPBITE_SECRET = 'b';
  assert.notEqual(secret.hashHex('x'), h, 'different current key → different hash');
});
