# The Cooperative Platform — One Co-op, Many Services

**Status:** north-star architecture (proposal) · **Date:** 28 June 2026
**Scope:** `coop-core` + CoopBite + Bunji Ride + future member services

---

## 1. Vision

There is **one cooperative**. People become **members of the cooperative** — not of a product —
and the cooperative offers a growing family of **member services**: CoopBite (fair food
delivery), Bunji Ride (inclusive ride-hailing), and more to come. One membership, one vote,
one shared treasury; many services on top.

This reframes everything built so far. `coop-core` started as *shared code to stop two apps
drifting*. Its destination is **the cooperative platform**: the shared layer that owns the
member-facing cooperative concerns (identity, membership, governance, treasury), with each
service plugging in for the things that are genuinely its own (orders vs rides vs …).

> **Principle.** *Cooperative-level concerns are shared and singular. Service-level concerns
> are autonomous and plural.* The dividing line is: "would a member experience this as part of
> *the co-op*, or as part of *a service*?"

---

## 2. Today → Target

| | Today | Target |
|---|---|---|
| Membership | Two separate user bases (`cb_users`, `br_users`) | **One member directory** for the whole co-op |
| Identity | Log in separately to each app | **One account, SSO** across all services |
| Governance | Per-app, divergent (CoopBite map-votes / all users; Bunji array-votes / drivers+riders) | **One cooperative governance** — one member, one vote, co-op-wide |
| Surplus | Per-app (CoopBite order fees; Bunji subscriptions) | **One cooperative treasury**; each service contributes; members decide distribution |
| Code | `coop-core` shared library (15 infra modules) | `coop-core` = **cooperative platform** (infra + membership + governance + treasury) |
| Services | Two standalone apps | Member services on a common platform |

The infrastructure extraction (Phases 1–3: secret, auth, store, settings, compliance, …) was the
prerequisite. This is the layer above it.

---

## 3. Domains

**Cooperative-level (shared, singular — owned by `coop-core` + a shared store):**
- **Member & identity** — one person = one member record; profile, contact, auth, MFA, consents,
  the member's *cooperative* status (member-owner in good standing).
- **Service enrolment & roles** — a member opts into services and holds *service-scoped roles*:
  e.g. `coopbite:customer`, `coopbite:restaurant`, `bunji:rider`, `bunji:driver`. One member can
  hold many.
- **Governance** — proposals + one-member-one-vote across the whole cooperative (some proposals
  co-op-wide, some scoped to a service but still co-op-democratic). Audited.
- **Treasury & surplus** — every service routes its co-op surplus into one treasury; the Safety
  Fund and member dividends are cooperative instruments, decided by governance.
- **Cooperative policy** — the constitution, consent/policy versions, the values badges
  ("100% Ethical", "Delivered fair").

**Service-level (autonomous, plural — owned by each app):**
- Domain operations & money engine — orders/menus/dispatch (CoopBite); rides/matching/fares (Bunji).
- Service-specific compliance catalogues, settings tunables, UI.
- The service's own operational data (orders, rides, ratings, payments-ledger).

---

## 4. Target architecture

```
                          ┌──────────────────────────────────────────┐
                          │              THE COOPERATIVE               │
                          │     members · governance · treasury        │
                          │                                            │
            ┌─────────────┤   coop-core  (the cooperative platform)    ├─────────────┐
            │             │  identity · membership · governance ·      │             │
            │             │  treasury · settings · store engine · …    │             │
            │             └──────────────────────┬─────────────────────┘             │
            │                                    │                                   │
            │                    ┌───────────────┴───────────────┐                   │
            ▼                    ▼                               ▼                   ▼
     ┌────────────┐      ┌────────────┐                  ┌────────────┐       ┌────────────┐
     │  CoopBite  │      │ Bunji Ride │                  │  Service…  │  ···  │  Service…  │
     │ food deliv.│      │ ride-hail  │                  │            │       │            │
     └────────────┘      └────────────┘                  └────────────┘       └────────────┘
       orders/menu         rides/match                      domain ops          domain ops
```

- **Shared cooperative store.** Member directory, governance and treasury live in **one place**
  (a `coop_*` schema / the cooperative DB), read/written through `coop-core`. Each service keeps
  its **operational** tables (`cb_orders`, `br_rides`, …). The store engine (Phase 3b) already
  supports this — a service composes the shared cooperative collections with its own.
