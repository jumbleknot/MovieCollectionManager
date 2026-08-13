# Phase 0 research — close the dependency-refresh gaps 057 left open

**Feature**: `058-dependency-refresh-loop` · **Date**: 2026-08-13

Every measurement below was taken on this branch's merge-base with `main` (`d615cb7`) on 2026-08-13.
Where a claim is reproduced from an earlier artifact it is marked as such and re-verified here, because
this feature exists partly because an unverified claim was carried forward (see R6).

---

## R1 — Does enabling `lockFileMaintenance` inherit the repository's schedule window?

**Decision**: No. It **must** be given its own explicit `schedule`, and the guard test must fail if it
is ever removed.

**Rationale**: Verified against the pinned major itself (`renovate@44.29.3`, the version
`renovate.yml` resolves), not from documentation or memory. The option carries a schedule in its own
default object:

```js
// node_modules/renovate/dist/config/options/index.js
{ name: "lockFileMaintenance",
  default: { enabled: false, recreateWhen: "always", branchTopic: "lock-file-maintenance",
             commitMessageAction: "Lock file maintenance", schedule: ["before 4am on monday"], … } }
```

Then exercised through renovate's own config resolver rather than reasoned about:

| Input config | Effective `lockFileMaintenance` schedule |
| --- | --- |
| defaults only | `["before 4am on monday"]` (`enabled: false`) |
| `schedule: ["* 2-4 * * 5"]` + `lockFileMaintenance: { enabled: true }` | **`["before 4am on monday"]`** |
| the same, plus `lockFileMaintenance.schedule: ["* 2-4 * * 5"]` | `["* 2-4 * * 5"]` |

The middle row is the trap: the top-level `schedule` does **not** propagate, because the option's own
default already occupies that key and `mergeChildConfig` lets the child win.

**Why this matters here specifically.** `before 4am on monday` in `America/New_York` is Monday
04:00–08:00 UTC under EDT and Monday 05:00–09:00 UTC under EST. The workflow's two triggers are
`0 3 * * *` (nightly, 03:00 UTC — Sunday 23:00 local on the Monday run) and `0 7 * * 5` (Friday).
**Neither intersects the inherited window under either offset.** Enabling the feature the obvious way
therefore produces a setting that is on and can never fire, reporting nothing — which is #153 exactly,
the fault 057 was created to fix.

**Alternatives considered**:
- *Rely on the top-level `schedule`.* Measured false, above.
- *Give it a distinct window of its own* (e.g. a second cron). Rejected under the operator's cadence
  decision: it doubles the cron surface the guard must pin, for no measured benefit.
- *Set `schedule: []` / "at any time".* Rejected — it would let a refresh land outside the reviewed
  window, defeating the point of having one.

---

## R2 — Where exactly does the pull-request end-to-end gate diverge from the push gate?

**Decision**: Add `pnpm-lock.yaml` and `pnpm-workspace.yaml` to the `changes` job's `app` filter and to
the `push:` paths; add neither to `mobile`.

**Rationale**: Measured in `.forgejo/workflows/app-ci.yml`:

| File | `push:` paths (line 38) | `changes.app` (82–92) | `changes.mobile` (99+) |
| --- | --- | --- | --- |
| `pnpm-lock.yaml` | ✅ present | ❌ **absent** | ❌ absent |
| `pnpm-workspace.yaml` | ❌ **absent** | ❌ **absent** | ❌ absent |
| `Cargo.lock` | ✅ present | ❌ absent | ❌ absent |

`app-e2e` is a single job gated by `if: needs.changes.outputs.app == 'true'` (line 252). The emulator
half is gated *per step* on `needs.changes.outputs.mobile` (lines 813, 845, 859, 893), each with an
existing `mobile-e2e` label escape hatch. So the operator's chosen option is a filter edit only — no
job restructuring, and the emulator exclusion is already implemented.

