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
- scanner: "semgrep"                       # semgrep | cargo-audit | pnpm-audit | pip-audit — must match
  id: "mcm-no-token-logging"               # EXACT rule id (Semgrep check_id) or advisory id (RUSTSEC-*/GHSA-*/CVE-*/PYSEC-*)
  locationPattern: "src/bff-server/foo\\.ts:.*"   # REGEX vs Finding.location — 'path:line' (FORWARD slashes) or 'package@version'
  justification: "False positive: the logged value is a request id, not a token."   # required, non-empty
  addedBy: "steve"                         # required, non-empty — who triaged
  # expiry: "2026-12-31"                    # optional ISO YYYY-MM-DD (see below)
```

**Field rules** (a missing/blank `justification`/`addedBy` or an invalid `locationPattern` regex is a
**gate error** — exit 2):

- **Match key** = `scanner` equal **AND** `id` equal **AND** `locationPattern` matches the finding's
  `location`. Scope `locationPattern` narrowly — anchor to the file (SAST) or package (SCA); avoid a
  blanket `.*`. Paths are normalized to **forward slashes** so one pattern works on the Windows dev host
  and the Linux CI runner.
- **`expiry`** (optional, ISO `YYYY-MM-DD`): while absent or **today-or-later**, the entry suppresses.
  Once the date is **past**, the entry stops suppressing and the finding **blocks again** — use it to
  force re-review of a time-boxed accepted risk (e.g. "accepted until the upstream fix ships").
- **Suppression is gate-only**: an allowlisted finding is removed from the *failure* set but stays
  **visible** in `findings.json` / the reports and is printed as "allowlisted by …" (FR-010) — accepted
  risks remain auditable, never hidden.
- Only **blocking** findings (High/Critical that are SAST, or runtime-scope SCA) need an entry; Medium/
  Low and dev-scope findings are warnings and never fail the gate.

**Seeding a fresh baseline**: `node scripts/sast-scan.mjs --scope full --emit-allowlist` writes
`reports/allowlist.proposed.yaml` covering every current finding (TODO justifications). Triage each,
then copy the kept entries into this `allowlist.yaml`. The committed baseline (FR-012 / SC-006) makes
`main` green on day one so the gate blocks only findings introduced *after* the baseline.

Verify the gate logic anytime with `node scripts/check-sast-findings.mjs --selftest`.
