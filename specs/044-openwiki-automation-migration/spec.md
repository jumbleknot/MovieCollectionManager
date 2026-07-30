# Feature Specification: OpenWiki Automated Maintenance and Content Relocation

**Feature Branch**: `044-openwiki-automation-migration`

**Created**: 2026-07-28

**Status**: Draft

**Input**: User description: "Feature 044: OpenWiki follow-ups from feature 043. Three scoped areas: (1) bounded-slice generation — generate/publish OpenWiki content in bounded slices rather than whole-repo passes; (2) scheduled staleness handling — detect and act on stale wiki content on a schedule; (3) move content INTO OpenWiki instead of only linking to it — e.g. relocate sections of CLAUDE.md into OpenWiki pages and replace them with links in CLAUDE.md."

## Clarifications

### Session 2026-07-29

- Q: Where does relocated content live, and who owns it afterwards? → A: **Neither of the offered ownership models. Replace the location-based rule with a declared per-path regeneration policy.** Feature 043's rule — everything under the bundle may be regenerated, everything under the documentation tree is human-owned — is no longer true and was never quite true: no documentation file here is strictly hand-authored, but some paths make no sense to regenerate. The repository declares a policy per path instead: *regenerate* (may be rewritten as the repository changes — the runbooks, the architecture documents, the primary instruction file, and bundle concepts), *event-driven* (never written as a side effect of repository change; written only when a specific event calls for it — including **creating** a new document, so a decision reached produces a new decision record and a decision superseded amends an existing one, and a template changes when it needs to), and *excluded* (never analyzed, never written — the proposal tree, and now the test-data fixture). This makes the ownership question answerable per path rather than per directory tree, and is what makes relocation into the bundle safe.
- Q: "Regenerated" by which actor? → A: **By an agent doing normal specification-driven work, under human review — not by the generator on a schedule.** The generator writes only into the bundle (plus its own managed block in the assistant configuration files); it cannot rewrite runbook bodies or the instruction file's content, and giving it that power would place precision operator procedures under unsupervised rewrite — a hazard the originating proposal named explicitly. The policy declared here is governance over what an agent may rewrite, and the basis for deciding what may safely be relocated. Expanding the generator's write scope is a separate feature.
- Q: How much of the primary instruction file moves, and what gates further tranches? → A: **The full trim.** The instruction file becomes a thin index of links into the bundle. Consequence accepted deliberately: this takes the bet feature 043 declined, across the whole file at once. It is made safe not by limiting the tranche but by making the failure mechanical — every relocated passage is fingerprinted at relocation time and the fingerprint is asserted by the always-on gate, so a later regeneration that paraphrases a load-bearing gotcha away fails the build rather than relying on a reviewer noticing.
- Q: What is the schedule cadence and trigger? → A: **On merge to the main branch, debounced, plus manual dispatch.** Maintenance follows the work that caused the drift, so each run is small and reacts to a known change set. No weekly sweep. Accepted costs: contention with the capacity-constrained runner, and spend that scales with merge rate — both bounded by the per-run spend ceiling (see the 2026-07-30 session) and by the run being off the merge-gating path.
- Q: Is the specification tree in scope for the bundle? → A: **Analyzable, but not a coverage target — made explicit.** Feature 043 excluded only the proposal tree and required coverage only of runbooks, decision records, and architecture documents, which left the specification tree in an undeclared middle state: exactly one concept links the folder, and no per-feature concepts exist. That outcome is correct and is now stated as policy. A merged feature's specification is a historical record superseded by the code, so enumerating them would fill metadata-driven retrieval with dead work-units — the proposal-tree argument, one notch weaker. Handoff documents are the named exception: they carry live measured knowledge, not history.
- Q: Should the test-data fixture remain in scope? → A: **Excluded explicitly.** It is a single binary spreadsheet consumed as a unit-test fixture with count-derived assertions, not documentation — there is nothing to summarize. It is already excluded by the binary-asset rule, but by accident rather than by decision. The file itself stays where it is: its path is referenced by a unit test, a feature specification's success criteria, that feature's tasks, and its quickstart, so relocating it is churn against count-derived assertions for no benefit. The load-bearing fact about it — that editing it requires re-running the consuming projects' unit and lint targets — already lives in the agent-layer document and is reachable from the bundle.
- Q: Does this feature introduce the repository's first non-keyless automated job and a new stored credential? → A: **No — that claim was wrong and is corrected.** `ANTHROPIC_API_KEY` is already a configured Forgejo Actions secret consumed by the existing end-to-end and dynamic-scanning jobs, alongside sixteen other stored secrets; `guardrails` is the workflow that is keyless, not the repository. A write-scoped repository credential for opening a proposal also already exists (the `CD_PUSH_TOKEN` precedent). The maintenance run is therefore a **new consumer of existing secrets**, and this feature introduces no new credential. The error came from over-reading feature 043's handoff, which said "the *feature's* first non-keyless scheduled job" — true within the OpenWiki work, false about the repository.
- Q: After the trim, where does an assistant write a new learning? → A: **Into the canonical home of the subject, determined mechanically from whether the covering concept cites an upstream source.** A concept that cites a source is a derived summary, so the learning goes to that source — an operational learning belongs in the runbook, not in the page summarizing it. A concept with no upstream source is authoritative, so the learning goes into the concept; that is where relocated instruction-file content lives. The instruction file itself becomes an index and never accumulates prose again; a check fails if it does. The alternative — keep writing to the instruction file and let the post-merge run relocate it — was rejected on a hard constraint, not a preference: it would require an automated run to rewrite instruction-file *content*, which is exactly the generator scope expansion excluded above, and it would reinstate the grow-then-trim cycle this feature exists to end. Two consequences: the load-bearing fingerprint set is **open** rather than closed at relocation time, and it is restricted to authoritative concepts — fingerprinting a derived summary would freeze it against the document it summarizes.
- Q: Does the "write into the bundle" rule apply to every *regenerate* path, and to every *event-driven* path? → A: **No — the two axes are orthogonal, and only the instruction file's destination changes.** The policy states govern *when* a path may be written; the canonical-home rule governs *where* a learning goes. Runbooks and the architecture document are `regenerate` **and** canonical, so learnings go into them exactly as they do today. Decision records and templates are `event-driven` **and** canonical, so learnings go into them too — `event-driven` constrains the trigger, not the destination. The one change this feature makes is that content relocated out of the instruction file becomes canonical *in the bundle*, because it no longer has anywhere upstream to live.
- Q: Does the agent-layer document stay, and where? → A: **It stays, and moves into the runbooks directory.** It is mandatory reading before any agent work, is cited by five feature specifications and two bundle concepts, and was last extended two features ago — it is load-bearing. But it is misfiled: only its first section is architecture, and its remaining seven sections are operational, which is why the instruction file already calls it a runbook. The known cost of the move is that a pure rename produced permanent false drift warnings in feature 043; this feature removes that failure mode by construction, so the move is cheaper inside it than outside it.

