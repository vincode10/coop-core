// treasury.js — cooperative treasury (P4 of COOPERATIVE_PLATFORM.md).
// One treasury for the whole cooperative. Services contribute their calculated surplus;
// the board records operating expenses; governance decides distributions + safety-fund claims.
//
// Table prefix `trs_` keeps this independent of `coop_` members and `gov_` governance.
// Uses an append-only entries split table (contributions, expenses, distributions, safety donations)
// plus mutable safety-claim records kept in the JSON doc (low-volume, status-updatable).
'use strict';
const crypto = require('node:crypto');
const { createStore } = require('./store');

const newId = prefix => prefix + '_' + crypto.randomBytes(5).toString('hex');

const EXPENSE_CATEGORIES = ['operations', 'infrastructure', 'insurance', 'legal', 'marketing', 'other'];

// ---- local view helpers (used in both shared and local modes) ----

function safetyFundView(sf) {
  const paid = (sf.claims || []).filter(c => c.status === 'approved').reduce((s, c) => s + c.amountCents, 0);
  return {
    donatedCents: sf.donatedCents || 0,
    paidCents: paid,
    availableCents: Math.max(0, (sf.donatedCents || 0) - paid),
    claims: (sf.claims || []).slice().reverse().slice(0, 50)
  };
}

function buildSummary(entries, distributions, safetyFund) {
  const contributions = entries.filter(e => e.kind === 'contribution');
  const expenses      = entries.filter(e => e.kind === 'expense');
  const totalContributedCents  = contributions.reduce((s, e) => s + e.amountCents, 0);
  const totalExpensesCents     = expenses.reduce((s, e) => s + e.amountCents, 0);
  const totalDistributedCents  = (distributions || []).reduce((s, d) => s + d.amountCents, 0);
  const sf = safetyFund || { donatedCents: 0, claims: [] };
  const surplusCents   = totalContributedCents - totalExpensesCents;
  const availableCents = surplusCents - totalDistributedCents - (sf.donatedCents || 0);
  const byService = {};
  for (const e of contributions) byService[e.service] = (byService[e.service] || 0) + e.amountCents;
  return {
    totalContributedCents, totalExpensesCents, surplusCents,
    totalDistributedCents, availableCents: Math.max(0, availableCents),
    byService,
    safetyFund: safetyFundView(sf),
    recentContributions: contributions.slice().reverse().slice(0, 5),
    recentDistributions: (distributions || []).slice().reverse().slice(0, 5)
  };
}

/**
 * Build the cooperative treasury.
 * config: { coopDbUrl?, replicaUrl?, pglite?, localStore? }
 *   shared mode  (coopDbUrl or pglite): live treasury in trs_* tables.
 *   local mode   (neither): reads summarise each service's own data; writes refused.
 */
