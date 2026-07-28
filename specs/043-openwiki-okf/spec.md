# Feature Specification: OpenWiki + OKF Knowledge Layer

**Feature Branch**: `043-openwiki-okf`

**Created**: 2026-07-26

**Status**: Draft

**Input**: User description: "docs/proposals/openwiki-okf-adoption-plan.md — OpenWiki 0.2 (with OKF) Research & Adoption Plan for MovieCollectionManager, Phases 0–2 only"

## Clarifications

### Session 2026-07-26

- Q: How much of the proposal's phase plan does this feature cover? → A: **Phases 0–2 only.** Governance, dual-environment tooling, authored generation instructions, first generation, review gates, the committed bundle, and consumer wiring. Freshness comes from folding a wiki-update step into the existing feature-completion checklist — the proposal's own "perfectly acceptable v1" fallback. **No** scheduled maintenance job and **no** new CI credential.
- Q: What is the testable artifact that gives us RED → GREEN? → A: **A new repository conformance gate**, following the existing house idiom of the other `check-*` gates, driven RED→GREEN by unit tests over fixture bundles and wired into the always-on guardrails workflow. Human review alone was rejected: it leaves nothing to write a failing test against.
- Q: How do we sequence the toolchain bake against the first generation? → A: **Install ad-hoc in the current dev container to produce the first bundle; ship the pinned toolchain-image entry in the same change.** The image refresh rides its normal cadence rather than blocking the feature; verifying the baked path is a follow-up acceptance step, recorded as a known residual.
- Q: Does this feature also shrink the primary instruction file? → A: **No — pointer only.** The instruction file gains the wiki reference and one factual correction; nothing is removed. Rationale: the instruction file is loaded unconditionally while the wiki is consulted on demand, so relocating load-bearing gotchas is a bet that agents actually retrieve them, and a failed bet regresses silently. Prove retrieval in real sessions first; the trim is an evidence-gated follow-on with measured before/after.
- Q: Does the mandatory full web E2E regression apply to a documentation-and-scripts feature? → A: **Yes, no deviation.** The Final Validation Checklist requires it for every feature; it runs via the containerized browser path because browsers cannot be installed natively in the dev container.
- Q: How broad should the first bundle be? → A: **Full navigational coverage of the canonical documentation.** Beyond the priority areas, every runbook, architecture-decision record, and architecture document gets at least one concept, so every canonical document is reachable by a metadata query and a missing concept unambiguously means the document does not exist. Rejected: a narrow priority-areas-only seed (leaves agents unable to distinguish "no concept" from "not covered yet") and an unbounded generation (review burden and cost unknowable up front).
- Q: What does it mean for a concept's source link to "resolve"? → A: **Offline resolution only.** Repository-relative links are resolved against the working tree and fail the gate when the target is missing; external links are checked for well-formedness and never fetched. Keeps the always-on gate keyless, deterministic, and immune to external outages — which matters because the gate is fail-closed, so a network hiccup would otherwise block unrelated merges. Accepted residual: dead external links are not detected.
- Q: What does the conformance gate do when the bundle is missing, empty, or partially written? → A: **Fail-closed, with no opt-out.** A gate that passes when its subject is absent is the failure mode that let the integration tier rot silently for a month before feature 041, and FR-001 makes the bundle a required artifact. Consequence for implementation ordering: RED→GREEN must be driven by fixture bundles, because the gate's real-tree run cannot go green until the bundle exists.
- Q: Should the gate detect drift between a concept and the document it cites? → A: **Yes, as a report-only warning.** The gate lists concepts whose cited source changed after the concept's timestamp but does not fail on them. Blocking was rejected as disproportionate: regeneration is a manual, model-cost step (Phase 3 automation is deferred), so a blocking check would gate every documentation edit on a paid run. Report-only makes drift visible on every run and feeds the manual update loop.
- Q: Where is the human-judgement evidence for the retrieval and accuracy criteria recorded? → A: **In a committed evidence document in the feature folder**, following the precedent feature 041 set with its own committed evidence file. SC-003 and SC-004 are performed once by a human and cannot be re-checked by a machine later, so a PR-body-only record (lost on archive) or an unrecorded assertion would leave both criteria unfalsifiable.

