// auth.test.js — share-safe auth primitives (scrypt hashing + role guard).
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const auth = require('../auth');

test('hashPassword/verifyPassword round-trip; rejects wrong + garbage', () => {
  const h = auth.hashPassword('s3cret');
  assert.match(h, /^[0-9a-f]{16}:[0-9a-f]{64}$/);
  assert.equal(auth.verifyPassword('s3cret', h), true);
  assert.equal(auth.verifyPassword('nope', h), false);
  assert.equal(auth.verifyPassword('x', 'garbage'), false);
});

test('requireRole throws 401 unauthenticated, 403 wrong role, passes allowed', () => {
  assert.throws(() => auth.requireRole(null, 'admin'), e => e.status === 401);
  assert.throws(() => auth.requireRole({ role: 'customer' }, 'admin'), e => e.status === 403);
  assert.doesNotThrow(() => auth.requireRole({ role: 'admin' }, 'admin', 'ops'));
});

test('tokenSign/tokenVerify round-trip; tamper + junk rejected', () => {
  process.env.COOP_SECRET = 'k1';
  const t = auth.tokenSign({ uid: 'u1', role: 'admin', exp: Date.now() + 1000 });
  const p = auth.tokenVerify(t);
  assert.equal(p.uid, 'u1');
  assert.equal(auth.tokenVerify(t.slice(0, -2) + 'xx'), null);  // bad mac
  assert.equal(auth.tokenVerify('garbage'), null);
  assert.equal(auth.tokenVerify(null), null);
  delete process.env.COOP_SECRET;
});

test('requireRoleFor: member-aware when _member present, else legacy user.role', () => {
  const guard = auth.requireRoleFor('coopbite');
  // legacy fallback (no _member): checks flat user.role
  assert.throws(() => guard(null, 'admin'), e => e.status === 401);
  assert.throws(() => guard({ role: 'customer' }, 'admin'), e => e.status === 403);
  assert.doesNotThrow(() => guard({ role: 'admin' }, 'admin'));
  // member-aware: uses the member's coopbite service roles, not the (absent) flat role
  const member = { id: 'mbr_1', services: { coopbite: { roles: ['restaurant'] }, bunji: { roles: ['rider'] } } };
  const user = auth.attachMember({ id: 'u1' }, member);
  assert.doesNotThrow(() => guard(user, 'restaurant'));
  assert.throws(() => guard(user, 'admin'), e => e.status === 403);
  // a role only held in ANOTHER service is not granted here
  assert.throws(() => guard(user, 'rider'), e => e.status === 403);
});

test('attachMember is non-persisted (non-enumerable; absent from JSON + spread)', () => {
  const user = auth.attachMember({ id: 'u1', role: 'customer' }, { id: 'mbr_1' });
  assert.equal(user._member.id, 'mbr_1');
  assert.deepEqual(Object.keys(user), ['id', 'role']);              // _member not enumerable
  assert.equal(JSON.parse(JSON.stringify(user))._member, undefined); // never serialised
  assert.equal({ ...user }._member, undefined);                      // never spread
});

test('createMemberResolver: enriches same-app user, SSO cross-app, fallback-to-local on error', async () => {
  process.env.COOP_SECRET = 'k1';
  const cbUser = { id: 'usr_1', role: 'customer', memberId: 'mbr_1' };
  const store = {
    getUser: async id => (id === 'usr_1' ? { ...cbUser } : null),
    getUserByMemberId: async mid => (mid === 'mbr_1' ? { ...cbUser } : null)
  };
  const member = { id: 'mbr_1', services: { coopbite: { roles: ['customer'] } } };
  const members = { shared: true, getById: async id => (id === 'mbr_1' ? member : null) };
  const resolver = auth.createMemberResolver({ store, members });
  const bearer = p => ({ headers: { authorization: 'Bearer ' + auth.tokenSign(p) } });

  // same-app token (uid resolves locally) → local user + attached member
  const a = await resolver(bearer({ uid: 'usr_1', mid: 'mbr_1', exp: Date.now() + 60000 }));
  assert.equal(a.id, 'usr_1');
  assert.equal(a._member.id, 'mbr_1');

  // cross-app token (uid is another service's, not found locally) → resolved via memberId (SSO)
  const b = await resolver(bearer({ uid: 'br_999', mid: 'mbr_1', exp: Date.now() + 60000 }));
  assert.equal(b.id, 'usr_1');
  assert.equal(b._member.id, 'mbr_1');

  // directory down → still returns the local user (resilient), just without _member
  const flaky = { ...store, getUserByMemberId: store.getUserByMemberId };
  const badMembers = { shared: true, getById: async () => { throw new Error('coop DB down'); } };
  const c = await auth.createMemberResolver({ store: flaky, members: badMembers })(
    bearer({ uid: 'usr_1', mid: 'mbr_1', exp: Date.now() + 60000 }));
  assert.equal(c.id, 'usr_1');
  assert.equal(c._member, undefined);

  // no members configured → behaves like createUserFromReq
  const d = await auth.createMemberResolver({ store })(bearer({ uid: 'usr_1', exp: Date.now() + 60000 }));
  assert.equal(d.id, 'usr_1');
  delete process.env.COOP_SECRET;
});

test('createMemberResolver never leaves a stale _member when the directory later fails', async () => {
  process.env.COOP_SECRET = 'k1';
  const live = { id: 'usr_1', role: 'customer', memberId: 'mbr_1' };  // file mode reuses ONE object
  const store = { getUser: async () => live };
  const member = { id: 'mbr_1', services: { coopbite: { roles: ['customer'] } } };
  let up = true;
  const members = { shared: true, getById: async () => { if (!up) throw new Error('down'); return member; } };
  const resolver = auth.createMemberResolver({ store, members });
  const bearer = { headers: { authorization: 'Bearer ' + auth.tokenSign({ uid: 'usr_1', mid: 'mbr_1', exp: Date.now() + 60000 }) } };

  const a = await resolver(bearer);
  assert.equal(a._member.id, 'mbr_1');       // directory up → attached
  up = false;
  const b = await resolver(bearer);          // same object, directory now down
  assert.equal(b._member, undefined);        // stale attach cleared (no lingering elevated roles)
  delete process.env.COOP_SECRET;
});

test('createUserFromReq resolves Bearer → unexpired token → store.getUser', async () => {
  process.env.COOP_SECRET = 'k1';
  const store = { getUser: async id => (id === 'u1' ? { id: 'u1', role: 'rider' } : null) };
  const userFromReq = auth.createUserFromReq(store);
  const good = auth.tokenSign({ uid: 'u1', role: 'rider', exp: Date.now() + 60000 });
  const expired = auth.tokenSign({ uid: 'u1', role: 'rider', exp: Date.now() - 1 });
  assert.equal((await userFromReq({ headers: { authorization: 'Bearer ' + good } })).id, 'u1');
  assert.equal(await userFromReq({ headers: { authorization: 'Bearer ' + expired } }), null);
  assert.equal(await userFromReq({ headers: {} }), null);
  delete process.env.COOP_SECRET;
});
