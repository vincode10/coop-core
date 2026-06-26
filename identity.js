// identity.js — ID-document + identity proofing (PRD ONB-11/25; STATUS §C.3). Uses Stripe
// Identity (reuses STRIPE_SECRET_KEY — no new account) to capture and verify a government ID
// and selfie. A verified result legitimately satisfies the "identity document sighted"
// compliance item. GATED: with no Stripe key, sessions are mock and verification is
// simulated, so the pilot's manual review is unchanged.
//
// Flow: createSession() → applicant completes the Stripe-hosted flow (url/client_secret)
//       → complete(sessionId) reads the result back.
'use strict';
const payments = require('./payments');

const configured = () => payments.configured();

/** Open a Stripe Identity verification session. Mock when Stripe is unconfigured. */
async function createSession({ userId, email } = {}) {
  if (!configured()) {
    return { provider: 'mock', sessionId: 'vs_mock_' + (userId || Date.now()), url: null, clientSecret: null, status: 'mock', mock: true };
  }
  const vs = await payments.request('/identity/verification_sessions', {
    type: 'document',
    'metadata[userId]': userId || '',
    'options[document][require_matching_selfie]': 'true'
  });
  return { provider: 'stripe', sessionId: vs.id, url: vs.url || null, clientSecret: vs.client_secret || null, status: vs.status };
}

/** Read the verification result. Mock-safe. Returns { status, verified, name?, mock? }. */
async function complete(sessionId) {
  if (!configured() || !sessionId || String(sessionId).startsWith('vs_mock_')) {
    return { status: 'verified', verified: true, name: 'Verified Applicant (mock)', verifiedAt: Date.now(), provider: 'mock', mock: true };
  }
  const vs = await payments.request(`/identity/verification_sessions/${sessionId}`, null, { method: 'GET' });
  const verified = vs.status === 'verified';
  const out = vs.verified_outputs || {};
  const name = [out.first_name, out.last_name].filter(Boolean).join(' ') || null;
  return { status: vs.status, verified, name: verified ? name : null, verifiedAt: verified ? Date.now() : null, provider: 'stripe' };
}

module.exports = { configured, createSession, complete };
