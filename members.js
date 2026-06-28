// members.js — the shared member directory (P1 of COOPERATIVE_PLATFORM.md). One member record
// per person across the WHOLE cooperative, backed by a shared cooperative database
// (COOP_DATABASE_URL) via the store engine. A member's identity (email/phone/passHash/MFA/
// consents) + their service enrolments (`services.{svc}.roles`) live here once; each service
// keeps its own operational data keyed by the member id.
//
// GATED: when no shared directory is configured, `createMembers` falls back to the service's
// OWN store (its existing `users`), so nothing changes until the cooperative DB is provisioned
// and the one-time backfill is run. Activation runbook at the bottom of this file.
'use strict';
const crypto = require('node:crypto');
const { createStore } = require('./store');
const { enrol } = require('./cooperative');

/** A fresh, globally-unique cooperative member id (service user-ids can collide across apps). */
const newMemberId = () => 'mbr_' + crypto.randomBytes(8).toString('hex');

/** Map a service user record → a cooperative member record (identity + one service enrolment).
 *  `id` (optional) sets the member id; otherwise an existing `memberId` or a fresh unique id. */
function toMember(user, service, id) {
  const m = {
    id: id || user.memberId || newMemberId(),
    name: user.name || null,
    email: (user.email || '').toLowerCase() || null,
    phone: user.phone || null,
    passHash: user.passHash || null,
    mfaEnabled: !!user.mfaEnabled,
    mfaSecret: user.mfaSecret || null,
    consents: user.consents || (user.application && user.application.consents) || null,
    status: user.status || 'active',
    joinedAt: user.joinedAt || user.createdAt || Date.now(),
    services: {}
  };
  if (service && user.role) enrol(m, service, user.role, { status: user.status || 'active' });
  return m;
}

/**
 * Build the member-directory façade.
 * config: { coopDbUrl, replicaUrl, pglite, localStore }
 *   - shared mode  (coopDbUrl or pglite): a dedicated store over `coop_members`.
 *   - local mode   (neither): delegate to the service's own store (`localStore.getUser…`).
 */
function createMembers({ coopDbUrl, replicaUrl, pglite, localStore } = {}) {
  const sharedConfigured = !!(coopDbUrl || pglite);

  if (!sharedConfigured) {
    if (!localStore) throw new Error('createMembers: provide a localStore (or a shared coopDbUrl)');
    return {
      shared: false,
      getById: id => localStore.getUser(id),
      getByEmail: email => localStore.getUserByEmail(email),
      getByPhone: phone => (localStore.getUserByPhone ? localStore.getUserByPhone(phone) : Promise.resolve(null)),
      count: () => localStore.countUsers(),
      async upsertFromUser() { throw new Error('directory sync requires a shared cooperative directory (COOP_DATABASE_URL)'); },
      async upsert() { throw new Error('member upsert requires a shared cooperative directory (COOP_DATABASE_URL)'); },
      async backfill() { throw new Error('backfill requires a shared cooperative directory (COOP_DATABASE_URL)'); }
    };
  }

  const store = createStore({
    pgUrl: coopDbUrl, replicaUrl, pglite, tablePrefix: 'coop_',
    emptyDoc: () => ({ seq: 1000, members: [], blobs: {} }),
    split: { members: { table: 'coop_members', key: 'members', cols: [
      ['email', m => (m.email || '').toLowerCase() || null, 'text'],
      ['phone', m => m.phone || null, 'text'],
      ['status', m => m.status || 'active', 'text'] ] } },
    indexes: [['coop_members_email', 'coop_members (email)'], ['coop_members_phone', 'coop_members (phone)']],
    logHotCap: {}, usersKey: 'members'
  });

  /** Insert or replace a member (own write transaction). */
  async function upsert(member) {
    return store.runScoped(async () => {
      await store.ensureLoaded(true);
      const db = store.load();
      const i = db.members.findIndex(m => m.id === member.id);
      if (i >= 0) db.members[i] = member; else db.members.push(member);
      store.save();
      await store.flush();
    });
  }

  /**
   * Insert or enrol ONE service user into the directory (idempotent). Deduplicated by email:
   * an existing member gains this service's role enrolment; a new person gets a fresh member.
   * Returns { memberId, merged }. Used for live registration-sync and by backfill().
   */
  async function upsertFromUser(user, service) {
    const email = (user.email || '').toLowerCase();
    const existing = email ? await store.getUserByEmail(email) : null;
    if (existing) {
      enrol(existing, service, user.role, { status: user.status || 'active' });
      await upsert(existing);
      return { memberId: existing.id, merged: true };
    }
    const m = toMember(user, service, newMemberId());
    await upsert(m);
    return { memberId: m.id, merged: false };
  }

  /**
   * One-time (idempotent) bulk backfill of a service's users. Returns { created, merged } and an
   * id-map { serviceUserId → memberId } for the cutover.
   */
  async function backfill(users, service) {
    let created = 0, merged = 0; const idMap = {};
    for (const u of users) {
      const r = await upsertFromUser(u, service);
      idMap[u.id] = r.memberId;
      if (r.merged) merged += 1; else created += 1;
    }
    return { created, merged, idMap };
  }

  return {
    shared: true, store,
    getById: id => store.getUser(id),
    getByEmail: email => store.getUserByEmail(email),
    getByPhone: phone => store.getUserByPhone ? store.getUserByPhone(phone) : Promise.resolve(null),
    count: () => store.countUsers(),
    upsert, upsertFromUser, backfill
  };
}

module.exports = { createMembers, toMember };

// ---------------------------------------------------------------------------------------------
// ACTIVATION RUNBOOK (P1 cutover — run once the cooperative DB exists):
//   1. Provision a shared Neon project; set COOP_DATABASE_URL in BOTH apps' env.
//   2. Backfill (read-only on the services; idempotent): for each app, in a maintenance script,
//      `createMembers({coopDbUrl}).backfill(await store.queryUsers({}), '<service>')`. Persist the
//      returned idMap → set `user.memberId` on each service user (links service data → member).
//   3. Dual-read window: auth resolves the member via `members.getByEmail/getById`; service
//      handlers still read their local user by memberId. Verify with a read-only prod smoke.
//   4. Cutover: registrations create a member (or enrol an existing one) + a thin service user.
//      SSO works because the bearer token (coop-core/secret) is the same across services.
// ---------------------------------------------------------------------------------------------
