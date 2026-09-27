# Feature Specification: Cheaper wiki maintenance — Fireworks provider, fewer planning passes, a measured time budget

**Feature Branch**: `078-wiki-generator-cost`

**Created**: 2026-09-27

**Status**: Draft

**Input**: User description: "Phase 2 of the LLM cost work (docs/proposals/MCM-LLM-Cost-Analysis-1.md §3 Phase 2, §5.3). Move the OpenWiki generator in the CI wiki job to DeepSeek V4.1 Flash hosted by Fireworks AI (operator choice over DeepSeek's own API), cut the per-invocation planning cost, and size the job's time budget from the measured cost-vs-speed trade-off — increasing it if needed."

## Context — what was measured before this spec (2026-09-27)

Four instrumented one-page runs of the pinned generator (`openwiki@0.5.2`), identical settings except provider,
every model call's usage recorded by a fetch tap. The Fireworks figures reconcile **to the cent** with the
operator's Fireworks bill ($0.178 for the two runs), so the instrument is trusted.

| Page | Sonnet 5 (today) | DeepSeek V4.1 Flash on Fireworks, standard | same, priority |
|---|---|---|---|
| `gotchas/keycloak-service-account.md` (no prose change) | $0.39 | **$0.090** | $0.112 |
| `runbooks/android-emulator.md` (69 source lines changed, first Claims) | $0.62 | **$0.088** | $0.110 |

Findings that shape the requirements:

1. **Quality held.** Both DeepSeek runs exited 0, wrote the assigned page and its index, submitted Claims and
   passed OKF conformance; zero tool-call failures across 120 model calls. Four factual statements spot-checked
   against source were all correct, and the DeepSeek page picked up feature 076's account-deletion paths that the
   Sonnet run of the same page did not.
2. **The cost shape is different.** DeepSeek makes many small calls (47–73 per page vs 12–13 on Sonnet), so ~94%
   of its input is cache reads. At $0.007/M cached, that is cheap; the conclusion depends on that price.
3. **Speed is the constraint.** A one-page DeepSeek run took **~10.6 minutes**. The job's budget is 16 pages / 20
   minutes enforced *between* slices, inside a 45-minute workflow timeout, on a **single** CI runner that the
   ~35-minute `app-e2e` job also needs.
4. **Every generator invocation pays a fixed planning pass** (~$0.33 on Sonnet, 83% of a one-page run): the
   generator's planner is instructed to explore the repository before planning, even for a one-page scoped run.
   `wiki-maintain` invokes the generator **once per slice**, and slices are per wiki area — so a run touching three
   areas plans three times.
