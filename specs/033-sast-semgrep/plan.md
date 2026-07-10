# Implementation Plan: SAST & SCA Static Security Scanning

**Branch**: `033-sast-semgrep` | **Date**: 2026-07-10 | **Spec**: [spec.md](spec.md)

**Input**: Feature specification from `specs/033-sast-semgrep/spec.md`

## Summary

Add static security scanning (SAST + SCA) to the repo as a config-as-code, keyless, blocking CI gate that structurally mirrors the feature-031 DAST harness. A single Node orchestrator (`scripts/sast-scan.mjs`) drives four keyless scanners — **Semgrep** (code SAST over TS/JS + Python), **cargo audit** (Rust deps), **pnpm audit** (JS deps), **pip-audit** (Python deps) — normalizes their heterogeneous output into one `findings.json` on a shared Critical/High/Medium/Low scale, and a single gate (`scripts/check-sast-findings.mjs`) applies one `security/sast/allowlist.yaml` (the baseline) and fails on any un-allowlisted High/Critical. A new blocking `sast` job in `.forgejo/workflows/guardrails.yml` runs the real scan on every push/PR (SCA always full; Semgrep full-tree for the baseline, changed-files-only on PRs). No new secret material; all four scanners run offline/anonymous against public rules and advisory data.

## Technical Context

**Language/Version**: Node.js ≥ 20 (orchestrator + gate, ES modules `.mjs`); scanners invoked as subprocesses — Semgrep (Python, via `uvx`), `cargo-audit` (Rust), `pnpm audit` (built-in), `pip-audit` (Python, via `uvx`). Custom rules authored in Semgrep YAML.

**Primary Dependencies**: Semgrep OSS CLI (pinned version, via `uvx semgrep@<pin>`); `cargo-audit` (via `cargo install --locked`); `pip-audit` (via `uvx`); pnpm 10.33.0 (`pnpm audit`, already present). YAML parsing reuses the same library `check-dast-findings.mjs` uses. No runtime app dependencies.

**Storage**: Filesystem only — native scanner reports + normalized `findings.json` + human summary + SARIF written to `security/sast/reports/` (gitignored, mirrors `security/zap/reports/`). Config-as-code under `security/sast/` is version-controlled.

**Testing**: `node --test` for the gate (`scripts/__tests__/check-sast-findings.test.mjs`) and orchestrator normalization (`scripts/__tests__/sast-scan.guard.test.mjs`), mirroring `check-dast-findings.test.mjs`; `semgrep --test` for custom-rule fixtures under `security/sast/rules/`; a committed known-vuln fixture proving SCA RED→allowlist→GREEN.

**Target Platform**: Self-hosted Forgejo Actions `act_runner` (`ubuntu-latest`) for CI; developer workstations (Windows/PowerShell + POSIX) for local runs via `pnpm nx sast infrastructure-as-code`.

**Project Type**: CI/security tooling additive to the existing web + mobile + backend monorepo. Touches **no application code** (no BFF, frontend, mc-service, or agent-runtime source) — same class of change as features 031 (DAST) and 023 (CI).

**Performance Goals**: PR-time `sast` job target ≤ ~8 min wall-clock: Semgrep affected-scoped on PRs; SCA scanners run full but are fast (advisory lookups); the heaviest cost is one-time `cargo-audit` install + advisory-DB fetch, both cached.

**Constraints**: Keyless (no account/license/SaaS, no new CI secret); fail-fast on missing toolchain or unreachable advisory data (never silent-skip a language); reports must not leak incidental secrets; must not collide with the existing `secret-scan` gate's ownership of credential detection.

**Scale/Scope**: Two code surfaces (TS/JS tree, Python agent layer) + three dependency graphs (root `Cargo.lock`, root `pnpm-lock.yaml`, `agents/movie-assistant/uv.lock`). Handful of custom Semgrep rules at v1.

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

| Principle | Assessment |
|---|---|
| **AI Assistant Constraints — Behavior-Descriptive Identifiers** | PASS. All artifacts named for behavior, not spec IDs: `sast-scan.mjs`, `check-sast-findings.mjs`, custom rule IDs like `mcm-no-token-logging`, `mcm-auth-before-authz`. FR/SC IDs appear only in traceability comments. |
| **AI Assistant Constraints — Spec/Plan separation** | PASS. spec.md stays tech-agnostic (tools confined to its Assumptions); this plan.md owns the concrete tool choices. |
| **Security — Secrets Management** | PASS & reinforcing. Introduces zero secret material (FR-017); the `secret-scan` gate remains the sole credential detector (FR-006); reports are secret-scrubbed (FR-018), reusing the DAST scrub approach. |
| **Security posture (defense in depth)** | PASS & reinforcing. Adds a static-analysis layer complementing DAST (031) and secret-scan; enforces existing house invariants (no token logging, auth-before-authz) as automated lints. |
| **Test-First (TDD)** | PASS. Gate logic, orchestrator normalization, and every custom rule ship with tests; the gate exposes `--selftest`; a known-vuln fixture proves the SCA path. Tests precede implementation per the tasks phase. |
| **Centralized Access Control / handler-default-protection** | N/A. No request handlers or auth code added. |
| **No inline secrets in compose / argv** | PASS. No compose or credential changes; existing `check-no-argv-secrets`/`check-no-inline-secrets` gates unaffected. |
| **Prod/CI port isolation (029)** | N/A. Static scanning publishes no host ports and brings up no stack. |

