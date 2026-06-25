// errors.js — exception reporting (STATUS §F item 4). Provider-agnostic, zero-dependency:
// uncaught/5xx errors are forwarded to a Sentry-compatible ingest endpoint (the store API,
// which DogStatsD/GlitchTip/Sentry all accept) over `fetch`. It is GATED on `SENTRY_DSN` —
// with no DSN set, capture() is a logged no-op, so the pipeline is safe to run unconfigured
// (the pilot). Nothing here ever throws; reporting is best-effort and fire-and-forget.
//
// To enable: set SENTRY_DSN (e.g. https://<key>@<host>/<projectId>). Optional:
//   SENTRY_ENVIRONMENT (default NODE_ENV || 'production'), SENTRY_RELEASE (default pkg version).
'use strict';
const crypto = require('node:crypto');
// Release defaults to the consuming app's version (set APP_VERSION) or coop-core's own.
const VERSION = process.env.SENTRY_RELEASE || process.env.APP_VERSION || require('./package.json').version;

const dsn = () => process.env.SENTRY_DSN || '';
const configured = () => !!dsn();

/** Parse a Sentry DSN into its ingest endpoint + public key. Returns null if invalid. */
function parseDsn(raw) {
  try {
    const u = new URL(raw);
    const segs = u.pathname.split('/').filter(Boolean);
    const projectId = segs.pop();
    if (!projectId || !u.username) return null;
    const prefix = segs.length ? '/' + segs.join('/') : '';
    return {
      publicKey: u.username,
      endpoint: `${u.protocol}//${u.host}${prefix}/api/${projectId}/store/`
    };
  } catch { return null; }
}

/** Turn an Error stack into Sentry frames (oldest-first), best-effort. */
function framesFromStack(stack) {
  const frames = [];
  for (const line of String(stack || '').split('\n').slice(1)) {
    // "    at fn (/abs/file.js:12:34)"  or  "    at /abs/file.js:12:34"
    const m = line.match(/at (?:(.+?) \()?(.+?):(\d+):(\d+)\)?$/);
    if (!m) continue;
    frames.push({ function: m[1] || '<anonymous>', filename: m[2], lineno: +m[3], colno: +m[4] });
  }
  return frames.reverse();
}

/** Build the Sentry event payload for an error + optional request/context. */
function buildEvent(err, ctx = {}) {
  const e = err instanceof Error ? err : new Error(typeof err === 'string' ? err : JSON.stringify(err));
  const event = {
    event_id: crypto.randomBytes(16).toString('hex'),
    timestamp: new Date().toISOString(),
    platform: 'node',
    level: ctx.level || 'error',
    logger: 'coopbite',
    server_name: process.env.VERCEL_REGION || undefined,
    release: process.env.SENTRY_RELEASE || VERSION,
    environment: process.env.SENTRY_ENVIRONMENT || process.env.NODE_ENV || 'production',
    transaction: ctx.transaction || undefined,
    exception: { values: [{ type: e.name || 'Error', value: e.message, stacktrace: { frames: framesFromStack(e.stack) } }] },
    tags: { component: ctx.component || 'server', ...(ctx.status ? { status: String(ctx.status) } : {}), ...(ctx.tags || {}) },
    extra: ctx.extra || undefined
  };
  if (ctx.req) event.request = { method: ctx.req.method, url: ctx.transaction || ctx.req.url };
  return event;
}

// tiny in-memory throttle so an error storm can't hammer the ingest endpoint
let _win = { at: 0, n: 0 };
const MAX_PER_MIN = 30;
function throttled() {
  const now = Date.now();
  if (now - _win.at > 60000) _win = { at: now, n: 0 };
  return ++_win.n > MAX_PER_MIN;
}

/** Report an error. Never throws. Returns {sent} / {skipped}. */
async function capture(err, ctx = {}) {
  if (!configured()) {
    console.error('[errors:skip]', (err && err.message) || err, ctx.transaction || '');
    return { sent: false, skipped: true };
  }
  if (throttled()) return { sent: false, skipped: true, reason: 'throttled' };
  try {
    const d = parseDsn(dsn());
    if (!d) return { sent: false, error: 'bad-dsn' };
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), 3000);
    const res = await fetch(d.endpoint, {
      method: 'POST', signal: ac.signal,
      headers: {
        'Content-Type': 'application/json',
        'X-Sentry-Auth': `Sentry sentry_version=7, sentry_client=coopbite/${VERSION}, sentry_key=${d.publicKey}`
      },
      body: JSON.stringify(buildEvent(err, ctx))
    }).finally(() => clearTimeout(t));
    return { sent: res.ok, status: res.status };
  } catch (e) { console.error('[errors] report failed:', e.message); return { sent: false, error: e.message }; }
}

let _installed = false;
/** Attach process-level handlers so unhandled failures are reported too. Idempotent. */
function install() {
  if (_installed) return;
  _installed = true;
  process.on('unhandledRejection', reason => { capture(reason, { component: 'unhandledRejection' }); });
  process.on('uncaughtException', err => { capture(err, { component: 'uncaughtException' }); });
}

module.exports = { configured, parseDsn, framesFromStack, buildEvent, capture, install };
