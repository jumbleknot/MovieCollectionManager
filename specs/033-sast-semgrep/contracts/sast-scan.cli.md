# CLI Contract: `scripts/sast-scan.mjs` (orchestrator)

Runs the four scanners, normalizes their output to `security/sast/reports/findings.json`, and writes human + SARIF reports. Does **not** decide pass/fail — that is the gate's job (`check-sast-findings.mjs`). Mirrors `scripts/zap-scan.mjs`.

## Usage

```bash
node scripts/sast-scan.mjs [--scope full|changed] [--base <ref>] [--only <scanner,...>] [--emit-allowlist] [--out <dir>]
```

## Flags

| Flag | Default | Meaning |
|---|---|---|
| `--scope` | `full` | `full` = Semgrep scans the whole tree (baseline/push). `changed` = Semgrep scans only files changed vs `--base` (PR). **SCA always runs full regardless of `--scope`.** |
| `--base` | `origin/main` | Base ref for `--scope changed` diff. |
| `--only` | (all) | Comma list to restrict scanners (`semgrep,cargo-audit,pnpm-audit,pip-audit`) — for local iteration. In CI all four run. |
| `--emit-allowlist` | off | Also write `reports/allowlist.proposed.yaml` covering every current finding (baseline-seeding aid, FR-012). Does not modify the committed allowlist. |
| `--out` | `security/sast/reports` | Output directory. |

## Outputs (to `--out`)

| File | Purpose |
|---|---|
| `findings.json` | Normalized report — conforms to `contracts/findings.schema.json`. The gate's input. |
| `findings.sarif` | SARIF (Semgrep native + normalized SCA) for artifact/interchange. |
| `summary.txt` | Human summary grouped by normalized severity + scanner (stdout mirror). |
| `<scanner>-native.json` | Each scanner's raw output, secret-scrubbed (R8), for triage. |

## Behavior

- **Normalization**: applies `security/sast/severity-map.yaml` (R4) and computes `scope` (R3) and derived `blocking` per the data model. An unmapped native severity is a **fail-fast error**, not a silent default.
- **Fail-fast (FR-015)**: if a required scanner's toolchain is unavailable, or required advisory/rule data cannot be fetched, exit **non-zero** with a clear message naming the scanner and record `scanners[].error`. Never silently drop a language surface.
- **Secret scrubbing (R8 / FR-018)**: all written reports and any stdout finding context are scrubbed of JWT/Bearer/known-key/`mcm_*`-cookie shapes.
- **Semgrep secret rules**: never enabled (FR-006).

## Exit codes

| Code | Meaning |
|---|---|
| `0` | All expected scanners ran and a valid `findings.json` was written (regardless of how many findings — gating is the gate's job). |
| `1` | A required scanner failed fast (missing toolchain / unreachable data) or normalization hit an unmapped severity. |
| `2` | Bad arguments. |

> Note: a non-empty `findings.json` is **not** a scan failure. `sast-scan.mjs` exiting 0 means "the scan is trustworthy"; `check-sast-findings.mjs` then decides the build outcome.
