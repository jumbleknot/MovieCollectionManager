# Phase 1 Data Model: SAST/SCA Baseline Hardening

This feature has no application data model. The "entities" are the artifacts the remediation manipulates: findings, allowlist entries, and the burn-down ledger that tracks the transition of each. Documented here so `/speckit-tasks` and reviewers share one vocabulary.

## Entity: Finding

One scanner result in `security/sast/reports/findings.json`.

| Field | Meaning |
|---|---|
| `scanner` | `semgrep` \| `cargo-audit` \| `pnpm-audit` \| `pip-audit` |
| `id` | Semgrep `check_id` or advisory id (`RUSTSEC-*`/`GHSA-*`/`CVE-*`/`PYSEC-*`) |
| `location` | `path:line` (forward slashes) or `package@version` |
| `severity` | normalized `Critical`/`High`/`Medium`/`Low` (via `security/sast/severity-map.yaml`) |
| `blocking` | `true` iff `severity ∈ {High,Critical}` AND (`kind==sast` OR SCA `scope==runtime`) |

**Lifecycle**: `present (blocking, allowlisted)` → *[remediate]* → `absent` (re-scan no longer produces it) → allowlist entry deleted → `re-blocks if reintroduced`. A dev/build-scope advisory is `present (non-blocking warning)` → *[opportunistic bump]* → `absent`; it never needs an allowlist entry.

## Entity: Allowlist entry

One record in `security/sast/allowlist.yaml`, consumed only by `scripts/check-sast-findings.mjs`.

| Field | Meaning |
|---|---|
| `scanner` | matches Finding.scanner |
| `id` | exact rule/advisory id |
| `locationPattern` | regex vs Finding.location |
| `justification` | why accepted (false-positive or accepted-risk or carried-forward debt) |
| `addedBy` | triager |
| `expiry` | optional ISO date; past-expiry stops suppressing |

**State transitions in this feature**:

- **DELETE** — the finding is remediated; a fresh Linux/CI scan confirms it absent. The entry is removed so any regression re-blocks. (P1 dep bumps, P2 container non-root, P3 refactored shell-injection steps, P3 SHA pins.)
- **REWRITE (retain)** — the finding is genuinely accepted (trusted internal value) or blocked by an upstream constraint; the generic baseline justification is replaced with a specific one. (P3 retained shell-injection steps; any P1 bump blocked upstream.)
- **KEEP UNCHANGED** — documented false-positives / accepted-risks that are out of scope for remediation (FR-010): `gcm-no-tag-length`, `bypass-tls-verification`, `logger-credential-disclosure`, `mcm-no-token-logging`, `mcm-auth-before-authz`, `mcm-no-console-in-bff`.

## Entity: Burn-down ledger

Not a file — the conceptual mapping from each backlog item to its allowlist action, tracked in `tasks.md` and reflected in `docs/proposals/sast-sca-hardening-backlog.md`. Invariant: **allowlist blocking-entry count is monotonically non-increasing** across the branch, ending materially below the 55-blocking feature-033 baseline (SC-006).

## Validation rules (enforced by the gate, not new here)

- All four match-key fields required; blank justification/addedBy or invalid regex = gate error.
- The gate fails on any `blocking` finding not covered by a live (non-expired) allowlist entry.
- Deleting an entry whose finding is still present → gate goes RED (the desired safety property: you cannot claim a fix that isn't real).
