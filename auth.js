// auth.js — share-safe auth primitives: scrypt password hashing + role guards. These are
// byte-identical across the apps (same scrypt params, same salt scheme). The app-specific
// pieces — login flow, MFA strategy, session-token issuance, `userFromReq` (which needs the
// store) and `publicUser` — stay in each app until the store is shared (Phase 3). Token
// signing/verification live in `coop-core/secret`. Zero dependencies.
'use strict';
const crypto = require('node:crypto');

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

module.exports = { hashPassword, verifyPassword, requireRole };