## User Scenarios & Testing *(mandatory)*

The primary actor is the **AI coding assistant working in this repository** (secondarily, a human
developer or operator). Today that actor's operational knowledge arrives one of two ways: a single
large instruction file loaded into **every** session regardless of what the session touches, or an
open-ended search across a documentation tree, a specifications tree, a governance document, and
several project READMEs. The instruction file grew roughly 13% in eight days. Neither path is
selective: the actor pays for knowledge it does not need, or hunts for knowledge it cannot locate by
description.

This feature adds a **structured knowledge bundle** — one file per concept, each carrying queryable
metadata, a distilled summary, the load-bearing gotchas, and a link to the authoritative source. It
is a navigation and gotcha layer. It does not restate, replace, or relocate the canonical
documentation it points at.

### User Story 1 - Find load-bearing knowledge without reading everything (Priority: P1)

An assistant starting work on an unfamiliar area of the repository consults the knowledge bundle,
narrows to the relevant concepts by their declared kind and topic labels, reads a short summary plus
the known pitfalls, and follows the link to the authoritative document only when it needs full
detail.

**Why this priority**: This is the feature. Every other story exists to make this one safe,
available, or durable. Without it there is no knowledge layer.

**Independent Test**: Pose a set of real repository questions spanning several subsystems. Confirm
each is answerable from the bundle by selecting concepts on their metadata, and that each answer
carries a working link to the authoritative source. Delivers value even if no other story ships.

**Acceptance Scenarios**:

1. **Given** the bundle is present, **When** an actor filters concepts by their declared kind and topic labels, **Then** it reaches the relevant concept without reading unrelated concept files.
2. **Given** a concept page, **When** the actor needs authoritative detail, **Then** the page links to the canonical source and does not duplicate its full text.
3. **Given** a directory of concepts, **When** the actor opens that directory's summary page, **Then** it can decide which concepts to open from the descriptions alone.
4. **Given** the proposal tree is excluded from the bundle, **When** an actor asks how an idea becomes implemented work, **Then** exactly one process concept explains the proposal → specification → implementation lifecycle and points to the proposal folder for humans.

---

### User Story 2 - Prove the bundle is conformant and leak-free before it lands (Priority: P2)

A contributor changes or regenerates the bundle. An automated gate rejects the change if any concept
is structurally malformed, and the existing leak gates reject it if any generated page reproduces
infrastructure topology or credential-shaped values scraped from the sources it read.

**Why this priority**: Generated content is written by a model that has read runbooks containing
hostnames and operational detail. Without an automated gate, the first bad generation either breaks
retrieval silently or leaks. This story is also what makes the feature test-drivable.

**Independent Test**: Run the gate against fixture bundles that are each broken in one specific way,
plus one valid bundle. Confirm it fails the broken ones with an identifying message and passes the
valid one. Testable with no real bundle present.

**Acceptance Scenarios**:

1. **Given** a concept whose metadata block is unparseable or missing its required kind, **When** the gate runs, **Then** it fails and names the offending file.
2. **Given** a concept whose declared timestamp is not a valid ISO 8601 value, **When** the gate runs, **Then** it fails and names the offending field.
3. **Given** a concept whose source link points at a path that does not exist, **When** the gate runs, **Then** it fails and names the dangling reference.
4. **Given** a concept directory with no summary page, **When** the gate runs, **Then** it fails.
5. **Given** a fully conformant bundle, **When** the gate runs, **Then** it passes and reports no findings.
6. **Given** a generated page containing a hostname, host-and-port pair, or credential-shaped string, **When** the existing leak gates run, **Then** they fail on it, and remediation is a change to the generation instructions followed by regeneration — never an allowlist entry.
7. **Given** the gate is added to the always-on checks, **When** the repository's check-coverage gate runs, **Then** the new job satisfies its failure-evidence obligation.
8. **Given** the bundle is absent, empty, or only partially written, **When** the gate runs, **Then** it fails rather than passing vacuously, and offers no flag to skip that check.
9. **Given** a concept whose cited source has changed since the concept's own timestamp, **When** the gate runs, **Then** it reports the drift as a warning and does not fail.
10. **Given** a concept citing an external source, **When** the gate runs, **Then** it checks only that the link is well-formed and performs no network request.

