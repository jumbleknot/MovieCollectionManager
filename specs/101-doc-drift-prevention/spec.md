# Feature Specification: Doc-Drift Prevention (doc-impact sweep + periodic drift audit)

**Feature Branch**: `101-doc-drift-prevention`

**Created**: 2026-11-15

**Status**: Draft

**Input**: Backlog item #1021, implementing [docs/proposals/PRD-DocDriftPrevention.md](../../docs/proposals/PRD-DocDriftPrevention.md) layers 1 and 3. Proposal §7 answered 2026-11-15 by the operator: Q1 tasks template only; Q2 a backlog item chain, where each audit files the next; Q3 deferred.

## Context

CI keeps each wiki summary in step with its source document (V17). Nothing keeps the source document
in step with the code it describes. The 2026-11-14 audit fixed 76 proven drifts across 21 docs,
about 4.5 per 1,000 lines. The record shows that features do the doc tasks they write. What fails is
**discovery**: a feature updates the docs it thinks of, not the other docs that name what it changed.

This feature adds two of the proposal's three layers:

- **Layer 1, the doc-impact sweep.** Every feature searches for the identifiers it changes when its
  tasks are generated, and searches again at close-out. The step is built into the task-generation
  template so that a framework upgrade cannot silently remove it.
- **Layer 3, the periodic drift audit.** A written procedure, run quarterly, whose findings measure
  whether layer 1 works.

Layer 2 (a mechanical per-PR check) is out of scope until success measure SM-3 in the proposal
triggers it.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Every new feature's task list carries a doc-impact sweep (Priority: P1)

A developer or coding session generates the task list for a new feature. The task list includes a
required doc-impact sweep in place of today's generic "documentation updates" line. The sweep
lists the identifiers the feature renames, removes or changes the meaning of, and searches every
doc that states current procedure for each one. Every hit becomes a named doc task, or gets a
one-line reason why it needs no change.

**Why this priority**: Discovery is the measured weak point. This is the change that would have
caught feature 020's five-month miss with one search.

**Independent Test**: Generate tasks for a scratch feature. The resulting task list contains the
sweep task with its instructions, and the template it came from is the project's own copy, not the
framework's.

**Acceptance Scenarios**:

1. **Given** the project's own task template exists, **When** a task list is generated for any
   feature, **Then** that template is used and the task list contains the doc-impact sweep task.
2. **Given** a generated task list, **When** a reader looks for the generic "Documentation updates
   in docs/" placeholder, **Then** it is absent and the sweep task stands in its place.

---

### User Story 2 - A framework upgrade cannot silently drop or stale the sweep (Priority: P1)

A maintainer upgrades the spec framework (Spec Kit). The upgrade may rewrite the framework's own
task template, stop resolving project overrides first, or the project's copy may be lost. In each
case a required check fails, names the files involved, and shows what changed upstream since the
project copy was forked. The maintainer merges the upstream change into the project copy, records
the new fork point with a helper (never by hand), and the check passes.

**Why this priority**: A project-owned template copy is a fork. Without a guard, an upgrade either
loses the sweep (if the copy goes) or silently stops passing upstream improvements to the project
(if the copy stays). Either is the same silent failure this feature exists to prevent.

**Independent Test**: Change the framework's task template in a scratch checkout. The guard fails
and names both files (Verify RED). Run the record helper. The guard passes (Verify GREEN).

**Acceptance Scenarios**:

1. **Given** the framework's task template no longer matches the recorded fork point, **When** the
   guard runs, **Then** it fails, names both templates, and prints the upstream diff since the fork
   point when history allows.
2. **Given** the project copy is missing, or no longer contains the sweep task, **When** the guard
   runs, **Then** it fails and says which.
3. **Given** the framework's task-generation setup stops resolving templates through its override
   lookup, or the lookup no longer checks project overrides first, **When** the guard runs, **Then**
   it fails rather than quietly falling back to the framework's template.
4. **Given** the maintainer has merged the upstream change, **When** they run the record helper,
   **Then** the fork point is rewritten from the framework template's current content and the guard
   passes.
5. **Given** a pull request, **When** CI runs, **Then** the guard runs in the required guardrails
   checks.

---

### User Story 3 - The sweep is a rule, not only a template line (Priority: P2)

The governing constitution requires the doc-impact sweep, with its results recorded in the
feature's task list. The final validation checklist gains a close-out item: re-run the sweep's
searches for the **old** identifiers, and fix or justify every remaining hit in a doc that states
current procedure. A runbook section describes the framework upgrade procedure from User Story 2.

**Why this priority**: The rule still holds in the one case the template cannot cover, when task
generation falls back to the framework's template. It also gives the close-out step (proposal G2)
a home. This depends on Story 1's sweep existing.

**Independent Test**: Read the constitution, the checklist and the runbook. Each states its rule,
and the constitution version and history are bumped.

**Acceptance Scenarios**:

1. **Given** the constitution, **When** a feature's plan or tasks omit the sweep, **Then** the
   omission conflicts with a stated principle, which cross-artifact analysis treats as critical.
2. **Given** the validation checklist, **When** a feature closes, **Then** it has an item to re-run
   the old-identifier searches.
3. **Given** a maintainer about to upgrade the framework, **When** they look for the procedure,
   **Then** a runbook section tells them to run the upgrade, expect the guard to fail, re-merge,
   record, and land all three in one PR.

---

### User Story 4 - The drift audit is a written, self-perpetuating procedure (Priority: P3)

An operator or session runs the quarterly drift audit from a written procedure. The procedure
covers what to read, which claims to check, what to edit and what only to report, the wiki refresh
in the same PR, and recording the drift rate per 1,000 lines against the previous audit. Its last
step files the next audit as a dated backlog item, about a quarter later. The first such item, for
around 2027-02, is filed by this feature.