function createTreasury({ coopDbUrl, replicaUrl, pglite, localStore } = {}) {
  const sharedConfigured = !!(coopDbUrl || pglite);

  if (!sharedConfigured) {
    const err503 = () => { const e = new Error('Cooperative treasury requires COOP_DATABASE_URL'); e.status = 503; throw e; };
    return {
      shared: false,
      async summary() {
        if (!localStore) return buildSummary([], [], null);
        const db = localStore.load();
        // Normalise per-service proposals → local view (no split-table data available).
        return buildSummary([], db.surplusDistributions || [], db.safetyFund || null);
      },
      async getSafetyFund() {
        if (!localStore) return safetyFundView({ donatedCents: 0, claims: [] });
        return safetyFundView(localStore.load().safetyFund || { donatedCents: 0, claims: [] });
      },
      async contribute()       { err503(); },
      async recordExpense()    { err503(); },
      async distribute()       { err503(); },
      async contributeSafety() { err503(); },
      async claimSafety()      { err503(); },
      async resolveClaim()     { err503(); },
      async listContributions() { return []; }
    };
  }

  const store = createStore({
    pgUrl: coopDbUrl, replicaUrl, pglite, tablePrefix: 'trs_',
    emptyDoc: () => ({ seq: 100, entries: [], distributions: [], safetyFund: { donatedCents: 0, claims: [] }, blobs: {} }),
    split: { entries: { table: 'trs_entries', key: 'entries', cols: [
      ['kind',    e => e.kind    || 'entry', 'text'],
      ['service', e => e.service || null,    'text'],
      ['at',      e => e.at      || null,    'bigint'] ] } },
    indexes: [
      ['trs_entries_kind',    'trs_entries (kind)'],
      ['trs_entries_service', 'trs_entries (service)'],
      ['trs_entries_at',      'trs_entries (at)'] ],
    logHotCap: {}
  });

  // ---- write helpers ----

  async function appendEntry(entry) {
    return store.runScoped(async () => {
      await store.ensureLoaded(true);
      store.load().entries.push(entry);
      store.save(); await store.flush();
      return entry;
    });
  }

  // ---- public API ----

  /**
   * Post a service's calculated surplus to the cooperative treasury.
   * Called by an admin route after the service computes its period revenue.
   */
  async function contribute(service, amountCents, { periodStart, periodEnd, postedBy } = {}) {
    const cents = Math.max(0, Math.round(Number(amountCents) || 0));
    if (!cents) { const e = new Error('Contribution must be > 0'); e.status = 400; throw e; }
    return appendEntry({
      id: newId('con'), kind: 'contribution',
      service: String(service || '').slice(0, 30),
      amountCents: cents,
      periodStart: periodStart ? Number(periodStart) : null,
      periodEnd:   periodEnd   ? Number(periodEnd)   : null,
      postedBy: postedBy || null,
      at: Date.now()
    });
  }

  /** Record a cooperative operating expense (infrastructure, legal, insurance…). */
  async function recordExpense(amountCents, { category, note, recordedBy } = {}) {
    const cents = Math.max(0, Math.round(Number(amountCents) || 0));
    if (!cents) { const e = new Error('Expense must be > 0'); e.status = 400; throw e; }
    return appendEntry({
      id: newId('exp'), kind: 'expense',
      amountCents: cents,
      category: EXPENSE_CATEGORIES.includes(category) ? category : 'other',
      note: String(note || '').slice(0, 200),
      recordedBy: recordedBy || null,
      at: Date.now()
    });
  }

  /** Record a surplus distribution (dividends returned to members, mission spending, etc.). */
  async function distribute(amountCents, { note, decidedBy, proposalId } = {}) {
    const cents = Math.max(0, Math.round(Number(amountCents) || 0));
    if (!cents) { const e = new Error('Distribution must be > 0'); e.status = 400; throw e; }
    return store.runScoped(async () => {
      await store.ensureLoaded(true);
      const db = store.load();
      const d = { id: newId('dst'), amountCents: cents,
        note: String(note || '').slice(0, 200),
        decidedBy: decidedBy || null, proposalId: proposalId || null, at: Date.now() };
      (db.distributions = db.distributions || []).push(d);
      store.save(); await store.flush();
      return d;
    });
  }

  /** Full treasury summary: totals, per-service breakdown, safety fund view. */
  async function summary() {
    return store.runScoped(async () => {
      await store.ensureLoaded(false);
      const db = store.load();
      return buildSummary(db.entries || [], db.distributions || [], db.safetyFund || null);
    });
  }

  // ---- cooperative safety fund ----

  /** Member donates to the cooperative safety fund. */
  async function contributeSafety(memberId, amountCents) {
    const cents = Math.max(0, Math.round(Number(amountCents) || 0));
    if (!cents) { const e = new Error('Enter a contribution amount'); e.status = 400; throw e; }
    return store.runScoped(async () => {
      await store.ensureLoaded(true);
      const db = store.load();
      db.safetyFund = db.safetyFund || { donatedCents: 0, claims: [] };
      db.safetyFund.donatedCents = (db.safetyFund.donatedCents || 0) + cents;
      (db.safetyFund.contributions = db.safetyFund.contributions || []).push({ by: memberId, amountCents: cents, at: Date.now() });
      store.save(); await store.flush();
      return safetyFundView(db.safetyFund);
    });
  }

  /** Member raises a safety-fund claim. */
  async function claimSafety(memberId, memberName, { amountCents, reason }) {
    const cents = Math.max(0, Math.round(Number(amountCents) || 0));
    if (!cents)  { const e = new Error('Claim amount must be > 0'); e.status = 400; throw e; }
    if (!reason) { const e = new Error('Please describe what the claim is for'); e.status = 400; throw e; }
    return store.runScoped(async () => {
      await store.ensureLoaded(true);
      const db = store.load();
      db.safetyFund = db.safetyFund || { donatedCents: 0, claims: [] };
      const claim = { id: newId('clm'), by: memberId, byName: String(memberName || '').slice(0, 80),
        amountCents: cents, reason: String(reason).slice(0, 300), status: 'pending', at: Date.now() };
      (db.safetyFund.claims = db.safetyFund.claims || []).push(claim);
      store.save(); await store.flush();
      return claim;
    });
  }

  /** Admin approves or rejects a safety-fund claim. */
  async function resolveClaim(claimId, approve) {
    return store.runScoped(async () => {
      await store.ensureLoaded(true);
      const db = store.load();
      const claim = ((db.safetyFund || {}).claims || []).find(c => c.id === claimId);
      if (!claim) { const e = new Error('Claim not found'); e.status = 404; throw e; }
      if (claim.status !== 'pending') { const e = new Error('Claim already resolved'); e.status = 409; throw e; }
      claim.status = approve ? 'approved' : 'rejected'; claim.resolvedAt = Date.now();
      store.save(); await store.flush();
      return claim;
    });
  }

  /** Current safety fund view (donated, paid out, available, recent claims). */
  async function getSafetyFund() {
    return store.runScoped(async () => {
      await store.ensureLoaded(false);
      return safetyFundView(store.load().safetyFund || { donatedCents: 0, claims: [] });
    });
  }

  /** Paginated contribution history, optionally filtered by service. */
  async function listContributions({ service, limit = 50 } = {}) {
    return store.runScoped(async () => {
      await store.ensureLoaded(false);
      let entries = (store.load().entries || []).filter(e => e.kind === 'contribution');
      if (service) entries = entries.filter(e => e.service === service);
      return entries.slice().reverse().slice(0, Math.min(limit, 200));
    });
  }

  return {
    shared: true, store,
    summary, contribute, recordExpense, distribute,
    contributeSafety, claimSafety, resolveClaim, getSafetyFund,
    listContributions
  };
}

module.exports = { createTreasury };

// ---------------------------------------------------------------------------------
// ACTIVATION RUNBOOK (P4 cutover):
//   1. COOP_DATABASE_URL already set (same Neon DB, trs_ prefix = new tables).
//   2. Run migration: scripts/migrate-treasury.js in each app to seed initial
//      surplus contribution + safety fund state from per-app stores.
//   3. Deploy both apps with coop-core v0.11.0+.
//   4. Smoke: GET /api/treasury on both apps → same cooperative summary.
// ---------------------------------------------------------------------------------