---

### User Story 3 - Regenerate the bundle from either supported workspace (Priority: P2)

A developer in the primary containerized workspace, or on the secondary host used for mobile and
native work, can generate or update the bundle with the same pinned tool version and no new
credential handling.

**Why this priority**: A knowledge layer only one person can regenerate rots. Environment parity is
what makes the maintenance loop in Story 6 credible.

**Independent Test**: Perform a generation run in the containerized workspace and confirm the same
pinned version is recorded for the host workspace, with setup for each documented in that
environment's own setup runbook.

**Acceptance Scenarios**:

1. **Given** the containerized workspace, **When** a generation run is started, **Then** it authenticates using credentials already available to that environment, with no new secret file created inside the workspace and no network-policy change.
2. **Given** the host workspace, **When** a developer follows the documented setup, **Then** they install the same pinned version, with configuration stored outside version control.
3. **Given** the tool keeps local state across runs, **When** the containerized workspace is recreated, **Then** the documented behavior is known — either the state is safely rebuilt or it is explicitly persisted.
4. **Given** the pinned version is recorded in the toolchain definition, **When** the workspace image is next refreshed, **Then** the tool is present without an ad-hoc install.

---

### User Story 4 - Every coding assistant knows the bundle exists (Priority: P3)

All four coding-assistant configuration surfaces in the repository carry the same short pointer: a
structured knowledge bundle exists, and its metadata should be queried before falling back to a
broad search.

**Why this priority**: The repository serves four assistants. A bundle only one of them is told about
delivers a quarter of the value, and the pointer is cheap.

**Independent Test**: Inspect each of the four configuration surfaces and confirm the pointer is
present and consistent.

**Acceptance Scenarios**:

1. **Given** the four assistant configuration surfaces, **When** each is inspected, **Then** each contains an equivalent pointer to the bundle and its retrieval convention.
2. **Given** two of those files contain machine-managed regions maintained by other tooling, **When** the pointer is inserted, **Then** it lands outside those regions and no managed region is altered or truncated.
3. **Given** the primary instruction file, **When** this feature is complete, **Then** it has gained only the pointer and one factual correction, and has had nothing removed.

---

### User Story 5 - Live operator documents sit where the bundle can describe them (Priority: P3)

Two documents in the proposal tree are not proposals — they are the authoritative live procedures for
operating the deployment pipeline and the server. Because the proposal tree is excluded from the
bundle, they move to the runbook collection, where the bundle can carry a concept for each.

**Why this priority**: Without the move, the cleanest exclusion rule silently hides two of the most
operationally important documents in the repository. Deferring it forces a messier per-file
exception.

**Independent Test**: Confirm both documents are reachable at their new location, that a search of
the tracked tree finds no reference to either old location, and that the bundle carries a concept for
each.

**Acceptance Scenarios**:

1. **Given** the two live operator documents, **When** this feature is complete, **Then** both reside in the runbook collection with their content unchanged.
2. **Given** every tracked file that referenced their old locations, **When** the tree is searched, **Then** no reference to an old location remains and each updated link resolves.
3. **Given** the remaining historical proposals, **When** this feature is complete, **Then** they are untouched and remain excluded from the bundle.

---

### User Story 6 - The bundle stays current as a by-product of normal work (Priority: P4)

Keeping the bundle fresh is folded into the existing end-of-feature validation routine: run the
update, review the resulting diff, include it in the same change. No scheduled job, no new automation
credential.

**Why this priority**: Freshness is what separates a knowledge layer from a snapshot that becomes
misleading. It is last because the bundle delivers value on day one and the update loop is a process
change rather than a build.

