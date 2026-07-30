# Specification Quality Checklist: OpenWiki Automated Maintenance and Content Relocation

**Purpose**: Validate specification completeness and quality before proceeding to planning
**Created**: 2026-07-28
**Last validated**: 2026-07-30
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

**Iteration 1 (2026-07-28)** — 17/18. Three `[NEEDS CLARIFICATION]` markers on decisions that
materially changed scope: ownership of relocated content (FR-029), first-tranche scope and its
evidence gate (FR-027), and schedule cadence (FR-009).

**Iteration 2 (2026-07-29)** — 18/18, all markers resolved. Recorded in **Clarifications**. Two
answers reshaped the feature rather than merely selecting an option:

- **The ownership question was rejected as posed.** Feature 043's location-based rule (bundle =
  generated, documentation tree = human-owned) was replaced by a **declared per-path regeneration
  policy** with three states and a named governing actor — FR-026a…FR-026f. This is new scope
  relative to the first draft and is the mechanism that makes relocation safe.
- **The full trim was accepted** rather than a measured tranche, which removes 043's evidence gate.
  Safety is restored mechanically instead: FR-029/FR-029a fingerprint every relocated passage and
  assert it on every change, offline and keyless, so a later paraphrase fails a gate rather than
  depending on a reviewer catching it in a large generated diff.

Three follow-on decisions were answered in the same session and are also recorded in Clarifications:
the specification tree is analyzable but not a coverage target (handoff documents excepted), the
test-data fixture is explicitly excluded while the file itself stays put, and the agent-layer document
moves into the runbooks directory.

Two consequences of the answers surfaced during validation and are now specified rather than left
implicit — **FR-009a** (a maintenance proposal's own merge must not re-trigger maintenance, or the
mechanism feeds itself) and the machine-managed-region edge case (the instruction file already has
three tool-managed writers; relocation adds a fourth).

**Iteration 3 (2026-07-29)** — 18/18 held. Four review corrections from the maintainer:

- **A factual error was removed.** FR-023 claimed this would be the repository's first non-keyless
  automated job requiring a new stored credential. Both halves were false: `ANTHROPIC_API_KEY` is
  already a Forgejo Actions secret consumed by `app-ci`'s end-to-end and dynamic-scanning jobs
  (17 secrets are in use), and a write-scoped repository credential already exists. FR-023 now states
  the opposite — **no new credential** — with FR-023a requiring any substitution to *reduce*
  privilege. The error came from over-reading 043's handoff phrase "the feature's first non-keyless
  scheduled job", which is true within the OpenWiki work and false about the repository.
- **`event-update` → `event-driven`**, broadened so the state covers **creating** a document, not only
  amending one when something becomes wrong. A decision reached produces a new decision record;
  FR-026f additionally requires a run to surface a decision merged with no record written.
- **The policy grid now names concrete paths** instead of abstract role names, which had hidden
  `CLAUDE.md` behind "primary instruction file" and left `openwiki/INSTRUCTIONS.md` unidentifiable
  as "bundle generation brief". The grid row now says what that file is and why it is never written.
- **The post-trim write path was unspecified and is now FR-037…FR-042.** Assistants write learnings
  **directly into bundle concepts**; the instruction file never accumulates prose again (FR-040
  fails the change that would re-grow it). The alternative — write to the instruction file, let
  maintenance relocate — was rejected on a hard constraint: it needs an automated run to rewrite
  instruction-file content, the generator scope expansion excluded by FR-026c. Consequence: FR-041
  makes the fingerprint set **open**, so a passage marked load-bearing after the trim is protected
  too.

**Iteration 4 (2026-07-29)** — 18/18 held. One review question exposed an overbroad requirement.

FR-037 previously said a durable learning always goes "directly into the relevant bundle concept."
That is wrong for every subject that still has a canonical document: an operational learning written
into the concept summarizing a runbook makes the summary more current than the runbook, and the next
refresh overwrites it from the stale source. The spec was conflating two orthogonal axes, now
separated explicitly:

- **The policy states (`regenerate` / `event-driven` / `excluded`) govern WHEN a path may be written.**
- **The canonical-home rule (FR-037) governs WHERE a learning goes** — mechanically, from whether the
  covering concept cites an upstream source. Cites a source → write to the source. Authoritative
  (no source) → write to the concept.

