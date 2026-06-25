// registry.js — ABN/ACN business-registry verification (PRD ONB-23; STATUS §C.3). Looks an
// ABN up against the Australian Business Register's free ABN Lookup JSON web service. An
// "Active" result satisfies the "ABN verified against the register" compliance item for
// restaurant partners. GATED on `ABR_GUID` (free to register at abr.business.gov.au) — with
// no GUID, lookups are mock and decided purely by the local 11-digit checksum, so the pilot
// still validates ABN format. The checksum runs first either way (cheap, offline).
'use strict';

const configured = () => !!process.env.ABR_GUID;
const clean = abn => String(abn || '').replace(/[^0-9]/g, '');

/** ATO ABN checksum: subtract 1 from the first digit, weight, sum, mod 89 === 0. */
function validChecksum(abn) {
  const d = clean(abn);
  if (d.length !== 11) return false;
  const w = [10, 1, 3, 5, 7, 9, 11, 13, 15, 17, 19];
  const digits = d.split('').map(Number);
  digits[0] -= 1;
  return digits.reduce((s, n, i) => s + n * w[i], 0) % 89 === 0;
}

/**
 * Look up an ABN. Returns { abn, valid, status, entityName, gstRegistered, entityType,
 * businessNames, mock? }. Never throws — a registry/network failure resolves to
 * { valid:false, status:'error' }.
 */
async function lookup(abn) {
  const d = clean(abn);
  const checksumOk = validChecksum(d);
  if (!configured()) {
    return { abn: d, valid: checksumOk, status: checksumOk ? 'Active' : 'Invalid',
      entityName: checksumOk ? 'Demo Trading Pty Ltd (mock)' : null, gstRegistered: checksumOk, mock: true };
  }
  if (!checksumOk) return { abn: d, valid: false, status: 'Invalid', mock: false };
  try {
    const url = `https://abr.business.gov.au/json/AbnDetails.aspx?abn=${d}&guid=${encodeURIComponent(process.env.ABR_GUID)}`;
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), 5000);
    const text = await fetch(url, { signal: ac.signal }).then(r => r.text()).finally(() => clearTimeout(t));
    const m = text.match(/\{[\s\S]*\}/);            // strip the JSONP callback(...) wrapper
    const j = m ? JSON.parse(m[0]) : {};
    if (j.Message) return { abn: d, valid: false, status: 'NotFound', message: j.Message };
    const active = j.AbnStatus === 'Active';
    return {
      abn: d, valid: active, status: j.AbnStatus || 'Unknown',
      entityName: j.EntityName || null, entityType: j.EntityTypeName || null,
      gstRegistered: !!j.Gst, businessNames: j.BusinessName || []
    };
  } catch (e) { return { abn: d, valid: false, status: 'error', message: e.message }; }
}

module.exports = { configured, clean, validChecksum, lookup };