5. OpenWiki 0.5.x Grounded Claims cannot be disabled and are **not** a material cost (~$0.07 per page on first
   creation on Sonnet, sparse thereafter); they are out of scope here (backlog #513).

## User Scenarios & Testing *(mandatory)*

### User Story 1 - The wiki job runs on the cheaper provider, and can be switched back without a code change (Priority: P1)

As the repository operator, I want the merge-triggered wiki maintenance job to generate pages with DeepSeek V4.1
Flash on Fireworks AI, so that the wiki — 53% of the org's LLM bill before feature 075 and rising since the
generator upgrade — costs a fraction of what it does on Sonnet 5, with the same verification deciding success.

**Why this priority**: It is the largest single saving available (≈77–86% per page measured) and needs no change
to how success is judged — `wiki-maintain` already verifies by pages landed and bundle conformance, never by the
generator's exit status.

**Independent Test**: Trigger the wiki job on `main` with the provider configured to Fireworks; confirm the
proposal PR carries pages that pass `okf-lint` and `okf-governance`, and that the run record names the provider
and model that produced them. Switch the configuration back to Anthropic and confirm the next run uses Sonnet 5
with no repository change.

**Acceptance Scenarios**:

1. **Given** the provider is configured as Fireworks, **When** a merge burst triggers the wiki job, **Then** the
   generator is invoked with the Fireworks provider and DeepSeek V4.1 Flash model, using a credential scoped to
   this job only, and pages are verified exactly as they are today.
2. **Given** the provider is configured as Anthropic, **When** the job runs, **Then** it behaves exactly as it
   does on `main` today (Sonnet 5, explicit 16,384 output cap).
3. **Given** the Fireworks credential is absent or rejected, **When** the job runs, **Then** it fails loudly
   naming the missing or rejected credential, and never reports "nothing to do" or success.
4. **Given** a developer runs wiki maintenance locally in the dev container, **When** they select the same
   provider, **Then** local and CI drive the identical entry point (the existing local-parity guarantee holds).

---

### User Story 2 - A run plans once, not once per wiki area (Priority: P2)

As the operator, I want a maintenance run to invoke the generator as few times as it safely can, so that the fixed
planning pass — the dominant cost of a small run — is paid once per run rather than once per area.

**Why this priority**: Provider-independent: it cuts cost on Sonnet and on DeepSeek alike, and on DeepSeek it also
cuts wall-clock time, which Story 3 depends on.

**Independent Test**: Plan a run whose backlog spans at least two wiki areas; execute it; confirm from the run
record that the generator was invoked fewer times than there were areas, and that every page is still verified
individually and the "write only where assigned" boundary still holds.

**Acceptance Scenarios**:

1. **Given** a backlog touching several areas, **When** the run executes, **Then** the number of generator
   invocations is lower than the number of areas, and each assigned page is verified as landed or reported as
   failed by name.
2. **Given** a combined invocation writes outside its assigned pages, **When** verification runs, **Then** the
   run fails that invocation exactly as a per-area slice would today — consolidation does not widen the write
   boundary.
3. **Given** a combined invocation fails part-way, **When** the run ends, **Then** pages that landed are kept and
   pages that did not are carried forward to the next run, with nothing reported as done that was not written.

---

### User Story 3 - The time budget fits the provider's measured speed, and the runner trade-off is explicit (Priority: P2)

As the operator, I want the wiki job's time budget set from measured per-page duration on the chosen provider and
tier (standard vs priority), so that a slower-but-cheaper model still makes progress each run, without the job
holding the single CI runner for longer than I have agreed to.

**Why this priority**: At ~10.6 minutes per one-page run, today's 20-minute budget would complete about two
invocations per run on DeepSeek; the saving from Story 1 is only real if pages still get written.

**Independent Test**: Run the measurement defined in the plan (the same pages on each candidate provider/tier);
record per-page duration and cost; set the budget and workflow timeout from those figures; confirm a subsequent
real run completes its planned pages within the new budget.

**Acceptance Scenarios**:

1. **Given** measured per-page durations for each candidate, **When** the budget is chosen, **Then** the spec's
   decision record states the cost and the runner-minutes of each option and which was chosen and why.
2. **Given** the budget is raised, **When** the job runs, **Then** the workflow timeout stays above the budget's
   effective ceiling (including the one-invocation overshoot), so the job is never killed mid-page by the
   platform instead of stopping cleanly at the budget.
3. **Given** a run stops at the budget with work outstanding, **When** it exits, **Then** it reports "stopped at
   budget" (not failure) and the next run picks up the remainder.

---

### User Story 4 - Every run records what it cost (Priority: P3)

As the operator, I want each maintenance run to record its token usage and estimated cost per invocation and per
page, so that cost and speed are measured on real runs rather than inferred from a console export days later.

**Why this priority**: The run budget today is explicitly "not a monetary bound" because the generator reports no
usage. The instrument built for this spec's research reconciled to the bill exactly; keeping it turns the next cost
question into a lookup.

**Independent Test**: After a run, read the run record and confirm it lists, per generator invocation, the
provider, model, call count, uncached/cached/output tokens, duration, and an estimated cost from a declared price
table — and that a run with the instrument unavailable says so rather than reporting zero.

**Acceptance Scenarios**:

1. **Given** a completed run, **When** the operator reads its record, **Then** per-invocation usage, duration and
   estimated cost are present, with the price table and its date named.
2. **Given** the usage could not be captured, **When** the record is written, **Then** it states "usage not
   captured" explicitly; it never records zero cost.
3. **Given** the record is committed to the proposal branch or published in the job log, **Then** it contains no
   credential, prompt text or file content — counts, names and timings only.

---

### Edge Cases

- The Fireworks model id is withdrawn or renamed → the pre-flight invocability check fails the job before any
  paid work, naming the id (the 075 lesson: a config guard is not proof a model can be called).
- Fireworks returns rate-limit or 5xx errors mid-page → the page is reported as not landed and carried forward;
  it is never counted as written.
- The provider silently stops caching (cached share collapses) → Story 4's record shows it; a run whose cached
  share falls below a declared floor is flagged in the job log.
- DeepSeek writes a page that passes conformance but is wrong → unchanged from today: the output is a proposal PR
  for human review, never auto-merged.
- A combined invocation's planner schedules pages the run did not assign (OpenWiki adds pages with Claims issues
  to every update plan) → those writes are outside the assignment and verification must treat them exactly as it
  does today.
- The operator switches provider mid-backlog → pages already written stay; the remainder is written by the newly
  configured provider; the run record names the provider per invocation.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: The wiki job MUST select its generator provider and model from configuration that the operator can
  change without a code change, with exactly two supported values in this feature: Anthropic (Sonnet 5, today's
  behaviour) and Fireworks (DeepSeek V4.1 Flash).
