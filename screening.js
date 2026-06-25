// screening.js — background / police check (PRD ONB-23; STATUS §C.3). Provider-agnostic
// REST seam: the co-op plugs in a screening provider (e.g. Checkr, National Crime Check,
// CVCheck) via a base URL + API key; the applicant must have consented (the driver
// `backgroundConsent` compliance item). A "clear" result satisfies the police-check item.
// GATED: with no provider configured, checks are mock and return "clear", so the pilot's
// manual review is unchanged.
//
// Config: BACKGROUND_CHECK_URL (base), BACKGROUND_CHECK_API_KEY (Bearer).
'use strict';

const URL_ = () => (process.env.BACKGROUND_CHECK_URL || '').replace(/\/$/, '');
const configured = () => !!(URL_() && process.env.BACKGROUND_CHECK_API_KEY);

async function req(path, params, method = 'POST') {
  const init = { method, headers: { Authorization: 'Bearer ' + process.env.BACKGROUND_CHECK_API_KEY } };
  if (method !== 'GET') { init.headers['Content-Type'] = 'application/json'; init.body = JSON.stringify(params || {}); }
  const res = await fetch(URL_() + path, init);
  const j = await res.json().catch(() => ({}));
  if (!res.ok) { const e = new Error('Background check ' + res.status + ': ' + (j.error || j.message || 'request failed')); e.status = 502; throw e; }
  return j;
}

/** Normalise a provider status to our vocabulary. */
function normalise(s) {
  s = String(s || '').toLowerCase();
  if (['clear', 'cleared', 'pass', 'passed', 'complete', 'completed'].includes(s)) return 'clear';
  if (['consider', 'review', 'fail', 'failed', 'flagged'].includes(s)) return 'consider';
  return 'pending';
}

/** Order a background check for an applicant. Mock when unconfigured. */
async function createCheck({ userId, name, email, dob } = {}) {
  if (!configured()) return { provider: 'mock', checkId: 'bgc_mock_' + (userId || Date.now()), status: 'pending', mock: true };
  const r = await req('/checks', { candidate: { name, email, dob }, metadata: { userId } });
  return { provider: 'screening', checkId: r.id || r.checkId, status: normalise(r.status) };
}

/** Poll a check's status. Mock returns 'clear'. Returns { status, cleared, mock? }. */
async function getCheck(checkId) {
  if (!configured() || !checkId || String(checkId).startsWith('bgc_mock_')) {
    return { status: 'clear', cleared: true, checkedAt: Date.now(), provider: 'mock', mock: true };
  }
  const r = await req('/checks/' + checkId, null, 'GET');
  const status = normalise(r.status);
  return { status, cleared: status === 'clear', checkedAt: Date.now(), provider: 'screening' };
}

module.exports = { configured, normalise, createCheck, getCheck };
