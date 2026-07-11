# Phase 0 Research: SAST & SCA Static Security Scanning

All decisions below resolve the "NEEDS CLARIFICATION"-class unknowns in the plan's Technical Context. Each is stated as Decision / Rationale / Alternatives.

## R1 — Semgrep invocation & keyless operation

**Decision**: Run Semgrep OSS via `uvx semgrep@<pinned-version> scan` (uv is already provisioned in the `agent-gates` guardrails job, so no new installer). Config = `--config security/sast/semgrep.yaml`, where `semgrep.yaml` lists community registry packs (`p/typescript`, `p/react`, `p/nodejs`, `p/python`, `p/owasp-top-ten`) **and** `--config security/sast/rules/` for the custom MCM rules. Emit both `--sarif` (for the artifact) and `--json` (for normalization) in one invocation via two output flags; never enable `p/secrets` (FR-006). No login, no `SEMGREP_APP_TOKEN` — the registry serves rules anonymously.

**Rationale**: `uvx` gives a pinned, cached, keyless Semgrep with zero extra CI setup beyond what `agent-gates` already does. Listing packs in a committed `semgrep.yaml` keeps the ruleset config-as-code and reviewable. Pinning the Semgrep version keeps rule behavior reproducible across runs.

**Alternatives considered**: (a) `semgrep/semgrep` Docker image — heavier pull, and the runner already has uv; (b) `pip install semgrep` into a venv — more steps than `uvx`; (c) vendoring rule YAML into the repo — maximal reproducibility but a maintenance burden and staleness risk; rejected for v1 in favor of pinned registry packs + a documented residual (R7).

## R2 — Semgrep affected-scoping on PRs (full baseline, changed-files on PR)

