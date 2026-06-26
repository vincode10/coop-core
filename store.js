// store.js — the shared persistence engine behind both apps. Two backends behind one
// interface:
//   • file (default): atomic JSON file — local dev, tests, VPS with a disk
//   • pg   (auto when a Postgres URL is set): the production system of record. The document
//     lives in one JSONB row; every WRITE request runs in a transaction with
//     `SELECT … FOR UPDATE`, so concurrent writers serialise (ACID). Request state is carried
//     in AsyncLocalStorage. Photos live in a `<prefix>blob` table; append-only logs overflow
//     to `<prefix>archive`. Tests run the same path on embedded PGlite.
//
// `createStore(config)` returns the engine; each app injects its schema and keeps its own
// thin domain query helpers (queryOrders vs queryRides) over the exposed `pgRead`/`load`/
// `initPg`/`MODE` primitives — so the nuanced per-collection filters stay app-local.
//
// config: {
//   dataFile, pgUrl, replicaUrl, pglite,            // backend selection (app reads its env)
//   tablePrefix,                                     // 'cb_' | 'br_' → <prefix>doc/blob/archive
//   emptyDoc:    () => ({...}),                      // initial doc collections
//   split:       { key: { table, key, cols:[[name, item=>val, sqltype]] } },
//   indexes:     [[indexName, 'table (cols)'], ...],
//   logHotCap:   { adminLog: 500, ... },             // append-only log retention caps
//   slowMs?, logCapOverride?, usersKey='users'
// }
'use strict';
const fs = require('fs');
const path = require('path');
const { AsyncLocalStorage } = require('node:async_hooks');

