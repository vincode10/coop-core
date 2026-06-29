// governance.test.js — cooperative governance: shared mode (pglite) + local read-only fallback.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createGovernance, isMember } = require('../governance');

// ---- helpers ----------------------------------------------------------------
const mbr = (id, svcs = { coopbite: { roles: ['customer'], status: 'active' } }) =>
  ({ id, name: 'Test ' + id, services: svcs });

// ---- isMember ---------------------------------------------------------------
test('isMember: any active cooperative service enrolment counts; no enrolment = not a member', () => {
  assert.equal(isMember(mbr('m1')), true);
  assert.equal(isMember(mbr('m2', { bunji: { roles: ['rider'], status: 'active' } })), true);
  assert.equal(isMember(mbr('m3', { coopbite: { roles: ['customer'], status: 'suspended' } })), false);
  assert.equal(isMember({ id: 'u1', role: 'customer', status: 'active' }), true);  // legacy user
  assert.equal(isMember(null), false);
});

// ---- shared mode (pglite) ---------------------------------------------------
test('shared: propose / vote (one-member-one-vote, re-votable) / tally / close', async () => {
  const gov = createGovernance({ pglite: true });
  assert.equal(gov.shared, true);

  const alice = mbr('mbr_alice');
  const bob   = mbr('mbr_bob');

  const p = await gov.propose(alice, { title: 'Raise driver fee cap', detail: 'Details here.', kind: 'pricing', days: 7 });
  assert.match(p.id, /^prop_/);
  assert.equal(p.status, 'open');
  assert.equal(p.scope, 'coop');

  // Alice and Bob vote
  await gov.vote(alice, p.id, 'yes');
  await gov.vote(bob,   p.id, 'no');
  await gov.vote(alice, p.id, 'no'); // re-vote: alice changes to no

  const listed = await gov.list();
  assert.equal(listed.length, 1);
  const pub = gov.publicProposal(listed[0], alice);
  assert.deepEqual(pub.tally, { yes: 0, no: 2, abstain: 0 }); // alice's re-vote counted
  assert.equal(pub.myVote, 'no');

  // Close
  const closed = await gov.close(p.id);
  assert.equal(closed.status, 'closed');
  assert.equal(closed.outcome, 'failed'); // no > yes
});

test('shared: abstain is a valid choice and counted separately', async () => {
  const gov = createGovernance({ pglite: true });
  const a = mbr('mbr_a'), b = mbr('mbr_b'), c = mbr('mbr_c');
  const p = await gov.propose(a, { title: 'Test abstain', days: 3 });
  await gov.vote(a, p.id, 'yes');
  await gov.vote(b, p.id, 'abstain');
  await gov.vote(c, p.id, 'yes');
  const closed = await gov.close(p.id);
  assert.deepEqual(require('../governance').tally(closed), { yes: 2, no: 0, abstain: 1 });
  assert.equal(closed.outcome, 'passed'); // yes > no (abstain doesn't count against)
});

test('shared: non-member cannot propose or vote', async () => {
  const gov = createGovernance({ pglite: true });
  const suspended = mbr('mbr_s', { coopbite: { roles: [], status: 'suspended' } });
  const p = await gov.propose(mbr('mbr_ok'), { title: 'A motion' });
  await assert.rejects(() => gov.propose(suspended, { title: 'X' }), e => e.status === 403);
  await assert.rejects(() => gov.vote(suspended, p.id, 'yes'), e => e.status === 403);
});

test('shared: cannot vote or close after proposal is closed', async () => {
  const gov = createGovernance({ pglite: true });
  const a = mbr('mbr_a');
  const p = await gov.propose(a, { title: 'Quick motion', days: 1 });
  await gov.close(p.id);
  await assert.rejects(() => gov.vote(a, p.id, 'yes'), e => e.status === 409);
  await assert.rejects(() => gov.close(p.id), /already.*closed|closed/i);
});

test('shared: invalid vote choice rejected', async () => {
  const gov = createGovernance({ pglite: true });
  const p = await gov.propose(mbr('mbr_x'), { title: 'Test' });
  await assert.rejects(() => gov.vote(mbr('mbr_y'), p.id, 'maybe'), e => e.status === 400);
});

test('shared: proposal scope field stored and visible; get() retrieves by id', async () => {
  const gov = createGovernance({ pglite: true });
  const p = await gov.propose(mbr('mbr_x'), { title: 'CoopBite only', scope: 'coopbite', kind: 'policy' });
  assert.equal(p.scope, 'coopbite');
  const fetched = await gov.get(p.id);
  assert.equal(fetched.scope, 'coopbite');
  assert.equal(await gov.get('prop_nonexistent'), null);
});

// ---- local mode (no shared DB) ----------------------------------------------
test('local mode: reads normalise both CoopBite (object votes) and Bunji (array votes) shapes', async () => {
  const cbProposal = {
    id: 'prop_cb1', title: 'CB motion', body: 'body text',
    createdBy: 'admin@cb.org', createdAt: Date.now() - 1000,
    closesAt: Date.now() + 86400000, status: 'open',
    votes: { 'usr_1': 'yes', 'usr_2': 'no' } // CoopBite object-votes
  };
  const brProposal = {
    id: 'prop_br1', title: 'Bunji motion', detail: 'detail text',
    createdBy: 'mbr_abc', createdByName: 'Alice', createdAt: Date.now() - 2000,
    status: 'open',
    votes: [{ memberId: 'mbr_abc', choice: 'yes', at: Date.now() }] // Bunji array-votes
  };
  const localStore = { load: () => ({ proposals: [cbProposal, brProposal] }), countUsers: async () => 2 };
  const gov = createGovernance({ localStore });
  assert.equal(gov.shared, false);

  const list = await gov.list();
  assert.equal(list.length, 2);

  const cb = list.find(p => p.id === 'prop_cb1');
  assert.equal(cb.detail, 'body text'); // body → detail normalised
  assert.equal(cb.votes.length, 2);
  assert.ok(cb.votes.some(v => v.memberId === 'usr_1' && v.choice === 'yes'));

  const br = list.find(p => p.id === 'prop_br1');
  assert.equal(br.detail, 'detail text');
  assert.equal(br.votes.length, 1);

  // get() also normalises
  const fetched = await gov.get('prop_cb1');
  assert.equal(fetched.id, 'prop_cb1');
  assert.equal(await gov.get('prop_missing'), null);
});

test('local mode: writes are refused with 503', async () => {
  const localStore = { load: () => ({ proposals: [] }), countUsers: async () => 0 };
  const gov = createGovernance({ localStore });
  await assert.rejects(() => gov.propose(mbr('mbr_x'), { title: 'X' }), e => e.status === 503);
  await assert.rejects(() => gov.vote(mbr('mbr_x'), 'prop_x', 'yes'), e => e.status === 503);
  await assert.rejects(() => gov.close('prop_x'), e => e.status === 503);
});
