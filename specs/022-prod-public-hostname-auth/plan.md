# Implementation Plan: Production Public-Hostname Authentication

**Branch**: `022-prod-public-hostname-auth` | **Date**: 2026-06-23 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `specs/022-prod-public-hostname-auth/spec.md`

## Summary

Produce the committed, config-as-code that lets an off-network user sign in over the public hostnames `mcm.${BASE_DOMAIN}` (BFF/app) and `auth.${BASE_DOMAIN}` (Keycloak). The work is **configuration, not application logic**: a production Keycloak compose (prod mode, public issuer, edge-TLS proxy headers, admin-on-tailnet, brute-force on, sanitized realm import), a production BFF compose (public issuer via the existing `KEYCLOAK_PUBLIC_URL`, `NODE_ENV=production` to set the Secure cookie flag, Redis session store, `edge-network` attachment), the OAuth client's prod redirect URIs (web + mobile), a production APK that bakes the public hostnames, and a secret-safe surface (`${VAR:?}` refs, placeholder templates, both CI gates green). Deploy orchestration (Komodo), Cloudflare route publication, and the off-network device test are documented operator steps, not code deliverables.

Key discovery from the codebase that shapes the approach: **the BFF already separates the internal connect URL (`KEYCLOAK_URL`) from the browser-facing issuer (`KEYCLOAK_PUBLIC_URL`)** ([config/env.ts](../../frontend/mcm-app/src/config/env.ts), [token-service.ts](../../frontend/mcm-app/src/bff-server/token-service.ts)), and the **Secure cookie flag is `!isDevelopment`** driven by `NODE_ENV` ([auth.ts](../../frontend/mcm-app/src/bff-server/auth.ts)). So no application code change is required — production is reached purely by setting these env values. The canonical realm is **`grumpyrobot`** (per `.env.local`/`.env.docker`); the work order is correct and the only realm-name drift is a stale template noted in research.

## Technical Context

**Language/Version**: No application language change. Artifacts are Docker Compose (Compose Spec v2), a Keycloak realm JSON export (Keycloak 26.5.5), dotenv-style `.env.example` templates, and a Node ESM build script invocation (`build-apk.mjs`). Gate scripts are Node 24.

**Primary Dependencies**: Keycloak 26.5.5 (`quay.io/keycloak/keycloak`), Postgres 18 (Keycloak store), the `mcm-bff` image (Expo Router Node BFF), Redis (BFF session store), Cloudflare Tunnel (`cloudflared`) as ingress. Existing repo tooling: `scripts/check-resource-naming.mjs`, `scripts/check-no-inline-secrets.mjs`, `scripts/secret-scan.mjs`, `scripts/gen-dev-secrets.mjs`.

**Storage**: No new storage. Keycloak → Postgres (existing volume `keycloak-store-postgres-data`); BFF sessions → Redis (`mcm-bff-cache-redis`). Production reuses the same volume/role names on the prod rootless daemon.

**Testing**: Automated guardrails (`secret-scan.mjs`, `check-no-inline-secrets.mjs`, `check-resource-naming.mjs`) run as RED/GREEN gates; `docker compose config` validates each prod compose interpolates and fail-fasts on missing vars; an issuer/discovery probe verifies the public issuer; the existing web E2E (Playwright) and mobile Maestro login flows are the regression surface; the off-network device login is a documented **manual** E2E (real device, non-home network).

**Target Platform**: Headless Ubuntu homelab, two segregated **rootless** Docker daemons (`ci`, `prod`); production runs on the `prod` daemon behind a Cloudflare Tunnel exposing only `mcm.`/`auth.`.

**Project Type**: Infrastructure/configuration feature within the existing web + mobile + backend monorepo. No new project; edits land in `infrastructure-as-code/`, `frontend/mcm-app/` (build/env + docs), and `scripts/`.

**Performance Goals**: Not a performance feature. Implicit target: the off-network OAuth round-trip completes within normal interactive latency over mobile data (no added round-trips vs. dev).

**Constraints**: No clear-text secrets in git (constitution §Secrets, features 021/022/023). TLS terminates at the Cloudflare edge; internal cloudflared→container traffic is plain HTTP confined to `edge-network` (see Complexity Tracking deviation). Only `mcm.` and `auth.` may be publicly reachable. The token issuer must stay fixed at the public origin while the BFF reaches Keycloak internally (back-channel-dynamic).

**Scale/Scope**: Single homelab server, single production instance (no HA). Scope = ~2 prod compose files, 1 realm export, 1–2 `.env.example` templates, 1 naming-gate allowlist edit, prod APK build wiring, and the companion doc updates already partially in place.

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

