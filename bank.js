// bank.js — payout bank-account verification (PRD ONB-24; STATUS §C). Uses Stripe
// Financial Connections to let a driver/restaurant securely link and verify the bank
// account they'll be paid out to, instead of typing an unverified account number.
// Reuses the Stripe seam (payments.request) so it shares the STRIPE_SECRET_KEY — no new
// account. GATED: with no key set, sessions are `mock` and verification is simulated, so
// the pilot's manual `bankRef` flow is unchanged.
//
// Two-step flow (the link UI itself runs client-side with Stripe.js):
//   1. createSession() → returns a client_secret the front-end hands to Stripe.js
//   2. complete(sessionId) → server reads the linked account back and stores a summary
'use strict';
const payments = require('./payments');

const configured = () => payments.configured(); // STRIPE_SECRET_KEY

/** Open a Financial Connections session for a user. Mock when Stripe is unconfigured. */
async function createSession({ userId, accountHolderName, email } = {}) {
  if (!configured()) {
    return { provider: 'mock', sessionId: 'fcs_mock_' + (userId || Date.now()), clientSecret: null, status: 'mock', mock: true };
  }
  // A FC session needs an account holder; create a lightweight customer to anchor it.
  const cust = await payments.request('/customers', { name: accountHolderName || undefined, email: email || undefined, 'metadata[userId]': userId || '' });
  const sess = await payments.request('/financial_connections/sessions', {
    'account_holder[type]': 'customer',
    'account_holder[customer]': cust.id,
    'permissions[]': 'ownership'
  });
  return { provider: 'stripe', sessionId: sess.id, clientSecret: sess.client_secret, status: 'pending', customerId: cust.id };
}

/** Read the linked account back and produce a non-sensitive summary. Mock-safe. */
async function complete(sessionId) {
  if (!configured() || !sessionId || String(sessionId).startsWith('fcs_mock_')) {
    return { status: 'verified', last4: '4242', institution: 'Demo Mutual (mock)', verifiedAt: Date.now(), provider: 'mock', mock: true };
  }
  const sess = await payments.request(`/financial_connections/sessions/${sessionId}`, null, { method: 'GET' });
  const list = (sess.accounts && (sess.accounts.data || sess.accounts)) || [];
  const acct = list[0];
  if (!acct) return { status: 'pending', provider: 'stripe' };
  return { status: 'verified', last4: acct.last4 || null, institution: acct.institution_name || null,
    accountId: acct.id, verifiedAt: Date.now(), provider: 'stripe' };
}

module.exports = { configured, createSession, complete };
