// oidc.js — OIDC / OpenID Connect client (PKCE, no extra npm deps).
// Activates only when OIDC_CLIENT_ID + OIDC_CLIENT_SECRET + OIDC_ISSUER_URL are set.
// In the pilot these env vars are absent; the login screen hides the SSO button.
'use strict';
const crypto = require('crypto');
const https  = require('https');

const CLIENT_ID     = process.env.OIDC_CLIENT_ID;
const CLIENT_SECRET = process.env.OIDC_CLIENT_SECRET;
const ISSUER_URL    = process.env.OIDC_ISSUER_URL;  // e.g. https://accounts.google.com
const BASE_URL      = process.env.COOPBITE_BASE_URL || 'https://coopbite.vercel.app';

function enabled() { return !!(CLIENT_ID && CLIENT_SECRET && ISSUER_URL); }

// ---------- HTTP helpers (no npm deps) ----------

function fetchJson(url) {
  return new Promise((res, rej) => {
    https.get(url, r => {
      let buf = '';
      r.on('data', d => (buf += d));
      r.on('end', () => { try { res(JSON.parse(buf)); } catch (e) { rej(e); } });
    }).on('error', rej);
  });
}

function postForm(url, params) {
  return new Promise((res, rej) => {
    const body = new URLSearchParams(params).toString();
    const u = new URL(url);
    const opts = {
      hostname: u.hostname, path: u.pathname + u.search, method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded',
                 'Content-Length': Buffer.byteLength(body) }
    };
    const req = https.request(opts, r => {
      let buf = '';
      r.on('data', d => (buf += d));
      r.on('end', () => { try { res(JSON.parse(buf)); } catch (e) { rej(e); } });
    });
    req.on('error', rej);
    req.write(body);
    req.end();
  });
}

// ---------- OIDC discovery (cached per process) ----------

let _discovery = null;
async function discover() {
  if (_discovery) return _discovery;
  _discovery = await fetchJson(`${ISSUER_URL}/.well-known/openid-configuration`);
  return _discovery;
}

// ---------- PKCE state store (in-memory, 10-min TTL) ----------

const states = new Map();
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of states) { if (v.exp < now) states.delete(k); }
}, 120000);

/** Build the IdP authorisation URL and return it along with the state token. */
async function startLogin(redirectPath = '/') {
  const d = await discover();
  const state    = crypto.randomBytes(16).toString('hex');
  const verifier = crypto.randomBytes(32).toString('base64url');
  const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
  states.set(state, { verifier, redirectPath, exp: Date.now() + 600000 });
  const params = new URLSearchParams({
    response_type: 'code',
    client_id:     CLIENT_ID,
    redirect_uri:  `${BASE_URL}/api/auth/oidc/callback`,
    scope:         'openid email profile',
    state,
    code_challenge:        challenge,
    code_challenge_method: 'S256'
  });
  return `${d.authorization_endpoint}?${params}`;
}

/** Exchange an auth code for user claims.  Returns {email, name, sub, redirectPath}. */
async function handleCallback(code, state) {
  const s = states.get(state);
  if (!s || s.exp < Date.now()) {
    throw Object.assign(new Error('Invalid or expired OIDC state'), { status: 400 });
  }
  states.delete(state);
  const d = await discover();
  const tok = await postForm(d.token_endpoint, {
    grant_type:    'authorization_code',
    code,
    client_id:     CLIENT_ID,
    client_secret: CLIENT_SECRET,
    redirect_uri:  `${BASE_URL}/api/auth/oidc/callback`,
    code_verifier: s.verifier
  });
  if (tok.error) {
    throw Object.assign(new Error(tok.error_description || tok.error), { status: 400 });
  }
  // Decode id_token claims (we trust our own token endpoint response in the pilot;
  // production should verify the JWT signature against the IdP's JWKS).
  const [, body] = tok.id_token.split('.');
  const claims = JSON.parse(Buffer.from(body, 'base64url').toString());
  return {
    email: claims.email,
    name:  claims.name || claims.given_name || claims.email,
    sub:   claims.sub,
    redirectPath: s.redirectPath
  };
}

module.exports = { enabled, startLogin, handleCallback };
