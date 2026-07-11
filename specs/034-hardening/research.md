# Phase 0 Research: SAST/SCA Baseline Hardening

Resolves the "HOW" mechanics for each remediation slice so `/speckit-tasks` can decompose deterministically. No open NEEDS CLARIFICATION remain.

## R1 — Python runtime CVE bumps (agent layer, `uv.lock`)

**Decision**: Bump each flagged package with `uv lock --upgrade-package <pkg>` run in `agents/movie-assistant/` (the pip-audit target audits the **installed venv**, so `uv sync` after re-lock is mandatory before re-scanning — feature-033 lesson `NO_COLOR=1` when uv runs under Node). All seven targets (`aiohttp`, `cryptography`, `langchain`, `langchain-anthropic`, `langsmith`, `pydantic-settings`, `starlette`) are **transitive** — none is a direct entry in `pyproject.toml` except `langchain-anthropic` (direct, `>=0.3`). For transitive packages, `--upgrade-package` bumps the locked version without a manifest edit; only if a direct parent's constraint blocks the fixed version is a `pyproject.toml` floor raise needed.

**Rationale**: Lockfile-targeted upgrades keep the change minimal and reproducible, honor the constitution's "pinned via lockfile" rule, and avoid over-widening the dependency graph. `uv sync --frozen` in the Dockerfiles then materializes the fixed versions into the image.

**Alternatives considered**: (a) `uv lock --upgrade` (whole-graph) — rejected: sweeps unrelated packages, noisy review, higher regression surface. (b) Adding direct pins for transitive packages — rejected: pollutes `pyproject.toml` with transitive concerns; the lock is the right pin surface.

**Validation**: `uv sync` then re-run pip-audit portion; each targeted advisory must be absent. Run `pytest` (agent unit + leak_scan) to confirm no behavioral regression — LangChain 1.3.4→1.3.9 and starlette 1.2.1→1.3.1 are the highest-risk (framework-level); watch for API drift.

## R2 — JS runtime CVE bumps (`pnpm-lock.yaml`)

**Decision**: `form-data`, `hono`, and the runtime `undici` (6.x) are transitive. Prefer `pnpm update <pkg> --recursive` to pull the fixed minor within existing ranges; if a parent range caps below the fix, add a **`pnpm.overrides`** entry in the root `package.json` (e.g. `"undici@<6.27.0": ">=6.27.0"`, `"form-data": ">=4.0.6"`, `"hono": ">=4.12.25"`). Re-run `pnpm install` to update the lock, then `pnpm audit`.

**Rationale**: `pnpm.overrides` is the supported, surgical mechanism for forcing a transitive floor without forking a direct dependency. It is lockfile-visible and reviewable. The runtime `undici` (6.x) is distinct from the dev `undici` (7.x, P4) — the override must be version-scoped so it does not disturb the 7.x copy.

**Alternatives considered**: Full `pnpm update` — rejected (noise/regression). Waiting for Renovate — rejected: this feature IS the one-time catch-up; Renovate owns steady-state after.

**Validation**: `pnpm audit` shows the three advisories gone from the runtime scope; JS unit tests + the web E2E regression pass (these libraries sit under the BFF/Expo server request path).

## R3 — Rust transitive bump (`Cargo.lock`)

**Decision**: `cargo update -p crossbeam-epoch --precise 0.9.20` (or the latest ≥0.9.20 that resolves) from repo root. Purely transitive; no `Cargo.toml` edit.

**Rationale**: `cargo update -p` is the canonical transitive-only lockfile bump; `--precise` keeps the change to exactly the advisory fix. cargo-audit then reports RUSTSEC-2026-0204 cleared.

**Alternatives considered**: `cargo update` (whole-lock) — rejected (noise). Yanking to a direct dep — rejected (crossbeam-epoch is not ours to own directly).

**Validation**: `cargo audit` clean for RUSTSEC-2026-0204; `pnpm nx test mc-service` green.

## R4 — Non-root container `USER` (5 Dockerfiles)

**Decision**: Two base-image families, two idioms — mirror `backend/mc-service` intent (create a system user, own the writable paths, `USER` before `CMD`):

