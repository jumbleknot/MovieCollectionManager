# Implementation Plan: DAST Security Scanning (OWASP ZAP)

**Branch**: `031-dast-zap-scanning` | **Date**: 2026-07-08 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `specs/031-dast-zap-scanning/spec.md`

## Summary

Add config-as-code Dynamic Application Security Testing with OWASP ZAP (OSS, no SaaS). Two modes share one scan definition: a **non-destructive baseline** developers run locally, and a **destructive active** scan the Forgejo CI pipeline runs against the existing ephemeral throwaway stack, gating merges on any High-risk finding not in a version-controlled allowlist. Three targets — the BFF (session-cookie auth), mc-service (bearer JWT), and the agent gateway (bearer JWT, passive-only in CI) — are scanned authenticated as the existing `e2e-test-user` (mc-user). ZAP runs as a container attached to the Compose networks (DNS names, no new published ports), reusing the E2E stack bring-up, the ROPC client (`mcm-bff-test`), and the Playwright login. Reports (HTML/JSON/SARIF) are published as build artifacts; a gate script fails the pipeline on un-allowlisted High findings.

## Technical Context

**Language/Version**: Node.js (ESM `.mjs`, matches `scripts/*.mjs`) for the runner + gate; ZAP JS scripts (Nashorn/Graal, ZAP-embedded) for in-scanner auth; YAML for ZAP Automation Framework plans. No application (TS/Rust/Python) source changes.

**Primary Dependencies**: OWASP ZAP stable Docker image (`ghcr.io/zaproxy/zaproxy:stable`) run via the Automation Framework (`zap.sh -cmd -autorun <plan>.yaml`); Docker Compose (existing stacks); Keycloak (JWT/ROPC); existing `gen-dev-secrets.mjs` / `gen-ci-env.mjs`.

**Storage**: N/A (no persistent data). Scan reports written to a gitignored output dir; allowlist + scan config are version-controlled text.

**Testing**: Node test for the gate script (synthetic ZAP JSON → RED/GREEN); `--selftest` self-check on both new gate/parser scripts (repo gate convention); quickstart validation scenarios (authenticated-crawl assertion, non-destructive assertion, intentional-finding gate proof).

**Target Platform**: Self-hosted Forgejo `act_runner` (`runs-on: kvm`, rootless Docker socket) for CI; developer workstations (Windows/PowerShell + Bash) for local.

**Project Type**: Security/DevOps tooling + CI integration over the existing web-service + agent monorepo. No new runtime service.

**Performance Goals**: Local baseline completes in minutes (spider + passive). CI active scan target ≤ ~15 min wall-clock so it does not dominate PR time on the single kvm runner; passive-only gateway scan keeps LLM invocations out of the hot path.

**Constraints**: No external SaaS (FR-014). No new published host ports — ZAP attaches to Compose networks by DNS (avoids the prod/CI port-collision gate, FR-016). No secrets in committed files, reports, or logs (FR-015, SC-008). Destructive active mode only against the disposable stack, with a guard against pointing at shared/prod (FR-006, FR-017). Must maintain a valid authenticated session across the 300s access-token TTL for the full scan (FR-013).

**Scale/Scope**: 3 scan targets; ~1 new top-level `security/zap/` config tree; 2 new `scripts/*.mjs`; 1 new CI job in `app-ci.yml`; 1 Nx target; 1 runbook. No application code touched.

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

