# Contract — the run-health signal (`[e2e-turns]`)

**Feature**: 054-app-e2e-reliability-cluster · **Requirement**: FR-009 · **Backlog**: #173 AC-2

## The line

Emitted once per `app-e2e` run by `scripts/e2e-turn-tally.sh`, under `scripts/ci-log-step.sh` so it lands as
a `step:` source (the failure digest ranks those 0, above every container log).

```text
[e2e-turns] gateway_posts=<n> tests_executed=<m> posts_per_100_tests=<r> verdict=<healthy|collapsed|indeterminate>
```

| Field | Meaning |
| --- | --- |
| `gateway_posts` | `POST /agent/movie-assistant` requests the gateway received during the web-E2E window |
| `tests_executed` | `failed + flaky + passed` from the `[e2e-gate]` line the previous step emits |
| `posts_per_100_tests` | `gateway_posts × 100 / tests_executed`, integer — bash has no floats, and a ratio scaled by 100 keeps the comparison exact rather than approximately right |
| `verdict` | the classification below |

## Why it is normalised

The measured discriminator in #173 is a whole-run count:

| run | failed | gateway POSTs | Anthropic calls | posts/100 tests |
| --- | ---: | ---: | ---: | ---: |
| 1614 (healthy) | 9 | 169 | 114 | **95** |
| 1619 (healthy) | 1 | 155 | 99 | **88** |
| 1621 (collapsed) | 28 | 43 | 26 | **24** |
| 1622 (collapsed) | 26 | 56 | 34 | **32** |
| 1633 (collapsed) | 30 | 39 | 24 | **22** |

(177 tests collected in each, from PRD §1.1.)

A bare threshold on `gateway_posts` becomes wrong the first time a spec is added, a spec is removed, or the
mobile half is path-gated out — and it becomes wrong **silently**, reporting `collapsed` for a run that
merely got smaller. Dividing by the executed count keeps the signal meaningful as the suite changes.

**The denominator is tests, not spec files.** An earlier draft of this contract said "per spec file" and
quoted 17–19 against 1.4–2.2. That was arithmetic on a guessed file count, not a measurement, and it is
wrong — there are 23 agent/dock spec *files*, which would give ≈6.7. The numbers above are computed from the
177-test total the PRD actually recorded. Corrected during T012 rather than carried forward: it is the same
class of unchecked claim this whole feature exists to stop.

## Classification

| Condition | `verdict` |
| --- | --- |
| the gateway log is unreadable, or `tests_executed` is 0 / unparseable | `indeterminate` |
| `posts_per_100_tests` **≥ 50** | `healthy` |
| otherwise | `collapsed` |

**The floor is 50**, sitting between a measured healthy minimum of 88 and a measured collapsed maximum of
32 — 1.8× below the lowest healthy run and 1.6× above the highest collapsed one. The gap, not the precision
of the number, is what makes a crude threshold workable.

`indeterminate` is a first-class outcome, not a fallback. It carries the same `0`-vs-`unavailable`
distinction `e2e-contention-tally.sh` already makes: a measurement that could not be taken must never read as
a good one.

## ⚠️ The threshold is heuristic, calibrated on five runs

It is **a triage aid, not a proof**. Five runs is a small calibration set. The two populations are well
separated on it, which is what makes the threshold usable at all — but a run near the boundary is a run to
read by hand, not one to trust the `verdict` on.

Two consequences, both deliberate:

- **It labels; it does not gate.** A collapsed run already fails on its test failures. Failing it a second
  time adds nothing and buys a new false-failure mode.
- **A `healthy` verdict is not evidence a run was correct**, only that turns were being sent at the usual
  rate. It is what makes a *failure* interpretable, not what makes a pass trustworthy.

Recalibrate when the agent spec set changes materially, and record the run ids the new floor came from.

## ⚠️ The floor does NOT apply to a gate-only run (added 2026-08-13)

Feature 056 split the suite, and a `pull_request` now runs the **gate tier alone** — 19 of the 41
agent tests, several of which drive no model turn at all. The floor of 50 was calibrated on the FULL
suite, where the model-decision tests drive most of the turns.

MEASURED on PR #181: `failed=0 flaky=1 passed=154` — green by every count — and 49 posts over 155
tests = **31 per 100**, which the floor called `collapsed`. A confident wrong label on every pull
request would teach people to ignore this field, which is the re-run reflex the signal exists to
remove.

So a gate-only run emits **`verdict=indeterminate` with the reason**, and still reports the raw
numbers. Abstaining from a verdict is not abstaining from the data. One gate-only sample is not a
calibration — the same standard this contract already applies to the original five.

Signalled by **`E2E_TURN_TIER=gate`**, set by the workflow, not inferred from an absent model counts
file: a LOCAL full-suite run has none either, and must keep its verdict.

**To retire this**: collect gate-only samples across several green PRs, then set a gate floor here with
the run ids it came from — exactly as the original floor records its five.

## Naming

`verdict` is the **canonical name** for this concept across `spec.md`, `plan.md` and this contract. It is
the field the CI line actually emits, so calling it a "label" or a "run-health signal" in prose creates a
second vocabulary for one thing.

## Where it is read

- On a **failing** run: in the published failure bundle, as a `step:` source.
- On a **passing** run: in the counts bundle published by `ci-failure-digest.mjs` in `counts` mode (FR-005).
  Before that existed, a green run left no bundle at all and this line was unreadable — which is #167.

## Ordering constraints — two, and both produce a wrong answer rather than a break

1. **Before `Tear down CI stacks (always)`**, which removes the container the count is read from. A step
   ordered after it reports zeros for a structural reason and looks like a clean result — the trap
   `e2e-contention-tally.sh` documents.
2. **After `E2E result gate`**, because that step's log is where `tests_executed` comes from. A missing
   counts line yields `indeterminate` — never a divide-by-zero, and never a confident wrong answer.

The script MUST always exit 0. `grep -c` exits 1 on a zero count, and under `ci-log-step.sh` — which
re-raises the wrapped command's exit code by design — that would fail the job with a diagnostic that had good
news to report.
