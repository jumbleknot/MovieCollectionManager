# Implementation Plan: Keep E2E Secrets Off the Test-Runner Command Line

**Branch**: `027-ci-maestro-secrets` | **Date**: 2026-07-05 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `specs/027-ci-maestro-secrets/spec.md`

## Summary

The mobile agent E2E flows are launched with their secrets expanded onto the Maestro command line
(`maestro test … --env E2E_TEST_PASSWORD="$E2E_TEST_PASSWORD" --env ANTHROPIC_API_KEY=… --env TMDB_API_KEY=…`),
so the live values are readable in the process list on the shared homelab CI runner. The secrets are
already present in the CI job's environment; the only leak is the `--env` re-serialisation onto argv.

**Technical approach**: Introduce a single reusable wrapper (`scripts/maestro-run.sh`) that hands the
secrets to Maestro via **`MAESTRO_`-prefixed environment variables** — Maestro's native, argv-free
ingestion channel — and calls `maestro test <flow>` with no secret on the command line. The CI runner
script and the dev-facing docs are repointed to the wrapper; a new keyless guard
(`scripts/check-no-argv-secrets.mjs`) wired into `guardrails.yml` fails the build if any in-scope file
reintroduces a `--env <credential>=` argument. Historical `specs/0NN/**` records are allowlisted.

Research confirmed Maestro strips the prefix in-flow: shell `MAESTRO_E2E_TEST_PASSWORD` → `${E2E_TEST_PASSWORD}`
inside the flow, so existing flow-body references are unchanged — only header comments and invocations change.

## Technical Context

**Language/Version**: Bash (POSIX sh, wrapper + CI script); Node.js ≥ 22 ESM (guard, matching the
existing `scripts/*.mjs` gates). No application code changes.

**Primary Dependencies**: Maestro CLI (mobile test runner; `MAESTRO_`-prefixed env ingestion). Node
built-ins only for the guard (`node:child_process` `git ls-files`, `node:fs`) — modeled on
`scripts/secret-scan.mjs` / `scripts/check-no-inline-secrets.mjs`.

**Storage**: N/A. Dev credentials read from a gitignored `frontend/mcm-app/.env.e2e.local`
(already matched by the `.gitignore` `*.env.*` rule).

**Testing**: Guard self-test (`--selftest`, plant → detect, clean → pass) as the RED/GREEN unit
surface; the mobile agent-flow suite (`scripts/ci-mobile-agent-flows.sh` via the wrapper) as the
behavioral proof; a `ps`/`/proc` inspection assertion for the no-argv-secret outcome (SC-001).

**Target Platform**: Self-hosted Forgejo Actions `act_runner` (homelab, shared host) + developer
machines (Windows PowerShell / POSIX bash). The Maestro run itself targets the Android emulator.

**Project Type**: CI/test tooling + repo-wide guardrail. No frontend/backend runtime surface.

**Performance Goals**: N/A (guard runs in the existing sub-5-min guardrails job; wrapper adds
negligible startup).

**Constraints**: No secret on argv (top-level or child process); fail-clean when a required secret is
unset (no `:-literal` / `?? 'literal'` fallback); no secret committed to git; existing inline-secret +
secret-scan gates stay green; historical `specs/0NN/**` not rewritten and allowlisted by the guard.

**Scale/Scope**: 1 new wrapper script, 1 new guard script + guardrails wiring, 1 CI runner-script
edit, ~32 active mobile flow-file header-comment edits (confirmed by grep at tasks time), ~3 current
doc edits (runbooks, `CLAUDE.md`, `docs/MCM-Testing-Strategy.md`).

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

