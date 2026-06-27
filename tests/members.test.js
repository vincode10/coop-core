// members.test.js — the shared member directory: cross-service dedup/merge backfill (PGlite
// shared mode) + the local-fallback façade (unconfigured mode).
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createMembers, toMember } = require('../members');

test('toMember maps a service user → member with one service enrolment', () => {
  const m = toMember({ id: 'u_1', name: 'Asha', email: 'A@B.com', role: 'customer', status: 'active' }, 'coopbite');
  assert.equal(m.email, 'a@b.com');
  assert.deepEqual(m.services.coopbite.roles, ['customer']);
});

test('shared mode: backfill dedups by email and merges service enrolments across services', async () => {
  const members = createMembers({ pglite: true });
  assert.equal(members.shared, true);

  // CoopBite users
  const r1 = await members.backfill([
    { id: 'u_1', name: 'Asha', email: 'asha@x.com', role: 'customer', passHash: 'h1' },
    { id: 'u_2', name: 'Bo', email: 'bo@x.com', role: 'restaurant' }
  ], 'coopbite');
  assert.deepEqual([r1.created, r1.merged], [2, 0]);

  // Bunji users — asha@x.com is the SAME person (merge), plus a new rider
  const r2 = await members.backfill([
    { id: 'usr_asha', name: 'Asha', email: 'asha@x.com', role: 'rider' },
    { id: 'usr_cleo', name: 'Cleo', email: 'cleo@x.com', role: 'driver' }
  ], 'bunji');
  assert.deepEqual([r2.created, r2.merged], [1, 1]);

  assert.equal(await members.count(), 3);                      // asha not duplicated
  const asha = await members.getByEmail('asha@x.com');
  assert.deepEqual(Object.keys(asha.services).sort(), ['bunji', 'coopbite']);
  assert.deepEqual(asha.services.coopbite.roles, ['customer']);
  assert.deepEqual(asha.services.bunji.roles, ['rider']);
  assert.equal(asha.passHash, 'h1');                          // identity preserved from first source
  assert.equal((await members.getById('u_1')).id, 'u_1');
  assert.equal(r2.idMap['usr_asha'], 'u_1');                  // Bunji's user maps to the existing member id
});

test('local mode: delegates to the service store; writes are refused', async () => {
  const localStore = {
    getUser: async id => (id === 'u_1' ? { id: 'u_1', role: 'customer' } : null),
    getUserByEmail: async e => (e === 'a@b.com' ? { id: 'u_1' } : null),
    countUsers: async () => 1
  };
  const members = createMembers({ localStore });
  assert.equal(members.shared, false);
  assert.equal((await members.getById('u_1')).id, 'u_1');
  assert.equal((await members.getByEmail('a@b.com')).id, 'u_1');
  assert.equal(await members.count(), 1);
  await assert.rejects(() => members.upsert({ id: 'x' }), /shared cooperative directory/);
});
