// cooperative.test.js — member service-role model (target shape + legacy fallback).
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const co = require('../cooperative');

test('memberServices / inService read the target shape', () => {
  const m = { id: 'm1', services: { coopbite: { roles: ['customer'] }, bunji: { roles: ['rider', 'driver'] } } };
  assert.deepEqual(co.memberServices(m).sort(), ['bunji', 'coopbite']);
  assert.equal(co.inService(m, 'bunji'), true);
  assert.equal(co.inService(m, 'other'), false);
  assert.deepEqual(co.memberServices({ id: 'x' }), []); // legacy user → no services map
});

test('hasServiceRole: target model', () => {
  const m = { services: { bunji: { roles: ['driver'] } } };
  assert.equal(co.hasServiceRole(m, 'bunji', 'driver'), true);
  assert.equal(co.hasServiceRole(m, 'bunji', 'rider'), false);
  assert.equal(co.hasServiceRole(m, 'bunji'), true);            // any role in service
  assert.equal(co.hasServiceRole(m, 'coopbite', 'customer'), false);
});

test('hasServiceRole: legacy flat-role fallback keeps pre-migration checks working', () => {
  const legacy = { role: 'driver' };
  assert.equal(co.hasServiceRole(legacy, 'bunji', 'driver'), true);
  assert.equal(co.hasServiceRole(legacy, 'bunji', 'rider'), false);
  assert.equal(co.hasServiceRole(null, 'bunji', 'driver'), false);
});

test('requireServiceRole throws 401 unauth / 403 wrong role', () => {
  assert.throws(() => co.requireServiceRole(null, 'bunji', 'driver'), e => e.status === 401);
  assert.throws(() => co.requireServiceRole({ services: { bunji: { roles: ['rider'] } } }, 'bunji', 'driver'), e => e.status === 403);
  assert.doesNotThrow(() => co.requireServiceRole({ services: { bunji: { roles: ['driver'] } } }, 'bunji', 'driver'));
});

test('enrol is additive + idempotent', () => {
  const m = { id: 'm1' };
  co.enrol(m, 'coopbite', 'customer');
  co.enrol(m, 'coopbite', 'restaurant');
  co.enrol(m, 'coopbite', 'customer'); // dup ignored
  assert.deepEqual(m.services.coopbite.roles, ['customer', 'restaurant']);
  assert.equal(m.services.coopbite.status, 'active');
});