- **`frontend/mcm-app/Dockerfile`** (`node:24.14.1-alpine3.23`, BusyBox): in the `runner` stage, `RUN addgroup -S mcm && adduser -S mcm -G mcm && chown -R mcm:mcm /app/runtime`, then `USER mcm` before `CMD ["node","server.js"]`. Node writes nothing outside `/app/runtime` at runtime (PORT/NODE_ENV only); no cache dir needed.
- **The four `python:3.13-slim` images** (agent gateway + 3 MCP; Debian): in the `runtime` stage, `RUN groupadd --system app && useradd --system --gid app --no-create-home app` then either `COPY --from=build --chown=app:app /app /app` or a `chown -R app:app /app` after copy, then `USER app` before `CMD`. The `.venv` on `PATH` is read-only at runtime; MCP/uvicorn processes bind a port and read code — no writable state on disk. Confirm no library writes a cache under `/app` (e.g. HF/torch caches) — if any does, point it at `/tmp` via env, which is world-writable.

**Rationale**: Non-root drops blast radius with zero functional change on the existing trusted network. The `--chown` on `COPY` is cheaper than a post-copy `chown -R` for the Python images (single layer, correct ownership at copy time). Alpine `adduser -S` vs Debian `useradd --system` is the only per-family difference.

**Alternatives considered**: A shared base image with a baked-in user — rejected: over-engineering for five leaf Dockerfiles; diverges from the per-service Dockerfile constitution rule. Running as root with a seccomp/cap-drop compose profile — rejected: doesn't clear the `dockerfile.security.missing-user` finding (the gate checks the Dockerfile, not runtime), and USER is the direct fix.

**Validation**: Rebuild each image; start it; confirm the service serves (BFF via web E2E; agent gateway + MCP via the containerized agent E2E). Re-scan: `dockerfile.security.missing-user` fires zero times for these files → delete the shared allowlist entry (or narrow if any image legitimately can't drop root).

**Edge**: If a Python process needs to write (e.g. a lockfile, a runtime download), correct ownership in the build rather than reverting to root. `web-api-mcp` is outbound-only (TMDB) — no inbound bind concern.

## R5 — Pin actions to commit SHAs (`.forgejo/workflows/*.yml`)

**Decision**: For every third-party action reference (`actions/checkout`, `pnpm/action-setup`, `actions/setup-node`, `astral-sh/setup-uv`, `actions/upload-artifact`, `dorny/paths-filter`, `docker/*`, …), replace `@vX` / `@vX.Y.Z` with the full 40-char commit SHA the tag currently resolves to, appending `# vX.Y.Z` as a trailing comment for human readability (the GitHub-recommended and Semgrep-`github-actions-mutable-action-tag`-clearing form). Resolve each SHA via the action's upstream repo (`git ls-remote https://github.com/<owner>/<repo> refs/tags/<tag>` for the tag's commit, or the release page). Local/composite actions (path-referenced) are exempt — record the exemption in the allowlist justification if any remains.

**Rationale**: A mutable tag can be force-repointed by a compromised upstream; a SHA is immutable. Trailing-version comment preserves reviewability and lets Renovate's `github-actions` manager still bump it (Renovate updates the SHA and the comment together). This is the exact pattern the Semgrep rule wants and clears all ~40 findings.

**Alternatives considered**: Trust `@vX` + rely on Renovate digest pinning — rejected: the finding stays; tags remain mutable between Renovate runs. Vendoring actions — rejected (heavy, maintenance burden).

**Validation**: Re-scan → `github-actions-mutable-action-tag` zero findings (minus documented exemptions). Push the branch → the workflows still resolve and run green (a bad SHA fails fast at action resolution).

## R6 — Release-age cooldowns (Renovate / pnpm / npm)

**Decision**:
- **`renovate.json`**: add top-level `"minimumReleaseAge": "3 days"` (a conservative cooldown; Renovate holds a PR until the release is ≥3 days old, mitigating the compromised-just-published-release window). Clears the `minimum-release-age` Semgrep finding on `renovate.json`.
- **`pnpm-workspace.yaml`**: add `minimumReleaseAge` (pnpm ≥10 supports `minimumReleaseAge`/`minimumReleaseAgeExclude`) and consider `onlyBuiltDependencies` trust policy; the `pnpm-block-exotic-sub-dependencies` finding is addressed by ensuring no git/http protocol sub-deps are allowed (pnpm 10 blocks these by default — document if a policy key is added).
- **`.npmrc`**: `.npmrc` is used only for the Android build workaround here (no runtime npm install), but add `minimum-release-age` to clear `npm-missing-minimum-release-age` where the toolchain honors it; if npm/pnpm ignores it harmlessly, it still clears the static finding.

