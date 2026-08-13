# CLI contract: `--check-expiring` (both allowlist gates)

A delta to two existing contracts —
[`check-sast-findings.cli.md`](../../033-sast-semgrep/contracts/check-sast-findings.cli.md) and the
equivalent for `check-infra-image-findings.mjs`. Everything not stated here is unchanged.

## Usage

```bash
# Normal run — unchanged exit semantics, new report sections
node scripts/check-sast-findings.mjs
node scripts/check-infra-image-findings.mjs

# Dedicated check mode — non-zero on any expiring / expired / unmatched entry
node scripts/check-sast-findings.mjs --check-expiring
node scripts/check-infra-image-findings.mjs --check-expiring
```

## Flags

| Flag | Default | Meaning |
| --- | --- | --- |
| `--check-expiring` | off | Report only. Skips the blocking-finding gate entirely and exits non-zero if any entry is `expiring`, `expired`, or unmatched. |

## Normal-run behaviour (the binding constraint)

**The exit code does not change.** An entry inside the warning window still suppresses its finding;
the run still exits 0 (FR-021, SC-007). Three sections are added to the printed report:

```text
EXPIRING SOON (suppressing for now)
  GHSA-7p8r-x3mc-p8w7   expires 2026-08-31   10 days   addedBy: steve

EXPIRED (no longer suppressing)
  GHSA-xxxx  this finding was suppressed until 2026-08-31 by an entry added by steve

UNMATCHED ENTRIES (suppressed nothing this run)
  GHSA-yyyy  addedBy: steve
```

The `EXPIRED` section is the more valuable half of the change: it converts a confusing new blocking
finding into a legible one, naming what used to cover it and who accepted it.

## `--check-expiring` behaviour

1. Load the allowlist and the report as usual. Malformed input → exit `2`, unchanged.
2. Classify every entry (`allowlist-expiry.mjs`).
3. Compute unmatched entries — **only** for scanners that produced ≥1 finding in this run.
4. Print the three sections above.
5. Exit `1` if any section is non-empty; otherwise `0`.

**Does not evaluate blocking findings.** A repository with un-allowlisted blocking findings and a
clean allowlist exits `0` in this mode — the blocking gate is the normal run's job, and conflating
them would make the weekly signal ambiguous.

## Exit codes

| Code | Normal run | `--check-expiring` |
| --- | --- | --- |
| `0` | No un-allowlisted blocking findings | No expiring, expired or unmatched entries |
| `1` | Un-allowlisted blocking finding present | At least one such entry |
| `2` | Bad args / unparseable report / invalid entry | Same |

## CI wiring

```yaml
# .forgejo/workflows/infra-image-scan.yml — scan job
- name: Allowlist expiry check (weekly only)
  if: github.event_name == 'schedule'
  run: bash scripts/ci-log-step.sh allowlist-expiry-check node scripts/check-sast-findings.mjs --check-expiring
# …and the same for check-infra-image-findings.mjs
```

**The `if:` is load-bearing.** That job also runs on path-gated `pull_request` events; without the
guard a red expiry check would block pull requests, which FR-021 and SC-007 forbid. Verification is
reading a real PR run's step list, not trusting the expression.

Failure announcement needs no new plumbing — the job already invokes `ci-failure-digest.mjs` on
failure (`infra-image-scan.yml:86-95`, `192-201`).

## New `--selftest` cases

Extending the existing harnesses — case `(f)` in `check-sast-findings.mjs`, case `(h)` in
`check-infra-image-findings.mjs`.

| Case | Scenario | Expected |
| --- | --- | --- |
| (g1) | Entry expiring in 10 days, finding present | Normal run exits **0**, finding suppressed, entry listed under `EXPIRING SOON` |
| (g2) | Same entry, `--check-expiring` | exits **1** |
| (g3) | Expired entry, finding re-blocks | exits `1` **and** the output names the former expiry and `addedBy` |
| (g4) | Entry matching nothing, its scanner produced findings | Listed as unmatched; `--check-expiring` exits `1` |
| (g5) | Entry matching nothing, its scanner produced **no** findings | **Not** listed; `--check-expiring` exits `0` |
| (g6) | All entries active and matched | `--check-expiring` exits `0` |

Case (g5) is the one that keeps the weekly signal trustworthy; without it the check goes red claiming
stale entries whenever a scanner is skipped.
