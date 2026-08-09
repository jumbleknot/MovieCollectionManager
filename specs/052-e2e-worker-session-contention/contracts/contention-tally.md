# Contract — the contention tally

**Feature**: 052-e2e-worker-session-contention · **Requirements**: FR-005, FR-006, FR-007, SC-001, SC-007

This is the only artifact of the measurement stage that a working session can read. Its format is a
contract because the counts get compared **across runs** — Phase 3 diffs two of them — and a format that
drifts between runs cannot be diffed.

## The line

Exactly one line, on stdout, for each `app-e2e` run:

```text
[e2e-contention] refresh_total=<N> refresh_429=<M> session_evicted=<K>
```

- `[e2e-contention]` — fixed marker. Grepped by humans and by any later automation; do not restyle it.
- `refresh_total` — token-refresh attempts the BFF handled during the web-E2E window, all outcomes.
- `refresh_429` — attempts rejected by the per-session refresh rate limit (2 per 30 s, keyed on
  `sessionId`).
- `session_evicted` — sessions deleted because `MAX_CONCURRENT_SESSIONS` was reached.
- Every value is a non-negative integer. **Zero is a result**, and must be printed as `0` — never
  omitted, never rendered as an empty string, never replaced by an error.

## Emission

- Produced by `scripts/e2e-contention-tally.sh`, invoked as
  `bash scripts/ci-log-step.sh e2e-contention-tally bash scripts/e2e-contention-tally.sh`.
- Runs `if: always()` — a passing run's counts are the evidence that the contention is gone (SC-007).
- Runs **after** the Web E2E step and **before** `Tear down CI stacks (always)`. Teardown removes the
  container the counts are read from; a step ordered after it reports zeros for a structural reason
  indistinguishable from a clean result.

## Exit status

**The script always exits 0.** It is a diagnostic; it must never fail a job, and above all it must not
fail the job when every count is zero.

The specific trap: `grep -c` exits **1** when it matches nothing, and `ci-log-step.sh` re-raises the
wrapped command's exit code by design (`pipefail` is load-bearing there). Naive counting therefore
turns the best possible measurement into a red job. The script must neutralise that.

## Degradation

Missing input is reported, never silently rendered as zero — the two are opposite conclusions:

| Condition | Behaviour |
| --- | --- |
| BFF container present, no matching events | print the line with `0` for the affected counters, exit 0 |
| BFF container absent or unreadable | print the line with `unavailable` in place of every count, plus a one-line reason, exit 0 |

`unavailable` and `0` must never be conflated. `0` means "measured, nothing happened"; `unavailable`
means "not measured". SC-001 is satisfied only by the former.

## Why this channel

`ci-failure-digest.mjs`'s `selectSources` ranks a `step:` source **0** — above `_ps.txt`, above
unhealthy-container logs, above everything. The digest is tail-biased and keeps at most
`DIGEST_MAX_SOURCES = 3` sources, so a line buried early in a multi-thousand-line BFF container log
would be dropped. The alternatives were considered and rejected in [../research.md §R6](../research.md):
the container-log artifact is not readable through the forge API, and `~/mcm-ci-last-failure` needs host
SSH.
