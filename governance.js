// governance.js — cooperative-level governance (P3 of COOPERATIVE_PLATFORM.md).
// One set of proposals + votes for the WHOLE cooperative; vote keys are cooperative member ids
// (`mbr_xxx`) so a member's single vote is shared across all services.
//
// GATED: when no shared cooperative DB is configured, reads fall back to a normalised view of
// the service's own local proposals (read-only); writes throw. The shared DB (COOP_DATABASE_URL)
// is required for cross-service governance to work.
//
// Uses a `gov_` table prefix so it coexists with `coop_` members in the same Postgres database
// without any conflict over the monolithic JSON doc.
'use strict';
const crypto = require('node:crypto');
const { createStore } = require('./store');

const newProposalId = () => 'prop_' + crypto.randomBytes(6).toString('hex');
const CHOICES = ['yes', 'no', 'abstain'];
const KINDS = ['pricing', 'policy', 'direction', 'other'];

/** Any cooperative member with at least one active service enrolment can vote. */
function isMember(member) {
  if (!member) return false;
  // Cooperative member shape: { services: { svc: { roles, status } } }
  if (member.services && typeof member.services === 'object')
    return Object.values(member.services).some(s => s && s.status !== 'inactive' && s.status !== 'suspended');
  // Legacy / local fallback: a service user with an active role is treated as a member.
  return !!(member.role && (!member.status || member.status === 'active'));
}

/** Compute yes/no/abstain tallies from a proposal's votes array. */
function tally(p) {
  const t = { yes: 0, no: 0, abstain: 0 };
  for (const v of (p.votes || [])) if (t[v.choice] != null) t[v.choice] += 1;
  return t;
}

/** Public view of a proposal. `member` (optional) adds `myVote`. */
function publicProposal(p, member) {
  const t = tally(p);
  const mine = member && (p.votes || []).find(v => v.memberId === member.id);
  const auto = p.status === 'open' && p.closesAt && p.closesAt <= Date.now();
  return {
    id: p.id, title: p.title, detail: p.detail, kind: p.kind, scope: p.scope || 'coop',
    createdBy: p.createdBy, createdByName: p.createdByName, createdAt: p.createdAt,
    closesAt: p.closesAt || null, status: auto ? 'closed' : p.status,
    tally: t, votes: (p.votes || []).length, myVote: mine ? mine.choice : null,
    outcome: p.outcome || null
  };
}

/** Normalise a per-service local proposal (CoopBite object-votes or Bunji array-votes) into
 *  the shared shape — used in local read-only mode so governance pages still render in dev. */
function normalizeLocal(p) {
  const votes = Array.isArray(p.votes)
    ? p.votes // Bunji: [{ memberId, choice, at }]
    : Object.entries(p.votes || {}).map(([memberId, choice]) => ({ memberId, choice, at: null }));
  return {
    id: p.id, title: p.title || '', detail: p.detail || p.body || '',
    kind: p.kind || 'policy', scope: 'coop',
    createdBy: p.createdBy || null, createdByName: p.createdByName || p.createdBy || '',
    createdAt: p.createdAt || Date.now(), closesAt: p.closesAt || null,
    status: p.status || 'open', votes, outcome: p.outcome || null
  };
}

/**
 * Build the shared cooperative governance façade.
 * config: { coopDbUrl?, replicaUrl?, pglite?, localStore? }
 *   shared mode  (coopDbUrl or pglite): proposals stored in `gov_proposals` table.
 *   local mode   (neither): reads from localStore.load().proposals (normalised); writes refused.
 */