- **One auth domain.** Bearer tokens (already `coop-core/secret` + `coop-core/auth`) are issued
  against the **member** identity and accepted by every service → SSO. A token carries the member
  id + their service roles.
- **Governance & treasury as platform modules.** `coop-core/governance` and `coop-core/treasury`
  operate on the shared cooperative store; services contribute surplus and surface the member's
  co-op standing, but the source of truth is singular.

---

## 5. How this resolves Phase 4 (governance)

The Phase-4 blocker was that the two apps' governance had diverged (vote model, membership,
surplus, lifecycle) and unifying them risked live data. **Under one cooperative, that divergence
shouldn't exist** — there is one governance, one member roll, one surplus. So governance is *not*
"shared code between two co-ops"; it's a **single cooperative service**. The migration folds both
apps' proposals into the one cooperative governance (CoopBite's single live `prop_1027` is
migrated as part of the membership/governance consolidation, not a risky per-app model swap).

---

## 6. Identity & membership model

```
Member {
  id, name, email, phone, passHash, mfa…, consents, status: member-owner|pending|…,
  coopStatus, joinedAt,
  services: { coopbite: { roles:[customer|restaurant|kitchen], status }, bunji: { roles:[rider|driver], status } }
}
```
- A person registers **once** with the cooperative. Using a new service is an **enrolment**
  (adds a `services.<svc>` entry + role), not a new account.
- Service-scoped authorisation: `requireRole` evolves to `requireServiceRole(member, 'bunji', 'driver')`.
- Compliance (Phase 3a) stays per-service (a driver's accreditation differs from a restaurant's
  food-safety), attached to the member's service enrolment.

---

## 7. Migration path (phased, safe — two live prod systems)

Each phase ships independently, behind the same verification bar used for the coop-core work
(full suites green + read-only prod smoke; never a risky live-data move without a reversible plan).

- **P0 — Platform framing (docs + member model).** ✅ DONE (`coop-core#v0.7.0`). This document;
  README reframed as the platform; `coop-core/cooperative` — the member **service-role** model
  (`hasServiceRole`/`requireServiceRole`/`enrol`) with a legacy flat-role fallback. Additive.
- **P1 — One member directory.** ▶ MECHANISM BUILT (`coop-core#v0.8.0`, gated). `coop-core/members`
  is the shared directory over a cooperative DB (`COOP_DATABASE_URL`), with `backfill()` that
  dedups each service's users by email and merges service enrolments (one person → one member
  across services) and returns an id-map for the cutover. **Falls back to the service's own store
  when no shared DB is set → zero prod effect today.** *Remaining (the cutover, needs the shared
  DB provisioned): run the backfill, set `user.memberId`, route auth through the directory, dual-read
  window, verify, flip. Runbook in `members.js`.*
- **P2 — Service enrolment & roles.** Move service roles onto the member record; `requireRole` →
  `requireServiceRole`. Cross-service login works.
- **P3 — Cooperative governance.** One `coop-core/governance` over the shared store; migrate both
  apps' proposals + member roll into it; retire per-app governance. *(resolves Phase 4)*
- **P4 — Cooperative treasury.** One treasury; each service posts its surplus contribution;
  Safety Fund + dividends become cooperative instruments under governance.
- **P5 — New-service template.** A starter that boots a new member service on the platform
  (shared identity/governance/treasury + its own domain) — proving "many services."

---

## 8. Open decisions (for the co-op to choose)

1. **One database or a shared "cooperative" service?** Simplest first step: a shared `coop_*`
   schema in one Neon project that both apps reach (members/governance/treasury), keeping
   operational tables per-service. A separate identity *service* (its own API) is the longer-term
   option if services proliferate.
2. **Auto-enrol or opt-in per service?** Recommended: one membership, explicit per-service
   enrolment (a Bunji rider isn't automatically a CoopBite restaurant).
3. **Proposal scope:** co-op-wide vs service-scoped-but-co-op-voted. Recommended: both, with a
   `scope` field; everyone votes on co-op-wide, affected members on service-scoped.
4. **Legal/finance:** one cooperative entity + treasury has real-world registration/accounting
   implications — out of scope for code, but the architecture should match the legal structure.

---

*Built on the coop-core extraction (`COOP_CORE_EXTRACTION_PLAN.md`). That plan made the
infrastructure shared; this plan makes the **cooperative** shared.*
