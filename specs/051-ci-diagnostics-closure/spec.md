# Feature Specification: CI diagnostics gap closure and E2E agent-gate fix

**Feature Branch**: `051-ci-diagnostics-closure`

**Created**: 2026-08-09

**Status**: Draft

**Input**: Backlog items #158, #156, #157 and #155, combined into one feature at the operator's
direction and shipping as a single pull request. The input document for #156 is
[docs/proposals/PRD-CIDiagnosticsGapClosure.md](../../docs/proposals/PRD-CIDiagnosticsGapClosure.md)
(Status: Proposed, created 2026-08-02).

## Context

Two distinct failures share one cause-class: **a step was containerized, and something that had to
cross the container boundary did not**.

| Direction | Item | Symptom |
| --- | --- | --- |
| Output does not come **out** — step logs are written inside the container and destroyed at teardown | #156 | A failure nobody can diagnose |
| Input does not go **in** — an environment flag set on the runner is not forwarded to `docker run` | #158 | A pass for a suite that never ran |

Both produce a job that tells you nothing true. One hides *why* it broke; the other hides *that it
never happened*. Two further items ride along because they touch the same files and the same
knowledge: a Windows-only assertion failure in the very test suite that guards CI diagnostics (#157),
and two undocumented cargo behaviours that cost a session and are recorded nowhere a future session
would look (#155).

**Already resolved, recorded here so it is not re-planned.** PRD §1.3 claimed
`check-ci-digest-coverage.mjs` fails on a clean tree. Re-measured on a clean checkout 2026-08-09:
`✓ ci-digest coverage gate passed (every job in 7 workflow(s) publishes a guarded failure digest)`,
exit 0. All three jobs the PRD named are covered. It is **out of scope** and its PRD success criterion
SC-3 is satisfied as-is.

## User Scenarios & Testing *(mandatory)*

The user in every story below is a **developer or coding agent diagnosing a red CI run**, except
US6 whose user is a future session reaching for cargo.

### User Story 1 - The required E2E gate actually exercises the agent surface (Priority: P1)

`app-ci / app-e2e` is a required merge gate. Its web half sets `E2E_AGENT_PRODUCTION` at the job
level and deploys the agent stack, but runs Playwright inside a container that is never told about
the flag. Every `agent-*.spec.ts` therefore skips, and the gate reports green. A developer merging a
change to the conversational assistant believes it was regression-tested. It was not, and never has
been.

**Why this priority**: It is a false green on a required gate covering an entire product surface —
the highest-severity failure mode a test harness has, because it actively misinforms rather than
merely omitting.

**Independent Test**: Run the CI Playwright invocation verbatim with and without the flag and compare
executed-versus-skipped counts for the agent specs. Delivers value alone: the gate starts covering
what it claims to cover, regardless of whether any other story ships.

**Acceptance Scenarios**:

1. **Given** the agent stack is deployed and the web E2E suite runs in CI, **When** the run
   completes, **Then** the agent specs report a non-zero executed count and a zero skip count.
2. **Given** the agent stack is *not* reachable, **When** the web E2E suite runs in CI, **Then** the
   run fails loudly naming the missing stack, rather than skipping and reporting success.
3. **Given** an environment flag the web E2E suite depends on, **When** the suite runs in CI,
   **Then** that flag's value inside the container matches its value on the runner.

---

### User Story 2 - A failing containerized job leaves output that outlives the container (Priority: P1)

Of the `runs-on` declarations across `.forgejo/workflows/`, the large majority are the container
executor — including every `guardrails` job and `mc-service-checks`. Their wrapped step logs are
written to a path inside the container and destroyed at teardown, so a developer diagnosing any
guardrail failure has no output at all and must ask a human to paste logs.

**Why this priority**: This is the load-bearing gap. The two 2026-08-01 incidents were each diagnosed
by inference over hours; each root cause was a one-line fact a single line of output would have named.

**Independent Test**: Deliberately fail a containerized job, then diagnose it using only the
self-serve status tooling — no human paste, no SSH.

**Acceptance Scenarios**:

1. **Given** a containerized job whose wrapped step fails, **When** the run finishes, **Then** the
   captured output of that step is retrievable after the container is gone.
2. **Given** two runs on the same persistent runner, **When** either is inspected, **Then** it shows
   only its own output — one run's output is never attributed to another.
3. **Given** captured output containing a credential-shaped string, **When** that output is published
   anywhere, **Then** the credential is redacted on the same terms as today's digest.
4. **Given** captured output from an earlier run older than the retention window, **When** a later
   run executes, **Then** the old output is pruned.

---

### User Story 3 - A digest that fails to publish says so, loudly (Priority: P2)

The failure digest runs as a `continue-on-error` step ending in an unconditional success exit. When
it breaks, the reporting tool says *"no digest was published"* — the identical message it emits when
no digest was needed. A silent alarm is worse than no alarm, because it is trusted.

**Why this priority**: It is what makes Story 2 trustworthy. Without it, a developer cannot tell a
working diagnostic channel from a broken one, so they cannot rely on either.

**Independent Test**: Deliberately break the digest step and confirm the report names it as broken
rather than absent.

**Acceptance Scenarios**:

1. **Given** the digest step runs and fails, **When** the failure report is requested, **Then** it
   states that the digest ran and failed, distinctly from "no digest was published".
2. **Given** the digest step is not needed (the job succeeded, or the run was superseded), **When**
   the failure report is requested, **Then** it does not claim a broken digest.
3. **Given** the digest step fails for any reason, **When** the job completes, **Then** the job's own
   pass/fail outcome is unchanged — a broken digest never fails a build.

---

### User Story 4 - The diagnostic channel survives a run with no secrets (Priority: P2)

The digest authenticates with a purpose-scoped Actions secret. On a run where secrets are empty, it
cannot authenticate — precisely when a run is most likely to be failing for a confusing reason. The
failure mode disables its own alarm.

**Why this priority**: The specific trigger that caused this on 2026-08-01 is now mitigated by a
process rule, but a process rule is not a technical control, and the dependency remains.

**Independent Test**: Run the digest path with the secret unset and confirm a signal still reaches
the developer without it.

**Acceptance Scenarios**:

1. **Given** a failing job on a run where the purpose-scoped secret is empty, **When** the digest
   step runs, **Then** a signal naming the failing step is still published through a channel the
   run's automatically-provisioned credential can write.
2. **Given** the purpose-scoped secret is present, **When** the digest step runs, **Then** the
   existing richer publication path is used unchanged — the fallback does not displace it.
3. **Given** the fallback channel has a size limit, **When** it is used, **Then** it carries enough
   to name the fault and a pointer to the fuller output, and is truncated safely rather than failing.

---

### User Story 5 - The diagnostics test suite is green on Windows (Priority: P3)

One case in the test suite that guards CI diagnostics compares a fully-resolved path against a joined
path. On Windows those differ by the drive root, so a developer running the suite locally sees a red
test that is not their fault. CI is Linux, so it stays green there — which is exactly the problem: a
red test nobody caused trains people to ignore red.

**Why this priority**: Small and self-contained, and it affects local developer experience rather
than a merge gate.

**Independent Test**: Run the suite on Windows and on Linux.

**Acceptance Scenarios**:

1. **Given** the suite runs on Windows, **When** the affected cases execute, **Then** they pass.
2. **Given** the suite runs on Linux, **When** the affected cases execute, **Then** they still pass.
3. **Given** a path that genuinely escapes the bundle root, **When** the affected cases execute,
   **Then** they still fail — the fix must not weaken what the test proves.

---

### User Story 6 - The cargo traps are written where a future session will look (Priority: P3)

Two cargo behaviours in this dev container are counter-intuitive, cost a session during feature 046,
and are recorded only inside a closed feature's task notes. A repository-wide search of the runbooks,
the knowledge bundle and the agent context finds neither.

**Why this priority**: Documentation only, no runtime effect, but it is cheap and the alternative is
re-deriving both the hard way.

**Independent Test**: Search the documented locations for each fact and find it stated with its
corollary.

**Acceptance Scenarios**:

1. **Given** a session hits a hanging dependency resolution, **When** it consults the dev-container
   runbook, **Then** it finds both the offline-resolution behaviour and the corollary that a failing
   offline resolve means the change adds a package absent from the lock file.
2. **Given** a session intends to format a single Rust file, **When** it consults the knowledge
   bundle, **Then** it finds that the per-file invocation reformats the whole crate, the correct
   single-file alternative, the recovery step, and the "format only what you touch" convention with
   its pre-existing-drift context.
3. **Given** a reader asks whether the Rust toolchain exists in the dev container, **When** they read
   the toolchain-scope section, **Then** it does not tell them the toolchain is deferred.
4. **Given** documentation changes land, **When** the knowledge index and lint gates run, **Then**
   the index is regenerated by its generator rather than hand-edited, and the governance and lint
   gates pass.

### Edge Cases

- **The container executor may not persist the workspace to the host.** Story 2's approach assumes it
  does. If that assumption is false, an alternative persistence route is required. This is the single
  assumption whose failure invalidates the design, so it is verified on the runner first, before any
  Story 2 work.
- **The agent specs may fail once they finally run.** Story 1 makes previously-skipped specs execute
  for the first time. Any failures they reveal are pre-existing product or harness defects, not
  regressions introduced here. They must be triaged and either fixed or attributed to a baseline with
  evidence — never silenced by reverting to the skip.
- **A failing digest must not cascade.** Making digest failure loud must not make it fatal.
- **Deliberate breakage must not reach `main`.** Stories 2-4 are proven by intentionally failing a
  job on this branch; those commits must be reverted before the pull request merges, and the branch
  must be verified clean of them.
- **Two runs sharing a persistent runner** must not have their output cross-attributed once logs move
  to a shared location.

## Requirements *(mandatory)*

### Functional Requirements

**Story 1 — E2E agent gate**

- **FR-001**: The containerized web E2E invocation MUST receive the agent-production flag with the
  same value it holds on the runner.
- **FR-002**: The containerized web E2E invocation MUST assert that the agent stack is required, so
  an unreachable stack fails the run instead of skipping it.
- **FR-003**: The set of environment variables the web E2E suite reads MUST be reconciled against the
  set the containerized invocation forwards, by enumeration rather than inspection, and every
  material omission found MUST be fixed or explicitly recorded as intentionally absent.

**Story 2 — containerized step logs**

- **FR-004**: Before any change to log placement, the runner's container-executor behaviour regarding
  workspace persistence MUST be measured and the result recorded in the plan.
- **FR-005**: Wrapped step output from a containerized job MUST be retrievable after the job's
  container is destroyed.
- **FR-006**: Persisted output MUST remain scoped per run, so output from one run is never presented
  as another's.
- **FR-007**: Persisted output MUST be pruned on the existing retention window.
- **FR-008**: Any newly persisted output that is published MUST pass through the existing redaction
  before publication.
- **FR-009**: Persisted output MUST NOT become a tracked change in the repository.

**Story 3 — loud digest failure**

- **FR-010**: A digest step that runs and fails MUST leave a distinguishable signal that it ran and
  failed.
- **FR-011**: The failure-reporting tool MUST report "the digest ran and failed" separately from "no
  digest was published".
- **FR-012**: A digest failure MUST NOT change the job's own outcome.

**Story 4 — secretless survival**

- **FR-013**: When the purpose-scoped digest credential is absent, the digest MUST fall back to a
  channel writable by the run's automatically-provisioned credential.
- **FR-014**: The fallback MUST carry the failing step's identity and a pointer to fuller output, and
  MUST truncate safely within that channel's size limit.
- **FR-015**: When the purpose-scoped credential is present, behaviour MUST be unchanged.

**Story 5 — Windows-safe assertions**

- **FR-016**: The affected assertions MUST compare paths in a form that is identical on Windows and
  Linux, without loosening what they assert.
- **FR-017**: The other cases in the same block MUST be checked for the same defect and fixed if
  present.

**Story 6 — documentation**

- **FR-018**: The dev-container runbook MUST document the offline dependency-resolution behaviour and
  its lock-discipline corollary.
- **FR-019**: A canonical knowledge-bundle concept MUST document the whole-crate formatting scope
  trap, the single-file alternative, the recovery step, and the "format only what you touch"
  convention including the pre-existing drift and lint-gate context that makes it meaningful.
- **FR-020**: The stale toolchain-scope claim that the Rust and Python toolchains are deferred MUST
  be corrected.
- **FR-021**: The knowledge index MUST be regenerated by its generator, not hand-edited, and the
  governance and lint gates MUST pass.

**Cross-cutting**

- **FR-022**: Every claim of success in this feature MUST be evidenced by an observed result — an
  executed-test count, a retrieved log, a published signal — never by an exit status alone.
- **FR-023**: Commits that deliberately break CI for demonstration purposes MUST be reverted before
  merge, and their absence verified on the branch tip.

### Key Entities

- **Wrapped step output**: The combined standard output and error of one named CI step, scoped to the
  run that produced it, subject to retention and redaction.
- **Failure digest**: The distilled report published when a job fails, carrying the failing step's
  identity and its output excerpt. Has a publication channel and an authenticating credential.
- **Digest outcome signal**: The three-way distinction between "no digest was needed", "a digest was
  published", and "the digest ran and failed" — today the first and third are indistinguishable.
- **Agent stack gate**: The suite-level control that decides whether agent specs run, are skipped, or
  fail loudly, driven by environment flags that must reach the process being gated.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: A CI run of the required E2E gate shows a non-zero executed count and a zero skip count
  for the agent specs. Evidenced by the counts themselves, not by the job's exit status.
- **SC-002**: A deliberately failed containerized job is diagnosed to its root cause using only the
  self-serve status tooling — no human pasting logs and no shell access to the runner.
- **SC-003**: A deliberately broken digest step yields a report naming it as broken, never as absent.
- **SC-004**: A failing job on a run with no available purpose-scoped credential still surfaces the
  failing step's identity to the developer.
- **SC-005**: The 2026-08-01 empty-credential failure is reproduced, and its cause is readable from
  CI output alone within five minutes of the run finishing.
- **SC-006**: The diagnostics test suite passes on Windows and on Linux, and still fails when given a
  path that escapes the bundle root.
- **SC-007**: Each of the two cargo facts is found by searching the documentation locations a session
  would actually consult, and the governance and lint gates pass on the result.
- **SC-008**: The branch tip carries no deliberate-breakage commit.

SC-002 and SC-005 MUST be demonstrated by actually breaking a job, not by inspection. Both incidents
this feature closes were prolonged by treating a green run as evidence when it never exercised the
failing path.

## Assumptions

- **Operator-directed batching.** These four items ship as one feature and one pull request at the
  operator's explicit direction, consistent with the repository's batching convention given a single
  CI runner and a long E2E job. Item #158's own analysis recommended keeping it separate as a p1;
  that recommendation was considered and overridden.
- **Windows verification is the operator's.** The development container is Linux, so US5 is
  implemented and proven on Linux here; the Windows run is performed by the operator, and backlog
  item #157 stays open until they confirm it.
- **Deliberate breakage happens on this branch.** SC-002 and SC-005 are demonstrated with temporary
  commits on `051-ci-diagnostics-closure`, reverted before merge, rather than on a separate throwaway
  branch.
- **PRD §1.3 is closed, not deferred.** Verified by measurement on 2026-08-09 and excluded from scope.
- **Retention and redaction semantics carry over.** The existing per-run scoping, retention window and
  redaction behaviour are correct; this feature preserves them across a change of location rather than
  redesigning them.
- **Story 1's fix may surface pre-existing agent-spec failures.** Triaging those is in scope for this
  feature; fixing arbitrary product defects they reveal may be split to the backlog if the scope grows
  beyond the harness.
- **The digest already possesses a commit-status publication path**, so Story 4 is expected to be a
  credential-selection change rather than new publication machinery. The plan verifies this.

## Out of Scope

- Adding a log or artifact API to the forge — it has none, and the diagnostics design is already
  inverted around that absence.
- Moving jobs between executors for their own sake. Executor choice is driven by real constraints.
- Shipping logs to an external service, or retention beyond the existing window.
- PRD §1.3 (`check-ci-digest-coverage.mjs` clean-tree failure) — verified resolved, see Context.

## Traceability

| Backlog item | Story | PRD section |
| --- | --- | --- |
| #158 (p1, bug) | US1 | — |
| #156 (p2, tech-debt) | US2, US3, US4 | §3.1, §3.2, §3.3 |
| #157 (p3, bug) | US5 | §1.4 / §3.4 |
| #155 (p3, chore) | US6 | — |
| — (verified resolved) | — | §1.3 — closed, out of scope |
