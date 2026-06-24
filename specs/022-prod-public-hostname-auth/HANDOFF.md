# HANDOFF — Feature 022: Production Public-Hostname Authentication

**For a fresh session.** Read this first, then [spec.md](./spec.md) → [plan.md](./plan.md) → [research.md](./research.md).

## Where we are (2026-06-23)

SDD progress: **constitution ✓ (pre-existing) → specify ✓ → plan ✓ → tasks ⬜ → implement ⬜**.

- **Branch**: `022-prod-public-hostname-auth` (pushed; `ea5e0d6 "spec and plan"`, 0 ahead/0 behind `origin`). Working tree clean.
- **Spec + plan + Phase-0/1 artifacts are committed**: spec.md, plan.md, research.md, data-model.md, quickstart.md, contracts/ (5 files), checklists/requirements.md. CLAUDE.md plan pointer + `.specify/feature.json` updated.
- The speckit git hooks **auto-commit** (`auto_execute_hooks: true`) — expect each `/speckit-*` step to land its own commit.

## What this feature is

Config-as-code to make **off-network mobile + web login** work over `mcm.${BASE_DOMAIN}` (BFF/app) and `auth.${BASE_DOMAIN}` (Keycloak). Scope = `docs/proposals/homelab-setup/Phase-11-Work-Order.md` Parts A–D; context in PRD-CI.md, Server-Setup-Runbook.md, keycloak-prod.compose.yaml (all in `docs/proposals/homelab-setup/`, already reconciled & consistent — committed on `main` as `6218f2d`/`196a539`).

**User stories**: US1 (P1) prod Keycloak on public auth host; US2 (P2) off-network e2e login (web+mobile); US3 (P3) secret-safe + gate-compliant config.

## Load-bearing decisions (verified against the codebase — don't re-litigate)

1. **No application code change.** The BFF already separates internal connect URL from public issuer:
   - `KEYCLOAK_PUBLIC_URL` (browser issuer) vs `KEYCLOAK_URL` (internal back-channel) — [src/config/env.ts](../../frontend/mcm-app/src/config/env.ts), accepted-issuer set in [src/bff-server/token-service.ts](../../frontend/mcm-app/src/bff-server/token-service.ts).
   - `Secure` cookie flag = `!isDevelopment`, and `isDevelopment = NODE_ENV==='development'` → set `NODE_ENV=production` ([src/bff-server/auth.ts](../../frontend/mcm-app/src/bff-server/auth.ts)).
   Production is reached purely by env values.
2. **Canonical realm is `grumpyrobot`** (confirmed in `frontend/mcm-app/.env.local` + `.env.docker`). The `KEYCLOAK_REALM=jumbleknot` in `frontend/mcm-app/.env.docker.example` is a **stale template** — fix it as an adjacent low-priority task (not on the login critical path). Org stays `jumbleknot` (intentional).
3. **Prod compose layout**: standalone per-stack files beside dev siblings — `infrastructure-as-code/docker/keycloak/compose.prod.yaml` (`name: prod-auth`) + `infrastructure-as-code/docker/bff/compose.prod.yaml`. Each a Komodo Stack. The Keycloak draft already exists at `docs/proposals/homelab-setup/keycloak-prod.compose.yaml` — move/adapt it in.
4. **Secrets**: fail-fast `${VAR:?}` refs only; commit `*.env.prod.example` placeholders; real `*.env.prod`/`secrets/*.txt` are operator/Komodo-injected (gitignored). `gen-dev-secrets.mjs` stays dev-only. `KC_DB_PASSWORD` must equal `keycloak_db_password.txt`.
5. **`edge-network`**: ingress net must be added to `APPROVED_NETWORKS` in `scripts/check-resource-naming.mjs` (+ `contracts/naming-convention.md` if present) BEFORE the prod compose enters the gated path, or `naming-gate.yml` fails. RED→GREEN task.
6. **CORS**: same-origin (app + bff-api both on `mcm.${BASE_DOMAIN}`) → no wildcard needed; verify none is set.
7. **TLS**: terminates at Cloudflare edge; cloudflared→container is plain HTTP on `edge-network`. This is the one documented constitution deviation (plan Complexity Tracking) — HSTS/TLS owned at the edge.

## Next step

Run **`/speckit-tasks`**. When writing tasks.md:
- Use the TDD checkpoint format from `docs/templates/feature-test-tasks-template.md` (constitution mandates Verify RED / Verify GREEN).
- This is an infra/config feature: the automatable RED/GREEN are the **gates** (`check-resource-naming.mjs`, `check-no-inline-secrets.mjs`, `secret-scan.mjs`) + `docker compose config` fail-fast + the issuer/discovery probe + existing web-E2E/cookie-unit regression. The **off-network device login is a manual E2E** (real device, cellular) — see [contracts/verification.md](./contracts/verification.md).
- Out-of-repo (document, don't code): Komodo Stacks, Cloudflare published routes, real secret injection, the device test. Work-order Part C/D.
- Suggested task order mirrors the work order: A1/A3/A4 (Keycloak+realm+redirect URIs, US1, deployable now) → B1/B2 (BFF+APK, US2) → US3 gate/secret tasks woven throughout → verification.

## Gotchas / context

- Off-network login E2E can't be automated here; mobile agent/login E2E otherwise runs in CI (Metro OOMs locally).
- mc-service requires Keycloak (JWKS on startup); Redis required or BFF `/login` 500s.
- Run gates exactly as CI does (`--selftest` then plain). Web E2E only via dev-container.
- The four `docs/proposals/homelab-setup/` files are mutually consistent as of `196a539` — if you change one infra fact (hostnames, network names, registry namespace `jumbleknot`, realm), update all four.