**Independent Test**: Confirm the completion checklist carries the update step and that the step is
executable by a developer in either supported workspace.

**Acceptance Scenarios**:

1. **Given** the feature-completion checklist, **When** it is read, **Then** it instructs the developer to run the wiki update and include the resulting diff in the change.
2. **Given** an update run, **When** it produces changes, **Then** those changes are reviewable as an ordinary diff and are subject to the same gates as any other bundle change.
3. **Given** this feature's scope, **When** the automated-maintenance surface is inspected, **Then** no scheduled job and no new stored credential were introduced.

---

### Edge Cases

- **A generated page reproduces topology or a credential-shaped value.** The leak gates fail the change. Remediation is a generation-instruction fix plus regeneration; adding an allowlist entry is prohibited.
- **The inserted pointer lands inside a machine-managed region** of an instruction file, so the tool that owns that region later clobbers it or is itself corrupted. The insertion is diff-reviewed before it is committed.
- **A concept contradicts the document it cites.** Generated documentation can be confidently wrong. A sample of pages is verified against sources before the bundle lands; the canonical document always wins, and the concept is corrected or removed.
- **A cited source is later moved or deleted**, leaving a dangling link. The conformance gate fails on unresolvable references.
- **A concept directory has no summary page**, or a concept exists that no summary page lists. The gate fails in both directions.
- **The tool's local state is discarded** when the containerized workspace is recreated, forcing a slow full regeneration or producing a partial one.
- **Generation fails partway**, leaving a partially written bundle. A partial bundle must fail the gate rather than merge as a subset.
- **A concept is generated for an excluded path**, reintroducing pre-specification ideation into retrieval. Only the single process concept may describe the excluded tree.
- **A bundle-only change still triggers the full continuous-integration suite** on a pull request, including the long end-to-end job. This is expected behavior for this repository's pull-request trigger, not a defect.

## Requirements *(mandatory)*

### Functional Requirements

**The knowledge bundle**

- **FR-001**: The repository MUST contain a version-controlled knowledge bundle at a single root location, distinct from the existing documentation tree.
- **FR-002**: Every concept in the bundle MUST be a plain-text markdown file carrying a structured metadata block, so that it remains human-readable and reviewable as an ordinary diff.
- **FR-003**: Every concept's metadata MUST declare its kind, and MUST use the reserved descriptive, topic-label, source-link, and timestamp fields where applicable.
- **FR-004**: Every directory in the bundle MUST contain a summary page that lists the concepts it holds using their declared descriptions, so navigation is possible without opening each concept.
- **FR-005**: Each concept MUST consist of a distilled summary plus the load-bearing pitfalls for its subject, and MUST link to the authoritative source rather than reproducing its full text.
- **FR-006**: The bundle MUST NOT contain concepts derived from the pre-specification proposal tree, except exactly one process concept describing the proposal → specification → implementation lifecycle.
- **FR-007**: The bundle MUST provide **full navigational coverage of the canonical documentation**: an overview per deployable project, the repository's cross-cutting invariants, the non-obvious design decisions currently held only in the primary instruction file, and at least one concept for **every** runbook, architecture-decision record, and architecture document. Every canonical document MUST therefore be reachable by a metadata query, so that the absence of a concept unambiguously means "no such document" rather than "not covered yet".

**Generation control**

- **FR-008**: Generation MUST be driven by a version-controlled instructions document, authored before the first generation run, so that regeneration is repeatable and reviewable.
- **FR-009**: The instructions MUST exclude dependency, build-output, cache, coverage, test-artifact, environment-file, secret, and lockfile paths, and MUST exclude the proposal tree.
- **FR-010**: The instructions MUST forbid reproducing hostnames, host-and-port pairs, tokens, and credential-shaped values, requiring abstract references instead.
- **FR-011**: The instructions MUST direct the generator to summarize and link rather than restate existing documentation.
- **FR-012**: When a gate rejects generated content, remediation MUST be a change to the instructions followed by regeneration; adding a gate allowlist entry to accept the content is prohibited.

