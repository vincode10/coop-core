// auth.js — share-safe auth primitives: scrypt password hashing, role guards, the bearer-
// token codec (HMAC over a base64url JSON body, keys from coop-core/secret) and a
// `createUserFromReq(store)` factory. These are byte-identical across the apps. App-specific
// pieces — the login flow, MFA strategy and `publicUser` strip-list — stay in each app.
'use strict';
const crypto = require('node:crypto');
const secret = require('./secret');
const { requireServiceRole } = require('./cooperative');

/** Sign a payload into a `<base64url(JSON)>.<mac>` bearer token (current key). */
function tokenSign(payload) {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return `${body}.${secret.signB64(body)}`;
}

/** Verify a bearer token's MAC (against any active key) and return its payload, or null.
 *  Does NOT check expiry — callers decide (e.g. session vs short-lived MFA token). */
function tokenVerify(token) {
  if (!token) return null;
  const [body, mac] = String(token).split('.');
  if (!body || !mac) return null;
  if (!secret.verifyB64(body, mac)) return null;
  try { return JSON.parse(Buffer.from(body, 'base64url').toString()); } catch { return null; }
}

/** Build the per-request user resolver: Bearer token → verified, unexpired → store.getUser. */
function createUserFromReq(store) {
  return async function userFromReq(req) {
    const h = req.headers['authorization'] || '';
    const tok = h.startsWith('Bearer ') ? h.slice(7) : null;
    const payload = tokenVerify(tok);
    if (!payload) return null;
    if (!payload.exp || payload.exp < Date.now()) return null;
    return store.getUser(payload.uid);
  };
}

/** Attach the resolved cooperative member to a service-user object WITHOUT persisting it: a
 *  non-enumerable property is invisible to JSON.stringify and `{...spread}`, so it never leaks
 *  into the store's `data` column or split-table columns even if the user is later saved. */
function attachMember(user, member) {
  if (user && member) Object.defineProperty(user, '_member', { value: member, enumerable: false, configurable: true, writable: true });
  return user;
}

/**
 * Build a member-aware per-request user resolver (P2 of COOPERATIVE_PLATFORM.md).
 * Resolves Bearer → verified, unexpired token → the service's LOCAL user, then best-effort
 * enriches it with the cooperative member from the shared directory.
 *
 *   - Same-app token: `payload.uid` → `store.getUser` (the existing hot path — unchanged).
 *   - Cross-app token (SSO): the uid is another service's; we fall back to OUR local user via
 *     `store.getUserByMemberId(payload.mid)`.
 *   - The member (`members.getById(mid)`) is attached as a non-persisted `user._member` for
 *     `requireRoleFor`/`requireServiceRole`.
 *
 * RESILIENT BY DESIGN: directory resolution is wrapped so it can NEVER break local auth — if the
 * cooperative DB is slow/down/misconfigured, same-app login still works exactly as before.
 * `members` may be omitted (or unconfigured) → behaves like `createUserFromReq`.
 */
function createMemberResolver({ store, members } = {}) {
  if (!store) throw new Error('createMemberResolver: provide a store');
  return async function userFromReq(req) {
    const h = req.headers['authorization'] || '';
    const tok = h.startsWith('Bearer ') ? h.slice(7) : null;
    const payload = tokenVerify(tok);
    if (!payload) return null;
    if (!payload.exp || payload.exp < Date.now()) return null;

    // Local user — the critical path. Never let directory work below affect this result.
    let user = null;
    try { if (payload.uid) user = await store.getUser(payload.uid); } catch { user = null; }

    // Best-effort cooperative enrichment + cross-service resolution (fallback-to-local on any error).
    if (members && members.shared && payload.mid) {
      try {
        if (!user && store.getUserByMemberId) user = await store.getUserByMemberId(payload.mid); // SSO
        const member = await members.getById(payload.mid);
        attachMember(user, member);
      } catch { /* directory unavailable — keep the local user (or null) */ }
    }
    return user;
  };
}

/**
 * A member-aware `requireRole(user, ...roles)` bound to one service. Drop-in for the legacy
 * `requireRole`: when the user carries a resolved `_member`, authorisation uses the cooperative
 * service-role model (`requireServiceRole`); otherwise it falls back to the flat `user.role`.
 * Keeps every existing call site unchanged while enabling cross-service roles + SSO.
 */
function requireRoleFor(service) {
  return function requireRole(user, ...roles) {
    if (!user) { const e = new Error('Authentication required'); e.status = 401; throw e; }
    if (user._member) return requireServiceRole(user._member, service, ...roles);
    if (!roles.includes(user.role)) { const e = new Error('Forbidden for your role'); e.status = 403; throw e; }
  };
}

/** scrypt password hash → "salt:hash" (8-byte salt, 32-byte derived key). */
function hashPassword(pw, salt = crypto.randomBytes(8).toString('hex')) {
  const h = crypto.scryptSync(pw, salt, 32).toString('hex');
  return `${salt}:${h}`;
}

/** Constant-time verify of a password against a stored "salt:hash". */
function verifyPassword(pw, stored) {
  const [salt, h] = String(stored).split(':');
  if (!salt || !h) return false;
  const cand = crypto.scryptSync(pw, salt, 32).toString('hex');
  const a = Buffer.from(h, 'hex'), b = Buffer.from(cand, 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/** Throw 401 if unauthenticated, 403 if the user's role isn't allowed. */
function requireRole(user, ...roles) {
  if (!user) { const e = new Error('Authentication required'); e.status = 401; throw e; }
  if (!roles.includes(user.role)) { const e = new Error('Forbidden for your role'); e.status = 403; throw e; }
}

module.exports = { hashPassword, verifyPassword, requireRole, requireRoleFor, tokenSign, tokenVerify, createUserFromReq, createMemberResolver, attachMember };
