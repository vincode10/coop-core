// auth.js — share-safe auth primitives: scrypt password hashing, role guards, the bearer-
// token codec (HMAC over a base64url JSON body, keys from coop-core/secret) and a
// `createUserFromReq(store)` factory. These are byte-identical across the apps. App-specific
// pieces — the login flow, MFA strategy and `publicUser` strip-list — stay in each app.
'use strict';
const crypto = require('node:crypto');
const secret = require('./secret');

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

module.exports = { hashPassword, verifyPassword, requireRole, tokenSign, tokenVerify, createUserFromReq };