**Conformance and safety gates**

- **FR-013**: A conformance gate MUST validate that every concept's metadata parses, declares its required kind, uses a valid ISO 8601 timestamp where present, and cites a source that resolves.
- **FR-013a**: Source-link resolution MUST be offline and deterministic. A repository-relative source link MUST be resolved against the working tree and MUST fail the gate when the target does not exist. An external source link MUST be validated for well-formedness only and MUST NOT be fetched, so that the gate remains keyless, requires no network access, and cannot fail because an external host is unreachable.
- **FR-014**: The conformance gate MUST validate that every directory has a summary page and that no concept is unreachable from one.
- **FR-014a**: The conformance gate MUST be fail-closed with respect to the bundle's existence: an absent, empty, or partially-written bundle MUST fail the gate rather than pass vacuously, so that deleting the bundle or merging an interrupted generation run cannot produce a green build. No opt-out flag or skip mechanism may be provided.
- **FR-014b**: The conformance gate MUST report, as a non-blocking warning, every concept whose cited repository-relative source has changed since the concept's own declared timestamp. Drift MUST be visible on every run and MUST NOT fail the gate, so that editing a canonical document never blocks a merge on a regeneration run.
- **FR-015**: The conformance gate MUST provide a self-test mode that exercises its own detection logic, consistent with the repository's existing gates.
- **FR-016**: The conformance gate MUST run automatically on every change, as part of the always-on checks rather than only on demand.
- **FR-017**: The new automated check MUST publish failure evidence in the form the repository's check-coverage gate requires.
- **FR-018**: The existing whole-tree credential and topology gates MUST cover the bundle, and this coverage MUST be asserted rather than assumed.
- **FR-019**: The bundle MUST NOT introduce any new stored automation credential.

**Consumers, governance, and maintenance**

- **FR-020**: All four coding-assistant configuration surfaces MUST carry an equivalent pointer to the bundle and its metadata-first retrieval convention.
- **FR-021**: Inserting that pointer MUST NOT alter or truncate any machine-managed region within those files.
- **FR-022**: The primary instruction file MUST NOT have existing content removed by this feature, **except for the factual corrections mandated by FR-023 and FR-031**. It is not otherwise trimmed, restructured, or shortened.
- **FR-023**: The primary instruction file's statement of the default development environment MUST be corrected to reflect that the containerized workspace is primary and the host workspace remains required for mobile, emulator, and native work.
- **FR-024**: The two live operator documents MUST be relocated from the proposal tree into the runbook collection, with every tracked inbound reference updated and no reference to an old location remaining.
- **FR-025**: The governing directory-structure definition and the repository-structure section of the project README MUST be amended to include the bundle, with the rationale for the deviation recorded.
- **FR-026**: The tool that generates the bundle MUST be pinned to a single version, available in both supported workspaces, and its setup documented in each workspace's own setup runbook.
- **FR-027**: The containerized workspace MUST obtain generation credentials from the environment already available to it, with no new secret material stored in the workspace or its image, and no network-policy change.
- **FR-028**: The feature-completion checklist MUST require running the bundle update and including the resulting diff in the same change.
- **FR-029**: The human-judgement verification behind SC-003 and SC-004 MUST be recorded in a committed evidence document in this feature's folder — the retrieval questions with the concepts that resolved them, and the audited concepts with their outcome — so that both criteria remain verifiable after the change is merged.
- **FR-031**: Every factual claim in the primary instruction file that the generation run identified as contradicting source MUST be **independently verified against that source** and, where confirmed stale, **corrected in place**. A correction MUST NOT be made on the generator's assertion alone. Where the generator's own replacement claim is itself imprecise, the correction MUST state what the source actually does rather than adopt either wording. Rationale: the instruction file is loaded into every session, so a stale operational claim there misleads far more often than a stale wiki page — and leaving a known-false claim in place while publishing a wiki that contradicts it creates exactly the two-sources-of-truth problem this feature exists to prevent.
- **FR-030**: The generation tool's usage telemetry MUST be explicitly disabled in every environment and every invocation path. The tool transmits run events to a third-party analytics service by default; the repository MUST NOT rely on the container's egress policy to block it, because the host workspace has no such policy and would transmit. Disabling MUST be configured, not assumed, and MUST NOT be achieved by widening the container egress allowlist. It MUST be enforced by the supported invocation path itself rather than by a setup instruction a developer could skip, so that a contributor on a freshly configured workspace cannot transmit by omission.

