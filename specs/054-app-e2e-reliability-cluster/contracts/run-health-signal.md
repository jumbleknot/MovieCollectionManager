# Contract — the run-health signal (`[e2e-turns]`)

**Feature**: 054-app-e2e-reliability-cluster · **Requirement**: FR-009 · **Backlog**: #173 AC-2

## The line

Emitted once per `app-e2e` run by `scripts/e2e-turn-tally.sh`, under `scripts/ci-log-step.sh` so it lands as
a `step:` source (the failure digest ranks those 0, above every container log).

```text
[e2e-turns] gateway_posts=<n> agent_specs_executed=<m> posts_per_spec=<r> verdict=<healthy|collapsed|indeterminate>
```

| Field | Meaning |
| --- | --- |
| `gateway_posts` | POSTs the agent gateway received during the web-E2E window |
| `agent_specs_executed` | agent/dock tests executed in that window, from the `e2e-result-gate` counts |
| `posts_per_spec` | `gateway_posts / agent_specs_executed`, to one decimal |
| `verdict` | the classification below |

## Why it is normalised

The measured discriminator in #173 is a whole-run count:

| run | failed | gateway POSTs | Anthropic calls |
| --- | ---: | ---: | ---: |
| 1614 (healthy) | 9 | 169 | 114 |
| 1619 (healthy) | 1 | 155 | 99 |
| 1621 (collapsed) | 28 | 43 | 26 |
| 1622 (collapsed) | 26 | 56 | 34 |
| 1633 (collapsed) | 30 | 39 | 24 |

A bare threshold on `gateway_posts` becomes wrong the first time a spec is added, a spec is removed, or the
mobile half is path-gated out — and it becomes wrong **silently**, reporting `collapsed` for a run that
merely got smaller. Dividing by the executed count keeps the signal meaningful as the suite changes.

## Classification

| Condition | `verdict` |
| --- | --- |
| `agent_specs_executed == 0`, or the gateway log is unreadable | `indeterminate` |
| `posts_per_spec` at or above the healthy floor | `healthy` |
| otherwise | `collapsed` |

`indeterminate` is a first-class outcome, not a fallback. It carries the same `0`-vs-`unavailable`
distinction `e2e-contention-tally.sh` already makes: a measurement that could not be taken must never read as
a good one.

## ⚠️ The thresholds are heuristic, calibrated on five runs

The healthy floor is derived from the table above and is **a triage aid, not a proof**. Five runs is a small
calibration set, the two populations are well separated on it (healthy ≈ 17–19 posts/spec against collapsed
≈ 1.4–2.2 on the same suite), and the gap is what makes a crude threshold workable — but a run near the
boundary is a run to look at by hand, not one to trust the label on.

Two consequences, both deliberate:

- **It labels; it does not gate.** A collapsed run already fails on its test failures. Failing it a second
  time adds nothing and buys a new false-failure mode.
- **A `healthy` label is not evidence a run was correct**, only that turns were being sent at the usual rate.
  It is what makes a *failure* interpretable, not what makes a pass trustworthy.

Recalibrate when the agent spec set changes materially, and record the run ids the new floor came from.

## Where it is read

- On a **failing** run: in the published failure bundle, as a `step:` source.
- On a **passing** run: in the counts bundle published by `ci-failure-digest.mjs` in `counts` mode (FR-005).
  Before that existed, a green run left no bundle at all and this line was unreadable — which is #167.

## Ordering constraint

The step MUST run **before** `Tear down CI stacks (always)`, which removes the container the count is read
from. A step ordered after it reports zeros for a structural reason and looks like a clean result — the same
trap `e2e-contention-tally.sh` documents.

The script MUST always exit 0. `grep -c` exits 1 on a zero count, and under `ci-log-step.sh` — which
re-raises the wrapped command's exit code by design — that would fail the job with a diagnostic that had good
news to report.
