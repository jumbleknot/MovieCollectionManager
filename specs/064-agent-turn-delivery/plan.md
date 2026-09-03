# Implementation Plan: 064 — agent turn delivery and branch-free gate waits

**Spec**: [spec.md](./spec.md) · **Item**: #337 (p1) · **Created**: 2026-09-02

## Approach in one line

Fix the cause (a turn dropped in the client), add the instrument that would have named it (the
classified intent), and give both test surfaces one shared way to wait for "the assistant answered"
so no `@gate` assertion has to name a branch.

## Why the cause fix comes first

The three `@gate` waits were grandfathered on the belief that `selection-options` is a model branch.
It is not — see spec.md's table. Building a test-design workaround on top of a client defect would
encode the wrong lesson and leave real members with a stranded upload. The workaround still ships,
because routing *is* a model decision and the gate should not depend on it either.

## Design

### 1. One send path (FR-001 … FR-004)

`hooks/use-assistant.tsx`'s `useAssistantRun` already holds the queue that features 053/054 added: it
resolves the agent from the live registry when the React-state handle lags, queues when the agent is
busy or momentarily absent, and flushes one message per completed run from an effect.

Three components bypass it and return early on `isRunning`:

| component | change |
| --- | --- |
| `request-import-file.tsx` | drop the local `useAgent`/`useCopilotKit`; call `run(IMPORT_PROMPT)` |
| `disambiguation-options.tsx` | same |
| `render-movie-card.tsx` | same, keeping its `actioned` latch so a queued action still fires once |

`useAssistantRun` is the only caller of `copilotkit.runAgent` afterwards. That is asserted by a
tooling-tier guard, not by review, because "one send path" is exactly the invariant that decayed
between 054 and now.

**The `actioned` latch matters (FR-004).** `render-movie-card` sets it to stop a double-fire. With a
queue the send is deferred, so the latch must be set at *enqueue* time, not at send time — otherwise
a second tap during the queued window fires a second action.

### 2. The intent is logged (FR-005 … FR-007)

`graph.py`'s `_classify` returns `{"intent": …}` from seven places (kill switch, cancel
short-circuit, degraded, noop, the classified path, and the stage overrides). Each currently writes
only the OTel counter. Add one INFO line naming the intent and the node `route_for_intent` maps it
to, plus the thread id — and nothing else. No message text; the never-log list holds.

The line is what makes the next occurrence of this class a five-minute read instead of a session.

### 3. One way to wait for a turn, on both surfaces (FR-008, FR-009)

- **web** — `setup/assistant-turn.ts` exports `beginTurn(page)` (reads the current
  `assistant-msg-assistant` count) and `awaitTurn(page, token)` (waits for it to rise). Counting
  replies is the model-invariant wait item #323 established; this makes it a shared helper rather
  than three copies.
- **mobile** — `_await-turn.yaml` waits for an `assistant-msg-assistant` bubble to exist. Maestro
  has no functions, so a sub-flow is the only way to express a shared step, and it **cannot count
  elements** — so the mobile statement is weaker than the web one by construction. Callers open with
  `clearState` and an empty dock, so for a flow's first turn the two coincide; a flow needing a later
  turn waits for the affordance that turn produces instead.

**REVISED after CI run 2566.** The first design rendered the count into the app as a 1 px
`opacity: 0` `assistant-turn-<n>` marker so both runners could read one number. Android never
exposed it — an alpha-0 node is not `visibleToUser` — and `agent-card-navigate.yaml` failed 3/3 on a
marker that was in the React tree the whole time. `assistant-msg-assistant` is already waited on by
`assistant-add.yaml` and `assistant-config-enable*.yaml`, so it is **proven on that surface rather
than assumed**, and it adds no test-only surface to the product.

### 4. Branch-adaptive continuations (FR-010, FR-011)

Each affected test waits for the turn, then continues into whatever the turn produced, and asserts
the **same end state** either way:

