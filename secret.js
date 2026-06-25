// secret.js — signing-key management with zero-downtime rotation (STATUS §D).
// `COOPBITE_SECRET` may be a comma-separated list of keys. The FIRST key is "current" and
// signs all new tokens/hashes; EVERY key is accepted on verification. To rotate without
// invalidating live tokens: prepend the new key (`new,old`), deploy, let old tokens expire,
// then drop the old key. Used by auth bearer tokens, password-reset and OTP hashes.
'use strict';
const crypto = require('node:crypto');
const FALLBACK = 'coopbite-pilot-secret-change-me';

/** All active keys, current first. Always ≥ 1 entry. */
function all() {
  const keys = (process.env.COOPBITE_SECRET || FALLBACK).split(',').map(s => s.trim()).filter(Boolean);
  return keys.length ? keys : [FALLBACK];
}
/** The current signing key. */
function current() { return all()[0]; }

/** HMAC-SHA256 hex of `data` under the current key (for storing a new hash). */
function hashHex(data) { return crypto.createHmac('sha256', current()).update(data).digest('hex'); }
/** HMAC-SHA256 hex under every active key — check membership for a stored hash. */
function hashesHex(data) { return all().map(s => crypto.createHmac('sha256', s).update(data).digest('hex')); }

/** base64url MAC under the current key (for signing). */
function signB64(data) { return crypto.createHmac('sha256', current()).update(data).digest('base64url'); }
/** Constant-time verify a base64url MAC against any active key. */
function verifyB64(data, mac) {
  if (!mac) return false;
  for (const s of all()) {
    const expect = crypto.createHmac('sha256', s).update(data).digest('base64url');
    if (mac.length === expect.length && crypto.timingSafeEqual(Buffer.from(mac), Buffer.from(expect))) return true;
  }
  return false;
}

module.exports = { all, current, hashHex, hashesHex, signB64, verifyB64, FALLBACK };
