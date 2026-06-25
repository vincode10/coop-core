// registry.test.js — ABN registry verification seam (STATUS §C.3). Checksum + mock lookup.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
delete process.env.ABR_GUID;
const registry = require('../registry');

test('validChecksum: real ABN passes, junk fails', () => {
  assert.equal(registry.validChecksum('51824753556'), true);   // ATO example ABN
  assert.equal(registry.validChecksum('51 824 753 556'), true); // spacing tolerated
  assert.equal(registry.validChecksum('12345678901'), false);
  assert.equal(registry.validChecksum('123'), false);
});

test('lookup (unconfigured) decides by checksum', async () => {
  const good = await registry.lookup('51 824 753 556');
  assert.equal(good.valid, true);
  assert.equal(good.status, 'Active');
  assert.equal(good.mock, true);
  const bad = await registry.lookup('12345678901');
  assert.equal(bad.valid, false);
});