### Session 2026-07-30

- Q: What is the debounce window for merge-triggered maintenance? → A: **Trigger once the main branch has been quiet for roughly 15 minutes**, rather than on a fixed clock window that would either fire mid-burst or delay a lone merge for no reason. A quiet-branch condition collapses a burst of merges into a single run naturally, and 15 minutes keeps the bundle tracking the day's work while sitting well inside the window the run must not contend with. **Consequence that must be handled**: a sufficiently busy day may never produce a 15-minute quiet period, which would starve maintenance indefinitely — so a maximum deferral MUST cap the wait and force a run regardless. Manual dispatch bypasses the debounce entirely.
- Q: Where does the load-bearing mark and its fingerprint live? → A: **In a version-controlled sidecar manifest, outside the generator's write scope.** In-content markers were rejected because they place the guard inside the blast radius it guards against: a refresh could strip the marker, and a stripped marker reads as "not protected" rather than as a failure. A manifest makes the removal of protection a reviewable diff in a single file instead of an absence nobody notices. Accepted cost: a concept does not itself show that one of its passages is protected, so a gate failure must name the passage precisely enough for someone who was not expecting it. The manifest is the authority — a protected passage that no longer appears in its concept is a failure, not a silent removal — and changing a protected passage legitimately means updating the manifest in the same change, which is the deliberate, reviewable escape hatch that keeps the gate from becoming a permanent blocker.
- Q: Is the one-time instruction-file trim performed through the slice machinery, or as a separate operation? → A: **Through the slice machinery, invoked manually via the local path.** The trim is the largest generation job in this feature and closely resembles the workload that defeated feature 043 in eight consecutive attempts, so it is exactly what the machinery exists for; running it any other way would leave the automation's hardest case unproven until the first live merge. Its run record therefore doubles as the acceptance evidence for User Story 1, replacing synthetic validation with a real workload. **Consequence — a priority correction**: this makes User Story 4's local invocation path a prerequisite for User Story 3 rather than a convenience, so User Story 4 is raised from P3 to P2 and its ordering relative to User Story 3 is now load-bearing.
- Q: What does a run do when a previous proposal is still unreviewed? → A: **Update the open proposal in place.** At most one maintenance proposal exists at any time; a new run rebases it onto the current main branch and adds its work to the same branch, so the proposal always reflects everything outstanding and stays mergeable. Rejected: skipping (drift accumulates untracked, and a slow review silently disables maintenance — the failure this feature exists to remove), queueing (backlog latency becomes bounded by review speed), and superseding (discards accumulated review comments). Accepted cost: the review target moves while a human is reading it. Two consequences that must be handled rather than assumed: human commits already on the proposal branch — a remediation edit to the generation brief, for instance — MUST survive the update; and if the proposal is ever closed without merging, the work it covered MUST return to outstanding, because the run marker would otherwise certify coverage that never landed.
- Q: What bounds the amount of generation a single maintenance run performs? → A: **An explicit per-run spend ceiling.** Cost is bounded directly rather than via a proxy such as page count or elapsed time. Enforced at slice granularity: cumulative spend is checked before each slice starts, and a slice that would breach the ceiling is not started but carried forward instead. Two consequences accepted: the effective bound is the ceiling plus at most one in-flight slice, since a slice already running is not interrupted; and the ceiling bounds **money only** — it does not bound how long a run occupies the build runner, so FR-019's non-contention requirement is satisfied separately rather than as a side effect of this choice.

## User Scenarios & Testing *(mandatory)*

Feature 043 delivered the knowledge bundle: 45 concepts across 8 directories, full navigational
coverage of every canonical document, and a fail-closed conformance gate that runs on every change.
It deliberately deferred three things, and each deferral has now produced a measured problem.

**The bundle was generated by hand, in eight attempts, because the generator cannot complete a large
pass in one invocation — and reports success when it gives up.** One run worked for twelve minutes,
terminated mid-sentence, wrote a single index file, and exited with a success status. Another
exhausted memory after minutes of paid work. A refresh against a partially-written bundle stamped
its own progress marker and exited successfully in under three minutes having done nothing. The
generator's success status is not evidence that anything was produced.

**Nothing keeps the bundle current except a human remembering to run it.** Feature 043's freshness
mechanism is a line in the feature-completion checklist. It also built a drift-triggered alternative,
measured it, and reverted it: per-concept staleness is the wrong layer, because a concept the
generator reads and judges accurate keeps its old timestamp and reports stale forever, and because
one edit to the primary instruction file marks a quarter of the bundle stale at once regardless of
which passage changed. The bundle currently reports nineteen drift warnings on a freshly-merged main
branch. That is the noise floor, and nothing acts on it.

**The primary instruction file still carries everything it carried before.** Feature 043 added a
pointer to the bundle and removed nothing, on the reasoning that the instruction file loads
unconditionally while the bundle is consulted on demand, so relocating load-bearing knowledge is a
bet that assistants actually retrieve it. That bet is now testable — the bundle exists and its
retrieval behaviour was measured — but the file continues to grow, and every session pays for all of
it regardless of what the session touches.

The primary actor throughout is the **AI coding assistant working in this repository**, with a
**human maintainer** as the reviewing actor for every change the automation proposes.

### User Story 1 - A maintenance run never claims success without producing verified work (Priority: P1)

A maintainer (or automation triggered by a merge) asks for the knowledge bundle to be brought up to date. The
request is decomposed into bounded slices before any generation begins. Each slice is
attempted, and its result is verified against what was asked for — pages actually written, bundle
still conformant — rather than against the generator's own success status. A slice that produced
nothing is reported as a failure, loudly, with the work still outstanding.

**Why this priority**: This is the foundation. Every other story in this feature invokes generation,
and today generation can silently produce nothing while reporting success. Automating an unverified
step multiplies the problem instead of solving it — automation on top of a false-green
generator produces a false green on every merge. Without this story, nothing else in the feature can be
trusted.