### Key Entities

- **Concept**: One markdown file describing one subject. Carries a metadata block (kind, description, topic labels, source link, timestamp), a distilled summary, and its known pitfalls. Its path is its identity. Links to other concepts form the graph.
- **Directory summary**: The reserved per-directory page that lists contained concepts by description, enabling navigation without opening each file.
- **Generation instructions**: The version-controlled document that scopes and constrains generation — exclusions, redaction rules, the summarize-and-link rule, and priority areas.
- **Conformance gate**: The automated check that decides whether a bundle state may enter the repository. Has a self-test mode.
- **Assistant pointer**: The short reference in each coding-assistant configuration surface that tells the assistant the bundle exists and how to query it.
- **Live operator document**: A procedure document currently filed under proposals but referenced as authoritative operating procedure; relocated by this feature.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: 100% of concepts in the committed bundle pass conformance, and the check runs automatically on every change rather than on request.
- **SC-002**: Zero un-redacted hostnames, host-and-port pairs, or credential-shaped strings in the bundle, confirmed by both existing leak gates passing against it, with zero allowlist entries added.
- **SC-003**: For each of at least eight repository questions spanning distinct subsystems, an actor reaches the authoritative source by selecting on concept metadata, opening no more than two bundle files. Each question and the concepts that resolved it are recorded in the committed evidence document.
- **SC-004**: A sample of at least ten concepts is verified against the sources they cite, with 100% of identified inconsistencies corrected before the bundle lands. Each audited concept and its outcome are recorded in the committed evidence document.
- **SC-014**: 100% of drift claims surfaced during generation are independently verified against source, and every confirmed-stale claim is corrected. Claims that cannot be confirmed are left unchanged and recorded as open.
- **SC-012**: Every canonical runbook, architecture-decision record, and architecture document has at least one concept citing it, so metadata-driven retrieval covers the documentation tree with no silent gaps.
- **SC-013**: Zero telemetry events leave either workspace during any generation run, demonstrated by capturing what a run would transmit and confirming it is empty, with the egress allowlist unchanged.
- **SC-005**: All four coding-assistant configuration surfaces carry the pointer, and every machine-managed region in those files is byte-identical to its pre-change state apart from the intended insertion.
- **SC-006**: A search of the tracked tree returns zero references to the pre-move locations of the two relocated operator documents, and every updated link resolves.
- **SC-007**: The primary instruction file's content is unchanged apart from the added pointer, the environment correction, and the verified drift corrections (FR-031) — no existing line is deleted, and **hand-authored** growth stays under one kilobyte. The tool-managed block the generator maintains in that file is **excluded from the budget**: its size is controlled by the generator, not by this feature, so measuring it against a hand-authored budget would fail the criterion for a reason no change here could fix. Its measured size is recorded in the evidence document instead, so an unexpected future increase is still visible.
- **SC-008**: The feature introduces zero new stored automation credentials and zero scheduled jobs.
- **SC-009**: A generation run is reproducible from the pinned version in the containerized workspace, and the same pinned version is documented for the host workspace.
- **SC-010**: The conformance gate's self-test detects every failure class it claims to cover, demonstrated by a fixture bundle per class that fails before the corresponding validation exists and passes after.
- **SC-011**: The feature-completion checklist contains the bundle-update step, and one rehearsal run of that step is performed during this feature, producing a reviewable diff (or a verified no-op) rather than an error.

## Out of Scope

Each item below was considered and deliberately deferred.

