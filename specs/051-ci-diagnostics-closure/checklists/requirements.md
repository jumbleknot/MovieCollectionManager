# Specification Quality Checklist: CI diagnostics gap closure and E2E agent-gate fix

**Purpose**: Validate specification completeness and quality before proceeding to planning
**Created**: 2026-08-09
**Feature**: [spec.md](../spec.md)

## Content Quality

- [x] No implementation details (languages, frameworks, APIs)
- [x] Focused on user value and business needs
- [x] Written for non-technical stakeholders
- [x] All mandatory sections completed

## Requirement Completeness

- [x] No [NEEDS CLARIFICATION] markers remain
- [x] Requirements are testable and unambiguous
- [x] Success criteria are measurable
- [x] Success criteria are technology-agnostic (no implementation details)
- [x] All acceptance scenarios are defined
- [x] Edge cases are identified
- [x] Scope is clearly bounded
- [x] Dependencies and assumptions identified

## Feature Readiness

- [x] All functional requirements have clear acceptance criteria
- [x] User scenarios cover primary flows
- [x] Feature meets measurable outcomes defined in Success Criteria
- [x] No implementation details leak into specification

## Notes

Three judgements worth stating plainly rather than ticking silently:

1. **"Non-technical stakeholders" is read as "not requiring knowledge of this repository's
   internals".** The subject of this feature is the CI harness, so its user is by definition a
   developer or coding agent. The stories name outcomes ("a failing job leaves output that outlives
   the container") rather than mechanisms, and no requirement names a file, script, flag or command.
   Concrete file paths appear only in the Context and Traceability sections, where they identify
   which prior artefacts this feature supersedes.

2. **FR-004 is a verification requirement, not a design choice, and that is deliberate.** The PRD's
   proposed solution rests on an assumption it flags as unverified — that the container executor
   leaves the workspace on the host. Encoding "measure it before designing around it" as a
   requirement is what prevents this feature from repeating the failure it exists to close.

3. **PRD §1.3 was excluded, then reopened.** The first version of this spec recorded §1.3 as resolved
   on the strength of a Linux measurement. An operator-run Windows sweep on 2026-08-09 reproduced the
   PRD's failure verbatim, naming the same three jobs, and identified the cause (a carriage return
   defeating a marker pattern). The exclusion was wrong and is reversed; §1.3 is now in scope as
   Story 7, and FR-031 was added so a platform-specific pass can never again be stated as a general
   one.

   This is recorded rather than edited away because it is the same mistake the feature exists to
   prevent — accepting a green result from an environment that never exercised the failing path.

## Revalidation — 2026-08-09, after the Windows sweep

Re-checked every item above after adding Story 7, five findings to Story 5, FR-016..024 and FR-031,
and renumbering Story 6 and the cross-cutting requirements.

- **Requirement completeness**: still passes. The new requirements are testable (each names an
  observable verdict or an executed-count), and SC-006 now carries a measured pre-change baseline
  (408 tests / 392 pass / 15 fail on Windows) rather than an aspiration.
- **Scope**: grew materially and deliberately, at the operator's direction, with the growth and its
  cause recorded in Assumptions. Out of Scope gained an explicit boundary — a general repository-wide
  parser audit is *not* included — so the growth stays bounded.
- **No [NEEDS CLARIFICATION] markers** were introduced.
- **Numbering**: story numbers follow discovery order, not priority; US7 is P1. Stated in
  Traceability so it does not read as an error.

No items require further spec updates before `/speckit-tasks`.

## Revalidation — 2026-08-09, after `/speckit-analyze`

Cross-artifact analysis found one CRITICAL and two HIGH issues, all in artifacts written during this
feature. All were remediated:

- **CRITICAL — Story 2's requirements still described the design research had rejected.** FR-004…009
  were written against the input PRD's log-relocation plan. Research R1 overturned that premise; the
  plan and research were updated, and the spec was not. Four requirements had zero task coverage and
  FR-005 was actively contradicted by the chosen design. Now restated against the real gap, with
  FR-004 and FR-009 explicitly **retired** (numbering preserved so the change is visible rather than
  hidden by a renumber) and US2's acceptance scenarios rewritten to match.

  This is the same failure mode as the §1.3 reversal above: a conclusion reached in one artifact and
  not propagated to the one that governs the work. Two occurrences in one feature is a pattern, not a
  coincidence — hence FR-031 and this note.

- **HIGH — the wrapping tasks under-covered the measured gap by two steps.** T022–T024 summed to 46
  against a measured 48; `guardrails / okf` was in no task, which would have landed the new gate red.
  Fixed, with an arithmetic check embedded in T022 so the sum is re-derivable.

- **HIGH — two exemption markers exist, and the contract named only one.** `ci-digest-exempt` and
  `ci-log-step-exempt` have distinct semantics and separate blank-reason checks. Both are now
  specified, with a test obligation that they stay independent.

- **MEDIUM** — the plan's TDD row now records the platform qualification instead of claiming an
  unqualified pass; a broken quickstart command (`T=… node` argument order) is fixed and verified;
  and the two US7 tests are now both RED before implementation rather than one being RED by stashing
  the fix.

Coverage after remediation: **29/31 functional requirements** referenced by tasks; the two
unreferenced are the retired FR-004 and FR-009. Success criteria: **10/10**.

The two LOW findings (terminology drift across three names for one entity; a contradictory sentence
in Complexity Tracking) are recorded and deliberately not fixed — neither affects execution.
