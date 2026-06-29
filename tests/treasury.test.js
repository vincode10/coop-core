// treasury.test.js — cooperative treasury: shared mode (pglite) + local fallback.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createTreasury } = require('../treasury');

// ---- shared mode (pglite) ---------------------------------------------------

test('shared: contribute posts service surplus; summary aggregates correctly', async () => {
  const t = createTreasury({ pglite: true });
  assert.equal(t.shared, true);

  await t.contribute('coopbite', 5000, { periodStart: Date.now() - 86400000, periodEnd: Date.now(), postedBy: 'admin@coopbite.org' });
  await t.contribute('bunji',    3000, { periodStart: Date.now() - 86400000, periodEnd: Date.now(), postedBy: 'admin@bunjiride.au' });

  const s = await t.summary();
  assert.equal(s.totalContributedCents, 8000);
  assert.equal(s.totalExpensesCents, 0);
  assert.equal(s.surplusCents, 8000);
  assert.equal(s.byService.coopbite, 5000);
  assert.equal(s.byService.bunji, 3000);
  assert.equal(s.recentContributions.length, 2);
});

test('shared: recordExpense reduces available surplus', async () => {
  const t = createTreasury({ pglite: true });
  await t.contribute('coopbite', 10000);
  await t.recordExpense(2000, { category: 'infrastructure', note: 'Neon DB Jan', recordedBy: 'admin' });

  const s = await t.summary();
  assert.equal(s.totalExpensesCents, 2000);
  assert.equal(s.surplusCents, 8000);
  assert.equal(s.availableCents, 8000);
});

test('shared: distribute records payout and reduces available', async () => {
  const t = createTreasury({ pglite: true });
  await t.contribute('coopbite', 10000);
  await t.distribute(3000, { note: 'Q1 member dividend', decidedBy: 'mbr_admin' });

  const s = await t.summary();
  assert.equal(s.totalDistributedCents, 3000);
  assert.equal(s.availableCents, 7000);
  assert.equal(s.recentDistributions[0].amountCents, 3000);
});

test('shared: contribute/distribute/expense reject zero amounts', async () => {
  const t = createTreasury({ pglite: true });
  await assert.rejects(() => t.contribute('coopbite', 0),   e => e.status === 400);
  await assert.rejects(() => t.distribute(0, {}),           e => e.status === 400);
  await assert.rejects(() => t.recordExpense(0, {}),        e => e.status === 400);
});

test('shared: listContributions returns history, filterable by service', async () => {
  const t = createTreasury({ pglite: true });
  await t.contribute('coopbite', 1000);
  await t.contribute('bunji',    2000);
  await t.contribute('coopbite', 500);

  const all = await t.listContributions();
  assert.equal(all.length, 3);

  const cb = await t.listContributions({ service: 'coopbite' });
  assert.equal(cb.length, 2);
  assert.ok(cb.every(e => e.service === 'coopbite'));
});

// ---- safety fund ------------------------------------------------------------

test('shared: contributeSafety + claimSafety + resolveClaim full lifecycle', async () => {
  const t = createTreasury({ pglite: true });
  await t.contributeSafety('mbr_alice', 5000);
  await t.contributeSafety('mbr_bob',   2000);

  let sf = await t.getSafetyFund();
  assert.equal(sf.donatedCents, 7000);
  assert.equal(sf.paidCents, 0);
  assert.equal(sf.availableCents, 7000);

  const claim = await t.claimSafety('mbr_driver1', 'James B', { amountCents: 1500, reason: 'Bike repair after road incident' });
  assert.match(claim.id, /^clm_/);
  assert.equal(claim.status, 'pending');

  await t.resolveClaim(claim.id, true); // approve
  sf = await t.getSafetyFund();
  assert.equal(sf.paidCents, 1500);
  assert.equal(sf.availableCents, 5500);
  assert.equal(sf.claims[0].status, 'approved');
});

test('shared: reject a claim; paid amount unaffected', async () => {
  const t = createTreasury({ pglite: true });
  await t.contributeSafety('mbr_alice', 5000);
  const c = await t.claimSafety('mbr_x', 'X', { amountCents: 500, reason: 'Test' });
  await t.resolveClaim(c.id, false);
  const sf = await t.getSafetyFund();
  assert.equal(sf.paidCents, 0);
  assert.equal(sf.claims[0].status, 'rejected');
});

test('shared: double-resolve throws 409', async () => {
  const t = createTreasury({ pglite: true });
  await t.contributeSafety('mbr_a', 1000);
  const c = await t.claimSafety('mbr_a', 'A', { amountCents: 100, reason: 'R' });
  await t.resolveClaim(c.id, true);
  await assert.rejects(() => t.resolveClaim(c.id, false), e => e.status === 409);
});

test('shared: claimSafety rejects missing reason or zero amount', async () => {
  const t = createTreasury({ pglite: true });
  await assert.rejects(() => t.claimSafety('mbr_a', 'A', { amountCents: 0,   reason: 'R' }), e => e.status === 400);
  await assert.rejects(() => t.claimSafety('mbr_a', 'A', { amountCents: 100, reason: '' }),  e => e.status === 400);
});

// ---- local mode (no shared DB) ----------------------------------------------

test('local mode: summary normalises per-app data; writes throw 503', async () => {
  const localStore = {
    load: () => ({
      surplusDistributions: [{ amountCents: 2000, note: 'Q4', at: Date.now() }],
      safetyFund: { donatedCents: 5000, claims: [{ id: 'c1', status: 'approved', amountCents: 500 }] }
    })
  };
  const t = createTreasury({ localStore });
  assert.equal(t.shared, false);

  const s = await t.summary();
  assert.equal(s.totalContributedCents, 0); // no contributions tracked locally
  assert.equal(s.totalDistributedCents, 2000);
  assert.equal(s.safetyFund.donatedCents, 5000);
  assert.equal(s.safetyFund.paidCents, 500);

  await assert.rejects(() => t.contribute('bunji', 1000),        e => e.status === 503);
  await assert.rejects(() => t.distribute(100, {}),              e => e.status === 503);
  await assert.rejects(() => t.contributeSafety('mbr_x', 100),   e => e.status === 503);
  await assert.rejects(() => t.claimSafety('mbr_x', 'X', { amountCents: 10, reason: 'r' }), e => e.status === 503);
});
