# HANDOFF — Feature 022: Production Public-Hostname Authentication

**For a fresh session.** Read this first, then [spec.md](./spec.md) → [plan.md](./plan.md) → [research.md](./research.md) (esp. **R11**) → [data-model.md](./data-model.md) → [tasks.md](./tasks.md).

## Where we are (2026-06-23)

SDD progress: **constitution ✓ → specify ✓ → plan ✓ → tasks ✓ → analyze ✓ → implement ⬜**.

- **Branch**: `022-prod-public-hostname-auth` (HEAD `e0a4f4c`, pushed to both remotes). Working tree clean.
- **tasks.md** = 28 tasks, 6 phases (Setup → Foundational → US1 → US2 → US3 → Polish) + a Platform Parity Table. `/speckit-analyze` found 1 CRITICAL (missing parity table) + 4 lesser (C2/G1/A1/I1); **all remediated**.
- The speckit git hooks **auto-commit** (`auto_execute_hooks: true`) — expect each `/speckit-*` step to land its own commit. The `before/after_implement` git hooks are **optional** (commit prompts).

## ⚠️ READ BEFORE TOUCHING ANY FILE — domain is parameterized + history was scrubbed

The real domain **`grumpyrobot.co` was removed from the entire repo AND git history** (private repo, scrubbed pre-public; commit `e0a4f4c`, both remotes force-pushed). **Never re-introduce the literal.** New convention (research **R11**):

- App host was **renamed `app.` → `mcm.`**. Canonical hosts: **`mcm.${BASE_DOMAIN}`** (app/BFF) + **`auth.${BASE_DOMAIN}`** (shared Keycloak — kept shared so future apps can reuse one IdP). One var `BASE_DOMAIN`; the real value is supplied at deploy via gitignored `*.env.prod` / CI vars, **never committed**.
- In committed compose: hosts interpolate as `${BASE_DOMAIN:?set in <stack>.env.prod}` (fail-fast). In docs/specs: the literal token `mcm.${BASE_DOMAIN}` / `auth.${BASE_DOMAIN}`.
- **Realm export**: commit `prod-realm.json` (or template) with `${BASE_DOMAIN}` in redirect URIs/webOrigins → render to a **gitignored concrete realm file at deploy via `envsubst`** (Keycloak native env-substitution is version-flaky). The realm **name** `grumpyrobot` (not the `.co` domain) is intentionally retained across the tree.
- **Stale clones reintroduce the domain** — if you pull on another machine that predates `e0a4f4c`, re-clone or hard-reset; do not push from a stale checkout. Two remotes: `github` (PRIVATE, 0 forks/PRs) + `origin` (homelab Gitea/tailnet). GitHub may keep old commits by-SHA until its GC; a guaranteed purge would need delete+recreate of the GitHub repo (not done — low risk while private).
- **Backup mirror** of the pre-scrub history is at **`E:/tmp/mcm-backup-domain-scrub.git`** — **KEEP until feature 022 is complete/merged**, then it can be deleted.
- Tooling note: history scrub used **git-filter-repo**; it needed Python, installed via `winget install Python.Python.3.12 --scope user` (`C:\Users\Steve\AppData\Local\Programs\Python\Python312\python.exe`; run as `python -m git_filter_repo`). **Maven Central / BFG download is egress-blocked here** (nginx 404); GitHub raw + PyPI + winget are reachable.

## What this feature is

Config-as-code so off-network mobile + web login works over `mcm.${BASE_DOMAIN}` (BFF/app) and `auth.${BASE_DOMAIN}` (Keycloak). Scope = `docs/proposals/homelab-setup/Phase-11-Work-Order.md` Parts A–D; context in PRD-CI.md / Server-Setup-Runbook.md / keycloak-prod.compose.yaml (all in `docs/proposals/homelab-setup/`, mutually consistent).

**User stories**: US1 (P1) prod Keycloak on public auth host; US2 (P2) off-network e2e login (web+mobile); US3 (P3) secret-safe + gate-compliant config.

