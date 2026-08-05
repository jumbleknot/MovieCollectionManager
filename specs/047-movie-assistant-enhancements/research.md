# Phase 0 Research: Movie Assistant Enhancements & Fixes

**Feature**: [spec.md](./spec.md) · **Plan**: [plan.md](./plan.md) · **Date**: 2026-08-02

Five questions. **All the gating ones are now answered.** RQ-4 resolved by the product owner
(2026-08-02); **RQ-1 answered 2026-08-04** and **RQ-2 answered 2026-08-05**, both by measurement
rather than inference — the probes are in [evidence/](./evidence/) and are re-runnable. RQ-3 and
RQ-5 have working defaults recorded here and can be confirmed during implementation; note that
RQ-2's evidence makes RQ-3's `GraphState` decision load-bearing for FR-014a too.

---

## RQ-1 — What actually produces the generic reply for "navigate to &lt;collection name&gt;"? {#rq-1}

**Status**: **ANSWERED at the mechanism level, 2026-08-04.** On a turn that is genuinely classified
`navigate`, the generic reply has exactly ONE possible source — `_degrade_node` — and `_degrade_node`
is reachable only through **the supervisor's model call**. H1 is not an independent cause, H4 (the
specialist model) is eliminated for this path, and **the pagination defect does not produce this
symptom at all**. The one thing still open is *which* of the two surviving causes fired in the
member's deployed environment, and that needs one cheap signal from that environment (below) — not
another local reproduction. See [the evidence](#rq-1-evidence).

**Why it was open.** `"Sorry — I couldn't complete that just now. Please try again."` appears in
exactly four places, and **none of them is the navigator**:

| Site | Trigger |
|---|---|
| [graph.py:349](../../agents/movie-assistant/src/graph.py#L349) `_degrade_node` | `intent == "degraded"` — the classifier raised, or the error-rate circuit breaker is open |
| [curator.py:138](../../agents/movie-assistant/src/nodes/curator.py#L138) | entity extraction raised |
| [organizer.py:550](../../agents/movie-assistant/src/nodes/organizer.py#L550) | organize-plan extraction raised |
| [query.py:226](../../agents/movie-assistant/src/nodes/query.py#L226) | query extraction raised |

The navigator resolves targets in pure code with no model call, so it cannot emit this message. The
string does not exist anywhere in `frontend/` either, so it is not a client fallback.

**Candidate explanations, as originally stated:**

- **H1 — the circuit breaker is open.** `ErrorRateBreaker` trips at a 0.5 failure rate over a
  20-run window (min 5 samples) and stays open for 30 s
  ([circuit_breaker.py:59-68](../../agents/movie-assistant/src/circuit_breaker.py#L59-L68)). If
  large-library turns are failing often enough, *every* intent degrades for 30 s at a time and the
  member would read that as "navigate is broken". This is the explanation most consistent with
  "it used to work and stopped as the library grew".
- **H2 — misclassification.** The request is being routed to `query` (or another model-backed node)
  rather than `navigate`, and that node's extraction is failing.
- **H3 — classifier failure.** The supervisor's model call is raising for this input shape.
- **H4 — a model-provider error from a missing/misconfigured model** (added 2026-08-04 from the PR A
  reproduction, [HANDOFF-PR-B.md](./HANDOFF-PR-B.md)). An uninstalled Ollama model answers **404**;
  the calling node degrades and the member sees exactly this sentence with nothing naming the cause.
  Listed last but **checked first — it is by far the cheapest to eliminate**, and at the UI it is
  indistinguishable from the other three.

### Evidence — what the graph can and cannot do {#rq-1-evidence}

Established by driving the **compiled graph** (`build_graph(...)`, never a node directly — the whole
question is about routing and guards, and a node-level test bypasses every one of them). The probe is
[evidence/t001_probe.py](./evidence/t001_probe.py) — five experiments, 12 assertions, all green, no
stack required:

```bash
cd agents/movie-assistant && uv run --offline python \
  ../../specs/047-movie-assistant-enhancements/evidence/t001_probe.py
```

**1. A navigate turn makes exactly ONE model call, and it is the supervisor's.**
`navigate` → `navigator` → `END` ([graph.py](../../agents/movie-assistant/src/graph.py#L508-L540));
the navigator is pure code with no model. Instrumenting every model-backed node and running
`"navigate to my Huge Library collection"` through the graph records `['supervisor']` and nothing
else. **`SPECIALIST_MODEL` is not on this path** ⇒ **H4 is eliminated as a direct cause of the
navigate symptom**. It survives only as the second half of H2 — misclassify into
curator/organizer/query first, *then* 404 the specialist. (H4 remains live for **add**, where PR A
reproduced it, and for any deployed environment: see the per-user-config note below.)

**2. The navigator cannot emit the generic reply, and cannot raise.** Every read failure is
absorbed: `list_collections` returns `[]` on a failed read and `list_movies` **breaks out of the
pagination loop** with a partial list ([runtime_nodes.py:439-467](../../agents/movie-assistant/src/runtime_nodes.py#L439-L467)),
because a limiter breach comes back as `ok=False` rather than an exception
([mcp_tools.py:317-319](../../agents/movie-assistant/src/tools/mcp_tools.py#L317-L319)). Driving a
2,300-movie collection against the production 30-call/60 s limiter: **29 of 46 pages fetched, and
the turn still answers `Opening "Huge Library".` with a `navigate_to_collection` tool call.**

> **⇒ The pagination defect does NOT produce the reported symptom.** This is the trap the plan's
> hypothesis list would otherwise have walked into: the pagination fix is correct and necessary, and
> it will not remove the message the member reported.

**3. Therefore, on a genuinely-`navigate` turn, the source is `_degrade_node` — and only two things
reach it**, both of them the supervisor's model call: the classifier raised
([graph.py:277-283](../../agents/movie-assistant/src/graph.py#L277-L283) — `classify_intent` wraps
`model.invoke` in **no** try/except), or the breaker is already open.

**4. H1 is not an independent hypothesis — it is a 30-second amplifier of H3.** `circuit.record(...)`
is called in **exactly one place in the whole codebase**: the supervisor, on the classifier's
outcome. A node-level failure records nothing. Verified both directions: six consecutive classifier
raises open the breaker, after which a **healthy** classifier still degrades for the cooldown; and
**twenty consecutive turns where the specialist node degrades leave the breaker `closed`.**

> **⇒ H1's stated rationale — "if large-library turns are failing often enough" — is mechanically
> impossible.** Large-library, tool, MCP and specialist failures cannot open the breaker. Only the
> supervisor's model call can.

**5. A second navigate turn inside the same 60 s window fails differently — and this one IS
large-library-correlated.** One navigate on a 2,300-movie collection spends the navigator's entire
30-call budget, so the next turn's `list_collections` returns `[]` and the member gets
**`"Which collection would you like to open?"` with no collections listed** — their own library,
invisible. Distinct message, distinct cause, real defect. Do not conflate it with the reported one.

**6. On the recorded Claude surface, the qualified phrasing classifies correctly.** The golden pair
`us040-intent-navigate-collection-qualified` (`"navigate to Test Import collection"` → `navigate`)
replays green (41 passed / 0 skipped, cassettes unchanged), which is evidence against H2 for that
phrasing. Note the deliberate asymmetry: an **unqualified** `"navigate to <name>"` classifies as
`search` **by design** ([supervisor.py](../../agents/movie-assistant/src/nodes/supervisor.py#L185-L190)),
and the search node does not carry the generic string either.

### Verdict

| | Was | Now |
|---|---|---|
| **H3 — supervisor model call fails** | third | **PRIMARY — the only cause that produces the exact symptom on a navigate turn** |
| **H1 — breaker open** | "most likely" | **not independent** — downstream of H3, and unreachable from large-library failures |
| **H2 — misclassification** | second | **survives, narrowed** — must land on curator/organizer/query specifically (the only other sites); `search` and `clarify` produce different text |
| **H4 — provider 404** | new | **eliminated for navigate**, except as the second half of H2 |

### What is still needed, and it is one signal — not another reproduction

Everything above is deterministic and settled locally. What cannot be observed from here is the
member's own environment, and under **018 the model is per-user**: `runtime_env` drops the gateway's
`SUPERVISOR_MODEL`/`SPECIALIST_MODEL` pins **only when the member's provider differs** from the base
env's ([models.py:80-90](../../agents/movie-assistant/src/models.py#L80-L90)). A member on the *same*
provider as the gateway therefore inherits the gateway's pinned model ids **against their own Ollama
base URL** — which need not have that model installed. That is the deployed-environment analogue of
the PR A reproduction, and it is the first thing to check.

Ask the deployment for one of these; each settles it outright:

1. **`record_turn_failure` > 0** ⇒ H3. Confirm with the provider log — a `404` / model-not-found on
   the **supervisor** model id (the signature PR A recorded is `200` then `404` on `/api/chat`;
   for a navigate turn it is a `404` on the *first* call, with no second call at all).
2. **`record_turn(intent)` labelled anything but `navigate`** ⇒ H2, and the label names the node.
3. **Both clean and the reply still generic** ⇒ contradiction with the evidence above; re-open, and
   check the `DEGRADE` feature flag, which forces the breaker open regardless of the window
   ([circuit_breaker.py:91-92](../../agents/movie-assistant/src/circuit_breaker.py#L91-L92)).

### Decision

- **Fix the pagination defect unconditionally** (T011–T018) — a real FR-002 defect, plus finding 5
  above. It is now confirmed that it will **not** change the reported message.
- **T019/T020 are unblocked, with their target changed.** The specific not-found reply cannot be
  produced by improving the navigator's resolution — the navigator already answers specifically, and
  the generic text is never its own. The two actionable surfaces are: (a) `_degrade_node`, which
  should name the failing component instead of being uniformly generic; and (b) the navigator's
  `_clarify([])` branch, which currently asks *"Which collection would you like to open?"* while
  offering **nothing** whenever the collections read failed — a failed read must not be rendered as
  an empty library.
- **Cover findings 2, 4 and 5 as regression tests** while T011–T018 are in hand: the limiter breach
  must never degrade, a node-level failure must never open the breaker, and a failed
  `list_collections` must not present as an empty one.

**Alternatives considered**: shipping the pagination fix and declaring the story done. Rejected, and
now for a stronger reason than when this was written — it is proven, not merely unevidenced, that the
pagination fix leaves the reported message in place.

---

## RQ-2 — By what mechanism does a progress line update *in place*? {#rq-2}

**Status**: **ANSWERED 2026-08-05 — Option A is VIABLE. FR-014a does NOT go back to the product
owner.** Measured, not inferred: [evidence/t002_probe.py](./evidence/t002_probe.py) drives the real
AG-UI endpoint in-process and records every event on the wire. Three corrections to how this
question was framed, each of which would cost a day if discovered during implementation — see
[the evidence](#rq-2-evidence).

```bash
cd agents/movie-assistant && uv run --offline python \
  ../../specs/047-movie-assistant-enhancements/evidence/t002_probe.py
```

**Constraint.** The client currently subscribes to nothing but messages and render-tool calls:
`assistant-dock.tsx` mounts `useAgent` plus six `useRenderTool` registrations and there is **no**
`useCoAgent` / agent-state subscription anywhere in `frontend/mcm-app`. So no in-place channel
exists today.

**Options:**

| Option | Mechanism | Assessment |
|---|---|---|
| A | AG-UI `STATE_DELTA` / state snapshots + a client agent-state subscription | The protocol-correct answer. The gateway already emits AG-UI natively, so this needs no BFF translation and stays inside the constitution's AG-UI-native mandate. Cost: new client wiring. |
| B | Streamed assistant-message deltas | Cheapest, but AG-UI text deltas **append**; they cannot replace "1,200 of 2,300" with "1,300 of 2,300". Fails FR-014a as written. |
| C | Re-emit a `render_import_progress` tool call per update | Each emission is a new tool call, so the dock accumulates cards — this is exactly the message-flood FR-014a exists to prevent. |

**Leaning**: A. B is disqualified by append-only semantics; C reproduces the problem.

### Evidence — what is actually on the wire {#rq-2-evidence}

**1. The client hook exists and re-renders on state — Option A's precondition holds.**
`useAgent({agentId, updates, throttleMs})` returns `{agent: AbstractAgent}`, and `UseAgentUpdate`
has a first-class **`OnStateChanged`** member. `AbstractAgent.state` is real (`state: State`,
`setState(state)`), and `@ag-ui/client` handles both event shapes: `STATE_SNAPSHOT` **replaces**
state, `STATE_DELTA` applies a JSON Patch via `fast-json-patch`. Either way the update is a
REPLACEMENT, which is exactly what FR-014a needs and what disqualified option B.

`throttleMs` is worth knowing about now rather than later: it coalesces high-frequency
state-change re-renders, which is precisely FR-014a's traffic shape.

**2. The transport is `STATE_SNAPSHOT`, NOT `STATE_DELTA`.** `ag_ui_langgraph` **imports**
`StateDeltaEvent` and never constructs it — three `StateSnapshotEvent` emit sites, zero delta
events. Measured on the wire: a turn produces `STATE_SNAPSHOT` at each super-step boundary and once
at run end. **Anyone implementing against this section's original wording would be waiting for an
event that never arrives.** The mechanism is unaffected: a snapshot replaces, so the progress line
still updates in place.

**3. A progress counter MUST be declared on `GraphState` or it is silently dropped.** The decisive
measurement: one node wrote `import_decisions_remaining` (declared) and `import_applied` (not
declared) in the same turn. Only the declared key reached the wire — the other vanished with no
error anywhere. The node "succeeds", the state write "succeeds", and nothing arrives.

> This makes [RQ-3](#rq-3)'s decision to add `import_applied` / `import_total` /
> `import_proposal_id` to `GraphState` **load-bearing for FR-014a as well**, not just for reporting
> an interrupted import. Skipping it does not degrade the progress line — it removes it entirely,
> silently.

**4. Super-step snapshots fire per NODE, so a loop inside ONE node emits nothing until it finishes.**
US3's apply loop is exactly that shape. The mechanism for mid-run progress is the
`manually_emit_state` custom event, which the gateway converts to a `STATE_SNAPSHOT`. Verified: three
`adispatch_custom_event("manually_emit_state", …)` calls from inside a single node produced a
progressing counter on the wire (500 → 1300 → 2300) before the node returned.

**5. A gotcha inside that mechanism: a manual emit REPLACES the snapshot, it does not merge.**
Measured payload keys — a super-step snapshot carries
`['copilotkit', 'intent', 'messages', 'tools']`, but a `manually_emit_state` snapshot carries
**only what was passed** (`['import_decisions_remaining']`). So during the apply loop the client's
`agent.state` becomes just that object and every other key transiently disappears, returning only
when the node's real return produces the next full snapshot. **The manual emit must carry the whole
state the client reads, not just the counter.** Also note each dispatch produced two snapshots —
harmless because state is replaced rather than accumulated, but it doubles the event volume, which
is the other reason `throttleMs` matters.

**Still unverified — the BFF hop.** The BFF is **not** a raw AG-UI passthrough: `run+api.ts` builds
a `CopilotRuntime` with an `HttpAgent` pointed at the gateway
([run+api.ts](../../frontend/mcm-app/src/app/bff-api/agent/run+api.ts)), so gateway events cross a
bridge before reaching the client. Everything above is measured at the **gateway** boundary. Whether
`STATE_SNAPSHOT` survives that bridge into `agent.state` is the one link not proven here, and it is
the thing to settle first in T049 — cheaply, by subscribing a throwaway `useAgent({updates:
[UseAgentUpdate.OnStateChanged]})` and logging `agent.state` during a run, before any UI is built.

**Decision**: Option A, with the plan's `STATE_DELTA` wording corrected to `STATE_SNAPSHOT`.
FR-014a stands as written and does **not** return to the product owner. Option B stays disqualified
(append-only), option C stays disqualified (card accumulation).

---

## RQ-3 — How is an interrupted import reported on the next turn? {#rq-3}

**Status**: Working answer recorded; confirm during implementation.

FR-016a/FR-016b require that applied rows survive an interruption and that the member is told where
it stopped. `ApplyResult` already tracks `applied_item_ids` / `skipped_item_ids` /
`failed_item_ids` / `failures`, but it is built inside `apply_proposal` and only surfaces once the
call returns — an interrupted run never returns.

**Decision**: persist a small running counter into graph state as the apply loop progresses
(`import_applied`, `import_total`, `import_proposal_id`), so the checkpoint holds enough to report
on. On the next turn, if a checkpointed import run is present and unfinished, report it and clear
it. Counters only — no payloads, keeping the checkpoint small.

**Rationale**: the checkpointer already persists graph state at each super-step; this reuses that
rather than introducing a job store, which the spec explicitly puts out of scope.

**Alternatives considered**: a dedicated import-run table in `agent-db` (rejected — out of scope,
and agent state is not domain data); re-deriving progress by diffing the collection against the
sheet on the next turn (rejected — expensive and racy).

---

## RQ-4 — Where does the media-format / rip-quality option list come from? {#rq-4}

**Status**: **RESOLVED 2026-08-02 (product owner) — Option A: expose the values through movie-mcp.**

**The tension.** FR-021/FR-024 require the assistant to offer exactly the values mc-service accepts.
Those values are `DVD`, `Blu-Ray`, `Blu-Ray 3D`, `UHD Blu-Ray` — the `MediaFormat` enum in
[movie.rs](../../backend/mc-service/src/domain/movie.rs), used for **both** `ownedMedia` and
`ripQuality`. But the constitution's *No Domain Logic in Agents* rule says agents "never own domain
rules, validation, or persistence".

**Options considered:**

| Option | Assessment |
|---|---|
| **A — expose the enum through movie-mcp as a read tool** | **Chosen.** Constitutionally clean: the agent asks the domain what it accepts and owns nothing. Cost: a new mc-service endpoint + MCP tool, which takes this feature outside the agent layer. |
| B — hardcode the four values in the agent's tool layer | Rejected. Duplicates domain data and rots silently the moment a format is added. |
| C — B plus a contract test pinning the agent's list to mc-service's enum | Rejected. Makes the rot loud rather than impossible, and still leaves domain values living in the agent. |

**Decision**: A. Full design in
[contracts/movie-metadata.md](./contracts/movie-metadata.md) — `GET /api/v1/movie-metadata` on
mc-service, wrapped by a `get_movie_metadata` read tool on movie-mcp, allowlisted to the organizer
only.

**Rationale**: the option list *is* domain data. B and C both keep it in the agent and differ only
in how quickly the drift is noticed; A removes the possibility. It also settles the constitution
gate outright rather than parking a justified violation in Complexity Tracking.

**Consequences — this is not a free choice, and the plan reflects all of them:**

- The feature is **no longer confined to the agent layer**. It now changes `backend/mc-service`
  (Rust) and `mcp-servers/movie-mcp` (Python), which adds Rust unit tests, mc-service HTTP authz
  integration tests, and a real-mc-service movie-mcp integration test.
- Story 4 gains a dependency chain: mc-service endpoint → movie-mcp tool → agent wiring. All three
  land in **one** PR and one commit — the layers are consistent at every point on `main`, the Nx
  test targets are per-project so a red unit tier names its own layer, and the specified graceful
  fallback (below) makes the deploy ordering safe on its own. Splitting the chain across PRs would
  spend an `app-e2e` slot on a change whose story-level acceptance cannot yet be demonstrated.
- The endpoint must derive the list from the enum by exhaustive match, so adding a `MediaFormat`
  variant fails to compile until the new value is published. A hand-maintained array would
  reintroduce exactly the rot that disqualified B.

**Notable finding while designing this.** The existing
`GET /api/v1/collections/{id}/movies/filter-options` endpoint looked like a candidate but cannot
serve this purpose — it aggregates values **observed** in a collection, so an empty collection
returns empty lists and a DVD-only collection would hide Blu-Ray. It answers "what can I filter by",
not "what may I choose".

**Fallback behaviour** (specified rather than left to implementation): if the metadata call fails,
the assistant skips the format question and completes the add with no formats recorded — it must
never fall back to a guessed list, which would put domain values back in the agent.

---

## RQ-5 — Audit-event granularity for a bulk import {#rq-5}

**Status**: Working answer recorded; this is the item deferred at `/speckit-clarify`.

**The tension.** *Immutable Audit Logging of Agent Actions* requires every agent action — tools
called, what was returned, every approval decision — in the append-only stream. A 2,000-row import
is 2,000 tool calls, so a literal reading means 2,000 audit events per import.

**Decision (default)**: keep per-write audit events. They are what makes an individual movie's
provenance auditable, and dropping them to a summary would weaken a NON-NEGOTIABLE control to save
storage — the wrong trade. The approval decision remains a single event, as today.

**To confirm during implementation**: that the audit sink absorbs a 2,000-event burst without
becoming the import's bottleneck. `emit_audit` already swallows its own exceptions and is designed
not to delay the tool result
([mcp_tools.py:354](../../agents/movie-assistant/src/tools/mcp_tools.py#L354)), so this is expected
to hold — but under the new bounded-concurrency apply it should be measured, not assumed.

**Alternatives considered**: one summary audit event per import (rejected — loses per-movie
provenance); sampling (rejected — an append-only audit trail with holes is not an audit trail).

---

## Confirmed findings that needed no research

These were verified by reading the code and are recorded so implementation does not re-litigate
them:

- **The import loop's root cause is proven, not hypothesised.** Trailing whitespace in the option
  label makes it strictly longer than the trimmed reply, so `resolve_option`'s `title in low`
  substring test can never match. See the plan's Story 2 section for the two file references.
- **Bulk-write rate exemption already exists.** Feature 040 added `skip_rate_limit=True` to the
  import node's reads and the approval gate's writes, with a comment recording that a 200-row import
  had been silently capped at 30. **FR-019a is already satisfied**; it reduces to a regression test.
  This corrects what I said when the clarification question was asked.
- **The import approval payload is already compact.** `build_approval_request` previews an import as
  a tab-level summary, not per-item, so the HITL interrupt is not a large-import bottleneck.
- **mc-service already enforces the ownership cross-field rules.** `OwnedMediaWhenOwnedSpec` and
  `RipQualityWhenRippedSpec` reject formats on an unowned movie and rip qualities on an unripped
  one, so FR-027 is validated in the domain layer — the agent must not duplicate it.
- **No golden re-record is needed.** Every changed resolver is deterministic pure code; no prompt,
  model binding, or classification path is touched. This should still be asserted by running the
  golden suite, not assumed.