**`Cargo.lock` is deliberately left out of scope, and the workflow must say so.** It has the same
`push`/`pull_request` disagreement, but the argument for #186 does not transfer: 057's FR-013 says the
end-to-end tier is the only one that catches a bad **JS** floor because `nx test` passes over a
build-time break. Rust is different — `mc-service-checks` runs `clippy` and the unit tier on *every*
pull request, and both compile the crate, so a bad Cargo floor fails there. Item #186's third
acceptance criterion allows exactly this: the filters may differ provided the file records why. A
comment is therefore part of the deliverable, not an optional nicety.

**Alternatives considered**:
- *Add to `app` and `mobile`.* Rejected by the operator's cost decision; ~35 extra minutes per
  dependency PR on one runner for a native-runtime risk a lockfile bump does not carry.
- *Gate on `overrides:` changes specifically.* Rejected: it exempts precisely the
  `lockFileMaintenance` PRs this feature is about to start producing weekly.

---

## R3 — How is "this step actually ran" provable on this forge?

**Decision**: It is not directly provable. Pin the wiring statically and mutation-test each assertion;
state the residual rather than implying a step list was read.

**Rationale**: `/actions/runs/<id>/jobs` returns 404 here and no log or artifact endpoint exists — the
constraint 057 already hit and recorded in `allowlist-expiry-wiring.guard.test.mjs`. A green job cannot
distinguish "filter matched" from "filter deleted, job ran for another reason". What *is* observable is
a job's reported conclusion (`skipped` vs a real result), which is how #186 was measured on PR #185 and
PR #187 — so the top-level claim ("a lockfile-only PR runs the tier") is observable even though the
step-level claim ("the emulator half did not run") is not.

Split accordingly:
- **Observable, and must be observed**: the end-to-end job's conclusion on a real lockfile-only PR.
- **Not observable, so pinned by test**: that the filter selects the files, that `mobile` does not,
  that `mobile ⊆ app`, and that `app-e2e` still consumes `changes.outputs.app`.

**Alternatives considered**: dispatching a run and reading its log — rejected, a *successful* run
publishes no failure digest and its log is unreadable, so success would be indistinguishable from a
step never running.

---

## R4 — What does the gate need in order to name the lever?

**Decision**: A pure function over one normalized finding plus the override map, returning either
nothing or one advice record. No new I/O, no new gate semantics.

**Rationale**: The normalized report already carries everything required. Measured shape from
`security/sast/reports/findings.json`:

```json
{ "scanner": "pnpm-audit", "kind": "sca", "id": "GHSA-…",
  "location": "hono@4.12.29", "fixAvailable": ">=4.12.34",
  "severity": "Medium", "scope": "runtime", "blocking": false }
```

`location` gives package name and **resolved** version; `fixAvailable` gives the fix floor;
`pnpm-workspace.yaml`'s `overrides:` gives the permitted range. The decision is then:

- override range **admits** the fixed version → *refresh the lockfile*
- override range **excludes** it → *raise the floor, both halves*
- no override for that package → *no advice*

The bound parsers this needs (`parseOverrideKey`, `exclusiveUpperBound`, `inclusiveLowerBound`) are
already exported from `check-override-consistency.mjs`. Its version comparator is currently private and
must be exported to be reused. **Exporting is not weakening** — the guard's rule, scope and exit codes
are untouched, and its existing tests must still pass unchanged as proof.

**Per-resolution, not per-package.** `undici` resolves at both 6.27.0 and 7.24.7 while its override
governs only `>=6.27.0 <7`. Keying advice on the package name alone would tell someone to refresh the
lockfile for the 7.x resolution, which the override cannot reach. The 6.x row is a genuine refresh
case; the 7.x rows are not.

**Alternatives considered**:
- *Compute it inside `check-sast-findings.mjs`.* Rejected — that file is the gate; keeping the advice
  in a separate pure module is what makes it unit-testable without touching gate semantics.
- *Re-derive ranges with a semver library.* Rejected — a second range dialect in the repository is how
  the two halves drift apart. Reuse the guard's parsers or the guard stops being the single definition.

---

## R5 — Is there a live reconstruction of the incident, or must one be synthesized?

**Decision**: Both. A committed fixture reconstructs the `fast-uri` case deterministically; the live
cases supply the end-to-end demonstration.

**Rationale**: Measured against `main` on 2026-08-13 by cross-referencing the current findings report
with the override map:

