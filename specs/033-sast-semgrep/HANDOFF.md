# Feature 033 — SAST & SCA Static Security Scanning — Implementation Handoff

**For the fresh session picking up implementation.** Spec → clarify → plan → tasks → analyze are all DONE and committed on branch `033-sast-semgrep`. No code written yet. Start with `/speckit-implement` (or work `tasks.md` manually, TDD).

## Read first (in order)

1. [tasks.md](tasks.md) — 31 tasks, TDD-ordered, this is your worklist.
2. [plan.md](plan.md) — HOW: tech choices, `security/sast/` layout, Constitution Check (PASS).
3. [research.md](research.md) — the 8 decisions you must implement to (tool invocations, severity map, scope classification, CI caching, keyless fail-closed).
4. [data-model.md](data-model.md) — Finding / Allowlist / Severity-Mapping / Custom-Rule schemas.
5. [contracts/](contracts/) — `findings.schema.json`, `allowlist.schema.json`, and the gate + orchestrator CLI contracts (flags, exit codes, `--selftest` scenarios). Build to these exactly.
6. [spec.md](spec.md) — WHAT/WHY, FR-001…FR-021, SC-001…SC-011, Clarifications.
7. `.claude` memory `project_mcm_033_sast_semgrep` — the condensed decision set.

## What this is

Add static (at-rest) security scanning mirroring the **feature-031 DAST harness**. Four keyless scanners → one normalization layer → one `findings.json` → one gate → one blocking `sast` CI job. **Study the 031 files before writing anything** — you are cloning their shape:

- `scripts/zap-scan.mjs` → model for `scripts/sast-scan.mjs` (orchestrator; arg parsing, report writing, `scrubSecretsInText`).
- `scripts/check-dast-findings.mjs` → model for `scripts/check-sast-findings.mjs` (gate; allowlist load/validate, `--selftest`, exit 0/1/2).
- `scripts/__tests__/check-dast-findings.test.mjs` → model for the gate test (`node:test`, subprocess-invokes the CLI).
- `security/zap/allowlist.yaml` + `README.md` → models for `security/sast/`.
- `infrastructure-as-code/project.json` `dast` target → model for the `sast` target.
- `.forgejo/workflows/guardrails.yml` `agent-gates` job → model for the `sast` job (corepack + uv installer steps to copy).

## MVP-first delivery (recommended checkpoints)

1. **US1 (T001–T018) = local scan MVP.** Land as its own commit; validate `pnpm nx sast infrastructure-as-code` produces a consolidated report locally BEFORE touching CI.
2. **US2 (T019–T024) = blocking CI gate.** This is where the risk is (new Rust toolchain in guardrails). Seed the baseline allowlist (T023) so `main` stays green.
3. **US3 (T025–T027) = allowlist expiry/suppression.**
4. **Polish (T028–T031).**

## Non-obvious gotchas (will bite you)

- **Rust is the ONE new toolchain in guardrails.** `cargo-audit` install + advisory-DB fetch is the heaviest CI step — cache `~/.cargo/bin/cargo-audit` + `~/.cargo/advisory-db` with a **monthly** rotation key (fresh advisories, cache-hit installs). Node/pnpm/uv steps already exist in `agent-gates` — copy them verbatim.
- **SCA runs FULL every time** (can't path-gate — a new advisory hits an unchanged dep). **Semgrep** is full-tree for baseline, `--scope changed` (git diff vs base) on PRs.
- **Dependency scope drives blocking, not just severity.** `blocking = severity∈{High,Critical} AND (kind==sast OR scope==runtime)`. Runtime-vs-dev computed via `cargo tree --edges no-dev`, `pnpm audit --prod`, `uv export --no-dev`. Compute `blocking` in the orchestrator (T015), NOT the gate.
- **Keyless & fail-CLOSED.** Registry/advisory fetch failure must FAIL the scan (exit 1), never green-light. No `SEMGREP_APP_TOKEN`, no account. Semgrep via `uvx semgrep@<pin>`.
- **`p/secrets` stays OFF** — `secret-scan.mjs` owns credential detection. Do not double-gate.
- **Unscored known-vuln advisory → normalize to High** (conservative). Unmapped native severity → orchestrator fails fast (no silent Low).
- **mc-service (Rust) JWT-logging is NOT covered** by Semgrep (Rust out of scope). `mcm-no-jwt-payload-tracing` is TS/JS + Python only — don't try to make it scan Rust.
- **Custom-rule severity is per-rule:** leak/auth-ordering rules = `ERROR`/High (block); `console.*`-in-bff hygiene = `WARNING`/Medium (warn). Each rule ships `semgrep --test` fixtures (`ruleid:`/`ok:`).
- **Baseline seeding:** run `sast-scan.mjs --emit-allowlist`, triage every current finding with a real `justification`/`addedBy`, commit as `security/sast/allowlist.yaml` (FR-012 / SC-006) — otherwise the first CI run blocks every PR.
- **No app-behavior E2E for this feature.** No app code / no deployed container → the CLAUDE.md "web E2E for every feature" rule is documented N/A in plan.md (same as 031/023). Validation = gate `--selftest` + `node --test` + `semgrep --test` + the demonstration PR.

## Repo facts (verified)

- pnpm-lock.yaml at repo root; `packageManager: pnpm@10.33.0` (corepack).
- Rust: single workspace, root `Cargo.lock`, member `backend/mc-service`. Clippy = `pnpm nx lint mc-service`.
- Python agent layer: `agents/movie-assistant/` (uv, `uv.lock`, `pyproject.toml`); lint = `pnpm nx lint movie-assistant` (`uv run ruff check . && uv run mypy src`).
- Gate scripts are plain `.mjs` wired as `nx:run-commands` targets in `infrastructure-as-code/project.json`; tests run via `node --test`.
- guardrails.yml jobs today: `secret-scan`, `naming`, `agent-gates` (ubuntu-latest, no path filters). Add `sast` alongside.

## CI / PR process

- Open the PR to the **Forgejo `origin`** (NOT the GitHub mirror) — only `origin` runs `guardrails`/`app-ci`. The mirror runs no CI. PR-creation + CI-monitor details are in CLAUDE.md ("Opening PRs" / "Driving CI/CD to green") and private memory `reference_mcm_ci_monitor_access`.
- Branch protection requires `guardrails*` (glob) — the new `sast` job is auto-covered once it's in guardrails.yml.
- **Forgejo shows no per-step logs.** If the `sast` job fails in CI, reproduce locally; instrument via host paths (this is exactly how 031's DAST CI was debugged — see `project_mcm_031_dast_zap_scanning` memory).
- **RTK** must be active before starting (`rtk gain` > 80%). Never grep RTK-compressed test output for pass counts — check exit codes.

## First concrete action

`/speckit-implement` → it will start at T001 (create `security/sast/` tree). Or manually: `git status` to confirm you're on `033-sast-semgrep`, then T001. Commit after each task or logical group.