**Rationale**: These are Medium, non-blocking findings — the gate doesn't fail on them — but they are cheap policy hardening that ties into the P1 bump workflow and are documented as SHOULD in the spec. Adding the config keys clears the static findings and improves supply-chain posture.

**Alternatives considered**: Ignore (non-blocking) — rejected: cheap to fix, aligns with the "materially smaller allowlist" success criterion (these are Medium/warning so not allowlisted, but clearing them removes scanner noise). Aggressive 14-day cooldown — rejected: too slow for security patches themselves; 3 days balances.

**Validation**: Re-scan → `minimum-release-age` / `pnpm-minimum-release-age` / `npm-missing-minimum-release-age` cleared. Renovate config validity: `npx --yes renovate-config-validator renovate.json` (Renovate ships a validator).

## R7 — Triage `run-shell-injection` (6 findings, `app-ci.yml` + `cd-deploy.yml`)

**Decision**: For each flagged `run:` step, classify the interpolated `${{ … }}` value:
1. **GitHub/Forgejo context that is attacker-controllable on `pull_request`** (`github.event.*.title/body/ref`, PR head branch names) → **refactor**: move the value into a step `env:` block and reference `"$VAR"` in the shell (quoted). This is the canonical GitHub-documented mitigation.
2. **Trusted internal job output / secret / fixed repo var** (a prior step's `outputs`, `secrets.*`, `vars.*`, `github.sha`) → **retain** with a per-step allowlist justification naming the specific value and why it is not PR-controllable. Replace the current generic baseline justification.

Enumerate all six, decide per-step, and split the outcome: refactored steps clear the finding (delete entry); retained steps get a specific justification (keep entry).

**Rationale**: Not every `run-shell-injection` hit is exploitable — the rule flags any `${{ }}`-in-`run:`. The security-meaningful ones are attacker-controllable inputs; those get the `env:` refactor. Blindly refactoring trusted internal outputs adds churn without security value, so those are documented-accepted with specificity (satisfies SC-005: no generic baseline justification remains).

**Alternatives considered**: Refactor all six uniformly — rejected: over-churns trusted steps and can break intended interpolation (e.g. a matrix value). Leave all allowlisted — rejected: SC-005 requires per-step triage, not a blanket entry.

**Validation**: Re-scan; refactored steps produce no finding; retained steps each have a specific justification. Workflows still run green.

## R8 — Dev/build-only bumps (P4, non-blocking)

**Decision**: Opportunistically `pnpm update` the dev copies (`undici` 7.x, `vite`, `ws`, `minimatch`, `picomatch`, `http-proxy-middleware`, `esbuild`, `tmp`) via overrides only where a transitive floor is needed; `cargo update -p quick-xml` for the Rust dev advisory. These are warnings, not blockers — no allowlist bookkeeping. Drop any bump that disrupts a build or test (FR-008).

**Rationale**: Lowest value, non-runtime-reachable. Clearing them reduces scanner noise and keeps tooling current, but must never risk the build for a non-blocking advisory.

**Validation**: Re-scan warning set shrinks; `pnpm nx run-many --targets=test,lint` + `pnpm nx test mc-service` green.

## Cross-cutting: burn-down discipline

- **Delete-on-fix, never delete-on-hope**: an allowlist entry is deleted only after a fresh Linux/CI-equivalent scan shows the finding absent. If blocked by an upstream constraint, keep the entry and rewrite its justification to "blocked by upstream constraint: <detail>" (carried-forward debt, FR-012).
- **Scan authority = Linux/CI**: Windows Semgrep file discovery under-reports (feature-033 lesson: Windows under-reported Dockerfiles → push-scope CI fail). Validate the burn-down against the CI scan result, not only local Windows.
- **Keep the backlog doc in sync**: as items clear, check them off / annotate `docs/proposals/sast-sca-hardening-backlog.md` so it reflects reality.
- **False-positives stay**: never touch the `gcm-no-tag-length`, `bypass-tls-verification`, `logger-credential-disclosure`, `mcm-*` unit-test, or `mcm-no-console-in-bff` entries (FR-010).
