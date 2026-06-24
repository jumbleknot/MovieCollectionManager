# Contract: Workflow Trigger Matrix

Defines which workflow runs on which event, and which gate it enforces. This is the authoritative trigger contract; the YAML `on:` blocks must match this table.

| Workflow | Event | Branch scope | Path filter | Runs | Gate (must pass) |
|---|---|---|---|---|---|
| `guardrails` | push, pull_request | all | none (whole-tree for secret-scan) + path-scoped for naming/agent jobs | resource-naming gate, inline-secret gate, whole-tree secret-scan, agent lint/test/golden-replay | all green |
| `app-ci` | push, pull_request | all | `frontend/**`, `agents/**`, `mcp-servers/**`, `backend/**`, `infrastructure-as-code/**`, the workflow file | nx-affected lint/build/unit; provision env (ci-realm + gen-dev-secrets); stack up (auth→mcm); web Playwright E2E (dev-container); release APK; Maestro agent flows (per-file); artifact upload on failure | web E2E + all 4 agent flows green |
| `cd-deploy` | push | `main` only | none (deploys whatever is on main) | build 6 images → Trivy → push (tag+digest) → Komodo redeploy (all prod stacks, by digest) → health probe → rollback on fail | images published only if scan-clean; deploy converges or rolls back |

## Rules

1. **CD is `main`-gated and CI-gated.** `cd-deploy` runs only on push to `main` AND only proceeds past build if the commit's `app-ci` (and `guardrails`) succeeded. A working-branch push runs `guardrails` + `app-ci` only — never `cd-deploy` (FR-020).
2. **Fail closed.** If the runner is unavailable, no required check reports success, so branch protection blocks the merge and no deploy fires (FR-025). An absent check is not a passing check.
3. **No approval gate.** `cd-deploy` proceeds automatically on a green `main` CI signal (clarify 2026-06-23) — no `environment:` manual-approval step.
4. **Concurrency.** Each workflow uses a `concurrency` group keyed on ref with `cancel-in-progress: true` (carried over from `android-e2e.yml`) so superseded pushes don't pile up.
5. **Path filters preserve today's behavior** — the ported jobs keep the GitHub workflows' `paths:` scoping (e.g. agent gates only on `agents/**` + `mcp-servers/**`); `secret-scan` stays whole-tree (no path filter).
6. **Required status checks (branch protection on `main`)** are repointed (US4) to the `guardrails` and `app-ci` job names — never to the retired GitHub Actions checks.
