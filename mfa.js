// mfa.js — TOTP two-factor authentication (RFC 6238 / RFC 4226), encoding-agnostic.
// The HOTP/TOTP algorithm is identical across apps; only how each app *stores* the shared
// secret differs (CoopBite: hex, Bunji: base32). This engine operates on the raw key bytes
// and takes the secret's `encoding` as an option, so each app keeps storing in its existing
// format with no data migration. Pure node:crypto, zero dependencies.
'use strict';
const crypto = require('node:crypto');

const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const DIGITS = 6;
const STEP_MS = 30000;

function base32Encode(buf) {
  let bits = 0, val = 0, out = '';
  for (const b of buf) { val = (val << 8) | b; bits += 8; while (bits >= 5) { out += B32[(val >>> (bits - 5)) & 31]; bits -= 5; } }
  if (bits > 0) out += B32[(val << (5 - bits)) & 31];
  return out;
}
function base32Decode(str) {
  let bits = 0, val = 0; const out = [];
  for (const c of String(str).toUpperCase().replace(/=+$/, '')) {
    const i = B32.indexOf(c); if (i < 0) continue;
    val = (val << 5) | i; bits += 5;
    if (bits >= 8) { out.push((val >>> (bits - 8)) & 0xff); bits -= 8; }
  }
  return Buffer.from(out);
}
function hexToBase32(hex) { return base32Encode(Buffer.from(hex, 'hex')); }

/** Decode a stored secret to its raw key bytes. */
function keyBytes(secret, encoding) { return encoding === 'hex' ? Buffer.from(secret, 'hex') : base32Decode(secret); }

/** HOTP (RFC 4226): HMAC-SHA1 over an 8-byte counter, dynamically truncated to 6 digits. */
function hotp(keyBuf, counter) {
  const buf = Buffer.alloc(8); buf.writeBigUInt64BE(BigInt(counter));
  const h = crypto.createHmac('sha1', keyBuf).update(buf).digest();
  const off = h[h.length - 1] & 0x0f;
  const bin = ((h[off] & 0x7f) << 24) | (h[off + 1] << 16) | (h[off + 2] << 8) | h[off + 3];
  return String(bin % (10 ** DIGITS)).padStart(DIGITS, '0');
}

/** Current TOTP code for a secret. opts: { encoding='base32', at=Date.now() }. */
function totp(secret, { encoding = 'base32', at = Date.now() } = {}) {
  return hotp(keyBytes(secret, encoding), Math.floor(at / STEP_MS));
}

/** Verify a 6-digit code (timing-safe). opts: { encoding='base32', at=Date.now(), window=1 }. */
function verify(secret, code, { encoding = 'base32', at = Date.now(), window = 1 } = {}) {
  if (!secret || !/^\d{6}$/.test(String(code || ''))) return false;
  const key = keyBytes(secret, encoding);
  const t = Math.floor(at / STEP_MS);
  for (let w = -window; w <= window; w++) {
    const cand = hotp(key, t + w);
    if (cand.length === String(code).length && crypto.timingSafeEqual(Buffer.from(cand), Buffer.from(String(code)))) return true;
  }
  return false;
}

/** Fresh 20-byte TOTP secret, returned in the requested encoding. */
function generateSecret(encoding = 'base32') {
  const b = crypto.randomBytes(20);
  return encoding === 'hex' ? b.toString('hex') : base32Encode(b);
}

/** otpauth:// URI for an authenticator app (always emits the base32 secret). */
function otpauthUrl(secret, { encoding = 'base32', label = 'user', issuer = 'Co-op' } = {}) {
  const b32 = encoding === 'hex' ? hexToBase32(secret) : secret;
  return `otpauth://totp/${encodeURIComponent(issuer)}:${encodeURIComponent(label)}`
    + `?secret=${b32}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=${DIGITS}&period=30`;
}

/** A short numeric OTP (e.g. phone-code login). */
function numericCode(len = 6) { return String(crypto.randomInt(0, 10 ** len)).padStart(len, '0'); }

module.exports = { generateSecret, totp, verify, otpauthUrl, hexToBase32, base32Encode, base32Decode, numericCode };