function createStore(config) {
  const DATA_FILE = config.dataFile;
  const PG_URL = config.pgUrl;
  const PGLITE = !!config.pglite;
  const PG_REPLICA_URL = config.replicaUrl;
  const PREFIX = config.tablePrefix || 'cb_';
  const DOC = PREFIX + 'doc', BLOB = PREFIX + 'blob', ARCHIVE = PREFIX + 'archive';
  const empty = config.emptyDoc;
  const SPLIT = config.split || {};
  const INDEXES = config.indexes || [];
  const LOG_HOT_CAP = config.logHotCap || {};
  const USERS = config.usersKey || 'users';
  const USERS_TABLE = (SPLIT[USERS] && SPLIT[USERS].table) || (PREFIX + 'users');
  const SLOW_MS = Number(config.slowMs) || 200;
  const LOG_CAP_OVERRIDE = Number(config.logCapOverride) || 0;
  const logCap = kind => LOG_CAP_OVERRIDE || LOG_HOT_CAP[kind];

  const MODE = (PG_URL || PGLITE) ? 'pg' : 'file';

  let db = null;                     // module-global doc for file mode
  let pending = Promise.resolve();   // serialised pg autonomous writes

  // ---- per-request context (pg mode): {db, client, mutating, dirty} ----
  const als = new AsyncLocalStorage();
  const boot = {};
  const ctx = () => als.getStore() || boot;
  function runScoped(fn) { return als.run({}, fn); }

  // ---- query observability: per-instance counters + slow-query log ----
  const SLOW_LOG_MAX = 20;
  const metrics = { startedAt: Date.now(), queries: 0, slowQueries: 0, errors: 0,
    totalMs: 0, maxMs: 0, maxPerRequest: 0, slowLog: [] };
  const nowMs = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());
  function recordQuery(sql, ms, errored) {
    metrics.queries += 1;
    metrics.totalMs += ms;
    if (ms > metrics.maxMs) metrics.maxMs = ms;
    if (errored) metrics.errors += 1;
    const c = als.getStore();
    if (c) { c.q = (c.q || 0) + 1; if (c.q > metrics.maxPerRequest) metrics.maxPerRequest = c.q; }
    if (ms >= SLOW_MS) {
      metrics.slowQueries += 1;
      const entry = { sql: String(sql).replace(/\s+/g, ' ').trim().slice(0, 140), ms: Math.round(ms), at: Date.now() };
      metrics.slowLog.push(entry);
      if (metrics.slowLog.length > SLOW_LOG_MAX) metrics.slowLog.shift();
      console.warn(`[slow-query ${entry.ms}ms] ${entry.sql}`);
    }
  }
  function timed(run) {
    return async (t, p) => {
      const start = nowMs();
      let errored = false;
      try { return await run(t, p); }
      catch (e) { errored = true; throw e; }
      finally { recordQuery(t, nowMs() - start, errored); }
    };
  }
  async function queryArchive(kind, { limit = 50, before = 0 } = {}) {
    if (MODE !== 'pg') return [];
    await initPg();
    const n = Math.min(500, Math.max(1, Number(limit) || 50));
    const params = [kind];
    let sql = `SELECT seq, entry FROM ${ARCHIVE} WHERE kind = $1`;
    if (before) { params.push(before); sql += ` AND seq < $${params.length}`; }
    sql += ` ORDER BY seq DESC LIMIT ${n}`;
    return (await pgRead(sql, params)).rows.map(r => ({ seq: Number(r.seq), ...r.entry }));
  }
  function dbStats() {
    return {
      mode: MODE, replica: usingReplica,
      uptimeSec: Math.round((Date.now() - metrics.startedAt) / 1000),
      queries: metrics.queries, slowQueries: metrics.slowQueries, errors: metrics.errors,
      avgMs: metrics.queries ? Math.round((metrics.totalMs / metrics.queries) * 10) / 10 : 0,
      maxMs: Math.round(metrics.maxMs), maxQueriesPerRequest: metrics.maxPerRequest,
      slowThresholdMs: SLOW_MS, recentSlow: metrics.slowLog.slice().reverse()
    };
  }

  // ---- postgres driver (lazy; Neon Pool in prod, PGlite in tests) ----
  let pgReady = null, pgOne = null, pgReadOne = null, pgAcquire = null, usingReplica = false;
  function initPg() {
    if (pgReady) return pgReady;
    pgReady = (async () => {
      if (PGLITE) {
        const { PGlite } = require('@electric-sql/pglite');
        const lite = new PGlite();
        await lite.waitReady;
        pgOne = timed((t, p) => lite.query(t, p));
        pgReadOne = pgOne;
        pgAcquire = async () => ({ query: timed((t, p) => lite.query(t, p)), release() {} });
      } else {
        const { Pool, neonConfig } = require('@neondatabase/serverless');
        if (globalThis.WebSocket) neonConfig.webSocketConstructor = globalThis.WebSocket;
        const pool = new Pool({ connectionString: PG_URL });
        pgOne = timed((t, p) => pool.query(t, p));
        pgAcquire = async () => { const c = await pool.connect(); return { query: timed((t, p) => c.query(t, p)), release: () => c.release() }; };
        if (PG_REPLICA_URL) {
          const rpool = new Pool({ connectionString: PG_REPLICA_URL });
          pgReadOne = timed((t, p) => rpool.query(t, p));
          usingReplica = true;
        } else { pgReadOne = pgOne; }
      }
      await pgOne(`CREATE TABLE IF NOT EXISTS ${DOC} (id int PRIMARY KEY, data jsonb NOT NULL, version bigint NOT NULL DEFAULT 0)`);
      await pgOne(`CREATE TABLE IF NOT EXISTS ${BLOB} (id text PRIMARY KEY, data text NOT NULL)`);
      await pgOne(`CREATE TABLE IF NOT EXISTS ${ARCHIVE} (seq bigserial PRIMARY KEY, kind text NOT NULL, at bigint, entry jsonb NOT NULL)`);
      await pgOne(`CREATE INDEX IF NOT EXISTS ${PREFIX}archive_kind ON ${ARCHIVE} (kind, seq)`);
      for (const { table, cols } of Object.values(SPLIT)) {
        await pgOne(`CREATE TABLE IF NOT EXISTS ${table} (id text PRIMARY KEY, data jsonb NOT NULL, ${cols.map(c => `${c[0]} ${c[2]}`).join(', ')})`);
        // Additive schema evolution: a column added to a SPLIT later must also exist on a
        // table created by an earlier deploy (idempotent — no-op when already present).
        for (const c of cols) await pgOne(`ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS ${c[0]} ${c[2]}`);
      }
      for (const [name, target] of INDEXES) await pgOne(`CREATE INDEX IF NOT EXISTS ${name} ON ${target}`);
      await pgOne(`INSERT INTO ${DOC} (id, data) VALUES (1, $1) ON CONFLICT (id) DO NOTHING`, [JSON.stringify(empty())]);
    })();
    return pgReady;
  }

  async function pgPersist(query, doc, snaps) {
    const docPart = { ...doc };
    for (const { table, key, cols } of Object.values(SPLIT)) {
      const items = doc[key] || [];
      delete docPart[key];
      const snap = snaps && snaps[key];
      const colNames = cols.map(c => c[0]);
      const setClause = colNames.map((c, i) => `${c} = $${i + 3}`).join(', ');
      const allCols = ['id', 'data', ...colNames];
      const upsert = `INSERT INTO ${table} (${allCols.join(', ')}) VALUES (${allCols.map((_, i) => '$' + (i + 1)).join(', ')}) ON CONFLICT (id) DO UPDATE SET data = $2, ${setClause}`;
      const seen = new Set();
      for (const it of items) {
        seen.add(it.id);
        const ser = JSON.stringify(it);
        if (!snap || snap.get(it.id) !== ser) await query(upsert, [it.id, ser, ...cols.map(c => c[1](it))]);
      }
      if (snap) for (const id of snap.keys()) if (!seen.has(id)) await query(`DELETE FROM ${table} WHERE id = $1`, [id]);
    }
    for (const kind of Object.keys(LOG_HOT_CAP)) {
      const arr = docPart[kind];
      const cap = logCap(kind);
      if (Array.isArray(arr) && arr.length > cap) {
        const overflow = arr.slice(0, arr.length - cap);
        for (const e of overflow) await query(`INSERT INTO ${ARCHIVE} (kind, at, entry) VALUES ($1, $2, $3)`, [kind, e.at || e.changedAt || Date.now(), JSON.stringify(e)]);
        docPart[kind] = arr.slice(arr.length - cap);
      }
    }
    await query(`UPDATE ${DOC} SET data = $1, version = version + 1 WHERE id = 1`, [JSON.stringify(docPart)]);
  }

  // ---- lifecycle ----
  function loadFile() {
    try { db = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')); }
    catch { db = empty(); }
    return db;
  }
  async function ensureLoaded(mutating = false) {
    if (MODE === 'file') return db || loadFile();
    await initPg();
    const c = ctx();
    c.mutating = !!mutating; c.dirty = false; c.client = null;
    const q = mutating
      ? (c.client = await pgAcquire(), await c.client.query('BEGIN'), (t, p) => c.client.query(t, p))
      : (t, p) => pgOne(t, p);
    const r = await q(`SELECT data FROM ${DOC} WHERE id = 1` + (mutating ? ' FOR UPDATE' : ''));
    c.db = r.rows[0] ? r.rows[0].data : empty();
    c.snaps = {};
    for (const { table, key } of Object.values(SPLIT)) {
      const items = (await q(`SELECT data FROM ${table}`)).rows.map(row => row.data);
      c.snaps[key] = new Map(items.map(it => [it.id, JSON.stringify(it)]));
      const legacy = Array.isArray(c.db[key]) ? c.db[key] : [];
      c.db[key] = mutating ? items.concat(legacy) : legacy;
    }
    return c.db;
  }
  function load() {
    if (MODE === 'pg') { const c = ctx(); if (!c.db) c.db = empty(); return c.db; }
    if (!db) { if (MODE === 'file') loadFile(); else db = empty(); }
    return db;
  }
  function save() {
    if (MODE === 'file') {
      fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });
      const tmp = DATA_FILE + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(db, null, 1));
      fs.renameSync(tmp, DATA_FILE);
      return;
    }
    const c = ctx();
    if (c.client) { c.dirty = true; return; }
    const snapshot = JSON.parse(JSON.stringify(c.db || empty()));
    pending = pending.then(() => initPg())
      .then(() => pgPersist((t, p) => pgOne(t, p), snapshot, null))
      .catch(e => console.error('PG save failed:', e.message));
  }
  async function flush() {
    await pending;
    if (MODE !== 'pg') return;
    const c = ctx();
    if (c.client) {
      try {
        if (c.dirty) await pgPersist((t, p) => c.client.query(t, p), c.db, c.snaps);
        await c.client.query('COMMIT');
      } catch (e) { try { await c.client.query('ROLLBACK'); } catch {} throw e; }
      finally { c.client.release(); c.client = null; c.dirty = false; }
    }
  }
  async function abort() {
    if (MODE !== 'pg') return;
    const c = ctx();
    if (c.client) {
      try { await c.client.query('ROLLBACK'); } catch {}
      finally { c.client.release(); c.client = null; c.dirty = false; }
    }
  }

  // ---- photo blobs ----
  async function putBlob(id, dataUrl) {
    if (MODE === 'file') { load(); db.blobs = db.blobs || {}; db.blobs[id] = dataUrl; save(); return; }
    await initPg(); await pgOne(`INSERT INTO ${BLOB} (id, data) VALUES ($1, $2) ON CONFLICT (id) DO UPDATE SET data = $2`, [id, dataUrl]);
  }
  async function getBlob(id) {
    if (MODE === 'file') { load(); return (db.blobs || {})[id] || null; }
    await initPg(); const r = await pgOne(`SELECT data FROM ${BLOB} WHERE id = $1`, [id]); return r.rows[0] ? r.rows[0].data : null;
  }

  // ---- primitive read path (app domain query helpers build on this) ----
  function pgRead(sql, params) { const c = ctx(); return c.client ? c.client.query(sql, params) : pgReadOne(sql, params); }

  // ---- generic user lookups (identical across apps) ----
  async function getUser(id) {
    const local = (load()[USERS] || []).find(u => u.id === id);
    if (local || MODE !== 'pg') return local || null;
    const r = await (await initPg(), pgRead(`SELECT data FROM ${USERS_TABLE} WHERE id = $1`, [id]));
    return r.rows[0] ? r.rows[0].data : null;
  }
  async function getUserByEmail(email) {
    const key = String(email || '').toLowerCase();
    const local = (load()[USERS] || []).find(u => (u.email || '').toLowerCase() === key);
    if (local || MODE !== 'pg') return local || null;
    const r = await (await initPg(), pgRead(`SELECT data FROM ${USERS_TABLE} WHERE email = $1`, [key]));
    return r.rows[0] ? r.rows[0].data : null;
  }
  async function countUsers() {
    if (MODE !== 'pg') return (load()[USERS] || []).length;
    await initPg();
    return (await pgRead(`SELECT count(*)::int AS n FROM ${USERS_TABLE}`, [])).rows[0].n;
  }

  function nextId(prefix) { const d = load(); d.seq += 1; return `${prefix}_${d.seq}`; }
  function reset() {
    if (MODE === 'pg') { const c = ctx(); c.db = empty(); save(); return c.db; }
    db = empty(); save(); return db;
  }
  async function __pgQuery(sql, params) { if (MODE !== 'pg') return null; await initPg(); return pgOne(sql, params); }

  return {
    MODE, DATA_FILE, runScoped, ensureLoaded, load, save, flush, abort,
    putBlob, getBlob, queryArchive, dbStats, nextId, reset, __pgQuery,
    initPg, pgRead, getUser, getUserByEmail, countUsers
  };
}

module.exports = { createStore };