**Independent Test**: Request an update that is known to require substantial new content. Confirm the
work is decomposed into bounded slices before generation starts, that each slice's result is asserted
against the request, and that an intentionally sabotaged slice (one that produces nothing) is reported
as a failure rather than a success. Delivers value even if no automation and no relocation ship: it
makes the existing manual loop honest.

**Acceptance Scenarios**:

1. **Given** an update request covering more content than a single generator invocation can complete, **When** the request is prepared, **Then** it is decomposed into bounded slices each no larger than the measured reliable size, and no slice combines extending an existing area with creating a new one.
2. **Given** a slice is attempted, **When** the generator reports success but wrote no pages, **Then** the run is reported as failed and the slice remains outstanding.
3. **Given** a slice is attempted, **When** the generator writes pages that violate the bundle's conformance rules, **Then** the run is reported as failed and the violation is surfaced.
4. **Given** a multi-slice request is interrupted after some slices complete, **When** the request is re-issued, **Then** the completed slices are not repeated and the outstanding slices are attempted.
5. **Given** the decomposition step, **When** it runs, **Then** it produces its plan without invoking any paid model and without network access, so the plan is reviewable before any cost is incurred.

---

### User Story 2 - The bundle stays current without a human remembering (Priority: P1)

When work lands on the main branch, the repository checks what has changed since the last recorded
maintenance run and brings the affected parts of the knowledge bundle up to date. The result is proposed to
humans as a reviewable change, never applied silently. A run that finds nothing to document costs
nothing and says so. A run that fails says why, in a form the next session can read without
out-of-band access.

**Why this priority**: Freshness is the reason the bundle exists. A knowledge layer that silently
falls behind its sources is worse than no knowledge layer, because it is confidently wrong. The
current mechanism — a checklist line — has already been shown to leave a nineteen-warning drift
backlog on a clean main branch.

**Independent Test**: Land a change that alters a documented subsystem. Confirm the triggered
maintenance detects it, produces an updated bundle covering that change, and proposes it for human
review without merging it. Separately, run the maintenance against an unchanged repository and
confirm it completes cheaply and proposes nothing.

**Acceptance Scenarios**:

1. **Given** a merge lands and sources have changed since the last recorded run, **When** maintenance executes, **Then** it updates the affected parts of the bundle and proposes the result as a change for human review.
2. **Given** a merge lands and nothing relevant has changed since the last recorded run, **When** maintenance executes, **Then** it completes without invoking a paid model and proposes no change.
3. **Given** maintenance produces an updated bundle, **When** the proposal is created, **Then** it is never merged automatically, and the repository's existing credential, topology, and conformance gates run against it exactly as they would for a human-authored change.
4. **Given** maintenance produces content that a credential or topology gate rejects, **When** the failure is reported, **Then** remediation is a correction to the hand-authored generation brief followed by a re-run — never an exemption for the rejected content.
5. **Given** maintenance fails for any reason, **When** a maintainer or assistant investigates, **Then** the failure evidence is retrievable through the repository's existing self-serve diagnostics path without out-of-band access to the runner.
6. **Given** the merge-gating validation pipeline is occupying the capacity-constrained runner, **When** maintenance runs, **Then** it does not contend with that pipeline, and its outcome never blocks an unrelated change from merging.
7. **Given** a previous run's proposal is still unreviewed, **When** maintenance is triggered again, **Then** that same proposal is rebased onto the current main branch and extended with the new work, no second proposal is opened, and any human commits already on it survive.

---

### User Story 3 - The always-loaded instruction file becomes a thin index (Priority: P2)

A maintainer relocates the primary instruction file's content into the knowledge bundle, leaving a
thin index of links in its place. Assistants that need a detail retrieve it; assistants that do not,
no longer pay for it on every session. Nothing is lost in the move: every relocated passage is
verifiably present at its destination, word for word, and the destination is reachable from where the
passage used to be.

**Why this priority**: This is the payoff the bundle was built for, but it depends on Stories 1 and 2.
Relocating knowledge into a bundle that cannot be reliably regenerated, or that silently falls behind,
moves load-bearing operational detail somewhere less trustworthy than where it started. Feature 043
declined this trim on the grounds that it bets on retrieval actually happening and that a failed bet
regresses silently; this story takes the bet, and removes the "silently" by fingerprinting every
relocated passage so that a later paraphrase fails a gate instead of escaping review.

**Independent Test**: Perform the relocation. Measure the instruction file before and after. Confirm
every relocated passage is present verbatim at its destination, that a link from the original location
reaches it, and that a set of repository questions previously answerable from the instruction file
remains answerable — with the answer now arriving through the bundle.

**Acceptance Scenarios**:

1. **Given** a passage is selected for relocation, **When** the relocation is complete, **Then** the passage's content is present at its destination, the original location carries a link to that destination, and no fact present before the move is absent after it.
2. **Given** relocated content lives in the bundle, **When** a subsequent generation run rewrites, reorders or paraphrases a relocated passage, **Then** an always-on check fails, identifying the passage that changed.
3. **Given** the relocation is complete, **When** the instruction file is measured, **Then** its size is demonstrably reduced against the recorded before-measurement, and the reduction is recorded as committed evidence.
4. **Given** a set of repository questions that the instruction file answered before the move, **When** an actor is given only the trimmed instruction file and the bundle, **Then** each question is still answerable, and the path taken is recorded as committed evidence.
5. **Given** the instruction file contains machine-managed regions maintained by other tooling, **When** the relocation is applied, **Then** those regions are unaltered.
6. **Given** the repository carries several assistant-facing configuration surfaces, **When** the relocation is applied, **Then** all of them remain mutually consistent — none is left pointing at content that has moved.
7. **Given** the instruction file is reduced to an index, **When** an assistant reads only that index, **Then** it can determine which bundle concept holds any given subject without opening the bundle, so retrieval is directed rather than exploratory.

---

### User Story 4 - A maintainer can run and resume the same maintenance locally (Priority: P2)

A maintainer runs the identical maintenance path on a workstation or in the development container —
same decomposition, same verification, same bounded slices — inspects the proposed plan before paying
for it, and resumes an interrupted multi-slice run without repeating completed work.

**Why this priority**: Raised from P3 to P2 because it became load-bearing. The one-time trim in
Story 3 runs through this path (FR-027aa), so Story 3 cannot be delivered without it, and this story
must land before Story 3. It also makes the automation debuggable and lets a maintainer force a
refresh without waiting for a merge.

