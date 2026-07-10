# CLI Contract: `scripts/check-sast-findings.mjs` (gate)

The authoritative pass/fail gate. Consumes only the normalized `findings.json` + `allowlist.yaml`. Mirrors `scripts/check-dast-findings.mjs`.

## Usage

```bash
node scripts/check-sast-findings.mjs [--report <path>] [--allowlist <path>] [--selftest]
```

## Flags

| Flag | Default | Meaning |
|---|---|---|
| `--report` | `security/sast/reports/findings.json` | The normalized findings report to evaluate. |
| `--allowlist` | `security/sast/allowlist.yaml` | The baseline allowlist. |
| `--selftest` | off | Run inline fixtures (no file I/O), then exit. Used by the CI gate step before the real scan, mirroring the DAST selftest. |

## Gate logic

1. Load `--report` (conforms to `findings.schema.json`). Unparseable → exit `2`.
2. Load `--allowlist`. Any entry missing a required field (`scanner`/`id`/`locationPattern`/`justification`/`addedBy`) or with an invalid `locationPattern` regex → exit `2` (GateError).
3. Compute the **fail set** = findings where `blocking === true` AND not suppressed by any allowlist entry, where suppression = `scanner` equal AND `id` equal AND `locationPattern` matches `location` AND (`expiry` absent OR `expiry >= today`).
4. Findings with `blocking === false` (Medium/Low, or dev-scope SCA) are printed as **warnings** and never fail the build.
5. Allowlisted findings are removed from the fail set but remain in the printed report (FR-010).

## `--selftest` scenarios (all must pass)

- (a) un-allowlisted blocking (High, runtime) finding → exit `1`.
- (b) same finding allowlisted → exit `0`.
- (c) High finding with `scope: dev` (non-blocking) → exit `0` (warned, not failed).
- (d) clean report → exit `0`.
- (e) allowlist entry with blank `justification` → GateError (exit `2`).
- (f) allowlist entry with past `expiry` does **not** suppress → exit `1`.

## Exit codes

| Code | Meaning |
|---|---|
| `0` | Pass — no un-allowlisted blocking findings (or `--selftest` all-pass). |
| `1` | Fail — at least one un-allowlisted High/Critical blocking finding present. |
| `2` | Bad args / unparseable report / invalid allowlist entry. |
