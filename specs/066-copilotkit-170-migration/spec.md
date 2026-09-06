# Feature Specification: the assistant dock renders CopilotKit 1.70's streaming tool calls

**Feature Branch**: `265-copilotkit-170-migration`

**Created**: 2026-09-06

**Status**: Draft

**Input**: Backlog item **#265** (`node scripts/backlog.mjs show 265`). Item **#266** (closed) already
pulled `@copilotkit/*` out of the `js patch/minor` Renovate group behind dashboard approval, so this
arrives as a reviewable migration rather than bundled with routine patches.

## Context

Item #265 was written against `1.69.0`, the version PR #263 proposed. Two things changed before this
spec: `1.70.1` is now current (the migration cost is identical — `useRenderToolRegistry` is absent
from both lines), and **measuring the actual behaviour showed the item's prescribed fix is wrong**.

### What the item asks for, and why it cannot be built as written

The item's second acceptance criterion says the four render components must "handle PARTIAL args
explicitly — a defined incomplete/loading state". The natural reading is: branch on the new `status`
discriminant, draw a skeleton while `status` is `inProgress`, draw the card otherwise.

**That would make every generative-UI card in the dock a permanent skeleton.**

### Measured 2026-09-06, against `@copilotkit/react-native@1.70.1` under the app's own Jest setup

A probe registered a render-only tool with `useRenderTool` inside a real `CopilotKitProvider` and
rendered a tool call through `useRenderToolCall`, capturing the props the render function received:

| tool-call `arguments` on the wire | `status` observed | `args` observed |
| --- | --- | --- |
| `{"title":"Blade Runner"}` (complete) | **`inProgress`** | `{title: "Blade Runner"}` — complete |
| `{"title": "Blade Ru` (mid-stream) | `inProgress` | `{title: "Blade Ru"}` — **truncated value** |
| `{"ti` (early) | `inProgress` | `{}` — no fields yet |

`status` never left `inProgress`, **including for fully-formed arguments**. The library derives it in
`ToolCallRenderer` (`@copilotkit/react-core@1.70.1`): `Complete` requires a matching `toolMessage`,
`Executing` requires membership of `executingToolCallIds` (populated only by
`onToolExecutionStart`/`End`, which fire for a tool with a **handler**). Every MCM generative-UI tool
is deliberately render-only — no `handler`, the write is gated behind the approval flow — and the
gateway emits `AIMessage(tool_calls=[…])` and never a `ToolMessage`. So neither condition can ever
hold here, and `status` is structurally pinned at `inProgress` for this application.

**Therefore `status` is not a signal of argument completeness in MCM, and no component may branch on
it.** The signal that is actually available is whether the arguments satisfy the tool's own schema —
which every component already declares (`renderMovieCardParameters`, `renderDisambiguationParameters`,
and so on) and currently uses only to describe the tool to the model.

Row 2 bounds what schema validation can promise: a *truncated string value* still satisfies
`z.string()`. Missing fields are caught; a half-written value is not. For every tool here the schema
requires several fields, so the object does not validate until it is essentially complete, and a
truncated trailing value is a cosmetic flicker rather than a wrong render.

### The second breakage is larger than an import swap

`useRenderToolRegistry` is not renamed — the React Native package no longer keeps a registry at all.
Renderers now register into react-core's canonical `copilotkit.renderToolCalls`, and the read side is
`useRenderToolCall()`, which returns `({toolCall, toolMessage}) => ReactElement | null` rather than a
`Map`. `buildDockItems` currently takes that `Map`, parses `tc.function.arguments` itself, and calls
the render function with a hardcoded `status: 'complete'`. Its signature and its argument-parsing
both have to change; this is not a one-line re-import.

### The error set the item lists is incomplete

Item #265 names five files (one import, four renders). Measured against `1.70.1` with
`tsc --noEmit`, there are **seven** errors across **seven** files — the item misses
`selection-options.tsx:122` (a fifth `{...args}` spread) and `ui-action-tools.tsx:287`
(`String(args.handle)` where `handle` became optional). Four further render sites
(`request-import-file`, `render-import-report`, and three more in `ui-action-tools`) compile only
because they read fields individually or supply `??` defaults — they are *silently* exposed to
partial args, and `ui-action-tools` navigating on `args.collectionId` while it is `undefined` would
push `/collections/undefined`.

## User Scenarios & Testing

### User Story 1 — a generative-UI card still appears (Priority: P1)

A member asks the assistant something that makes it emit a generative-UI tool call — a movie card, a
collection summary, a disambiguation list, a multi-select, a search selection. The card appears in
the dock, fully drawn, exactly as it does today.

**Why this priority**: this is the whole of the assistant's visible output. If it regresses, the
assistant is unusable regardless of anything else in the migration. It is also the specific thing
the item's prescribed fix would have broken.

**Independent Test**: mount the dock with an agent message carrying a complete `render_movie_card`
tool call and assert the card's content is on screen — the existing
`assistant-dock-tools.test.tsx` coverage, which must stay green through the migration.

**Acceptance Scenarios**:

1. **Given** an assistant message with a complete `render_movie_card` tool call, **When** the dock
   renders, **Then** the movie card is shown with its title, and not a placeholder.
