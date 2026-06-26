// payments.js — payment processor seam (PRD CUS-05 / DRV-11; STATUS §C.1).
// The cooperative money engine (fare.js) and the mock settlement ledger (order issues,
// refunds, payout statements) already decide every cent server-side. This module is the
// thin processor surface that turns those decisions into real money movement via Stripe
// (AU, charges in AUD cents — Stripe's native minor unit). Zero-dependency: the Stripe
// REST API is called over `fetch` with form-encoded bodies (same approach as push.js).
//
// It is GATED on credentials. With no STRIPE_SECRET_KEY set, every call returns a `mock`
// result and moves no money — preserving the exact pilot behaviour (orders are PLACED,
// refunds are recorded on the order, no external charge). To go live, set:
//   STRIPE_SECRET_KEY   (sk_live_… or sk_test_…)
// Currency defaults to AUD; override with PAYMENTS_CURRENCY.
'use strict';

const API = 'https://api.stripe.com/v1';
const configured = () => !!process.env.STRIPE_SECRET_KEY;
const currency = () => (process.env.PAYMENTS_CURRENCY || 'aud').toLowerCase();

/** Flatten a nested object into Stripe's bracketed form-encoding (metadata[orderId]=…). */
function encode(obj, prefix, out) {
  out = out || new URLSearchParams();
  for (const [k, v] of Object.entries(obj)) {
    if (v == null) continue;
    const key = prefix ? `${prefix}[${k}]` : k;
    if (typeof v === 'object' && !Array.isArray(v)) encode(v, key, out);
    else out.append(key, String(v));
  }
  return out;
}

async function stripe(path, params, { idempotencyKey, method = 'POST' } = {}) {
  const headers = { Authorization: 'Bearer ' + process.env.STRIPE_SECRET_KEY };
  if (idempotencyKey) headers['Idempotency-Key'] = idempotencyKey;
  const init = { method, headers };
  if (method !== 'GET') {
    headers['Content-Type'] = 'application/x-www-form-urlencoded';
    init.body = encode(params || {}).toString();
  }
  const res = await fetch(API + path, init);
  const j = await res.json().catch(() => ({}));
  if (!res.ok) {
    const e = new Error('Stripe ' + res.status + ': ' + ((j.error && j.error.message) || 'request failed'));
    e.status = 502; throw e;
  }
  return j;
}

/**
 * Create a payment intent for an order total. Mock when unconfigured.
 * Returns { provider, intentId, status, amountCents, currency, clientSecret?, mock? }.
 * Never throws when unconfigured; in live mode a Stripe error propagates (status 502).
 */
async function createIntent({ amountCents, orderId, customerEmail, metadata }) {
  amountCents = Math.max(0, Math.round(amountCents || 0));
  if (!configured()) {
    return { provider: 'mock', intentId: 'pi_mock_' + (orderId || Date.now()), status: 'mock',
      amountCents, currency: currency(), mock: true };
  }
  const pi = await stripe('/payment_intents', {
    amount: amountCents, currency: currency(), confirm: false,
    'automatic_payment_methods': { enabled: true },
    description: orderId ? `CoopBite order ${orderId}` : 'CoopBite order',
    receipt_email: customerEmail || undefined,
    metadata: { orderId: orderId || '', ...(metadata || {}) }
  }, orderId ? { idempotencyKey: 'create:' + orderId } : undefined);
  return { provider: 'stripe', intentId: pi.id, status: pi.status, amountCents,
    currency: currency(), clientSecret: pi.client_secret };
}

/** Capture a previously authorised intent (when manual capture is used). Mock-safe. */
async function capture(intentId, amountCents) {
  if (!configured() || !intentId || String(intentId).startsWith('pi_mock_')) {
    return { intentId, status: 'captured', mock: true };
  }
  const params = amountCents != null ? { amount_to_capture: Math.round(amountCents) } : {};
  const pi = await stripe(`/payment_intents/${intentId}/capture`, params);
  return { intentId: pi.id, status: pi.status };
}

/**
 * Refund (full or partial) against an order's payment intent. Mock when unconfigured —
 * the caller still records the refund on the order ledger exactly as today.
 * Returns { refundId, status, amountCents, mock? }.
 */
async function refund({ intentId, amountCents, reason }) {
  amountCents = Math.max(0, Math.round(amountCents || 0));
  if (!configured() || !intentId || String(intentId).startsWith('pi_mock_')) {
    return { refundId: 'rf_mock_' + Date.now(), status: 'succeeded', amountCents, mock: true };
  }
  const params = { payment_intent: intentId };
  if (amountCents > 0) params.amount = amountCents;        // omit ⇒ full refund
  if (['duplicate', 'fraudulent', 'requested_by_customer'].includes(reason)) params.reason = reason;
  const r = await stripe('/refunds', params);
  return { refundId: r.id, status: r.status, amountCents: r.amount };
}

module.exports = { configured, currency, createIntent, capture, refund, request: stripe };
