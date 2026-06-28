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
  // member ids are fresh + globally unique (service user-ids can collide across apps);
  // each service user links to its member via the idMap.
  assert.match(asha.id, /^mbr_/);
  assert.equal(r1.idMap['u_1'], asha.id);                     // CoopBite's user → this member
  assert.equal(r2.idMap['usr_asha'], asha.id);               // Bunji's same-email user → SAME member
  assert.notEqual(r1.idMap['u_1'], r1.idMap['u_2']);          // distinct people, distinct members
  assert.equal((await members.getById(asha.id)).email, 'asha@x.com');
});

test('collision-safe: same service-user-id in two apps → two distinct members', async () => {
  const members = createMembers({ pglite: true });
  const a = await members.backfill([{ id: 'usr_1008', email: 'p1@x.com', role: 'customer' }], 'coopbite');
  const b = await members.backfill([{ id: 'usr_1008', email: 'p2@y.com', role: 'rider' }], 'bunji');  // different person, same id
  assert.equal(await members.count(), 2);                     // not overwritten
  assert.notEqual(a.idMap['usr_1008'], b.idMap['usr_1008']);
});

test('re-backfill is idempotent: dedups email-less users by phone, and any user by memberId', async () => {
  const members = createMembers({ pglite: true });
  // First backfill: an email-less, phone-login rider (the no-email edge) + an emailed user.
  const r1 = await members.backfill([
    { id: 'usr_p', name: 'Priya', phone: '+61400000001', role: 'rider' },
    { id: 'usr_e', name: 'Eve', email: 'eve@x.com', role: 'customer' }
  ], 'bunji');
  assert.deepEqual([r1.created, r1.merged], [2, 0]);
  assert.equal(await members.count(), 2);

  // Re-run the SAME users → no duplicates: phone re-resolves Priya, email re-resolves Eve.
  const r2 = await members.backfill([
    { id: 'usr_p', name: 'Priya', phone: '+61400000001', role: 'rider' },
    { id: 'usr_e', name: 'Eve', email: 'eve@x.com', role: 'customer' }
  ], 'bunji');
  assert.deepEqual([r2.created, r2.merged], [0, 2]);
  assert.equal(await members.count(), 2);                 // still 2 — re-backfill safe

  // After the cutover the service user carries memberId — the strongest dedup key (covers the
  // email-less AND phone-less case, which no other key can).
  const pid = r1.idMap['usr_p'];
  const r3 = await members.upsertFromUser({ id: 'usr_p', memberId: pid, role: 'rider' }, 'bunji');
  assert.deepEqual([r3.memberId, r3.merged], [pid, true]);
  assert.equal(await members.count(), 2);
  // source user id is recorded as the last-resort key
  assert.equal((await members.getById(pid)).services.bunji.userId, 'usr_p');
});

test('directory store resolves email-less members by phone (pglite)', async () => {
  const members = createMembers({ pglite: true });
  const r = await members.backfill([{ id: 'usr_x', phone: '+61411111111', role: 'driver' }], 'bunji');
  const mid = r.idMap['usr_x'];
  assert.equal((await members.store.getUserByPhone('+61411111111')).id, mid);
  assert.equal(await members.store.getUserByPhone('+61499999999'), null);
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
