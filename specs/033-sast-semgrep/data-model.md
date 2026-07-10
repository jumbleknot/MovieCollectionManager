# Phase 1 Data Model: SAST & SCA Static Security Scanning

The "data" here is the config-as-code and the scanner-output records that flow orchestrator → gate. No database. Four logical entities.

## Entity 1 — Finding (normalized)

Produced by `sast-scan.mjs` (one per scanner finding, after normalization); consumed by `check-sast-findings.mjs`. Serialized as an element of the `findings[]` array in `security/sast/reports/findings.json`.

| Field | Type | Notes |
|---|---|---|
| `scanner` | enum `semgrep` \| `cargo-audit` \| `pnpm-audit` \| `pip-audit` | Source scanner. Part of the allowlist match key. |
| `kind` | enum `sast` \| `sca` | `semgrep`→`sast`; the three audits→`sca`. |
| `id` | string | Rule id (Semgrep `check_id`, e.g. `mcm-no-token-logging`) or advisory id (`RUSTSEC-YYYY-NNNN`, `GHSA-…`, `CVE-…`). Part of the match key. |
| `title` | string | Human-readable finding title / advisory summary. |
| `location` | string | SAST: `path:line` (repo-relative). SCA: `package@version`. Part of the match key. |
| `ecosystem` | enum `npm` \| `cargo` \| `pypi` \| null | SCA only; null for SAST. |
| `nativeSeverity` | string | As emitted by the scanner (e.g. Semgrep `ERROR`, CVSS score, pnpm `high`). Retained for triage/report. |
| `severity` | enum `Critical` \| `High` \| `Medium` \| `Low` | Normalized via `severity-map.yaml` (research R4). Drives gating. |
| `scope` | enum `runtime` \| `dev` \| null | SCA only (research R3): `runtime` blocking-eligible, `dev` warn-only. null for SAST (all SAST is blocking-eligible by severity). |
| `blocking` | boolean | Derived, not authored: `true` iff `severity ∈ {High, Critical}` AND (`kind==sast` OR `scope==runtime`). The gate fails on any `blocking && !allowlisted` finding. |
| `fixAvailable` | string \| null | SCA: fixed version if the advisory names one; informational. |

**Validation / derivation rules**
- `severity` MUST come from `severity-map.yaml`; an unmapped native value is a fail-fast error in the orchestrator (never a silent Low).
- SCA `scope` MUST be computed from the ecosystem's runtime-dep set (R3); a finding whose package cannot be classified defaults to `runtime` (conservative — blocks rather than hides).
- `blocking` is computed, never read from scanner output — this is the single place FR-010 + FR-021 combine.
- `location` for SAST is repo-relative and stable so allowlist patterns survive across runs.

## Entity 2 — Allowlist Entry

An element of `security/sast/allowlist.yaml`. The version-controlled baseline (FR-011/012). Mirrors the DAST allowlist's required-fields + regex-pattern discipline, adapted to normalized findings.

| Field | Type | Required | Notes |
|---|---|---|---|
| `scanner` | enum (as Finding.scanner) | yes | Must match the finding's scanner. |
| `id` | string | yes | Rule/advisory id to suppress. Exact match. |
| `locationPattern` | string (regex) | yes | Regex matched against `Finding.location` (`path:line` or `package@version`). Compiled at load; an invalid regex is a gate error (exit 2). |
| `justification` | string (non-empty) | yes | Why accepted (false positive / accepted risk). Gate error if blank. |
| `addedBy` | string (non-empty) | yes | Who triaged. Gate error if blank. |
| `expiry` | string (ISO-8601 date) | no | If present and in the past, the entry no longer suppresses (FR-011) → the finding blocks again. |

**Validation rules**
- Every entry MUST have non-empty `scanner`, `id`, `locationPattern`, `justification`, `addedBy` (same strictness as `check-dast-findings.mjs`).
- Suppression match = `scanner` equal AND `id` equal AND `locationPattern` matches `Finding.location` AND (`expiry` absent OR `expiry >= today`).
- Suppression is **gate-only**: an allowlisted finding is removed from the fail set but stays in `findings.json` and the reports (FR-010).
- **Baseline seeding (FR-012)**: on first landing, the orchestrator can emit a `--emit-allowlist` proposal covering every current finding; the maintainer commits it (with real justifications) so `main` is green day one.

## Entity 3 — Severity Mapping

`security/sast/severity-map.yaml` — pure data (research R4), read by the orchestrator. Shape:

```yaml
semgrep:   { ERROR: High, WARNING: Medium, INFO: Low }
cvssBands: { critical: 9.0, high: 7.0, medium: 4.0 }   # >=band → that level; below medium → Low
pnpmAudit: { critical: Critical, high: High, moderate: Medium, low: Low, info: Low }
unscoredAdvisory: High     # cargo/pip advisory with no CVSS
informationalWarning: Low  # cargo unmaintained/yanked
```

**Validation rules**: every scanner's full native-severity domain MUST be representable; the orchestrator fails fast on an unmapped native value (no silent default).

## Entity 4 — Custom Rule (Semgrep)

A YAML rule under `security/sast/rules/`, each shipped with test fixtures (FR-019).

| Field | Type | Notes |
|---|---|---|
| `id` | string | Behavior-descriptive, `mcm-`-prefixed (e.g. `mcm-no-token-logging`). No FR-id in the name. |
| `severity` | Semgrep `ERROR` \| `WARNING` | `ERROR` (→High, blocking) for credential/token/PII-leak + auth-before-authz rules; `WARNING` (→Medium, warn) for hygiene rules (FR-004). |
| `languages` | list | `typescript`/`javascript` (BFF, frontend) and/or `python` (agent layer). |
| `message` | string | What invariant is violated + how to fix. |
| `metadata.mcmRequirement` | string | Traceability comment field (e.g. `FR-004`) — provenance only, per the constitution's behavior-descriptive-identifier exception. |
| `patterns` | Semgrep DSL | The match. |

**v1 rule set (minimum, FR-004)**
- `mcm-no-console-in-bff` — WARNING/Medium — direct `console.*` in `src/bff-server/**` or `bff-api/**` (house rule: use the structured logger).
- `mcm-no-token-logging` — ERROR/High — logging a raw token/JWT/`authorization`/session id / email in server code.
- `mcm-auth-before-authz` — ERROR/High — a BFF route handler that reaches an upstream/`createMcServiceClient` call without a preceding `requireAuth`/`requireMcUser` (best-effort structural rule; documented limitations in the rule comment).
- `mcm-no-jwt-payload-tracing` — ERROR/High — logging/tracing a decoded JWT payload or token on the **TS/JS and Python** surfaces only (BFF, agent layer). **mc-service is Rust → out of Semgrep scope (R6), so this rule does NOT enforce the mc-service no-JWT-logging invariant** — that residual stays owned by `cargo clippy` + code review (documented gap, not covered by this feature).

**Validation rules**: each rule file has a sibling `*.test.*` fixture with `// ruleid:` (insecure) and `// ok:` (safe) annotations; `semgrep --test security/sast/rules/` MUST pass in CI (FR-019 / SC-007).

## Relationships

```
severity-map.yaml ──read──▶ sast-scan.mjs ──emits──▶ findings.json (Finding[])
rules/*.yaml ──scanned by──▶ semgrep ──▶ (subset of) findings.json           │
                                                                              ▼
allowlist.yaml (AllowlistEntry[]) ──read──▶ check-sast-findings.mjs ──gate──▶ exit 0/1/2
```

The gate depends only on `findings.json` + `allowlist.yaml` — never on scanner internals — keeping it as small and unit-testable as `check-dast-findings.mjs`.
