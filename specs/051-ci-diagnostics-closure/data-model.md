# Phase 1 Data Model — 051 CI diagnostics closure

This feature has no database and no application entities. What it does have is a small set of
**on-disk and over-the-wire artefacts** whose shape determines whether a failure is diagnosable. They
are modelled here because getting their state transitions wrong is precisely how the current system
lies.

---

## 1. Step capture

The output of one wrapped CI step, written by `scripts/ci-log-step.sh` and read by
`scripts/ci-failure-digest.mjs` **within the same job and container**.

| Field | Source | Notes |
| --- | --- | --- |
| root | `CI_STEP_LOG_ROOT`, else `$HOME/mcm-ci-step-logs` | Unchanged by this feature — see research R1 |
| run scope | `GITHUB_RUN_ID`, else `local` | Load-bearing: the runner is persistent |
| step name | first wrapper argument | Becomes the digest excerpt's `source` as `step:<name>` |
| content | combined stdout + stderr | stderr inclusion is what makes a stack trace usable |
| failing-step marker | `_failed-step`, first failure only | `set -e` stops the job at the first failure, so the first is the causative one |

**Lifecycle**: created on first wrapped step → appended per step → read by the digest step in the
same job → destroyed with the container (container executor) or pruned at 7 days (host executor).

**Invariant preserved by this feature**: the capture is consumed in-job. No consumer outside the job
depends on it, so it does not need to outlive the container. Any future change that introduces an
out-of-job reader breaks this invariant and must revisit research R1.

**Invariant newly enforced**: a `run:` step in a containerized job either produces a capture or
carries an explicit exemption marker. Today 48 of 83 produce neither.

---

## 2. Failure digest

The distilled, redacted report a job publishes when it fails.

| Field | Notes |
| --- | --- |
| failing step | from the `_failed-step` marker; `_not reported_` when no wrapped step failed |
| excerpts | one per step capture, plus container logs and health where a bundle exists |
| absent | explicit list of evidence that was *not* available — a first-class field, not an omission |
| bundle reference | `ci-failures:<version>` in the generic package registry, plus its URL |
| publication channel | PR comment on `pull_request`; commit status otherwise |
| credential | `CI_DIGEST_TOKEN` today; gains a fallback in Story 4 |

**Design note worth preserving**: `absent` already models "we looked and found nothing" distinctly
from "we did not look". That is the same distinction Story 3 needs one level up, and the new outcome
signal should follow its example rather than invent a different vocabulary.

---

## 3. Digest outcome signal — **new**

The entity this feature adds. Today two of these three states are indistinguishable, which is the
whole of Story 3.

| State | Means | Observable today? |
| --- | --- | --- |
| `not-needed` | The job succeeded, or the run was superseded/cancelled | yes |
| `published` | A digest reached its channel | yes |
| `failed` | The digest step ran, and could not publish | **no — reported as "no digest was published"** |

**Transitions**: a digest step enters `not-needed` or attempts publication; an attempt resolves to
`published` or `failed`. `failed` MUST NOT transition the job's own status — the job outcome and the
digest outcome are independent, and conflating them would make the alarm able to break the build.

**Sub-states of `failed` worth naming separately**, because they call for different actions:

- `failed:no-credential` — no usable token was available (the 2026-08-01 case)
- `failed:forbidden` — a token was present but lacked scope for the endpoint
- `failed:transport` — network, timeout, or an unexpected status

---

## 4. Step-instrumentation coverage record

What `scripts/check-ci-digest-coverage.mjs` evaluates. Today it is per **job**; this feature makes it
per **step**.

| Field | Today | After |
| --- | --- | --- |
| unit of evaluation | job | `run:` step |
| pass condition | job publishes a digest **and** has ≥ 1 wrapped step | every `run:` step is wrapped **or** carries an exemption marker, and the job publishes a digest |
| exemption | `# ci-log-step-exempt:` with a reason, at job level | same marker, also valid at step level |

**Why the change matters**: under the current rule `guardrails / naming` passes with 2 of 16 steps
wrapped, none of which is a gate. The rule is satisfied while the job remains undiagnosable.

---

## 5. E2E environment contract

The set of variables the web E2E suite reads, and whether each must cross into the Playwright
container. Enumerated in research R4; the authoritative list lives in
[contracts/e2e-env-forwarding.md](./contracts/e2e-env-forwarding.md).

**State transition that defines the defect**: a gated spec resolves to `run`, `skip`, or `fail-loud`.
The gate's own logic is correct. The defect is that the input deciding the transition never reaches
the process, so `fail-loud` was unreachable and `skip` was silently chosen — for the agent specs by a
missing `E2E_AGENT_PRODUCTION`, and for the admin specs by a missing `KEYCLOAK_SERVICE_CLIENT_SECRET`.