| Principle | Assessment |
|---|---|
| **Security (NON-NEGOTIABLE)** | **Advances** the mandate. DAST directly verifies §Transport Security (security headers, HSTS, CORS), §Error Handling (no stack-trace/internal leakage), §Infrastructure Hardening (rate limiting, no directory listing / exposed metadata files) on the running app. Complements the §Dependency Security "automated vulnerability scanning" requirement (DAST alongside existing SAST/deps). No principle relaxed. ✅ |
| **Authentication / Token Validation** | Scans authenticate via the existing OAuth/OIDC test user and ROPC test client; no auth logic altered. mc-service audience/role checks are exercised, not bypassed. ✅ |
| **Secrets Management (NON-NEGOTIABLE)** | Test-user + ROPC creds sourced from the Forgejo Actions secret store / gitignored local `.env.e2e.local` (existing wiring); no literal in any committed scan config, script, or report. New scan config/allowlist contain no credentials. Reports scrubbed/validated for secret leakage (SC-008). ✅ |
| **TDD (NON-NEGOTIABLE)** | Gate/parser scripts are TDD'd: synthetic ZAP report with a High finding proves the gate goes RED (non-zero exit); allowlist suppression + clean report prove GREEN. Both scripts ship a `--selftest`. Scan behavior validated by quickstart scenarios (authenticated-crawl, non-destructive, intentional-finding). tasks.md will carry the TDD checkpoint format. ✅ |
| **Behavior-Descriptive Identifiers** | New files named by behavior (`zap-scan.mjs`, `check-dast-findings.mjs`, `bearer-auth.js`, `bff-session-refresh.js`, `zap-baseline.yaml`, `zap-full.yaml`, `allowlist.yaml`); spec IDs only in provenance comments. ✅ |
| **Docker-Native Operations** | ZAP runs as a container; scan environment is the existing Compose stacks. ✅ |
| **CI/CD (feature 023/029/030 rules)** | New job lives in `.forgejo/workflows/app-ci.yml` (not GitHub); path-gated via the existing `changes.app` filter; `upload-artifact@v3`; `always()` teardown; no published ports → passes `check-prod-ci-port-collision.mjs`. ✅ |
| **API-First / Clean Architecture / Rust Safety** | N/A — no application/API/Rust source changes. ✅ |

**Result: PASS.** No violations; Complexity Tracking not required.

## Project Structure

### Documentation (this feature)

```text
specs/031-dast-zap-scanning/
├── plan.md              # This file
├── research.md          # Phase 0 — decisions (auth mechanism, runner, allowlist, token-refresh, job placement)
├── data-model.md        # Phase 1 — entities (Scan Definition/Target/Test User/Finding/Allowlist/Report)
├── contracts/
│   ├── zap-scan-contract.md      # scan config + allowlist + report output contract
│   └── ci-integration-contract.md # dast CI job: triggers, inputs/secrets, artifacts, pass/fail, teardown
├── quickstart.md        # Phase 1 — runnable validation scenarios
└── tasks.md             # Phase 2 (/speckit-tasks — NOT created here)
```

### Source Code (repository root)

```text
security/
└── zap/
    ├── README.md                    # what/why, how to run, how to triage + allowlist
    ├── zap-baseline.yaml            # AF plan: spider + passive, all 3 targets, non-destructive (local default)
    ├── zap-full.yaml               # AF plan: active BFF + mc-service, passive gateway (CI)
    ├── scripts/
    │   ├── bearer-auth.js          # ZAP auth script: ROPC mint (mcm-bff-test / e2e-test-user) → Bearer; re-auth on 401
    │   └── bff-session-refresh.js  # ZAP httpsender: refresh mcm_access_token via /bff-api/auth/refresh on 401
    ├── contexts/                    # (optional) exported ZAP contexts if not inlined in the plans
    ├── allowlist.yaml              # accepted / false-positive findings: {pluginId, uriPattern, justification, addedBy}
    └── reports/                     # gitignored scan output (html/json/sarif)

scripts/
├── zap-scan.mjs                    # runner: resolve target (local|ci) + mode (baseline|full), prep auth env,
│                                   #   run ZAP container on the compose network, collect reports
└── check-dast-findings.mjs         # gate: parse ZAP JSON, drop allowlisted, fail on remaining High; --selftest

.forgejo/workflows/app-ci.yml       # + new `dast` job (path-gated on changes.app, runs-on: kvm); add to trigger-cd needs
infrastructure-as-code/project.json # + Nx `dast` target wrapping scripts/zap-scan.mjs (run-commands)
docs/runbooks/dast-scanning.md      # operator runbook (local run, CI behavior, triage/allowlist, guard rules)
.gitignore                          # + security/zap/reports/  and  security/zap/**/*.local.*
```

**Structure Decision**: A single new top-level `security/zap/` tree holds all config-as-code (ZAP plans, in-scanner auth scripts, allowlist), keeping security tooling isolated and discoverable. Executable glue (runner + gate) lives in the existing `scripts/` directory to match the repo's `*.mjs` convention and the `--selftest` gate pattern. CI wiring is a single added job in the existing `app-ci.yml`; the Nx `dast` target on `infrastructure-as-code` gives the standard `pnpm nx dast infrastructure-as-code` invocation.

## Complexity Tracking

No Constitution Check violations — section intentionally empty.
