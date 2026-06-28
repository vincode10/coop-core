// cooperative.js — cooperative-level identity + the member service-role model.
// (See COOPERATIVE_PLATFORM.md.) One person = one member of THE cooperative; a member enrols
// in services (coopbite, bunji, …) and holds service-scoped roles. These helpers read the
// target member shape `{ services: { <svc>: { roles, status } } }` and fall back to the legacy
// flat `member.role` during migration, so each app can adopt incrementally without breaking.
'use strict';

const COOPERATIVE = Object.freeze({
  name: 'The Cooperative',
  tagline: 'Member-owned. Many services. One vote.'
});

/** Service keys a member is enrolled in (target model), or [] for a legacy flat-role user. */
function memberServices(member) {
  if (member && member.services && typeof member.services === 'object') return Object.keys(member.services);
  return [];
}

/** Is the member enrolled in `service`? (Legacy flat-role users count as enrolled everywhere
 *  their single role applies — see hasServiceRole.) */
function inService(member, service) {
  return !!(member && member.services && member.services[service]);
}

/** Does the member hold one of `roles` in `service`? With no roles given, "any role in the
 *  service" is enough. Falls back to a legacy flat `member.role` so pre-migration checks work. */
function hasServiceRole(member, service, ...roles) {
  if (!member) return false;
  const svc = member.services && member.services[service];
  if (svc && Array.isArray(svc.roles)) return roles.length === 0 ? svc.roles.length > 0 : roles.some(r => svc.roles.includes(r));
  if (member.role) return roles.length === 0 || roles.includes(member.role); // legacy single-role model
  return false;
}

/** Throw 401 if not authenticated, 403 if the member lacks the service role. */
function requireServiceRole(member, service, ...roles) {
  if (!member) { const e = new Error('Authentication required'); e.status = 401; throw e; }
  if (!hasServiceRole(member, service, ...roles)) { const e = new Error('Forbidden for your role'); e.status = 403; throw e; }
}

/** Enrol a member in a service with a role (idempotent, additive). Returns the member.
 *  `userId` (optional) records the service's own user id for this member — a stable secondary
 *  dedup key so a re-backfill of email-less users doesn't duplicate them. */
function enrol(member, service, role, { status = 'active', userId } = {}) {
  member.services = member.services || {};
  const svc = member.services[service] || (member.services[service] = { roles: [], status });
  if (role && !svc.roles.includes(role)) svc.roles.push(role);
  if (userId && !svc.userId) svc.userId = userId;
  return member;
}

module.exports = { COOPERATIVE, memberServices, inService, hasServiceRole, requireServiceRole, enrol };