**Independent Test**: Run maintenance locally against a repository state with known outstanding work.
Confirm the plan is shown before generation, that generation can be limited to a subset, and that
re-running resumes rather than restarts.

**Acceptance Scenarios**:

1. **Given** a maintainer runs maintenance locally, **When** the plan is produced, **Then** it is inspectable before any generation is attempted.
2. **Given** an interrupted local run, **When** it is re-invoked, **Then** it resumes from the outstanding work.
3. **Given** a maintainer runs maintenance locally, **When** it invokes the generator, **Then** it uses the same sanctioned invocation path as the automated run — the same memory ceiling, the same pinned model, and the same telemetry opt-out.

---

### Edge Cases

- **The generator reports success but writes nothing.** Measured repeatedly. The run must be judged by delivered pages and bundle conformance, never by the generator's exit status.
- **The generator exhausts memory mid-slice.** Partial output may be on disk. The slice must be treated as failed and its partial output must not be mistaken for completion by the next run.
- **A slice mixes extending an existing area with creating a new one.** The single measured decomposition that produced zero pages was the only one shaped this way. This shape must not be plannable.
- **Nothing has changed since the last run.** The cheap path must actually be reachable — the run marker must advance even when a run legitimately finds nothing to document, or every subsequent run pays full cost to re-discover the same nothing.
- **The stored model credential is missing, expired, or revoked.** The run must fail loudly and distinguishably from "nothing to do", never silently degrade to a no-op that looks like success.
- **A previous run's proposal is still open and unreviewed.** This is the steady state, not an exception. The run extends that proposal rather than opening a second one, which means the review target moves while a human is reading it.
- **A human has committed to the open proposal branch** — a remediation edit to the generation brief, say — and a run then updates that proposal. A naive regeneration would discard the human's fix and reintroduce whatever it corrected.
- **A proposal is closed without merging.** The run marker would otherwise still certify its work as covered, leaving a permanent gap that no later run re-detects. Closing must return that work to outstanding.
- **Generated content trips a credential or topology gate.** The remediation path is the generation brief, never an exemption entry.
- **Generated content trips the bundle's own conformance gate.** The proposal must not be created, or must be created visibly failing — never created in a state that looks reviewable but cannot merge.
- **A maintenance run collides with the merge-gating validation pipeline** on a capacity-constrained runner. The maintenance run must not starve or be starved by the pipeline that gates merges.
- **A maintenance proposal is merged, and that merge triggers maintenance.** The mechanism would feed itself indefinitely. Bundle-only changes must not re-trigger a run.
- **A relocated passage has no upstream authoritative source to cite.** Bundle concepts are built to summarize and link to a canonical source; a passage relocated *into* the bundle is itself canonical. The bundle's structural rules must accommodate this without weakening the rule that every other concept cites something real.
- **A regeneration paraphrases a load-bearing gotcha into something plausible but wrong.** After a full trim, no hand-authored copy remains anywhere except the generation brief, and human review of a large generated diff is a weak control. This must fail mechanically, not by inspection.
- **A link left behind by relocation points at a bundle page the generator later renames or removes.** The link must not be allowed to rot silently.
- **The instruction file already carries three machine-managed regions**, written by three different tools, one of which currently asserts a scheduled workflow exists — which is why a hand-authored correction note sits beneath it. The relocation adds a fourth writer to that file and must not collide with any of them, and must leave the correction note accurate.
- **A path is written by a run despite its declared policy forbidding it** — for example, a decision record rewritten as a side effect of a repository change rather than because a decision was superseded. The policy must be enforced, not documented.
- **A decision is reached and merged with no decision record written.** An *event-driven* path is not satisfied by being left alone: the missing record is the failure, and it must be surfaced rather than passing silently.
- **An assistant records a learning the old way**, appending prose to the instruction file after the trim. The file re-grows and the trim is undone within weeks unless a check rejects it on the change that introduces it.
- **A learning is written into a concept and a later regeneration paraphrases it.** Relocation-time fingerprints do not cover it, because it arrived afterwards. The protected set must be open to passages marked at any time, not fixed at relocation.
- **An operational learning is written into the concept summarizing a runbook rather than into the runbook.** The summary silently becomes the more current of the two, the runbook stays authoritative but wrong, and the next refresh overwrites the learning from its stale source. The destination rule must be mechanical, not a judgement call.
- **A derived summary is marked load-bearing and fingerprinted.** It is then frozen against the document it summarizes, and every subsequent refresh fails the fingerprint check — turning the protection into a permanent blocker. Only authoritative content may be protected.
- **A protected passage genuinely needs correcting.** If the only way to change it is to defeat the gate, the gate will be defeated. Updating the manifest in the same change must be the supported path.
- **A protected passage is deleted outright** rather than reworded. A fingerprint comparison against absent text must fail as a removal, not pass because there is nothing to mismatch.
- **Someone edits a concept without knowing a passage in it is protected**, because the concept does not say so. The failure must tell them which passage and what changed, or the manifest's invisibility becomes its own trap.
- **A run costs far more than expected.** The spend ceiling must stop the run before the next slice starts, not report the overrun afterwards.
- **The generator does not report what a slice consumed.** The ceiling becomes unenforceable. An unavailable spend figure must fail the run, never be treated as zero spend — otherwise the bound silently disappears.
- **A single slice's spend exceeds the whole ceiling.** The run cannot subdivide further and cannot interrupt work in flight, so the overshoot must be bounded and declared rather than discovered.
- **A maintenance proposal is never reviewed.** The backlog must remain visible rather than accumulating silently.
- **The main branch is never quiet long enough to trigger a run.** On the busiest days — exactly when the bundle drifts fastest — the debounce would defer indefinitely. A maximum deferral must force the run.
- **Several merges land during a single run.** They arrived after the run computed its change set, so they must be picked up by the next trigger rather than silently falling between the two.

## Requirements *(mandatory)*

### Functional Requirements

#### Bounded-slice generation

