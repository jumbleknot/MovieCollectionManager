---
type: Gotcha
title: Role enforcement is a layer, not a per-handler check — at every tier
description: Cross-cutting pattern repeated across the frontend, BFF, and mc-service — mc-user/mc-admin role checks are enforced by a centralized middleware/layer at each tier, with per-handler role reads and client-side role checks treated as advisory only, never the actual guard.
resource: CLAUDE.md
tags: [auth, rbac, cross-cutting, keycloak]
timestamp: 2026-07-28T02:22:54.286Z
---

# Role enforcement is a layer, not a per-handler check — at every tier

The same design rule repeats independently at three tiers of
[the auth chain](/openwiki/invariants/auth-chain.md): application-role membership (`mc-user` /
`mc-admin`) is enforced by one centralized piece of middleware per tier, and anything that reads
roles inside an individual handler or component is there only to *display or branch on* an
already-enforced decision — never to be the actual gate.

- **mc-service**: `KeycloakAuthLayer<Role>` (a Tower layer on the whole `protected` sub-router in
  `router.rs`) checks JWT signature + audience only. A second `require_app_role` middleware
  (`api/middleware/auth.rs`), applied inside the auth layer, does the actual `mc-user` OR `mc-admin`
  check. Handlers that take `Extension<KeycloakToken<Role>>` are reading already-validated claims —
  they must never be the primary guard.
- **BFF**: every `bff-api/collections/*` and `.../movies/*` route calls `requireAuth()` then
  `requireMcUser()`/`requireMcAdmin()` (`frontend/mcm-app/src/bff-server/role-check.ts`) before
  constructing the mc-service client. This ordering is enforced structurally in CI by the
  `mcm-auth-before-authz` Semgrep rule (`security/sast/rules/mcm-auth-before-authz.yaml`), which
  flags any `createMcServiceClient(...)` call not textually preceded by one of those guards in the
  same function.
- **Frontend**: `frontend/mcm-app/src/utils/role-checker.ts` exposes `hasRole`/`isAdmin`/`isMcUser`
  for React components — this is UI-only convenience (show/hide an admin card, etc.). It has zero
  enforcement value; the real authorization always happens server-side at the BFF and mc-service
  tiers.

## Gotchas

- **`axum-keycloak-auth`'s `KeycloakAuthLayer` does not check application roles by itself.** Its
  `required_roles` option is AND-logic (all listed roles must be present), which can't express the
  OR-logic `mc-user` OR `mc-admin` this app needs — that's why a *separate* middleware exists rather
  than configuring the layer with `required_roles`.
- **The SAST rule is structural, not semantic — it can be fooled.** It only recognizes a guard
  call appearing textually before the client construction in the same function body. Auth performed
  in a wrapper/HOF or via an aliased guard name won't be recognized and needs to be triaged into
  `security/sast/allowlist.yaml` rather than silently ignored.
- **Client-side role checks are never a security boundary.** Treat `role-checker.ts` results as a
  UX affordance only — any feature-gating decision that actually matters must be re-verified
  server-side, because a compromised or modified client can call `hasRole`/`isAdmin` with whatever
  it wants.
- **`mc-admin` implicitly includes `mc-user` access at every tier** — each tier's role check
  (`requireMcUser`, `hasRole`, the mc-service OR-check) treats admin as a superset, not a separate
  parallel permission; don't add a new check that requires both roles independently.

See [Auth chain](/openwiki/invariants/auth-chain.md) for how these checks fit into the full
login-to-request sequence, and [mc-service](/openwiki/projects/mc-service.md) /
[BFF](/openwiki/projects/bff.md) for each service's broader architecture.
