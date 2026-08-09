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

## The third false zero — a BFF without the instrumentation

The `0`-vs-`unavailable` rule covers a missing *source*. It does not cover a present source produced
by a build that has no instrumentation in it: that reports a clean, confident `0` for all three
counters, and nothing in the line says otherwise. Found the honest way — running the tally against
the live dev container, which predated feature 052's events and duly returned a tidy row of zeros.

`refresh_attempted` fires on every refresh attempt, and refresh cadence is set by the **5-minute**
access-token lifespan, not by anything the tests do. Across a full multi-worker run, `refresh_total=0`
in the presence of ordinary BFF traffic therefore means *the instrumented image did not ship* — not
that nothing refreshed. The script emits a second line when it sees that combination:

```text
[e2e-contention] caution: refresh_total=0 across <N> BFF log entries — over a full run this
indicates the instrumented build did NOT ship, not that no refresh occurred. …
```

No caution is emitted when there was no BFF traffic at all: that is a legitimate zero with nothing to
infer from, and warning there would train the reader to ignore the line in the case that matters.

**Known limitation — the caution can cry wolf on a SHORT run.** Its premise is a full multi-worker
suite crossing several five-minute token boundaries. A single-spec smoke run of ~40 s legitimately
performs zero refreshes and still trips the caution (observed locally, 2026-08-09). The wording says
"over a full run" and asks the reader to verify the image, so it misleads only if read as an assertion
of fact. It is deliberately left noisy in this direction: a spurious caution costs a glance, whereas a
missed one costs a whole measurement mis-read as a result.

## The tally counts the container's LIFETIME, not the run

`docker logs` is cumulative and survives `docker restart`. In CI that distinction does not arise —
every run brings the stacks up fresh and tears them down — so lifetime and run are the same window.
**Locally they are not**: a second measurement against the same container reports the sum of both.
Recreate the container (`docker compose … up -d --force-recreate mcm-bff-service-nonsecure`) to reset
the baseline; restarting is not enough.

**Consequence for SC-001**: a measurement run whose tally reads `refresh_total=0` has **not** answered
the question. Rebuild the BFF image from the branch and re-run.

## Where to actually look for it

⚠️ **The tally is guaranteed in the evidence BUNDLE, not necessarily in the digest comment.**
`DIGEST_MAX_SOURCES = 3` caps what the comment *shows*; the code's own words are "the bundle always
carries all of them", and held-back sources are announced with a `_N more source(s) held back…_` line.
`app-e2e` wraps many steps in `ci-log-step.sh`, so there are more than three `step:` sources competing
for those slots.

So **"the tally is not in the digest comment" does not mean it was not produced** — that inference is
the same silence-reads-as-a-result mistake this feature exists to remove. Fetch the bundle:

```bash
GET /api/v1/packages/{owner}?type=generic&limit=10     # list versions; take the newest for the job
```

List the versions rather than constructing `<run_number>--<job>`: `run_number` is per-workflow while
the bundle is named from the repository-wide `GITHUB_RUN_ID`, so a constructed name 404s and reads as
"no bundle was published" (see [docs/runbooks/ci-diagnostics.md](../../../docs/runbooks/ci-diagnostics.md)).

## Why this channel

`ci-failure-digest.mjs`'s `selectSources` ranks a `step:` source **0** — above `_ps.txt`, above
unhealthy-container logs, above everything. The digest is tail-biased and keeps at most
`DIGEST_MAX_SOURCES = 3` sources, so a line buried early in a multi-thousand-line BFF container log
would be dropped. The alternatives were considered and rejected in [../research.md §R6](../research.md):
the container-log artifact is not readable through the forge API, and `~/mcm-ci-last-failure` needs host
SSH.
