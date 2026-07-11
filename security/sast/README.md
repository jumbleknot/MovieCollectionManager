# SAST & SCA Static Security Scanning (Semgrep + audit tools) — feature 033

Config-as-code **Static** Application Security Testing (SAST) and **Software Composition Analysis** (SCA),
all **keyless** (no SaaS, no account, no new CI secret). Where DAST (feature 031) exercises the *running*
app over HTTP, this scans the source and the dependency graph *at rest*. Four scanners, one normalized
severity scale, one allowlist-as-baseline, one blocking `sast` CI job.

| Kind | Scanner | Surface | Invocation |
|---|---|---|---|
| SAST | **Semgrep** (OSS) | first-party TS/JS tree (BFF + full frontend) + Python agent layer | `uvx semgrep@<pin> scan` |
| SCA | **cargo audit** | Rust deps (root `Cargo.lock`) | `cargo audit --json` |
| SCA | **pnpm audit** | JS deps (root `pnpm-lock.yaml`) | `pnpm audit --json` |
| SCA | **pip-audit** | Python deps (`agents/movie-assistant/uv.lock`) | `uvx pip-audit` over a `uv export` |

Rust *code* is out of Semgrep scope (clippy via `pnpm nx lint mc-service` already covers Rust patterns);
Rust participates only through `cargo audit` (deps). `p/secrets` is **never** enabled — the existing
`secret-scan` gate remains the sole owner of credential detection (FR-006).

## Normalized severity scale

All four scanners' native severities map onto one **Critical / High / Medium / Low** scale via
[`severity-map.yaml`](./severity-map.yaml) (applied by the orchestrator, not the gate). The gate fails on
any un-allowlisted **High/Critical** finding that is *blocking*; Medium/Low are warnings.

`blocking = severity ∈ {High, Critical} AND (kind == sast OR scope == runtime)` — a High/Critical advisory
in a **runtime** dependency blocks; the same advisory in a **dev/test/build-only** dependency is downgraded
to a non-blocking warning (FR-021). Dependency scope is computed deterministically per ecosystem
(`cargo tree --edges no-dev`, `pnpm audit --prod`, `uv export --no-dev`).

## Custom MCM rules

Project-specific invariants live under [`rules/`](./rules/), each with `semgrep --test` fixtures (FR-019):

| Rule | Severity | Enforces |
|---|---|---|
| `mcm-no-console-in-bff` | WARNING → Medium (warn) | no direct `console.*` in `src/bff-server/**` or `bff-api/**` |
| `mcm-no-token-logging` | ERROR → High (block) | no logging of a raw token/JWT/`authorization`/session id/email in server code |
| `mcm-auth-before-authz` | ERROR → High (block) | a BFF route handler must not reach an upstream call without a preceding `requireAuth`/`requireMcUser` |
| `mcm-no-jwt-payload-tracing` | ERROR → High (block) | no logging/tracing of a decoded JWT payload on the TS/JS + Python surfaces |

> `mcm-no-jwt-payload-tracing` covers **TS/JS + Python only**. mc-service (Rust) is out of Semgrep scope,
> so its no-JWT-logging invariant stays owned by `cargo clippy` + code review (documented gap).

## How to run

> Full procedure (local run, CI job, toolchain/cache notes, triage) →
> [docs/runbooks/sast-scanning.md](../../docs/runbooks/sast-scanning.md).

No application stack is required — this is a static scan. Prerequisites: Node ≥ 20, `uv`/`uvx`, a Rust
toolchain with `cargo-audit`, and pnpm (all provisioned in CI; install locally as needed).

```bash
pnpm nx sast infrastructure-as-code        # or: node scripts/sast-scan.mjs --scope full
```

Reports land in `security/sast/reports/` (gitignored).

## Reports

Each run writes to `security/sast/reports/` (gitignored):

| File | Purpose |
|---|---|
| `findings.json` | **gate input** — normalized report (`check-sast-findings.mjs` reads this) |
| `findings.sarif` | portable SARIF interchange |
| `summary.txt` | human summary grouped by normalized severity + scanner |
| `<scanner>-native.json` | each scanner's raw output, secret-scrubbed, for triage |

## Triage / allowlist workflow

A **blocking High/Critical** finding fails the CI gate. To resolve one you either **fix it** or, if it is a
false positive / accepted risk, **triage it** into [`allowlist.yaml`](./allowlist.yaml) with all required
fields (a blank `justification` or `addedBy` is a **gate error**):

```yaml
- scanner: "semgrep"                       # semgrep | cargo-audit | pnpm-audit | pip-audit
  id: "mcm-no-token-logging"               # rule id or advisory id (RUSTSEC-*/GHSA-*/CVE-*)
  locationPattern: "src/bff-server/foo\\.ts:.*"   # regex vs Finding.location ('path:line' or 'package@version')
  justification: "False positive: the logged value is a request id, not a token."
  addedBy: "steve"
  # expiry: "2026-12-31"                    # optional ISO-8601; once past, the entry stops suppressing
```

Suppression is **gate-only** — the finding stays visible in `findings.json`/reports (FR-010).

Verify the gate logic anytime with `node scripts/check-sast-findings.mjs --selftest`.