- **FR-001**: Any request to generate or refresh bundle content MUST be decomposed into bounded slices before any generation is attempted.
- **FR-002**: Each slice MUST be limited to at most **eight pages** — the largest size feature 043 measured as reliably delivered, across two independent successful runs — and MUST NOT combine adding content to an existing bundle area with creating a new bundle area.
- **FR-003**: The decomposition step MUST be deterministic, MUST run offline, and MUST NOT invoke a paid model — so that the plan can be reviewed and tested without cost.
- **FR-004**: The decomposition step's output MUST be inspectable by a human or an assistant before any generation is attempted.
- **FR-005**: After each slice, the result MUST be verified against what was requested — the pages actually produced and the bundle's continued conformance. The generator's own success status MUST NOT be accepted as evidence of completion.
- **FR-006**: A slice that produces no pages MUST be reported as a failure, and MUST leave the work recorded as outstanding.
- **FR-007**: Outstanding work MUST persist across invocations, so that an interrupted or partially-completed request resumes rather than restarts, and completed slices are not repeated.
- **FR-008**: The decomposition and verification behaviours MUST be exercised by automated tests that run offline, without credentials, and without invoking a model.

#### Automated maintenance

- **FR-009**: Bundle maintenance MUST execute automatically on merges to the main branch, triggered once the branch has been quiet for approximately **15 minutes**, so that a burst of merges collapses into a single run. There is no periodic sweep.
- **FR-009b**: A **maximum deferral** MUST cap the debounce wait and force a run even if the quiet period never arrives. Without it, a sustained run of merges starves maintenance indefinitely — the busiest days, when the bundle drifts fastest, would be the ones that never trigger a run.
- **FR-009c**: Manual dispatch MUST bypass the debounce entirely.
- **FR-009a**: A maintenance run's own proposal, once merged, MUST NOT trigger a further maintenance run. Changes confined to the bundle MUST NOT re-trigger maintenance, so the mechanism cannot feed itself.
- **FR-010**: An automated maintenance run MUST determine what needs updating from what has changed in the repository since the last recorded maintenance run — not from per-concept staleness markers.
- **FR-011**: An automated maintenance run MUST be bounded by an explicit **per-run spend ceiling**. The ceiling MUST be enforced at slice granularity: cumulative spend is checked before each slice is started, and a slice that would breach the ceiling MUST NOT be started — it carries forward to the next run instead.
- **FR-011a**: Because a slice already in flight is not interrupted, the effective bound is the ceiling plus at most one slice's spend. That overshoot MUST be bounded and stated, not open-ended.
- **FR-011b**: Enforcing a spend ceiling requires per-run spend to be **observable**. Where the generator does not report consumption directly, the run MUST derive it from a recorded proxy and MUST treat an unavailable spend figure as a failure rather than as zero — an unmeasurable run must not proceed as if it were free.
- **FR-011c**: The spend ceiling bounds cost only. It does not bound how long a run occupies the build runner, so FR-019's non-contention requirement MUST be satisfied by its own mechanism rather than as a side effect of the cost bound.
- **FR-012**: An automated maintenance run MUST record its own progress marker even when it legitimately finds nothing to document, so that the no-cost path remains reachable on subsequent runs.
- **FR-013**: An automated maintenance run MUST propose its result as a reviewable change requiring human approval. It MUST NOT merge or apply changes to the main branch automatically.
- **FR-014**: A proposal produced by an automated maintenance run MUST be subject to the repository's existing credential, topology, and bundle-conformance gates, on the same terms as a human-authored change.
- **FR-015**: When a gate rejects generated content, remediation MUST be a change to the hand-authored generation brief followed by a re-run. Adding an exemption for the rejected content is prohibited.
- **FR-016**: At most **one** maintenance proposal MUST exist at any time. When a proposal is already open, a run MUST update it in place — rebasing it onto the current main branch and adding its work to the same proposal — rather than opening a second one or skipping.
- **FR-016a**: Updating an open proposal MUST preserve commits a human has already made to it, such as a remediation edit to the generation brief. The update MUST NOT discard human work in favour of regenerated content.
- **FR-016b**: If a proposal is closed without merging, the work it covered MUST return to outstanding and the run marker MUST NOT continue to certify that work as covered — otherwise abandoning a proposal creates a permanent, invisible gap in the bundle.
- **FR-017**: An automated maintenance run MUST distinguish, in its reported outcome, between "nothing to do", "work completed", and "failed" — and MUST NOT report a credential, capacity, or generator failure as "nothing to do".
- **FR-018**: An automated maintenance run MUST publish machine-readable failure evidence retrievable through the repository's existing self-serve diagnostics path, without out-of-band access to the runner.
- **FR-019**: The automated run's outcome MUST NOT block unrelated changes from merging, and the run MUST be sequenced so that it does not contend with the change-triggered validation pipeline on the capacity-constrained runner.
- **FR-020**: An automated maintenance run MUST be manually invocable on demand, using the same code path as the triggered invocation.
- **FR-021**: All generation, automated or local, MUST use the sanctioned invocation path that applies the pinned model, the raised memory ceiling, and the telemetry opt-out. A bare invocation of the underlying tool is prohibited.
- **FR-022**: This feature MUST NOT widen the development container's network egress allowlist. Telemetry MUST remain disabled by configuration.

#### Credential and security posture

- **FR-023**: This feature MUST NOT introduce any new stored credential. Both credentials the maintenance run needs already exist in the continuous-integration secret store and are already consumed by existing jobs: the model credential (`ANTHROPIC_API_KEY`, used today by the end-to-end and dynamic-scanning jobs) and a write-scoped repository credential for opening a proposal (the `CD_PUSH_TOKEN` precedent). The maintenance run is a **new consumer of existing secrets**, not a new secret surface.
- **FR-023a**: If a narrower write credential is preferred over reusing the existing one — the existing token can push directly to the protected main branch, which opening a proposal does not require — the substitution MUST reduce privilege, never add a credential with equal or broader scope.
- **FR-024**: Both credentials MUST be consumed from the continuous-integration secret store. Neither MUST appear in version control, in command arguments, or in any log or published evidence.
- **FR-025**: The model credential and the write credential MUST remain distinct; the run MUST NOT use one in place of the other.
- **FR-026**: Existing always-on gates MUST remain keyless and fail-closed. This feature MUST NOT introduce a credential requirement into any gate that runs on every change.

#### Regeneration policy

- **FR-026a**: The repository MUST declare, in one version-controlled place, a regeneration policy for every documentation path. This replaces feature 043's location-based rule — that everything under the bundle may be regenerated and everything under the documentation tree is human-owned — which ceases to hold the moment instruction content is relocated into the bundle.
- **FR-026b**: The policy MUST distinguish at least three states:
  - **regenerate** — may be rewritten as the repository changes.
  - **event-driven** — never rewritten as a side effect of repository change. Written only when a specific event calls for it, and that includes **creating a new document** as well as amending an existing one: a decision reached produces a **new** decision record, and a decision superseded amends the record it supersedes. A path in this state is never left untouched merely because nothing existing became wrong.
  - **excluded** — never analyzed and never written.
