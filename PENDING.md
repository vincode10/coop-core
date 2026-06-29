# Pending / Resume Point — the Cooperative program

**Paused:** 28 June 2026. Single source of truth for everything outstanding across
`coop-core` + CoopBite + Bunji Ride. Newest/most-immediate first.

---

## ▶ IMMEDIATE RESUME POINT — Platform P4 (cooperative treasury)

**P3 COMPLETE (29 Jun 2026).** Shared cooperative governance live on both apps.
- `coop-core/governance.js` v0.10.0 — `gov_` prefixed tables, cooperative memberId vote keys, yes/no/abstain, scope, kinds; 79 tests green.
- `store.js` read-mode split-table fix: `ensureLoaded(false)` now merges split rows into `c.db` (was using empty legacy doc only).
- `server/coopgov.js` singleton in each app; proposal/vote/close routes delegate to shared store when `COOP_DATABASE_URL` set; falls back to local read-only view.
- Migration scripts at `scripts/migrate-governance.js` in both apps (idempotent, translates vote keys).
- **Prod smoke verified:** proposal `prop_ccc0656ed97d` created in CoopBite, instantly visible in Bunji; cross-app votes tallied: `{ yes: 2, no: 0, abstain: 0 }`.
- **Next ops:** run migration scripts to backfill existing per-app proposals into shared store.

---

## P1 details (done)

**Shared directory provisioned + backfilled + register-sync.**
- Neon project **`the-cooperative`** (Sydney) created; its `neondb` is the cooperative DB
  (the `cooperative` db name didn't get created — using the project default, which is fine since
  the directory tables are `coop_`-prefixed). `COOP_DATABASE_URL` set in **both** Vercel projects
  (Production + Development; Preview pending — non-critical).
- `coop-core/members` v0.8.1 (`mbr_` member ids — service user-ids like `usr_1008` collide across
  apps, so members get fresh ids; `idMap` links them).
- **Backfill ran: 15 distinct members** (8 CoopBite + 7 Bunji) now in `coop_members`. No cross-service
  merges (seed emails don't overlap `@coopbite.org`/`@bunjiride.au` — merge logic is tested though).
- Apps **not yet wired** — coopbite stays on `coop-core#v0.6.0` (deployed v2.34.0), directory unused.

**NEXT — the cutover (changes the auth hot path; do carefully, RESILIENT):**
1. Persist the `idMap` → set `user.memberId` on each service user (additive write to cb_users/br_users;
   re-run backfill is idempotent for emailed users — but **no-email users duplicate on re-run**, so
   add a phone/id secondary key OR snapshot the idMap once).
2. Wire each app's `auth` to resolve the member via `members.getByEmail/getById` **with fallback-to-local
   on any directory error** (don't make login hard-depend on a 3rd DB's availability). Gated on
   `COOP_DATABASE_URL`. Deploy → read-only prod smoke (login/me both apps). SSO falls out (shared token).
3. Registrations create/enrol a member + a thin service user.

**Activation note:** to run another backfill / the cutover, re-pull both apps' DB URLs
(`vercel env pull`), and `COOP_DATABASE_URL` from either project. Runbook also in `members.js`.

---

## Cooperative platform — remaining phases (`COOPERATIVE_PLATFORM.md`)

| Phase | What | Needs | Status |
|---|---|---|---|
| P0 | Platform framing + `coop-core/cooperative` member-role model | — | ✅ done (v0.7.0) |
| P1 | Shared member directory `coop-core/members` — provisioned, backfilled (15 members), **register-sync live on both apps** | done (v0.8.2; CoopBite v2.35.0) | ✅ done |
| P2 | **Auth + SSO via the directory** — member-scoped tokens, `userFromReq` cross-service w/ fallback-to-local, `requireRoleFor(service)`, persist `user.memberId`, dedup-safe re-backfill | done (coop-core v0.9.1; both apps deployed; SSO verified in prod) | ✅ done |
| P3 | **Cooperative governance** (one member-one-vote, co-op-wide) — *resolves old Phase 4* | after P2 | ✅ done (v0.10.0; both apps deployed; smoke verified) |
| P4 | **Cooperative treasury** — pooled surplus, dividends, Safety Fund as co-op instruments | after P2 | ⏳ pending |
| P5 | New-service template (boot a service on the platform) | after P1–P4 | ⏳ pending |

**P2 is the big, risky one** — a multi-route auth refactor across two live apps. Bake in the
fallback-to-local so login can never hard-depend on the cooperative DB. Also fix the no-email
backfill dedup (phone/source key) before any re-backfill.

---

## coop-core extraction — done; two intentional non-items

The shared-infra extraction (Phases 1–3) is **complete and live on both apps** — 17 modules at
`coop-core#v0.8.2` (incl. the platform modules `cooperative` + `members`). Deliberately **not**
extracted (documented decisions, not omissions):
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

## State snapshot (29 Jun 2026)

- **coop-core** `v0.10.0` · master · 79 tests · public repo · 18 modules · P3 governance shipped.
- **CoopBite** `v2.37.0` live at coopbite.vercel.app · 234 tests · git-auto-deploys · on `coop-core#v0.10.0` · P3 deployed.
- **Bunji Ride** `v0.3.0` live at bunjiride.vercel.app · 73 tests · on `coop-core#v0.10.0` · P3 deployed · **manual deploy**
  (`vercel deploy --prod --yes --scope vincode10s-projects`; *not* git-auto-deploy).
- **The Cooperative** Neon DB (Sydney) live · `coop_members` = 15 members · `COOP_DATABASE_URL`
  set in both Vercel projects (Production + Development).
- Marketing site live at coopbite-site.vercel.app (+ `/posts`).
- All three repos clean (0 tracked changes). *(Note: an unrelated Obsidian vault sits untracked at
  `~/coopbite/coopbite/` — user's, not part of the repo.)*
