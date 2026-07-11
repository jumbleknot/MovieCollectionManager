# SAST & SCA Static Scanning — Operator Runbook (feature 033)

Keyless, config-as-code Static Application Security Testing (SAST) + Software Composition Analysis
(SCA). Complements DAST ([dast-scanning.md](dast-scanning.md)): where DAST exercises the *running* app,
this scans source and the dependency graph *at rest*. Four scanners → one normalized report → one
blocking `sast` CI gate. Config tree: [security/sast/](../../security/sast/).

| Kind | Scanner | Surface | How |
|---|---|---|---|
| SAST | Semgrep (OSS) | TS/JS tree (BFF + frontend) + Python agent layer | `uvx semgrep@<pin> scan` |
| SCA | cargo audit | Rust deps (root `Cargo.lock`) | `cargo audit --json` |
| SCA | pnpm audit | JS deps (root `pnpm-lock.yaml`) | `pnpm audit --json` (+ `--prod` for scope) |
| SCA | pip-audit | Python deps (`agents/movie-assistant`) | audits the **installed venv** (see gotcha) |

## Run it locally

Prereqs (no app stack needed — this is a static scan): Node ≥ 20, `uv`/`uvx`, a Rust toolchain with
`cargo-audit` (`cargo install cargo-audit --locked`), pnpm, and a **synced agent venv**
(`uv sync` in `agents/movie-assistant` — pip-audit audits the installed env).

```bash
pnpm nx sast infrastructure-as-code        # or: node scripts/sast-scan.mjs --scope full
node scripts/check-sast-findings.mjs       # the gate (exit 0 pass / 1 fail / 2 bad input)
```

Reports land in `security/sast/reports/` (gitignored): `findings.json` (gate input), `findings.sarif`,
`summary.txt`, and `<scanner>-native.json`. A full local run is ~2–6 min (pip-audit's OSV lookups are
the long pole).

Scope flags: `--scope full` (default, whole tree) vs `--scope changed --base <ref>` (Semgrep scans only
files changed vs `<ref>`; **SCA always runs full**). `--only <scanner,...>` restricts scanners for local
iteration. `--emit-allowlist` writes `reports/allowlist.proposed.yaml` (baseline-seeding aid).

## The CI gate

The blocking **`sast`** job in [.forgejo/workflows/guardrails.yml](../../.forgejo/workflows/guardrails.yml)
runs on every push/PR (auto-covered by the `guardrails*` branch-protection glob). Keyless — no
`${{ secrets }}`. Steps: install uv + Rust/cargo-audit fresh + `pnpm install` + `uv sync` the agent
venv → `check-sast-findings.mjs --selftest` → `sast-scan.mjs` (`--scope changed` on PRs, `--scope full`
on push; **SCA always full**) → `check-sast-findings.mjs` (the gate) → upload the `sast-report` artifact
(always, for triage). **No `paths:` filter** — a newly-published advisory can hit an unchanged dep, so
SCA must run regardless of what changed (FR-013).

Forgejo shows no per-step logs; if the `sast` job fails, reproduce locally and read the `sast-report`
artifact (`findings.json` + `summary.txt`). This is how 031's DAST CI was debugged.

## Triage / allowlist

The gate fails on any **blocking** finding (High/Critical that is SAST, or **runtime-scope** SCA) not in
[security/sast/allowlist.yaml](../../security/sast/allowlist.yaml). Medium/Low and **dev-scope** SCA are
warnings and never fail. To resolve a blocking finding: **fix it**, or triage it into the allowlist with
all required fields (`scanner`, `id`, `locationPattern` regex, `justification`, `addedBy`; optional
`expiry`). Suppression is gate-only — the finding stays visible in reports (FR-010). Full field rules,
expiry semantics, and baseline-seeding steps are in
[security/sast/README.md](../../security/sast/README.md#triage--allowlist-workflow).

## Non-obvious gotchas

- **pip-audit audits the INSTALLED venv, not a requirements file.** `pip-audit -r <requirements>`
  resolves the file in an ephemeral venv (downloads the whole 179-pkg graph, chokes on yanked versions —
  hangs >11 min). The orchestrator instead runs `uv run --no-sync --with pip-audit pip-audit -s osv`
  against the synced venv (~50 s) and intersects findings with the `uv export` dep-set to drop
  pip-audit's own injected deps. **CI must `uv sync` the agent layer first**, and a developer's venv must
  be synced for a local run.
- **Keyless & fail-CLOSED (R7).** All rule/advisory data is fetched anonymously at scan time (Semgrep
  registry, RustSec DB, npm advisories, OSV/PyPI). If any fetch fails, that scanner **fails fast**
  (exit 1, `scanners[].error` recorded) rather than reporting a false clean. Residual: an upstream
  outage blocks the gate — re-run when it recovers. No secret is ever required.
- **`p/secrets` stays OFF** — `secret-scan.mjs` owns credential detection (FR-006). Do not double-gate.
- **Rust code is out of Semgrep scope** — clippy (`pnpm nx lint mc-service`) covers Rust patterns;
  cargo-audit covers only Rust *deps*. Consequently `mcm-no-jwt-payload-tracing` enforces the no-JWT-
  logging invariant on TS/JS + Python only; the mc-service (Rust) residual stays with clippy + review.
- **No caching yet.** `actions/cache` is not mirrored on the runner, so cargo-audit is compiled fresh
  each run (~2–3 min). A monthly-keyed cache of `~/.cargo/bin/cargo-audit` + `~/.cargo/advisory-db` is a
  future optimization.
- **Paths are normalized to forward slashes** so allowlist `locationPattern`s are portable across the
  Windows dev host and the Linux CI runner.
