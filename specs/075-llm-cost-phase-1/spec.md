# Feature Specification: LLM cost reduction, phase 1 — no new vendor

**Feature Branch**: `075-llm-cost-phase-1`

**Created**: 2026-09-20

**Status**: Draft

**Input**: Phase 1 of [docs/proposals/MCM-LLM-Cost-Analysis-1.md](../../docs/proposals/MCM-LLM-Cost-Analysis-1.md) — halve the organisation's measured model spend without adding a vendor, and make the saving a property the repository defends rather than one an operator once observed on a dashboard.

## Context — the measured baseline

Thirty days of console data (22 Aug – 20 Sep 2026) put total spend at **$74.89** across five keys, none of it on the escalation tier:

| Surface | 30-day cost | Shape |
|---|---|---|
| OpenWiki knowledge-bundle generator | $39.61 (53%) | Agentic loop, already 92% cache reads — near the ceiling of what caching can do |
| Movie-assistant gateway in CI (`app-e2e`) | $26.02 (35%) | $22.24 of it is the ~2,650-token supervisor classifier prompt, sent **uncached** on every call |
| Golden-live deploy gate | $5.62 (8%) | 67 runs, $0.084 per deploy — already proportionate |
| Dev-container local runs | $3.51 (5%) | Same uncached shape as CI |
| Production assistant (owner's own BYOK key) | $0.13 (<1%) | ≈$0.003 per turn, almost all of it the supervisor classify |

Three facts decide this feature, and all three were verified against the vendor reference and the repository rather than taken from the proposal:

1. **The current supervisor model cannot cache its own prompt.** The classifier prompt is ~2,650 tokens; the fast-tier model's minimum cacheable prefix is 4,096 tokens. Marking it cacheable today is a silent no-op — no error, no warning, just full price on ~29M input tokens a month.
2. **A model one tier up has a 1,024-token minimum and costs less per cached read than the fast tier costs per uncached read.** In a CI burst, where calls arrive back-to-back and hit rates should exceed 95%, the more capable model is roughly 5× cheaper per classification *and* a better classifier. Break-even against the uncached fast tier is a ≈65% hit rate.
3. **Real production turns are minutes or days apart and will never reach that break-even.** A lone cached-tier call pays the cache *write* and costs ≈2× the uncached fast tier. Production must therefore keep the fast tier as its default; only the burst surfaces (CI, the deploy gate, local runs) take the cached tier.

That asymmetry — the same change being right for CI and wrong for production — is the central constraint of this feature, and the reason the choice is expressed as environment configuration rather than as a single global default.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - The knowledge-bundle generator runs on the cheaper model (Priority: P1)

The OpenWiki generator is the single largest line on the bill and is about to get larger: a backlog of queued page regeneration (tracked as backlog items #525 and #526) will run at elevated volume until it clears. Moving it to the newer generation of the same model family is a straight one-third reduction on 53% of the bill, using the same vendor, the same credential, the same workflow and the same agentic middleware — the only thing that changes is which model id the generator is pointed at.

**Why this priority**: Largest single saving, lowest risk, and time-sensitive — every regeneration run that happens before this lands is billed at the old rate. It touches no application code and has no interaction with the other two stories, so it can ship on its own and be judged on its own.

**Independent Test**: Point the generator at the newer model, run the existing offline generator guard (which is keyless, free and makes no model call), then let one real merge-triggered maintenance run complete and confirm it produced pages and passed the bundle's own conformance and governance gates, exactly as before.

**Acceptance Scenarios**:

1. **Given** the generator target is pinned to the newer model, **When** the offline generator guard runs, **Then** it passes — the explicit per-turn output cap is still set, still at or above the page-writing minimum, and the newer model id is still matched by the generator's own cap resolver, so the model never falls back to the truncating default that once produced a ~50% zero-page rate.
2. **Given** the change is merged, **When** the next merge-triggered maintenance run executes, **Then** it lands pages in the working tree and opens its usual proposal pull request, and the run record shows no increase in zero-page attempts or verification retries relative to the committed history on the previous model.
3. **Given** the generator's recorded reason for pinning an explicit output cap, **When** the model id changes, **Then** that reason travels with the value unchanged — the cap is not "tidied" back to an inherited vendor default as part of the bump.

---

### User Story 2 - The burst surfaces stop paying full price for a prompt that never changes (Priority: P2)

The classifier prompt is static: the same ~2,650 tokens of intent taxonomy on every single call, with only a one-line user message differing. In continuous-integration runs, hundreds of these arrive back-to-back. Today every one of them is billed in full, because the model in use cannot cache a prompt that short. Restructuring the request so the unchanging part is a distinct, explicitly cacheable block — and pointing the burst surfaces at a model whose minimum prefix the prompt actually clears — turns the dominant line item on the gateway's bill into a cache read.

A saving that depends on byte-for-byte prefix stability degrades silently: one interpolated value, one reordered rule, and the cache read rate drops to zero with no error raised and no test failing. This story is therefore not complete when the request is restructured; it is complete when the repository can *detect* that caching has stopped working.

**Why this priority**: Largest gateway saving — roughly $30 of monthly spend becomes $8–11. Depends on no other story, but carries the real risk in this feature (a prompt restructure invalidates every recorded model interaction) so it follows the risk-free one.

**Independent Test**: Drive two classifications in succession against the real provider with the cached-tier model selected, and assert that the second reports a non-zero count of tokens served from cache. Run the recorded-interaction suite in replay to confirm classification behaviour is unchanged, and the full end-to-end suite to confirm the assistant still routes every intent correctly.

**Acceptance Scenarios**:

1. **Given** the burst surfaces select the cached-tier supervisor model, **When** two classifications run in succession against the real provider, **Then** the second reports tokens served from cache greater than zero.
2. **Given** that assertion is running as the pre-deploy live gate, **When** no model credential is available, **Then** it **fails** rather than skipping — a skipped check reports exit zero and would certify a saving that was never measured.
3. **Given** production selects the fast-tier supervisor model, **When** a classification runs, **Then** the explicitly cacheable marking is simply ignored (the prompt is below that model's minimum prefix) and the call behaves and is billed exactly as it does today — the restructure must be inert where it cannot help.
4. **Given** the prompt is restructured, **When** the recorded-interaction suite runs in replay, **Then** every intent still classifies to the same label it did before, with no recorded interaction silently treated as a capacity failure or otherwise downgraded to a skip.

4a. **Given** the keyless merge gate runs with no provider selected — which resolves to the **self-hosted** provider — **When** the restructured prompt replays there, **Then** the same in-domain and out-of-domain assertions still hold, proving the single message shape works on the default provider and not only on the hosted one.

4b. **Given** the self-hosted recorded interactions have not been re-recorded, **When** the keyless merge gate runs, **Then** it **fails** naming the missing recording as drift — it MUST NOT skip, so the self-hosted path cannot break silently.
5. **Given** someone later edits the static portion of the prompt in a way that breaks prefix stability, **When** the cache assertion runs, **Then** it fails and names prefix drift as the cause, rather than passing quietly at full price.

---

### User Story 3 - Every assistant user's extraction calls cost a third of what they did (Priority: P3)

Beyond classification, the assistant makes at most one further model call per turn: a short extraction that turns a sentence into a small structured object. These prompts are 120–520 tokens and return a handful of fields. They are far too short to cache under any model, so the only lever is per-token price — and they are currently served by a model three times more expensive than the fast tier, for work the fast tier handles.

Because production deliberately pins no model ids and lets the code defaults rule, changing the default is the one change in this feature that reaches end users automatically with the next image. Users bring their own credential and spend against their own ceiling, so a cheaper extractor directly buys them more turns before the assistant stops answering.

**Why this priority**: Smallest organisational saving of the three, but the only one that reduces what a real member pays per turn. Independent of the other two; ships with the next gateway image.

**Independent Test**: Run the recorded-interaction suite in record mode against the fast tier, then in replay, and confirm every extraction still produces the expected structured result — particularly the cases the proposal flags as near-misses in the intent taxonomy.

**Acceptance Scenarios**:

1. **Given** the specialist default is the fast tier, **When** the recorded-interaction suite runs, **Then** every extraction pair still yields its expected structured output.
2. **Given** a user has supplied only their own credential, **When** a turn runs, **Then** it uses that credential alone and never falls back to a shared organisational one — the existing per-user credential rule is unchanged by this feature.
3. **Given** a user's configuration selects a different provider entirely, **When** the turn runs, **Then** no model id from this feature leaks into that provider's request, and the escalation tier remains pinned to its current vendor and remains disabled by default.

---

### Edge Cases

- **The saving evaporates silently.** Caching is a prefix match: any byte change anywhere before the cache marker invalidates everything after it. The failure mode is not an exception — it is a zero in a usage field nobody reads. This is the specific reason User Story 2 requires an assertion rather than an operator observation.
- **A skipped check reads as a pass.** Every credential-driven skip in the model-facing suites was written for a credential-less developer checkout, where skipping clean is correct. At the deploy boundary the same skip means the gate verified nothing and still reported success. The new assertion must inherit the existing escalation rule, not invent a second one.
- **Every recorded model interaction is invalidated twice over.** Recorded interactions are keyed by model id *and* by the serialized prompt. This feature changes both — the specialist model id and the supervisor prompt structure — so a full re-record against a live credential is mandatory, not incidental, and it costs real money.
- **A re-record failure can masquerade as provider capacity.** The suite converts overload signals into skips by inspecting error text. A drift signal from a stale recording must never be downgraded that way, or a genuinely changed prompt reports green.
- **A model can be current, correctly named, and still reject what we send it.** The measured blocker: the model this feature moves classification to returns a client error on every call because of a sampling parameter the code sends unconditionally. Every existing gate was green and truthful — each was asserting something narrower than "this model actually answers". The same gap already leaves the escalation tier broken on the default branch, unnoticed because it is dormant.
- **The cheaper extractor could be a quality regression.** Moving extraction down a tier trades capability for price. The recorded-interaction pairs — especially the documented near-miss boundaries in the intent taxonomy — are the gate that decides whether that trade is acceptable, and a failure there blocks the change rather than being waived.
- **The cacheable marking must be harmless where it cannot apply.** Production stays on a model whose minimum prefix this prompt does not clear. The marking must be ignored there, not rejected, and must not alter what production is billed.
- **A dependency upgrade could break the self-hosted provider silently.** The single-shape design depends on that provider's adapter *tolerating* an unknown key on a text block. It does today. If a future version of that adapter tightens its validation to reject unknown keys, the default provider breaks — and recorded-interaction replay would not notice, because replay substitutes the model and never constructs the adapter at all. This is the gap FR-025 exists to close, and it is a supply-chain failure mode rather than an authoring one: nobody would be editing this feature when it lands.
- **A vendor table is not a guarantee.** The generator's per-turn output cap is set explicitly precisely because an inherited vendor default once silently truncated every turn and produced no pages while reporting success. A model bump must not become the edit that reintroduces that dependency.

## Requirements *(mandatory)*

### Functional Requirements

**Generator (User Story 1)**

- **FR-001**: The knowledge-bundle generator MUST be pinned to the newer generation of its current model family.
- **FR-002**: The generator's explicit per-turn output cap MUST remain set, MUST remain at or above the page-writing minimum, and MUST NOT be replaced by an inherited vendor default as part of this change.
- **FR-003**: The recorded rationale for pinning that cap explicitly MUST survive the model bump intact.
- **FR-004**: The generator's offline guard MUST pass without modification, and MUST NOT be relaxed to accommodate the new model id. If it fails, the model id is wrong, not the guard.

**Supervisor caching (User Story 2)**

- **FR-005**: The classification request MUST be split into an unchanging portion, marked as explicitly cacheable, and a separate short portion carrying the user's message.
- **FR-006**: The unchanging portion MUST be byte-for-byte identical across calls — it MUST NOT interpolate any per-call value.
- **FR-007**: The burst surfaces — continuous integration's end-to-end job and local developer runs — MUST select the cached-tier supervisor through environment configuration. The pre-deploy gate MUST NOT; it keeps the code defaults so it certifies what production runs.
- **FR-007a**: Any such pin MUST be **provider-scoped** — it MUST take effect only when the hosted provider is active, and MUST be inert on the self-hosted provider. A pin that follows whichever provider happens to be active is prohibited, because the end-to-end job accepts a provider input and genuinely runs both ways; a hosted model id reaching the self-hosted provider is a broken run.
- **FR-007b**: Model selection MUST resolve a provider-scoped override ahead of an unscoped one, so this rule holds wherever selection happens rather than only inside the one script that currently implements it by convention.
- **FR-008**: Production MUST continue to select the fast-tier supervisor model, and this MUST remain a code default rather than a deployment setting, so that it holds wherever no override is present.
- **FR-009**: The system MUST provide an automated check asserting that a repeated classification is served from cache.
- **FR-010**: That check MUST fail, not skip, when it is running as the pre-deploy gate and cannot obtain a credential.
- **FR-011**: That check MUST distinguish "caching is not working" from "the provider was unavailable", and MUST NOT report the former as the latter.
- **FR-012**: The cacheable marking MUST be inert on any model whose minimum cacheable prefix the unchanging portion does not clear — it MUST NOT cause an error or change billing on such a model.

**Extraction (User Story 3)**

- **FR-013**: The extraction specialist default MUST be the fast tier.
- **FR-014**: The escalation tier MUST remain pinned to its current vendor and MUST remain disabled by default; this feature MUST NOT route to it.

**Model parameters must match what the model accepts**

- **FR-026**: The system MUST NOT send a sampling parameter to a model that rejects it. Newer models reject the fixed sampling setting this code currently sends unconditionally, returning a client error on every call — so the supervisor change is unshippable without this, and the escalation tier is already non-functional because of it.
- **FR-026a**: When it is unknown whether a model accepts that parameter, the system MUST omit it. Omitting it never fails; sending it can. A default in the other direction reintroduces this defect with the next model generation.
- **FR-027**: The escalation tier MUST be moved to the current generation of its frontier model. The id pinned today is superseded *and* is one of the models that rejects the parameter, so the escape hatch would fail on first use; leaving it would knowingly ship a broken fallback while editing the very line that defines it.
- **FR-028**: The system MUST carry an automated check that every model the selection logic can resolve is actually invocable with the parameters the system sends — one minimal call per model id, asserting no client error. Nothing today asserts this: the generator guard checks only an output cap, the selection tests never call a provider, and the recorded-interaction suite replays fixtures instead of constructing a real model. This check MUST be gated so that it fails rather than skips where a skip would certify nothing.
- **FR-015**: The existing rule that a per-user run uses only that user's credential, with no shared fallback, MUST be preserved unchanged.
- **FR-016**: A per-user run that selects a different provider MUST NOT inherit any model id introduced by this feature.

**Both providers keep working (cross-cutting)**

- **FR-021**: The assistant MUST continue to work on **both** supported providers — the self-hosted local provider (the default) and the hosted one. No change in this feature may make either unusable, and no change may introduce a provider-conditional branch in the classification path unless the self-hosted provider is measured to regress without one.
- **FR-022**: The restructured classification request MUST be accepted by both providers using **one** message shape. On the self-hosted provider the cache marking MUST be ignored without error; on the hosted provider it MUST be honoured where the model's minimum prefix allows.
- **FR-023**: The recorded interactions for the self-hosted provider MUST be re-recorded alongside the hosted ones, and the keyless merge gate — which resolves to the self-hosted tier because it sets no provider — MUST pass in replay afterwards.
- **FR-024**: A re-record of the self-hosted tier requires a locally running model rather than a hosted credential; this MUST be tracked as its own task with its own prerequisite, not folded into the hosted re-record.
- **FR-025**: The system MUST carry an automated check, runnable with no model server and no credential, asserting that the self-hosted provider's message adapter accepts the restructured request — dropping the cache marking without error and preserving the instruction text intact. Recorded-interaction replay does NOT exercise that adapter, so without this check the property the single-shape design rests on is asserted nowhere that runs automatically, and a dependency upgrade could remove it silently.

**Cross-cutting**

- **FR-017**: All recorded model interactions MUST be re-recorded against the live provider, and the recorded-interaction suite MUST pass in replay afterwards.
- **FR-018**: The keyless replay gate MUST remain green, and MUST remain keyless.
- **FR-019**: Documentation that states which model each environment uses MUST be updated to match, including the canonical statement of model-provider scoping, the agent-layer runbook, and the production deployment file's explanatory header. Specifically, the canonical page MUST (a) keep its statement that dev and test default to the self-hosted provider **unchanged**, (b) correct the balanced-tier model id it names for the golden surface and production, (c) gain the burst-surface category it does not yet describe, and (d) keep its escalation rule unchanged. Because that page is canonical, the learning is written **into** it rather than into a source it cites.
- **FR-019a**: The self-hosted provider MUST remain the default for dev and test after this feature. No change may alter which provider is selected when none is specified.
- **FR-020**: The generator change MUST be mergeable independently of the gateway changes, so that a failure in either is unambiguous as to its cause.

### Key Entities

- **Model tier selection**: the mapping from a graph role (classify, extract, escalate) and an environment to a model id. Already expressed as a pure, testable function over environment values with per-role overrides; this feature changes two defaults and adds environment overrides on three surfaces, not the mechanism.
- **Recorded model interaction**: a stored provider response keyed by model id plus serialized prompt, replayed to make model-dependent tests deterministic and keyless. Invalidated by any change to either key component.
- **Cache effectiveness signal**: the provider-reported count of input tokens served from cache on a response. Currently produced on every call and read by nothing; this feature makes it an asserted property.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: Measured 30-day spend falls from $74.89 to $37–40 — a reduction of approximately 48% — at unchanged workload volumes.
- **SC-002**: Knowledge-bundle generation cost per run-day falls by approximately one third, from ≈$1.72 to ≈$1.15, with no increase in runs that produce no pages.
- **SC-003**: The share of classification input tokens served from cache on the continuous-integration surface exceeds 95%, measured from the provider's own usage reporting, where today it is 0%.
- **SC-004**: Cost per assistant turn for a user on their own credential falls from ≈$0.005 to ≈$0.0035 — a reduction of approximately 30% — with no change required by the user.
- **SC-005**: Every intent classification and extraction that produced a correct result before this feature produces the same result after it; the recorded-interaction suite passes with zero regressions.
- **SC-006**: A deliberate change to the unchanging portion of the classification prompt causes an automated check to fail, and that failure names prefix instability as the cause rather than reporting a generic error.
- **SC-007**: The generator change and the gateway changes reach the default branch as separate merges, so that a failure in continuous integration identifies which of the two caused it without further investigation.
- **SC-008**: The assistant answers correctly on **both** providers after the change — the keyless merge gate (self-hosted tier) and the pre-deploy gate (hosted tier) both pass, from one shared message shape with no provider-conditional branch in the classification path.

## Assumptions

- **Model pricing and cacheable-prefix minimums are as verified on 2026-09-20** against the vendor's published reference: fast tier minimum 4,096 tokens; cached tier minimum 1,024 tokens; cached reads priced at one tenth of uncached input, cache writes at one and a quarter times. Should the vendor change these, the break-even that justifies the production/CI split changes with them.
- **The newer generator model is accepted by the existing offline guard without modification.** This was verified rather than assumed: the generator's own cap resolver matches the new id by pattern, and the underlying library's cap table carries an explicit entry for it at the required value. The proposal's warning that this guard might need relaxing is therefore not expected to apply, and FR-004 forbids relaxing it if it somehow does.
- **The override mechanism for pinning models per surface already exists** and is already used to prevent one provider's model ids reaching another. This feature uses it rather than introducing a parallel one.
- **Production deliberately pins no model ids**, so code defaults rule there. This is what carries the extraction saving to end users with the next image, and it is also why the supervisor choice must stay a code default rather than a deployment setting.
- **Re-recording model interactions spends real money** against the development credential and is a required, budgeted step — not an optional tidy-up.
- **Adding a second vendor is explicitly out of scope.** The proposal's later phases cover a cheaper generator provider and a third provider choice for end users; neither is part of this feature, and nothing here should foreclose them.
- **The deploy gate's per-run cost is already proportionate** at $0.084 and is not itself a target; it benefits from these changes incidentally.
- **Escalation remains dormant.** It has never been routed to and is disabled by default; this feature does not change that.