function createGovernance({ coopDbUrl, replicaUrl, pglite, localStore } = {}) {
  const sharedConfigured = !!(coopDbUrl || pglite);

  if (!sharedConfigured) {
    return {
      shared: false,
      isMember,
      publicProposal,
      async list() {
        if (!localStore) return [];
        return (localStore.load().proposals || []).map(normalizeLocal).slice().reverse();
      },
      async get(id) {
        if (!localStore) return null;
        const p = (localStore.load().proposals || []).find(p => p.id === id);
        return p ? normalizeLocal(p) : null;
      },
      async propose() { const e = new Error('Shared cooperative governance requires COOP_DATABASE_URL'); e.status = 503; throw e; },
      async vote()    { const e = new Error('Shared cooperative governance requires COOP_DATABASE_URL'); e.status = 503; throw e; },
      async close()   { const e = new Error('Shared cooperative governance requires COOP_DATABASE_URL'); e.status = 503; throw e; }
    };
  }

  const store = createStore({
    pgUrl: coopDbUrl, replicaUrl, pglite, tablePrefix: 'gov_',
    emptyDoc: () => ({ seq: 100, proposals: [], blobs: {} }),
    split: { proposals: { table: 'gov_proposals', key: 'proposals', cols: [
      ['status', p => p.status || 'open', 'text'],
      ['scope',  p => p.scope  || 'coop', 'text'],
      ['created_at', p => p.createdAt || null, 'bigint'],
      ['created_by', p => p.createdBy || null, 'text'] ] } },
    indexes: [
      ['gov_proposals_status',  'gov_proposals (status)'],
      ['gov_proposals_scope',   'gov_proposals (scope)'],
      ['gov_proposals_created', 'gov_proposals (created_at)'] ],
    logHotCap: {}
    // no usersKey — governance doesn't expose generic user lookups; memberCount lives in coop/members
  });

  async function upsertProposal(p) {
    return store.runScoped(async () => {
      await store.ensureLoaded(true);
      const db = store.load();
      const i = db.proposals.findIndex(x => x.id === p.id);
      if (i >= 0) db.proposals[i] = p; else db.proposals.push(p);
      store.save();
      await store.flush();
    });
  }

  /** Any member can raise a proposal. */
  async function propose(member, { title, detail, kind, scope, days }) {
    if (!isMember(member)) { const e = new Error('Only cooperative members can raise proposals'); e.status = 403; throw e; }
    const t = String(title || '').trim().slice(0, 120);
    if (!t) { const e = new Error('A proposal needs a title'); e.status = 400; throw e; }
    const d = Math.min(60, Math.max(1, Math.round(Number(days) || 14)));
    const p = {
      id: newProposalId(),
      title: t,
      detail: String(detail || '').trim().slice(0, 1000),
      kind: KINDS.includes(kind) ? kind : 'policy',
      scope: (scope && scope !== 'coop') ? String(scope).slice(0, 20) : 'coop',
      createdBy: member.id,
      createdByName: member.name || '',
      createdAt: Date.now(),
      closesAt: Date.now() + d * 86400000,
      status: 'open',
      votes: [],
      outcome: null
    };
    await upsertProposal(p);
    return p;
  }

  /** One member, one vote — re-voting while open updates the existing vote. */
  async function vote(member, proposalId, choice) {
    if (!CHOICES.includes(choice)) { const e = new Error('Vote must be yes, no or abstain'); e.status = 400; throw e; }
    if (!isMember(member)) { const e = new Error('Only cooperative members can vote'); e.status = 403; throw e; }
    return store.runScoped(async () => {
      await store.ensureLoaded(true);
      const db = store.load();
      const p = db.proposals.find(x => x.id === proposalId);
      if (!p) { const e = new Error('Proposal not found'); e.status = 404; throw e; }
      if (p.status !== 'open' || (p.closesAt && p.closesAt <= Date.now())) {
        const e = new Error('Voting has closed on this proposal'); e.status = 409; throw e;
      }
      p.votes = p.votes || [];
      const existing = p.votes.find(v => v.memberId === member.id);
      if (existing) { existing.choice = choice; existing.at = Date.now(); }
      else p.votes.push({ memberId: member.id, choice, at: Date.now() });
      store.save();
      await store.flush();
      return p;
    });
  }

  /** Admin closes a proposal and records the outcome. */
  async function close(proposalId) {
    return store.runScoped(async () => {
      await store.ensureLoaded(true);
      const db = store.load();
      const p = db.proposals.find(x => x.id === proposalId);
      if (!p) { const e = new Error('Proposal not found'); e.status = 404; throw e; }
      if (p.status === 'closed') { const e = new Error('Proposal is already closed'); e.status = 409; throw e; }
      const t = tally(p);
      p.status = 'closed';
      p.closedAt = Date.now();
      p.outcome = t.yes > t.no ? 'passed' : 'failed';
      store.save();
      await store.flush();
      return p;
    });
  }

  /** List proposals (newest first). filter: { scope?, status? } */
  async function list({ scope, status } = {}) {
    // Must run inside runScoped so store.load() has access to the pg/pglite context.
    return store.runScoped(async () => {
      await store.ensureLoaded(false);
      let ps = (store.load().proposals || []).slice().reverse();
      if (scope)  ps = ps.filter(p => p.scope === scope || p.scope === 'coop');
      if (status) ps = ps.filter(p => p.status === status);
      return ps;
    });
  }

  async function get(id) {
    return store.runScoped(async () => {
      await store.ensureLoaded(false);
      return (store.load().proposals || []).find(p => p.id === id) || null;
    });
  }

  return { shared: true, store, isMember, publicProposal, propose, vote, close, list, get };
}

module.exports = { createGovernance, isMember, publicProposal, tally };

// ---------------------------------------------------------------------------------
// ACTIVATION RUNBOOK (P3 cutover):
//   1. Provision COOP_DATABASE_URL (already done for members — same DB, different prefix).
//   2. Run migration: scripts/migrate-governance.js in each app — reads per-app proposals,
//      translates service-user-id vote keys → cooperative memberId, writes to gov_ store.
//   3. Deploy both apps with coop-core v0.10.0+.
//   4. Smoke: GET /api/governance on both apps should return the migrated proposals.
// ---------------------------------------------------------------------------------
