# Pending / Resume Point — the Cooperative program

**Paused:** 28 June 2026. Single source of truth for everything outstanding across
`coop-core` + CoopBite + Bunji Ride. Newest/most-immediate first.

---

## ▶ IMMEDIATE RESUME POINT — Platform P1 cutover (shared member directory)

**Where we are:** the directory *mechanism* is built and tested (`coop-core/members`, v0.8.0,
gated). You created the Neon project **`the-cooperative`** / database **`cooperative`** (Sydney).
The cutover is blocked only on the connection string being exposed to both apps.

**You — finish provisioning (steps 2–3 of the earlier instructions):**
1. Neon → the-cooperative → **Connection Details** → database `cooperative` → **Pooled connection ON**
   (host contains `-pooler`) → copy the string.
2. Add it as env var **`COOP_DATABASE_URL`** to **both** Vercel projects (`coopbite`, `bunjiride`),
   scope Production+Preview+Development. *(Or paste the string and I'll `vercel env add` it.)*

**Then me (P1 cutover — all staged & reversible; unset the env → instant fallback to today):**
1. `vercel env pull` to read `COOP_DATABASE_URL`; create the `coop_members` table (auto on first connect).
2. Run the **backfill** (`members.backfill`) for each app: read users → dedup/merge by email into the
   directory; persist the returned `idMap` → set `user.memberId` on each service user. Verify counts.
3. **Dual-read window:** wire each app's `auth` to resolve the member via `members.getByEmail/getById`
   (gated: falls back to local store when the env is unset); service handlers still read their local
   user by `memberId`. Deploy → read-only prod smoke (login/me on both apps).
4. Cutover: registrations create/enrol a member + a thin service user. SSO works automatically
   (same `coop-core/secret` token domain).

Runbook also in `members.js` (bottom) and `COOPERATIVE_PLATFORM.md` §7.

---

## Cooperative platform — remaining phases (`COOPERATIVE_PLATFORM.md`)

| Phase | What | Needs | Status |
|---|---|---|---|
| P0 | Platform framing + `coop-core/cooperative` member-role model | — | ✅ done (v0.7.0) |
| P1 | Shared member directory `coop-core/members` | mechanism ✅ (v0.8.0); **cutover needs `COOP_DATABASE_URL`** | ▶ in progress |
| P2 | Service enrolment & roles — adopt `requireServiceRole`; `member.services.{svc}.roles` | infra-free | ⏳ pending |
| P3 | **Cooperative governance** (one member-one-vote, co-op-wide) — *resolves old Phase 4* | after P1 | ⏳ pending |
| P4 | **Cooperative treasury** — pooled surplus, dividends, Safety Fund as co-op instruments | after P1 | ⏳ pending |
| P5 | New-service template (boot a service on the platform) | after P1–P4 | ⏳ pending |

**Note:** P2 (service-role model adoption in each app's authorization) does **not** need the shared
DB and could be done now if you'd rather make progress while the directory is being provisioned.

---

## coop-core extraction — done; two intentional non-items

The shared-infra extraction (Phases 1–3) is **complete and live on both apps** — 16 modules at
`coop-core#v0.8.0`. Deliberately **not** extracted (documented decisions, not omissions):
- **`metrics` / `storage` / `push`** — CoopBite-only (Bunji has none) → no drift to prevent. Extract
  only if/when Bunji needs them.
- **Per-app `login` / `publicUser` / MFA flow** — genuinely differ (CoopBite 2-step `mfaPending`
  token vs Bunji inline code) → stay per-app by design.
- **Old "Phase 4 governance"** — superseded by platform **P3** (cooperative governance).

---

## Built but gated — activate by setting keys (no code work; per-app Vercel env)

All wired, no-op until configured. See each app's `docs/STATUS.md` / `API.md`.

| Capability | Module | Env to set |
|---|---|---|
| Real payments | `coop-core/payments` (+bank/identity) | `STRIPE_SECRET_KEY` (+`PAYMENTS_CURRENCY`) |
| Email/SMS | `coop-core/notify` | `SENDGRID_API_KEY`+`NOTIFY_FROM_EMAIL`; `TWILIO_ACCOUNT_SID`+`_AUTH_TOKEN`+`_FROM` |
| Error tracking | `coop-core/errors` | `SENTRY_DSN` (+`APP_VERSION`) |
| Metrics sink | CoopBite `server/metrics.js` | `STATSD_HOST` (+`STATSD_PORT`/`STATSD_PREFIX`) |
| Background checks | `coop-core/screening` | `BACKGROUND_CHECK_URL`+`_API_KEY` |
| ABN registry | `coop-core/registry` | `ABR_GUID` |
| Read replica | `coop-core/store` | `POSTGRES_REPLICA_URL` |
| Key rotation | `coop-core/secret` | `COOPBITE_SECRET`/`BUNJI_SECRET` = `new,old` (comma-sep) |

---

## Infra / ops (not application code)

- **PITR drills** — a Neon plan setting + an operational runbook. Nothing to build.
- **Dedicated cooperative DB region** — confirm `the-cooperative` is **ap-southeast-2 (Sydney)** for
  member-PII residency (AU pilot).

---

## Cross-portfolio (shared with Bunji — larger, deferred)

- **Native strategy** — CoopBite uses Capacitor, Bunji uses Expo/React-Native. Recommendation
  (architecture deck): standardise on Expo + `react-native-web` when consolidating. Not started.
- **Shared design system** — both hand-roll `shared.css`/`shared.js`; a common component kit would
  keep UX/a11y consistent (the v2.19 Material-3 theme is a natural seed). Not started.

---

## State snapshot (28 Jun 2026)

- **coop-core** `v0.8.0` · master · 63 tests · public repo.
- **CoopBite** `v2.34.0` live at coopbite.vercel.app · CI green · 234 tests · git-auto-deploys.
- **Bunji Ride** live at bunjiride.vercel.app · 73 tests · **manual deploy** (`vercel deploy --prod
  --yes --scope vincode10s-projects`; *not* git-auto-deploy).
- Marketing site live at coopbite-site.vercel.app (+ `/posts`).
- All three repos clean (0 uncommitted).
