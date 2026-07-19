# Phase 1 Data Model: CI Self-Serve Diagnostics

**Feature**: 042-ci-self-serve-diagnostics | **Date**: 2026-07-19

No database. The "model" here is the set of in-memory shapes the two scripts exchange with the forge
API, plus the identity and state rules that make them correct. Field names below are the actual
property names used in code.

---

## Entity: `CheckState` (enumeration)

The classifier's output. **Getting this enum right is the feature's highest-risk logic** — two of the
five values are traps that the raw API reports incorrectly.

| Value | Meaning | Counts toward merge? | Source of truth |
|---|---|---|---|
| `passed` | Completed successfully | ✅ satisfied | status `success` |
| `failed` | Genuinely failed | ❌ blocks | status `failure` **and** run not cancelled |
| `skipped` | Gated out; trigger paths untouched | ✅ **satisfied** (FR-012) | status resolves to `success`/`skipped` |
| `waiting` | Queued or running | ⏳ neither — keep polling (FR-013) | status `pending` |
| `superseded` | Run cancelled by a newer push | ➖ excluded entirely (FR-014) | **run.status**, not the context status |

### The two traps, stated explicitly

- **`skipped` → satisfied.** A gated job that skips settles to `success`. Treating it as pending makes
  a green PR look blocked forever. Fails *safe* (an unnecessary wait).
- **`superseded` ≠ `failed`.** The commit-status endpoint reports a cancelled run's contexts as
  `failure` for a commit that was never broken. **The run's own `status` field must be cross-checked
  before any failure is announced.** Fails *loud* — it announces a broken build that isn't — so it is
  the worse of the two. The tell: every job dies together on a change that could not have affected
  them all.

### State transitions

```text
        ┌──────────────► superseded   (newer push cancels the run; terminal)
        │
waiting ┼──────────────► passed       (terminal)
        ├──────────────► failed       (terminal)
        └──────────────► skipped      (terminal)
```

`waiting` is the only non-terminal state. Nothing transitions *out of* a terminal state — a retry
produces a **new** run, which is why digest upsert (below) is keyed by job rather than by run.

---

## Entity: `CheckRun`

One execution of one pipeline against one commit. **Terminology**: the spec and this document say
*check run*; plan.md and tasks.md say *job*. They denote the same thing — the spec-level term is
channel-agnostic, the implementation-level term matches the runner's vocabulary.

| Field | Type | Notes |
|---|---|---|
| `runId` | number | Forge run id; part of bundle identity |
| `workflow` | string | e.g. `app-ci` |
| `jobName` | string | e.g. `app-e2e` |
| `headSha` | string | Full 40-char commit SHA — **the primary query key** (R6) |
| `event` | string | `push` \| `pull_request` \| `workflow_dispatch`; selects the publication channel |
| `prNumber` | number \| null | Present only for `pull_request`; null selects the commit-status path |
| `state` | `CheckState` | Classified, not raw |
| `required` | boolean | Whether the context is in the branch-protection required set |
| `conclusion` | string | Raw upstream value, retained for diagnosis of misclassification |

**Validation rules**

- `headSha` must be a full SHA. Abbreviated SHAs are rejected — `?head_sha=` is an exact-match
  server-side filter and a short SHA silently returns nothing, which would read as "no runs".
- `state` is always derived through the classifier; raw `conclusion` is never used directly for the
  verdict.
- `required` is derived from the configured required-context list, matched by **glob** (`guardrails*`,
  `app-ci / app-e2e*`) — a zero-match glob is treated as satisfied, matching branch-protection
  behavior.

---

## Entity: `MergeVerdict`

The roll-up that actually determines mergeability. Not "no job failed".

| Field | Type | Notes |
|---|---|---|
| `mergeable` | boolean | True when every required context is `passed` or `skipped` |
| `blocking` | `CheckRun[]` | Required contexts in `failed` |
| `waiting` | `CheckRun[]` | Required contexts still `waiting` — non-empty means poll, not fail |
| `advisory` | `CheckRun[]` | **Non-required** failures (FR-011b) — reported, never blocking |
| `superseded` | `CheckRun[]` | Excluded from the verdict entirely |

**Computation** (FR-011a): over **required contexts only**.

```text
mergeable = required.every(c => c.state ∈ {passed, skipped})
```

A failing non-required check (`prod-apk`, `dast`, `trigger-cd`) lands in `advisory` and leaves
`mergeable` untouched. Both failure modes are guarded: a false "blocked" report, and a silently
dropped real regression.

---

## Entity: `FailureDigest`

The published artifact. Small, redacted, tail-biased.

| Field | Type | Cap | Notes |
|---|---|---|---|
| `marker` | string | — | `<!-- ci-digest:job=<job_slug> -->` — the upsert key (FR-007) |
| `workflow`, `jobName`, `stepName` | string | — | FR-002 |
| `headSha`, `prNumber`, `runId` | — | — | FR-002 |
| `excerpts` | `{source, text, truncated}[]` | 200 lines / 32 KB **per source** | **Tail-biased** (FR-003) |
| `containerHealth` | object \| null | included in cap | Present only on `kvm` jobs (R7) |
| `bundleRef` | string | — | Pointer to the evidence bundle (FR-006) |
| `absentEvidence` | string[] | — | What could not be collected and why — degradation is stated, not silent (D5) |

**Validation rules**

- Every field passes `redactForPublication` before publication (FR-005).
- **Fail-closed**: if a detection rule still matches after redaction, that excerpt is dropped and
  replaced with an explicit note. Publication never proceeds with a suspected-unredacted excerpt.
- Excerpts are taken from the **end** of the source. A head-biased excerpt is worthless — failures
  surface last.
- **Not produced at all** when the run is `superseded` (FR-001a).

### Upsert identity

Keyed by `job_slug` **within a pull request**, so a retried job edits its own comment instead of
stacking. Two different jobs failing on the same PR produce two comments; the same job failing three
times produces one, edited twice.

---

## Entity: `EvidenceBundle`

| Field | Type | Notes |
|---|---|---|
| `packageName` | string | `ci-failures` (constant) |
| `version` | string | **`{runId}--{jobSlug}`** — per run *and* job (clarified FR-006) |
| `filename` | string | `bundle.tar.zst` |
| `contents` | archive | Full logs, full `.State.Health` records, test artifacts |
| `publishedAt` | timestamp | Drives retention |

**Identity rule (the clarified one).** Keying by run alone would let two jobs failing in the same run
overwrite each other — and jobs fail together routinely, most notably when a cancelled run fails every
context at once. The version therefore carries the job.

**Retention** (FR-021/021a/021b): 30 days, pruned opportunistically at publish time. A pruning failure
must not fail the publish, and must not fail the job. Accepted trade-off: if failures stop entirely,
expired bundles linger until the next failure publishes.

**Size cap** (NFR-003): 5 MB — ≈40 s to retrieve at the measured 135 KB/s.

---

## Cross-cutting invariants

1. **Never announce a failure without cross-checking the run's own state** (FR-014). Applies to both
   the read classifier and the write-side publish guard — the two sides must agree on what "failed"
   means, or one publishes noise the other suppresses.
2. **Never emit a raw API payload** (FR-016). Responses cache to the scratchpad; only distillations
   surface. The unfiltered runs listing is 12.4 MB.
3. **Never emit the forge host** (FR-017). Redaction to `<forge>` happens by construction on every
   output path, matched by shape so the redactor never embeds the literal it protects.
4. **Never change a job's outcome** (FR-009). Every write-side step is `if: always()` +
   `continue-on-error: true`, and every failure inside the script is swallowed after being reported.