- **FR-026c**: The policy MUST state, for each path, **which actor** it governs. The generator's write scope is limited to the bundle and to its own managed regions in the assistant configuration files; every other *regenerate* assignment governs an agent working under human review, not the generator.
- **FR-026d**: The declared assignments MUST be:

  | Path | Policy | Rationale |
  |---|---|---|
  | `docs/runbooks/**` | regenerate | Operational truth tracks the repository and goes wrong as it changes |
  | `docs/MCM-Architecture.md` | regenerate | Same |
  | `CLAUDE.md` and the sibling assistant configuration files | regenerate | Same; it is also this feature's relocation source |
  | `openwiki/**` concepts that cite an upstream source | regenerate | Derived summaries of a canonical document; freely refreshed from it |
  | `openwiki/**` concepts that are authoritative (no upstream source) | event-driven, and protected | Canonical in their own right — this is where relocated instruction-file content lands. Written when their subject changes; load-bearing passages are fingerprinted (FR-041) so a refresh cannot paraphrase them away |
  | `docs/decisions/**` | event-driven | A decision reached creates a record; a decision superseded amends one. Never rewritten because surrounding code changed |
  | `docs/templates/**` | event-driven | Changed deliberately when a template needs to change, never as a side effect of repository change |
  | The load-bearing protection manifest | never written | Holds the marks and fingerprints for protected passages (FR-029b). Outside the generator's write scope by design — the process it constrains must not be able to remove it |
  | `openwiki/INSTRUCTIONS.md` | never written | The generation brief — the hand-authored scope, exclusion and redaction rules the generator reads but never rewrites. It is the sole remediation surface when a gate rejects generated content |
  | `docs/proposals/**` | excluded | Pre-specification ideation, superseded once a specification exists |
  | `docs/test-data/**` | excluded | A binary unit-test fixture, not documentation — nothing to summarize |
  | `specs/**` | analyzable, not a coverage target | Historical records superseded by the code; enumerating them fills retrieval with dead work-units. `HANDOFF.md` files are the exception — they carry live measured knowledge |

- **FR-026e**: A generation or maintenance run MUST NOT write to a path whose declared policy forbids it, and that constraint MUST be checked automatically rather than trusted.
- **FR-026f**: A maintenance run MUST surface an *event-driven* path whose triggering event has occurred without the corresponding document existing — most importantly, a decision reached in merged work with no decision record for it. Surfacing it MAY be a proposal to create the record, but MUST NOT be silence.
- **FR-026g**: The excluded and non-coverage assignments above MUST be stated explicitly in the generation brief rather than left to be inferred from a general binary-asset or unlisted-path rule.

#### Content relocation

- **FR-027**: The primary instruction file MUST be reduced to a thin index: its content relocated into the knowledge bundle, and each relocated passage replaced in place by a link to its destination.
- **FR-027aa**: The relocation MUST be performed through the same slice planning and result-verification path defined by FR-001–FR-008, invoked manually rather than by the merge trigger. It MUST NOT be carried out by an ad-hoc process that bypasses slice bounding or result verification.
- **FR-027ab**: The relocation's run record MUST serve as the acceptance evidence for User Story 1 — a real workload of the size that defeated the generator in feature 043, rather than a synthetic exercise.
- **FR-027a**: The resulting index MUST allow an assistant reading only the index to determine which concept holds a given subject, so that retrieval is directed rather than exploratory.
- **FR-028**: Relocated content MUST NOT be lost, abridged, or altered in meaning by the move. Every fact present before the relocation MUST be present after it.
- **FR-029**: Each relocated passage MUST be fingerprinted at relocation time, and the fingerprint MUST be asserted on every change, so that a later regeneration which rewrites, reorders, or paraphrases a relocated passage fails a gate rather than depending on a reviewer noticing.
- **FR-029b**: Marks and fingerprints MUST live in a single version-controlled **sidecar manifest**, not inside the concepts they protect. The manifest MUST be outside the generator's write scope, so that protection cannot be removed by the process it constrains, and its removal is a reviewable diff rather than an absence.
- **FR-029c**: The manifest MUST be the authority. A passage listed in the manifest that no longer appears in its concept MUST fail — a protected passage cannot be silently deleted, only deliberately delisted.
- **FR-029d**: Changing a protected passage legitimately MUST be possible by updating the manifest in the same change. Without this the gate becomes a permanent blocker on correcting the very content it protects.
- **FR-029e**: Because a concept does not itself disclose that a passage is protected, a failure MUST identify the concept, the passage, and what changed, precisely enough to be actionable by someone who did not know the protection existed.
- **FR-029a**: The fingerprint check MUST run offline, without credentials, and on every change — it is a protection against silent regression and cannot depend on the paid maintenance run.
- **FR-030**: The bundle's structural rules MUST accommodate a concept that is itself authoritative — one with no upstream document to cite — without weakening the requirement that every summarizing concept cites a source that resolves.
- **FR-030a**: The agent-layer document MUST be relocated into the runbooks directory, with every inbound reference updated in lockstep and no content change.
- **FR-031**: Links left behind in the instruction file MUST resolve to existing bundle content, and that resolution MUST be checked automatically on every change so a rename or removal cannot rot the link silently.
- **FR-032**: Machine-managed regions of the instruction file maintained by other tooling MUST NOT be altered by the relocation.
- **FR-033**: All assistant-facing configuration surfaces in the repository MUST remain mutually consistent after relocation; none may be left describing or pointing at content that has moved.
- **FR-034**: The relocation MUST be recorded as committed evidence in this feature's folder, containing the before and after measurement of the instruction file and the retrieval verification, so that the outcome remains verifiable after the change is merged.
- **FR-035**: The relocation MUST be reversible by a single revert of its change, with no dependency on a regeneration run to restore the prior state.

#### Staleness reporting

- **FR-036**: The existing per-concept drift warning MUST remain report-only and MUST NOT gain the ability to fail a change or to trigger a paid run. Its known false-positive behaviour — warnings that never clear, and warnings that fan out from a single edit to a widely-cited file — is why change-triggered regeneration, not per-concept staleness, is the mechanism this feature relies on.

#### Recording new knowledge after the trim

Today an assistant that learns something durable writes it into the primary instruction file. Once
that file is an index, that habit has to land somewhere else, and this section says where.