## Load-bearing decisions (verified against the codebase — don't re-litigate)

1. **No application code change.** BFF already separates `KEYCLOAK_PUBLIC_URL` (browser issuer) from `KEYCLOAK_URL` (internal back-channel) — [env.ts](../../frontend/mcm-app/src/config/env.ts) + [token-service.ts](../../frontend/mcm-app/src/bff-server/token-service.ts). `Secure` cookie = `!isDevelopment` → set `NODE_ENV=production` ([auth.ts](../../frontend/mcm-app/src/bff-server/auth.ts)). Production is reached purely by env values. (Lone code touch this feature made: the `error_handler.rs` RFC-9457 problem-`type` URI moved off the real domain to a reserved `.example` host — not login logic.)
2. **Canonical realm is `grumpyrobot`** (`.env.local`/`.env.docker`). The `KEYCLOAK_REALM=jumbleknot` in `.env.docker.example` is a stale template (adjacent fix = T025). Org stays `jumbleknot` (intentional).
3. **Prod compose layout**: standalone per-stack files beside dev siblings — `infrastructure-as-code/docker/keycloak/compose.prod.yaml` (`name: prod-auth`) + `bff/compose.prod.yaml` (`name: prod-app`). Each a Komodo Stack. Keycloak draft at `docs/proposals/homelab-setup/keycloak-prod.compose.yaml`.
4. **Secrets**: fail-fast `${VAR:?}` only; commit `*.env.prod.example` placeholders; real `*.env.prod`/`secrets/*.txt` operator/Komodo-injected (gitignored — `.gitignore` already negates `*.env.prod.example` to keep templates tracked). `gen-dev-secrets.mjs` stays dev-only. `KC_DB_PASSWORD` == `keycloak_db_password.txt`.
5. **`edge-network`** ingress net must be added to `APPROVED_NETWORKS` in `scripts/check-resource-naming.mjs` **before** the prod compose enters the gated path (RED→GREEN, T003/T004) or `naming-gate.yml` fails.
6. **CORS**: same-origin (app + bff-api both on `mcm.${BASE_DOMAIN}`) → no wildcard; verify none set.
7. **TLS**: terminates at Cloudflare edge; cloudflared→container plain HTTP on `edge-network` — the one documented constitution deviation (plan Complexity Tracking), HSTS/TLS owned at the edge.

## Next step — run `/speckit-implement`

- **MVP = Phases 1–3 (US1 Keycloak)** — deployable on the upstream image alone, ahead of the BFF image pipeline. Then US2 (BFF + APK + mobile redirect), then US3 audit woven throughout.
- TDD is adapted for this config feature: the **gates are the RED/GREEN checks** — `scripts/check-resource-naming.mjs`, `scripts/check-no-inline-secrets.mjs`, `scripts/secret-scan.mjs` (run `--selftest` THEN plain, as CI does), plus `docker compose -f <file> config` fail-fast on missing `${VAR:?}`. tasks.md carries the literal expected RED/GREEN output per checkpoint.
- **Regression**: web E2E (Playwright) login + BFF cookie units — web E2E only via the **dev-container** path (Metro OOMs). The **off-network device login is a MANUAL operator E2E** (real device, cellular) — [contracts/verification.md](./contracts/verification.md) item 7.
- **Out-of-repo (document, don't code)**: Komodo Stacks, Cloudflare published routes, real secret injection, the device test — Work-Order Parts C/D (task T028).

## Gotchas / context

- Redis required or BFF `/login` 500s; mc-service needs Keycloak (JWKS on startup).
- mc-service integration tests need a replica-set MongoDB — bring the mcm stack up, never a bare `docker run` (see CLAUDE.md).
- The four `docs/proposals/homelab-setup/` files are mutually consistent — if you change one infra fact (hostnames, network names, registry namespace, realm), update all four (T027).
- Memory: see `project_mcm_022_prod_public_hostname_auth` + the 🚨 DOMAIN note for the full scrub/convention record.