**Why this priority**: The audit is the measure of whether layers 1 and 2 are needed, and it is
manual and infrequent. It matters, but nothing breaks between quarters without it.

**Independent Test**: The procedure is in a runbook, and the backlog holds an open audit item with
a date and acceptance criteria.

**Acceptance Scenarios**:

1. **Given** the runbook, **When** an audit is run, **Then** the procedure states scope, the claim
   types to verify, the edit-versus-report rule, the wiki refresh, and the rate to record.
2. **Given** an audit is completing, **When** its last step runs, **Then** the next audit is filed
   as a backlog item with a target date, so the cadence needs no external scheduler and no owner
   beyond the session closing the current audit.

### Edge Cases

- **Task generation returns no template path** and the skill falls back to the framework's
  template. The guard cannot catch this at generation time. The constitution rule (Story 3) still
  requires the sweep.
- **The framework adds an upstream improvement to its task template.** The guard fails on the next
  PR after the upgrade, never silently. The fix is to re-merge, not to delete the project copy.
- **Fork-base history is unavailable** (shallow clone in CI). The guard still fails on a hash
  mismatch and says the diff could not be shown. It never passes for that reason.
- **The sweep finds a hit in a dated record** (ADRs, `specs/`, proposals, "measured on …" tables).
  These are excluded from the search scope or justified as history. They are never rewritten.
- **A framework upgrade adds composition strategies to task generation.** That is out of scope. The
  guard's resolution check fails if resolution changes, and that failure prompts a re-evaluation.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: The project MUST own a task-generation template that the framework resolves ahead of
  its own, and that template MUST contain the doc-impact sweep task in place of the generic
  documentation line.
- **FR-002**: The sweep task MUST instruct the feature to list changed identifiers (paths, task
  runner targets, script names and flags, environment variables, compose service, container,
  volume, network, stack and profile names, ports, workflow and job names, user-visible labels), to
  search every Markdown doc outside `specs/`, `docs/proposals/` and `docs/decisions/` for each one,
  to turn every hit into a named doc task or a one-line justification, and to record the terms and
  results in the task.
- **FR-003**: The project template MUST record its fork point: the framework template's path, its
  content fingerprint and the framework version.
- **FR-004**: A guard MUST fail when the framework template's fingerprint differs from the recorded
  fork point, when the project template is missing or lacks the sweep task, or when the framework's
  task-generation setup no longer resolves through a lookup that checks project overrides first.
- **FR-005**: On a fork-point mismatch the guard MUST name both templates and print the framework
  template's diff since the fork point, or state that history was unavailable.
- **FR-006**: The fork point MUST be written only by a record helper, from the framework template's
  current content. It is never hand-typed.
- **FR-007**: The guard MUST run in the required guardrails CI checks on every pull request.
- **FR-008**: The constitution MUST require the doc-impact sweep, with results recorded in the
  feature's task list, with a version bump and history entry.
- **FR-009**: The final validation checklist MUST gain a close-out item to re-run the sweep's
  searches for old identifiers, and to fix or justify each remaining hit in a doc stating current
  procedure.
- **FR-010**: A runbook MUST describe the framework upgrade procedure: upgrade, expect the guard to
  fail, re-merge into the project template, record, and land all three in one PR.
- **FR-011**: A runbook MUST describe the drift-audit procedure. It covers scope, verified claim
  types, edit-only-what-is-proven, report-what-cannot-be-proven, wiki refresh in the same PR, the
  drift rate per 1,000 doc lines compared with the previous audit, and filing the next audit as a
  dated backlog item as the final step.
- **FR-012**: The next audit MUST be filed as a backlog item with a target date around 2027-02 and
  acceptance criteria.
- **FR-013**: The proposal's §7 MUST record the 2026-11-15 answers: Q1 tasks template only, Q2 a
  backlog item chain, Q3 deferred.
- **FR-014**: Every derived wiki page whose source this feature changes MUST be refreshed in the
  same PR (V17).

### Key Entities

- **Project task template**: the project-owned copy of the framework's task template. It carries
  the sweep task and a fork-point header.
- **Fork point**: framework template path, content fingerprint and framework version, written only
  by the record helper.
- **Drift-audit backlog item**: a dated, recurring item. Each instance files its successor.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: 100% of task lists generated after this merges contain the doc-impact sweep task
  (proposal SM-1, sampled from `tasks.md`).
- **SC-002**: Changing a single byte of the framework's task template makes the required CI check
  fail. Recording the fork point after the re-merge makes it pass. Both are demonstrated in the PR.
- **SC-003**: Each of the four guard failure conditions (fingerprint mismatch, missing template,
  missing sweep task, broken override resolution) has its own failing test case.
- **SC-004**: The next drift audit exists in the backlog with a date when this feature closes, and
  each later audit records a drift rate per 1,000 doc lines for comparison with the 4.5 baseline
  (proposal SM-2).
- **SC-005**: The next framework upgrade lands only with the guard having fired and been resolved
  (proposal SM-4).

## Assumptions

- The framework (Spec Kit 0.11.2) resolves templates as project overrides, then presets, then
  extensions, then core. Its task setup resolves through that path, verified 2026-11-14 and
  re-checked 2026-11-15.
- The framework's manifest of owned files does not list project overrides, so an upgrade does not
  rewrite them. Whether an upgrade warns on locally modified files is unverified, and nothing here
  depends on it.
- The plan template gets no sweep (§7 Q1). Revisit if audits show dependent docs found too late.
- Making READMEs wiki resources is deferred (§7 Q3). The audit already reads them.
- Layer 2 is out of scope until SM-3 triggers it.
- The sweep is literal text search, run by the session on the subscription. No model call runs in
  CI.
