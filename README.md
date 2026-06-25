# coop-core

Shared, **zero-runtime-dependency** platform plumbing for cooperative apps
([CoopBite](https://github.com/vincode10/coopbite), Bunji Ride). Extracted so the common
backend is written once and can't drift between apps. See the extraction plan in CoopBite's
`docs/COOP_CORE_EXTRACTION_PLAN.md`.

## Install

Pinned by Git tag (public repo, no auth needed in CI/Vercel):

```
npm install github:vincode10/coop-core#v0.1.0
```

## Modules (Phase 1 — dependency-clean leaf utilities)

| import | what |
|---|---|
| `coop-core/secret` | Rotating signing keys — `COOPBITE_SECRET` as a comma-separated list; first signs, all verify. |
| `coop-core/errors` | Sentry-compatible exception reporter (gated on `SENTRY_DSN`; set `APP_VERSION` for release tagging). |
| `coop-core/oidc` | PKCE OIDC/SSO client (gated on `OIDC_CLIENT_ID/SECRET/ISSUER_URL`). |
| `coop-core/screening` | Provider-agnostic background-check REST seam (gated on `BACKGROUND_CHECK_URL`/`_API_KEY`). |
| `coop-core/registry` | ABN business-registry verification — ABR Lookup (gated on `ABR_GUID`) + offline checksum. |

Every module is **env-gated**: with no keys it is a logged no-op, so apps run unconfigured.

## Roadmap

- **Phase 2:** `payments`, then `bank` + `identity` (depend on payments); `notify`, `mfa`, `auth`.
- **Phase 3:** parameterised `store` (inject schema), `settings`, `compliance`; then `metrics`,
  `storage`, `push` (depend on store).
- **Phase 4:** `governance`.

## Develop

```
npm install
npm test         # node --test + syntax lint
npm run typecheck
```
