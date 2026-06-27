// settings.js — board-level platform configuration engine: persistent, versioned, audited.
// Every tunable lives here so the co-op board can change it from the admin console without a
// deploy, and every change is recorded with who/when/what for governance. The engine is
// identical across apps; inject the app's store + defaults + limits via createSettings().
'use strict';

function createSettings({ store, defaults, limits }) {
  const DEFAULTS = Object.freeze({ ...defaults });
  const LIMITS = Object.freeze({ ...limits });

  /** Effective settings: persisted values over board defaults. */
  function current() {
    const db = store.load();
    return { ...DEFAULTS, ...(db.settings || {}) };
  }

  /** Apply a validated partial update and record it in the audit history. */
  function update(patch, byEmail) {
    const db = store.load();
    const clean = {};
    for (const key of Object.keys(LIMITS)) {
      if (patch[key] === undefined) continue;
      const v = Math.round(patch[key]);
      const [lo, hi] = LIMITS[key];
      if (!Number.isFinite(v) || v < lo || v > hi) {
        const e = new Error(`${key} must be between ${lo} and ${hi}`); e.status = 400; throw e;
      }
      clean[key] = v;
    }
    if (!Object.keys(clean).length) { const e = new Error('No valid settings provided'); e.status = 400; throw e; }
    const before = current();
    db.settings = { ...before, ...clean };
    db.settingsHistory = db.settingsHistory || [];
    db.settingsHistory.push({
      at: Date.now(), by: byEmail, changes: clean,
      previous: Object.fromEntries(Object.keys(clean).map(k => [k, before[k]]))
    });
    store.save();
    return current();
  }

  function history() {
    return (store.load().settingsHistory || []).slice(-50).reverse();
  }

  return { DEFAULTS, LIMITS, current, update, history };
}

module.exports = { createSettings };
