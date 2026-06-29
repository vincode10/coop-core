// store.test.js — the shared persistence engine (createStore). Exercises the pg path on
// embedded PGlite (write transaction → flush → indexed reads, split-table materialization,
// archive retention, blobs, user lookups) and the file backend.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const { createStore } = require('../store');

const schema = (over = {}) => ({
  tablePrefix: 'tc_',
  emptyDoc: () => ({ seq: 1000, users: [], items: [], adminLog: [], blobs: {} }),
  split: {
    users: { table: 'tc_users', key: 'users', cols: [
      ['email', u => (u.email || '').toLowerCase() || null, 'text'],
      ['role', u => u.role || null, 'text'] ] },
    items: { table: 'tc_items', key: 'items', cols: [
      ['owner', i => i.owner || null, 'text'] ] }
  },
  indexes: [['tc_users_email', 'tc_users (email)'], ['tc_items_owner', 'tc_items (owner)']],
  logHotCap: { adminLog: 3 },
  ...over
});

// ---------------- pg path (PGlite) ----------------
test('pg: write tx → flush persists doc + split tables; indexed reads work', async () => {
  const s = createStore(schema({ pglite: true }));
  assert.equal(s.MODE, 'pg');

  await s.runScoped(async () => {
    await s.ensureLoaded(true);                 // write request → opens a transaction
    const d = s.load();
    d.users.push({ id: 'u1', email: 'A@B.com', role: 'admin' });
    d.items.push({ id: 'i1', owner: 'u1' });
    d.adminLog.push({ at: 1, m: 'created' });
    s.save();
    await s.flush();                            // commit
  });

  // user lookups (materialized-first then indexed; here outside scope → indexed)
  assert.equal((await s.getUser('u1')).email, 'A@B.com');
  assert.equal((await s.getUserByEmail('a@b.com')).id, 'u1');
  assert.equal(await s.countUsers(), 1);

  // split items are now materialized in read mode too (ensureLoaded always merges split rows)
  await s.runScoped(async () => {
    await s.ensureLoaded(false);
    assert.equal(s.load().items.length, 1, 'read mode materializes split arrays');
    assert.equal(s.load().items[0].id, 'i1');
    const r = await s.pgRead('SELECT data FROM tc_items WHERE owner = $1', ['u1']);
    assert.equal(r.rows[0].data.id, 'i1');
  });
});

test('pg: a write request materializes split arrays so handlers can mutate them', async () => {
  const s = createStore(schema({ pglite: true }));
  await s.runScoped(async () => { await s.ensureLoaded(true); s.load().items.push({ id: 'i1', owner: 'u1' }); s.save(); await s.flush(); });
  await s.runScoped(async () => {
    await s.ensureLoaded(true);                 // mutating → items materialized from the table
    assert.equal(s.load().items.length, 1);
    s.load().items.push({ id: 'i2', owner: 'u2' });
    s.save(); await s.flush();
  });
  assert.equal((await createStoreReusing(s).pgReadCount('tc_items')), 2);
});

test('pg: archive retention caps hot logs and preserves overflow', async () => {
  const s = createStore(schema({ pglite: true }));
  await s.runScoped(async () => {
    await s.ensureLoaded(true);
    const d = s.load();
    for (let i = 1; i <= 5; i++) d.adminLog.push({ at: i, m: 'e' + i });  // cap 3 → 2 archived
    s.save(); await s.flush();
  });
  const archived = await s.queryArchive('adminLog');
  assert.equal(archived.length, 2);
  assert.deepEqual(archived.map(a => a.m).sort(), ['e1', 'e2']);
});

test('pg: blobs round-trip', async () => {
  const s = createStore(schema({ pglite: true }));
  await s.putBlob('b1', 'data:image/png;base64,AAA');
  assert.equal(await s.getBlob('b1'), 'data:image/png;base64,AAA');
  assert.equal(await s.getBlob('missing'), null);
});

// ---------------- file path ----------------
test('file: load/save round-trip + user helpers', async () => {
  const f = '/tmp/coop-core-store-test.json';
  fs.rmSync(f, { force: true });
  const s = createStore(schema({ dataFile: f }));
  assert.equal(s.MODE, 'file');
  s.load().users.push({ id: 'u1', email: 'x@y.com', role: 'rider', phone: '+61400000009', memberId: 'mbr_9' });
  s.save();
  assert.equal((await s.getUser('u1')).email, 'x@y.com');
  assert.equal((await s.getUserByEmail('X@Y.com')).id, 'u1');
  assert.equal((await s.getUserByPhone('+61400000009')).id, 'u1');   // P2: phone lookup
  assert.equal((await s.getUserByMemberId('mbr_9')).id, 'u1');       // P2: cross-service link
  assert.equal(await s.getUserByMemberId('mbr_absent'), null);
  assert.equal(await s.countUsers(), 1);
  assert.match(s.nextId('ride'), /^ride_\d+$/);
});

// helper: count rows in a table via a fresh read scope on the same store
function createStoreReusing(s) {
  return { pgReadCount: async (table) => {
    let n;
    await s.runScoped(async () => { await s.ensureLoaded(false); n = (await s.pgRead(`SELECT count(*)::int AS c FROM ${table}`, [])).rows[0].c; });
    return n;
  } };
}
