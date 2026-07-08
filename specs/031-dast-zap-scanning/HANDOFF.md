# HANDOFF — Feature 031: DAST Security Scanning (OWASP ZAP)

**For**: a fresh implementation session. **Branch**: `031-dast-zap-scanning` (already checked out).
**State as of handoff**: SDD spec→clarify→plan→tasks→analyze all complete and committed. **No implementation code written yet.** Last commit `a22c4ae` (analyze remediations C1–C6).

## Start here

1. Read, in order: [spec.md](./spec.md) → [plan.md](./plan.md) → [research.md](./research.md) → [data-model.md](./data-model.md) → [contracts/](./contracts/) → [quickstart.md](./quickstart.md) → [tasks.md](./tasks.md).
2. Then run **`/speckit-implement`** to execute [tasks.md](./tasks.md). It has a mandatory `before_implement` git-commit hook (auto-execute on) — the tree is currently clean.
3. Build in task order. **MVP = User Story 1** (Setup T001–T003 → Foundational T004–T009 → US1 T010–T014). Stop and validate quickstart Scenario 1 before US2/US3.

## What this feature is

Config-as-code DAST with **OSS OWASP ZAP only (no StackHawk/SaaS)**. Two modes share one scan definition: a non-destructive **baseline** run locally, and a destructive **active** scan in Forgejo CI against the ephemeral throwaway stack, gating merges on any High finding not in a version-controlled allowlist. Targets: **BFF** (session-cookie), **mc-service** (bearer JWT), **agent gateway** (bearer JWT, **passive-only in CI**). Keycloak is out of scope.

## Decisions already made (do NOT re-litigate — see research.md)

- **Auth**: mc-service + gateway → ZAP script does Keycloak **ROPC** (client `mcm-bff-test`, user `e2e-test-user`); the minted token's `aud` already covers `movie-collection-manager` + `agent-gateway`; auto re-auth on 401. BFF → **headless HTTP** PKCE login helper `scripts/dast-bff-login.mjs` (NO Playwright/browser in the job) → 3 `mcm_*` cookies; refresh via `/bff-api/auth/refresh` on 401.
- **Reachability**: ZAP runs as a container **attached to the Compose networks** and reaches targets by DNS (`mcm-bff-service-nonsecure:3000`, `mc-service:3001`, `movie-assistant-gateway:8000`, `keycloak-service:8080`). **No new published host ports** (keeps `check-prod-ci-port-collision.mjs` green).
- **Gate**: `scripts/check-dast-findings.mjs` parses ZAP JSON, suppresses via `security/zap/allowlist.yaml` (the allowlist IS the baseline — no stored-diff), fails on remaining High; findings stay **visible** in reports.
- **Env vars**: scripts read `DAST_*`, defaulting to the existing `E2E_*` secrets — **no new secret material**.
- **CI**: new `dast` job in `.forgejo/workflows/app-ci.yml`, `runs-on: kvm`, path-gated on `changes.app`; **must also bring up the agent stack** (`up-agents-prod`) or the gateway target won't exist; `upload-artifact@v3`; `always()` teardown incl. `down-agents-prod`.

## Environment facts the fresh session needs

- **Ports (CI/dev)**: BFF `127.0.0.1:8082`, mc-service `127.0.0.1:3001`, Keycloak `127.0.0.1:8099`; agent gateway has **no host port** (internal network). Prod-reserved range 19000–19099 — do not touch.
- **Local run prereqs**: `node scripts/gen-dev-secrets.mjs`; `pnpm nx up-auth infrastructure-as-code`; `pnpm nx up-mcm infrastructure-as-code` **with `--profile agents`** for full 3-target coverage. `frontend/mcm-app/.env.e2e.local` supplies `E2E_TEST_USER`/`E2E_TEST_PASSWORD`/`E2E_ROPC_CLIENT_ID`/`E2E_ROPC_CLIENT_SECRET`.
- **CI is Forgejo** (`.forgejo/workflows/`, NOT GitHub). `upload-artifact@v4` is unsupported → use **v3**. Guardrails scripts follow a `--selftest`-then-scan pattern.
- **RTK** must be active (`rtk gain` > 80%) per the constitution before test runs.
- **TDD is mandatory**: each test task (T007/T013/T015/T022) has a Verify RED (expected failure output) before the paired impl's Verify GREEN. Do not skip RED.

## Constitution & gotchas

- Constitution Check already PASSED (plan.md) — this feature advances Security (validates headers/error-handling/rate-limiting), adds no new secrets, is Docker-native, honors CI rules. Keep it that way.
- **Never** commit the forge host literal or the domain (`grumpyrobot.co`) — same rule as everywhere in this repo.
- No application (TS/Rust/Python) source changes — work is `security/zap/` config, `scripts/*.mjs`, CI YAML, and docs only.
- Final validation (tasks T028/T029): full quickstart scenarios, `pnpm nx e2e mcm-app` still green, `check-prod-ci-port-collision.mjs` green.

## Files to be created (from tasks.md)

`security/zap/{README.md,zap-baseline.yaml,zap-full.yaml,allowlist.yaml,scripts/bearer-auth.js,scripts/bff-session-refresh.js,contexts/}`, `scripts/{zap-scan.mjs,dast-bff-login.mjs,check-dast-findings.mjs}`, `scripts/__tests__/*.test.mjs`, a `dast` job in `.forgejo/workflows/app-ci.yml`, an Nx `dast` target in `infrastructure-as-code/project.json`, `docs/runbooks/dast-scanning.md`, `.gitignore` additions.