| Principle | Assessment |
|---|---|
| **Secrets Management (§Data Protection)** | ✅ Directly advances it. Secrets move from argv (readable via `ps`) to the process environment; no new at-rest secret; no literal fallback; dev creds sourced from a gitignored `*.env.*`. |
| **Environment & Secret Files** | ✅ Uses env vars (Maestro's `MAESTRO_` channel), not source/config literals. `.env.e2e.local` is gitignored. |
| **Monorepo Build Tool (Nx primary)** | ⚠️ Deviation — justified. `maestro test <flow>` is already the constitution/CLAUDE-sanctioned non-Nx call (`e2e:mobile` has no single-flow passthrough). The wrapper is a thin argv-safety shim around that same permitted call; it does not introduce a new primary build path. Recorded in Complexity Tracking. |
| **Behavior-Descriptive Identifiers** | ✅ `maestro-run.sh`, `check-no-argv-secrets.mjs` describe behavior; no `FR-`/`SC-` in names (traceability in header comments). |
| **TDD (NON-NEGOTIABLE)** | ✅ Guard ships with a `--selftest` (plant a `--env SECRET=` line → detect; clean tree → pass) authored/verified RED before the guard logic; behavioral GREEN via the flow suite + `ps` assertion. |
| **AI Assistant — Documentation** | ✅ Repoints the ~14 flow headers + 3 live docs to the sanctioned path; header comments carry the requirement-ID provenance. |
| **Test Type Integrity / Platform Parity** | ✅ Tooling feature, no user-facing scenario; the Platform Parity Table in tasks.md marks scenarios N/A with justification (the leak is mobile-runner-only; web Playwright passes secrets via `-e NAME` process env, not argv — out of scope). |

**Result**: PASS with one documented, pre-existing-sanctioned deviation (Nx). No unjustified violations.

## Project Structure

### Documentation (this feature)

```text
specs/027-ci-maestro-secrets/
├── plan.md              # This file
├── research.md          # Phase 0 output
├── data-model.md        # Phase 1 output (config artifacts, not domain entities)
├── quickstart.md        # Phase 1 output (validation guide)
├── contracts/
│   ├── maestro-run.md       # wrapper CLI contract
│   └── argv-secret-guard.md # guard contract (inputs, allowlist, exit codes)
├── checklists/
│   └── requirements.md  # spec quality checklist (from /speckit-specify)
└── tasks.md             # /speckit-tasks output (NOT created here)
```

### Source Code (repository root)

```text
scripts/
├── maestro-run.sh                 # NEW — sanctioned argv-free flow runner (MAESTRO_-prefix shim)
├── ci-mobile-agent-flows.sh       # EDIT — run_flow() drops --env secrets, calls maestro-run.sh
├── check-no-argv-secrets.mjs      # NEW — keyless guard (selftest + scan), allowlists specs/0NN/**
├── secret-scan.mjs                # REFERENCE — model the new guard on this
└── check-no-inline-secrets.mjs    # REFERENCE — --selftest + scan shape, guardrails wiring

.forgejo/workflows/
└── guardrails.yml                 # EDIT — add the argv-secret guard step (naming job, keyless)

frontend/mcm-app/tests/e2e/mobile/
└── *.yaml                         # EDIT (headers only) — ~14 active flows: repoint "# Run:" comment

docs/runbooks/android-emulator.md  # EDIT — repoint invocation snippets
docs/MCM-Testing-Strategy.md       # EDIT — repoint single-flow snippet
CLAUDE.md                          # EDIT — repoint the "maestro test … --env" example
frontend/mcm-app/.env.e2e.local    # DEV-ONLY (gitignored) — documented, not committed
```

**Structure Decision**: Repo-root `scripts/` + `.forgejo/workflows/` + the active mobile flow dir.
This is CI/test infrastructure, so it lives outside the frontend/backend `src/` trees, matching the
existing `scripts/*.mjs` guardrail + `scripts/ci-*.sh` runner conventions. Historical `specs/0NN/**`
are deliberately excluded (allowlisted) per the clarification.

## Complexity Tracking

| Violation | Why Needed | Simpler Alternative Rejected Because |
|-----------|------------|-------------------------------------|
| Non-Nx invocation (`scripts/maestro-run.sh` wrapping `maestro test`) | `e2e:mobile` Nx target runs the whole dir with no single-flow passthrough; per-flow runs (with retry/rate-limit handling) are already a sanctioned direct `maestro test` call. The wrapper only makes that existing call argv-safe. | An Nx target per flow would duplicate the runner loop and still shell out to `maestro`; it adds a build-graph node without removing the argv exposure. A temp env-file sourced into the wrapper adds a file + cleanup trap for no gain over the `MAESTRO_` env channel. |