2. **Given** the same for `render_multi_select`, `render_disambiguation`, `render_selection` and
   `render_collection_summary`, **When** the dock renders, **Then** each renders its component.
3. **Given** a tool call whose id repeats across two messages after an approve→resume continuation,
   **When** the dock renders, **Then** the item keys are still unique.

---

### User Story 2 — a still-streaming tool call draws something honest (Priority: P2)

While the model is still writing a tool call's JSON, the dock shows a defined incomplete state for
that card rather than a component rendered from absent fields.

**Why this priority**: it is the semantic half of the breaking change and the reason the bump is not
a type annoyance. Without it a card renders `undefined` where a required value belongs — a title-less
card, or a navigation to `/collections/undefined`.

**Independent Test**: render each component's registered `render` with arguments that omit a required
field and assert the incomplete state, not a crash and not a half-drawn card.

**Acceptance Scenarios**:

1. **Given** a `render_movie_card` tool call whose arguments are `{}`, **When** it renders, **Then** a
   defined incomplete state is shown and no movie card is claimed.
2. **Given** arguments that are complete, **When** they render, **Then** the full component is shown.
3. **Given** a `navigate_to_collection` tool call with no `collectionId` yet, **When** it renders,
   **Then** **no navigation is performed**.

---

### User Story 3 — the incomplete path cannot silently regress (Priority: P3)

A future change to how CopilotKit streams tool arguments cannot quietly reintroduce a card drawn
from absent fields.

**Why this priority**: the value is entirely in the future; the behaviour is delivered by US2. The
item asks for it explicitly.

**Independent Test**: the partial-args case for `render_movie_card` is asserted by a test that fails
if the incomplete branch is removed.

**Acceptance Scenarios**:

1. **Given** the incomplete branch is deleted from `render-movie-card`, **When** the suite runs,
   **Then** a test fails.

### Edge Cases

- Arguments arrive with a **truncated string value** that still satisfies the schema — accepted, and
  recorded as accepted: the component draws with the partial text and completes on the next frame.
- Arguments contain a field the schema rejects outright (wrong type) — treated as incomplete, not as
  a crash.
- A tool call names a tool with no registered renderer — nothing is rendered for it, as today.
- The dock is closed while a tool call streams — unchanged; the panel mounts only when opened.

## Requirements

### Functional Requirements

- **FR-001**: The app MUST depend on `@copilotkit/react-native` and `@copilotkit/runtime` at the same
  `1.70.1` version.
- **FR-002**: The dock MUST render an assistant message's tool calls without `useRenderToolRegistry`,
  which no longer exists.
- **FR-003**: Every registered `render` MUST tolerate arguments that do not yet satisfy its declared
  schema, and MUST show a defined incomplete state for them.
- **FR-004**: No component may decide completeness from `status`, which is structurally pinned at
  `inProgress` for this application's render-only tools.
- **FR-005**: Completeness MUST be decided by the tool's own already-declared parameter schema, so
  the render contract and the model-facing contract cannot drift apart.
- **FR-006**: A UI-action tool (navigate / prefill / download) MUST perform **no** effect while its
  arguments are incomplete.
- **FR-007**: No `as`-cast or non-null assertion may be used to satisfy the new props union.
- **FR-008**: A test MUST cover the partial-args path for at least `render_movie_card`.
- **FR-009**: `nx affected` for `mcm-app` MUST be green — `typecheck`, `lint` and `test`.

### Key Entities

- **Tool-call render props** — what a registered `render` receives in 1.70: `name`, `toolCallId`,
  `args` (possibly partial), `status`, `result`. In MCM, `status` is always `inProgress` and `result`
  always `undefined`.
- **Parameter schema** — the per-tool schema already declared for the model. Becomes the render-side
  completeness test as well.

## Success Criteria

- **SC-001**: `tsc --noEmit` reports **0** errors for `mcm-app`, down from the measured 7, with no
  new `as`-cast or `!` in the touched files.
- **SC-002**: Every dock generative-UI test that passes before the migration passes after it — the
  card that renders today still renders.
- **SC-003**: For each of the eleven registered render sites, arguments missing a required field
  produce a defined incomplete state and **zero** side effects.
- **SC-004**: `nx run-many -t typecheck lint test -p mcm-app` is green.
- **SC-005**: `app-e2e` is green on the pull request — the assistant specs exercise the real
  registry against the real gateway.

## Assumptions

- `1.70.1` is the target (operator decision, 2026-09-06). `1.69.x` carries the identical breakage.
- The gateway is unchanged: it emits `AIMessage(tool_calls=…)` and no `ToolMessage`, and the tools
  stay render-only. If either changes, `status` becomes meaningful and FR-004 should be revisited.
- The `as unknown as AgentsConfig` cast in `run+api.ts` is **out of scope here**, though `1.70.1`'s
  runtime now depends on `@ag-ui/client@0.0.59` — exactly what the app pins — so the nominal mismatch
  that forced it is likely gone. It is left alone deliberately: PR #369 (item #284) is open against
  the same file, and conflating them is what the PR-batching rule exists to prevent. Filed separately.