**Decision**: The orchestrator computes the scan target set. Baseline/push-to-`main` = full tree (`.` with Semgrep's own include/exclude honoring `.semgrepignore`). On a pull request = the changed files only: `git diff --name-only --diff-filter=ACMR <base>...HEAD` filtered to `.ts/.tsx/.js/.jsx/.mjs/.cjs/.py`, passed to Semgrep as explicit targets. If the changed set contains no scannable code file, the Semgrep step is a no-op (0 findings), but SCA still runs (R3). A `--scope full|changed` flag selects mode; CI passes `--scope changed` on `pull_request`, `--scope full` on `push`.

**Rationale**: Matches the clarified requirement (FR-014) and the existing `app-e2e` path-gating philosophy without depending on Semgrep's platform-tied `--diff-aware`/`semgrep ci` (which expects the SaaS baseline). Git-diff scoping is keyless and deterministic.

**Alternatives considered**: `semgrep ci` diff-aware mode — rejected (assumes Semgrep AppSec Platform baseline); scanning full tree on every PR — rejected for latency on the large TS/JS tree.

## R3 — SCA invocation per ecosystem + runtime-vs-dev scope classification

Dependency scanning always runs full (FR-013), and dependency scope decides blocking vs warn (FR-021).

**Rust (`cargo audit`)**: `cargo audit --file Cargo.lock --json` over the root workspace lockfile. Scope: compute the runtime dependency set with `cargo tree --edges no-dev --prefix none --no-dedupe` (names+versions); any advisory whose package is **not** in that set is dev/build-only → warn. cargo-audit "warnings" (unmaintained/yanked, RUSTSEC informational) normalize to Low regardless.

**JavaScript (`pnpm audit`)**: `pnpm audit --json` for the full finding set, plus `pnpm audit --prod --json` to obtain the production-only advisory set. Advisories present in the `--prod` set are runtime (blocking-eligible); the remainder are dev-only → warn.

**Python (`pip-audit`)**: export the resolved deps from uv, then audit: `uv export --frozen --no-emit-project --no-dev --format requirements-txt` → runtime set; `uv export --frozen --no-emit-project --format requirements-txt` → full set (incl. dev groups). Run `uvx pip-audit --format json -r <file>` on the full set for findings, and classify a finding as runtime if its package appears in the runtime export, else dev-only → warn.

**Rationale**: Every ecosystem exposes a first-class way to distinguish production from dev/test/build dependencies, so scope classification is pure, deterministic code in the orchestrator — no heuristics. Running the full set for *findings* (and using the runtime set only for the *blocking* decision) keeps dev-tool vulnerabilities visible (FR-021) rather than hidden.

**Alternatives considered**: `cargo-deny` (adds license/ban policy — out of scope for v1, R6); `npm audit`/`osv-scanner` (project is pnpm-only and osv-scanner adds a Go toolchain); `safety`/`osv` for Python (pip-audit is the keyless PyPA-native choice and already reachable via `uvx`).

## R4 — Native → normalized severity mapping

**Decision**: A committed `security/sast/severity-map.yaml` documents the mapping; the orchestrator applies it. The gate consumes only the already-normalized severity, so mapping changes never touch gate code.

| Scanner | Native | Normalized |
|---|---|---|
| Semgrep | `ERROR` | High |
| Semgrep | `WARNING` | Medium |
| Semgrep | `INFO` | Low |
| Semgrep (custom rules) | rule-declared `severity` | per FR-004: leak/auth rules author `ERROR`→High; hygiene rules author `WARNING`→Medium |
| cargo audit | CVSS ≥ 9.0 | Critical |
| cargo audit | CVSS 7.0–8.9 | High |
| cargo audit | CVSS 4.0–6.9 | Medium |
| cargo audit | CVSS < 4.0 | Low |
| cargo audit | advisory present, **no CVSS** | **High** (conservative, per spec edge case) |
| cargo audit | informational warning (unmaintained/yanked) | Low |
| pnpm audit | `critical` / `high` / `moderate` / `low` / `info` | Critical / High / Medium / Low / Low |
| pip-audit | advisory CVSS bands (same thresholds as cargo) | Critical / High / Medium / Low |
| pip-audit | known-vuln, **no severity** | **High** (conservative, per spec edge case) |

**Rationale**: One scale makes findings from four tools gate-comparable (FR-009). The "unscored known-vuln → High" default (FR edge case) errs toward surfacing rather than silently down-ranking. Dev-scope downgrade (R3) is applied to the *blocking* decision after normalization, not to the displayed severity.

**Alternatives considered**: Gating on each tool's native severity — rejected (four incompatible scales, four gate policies). Mapping unscored advisories to Medium — rejected as under-conservative for a security gate.

## R5 — CI toolchain provisioning & caching

**Decision**: The new `sast` job (`ubuntu-latest`) provisions three toolchains, reusing existing patterns:
- **Node/pnpm**: `corepack enable` + `pnpm install --frozen-lockfile` (as in `naming`/`agent-gates`).
- **uv** (Semgrep + pip-audit): the exact `agent-gates` uv installer step (`curl -LsSf https://astral.sh/uv/install.sh | sh`), then `uvx` invocations.
- **Rust** (`cargo audit`): ensure a Rust toolchain (`rustup`/`cargo` — install via rustup if absent), then `cargo install cargo-audit --locked`. Cache `~/.cargo/bin/cargo-audit` (binary) + `~/.cargo/advisory-db` (RustSec DB) keyed by a monthly rotation key so the DB refreshes but installs are usually a cache hit. Also cache Semgrep's rule cache (`~/.semgrep` / `~/.cache/semgrep`) and uv's cache.

**Rationale**: Rust is the one toolchain not already present in guardrails, making `cargo-audit` install the heaviest step; caching the binary + advisory DB keeps steady-state PR runs fast while a monthly key still pulls fresh advisories. Everything else reuses proven guardrails steps.

**Alternatives considered**: Running `cargo audit` in a separate job/workflow with a Rust base image — rejected to keep one required `sast` check; running SCA nightly instead of per-PR — rejected (weaker shift-left; FR-002/013).

## R6 — Scope boundaries confirmed

**Decision**: v1 detects and gates only; it does **not**: enable Semgrep secret rules (secret-scan owns credentials, FR-006); run `cargo-deny` license/ban policy (advisories only); open dependency-bump PRs (Renovate owns remediation); or scan Rust *code* with Semgrep (clippy via `nx lint mc-service` already covers Rust code patterns — Semgrep's Rust support is experimental). Rust participates only through `cargo audit` (deps).

**Rationale**: Keeps v1 focused and avoids duplicate gating; each exclusion is already owned by an existing gate or tool, or is experimental.

## R7 — Keyless residual: registry & advisory-DB availability

**Decision**: All rule/advisory data is fetched anonymously at scan time (Semgrep registry, RustSec advisory-db, npm registry advisories, PyPI/OSV). If any fetch fails, the affected scanner **fails fast** with a clear message (FR-015) rather than reporting a false clean. Mitigations: pin the Semgrep version, cache the rule + advisory DBs (R5), and document the residual (upstream outage blocks the gate) in the runbook. No secret is ever required for these fetches (FR-016/017).

**Rationale**: Fail-closed is correct for a security gate — a transient upstream outage should block-and-retry, never green-light unscanned code. Caching reduces the blast radius of upstream flakiness.

**Alternatives considered**: Fail-open on fetch error — rejected (defeats the gate). Fully offline vendored DBs — deferred (heavy maintenance; R1/R6 rationale).

## R8 — Report scrubbing & secret safety in artifacts

**Decision**: Reuse the DAST scrub approach (`scrubSecretsInText` pattern from `zap-scan.mjs`): before writing any report to `security/sast/reports/`, redact JWT/Bearer/known-key/`mcm_*`-cookie shapes from scanner output (a scanned source snippet could echo a token literal). Reports dir stays gitignored. The gate and orchestrator never print raw finding code snippets containing credential shapes to CI logs unscrubbed.

**Rationale**: Satisfies FR-018/SC-009 and stays consistent with the DAST harness; Semgrep code findings include surrounding source lines, which is the realistic leak vector here.

**Alternatives considered**: Trusting scanners not to echo secrets — rejected (Semgrep deliberately includes matched code context).
