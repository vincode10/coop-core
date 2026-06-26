# coop-core

Shared, **zero-runtime-dependency** platform plumbing for cooperative apps
([CoopBite](https://github.com/vincode10/coopbite), Bunji Ride). Extracted so the common
backend is written once and can't drift between apps. See the extraction plan in CoopBite's
`docs/COOP_CORE_EXTRACTION_PLAN.md`.

**Consumed by:** CoopBite (`coop-core#v0.3.0`) and Bunji Ride (`coop-core#v0.3.0`).

## Install

Pinned by Git tag (public repo, no auth needed in CI/Vercel):

```
npm install github:vincode10/coop-core#v0.3.0
```

## Modules (11 — Phases 1, 2a, 2b)

| import | what |
|---|---|
| `coop-core/secret` | Rotating signing keys — `COOP_SECRET`/`COOPBITE_SECRET`/`BUNJI_SECRET` as a comma-separated list; first signs, all verify (zero-downtime rotation). |
| `coop-core/auth` | Share-safe scrypt `hashPassword`/`verifyPassword` + `requireRole` guard. |
| `coop-core/mfa` | **Encoding-agnostic** TOTP (RFC 6238) — `{encoding:'hex'\|'base32'}`; apps keep their stored-secret format. |
| `coop-core/errors` | Sentry-compatible exception reporter (gated on `SENTRY_DSN`; set `APP_VERSION` for release tagging). |
| `coop-core/notify` | Email/SMS transport (SendGrid/Twilio) + generic flows (passwordReset/approvalDecision/otpCode); brand via `NOTIFY_BRAND`. |
| `coop-core/oidc` | PKCE OIDC/SSO client (gated on `OIDC_CLIENT_ID/SECRET/ISSUER_URL`). |
| `coop-core/payments` | Stripe processor seam — `createIntent`/`capture`/`refund`/`request` (gated on `STRIPE_SECRET_KEY`). |
| `coop-core/bank` | Payout bank verification — Stripe Financial Connections (reuses the Stripe key). |
| `coop-core/identity` | ID proofing — Stripe Identity (reuses the Stripe key). |
| `coop-core/screening` | Provider-agnostic background-check REST seam (gated on `BACKGROUND_CHECK_URL`/`_API_KEY`). |
| `coop-core/registry` | ABN business-registry verification — ABR Lookup (gated on `ABR_GUID`) + offline checksum. |

Every module is **env-gated**: with no keys it is a logged no-op, so apps run unconfigured.
Domain-specific modules that depend on `mfa`/`payments`/`notify` (e.g. CoopBite's `orderReceipt`,
Bunji's ride `payments` ledger) keep a thin per-app wrapper.

## Roadmap (remaining)

- **Phase 3:** parameterised `store` (inject each app's schema), `settings`, `compliance`;
  then `metrics`, `storage`, `push` (depend on store), and shared `userFromReq`/login.
- **Phase 4:** `governance`.

## Develop

```
npm install
npm test         # node --test + syntax lint
npm run typecheck
```