| Package | Override value | Lockfile resolves | Fix floor | Advisories | Blocking today |
| --- | --- | --- | --- | --- | --- |
| `hono` | `>=4.12.25` | 4.12.29 | `>=4.12.34` | 4 | no (Medium/Low) |
| `undici` (6.x) | `>=6.27.0 <7` | 6.27.0 | `>=6.28.0` | 3 | no (Medium) |

Both **runtime** scope. They are the `fast-uri` shape exactly: the range already permits the fix, the
lockfile sits below it, nothing proposes anything. They are non-blocking only because their severities
are Medium/Low — which is the state `fast-uri` occupied between 2026-07-31 (fix published) and
2026-08-03 (advisory published), before it became a ten-day red.

This is why FR-017 requires advice on non-blocking findings: blocking-only advice would first appear at
the moment the finding is already reddening every branch.

The fixture is still required, because the live cases will be remediated by this very feature and the
test must keep failing for the right reason afterwards.

**Baseline to measure against**: 55 findings, 2 blocking (the allowlisted `image-size` pair).

---

## R6 — Where does the superseded "extracts zero dependencies" claim still live?

**Decision**: Correct in place with a dated note; do not rewrite the historical record.

**Rationale**: Measured by search. The claim survives in:

| File | Status |
| --- | --- |
| `renovate.json` | already corrected by 057 — no action |
| `specs/057-dependency-security-loop/tasks.md` | already corrected by 057 — no action |
| `specs/057-dependency-security-loop/research.md` | **stale** (lines ~125, ~127, ~139) |
| `specs/057-dependency-security-loop/spec.md` | **stale** |
| `docs/proposals/PRD-ForgejoIssueTracking.md` | **stale** |

The truth, from run 1704 (2026-08-13, head `6afc2c8`): the built-in npm manager extracts **twelve**
dependencies from `pnpm-workspace.yaml` — ten keyed override floors plus `postcss` and
`@expo/dom-webview` — and the dashboard that run wrote lists pending updates for five of them. There is
no zero baseline to improve on. This matters beyond tidiness: the false premise is what made a regex
`customManager` look like a free win, and it is why #184 was originally filed against the wrong fault.

057's spec and research are a record of what was believed at the time. Rewriting them would destroy the
evidence of how the mis-premise propagated, so each gets a dated correction note pointing here.

---

## R7 — Packaging and ordering

**Decision**: One pull request (PR-A) carrying the whole feature, then a separate lockfile-only pull
request (PR-B) as the observation.

**Rationale**: The spec's FR-025 requires the filter to be in force before the first refresh proposal
can exist. A single PR satisfies it: the filter is live at merge, and the bot can only act on a later
scheduled run. Splitting would add a second ~23-minute end-to-end run for no gain in ordering safety,
against `openwiki/process/pull-request-batching.md`'s batch-by-default rule — and a red would not be
ambiguous here, since the three parts fail in different jobs (`app-e2e`, `guardrails/naming`, the
`node --test` suite).

PR-B is not a packaging choice but the evidence itself: it must touch **only** `pnpm-lock.yaml` for its
end-to-end conclusion to prove anything about the filter. Its content is the remedy the new advice
recommends for `hono` and `undici`, so one pull request discharges both SC-001 and SC-007.

**Ordering within PR-A** is nonetheless preserved task-by-task (US1 before US2), so that a partial
landing — a reviewer taking only the first commits — still cannot produce untested refreshes.

---

## Resolved unknowns

| Unknown | Resolution |
| --- | --- |
| Does `lockFileMaintenance` inherit the global schedule? | No — R1, proven with renovate's own resolver |
| Is `mobile` step-gated or job-gated? | Step-gated; exclusion needs no restructuring — R2 |
| Should `Cargo.lock` be added too? | No, and the reason is recorded in-file — R2 |
| Can a step's execution be observed? | No; conclusion can — R3 |
| Does the advice need new inputs? | No — R4 |
| Is a synthetic reconstruction required? | Fixture yes, but live cases exist — R5 |
| Does exporting a parser weaken the guard? | No; guard tests must pass unchanged as proof — R4 |