- **FR-002**: The default for the CI wiki job MUST become Fireworks / DeepSeek V4.1 Flash once Story 3's
  measurement is recorded; until then the default stays Anthropic.
- **FR-003**: The Fireworks credential MUST be a secret dedicated to the wiki job, carried in the dev container as
  `MCM_FIREWORKS_API_KEY` and mapped to the generator's expected name only at the point of use — the same rule the
  Anthropic key follows. It MUST NOT appear in a process argument list, an image layer, or a log.
- **FR-004**: The per-turn output cap MUST be set explicitly for every provider (the 4,096-fallback lesson of
  feature 043 is provider-independent), and the existing generator guard MUST continue to pass unmodified for the
  Anthropic configuration; it MUST gain an equivalent assertion for the Fireworks configuration rather than being
  relaxed.
- **FR-005**: Before any paid work, the job MUST confirm the configured model is invocable with the parameters
  this repository sends, failing — not skipping — when the credential or model is missing.
- **FR-006**: A missing or rejected credential for the configured provider MUST fail the job with a message naming
  it, and MUST NOT be reported as "nothing to do".
- **FR-007**: A maintenance run MUST invoke the generator fewer times than the number of wiki areas in its
  backlog whenever more than one area is scheduled, while keeping per-page verification, the per-invocation write
  boundary, and carry-forward of unwritten pages.
- **FR-008**: The page and time budgets and the workflow timeout MUST be set from the Story 3 measurement and
  recorded with their derivation; the workflow timeout MUST exceed the budget's effective ceiling including the
  non-interruptible overshoot of one invocation.
- **FR-009**: The choice between Fireworks standard and priority tiers MUST be recorded with the measured cost and
  duration of each; if priority is chosen, the mechanism that selects it MUST be verified by a measurement (a
  duration or billing difference), not assumed from an accepted request parameter.
- **FR-010**: Each run MUST record, per generator invocation: provider, model, tier, call count, uncached /
  cached / output tokens, duration, and estimated cost from a dated price table — or state explicitly that usage
  was not captured.
- **FR-011**: The usage record MUST contain no credential, prompt, or file content.
- **FR-012**: The dev container's egress allowlist and credential passthrough MUST carry the Fireworks host and
  key (delivered by PR #586; this feature depends on it rather than duplicating it).
- **FR-013**: Documentation MUST be updated at the canonical sources: the wiki-maintenance runbook (provider
  switch, budget derivation, reading the usage record), the model-provider scoping invariant (the wiki's
  provider is now configurable and differs from the gateway's), and the cost analysis proposal §5.
- **FR-014**: The output of every run MUST remain a proposal PR for human review; this feature MUST NOT introduce
  auto-merge.

### Key Entities

- **Provider configuration**: which generator provider/model/tier the job uses, where it is set, and its default.
- **Run usage record**: per-invocation counts, duration and estimated cost, plus the price table it was computed
  from.
- **Budget decision record**: the measured per-page cost and duration for each candidate provider/tier, the
  chosen budget and timeout, and the runner-minutes they commit.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: Median cost per page written by the CI wiki job falls by at least 70% against the 22–26 Sep baseline
  of $0.90 per page, measured over at least 10 real runs.
- **SC-002**: The share of planned pages that land and pass verification is no lower than on Sonnet 5 over the
  same number of runs (no reliability regression traded for cost).
- **SC-003**: On a run whose backlog spans two or more areas, the generator is invoked fewer times than there are
  areas.
- **SC-004**: No run is killed by the platform timeout; every over-budget run ends as "stopped at budget" with its
  remainder carried forward.
- **SC-005**: The estimated cost in the run record is within 5% of the provider's billed amount for the same runs.
- **SC-006**: Switching the provider back to Anthropic takes one configuration change and no code change, and the
  next run uses it.

## Assumptions

- Fireworks prices as supplied by the operator on 2026-09-27: standard $0.22 / $0.007 / $0.66 per M
  uncached / cached / output; priority $0.275 / $0.00875 / $0.825.
- The generator stays pinned at `openwiki@0.5.2`; its planner behaviour (explore-before-plan) and mandatory Claims
  are taken as given. Upgrading it is out of scope.
- The CI runner remains capacity-1; the operator accepts some extra runner time for the wiki job in exchange for
  the saving, with the amount fixed by the Story 3 decision record.
- Data residency: DeepSeek V4.1 Flash served by Fireworks AI (US-hosted) was chosen by the operator over
  DeepSeek's own API.
- Out of scope: Grounded Claims adoption follow-ups (#513), the agent gateway's thinking/effort settings, Phase 3
  (the gateway's OpenAI-compatible provider), and the #525/#526 regeneration backlog, which stays on hold until this
  feature lands.
