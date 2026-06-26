// compliance.test.js — the shared evaluator, driven by a tiny injected catalogue.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createCompliance, yearsSince, abnOk } = require('../compliance');

const cat = {
  driver: [
    { key: 'dob', label: 'DOB 18+', type: 'field', mandatory: true, validate: v => yearsSince(v) >= 18 },
    { key: 'abn', label: 'ABN', type: 'field', mandatory: true, validate: abnOk },
    { key: 'terms', label: 'Terms', type: 'consent', mandatory: true },
    { key: 'over18', label: '18+', type: 'attest', mandatory: true },
    { key: 'v_id', label: 'ID sighted', type: 'verify', mandatory: true },
    { key: 'newsletter', label: 'News', type: 'attest', mandatory: false }
  ]
};
const C = createCompliance({ catalogue: cat, policyVersion: '2026-06' });

test('helpers: yearsSince + abnOk', () => {
  assert.equal(yearsSince('2000-01-01') >= 18, true);
  assert.equal(yearsSince('bad'), null);
  assert.equal(abnOk('51 824 753 556'), true);
  assert.equal(abnOk('123'), false);
});

test('buildApplication validates applicant items + stamps policyVersion', () => {
  assert.throws(() => C.buildApplication('driver', { dob: '2015-01-01' }), e => e.status === 400);
  const app = C.buildApplication('driver', { dob: '1990-05-05', abn: '51824753556', terms: true, over18: true });
  assert.equal(app.policyVersion, '2026-06');
  assert.equal(app.consents.terms.version, '2026-06');
  assert.equal(app.attests.over18, true);
});

test('evaluate gates on admin verify items; setVerify satisfies them', () => {
  const app = C.buildApplication('driver', { dob: '1990-05-05', abn: '51824753556', terms: true, over18: true });
  let ev = C.evaluate('driver', app);
  assert.equal(ev.applicantComplete, true);
  assert.equal(ev.approvable, false);            // v_id not verified yet
  assert.deepEqual(ev.missingVerify, ['ID sighted']);
  C.setVerify('driver', app, 'v_id', true, 'admin@x');
  ev = C.evaluate('driver', app);
  assert.equal(ev.approvable, true);
  assert.throws(() => C.setVerify('driver', app, 'nope', true, 'admin@x'), e => e.status === 400);
});

test('requirements omit verify items + validators', () => {
  const reqs = C.requirements('driver');
  assert.equal(reqs.some(r => r.key === 'v_id'), false);
  assert.equal(reqs.every(r => !('validate' in r)), true);
});
