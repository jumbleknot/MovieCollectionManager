# Implementation Plan: SAST/SCA Baseline Hardening

**Branch**: `034-hardening` | **Date**: 2026-07-11 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `specs/034-hardening/spec.md`

## Summary

Burn down the feature-033 SAST/SCA allowlist baseline by actually remediating the pre-existing findings and deleting each fixed finding's `security/sast/allowlist.yaml` entry, so `scripts/check-sast-findings.mjs` stays green while the allowlist shrinks monotonically to only documented false-positives/accepted-risks plus any recorded carried-forward debt. Four slices, ordered by security value: (P1) runtime dependency CVE bumps across Python (`uv.lock`), JS (`pnpm-lock.yaml`), and Rust (`Cargo.lock`); (P2) non-root `USER` hardening of the five app-tier Dockerfiles using `backend/mc-service` as the reference; (P3) CI/CD supply-chain hardening (pin `.forgejo/workflows/*.yml` actions to commit SHAs, add Renovate/pnpm/npm release-age cooldowns, triage `run-shell-injection` steps); (P4) opportunistic non-blocking dev/build-only dep bumps. No new application behavior, no new CI secrets — only dependency versions, container user config, workflow definitions, and the allowlist change.

## Technical Context

**Language/Version**: Python 3.13 (agent layer + MCP servers, `uv`); TypeScript/Node 24.14.1 (BFF/frontend, `pnpm`); Rust (mc-service workspace, `cargo`). No application source changes.

**Primary Dependencies**: The remediation targets — Python: `aiohttp`, `cryptography`, `langchain`, `langchain-anthropic`, `langsmith`, `pydantic-settings`, `starlette` (all transitive, pinned in `uv.lock`). JS: `form-data`, `hono`, `undici` (transitive, `pnpm-lock.yaml`). Rust: `crossbeam-epoch` (transitive, `Cargo.lock`). Tooling: Semgrep + cargo-audit/pnpm-audit/pip-audit via `scripts/sast-scan.mjs`; the gate `scripts/check-sast-findings.mjs`.

**Storage**: N/A (no data-tier change).

**Testing**: The SAST gate itself is the primary acceptance harness (`pnpm nx sast infrastructure-as-code` → `node scripts/check-sast-findings.mjs`). Existing suites for regression: agent-layer `pytest` (per Python bump), JS unit + web E2E regression (JS bumps + container hardening), `pnpm nx test mc-service` (Rust bump), CI workflow validity (pipeline changes).

**Target Platform**: Linux containers on the trusted internal Docker network (prod = homelab Komodo stacks; CI = Forgejo `act_runner`). Scan validated on Linux/CI file discovery (feature-033 platform-discovery lesson), not only local Windows.

**Project Type**: Cross-cutting security remediation across the polyglot monorepo (no single project owns it; `infrastructure-as-code` hosts the `sast` Nx target).

**Performance Goals**: N/A — no runtime hot path touched. Bumps must not measurably regress container start or the agent/BFF request path.

**Constraints**: Every dependency bump must keep the affected build + existing tests green (FR-012: revert-on-break, retain-allowlist-with-updated-justification). Non-root hardening must preserve writable runtime paths. Action SHA pins must keep the human-readable version as a trailing comment. Scan authority is Linux/CI, not Windows.

**Scale/Scope**: ~19 runtime advisories / 13 packages (P1); 5 Dockerfiles (P2); ~40 action-pin + ~6 shell-injection + release-age findings across 4 workflow files + `renovate.json`/`.npmrc`/`pnpm-workspace.yaml` (P3); ~9 dev-dep advisories (P4). Net effect: `allowlist.yaml` drops from the 55-blocking baseline to a small residual.

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

