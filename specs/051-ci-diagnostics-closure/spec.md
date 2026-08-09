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

**PRD §1.3 is live, and its cause is now known.** This spec initially recorded §1.3 as resolved on
the strength of a clean Linux run (`✓ ci-digest coverage gate passed`, exit 0, 2026-08-09). That was
wrong, and wrong in the way this feature exists to prevent: a green result was accepted as evidence
on a platform that never exercised the failing path. An operator-run Windows sweep on the same day
reproduced the PRD's failure verbatim, naming the **same three jobs** the PRD named — `app-ci /
changes`, `app-ci / trigger-cd`, `infra-image-scan / changes`.

The cause is line endings. The three jobs *do* carry exemption markers; the parser cannot see them on
a CRLF checkout, because it splits on `\n` and its marker pattern cannot match a line ending in `\r`
— while the adjacent job-header pattern absorbs the `\r` and survives. The asymmetry is the bug.
§1.3 is therefore **in scope**, and the Windows sweep that found it surfaced a second, worse instance
of the same class in a different gate — one that fails *open*, reporting conformance while silently
skipping its check.

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

### User Story 5 - The diagnostics test suite is honest on Windows (Priority: P3)

The suite that guards CI diagnostics is red on Windows in ways no developer caused. An operator sweep
measured 408 tests: 392 pass, 15 fail, across five files. The failures are not one defect but three
kinds, and only the first was known when this feature was scoped:

- **Path handling** — an assertion comparing a fully-resolved path against a joined one (they differ
  by the drive root); a gate that reports a finding's location with the platform's own separator
  where the test expects a stable one; and a test module that dynamically imports an absolute path
  without converting it to a file URL, which aborts the whole file before any case runs.
- **A capability probe that answers the wrong question** — the step-wrapper suite asks "does a shell
  exist" when what it needs is "can that shell see my files". A shell from a different filesystem
  namespace answers yes, then fails every case with a not-found status, so the intended skip never
  engages and nine cases fail for a reason unrelated to what they test.
- **A tripwire keyed on the filesystem rather than on version control** — a guard asserts a certain
  example file is absent, but tests the working directory rather than tracked files. The file is
  ignored by version control, so any developer who creates one locally trips a test that is meant to
  detect the file being *added to the repository*.

**Why this priority**: no merge gate is affected — CI is Linux and stays green. But a suite that is
red for reasons the developer did not cause trains people to ignore red, and this is the suite that
guards CI diagnosis.

**Independent Test**: Run the full script suite on Windows and on Linux and compare.

**Acceptance Scenarios**:

1. **Given** the suite runs on Windows, **When** the affected cases execute, **Then** they pass.
2. **Given** the suite runs on Linux, **When** the affected cases execute, **Then** they still pass.
3. **Given** a path that genuinely escapes the bundle root, **When** the containment cases execute,
   **Then** they still fail — the fix must not weaken what the test proves.
4. **Given** a shell that cannot reach the files under test, **When** the step-wrapper suite runs,
   **Then** it skips with a reason naming that condition, rather than failing every case.
5. **Given** the example file exists locally but is not tracked, **When** the guard runs, **Then** it
   does not fire; **and given** the file is added to version control, **Then** it does.

---

### User Story 7 - A gate enforces the same rule regardless of line endings (Priority: P1)

Two gates parse repository text line-by-line and both mis-handle a carriage return, so a checkout
made on a platform that normalizes line endings gets a different verdict from the same commit. One
fails closed — it reports jobs as uncovered whose exemptions it simply could not see, which is PRD
§1.3 and cost that PRD a wrong diagnosis. The other fails **open**: an unparsable timestamp is
treated as "no timestamp to compare", so a staleness check silently does not run and the gate reports
conformance.

**Why this priority**: a gate that reports green while not checking is precisely the failure class
this whole feature exists to close, and it was found inside the feature's own toolchain. It also
means every guardrail verdict is contingent on a contributor's local version-control configuration —
so two people can get different answers from the same commit.

**Independent Test**: Convert the relevant fixtures and inputs to carriage-return line endings and
run both gates; the verdict must be identical to the line-feed case.

**Acceptance Scenarios**:

1. **Given** repository text with carriage-return line endings, **When** the coverage gate runs,
   **Then** it sees the exemption markers and reaches the same verdict as on line-feed text.
2. **Given** a stale entry in text with carriage-return line endings, **When** the conformance gate
   runs, **Then** the staleness check runs and reports the drift — it does not silently pass.
3. **Given** a fresh checkout on a platform that normalizes line endings, **When** the affected file
   types are inspected, **Then** they carry line-feed endings.
4. **Given** a parser in this family, **When** it is given carriage-return input directly, **Then**
   it behaves identically — the gate does not depend on the checkout being normalized.

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

**Story 5 — Windows parity for the diagnostics suite**

- **FR-016**: Path assertions MUST compare values normalized identically on both platforms, without
  loosening what they assert.
- **FR-017**: A gate that reports a finding's location MUST emit a stable, platform-independent
  representation of that location.
- **FR-018**: A test module MUST load on both platforms — an absolute path used as a dynamic import
  specifier MUST be converted to a file URL first.
- **FR-019**: A capability probe that decides whether a suite can run MUST test the capability the
  suite actually needs, and MUST skip with a reason naming the unmet condition rather than failing
  every case.
- **FR-020**: A guard asserting a file's absence from the repository MUST test version-control
  tracking, not working-directory presence.

**Story 7 — line-ending-independent gates**

- **FR-021**: Every gate parser in this family MUST produce an identical verdict for input with
  carriage-return line endings and input with line-feed endings.
- **FR-022**: A value parsed from repository text MUST be normalized before it is validated, so an
  unparsable value can never be silently reinterpreted as "nothing to check".
- **FR-023**: The repository MUST declare line-ending normalization for the file types these gates
  parse, so a checkout does not introduce the condition in the first place.
- **FR-024**: FR-021 MUST be enforced by a test that feeds carriage-return input directly, so the
  guarantee does not depend on the checkout being normalized.

**Story 6 — documentation**

- **FR-025**: The dev-container runbook MUST document the offline dependency-resolution behaviour and
  its lock-discipline corollary.
- **FR-026**: A canonical knowledge-bundle concept MUST document the whole-crate formatting scope
  trap, the single-file alternative, the recovery step, and the "format only what you touch"
  convention including the pre-existing drift and lint-gate context that makes it meaningful.
- **FR-027**: The stale toolchain-scope claim that the Rust and Python toolchains are deferred MUST
  be corrected.
- **FR-028**: The knowledge index MUST be regenerated by its generator, not hand-edited, and the
  governance and lint gates MUST pass.

**Cross-cutting**

- **FR-029**: Every claim of success in this feature MUST be evidenced by an observed result — an
  executed-test count, a retrieved log, a published signal — never by an exit status alone.
- **FR-030**: Commits that deliberately break CI for demonstration purposes MUST be reverted before
  merge, and their absence verified on the branch tip.
- **FR-031**: A claim that something passes MUST name the platform it was observed on. A green result
  on one platform is not evidence for another — this feature's own §1.3 reversal is the worked
  example.

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
- **SC-006**: The full script test suite reports **zero failures** on Windows and on Linux, and the
  containment cases still fail when given a path that escapes the bundle root. Measured Windows
  baseline before the change: 408 collected, 392 pass, **15 fail**. Target: 15 → 0, of which the nine
  step-wrapper cases become **reasoned skips** (the component under test runs only in Linux CI
  containers, so a skip is the honest outcome — but a skip without a stated reason is a failure of
  this criterion, not a pass), and the remaining six become passes. The collected total is expected to
  **rise** above 408, because one file currently aborts at load and its cases are not collected at
  all; a total that falls indicates a selector that stopped matching and does not satisfy this
  criterion.
- **SC-007**: Both gates in the line-ending family reach an identical verdict on carriage-return and
  line-feed input, proven by a test that supplies carriage-return input directly rather than by
  relying on the checkout. In particular the staleness check runs and reports drift on
  carriage-return input, where today it silently does not run.
- **SC-008**: PRD §1.3 is demonstrably closed — the coverage gate exits 0 on a clean checkout **on
  both platforms**, with the three previously-reported jobs recognised as exempt.
- **SC-009**: Each of the two cargo facts is found by searching the documentation locations a session
  would actually consult, and the governance and lint gates pass on the result.
- **SC-010**: The branch tip carries no deliberate-breakage commit.

SC-002 and SC-005 MUST be demonstrated by actually breaking a job, not by inspection. Both incidents
this feature closes were prolonged by treating a green run as evidence when it never exercised the
failing path.

SC-006, SC-007 and SC-008 MUST each name the platform they were observed on. This spec's own initial
claim that §1.3 was resolved was a Linux-only measurement presented as a general one, and it was
wrong.

## Assumptions

- **Operator-directed batching.** These four items ship as one feature and one pull request at the
  operator's explicit direction, consistent with the repository's batching convention given a single
  CI runner and a long E2E job. Item #158's own analysis recommended keeping it separate as a p1;
  that recommendation was considered and overridden.
- **Windows verification is the operator's.** The development container is Linux, so US5 and US7 are
  implemented and proven on Linux here; the Windows runs are performed by the operator, and backlog
  item #157 stays open until they confirm. The pre-change Windows baseline (408 tests / 15 failures)
  was supplied by the operator on 2026-08-09 and is the measurement US5 is judged against.
- **Scope grew after the Windows baseline arrived.** Item #157 described one assertion; the sweep it
  prompted found seven defects across three classes, two of which are live gate bugs rather than test
  bugs. The operator directed that all seven land in this feature.
- **Deliberate breakage happens on this branch.** SC-002 and SC-005 are demonstrated with temporary
  commits on `051-ci-diagnostics-closure`, reverted before merge, rather than on a separate throwaway
  branch.
- **Line-ending normalization is fixed at both layers.** The repository declares normalization for the
  affected file types *and* the parsers tolerate carriage returns, at the operator's direction. A gate
  must not depend on a contributor's local version-control configuration for its verdict — especially
  the one that fails open. Existing checkouts on a normalizing platform need to be re-normalized after
  the declaration lands; that is an operator step, not an automated one.
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
- Auditing every parser in the repository for line-ending sensitivity. This feature fixes the two
  gates the sweep found and declares normalization for the file types they read; a general audit is
  backlog work if it is wanted.
- Making the mobile/emulator half of the E2E gate run on Windows. Nothing in this feature changes
  where those flows run.

## Traceability

| Backlog item | Story | PRD section |
| --- | --- | --- |
| #158 (p1, bug) | US1 | — |
| #156 (p2, tech-debt) | US2, US3, US4 | §3.1 (rejected — see research R1), §3.2, §3.3 |
| #157 (p3, bug) | US5 | §1.4 / §3.4 |
| #155 (p3, chore) | US6 | — |
| #157's Windows sweep (new findings, 2026-08-09) | US5, US7 | §1.3 — **reopened**, cause identified |

Story priority does not follow story numbering: US7 is P1 and was added last, after the operator's
Windows sweep reopened PRD §1.3. Numbering follows the order the work was discovered, so that the
provenance of each story stays legible.
