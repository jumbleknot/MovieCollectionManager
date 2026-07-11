# Quickstart: Validate the SAST/SCA Baseline Burn-Down

Run guide proving each remediation slice actually cleared its findings and the gate stays green with a smaller allowlist. Details of the fixes live in [research.md](./research.md); the finding/allowlist model is in [data-model.md](./data-model.md).

## Prerequisites

- `uv sync` in `agents/movie-assistant/` (pip-audit audits the **installed** venv, not the requirements file — feature-033 lesson).
- Node + pnpm workspace installed (`pnpm install`).
- Rust toolchain for `cargo audit`.
- Set `NO_COLOR=1` when the scanner runs uv under Node (feature-033 lesson).
- **Authoritative scan runs on Linux/CI file discovery** — local Windows is indicative only (Semgrep file discovery differs by platform). The CI `sast` job in `.forgejo/workflows/guardrails.yml` is the source of truth.

## Full scan + gate (the acceptance harness)

```bash
# Run all four scanners → security/sast/reports/findings.json (+ SARIF/summary)
pnpm nx sast infrastructure-as-code
#   equivalently: node scripts/sast-scan.mjs --scope full

# Apply the allowlist and fail on any un-allowlisted blocking finding
node scripts/check-sast-findings.mjs
#   exit 0 = green (gate passes)
```

## Per-slice validation

### P1 — runtime dependency CVEs

```bash
# Python (agent layer)
cd agents/movie-assistant && uv lock --upgrade-package aiohttp --upgrade-package cryptography \
  --upgrade-package langchain --upgrade-package langchain-anthropic --upgrade-package langsmith \
  --upgrade-package pydantic-settings --upgrade-package starlette && uv sync && cd -
uv run --with pip-audit pip-audit    # each targeted advisory must be ABSENT
pnpm nx test movie-assistant         # (or the agent pytest target) — no regression

# JS (root workspace) — add pnpm.overrides floors if transitive parents cap the fix
pnpm install && pnpm audit           # form-data / hono / undici(6.x) advisories ABSENT
pnpm nx test mcm-app                 # unit; then the web E2E regression below

# Rust
cargo update -p crossbeam-epoch --precise 0.9.20
cargo audit                          # RUSTSEC-2026-0204 ABSENT
pnpm nx test mc-service
```

Then delete the corresponding `pip-audit` / `pnpm-audit` / `cargo-audit` entries from `security/sast/allowlist.yaml` and re-run the gate → still green.

### P2 — non-root containers

```bash
pnpm nx build mcm-app          # rebuild BFF image with USER
pnpm nx up-agents-prod infrastructure-as-code   # rebuild agent gateway + MCP images
# Confirm each container starts and serves; then the E2E below.
```

Re-scan → `dockerfile.security.missing-user` fires zero times for the five files → delete its allowlist entry.

### P3 — CI/CD supply-chain

```bash
# After SHA-pinning actions and adding release-age config:
npx --yes renovate-config-validator renovate.json   # config still valid
# Push the branch; the workflows must resolve + run green (a bad SHA fails at action resolution).
```

Re-scan → `github-actions-mutable-action-tag` and `minimum-release-age` cleared; each `run-shell-injection` step is either cleared (refactored) or retained with a specific justification. Delete cleared entries.

### P4 — dev/build-only bumps (opportunistic, non-blocking)

```bash
pnpm update   # via overrides where a transitive floor is needed
cargo update -p quick-xml
pnpm nx run-many --targets=test,lint && pnpm nx test mc-service
```

Re-scan warning set shrinks; no allowlist bookkeeping (these are warnings).

## End-to-end regression (required — real user path)

```bash
# Rebuild any changed container FIRST (stale image = meaningless E2E), then:
pnpm nx e2e mcm-app                 # web E2E regression (required for every feature)
pnpm nx e2e:mobile mcm-app          # containerized agent E2E (P2 touches gateway + BFF images)
```

## Done / success signals

- `node scripts/check-sast-findings.mjs` exits 0 on the **CI** scan (SC-001).
- `security/sast/allowlist.yaml` blocking-entry count is materially below the 55-blocking baseline (SC-006); residual = documented false-positives/accepted-risks + any recorded carried-forward debt.
- Web E2E + agent E2E pass after container + JS changes (SC-007); agent/JS/mc-service suites pass (SC-008).