**These requirements are orthogonal to the regeneration policy above.** The policy states govern
*when* a path may be written; the rule below governs *where* a given learning goes. A path can be
`regenerate` and still be the correct destination for hand-written knowledge.

- **FR-037**: The destination for a durable learning MUST be the **canonical home of its subject**, determined mechanically from the bundle: if the concept covering that subject cites an upstream source, that source is canonical and the learning MUST be written there; if the concept is authoritative — no upstream source, per FR-030 — the concept itself is canonical and the learning MUST be written into it.
- **FR-037a**: Consequently, a learning about an operational procedure MUST be written into the runbook, not into the concept that summarizes it, and the summary MUST be left to refresh from it. A concept that becomes a copy of its source has failed the generation brief, and hand-writing into derived summaries is how that failure starts.
- **FR-037b**: Content relocated out of the instruction file has no upstream source, so its concepts are authoritative and learnings about those subjects MUST be written into the concept. This is the **only** destination this feature changes; every other subject keeps the canonical home it has today.
- **FR-037c**: An assistant MUST NOT write prose back into the instruction file and rely on a later maintenance run to relocate it.
- **FR-038**: Recording a learning about a subject the bundle does not yet cover MUST mean adding a concept — and, where the subject has a canonical document, writing the detail there and citing it — never appending prose to the index.
- **FR-039**: The instruction file's index entries MUST be derivable from the bundle itself, so the index cannot drift from what the bundle actually holds, and an entry pointing at a concept that does not exist MUST fail a check.
- **FR-040**: A check MUST fail if the instruction file accumulates content beyond its index and its machine-managed regions. Without this, the file silently re-grows and the trim is undone within weeks.
- **FR-041**: The load-bearing-passage protection MUST generalize beyond relocation: **any** passage marked load-bearing by its author is fingerprinted and asserted on every change, whether it arrived by relocation during this feature or was written into an authoritative concept later. Relocation is the first population of that set, not a closed one.
- **FR-041a**: A concept that cites an upstream source MUST NOT carry fingerprinted passages. Protecting a derived summary from refresh would freeze it against the document it summarizes — the drift the bundle exists to avoid. Protection belongs to authoritative content only.
- **FR-042**: The rejected alternative MUST be recorded: writing learnings to the instruction file and having maintenance relocate them afterwards would require an automated run to rewrite instruction-file content — the generator scope expansion excluded by FR-026c — and would reintroduce the growth-then-trim cycle this feature exists to end.

### Key Entities

- **Slice**: A bounded generation request naming a single bundle area and a specific, limited set of pages. Carries the requested page list, its target area, and whether that area already exists.
- **Maintenance plan**: The ordered set of slices produced by decomposition, together with the reason each slice was included. Produced without cost; reviewable before generation.
- **Run record**: The durable marker of the last maintenance run — what repository state it covered, what it produced, and what remains outstanding. Distinguishes "covered and found nothing" from "never covered".
- **Outstanding backlog**: Slices that were planned but not completed, carried forward to subsequent runs.
- **Maintenance proposal**: The reviewable change an automated run produces, subject to the repository's normal gates and to human approval.
- **Relocated passage**: A passage of content moved out of the instruction file, identified by its original location, its destination, the link left in its place, and the fingerprint that proves it has not been reworded since.
- **Regeneration policy**: The declared, per-path statement of whether a path may be rewritten as the repository changes, changed only on a specific event, or never touched — and which actor each assignment governs.
- **Protection manifest**: The version-controlled sidecar mapping each protected passage to its concept and its fingerprint. Lives outside the generator's write scope, is the authority on what is protected, and is the one place a protection is deliberately added or removed.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: Across a set of at least five maintenance runs covering both new and existing bundle areas, no run reports success while having produced no pages. Every run's reported outcome matches what it actually produced.
- **SC-002**: A generation request larger than a single invocation can complete is decomposed into slices, and 100% of the requested content is eventually produced across successive runs without a human re-planning the work by hand.
- **SC-002a**: The instruction-file relocation is delivered entirely through the slice path, with every slice's result verified and no slice reporting success without producing pages — the workload that failed eight consecutive times in feature 043 now completing under the machinery.
- **SC-003**: A deliberately sabotaged run — one that produces nothing — is reported as a failure, and the affected work remains recorded as outstanding.
- **SC-004**: A maintenance run against an unchanged repository completes without invoking a paid model, and two such consecutive runs both take the cheap path — demonstrating the run marker advances correctly.
- **SC-005**: Following a merge that changes a documented subsystem, the triggered maintenance run produces a proposal covering that change, and that proposal reaches a human for review without being merged automatically.
- **SC-005a**: Merging a maintenance proposal produces no further maintenance run, verified across at least two consecutive proposal merges.
- **SC-005b**: Across at least three merges landing while a proposal is open, exactly one proposal exists throughout, it remains mergeable against the main branch, and a human commit placed on it survives every subsequent update.
- **SC-005c**: Closing a proposal without merging returns its work to outstanding, and the next run re-proposes it.
- **SC-006**: No maintenance run's spend exceeds the declared per-run ceiling plus at most one slice's overshoot, measured across every run in the validation period, and work stopped at the ceiling appears in the next run's plan.
- **SC-006a**: A run whose spend cannot be measured fails rather than proceeding, verified by simulating an unavailable spend figure.
- **SC-007**: A maintenance failure is fully diagnosable through the repository's self-serve diagnostics path, with no step requiring direct access to the runner host.
- **SC-008**: No maintenance run blocks an unrelated change from merging, measured across the feature's validation period.
- **SC-008a**: A burst of at least three merges inside the debounce window produces exactly one maintenance run covering all of them.
- **SC-008b**: A merge stream that never yields a quiet period still triggers a run at the maximum deferral, and merges landing during a run are covered by the next one rather than skipped.
- **SC-009**: The primary instruction file is measurably smaller after relocation than before, with both measurements recorded as committed evidence.
- **SC-010**: For each of at least eight repository questions that the instruction file answered before relocation, the question remains answerable from the trimmed instruction file plus the bundle, opening no more than two bundle files. Each question and its resolution path is recorded as committed evidence.
- **SC-011**: 100% of relocated passages are verifiably present at their destinations, and 100% of the links left in their place resolve to existing bundle content — checked automatically rather than by inspection.
- **SC-012**: A deliberately reworded relocated passage is detected and fails a check that runs on every change, without a credential and without a model — demonstrating that silent paraphrase is mechanically prevented rather than left to review.
- **SC-015**: Every documentation path in the repository carries a declared regeneration policy, and an attempt to write to a path whose policy forbids it is rejected by an automated check.
- **SC-017**: A learning recorded after the trim lands in the canonical home of its subject — the upstream document where one exists, the concept where the concept is authoritative — and an attempt to record it as prose in the instruction file instead is rejected by a check that runs on every change.
- **SC-017a**: For a sample of at least six subjects spanning runbooks, decision records, the architecture document, and relocated instruction-file content, the destination rule yields exactly one correct answer per subject with no judgement call required.
- **SC-018**: A passage marked load-bearing after the trim — not during relocation — is protected by the same fingerprint check, demonstrating the protected set is open rather than closed at relocation time.
- **SC-018a**: A generation run cannot remove a passage's protection: with the manifest outside its write scope, a refresh that rewords a protected passage fails, and a refresh cannot delist it.
- **SC-018b**: A protected passage is corrected deliberately by updating the manifest in the same change, and that change passes — demonstrating the protection is a gate, not a freeze.
- **SC-018c**: Deleting a protected passage outright fails the check as a removal rather than passing for lack of text to compare.
- **SC-019**: Merged work that reaches a decision with no corresponding decision record is surfaced by the maintenance run rather than passing silently.
- **SC-020**: This feature adds zero new entries to the continuous-integration secret store, verified against the store's contents before and after.
- **SC-016**: An assistant given only the trimmed instruction file can name the concept holding each of at least eight subjects without opening the bundle, demonstrating the index directs retrieval rather than requiring exploration.
- **SC-013**: No credential introduced by this feature appears in version control, in command arguments, or in any published log or evidence artifact — verified by the repository's existing whole-tree credential scan.
- **SC-014**: Every gate that runs on every change remains keyless and fail-closed after this feature ships.