**Result: PASS — no violations.** Complexity Tracking table left empty.

One documented scope note (not a violation): the project's Final Validation Checklist mandates a web-E2E regression for *every* feature "including backend-only". This feature changes **no application code and no deployed container** — it adds only CI scripts, security config, and a workflow job (identical in kind to features 031 and 023, which also added no app source and did not require an app-behavior E2E). The equivalent end-to-end proof here is the gate's own test suite + `--selftest` + a demonstration PR that trips and then allowlists a finding (SC-002/003/005). This rationale is recorded here for the tasks phase and Final Validation.

## Project Structure

### Documentation (this feature)

```text
specs/033-sast-semgrep/
├── plan.md              # This file
├── research.md          # Phase 0 — tool-invocation, severity-mapping, scope-classification decisions
├── data-model.md        # Phase 1 — Finding / Allowlist Entry / Severity Mapping / Custom Rule schemas
├── quickstart.md        # Phase 1 — run locally, gate, triage, rule-test guide
├── contracts/           # Phase 1 — findings.json schema, allowlist schema, gate + orchestrator CLI contracts
│   ├── findings.schema.json
│   ├── allowlist.schema.json
│   ├── sast-scan.cli.md
│   └── check-sast-findings.cli.md
└── tasks.md             # Phase 2 — /speckit-tasks (NOT created here)
```

### Source Code (repository root)

```text
security/sast/                      # config-as-code (mirrors security/zap/)
├── semgrep.yaml                    # Semgrep run config: community pack refs + include of rules/
├── rules/                          # custom MCM Semgrep rules + inline test fixtures
│   ├── mcm-no-console-in-bff.yaml
│   ├── mcm-no-token-logging.yaml
│   ├── mcm-auth-before-authz.yaml
│   ├── mcm-no-jwt-payload-tracing.yaml
│   └── *.test.* fixtures           # semgrep --test annotated insecure/safe pairs
├── allowlist.yaml                  # THE baseline — normalized findings suppressed from the gate
├── severity-map.yaml               # documented native→normalized mapping per scanner (data, not code)
├── reports/.gitkeep                # gitignored scanner output (findings.json, *-native.json, sarif, summary)
└── README.md                       # modes, surfaces, report formats, triage workflow

scripts/
├── sast-scan.mjs                   # orchestrator: run 4 scanners → normalize → findings.json + summary + sarif
├── check-sast-findings.mjs         # gate: load findings.json, apply allowlist, fail on un-allowlisted High/Critical; --selftest
└── __tests__/
    ├── check-sast-findings.test.mjs   # node:test — gate: allowlist hit/miss, severity, dep-scope, exit codes, selftest
    └── sast-scan.guard.test.mjs       # node:test — normalization + scope-classification + fail-fast on missing toolchain

infrastructure-as-code/project.json # + "sast" nx:run-commands target (mirrors "dast")

.forgejo/workflows/guardrails.yml   # + blocking "sast" job (node/pnpm + uv→semgrep+pip-audit + rust→cargo-audit)

docs/runbooks/sast-scanning.md      # operator runbook (mirrors dast-scanning.md)
```

**Structure Decision**: Reuse the exact feature-031 layout — a `security/<tool-family>/` config tree + a `scripts/<family>-scan.mjs` orchestrator + `scripts/check-<family>-findings.mjs` gate + `node:test` suite + an `infrastructure-as-code` Nx target + a guardrails CI job. This keeps one mental model for all static/dynamic security gates and lets maintainers reason about SAST exactly as they already do about DAST. The one structural addition over DAST is the **normalization layer** in the orchestrator (four heterogeneous scanners → one findings schema), which DAST did not need (single scanner). The gate consumes only the normalized `findings.json`, so it stays as small and testable as `check-dast-findings.mjs`.

## Complexity Tracking

> No Constitution Check violations — table intentionally empty.

## Phase 0 — Research

See [research.md](research.md). Resolves: exact per-scanner invocation + JSON output flags; the native→normalized severity mapping for each tool (incl. unscored-advisory policy); how Semgrep is affected-scoped on PRs; how runtime-vs-dev dependency scope is computed per ecosystem (`cargo tree --edges no-dev`, `pnpm audit --prod`, `uv export --no-dev`); CI toolchain provisioning + caching (cargo-audit binary, advisory DBs, Semgrep rule cache); and the keyless registry-fetch residual + mitigation.

## Phase 1 — Design & Contracts

- [data-model.md](data-model.md) — the normalized **Finding** record, **Allowlist Entry**, **Severity Mapping**, and **Custom Rule** metadata shapes, with validation rules drawn from FR-009/011/012/019/021.
- [contracts/findings.schema.json](contracts/findings.schema.json) — JSON Schema for the orchestrator's `findings.json` output (the gate's input contract).
- [contracts/allowlist.schema.json](contracts/allowlist.schema.json) — schema for `security/sast/allowlist.yaml` entries.
- [contracts/sast-scan.cli.md](contracts/sast-scan.cli.md) — orchestrator CLI (flags, outputs, exit codes, fail-fast behavior).
- [contracts/check-sast-findings.cli.md](contracts/check-sast-findings.cli.md) — gate CLI (flags, `--selftest`, exit codes).
- [quickstart.md](quickstart.md) — run the scan locally, run the gate, add an allowlist entry, run custom-rule tests.

**Post-design Constitution re-check**: PASS (unchanged — the design adds only tooling/config, preserves secret-scan ownership, keeps behavior-descriptive names, and is test-first).