| Principle (constitution) | Verdict | Notes |
|---|---|---|
| Auth: Authorization Code + PKCE via BFF | ✅ PASS | Unchanged. Feature only points the existing flow at public origins. No new auth code, no prohibited custom login. |
| Token Validation (`iss`/`aud`/`exp`/`nbf`) | ✅ PASS | BFF validates the public issuer via `KEYCLOAK_PUBLIC_URL` (already implemented). Prod sets it to `https://auth.${BASE_DOMAIN}`. |
| IdP Boundary (MFA/CA at IdP only) | ✅ PASS | Brute-force + admin 2FA enforced at Keycloak; app does not replicate. |
| Centralized Access Control (protected-by-default) | ✅ PASS | No handler added or changed; mc-service layer guard + BFF `requireAuth` untouched. |
| Secrets Management (no secrets in git) | ✅ PASS | Core of US3: `${VAR:?}` refs, placeholder templates, file-secrets, both CI gates. |
| Session Management (server-side, SameSite=Strict, Secure, rotation) | ✅ PASS | Redis store wired; `SameSite=Strict` already set; Secure flag enabled by `NODE_ENV=production`; refresh rotation unchanged. |
| Transport Security — TLS 1.3 + HSTS + CORS no-wildcard | ⚠️ DEVIATION (justified) | TLS terminates at the Cloudflare edge (TLS 1.3 + HSTS owned there); cloudflared→container is plain HTTP on the private `edge-network` with no published ports. CORS is app-origin-only (same-origin architecture; no wildcard). See Complexity Tracking. |
| Docker-Native Operations | ✅ PASS | Prod compose files with healthchecks, env-var config, log rotation. |
| TDD / Test Type Integrity | ✅ PASS (adapted) | Config feature: gates + `compose config` + issuer probe are the automatable RED/GREEN checks; login regression via existing web/mobile E2E; off-network device login is a documented manual E2E. tasks.md carries TDD checkpoints. |
| SDD + Resource Naming convention | ✅ PASS | New `edge-network` is convention-compliant and added to the gate's approved set (FR-024) before the prod files enter the gated path. |
| Logging (no secrets, debug off in prod) | ✅ PASS | `NODE_ENV=production` suppresses debug logs ([logger.ts](../../frontend/mcm-app/src/bff-server/logger.ts)); realm export carries no secrets. |

**Gate result**: PASS with one documented deviation (edge-terminated TLS). No unjustified violations.

## Project Structure

### Documentation (this feature)

```text
specs/022-prod-public-hostname-auth/
├── plan.md              # This file
├── research.md          # Phase 0 output — decisions + resolved unknowns
├── data-model.md        # Phase 1 output — config entities & their fields
├── quickstart.md        # Phase 1 output — verification/run guide
├── contracts/           # Phase 1 output — config "contracts"
│   ├── keycloak-prod-env.md
│   ├── bff-prod-env.md
│   ├── realm-export.md
│   ├── network-and-secrets.md
│   └── verification.md
├── checklists/
│   └── requirements.md  # (from /speckit-specify)
└── tasks.md             # Phase 2 output (/speckit-tasks — NOT created here)
```

### Source Code (repository root)

```text
infrastructure-as-code/docker/
├── keycloak/
│   ├── compose.prod.yaml        # NEW — production Keycloak (from keycloak-prod.compose.yaml draft)
│   ├── .env.prod.example        # NEW — placeholder template (KC_DB_PASSWORD, KC_BOOTSTRAP_ADMIN_PASSWORD)
│   ├── prod-realm.json          # NEW — sanitized realm export, --import-realm
│   ├── compose.yaml             # UNCHANGED (dev)
│   └── secrets/                 # keycloak_db_password.txt (gitignored, operator-supplied)
├── bff/
│   ├── compose.prod.yaml        # NEW — production BFF (public issuer, NODE_ENV=production, Redis, edge-network)
│   ├── .env.prod.example        # NEW — placeholder template for BFF prod server vars (or reuse .env.docker.example shape)
│   └── compose.yaml             # UNCHANGED (dev)
└── stacks/                      # UNCHANGED (dev named stacks)

scripts/
└── check-resource-naming.mjs    # EDIT — add `edge-network` to APPROVED_NETWORKS

contracts/ (repo)                # naming convention doc
└── naming-convention.md         # EDIT — document `edge-network` (if present in repo)

frontend/mcm-app/
├── scripts/build-apk.mjs        # UNCHANGED logic — prod invocation sets EXPO_PUBLIC_* to public hosts
└── .env.docker.example          # EDIT (separate fix) — stale KEYCLOAK_REALM=jumbleknot → grumpyrobot

docs/proposals/homelab-setup/    # UNCHANGED here (already reconciled); referenced as context
```

**Structure Decision**: Production compose files live **beside their dev counterparts** in each component directory (`infrastructure-as-code/docker/<component>/compose.prod.yaml`), each a standalone Compose project (`name: prod-auth`, `name: prod-app`) deployable as its own Komodo Stack — matching the committed `keycloak-prod.compose.yaml` draft and Komodo's per-stack model. The dev named-stack `include` layer (feature 020) is left untouched. Real `.env.prod` and `secrets/*.txt` are operator-supplied/Komodo-injected and gitignored; only `*.env.prod.example` placeholders are committed.

## Complexity Tracking

| Violation | Why Needed | Simpler Alternative Rejected Because |
|-----------|------------|-------------------------------------|
| Edge-terminated TLS; internal cloudflared→container traffic is plain HTTP (constitution requires TLS 1.3 for all client/service/infra communication) | Cloudflare Tunnel is the chosen CGNAT-proof, no-static-IP ingress; it terminates TLS 1.3 at the edge and dials the origin over the private `edge-network`. HSTS is owned at the edge. This is the precedented repo pattern (feature 007 TLS proxy, runbook 10.C). | Mutual-TLS / in-cluster TLS between cloudflared and each container adds cert management with no real attacker benefit: the segment is a private Docker network with no published ports on a single host. Per §Governance this deviation is documented and human-approved rather than implemented. |