Runbooks and the architecture document are `regenerate` *and* canonical; decision records and
templates are `event-driven` *and* canonical. All four keep taking learnings directly, exactly as
today. The only destination this feature changes is content relocated out of `CLAUDE.md`, which
becomes canonical in the bundle because it has nowhere upstream to live (FR-037b).

Two consequential fixes followed: the policy grid's flat `openwiki/** = regenerate` row split into
derived (regenerate) versus authoritative (event-driven, protected); and **FR-041a** now forbids
fingerprinting a derived summary, which would freeze it against the document it summarizes and turn
the protection into a permanent blocker on every refresh.

**Iteration 5 — `/speckit-clarify`, 2026-07-30** — 16/16 held, no checkbox state changed. Five
clarifications recorded, each closing a requirement that referenced a decision the spec never made:

- **Per-run bound** was referenced by FR-011 and asserted by SC-006 but never defined → an explicit
  **spend ceiling**, enforced between slices. Two consequences specified: a bounded overshoot
  (a slice in flight is not interrupted), and FR-011c noting the ceiling bounds *money only*, so
  FR-019's non-contention requirement needs its own mechanism.
- **Unresolved-proposal behaviour** — FR-016 prohibited a competing proposal without saying what
  happens instead → **update the open proposal in place**, at most one ever open. Added FR-016a
  (human commits on the branch must survive) and FR-016b (a closed-unmerged proposal returns its work
  to outstanding, or the marker certifies a gap that no later run re-detects).
- **Trim sequencing** → the relocation runs **through the slice machinery** via the local path, and
  its run record is User Story 1's acceptance evidence. This raised **User Story 4 from P3 to P2**:
  its local invocation path is now a prerequisite for Story 3, not a convenience.
- **Protection mechanism** → a **sidecar manifest** outside the generator's write scope, so the guard
  is not inside the blast radius it guards. Required three additions the choice implies: the manifest
  is authoritative (a listed passage missing from its concept fails), delisting in the same change is
  the supported way to correct protected content, and failures must name the passage — since the
  concept itself does not disclose that it is protected.
- **Debounce** → trigger on a **~15-minute quiet main branch**, with a **maximum deferral** cap
  (FR-009b), because a sustained merge stream would otherwise starve maintenance on exactly the days
  the bundle drifts fastest.

Also normalized editorially, without spending a question: the feature is named *bounded-slice
generation* but the body said "unit of work" throughout — now **slice** everywhere (genuine
"unit-test" uses preserved) — and FR-002's "measured reliable size" is pinned to the **eight pages**
043 measured across two successful runs.

**Deferred to planning** (requirement exists, value is tuning): the maximum-deferral value, and how a
*successful* run reports its outcome.

**Iteration 6 — `/speckit-plan` Phase 0 amendment, 2026-07-30** — 16/16 held.

Phase 0 research invalidated the premise of the per-run bound and FR-011 was amended. OpenWiki 0.2.3
emits **no token or cost data**: no usage or budget flag in its option list, zero matches for
token-accounting fields across its distribution (all 21 `tokens` hits in `cli.js` are `marked`
markdown-lexer tokens), and no token counts in its telemetry payload. Feature 043 never measured cost
either — every figure it recorded is wall-clock.

The spend ceiling was therefore replaced by a **page budget + wall-clock budget** (FR-011, FR-011a–d) —
the quantities the repository can actually observe. A calibrated cost estimate was offered and rejected:
with nothing to calibrate against it would have read as a monetary guarantee while being a fabrication.
FR-011d now records the honest negative — **no requirement in this feature asserts a monetary bound**.

Two requirements improved as a result. FR-011b now demands both counters come from **verified
observation** — pages counted from the working tree, never from the generator's self-report — extending
FR-005's anti-false-green rule to the budget, which matters because nothing prevents the generator
over-producing past its free-text page list. And FR-011c inverted from a caveat into a benefit: a
wall-clock budget bounds runner occupancy directly, so it now *contributes* to FR-019 instead of leaving
non-contention to a separate mechanism.

The original clarification bullet is retained and marked superseded rather than rewritten, so the record
shows the decision changed and why.

**One assumption to confirm at planning time**: FR-026c reads "regenerate" as governing *an agent
working under human review*, not as expanding the generator's write scope beyond the bundle. That
reading is stated in Clarifications and in Out of Scope. If the intent was the broader one, it is a
spec amendment, not an implementation choice.

Ready for `/speckit-plan`.