| test | end state asserted unconditionally | branches that reach it |
| --- | --- | --- |
| `agent-card-navigate` | `movie-detail-title` contains the seeded title | the offered result button (`selection-option-pick-0`), or the movie card if the turn rendered one |
| `agent-navigate-collection` | `/collections/<importId>` + `collection-screen-add-movie` | the offered collection button |
| `agent-import-disambiguate` | the imported movie lands in the collection **the test picked** | the offered collection button |

For the two whose alternative branch cannot reach the end state, the test does **not** silently pass:
it asserts the turn completed and that the app did not mis-navigate, then fails with a message naming
the branch actually taken and pointing at the new gateway intent line. That keeps a red meaningful
while removing "an element that never appeared" as the only diagnostic.

**No coverage is lost (FR-013, item #337 criterion 4).** The branch *decision* is already proven
deterministically off the E2E surface — `unit/test_navigator.py`, `unit/test_search.py`,
`unit/test_import_disambiguation_runtime.py`, `integration/test_import_flow.py`,
`integration/test_search_flow.py`. What only E2E can prove is the client wiring, and the adaptive
continuation still proves it every time the offer appears.

### 5. The allowlist empties (FR-012)

`KNOWN_BRANCH_WAITS` becomes `[]`. Both existing assertions stay: a new branch wait in `@gate` fails,
and a stale entry fails. The meta-tests already exercise the detector against samples, so an empty
list cannot be reached by the detector having quietly stopped matching — that property is the reason
they exist and it is why the list can safely go to zero.

## Files

| path | change |
| --- | --- |
| `frontend/mcm-app/src/hooks/use-assistant.tsx` | unchanged (already correct) — the target of the other three |
| `frontend/mcm-app/src/components/agent/request-import-file.tsx` | route through `useAssistantRun` |
| `frontend/mcm-app/src/components/agent/disambiguation-options.tsx` | route through `useAssistantRun` |
| `frontend/mcm-app/src/components/agent/render-movie-card.tsx` | route through `useAssistantRun`; latch at enqueue |
| `frontend/mcm-app/src/components/agent/assistant-dock.tsx` | **unchanged** — the marker was withdrawn after CI run 2566 (see §3) |
| `agents/movie-assistant/src/graph.py` | the classified-intent INFO line |
| `frontend/mcm-app/tests/e2e/web/setup/assistant-turn.ts` | **new** — `beginTurn` / `awaitTurn` |
| `frontend/mcm-app/tests/e2e/mobile/_await-turn.yaml` | **new** — the shared wait sub-flow |
| the three web specs, the three mobile flows | adaptive continuations |
| `scripts/__tests__/agent-test-classification.test.mjs` | empty `KNOWN_BRANCH_WAITS`; add the single-send-path guard |
| `openwiki/invariants/testing-tiers.md` | replace the grandfathering passage with what was actually found |

## Testing

Per `openwiki/process/test-authoring-conventions.md`, every test task records **Verify RED** then
**Verify GREEN**. The three component fixes are behaviour changes to already-shipping code, so RED is
a genuine failing assertion (send while `isRunning`, assert the message is delivered after the run
completes) — not a compile error.

Tiers derived from the diff (`openwiki/invariants/testing-tiers.md`): `nx test mcm-app` (jest),
`nx lint mcm-app`, `nx test movie-assistant` + `nx lint movie-assistant` (ruff — item #326's lesson),
`node --test scripts/__tests__/…`, and the web E2E gate tier.

**NFR-002 is load-bearing.** Feature 053 measured 6/6 unit and 5/5 E2E on a shared-hook change, then
28 and 26 failures on the full suite. The full `E2E_TIER=gate` selection runs before this is called
done.

## Measurement (NFR-001, SC-004)

Repeated runs of the three affected specs on one unchanged tree, `--retries=0` so each run is an
independent trial, against the dev-container stack (`openwiki/runbooks/e2e-testing.md`'s
deterministic baseline). The rate is recorded on item #337 **with the worker count**, alongside the
pre-change 30-run baseline of 2/30 at `--workers=1`.

Mobile is **not** re-measured — `/dev/kvm` is unavailable in the Docker Sandbox microVM. Item #337
records that plainly rather than implying a measurement that was not taken.