## Assumptions

- **Reliable slice size is taken from measurement, not estimation.** Feature 043 recorded six to eight pages per invocation as reliably deliverable, and recorded that size alone did not predict failure — the single slice that produced nothing was the only one that mixed extending an existing area with creating a new one. The decomposition rules follow that evidence.
- **Scheduled regeneration is the staleness mechanism, and per-concept drift is not.** This is a settled decision carried forward from feature 043, which implemented the per-concept alternative, measured it, and reverted it. Reopening it is a spec amendment, not an implementation choice.
- **The proposal is reviewed by a human and never auto-merged.** Generated documentation changes carry real risk of leaking topology or credential-shaped strings scraped from operator documentation; human review is the control.
- **The generation brief is the only remediation surface.** It is hand-authored and never rewritten by the generator. Every rejection — conformance, credential, or topology — is fixed there and regenerated, never exempted.
- **Existing always-on gates stay keyless.** The credentials the maintenance run consumes are used by that job only. No gate that runs on every change gains a credential requirement — and this feature adds no credential to the store in any case.
- **Failure evidence follows the repository's established self-serve diagnostics pattern**, so an assistant can diagnose a failed run without out-of-band runner access.
- **The automated run is not a required approval for merging.** It is paid and occasionally slow; making it a merge requirement would couple unrelated changes to model availability and cost.
- **Relocation is reversible.** It is a single revert away, and it does not depend on a regeneration run to undo. That, plus the fingerprint check, is what makes a full trim acceptable where feature 043 required a measured tranche.
- **Retrieval evidence is recorded as a committed document in this feature's folder**, following the precedent set by features 041 and 043, because it is human judgement that a machine cannot re-check later.
- **The generator's write scope is unchanged.** It writes the bundle and its own managed regions in the assistant configuration files, and nothing else. Every other *regenerate* assignment in the policy governs an agent working under human review. Runbooks are therefore never rewritten by an unsupervised model, which is what makes the *regenerate* assignment on them safe.
- **The regeneration policy is governance plus enforcement, not a new capability.** It records what may be rewritten and by whom, and is checked automatically. It does not grant the generator access to any path it cannot already write.
- **Costs of merge-triggered maintenance are accepted.** Runs contend with the capacity-constrained runner and spend scales with merge rate. Spend is bounded by the per-run ceiling (FR-011) and by quiet-branch debouncing collapsing bursts into one run; contention is bounded separately by the run sitting off the merge-gating path (FR-011c), since a spend ceiling does not limit runner occupancy.

## Dependencies

- **Feature 043 (merged)**: the knowledge bundle, the hand-authored generation brief, the sanctioned generation invocation path, and the fail-closed conformance gate. This feature extends all four.
- **Feature 042**: the self-serve failure-diagnostics path and the requirement that every automated job publish machine-readable failure evidence.
- **The self-hosted continuous-integration platform and its secret store**, which already holds both credentials the maintenance run consumes — the model credential used today by the end-to-end and dynamic-scanning jobs, and the write-scoped repository credential used today to push to the protected main branch. Neither is new (FR-023).
- **The capacity-constrained build runner**, shared with the change-triggered validation pipeline, which constrains when maintenance may run.

## Out of Scope

- **Migrating the canonical documentation tree into the bundle.** Runbooks, decision records and architecture documents remain authoritative where they are. This feature relocates content from the always-loaded instruction file only. The one move it does make — the agent-layer document into the runbooks directory — is a relocation *within* the documentation tree, not into the bundle, and carries no content change.
- **Expanding the generator's write scope beyond the bundle.** Allowing an automated run to rewrite runbook bodies, architecture documents, or the instruction file's content would place precision operator procedures under unsupervised model rewrite. The regeneration policy declared here is the prerequisite for ever considering that; it is not that.
- **Adding structured metadata to canonical documentation in place.** Considered in the originating proposal as a separate pilot; it would create a second knowledge surface to review inside this feature.
- **A periodic sweep.** Maintenance is merge-triggered only. A safety-net cadence can be added later if merge-triggered runs prove to miss drift.
- **Relocating the test-data fixture.** It stays where it is; only its exclusion from the bundle is made explicit.
- **Making per-concept drift a blocking condition or a generation trigger.** Settled and reverted in feature 043; FR-036 keeps it report-only.
- **Auto-merging maintenance proposals.** Explicitly excluded; human review is the control on generated content.
- **Making the maintenance run a required approval for merging.** It is paid; coupling merges to it would gate unrelated work on model availability.
- **Changing the pinned generation model or the generator itself.** Feature 043 measured that the binding constraint is request scope, not model capability.