- **Automated scheduled maintenance.** No scheduled job to regenerate the bundle, no stored automation credential for it, and no automated pull-request creation. Freshness is the checklist loop in User Story 6. Deferred to a follow-on because it would add the feature's only non-keyless automated check and a new privileged credential.

  **Staleness handling belongs here too — decided 2026-07-28 after building and reverting an alternative.** A drift-triggered variant of FR-028 was implemented (regenerate only when the gate reports a stale or uncited concept) and then reverted, because per-concept staleness is the wrong layer to solve this at:

  - Drift never clears on its own. The generator rewrites only files it *changes*, so a concept it reads and judges accurate keeps its old timestamp and reports stale **forever**. Clearing it needs a second mechanism that *asserts* verification without performing it — which can launder stale documentation as fresh, the exact failure the check exists to catch.
  - The signal fans out. 12 of 45 concepts cite `CLAUDE.md`; one edit to that file marks all 12 stale regardless of which passage changed, so the trigger fires on nearly every feature anyway.
  - **The tool's own answer is scheduled regeneration** — a job that scans commits since the last run and updates where needed. Frequency is the mechanism; per-concept staleness never needs measuring. Our timestamp-drift trigger was a repo-local invention, and `timestamp` is an OKF *last-modified* marker, not a designed staleness signal.

  So FR-028 stays as written — unconditional, simple, honest about its cost — and the freshness problem is handled properly in Phase 3 by the scheduled workflow the tool is designed around. The gate's V12 drift warning remains as **information**, not a trigger.
- **Migrating existing documentation into the bundle.** The documentation tree is referenced, never moved. Runbooks in particular remain human-owned canonical text that no generator may rewrite.
- **Adding structured metadata to existing documentation in place.** The proposal frames this as a later pilot; it would create a second knowledge surface to review inside this feature.
- **Trimming the primary instruction file.** Rationale recorded in Clarifications: the instruction file loads unconditionally, the bundle is consulted on demand, and a failed retrieval bet regresses silently. The trim is an evidence-gated follow-on requiring measured before/after.

## Assumptions

- **Two of the three originally-unverified tool behaviors were resolved during planning** by inspecting the published package (see `research.md`): the generation-instructions document lives **inside** the bundle directory and is user-authored — the tool reads it but never rewrites it; and generation **can** be driven non-interactively from environment configuration, because the update path creates the bundle when none exists and supports a one-shot print mode, so the interactive onboarding is avoidable entirely. Both are now design inputs rather than assumptions.
- **One unknown remains and MUST be bounded during the first run**: the cost and page quality of a full generation over a repository of this size. No useful target can be set before one real run. Weak output is remediated by iterating the instructions and regenerating, not by accepting it.
- **The generation tool reports usage telemetry to a third-party analytics service by default.** The container's egress policy would block it, but the host workspace has no such policy, so disabling is a configuration requirement (FR-030), not an environmental accident. The tool's documentation states that file contents, repository names, paths, and prompts are never transmitted; this feature disables it regardless, because the repository's posture is that outbound reporting is opted into deliberately, never inherited from a tool default.
- The first bundle is produced from an ad-hoc installation in the containerized workspace, while the pinned toolchain entry ships in the same change. **Known residual**: the baked path is therefore not proven end-to-end until the next workspace image refresh, which is an acceptance follow-up rather than a blocker.
- The containerized workspace already reaches the generation service and the package registry under its existing network policy, so no policy widening is needed. The repository rule against widening that policy stands.
- Adding a root-level bundle directory is a deviation from the governing directory-structure definition and requires the documented amendment in FR-025 with human approval, per the repository's governance rules.
- The full web end-to-end regression is required for this feature, with no deviation. It runs through the containerized browser path because browsers cannot be installed in the dev container under its network policy.
- A bundle-only pull request still runs the repository's full continuous-integration suite, because the pull-request trigger is not path-filtered. This is expected and is distinct from the previously documented path-filter gap on the push trigger.
- The bundle is a navigation layer whose value depends on assistants actually consulting it. This feature establishes the layer and measures its structural quality; whether retrieval changes assistant behavior enough to justify trimming the instruction file is a question for the follow-on.