| Principle | Assessment |
|---|---|
| **Security §Dependency Security** ("dependencies kept up to date and scanned; critical vulns remediated within SLA; versions pinned") | **This feature directly implements it.** Bumps clear known advisories; lockfiles keep exact pins; the SAST gate enforces no regression. ✅ Advances compliance. |
| **Security §Infrastructure Hardening / Web Server Hardening** | Non-root container `USER` is defense-in-depth aligned with hardening intent. ✅ |
| **Docker-Native (multi-stage, env-config, health checks)** | All five images stay multi-stage; only a non-root `USER` + ownership of writable paths is added. No structural change. ✅ |
| **AI Assistant §Technology Agnosticism** | spec.md stays WHAT/WHY (version numbers are testable acceptance targets, not design — mirrors 033's naming of concrete scanners); plan.md holds the HOW (uv/pnpm/cargo commands, SHA-pin mechanics). ✅ |
| **TDD (NON-NEGOTIABLE)** | No new application behavior to test-drive. The "test" for each remediation is the **re-scan proving the finding is gone** and the **gate staying green after the allowlist entry is deleted** — a genuine RED→GREEN: RED = finding present / entry required; GREEN = finding absent / entry deleted. Existing suites guard against functional regression from bumps + container changes. Documented in Complexity Tracking as an intentional, justified adaptation of the TDD checkpoint for a remediation feature. ⚠️ Justified. |
| **Behavior-Descriptive Identifiers** | No new identifiers; only version strings, Dockerfile user names, workflow SHAs, YAML config keys. ✅ |
| **Secrets Management / No clear-text secrets** | No new secret material; SHA-pinning and release-age changes touch no credentials. The P3 `run-shell-injection` refactor moves values into `env:` (safer), never inlines a secret. ✅ |

**Gate result**: PASS. One justified adaptation (TDD checkpoint shape for a remediation feature) recorded in Complexity Tracking; no unjustified violation.

## Project Structure

### Documentation (this feature)

```text
specs/034-hardening/
├── plan.md              # This file
├── spec.md              # Feature spec (/speckit-specify)
├── research.md          # Phase 0 — remediation mechanics per ecosystem
├── data-model.md        # Phase 1 — allowlist-entry / finding / burn-down ledger
├── quickstart.md        # Phase 1 — how to run the scan + validate the burn-down
├── checklists/
│   └── requirements.md   # Spec quality checklist
└── tasks.md             # Phase 2 output (/speckit-tasks — NOT created here)
```

### Source Code (repository root)

This feature edits existing files across the monorepo; it adds no new source tree.

```text
agents/movie-assistant/
├── pyproject.toml           # lower-bound deps (may raise a floor if a transitive fix needs it)
├── uv.lock                  # P1 Python bumps land here (uv lock --upgrade-package)
└── Dockerfile               # P2 non-root USER (python:3.13-slim / Debian adduser)

mcp-servers/{movie-mcp,spreadsheet-mcp,web-api-mcp}/
├── uv.lock                  # (audited but P1 advisories are in the agent layer)
└── Dockerfile               # P2 non-root USER (python:3.13-slim / Debian adduser)

frontend/mcm-app/Dockerfile  # P2 non-root USER (node:alpine / BusyBox adduser)

pnpm-lock.yaml               # P1 JS runtime bumps (form-data, hono, undici) via override/update
package.json                 # pnpm.overrides block if transitive pinning is needed
pnpm-workspace.yaml          # P3 pnpm supply-chain policy (minimum-release-age / trust)
.npmrc                       # P3 npm minimum-release-age
Cargo.lock                   # P1 Rust bump (crossbeam-epoch) via cargo update -p

.forgejo/workflows/{guardrails,app-ci,cd-deploy,renovate}.yml  # P3 SHA pins + run: triage
renovate.json                # P3 minimumReleaseAge

security/sast/allowlist.yaml # burn-down: delete each remediated finding's entry (all slices)
docs/proposals/sast-sca-hardening-backlog.md   # keep in sync as items clear
```

**Structure Decision**: No new structure. The change surface is (a) three lockfiles + two manifests for dependency bumps, (b) five Dockerfiles for non-root hardening, (c) four workflow files + three package-manager configs for CI supply-chain, and (d) the single `security/sast/allowlist.yaml` which every slice edits (delete-on-fix). `infrastructure-as-code` owns the `sast`/`dast` Nx targets that validate the work.

## Complexity Tracking

| Violation | Why Needed | Simpler Alternative Rejected Because |
|-----------|------------|-------------------------------------|
| TDD checkpoint shape adapted (re-scan + gate-green instead of a new failing unit test) | This is a dependency/config remediation feature with **no new application behavior** to test-drive. The authentic RED→GREEN is: the finding is present and its allowlist entry is required (RED), then after the fix the finding is absent and the entry is deleted with the gate still green (GREEN). | Writing a bespoke unit test per CVE would test the upstream library, not our code — false confidence. The SAST scan IS the executable specification here; the existing suites already guard functional regression from the bumps. |
