// screening.test.js — background/police check seam (STATUS §C.3). Unconfigured → mock clear.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
for (const k of ['BACKGROUND_CHECK_URL', 'BACKGROUND_CHECK_API_KEY']) delete process.env[k];
const screening = require('../screening');

test('unconfigured: configured() false', () => assert.equal(screening.configured(), false));

test('normalise maps provider vocabularies', () => {
  assert.equal(screening.normalise('Clear'), 'clear');
  assert.equal(screening.normalise('passed'), 'clear');
  assert.equal(screening.normalise('consider'), 'consider');
  assert.equal(screening.normalise('whatever'), 'pending');
});

test('createCheck returns a mock check; getCheck clears it', async () => {
  const c = await screening.createCheck({ userId: 'u_1', name: 'Asha' });
  assert.match(c.checkId, /^bgc_mock_/);
  const r = await screening.getCheck(c.checkId);
  assert.equal(r.cleared, true);
  assert.equal(r.status, 'clear');
});
