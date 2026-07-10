# Quickstart: SAST & SCA Static Security Scanning

Validation/run guide. Implementation lives in `tasks.md` + the source tree; this proves the feature end-to-end.

## Prerequisites

- Node ≥ 20 + pnpm (`corepack enable`), `pnpm install`.
- `uv` on PATH (for `uvx semgrep` + `uvx pip-audit`). Install: `curl -LsSf https://astral.sh/uv/install.sh | sh` (POSIX) — on Windows use the documented `uv` installer.
- Rust toolchain (`cargo`) + `cargo install cargo-audit --locked` (for the Rust SCA scanner).
- No accounts, license keys, or secrets — everything is keyless.

## Run the full scan locally

```bash
pnpm nx sast infrastructure-as-code          # → node scripts/sast-scan.mjs --scope full
# or directly:
node scripts/sast-scan.mjs --scope full
```

**Expected**: `security/sast/reports/findings.json` (+ `findings.sarif`, `summary.txt`, `<scanner>-native.json`) written; stdout summary groups findings by normalized severity and scanner. Every expected scanner shows `ran: true` in the report's `scanners[]`.

Iterate on one scanner:

```bash
node scripts/sast-scan.mjs --only semgrep --scope changed --base origin/main
```

## Run the gate

```bash
node scripts/check-sast-findings.mjs                    # evaluates the report above
```

**Expected**: exit `0` and "gate passed" when no un-allowlisted High/Critical **blocking** findings remain; exit `1` listing the offending findings otherwise. Medium/Low and dev-scope SCA findings print as warnings and never fail.

Gate self-test (no scan needed — this is what CI runs first):

```bash
node scripts/check-sast-findings.mjs --selftest        # exit 0 iff all inline scenarios pass
```

## Triage a finding → allowlist

When a finding is a false positive or an accepted risk, add an entry to `security/sast/allowlist.yaml` (schema: [contracts/allowlist.schema.json](contracts/allowlist.schema.json)):

```yaml
- scanner: "semgrep"
  id: "javascript.lang.security.audit.some-rule"
  locationPattern: "src/frontend/.*\\.tsx:[0-9]+"
  justification: "False positive — matched a constant string, not user input. Confirmed by review."
  addedBy: "steve"
  # expiry: "2026-10-01"   # optional; after this date the finding blocks again
```

Re-run the gate → the finding is now suppressed from the fail set but still appears in `findings.json` (FR-010). An unrelated new High/Critical still fails (SC-005).

## Seed the baseline (one-time, at feature landing)

```bash
node scripts/sast-scan.mjs --scope full --emit-allowlist
# review reports/allowlist.proposed.yaml, add real justifications, commit as security/sast/allowlist.yaml
```

This makes `main` green on day one (FR-012 / SC-006); only findings introduced *after* the baseline block.

## Run the custom-rule tests

```bash
uvx semgrep --test security/sast/rules/                # every mcm-* rule's insecure/safe fixtures must pass
```

## Gate unit tests

```bash
node --test scripts/__tests__/check-sast-findings.test.mjs
node --test scripts/__tests__/sast-scan.guard.test.mjs
```

## Demonstration scenarios (map to Success Criteria)

| Scenario | Steps | Expected | SC |
|---|---|---|---|
| Insecure code pattern blocks | Add a Semgrep-detectable High pattern in a `.ts` file; run scan+gate | gate exit `1`, finding in report | SC-002 |
| Vulnerable runtime dep blocks | Add a dependency with a known High advisory to a runtime manifest; run scan+gate | gate exit `1`, finding in report | SC-003 |
| Dev-only dep warns, not blocks | Introduce a High advisory in a dev/test-only dep | gate exit `0`, finding shown as warning | SC-011 |
| Allowlist suppresses one, not all | Allowlist the SC-002 finding; introduce a different High | first passes, second fails | SC-005 |
| Clean PR passes | Benign change | gate exit `0`, artifacts published | SC-004 |
| Keyless | Run on a runner with no security-tool account | scan + gate succeed | SC-008 |

## CI

The `sast` job in `.forgejo/workflows/guardrails.yml` runs on every push/PR: provisions node/pnpm + uv + rust (+ `cargo-audit`, cached), runs `--selftest`, runs `sast-scan.mjs` (`--scope changed` on PRs, `--scope full` on push), runs the gate on the real report, and uploads `security/sast/reports/` as a build artifact. It is a branch-protection-required check (covered by the existing `guardrails*` required-glob). Full operator detail: `docs/runbooks/sast-scanning.md`.
