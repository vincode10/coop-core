// compliance.js — onboarding requirement evaluator (PRD ONB). The per-role requirement
// *catalogue* is the app's domain and stays in each app; this is the shared engine that
// evaluates an application against a catalogue, builds it from a registration payload, and
// records admin verifications. Inject the catalogue via createCompliance(). Item types:
//   field (validated text/number) · attest (boolean) · consent (versioned) · verify (admin).
'use strict';

const DEFAULT_POLICY_VERSION = '2026-06';

/** ABN format check (11 digits). */
const abnOk = v => /^\d{11}$/.test(String(v || '').replace(/\s/g, ''));

/** Whole years since a yyyy-mm-dd date (UTC), or null if malformed. */
const yearsSince = ymd => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(ymd || ''))) return null;
  const d = new Date(ymd + 'T00:00:00Z'), now = new Date();
  let a = now.getUTCFullYear() - d.getUTCFullYear();
  const m = now.getUTCMonth() - d.getUTCMonth();
  if (m < 0 || (m === 0 && now.getUTCDate() < d.getUTCDate())) a--;
  return a;
};

/** Is one catalogue item satisfied by the stored application? (catalogue-independent) */
function itemSatisfied(item, app) {
  app = app || {};
  if (item.type === 'field') {
    const v = (app.fields || {})[item.key];
    if (v == null || String(v).trim() === '') return false;
    return item.validate ? !!item.validate(v) : true;
  }
  if (item.type === 'attest') return (app.attests || {})[item.key] === true;
  if (item.type === 'consent') return !!(app.consents || {})[item.key];
  if (item.type === 'verify') return !!(app.verified || {})[item.key];
  return false;
}

/** Build a compliance instance bound to an app's role catalogue. */
function createCompliance({ catalogue = {}, policyVersion = DEFAULT_POLICY_VERSION } = {}) {
  /** Full evaluation: per-item status + completeness flags + approvable. */
  function evaluate(role, app) {
    const items = (catalogue[role] || []).map(it => ({
      key: it.key, label: it.label, type: it.type, mandatory: it.mandatory, satisfied: itemSatisfied(it, app)
    }));
    const mand = items.filter(i => i.mandatory);
    const applicantComplete = mand.filter(i => i.type !== 'verify').every(i => i.satisfied);
    const adminComplete = mand.filter(i => i.type === 'verify').every(i => i.satisfied);
    return {
      items, applicantComplete, adminComplete, approvable: applicantComplete && adminComplete,
      missing: mand.filter(i => !i.satisfied).map(i => i.label),
      missingVerify: mand.filter(i => i.type === 'verify' && !i.satisfied).map(i => i.label)
    };
  }

  /** Build the stored application from a registration payload; throws 400 if incomplete. */
  function buildApplication(role, body) {
    const cat = catalogue[role] || [];
    const app = { fields: {}, attests: {}, consents: {}, verified: {}, policyVersion };
    for (const it of cat) {
      if (it.type === 'field') {
        const v = body[it.key];
        if (v != null && String(v).trim() !== '') app.fields[it.key] = String(v).slice(0, 120);
      } else if (it.type === 'attest') {
        if (body[it.key] === true || body[it.key] === 'true') app.attests[it.key] = true;
      } else if (it.type === 'consent') {
        if (body[it.key] === true || body[it.key] === 'true' || (body.consents && body.consents[it.key])) {
          app.consents[it.key] = { version: policyVersion, at: Date.now() };
        }
      }
    }
    const ev = evaluate(role, app);
    if (!ev.applicantComplete) {
      const e = new Error('Application incomplete — please provide/accept: ' + ev.missing.join(', '));
      e.status = 400; throw e;
    }
    return app;
  }

  /** Record (or clear) an admin verify item on an application. */
  function setVerify(role, app, key, value, byEmail) {
    const item = (catalogue[role] || []).find(i => i.key === key && i.type === 'verify');
    if (!item) { const e = new Error('Unknown verification item'); e.status = 400; throw e; }
    app.verified = app.verified || {};
    if (value) app.verified[key] = { at: Date.now(), by: byEmail };
    else delete app.verified[key];
    return app;
  }

  /** Public requirements descriptor for the registration UI (no validators leaked). */
  function requirements(role) {
    return (catalogue[role] || []).filter(i => i.type !== 'verify')
      .map(i => ({ key: i.key, label: i.label, type: i.type, mandatory: i.mandatory }));
  }

  return { CATALOGUE: catalogue, CURRENT_POLICY_VERSION: policyVersion, evaluate, buildApplication, setVerify, requirements, itemSatisfied };
}

module.exports = { createCompliance, itemSatisfied, yearsSince, abnOk };
